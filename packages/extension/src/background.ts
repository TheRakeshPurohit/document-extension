import type { RecordedEvent, RecordingState, ExtensionMessage, ClickMeta } from '@docext/shared';
import { storeEvent, updateEventSkipHighlight, updateEventAfterScreenshots, storeScreenshot, getAllEvents, getScreenshotsByIds, clearAll, deleteByIds, hasPendingData } from './lib/idb-store.js';
import { createSession, uploadEvents, uploadScreenshotBlob, finalizeSession, deleteSession, uploadDomEdits, patchSkipHighlight } from './lib/api-client.js';

// ── Configuration ──

const SCREENSHOT_DELAY_MS = 200;
const NAVIGATE_LOAD_TIMEOUT_MS = 8000;
const CLICK_SCREENSHOT_DELAY_MS = 10;
const BATCH_INTERVAL_MS = 30_000;
const UPLOAD_CONCURRENCY = 4;
const NAVIGATE_RENDER_DELAY_MS = 700;

// ── Sequential Event Queue ──

const eventQueue: Array<{ event: RecordedEvent; resolve: () => void }> = [];
let processingEvent = false;
const DEBUG_CLICK_PIPELINE = false;

function dbg(...args: unknown[]) {
  if (!DEBUG_CLICK_PIPELINE) return;
  const t = Math.round(performance.now());
  console.log('[docext][bg]', t, ...args);
}

async function drainEventQueue() {
  if (processingEvent) return;
  processingEvent = true;
  while (eventQueue.length > 0) {
    const item = eventQueue.shift()!;
    let acked = false;
    const earlyAck = () => {
      if (!acked) {
        acked = true;
        item.resolve();
      }
    };
    try {
      await handleEventCaptured(item.event, earlyAck);
    } catch (err) {
      console.error('[docext] Event queue error:', err);
    }
    earlyAck(); // ensure resolve even if capture path forgot
  }
  processingEvent = false;
}

function enqueueEvent(event: RecordedEvent): Promise<void> {
  dbg('enqueueEvent', event.type, event.id);
  return new Promise<void>((resolve) => {
    eventQueue.push({ event, resolve });
    drainEventQueue();
  });
}

// ── Tab Load Waiting ──

function waitForTabLoad(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const timer = setTimeout(done, timeoutMs);
    const listener = (id: number, changeInfo: chrome.tabs.TabChangeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') done();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') done();
    }).catch(done);
  });
}

// ── State ──

function defaultState(): RecordingState {
  return {
    isRecording: false,
    sessionId: null,
    eventCount: 0,
    startedAt: null,
    editMode: false,
    theme: 'system',
  };
}

let state: RecordingState = defaultState();
let batchTimer: ReturnType<typeof setInterval> | null = null;
let activeTabId: number | null = null;
let activeWindowId: number | null = null;
let flushing = false;
let lastKnownUrl = '';
let stateLoaded = false;

// Per-event upload status — tracks which screenshot blobs have been confirmed
// uploaded so failed ones can be retried instead of silently dropped.
const failedUploadIds = new Set<string>();

function getState(): RecordingState {
  return { ...state };
}

// ── Persistent State (survives MV3 SW suspension) ──

const STATE_KEY = 'docext_recording_state_v1';

interface PersistedState {
  state: RecordingState;
  activeTabId: number | null;
  activeWindowId: number | null;
  lastKnownUrl: string;
}

async function persistState(): Promise<void> {
  try {
    const payload: PersistedState = {
      state,
      activeTabId,
      activeWindowId,
      lastKnownUrl,
    };
    await chrome.storage.session.set({ [STATE_KEY]: payload });
  } catch { /* storage may be unavailable */ }
}

async function clearPersistedState(): Promise<void> {
  try { await chrome.storage.session.remove(STATE_KEY); } catch {}
}

async function loadPersistedState(): Promise<void> {
  if (stateLoaded) return;
  stateLoaded = true;
  try {
    const result = await chrome.storage.session.get(STATE_KEY);
    const stored = result?.[STATE_KEY] as PersistedState | undefined;
    if (!stored || !stored.state || !stored.state.isRecording) return;

    // Confirm the recording tab still exists. If not, drop state quietly.
    if (stored.activeTabId != null) {
      try {
        await chrome.tabs.get(stored.activeTabId);
      } catch {
        await clearPersistedState();
        return;
      }
    }

    state = stored.state;
    activeTabId = stored.activeTabId;
    activeWindowId = stored.activeWindowId;
    lastKnownUrl = stored.lastKnownUrl;

    if (batchTimer) clearInterval(batchTimer);
    batchTimer = setInterval(flushToBackend, BATCH_INTERVAL_MS);
    broadcastState();
  } catch { /* ignore */ }
}

