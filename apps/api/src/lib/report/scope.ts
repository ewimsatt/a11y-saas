type PageLifecycle = {
  id: string;
  url: string;
  outcome: 'PENDING' | 'ANALYZED' | 'FAILED';
};

type PriorScan = {
  id: string;
  completedAt: Date | null;
  pages: Array<{ url: string }>;
};

export function deriveReportFinality(
  status: string,
  coverage: string,
  pages: readonly PageLifecycle[]
): boolean {
  return (
    status === 'completed' &&
    coverage === 'COMPLETE' &&
    pages.length > 0 &&
    pages.every((page) => page.outcome === 'ANALYZED')
  );
}

export function reportCoverageLabel(isFinal: boolean, coverage: string): string {
  if (isFinal) return 'Complete requested-page coverage';
  if (coverage === 'COMPLETE') {
    return 'Provisional: COMPLETE is recorded, but lifecycle or page outcomes are not final';
  }
  return `Provisional ${coverage} requested-page coverage`;
}

function normalizeRequestedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    url.hostname = url.hostname.toLowerCase();
    if (
      (url.protocol === 'https:' && url.port === '443') ||
      (url.protocol === 'http:' && url.port === '80')
    ) {
      url.port = '';
    }
    // Path slashes and raw query order can change the requested resource.
    // Only normalize URL-parser origin details and the non-request fragment.
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function normalizeRequestedUrlSet(urls: readonly string[]): string[] {
  return [...new Set(urls.map(normalizeRequestedUrl))].sort();
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function findComparablePriorScan<T extends PriorScan>(
  currentUrls: readonly string[],
  candidates: readonly T[]
): T | null {
  const current = normalizeRequestedUrlSet(currentUrls);
  return (
    [...candidates]
      .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))
      .find((candidate) =>
        sameStringSet(current, normalizeRequestedUrlSet(candidate.pages.map((page) => page.url)))
      ) ?? null
  );
}

export function selectScreenshotPageIds(
  pages: readonly (PageLifecycle & { findingCount: number })[],
  limit: number
): string[] {
  return pages
    .filter((page) => page.outcome === 'ANALYZED')
    .sort(
      (left, right) =>
        right.findingCount - left.findingCount ||
        left.url.localeCompare(right.url) ||
        left.id.localeCompare(right.id)
    )
    .slice(0, Math.max(0, limit))
    .map((page) => page.id);
}
