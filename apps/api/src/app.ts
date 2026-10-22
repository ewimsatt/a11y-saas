import Fastify from 'fastify';
import cors from '@fastify/cors';
import staticPlugin from '@fastify/static';
import { EVIDENCE_DIR } from './lib/paths';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3010', 'http://127.0.0.1:3010'];

export type RuntimeConfig = {
  host: string;
  port: number;
  allowedOrigins: string[];
};

type RuntimeEnvironment = Partial<Pick<NodeJS.ProcessEnv, 'HOST' | 'PORT' | 'CORS_ORIGIN' | 'CONTAINER_BIND_ALL_INTERFACES'>>;

type CreateAppOptions = {
  includeApplicationRoutes?: boolean;
};

function parsePort(value: string | undefined): number {
  if (value === undefined || value === '') return 3001;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535');
  }
  return port;
}

function parseOrigins(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') return DEFAULT_ALLOWED_ORIGINS;

  const origins = value.split(',').map((origin) => origin.trim()).filter(Boolean);
  if (origins.length === 0) throw new Error('CORS_ORIGIN must contain at least one origin');

  return origins.map((origin) => {
    const url = new URL(origin);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== origin) {
      throw new Error(`CORS_ORIGIN must contain absolute HTTP(S) origins, received: ${origin}`);
    }
    return origin;
  });
}

export function resolveRuntimeConfig(env: RuntimeEnvironment = process.env as RuntimeEnvironment): RuntimeConfig {
  const host = env.HOST?.trim() || '127.0.0.1';
  const containerBindingEnabled = env.CONTAINER_BIND_ALL_INTERFACES === '1';
  if (!LOOPBACK_HOSTS.has(host) && !(host === '0.0.0.0' && containerBindingEnabled)) {
    throw new Error(`HOST must be a loopback address for this alpha service, received: ${host}`);
  }

  return {
    host,
    port: parsePort(env.PORT),
    allowedOrigins: parseOrigins(env.CORS_ORIGIN)
  };
}

export async function createApp(config: RuntimeConfig, options: CreateAppOptions = {}) {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: config.allowedOrigins });
  app.get('/healthz', async () => ({ ok: true }));

  if (options.includeApplicationRoutes ?? true) {
    const [projects, scans, issues, reports] = await Promise.all([
      import('./routes/projects'),
      import('./routes/scans'),
      import('./routes/issues'),
      import('./routes/reports')
    ]);
    await app.register(projects.projectRoutes);
    await app.register(scans.scanRoutes);
    await app.register(issues.issueRoutes);
    await app.register(reports.reportRoutes);
  }

  await app.register(staticPlugin, {
    root: EVIDENCE_DIR,
    prefix: '/evidence/',
    immutable: true,
    maxAge: '1d'
  });

  return app;
}
