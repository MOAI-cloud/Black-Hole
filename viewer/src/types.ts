import type { SkyId } from './skies';

export type DiskModel = 'nt' | 'legacy';
/** Thermal optical disk, or the 230 GHz synchrotron image of a hot flow (EHT). */
export type EmissionModel = 'thermal' | 'synchrotron';

export interface RenderSettings {
  width: number;
  height: number;
  spp: number;
  shutter: number;
  spin: number;
  camR: number;
  camTheta: number;
  camPhi: number;
  roll: number;
  fov: number;
  diskTemp: number;
  diskBright: number;
  diskOuter: number;
  diskNoise: number;
  diskThick: number;
  diskFlare: number;
  diskAbsorb: number;
  background: SkyId;
  skyBright: number;
  exposure: number;
  cinematic: boolean;
  thin: boolean;
  photosphere: boolean;
  noDoppler: boolean;
  noRedshift: boolean;
  staticDiskPattern: boolean;
  diskModel: DiskModel;
  /** Catalog object id, or 'custom'. */
  blackHole: string;
  /** Mass in solar masses: sets physical lengths, times and the synchrotron scale. */
  massSolar: number;
  diskEnabled: boolean;
  emission: EmissionModel;
  observeGHz: number;
  /** Electron density (cm⁻³) and temperature (K) of the hot flow at r = 10 M. */
  riafDensity: number;
  riafTemperature: number;
  riafHeight: number;
  riafBeta: number;
  /** Radial power-law indices of electron density and temperature, n ∝ r^-x. */
  riafDensitySlope: number;
  riafTemperatureSlope: number;
  hotspot: boolean;
  hotspotRadius: number;
  jet: boolean;
  /** Companion star on the celestial sphere: direction (deg), angular radius (deg), T_eff (K). */
  companion: boolean;
  companionTheta: number;
  companionPhi: number;
  companionRadius: number;
  companionTemp: number;
  /** Disk colour correction f_col: the disk is a blackbody at f T_eff diluted by f⁻⁴. */
  diskColorCorrection: number;
  /** Telescope beam FWHM in μas for the millimetre image (0 = ideal resolution). */
  telescopeBeam: number;
  /** Logarithmic display range of the millimetre image in decades (0 = linear). */
  displayDecades: number;
  /** Angular size of one gravitational radius seen from Earth, μas (0 = unknown). */
  angularScale: number;
}

export type RenderMode = 'preview' | 'final';

export interface HealthResponse {
  ok: boolean;
  binaryExists: boolean;
  rendererAvailable: boolean;
  legacy?: boolean;
  rendererMessage: string;
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
  width: 3840,
  height: 2160,
  spp: 12,
  shutter: 0,
  spin: 0.5,
  camR: 62,
  camTheta: 83.2,
  camPhi: 115,
  roll: -2,
  fov: 28,
  diskTemp: 5600,
  diskBright: 4,
  diskOuter: 26,
  diskNoise: 0.5,
  diskThick: 0.35,
  diskFlare: 0.035,
  diskAbsorb: 0.4,
  background: 'milky-way',
  skyBright: 0.12,
  exposure: 1,
  cinematic: true,
  thin: true,
  photosphere: true,
  noDoppler: false,
  noRedshift: false,
  staticDiskPattern: false,
  diskModel: 'nt',
  blackHole: 'custom',
  massSolar: 1e8,
  diskEnabled: true,
  emission: 'thermal',
  observeGHz: 230,
  riafDensity: 1e6,
  riafTemperature: 4e10,
  riafHeight: 0.5,
  riafBeta: 10,
  riafDensitySlope: 1.1,
  riafTemperatureSlope: 0.84,
  hotspot: false,
  hotspotRadius: 9,
  jet: false,
  companion: false,
  companionTheta: 90,
  companionPhi: 0,
  companionRadius: 1,
  companionTemp: 5800,
  diskColorCorrection: 1,
  telescopeBeam: 0,
  displayDecades: 0,
  angularScale: 0
};
