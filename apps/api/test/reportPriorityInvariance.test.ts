import { describe, expect, it } from 'vitest';
import { groupFindings, type FindingForQuality } from '../src/lib/report/quality';

function finding(id: string, ruleId: string, status: FindingForQuality['status']): FindingForQuality {
  return {
    id, ruleId, status, severity: 'SERIOUS', pageUrl: `https://example.test/${id}`,
    pageId: id, fingerprint: id, targetIdentity: null, evidenceMeta: null,
    message: ruleId, selector: '#example', domSnippet: null, failureSummary: null, wcagRefs: []
  };
}

describe('actionable priority invariance', () => {
  it.each(['FIXED', 'WAIVED'] as const)('adding %s occurrences cannot change actionable ranking', (status) => {
    const actionable = [finding('a', 'a-open', 'OPEN'), finding('z', 'z-mixed', 'REGRESSED')];
    const before = groupFindings(actionable);
    const after = groupFindings([...actionable, finding('historical', 'z-mixed', status)]);
    expect(after.map(group => group.ruleId)).toEqual(before.map(group => group.ruleId));
    const mixed = after.find(group => group.ruleId === 'z-mixed');
    expect(mixed).toMatchObject({ occurrences: 2, affectedPages: 2, actionableOccurrences: 1, actionableAffectedPages: 1 });
  });
});
