import { spinWeightedY } from './harmonics';
import type { MergerSolution } from './merger';
import { MPC_METRES, MSUN_METRES } from './units';

/** Dimensionless strain per unit r h / M at the source's luminosity distance. */
export function strainScale(solution: MergerSolution): number {
  return solution.detectorMass * MSUN_METRES / (solution.input.distance * MPC_METRES);
}

export interface Polarizations {
  plus: Float64Array;
  cross: Float64Array;
}

/**
 * h+ and hx at Earth for an observer at inclination iota (angle between the line
 * of sight and the orbital angular momentum) and reference azimuth phi0:
 * h+ - i hx = (M/D) sum_lm h_lm  _{-2}Y_lm(iota, phi0), with h_l,-m = (-1)^l h_lm*.
 */
export function polarizations(solution: MergerSolution, iota: number, phi0 = 0): Polarizations {
  const n = solution.t.length;
  const plus = new Float64Array(n), cross = new Float64Array(n);
  const scale = strainScale(solution);
  for (const mode of solution.modes) {
    const [yr, yi] = spinWeightedY(-2, mode.l, mode.m, iota, phi0);
    const [zr, zi] = spinWeightedY(-2, mode.l, -mode.m, iota, phi0);
    const parity = mode.l % 2 === 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const a = mode.amp[i] * scale, c = Math.cos(mode.phase[i]), s = Math.sin(mode.phase[i]);
      // h_lm Y_lm + (-1)^l conj(h_lm) Y_l,-m
      const re = a * (c * yr - s * yi) + parity * a * (c * zr + s * zi);
      const im = a * (c * yi + s * yr) + parity * a * (c * zi - s * zr);
      plus[i] += re;
      cross[i] -= im;
    }
  }
  return { plus, cross };
}

/** Index of the first sample at or after time t (binary search). */
export function sampleIndex(times: Float64Array, t: number): number {
  let lo = 0, hi = times.length - 1;
  if (t <= times[0]) return 0;
  if (t >= times[hi]) return hi;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < t) lo = mid; else hi = mid;
  }
  return hi;
}

/** Linear interpolation of a sampled series. */
export function valueAt(times: Float64Array, values: Float64Array, t: number): number {
  const i = sampleIndex(times, t);
  if (i === 0) return values[0];
  const f = (t - times[i - 1]) / (times[i] - times[i - 1]);
  return values[i - 1] + Math.max(0, Math.min(1, f)) * (values[i] - values[i - 1]);
}

/** Number of (2,2) cycles between the detector-frame frequency fLow and merger. */
export function cyclesInBand(solution: MergerSolution, fLow: number): number {
  const omegaLow = 2 * Math.PI * fLow * solution.secondsPerM;
  const phase = solution.modes[0].phase;
  const merger = sampleIndex(solution.t, 0);
  let start = 0;
  while (start < merger && solution.frequency22[start] < omegaLow) start++;
  return Math.abs(phase[merger] - phase[start]) / (2 * Math.PI);
}
