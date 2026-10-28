-- Durable initial dispatch intent. Existing scans remain valid: request keys are nullable
-- and no existing row requires a dispatch record retroactively.
CREATE TYPE "DispatchState" AS ENUM ('PENDING', 'DISPATCHING', 'ENQUEUED', 'DEAD');

ALTER TABLE "Scan"
  ADD COLUMN "requestKey" VARCHAR(255),
  ADD COLUMN "requestDigest" CHAR(64),
  ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "ScanDispatch" (
  "scanId" TEXT NOT NULL,
  "jobId" VARCHAR(255) NOT NULL,
  "state" "DispatchState" NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastAttemptAt" TIMESTAMP(3),
  "enqueuedAt" TIMESTAMP(3),
  "lastErrorCode" VARCHAR(100),
  "leaseUntil" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ScanDispatch_pkey" PRIMARY KEY ("scanId")
);

CREATE UNIQUE INDEX "Scan_requestKey_key" ON "Scan"("requestKey");
CREATE UNIQUE INDEX "ScanDispatch_jobId_key" ON "ScanDispatch"("jobId");
CREATE INDEX "ScanDispatch_state_nextAttemptAt_idx" ON "ScanDispatch"("state", "nextAttemptAt");

ALTER TABLE "ScanDispatch"
  ADD CONSTRAINT "ScanDispatch_scanId_fkey"
  FOREIGN KEY ("scanId") REFERENCES "Scan"("id") ON DELETE CASCADE ON UPDATE CASCADE;
