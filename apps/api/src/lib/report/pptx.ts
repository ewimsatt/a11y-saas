import PptxGenJS from 'pptxgenjs';
import type { ReportData, ReportFinding } from './data';

// Under tsx/esbuild the CJS build's default import is the module namespace,
// not the class; unwrap whichever shape we got.
const PptxCtor: typeof PptxGenJS =
  (PptxGenJS as unknown as { default?: typeof PptxGenJS }).default ?? PptxGenJS;
import { SEVERITY_ORDER, type Severity } from './stats';

// pptxgenjs colors are hex without '#'.
const INK = '0F172A';
const MUTED = '64748B';
const ACCENT = '0E7490';
const LINE = 'E2E8F0';
const SEVERITY_COLORS: Record<Severity, string> = {
  CRITICAL: 'B91C1C',
  SERIOUS: 'C2410C',
  MODERATE: 'A16207',
  MINOR: '0369A1'
};

const TITLE_OPTS = { fontFace: 'Helvetica', color: INK, bold: true } as const;
const BODY_OPTS = { fontFace: 'Helvetica', color: INK } as const;

function fmtDate(d: Date | null | undefined): string {
  if (!d) return '—';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function addSlideHeading(slide: PptxGenJS.Slide, text: string) {
  slide.addText(text, { ...TITLE_OPTS, x: 0.5, y: 0.3, w: 9, h: 0.6, fontSize: 26 });
  slide.addShape('rect', { x: 0.5, y: 0.95, w: 1.6, h: 0.06, fill: { color: ACCENT }, line: { type: 'none' } });
}

function addKpi(slide: PptxGenJS.Slide, x: number, value: string, label: string, color = INK) {
  slide.addShape('roundRect', {
    x, y: 1.5, w: 2.1, h: 1.6, rectRadius: 0.08,
    fill: { color: 'F8FAFC' }, line: { color: LINE, width: 1 }
  });
  slide.addText(value, { ...TITLE_OPTS, color, x, y: 1.6, w: 2.1, h: 0.9, fontSize: 34, align: 'center' });
  slide.addText(label.toUpperCase(), {
    ...BODY_OPTS, color: MUTED, x, y: 2.5, w: 2.1, h: 0.4, fontSize: 10, align: 'center', charSpacing: 2
  });
}

function findingBullets(findings: ReportFinding[], max: number): PptxGenJS.TextProps[] {
  return findings.slice(0, max).flatMap((f) => [
    {
      text: `${f.severity} — ${f.message}`,
      options: { ...BODY_OPTS, fontSize: 13, bold: true, color: SEVERITY_COLORS[f.severity], bullet: true, breakLine: true }
    },
    {
      text: `${f.ruleId} · ${f.pageUrl}`,
      options: { ...BODY_OPTS, fontSize: 10, color: MUTED, breakLine: true, indentLevel: 1 }
    }
  ]);
}

export async function buildPptx(data: ReportData): Promise<Buffer> {
  const pptx = new PptxCtor();
  pptx.layout = 'LAYOUT_16x9';
  pptx.author = 'A11Y SaaS';
  pptx.title = `Accessibility Audit — ${data.project.name}`;

  // --- Title slide
  {
    const slide = pptx.addSlide();
    slide.background = { color: 'FFFFFF' };
    slide.addShape('rect', { x: 0, y: 0, w: 10, h: 0.35, fill: { color: ACCENT }, line: { type: 'none' } });
    slide.addText('ACCESSIBILITY AUDIT REPORT', {
      ...BODY_OPTS, color: ACCENT, x: 0.6, y: 1.4, w: 8.8, h: 0.5, fontSize: 14, bold: true, charSpacing: 3
    });
    slide.addText(data.project.name, { ...TITLE_OPTS, x: 0.6, y: 1.9, w: 8.8, h: 1.1, fontSize: 44 });
    slide.addText(data.project.baseUrl, { ...BODY_OPTS, color: MUTED, x: 0.6, y: 3.0, w: 8.8, h: 0.5, fontSize: 16 });
    slide.addText(
      `Scan completed ${fmtDate(data.scan.completedAt)}  ·  Report generated ${fmtDate(data.generatedAt)}`,
      { ...BODY_OPTS, color: MUTED, x: 0.6, y: 4.6, w: 8.8, h: 0.4, fontSize: 12 }
    );
  }

  // --- Executive summary
  {
    const slide = pptx.addSlide();
    addSlideHeading(slide, 'Executive Summary');
    addKpi(slide, 0.5, String(data.score), `Score (${data.grade})`, ACCENT);
    addKpi(slide, 2.85, String(data.totals.findings), 'Total findings');
    addKpi(slide, 5.2, String(data.totals.bySeverity.CRITICAL), 'Critical', SEVERITY_COLORS.CRITICAL);
    addKpi(slide, 7.55, `${data.pages.filter((p) => p.crawled).length}/${data.pages.length}`, 'Pages scanned');
    const open = data.totals.byStatus.OPEN + data.totals.byStatus.REGRESSED;
    slide.addText(
      [
        { text: `${open} findings need action. `, options: { ...BODY_OPTS, fontSize: 16, bold: true } },
        {
          text: `${data.totals.byStatus.WAIVED} waived, ${data.totals.byStatus.FIXED} fixed since the previous scan. Waived findings are excluded from the health score.`,
          options: { ...BODY_OPTS, fontSize: 16, color: MUTED }
        }
      ],
      { x: 0.5, y: 3.5, w: 9, h: 1.2 }
    );
  }

  // --- Severity breakdown chart
  {
    const slide = pptx.addSlide();
    addSlideHeading(slide, 'Findings by Severity');
    slide.addChart(
      pptx.ChartType.bar,
      [
        {
          name: 'Findings',
          labels: [...SEVERITY_ORDER],
          values: SEVERITY_ORDER.map((s) => data.totals.bySeverity[s])
        }
      ],
      {
        x: 0.7, y: 1.3, w: 8.6, h: 3.8,
        barDir: 'bar',
        chartColors: SEVERITY_ORDER.map((s) => SEVERITY_COLORS[s]),
        chartColorsOpacity: 90,
        showValue: true,
        dataLabelColor: INK,
        dataLabelFontSize: 12,
        catAxisLabelColor: INK,
        valAxisLabelColor: MUTED,
        valGridLine: { color: LINE, style: 'solid', size: 1 },
        showLegend: false
      }
    );
  }

  // --- Trend vs previous scan
  if (data.comparison) {
    const slide = pptx.addSlide();
    addSlideHeading(slide, 'Change Since Previous Scan');
    addKpi(slide, 0.5, String(data.comparison.fixed), 'Fixed', '15803D');
    addKpi(slide, 2.85, String(data.comparison.regressed), 'Regressed', SEVERITY_COLORS.CRITICAL);
    addKpi(slide, 5.2, `${data.comparison.prevTotal} → ${data.totals.findings}`, 'Total findings');
    slide.addText(`Compared against the scan completed ${fmtDate(data.comparison.prevCompletedAt)}.`, {
      ...BODY_OPTS, color: MUTED, x: 0.5, y: 3.5, w: 9, h: 0.4, fontSize: 13
    });
  }

  // --- Top rules table
  if (data.topRules.length) {
    const slide = pptx.addSlide();
    addSlideHeading(slide, 'Most Frequent Rules');
    const header: PptxGenJS.TableRow = ['Rule', 'WCAG', 'Max severity', 'Count'].map((h) => ({
      text: h,
      options: { ...BODY_OPTS, bold: true, color: MUTED, fontSize: 11, fill: { color: 'F8FAFC' } }
    }));
    const rows: PptxGenJS.TableRow[] = data.topRules.slice(0, 8).map((r) => [
      { text: r.ruleId, options: { ...BODY_OPTS, fontSize: 12, bold: true } },
      { text: r.wcagRefs.join(', ') || '—', options: { ...BODY_OPTS, fontSize: 11, color: MUTED } },
      { text: r.maxSeverity, options: { ...BODY_OPTS, fontSize: 11, bold: true, color: SEVERITY_COLORS[r.maxSeverity] } },
      { text: String(r.count), options: { ...BODY_OPTS, fontSize: 12, align: 'center' } }
    ]);
    slide.addTable([header, ...rows], {
      x: 0.5, y: 1.3, w: 9, colW: [3.6, 2.4, 1.8, 1.2],
      border: { type: 'solid', color: LINE, pt: 1 },
      rowH: 0.42, valign: 'middle'
    });
  }

  // --- Key findings
  const keyFindings = data.findingsBySeverity.flatMap((g) => g.findings);
  if (keyFindings.length) {
    const slide = pptx.addSlide();
    addSlideHeading(slide, 'Key Findings');
    slide.addText(findingBullets(keyFindings, 6), { x: 0.5, y: 1.25, w: 9, h: 4, valign: 'top' });
    if (data.totals.findings > 6) {
      slide.addText(`Full detail for all ${data.totals.findings} findings is available in the PDF report.`, {
        ...BODY_OPTS, color: MUTED, x: 0.5, y: 5.1, w: 9, h: 0.35, fontSize: 11, italic: true
      });
    }
  }

  // --- Screenshot slides
  for (const page of data.pages.filter((p) => p.screenshotBase64).slice(0, 6)) {
    const slide = pptx.addSlide();
    addSlideHeading(slide, page.title || 'Scanned Page');
    slide.addText(`${page.url}  ·  ${page.findingCount} findings`, {
      ...BODY_OPTS, color: MUTED, x: 0.5, y: 1.05, w: 9, h: 0.35, fontSize: 11
    });
    slide.addImage({
      data: `image/png;base64,${page.screenshotBase64}`,
      x: 0.5, y: 1.5, w: 9, h: 3.9,
      sizing: { type: 'contain', w: 9, h: 3.9 }
    });
  }

  // --- Closing slide
  {
    const slide = pptx.addSlide();
    addSlideHeading(slide, 'Methodology & Next Steps');
    slide.addText(
      [
        { text: 'Methodology', options: { ...BODY_OPTS, bold: true, fontSize: 14, breakLine: true } },
        {
          text: 'Pages were loaded in headless Chromium and evaluated with axe-core against WCAG 2.0/2.1 A and AA rules. Findings are fingerprinted for stable tracking across scans.',
          options: { ...BODY_OPTS, fontSize: 13, color: MUTED, breakLine: true }
        },
        { text: '', options: { breakLine: true } },
        { text: 'Recommended next steps', options: { ...BODY_OPTS, bold: true, fontSize: 14, breakLine: true } },
        { text: 'Resolve critical and serious findings first.', options: { ...BODY_OPTS, fontSize: 13, bullet: true, breakLine: true } },
        { text: 'Re-scan after fixes to confirm and catch regressions.', options: { ...BODY_OPTS, fontSize: 13, bullet: true, breakLine: true } },
        { text: 'Schedule a manual expert audit — automated scans cover only a subset of WCAG.', options: { ...BODY_OPTS, fontSize: 13, bullet: true, breakLine: true } }
      ],
      { x: 0.5, y: 1.3, w: 9, h: 3.6, valign: 'top' }
    );
    slide.addText(`Scan ${data.scan.id} · Generated by A11Y SaaS`, {
      ...BODY_OPTS, color: MUTED, x: 0.5, y: 5.1, w: 9, h: 0.35, fontSize: 10
    });
  }

  return (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
}
