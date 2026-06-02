import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { createDiskTexture } from './diskTexture';
import type { RenderSettings } from './types';

type CameraChangeHandler = (camera: Pick<RenderSettings, 'camR' | 'camTheta' | 'camPhi' | 'fov'>) => void;

const degreesToRadians = Math.PI / 180;
const radiansToDegrees = 180 / Math.PI;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function disposeObject(object: THREE.Object3D): void {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (mesh.geometry) {
      mesh.geometry.dispose();
    }
    const material = mesh.material;
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose());
    } else if (material) {
      material.dispose();
    }
  });
}

function kerrHorizonRadius(spin: number): number {
  return 1 + Math.sqrt(Math.max(0, 1 - spin * spin));
}

function progradeIscoRadius(spin: number): number {
  const safeSpin = clamp(spin, 0, 0.999);
  const z1 = 1 + Math.cbrt(1 - safeSpin * safeSpin)
    * (Math.cbrt(1 + safeSpin) + Math.cbrt(1 - safeSpin));
  const z2 = Math.sqrt(3 * safeSpin * safeSpin + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

function createFallbackStarTexture(): THREE.CanvasTexture {
  const width = 2048;
  const height = 1024;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    throw new Error('Canvas 2D context unavailable');
  }

  const gradient = context.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#05070d');
  gradient.addColorStop(0.5, '#101826');
  gradient.addColorStop(1, '#070609');
  context.fillStyle = gradient;
  context.fillRect(0, 0, width, height);

  for (let starIndex = 0; starIndex < 3400; starIndex += 1) {
    const longitude = Math.random() * width;
    const latitudeBand = Math.pow(Math.random(), 1.8);
    const latitude = height * (0.5 + (Math.random() - 0.5) * latitudeBand);
    const radius = Math.random() < 0.985 ? Math.random() * 1.1 : Math.random() * 2.8 + 1.0;
    const alpha = Math.random() * 0.8 + 0.2;
    context.fillStyle = `rgba(235, 244, 255, ${alpha})`;
    context.beginPath();
    context.arc(longitude, latitude, radius, 0, Math.PI * 2);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}

export class BlackHoleScene {
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(45, 1, 0.05, 900);
  private readonly controls: OrbitControls;
  private readonly cameraChangeHandler: CameraChangeHandler;
  private readonly resizeObserver: ResizeObserver;
  private settings: RenderSettings;
  private blackHoleMesh: THREE.Mesh | null = null;
  private diskGroup = new THREE.Group();
  private guideGroup = new THREE.Group();
  private starSphere: THREE.Mesh;
  private diskTexture: THREE.Texture | null = null;
  private syncingCamera = false;
  private lastDiskSignature = '';
  private lastFrameMs = 0;

  constructor(canvas: HTMLCanvasElement, initialSettings: RenderSettings, cameraChangeHandler: CameraChangeHandler) {
    this.canvas = canvas;
    this.settings = { ...initialSettings };
    this.cameraChangeHandler = cameraChangeHandler;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });

    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene.background = new THREE.Color('#020309');
    this.scene.fog = new THREE.FogExp2('#020309', 0.0045);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.065;
    this.controls.rotateSpeed = 0.62;
    this.controls.zoomSpeed = 0.7;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 220;
    this.controls.target.set(0, 0, 0);
    this.controls.addEventListener('change', () => this.emitCameraChange());

    this.scene.add(new THREE.AmbientLight('#bfd7ff', 0.22));
    const diskLight = new THREE.PointLight('#ffb55f', 4.5, 100, 1.8);
    diskLight.position.set(0, 1.5, 0);
    this.scene.add(diskLight);

    this.starSphere = this.createStarSphere(createFallbackStarTexture());
    this.scene.add(this.starSphere);
    this.scene.add(this.diskGroup);
    this.scene.add(this.guideGroup);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement ?? canvas);

    this.rebuildGuides();
    this.rebuildBlackHole();
    this.rebuildDisk(true);
    this.syncCameraFromSettings();
    this.resize();
    this.renderer.setAnimationLoop((timeMs) => this.render(timeMs));
  }

  setSettings(settings: RenderSettings, options: { syncCamera?: boolean } = {}): void {
    this.settings = { ...settings };
    this.renderer.toneMappingExposure = clamp(settings.exposure, 0.05, 10);
    this.rebuildBlackHole();
    this.rebuildDisk(false);
    if (options.syncCamera) {
      this.syncCameraFromSettings();
    }
  }

  setStarTexture(texture: THREE.Texture): void {
    const material = this.starSphere.material as THREE.MeshBasicMaterial;
    const previousTexture = material.map;
    material.map = texture;
    material.color.set('#ffffff');
    material.needsUpdate = true;
    if (previousTexture) {
      previousTexture.dispose();
    }
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse((object) => disposeObject(object));
    this.diskTexture?.dispose();
    this.renderer.dispose();
  }

  private createStarSphere(texture: THREE.Texture): THREE.Mesh {
    const geometry = new THREE.SphereGeometry(360, 96, 48);
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      side: THREE.BackSide,
      color: '#dfe8ff'
    });
    const sphere = new THREE.Mesh(geometry, material);
    sphere.rotation.y = Math.PI;
    return sphere;
  }

  private rebuildBlackHole(): void {
    const horizonRadius = kerrHorizonRadius(this.settings.spin);
    if (!this.blackHoleMesh) {
      const geometry = new THREE.SphereGeometry(1, 96, 64);
      const material = new THREE.MeshBasicMaterial({ color: '#000000' });
      this.blackHoleMesh = new THREE.Mesh(geometry, material);
      this.scene.add(this.blackHoleMesh);
    }
    this.blackHoleMesh.scale.setScalar(horizonRadius);
  }

  private rebuildDisk(force: boolean): void {
    const signature = [
      this.settings.spin.toFixed(3),
      this.settings.diskOuter.toFixed(2),
      this.settings.diskTemp.toFixed(0),
      this.settings.diskBright.toFixed(2),
      this.settings.diskNoise.toFixed(2),
      this.settings.diskThick.toFixed(2),
      this.settings.thin ? 'thin' : 'thick',
      this.settings.noDoppler ? 'sym' : 'doppler'
    ].join(':');

    if (!force && signature === this.lastDiskSignature) {
      return;
    }

    this.lastDiskSignature = signature;
    disposeObject(this.diskGroup);
    this.diskGroup.clear();
    this.diskTexture?.dispose();

    const innerRadius = clamp(
      progradeIscoRadius(this.settings.spin),
      kerrHorizonRadius(this.settings.spin) + 0.08,
      this.settings.diskOuter - 1
    );
    const outerRadius = this.settings.diskOuter;
    this.diskTexture = createDiskTexture(this.settings);

    const diskGeometry = new THREE.RingGeometry(innerRadius, outerRadius, 288, 2);
    const diskMaterial = new THREE.MeshBasicMaterial({
      map: this.diskTexture,
      transparent: true,
      opacity: this.settings.thin ? 0.88 : 0.72,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });
    const diskMesh = new THREE.Mesh(diskGeometry, diskMaterial);
    diskMesh.rotation.x = -Math.PI / 2;
    this.diskGroup.add(diskMesh);

    const photonGeometry = new THREE.TorusGeometry(3, 0.045, 12, 192);
    const photonMaterial = new THREE.MeshBasicMaterial({
      color: '#ffd07a',
      transparent: true,
      opacity: 0.86,
      blending: THREE.AdditiveBlending
    });
    const photonRing = new THREE.Mesh(photonGeometry, photonMaterial);
    photonRing.rotation.x = Math.PI / 2;
    this.diskGroup.add(photonRing);

    if (!this.settings.thin) {
      const glowGeometry = new THREE.TorusGeometry(
        (innerRadius + outerRadius) * 0.5,
        clamp(this.settings.diskThick * 1.35, 0.18, 3.2),
        18,
        192
      );
      const glowMaterial = new THREE.MeshBasicMaterial({
        color: this.settings.noDoppler ? '#ffbd73' : '#ff9f4a',
        transparent: true,
        opacity: clamp(0.16 + this.settings.diskBright / 90, 0.12, 0.52),
        blending: THREE.AdditiveBlending,
        depthWrite: false
      });
      const glow = new THREE.Mesh(glowGeometry, glowMaterial);
      glow.rotation.x = Math.PI / 2;
      this.diskGroup.add(glow);
    }
  }

  private rebuildGuides(): void {
    disposeObject(this.guideGroup);
    this.guideGroup.clear();

    const guideMaterial = new THREE.LineBasicMaterial({
      color: '#6fb6c9',
      transparent: true,
      opacity: 0.22
    });

    for (const radius of [10, 20, 40, 80]) {
      const points: THREE.Vector3[] = [];
      for (let segmentIndex = 0; segmentIndex <= 192; segmentIndex += 1) {
        const angle = (segmentIndex / 192) * Math.PI * 2;
        points.push(new THREE.Vector3(Math.cos(angle) * radius, 0, Math.sin(angle) * radius));
      }
      const geometry = new THREE.BufferGeometry().setFromPoints(points);
      this.guideGroup.add(new THREE.Line(geometry, guideMaterial));
    }
  }

  private syncCameraFromSettings(): void {
    this.syncingCamera = true;
    const thetaRadians = this.settings.camTheta * degreesToRadians;
    const phiRadians = this.settings.camPhi * degreesToRadians;
    const radius = this.settings.camR;
    this.camera.position.set(
      radius * Math.sin(thetaRadians) * Math.cos(phiRadians),
      radius * Math.cos(thetaRadians),
      radius * Math.sin(thetaRadians) * Math.sin(phiRadians)
    );
    this.camera.fov = this.settings.fov;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.syncingCamera = false;
  }

  private emitCameraChange(): void {
    if (this.syncingCamera) {
      return;
    }

    const position = this.camera.position;
    const radius = clamp(position.length(), 3, 220);
    const theta = Math.acos(clamp(position.y / radius, -1, 1)) * radiansToDegrees;
    const phi = ((Math.atan2(position.z, position.x) * radiansToDegrees) + 360) % 360;
    this.cameraChangeHandler({
      camR: Number(radius.toFixed(2)),
      camTheta: Number(theta.toFixed(2)),
      camPhi: Number(phi.toFixed(2)),
      fov: Number(this.camera.fov.toFixed(2))
    });
  }

  private resize(): void {
    const bounds = this.canvas.getBoundingClientRect();
    const width = Math.max(1, Math.floor(bounds.width));
    const height = Math.max(1, Math.floor(bounds.height));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private render(timeMs: number): void {
    // Delta time keeps rotation speed constant regardless of frame rate, and
    // avoids the unbounded acceleration of integrating an ever-growing clock.
    const deltaMs = this.lastFrameMs === 0 ? 0 : Math.min(timeMs - this.lastFrameMs, 100);
    this.lastFrameMs = timeMs;
    const twoPi = Math.PI * 2;

    this.controls.update();
    // Disk angular velocity (rad/ms) grows mildly with spin; wrapped to stay
    // within [0, 2pi) so the float never loses precision over long sessions.
    const diskOmega = 0.00004 * (1 + this.settings.spin * 2);
    this.diskGroup.rotation.y = (this.diskGroup.rotation.y + diskOmega * deltaMs) % twoPi;
    this.starSphere.rotation.y = (this.starSphere.rotation.y + 0.000001 * deltaMs) % twoPi;
    this.renderer.render(this.scene, this.camera);
  }
}
