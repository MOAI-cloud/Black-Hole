import * as THREE from 'three';

const vertexShader = `
void main() { gl_Position = vec4(position.xy, 0., 1.); }
`;

// Average k × k blocks of the brightness-temperature image.
const reduceFragment = `
uniform sampler2D source;
uniform int bin;
void main() {
  ivec2 base = ivec2(gl_FragCoord.xy) * bin;
  ivec2 size = textureSize(source, 0);
  float sum = 0., count = 0.;
  for (int y = 0; y < 8; y++) {
    if (y >= bin) break;
    for (int x = 0; x < 8; x++) {
      if (x >= bin) break;
      ivec2 p = base + ivec2(x, y);
      if (any(greaterThanEqual(p, size))) continue;
      sum += texelFetch(source, p, 0).r;
      count += 1.;
    }
  }
  gl_FragColor = vec4(sum / max(count, 1.), 0., 0., 1.);
}
`;

// Separable Gaussian, ±3σ with linear-filtered taps.
const blurFragment = `
uniform sampler2D source;
uniform vec2 direction;
uniform float sigma;
void main() {
  vec2 size = vec2(textureSize(source, 0));
  vec2 uv = gl_FragCoord.xy / size;
  float total = texture2D(source, uv).r, weights = 1.;
  for (int i = 1; i <= 24; i++) {
    float x = float(i) * max(sigma, .5) / 8.;
    if (x > 3. * sigma) break;
    float w = exp(-.5 * x * x / (sigma * sigma));
    vec2 offset = direction * x / size;
    total += w * (texture2D(source, uv + offset).r + texture2D(source, uv - offset).r);
    weights += 2. * w;
  }
  gl_FragColor = vec4(total / weights, 0., 0., 1.);
}
`;

// Same false-colour map as writeBrightnessTemperature().
const displayFragment = `
uniform sampler2D source;
uniform vec2 screenSize;
void main() {
  float x = max(0., texture2D(source, gl_FragCoord.xy / screenSize).r);
  x = x / (1. + .35 * x);
  vec3 c = clamp(vec3(2. * x, 2. * x - .5, 2. * x - 1.), 0., 1.);
  gl_FragColor = vec4(c * c, 1.);
  #include <colorspace_fragment>
}
`;

/**
 * Convolves the 230 GHz brightness-temperature image with a circular
 * Gaussian telescope beam, as in the Event Horizon Telescope images
 * (restoring beam ≈ 20 μas FWHM). The scene renders brightness temperature
 * into a float target; the beam is applied on a reduced grid, which the
 * smooth result tolerates, then the colour map is applied.
 */
export class TelescopeBeam {
  private readonly source = this.target();
  private readonly low = [this.target(), this.target()];
  private readonly reduce = this.pass(reduceFragment, { source: { value: null }, bin: { value: 1 } });
  private readonly blur = this.pass(blurFragment, { source: { value: null }, direction: { value: new THREE.Vector2(1, 0) }, sigma: { value: 1 } });
  private readonly display = this.pass(displayFragment, { source: { value: null }, screenSize: { value: new THREE.Vector2(1, 1) } });
  private readonly quad: THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
  private readonly stage = new THREE.Scene();

  constructor(private readonly renderer: THREE.WebGLRenderer, geometry: THREE.BufferGeometry) {
    this.quad = new THREE.Mesh(geometry, this.reduce);
    this.quad.frustumCulled = false;
    this.stage.add(this.quad);
  }

  private target(): THREE.WebGLRenderTarget {
    return new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false
    });
  }

  private pass(fragmentShader: string, uniforms: Record<string, THREE.IUniform>): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({ vertexShader, fragmentShader, uniforms, depthTest: false, depthWrite: false });
  }

  /** Render `scene` (which must output brightness temperature in .r) through a beam of `sigma` pixels. */
  draw(scene: THREE.Scene, camera: THREE.Camera, width: number, height: number, sigma: number): void {
    const renderer = this.renderer;
    if (this.source.width !== width || this.source.height !== height) this.source.setSize(width, height);
    renderer.setRenderTarget(this.source);
    renderer.render(scene, camera);
    const bin = Math.max(1, Math.min(8, Math.floor(sigma / 3)));
    const w = Math.max(1, Math.ceil(width / bin)), h = Math.max(1, Math.ceil(height / bin));
    for (const target of this.low) if (target.width !== w || target.height !== h) target.setSize(w, h);
    const run = (material: THREE.ShaderMaterial, target: THREE.WebGLRenderTarget | null) => {
      this.quad.material = material;
      renderer.setRenderTarget(target);
      renderer.render(this.stage, camera);
    };
    this.reduce.uniforms.source.value = this.source.texture;
    this.reduce.uniforms.bin.value = bin;
    run(this.reduce, this.low[0]);
    this.blur.uniforms.sigma.value = sigma / bin;
    this.blur.uniforms.source.value = this.low[0].texture;
    this.blur.uniforms.direction.value.set(1, 0);
    run(this.blur, this.low[1]);
    this.blur.uniforms.source.value = this.low[1].texture;
    this.blur.uniforms.direction.value.set(0, 1);
    run(this.blur, this.low[0]);
    this.display.uniforms.source.value = this.low[0].texture;
    this.display.uniforms.screenSize.value.set(width, height);
    run(this.display, null);
  }

  dispose(): void {
    for (const item of [this.source, ...this.low, this.reduce, this.blur, this.display]) item.dispose();
  }
}
