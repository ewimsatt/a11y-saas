import { Job } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  update: vi.fn(),
  getCrawlQueue: vi.fn(),
  discardCrawlQueue: vi.fn()
}));

vi.mock('@a11y/db', () => ({
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
    mocks.findUnique.mockResolvedValue({ scanId: 'scan-1', jobId: 'scan-1-crawl', state: 'PENDING', attemptCount: 0 });
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

    expect(add).toHaveBeenCalledWith(expect.anything(), { scanId: 'scan-1' }, expect.objectContaining({ jobId: 'scan-1-crawl' }));
    expect(mocks.discardCrawlQueue).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { scanId: 'scan-1' },
      data: expect.objectContaining({ state: 'PENDING', attemptCount: 1, lastErrorCode: 'Error' })
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
    expect(recoveredQueue.add).toHaveBeenCalledWith(expect.anything(), { scanId: 'scan-1' }, expect.objectContaining({ jobId: 'scan-1-crawl' }));
  });
});
