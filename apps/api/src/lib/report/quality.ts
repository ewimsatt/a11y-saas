import type { FindingStatus, Severity } from './stats';

export type FindingForQuality = {
  id: string;
  pageId: string;
  fingerprint: string;
  targetIdentity: unknown | null;
  evidenceMeta: unknown | null;
  severity: Severity;
  status: FindingStatus;
  ruleId: string;
  message: string;
  selector: string | null;
  pageUrl: string;
  domSnippet: string | null;
  failureSummary: string | null;
  wcagRefs: string[];
};

export type FindingGroup = {
  ruleId: string;
  message: string;
  wcagRefs: string[];
  /** Worst severity across every recorded occurrence, retained for distribution and inventory. */
  maxSeverity: Severity;
  /** Worst severity across OPEN and REGRESSED occurrences only, used for remediation priority. */
  actionableMaxSeverity: Severity | null;
  occurrences: number;
  actionableOccurrences: number;
  /** Distinct pages across every recorded occurrence. */
  affectedPages: number;
  /** Distinct pages containing OPEN or REGRESSED occurrences only. */
  actionableAffectedPages: number;
  pages: Array<{ pageUrl: string; findings: FindingForQuality[] }>;
};

const severityRank: Record<Severity, number> = {
  CRITICAL: 0,
  SERIOUS: 1,
  MODERATE: 2,
  MINOR: 3
};

export function isActionableFinding(finding: Pick<FindingForQuality, 'status'>): boolean {
  return finding.status === 'OPEN' || finding.status === 'REGRESSED';
}

export function groupFindings(findings: FindingForQuality[]): FindingGroup[] {
  const byRule = new Map<string, FindingForQuality[]>();
  for (const finding of findings) {
    byRule.set(finding.ruleId, [...(byRule.get(finding.ruleId) ?? []), finding]);
  }

  return [...byRule.entries()]
    .map(([ruleId, occurrences]) => {
      const byPage = new Map<string, FindingForQuality[]>();
      for (const finding of occurrences) {
        byPage.set(finding.pageUrl, [...(byPage.get(finding.pageUrl) ?? []), finding]);
      }
      const first = occurrences[0]!;
      const actionable = occurrences.filter(isActionableFinding);
      const actionableByPage = new Set(actionable.map((finding) => finding.pageUrl));
      return {
        ruleId,
        message: first.message,
        wcagRefs: [...new Set(occurrences.flatMap((finding) => finding.wcagRefs))],
        maxSeverity: occurrences.reduce(
          (worst, finding) =>
            severityRank[finding.severity] < severityRank[worst] ? finding.severity : worst,
          first.severity
        ),
        actionableMaxSeverity: actionable.length
          ? actionable.reduce(
              (worst, finding) =>
                severityRank[finding.severity] < severityRank[worst] ? finding.severity : worst,
              actionable[0]!.severity
            )
          : null,
        occurrences: occurrences.length,
        actionableOccurrences: actionable.length,
        affectedPages: byPage.size,
        actionableAffectedPages: actionableByPage.size,
        pages: [...byPage.entries()].map(([pageUrl, pageFindings]) => ({ pageUrl, findings: pageFindings }))
      };
    })
    .sort(
      (a, b) =>
        Number(b.actionableOccurrences > 0) - Number(a.actionableOccurrences > 0) ||
        severityRank[a.actionableMaxSeverity ?? 'MINOR'] - severityRank[b.actionableMaxSeverity ?? 'MINOR'] ||
        b.actionableOccurrences - a.actionableOccurrences ||
        b.actionableAffectedPages - a.actionableAffectedPages ||
        a.ruleId.localeCompare(b.ruleId)
    );
}

export function findingGuidance(ruleId: string): {
  whyItMatters: string;
  suggestedFix: string;
  howToRetest: string;
} {
  if (ruleId === 'color-contrast') {
    return {
      whyItMatters:
        'Insufficient text or control contrast can make content difficult to read, especially for people with low vision.',
      suggestedFix:
        'Inspect the foreground, background, font size, and weight at this selector. Adjust the color pairing or visual treatment until the required contrast is met.',
      howToRetest:
        'Recheck the rendered state at this URL with the same text, hover/focus states where applicable, and keyboard navigation before rerunning the scan.'
    };
  }
  if (ruleId === 'image-alt') {
    return {
      whyItMatters:
        'Images without an appropriate text alternative can leave nonvisual users without equivalent information.',
      suggestedFix:
        'Review the image purpose. Provide concise alternative text for informative images, or use an empty alternative for genuinely decorative images.',
      howToRetest:
        'Inspect the rendered image and its accessible name with a screen reader or browser accessibility tree, then rerun the scan.'
    };
  }
  return {
    whyItMatters:
      'This automated result indicates a condition that may make the affected content or control harder to use.',
    suggestedFix:
      'Inspect the referenced rule, selector, and rendered state before changing code. Apply a fix appropriate to the component behavior rather than assuming a root cause.',
    howToRetest:
      'Exercise the affected interaction or content state, inspect the accessible tree where relevant, and rerun the automated scan.'
  };
}

/** Prefix cells that spreadsheet software could reinterpret after trimming control characters or whitespace. */
export function csvCell(value: string | number | null | undefined): string {
  let text = value == null ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function jsonMetadata(value: unknown | null): string {
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

export function buildFindingsCsv(data: {
  project: { name: string };
  scan: { id: string; status: string; coverage: string };
  generatedAt: Date;
  findings: FindingForQuality[];
}): string {
  const header = [
    'finding_id',
    'page_id',
    'fingerprint',
    'target_identity',
    'evidence_metadata',
    'project',
    'scan_id',
    'scan_status',
    'coverage',
    'severity',
    'finding_status',
    'rule_id',
    'wcag_references',
    'page_url',
    'selector',
    'message',
    'failure_summary',
    'dom_snippet',
    'generated_at'
  ];
  const rows = data.findings.map((finding) =>
    [
      finding.id,
      finding.pageId,
      finding.fingerprint,
      jsonMetadata(finding.targetIdentity),
      jsonMetadata(finding.evidenceMeta),
      data.project.name,
      data.scan.id,
      data.scan.status,
      data.scan.coverage,
      finding.severity,
      finding.status,
      finding.ruleId,
      finding.wcagRefs.join(' '),
      finding.pageUrl,
      finding.selector,
      finding.message,
      finding.failureSummary,
      finding.domSnippet,
      data.generatedAt.toISOString()
    ]
      .map(csvCell)
      .join(',')
  );
  return [header.join(','), ...rows].join('\n');
}
