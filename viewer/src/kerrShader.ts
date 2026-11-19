import { transferShader } from './transferShader';
import { synchrotronShader } from './synchrotronShader';
import { infallShader } from './scenarios/infall/infallShader';

// Geometrized units M=1. E, ell=Lz/E and Q/E² refer to the future photon.
// Positive integration steps trace into the observer's past.
export const kerrFragmentShader = `
${transferShader}
float ell, carter, angular2, radialK, energy, a2;
float inverseHorizon;

vec4 acceleration(vec4 q) {
  float u = q.w;
  // n is the unit radial direction with frame dragging factored out. Embedding
  // the polar equation on the sphere keeps the state regular on the spin axis.
  vec3 angular = -(angular2 + 2. * a2 * q.y * q.y) * q.xyz + vec3(0., a2 * q.y, 0.);
  float invRadial = u * (a2 - angular2 + u * (3. * radialK - 2. * a2 * carter * u));
  return vec4(angular, invRadial);
}

vec2 clockAndDrag(vec4 q) {
  // The BL clock and azimuth diverge at the horizon; events inside the
  // stopping surface do not contribute to the emitted intensity.
  float u = clamp(q.w, .00001, .99995 * inverseHorizon);
  float u2 = u * u;
  float delta = 1. - 2. * u + a2 * u2;
  float drag = -spin * u * (2. - spin * ell * u) / delta;
  float delay = (1. / u2 + a2) * (1. + (a2 - spin * ell) * u2) / delta
      + spin * (ell - spin * (1. - q.y * q.y));
  return vec2(delay, drag);
}

vec3 applyDrag(vec3 n, float angle) {
  float c = cos(angle), s = sin(angle);
  return vec3(c * n.x + s * n.z, n.y, c * n.z - s * n.x);
}

void diskEvent(vec4 q, vec2 clock, float stepMino, vec4 velocity, bool immersed, bool outerLayer) {
  float r = 1. / q.w;
  if (r < innerR - .0001 || r > outerR + .0001) return;
  float mu = q.y;
  float height = diskHeight * (1. + flare * (r - innerR));
  if (!thin && abs(r * mu) > 3.5 * height) return;
  float sin2 = max(0., 1. - mu * mu);
  float r2 = r * r;
  float sigma = r2 + a2 * mu * mu;
  float delta = r2 - 2. * r + a2;
  float A = (r2 + a2) * (r2 + a2) - a2 * delta * sin2;
  float lapse = sqrt(sigma * delta / A);
  float omegaFrame = 2. * spin * r / A;
  float omega = 1. / (r * sqrt(r) + spin);
  // u^t = 1 / sqrt(alpha² - g_phi_phi (Omega - omega_ZAMO)²).
  float norm = lapse * lapse - (A * sin2 / sigma) * (omega - omegaFrame) * (omega - omegaFrame);
  if (norm <= 0.) return;
  float gFull = sqrt(norm) / (energy * (1. - omega * ell));
  float gGrav = lapse / (energy * (1. - omegaFrame * ell));
  float shift = (gravity ? gGrav : 1.) * (kinematic ? gFull / gGrav : 1.);
  // At an equatorial crossing |p_theta| = E sqrt(Q/E²). Divide the
  // orthonormal normal momentum by the local fluid-frame photon frequency.
  float incidence = thin ? clamp(energy * gFull * sqrt(max(0., carter)) / r, 0., 1.) : 1.;
  if (photosphere && !outerLayer) {
    float dR = -photosphereSlope2(r, innerR, outerR, diskHeight, flare);
    float normN = sqrt(sigma * (delta*dR*dR + 4.*mu*mu*sin2));
    float dF = -dR * r2 * velocity.w + 2.*mu*velocity.y;
    incidence = immersed ? -1. : clamp(abs(dF)*energy*gFull / max(1.e-12, normN), 0., 1.);
  }
  emitDisk(r, applyDrag(q.xyz, clock.y), shift, sigma * stepMino / (energy * gFull), timeM - clock.x, incidence,
           outerLayer ? photosphereDepth(r, innerR, outerR) : -1.);
}

${synchrotronShader}
${infallShader}

vec4 interpolateRay(vec4 q, vec4 next, vec4 d0, vec4 d1, float f) {
  float l = 1.-f;
  return l*l*((1.+2.*f)*q + f*d0) + f*f*((3.-2.*f)*next-l*d1);
}

float rayField(vec4 q) {
  return surfaceField(1./max(.000001,q.w), q.y);
}

// First entry on an accepted Kerr segment. A grazing ray can enter and exit
// between its endpoints, so probe its midpoint and a local quadratic minimum.
float surfaceEntry(vec4 q, vec4 next, vec4 d0, vec4 d1, vec4 mid, float opening) {
  if (max(q.w,max(next.w,mid.w)) < 1./outerR || min(q.w,min(next.w,mid.w)) > 1./innerR) return -1.;
  if (q.y*next.y > 0. && min(abs(q.y),min(abs(mid.y),abs(next.y))) > opening+.002) return -1.;
  float a = rayField(q), m = rayField(mid), b = rayField(next);
  if (a <= 0.) return 0.;
  float hi = m <= 0. ? .5 : 1.;
  if (m > 0. && b > 0.) {
    hi = photosphereMinimum(a,m,b);
    if (rayField(interpolateRay(q,next,d0,d1,hi)) > 0.) {
      if (q.y*next.y >= 0.) return -1.;
      float loPlane = 0., hiPlane = 1.;
      for (int j=0; j<14; j++) {
        float f=.5*(loPlane+hiPlane);
        if (interpolateRay(q,next,d0,d1,f).y*q.y > 0.) loPlane=f; else hiPlane=f;
      }
      hi=.5*(loPlane+hiPlane);
      if (surfaceField(1./interpolateRay(q,next,d0,d1,hi).w,0.) > 0.) return -1.;
    }
  }
  float lo = 0.;
  for (int j=0;j<14;j++) {
    float f = .5*(lo+hi);
    if (rayField(interpolateRay(q,next,d0,d1,f)) <= 0.) hi=f; else lo=f;
  }
  return .5*(lo+hi);
}

void main() {
  vec2 slope = raySlope();
  vec3 local = normalize(vec3(slope, -1.)); // right, up, outward
  float cameraShift = 1.;
#ifdef INFALL
  if (observerBoost.w > 1.) {
    // Aberration from the moving observer to its local ZAMO frame. The
    // ZAMO-frame frequency of a unit-frequency photon is gamma (1 - beta.d).
    vec3 beta = vec3(dot(observerBoost.xyz, cameraAxes[0]), dot(observerBoost.xyz, cameraAxes[1]),
                     dot(observerBoost.xyz, cameraAxes[2]));
    float speed = length(beta);
    if (speed > 1e-6) {
      vec3 axis = beta / speed;
      cameraShift = observerBoost.w * (1. - dot(beta, local));
      local = normalize(local + ((observerBoost.w - 1.) * dot(local, axis)) * axis - observerBoost.w * beta);
    }
  }
#endif
  vec3 radial = cameraAxes[2];
  float mu = radial.y;
  float sinTheta = length(radial.xz);
  a2 = spin * spin;
  float r2 = radius * radius;
  float sigma = r2 + a2 * mu * mu;
  float delta = r2 - 2. * radius + a2;
  float A = (r2 + a2) * (r2 + a2) - a2 * delta * sinTheta * sinTheta;
  float Lz = -local.x * sqrt(A / sigma) * sinTheta;
  energy = sqrt(sigma * delta / A) + 2. * spin * radius / A * Lz;
  ell = Lz / energy;
  float pNorth = local.y * sqrt(sigma) / energy;
  float pEast = -ell / sinTheta;
  carter = pNorth * pNorth + mu * mu * (pEast * pEast - a2);
  angular2 = carter + ell * ell;
  radialK = carter + (ell - spin) * (ell - spin);
  inverseHorizon = 1. / (1. + sqrt(1. - a2));
  vec4 q = vec4(radial, 1. / radius);
  vec4 velocity = vec4(cameraAxes[1] * pNorth + cameraAxes[0] * pEast,
      -local.z * sqrt(sigma * delta) / (energy * r2));
  // Conserved energy per unit frequency of the (possibly moving) camera.
  energy *= cameraShift;
  vec2 clock = vec2(0.);
  float angularStep = .105 / sqrt(max(1., angular2 + a2));
  vec3 exitDirection = radial;
  float escaped = 0.;
  float opening = diskHeight * max(1./innerR, (1.+flare*(outerR-innerR))/outerR);
  opening *= inversesqrt(1.+4.*opening*opening);
  startTransfer();
  for (int i = 0; i < 320; i++) {
    // Bound angular motion as well as fractional radial change. Large steps
    // at infinity and a smaller stride through a thin photosphere save work.
    float h = min(angularStep, .18 * max(q.w, .018) / max(abs(velocity.w), .0001));
    if (q.w > .3 && velocity.w > 0.) {
      h = min(h, .24 * max(.0005, inverseHorizon - q.w) / max(.001, velocity.w));
    }
#ifdef INFALL
    h = min(h, bodyStep(q, velocity, clock));
#endif
#ifdef SYNCHROTRON
    // Resolve the thick flow's vertical profile and any orbiting flare.
    h = min(h, .3 * riafHeight / max(.01, length(velocity.xyz)));
    h = min(h, hotspotStep(q, velocity, clock));
#else
    if (!thin && q.w > 1. / (outerR + 2.) && abs(q.y) < .3) {
      float H = diskHeight * (1. + flare * max(0., 1. / q.w - innerR));
      h = min(h, max(.12 * angularStep, H * q.w / max(.01, abs(velocity.y))));
    }
#endif
    vec4 acc1 = acceleration(q);
    vec4 q2 = q + .5 * h * velocity;
    vec4 v2 = velocity + .5 * h * acc1;
    vec4 q3 = q + .5 * h * v2;
    vec4 acc2 = acceleration(q2);
    vec4 v3 = velocity + .5 * h * acc2;
    vec4 q4 = q + h * v3;
    vec4 acc3 = acceleration(q3);
    vec4 v4 = velocity + h * acc3;
    vec4 next = q + h / 6. * (velocity + 2. * (v2 + v3) + v4);
    vec4 nextV = velocity + h / 6. * (acc1 + 2. * (acc2 + acc3) + acceleration(q4));
    // Cubic Hermite midpoint uses the same fourth-order endpoint information.
    vec4 mid = .5 * (q + next) + .125 * h * (velocity - nextV);
    vec2 c0 = clockAndDrag(q), cm = clockAndDrag(mid), c1 = clockAndDrag(next);
    vec2 advance = h / 6. * (c0 + 4. * cm + c1);
#ifdef SYNCHROTRON
    emitSynchrotron(mid, clock + h/24.*(5.*c0+8.*cm-c1), h, .5 * (velocity + nextV));
#else
    float core = -1., layer = -1.;
    if (diskEnabled) {
    if (photosphere) core = surfaceEntry(q,next,h*velocity,h*nextV,mid,opening);
    if (thin && q.y*next.y < 0.) {
      layer = q.y/(q.y-next.y);
      if (photosphere) {
        // Cubic latitude root of the same accepted orbit as the opaque body.
        for (int j=0; j<2; j++) {
          float l = 1.-layer;
          float slope = 6.*layer*l*(next.y-q.y) + h*(l*(1.-3.*layer)*velocity.y+layer*(3.*layer-2.)*nextV.y);
          vec4 hit = interpolateRay(q,next,h*velocity,h*nextV,layer);
          if (abs(slope)>1.e-10) layer=clamp(layer-hit.y/slope,0.,1.);
        }
        float u = interpolateRay(q,next,h*velocity,h*nextV,layer).w;
        if (u <= 1./outerR || u >= 1./photosphereCoreEdge(innerR,outerR) ||
            (core >= 0. && layer >= core)) layer = -1.;
      }
    }
    // A single segment can hit the tenuous outer slab and then the body.
    // Keep photon flight order and shade both via the same material lookup.
    float event = layer >= 0. ? layer : core;
    if (!thin && mid.w > 0.) event = .5;
    for (int j=0; j<2; j++) {
      if (event < 0.) break;
      bool outerLayer = photosphere && layer >= 0. && event == layer;
      bool opaque = photosphere && !outerLayer;
      vec4 position = mid, vHit = velocity;
      vec2 eventClock = clock + h/24.*(5.*c0+8.*cm-c1);
      if (thin) {
        float l=1.-event;
        position = interpolateRay(q,next,h*velocity,h*nextV,event);
        vHit = 6.*event*l*(next-q)/h + l*(1.-3.*event)*velocity + event*(3.*event-2.)*nextV;
        vec4 halfHit = interpolateRay(q,next,h*velocity,h*nextV,.5*event);
        eventClock = clock + h*event/6.*(c0+4.*clockAndDrag(halfHit)+clockAndDrag(position));
      }
      diskEvent(position, eventClock, thin ? 0. : h, vHit, opaque && i==0 && event==0., outerLayer);
      if (opaque) transfer.a = 0.;
      event = outerLayer ? core : -1.;
    }
    }
#endif
#ifdef INFALL
    emitBody(q, next, clock, clock + advance, velocity);
#endif
    if (transfer.a < .003 || next.w >= inverseHorizon * .9999) break;
    if (next.w <= 0.) {
      float f = q.w / (q.w - next.w);
      exitDirection = applyDrag(normalize(mix(q.xyz, next.xyz, f)), clock.y + f * advance.y);
      escaped = 1.;
      break;
    }
    q = next;
    velocity = nextV;
    clock += advance;
  }
  // All lanes reconverge before deriving the lensed sky texture footprint.
#ifdef SYNCHROTRON
  writeBrightnessTemperature(transfer.r);
#else
#ifdef INFALL
  // Sky light is Doppler shifted into the moving camera: I ∝ D⁴ (bolometric).
  if (observerBoost.w > 1.) escaped *= min(40., pow(1. / max(energy, 1e-3), 4.));
#endif
  sampleSky(exitDirection, escaped);
  finishTransfer();
#endif
}
`;
