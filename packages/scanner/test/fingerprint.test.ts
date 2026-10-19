import { describe, expect, it } from 'vitest';
import { stableFingerprint } from '../src/fingerprint.js';

describe('stableFingerprint', () => {
  const base = {
    ruleId: 'color-contrast',
    pageUrl: 'https://example.com/page',
    selector: '#main > p',
    message: 'Elements must have sufficient color contrast'
  };

  it('is deterministic', () => {
    expect(stableFingerprint(base)).toBe(stableFingerprint({ ...base }));
  });

  it('is case-insensitive', () => {
    expect(stableFingerprint(base)).toBe(
      stableFingerprint({ ...base, ruleId: 'COLOR-CONTRAST' })
    );
  });

  it('changes when the rule changes', () => {
    expect(stableFingerprint(base)).not.toBe(
      stableFingerprint({ ...base, ruleId: 'image-alt' })
    );
  });

  it('changes when the page changes', () => {
    expect(stableFingerprint(base)).not.toBe(
      stableFingerprint({ ...base, pageUrl: 'https://example.com/other' })
    );
  });

  it('tolerates missing selector and message', () => {
    const fp = stableFingerprint({ ruleId: 'r', pageUrl: 'https://e.com' });
    expect(fp).toMatch(/^[0-9a-f]{24}$/);
  });

  it('produces a 24-char hex digest', () => {
    expect(stableFingerprint(base)).toMatch(/^[0-9a-f]{24}$/);
  });

  it('does not merge structurally different axe targets with the same display selector', () => {
    const input = { ruleId: 'image-alt', pageUrl: 'https://e.com', message: 'missing alt', selector: 'iframe >> button' };
    expect(stableFingerprint({ ...input, targetIdentity: '[["iframe","button"]]' })).not.toBe(
      stableFingerprint({ ...input, targetIdentity: '["iframe","button"]' })
    );
    expect(stableFingerprint({ ...input, targetIdentity: '[["iframe"],["button"]]' })).toBe(
      stableFingerprint({ ...input, targetIdentity: '[["iframe"],["button"]]' })
    );
  });

  it('keeps case-sensitive structured targets as two unique finding records', () => {
    const input = { ruleId: 'image-alt', pageUrl: 'https://e.com', message: 'missing alt', selector: '#same-display' };
    const fingerprints = new Set([
      stableFingerprint({ ...input, targetIdentity: '["#Foo"]' }),
      stableFingerprint({ ...input, targetIdentity: '["#foo"]' })
    ]);
    expect(fingerprints.size).toBe(2);
  });
});
