import {
  claimNextStageDispatch,
  ensureClaimedStageTransport,
  finalizeStageDispatchEnqueueFailure,
  finalizeStageDispatchEnqueueSuccess,
  prisma
} from '@a11y/db';
import { QUEUES } from '@a11y/shared';
import { discardCrawlQueue, getCrawlQueue } from './queues';

const DISPATCH_LEASE_MS = 30_000;
let dispatching = false;

function queueErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 100) : 'QUEUE_UNAVAILABLE';
}


/**
 * Claims and transports only CRAWL intent. The worker owns later-stage recovery.
 * PostgreSQL decides eligibility and fence validity; Redis is a replaceable transport.
 */
export async function dispatchScan(scanId?: string): Promise<boolean> {
  const dispatch = await claimNextStageDispatch(prisma, { leaseMs: DISPATCH_LEASE_MS, scanId, stage: 'CRAWL' });
  if (!dispatch) return false;
  try {
    await ensureClaimedStageTransport(
      getCrawlQueue(),
      dispatch,
      QUEUES.crawl,
      { scanId: dispatch.scanId, stage: dispatch.stage, generation: dispatch.generation },
      {
        attempts: 3,
        backoff: { type: 'stage-run', delay: 1_000 },
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 1_000 }
      }
    );
    return await finalizeStageDispatchEnqueueSuccess(prisma, dispatch);
  } catch (error) {
    discardCrawlQueue();
    await finalizeStageDispatchEnqueueFailure(prisma, {
      ...dispatch,
      errorCode: queueErrorCode(error)
    });
    return false;
  }
}

/** Bounded, non-overlapping recovery pass. */
export async function dispatchDueScans(limit = 20): Promise<void> {
  if (dispatching) return;
  dispatching = true;
  try {
    for (let index = 0; index < limit; index += 1) {
      const dispatched = await dispatchScan();
      if (!dispatched) break;
    }
  } finally {
    dispatching = false;
  }
}

export function startScanDispatcher(intervalMs = 5_000): () => void {
  void dispatchDueScans().catch(() => undefined);
  const timer = setInterval(() => void dispatchDueScans().catch(() => undefined), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
