import { Job, Queue, QueueEvents, Worker } from 'bullmq';
import Redis from 'ioredis';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureClaimedStageTransport, reconcileExactEnqueuedTransport } from '../src/stageTransport.ts';
import type { ClaimedStageDispatch, EnqueuedStage } from '../src/stageDispatchLedger.ts';

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error('REDIS_URL is required: this real-Redis suite must never skip');

const prefix = `a11y-stage-transport-test-${crypto.randomUUID()}`;
const queueName = `stage-transport-${crypto.randomUUID()}`;
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const queue = new Queue(queueName, { connection, prefix });
const events = new QueueEvents(queueName, { connection: connection.duplicate(), prefix });
const worker = new Worker(queueName, async (job) => {
  if (job.data.fail) throw new Error('fixture failure');
  return 'ok';
}, { connection: connection.duplicate(), prefix });

function dispatch(jobId: string): ClaimedStageDispatch {
  return {
    scanId: `scan-${jobId}`,
    jobId,
    stage: 'CRAWL',
    generation: 0,
    attemptCount: 0,
    dispatchAttemptCount: 0,
    runAttemptCount: 0,
    nextAttemptAt: new Date(),
    lastAttemptAt: null,
    enqueuedAt: null,
    lastErrorCode: null,
    claimToken: '00000000-0000-4000-8000-000000000001',
    leaseUntil: new Date(Date.now() + 30_000)
  };
}

function stage(jobId: string, runAttemptCount = 0): EnqueuedStage {
  return { scanId: `scan-${jobId}`, jobId, stage: 'CRAWL', generation: 0, runAttemptCount };
}

async function addTerminal(jobId: string, fail = false): Promise<Job> {
  const job = await queue.add(queueName, { fail }, { jobId, removeOnComplete: false, removeOnFail: false });
  if (fail) await expect(job.waitUntilFinished(events, 10_000)).rejects.toThrow('fixture failure');
  else await expect(job.waitUntilFinished(events, 10_000)).resolves.toBe('ok');
  return (await queue.getJob(jobId))!;
}

describe('shared exact Redis stage transport policy', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await queue.drain(true);
    await queue.clean(0, 1_000, 'completed');
    await queue.clean(0, 1_000, 'failed');
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await worker.close();
    await events.close();
    await queue.obliterate({ force: true });
    await queue.close();
    await connection.quit();
  });

  it('adds an absent exact job and leaves an existing waiting job untouched', async () => {
    await worker.pause();
    const claimed = dispatch('absent-job');
    await expect(ensureClaimedStageTransport(queue, claimed, queueName, {
      scanId: claimed.scanId, stage: claimed.stage, generation: claimed.generation
    }, {})).resolves.toBe('added');
    const job = await queue.getJob(claimed.jobId);
    expect(job).toBeDefined();

    await worker.pause();
    const waitingClaim = dispatch('waiting-job');
    const waiting = await queue.add(queueName, {
      scanId: waitingClaim.scanId, stage: waitingClaim.stage, generation: waitingClaim.generation
    }, { jobId: waitingClaim.jobId });
    try {
      await expect(ensureClaimedStageTransport(queue, waitingClaim, queueName, {
        scanId: waitingClaim.scanId, stage: waitingClaim.stage, generation: 0
      }, {})).resolves.toBe('existing-live');
      expect((await queue.getJob(waitingClaim.jobId))?.timestamp).toBe(waiting.timestamp);
    } finally {
      await worker.resume();
    }
  });

  it('removes completed and failed exact records before recreating them', async () => {
    for (const [jobId, fail] of [['completed-job', false], ['failed-job', true]] as const) {
      await addTerminal(jobId, fail);
      const claimed = dispatch(jobId);
      await worker.pause();
      await expect(ensureClaimedStageTransport(queue, claimed, queueName, {
        scanId: claimed.scanId, stage: claimed.stage, generation: 0
      }, {})).resolves.toBe('added');
      expect(await (await queue.getJob(jobId))!.getState()).toBe('waiting');
      await worker.resume();
    }
  });

  it('removes an unknown custom-ID record, confirms absence, and installs the expected runnable job', async () => {
    await worker.pause();
    const claimed = dispatch('unknown-job');
    const orphan = await queue.add(queueName, { stale: true }, { jobId: claimed.jobId });
    const stateSpy = vi.spyOn(Job.prototype, 'getState').mockImplementationOnce(async () => 'unknown');
    try {
      await expect(ensureClaimedStageTransport(queue, claimed, queueName, {
        scanId: claimed.scanId, stage: claimed.stage, generation: claimed.generation
      }, {})).resolves.toBe('added');

      const installed = await queue.getJob(claimed.jobId);
      expect(installed).toBeDefined();
      expect(installed?.data).toEqual({ scanId: claimed.scanId, stage: claimed.stage, generation: claimed.generation });
      expect(await installed?.getState()).toBe('waiting');
    } finally {
      stateSpy.mockRestore();
      await worker.resume();
    }
  });

  it('does not report permission to release when terminal record removal fails', async () => {
    const job = await addTerminal('remove-failure');
    vi.spyOn(Job.prototype, 'remove').mockRejectedValueOnce(new Error('fixture remove denied'));
    await expect(reconcileExactEnqueuedTransport(queue, stage(job.id!))).rejects.toThrow('fixture remove denied');
    expect(await queue.getJob(job.id!)).toBeDefined();
  });

  it('classifies absent, waiting, completed, and failed exact records against real Redis', async () => {
    await expect(reconcileExactEnqueuedTransport(queue, stage('missing-job'))).resolves.toBe('absent');

    await worker.pause();
    await queue.add(queueName, {}, { jobId: 'live-job' });
    await expect(reconcileExactEnqueuedTransport(queue, stage('live-job'))).resolves.toBe('live');
    await worker.resume();

    await addTerminal('terminal-completed');
    await expect(reconcileExactEnqueuedTransport(queue, stage('terminal-completed'))).resolves.toBe('terminal-removed');
    expect(await queue.getJob('terminal-completed')).toBeUndefined();

    await addTerminal('terminal-failed', true);
    await expect(reconcileExactEnqueuedTransport(queue, stage('terminal-failed', 3))).resolves.toBe('terminal-removed');
    expect(await queue.getJob('terminal-failed')).toBeUndefined();
  });
});
