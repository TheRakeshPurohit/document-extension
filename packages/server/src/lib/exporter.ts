import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import archiver from 'archiver';
import { Writable } from 'stream';
import type { Step, Session } from '@docext/shared';
import { getScreenshotPath, screenshotExists, readScreenshotEnsuringWebp } from './screenshot-store.js';
import { db, schema } from '../db/index.js';
import { eq, inArray } from 'drizzle-orm';

interface ExportData {
  session: Session;
  steps: Step[];
}

async function loadScreenshotBase64(screenshotId: string): Promise<string | null> {
  const row = await db.query.screenshots.findFirst({
    where: eq(schema.screenshots.id, screenshotId),
  });
  if (!row) return null;

  if (!screenshotExists(row.filePath)) return null;

  // Self-heal disguised files before embedding them as data URLs.
  const buffer = await readScreenshotEnsuringWebp(row.filePath);
  return `data:image/webp;base64,${buffer.toString('base64')}`;
}

async function exportHtml(data: ExportData, inline = true): Promise<string> {
  const stepsHtml: string[] = [];

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    let imgTag = '';

    if (step.screenshotId) {
      if (inline) {
        const b64 = await loadScreenshotBase64(step.screenshotId);
        if (b64) {
          imgTag = `<img src="${b64}" alt="Step ${i + 1}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0;" />`;
        }
      } else {
        imgTag = `<img src="screenshots/${step.screenshotId}.webp" alt="Step ${i + 1}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0;" />`;
      }
    }

    let subStepsHtml = '';
    if (step.subSteps && step.subSteps.length > 0) {
      const items = step.subSteps.map((sub, idx) =>
        `<li style="margin-bottom:4px;"><strong>${idx + 1}.</strong> ${escapeHtml(sub.title)}</li>`
      ).join('\n');
      subStepsHtml = `<ol style="padding-left:0;list-style:none;margin:8px 0;">${items}</ol>`;
    }

    stepsHtml.push(`
      <div style="margin-bottom:32px;">
        <h2 style="font-size:1.2em;margin-bottom:8px;">Step ${i + 1}: ${escapeHtml(step.title)}</h2>
        ${step.description ? `<p style="color:#4a5568;margin-bottom:8px;">${escapeHtml(step.description)}</p>` : ''}
        ${subStepsHtml}
        ${imgTag}
      </div>
    `);
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(data.session.title)}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 40px 20px;
      color: #1a202c;
      line-height: 1.6;
    }
    h1 { font-size: 1.8em; margin-bottom: 4px; }
    .meta { color: #718096; font-size: 0.9em; margin-bottom: 24px; }
    hr { border: none; border-top: 1px solid #e2e8f0; margin: 24px 0; }
    @media print {
      body { padding: 20px; }
      div { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <h1>${escapeHtml(data.session.title)}</h1>
  <p class="meta">
    Recorded from <a href="${escapeHtml(data.session.startUrl)}">${escapeHtml(data.session.startUrl)}</a><br/>
    Date: ${new Date(data.session.createdAt).toLocaleDateString()}
  </p>
  <hr />
  ${stepsHtml.join('\n')}
</body>
</html>`;
}

export async function exportZip(
  data: ExportData,
  format: 'markdown' | 'html'
): Promise<Buffer> {
  const mainImageNameByStep = new Map<number, string>();
  const altImageNameByStep = new Map<number, string>();
  const totalSteps = data.steps.length;
  const padWidth = Math.max(2, String(totalSteps).length);
  for (let i = 0; i < data.steps.length; i++) {
    const stepNo = i + 1;
    const stepLabel = String(stepNo).padStart(padWidth, '0');
    if (data.steps[i].screenshotId) mainImageNameByStep.set(i, `step${stepLabel}-light.webp`);
    if (data.steps[i].altScreenshotId) altImageNameByStep.set(i, `step${stepLabel}-dark.webp`);
  }

  const content = format === 'markdown'
    ? buildMarkdownForZip(data, mainImageNameByStep, altImageNameByStep)
    : await exportHtml(data, false);

  const idToZipName = new Map<string, string>();
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    const mainName = mainImageNameByStep.get(i);
    const altName = altImageNameByStep.get(i);
    if (step.screenshotId && mainName) idToZipName.set(step.screenshotId, mainName);
    if (step.altScreenshotId && altName) idToZipName.set(step.altScreenshotId, altName);
  }

  const screenshotIds = [...idToZipName.keys()];
  const screenshotRows = screenshotIds.length > 0
    ? await db
      .select({ id: schema.screenshots.id, filePath: schema.screenshots.filePath })
      .from(schema.screenshots)
      .where(inArray(schema.screenshots.id, screenshotIds))
    : [];

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const writable = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    });

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', reject);
    writable.on('finish', () => resolve(Buffer.concat(chunks)));

    archive.pipe(writable);

    const ext = format === 'markdown' ? 'md' : 'html';
    archive.append(content, { name: `documentation.${ext}` });

    // Add screenshot files with friendly names (step01-light.webp / step01-dark.webp).
    // We validate each file's magic bytes before adding to the archive — any
    // file that's silently TIFF/PNG/etc. on disk gets re-encoded in place so
    // the ZIP only ever contains real WebP under .webp filenames.
    Promise.all(
      screenshotRows.map(async (row) => {
        const zipName = idToZipName.get(row.id);
        if (!zipName) return;
        const fullPath = getScreenshotPath(row.filePath);
        if (!fs.existsSync(fullPath)) return;
        try {
          const buf = await readScreenshotEnsuringWebp(row.filePath);
          archive.append(buf, { name: `screenshots/${zipName}` });
        } catch (err) {
          console.warn('[docext] Skipping invalid screenshot in export:', row.filePath, err);
        }
      })
    )
      .then(() => archive.finalize())
      .catch((err) => {
        archive.abort();
        reject(err);
      });
  });
}

function buildMarkdownForZip(
  data: ExportData,
  mainImageNameByStep: Map<number, string>,
  altImageNameByStep: Map<number, string>,
): string {
  const lines: string[] = [];
  lines.push(`# ${data.session.title}`);
  lines.push('');
  lines.push(`> Recorded from [${data.session.startUrl}](${data.session.startUrl})`);
  lines.push(`> Date: ${new Date(data.session.createdAt).toLocaleDateString()}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    lines.push(`## Step ${i + 1}: ${step.title}`);
    lines.push('');

    if (step.description) {
      lines.push(step.description);
      lines.push('');
    }

    if (step.subSteps && step.subSteps.length > 0) {
      for (let s = 0; s < step.subSteps.length; s++) {
        lines.push(`${s + 1}. ${step.subSteps[s].title}`);
      }
      lines.push('');
    }

    const mainImageName = mainImageNameByStep.get(i);
    if (mainImageName) {
      lines.push(`![Step ${i + 1} - Light](screenshots/${mainImageName})`);
      lines.push('');
    }

    const altImageName = altImageNameByStep.get(i);
    if (altImageName) {
      lines.push(`![Step ${i + 1} - Dark](screenshots/${altImageName})`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
