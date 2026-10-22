import { groupContrastPatterns } from './contrast';
import { isActionableFinding, type FindingForQuality } from './quality';

/**
 * Prefer high-frequency, distinct parsed contrast pairings, then fill from distinct
 * actionable rule families. This keeps storage order from dominating executive evidence.
 */
export function selectRepresentativeFindings<T extends FindingForQuality>(
  findings: readonly T[],
  limit: number
): T[] {
  const boundedLimit = Math.max(0, limit);
  if (boundedLimit === 0) return [];

  const byId = new Map(findings.map((finding) => [finding.id, finding]));
  const selected: T[] = [];
  const selectedIds = new Set<string>();
  const representedRules = new Set<string>();

  for (const pattern of groupContrastPatterns(findings).groups) {
    const finding = byId.get(pattern.exampleID);
    if (!finding || selectedIds.has(finding.id)) continue;
    selected.push(finding);
    selectedIds.add(finding.id);
    representedRules.add(finding.ruleId);
    if (selected.length === boundedLimit) return selected;
  }

  for (const finding of findings) {
    if (
      !isActionableFinding(finding) ||
      selectedIds.has(finding.id) ||
      representedRules.has(finding.ruleId)
    ) {
      continue;
    }
    selected.push(finding);
    selectedIds.add(finding.id);
    representedRules.add(finding.ruleId);
    if (selected.length === boundedLimit) break;
  }

  return selected;
}
