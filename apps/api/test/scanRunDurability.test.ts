import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  projectFindUnique: vi.fn(),
  scanFindUnique: vi.fn(),
  scanCreate: vi.fn(),
  pageCreateMany: vi.fn(),
  dispatchCreate: vi.fn(),
  transaction: vi.fn(),
  dispatchScan: vi.fn()
}));

vi.mock('@a11y/db', () => ({
  prisma: {
    project: { findUnique: mocks.projectFindUnique },
    scan: { findUnique: mocks.scanFindUnique, create: mocks.scanCreate },
    page: { createMany: mocks.pageCreateMany },
    scanDispatch: { create: mocks.dispatchCreate },
    $transaction: mocks.transaction
  }
}));

vi.mock('../src/lib/scanDispatch', () => ({
  dispatchScan: mocks.dispatchScan
}));

import { scanRoutes } from '../src/routes/scans';

describe('durable scan-run intake', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vi.resetAllMocks();
    mocks.projectFindUnique.mockResolvedValue({ id: 'project-1', baseUrl: 'https://example.test' });
    mocks.scanFindUnique.mockResolvedValue(null);
    mocks.scanCreate.mockResolvedValue({ id: 'scan-1', projectId: 'project-1', status: 'queued' });
    mocks.pageCreateMany.mockResolvedValue({ count: 1 });
    mocks.dispatchCreate.mockResolvedValue({ scanId: 'scan-1', state: 'PENDING' });
    mocks.transaction.mockImplementation(async (callback) => callback({
      project: { findUnique: mocks.projectFindUnique },
      scan: { findUnique: mocks.scanFindUnique, create: mocks.scanCreate },
      page: { createMany: mocks.pageCreateMany },
      scanDispatch: { create: mocks.dispatchCreate }
    }));
    mocks.dispatchScan.mockResolvedValue(true);
    app = Fastify();
    await app.register(scanRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  it('commits scan, requested pages, and deterministic dispatch intent together before enqueueing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'key-1' },
      payload: { urls: ['https://example.test/one'] }
    });

    expect(response.statusCode).toBe(202);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.scanCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ projectId: 'project-1', requestKey: 'key-1' })
    }));
    expect(mocks.pageCreateMany).toHaveBeenCalledWith({
      data: [{ scanId: 'scan-1', url: 'https://example.test/one' }]
    });
    expect(mocks.dispatchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ scanId: 'scan-1', jobId: 'scan-1-crawl', state: 'PENDING' })
    });
    expect(mocks.dispatchScan).toHaveBeenCalledWith('scan-1');
  });

  it('keeps the committed scan accepted when initial Redis dispatch fails', async () => {
    mocks.dispatchScan.mockRejectedValueOnce(new Error('Redis unavailable'));

    const response = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'key-2' },
      payload: { urls: ['https://example.test/one'] }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ scanId: 'scan-1', projectId: 'project-1', status: 'queued' });
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
  });

  it('returns the original scan when the same idempotency key is replayed with the same payload', async () => {
    mocks.scanFindUnique.mockResolvedValueOnce({
      id: 'scan-original',
      projectId: 'project-1',
      status: 'queued',
      requestDigest: 'bdf66b992fd89e1f9b6f4bf8dbab55aab7e8b37614f358e6649c154076170990'
    });

    const response = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'key-replayed' },
      payload: { urls: ['https://example.test/one'] }
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ scanId: 'scan-original', projectId: 'project-1', status: 'queued' });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('returns 400 for an empty Idempotency-Key instead of creating a scan', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': '   ' },
      payload: { urls: ['https://example.test/one'] }
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it('returns 409 when an idempotency key is reused with a changed payload', async () => {
    mocks.scanFindUnique.mockResolvedValueOnce({
      id: 'scan-original',
      projectId: 'project-1',
      requestDigest: 'different-digest'
    });

    const response = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'key-reused' },
      payload: { urls: ['https://example.test/changed'] }
    });

    expect(response.statusCode).toBe(409);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
