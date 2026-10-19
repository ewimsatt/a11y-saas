import crypto from 'node:crypto';

export function stableFingerprint(input: {
  ruleId: string;
  pageUrl: string;
  selector?: string;
  /** Canonical JSON serialization of axe's structured target array. */
  targetIdentity?: string;
  message?: string;
}) {
  // Rule identifiers are case-insensitive; axe's structured target JSON is not.
  const raw = [input.ruleId.toLowerCase(), input.pageUrl, input.selector ?? '', input.targetIdentity ?? '', input.message ?? '']
    .join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}
