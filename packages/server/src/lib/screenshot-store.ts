import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { DATA_DIR } from '../db/index.js';

const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

/**
 * Detect a WebP file via its first 12 bytes:
 *   bytes 0–3 = "RIFF", bytes 8–11 = "WEBP".
 * Anything else (PNG, JPEG, TIFF — `49 49 2A 00` / `4D 4D 00 2A` —, etc.)
 * is treated as not-WebP and re-encoded.
 */
export function isWebpBuffer(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 12) return false;
  return (
    buffer[0] === 0x52 && // 'R'
    buffer[1] === 0x49 && // 'I'
    buffer[2] === 0x46 && // 'F'
    buffer[3] === 0x46 && // 'F'
    buffer[8] === 0x57 && // 'W'
    buffer[9] === 0x45 && // 'E'
    buffer[10] === 0x42 && // 'B'
    buffer[11] === 0x50    // 'P'
  );
}

/**
 * Encode a buffer to WebP. `force: true` defends against sharp silently
 * passing through the input format (it's the default, but making it explicit
 * keeps the intent obvious if a future sharp upgrade changes defaults).
 * Verifies the output magic bytes; if sharp produced something other than
 * WebP (e.g. on a sharp build missing libwebp, or with a TIFF source), tries
 * once more with PNG → WebP and finally throws if still wrong.
 */
export async function encodeAsWebp(buffer: Buffer, quality = 85): Promise<Buffer> {
  let out = await sharp(buffer).webp({ quality, force: true }).toBuffer();
  if (isWebpBuffer(out)) return out;

  // Defensive second pass: decode to PNG (always supported) then re-encode.
  console.warn('[docext] sharp.webp() did not produce a WebP buffer — retrying via PNG intermediate');
  const pngIntermediate = await sharp(buffer).png().toBuffer();
  out = await sharp(pngIntermediate).webp({ quality, force: true }).toBuffer();
  if (isWebpBuffer(out)) return out;

  throw new Error('Failed to produce a valid WebP buffer (libwebp missing?)');
}

export async function saveScreenshot(
  sessionId: string,
  screenshotId: string,
  buffer: Buffer
): Promise<string> {
  const sessionDir = path.join(SCREENSHOTS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const filePath = path.join(sessionDir, `${screenshotId}.webp`);
  // If the caller already produced WebP bytes (e.g. an annotated buffer from
  // screenshot-annotator), accept them; otherwise force a re-encode here so
  // every file on disk is guaranteed-WebP.
  const out = isWebpBuffer(buffer) ? buffer : await encodeAsWebp(buffer);
  fs.writeFileSync(filePath, out);

  return `${sessionId}/${screenshotId}.webp`;
}

export function getScreenshotPath(relativePath: string): string {
  return path.join(SCREENSHOTS_DIR, relativePath);
}

export function deleteSessionScreenshots(sessionId: string): void {
  const sessionDir = path.join(SCREENSHOTS_DIR, sessionId);
  if (fs.existsSync(sessionDir)) {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

export function screenshotExists(relativePath: string): boolean {
  return fs.existsSync(path.join(SCREENSHOTS_DIR, relativePath));
}

/**
 * Read a screenshot file and ensure its bytes are valid WebP. If not, re-encode
 * in-place and return the re-encoded buffer. Used by the export path so the ZIP
 * never ships disguised-format files.
 */
export async function readScreenshotEnsuringWebp(relativePath: string): Promise<Buffer> {
  const fullPath = getScreenshotPath(relativePath);
  const raw = fs.readFileSync(fullPath);
  if (isWebpBuffer(raw)) return raw;
  console.warn('[docext] On-disk screenshot is not WebP, re-encoding:', relativePath);
  const fixed = await encodeAsWebp(raw);
  fs.writeFileSync(fullPath, fixed);
  return fixed;
}
