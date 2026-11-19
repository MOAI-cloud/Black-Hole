// Complete inspiral–merger–ringdown solution for an aligned-spin binary.
//
// 1. Inspiral and plunge: TEOBResumS-type EOB dynamics (eob.ts) from a
//    post-adiabatic initial state at the separation where the (2,2) mode enters
//    the detector band.
// 2. Waveform before merger: factorized multipolar modes. The (2,2) mode receives
//    next-to-quasi-circular (NQC) corrections that impose the numerical-relativity
//    peak amplitude and frequency of Healy & Lousto, PRD 97, 084002 (2018).
// 3. Merger and ringdown: the Backwards-One-Body model, McWilliams, PRL 122,
//    191102 (2019), driven by the remnant's exact Kerr quasi-normal modes (qnm.ts)
//    for a remnant mass and spin from NR fits (remnant.ts). The (2,2) strain uses
//    |h| = |h0| (w0/w)^2 sech((t - tp)/tau)/sech((t0 - tp)/tau) with tp fixed by the
//    amplitude peak at t0, as in Kankani & McWilliams' SEBOB construction.
// 4. Higher modes attach the same BOB form with C1 amplitude continuity.

import { DenseOutput, integrate } from './ode';
import { EobModel, type EobDerivatives } from './eob';
import { kerrQnm, type Qnm } from './qnm';
import { peakValues, remnant as remnantFit, type BinaryMasses, type PeakValues } from './remnant';
import { MSUN_SECONDS, redshiftForDistance } from './units';

export interface MergerInput {
  /** Source-frame total mass in solar masses. */
  totalMass: number;
  /** m1/m2 >= 1. */
  massRatio: number;
  /** Dimensionless spin components along the orbital angular momentum. */
  chi1: number;
  chi2: number;
  /** Luminosity distance in Mpc. */
  distance: number;
  /** Detector-frame (2,2) frequency at which the evolution starts, Hz. */
  fLow?: number;
  /** Smallest initial separation in M, so the 3D view always shows an inspiral. */
  minSeparation?: number;
}

export interface ModeSeries {
  l: number;
  m: number;
  /** |r h_lm / M| */
  amp: Float64Array;
  /** arg h_lm, unwrapped; the mode frequency is -d(phase)/dt. */
  phase: Float64Array;
}

export interface MergerSolution {
  input: Required<MergerInput>;
  masses: BinaryMasses;
  nu: number;
  redshift: number;
  /** Redshifted total mass, (1 + z) M, in solar masses. */
  detectorMass: number;
  /** Detector-frame seconds per unit of M. */
  secondsPerM: number;
  /** Coordinate time in M; t = 0 at the peak of |h22|. */
  t: Float64Array;
  /** EOB separation, orbital phase of body 1, and their rates. */
  r: Float64Array;
  phi: Float64Array;
  rdot: Float64Array;
  omega: Float64Array;
  /** Time after which the binary is replaced by the remnant in the 3D view. */
  dynamicsEnd: number;
  modes: ModeSeries[];
  /** Gravitational-wave luminosity in units of c^5/G. */
  luminosity: Float64Array;
  /** (2,2) frequency, M omega22. */
  frequency22: Float64Array;
  start: number;
  end: number;
  remnant: {
    mass: number;
    spin: number;
    kick: number;
    /** Radiated energy from the NR fit and from integrating the waveform, in M. */
    radiatedFit: number;
    radiatedWaveform: number;
    qnm: Record<string, Qnm & { omegaM: number; tauM: number }>;
  };
  peak: PeakValues & { time: number };
  peakFit: PeakValues;
  /** Binding energy E/M - 1 when the evolution starts. */
  initialBinding: number;
  initialSeparation: number;
  /** Detector-frame (2,2) frequency at the start, Hz. */
  startFrequency: number;
  elapsedMs: number;
}

const OUTPUT_MODES: [number, number][] = [[2, 2], [2, 1], [3, 3], [3, 2], [4, 4]];

function sech(x: number): number {
  const e = Math.exp(-Math.abs(x));
  return 2 * e / (1 + e * e);
}

/** Unwrap a phase series in place. */
function unwrap(phase: Float64Array): void {
  let offset = 0;
  for (let i = 1; i < phase.length; i++) {
    const raw = phase[i] + offset;
    const delta = raw - phase[i - 1];
    if (delta > Math.PI) offset -= 2 * Math.PI * Math.round(delta / (2 * Math.PI));
    else if (delta < -Math.PI) offset += 2 * Math.PI * Math.round(-delta / (2 * Math.PI));
    phase[i] += offset;
  }
}

