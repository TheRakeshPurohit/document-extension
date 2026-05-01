import { Router } from 'express';
import { v4 as uuid } from 'uuid';
import { eq, desc, inArray, count } from 'drizzle-orm';
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
} from '@docext/shared';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

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
      sortOrder: startOrder + i,
    }));

    if (rows.length > 0) {
      await db.insert(schema.events).values(rows);
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

    const events: RecordedEvent[] = eventRows.map((r) => ({
      id: r.id,
      type: r.type as RecordedEvent['type'],
      timestamp: r.timestamp,
      url: r.url,
      pageTitle: r.pageTitle,
      screenshotId: r.screenshotId ?? undefined,
      altScreenshotId: r.altScreenshotId ?? undefined,
      metadata: JSON.parse(r.metadata),
    }));

    const eventById = new Map(events.map((e) => [e.id, e]));

    await db.delete(schema.steps).where(eq(schema.steps.sessionId, req.params.id));

    const steps = generateSteps(req.params.id, events);

    // Annotate screenshots server-side
    for (let stepIdx = 0; stepIdx < steps.length; stepIdx++) {
      const step = steps[stepIdx];
      const sourceEvents = step.sourceEventIds
        .map((id) => eventById.get(id))
        .filter((e): e is RecordedEvent => !!e);

      if (sourceEvents.length === 0) continue;

      const isGrouped = step.subSteps && step.subSteps.length > 1;
      const isFirstStep = stepIdx === 0;

      // Collect element rects and viewport info
      type MetaWithRect = ClickMeta | InputMeta | SelectMeta;
      const rects: Array<{ x: number; y: number; width: number; height: number }> = [];
      let viewportWidth = 0;
      let viewportHeight = 0;

      if (isGrouped && step.subSteps) {
        // For grouped steps, map sub-steps back to their source events to respect skipHighlight
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
          if ((meta as ClickMeta).skipHighlight) break; // user opted out
          if (meta.elementRect) {
            rects.push(meta.elementRect);
            break;
          }
        }
      }

      // Get viewport size from any source event
      for (const ev of sourceEvents) {
        const meta = ev.metadata as MetaWithRect;
        if (meta.viewportSize) {
          viewportWidth = meta.viewportSize.width;
          viewportHeight = meta.viewportSize.height;
          break;
        }
      }

      if (rects.length === 0 || !viewportWidth || !viewportHeight) continue;

      // Build highlights
      const highlights: Highlight[] = rects.map((rect, idx) => ({
        rect,
        number: isGrouped ? idx + 1 : undefined,
      }));

      // Find the raw screenshot to annotate.
      // step.screenshotId (set by step-generator) pinpoints the exact event whose
      // screenshot we want — this is crucial for trigger+ephemeral merges where we
      // need the LAST event's screenshot (popup open), not the first.
      const screenshotEvent =
        (step.screenshotId && sourceEvents.find((e) => e.screenshotId === step.screenshotId)) ||
        sourceEvents.find((e) => e.screenshotId);
      const altScreenshotEvent =
        (step.altScreenshotId && sourceEvents.find((e) => e.altScreenshotId === step.altScreenshotId)) ||
        sourceEvents.find((e) => e.altScreenshotId);

      // Annotate light screenshot
      if (screenshotEvent?.screenshotId) {
        const annotatedId = await annotateAndSave(
          req.params.id, screenshotEvent.screenshotId, highlights, viewportWidth, viewportHeight, isFirstStep,
        );
        if (annotatedId) step.screenshotId = annotatedId;
      }

      // Annotate dark screenshot
      if (altScreenshotEvent?.altScreenshotId) {
        const annotatedId = await annotateAndSave(
          req.params.id, altScreenshotEvent.altScreenshotId, highlights, viewportWidth, viewportHeight, isFirstStep,
        );
        if (annotatedId) step.altScreenshotId = annotatedId;
      }
    }

    if (steps.length > 0) {
      await db.insert(schema.steps).values(
        steps.map((s) => ({
          ...s,
          sourceEventIds: JSON.stringify(s.sourceEventIds),
          subSteps: JSON.stringify(s.subSteps || []),
          mergeWithNextId: s.mergeWithNextId ?? null,
          isEdited: s.isEdited,
        }))
      );
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
  isFirstStep: boolean,
): Promise<string | null> {
  try {
    const ssRow = await db.query.screenshots.findFirst({
      where: eq(schema.screenshots.id, rawScreenshotId),
    });
    if (!ssRow) return null;

    const rawPath = getScreenshotPath(ssRow.filePath);
    const rawBuffer = await fsp.readFile(rawPath);

    const annotatedBuffer = await annotateScreenshot(rawBuffer, {
      highlights,
      viewportWidth,
      viewportHeight,
      isFirstStep,
    });

    const newId = uuid();
    const filePath = await saveScreenshot(sessionId, newId, annotatedBuffer);
    await db.insert(schema.screenshots).values({
      id: newId,
      sessionId,
      filePath,
      createdAt: Date.now(),
    });
    return newId;
  } catch (err) {
    console.warn('Screenshot annotation failed:', err);
    return rawScreenshotId;
  }
}

