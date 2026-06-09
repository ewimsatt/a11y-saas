import path from 'node:path';

export const EVIDENCE_DIR = path.resolve(
  process.env.EVIDENCE_DIR ?? path.join(process.cwd(), '../../evidence')
);
