import type { Step, SubStep } from '@docext/shared';
import type { schema } from '../db/index.js';

export function toStep(r: typeof schema.steps.$inferSelect): Step {
  const subSteps = JSON.parse(r.subSteps) as SubStep[];
  return {
    ...r,
    screenshotId: r.screenshotId ?? undefined,
    altScreenshotId: r.altScreenshotId ?? undefined,
    sourceEventIds: JSON.parse(r.sourceEventIds) as string[],
    isEdited: !!r.isEdited,
    subSteps: subSteps.length > 0 ? subSteps : undefined,
    mergeWithNextId: r.mergeWithNextId ?? undefined,
  };
}

export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned.length > 0 ? cleaned : 'export';
}
