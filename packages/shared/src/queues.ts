export const QUEUES = {
  crawl: 'crawl',
  analyze: 'analyze',
  diff: 'diff',
  evidence: 'evidence'
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];
