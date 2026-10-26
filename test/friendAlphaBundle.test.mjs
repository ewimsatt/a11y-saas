import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temporaryPaths = [];

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) => rm(temporaryPath, { force: true, recursive: true })));
});

describe('friend alpha bundle', () => {
  it('creates an inspectable source archive without local secrets or generated artifacts and refuses replacement output', async () => {
    const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'a11y-friend-alpha-bundle-test-'));
    temporaryPaths.push(temporaryDirectory);
    const output = path.join(temporaryDirectory, 'friend-alpha.tgz');
    const syntheticSecret = path.join(repositoryRoot, '.env.friend-alpha-bundle-test');
    const syntheticEvidence = path.join(repositoryRoot, 'evidence', 'friend-alpha-bundle-test', 'fixture.txt');

    await mkdir(path.dirname(syntheticEvidence), { recursive: true });
    await writeFile(syntheticSecret, 'SYNTHETIC_TEST_SECRET=not-for-distribution\n', { mode: 0o600 });
    await writeFile(syntheticEvidence, 'synthetic evidence must not ship\n');

    try {
      const firstRun = spawnSync(process.execPath, ['scripts/create-friend-alpha-bundle.mjs', output], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      expect(firstRun.status, `${firstRun.stdout}\n${firstRun.stderr}`).toBe(0);
      expect(firstRun.stdout).toContain(output);
      expect(firstRun.stdout).toMatch(/SHA-256:\s+[a-f0-9]{64}/i);

      const entries = execFileSync('tar', ['-tzf', output], { encoding: 'utf8' }).trim().split('\n')
        .map((entry) => entry.replace(/^\.\//, ''));
      expect(entries).toContain('docs/friend-alpha-local.md');
      expect(entries).toContain('scripts/create-alpha-env.mjs');
      expect(entries).toContain('scripts/create-friend-alpha-bundle.mjs');
      expect(entries).toContain('package.json');
      expect(entries.some((entry) => entry === '.git' || entry.startsWith('.git/'))).toBe(false);
      expect(entries.some((entry) => entry === 'node_modules' || entry.startsWith('node_modules/'))).toBe(false);
      expect(entries.some((entry) => entry === 'evidence' || entry.startsWith('evidence/'))).toBe(false);
      expect(entries.some((entry) => entry.startsWith('.env'))).toBe(false);
      expect(entries.some((entry) => /(^|\/)(dist|build|\.cache)(\/|$)/.test(entry))).toBe(false);

      const secondRun = spawnSync(process.execPath, ['scripts/create-friend-alpha-bundle.mjs', output], {
        cwd: repositoryRoot,
        encoding: 'utf8'
      });
      expect(secondRun.status).not.toBe(0);
      expect(secondRun.stderr).toContain('refuse to overwrite');
    } finally {
      await rm(syntheticSecret, { force: true });
      await rm(path.join(repositoryRoot, 'evidence', 'friend-alpha-bundle-test'), { force: true, recursive: true });
    }
  });
});
