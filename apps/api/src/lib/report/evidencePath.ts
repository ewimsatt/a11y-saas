import fs, { constants, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { MAX_SCREENSHOT_INPUT_BYTES, processScreenshotBytes } from './image';

const IMMUTABLE_SCREENSHOT = /^pages\/[A-Za-z0-9._-]+\.png$/;

type Image = { base64: string; mime: 'image/png' | 'image/jpeg' };

/** Decode bounded evidence bytes from one already-opened, regular file descriptor. */
export async function readEvidenceScreenshotFromOpenFile(handle: FileHandle): Promise<Image | null> {
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_SCREENSHOT_INPUT_BYTES) return null;
    const bytes = Buffer.allocUnsafe(before.size);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (
      bytesRead !== before.size ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) return null;
    const image = await processScreenshotBytes(bytes);
    return image;
  } catch {
    return null;
  }
}

/**
 * Reads one durable Evidence screenshot without following a symlinked leaf.
 * Evidence storage is API-mounted read-only: parent-directory lstat checks reject
 * pre-existing symlinked parents; the descriptor prevents a leaf replacement from
 * changing the bytes decoded after opening. Concurrent replacement of a trusted
 * mounted parent between validation and open is outside this local alpha boundary.
 */
export async function loadEvidenceScreenshot(evidenceDir: string, relative: string | null | undefined): Promise<Image | null> {
  if (!relative || !IMMUTABLE_SCREENSHOT.test(relative)) return null;
  const root = path.resolve(evidenceDir);
  const pages = path.join(root, 'pages');
  const candidate = path.resolve(root, relative);
  if (!candidate.startsWith(`${root}${path.sep}`)) return null;
  try {
    const [rootInfo, pagesInfo] = await Promise.all([fs.lstat(root), fs.lstat(pages)]);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) return null;
    if (!pagesInfo.isDirectory() || pagesInfo.isSymbolicLink()) return null;
    const handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return await readEvidenceScreenshotFromOpenFile(handle);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
