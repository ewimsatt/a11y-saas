/**
 * Canonical identity for comparing requested scan scope and finding URLs.
 * It deliberately preserves pathname slash and query parameter ordering: both
 * can address different resources. Requested URLs remain stored for display.
 */
export function canonicalUrlIdentity(value: string): string {
  try {
    const url = new URL(value);
    url.hostname = url.hostname.toLowerCase();
    if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) {
      url.port = '';
    }
    return url.toString();
  } catch {
    return value.trim();
  }
}

/** Sorted, de-duplicated canonical identity set for an explicit request scope. */
export function canonicalUrlSet(urls: readonly string[]): string[] {
  return [...new Set(urls.map(canonicalUrlIdentity))].sort();
}

export function sameCanonicalUrlSet(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = canonicalUrlSet(left);
  const normalizedRight = canonicalUrlSet(right);
  return normalizedLeft.length === normalizedRight.length && normalizedLeft.every((value, index) => value === normalizedRight[index]);
}
