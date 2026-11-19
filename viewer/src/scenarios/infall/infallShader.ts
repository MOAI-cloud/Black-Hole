// Additions to the Kerr geodesic shader for the infall scenario (INFALL).
//
// The falling body is an opaque, thermally glowing dust ellipsoid whose centre,
// four-velocity, proper time and Jacobi stretch are tabulated uniformly in
// Boyer–Lindquist coordinate time. Each ray samples the body at its own
// retarded emission time, so a distant camera sees the light-travel delay, the
// exponential redshift and the freezing of the image at the horizon. The
// observed temperature is g T with g from the body's four-velocity and the
// photon momentum on that ray. A beacon flashes at fixed proper-time intervals.
//
// With a ride-along camera the observer is boosted from its local ZAMO frame
// to the body's velocity: pixel directions are aberrated and the camera
// frequency is Doppler shifted, which rescales every received frequency.
import { BLACKBODY_MIN_K } from '../../emissionTextures';

export const infallShader = `
#ifdef INFALL
uniform sampler2D bodyTrack;   // rows: (r, cos θ, φ, τ), (u^t, u^r, u^θ, u^φ), (stretch radial, orbital, polar)
uniform vec3 bodyTrackSpan;    // last tabulated time, sample count, horizon angular velocity
uniform vec4 bodyLook;         // radius (M), temperature (K), emission scale, beacon period (M of proper time)
uniform bool bodyVisible;
uniform vec4 observerBoost;    // camera velocity relative to its ZAMO in world axes, and its Lorentz factor (w = 0: none)

struct Body { vec3 centre; vec3 radial; vec3 polar; vec3 orbital; vec3 axes; vec4 velocity; float tau; };

Body bodyAt(float t) {
  float n = bodyTrackSpan.y;
  float x = clamp(t / bodyTrackSpan.x, 0., 1.) * (n - 1.);
  int i = int(floor(x)), j = min(i + 1, int(n) - 1);
  float f = x - float(i);
  vec4 p = mix(texelFetch(bodyTrack, ivec2(i, 0), 0), texelFetch(bodyTrack, ivec2(j, 0), 0), f);
  Body b;
  b.velocity = mix(texelFetch(bodyTrack, ivec2(i, 1), 0), texelFetch(bodyTrack, ivec2(j, 1), 0), f);
  vec3 stretch = mix(texelFetch(bodyTrack, ivec2(i, 2), 0), texelFetch(bodyTrack, ivec2(j, 2), 0), f).xyz;
  // After the last sample the frozen image co-rotates with the horizon.
  float phi = p.z + bodyTrackSpan.z * max(0., t - bodyTrackSpan.x);
  float sinTheta = sqrt(max(0., 1. - p.y * p.y));
  b.radial = vec3(sinTheta * cos(phi), p.y, -sinTheta * sin(phi));
  b.polar = vec3(p.y * cos(phi), -sinTheta, -p.y * sin(phi));
  b.orbital = vec3(-sin(phi), 0., -cos(phi));
  b.centre = p.x * b.radial;
  b.axes = bodyLook.x * vec3(stretch.x, stretch.z, stretch.y);
  b.tau = p.w;
  return b;
}

vec3 bodyLocal(Body b, vec3 point) {
  vec3 d = point - b.centre;
  return vec3(dot(d, b.radial), dot(d, b.polar), dot(d, b.orbital)) / b.axes;
}

// Entry fraction of a straight chord through the ellipsoid, or -1.
float bodyEntry(Body b, vec3 from, vec3 to) {
  vec3 A = bodyLocal(b, from), D = bodyLocal(b, to) - A;
  float dd = dot(D, D), ad = dot(A, D), aa = dot(A, A) - 1.;
  if (aa <= 0.) return 0.;
  float disc = ad * ad - dd * aa;
  if (disc < 0. || dd < 1e-12) return -1.;
  float f = (-ad - sqrt(disc)) / dd;
  return f >= 0. && f <= 1. ? f : -1.;
}

// Fluid-frame frequency over camera frequency for the body's four-velocity.
float bodyFrequency(vec4 q, vec4 velocity, vec4 u4) {
  float r = 1. / q.w, mu = q.y, r2 = r * r;
  float sinTheta = sqrt(max(1e-8, 1. - mu * mu));
  float delta = r2 - 2. * r + a2;
  return energy * (u4.x - ell * u4.w - velocity.w / (q.w * q.w * delta) * u4.y - velocity.y / sinTheta * u4.z);
}

void emitBody(vec4 q, vec4 next, vec2 clock, vec2 nextClock, vec4 velocity) {
  // A step that leaves to infinity (u <= 0) has no finite end point.
  if (!bodyVisible || transfer.a <= 0. || next.w <= 1e-4 || q.w <= 1e-4) return;
  Body b = bodyAt(timeM - .5 * (clock.x + nextClock.x));
  vec3 from = applyDrag(q.xyz, clock.y) / q.w, to = applyDrag(next.xyz, nextClock.y) / next.w;
  float f = bodyEntry(b, from, to);
  if (f < 0.) return;
  float ratio = bodyFrequency(mix(q, next, f), velocity, b.velocity);
  if (ratio > 0.) {
    float g = 1. / ratio;
    float temperature = g * bodyLook.y;
    vec4 spectral = blackbody(temperature);
    float phase = fract(b.tau / bodyLook.w + .5) - .5;
    float beacon = 1. + 5. * exp(-.5 * pow(phase * bodyLook.w / .5, 2.));
    float radiance = temperature < ${BLACKBODY_MIN_K}. ? 0. : bodyLook.z * beacon * exp2(spectral.a - referenceLogY);
    transfer.rgb += transfer.a * spectral.rgb * radiance;
  }
  transfer.a = 0.;
}

// Keep each Mino step from jumping across the body.
float bodyStep(vec4 q, vec4 velocity, vec2 clock) {
  if (!bodyVisible) return 1e9;
  Body b = bodyAt(timeM - clock.x);
  float d = length(applyDrag(q.xyz, clock.y) / q.w - b.centre);
  float size = max(b.axes.x, max(b.axes.y, b.axes.z));
  // Only near the body: far away the bound would shrink like 1/r and keep an
  // escaping ray from ever reaching u = 0.
  if (d > 4. * size + 2.) return 1e9;
  float speed = sqrt(velocity.w * velocity.w / (q.w * q.w * q.w * q.w) + dot(velocity.xyz, velocity.xyz) / (q.w * q.w));
  return .4 * max(d - 1.2 * size, .35 * min(b.axes.x, min(b.axes.y, b.axes.z))) / max(speed, 1e-6);
}
#endif
`;
