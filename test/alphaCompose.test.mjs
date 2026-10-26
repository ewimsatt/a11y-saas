import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const composePath = resolve(import.meta.dirname, '..', 'docker-compose.alpha.yml');

describe('friend alpha Compose isolation', () => {
  it('uses its own Compose project and gives the read-only API the worker evidence volume', async () => {
    const compose = await readFile(composePath, 'utf8');

    const service = (name, nextName) => compose.slice(
      compose.indexOf(`  ${name}:`),
      compose.indexOf(`  ${nextName}:`)
    );
    const api = service('api', 'worker');
    const worker = service('worker', 'browser');

    expect(compose).toMatch(/^name:\s*a11y-friend-alpha\s*$/m);
    expect(api).toContain('EVIDENCE_DIR: /app/evidence');
    expect(api).toContain('volumes: [alpha-evidence:/app/evidence:ro]');
    expect(worker).toContain('EVIDENCE_DIR: /app/evidence');
    expect(worker).toContain('volumes: [alpha-evidence:/app/evidence]');
  });
});
