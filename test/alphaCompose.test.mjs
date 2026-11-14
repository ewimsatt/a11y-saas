import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..');
const composePath = resolve(root, 'docker-compose.alpha.yml');

function renderAlphaCompose(envPath, extraEnv = {}) {
  const result = spawnSync('docker', [
    'compose',
    '--env-file', envPath,
    '-f', composePath,
    'config',
    '--format', 'json'
  ], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv }
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
      expect(compose.services.api.user).toBe('node');
      expect(compose.services.api.read_only).toBe(true);
      expect(compose.services.api.security_opt).toContain('no-new-privileges:true');
      expect(compose.services.api.security_opt).toContain('seccomp:./infra/playwright/seccomp_profile.json');
      expect(compose.services.api.cap_drop).toContain('ALL');
      expect(compose.services.api.pids_limit).toBe(256);
      expect(compose.services.api.mem_limit).toBe('805306368');
      expect(web.ports).toContainEqual(expect.objectContaining({
        target: 3010,
        published: '3010',
        protocol: 'tcp',
        host_ip: '127.0.0.1'
      }));
      expect(Object.keys(web.networks)).toEqual(['app_internal', 'local_access']);
      expect(Object.keys(web.networks)).not.toContain('scanner_egress');
      expect(Object.keys(compose.services.api.networks)).toEqual(['app_internal', 'local_access', 'pdf_control']);
      expect(Object.keys(compose.services.worker.networks)).toEqual(['app_internal', 'browser_control']);
      expect(compose.networks.local_access.internal).not.toBe(true);
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });

  it('isolates an authenticated sandboxed PDF renderer with no host port or egress network', async () => {
    const envDir = await mkdtemp(resolve(tmpdir(), 'a11y-alpha-compose-'));
    const envPath = resolve(envDir, '.env.alpha');

    try {
      const envResult = spawnSync(process.execPath, ['scripts/create-alpha-env.mjs', envPath], {
        cwd: root,
        encoding: 'utf8'
      });
      expect(envResult.status, envResult.stderr).toBe(0);
      const envText = await (await import('node:fs/promises')).readFile(envPath, 'utf8');
      expect(envText).toMatch(/^PDF_RENDERER_TOKEN=[A-Za-z0-9_-]{32,}$/m);

      const compose = renderAlphaCompose(envPath);
      const renderer = compose.services['pdf-renderer'];
      expect(renderer).toBeDefined();
      expect(renderer.ports).toBeUndefined();
      expect(renderer.environment.PDF_RENDERER_TOKEN).toMatch(/^[A-Za-z0-9_-]{32,}$/);
      expect(renderer.user).toBe('pwuser');
      expect(renderer.read_only).toBe(true);
      expect(renderer.security_opt).toContain('no-new-privileges:true');
      expect(renderer.cap_drop).toContain('ALL');
      expect(renderer.cap_add).toEqual(['SYS_CHROOT']);
      expect(renderer.pids_limit).toBe(512);
      expect(renderer.mem_limit).toBe('1073741824');
      expect(renderer.cpus).toBe(2);
      expect(Object.keys(renderer.networks)).toEqual(['pdf_control']);
      expect(compose.networks.pdf_control.internal).toBe(true);
      expect(compose.services.api.environment.PDF_RENDERER_URL).toBe('http://pdf-renderer:3002/render');
      expect(compose.services.api.environment.PDF_RENDERER_TOKEN).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });

  it('supports unique loopback acceptance ports without changing container ports', async () => {
    const envDir = await mkdtemp(resolve(tmpdir(), 'a11y-alpha-compose-'));
    const envPath = resolve(envDir, '.env.alpha');

    try {
      const envResult = spawnSync(process.execPath, ['scripts/create-alpha-env.mjs', envPath], {
        cwd: root,
        encoding: 'utf8'
      });
      expect(envResult.status, envResult.stderr).toBe(0);

      const compose = renderAlphaCompose(envPath, {
        ALPHA_API_HOST_PORT: '43101',
        ALPHA_WEB_HOST_PORT: '43110'
      });
      expect(compose.services.api.ports).toContainEqual(expect.objectContaining({
        target: 3001,
        published: '43101',
        host_ip: '127.0.0.1'
      }));
      expect(compose.services.web.ports).toContainEqual(expect.objectContaining({
        target: 3010,
        published: '43110',
        host_ip: '127.0.0.1'
      }));
      expect(compose.services.api.environment.CORS_ORIGIN.split(',')).toContain('http://127.0.0.1:43110');
      expect(compose.services.web.environment.VITE_API_URL).toBe('http://127.0.0.1:43101');
    } finally {
      await rm(envDir, { recursive: true, force: true });
    }
  });
});
