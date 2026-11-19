// Timelike Kerr geodesics in Boyer–Lindquist coordinates, G = c = M = 1.
//
// The separated equations are integrated in Mino time σ (dτ = Σ dσ) in
// second-order form, so radial and polar turning points need no sign logic:
//   (dr/dσ)² = R(r) = P² − Δ (r² + K),  P = E (r² + a²) − a L,
//   (dμ/dσ)² = M(μ) = (1 − μ²) Q − μ² [a² (1 − E²)(1 − μ²) + L²],  μ = cos θ,
//   dφ/dσ = a P / Δ − a E + L / (1 − μ²),
//   dt/dσ = (r² + a²) P / Δ − a (a E (1 − μ²) − L),
// with Carter's K = Q + (L − a E)². r(σ) and τ(σ) stay regular through the
// horizon while t and φ diverge there, which is the distant observer's
// "frozen" image of the infalling body.
//
// A small dust body is deformed by the geodesic-deviation (Jacobi) equation
// d²ξᵢ/dτ² = −Eᵢ ξᵢ with the equatorial Kerr tidal eigenvalues in Marck's
// parallel-propagated frame (exact for Schwarzschild; the 3K/r² terms carry
// the orbital and spin contributions):
//   E_radial = −(M/r³)(2 + 3K/r²),  E_orbital = (M/r³)(1 + 3K/r²),  E_polar = M/r³.

export interface InfallOptions {
  spin: number;
  /** Release radius in M. */
  radius: number;
  /** Release polar angle in degrees (90 = equatorial plane). */
  theta: number;
  /** Specific angular momentum as a fraction of the local circular-orbit value (0 = released from rest). */
  angularMomentum: number;
}

export interface InfallSample {
  t: number; tau: number; r: number; mu: number; phi: number;
  /** Contravariant four-velocity. */
  ut: number; ur: number; uth: number; uphi: number;
  /** Jacobi stretch factors of a dust body: radial, orbital, polar. */
  stretch: [number, number, number];
  /** Tidal eigenvalues (1/M²): radial, orbital, polar. */
  tidal: [number, number, number];
}

export interface InfallTrack {
  options: InfallOptions;
  E: number; L: number; Q: number; K: number;
  horizon: number;
  /** Angular velocity of the horizon, the late-time rotation of the frozen image. */
  horizonOmega: number;
  /** Surface gravity κ: outgoing light from the frozen body redshifts as e^(−κ t). */
  surfaceGravity: number;
  /** Samples outside the horizon, ordered in t. */
  outside: InfallSample[];
  /** Proper time and radius continued inside the horizon (t is not defined there). */
  inside: { tau: number; r: number }[];
  /** Proper time at which the body crosses the horizon. */
  crossingTau: number;
}

const horizonOf = (a: number) => 1 + Math.sqrt(Math.max(0, 1 - a * a));

function metricAt(r: number, mu: number, a: number) {
  const r2 = r * r, a2 = a * a, sin2 = Math.max(1e-12, 1 - mu * mu);
  const sigma = r2 + a2 * mu * mu;
  const delta = r2 - 2 * r + a2;
  const A = (r2 + a2) * (r2 + a2) - a2 * delta * sin2;
  return { r2, a2, sin2, sigma, delta, A };
}

/** E and L of a body released with angular momentum L relative to the local ZAMO, at rest in r and θ. */
function releaseConstants(o: InfallOptions) {
  const a = o.spin, r = o.radius, mu = Math.cos(o.theta * Math.PI / 180);
  const { sigma, delta, A, sin2 } = metricAt(r, mu, a);
  const alpha = Math.sqrt(sigma * delta / A), omega = 2 * a * r / A;
  const gphiphi = A * sin2 / sigma;
  // Circular prograde equatorial orbit for scale; the release keeps u^r = u^θ = 0.
  const sr = Math.sqrt(r);
  const circularL = (r * r - 2 * a * sr + a * a) / (r ** 0.75 * Math.sqrt(Math.max(1e-9, r * sr - 3 * sr + 2 * a)));
  const L = o.angularMomentum * circularL * Math.sqrt(sin2);
  // ZAMO-frame speed v = L / sqrt(g_φφ) / γ  →  γ = sqrt(1 + L² / g_φφ).
  const gamma = Math.sqrt(1 + L * L / gphiphi);
  const E = alpha * gamma + omega * L;
  const Q = mu * mu * (a * a * (1 - E * E) + L * L / sin2);
  return { E, L, Q, mu };
}

