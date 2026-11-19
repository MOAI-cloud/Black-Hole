import * as THREE from 'three';

// Planck/CIE integration as in blackbody.cuh, from 300 K to 3e8 K so hot
// X-ray binary and quasar disks keep their Doppler and temperature contrast.
// Pack chromaticity and log2 Y separately to preserve brightness over the
// whole range. Above the table the visible band is Rayleigh-Jeans, Y ∝ T.
export const BLACKBODY_SIZE = 512;
export const BLACKBODY_MIN_K = 300;
export const BLACKBODY_MAX_K = 3e8;

const lobe = (lambda: number, center: number, left: number, right: number) =>
  Math.exp(-0.5 * ((lambda - center) * (lambda < center ? left : right)) ** 2);

/** Linear-sRGB chromaticity (Y = 1) and log2 of the visible luminance of a blackbody. */
export function blackbodyColor(temperature: number): { rgb: [number, number, number]; log2Y: number } {
  let X = 0, Y = 0, Z = 0;
  for (let lambda = 380; lambda <= 780; lambda += 2) {
    const radiance = (550 / lambda) ** 5 / Math.expm1(1.438776877e7 / (lambda * temperature));
    X += radiance * (1.056 * lobe(lambda, 599.8, 0.0264, 0.0323)
      + 0.362 * lobe(lambda, 442, 0.0624, 0.0374) - 0.065 * lobe(lambda, 501.1, 0.0490, 0.0382));
    Y += radiance * (0.821 * lobe(lambda, 568.8, 0.0213, 0.0247) + 0.286 * lobe(lambda, 530.9, 0.0613, 0.0322));
    Z += radiance * (1.217 * lobe(lambda, 437, 0.0845, 0.0278) + 0.681 * lobe(lambda, 459, 0.0385, 0.0725));
  }
  return {
    rgb: [Math.max(0, (3.2406 * X - 1.5372 * Y - 0.4986 * Z) / Y), Math.max(0, (-0.9689 * X + 1.8758 * Y + 0.0415 * Z) / Y),
      Math.max(0, (0.0557 * X - 0.2040 * Y + 1.057 * Z) / Y)],
    log2Y: Math.log2(Y)
  };
}

export function createBlackbodyTable(): THREE.DataTexture {
  const size = BLACKBODY_SIZE;
  const data = new Uint16Array(size * 4);
  for (let i = 0; i < size; i++) {
    const { rgb, log2Y } = blackbodyColor(BLACKBODY_MIN_K * (BLACKBODY_MAX_K / BLACKBODY_MIN_K) ** (i / (size - 1)));
    for (let k = 0; k < 3; k++) data[i * 4 + k] = THREE.DataUtils.toHalfFloat(rgb[k]);
    data[i * 4 + 3] = THREE.DataUtils.toHalfFloat(log2Y);
  }
  const texture = new THREE.DataTexture(data, size, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// GLSL lookup: rgb chromaticity (Y = 1) and log2 of the visible luminance.
export const blackbodyLookup = `
vec4 blackbody(float temperature) {
  const float lo = ${BLACKBODY_MIN_K.toFixed(1)}, span = ${Math.log(BLACKBODY_MAX_K / BLACKBODY_MIN_K).toFixed(8)};
  float x = log(max(temperature, lo) / lo) / span;
  vec4 c = texture2D(colorMap, vec2((.5 + ${BLACKBODY_SIZE - 1}. * clamp(x, 0., 1.)) / ${BLACKBODY_SIZE}., .5));
  // Rayleigh-Jeans continuation above the table: Y ∝ T at fixed chromaticity.
  c.a += max(0., x - 1.) * span * 1.4426950409;
  return c;
}
`;

function randomSequence(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

export function createFallbackSky(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 1024;
  const context = canvas.getContext('2d')!;
  const random = randomSequence(203);
  context.fillStyle = '#060810';
  context.fillRect(0, 0, canvas.width, canvas.height);
  for (let i = 0; i < 12500; i++) {
    const x = random() * canvas.width;
    const y = Math.acos(2 * random() - 1) / Math.PI * canvas.height;
    const luminance = 40 + Math.floor(180 * random() ** 2);
    context.fillStyle = `rgb(${luminance},${luminance + 3},${luminance + 9})`;
    context.fillRect(x, y, random() ** 4 * 2.2 + 0.5, 1);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  return texture;
}
