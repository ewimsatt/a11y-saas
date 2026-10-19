// Rendered UI integration regression using only intercepted synthetic API responses.
// Usage: A11Y_UI_BASE_URL=http://127.0.0.1:23110 node scripts/ui-regression.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { chromium } = createRequire(`${root}/package.json`)('playwright')
const base = process.env.A11Y_UI_BASE_URL || 'http://127.0.0.1:23110'
const out = process.env.A11Y_UI_OUTPUT || resolve(root, '.ui-regression-results')
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ headless: true })
const results = []
const issues = [
  { id: 'a1', severity: 'SERIOUS', status: 'OPEN', message: 'FIRST OWNED FIXTURE ISSUE', selector: '#first', rule: { id: 'label', title: 'Label', wcagRefs: ['wcag2a', 'wcag131'] } },
  { id: 'a2', severity: 'SERIOUS', status: 'OPEN', message: 'SECOND OWNED FIXTURE ISSUE', selector: '#second', rule: { id: 'label', title: 'Label', wcagRefs: ['wcag2a', 'wcag131'] } }
]
const deferred = () => {
  let release
  const promise = new Promise((resolvePromise) => { release = resolvePromise })
  return { promise, release }
}

async function scenario(name, test) {
  const context = await browser.newContext()
  const page = await context.newPage()
  const holds = new Map()
  const seen = new Map()
  const calls = []
  const hold = (key) => {
    const barrier = deferred()
    holds.set(key, barrier)
    return barrier
  }
  const waitForCall = async (key) => {
    if ((seen.get(key) || 0) > 0) return
    const barrier = deferred()
    seen.set(`${key}:seen`, barrier)
    await barrier.promise
  }
  const mark = (key) => {
    seen.set(key, (seen.get(key) || 0) + 1)
    seen.get(`${key}:seen`)?.release()
  }
  const release = (key) => holds.get(key)?.release()
  await page.route('http://localhost:3001/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const key = `${request.method()} ${path}`
    calls.push({ key, body: request.postData() })
    mark(key)
    await holds.get(key)?.promise
    let data = {}
    if (path === '/projects') data = [{ id: 'pa', name: 'Project A', baseUrl: 'https://a.example' }, { id: 'pb', name: 'Project B', baseUrl: 'https://b.example' }]
    else if (path === '/projects/pa/scans') data = { scans: [{ id: 'sa', status: 'completed' }] }
    else if (path === '/projects/pb/scans') data = { scans: [{ id: 'sb', status: 'completed' }] }
    else if (path === '/scans/sa/issues') data = { scanId: 'sa', issues }
    else if (path === '/scans/sb/issues') data = { scanId: 'sb', issues }
    else if (path === '/scans/pa/run') data = { scanId: 'new-pa' }
    else if (path === '/scans/new-pa') data = { id: 'new-pa', status: 'completed', _count: { findings: 0 } }
    else if (/^\/issues\/a[12]\/evidence$/.test(path)) {
      const id = path.split('/')[2]
      data = { issueId: id, domSnippet: `<div>evidence-${id}</div>`, meta: { url: `https://fixture.example/${id}`, failureSummary: `fix-${id}` } }
    } else if (path === '/issues/a1/waive') data = { ok: true }
    await route.fulfill({ json: data, headers: { 'access-control-allow-origin': '*' } }).catch(() => {})
    mark(`FULFILLED ${key}`)
  })
  try {
    await page.goto(base)
    await page.getByLabel('Scan', { exact: true }).selectOption('sa')
    await page.getByRole('button', { name: 'Load Issues', exact: true }).click()
    await page.getByText('FIRST OWNED FIXTURE ISSUE', { exact: true }).waitFor()
    await test(page, { calls, hold, release, waitForCall })
    results.push({ name, status: 'PASS' })
  } catch (error) {
    results.push({ name, status: 'FAIL', error: String(error) })
    await page.screenshot({ path: `${out}/${name}.png`, fullPage: true })
  } finally {
    for (const barrier of holds.values()) barrier.release()
    await context.close()
  }
}

