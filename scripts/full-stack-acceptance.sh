#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"
: "${DOCKER_HOST:=}"

port() { node -e "const n=require('net').createServer(); n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})"; }
ACCEPTANCE_POSTGRES_PORT=$(port)
ACCEPTANCE_REDIS_PORT=$(port)
API_PORT=$(port)
FIXTURE_PORT=$(port)
PROJECT="a11y-friend-acceptance-$$"
LOG_DIR=$(mktemp -d "${TMPDIR:-/tmp}/a11y-acceptance.XXXXXX")
EVIDENCE_DIR="$LOG_DIR/evidence"
DATABASE_URL="postgresql://acceptance:acceptance-only-not-a-secret@127.0.0.1:${ACCEPTANCE_POSTGRES_PORT}/a11y"
REDIS_URL="redis://127.0.0.1:${ACCEPTANCE_REDIS_PORT}"
BULLMQ_PREFIX="a11y-acceptance-${PROJECT}"
FIXTURE_ORIGIN="http://127.0.0.1:${FIXTURE_PORT}"

# Each child gets a fresh process group whose leader is the recorded PID. This
# lets the harness stop only the processes it started, including browser children.
start_owned() {
  local pid_var=$1 logfile=$2
  shift 2
  perl -e 'setpgrp(0, 0) or die "setpgrp: $!"; exec @ARGV' "$@" >"$logfile" 2>&1 &
  printf -v "$pid_var" '%s' "$!"
}

stop_owned() {
  local pid=${1:-}
  [ -n "$pid" ] || return 0
  if kill -0 "$pid" 2>/dev/null; then kill -- -"$pid" 2>/dev/null || true; fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local code=$?
  stop_owned "${WORKER_PID:-}"
  stop_owned "${API_PID:-}"
  stop_owned "${FIXTURE_PID:-}"
  ACCEPTANCE_POSTGRES_PORT="$ACCEPTANCE_POSTGRES_PORT" ACCEPTANCE_REDIS_PORT="$ACCEPTANCE_REDIS_PORT" \
    docker compose -p "$PROJECT" -f scripts/acceptance-compose.yml down -v --remove-orphans >/dev/null 2>&1 || true
  if [ "$code" -eq 0 ]; then rm -rf "$LOG_DIR"; else echo "acceptance logs retained at $LOG_DIR" >&2; fi
  exit "$code"
}
trap cleanup EXIT

export ACCEPTANCE_POSTGRES_PORT ACCEPTANCE_REDIS_PORT DATABASE_URL REDIS_URL BULLMQ_PREFIX FIXTURE_ORIGIN EVIDENCE_DIR
printf 'acceptance project=%s postgres=%s redis=%s api=%s fixture=%s\n' "$PROJECT" "$ACCEPTANCE_POSTGRES_PORT" "$ACCEPTANCE_REDIS_PORT" "$API_PORT" "$FIXTURE_PORT"
docker compose -p "$PROJECT" -f scripts/acceptance-compose.yml up -d --wait
pnpm exec prisma migrate deploy --schema packages/db/prisma/schema.prisma
start_owned FIXTURE_PID "$LOG_DIR/fixture.log" env FIXTURE_PORT="$FIXTURE_PORT" node scripts/owned-fixture-server.mjs
# The harness exports its disposable configuration and must not load a developer .env.
start_owned API_PID "$LOG_DIR/api.log" bash -c 'cd "$1"; shift; exec "$@"' _ "$ROOT/apps/api" env HOST=127.0.0.1 PORT="$API_PORT" node --import tsx src/index.ts
for _ in {1..60}; do curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null && break; sleep 1; done
curl -fsS "http://127.0.0.1:${API_PORT}/healthz" >/dev/null
SEED=$(DATABASE_URL="$DATABASE_URL" FIXTURE_ORIGIN="$FIXTURE_ORIGIN" pnpm tsx scripts/acceptance-seed.ts)
CLEAN_PROJECT=$(node -e 'console.log(JSON.parse(process.argv[1]).cleanProjectId)' "$SEED")
VIOLATION_PROJECT=$(node -e 'console.log(JSON.parse(process.argv[1]).violationProjectId)' "$SEED")
PARTIAL_PROJECT=$(node -e 'console.log(JSON.parse(process.argv[1]).partialProjectId)' "$SEED")
run_scan() { curl -fsS -X POST "http://127.0.0.1:${API_PORT}/scans/$1/run" -H 'content-type: application/json' -d '{}' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).scanId))'; }
CLEAN_SCAN=$(run_scan "$CLEAN_PROJECT")
VIOLATION_SCAN=$(run_scan "$VIOLATION_PROJECT")
PARTIAL_SCAN=$(run_scan "$PARTIAL_PROJECT")
DATABASE_URL="$DATABASE_URL" pnpm tsx scripts/acceptance-add-failed-page.ts "$PARTIAL_SCAN" "$FIXTURE_ORIGIN/failure"
start_owned WORKER_PID "$LOG_DIR/worker.log" bash -c 'cd "$1"; shift; exec "$@"' _ "$ROOT/apps/worker" node --import tsx src/index.ts

