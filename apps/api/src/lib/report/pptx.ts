import PptxGenJS from 'pptxgenjs';
import type { ReportData, ReportFinding } from './data';
import { groupContrastPatterns, type ContrastPattern } from './contrast';
import { SEVERITY_ORDER, type Severity } from './stats';
import { findingGuidance } from './quality';
import { selectRepresentativeFindings } from './representatives';

const PptxCtor: typeof PptxGenJS = (PptxGenJS as unknown as { default?: typeof PptxGenJS }).default ?? PptxGenJS;
const C = { charcoal: '19292F', ivory: 'FFFDF7', teal: '087D78', pale: 'EFF5F2', muted: '46545C', line: 'C8D1CD', critical: '8B1E1E', serious: '913B00', moderate: '6B5100', minor: '075D86' };
const severity: Record<Severity, string> = { CRITICAL: C.critical, SERIOUS: C.serious, MODERATE: C.moderate, MINOR: C.minor };

function shorten(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function formatDate(value: Date | null): string {
  return value ? value.toISOString().replace('T', ' ').replace('.000Z', ' UTC') : 'Not recorded';
}
function footer(slide: PptxGenJS.Slide, number: number, data: ReportData): void {
  slide.addText(`PROPELLIC  |  Scan ${data.scan.id}`, { x: .55, y: 5.26, w: 6.8, h: .16, fontFace: 'Arial', fontSize: 7, color: C.muted, margin: 0 });
  slide.addText(String(number), { x: 9.1, y: 5.23, w: .3, h: .2, fontFace: 'Arial', fontSize: 8, color: C.muted, align: 'right', margin: 0 });
}
function heading(slide: PptxGenJS.Slide, title: string, number: number, data: ReportData): void {
  slide.background = { color: C.ivory };
  slide.addText(title, { x: .55, y: .35, w: 8.6, h: .43, fontFace: 'Arial', fontSize: 25, bold: true, color: C.charcoal, margin: 0, fit: 'shrink' });
  footer(slide, number, data);
}
function card(slide: PptxGenJS.Slide, x: number, value: string, label: string): void {
  slide.addShape('rect', { x, y: 1.18, w: 1.68, h: 1.15, fill: { color: C.pale }, line: { color: C.line, pt: .8 } });
  slide.addShape('rect', { x, y: 1.18, w: .07, h: 1.15, fill: { color: C.teal }, line: { color: C.teal, transparency: 100 } });
  slide.addText(value, { x: x + .17, y: 1.39, w: 1.35, h: .35, fontFace: 'Arial', fontSize: 21, bold: true, color: C.teal, margin: 0, fit: 'shrink' });
  slide.addText(label.toUpperCase(), { x: x + .17, y: 1.92, w: 1.35, h: .14, fontFace: 'Arial', fontSize: 6.8, bold: true, color: C.muted, charSpacing: 1, margin: 0, fit: 'shrink' });
}
function evidence(slide: PptxGenJS.Slide, finding: ReportFinding): void {
  const guide = findingGuidance(finding.ruleId);
  slide.addShape('rect', { x: .55, y: 1.2, w: 8.65, h: 3.65, fill: { color: 'FFFFFF' }, line: { color: C.line, pt: .8 } });
  slide.addShape('rect', { x: .55, y: 1.2, w: .1, h: 3.65, fill: { color: severity[finding.severity] }, line: { color: severity[finding.severity], transparency: 100 } });
  slide.addText(`${finding.severity} · ${finding.ruleId} · WCAG ${finding.wcagRefs.join(', ') || 'reference not stored'}`, { x: .82, y: 1.46, w: 7.95, h: .24, fontFace: 'Arial', fontSize: 11, bold: true, color: severity[finding.severity], margin: 0, fit: 'shrink' });
  slide.addText(shorten(finding.message, 180), { x: .82, y: 1.86, w: 7.95, h: .42, fontFace: 'Arial', fontSize: 17, bold: true, color: C.charcoal, margin: 0, fit: 'shrink' });
  slide.addText(`Observed: ${shorten(finding.failureSummary ?? finding.message, 220)}`, { x: .82, y: 2.46, w: 7.95, h: .48, fontFace: 'Arial', fontSize: 12, color: C.charcoal, margin: 0, fit: 'shrink' });
  slide.addText(`URL ${shorten(finding.pageUrl, 118)}\nSelector ${shorten(finding.selector ?? 'Not stored', 118)}`, { x: .82, y: 3.08, w: 7.95, h: .5, fontFace: 'Arial', fontSize: 9.5, color: C.muted, margin: 0, fit: 'shrink' });
  slide.addText(`Repair lead: ${shorten(guide.suggestedFix, 220)}`, { x: .82, y: 3.76, w: 7.95, h: .45, fontFace: 'Arial', fontSize: 11, color: C.charcoal, margin: 0, fit: 'shrink' });
  slide.addText(`Full finding ID: ${finding.id}`, { x: .82, y: 4.48, w: 7.95, h: .16, fontFace: 'Arial', fontSize: 7, color: C.muted, margin: 0, fit: 'shrink' });
}

function addContrastRow(slide: PptxGenJS.Slide, pattern: ContrastPattern, y: number): void {
  const rowHeight = .52;
  slide.addShape('rect', { x: .55, y, w: 8.65, h: rowHeight, fill: { color: 'FFFFFF' }, line: { color: C.line, pt: .5 } });
  slide.addShape('rect', { x: .7, y: y + .13, w: .24, h: .24, fill: { color: pattern.foreground.slice(1) }, line: { color: '68756F', pt: .6 } });
  slide.addText(pattern.foreground, { x: 1, y: y + .12, w: .72, h: .2, fontFace: 'Arial', fontSize: 7.5, color: C.charcoal, margin: 0, fit: 'shrink' });
  slide.addShape('rect', { x: 1.76, y: y + .13, w: .24, h: .24, fill: { color: pattern.background.slice(1) }, line: { color: '68756F', pt: .6 } });
  slide.addText(pattern.background, { x: 2.06, y: y + .12, w: .72, h: .2, fontFace: 'Arial', fontSize: 7.5, color: C.charcoal, margin: 0, fit: 'shrink' });
  const observed = pattern.observedMin === pattern.observedMax ? String(pattern.observedMin) : `${pattern.observedMin}–${pattern.observedMax}`;
  slide.addText(`${observed}:1`, { x: 3.03, y: y + .12, w: .85, h: .2, fontFace: 'Arial', fontSize: 8.5, bold: true, color: C.charcoal, margin: 0 });
  slide.addText(`${pattern.requiredThreshold}:1`, { x: 4.05, y: y + .12, w: .8, h: .2, fontFace: 'Arial', fontSize: 8.5, color: C.charcoal, margin: 0 });
  slide.addText(`${pattern.occurrences} / ${pattern.affectedPageCount}`, { x: 5.05, y: y + .12, w: .85, h: .2, fontFace: 'Arial', fontSize: 8.5, color: C.charcoal, margin: 0 });
  slide.addText(`${shorten(pattern.exampleID, 28)}\n${shorten(pattern.exampleURL ?? 'URL not stored', 52)}`, { x: 6.05, y: y + .07, w: 2.95, h: .35, fontFace: 'Arial', fontSize: 6.8, color: C.muted, margin: 0, fit: 'shrink' });
}

export async function buildPptx(data: ReportData): Promise<Buffer> {
  const pptx = new PptxCtor();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'Propellic';
  pptx.subject = 'Accessibility scan executive summary';
  pptx.title = `Accessibility report | ${data.project.name}`;
  let number = 1;

  const cover = pptx.addSlide();
  cover.background = { color: C.charcoal };
  cover.addText('PROPELLIC', { x: .65, y: .55, w: 2, h: .25, fontFace: 'Arial', fontSize: 11, bold: true, color: '83F0E4', charSpacing: 2, margin: 0 });
  cover.addText('Accessibility\nreport', { x: .65, y: 1.18, w: 6.5, h: 1.2, fontFace: 'Arial', fontSize: 34, bold: true, color: C.ivory, margin: 0, fit: 'shrink' });
  cover.addText(shorten(data.project.name, 90), { x: .65, y: 2.65, w: 7.8, h: .46, fontFace: 'Arial', fontSize: 21, color: 'C8DDD8', margin: 0, fit: 'shrink' });
  cover.addText(`Status ${data.scan.status} | Requested-page coverage ${data.scan.coverage}`, { x: .65, y: 4.28, w: 8.7, h: .24, fontFace: 'Arial', fontSize: 10, color: C.ivory, margin: 0, fit: 'shrink' });
  cover.addText(`Scan completed ${formatDate(data.scan.completedAt)} | Exported ${formatDate(data.generatedAt)}`, { x: .65, y: 4.66, w: 8.7, h: .2, fontFace: 'Arial', fontSize: 8, color: 'C8DDD8', margin: 0, fit: 'shrink' });
  cover.addText(`Scan ID ${data.scan.id}`, { x: .65, y: 5.15, w: 6, h: .15, fontFace: 'Arial', fontSize: 7, color: 'B9D9D4', margin: 0 });
  cover.addText(String(number++), { x: 9.1, y: 5.15, w: .3, h: .15, fontFace: 'Arial', fontSize: 8, color: 'B9D9D4', align: 'right', margin: 0 });

  { const slide = pptx.addSlide(); heading(slide, 'Executive overview', number++, data); card(slide, .55, String(data.coverage.requestedPages), 'Requested'); card(slide, 2.35, String(data.coverage.analyzedPages), 'Analyzed'); card(slide, 4.15, String(data.totals.findings), 'Occurrences'); card(slide, 5.95, String(data.totals.uniqueRules), 'Rule types'); card(slide, 7.75, String(data.totals.affectedPages), 'Affected pages'); const statement = data.scan.isFinal ? 'Complete means every requested page was analyzed. It does not establish whole-site coverage or accessibility conformance.' : `${data.scan.coverage} coverage or ${data.scan.status} status is provisional. No final assessment or comparison is issued.`; slide.addShape('rect', { x: .55, y: 2.72, w: 8.66, h: .82, fill: { color: 'FFF0C9' }, line: { color: 'B88717', pt: .8 } }); slide.addText(statement, { x: .78, y: 2.98, w: 8.15, h: .28, fontFace: 'Arial', fontSize: 12, bold: true, color: '574000', margin: 0, fit: 'shrink' }); slide.addText(`${data.totals.actionableFindings} actionable occurrence(s), excluding FIXED and WAIVED findings.`, { x: .55, y: 3.92, w: 8.65, h: .28, fontFace: 'Arial', fontSize: 13, color: C.charcoal, margin: 0, fit: 'shrink' }); }
  { const slide = pptx.addSlide(); heading(slide, 'Observed distribution', number++, data); slide.addChart(pptx.ChartType.bar, [{ name: 'Occurrences', labels: SEVERITY_ORDER, values: SEVERITY_ORDER.map((item) => data.totals.bySeverity[item]) }], { x: .55, y: 1.1, w: 5.4, h: 3.75, barDir: 'bar', chartColors: SEVERITY_ORDER.map((item) => severity[item]), showValue: true, showLegend: false, catAxisLabelColor: C.charcoal, valAxisLabelColor: C.muted, valGridLine: { color: C.line, size: .5 } }); const priority = data.actionableGroups[0]; slide.addText('Action priority', { x: 6.35, y: 1.3, w: 2.4, h: .2, fontFace: 'Arial', fontSize: 15, bold: true, color: C.charcoal, margin: 0 }); slide.addText(priority ? `${priority.ruleId}\n${priority.actionableOccurrences} actionable occurrence(s) across ${priority.actionableAffectedPages} actionable page(s) (worst: ${priority.actionableMaxSeverity ?? 'MINOR'}). Priority reflects actionable observed severity and frequency, not effort or root cause.` : 'No actionable occurrences were recorded. This is not an accessibility conformance result.', { x: 6.35, y: 1.72, w: 2.6, h: 1.5, fontFace: 'Arial', fontSize: 13, color: C.charcoal, margin: 0, fit: 'shrink' }); }
  { const slide = pptx.addSlide(); heading(slide, 'Scope and methodology', number++, data); slide.addText('Requested pages were loaded in Chromium and evaluated with axe-core checks tagged WCAG 2.0 A/AA.', { x: .65, y: 1.25, w: 8.2, h: .36, fontFace: 'Arial', fontSize: 16, bold: true, color: C.charcoal, margin: 0, fit: 'shrink' }); slide.addText([{ text: 'Coverage is limited to the requested page set.', options: { bullet: true, breakLine: true } }, { text: 'Manual checks remain needed for keyboard paths, screen-reader experience, content, workflows, and conditions automation cannot determine.', options: { bullet: true, breakLine: true } }, { text: 'All recorded states appear in distribution; action priority excludes FIXED and WAIVED findings.', options: { bullet: true } }], { x: .8, y: 2.05, w: 7.8, h: 1.6, fontFace: 'Arial', fontSize: 15, color: C.charcoal, margin: 0, breakLine: false }); }

  const groupPages = Array.from(
    { length: Math.ceil(data.findingGroups.length / 7) },
    (_, index) => data.findingGroups.slice(index * 7, index * 7 + 7)
  );
  for (const [index, groups] of groupPages.entries()) {
    const slide = pptx.addSlide();
    heading(
      slide,
      groupPages.length === 1
        ? 'Findings and affected pages'
        : `Findings and affected pages (${index + 1}/${groupPages.length})`,
      number++,
      data
    );
    const rows: PptxGenJS.TableRow[] = [
      ['Rule', 'All', 'Actionable', 'Pages', 'Severity'].map((text) => ({
        text,
        options: { bold: true, fontFace: 'Arial', fontSize: 9, color: C.muted, fill: { color: C.pale } }
      })) as PptxGenJS.TableRow,
      ...groups.map((group) => [
        { text: shorten(group.ruleId, 42), options: { fontFace: 'Arial', fontSize: 10, bold: true } },
        { text: String(group.occurrences), options: { fontFace: 'Arial', fontSize: 10, align: 'center' as const } },
        { text: String(group.actionableOccurrences), options: { fontFace: 'Arial', fontSize: 10, align: 'center' as const } },
        { text: String(group.affectedPages), options: { fontFace: 'Arial', fontSize: 10, align: 'center' as const } },
        { text: group.maxSeverity, options: { fontFace: 'Arial', fontSize: 9, bold: true, color: severity[group.maxSeverity] } }
      ])
    ];
    slide.addTable(rows, {
      x: .55,
      y: 1.18,
      w: 8.65,
      colW: [3.65, 1.05, 1.25, 1.05, 1.65],
      border: { type: 'solid', color: C.line, pt: .6 },
      rowH: .42,
      valign: 'middle'
    });
    if (groupPages.length === 1 && groups.length <= 3) {
      const topPages = [...data.pages]
        .filter((page) => page.findingCount > 0)
        .sort((left, right) => right.findingCount - left.findingCount || left.url.localeCompare(right.url))
        .slice(0, 3);
      slide.addText('Top affected pages (all recorded)', { x: .55, y: 2.95, w: 4.2, h: .22, fontFace: 'Arial', fontSize: 14, bold: true, color: C.charcoal, margin: 0 });
      const pageRows: PptxGenJS.TableRow[] = [
        [
          { text: 'Page URL', options: { bold: true, fontFace: 'Arial', fontSize: 8, color: C.muted, fill: { color: C.pale } } },
          { text: 'Occurrences', options: { bold: true, fontFace: 'Arial', fontSize: 8, color: C.muted, fill: { color: C.pale } } }
        ],
        ...topPages.map((page) => [
          { text: shorten(page.url, 88), options: { fontFace: 'Arial', fontSize: 8.5 } },
          { text: String(page.findingCount), options: { fontFace: 'Arial', fontSize: 9, bold: true, align: 'center' as const } }
        ])
      ];
      slide.addTable(pageRows, { x: .55, y: 3.28, w: 8.65, colW: [7.1, 1.55], border: { type: 'solid', color: C.line, pt: .5 }, rowH: .34, valign: 'middle' });
    }
    slide.addText('All recorded states are shown. Actionable excludes FIXED and WAIVED. CSV and PDF retain every occurrence.', { x: .55, y: 4.78, w: 8.5, h: .2, fontFace: 'Arial', fontSize: 8.5, color: C.muted, margin: 0, fit: 'shrink' });
  }
  const contrast = groupContrastPatterns(data.findings);
  const contrastPages = Array.from(
    { length: Math.ceil(contrast.groups.length / 6) },
    (_, index) => contrast.groups.slice(index * 6, index * 6 + 6)
  );
  for (const [index, patterns] of contrastPages.entries()) {
    const slide = pptx.addSlide();
    heading(
      slide,
      contrastPages.length === 1
        ? 'Observed contrast patterns'
        : `Observed contrast patterns (${index + 1}/${contrastPages.length})`,
      number++,
      data
    );
    slide.addText('Reported color pairings are repair leads, not confirmed shared components or root causes.', { x: .55, y: .86, w: 8.55, h: .2, fontFace: 'Arial', fontSize: 9, color: C.muted, margin: 0, fit: 'shrink' });
    slide.addText('Foreground / background', { x: .7, y: 1.14, w: 2.1, h: .18, fontFace: 'Arial', fontSize: 7, bold: true, color: C.muted, margin: 0 });
    slide.addText('Observed', { x: 3.03, y: 1.14, w: .85, h: .18, fontFace: 'Arial', fontSize: 7, bold: true, color: C.muted, margin: 0 });
    slide.addText('Required', { x: 4.05, y: 1.14, w: .8, h: .18, fontFace: 'Arial', fontSize: 7, bold: true, color: C.muted, margin: 0 });
    slide.addText('Occurrences / pages', { x: 5.05, y: 1.14, w: .9, h: .18, fontFace: 'Arial', fontSize: 7, bold: true, color: C.muted, margin: 0, fit: 'shrink' });
    slide.addText('Traceable example', { x: 6.05, y: 1.14, w: 2.8, h: .18, fontFace: 'Arial', fontSize: 7, bold: true, color: C.muted, margin: 0 });
    patterns.forEach((pattern, row) => addContrastRow(slide, pattern, 1.4 + row * .56));
    if (contrast.unparsedEligibleCount > 0 && index === contrastPages.length - 1) {
      slide.addText(`${contrast.unparsedEligibleCount} eligible occurrence${contrast.unparsedEligibleCount === 1 ? ' was' : 's were'} not parsed from stored evidence; no ratio was invented.`, { x: .55, y: 4.82, w: 8.5, h: .22, fontFace: 'Arial', fontSize: 8.5, color: C.muted, margin: 0, fit: 'shrink' });
    }
  }
  if (!contrast.groups.length && contrast.unparsedEligibleCount > 0) {
    const slide = pptx.addSlide();
    heading(slide, 'Observed contrast patterns', number++, data);
    slide.addText(`${contrast.unparsedEligibleCount} eligible occurrence${contrast.unparsedEligibleCount === 1 ? ' was' : 's were'} not parsed from stored evidence; no ratio was invented.`, { x: .7, y: 1.45, w: 8, h: .6, fontFace: 'Arial', fontSize: 16, color: C.charcoal, margin: 0, fit: 'shrink' });
  }

  const representatives = selectRepresentativeFindings(data.findings, 2);
  for (const [index, finding] of representatives.entries()) {
    const slide = pptx.addSlide();
    heading(
      slide,
      representatives.length === 1
        ? 'Representative observed evidence'
        : `Representative observed evidence (${index + 1}/${representatives.length})`,
      number++,
      data
    );
    evidence(slide, finding);
  }
  const screenshots = data.pages.filter((page) => page.screenshot).slice(0, 2);
  if (screenshots.length) { const slide = pptx.addSlide(); heading(slide, 'Scanned page context', number++, data); slide.addText('Cropped top-of-page context only. These images are not annotated problem evidence.', { x: .55, y: .88, w: 8.6, h: .18, fontFace: 'Arial', fontSize: 9, color: C.muted, margin: 0 }); screenshots.forEach((page, index) => { const x = .55 + index * 4.35; slide.addShape('rect', { x, y: 1.25, w: 4.05, h: 3.18, fill: { color: C.pale }, line: { color: C.line, pt: .7 } }); slide.addImage({ data: `data:${page.screenshot!.mime};base64,${page.screenshot!.base64}`, x: x + .08, y: 1.33, sizing: { type: 'contain', x: x + .08, y: 1.33, w: 3.89, h: 2.58 }, altText: `Scanned page context: ${page.title ?? page.url}` }); slide.addText(shorten(page.url, 95), { x: x + .1, y: 4.02, w: 3.82, h: .18, fontFace: 'Arial', fontSize: 7, color: C.muted, margin: 0, fit: 'shrink' }); }); }
  {
    const slide = pptx.addSlide();
    heading(slide, 'Locate, repair, verify', number++, data);
    const steps = [
      ['01', 'LOCATE', 'Use the finding ID, URL, selector, and observed detail to reproduce the recorded state.'],
      ['02', 'REPAIR', 'Fix the rendered component behavior or content. Treat reported patterns as leads, not assumed root causes.'],
      ['03', 'VERIFY', 'Exercise the affected state, run relevant manual checks, then re-scan the same requested URL set.']
    ] as const;
    steps.forEach(([step, label, text], index) => {
      const x = .55 + index * 2.9;
      slide.addShape('rect', { x, y: 1.35, w: 2.58, h: 2.75, fill: { color: index === 1 ? 'FFFFFF' : C.pale }, line: { color: C.line, pt: .8 } });
      slide.addText(step, { x: x + .18, y: 1.6, w: .55, h: .3, fontFace: 'Arial', fontSize: 20, bold: true, color: C.teal, margin: 0 });
      slide.addText(label, { x: x + .18, y: 2.12, w: 2.1, h: .28, fontFace: 'Arial', fontSize: 14, bold: true, color: C.charcoal, margin: 0 });
      slide.addText(text, { x: x + .18, y: 2.65, w: 2.18, h: 1.05, fontFace: 'Arial', fontSize: 11, color: C.charcoal, margin: 0, fit: 'shrink' });
    });
    slide.addText('Manual accessibility checks remain necessary for keyboard paths, screen-reader experience, content, and workflows automation cannot determine.', { x: .55, y: 4.5, w: 8.65, h: .28, fontFace: 'Arial', fontSize: 10, color: C.muted, margin: 0, fit: 'shrink' });
  }
  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
