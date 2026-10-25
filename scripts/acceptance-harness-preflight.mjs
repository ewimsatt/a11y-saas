import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const scriptPath = process.env.ACCEPTANCE_HARNESS_SCRIPT || resolve(root, 'scripts/full-stack-acceptance.sh')
const script = readFileSync(scriptPath, 'utf8')
const compose = readFileSync(resolve(root, 'scripts/acceptance-compose.yml'), 'utf8')
const worker = readFileSync(resolve(root, 'apps/worker/src/index.ts'), 'utf8')
const scanRoutes = readFileSync(resolve(root, 'apps/api/src/routes/scans.ts'), 'utf8')

test('acceptance harness uses disposable database credentials and queue namespace', () => {
  const password = compose.match(/^\s*POSTGRES_PASSWORD:\s*(\S+)\s*$/m)?.[1]
  assert.ok(password, 'acceptance compose must declare a disposable postgres password')
  assert.match(compose, new RegExp(`DATABASE_URL:\\s*postgresql://acceptance:${password}@postgres:5432/a11y`))
  assert.match(script, /BULLMQ_PREFIX="a11y-acceptance-\$\{PROJECT\}"/)
  assert.match(compose, /BULLMQ_PREFIX:\s*\$\{BULLMQ_PREFIX\}/)
})

test('acceptance harness does not use broad process cleanup', () => {
  assert.doesNotMatch(script, /pkill|killall/)
  assert.match(script, /compose down -v --remove-orphans/)
})

test('acceptance harness removes and verifies only its exact disposable Compose resources', () => {
  assert.doesNotMatch(script, /compose down[^\n]*\|\| true/)
  assert.match(script, /if ! .*compose down -v --remove-orphans/s)
  assert.match(script, /if ! containers=\$\(docker ps -aq --filter "label=com\.docker\.compose\.project=\$PROJECT"\); then/)
  assert.match(script, /if ! networks=\$\(docker network ls -q --filter "label=com\.docker\.compose\.project=\$PROJECT"\); then/)
  assert.match(script, /if ! volumes=\$\(docker volume ls -q --filter "label=com\.docker\.compose\.project=\$PROJECT"\); then/)
  assert.match(script, /if \[ "\$code" -eq 0 \] && \[ "\$cleanup_failed" -eq 0 \]/)
})

test('acceptance harness gives the worker only the isolated remote browser route', () => {
  assert.match(compose, /^\s{2}worker:\n/m)
  assert.match(compose, /PLAYWRIGHT_WS_ENDPOINT:\s*ws:\/\/browser:3000\/\$\{PLAYWRIGHT_WS_TOKEN\}/)
  assert.match(compose, /^\s{2}browser:\n/m)
  assert.match(compose, /^\s{2}smokescreen:\n/m)
  assert.match(compose, /^\s{2}fixture:\n/m)
  assert.match(compose, /browser_control:\s*\{\s*internal:\s*true\s*\}/)
  assert.match(compose, /scanner_egress:/)
  assert.doesNotMatch(compose, /extra_hosts|network_mode:\s*host|NO_PROXY/)
  assert.doesNotMatch(script, /FIXTURE_ORIGIN="http:\/\/127\.0\.0\.1/)
})

test('acceptance harness drives its loopback-only API from the disposable API container', () => {
  assert.match(compose, /^\s{2}api:\n/m)
  assert.match(compose, /HOST:\s*127\.0\.0\.1/)
  assert.doesNotMatch(compose, /^\s{4}ports:/m)
  assert.match(script, /compose exec -T api/)
})

test('atomic evidence fault is scoped to its selected scan and production has no fault or repair switch', () => {
  assert.match(script, /CREATE FUNCTION acceptance_fail_evidence_insert\(\) RETURNS trigger/)
  assert.match(script, /target_scan_id text := TG_ARGV\[0\]/)
  assert.match(script, /WHERE id = NEW\."findingId" AND "scanId" = target_scan_id/)
  assert.match(script, /EXECUTE FUNCTION acceptance_fail_evidence_insert\('\$1'\)/)
  assert.match(script, /ATOMIC_BASELINE_SNAPSHOT=\$\(atomic_evidence snapshot "\$ATOMIC_BASELINE_SCAN" \| base64/)
  assert.match(script, /atomic_evidence assert-faulted "\$ATOMIC_FAULTED_SCAN" "\$ATOMIC_BASELINE_SNAPSHOT"/)
  assert.doesNotMatch(worker, /process\.env\.(?:EVIDENCE_FAULT|FAULT_INJECT|REPAIR_ORPHAN)/)
  assert.doesNotMatch(scanRoutes, /\/repair|repair.*evidence/i)
})
