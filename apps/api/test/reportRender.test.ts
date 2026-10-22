import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderReportHtml } from '../src/lib/report/html';
import { renderPdf } from '../src/lib/report/pdf';
import { buildPptx } from '../src/lib/report/pptx';
import { groupFindings } from '../src/lib/report/quality';
import type { ReportData, ReportFinding } from '../src/lib/report/data';

const dirs: string[] = [];

function finding(
  id: string,
  ruleId = 'color-contrast',
  status: ReportFinding['status'] = 'OPEN'
): ReportFinding {
  return {
    id,
    pageId: `page-${id}`,
    fingerprint: `fp-${id}`,
    targetIdentity: { selector: `#${id}` },
    evidenceMeta: { targetIdentity: { selector: `#${id}` }, title: `Title ${id}`, url: `https://example.test/${id}` },
    severity: status === 'FIXED' ? 'CRITICAL' : 'SERIOUS',
    status,
    ruleId,
    message: `Observed ${ruleId} issue`,
    selector: `#${id}`,
    pageUrl: `https://example.test/${id}`,
    domSnippet: '<p>Observed</p>',
    failureSummary: `Observed failure for ${id}`,
    wcagRefs: ['wcag143']
  };
}

function reportData(overrides: Partial<ReportData> = {}): ReportData {
  const findings = overrides.findings ?? [finding('open'), finding('fixed', 'fixed-rule', 'FIXED')];
  const groups: ReportData['findingGroups'] = overrides.findingGroups ?? [
    { ruleId: 'color-contrast', message: 'Observed color-contrast issue', wcagRefs: ['wcag143'], maxSeverity: 'SERIOUS' as const, actionableMaxSeverity: 'SERIOUS' as const, occurrences: 1, actionableOccurrences: 1, affectedPages: 1, actionableAffectedPages: 1, pages: [{ pageUrl: findings[0]!.pageUrl, findings: [findings[0]!] }] },
    { ruleId: 'fixed-rule', message: 'Observed fixed-rule issue', wcagRefs: [], maxSeverity: 'CRITICAL' as const, actionableMaxSeverity: null, occurrences: 1, actionableOccurrences: 0, affectedPages: 1, actionableAffectedPages: 0, pages: [{ pageUrl: findings[1]!.pageUrl, findings: [findings[1]!] }] }
  ];
  return {
    project: { name: 'Fixture', baseUrl: 'https://example.test' },
    scan: { id: 'scan-1', status: 'completed', coverage: 'COMPLETE', startedAt: null, completedAt: null, isFinal: true },
    generatedAt: new Date('2026-10-21T00:00:00Z'),
    coverage: { requestedPages: 2, analyzedPages: 2, failedPages: 0, pendingPages: 0, label: 'Complete requested-page coverage' },
    totals: { findings: findings.length, actionableFindings: findings.filter((item) => item.status === 'OPEN' || item.status === 'REGRESSED').length, uniqueRules: groups.length, affectedPages: findings.length, bySeverity: { CRITICAL: 1, SERIOUS: 1, MODERATE: 0, MINOR: 0 }, byStatus: { OPEN: 1, FIXED: 1, REGRESSED: 0, WAIVED: 0 } },
    findingGroups: groups,
    actionableGroups: groups.filter((group) => group.actionableOccurrences > 0),
    findings,
    pages: [{ id: 'page-1', url: 'https://example.test/open', title: null, crawled: true, outcome: 'ANALYZED', responseStatus: 200, error: null, findingCount: 1, screenshot: null }],
    comparison: null,
    comparisonNote: 'Comparison omitted: no identical normalized requested URL set was found among the 25 most recent earlier completed COMPLETE scans.',
    ...overrides
  };
}

function pptxText(buffer: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-pptx-'));
  dirs.push(dir);
  const file = path.join(dir, 'report.pptx');
  fs.writeFileSync(file, buffer);
  return execFileSync('unzip', ['-p', file], { encoding: 'utf8' });
}
afterEach(() => dirs.splice(0).forEach((dir) => fs.rmSync(dir, { recursive: true, force: true })));

