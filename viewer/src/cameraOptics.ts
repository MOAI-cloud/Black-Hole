import * as THREE from 'three';
import response from '../../src/film_response.inl?raw';

const vertexShader = `
void main() { gl_Position = vec4(position.xy, 0., 1.); }
`;

export const encodeRadiance = `
vec4 encodeRadiance(vec3 c) {
  #ifdef PACK_RADIANCE
    float peak = max(max(c.r, c.g), c.b);
    float exponent = clamp(ceil(log2(max(peak, 1e-30))), -100., 100.);
    return vec4(c * exp2(-exponent), (exponent + 128.) / 255.);
  #else
    return vec4(min(c, vec3(65000.)), 1.);
  #endif
}
`;

const preamble = `
#define FILM_FN
#define FILM_MAX max
#define FILM_POW pow
#define FILM_RGB vec3
#define FILM_MAKE_RGB vec3
${response}
${encodeRadiance}

vec3 readPixel(sampler2D image, ivec2 p) {
  vec4 sampleValue = texelFetch(image, clamp(p, ivec2(0), textureSize(image, 0) - 1), 0);
  #ifdef PACK_RADIANCE
    return sampleValue.rgb * exp2(round(sampleValue.a * 255.) - 128.);
  #else
    return sampleValue.rgb;
  #endif
}

vec3 interpolateImage(sampler2D image, vec2 pixel) {
  #ifdef PACK_RADIANCE
    vec2 f = fract(pixel);
    ivec2 p = ivec2(floor(pixel));
    return mix(mix(readPixel(image, p), readPixel(image, p + ivec2(1, 0)), f.x),
               mix(readPixel(image, p + ivec2(0, 1)), readPixel(image, p + ivec2(1)), f.x), f.y);
  #else
    return texture2D(image, (pixel + .5) / vec2(textureSize(image, 0))).rgb;
  #endif
}
`;

const seedFragment = `
uniform sampler2D source;
uniform int bin;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * bin;
  ivec2 size = textureSize(source, 0);
  vec3 sum = vec3(0.);
  float count = 0.;
  for (int y = 0; y < bin; y++) {
    for (int x = 0; x < bin; x++) {
      ivec2 p = base + ivec2(x, y);
      if (any(greaterThanEqual(p, size))) continue;
      sum += readPixel(source, p);
      count += 1.;
    }
  }
  gl_FragColor = encodeRadiance(sum / count);
}
`;

const blurFragment = `
uniform sampler2D source;
uniform vec2 offset;
void main() {
  vec2 p = gl_FragCoord.xy - .5;
  // Normalized nine-tap binomial. Its variance is two sample spacings squared.
  vec3 c = 70. * readPixel(source, ivec2(gl_FragCoord.xy));
  c += 56. * (interpolateImage(source, p - offset) + interpolateImage(source, p + offset));
  c += 28. * (interpolateImage(source, p - 2. * offset) + interpolateImage(source, p + 2. * offset));
  c += 8. * (interpolateImage(source, p - 3. * offset) + interpolateImage(source, p + 3. * offset));
  c += interpolateImage(source, p - 4. * offset) + interpolateImage(source, p + 4. * offset);
  gl_FragColor = encodeRadiance(c / 256.);
}
`;

const displayFragment = `
uniform sampler2D source, nearWing, middleWing, farWing;
uniform vec3 invStride;
void main() {
  vec2 pos = gl_FragCoord.xy;
  vec3 d = readPixel(source, ivec2(pos));
  vec3 n = interpolateImage(nearWing, pos * invStride.x - .5);
  vec3 m = interpolateImage(middleWing, pos * invStride.y - .5);
  vec3 f = interpolateImage(farWing, pos * invStride.z - .5);
  vec3 c = vec3(film_irradiance(d.r, n.r, m.r, f.r), film_irradiance(d.g, n.g, m.g, f.g),
                film_irradiance(d.b, n.b, m.b, f.b));
  c = film_balance(c);
  float peak = max(max(c.r, c.g), c.b);
  float peakResponse = film_shoulder(peak);
  gl_FragColor = vec4(film_channel(c.r, peak, peakResponse), film_channel(c.g, peak, peakResponse),
                      film_channel(c.b, peak, peakResponse), 1.);
  #include <colorspace_fragment>
}
`;

