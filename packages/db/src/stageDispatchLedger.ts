import type { PrismaClient } from '../generated/prisma/client.ts';

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60_000;
const MAX_DISPATCH_ATTEMPTS = 5;

export type ClaimedStageDispatch = {
  scanId: string;
  jobId: string;
  stage: 'CRAWL' | 'ANALYZE' | 'DIFF' | 'EVIDENCE';
  generation: number;
  attemptCount: number;
  dispatchAttemptCount: number;
  runAttemptCount: number;
  nextAttemptAt: Date;
  lastAttemptAt: Date | null;
  enqueuedAt: Date | null;
  lastErrorCode: string | null;
  claimToken: string;
  leaseUntil: Date;
};

export type StageDispatchClaimOptions = {
  /** A bounded database-time lease. Application clocks never participate in eligibility. */
  leaseMs: number;
  /** Optional exact durable identity filter for an API or worker recovery pass. */
  scanId?: string;
  stage?: 'CRAWL' | 'ANALYZE' | 'DIFF' | 'EVIDENCE';
};

export type StageDispatchFinalization = {
  scanId: string;
  claimToken: string;
};

export type StageDispatchFailureFinalization = StageDispatchFinalization & {
  /** Stored as a safe, bounded operational code rather than raw queue error text. */
  errorCode: string;
};

function validateBoundedMilliseconds(value: number, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer from ${min} through ${max}`);
  }
}

function validateLeaseMs(leaseMs: number): void {
  validateBoundedMilliseconds(leaseMs, 'leaseMs', MIN_LEASE_MS, MAX_LEASE_MS);
}


function sanitizeErrorCode(errorCode: string): string {
  const normalized = errorCode
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 100);
  return normalized || 'DISPATCH_FAILED';
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

/** Canonicalizes historical terminal scans once and makes their ledger rows absorbing. */
export async function canonicalizeTerminalStageDispatches(prisma: PrismaClient): Promise<number> {
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch" AS dispatch
    SET "state" = CASE
          WHEN scan."status" = 'completed' THEN 'COMPLETED'::"DispatchState"
          ELSE 'DEAD'::"DispatchState"
        END,
        "completedAt" = COALESCE(dispatch."completedAt", scan."completedAt", CURRENT_TIMESTAMP),
        "claimToken" = NULL,
        "leaseUntil" = NULL,
        "runClaimToken" = NULL,
        "runLeaseUntil" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM "Scan" AS scan
    WHERE dispatch."scanId" = scan.id
      AND scan."status" IN ('completed', 'failed')
      AND dispatch."state" IS DISTINCT FROM CASE
        WHEN scan."status" = 'completed' THEN 'COMPLETED'::"DispatchState"
        ELSE 'DEAD'::"DispatchState"
      END
    RETURNING dispatch."scanId" AS "scanId"
  `;
  return rows.length;
}

/**
 * Claims one due initial dispatch intent using PostgreSQL time, row locking,
 * and a fresh database-generated UUID fence.
 *
 * This intentionally owns only Redis-enqueue bookkeeping for the existing
 * initial `ScanDispatch` intent. It does not grant worker-stage run ownership.
 */
export async function claimNextStageDispatch(
  prisma: PrismaClient,
  { leaseMs, scanId, stage }: StageDispatchClaimOptions
): Promise<ClaimedStageDispatch | null> {
  validateLeaseMs(leaseMs);
  const requestedScanId = scanId ?? null;
  const requestedStage = stage ?? null;

  const claimed = await prisma.$queryRaw<ClaimedStageDispatch[]>`
    WITH candidate AS (
      SELECT dispatch."scanId"
      FROM "ScanDispatch" AS dispatch
      JOIN "Scan" AS scan ON scan.id = dispatch."scanId"
      WHERE (${requestedScanId}::text IS NULL OR dispatch."scanId" = ${requestedScanId})
        AND (${requestedStage}::"DispatchStage" IS NULL OR dispatch."stage" = ${requestedStage}::"DispatchStage")
        AND scan."status" NOT IN ('completed', 'failed')
        AND dispatch."dispatchAttemptCount" < ${MAX_DISPATCH_ATTEMPTS}
        AND (
          (dispatch."state" = 'PENDING' AND dispatch."nextAttemptAt" <= CURRENT_TIMESTAMP)
          OR (dispatch."state" = 'DISPATCHING' AND (dispatch."leaseUntil" IS NULL OR dispatch."leaseUntil" <= CURRENT_TIMESTAMP))
        )
      ORDER BY dispatch."nextAttemptAt" ASC, dispatch."scanId" ASC
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    UPDATE "ScanDispatch" AS dispatch
    SET
      "state" = 'DISPATCHING',
      "claimToken" = gen_random_uuid(),
      "lastAttemptAt" = CURRENT_TIMESTAMP,
      "leaseUntil" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'),
      "updatedAt" = CURRENT_TIMESTAMP
    FROM candidate
    WHERE dispatch."scanId" = candidate."scanId"
    RETURNING
      dispatch."scanId" AS "scanId",
      dispatch."jobId" AS "jobId",
      dispatch."stage" AS "stage",
      dispatch."generation" AS "generation",
      dispatch."attemptCount" AS "attemptCount",
      dispatch."dispatchAttemptCount" AS "dispatchAttemptCount",
      dispatch."runAttemptCount" AS "runAttemptCount",
      dispatch."nextAttemptAt" AS "nextAttemptAt",
      dispatch."lastAttemptAt" AS "lastAttemptAt",
      dispatch."enqueuedAt" AS "enqueuedAt",
      dispatch."lastErrorCode" AS "lastErrorCode",
      dispatch."claimToken" AS "claimToken",
      dispatch."leaseUntil" AS "leaseUntil"
  `;

  return claimed[0] ?? null;
}

