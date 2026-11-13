import { QUEUES, checkScanTargetUrl, publicFailureReason } from '@a11y/shared';
import {
  advanceStageRun,
  claimNextStageDispatch,
  completeStageRun,
  ensureClaimedStageTransport,
  failStageRun,
  finalizeStageDispatchEnqueueFailure,
  finalizeStageDispatchEnqueueSuccess,
  findStaleEnqueuedStages,
  lockStageRun,
  prisma,
  reconcileExactEnqueuedTransport,
  releaseEnqueuedStageForReconcile,
  releaseStageRun,
  renewStageRun,
  terminalizeAbandonedStageRun,
  type StageRun
} from '@a11y/db';
import { createBrowserSession, ScanPageError, stableFingerprint } from '@a11y/scanner';
import { decideScanOutcome } from './scanOutcome.js';
import { deriveScanComparison, findComparableScan, persistCurrentRegressions, selectComparableScans } from './diff.js';
import { dedupePageViolations } from './violationPersistence.js';
import { DISPATCH_STAGES, stageJobId, stageJobOptions, type DispatchStage } from './stageDispatch.js';
import { claimStageRunAfterDispatchFinalize } from './stageRunClaim.js';
import { validateReadableEvidenceArtifacts } from './evidenceArtifacts.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import Redis from 'ioredis';
import { Worker, Queue } from 'bullmq';
import type { Job, Queue as QueueType } from 'bullmq';

const COMPARISON_SCAN_LIMIT = 25;
const RUN_LEASE_MS = 120_000;
const DISPATCH_LEASE_MS = 30_000;
const RECONCILE_AGE_MS = 30_000;
const EVIDENCE_DIR = path.resolve(process.env.EVIDENCE_DIR ?? path.join(process.cwd(), '../../evidence'));

type StageJobData = { scanId: string; stage: DispatchStage; generation: number };
type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

console.log('Worker boot - durable stage ledger mode');

const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
const bullmqPrefix = process.env.BULLMQ_PREFIX;
const queueOptions = bullmqPrefix ? { connection, prefix: bullmqPrefix } : { connection };
const crawlQueue = new Queue(QUEUES.crawl, queueOptions);
const analyzeQueue = new Queue(QUEUES.analyze, queueOptions);
const diffQueue = new Queue(QUEUES.diff, queueOptions);
const evidenceQueue = new Queue(QUEUES.evidence, queueOptions);

function queueForStage(stage: DispatchStage): QueueType<StageJobData> {
  switch (stage) {
    case 'CRAWL': return crawlQueue;
    case 'ANALYZE': return analyzeQueue;
    case 'DIFF': return diffQueue;
    case 'EVIDENCE': return evidenceQueue;
  }
}

function queueName(stage: DispatchStage): string {
  return queueForStage(stage).name;
}

function safeFailureReason(error: unknown): string {
  return publicFailureReason(error);
}

function failureCode(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'STAGE_RUN_FAILED';
}

function publicStageFailure(stage: DispatchStage): string {
  if (stage === 'CRAWL') return 'Execution unavailable before analysis';
  if (stage === 'ANALYZE') return 'Page analysis failed';
  return 'Scan finalization failed';
}

async function lockOwned(tx: TransactionClient, run: StageRun): Promise<boolean> {
  return lockStageRun(tx, run);
}

async function terminalizeOwnedRun(run: StageRun, error: unknown): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!await lockOwned(tx, run)) return;
    if (!await failStageRun(tx, run, failureCode(error))) return;
    // All terminal timestamps come from one PostgreSQL statement, never host time.
    await tx.$executeRaw`
      UPDATE "Scan" SET "status" = 'failed', "coverage" = 'FAILED', "completedAt" = CURRENT_TIMESTAMP
      WHERE id = ${run.scanId} AND "status" NOT IN ('completed', 'failed')
    `;
    await tx.page.updateMany({
      where: { scanId: run.scanId, outcome: 'PENDING' },
      data: { outcome: 'FAILED', error: publicStageFailure(run.stage), status: null }
    });
  });
}

