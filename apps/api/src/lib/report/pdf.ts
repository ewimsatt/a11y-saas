/** Renders standalone report HTML to a PDF buffer via headless Chromium. */
export async function renderPdf(html: string, scanId: string): Promise<Buffer> {
  const safeScanId = scanId.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
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
    await browser.close();
  }
}
