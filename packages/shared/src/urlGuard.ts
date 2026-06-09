import net from 'node:net';

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', '127.0.0.1', '::1']);
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal'];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved
  );
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  return (
    lower === '::1' ||
    lower === '::' ||
    lower.startsWith('fc') || // unique-local fc00::/7
    lower.startsWith('fd') ||
    lower.startsWith('fe8') || // link-local fe80::/10
    lower.startsWith('fe9') ||
    lower.startsWith('fea') ||
    lower.startsWith('feb') ||
    lower.startsWith('::ffff:') // IPv4-mapped; be conservative
  );
}

export type UrlCheckResult = { ok: true } | { ok: false; reason: string };

/**
 * Validates that a URL is a plausible public scan target.
 * Blocks non-http(s) schemes, loopback, link-local (cloud metadata),
 * and private-range IP literals to reduce SSRF risk.
 *
 * Note: this checks hostname literals only; it does not resolve DNS,
 * so it does not protect against DNS-rebinding. Run the worker in a
 * network-isolated environment for full protection.
 */
export function checkScanTargetUrl(raw: string): UrlCheckResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Invalid URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http(s) URLs can be scanned' };
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { ok: false, reason: 'Loopback addresses cannot be scanned' };
  }
  if (BLOCKED_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return { ok: false, reason: 'Internal hostnames cannot be scanned' };
  }
  if (net.isIPv4(hostname) && isPrivateIPv4(hostname)) {
    return { ok: false, reason: 'Private or reserved IP addresses cannot be scanned' };
  }
  if (net.isIPv6(hostname) && isPrivateIPv6(hostname)) {
    return { ok: false, reason: 'Private or reserved IP addresses cannot be scanned' };
  }
  return { ok: true };
}
