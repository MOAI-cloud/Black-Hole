// Kerr quasi-normal modes of spin weight s = -2 from Leaver's continued-fraction
// method: E. W. Leaver, Proc. R. Soc. Lond. A 402, 285 (1985), in the notation of
// Berti, Cardoso & Starinets, Class. Quantum Grav. 26, 163001 (2009), Sec. 4.2.
// Leaver works in units 2M = 1 with time dependence exp(-i omega t). The radial
// and angular (spin-weighted spheroidal) continued fractions are solved together
// for omega and the separation constant A. Initial guesses come from the fits of
// Berti, Cardoso & Will, Phys. Rev. D 73, 064030 (2006), and the spin is reached
// by continuation from Schwarzschild when a direct solve does not converge.

/** Mode frequency in units of the remnant mass: M_f (omega - i gamma). */
export interface Qnm {
  /** Oscillation frequency M_f omega_R. */
  omega: number;
  /** Damping rate M_f omega_I = M_f / tau (positive). */
  gamma: number;
}

const S = -2;
const RADIAL_TERMS = 600;
const ANGULAR_TERMS = 60;

interface Root { wr: number; wi: number; ar: number; ai: number }

// Complex division helpers operate on scalars to keep the inner loops allocation free.
function angularResidual(ar: number, ai: number, wr: number, wi: number, a: number, m: number): [number, number] {
  const k1 = Math.abs(m - S) / 2, k2 = Math.abs(m + S) / 2;
  const cr = a * wr, ci = a * wi;
  const c2r = cr * cr - ci * ci, c2i = 2 * cr * ci;
  const kk = k1 + k2;
  const constR = kk * (kk + 1) - S * (S + 1) - c2r - ar - 2 * cr * (2 * k1 + S + 1);
  const constI = -c2i - ai - 2 * ci * (2 * k1 + S + 1);
  let tr = 0, ti = 0;
  for (let n = ANGULAR_TERMS; n >= 1; n--) {
    const br = n * (n - 1) + 2 * n * (kk + 1) - 4 * n * cr + constR;
    const bi = -4 * n * ci + constI;
    const alpha = -2 * n * (n + 2 * k1); // alpha_{n-1}
    const g = 2 * (n + kk + S);
    const nr = alpha * g * cr, ni = alpha * g * ci; // alpha_{n-1} gamma_n
    const dr = br - tr, di = bi - ti;
    const inv = 1 / (dr * dr + di * di);
    tr = (nr * dr + ni * di) * inv;
    ti = (ni * dr - nr * di) * inv;
  }
  return [constR - tr, constI - ti];
}

