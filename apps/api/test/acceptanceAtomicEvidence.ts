import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@a11y/db';

type Snapshot = {
  scanId: string;
  records: Array<{
    id: string;
    fingerprint: string;
    status: string;
    pageId: string;
    ruleId: string;
    selector: string | null;
    evidence: { id: string; screenshot: string; artifactDigest: string; domSnippet: string | null; meta: unknown } | null;
    page: { title: string | null; url: string };
  }>;
  deletedFindingId?: string;
};

const [mode, primaryId = '', encodedSnapshot = ''] = process.argv.slice(2);
if (!primaryId || ![
  'assert-faulted',
  'retry',
  'snapshot',
  'delete-one-evidence',
  'assert-legacy-repair',
  'assert-stable',
  'create-queued-scan'
].includes(mode)) {
  throw new Error('usage: acceptanceAtomicEvidence.ts <assert-faulted|retry|snapshot|delete-one-evidence|assert-legacy-repair|assert-stable|create-queued-scan> <scanId-or-projectId> [base64-snapshot-or-baseline-scan-id]');
}

function decodeSnapshot(value: string): Snapshot {
  return JSON.parse(Buffer.from(value, 'base64').toString('utf8')) as Snapshot;
}

async function snapshot(scanId: string): Promise<Snapshot> {
  const findings = await prisma.finding.findMany({
    where: { scanId },
    include: { evidence: true, page: { select: { title: true, url: true } } },
    orderBy: { fingerprint: 'asc' }
  });
  return {
    scanId,
    records: await Promise.all(findings.map(async (finding) => {
      const evidence = finding.evidence
        ? {
            id: finding.evidence.id,
            screenshot: finding.evidence.screenshot,
            artifactDigest: createHash('sha256').update(await fs.readFile(path.join(process.env.EVIDENCE_DIR ?? '/evidence', finding.evidence.screenshot))).digest('hex'),
            domSnippet: finding.evidence.domSnippet,
            meta: finding.evidence.meta
          }
        : null;
      return {
        id: finding.id,
        fingerprint: finding.fingerprint,
        status: finding.status,
        pageId: finding.pageId,
        ruleId: finding.ruleId,
        selector: finding.selector,
        evidence,
        page: finding.page
      };
    }))
  };
}


async function assertFaulted(encodedBaseline: string) {
  const expectedBaseline = decodeSnapshot(encodedBaseline);
  const [faulted, baseline] = await Promise.all([snapshot(primaryId), snapshot(expectedBaseline.scanId)]);
  if (faulted.records.length !== 0) {
    throw new Error(`faulted scan left durable findings: ${JSON.stringify(faulted.records)}`);
  }
  if (!baseline.records.length || baseline.records.some((record) => record.status !== 'OPEN' || !record.evidence)) {
    throw new Error(`faulted second scan changed or invalidated its completed OPEN baseline: ${JSON.stringify(baseline.records)}`);
  }
  if (JSON.stringify(baseline) !== JSON.stringify(expectedBaseline)) {
    throw new Error(`faulted second scan mutated its baseline diff inputs: ${JSON.stringify({ expectedBaseline, baseline })}`);
  }
  console.log(JSON.stringify({ phase: 'faulted-second-scan', faultedFindings: 0, baselineOpenFindings: baseline.records.length }));
}

async function retry() {
  const dispatch = await prisma.scanDispatch.findUniqueOrThrow({ where: { scanId: primaryId } });
  const generation = dispatch.generation + 1;
  await prisma.$transaction(async (tx) => {
    await tx.page.updateMany({
      where: { scanId: primaryId },
      data: { outcome: 'PENDING', status: null, error: null }
    });
    await tx.scan.update({
      where: { id: primaryId },
      data: { status: 'queued', coverage: 'PENDING', completedAt: null }
    });
    await tx.$executeRaw`
      UPDATE "ScanDispatch"
      SET "stage" = 'CRAWL', "generation" = ${generation}, "jobId" = ${`${primaryId}-crawl-${generation}`},
          "state" = 'PENDING', "dispatchAttemptCount" = 0, "attemptCount" = 0, "runAttemptCount" = 0,
          "claimToken" = NULL, "leaseUntil" = NULL, "runClaimToken" = NULL, "runLeaseUntil" = NULL,
          "completedAt" = NULL, "enqueuedAt" = NULL, "lastAttemptAt" = NULL, "lastErrorCode" = NULL,
          "nextAttemptAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "scanId" = ${primaryId}
    `;
  });
}

async function deleteOneEvidence() {
  const before = await snapshot(primaryId);
  const target = before.records.find((record) => record.evidence);
  if (!target?.evidence) throw new Error(`cannot create legacy orphan from scan ${primaryId}`);
  await prisma.evidence.delete({ where: { id: target.evidence.id } });
  const orphanCount = await prisma.finding.count({ where: { scanId: primaryId, evidence: { is: null } } });
  if (orphanCount !== 1) throw new Error(`legacy orphan setup was not exact: orphanCount=${orphanCount}`);
  console.log(JSON.stringify({ ...before, deletedFindingId: target.id }));
}

