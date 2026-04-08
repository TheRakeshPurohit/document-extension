import fs from 'fs';
import path from 'path';
import sharp from 'sharp';
import { DATA_DIR } from '../db/index.js';

const SCREENSHOTS_DIR = path.join(DATA_DIR, 'screenshots');

export async function saveScreenshot(
  sessionId: string,
  screenshotId: string,
  buffer: Buffer
): Promise<string> {
  const sessionDir = path.join(SCREENSHOTS_DIR, sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });

  const filePath = path.join(sessionDir, `${screenshotId}.webp`);
  const converted = await sharp(buffer)
    .webp({ quality: 85 })
    .toBuffer();
  fs.writeFileSync(filePath, converted);

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
