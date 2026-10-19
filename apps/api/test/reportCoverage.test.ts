import { describe, expect, it } from 'vitest';
import { reportAssessment } from '../src/lib/report/coverage';

describe('reportAssessment', () => {
  it('does not issue a grade for partial or failed coverage', () => {
    expect(reportAssessment('PARTIAL', 100)).toEqual({ score: null, grade: null, label: 'Partial coverage' });
    expect(reportAssessment('FAILED', 100)).toEqual({ score: null, grade: null, label: 'Scan failed' });
  });

  it('keeps a clean complete scan as a successful A grade', () => {
    expect(reportAssessment('COMPLETE', 100)).toEqual({ score: 100, grade: 'A', label: 'Complete coverage' });
  });
});
