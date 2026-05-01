import type { DomEdit } from '@docext/shared';
import { resolveElement, buildSelector, type ElementInfo } from './element-resolver.js';
import { getToolbarHost } from './floating-toolbar.js';

// ── Constants ──

const EDIT_GUARD_DEBOUNCE_MS = 400;
const DELETED_SENTINEL = '___DELETED___';

const TEXT_LEAF_TAGS = new Set([
  'p', 'span', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'a', 'button', 'label',
  'td', 'th', 'li', 'dt', 'dd', 'figcaption', 'legend', 'summary', 'em',
  'strong', 'b', 'i', 'u', 'small', 'mark', 'del', 'ins', 'sub', 'sup', 'cite',
]);

const STRUCTURAL_TAGS = new Set([
  'div', 'section', 'main', 'header', 'footer', 'nav', 'aside',
  'article', 'form', 'fieldset', 'details', 'dialog', 'figure',
  'table', 'thead', 'tbody', 'tr', 'ul', 'ol', 'dl',
]);

const NON_EDITABLE_TAGS = new Set(['svg', 'img', 'video', 'canvas', 'iframe', 'script', 'style']);

// ── State ──

interface PersistedEdit {
  original: string;
  modified: string;
  tag: string;
  ancestorPath?: string;
  /** Short signature of the nearest meaningful ancestors (role / aria-label /
   *  stable id). Used to disambiguate popup re-mounts where the saved
   *  ancestorPath is structurally similar but the actual context differs. */
  ancestorSignature?: string;
}

let editModeActive = false;
let domSnapshot: WeakMap<Node, string> = new WeakMap();
let activeEditable: HTMLElement | null = null;
let selectedElement: HTMLElement | null = null;
let domEdits: DomEdit[] = [];

const persistedEdits: Map<string, PersistedEdit> = new Map();
let editGuardObserver: MutationObserver | null = null;
let applyingEdits = false;
let editGuardDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// ── Public Getters ──

export function isEditMode(): boolean { return editModeActive; }
export function getDomEdits(): DomEdit[] { return domEdits; }
export function getActiveEditable(): HTMLElement | null { return activeEditable; }

// ── Persistent Edit Guard ──

function normalizeWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function getAncestorPath(el: Element): string {
  const parts: string[] = [];
  let cur = el.parentElement;
  while (cur && parts.length < 4) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const id = cur.getAttribute('id');
    const role = cur.getAttribute('role');
    let seg = tag;
    if (id) seg += `#${id.slice(0, 20)}`;
    else if (role) seg += `[${role}]`;
    parts.push(seg);
    cur = cur.parentElement;
  }
  return parts.join('/');
}

function ancestorPathMatches(elPath: string, storedPath: string): boolean {
  if (!storedPath || !elPath) return true;
  const elParts = elPath.split('/');
  const storedParts = storedPath.split('/');
  let matches = 0;
  const check = Math.min(elParts.length, storedParts.length, 3);
  for (let i = 0; i < check; i++) {
    if (elParts[i] === storedParts[i]) matches++;
  }
  return check === 0 || matches >= Math.ceil(check / 2);
}

/** Build a fingerprint from up to 6 ancestors using semantically meaningful
 *  attributes only (role / aria-label / stable id / dialog-like tags).
 *  Differs from `getAncestorPath` (which uses tag chain). The richer signal
 *  helps when popups remount with different structural ancestors but
 *  consistent semantic ones. */
function getAncestorSignature(el: Element): string {
  const parts: string[] = [];
  let cur = el.parentElement;
  let depth = 0;
  while (cur && depth < 6) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const role = cur.getAttribute('role');
    const aria = cur.getAttribute('aria-label');
    const id = cur.getAttribute('id');
    let token = '';
    if (aria && aria.length < 80) token = `a:${aria}`;
    else if (role) token = `r:${role}`;
    else if (id && id.length < 40 && !/[:.\[\]]/.test(id)) token = `i:${id}`;
    else if (tag === 'dialog' || tag === 'nav' || tag === 'aside' || tag === 'header' || tag === 'footer') token = `t:${tag}`;
    if (token) parts.push(token);
    cur = cur.parentElement;
    depth++;
  }
  return parts.join('|');
}

