import type {
  AfterOutcome,
  ElementStates,
  ParentContext,
  Rect,
} from '@docext/shared';
import {
  buildSelector,
  getNearestHeading,
  isStrongInteractive,
} from './element-resolver.js';

export interface ControlSnapshot {
  accessibleName: string;
  accessibleDescription?: string;
  role?: string;
  tag: string;
  selector: string;
  states: ElementStates;
  rect: Rect;
  href?: string;
  target?: string;
  buttonType?: string;
  value?: string;
  visible: boolean;
}

export interface RegionSnapshot {
  parent?: ParentContext;
  breadcrumb: string[]; // named regions only
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
}

export interface PageFrameSnapshot {
  title: string;
  url: string;
  pageHeading?: string;
  openOverlays: string[];
  currentNav?: string;
  viewportSize: { width: number; height: number };
  scrollPosition: { x: number; y: number };
}

export interface ExtractOptions {
  /** When true, only do hot-path fields (name, rect, selector, states, ephemeral). Skip region/page-frame heavy walks. */
  hotPath?: boolean;
}

const OVERLAY_ROLES = new Set(['dialog', 'alertdialog', 'menu', 'listbox', 'tree']);
const LANDMARK_ROLES = new Set([
  'navigation', 'banner', 'main', 'complementary', 'contentinfo',
  'form', 'search', 'region', 'toolbar', 'menubar', 'tablist',
]);
const SEMANTIC_LANDMARKS: Record<string, string> = {
  nav: 'navigation',
  header: 'banner',
  footer: 'contentinfo',
  main: 'main',
  aside: 'complementary',
  form: 'form',
  section: 'region',
  article: 'article',
};
const SR_ONLY_RE = /\b(sr-only|visually-hidden|screen-reader-only|a11y-hidden|clipped)\b/i;
const NESTED_SKIP_TAGS = new Set(['button', 'a', 'script', 'style', 'noscript', 'template']);
const NESTED_SKIP_ROLES = new Set(['button', 'link', 'tooltip', 'presentation', 'none']);
const REGION_AREA_CAP = 0.45;

function safeGetBoundingRect(el: Element): Rect {
  try {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch {
    return { x: 0, y: 0, width: 0, height: 0 };
  }
}

function isVisible(el: Element): boolean {
  try {
    const html = el as HTMLElement;
    if (html.hidden || el.getAttribute('aria-hidden') === 'true') return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 || r.height > 0;
  } catch {
    return false;
  }
}

function isHeadingElement(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (/^h[1-6]$/.test(tag)) return true;
  return el.getAttribute('role') === 'heading';
}

function headingText(el: Element): string | undefined {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text && text.length < 80) return text;
  return undefined;
}

function resolveLabelledByText(el: Element): string | undefined {
  const ids = el.getAttribute('aria-labelledby');
  if (!ids) return undefined;
  const parts = ids
    .split(/\s+/)
    .map((id) => {
      try {
        const ref = document.getElementById(id);
        if (!ref) return undefined;
        return visibleNameText(ref) || (ref.textContent || '').replace(/\s+/g, ' ').trim();
      } catch {
        return undefined;
      }
    })
    .filter((t): t is string => Boolean(t));
  if (parts.length === 0) return undefined;
  return parts.join(' ').trim() || undefined;
}

function resolveDescribedByText(el: Element): string | undefined {
  const ids = el.getAttribute('aria-describedby');
  if (!ids) return undefined;
  const parts = ids
    .split(/\s+/)
    .map((id) => {
      try {
        return document.getElementById(id)?.textContent?.replace(/\s+/g, ' ').trim();
      } catch {
        return undefined;
      }
    })
    .filter((t): t is string => Boolean(t));
  if (parts.length === 0) return undefined;
  return parts.join(' ').trim() || undefined;
}

function isSrOnlyClass(el: Element): boolean {
  try {
    return SR_ONLY_RE.test(el.className?.toString?.() || '');
  } catch {
    return false;
  }
}

