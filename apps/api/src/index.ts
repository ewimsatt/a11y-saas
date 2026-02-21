import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import path from 'node:path';
import { projectRoutes } from './routes/projects';
import { scanRoutes } from './routes/scans';
import { issueRoutes } from './routes/issues';

async function main() {
  const app = Fastify({ logger: true });
  await app.register(projectRoutes);
  await app.register(scanRoutes);
  await app.register(issueRoutes);
  app.register(staticPlugin, {
    root: path.join(process.cwd(), '../../evidence'),
    prefix: '/evidence/',
    immutable: true,
    maxAge: '1d'
  });
  await app.listen({ port: 3001, host: '0.0.0.0' });
  console.log('API listening on http://localhost:3001');
}

main();
