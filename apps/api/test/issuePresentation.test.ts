import { describe, expect, it } from 'vitest';
import { presentIssue } from '../src/lib/issuePresentation';

describe('presentIssue', () => {
  it('adds exact dotted criteria and an honest impact without changing raw rule references', () => {
    const issue = presentIssue({
      id: 'finding-1',
      severity: 'SERIOUS',
      message: 'Contrast must meet minimum thresholds',
      rule: { id: 'color-contrast', title: 'Elements must meet minimum color contrast ratio thresholds', wcagRefs: ['wcag143', 'wcag2aa', 'best-practice'] }
    });

    expect(issue).toMatchObject({
      id: 'finding-1',
      impact: 'serious',
      rule: {
        id: 'color-contrast',
        title: 'Elements must meet minimum color contrast ratio thresholds',
        wcagRefs: ['wcag143', 'wcag2aa', 'best-practice'],
        wcagCriteria: ['1.4.3']
      }
    });
  });
});
