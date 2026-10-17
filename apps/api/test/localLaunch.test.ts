import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function scriptsAt(relativePath: string): Promise<Record<string, string>> {
  const packageJson = JSON.parse(await readFile(new URL(relativePath, import.meta.url), 'utf8')) as {
    scripts: Record<string, string>;
  };
  return packageJson.scripts;
}

describe('local service launch configuration', () => {
  it('loads a root .env when present without breaking environment-injected starts', async () => {
    const [apiScripts, workerScripts] = await Promise.all([
      scriptsAt('../package.json'),
      scriptsAt('../../worker/package.json')
    ]);

    for (const scripts of [apiScripts, workerScripts]) {
      expect(scripts.start).toContain('if [ -f ../../.env ]');
      expect(scripts.start).toContain('--env-file=../../.env');
      expect(scripts.start).not.toContain('--env-file-if-exists');
      expect(scripts.dev).toContain('if [ -f ../../.env ]');
      expect(scripts.dev).toContain('--env-file=../../.env');
      expect(scripts.dev).not.toContain('--env-file-if-exists');
    }
  });
});
