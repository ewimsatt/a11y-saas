import sharp from 'sharp';

export const MAX_SCREENSHOT_INPUT_BYTES = 20_000_000;
export const MAX_SCREENSHOT_INPUT_PIXELS = 40_000_000;
const THUMBNAIL_WIDTH = 900;
const THUMBNAIL_HEIGHT = 560;

type ProcessedScreenshot = {
  base64: string;
  mime: 'image/jpeg';
};

/** Decode and bound already-read PNG/JPEG bytes before embedding them in a report. */
export async function processScreenshotBytes(input: Buffer): Promise<ProcessedScreenshot | null> {
  try {
    if (input.byteLength <= 0 || input.byteLength > MAX_SCREENSHOT_INPUT_BYTES) return null;
    const decoder = sharp(input, {
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
