// Numerical-relativity fits for the merger remnant and the (2,2) peak.
// Masses are labelled so that X1 = m1/M >= X2 = m2/M; spins are the
// dimensionless components along the orbital angular momentum.

/** Prograde equatorial ISCO radius of a Kerr black hole (Bardeen, Press & Teukolsky 1972). */
export function iscoRadius(a: number): number {
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sign(a || 1) * Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** Specific energy at the ISCO, E = sqrt(1 - 2/(3 r_ISCO)). */
export function iscoEnergy(a: number): number {
  return Math.sqrt(1 - 2 / (3 * iscoRadius(a)));
}

export interface BinaryMasses {
  X1: number;
  X2: number;
  chi1: number;
  chi2: number;
}

/**
 * Final spin, Rezzolla et al., ApJ 674, L29 (2008), Eq. (5) for aligned spins:
 * a_f = a~ + a~ nu (s4 a~ + s5 nu + t0) + nu (2 sqrt3 + t2 nu + t3 nu^2),
 * a~ = (a1 + a2 q^2)/(1 + q^2), q = m2/m1 <= 1.
 */
export function finalSpin({ X1, X2, chi1, chi2 }: BinaryMasses): number {
  const nu = X1 * X2;
  const q = X2 / X1;
  const at = (chi1 + chi2 * q * q) / (1 + q * q);
  const s4 = -0.1229, s5 = 0.4537, t0 = -2.8904, t2 = -3.5171, t3 = 2.5763;
  const af = at + at * nu * (s4 * at + s5 * nu + t0) + nu * (2 * Math.sqrt(3) + t2 * nu + t3 * nu * nu);
  return Math.max(-0.998, Math.min(0.998, af));
}

/**
 * Radiated energy in units of M, Barausse, Morozova & Rezzolla, ApJ 758, 63 (2012),
 * Eq. (18): E/M = [1 - E_ISCO(a~)] nu + 4 nu^2 [4 p0 + 16 p1 a~(a~+1) + E_ISCO(a~) - 1],
 * a~ = (a1 + a2 q^2)/(1 + q)^2, p0 = 0.04827, p1 = 0.01707.
 */
export function radiatedEnergy({ X1, X2, chi1, chi2 }: BinaryMasses): number {
  const nu = X1 * X2;
  const q = X2 / X1;
  const at = (chi1 + chi2 * q * q) / ((1 + q) * (1 + q));
  const e = iscoEnergy(at);
  return (1 - e) * nu + 4 * nu * nu * (4 * 0.04827 + 16 * 0.01707 * at * (at + 1) + e - 1);
}

// Healy & Lousto, Phys. Rev. D 97, 084002 (2018): 4th-order expansion in the
// RIT variables. The odd terms pair delta-m with Delta-tilde, so the result is
// independent of which body is labelled 1.
type Coefficients = [number, number, number, number, number, number, number, number, number, number,
  number, number, number, number, number, number, number, number, number];

function ritExpansion(c: Coefficients, S: number, D: number, dm: number): number {
  const [q0, q1, q2a, q2b, q2c, q2d, q3a, q3b, q3c, q3d, q4a, q4b, q4c, q4d, q4e, q4f, q4g, q4h, q4i] = c;
  return q0 + q1 * S + q2a * D * dm + q2b * S * S + q2c * D * D + q2d * dm * dm
    + q3a * D * S * dm + q3b * S * D * D + q3c * S * S * S + q3d * S * dm * dm
    + q4a * D * S * S * dm + q4b * D * D * D * dm + q4c * D ** 4 + q4d * S ** 4 + q4e * D * D * S * S
    + q4f * dm ** 4 + q4g * D * dm ** 3 + q4h * D * D * dm * dm + q4i * S * S * dm * dm;
}

const PEAK_LUMINOSITY: Coefficients = [1.026e-3, 8.839321e-4, 1.076865e-4, 6.882092e-4, -1.342443e-5, -4.092e-4,
  -1.659899e-4, 5.383661e-4, 1.238655e-3, -5.363013e-4, 9.409468e-4, 3.479228e-4, 8.235426e-6, 1.780791e-3,
  1.020294e-3, 2.422e-4, -7.775870e-4, -5.165251e-4, -1.357834e-3];
const PEAK_AMPLITUDE: Coefficients = [0.3937, -0.00252, 0.00385, 0.00495, -0.00145, -0.0526, 0.00331, 0.01775,
  0.03202, 0.05267, 0.11029, -0.00552, 0.00558, 0.04593, -0.04754, 0.0179, -0.00516, 0.00163, -0.02098];
const PEAK_FREQUENCY: Coefficients = [0.3587, 0.14189, -0.01461, 0.05505, 0.00878, -0.1211, -0.16841, 0.04874,
  0.09181, -0.08607, -0.02185, 0.11183, -0.01704, 0.21595, -0.12378, 0.0432, 0.00167, -0.13224, -0.09933];

function ritVariables({ X1, X2, chi1, chi2 }: BinaryMasses) {
  return {
    eta: X1 * X2,
    dm: X1 - X2,
    S: X1 * X1 * chi1 + X2 * X2 * chi2,
    D: X2 * chi2 - X1 * chi1
  };
}

export interface PeakValues {
  /** max |r h22| / M */
  amplitude: number;
  /** M omega22 at the amplitude peak */
  frequency: number;
  /** Peak luminosity in units of c^5/G */
  luminosity: number;
}

export function peakValues(masses: BinaryMasses): PeakValues {
  const { eta, dm, S, D } = ritVariables(masses);
  return {
    amplitude: 4 * eta * ritExpansion(PEAK_AMPLITUDE, S, D, dm),
    frequency: ritExpansion(PEAK_FREQUENCY, S, D, dm),
    luminosity: 16 * eta * eta * ritExpansion(PEAK_LUMINOSITY, S, D, dm)
  };
}

/**
 * Recoil speed in km/s for aligned spins. Mass-asymmetry part: Healy & Lousto
 * (2018), v_m = eta^2 dm (A + B dm^2 + C dm^4). Spin part: Campanelli, Lousto,
 * Zlochower & Merritt, ApJ 659, L5 (2007), v_perp = H eta^2 Delta-tilde, at the
 * Healy & Lousto (2018) angle xi = a + b S + c dm Delta.
 */
export function recoilSpeed(masses: BinaryMasses): number {
  const { eta, dm, S, D } = ritVariables(masses);
  const vm = eta * eta * dm * (-8712 - 6516 * dm * dm + 3907 * dm ** 4);
  const vPerp = 7.0e3 * eta * eta * D;
  const xi = 2.489240 + 1.428658 * S + 0.558505 * dm * D;
  return Math.sqrt(Math.max(0, vm * vm + vPerp * vPerp + 2 * vm * vPerp * Math.cos(xi)));
}

export interface Remnant {
  /** Final mass in units of the initial total mass M. */
  mass: number;
  /** Dimensionless final spin along the orbital angular momentum. */
  spin: number;
  /** Radiated energy in units of M. */
  radiated: number;
  /** Recoil speed in km/s. */
  kick: number;
}

export function remnant(masses: BinaryMasses): Remnant {
  const radiated = radiatedEnergy(masses);
  return { mass: 1 - radiated, spin: finalSpin(masses), radiated, kick: recoilSpeed(masses) };
}
