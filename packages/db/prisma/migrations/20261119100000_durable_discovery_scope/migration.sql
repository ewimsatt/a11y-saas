CREATE TYPE "DiscoveryState" AS ENUM ('PENDING', 'FROZEN');

ALTER TABLE "Scan"
  ADD COLUMN "discoveryState" "DiscoveryState" NOT NULL DEFAULT 'PENDING',
  ADD COLUMN "discoveryTruncated" BOOLEAN NOT NULL DEFAULT false;

-- Pre-discovery explicit scans already have their entire requested scope; discovery-enabled
-- legacy scans intentionally replay once through the new fence rather than pretending frozen.
UPDATE "Scan"
SET "discoveryState" = CASE WHEN "discoveryEnabled" THEN 'PENDING'::"DiscoveryState" ELSE 'FROZEN'::"DiscoveryState" END;

-- SQL cannot implement the runtime's exact WHATWG URL serialization safely (notably
-- Unicode host punycode and IPv6/default-port handling). Legacy rows remain NULL until the worker canonicalizes them with the runtime WHATWG policy. They are deliberately not
-- deduplicated automatically: an ambiguous legacy collision must fail truthfully rather
-- than silently merge pages or reassign findings.
ALTER TABLE "Page" ADD COLUMN "urlIdentity" VARCHAR(1000);
CREATE UNIQUE INDEX "Page_scanId_urlIdentity_key"
  ON "Page"("scanId", "urlIdentity")
  WHERE "urlIdentity" IS NOT NULL;
