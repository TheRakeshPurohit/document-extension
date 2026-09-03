import fs from 'fs';
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

type ScreenshotRow = { id: string; filePath: string };

async function loadScreenshotMap(ids: string[]): Promise<Map<string, ScreenshotRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: schema.screenshots.id, filePath: schema.screenshots.filePath })
    .from(schema.screenshots)
    .where(inArray(schema.screenshots.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

async function loadScreenshotBase64(
  screenshotId: string,
  ssMap?: Map<string, ScreenshotRow>,
): Promise<string | null> {
  const row = ssMap?.get(screenshotId) ?? await db.query.screenshots.findFirst({
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

  const allIds = data.steps.flatMap((s) =>
    [s.screenshotId, s.altScreenshotId, s.afterLightId, s.afterDarkId].filter((id): id is string => !!id),
  );
  const ssMap = inline ? await loadScreenshotMap(allIds) : undefined;

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    let imgTag = '';

    if (step.screenshotId) {
      if (inline) {
        const b64 = await loadScreenshotBase64(step.screenshotId, ssMap);
        if (b64) {
          imgTag = `<img src="${b64}" alt="Step ${i + 1}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0;" />`;
        }
      } else {
        imgTag = `<img src="screenshots/${step.screenshotId}.webp" alt="Step ${i + 1}" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0;" />`;
      }
    }

    let afterImgTag = '';
    if (step.afterLightId) {
      if (inline) {
        const b64 = await loadScreenshotBase64(step.afterLightId, ssMap);
        if (b64) {
          afterImgTag = `<h3 style="font-size:1em;margin:16px 0 8px;">Result</h3><img src="${b64}" alt="Step ${i + 1} result" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0;" />`;
        }
      } else {
        afterImgTag = `<h3 style="font-size:1em;margin:16px 0 8px;">Result</h3><img src="screenshots/${step.afterLightId}.webp" alt="Step ${i + 1} result" style="max-width:100%;border:1px solid #e2e8f0;border-radius:8px;margin:12px 0;" />`;
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
        ${afterImgTag}
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

interface StepImageNames {
  main?: string;
  alt?: string;
  cleanLight?: string;
  cleanDark?: string;
  afterLight?: string;
  afterDark?: string;
}

export async function exportZip(
  data: ExportData,
  format: 'markdown' | 'html'
): Promise<Buffer> {
  const imageNamesByStep = new Map<number, StepImageNames>();
  const totalSteps = data.steps.length;
  const padWidth = Math.max(2, String(totalSteps).length);

  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    const stepLabel = String(i + 1).padStart(padWidth, '0');
    const names: StepImageNames = {};
    if (step.screenshotId) names.main = `step${stepLabel}-light.webp`;
    if (step.altScreenshotId) names.alt = `step${stepLabel}-dark.webp`;
    if (step.beforeLightId && step.beforeLightId !== step.screenshotId) {
      names.cleanLight = `step${stepLabel}-clean-light.webp`;
    }
    if (step.beforeDarkId && step.beforeDarkId !== step.altScreenshotId) {
      names.cleanDark = `step${stepLabel}-clean-dark.webp`;
    }
    if (step.afterLightId) names.afterLight = `step${stepLabel}-after-light.webp`;
    if (step.afterDarkId) names.afterDark = `step${stepLabel}-after-dark.webp`;
    imageNamesByStep.set(i, names);
  }

  const content = format === 'markdown'
    ? buildMarkdownForZip(data, imageNamesByStep)
    : await exportHtml(data, false);

  const idToZipName = new Map<string, string>();
  for (let i = 0; i < data.steps.length; i++) {
    const step = data.steps[i];
    const names = imageNamesByStep.get(i)!;
    if (step.screenshotId && names.main) idToZipName.set(step.screenshotId, names.main);
    if (step.altScreenshotId && names.alt) idToZipName.set(step.altScreenshotId, names.alt);
    if (step.beforeLightId && names.cleanLight) idToZipName.set(step.beforeLightId, names.cleanLight);
    if (step.beforeDarkId && names.cleanDark) idToZipName.set(step.beforeDarkId, names.cleanDark);
    if (step.afterLightId && names.afterLight) idToZipName.set(step.afterLightId, names.afterLight);
    if (step.afterDarkId && names.afterDark) idToZipName.set(step.afterDarkId, names.afterDark);
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
  imageNamesByStep: Map<number, StepImageNames>,
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
    const names = imageNamesByStep.get(i) || {};
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

    if (names.main) {
      lines.push(`![Step ${i + 1} - Light](screenshots/${names.main})`);
      lines.push('');
    }

    if (names.alt) {
      lines.push(`![Step ${i + 1} - Dark](screenshots/${names.alt})`);
      lines.push('');
    }

    if (names.afterLight || names.afterDark) {
      lines.push('### Result');
      lines.push('');
      if (names.afterLight) {
        lines.push(`![Step ${i + 1} - After Light](screenshots/${names.afterLight})`);
        lines.push('');
      }
      if (names.afterDark) {
        lines.push(`![Step ${i + 1} - After Dark](screenshots/${names.afterDark})`);
        lines.push('');
      }
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
