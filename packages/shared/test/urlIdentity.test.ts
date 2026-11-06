import { describe, expect, it } from 'vitest';
import { canonicalUrlIdentity, canonicalUrlSet } from '../src/urlIdentity.js';

describe('shared URL identity policy', () => {
  it('normalizes parser-level aliases while retaining requested-resource distinctions', () => {
    expect(canonicalUrlIdentity('HTTPS://Example.TEST:443/a?b=2&a=1#fragment')).toBe(
      'https://example.test/a?b=2&a=1#fragment'
    );
    expect(canonicalUrlIdentity('http://Example.TEST:80/a')).toBe('http://example.test/a');
    expect(canonicalUrlIdentity('https://example.test/a/')).not.toBe(canonicalUrlIdentity('https://example.test/a'));
    // Query ordering remains meaningful: requests can have order-sensitive semantics.
    expect(canonicalUrlIdentity('https://example.test/a?b=2&a=1')).not.toBe(
      canonicalUrlIdentity('https://example.test/a?a=1&b=2')
    );
  });

  it('deduplicates canonical scope identities and ignores request order without collapsing hash routes', () => {
    expect(
      canonicalUrlSet([
        'HTTPS://EXAMPLE.test:443/a#one',
        'https://example.test/a#two',
        'https://example.test/'
      ])
    ).toEqual(['https://example.test/', 'https://example.test/a#one', 'https://example.test/a#two']);
  });
});
