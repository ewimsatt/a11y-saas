import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';

export type EvidenceArtifactPage = {
  id: string;
  findings: Array<{ evidence: { screenshot: string } | null }>;
};

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function artifactPath(evidenceDir: string, relative: string): string {
  if (!/^pages\/[A-Za-z0-9._-]+\.png$/.test(relative)) {
    throw new Error(`Unsafe evidence artifact path ${relative}`);
  }
  return path.join(evidenceDir, relative);
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function assertCompletePng(bytes: Buffer): void {
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) throw new Error('missing signature');
  let offset = PNG_SIGNATURE.length;
  let sawIend = false;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw new Error('truncated chunk header');
    const length = bytes.readUInt32BE(offset);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + length;
    if (chunkEnd + 4 > bytes.length) throw new Error('truncated chunk payload');
    const type = bytes.subarray(offset + 4, offset + 8);
    if (bytes.readUInt32BE(chunkEnd) !== crc32(bytes.subarray(offset + 4, chunkEnd))) throw new Error('invalid chunk checksum');
    offset = chunkEnd + 4;
    if (type.equals(Buffer.from('IEND'))) {
      if (length !== 0 || offset !== bytes.length) throw new Error('invalid IEND');
      sawIend = true;
    }
  }
  if (!sawIend) throw new Error('missing IEND');
}

async function assertReadablePng(filename: string, pageId: string): Promise<void> {
  try {
    const bytes = await fs.readFile(filename);
    assertCompletePng(bytes);
    const image = sharp(bytes, { failOn: 'error' });
    const metadata = await image.metadata();
    if (metadata.format !== 'png' || !metadata.width || !metadata.height) throw new Error('unsupported image structure');
    // Metadata alone does not decode IDAT. Completion requires readable pixels.
    await image.raw().toBuffer();
  } catch {
    throw new Error(`Unreadable screenshot artifact for analyzed page ${pageId}`);
  }
}

/** Completion gate for every durable evidence reference. */
export async function validateReadableEvidenceArtifacts(
  evidenceDir: string,
  pages: EvidenceArtifactPage[]
): Promise<void> {
  for (const page of pages) {
    const paths = new Set<string>();
    for (const finding of page.findings) {
      if (finding.evidence) paths.add(finding.evidence.screenshot);
    }
    for (const relative of paths) {
      await assertReadablePng(artifactPath(evidenceDir, relative), page.id);
    }
  }
}
