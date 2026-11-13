import { PrismaClient } from '../generated/prisma/client.ts';

export { ensureClaimedStageTransport, reconcileExactEnqueuedTransport } from './stageTransport.ts';

export {
  canonicalizeTerminalStageDispatches,
  claimNextStageDispatch,
  finalizeStageDispatchEnqueueFailure,
  finalizeStageDispatchEnqueueSuccess,
  claimStageRun,
  renewStageRun,
  lockStageRun,
  releaseStageRun,
  advanceStageRun,
  completeStageRun,
  failStageRun,
  findStaleEnqueuedStages,
  releaseEnqueuedStageForReconcile,
  terminalizeAbandonedStageRun
} from './stageDispatchLedger.ts';
export type {
  ClaimedStageDispatch,
  StageDispatchClaimOptions,
  StageDispatchFailureFinalization,
  StageDispatchFinalization,
  StageRun,
  StageRunClaimOptions,
  EnqueuedStage
} from './stageDispatchLedger.ts';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : [],
});

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}
