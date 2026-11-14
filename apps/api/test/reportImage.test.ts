import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MAX_SCREENSHOT_INPUT_BYTES, processScreenshotBytes } from '../src/lib/report/image';

describe('report screenshot processing', () => {
  it('decodes and creates a bounded top-cropped JPEG without mutating the captured bytes', async () => {
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
    const before = Buffer.from(original);

    const result = await processScreenshotBytes(original);
    expect(result?.mime).toBe('image/jpeg');
    const output = await sharp(Buffer.from(result!.base64, 'base64')).metadata();
    expect(output.width).toBeLessThanOrEqual(900);
    expect(output.height).toBeLessThanOrEqual(560);
    expect(original.equals(before)).toBe(true);

    const pixel = await sharp(Buffer.from(result!.base64, 'base64')).extract({ left: 10, top: 10, width: 1, height: 1 }).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(150);
    expect(pixel[1]).toBeGreaterThan(60);
    expect(pixel[2]).toBeLessThan(100);
  });

  it('accepts valid JPEG bytes and re-encodes them within bounds', async () => {
    const input = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#abcdef' } }).jpeg().toBuffer();
    const result = await processScreenshotBytes(input);
    expect(result?.mime).toBe('image/jpeg');
    await expect(sharp(Buffer.from(result!.base64, 'base64')).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
  });

  it('rejects a corrupt payload with plausible PNG headers', async () => {
    const fake = Buffer.alloc(64);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(fake);
    fake.writeUInt32BE(1200, 16);
    fake.writeUInt32BE(800, 20);
    await expect(processScreenshotBytes(fake)).resolves.toBeNull();
  });

  it('rejects oversized captured bytes before decoding', async () => {
    await expect(processScreenshotBytes(Buffer.alloc(MAX_SCREENSHOT_INPUT_BYTES + 1))).resolves.toBeNull();
  });

  it('rejects unsupported decoded formats and multiple frames', async () => {
    const gif = await sharp({ create: { width: 20, height: 20, channels: 3, background: '#ffffff' } }).gif().toBuffer();
    await expect(processScreenshotBytes(gif)).resolves.toBeNull();
  });
});
