// Effective-one-body (EOB) dynamics and factorized multipolar waveform for
// quasi-circular binaries with spins aligned with the orbital angular momentum.
//
// Conservative dynamics: the TEOBResumS Hamiltonian as written in Rettegno et al.,
// Phys. Rev. D 101, 104027 (2020) [arXiv:1911.10818], Eqs. (17)-(41):
//   H_eff = sqrt(p_r*^2 + A (1 + p_phi^2 u_c^2 + 2 nu (4 - 3 nu) p_r*^4 u_c^2))
//           + p_phi (G_S S + G_S* S*),
// with the 5PN Pade(1,5) A potential (NR-informed a6^c), the Pade(0,3) D potential,
// the NLO spin-spin centrifugal radius r_c and NNLO gyro-gravitomagnetic ratios
// with the NR-informed c3. Radiation reaction: the factorized and resummed flux of
// Damour, Iyer & Nagar, Phys. Rev. D 79, 064004 (2009), summed over l <= 4,
// with the leading spin-orbit terms of rho_22 and f_21 (Pan et al. 2011).
// Units: G = c = M = 1, time in M; p_phi and p_r* are reduced by mu M and mu.

import type { BinaryMasses } from './remnant';

const EULER = 0.5772156649015329;
const LN2 = Math.LN2;
const PI = Math.PI;
const R0 = 2 / Math.sqrt(Math.E); // tail-factor scale (Fujita & Iyer 2010)

export interface EobDerivatives {
  r: number; uc: number; A: number; D: number;
  Hreal: number; // E = H_real / M
  Heff: number;
  Omega: number;
  rdot: number; prsDot: number; pphiDot: number;
}

/** A complex mode value and its ingredients at one dynamical state. */
export interface ModeSample { amp: number; phase: number }

export interface ModeSpec { l: number; m: number }

/** All modes kept in flux and waveforms, (l, m > 0); m < 0 follow from reflection symmetry. */
export const FLUX_MODES: ModeSpec[] = [
  { l: 2, m: 2 }, { l: 2, m: 1 }, { l: 3, m: 3 }, { l: 3, m: 2 }, { l: 3, m: 1 },
  { l: 4, m: 4 }, { l: 4, m: 3 }, { l: 4, m: 2 }, { l: 4, m: 1 }
];

function eulerlog(m: number, x: number): number {
  return EULER + LN2 + 0.5 * Math.log(x) + Math.log(m);
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

// Argument of Gamma(z) for Re z > 0.5 via the Lanczos approximation (g = 7, n = 9).
const LANCZOS = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

function logGammaImag(re: number, im: number): number {
  // ln Gamma(z) = 0.5 ln(2 pi) + (z - 0.5) ln(t) - t + ln(x), z -> z - 1.
  const zr = re - 1, zi = im;
  let xr = LANCZOS[0], xi = 0;
  for (let k = 1; k < 9; k++) {
    const dr = zr + k, di = zi;
    const d = dr * dr + di * di;
    xr += LANCZOS[k] * dr / d;
    xi -= LANCZOS[k] * di / d;
  }
  const tr = zr + 7.5, ti = zi;
  const lnTr = 0.5 * Math.log(tr * tr + ti * ti), lnTi = Math.atan2(ti, tr);
  // (z + 0.5) ln t with z = zr + i zi (shifted form uses z - 1 + 0.5)
  const ar = zr + 0.5, ai = zi;
  const imag = ar * lnTi + ai * lnTr - ti + Math.atan2(xi, xr);
  return imag;
}

/** Solve a small dense linear system in place (partial pivoting). */
function solveLinear(a: number[][], b: number[]): number[] | null {
  const n = b.length;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r;
    if (Math.abs(a[p][c]) < 1e-300) return null;
    [a[c], a[p]] = [a[p], a[c]];
    [b[c], b[p]] = [b[p], b[c]];
    for (let r = c + 1; r < n; r++) {
      const f = a[r][c] / a[c][c];
      for (let k = c; k < n; k++) a[r][k] -= f * a[c][k];
      b[r] -= f * b[c];
    }
  }
  const x = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r];
    for (let k = r + 1; k < n; k++) s -= a[r][k] * x[k];
    x[r] = s / a[r][r];
  }
  return x;
}

