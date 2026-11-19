import type { HealthResponse, RenderMode, RenderResponse, RenderSettings } from './types';

async function checkResponse(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const error = body?.error || `Request failed (${response.status})`;
    const detail = typeof body?.stderr === 'string' ? body.stderr.trim() : '';
    throw new Error(detail ? error + '\n' + detail : error);
  }
  return response;
}

export async function getHealth(): Promise<HealthResponse> {
  return (await checkResponse(await fetch('/api/health'))).json();
}

export type Precision = 'double' | 'single';

function postFrame(settings: RenderSettings, mode: RenderMode, observerTime: number, signal: AbortSignal, accept: string,
                   precision?: Precision) {
  // The orbit camera uses vertical FOV. The native camera accepts horizontal FOV.
  const horizontal = 2 * Math.atan(Math.tan(settings.fov * Math.PI / 360) * settings.width / settings.height);
  return fetch('/api/render', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept },
    body: JSON.stringify({ ...settings, fov: horizontal * 180 / Math.PI, observerTime, mode, precision }),
    signal
  }).then(checkResponse);
}

export async function requestRender(settings: RenderSettings, mode: RenderMode, time: number, signal: AbortSignal,
                                    precision: Precision = 'double'): Promise<RenderResponse> {
  return (await postFrame(settings, mode, time, signal, 'application/json', precision)).json();
}

export async function refineView(settings: RenderSettings, mode: RenderMode, time: number, signal: AbortSignal): Promise<Blob> {
  return (await postFrame(settings, mode, time, signal, 'image/png')).blob();
}
