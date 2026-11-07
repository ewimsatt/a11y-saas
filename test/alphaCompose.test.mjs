import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const composePath = resolve(root, 'docker-compose.alpha.yml');

function renderAlphaCompose(envPath) {
  const result = spawnSync('docker', [
    'compose',
    '--env-file', envPath,
    '-f', composePath,
    'config',
    '--format', 'json'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: process.env
  });

  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe('friend alpha Compose isolation', () => {
  it('uses its own Compose project and gives the read-only API the worker evidence volume', async () => {
    const envDir = await mkdtemp(resolve(tmpdir(), 'a11y-alpha-compose-'));
    const envPath = resolve(envDir, '.env.alpha');

    try {
      const envResult = spawnSync(process.execPath, ['scripts/create-alpha-env.mjs', envPath], {
        cwd: root,
        encoding: 'utf8'
      });
      expect(envResult.status, envResult.stderr).toBe(0);

      const compose = renderAlphaCompose(envPath);

      expect(compose.name).toBe('a11y-friend-alpha');
      expect(compose.services.api.environment.EVIDENCE_DIR).toBe('/app/evidence');
      expect(compose.services.api.volumes).toContainEqual(expect.objectContaining({
        source: 'alpha-evidence',
        target: '/app/evidence',
        read_only: true
      }));
      expect(compose.services.worker.environment.EVIDENCE_DIR).toBe('/app/evidence');
      expect(compose.services.worker.volumes).toContainEqual(expect.objectContaining({
        source: 'alpha-evidence',
        target: '/app/evidence'
      }));
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });

  it('renders a production web console bound only to loopback with the loopback API origin', async () => {
    const envDir = await mkdtemp(resolve(tmpdir(), 'a11y-alpha-compose-'));
    const envPath = resolve(envDir, '.env.alpha');

    try {
      const envResult = spawnSync(process.execPath, ['scripts/create-alpha-env.mjs', envPath], {
        cwd: root,
        encoding: 'utf8'
      });
      expect(envResult.status, envResult.stderr).toBe(0);

      const compose = renderAlphaCompose(envPath);
      const web = compose.services.web;

      expect(web.command).toEqual(['pnpm', '--filter', '@a11y/web', 'start']);
      expect(web.environment.VITE_API_URL).toBe('http://127.0.0.1:3001');
      expect(compose.services.api.environment.CORS_ORIGIN.split(',')).toContain('http://127.0.0.1:3010');
      expect(web.ports).toContainEqual(expect.objectContaining({
        target: 3010,
        published: '3010',
        protocol: 'tcp',
        host_ip: '127.0.0.1'
      }));
      expect(Object.keys(web.networks)).toEqual(['app_internal']);
      expect(Object.keys(web.networks)).not.toContain('scanner_egress');
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });
});