export function integrateInfall(options: InfallOptions, maxCoordinateTime = 400): InfallTrack {
  const a = options.spin, horizon = horizonOf(a);
  const { E, L, Q, mu: mu0 } = releaseConstants(options);
  const K = Q + (L - a * E) ** 2;
  const horizonOmega = a / (2 * horizon);
  const surfaceGravity = Math.sqrt(1 - a * a) / (2 * horizon);
  // State: r, dr/dσ, μ, dμ/dσ, φ, t, τ, and (J, dJ/dτ) for three axes.
  let state = [options.radius, 0, mu0, 0, 0, 0, 0, 1, 0, 1, 0, 1, 0];
  const derivative = (s: number[]) => {
    const [r, vr, mu, vmu] = s;
    const { a2, sin2, sigma, delta } = metricAt(r, mu, a);
    const P = E * (r * r + a2) - a * L;
    const accelR = 2 * E * r * P - (r - 1) * (r * r + K) - r * delta;
    const oneMinusE2 = 1 - E * E;
    const accelMu = -mu * (Q + L * L + a2 * oneMinusE2 * (1 - 2 * mu * mu));
    const dphi = a * P / delta - a * E + L / sin2;
    const dt = (r * r + a2) * P / delta - a * (a * E * sin2 - L);
    const m = 1 / (r * r * r), k = 3 * K / (r * r);
    const tidal = [-m * (2 + k), m * (1 + k), m];
    return [vr, accelR, vmu, accelMu, dphi, dt, sigma,
      sigma * s[8], -sigma * tidal[0] * s[7], sigma * s[10], -sigma * tidal[1] * s[9], sigma * s[12], -sigma * tidal[2] * s[11]];
  };
  const sampleOf = (s: number[]): InfallSample => {
    const [r, vr, mu, vmu, phi, t, tau] = s;
    const { a2, sin2, sigma, delta, A } = metricAt(r, mu, a);
    const P = E * (r * r + a2) - a * L;
    const ut = ((r * r + a2) * P / delta - a * (a * E * sin2 - L)) / sigma;
    const uphi = (a * P / delta - a * E + L / sin2) / sigma;
    const m = 1 / (r * r * r), k = 3 * K / (r * r);
    void A;
    return {
      t, tau, r, mu, phi, ut, ur: vr / sigma, uth: -vmu / Math.sqrt(sin2) / sigma, uphi,
      stretch: [s[7], s[9], s[11]], tidal: [-m * (2 + k), m * (1 + k), m]
    };
  };
  const outside: InfallSample[] = [sampleOf(state)];
  const rk4 = (s: number[], h: number) => {
    const k1 = derivative(s);
    const k2 = derivative(s.map((x, i) => x + 0.5 * h * k1[i]));
    const k3 = derivative(s.map((x, i) => x + 0.5 * h * k2[i]));
    const k4 = derivative(s.map((x, i) => x + h * k3[i]));
    return s.map((x, i) => x + h / 6 * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]));
  };
  // Outside: until the image is frozen (r − r+ < 10⁻⁵ r+) or t is large.
  for (let step = 0; step < 200000; step++) {
    const r = state[0], gap = r - horizon;
    if (gap < 1e-5 * horizon || state[5] > maxCoordinateTime) break;
    const d = derivative(state);
    // Bound the Mino step by fractional radius, coordinate time and the
    // remaining distance to the horizon.
    const h = Math.min(0.01 / (r * r), 0.25 / Math.max(1e-9, Math.abs(d[5])),
      d[0] < 0 ? 0.2 * gap / -d[0] : Infinity);
    const next = rk4(state, h);
    if (!next.every(Number.isFinite)) break;
    state = next;
    const last = outside[outside.length - 1];
    if (state[5] - last.t > 0.05 || Math.abs(state[0] - last.r) > 0.002 * state[0]) outside.push(sampleOf(state));
  }
  if (outside[outside.length - 1].t !== state[5]) outside.push(sampleOf(state));
  // Through the horizon: r(σ) and τ(σ) are regular where t and φ diverge.
  const inside: { tau: number; r: number }[] = [];
  let crossingTau = Infinity;
  let r = state[0], vr = state[1], tau = state[6];
  const mu2 = state[2] * state[2];
  const accel = (x: number) => {
    const delta = x * x - 2 * x + a * a, P = E * (x * x + a * a) - a * L;
    return 2 * E * x * P - (x - 1) * (x * x + K) - x * delta;
  };
  for (let step = 0; step < 400000 && r > horizon; step++) {
    const h = Math.min(2e-4 / (r * r), 0.05 * Math.abs(r - horizon) / Math.max(1e-9, Math.abs(vr)) + 1e-8);
    // Velocity Verlet in Mino time; proper time dτ = Σ dσ.
    const half = vr + 0.5 * h * accel(r);
    const nextR = r + h * half;
    const nextV = half + 0.5 * h * accel(nextR);
    const nextTau = tau + h * 0.5 * (r * r + nextR * nextR + 2 * a * a * mu2);
    if (nextR <= horizon) crossingTau = tau + (r - horizon) / (r - nextR) * (nextTau - tau);
    r = nextR; vr = nextV; tau = nextTau;
  }
  if (Number.isFinite(crossingTau)) {
    // Inside, r decreases monotonically to the singularity or an inner
    // turning point: τ = ∫ Σ / sqrt(R) dr by midpoint quadrature in r.
    const radial = (x: number) => {
      const delta = x * x - 2 * x + a * a, P = E * (x * x + a * a) - a * L;
      return P * P - delta * (x * x + K);
    };
    let x = horizon;
    tau = crossingTau;
    inside.push({ tau, r: x });
    while (x > 0.01) {
      const dx = Math.min(0.004 * x, x - 0.005);
      const mid = x - 0.5 * dx;
      const potential = radial(mid);
      if (!(potential > 1e-12)) break; // inner turning point (spinning holes)
      tau += (mid * mid + a * a * mu2) / Math.sqrt(potential) * dx;
      x -= dx;
      if (tau - inside[inside.length - 1].tau > 0.02 || x <= 0.01) inside.push({ tau, r: x });
    }
  }
  return { options, E, L, Q, K, horizon, horizonOmega, surfaceGravity, outside, inside, crossingTau };
}

