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
    connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
    crawlQueue = new Queue(QUEUES.crawl, queueOptions(connection));
  }
  return crawlQueue;
}

export async function closeQueues(): Promise<void> {
  await crawlQueue?.close();
  await connection?.quit();
  crawlQueue = undefined;
  connection = undefined;
}
