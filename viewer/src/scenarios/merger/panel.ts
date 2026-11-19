import type { MergerInput, MergerSolution } from './merger';
import { formatDistance } from './gwPlot';
import { C5_OVER_G_WATTS, MSUN_JOULES } from './units';
import { cyclesInBand } from './waveform';

export interface MergerSettings {
  totalMass: number;
  massRatio: number;
  chi1: number;
  chi2: number;
  distance: number;
  inclination: number;
  waves: boolean;
  trails: boolean;
  gain: number;
}

export interface Preset { id: string; label: string; note: string; settings: Omit<MergerSettings, 'waves' | 'trails' | 'gain'> }

// Source-frame parameters; spins are the components along the orbital angular momentum.
export const PRESETS: Preset[] = [
  { id: 'gw150914', label: 'GW150914', note: 'First detection, 14 Sep 2015 (GWTC-1 medians; χ_eff ≈ 0).',
    settings: { totalMass: 66.2, massRatio: 35.6 / 30.6, chi1: 0, chi2: 0, distance: 440, inclination: 150 } },
  { id: 'gw190521', label: 'GW190521', note: 'Most massive confirmed binary; 142 M☉ remnant (aligned part of the spins, χ_eff ≈ 0.08).',
    settings: { totalMass: 151, massRatio: 85 / 66, chi1: 0.08, chi2: 0.08, distance: 5300, inclination: 30 } },
  { id: 'gw190814', label: 'GW190814', note: 'Mass ratio ≈ 9; the 2.6 M☉ companion is modelled as a black hole.',
    settings: { totalMass: 25.8, massRatio: 23.2 / 2.59, chi1: 0, chi2: 0, distance: 241, inclination: 46 } },
  { id: 'hangup', label: 'Orbital hang-up (χ = +0.9)', note: 'Spins aligned with the orbit delay the merger and add cycles.',
    settings: { totalMass: 60, massRatio: 1, chi1: 0.9, chi2: 0.9, distance: 400, inclination: 30 } },
  { id: 'antialigned', label: 'Anti-aligned spins (χ = −0.9)', note: 'Spins against the orbit plunge earlier and leave a slower remnant.',
    settings: { totalMass: 60, massRatio: 1, chi1: -0.9, chi2: -0.9, distance: 400, inclination: 30 } }
];

type NumericKey = 'totalMass' | 'massRatio' | 'chi1' | 'chi2' | 'distance' | 'inclination' | 'gain';
interface SliderSpec { key: NumericKey; label: string; min: number; max: number; step: number; log?: boolean; format: (v: number) => string }

