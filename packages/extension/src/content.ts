import type {
  RecordedEvent,
  RecordingState,
  ExtensionMessage,
} from '@docext/shared';
import { resolveElement, isInteractiveElement, isStrongInteractive } from './lib/element-resolver.js';
import {
  isDuplicateClick,
  debounceInput,
  flushPendingInput,
  flushAllPending,
  resetFilters,
} from './lib/event-filter.js';
import { buildClickEvent, buildInputEvent, buildSelectEvent, buildSubmitEvent } from './lib/event-builders.js';
import {
  enterEditMode,
  exitEditMode,
  isEditMode,
  getDomEdits,
  startEditGuard,
  stopEditGuard,
  loadEditsFromStorage,
} from './lib/edit-mode.js';
import {
  createFloatingToolbar,
  destroyFloatingToolbar,
  updateToolbar,
  startToolbarTimer,
  stopToolbarTimer,
  getToolbarHost,
  hideToolbar,
  showToolbar,
  showHighlightPrompt,
  hideHighlightPrompt,
} from './lib/floating-toolbar.js';
import {
  startSpaObserver,
  stopSpaObserver,
  setLastClickTimestamp,
  pauseMutationObserver,
  resumeMutationObserver,
} from './lib/spa-observer.js';

// ── State ──

let isRecording = false;
let isReplayingClick = false;
let capturePaused = false;
let lastClickSentAt = 0;
const DEBUG_CLICK_PIPELINE = false;
let gateSafetyTimer: number | null = null;

// Highlight prompt auto-dismisses after 4000ms (see floating-toolbar.ts).
// The gate safety timer must outlive that plus the BG capture pipeline to
// avoid releasing the gate mid-capture. Bump together if either changes.
const HIGHLIGHT_PROMPT_TIMEOUT_MS = 4000;
const BG_PIPELINE_BUDGET_MS = 2000;
const GATE_SAFETY_TIMEOUT_MS = HIGHLIGHT_PROMPT_TIMEOUT_MS + BG_PIPELINE_BUDGET_MS;

// Guard against duplicate script injection
const INJECTED_KEY = '__docext_injected';
if ((window as any)[INJECTED_KEY]) {
  // Already injected — the existing listener handles messages.
} else {
  (window as any)[INJECTED_KEY] = true;
  initContentScript();
}

function initContentScript() {
  chrome.runtime.onMessage.addListener(messageHandler);
}

// Pointerdown → click coordination
let lastPointerCapture: {
  selector: string;
  time: number;
  promise: Promise<unknown>;
  target: Element;
  originalEvent?: PointerEvent;
  didPrevent: boolean;
  clientX: number;
  clientY: number;
} | null = null;

// ── Utilities ──

