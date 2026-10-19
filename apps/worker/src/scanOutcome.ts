export type ScanCoverage = 'COMPLETE' | 'PARTIAL' | 'FAILED';

export type ScanOutcome = {
  scanStatus: 'completed' | 'failed';
  coverage: ScanCoverage;
  shouldDiff: boolean;
};

/**
 * A diff is only meaningful when this scan analyzed every requested page.
 * Incomplete coverage must not turn missing observations into FIXED findings.
 */
export function decideScanOutcome(input: { attempted: number; analyzed: number; failed: number }): ScanOutcome {
  if (input.attempted === 0 || input.analyzed === 0) {
    return { scanStatus: 'failed', coverage: 'FAILED', shouldDiff: false };
  }
  if (input.failed > 0 || input.analyzed !== input.attempted) {
    return { scanStatus: 'completed', coverage: 'PARTIAL', shouldDiff: false };
  }
  return { scanStatus: 'completed', coverage: 'COMPLETE', shouldDiff: true };
}
