import './merger.css';
import type { Scenario, ScenarioContext, ScenarioFactory } from '../types';
import { GWPlot } from './gwPlot';
import { MergerProgram } from './MergerProgram';
import { solveMerger, type MergerSolution } from './merger';
import { MergerPanel, PRESETS, inputFromSettings, superscriptExponent, type MergerSettings } from './panel';
import { MSUN_METRES } from './units';
import { polarizations, sampleIndex, valueAt, type Polarizations } from './waveform';

const VISIBLE_SEPARATION = 12;
const MAX_VISIBLE_SPAN = 2600;

/** Retarded time at a static observer: u = t - r*, r* = r + 2 ln(r/2 - 1) (M = 1). */
function tortoise(r: number): number {
  return r + 2 * Math.log(Math.max(1e-6, 0.5 * r - 1));
}

class MergerScenario implements Scenario {
  readonly id = 'merger';
  readonly title = 'Binary black hole merger';
  readonly program: MergerProgram;
  readonly camera = { camR: 46, camTheta: 62, camPhi: 32, fov: 42, roll: 0 };
  readonly playbackRate = 40;
  private readonly settings: MergerSettings = { ...PRESETS[0].settings, waves: true, trails: true, gain: 4 };
  private solution: MergerSolution | null = null;
  private strain: Polarizations | null = null;
  /** Source-time span shown in the 3D view and the strain plot (M). */
  private sourceWindow: [number, number] = [0, 1];
  /** Observer-time span: the source window delayed to a reference camera radius. */
  private eventWindow: [number, number] = [0, 1];
  private readonly plot: GWPlot;
  private readonly panel: MergerPanel;
  private readonly readouts = new Map<string, HTMLElement>();
  private solveTimer = 0;
  private lastReadout = 0;
  private disposed = false;

  constructor(private readonly context: ScenarioContext) {
    this.program = new MergerProgram(context.packedRadiance);
    this.program.setOverlays(this.settings);
    this.plot = new GWPlot(context.plots, source => this.seek(source));
    this.panel = new MergerPanel(context.controls, this.settings, physics => this.changed(physics), {
      restart: () => { this.context.setTime(0); this.context.requestRedraw(); },
      merger: () => this.seek(-90)
    });
    this.panel.selectPreset(PRESETS[0].id);
    this.buildReadouts();
    this.solve(true);
  }

  private buildReadouts(): void {
    const list = document.createElement('dl');
    list.className = 'merger-readouts';
    for (const [key, label] of [['time', 'Time to merger'], ['frequency', 'GW frequency'], ['separation', 'Separation'],
      ['speed', 'Relative speed'], ['strain', 'Strain at Earth']]) {
      const row = document.createElement('div');
      const dt = document.createElement('dt');
      const dd = document.createElement('dd');
      dt.textContent = label;
      row.append(dt, dd);
      list.append(row);
      this.readouts.set(key, dd);
    }
    this.context.readouts.append(list);
  }

  private changed(physics: boolean): void {
    this.program.setOverlays(this.settings);
    if (physics) {
      window.clearTimeout(this.solveTimer);
      this.panel.setBusy(true);
      this.solveTimer = window.setTimeout(() => this.solve(true), 140);
    } else if (this.solution) {
      this.updateStrain();
    }
    this.context.requestRedraw();
  }

  private solve(restart: boolean): void {
    if (this.disposed) return;
    const solution = solveMerger({ ...inputFromSettings(this.settings), fLow: 20, minSeparation: VISIBLE_SEPARATION });
    this.solution = solution;
    // Begin the 3D view where the separation is VISIBLE_SEPARATION M.
    let start = solution.start;
    for (let i = 0; i < solution.t.length; i++) {
      if (solution.r[i] <= VISIBLE_SEPARATION) { start = solution.t[i]; break; }
    }
    start = Math.max(start, -MAX_VISIBLE_SPAN, solution.start);
    this.sourceWindow = [start, solution.end];
    const reference = tortoise(this.camera.camR);
    this.eventWindow = [start + reference, solution.end + reference + 30];
    this.program.setSolution(solution, start, solution.end);
    this.updateStrain();
    if (restart) this.context.setTime(0);
    this.context.requestRedraw();
  }

  private updateStrain(): void {
    const solution = this.solution!;
    this.strain = polarizations(solution, this.settings.inclination * Math.PI / 180);
    let peak = 0;
    for (let i = 0; i < solution.t.length; i++) peak = Math.max(peak, Math.hypot(this.strain.plus[i], this.strain.cross[i]));
    this.plot.setData({ solution, polarizations: this.strain, window: this.sourceWindow, inclinationDeg: this.settings.inclination });
    this.panel.setResults(solution, peak);
  }

  /** Move the observer clock so that the signal from `source` (M) is arriving now. */
  private seek(source: number): void {
    const radius = this.program.material.uniforms.radius.value as number;
    const event = Math.max(this.eventWindow[0], Math.min(this.eventWindow[1], source + tortoise(radius)));
    this.context.setTime(event - this.eventWindow[0]);
    this.context.requestRedraw();
  }

  frame(timeM: number): void {
    if (!this.solution || !this.strain) return;
    let event = this.eventWindow[0] + timeM;
    if (timeM < 0 || event > this.eventWindow[1]) {
      this.context.setTime(0);
      event = this.eventWindow[0];
    }
    if (event !== this.program.eventTime) {
      this.program.eventTime = event;
      if (this.context.isPaused()) this.context.requestRedraw();
    }
    const radius = this.program.material.uniforms.radius.value as number;
    const source = event - tortoise(radius);
    this.plot.setCursor(source);
    const now = performance.now();
    if (now - this.lastReadout < 66) return;
    this.lastReadout = now;
    this.updateReadouts(source);
  }

  private updateReadouts(source: number): void {
    const s = this.solution!;
    const set = (key: string, text: string) => {
      const node = this.readouts.get(key)!;
      if (node.textContent !== text) node.textContent = text;
    };
    const seconds = source * s.secondsPerM;
    set('time', source < 0
      ? `${Math.abs(seconds) < 1 ? (seconds * 1000).toFixed(1) + ' ms' : seconds.toFixed(2) + ' s'} · ${source.toFixed(0)} M`
      : `+${(seconds * 1000).toFixed(1)} ms · ringdown`);
    const omega = Math.max(0, valueAt(s.t, s.frequency22, source));
    set('frequency', `${(omega / (2 * Math.PI * s.secondsPerM)).toFixed(1)} Hz`);
    if (source <= Math.min(0, s.dynamicsEnd)) {
      const r = valueAt(s.t, s.r, source);
      const km = r * s.input.totalMass * MSUN_METRES / 1000;
      set('separation', `${r.toFixed(2)} M · ${km < 1e4 ? km.toFixed(0) : (km / 1000).toFixed(1) + 'k'} km`);
      const speed = r * valueAt(s.t, s.omega, source);
      set('speed', `${speed.toFixed(3)} c`);
    } else {
      set('separation', `remnant · χ ${s.remnant.spin.toFixed(2)}`);
      set('speed', '—');
    }
    const i = sampleIndex(s.t, source);
    set('strain', superscriptExponent(Math.hypot(this.strain!.plus[i], this.strain!.cross[i]), 1));
  }

  dispose(): void {
    this.disposed = true;
    window.clearTimeout(this.solveTimer);
    this.plot.dispose();
    this.program.dispose();
    this.context.controls.replaceChildren();
    this.context.readouts.replaceChildren();
    this.context.plots.replaceChildren();
  }
}

export const createMergerScenario: ScenarioFactory = context => new MergerScenario(context);