async function persistPageViolations(
  tx: TransactionClient,
  run: StageRun,
  page: { id: string; scanId: string; url: string; title: string | null },
  violations: import('@a11y/scanner').RawViolation[],
  status: number | null,
  screenshot: string
): Promise<boolean> {
  if (!await lockOwned(tx, run)) return false;
  const rows = dedupePageViolations(page, violations, stableFingerprint);
  await tx.rule.createMany({
    data: [...new Map(rows.map(({ violation }) => [violation.ruleId, violation])).values()].map((violation) => ({
      id: violation.ruleId, title: violation.message, wcagRefs: violation.wcagRefs || []
    })),
    skipDuplicates: true
  });
  const fingerprints = rows.map(({ row }) => row.fingerprint);
  const existing = await tx.finding.findMany({
    where: { scanId: page.scanId, fingerprint: { in: fingerprints } },
    include: { evidence: { select: { id: true } } }
  });
  for (const finding of existing) {
    if (finding.pageId !== page.id) throw new Error(`Refusing cross-page evidence repair for finding ${finding.id}`);
  }
  const existingFingerprints = new Set(existing.map((finding) => finding.fingerprint));
  const missing = rows.filter(({ row }) => !existingFingerprints.has(row.fingerprint));
  if (missing.length) await tx.finding.createMany({ data: missing.map(({ row }) => row) });
  const findings = await tx.finding.findMany({
    where: { scanId: page.scanId, fingerprint: { in: fingerprints } },
    include: { evidence: { select: { id: true } } }
  });
  if (findings.length !== rows.length) throw new Error(`Finding persistence was incomplete for page ${page.id}`);
  const byFingerprint = new Map(rows.map(({ row, violation }) => [row.fingerprint, violation]));
  const missingEvidence = findings.filter((finding) => !finding.evidence).map((finding) => {
    const violation = byFingerprint.get(finding.fingerprint);
    if (!violation) throw new Error(`Missing source violation for finding ${finding.id}`);
    return {
      findingId: finding.id,
      screenshot,
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
  const pageTransition = await tx.page.updateMany({
    where: { id: page.id, scanId: run.scanId, outcome: 'PENDING' },
    data: { title: page.title, status, outcome: 'ANALYZED', error: null }
  });
  if (pageTransition.count !== 1) throw new Error(`Lost pending page CAS for ${page.id}`);
  return true;
}

async function crawlStage(run: StageRun): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!await lockOwned(tx, run)) return;
    await tx.scan.updateMany({ where: { id: run.scanId, status: { notIn: ['completed', 'failed'] } }, data: { status: 'crawling', coverage: 'PENDING' } });
    const advanced = await advanceStageRun(tx, run, 'ANALYZE', stageJobId(run.scanId, 'ANALYZE', run.generation + 1));
    if (!advanced) throw new Error('Lost crawl stage fence');
  });
}

