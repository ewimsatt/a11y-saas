import fs from 'node:fs/promises';
import path from 'node:path';
import { prisma } from '@a11y/db';
import { publicFailureReason } from '@a11y/shared';
import { EVIDENCE_DIR } from '../paths';
import { reportAssessment, type Coverage } from './coverage';
import {
  countBySeverity,
  countByStatus,
  computeScore,
  summarizeRules,
  SEVERITY_ORDER,
  type Severity,
  type FindingStatus,
  type RuleSummary
} from './stats';

// Caps keep PDF size and deck length sane for large scans.
const MAX_SCREENSHOT_PAGES = 8;
const MAX_FINDINGS_PER_SEVERITY = 25;
const MAX_SNIPPET_LENGTH = 400;

export type ReportFinding = {
  id: string;
  severity: Severity;
  status: FindingStatus;
  ruleId: string;
  message: string;
  selector: string | null;
  pageUrl: string;
  domSnippet: string | null;
  failureSummary: string | null;
};

export type ReportPage = {
  id: string;
  url: string;
  title: string | null;
  crawled: boolean;
  outcome: 'PENDING' | 'ANALYZED' | 'FAILED';
  responseStatus: number | null;
  error: string | null;
  findingCount: number;
  screenshotBase64: string | null;
};

export type ReportData = {
  project: { name: string; baseUrl: string };
  scan: { id: string; status: string; coverage: Coverage; startedAt: Date | null; completedAt: Date | null };
  generatedAt: Date;
  coverage: { requestedPages: number; analyzedPages: number; failedPages: number; label: string };
  totals: {
    findings: number;
    bySeverity: Record<Severity, number>;
    byStatus: Record<FindingStatus, number>;
  };
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  topRules: RuleSummary[];
  findingsBySeverity: Array<{ severity: Severity; findings: ReportFinding[]; omitted: number }>;
  pages: ReportPage[];
  comparison: {
    prevScanId: string;
    prevCompletedAt: Date | null;
    prevTotal: number;
    fixed: number;
    regressed: number;
    prevCoverage: Coverage;
  } | null;
};

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

async function loadScreenshot(pageId: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(path.join(EVIDENCE_DIR, 'pages', `${pageId}.png`));
    return buf.toString('base64');
  } catch {
    return null;
  }
}

export async function buildReportData(scanId: string): Promise<ReportData | null> {
  const scan = await prisma.scan.findUnique({
    where: { id: scanId },
    include: { project: true, pages: true }
  });
  if (!scan) return null;

  const findings = await prisma.finding.findMany({
    where: { scanId },
    include: { rule: true, page: true, evidence: true },
    orderBy: [{ severity: 'desc' }, { ruleId: 'asc' }]
  });

  const reportFindings: ReportFinding[] = findings.map((f) => {
    const meta = (f.evidence?.meta ?? {}) as { failureSummary?: string };
    return {
      id: f.id,
      severity: f.severity,
      status: f.status,
      ruleId: f.ruleId,
      message: f.message,
      selector: f.selector,
      pageUrl: f.page.url,
      domSnippet: f.evidence?.domSnippet ? truncate(f.evidence.domSnippet, MAX_SNIPPET_LENGTH) : null,
      failureSummary: meta.failureSummary ? truncate(meta.failureSummary, MAX_SNIPPET_LENGTH) : null
    };
  });

  const findingsBySeverity = SEVERITY_ORDER.map((severity) => {
    const all = reportFindings.filter((f) => f.severity === severity);
    return {
      severity,
      findings: all.slice(0, MAX_FINDINGS_PER_SEVERITY),
      omitted: Math.max(0, all.length - MAX_FINDINGS_PER_SEVERITY)
    };
  }).filter((group) => group.findings.length > 0);

  const findingCountByPage = new Map<string, number>();
  for (const f of findings) {
    findingCountByPage.set(f.pageId, (findingCountByPage.get(f.pageId) ?? 0) + 1);
  }
  const pages: ReportPage[] = await Promise.all(
    scan.pages.map(async (p, index) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      crawled: p.outcome === 'ANALYZED',
      outcome: p.outcome,
      responseStatus: p.status,
      error: p.error ? publicFailureReason(p.error) : null,
      findingCount: findingCountByPage.get(p.id) ?? 0,
      screenshotBase64: index < MAX_SCREENSHOT_PAGES ? await loadScreenshot(p.id) : null
    }))
  );

  let comparison: ReportData['comparison'] = null;
  if (scan.coverage === 'COMPLETE') {
    const prevScan = await prisma.scan.findFirst({
      where: {
        projectId: scan.projectId,
        status: 'completed',
        coverage: 'COMPLETE',
        completedAt: { lt: scan.startedAt ?? new Date() }
      },
      orderBy: { completedAt: 'desc' }
    });
    if (prevScan) {
      const [prevTotal, fixed, regressed] = await Promise.all([
        prisma.finding.count({ where: { scanId: prevScan.id } }),
        prisma.finding.count({ where: { scanId: prevScan.id, status: 'FIXED' } }),
        prisma.finding.count({ where: { scanId, status: 'REGRESSED' } })
      ]);
      comparison = {
        prevScanId: prevScan.id,
        prevCompletedAt: prevScan.completedAt,
        prevTotal,
        fixed,
        regressed,
        prevCoverage: 'COMPLETE'
      };
    }
  }

  const rawScore = computeScore(reportFindings);
  const assessment = reportAssessment(scan.coverage, rawScore);
  const analyzedPages = scan.pages.filter((page) => page.outcome === 'ANALYZED').length;
  const failedPages = scan.pages.filter((page) => page.outcome === 'FAILED').length;

  return {
    project: { name: scan.project.name, baseUrl: scan.project.baseUrl },
    scan: {
      id: scan.id,
      status: scan.status,
      coverage: scan.coverage,
      startedAt: scan.startedAt,
      completedAt: scan.completedAt
    },
    generatedAt: new Date(),
    coverage: { requestedPages: scan.pages.length, analyzedPages, failedPages, label: assessment.label },
    totals: {
      findings: findings.length,
      bySeverity: countBySeverity(reportFindings),
      byStatus: countByStatus(reportFindings)
    },
    score: assessment.score,
    grade: assessment.grade,
    topRules: summarizeRules(findings).slice(0, 10),
    findingsBySeverity,
    pages,
    comparison
  };
}
