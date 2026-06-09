// Playwright + axe-core integration for accessibility scanning.

export type RawViolation = {
  ruleId: string;
  // axe-core can return null impact for some rules; consumers must handle it.
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  message: string;
  selector?: string;
  wcagRefs?: string[];
  // Outer HTML of the first violating node, as reported by axe.
  domSnippet?: string;
  // axe's human-readable explanation of why the node failed.
  failureSummary?: string;
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
  nodes: Array<{
    target?: Array<string | string[]>;
    html?: string;
    failureSummary?: string;
  }>;
};

function toRawViolations(violations: AxeViolation[]): RawViolation[] {
  return violations.map((v) => {
    const node = v.nodes[0];
    return {
      ruleId: v.id,
      impact: (v.impact ?? null) as RawViolation['impact'],
      message: v.description,
      selector: node?.target?.flat().join(' >> ') || undefined,
      wcagRefs: v.tags?.filter((t) => t.startsWith('wcag')) || [],
      domSnippet: node?.html || undefined,
      failureSummary: node?.failureSummary || undefined
    };
  });
}

async function runAxe(page: import('playwright').Page) {
  const { AxeBuilder } = await import('@axe-core/playwright');
  return new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
}

export type BrowserSession = {
  crawlPage(url: string): Promise<{ title: string; screenshotBuffer: Buffer }>;
  analyzePage(url: string): Promise<RawViolation[]>;
  scanPage(url: string): Promise<ScanResult>;
  close(): Promise<void>;
};

/**
 * Launches a single browser to be reused across multiple pages.
 * Each page operation gets a fresh tab; callers must close() the session.
 */
export async function createBrowserSession(): Promise<BrowserSession> {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch({ headless: true });

  async function withPage<T>(url: string, fn: (page: import('playwright').Page) => Promise<T>): Promise<T> {
    const page = await browser.newPage();
    try {
      await page.goto(url, NAV_OPTIONS);
      return await fn(page);
    } finally {
      await page.close();
    }
  }

  return {
    crawlPage(url) {
      return withPage(url, async (page) => {
        const title = await page.title();
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        return { title, screenshotBuffer };
      });
    },
    analyzePage(url) {
      return withPage(url, async (page) => {
        const axeResults = await runAxe(page);
        return toRawViolations(axeResults.violations as AxeViolation[]);
      });
    },
    scanPage(url) {
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
    },
    close() {
      return browser.close();
    }
  };
}

async function withSession<T>(fn: (session: BrowserSession) => Promise<T>): Promise<T> {
  const session = await createBrowserSession();
  try {
    return await fn(session);
  } finally {
    await session.close();
  }
}

/** Crawl + analyze in a single browser session. */
export async function scanPage(url: string): Promise<ScanResult> {
  return withSession((s) => s.scanPage(url));
}

export async function crawlPage(url: string): Promise<{ title: string; screenshotBuffer: Buffer }> {
  return withSession((s) => s.crawlPage(url));
}

export async function analyzePage(url: string): Promise<RawViolation[]> {
  return withSession((s) => s.analyzePage(url));
}