export class EobModel {
  readonly nu: number;
  readonly X1: number;
  readonly X2: number;
  readonly chi1: number;
  readonly chi2: number;
  readonly delta: number;
  readonly chiS: number;
  readonly chiA: number;
  /** S = (S1 + S2)/M^2 and S* = (m2/m1 S1 + m1/m2 S2)/M^2. */
  readonly S: number;
  readonly Sstar: number;
  private readonly a0: number;
  private readonly da2: number;
  private readonly cS: number[];
  private readonly cSs: number[];
  // A_orb(u_c) and dA_orb/du_c on a uniform grid; Pade(1,5) evaluated once.
  private readonly tableStep = 1 / 4096;
  private readonly aTable: Float64Array;
  private readonly daTable: Float64Array;
  /** Largest u_c at which the resummed potential is regular. */
  readonly uMax: number;

  constructor(masses: BinaryMasses) {
    const { X1, X2, chi1, chi2 } = masses;
    this.X1 = X1; this.X2 = X2; this.chi1 = chi1; this.chi2 = chi2;
    const nu = this.nu = X1 * X2;
    this.delta = X1 - X2;
    this.chiS = 0.5 * (chi1 + chi2);
    this.chiA = 0.5 * (chi1 - chi2);
    this.S = X1 * X1 * chi1 + X2 * X2 * chi2;
    this.Sstar = X1 * X2 * (chi1 + chi2);
    const a1 = X1 * chi1, a2 = X2 * chi2;
    this.a0 = a1 + a2;
    const a12 = a1 - a2, X12 = X1 - X2;
    this.da2 = -(9 * this.a0 * this.a0 + (1 + 4 * nu) * a12 * a12 - 10 * X12 * this.a0 * a12) / 8;
    // NR-informed next-to-next-to-next-to-leading-order spin-orbit parameter.
    const c3 = 43.371638 * (1 - 1.174839 * this.a0 + 0.354064 * this.a0 * this.a0) / (1 - 0.151961 * this.a0)
      + (929.579 * nu - 9178.87 * nu * nu + 23632.3 * nu ** 3) * this.a0 * X12 - 104.891 * a12 * nu * nu;
    // [c10, c20, c30, c40, c02, c12, c04]
    this.cS = [5 / 16 * nu, 51 / 8 * nu + 41 / 256 * nu * nu, nu * c3, 0,
      27 / 16 * nu, 12 * nu - 49 / 128 * nu * nu, -5 / 16 * nu + 169 / 256 * nu * nu];
    this.cSs = [3 / 4 + nu / 2, 27 / 16 + 29 / 4 * nu + 3 / 8 * nu * nu, 135 / 32 + nu * c3, 2835 / 256,
      5 / 84 + 3 / 2 * nu, 4 + 11 * nu - 7 / 8 * nu * nu, 5 / 48 + 25 / 12 * nu + 3 / 8 * nu * nu];
    const n = Math.round(1 / this.tableStep) + 1;
    this.aTable = new Float64Array(n);
    this.daTable = new Float64Array(n);
    let uMax = 1;
    for (let i = 0; i < n; i++) {
      const u = i * this.tableStep;
      const value = this.aOrbitalExact(u);
      const h = 1e-5;
      const slope = u < 2 * h ? (this.aOrbitalExact(u + h) - value) / h
        : (8 * (this.aOrbitalExact(u + h) - this.aOrbitalExact(u - h)) -
           (this.aOrbitalExact(u + 2 * h) - this.aOrbitalExact(u - 2 * h))) / (12 * h);
      if (!Number.isFinite(value) || !Number.isFinite(slope) || (i > 0 && value > this.aTable[i - 1] + 1e-12 && u > 0.3)) {
        uMax = Math.min(uMax, (i - 1) * this.tableStep);
        for (let k = i; k < n; k++) { this.aTable[k] = this.aTable[i - 1]; this.daTable[k] = 0; }
        break;
      }
      this.aTable[i] = value;
      this.daTable[i] = slope;
    }
    this.uMax = uMax;
  }

