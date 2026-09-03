import type {
  RecordedEvent,
  ClickMeta,
  InputMeta,
  SelectMeta,
  NavigateMeta,
  SubmitMeta,
  ModalMeta,
  ScreenshotMeta,
  DomEdit,
} from '@docext/shared';
import { resolveElement, type ElementInfo } from './element-resolver.js';
import {
  extractElementLayers,
  extractPageFrame,
  extractControl,
  computeAccessibleName,
  getElementStates,
  type ExtractOptions,
} from './page-extractor.js';

const SENSITIVE_RE = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

function pickBestHighlightTarget(hit: Element): Element {
  const actionable = hit.closest(
    'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], a, input, select, textarea'
  );
  let best: Element = actionable || hit;
  let bestRect = best.getBoundingClientRect();

  let node: Element | null = best.parentElement;
  let depth = 0;
  const bestIsTextLike = best.tagName.toLowerCase() === 'span' || best.tagName.toLowerCase() === 'p';
  while (node && depth < 5) {
    const rect = node.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) {
      node = node.parentElement;
      depth++;
      continue;
    }

    const role = node.getAttribute('role');
    const tag = node.tagName.toLowerCase();
    const cls = node.className || '';
    const isContainerRole = role === 'dialog' || role === 'alertdialog' || role === 'menu' || role === 'listbox';
    const looksLikeOverlay =
      tag === 'dialog' ||
      /modal|dialog|drawer|sheet|overlay|backdrop|popover|portal|content/i.test(String(cls));

    if (isContainerRole || looksLikeOverlay) {
      node = node.parentElement;
      depth++;
      continue;
    }

    const bestArea = bestRect.width * bestRect.height;
    const nodeArea = rect.width * rect.height;
    if (nodeArea > bestArea * 6) {
      node = node.parentElement;
      depth++;
      continue;
    }

    const isStronglyInteractive =
      tag === 'button' ||
      tag === 'a' ||
      tag === 'input' ||
      tag === 'select' ||
      tag === 'textarea' ||
      role === 'button' ||
      role === 'link' ||
      role === 'tab' ||
      role === 'menuitem' ||
      role === 'menuitemcheckbox' ||
      role === 'menuitemradio' ||
      role === 'option';

    const largerThanCurrent = nodeArea > bestArea * 1.8;
    const notHuge = rect.width <= window.innerWidth * 0.45 && rect.height <= window.innerHeight * 0.25;
    const plausibleButtonLike =
      bestIsTextLike &&
      rect.height >= 28 &&
      rect.height <= 90 &&
      rect.width >= 120 &&
      rect.width <= window.innerWidth * 0.8;

    if (isStronglyInteractive && largerThanCurrent && notHuge) {
      best = node;
      bestRect = rect;
    } else if (plausibleButtonLike && isStronglyInteractive && largerThanCurrent && notHuge) {
      best = node;
      bestRect = rect;
    }

    node = node.parentElement;
    depth++;
  }

  return best;
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function enrichFromLayers(
  el: Element,
  opts?: ExtractOptions,
): {
  accessibleName?: string;
  accessibleDescription?: string;
  states?: ReturnType<typeof getElementStates>;
  parent?: ReturnType<typeof extractElementLayers>['region'] extends infer R
    ? R extends { parent?: infer P } ? P : undefined
    : undefined;
  breadcrumb?: string;
  nearestHeading?: string;
  sectionLabel?: string;
  containerRole?: string;
  pageHeading?: string;
  openOverlays?: string[];
  href?: string;
  target?: string;
  buttonType?: string;
} {
  try {
    const layers = extractElementLayers(el, opts);
    const parent = layers.region?.parent;
    return {
      accessibleName: layers.control.accessibleName || undefined,
      accessibleDescription: layers.control.accessibleDescription,
      states: layers.control.states,
      parent,
      breadcrumb: layers.region?.breadcrumb.length
        ? layers.region.breadcrumb.join(' > ')
        : undefined,
      nearestHeading: layers.region?.nearestHeading,
      sectionLabel: layers.region?.sectionLabel,
      containerRole: layers.region?.containerRole,
      pageHeading: layers.page?.pageHeading,
      openOverlays: layers.page?.openOverlays.length ? layers.page.openOverlays : undefined,
      href: layers.control.href,
      target: layers.control.target,
      buttonType: layers.control.buttonType,
    };
  } catch {
    return {
      accessibleName: computeAccessibleName(el) || undefined,
      states: getElementStates(el),
    };
  }
}

