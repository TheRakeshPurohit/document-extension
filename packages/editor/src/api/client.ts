import type { Session, Step, UpdateStepsRequest } from '@docext/shared';

const BASE = '/api';

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

export function listSessions() {
  return request<{ sessions: (Session & { stepCount: number })[] }>('/sessions');
}

export function getSession(id: string) {
  return request<{ session: Session; steps: Step[] }>(`/sessions/${id}`);
}

export function updateSessionTitle(id: string, title: string) {
  return request<{ session: Session }>(`/sessions/${id}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
  });
}

export function updateSteps(id: string, data: UpdateStepsRequest) {
  return request<{ steps: Step[] }>(`/sessions/${id}/steps`, {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export function deleteSession(id: string) {
  return request<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' });
}

export function mergeSteps(sessionId: string, groupIds: string[]) {
  return request<{ steps: Step[] }>(`/sessions/${sessionId}/merge-steps`, {
    method: 'POST',
    body: JSON.stringify({ groupIds }),
  });
}

export function keepSeparate(sessionId: string, groupIds: string[]) {
  return request<{ steps: Step[] }>(`/sessions/${sessionId}/keep-separate`, {
    method: 'POST',
    body: JSON.stringify({ groupIds }),
  });
}

export function getExportUrl(id: string) {
  return `/api/sessions/${id}/export`;
}

export function getScreenshotUrl(screenshotId: string) {
  return `/api/screenshots/${screenshotId}`;
}
