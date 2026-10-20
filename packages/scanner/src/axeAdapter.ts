// Playwright + axe-core integration for accessibility scanning.

export type RawViolation = {
  ruleId: string;
  // axe-core can return null impact for some rules; consumers must handle it.
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  message: string;
  /** Human-readable rendering only. Do not use as canonical identity. */
  selector?: string;
  /** Canonical, deterministic serialization of axe's structured target array. */
  targetIdentity: string;
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
  responseStatus: number;
};

export class ScanPageError extends Error {
  constructor(message: string, readonly responseStatus: number | null = null) {
    super(message);
    this.name = 'ScanPageError';
  }
}

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

function canonicalTarget(target: Array<string | string[]> | undefined): string {
  return JSON.stringify(target ?? []);
}

function displaySelector(target: Array<string | string[]> | undefined): string | undefined {
  const flattened = target?.flat(Infinity).filter((part): part is string => typeof part === 'string');
  return flattened?.length ? flattened.join(' >> ') : undefined;
}

export function toRawViolations(violations: AxeViolation[]): RawViolation[] {
  return violations.flatMap((v) =>
    v.nodes.map((node) => ({
      ruleId: v.id,
      impact: (v.impact ?? null) as RawViolation['impact'],
      message: v.description,
      selector: displaySelector(node.target),
      targetIdentity: canonicalTarget(node.target),
      wcagRefs: v.tags?.filter((t) => t.startsWith('wcag')) || [],
      domSnippet: node.html || undefined,
      failureSummary: node.failureSummary || undefined
    }))
  );
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
function requireBrowserEndpoint(): string {
  const endpoint = process.env.PLAYWRIGHT_WS_ENDPOINT;
  if (!endpoint) throw new ScanPageError('PLAYWRIGHT_WS_ENDPOINT is required for the remote scanner browser');
  try {
    const parsed = new URL(endpoint);
    if ((parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') || !parsed.hostname || !parsed.pathname || parsed.search || parsed.hash) {
      throw new Error('invalid endpoint');
    }
  } catch {
    throw new ScanPageError('PLAYWRIGHT_WS_ENDPOINT must be a websocket URL with a protected path');
  }
  return endpoint;
}

/**
 * Connects only to the isolated remote browser sidecar. There is intentionally
 * no local Chromium launch or per-context proxy override in this runtime.
 */
export async function createBrowserSession(): Promise<BrowserSession> {
  const endpoint = requireBrowserEndpoint();
  const { chromium } = await import('playwright');
  let browser: import('playwright').Browser;
  try {
    browser = await chromium.connect(endpoint);
  } catch {
    throw new ScanPageError('Remote scanner browser is unavailable');
  }

  // @axe-core/playwright requires pages from an explicit context
  // (browser.newPage()'s implicit context is rejected by AxeBuilder).
  async function withPage<T>(
    url: string,
    fn: (page: import('playwright').Page, response: import('playwright').Response) => Promise<T>
  ): Promise<T> {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, NAV_OPTIONS);
      if (!response) throw new ScanPageError('Navigation returned no HTTP response');
      if (!response.ok()) throw new ScanPageError(`HTTP ${response.status()} while loading page`, response.status());
      return await fn(page, response);
    } finally {
      await context.close();
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
      return withPage(url, async (page, response) => {
        const title = await page.title();
        const axeResults = await runAxe(page);
        const screenshotBuffer = await page.screenshot({ fullPage: true });
        const html = await page.content();
        return {
          violations: toRawViolations(axeResults.violations as AxeViolation[]),
          html,
          screenshotBuffer,
          title,
          responseStatus: response.status()
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
