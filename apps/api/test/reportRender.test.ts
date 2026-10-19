import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { renderReportHtml } from '../src/lib/report/html';
import { buildPptx } from '../src/lib/report/pptx';
import type { ReportData } from '../src/lib/report/data';

const tempDirs: string[] = [];

function reportData(coverage: ReportData['scan']['coverage']): ReportData {
  return {
    project: { name: 'Fixture', baseUrl: 'https://example.test' },
    scan: { id: 'scan-1', status: coverage === 'FAILED' ? 'failed' : 'completed', coverage, startedAt: null, completedAt: null },
    generatedAt: new Date('2026-10-18T00:00:00Z'),
    coverage: { requestedPages: 2, analyzedPages: coverage === 'COMPLETE' ? 2 : 1, failedPages: coverage === 'COMPLETE' ? 0 : 1, label: 'Injected label' },
    totals: {
      findings: 1,
      bySeverity: { CRITICAL: 0, SERIOUS: 1, MODERATE: 0, MINOR: 0 },
      byStatus: { OPEN: 1, FIXED: 9, REGRESSED: 2, WAIVED: 0 }
    },
    // Deliberately invalid supplied assessment and comparison data. Renderers must not trust it.
    score: 99,
    grade: 'A',
    topRules: [],
    findingsBySeverity: [],
    pages: [{ id: 'page-1', url: 'https://example.test', title: null, crawled: coverage === 'COMPLETE', outcome: coverage === 'COMPLETE' ? 'ANALYZED' : 'FAILED', responseStatus: null, error: 'browserType.launch: secret=top-secret at /private/path\nCall log: alice@example.test?token=hidden', findingCount: 1, screenshotBase64: null }],
    comparison: { prevScanId: 'old', prevCompletedAt: null, prevTotal: 10, fixed: 9, regressed: 2, prevCoverage: 'PARTIAL' }
  };
}

function pptxText(buffer: Buffer): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a11y-pptx-'));
  tempDirs.push(dir);
  const file = path.join(dir, 'report.pptx');
  fs.writeFileSync(file, buffer);
  return execFileSync('unzip', ['-p', file], { encoding: 'utf8' });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.each(['PENDING', 'PARTIAL', 'FAILED'] as const)('incomplete %s reports', (coverage) => {
  it('renders explicit coverage and no supplied assessment or trend in HTML', () => {
    const html = renderReportHtml(reportData(coverage));
    expect(html).toContain(coverage);
    expect(html).toContain('not graded');
    expect(html).not.toContain('>99<');
    expect(html).not.toContain('Change Since Previous Scan');
    expect(html).not.toContain('>9</div><div class="kpi-label">Fixed');
    expect(html).not.toContain('top-secret');
    expect(html).not.toContain('/private/path');
    expect(html).not.toContain('Call log');
  });

  it('renders explicit coverage and no supplied assessment or trend in PPTX', async () => {
    const text = pptxText(await buildPptx(reportData(coverage)));
    expect(text).toContain(coverage);
    expect(text).toContain('NOT GRADED');
    expect(text).not.toContain('SCORE (A)');
    expect(text).not.toContain('Change Since Previous Scan');
    expect(text).not.toContain('9 waived, 9 fixed since the previous scan');
  });
});

it('keeps assessment and comparison only for current and prior complete coverage', () => {
  const data = reportData('COMPLETE');
  data.comparison = { prevScanId: 'old', prevCompletedAt: null, prevTotal: 10, fixed: 1, regressed: 0, prevCoverage: 'COMPLETE' };
  const html = renderReportHtml(data);
  expect(html).toContain('>99<');
  expect(html).toContain('Change Since Previous Scan');
});
