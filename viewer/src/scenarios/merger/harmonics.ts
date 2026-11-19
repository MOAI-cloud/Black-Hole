// Spin-weighted spherical harmonics, in the convention used by SXS and LALSuite:
// h+ - i hx = sum_lm h_lm  _{-2}Y_lm(theta, phi). Goldberg et al., J. Math. Phys.
// 8, 2155 (1967), written with half-angle powers so the poles stay regular.

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

function binomial(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  return factorial(n) / (factorial(k) * factorial(n - k));
}

/** Real and imaginary parts of sY_lm(theta, phi). */
export function spinWeightedY(s: number, l: number, m: number, theta: number, phi: number): [number, number] {
  if (l < Math.abs(s) || l < Math.abs(m)) return [0, 0];
  const norm = (m % 2 === 0 ? 1 : -1) * Math.sqrt(
    factorial(l + m) * factorial(l - m) * (2 * l + 1) / (4 * Math.PI * factorial(l + s) * factorial(l - s)));
  const sh = Math.sin(theta / 2), ch = Math.cos(theta / 2);
  let sum = 0;
  for (let r = 0; r <= l - s; r++) {
    const b = binomial(l - s, r) * binomial(l + s, r + s - m);
    if (b === 0) continue;
    const cotPower = 2 * r + s - m;
    const sign = (l - r - s) % 2 === 0 ? 1 : -1;
    sum += sign * b * sh ** (2 * l - cotPower) * ch ** cotPower;
  }
  const value = norm * sum;
  return [value * Math.cos(m * phi), value * Math.sin(m * phi)];
}
