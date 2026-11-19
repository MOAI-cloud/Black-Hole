import * as THREE from 'three';
import flowUrl from '../../src/flow/accretion.bin?url';
import { CameraOptics } from './cameraOptics';
import { TelescopeBeam } from './telescopeBeam';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { blackbodyColor, createBlackbodyTable, createFallbackSky } from './emissionTextures';
import { kerrRadii } from './geometry';
import { circularOrbit, gravitationalRadius } from './astro';
import { vertexShader, fragmentShader } from './lensingShader';
import { kerrFragmentShader } from './kerrShader';
import { createDiskBounds, createFluxTable, createObserverTable, createOrbitTable, updateObserverTable } from './orbitTables';
import type { RenderSettings } from './types';
import type { ViewportProgram } from './scenarios/types';

type CameraValues = Pick<RenderSettings, 'camR' | 'camTheta' | 'camPhi' | 'fov'>;
export type PreviewQuality = 'auto' | 'high' | 'performance';
export type LensingModel = 'schwarzschild' | 'kerr';
export type FrameStats = { fps: number; scale: number };

const rad = Math.PI / 180;
const uhdPixels = 3840 * 2160;

export class BlackHoleScene {
  private readonly renderer: THREE.WebGLRenderer;
  readonly automaticModel: LensingModel;
  private readonly initialScale: number;
  private readonly scene = new THREE.Scene();
  private readonly optics: CameraOptics;
  private readonly beam: TelescopeBeam;
  private readonly camera = new THREE.PerspectiveCamera();
  private readonly controls: OrbitControls;
  private readonly material: THREE.ShaderMaterial;
  private readonly screen: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private program: ViewportProgram | null = null;
  private frameListener: ((timeM: number) => void) | null = null;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly resizeObserver: ResizeObserver;
  private readonly controller = new AbortController();
  private readonly orbit = createOrbitTable();
  private readonly observer = createObserverTable();
  private readonly blackbody = createBlackbodyTable();
  private readonly flow = new THREE.Data3DTexture();
  private readonly flowReady: Promise<void>;
  private sky: THREE.Texture = createFallbackSky();
  private bounds: THREE.DataTexture;
  private flux: THREE.DataTexture;
  private settings: RenderSettings;
  private observerRadius = 0;
  private dirty = true;
  private paused = false;
  private autoOrbit = false;
  private timeM = 0;
  private playbackRate = 12;
  private quality: PreviewQuality = 'auto';
  private lensingModel: LensingModel = 'schwarzschild';
  private adaptiveScale: number;
  private pixelScale = 1;
  private maxBufferWidth = 1;
  private maxBufferHeight = 1;
  private lastPausedCameraMotion = -Infinity;
  private pausedCameraMoving = false;
  private lastFrame = 0;
  private statsDuration = 0;
  private statsFrames = 0;
  private syncingCamera = false;
  private pendingCamera = false;
  private lastCameraSignal = 0;
  private disposed = false;

