import Fastify from 'fastify';
import { projectRoutes } from './routes/projects';
import { scanRoutes } from './routes/scans';
import { issueRoutes } from './routes/issues';

async function main() {
  const app = Fastify({ logger: true });
  await app.register(projectRoutes);
  await app.register(scanRoutes);
  await app.register(issueRoutes);
  await app.listen({ port: 3001, host: '0.0.0.0' });
}

main();