/** Derivative on a non-uniform grid (second-order central differences). */
function derivative(t: Float64Array, y: Float64Array): Float64Array {
  const n = t.length, d = new Float64Array(n);
  for (let i = 1; i < n - 1; i++) {
    const h0 = t[i] - t[i - 1], h1 = t[i + 1] - t[i];
    d[i] = (h0 * h0 * (y[i + 1] - y[i]) + h1 * h1 * (y[i] - y[i - 1])) / (h0 * h1 * (h0 + h1));
  }
  d[0] = (y[1] - y[0]) / (t[1] - t[0]);
  d[n - 1] = (y[n - 1] - y[n - 2]) / (t[n - 1] - t[n - 2]);
  return d;
}

/**
 * Backwards-One-Body strain for one mode attached at t0 with amplitude A0,
 * log-derivative of the amplitude D0, and frequency w0, ringing down at the
 * quasi-normal mode (wQ, 1/tau). Returns amplitude and frequency at time t.
 */
class BobMode {
  private readonly tp: number;
  private readonly k: number;
  private readonly tanh0: number;
  private readonly sech0: number;
  constructor(readonly t0: number, readonly A0: number, D0: number, readonly w0In: number,
    readonly wQ: number, readonly tau: number) {
    const w0 = this.w0 = Math.min(w0In, 0.995 * wQ);
    // d ln|h|/dt = -2 w'/w - tanh(s)/tau with w'^ from the BOB frequency law.
    const R = (wQ ** 4 - w0 ** 4) / (2 * w0 ** 4);
    const T = Math.max(-0.9999, Math.min(0.9999, -(D0 * tau + R) / (R + 1)));
    this.tanh0 = T;
    const s0 = Math.atanh(T);
    this.sech0 = sech(s0);
    this.tp = t0 - tau * s0;
    this.k = (wQ ** 4 - w0 ** 4) / (1 - T);
  }
  readonly w0: number;

  frequency(t: number): number {
    const s = (t - this.tp) / this.tau;
    return Math.pow(this.w0 ** 4 + this.k * (Math.tanh(s) - this.tanh0), 0.25);
  }

  frequencyRate(t: number): number {
    const s = (t - this.tp) / this.tau;
    const w = this.frequency(t);
    const c = sech(s);
    return this.k * c * c / (4 * this.tau * w ** 3);
  }

  amplitude(t: number): number {
    const s = (t - this.tp) / this.tau;
    const w = this.frequency(t);
    return this.A0 * (this.w0 / w) ** 2 * sech(s) / this.sech0;
  }

  /** Second time derivative of the amplitude (central differences of the closed form). */
  amplitudeCurvature(t: number): number {
    const h = 0.05;
    return (this.amplitude(t + h) - 2 * this.amplitude(t) + this.amplitude(t - h)) / (h * h);
  }
}