function signatureMatchScore(elSig: string, storedSig: string): number {
  if (!storedSig) return 0;
  if (!elSig) return 0;
  const elParts = new Set(elSig.split('|'));
  const storedParts = storedSig.split('|');
  let matched = 0;
  for (const p of storedParts) if (elParts.has(p)) matched++;
  return matched;
}

function findElementByOriginalText(edit: PersistedEdit): Element | null {
  if (!edit.original) return null;
  const needle = normalizeWs(edit.original);
  if (!needle) return null;
  try {
    const candidates = document.querySelectorAll(edit.tag);
    let best: Element | null = null;
    let bestSigScore = -1;
    let bestChildren = Infinity;
    for (const el of candidates) {
      if (el === activeEditable || el.contains(activeEditable!)) continue;
      if ((el as HTMLElement).dataset?.docextHidden) continue;
      if (el instanceof HTMLElement && !isSafeToHide(el)) continue;
      if (normalizeWs(el.textContent || '') !== needle) continue;
      if (edit.ancestorPath && !ancestorPathMatches(getAncestorPath(el), edit.ancestorPath)) continue;

      const sigScore = edit.ancestorSignature
        ? signatureMatchScore(getAncestorSignature(el), edit.ancestorSignature)
        : 0;
      const count = el.children.length;
      // Prefer highest signature score; break ties by fewest children.
      if (sigScore > bestSigScore || (sigScore === bestSigScore && count < bestChildren)) {
        best = el;
        bestSigScore = sigScore;
        bestChildren = count;
      }
    }
    return best;
  } catch { /* DOM traversal error */ }
  return null;
}

/**
 * Strategy for applying a text-only edit:
 *   - If the element has element children (e.g. icons, badges, nested spans),
 *     write the new value into the FIRST text node and CLEAR all other text
 *     nodes. This keeps framework-managed sub-trees intact while preventing
 *     stale trailing text nodes (e.g. "<modified> world!" when the original
 *     contained `<p>Hello <strong>world</strong>!</p>`).
 *   - If the element has no element children, set textContent directly.
 *   This avoids infinite MutationObserver loops and keeps rendered text
 *   exactly equal to `newText`.
 */
function isSafeToHide(el: HTMLElement): boolean {
  try {
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    if (rect.width > vw * 0.5 && rect.height > vh * 0.4) return false;
    const tag = el.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html' || tag === 'main') return false;
    if (el.id === 'app' || el.id === 'root' || el.id === '__next') return false;
    const role = el.getAttribute('role');
    if (role === 'main' || role === 'application') return false;
  } catch { /* detached element */ }
  return true;
}

function hideElement(el: HTMLElement) {
  if (!isSafeToHide(el)) return;
  el.style.setProperty('display', 'none', 'important');
  el.dataset.docextHidden = '1';
}

function applyTextEdit(el: Element, newText: string) {
  const hasElementChildren = el.children.length > 0;
  if (!hasElementChildren) {
    el.textContent = newText;
    return;
  }

  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text);

  if (textNodes.length === 0) {
    el.textContent = newText;
    return;
  }

  textNodes[0].nodeValue = newText;
  for (let i = 1; i < textNodes.length; i++) {
    textNodes[i].nodeValue = '';
  }
}

function selectorMatchesContent(el: Element, edit: PersistedEdit): boolean {
  const elText = normalizeWs(el.textContent || '');
  const origText = normalizeWs(edit.original);

  if (origText === '' || origText.length < 5) {
    if (elText.length > 10) return false;
    if (el.tagName.toLowerCase() !== edit.tag) return false;
    if (edit.ancestorPath) {
      return ancestorPathMatches(getAncestorPath(el), edit.ancestorPath);
    }
    return true;
  }
  if (elText === origText) return true;
  if (edit.modified !== DELETED_SENTINEL && elText === normalizeWs(edit.modified)) return true;
  return false;
}

