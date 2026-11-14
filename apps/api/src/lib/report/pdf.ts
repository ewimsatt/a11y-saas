const PDF_RENDER_TIMEOUT_MS = 20_000;
const MAX_REMOTE_PDF_BYTES = 25_000_000;
const PDF_MAGIC = Buffer.from('%PDF-');

async function readRemotePdf(response: Response): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > MAX_REMOTE_PDF_BYTES) {
      throw new Error('PDF renderer service returned an oversized PDF');
    }
  }
  if (!response.body) throw new Error('PDF renderer service returned an unreadable PDF stream');

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_REMOTE_PDF_BYTES) {
        await reader.cancel('PDF renderer response exceeded byte limit');
        throw new Error('PDF renderer service returned an oversized PDF');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  const pdf = Buffer.concat(chunks, bytesRead);
  if (pdf.length <= PDF_MAGIC.length || !pdf.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC)) {
    throw new Error('PDF renderer service returned invalid PDF bytes');
  }
  return pdf;
}

async function renderRemotePdf(html: string, scanId: string, rendererUrl: string, token: string): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(rendererUrl, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html, scanTitle: scanId }),
      signal: AbortSignal.timeout(PDF_RENDER_TIMEOUT_MS)
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      throw new Error('PDF renderer service timed out');
    }
    throw new Error(`PDF renderer service request failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    if (response.status === 422) throw new Error('PDF renderer blocked external request');
    throw new Error(`PDF renderer service failed with HTTP ${response.status}`);
  }
  if (!response.headers.get('content-type')?.toLowerCase().startsWith('application/pdf')) {
    throw new Error('PDF renderer service returned an invalid content type');
  }
  return readRemotePdf(response);
}

/** Renders standalone report HTML to a PDF buffer via headless Chromium for local development. */
export async function renderPdfLocally(html: string, scanId: string): Promise<Buffer> {
  const safeScanId = scanId.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const { chromium } = await import('playwright');
  const executablePath = process.env.PDF_CHROMIUM_EXECUTABLE_PATH?.trim();
  const browser = await chromium.launch({
    headless: true,
    chromiumSandbox: true,
    ...(executablePath ? { executablePath } : {})
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    const blockedRequests: string[] = [];
    try {
      await context.route('**/*', async (route) => {
        const request = route.request();
        blockedRequests.push(`${request.resourceType()}:${request.url()}`);
        await route.abort();
      });
      const page = await context.newPage();
      await page.setContent(html, { waitUntil: 'load' });
      if (blockedRequests.length) throw new Error(`PDF renderer blocked external request(s): ${blockedRequests.join(', ')}`);
      return await page.pdf({
        format: 'A4',
        printBackground: true,
        tagged: true,
        outline: true,
        displayHeaderFooter: true,
        headerTemplate: '<span></span>',
        footerTemplate: `<div style="width:100%;font:8px Arial;color:#46545c;padding:0 12mm;display:flex;justify-content:space-between"><span>Propellic accessibility report · Scan ${safeScanId}</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`,
        margin: { top: '14mm', bottom: '18mm', left: '12mm', right: '12mm' }
      });
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function renderPdf(html: string, scanId: string): Promise<Buffer> {
  const rendererUrl = process.env.PDF_RENDERER_URL?.trim();
  if (!rendererUrl) return renderPdfLocally(html, scanId);
  const token = process.env.PDF_RENDERER_TOKEN?.trim();
  if (!token) throw new Error('PDF_RENDERER_TOKEN is required when PDF_RENDERER_URL is configured');
  return renderRemotePdf(html, scanId, rendererUrl, token);
}