// Kick off rehydration eagerly so state is ready by the time messages arrive.
loadPersistedState();

function broadcastState() {
  const snapshot = getState();
  if (snapshot.isRecording) {
    chrome.action.setBadgeText({ text: String(snapshot.eventCount) });
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
  if (activeTabId) {
    chrome.tabs.sendMessage(activeTabId, {
      type: 'RECORDING_STATE',
      payload: snapshot,
    } as ExtensionMessage).catch(() => {});
  }
}

// ── Toolbar Visibility ──

async function hideToolbar() {
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: 'HIDE_TOOLBAR' } as ExtensionMessage);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: () => {
          const el = document.getElementById('docext-toolbar');
          if (el) el.style.display = 'none';
        },
      });
    } catch { /* tab closed or restricted */ }
  }
}

async function showToolbar() {
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, { type: 'SHOW_TOOLBAR' } as ExtensionMessage);
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        func: () => {
          const el = document.getElementById('docext-toolbar');
          if (el) el.style.display = '';
        },
      });
    } catch { /* tab closed or restricted */ }
  }
}

// ── Screenshot Capture ──

// Always capture the window the recording was started in, never just the
// "currently visible" tab. If the user switches tabs mid-recording we'd
// otherwise toggle theme on the recording tab and capture an unrelated one.
async function captureWindow(): Promise<string> {
  const opts: chrome.tabs.CaptureVisibleTabOptions = { format: 'jpeg', quality: 90 };
  if (activeWindowId != null) {
    return chrome.tabs.captureVisibleTab(activeWindowId, opts);
  }
  return chrome.tabs.captureVisibleTab(opts);
}

async function toWebp(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bmp, 0, 0);
  bmp.close();
  const out = await canvas.convertToBlob({ type: 'image/webp', quality: 0.85 });
  if (out.type !== 'image/webp') {
    console.warn('[docext] OffscreenCanvas.convertToBlob did not produce WebP, got:', out.type);
  }
  return out;
}

/** Cheap sample of blob bytes for identical-frame detection. */
async function sampleBlobHash(blob: Blob): Promise<string> {
  const slice = blob.slice(0, Math.min(blob.size, 4096));
  const buf = await slice.arrayBuffer();
  const view = new Uint8Array(buf);
  let h = blob.size;
  for (let i = 0; i < view.length; i += 17) {
    h = ((h * 31) + view[i]) >>> 0;
  }
  return `${blob.size}:${h}`;
}

// ── Page Observer Pausing ──

async function pausePageObservers() {
  if (!activeTabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: () => (window as unknown as { __docext_pauseObservers?: () => void }).__docext_pauseObservers?.(),
    });
  } catch {}
}

async function resumePageObservers() {
  if (!activeTabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: () => (window as unknown as { __docext_resumeObservers?: () => void }).__docext_resumeObservers?.(),
    });
  } catch {}
}

// ── Theme Toggle ──

async function pauseContentCapture() {
  if (!activeTabId) return;
  try { await chrome.tabs.sendMessage(activeTabId, { type: 'PAUSE_CAPTURE' }); } catch {}
}

async function resumeContentCapture() {
  if (!activeTabId) return;
  try { await chrome.tabs.sendMessage(activeTabId, { type: 'RESUME_CAPTURE' }); } catch {}
}

/**
 * After toggling the theme, wait for the browser to actually commit the paint.
 */
async function waitForThemePaint(targetTheme: 'light' | 'dark' | 'system'): Promise<void> {
  if (!activeTabId) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId: activeTabId },
      world: 'MAIN',
      func: () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
    });

    if (targetTheme === 'dark') {
      for (let attempt = 0; attempt < 3; attempt++) {
        const [result] = await chrome.scripting.executeScript({
          target: { tabId: activeTabId },
          world: 'MAIN',
          func: () => {
            const html = document.documentElement;
            return (
              html.classList.contains('dark') ||
              html.getAttribute('data-theme') === 'dark' ||
              html.getAttribute('data-color-scheme') === 'dark' ||
              (html.style.colorScheme === 'dark')
            );
          },
        });
        if (result?.result) break;
        await new Promise((r) => setTimeout(r, 16));
      }
    }
  } catch { /* tab may be restricted or closed — proceed anyway */ }
}