function safeSendMessage(msg: ExtensionMessage): Promise<unknown> {
  try {
    return chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

function dbg(...args: unknown[]) {
  if (!DEBUG_CLICK_PIPELINE) return;
  const t = Math.round(performance.now());
  console.log('[docext][content]', t, ...args);
}

function sendEvent(event: RecordedEvent) {
  if (capturePaused) return;
  safeSendMessage({ type: 'EVENT_CAPTURED', payload: event });
}

function setMainWorldClickGate(active: boolean) {
  try {
    if (gateSafetyTimer !== null) {
      window.clearTimeout(gateSafetyTimer);
      gateSafetyTimer = null;
    }
    dbg('main-world-gate', active ? 'ON' : 'OFF');
    window.postMessage({ __docextClickGate: active }, '*');
    if (active) {
      // Safety valve: never leave the gate stuck ON if a promise chain stalls.
      gateSafetyTimer = window.setTimeout(() => {
        window.postMessage({ __docextClickGate: false }, '*');
        gateSafetyTimer = null;
      }, GATE_SAFETY_TIMEOUT_MS);
    }
  } catch {}
}

function releaseGateThenReplay(run: () => void, delayMs = 24) {
  setMainWorldClickGate(false);
  // Give page listeners one frame to observe gate release before replay.
  window.setTimeout(() => {
    try { run(); } catch {}
  }, delayMs);
}

function isInsideToolbar(e: Event): boolean {
  const toolbar = getToolbarHost();
  if (!toolbar) return false;
  return e.composedPath().includes(toolbar);
}

const CONTAINER_ROLES = new Set(['menu', 'menubar', 'listbox', 'tablist', 'navigation', 'dialog', 'alertdialog']);
const CONTAINER_TAGS = new Set(['menu', 'nav', 'ul', 'ol', 'dialog']);
const FORM_FIELD_TAGS = new Set(['input', 'select', 'textarea']);

function hasActionableHints(n: Element): boolean {
  return (
    n.hasAttribute('aria-haspopup') ||
    n.hasAttribute('onclick') ||
    n.hasAttribute('data-action') ||
    n.getAttribute('role') === 'button' ||
    n.tagName.toLowerCase() === 'button' ||
    n.tagName.toLowerCase() === 'a'
  );
}

const VISUAL_ONLY_TAGS = new Set(['svg', 'img', 'path', 'circle', 'rect', 'line', 'polyline', 'polygon', 'use', 'g', 'icon', 'i', 'span']);

function findInteractiveAncestor(el: Element): Element | null {
  let node: Element | null = el;
  let depth = 0;
  let weakMatch: Element | null = null;

  while (node && depth < 10) {
    if (isStrongInteractive(node)) {
      const role = node.getAttribute('role');
      const tag = node.tagName.toLowerCase();
      if ((role && CONTAINER_ROLES.has(role)) || CONTAINER_TAGS.has(tag)) {
        if (!hasActionableHints(node)) {
          node = node.parentElement;
          depth++;
          continue;
        }
      }
      return node;
    }
    if (isInteractiveElement(node)) {
      const tag = node.tagName.toLowerCase();
      if (!weakMatch) {
        weakMatch = node;
      } else if (VISUAL_ONLY_TAGS.has(weakMatch.tagName.toLowerCase()) && !VISUAL_ONLY_TAGS.has(tag)) {
        weakMatch = node;
      }
    }
    node = node.parentElement;
    depth++;
  }

  return weakMatch;
}

function findPopupTriggerAncestor(el: Element): Element | null {
  let node: Element | null = el;
  let depth = 0;
  while (node && depth < 8) {
    const role = node.getAttribute('role');
    const tag = node.tagName.toLowerCase();
    const isContainer = role === 'menu' || role === 'menubar' || role === 'list' || role === 'listbox' || tag === 'menu' || tag === 'ul' || tag === 'ol' || tag === 'nav';
    const isTrigger =
      node.hasAttribute('aria-haspopup') ||
      node.hasAttribute('data-state') ||
      node.getAttribute('aria-expanded') !== null;
    if (isTrigger && !isContainer) return node;
    node = node.parentElement;
    depth++;
  }
  return null;
}

function liftFromVisualElement(el: Element): Element {
  if (!VISUAL_ONLY_TAGS.has(el.tagName.toLowerCase())) return el;
  let node = el.parentElement;
  let depth = 0;
  while (node && depth < 5) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'button' || tag === 'a' || node.getAttribute('role') === 'button' || node.getAttribute('role') === 'link') {
      return node;
    }
    if (!VISUAL_ONLY_TAGS.has(tag) && isInteractiveElement(node)) return node;
    node = node.parentElement;
    depth++;
  }
  return el;
}

function resolveClickTarget(rawTarget: Element): Element | null {
  const popupTrigger = findPopupTriggerAncestor(rawTarget);
  let target = popupTrigger || findInteractiveAncestor(rawTarget);
  if (!target) return null;
  target = liftFromVisualElement(target);
  const tag = target.tagName.toLowerCase();
  if (tag === 'html' || tag === 'body') return null;
  if (FORM_FIELD_TAGS.has(tag)) return null;
  return target;
}

// ── Event Handlers ──

