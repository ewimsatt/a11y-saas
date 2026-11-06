import { isComparableScan } from '@a11y/shared';

export type FindingObservation = { id: string; fingerprint: string };

export type FixedTransition = {
  priorFindingId: string;
  fingerprint: string;
};

export type ScanComparison = {
  fixed: FixedTransition[];
  persisting: string[];
  new: string[];
  /** IDs belonging only to current-scan observations that reappeared after an absence. */
  regressedIds: string[];
};

export type FindingWriter = {
  finding: {
    updateMany(args: {
      where: { id: { in: string[] }; scanId: string };
      data: { status: 'REGRESSED' };
    }): Promise<unknown>;
  };
};

/** Persists only classifications of observations belonging to the current scan. */
export async function persistCurrentRegressions(
  prisma: FindingWriter,
  scanId: string,
  currentFindingIds: readonly string[]
): Promise<void> {
  if (currentFindingIds.length === 0) return;
  await prisma.finding.updateMany({
    where: { id: { in: [...currentFindingIds] }, scanId },
    data: { status: 'REGRESSED' }
  });
}

export type ComparableScan = {
  id: string;
  completedAt: Date | null;
  pages: Array<{ url: string }>;
};

export type ComparableScanCandidate = ComparableScan & {
  status: string;
  coverage: string;
  pages: Array<{ url: string; outcome: string }>;
};

function exactRequestedUrlSet(urls: readonly string[]): string[] {
  return [...urls].sort((left, right) => left.localeCompare(right));
}

export function findComparableScan<T extends ComparableScan>(currentUrls: readonly string[], candidates: readonly T[]): T | null {
  const current = exactRequestedUrlSet(currentUrls);
  return [...candidates]
    .sort((left, right) => (right.completedAt?.getTime() ?? 0) - (left.completedAt?.getTime() ?? 0))
    .find((candidate) => {
      const scope = exactRequestedUrlSet(candidate.pages.map((page) => page.url));
      return scope.length === current.length && scope.every((url, index) => url === current[index]);
    }) ?? null;
}

/** Filters historical candidates through the shared finality policy before scope matching. */
export function selectComparableScans<T extends ComparableScanCandidate>(
  currentUrls: readonly string[],
  candidates: readonly T[]
): T[] {
  return candidates.filter((candidate) => isComparableScan(candidate) && findComparableScan(currentUrls, [candidate]) !== null);
}

/**
 * Derives comparison facts from immutable scan observations. The immediately
 * previous comparable scan establishes fixed/persisting/new. Older comparable
 * observations only distinguish a new occurrence from a regression.
 */
export function deriveScanComparison(
  previous: readonly FindingObservation[] | null,
  current: readonly FindingObservation[],
  olderComparableObservations: readonly (readonly FindingObservation[])[]
): ScanComparison {
  if (!previous) return { fixed: [], persisting: [], new: [], regressedIds: [] };

  const previousByFingerprint = new Map(previous.map((finding) => [finding.fingerprint, finding]));
  const currentFingerprints = new Set(current.map((finding) => finding.fingerprint));
  const olderFingerprints = new Set(olderComparableObservations.flatMap((findings) => findings.map((finding) => finding.fingerprint)));
  const fixed = previous
    .filter((finding) => !currentFingerprints.has(finding.fingerprint))
    .map((finding) => ({ priorFindingId: finding.id, fingerprint: finding.fingerprint }));
  const persisting: string[] = [];
  const newlyObserved: string[] = [];
  const regressedIds: string[] = [];

  for (const finding of current) {
    if (previousByFingerprint.has(finding.fingerprint)) {
      persisting.push(finding.fingerprint);
    } else if (olderFingerprints.has(finding.fingerprint)) {
      regressedIds.push(finding.id);
    } else {
      newlyObserved.push(finding.fingerprint);
    }
  }

  return { fixed, persisting, new: newlyObserved, regressedIds };
}
