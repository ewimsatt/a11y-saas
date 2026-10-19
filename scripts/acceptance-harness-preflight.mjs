import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'

const root = resolve(import.meta.dirname, '..')
const scriptPath = process.env.ACCEPTANCE_HARNESS_SCRIPT || resolve(root, 'scripts/full-stack-acceptance.sh')
const script = readFileSync(scriptPath, 'utf8')
const compose = readFileSync(resolve(root, 'scripts/acceptance-compose.yml'), 'utf8')

test('acceptance harness pairs its disposable database credential and queue namespace', () => {
  const password = compose.match(/^\s*POSTGRES_PASSWORD:\s*(\S+)\s*$/m)?.[1]
  assert.ok(password, 'acceptance compose must declare a disposable postgres password')
  const configuredPassword = script.match(/^DATABASE_URL="postgresql:\/\/acceptance:([^@]+)@127\.0\.0\.1:/m)?.[1]
  assert.equal(configuredPassword, password, 'acceptance harness must use the compose-owned disposable postgres password')
  assert.match(script, /BULLMQ_PREFIX="a11y-acceptance-\$\{PROJECT\}"/)
  assert.match(script, /export .*BULLMQ_PREFIX/)
})

test('acceptance harness starts and stops only owned process groups', () => {
  assert.match(script, /start_owned\(\)/)
  assert.match(script, /stop_owned\(\)/)
  assert.match(script, /kill -- -"\$pid"/)
  assert.doesNotMatch(script, /pkill|killall/)
})
