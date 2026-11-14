import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.dirname(repositoryRoot);
const temporaryPaths = [];

async function createOutputDirectory() {
  const directory = await mkdtemp(path.join(outputRoot, '.friend-alpha-bundle-test-'));
  temporaryPaths.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryPaths.splice(0).map((temporaryPath) => rm(temporaryPath, { force: true, recursive: true })));
});

describe('friend alpha bundle', () => {
  it('stages beside the canonical output directory and removes staging after an archive failure', async () => {
    const outputDirectory = await createOutputDirectory();
    const fakeBin = path.join(outputDirectory, 'fake-bin');
    const archiveArguments = path.join(outputDirectory, 'tar-arguments.txt');
    const output = path.join(outputDirectory, 'friend-alpha.tgz');
    const fakeTar = path.join(fakeBin, 'tar');
    await mkdir(fakeBin);
    await writeFile(fakeTar, '#!/bin/sh\nprintf "%s\\n" "$@" > "$TAR_ARGUMENTS_FILE"\nexit 9\n');
    await chmod(fakeTar, 0o755);

    const result = spawnSync(process.execPath, ['scripts/create-friend-alpha-bundle.mjs', output], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
        TAR_ARGUMENTS_FILE: archiveArguments
      }
    });

    expect(result.status).not.toBe(0);
    const tarArguments = (await (await import('node:fs/promises')).readFile(archiveArguments, 'utf8')).trim().split('\n');
    const stagingDirectory = tarArguments[tarArguments.indexOf('-C') + 1];
    expect(stagingDirectory).toMatch(new RegExp(`^${outputDirectory.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.a11y-friend-alpha-source-`));
    expect(await readdir(outputDirectory)).not.toContain(path.basename(stagingDirectory));
    expect(await readdir(outputDirectory)).not.toContain('friend-alpha.tgz');
  });

  it('creates an inspectable source archive without local secrets or generated artifacts and refuses replacement output', async () => {
    const temporaryDirectory = await createOutputDirectory();
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
