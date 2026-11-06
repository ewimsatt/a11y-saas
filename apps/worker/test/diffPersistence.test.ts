import { describe, expect, it, vi } from 'vitest';
import { persistCurrentRegressions } from '../src/diffPersistence.js';

describe('persistCurrentRegressions', () => {
  it('scopes regression writes to current scan observations and never accepts prior finding IDs', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });

    await persistCurrentRegressions({ finding: { updateMany } }, 'current-scan', ['current-occurrence']);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['current-occurrence'] }, scanId: 'current-scan' },
      data: { status: 'REGRESSED' }
    });
    expect(updateMany).not.toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: { in: ['prior-occurrence'] } }) }));
  });

  it('does not write when there are no current regressions', async () => {
    const updateMany = vi.fn();
    await persistCurrentRegressions({ finding: { updateMany } }, 'current-scan', []);
    expect(updateMany).not.toHaveBeenCalled();
  });
});
