import { describe, expect, it } from 'vitest';
import { stageJobId, stageJobOptions, runRetryDelayMs, remainingRunAttempts } from '../src/stageDispatch.js';

describe('stage dispatch runtime policy', () => {
  it('uses scan, stage, and generation in a BullMQ-safe stable job identity', () => {
    expect(stageJobId('scan-1', 'ANALYZE', 0)).toBe('scan-1-analyze-0');
    expect(stageJobId('scan-1', 'EVIDENCE', 7)).toBe('scan-1-evidence-7');
    expect(stageJobId('scan-1', 'DIFF', 2)).not.toContain(':');
  });

  it('retains exactly three database-authoritative run attempts with 1s then 5s backoff', () => {
    expect(remainingRunAttempts(0)).toBe(3);
    expect(remainingRunAttempts(1)).toBe(2);
    expect(remainingRunAttempts(2)).toBe(1);
    expect(remainingRunAttempts(3)).toBe(0);
    expect(runRetryDelayMs(1)).toBe(1_000);
    expect(runRetryDelayMs(2)).toBe(5_000);
  });

  it('does not let Redis grant attempts beyond the remaining durable run budget', () => {
    expect(stageJobOptions(0)).toMatchObject({ attempts: 3, backoff: { type: 'stage-run', delay: 1_000 } });
    expect(stageJobOptions(1)).toMatchObject({ attempts: 2, backoff: { type: 'stage-run', delay: 1_000 } });
    expect(stageJobOptions(2)).toMatchObject({ attempts: 1 });
    expect(stageJobOptions(3)).toBeNull();
  });
});