async function assertCompleteMapping(current: Snapshot, expected: Snapshot, requireEvidenceIds: boolean) {
  if (current.records.length !== expected.records.length || current.records.some((record) => !record.evidence)) {
    throw new Error(`expected exact finding/evidence counts with zero orphans: ${JSON.stringify(current.records)}`);
  }
  const ids = new Set(current.records.map((record) => record.id));
  const fingerprints = new Set(current.records.map((record) => record.fingerprint));
  if (ids.size !== current.records.length || fingerprints.size !== current.records.length) {
    throw new Error(`finding identities were not distinct: ${JSON.stringify(current.records)}`);
  }
  for (const expectedRecord of expected.records) {
    const record = current.records.find((candidate) => candidate.id === expectedRecord.id);
    if (!record?.evidence || !expectedRecord.evidence) throw new Error(`missing repaired finding/evidence ${expectedRecord.id}`);
    const preservesPriorEvidence = record.id !== expected.deletedFindingId;
    if (
      record.fingerprint !== expectedRecord.fingerprint ||
      record.status !== expectedRecord.status ||
      record.pageId !== expectedRecord.pageId ||
      record.ruleId !== expectedRecord.ruleId ||
      record.selector !== expectedRecord.selector ||
      !/^pages\/[A-Za-z0-9._-]+\.png$/.test(record.evidence.screenshot) ||
      record.evidence.domSnippet !== expectedRecord.evidence.domSnippet ||
      JSON.stringify(record.evidence.meta) !== JSON.stringify(expectedRecord.evidence.meta) ||
      JSON.stringify(record.page) !== JSON.stringify(expectedRecord.page)
    ) {
      throw new Error(`finding/evidence mapping changed for ${expectedRecord.id}: ${JSON.stringify({ expected: expectedRecord, actual: record })}`);
    }
    if (preservesPriorEvidence && (
      record.evidence.id !== expectedRecord.evidence.id ||
      record.evidence.screenshot !== expectedRecord.evidence.screenshot ||
      record.evidence.artifactDigest !== expectedRecord.evidence.artifactDigest
    )) {
      throw new Error(`retry changed durable evidence reference or bytes for ${record.id}`);
    }
    const meta = record.evidence.meta as { title?: unknown; url?: unknown; targetIdentity?: unknown } | null;
    if (meta?.title !== record.page.title || meta?.url !== record.page.url || typeof meta?.targetIdentity !== 'string') {
      throw new Error(`evidence meta does not match page/target identity for ${record.id}: ${JSON.stringify(record)}`);
    }
    let target: unknown;
    try { target = JSON.parse(meta.targetIdentity); } catch { throw new Error(`evidence target identity is not canonical JSON for ${record.id}`); }
    const targetSelector = Array.isArray(target) ? target.flat(Infinity).filter((part): part is string => typeof part === 'string').join(' >> ') : '';
    if (!record.selector || targetSelector !== record.selector || !record.evidence.domSnippet?.includes(record.selector.replace(/^\./, ''))) {
      throw new Error(`finding selector, target identity, and DOM evidence disagree for ${record.id}: ${JSON.stringify(record)}`);
    }
    if (requireEvidenceIds && record.evidence.id !== expectedRecord.evidence.id) {
      throw new Error(`idempotent requeue changed existing evidence ${record.id}`);
    }
    if (!requireEvidenceIds && record.id !== expected.deletedFindingId && record.evidence.id !== expectedRecord.evidence.id) {
      throw new Error(`legacy repair changed unrelated evidence ${record.id}`);
    }
  }
  const screenshots = await Promise.all(current.records.map(async (record) => {
    const evidence = record.evidence!;
    return fs.readFile(path.join(process.env.EVIDENCE_DIR ?? '/evidence', evidence.screenshot));
  }));
  if (screenshots.some((bytes) => bytes.byteLength < 8 || !bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))) {
    throw new Error('evidence screenshot is missing or not a PNG');
  }
  const selectors = current.records.map((record) => record.selector).sort();
  const dom = current.records.map((record) => record.evidence?.domSnippet).join(' ');
  if (!selectors.includes('.first-bad') || !selectors.includes('.second-bad') || !dom.includes('first-bad') || !dom.includes('second-bad')) {
    throw new Error(`exact node evidence mapping was not retained: ${JSON.stringify(current.records)}`);
  }
}

async function assertLegacyRepair(encoded: string, requireEvidenceIds: boolean) {
  const expected = decodeSnapshot(encoded);
  const current = await snapshot(primaryId);
  await assertCompleteMapping(current, expected, requireEvidenceIds);
  console.log(JSON.stringify({ phase: requireEvidenceIds ? 'idempotent-second-requeue' : 'legacy-orphan-repaired', findings: current.records.length, evidence: current.records.length }));
}

async function createQueuedScan(projectId: string) {
  const project = await prisma.project.findUniqueOrThrow({ where: { id: projectId } });
  const scan = await prisma.$transaction(async (tx) => {
    // Keep the selected fault fixture terminal and non-claimable until the
    // harness has installed its target-scoped trigger and calls retry().
    const created = await tx.scan.create({
      data: { projectId, status: 'failed', coverage: 'FAILED', startedAt: new Date() }
    });
    await tx.page.create({ data: { scanId: created.id, url: project.baseUrl } });
    await tx.scanDispatch.create({
      data: {
        scanId: created.id,
        jobId: `${created.id}-crawl-0`,
        stage: 'CRAWL',
        generation: 0,
        state: 'DEAD',
        lastErrorCode: 'ACCEPTANCE_FIXTURE_DORMANT'
      }
    });
    return created;
  });
  console.log(scan.id);
}

try {
  if (mode === 'assert-faulted') await assertFaulted(encodedSnapshot);
  if (mode === 'retry') await retry();
  if (mode === 'snapshot') console.log(JSON.stringify(await snapshot(primaryId)));
  if (mode === 'delete-one-evidence') await deleteOneEvidence();
  if (mode === 'assert-legacy-repair') await assertLegacyRepair(encodedSnapshot, false);
  if (mode === 'assert-stable') await assertLegacyRepair(encodedSnapshot, true);
  if (mode === 'create-queued-scan') await createQueuedScan(primaryId);
} finally {
  await prisma.$disconnect();
}
