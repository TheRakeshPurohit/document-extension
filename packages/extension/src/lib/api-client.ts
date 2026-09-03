import type { RecordedEvent } from '@docext/shared';

const BASE_URL = 'http://localhost:3001/api';

export async function createSession(startUrl: string, title?: string) {
  const res = await fetch(`${BASE_URL}/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startUrl, title }),
  });
  if (!res.ok) throw new Error(`Create session failed: ${res.status}`);
  return res.json();
}

export async function uploadEvents(sessionId: string, events: RecordedEvent[]) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ events }),
  });
  if (!res.ok) throw new Error(`Upload events failed: ${res.status}`);
  return res.json();
}

export async function uploadScreenshotBlob(
  sessionId: string,
  blob: Blob
): Promise<string> {
  const formData = new FormData();
  // Pick a filename that matches the actual blob type so the server can
  // distinguish a WebP fallback from a PNG fallback in logs. The server
  // re-encodes either way, so this is purely informational.
  const ext = blob.type === 'image/png' ? 'png' : 'webp';
  formData.append('screenshot', blob, `screenshot.${ext}`);

  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/screenshots`, {
    method: 'POST',
    body: formData,
  });
  if (!res.ok) throw new Error(`Upload screenshot failed: ${res.status}`);
  const data = await res.json();
  return data.screenshotId;
}

export async function finalizeSession(sessionId: string) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/finalize`, {
    method: 'POST',
  });
  if (!res.ok) throw new Error(`Finalize session failed: ${res.status}`);
  return res.json();
}

export async function deleteSession(sessionId: string) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`Delete session failed: ${res.status}`);
  return res.json();
}

export async function uploadDomEdits(
  sessionId: string,
  edits: Array<{ selector: string; original: string; modified: string; kind?: string; url?: string }>,
) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/edits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ edits }),
  });
  if (!res.ok) throw new Error(`Upload edits failed: ${res.status}`);
  return res.json();
}

export async function patchSkipHighlight(sessionId: string, eventId: string) {
  const res = await fetch(`${BASE_URL}/sessions/${sessionId}/events/${eventId}/skip-highlight`, {
    method: 'PATCH',
  });
  if (!res.ok) throw new Error(`Skip highlight failed: ${res.status}`);
  return res.json();
}
