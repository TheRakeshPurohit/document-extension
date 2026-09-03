import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { eq, desc, inArray, count, and } from 'drizzle-orm';
import multer from 'multer';
import fsp from 'fs/promises';
import { db, schema } from '../db/index.js';
import { generateSteps, mergeStepGroup } from '../lib/step-generator.js';
import { saveScreenshot, deleteSessionScreenshots, getScreenshotPath } from '../lib/screenshot-store.js';
import { annotateScreenshot, type Highlight } from '../lib/screenshot-annotator.js';
import { toStep } from '../lib/mappers.js';
import type {
  RecordedEvent,
  CreateSessionRequest,
  BatchEventsRequest,
  UpdateStepsRequest,
  ClickMeta,
  InputMeta,
  SelectMeta,
  Step,
  DomEdit,
  HighlightSpec,
} from '@docext/shared';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

type ScreenshotRow = typeof schema.screenshots.$inferSelect;

export const sessionsRouter = Router();

// List all sessions with step count via LEFT JOIN
sessionsRouter.get('/', async (_req, res) => {
  try {
    const rows = await db
      .select({
        id: schema.sessions.id,
        title: schema.sessions.title,
        startUrl: schema.sessions.startUrl,
        createdAt: schema.sessions.createdAt,
        updatedAt: schema.sessions.updatedAt,
        stepCount: count(schema.steps.id),
      })
      .from(schema.sessions)
      .leftJoin(schema.steps, eq(schema.sessions.id, schema.steps.sessionId))
      .groupBy(schema.sessions.id)
      .orderBy(desc(schema.sessions.createdAt));

    res.json({ sessions: rows });
  } catch (err) {
    console.error('List sessions error:', err);
    res.status(500).json({ error: 'Failed to list sessions' });
  }
});

