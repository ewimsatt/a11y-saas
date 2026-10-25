export type RawViolationInput = {
  ruleId: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor' | null;
  message: string;
  selector?: string;
  targetIdentity: string;
  wcagRefs?: string[];
  domSnippet?: string;
  failureSummary?: string;
};

type Fingerprint = (input: {
  ruleId: string;
  pageUrl: string;
  selector?: string;
  targetIdentity?: string;
  message?: string;
}) => string;

export type Severity = 'CRITICAL' | 'SERIOUS' | 'MODERATE' | 'MINOR';

export type FindingRow = {
  scanId: string;
  pageId: string;
  ruleId: string;
  severity: Severity;
  fingerprint: string;
  selector: string | undefined;
  message: string;
};

export type PersistedViolation = {
  row: FindingRow;
  violation: RawViolationInput;
};

export const MAX_PAGE_VIOLATIONS = 250;

const SEVERITY_BY_IMPACT: Record<string, Severity> = {
  critical: 'CRITICAL',
  serious: 'SERIOUS',
  moderate: 'MODERATE',
  minor: 'MINOR'
};

export function dedupePageViolations(
  page: { id: string; scanId: string; url: string },
  violations: RawViolationInput[],
  fingerprint: Fingerprint
): PersistedViolation[] {
  const rowsByFingerprint = new Map<string, PersistedViolation>();
  for (const violation of violations) {
    const fingerprintValue = fingerprint({
      ruleId: violation.ruleId,
      pageUrl: page.url,
      selector: violation.selector,
      targetIdentity: violation.targetIdentity,
      message: violation.message
    });
    if (rowsByFingerprint.has(fingerprintValue)) continue;
    rowsByFingerprint.set(fingerprintValue, {
      violation,
      row: {
        scanId: page.scanId,
        pageId: page.id,
        ruleId: violation.ruleId,
        severity: SEVERITY_BY_IMPACT[violation.impact ?? ''] ?? 'MODERATE',
        fingerprint: fingerprintValue,
        selector: violation.selector,
        message: violation.message
      }
    });
    if (rowsByFingerprint.size > MAX_PAGE_VIOLATIONS) {
      throw new Error(`Refusing to persist more than ${MAX_PAGE_VIOLATIONS} unique violations for page ${page.id}`);
    }
  }
  return [...rowsByFingerprint.values()];
}
