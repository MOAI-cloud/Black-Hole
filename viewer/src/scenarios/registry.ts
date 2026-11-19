import type { RenderSettings } from '../types';
import type { ScenarioFactory } from './types';

export interface ScenarioEntry {
  id: string;
  title: string;
  summary: string;
  /** Viewer settings applied while the scenario is open. */
  settings?: Partial<RenderSettings>;
  create: ScenarioFactory;
}

// Scenario modules load on demand so the main viewer stays small.
export const SCENARIOS: ScenarioEntry[] = [
  {
    id: 'infall', title: 'Falling into a black hole',
    summary: 'A glowing body on a Kerr geodesic: redshift, frozen image, time dilation and tides.',
    create: async context => (await import('./infall')).createInfallScenario(context)
  },
  {
    id: 'merger', title: 'Binary black hole merger',
    summary: 'Effective-one-body inspiral, NR-calibrated merger and Kerr ringdown, with live gravitational waves.',
    // A vacuum binary emits no light: the lensed sky is the whole picture.
    settings: { skyBright: 0.5, cinematic: true },
    create: async context => (await import('./merger')).createMergerScenario(context)
  }
];
