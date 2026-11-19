import { transferShader } from './transferShader';
import { ANGLE_SAMPLES, CRITICAL_IMPACT, IMPACT_SAMPLES, MAX_ANGLE, MAX_IMPACT } from './orbitTables';

export const vertexShader = `
varying vec2 screen;
void main() {
  screen = position.xy;
  gl_Position = vec4(position.xy, 0., 1.);
}
`;

export const fragmentShader = `
${transferShader}
const float critical = ${CRITICAL_IMPACT};
const float orbitWidth = ${IMPACT_SAMPLES}.;
const float orbitHeight = ${ANGLE_SAMPLES + 2}.;
const float maxAngle = ${MAX_ANGLE};

// All angles below are measured in the individual photon's orbital plane.
// Positive azimuth agrees with the native Kerr renderer's +e_phi basis.
vec3 radial, tangent;
float impact, impactLz, tableX, cameraPhase, endAngle, planeAmplitude;
vec4 radialBounds;
float observerClock, turnAngle, turnTortoise, firstSurfaceHit;

vec2 orbitAt(float angle) {
  float row = 2.5 + (cameraPhase + angle) / maxAngle * (orbitHeight - 3.);
  return texture2D(orbitMap, vec2(tableX, row / orbitHeight)).rg;
}

float radiusAt(float angle) { return 1. / max(orbitAt(angle).r, 1.e-5); }
float tortoise(float r) { return r + 2. * log(max(.00001, .5 * r - 1.)); }

void accumulate(float angle, float stepAngle) {
  vec2 orbital = orbitAt(angle);
  float r = 1. / max(orbital.r, 1.e-5);
  if (r <= innerR || r >= outerR) return;
  vec3 n = radial * cos(angle) + tangent * sin(angle);
  float omega = 1. / (r * sqrt(r) + spin);
  // Local circular-orbit speed relative to a Kerr ZAMO. The photon direction
  // and impact parameter are from the spherical lens transfer table.
  float delta = r * r - 2. * r + spin * spin;
  float gpp = r * r + spin * spin * (1. + 2. / r);
  float speed = clamp((omega * gpp - 2. * spin / r) / sqrt(delta), 0., .995);
  float redshift = sqrt(delta / (gpp * (1. - 2. / radius)));
  float localCos = clamp(-impactLz * sqrt(max(0., 1. - 2. / r)) / r, -1., 1.);
  float doppler = sqrt(1. - speed * speed) / (1. - speed * localCos);
  float shift = (gravity ? redshift : 1.) * (kinematic ? doppler : 1.);
  float fluidLength = r * r * stepAngle / max(.00001, impact * redshift * doppler * sqrt(1. - 2. / radius));
  float rStar = tortoise(r);
  float delay = observerClock + orbital.g - rStar;
  if (cameraPhase + angle > turnAngle) delay += 2. * (rStar - turnTortoise);
  float incidence = thin ? clamp(impact * planeAmplitude * sqrt(1. - 2. / radius) * redshift * doppler / r, 0., 1.) : 1.;
  bool outerLayer = photosphere && r > photosphereCoreEdge(innerR, outerR);
  if (photosphere && !outerLayer) {
    float lapse2 = max(.00001,1.-2./r);
    float dR = -photosphereSlope2(r,innerR,outerR,diskHeight,flare);
    float normN = sqrt(lapse2*dR*dR + 4.*n.y*n.y*(1.-n.y*n.y)/(r*r));
    float ur = sqrt(max(0.,1.-impact*impact*lapse2/(r*r)));
    if (cameraPhase+angle < turnAngle) ur = -ur;
    float muDot = impact * (-radial.y*sin(angle)+tangent.y*cos(angle))/(r*r);
    float eInfinity = sqrt(1.-2./radius);
    incidence = angle == 0. ? -1. : clamp(abs(dR*ur + 2.*n.y*muDot)*eInfinity*redshift*doppler/max(1.e-12,normN),0.,1.);
  }
  emitDisk(r, n, shift, fluidLength, timeM - max(0., delay), incidence,
           outerLayer ? photosphereDepth(r, innerR, outerR) : -1.);
}

float layerHeight(float phi) {
  float r = radiusAt(phi);
  float y = radial.y * cos(phi) + tangent.y * sin(phi);
  return abs(r * y) / (diskHeight * (1. + flare * max(0., r - innerR)));
}

// Clip to the local Gaussian layer before quadrature. A fixed angular stride
// otherwise skips narrow, distant columns at shallow viewing inclinations.
float clipLayer(float outside, float inside) {
  for (int j = 0; j < 6; j++) {
    float mid = .5 * (outside + inside);
    if (layerHeight(mid) > 3.5) outside = mid;
    else inside = mid;
  }
  return .5 * (outside + inside);
}

void integrateRange(float start, float stop) {
  if (stop <= start + .000001 || transfer.a < .003) return;
  bool startOutside = layerHeight(start) > 3.5;
  bool stopOutside = layerHeight(stop) > 3.5;
  if (startOutside && stopOutside) {
    float mid = .5 * (start + stop);
    if (layerHeight(mid) > 3.5) return;
    start = clipLayer(start, mid);
    stop = clipLayer(stop, mid);
  } else if (startOutside) start = clipLayer(start, stop);
  else if (stopOutside) stop = clipLayer(stop, start);

  const int samples = 6;
  float stepAngle = (stop - start) / float(samples);
  for (int j = 0; j < samples; j++) {
    accumulate(start + (float(j) + .5) * stepAngle, stepAngle);
  }
}

void integrateColumn(float lo, float hi, float center) {
  if (hi <= lo) return;
  float split = clamp(center, lo, hi);
  integrateRange(lo, split);
  integrateRange(split, hi);
}

float photoFieldAt(float angle) {
  return surfaceField(radiusAt(angle), radial.y*cos(angle)+tangent.y*sin(angle));
}

void traceSurfaceRange(float lo, float hi) {
  if (hi <= lo || firstSurfaceHit >= 0.) return;
  float left = lo, a = photoFieldAt(left);
  // Each range is monotone in radius and bounded to one side of the orbital
  // plane. The midpoint and quadratic minimum also catch grazing tangencies.
  for (int j=0;j<4;j++) {
    float right = mix(lo,hi,float(j+1)*.25);
    float mid = .5*(left+right), m = photoFieldAt(mid), b = photoFieldAt(right);
    float inside = a <= 0. ? left : m <= 0. ? mid : right;
    if (a > 0. && m > 0. && b > 0.) {
      float u = photosphereMinimum(a,m,b);
      inside = mix(left,right,u);
      if (u <= 0. || u >= 1. || photoFieldAt(inside)>0.) { left=right; a=b; continue; }
    }
    for (int k=0;k<12;k++) {
      float f=.5*(left+inside);
      if (photoFieldAt(f)<=0.) inside=f; else left=f;
    }
    firstSurfaceHit = inside;
    return;
  }
}

void traceSurface(float begin, float end, float lo, float hi, float center) {
  // Bounds are interpolated from a half-float table, so pad the search and
  // let the actual implicit equation, including the rounded rim, clip it.
  float s=max(begin,lo-.015), e=min(end,hi+.015);
  float c=clamp(center,s,max(s,e));
  traceSurfaceRange(s,c);
  traceSurfaceRange(c,e);
}

void main() {
  vec2 slope = raySlope();
  float slopeLength = length(slope);
  radial = cameraAxes[2];
  tangent = slopeLength > 1.e-7 ? cameraAxes * vec3(slope / slopeLength, 0.) : cameraAxes[0];
  float viewAngle = atan(slopeLength);
  impact = radius * sin(viewAngle) / sqrt(1. - 2. / radius);
  impactLz = impact * cross(radial, tangent).y;
  float span = impact < critical ? critical : ${MAX_IMPACT}. - critical;
  float x = sign(impact - critical) * pow(abs(impact - critical) / span, 1./3.);
  tableX = (.5 + (.5 * x + .5) * (orbitWidth - 1.)) / orbitWidth;
  float observerX = (.5 + 255. * viewAngle / (.5 * pi)) / 256.;
  cameraPhase = texture2D(observerMap, vec2(observerX, .25)).r + texture2D(observerMap, vec2(observerX, .75)).r;
  vec2 first = texture2D(orbitMap, vec2(tableX, .5 / orbitHeight)).rg;
  vec2 second = texture2D(orbitMap, vec2(tableX, 1.5 / orbitHeight)).rg;
  endAngle = first.r + second.r - cameraPhase;
  turnAngle = first.g;
  turnTortoise = second.g;
  observerClock = tortoise(radius) - orbitAt(0.).g;
  radialBounds = texture2D(boundsMap, vec2(tableX,.5)) - cameraPhase;
  startTransfer();
  float firstCross = mod(atan(-radial.y, tangent.y), pi);
  planeAmplitude = length(vec2(radial.y, tangent.y));
  float maxOpening = diskHeight * max(1. / innerR, (1. + flare * (outerR - innerR)) / outerR);
  float opening = photosphere ? maxOpening*inversesqrt(1.+4.*maxOpening*maxOpening) : 3.5*maxOpening;
  float halfRange = asin(min(1., opening / max(.00001, planeAmplitude)));
  firstSurfaceHit = diskEnabled && photosphere && surfaceField(radius,radial.y) <= 0. ? 0. : -1.;
  for (int order = -1; order < 3 && diskEnabled; order++) {
    float center = firstCross + float(order) * pi;
    if (center - halfRange > endAngle || transfer.a < .005 || firstSurfaceHit >= 0.) break;
    if (photosphere) {
      float lo = max(0.,center-halfRange), hi=min(endAngle,center+halfRange);
      traceSurface(lo,hi,radialBounds.x,radialBounds.y,center);
      traceSurface(lo,hi,radialBounds.z,radialBounds.w,center);
      // The tenuous exterior is a gray slab. If a ray crosses it before
      // entering the closed, opaque body, transmit the remaining intensity.
      if (center > .00001 && center < endAngle && (firstSurfaceHit < 0. || center < firstSurfaceHit)) {
        float r = radiusAt(center);
        if (r > photosphereCoreEdge(innerR,outerR) && r < outerR) accumulate(center, 0.);
      }
    } else if (thin) {
      if (center > .00001 && center < endAngle) accumulate(center, 0.);
    } else {
      float lo = max(0., center - halfRange), hi = min(endAngle, center + halfRange);
      integrateColumn(max(lo, radialBounds.x), min(hi, radialBounds.y), center);
      integrateColumn(max(lo, radialBounds.z), min(hi, radialBounds.w), center);
    }
  }
  if (firstSurfaceHit >= 0.) {
    accumulate(firstSurfaceHit, 0.);
    transfer.a = 0.;
  }
  vec3 skyDirection = radial * cos(endAngle) + tangent * sin(endAngle);
  sampleSky(skyDirection, impact > critical ? 1. : 0.);
  finishTransfer();
}
`;
