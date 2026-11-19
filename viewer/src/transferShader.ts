import photosphereShape from '../../src/photosphere.inl?raw';
import flowSampling from '../../src/flow/sampling.inl?raw';
import diskTurbulence from '../../src/disk_turbulence.inl?raw';

import { viewportCommon } from './shaderCommon';
import { BLACKBODY_MIN_K, blackbodyLookup } from './emissionTextures';

export const transferShader = `
${viewportCommon}
uniform sampler2D orbitMap, observerMap, fluxMap, boundsMap, colorMap;
uniform highp sampler3D flowMap;
uniform float spin, innerR, outerR, diskHeight, flare;
uniform float absorption, peakTemp, brightness, turbulence;
uniform bool thin, photosphere, kinematic, gravity, staticPattern, diskEnabled;
// Companion star on the celestial sphere: world direction and cos(angular
// radius) in w (w > 1 disables it); linear radiance of its centre.
uniform vec4 companion;
uniform vec3 companionRadiance;

#define BH_INLINE
#define BH_TIME float
#define BH_EXP exp
#define BH_SQRT sqrt
#define BH_SIN sin
#define BH_COS cos
#define BH_LOG log
#define BH_MAX max
#define BH_MIN min
#define BH_ABS abs
#define BH_FLOOR_TIME floor
#define BH_FLOOR floor
${diskTurbulence}
#define FLOW_SAMPLER highp sampler3D
#define FLOW_PAIR vec2
#define FLOW_SAMPLE(a,u,v,i) texture(a,vec3(u,v,((i)+0.5)/32.0)).rg
${flowSampling}

#define PS_INLINE
#define PS_REAL float
#define PS_MIN min
#define PS_MAX max
${photosphereShape}

float surfaceField(float r, float mu) {
  return mu*mu - photosphereOpening2(r, innerR, outerR, diskHeight, flare);
}

${blackbodyLookup}

vec4 transfer; // accumulated emission in rgb, remaining transmittance in a
float referenceLogY;

void startTransfer() {
  transfer = vec4(0., 0., 0., 1.);
  referenceLogY = blackbody(peakTemp).a;
}

void emitDisk(float r, vec3 n, float shift, float fluidLength, float emissionTime, float incidence, float opticalDepth) {
  float H = diskHeight * (1. + flare * (r - innerR));
  float height = r * n.y / H;
  float density = thin ? 1. : exp(-0.5 * height * height);
  if (density < 0.002) return;
  float profileU = log(r / innerR) / log(outerR / innerR);
  float flux = texture2D(fluxMap, vec2((0.5 + 511. * profileU) / 512., .5)).r;
  float phi = atan(-n.z, n.x);
  // A ray pencil intersects the emitting surface over a larger area at
  // grazing incidence. Match an equal-area circular footprint to that ellipse.
  float projectedArea = thin ? max(.04, incidence) : 1.;
  float footprint = 2. * radius * tanHalfFov / (bufferHeight * r * sqrt(projectedArea));
  // Local heating relative to the annular mean: the recorded flow at large
  // scales and a sheared turbulent cascade below its grid, log-normal, mean 1.
  float power = 1.;
  if (turbulence > 0.) {
    float t = staticPattern ? 0. : emissionTime;
    float flowHeight = photosphere ? clamp(height / .8, -1., 1.) : clamp(height, -1., 1.);
    float activity = flow_field(flowMap, r, phi, t, spin, flowHeight);
    TurbulenceSample eddies = turbulence_field(flow_grain_radius(r, activity), phi, t, spin, footprint);
    power = turbulent_heating(activity, eddies, turbulence);
  }
  float coverage = 1. - turbulence * exp(-2.5 * power);
  if (!photosphere && coverage < .000001) return;
  float taper = smoothstep(innerR, innerR + .5, r) * (1. - smoothstep(.82 * outerR, outerR, r));
  // The area integral of sigma*T^4 follows the supplied radial flux. In a
  // surface element the emitting area is its covering fraction. In the
  // volume, the emissivity variation is shared between heat and column density.
  float columnFactor = sqrt(power);
  float heating = photosphere ? power : thin ? power / coverage : columnFactor;
  float temperature = peakTemp * shift * pow(max(flux * heating, 0.), .25);
  vec4 spectral = blackbody(temperature);
  vec3 chroma = spectral.rgb;
  // Below the table the optical Wien tail is negligible, but cold gas still absorbs.
  float radiance = temperature < ${BLACKBODY_MIN_K}. ? 0. : brightness * exp2(spectral.a - referenceLogY);
  if (thin) {
    float opacity = photosphere ? 1. : coverage * taper;
    if (opticalDepth >= 0.) opacity = 1. - exp(-opticalDepth/max(incidence,1.e-5));
    float angular = photosphere && incidence >= 0. ? photosphereLimb(incidence) : 1.;
    transfer.rgb += transfer.a * chroma * radiance * opacity * angular;
    transfer.a *= 1. - opacity;
  } else {
    float column = density * columnFactor * taper * sqrt(innerR / r) *
      fluidLength;
    float transmission = exp(-absorption * column);
    float emittedPath = absorption * column < .001 ? column : (1. - transmission) / absorption;
    transfer.rgb += transfer.a * chroma * radiance * .45 * emittedPath;
    transfer.a *= transmission;
  }
}


// A binary companion lies ~10^6 M away, so it is part of the sky at infinity.
// Linear limb darkening with u = 0.6 (solar-type photosphere in the optical).
vec3 companionStar(vec3 d) {
  float c = dot(d, companion.xyz);
  if (c <= companion.w) return vec3(0.);
  float edge = (1. - c * c) / max(1e-12, 1. - companion.w * companion.w);
  float limb = sqrt(max(0., 1. - edge));
  return companionRadiance * (.4 + .6 * limb);
}

void sampleSky(vec3 d, float visibility) {
  vec3 sky = skyRadiance(d);
  transfer.rgb += visibility * transfer.a * (sky + companionStar(d));
}

void finishTransfer() {
  writeRadiance(transfer.rgb);
}
`;
