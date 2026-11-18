import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function readDoc(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), 'utf8');
}

describe('current user-facing documentation', () => {
  it('keeps the scope page aligned with the local alpha workflow and its limits', async () => {
    const scope = await readDoc('docs/current-scope.md');

    expect(scope).toContain('local single-user alpha');
    expect(scope).toContain('http://127.0.0.1:3010');
    expect(scope).toContain('PostgreSQL-authoritative');
    expect(scope).toContain('token-fenced');
    expect(scope).toContain('comparisons appear only for complete-coverage scans with an eligible prior scan of the same requested URL set');
    expect(scope).toContain('not approved for public, shared, hosted, LAN, or multi-tenant use');
    expect(scope).not.toContain('Empty shell');
    expect(scope).not.toContain('No GitHub Actions workflow');
    expect(scope).not.toContain('Returns `{evidence: null}`');
  });

  it('points old quickstart readers at the safe current setup instead of obsolete demo commands', async () => {
    const quickstart = await readDoc('docs/quickstart.md');

    expect(quickstart).toContain('pnpm alpha:env .env.alpha');
    expect(quickstart).toContain('docker-compose.alpha.yml');
    expect(quickstart).toContain('friend-alpha-local.md');
    expect(quickstart).not.toContain('cp .env.example .env');
    expect(quickstart).not.toContain('migrate dev');
    expect(quickstart).not.toContain('web UI stub');
  });
});
