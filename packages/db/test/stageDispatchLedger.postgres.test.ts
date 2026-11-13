import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaClient } from '../generated/prisma/client.ts';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  canonicalizeTerminalStageDispatches,
  claimNextStageDispatch,
  claimStageRun,
  finalizeStageDispatchEnqueueFailure,
  finalizeStageDispatchEnqueueSuccess,
  terminalizeAbandonedStageRun
} from '../src/stageDispatchLedger.ts';

const connectionString = process.env.STAGE_DISPATCH_TEST_DATABASE_URL;
if (!connectionString) {
  throw new Error('STAGE_DISPATCH_TEST_DATABASE_URL is required: this real-PostgreSQL suite must never skip');
}

const databaseName = new URL(connectionString).pathname.replace(/^\//, '');
if (!/^a11y_stage_dispatch_test(?:_|$)/.test(databaseName)) {
  throw new Error(`STAGE_DISPATCH_TEST_DATABASE_URL must name an owned a11y_stage_dispatch_test database, got ${databaseName}`);
}

const runPrefix = `stage-ledger-${crypto.randomUUID()}`;
const migrationPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prisma/migrations/20261112090000_runtime_stage_dispatch_ledger/migration.sql');

async function applyExhaustedLegacyDispatchMigration(client: PrismaClient): Promise<void> {
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const start = sql.indexOf('-- Historical dispatching capped retries');
  const end = sql.indexOf('DROP INDEX', start);
  if (start < 0 || end < 0) throw new Error('missing exhausted legacy dispatch migration block');
  await client.$executeRawUnsafe(sql.slice(start, end));
}

function createClient(): { prisma: PrismaClient; pool: Pool } {
  const pool = new Pool({ connectionString, max: 1 });
  return { prisma: new PrismaClient({ adapter: new PrismaPg(pool) }), pool };
}

const first = createClient();
const second = createClient();

type DispatchSeed = {
  state?: 'PENDING' | 'DISPATCHING';
  due?: 'past' | 'future';
  lease?: 'expired' | 'live' | null;
};

async function createDispatch(client: PrismaClient, suffix: string, seed: DispatchSeed = {}): Promise<string> {
  const project = await client.project.create({
    data: { name: `${runPrefix}-${suffix}`, baseUrl: `https://${suffix}.test` }
  });
  const scan = await client.scan.create({ data: { projectId: project.id } });
  await client.scanDispatch.create({
    data: {
      scanId: scan.id,
      jobId: `${scan.id}-crawl`,
      state: seed.state ?? 'PENDING'
    }
  });

  await client.$executeRaw`
    UPDATE "ScanDispatch"
    SET
      "nextAttemptAt" = CASE ${seed.due ?? 'past'}
        WHEN 'future' THEN CURRENT_TIMESTAMP + INTERVAL '1 hour'
        ELSE CURRENT_TIMESTAMP - INTERVAL '1 minute'
      END,
      "leaseUntil" = CASE ${seed.lease ?? null}
        WHEN 'expired' THEN CURRENT_TIMESTAMP - INTERVAL '1 minute'
        WHEN 'live' THEN CURRENT_TIMESTAMP + INTERVAL '1 hour'
        ELSE NULL
      END
    WHERE "scanId" = ${scan.id}
  `;
  return scan.id;
}

async function databaseNow(client: PrismaClient): Promise<Date> {
  const rows = await client.$queryRaw<{ now: Date }[]>`SELECT CURRENT_TIMESTAMP AS now`;
  return rows[0]!.now;
}

describe('PostgreSQL stage-dispatch token-fenced foundation', () => {
  beforeEach(async () => {
    // Cleanup is constrained to this run's owned projects in an unmistakably disposable database.
    await first.prisma.project.deleteMany({ where: { name: { startsWith: runPrefix } } });
  });

  afterAll(async () => {
    await first.prisma.project.deleteMany({ where: { name: { startsWith: runPrefix } } });
    await Promise.all([first.prisma.$disconnect(), second.prisma.$disconnect()]);
    await Promise.all([first.pool.end(), second.pool.end()]);
  });

  it('upgrades an old-schema exhausted PENDING dispatch into one terminal scan, dispatch, and page outcome', async () => {
    const scanId = await createDispatch(first.prisma, 'legacy-exhausted');
    const page = await first.prisma.page.create({ data: { scanId, url: 'https://legacy-exhausted.test', outcome: 'PENDING' } });
    await first.prisma.$executeRaw`
      UPDATE "ScanDispatch"
      SET "attemptCount" = 5, "dispatchAttemptCount" = 5,
          "claimToken" = '00000000-0000-4000-8000-000000000099'::uuid,
          "leaseUntil" = CURRENT_TIMESTAMP + INTERVAL '1 hour',
          "runClaimToken" = '00000000-0000-4000-8000-000000000098'::uuid,
          "runLeaseUntil" = CURRENT_TIMESTAMP + INTERVAL '1 hour'
      WHERE "scanId" = ${scanId}
    `;

    await applyExhaustedLegacyDispatchMigration(first.prisma);

    await expect(first.prisma.scan.findUniqueOrThrow({ where: { id: scanId } })).resolves.toMatchObject({ status: 'failed', coverage: 'FAILED' });
    await expect(first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } })).resolves.toMatchObject({
      state: 'DEAD', claimToken: null, leaseUntil: null, runClaimToken: null, runLeaseUntil: null
    });
    await expect(first.prisma.page.findUniqueOrThrow({ where: { id: page.id } })).resolves.toMatchObject({ outcome: 'FAILED', error: 'Execution unavailable before analysis' });
    await expect(claimNextStageDispatch(first.prisma, { scanId, stage: 'CRAWL', leaseMs: 30_000 })).resolves.toBeNull();
  });

  it('allows exactly one of two independent clients to claim one due dispatch with a durable token', async () => {
    const scanId = await createDispatch(first.prisma, 'contended');

    const [one, two] = await Promise.all([
      claimNextStageDispatch(first.prisma, { leaseMs: 30_000 }),
      claimNextStageDispatch(second.prisma, { leaseMs: 30_000 })
    ]);

    const claims = [one, two].filter((claim): claim is NonNullable<typeof claim> => claim !== null);
    expect(claims).toHaveLength(1);
    expect(claims[0]!.scanId).toBe(scanId);
    expect(claims[0]!.claimToken).toMatch(/^[0-9a-f-]{36}$/i);

    const row = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } });
    expect(row.state).toBe('DISPATCHING');
    expect(row.claimToken).toBe(claims[0]!.claimToken);
    expect(row.leaseUntil).not.toBeNull();
  });

  it('creates a distinct durable token for each claim', async () => {
    await createDispatch(first.prisma, 'token-one');
    await createDispatch(first.prisma, 'token-two');

    const firstClaim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(firstClaim).not.toBeNull();
    await expect(finalizeStageDispatchEnqueueSuccess(first.prisma, {
      scanId: firstClaim!.scanId,
      claimToken: firstClaim!.claimToken
    })).resolves.toBe(true);

    const secondClaim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(secondClaim).not.toBeNull();
    expect(secondClaim!.claimToken).not.toBe(firstClaim!.claimToken);
  });

  it('leaves a nonexpired claim field-for-field untouched', async () => {
    const scanId = await createDispatch(first.prisma, 'live-lease', {
      state: 'DISPATCHING',
      lease: 'live'
    });
    await first.prisma.scanDispatch.update({
      where: { scanId },
      data: { claimToken: '00000000-0000-4000-8000-000000000001', lastErrorCode: 'UNCHANGED' }
    });
    const before = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } });

    await expect(claimNextStageDispatch(first.prisma, { leaseMs: 30_000 })).resolves.toBeNull();
    const after = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } });
    expect(after).toEqual(before);
  });

  it('reclaims only after the DB-time lease expires and gives the successor a fresh token', async () => {
    const scanId = await createDispatch(first.prisma, 'expired-lease', {
      state: 'DISPATCHING',
      lease: 'expired'
    });
    await first.prisma.scanDispatch.update({ where: { scanId }, data: { claimToken: '00000000-0000-4000-8000-000000000002' } });

    const claim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(claim).toMatchObject({ scanId });
    expect(claim?.claimToken).not.toBe('00000000-0000-4000-8000-000000000002');
  });

  it('uses PostgreSQL time despite a skewed application clock', async () => {
    const futureScanId = await createDispatch(first.prisma, 'future', { due: 'future' });
    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 24 * 60 * 60_000;
    try {
      await expect(claimNextStageDispatch(first.prisma, { leaseMs: 30_000 })).resolves.toBeNull();
    } finally {
      Date.now = originalDateNow;
    }

    const row = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: futureScanId } });
    expect(row.state).toBe('PENDING');
    expect(row.claimToken).toBeNull();
  });

  it('rejects both finalizers after a lease expires even before a successor claims', async () => {
    const successScanId = await createDispatch(first.prisma, 'expired-success');
    const successClaim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(successClaim?.scanId).toBe(successScanId);
    await first.prisma.$executeRaw`
      UPDATE "ScanDispatch"
      SET "leaseUntil" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond'
      WHERE "scanId" = ${successScanId}
    `;
    const beforeExpiredSuccess = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: successScanId } });
    await expect(finalizeStageDispatchEnqueueSuccess(first.prisma, {
      scanId: successScanId,
      claimToken: successClaim!.claimToken
    })).resolves.toBe(false);
    expect(await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: successScanId } })).toEqual(beforeExpiredSuccess);

    const failureScanId = await createDispatch(first.prisma, 'expired-failure');
    await first.prisma.$executeRaw`
      UPDATE "ScanDispatch"
      SET "nextAttemptAt" = CURRENT_TIMESTAMP - INTERVAL '2 hours'
      WHERE "scanId" = ${failureScanId}
    `;
    const failureClaim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(failureClaim?.scanId).toBe(failureScanId);
    await first.prisma.$executeRaw`
      UPDATE "ScanDispatch"
      SET "leaseUntil" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond'
      WHERE "scanId" = ${failureScanId}
    `;
    const beforeExpiredFailure = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: failureScanId } });
    await expect(finalizeStageDispatchEnqueueFailure(first.prisma, {
      scanId: failureScanId,
      claimToken: failureClaim!.claimToken,
      errorCode: 'REDIS_UNAVAILABLE'
    })).resolves.toBe(false);
    expect(await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: failureScanId } })).toEqual(beforeExpiredFailure);
  });

  it('treats a malformed token as a lost fence without mutating the claim', async () => {
    const scanId = await createDispatch(first.prisma, 'malformed-token');
    const claim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(claim?.scanId).toBe(scanId);
    const before = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } });

    await expect(finalizeStageDispatchEnqueueSuccess(first.prisma, {
      scanId,
      claimToken: 'not-a-uuid'
    })).resolves.toBe(false);
    await expect(finalizeStageDispatchEnqueueFailure(first.prisma, {
      scanId,
      claimToken: 'not-a-uuid',
      errorCode: 'REDIS_UNAVAILABLE'
    })).resolves.toBe(false);
    expect(await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } })).toEqual(before);
  });

  it('rejects stale success finalization after a successor claim', async () => {
    const scanId = await createDispatch(first.prisma, 'stale-success');
    const firstClaim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(firstClaim).not.toBeNull();

    await first.prisma.$executeRaw`
      UPDATE "ScanDispatch"
      SET "leaseUntil" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond'
      WHERE "scanId" = ${scanId}
    `;
    const secondClaim = await claimNextStageDispatch(second.prisma, { leaseMs: 30_000 });
    expect(secondClaim?.scanId).toBe(scanId);
    expect(secondClaim?.claimToken).not.toBe(firstClaim?.claimToken);
    const beforeStaleFinalize = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } });

    await expect(finalizeStageDispatchEnqueueSuccess(first.prisma, {
      scanId,
      claimToken: firstClaim!.claimToken
    })).resolves.toBe(false);

    expect(await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } })).toEqual(beforeStaleFinalize);
    await expect(finalizeStageDispatchEnqueueSuccess(second.prisma, {
      scanId,
      claimToken: secondClaim!.claimToken
    })).resolves.toBe(true);
  });

  it('rejects stale failure finalization and uses DB time for a winning retry', async () => {
    const scanId = await createDispatch(first.prisma, 'stale-failure');
    const firstClaim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000 });
    expect(firstClaim).not.toBeNull();

    await first.prisma.$executeRaw`
      UPDATE "ScanDispatch"
      SET "leaseUntil" = CURRENT_TIMESTAMP - INTERVAL '1 millisecond'
      WHERE "scanId" = ${scanId}
    `;
    const secondClaim = await claimNextStageDispatch(second.prisma, { leaseMs: 30_000 });
    expect(secondClaim?.scanId).toBe(scanId);
    const beforeStaleFinalize = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } });

    await expect(finalizeStageDispatchEnqueueFailure(first.prisma, {
      scanId,
      claimToken: firstClaim!.claimToken,
      errorCode: 'REDIS_UNAVAILABLE'
    })).resolves.toBe(false);
    expect(await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } })).toEqual(beforeStaleFinalize);

    const beforeRetry = await databaseNow(first.prisma);
    await expect(finalizeStageDispatchEnqueueFailure(second.prisma, {
      scanId,
      claimToken: secondClaim!.claimToken,
      errorCode: 'REDIS_UNAVAILABLE'
    })).resolves.toBe(true);
    const afterRetry = await first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } });
    const afterNow = await databaseNow(first.prisma);

    expect(afterRetry).toMatchObject({
      state: 'PENDING',
      attemptCount: 1,
      claimToken: null,
      leaseUntil: null,
      lastErrorCode: 'REDIS_UNAVAILABLE'
    });
    expect(afterRetry.nextAttemptAt.getTime()).toBeGreaterThanOrEqual(beforeRetry.getTime() + 900);
    expect(afterRetry.nextAttemptAt.getTime()).toBeLessThanOrEqual(afterNow.getTime() + 1_100);
  });

  it('atomically absorbs the fifth dispatch failure without a sixth claim', async () => {
    const scanId = await createDispatch(first.prisma, 'dispatch-exhaustion');
    await first.prisma.page.create({ data: { scanId, url: 'https://dispatch-exhaustion.test' } });
    await first.prisma.scanDispatch.update({
      where: { scanId },
      data: { dispatchAttemptCount: 4, attemptCount: 4 }
    });
    const claim = await claimNextStageDispatch(first.prisma, { leaseMs: 30_000, scanId });
    expect(claim?.dispatchAttemptCount).toBe(4);

    await expect(finalizeStageDispatchEnqueueFailure(first.prisma, {
      scanId,
      claimToken: claim!.claimToken,
      errorCode: 'redis unavailable with secret detail'
    })).resolves.toBe(true);

    const [dispatch, scan, page] = await Promise.all([
      first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } }),
      first.prisma.scan.findUniqueOrThrow({ where: { id: scanId } }),
      first.prisma.page.findFirstOrThrow({ where: { scanId } })
    ]);
    expect(dispatch).toMatchObject({
      state: 'DEAD',
      dispatchAttemptCount: 5,
      attemptCount: 5,
      lastErrorCode: 'REDIS_UNAVAILABLE_WITH_SECRET_DETAIL',
      claimToken: null,
      leaseUntil: null
    });
    expect(dispatch.completedAt).not.toBeNull();
    expect(scan).toMatchObject({ status: 'failed', coverage: 'FAILED' });
    expect(scan.completedAt?.getTime()).toBe(dispatch.completedAt?.getTime());
    expect(page).toMatchObject({ outcome: 'FAILED', error: 'Execution unavailable before analysis' });
    await expect(claimNextStageDispatch(first.prisma, { leaseMs: 30_000, scanId })).resolves.toBeNull();
  });

  it('canonicalizes historical completed and failed scans into absorbing ledger terminals', async () => {
    const completedId = await createDispatch(first.prisma, 'terminal-completed');
    const failedId = await createDispatch(first.prisma, 'terminal-failed');
    const completedAt = new Date('2026-11-12T12:00:00.000Z');
    const failedAt = new Date('2026-11-12T12:01:00.000Z');
    await first.prisma.scan.update({ where: { id: completedId }, data: { status: 'completed', coverage: 'COMPLETE', completedAt } });
    await first.prisma.scan.update({ where: { id: failedId }, data: { status: 'failed', coverage: 'FAILED', completedAt: failedAt } });
    await first.prisma.scanDispatch.update({ where: { scanId: failedId }, data: { state: 'ENQUEUED', enqueuedAt: new Date() } });

    await expect(canonicalizeTerminalStageDispatches(first.prisma)).resolves.toBe(2);

    const [completed, failed] = await Promise.all([
      first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: completedId } }),
      first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: failedId } })
    ]);
    expect(completed).toMatchObject({ state: 'COMPLETED', completedAt, claimToken: null, runClaimToken: null });
    expect(failed).toMatchObject({ state: 'DEAD', completedAt: failedAt, claimToken: null, runClaimToken: null });
    await expect(canonicalizeTerminalStageDispatches(first.prisma)).resolves.toBe(0);
    await expect(claimNextStageDispatch(first.prisma, { leaseMs: 30_000 })).resolves.toBeNull();
  });

  it('terminalizes an abandoned third run after its DB-time lease expires and never grants a fourth run', async () => {
    const scanId = await createDispatch(first.prisma, 'abandoned-third-run');
    const jobId = `${scanId}-analyze-2`;
    await first.prisma.page.create({ data: { scanId, url: 'https://abandoned-third-run.test' } });
    await first.prisma.scan.update({ where: { id: scanId }, data: { status: 'analyzing' } });
    await first.prisma.scanDispatch.update({
      where: { scanId },
      data: {
        stage: 'ANALYZE', generation: 2, jobId, state: 'ENQUEUED', runAttemptCount: 3,
        runClaimToken: '00000000-0000-4000-8000-000000000099'
      }
    });
    await first.prisma.$executeRaw`
      UPDATE "ScanDispatch" SET "runLeaseUntil" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "scanId" = ${scanId}
    `;

    await expect(terminalizeAbandonedStageRun(first.prisma, {
      scanId, stage: 'ANALYZE', generation: 2, jobId, runAttemptCount: 3
    }, 'ABANDONED_RUN_EXHAUSTED')).resolves.toBe(true);

    const [dispatch, scan, page] = await Promise.all([
      first.prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } }),
      first.prisma.scan.findUniqueOrThrow({ where: { id: scanId } }),
      first.prisma.page.findFirstOrThrow({ where: { scanId } })
    ]);
    expect(dispatch).toMatchObject({ state: 'DEAD', runAttemptCount: 3, runClaimToken: null, runLeaseUntil: null });
    expect(scan).toMatchObject({ status: 'failed', coverage: 'FAILED' });
    expect(page).toMatchObject({ outcome: 'FAILED', error: 'Page analysis failed' });
    await expect(claimStageRun(first.prisma, { scanId, stage: 'ANALYZE', generation: 2, leaseMs: 30_000 })).resolves.toBeNull();
  });
});
