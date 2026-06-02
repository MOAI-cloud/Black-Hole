import * as THREE from 'three';

const whitespace = new Set([9, 10, 12, 13, 32]);

function skipWhitespaceAndComments(bytes: Uint8Array, startIndex: number): number {
  let currentIndex = startIndex;

  while (currentIndex < bytes.length) {
    while (currentIndex < bytes.length && whitespace.has(bytes[currentIndex])) {
      currentIndex += 1;
    }

    if (bytes[currentIndex] !== 35) {
      break;
    }

    while (currentIndex < bytes.length && bytes[currentIndex] !== 10) {
      currentIndex += 1;
    }
  }

  return currentIndex;
}

function readToken(bytes: Uint8Array, startIndex: number): { token: string; nextIndex: number } {
  const tokenStart = skipWhitespaceAndComments(bytes, startIndex);
  let tokenEnd = tokenStart;
  while (tokenEnd < bytes.length && !whitespace.has(bytes[tokenEnd])) {
    tokenEnd += 1;
  }
  const token = new TextDecoder().decode(bytes.slice(tokenStart, tokenEnd));
  return { token, nextIndex: tokenEnd };
}

function findRasterStart(bytes: Uint8Array, headerEndIndex: number): number {
  let rasterStart = headerEndIndex;
  if (bytes[rasterStart] === 13 && bytes[rasterStart + 1] === 10) {
    return rasterStart + 2;
  }
  if (whitespace.has(bytes[rasterStart])) {
    rasterStart += 1;
  }
  return rasterStart;
}

export async function loadPpmTexture(url: string): Promise<THREE.DataTexture> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not load ${url}`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  const magic = readToken(bytes, 0);
  if (magic.token !== 'P6') {
    throw new Error('Only binary P6 PPM star maps are supported');
  }

  const widthToken = readToken(bytes, magic.nextIndex);
  const heightToken = readToken(bytes, widthToken.nextIndex);
  const maxToken = readToken(bytes, heightToken.nextIndex);
  const width = Number.parseInt(widthToken.token, 10);
  const height = Number.parseInt(heightToken.token, 10);
  const maxValue = Number.parseInt(maxToken.token, 10);
  const pixelStart = findRasterStart(bytes, maxToken.nextIndex);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Invalid PPM dimensions');
  }
  if (maxValue !== 255) {
    throw new Error('Only 8-bit PPM star maps are supported');
  }

  const expectedBytes = width * height * 3;
  const pixels = bytes.slice(pixelStart, pixelStart + expectedBytes);
  if (pixels.length !== expectedBytes) {
    throw new Error('PPM pixel data is truncated');
  }

  const rgbaPixels = new Uint8Array(width * height * 4);
  for (let sourceIndex = 0, targetIndex = 0; sourceIndex < pixels.length; sourceIndex += 3, targetIndex += 4) {
    rgbaPixels[targetIndex] = pixels[sourceIndex];
    rgbaPixels[targetIndex + 1] = pixels[sourceIndex + 1];
    rgbaPixels[targetIndex + 2] = pixels[sourceIndex + 2];
    rgbaPixels[targetIndex + 3] = 255;
  }

  const texture = new THREE.DataTexture(rgbaPixels, width, height, THREE.RGBAFormat, THREE.UnsignedByteType);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}
