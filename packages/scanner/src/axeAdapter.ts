// Stub adapter - wire Playwright page + axe-core here.
export type RawViolation = {
  ruleId: string;
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  message: string;
  selector?: string;
  wcagRefs?: string[];
};

export async function runAxeOnPage(_url: string): Promise<RawViolation[]> {
  // TODO: integrate Playwright + axe-core execution.
  return [];
}