async function analyzeStage(run: StageRun): Promise<void> {
  const scan = await prisma.$transaction(async (tx) => {
    if (!await lockOwned(tx, run)) return null;
    await tx.scan.updateMany({ where: { id: run.scanId, status: { notIn: ['completed', 'failed'] } }, data: { status: 'analyzing' } });
    return tx.scan.findUnique({ where: { id: run.scanId }, include: { pages: { where: { outcome: 'PENDING' } } } });
  });
  if (!scan) return;
  const pagesDir = path.join(EVIDENCE_DIR, 'pages');
  await fs.mkdir(pagesDir, { recursive: true });
  const session = await createBrowserSession();
  try {
    for (const page of scan.pages) {
      if (!await renewStageRun(prisma, run, RUN_LEASE_MS)) return;
      let tmp: string | null = null;
      try {
        if (!checkScanTargetUrl(page.url).ok) throw new ScanPageError('NETWORK_POLICY_REJECTED');
        const result = await session.scanPage(page.url);
        const relativeArtifact = `pages/${page.id}.${run.generation}.${run.runClaimToken}.png`;
        tmp = path.join(pagesDir, `${page.id}.${run.runClaimToken}.tmp`);
        const immutable = path.join(EVIDENCE_DIR, relativeArtifact);
        await fs.writeFile(tmp, result.screenshotBuffer);
        const persisted = await prisma.$transaction(async (tx) => {
          if (!await lockOwned(tx, run)) return false;
          // Artifact names bind bytes to one run. Existing durable evidence never
          // shares this pathname, so rollback can leave only an unreferenced file.
          await fs.rename(tmp!, immutable);
          tmp = null;
          return persistPageViolations(tx, run, { ...page, title: result.title }, result.violations, result.responseStatus, relativeArtifact);
        });
        if (!persisted) return;
      } catch (error) {
        if (tmp) await fs.rm(tmp, { force: true }).catch(() => undefined);
        // Only expected per-page scan failures become a page outcome. Database,
        // fence, and filesystem failures must reach the stage retry boundary.
        if (!(error instanceof ScanPageError)) throw error;
        const status = error instanceof ScanPageError ? error.responseStatus : null;
        const reason = safeFailureReason(error);
        const owned = await prisma.$transaction(async (tx) => {
          if (!await lockOwned(tx, run)) return false;
          const transition = await tx.page.updateMany({ where: { id: page.id, scanId: run.scanId, outcome: 'PENDING' }, data: { status, outcome: 'FAILED', error: reason } });
          if (transition.count !== 1) throw new Error(`Lost failed page CAS for ${page.id}`);
          return true;
        });
        if (!owned) return;
      }
    }
  } finally {
    await session.close();
  }

  await prisma.$transaction(async (tx) => {
    if (!await lockOwned(tx, run)) return;
    const counts = await tx.page.groupBy({ by: ['outcome'], where: { scanId: run.scanId }, _count: { _all: true } });
    const count = (outcome: 'PENDING' | 'ANALYZED' | 'FAILED') => counts.find((entry) => entry.outcome === outcome)?._count._all ?? 0;
    if (count('PENDING') !== 0) throw new Error('Refusing analyze finalization while pages remain pending');
    const outcome = decideScanOutcome({ attempted: count('PENDING') + count('ANALYZED') + count('FAILED'), analyzed: count('ANALYZED'), failed: count('FAILED') });
    if (!outcome.shouldDiff) {
      if (!await completeStageRun(tx, run)) return;
      await tx.$executeRaw`
        UPDATE "Scan" SET "status" = ${outcome.scanStatus}::"ScanStatus", "coverage" = ${outcome.coverage}::"ScanCoverage", "completedAt" = CURRENT_TIMESTAMP
        WHERE id = ${run.scanId} AND "status" NOT IN ('completed', 'failed')
      `;
      return;
    }
    await tx.scan.updateMany({ where: { id: run.scanId, status: { notIn: ['completed', 'failed'] } }, data: { coverage: outcome.coverage, status: 'diffing' } });
    if (!await advanceStageRun(tx, run, 'DIFF', stageJobId(run.scanId, 'DIFF', run.generation + 1))) throw new Error('Lost analyze stage fence');
  });
}

async function diffStage(run: StageRun): Promise<void> {
  const scan = await prisma.scan.findUnique({ where: { id: run.scanId }, include: { pages: true } });
  if (!scan) return;
  const candidates = await prisma.scan.findMany({
    where: { projectId: scan.projectId, status: 'completed', coverage: 'COMPLETE', completedAt: { lt: scan.startedAt ?? new Date() } },
    include: { pages: { select: { url: true, outcome: true } } }, orderBy: { completedAt: 'desc' }, take: COMPARISON_SCAN_LIMIT
  });
  const comparable = selectComparableScans(scan.pages.map((page) => page.url), candidates);
  const previous = findComparableScan(scan.pages.map((page) => page.url), comparable);
  await prisma.$transaction(async (tx) => {
    if (!await lockOwned(tx, run)) return;
    if (previous) {
      const findings = await tx.finding.findMany({ where: { scanId: { in: [run.scanId, ...comparable.map((candidate) => candidate.id)] } }, select: { id: true, scanId: true, fingerprint: true } });
      const byScan = new Map<string, Array<{ id: string; fingerprint: string }>>();
      for (const finding of findings) byScan.set(finding.scanId, [...(byScan.get(finding.scanId) ?? []), finding]);
      const comparison = deriveScanComparison(byScan.get(previous.id) ?? [], byScan.get(run.scanId) ?? [], comparable.filter((candidate) => candidate.id !== previous.id).map((candidate) => byScan.get(candidate.id) ?? []));
      await persistCurrentRegressions(tx, run.scanId, comparison.regressedIds);
    }
    await tx.scan.updateMany({ where: { id: run.scanId, status: { notIn: ['completed', 'failed'] } }, data: { status: 'evidence' } });
    if (!await advanceStageRun(tx, run, 'EVIDENCE', stageJobId(run.scanId, 'EVIDENCE', run.generation + 1))) throw new Error('Lost diff stage fence');
  });
}

