import { viewportCommon } from '../../shaderCommon';

export const TEXTURE_WIDTH = 1024;

// Null geodesics in an approximate binary-black-hole spacetime.
//
// Each hole is a boosted Kerr–Schild black hole, g = eta + 2 H l l. The ray
// Hamiltonian uses the superposed inverse metric
//   g^{mu nu} ~ eta^{mu nu} - sum_i 2 H_i l_i^mu l_i^nu,
// which is exact for a single hole and correct to first order in the overlap
// H_1 H_2 (the usual superposed Kerr–Schild construction for binary initial data).
// Hole positions and velocities come from the EOB dynamics at each ray's own
// coordinate time, so the image includes light-travel delay across the system.
// Near merger the binary fades into the remnant Kerr hole at the origin.
// Kerr–Schild axes (X, Y, Z) map to world (z, x, y): the spin points along +y.
export const binaryFragmentShader = `
${viewportCommon}
uniform highp sampler2D trajectoryMap, waveMap;
uniform vec3 trajectoryTiming;   // start, step, count (M)
uniform vec3 waveTiming;         // start, step, count (M)
uniform vec4 holes;              // m1, m2, a1, a2 (Kerr–Schild a = chi m)
uniform vec2 levers;             // m2/M, m1/M: distance of each hole from the centre of mass in units of r
uniform vec2 remnantHole;        // M_f, a_f
uniform vec2 blendWindow;        // binary -> remnant (M)
uniform float eventTime;         // observer coordinate time, M
uniform float waveGain, trailWidth;
uniform bool showWaves, showTrails;

const int TEXTURE_W = ${TEXTURE_WIDTH};

vec4 fetchTrajectory(int i) {
  return texelFetch(trajectoryMap, ivec2(i % TEXTURE_W, i / TEXTURE_W), 0);
}

// (r, phi, dr/dt, dphi/dt) of the relative orbit; phi is body 1's azimuth.
vec4 orbitAt(float t) {
  float x = clamp((t - trajectoryTiming.x) / trajectoryTiming.y, 0., trajectoryTiming.z - 1.001);
  int i = int(x);
  return mix(fetchTrajectory(i), fetchTrajectory(i + 1), x - float(i));
}

float remnantWeight(float t) {
  return smoothstep(blendWindow.x, blendWindow.y, t);
}

// Boosted Kerr–Schild hole. Adds its terms to dx^mu/dlambda and dp_mu/dlambda.
// Returns the Kerr–Schild radius relative to the outer horizon.
float addHole(vec4 X, vec4 P, vec3 centre, vec3 velocity, float m, float a, float weight,
              inout vec4 dX, inout vec4 dP) {
  float v2 = min(dot(velocity, velocity), .81);
  float gamma = inversesqrt(1. - v2);
  // Branch-free unit vector: a hole at rest gives vhat = 0 instead of 0 * inf = NaN.
  vec3 vhat = velocity * inversesqrt(max(v2, 1e-24));
  vec3 delta = X.yzw - centre;
  // Rest-frame position and covector (Lorentz boost with the hole's velocity).
  vec3 xr = delta + (gamma - 1.) * dot(vhat, delta) * vhat;
  float ptr = gamma * (P.x + dot(velocity, P.yzw));
  vec3 pr = P.yzw + (gamma - 1.) * dot(vhat, P.yzw) * vhat + gamma * velocity * P.x;
  vec3 K = vec3(xr.z, xr.x, xr.y);
  vec3 Q = vec3(pr.z, pr.x, pr.y);
  float a2 = a * a;
  float w = dot(K, K) - a2;
  float r2 = .5 * (w + sqrt(w * w + 4. * a2 * K.z * K.z));
  r2 = max(r2, 1e-8);
  float r = sqrt(r2);
  float W = r2 * r2 + a2 * K.z * K.z;
  float H = m * r2 * r / W;
  float ra = r2 + a2;
  vec3 l = vec3((r * K.x + a * K.y) / ra, (r * K.y - a * K.x) / ra, K.z / r);
  float L = -ptr + dot(l, Q);
  vec3 dr = (r2 * r / W) * vec3(K.x, K.y, K.z * ra / r2);
  vec3 dH = (m * r2 * (3. * a2 * K.z * K.z - r2 * r2) / (W * W)) * dr;
  dH.z -= 2. * m * a2 * r2 * r * K.z / (W * W);
  float c = (Q.x * (K.x * (a2 - r2) - 2. * a * r * K.y) + Q.y * (K.y * (a2 - r2) + 2. * a * r * K.x)) / (ra * ra)
          - Q.z * K.z / r2;
  vec3 dL = vec3((r * Q.x - a * Q.y) / ra, (a * Q.x + r * Q.y) / ra, Q.z / r) + c * dr;
  vec3 g = weight * (L * L * dH + 2. * H * L * dL);
  // Back to world axes, then to the coordinates in which the hole moves.
  vec3 gw = vec3(g.y, g.z, g.x);
  vec3 gs = gw + (gamma - 1.) * dot(vhat, gw) * vhat;
  dP += vec4(-gamma * dot(velocity, gw), gs);
  vec3 lw = vec3(l.y, l.z, l.x);
  float lt = gamma * (-1. + dot(velocity, lw));
  vec3 ls = lw + (gamma - 1.) * dot(vhat, lw) * vhat - gamma * velocity;
  dX -= 2. * weight * H * L * vec4(lt, ls);
  float horizon = m + sqrt(max(0., m * m - a2));
  return r / horizon;
}

struct Holes { vec3 c1, v1, c2, v2; float blend; };

Holes holesAt(float t) {
  vec4 o = orbitAt(t);
  vec3 n = vec3(cos(o.y), 0., -sin(o.y));
  vec3 e = vec3(-sin(o.y), 0., -cos(o.y));
  vec3 rel = o.x * n, relV = o.z * n + o.x * o.w * e;
  Holes h;
  h.c1 = levers.x * rel; h.v1 = levers.x * relV;
  h.c2 = -levers.y * rel; h.v2 = -levers.y * relV;
  h.blend = remnantWeight(t);
  return h;
}

// Hamilton's equations; returns the smallest horizon-relative radius.
float derivatives(vec4 X, vec4 P, out vec4 dX, out vec4 dP) {
  dX = vec4(-P.x, P.yzw);
  dP = vec4(0.);
  Holes h = holesAt(X.x);
  float closest = 1e9;
  if (h.blend < 1.) {
    float wb = 1. - h.blend;
    closest = min(closest, addHole(X, P, h.c1, h.v1, holes.x, holes.z, wb, dX, dP));
    closest = min(closest, addHole(X, P, h.c2, h.v2, holes.y, holes.w, wb, dX, dP));
  }
  if (h.blend > 0.) {
    float rr = addHole(X, P, vec3(0.), vec3(0.), remnantHole.x, remnantHole.y, h.blend, dX, dP);
    // (mix(1e9, rr, 1.) would cancel to 0 in single precision.)
    if (h.blend >= .35) closest = min(closest, rr);
  }
  return closest;
}

// Distance to the nearest hole; RK steps are a fixed fraction of it.
float nearestHole(vec3 x, float t) {
  Holes h = holesAt(t);
  float d = 1e9;
  if (h.blend < 1.) d = min(length(x - h.c1), length(x - h.c2));
  if (h.blend > 0.) d = min(d, length(x));
  return d;
}

// Initial covector: spatial part along the pixel direction, p_t from H = 0,
// on the branch that traces the ray into the past.
vec4 initialMomentum(vec4 X, vec3 dir) {
  vec4 dX, dP;
  // Probe the quadratic in p_t with three samples of the Hamiltonian.
  float hm = 0., h0 = 0., hp = 0.;
  for (int k = -1; k <= 1; k++) {
    vec4 P = vec4(1. + float(k), dir);
    derivatives(X, P, dX, dP);
    // H = 1/2 eta p p - sum H L^2; recover it from dX = eta p - 2 sum H L l.
    // Since H is quadratic in p, 2H = p_mu dX^mu.
    float value = .5 * dot(P, dX);
    if (k == -1) hm = value; else if (k == 0) h0 = value; else hp = value;
  }
  // H(p_t) = A (p_t - 1)^2 + B (p_t - 1) + C with samples at p_t = 0, 1, 2.
  float A = .5 * (hp + hm) - h0, B = .5 * (hp - hm), C = h0;
  float disc = max(0., B * B - 4. * A * C);
  float root = abs(A) > 1e-9 ? (-B - sign(A) * sqrt(disc)) / (2. * A) : -C / B;
  // Two roots straddle zero for a null cone; pick the one nearest p_t = 1.
  float other = abs(A) > 1e-9 ? C / (A * root) : root;
  float s = abs(root) < abs(other) ? root : other;
  return vec4(1. + s, dir);
}

vec3 diverging(float v) {
  return v > 0. ? vec3(1., .6, .26) : vec3(.3, .62, 1.);
}

// Plus polarization in the orbital plane at azimuth psi from the stored modes.
float planeStrain(float u, float psi) {
  float x = (u - waveTiming.x) / waveTiming.y;
  if (x < 0. || x > waveTiming.z - 1.001) return 0.;
  int i = int(x);
  float f = x - float(i);
  vec4 a0 = texelFetch(waveMap, ivec2((2 * i) % TEXTURE_W, (2 * i) / TEXTURE_W), 0);
  vec4 a1 = texelFetch(waveMap, ivec2((2 * i + 2) % TEXTURE_W, (2 * i + 2) / TEXTURE_W), 0);
  vec4 b0 = texelFetch(waveMap, ivec2((2 * i + 1) % TEXTURE_W, (2 * i + 1) / TEXTURE_W), 0);
  vec4 b1 = texelFetch(waveMap, ivec2((2 * i + 3) % TEXTURE_W, (2 * i + 3) / TEXTURE_W), 0);
  vec4 a = mix(a0, a1, f), b = mix(b0, b1, f);
  // In the orbital plane h_x = 0 and h_lm Y_lm + h_l,-m Y_l,-m = c_lm A_lm cos(Phi_lm + m psi),
  // c_lm = _{-2}Y_lm(pi/2, 0) + (-1)^l _{-2}Y_l,-m(pi/2, 0).
  return .31539157 * a.x * cos(a.y + 2. * psi) - .45704580 * a.z * cos(a.w + 3. * psi)
       + .63078313 * b.x * cos(b.y + psi) + .55976450 * b.z * cos(b.w + 4. * psi);
}

// Lensed trail of each hole's past positions in the orbital plane.
float trail(vec3 point, float t, float lever, float offset) {
  float rho = length(point.xz);
  float target = rho / lever;
  // Binary search for the time at which the relative separation was rho/lever.
  int lo = 0, hi = int(trajectoryTiming.z) - 1;
  if (fetchTrajectory(lo).x < target || fetchTrajectory(hi).x > target) return 0.;
  for (int k = 0; k < 18; k++) {
    if (hi - lo <= 1) break;
    int mid = (lo + hi) / 2;
    if (fetchTrajectory(mid).x > target) lo = mid; else hi = mid;
  }
  vec4 a = fetchTrajectory(lo), b = fetchTrajectory(hi);
  float f = clamp((a.x - target) / max(1e-6, a.x - b.x), 0., 1.);
  vec4 o = mix(a, b, f);
  float tStar = trajectoryTiming.x + (float(lo) + f) * trajectoryTiming.y;
  float psi = atan(-point.z, point.x);
  float d = psi - (o.y + offset);
  d -= 6.28318531 * floor(d / 6.28318531 + .5);
  float best = 0.;
  for (int k = -1; k <= 1; k++) {
    float dt = (d + 6.28318531 * float(k)) / max(o.w, 1e-6);
    float age = t - (tStar + dt);
    if (age < 0.) continue;
    float radial = abs(lever * o.z * dt);
    float width = trailWidth * (1. + .02 * rho);
    // A comet tail about one orbit long, so successive windings do not crowd.
    float period = 6.28318531 / max(o.w, 1e-6);
    float tail = exp(-age / (.6 * period));
    best = max(best, (1. - smoothstep(.3 * width, width, radial)) * smoothstep(.03, .12, tail) * tail);
  }
  return best;
}

void main() {
  vec3 dir = normalize(cameraAxes * normalize(vec3(raySlope(), -1.)));
  vec4 X = vec4(eventTime, radius * cameraAxes[2]);
  vec4 P = initialMomentum(X, dir);
  vec3 emitted = vec3(0.);
  float transmittance = 1.;
  vec3 exitDirection = dir;
  float escaped = 0.;
  float escapeRadius = max(320., 4. * radius);
  // Overlays use the direct and first lensed image of the orbital plane; the
  // thinner higher-order images near each shadow would alias at screen resolution.
  float crossings = 0.;
  float captured = 0., steps = 0.;
  for (int i = 0; i < 420; i++) {
    steps += 1.;
    vec4 k1x, k1p, k2x, k2p, k3x, k3p, k4x, k4p;
    float near = derivatives(X, P, k1x, k1p);
    // Ingoing Kerr–Schild coordinates are singular on the past horizon, where a
    // backward-traced captured ray hovers with a diverging p_t: stop it there.
    if (near < 1.05 || abs(P.x) > 25.) { captured = 1.; break; }
    // Spatial step a fixed fraction of the distance to the nearest hole. Dividing
    // by the coordinate speed keeps it so while p grows near a horizon.
    float speed = max(1., length(k1x.yzw));
    float h = clamp(.075 * nearestHole(X.yzw, X.x), .012 * holes.y, .2 * length(X.yzw) + 1.) / speed;
    derivatives(X + .5 * h * k1x, P + .5 * h * k1p, k2x, k2p);
    derivatives(X + .5 * h * k2x, P + .5 * h * k2p, k3x, k3p);
    derivatives(X + h * k3x, P + h * k3p, k4x, k4p);
    vec4 nextX = X + h / 6. * (k1x + 2. * (k2x + k3x) + k4x);
    vec4 nextP = P + h / 6. * (k1p + 2. * (k2p + k3p) + k4p);
    // Orbital-plane crossing: gravitational-wave field and trails.
    if ((showWaves || showTrails) && X.z * nextX.z < 0. && transmittance > .01 && crossings < 2.) {
      float imageWeight = crossings == 0. ? 1. : .55;
      crossings += 1.;
      float f = X.z / (X.z - nextX.z);
      vec4 hit = mix(X, nextX, f);
      float rho = length(hit.yw);
      if (showWaves && rho > 4.5 && rho < .92 * radius) {
        float u = hit.x - (rho + 2. * log(max(1e-3, .5 * rho - 1.)));
        float strain = planeStrain(u, atan(-hit.w, hit.y)) * 10. / rho;
        float value = tanh(waveGain * strain);
        float fade = smoothstep(4.5, 9., rho) * (1. - smoothstep(.75 * radius, .92 * radius, rho));
        float alpha = .5 * abs(value) * fade * imageWeight;
        emitted += transmittance * alpha * .75 * diverging(value);
        transmittance *= 1. - alpha;
      }
      if (showTrails && remnantWeight(hit.x) < 1.) {
        float t1 = trail(hit.yzw, hit.x, levers.x, 0.);
        float t2 = trail(hit.yzw, hit.x, levers.y, 3.14159265);
        float alpha = .85 * max(t1, t2) * imageWeight;
        vec3 c = t1 > t2 ? vec3(1., .72, .42) : vec3(.62, .82, 1.);
        emitted += transmittance * alpha * 1.1 * c;
        transmittance *= 1. - alpha;
      }
    }
    X = nextX;
    P = nextP;
    float r = length(X.yzw);
    if (r > escapeRadius && dot(X.yzw, k4x.yzw) > 0.) {
      exitDirection = normalize(k4x.yzw);
      escaped = 1.;
      break;
    }
  }
  // All lanes reconverge before deriving the lensed sky footprint.
  vec3 sky = skyRadiance(exitDirection);
  #ifdef DEBUG_STEPS
    // Red: integration steps; green: escaped; blue: captured.
    gl_FragColor = vec4(steps / 420., escaped, captured, 1.);
    return;
  #endif
  writeRadiance(emitted + transmittance * escaped * sky);
}
`;
