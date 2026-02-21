// Playwright + axe-core integration for accessibility scanning.

export type RawViolation = {
  ruleId: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  message: string;
  selector?: string;
  wcagRefs?: string[];
};

export type ScanResult = {
  violations: RawViolation[];
  html: string;
  screenshotBuffer: Buffer;
  title: string;
};

export async function scanPage(url: string): Promise<ScanResult> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  const axeResults = await (await import('@axe-core/playwright')).AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  const screenshotBuffer = await page.screenshot({ fullPage: true });
  const html = await page.content();
  await page.close();
  await browser.close();
  const violations: RawViolation[] = axeResults.violations.map((v) => ({
    ruleId: v.id,
    impact: v.impact as 'critical' | 'serious' | 'moderate' | 'minor',
    message: v.description,
    selector: v.nodes[0]?.target?.join(' >> ') || undefined,
    wcagRefs: v.tags?.filter((t) => t.startsWith('wcag')) || [],
  }));
  return { violations, html, screenshotBuffer, title };
}

export async function crawlPage(url: string): Promise<{title: string; screenshotBuffer: Buffer}> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const title = await page.title();
  const screenshotBuffer = await page.screenshot({ fullPage: true });
  await page.close();
  await browser.close();
  return { title, screenshotBuffer };
}

export async function analyzePage(url: string): Promise<RawViolation[]> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
  const axeResults = await (await import('@axe-core/playwright')).AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .analyze();
  await page.close();
  await browser.close();
  const violations: RawViolation[] = axeResults.violations.map((v) => ({
    ruleId: v.id,
    impact: v.impact as 'critical' | 'serious' | 'moderate' | 'minor',
    message: v.description,
    selector: v.nodes[0]?.target?.join(' >> ') || undefined,
    wcagRefs: v.tags?.filter((t) => t.startsWith('wcag')) || [],
  }));
  return violations;
}
