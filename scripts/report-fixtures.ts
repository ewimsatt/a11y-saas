import os from 'node:os';
import path from 'node:path';
import type { ReportData } from '../apps/api/src/lib/report/data';
import {
  groupFindings,
  type FindingForQuality
} from '../apps/api/src/lib/report/quality';

export const FIXTURE_KINDS = [
  'zero',
  'incomplete',
  'long',
  'large162',
  'mixed',
  'fixed-only',
  'waived-only'
] as const;

export type FixtureKind = (typeof FIXTURE_KINDS)[number];

export function fixtureOutputDirectory(
  environment: { REPORT_FIXTURE_DIR?: string } = process.env
): string {
  return environment.REPORT_FIXTURE_DIR ?? path.join(os.tmpdir(), 'a11y-report-fixtures');
}

function statusFor(kind: FixtureKind, index: number): FindingForQuality['status'] {
  if (kind === 'fixed-only') return 'FIXED';
  if (kind === 'waived-only') return 'WAIVED';
  if (kind === 'mixed' || kind === 'large162') {
    return (['OPEN', 'REGRESSED', 'FIXED', 'WAIVED'] as const)[index % 4]!;
  }
  return index % 7 === 0 ? 'WAIVED' : index % 5 === 0 ? 'FIXED' : 'OPEN';
}

function fixtureFinding(
  index: number,
  kind: FixtureKind,
  pageCount: number
): FindingForQuality {
  const pageIndex = index % pageCount;
  const ruleId = index % 11 === 0 ? 'color-contrast' : `rule-${index % 11}`;
  const foreground = (['#c4853e', '#8a8a8a', '#ffffff'] as const)[index % 3]!;
  const background = foreground === '#ffffff' ? '#c4853e' : '#ffffff';
  return {
    id: `fixture-finding-${index}`,
    pageId: `fixture-page-${pageIndex}`,
    fingerprint: `fixture-fingerprint-${index}`,
    targetIdentity: { selector: `.fixture-${index}`, source: 'synthetic-fixture' },
    evidenceMeta: {
      targetIdentity: { selector: `.fixture-${index}`, source: 'synthetic-fixture' },
      title: `Synthetic page ${pageIndex}`,
      url: `https://fixture.example.test/page/${pageIndex}`
    },
    severity: (['CRITICAL', 'SERIOUS', 'MODERATE', 'MINOR'] as const)[index % 4]!,
    status: statusFor(kind, index),
    ruleId,
    message: `Synthetic observed ${ruleId} result ${index}`,
    selector: `.fixture-${index}`,
    pageUrl: `https://fixture.example.test/page/${pageIndex}`,
    domSnippet: `<p data-fixture="${index}">synthetic ${index}</p>`,
    failureSummary:
      ruleId === 'color-contrast'
        ? `Element has insufficient color contrast of 3.1 (foreground color: ${foreground}, background color: ${background}, font size: 12px). Expected contrast ratio of 4.5:1`
        : `Synthetic observed failure detail ${index}`,
    wcagRefs: ruleId === 'color-contrast' ? ['wcag143'] : ['wcag111']
  };
}

function findingCount(kind: FixtureKind): number {
  if (kind === 'zero') return 0;
  if (kind === 'large162') return 162;
  if (kind === 'long') return 15;
  if (kind === 'fixed-only' || kind === 'waived-only') return 8;
  return 12;
}

export function buildFixtureData(kind: FixtureKind): ReportData {
  const pageCount = 20;
  const findings = Array.from({ length: findingCount(kind) }, (_, index) =>
    fixtureFinding(index, kind, pageCount)
  );
  if (kind === 'long' && findings[0]) {
    findings[0].message = `Synthetic long field ${'x'.repeat(1000)}`;
    findings[0].selector = `#synthetic-${'selector-'.repeat(100)}`;
    findings[0].pageUrl = `https://fixture.example.test/${'segment/'.repeat(80)}`;
  }

  const groups = groupFindings(findings);
  const incomplete = kind === 'incomplete';
  const pages: ReportData['pages'] = Array.from({ length: pageCount }, (_, index) => ({
    id: `fixture-page-${index}`,
    url: `https://fixture.example.test/page/${index}`,
    title: `Synthetic page ${index}`,
    crawled: index < (incomplete ? 18 : pageCount),
    outcome:
      index < (incomplete ? 18 : pageCount)
        ? 'ANALYZED'
        : index === 18
          ? 'FAILED'
          : 'PENDING',
    responseStatus: index === 18 && incomplete ? 503 : 200,
    error: index === 18 && incomplete ? 'Synthetic fixture failure' : null,
    findingCount: findings.filter((finding) => finding.pageId === `fixture-page-${index}`).length,
    screenshot: null
  }));

  return {
    project: {
      name:
        kind === 'long'
          ? `Synthetic long fixture ${'project-name-'.repeat(20)}`
          : `Synthetic ${kind} fixture`,
      baseUrl: 'https://fixture.example.test'
    },
    scan: {
      id: `fixture-${kind}`,
      status: incomplete ? 'diffing' : 'completed',
      coverage: incomplete ? 'PARTIAL' : 'COMPLETE',
      startedAt: new Date('2026-10-21T00:00:00Z'),
      completedAt: new Date('2026-10-21T00:05:00Z'),
      isFinal: !incomplete
    },
    generatedAt: new Date('2026-10-21T00:10:00Z'),
    coverage: {
      requestedPages: pageCount,
      analyzedPages: incomplete ? 18 : pageCount,
      failedPages: incomplete ? 1 : 0,
      pendingPages: incomplete ? 1 : 0,
      label: incomplete
        ? 'PARTIAL requested-page coverage'
        : 'Complete requested-page coverage'
    },
    totals: {
      findings: findings.length,
      actionableFindings: findings.filter(
        (finding) => finding.status === 'OPEN' || finding.status === 'REGRESSED'
      ).length,
      uniqueRules: new Set(findings.map((finding) => finding.ruleId)).size,
      affectedPages: new Set(findings.map((finding) => finding.pageUrl)).size,
      bySeverity: {
        CRITICAL: findings.filter((finding) => finding.severity === 'CRITICAL').length,
        SERIOUS: findings.filter((finding) => finding.severity === 'SERIOUS').length,
        MODERATE: findings.filter((finding) => finding.severity === 'MODERATE').length,
        MINOR: findings.filter((finding) => finding.severity === 'MINOR').length
      },
      byStatus: {
        OPEN: findings.filter((finding) => finding.status === 'OPEN').length,
        FIXED: findings.filter((finding) => finding.status === 'FIXED').length,
        REGRESSED: findings.filter((finding) => finding.status === 'REGRESSED').length,
        WAIVED: findings.filter((finding) => finding.status === 'WAIVED').length
      }
    },
    findingGroups: groups,
    actionableGroups: groups.filter((group) => group.actionableOccurrences > 0),
    findings,
    pages,
    comparison: null,
    comparisonNote: incomplete
      ? 'Comparison omitted because this report is provisional.'
      : 'Comparison omitted: no identical normalized requested URL set was found among the 25 most recent earlier completed COMPLETE scans.'
  };
}