async function unmountDuringDelayedCreateScenario() {
  const context = await browser.newContext()
  const page = await context.newPage()
  const calls = []
  const createGate = deferred()
  const createSeen = deferred()
  try {
    await page.route('http://localhost:3001/**', async (route) => {
      const request = route.request()
      const path = new URL(request.url()).pathname
      const key = `${request.method()} ${path}`
      calls.push(key)
      if (key === 'POST /projects') { createSeen.release(); await createGate.promise }
      const data = path === '/projects'
        ? [{ id: 'pa', name: 'Project A', baseUrl: 'https://a.example' }]
        : path === '/projects/pa/scans' ? { scans: [] } : { id: 'created' }
      await route.fulfill({ json: data, headers: { 'access-control-allow-origin': '*' } })
    })
    await page.goto(base)
    await page.waitForFunction(() => document.querySelector('select[aria-label="Project"] option[value="pa"]'))
    await page.evaluate(async () => {
      const { default: React } = await import('/node_modules/.vite/deps/react.js')
      const { default: ReactDOMClient } = await import('/node_modules/.vite/deps/react-dom_client.js')
      const { default: App } = await import('/src/App.tsx')
      const { createRoot } = ReactDOMClient
      const container = document.createElement('div')
      container.id = 'unmount-probe-root'
      document.body.append(container)
      const root = createRoot(container)
      root.render(React.createElement(App))
      window.__a11yUnmountProbeRoot = root
    })
    const probe = page.locator('#unmount-probe-root')
    await probe.getByLabel('Project', { exact: true }).selectOption('pa')
    await probe.getByLabel('New project name', { exact: true }).fill('Unmounted project')
    await probe.getByLabel('New project base URL', { exact: true }).fill('https://unmounted.example')
    const getCallsBeforeCreate = calls.filter((key) => key === 'GET /projects').length
    await probe.getByRole('button', { name: 'Create Project', exact: true }).click()
    await createSeen.promise
    assert.equal(calls.filter((key) => key === 'POST /projects').length, 1, 'The rendered probe must submit exactly one delayed create request')
    await page.evaluate(() => window.__a11yUnmountProbeRoot.unmount())
    createGate.release()
    await page.waitForTimeout(150)
    assert.equal(calls.filter((key) => key === 'GET /projects').length, getCallsBeforeCreate, 'Unmounted create continuation must not start a fresh projects reload')
    results.push({ name: 'unmount-during-delayed-create', status: 'PASS' })
  } catch (error) {
    results.push({ name: 'unmount-during-delayed-create', status: 'FAIL', error: String(error) })
    await page.screenshot({ path: `${out}/unmount-during-delayed-create.png`, fullPage: true })
  } finally {
    createGate.release()
    await context.close()
  }
}

