import { describe, expect, it } from 'vitest';
import { DISCOVERY_PAGE_LIMIT, selectDiscoveredUrls } from '../../shared/src/discovery';

describe('selectDiscoveredUrls', () => {
  it('returns the seed and selected same-origin links with truthful cap truncation', () => {
    const seed = 'https://Example.test:443/start';
    const links = [
      'https://example.test/one',
      'https://example.test/two',
      ...Array.from({ length: 25 }, (_, index) => `https://example.test/page-${index}`)
    ];

    expect(selectDiscoveredUrls(seed, links)).toEqual({
      urls: [
        'https://example.test/start',
        'https://example.test/one',
        'https://example.test/two',
        ...Array.from({ length: DISCOVERY_PAGE_LIMIT - 3 }, (_, index) => `https://example.test/page-${index}`)
      ],
      truncated: true
    });
  });

  it('does not report truncation when exactly the allowed number of canonical pages exist', () => {
    const seed = 'https://example.test/start';
    expect(selectDiscoveredUrls(seed, Array.from({ length: DISCOVERY_PAGE_LIMIT - 1 }, (_, index) => `https://example.test/p${index}`))).toEqual({
      urls: [seed, ...Array.from({ length: DISCOVERY_PAGE_LIMIT - 1 }, (_, index) => `https://example.test/p${index}`)],
      truncated: false
    });
  });

  it('rejects unsafe, off-origin, non-standard-port, and non-http links while preserving valid hash routes', () => {
    const seed = 'https://example.test/start?view=all#top';

    expect(selectDiscoveredUrls(seed, [
      'https://other.test/away',
      'https://user:pass@example.test/credentialed',
      'https://127.0.0.1/internal',
      'https://example.test:8443/odd-port',
      'mailto:test@example.test',
      'javascript:alert(1)',
      'https://example.test/start?view=all#top',
      'https://example.test/start?view=all#other',
      'https://example.test/kept'
    ])).toEqual({
      urls: [
        'https://example.test/start?view=all#top',
        'https://example.test/start?view=all#other',
        'https://example.test/kept'
      ],
      truncated: false
    });
  });

  it('uses canonical identity for parser aliases, trailing slashes, query order, and fragments without erasing display URLs', () => {
    expect(selectDiscoveredUrls('https://example.test/app#/dashboard', [
      'https://EXAMPLE.test:443/docs#intro',
      'https://example.test/docs#intro',
      'https://example.test/docs#api',
      'https://example.test/docs/#intro',
      'https://example.test/docs?a=1&b=2',
      'https://example.test/docs?b=2&a=1',
      'https://example.test/app#/dashboard',
      'https://example.test/app#/settings'
    ])).toEqual({
      urls: [
        'https://example.test/app#/dashboard',
        'https://example.test/docs#intro',
        'https://example.test/docs#api',
        'https://example.test/docs/#intro',
        'https://example.test/docs?a=1&b=2',
        'https://example.test/docs?b=2&a=1',
        'https://example.test/app#/settings'
      ],
      truncated: false
    });
  });
});
