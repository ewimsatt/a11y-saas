import { describe, expect, it } from 'vitest';
import { decideScanOutcome } from '../src/scanOutcome.js';

describe('decideScanOutcome', () => {
  it('marks a zero-finding clean page as a complete successful scan', () => {
    expect(decideScanOutcome({ attempted: 1, analyzed: 1, failed: 0 })).toEqual({
      scanStatus: 'completed',
      coverage: 'COMPLETE',
      shouldDiff: true
    });
  });

  it('marks all page failures as failed and never diffs old findings', () => {
    expect(decideScanOutcome({ attempted: 2, analyzed: 0, failed: 2 })).toEqual({
      scanStatus: 'failed',
      coverage: 'FAILED',
      shouldDiff: false
    });
  });

  it('marks mixed page outcomes partial and never diffs incomplete scope', () => {
    expect(decideScanOutcome({ attempted: 2, analyzed: 1, failed: 1 })).toEqual({
      scanStatus: 'completed',
      coverage: 'PARTIAL',
      shouldDiff: false
    });
  });
});
