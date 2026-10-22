import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { chromium } from 'playwright';

const token = process.env.PLAYWRIGHT_WS_TOKEN;
assert(token, 'PLAYWRIGHT_WS_TOKEN required');

function effectiveChromiumArgs() {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = fs.readFileSync(`/proc/${entry}/cmdline`).toString().split('\0').filter(Boolean);
      if (args[0]?.includes('chrome-headless-shell') && !args.some((arg) => arg.startsWith('--type='))) {
        return args.slice(1);
      }
    } catch {}
  }
  return [];
}

function directConnectionDenied(host = '45.0.0.10', port = 80) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: 1500 });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => resolve(true));
    socket.once('timeout', () => { socket.destroy(); resolve(true); });
  });
}

async function navigate(browser, url, options = {}) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  const seen = [];
  page.on('response', (response) => {
    if (response.url().includes('trap')) seen.push({ url: response.url(), status: response.status() });
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes('trap')) seen.push({ url: request.url(), failed: true, error: request.failure()?.errorText ?? 'request failed' });
  });
  let response;
  let error = null;
  try {
    response = await page.goto(url, { waitUntil: options.waitUntil ?? 'domcontentloaded', timeout: options.timeout ?? 8000 });
    if (options.pause) await page.waitForTimeout(options.pause);
    return {
      url,
      finalUrl: page.url(),
      status: response?.status() ?? null,
      marker: await page.locator(options.marker ?? '#allowed').count(),
      seen,
      error,
    };
  } catch (caught) {
    error = caught?.name ?? 'Error';
    return { url, finalUrl: page.url(), status: response?.status() ?? null, marker: 0, seen, error };
  } finally {
    await context.close();
  }
}

async function wrongTokenDenied() {
  try {
    const wrong = await chromium.connect('ws://127.0.0.1:3000/definitely-wrong-boundary-token', { timeout: 2000 });
    await wrong.close();
    return false;
  } catch {
    return true;
  }
}

const command = process.argv[2] ?? '--core';
if (command === '--wrong-token') {
  console.log(JSON.stringify({ wrongTokenDenied: await wrongTokenDenied() }));
  process.exit(0);
}

const browser = await chromium.connect(`ws://127.0.0.1:3000/${token}`);
try {
  if (command === '--navigate') {
    const url = process.argv[3];
    assert(url, '--navigate requires a URL');
    console.log(JSON.stringify(await navigate(browser, url)));
  } else if (command === '--outage') {
    const result = await navigate(browser, 'http://allowed.test/outage');
    console.log(JSON.stringify({ proxyOutageDenied: result.status === null || result.status >= 400, result }));
  } else {
    const args = effectiveChromiumArgs();
    const allowed = await navigate(browser, 'http://allowed.test/allowed');
    const screenshotContext = await browser.newContext({ serviceWorkers: 'block' });
    const screenshotPage = await screenshotContext.newPage();
    await screenshotPage.goto('http://allowed.test/screenshot', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await screenshotPage.screenshot({ path: '/tmp/allowed.png' });
    await screenshotContext.close();

    const deniedTargets = {};
    for (const [name, url] of Object.entries({
      loopback: 'http://127.0.0.1/trap-loopback',
      private: 'http://10.66.0.10/trap-private',
      metadata: 'http://169.254.169.254/trap-metadata',
      ipv6: 'http://[fd00:dead:beef::10]/trap-ipv6',
      ipv4Mapped: 'http://[::ffff:10.66.0.10]/trap-mapped',
      privateDns: 'http://private.test/trap-private-dns',
      metadataDns: 'http://metadata.test/trap-metadata-dns',
      ipv6Dns: 'http://ipv6.test/trap-ipv6-dns',
    })) deniedTargets[name] = await navigate(browser, url);

    const redirects = {};
    for (const path of ['redirect-private', 'redirect-metadata', 'redirect-ipv6', 'redirect-private-dns']) {
      redirects[path] = await navigate(browser, `http://allowed.test/${path}`);
    }

    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    const subresourceDecisions = [];
    page.on('response', (response) => {
      if (response.url().includes('trap')) subresourceDecisions.push({ url: response.url(), status: response.status() });
    });
    page.on('requestfailed', (request) => {
      if (request.url().includes('trap')) subresourceDecisions.push({ url: request.url(), failed: true, error: request.failure()?.errorText ?? 'request failed' });
    });
    page.on('websocket', (socket) => {
      if (socket.url().includes('trap')) subresourceDecisions.push({ url: socket.url(), failed: true, error: 'websocket attempted' });
    });
    const subresourceResponse = await page.goto('http://allowed.test/subresources', { waitUntil: 'domcontentloaded', timeout: 8000 });
    await page.waitForTimeout(1000);
    const subresources = { status: subresourceResponse?.status() ?? null, marker: await page.locator('#subresources').count(), decisions: subresourceDecisions };
    await context.close();

    const swContext = await browser.newContext({ serviceWorkers: 'block' });
    const swPage = await swContext.newPage();
    const swResponse = await swPage.goto('http://allowed.test/service-worker', { waitUntil: 'domcontentloaded', timeout: 8000 });
    const swResult = await swPage.evaluate(() => window.swResult);
    const registrations = await swPage.evaluate(async () => navigator.serviceWorker ? (await navigator.serviceWorker.getRegistrations()).length : 0);
    await swContext.close();

    const mixed = await navigate(browser, 'http://mixed.test/mixed');
    const deniedPort = await navigate(browser, 'http://allowed.test:8080/trap-denied-port');
    const deniedConnectPort = await navigate(browser, 'https://allowed.test:8443/trap-denied-connect-port');
    console.log(JSON.stringify({
      allowed,
      screenshot: true,
      directDenied: await directConnectionDenied(),
      deniedTargets,
      redirects,
      subresources,
      serviceWorker: { status: swResponse?.status() ?? null, result: swResult, registrations, blocked: String(swResult).startsWith('blocked:') && registrations === 0 },
      mixed,
      deniedPort,
      deniedConnectPort,
      wrongTokenDenied: await wrongTokenDenied(),
      launch: {
        proxyServer: args.find((arg) => arg.startsWith('--proxy-server=')) ?? null,
        proxyBypass: args.find((arg) => arg.startsWith('--proxy-bypass-list=')) ?? null,
        disableQuic: args.includes('--disable-quic'),
        webrtcNonProxiedUdpDisabled: args.includes('--force-webrtc-ip-handling-policy=disable_non_proxied_udp'),
        sandboxExplicitlyEnabled: !args.includes('--no-sandbox') && !args.includes('--disable-setuid-sandbox'),
      },
    }));
  }
} finally {
  await browser.close();
}
