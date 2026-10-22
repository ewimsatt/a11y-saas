export type ContrastFinding = {
  id: string;
  ruleId: string;
  status: string;
  pageUrl?: string;
  selector?: string | null;
  failureSummary?: string | null;
};

export type ContrastPattern = {
  foreground: string;
  background: string;
  requiredThreshold: number;
  observedMin: number;
  observedMax: number;
  occurrences: number;
  affectedPageCount: number;
  exampleID: string;
  exampleSelector?: string | null;
  exampleURL?: string;
};

export type ContrastPatternResult = {
  groups: ContrastPattern[];
  parsedEligibleCount: number;
  unparsedEligibleCount: number;
};

type ParsedContrast = {
  foreground: string;
  background: string;
  observed: number;
  required: number;
};

const HEX = /#[0-9a-f]{3}(?:[0-9a-f]{3})?/i;
const AXE_SUMMARY = new RegExp(
  `color\\s+contrast\\s+of\\s+([0-9]+(?:\\.[0-9]+)?)\\s*\\(\\s*foreground\\s+color:\\s*(${HEX.source})\\s*,\\s*background\\s+color:\\s*(${HEX.source})\\s*,[\\s\\S]*?\\)\\s*\\.\\s*Expected\\s+contrast\\s+ratio\\s+of\\s+([0-9]+(?:\\.[0-9]+)?)\\s*:\\s*1(?![\\d.])`,
  'i'
);

function normalizeHex(value: string): string {
  const lower = value.toLowerCase();
  return lower.length === 4
    ? `#${lower
        .slice(1)
        .split('')
        .map((character) => character + character)
        .join('')}`
    : lower;
}

function parseSummary(summary: unknown): ParsedContrast | undefined {
  if (typeof summary !== 'string' || summary.length > 16_384) return undefined;
  const match = AXE_SUMMARY.exec(summary);
  if (!match) return undefined;
  const observed = Number(match[1]);
  const required = Number(match[4]);
  if (
    !Number.isFinite(observed) ||
    !Number.isFinite(required) ||
    observed < 1 ||
    observed > 21 ||
    required < 1 ||
    required > 21
  ) {
    return undefined;
  }
  return {
    observed,
    required,
    foreground: normalizeHex(match[2]!),
    background: normalizeHex(match[3]!)
  };
}

/** Patterns observed by axe; this does not assert shared components, root causes, or unique defects. */
export function groupContrastPatterns(
  findings: readonly ContrastFinding[]
): ContrastPatternResult {
  const groups = new Map<string, ContrastPattern & { pages: Set<string> }>();
  let parsedEligibleCount = 0;
  let unparsedEligibleCount = 0;

  for (const finding of findings) {
    if (
      (finding.status !== 'OPEN' && finding.status !== 'REGRESSED') ||
      finding.ruleId !== 'color-contrast'
    ) {
      continue;
    }
    const parsed = parseSummary(finding.failureSummary);
    if (!parsed) {
      unparsedEligibleCount += 1;
      continue;
    }
    parsedEligibleCount += 1;
    const key = `${parsed.foreground}|${parsed.background}|${parsed.required}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        foreground: parsed.foreground,
        background: parsed.background,
        requiredThreshold: parsed.required,
        observedMin: parsed.observed,
        observedMax: parsed.observed,
        occurrences: 0,
        affectedPageCount: 0,
        exampleID: finding.id,
        exampleSelector: finding.selector,
        exampleURL: finding.pageUrl,
        pages: new Set()
      };
      groups.set(key, group);
    }
    group.observedMin = Math.min(group.observedMin, parsed.observed);
    group.observedMax = Math.max(group.observedMax, parsed.observed);
    group.occurrences += 1;
    if (finding.pageUrl) group.pages.add(finding.pageUrl);
  }

  return {
    parsedEligibleCount,
    unparsedEligibleCount,
    groups: [...groups.values()]
      .map(({ pages, ...group }) => ({ ...group, affectedPageCount: pages.size }))
      .sort(
        (left, right) =>
          right.occurrences - left.occurrences ||
          left.foreground.localeCompare(right.foreground) ||
          left.background.localeCompare(right.background) ||
          right.requiredThreshold - left.requiredThreshold
      )
  };
}
