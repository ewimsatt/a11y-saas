import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findingFindUnique: vi.fn(),
  findingFindMany: vi.fn(),
  findingUpdate: vi.fn(),
  findingUpdateMany: vi.fn()
}));

vi.mock('@a11y/db', () => ({
  prisma: {
    finding: {
      findUnique: mocks.findingFindUnique,
      findMany: mocks.findingFindMany,
      update: mocks.findingUpdate,
      updateMany: mocks.findingUpdateMany
    }
  }
}));

const reportMocks = vi.hoisted(() => ({ buildReportData: vi.fn() }));
vi.mock('../src/lib/report/data', () => ({ buildReportData: reportMocks.buildReportData }));

import { issueRoutes } from '../src/routes/issues';
import { scanRoutes } from '../src/routes/scans';

describe('local waiver lifecycle routes', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.findingUpdateMany.mockResolvedValue({ count: 0 });
    mocks.findingFindUnique.mockResolvedValue({ id: 'finding-1', status: 'OPEN' });
    mocks.findingUpdate.mockResolvedValue({ id: 'finding-1' });
    mocks.findingFindMany.mockResolvedValue([{ id: 'finding-1', severity: 'SERIOUS', status: 'WAIVED', waivedReason: 'Accepted local risk', waivedAt: new Date('2026-11-03T00:00:00.000Z'), waivedExpiresAt: null, rule: { id: 'label', title: 'Label', wcagRefs: ['wcag131'] }, evidence: null }]);
    reportMocks.buildReportData.mockResolvedValue(null);
    app = Fastify();
    await app.register(issueRoutes);
    await app.register(scanRoutes);
  });

  afterEach(async () => { await app.close(); });

  it('lists waived findings with waiver metadata after expiring stale waivers', async () => {
    const response = await app.inject({ method: 'GET', url: '/scans/scan-1/issues' });

    expect(response.statusCode).toBe(200);
    expect(mocks.findingUpdateMany).toHaveBeenCalledWith({
      where: { scanId: 'scan-1', status: 'WAIVED', waivedExpiresAt: { lte: expect.any(Date) } },
      data: { status: 'OPEN', waivedReason: null, waivedAt: null, waivedExpiresAt: null }
    });
    expect(mocks.findingFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { scanId: 'scan-1' } }));
    expect(response.json().issues[0]).toMatchObject({ status: 'WAIVED', waivedReason: 'Accepted local risk', waivedExpiresAt: null });
  });

  it('exposes derived fixed transitions beside, not inside, current issue observations', async () => {
    reportMocks.buildReportData.mockResolvedValue({
      comparison: {
        prevScanId: 'prior-scan',
        prevCompletedAt: new Date('2026-11-04T00:00:00.000Z'),
        prevTotal: 1,
        regressed: 0,
        fixed: [{ priorFindingId: 'prior-finding', priorEvidenceId: 'prior-evidence', priorPageUrl: 'https://example.test/prior', ruleId: 'color-contrast', message: 'Prior observed contrast issue' }]
      }
    });

    const response = await app.inject({ method: 'GET', url: '/scans/scan-1/issues' });

    expect(response.statusCode).toBe(200);
    expect(reportMocks.buildReportData).toHaveBeenCalledWith('scan-1', { includeScreenshots: false });
    expect(response.json()).toMatchObject({
      scanId: 'scan-1',
      issues: [expect.objectContaining({ id: 'finding-1' })],
      comparison: { fixed: [{ priorFindingId: 'prior-finding', priorEvidenceId: 'prior-evidence' }] }
    });
  });

  it('rejects a past waiver expiry before mutation', async () => {
    const response = await app.inject({ method: 'POST', url: '/issues/finding-1/waive', payload: { reason: 'Accepted local risk', expiresAt: '2020-01-01T00:00:00.000Z' } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatch(/future/i);
    expect(mocks.findingUpdate).not.toHaveBeenCalled();
  });

  it('expires stale waiver before rewaiving and clears a prior expiry when omitted', async () => {
    const response = await app.inject({ method: 'POST', url: '/issues/finding-1/waive', payload: { reason: 'Accepted local risk' } });

    expect(response.statusCode).toBe(200);
    expect(mocks.findingUpdateMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'finding-1', status: 'WAIVED' }) }));
    expect(mocks.findingUpdate).toHaveBeenCalledWith({ where: { id: 'finding-1' }, data: expect.objectContaining({ status: 'WAIVED', waivedExpiresAt: null }) });
  });

  it('unwaives through named and legacy routes with an atomic waived-only update', async () => {
    mocks.findingFindUnique.mockResolvedValue({ id: 'finding-1', status: 'WAIVED' });
    const named = await app.inject({ method: 'POST', url: '/issues/finding-1/unwaive' });
    const legacy = await app.inject({ method: 'POST', url: '/finding-1/unwaive' });

    expect(named.statusCode).toBe(200);
    expect(legacy.statusCode).toBe(200);
    expect(mocks.findingUpdateMany).toHaveBeenCalledWith({
      where: { id: 'finding-1', status: 'WAIVED' },
      data: { status: 'OPEN', waivedReason: null, waivedAt: null, waivedExpiresAt: null }
    });
    expect(mocks.findingUpdate).not.toHaveBeenCalled();
  });

  it('leaves an already non-waived finding unchanged when unwaived again', async () => {
    mocks.findingFindUnique.mockResolvedValue({ id: 'finding-1', status: 'FIXED' });
    const response = await app.inject({ method: 'POST', url: '/issues/finding-1/unwaive' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ issueId: 'finding-1', waived: false });
    expect(mocks.findingUpdate).not.toHaveBeenCalled();
  });

  it('returns 404 when unwaiving a missing finding', async () => {
    mocks.findingFindUnique.mockResolvedValueOnce(null);
    const response = await app.inject({ method: 'POST', url: '/issues/missing/unwaive' });
    expect(response.statusCode).toBe(404);
  });
});
