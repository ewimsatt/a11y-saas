#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  symlink
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const forbiddenPath = (entry) => entry.split('/').some((segment) =>
  segment === '.git' ||
  segment === 'node_modules' ||
  segment === 'evidence' ||
  segment === 'dist' ||
  segment === 'build' ||
  segment === '.cache' ||
  segment.startsWith('.env') ||
  segment === '.alpha'
);

const fail = (message) => {
  throw new Error(message);
};

const run = (command, arguments_, options = {}) => {
  const result = spawnSync(command, arguments_, { encoding: 'utf8', ...options });
  if (result.error) fail(`${command} failed to start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} failed: ${result.stderr || result.stdout}`.trim());
  return result.stdout;
};

const repositoryRoot = run('git', ['rev-parse', '--show-toplevel']).trim();
const requestedOutput = process.argv[2];
if (!requestedOutput) {
  fail('Usage: pnpm alpha:bundle /absolute/or-relative/path/friend-alpha-source.tgz');
}

const requestedAbsoluteOutput = path.resolve(process.cwd(), requestedOutput);
const outputParent = path.dirname(requestedAbsoluteOutput);
let canonicalOutputParent;
try {
  canonicalOutputParent = await realpath(outputParent);
} catch {
  fail(`Output directory does not exist: ${outputParent}`);
}
const output = path.join(canonicalOutputParent, path.basename(requestedAbsoluteOutput));
if (!output.endsWith('.tgz') && !output.endsWith('.tar.gz')) {
  fail('Output must end in .tgz or .tar.gz');
}
if (output === repositoryRoot || output.startsWith(`${repositoryRoot}${path.sep}`)) {
  fail('Refuse to write a generated bundle inside the source checkout');
}
try {
  await lstat(output);
  fail(`refuse to overwrite existing output: ${output}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const entries = run('git', ['ls-files', '-z'], { cwd: repositoryRoot })
  .split('\0')
  .filter(Boolean)
  .filter((entry) => !forbiddenPath(entry))
  .sort();
if (!entries.includes('docs/friend-alpha-local.md') || !entries.includes('scripts/create-alpha-env.mjs')) {
  fail('Refuse to bundle without the friend-alpha guide and local environment generator');
}

const staging = await mkdtemp(path.join(os.tmpdir(), 'a11y-friend-alpha-source-'));
try {
  for (const entry of entries) {
    const source = path.join(repositoryRoot, entry);
    const destination = path.join(staging, entry);
    const details = await lstat(source);
    await mkdir(path.dirname(destination), { recursive: true });
    if (details.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
    } else if (details.isFile()) {
      await copyFile(source, destination);
      await chmod(destination, details.mode & 0o777);
    } else {
      fail(`Refuse unsupported tracked source entry: ${entry}`);
    }
  }

  run('tar', ['-czf', output, '-C', staging, '.']);
  const digest = createHash('sha256').update(await readFile(output)).digest('hex');
  console.log(`Friend-alpha source bundle: ${output}`);
  console.log(`SHA-256: ${digest}`);
  console.log(`Inspect: tar -tzf ${JSON.stringify(output)}`);
} catch (error) {
  await rm(output, { force: true });
  throw error;
} finally {
  await rm(staging, { force: true, recursive: true });
}
