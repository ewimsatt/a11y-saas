import { timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { chromium } from 'playwright';

const token = process.env.PDF_RENDERER_TOKEN;
const maxHtmlBytes = Number(process.env.PDF_RENDER_MAX_HTML_BYTES ?? 8 * 1024 * 1024);
const maxPdfBytes = Number(process.env.PDF_RENDER_MAX_PDF_BYTES ?? 25 * 1024 * 1024);
const renderTimeoutMs = Number(process.env.PDF_RENDER_TIMEOUT_MS ?? 15_000);

function requireBoundedInteger(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} through ${max}`);
  return value;
}
if (process.getuid?.() === 0) throw new Error('PDF renderer must not run as root');
if (!token || token.length < 43) throw new Error('PDF_RENDERER_TOKEN must be a high-entropy token');
requireBoundedInteger(maxHtmlBytes, 'PDF_RENDER_MAX_HTML_BYTES', 1, 16 * 1024 * 1024);
requireBoundedInteger(maxPdfBytes, 'PDF_RENDER_MAX_PDF_BYTES', 1024, 25 * 1024 * 1024);
requireBoundedInteger(renderTimeoutMs, 'PDF_RENDER_TIMEOUT_MS', 1000, 20_000);

const expectedAuthorization = Buffer.from(`Bearer ${token}`);
let rendering = false;

function send(response, status, message) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({ error: message }));
}

function hasValidAuthorization(value) {
  if (typeof value !== 'string') return false;
  const received = Buffer.from(value);
  return received.length === expectedAuthorization.length && timingSafeEqual(received, expectedAuthorization);
}

async function readBody(request) {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxHtmlBytes)) throw new Error('request body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxHtmlBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function escapeFooter(scanTitle) {
  return scanTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function render(html, scanTitle, control) {
  let browser;
  let context;
  control.close = async () => { await browser?.close(); };
  try {
    browser = await chromium.launch({ headless: true, chromiumSandbox: true });
    context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    let blockedRequests = 0;
    await context.route('**/*', async (route) => {
      blockedRequests += 1;
      await route.abort();
    });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: renderTimeoutMs });
    if (blockedRequests) throw new Error('PDF renderer blocked external request');
    const pdf = await page.pdf({
      format: 'A4', printBackground: true, tagged: true, outline: true, displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;font:8px Arial;color:#46545c;padding:0 12mm;display:flex;justify-content:space-between"><span>Propellic accessibility report · Scan ${escapeFooter(scanTitle)}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
      margin: { top: '14mm', bottom: '18mm', left: '12mm', right: '12mm' }
    });
    if (pdf.length > maxPdfBytes || !pdf.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('renderer produced invalid PDF bytes');
    return pdf;
  } finally {
    await context?.close();
    await browser?.close();
  }
}

const server = http.createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/healthz') return response.end('ok\n');
  if (request.method !== 'POST' || request.url !== '/render') return send(response, 404, 'not found');
  if (rendering) return send(response, 503, 'renderer busy');
  if (!hasValidAuthorization(request.headers.authorization)) return send(response, 401, 'unauthorized');
  if (request.headers['content-encoding']) return send(response, 415, 'content encoding is not accepted');
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) return send(response, 415, 'application/json is required');

  rendering = true;
  let timeout;
  const renderControl = { close: async () => {} };
  try {
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    if (!body || typeof body.html !== 'string' || typeof body.scanTitle !== 'string' || Buffer.byteLength(body.scanTitle, 'utf8') > 256) {
      return send(response, 400, 'invalid render request');
    }
    const pdf = await Promise.race([
      render(body.html, body.scanTitle, renderControl),
      new Promise((_, reject) => { timeout = setTimeout(() => { void renderControl.close(); reject(new Error('renderer timed out')); }, renderTimeoutMs); })
    ]);
    response.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdf.length, 'cache-control': 'no-store' });
    response.end(pdf);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'renderer failed';
    const status = message === 'PDF renderer blocked external request' ? 422 : message.includes('too large') ? 413 : message === 'renderer timed out' ? 504 : 400;
    send(response, status, status === 422 ? message : 'render request failed');
  } finally {
    clearTimeout(timeout);
    rendering = false;
  }
});
server.headersTimeout = 5_000;
server.requestTimeout = 20_000;
server.keepAliveTimeout = 2_000;
server.maxConnections = 16;
server.listen(3002, '0.0.0.0', () => console.log('PDF renderer ready on private port 3002'));
