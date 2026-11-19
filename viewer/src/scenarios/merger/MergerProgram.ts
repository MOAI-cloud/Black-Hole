import * as THREE from 'three';
import { vertexShader } from '../../lensingShader';
import type { ViewportProgram } from '../types';
import { binaryFragmentShader, TEXTURE_WIDTH } from './binaryShader';
import type { MergerSolution } from './merger';
import { valueAt } from './waveform';

const TRAJECTORY_STEP = 0.5;
const WAVE_STEP = 0.25;

function dataTexture(texels: number): THREE.DataTexture {
  const height = Math.max(1, Math.ceil(texels / TEXTURE_WIDTH));
  const texture = new THREE.DataTexture(new Float32Array(TEXTURE_WIDTH * height * 4), TEXTURE_WIDTH, height,
    THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

/** Full-screen pass that ray-traces the binary and remnant (binaryShader.ts). */
export class MergerProgram implements ViewportProgram {
  readonly material: THREE.ShaderMaterial;
  private trajectory = dataTexture(1);
  private waves = dataTexture(2);
  eventTime = 0;

  constructor(packedRadiance: boolean) {
    this.material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader: binaryFragmentShader,
      defines: packedRadiance ? { PACK_RADIANCE: 1 } : {},
      depthTest: false,
      depthWrite: false,
      uniforms: {
        skyMap: { value: null }, cameraAxes: { value: new THREE.Matrix3() }, cameraRoll: { value: new THREE.Vector2(1, 0) },
        radius: { value: 48 }, aspect: { value: 1 }, tanHalfFov: { value: 0.4 }, bufferHeight: { value: 1 },
        timeM: { value: 0 }, skyBrightness: { value: 1 }, exposure: { value: 1 }, opticalPass: { value: false },
        trajectoryMap: { value: this.trajectory }, waveMap: { value: this.waves },
        trajectoryTiming: { value: new THREE.Vector3(0, 1, 1) }, waveTiming: { value: new THREE.Vector3(0, 1, 1) },
        holes: { value: new THREE.Vector4(0.5, 0.5, 0, 0) }, levers: { value: new THREE.Vector2(0.5, 0.5) },
        remnantHole: { value: new THREE.Vector2(0.95, 0.65) }, blendWindow: { value: new THREE.Vector2(-7, 2) },
        eventTime: { value: 0 }, waveGain: { value: 6 }, trailWidth: { value: 0.055 },
        showWaves: { value: true }, showTrails: { value: true }
      }
    });
  }

  /** Upload the dynamics over [start, end] and the modes needed for the wave overlay. */
  setSolution(solution: MergerSolution, start: number, end: number): void {
    const u = this.material.uniforms;
    const { X1, X2, chi1, chi2 } = solution.masses;
    u.holes.value.set(X1, X2, chi1 * X1, chi2 * X2);
    u.levers.value.set(X2, X1);
    u.remnantHole.value.set(solution.remnant.mass, solution.remnant.spin * solution.remnant.mass);
    u.blendWindow.value.set(-7, Math.max(-3, Math.min(2, solution.dynamicsEnd - 0.5)));

    // Rays leave the camera up to ~escape radius earlier than the observer time.
    const trajStart = Math.max(solution.start, start - 1200);
    const trajCount = Math.max(2, Math.ceil((end - trajStart) / TRAJECTORY_STEP) + 1);
    this.trajectory.dispose();
    this.trajectory = dataTexture(trajCount);
    const traj = this.trajectory.image.data as unknown as Float32Array;
    const phiRef = 2 * Math.PI * Math.round(valueAt(solution.t, solution.phi, start) / (2 * Math.PI));
    for (let i = 0; i < trajCount; i++) {
      const t = trajStart + i * TRAJECTORY_STEP;
      traj[4 * i] = valueAt(solution.t, solution.r, t);
      traj[4 * i + 1] = valueAt(solution.t, solution.phi, t) - phiRef;
      traj[4 * i + 2] = t > solution.dynamicsEnd ? 0 : valueAt(solution.t, solution.rdot, t);
      traj[4 * i + 3] = valueAt(solution.t, solution.omega, t);
    }
    this.trajectory.needsUpdate = true;
    u.trajectoryMap.value = this.trajectory;
    u.trajectoryTiming.value.set(trajStart, TRAJECTORY_STEP, trajCount);

    const waveStart = Math.max(solution.start, start - 900);
    const waveCount = Math.max(2, Math.ceil((Math.min(end, solution.end) - waveStart) / WAVE_STEP) + 1);
    this.waves.dispose();
    this.waves = dataTexture(2 * waveCount);
    const wave = this.waves.image.data as unknown as Float32Array;
    const byKey = new Map(solution.modes.map(mode => [`${mode.l}${mode.m}`, mode]));
    const slots: [string, number][] = [['22', 0], ['33', 2], ['21', 4], ['44', 6]];
    for (const [key, offset] of slots) {
      const mode = byKey.get(key);
      if (!mode) continue;
      const reference = 2 * Math.PI * Math.round(valueAt(solution.t, mode.phase, waveStart) / (2 * Math.PI));
      for (let i = 0; i < waveCount; i++) {
        const t = waveStart + i * WAVE_STEP;
        wave[8 * i + offset] = valueAt(solution.t, mode.amp, t);
        wave[8 * i + offset + 1] = valueAt(solution.t, mode.phase, t) - reference;
      }
    }
    this.waves.needsUpdate = true;
    u.waveMap.value = this.waves;
    u.waveTiming.value.set(waveStart, WAVE_STEP, waveCount);
  }

  setOverlays(options: { waves: boolean; trails: boolean; gain: number }): void {
    const u = this.material.uniforms;
    u.showWaves.value = options.waves;
    u.showTrails.value = options.trails;
    u.waveGain.value = options.gain;
  }

  update(): void {
    this.material.uniforms.eventTime.value = this.eventTime;
  }

  dispose(): void {
    this.trajectory.dispose();
    this.waves.dispose();
    this.material.dispose();
  }
}
