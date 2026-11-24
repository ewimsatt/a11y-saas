import type { Browser } from 'playwright';

/**
 * Production discovery primitive shared by BrowserSession and the isolated
 * egress harness. It accepts the already-connected remote browser only.
 */
export async function discoverLinksFromRemoteBrowser(
  browser: Browser,
  url: string,
  navigationOptions: Parameters<import('playwright').Page['goto']>[1]
): Promise<{ status: number; hrefs: string[] }> {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    const response = await page.goto(url, navigationOptions);
    if (!response) throw new Error('Navigation returned no HTTP response');
    if (!response.ok()) throw new Error(`HTTP ${response.status()} while loading page`);
    return {
      status: response.status(),
      hrefs: await page.locator('a[href]').evaluateAll((anchors) => anchors.map((anchor) => anchor.href))
    };
  } finally {
    await context.close();
  }
}