const EPHEMERAL_SELECTORS = [
  // ARIA roles
  '[role="menu"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menubar"]',
  '[role="tooltip"]',
  '[role="dialog"][style*="position"]',
  '[aria-modal="true"]',
  // Radix UI
  '[data-radix-menu-content]',
  '[data-radix-dropdown-menu-content]',
  '[data-radix-select-content]',
  '[data-radix-popover-content]',
  '[data-radix-dialog-content]',
  '[data-radix-tooltip-content]',
  // Floating UI / Popper.js
  '[data-floating-ui-portal]',
  '[data-popper-placement]',
  // Headless UI
  '[data-headlessui-state]',
  // Tippy.js
  '.tippy-box',
  // Native HTML popover
  '[popover]',
  // Generic: any element with [data-state="open"] that is also positioned
  // (covers many React-based dropdown/combobox implementations)
  '[data-state="open"][style*="position"]',
].join(', ');

function isInsideEphemeralUI(el: Element): boolean {
  if (el.closest(EPHEMERAL_SELECTORS)) return true;

  // Fallback 1: React portals render overlays as direct children of <body>
  // with fixed/absolute positioning.
  let node: Element | null = el.parentElement;
  while (node && node !== document.documentElement) {
    const parent = node.parentElement;
    if (parent === document.body) {
      const cs = window.getComputedStyle(node);
      const pos = cs.position;
      const display = cs.display;
      const visibility = cs.visibility;
      if (
        (pos === 'fixed' || pos === 'absolute') &&
        display !== 'none' &&
        visibility !== 'hidden'
      ) {
        return true;
      }
    }
    node = parent;
  }

  // Fallback 2: inline (non-portal) popups — absolutely/fixed positioned
  // ancestor with a z-index that puts it in the overlay layer (≥ 100).
  // Sticky nav bars and sidebars rarely have z-index that high AND have
  // interactive items worth clicking mid-sequence.
  node = el.parentElement;
  while (node && node !== document.documentElement && node !== document.body) {
    const cs = window.getComputedStyle(node);
    const zi = parseInt(cs.zIndex, 10);
    if (
      !isNaN(zi) && zi >= 100 &&
      (cs.position === 'fixed' || cs.position === 'absolute') &&
      cs.display !== 'none' &&
      cs.visibility !== 'hidden'
    ) {
      return true;
    }
    node = node.parentElement;
  }

  return false;
}

function resolveReplayTarget(target: Element, selector?: string, coords?: { x: number; y: number }): Element | null {
  if (document.contains(target)) return target;
  if (selector) {
    const found = document.querySelector(selector);
    if (found) return found;
  }
  if (coords) {
    const found = document.elementFromPoint(coords.x, coords.y);
    if (found && found.tagName.toLowerCase() !== 'html' && found.tagName.toLowerCase() !== 'body') return found;
  }
  return null;
}

