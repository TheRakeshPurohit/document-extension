import type { RecordedEvent } from '@docext/shared';
import { buildNavigateEvent, buildModalEvent } from './event-builders.js';

let urlObserverInterval: ReturnType<typeof setInterval> | null = null;
let mutationObserver: MutationObserver | null = null;
let lastUrl = location.href;
let lastClickSentAt = 0;
let sendEventFn: ((event: RecordedEvent) => void) | null = null;
let capturePausedFn: (() => boolean) | null = null;

const CLICK_COOLDOWN_MS = 4000;

export function setLastClickTimestamp(ts: number) {
  lastClickSentAt = ts;
}

export function checkUrlChange() {
  const currentUrl = location.href;
  if (currentUrl !== lastUrl) {
    const fromUrl = lastUrl;
    lastUrl = currentUrl;
    if (Date.now() - lastClickSentAt < CLICK_COOLDOWN_MS) return;
    sendEventFn?.(buildNavigateEvent(fromUrl, currentUrl));
  }
}

const HISTORY_PATCHED = '__docext_history_patched';
let savedPushState: typeof history.pushState | null = null;
let savedReplaceState: typeof history.replaceState | null = null;

export function patchHistory() {
  if ((history as any)[HISTORY_PATCHED]) return;
  savedPushState = history.pushState;
  savedReplaceState = history.replaceState;
  history.pushState = function (...args) {
    savedPushState!.apply(this, args);
    setTimeout(checkUrlChange, 50);
  };
  history.replaceState = function (...args) {
    savedReplaceState!.apply(this, args);
    setTimeout(checkUrlChange, 50);
  };
  (history as any)[HISTORY_PATCHED] = true;
}

export function unpatchHistory() {
  if (savedPushState) history.pushState = savedPushState;
  if (savedReplaceState) history.replaceState = savedReplaceState;
  savedPushState = null;
  savedReplaceState = null;
  delete (history as any)[HISTORY_PATCHED];
}

export function isModalElement(node: HTMLElement): boolean {
  if (node.tagName === 'DIALOG') return true;
  const role = node.getAttribute('role');
  if (role === 'dialog' || role === 'alertdialog') return true;
  if (node.getAttribute('aria-modal') === 'true') return true;
  if (node.classList.contains('modal') || node.classList.contains('Modal')) return true;

  try {
    const cs = getComputedStyle(node);
    const isOverlay = (cs.position === 'fixed' || cs.position === 'absolute') &&
      parseInt(cs.zIndex || '0') > 100;
    if (isOverlay && node.offsetWidth > window.innerWidth * 0.5 && node.offsetHeight > window.innerHeight * 0.3) {
      return true;
    }
  } catch { /* detached or cross-origin */ }

  return false;
}

export function pauseMutationObserver() {
  if (mutationObserver) mutationObserver.disconnect();
}

export function resumeMutationObserver() {
  if (mutationObserver) {
    mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
  }
}

export function setupMutationObserver() {
  if (mutationObserver) return;
  const trackedModals = new WeakSet<Element>();
  mutationObserver = new MutationObserver((mutations) => {
    if (capturePausedFn?.()) return;
    if (Date.now() - lastClickSentAt < CLICK_COOLDOWN_MS) return;
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        // Cheap attribute check before getComputedStyle
        const looksModal =
          node.tagName === 'DIALOG' ||
          node.getAttribute('role') === 'dialog' ||
          node.getAttribute('role') === 'alertdialog' ||
          node.getAttribute('aria-modal') === 'true' ||
          node.classList.contains('modal') ||
          node.classList.contains('Modal');
        if (looksModal && isModalElement(node)) {
          trackedModals.add(node);
          lastClickSentAt = Date.now();
          sendEventFn?.(buildModalEvent('open', node));
          return;
        }
        const dialog = node.querySelector('[role="dialog"], [role="alertdialog"], dialog, [aria-modal="true"]');
        if (dialog instanceof HTMLElement && isModalElement(dialog)) {
          trackedModals.add(dialog);
          lastClickSentAt = Date.now();
          sendEventFn?.(buildModalEvent('open', dialog));
          return;
        }
      }

      for (const node of mutation.removedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const looksModal =
          node.tagName === 'DIALOG' ||
          node.getAttribute('role') === 'dialog' ||
          node.getAttribute('role') === 'alertdialog' ||
          node.getAttribute('aria-modal') === 'true';
        if (looksModal || trackedModals.has(node)) {
          lastClickSentAt = Date.now();
          sendEventFn?.(buildModalEvent('close', node));
          return;
        }
      }

      if (mutation.type === 'attributes' && mutation.target instanceof HTMLElement) {
        const target = mutation.target;
        if (mutation.attributeName === 'open' && target.tagName === 'DIALOG') {
          if (target.hasAttribute('open')) {
            trackedModals.add(target);
            lastClickSentAt = Date.now();
            sendEventFn?.(buildModalEvent('open', target));
          } else {
            lastClickSentAt = Date.now();
            sendEventFn?.(buildModalEvent('close', target));
          }
        }
      }
    }
  });
  mutationObserver.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
}

export interface SpaObserverCallbacks {
  sendEvent: (event: RecordedEvent) => void;
  isCapturePaused: () => boolean;
}

export function startSpaObserver(callbacks: SpaObserverCallbacks) {
  sendEventFn = callbacks.sendEvent;
  capturePausedFn = callbacks.isCapturePaused;
  lastUrl = location.href;
  lastClickSentAt = 0;

  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('hashchange', checkUrlChange);
  patchHistory();
  setupMutationObserver();
  // No polling interval — history patches + popstate/hashchange cover SPA nav
}

export function stopSpaObserver() {
  window.removeEventListener('popstate', checkUrlChange);
  window.removeEventListener('hashchange', checkUrlChange);
  unpatchHistory();

  if (mutationObserver) {
    mutationObserver.disconnect();
    mutationObserver = null;
  }
  if (urlObserverInterval) {
    clearInterval(urlObserverInterval);
    urlObserverInterval = null;
  }

  sendEventFn = null;
  capturePausedFn = null;
}
