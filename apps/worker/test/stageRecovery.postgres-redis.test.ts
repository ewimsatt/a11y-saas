import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../../packages/db/generated/prisma/client.ts';
import { Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimNextStageDispatch, finalizeStageDispatchEnqueueSuccess } from '@a11y/db';
import { claimStageRunAfterDispatchFinalize } from '../src/stageRunClaim.ts';

const databaseUrl = process.env.STAGE_DISPATCH_TEST_DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl || !redisUrl) {
  throw new Error('STAGE_DISPATCH_TEST_DATABASE_URL and REDIS_URL are required: this real-service suite must never skip');
}
const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '');
if (!/^a11y_stage_dispatch_test(?:_|$)/.test(databaseName)) {
  throw new Error(`refusing non-owned PostgreSQL database ${databaseName}`);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runId = `stage-recovery-${crypto.randomUUID()}`;
const prefix = `a11y-stage-recovery-test-${crypto.randomUUID()}`;
const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });
const redis = new Redis(redisUrl, { maxRetriesPerRequest: null });
const crawlQueue = new Queue('crawl', { connection: redis, prefix });

async function cleanupOwned(): Promise<void> {
  await crawlQueue.obliterate({ force: true }).catch(() => undefined);
  await prisma.project.deleteMany({ where: { name: { startsWith: runId } } });
}

describe('stage recovery with real PostgreSQL and Redis', () => {
  beforeAll(cleanupOwned);

  afterAll(async () => {
    await cleanupOwned();
    await crawlQueue.close();
    await redis.quit();
    await prisma.$disconnect();
  });

  it('keeps the selected evidence-fault scan dormant until the trigger is installed and retry begins', async () => {
    const project = await prisma.project.create({
      data: { name: `${runId}-evidence-fault-setup`, baseUrl: 'https://evidence-fault.test' }
    });

    const output = execFileSync('pnpm', ['tsx', 'apps/api/test/acceptanceAtomicEvidence.ts', 'create-queued-scan', project.id], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        BULLMQ_PREFIX: prefix
      },
      encoding: 'utf8'
    });
    const scanId = output.trim();

    await expect(claimNextStageDispatch(prisma, { scanId, stage: 'CRAWL', leaseMs: 30_000 })).resolves.toBeNull();
    await expect(prisma.scan.findUniqueOrThrow({ where: { id: scanId } })).resolves.toMatchObject({
      status: 'failed',
      coverage: 'FAILED'
    });
    await expect(prisma.scanDispatch.findUniqueOrThrow({ where: { scanId } })).resolves.toMatchObject({
      state: 'DEAD',
      stage: 'CRAWL',
      generation: 0
    });
    expect(await crawlQueue.getJob(`${scanId}-crawl-0`)).toBeUndefined();
  }, 30_000);

  it('legacy retry enters through PENDING ledger intent and never pre-enqueues a terminal deterministic job', async () => {
    const project = await prisma.project.create({
      data: { name: `${runId}-legacy-retry`, baseUrl: 'https://legacy-retry.test' }
    });
    const scan = await prisma.scan.create({
      data: { projectId: project.id, status: 'failed', coverage: 'FAILED', completedAt: new Date() }
    });
    await prisma.page.create({
      data: { scanId: scan.id, url: project.baseUrl, outcome: 'FAILED', error: 'prior failure' }
    });
    await prisma.scanDispatch.create({
      data: {
        scanId: scan.id,
        jobId: `${scan.id}-crawl-0`,
        stage: 'CRAWL',
        generation: 0,
        state: 'DEAD',
        dispatchAttemptCount: 5,
        attemptCount: 5,
        runAttemptCount: 3,
        completedAt: new Date(),
        lastErrorCode: 'PRIOR_FAILURE'
      }
    });

    execFileSync('pnpm', ['tsx', 'apps/api/test/acceptanceAtomicEvidence.ts', 'retry', scan.id], {
      cwd: root,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        REDIS_URL: redisUrl,
        BULLMQ_PREFIX: prefix
      },
      stdio: 'pipe'
    });

    const dispatch = await prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: scan.id } });
    expect(dispatch).toMatchObject({
      stage: 'CRAWL',
      generation: 1,
      jobId: `${scan.id}-crawl-1`,
      state: 'PENDING',
      dispatchAttemptCount: 0,
      runAttemptCount: 0,
      claimToken: null,
      runClaimToken: null,
      enqueuedAt: null,
      completedAt: null,
      lastErrorCode: null
    });
    expect(await crawlQueue.getJob(dispatch.jobId)).toBeUndefined();
  }, 30_000);

  it('claims a real Redis delivery that arrives before its database enqueue finalizer', async () => {
    const project = await prisma.project.create({
      data: { name: `${runId}-add-before-finalize`, baseUrl: 'https://add-before-finalize.test' }
    });
    const scan = await prisma.scan.create({ data: { projectId: project.id, status: 'queued' } });
    await prisma.scanDispatch.create({
      data: { scanId: scan.id, jobId: `${scan.id}-crawl-0`, stage: 'CRAWL', generation: 0, state: 'PENDING' }
    });
    const dispatch = await claimNextStageDispatch(prisma, { scanId: scan.id, stage: 'CRAWL', leaseMs: 30_000 });
    expect(dispatch).not.toBeNull();

    const events = new QueueEvents('crawl', { connection: redis.duplicate(), prefix });
    const worker = new Worker('crawl', async (job) => {
      const run = await claimStageRunAfterDispatchFinalize(prisma, {
        scanId: job.data.scanId,
        stage: job.data.stage,
        generation: job.data.generation,
        leaseMs: 30_000
      }, 100, 5);
      if (!run) {
        const row = await prisma.scanDispatch.findUnique({ where: { scanId: scan.id } });
        throw new Error(`delivery was acknowledged without a durable run claim: ${JSON.stringify(row)}`);
      }
      return run.runAttemptCount;
    }, { connection: redis.duplicate(), prefix });
    try {
      const job = await crawlQueue.add('crawl', {
        scanId: scan.id, stage: 'CRAWL', generation: 0
      }, { jobId: dispatch!.jobId, removeOnComplete: false });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(finalizeStageDispatchEnqueueSuccess(prisma, dispatch!)).resolves.toBe(true);
      await expect(job.waitUntilFinished(events, 10_000)).resolves.toBe(1);
      const durable = await prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: scan.id } });
      expect(durable).toMatchObject({ state: 'ENQUEUED', runAttemptCount: 1 });
      expect(durable.runClaimToken).not.toBeNull();
    } finally {
      await worker.close();
      await events.close();
    }
  }, 30_000);
});