// Create a session
sessionsRouter.post('/', async (req, res) => {
  try {
    const body = req.body as CreateSessionRequest;
    const now = Date.now();
    const session = {
      id: uuid(),
      title: body.title || `Recording ${new Date(now).toLocaleString()}`,
      startUrl: body.startUrl || '',
      createdAt: now,
      updatedAt: now,
    };

    await db.insert(schema.sessions).values(session);
    res.status(201).json({ session });
  } catch (err) {
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// Get a session with steps
sessionsRouter.get('/:id', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const stepRows = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, req.params.id))
      .orderBy(schema.steps.sortOrder);

    res.json({ session, steps: stepRows.map(toStep) });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// Delete a session
sessionsRouter.delete('/:id', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await db.delete(schema.sessions).where(eq(schema.sessions.id, req.params.id));
    deleteSessionScreenshots(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete session' });
  }
});

// Update session title
sessionsRouter.patch('/:id', async (req, res) => {
  try {
    const { title } = req.body;
    if (!title) {
      res.status(400).json({ error: 'Title is required' });
      return;
    }

    const existing = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!existing) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    await db
      .update(schema.sessions)
      .set({ title, updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    res.json({ session: { ...existing, title, updatedAt: Date.now() } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to update session' });
  }
});

async function upsertSessionEdits(
  sessionId: string,
  edits: DomEdit[],
  url?: string,
): Promise<void> {
  if (!edits || edits.length === 0) return;

  const existing = await db
    .select()
    .from(schema.sessionEdits)
    .where(eq(schema.sessionEdits.sessionId, sessionId));
  const bySelector = new Map(existing.map((e) => [e.selector, e]));

  for (const edit of edits) {
    if (!edit.selector) continue;
    const prev = bySelector.get(edit.selector);
    if (prev) {
      await db
        .update(schema.sessionEdits)
        .set({
          original: edit.original,
          modified: edit.modified,
          kind: edit.kind ?? prev.kind ?? 'text',
          url: url ?? prev.url ?? null,
        })
        .where(eq(schema.sessionEdits.id, prev.id));
    } else {
      const row = {
        id: uuid(),
        sessionId,
        selector: edit.selector,
        original: edit.original,
        modified: edit.modified,
        kind: edit.kind ?? 'text',
        url: url ?? null,
        createdAt: Date.now(),
      };
      await db.insert(schema.sessionEdits).values(row);
      bySelector.set(edit.selector, row as typeof existing[0]);
    }
  }
}

// Batch upload events — use COUNT instead of fetching all rows
sessionsRouter.post('/:id/events', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const { events } = req.body as BatchEventsRequest;
    if (!events || !Array.isArray(events)) {
      res.status(400).json({ error: 'Events array is required' });
      return;
    }

    const [{ value: existingCount }] = await db
      .select({ value: count() })
      .from(schema.events)
      .where(eq(schema.events.sessionId, req.params.id));

    const startOrder = existingCount;

    const rows = events.map((e: RecordedEvent, i: number) => ({
      id: e.id,
      sessionId: req.params.id,
      type: e.type,
      timestamp: e.timestamp,
      url: e.url,
      pageTitle: e.pageTitle,
      metadata: JSON.stringify(e.metadata),
      screenshotId: e.screenshotId ?? null,
      altScreenshotId: e.altScreenshotId ?? null,
      afterScreenshotId: e.afterScreenshotId ?? null,
      afterAltScreenshotId: e.afterAltScreenshotId ?? null,
      domEdits: e.domEdits ? JSON.stringify(e.domEdits) : null,
      sortOrder: startOrder + i,
    }));

    if (rows.length > 0) {
      await db.insert(schema.events).values(rows);
    }

    // Upsert any event.domEdits into session_edits (dedupe by session+selector)
    for (const e of events) {
      if (e.domEdits && e.domEdits.length > 0) {
        await upsertSessionEdits(req.params.id, e.domEdits, e.url);
      }
    }

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    res.json({ inserted: rows.length });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload events' });
  }
});

// List session edits
sessionsRouter.get('/:id/edits', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const edits = await db
      .select()
      .from(schema.sessionEdits)
      .where(eq(schema.sessionEdits.sessionId, req.params.id))
      .orderBy(schema.sessionEdits.createdAt);

    res.json({
      edits: edits.map((e) => ({
        id: e.id,
        selector: e.selector,
        original: e.original,
        modified: e.modified,
        kind: e.kind as 'text' | 'hide',
        url: e.url ?? undefined,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list edits' });
  }
});

// Replace/merge session edits from body
sessionsRouter.post('/:id/edits', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const { edits } = req.body as { edits: DomEdit[] };
    if (!edits || !Array.isArray(edits)) {
      res.status(400).json({ error: 'edits array is required' });
      return;
    }

    await upsertSessionEdits(req.params.id, edits);

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    const updated = await db
      .select()
      .from(schema.sessionEdits)
      .where(eq(schema.sessionEdits.sessionId, req.params.id))
      .orderBy(schema.sessionEdits.createdAt);

    res.json({
      edits: updated.map((e) => ({
        id: e.id,
        selector: e.selector,
        original: e.original,
        modified: e.modified,
        kind: e.kind as 'text' | 'hide',
        url: e.url ?? undefined,
        createdAt: e.createdAt,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to save edits' });
  }
});

// Upload screenshot
sessionsRouter.post('/:id/screenshots', upload.single('screenshot'), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'Screenshot file is required' });
      return;
    }

    const sessionId = req.params.id as string;
    const screenshotId = uuid();
    const filePath = await saveScreenshot(sessionId, screenshotId, req.file.buffer);

    await db.insert(schema.screenshots).values({
      id: screenshotId,
      sessionId,
      filePath,
      createdAt: Date.now(),
    });

    res.status(201).json({ screenshotId });
  } catch (err) {
    res.status(500).json({ error: 'Failed to upload screenshot' });
  }
});

function eventRowToRecorded(r: typeof schema.events.$inferSelect): RecordedEvent {
  let domEdits: DomEdit[] | undefined;
  if (r.domEdits) {
    try {
      domEdits = JSON.parse(r.domEdits) as DomEdit[];
    } catch {
      domEdits = undefined;
    }
  }
  return {
    id: r.id,
    type: r.type as RecordedEvent['type'],
    timestamp: r.timestamp,
    url: r.url,
    pageTitle: r.pageTitle,
    screenshotId: r.screenshotId ?? undefined,
    altScreenshotId: r.altScreenshotId ?? undefined,
    afterScreenshotId: r.afterScreenshotId ?? undefined,
    afterAltScreenshotId: r.afterAltScreenshotId ?? undefined,
    metadata: JSON.parse(r.metadata),
    domEdits,
  };
}

function buildStepHighlights(
  step: Step,
  sourceEvents: RecordedEvent[],
): { highlights: Highlight[]; specs: HighlightSpec[]; viewportWidth: number; viewportHeight: number } {
  type MetaWithRect = ClickMeta | InputMeta | SelectMeta;
  const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
  let viewportWidth = 0;
  let viewportHeight = 0;

  const isGrouped = step.subSteps && step.subSteps.length > 1;

  if (isGrouped && step.subSteps) {
    for (let si = 0; si < step.subSteps.length; si++) {
      const sub = step.subSteps[si];
      const srcEv = sourceEvents[si];
      const meta = srcEv?.metadata as MetaWithRect | undefined;
      if (sub.elementRect && !(meta as ClickMeta)?.skipHighlight) {
        rects.push(sub.elementRect);
      }
    }
  } else {
    for (const ev of sourceEvents) {
      const meta = ev.metadata as MetaWithRect;
      if ((meta as ClickMeta).skipHighlight) break;
      if (meta.elementRect) {
        rects.push(meta.elementRect);
        break;
      }
    }
  }

  for (const ev of sourceEvents) {
    const meta = ev.metadata as MetaWithRect;
    if (meta.viewportSize) {
      viewportWidth = meta.viewportSize.width;
      viewportHeight = meta.viewportSize.height;
      break;
    }
  }

  const highlights: Highlight[] = rects.map((rect, idx) => ({
    rect,
    number: isGrouped ? idx + 1 : undefined,
  }));

  const specs: HighlightSpec[] = highlights.map((h) => ({
    rect: h.rect,
    number: h.number,
  }));

  return { highlights, specs, viewportWidth, viewportHeight };
}

function stepInsertValues(s: Step) {
  return {
    id: s.id,
    sessionId: s.sessionId,
    sortOrder: s.sortOrder,
    title: s.title,
    description: s.description,
    screenshotId: s.screenshotId ?? null,
    altScreenshotId: s.altScreenshotId ?? null,
    beforeLightId: s.beforeLightId ?? null,
    beforeDarkId: s.beforeDarkId ?? null,
    afterLightId: s.afterLightId ?? null,
    afterDarkId: s.afterDarkId ?? null,
    sourceEventIds: JSON.stringify(s.sourceEventIds),
    subSteps: JSON.stringify(s.subSteps || []),
    mergeWithNextId: s.mergeWithNextId ?? null,
    isEdited: s.isEdited,
    themeCapture: s.themeCapture ?? null,
    highlights: s.highlights ? JSON.stringify(s.highlights) : null,
  };
}

// Finalize session: generate steps from events, annotate screenshots server-side
sessionsRouter.post('/:id/finalize', async (req, res) => {
  try {
    const session = await db.query.sessions.findFirst({
      where: eq(schema.sessions.id, req.params.id),
    });
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const eventRows = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.sessionId, req.params.id))
      .orderBy(schema.events.sortOrder);

    const events: RecordedEvent[] = eventRows.map(eventRowToRecorded);
    const eventById = new Map(events.map((e) => [e.id, e]));

    await db.delete(schema.steps).where(eq(schema.steps.sessionId, req.params.id));

    const steps = generateSteps(req.params.id, events);

    // Prefetch all session screenshot rows once to avoid N+1
    const ssRows = await db
      .select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.sessionId, req.params.id));
    const ssMap = new Map(ssRows.map((r) => [r.id, r]));

    // Annotate screenshots server-side (light + dark in parallel per step)
    for (const step of steps) {
      const sourceEvents = step.sourceEventIds
        .map((id) => eventById.get(id))
        .filter((e): e is RecordedEvent => !!e);

      if (sourceEvents.length === 0) continue;

      // Preserve raw before IDs; after from last source event's after shots
      const firstEv = sourceEvents[0];
      const lastEv = sourceEvents[sourceEvents.length - 1];

      step.beforeLightId = step.beforeLightId ?? firstEv.screenshotId ?? step.screenshotId;
      step.beforeDarkId = step.beforeDarkId ?? firstEv.altScreenshotId ?? step.altScreenshotId;
      step.afterLightId = step.afterLightId ?? lastEv.afterScreenshotId;
      step.afterDarkId = step.afterDarkId ?? lastEv.afterAltScreenshotId;

      if (!step.themeCapture) {
        const themeMeta = sourceEvents
          .map((e) => (e.metadata as { themeCapture?: 'dual' | 'same' }).themeCapture)
          .find(Boolean);
        if (themeMeta) step.themeCapture = themeMeta;
      }

      const { highlights, specs, viewportWidth, viewportHeight } = buildStepHighlights(step, sourceEvents);
      step.highlights = specs.length > 0 ? specs : undefined;

      if (highlights.length === 0 || !viewportWidth || !viewportHeight) {
        // No annotation — keep raw IDs as primary screenshots
        continue;
      }

      // Annotate from raw before IDs (or merge-source screenshotId when it differs)
      const lightSrc = step.beforeLightId ?? step.screenshotId;
      const darkSrc = step.beforeDarkId ?? step.altScreenshotId;

      // For trigger→ephemeral style steps where screenshotId points at the popup
      // (last event), prefer that as the annotation source while keeping before* raw.
      const annotateLight =
        step.screenshotId && step.screenshotId !== step.beforeLightId
          ? step.screenshotId
          : lightSrc;
      const annotateDark =
        step.altScreenshotId && step.altScreenshotId !== step.beforeDarkId
          ? step.altScreenshotId
          : darkSrc;

      const [annotatedLight, annotatedDark] = await Promise.all([
        annotateLight
          ? annotateAndSave(req.params.id, annotateLight, highlights, viewportWidth, viewportHeight, ssMap)
          : Promise.resolve(null),
        annotateDark
          ? annotateAndSave(req.params.id, annotateDark, highlights, viewportWidth, viewportHeight, ssMap)
          : Promise.resolve(null),
      ]);

      if (annotatedLight) step.screenshotId = annotatedLight;
      if (annotatedDark) step.altScreenshotId = annotatedDark;
    }

    if (steps.length > 0) {
      await db.insert(schema.steps).values(steps.map(stepInsertValues));
    }

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

    res.json({ steps });
  } catch (err) {
    console.error('Finalize error:', err);
    res.status(500).json({ error: 'Failed to finalize session' });
  }
});

