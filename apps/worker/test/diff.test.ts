import { describe, expect, it } from 'vitest';
import { deriveScanComparison, findComparableScan, selectComparableScans } from '../src/diff.js';

describe('deriveScanComparison', () => {
  it('derives fixed, persistent, and new transitions without changing an earlier observation', () => {
    const prior = [
      { id: 'prior-fixed', fingerprint: 'fixed' },
      { id: 'prior-persisting', fingerprint: 'persisting' }
    ];
    const current = [
      { id: 'current-persisting', fingerprint: 'persisting' },
      { id: 'current-new', fingerprint: 'new' }
    ];

    expect(deriveScanComparison(prior, current, [])).toEqual({
      fixed: [{ priorFindingId: 'prior-fixed', fingerprint: 'fixed' }],
      persisting: ['persisting'],
      new: ['new'],
      regressedIds: []
    });
    expect(prior).toEqual([
      { id: 'prior-fixed', fingerprint: 'fixed' },
      { id: 'prior-persisting', fingerprint: 'persisting' }
    ]);
  });

  it('marks only the current observation REGRESSED after present -> absent -> present', () => {
    const result = deriveScanComparison(
      [],
      [{ id: 'current-returned', fingerprint: 'returned' }],
      [[{ id: 'first-observation', fingerprint: 'returned' }]]
    );

    expect(result.fixed).toEqual([]);
    expect(result.regressedIds).toEqual(['current-returned']);
    expect(result.new).toEqual([]);
  });

  it('does not claim a regression from legacy mutable FIXED status alone', () => {
    expect(deriveScanComparison([], [{ id: 'current', fingerprint: 'legacy' }], [])).toEqual({
      fixed: [], persisting: [], new: ['legacy'], regressedIds: []
    });
  });

  it('returns no transitions when there is no comparable scan', () => {
    expect(deriveScanComparison(null, [{ id: 'current', fingerprint: 'fp' }], [])).toEqual({
      fixed: [], persisting: [], new: [], regressedIds: []
    });
  });
});

describe('findComparableScan', () => {
  it('requires exact raw requested URL scope equality so legacy raw fingerprints stay comparable', () => {
    const candidate = findComparableScan(
      ['HTTPS://EXAMPLE.test:443/a#fragment'],
      [
        { id: 'different', completedAt: new Date('2026-11-02T00:00:00Z'), pages: [{ url: 'https://example.test/other' }] },
        { id: 'different-hash-route', completedAt: new Date('2026-11-01T06:00:00Z'), pages: [{ url: 'https://example.test/a#settings' }] },
        { id: 'equivalent', completedAt: new Date('2026-11-01T00:00:00Z'), pages: [{ url: 'https://example.test/a#fragment' }] }
      ]
    );
    expect(candidate).toBeNull();
  });

  it('ignores completed COMPLETE candidates with pending or failed pages', () => {
    const candidates = selectComparableScans(['https://example.test/a'], [
      { id: 'pending', completedAt: new Date('2026-11-03T00:00:00Z'), status: 'completed', coverage: 'COMPLETE', pages: [{ url: 'https://example.test/a', outcome: 'PENDING' as const }] },
      { id: 'failed', completedAt: new Date('2026-11-02T00:00:00Z'), status: 'completed', coverage: 'COMPLETE', pages: [{ url: 'https://example.test/a', outcome: 'FAILED' as const }] },
      { id: 'valid', completedAt: new Date('2026-11-01T00:00:00Z'), status: 'completed', coverage: 'COMPLETE', pages: [{ url: 'https://example.test/a', outcome: 'ANALYZED' as const }] }
    ]);
    expect(candidates.map((candidate) => candidate.id)).toEqual(['valid']);
  });
});
