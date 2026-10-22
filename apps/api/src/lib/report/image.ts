import fs from 'node:fs/promises';
import sharp from 'sharp';

export const MAX_SCREENSHOT_INPUT_BYTES = 20_000_000;
export const MAX_SCREENSHOT_INPUT_PIXELS = 40_000_000;
const THUMBNAIL_WIDTH = 900;
const THUMBNAIL_HEIGHT = 560;

type ProcessedScreenshot = {
  base64: string;
  mime: 'image/jpeg';
};

/**
 * Decode and bound a stored PNG/JPEG before embedding it in a report.
 * The original evidence file is never modified. Tall pages are cropped from the top.
 */
export async function processScreenshotFile(filePath: string): Promise<ProcessedScreenshot | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_SCREENSHOT_INPUT_BYTES) return null;

    const decoder = sharp(filePath, {
      failOn: 'error',
      limitInputPixels: MAX_SCREENSHOT_INPUT_PIXELS,
      sequentialRead: true
    });
    const metadata = await decoder.metadata();
    if (
      (metadata.format !== 'png' && metadata.format !== 'jpeg') ||
      !metadata.width ||
      !metadata.height ||
      metadata.width * metadata.height > MAX_SCREENSHOT_INPUT_PIXELS ||
      (metadata.pages ?? 1) !== 1
    ) {
      return null;
    }

    const output = await decoder
      .rotate()
      .resize({
        width: THUMBNAIL_WIDTH,
        height: THUMBNAIL_HEIGHT,
        fit: 'cover',
        position: 'top',
        withoutEnlargement: true
      })
      .jpeg({ quality: 74, chromaSubsampling: '4:2:0', progressive: true })
      .toBuffer();

    return { base64: output.toString('base64'), mime: 'image/jpeg' };
  } catch {
    return null;
  }
}