async function annotateAndSave(
  sessionId: string,
  rawScreenshotId: string,
  highlights: Highlight[],
  viewportWidth: number,
  viewportHeight: number,
  ssMap?: Map<string, ScreenshotRow>,
): Promise<string | null> {
  try {
    const ssRow = ssMap?.get(rawScreenshotId) ?? await db.query.screenshots.findFirst({
      where: eq(schema.screenshots.id, rawScreenshotId),
    });
    if (!ssRow) return null;

    const rawPath = getScreenshotPath(ssRow.filePath);
    const rawBuffer = await fsp.readFile(rawPath);

    const annotatedBuffer = await annotateScreenshot(rawBuffer, {
      highlights,
      viewportWidth,
      viewportHeight,
    });

    const newId = uuid();
    const filePath = await saveScreenshot(sessionId, newId, annotatedBuffer);
    const row = {
      id: newId,
      sessionId,
      filePath,
      createdAt: Date.now(),
    };
    await db.insert(schema.screenshots).values(row);
    ssMap?.set(newId, row);
    return newId;
  } catch (err) {
    console.warn('Screenshot annotation failed:', err);
    return rawScreenshotId;
  }
}

// Update steps (reorder, edit text, delete) — batch operations in a transaction
sessionsRouter.put('/:id/steps', async (req, res) => {
  try {
    const { steps, deletedStepIds } = req.body as UpdateStepsRequest;

    db.transaction((tx) => {
      if (deletedStepIds && deletedStepIds.length > 0) {
        tx.delete(schema.steps).where(inArray(schema.steps.id, deletedStepIds)).run();
      }

      if (steps && steps.length > 0) {
        for (const step of steps) {
          tx.update(schema.steps)
            .set({
              sortOrder: step.sortOrder,
              title: step.title,
              description: step.description,
              isEdited: true,
            })
            .where(eq(schema.steps.id, step.id))
            .run();
        }
      }

      tx.update(schema.sessions)
        .set({ updatedAt: Date.now() })
        .where(eq(schema.sessions.id, req.params.id))
        .run();
    });

    const updatedSteps = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, req.params.id))
      .orderBy(schema.steps.sortOrder);

    res.json({ steps: updatedSteps.map(toStep) });
  } catch (err) {
    console.error('Update steps error:', err);
    res.status(500).json({ error: 'Failed to update steps' });
  }
});

