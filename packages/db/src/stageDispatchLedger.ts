import type { PrismaClient } from '../generated/prisma/client.ts';

const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 5 * 60_000;
const MIN_RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;

export type ClaimedStageDispatch = {
  scanId: string;
  jobId: string;
  attemptCount: number;
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
};

export type StageDispatchFinalization = {
  scanId: string;
  claimToken: string;
};

export type StageDispatchFailureFinalization = StageDispatchFinalization & {
  /** A bounded database-time delay before the next dispatch attempt. */
  retryDelayMs: number;
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

function validateRetryDelayMs(retryDelayMs: number): void {
  validateBoundedMilliseconds(retryDelayMs, 'retryDelayMs', MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS);
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

/**
 * Claims one due initial dispatch intent using PostgreSQL time, row locking,
 * and a fresh database-generated UUID fence.
 *
 * This intentionally owns only Redis-enqueue bookkeeping for the existing
 * initial `ScanDispatch` intent. It does not grant worker-stage run ownership.
 */
export async function claimNextStageDispatch(
  prisma: PrismaClient,
  { leaseMs }: StageDispatchClaimOptions
): Promise<ClaimedStageDispatch | null> {
  validateLeaseMs(leaseMs);

  const claimed = await prisma.$queryRaw<ClaimedStageDispatch[]>`
    WITH candidate AS (
      SELECT "scanId"
      FROM "ScanDispatch"
      WHERE (
        "state" = 'PENDING'
        AND "nextAttemptAt" <= CURRENT_TIMESTAMP
      ) OR (
        "state" = 'DISPATCHING'
        AND ("leaseUntil" IS NULL OR "leaseUntil" <= CURRENT_TIMESTAMP)
      )
      ORDER BY "nextAttemptAt" ASC, "scanId" ASC
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
      dispatch."attemptCount" AS "attemptCount",
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
  { scanId, claimToken, retryDelayMs, errorCode }: StageDispatchFailureFinalization
): Promise<boolean> {
  validateRetryDelayMs(retryDelayMs);
  if (!isUuid(claimToken)) return false;
  const safeErrorCode = sanitizeErrorCode(errorCode);
  const finalized = await prisma.$queryRaw<{ scanId: string }[]>`
    UPDATE "ScanDispatch"
    SET
      "state" = 'PENDING',
      "attemptCount" = "attemptCount" + 1,
      "nextAttemptAt" = CURRENT_TIMESTAMP + (${retryDelayMs} * INTERVAL '1 millisecond'),
      "lastErrorCode" = ${safeErrorCode},
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
 * Integration TODO, deliberately not wired on this foundation branch:
 * - Replace API `dispatchScan` / `dispatchDueScans` only together with exact
 *   Redis-job reconciliation using these token-fenced finalizers.
 * - Do not use this dispatch lease for worker crawl/analyze/diff/evidence runs;
 *   those require separate stage/generation/run-token fencing.
 */
