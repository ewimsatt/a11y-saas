import { canonicalUrlIdentity, selectDiscoveredUrls } from '@a11y/shared';

export type PersistedDiscoveryScope = { urls: string[]; truncated: boolean };
type PendingScan = {
  id: string;
  discoveryEnabled: boolean;
  discoveryState: 'PENDING' | 'FROZEN';
  pages: Array<{ url: string; urlIdentity: string | null }>;
};

/**
 * This is the production CRAWL transaction's durable discovery seam. Its callers
 * must supply callbacks bound to the same transaction so candidate rows, scope
 * freeze, and CRAWL-to-ANALYZE advancement commit or roll back together.
 */
export async function persistAndFreezeDiscoveryScope(input: {
  scan: PendingScan;
  hrefs: readonly string[];
  createPages(rows: Array<{ scanId: string; url: string; urlIdentity: string }>): Promise<unknown>;
  freeze(data: { discoveryState: 'FROZEN'; discoveryTruncated: boolean }): Promise<unknown>;
  advance(): Promise<boolean>;
}): Promise<PersistedDiscoveryScope | null> {
  const { scan } = input;
  if (!scan.discoveryEnabled || scan.discoveryState !== 'PENDING') return null;

  const seed = scan.pages[0];
  if (!seed) throw new Error('A pending discovery scan must retain its seed page');
  const existing = new Set(scan.pages.map((page) => page.urlIdentity ?? canonicalUrlIdentity(page.url)));
  const selected = selectDiscoveredUrls(seed.url, input.hrefs);
  const urls = selected.urls.filter((url) => !existing.has(canonicalUrlIdentity(url)));
  if (urls.length) {
    await input.createPages(urls.map((url) => ({
      scanId: scan.id,
      url,
      urlIdentity: canonicalUrlIdentity(url)
    })));
  }
  await input.freeze({ discoveryState: 'FROZEN', discoveryTruncated: selected.truncated });
  if (!await input.advance()) throw new Error('Lost crawl stage fence');
  return { urls, truncated: selected.truncated };
}
