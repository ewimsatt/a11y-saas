import { describe, expect, it } from 'vitest';
import { computeDiffUpdates, groupStatusUpdates } from '../src/diff.js';

describe('computeDiffUpdates', () => {
  it('returns no updates when there are no findings', () => {
    expect(computeDiffUpdates([], [])).toEqual([]);
  });

  it('marks previous OPEN findings as FIXED when absent from new scan', () => {
    const updates = computeDiffUpdates(
      [{ id: 'p1', fingerprint: 'fp-a', status: 'OPEN' }],
      []
    );
    expect(updates).toEqual([{ id: 'p1', status: 'FIXED' }]);
  });

  it('marks new findings as REGRESSED when previously FIXED', () => {
    const updates = computeDiffUpdates(
      [{ id: 'p1', fingerprint: 'fp-a', status: 'FIXED' }],
      [{ id: 'n1', fingerprint: 'fp-a' }]
    );
    expect(updates).toEqual([{ id: 'n1', status: 'REGRESSED' }]);
  });

  it('leaves persisting OPEN findings untouched', () => {
    const updates = computeDiffUpdates(
      [{ id: 'p1', fingerprint: 'fp-a', status: 'OPEN' }],
      [{ id: 'n1', fingerprint: 'fp-a' }]
    );
    expect(updates).toEqual([]);
  });

  it('does not resurrect WAIVED findings', () => {
    const updates = computeDiffUpdates(
      [{ id: 'p1', fingerprint: 'fp-a', status: 'WAIVED' }],
      []
    );
    expect(updates).toEqual([]);
  });

  it('handles mixed scenarios', () => {
    const updates = computeDiffUpdates(
      [
        { id: 'p1', fingerprint: 'gone', status: 'OPEN' },
        { id: 'p2', fingerprint: 'fixed-now-back', status: 'FIXED' },
        { id: 'p3', fingerprint: 'still-here', status: 'OPEN' }
      ],
      [
        { id: 'n1', fingerprint: 'fixed-now-back' },
        { id: 'n2', fingerprint: 'still-here' },
        { id: 'n3', fingerprint: 'brand-new' }
      ]
    );
    expect(updates).toContainEqual({ id: 'n1', status: 'REGRESSED' });
    expect(updates).toContainEqual({ id: 'p1', status: 'FIXED' });
    expect(updates).toHaveLength(2);
  });
});

describe('groupStatusUpdates', () => {
  it('returns empty groups for no updates', () => {
    expect(groupStatusUpdates([])).toEqual({ fixedIds: [], regressedIds: [] });
  });

  it('splits updates by status', () => {
    const groups = groupStatusUpdates([
      { id: 'a', status: 'FIXED' },
      { id: 'b', status: 'REGRESSED' },
      { id: 'c', status: 'FIXED' }
    ]);
    expect(groups).toEqual({ fixedIds: ['a', 'c'], regressedIds: ['b'] });
  });
});
