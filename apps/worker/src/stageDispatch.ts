import type { JobsOptions } from 'bullmq';

export const DISPATCH_STAGES = ['CRAWL', 'ANALYZE', 'DIFF', 'EVIDENCE'] as const;
export type DispatchStage = (typeof DISPATCH_STAGES)[number];

export const MAX_RUN_ATTEMPTS = 3;

/** Stable, BullMQ-valid transport identity for one durable ledger generation. */
export function stageJobId(scanId: string, stage: DispatchStage, generation: number): string {
  if (!Number.isInteger(generation) || generation < 0) throw new RangeError('generation must be a non-negative integer');
  return `${scanId}-${stage.toLowerCase()}-${generation}`;
}

/** Remaining database-authoritative stage executions, never inferred from Redis. */
export function remainingRunAttempts(runAttemptCount: number): number {
  if (!Number.isInteger(runAttemptCount) || runAttemptCount < 0) throw new RangeError('runAttemptCount must be a non-negative integer');
  return Math.max(0, MAX_RUN_ATTEMPTS - runAttemptCount);
}

/** Delay before the next run after a completed run attempt. */
export function runRetryDelayMs(runAttemptCount: number): number {
  if (runAttemptCount === 1) return 1_000;
  if (runAttemptCount === 2) return 5_000;
  throw new RangeError('retry delay exists only after run attempts one or two');
}

/**
 * Redis is only transport.  A recreated job receives no more attempts than
 * the durable database ledger has left. BullMQ invokes the named strategy from
 * the worker's settings, which returns 1s after run one and 5s after run two.
 */
export function stageJobOptions(runAttemptCount: number): JobsOptions | null {
  const attempts = remainingRunAttempts(runAttemptCount);
  if (attempts === 0) return null;
  return {
    attempts,
    backoff: { type: 'stage-run', delay: 1_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 1_000 }
  };
}
