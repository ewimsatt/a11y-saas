import { prisma } from '@a11y/db';
import { QUEUES } from '@a11y/shared';
import { discardCrawlQueue, getCrawlQueue } from './queues';

const MAX_IMMEDIATE_DISPATCH_ATTEMPTS = 5;
const MAX_BACKOFF_MS = 30_000;

function retryDelay(attemptCount: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attemptCount - 1), MAX_BACKOFF_MS);
}

function queueErrorCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name.slice(0, 100) : 'QUEUE_UNAVAILABLE';
}

/**
 * Dispatches an already-committed scan intent. PostgreSQL remains authoritative:
 * a Redis failure leaves the intent PENDING for this process or a later API start.
 */
export async function dispatchScan(scanId: string): Promise<boolean> {
  const dispatch = await prisma.scanDispatch.findUnique({ where: { scanId } });
  if (!dispatch || dispatch.state === 'ENQUEUED' || dispatch.state === 'DEAD') return dispatch?.state === 'ENQUEUED';

  try {
    await getCrawlQueue().add(
      QUEUES.crawl,
      { scanId },
      {
        jobId: dispatch.jobId,
        removeOnComplete: { age: 86_400, count: 1_000 },
        removeOnFail: { age: 604_800, count: 1_000 }
      }
    );
    await prisma.scanDispatch.update({
      where: { scanId },
      data: { state: 'ENQUEUED', enqueuedAt: new Date(), lastAttemptAt: new Date(), lastErrorCode: null, leaseUntil: null }
    });
    return true;
  } catch (error) {
    discardCrawlQueue();
    const now = new Date();
    const attemptCount = Math.min(dispatch.attemptCount + 1, MAX_IMMEDIATE_DISPATCH_ATTEMPTS);
    await prisma.scanDispatch.update({
      where: { scanId },
      data: {
        state: 'PENDING',
        attemptCount,
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + retryDelay(attemptCount)),
        lastErrorCode: queueErrorCode(error),
        leaseUntil: null
      }
    }).catch(() => undefined);
    return false;
  }
}

/** Bounded recovery pass. It never waits for Redis between candidates. */
export async function dispatchDueScans(limit = 20): Promise<void> {
  const due = await prisma.scanDispatch.findMany({
    where: { state: 'PENDING', nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: 'asc' },
    take: limit,
    select: { scanId: true }
  });
  for (const intent of due) await dispatchScan(intent.scanId);
}

export function startScanDispatcher(intervalMs = 5_000): () => void {
  void dispatchDueScans().catch(() => undefined);
  const timer = setInterval(() => void dispatchDueScans().catch(() => undefined), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