async function setEmulatedTheme(theme: 'light' | 'dark' | 'system') {
  if (!activeTabId) return;
  try {
    await chrome.tabs.sendMessage(activeTabId, {
      type: 'TOGGLE_THEME',
      payload: { theme },
    } as ExtensionMessage);
  } catch {
    // Fallback: content script might not be ready on a fresh navigation.
    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId },
        world: 'MAIN',
        args: [theme],
        func: (t: 'light' | 'dark' | 'system') => {
          const html = document.documentElement;
          if (t === 'dark') {
            html.classList.add('dark');
            html.setAttribute('data-theme', 'dark');
            html.setAttribute('data-color-scheme', 'dark');
            html.style.colorScheme = 'dark';
          } else if (t === 'light') {
            html.classList.remove('dark');
            html.setAttribute('data-theme', 'light');
            html.setAttribute('data-color-scheme', 'light');
            html.style.colorScheme = 'light';
          } else {
            html.classList.remove('dark');
            html.removeAttribute('data-theme');
            html.removeAttribute('data-color-scheme');
            html.style.colorScheme = '';
          }
        },
      });
    } catch {}
  }
  state.theme = theme;
}

async function storeFinalScreenshot(pngBlob: Blob): Promise<string> {
  const blob = await toWebp(pngBlob);
  const id = `ss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await storeScreenshot(id, blob);
  return id;
}

interface RawDualCapture {
  lightRaw: Blob | null;
  darkRaw: Blob | null;
  fallbackRaw: Blob | null;
  themeCapture: 'dual' | 'same';
}

async function captureRawDual(themeSettleMs = 300, darkSettleMs = 300): Promise<RawDualCapture> {
  const result: RawDualCapture = { lightRaw: null, darkRaw: null, fallbackRaw: null, themeCapture: 'dual' };
  const originalTheme = state.theme;
  const paintFrame = 20;

  try {
    await hideToolbar();
    await pauseContentCapture();

    if (activeTabId) {
      try {
        await pausePageObservers();

        const needsLightSwitch = originalTheme !== 'light';
        if (needsLightSwitch) {
          await setEmulatedTheme('light');
          await waitForThemePaint('light');
          // Fallback settle if paint verification alone is too fast for CSS transitions
          await new Promise((r) => setTimeout(r, Math.min(themeSettleMs, 120)));
        }

        const lightDataUrl = await captureWindow();
        result.lightRaw = await (await globalThis.fetch(lightDataUrl)).blob();

        // Start encoding light while dark theme settles
        const lightEncodePromise = toWebp(result.lightRaw).then(async (webp) => {
          const id = `ss-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
          await storeScreenshot(id, webp);
          return id;
        }).catch(() => null);

        await setEmulatedTheme('dark');
        await waitForThemePaint('dark');
        await new Promise((r) => setTimeout(r, Math.min(darkSettleMs, 200)));

        const darkDataUrl = await captureWindow();
        result.darkRaw = await (await globalThis.fetch(darkDataUrl)).blob();

        // Identical-frame detection
        try {
          const [lh, dh] = await Promise.all([
            sampleBlobHash(result.lightRaw),
            sampleBlobHash(result.darkRaw),
          ]);
          if (lh === dh) {
            result.themeCapture = 'same';
            result.darkRaw = null;
          }
        } catch { /* keep dual */ }

        await setEmulatedTheme(originalTheme === 'system' ? 'system' : originalTheme);
        await new Promise((r) => setTimeout(r, paintFrame));
        await resumePageObservers();
        await resumeContentCapture();
        await showToolbar();

        // Attach pre-encoded light id if available (consumed by processRawDual via pending)
        (result as RawDualCapture & { _pendingLightId?: Promise<string | null> })._pendingLightId = lightEncodePromise;
        return result;
      } catch (err) {
        console.warn('[docext] Dual-theme capture failed, falling back:', err);
        try { await setEmulatedTheme(originalTheme === 'system' ? 'system' : originalTheme); } catch {}
        await resumePageObservers();
        await resumeContentCapture();
      }
    }

    const dataUrl = await captureWindow();
    result.fallbackRaw = await (await globalThis.fetch(dataUrl)).blob();
    result.themeCapture = 'same';
    await resumeContentCapture();
    await showToolbar();
  } catch (err) {
    await resumeContentCapture();
    await showToolbar();
    console.warn('[docext] Raw screenshot capture failed:', err);
  }

  return result;
}

async function processRawDual(
  raw: RawDualCapture & { _pendingLightId?: Promise<string | null> },
): Promise<{ mainId: string | null; altId: string | null; themeCapture: 'dual' | 'same' }> {
  let mainId: string | null = null;
  let altId: string | null = null;

  try {
    if (raw.lightRaw && raw.darkRaw) {
      const pendingLight = raw._pendingLightId;
      const [lId, dId] = await Promise.all([
        pendingLight ? pendingLight.then((id) => id || storeFinalScreenshot(raw.lightRaw!)) : storeFinalScreenshot(raw.lightRaw),
        storeFinalScreenshot(raw.darkRaw),
      ]);
      mainId = lId;
      altId = dId;
    } else if (raw.lightRaw) {
      const pendingLight = raw._pendingLightId;
      mainId = pendingLight
        ? (await pendingLight) || await storeFinalScreenshot(raw.lightRaw)
        : await storeFinalScreenshot(raw.lightRaw);
    } else if (raw.fallbackRaw) {
      mainId = await storeFinalScreenshot(raw.fallbackRaw);
    }
  } catch (err) {
    console.warn('[docext] Screenshot processing failed:', err);
  }

  return { mainId, altId, themeCapture: raw.themeCapture };
}