function replayClick(target: Element, selector?: string, coords?: { x: number; y: number }) {
  const el = resolveReplayTarget(target, selector, coords);
  if (!el) return;
  dbg('replayClick', { selector, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' });
  isReplayingClick = true;
  try {
    if (typeof (el as HTMLElement).click === 'function') {
      (el as HTMLElement).click();
    } else {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  } finally {
    isReplayingClick = false;
  }
}

function replayFullChain(target: Element, origPointerEvent: PointerEvent, selector?: string, coords?: { x: number; y: number }) {
  const el = resolveReplayTarget(target, selector, coords);
  if (!el) return;
  dbg('replayFullChain', { selector, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '' });
  isReplayingClick = true;
  try {
    const opts = {
      bubbles: true, cancelable: true,
      clientX: origPointerEvent.clientX, clientY: origPointerEvent.clientY,
      screenX: origPointerEvent.screenX, screenY: origPointerEvent.screenY,
      button: origPointerEvent.button, buttons: origPointerEvent.buttons,
      pointerId: origPointerEvent.pointerId, pointerType: origPointerEvent.pointerType,
    };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    if (typeof (el as HTMLElement).click === 'function') {
      (el as HTMLElement).click();
    } else {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    }
  } finally {
    isReplayingClick = false;
  }
}

function handlePointerdown(e: PointerEvent) {
  if (isReplayingClick) return;
  if (!isRecording || isEditMode() || capturePaused) return;
  const rawTarget = e.target as Element;
  if (!rawTarget || isInsideToolbar(e)) return;

  const target = resolveClickTarget(rawTarget);
  if (!target) return;

  // If user clicks away from an active text field, flush its pending debounced
  // input first so typed edits are recorded before the click action.
  const active = document.activeElement;
  if (
    active &&
    active !== target &&
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
  ) {
    const activeInfo = resolveElement(active);
    flushPendingInput(activeInfo.selector, sendEvent);
  }

  const info = resolveElement(target);
  if (isDuplicateClick(info.selector, Date.now())) return;

  // Always gate and prevent so the screenshot captures pre-click page state.
  // For needsPrevent targets this was already happening; extending to all
  // interactive elements ensures focus/hover changes don't pollute the capture.
  e.stopImmediatePropagation();
  e.preventDefault();
  setMainWorldClickGate(true);
  const needsPrevent = true;

  dbg('pointerdown', {
    tag: target.tagName.toLowerCase(),
    role: target.getAttribute('role') || '',
    selector: info.selector,
    needsPrevent,
    inEphemeral: isInsideEphemeralUI(target),
    isTrusted: e.isTrusted,
  });

  const ephemeral = isInsideEphemeralUI(target);
  const capturedEvent = buildClickEvent(target, e, info, getDomEdits(), { inEphemeralUI: ephemeral || undefined });
  const label = info.text || info.ariaLabel || info.fieldLabel || info.selector;

  const dispatchAndReplay = (ev: typeof capturedEvent) => {
    lastClickSentAt = Date.now();
    setLastClickTimestamp(lastClickSentAt);
    const promise = safeSendMessage({ type: 'EVENT_CAPTURED', payload: ev });
    promise.then(() => dbg('event-captured-ack', info.selector)).catch(() => dbg('event-captured-ack-failed', info.selector));

    lastPointerCapture = {
      selector: info.selector,
      time: Date.now(),
      promise,
      target,
      originalEvent: needsPrevent ? e : undefined,
      didPrevent: needsPrevent,
      clientX: e.clientX,
      clientY: e.clientY,
    };

    const sel = info.selector;
    const fallback = { x: e.clientX, y: e.clientY };
    const eventId = ev.id;

    const afterReplay = () => {
      // Screenshot already captured — prompt is purely an annotation decision.
      // Show after replay so ephemeral UI (hover menus, sidebars) has closed naturally.
      if (isTopFrame) {
        showHighlightPrompt(
          label,
          () => {}, // Yes: default — screenshot will be annotated
          () => safeSendMessage({ type: 'SET_SKIP_HIGHLIGHT', payload: { eventId } }),
        );
      }
    };

    promise
      .then(() => {
        releaseGateThenReplay(() => {
          lastClickSentAt = Date.now();
          setLastClickTimestamp(lastClickSentAt);
          replayFullChain(target, e, sel, fallback);
          afterReplay();
        }, ephemeral ? 90 : 24);
      })
      .catch(() => {
        releaseGateThenReplay(() => {
          lastClickSentAt = Date.now();
          setLastClickTimestamp(lastClickSentAt);
          replayFullChain(target, e, sel, fallback);
          afterReplay();
        }, ephemeral ? 90 : 24);
      });
  };

  dispatchAndReplay(capturedEvent);
}

function handlePointerup(e: PointerEvent) {
  if (isReplayingClick) return;
  if (!isRecording || isEditMode() || capturePaused) return;
  if (!lastPointerCapture) return;

  const now = Date.now();
  if (now - lastPointerCapture.time > 1200) return;
  if (!lastPointerCapture.didPrevent) return;
  dbg('pointerup-blocked', { selector: lastPointerCapture.selector, isTrusted: e.isTrusted });

  const rawTarget = e.target as Element | null;
  if (rawTarget && isInsideToolbar(e)) return;

  // Some UI libraries (e.g. Radix) commit selection on pointerup.
  // Block pointerup while the screenshot pipeline is in progress.
  e.preventDefault();
  e.stopImmediatePropagation();
}

function handleClick(e: MouseEvent) {
  if (isReplayingClick) return;
  if (!isRecording || isEditMode()) return;
  const rawTarget = e.target as Element;
  if (!rawTarget || isInsideToolbar(e)) return;

  const target = resolveClickTarget(rawTarget);
  if (!target) return;

  const now = Date.now();
  dbg('click', { tag: target.tagName.toLowerCase(), role: target.getAttribute('role') || '', isTrusted: e.isTrusted });

  if (lastPointerCapture && now - lastPointerCapture.time < 800) {
    e.preventDefault();
    e.stopImmediatePropagation();
    // didPrevent is always true now (gate+prevent on all interactive pointerdowns).
    // Release any stale lastPointerCapture; replay is handled by dispatchAndReplay.
    lastPointerCapture = null;
    return;
  }

  if (capturePaused) return;

  lastPointerCapture = null;
  const info = resolveElement(target);
  if (isDuplicateClick(info.selector, now)) return;

  const ephemeralFallback = isInsideEphemeralUI(target);
  const capturedEvent = buildClickEvent(target, e, info, getDomEdits(), { inEphemeralUI: ephemeralFallback || undefined });
  const label = info.text || info.ariaLabel || info.fieldLabel || info.selector;

  e.preventDefault();
  e.stopImmediatePropagation();
  setMainWorldClickGate(true);

  const replayTarget = target;
  const sel = info.selector;
  const fallback = { x: e.clientX, y: e.clientY };
  const eventId = capturedEvent.id;

  lastClickSentAt = Date.now();
  setLastClickTimestamp(lastClickSentAt);
  safeSendMessage({ type: 'EVENT_CAPTURED', payload: capturedEvent })
    .then(() => {
      releaseGateThenReplay(() => {
        lastClickSentAt = Date.now();
        setLastClickTimestamp(lastClickSentAt);
        replayClick(replayTarget, sel, fallback);
        if (isTopFrame) {
          showHighlightPrompt(
            label,
            () => {},
            () => safeSendMessage({ type: 'SET_SKIP_HIGHLIGHT', payload: { eventId } }),
          );
        }
      }, ephemeralFallback ? 90 : 24);
    })
    .catch(() => {
      releaseGateThenReplay(() => {
        lastClickSentAt = Date.now();
        setLastClickTimestamp(lastClickSentAt);
        replayClick(replayTarget, sel, fallback);
        if (isTopFrame) {
          showHighlightPrompt(
            label,
            () => {},
            () => safeSendMessage({ type: 'SET_SKIP_HIGHLIGHT', payload: { eventId } }),
          );
        }
      }, ephemeralFallback ? 90 : 24);
    });
}

function handleBlur(e: FocusEvent) {
  if (!isRecording || isEditMode() || capturePaused) return;
  const target = e.target as Element;
  if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)) return;

  const info = resolveElement(target);
  // Blur should flush pending debounced input only; emitting a fresh input event
  // here duplicates actions for modal/save flows.
  flushPendingInput(info.selector, sendEvent);
}

function handleChange(e: Event) {
  if (!isRecording || isEditMode() || capturePaused) return;
  const target = e.target as Element;
  if (target instanceof HTMLSelectElement) {
    const info = resolveElement(target);
    sendEvent(buildSelectEvent(target, info));
    return;
  }
}

function handleInput(e: Event) {
  if (!isRecording || isEditMode() || capturePaused) return;
  const target = e.target as Element;
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const info = resolveElement(target);
    debounceInput(buildInputEvent(target, info), info.selector, sendEvent);
  }
}