/** Visible + sr-only text for accessible name; skips nested buttons/tooltips. */
function visibleNameText(el: Element): string {
  let result = '';
  const walk = (node: Node) => {
    if (result.length > 130) return;
    if (node.nodeType === Node.TEXT_NODE) {
      result += node.textContent || '';
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const child = node as Element;
    if (child !== el) {
      const tag = child.tagName.toLowerCase();
      if (NESTED_SKIP_TAGS.has(tag)) return;
      const role = child.getAttribute('role');
      if (role && NESTED_SKIP_ROLES.has(role)) return;
      if (child.getAttribute('aria-hidden') === 'true' && !isSrOnlyClass(child)) return;
      try {
        const style = window.getComputedStyle(child);
        // Include sr-only / visually-hidden; skip truly hidden non-a11y content
        if (style.display === 'none') return;
        if (
          style.visibility === 'hidden' &&
          !isSrOnlyClass(child) &&
          style.position !== 'absolute' &&
          style.clip !== 'rect(0px, 0px, 0px, 0px)' &&
          style.clipPath !== 'inset(100%)'
        ) {
          return;
        }
      } catch {
        /* ignore */
      }
    }
    for (const c of child.childNodes) walk(c);
  };
  walk(el);
  return result.replace(/\s+/g, ' ').trim();
}

function nativeLabelText(el: Element): string | undefined {
  const id = el.getAttribute('id');
  if (id) {
    try {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (label) {
        const text = visibleNameText(label) || (label.textContent || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
      }
    } catch {
      /* invalid selector */
    }
  }
  const parentLabel = el.closest('label');
  if (parentLabel) {
    try {
      const clone = parentLabel.cloneNode(true) as HTMLElement;
      clone.querySelectorAll('input, select, textarea, button').forEach((c) => c.remove());
      const text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (text) return text;
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

function nearbySiblingText(el: Element): string | undefined {
  try {
    const prev = el.previousElementSibling;
    if (prev && !isStrongInteractive(prev)) {
      const t = (prev.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 60) return t;
    }
    const next = el.nextElementSibling;
    if (next && !isStrongInteractive(next)) {
      const t = (next.textContent || '').replace(/\s+/g, ' ').trim();
      if (t.length > 0 && t.length < 60) return t;
    }
    // Parent direct text (icon button with sibling span)
    const parent = el.parentElement;
    if (parent) {
      for (const child of parent.children) {
        if (child === el || isStrongInteractive(child)) continue;
        const t = (child.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length > 0 && t.length < 60) return t;
      }
    }
  } catch {
    /* detached */
  }
  return undefined;
}

export function computeAccessibleName(el: Element): string {
  try {
    const labelledBy = resolveLabelledByText(el);
    if (labelledBy) return labelledBy.slice(0, 120);

    const ariaLabel = el.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel.slice(0, 120);

    const tag = el.tagName.toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'output' || tag === 'meter' || tag === 'progress') {
      const native = nativeLabelText(el);
      if (native) return native.slice(0, 120);
    } else {
      const native = nativeLabelText(el);
      if (native) return native.slice(0, 120);
    }

    const text = visibleNameText(el);
    if (text) return text.length > 120 ? text.slice(0, 119) + '…' : text;

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const ph = el.placeholder?.trim();
      if (ph) return ph.slice(0, 120);
    }

    const title = el.getAttribute('title')?.trim();
    if (title) return title.slice(0, 120);

    const svgTitle = el.querySelector('svg title');
    if (svgTitle) {
      const t = (svgTitle.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return t.slice(0, 120);
    }

    if (el instanceof HTMLImageElement && el.alt) {
      return el.alt.slice(0, 120);
    }
    const img = el.querySelector('img[alt]') as HTMLImageElement | null;
    if (img?.alt) return img.alt.slice(0, 120);

    const nearby = nearbySiblingText(el);
    if (nearby) return nearby.slice(0, 120);
  } catch {
    /* detached or cross-origin */
  }
  return '';
}

export function getElementStates(el: Element): ElementStates {
  const states: ElementStates = {};
  try {
    const expanded = el.getAttribute('aria-expanded');
    if (expanded === 'true') states.expanded = true;
    else if (expanded === 'false') states.expanded = false;

    const pressed = el.getAttribute('aria-pressed');
    if (pressed === 'true') states.pressed = true;
    else if (pressed === 'false') states.pressed = false;

    const checkedAttr = el.getAttribute('aria-checked');
    if (checkedAttr === 'true') states.checked = true;
    else if (checkedAttr === 'false') states.checked = false;
    else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      states.checked = el.checked;
    }

    const selected = el.getAttribute('aria-selected');
    if (selected === 'true') states.selected = true;
    else if (selected === 'false') states.selected = false;

    if (
      el.hasAttribute('disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      (el instanceof HTMLInputElement && el.disabled) ||
      (el instanceof HTMLButtonElement && el.disabled) ||
      (el instanceof HTMLSelectElement && el.disabled) ||
      (el instanceof HTMLTextAreaElement && el.disabled)
    ) {
      states.disabled = true;
    }

    const current = el.getAttribute('aria-current');
    if (current && current !== 'false') states.current = current;
  } catch {
    /* detached */
  }
  return states;
}

function regionAreaOk(rect: Rect): boolean {
  try {
    const vw = window.innerWidth || 1;
    const vh = window.innerHeight || 1;
    return (rect.width * rect.height) / (vw * vh) <= REGION_AREA_CAP;
  } catch {
    return true;
  }
}

function namedRegionLabel(el: Element): string | undefined {
  const labelledBy = resolveLabelledByText(el);
  if (labelledBy) return labelledBy.slice(0, 80);
  const aria = el.getAttribute('aria-label')?.trim();
  if (aria) return aria.slice(0, 80);
  return undefined;
}

function childHeadingLabel(el: Element): string | undefined {
  // Only scan direct / shallow children — not large ancestor querySelector
  try {
    for (const child of el.children) {
      if (isHeadingElement(child)) {
        const t = headingText(child);
        if (t) return t;
      }
      for (const grand of child.children) {
        if (isHeadingElement(grand)) {
          const t = headingText(grand);
          if (t) return t;
        }
      }
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function toParentContext(el: Element, name: string, landmark?: string): ParentContext | undefined {
  try {
    const rect = safeGetBoundingRect(el);
    if (!regionAreaOk(rect) && rect.width * rect.height > 0) {
      // Still return context without oversized rect
      return {
        selector: buildSelector(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || undefined,
        name,
        text: visibleNameText(el).slice(0, 80) || undefined,
        landmark,
      };
    }
    return {
      selector: buildSelector(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute('role') || undefined,
      name,
      text: visibleNameText(el).slice(0, 80) || undefined,
      rect: rect.width > 0 || rect.height > 0 ? rect : undefined,
      landmark,
    };
  } catch {
    return undefined;
  }
}

function pointInRect(x: number, y: number, rect: DOMRect): boolean {
  return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
}

function isOpenOverlay(el: Element): boolean {
  try {
    const role = el.getAttribute('role');
    const tag = el.tagName.toLowerCase();
    if (tag === 'dialog') {
      const dlg = el as HTMLDialogElement;
      if (typeof dlg.open === 'boolean') return dlg.open;
      return isVisible(el);
    }
    if (role && OVERLAY_ROLES.has(role)) {
      if (el.getAttribute('aria-hidden') === 'true') return false;
      const hidden = el.getAttribute('data-state');
      if (hidden === 'closed' || hidden === 'hide') return false;
      return isVisible(el);
    }
    // Radix / portal wrappers
    if (
      el.hasAttribute('data-radix-portal') ||
      el.getAttribute('data-state') === 'open' ||
      el.classList.contains('modal') ||
      el.classList.contains('popover-content')
    ) {
      const r = el.getAttribute('role');
      if (r && (OVERLAY_ROLES.has(r) || r === 'presentation')) return isVisible(el);
      if (el.querySelector('[role="dialog"], [role="menu"], [role="listbox"], dialog')) {
        return isVisible(el);
      }
    }
  } catch {
    /* ignore */
  }
  return false;
}

function overlayName(el: Element): string {
  return (
    namedRegionLabel(el) ||
    childHeadingLabel(el) ||
    el.getAttribute('role') ||
    el.tagName.toLowerCase()
  );
}

function findOpenOverlayContaining(el: Element): Element | null {
  try {
    // Ancestor walk first
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < 20) {
      if (isOpenOverlay(current) && current !== el) return current;
      current = current.parentElement;
      depth++;
    }

    // Portals: find open overlays whose rect contains the control's center
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    const candidates = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-state="open"], [data-radix-portal]',
    );
    for (const candidate of candidates) {
      if (!isOpenOverlay(candidate)) continue;
      if (candidate.contains(el)) return candidate;
      try {
        const cr = candidate.getBoundingClientRect();
        if (cr.width > 0 && cr.height > 0 && pointInRect(cx, cy, cr)) {
          return candidate;
        }
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* detached */
  }
  return null;
}

function findSelectedTabName(tabpanel: Element): string | undefined {
  try {
    const labelledBy = tabpanel.getAttribute('aria-labelledby');
    if (labelledBy) {
      const tab = document.getElementById(labelledBy.split(/\s+/)[0]!);
      if (tab) {
        return computeAccessibleName(tab) || (tab.textContent || '').replace(/\s+/g, ' ').trim() || undefined;
      }
    }
    const id = tabpanel.getAttribute('id');
    if (id) {
      const tab = document.querySelector(`[role="tab"][aria-controls="${CSS.escape(id)}"]`);
      if (tab) {
        return computeAccessibleName(tab) || (tab.textContent || '').replace(/\s+/g, ' ').trim() || undefined;
      }
    }
    const selected = document.querySelector('[role="tab"][aria-selected="true"]');
    if (selected && tabpanel.closest('[role="tabpanel"]') === tabpanel) {
      return computeAccessibleName(selected) || undefined;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function tableContext(el: Element): { name: string; node: Element } | null {
  try {
    const table = el.closest('table, [role="table"], [role="grid"]');
    if (!table) return null;
    const caption = table.querySelector('caption');
    if (caption) {
      const t = (caption.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) return { name: t.slice(0, 80), node: table };
    }
    const cell = el.closest('td, th, [role="cell"], [role="gridcell"]');
    if (cell && cell.parentElement) {
      const row = cell.parentElement;
      const idx = Array.from(row.children).indexOf(cell);
      const thead = table.querySelector('thead tr');
      if (thead && idx >= 0) {
        const th = thead.children[idx];
        if (th) {
          const t = (th.textContent || '').replace(/\s+/g, ' ').trim();
          if (t) return { name: t.slice(0, 80), node: th };
        }
      }
      // row header
      const th = row.querySelector('th');
      if (th) {
        const t = (th.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) return { name: t.slice(0, 80), node: th };
      }
    }
  } catch {
    /* ignore */
  }
  return null;
}

function collectNamedBreadcrumb(el: Element): string[] {
  const parts: string[] = [];
  try {
    let current: Element | null = el.parentElement;
    let depth = 0;
    while (current && depth < 12) {
      const tag = current.tagName.toLowerCase();
      if (tag === 'body' || tag === 'html') break;

      let label = namedRegionLabel(current);
      if (!label) {
        const role = current.getAttribute('role');
        if (role && (LANDMARK_ROLES.has(role) || OVERLAY_ROLES.has(role))) {
          label = role.charAt(0).toUpperCase() + role.slice(1);
        }
      }
      if (!label && tag in SEMANTIC_LANDMARKS) {
        label = namedRegionLabel(current) || SEMANTIC_LANDMARKS[tag];
        if (label === SEMANTIC_LANDMARKS[tag]) {
          const human = label.charAt(0).toUpperCase() + label.slice(1);
          label = human;
        }
      }
      if (!label && (tag === 'fieldset' || tag === 'dialog' || tag === 'section' || tag === 'article')) {
        label = childHeadingLabel(current) || (tag === 'fieldset'
          ? (current.querySelector(':scope > legend')?.textContent || '').replace(/\s+/g, ' ').trim()
          : undefined) || undefined;
      }

      if (label && !parts.includes(label)) {
        parts.unshift(label);
      }
      current = current.parentElement;
      depth++;
    }
  } catch {
    /* ignore */
  }
  return parts;
}

export function extractControl(el: Element, _opts?: ExtractOptions): ControlSnapshot {
  const tag = el.tagName.toLowerCase();
  const rect = safeGetBoundingRect(el);
  const states = getElementStates(el);
  const role = el.getAttribute('role') || undefined;
  const accessibleName = computeAccessibleName(el);
  const accessibleDescription =
    resolveDescribedByText(el) || el.getAttribute('title')?.trim() || undefined;

  const snap: ControlSnapshot = {
    accessibleName,
    accessibleDescription,
    role,
    tag,
    selector: buildSelector(el),
    states,
    rect,
    visible: isVisible(el),
  };

  try {
    if (tag === 'a' || role === 'link') {
      const a = el as HTMLAnchorElement;
      snap.href = a.href || el.getAttribute('href') || undefined;
      snap.target = a.target || el.getAttribute('target') || undefined;
    }
    if (tag === 'button' || role === 'button') {
      const type = (el as HTMLButtonElement).type || el.getAttribute('type') || undefined;
      if (type) snap.buttonType = type;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      snap.value = el.type === 'password' ? '••••••' : el.value;
    } else if (el instanceof HTMLSelectElement) {
      snap.value = el.options[el.selectedIndex]?.text || el.value;
    }
  } catch {
    /* detached */
  }

  return snap;
}

export function extractRegion(el: Element): RegionSnapshot {
  const breadcrumb = collectNamedBreadcrumb(el);
  const nearestHeading = getNearestHeading(el);
  let parent: ParentContext | undefined;
  let sectionLabel: string | undefined;
  let containerRole: string | undefined;

  try {
    // 1. Open overlay containing control
    const overlay = findOpenOverlayContaining(el);
    if (overlay) {
      const name = overlayName(overlay);
      parent = toParentContext(overlay, name, overlay.getAttribute('role') || 'dialog');
      sectionLabel = name;
      containerRole = overlay.getAttribute('role') || overlay.tagName.toLowerCase();
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // 2. fieldset → legend
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const legend = fieldset.querySelector(':scope > legend');
      const name =
        (legend?.textContent || '').replace(/\s+/g, ' ').trim() ||
        namedRegionLabel(fieldset) ||
        'fieldset';
      parent = toParentContext(fieldset, name, 'group');
      sectionLabel = name;
      containerRole = 'group';
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // 3. Named landmark
    let current: Element | null = el.parentElement;
    let depth = 0;
    while (current && depth < 12) {
      const role = current.getAttribute('role');
      const tag = current.tagName.toLowerCase();
      const landmark =
        (role && LANDMARK_ROLES.has(role) ? role : undefined) ||
        SEMANTIC_LANDMARKS[tag];
      if (landmark) {
        const name =
          namedRegionLabel(current) ||
          childHeadingLabel(current) ||
          landmark.charAt(0).toUpperCase() + landmark.slice(1);
        if (namedRegionLabel(current) || childHeadingLabel(current) || landmark !== 'main') {
          parent = toParentContext(current, name, landmark);
          sectionLabel = namedRegionLabel(current) || (landmark !== 'main' ? name : undefined);
          containerRole = landmark;
          if (namedRegionLabel(current) || childHeadingLabel(current)) {
            return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
          }
          // Keep unnamed main/nav as fallback; continue looking for better region
          if (!parent) parent = toParentContext(current, name, landmark);
        }
      }
      current = current.parentElement;
      depth++;
    }

    // 4. Card/section with child heading
    current = el.parentElement;
    depth = 0;
    while (current && depth < 10) {
      const tag = current.tagName.toLowerCase();
      if (tag === 'section' || tag === 'article' || current.getAttribute('role') === 'group' ||
          /\b(card|panel|tile)\b/i.test(current.className?.toString?.() || '')) {
        const heading = childHeadingLabel(current) || namedRegionLabel(current);
        if (heading) {
          parent = toParentContext(current, heading, tag === 'section' ? 'region' : undefined);
          sectionLabel = heading;
          containerRole = current.getAttribute('role') || tag;
          return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
        }
      }
      current = current.parentElement;
      depth++;
    }

    // 5. tabpanel + selected tab name
    const tabpanel = el.closest('[role="tabpanel"]');
    if (tabpanel) {
      const tabName = findSelectedTabName(tabpanel) || namedRegionLabel(tabpanel) || 'Tab panel';
      parent = toParentContext(tabpanel, tabName, 'tabpanel');
      sectionLabel = tabName;
      containerRole = 'tabpanel';
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // 6. table th/caption
    const tableCtx = tableContext(el);
    if (tableCtx) {
      parent = toParentContext(tableCtx.node, tableCtx.name, 'table');
      sectionLabel = tableCtx.name;
      containerRole = 'table';
      return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
    }

    // Fallback: use first landmark found during walk if we had one without a name
    if (!parent) {
      current = el.parentElement;
      depth = 0;
      while (current && depth < 10) {
        const role = current.getAttribute('role');
        const tag = current.tagName.toLowerCase();
        const landmark =
          (role && LANDMARK_ROLES.has(role) ? role : undefined) || SEMANTIC_LANDMARKS[tag];
        if (landmark && landmark !== 'main') {
          const name = namedRegionLabel(current) || landmark.charAt(0).toUpperCase() + landmark.slice(1);
          parent = toParentContext(current, name, landmark);
          sectionLabel = namedRegionLabel(current);
          containerRole = landmark;
          break;
        }
        current = current.parentElement;
        depth++;
      }
    }
  } catch {
    /* detached */
  }

  return { parent, breadcrumb, nearestHeading, sectionLabel, containerRole };
}

function listOpenOverlays(): string[] {
  const names: string[] = [];
  try {
    const candidates = document.querySelectorAll(
      'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-state="open"]',
    );
    for (const el of candidates) {
      if (!isOpenOverlay(el)) continue;
      const name = overlayName(el);
      if (name && !names.includes(name)) names.push(name);
    }
  } catch {
    /* ignore */
  }
  return names;
}

function findPageHeading(): string | undefined {
  try {
    const main =
      document.querySelector('main, [role="main"]') || document.body;
    if (!main) return undefined;
    // Prefer visible h1 inside main (shallow-ish: first few h1 matches)
    const h1s = main.querySelectorAll('h1, [role="heading"][aria-level="1"]');
    for (const h of h1s) {
      if (!isVisible(h)) continue;
      const t = headingText(h);
      if (t) return t;
    }
    const anyH1 = document.querySelector('h1');
    if (anyH1 && isVisible(anyH1)) return headingText(anyH1);
  } catch {
    /* ignore */
  }
  return undefined;
}

function findCurrentNav(): string | undefined {
  try {
    const current =
      document.querySelector('[aria-current="page"]') ||
      document.querySelector('nav [aria-current="true"], [role="navigation"] [aria-current="true"]');
    if (!current) return undefined;
    return (
      computeAccessibleName(current) ||
      (current.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) ||
      undefined
    );
  } catch {
    return undefined;
  }
}

export function extractPageFrame(): PageFrameSnapshot {
  let title = '';
  let url = '';
  try {
    title = document.title || '';
    url = location.href;
  } catch {
    /* cross-origin */
  }

  return {
    title,
    url,
    pageHeading: findPageHeading(),
    openOverlays: listOpenOverlays(),
    currentNav: findCurrentNav(),
    viewportSize: {
      width: typeof window !== 'undefined' ? window.innerWidth : 0,
      height: typeof window !== 'undefined' ? window.innerHeight : 0,
    },
    scrollPosition: {
      x: typeof window !== 'undefined' ? window.scrollX : 0,
      y: typeof window !== 'undefined' ? window.scrollY : 0,
    },
  };
}

export function extractElementLayers(
  el: Element,
  opts?: ExtractOptions,
): {
  control: ControlSnapshot;
  region?: RegionSnapshot;
  page?: PageFrameSnapshot;
} {
  const control = extractControl(el, opts);
  if (opts?.hotPath) {
    return { control };
  }
  return {
    control,
    region: extractRegion(el),
    page: extractPageFrame(),
  };
}

export function extractAfterState(
  el: Element | null,
  beforeStates: ElementStates,
  beforeUrl: string,
): AfterOutcome {
  try {
    let afterUrl = '';
    try {
      afterUrl = location.href;
    } catch {
      /* ignore */
    }

    const afterStates = el && el.isConnected ? getElementStates(el) : {};
    const overlays = listOpenOverlays();
    const heading = findPageHeading();

    if (afterUrl && beforeUrl && afterUrl !== beforeUrl) {
      return {
        outcome: 'navigated',
        states: afterStates,
        newUrl: afterUrl,
        newHeading: heading,
      };
    }

    if (
      beforeStates.expanded === false &&
      afterStates.expanded === true
    ) {
      return { outcome: 'expanded', states: afterStates, openOverlayName: overlays[0] };
    }
    if (
      beforeStates.expanded === true &&
      afterStates.expanded === false
    ) {
      return { outcome: 'collapsed', states: afterStates };
    }

    if (
      (beforeStates.pressed !== undefined &&
        afterStates.pressed !== undefined &&
        beforeStates.pressed !== afterStates.pressed) ||
      (beforeStates.checked !== undefined &&
        afterStates.checked !== undefined &&
        beforeStates.checked !== afterStates.checked) ||
      (beforeStates.selected !== undefined &&
        afterStates.selected !== undefined &&
        beforeStates.selected !== afterStates.selected)
    ) {
      return { outcome: 'toggled', states: afterStates };
    }

    if (overlays.length > 0) {
      // Newly opened dialog/menu relative to interaction
      return {
        outcome: 'opened-dialog',
        states: afterStates,
        openOverlayName: overlays[0],
      };
    }

    if (el) {
      const tag = el.tagName.toLowerCase();
      const type = el.getAttribute('type');
      if (tag === 'form' || type === 'submit' || (tag === 'button' && type === 'submit')) {
        return { outcome: 'submitted', states: afterStates, newUrl: afterUrl || undefined };
      }
    }

    return { outcome: 'unknown', states: afterStates, newHeading: heading };
  } catch {
    return { outcome: 'unknown' };
  }
}