// The ray pass always runs at the actual drawing-buffer resolution. Only
// scattered light is downsampled, so the direct disk retains every ray sample.
export class CameraOptics {
  readonly packed: boolean;
  private readonly source: THREE.WebGLRenderTarget;
  private readonly bands: {
    radius: number; field: THREE.WebGLRenderTarget; scratch: THREE.WebGLRenderTarget;
    bin: number; stride: number; spacing: number;
  }[];
  private readonly seed: THREE.ShaderMaterial;
  private readonly blur: THREE.ShaderMaterial;
  private readonly display: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly stage = new THREE.Scene();

  constructor(private readonly renderer: THREE.WebGLRenderer, geometry: THREE.BufferGeometry) {
    this.packed = !(renderer.extensions.has('EXT_color_buffer_float') || renderer.extensions.has('EXT_color_buffer_half_float'));
    const target = () => new THREE.WebGLRenderTarget(1, 1, {
      type: this.packed ? THREE.UnsignedByteType : THREE.HalfFloatType,
      minFilter: this.packed ? THREE.NearestFilter : THREE.LinearFilter,
      magFilter: this.packed ? THREE.NearestFilter : THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false,
    });
    this.source = target();
    this.bands = [.004, .023, .096].map(radius => ({
      radius, field: target(), scratch: target(), bin: 1, stride: 1, spacing: 0
    }));
    const pass = (fragment: string, uniforms: THREE.ShaderMaterialParameters['uniforms']) =>
      new THREE.ShaderMaterial({ vertexShader, fragmentShader: preamble + fragment, uniforms,
        defines: this.packed ? { PACK_RADIANCE: 1 } : {}, depthTest: false, depthWrite: false });
    this.seed = pass(seedFragment, { source: { value: null }, bin: { value: 1 } });
    this.blur = pass(blurFragment, { source: { value: null }, offset: { value: new THREE.Vector2() } });
    this.display = pass(displayFragment, {
      source: { value: this.source.texture }, nearWing: { value: this.bands[0].field.texture },
      middleWing: { value: this.bands[1].field.texture }, farWing: { value: this.bands[2].field.texture },
      invStride: { value: new THREE.Vector3(1, 1, 1) }
    });
    this.quad = new THREE.Mesh(geometry, this.seed);
    this.quad.frustumCulled = false;
    this.stage.add(this.quad);
  }

  draw(rayScene: THREE.Scene, camera: THREE.Camera, width: number, height: number): void {
    const renderer = this.renderer;
    this.resize(width, height);
    renderer.setRenderTarget(this.source);
    renderer.render(rayScene, camera);
    const run = (pass: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = pass;
      renderer.setRenderTarget(target);
      renderer.render(this.stage, camera);
    };
    let input = this.source.texture;
    for (const band of this.bands) {
      this.seed.uniforms.source.value = input;
      this.seed.uniforms.bin.value = band.bin;
      run(this.seed, band.field);
      this.blur.uniforms.source.value = band.field.texture;
      this.blur.uniforms.offset.value.set(band.spacing, 0);
      run(this.blur, band.scratch);
      this.blur.uniforms.source.value = band.scratch.texture;
      this.blur.uniforms.offset.value.set(0, band.spacing);
      run(this.blur, band.field);
      input = band.field.texture;
    }
    run(this.display, null);
  }

  private resize(width: number, height: number): void {
    if (this.source.width === width && this.source.height === height) return;
    this.source.setSize(width, height);
    let stride = 1, w = width, h = height, previousSigma = 0;
    for (const band of this.bands) {
      const sigma = band.radius * Math.min(width, height);
      band.bin = 1;
      while (band.bin < 8 && 2.5 * band.bin * stride <= sigma) band.bin *= 2;
      band.stride = stride * band.bin;
      w = Math.ceil(w / band.bin);
      h = Math.ceil(h / band.bin);
      band.field.setSize(w, h);
      band.scratch.setSize(w, h);
      // The previous band and the area reduction have already blurred the image.
      const binVariance = (band.stride ** 2 - stride ** 2) / 12;
      const variance = Math.max(0, sigma ** 2 - previousSigma ** 2 - binVariance);
      band.spacing = Math.sqrt(.5 * variance) / band.stride;
      previousSigma = sigma;
      stride = band.stride;
    }
    const [near, middle, far] = this.bands;
    this.display.uniforms.invStride.value.set(1 / near.stride, 1 / middle.stride, 1 / far.stride);
  }

  dispose(): void {
    for (const band of this.bands) { band.field.dispose(); band.scratch.dispose(); }
    for (const item of [this.source, this.seed, this.blur, this.display]) item.dispose();
  }
}
