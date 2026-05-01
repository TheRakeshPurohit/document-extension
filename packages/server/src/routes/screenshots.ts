import { Router } from 'express';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { screenshotExists, readScreenshotEnsuringWebp } from '../lib/screenshot-store.js';

export const screenshotsRouter = Router();

screenshotsRouter.get('/:id', async (req, res) => {
  try {
    const row = await db.query.screenshots.findFirst({
      where: eq(schema.screenshots.id, req.params.id),
    });

    if (!row || !screenshotExists(row.filePath)) {
      res.status(404).json({ error: 'Screenshot not found' });
      return;
    }

    // Validate magic bytes; if the file on disk is silently TIFF/PNG/etc.
    // it's re-encoded in place once and then served as guaranteed WebP.
    const buffer = await readScreenshotEnsuringWebp(row.filePath);
    res.type('image/webp').send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get screenshot' });
  }
});