const SLIDERS: SliderSpec[] = [
  { key: 'totalMass', label: 'Total mass', min: 6, max: 400, step: 0.001, log: true, format: v => v.toFixed(v < 100 ? 1 : 0) + ' M☉' },
  { key: 'massRatio', label: 'Mass ratio m₁/m₂', min: 1, max: 10, step: 0.01, format: v => v.toFixed(2) },
  { key: 'chi1', label: 'Spin χ₁ (along L)', min: -0.95, max: 0.95, step: 0.01, format: v => (v >= 0 ? '+' : '') + v.toFixed(2) },
  { key: 'chi2', label: 'Spin χ₂ (along L)', min: -0.95, max: 0.95, step: 0.01, format: v => (v >= 0 ? '+' : '') + v.toFixed(2) },
  { key: 'distance', label: 'Luminosity distance', min: 10, max: 10000, step: 0.001, log: true, format: formatDistance },
  { key: 'inclination', label: 'Inclination at Earth', min: 0, max: 180, step: 0.5, format: v => v.toFixed(0) + '°' }
];

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function superscriptExponent(value: number, digits = 2): string {
  if (value === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  const mantissa = value / 10 ** exponent;
  const sup = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  const power = (exponent < 0 ? '⁻' : '') + String(Math.abs(exponent)).split('').map(d => sup[Number(d)]).join('');
  return `${mantissa.toFixed(digits)} × 10${power}`;
}

export class MergerPanel {
  private readonly refreshers: Array<() => void> = [];
  private readonly results = new Map<string, HTMLElement>();
  private readonly presetSelect: HTMLSelectElement;
  private readonly presetNote: HTMLElement;
  private readonly status: HTMLElement;

  constructor(host: HTMLElement, private readonly settings: MergerSettings,
    private readonly onChange: (physics: boolean) => void,
    actions: { restart: () => void; merger: () => void }) {
    host.classList.add('merger-panel');
    // Binary parameters.
    const binary = element('section', 'panel-section');
    binary.append(element('h3', undefined, 'Binary black hole'));
    const presetRow = element('label', 'select-row');
    presetRow.append(element('span', undefined, 'Observed system'));
    this.presetSelect = element('select');
    this.presetSelect.append(new Option('Custom', ''));
    for (const preset of PRESETS) this.presetSelect.append(new Option(preset.label, preset.id));
    presetRow.append(this.presetSelect);
    this.presetNote = element('p', 'merger-note');
    binary.append(presetRow, this.presetNote);
    this.presetSelect.addEventListener('change', () => {
      const preset = PRESETS.find(p => p.id === this.presetSelect.value);
      if (!preset) return;
      Object.assign(this.settings, preset.settings);
      this.refresh();
      this.onChange(true);
    });
    const stack = element('div', 'control-stack');
    for (const spec of SLIDERS) stack.append(this.slider(spec, spec.key !== 'inclination'));
    binary.append(stack);
    host.append(binary);

    // View options.
    const view = element('section', 'panel-section');
    view.append(element('h3', undefined, 'Spacetime view'));
    view.append(this.toggle('Gravitational-wave field h₊', 'waves'));
    view.append(this.toggle('Orbit trails', 'trails'));
    view.append(this.slider({ key: 'gain', label: 'Wave-field contrast', min: 1, max: 30, step: 0.5, log: true,
      format: v => v.toFixed(1) + '×' }, false));
    const buttons = element('div', 'merger-actions');
    const restart = element('button', 'outline', 'Replay inspiral');
    restart.type = 'button';
    restart.addEventListener('click', actions.restart);
    const jump = element('button', 'outline', 'Jump to merger');
    jump.type = 'button';
    jump.addEventListener('click', actions.merger);
    buttons.append(restart, jump);
    view.append(buttons);
    host.append(view);

    // Remnant and radiation.
    const results = element('section', 'panel-section');
    results.append(element('h3', undefined, 'Remnant and radiation'));
    const list = element('dl', 'merger-results');
    for (const [key, label] of [['final', 'Final mass'], ['spin', 'Final spin χ_f'], ['energy', 'Radiated energy'],
      ['joules', 'Energy (J)'], ['luminosity', 'Peak luminosity'], ['kick', 'Recoil'], ['ringdown', 'Ringdown f₂₂₀ · τ'],
      ['merger', 'Peak f_GW'], ['cycles', 'Cycles above 20 Hz'], ['strain', 'Peak strain at Earth'], ['redshift', 'Redshift z']]) {
      const row = element('div');
      const value = element('dd');
      row.append(element('dt', undefined, label), value);
      list.append(row);
      this.results.set(key, value);
    }
    results.append(list);
    this.status = element('p', 'merger-status');
    results.append(this.status);
    host.append(results);

    // Model notes.
    const model = element('section', 'panel-section merger-model');
    model.append(element('h3', undefined, 'Model'));
    const notes: [string, string, string][] = [
      ['Inspiral & plunge', 'Effective-one-body dynamics (TEOBResumS Hamiltonian, NR-informed a₆ᶜ, c₃) with factorized resummed radiation reaction, l ≤ 4.', 'https://arxiv.org/abs/1911.10818'],
      ['Waveform', 'Damour–Iyer–Nagar factorized modes; (2,2) NQC corrections impose the NR peak amplitude and frequency of Healy & Lousto (2018).', 'https://arxiv.org/abs/0811.2069'],
      ['Merger & ringdown', 'Backwards-One-Body model on the remnant’s Kerr quasi-normal modes, computed with Leaver’s continued fractions.', 'https://arxiv.org/abs/1810.00040'],
      ['Remnant', 'Final spin: Rezzolla et al. (2008). Radiated energy: Barausse, Morozova & Rezzolla (2012). Recoil: Healy & Lousto (2018), Campanelli et al. (2007).', 'https://arxiv.org/abs/1206.3803'],
      ['Lensing', 'Null geodesics in superposed, boosted Kerr–Schild black holes at each ray’s retarded time; the remnant is exact Kerr. The binary metric is an approximation outside full numerical relativity.', 'https://arxiv.org/abs/1410.7775']
    ];
    for (const [title, text, href] of notes) {
      const p = element('p', 'merger-note');
      const strong = element('strong', undefined, title + '. ');
      const link = element('a', undefined, 'Ref.');
      link.href = href; link.target = '_blank'; link.rel = 'noreferrer';
      p.append(strong, text + ' ', link);
      model.append(p);
    }
    host.append(model);
    this.refresh();
  }

  private slider(spec: SliderSpec, physics: boolean): HTMLElement {
    const row = element('label', 'range-row');
    const value = element('output', 'range-value');
    const input = element('input');
    input.type = 'range';
    input.setAttribute('aria-label', spec.label);
    const toInput = (v: number) => spec.log ? Math.log(v) : v;
    const fromInput = (v: number) => spec.log ? Math.exp(v) : v;
    input.min = String(toInput(spec.min));
    input.max = String(toInput(spec.max));
    input.step = String(spec.log ? 0.001 : spec.step);
    row.append(element('span', 'range-label', spec.label), value, input);
    const render = () => {
      const current = this.settings[spec.key];
      value.textContent = spec.format(current);
      input.value = String(toInput(current));
      input.setAttribute('aria-valuetext', value.textContent);
      const fill = (toInput(current) - toInput(spec.min)) / (toInput(spec.max) - toInput(spec.min));
      input.style.setProperty('--fill', 100 * fill + '%');
    };
    this.refreshers.push(render);
    input.addEventListener('input', () => {
      let v = fromInput(input.valueAsNumber);
      if (!spec.log) v = Math.round(v / spec.step) * spec.step;
      this.settings[spec.key] = v;
      if (physics) this.presetSelect.value = '';
      render();
      this.updatePresetNote();
      this.onChange(physics);
    });
    return row;
  }

  private toggle(label: string, key: 'waves' | 'trails'): HTMLElement {
    const row = element('label', 'toggle-row');
    const input = element('input');
    input.type = 'checkbox';
    input.setAttribute('role', 'switch');
    row.append(element('span', undefined, label), input);
    this.refreshers.push(() => { input.checked = this.settings[key]; });
    input.addEventListener('change', () => { this.settings[key] = input.checked; this.onChange(false); });
    return row;
  }

  private updatePresetNote(): void {
    const preset = PRESETS.find(p => p.id === this.presetSelect.value);
    this.presetNote.textContent = preset ? preset.note : 'Aligned spins; masses in the source frame.';
  }

  selectPreset(id: string): void {
    this.presetSelect.value = id;
    this.updatePresetNote();
  }

  refresh(): void {
    for (const render of this.refreshers) render();
    this.updatePresetNote();
  }

  setBusy(busy: boolean): void {
    this.status.textContent = busy ? 'Solving the binary…' : this.status.textContent;
  }

  setResults(solution: MergerSolution, peakStrain: number): void {
    const M = solution.input.totalMass;
    const set = (key: string, text: string) => { this.results.get(key)!.textContent = text; };
    const radiated = solution.remnant.radiatedFit * M;
    set('final', `${(solution.remnant.mass * M).toFixed(1)} M☉`);
    set('spin', solution.remnant.spin.toFixed(3));
    set('energy', `${radiated.toFixed(2)} M☉c²`);
    set('joules', superscriptExponent(radiated * MSUN_JOULES) + ' J');
    set('luminosity', superscriptExponent(solution.peak.luminosity * C5_OVER_G_WATTS) + ' W');
    set('kick', `${solution.remnant.kick.toFixed(0)} km/s`);
    const q = solution.remnant.qnm['22'];
    const toHz = 1 / (2 * Math.PI * solution.secondsPerM);
    set('ringdown', `${(q.omegaM * toHz).toFixed(0)} Hz · ${(q.tauM * solution.secondsPerM * 1000).toFixed(2)} ms`);
    set('merger', `${(solution.peak.frequency * toHz).toFixed(0)} Hz`);
    set('cycles', cyclesInBand(solution, 20).toFixed(1));
    set('strain', superscriptExponent(peakStrain));
    set('redshift', solution.redshift.toFixed(3));
    const check = solution.remnant.radiatedWaveform / solution.remnant.radiatedFit - 1;
    this.status.textContent = `Solved in ${solution.elapsedMs.toFixed(0)} ms from ${solution.initialSeparation.toFixed(1)} M ` +
      `(${solution.startFrequency.toFixed(0)} Hz). Waveform energy vs NR fit: ${(100 * check >= 0 ? '+' : '') + (100 * check).toFixed(1)}%.`;
  }
}

export function inputFromSettings(settings: MergerSettings): MergerInput {
  return {
    totalMass: settings.totalMass, massRatio: settings.massRatio,
    chi1: settings.chi1, chi2: settings.chi2, distance: settings.distance
  };
}
