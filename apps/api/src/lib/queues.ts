import Redis from 'ioredis';
import { Queue } from 'bullmq';
import { QUEUES } from '@a11y/shared';

// Single shared connection + queue instance for the API process.
// (Previously a new Redis connection and Queue were created per request
// and never closed, leaking connections on every scan run.)
let connection: Redis | undefined;
let crawlQueue: Queue | undefined;

function queueOptions(activeConnection: Redis) {
  const prefix = process.env.BULLMQ_PREFIX;
  return prefix ? { connection: activeConnection, prefix } : { connection: activeConnection };
}

export function getCrawlQueue(): Queue {
  if (!crawlQueue) {
    connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 1_000,
      retryStrategy: (attempt) => (attempt === 1 ? 100 : null)
    });
    crawlQueue = new Queue(QUEUES.crawl, queueOptions(connection));
  }
  return crawlQueue;
}

/**
 * Retire a queue that failed to reach Redis so the next due dispatch creates
 * a fresh bounded connection in this API process.
 */
export function discardCrawlQueue(): void {
  const staleQueue = crawlQueue;
  const staleConnection = connection;
  crawlQueue = undefined;
  connection = undefined;
  void staleQueue?.close().catch(() => undefined);
  staleConnection?.disconnect(false);
}

export async function closeQueues(): Promise<void> {
  const activeQueue = crawlQueue;
  const activeConnection = connection;
  crawlQueue = undefined;
  connection = undefined;
  await activeQueue?.close();
  await activeConnection?.quit();
}
