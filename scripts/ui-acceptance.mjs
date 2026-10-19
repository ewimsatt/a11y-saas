// Run rendered UI regressions against an owned dev server. The unmount fixture
// imports the real React component; the production build is a separate gate.
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const require = createRequire(`${root}/apps/web/package.json`)
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const server = await createServer({
  root: `${root}/apps/web`,
  define: { 'import.meta.env.VITE_API_URL': JSON.stringify('http://localhost:3001') },
  server: { host: '127.0.0.1', port: 0, strictPort: true }
})
await server.listen()
const address = server.httpServer.address()
if (!address || typeof address === 'string') throw new Error('Preview did not open a TCP listener')
const output = process.env.A11Y_UI_OUTPUT || mkdtempSync(resolve(tmpdir(), 'a11y-ui-'))
console.log(`Rendered UI test artifacts: ${output}`)
let child
let timeout
let forceKill
let timedOut = false
const stopOwnedGroup = (signal) => {
  if (!child?.pid) return
  try {
    if (process.platform === 'win32') child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}
try {
  child = spawn(process.execPath, [`${root}/scripts/ui-regression.mjs`], {
    cwd: root, stdio: 'inherit', detached: process.platform !== 'win32',
    env: { ...process.env, A11Y_UI_BASE_URL: `http://127.0.0.1:${address.port}`, A11Y_UI_OUTPUT: output }
  })
  timeout = setTimeout(() => {
    timedOut = true
    stopOwnedGroup('SIGTERM')
    forceKill = setTimeout(() => stopOwnedGroup('SIGKILL'), 5000)
  }, 120000)
  const code = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('exit', (code) => resolvePromise(code))
  })
  process.exitCode = timedOut || code !== 0 ? 1 : 0
} finally {
  clearTimeout(timeout); clearTimeout(forceKill)
  stopOwnedGroup('SIGTERM')
  server.httpServer.closeAllConnections()
  await server.close()
}