export function solveMerger(request: MergerInput): MergerSolution {
  const started = performance.now();
  const input: Required<MergerInput> = { fLow: 20, minSeparation: 12, ...request };
  const q = Math.max(1, input.massRatio);
  const masses: BinaryMasses = {
    X1: q / (1 + q), X2: 1 / (1 + q),
    chi1: Math.max(-0.99, Math.min(0.99, input.chi1)),
    chi2: Math.max(-0.99, Math.min(0.99, input.chi2))
  };
  const redshift = redshiftForDistance(input.distance);
  const detectorMass = (1 + redshift) * input.totalMass;
  const secondsPerM = detectorMass * MSUN_SECONDS;
  const eob = new EobModel(masses);
  const nu = eob.nu;

  // Start where the (2,2) mode reaches fLow, but always with a visible inspiral.
  const omegaLow = Math.PI * input.fLow * secondsPerM;
  const r0 = Math.min(40, Math.max(input.minSeparation + 2, Math.pow(omegaLow, -2 / 3)));
  const y0 = eob.initialState(r0);
  const state = {} as EobDerivatives;
  let omegaPeak = 0, tOmegaPeak = NaN;
  const path = integrate((_t, y, dy) => eob.rhs(y, dy, state), 0, y0, {
    rtol: 1e-9, atol: 1e-12, initialStep: 1, maxSteps: 400000,
    maxStep: (_t, y) => Math.max(0.05, 0.25 * Math.pow(Math.max(1, y[0]), 1.5)),
    stop: (t, y, dy) => {
      const omega = dy[1];
      if (omega > omegaPeak) { omegaPeak = omega; tOmegaPeak = t; }
      return y[0] < 0.9 || (omegaPeak > 0.05 && omega < 0.97 * omegaPeak) || t > tOmegaPeak + 25 && omegaPeak > 0.08;
    }
  });
  const dense = new DenseOutput(path);
  const tDynEnd = dense.end;
  if (!Number.isFinite(tOmegaPeak)) tOmegaPeak = tDynEnd;
  const scratch = new Float64Array(4);
  const peakFit = peakValues(masses);
  // Matching (merger) time: one M before the peak of the orbital frequency or,
  // when the plunge continues to higher frequency (large aligned spins), the
  // moment the orbit reaches the NR peak frequency, omega22 = 2 Omega. Both keep
  // t0 inside the integrated dynamics so that the derivatives below are centred.
  let t0 = Math.min(tOmegaPeak - 1, tDynEnd - 2.5);
  {
    const omegaTarget = 0.5 * peakFit.frequency;
    const steps = path.t;
    for (let i = 1; i < steps.length; i++) {
      if (path.f[4 * i + 1] < omegaTarget) continue;
      let lo = steps[i - 1], hi = steps[i];
      for (let k = 0; k < 50; k++) {
        const mid = 0.5 * (lo + hi);
        dense.evaluate(mid, scratch);
        const s = {} as EobDerivatives;
        eob.evaluate(scratch[0], scratch[2], scratch[3], s);
        if (s.Omega < omegaTarget) lo = mid; else hi = mid;
      }
      t0 = Math.min(t0, 0.5 * (lo + hi));
      break;
    }
  }
  const dynamics = (t: number) => {
    dense.evaluate(t, scratch);
    eob.evaluate(scratch[0], scratch[2], scratch[3], state);
    return state;
  };
  const factorized = (l: number, m: number, t: number) => {
    const s = dynamics(t);
    const vPhi = eob.vPhi(s, scratch[3]);
    return eob.mode(l, m, s, scratch[3], scratch[1], vPhi);
  };

  // Remnant and its quasi-normal modes, in units of the initial total mass.
  const fit = remnantFit(masses);
  const qnm: MergerSolution['remnant']['qnm'] = {};
  for (const [l, m] of OUTPUT_MODES) {
    const mode = kerrQnm(l, m, 0, fit.spin);
    qnm[`${l}${m}`] = { ...mode, omegaM: mode.omega / fit.mass, tauM: fit.mass / mode.gamma };
  }
  const q22 = qnm['22'];

  // --- NQC calibration of the (2,2) mode at t0 -------------------------------
  const dt = 0.02;
  const sample = (t: number) => {
    const s = dynamics(t);
    const r = scratch[0], prs = scratch[2];
    const rOmega = r * s.Omega;
    const base = prs * prs / (rOmega * rOmega);
    const mode = factorized(2, 2, t);
    return { amp: mode.amp, phase: mode.phase, n1: base, n2: base / r, n3: base / (r * Math.sqrt(r)),
      n4: prs / rOmega, n5: prs ** 3 / rOmega };
  };
  const stencil = [-2, -1, 0, 1, 2].map(j => sample(t0 + j * dt));
  for (let j = 1; j < 5; j++) {
    while (stencil[j].phase - stencil[j - 1].phase > Math.PI) stencil[j].phase -= 2 * Math.PI;
    while (stencil[j].phase - stencil[j - 1].phase < -Math.PI) stencil[j].phase += 2 * Math.PI;
  }
  type Key = 'amp' | 'phase' | 'n1' | 'n2' | 'n3' | 'n4' | 'n5';
  const d1 = (key: Key) =>
    (8 * (stencil[3][key] - stencil[1][key]) - (stencil[4][key] - stencil[0][key])) / (12 * dt);
  const d2 = (key: Key) =>
    (-(stencil[4][key] + stencil[0][key]) + 16 * (stencil[3][key] + stencil[1][key]) - 30 * stencil[2][key]) / (12 * dt * dt);
  const c = stencil[2];
  const target = { amp: peakFit.amplitude, omega: Math.min(peakFit.frequency, 0.97 * q22.omegaM) };
  const bob22 = new BobMode(t0, target.amp, 0, target.omega, q22.omegaM, q22.tauM);
  const omegaDotTarget = bob22.frequencyRate(t0);
  // |h| = |hF| (1 + a1 n1 + a2 n2 + a3 n3): NR peak value, zero slope and the
  // BOB curvature at t0, so the amplitude joins the ringdown with C2 continuity.
  const amps = (() => {
    const F = c.amp, Fd = d1('amp'), Fdd = d2('amp');
    const keys = ['n1', 'n2', 'n3'] as const;
    const m = [
      keys.map(k => F * c[k]),
      keys.map(k => Fd * c[k] + F * d1(k)),
      keys.map(k => Fdd * c[k] + 2 * Fd * d1(k) + F * d2(k))
    ];
    const rhs = [target.amp - F, -Fd, bob22.amplitudeCurvature(t0) - Fdd];
    return solveTriple(m, rhs) ?? [0, 0, 0];
  })();
  // arg h = arg hF + b1 n4 + b2 n5, with omega = -d(arg h)/dt and its rate.
  const phases = (() => {
    const omegaF = -d1('phase'), omegaDotF = -d2('phase');
    const m = [[d1('n4'), d1('n5')], [d2('n4'), d2('n5')]];
    return solvePair(m, [omegaF - target.omega, omegaDotF - omegaDotTarget]) ?? [0, 0];
  })();

  // --- Output grid -------------------------------------------------------------
  const ringdownEnd = t0 + Math.max(160, 14 * q22.tauM);
  const times: number[] = [];
  for (let t = dense.start; t < ringdownEnd;) {
    times.push(t);
    let step: number;
    if (t < t0 - 60) {
      dense.evaluate(t, scratch);
      const omega = Math.abs(dynamics(t).Omega);
      step = Math.min(40, Math.max(0.25, 0.12 / omega));
    } else step = t < t0 + 60 ? 0.1 : 0.25;
    if (t < t0 && t + step > t0) step = t0 - t;
    t += Math.max(step, 1e-9);
  }
  times.push(ringdownEnd);
  const n = times.length;
  const t = Float64Array.from(times);
  const r = new Float64Array(n), phi = new Float64Array(n), rdot = new Float64Array(n), omega = new Float64Array(n);
  const modes: ModeSeries[] = OUTPUT_MODES.map(([l, m]) => ({ l, m, amp: new Float64Array(n), phase: new Float64Array(n) }));
  const preMerger = t.findIndex(time => time > t0) - 1;
  // Higher multipoles carry no NQC information, and their PN-resummed amplitudes
  // lose accuracy deep in the plunge. Join them to their ringdown no later than
  // the orbital frequency 0.16/M, roughly where NR modes stop following the orbit.
  let attachHM = preMerger;
  for (let i = 0; i < n; i++) {
    const s = dynamics(Math.min(t[i], tDynEnd));
    r[i] = scratch[0]; phi[i] = scratch[1]; rdot[i] = s.rdot; omega[i] = s.Omega;
    if (i > preMerger) continue;
    if (attachHM === preMerger && s.Omega >= 0.16 && i >= 2) attachHM = i;
    const vPhi = eob.vPhi(s, scratch[3]);
    for (const series of modes) {
      if (series !== modes[0] && i > attachHM) continue;
      const value = eob.mode(series.l, series.m, s, scratch[3], scratch[1], vPhi);
      series.amp[i] = value.amp;
      series.phase[i] = value.phase;
    }
    // NQC factors for the dominant mode.
    const prs = scratch[2], rOmega = scratch[0] * s.Omega;
    const base = prs * prs / (rOmega * rOmega);
    modes[0].amp[i] *= 1 + base * (amps[0] + amps[1] / scratch[0] + amps[2] / (scratch[0] * Math.sqrt(scratch[0])));
    modes[0].phase[i] += phases[0] * prs / rOmega + phases[1] * prs ** 3 / rOmega;
  }
  unwrap(modes[0].phase.subarray(0, preMerger + 1));
  for (const series of modes.slice(1)) unwrap(series.phase.subarray(0, attachHM + 1));

  // --- Merger and ringdown ------------------------------------------------------
  for (const series of modes) {
    const key = `${series.l}${series.m}`;
    const mode = qnm[key];
    const j = key === '22' ? preMerger : attachHM;
    const A0 = series.amp[j];
    if (!(A0 > 0)) continue;
    let bob: BobMode;
    if (key === '22') bob = bob22;
    else {
      // Local slopes from the last factorized samples before t0.
      const h = t[j] - t[j - 2];
      const D0 = Math.log(series.amp[j] / series.amp[j - 2]) / h;
      const w0 = -(series.phase[j] - series.phase[j - 2]) / h;
      bob = new BobMode(t[j], A0, D0, Math.max(0.2 * mode.omegaM, w0), mode.omegaM, mode.tauM);
    }
    let phase = series.phase[j];
    let previous = t[j];
    for (let i = j + 1; i < n; i++) {
      // Simpson integration of the BOB frequency.
      const mid = 0.5 * (previous + t[i]);
      phase -= (t[i] - previous) / 6 * (bob.frequency(previous) + 4 * bob.frequency(mid) + bob.frequency(t[i]));
      previous = t[i];
      series.amp[i] = bob.amplitude(t[i]);
      series.phase[i] = phase;
    }
  }

  // --- Energy balance -----------------------------------------------------------
  const luminosity = new Float64Array(n);
  for (const series of modes) {
    const ampDot = derivative(t, series.amp);
    const phaseDot = derivative(t, series.phase);
    for (let i = 0; i < n; i++) {
      luminosity[i] += (ampDot[i] ** 2 + (series.amp[i] * phaseDot[i]) ** 2) / (8 * Math.PI);
    }
  }
  let radiated = 0;
  for (let i = 1; i < n; i++) radiated += 0.5 * (luminosity[i] + luminosity[i - 1]) * (t[i] - t[i - 1]);
  const first = {} as EobDerivatives;
  eob.evaluate(y0[0], y0[2], y0[3], first);
  const initialBinding = first.Hreal - 1;
  let peakIndex = 0;
  for (let i = 1; i < n; i++) if (luminosity[i] > luminosity[peakIndex]) peakIndex = i;
  let ampPeak = 0, ampPeakTime = t0;
  for (let i = 0; i < n; i++) if (modes[0].amp[i] > ampPeak) { ampPeak = modes[0].amp[i]; ampPeakTime = t[i]; }
  const frequency22 = derivative(t, modes[0].phase).map(v => -v);
  const peakIndex22 = t.findIndex(time => time >= ampPeakTime);

  // Shift the clock so that t = 0 at the merger (peak of |h22|).
  for (let i = 0; i < n; i++) t[i] -= ampPeakTime;
  return {
    input, masses, nu, redshift, detectorMass, secondsPerM,
    t, r, phi, rdot, omega,
    dynamicsEnd: Math.min(tDynEnd, t0) - ampPeakTime,
    modes, luminosity, frequency22,
    start: t[0], end: t[n - 1],
    remnant: { mass: fit.mass, spin: fit.spin, kick: fit.kick, radiatedFit: fit.radiated,
      radiatedWaveform: radiated - initialBinding, qnm },
    peak: { amplitude: ampPeak, frequency: frequency22[peakIndex22], luminosity: luminosity[peakIndex], time: 0 },
    peakFit,
    initialBinding,
    initialSeparation: r0,
    startFrequency: frequency22[0] / (2 * Math.PI * secondsPerM),
    elapsedMs: performance.now() - started
  };
}

function solveTriple(m: number[][], b: number[]): [number, number, number] | null {
  const det = (a: number[][]) => a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
  const d = det(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-300) return null;
  const column = (j: number) => m.map((row, i) => row.map((v, k) => k === j ? b[i] : v));
  const x: [number, number, number] = [det(column(0)) / d, det(column(1)) / d, det(column(2)) / d];
  return x.every(Number.isFinite) ? x : null;
}

function solvePair(m: number[][], b: number[]): [number, number] | null {
  const det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) return null;
  const x = (b[0] * m[1][1] - b[1] * m[0][1]) / det;
  const y = (m[0][0] * b[1] - m[1][0] * b[0]) / det;
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : null;
}

/** Interpolated value of a series at time t (linear; series are densely sampled). */
export function interpolate(t: Float64Array, values: Float64Array, time: number): number {
  const n = t.length;
  if (time <= t[0]) return values[0];
  if (time >= t[n - 1]) return values[n - 1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid; }
  const f = (time - t[lo]) / (t[hi] - t[lo]);
  return values[lo] + f * (values[hi] - values[lo]);
}
