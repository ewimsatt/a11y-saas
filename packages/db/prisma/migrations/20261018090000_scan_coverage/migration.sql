-- Preserve per-page scan outcomes so reports can distinguish a clean page from one that was never analyzed.
CREATE TYPE "ScanCoverage" AS ENUM ('PENDING', 'COMPLETE', 'PARTIAL', 'FAILED');
CREATE TYPE "PageOutcome" AS ENUM ('PENDING', 'ANALYZED', 'FAILED');

ALTER TABLE "Scan"
  ADD COLUMN "coverage" "ScanCoverage" NOT NULL DEFAULT 'PENDING';

ALTER TABLE "Page"
  ADD COLUMN "outcome" "PageOutcome" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "error" TEXT;