/**
 * Marks a Redis enqueue as durable only when this exact, unexpired claim still
 * owns the intent. A false result is a lost fence and must be a no-op to callers.
 */
export async function finalizeStageDispatchEnqueueSuccess(
  prisma: PrismaClient,
  { scanId, claimToken }: StageDispatchFinalization
): Promise<boolean> {
  if (!isUuid(claimToken)) return false;
  const finalized = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch"
    SET
      "state" = 'ENQUEUED',
      "enqueuedAt" = CURRENT_TIMESTAMP,
      "lastAttemptAt" = CURRENT_TIMESTAMP,
      "claimToken" = NULL,
      "leaseUntil" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "scanId" = ${scanId}
      AND "claimToken" = CAST(${claimToken} AS UUID)
      AND "state" = 'DISPATCHING'
      AND "leaseUntil" > CURRENT_TIMESTAMP
    RETURNING "scanId" AS "scanId"
  `;
  return finalized.length === 1;
}

/**
 * Releases a failed Redis enqueue only when this exact, unexpired claim still
 * owns the intent. Retry timing is computed by PostgreSQL, not the caller clock.
 */
export async function finalizeStageDispatchEnqueueFailure(
  prisma: PrismaClient,
  { scanId, claimToken, errorCode }: StageDispatchFailureFinalization
): Promise<boolean> {
  if (!isUuid(claimToken)) return false;
  const safeErrorCode = sanitizeErrorCode(errorCode);
  const finalized = await prisma.$queryRaw<{ scanId: string }[]>`
    WITH failed_dispatch AS (
      UPDATE "ScanDispatch" AS dispatch
      SET
        "state" = CASE
          WHEN dispatch."dispatchAttemptCount" + 1 >= ${MAX_DISPATCH_ATTEMPTS} THEN 'DEAD'::"DispatchState"
          ELSE 'PENDING'::"DispatchState"
        END,
        "attemptCount" = dispatch."attemptCount" + 1,
        "dispatchAttemptCount" = dispatch."dispatchAttemptCount" + 1,
        "nextAttemptAt" = CURRENT_TIMESTAMP
          + ((POWER(2, LEAST(dispatch."dispatchAttemptCount", 4)))::integer * INTERVAL '1 second'),
        "completedAt" = CASE
          WHEN dispatch."dispatchAttemptCount" + 1 >= ${MAX_DISPATCH_ATTEMPTS} THEN CURRENT_TIMESTAMP
          ELSE NULL
        END,
        "lastErrorCode" = ${safeErrorCode},
        "claimToken" = NULL,
        "leaseUntil" = NULL,
        "runClaimToken" = CASE
          WHEN dispatch."dispatchAttemptCount" + 1 >= ${MAX_DISPATCH_ATTEMPTS} THEN NULL
          ELSE dispatch."runClaimToken"
        END,
        "runLeaseUntil" = CASE
          WHEN dispatch."dispatchAttemptCount" + 1 >= ${MAX_DISPATCH_ATTEMPTS} THEN NULL
          ELSE dispatch."runLeaseUntil"
        END,
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE dispatch."scanId" = ${scanId}
        AND dispatch."claimToken" = CAST(${claimToken} AS UUID)
        AND dispatch."state" = 'DISPATCHING'
        AND dispatch."leaseUntil" > CURRENT_TIMESTAMP
        AND dispatch."dispatchAttemptCount" < ${MAX_DISPATCH_ATTEMPTS}
      RETURNING dispatch."scanId", dispatch."stage", dispatch."state", dispatch."completedAt"
    ), failed_scan AS (
      UPDATE "Scan" AS scan
      SET "status" = 'failed', "coverage" = 'FAILED', "completedAt" = failed_dispatch."completedAt"
      FROM failed_dispatch
      WHERE scan.id = failed_dispatch."scanId"
        AND failed_dispatch."state" = 'DEAD'
        AND scan."status" NOT IN ('completed', 'failed')
      RETURNING scan.id
    ), failed_pages AS (
      UPDATE "Page" AS page
      SET "outcome" = 'FAILED', "status" = NULL,
          "error" = CASE
            WHEN failed_dispatch."stage" = 'CRAWL' THEN 'Execution unavailable before analysis'
            WHEN failed_dispatch."stage" = 'ANALYZE' THEN 'Page analysis failed'
            ELSE 'Scan finalization failed'
          END
      FROM failed_dispatch, failed_scan
      WHERE page."scanId" = failed_dispatch."scanId"
        AND page."outcome" = 'PENDING'
      RETURNING page.id
    )
    SELECT "scanId" AS "scanId" FROM failed_dispatch
  `;
  return finalized.length === 1;
}

export type StageRun = {
  scanId: string;
  stage: 'CRAWL' | 'ANALYZE' | 'DIFF' | 'EVIDENCE';
  generation: number;
  runClaimToken: string;
  runAttemptCount: number;
  runLeaseUntil: Date;
};

export type StageRunClaimOptions = {
  scanId: string;
  stage: StageRun['stage'];
  generation: number;
  leaseMs: number;
};

type Queryable = Pick<PrismaClient, '$queryRaw'>;

export type EnqueuedStage = {
  scanId: string;
  stage: StageRun['stage'];
  generation: number;
  jobId: string;
  runAttemptCount: number;
  runLeaseUntil?: Date | null;
};

/** Returns only DB-time-stale live transports; callers must inspect Redis before release. */
export async function findStaleEnqueuedStages(prisma: Queryable, ageMs: number, limit = 20): Promise<EnqueuedStage[]> {
  validateBoundedMilliseconds(ageMs, 'ageMs', MIN_LEASE_MS, MAX_LEASE_MS);
  return prisma.$queryRaw<EnqueuedStage[]>`
    SELECT dispatch."scanId" AS "scanId", dispatch."stage" AS "stage",
      dispatch."generation" AS "generation", dispatch."jobId" AS "jobId",
      dispatch."runAttemptCount" AS "runAttemptCount", dispatch."runLeaseUntil" AS "runLeaseUntil"
    FROM "ScanDispatch" AS dispatch
    JOIN "Scan" AS scan ON scan.id = dispatch."scanId"
    WHERE dispatch."state" = 'ENQUEUED'
      AND scan."status" NOT IN ('completed', 'failed')
      AND dispatch."enqueuedAt" <= CURRENT_TIMESTAMP - (${ageMs} * INTERVAL '1 millisecond')
    ORDER BY dispatch."enqueuedAt" ASC NULLS FIRST LIMIT ${limit}
  `;
}

/**
 * Absorbs an exact third run whose owner disappeared. PostgreSQL time decides
 * lease expiry and the stage, scan, and still-pending pages change together.
 */
export async function terminalizeAbandonedStageRun(
  prisma: Queryable,
  stage: EnqueuedStage,
  errorCode: string
): Promise<boolean> {
  const safeErrorCode = sanitizeErrorCode(errorCode);
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    WITH dead_dispatch AS (
      UPDATE "ScanDispatch" AS dispatch
      SET "state" = 'DEAD', "completedAt" = CURRENT_TIMESTAMP,
          "lastErrorCode" = ${safeErrorCode}, "claimToken" = NULL,
          "leaseUntil" = NULL, "runClaimToken" = NULL,
          "runLeaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
      FROM "Scan" AS scan
      WHERE dispatch."scanId" = ${stage.scanId}
        AND dispatch."scanId" = scan.id
        AND dispatch."stage" = ${stage.stage}::"DispatchStage"
        AND dispatch."generation" = ${stage.generation}
        AND dispatch."jobId" = ${stage.jobId}
        AND dispatch."state" = 'ENQUEUED'
        AND dispatch."runAttemptCount" >= 3
        AND (dispatch."runLeaseUntil" IS NULL OR dispatch."runLeaseUntil" <= CURRENT_TIMESTAMP)
        AND scan."status" NOT IN ('completed', 'failed')
      RETURNING dispatch."scanId", dispatch."stage", dispatch."completedAt"
    ), dead_scan AS (
      UPDATE "Scan" AS scan
      SET "status" = 'failed', "coverage" = 'FAILED',
          "completedAt" = dead_dispatch."completedAt"
      FROM dead_dispatch
      WHERE scan.id = dead_dispatch."scanId"
        AND scan."status" NOT IN ('completed', 'failed')
      RETURNING scan.id
    ), dead_pages AS (
      UPDATE "Page" AS page
      SET "outcome" = 'FAILED', "status" = NULL,
          "error" = CASE
            WHEN dead_dispatch."stage" = 'CRAWL' THEN 'Execution unavailable before analysis'
            WHEN dead_dispatch."stage" = 'ANALYZE' THEN 'Page analysis failed'
            ELSE 'Scan finalization failed'
          END
      FROM dead_dispatch, dead_scan
      WHERE page."scanId" = dead_dispatch."scanId"
        AND page."outcome" = 'PENDING'
      RETURNING page.id
    )
    SELECT "scanId" AS "scanId" FROM dead_dispatch
  `;
  return rows.length === 1;
}