// Merge a group of steps into one annotated step
// Body: { groupIds: string[] } — ordered list of step IDs (trigger first, ephemerals after)
sessionsRouter.post('/:id/merge-steps', async (req, res) => {
  try {
    const { groupIds } = req.body as { groupIds: string[] };
    if (!groupIds || groupIds.length < 2) {
      res.status(400).json({ error: 'groupIds must have at least 2 step IDs' });
      return;
    }

    const sessionId = req.params.id;

    // Load the steps to merge
    const stepRows = await db
      .select()
      .from(schema.steps)
      .where(inArray(schema.steps.id, groupIds));

    if (stepRows.length !== groupIds.length) {
      res.status(404).json({ error: 'One or more steps not found' });
      return;
    }

    // Sort by groupIds order
    const stepMap = new Map(stepRows.map((r) => [r.id, toStep(r)]));
    const orderedSteps = groupIds.map((id) => stepMap.get(id)!);

    // Load source events for each step
    const allEventIds = orderedSteps.flatMap((s) => s.sourceEventIds);
    const eventRows = await db
      .select()
      .from(schema.events)
      .where(inArray(schema.events.id, allEventIds));
    const eventById = new Map(eventRows.map((r) => [r.id, r]));

    // Prefetch session screenshots
    const ssRows = await db
      .select()
      .from(schema.screenshots)
      .where(eq(schema.screenshots.sessionId, sessionId));
    const ssMap = new Map(ssRows.map((r) => [r.id, r]));

    // Build the raw group for mergeStepGroup
    type MetaWithRect = {
      elementRect?: { x: number; y: number; width: number; height: number };
      viewportSize?: { width: number; height: number };
      scrollPosition?: { x: number; y: number };
    };
    const rawGroup = orderedSteps.map((step) => {
      const srcEvent = step.sourceEventIds
        .map((id) => eventById.get(id))
        .find((e) => !!e);
      const meta = srcEvent ? JSON.parse(srcEvent.metadata) as MetaWithRect : {};
      return {
        title: step.title,
        description: step.description,
        screenshotId: step.screenshotId,
        altScreenshotId: step.altScreenshotId,
        beforeLightId: step.beforeLightId,
        beforeDarkId: step.beforeDarkId,
        afterLightId: step.afterLightId,
        afterDarkId: step.afterDarkId,
        sourceEventIds: step.sourceEventIds,
        timestamp: srcEvent?.timestamp ?? 0,
        url: srcEvent?.url,
        elementRect: step.subSteps?.[0]?.elementRect ?? meta.elementRect,
        viewportSize: meta.viewportSize,
        scrollPosition: meta.scrollPosition,
        inEphemeralUI: undefined as boolean | undefined,
        containerRole: undefined as string | undefined,
        themeCapture: step.themeCapture,
        subSteps: step.subSteps,
      };
    });

    const merged = mergeStepGroup(rawGroup);
    if (!merged) {
      res.status(500).json({ error: 'Failed to merge steps' });
      return;
    }

    // Get viewport from events
    let viewportWidth = 0;
    let viewportHeight = 0;
    for (const evRow of eventRows) {
      const m = JSON.parse(evRow.metadata) as MetaWithRect;
      if (m.viewportSize) {
        viewportWidth = m.viewportSize.width;
        viewportHeight = m.viewportSize.height;
        break;
      }
    }

    // Build highlights for numbered annotation
    const highlights: Highlight[] = (merged.subSteps || [])
      .flatMap((sub, idx) =>
        sub.elementRect ? [{ rect: sub.elementRect, number: idx + 1 } as Highlight] : []
      );
    const highlightSpecs: HighlightSpec[] = highlights.map((h) => ({
      rect: h.rect,
      number: h.number,
    }));

    // Re-annotate from raw before IDs of the last (popup) step in parallel
    const lastStep = orderedSteps[orderedSteps.length - 1];
    const firstStep = orderedSteps[0];
    const lastSourceIds = lastStep.sourceEventIds;
    const lastEvents = eventRows.filter((e) => lastSourceIds.includes(e.id));

    const rawLight =
      lastStep.beforeLightId
      ?? lastEvents.find((e) => e.screenshotId)?.screenshotId
      ?? lastStep.screenshotId;
    const rawDark =
      lastStep.beforeDarkId
      ?? lastEvents.find((e) => e.altScreenshotId)?.altScreenshotId
      ?? lastStep.altScreenshotId;

    const beforeLightId = firstStep.beforeLightId ?? firstStep.screenshotId;
    const beforeDarkId = firstStep.beforeDarkId ?? firstStep.altScreenshotId;
    const afterLightId =
      lastStep.afterLightId
      ?? lastEvents.find((e) => e.afterScreenshotId)?.afterScreenshotId
      ?? rawLight;
    const afterDarkId =
      lastStep.afterDarkId
      ?? lastEvents.find((e) => e.afterAltScreenshotId)?.afterAltScreenshotId
      ?? rawDark;

    let newScreenshotId = rawLight;
    let newAltScreenshotId = rawDark;

    if (highlights.length > 0 && viewportWidth && viewportHeight) {
      const [annotatedLight, annotatedDark] = await Promise.all([
        rawLight
          ? annotateAndSave(sessionId, rawLight, highlights, viewportWidth, viewportHeight, ssMap)
          : Promise.resolve(null),
        rawDark
          ? annotateAndSave(sessionId, rawDark, highlights, viewportWidth, viewportHeight, ssMap)
          : Promise.resolve(null),
      ]);
      if (annotatedLight) newScreenshotId = annotatedLight;
      if (annotatedDark) newAltScreenshotId = annotatedDark;
    }

    // Use the sort order of the first step in the group
    const sortOrder = orderedSteps[0].sortOrder;

    // Insert merged step
    const mergedId = uuid();
    await db.insert(schema.steps).values({
      id: mergedId,
      sessionId,
      sortOrder,
      title: merged.title,
      description: merged.description,
      screenshotId: newScreenshotId ?? null,
      altScreenshotId: newAltScreenshotId ?? null,
      beforeLightId: beforeLightId ?? null,
      beforeDarkId: beforeDarkId ?? null,
      afterLightId: afterLightId ?? null,
      afterDarkId: afterDarkId ?? null,
      sourceEventIds: JSON.stringify(merged.sourceEventIds),
      subSteps: JSON.stringify(merged.subSteps || []),
      mergeWithNextId: null,
      isEdited: false,
      themeCapture: merged.themeCapture ?? firstStep.themeCapture ?? null,
      highlights: highlightSpecs.length > 0 ? JSON.stringify(highlightSpecs) : null,
    });

    // Delete the original steps
    await db.delete(schema.steps).where(inArray(schema.steps.id, groupIds));

    // Any other step that linked to one of the deleted ids now points at a
    // ghost — clear those references so the editor doesn't render orphan
    // merge prompts.
    await db
      .update(schema.steps)
      .set({ mergeWithNextId: null })
      .where(inArray(schema.steps.mergeWithNextId, groupIds));

    // Re-number remaining steps
    const remaining = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, sessionId))
      .orderBy(schema.steps.sortOrder);

    db.transaction((tx) => {
      for (let i = 0; i < remaining.length; i++) {
        tx.update(schema.steps).set({ sortOrder: i }).where(eq(schema.steps.id, remaining[i].id)).run();
      }
      tx.update(schema.sessions).set({ updatedAt: Date.now() }).where(eq(schema.sessions.id, sessionId)).run();
    });

    const finalSteps = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, sessionId))
      .orderBy(schema.steps.sortOrder);

    res.json({ steps: finalSteps.map(toStep) });
  } catch (err) {
    console.error('Merge steps error:', err);
    res.status(500).json({ error: 'Failed to merge steps' });
  }
});