  /** 5PN-accurate A_orb with NR-informed a6^c, resummed as a Pade(1,5) approximant. */
  private aOrbitalExact(u: number): number {
    const nu = this.nu;
    if (u < 1e-3) return 1 - 2 * u + 2 * nu * u ** 3;
    const lnu = Math.log(u);
    const a5c = nu * (2275 * PI * PI / 512 - 4237 / 60 + 128 / 5 * EULER + 256 / 5 * LN2) + nu * nu * (41 * PI * PI / 32 - 221 / 6);
    const a6c = 3097.3 * nu * nu - 1330.6 * nu + 81.38;
    const c = [1, -2, 0, 2 * nu, nu * (94 / 3 - 41 * PI * PI / 32), a5c + 64 / 5 * nu * lnu,
      nu * (a6c + (-7004 / 105 - 144 / 5 * nu) * lnu)];
    // Denominator coefficients d1..d5 cancel the u^2..u^6 terms of (1 + sum d_j u^j) A_T.
    const m: number[][] = [];
    const rhs: number[] = [];
    for (let k = 2; k <= 6; k++) {
      const row: number[] = [];
      for (let j = 1; j <= 5; j++) row.push(k - j >= 0 ? c[k - j] : 0);
      m.push(row);
      rhs.push(-c[k]);
    }
    const d = solveLinear(m, rhs);
    if (!d) return NaN;
    const n1 = c[1] + d[0];
    let den = 1, p = 1;
    for (let j = 0; j < 5; j++) { p *= u; den += d[j] * p; }
    if (den <= 0) return NaN;
    return (1 + n1 * u) / den;
  }

  /** Hermite interpolation of the tabulated A_orb and its derivative. */
  private aOrbital(u: number, out: { a: number; da: number }): void {
    const x = Math.min(u, this.uMax) / this.tableStep;
    const i = Math.min(this.aTable.length - 2, Math.max(0, Math.floor(x)));
    const f = x - i, h = this.tableStep;
    const y0 = this.aTable[i], y1 = this.aTable[i + 1];
    const m0 = this.daTable[i] * h, m1 = this.daTable[i + 1] * h;
    const f2 = f * f, f3 = f2 * f;
    out.a = (2 * f3 - 3 * f2 + 1) * y0 + (f3 - 2 * f2 + f) * m0 + (-2 * f3 + 3 * f2) * y1 + (f3 - f2) * m1;
    out.da = ((6 * f2 - 6 * f) * y0 + (3 * f2 - 4 * f + 1) * m0 + (-6 * f2 + 6 * f) * y1 + (3 * f2 - 2 * f) * m1) / h;
  }

  private readonly aScratch = { a: 0, da: 0 };

