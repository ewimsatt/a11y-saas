#!/usr/bin/env node
/**
 * Disposable real-Chromium scanner-egress acceptance test.
 * Owns only its unique Compose project and never publishes a host port.
 */
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const composeFile = join(root, 'docker-compose.scanner-boundary-test.yml');
const dockerHost = process.env.DOCKER_HOST || 'unix:///Users/ewimsatt/.colima/default/docker.sock';
const project = `scanner-egress-test-${process.pid}-${Date.now()}`;
const tempDir = await mkdtemp(join(tmpdir(), 'scanner-egress-'));
const envFile = join(tempDir, '.env');
const env = { ...process.env, DOCKER_HOST: dockerHost, COMPOSE_PROJECT_NAME: project };
const syntheticToken = 'boundary-test-token-not-for-runtime';

function run(args, options = {}) {
  const result = spawnSync('docker', args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: options.timeout ?? 180_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}
const compose = (...args) => run(['compose', '--project-name', project, '--env-file', envFile, '-f', composeFile, ...args]);
function must(result, description) {
  assert.equal(result.status, 0, `${description}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  return result;
}
function parseLastJson(result, description) {
  must(result, description);
  const line = result.stdout.trim().split('\n').filter(Boolean).at(-1);
  try { return JSON.parse(line); }
  catch { assert.fail(`${description} did not end in JSON: ${result.stdout}`); }
}
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitForReady() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ps = compose('ps', '--format', 'json');
    const services = ps.status === 0 ? ps.stdout.trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    const running = ['browser', 'smokescreen', 'fixture', 'dns'].every((name) => services.some((service) => service.Service === name && service.State === 'running'));
    const logs = compose('logs', '--no-color', 'browser', 'smokescreen', 'fixture', 'dns');
    if (running && logs.stdout.includes('Playwright browser server ready') && logs.stdout.includes('scanner egress port guard listening') && logs.stdout.includes('deterministic DNS fixture ready') && logs.stdout.includes('fixture listening on dual-stack port 80')) return;
    await sleep(250);
  }
  assert.fail(`services did not become ready\n${compose('ps').stdout}\n${compose('logs', '--no-color').stdout}`);
}

function execJson(service, ...command) {
  return parseLastJson(compose('exec', '-T', service, ...command), `${service} JSON probe`);
}
function fixtureCounters() {
  return execJson('fixture', 'node', '-e', "fetch('http://127.0.0.1/__counters').then(r=>r.text()).then(console.log)");
}
function resetCounters() {
  return execJson('fixture', 'node', '-e', "fetch('http://127.0.0.1/__reset',{method:'POST'}).then(r=>r.text()).then(console.log)");
}
function setRebind(mode) {
  return execJson('dns', 'node', '-e', `fetch('http://127.0.0.1:8053/rebind/${mode}',{method:'POST'}).then(r=>r.text()).then(console.log)`);
}
function dnsState() {
  return execJson('dns', 'node', '-e', "fetch('http://127.0.0.1:8053/state').then(r=>r.text()).then(console.log)");
}
function browserProbe(...args) {
  return parseLastJson(compose('exec', '-T', 'browser', 'node', '/app/fixtures/browser-probe.mjs', ...args), `browser probe ${args.join(' ') || '--core'}`);
}
function isDenied(result) {
  return result.status === null || result.status >= 400 || result.error !== null;
}
function projectResources() {
  return {
    containers: run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim(),
    networks: run(['network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim(),
    volumes: run(['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]).stdout.trim(),
  };
}

let started = false;
let failure;
let summary;
let proxyLogs = '';
const protectedBefore = run(['ps', '-a', '--filter', 'name=seo-audit-hub', '--format', '{{.ID}} {{.Names}} {{.Status}}']).stdout.trim();
try {
  await access(composeFile, constants.R_OK);
  for (const path of [
    'infra/scanner-egress/Dockerfile',
    'infra/scanner-egress/port-guard.go',
    'infra/scanner-egress/smokescreen.yaml',
    'infra/playwright/Dockerfile',
    'infra/playwright/server.mjs',
    'infra/playwright/seccomp_profile.json',
    'test/network-fixtures/dns-server.mjs',
    'test/network-fixtures/http-fixture.mjs',
    'test/network-fixtures/browser-probe.mjs',
  ]) await access(join(root, path), constants.R_OK);

  await writeFile(envFile, `PLAYWRIGHT_WS_TOKEN=${syntheticToken}\n`);
  const model = must(compose('config'), 'rendered Compose model');
  assert.match(model.stdout, /internal: true/, 'isolated networks must render internal');
  assert.doesNotMatch(model.stdout, /network_mode:\s*host/, 'host networking is forbidden');
  assert.doesNotMatch(model.stdout, /^\s+ports:/m, 'browser/proxy services must not publish ports');
  assert.doesNotMatch(model.stdout, /extra_hosts:/, 'fixture host injection is forbidden');

  must(compose('up', '--build', '-d'), 'build and start isolated test project');
  started = true;
  await waitForReady();

  const serviceIds = {};
  for (const service of ['browser', 'smokescreen', 'fixture', 'dns']) {
    serviceIds[service] = must(compose('ps', '-q', service), `locate ${service}`).stdout.trim();
    assert(serviceIds[service], `${service} container ID required`);
  }
  const browserInspect = JSON.parse(must(run(['inspect', serviceIds.browser]), 'inspect browser').stdout)[0];
  const smokescreenInspect = JSON.parse(must(run(['inspect', serviceIds.smokescreen]), 'inspect Smokescreen').stdout)[0];
  assert.deepEqual(Object.keys(browserInspect.NetworkSettings.Networks).sort(), [`${project}_browser_internal`], 'browser may join only browser_internal');
  assert(Object.values(browserInspect.NetworkSettings.Ports ?? {}).every((bindings) => bindings === null), 'browser socket must not be host-published');
  assert(Object.values(smokescreenInspect.NetworkSettings.Ports ?? {}).every((bindings) => bindings === null), 'proxy port must not be host-published');
  assert.notEqual(browserInspect.Config.User, '', 'browser must declare a non-root user');
  assert.notEqual(browserInspect.Config.User, '0', 'browser must not run as root');
  assert.equal(smokescreenInspect.Config.User, 'nonroot:nonroot', 'Smokescreen must run as its nonroot image user');
  const upstreamAttempt = compose('exec', '-T', 'browser', 'node', '-e', "const net=require('net');const socket=net.connect({host:'smokescreen',port:4751,timeout:1500});socket.once('connect',()=>{console.error('unguarded upstream reachable');process.exit(1)});socket.once('error',()=>process.exit(0));socket.once('timeout',()=>{socket.destroy();process.exit(0)})");
  assert.equal(upstreamAttempt.status, 0, `browser-control peers must not reach Smokescreen's upstream listener on 4751:\n${upstreamAttempt.stdout}\n${upstreamAttempt.stderr}`);
  assert(browserInspect.HostConfig.CapAdd?.includes('CAP_SYS_CHROOT'), 'browser gets only the sandbox chroot capability back');
  assert.deepEqual(browserInspect.HostConfig.CapDrop, ['ALL'], 'browser drops all ambient capabilities');
  for (const suffix of ['browser_internal', 'trap_private', 'trap_metadata', 'trap_ipv6']) {
    const network = JSON.parse(must(run(['network', 'inspect', `${project}_${suffix}`]), `inspect ${suffix}`).stdout)[0];
    assert.equal(network.Internal, true, `${suffix} must be internal`);
  }

  resetCounters();
  const core = browserProbe('--core');
  assert.equal(core.allowed.status, 200, `allowed status: ${JSON.stringify(core.allowed)}`);
  assert.equal(core.allowed.marker, 1, 'allowed fixture marker must render');
  assert.equal(core.screenshot, true, 'real Chromium screenshot must succeed');
  assert.equal(core.directDenied, true, 'browser raw TCP route to fixture must fail');
  for (const [name, result] of Object.entries(core.deniedTargets)) assert(isDenied(result), `${name} top-level target must receive denial/error: ${JSON.stringify(result)}`);
  for (const [name, result] of Object.entries(core.redirects)) assert(isDenied(result), `${name} redirect must receive denial/error: ${JSON.stringify(result)}`);
  assert.equal(core.subresources.status, 200, 'owned subresource document itself must load');
  assert.equal(core.subresources.marker, 1, 'owned subresource document marker must render');
  const expectedForbiddenSubresources = new Set([
    'http://10.66.0.10/trap-image',
    'http://169.254.169.254/trap-script',
    'http://[fd00:dead:beef::10]/trap-style',
    'http://private.test/trap-frame',
    'http://10.66.0.10/trap-fetch',
    'http://169.254.169.254/trap-events',
  ]);
  const observedForbiddenSubresources = new Map(core.subresources.decisions.map((item) => [item.url, item]));
  assert.deepEqual(new Set(observedForbiddenSubresources.keys()), expectedForbiddenSubresources, `each owned forbidden subresource mechanism/path must be observed exactly once: ${JSON.stringify(core.subresources)}`);
  assert([...observedForbiddenSubresources.values()].every((item) => item.failed || item.status >= 400), 'every observed forbidden subresource must be denied');
  assert.equal(core.serviceWorker.blocked, true, `service worker registration must be blocked: ${JSON.stringify(core.serviceWorker)}`);
  assert.equal(core.mixed.status, 200, `mixed DNS must select only allowed answer: ${JSON.stringify(core.mixed)}`);
  assert.equal(core.mixed.marker, 1, 'mixed DNS public answer must reach fixture');
  assert.equal(core.deniedPort.status, 403, `HTTP port guard must return 403: ${JSON.stringify(core.deniedPort)}`);
  assert(isDenied(core.deniedConnectPort), `CONNECT port guard must deny 8443: ${JSON.stringify(core.deniedConnectPort)}`);
  assert.equal(core.wrongTokenDenied, true, 'wrong browser-control token must fail closed');
  assert.equal(core.launch.proxyServer, '--proxy-server=http://smokescreen:4750', 'effective Chromium proxy must be Smokescreen');
  assert.equal(core.launch.proxyBypass, '--proxy-bypass-list=<-loopback>', 'effective Chromium args must disable implicit loopback bypass');
  assert.equal(core.launch.disableQuic, true, 'QUIC must be disabled');
  assert.equal(core.launch.webrtcNonProxiedUdpDisabled, true, 'non-proxied WebRTC UDP must be disabled');
  assert.equal(core.launch.sandboxExplicitlyEnabled, true, 'effective Chromium argv must not disable sandboxing');

  const countersAfterCore = fixtureCounters();
  assert(countersAfterCore.byTarget.public > 0, 'allowed traffic must hit the public fixture');
  for (const target of ['private', 'metadata', 'ipv6', 'denied-port']) assert.equal(countersAfterCore.byTarget[target], 0, `${target} fixture counter must stay zero`);
  assert.equal(Object.keys(countersAfterCore.requests).some((key) => key.endsWith(':/sw.js')), false, 'blocked service worker script must never reach fixture');

  resetCounters();
  setRebind('public');
  const rebindPublic = browserProbe('--navigate', 'http://rebind.test/rebind-public');
  assert.equal(rebindPublic.status, 200, `first rebind answer must reach public fixture: ${JSON.stringify(rebindPublic)}`);
  assert.equal(rebindPublic.marker, 1, 'first rebind response marker must render');
  setRebind('private');
  const rebindPrivate = browserProbe('--navigate', 'http://rebind.test/rebind-private');
  assert(isDenied(rebindPrivate), `changed private DNS answer must be denied: ${JSON.stringify(rebindPrivate)}`);
  const countersAfterRebind = fixtureCounters();
  assert.equal(countersAfterRebind.byTarget.public, 1, 'only first rebind connection may reach public fixture');
  assert.equal(countersAfterRebind.byTarget.private, 0, 'changed private DNS answer must never hit trap');
  const dnsEvidence = dnsState();
  assert(Object.keys(dnsEvidence.queries).some((key) => key.startsWith('mixed.test/')), 'mixed DNS lookup must be exercised');
  assert(Object.keys(dnsEvidence.queries).some((key) => key.startsWith('rebind.test/')), 'changed DNS lookup must be exercised');

  const missingProxy = compose('run', '--rm', '--no-deps', '-e', 'SCANNER_PROXY_URL=', 'browser');
  assert.notEqual(missingProxy.status, 0, 'missing proxy configuration must prevent browser startup');
  assert.match(`${missingProxy.stdout}\n${missingProxy.stderr}`, /SCANNER_PROXY_URL must be an http proxy URL/, 'missing proxy failure must be explicit');

  const countersBeforeOutage = fixtureCounters();
  must(compose('stop', 'smokescreen'), 'stop only owned proxy');
  const outage = browserProbe('--outage');
  assert.equal(outage.proxyOutageDenied, true, `proxy outage must fail closed: ${JSON.stringify(outage)}`);
  assert.deepEqual(fixtureCounters(), countersBeforeOutage, 'proxy outage must not create direct fixture traffic');

  proxyLogs = compose('logs', '--no-color', 'smokescreen').stdout;
  const proxyDecisions = proxyLogs.split('\n').map((line) => line.slice(line.indexOf('{'))).filter((line) => line.startsWith('{')).flatMap((line) => {
    try { const parsed = JSON.parse(line); return parsed.msg === 'CANONICAL-PROXY-DECISION' ? [parsed] : []; }
    catch { return []; }
  });
  assert.match(proxyLogs, /destination_decision allow=false host="allowed\.test" port=8080/, 'port guard logs must prove HTTP 8080 denial');
  assert.match(proxyLogs, /destination_decision allow=false host="allowed\.test" port=8443/, 'port guard logs must prove CONNECT 8443 denial');
  assert(proxyDecisions.some((entry) => entry.requested_host === 'allowed.test' && entry.allow === true && entry.outbound_remote_addr === '45.0.0.10:80'), 'Smokescreen logs must prove allowed decision and pinned public fixture peer');
  for (const host of ['10.66.0.10', '169.254.169.254', 'private.test', 'metadata.test', 'rebind.test']) {
    assert(proxyDecisions.some((entry) => entry.requested_host === host && entry.allow === false), `Smokescreen logs must prove denial for ${host}`);
  }
  assert(proxyDecisions.some((entry) => entry.requested_host === '10.66.0.10:80' && entry.allow === false && entry.proxy_type === 'connect'), 'the owned WebSocket CONNECT attempt must be denied at the proxy boundary');

  const productionFiles = await Promise.all([
    readFile(join(root, 'infra/playwright/server.mjs'), 'utf8'),
    readFile(join(root, 'infra/scanner-egress/smokescreen.yaml'), 'utf8'),
    readFile(join(root, 'infra/scanner-egress/port-guard.go'), 'utf8'),
    readFile(composeFile, 'utf8'),
  ]);
  const productionText = productionFiles.join('\n');
  assert.doesNotMatch(productionText, /unsafe_allow_private_ranges:\s*true/, 'private-range policy may not be weakened');
  assert.doesNotMatch(productionText, /\bNO_PROXY\b|\bno_proxy\b/, 'proxy bypass environment is forbidden');
  assert.doesNotMatch(productionText, /network_mode:\s*host|extra_hosts:/, 'host/trust bypass is forbidden');
  assert.doesNotMatch(productionFiles[0], /--no-sandbox|chromiumSandbox:\s*false/, 'browser server may not disable sandboxing');
  assert.match(productionFiles[0], /chromiumSandbox:\s*true/, 'browser sandbox must be explicitly enabled');
  assert.match(productionFiles[2], /smokescreenAddr\s*=\s*"127\.0\.0\.1:4751"/, 'port guard may forward only to loopback Smokescreen');

  summary = {
    project,
    passed: true,
    statuses: {
      allowed: core.allowed.status,
      deniedTargets: Object.fromEntries(Object.entries(core.deniedTargets).map(([name, result]) => [name, result.status ?? result.error])),
      redirects: Object.fromEntries(Object.entries(core.redirects).map(([name, result]) => [name, result.status ?? result.error])),
      deniedPort: core.deniedPort.status,
      deniedConnectPort: core.deniedConnectPort.status ?? core.deniedConnectPort.error,
      rebindPublic: rebindPublic.status,
      rebindPrivate: rebindPrivate.status ?? rebindPrivate.error,
      outage: outage.result.status ?? outage.result.error,
    },
    launch: core.launch,
    fixtureCounters: { core: countersAfterCore, rebind: countersAfterRebind, outageUnchanged: true },
    dns: dnsEvidence,
    proxyDecisions: proxyDecisions.map(({ requested_host, status_code, allow, outbound_remote_addr, decision_reason }) => ({ requested_host, status_code, allow, outbound_remote_addr, decision_reason })),
    topology: {
      browserNetworks: Object.keys(browserInspect.NetworkSettings.Networks),
      browserUser: browserInspect.Config.User,
      browserCapDrop: browserInspect.HostConfig.CapDrop,
      browserCapAdd: browserInspect.HostConfig.CapAdd,
      publishedBrowserPorts: Object.entries(browserInspect.NetworkSettings.Ports ?? {}).filter(([, bindings]) => bindings !== null).map(([port]) => port),
      publishedProxyPorts: Object.entries(smokescreenInspect.NetworkSettings.Ports ?? {}).filter(([, bindings]) => bindings !== null).map(([port]) => port),
    },
    startupFailures: { missingProxy: missingProxy.status, wrongTokenDenied: core.wrongTokenDenied },
  };
} catch (error) {
  failure = error;
  if (started) proxyLogs = compose('logs', '--no-color').stdout;
} finally {
  compose('down', '--volumes', '--remove-orphans');
  await rm(tempDir, { recursive: true, force: true });
}

const leftovers = projectResources();
assert.deepEqual(leftovers, { containers: '', networks: '', volumes: '' }, `owned cleanup incomplete: ${JSON.stringify(leftovers)}`);
const protectedAfter = run(['ps', '-a', '--filter', 'name=seo-audit-hub', '--format', '{{.ID}} {{.Names}} {{.Status}}']).stdout.trim();
assert.equal(protectedAfter, protectedBefore, 'unrelated seo-audit-hub resources changed during test');
if (failure) {
  console.error(proxyLogs);
  throw failure;
}
summary.cleanup = { containers: 0, networks: 0, volumes: 0, protectedServicesUnchanged: true };
console.log(JSON.stringify(summary));