async function evidenceStage(run: StageRun): Promise<void> {
  await prisma.$transaction(async (tx) => {
    if (!await lockOwned(tx, run)) return;
    const orphaned = await tx.finding.count({ where: { scanId: run.scanId, evidence: { is: null } } });
    if (orphaned) throw new Error(`Refusing completion with ${orphaned} orphan findings`);
    const analyzedPages = await tx.page.findMany({
      where: { scanId: run.scanId, outcome: 'ANALYZED' },
      select: { id: true, findings: { select: { evidence: { select: { screenshot: true } } } } }
    });
    await validateReadableEvidenceArtifacts(EVIDENCE_DIR, analyzedPages);
    if (!await completeStageRun(tx, run)) return;
    await tx.$executeRaw`
      UPDATE "Scan" SET "status" = 'completed', "coverage" = 'COMPLETE', "completedAt" = CURRENT_TIMESTAMP
      WHERE id = ${run.scanId} AND "status" NOT IN ('completed', 'failed')
    `;
  });
}

async function processStage(job: Job<StageJobData>, expected: DispatchStage, processor: (run: StageRun) => Promise<void>): Promise<void> {
  const { scanId, stage, generation } = job.data;
  if (stage !== expected || !Number.isInteger(generation)) return;
  const run = await claimStageRunAfterDispatchFinalize(prisma, { scanId, stage, generation, leaseMs: RUN_LEASE_MS });
  if (!run) return;
  try {
    await processor(run);
  } catch (error) {
    if (run.runAttemptCount >= 3) await terminalizeOwnedRun(run, error);
    else await releaseStageRun(prisma, run);
    throw error;
  }
}

const processors: Record<DispatchStage, (job: Job<StageJobData>) => Promise<void>> = {
  CRAWL: (job) => processStage(job, 'CRAWL', crawlStage),
  ANALYZE: (job) => processStage(job, 'ANALYZE', analyzeStage),
  DIFF: (job) => processStage(job, 'DIFF', diffStage),
  EVIDENCE: (job) => processStage(job, 'EVIDENCE', evidenceStage)
};

async function dispatchClaim(): Promise<boolean> {
  const dispatch = await claimNextStageDispatch(prisma, { leaseMs: DISPATCH_LEASE_MS });
  if (!dispatch) return false;
  const queue = queueForStage(dispatch.stage);
  try {
    await ensureClaimedStageTransport(queue, dispatch, queueName(dispatch.stage), {
      scanId: dispatch.scanId,
      stage: dispatch.stage,
      generation: dispatch.generation
    }, {
      ...stageJobOptions(dispatch.runAttemptCount)
    });
    return await finalizeStageDispatchEnqueueSuccess(prisma, dispatch);
  } catch (error) {
    await finalizeStageDispatchEnqueueFailure(prisma, { ...dispatch, errorCode: failureCode(error) });
    return false;
  }
}

let reconciling = false;
async function reconcileStageDispatches(): Promise<void> {
  if (reconciling) return;
  reconciling = true;
  try {
    for (const stale of await findStaleEnqueuedStages(prisma, RECONCILE_AGE_MS)) {
      const transport = await reconcileExactEnqueuedTransport(queueForStage(stale.stage), stale);
      if (transport === 'live') continue;
      if (stale.runAttemptCount >= 3) {
        await terminalizeAbandonedStageRun(prisma, stale, 'ABANDONED_RUN_EXHAUSTED');
        continue;
      }
      await releaseEnqueuedStageForReconcile(prisma, stale);
    }
    for (let index = 0; index < 20; index += 1) if (!await dispatchClaim()) break;
  } finally {
    reconciling = false;
  }
}

const workerSettings = { backoffStrategy: (attemptsMade: number, type?: string) => type === 'stage-run' ? (attemptsMade <= 1 ? 1_000 : 5_000) : 0 };
const crawlWorker = new Worker(QUEUES.crawl, processors.CRAWL, { ...queueOptions, settings: workerSettings });
const analyzeWorker = new Worker(QUEUES.analyze, processors.ANALYZE, { ...queueOptions, settings: workerSettings });
const diffWorker = new Worker(QUEUES.diff, processors.DIFF, { ...queueOptions, settings: workerSettings });
const evidenceWorker = new Worker(QUEUES.evidence, processors.EVIDENCE, { ...queueOptions, settings: workerSettings });
const reconciliationTimer = setInterval(() => void reconcileStageDispatches().catch((error) => console.error('stage reconciliation failed', error)), 5_000);
reconciliationTimer.unref();
void reconcileStageDispatches().catch((error) => console.error('initial stage reconciliation failed', error));

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(reconciliationTimer);
  await Promise.all([crawlWorker.close(), analyzeWorker.close(), diffWorker.close(), evidenceWorker.close(), crawlQueue.close(), analyzeQueue.close(), diffQueue.close(), evidenceQueue.close()]);
  await connection.quit();
  await prisma.$disconnect();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
