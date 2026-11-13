import { claimStageRun, type StageRun } from '@a11y/db';
import type { PrismaClient } from '../../../packages/db/generated/prisma/client.ts';
import type { DispatchStage } from './stageDispatch.js';

/**
 * Bridges the unavoidable Queue.add-before-database-finalize window. It keeps
 * trying while the exact ledger identity is DISPATCHING or has just finalized
 * ENQUEUED; every other state is an immediate no-op so stale or duplicate jobs
 * stay fenced.
 */
export async function claimStageRunAfterDispatchFinalize(
  prisma: PrismaClient,
  options: { scanId: string; stage: DispatchStage; generation: number; leaseMs: number },
  attempts = 20,
  delayMs = 25
): Promise<StageRun | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const run = await claimStageRun(prisma, options);
    if (run) return run;
    const ledger = await prisma.scanDispatch.findUnique({
      where: { scanId: options.scanId },
      select: { stage: true, generation: true, state: true }
    });
    if (!ledger || ledger.stage !== options.stage || ledger.generation !== options.generation || (ledger.state !== 'DISPATCHING' && ledger.state !== 'ENQUEUED')) {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}
