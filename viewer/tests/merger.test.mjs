// Validation of the binary-black-hole merger physics against exact results,
// post-Newtonian limits and numerical-relativity (NR) benchmarks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const qnm = await loadTs('src/scenarios/merger/qnm.ts');
const harmonics = await loadTs('src/scenarios/merger/harmonics.ts');
const remnant = await loadTs('src/scenarios/merger/remnant.ts');
const eob = await loadTs('src/scenarios/merger/eob.ts');
const merger = await loadTs('src/scenarios/merger/merger.ts');
const waveform = await loadTs('src/scenarios/merger/waveform.ts');
const units = await loadTs('src/scenarios/merger/units.ts');

const close = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected} (±${tolerance})`);
const relative = (actual, expected, tolerance, label) =>
  assert.ok(Math.abs(actual / expected - 1) <= tolerance, `${label}: ${actual} vs ${expected} (±${100 * tolerance}%)`);

test('Leaver continued fractions reproduce exact Schwarzschild quasi-normal modes', () => {
  // Leaver (1985); Berti, Cardoso & Starinets (2009) tables.
  for (const [l, m, n, w, g] of [[2, 2, 0, 0.373672, 0.088962], [2, 2, 1, 0.346711, 0.273915],
    [3, 3, 0, 0.599443, 0.092703], [4, 4, 0, 0.809178, 0.094164], [2, 1, 0, 0.373672, 0.088962]]) {
    const mode = qnm.kerrQnm(l, m, n, 0);
    close(mode.omega, w, 2e-6, `Re omega ${l}${m}${n}`);
    close(mode.gamma, g, 2e-6, `Im omega ${l}${m}${n}`);
  }
});

test('Kerr quasi-normal modes match tabulated values and the Berti–Cardoso–Will fits', () => {
  // M omega_220 = 0.5326 - 0.0808i at a = 0.7 and 0.6716 - 0.0649i at a = 0.9 (Berti's tables).
  const a07 = qnm.kerrQnm(2, 2, 0, 0.7), a09 = qnm.kerrQnm(2, 2, 0, 0.9);
  close(a07.omega, 0.5326, 2e-4, 'a=0.7 omega');
  close(a07.gamma, 0.0808, 2e-4, 'a=0.7 gamma');
  close(a09.omega, 0.6716, 2e-4, 'a=0.9 omega');
  close(a09.gamma, 0.0649, 2e-4, 'a=0.9 gamma');
  for (const [l, m] of [[2, 2], [3, 3], [4, 4], [2, 1]]) {
    for (const chi of [0.3, 0.6, 0.8, 0.95]) {
      relative(qnm.kerrQnm(l, m, 0, chi).omega, qnm.qnmFit(l, m, 0, chi).omega, 0.025, `fit ${l}${m} chi=${chi}`);
    }
  }
  // A remnant spinning against the orbit rings at its (slower) counter-rotating frequency.
  assert.ok(qnm.kerrQnm(2, 2, 0, -0.5).omega < qnm.kerrQnm(2, 2, 0, 0).omega);
});

test('spin-weighted spherical harmonics have the standard closed forms and unit norm', () => {
  const [re, im] = harmonics.spinWeightedY(-2, 2, 2, 0.7, 0.3);
  const ref = Math.sqrt(5 / (64 * Math.PI)) * (1 + Math.cos(0.7)) ** 2;
  close(re, ref * Math.cos(0.6), 1e-12, '-2Y22 real');
  close(im, ref * Math.sin(0.6), 1e-12, '-2Y22 imag');
  for (const [l, m] of [[2, 1], [3, 3], [4, -2]]) {
    let sum = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const theta = (i + 0.5) * Math.PI / n;
      const [a, b] = harmonics.spinWeightedY(-2, l, m, theta, 0);
      sum += (a * a + b * b) * Math.sin(theta) * (Math.PI / n) * 2 * Math.PI;
    }
    close(sum, 1, 1e-4, `norm ${l}${m}`);
  }
});

test('remnant fits reproduce numerical-relativity final states', () => {
  const equal = { X1: 0.5, X2: 0.5, chi1: 0, chi2: 0 };
  // SXS:BBH:0001, Scheel et al. (2009): chi_f = 0.68646, M_f = 0.95162.
  close(remnant.finalSpin(equal), 0.68646, 1e-3, 'equal-mass final spin');
  close(1 - remnant.radiatedEnergy(equal), 0.95162, 1e-3, 'equal-mass final mass');
  // Campanelli, Lousto & Zlochower (2006) hang-up runs, S/m^2 = 0.757: a_f ~ 0.89 and 0.44.
  close(remnant.finalSpin({ ...equal, chi1: 0.757, chi2: 0.757 }), 0.89, 0.015, 'aligned');
  close(remnant.finalSpin({ ...equal, chi1: -0.757, chi2: -0.757 }), 0.44, 0.015, 'anti-aligned');
  // Kerr ISCO identities.
  close(remnant.iscoRadius(0), 6, 1e-12, 'Schwarzschild ISCO');
  close(remnant.iscoEnergy(0), Math.sqrt(8 / 9), 1e-12, 'Schwarzschild ISCO energy');
  // Non-spinning recoil peaks near 175 km/s around q = 3 (Gonzalez et al. 2007).
  const kick = remnant.recoilSpeed({ X1: 0.75, X2: 0.25, chi1: 0, chi2: 0 });
  close(kick, 175, 20, 'q=3 recoil');
});

test('EOB binding energy and flux agree with post-Newtonian theory at low frequency', () => {
  for (const q of [1, 4]) {
    const X1 = q / (1 + q), X2 = 1 / (1 + q), nu = X1 * X2;
    const model = new eob.EobModel({ X1, X2, chi1: 0, chi2: 0 });
    const state = {};
    const r = 60;
    const j = model.circularPphi(r);
    model.evaluate(r, 0, j, state);
    const x = Math.cbrt(state.Omega) ** 2;
    // 3PN binding energy (Blanchet, Living Rev. Rel. 17, 2 (2014), Eq. 233).
    const e3 = -0.5 * nu * x * (1 + (-0.75 - nu / 12) * x + (-27 / 8 + 19 / 8 * nu - nu * nu / 24) * x * x
      + (-675 / 64 + (34445 / 576 - 205 / 96 * Math.PI ** 2) * nu - 155 / 96 * nu * nu - 35 / 5184 * nu ** 3) * x ** 3);
    relative(state.Hreal - 1, e3, 2e-5, `binding energy q=${q}`);
    // 3.5PN energy flux (Blanchet 2014, Eq. 314) at r = 30.
    const j30 = model.circularPphi(30);
    model.evaluate(30, 0, j30, state);
    const y = Math.cbrt(state.Omega) ** 2, pi = Math.PI, g = 0.5772156649015329;
    const flux = 32 / 5 * nu * nu * y ** 5 * (1 + (-1247 / 336 - 35 / 12 * nu) * y + 4 * pi * y ** 1.5
      + (-44711 / 9072 + 9271 / 504 * nu + 65 / 18 * nu * nu) * y * y + (-8191 / 672 - 583 / 24 * nu) * pi * y ** 2.5
      + (6643739519 / 69854400 + 16 / 3 * pi * pi - 1712 / 105 * g - 856 / 105 * Math.log(16 * y)
        + (-134543 / 7776 + 41 / 48 * pi * pi) * nu - 94403 / 3024 * nu * nu - 775 / 324 * nu ** 3) * y ** 3
      + (-16285 / 504 + 214745 / 1728 * nu + 193385 / 3024 * nu * nu) * pi * y ** 3.5);
    relative(model.flux(state, j30), flux, 2e-3, `flux q=${q}`);
  }
});

test('EOB inspiral rate matches TaylorT4 3.5PN early in the inspiral', () => {
  const s = merger.solveMerger({ totalMass: 20, massRatio: 1, chi1: 0, chi2: 0, distance: 100 });
  const nu = 0.25, pi = Math.PI, g = 0.5772156649015329;
  // Find x = (M Omega)^(2/3) = 0.045 and measure dx/dt by central differences.
  let i = 1;
  while (Math.cbrt(s.omega[i]) ** 2 < 0.045) i++;
  const xs = [i - 1, i, i + 1].map(k => Math.cbrt(s.omega[k]) ** 2);
  const rate = (xs[2] - xs[0]) / (s.t[i + 1] - s.t[i - 1]);
  const x = xs[1];
  const t4 = 64 / 5 * nu * x ** 5 * (1 + (-743 / 336 - 11 / 4 * nu) * x + 4 * pi * x ** 1.5
    + (34103 / 18144 + 13661 / 2016 * nu + 59 / 18 * nu * nu) * x * x + (-4159 / 672 - 189 / 8 * nu) * pi * x ** 2.5
    + (16447322263 / 139708800 + 16 / 3 * pi * pi - 1712 / 105 * g - 856 / 105 * Math.log(16 * x)
      + (-56198689 / 217728 + 451 / 48 * pi * pi) * nu + 541 / 896 * nu * nu - 5605 / 2592 * nu ** 3) * x ** 3
    + (-4415 / 4032 + 358675 / 6048 * nu + 91495 / 1512 * nu * nu) * pi * x ** 3.5);
  relative(rate, t4, 0.015, 'dx/dt at x = 0.045');
});

test('equal-mass non-spinning merger reproduces NR peak, luminosity and energy', () => {
  const s = merger.solveMerger({ totalMass: 65, massRatio: 1, chi1: 0, chi2: 0, distance: 410 });
  // Healy & Lousto, PRD 97, 084002 (2018): A0 = 0.3937, W0 = 0.3587, N0 = 1.026e-3.
  relative(s.peak.amplitude, 0.3937, 0.005, 'peak |r h22|/M');
  relative(s.peak.frequency, 0.3587, 0.01, 'peak M omega22');
  relative(s.peak.luminosity, 1.026e-3, 0.05, 'peak luminosity (c^5/G)');
  // Energy balance: the integrated waveform flux against the NR fit (4.83% of M).
  relative(s.remnant.radiatedWaveform, s.remnant.radiatedFit, 0.04, 'radiated energy');
  close(s.remnant.spin, 0.6865, 2e-3, 'final spin');
  // Ringdown at the remnant's Kerr frequency, M_f omega = 0.5267 - 0.0813i at chi = 0.6865.
  close(s.remnant.qnm['22'].omega, 0.5267, 1e-3, 'QNM omega');
  close(s.remnant.qnm['22'].gamma, 0.0813, 5e-4, 'QNM gamma');
  // After the peak the (2,2) frequency approaches the quasi-normal frequency.
  const late = waveform.valueAt(s.t, s.frequency22, 60);
  relative(late, s.remnant.qnm['22'].omegaM, 0.02, 'late ringdown frequency');
  // Mirror symmetry: odd-m modes vanish for equal masses without spin.
  assert.ok(Math.max(...s.modes.find(m => m.l === 3 && m.m === 3).amp) < 1e-10);
});

test('a GW150914-like binary at 410 Mpc: chirp timing, cycles and strain', () => {
  const s = merger.solveMerger({ totalMass: 65, massRatio: 36 / 29, chi1: 0, chi2: 0, distance: 410 });
  close(s.redshift, 0.088, 0.004, 'redshift (Planck 2018)');
  // Independent TaylorT4 3.5PN integration from f22 = 35 Hz to x = 1/6.
  const nu = s.nu, pi = Math.PI, g = 0.5772156649015329;
  const rate = x => 64 / 5 * nu * x ** 5 * (1 + (-743 / 336 - 11 / 4 * nu) * x + 4 * pi * x ** 1.5
    + (34103 / 18144 + 13661 / 2016 * nu + 59 / 18 * nu * nu) * x * x + (-4159 / 672 - 189 / 8 * nu) * pi * x ** 2.5
    + (16447322263 / 139708800 + 16 / 3 * pi * pi - 1712 / 105 * g - 856 / 105 * Math.log(16 * x)
      + (-56198689 / 217728 + 451 / 48 * pi * pi) * nu + 541 / 896 * nu * nu - 5605 / 2592 * nu ** 3) * x ** 3
    + (-4415 / 4032 + 358675 / 6048 * nu + 91495 / 1512 * nu * nu) * pi * x ** 3.5);
  let x = (pi * 35 * s.secondsPerM) ** (2 / 3), elapsed = 0;
  const h = 0.05;
  while (x < 1 / 6) {
    const k1 = rate(x), k2 = rate(x + h / 2 * k1), k3 = rate(x + h / 2 * k2), k4 = rate(x + h * k3);
    x += h / 6 * (k1 + 2 * k2 + 2 * k3 + k4);
    elapsed += h;
  }
  let i = 0;
  while (s.frequency22[i] < 2 * pi * 35 * s.secondsPerM) i++;
  let k = i;
  while (Math.cbrt(s.omega[k]) ** 2 < 1 / 6) k++;
  relative(s.t[k] - s.t[i], elapsed, 0.05, 'EOB vs TaylorT4 time from 35 Hz to x = 1/6');
  // From 35 Hz to the peak: ~0.12 s, in line with "the signal sweeps upwards in frequency
  // from 35 to 250 Hz" over a fraction of a second (PRL 116, 061102).
  const duration = -s.t[i] * s.secondsPerM;
  assert.ok(duration > 0.1 && duration < 0.16, `time above 35 Hz: ${duration} s`);
  const omega150 = 2 * pi * 150 * s.secondsPerM;
  let j = i;
  while (s.frequency22[j] < omega150) j++;
  const cycles = (s.modes[0].phase[i] - s.modes[0].phase[j]) / (2 * pi);
  assert.ok(cycles > 5 && cycles < 9, `cycles 35-150 Hz: ${cycles}`);
  const { plus, cross } = waveform.polarizations(s, 0);
  let peak = 0;
  for (let n = 0; n < plus.length; n++) peak = Math.max(peak, Math.hypot(plus[n], cross[n]));
  assert.ok(peak > 0.7e-21 && peak < 2.5e-21, `face-on peak strain ${peak}`);
  const peakHz = s.peak.frequency / (2 * pi * s.secondsPerM);
  assert.ok(peakHz > 120 && peakHz < 200, `peak frequency ${peakHz} Hz`);
  assert.ok(s.elapsedMs < 400, `solve time ${s.elapsedMs} ms`);
});

test('unequal masses and spins follow the NR fits and show the orbital hang-up', () => {
  const q4 = merger.solveMerger({ totalMass: 60, massRatio: 4, chi1: 0, chi2: 0, distance: 400 });
  const fit4 = remnant.peakValues(q4.masses);
  relative(q4.peak.amplitude, fit4.amplitude, 0.01, 'q=4 peak amplitude');
  relative(q4.peak.frequency, fit4.frequency, 0.02, 'q=4 peak frequency');
  // Higher multipoles are not NR-calibrated: luminosity and energy carry larger errors.
  relative(q4.peak.luminosity, fit4.luminosity, 0.25, 'q=4 peak luminosity');
  relative(q4.remnant.radiatedWaveform, q4.remnant.radiatedFit, 0.15, 'q=4 radiated energy');
  assert.ok(Math.max(...q4.modes.find(m => m.l === 3 && m.m === 3).amp) > 0.03, 'q=4 excites (3,3)');
  const cycles = chi => {
    const s = merger.solveMerger({ totalMass: 60, massRatio: 1, chi1: chi, chi2: chi, distance: 400, minSeparation: 12 });
    return Math.abs(s.phi[waveform.sampleIndex(s.t, 0)] - s.phi[0]) / (2 * Math.PI);
  };
  const up = cycles(0.9), none = cycles(0), down = cycles(-0.9);
  assert.ok(up > none + 2 && none > down + 2, `orbits from 14 M: ${up}, ${none}, ${down}`);
  const spinning = merger.solveMerger({ totalMass: 60, massRatio: 1, chi1: 0.9, chi2: 0.9, distance: 400 });
  relative(spinning.peak.amplitude, spinning.peakFit.amplitude, 0.01, 'chi=0.9 peak amplitude');
  relative(spinning.peak.frequency, spinning.peakFit.frequency, 0.02, 'chi=0.9 peak frequency');
  relative(spinning.remnant.radiatedWaveform, spinning.remnant.radiatedFit, 0.2, 'chi=0.9 radiated energy');
});

test('polarizations: circular face-on, linear edge-on', () => {
  const s = merger.solveMerger({ totalMass: 65, massRatio: 1, chi1: 0, chi2: 0, distance: 410 });
  const i = waveform.sampleIndex(s.t, -400);
  const faceOn = waveform.polarizations(s, 0);
  relative(Math.hypot(faceOn.plus[i], faceOn.cross[i]), Math.hypot(faceOn.plus[i + 3], faceOn.cross[i + 3]), 0.01,
    'face-on envelope is smooth (circular polarization)');
  const edgeOn = waveform.polarizations(s, Math.PI / 2);
  let crossMax = 0, plusMax = 0;
  for (let n = 0; n < s.t.length; n++) { crossMax = Math.max(crossMax, Math.abs(edgeOn.cross[n])); plusMax = Math.max(plusMax, Math.abs(edgeOn.plus[n])); }
  assert.ok(crossMax < 1e-6 * plusMax, 'edge-on h_x vanishes');
  // Units: G M_sun / c^3 and the c^5/G luminosity scale.
  close(units.MSUN_SECONDS, 4.925491e-6, 1e-12, 'GM/c^3');
  relative(units.C5_OVER_G_WATTS, 3.628e52, 1e-3, 'c^5/G');
});
