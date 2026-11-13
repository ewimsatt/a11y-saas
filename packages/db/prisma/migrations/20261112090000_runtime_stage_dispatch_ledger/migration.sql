-- PostgreSQL-authoritative runtime stage ledger. Existing ScanDispatch rows remain
-- CRAWL at generation zero and retain all historical dispatch bookkeeping.
CREATE TYPE "DispatchStage" AS ENUM ('CRAWL', 'ANALYZE', 'DIFF', 'EVIDENCE');
ALTER TYPE "DispatchState" ADD VALUE IF NOT EXISTS 'COMPLETED';

ALTER TABLE "ScanDispatch"
  ADD COLUMN "stage" "DispatchStage" NOT NULL DEFAULT 'CRAWL',
  ADD COLUMN "generation" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "dispatchAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "runAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "completedAt" TIMESTAMP(3),
  ADD COLUMN "runClaimToken" UUID,
  ADD COLUMN "runLeaseUntil" TIMESTAMP(3);

UPDATE "ScanDispatch"
SET "dispatchAttemptCount" = "attemptCount"
WHERE "dispatchAttemptCount" = 0 AND "attemptCount" <> 0;

-- Existing terminal business rows are absorbing. Preserve their known completion
-- timestamp and clear any stale transport/run ownership inherited from history.
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
  AND scan."status" IN ('completed', 'failed');

-- Historical dispatching capped retries but left exhausted rows PENDING. Resolve
-- those nonterminal scans during the upgrade so the new < 5 claim predicate
-- cannot strand them. All timestamps use this migration transaction's DB time.
UPDATE "ScanDispatch" AS dispatch
SET "state" = 'DEAD'::"DispatchState",
    "completedAt" = CURRENT_TIMESTAMP,
    "claimToken" = NULL,
    "leaseUntil" = NULL,
    "runClaimToken" = NULL,
    "runLeaseUntil" = NULL,
    "updatedAt" = CURRENT_TIMESTAMP
FROM "Scan" AS scan
WHERE dispatch."scanId" = scan.id
  AND dispatch."state" = 'PENDING'::"DispatchState"
  AND dispatch."attemptCount" >= 5
  AND scan."status" NOT IN ('completed', 'failed');

UPDATE "Scan" AS scan
SET "status" = 'failed',
    "coverage" = 'FAILED',
    "completedAt" = CURRENT_TIMESTAMP
FROM "ScanDispatch" AS dispatch
WHERE dispatch."scanId" = scan.id
  AND dispatch."state" = 'DEAD'::"DispatchState"
  AND dispatch."attemptCount" >= 5
  AND scan."status" NOT IN ('completed', 'failed');

UPDATE "Page" AS page
SET "outcome" = 'FAILED',
    "error" = 'Execution unavailable before analysis',
    "status" = NULL
FROM "ScanDispatch" AS dispatch
WHERE dispatch."scanId" = page."scanId"
  AND dispatch."state" = 'DEAD'::"DispatchState"
  AND dispatch."attemptCount" >= 5
  AND page."outcome" = 'PENDING';

DROP INDEX IF EXISTS "ScanDispatch_state_nextAttemptAt_idx";
CREATE INDEX "ScanDispatch_state_nextAttemptAt_leaseUntil_idx"
  ON "ScanDispatch"("state", "nextAttemptAt", "leaseUntil");
