import { chromium } from 'playwright';

const proxy = process.env.SCANNER_PROXY_URL;
const token = process.env.PLAYWRIGHT_WS_TOKEN;
if (!proxy || !/^http:\/\/[A-Za-z0-9.-]+(?::\d+)?$/.test(proxy)) throw new Error('SCANNER_PROXY_URL must be an http proxy URL');
if (!token || token.length < 16) throw new Error('PLAYWRIGHT_WS_TOKEN must be an unguessable token (minimum 16 characters)');
if (process.getuid?.() === 0) throw new Error('browser server must not run as root');

const server = await chromium.launchServer({
  host: '0.0.0.0',
  port: 3000,
  wsPath: token,
  chromiumSandbox: true,
  proxy: { server: proxy, bypass: '<-loopback>' },
  args: [
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ],
});
console.log(`Playwright browser server ready on protected wsPath; pid=${server.process().pid}`);
const stop = async () => { await server.close(); process.exit(0); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
