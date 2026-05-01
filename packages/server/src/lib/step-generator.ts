import { v4 as uuid } from 'uuid';
import type {
  RecordedEvent,
  ClickMeta,
  InputMeta,
  SelectMeta,
  NavigateMeta,
  SubmitMeta,
  ModalMeta,
  Step,
  SubStep,
} from '@docext/shared';

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RawStep {
  title: string;
  description: string;
  screenshotId?: string;
  altScreenshotId?: string;
  sourceEventIds: string[];
  timestamp: number;
  url?: string;
  elementRect?: Rect;
  scrollPosition?: { x: number; y: number };
  viewportSize?: { width: number; height: number };
  inEphemeralUI?: boolean;
  containerRole?: string;
  subSteps?: SubStep[];
  mergeWithNextId?: string;
}

function truncate(text: string, max = 50): string {
  text = text.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function quote(text: string): string {
  return `"${truncate(text)}"`;
}

function cleanLabel(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function humanizeId(id: string): string {
  return id
    .replace(/[-_]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
}

function locationHint(meta: { containerRole?: string; sectionLabel?: string; nearestHeading?: string; parentId?: string; parentName?: string; viewportHint?: string }): string {
  if (meta.sectionLabel) return ` in the ${cleanLabel(meta.sectionLabel)} section`;
  if (meta.containerRole === 'navigation') return ' in the navigation';
  if (meta.containerRole === 'toolbar') return ' in the toolbar';
  if (meta.containerRole === 'dialog') return ' in the dialog';
  if (meta.containerRole === 'menu') return ' from the menu';
  if (meta.containerRole === 'header') return ' in the header';
  if (meta.containerRole === 'footer') return ' in the footer';
  if (meta.containerRole === 'sidebar') return ' in the sidebar';
  if (meta.containerRole === 'form') return ' in the form';
  if (meta.containerRole === 'search') return ' in the search area';
  if (meta.parentName) return ` in the ${truncate(meta.parentName, 30)} area`;
  if (meta.parentId) {
    const name = humanizeId(meta.parentId);
    if (name.length > 1) return ` in the ${name} section`;
  }
  if (meta.viewportHint) return ` in the ${meta.viewportHint}`;
  return '';
}

function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

const SENSITIVE_FIELDS = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

function bestLabel(m: ClickMeta): string {
  if (m.ariaLabel) return m.ariaLabel;
  if (m.elementText && m.elementText.length > 1 && m.elementText !== m.elementTag) return m.elementText;
  if (m.fieldLabel) return m.fieldLabel;
  if (m.title) return m.title;
  if (m.tooltipText) return m.tooltipText;
  if (m.parentText && m.parentText.length > 1) return m.parentText;
  if (m.parentName && m.parentName.length > 1) return m.parentName;
  return '';
}

function titleForClick(m: ClickMeta): string {
  const label = bestLabel(m);
  const loc = locationHint(m);

  if (m.elementTag === 'a' || m.href) {
    if (label) return `Click the ${quote(label)} link${loc}`;
    return `Click a link${loc}`;
  }

  if (m.elementTag === 'button' || m.role === 'button') {
    if (label) return `Click the ${quote(label)} button${loc}`;
    return `Click a button${loc}`;
  }

  if (m.role === 'tab') {
    return `Select the ${quote(label || 'tab')} tab${loc}`;
  }

  if (m.role === 'menuitem' || m.role === 'menuitemcheckbox' || m.role === 'menuitemradio') {
    return `Choose ${quote(label || 'item')} from the menu`;
  }

  if (m.role === 'checkbox' || m.role === 'switch') {
    const fieldHint = m.fieldLabel ? quote(m.fieldLabel) : quote(label || 'option');
    return `Toggle the ${fieldHint} checkbox${loc}`;
  }

  if (m.role === 'radio') {
    const fieldHint = m.fieldLabel ? quote(m.fieldLabel) : quote(label || 'option');
    return `Select the ${fieldHint} option${loc}`;
  }

  if (m.elementTag === 'input' || m.elementTag === 'select' || m.elementTag === 'textarea') {
    const fieldName = m.fieldLabel || m.ariaLabel || m.title || 'field';
    return `Click the ${quote(fieldName)} field${loc}`;
  }

  if (['img', 'svg', 'icon'].includes(m.elementTag)) {
    if (m.ariaLabel) return `Click the ${quote(m.ariaLabel)} icon${loc}`;
    if (m.tooltipText) return `Click the ${quote(m.tooltipText)} icon${loc}`;
    if (m.parentText) return `Click the ${quote(m.parentText)} icon${loc}`;
    if (m.parentName) return `Click the icon in ${quote(m.parentName)}${loc}`;
    if (m.nearbyText) return `Click the icon next to ${quote(m.nearbyText)}${loc}`;
    if (m.nearestHeading) return `Click an icon near ${quote(m.nearestHeading)}${loc}`;
    return `Click an icon${loc}`;
  }

  if (!label || label === m.elementTag) {
    if (m.nearbyText) return `Click next to ${quote(m.nearbyText)}${loc}`;
    if (m.nearestHeading) return `Click near ${quote(m.nearestHeading)}${loc}`;
    return `Click an element${loc}`;
  }

  return `Click ${quote(label)}${loc}`;
}

function titleForInput(m: InputMeta, group: RecordedEvent[]): string {
  const rawLabel = m.fieldLabel && m.fieldLabel !== m.selector ? cleanLabel(m.fieldLabel) : '';
  const label = rawLabel || m.placeholder || 'field';
  const loc = locationHint(m);
  const lastEvent = group[group.length - 1];
  const lastMeta = lastEvent.metadata as InputMeta;
  const finalValue = lastMeta.value || m.value;

  if (m.fieldType === 'password' || SENSITIVE_FIELDS.test(label) || SENSITIVE_FIELDS.test(m.selector)) {
    return `Enter a password in the ${quote(label)} field${loc}`;
  }

  if (m.fieldType === 'email' || /email/i.test(label)) {
    if (finalValue && !SENSITIVE_FIELDS.test(finalValue)) return `Enter email ${quote(finalValue)} in the ${quote(label)} field${loc}`;
    return `Enter an email address in the ${quote(label)} field${loc}`;
  }

  if (m.fieldType === 'search' || /search/i.test(label)) {
    if (finalValue) return `Search for ${quote(finalValue)}${loc}`;
    return `Type in the search field${loc}`;
  }

  if (m.fieldType === 'textarea') {
    if (finalValue) {
      const preview = truncate(finalValue, 40);
      return `Type ${quote(preview)} in the ${quote(label)} text area${loc}`;
    }
    return `Type in the ${quote(label)} text area${loc}`;
  }

  if (finalValue) {
    return `Type ${quote(finalValue)} in the ${quote(label)} field${loc}`;
  }

  return `Type in the ${quote(label)} field${loc}`;
}

function titleForSelect(m: SelectMeta): string {
  const label = m.fieldLabel && m.fieldLabel !== m.selector ? cleanLabel(m.fieldLabel) : 'dropdown';
  const loc = locationHint(m);
  return `Select ${quote(m.selectedOption)} from the ${quote(label)} dropdown${loc}`;
}

function titleForNavigate(m: NavigateMeta, isFinal: boolean): string {
  if (isFinal) return 'Final state';
  return !m.fromUrl ? 'Page loaded' : 'Navigate to a new page';
}

function titleForSubmit(m: SubmitMeta): string {
  if (m.formName) {
    return `Submit the ${quote(m.formName)} form`;
  }
  const loc = m.nearestHeading ? ` (${truncate(m.nearestHeading, 30)})` : '';
  return `Submit the form${loc}`;
}

function titleForModal(m: ModalMeta): string {
  if (m.action === 'close') return 'Close the dialog';
  if (m.dialogText) return `A dialog appears: ${quote(m.dialogText)}`;
  return 'A dialog appears';
}

function alreadyInTitle(titleLower: string, text: string | undefined): boolean {
  if (!text || text.length < 2) return true;
  return titleLower.includes(text.toLowerCase());
}

function humanizeClasses(classes: string): string {
  return classes
    .split(', ')
    .map((c) => c.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase())
    .join(', ');
}

function descriptionForEvent(event: RecordedEvent, title: string): string {
  const parts: string[] = [];
  const meta = event.metadata;
  const tl = title.toLowerCase();

  switch (event.type) {
    case 'click': {
      const m = meta as ClickMeta;
      if (m.breadcrumb) parts.push(`Found in ${m.breadcrumb}`);
      if (m.viewportHint && !alreadyInTitle(tl, m.viewportHint)) {
        parts.push(`Located in the ${m.viewportHint}`);
      }
      if (m.listPosition) {
        const [pos, total] = m.listPosition.split(' of ');
        parts.push(`${ordinal(Number(pos))} item in a list of ${total}`);
      }
      if (m.parentName && !alreadyInTitle(tl, m.parentName)) {
        parts.push(`Inside the "${truncate(m.parentName, 40)}" area`);
      }
      if (m.nearbyText && !alreadyInTitle(tl, m.nearbyText)) {
        parts.push(`Next to "${truncate(m.nearbyText, 40)}"`);
      }
      if (m.tooltipText && m.tooltipText !== m.ariaLabel && !alreadyInTitle(tl, m.tooltipText)) {
        parts.push(`Shows "${truncate(m.tooltipText, 50)}" on hover`);
      }
      if (m.nearestHeading && !alreadyInTitle(tl, m.nearestHeading)) {
        parts.push(`Under the "${truncate(m.nearestHeading, 40)}" heading`);
      }
      if (m.semanticClasses) {
        parts.push(`Styled as ${humanizeClasses(m.semanticClasses)}`);
      }
      const elType = m.role || m.elementTag;
      if (elType && !['div', 'span', 'p'].includes(elType)) parts.push(`${elType} element`);
      break;
    }
    case 'input': {
      const m = meta as InputMeta;
      if (m.breadcrumb) parts.push(`Found in ${m.breadcrumb}`);
      if (m.listPosition) {
        const [pos, total] = m.listPosition.split(' of ');
        parts.push(`${ordinal(Number(pos))} field in a group of ${total}`);
      }
      if (m.placeholder && !alreadyInTitle(tl, m.placeholder)) {
        parts.push(`Placeholder reads "${m.placeholder}"`);
      }
      if (m.nearestHeading && !alreadyInTitle(tl, m.nearestHeading)) {
        parts.push(`Under the "${truncate(m.nearestHeading, 40)}" heading`);
      }
      if (m.fieldType && m.fieldType !== 'text') parts.push(`${m.fieldType} field`);
      break;
    }
    case 'select': {
      const m = meta as SelectMeta;
      if (m.breadcrumb) parts.push(`Found in ${m.breadcrumb}`);
      if (m.listPosition) {
        const [pos, total] = m.listPosition.split(' of ');
        parts.push(`${ordinal(Number(pos))} field in a group of ${total}`);
      }
      if (m.nearestHeading && !alreadyInTitle(tl, m.nearestHeading)) {
        parts.push(`Under the "${truncate(m.nearestHeading, 40)}" heading`);
      }
      break;
    }
    case 'submit': {
      const m = meta as SubmitMeta;
      if (m.fieldCount > 0) {
        parts.push(`Form contains ${m.fieldCount} field${m.fieldCount > 1 ? 's' : ''}`);
      }
      break;
    }
    case 'modal': {
      const m = meta as ModalMeta;
      if (m.dialogText) parts.push(truncate(m.dialogText, 80));
      break;
    }
  }

  return parts.join('. ');
}

function mergeConsecutiveInputs(events: RecordedEvent[]): RecordedEvent[][] {
  const groups: RecordedEvent[][] = [];
  let currentGroup: RecordedEvent[] = [];

  for (const event of events) {
    if (event.type === 'input') {
      const meta = event.metadata as InputMeta;
      if (
        currentGroup.length > 0 &&
        currentGroup[0].type === 'input' &&
        (currentGroup[0].metadata as InputMeta).selector === meta.selector
      ) {
        currentGroup.push(event);
        continue;
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }
    currentGroup = [event];
  }

  if (currentGroup.length > 0) {
    groups.push(currentGroup);
  }

  return groups;
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[""'']/g, '"').replace(/\s+/g, ' ').trim();
}

export function generateSteps(
  sessionId: string,
  events: RecordedEvent[]
): Step[] {
  if (events.length === 0) return [];

  const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
  const groups = mergeConsecutiveInputs(sorted);

  const rawSteps: RawStep[] = [];
  let prevEvent: RecordedEvent | null = null;
  for (const group of groups) {
    const primaryEvent = group[0];

    if (primaryEvent.type === 'input') {
      const lastMeta = (group[group.length - 1].metadata as InputMeta);
      const finalValue = lastMeta.value || (primaryEvent.metadata as InputMeta).value || '';
      if (finalValue.length <= 2 && finalValue !== '') { prevEvent = primaryEvent; continue; }
    }

    if (primaryEvent.type === 'modal' && (primaryEvent.metadata as ModalMeta).action === 'open') {
      if (prevEvent && prevEvent.type === 'click') {
        prevEvent = primaryEvent;
        continue;
      }
    }

    prevEvent = primaryEvent;

    let title: string;
    switch (primaryEvent.type) {
      case 'click':
        title = titleForClick(primaryEvent.metadata as ClickMeta);
        break;
      case 'input':
        title = titleForInput(primaryEvent.metadata as InputMeta, group);
        break;
      case 'select':
        title = titleForSelect(primaryEvent.metadata as SelectMeta);
        break;
      case 'navigate':
        title = titleForNavigate(primaryEvent.metadata as NavigateMeta, primaryEvent.id.startsWith('final-'));
        break;
      case 'submit':
        title = titleForSubmit(primaryEvent.metadata as SubmitMeta);
        break;
      case 'modal':
        title = titleForModal(primaryEvent.metadata as ModalMeta);
        break;
      default:
        title = `Action: ${primaryEvent.type}`;
    }

    const lastEvent = group[group.length - 1];
    const screenshotId = lastEvent.screenshotId ?? primaryEvent.screenshotId;
    const altScreenshotId = lastEvent.altScreenshotId ?? primaryEvent.altScreenshotId;
    const description = descriptionForEvent(primaryEvent, title);

    const meta = primaryEvent.metadata as ClickMeta & InputMeta & SelectMeta;
    rawSteps.push({
      title,
      description,
      screenshotId,
      altScreenshotId,
      sourceEventIds: group.map((e) => e.id),
      timestamp: primaryEvent.timestamp,
      url: primaryEvent.url,
      elementRect: meta.elementRect,
      scrollPosition: meta.scrollPosition,
      viewportSize: meta.viewportSize,
      inEphemeralUI: (meta as ClickMeta).inEphemeralUI || undefined,
      containerRole: (meta as ClickMeta).containerRole || undefined,
    });
  }

  // Deduplicate identical adjacent steps
  const deduped: RawStep[] = [];
  for (const step of rawSteps) {
    if (deduped.length > 0) {
      const prev = deduped[deduped.length - 1];
      const sameTitleExact = prev.title === step.title;
      const sameTitleNorm = normalizeTitle(prev.title) === normalizeTitle(step.title);
      const timeDiff = Math.abs(step.timestamp - prev.timestamp);

      // Same exact title within 3s: merge, keep later screenshots
      if (sameTitleExact && timeDiff < 3000) {
        prev.sourceEventIds.push(...step.sourceEventIds);
        if (step.screenshotId) prev.screenshotId = step.screenshotId;
        if (step.altScreenshotId) prev.altScreenshotId = step.altScreenshotId;
        continue;
      }

      // Similar title within 1s: merge, keep longer title and later screenshots
      if (sameTitleNorm && timeDiff < 1000) {
        prev.sourceEventIds.push(...step.sourceEventIds);
        if (step.screenshotId) prev.screenshotId = step.screenshotId;
        if (step.altScreenshotId) prev.altScreenshotId = step.altScreenshotId;
        if (step.title.length > prev.title.length) prev.title = step.title;
        continue;
      }

      // Container subsumption: if prev is a generic click and current is a
      // more specific click on something inside the same area, drop prev.
      // Run regexes against the NORMALIZED form so curly quotes from
      // truncate(...) don't break matching.
      if (timeDiff < 5000) {
        const prevNorm = normalizeTitle(prev.title);
        const stepNorm = normalizeTitle(step.title);
        const prevLabel = prevNorm.match(/click\s+"([^"]+)"/)?.[1];
        const stepLabel = stepNorm.match(/click\s+"([^"]+)"/)?.[1];
        if (prevLabel && stepLabel && prevLabel !== stepLabel && stepNorm.includes(prevLabel)) {
          prev.title = step.title;
          prev.description = step.description;
          prev.sourceEventIds.push(...step.sourceEventIds);
          if (step.screenshotId) prev.screenshotId = step.screenshotId;
          if (step.altScreenshotId) prev.altScreenshotId = step.altScreenshotId;
          continue;
        }
      }
    }
    deduped.push(step);
  }

  const grouped = groupSameAreaSteps(deduped);
  const detected = detectMergeableGroups(grouped);

  // Assign real UUIDs first so we can resolve mergeWithNextId references.
  const ids = detected.map(() => uuid());

  return detected.map((raw, idx) => ({
    id: ids[idx],
    sessionId,
    sortOrder: idx,
    title: raw.title,
    description: raw.description,
    screenshotId: raw.screenshotId,
    altScreenshotId: raw.altScreenshotId,
    sourceEventIds: raw.sourceEventIds,
    isEdited: false,
    subSteps: raw.subSteps,
    // Resolve sentinel "__merge_N" → the real UUID of step at position N
    mergeWithNextId: raw.mergeWithNextId?.startsWith('__merge_')
      ? ids[parseInt(raw.mergeWithNextId.slice('__merge_'.length), 10)]
      : undefined,
  }));
}

const SCROLL_THRESHOLD = 50;
const GROUP_TIME_SPAN_MS = 30_000;

function stripHash(url: string): string {
  try { return url.split('#')[0]; } catch { return url; }
}

function groupSameAreaSteps(steps: RawStep[]): RawStep[] {
  const result: RawStep[] = [];
  let i = 0;

  while (i < steps.length) {
    const current = steps[i];

    // Navigate / modal / submit steps and steps without element rects can't be grouped.
    // Ephemeral steps (popup items, etc.) also can't start a group — their screenshot
    // shows an overlay that won't be present for any subsequent steps.
    if (!current.elementRect || !current.url || !current.viewportSize || current.inEphemeralUI) {
      result.push(current);
      i++;
      continue;
    }

    const group: RawStep[] = [current];
    let j = i + 1;

    while (j < steps.length) {
      const candidate = steps[j];

      // Stop grouping at navigate-like steps or steps without rects
      if (!candidate.elementRect || !candidate.url) break;

      // Ephemeral UI clicks (dropdown items, popups, etc.) were visible only
      // at the moment of interaction. The group screenshot is taken before
      // any actions replay, so an ephemeral element won't appear in it —
      // the annotation would float over empty space.
      if (candidate.inEphemeralUI) break;

      // Server-side guard: even if inEphemeralUI wasn't set by the content script,
      // a containerRole of menu/dialog/listbox indicates the element lived inside
      // an overlay that won't be visible in the group's base screenshot.
      const OVERLAY_ROLES = new Set(['menu', 'dialog', 'alertdialog', 'listbox', 'tooltip', 'combobox']);
      if (candidate.containerRole && OVERLAY_ROLES.has(candidate.containerRole)) break;

      // Same page?
      if (stripHash(candidate.url) !== stripHash(current.url)) break;

      // Time span check
      if (candidate.timestamp - current.timestamp > GROUP_TIME_SPAN_MS) break;

      // Scroll position check
      if (current.scrollPosition && candidate.scrollPosition) {
        const dx = Math.abs(candidate.scrollPosition.x - current.scrollPosition.x);
        const dy = Math.abs(candidate.scrollPosition.y - current.scrollPosition.y);
        if (dx > SCROLL_THRESHOLD || dy > SCROLL_THRESHOLD) break;
      }

      // Check that all elements are visually close to each other (same section/area).
      // "Fits within the viewport" is too permissive — a sidebar link and a hero button
      // both fit but are in completely different page regions.
      // Instead, require every element center to be within MAX_CENTER_DIST_PX of the
      // first element's center.
      const MAX_CENTER_DIST_PX = 250;
      const firstRect = current.elementRect!;
      const firstCx = firstRect.x + firstRect.width / 2;
      const firstCy = firstRect.y + firstRect.height / 2;
      const candRect = candidate.elementRect;
      const candCx = candRect.x + candRect.width / 2;
      const candCy = candRect.y + candRect.height / 2;
      if (Math.hypot(candCx - firstCx, candCy - firstCy) > MAX_CENTER_DIST_PX) break;

      // Look-ahead: if the step immediately AFTER this candidate is a navigate
      // (no elementRect / url differs), this candidate triggered a navigation —
      // don't include it in the group so it gets its own step with the correct screenshot.
      const next = steps[j + 1];
      const candidateCausesNav =
        next &&
        (!next.elementRect ||
          !next.url ||
          stripHash(next.url) !== stripHash(current.url));
      if (candidateCausesNav) break;

      group.push(candidate);
      j++;
    }

    if (group.length === 1) {
      result.push(current);
      i++;
      continue;
    }

    // Merge the group into a compound step
    const subSteps: SubStep[] = group.map((s) => ({
      title: s.title,
      description: s.description,
      elementRect: s.elementRect,
    }));

    const firstStep = group[0];
    const loc = findGroupLocationHint(group);
    const groupTitle = loc
      ? `Perform ${group.length} actions ${loc}`
      : `Perform ${group.length} actions on this page`;

    result.push({
      title: groupTitle,
      description: '',
      // Use the FIRST step's screenshot: it was taken before any action replayed,
      // so it shows the page state the user sees when starting this sequence.
      screenshotId: firstStep.screenshotId,
      altScreenshotId: firstStep.altScreenshotId,
      sourceEventIds: group.flatMap((s) => s.sourceEventIds),
      timestamp: group[0].timestamp,
      url: current.url,
      elementRect: current.elementRect,
      viewportSize: current.viewportSize,
      scrollPosition: current.scrollPosition,
      subSteps,
    });

    i = j;
  }

  return result;
}

/**
 * Detect consecutive "trigger → ephemeral" chains (length 2 or 3) and mark
 * them with `mergeWithNextId` — without actually merging them yet.
 *
 * A qualifying chain is:
 *  - trigger step (not ephemeral) → 1 or 2 consecutive ephemeral steps
 *  - Same URL (stripped of hash), within 10 seconds, all have elementRect
 *
 * For a 2-step chain: step[0].mergeWithNextId = step[1].id
 * For a 3-step chain: step[0].mergeWithNextId = step[1].id
 *                      step[1].mergeWithNextId = step[2].id
 *
 * The IDs used here are placeholder tokens — the real step IDs are assigned
 * later by generateSteps, which reads this field back from the RawStep.
 * We therefore attach a stable token (index-based) that generateSteps
 * replaces with the real UUID after mapping.
 */
function detectMergeableGroups(steps: RawStep[]): RawStep[] {
  const result: RawStep[] = [...steps];

  for (let i = 0; i < result.length; i++) {
    const current = result[i];
    if (current.inEphemeralUI || !current.elementRect || !current.url) continue;

    const next = i + 1 < result.length ? result[i + 1] : null;
    if (
      !next ||
      !next.inEphemeralUI ||
      !next.elementRect ||
      !next.url ||
      stripHash(next.url) !== stripHash(current.url) ||
      next.timestamp - current.timestamp > 10_000
    ) continue;

    // Mark trigger → first ephemeral
    // We store a sentinel that will be replaced with the real UUID after mapping.
    result[i] = { ...current, mergeWithNextId: `__merge_${i + 1}` };

    // Check for a second ephemeral (3-step chain)
    const nextNext = i + 2 < result.length ? result[i + 2] : null;
    if (
      nextNext &&
      nextNext.inEphemeralUI &&
      nextNext.elementRect &&
      nextNext.url &&
      stripHash(nextNext.url) === stripHash(current.url) &&
      nextNext.timestamp - current.timestamp <= 10_000
    ) {
      result[i + 1] = { ...next, mergeWithNextId: `__merge_${i + 2}` };
    }
  }

  return result;
}

/**
 * Merge a group of steps (trigger + 1-2 ephemerals) into a single step.
 * Uses the LAST step's screenshot (popup/overlay is open so all elements visible).
 * Returns the merged RawStep, or null if the group is invalid.
 */
export function mergeStepGroup(group: RawStep[]): RawStep | null {
  if (group.length < 2) return null;

  const subSteps: SubStep[] = group.map((s) => ({
    title: s.title,
    description: s.description,
    elementRect: s.elementRect,
  }));

  const last = group[group.length - 1];
  const first = group[0];

  return {
    title: last.title,
    description: last.description,
    screenshotId: last.screenshotId,
    altScreenshotId: last.altScreenshotId,
    sourceEventIds: group.flatMap((s) => s.sourceEventIds),
    timestamp: first.timestamp,
    url: first.url,
    elementRect: last.elementRect,
    viewportSize: last.viewportSize || first.viewportSize,
    scrollPosition: last.scrollPosition || first.scrollPosition,
    subSteps,
  };
}

function findGroupLocationHint(group: RawStep[]): string {
  for (const step of group) {
    const loc = step.description.match(/Found in (.+?)(?:\.|$)/)?.[1];
    if (loc) return `in ${loc}`;
  }
  // Fall back to extracting location from titles
  for (const step of group) {
    const inMatch = step.title.match(/ in the (.+?)$/)?.[1];
    if (inMatch) return `in the ${inMatch}`;
    const fromMatch = step.title.match(/ from the (.+?)$/)?.[1];
    if (fromMatch) return `in the ${fromMatch}`;
  }
  return '';
}
