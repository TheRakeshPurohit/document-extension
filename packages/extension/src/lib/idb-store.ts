import type { RecordedEvent } from '@docext/shared';

const DB_NAME = 'docext';
const DB_VERSION = 1;
const EVENTS_STORE = 'events';
const SCREENSHOTS_STORE = 'screenshots';

let cachedDb: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (cachedDb) return Promise.resolve(cachedDb);
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      cachedDb = request.result;
      cachedDb.onclose = () => { cachedDb = null; };
      resolve(cachedDb);
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(EVENTS_STORE)) {
        db.createObjectStore(EVENTS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SCREENSHOTS_STORE)) {
        db.createObjectStore(SCREENSHOTS_STORE, { keyPath: 'id' });
      }
    };
  });
}

export async function storeEvent(event: RecordedEvent): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS_STORE, 'readwrite');
    tx.objectStore(EVENTS_STORE).put(event);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getEvent(eventId: string): Promise<RecordedEvent | undefined> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS_STORE, 'readonly');
    const req = tx.objectStore(EVENTS_STORE).get(eventId);
    req.onsuccess = () => resolve(req.result as RecordedEvent | undefined);
    req.onerror = () => reject(req.error);
  });
}

export async function updateEventSkipHighlight(eventId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS_STORE, 'readwrite');
    const store = tx.objectStore(EVENTS_STORE);
    const req = store.get(eventId);
    req.onsuccess = () => {
      const event = req.result as RecordedEvent | undefined;
      if (event) {
        (event.metadata as unknown as Record<string, unknown>).skipHighlight = true;
        store.put(event);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateEventAfterScreenshots(
  eventId: string,
  afterScreenshotId: string | null,
  afterAltScreenshotId: string | null,
  afterOutcome?: unknown,
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS_STORE, 'readwrite');
    const store = tx.objectStore(EVENTS_STORE);
    const req = store.get(eventId);
    req.onsuccess = () => {
      const event = req.result as RecordedEvent | undefined;
      if (event) {
        if (afterScreenshotId) event.afterScreenshotId = afterScreenshotId;
        if (afterAltScreenshotId) event.afterAltScreenshotId = afterAltScreenshotId;
        if (afterOutcome) {
          (event.metadata as unknown as Record<string, unknown>).afterOutcome = afterOutcome;
        }
        store.put(event);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function storeScreenshot(id: string, blob: Blob): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCREENSHOTS_STORE, 'readwrite');
    tx.objectStore(SCREENSHOTS_STORE).put({ id, blob });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAllEvents(): Promise<RecordedEvent[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EVENTS_STORE, 'readonly');
    const request = tx.objectStore(EVENTS_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function getAllScreenshots(): Promise<Array<{ id: string; blob: Blob }>> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCREENSHOTS_STORE, 'readonly');
    const request = tx.objectStore(SCREENSHOTS_STORE).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/** Fetch only the screenshot blobs referenced by the given ids. */
export async function getScreenshotsByIds(
  ids: string[],
): Promise<Array<{ id: string; blob: Blob }>> {
  if (ids.length === 0) return [];
  const unique = [...new Set(ids)];
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SCREENSHOTS_STORE, 'readonly');
    const store = tx.objectStore(SCREENSHOTS_STORE);
    const results: Array<{ id: string; blob: Blob }> = [];
    let pending = unique.length;
    let failed = false;
    for (const id of unique) {
      const req = store.get(id);
      req.onsuccess = () => {
        if (req.result) results.push(req.result as { id: string; blob: Blob });
        pending--;
        if (pending === 0 && !failed) resolve(results);
      };
      req.onerror = () => {
        if (!failed) {
          failed = true;
          reject(req.error);
        }
      };
    }
  });
}

export async function clearAll(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([EVENTS_STORE, SCREENSHOTS_STORE], 'readwrite');
    tx.objectStore(EVENTS_STORE).clear();
    tx.objectStore(SCREENSHOTS_STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Selective clear used when a batch upload partially succeeded:
 * - Removes events whose ids are listed in `eventIds`.
 * - Removes screenshots whose ids are listed in `screenshotIds`.
 * Anything left behind is retried on the next flush.
 */
export async function deleteByIds(
  eventIds: string[],
  screenshotIds: string[],
): Promise<void> {
  if (eventIds.length === 0 && screenshotIds.length === 0) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([EVENTS_STORE, SCREENSHOTS_STORE], 'readwrite');
    const evStore = tx.objectStore(EVENTS_STORE);
    for (const id of eventIds) evStore.delete(id);
    const ssStore = tx.objectStore(SCREENSHOTS_STORE);
    for (const id of screenshotIds) ssStore.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function hasPendingData(): Promise<boolean> {
  const events = await getAllEvents();
  return events.length > 0;
}
