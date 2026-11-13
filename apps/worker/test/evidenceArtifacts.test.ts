import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { validateReadableEvidenceArtifacts } from '../src/evidenceArtifacts.ts';

const validPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
  'base64'
);
const directories: string[] = [];

async function artifact(bytes: Buffer): Promise<{ dir: string; page: { id: string; findings: Array<{ evidence: { screenshot: string } }> } }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-evidence-artifacts-'));
  directories.push(dir);
  await fs.mkdir(path.join(dir, 'pages'));
  await fs.writeFile(path.join(dir, 'pages', 'observation.png'), bytes);
  return { dir, page: { id: 'page-1', findings: [{ evidence: { screenshot: 'pages/observation.png' } }] } };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('durable evidence artifact validation', () => {
  it('accepts a decodable PNG at the durable evidence path', async () => {
    const { dir, page } = await artifact(validPng);
    await expect(validateReadableEvidenceArtifacts(dir, [page])).resolves.toBeUndefined();
  });

  it.each([
    ['signature-only', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['truncated', validPng.subarray(0, validPng.length - 12)],
    ['corrupt', (() => { const corrupt = Buffer.from(validPng); corrupt[45] = corrupt[45]! ^ 0xff; return corrupt; })()]
  ])('rejects a %s PNG instead of completing evidence', async (_kind, bytes) => {
    const { dir, page } = await artifact(bytes);
    await expect(validateReadableEvidenceArtifacts(dir, [page])).rejects.toThrow('Unreadable screenshot artifact');
  });

  it('rejects a CRC-valid PNG with an undecodable IDAT stream', async () => {
    const corrupt = Buffer.from(validPng);
    let changed = false;
    for (let offset = 8; offset < corrupt.length;) {
      const length = corrupt.readUInt32BE(offset);
      const end = offset + 8 + length;
      if (corrupt.toString('ascii', offset + 4, offset + 8) === 'IDAT') {
        corrupt[offset + 8] = 0; // Invalid zlib compression method, intact PNG structure.
        let crc = 0xffffffff;
        for (const byte of corrupt.subarray(offset + 4, end)) {
          crc ^= byte;
          for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
        }
        corrupt.writeUInt32BE((crc ^ 0xffffffff) >>> 0, end);
        changed = true;
        break;
      }
      offset = end + 4;
    }
    expect(changed).toBe(true);
    await expect(sharp(corrupt).metadata()).resolves.toMatchObject({ format: 'png', width: 1, height: 1 });
    await expect(sharp(corrupt, { failOn: 'error' }).raw().toBuffer()).rejects.toThrow();
    const { dir, page } = await artifact(corrupt);
    await expect(validateReadableEvidenceArtifacts(dir, [page])).rejects.toThrow('Unreadable screenshot artifact');
  });

  it('refuses an evidence reference whose durable artifact is absent', async () => {
    const { dir, page } = await artifact(validPng);
    page.findings[0]!.evidence.screenshot = 'pages/other.png';
    await expect(validateReadableEvidenceArtifacts(dir, [page])).rejects.toThrow('Unreadable screenshot artifact');
  });
});
