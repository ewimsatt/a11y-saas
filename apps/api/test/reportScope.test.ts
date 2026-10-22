import { describe, expect, it } from 'vitest';
import {
  deriveReportFinality,
  findComparablePriorScan,
  normalizeRequestedUrlSet,
  reportCoverageLabel,
  selectScreenshotPageIds
} from '../src/lib/report/scope';

describe('report scope and lifecycle facts', () => {
  it('requires completed COMPLETE status, a nonempty request set, and every requested page analyzed', () => {
    const analyzed = [{ id: 'a', url: 'https://example.test/a', outcome: 'ANALYZED' as const }];
    expect(deriveReportFinality('completed', 'COMPLETE', analyzed)).toBe(true);
    expect(deriveReportFinality('diffing', 'COMPLETE', analyzed)).toBe(false);
    expect(deriveReportFinality('completed', 'PARTIAL', analyzed)).toBe(false);
    expect(deriveReportFinality('completed', 'COMPLETE', [])).toBe(false);
    expect(
      deriveReportFinality('completed', 'COMPLETE', [
        ...analyzed,
        { id: 'b', url: 'https://example.test/b', outcome: 'FAILED' as const }
      ])
    ).toBe(false);
  });

  it('labels lifecycle or page-state contradictions as provisional', () => {
    expect(reportCoverageLabel(true, 'COMPLETE')).toBe('Complete requested-page coverage');
    expect(reportCoverageLabel(false, 'COMPLETE')).toBe(
      'Provisional: COMPLETE is recorded, but lifecycle or page outcomes are not final'
    );
    expect(reportCoverageLabel(false, 'PARTIAL')).toBe('Provisional PARTIAL requested-page coverage');
  });

  it('normalizes equivalent URL sets without treating different requested paths as comparable', () => {
    expect(
      normalizeRequestedUrlSet([
        'HTTPS://Example.TEST:443/a/?b=2&a=1#fragment',
        'https://example.test/'
      ])
    ).toEqual(['https://example.test/', 'https://example.test/a/?b=2&a=1']);
    expect(normalizeRequestedUrlSet(['https://example.test/a'])).not.toEqual(
      normalizeRequestedUrlSet(['https://example.test/b'])
    );
  });

  it('preserves path slashes and raw query order when deciding comparability', () => {
    for (const [left, right] of [
      ['https://example.test/a', 'https://example.test/a/'],
      ['https://example.test/a?b=2&a=1', 'https://example.test/a?a=1&b=2'],
      ['https://example.test/a?q=a%20b', 'https://example.test/a?q=a+b']
    ]) {
      expect(normalizeRequestedUrlSet([left!])).not.toEqual(normalizeRequestedUrlSet([right!]));
    }
  });

  it('searches past the newest scan for the latest scope-equivalent prior scan', () => {
    const candidates = [
      { id: 'newest-wrong-scope', completedAt: new Date('2026-10-20T12:00:00Z'), pages: [{ url: 'https://example.test/other' }] },
      { id: 'older-match', completedAt: new Date('2026-10-19T12:00:00Z'), pages: [{ url: 'https://example.test/a/' }] }
    ];
    expect(findComparablePriorScan(['https://EXAMPLE.test/a/'], candidates)?.id).toBe('older-match');
  });

  it('selects the most-affected analyzed pages, not storage order or failed pages', () => {
    const pages = [
      { id: 'first', url: 'https://example.test/first', outcome: 'ANALYZED' as const, findingCount: 1 },
      { id: 'failed', url: 'https://example.test/failed', outcome: 'FAILED' as const, findingCount: 99 },
      { id: 'most', url: 'https://example.test/most', outcome: 'ANALYZED' as const, findingCount: 8 },
      { id: 'second', url: 'https://example.test/second', outcome: 'ANALYZED' as const, findingCount: 4 },
      { id: 'third', url: 'https://example.test/third', outcome: 'ANALYZED' as const, findingCount: 3 }
    ];
    expect(selectScreenshotPageIds(pages, 3)).toEqual(['most', 'second', 'third']);
  });
});
