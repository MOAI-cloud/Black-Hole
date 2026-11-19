// Physical units for the geometric (G = c = M = 1) simulation.
// SI constants: CODATA 2018 and IAU 2015 nominal values.
export const G = 6.6743e-11;
export const C = 299792458;
export const M_SUN = 1.98847e30;
export const GM_SUN = 1.32712440018e20;
export const SIGMA_SB = 5.670374419e-8;
export const M_PROTON = 1.67262192369e-27;
export const SIGMA_THOMSON = 6.6524587321e-29;
export const K_BOLTZMANN = 1.380649e-23;
export const AU = 1.495978707e11;
export const LIGHT_YEAR = 9.4607304725808e15;
export const PARSEC = 3.0856775814913673e16;
export const R_SUN = 6.957e8;
export const L_SUN = 3.828e26;
export const YEAR = 365.25 * 86400;

/** GM/c² in metres. */
export const gravitationalRadius = (solarMasses: number) => GM_SUN * solarMasses / (C * C);
/** GM/c³ in seconds. */
export const timeUnit = (solarMasses: number) => GM_SUN * solarMasses / (C * C * C);
/** Electron-scattering Eddington luminosity for ionized hydrogen, W. */
export const eddingtonLuminosity = (solarMasses: number) =>
  4 * Math.PI * GM_SUN * solarMasses * M_PROTON * C / SIGMA_THOMSON;

export function horizonRadius(spin: number): number {
  return 1 + Math.sqrt(Math.max(0, 1 - spin * spin));
}

export function iscoRadius(spin: number): number {
  const z1 = 1 + Math.cbrt(1 - spin * spin) * (Math.cbrt(1 + spin) + Math.cbrt(1 - spin));
  const z2 = Math.sqrt(3 * spin * spin + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

/** Specific energy, angular momentum and angular velocity of a prograde equatorial circular orbit. */
export function circularOrbit(r: number, spin: number) {
  const sr = Math.sqrt(r);
  const root = Math.sqrt(r * sr - 3 * sr + 2 * spin);
  const denominator = r ** 0.75 * root;
  return {
    E: (r * sr - 2 * sr + spin) / denominator,
    L: (r * r - 2 * spin * sr + spin * spin) / denominator,
    Omega: 1 / (r * sr + spin)
  };
}

/** Novikov–Thorne radiative efficiency 1 - E_ISCO. */
export function radiativeEfficiency(spin: number): number {
  return 1 - circularOrbit(iscoRadius(spin), spin).E;
}

/**
 * Page–Thorne surface flux of a Novikov–Thorne disk, in units of Ṁc²/r_g²,
 * F(r) = (1 / 4π r) (−dΩ/dr) / (E − ΩL)² ∫_{r_ISCO}^{r} (E − ΩL) dL.
 * Returns radii, flux and the peak.
 */
export function novikovThorneFlux(spin: number, outer = 400, samples = 4000) {
  const inner = iscoRadius(spin);
  const radii = new Float64Array(samples);
  const flux = new Float64Array(samples);
  let integral = 0, previous = circularOrbit(inner, spin), peak = 0, peakRadius = inner;
  radii[0] = inner;
  for (let i = 1; i < samples; i++) {
    const r = inner * (outer / inner) ** (i / (samples - 1));
    const orbit = circularOrbit(r, spin);
    const binding = orbit.E - orbit.Omega * orbit.L;
    const previousBinding = previous.E - previous.Omega * previous.L;
    // Trapezoidal Stieltjes integral in L avoids differentiating L(r).
    integral += 0.5 * (binding + previousBinding) * (orbit.L - previous.L);
    const sr = Math.sqrt(r);
    const dOmega = 1.5 * sr / (r * sr + spin) ** 2;
    radii[i] = r;
    flux[i] = dOmega * integral / (4 * Math.PI * r * binding * binding);
    if (flux[i] > peak) { peak = flux[i]; peakRadius = r; }
    previous = orbit;
  }
  return { radii, flux, peak, peakRadius };
}

/** Peak effective temperature (K) of a Novikov–Thorne disk at Eddington ratio λ. */
export function diskPeakTemperature(solarMasses: number, spin: number, eddingtonRatio: number): number {
  const rg = gravitationalRadius(solarMasses);
  const accretionPower = eddingtonRatio * eddingtonLuminosity(solarMasses) / radiativeEfficiency(spin);
  return (accretionPower * novikovThorneFlux(spin).peak / (rg * rg * SIGMA_SB)) ** 0.25;
}

/**
 * Spectral hardening of an electron-scattering atmosphere, T_color / T_eff,
 * following Done et al. (2012, MNRAS 420, 1848, eq. 1).
 */
export function colorCorrection(effectiveTemperature: number): number {
  if (effectiveTemperature < 3e4) return 1;
  if (effectiveTemperature < 1e5) return (effectiveTemperature / 3e4) ** 0.82;
  const kT = K_BOLTZMANN * effectiveTemperature / 1.602176634e-16; // keV
  return (72 / kT) ** (1 / 9);
}

/** Radial tidal acceleration difference across a body of length L (m) at radius r (in M). */
export function tidalAcceleration(solarMasses: number, r: number, length = 2): number {
  const rg = gravitationalRadius(solarMasses);
  return 2 * GM_SUN * solarMasses * length / (r * rg) ** 3;
}

/** Coordinate period of a prograde equatorial circular orbit, in M. */
export const orbitalPeriod = (r: number, spin: number) => 2 * Math.PI * (r ** 1.5 + spin);

const superscripts: Record<string, string> = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

export function scientific(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  const exponent = Math.floor(Math.log10(Math.abs(value)));
  if (exponent >= -2 && exponent <= 4) return value.toLocaleString('en-US', { maximumSignificantDigits: digits + 1 });
  const mantissa = value / 10 ** exponent;
  const power = String(exponent).split('').map(ch => superscripts[ch]).join('');
  return `${mantissa.toFixed(digits - 1 > 0 ? digits - 1 : 0)} × 10${power}`;
}

/** Human-readable duration from seconds. */
export function duration(seconds: number): string {
  const units: [number, string][] = [[YEAR, 'yr'], [86400, 'd'], [3600, 'h'], [60, 'min'], [1, 's'], [1e-3, 'ms'], [1e-6, 'µs']];
  const abs = Math.abs(seconds);
  for (const [size, label] of units) {
    if (abs >= size) {
      const value = seconds / size;
      return `${value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${label}`;
    }
  }
  return `${(seconds * 1e9).toPrecision(3)} ns`;
}

/** Human-readable length from metres. */
export function distance(metres: number): string {
  const abs = Math.abs(metres);
  if (abs >= 0.1 * LIGHT_YEAR) return `${scientific(metres / LIGHT_YEAR, 3)} ly`;
  if (abs >= 0.1 * AU) return `${scientific(metres / AU, 3)} AU`;
  if (abs >= 1e3) return `${scientific(metres / 1e3, 3)} km`;
  return `${scientific(metres, 3)} m`;
}
