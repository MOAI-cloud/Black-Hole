// Equatorial prograde circular orbits, in units G = c = M = 1.
export function kerrRadii(spin: number): { horizon: number; isco: number } {
  const horizon = 1 + Math.sqrt(1 - spin * spin);
  const z1 = 1 + Math.cbrt(1 - spin * spin) * (Math.cbrt(1 + spin) + Math.cbrt(1 - spin));
  const z2 = Math.sqrt(3 * spin * spin + z1 * z1);
  return { horizon, isco: 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2)) };
}
