import path from 'node:path';
import { prisma } from '@a11y/db';
import { publicFailureReason } from '@a11y/shared';
import { EVIDENCE_DIR } from '../paths';
import type { Coverage } from './coverage';
import { processScreenshotFile } from './image';
import {
  deriveReportFinality,
  findComparablePriorScan,
  reportCoverageLabel,
  selectScreenshotPageIds
} from './scope';
import { countBySeverity, countByStatus, type FindingStatus, type Severity } from './stats';
import { groupFindings, isActionableFinding, type FindingForQuality, type FindingGroup } from './quality';

const MAX_SCREENSHOT_PAGES = 2;
export const COMPARISON_SCAN_LIMIT = 25;

type Image = { base64: string; mime: 'image/png' | 'image/jpeg' };

export type ReportFinding = FindingForQuality;
export type ReportPage = {
  id: string;
  url: string;
  title: string | null;
  crawled: boolean;
  outcome: 'PENDING' | 'ANALYZED' | 'FAILED';
  responseStatus: number | null;
  error: string | null;
  findingCount: number;
  screenshot: Image | null;
};
export type ReportData = {
  project: { name: string; baseUrl: string };
  scan: {
    id: string;
    status: string;
    coverage: Coverage;
    startedAt: Date | null;
    completedAt: Date | null;
    isFinal: boolean;
  };
  generatedAt: Date;
  coverage: {
    requestedPages: number;
    analyzedPages: number;
    failedPages: number;
    pendingPages: number;
    label: string;
  };
  totals: {
    findings: number;
    actionableFindings: number;
    uniqueRules: number;
    affectedPages: number;
    bySeverity: Record<Severity, number>;
    byStatus: Record<FindingStatus, number>;
  };
  findingGroups: FindingGroup[];
  actionableGroups: FindingGroup[];
  findings: ReportFinding[];
  pages: ReportPage[];
  comparison: { prevScanId: string; prevCompletedAt: Date | null; prevTotal: number; regressed: number } | null;
  comparisonNote: string;
};

async function loadScreenshot(pageId: string): Promise<Image | null> {
  for (const extension of ['png', 'jpg', 'jpeg']) {
    const image = await processScreenshotFile(path.join(EVIDENCE_DIR, 'pages', `${pageId}.${extension}`));
    if (image) return image;
  }
  return null;
}

