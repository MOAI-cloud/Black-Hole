import type { HealthResponse, RenderMode, RenderResponse, RenderSettings } from './types';

async function readJson<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload && typeof payload.error === 'string'
      ? payload.error
      : `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return payload as T;
}

export async function getHealth(): Promise<HealthResponse> {
  const response = await fetch('/api/health');
  return readJson<HealthResponse>(response);
}

export async function requestRender(settings: RenderSettings, mode: RenderMode): Promise<RenderResponse> {
  const response = await fetch('/api/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...settings, mode })
  });
  return readJson<RenderResponse>(response);
}