describe.each(['PENDING', 'PARTIAL', 'FAILED'] as const)('provisional %s reports', (coverage) => {
  it('does not emit final conclusions, comparison, grades, or scores', async () => {
    const data = reportData({ scan: { id: 'scan-1', status: coverage === 'PENDING' ? 'diffing' : 'completed', coverage, startedAt: null, completedAt: null, isFinal: false }, comparison: null });
    const html = renderReportHtml(data);
    expect(html).toContain('No final assessment or comparison is issued');
    expect(html).not.toMatch(/\b[0-9]+\/100\b|\bgrade\b/i);
    expect(html).not.toContain('Comparable prior scan');
    const text = pptxText(await buildPptx(data));
    expect(text).toContain('No final assessment or comparison is issued');
    expect(text).not.toMatch(/\b[0-9]+\/100\b/);
  });
});

it('does not treat COMPLETE plus diffing as final', () => {
  const html = renderReportHtml(reportData({ scan: { id: 'scan-1', status: 'diffing', coverage: 'COMPLETE', startedAt: null, completedAt: null, isFinal: false }, comparison: null }));
  expect(html).toContain('No final assessment or comparison is issued');
  expect(html).not.toContain('Comparable prior scan');
});

it('escapes hostile values and keeps fixed findings out of remediation priority', () => {
  const hostile = finding('open');
  hostile.message = '<script>window.pwned=1</script>';
  hostile.selector = 'x" onmouseover="alert(1)';
  const html = renderReportHtml(reportData({ findings: [hostile, finding('fixed', 'fixed-rule', 'FIXED')] }));
  expect(html).toContain('&lt;script&gt;window.pwned=1&lt;/script&gt;');
  expect(html).not.toContain('<script>window.pwned=1</script>');
  expect(html).toContain('Action priority: <b>color-contrast</b>');
  expect(html).not.toContain('Action priority: <b>fixed-rule</b>');
  expect(html).toContain('<tr class="context"><th colspan="4">');
  expect(html).toContain('<section class="appendix-group compact">');
  expect(html).toContain('.appendix-group td:first-child code{white-space:nowrap');
});

it('renders actionable severity and pages, not fixed or waived scope, in HTML and PPTX priority prose', async () => {
  const mixedFixed = finding('mixed-fixed', 'mixed-rule', 'FIXED');
  mixedFixed.severity = 'CRITICAL';
  mixedFixed.pageUrl = 'https://example.test/fixed';
  const mixedOpen = finding('mixed-open', 'mixed-rule');
  mixedOpen.severity = 'MINOR';
  mixedOpen.pageUrl = 'https://example.test/open';
  const serious = finding('serious', 'serious-rule');
  const waived = finding('waived', 'waived-rule', 'WAIVED');
  waived.severity = 'CRITICAL';
  const findings = [mixedFixed, mixedOpen, serious, waived];
  const groups = groupFindings(findings);
  const data = reportData({
    findings,
    findingGroups: groups,
    actionableGroups: groups.filter((group) => group.actionableOccurrences > 0)
  });

  const html = renderReportHtml(data);
  expect(html).toContain('Action priority: <b>serious-rule</b> has 1 actionable occurrence(s) across 1 actionable page(s) (worst: SERIOUS)');
  expect(html).not.toContain('Action priority: <b>mixed-rule</b>');

  const text = pptxText(await buildPptx(data));
  expect(text).toContain('serious-rule');
  expect(text).toContain('1 actionable occurrence(s) across 1 actionable page(s) (worst: SERIOUS)');
  expect(text).not.toContain('mixed-rule\n1 actionable occurrence(s) across 1 actionable page(s) (worst: MINOR)');
});