export async function buildReportData(
  scanId: string,
  options: { includeScreenshots?: boolean } = {}
): Promise<ReportData | null> {
  const scan = await prisma.scan.findUnique({
    where: { id: scanId },
    include: { project: true, pages: true }
  });
  if (!scan) return null;

  const findings = await prisma.finding.findMany({
    where: { scanId },
    include: { rule: true, page: true, evidence: true },
    orderBy: [{ severity: 'desc' }, { ruleId: 'asc' }, { id: 'asc' }]
  });
  const reportFindings: ReportFinding[] = findings.map((finding) => {
    const meta = (finding.evidence?.meta ?? {}) as { failureSummary?: string; targetIdentity?: unknown };
    return {
      id: finding.id,
      pageId: finding.pageId,
      fingerprint: finding.fingerprint,
      targetIdentity: meta.targetIdentity ?? null,
      evidenceMeta: finding.evidence?.meta ?? null,
      severity: finding.severity,
      status: finding.status,
      ruleId: finding.ruleId,
      message: finding.message,
      selector: finding.selector,
      pageUrl: finding.page.url,
      domSnippet: finding.evidence?.domSnippet ?? null,
      failureSummary: meta.failureSummary ?? null,
      wcagRefs: finding.rule?.wcagRefs ?? []
    };
  });

  const findingCountByPage = new Map<string, number>();
  for (const finding of findings) {
    findingCountByPage.set(finding.pageId, (findingCountByPage.get(finding.pageId) ?? 0) + 1);
  }
  const pageFacts = scan.pages.map((page) => ({
      id: page.id,
      url: page.url,
      title: page.title,
      crawled: page.outcome === 'ANALYZED',
      outcome: page.outcome,
      responseStatus: page.status,
      error: page.error ? publicFailureReason(page.error) : null,
      findingCount: findingCountByPage.get(page.id) ?? 0,
      screenshot: null as Image | null
    }));
  const screenshotCandidates = options.includeScreenshots
    ? selectScreenshotPageIds(pageFacts, pageFacts.length)
    : [];
  const screenshotByPage = new Map<string, Image>();
  for (const pageId of screenshotCandidates) {
    if (screenshotByPage.size >= MAX_SCREENSHOT_PAGES) break;
    const screenshot = await loadScreenshot(pageId);
    if (screenshot) screenshotByPage.set(pageId, screenshot);
  }
  const pages = pageFacts.map((page) => ({
    ...page,
    screenshot: screenshotByPage.get(page.id) ?? null
  }));

  const isFinal = deriveReportFinality(scan.status, scan.coverage, scan.pages);
  let comparison: ReportData['comparison'] = null;
  let comparisonNote = 'Comparison omitted because this report is provisional.';
  if (isFinal) {
    const candidates = await prisma.scan.findMany({
      where: {
        id: { not: scan.id },
        projectId: scan.projectId,
        status: 'completed',
        coverage: 'COMPLETE',
        completedAt: scan.startedAt
          ? { lt: scan.startedAt }
          : scan.completedAt
            ? { lt: scan.completedAt }
            : { not: null }
      },
      include: { pages: { select: { id: true, url: true, outcome: true } } },
      orderBy: { completedAt: 'desc' },
      take: COMPARISON_SCAN_LIMIT
    });
    const previous = findComparablePriorScan(
      scan.pages.map((page) => page.url),
      candidates.filter((candidate) =>
        deriveReportFinality(candidate.status, candidate.coverage, candidate.pages)
      )
    );
    comparisonNote = `Comparison searched the ${COMPARISON_SCAN_LIMIT} most recent earlier completed COMPLETE scans and requires an identical normalized requested URL set.`;
    if (previous) {
      const [prevTotal, regressed] = await Promise.all([
        prisma.finding.count({ where: { scanId: previous.id } }),
        prisma.finding.count({ where: { scanId, status: 'REGRESSED' } })
      ]);
      comparison = { prevScanId: previous.id, prevCompletedAt: previous.completedAt, prevTotal, regressed };
    } else {
      comparisonNote = `Comparison omitted: no identical normalized requested URL set was found among the ${COMPARISON_SCAN_LIMIT} most recent earlier completed COMPLETE scans.`;
    }
  }

  const analyzedPages = pages.filter((page) => page.outcome === 'ANALYZED').length;
  const failedPages = pages.filter((page) => page.outcome === 'FAILED').length;
  const pendingPages = pages.filter((page) => page.outcome === 'PENDING').length;
  const findingGroups = groupFindings(reportFindings);
  return {
    project: { name: scan.project.name, baseUrl: scan.project.baseUrl },
    scan: {
      id: scan.id,
      status: scan.status,
      coverage: scan.coverage,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt,
      isFinal
    },
    generatedAt: new Date(),
    coverage: {
      requestedPages: pages.length,
      analyzedPages,
      failedPages,
      pendingPages,
      label: reportCoverageLabel(isFinal, scan.coverage)
    },
    totals: {
      findings: reportFindings.length,
      actionableFindings: reportFindings.filter(isActionableFinding).length,
      uniqueRules: new Set(reportFindings.map((finding) => finding.ruleId)).size,
      affectedPages: new Set(reportFindings.map((finding) => finding.pageUrl)).size,
      bySeverity: countBySeverity(reportFindings),
      byStatus: countByStatus(reportFindings)
    },
    findingGroups,
    actionableGroups: findingGroups.filter((group) => group.actionableOccurrences > 0),
    findings: reportFindings,
    pages,
    comparison,
    comparisonNote
  };
}
