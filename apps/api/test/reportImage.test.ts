import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_SCREENSHOT_INPUT_BYTES, processScreenshotFile } from '../src/lib/report/image';

const dirs: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-report-image-'));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('report screenshot processing', () => {
  it('decodes and creates a bounded top-cropped JPEG without changing the original', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'tall.png');
    const top = await sharp({ create: { width: 1200, height: 700, channels: 3, background: '#c4853e' } })
      .png()
      .toBuffer();
    const bottom = await sharp({ create: { width: 1200, height: 1700, channels: 3, background: '#102030' } })
      .png()
      .toBuffer();
    const original = await sharp({ create: { width: 1200, height: 2400, channels: 3, background: '#ffffff' } })
      .composite([
        { input: top, top: 0, left: 0 },
        { input: bottom, top: 700, left: 0 }
      ])
      .png()
      .toBuffer();
    await fs.writeFile(file, original);

    const result = await processScreenshotFile(file);
    expect(result?.mime).toBe('image/jpeg');
    const output = await sharp(Buffer.from(result!.base64, 'base64')).metadata();
    expect(output.width).toBeLessThanOrEqual(900);
    expect(output.height).toBeLessThanOrEqual(560);
    expect((await fs.readFile(file)).equals(original)).toBe(true);

    const pixel = await sharp(Buffer.from(result!.base64, 'base64')).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(150);
    expect(pixel[1]).toBeGreaterThan(60);
    expect(pixel[2]).toBeLessThan(100);
  });

  it('rejects a corrupt payload with plausible PNG headers', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'corrupt.png');
    const fake = Buffer.alloc(64);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fake);
    fake.writeUInt32BE(1200, 16);
    fake.writeUInt32BE(800, 20);
    await fs.writeFile(file, fake);
    await expect(processScreenshotFile(file)).resolves.toBeNull();
  });

  it('rejects oversized input by stat before opening it for decoding', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'oversized.png');
    await fs.writeFile(file, Buffer.alloc(16));
    await fs.truncate(file, MAX_SCREENSHOT_INPUT_BYTES + 1);
    await expect(processScreenshotFile(file)).resolves.toBeNull();
  });

  it('rejects unsupported decoded formats', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'image.gif');
    await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } })
      .gif()
      .toFile(file);
    await expect(processScreenshotFile(file)).resolves.toBeNull();
  });
});
