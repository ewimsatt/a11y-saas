import crypto from 'node:crypto';

export function stableFingerprint(input: {
  ruleId: string;
  pageUrl: string;
  selector?: string;
  message?: string;
}) {
  const raw = [input.ruleId, input.pageUrl, input.selector ?? '', input.message ?? '']
    .join('|')
    .toLowerCase()
    .trim();
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}
