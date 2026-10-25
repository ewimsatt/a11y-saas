#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
: "${DOCKER_HOST:=}"
PROJECT="a11y-friend-acceptance-$$"
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/a11y-acceptance.XXXXXX")
EVIDENCE_DIR="$LOG_DIR/evidence"
BULLMQ_PREFIX="a11y-acceptance-${PROJECT}"
FIXTURE_ORIGIN="http://allowed.test"
PLAYWRIGHT_WS_TOKEN=$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")

compose() {
  docker compose -p "$PROJECT" -f scripts/acceptance-compose.yml "$@"
}

cleanup() {
  local code=$? cleanup_failed=0 leftovers='' containers='' networks='' volumes=''
  if ! BULLMQ_PREFIX="$BULLMQ_PREFIX" PLAYWRIGHT_WS_TOKEN="$PLAYWRIGHT_WS_TOKEN" ACCEPTANCE_EVIDENCE_DIR="$EVIDENCE_DIR" \
    compose logs --no-color >"$LOG_DIR/compose.log" 2>&1; then
    # Log collection is diagnostic only. The down command and exact-label check
    # below remain fail-closed for owned-resource cleanup.
    echo "failed to capture disposable Compose logs" >&2
  fi
  # Worker evidence is created as container root. Before the host deletes only
  # this run's temp directory, let the still-running disposable API grant it
  # deletion rights. Failure here is diagnostic; `down` and label checks fail closed.
  compose exec -T api sh -c 'chmod -R a+rwx /evidence' >/dev/null 2>&1 || true
  if ! BULLMQ_PREFIX="$BULLMQ_PREFIX" PLAYWRIGHT_WS_TOKEN="$PLAYWRIGHT_WS_TOKEN" ACCEPTANCE_EVIDENCE_DIR="$EVIDENCE_DIR" \
    compose down -v --remove-orphans >/dev/null 2>&1; then
    echo "failed to remove disposable Compose project $PROJECT" >&2
    cleanup_failed=1
  fi
  if ! containers=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT"); then
    echo "failed to query disposable containers for $PROJECT" >&2
    cleanup_failed=1
  fi
  if ! networks=$(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"); then
    echo "failed to query disposable networks for $PROJECT" >&2
    cleanup_failed=1
  fi
  if ! volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT"); then
    echo "failed to query disposable volumes for $PROJECT" >&2
    cleanup_failed=1
  fi
  leftovers="$containers $networks $volumes"
  if [ -n "${leftovers// /}" ]; then
    echo "disposable Compose resources remain for $PROJECT: $leftovers" >&2
    cleanup_failed=1
  fi
  if [ "$code" -eq 0 ] && [ "$cleanup_failed" -eq 0 ]; then
    rm -rf "$LOG_DIR"
    exit 0
  fi
  echo "acceptance logs retained at $LOG_DIR" >&2
  exit 1
}
trap cleanup EXIT

mkdir -p "$EVIDENCE_DIR"
# The disposable worker runs as the image's non-root node user. The harness
# owner keeps deletion rights over evidence directories it created in CI.
chmod 0777 "$EVIDENCE_DIR"
export BULLMQ_PREFIX FIXTURE_ORIGIN EVIDENCE_DIR PLAYWRIGHT_WS_TOKEN
export ACCEPTANCE_EVIDENCE_DIR="$EVIDENCE_DIR"
printf 'acceptance project=%s\n' "$PROJECT"
node --test scripts/acceptance-harness-preflight.mjs
compose up -d --build --wait

api() {
  compose exec -T api node /acceptance/acceptance-api.mjs "$@"
}
seed() {
  compose exec -T api pnpm tsx /acceptance/acceptance-seed.ts
}
add_failed_page() {
  compose exec -T api pnpm tsx /acceptance/acceptance-add-failed-page.ts "$@"
}
atomic_evidence() {
  compose exec -T api pnpm tsx /app/apps/api/test/acceptanceAtomicEvidence.ts "$@"
}
inject_evidence_fault() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U acceptance -d a11y <<SQL
CREATE FUNCTION acceptance_fail_evidence_insert() RETURNS trigger LANGUAGE plpgsql AS \$\$
DECLARE
  target_scan_id text := TG_ARGV[0];
BEGIN
  IF EXISTS (SELECT 1 FROM "Finding" WHERE id = NEW."findingId" AND "scanId" = target_scan_id) THEN
    RAISE EXCEPTION 'acceptance evidence insert fault';
  END IF;
  RETURN NEW;
END;
\$\$;
CREATE TRIGGER acceptance_fail_evidence_insert BEFORE INSERT ON "Evidence"
FOR EACH ROW EXECUTE FUNCTION acceptance_fail_evidence_insert('$1');
SQL
}
remove_evidence_fault() {
  compose exec -T postgres psql -v ON_ERROR_STOP=1 -U acceptance -d a11y <<'SQL'
DROP TRIGGER IF EXISTS acceptance_fail_evidence_insert ON "Evidence";
DROP FUNCTION IF EXISTS acceptance_fail_evidence_insert();
SQL
}