poll() {
  local id=$1 body status
  for _ in {1..90}; do
    body=$(curl -fsS "http://127.0.0.1:${API_PORT}/scans/$id")
    status=$(node -e 'console.log(JSON.parse(process.argv[1]).status)' "$body")
    if [ "$status" = completed ] || [ "$status" = failed ]; then printf '%s' "$body"; return; fi
    sleep 1
  done
  echo "scan $id did not reach a terminal status" >&2
  return 1
}
CLEAN=$(poll "$CLEAN_SCAN")
VIOLATION=$(poll "$VIOLATION_SCAN")
PARTIAL=$(poll "$PARTIAL_SCAN")
ISSUES=$(curl -fsS "http://127.0.0.1:${API_PORT}/scans/$VIOLATION_SCAN/issues")
REPORT=$(curl -fsS "http://127.0.0.1:${API_PORT}/scans/$PARTIAL_SCAN/report?format=html")
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

node - "$ISSUES" "$API_PORT" <<'NODE'
const [issuesRaw, apiPort] = process.argv.slice(2);
const issues = JSON.parse(issuesRaw).issues;
const required = ['.first-bad', '.second-bad'];
(async () => {
  for (const selector of required) {
    const issue = issues.find((item) => item.selector === selector);
    if (!issue) throw new Error(`missing expected issue ${selector}`);
    if (!issue.evidence?.domSnippet || !issue.evidence?.meta?.failureSummary) throw new Error(`missing inline DOM/failure evidence for ${selector}`);
    const evidence = await (await fetch(`http://127.0.0.1:${apiPort}/issues/${issue.id}/evidence`)).json();
    if (evidence.domSnippet !== issue.evidence.domSnippet || evidence.meta?.failureSummary !== issue.evidence.meta?.failureSummary) throw new Error(`evidence endpoint mismatch for ${selector}`);
    const screenshot = await fetch(`http://127.0.0.1:${apiPort}${evidence.screenshot}`);
    const bytes = new Uint8Array(await screenshot.arrayBuffer());
    if (!screenshot.ok || screenshot.headers.get('content-type') !== 'image/png' || bytes.length === 0) throw new Error(`missing PNG evidence for ${selector}`);
  }
})().catch((error) => { console.error(error); process.exit(1); });
NODE

# Stop the owned normal-worker group before enqueuing the browser-launch case.
stop_owned "$WORKER_PID"
unset WORKER_PID
MISSING_BROWSER_SCAN=$(run_scan "$PARTIAL_PROJECT")
start_owned WORKER_PID "$LOG_DIR/missing-browser-worker.log" bash -c 'cd "$1"; shift; exec "$@"' _ "$ROOT/apps/worker" env PLAYWRIGHT_BROWSERS_PATH="$LOG_DIR/no-browser" PLAYWRIGHT_EXECUTABLE_PATH="$LOG_DIR/no-browser/chromium" node --import tsx src/index.ts
MISSING_BROWSER=$(poll "$MISSING_BROWSER_SCAN")
MISSING_REPORT=$(curl -fsS "http://127.0.0.1:${API_PORT}/scans/$MISSING_BROWSER_SCAN/report?format=html")
node - "$MISSING_BROWSER" "$MISSING_REPORT" <<'NODE'
const [scanRaw, html] = process.argv.slice(2);
const scan = JSON.parse(scanRaw);
if (scan.status !== 'failed' || scan.coverage !== 'FAILED') throw new Error(`missing-browser scan did not fail honestly: ${scanRaw}`);
if (!scan.pages.length || scan.pages.some((page) => page.outcome !== 'FAILED' || !page.error?.includes('Browser could not start'))) throw new Error(`missing-browser pages lacked controlled failure truth: ${scanRaw}`);
if (!html.includes('FAILED') || !html.includes('No final assessment or comparison is issued') || html.includes('Executable doesn\'t exist')) throw new Error('missing-browser HTML report was misleading or leaked launch internals');
console.log(JSON.stringify({ missingBrowser: { status: scan.status, coverage: scan.coverage, pages: scan.pages.length } }));
NODE