function radialResidual(wr: number, wi: number, ar: number, ai: number, a: number, m: number, overtone: number): [number, number] {
  const b = Math.sqrt(1 - 4 * a * a);
  // term = omega/2 - a m
  const tR = wr / 2 - a * m, tI = wi / 2;
  // (2i/b) term = (2/b)(i tR - tI)
  const twoI_R = -2 * tI / b, twoI_I = 2 * tR / b;
  // i omega
  const iwR = -wi, iwI = wr;
  const c0r = 1 - S - iwR - twoI_R, c0i = -iwI - twoI_I;
  const c1r = -4 + 2 * (2 + b) * iwR + 2 * twoI_R, c1i = 2 * (2 + b) * iwI + 2 * twoI_I;
  const c2r = S + 3 - 3 * iwR - twoI_R, c2i = -3 * iwI - twoI_I;
  // (4 omega + 2i)/b * term
  const fR = 4 * wr / b, fI = (4 * wi + 2) / b;
  const ftR = fR * tR - fI * tI, ftI = fR * tI + fI * tR;
  const w2r = wr * wr - wi * wi, w2i = 2 * wr * wi;
  const c3r = w2r * (4 + 2 * b - a * a) - 2 * a * m * wr - S - 1 + (2 + b) * iwR - ar + ftR;
  const c3i = w2i * (4 + 2 * b - a * a) - 2 * a * m * wi + (2 + b) * iwI - ai + ftI;
  const c4r = S + 1 - 2 * w2r - (2 * S + 3) * iwR - ftR;
  const c4i = -2 * w2i - (2 * S + 3) * iwI - ftI;
  const alpha = (n: number): [number, number] => [n * n + (c0r + 1) * n + c0r, (c0i) * n + c0i];
  const beta = (n: number): [number, number] => [-2 * n * n + (c1r + 2) * n + c3r, c1i * n + c3i];
  const gamma = (n: number): [number, number] => [n * n + (c2r - 3) * n + c4r - c2r + 2, c2i * n + c4i - c2i];
  // Tail: alpha_n gamma_{n+1} / (beta_{n+1} - alpha_{n+1} gamma_{n+2} / (...)).
  let tr = 0, ti = 0;
  for (let n = RADIAL_TERMS; n > overtone; n--) {
    const [a1r, a1i] = alpha(n - 1);
    const [g1r, g1i] = gamma(n);
    const nr = a1r * g1r - a1i * g1i, ni = a1r * g1i + a1i * g1r;
    const [b1r, b1i] = beta(n);
    const dr = b1r - tr, di = b1i - ti;
    const inv = 1 / (dr * dr + di * di);
    tr = (nr * dr + ni * di) * inv;
    ti = (ni * dr - nr * di) * inv;
  }
  // Leaver's n-th inversion places the n-th overtone at the most stable root.
  let [lr, li] = beta(0);
  for (let j = 1; j <= overtone; j++) {
    const [a0r, a0i] = alpha(j - 1);
    const [g0r, g0i] = gamma(j);
    const nr = a0r * g0r - a0i * g0i, ni = a0r * g0i + a0i * g0r;
    const inv = 1 / (lr * lr + li * li);
    const qr = (nr * lr + ni * li) * inv, qi = (ni * lr - nr * li) * inv;
    const [bjr, bji] = beta(j);
    lr = bjr - qr;
    li = bji - qi;
  }
  return [lr - tr, li - ti];
}

function secant(f: (xr: number, xi: number) => [number, number], x0r: number, x0i: number,
  x1r: number, x1i: number, tolerance: number, iterations: number): [number, number] | null {
  let [f0r, f0i] = f(x0r, x0i);
  for (let k = 0; k < iterations; k++) {
    const [f1r, f1i] = f(x1r, x1i);
    if (!Number.isFinite(f1r) || !Number.isFinite(f1i)) return null;
    const dfr = f1r - f0r, dfi = f1i - f0i;
    const den = dfr * dfr + dfi * dfi;
    if (den === 0) return [x1r, x1i];
    const dxr = x1r - x0r, dxi = x1i - x0i;
    // step = f1 * dx / df
    const pr = f1r * dxr - f1i * dxi, pi = f1r * dxi + f1i * dxr;
    const sr = (pr * dfr + pi * dfi) / den, si = (pi * dfr - pr * dfi) / den;
    x0r = x1r; x0i = x1i; f0r = f1r; f0i = f1i;
    x1r -= sr; x1i -= si;
    if (Math.hypot(sr, si) < tolerance * Math.max(1, Math.hypot(x1r, x1i))) return [x1r, x1i];
  }
  return null;
}

function solveAngular(wr: number, wi: number, a: number, m: number, guessR: number, guessI: number): [number, number] | null {
  return secant((xr, xi) => angularResidual(xr, xi, wr, wi, a, m), guessR, guessI, guessR + 1e-3, guessI + 1e-3, 1e-13, 60);
}

function solveMode(a: number, m: number, overtone: number, guess: Root): Root | null {
  let angle: [number, number] = [guess.ar, guess.ai];
  const residual = (wr: number, wi: number): [number, number] => {
    const found = solveAngular(wr, wi, a, m, angle[0], angle[1]);
    if (!found) return [NaN, NaN];
    angle = found;
    return radialResidual(wr, wi, found[0], found[1], a, m, overtone);
  };
  const omega = secant(residual, guess.wr, guess.wi, guess.wr * (1 + 1e-4) + 1e-5, guess.wi * (1 + 1e-4), 1e-12, 80);
  if (!omega || !(omega[1] < 0)) return null;
  const final = solveAngular(omega[0], omega[1], a, m, angle[0], angle[1]);
  if (!final) return null;
  return { wr: omega[0], wi: omega[1], ar: final[0], ai: final[1] };
}

