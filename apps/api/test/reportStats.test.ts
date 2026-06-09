import { describe, expect, it } from 'vitest';
import {
  computeScore,
  countBySeverity,
  countByStatus,
  scoreGrade,
  summarizeRules,
  type FindingLike
} from '../src/lib/report/stats';

const f = (
  severity: FindingLike['severity'],
  status: FindingLike['status'] = 'OPEN',
  ruleId = 'rule-a'
): FindingLike => ({ severity, status, ruleId });

describe('countBySeverity / countByStatus', () => {
  it('returns zeroed counts for no findings', () => {
    expect(countBySeverity([])).toEqual({ CRITICAL: 0, SERIOUS: 0, MODERATE: 0, MINOR: 0 });
    expect(countByStatus([])).toEqual({ OPEN: 0, FIXED: 0, REGRESSED: 0, WAIVED: 0 });
  });

  it('counts each finding once', () => {
    const findings = [f('CRITICAL'), f('CRITICAL'), f('MINOR', 'WAIVED')];
    expect(countBySeverity(findings)).toEqual({ CRITICAL: 2, SERIOUS: 0, MODERATE: 0, MINOR: 1 });
    expect(countByStatus(findings)).toEqual({ OPEN: 2, FIXED: 0, REGRESSED: 0, WAIVED: 1 });
  });
});

describe('computeScore', () => {
  it('is 100 with no findings', () => {
    expect(computeScore([])).toBe(100);
  });

  it('weights severities differently', () => {
    expect(computeScore([f('CRITICAL')])).toBe(90);
    expect(computeScore([f('SERIOUS')])).toBe(95);
    expect(computeScore([f('MODERATE')])).toBe(98);
    expect(computeScore([f('MINOR')])).toBe(99);
  });

  it('excludes waived findings', () => {
    expect(computeScore([f('CRITICAL', 'WAIVED')])).toBe(100);
  });

  it('floors at zero', () => {
    expect(computeScore(Array.from({ length: 20 }, () => f('CRITICAL')))).toBe(0);
  });
});

describe('scoreGrade', () => {
  it('maps boundaries to grades', () => {
    expect(scoreGrade(100)).toBe('A');
    expect(scoreGrade(90)).toBe('A');
    expect(scoreGrade(89)).toBe('B');
    expect(scoreGrade(70)).toBe('C');
    expect(scoreGrade(60)).toBe('D');
    expect(scoreGrade(0)).toBe('F');
  });
});

describe('summarizeRules', () => {
  it('groups by rule, sorts by count, and tracks max severity', () => {
    const summaries = summarizeRules([
      { ...f('MINOR', 'OPEN', 'color-contrast'), rule: { title: 'Contrast', wcagRefs: ['wcag143'] } },
      { ...f('SERIOUS', 'OPEN', 'color-contrast'), rule: { title: 'Contrast', wcagRefs: ['wcag143'] } },
      { ...f('CRITICAL', 'OPEN', 'image-alt'), rule: { title: 'Alt text', wcagRefs: ['wcag111'] } }
    ]);
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({ ruleId: 'color-contrast', count: 2, maxSeverity: 'SERIOUS' });
    expect(summaries[1]).toMatchObject({ ruleId: 'image-alt', count: 1, maxSeverity: 'CRITICAL' });
  });

  it('falls back to ruleId when rule metadata is missing', () => {
    const summaries = summarizeRules([f('MINOR', 'OPEN', 'mystery-rule')]);
    expect(summaries[0]).toMatchObject({ title: 'mystery-rule', wcagRefs: [] });
  });
});