function handleSubmit(e: Event) {
  if (!isRecording || isEditMode() || capturePaused) return;
  const form = e.target as HTMLFormElement;
  if (!(form instanceof HTMLFormElement)) return;
  flushAllPending(sendEvent);
  // A submit immediately after a captured click (e.g., "Save") is the same
  // user intent. Skip duplicate submit events in that window.
  if (Date.now() - lastClickSentAt < 1200) return;
  sendEvent(buildSubmitEvent(form));
}

// ── Start/Stop Recording ──

const isTopFrame = window === window.top;

function startRecording() {
  if (isRecording) return;
  isRecording = true;
  capturePaused = false;
  lastPointerCapture = null;
  lastClickSentAt = 0;

  document.addEventListener('pointerdown', handlePointerdown, true);
  document.addEventListener('pointerup', handlePointerup, true);
  document.addEventListener('click', handleClick, true);
  document.addEventListener('blur', handleBlur, true);
  document.addEventListener('input', handleInput, true);
  document.addEventListener('change', handleChange, true);
  document.addEventListener('submit', handleSubmit, true);

  if (isTopFrame) {
    startSpaObserver({
      sendEvent,
      isCapturePaused: () => capturePaused,
    });
    createFloatingToolbar(isEditMode(), () => {
      safeSendMessage({ type: isEditMode() ? 'EXIT_EDIT_MODE' : 'ENTER_EDIT_MODE' });
    });
    startToolbarTimer();
    startEditGuard();
    loadEditsFromStorage();
  }
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;

  if (isTopFrame) {
    stopEditGuard();
    if (isEditMode()) exitEditMode();
  }

  lastPointerCapture = null;
  capturePaused = false;
  document.removeEventListener('pointerdown', handlePointerdown, true);
  document.removeEventListener('pointerup', handlePointerup, true);
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('blur', handleBlur, true);
  document.removeEventListener('input', handleInput, true);
  document.removeEventListener('change', handleChange, true);
  document.removeEventListener('submit', handleSubmit, true);

  if (isTopFrame) {
    stopSpaObserver();
    flushAllPending(sendEvent);
    resetFilters();
    stopToolbarTimer();
    hideHighlightPrompt();
    destroyFloatingToolbar();
  }
}