function applyPersistedEdits() {
  if (persistedEdits.size === 0 || applyingEdits) return;
  applyingEdits = true;
  try {
    const selectorUpdates: [string, string, PersistedEdit][] = [];

    for (const [selector, edit] of persistedEdits) {
      try {
        let el = document.querySelector(selector);

        if (el && (el === activeEditable || el.contains(activeEditable!))) continue;
        if (el && el instanceof HTMLElement && !isSafeToHide(el)) continue;

        // Verify selector still points to the right element by checking content
        if (el && !selectorMatchesContent(el, edit)) {
          el = null;
        }

        // Handle deletions — fall back to text match if selector fails
        if (edit.modified === DELETED_SENTINEL) {
          if (!el && edit.original !== DELETED_SENTINEL) {
            el = findElementByOriginalText(edit);
            if (el) {
              const newSelector = buildSelector(el);
              if (newSelector !== selector) selectorUpdates.push([selector, newSelector, edit]);
            }
          }
          if (el && el instanceof HTMLElement) hideElement(el);
          continue;
        }

        if (!el || (el.textContent || '').trim() === edit.modified.trim()) {
          if (el) continue;
          el = findElementByOriginalText(edit);
          if (!el) continue;
          const newSelector = buildSelector(el);
          if (newSelector !== selector) {
            selectorUpdates.push([selector, newSelector, edit]);
          }
        }

        if (el.textContent !== edit.modified) {
          applyTextEdit(el, edit.modified);
        }
      } catch { /* invalid selector or DOM error */ }
    }

    for (const [oldSel, newSel, edit] of selectorUpdates) {
      persistedEdits.delete(oldSel);
      persistedEdits.set(newSel, edit);
    }
    if (selectorUpdates.length > 0) saveEditsToStorage();
  } finally {
    applyingEdits = false;
  }
}

let editGuardRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleEditGuard(immediate: boolean) {
  if (immediate) {
    if (editGuardDebounceTimer) clearTimeout(editGuardDebounceTimer);
    editGuardDebounceTimer = setTimeout(() => {
      editGuardDebounceTimer = null;
      if (!applyingEdits && !activeEditable) applyPersistedEdits();
    }, 16);
    // Follow-up pass for async-rendered content (dropdowns, modals)
    if (editGuardRetryTimer) clearTimeout(editGuardRetryTimer);
    editGuardRetryTimer = setTimeout(() => {
      editGuardRetryTimer = null;
      if (!applyingEdits && !activeEditable) applyPersistedEdits();
    }, 300);
    return;
  }
  if (editGuardDebounceTimer) clearTimeout(editGuardDebounceTimer);
  editGuardDebounceTimer = setTimeout(() => {
    editGuardDebounceTimer = null;
    if (!applyingEdits && !activeEditable) applyPersistedEdits();
  }, EDIT_GUARD_DEBOUNCE_MS);
}

export function startEditGuard() {
  if (editGuardObserver) return;
  editGuardObserver = new MutationObserver((mutations) => {
    if (applyingEdits) return;
    let hasNewNodes = false;
    for (const m of mutations) {
      if (m.addedNodes.length > 0) { hasNewNodes = true; break; }
    }
    scheduleEditGuard(hasNewNodes);
  });
  editGuardObserver.observe(document.body, { childList: true, subtree: true });
}

export function stopEditGuard() {
  if (editGuardDebounceTimer) {
    clearTimeout(editGuardDebounceTimer);
    editGuardDebounceTimer = null;
  }
  if (editGuardRetryTimer) {
    clearTimeout(editGuardRetryTimer);
    editGuardRetryTimer = null;
  }
  if (editGuardObserver) {
    editGuardObserver.disconnect();
    editGuardObserver = null;
  }
  persistedEdits.clear();
  chrome.storage.local.remove('docext_edits').catch(() => {});
}

function saveEditsToStorage() {
  if (persistedEdits.size === 0) {
    chrome.storage.local.remove('docext_edits').catch(() => {});
    return;
  }
  const data: Record<string, PersistedEdit> = {};
  for (const [k, v] of persistedEdits) data[k] = v;
  chrome.storage.local.set({ docext_edits: data }).catch(() => {});
}

