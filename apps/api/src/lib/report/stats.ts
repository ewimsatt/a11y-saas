// Pure aggregation helpers for scan reports (no I/O, unit-tested).

export type Severity = 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';
export type FindingStatus = 'OPEN' | 'FIXED' | 'REGRESSED' | 'WAIVED';

export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'SERIOUS', 'MODERATE', 'MINOR'];
export const STATUS_ORDER: FindingStatus[] = ['OPEN', 'REGRESSED', 'FIXED', 'WAIVED'];

export type FindingLike = {
  severity: Severity;
  status: FindingStatus;
  ruleId: string;
};

export function countBySeverity(findings: FindingLike[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { CRITICAL: 0, SERIOUS: 0, MODERATE: 0, MINOR: 0 };
  for (const f of findings) counts[f.severity] += 1;
  return counts;
}

export function countByStatus(findings: FindingLike[]): Record<FindingStatus, number> {
  const counts: Record<FindingStatus, number> = { OPEN: 0, FIXED: 0, REGRESSED: 0, WAIVED: 0 };
  for (const f of findings) counts[f.status] += 1;
  return counts;
}

const SCORE_WEIGHTS: Record<Severity, number> = {
  CRITICAL: 10,
  SERIOUS: 5,
  MODERATE: 2,
  MINOR: 1
};

/**
 * Weighted 0-100 health score. Waived findings are excluded: they have been
 * explicitly accepted, so they should not keep dragging the score down.
 */
export function computeScore(findings: FindingLike[]): number {
  let penalty = 0;
  for (const f of findings) {
    if (f.status === 'WAIVED') continue;
    penalty += SCORE_WEIGHTS[f.severity];
  }
  return Math.max(0, 100 - penalty);
}

export function scoreGrade(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

export type RuleSummary = {
  ruleId: string;
  title: string;
  wcagRefs: string[];
  count: number;
  maxSeverity: Severity;
};

export function summarizeRules(
  findings: Array<FindingLike & { rule?: { title: string; wcagRefs: string[] } | null }>
): RuleSummary[] {
  const byRule = new Map<string, RuleSummary>();
  for (const f of findings) {
    const existing = byRule.get(f.ruleId);
    if (!existing) {
      byRule.set(f.ruleId, {
        ruleId: f.ruleId,
        title: f.rule?.title ?? f.ruleId,
        wcagRefs: f.rule?.wcagRefs ?? [],
        count: 1,
        maxSeverity: f.severity
      });
      continue;
    }
    existing.count += 1;
    if (SEVERITY_ORDER.indexOf(f.severity) < SEVERITY_ORDER.indexOf(existing.maxSeverity)) {
      existing.maxSeverity = f.severity;
    }
  }
  return [...byRule.values()].sort(
    (a, b) =>
      b.count - a.count || SEVERITY_ORDER.indexOf(a.maxSeverity) - SEVERITY_ORDER.indexOf(b.maxSeverity)
  );
}
