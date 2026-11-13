import { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  ensureClaimedStageTransport: vi.fn(),
  claimNextStageDispatch: vi.fn(),
  finalizeStageDispatchEnqueueSuccess: vi.fn(),
  finalizeStageDispatchEnqueueFailure: vi.fn(),
  getCrawlQueue: vi.fn(),
  discardCrawlQueue: vi.fn()
}));

vi.mock('@a11y/db', () => ({
  ensureClaimedStageTransport: mocks.ensureClaimedStageTransport,
  claimNextStageDispatch: mocks.claimNextStageDispatch,
  finalizeStageDispatchEnqueueSuccess: mocks.finalizeStageDispatchEnqueueSuccess,
  finalizeStageDispatchEnqueueFailure: mocks.finalizeStageDispatchEnqueueFailure,
  prisma: {
    scanDispatch: {
      findUnique: mocks.findUnique,
      update: mocks.update,
      findMany: vi.fn()
    }
  }
}));

vi.mock('../src/lib/queues', () => ({
  getCrawlQueue: mocks.getCrawlQueue,
  discardCrawlQueue: mocks.discardCrawlQueue
}));

import { dispatchScan } from '../src/lib/scanDispatch';

function validateBullMqJobId(jobId: string): void {
  const validateOptions = (Job.prototype as unknown as {
    validateOptions(this: unknown, jobData: unknown): void;
  }).validateOptions;
  validateOptions.call(
    { opts: { jobId }, name: 'crawl' },
    { data: JSON.stringify({ scanId: 'scan-1' }) }
  );
}

describe('initial scan dispatcher', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.findUnique.mockResolvedValue({ scanId: 'scan-1', jobId: 'scan-1-crawl-0', state: 'PENDING', attemptCount: 0 });
    mocks.claimNextStageDispatch.mockResolvedValue({
      scanId: 'scan-1', jobId: 'scan-1-crawl-0', stage: 'CRAWL', generation: 0,
      attemptCount: 0, dispatchAttemptCount: 0, claimToken: '00000000-0000-4000-8000-000000000001'
    });
    mocks.finalizeStageDispatchEnqueueSuccess.mockResolvedValue(true);
    mocks.finalizeStageDispatchEnqueueFailure.mockResolvedValue(true);
    mocks.ensureClaimedStageTransport.mockImplementation(async (queue, dispatch, name, data, options) => {
      await queue.add(name, data, { ...options, jobId: dispatch.jobId });
      return 'added';
    });
  });

  it('uses a deterministic BullMQ-valid custom job ID', () => {
    expect(() => validateBullMqJobId('scan-1-crawl')).not.toThrow();
    expect(() => validateBullMqJobId('scan-1:crawl')).toThrow('Custom Id cannot contain :');
  });

  it('retains a failed initial Redis enqueue as pending retryable intent', async () => {
    const add = vi.fn().mockRejectedValueOnce(new Error('Redis unavailable'));
    mocks.getCrawlQueue.mockReturnValue({ add });
    mocks.update.mockResolvedValue({ scanId: 'scan-1', state: 'PENDING' });

    await expect(dispatchScan('scan-1')).resolves.toBe(false);

    expect(add).toHaveBeenCalledWith(expect.anything(), { scanId: 'scan-1', stage: 'CRAWL', generation: 0 }, expect.objectContaining({ jobId: 'scan-1-crawl-0' }));
    expect(mocks.finalizeStageDispatchEnqueueFailure).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scanId: 'scan-1', errorCode: 'Error'
    }));
  });

  it('reinitializes the shared queue after Redis recovers in the same API process', async () => {
    const unavailableQueue = { add: vi.fn().mockRejectedValueOnce(new Error('Redis unavailable')) };
    const recoveredQueue = { add: vi.fn().mockResolvedValueOnce({ id: 'scan-1-crawl' }) };
    mocks.getCrawlQueue.mockReturnValueOnce(unavailableQueue).mockReturnValueOnce(recoveredQueue);
    mocks.update.mockResolvedValue({ scanId: 'scan-1', state: 'PENDING' });

    await expect(dispatchScan('scan-1')).resolves.toBe(false);
    await expect(dispatchScan('scan-1')).resolves.toBe(true);

    expect(mocks.discardCrawlQueue).toHaveBeenCalledTimes(1);
    expect(mocks.getCrawlQueue).toHaveBeenCalledTimes(2);
    expect(recoveredQueue.add).toHaveBeenCalledWith(expect.anything(), { scanId: 'scan-1', stage: 'CRAWL', generation: 0 }, expect.objectContaining({ jobId: 'scan-1-crawl-0' }));
  });
});