/** Returns a live ledger row to PENDING only when its exact terminal Redis transport was observed. */
export async function releaseEnqueuedStageForReconcile(prisma: Queryable, stage: EnqueuedStage): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch" SET "state" = 'PENDING', "nextAttemptAt" = CURRENT_TIMESTAMP,
      "claimToken" = NULL, "leaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "scanId" = ${stage.scanId} AND "stage" = ${stage.stage}::"DispatchStage"
      AND "generation" = ${stage.generation} AND "jobId" = ${stage.jobId} AND "state" = 'ENQUEUED'
    RETURNING "scanId" AS "scanId"
  `;
  return rows.length === 1;
}

/**
 * Atomically fences a single durable processor execution. A current-generation
 * duplicate returns null before it can touch scan/page/finding/evidence state.
 */
export async function claimStageRun(prisma: Queryable, options: StageRunClaimOptions): Promise<StageRun | null> {
  validateLeaseMs(options.leaseMs);
  const claimed = await prisma.$queryRaw<StageRun[]>`
    UPDATE "ScanDispatch" AS dispatch
    SET "runClaimToken" = gen_random_uuid(),
        "runLeaseUntil" = CURRENT_TIMESTAMP + (${options.leaseMs} * INTERVAL '1 millisecond'),
        "runAttemptCount" = dispatch."runAttemptCount" + 1,
        "updatedAt" = CURRENT_TIMESTAMP
    FROM "Scan" AS scan
    WHERE dispatch."scanId" = ${options.scanId}
      AND dispatch."scanId" = scan.id
      AND dispatch."stage" = ${options.stage}::"DispatchStage"
      AND dispatch."generation" = ${options.generation}
      AND dispatch."state" = 'ENQUEUED'
      AND scan."status" NOT IN ('completed', 'failed')
      AND (dispatch."runLeaseUntil" IS NULL OR dispatch."runLeaseUntil" <= CURRENT_TIMESTAMP)
      AND dispatch."runAttemptCount" < 3
    RETURNING dispatch."scanId" AS "scanId", dispatch."stage" AS "stage",
      dispatch."generation" AS "generation", dispatch."runClaimToken" AS "runClaimToken",
      dispatch."runAttemptCount" AS "runAttemptCount", dispatch."runLeaseUntil" AS "runLeaseUntil"
  `;
  return claimed[0] ?? null;
}

/** A fenced lease renewal for long browser work. */
export async function renewStageRun(prisma: Queryable, run: StageRun, leaseMs: number): Promise<boolean> {
  validateLeaseMs(leaseMs);
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch"
    SET "runLeaseUntil" = CURRENT_TIMESTAMP + (${leaseMs} * INTERVAL '1 millisecond'), "updatedAt" = CURRENT_TIMESTAMP
    WHERE "scanId" = ${run.scanId} AND "stage" = ${run.stage}::"DispatchStage"
      AND "generation" = ${run.generation} AND "state" = 'ENQUEUED'
      AND "runClaimToken" = CAST(${run.runClaimToken} AS UUID) AND "runLeaseUntil" > CURRENT_TIMESTAMP
    RETURNING "scanId" AS "scanId"
  `;
  return rows.length === 1;
}