  /**
   * Hamiltonian and Hamilton's equations at (r, p_r*, p_phi). Writes into `out`
   * and returns false if the state left the domain of the potentials.
   */
  evaluate(r: number, prs: number, pphi: number, out: EobDerivatives): boolean {
    const nu = this.nu;
    const u = 1 / r;
    const rc2 = r * r + this.a0 * this.a0 * (1 + 2 * u) + this.da2 * u;
    if (!(rc2 > 0)) return false;
    const rc = Math.sqrt(rc2), uc = 1 / rc;
    if (uc > this.uMax) return false;
    const drc = (r - (this.a0 * this.a0 + 0.5 * this.da2) * u * u) / rc;
    const duc = -uc * uc * drc;
    this.aOrbital(uc, this.aScratch);
    const Ao = this.aScratch.a, dAo = this.aScratch.da;
    const ratio = (1 + 2 * uc) / (1 + 2 * u);
    const A = Ao * ratio;
    if (!(A > 0)) return false;
    const dA = ((dAo * (1 + 2 * uc) + 2 * Ao) * duc) / (1 + 2 * u) + Ao * (1 + 2 * uc) * 2 * u * u / ((1 + 2 * u) * (1 + 2 * u));
    const Do = 1 / (1 + 6 * nu * uc * uc + 2 * (26 - 3 * nu) * nu * uc ** 3);
    const D = (r * uc) * (r * uc) * Do;
    const qCoeff = 2 * nu * (4 - 3 * nu);
    const prs2 = prs * prs, prs4 = prs2 * prs2;
    const inner = 1 + pphi * pphi * uc * uc + qCoeff * prs4 * uc * uc;
    const horb2 = prs2 + A * inner;
    if (!(horb2 > 0)) return false;
    const Horb = Math.sqrt(horb2);
    const dHorb_dr = (dA * inner + A * (pphi * pphi + qCoeff * prs4) * 2 * uc * duc) / (2 * Horb);
    const dHorb_dpphi = A * pphi * uc * uc / Horb;
    const dHorb_dprs = (prs + 2 * A * qCoeff * prs2 * prs * uc * uc) / Horb;
    // Gyro-gravitomagnetic ratios with inverse-resummed NNLO corrections.
    const [c10, c20, c30, , c02, c12, c04] = this.cS;
    const BS = 1 + c10 * uc + c20 * uc * uc + c30 * uc ** 3 + c02 * prs2 + c12 * uc * prs2 + c04 * prs4;
    const dBS_dr = (c10 + 2 * c20 * uc + 3 * c30 * uc * uc + c12 * prs2) * duc;
    const dBS_dprs = 2 * c02 * prs + 2 * c12 * uc * prs + 4 * c04 * prs2 * prs;
    const GS0 = 2 * u * uc * uc;
    const GS = GS0 / BS;
    const dGS0 = 2 * (-u * u * uc * uc + 2 * u * uc * duc);
    const dGS_dr = dGS0 / BS - GS0 * dBS_dr / (BS * BS);
    const dGS_dprs = -GS0 * dBS_dprs / (BS * BS);
    const [s10, s20, s30, s40, s02, s12, s04] = this.cSs;
    const BSs = 1 + s10 * uc + s20 * uc * uc + s30 * uc ** 3 + s40 * uc ** 4 + s02 * prs2 + s12 * uc * prs2 + s04 * prs4;
    const dBSs_dr = (s10 + 2 * s20 * uc + 3 * s30 * uc * uc + 4 * s40 * uc ** 3 + s12 * prs2) * duc;
    const dBSs_dprs = 2 * s02 * prs + 2 * s12 * uc * prs + 4 * s04 * prs2 * prs;
    const GSs0 = 1.5 * uc ** 3;
    const GSs = GSs0 / BSs;
    const dGSs_dr = 4.5 * uc * uc * duc / BSs - GSs0 * dBSs_dr / (BSs * BSs);
    const dGSs_dprs = -GSs0 * dBSs_dprs / (BSs * BSs);
    const spinOrbit = GS * this.S + GSs * this.Sstar;
    const Heff = Horb + pphi * spinOrbit;
    const e2 = 1 + 2 * nu * (Heff - 1);
    if (!(e2 > 0)) return false;
    const E = Math.sqrt(e2);
    const dH_dr = dHorb_dr + pphi * (this.S * dGS_dr + this.Sstar * dGSs_dr);
    const dH_dprs = dHorb_dprs + pphi * (this.S * dGS_dprs + this.Sstar * dGSs_dprs);
    const dH_dpphi = dHorb_dpphi + spinOrbit;
    const tortoise = A / Math.sqrt(D);
    out.r = r; out.uc = uc; out.A = A; out.D = D;
    out.Heff = Heff; out.Hreal = E;
    out.Omega = dH_dpphi / E;
    out.rdot = tortoise * dH_dprs / E;
    out.prsDot = -tortoise * dH_dr / E;
    out.pphiDot = 0;
    return true;
  }

  /** dH_eff/dr at p_r* = 0, used to find circular orbits. */
  private radialForce(r: number, pphi: number, scratch: EobDerivatives): number {
    if (!this.evaluate(r, 0, pphi, scratch)) return NaN;
    return -scratch.prsDot;
  }