// ── Message Handler ──

function messageHandler(message: ExtensionMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) {
  switch (message.type) {
    case 'START_RECORDING':
      startRecording();
      sendResponse({ ok: true });
      break;
    case 'STOP_RECORDING':
    case 'CANCEL_RECORDING':
      stopRecording();
      sendResponse({ ok: true });
      break;
    case 'ENTER_EDIT_MODE':
      enterEditMode();
      sendResponse({ ok: true });
      break;
    case 'EXIT_EDIT_MODE':
      exitEditMode();
      sendResponse({ ok: true });
      break;
    case 'PAUSE_CAPTURE':
      capturePaused = true;
  setMainWorldClickGate(false);
      pauseMutationObserver();
      sendResponse({ ok: true });
      break;
    case 'RESUME_CAPTURE':
      capturePaused = false;
      resumeMutationObserver();
      sendResponse({ ok: true });
      break;
    case 'TOGGLE_THEME': {
      const payload = message.payload as { theme: string } | undefined;
      if (payload) {
        const savedFocus = document.activeElement;
        const html = document.documentElement;
        if (payload.theme === 'dark') {
          html.classList.add('dark');
          html.setAttribute('data-theme', 'dark');
          html.style.colorScheme = 'dark';
        } else if (payload.theme === 'light') {
          html.classList.remove('dark');
          html.setAttribute('data-theme', 'light');
          html.style.colorScheme = 'light';
        } else {
          html.classList.remove('dark');
          html.removeAttribute('data-theme');
          html.style.colorScheme = '';
        }
        if (savedFocus instanceof HTMLElement) {
          try { savedFocus.focus({ preventScroll: true }); } catch {}
        }
      }
      sendResponse({ ok: true });
      break;
    }
    case 'RECORDING_STATE': {
      const s = message.payload as RecordingState;
      if (s) updateToolbar(s);
      sendResponse({ ok: true });
      break;
    }
    case 'HIDE_TOOLBAR':
      hideToolbar();
      sendResponse({ ok: true });
      break;
    case 'SHOW_TOOLBAR':
      showToolbar();
      sendResponse({ ok: true });
      break;
    case 'GET_STATE':
      sendResponse({ isRecording, editMode: isEditMode() });
      break;
  }
  return true;
}
