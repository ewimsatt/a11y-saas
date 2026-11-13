import type { Job, JobsOptions, Queue } from 'bullmq';
import type { ClaimedStageDispatch, EnqueuedStage } from './stageDispatchLedger.ts';

export type ExactTransportState =
  | 'absent'
  | 'unknown'
  | 'waiting'
  | 'delayed'
  | 'active'
  | 'waiting-children'
  | 'completed'
  | 'failed';

type StageData = { scanId: string; stage: ClaimedStageDispatch['stage']; generation: number };

const LIVE_STATES = new Set<ExactTransportState>(['waiting', 'delayed', 'active', 'waiting-children']);

async function exactState(queue: Queue, jobId: string): Promise<{ job: Job | undefined; state: ExactTransportState }> {
  const job = await queue.getJob(jobId);
  if (!job) return { job: undefined, state: 'absent' };
  const state = await job.getState();
  if (state === 'unknown') return { job, state: 'unknown' };
  return { job, state: state as ExactTransportState };
}

async function removeAndConfirmAbsent(queue: Queue, job: Job, jobId: string): Promise<void> {
  await job.remove();
  const after = await exactState(queue, jobId);
  if (after.state !== 'absent') throw new Error(`transport ${jobId} still exists after removal`);
}

function matchesExpectedJob(job: Job | undefined, name: string, data: StageData): boolean {
  if (!job || job.name !== name) return false;
  const current = job.data as Partial<StageData>;
  return current.scanId === data.scanId && current.stage === data.stage && current.generation === data.generation;
}

/**
 * One exact-ID policy used by API CRAWL and worker stage dispatchers.
 * Unknown and terminal custom-ID records are removed and re-read before add.
 */
export async function ensureClaimedStageTransport(
  queue: Queue,
  dispatch: ClaimedStageDispatch,
  name: string,
  data: StageData,
  options: JobsOptions
): Promise<'existing-live' | 'added'> {
  const existing = await exactState(queue, dispatch.jobId);
  if (LIVE_STATES.has(existing.state)) {
    if (!matchesExpectedJob(existing.job, name, data)) throw new Error(`live transport ${dispatch.jobId} has unexpected identity or data`);
    return 'existing-live';
  }
  if (existing.job) await removeAndConfirmAbsent(queue, existing.job, dispatch.jobId);
  await queue.add(name, data, { ...options, jobId: dispatch.jobId });
  const installed = await exactState(queue, dispatch.jobId);
  if (!LIVE_STATES.has(installed.state) || !matchesExpectedJob(installed.job, name, data)) {
    throw new Error(`transport ${dispatch.jobId} was not installed as the expected live job`);
  }
  return 'added';
}

/**
 * Classifies an ENQUEUED exact transport. Unknown records are never absent:
 * they are removed and confirmed gone before the PostgreSQL claim can retry.
 */
export async function reconcileExactEnqueuedTransport(
  queue: Queue,
  stage: EnqueuedStage
): Promise<'live' | 'absent' | 'terminal-removed'> {
  const current = await exactState(queue, stage.jobId);
  if (LIVE_STATES.has(current.state)) return 'live';
  if (current.state === 'absent') return 'absent';
  if (!current.job) throw new Error(`transport ${stage.jobId} disappeared before removal`);
  await removeAndConfirmAbsent(queue, current.job, stage.jobId);
  return 'terminal-removed';
}