  /** Angular momentum of the circular orbit at radius r (dH/dr = 0 at p_r* = 0). */
  circularPphi(r: number, guess?: number): number {
    const scratch = {} as EobDerivatives;
    let p0 = guess ?? Math.sqrt(r) * (1 + 1.5 / r);
    let f0 = this.radialForce(r, p0, scratch);
    let p1 = p0 * 1.01;
    for (let k = 0; k < 60; k++) {
      const f1 = this.radialForce(r, p1, scratch);
      if (!Number.isFinite(f1)) return NaN;
      if (f1 === f0) break;
      const next = p1 - f1 * (p1 - p0) / (f1 - f0);
      p0 = p1; f0 = f1; p1 = next;
      if (Math.abs(p1 - p0) < 1e-13 * Math.abs(p1)) break;
    }
    return p1;
  }

  /**
   * Factorized multipolar amplitude |h_lm| (r h / M) and phase, Damour, Iyer &
   * Nagar (2009), with the leading spin-orbit terms. `phi` is the orbital phase.
   */
  mode(l: number, m: number, state: EobDerivatives, pphi: number, phi: number, vPhi: number): ModeSample {
    const nu = this.nu, Omega = state.Omega;
    const v = Math.cbrt(Omega), x = v * v;
    const even = (l + m) % 2 === 0;
    const source = even ? state.Heff : pphi * v;
    const khat = state.Hreal * m * Omega;
    // |T_lm| and arg T_lm.
    let product = 1;
    for (let s = 1; s <= l; s++) product *= s * s + 4 * khat * khat;
    const tail2 = product / (factorial(l) ** 2) * (khat > 1e-12 ? 4 * PI * khat / (1 - Math.exp(-4 * PI * khat)) : 1);
    const tailPhase = logGammaImag(l + 1, -2 * khat) + 2 * khat * Math.log(2 * m * Omega * R0);
    const y = Math.cbrt(state.Hreal * Omega) ** 2;
    const y15 = y * Math.sqrt(y);
    const nuX25 = nu * x * x * v;
    const d = this.delta, chiS = this.chiS, chiA = this.chiA;
    let newton = 0, power = 2, phaseOffset = 0, f = 1, residual = 0;
    const one3nu = 1 - 3 * nu;
    switch (`${l}${m}`) {
      case '22': {
        const el = eulerlog(2, x);
        const rho = 1 + (55 * nu / 84 - 43 / 42) * x - 2 / 3 * ((1 - nu) * chiS + d * chiA) * x * v
          + (19583 * nu * nu / 42336 - 33025 * nu / 21168 - 20555 / 10584) * x * x
          + (10620745 * nu ** 3 / 39118464 - 6292061 * nu * nu / 3259872 + 41 * PI * PI * nu / 192
            - 48993925 * nu / 9779616 - 428 / 105 * el + 1556919113 / 122245200) * x ** 3
          + (9202 / 2205 * el - 387216563023 / 160190110080) * x ** 4
          + (439877 / 55566 * el - 16094530514677 / 533967033600) * x ** 5;
        f = rho * rho;
        newton = 1;
        residual = 7 / 3 * y15 + 428 * PI / 105 * y15 * y15 - 24 * nuX25;
        break;
      }
      case '21': {
        const el = eulerlog(1, x);
        const rho = 1 + (23 * nu / 84 - 59 / 56) * x + (617 * nu * nu / 4704 - 10993 * nu / 14112 - 47009 / 56448) * x * x
          + (7613184941 / 2607897600 - 107 / 105 * el) * x ** 3
          + (6313 / 5880 * el - 1168617463883 / 911303737344) * x ** 4;
        // Mass-asymmetry and spin contributions, Pan et al. (2011).
        f = d * rho * rho - 1.5 * (chiA + d * chiS) * v;
        newton = 1 / 3;
        power = 3;
        phaseOffset = PI / 2;
        residual = 2 / 3 * y15 - 493 * nuX25 / 42;
        break;
      }
      case '33': {
        const el = eulerlog(3, x);
        const rho = 1 + (2 * nu / 3 - 7 / 6) * x + (149 * nu * nu / 330 - 1861 * nu / 990 - 6719 / 3960) * x * x
          + (3203101567 / 227026800 - 26 / 7 * el) * x ** 3 + (13 / 3 * el - 57566572157 / 8562153600) * x ** 4;
        f = d * rho ** 3;
        newton = 0.75 * Math.sqrt(15 / 14);
        power = 3;
        phaseOffset = -PI / 2;
        residual = 13 / 10 * y15 - 80897 * nuX25 / 2430;
        break;
      }
      case '32': {
        const el = eulerlog(2, x);
        const rho = 1 + (320 * nu * nu - 1115 * nu + 328) / (270 * (3 * nu - 1)) * x
          + (3085640 * nu ** 4 - 20338960 * nu ** 3 - 4725605 * nu * nu + 8050045 * nu - 1444528) / (1603800 * one3nu * one3nu) * x * x
          + (5849948554 / 940355325 - 104 / 63 * el) * x ** 3;
        f = one3nu * rho ** 3;
        newton = Math.sqrt(5 / 7) / 3;
        power = 4;
        residual = (10 + 33 * nu) / (15 * one3nu) * y15;
        break;
      }
      case '31': {
        const el = eulerlog(1, x);
        const rho = 1 + (-2 * nu / 9 - 13 / 18) * x + (-829 * nu * nu / 1782 - 1685 * nu / 1782 + 101 / 7128) * x * x
          + (11706720301 / 6129723600 - 26 / 63 * el) * x ** 3 + (169 / 567 * el + 2606097992581 / 4854741091200) * x ** 4;
        f = d * rho ** 3;
        newton = 1 / (12 * Math.sqrt(14));
        power = 3;
        phaseOffset = PI / 2;
        residual = 13 / 30 * y15 - 17 * nuX25 / 10;
        break;
      }
      case '44': {
        const el = eulerlog(4, x);
        const rho = 1 + (2625 * nu * nu - 5870 * nu + 1614) / (1320 * (3 * nu - 1)) * x
          + (1252563795 * nu ** 4 - 6733146000 * nu ** 3 - 313857376 * nu * nu + 2338945704 * nu - 511573572)
            / (317116800 * one3nu * one3nu) * x * x
          + (16600939332793 / 1098809712000 - 12568 / 3465 * el) * x ** 3;
        f = one3nu * rho ** 4;
        newton = 8 / 9 * Math.sqrt(5 / 7);
        power = 4;
        phaseOffset = PI;
        residual = (112 + 219 * nu) / (120 * one3nu) * y15;
        break;
      }
      case '43': {
        const rho = 1 + (160 * nu * nu - 547 * nu + 222) / (176 * (2 * nu - 1)) * x - 6894273 / 7047040 * x * x;
        f = d * (1 - 2 * nu) * rho ** 4;
        newton = 9 / (4 * Math.sqrt(70));
        power = 5;
        phaseOffset = PI / 2;
        residual = (486 + 4961 * nu) / (810 * (1 - 2 * nu)) * y15;
        break;
      }
      case '42': {
        const el = eulerlog(2, x);
        const rho = 1 + (285 * nu * nu - 3530 * nu + 1146) / (1320 * (3 * nu - 1)) * x
          + (-379526805 * nu ** 4 - 3047981160 * nu ** 3 + 1204388696 * nu * nu + 295834536 * nu - 114859044)
            / (317116800 * one3nu * one3nu) * x * x
          + (848238724511 / 219761942400 - 3142 / 3465 * el) * x ** 3;
        f = one3nu * rho ** 4;
        newton = Math.sqrt(5) / 63;
        power = 4;
        residual = 7 * (1 + 6 * nu) / (15 * one3nu) * y15;
        break;
      }
      case '41': {
        const rho = 1 + (288 * nu * nu - 1385 * nu + 602) / (528 * (2 * nu - 1)) * x - 7775491 / 21141120 * x * x;
        f = d * (1 - 2 * nu) * rho ** 4;
        newton = 1 / (84 * Math.sqrt(10));
        power = 5;
        phaseOffset = -PI / 2;
        residual = (2 + 507 * nu) / (10 * (1 - 2 * nu)) * y15;
        break;
      }
      default:
        return { amp: 0, phase: 0 };
    }
    const amplitude = 8 * Math.sqrt(PI / 5) * nu * newton * vPhi ** power * Math.abs(source) * Math.sqrt(tail2) * Math.abs(f);
    const phase = phaseOffset + (f < 0 ? PI : 0) - m * phi + tailPhase + residual;
    return { amp: amplitude, phase };
  }

