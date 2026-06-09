import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { projectRoutes } from './routes/projects';
import { scanRoutes } from './routes/scans';
import { issueRoutes } from './routes/issues';
import { closeQueues } from './lib/queues';

const PORT = Number(process.env.PORT ?? 3001);
const EVIDENCE_DIR = path.resolve(
  process.env.EVIDENCE_DIR ?? path.join(process.cwd(), '../../evidence')
);

async function main() {
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : true
  });
  await app.register(projectRoutes);
  await app.register(scanRoutes);
  await app.register(issueRoutes);
  await app.register(staticPlugin, {
    root: EVIDENCE_DIR,
    prefix: '/evidence/',
    immutable: true,
    maxAge: '1d'
  });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await closeQueues();
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
