export interface RenderSettings {
  width: number;
  height: number;
  spp: number;
  spin: number;
  camR: number;
  camTheta: number;
  camPhi: number;
  fov: number;
  diskTemp: number;
  diskBright: number;
  diskOuter: number;
  diskNoise: number;
  diskThick: number;
  diskFlare: number;
  diskAbsorb: number;
  skyBright: number;
  exposure: number;
  thin: boolean;
  noDoppler: boolean;
}

export type RenderMode = 'preview' | 'final';

export interface HealthResponse {
  ok: boolean;
  binaryExists: boolean;
  binaryPath: string;
  starmap: { name: string } | null;
  renderDir: string;
}

export interface RenderResponse {
  ok: boolean;
  render: {
    id: string;
    url: string;
    width: number;
    height: number;
    spp: number;
    mode: RenderMode;
    elapsedMs: number;
    stdout: string;
    stderr: string;
  };
  settings: RenderSettings & { mode: RenderMode };
}

export const DEFAULT_SETTINGS: RenderSettings = {
  width: 1280,
  height: 720,
  spp: 8,
  spin: 0.9,
  camR: 60,
  camTheta: 84,
  camPhi: 0,
  fov: 45,
  diskTemp: 9000,
  diskBright: 12,
  diskOuter: 22,
  diskNoise: 0.45,
  diskThick: 0.5,
  diskFlare: 0.05,
  diskAbsorb: 0.4,
  skyBright: 1.2,
  exposure: 1,
  thin: false,
  noDoppler: false
};