SEED=$(seed)
CLEAN_PROJECT=$(node -e 'console.log(JSON.parse(process.argv[1]).cleanProjectId)' "$SEED")
VIOLATION_PROJECT=$(node -e 'console.log(JSON.parse(process.argv[1]).violationProjectId)' "$SEED")
PARTIAL_PROJECT=$(node -e 'console.log(JSON.parse(process.argv[1]).partialProjectId)' "$SEED")
ATOMIC_EVIDENCE_PROJECT=$(node -e 'console.log(JSON.parse(process.argv[1]).atomicEvidenceProjectId)' "$SEED")
run_scan() { api POST "/scans/$1/run" '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).scanId))'; }
poll() {
  local id=$1 body status
  for _ in {1..90}; do
    body=$(api GET "/scans/$id")
    status=$(node -e 'console.log(JSON.parse(process.argv[1]).status)' "$body")
    if [ "$status" = completed ] || [ "$status" = failed ]; then printf '%s' "$body"; return; fi
    sleep 1
  done
  echo "scan $id did not reach a terminal status" >&2
  return 1
}

CLEAN_SCAN=$(run_scan "$CLEAN_PROJECT")
VIOLATION_SCAN=$(run_scan "$VIOLATION_PROJECT")
PARTIAL_SCAN=$(run_scan "$PARTIAL_PROJECT")
add_failed_page "$PARTIAL_SCAN" "$FIXTURE_ORIGIN/failure"
CLEAN=$(poll "$CLEAN_SCAN")
VIOLATION=$(poll "$VIOLATION_SCAN")
PARTIAL=$(poll "$PARTIAL_SCAN")
ISSUES=$(api GET "/scans/$VIOLATION_SCAN/issues")
REPORT=$(api GET "/scans/$PARTIAL_SCAN/report?format=html")
node - "$CLEAN" "$VIOLATION" "$PARTIAL" "$ISSUES" "$REPORT" <<'NODE'
const [cleanRaw, violationRaw, partialRaw, issuesRaw, report] = process.argv.slice(2);
const clean = JSON.parse(cleanRaw);
const violation = JSON.parse(violationRaw);
const partial = JSON.parse(partialRaw);
const issues = JSON.parse(issuesRaw);
const fail = (message) => { throw new Error(message); };
if (clean.status !== 'completed' || clean.coverage !== 'COMPLETE' || clean._count.findings !== 0) fail(`clean scan was not a completed zero-finding scan: ${JSON.stringify(clean)}`);
if (violation.status !== 'completed' || violation.coverage !== 'COMPLETE' || violation._count.findings < 2) fail(`violation scan did not retain both nodes: ${JSON.stringify(violation)}`);
const selectors = issues.issues.map((issue) => issue.selector).join(' ');
if (!selectors.includes('.first-bad') || !selectors.includes('.second-bad')) fail(`missing node-specific evidence: ${selectors}`);
if (partial.status !== 'completed' || partial.coverage !== 'PARTIAL') fail(`partial scan was not labeled partial: ${JSON.stringify(partial)}`);
if (!partial.pages.some((page) => page.outcome === 'FAILED' && page.status === 503)) fail(`HTTP failure was not retained: ${JSON.stringify(partial.pages)}`);
if (!report.includes('PARTIAL coverage') || !report.includes('No final assessment or comparison is issued')) fail('partial report issued an unqualified assessment');
console.log(JSON.stringify({ clean: { status: clean.status, coverage: clean.coverage, findings: clean._count.findings }, violation: { findings: violation._count.findings, selectors }, partial: { status: partial.status, coverage: partial.coverage, pages: partial.pages.map(({ outcome, status }) => ({ outcome, status })) } }, null, 2));
NODE

compose exec -T api node /acceptance/acceptance-evidence.mjs "$ISSUES"

