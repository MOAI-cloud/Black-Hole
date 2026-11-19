// Dormand–Prince 5(4) with step-size control and cubic Hermite dense output.
// J. R. Dormand & P. J. Prince, J. Comput. Appl. Math. 6, 19 (1980).

export type Derivative = (t: number, y: Float64Array, dy: Float64Array) => boolean;

export interface Trajectory {
  /** Accepted step times. */
  t: number[];
  /** State at each accepted time, flattened with stride `dimension`. */
  y: number[];
  /** Derivative at each accepted time, flattened with stride `dimension`. */
  f: number[];
  dimension: number;
}

const C = [0, 1 / 5, 3 / 10, 4 / 5, 8 / 9, 1, 1];
const A = [
  [],
  [1 / 5],
  [3 / 40, 9 / 40],
  [44 / 45, -56 / 15, 32 / 9],
  [19372 / 6561, -25360 / 2187, 64448 / 6561, -212 / 729],
  [9017 / 3168, -355 / 33, 46732 / 5247, 49 / 176, -5103 / 18656],
  [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84]
];
const B5 = [35 / 384, 0, 500 / 1113, 125 / 192, -2187 / 6784, 11 / 84, 0];
const B4 = [5179 / 57600, 0, 7571 / 16695, 393 / 640, -92097 / 339200, 187 / 2100, 1 / 40];

export interface IntegrateOptions {
  rtol: number;
  atol: number;
  initialStep: number;
  maxStep: (t: number, y: Float64Array) => number;
  /** Return true to stop after the accepted step. */
  stop: (t: number, y: Float64Array, dy: Float64Array) => boolean;
  maxSteps: number;
}

export function integrate(f: Derivative, t0: number, y0: Float64Array, options: IntegrateOptions): Trajectory {
  const n = y0.length;
  const k = Array.from({ length: 7 }, () => new Float64Array(n));
  const y = Float64Array.from(y0);
  const trial = new Float64Array(n);
  const next = new Float64Array(n);
  const out: Trajectory = { t: [], y: [], f: [], dimension: n };
  let t = t0;
  if (!f(t, y, k[0])) return out;
  const record = () => {
    out.t.push(t);
    for (let i = 0; i < n; i++) { out.y.push(y[i]); out.f.push(k[0][i]); }
  };
  record();
  let h = options.initialStep;
  for (let step = 0; step < options.maxSteps; step++) {
    h = Math.min(h, options.maxStep(t, y));
    let accepted = false;
    for (let attempt = 0; attempt < 40 && !accepted; attempt++) {
      let ok = true;
      for (let s = 1; s < 7 && ok; s++) {
        for (let i = 0; i < n; i++) {
          let sum = y[i];
          for (let j = 0; j < s; j++) sum += h * A[s][j] * k[j][i];
          trial[i] = sum;
        }
        ok = f(t + C[s] * h, trial, k[s]);
      }
      if (!ok) { h *= 0.3; continue; }
      let error = 0;
      for (let i = 0; i < n; i++) {
        let y5 = y[i], e = 0;
        for (let j = 0; j < 7; j++) {
          y5 += h * B5[j] * k[j][i];
          e += h * (B5[j] - B4[j]) * k[j][i];
        }
        next[i] = y5;
        const scale = options.atol + options.rtol * Math.max(Math.abs(y[i]), Math.abs(y5));
        error = Math.max(error, Math.abs(e) / scale);
      }
      if (!(error <= 1)) {
        h *= Math.max(0.1, 0.9 * Math.pow(error || 1e10, -0.25));
        continue;
      }
      accepted = true;
      t += h;
      y.set(next);
      k[0].set(k[6]); // first same as last
      record();
      h *= Math.min(4, Math.max(0.2, 0.9 * Math.pow(Math.max(error, 1e-12), -0.2)));
    }
    if (!accepted || options.stop(t, y, k[0])) break;
  }
  return out;
}

/** Cubic Hermite interpolation of the accepted steps. */
export class DenseOutput {
  private index = 0;
  constructor(readonly path: Trajectory) {}

  get start(): number { return this.path.t[0]; }
  get end(): number { return this.path.t[this.path.t.length - 1]; }

  evaluate(time: number, out: Float64Array): void {
    const { t, y, f, dimension: n } = this.path;
    const last = t.length - 1;
    if (time <= t[0]) { for (let i = 0; i < n; i++) out[i] = y[i]; return; }
    if (time >= t[last]) { for (let i = 0; i < n; i++) out[i] = y[last * n + i]; return; }
    let j = Math.min(this.index, last - 1);
    if (t[j] > time) j = 0;
    while (j < last - 1 && t[j + 1] < time) j++;
    if (t[j] > time || t[j + 1] < time) {
      let lo = 0, hi = last;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= time) lo = mid; else hi = mid; }
      j = lo;
    }
    this.index = j;
    const h = t[j + 1] - t[j];
    const s = (time - t[j]) / h, s2 = s * s, s3 = s2 * s;
    const h00 = 2 * s3 - 3 * s2 + 1, h10 = s3 - 2 * s2 + s, h01 = -2 * s3 + 3 * s2, h11 = s3 - s2;
    for (let i = 0; i < n; i++) {
      out[i] = h00 * y[j * n + i] + h10 * h * f[j * n + i] + h01 * y[(j + 1) * n + i] + h11 * h * f[(j + 1) * n + i];
    }
  }
}
