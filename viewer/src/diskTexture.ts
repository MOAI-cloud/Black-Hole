import * as THREE from 'three';
import type { RenderSettings } from './types';

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function mix(start: number, end: number, amount: number): number {
  return start + (end - start) * amount;
}

function smoothstep(edgeStart: number, edgeEnd: number, value: number): number {
  const amount = clamp((value - edgeStart) / (edgeEnd - edgeStart));
  return amount * amount * (3 - 2 * amount);
}

function progradeIscoRadius(spin: number): number {
  const safeSpin = clamp(spin, 0, 0.999);
  const z1 = 1 + Math.cbrt(1 - safeSpin * safeSpin)
    * (Math.cbrt(1 + safeSpin) + Math.cbrt(1 - safeSpin));
  const z2 = Math.sqrt(3 * safeSpin * safeSpin + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

function colorRamp(heat: number, temperatureBias: number): [number, number, number] {
  const ember = [210, 68, 37];
  const gold = [255, 178, 72];
  const white = [245, 248, 255];
  const blue = [122, 212, 255];
  const hotAmount = clamp(heat * 1.35 + temperatureBias * 0.35);

  if (hotAmount < 0.62) {
    const amount = hotAmount / 0.62;
    return [
      mix(ember[0], gold[0], amount),
      mix(ember[1], gold[1], amount),
      mix(ember[2], gold[2], amount)
    ];
  }

  const amount = (hotAmount - 0.62) / 0.38;
  const whiteMix = temperatureBias > 0.72 ? blue : white;
  return [
    mix(gold[0], whiteMix[0], amount),
    mix(gold[1], whiteMix[1], amount),
    mix(gold[2], whiteMix[2], amount)
  ];
}

export function createDiskTexture(settings: RenderSettings): THREE.CanvasTexture {
  const size = 768;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d', { willReadFrequently: false });
  if (!context) {
    throw new Error('Canvas 2D context unavailable');
  }

  const imageData = context.createImageData(size, size);
  const data = imageData.data;
  const innerRatio = clamp(progradeIscoRadius(settings.spin) / settings.diskOuter, 0.04, 0.44);
  const temperatureBias = clamp((settings.diskTemp - 3500) / 18000);
  const brightness = clamp(settings.diskBright / 18, 0.12, 2.6);

  for (let pixelY = 0; pixelY < size; pixelY += 1) {
    for (let pixelX = 0; pixelX < size; pixelX += 1) {
      const normalizedX = (pixelX + 0.5) / size * 2 - 1;
      const normalizedY = (pixelY + 0.5) / size * 2 - 1;
      const radius = Math.sqrt(normalizedX * normalizedX + normalizedY * normalizedY);
      const pixelIndex = (pixelY * size + pixelX) * 4;

      if (radius < innerRatio || radius > 1) {
        data[pixelIndex + 3] = 0;
        continue;
      }

      const angle = Math.atan2(normalizedY, normalizedX);
      const diskRadius = (radius - innerRatio) / (1 - innerRatio);
      const innerGlow = Math.pow(1 - diskRadius, 1.9);
      const edgeIn = smoothstep(innerRatio, innerRatio + 0.035, radius);
      const edgeOut = 1 - smoothstep(0.82, 1, radius);
      const spiral = Math.sin(angle * 7.0 - Math.log(radius + 0.08) * 18.0 + settings.spin * 4.0);
      const braided = Math.sin(angle * 17.0 + radius * 34.0) * 0.5 + 0.5;
      const grain = Math.sin((normalizedX * 91.7 + normalizedY * 37.3) * 8.0) * 0.5 + 0.5;
      const turbulence = clamp(0.72 + settings.diskNoise * (spiral * 0.22 + braided * 0.18 + grain * 0.12));
      const alpha = clamp((0.18 + innerGlow * 0.95) * edgeIn * edgeOut * turbulence * brightness);
      const heat = clamp(innerGlow * 1.1 + spiral * 0.08 + temperatureBias * 0.2);
      const [red, green, blue] = colorRamp(heat, temperatureBias);

      data[pixelIndex] = red;
      data[pixelIndex + 1] = green;
      data[pixelIndex + 2] = blue;
      data[pixelIndex + 3] = Math.round(alpha * 255);
    }
  }

  context.putImageData(imageData, 0, 0);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearMipMapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
