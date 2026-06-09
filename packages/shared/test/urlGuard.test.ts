import { describe, expect, it } from 'vitest';
import { checkScanTargetUrl } from '../src/urlGuard.js';

describe('checkScanTargetUrl', () => {
  it.each([
    'https://example.com',
    'http://example.com/path?q=1',
    'https://8.8.8.8',
    'https://sub.domain.co.uk:8443/page'
  ])('allows public URL %s', (url) => {
    expect(checkScanTargetUrl(url).ok).toBe(true);
  });

  it.each([
    'not-a-url',
    'ftp://example.com',
    'file:///etc/passwd',
    'http://localhost:3001',
    'http://127.0.0.1',
    'http://0.0.0.0',
    'http://10.1.2.3',
    'http://172.16.0.1',
    'http://192.168.1.1',
    'http://169.254.169.254/latest/meta-data/', // cloud metadata
    'http://100.64.0.1', // CGNAT
    'http://[::1]:8080',
    'http://[fd00::1]',
    'http://[fe80::1]',
    'http://foo.internal',
    'http://printer.local',
    'http://app.localhost'
  ])('blocks %s', (url) => {
    expect(checkScanTargetUrl(url).ok).toBe(false);
  });
});
