import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FIXTURE_KINDS,
  buildFixtureData,
  fixtureOutputDirectory
} from '../../../scripts/report-fixtures';

describe('portable report fixtures', () => {
  it('defaults to a portable temp directory and honors an explicit override', () => {
    expect(fixtureOutputDirectory({})).toBe(path.join(os.tmpdir(), 'a11y-report-fixtures'));
    expect(fixtureOutputDirectory({ REPORT_FIXTURE_DIR: '/tmp/custom-reports' })).toBe(
      '/tmp/custom-reports'
    );
  });

  it('covers the required semantic fixture families', () => {
    expect(FIXTURE_KINDS).toEqual([
      'zero',
      'incomplete',
      'long',
      'large162',
      'mixed',
      'fixed-only',
      'waived-only'
    ]);
  });

  it('builds provisional diffing coverage and final all-analyzed coverage truthfully', () => {
    const incomplete = buildFixtureData('incomplete');
    expect(incomplete.scan).toMatchObject({ status: 'diffing', coverage: 'PARTIAL', isFinal: false });
    expect(incomplete.pages.some((page) => page.outcome !== 'ANALYZED')).toBe(true);

    const complete = buildFixtureData('large162');
    expect(complete.scan).toMatchObject({ status: 'completed', coverage: 'COMPLETE', isFinal: true });
    expect(complete.findings).toHaveLength(162);
    expect(complete.pages.every((page) => page.outcome === 'ANALYZED')).toBe(true);
  });

  it('keeps fixed-only and waived-only records non-actionable while preserving them', () => {
    const fixed = buildFixtureData('fixed-only');
    const waived = buildFixtureData('waived-only');
    expect(fixed.findings.every((finding) => finding.status === 'FIXED')).toBe(true);
    expect(waived.findings.every((finding) => finding.status === 'WAIVED')).toBe(true);
    expect(fixed.totals.actionableFindings).toBe(0);
    expect(waived.totals.actionableFindings).toBe(0);
  });
});
