import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { prisma } from '@a11y/db';
import { projectRoutes } from './routes/projects';
import { scanRoutes } from './routes/scans';
import { issueRoutes } from './routes/issues';
import { reportRoutes } from './routes/reports';
import { closeQueues } from './lib/queues';
import { EVIDENCE_DIR } from './lib/paths';

const PORT = Number(process.env.PORT ?? 3001);

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true
  });
  app.get('/healthz', async () => ({ ok: true }));
  await app.register(projectRoutes);
  await app.register(scanRoutes);
  await app.register(issueRoutes);
  await app.register(reportRoutes);
  await app.register(staticPlugin, {
    root: EVIDENCE_DIR,
    prefix: '/evidence/',
    immutable: true,
    maxAge: '1d'
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: PORT, host: '0.0.0.0' });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
