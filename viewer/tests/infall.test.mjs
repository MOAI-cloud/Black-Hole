import test from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './load-ts.mjs';

const physics = await loadTs('src/scenarios/infall/geodesic.ts');

test('Schwarzschild radial infall reaches the horizon at the analytic proper time', () => {
  const track = physics.integrateInfall({ spin: 0, radius: 12, theta: 90, angularMomentum: 0 });
  // τ(r) = sqrt(r0³/2M) [sqrt(x(1−x)) + arccos(sqrt x)], x = r/r0.
  const x = 2 / 12;
  const expected = Math.sqrt(12 ** 3 / 2) * (Math.sqrt(x * (1 - x)) + Math.acos(Math.sqrt(x)));
  assert.ok(Math.abs(track.crossingTau - expected) < 1e-3, `${track.crossingTau} vs ${expected}`);
  // From rest, the singularity follows at (π/2) sqrt(r0³/2M).
  const last = track.inside[track.inside.length - 1];
  assert.ok(last.r < 0.05, `inside ends at r = ${last.r}, τ = ${last.tau}`);
  assert.ok(Math.abs(last.tau - Math.PI / 2 * Math.sqrt(12 ** 3 / 2)) < 0.05, `${last.tau}`);
});

test('four-velocity stays normalized along a Kerr plunge', () => {
  const a = 0.9;
  const track = physics.integrateInfall({ spin: a, radius: 10, theta: 70, angularMomentum: 0.6 });
  for (const s of track.outside.filter((_, i) => i % 25 === 0)) {
    const r2 = s.r * s.r, sin2 = 1 - s.mu * s.mu, sigma = r2 + a * a * s.mu * s.mu, delta = r2 - 2 * s.r + a * a;
    const gtt = -(1 - 2 * s.r / sigma), gtp = -2 * a * s.r * sin2 / sigma;
    const gpp = (r2 + a * a + 2 * a * a * s.r * sin2 / sigma) * sin2;
    const norm = gtt * s.ut * s.ut + 2 * gtp * s.ut * s.uphi + gpp * s.uphi * s.uphi + sigma / delta * s.ur * s.ur + sigma * s.uth * s.uth;
    assert.ok(Math.abs(norm + 1) < 2e-5 * Math.max(1, s.ut * s.ut), `u·u = ${norm} at r = ${s.r}`);
  }
});

test('the frozen image redshifts at the surface gravity and co-rotates with the horizon', () => {
  for (const a of [0, 0.7]) {
    const track = physics.integrateInfall({ spin: a, radius: 9, theta: 90, angularMomentum: 0 });
    const late = track.outside.slice(-40);
    const g0 = physics.outgoingRedshift(track, late[0]), g1 = physics.outgoingRedshift(track, late[late.length - 1]);
    // Against emission time the body approaches the horizon as e^(−2κt);
    // at a distant observer (retarded time u ≈ 2t) that is the e^(−κu) law.
    const rate = -Math.log(g1 / g0) / (late[late.length - 1].t - late[0].t);
    assert.ok(Math.abs(rate - 2 * track.surfaceGravity) < 0.03 * track.surfaceGravity, `a=${a}: ${rate} vs 2κ=${2 * track.surfaceGravity}`);
    const s = late[late.length - 1];
    assert.ok(Math.abs(s.uphi / s.ut - track.horizonOmega) < 1e-3, `dφ/dt ${s.uphi / s.ut} vs Ω_H ${track.horizonOmega}`);
  }
});

test('tidal deformation stretches radially and compresses transversely', () => {
  const track = physics.integrateInfall({ spin: 0, radius: 12, theta: 90, angularMomentum: 0 });
  const end = track.outside[track.outside.length - 1];
  assert.ok(end.stretch[0] > 1.3 && end.stretch[1] < 0.9 && end.stretch[2] < 0.9, JSON.stringify(end.stretch));
  assert.ok(Math.abs(end.tidal[0] + end.tidal[1] + end.tidal[2]) < 1e-12, 'vacuum tidal tensor is traceless');
  assert.ok(Math.abs(end.tidal[0] + 2 / 8) < 1e-3, 'radial eigenvalue −2M/r³ at the horizon');
});