/** Linear interpolation of the outside track at coordinate time t (frozen beyond its end). */
export function sampleAtTime(track: InfallTrack, t: number): InfallSample {
  const s = track.outside;
  if (t <= s[0].t) return s[0];
  const last = s[s.length - 1];
  if (t >= last.t) return { ...last, phi: last.phi + track.horizonOmega * (t - last.t), t };
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t <= t) lo = mid; else hi = mid;
  }
  const A = s[lo], B = s[hi], f = (t - A.t) / (B.t - A.t);
  const mix = (x: number, y: number) => x + f * (y - x);
  return {
    t, tau: mix(A.tau, B.tau), r: mix(A.r, B.r), mu: mix(A.mu, B.mu), phi: mix(A.phi, B.phi),
    ut: mix(A.ut, B.ut), ur: mix(A.ur, B.ur), uth: mix(A.uth, B.uth), uphi: mix(A.uphi, B.uphi),
    stretch: [mix(A.stretch[0], B.stretch[0]), mix(A.stretch[1], B.stretch[1]), mix(A.stretch[2], B.stretch[2])],
    tidal: [mix(A.tidal[0], B.tidal[0]), mix(A.tidal[1], B.tidal[1]), mix(A.tidal[2], B.tidal[2])]
  };
}

/** The outside sample at proper time τ (for an observer riding with the body). */
export function sampleAtProperTime(track: InfallTrack, tau: number): InfallSample {
  const s = track.outside;
  if (tau <= s[0].tau) return s[0];
  if (tau >= s[s.length - 1].tau) return s[s.length - 1];
  let lo = 0, hi = s.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (s[mid].tau <= tau) lo = mid; else hi = mid;
  }
  const f = (tau - s[lo].tau) / (s[hi].tau - s[lo].tau);
  return sampleAtTime(track, s[lo].t + f * (s[hi].t - s[lo].t));
}

/**
 * Frequency ratio received at infinity over emitted, for light leaving the body
 * along the outgoing principal null direction (k_t = −1, k_φ = a sin²θ,
 * k_r = (r² + a²)/Δ): g = 1 / (u^t − a sin²θ u^φ − (r² + a²)/Δ u^r).
 */
export function outgoingRedshift(track: InfallTrack, sample: InfallSample): number {
  const a = track.options.spin;
  const { sin2, delta } = metricAt(sample.r, sample.mu, a);
  return 1 / (sample.ut - a * sin2 * sample.uphi - (sample.r * sample.r + a * a) / delta * sample.ur);
}

/** Speed of the body relative to the local ZAMO and its world-space direction components. */
export function zamoVelocity(track: InfallTrack, sample: InfallSample) {
  const a = track.options.spin;
  const { sigma, delta, A, sin2 } = metricAt(sample.r, sample.mu, a);
  const alpha = Math.sqrt(sigma * delta / A), omega = 2 * a * sample.r / A;
  const gamma = alpha * sample.ut;
  const vr = Math.sqrt(sigma / delta) * sample.ur / gamma;
  const vth = Math.sqrt(sigma) * sample.uth / gamma;
  const vphi = Math.sqrt(A * sin2 / sigma) * (sample.uphi - omega * sample.ut) / gamma;
  return { gamma, vr, vth, vphi };
}