async function captureDualScreenshots(
  themeSettleMs = 300,
): Promise<{ mainId: string | null; altId: string | null; themeCapture: 'dual' | 'same' }> {
  const raw = await captureRawDual(themeSettleMs);
  return processRawDual(raw);
}

function sortEventsForUpload(events: RecordedEvent[]): RecordedEvent[] {
  return [...events].sort((a, b) => {
    if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
    return a.id.localeCompare(b.id);
  });
}

function collectScreenshotIds(events: RecordedEvent[]): string[] {
  const ids: string[] = [];
  for (const ev of events) {
    if (ev.screenshotId) ids.push(ev.screenshotId);
    if (ev.altScreenshotId) ids.push(ev.altScreenshotId);
    if (ev.afterScreenshotId) ids.push(ev.afterScreenshotId);
    if (ev.afterAltScreenshotId) ids.push(ev.afterAltScreenshotId);
  }
  return ids;
}

function assignScreenshotField(
  event: RecordedEvent,
  field: 'screenshotId' | 'altScreenshotId' | 'afterScreenshotId' | 'afterAltScreenshotId',
  remoteId: string,
) {
  event[field] = remoteId;
}

// ── Event Processing ──

async function handleEventCaptured(event: RecordedEvent, earlyAck?: () => void) {
  dbg('handleEventCaptured:start', event.type, event.id);
  const isClick = event.type === 'click';
  const isNavigate = event.type === 'navigate';
  const isModal = event.type === 'modal';
  const isScreenshot = event.type === 'screenshot';
  const isEphemeralClick = isClick && !!(event.metadata as ClickMeta | undefined)?.inEphemeralUI;
  const shouldCaptureScreenshot = isClick || isNavigate || isModal || isScreenshot;
  if (event.url) lastKnownUrl = event.url;

  try {
    // Skip recapture when screenshots were already attached (cross-origin nav, manual)
    if (event.screenshotId) {
      await storeEvent(event);
      state.eventCount++;
      await persistState();
      broadcastState();
      earlyAck?.();
      return;
    }

    if (isNavigate && activeTabId) {
      await waitForTabLoad(activeTabId, NAVIGATE_LOAD_TIMEOUT_MS);
      await new Promise((r) => setTimeout(r, NAVIGATE_RENDER_DELAY_MS));
    } else {
      const delay = isClick ? CLICK_SCREENSHOT_DELAY_MS : SCREENSHOT_DELAY_MS;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    if (!shouldCaptureScreenshot) {
      await storeEvent(event);
      state.eventCount++;
      broadcastState();
      earlyAck?.();
      return;
    }

    const rawCapture = await captureRawDual(
      isNavigate ? 800 : 300,
      isEphemeralClick ? 300 : 200,
    );
    dbg('captureRawDual:done', event.type, event.id);

    // Release the click gate as soon as raw pixels exist — encode can finish after replay.
    earlyAck?.();

    try {
      const { mainId, altId, themeCapture } = await processRawDual(rawCapture);
      if (mainId) event.screenshotId = mainId;
      if (altId) event.altScreenshotId = altId;
      if (themeCapture === 'same') {
        (event.metadata as ClickMeta).themeCapture = 'same';
      }
      await storeEvent(event);
      dbg('storeEvent:done', event.type, event.id, { screenshotId: !!event.screenshotId, altScreenshotId: !!event.altScreenshotId });
      state.eventCount++;
      await persistState();
      broadcastState();
    } catch (err) {
      console.warn('[docext] Screenshot processing failed:', err);
      try { await storeEvent(event); state.eventCount++; await persistState(); broadcastState(); } catch {}
    }
  } catch (err) {
    console.warn('[docext] Event capture failed:', err);
    earlyAck?.();
    try { await storeEvent(event); state.eventCount++; await persistState(); broadcastState(); } catch {}
  }
}

async function handleCaptureAfter(
  eventId: string,
  afterOutcome?: unknown,
): Promise<{ ok: boolean }> {
  try {
    const raw = await captureRawDual(200, 200);
    const { mainId, altId, themeCapture } = await processRawDual(raw);
    if (themeCapture === 'same' && afterOutcome && typeof afterOutcome === 'object') {
      (afterOutcome as Record<string, unknown>).themeCapture = 'same';
    }
    await updateEventAfterScreenshots(eventId, mainId, altId, afterOutcome);
    return { ok: true };
  } catch (err) {
    console.warn('[docext] After-click capture failed:', err);
    return { ok: false };
  }
}

async function waitForPendingCaptures() {
  const maxWait = 30_000;
  const start = Date.now();
  while ((eventQueue.length > 0 || processingEvent) && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

// ── Recording Lifecycle ──

async function startRecording(tab: chrome.tabs.Tab) {
  if (state.isRecording) return;

  activeTabId = tab.id ?? null;
  activeWindowId = tab.windowId ?? null;

  try {
    const { session } = await createSession(tab.url || '', tab.title);
    state = { ...defaultState(), isRecording: true, sessionId: session.id, startedAt: Date.now() };
  } catch (err) {
    console.warn('[docext] Failed to create session on server, using local:', err);
    state = { ...defaultState(), isRecording: true, sessionId: `local-${Date.now()}`, startedAt: Date.now() };
  }

  lastKnownUrl = tab.url || '';
  // Only clear IDB if there is no leftover data from a prior failed force-flush
  const pending = await hasPendingData();
  if (!pending) {
    await clearAll();
  } else {
    console.warn('[docext] Preserving unflushed IDB data from prior session');
  }
  failedUploadIds.clear();
  await persistState();

  if (activeTabId) {
    try {
      // Inject observer-patch into MAIN world only while recording
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        files: ['observer-patch.js'],
        world: 'MAIN',
      });
    } catch { /* may already be present */ }

    try {
      await chrome.scripting.executeScript({
        target: { tabId: activeTabId, allFrames: true },
        files: ['content.js'],
      });
    } catch { /* content script may already be injected */ }

    await new Promise((r) => setTimeout(r, 50));

    try {
      await chrome.tabs.sendMessage(activeTabId, {
        type: 'START_RECORDING',
        payload: getState(),
      } as ExtensionMessage);
    } catch (err) {
      console.warn('[docext] Failed to send START_RECORDING:', err);
    }

    // Ensure the page starts in light mode for consistent screenshots
    await setEmulatedTheme('light');
    state.theme = 'light';
  }

  batchTimer = setInterval(flushToBackend, BATCH_INTERVAL_MS);
  await persistState();
  broadcastState();
}

async function captureFinalScreenshots(): Promise<void> {
  if (!activeTabId) return;
  try {
    let tab: chrome.tabs.Tab | undefined;
    try { tab = await chrome.tabs.get(activeTabId); } catch { return; }

    const { mainId: ssId, altId, themeCapture } = await captureDualScreenshots(500);

    const event: RecordedEvent = {
      id: `final-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'navigate',
      timestamp: Date.now(),
      url: tab?.url || '',
      pageTitle: tab?.title || '',
      metadata: { fromUrl: '', toUrl: tab?.url || '', newTitle: tab?.title || '', themeCapture },
      screenshotId: ssId ?? undefined,
      altScreenshotId: altId ?? undefined,
    };

    await storeEvent(event);
    state.eventCount++;
  } catch (err) {
    console.warn('[docext] Final screenshot capture failed:', err);
  }
}

async function stopRecording() {
  if (!state.isRecording) return;

  const sessionId = state.sessionId;

  // Stop batch timer first to prevent races during final flush
  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }

  // Tell the content script to stop immediately so the toolbar disappears
  // right when the user clicks Stop, before the async capture/flush work.
  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_RECORDING' } as ExtensionMessage);
    } catch { /* tab may have closed */ }
  }

  // Restore the page's theme to whatever the OS prefers, since we forced
  // 'light' at the start of the recording for screenshot consistency.
  try { await setEmulatedTheme('system'); } catch {}

  // Wait for any in-progress batch flush to finish
  await waitForFlush();

  await waitForPendingCaptures();
  await captureFinalScreenshots();

  await forceFlushToBackend();

  if (sessionId && !sessionId.startsWith('local-')) {
    try {
      await finalizeSession(sessionId);
    } catch (err) {
      console.warn('[docext] Failed to finalize session:', err);
    }
  }

  state = defaultState();
  activeTabId = null;
  activeWindowId = null;
  lastKnownUrl = '';
  failedUploadIds.clear();
  await clearPersistedState();
  broadcastState();

  return sessionId;
}

async function cancelRecording() {
  if (!state.isRecording) return;

  const sessionId = state.sessionId;

  if (batchTimer) {
    clearInterval(batchTimer);
    batchTimer = null;
  }

  if (activeTabId) {
    try {
      await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_RECORDING' } as ExtensionMessage);
    } catch { /* tab may have closed */ }
  }

  try { await setEmulatedTheme('system'); } catch {}

  await clearAll();
  eventQueue.length = 0;
  processingEvent = false;
  failedUploadIds.clear();

  if (sessionId && !sessionId.startsWith('local-')) {
    try {
      await deleteSession(sessionId);
    } catch (err) {
      console.warn('[docext] Failed to delete cancelled session:', err);
    }
  }

  state = defaultState();
  activeTabId = null;
  activeWindowId = null;
  lastKnownUrl = '';
  await clearPersistedState();
  broadcastState();
}

// ── Backend Sync ──

async function uploadWithRetry(sessionId: string, blob: Blob, retries = 2): Promise<string> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await uploadScreenshotBlob(sessionId, blob);
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
  throw new Error('Upload exhausted retries');
}

/**
 * Upload screenshots referenced by `events`. Returns the set of local screenshot
 * ids that failed to upload — the caller uses this to decide whether IDB rows
 * for those screenshots should be retained for retry.
 */
async function uploadScreenshotsParallel(
  sessionId: string,
  events: RecordedEvent[],
  ssMap: Map<string, Blob>,
): Promise<{ failedLocalIds: Set<string> }> {
  type SsField = 'screenshotId' | 'altScreenshotId' | 'afterScreenshotId' | 'afterAltScreenshotId';
  const tasks: Array<{ event: RecordedEvent; field: SsField; localId: string }> = [];

  for (const event of events) {
    if (event.screenshotId && ssMap.has(event.screenshotId)) {
      tasks.push({ event, field: 'screenshotId', localId: event.screenshotId });
    }
    if (event.altScreenshotId && ssMap.has(event.altScreenshotId)) {
      tasks.push({ event, field: 'altScreenshotId', localId: event.altScreenshotId });
    }
    if (event.afterScreenshotId && ssMap.has(event.afterScreenshotId)) {
      tasks.push({ event, field: 'afterScreenshotId', localId: event.afterScreenshotId });
    }
    if (event.afterAltScreenshotId && ssMap.has(event.afterAltScreenshotId)) {
      tasks.push({ event, field: 'afterAltScreenshotId', localId: event.afterAltScreenshotId });
    }
  }

  const idMap = new Map<string, string>();
  const failedLocalIds = new Set<string>();
  const seen = new Set<string>();
  const uniqueTasks = tasks.filter((t) => {
    if (seen.has(t.localId)) return false;
    seen.add(t.localId);
    return true;
  });

  let i = 0;
  while (i < uniqueTasks.length) {
    const batch = uniqueTasks.slice(i, i + UPLOAD_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(async (t) => {
        const remoteId = await uploadWithRetry(sessionId, ssMap.get(t.localId)!);
        idMap.set(t.localId, remoteId);
        return t.localId;
      })
    );
    for (let r = 0; r < results.length; r++) {
      const result = results[r];
      if (result.status === 'rejected') {
        const localId = batch[r].localId;
        failedLocalIds.add(localId);
        console.warn('[docext] Screenshot upload failed:', result.reason);
      }
    }
    i += UPLOAD_CONCURRENCY;
  }

  for (const t of tasks) {
    const remoteId = idMap.get(t.localId);
    if (remoteId) {
      assignScreenshotField(t.event, t.field, remoteId);
    }
  }

  return { failedLocalIds };
}

async function syncBatch(opts?: { retries?: number }): Promise<void> {
  if (!state.sessionId || state.sessionId.startsWith('local-')) return;
  if (flushing) return;
  flushing = true;

  const maxAttempts = opts?.retries ?? 1;
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const events = sortEventsForUpload(await getAllEvents());
      if (events.length === 0) return;

      const ssIds = collectScreenshotIds(events);
      const screenshots = await getScreenshotsByIds(ssIds);
      const ssMap = new Map(screenshots.map((s) => [s.id, s.blob]));

      const { failedLocalIds } = await uploadScreenshotsParallel(state.sessionId!, events, ssMap);

      const stuckEvents = new Set<string>();
      for (const ev of events) {
        if (ev.screenshotId && failedLocalIds.has(ev.screenshotId)) stuckEvents.add(ev.id);
        if (ev.altScreenshotId && failedLocalIds.has(ev.altScreenshotId)) stuckEvents.add(ev.id);
        if (ev.afterScreenshotId && failedLocalIds.has(ev.afterScreenshotId)) stuckEvents.add(ev.id);
        if (ev.afterAltScreenshotId && failedLocalIds.has(ev.afterAltScreenshotId)) stuckEvents.add(ev.id);
      }
      const uploadable = events.filter((e) => !stuckEvents.has(e.id));

      if (uploadable.length > 0) {
        await uploadEvents(state.sessionId!, uploadable);
      }

      const stuckLocalSsIds = new Set<string>();
      for (const ev of events) {
        if (stuckEvents.has(ev.id)) {
          if (ev.screenshotId) stuckLocalSsIds.add(ev.screenshotId);
          if (ev.altScreenshotId) stuckLocalSsIds.add(ev.altScreenshotId);
          if (ev.afterScreenshotId) stuckLocalSsIds.add(ev.afterScreenshotId);
          if (ev.afterAltScreenshotId) stuckLocalSsIds.add(ev.afterAltScreenshotId);
        }
      }
      // After upload, events hold remote ids — delete the local blobs we successfully uploaded
      const localIdsUploaded = [...ssMap.keys()].filter(
        (id) => !failedLocalIds.has(id) && !stuckLocalSsIds.has(id),
      );
      await deleteByIds(uploadable.map((e) => e.id), localIdsUploaded);

      if (failedLocalIds.size === 0) return;
      if (attempt < maxAttempts - 1) {
        await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
      } else {
        console.warn('[docext] Some screenshots failed to upload, will retry next flush:', failedLocalIds.size);
      }
    }
  } catch (err) {
    console.warn('[docext] Batch flush failed (will retry):', err);
  } finally {
    flushing = false;
  }
}

async function flushToBackend() {
  await syncBatch({ retries: 1 });
}

async function waitForFlush() {
  const maxWait = 15_000;
  const start = Date.now();
  while (flushing && Date.now() - start < maxWait) {
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function forceFlushToBackend() {
  await waitForFlush();
  if (!state.sessionId || state.sessionId.startsWith('local-')) return;
  await syncBatch({ retries: 3 });
}

// ── Message Listener ──

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, _sender, sendResponse) => {
    const handle = async () => {
      await loadPersistedState();
      switch (message.type) {
        case 'START_RECORDING': {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tab) await startRecording(tab);
          return getState();
        }
        case 'STOP_RECORDING': {
          const sessionId = await stopRecording();
          if (sessionId && !sessionId.startsWith('local-')) {
            chrome.tabs.create({ url: `http://localhost:3001/session/${sessionId}` });
          }
          return { ...getState(), finishedSessionId: sessionId };
        }
        case 'CANCEL_RECORDING': {
          await cancelRecording();
          return getState();
        }
        case 'GET_STATE': {
          return getState();
        }
        case 'EVENT_CAPTURED': {
          const event = message.payload as RecordedEvent;
          await enqueueEvent(event);
          return { ok: true };
        }
        case 'SET_SKIP_HIGHLIGHT': {
          const { eventId } = message.payload as { eventId: string };
          await updateEventSkipHighlight(eventId);
          // Also flush to server if the event may already have been uploaded
          if (state.sessionId && !state.sessionId.startsWith('local-')) {
            try {
              await patchSkipHighlight(state.sessionId, eventId);
            } catch (err) {
              console.warn('[docext] Server skip-highlight failed (will rely on IDB):', err);
            }
          }
          return { ok: true };
        }
        case 'ENTER_EDIT_MODE': {
          state.editMode = true;
          if (activeTabId) {
            await chrome.tabs.sendMessage(activeTabId, { type: 'ENTER_EDIT_MODE' } as ExtensionMessage);
          }
          await persistState();
          broadcastState();
          return getState();
        }
        case 'EXIT_EDIT_MODE': {
          state.editMode = false;
          if (activeTabId) {
            await chrome.tabs.sendMessage(activeTabId, { type: 'EXIT_EDIT_MODE' } as ExtensionMessage);
          }
          await persistState();
          broadcastState();
          return getState();
        }
        case 'TOGGLE_THEME': {
          const { theme } = message.payload as { theme: 'light' | 'dark' | 'system' };
          await setEmulatedTheme(theme);
          await persistState();
          return getState();
        }
        case 'CAPTURE_SCREENSHOT': {
          if (!state.isRecording) return { error: 'Not recording' };
          const { mainId, altId, themeCapture } = await captureDualScreenshots();
          const event: RecordedEvent = {
            id: `manual-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: 'screenshot',
            timestamp: Date.now(),
            url: lastKnownUrl,
            pageTitle: '',
            metadata: {
              label: 'Manual screenshot',
              skipHighlight: true,
              themeCapture,
            },
            screenshotId: mainId ?? undefined,
            altScreenshotId: altId ?? undefined,
          };
          try {
            const tab = activeTabId ? await chrome.tabs.get(activeTabId) : null;
            if (tab) {
              event.url = tab.url || event.url;
              event.pageTitle = tab.title || '';
            }
          } catch { /* ignore */ }
          await storeEvent(event);
          state.eventCount++;
          await persistState();
          broadcastState();
          return { ok: true, mainId, altId, eventId: event.id };
        }
        case 'CAPTURE_AFTER': {
          if (!state.isRecording) return { error: 'Not recording' };
          const payload = message.payload as { eventId: string; afterOutcome?: unknown };
          return handleCaptureAfter(payload.eventId, payload.afterOutcome);
        }
        case 'FLUSH_DOM_EDITS': {
          const payload = message.payload as {
            edits: Array<{ selector: string; original: string; modified: string; kind?: string }>;
            url?: string;
          };
          if (
            state.sessionId &&
            !state.sessionId.startsWith('local-') &&
            payload?.edits?.length
          ) {
            try {
              await uploadDomEdits(
                state.sessionId,
                payload.edits.map((e) => ({ ...e, url: payload.url })),
              );
            } catch (err) {
              console.warn('[docext] Failed to upload dom edits:', err);
            }
          }
          return { ok: true };
        }
        default:
          return { error: 'Unknown message type' };
      }
    };

    handle()
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[docext] Background handler error:', err);
        sendResponse({ error: String(err) });
      });

    return true;
  }
);

// ── Content Script Re-injection ──

function injectAndStart(tabId: number, allFrames: boolean, frameIds?: number[]) {
  const target = frameIds ? { tabId, frameIds } : { tabId, allFrames };
  chrome.scripting.executeScript({
    target,
    files: ['observer-patch.js'],
    world: 'MAIN',
  }).catch(() => {}).then(() =>
    chrome.scripting.executeScript({
      target,
      files: ['content.js'],
    })
  ).then(() => {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, {
        type: 'START_RECORDING',
        payload: getState(),
      } as ExtensionMessage).catch(() => {});
      // Re-force light theme after navigation so dual capture stays dual
      setEmulatedTheme('light').catch(() => {});
      state.theme = 'light';
      // Restore edit mode if it was active
      if (state.editMode) {
        chrome.tabs.sendMessage(tabId, { type: 'ENTER_EDIT_MODE' } as ExtensionMessage).catch(() => {});
      }
    }, 50);
  }).catch(() => {});
}

function getOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return ''; }
}

chrome.webNavigation?.onDOMContentLoaded?.addListener((details) => {
  if (!state.isRecording || details.tabId !== activeTabId) return;
  if (details.frameId === 0) {
    injectAndStart(details.tabId, true);
  } else {
    injectAndStart(details.tabId, false, [details.frameId]);
  }
});

let crossOriginCaptureInProgress = false;
let lastCrossOriginCaptureAt = 0;
const CROSS_ORIGIN_COOLDOWN_MS = 5000;

chrome.webNavigation?.onCompleted?.addListener(async (details) => {
  if (!state.isRecording || details.tabId !== activeTabId || details.frameId !== 0) return;

  const newUrl = details.url;
  const oldOrigin = getOrigin(lastKnownUrl);
  const newOrigin = getOrigin(newUrl);
  const prevUrl = lastKnownUrl;
  lastKnownUrl = newUrl;

  if (!oldOrigin || !newOrigin || oldOrigin === newOrigin) return;
  if (crossOriginCaptureInProgress) return;
  if (Date.now() - lastCrossOriginCaptureAt < CROSS_ORIGIN_COOLDOWN_MS) return;

  crossOriginCaptureInProgress = true;
  lastCrossOriginCaptureAt = Date.now();

  try {
    // Ensure content script is recording on the new page
    try {
      await chrome.tabs.sendMessage(details.tabId, {
        type: 'START_RECORDING',
        payload: getState(),
      } as ExtensionMessage);
    } catch {}

    await new Promise((r) => setTimeout(r, 800));
    const tab = await chrome.tabs.get(details.tabId);

    const { mainId, altId, themeCapture } = await captureDualScreenshots(500);

    const event: RecordedEvent = {
      id: `nav-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      type: 'navigate',
      timestamp: Date.now(),
      url: newUrl,
      pageTitle: tab?.title || '',
      metadata: { fromUrl: prevUrl, toUrl: newUrl, newTitle: tab?.title || '', themeCapture },
      screenshotId: mainId ?? undefined,
      altScreenshotId: altId ?? undefined,
    };

    // Already has screenshots — store directly without recapture
    await storeEvent(event);
    state.eventCount++;
    await persistState();
    broadcastState();
  } catch (err) {
    console.warn('[docext] Cross-origin navigate capture failed:', err);
  } finally {
    crossOriginCaptureInProgress = false;
  }
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (state.isRecording && tabId === activeTabId && changeInfo.status === 'complete') {
    injectAndStart(tabId, true);
  }
});
