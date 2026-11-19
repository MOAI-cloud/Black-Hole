// Millimetre-wave image of a hot, radiatively inefficient accretion flow
// (RIAF), as observed by the Event Horizon Telescope. Included in the Kerr
// geodesic shader when SYNCHROTRON is defined.
//
// Thermal electrons radiate synchrotron emission. The angle-averaged
// emissivity is the Mahadevan, Narayan & Yi (1996, ApJ 465, 327) fit and the
// absorption follows Kirchhoff's law in the Rayleigh–Jeans limit. Density,
// electron temperature and an equipartition magnetic field follow the
// self-similar RIAF profiles used for Sgr A* by Broderick et al. (2011, ApJ
// 735, 110). Gas rotates on Keplerian shells outside the ISCO and plunges with
// the ISCO energy and angular momentum inside it (Cunningham 1975). The
// invariant transfer uses g³ j_ν(ν/g) and the frame-invariant optical depth.
// The image is accumulated as brightness temperature at the observing frequency.
export const synchrotronShader = `
#ifdef SYNCHROTRON
uniform float riafDensity;     // electron density at r = 10 M (cm^-3)
uniform float riafTemperature; // electron temperature at r = 10 M (K)
uniform float riafBeta;        // gas-to-magnetic pressure ratio
uniform float riafHeight;      // angular scale height H/R
uniform vec2 riafSlopes;       // radial power laws of n_e and T_e (r^-x)
uniform float gravitationalCm; // GM/c^2 in cm
uniform float observeHz;       // observing frequency at the camera (Hz)
uniform float iscoEnergy, iscoMomentum;
uniform vec4 hotspot;          // orbit radius (M), Gaussian size (M), density boost (0 = off), phase (rad)
uniform float jetDensity;      // relative sheath density of a parabolic jet (0 = off)
uniform float jetLorentz;      // bulk Lorentz factor of the jet sheath

// K_2(1/theta) for the relativistic Maxwell-Juttner normalization.
float besselK2Inverse(float theta) {
  float z = 1. / theta;
  if (z < .8) return 2. * theta * theta - .5;
  return sqrt(1.5707963 / z) * exp(-z) * (1. + 1.875 / z + .8203 / (z * z));
}

// Emission coefficient per steradian (cgs) at fluid-frame frequency nu.
float synchrotronJ(float ne, float te, float b, float nu) {
  float theta = te / 5.92989e9;
  float nuS = 2.79925e6 * b * theta * theta; // nu_0 Theta^2
  float x = 2. * nu / (3. * max(nuS, 1.));
  float x6 = pow(x, 1. / 6.);
  float m = 4.0505 / x6 * (1. + .40 / (x6 * sqrt(x6)) + .5316 / (x6 * x6 * x6)) * exp(-1.8899 * x6 * x6);
  return 4.44307e-30 * ne * nu * m / besselK2Inverse(theta);
}

// Fluid-frame photon frequency over the camera frequency for the flow's
// four-velocity. vw is du/dMino of the backward ray, so the forward photon has
// dr/dMino = +vw/u^2 and covariant k_r = (dr/dMino)/Delta per unit energy.
float flowFrequency(float r, float mu, float vw, float u) {
  float r2 = r * r, sin2 = max(1e-6, 1. - mu * mu);
  float sigma = r2 + a2 * mu * mu;
  float delta = r2 - 2. * r + a2;
  float A = (r2 + a2) * (r2 + a2) - a2 * delta * sin2;
  float ut, uphi, ur = 0.;
  if (r >= innerR) {
    float omega = 1. / (r * sqrt(r) + spin);
    float frame = 2. * spin * r / A;
    float norm = sigma * delta / A - A * sin2 / sigma * (omega - frame) * (omega - frame);
    if (norm <= 0.) return -1.;
    ut = inversesqrt(norm);
    uphi = omega * ut;
  } else {
    // Ballistic plunge with the ISCO's conserved energy and angular momentum.
    // Off the equator the thick flow carries the same specific angular
    // momentum per unit cylindrical radius squared, L sin²θ.
    float momentum = iscoMomentum * sin2;
    float sd = sigma * delta;
    ut = (A * iscoEnergy - 2. * spin * r * momentum) / sd;
    uphi = (2. * spin * r * iscoEnergy + (delta - a2 * sin2) * momentum / sin2) / sd;
    float potential = -1. + ut * iscoEnergy - uphi * momentum;
    ur = -sqrt(max(0., potential * delta / sigma));
  }
  float ratio = energy * (ut - ell * uphi - vw / (u * u * delta) * ur);
  // Beaming beyond g = 12 would need sub-percent velocity accuracy.
  return ratio < 1. / 12. ? -1. : ratio;
}

// The same ratio for a radial outflow with bulk Lorentz factor gamma relative
// to the local zero-angular-momentum observer, as in a jet far from its base.
float outflowFrequency(float r, float mu, float vw, float u, float gamma) {
  float r2 = r * r, sin2 = max(1e-6, 1. - mu * mu);
  float sigma = r2 + a2 * mu * mu;
  float delta = r2 - 2. * r + a2;
  float A = (r2 + a2) * (r2 + a2) - a2 * delta * sin2;
  float ut = gamma * sqrt(A / (sigma * delta));
  float uphi = 2. * spin * r / A * ut;
  float ur = sqrt(gamma * gamma - 1.) * sqrt(delta / sigma);
  return energy * (ut - ell * uphi - vw / (u * u * delta) * ur);
}

// Formal solution of one segment for an emitting component, accumulated as
// observed brightness temperature. Returns its optical depth. The field is in
// equipartition with ions at the virial temperature divided by plasma beta,
// or, for a magnetically dominated jet, B²/8π = sigma n m_p c².
float transferSynchrotron(float ne, float te, float r, float ratio, float stepMino, float mu, float magnetization) {
  if (ne <= 1e-3 || ratio <= 0.) return 0.;
  float b = magnetization > 0. ? sqrt(25.1327 * ne * 1.50328e-3 * magnetization)
                               : sqrt(25.1327 * ne * 1.50328e-3 / (6. * r * riafBeta));
  float nuFluid = observeHz * ratio;
  float j = synchrotronJ(ne, te, b, nuFluid);
  // Kirchhoff absorption with the Rayleigh-Jeans source function.
  float alpha = j / (3.0718e-37 * nuFluid * nuFluid * te);
  float path = (r * r + a2 * mu * mu) * stepMino / energy * ratio * gravitationalCm; // fluid frame, cm
  float tau = alpha * path;
  float emitted = tau < 1e-4 ? path : (1. - exp(-tau)) / alpha;
  float g = 1. / ratio;
  transfer.r += transfer.a * g * g * g * j * emitted * 8.98755e20 / (2.76130e-16 * observeHz * observeHz);
  return tau;
}

void emitSynchrotron(vec4 q, vec2 clock, float stepMino, vec4 velocity) {
  float u = q.w;
  if (u <= 1. / 400. || u >= .999 * inverseHorizon) return;
  float r = 1. / u;
  float mu = q.y;
  vec3 n = applyDrag(q.xyz, clock.y);
  float scale = r / 10.;
  float ne = riafDensity * pow(scale, -riafSlopes.x) * exp(-.5 * mu * mu / (riafHeight * riafHeight));
  float te = riafTemperature * pow(scale, -riafSlopes.y);
  if (hotspot.z > 0.) {
    // Orbiting flare: a Gaussian overdensity on a Keplerian equatorial orbit,
    // sampled at this event's retarded coordinate time.
    float phase = hotspot.w + (timeM - clock.x) / (hotspot.x * sqrt(hotspot.x) + spin);
    vec3 centre = hotspot.x * vec3(cos(phase), 0., -sin(phase));
    vec3 offset = r * n - centre;
    float spot = exp(-.5 * dot(offset, offset) / (hotspot.y * hotspot.y));
    ne += hotspot.z * riafDensity * pow(hotspot.x / 10., -riafSlopes.x) * spot;
    te *= 1. + .6 * spot;
  }
  float tau = transferSynchrotron(ne, te, r, flowFrequency(r, mu, velocity.w, u), stepMino, mu, 0.);
  if (jetDensity > 0.) {
    // Limb-brightened parabolic sheath, z ∝ R², along the spin axis.
    float z = abs(r * mu), cylinder = r * sqrt(max(0., 1. - mu * mu));
    float wall = 1.6 * sqrt(max(z, .1));
    float sheath = exp(-.5 * (cylinder - wall) * (cylinder - wall) / (.09 * wall * wall)) * smoothstep(2., 6., z);
    float jetNe = jetDensity * riafDensity * pow(max(z, 2.) / 10., -1.6) * sheath;
    // Sheath electrons stay hotter than the disk at the same radius.
    float jetTe = riafTemperature * pow(max(z, 2.) / 10., -.5);
    tau += transferSynchrotron(jetNe, jetTe, r, outflowFrequency(r, mu, velocity.w, u, jetLorentz), stepMino, mu, 1.);
  }
  transfer.a *= exp(-tau);
}

// Step bound near the flare so a ray cannot jump across it.
float hotspotStep(vec4 q, vec4 velocity, vec2 clock) {
  if (hotspot.z <= 0.) return 1e9;
  float r = 1. / q.w;
  float phase = hotspot.w + (timeM - clock.x) / (hotspot.x * sqrt(hotspot.x) + spin);
  vec3 centre = hotspot.x * vec3(cos(phase), 0., -sin(phase));
  float d = length(r * applyDrag(q.xyz, clock.y) - centre);
  if (d > 6. * hotspot.y + 2.) return 1e9;
  float speed = sqrt(velocity.w * velocity.w / (q.w * q.w * q.w * q.w) + r * r * dot(velocity.xyz, velocity.xyz));
  return .35 * max(d - 2.5 * hotspot.y, .6 * hotspot.y) / max(speed, 1e-6);
}

uniform bool rawBrightness; // write T_b / 10^10 K for the telescope-beam pass
uniform float displayDecades; // > 0: logarithmic display over this many decades
// False-colour display of brightness temperature (EHT "afmhot" map).
void writeBrightnessTemperature(float tb) {
  if (rawBrightness) { gl_FragColor = vec4(exposure * tb / 1e10, 0., 0., 1.); return; }
  float x = max(0., exposure * tb / 1e10);
  if (displayDecades > 0.) x = clamp(1. + log(max(x, 1e-20)) / (2.302585 * displayDecades), 0., 1.);
  else x = x / (1. + .35 * x);
  vec3 c = clamp(vec3(2. * x, 2. * x - .5, 2. * x - 1.), 0., 1.);
  gl_FragColor = vec4(c * c, 1.);
  #include <colorspace_fragment>
}
#endif
`;
