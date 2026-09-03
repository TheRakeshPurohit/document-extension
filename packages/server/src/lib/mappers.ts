import type { HighlightSpec, Step, SubStep } from '@docext/shared';
import type { schema } from '../db/index.js';

export function toStep(r: typeof schema.steps.$inferSelect): Step {
  const subSteps = JSON.parse(r.subSteps) as SubStep[];
  let highlights: HighlightSpec[] | undefined;
  if (r.highlights) {
    try {
      highlights = JSON.parse(r.highlights) as HighlightSpec[];
    } catch {
      highlights = undefined;
    }
  }
  return {
    ...r,
    screenshotId: r.screenshotId ?? undefined,
    altScreenshotId: r.altScreenshotId ?? undefined,
    beforeLightId: r.beforeLightId ?? undefined,
    beforeDarkId: r.beforeDarkId ?? undefined,
    afterLightId: r.afterLightId ?? undefined,
    afterDarkId: r.afterDarkId ?? undefined,
    sourceEventIds: JSON.parse(r.sourceEventIds) as string[],
    isEdited: !!r.isEdited,
    subSteps: subSteps.length > 0 ? subSteps : undefined,
    mergeWithNextId: r.mergeWithNextId ?? undefined,
    themeCapture: (r.themeCapture as Step['themeCapture']) ?? undefined,
    highlights,
  };
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : 'export';
}