it('labels the worst actionable severity without assigning it to every occurrence', async () => {
  const minor = finding('minor', 'mixed-severity');
  minor.severity = 'MINOR';
  const serious = finding('serious', 'mixed-severity');
  const findings = [minor, serious];
  const groups = groupFindings(findings);
  const data = reportData({ findings, findingGroups: groups, actionableGroups: groups });
  for (const text of [renderReportHtml(data), pptxText(await buildPptx(data))]) {
    expect(text).toContain('2 actionable occurrence(s) across 2 actionable page(s) (worst: SERIOUS)');
    expect(text).not.toContain('2 actionable SERIOUS occurrence(s)');
  }
});

it('renders all report groups through adaptive PPTX pagination and traceable evidence', async () => {
  const findings = Array.from({ length: 9 }, (_, index) => finding(`finding-${index}`, `rule-${index}`));
  const groups = findings.map((item) => ({ ruleId: item.ruleId, message: item.message, wcagRefs: ['wcag143'], maxSeverity: item.severity, actionableMaxSeverity: item.severity, occurrences: 1, actionableOccurrences: 1, affectedPages: 1, actionableAffectedPages: 1, pages: [{ pageUrl: item.pageUrl, findings: [item] }] }));
  const text = pptxText(await buildPptx(reportData({ findings, findingGroups: groups, actionableGroups: groups })));
  expect(text).toContain('Findings and affected pages (1/2)');
  expect(text).toContain('Findings and affected pages (2/2)');
  expect(text).toContain('rule-8');
  expect(text).toContain('Full finding ID: finding-0');
  expect(text).toContain('Selector #finding-0');
  expect(text).toContain('Observed: Observed failure for finding-0');
  expect(text).toContain('WCAG wcag143');
  expect(text.match(/Representative observed evidence/g)).toHaveLength(2);
});

it('uses sparse rule-slide space for affected-page facts and a structured closing slide', async () => {
  const text = pptxText(await buildPptx(reportData()));
  expect(text).toContain('Top affected pages (all recorded)');
  expect(text).toContain('LOCATE');
  expect(text).toContain('REPAIR');
  expect(text).toContain('VERIFY');
  expect(text).toContain('Manual accessibility checks remain necessary');
});

it('renders observed contrast-pattern evidence without claiming shared root causes', async () => {
  const parsed = finding('contrast-parsed');
  parsed.failureSummary =
    'Element has insufficient color contrast of 3.1 (foreground color: #C4853E, background color: #FFFFFF, font size: 12px). Expected contrast ratio of 4.5:1';
  const unparsed = finding('contrast-unparsed');
  unparsed.failureSummary = 'Contrast evidence was stored in an unsupported shape';
  const data = reportData({ findings: [parsed, unparsed] });

  const html = renderReportHtml(data);
  expect(html).toContain('Observed contrast patterns');
  expect(html).toContain('#c4853e');
  expect(html).toContain('#ffffff');
  expect(html).toContain('3.1:1');
  expect(html).toContain('4.5:1');
  expect(html).toContain('1 eligible contrast occurrence could not be parsed');
  expect(html).toContain('not confirmed shared components or root causes');

  const text = pptxText(await buildPptx(data));
  expect(text).toContain('Observed contrast patterns');
  expect(text).toContain('#c4853e');
  expect(text).toContain('1 eligible occurrence was not parsed');
});

it('labels screenshots as cropped top-of-page context rather than annotated evidence', () => {
  const data = reportData();
  data.pages[0]!.screenshot = { mime: 'image/jpeg', base64: '/9j/2Q==' };
  const html = renderReportHtml(data);
  expect(html).toContain('cropped top-of-page context');
  expect(html).toContain('not annotated problem evidence');
});

it('emits tagged PDF structure and an outline', async () => {
  const pdf = await renderPdf(
    '<!doctype html><html lang="en"><body><h1>Report</h1><h2>Section</h2><p>Evidence</p></body></html>',
    'scan-tags'
  );
  const raw = pdf.toString('latin1');
  expect(raw).toContain('/StructTreeRoot');
  expect(raw).toContain('/Outlines');
});