export function buildClickEvent(
  el: Element,
  e: MouseEvent | PointerEvent,
  info: ElementInfo,
  domEdits: DomEdit[],
  opts?: { inEphemeralUI?: boolean; hotPath?: boolean },
): RecordedEvent {
  const r = el.getBoundingClientRect();
  let highlightRect = r;
  try {
    const hit = document.elementFromPoint(e.clientX, e.clientY);
    if (hit) {
      const bestTarget = pickBestHighlightTarget(hit);
      const rr = bestTarget.getBoundingClientRect();
      const hitLooksValid = rr.width >= 8 && rr.height >= 8;
      const role = info.role || '';
      const originalActionable =
        info.tag === 'button' ||
        info.tag === 'a' ||
        info.tag === 'input' ||
        info.tag === 'select' ||
        info.tag === 'textarea' ||
        role === 'button' ||
        role === 'menuitem' ||
        role === 'menuitemcheckbox' ||
        role === 'menuitemradio' ||
        role === 'link';
      const originalLooksControlSized =
        originalActionable &&
        r.width >= 20 &&
        r.height >= 16 &&
        r.width <= window.innerWidth * 0.6 &&
        r.height <= window.innerHeight * 0.35;
      const shouldPreferHit =
        (!!opts?.inEphemeralUI && !originalLooksControlSized) ||
        r.width < 8 ||
        r.height < 8 ||
        ((info.tag === 'div' || info.tag === 'span') && !info.role);
      if (hitLooksValid && shouldPreferHit) {
        highlightRect = rr;
      }
    }
  } catch { /* safe fallback */ }

  const layers = enrichFromLayers(el, { hotPath: opts?.hotPath });
  const accessibleName = layers.accessibleName || info.ariaLabel || info.text || undefined;

  const meta: ClickMeta = {
    elementTag: info.tag,
    elementText: info.text,
    ariaLabel: info.ariaLabel,
    role: info.role,
    selector: info.selector,
    coordinates: { x: e.clientX, y: e.clientY },
    elementRect: { x: highlightRect.left, y: highlightRect.top, width: highlightRect.width, height: highlightRect.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    nearestHeading: layers.nearestHeading || info.nearestHeading,
    sectionLabel: layers.sectionLabel || info.sectionLabel,
    containerRole: layers.containerRole || info.containerRole,
    href: layers.href || info.href,
    target: layers.target,
    title: info.title,
    parentText: layers.parent?.text || info.parentText,
    fieldLabel: info.fieldLabel,
    breadcrumb: layers.breadcrumb || info.breadcrumb,
    tooltipText: info.tooltipText,
    inputValue: info.inputValue,
    parentId: info.parentId,
    parentName: layers.parent?.name || info.parentName,
    parent: layers.parent,
    listPosition: info.listPosition,
    nearbyText: info.nearbyText,
    viewportHint: info.viewportHint,
    semanticClasses: info.semanticClasses,
    inEphemeralUI: opts?.inEphemeralUI || undefined,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    accessibleName,
    accessibleDescription: layers.accessibleDescription,
    states: layers.states,
    pageHeading: layers.pageHeading,
    openOverlays: layers.openOverlays,
    buttonType: layers.buttonType,
  };
  return {
    id: generateId(),
    type: 'click',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
    domEdits: domEdits.length > 0 ? [...domEdits] : undefined,
  };
}

export function buildInputEvent(el: Element, info: ElementInfo): RecordedEvent {
  const layers = enrichFromLayers(el);
  const label =
    layers.accessibleName ||
    info.fieldLabel ||
    info.ariaLabel ||
    info.placeholder ||
    info.tag;
  const fieldType = info.fieldType || 'text';
  let value = '';
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    value = el.value;
  }
  if (fieldType === 'password' || SENSITIVE_RE.test(label)) value = '••••••';

  const r = el.getBoundingClientRect();
  const meta: InputMeta = {
    fieldLabel: label,
    fieldType,
    value,
    selector: info.selector,
    placeholder: info.placeholder,
    nearestHeading: layers.nearestHeading || info.nearestHeading,
    sectionLabel: layers.sectionLabel || info.sectionLabel,
    containerRole: layers.containerRole || info.containerRole,
    breadcrumb: layers.breadcrumb || info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    parentId: info.parentId,
    parentName: layers.parent?.name || info.parentName,
    parentText: layers.parent?.text || info.parentText,
    parent: layers.parent,
    listPosition: info.listPosition,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    tooltipText: info.tooltipText,
    viewportHint: info.viewportHint,
    nearbyText: info.nearbyText,
    semanticClasses: info.semanticClasses,
    accessibleName: layers.accessibleName,
    accessibleDescription: layers.accessibleDescription,
    states: layers.states,
    pageHeading: layers.pageHeading,
    openOverlays: layers.openOverlays,
  };
  return {
    id: generateId(),
    type: 'input',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

export function buildSelectEvent(el: HTMLSelectElement, info: ElementInfo): RecordedEvent {
  const layers = enrichFromLayers(el);
  const selectedOption = el.options[el.selectedIndex]?.text || el.value;
  const label =
    layers.accessibleName ||
    info.fieldLabel ||
    info.ariaLabel ||
    info.placeholder ||
    'dropdown';
  const r = el.getBoundingClientRect();
  const meta: SelectMeta = {
    fieldLabel: label,
    selectedOption,
    selector: info.selector,
    nearestHeading: layers.nearestHeading || info.nearestHeading,
    sectionLabel: layers.sectionLabel || info.sectionLabel,
    containerRole: layers.containerRole || info.containerRole,
    breadcrumb: layers.breadcrumb || info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    parentId: info.parentId,
    parentName: layers.parent?.name || info.parentName,
    parentText: layers.parent?.text || info.parentText,
    parent: layers.parent,
    listPosition: info.listPosition,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
    tooltipText: info.tooltipText,
    viewportHint: info.viewportHint,
    nearbyText: info.nearbyText,
    semanticClasses: info.semanticClasses,
    accessibleName: layers.accessibleName,
    accessibleDescription: layers.accessibleDescription,
    states: layers.states,
    pageHeading: layers.pageHeading,
    openOverlays: layers.openOverlays,
  };
  return {
    id: generateId(),
    type: 'select',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

export function buildNavigateEvent(fromUrl: string, toUrl: string): RecordedEvent {
  let pageHeading: string | undefined;
  let openOverlays: string[] | undefined;
  try {
    const frame = extractPageFrame();
    pageHeading = frame.pageHeading;
    openOverlays = frame.openOverlays.length ? frame.openOverlays : undefined;
  } catch { /* ignore */ }
  const meta: NavigateMeta = {
    fromUrl,
    toUrl,
    newTitle: document.title,
    pageHeading,
    openOverlays,
  };
  return {
    id: generateId(),
    type: 'navigate',
    timestamp: Date.now(),
    url: toUrl,
    pageTitle: document.title,
    metadata: meta,
  };
}

export function buildSubmitEvent(form: HTMLFormElement): RecordedEvent {
  const layers = enrichFromLayers(form);
  const r = form.getBoundingClientRect();
  const meta: SubmitMeta = {
    formName: form.name || form.getAttribute('aria-label') || layers.accessibleName || undefined,
    formAction: form.action || undefined,
    fieldCount: form.elements.length,
    nearestHeading: layers.nearestHeading,
    selector: layers.parent ? undefined : undefined,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    accessibleName: layers.accessibleName,
    parent: layers.parent,
    pageHeading: layers.pageHeading,
    openOverlays: layers.openOverlays,
    breadcrumb: layers.breadcrumb,
  };
  try {
    meta.selector = extractControl(form).selector;
  } catch { /* ignore */ }
  return {
    id: generateId(),
    type: 'submit',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

export function buildModalEvent(action: 'open' | 'close', el?: Element): RecordedEvent {
  let selector: string | undefined;
  let accessibleName: string | undefined;
  let elementRect: ModalMeta['elementRect'];
  let pageHeading: string | undefined;
  let openOverlays: string[] | undefined;
  let nearestHeading: string | undefined;
  try {
    if (el) {
      const layers = extractElementLayers(el);
      selector = layers.control.selector;
      accessibleName = layers.control.accessibleName || undefined;
      elementRect = layers.control.rect;
      pageHeading = layers.page?.pageHeading;
      openOverlays = layers.page?.openOverlays.length ? layers.page.openOverlays : undefined;
      nearestHeading = layers.region?.nearestHeading;
    } else {
      const frame = extractPageFrame();
      pageHeading = frame.pageHeading;
      openOverlays = frame.openOverlays.length ? frame.openOverlays : undefined;
    }
  } catch { /* detached element */ }
  const meta: ModalMeta = {
    action,
    dialogText:
      accessibleName ||
      (el ? (el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 80)) : undefined),
    selector,
    nearestHeading,
    accessibleName,
    elementRect,
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    pageHeading,
    openOverlays,
  };
  return {
    id: generateId(),
    type: 'modal',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}

export function buildScreenshotEvent(label?: string): RecordedEvent {
  let pageHeading: string | undefined;
  let openOverlays: string[] | undefined;
  try {
    const frame = extractPageFrame();
    pageHeading = frame.pageHeading;
    openOverlays = frame.openOverlays.length ? frame.openOverlays : undefined;
  } catch { /* ignore */ }
  const meta: ScreenshotMeta = {
    label,
    pageHeading,
    openOverlays,
    skipHighlight: true,
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    scrollPosition: { x: window.scrollX, y: window.scrollY },
  };
  return {
    id: generateId(),
    type: 'screenshot',
    timestamp: Date.now(),
    url: location.href,
    pageTitle: document.title,
    metadata: meta,
  };
}