export async function loadEditsFromStorage() {
  try {
    const result = await chrome.storage.local.get('docext_edits');
    const stored = result?.docext_edits as Record<string, PersistedEdit> | undefined;
    if (!stored) return;
    for (const [selector, edit] of Object.entries(stored)) {
      if (edit && edit.modified && edit.tag) {
        persistedEdits.set(selector, edit);
        // Re-hydrate the domEdits array so click events captured AFTER a page
        // refresh still carry the historical edit list (otherwise clicks would
        // appear to undo the edits when replayed for documentation).
        if (edit.modified !== '___DELETED___') {
          domEdits.push({ selector, original: edit.original, modified: edit.modified });
        }
      }
    }
    if (persistedEdits.size === 0) return;

    applyPersistedEdits();

    // Retry at increasing intervals to catch elements that render late
    // (SSR hydration, lazy-loaded components, async data fetching)
    const retryDelays = [100, 500, 1500];
    for (const delay of retryDelays) {
      setTimeout(() => {
        if (persistedEdits.size > 0) applyPersistedEdits();
      }, delay);
    }

    // Final retry after page fully loads
    if (document.readyState !== 'complete') {
      window.addEventListener('load', () => {
        setTimeout(() => {
          if (persistedEdits.size > 0) applyPersistedEdits();
        }, 200);
      }, { once: true });
    }
  } catch { /* storage unavailable in some contexts */ }
}

// ── Text Target Resolution ──

function isSmallTextContainer(el: Element): boolean {
  const text = (el.textContent || '').trim();
  return text.length > 0 && text.length < 500 && el.children.length <= 3;
}

function findTextTarget(x: number, y: number, clicked: HTMLElement): HTMLElement | null {
  try {
    const range = document.caretRangeFromPoint(x, y);
    if (range && range.startContainer.nodeType === Node.TEXT_NODE) {
      const parent = range.startContainer.parentElement;
      if (parent && parent !== document.body && parent !== document.documentElement) {
        const tag = parent.tagName.toLowerCase();
        if (NON_EDITABLE_TAGS.has(tag)) { /* skip */ }
        else if (!STRUCTURAL_TAGS.has(tag)) return parent;
        else if (isSmallTextContainer(parent)) return parent;
      }
    }
  } catch { /* caretRangeFromPoint not supported */ }

  let el: HTMLElement | null = clicked;
  while (el && el !== document.body) {
    const tag = el.tagName.toLowerCase();
    if (TEXT_LEAF_TAGS.has(tag)) return el;
    if (STRUCTURAL_TAGS.has(tag) && isSmallTextContainer(el)) return el;
    if (STRUCTURAL_TAGS.has(tag)) { el = el.parentElement as HTMLElement | null; continue; }
    const text = (el.textContent || '').trim();
    if (text.length > 0 && text.length < 500 && el.children.length <= 3) return el;
    el = el.parentElement as HTMLElement | null;
  }
  return null;
}

// ── Selection Highlight ──

let focusTrap: HTMLElement | null = null;

function getFocusTrap(): HTMLElement {
  if (focusTrap && focusTrap.isConnected) return focusTrap;
  focusTrap = document.createElement('span');
  focusTrap.setAttribute('tabindex', '-1');
  focusTrap.setAttribute('aria-hidden', 'true');
  focusTrap.style.cssText = 'position:fixed;opacity:0;width:0;height:0;pointer-events:none;';
  document.documentElement.appendChild(focusTrap);
  return focusTrap;
}

function removeFocusTrap() {
  if (focusTrap) {
    focusTrap.remove();
    focusTrap = null;
  }
}

function clearSelection() {
  if (selectedElement) {
    selectedElement.style.outline = '';
    selectedElement = null;
  }
}

function selectElement(el: HTMLElement) {
  clearSelection();
  selectedElement = el;
  el.style.outline = '2px dashed #ef4444';
  getFocusTrap().focus({ preventScroll: true });
}

// ── Commit & Editing ──

