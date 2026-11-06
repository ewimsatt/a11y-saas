import { describe, expect, it } from 'vitest';
import { isComparableScan } from '../src/comparableScan.js';

describe('isComparableScan', () => {
  it('requires completed COMPLETE scans with a non-empty all-ANALYZED page set', () => {
    expect(isComparableScan({ status: 'completed', coverage: 'COMPLETE', pages: [{ outcome: 'ANALYZED' }] })).toBe(true);
    expect(isComparableScan({ status: 'completed', coverage: 'COMPLETE', pages: [] })).toBe(false);
    expect(isComparableScan({ status: 'completed', coverage: 'COMPLETE', pages: [{ outcome: 'PENDING' }] })).toBe(false);
    expect(isComparableScan({ status: 'completed', coverage: 'COMPLETE', pages: [{ outcome: 'FAILED' }] })).toBe(false);
  });
});