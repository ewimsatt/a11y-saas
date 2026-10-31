type PresentedRule = {
  wcagRefs: string[];
  [key: string]: unknown;
};

type PresentableIssue = {
  severity: string;
  rule: PresentedRule | null;
  [key: string]: unknown;
};

function criterionFromAxeTag(tag: string): string | null {
  const match = /^wcag([1-4])(\d)(\d)$/i.exec(tag.trim());
  return match ? `${match[1]}.${match[2]}.${match[3]}` : null;
}

export function presentIssue<T extends PresentableIssue>(issue: T): T & { impact: string; rule: (T['rule'] & { wcagCriteria: string[] }) | null } {
  return {
    ...issue,
    impact: issue.severity.toLowerCase(),
    rule: issue.rule && {
      ...issue.rule,
      wcagCriteria: [...new Set(issue.rule.wcagRefs.flatMap((tag) => {
        const criterion = criterionFromAxeTag(tag);
        return criterion ? [criterion] : [];
      }))]
    }
  } as T & { impact: string; rule: (T['rule'] & { wcagCriteria: string[] }) | null };
}
