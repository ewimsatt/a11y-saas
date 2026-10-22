import { describe, expect, it } from 'vitest';
import {
  buildFindingsCsv,
  csvCell,
  findingGuidance,
  groupFindings,
  isActionableFinding,
  type FindingForQuality
} from '../src/lib/report/quality';

const finding = (
  id: string,
  ruleId: string,
  pageUrl: string,
  severity: FindingForQuality['severity'] = 'SERIOUS',
  status: FindingForQuality['status'] = 'OPEN'
): FindingForQuality => ({
  id,
  pageId: `page-${id}`,
  fingerprint: `fingerprint-${id}`,
  targetIdentity: { selector: `#${id}` },
  evidenceMeta: { targetIdentity: { selector: `#${id}` }, title: `Title ${id}`, url: pageUrl },
  ruleId,
  pageUrl,
  severity,
  status,
  message: 'Observed issue',
  selector: `#${id}`,
  domSnippet: null,
  failureSummary: null,
  wcagRefs: []
});

function parseCsvRecords(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index]!;
    if (quoted) {
      if (char === '"' && csv[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (char !== '\r') {
      cell += char;
    }
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

describe('report-quality helpers', () => {
  it('keeps all-recorded severity and pages while ranking mixed rules by actionable scope', () => {
    const mixedFixed = finding('mixed-fixed', 'mixed-rule', 'https://example.test/fixed', 'CRITICAL', 'FIXED');
    const mixedOpen = finding('mixed-open', 'mixed-rule', 'https://example.test/open', 'MINOR', 'OPEN');
    const waived = finding('waived', 'waived-rule', 'https://example.test/waived', 'CRITICAL', 'WAIVED');
    const serious = finding('serious', 'serious-rule', 'https://example.test/serious', 'SERIOUS', 'OPEN');
    const groups = groupFindings([mixedFixed, mixedOpen, waived, serious]);

    expect(groups.map((group) => group.ruleId)).toEqual(['serious-rule', 'mixed-rule', 'waived-rule']);
    expect(groups[1]).toMatchObject({
      maxSeverity: 'CRITICAL',
      affectedPages: 2,
      actionableMaxSeverity: 'MINOR',
      actionableAffectedPages: 1,
      actionableOccurrences: 1
    });
    expect(groups[2]).toMatchObject({
      maxSeverity: 'CRITICAL',
      actionableMaxSeverity: null,
      actionableAffectedPages: 0,
      actionableOccurrences: 0
    });
    expect(isActionableFinding(mixedOpen)).toBe(true);
    expect(isActionableFinding(mixedFixed)).toBe(false);
    expect(isActionableFinding(waived)).toBe(false);
  });

  it('offers evidence-safe contrast guidance without pretending to know the root cause', () => {
    expect(findingGuidance('color-contrast')).toMatchObject({
      whyItMatters: expect.stringContaining('read'),
      suggestedFix: expect.stringContaining('contrast'),
      howToRetest: expect.stringContaining('keyboard')
    });
    expect(findingGuidance('unknown-rule').suggestedFix.toLowerCase()).toContain('inspect');
  });

  it.each(['=SUM(A1:A2)', '+1+1', '-1+1', '@HYPERLINK("https://attacker.test")', '\t=SUM(A1:A2)', '\r=SUM(A1:A2)', ' =SUM(A1:A2)', '\n=SUM(A1:A2)'])(
    'formula-protects a cell after leading whitespace (%j)',
    (payload) => {
      const escaped = csvCell(payload);
      expect(escaped).toMatch(/^'?/);
      expect(escaped.replace(/^"|"$/g, '').replaceAll('""', '"')).toBe(`'${payload}`);
    }
  );

  it('round-trips multiline CSV records, full identity metadata, and all 162 rows', () => {
    const hostile = {
      ...finding('f-1', 'color-contrast', 'https://example.test'),
      message: '\n=HYPERLINK("https://attacker.test")',
      selector: ' =SUM(A1:A2)',
      domSnippet: '<p>first line\nsecond line</p>',
      failureSummary: '@formula',
      wcagRefs: ['wcag143']
    };
    const findings = [
      hostile,
      ...Array.from({ length: 161 }, (_, index) =>
        finding(`finding-${index + 2}`, 'color-contrast', `https://example.test/page-${index + 2}`)
      )
    ];
    const csv = buildFindingsCsv({
      project: { name: 'Fixture' },
      scan: { id: 'scan-162', status: 'completed', coverage: 'COMPLETE' },
      generatedAt: new Date('2026-10-21T00:00:00Z'),
      findings
    });
    const rows = parseCsvRecords(csv);

    expect(rows).toHaveLength(163);
    expect(rows[0]).toContain('fingerprint');
    expect(rows[0]).toContain('page_id');
    expect(rows[0]).toContain('target_identity');
    expect(rows[0]).toContain('evidence_metadata');
    expect(rows[1]).toContain("'\n=HYPERLINK(\"https://attacker.test\")");
    expect(rows[1]).toContain("' =SUM(A1:A2)");
    expect(rows[1]).toContain('fingerprint-f-1');
    expect(rows[1]).toContain('page-f-1');
    expect(rows[1]).toContain('{"selector":"#f-1"}');
    expect(rows[1]).toContain('{"targetIdentity":{"selector":"#f-1"},"title":"Title f-1","url":"https://example.test"}');
    expect(rows.at(-1)).toContain('finding-162');
  });
});