  /**
   * Velocity in the Newtonian prefactor, v_phi = r_omega Omega with r_omega from
   * the circular-orbit Kepler relation of the resummed potential (Damour & Nagar 2007).
   */
  vPhi(state: EobDerivatives, pphi: number): number {
    const uc = state.uc;
    this.aOrbital(uc, this.aScratch);
    const Ao = this.aScratch.a, dAo_drc = -uc * uc * this.aScratch.da;
    if (!(dAo_drc > 0)) return Math.cbrt(state.Omega);
    const heffCirc = Math.sqrt(Ao * (1 + pphi * pphi * uc * uc));
    const psi = 2 * (1 + 2 * this.nu * (heffCirc - 1)) / ((1 / (uc * uc)) * dAo_drc);
    const rOmega = (1 / uc) * Math.cbrt(psi);
    return rOmega * state.Omega;
  }

  /** Energy flux in units of c^5/G (circular-orbit factorized resummation). */
  flux(state: EobDerivatives, pphi: number): number {
    const vPhi = this.vPhi(state, pphi);
    let sum = 0;
    for (const { l, m } of FLUX_MODES) {
      const { amp } = this.mode(l, m, state, pphi, 0, vPhi);
      const k = m * state.Omega;
      sum += k * k * amp * amp;
    }
    return sum / (8 * PI);
  }