function commitActiveEditable() {
  if (!activeEditable) return;
  const el = activeEditable;
  activeEditable = null;

  let info: ElementInfo;
  try {
    info = resolveElement(el);
  } catch {
    info = { tag: el.tagName.toLowerCase(), text: '', selector: el.tagName.toLowerCase() } as ElementInfo;
  }

  const original = (el.firstChild ? domSnapshot.get(el.firstChild) : null) || '';
  const modified = el.textContent || '';
  if (original !== modified) {
    domEdits.push({ selector: info.selector, original, modified });
    persistedEdits.set(info.selector, {
      original,
      modified,
      tag: el.tagName.toLowerCase(),
      ancestorPath: getAncestorPath(el),
      ancestorSignature: getAncestorSignature(el),
    });
    if (el.firstChild) domSnapshot.set(el.firstChild, modified);
    saveEditsToStorage();
  }
  el.contentEditable = 'false';
  el.style.outline = '';
}

// ── Event Handlers ──

function handleEditKeydown(e: KeyboardEvent) {
  // Text editing mode — let normal keys pass through
  if (activeEditable) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitActiveEditable();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      const el = activeEditable;
      activeEditable = null;
      if (el.firstChild && domSnapshot.has(el.firstChild)) {
        el.textContent = domSnapshot.get(el.firstChild)!;
      }
      el.contentEditable = 'false';
      el.style.outline = '';
    }
    return;
  }

  // Element selected (not editing text) — Delete/Backspace hides it
  if (selectedElement && (e.key === 'Delete' || e.key === 'Backspace')) {
    e.preventDefault();
    e.stopPropagation();
    const el = selectedElement;
    clearSelection();
    hideElement(el);

    let selector: string;
    try {
      selector = buildSelector(el);
    } catch {
      selector = el.tagName.toLowerCase();
    }
    persistedEdits.set(selector, {
      original: (el.textContent || '').trim(),
      modified: DELETED_SENTINEL,
      tag: el.tagName.toLowerCase(),
      ancestorPath: getAncestorPath(el),
      ancestorSignature: getAncestorSignature(el),
    });
    saveEditsToStorage();
    return;
  }

  // Escape clears selection
  if (selectedElement && e.key === 'Escape') {
    e.preventDefault();
    clearSelection();
  }
}

function startEditing(target: HTMLElement) {
  clearSelection();

  if (activeEditable && activeEditable !== target) {
    commitActiveEditable();
  }

  target.contentEditable = 'true';
  target.style.outline = '2px solid #6366f1';
  target.focus();

  try {
    const sel = window.getSelection();
    if (sel && target.firstChild) {
      const range = document.createRange();
      range.selectNodeContents(target);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
  } catch { /* selection API edge case */ }

  activeEditable = target;
}

function handleEditClick(e: MouseEvent) {
  if (!editModeActive) return;
  const clicked = e.target as HTMLElement;
  if (!clicked) return;

  const toolbar = getToolbarHost();
  if (toolbar && (toolbar.contains(clicked) || clicked === toolbar)) return;

  if (activeEditable && activeEditable.contains(clicked)) return;

  e.preventDefault();
  e.stopPropagation();

  if (!(clicked instanceof HTMLElement)) {
    clearSelection();
    return;
  }

  if (activeEditable) commitActiveEditable();

  const tag = clicked.tagName.toLowerCase();

  // Non-editable elements can only be selected for deletion
  if (NON_EDITABLE_TAGS.has(tag)) {
    clearSelection();
    selectElement(clicked);
    return;
  }

  const target = findTextTarget(e.clientX, e.clientY, clicked);

  // Second click on the already-selected element → enter text editing
  if (selectedElement && target && (selectedElement === target || selectedElement.contains(target) || target.contains(selectedElement))) {
    startEditing(target);
    return;
  }

  // First click → select the element (red outline). User can then press
  // Delete to hide it, or click again to start editing text.
  clearSelection();
  selectElement(target || clicked);
}

// ── Enter / Exit ──

export function enterEditMode() {
  editModeActive = true;
  domSnapshot = new WeakMap();

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    domSnapshot.set(walker.currentNode, walker.currentNode.textContent || '');
  }
  document.addEventListener('click', handleEditClick, true);
  document.addEventListener('keydown', handleEditKeydown, true);
}

export function exitEditMode() {
  editModeActive = false;

  if (activeEditable) commitActiveEditable();
  clearSelection();
  removeFocusTrap();

  domSnapshot = new WeakMap();
  document.removeEventListener('click', handleEditClick, true);
  document.removeEventListener('keydown', handleEditKeydown, true);
}
