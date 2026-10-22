import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportData, ReportFinding } from '../src/lib/report/data';

const mocks = vi.hoisted(() => ({ buildReportData: vi.fn() }));
vi.mock('../src/lib/report/data', () => ({ buildReportData: mocks.buildReportData }));

import { reportRoutes } from '../src/routes/reports';

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

function finding(id: string, message: string, selector: string | null): ReportFinding {
  return {
    id,
    pageId: `page-${id}`,
    fingerprint: `fingerprint-${id}`,
    targetIdentity: { selector, id },
    evidenceMeta: { source: 'axe', multiline: 'first line\nsecond line', id },
    severity: 'SERIOUS',
    status: 'OPEN',
    ruleId: `rule-${id}`,
    message,
    selector,
    pageUrl: `https://example.test/${id}`,
    domSnippet: `<main data-id="${id}">first line\nsecond line</main>`,
    failureSummary: `Long observed failure for ${id}: ${'details '.repeat(40)}`,
    wcagRefs: ['wcag143', 'wcag412']
  };
}

function reportData(): ReportData {
  const findings = [
    finding('one', 'First line\nsecond line, with "quotes"', '#first'),
    finding('two', 'Second complete finding', 'main > a[href="/next"]')
  ];
  const groups = findings.map((item) => ({
    ruleId: item.ruleId,
    message: item.message,
    wcagRefs: item.wcagRefs,
    maxSeverity: item.severity,
    actionableMaxSeverity: item.severity,
    occurrences: 1,
    actionableOccurrences: 1,
    affectedPages: 1,
    actionableAffectedPages: 1,
    pages: [{ pageUrl: item.pageUrl, findings: [item] }]
  }));
  return {
    project: { name: 'Acme / <script>', baseUrl: 'https://example.test' },
    scan: { id: 'scan-route', status: 'completed', coverage: 'COMPLETE', startedAt: null, completedAt: null, isFinal: true },
    generatedAt: new Date('2026-10-21T00:00:00Z'),
    coverage: { requestedPages: 2, analyzedPages: 2, failedPages: 0, pendingPages: 0, label: 'Complete requested-page coverage' },
    totals: { findings: 2, actionableFindings: 2, uniqueRules: 2, affectedPages: 2, bySeverity: { CRITICAL: 0, SERIOUS: 2, MODERATE: 0, MINOR: 0 }, byStatus: { OPEN: 2, FIXED: 0, REGRESSED: 0, WAIVED: 0 } },
    findingGroups: groups,
    actionableGroups: groups,
    findings,
    pages: [],
    comparison: null,
    comparisonNote: 'Comparison omitted: no identical normalized requested URL set was found among the 25 most recent earlier completed COMPLETE scans.'
  };
}

describe('report routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.buildReportData.mockReset();
    app = Fastify();
    await app.register(reportRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns complete CSV export with a safe filename and no screenshot loading', async () => {
    mocks.buildReportData.mockResolvedValue(reportData());

    const response = await app.inject({ method: 'GET', url: '/scans/scan-route/report?format=csv' });
    const rows = parseCsvRecords(response.body);

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe('attachment; filename="a11y-report-acme-script-2026-10-21.csv"');
    expect(mocks.buildReportData).toHaveBeenCalledWith('scan-route', { includeScreenshots: false });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual(expect.arrayContaining(['finding_id', 'target_identity', 'evidence_metadata', 'dom_snippet']));
    expect(rows[1]).toEqual(expect.arrayContaining([
      'one',
      'page-one',
      'fingerprint-one',
      '{"selector":"#first","id":"one"}',
      '{"source":"axe","multiline":"first line\\nsecond line","id":"one"}',
      'First line\nsecond line, with "quotes"',
      '<main data-id="one">first line\nsecond line</main>'
    ]));
    expect(rows[2]).toEqual(expect.arrayContaining(['two', 'page-two', 'fingerprint-two', 'Second complete finding']));
    for (const item of reportData().findings) {
      const record = rows.find(row => row[0] === item.id)!;
      for (const value of [item.message, item.selector, item.failureSummary, item.domSnippet]) {
        expect(record).toContain(value);
      }
    }
  });

  it('returns not found when the report loader has no scan', async () => {
    mocks.buildReportData.mockResolvedValue(null);

    const response = await app.inject({ method: 'GET', url: '/scans/missing/report?format=csv' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Scan not found' });
    expect(mocks.buildReportData).toHaveBeenCalledWith('missing', { includeScreenshots: false });
  });

  it('keeps existing HTML behavior and requests screenshots for non-CSV formats', async () => {
    mocks.buildReportData.mockResolvedValue(reportData());

    const response = await app.inject({ method: 'GET', url: '/scans/scan-route/report?format=html' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('Accessibility report');
    expect(mocks.buildReportData).toHaveBeenCalledWith('scan-route', { includeScreenshots: true });
  });
});
