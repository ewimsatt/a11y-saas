import { describe, expect, it } from 'vitest';
import type { FindingForQuality } from '../src/lib/report/quality';
import { selectRepresentativeFindings } from '../src/lib/report/representatives';

function contrastFinding(
  id: string,
  foreground: string,
  background: string,
  pageUrl: string
): FindingForQuality {
  return {
    id,
    pageId: `page-${id}`,
    fingerprint: `fp-${id}`,
    targetIdentity: null,
    evidenceMeta: null,
    severity: 'SERIOUS',
    status: 'OPEN',
    ruleId: 'color-contrast',
    message: 'Insufficient contrast',
    selector: `#${id}`,
    pageUrl,
    domSnippet: null,
    failureSummary: `Element has insufficient color contrast of 3.1 (foreground color: ${foreground}, background color: ${background}, font size: 12px). Expected contrast ratio of 4.5:1`,
    wcagRefs: ['wcag143']
  };
}

describe('representative report evidence', () => {
  it('chooses diverse contrast patterns by occurrence count before storage order', () => {
    const findings = [
      contrastFinding('small-pattern', '#111111', '#ffffff', 'https://example.test/small'),
      contrastFinding('large-pattern-example', '#c4853e', '#ffffff', 'https://example.test/a'),
      contrastFinding('large-pattern-2', '#c4853e', '#ffffff', 'https://example.test/b'),
      contrastFinding('large-pattern-3', '#c4853e', '#ffffff', 'https://example.test/c')
    ];
    expect(selectRepresentativeFindings(findings, 2).map((finding) => finding.id)).toEqual([
      'large-pattern-example',
      'small-pattern'
    ]);
  });

  it('falls back to distinct actionable rule families when parsed contrast evidence is absent', () => {
    const contrast = contrastFinding('unparsed', '#111111', '#ffffff', 'https://example.test/a');
    contrast.failureSummary = 'Stored contrast evidence was not parseable';
    const imageAlt = { ...contrast, id: 'image-alt', pageId: 'page-image', ruleId: 'image-alt' };
    expect(selectRepresentativeFindings([contrast, imageAlt], 2).map((finding) => finding.id)).toEqual([
      'unparsed',
      'image-alt'
    ]);
  });
});