// Update steps (reorder, edit text, delete) — batch operations
sessionsRouter.put('/:id/steps', async (req, res) => {
  try {
    const { steps, deletedStepIds } = req.body as UpdateStepsRequest;

    // Batch delete with inArray
    if (deletedStepIds && deletedStepIds.length > 0) {
      await db.delete(schema.steps).where(inArray(schema.steps.id, deletedStepIds));
    }

    // Batch updates (still individual but unavoidable without raw SQL)
    if (steps && steps.length > 0) {
      for (const step of steps) {
        await db
          .update(schema.steps)
          .set({
            sortOrder: step.sortOrder,
            title: step.title,
            description: step.description,
            isEdited: true,
          })
          .where(eq(schema.steps.id, step.id));
      }
    }

    await db
      .update(schema.sessions)
      .set({ updatedAt: Date.now() })
      .where(eq(schema.sessions.id, req.params.id));

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

    // Build the raw group for mergeStepGroup
    type MetaWithRect = { elementRect?: { x: number; y: number; width: number; height: number }; viewportSize?: { width: number; height: number }; scrollPosition?: { x: number; y: number } };
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
        sourceEventIds: step.sourceEventIds,
        timestamp: srcEvent?.timestamp ?? 0,
        url: srcEvent?.url,
        elementRect: step.subSteps?.[0]?.elementRect ?? meta.elementRect,
        viewportSize: meta.viewportSize,
        scrollPosition: meta.scrollPosition,
        inEphemeralUI: undefined as boolean | undefined,
        containerRole: undefined as string | undefined,
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
      if (m.viewportSize) { viewportWidth = m.viewportSize.width; viewportHeight = m.viewportSize.height; break; }
    }

    // Build highlights for numbered annotation
    const highlights: Highlight[] = (merged.subSteps || [])
      .flatMap((sub, idx) =>
        sub.elementRect ? [{ rect: sub.elementRect, number: idx + 1 } as Highlight] : []
      );

    // Annotate using last step's RAW screenshot (from its source events, before any
    // prior annotation was baked in).  Falls back to the step's screenshotId if no
    // raw event screenshot is found.
    const lastStep = orderedSteps[orderedSteps.length - 1];
    const lastSourceIds = lastStep.sourceEventIds;
    const lastEvents = eventRows.filter((e) => lastSourceIds.includes(e.id));
    const rawLight = lastEvents.find((e) => e.screenshotId)?.screenshotId ?? lastStep.screenshotId;
    const rawDark  = lastEvents.find((e) => e.altScreenshotId)?.altScreenshotId ?? lastStep.altScreenshotId;

    let newScreenshotId = rawLight;
    let newAltScreenshotId = rawDark;

    if (highlights.length > 0 && viewportWidth && viewportHeight) {
      if (rawLight) {
        const annotatedId = await annotateAndSave(sessionId, rawLight, highlights, viewportWidth, viewportHeight, false);
        if (annotatedId) newScreenshotId = annotatedId;
      }
      if (rawDark) {
        const annotatedId = await annotateAndSave(sessionId, rawDark, highlights, viewportWidth, viewportHeight, false);
        if (annotatedId) newAltScreenshotId = annotatedId;
      }
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
      sourceEventIds: JSON.stringify(merged.sourceEventIds),
      subSteps: JSON.stringify(merged.subSteps || []),
      mergeWithNextId: null,
      isEdited: false,
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

    for (let i = 0; i < remaining.length; i++) {
      await db.update(schema.steps).set({ sortOrder: i }).where(eq(schema.steps.id, remaining[i].id));
    }

    await db.update(schema.sessions).set({ updatedAt: Date.now() }).where(eq(schema.sessions.id, sessionId));

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

    for (const stepId of groupIds) {
      await db
        .update(schema.steps)
        .set({ mergeWithNextId: null })
        .where(eq(schema.steps.id, stepId));
    }

    await db.update(schema.sessions).set({ updatedAt: Date.now() }).where(eq(schema.sessions.id, sessionId));

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
