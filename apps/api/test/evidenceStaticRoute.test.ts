import { mkdir, rm, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { createApp, resolveRuntimeConfig } from '../src/app';
import { EVIDENCE_DIR } from '../src/lib/paths';

describe('local evidence serving', () => {
  it('serves an evidence file under the configured prefix', async () => {
    const filename = 'static-evidence-route-test.txt';
    await mkdir(EVIDENCE_DIR, { recursive: true });
    await writeFile(`${EVIDENCE_DIR}/${filename}`, 'local evidence probe');
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL ??= 'postgresql://test:test@127.0.0.1:5432/test';
    const app = await createApp(resolveRuntimeConfig());
    try {
      const response = await app.inject(`/evidence/${filename}`);
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('local evidence probe');
    } finally {
      await app.close();
      await rm(`${EVIDENCE_DIR}/${filename}`, { force: true });
    }
  });
});