/** Locks and verifies an exact run owner inside a caller-owned transaction. */
export async function lockStageRun(prisma: Queryable, run: StageRun): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    SELECT dispatch."scanId" AS "scanId"
    FROM "ScanDispatch" AS dispatch JOIN "Scan" AS scan ON scan.id = dispatch."scanId"
    WHERE dispatch."scanId" = ${run.scanId} AND dispatch."stage" = ${run.stage}::"DispatchStage"
      AND dispatch."generation" = ${run.generation} AND dispatch."state" = 'ENQUEUED'
      AND dispatch."runClaimToken" = CAST(${run.runClaimToken} AS UUID)
      AND dispatch."runLeaseUntil" > CURRENT_TIMESTAMP AND scan."status" NOT IN ('completed', 'failed')
    FOR UPDATE
  `;
  return rows.length === 1;
}

/** Releases a nonfinal failed attempt so BullMQ may deliver the remaining DB budget. */
export async function releaseStageRun(prisma: Queryable, run: StageRun): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch" SET "runClaimToken" = NULL, "runLeaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "scanId" = ${run.scanId} AND "stage" = ${run.stage}::"DispatchStage" AND "generation" = ${run.generation}
      AND "state" = 'ENQUEUED' AND "runClaimToken" = CAST(${run.runClaimToken} AS UUID)
    RETURNING "scanId" AS "scanId"
  `;
  return rows.length === 1;
}

