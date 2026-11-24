import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(path.resolve(import.meta.dirname, '../prisma/migrations/20261119100000_durable_discovery_scope/migration.sql'), 'utf8');

describe('durable discovery identity migration', () => {
  it('does not approximate WHATWG URL identity or silently deduplicate legacy pages', () => {
    expect(migration).not.toMatch(/regexp_match|regexp_replace|DELETE FROM "Page"|UPDATE "Finding"/);
    expect(migration).toContain('ADD COLUMN "urlIdentity" VARCHAR(1000);');
    expect(migration).toContain('WHERE "urlIdentity" IS NOT NULL');
  });

  it('defers legacy canonicalization to the runtime URL implementation before unique identity is enforced', () => {
    expect(migration).toContain('Legacy rows remain NULL until the worker canonicalizes them with the runtime WHATWG policy.');
  });
});
