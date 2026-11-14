import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCREENSHOT_INPUT_BYTES } from '../src/lib/report/image';
import { loadEvidenceScreenshot, readEvidenceScreenshotFromOpenFile } from '../src/lib/report/evidencePath';

const directories: string[] = [];

async function tempDirectory(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-report-evidence-'));
  directories.push(root);
  return root;
}

async function fixtureRoot(): Promise<string> {
  const root = await tempDirectory();
  await fs.mkdir(path.join(root, 'pages'));
  return root;
}

async function png(color = '#c4853e'): Promise<Buffer> {
  return sharp({ create: { width: 12, height: 12, channels: 3, background: color } }).png().toBuffer();
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('report immutable evidence screenshot lookup', () => {
  it('loads a decodable immutable Evidence reference instead of reconstructing a legacy page filename', async () => {
    const root = await fixtureRoot();
    const relative = 'pages/page-1.2.claim-token.png';
    await fs.writeFile(path.join(root, relative), await png());

    const image = await loadEvidenceScreenshot(root, relative);

    expect(image?.mime).toBe('image/jpeg');
    expect(Buffer.from(image!.base64, 'base64').byteLength).toBeGreaterThan(20);
  });

  it('rejects traversal, absolute, nested, malformed, and missing references', async () => {
    const root = await fixtureRoot();
    await expect(loadEvidenceScreenshot(root, '../outside.png')).resolves.toBeNull();
    await expect(loadEvidenceScreenshot(root, path.join(root, 'pages', 'absolute.png'))).resolves.toBeNull();
    await expect(loadEvidenceScreenshot(root, 'pages/nested/image.png')).resolves.toBeNull();
    await expect(loadEvidenceScreenshot(root, 'pages/image.jpeg')).resolves.toBeNull();
    await expect(loadEvidenceScreenshot(root, 'pages/missing.png')).resolves.toBeNull();
  });

  it('rejects empty, directory, symlinked, and oversized leaves before decode', async () => {
    const root = await fixtureRoot();
    await fs.writeFile(path.join(root, 'pages', 'empty.png'), Buffer.alloc(0));
    await fs.mkdir(path.join(root, 'pages', 'directory.png'));
    const outside = path.join(root, 'outside.png');
    await fs.writeFile(outside, await png('#abcdef'));
    await fs.symlink(outside, path.join(root, 'pages', 'linked.png'));
    const oversized = path.join(root, 'pages', 'oversized.png');
    await fs.writeFile(oversized, Buffer.alloc(1));
    await fs.truncate(oversized, MAX_SCREENSHOT_INPUT_BYTES + 1);

    for (const name of ['empty.png', 'directory.png', 'linked.png', 'oversized.png']) {
      await expect(loadEvidenceScreenshot(root, `pages/${name}`)).resolves.toBeNull();
    }
  });

  it('rejects a symlinked evidence root and a symlinked pages directory', async () => {
    const base = await tempDirectory();
    const target = path.join(base, 'target');
    await fs.mkdir(path.join(target, 'pages'), { recursive: true });
    await fs.writeFile(path.join(target, 'pages', 'fixture.png'), await png());
    const linkedRoot = path.join(base, 'linked-root');
    await fs.symlink(target, linkedRoot);
    await expect(loadEvidenceScreenshot(linkedRoot, 'pages/fixture.png')).resolves.toBeNull();

    const root = path.join(base, 'root');
    await fs.mkdir(root);
    await fs.symlink(path.join(target, 'pages'), path.join(root, 'pages'));
    await expect(loadEvidenceScreenshot(root, 'pages/fixture.png')).resolves.toBeNull();
  });

  it('decodes the already-opened inode after its pathname is replaced by a symlink', async () => {
    const root = await fixtureRoot();
    const relative = 'pages/page-1.2.claim-token.png';
    const leaf = path.join(root, relative);
    const outside = path.join(root, 'outside.png');
    const original = await png('#c4853e');
    await fs.writeFile(leaf, original);
    await fs.writeFile(outside, await png('#102030'));
    const handle = await fs.open(leaf, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      await fs.rm(leaf);
      await fs.symlink(outside, leaf);
      const image = await readEvidenceScreenshotFromOpenFile(handle);
      expect(image?.mime).toBe('image/jpeg');
      const pixel = await sharp(Buffer.from(image!.base64, 'base64')).removeAlpha().raw().toBuffer();
      expect(pixel[0]).toBeGreaterThan(150);
    } finally {
      await handle.close();
    }
  });

  it('rejects growth, truncation, or metadata changes detected after the bounded read', async () => {
    const bytes = await png();
    const before = { isFile: () => true, size: bytes.length, dev: 1, ino: 2, mtimeMs: 3, ctimeMs: 4 };
    for (const after of [
      { ...before, size: bytes.length + 1 },
      { ...before, size: bytes.length - 1 },
      { ...before, mtimeMs: 5 },
      { ...before, ino: 9 }
    ]) {
      const handle = {
        stat: vi.fn().mockResolvedValueOnce(before).mockResolvedValueOnce(after),
        read: vi.fn(async (buffer: Buffer) => {
          bytes.copy(buffer);
          return { bytesRead: bytes.length, buffer };
        })
      } as unknown as FileHandle;
      await expect(readEvidenceScreenshotFromOpenFile(handle)).resolves.toBeNull();
    }
  });
});