// Berti, Cardoso & Will (2006) Table VIII fits: M omega = f1 + f2 (1-j)^f3, Q = q1 + q2 (1-j)^q3.
const FITS: Record<string, [number, number, number, number, number, number]> = {
  '2,2,0': [1.5251, -1.1568, 0.1292, 0.7000, 1.4187, -0.4990],
  '2,2,1': [1.3673, -1.0260, 0.1628, 0.1000, 0.5436, -0.4731],
  '2,2,2': [1.3223, -1.0257, 0.1860, -0.1000, 0.4206, -0.4256],
  '2,1,0': [0.6000, -0.2339, 0.4175, -0.3000, 2.3561, -0.2277],
  '3,3,0': [1.8956, -1.3043, 0.1818, 0.9000, 2.3430, -0.4810],
  '3,3,1': [1.8566, -1.2818, 0.1934, 0.4000, 1.4544, -0.4908],
  '4,4,0': [2.3000, -1.5056, 0.2244, 1.1929, 3.1191, -0.4825],
};

/** Berti–Cardoso–Will fit, accurate to a few per cent; also used as a starting guess. */
export function qnmFit(l: number, m: number, n: number, chi: number): Qnm {
  const f = FITS[`${l},${m},${n}`] ?? FITS['2,2,0'];
  const j = Math.min(0.9999, Math.max(0, chi));
  const omega = f[0] + f[1] * Math.pow(1 - j, f[2]);
  const quality = f[3] + f[4] * Math.pow(1 - j, f[5]);
  return { omega, gamma: omega / (2 * quality) };
}

// Exact Schwarzschild values (Leaver 1985) anchor the continuation.
const SCHWARZSCHILD: Record<string, [number, number]> = {
  '2,0': [0.373671684418, 0.088962316257], '2,1': [0.346710996879, 0.273914875291],
  '2,2': [0.301053454612, 0.478276983223], '3,0': [0.599443288437, 0.092703047944],
  '3,1': [0.582643803033, 0.281298113435], '4,0': [0.809178420890, 0.094163997116],
};

const cache = new Map<string, Qnm>();

/**
 * Kerr QNM (l, m, n) for dimensionless remnant spin chi (|chi| < 1), in units of
 * the remnant mass. Negative chi is a remnant spinning against the orbit; the
 * prograde-orbit (m > 0) mode is then the black hole's counter-rotating mode.
 */
export function kerrQnm(l: number, m: number, n: number, chi: number): Qnm {
  const spin = Math.max(-0.995, Math.min(0.995, chi));
  const key = `${l},${m},${n},${spin.toFixed(5)}`;
  const cached = cache.get(key);
  if (cached) return cached;
  // Leaver: a in units of 2M = 1 is chi/2; Mw = omega_L / 2.
  const a = spin / 2;
  const anchor = SCHWARZSCHILD[`${l},${n}`];
  const startOmega = anchor ? [2 * anchor[0], -2 * anchor[1]] : (() => {
    const fit = qnmFit(l, m, n, 0);
    return [2 * fit.omega, -2 * fit.gamma];
  })();
  const sphere = l * (l + 1) - S * (S + 1);
  let root: Root | null = null;
  if (spin >= 0 && FITS[`${l},${m},${n}`]) {
    const fit = qnmFit(l, m, n, spin);
    root = solveMode(a, m, n, { wr: 2 * fit.omega, wi: -2 * fit.gamma, ar: sphere - spin * spin * 0.5, ai: 0 });
    if (root && Math.abs(root.wr / 2 - fit.omega) > 0.08 * fit.omega) root = null;
  }
  if (!root) {
    // Continuation in spin from Schwarzschild, refining the previous root.
    let current: Root = { wr: startOmega[0], wi: startOmega[1], ar: sphere, ai: 0 };
    const steps = Math.max(4, Math.ceil(Math.abs(spin) / 0.04));
    for (let k = 1; k <= steps; k++) {
      // Concentrate steps toward extremal spin, where the modes move fastest.
      const fraction = 1 - Math.pow(1 - k / steps, 1.6);
      const next = solveMode(a * fraction, m, n, current);
      if (!next) break;
      current = next;
      if (k === steps) root = next;
    }
  }
  const result: Qnm = root
    ? { omega: root.wr / 2, gamma: -root.wi / 2 }
    : qnmFit(l, m, n, Math.abs(spin));
  cache.set(key, result);
  return result;
}
