import { describe, expect, it } from 'vitest';
import { groupContrastPatterns, type ContrastFinding } from '../src/lib/report/contrast';

const finding = (overrides: Partial<ContrastFinding> = {}): ContrastFinding => ({
  id: 'id-1',
  ruleId: 'color-contrast',
  status: 'OPEN',
  pageUrl: 'https://example.test/a',
  selector: '.x',
  failureSummary:
    'Element has insufficient color contrast of 3.1 (foreground color: #C4853E, background color: #FFFFFF, font size: 12px). Expected contrast ratio of 4.5:1',
  ...overrides
});

describe('groupContrastPatterns', () => {
  it('groups evidence and tracks extrema, occurrences, pages, and example', () => {
    const result = groupContrastPatterns([
      finding(),
      finding({
        id: 'id-2',
        pageUrl: 'https://example.test/b',
        selector: '#y',
        failureSummary:
          'Element has insufficient color contrast of 2.92 (foreground color: #c4853e, background color: #ffffff, font size: 12px). Expected contrast ratio of 4.5:1'
      })
    ]);
    expect(result.parsedEligibleCount).toBe(2);
    expect(result.unparsedEligibleCount).toBe(0);
    expect(result.groups).toEqual([
      {
        foreground: '#c4853e',
        background: '#ffffff',
        requiredThreshold: 4.5,
        observedMin: 2.92,
        observedMax: 3.1,
        occurrences: 2,
        affectedPageCount: 2,
        exampleID: 'id-1',
        exampleSelector: '.x',
        exampleURL: 'https://example.test/a'
      }
    ]);
  });

  it('keeps required thresholds separate', () => {
    const result = groupContrastPatterns([
      finding(),
      finding({
        id: 'id-2',
        failureSummary:
          'Element has insufficient color contrast of 3 (foreground color: #c4853e, background color: #ffffff, font size: 12px). Expected contrast ratio of 3:1'
      })
    ]);
    expect(result.groups.map((group) => group.requiredThreshold)).toEqual([4.5, 3]);
  });

  it('only considers OPEN and REGRESSED color-contrast findings', () => {
    const result = groupContrastPatterns([
      finding(),
      finding({ id: 'closed', status: 'CLOSED' }),
      finding({ id: 'other', ruleId: 'color-contrast-enhanced' }),
      finding({ id: 'reg', status: 'REGRESSED' })
    ]);
    expect(result.parsedEligibleCount).toBe(2);
    expect(result.groups[0]?.occurrences).toBe(2);
  });

  it('counts missing and malformed eligible evidence as unparsed', () => {
    const result = groupContrastPatterns([
      finding({ failureSummary: undefined }),
      finding({ id: 'bad', failureSummary: 'contrast ratio unknown foreground #123456' }),
      finding({
        id: 'nan',
        failureSummary:
          'Element has insufficient color contrast of NaN (foreground color: #123, background color: #fff). Expected contrast ratio of 4.5:1'
      })
    ]);
    expect(result.parsedEligibleCount).toBe(0);
    expect(result.unparsedEligibleCount).toBe(3);
    expect(result.groups).toEqual([]);
  });

  it('rejects invalid colors and out-of-range ratios without inventing data', () => {
    const result = groupContrastPatterns([
      finding({
        failureSummary:
          'Element has insufficient color contrast of 22 (foreground color: #123456, background color: #ffffff). Expected contrast ratio of 4.5:1'
      }),
      finding({
        id: 'bad-color',
        failureSummary:
          'Element has insufficient color contrast of 3 (foreground color: rgb(1,2,3), background color: #ffffff). Expected contrast ratio of 4.5:1'
      })
    ]);
    expect(result.unparsedEligibleCount).toBe(2);
    expect(result.groups).toEqual([]);
  });

  it('handles HTML-like selectors and whitespace/newlines', () => {
    const result = groupContrastPatterns([
      finding({
        selector: '<a data-x="1">&</a>',
        failureSummary:
          'Fix any of the following:\n Element has insufficient color contrast of 3.25\n (foreground color: #8A8,\n background color: #faf8f5, font weight: normal).\n Expected contrast ratio of 4.5:1'
      })
    ]);
    expect(result.groups[0]).toMatchObject({
      foreground: '#88aa88',
      background: '#faf8f5',
      observedMin: 3.25,
      exampleSelector: '<a data-x="1">&</a>'
    });
  });

  it('rejects out-of-range ratios and non-unit denominators', () => {
    const summary = finding().failureSummary!;
    const summaries = [
      summary.replace('of 3.1', 'of 0.5'),
      summary.replace('of 3.1', 'of 22'),
      summary.replace('of 4.5:1', 'of 0.5:1'),
      summary.replace('4.5:1', '4.5:10'),
      summary.replace('4.5:1', '4.5:1.5')
    ];
    const result = groupContrastPatterns(
      summaries.map((failureSummary) => finding({ failureSummary }))
    );
    expect(result.parsedEligibleCount).toBe(0);
    expect(result.unparsedEligibleCount).toBe(summaries.length);
  });

  it('ranks the most common observed pattern first and ignores absent page identities', () => {
    const other = finding().failureSummary!.replace('#C4853E', '#888888');
    const result = groupContrastPatterns([
      finding(),
      finding({ failureSummary: other }),
      finding({ failureSummary: other, pageUrl: '' })
    ]);
    expect(result.groups[0]).toMatchObject({
      foreground: '#888888',
      occurrences: 2,
      affectedPageCount: 1
    });
  });

  it('does not parse unrelated text that merely contains color words', () => {
    const result = groupContrastPatterns([
      finding({
        failureSummary:
          'foreground color: #c4853e background color: #ffffff contrast of 3.1 expected 4.5'
      })
    ]);
    expect(result.parsedEligibleCount).toBe(0);
    expect(result.unparsedEligibleCount).toBe(1);
  });
});
