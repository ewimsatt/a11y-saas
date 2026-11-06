import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  scanFindMany: vi.fn(),
  findingFindMany: vi.fn(),
  findingCount: vi.fn()
}));
vi.mock('@a11y/db', () => ({
  prisma: {
    scan: { findUnique: mocks.findUnique, findMany: mocks.scanFindMany },
    finding: { findMany: mocks.findingFindMany, count: mocks.findingCount }
  }
}));

import { buildReportData, COMPARISON_SCAN_LIMIT } from '../src/lib/report/data';

describe('report data comparison lookup', () => {
  it('uses the documented bounded 25-candidate lookup and reports that same bound honestly', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'current',
      projectId: 'project-1',
      status: 'completed',
      coverage: 'COMPLETE',
      startedAt: new Date('2026-10-21T00:00:00Z'),
      completedAt: new Date('2026-10-21T01:00:00Z'),
      project: { name: 'Fixture', baseUrl: 'https://example.test' },
      pages: [{ id: 'page-1', url: 'https://example.test/a', outcome: 'ANALYZED', status: 200, title: null, error: null }]
    });
    mocks.findingFindMany.mockResolvedValue([]);
    mocks.scanFindMany.mockResolvedValue([]);

    const data = await buildReportData('current', { includeScreenshots: false });

    expect(COMPARISON_SCAN_LIMIT).toBe(25);
    expect(mocks.scanFindMany).toHaveBeenCalledWith(expect.objectContaining({ take: 25 }));
    expect(data?.comparison).toBeNull();
    expect(data?.comparisonNote).toContain('25 most recent earlier completed COMPLETE scans');
  });

  it('returns derived fixed transitions separately from a clean current scan total', async () => {
    mocks.findUnique.mockResolvedValue({
      id: 'current', projectId: 'project-1', status: 'completed', coverage: 'COMPLETE',
      startedAt: new Date('2026-10-21T00:00:00Z'), completedAt: new Date('2026-10-21T01:00:00Z'),
      project: { name: 'Fixture', baseUrl: 'https://example.test' },
      pages: [{ id: 'current-page', url: 'https://example.test/a', outcome: 'ANALYZED', status: 200, title: null, error: null }]
    });
    mocks.findingFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'prior-finding', fingerprint: 'same-rule-target', severity: 'SERIOUS', status: 'OPEN', ruleId: 'color-contrast', message: 'Prior observation', selector: '#old', page: { url: 'https://example.test/a' }, evidence: { id: 'prior-evidence', screenshot: 'pages/prior.png', domSnippet: '<p>old</p>', meta: {} }, rule: { wcagRefs: ['wcag2aa'] } }]);
    mocks.scanFindMany.mockResolvedValue([{ id: 'previous', status: 'completed', coverage: 'COMPLETE', completedAt: new Date('2026-10-20T01:00:00Z'), pages: [{ id: 'prior-page', url: 'https://example.test/a', outcome: 'ANALYZED' }] }]);

    const data = await buildReportData('current', { includeScreenshots: false });

    expect(data?.totals.findings).toBe(0);
    expect(data?.comparison).toMatchObject({ prevScanId: 'previous', fixed: [{ priorFindingId: 'prior-finding', priorEvidenceId: 'prior-evidence' }] });
  });
});
