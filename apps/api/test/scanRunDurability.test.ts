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

  it('marks only an omitted URL payload as shallow-discovery eligible while preserving the empty-payload digest', async () => {
    const defaultResponse = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'default-scan' },
      payload: {}
    });
    expect(defaultResponse.statusCode).toBe(202);
    expect(mocks.scanCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ discoveryEnabled: true, discoveryState: 'PENDING', discoveryTruncated: false, requestDigest: 'fb2cc66ace5940bfc56c5faeaef6f2eff980023e571a0fa72a5b4e65e2007e3d' })
    }));

    const selectedResponse = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'selected-scan' },
      payload: { urls: ['https://example.test'] }
    });
    expect(selectedResponse.statusCode).toBe(202);
    expect(mocks.scanCreate).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ discoveryEnabled: false, discoveryState: 'FROZEN', discoveryTruncated: false })
    }));
  });

  it('rejects an explicitly empty URL scope instead of turning it into discovery', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'empty-explicit-scope' },
      payload: { urls: [] }
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.scanCreate).not.toHaveBeenCalled();
  });

  it('does not replay a discovery scan as an explicit one-page scan under the same idempotency key', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'mode-boundary' },
      payload: {}
    });
    expect(first.statusCode).toBe(202);
    const discoveryDigest = mocks.scanCreate.mock.calls[0][0].data.requestDigest;
    mocks.scanFindUnique.mockResolvedValueOnce({
      id: 'scan-discovery', projectId: 'project-1', status: 'queued', requestDigest: discoveryDigest
    });

    const replay = await app.inject({
      method: 'POST',
      url: '/scans/project-1/run',
      headers: { 'idempotency-key': 'mode-boundary' },
      payload: { urls: ['https://example.test'] }
    });

    expect(replay.statusCode).toBe(409);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
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
      data: [{ scanId: 'scan-1', url: 'https://example.test/one', urlIdentity: 'https://example.test/one' }],
      skipDuplicates: true
    });
    expect(mocks.dispatchCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ scanId: 'scan-1', jobId: 'scan-1-crawl-0', stage: 'CRAWL', generation: 0, state: 'PENDING' })
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
      requestDigest: '6c26586de69d65a8766bfb0f0d52d051bba1f8bafaa120ce2f9c6101d7da566b'
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