  /** Right-hand side of the EOB equations, y = (r, phi, p_r*, p_phi). */
  rhs(y: Float64Array, dy: Float64Array, state: EobDerivatives): boolean {
    if (!this.evaluate(y[0], y[2], y[3], state)) return false;
    const F = this.flux(state, y[3]);
    dy[0] = state.rdot;
    dy[1] = state.Omega;
    dy[2] = state.prsDot;
    dy[3] = -F / (this.nu * state.Omega);
    state.pphiDot = dy[3];
    return Number.isFinite(dy[0] + dy[1] + dy[2] + dy[3]);
  }

  /**
   * Post-adiabatic initial data at r0: circular p_phi plus the radial momentum
   * that reproduces the adiabatic inspiral rate dr/dt = Fphi / (dj/dr).
   */
  initialState(r0: number): Float64Array {
    const j0 = this.circularPphi(r0);
    const h = 1e-4 * r0;
    const jp = this.circularPphi(r0 + h, j0), jm = this.circularPphi(r0 - h, j0);
    const djdr = (jp - jm) / (2 * h);
    const state = {} as EobDerivatives;
    this.evaluate(r0, 0, j0, state);
    const F = this.flux(state, j0);
    const fphi = -F / (this.nu * state.Omega);
    const rdot = fphi / djdr;
    // Invert dr/dt = (A/sqrt(D)) (1/E) dH_eff/dp_r* at small p_r* by secant iteration.
    let p0 = 0, p1 = rdot * state.Hreal * state.Heff * Math.sqrt(state.D) / state.A;
    const rate = (p: number) => { this.evaluate(r0, p, j0, state); return state.rdot - rdot; };
    let f0 = rate(p0);
    for (let k = 0; k < 30 && p1 !== p0; k++) {
      const f1 = rate(p1);
      if (f1 === f0) break;
      const next = p1 - f1 * (p1 - p0) / (f1 - f0);
      p0 = p1; f0 = f1; p1 = next;
      if (Math.abs(p1 - p0) < 1e-16) break;
    }
    return Float64Array.from([r0, 0, p1, j0]);
  }
}