/** Moves one owned stage to a successor PENDING intent while retaining one row per scan. */
export async function advanceStageRun(
  prisma: Queryable,
  run: StageRun,
  nextStage: StageRun['stage'],
  nextJobId: string
): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch"
    SET "stage" = ${nextStage}::"DispatchStage", "generation" = "generation" + 1,
        "jobId" = ${nextJobId}, "state" = 'PENDING', "dispatchAttemptCount" = 0,
        "attemptCount" = 0, "runAttemptCount" = 0, "nextAttemptAt" = CURRENT_TIMESTAMP,
        "lastAttemptAt" = NULL, "enqueuedAt" = NULL, "completedAt" = NULL,
        "lastErrorCode" = NULL, "claimToken" = NULL, "leaseUntil" = NULL,
        "runClaimToken" = NULL, "runLeaseUntil" = NULL, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "scanId" = ${run.scanId} AND "stage" = ${run.stage}::"DispatchStage" AND "generation" = ${run.generation}
      AND "state" = 'ENQUEUED' AND "runClaimToken" = CAST(${run.runClaimToken} AS UUID)
      AND "runLeaseUntil" > CURRENT_TIMESTAMP
    RETURNING "scanId" AS "scanId"
  `;
  return rows.length === 1;
}

/** Completes an owned EVIDENCE stage with one database timestamp. */
export async function completeStageRun(prisma: Queryable, run: StageRun): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch"
    SET "state" = 'COMPLETED', "completedAt" = CURRENT_TIMESTAMP,
        "runClaimToken" = NULL, "runLeaseUntil" = NULL, "claimToken" = NULL, "leaseUntil" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "scanId" = ${run.scanId} AND "stage" = ${run.stage}::"DispatchStage" AND "generation" = ${run.generation}
      AND "state" = 'ENQUEUED' AND "runClaimToken" = CAST(${run.runClaimToken} AS UUID)
      AND "runLeaseUntil" > CURRENT_TIMESTAMP
    RETURNING "scanId" AS "scanId"
  `;
  return rows.length === 1;
}

/** Terminalizes only the exact exhausted run. A stale failure is an absorbing no-op. */
export async function failStageRun(prisma: Queryable, run: StageRun, errorCode: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch"
    SET "state" = 'DEAD', "completedAt" = CURRENT_TIMESTAMP, "lastErrorCode" = ${sanitizeErrorCode(errorCode)},
        "runClaimToken" = NULL, "runLeaseUntil" = NULL, "claimToken" = NULL, "leaseUntil" = NULL,
        "updatedAt" = CURRENT_TIMESTAMP
    WHERE "scanId" = ${run.scanId} AND "stage" = ${run.stage}::"DispatchStage" AND "generation" = ${run.generation}
      AND "state" = 'ENQUEUED' AND "runClaimToken" = CAST(${run.runClaimToken} AS UUID)
      AND "runLeaseUntil" > CURRENT_TIMESTAMP AND "runAttemptCount" >= 3
    RETURNING "scanId" AS "scanId"
  `;
  return rows.length === 1;
}
