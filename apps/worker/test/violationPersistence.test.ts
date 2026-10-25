import { describe, expect, it } from 'vitest';
import { MAX_PAGE_VIOLATIONS, dedupePageViolations } from '../src/violationPersistence.js';

const page = { id: 'page-1', scanId: 'scan-1', url: 'https://example.test/violations' };

function violation(index: number) {
  return {
    ruleId: `rule-${index}`,
    impact: 'serious' as const,
    message: `missing alt ${index}`,
    selector: `.bad-${index}`,
    targetIdentity: JSON.stringify([`.bad-${index}`]),
    domSnippet: `<img class="bad-${index}">`
  };
}

const fingerprint = (input: { ruleId: string; selector?: string }) => `${input.ruleId}:${input.selector}`;

describe('dedupePageViolations', () => {
  it('refuses more than the bounded number of unique page violations', () => {
    expect(() => dedupePageViolations(page, Array.from({ length: MAX_PAGE_VIOLATIONS + 1 }, (_, index) => violation(index)), fingerprint)).toThrow(
      `Refusing to persist more than ${MAX_PAGE_VIOLATIONS} unique violations for page ${page.id}`
    );
  });

  it('retains one deterministic row for duplicate violations', () => {
    const rows = dedupePageViolations(page, [violation(1), violation(1)], fingerprint);
    expect(rows).toHaveLength(1);
    expect(rows[0].row).toMatchObject({ scanId: page.scanId, pageId: page.id, ruleId: 'rule-1', selector: '.bad-1' });
  });
});
