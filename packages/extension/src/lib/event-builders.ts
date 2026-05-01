import type {
  RecordedEvent,
  ClickMeta,
  InputMeta,
  SelectMeta,
  NavigateMeta,
  SubmitMeta,
  ModalMeta,
  DomEdit,
} from '@docext/shared';
import { resolveElement, type ElementInfo } from './element-resolver.js';

const SENSITIVE_RE = /password|secret|token|ssn|credit.?card|cvv|pin|social.?security/i;

function pickBestHighlightTarget(hit: Element): Element {
  const actionable = hit.closest(
    'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], a, input, select, textarea'
  );
  let best: Element = actionable || hit;
  let bestRect = best.getBoundingClientRect();

  // If we landed on a small text/icon wrapper, climb to a likely clickable container.
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

    // Never promote highlight to overlay/dialog style containers.
    if (isContainerRole || looksLikeOverlay) {
      node = node.parentElement;
      depth++;
      continue;
    }

    // Hard area cap: never promote if ancestor is more than 6× bigger.
    const bestArea = bestRect.width * bestRect.height;
    const nodeArea = rect.width * rect.height;
    if (nodeArea > bestArea * 6) {
      node = node.parentElement;
      depth++;
      continue;
    }

    // Require the promotion target to be a strongly-interactive semantic element —
    // no generic div/span containers, even if they have cursor:pointer.
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

export function buildClickEvent(
  el: Element,
  e: MouseEvent | PointerEvent,
  info: ElementInfo,
  domEdits: DomEdit[],
  opts?: { inEphemeralUI?: boolean },
): RecordedEvent {
  const r = el.getBoundingClientRect();
  let highlightRect = r;
  // In popups/modals/portals we often resolve structural wrappers.
  // Prefer hit-point actionable rect for more reliable highlights.
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
  const meta: ClickMeta = {
    elementTag: info.tag,
    elementText: info.text,
    ariaLabel: info.ariaLabel,
    role: info.role,
    selector: info.selector,
    coordinates: { x: e.clientX, y: e.clientY },
    elementRect: { x: highlightRect.left, y: highlightRect.top, width: highlightRect.width, height: highlightRect.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    nearestHeading: info.nearestHeading,
    sectionLabel: info.sectionLabel,
    containerRole: info.containerRole,
    href: info.href,
    title: info.title,
    parentText: info.parentText,
    fieldLabel: info.fieldLabel,
    breadcrumb: info.breadcrumb,
    tooltipText: info.tooltipText,
    inputValue: info.inputValue,
    parentId: info.parentId,
    parentName: info.parentName,
    listPosition: info.listPosition,
    nearbyText: info.nearbyText,
    viewportHint: info.viewportHint,
    semanticClasses: info.semanticClasses,
    inEphemeralUI: opts?.inEphemeralUI || undefined,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
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
  const label = info.fieldLabel || info.ariaLabel || info.placeholder || info.tag;
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
    nearestHeading: info.nearestHeading,
    sectionLabel: info.sectionLabel,
    containerRole: info.containerRole,
    breadcrumb: info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    parentId: info.parentId,
    listPosition: info.listPosition,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
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
  const selectedOption = el.options[el.selectedIndex]?.text || el.value;
  const label = info.fieldLabel || info.ariaLabel || info.placeholder || 'dropdown';
  const r = el.getBoundingClientRect();
  const meta: SelectMeta = {
    fieldLabel: label,
    selectedOption,
    selector: info.selector,
    nearestHeading: info.nearestHeading,
    sectionLabel: info.sectionLabel,
    containerRole: info.containerRole,
    breadcrumb: info.breadcrumb,
    elementRect: { x: r.left, y: r.top, width: r.width, height: r.height },
    viewportSize: { width: window.innerWidth, height: window.innerHeight },
    parentId: info.parentId,
    listPosition: info.listPosition,
    scrollPosition: { x: window.scrollX, y: window.scrollY },
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
  const meta: NavigateMeta = { fromUrl, toUrl, newTitle: document.title };
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
  const meta: SubmitMeta = {
    formName: form.name || form.getAttribute('aria-label') || undefined,
    formAction: form.action || undefined,
    fieldCount: form.elements.length,
  };
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
  try {
    if (el) selector = resolveElement(el).selector;
  } catch { /* detached element */ }
  const meta: ModalMeta = {
    action,
    dialogText: el ? (el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 80)) : undefined,
    selector,
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