  constructor(private readonly canvas: HTMLCanvasElement, initial: RenderSettings,
    private readonly onCamera: (values: CameraValues) => void,
    private readonly onStats?: (stats: FrameStats) => void,
    onShaderFailure?: () => void) {
    this.settings = { ...initial };
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, depth: false,
      stencil: false, alpha: false, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    const gl = this.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const device = String(gl.getParameter(info?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER));
    const software = /swiftshader|llvmpipe|softpipe|software rasterizer|basic render driver/i.test(device);
    this.automaticModel = software ? 'schwarzschild' : 'kerr';
    this.initialScale = software ? .5 : Math.min(1.5, Math.max(1.15, window.devicePixelRatio));
    this.adaptiveScale = this.initialScale;
    if (onShaderFailure) {
      let reported = false;
      this.renderer.debug.onShaderError = (gl, program, vertex, fragment) => {
        if (reported) return;
        reported = true;
        console.error('Viewport shader failed', gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment));
        // Leave the renderer's active draw before releasing its resources.
        queueMicrotask(onShaderFailure);
      };
    }
    this.readBufferLimits();
    this.optics = new CameraOptics(this.renderer, this.geometry);
    this.beam = new TelescopeBeam(this.renderer, this.geometry);
    const inner = kerrRadii(initial.spin).isco;
    this.bounds = createDiskBounds(this.orbit, inner, initial.diskOuter);
    this.flux = createFluxTable(initial.spin, initial.diskOuter, initial.diskModel);
    this.flowReady = this.loadFlow();
    // Startup reports asset errors through whenFrameReady, including when
    // shader compilation takes longer than the asset request.
    void this.flowReady.catch(() => {});
    this.material = new THREE.ShaderMaterial({
      vertexShader, fragmentShader, depthTest: false, depthWrite: false,
      defines: this.optics.packed ? { PACK_RADIANCE: 1 } : {},
      uniforms: {
        flowMap: { value: this.flow }, orbitMap: { value: this.orbit }, observerMap: { value: this.observer },
        fluxMap: { value: this.flux }, boundsMap: { value: this.bounds },
        colorMap: { value: this.blackbody }, skyMap: { value: this.sky },
        cameraAxes: { value: new THREE.Matrix3() }, timeM: { value: 0 }, radius: { value: initial.camR },
        aspect: { value: 1 }, bufferHeight: { value: 1 }, tanHalfFov: { value: 1 }, cameraRoll: { value: new THREE.Vector2(1, 0) },
        spin: { value: 0 }, innerR: { value: inner },
        outerR: { value: 0 }, diskHeight: { value: 0 }, flare: { value: 0 }, absorption: { value: 0 },
        peakTemp: { value: 0 }, brightness: { value: 0 }, turbulence: { value: 0 }, skyBrightness: { value: 0 },
        opticalPass: { value: false }, exposure: { value: 1 }, thin: { value: false }, photosphere: { value: false }, kinematic: { value: true },
        gravity: { value: true }, staticPattern: { value: false }, diskEnabled: { value: true },
        companion: { value: new THREE.Vector4(0, 0, 1, 2) }, companionRadiance: { value: new THREE.Vector3() },
        riafDensity: { value: 1e6 }, riafTemperature: { value: 4e10 }, riafBeta: { value: 10 }, riafHeight: { value: .5 },
        riafSlopes: { value: new THREE.Vector2(1.1, .84) },
        gravitationalCm: { value: 1 }, observeHz: { value: 2.3e11 }, iscoEnergy: { value: 1 }, iscoMomentum: { value: 0 },
        hotspot: { value: new THREE.Vector4(9, .7, 0, 0) }, jetDensity: { value: 0 }, jetLorentz: { value: 3 },
        rawBrightness: { value: false }, displayDecades: { value: 0 }
      }
    });
    // One full-screen triangle, independent of zoom and of the number of disk images.
    this.geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this.screen = new THREE.Mesh(this.geometry, this.material);
    this.screen.frustumCulled = false;
    this.scene.add(this.screen);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableDamping = true;
    this.controls.dampingFactor = .085;
    this.controls.rotateSpeed = .55;
    this.controls.zoomSpeed = .75;
    this.controls.autoRotateSpeed = .45;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 1000;
    this.controls.minPolarAngle = rad;
    this.controls.maxPolarAngle = 179 * rad;
    this.controls.addEventListener('change', () => {
      this.dirty = true;
      if (!this.syncingCamera) this.pendingCamera = true;
      if (this.paused && !this.syncingCamera && this.quality === 'auto') {
        this.lastPausedCameraMotion = performance.now();
        if (!this.pausedCameraMoving) {
          this.pausedCameraMoving = true;
          this.resize();
        }
      }
    });
    if (!canvas.hasAttribute('tabindex')) canvas.tabIndex = 0;
    const events = { signal: this.controller.signal };
    canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }), events);
    canvas.addEventListener('keydown', event => this.keyNavigation(event), events);
    canvas.addEventListener('webglcontextrestored', () => {
      this.readBufferLimits();
      this.resize();
    }, events);
    document.addEventListener('visibilitychange', () => {
      this.lastFrame = 0;
      this.statsDuration = this.statsFrames = 0;
      this.dirty = true;
      this.renderer.setAnimationLoop(document.hidden ? null : this.frame);
    }, events);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas);
    this.setSettings(initial, { syncCamera: true });
    this.resize();
    this.renderer.setAnimationLoop(this.frame);
  }

  setSettings(next: RenderSettings, options: { syncCamera?: boolean } = {}): void {
    const old = this.settings;
    const inner = kerrRadii(next.spin).isco;
    const radialChange = next.spin !== old.spin || next.diskOuter !== old.diskOuter;
    if (radialChange) {
      this.bounds.dispose();
      this.bounds = createDiskBounds(this.orbit, inner, next.diskOuter);
      this.material.uniforms.boundsMap.value = this.bounds;
    }
    if (radialChange || next.diskModel !== old.diskModel) {
      this.flux.dispose();
      this.flux = createFluxTable(next.spin, next.diskOuter, next.diskModel);
      this.material.uniforms.fluxMap.value = this.flux;
    }
    const modelChange = (next.emission === 'synchrotron') !== (old.emission === 'synchrotron');
    this.settings = { ...next };
    if (modelChange) this.applyFragmentShader();
    const uniforms = this.material.uniforms;
    uniforms.tanHalfFov.value = Math.tan(next.fov * rad * .5);
    uniforms.cameraRoll.value.set(Math.cos(next.roll * rad), Math.sin(next.roll * rad));
    uniforms.spin.value = next.spin;
    uniforms.innerR.value = inner;
    uniforms.outerR.value = next.diskOuter;
    uniforms.diskHeight.value = Math.max(.001, next.diskThick);
    uniforms.flare.value = next.diskFlare;
    uniforms.absorption.value = next.diskAbsorb;
    uniforms.peakTemp.value = next.diskTemp;
    uniforms.brightness.value = next.diskBright;
    uniforms.turbulence.value = next.diskNoise;
    uniforms.skyBrightness.value = next.skyBright;
    uniforms.exposure.value = next.exposure;
    uniforms.opticalPass.value = next.cinematic;
    uniforms.thin.value = next.thin;
    uniforms.photosphere.value = next.thin && next.photosphere;
    uniforms.kinematic.value = !next.noDoppler;
    uniforms.gravity.value = !next.noRedshift;
    uniforms.staticPattern.value = next.staticDiskPattern;
    uniforms.diskEnabled.value = next.diskEnabled;
    this.updateCompanion(next);
    this.updateSynchrotron(next, inner);
    this.dirty = true;
    if (options.syncCamera) this.positionCamera(next);
  }

  private updateCompanion(next: RenderSettings): void {
    const uniforms = this.material.uniforms;
    if (!next.companion) {
      uniforms.companion.value.set(0, 0, 1, 2);
      return;
    }
    const theta = next.companionTheta * rad, phi = next.companionPhi * rad;
    uniforms.companion.value.set(Math.sin(theta) * Math.cos(phi), Math.cos(theta), -Math.sin(theta) * Math.sin(phi),
      Math.cos(Math.max(1e-4, next.companionRadius) * rad));
    // Same Planck/CIE normalization as the disk: radiance relative to the
    // reference (peak) temperature, scaled by the emission setting.
    const star = blackbodyColor(next.companionTemp);
    // A colour-corrected disk is a diluted blackbody, f⁻⁴ B(f T_eff), so a
    // star of the same colour temperature is f⁴ brighter per unit area.
    const scale = next.diskBright * next.diskColorCorrection ** 4 * 2 ** (star.log2Y - blackbodyColor(next.diskTemp).log2Y);
    uniforms.companionRadiance.value.set(star.rgb[0] * scale, star.rgb[1] * scale, star.rgb[2] * scale);
  }

  private updateSynchrotron(next: RenderSettings, isco: number): void {
    const synchrotron = next.emission === 'synchrotron';
    const defines = this.material.defines as Record<string, unknown>;
    if (synchrotron !== ('SYNCHROTRON' in defines)) {
      if (synchrotron) defines.SYNCHROTRON = 1;
      else delete defines.SYNCHROTRON;
      this.applyFragmentShader();
    }
    if (!synchrotron) return;
    const uniforms = this.material.uniforms;
    const orbit = circularOrbit(isco, next.spin);
    uniforms.riafDensity.value = next.riafDensity;
    uniforms.riafTemperature.value = next.riafTemperature;
    uniforms.riafBeta.value = next.riafBeta;
    uniforms.riafHeight.value = next.riafHeight;
    uniforms.riafSlopes.value.set(next.riafDensitySlope, next.riafTemperatureSlope);
    uniforms.gravitationalCm.value = gravitationalRadius(next.massSolar) * 100;
    uniforms.observeHz.value = next.observeGHz * 1e9;
    uniforms.iscoEnergy.value = orbit.E;
    uniforms.iscoMomentum.value = orbit.L;
    uniforms.hotspot.value.set(next.hotspotRadius, .7, next.hotspot ? 6 : 0, .3);
    uniforms.jetDensity.value = next.jet ? .6 : 0;
    uniforms.displayDecades.value = next.displayDecades;
  }

  /** The synchrotron flow needs volumetric geodesic transfer, so it always uses Kerr. */
  private effectiveModel(): LensingModel {
    return this.settings.emission === 'synchrotron' ? 'kerr' : this.lensingModel;
  }

  private applyFragmentShader(): void {
    const shader = this.effectiveModel() === 'kerr' ? kerrFragmentShader : fragmentShader;
    if (this.material.fragmentShader !== shader) this.material.fragmentShader = shader;
    this.material.needsUpdate = true;
  }

  private positionCamera(values: CameraValues): void {
    this.syncingCamera = true;
    // Drain pending drag damping before applying an absolute preset or slider.
    const rotate = this.controls.autoRotate;
    this.controls.autoRotate = false;
    this.controls.enableDamping = false;
    this.controls.update();
    this.controls.enableDamping = true;
    const theta = THREE.MathUtils.clamp(values.camTheta, 1, 179) * rad;
    const phi = values.camPhi * rad;
    const r = THREE.MathUtils.clamp(values.camR, 4, 1000);
    this.camera.position.set(r * Math.sin(theta) * Math.cos(phi), r * Math.cos(theta), -r * Math.sin(theta) * Math.sin(phi));
    this.camera.fov = values.fov;
    this.controls.update();
    this.controls.autoRotate = rotate;
    this.pendingCamera = false;
    this.syncingCamera = false;
    this.dirty = true;
  }

  private cameraValues(): CameraValues {
    const { x, y, z } = this.camera.position;
    const r = this.camera.position.length();
    return { camR: r, camTheta: Math.acos(THREE.MathUtils.clamp(y / r, -1, 1)) / rad,
      camPhi: (Math.atan2(-z, x) / rad + 360) % 360, fov: this.camera.fov };
  }

  private keyNavigation(event: KeyboardEvent): void {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const pose = this.cameraValues();
    const step = event.shiftKey ? 5 : 1.5;
    switch (event.key) {
      case 'ArrowLeft': pose.camPhi -= step; break;
      case 'ArrowRight': pose.camPhi += step; break;
      case 'ArrowUp': pose.camTheta -= step; break;
      case 'ArrowDown': pose.camTheta += step; break;
      case '+': case '=': pose.camR /= 1.08; break;
      case '-': case '_': pose.camR *= 1.08; break;
      default: return;
    }
    event.preventDefault();
    this.positionCamera(pose);
    this.onCamera(this.cameraValues());
  }

  setStarTexture(texture: THREE.Texture): void {
    if (this.disposed) { texture.dispose(); return; }
    this.sky.dispose();
    texture.flipY = true;
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.needsUpdate = true;
    this.sky = texture;
    this.material.uniforms.skyMap.value = texture;
    this.dirty = true;
  }

  setPaused(paused: boolean): void {
    const changed = this.paused !== paused;
    this.paused = paused;
    this.controls.autoRotate = this.autoOrbit && !paused;
    if (changed) {
      this.pausedCameraMoving = false;
      this.lastFrame = 0;
      this.statsFrames = this.statsDuration = 0;
      if (this.quality === 'auto') this.resize();
    }
    this.dirty = true;
  }

  setPlaybackRate(rateMPerSecond: number): void {
    if (Number.isFinite(rateMPerSecond) && rateMPerSecond >= 0) this.playbackRate = rateMPerSecond;
  }

  private async loadFlow(): Promise<void> {
    const response = await fetch(flowUrl, { signal: this.controller.signal });
    if (!response.ok) throw new Error('Could not load the accretion flow.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== 128 * 190 * 32 * 2) throw new Error('Incomplete accretion flow movie.');
    if (this.disposed) return;
    this.flow.image = { data: bytes, width: 128, height: 190, depth: 32 };
    this.flow.format = THREE.RGFormat;
    this.flow.wrapS = THREE.RepeatWrapping;
    this.flow.minFilter = this.flow.magFilter = THREE.LinearFilter;
    this.flow.needsUpdate = true;
    this.dirty = true;
  }

  async whenFrameReady(): Promise<void> {
    await Promise.all([this.flowReady, this.renderer.compileAsync(this.scene, this.camera)]);
    if (this.disposed || this.renderer.getContext().isContextLost()) {
      throw new Error('The live viewport is unavailable.');
    }
    this.draw();
  }

  getObserverTime(): number { return this.timeM; }

  /** True when scenario materials need the PACK_RADIANCE define. */
  get packedRadiance(): boolean { return this.optics.packed; }

  getRenderer(): THREE.WebGLRenderer { return this.renderer; }

  /** A Kerr geodesic material that shares this scene's uniforms (and their live values). */
  createKerrMaterial(defines: Record<string, number>, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      vertexShader, fragmentShader: kerrFragmentShader, depthTest: false, depthWrite: false,
      defines: { ...(this.optics.packed ? { PACK_RADIANCE: 1 } : {}), ...defines },
      uniforms: { ...this.material.uniforms, ...uniforms }
    });
  }

  /** Replace the accretion-disk pass with a scenario program, or restore it with null. */
  setProgram(program: ViewportProgram | null): void {
    if (program === this.program) return;
    this.program = program;
    this.screen.material = program?.material ?? this.material;
    this.adaptiveScale = this.initialScale;
    this.statsFrames = this.statsDuration = 0;
    this.resize();
  }

  /** Called on every animation frame with the observer time, drawn or not. */
  setFrameListener(listener: ((timeM: number) => void) | null): void {
    this.frameListener = listener;
  }

  requestRedraw(): void { this.dirty = true; }

  isPaused(): boolean { return this.paused; }

  setObserverTime(time: number): void {
    if (!Number.isFinite(time)) return;
    this.timeM = time;
    this.dirty = true;
  }

  setAutoOrbit(enabled: boolean): void {
    this.autoOrbit = enabled;
    this.controls.autoRotate = enabled && !this.paused;
  }

  setLensingModel(model: LensingModel): void {
    if (model === this.lensingModel) return;
    this.lensingModel = model;
    this.applyFragmentShader();
    this.adaptiveScale = this.initialScale;
    this.statsFrames = this.statsDuration = 0;
    this.resize();
  }

  setQuality(quality: PreviewQuality): void {
    this.quality = quality;
    this.pausedCameraMoving = false;
    this.statsFrames = this.statsDuration = 0;
    this.resize();
  }

  private readBufferLimits(): void {
    const gl = this.renderer.getContext();
    const viewport: Int32Array = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
    const limit = Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_TEXTURE_SIZE));
    this.maxBufferWidth = Math.min(limit, viewport[0]);
    this.maxBufferHeight = Math.min(limit, viewport[1]);
  }

  private resize(): void {
    const { width, height } = this.canvas.getBoundingClientRect();
    if (width < 1 || height < 1) return;
    const native = Math.min(2, window.devicePixelRatio);
    const kerr = this.effectiveModel() === 'kerr';
    // A stationary frame can afford four real rays per CSS pixel. During
    // animation adaptive quality uses frame time to choose the sampling rate.
    const supersample = this.quality === 'high' || (this.quality === 'auto' && this.paused && !this.pausedCameraMoving);
    const scale = supersample ? 2 : this.quality === 'auto' ? this.adaptiveScale : Math.min(.75, native);
    const budget = supersample ? uhdPixels : this.quality === 'auto'
      ? (kerr ? 2560 * 1440 : 3200 * 1800) : (kerr ? 320000 : 900000);
    this.pixelScale = Math.min(scale, Math.sqrt(budget / (width * height)),
      this.maxBufferWidth / width, this.maxBufferHeight / height);
    const w = Math.max(1, Math.floor(width * this.pixelScale));
    const h = Math.max(1, Math.floor(height * this.pixelScale));
    if (this.canvas.width !== w || this.canvas.height !== h) this.renderer.setDrawingBufferSize(w, h, 1);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.material.uniforms.aspect.value = this.camera.aspect;
    this.material.uniforms.bufferHeight.value = this.canvas.height;
    this.dirty = true;
  }

  private draw(): void {
    const r = this.camera.position.length();
    if (!this.program && this.effectiveModel() === 'schwarzschild' && Math.abs(this.observerRadius - r) > .001) {
      updateObserverTable(this.observer, r);
      this.observerRadius = r;
    }
    this.camera.updateMatrixWorld();
    const uniforms = this.screen.material.uniforms;
    this.material.uniforms.cameraAxes.value.setFromMatrix4(this.camera.matrixWorld);
    this.material.uniforms.radius.value = r;
    this.material.uniforms.timeM.value = this.timeM;
    if (this.program) {
      const shared = this.material.uniforms;
      for (const key of ['cameraAxes', 'radius', 'timeM', 'aspect', 'bufferHeight', 'tanHalfFov', 'cameraRoll',
        'exposure', 'opticalPass', 'skyMap', 'skyBrightness']) {
        if (!uniforms[key]) continue;
        const value = shared[key].value;
        if (value instanceof THREE.Matrix3 || value instanceof THREE.Vector2) uniforms[key].value.copy(value);
        else uniforms[key].value = value;
      }
      this.program.update(this.timeM);
    }
    // The synchrotron image is a false-colour map of brightness temperature, not radiance.
    const synchrotron = !this.program && this.settings.emission === 'synchrotron';
    const optics = this.settings.cinematic && !synchrotron;
    const beamPixels = synchrotron ? this.beamSigmaPixels(r) : 0;
    this.material.uniforms.rawBrightness.value = beamPixels > 0;
    if (beamPixels > 0) this.beam.draw(this.scene, this.camera, this.canvas.width, this.canvas.height, beamPixels);
    else if (optics) this.optics.draw(this.scene, this.camera, this.canvas.width, this.canvas.height);
    else this.renderer.render(this.scene, this.camera);
    this.dirty = false;
  }

  /** Gaussian σ of the telescope beam in drawing-buffer pixels at camera radius r. */
  private beamSigmaPixels(r: number): number {
    const { telescopeBeam, angularScale, fov } = this.settings;
    if (!(telescopeBeam > 0 && angularScale > 0)) return 0;
    // One M at the hole subtends 1/r rad from the camera.
    const pixelsPerM = this.canvas.height / (2 * r * Math.tan(fov * rad / 2));
    return telescopeBeam / angularScale / 2.3548 * pixelsPerM;
  }

  async capture(): Promise<Blob> {
    await this.flowReady;
    this.draw();
    return new Promise((resolve, reject) => this.canvas.toBlob(blob =>
      blob ? resolve(blob) : reject(new Error('Could not capture the viewport')), 'image/png'));
  }

  private readonly frame = (now: number): void => {
    const dt = this.lastFrame ? Math.max(0, (now - this.lastFrame) / 1000) : 0;
    this.lastFrame = now;
    const motionDt = Math.min(dt, .1);
    if (!this.paused) this.timeM += dt * this.playbackRate;
    this.controls.update(motionDt);
    if (this.pausedCameraMoving && now - this.lastPausedCameraMotion > 200) {
      this.pausedCameraMoving = false;
      this.resize();
    }
    if (this.pendingCamera && now - this.lastCameraSignal > 65) {
      this.pendingCamera = false;
      this.lastCameraSignal = now;
      this.onCamera(this.cameraValues());
    }
    this.frameListener?.(this.timeM);
    if (!this.dirty && (this.paused || (!this.program && this.settings.staticDiskPattern))) return;
    this.draw();
    if (dt === 0 || this.paused) return;
    this.statsFrames++;
    this.statsDuration += dt;
    if (this.statsDuration >= 1.25) {
      const fps = this.statsFrames / this.statsDuration;
      this.onStats?.({ fps, scale: this.pixelScale });
      if (this.quality === 'auto') {
        const previous = this.adaptiveScale;
        if (fps < 40) this.adaptiveScale = Math.max(.5, this.pixelScale * .84);
        else if (fps > 54) this.adaptiveScale = Math.min(Math.max(1.5, Math.min(2, window.devicePixelRatio)), this.pixelScale * 1.10);
        if (Math.abs(previous - this.adaptiveScale) > .015) this.resize();
      }
      this.statsDuration = this.statsFrames = 0;
    }
  };

  dispose(): void {
    this.disposed = true;
    this.renderer.setAnimationLoop(null);
    this.controller.abort();
    this.resizeObserver.disconnect();
    this.controls.dispose();
    for (const texture of [this.flow, this.sky, this.orbit, this.flux, this.bounds, this.observer, this.blackbody]) texture.dispose();
    this.geometry.dispose();
    this.optics.dispose();
    this.beam.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }
}