# The atomic project first establishes a completed OPEN baseline. The next scan
# is created but not enqueued until its target-scoped disposable trigger exists.
ATOMIC_BASELINE_SCAN=$(run_scan "$ATOMIC_EVIDENCE_PROJECT")
ATOMIC_BASELINE=$(poll "$ATOMIC_BASELINE_SCAN")
node - "$ATOMIC_BASELINE" <<'NODE'
const scan = JSON.parse(process.argv[2]);
if (scan.status !== 'completed' || scan.coverage !== 'COMPLETE' || scan._count.findings !== 3) throw new Error(`atomic baseline was not a complete three-finding scan: ${JSON.stringify(scan)}`);
NODE
ATOMIC_BASELINE_SNAPSHOT=$(atomic_evidence snapshot "$ATOMIC_BASELINE_SCAN" | base64 | tr -d '\n')
ATOMIC_FAULTED_SCAN=$(atomic_evidence create-queued-scan "$ATOMIC_EVIDENCE_PROJECT")
inject_evidence_fault "$ATOMIC_FAULTED_SCAN"
atomic_evidence retry "$ATOMIC_FAULTED_SCAN"
ATOMIC_FAULTED=$(poll "$ATOMIC_FAULTED_SCAN")
node - "$ATOMIC_FAULTED" <<'NODE'
const scan = JSON.parse(process.argv[2]);
if (scan.status !== 'failed' || scan.coverage !== 'FAILED') throw new Error(`faulted second scan did not fail honestly: ${JSON.stringify(scan)}`);
NODE
atomic_evidence assert-faulted "$ATOMIC_FAULTED_SCAN" "$ATOMIC_BASELINE_SNAPSHOT"
remove_evidence_fault
atomic_evidence retry "$ATOMIC_FAULTED_SCAN"
ATOMIC_RETRIED=$(poll "$ATOMIC_FAULTED_SCAN")
node - "$ATOMIC_RETRIED" <<'NODE'
const scan = JSON.parse(process.argv[2]);
if (scan.status !== 'completed' || scan.coverage !== 'COMPLETE') throw new Error(`retried scan did not complete honestly: ${JSON.stringify(scan)}`);
NODE
LEGACY_SNAPSHOT=$(atomic_evidence delete-one-evidence "$ATOMIC_FAULTED_SCAN" | base64 | tr -d '\n')
atomic_evidence retry "$ATOMIC_FAULTED_SCAN"
ATOMIC_LEGACY_REPAIRED=$(poll "$ATOMIC_FAULTED_SCAN")
node - "$ATOMIC_LEGACY_REPAIRED" <<'NODE'
const scan = JSON.parse(process.argv[2]);
if (scan.status !== 'completed' || scan.coverage !== 'COMPLETE') throw new Error(`legacy orphan repair did not complete honestly: ${JSON.stringify(scan)}`);
NODE
atomic_evidence assert-legacy-repair "$ATOMIC_FAULTED_SCAN" "$LEGACY_SNAPSHOT"
REPAIRED_SNAPSHOT=$(atomic_evidence snapshot "$ATOMIC_FAULTED_SCAN" | base64 | tr -d '\n')
atomic_evidence retry "$ATOMIC_FAULTED_SCAN"
ATOMIC_IDEMPOTENT=$(poll "$ATOMIC_FAULTED_SCAN")
node - "$ATOMIC_IDEMPOTENT" <<'NODE'
const scan = JSON.parse(process.argv[2]);
if (scan.status !== 'completed' || scan.coverage !== 'COMPLETE') throw new Error(`second legacy repair requeue did not complete honestly: ${JSON.stringify(scan)}`);
NODE
atomic_evidence assert-stable "$ATOMIC_FAULTED_SCAN" "$REPAIRED_SNAPSHOT"

compose stop worker browser
MISSING_BROWSER_SCAN=$(run_scan "$PARTIAL_PROJECT")
compose run -d --no-deps worker
MISSING_BROWSER=$(poll "$MISSING_BROWSER_SCAN")
MISSING_REPORT=$(api GET "/scans/$MISSING_BROWSER_SCAN/report?format=html")
node - "$MISSING_BROWSER" "$MISSING_REPORT" <<'NODE'
const [scanRaw, html] = process.argv.slice(2);
const scan = JSON.parse(scanRaw);
if (scan.status !== 'failed' || scan.coverage !== 'FAILED') throw new Error(`missing-browser scan did not fail honestly: ${scanRaw}`);
if (!scan.pages.length || scan.pages.some((page) => page.outcome !== 'FAILED' || !page.error?.includes('Page analysis failed'))) throw new Error(`missing-browser pages lacked controlled failure truth: ${scanRaw}`);
if (!html.includes('FAILED') || !html.includes('No final assessment or comparison is issued') || html.includes('Remote scanner browser is unavailable')) throw new Error('missing-browser HTML report was misleading or leaked sidecar internals');
console.log(JSON.stringify({ missingBrowser: { status: scan.status, coverage: scan.coverage, pages: scan.pages.length } }));
NODE
