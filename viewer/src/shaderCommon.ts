import { encodeRadiance } from './cameraOptics';

// Camera, sky and output conventions shared by every full-screen ray pass.
//
// World axes: +y is the black hole's spin (polar) axis. Azimuth phi has
// x = cos(phi), -z = sin(phi). The observer sits at radius * cameraAxes[2]
// and looks toward the origin. cameraAxes columns are (right, up, back), so a
// pixel's propagation direction in world axes is
//   cameraAxes * normalize(vec3(raySlope(), -1.)).
// Radiance is linear and scene-referred. writeRadiance() applies the exposure
// and either encodes the value for the camera-optics pass or tone maps it.
export const viewportCommon = `
varying vec2 screen;
uniform sampler2D skyMap;
uniform mat3 cameraAxes;
uniform vec2 cameraRoll;
uniform float radius, aspect, tanHalfFov, bufferHeight, timeM, skyBrightness, exposure;
uniform bool opticalPass;
const float pi = 3.14159265359;

vec2 raySlope() {
  vec2 s = screen * vec2(aspect, 1.) * tanHalfFov;
  return mat2(cameraRoll.x, cameraRoll.y, -cameraRoll.y, cameraRoll.x) * s;
}

// Equirectangular sky radiance along an asymptotic world direction. Call it in
// uniform control flow: the texture footprint comes from screen derivatives.
vec3 skyRadiance(vec3 d) {
  vec2 uv = vec2(.5 + atan(-d.z, d.x) / (2. * pi), .5 + asin(clamp(d.y, -1., 1.)) / pi);
  // Keep the texture footprint local when neighbouring longitudes wrap 1 -> 0.
  vec2 dx = dFdx(uv), dy = dFdy(uv);
  dx.x -= floor(dx.x + .5);
  dy.x -= floor(dy.x + .5);
  return skyBrightness * textureGrad(skyMap, uv, dx, dy).rgb;
}

${encodeRadiance}

// Hue-preserving display transform. Luminance follows a filmic curve and the
// chromaticity is kept until the brightest highlights, which converge to
// white along a path that keeps hot gas from turning into flat, grey "sheen".
vec3 displayTransform(vec3 c) {
  float luma = dot(c, vec3(.2126, .7152, .0722));
  float mapped = luma * (2.51 * luma + .03) / (luma * (2.43 * luma + .59) + .14);
  vec3 hue = c * (mapped / max(luma, 1e-6));
  vec3 perChannel = clamp(c * (2.51 * c + .03) / (c * (2.43 * c + .59) + .14), 0., 1.);
  float white = smoothstep(.55, 1., mapped);
  return clamp(mix(hue, perChannel, white * white), 0., 1.);
}

void writeRadiance(vec3 radiance) {
  vec3 c = max(vec3(0.), exposure * radiance);
  if (opticalPass) { gl_FragColor = encodeRadiance(c); return; }
  gl_FragColor = vec4(displayTransform(c), 1.);
  #include <colorspace_fragment>
}
`;
