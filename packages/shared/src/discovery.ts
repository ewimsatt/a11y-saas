import { checkScanTargetUrl } from './urlGuard';
import { canonicalUrlIdentity } from './urlIdentity';

export const DISCOVERY_PAGE_LIMIT = 20;

function effectiveOrigin(url: URL): string {
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.protocol}//${url.hostname.toLowerCase()}:${port}`;
}

export type DiscoveredScope = {
  /** Display URLs in deterministic document order, beginning with the persisted seed. */
  urls: string[];
  /** True only when an additional policy-eligible canonical candidate was omitted by the cap. */
  truncated: boolean;
};

/**
 * Filters browser-resolved links from one rendered seed document. Discovery is
 * intentionally shallow: this does not navigate or recursively inspect links.
 */
export function selectDiscoveredUrls(seed: string, hrefs: readonly string[]): DiscoveredScope {
  const seedUrl = new URL(seed);
  const seedOrigin = effectiveOrigin(seedUrl);
  const urls = [seedUrl.toString()];
  const identities = new Set([canonicalUrlIdentity(seedUrl.toString())]);
  let truncated = false;

  for (const href of hrefs) {
    let candidate: URL;
    try {
      candidate = new URL(href);
    } catch {
      continue;
    }
    if (effectiveOrigin(candidate) !== seedOrigin || !checkScanTargetUrl(candidate.toString()).ok) continue;
    const identity = canonicalUrlIdentity(candidate.toString());
    if (identities.has(identity)) continue;
    if (urls.length >= DISCOVERY_PAGE_LIMIT) {
      truncated = true;
      continue;
    }
    identities.add(identity);
    urls.push(candidate.toString());
  }
  return { urls, truncated };
}
