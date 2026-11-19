// Physical constants (CODATA 2018 / IAU 2015 nominal values) and cosmology.

/** G M_sun / c^3 in seconds. */
export const MSUN_SECONDS = 4.925490947641267e-6;
/** G M_sun / c^2 in metres. */
export const MSUN_METRES = 1476.6250385063112;
/** M_sun c^2 in joules. */
export const MSUN_JOULES = 1.78709e47;
/** c^5 / G in watts: the natural unit of gravitational-wave luminosity. */
export const C5_OVER_G_WATTS = 3.6282542e52;
/** One megaparsec in metres. */
export const MPC_METRES = 3.0856775814913673e22;
/** Speed of light in km/s. */
export const C_KMS = 299792.458;

// Flat Lambda-CDM, Planck 2018 (TT,TE,EE+lowE+lensing+BAO).
const H0 = 67.66; // km/s/Mpc
const OMEGA_M = 0.30966;
const HUBBLE_DISTANCE = C_KMS / H0; // Mpc

function comovingDistance(z: number): number {
  // Composite Simpson rule; the integrand is smooth and z stays below ~10.
  const n = 256;
  const h = z / n;
  let sum = 0;
  for (let i = 0; i <= n; i++) {
    const x = i * h;
    const e = 1 / Math.sqrt(OMEGA_M * (1 + x) ** 3 + 1 - OMEGA_M);
    sum += e * (i === 0 || i === n ? 1 : i % 2 ? 4 : 2);
  }
  return HUBBLE_DISTANCE * sum * h / 3;
}

/** Luminosity distance in Mpc for redshift z. */
export function luminosityDistance(z: number): number {
  return (1 + z) * comovingDistance(z);
}

/** Cosmological redshift for a luminosity distance in Mpc (Newton iteration). */
export function redshiftForDistance(distanceMpc: number): number {
  if (!(distanceMpc > 0)) return 0;
  let z = distanceMpc / HUBBLE_DISTANCE;
  for (let i = 0; i < 40; i++) {
    const d = luminosityDistance(z) - distanceMpc;
    const dz = 1e-5 * Math.max(1, z);
    const slope = (luminosityDistance(z + dz) - luminosityDistance(z)) / dz;
    const next = Math.max(0, z - d / slope);
    if (Math.abs(next - z) < 1e-12 * Math.max(1, z)) return next;
    z = next;
  }
  return z;
}
