// Playwright + axe-core integration for accessibility scanning.

export type RawViolation = {
  ruleId: string;
  // axe-core can return null impact for some rules; consumers must handle it.
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
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

const NAV_OPTIONS = { waitUntil: 'networkidle', timeout: 30000 } as const;

type AxeViolation = {
  id: string;
  impact?: string | null;
  description: string;
  tags?: string[];
  nodes: Array<{ target?: Array<string | string[]> }>;
};

function toRawViolations(violations: AxeViolation[]): RawViolation[] {
  return violations.map((v) => ({
    ruleId: v.id,
    impact: (v.impact ?? null) as RawViolation['impact'],
    message: v.description,
    selector: v.nodes[0]?.target?.flat().join(' >> ') || undefined,
    wcagRefs: v.tags?.filter((t) => t.startsWith('wcag')) || []
  }));
}

async function withPage<T>(url: string, fn: (page: import('playwright').Page) => Promise<T>): Promise<T> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(url, NAV_OPTIONS);
    return await fn(page);
  } finally {
    await browser.close();
  }
}

async function runAxe(page: import('playwright').Page) {
  const { AxeBuilder } = await import('@axe-core/playwright');
  return new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
}

/** Crawl + analyze in a single browser session. */
export async function scanPage(url: string): Promise<ScanResult> {
  return withPage(url, async (page) => {
    const title = await page.title();
    const axeResults = await runAxe(page);
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    const html = await page.content();
    return {
      violations: toRawViolations(axeResults.violations as AxeViolation[]),
      html,
      screenshotBuffer,
      title
    };
  });
}

export async function crawlPage(url: string): Promise<{ title: string; screenshotBuffer: Buffer }> {
  return withPage(url, async (page) => {
    const title = await page.title();
    const screenshotBuffer = await page.screenshot({ fullPage: true });
    return { title, screenshotBuffer };
  });
}

export async function analyzePage(url: string): Promise<RawViolation[]> {
  return withPage(url, async (page) => {
    const axeResults = await runAxe(page);
    return toRawViolations(axeResults.violations as AxeViolation[]);
  });
}
