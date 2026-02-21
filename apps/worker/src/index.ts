import { QUEUES } from './queues.js';
import { prisma } from '@a11y/db';
import { crawlPage, analyzePage, stableFingerprint } from '@a11y/scanner';
import fs from 'node:fs/promises';
import path from 'node:path';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import type { Severity } from '@prisma/client';

console.log('Worker boot - BullMQ queues mode');
console.log('Queues:', Object.values(QUEUES).join(', '));

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl);

const crawlWorker = new Worker(QUEUES.crawl, crawlProcessor, { connection });
const analyzeWorker = new Worker(QUEUES.analyze, analyzeProcessor, { connection });
const diffWorker = new Worker(QUEUES.diff, diffProcessor, { connection });
const evidenceWorker = new Worker(QUEUES.evidence, evidenceProcessor, { connection });

async function crawlProcessor(job: Job<{ scanId: string }>) {
  try {
    const { scanId } = job.data;
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'crawling' }
    });
    const scan = await prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      include: { pages: true }
    });
    const evidenceDir = path.join(process.cwd(), '../../evidence/pages');
    await fs.mkdir(evidenceDir, { recursive: true });
    for (const page of scan.pages) {
      try {
        const { title, screenshotBuffer } = await crawlPage(page.url);
        const screenshotRel = `pages/${page.id}.png`;
        const screenshotPath = path.join(evidenceDir, screenshotRel);
        await fs.writeFile(screenshotPath, screenshotBuffer);
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
    const analyzeQueue = new Queue(QUEUES.analyze, { connection });
    await analyzeQueue.add(QUEUES.analyze, { scanId }, {
      jobId: `${scanId}-analyze`,
      removeOnComplete: true,
      removeOnFail: true
    });
  } catch (e) {
    console.error('Crawl processor error:', e);
    throw e;
  }
}

async function analyzeProcessor(job: Job<{ scanId: string }>) {
  try {
    const { scanId } = job.data;
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'analyzing' }
    });
    const scan = await prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      include: { pages: true }
    });
    for (const page of scan.pages) {
      try {
        const violations = await analyzePage(page.url);
        for (const violation of violations) {
          const fpInput = {
            ruleId: violation.ruleId,
            pageUrl: page.url,
            selector: violation.selector,
            message: violation.message
          };
          const fingerprint = stableFingerprint(fpInput);
          const existing = await prisma.finding.findUnique({
            where: {
              scanId_fingerprint: {
                scanId: page.scanId,
                fingerprint
              }
            }
          });
          if (existing) continue;
          const severity = violation.impact.toUpperCase() as Severity;
          await prisma.rule.upsert({
            where: { id: violation.ruleId },
            create: {
              id: violation.ruleId,
              title: violation.message,
              wcagRefs: violation.wcagRefs || [],
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
              message: violation.message,
            }
          });
          const screenshotRel = `pages/${page.id}.png`;
          await prisma.evidence.create({
            data: {
              findingId: finding.id,
              screenshot: screenshotRel,
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
    const diffQueue = new Queue(QUEUES.diff, { connection });
    await diffQueue.add(QUEUES.diff, { scanId }, {
      jobId: `${scanId}-diff`,
      removeOnComplete: true,
      removeOnFail: true
    });
  } catch (e) {
    console.error('Analyze processor error:', e);
    throw e;
  }
}

async function diffProcessor(job: Job<{ scanId: string }>) {
  try {
    const { scanId } = job.data;
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'diffing' }
    });
    const scan = await prisma.scan.findUniqueOrThrow({
      where: { id: scanId },
      include: { project: true }
    });
    const prevScan = await prisma.scan.findFirst({
      where: {
        projectId: scan!.project!.id,
        status: 'completed',
        completedAt: { lt: scan.startedAt }
      },
      orderBy: { completedAt: 'desc' }
    });
    if (!prevScan) return;
    const prevFindings = await prisma.finding.findMany({
      where: { scanId: prevScan.id },
      select: { id: true, fingerprint: true, status: true }
    });
    const newFindings = await prisma.finding.findMany({
      where: { scanId },
      select: { id: true, fingerprint: true }
    });
    const prevFpStatus = new Map(prevFindings.map(f => [f.fingerprint, { id: f.id, status: f.status }]));
    const newFpSet = new Set(newFindings.map(f => f.fingerprint));
    for (const nf of newFindings) {
      const prev = prevFpStatus.get(nf.fingerprint);
      if (prev && prev.status === 'FIXED') {
        await prisma.finding.update({
          where: { id: nf.id },
          data: { status: 'REGRESSED' }
        });
      }
    }
    for (const pf of prevFindings) {
      if (pf.status === 'OPEN' && !newFpSet.has(pf.fingerprint)) {
        await prisma.finding.update({
          where: { id: pf.id },
          data: { status: 'FIXED' }
        });
      }
    }
    const evidenceQueue = new Queue(QUEUES.evidence, { connection });
    await evidenceQueue.add(QUEUES.evidence, { scanId }, {
      jobId: `${scanId}-evidence`,
      removeOnComplete: true,
      removeOnFail: true
    });
  } catch (e) {
    console.error('Diff processor error:', e);
    throw e;
  }
}

async function evidenceProcessor(job: Job<{ scanId: string }>) {
  try {
    const { scanId } = job.data;
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'completed', completedAt: new Date() }
    });
    console.log(`Scan ${scanId} completed.`);
  } catch (e) {
    console.error('Evidence processor error:', e);
    throw e;
  }
}

process.on('SIGTERM', async () => {
  console.log('Shutting down workers...');
  await Promise.all([
    crawlWorker.close(),
    analyzeWorker.close(),
    diffWorker.close(),
    evidenceWorker.close()
  ]);
  connection.quit();
  process.exit(0);
});