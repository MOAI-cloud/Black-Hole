import * as THREE from 'three';
import type { DiskModel } from './types';
import { kerrRadii } from './geometry';

export const IMPACT_SAMPLES = 768;
export const ANGLE_SAMPLES = 512;
export const MAX_ANGLE = 5 * Math.PI;
export const MAX_IMPACT = 256;
export const CRITICAL_IMPACT = Math.sqrt(27);

function scalarTexture(data: Uint16Array, width: number, height: number): THREE.DataTexture {
  const texture = new THREE.DataTexture(data, width, height, THREE.RedFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// u = M/r. With M=1, a Schwarzschild light ray in its orbital plane satisfies
// u'' = 3u² - u and u'(infinity) = 1/b. Every camera shares this transfer table.
export function createOrbitTable(): THREE.DataTexture {
  const data = new Uint16Array(2 * IMPACT_SAMPLES * (ANGLE_SAMPLES + 2));
  const step = MAX_ANGLE / (ANGLE_SAMPLES - 1);
  const half = THREE.DataUtils.toHalfFloat;
  for (let i = 0; i < IMPACT_SAMPLES; i++) {
    const x = 2 * i / (IMPACT_SAMPLES - 1) - 1;
    const span = x < 0 ? CRITICAL_IMPACT : MAX_IMPACT - CRITICAL_IMPACT;
    const impact = Math.max(1e-6, CRITICAL_IMPACT + x ** 3 * span);
    let u = 0;
    let velocity = 1 / impact;
    let endAngle = MAX_ANGLE;
    let regularDelay = 0;
    let turnAngle = MAX_ANGLE + 1, turnTortoise = 0;
    let finished = false;
    for (let j = 0; j < ANGLE_SAMPLES; j++) {
      const at = 2 * ((j + 2) * IMPACT_SAMPLES + i);
      data[at] = half(u);
      data[at + 1] = half(regularDelay);
      if (finished) continue;

      const a1 = u * (3 * u - 1);
      const u2 = u + 0.5 * step * velocity;
      const v2 = velocity + 0.5 * step * a1;
      const a2 = u2 * (3 * u2 - 1);
      const u3 = u + 0.5 * step * v2;
      const v3 = velocity + 0.5 * step * a2;
      const a3 = u3 * (3 * u3 - 1);
      const u4 = u + step * v3;
      const v4 = velocity + step * a3;
      const next = u + step / 6 * (velocity + 2 * v2 + 2 * v3 + v4);
      const nextV = velocity + step / 6 * (a1 + 2 * a2 + 2 * a3 + u4 * (3 * u4 - 1));
      if (velocity > 0 && nextV < 0) {
        const f = velocity / (velocity - nextV);
        const periapsis = 1 / (u + .5 * step * f * velocity);
        turnAngle = step * (j + f);
        turnTortoise = periapsis + 2 * Math.log(periapsis / 2 - 1);
      }
      // dt/dphi = |dr*/dphi| + 1/(1/b + |du/dphi|), with the Schwarzschild
      // tortoise radius r*. Only the finite remainder is stored in the table.
      const invB = 1 / impact;
      regularDelay += step / 6 * (1 / (invB + Math.abs(velocity)) + 2 / (invB + Math.abs(v2))
        + 2 / (invB + Math.abs(v3)) + 1 / (invB + Math.abs(v4)));
      velocity = nextV;

      if (next >= 0.5 || next < 0) {
        const boundary = next < 0 ? 0 : 0.5;
        endAngle = step * (j + (boundary - u) / (next - u));
        u = boundary;
        finished = true;
      } else {
        u = next;
      }
    }
    // A one-half-float encode of an angle near π quantizes distant stars into
    // visible bands. Store the residual for sub-texel angular interpolation.
    data[2 * i] = half(endAngle);
    data[2 * i + 1] = half(turnAngle);
    data[2 * (IMPACT_SAMPLES + i)] = half(endAngle - THREE.DataUtils.fromHalfFloat(data[2 * i]));
    data[2 * (IMPACT_SAMPLES + i) + 1] = half(turnTortoise);
  }
  const texture = new THREE.DataTexture(data, IMPACT_SAMPLES, ANGLE_SAMPLES + 2, THREE.RGFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// The phase at a finite stationary observer on the incoming trajectory is
// integral_0^(1/R) du / sqrt(1/b² - u²+2u³). Substitute u=(1-t²)/R
// to regularize the endpoint for a ray tangent to the camera sphere.
const quadrature = [
  [0.01985507175, 0.05061426815], [0.1016667613, 0.1111905172],
  [0.2372337950, 0.1568533229], [0.4082826788, 0.1813418917],
  [0.5917173212, 0.1813418917], [0.7627662050, 0.1568533229],
  [0.8983332387, 0.1111905172], [0.9801449282, 0.05061426815]
];

function phaseAtRadius(bOverR: number, radius: number): number {
  let phase = 0;
  for (const [t, weight] of quadrature) {
    const x = 1 - t * t;
    phase += weight * 2 * t * bOverR / Math.sqrt(Math.max(1e-14, 1 - (bOverR * x) ** 2 * (1 - 2 * x / radius)));
  }
  return phase;
}

// Intersect each entire orbit with the disk's radial bounds once, so grazing
// rays can integrate just the visible column through the emitting material.
export function createDiskBounds(orbit: THREE.DataTexture, inner: number, outer: number): THREE.DataTexture {
  const data = new Uint16Array(IMPACT_SAMPLES * 4);
  const orbitData = new Uint16Array(orbit.image.data.buffer);
  for (let i = 0; i < IMPACT_SAMPLES; i++) {
    const x = 2 * i / (IMPACT_SAMPLES - 1) - 1;
    const captured = x < 0;
    const b = CRITICAL_IMPACT + x ** 3 * (captured ? CRITICAL_IMPACT : MAX_IMPACT - CRITICAL_IMPACT);
    const end = THREE.DataUtils.fromHalfFloat(orbitData[2 * i]) + THREE.DataUtils.fromHalfFloat(orbitData[2 * (IMPACT_SAMPLES + i)]);
    const turn = captured ? end : end * 0.5;
    const crossing = (r: number) => {
      if (r <= 2 || (!captured && r <= 3) || b / r * Math.sqrt(1 - 2 / r) >= 1) return turn;
      return Math.min(turn, phaseAtRadius(b / r, r));
    };
    const entry = crossing(outer), exit = crossing(inner);
    const bounds = [entry, exit, captured ? end : end - exit, captured ? end : end - entry];
    for (let j = 0; j < 4; j++) data[4 * i + j] = THREE.DataUtils.toHalfFloat(bounds[j]);
  }
  const texture = new THREE.DataTexture(data, IMPACT_SAMPLES, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.magFilter = texture.minFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function updateObserverTable(texture: THREE.DataTexture, radius: number): void {
  const data = new Uint16Array(texture.image.data.buffer);
  const lapse = Math.sqrt(1 - 2 / radius);
  const length = texture.image.width;
  for (let i = 0; i < length; i++) {
    const bOverR = Math.sin(Math.PI * 0.5 * i / (length - 1)) / lapse;
    const phase = phaseAtRadius(bOverR, radius);
    data[i] = THREE.DataUtils.toHalfFloat(phase);
    data[length + i] = THREE.DataUtils.toHalfFloat(phase - THREE.DataUtils.fromHalfFloat(data[i]));
  }
  texture.needsUpdate = true;
}

export function createObserverTable(): THREE.DataTexture {
  return scalarTexture(new Uint16Array(512), 256, 2);
}

// Page–Thorne flux shape, trapezoidally integrating (E-ΩL) dL.
// This discrete Stieltjes integral avoids differentiating angular momentum.
export function createFluxTable(spin: number, outer: number, model: DiskModel): THREE.DataTexture {
  const samples = 512;
  const inner = kerrRadii(spin).isco;
  const values = new Float64Array(samples);
  let prevL = 0, prevNorm = 0, integral = 0, peak = 0;
  for (let i = 0; i < samples; i++) {
    const r = inner * (outer / inner) ** (i / (samples - 1));
    if (model === 'legacy') {
      const ratio = inner / r;
      values[i] = ratio ** 3 * (1 - Math.sqrt(ratio)) / 0.05665;
    } else {
      const sr = Math.sqrt(r);
      const omega = 1 / (r * sr + spin);
      const norm = Math.sqrt(1 - 3 / r + 2 * spin / (r * sr)) / (1 + spin / (r * sr));
      const L = (r * r - 2 * spin * sr + spin * spin) / (r * sr + spin) / norm;
      if (i > 0) integral += 0.5 * (norm + prevNorm) * (L - prevL);
      values[i] = 1.5 * sr * omega * omega * integral / (r * norm * norm);
      prevL = L;
      prevNorm = norm;
    }
    peak = Math.max(peak, values[i]);
  }
  const divisor = model === 'nt' ? peak : 1;
  const data = Uint16Array.from(values, value => THREE.DataUtils.toHalfFloat(Math.max(0, value / divisor)));
  return scalarTexture(data, samples, 1);
}
