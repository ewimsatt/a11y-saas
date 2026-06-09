export type PrevFinding = { id: string; fingerprint: string; status: string };
export type NewFinding = { id: string; fingerprint: string };
export type StatusUpdate = { id: string; status: 'FIXED' | 'REGRESSED' };

/**
 * Pure diff between a previous completed scan and the current scan.
 * - A new finding whose fingerprint was previously FIXED is REGRESSED.
 * - A previous OPEN finding whose fingerprint no longer appears is FIXED.
 */
export function computeDiffUpdates(
  prevFindings: PrevFinding[],
  newFindings: NewFinding[]
): StatusUpdate[] {
  const updates: StatusUpdate[] = [];
  const prevByFingerprint = new Map(prevFindings.map((f) => [f.fingerprint, f]));
  const newFingerprints = new Set(newFindings.map((f) => f.fingerprint));

  for (const nf of newFindings) {
    const prev = prevByFingerprint.get(nf.fingerprint);
    if (prev?.status === 'FIXED') {
      updates.push({ id: nf.id, status: 'REGRESSED' });
    }
  }
  for (const pf of prevFindings) {
    if (pf.status === 'OPEN' && !newFingerprints.has(pf.fingerprint)) {
      updates.push({ id: pf.id, status: 'FIXED' });
    }
  }
  return updates;
}

/** Groups status updates into id lists so they can be applied as bulk updateMany calls. */
export function groupStatusUpdates(updates: StatusUpdate[]): {
  fixedIds: string[];
  regressedIds: string[];
} {
  const fixedIds: string[] = [];
  const regressedIds: string[] = [];
  for (const u of updates) {
    (u.status === 'FIXED' ? fixedIds : regressedIds).push(u.id);
  }
  return { fixedIds, regressedIds };
}
