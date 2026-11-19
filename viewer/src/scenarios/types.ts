import type * as THREE from 'three';
import type { RenderSettings } from '../types';

/** Observer pose in RenderSettings units (M and degrees, vertical FOV). */
export interface ScenarioCamera {
  camR: number;
  camTheta: number;
  camPhi: number;
  fov: number;
  roll: number;
}

/**
 * A full-screen ray pass that replaces the accretion-disk shader while a
 * scenario is active. BlackHoleScene keeps ownership of the observer camera,
 * drawing-buffer resolution, observer clock, camera optics and captures.
 *
 * Use `vertexShader` from lensingShader.ts and start the fragment shader with
 * `viewportCommon` from shaderCommon.ts. Every frame the scene writes these
 * uniforms when the material declares them:
 *   cameraAxes, radius, aspect, bufferHeight, tanHalfFov, cameraRoll, timeM,
 *   exposure, opticalPass, skyMap, skyBrightness.
 * When the scene reports `packedRadiance`, include `PACK_RADIANCE: 1` in the
 * material defines. Finish with writeRadiance(linearRadiance).
 */
export interface ViewportProgram {
  readonly material: THREE.ShaderMaterial;
  /** Called before each draw with the observer coordinate time in M. */
  update(timeM: number): void;
  dispose(): void;
}

/** Access to the sandbox's Kerr geodesic pass, for scenarios that extend it. */
export interface KerrAccess {
  /** A Kerr material sharing every sandbox uniform, with extra defines and uniforms. */
  createMaterial(defines: Record<string, number>, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial;
  settings(): Readonly<RenderSettings>;
  /** Merge settings; `camera` also moves the observer to camR/camTheta/camPhi. */
  updateSettings(patch: Partial<RenderSettings>, camera?: boolean): void;
}

export interface ScenarioContext {
  renderer: THREE.WebGLRenderer;
  kerr: KerrAccess;
  /** Material defines must contain PACK_RADIANCE: 1 when true. */
  packedRadiance: boolean;
  /** Empty inspector container for the scenario's controls and notes. */
  controls: HTMLElement;
  /** Empty container below the viewport for live plots. */
  plots: HTMLElement;
  /** Empty overlay container in the viewport for live numeric readouts. */
  readouts: HTMLElement;
  getTime(): number;
  /** Move the observer clock, for example to loop or scrub a scenario. */
  setTime(timeM: number): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  /** Redraw while paused after a uniform or texture changes. */
  requestRedraw(): void;
}

export interface Scenario {
  readonly id: string;
  readonly title: string;
  readonly program: ViewportProgram;
  /** Pose applied when the scenario opens. */
  readonly camera: ScenarioCamera;
  /** Suggested observer clock rate in M per second. */
  readonly playbackRate: number;
  /** Called on every animation frame with the observer time, for plots and readouts. */
  frame(timeM: number): void;
  dispose(): void;
}

export type ScenarioFactory = (context: ScenarioContext) => Scenario | Promise<Scenario>;