try {
  await scenario('project-switch-clears-context', async (page) => {
    await page.getByRole('button', { name: 'View evidence for serious issue: FIRST OWNED FIXTURE ISSUE', exact: true }).click()
    await page.getByText('fix-a1', { exact: true }).waitFor()
    await page.getByLabel('Project', { exact: true }).selectOption('pb')
    await page.waitForFunction(() => document.querySelector('select[aria-label="Scan"] option[value="sb"]'))
    assert.equal(await page.getByText('FIRST OWNED FIXTURE ISSUE', { exact: true }).count(), 0, 'Old project findings must clear on project switch')
    assert.equal(await page.getByText('fix-a1', { exact: true }).count(), 0, 'Old evidence must clear on project switch')
    assert.equal(await page.getByRole('button', { name: 'Export Report', exact: true }).isDisabled(), true, 'Export must not target stale hidden scan')
  })
  await scenario('wcag-dotted-filter', async (page) => {
    await page.getByRole('button', { name: 'Preset: WCAG 1.3.1', exact: true }).click()
    assert.equal(await page.getByText('FIRST OWNED FIXTURE ISSUE', { exact: true }).count(), 1, 'WCAG 1.3.1 preset must match actual axe wcag131 tags')
  })
  await scenario('evidence-response-race', async (page, state) => {
    state.hold('GET /issues/a1/evidence')
    await page.getByRole('button', { name: 'View evidence for serious issue: FIRST OWNED FIXTURE ISSUE', exact: true }).click()
    await state.waitForCall('GET /issues/a1/evidence')
    await page.getByRole('button', { name: 'View evidence for serious issue: SECOND OWNED FIXTURE ISSUE', exact: true }).click()
    await page.getByText('fix-a2', { exact: true }).waitFor()
    state.release('GET /issues/a1/evidence')
    await state.waitForCall('FULFILLED GET /issues/a1/evidence')
    assert.equal(await page.getByText('fix-a2', { exact: true }).count(), 1, 'Older evidence response must not replace newly selected evidence')
    assert.equal(await page.getByText('fix-a1', { exact: true }).count(), 0)
  })
  await scenario('evidence-body-parse-race', async (page) => {
    // This is an explicit test-only body-parse gate: fetch has already resolved
    // headers, but Response.json() for a1 cannot resolve until we release it.
    await page.evaluate(() => {
      const originalJson = Response.prototype.json
      let release
      let entered = false
      Response.prototype.json = async function () {
        if (!entered && this.url.endsWith('/issues/a1/evidence')) {
          entered = true
          window.__a11yBodyGate = { entered: true, release: () => release?.() }
          await new Promise((resolvePromise) => { release = resolvePromise })
        }
        return originalJson.call(this)
      }
    })
    await page.getByRole('button', { name: 'View evidence for serious issue: FIRST OWNED FIXTURE ISSUE', exact: true }).click()
    await page.waitForFunction(() => window.__a11yBodyGate?.entered === true)
    await page.getByRole('button', { name: 'View evidence for serious issue: SECOND OWNED FIXTURE ISSUE', exact: true }).click()
    await page.getByText('fix-a2', { exact: true }).waitFor()
    await page.evaluate(() => window.__a11yBodyGate.release())
    await page.waitForTimeout(100)
    assert.equal(await page.getByText('fix-a2', { exact: true }).count(), 1, 'A response whose body finishes after selection changes must not overwrite current evidence')
    assert.equal(await page.getByText('fix-a1', { exact: true }).count(), 0)
  })
  await scenario('delayed-project-and-issues-never-flash-stale-context', async (page, state) => {
    state.hold('GET /projects/pb/scans')
    await page.getByLabel('Project', { exact: true }).selectOption('pb')
    await state.waitForCall('GET /projects/pb/scans')
    assert.equal(await page.getByText('FIRST OWNED FIXTURE ISSUE', { exact: true }).count(), 0, 'Changing projects clears visible findings before a delayed scans response')
    assert.equal(await page.getByRole('button', { name: 'Load Issues', exact: true }).isDisabled(), true)
    state.release('GET /projects/pb/scans')
    await page.getByLabel('Scan', { exact: true }).selectOption('sb')
    state.hold('GET /scans/sb/issues')
    await page.getByRole('button', { name: 'Load Issues', exact: true }).click()
    await state.waitForCall('GET /scans/sb/issues')
    await page.getByLabel('Project', { exact: true }).selectOption('pa')
    state.release('GET /scans/sb/issues')
    await page.waitForFunction(() => document.querySelector('select[aria-label="Scan"] option[value="sa"]'))
    assert.equal(await page.getByText('FIRST OWNED FIXTURE ISSUE', { exact: true }).count(), 0, 'Late issues cannot populate after its scan is no longer selected')
  })
  await scenario('late-run-submission-cannot-select-another-project', async (page, state) => {
    state.hold('POST /scans/pa/run')
    await page.getByRole('button', { name: 'Run Scan', exact: true }).click()
    await state.waitForCall('POST /scans/pa/run')
    assert.equal(state.calls.filter((call) => call.key === 'POST /scans/pa/run').length, 1, 'Run request targets current project exactly once')
    await page.getByLabel('Project', { exact: true }).selectOption('pb')
    state.release('POST /scans/pa/run')
    await page.waitForFunction(() => document.querySelector('select[aria-label="Scan"] option[value="sb"]'))
    assert.equal(await page.getByLabel('Scan', { exact: true }).inputValue(), '', 'Late run completion cannot select a scan in a different project')
  })
  await scenario('delayed-run-recovers-control-after-project-switch', async (page, state) => {
    state.hold('POST /scans/pa/run')
    const run = page.getByRole('button', { name: /^(Run Scan|Queueing Scan…)$/ })
    await run.click()
    await state.waitForCall('POST /scans/pa/run')
    assert.equal(await run.isDisabled(), true, 'Run Scan is disabled while its request is pending')
    await page.getByLabel('Project', { exact: true }).selectOption('pb')
    state.release('POST /scans/pa/run')
    await page.waitForFunction(() => document.querySelector('select[aria-label="Scan"] option[value="sb"]'))
    assert.equal(await run.isDisabled(), false, 'Run Scan recovers after its old project context is invalidated')
  })
  await scenario('delayed-waiver-recovers-control-after-context-switch', async (page, state) => {
    await page.getByRole('button', { name: 'View evidence for serious issue: FIRST OWNED FIXTURE ISSUE', exact: true }).click()
    await page.getByText('fix-a1', { exact: true }).waitFor()
    state.hold('POST /issues/a1/waive')
    const waive = page.getByRole('button', { name: 'Waive Issue', exact: true })
    await page.getByLabel('Waive reason', { exact: true }).fill('enough reason')
    await waive.click()
    await state.waitForCall('POST /issues/a1/waive')
    assert.equal(await waive.isDisabled(), true, 'Waive Issue is disabled while its request is pending')
    await page.getByLabel('Project', { exact: true }).selectOption('pb')
    state.release('POST /issues/a1/waive')
    await page.waitForFunction(() => document.querySelector('select[aria-label="Scan"] option[value="sb"]'))
    await page.getByLabel('Scan', { exact: true }).selectOption('sb')
    await page.getByRole('button', { name: 'Load Issues', exact: true }).click()
    await page.getByText('FIRST OWNED FIXTURE ISSUE', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'View evidence for serious issue: FIRST OWNED FIXTURE ISSUE', exact: true }).click()
    await page.getByText('fix-a1', { exact: true }).waitFor()
    await page.getByLabel('Waive reason', { exact: true }).fill('another enough reason')
    assert.equal(await page.getByRole('button', { name: 'Waive Issue', exact: true }).isDisabled(), false, 'Waive Issue recovers for the current scan after old context invalidation')
  })
  await scenario('stale-completed-poll-cannot-supersede-current-project-scan-load', async (page, state) => {
    state.hold('GET /scans/new-pa')
    await page.getByRole('button', { name: 'Run Scan', exact: true }).click()
    await state.waitForCall('GET /scans/new-pa')
    state.hold('GET /scans/new-pa/issues')
    state.release('GET /scans/new-pa')
    await state.waitForCall('GET /scans/new-pa/issues')
    state.hold('GET /projects/pb/scans')
    await page.getByLabel('Project', { exact: true }).selectOption('pb')
    await state.waitForCall('GET /projects/pb/scans')
    state.release('GET /scans/new-pa/issues')
    await page.waitForTimeout(100)
    assert.equal(state.calls.filter((call) => call.key === 'GET /projects/pa/scans').length, 1, 'A completed poll whose issues continuation is stale must not start another old-project scan load')
    state.release('GET /projects/pb/scans')
    await page.waitForFunction(() => document.querySelector('select[aria-label="Scan"] option[value="sb"]'))
    assert.equal(await page.getByLabel('Scan', { exact: true }).isDisabled(), false, 'Current project scan load completes after stale poll continuation')
  })
  await scenario('waiver-validation-pending-success-and-late-response', async (page, state) => {
    await page.getByRole('button', { name: 'View evidence for serious issue: FIRST OWNED FIXTURE ISSUE', exact: true }).click()
    await page.getByText('fix-a1', { exact: true }).waitFor()
    const waive = page.getByRole('button', { name: 'Waive Issue', exact: true })
    await page.getByLabel('Waive reason', { exact: true }).fill('too short')
    assert.equal(await waive.isDisabled(), true, 'Unsafe short waiver is disabled')
    await page.getByText('Enter at least 10 characters to waive this issue.', { exact: true }).waitFor()
    assert.equal(state.calls.filter((call) => call.key === 'POST /issues/a1/waive').length, 0)
    state.hold('POST /issues/a1/waive')
    await page.getByLabel('Waive reason', { exact: true }).fill('enough reason')
    await waive.click()
    await state.waitForCall('POST /issues/a1/waive')
    assert.equal(await waive.isDisabled(), true, 'Duplicate waiver submit is disabled while pending')
    assert.equal(state.calls.filter((call) => call.key === 'POST /issues/a1/waive').length, 1)
    state.release('POST /issues/a1/waive')
    await page.getByText('Waived issue a1', { exact: true }).waitFor()
    assert.equal(await page.getByText('fix-a1', { exact: true }).count(), 0, 'Successful waiver clears selected evidence')
    state.hold('POST /issues/a1/waive')
    await page.getByRole('button', { name: 'View evidence for serious issue: FIRST OWNED FIXTURE ISSUE', exact: true }).click()
    await page.getByLabel('Waive reason', { exact: true }).fill('another enough reason')
    await waive.click()
    await state.waitForCall('POST /issues/a1/waive')
    await page.getByLabel('Project', { exact: true }).selectOption('pb')
    state.release('POST /issues/a1/waive')
    await page.waitForFunction(() => document.querySelector('select[aria-label="Scan"] option[value="sb"]'))
    assert.equal(await page.getByText('fix-a1', { exact: true }).count(), 0, 'Late waiver completion cannot repopulate evidence for another scan')
  })
  await unmountDuringDelayedCreateScenario()
} finally {
  await browser.close()
}
writeFileSync(`${out}/results.json`, JSON.stringify({ scope: 'rendered UI with synthetic intercepted API, not full-stack evidence', root, base, results }, null, 2))
console.log(JSON.stringify(results, null, 2))
if (results.some((result) => result.status === 'FAIL')) process.exitCode = 1
