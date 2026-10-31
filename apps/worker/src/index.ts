import { QUEUES, checkScanTargetUrl, publicFailureReason } from '@a11y/shared';
import { prisma } from '@a11y/db';
import { createBrowserSession, ScanPageError, stableFingerprint } from '@a11y/scanner';
import { decideScanOutcome } from './scanOutcome.js';
import { computeDiffUpdates, groupStatusUpdates } from './diff.js';
import { dedupePageViolations } from './violationPersistence.js';
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
const bullmqPrefix = process.env.BULLMQ_PREFIX;
const queueOptions = bullmqPrefix ? { connection, prefix: bullmqPrefix } : { connection };

const EVIDENCE_DIR = path.resolve(
  process.env.EVIDENCE_DIR ?? path.join(process.cwd(), '../../evidence')
);

// Queues are created once, not per job run.
const analyzeQueue = new Queue(QUEUES.analyze, queueOptions);
const diffQueue = new Queue(QUEUES.diff, queueOptions);
const evidenceQueue = new Queue(QUEUES.evidence, queueOptions);


async function markScanFailed(scanId: string) {
  try {
    await prisma.scan.update({
      where: { id: scanId },
      data: { status: 'failed', coverage: 'FAILED', completedAt: new Date() }
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
      data: { status: 'crawling', coverage: 'PENDING' }
    });
    // Navigation, analysis, screenshot, and evidence must share one browser page.
    // The analyze lane performs that atomic observation rather than doing a stale pre-crawl.
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

async function persistPageViolations(
  page: { id: string; scanId: string; url: string; title: string | null },
  violations: import('@a11y/scanner').RawViolation[]
) {
  const rows = dedupePageViolations(page, violations, stableFingerprint);
  if (rows.length === 0) return;

  // All database writes are bounded by MAX_PAGE_VIOLATIONS. The transaction
  // atomically creates missing rules/findings/evidence and repairs legacy
  // finding rows that have no evidence without mutating existing captures.
  await prisma.$transaction(async (tx) => {
    await tx.rule.createMany({
      data: [...new Map(rows.map(({ violation }) => [violation.ruleId, violation])).values()].map((violation) => ({
        id: violation.ruleId,
        title: violation.message,
        wcagRefs: violation.wcagRefs || []
      })),
      skipDuplicates: true
    });
    const fingerprints = rows.map(({ row }) => row.fingerprint);
    const existing = await tx.finding.findMany({
      where: { scanId: page.scanId, fingerprint: { in: fingerprints } },
      select: { id: true, fingerprint: true, pageId: true }
    });
    for (const finding of existing) {
      if (finding.pageId !== page.id) {
        throw new Error(`Refusing cross-page evidence repair for finding ${finding.id}`);
      }
    }
    const existingFingerprints = new Set(existing.map((finding) => finding.fingerprint));
    const missingRows = rows.filter(({ row }) => !existingFingerprints.has(row.fingerprint));
    if (missingRows.length) {
      await tx.finding.createMany({ data: missingRows.map(({ row }) => row) });
    }
    const findings = await tx.finding.findMany({
      where: { scanId: page.scanId, fingerprint: { in: fingerprints } },
      include: { evidence: { select: { id: true } } }
    });
    if (findings.length !== rows.length) throw new Error(`Finding persistence was incomplete for page ${page.id}`);
    for (const finding of findings) {
      if (finding.pageId !== page.id) throw new Error(`Refusing cross-page evidence repair for finding ${finding.id}`);
    }
    const violationByFingerprint = new Map(rows.map(({ row, violation }) => [row.fingerprint, violation]));
    const missingEvidence = findings.filter((finding) => !finding.evidence).map((finding) => {
      const violation = violationByFingerprint.get(finding.fingerprint);
      if (!violation) throw new Error(`Missing source violation for finding ${finding.id}`);
      return {
        findingId: finding.id,
        screenshot: `pages/${page.id}.png`,
        domSnippet: violation.domSnippet ?? '',
        meta: {
          title: page.title,
          url: page.url,
          ...(violation.failureSummary && { failureSummary: violation.failureSummary }),
          ...(violation.help && { help: violation.help }),
          ...(violation.helpUrl && { helpUrl: violation.helpUrl }),
          targetIdentity: violation.targetIdentity
        }
      };
    });
    if (missingEvidence.length) await tx.evidence.createMany({ data: missingEvidence });
  });
}

function safeFailureReason(error: unknown): string {
  return publicFailureReason(error);
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
    const pagesDir = path.join(EVIDENCE_DIR, 'pages');
    await fs.mkdir(pagesDir, { recursive: true });
    let analyzed = 0;
    let failed = 0;
    let session: Awaited<ReturnType<typeof createBrowserSession>>;
    try {
      session = await createBrowserSession();
    } catch (error) {
      const reason = safeFailureReason(error);
      await prisma.page.updateMany({
        where: { scanId, outcome: 'PENDING' },
        data: { outcome: 'FAILED', error: reason, status: null }
      });
      await prisma.scan.update({
        where: { id: scanId },
        data: { status: 'failed', coverage: 'FAILED', completedAt: new Date() }
      });
      console.error(`Browser launch failed for scan ${scanId}: ${reason}`);
      return;
    }
    try {
      for (const page of scan.pages) {
        try {
          // Validate again at the actual browser-work boundary. This is an early
          // literal guard; the isolated Smokescreen proxy owns DNS/connect policy.
          if (!checkScanTargetUrl(page.url).ok) throw new ScanPageError('NETWORK_POLICY_REJECTED');
          const result = await session.scanPage(page.url);
          await fs.writeFile(path.join(pagesDir, `${page.id}.png`), result.screenshotBuffer);
          await prisma.page.update({
            where: { id: page.id },
            data: { title: result.title, status: result.responseStatus, outcome: 'ANALYZED', error: null }
          });
          await persistPageViolations({ ...page, title: result.title }, result.violations);
          analyzed += 1;
        } catch (error) {
          failed += 1;
          const status = error instanceof ScanPageError ? error.responseStatus : null;
          const reason = safeFailureReason(error);
          console.error(`Analyze failed for page ${page.id}: ${reason}`);
          await prisma.page.update({
            where: { id: page.id },
            data: { status, outcome: 'FAILED', error: reason }
          });
        }
      }
    } finally {
      await session.close();
    }

    const outcome = decideScanOutcome({ attempted: scan.pages.length, analyzed, failed });
    if (!outcome.shouldDiff) {
      await prisma.scan.update({
        where: { id: scanId },
        data: { status: outcome.scanStatus, coverage: outcome.coverage, completedAt: new Date() }
      });
      return;
    }
    await prisma.scan.update({ where: { id: scanId }, data: { coverage: outcome.coverage } });
    await diffQueue.add(
      QUEUES.diff,
      { scanId },
      { jobId: `${scanId}-diff`, removeOnComplete: true, removeOnFail: true }
    );
  } catch (e) {
    console.error(`Analyze processor failed for scan ${scanId}`);
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
        coverage: 'COMPLETE',
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
    const orphanedFindings = await prisma.finding.count({
      where: { scanId, evidence: { is: null } }
    });
    if (orphanedFindings !== 0) {
      throw new Error(`Refusing completion for scan ${scanId}: ${orphanedFindings} findings lack evidence`);
    }
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

const crawlWorker = new Worker(QUEUES.crawl, crawlProcessor, queueOptions);
const analyzeWorker = new Worker(QUEUES.analyze, analyzeProcessor, queueOptions);
const diffWorker = new Worker(QUEUES.diff, diffProcessor, queueOptions);
const evidenceWorker = new Worker(QUEUES.evidence, evidenceProcessor, queueOptions);

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
