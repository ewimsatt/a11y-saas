import { QUEUES } from '@a11y/shared';
import { prisma } from '@a11y/db';
import { crawlPage, analyzePage, stableFingerprint } from '@a11y/scanner';
import { computeDiffUpdates } from './diff.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';

console.log('Worker boot - BullMQ queues mode');
console.log('Queues:', Object.values(QUEUES).join(', '));

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
// BullMQ workers require maxRetriesPerRequest: null on their blocking connection.
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });

const EVIDENCE_DIR = path.resolve(
  process.env.EVIDENCE_DIR ?? path.join(process.cwd(), '../../evidence')
);

// Queues are created once, not per job run.
const analyzeQueue = new Queue(QUEUES.analyze, { connection });
const diffQueue = new Queue(QUEUES.diff, { connection });
const evidenceQueue = new Queue(QUEUES.evidence, { connection });

type Severity = 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
const SEVERITY_BY_IMPACT: Record<string, Severity> = {
  critical: 'CRITICAL',
  serious: 'SERIOUS',
  moderate: 'MODERATE',
  minor: 'MINOR'
};

async function markScanFailed(scanId: string) {
  try {
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'failed', completedAt: new Date() }
    });
  } catch (e) {
    console.error(`Failed to mark scan ${scanId} as failed:`, e);
  }
}

async function crawlProcessor(job: Job<{ scanId: string }>) {
  const { scanId } = job.data;
  try {
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'crawling' }
    });
    const scan = await prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      include: { pages: true }
    });
    const pagesDir = path.join(EVIDENCE_DIR, 'pages');
    await fs.mkdir(pagesDir, { recursive: true });
    for (const page of scan.pages) {
      try {
        const { title, screenshotBuffer } = await crawlPage(page.url);
        await fs.writeFile(path.join(pagesDir, `${page.id}.png`), screenshotBuffer);
        await prisma.page.update({
          where: { id: page.id },
          data: { title, status: 200 }
        });
      } catch (e) {
        console.error(`Crawl failed for page ${page.id}:`, e);
        await prisma.page.update({
          where: { id: page.id },
          data: { status: 500 }
        });
      }
    }
    await analyzeQueue.add(
      QUEUES.analyze,
      { scanId },
      { jobId: `${scanId}-analyze`, removeOnComplete: true, removeOnFail: true }
    );
  } catch (e) {
    console.error('Crawl processor error:', e);
    await markScanFailed(scanId);
    throw e;
  }
}

async function analyzeProcessor(job: Job<{ scanId: string }>) {
  const { scanId } = job.data;
  try {
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'analyzing' }
    });
    const scan = await prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      include: { pages: true }
    });
    for (const page of scan.pages) {
      if (page.status !== 200) continue; // crawl failed; nothing to analyze
      try {
        const violations = await analyzePage(page.url);
        for (const violation of violations) {
          const fingerprint = stableFingerprint({
            ruleId: violation.ruleId,
            pageUrl: page.url,
            selector: violation.selector,
            message: violation.message
          });
          const existing = await prisma.finding.findUnique({
            where: {
              scan_fingerprint: { scanId: page.scanId, fingerprint }
            }
          });
          if (existing) continue;
          const severity = SEVERITY_BY_IMPACT[violation.impact ?? ''] ?? 'MODERATE';
          await prisma.rule.upsert({
            where: { id: violation.ruleId },
            create: {
              id: violation.ruleId,
              title: violation.message,
              wcagRefs: violation.wcagRefs || []
            },
            update: {}
          });
          const finding = await prisma.finding.create({
            data: {
              scanId: page.scanId,
              pageId: page.id,
              ruleId: violation.ruleId,
              severity,
              fingerprint,
              selector: violation.selector,
              message: violation.message
            }
          });
          await prisma.evidence.create({
            data: {
              findingId: finding.id,
              screenshot: `pages/${page.id}.png`,
              domSnippet: '',
              meta: {
                title: page.title,
                url: page.url
              }
            }
          });
        }
      } catch (e) {
        console.error(`Analyze failed for page ${page.id}:`, e);
      }
    }
    await diffQueue.add(
      QUEUES.diff,
      { scanId },
      { jobId: `${scanId}-diff`, removeOnComplete: true, removeOnFail: true }
    );
  } catch (e) {
    console.error('Analyze processor error:', e);
    await markScanFailed(scanId);
    throw e;
  }
}

async function diffProcessor(job: Job<{ scanId: string }>) {
  const { scanId } = job.data;
  try {
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'diffing' }
    });
    const scan = await prisma.scan.findUniqueOrThrow({ where: { id: scanId } });
    const prevScan = await prisma.scan.findFirst({
      where: {
        projectId: scan.projectId,
        status: 'completed',
        completedAt: { lt: scan.startedAt ?? new Date() }
      },
      orderBy: { completedAt: 'desc' }
    });
    // Note: when there is no previous scan we still continue to the evidence
    // lane. (Previously this returned early, leaving first scans stuck in
    // 'diffing' forever.)
    if (prevScan) {
      const prevFindings = await prisma.finding.findMany({
        where: { scanId: prevScan.id },
        select: { id: true, fingerprint: true, status: true }
      });
      const newFindings = await prisma.finding.findMany({
        where: { scanId },
        select: { id: true, fingerprint: true }
      });
      const updates = computeDiffUpdates(prevFindings, newFindings);
      for (const update of updates) {
        await prisma.finding.update({
          where: { id: update.id },
          data: { status: update.status }
        });
      }
    }
    await evidenceQueue.add(
      QUEUES.evidence,
      { scanId },
      { jobId: `${scanId}-evidence`, removeOnComplete: true, removeOnFail: true }
    );
  } catch (e) {
    console.error('Diff processor error:', e);
    await markScanFailed(scanId);
    throw e;
  }
}

async function evidenceProcessor(job: Job<{ scanId: string }>) {
  const { scanId } = job.data;
  try {
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'completed', completedAt: new Date() }
    });
    console.log(`Scan ${scanId} completed.`);
  } catch (e) {
    console.error('Evidence processor error:', e);
    await markScanFailed(scanId);
    throw e;
  }
}

const crawlWorker = new Worker(QUEUES.crawl, crawlProcessor, { connection });
const analyzeWorker = new Worker(QUEUES.analyze, analyzeProcessor, { connection });
const diffWorker = new Worker(QUEUES.diff, diffProcessor, { connection });
const evidenceWorker = new Worker(QUEUES.evidence, evidenceProcessor, { connection });

async function shutdown() {
  console.log('Shutting down workers...');
  await Promise.all([
    crawlWorker.close(),
    analyzeWorker.close(),
    diffWorker.close(),
    evidenceWorker.close(),
    analyzeQueue.close(),
    diffQueue.close(),
    evidenceQueue.close()
  ]);
  await connection.quit();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
