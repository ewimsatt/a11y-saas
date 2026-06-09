import { QUEUES } from '@a11y/shared';
import { prisma } from '@a11y/db';
import { createBrowserSession, stableFingerprint } from '@a11y/scanner';
import type { RawViolation } from '@a11y/scanner';
import { computeDiffUpdates, groupStatusUpdates } from './diff.js';
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
    let crawledCount = 0;
    const session = await createBrowserSession();
    try {
      for (const page of scan.pages) {
        try {
          const { title, screenshotBuffer } = await session.crawlPage(page.url);
          await fs.writeFile(path.join(pagesDir, `${page.id}.png`), screenshotBuffer);
          await prisma.page.update({
            where: { id: page.id },
            data: { title, status: 200 }
          });
          crawledCount += 1;
        } catch (e) {
          console.error(`Crawl failed for page ${page.id}:`, e);
          await prisma.page.update({
            where: { id: page.id },
            data: { status: 500 }
          });
        }
      }
    } finally {
      await session.close();
    }
    if (scan.pages.length > 0 && crawledCount === 0) {
      console.error(`All ${scan.pages.length} pages failed to crawl for scan ${scanId}`);
      await markScanFailed(scanId);
      return;
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

type FindingRow = {
  scanId: string;
  pageId: string;
  ruleId: string;
  severity: Severity;
  fingerprint: string;
  selector: string | undefined;
  message: string;
};

async function persistPageViolations(
  page: { id: string; scanId: string; url: string; title: string | null },
  violations: RawViolation[]
) {
  // Upsert each distinct rule once, then bulk-insert findings and evidence.
  const ruleById = new Map(violations.map((v) => [v.ruleId, v]));
  for (const [ruleId, v] of ruleById) {
    await prisma.rule.upsert({
      where: { id: ruleId },
      create: { id: ruleId, title: v.message, wcagRefs: v.wcagRefs || [] },
      update: {}
    });
  }

  const rowsByFingerprint = new Map<string, { row: FindingRow; violation: RawViolation }>();
  for (const violation of violations) {
    const fingerprint = stableFingerprint({
      ruleId: violation.ruleId,
      pageUrl: page.url,
      selector: violation.selector,
      message: violation.message
    });
    if (rowsByFingerprint.has(fingerprint)) continue;
    rowsByFingerprint.set(fingerprint, {
      violation,
      row: {
        scanId: page.scanId,
        pageId: page.id,
        ruleId: violation.ruleId,
        severity: SEVERITY_BY_IMPACT[violation.impact ?? ''] ?? 'MODERATE',
        fingerprint,
        selector: violation.selector,
        message: violation.message
      }
    });
  }
  if (rowsByFingerprint.size === 0) return;

  // skipDuplicates makes re-runs idempotent: findings from a previous attempt
  // are left untouched and get no duplicate evidence rows.
  const created = await prisma.finding.createManyAndReturn({
    data: [...rowsByFingerprint.values()].map((e) => e.row),
    skipDuplicates: true,
    select: { id: true, fingerprint: true }
  });
  if (created.length === 0) return;

  await prisma.evidence.createMany({
    data: created.map((finding) => {
      const violation = rowsByFingerprint.get(finding.fingerprint)?.violation;
      return {
        findingId: finding.id,
        screenshot: `pages/${page.id}.png`,
        domSnippet: violation?.domSnippet ?? '',
        meta: {
          title: page.title,
          url: page.url,
          ...(violation?.failureSummary && { failureSummary: violation.failureSummary })
        }
      };
    }),
    skipDuplicates: true
  });
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
    const session = await createBrowserSession();
    try {
      for (const page of scan.pages) {
        if (page.status !== 200) continue; // crawl failed; nothing to analyze
        try {
          const violations = await session.analyzePage(page.url);
          await persistPageViolations(page, violations);
        } catch (e) {
          console.error(`Analyze failed for page ${page.id}:`, e);
        }
      }
    } finally {
      await session.close();
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
      const { fixedIds, regressedIds } = groupStatusUpdates(
        computeDiffUpdates(prevFindings, newFindings)
      );
      await prisma.$transaction([
        ...(fixedIds.length
          ? [prisma.finding.updateMany({ where: { id: { in: fixedIds } }, data: { status: 'FIXED' } })]
          : []),
        ...(regressedIds.length
          ? [prisma.finding.updateMany({ where: { id: { in: regressedIds } }, data: { status: 'REGRESSED' } })]
          : [])
      ]);
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

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
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
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