// Keep steps separate — clears mergeWithNextId from a group
// Body: { groupIds: string[] }
sessionsRouter.post('/:id/keep-separate', async (req, res) => {
  try {
    const { groupIds } = req.body as { groupIds: string[] };
    if (!groupIds || groupIds.length === 0) {
      res.status(400).json({ error: 'groupIds is required' });
      return;
    }

    const sessionId = req.params.id;

    db.transaction((tx) => {
      for (const stepId of groupIds) {
        tx.update(schema.steps)
          .set({ mergeWithNextId: null })
          .where(eq(schema.steps.id, stepId))
          .run();
      }
      tx.update(schema.sessions).set({ updatedAt: Date.now() }).where(eq(schema.sessions.id, sessionId)).run();
    });

    const updatedSteps = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, sessionId))
      .orderBy(schema.steps.sortOrder);

    res.json({ steps: updatedSteps.map(toStep) });
  } catch (err) {
    console.error('Keep separate error:', err);
    res.status(500).json({ error: 'Failed to update steps' });
  }
});

// Patch skipHighlight on an event's metadata; update related steps if finalized
sessionsRouter.patch('/:id/events/:eventId/skip-highlight', async (req, res) => {
  try {
    const sessionId = req.params.id;
    const eventId = req.params.eventId;
    const skipHighlight = req.body?.skipHighlight !== false;

    const eventRow = await db.query.events.findFirst({
      where: and(eq(schema.events.id, eventId), eq(schema.events.sessionId, sessionId)),
    });
    if (!eventRow) {
      res.status(404).json({ error: 'Event not found' });
      return;
    }

    const metadata = JSON.parse(eventRow.metadata) as Record<string, unknown>;
    metadata.skipHighlight = skipHighlight;

    await db
      .update(schema.events)
      .set({ metadata: JSON.stringify(metadata) })
      .where(eq(schema.events.id, eventId));

    // If steps already exist, rebuild highlights / re-annotate affected steps
    const stepRows = await db
      .select()
      .from(schema.steps)
      .where(eq(schema.steps.sessionId, sessionId));

    const affected = stepRows.filter((s) => {
      try {
        const ids = JSON.parse(s.sourceEventIds) as string[];
        return ids.includes(eventId);
      } catch {
        return false;
      }
    });

    if (affected.length > 0) {
      const allEventIds = [...new Set(affected.flatMap((s) => JSON.parse(s.sourceEventIds) as string[]))];
      const evRows = allEventIds.length > 0
        ? await db.select().from(schema.events).where(inArray(schema.events.id, allEventIds))
        : [];
      const eventById = new Map(evRows.map((r) => [r.id, eventRowToRecorded(r)]));
      // Ensure the patched event is current
      eventById.set(eventId, eventRowToRecorded({ ...eventRow, metadata: JSON.stringify(metadata) }));

      const ssRows = await db
        .select()
        .from(schema.screenshots)
        .where(eq(schema.screenshots.sessionId, sessionId));
      const ssMap = new Map(ssRows.map((r) => [r.id, r]));

      for (const row of affected) {
        const step = toStep(row);
        const sourceEvents = step.sourceEventIds
          .map((id) => eventById.get(id))
          .filter((e): e is RecordedEvent => !!e);
        const { highlights, specs, viewportWidth, viewportHeight } = buildStepHighlights(step, sourceEvents);

        const lightSrc = step.beforeLightId ?? step.screenshotId;
        const darkSrc = step.beforeDarkId ?? step.altScreenshotId;

        let newLight = step.screenshotId;
        let newDark = step.altScreenshotId;

        if (highlights.length > 0 && viewportWidth && viewportHeight) {
          const [annotatedLight, annotatedDark] = await Promise.all([
            lightSrc
              ? annotateAndSave(sessionId, lightSrc, highlights, viewportWidth, viewportHeight, ssMap)
              : Promise.resolve(null),
            darkSrc
              ? annotateAndSave(sessionId, darkSrc, highlights, viewportWidth, viewportHeight, ssMap)
              : Promise.resolve(null),
          ]);
          if (annotatedLight) newLight = annotatedLight;
          if (annotatedDark) newDark = annotatedDark;
        }

        await db
          .update(schema.steps)
          .set({
            screenshotId: newLight ?? null,
            altScreenshotId: newDark ?? null,
            highlights: specs.length > 0 ? JSON.stringify(specs) : null,
          })
          .where(eq(schema.steps.id, step.id));
      }
    }

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, sessionId));

    res.json({ ok: true, skipHighlight });
  } catch (err) {
    console.error('Skip highlight error:', err);
    res.status(500).json({ error: 'Failed to update skip highlight' });
  }
});
