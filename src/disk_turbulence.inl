// Sheared, finite-lifetime turbulence below the resolution of the recorded
// accretion flow. One scalar source is shared by the WebGL shaders and CUDA.
//
// Magnetorotational turbulence in a Keplerian disk is anisotropic: shear winds
// eddies into trailing spirals and new eddies replace them within a fraction
// of the local orbital period. Each octave is gradient noise in the comoving
// frame of overlapping logarithmic radial bands. Inside a band, a generation
// of eddies is born unwound and is then sheared by the exact local Kerr
// angular velocity Omega(r) relative to the band's guiding orbit while it fades
// in and out over two generation times. Bands are joined by a partition of
// unity and generations by a variance-preserving cos/sin cross-fade, so the
// field is continuous in radius, azimuth and time with unit variance.
//
// The heating rate is log-normal: a multiplicative cascade of the recorded
// large-scale pressure field and these smaller eddies. Its ensemble mean is
// one, which preserves the prescribed radial flux law.
//
// Required macros: BH_INLINE BH_TIME BH_FLOOR BH_FLOOR_TIME BH_EXP BH_LOG
// BH_SQRT BH_COS BH_SIN BH_MIN BH_MAX BH_ABS, and a 32-bit `uint` type.

BH_INLINE uint turb_hash(uint x) {
    x ^= x >> 16u;
    x *= 0x7feb352du;
    x ^= x >> 15u;
    x *= 0x846ca68bu;
    return x ^ (x >> 16u);
}

BH_INLINE float turb_unit(uint bits) {
    return float(bits & 65535u) * (1.0f / 65535.0f);
}

// Dot product of a hashed lattice gradient with the offset to that corner.
BH_INLINE float turb_corner(uint h, float dx, float dy) {
    float gx = float(int(h & 255u) - 128) * (1.0f / 128.0f);
    float gy = float(int((h >> 8u) & 255u) - 128) * (1.0f / 128.0f);
    return gx * dx + gy * dy;
}

// Gradient noise with a lattice that is periodic in v with an integer period.
// Divided by its measured standard deviation, 0.1760, to give unit variance.
BH_INLINE float turb_noise(float u, float v, float period, uint seed) {
    float iu = BH_FLOOR(u), iv = BH_FLOOR(v);
    float x = u - iu, y = v - iv;
    iv -= period * BH_FLOOR(iv / period);
    int i = int(iu), j = int(iv);
    int j1 = j + 1 >= int(period) ? 0 : j + 1;
    uint a = turb_hash(seed ^ (uint(i) * 0x8da6b343u));
    uint b = turb_hash(seed ^ (uint(i + 1) * 0x8da6b343u));
    float n00 = turb_corner(turb_hash(a ^ (uint(j) * 0xd8163841u)), x, y);
    float n01 = turb_corner(turb_hash(a ^ (uint(j1) * 0xd8163841u)), x, y - 1.0f);
    float n10 = turb_corner(turb_hash(b ^ (uint(j) * 0xd8163841u)), x - 1.0f, y);
    float n11 = turb_corner(turb_hash(b ^ (uint(j1) * 0xd8163841u)), x - 1.0f, y - 1.0f);
    float sx = x * x * x * (x * (x * 6.0f - 15.0f) + 10.0f);
    float sy = y * y * y * (y * (y * 6.0f - 15.0f) + 10.0f);
    float low = n00 + sx * (n10 - n00);
    float high = n01 + sx * (n11 - n01);
    return (low + sy * (high - low)) * (1.0f / 0.1760f);
}

// Width of the overlapping radial guiding bands in ln r.
#define TURB_BAND 0.2f
// Largest synthetic eddies: radial cells per unit ln r, cells around an orbit
// (a 1.5:1 azimuthal-to-radial aspect at birth, which shear then winds toward
// the ~3-5:1 correlation ellipses of MRI turbulence), and their lifetime in
// local orbital periods, comparable to the MRI growth and correlation time.
#define TURB_KAPPA0 64.0f
#define TURB_M0 268.0f
#define TURB_LIFE0 0.20f

// One octave: kappa radial cells per unit ln r, m cells around the orbit, and
// a generation lifetime in local orbital periods.
BH_INLINE float turb_octave(float log_r, float turns, BH_TIME t, float spin, float kappa,
                            float m, float life, uint layer) {
    float s = log_r / TURB_BAND;
    float base = BH_FLOOR(s);
    float f = s - base;
    // Local prograde angular velocity relative to each band's guiding orbit.
    float r32 = BH_EXP(1.5f * log_r);
    float total = 0.0f;
    for (int k = 0; k < 2; ++k) {
        float band = base + float(k);
        float weight = k == 0 ? 1.0f - f : f;
        uint id = turb_hash(uint(int(band) + 4096) * 0x9e3779b9u ^ layer);
        float guide32 = BH_EXP(1.5f * TURB_BAND * band);
        // Coordinate orbital period of the guiding orbit, 2 pi (r^1.5 + a).
        BH_TIME period = BH_TIME(6.283185307179586) * (BH_TIME(guide32) + BH_TIME(spin));
        BH_TIME orbits = t / period;
        float guiding = float(orbits - BH_FLOOR_TIME(orbits));
        BH_TIME clock = orbits / BH_TIME(life) + BH_TIME(turb_unit(id));
        BH_TIME epoch = BH_FLOOR_TIME(clock);
        float age = float(clock - epoch);
        uint generation = uint(int(epoch - BH_FLOOR_TIME(epoch / BH_TIME(65536.0f)) * BH_TIME(65536.0f)));
        // Fractional orbits this radius gains on the guiding orbit per lifetime.
        float drift = life * ((guide32 + spin) / (r32 + spin) - 1.0f);
        float field = 0.0f;
        for (int g = 0; g < 2; ++g) {
            // Generation epoch+g was born at clock epoch+g-1.
            uint seed = turb_hash(id ^ (((generation + uint(g)) & 65535u) * 0x27d4eb2du));
            float elapsed = age + float(1 - g);
            float u = kappa * log_r + 97.0f * turb_unit(seed);
            float v = m * (turns - guiding - drift * elapsed) + m * turb_unit(seed >> 16u);
            float fade = g == 0 ? BH_COS(1.5707963267948966f * age) : BH_SIN(1.5707963267948966f * age);
            field += fade * turb_noise(u, v, m, seed);
        }
        total += weight * field;
    }
    return total / BH_SQRT((1.0f - f) * (1.0f - f) + f * f);
}

struct TurbulenceSample {
    float field;    // weighted sum of resolved octaves
    float variance; // its variance, for a unit-mean log-normal
};

// Kolmogorov-like cascade below the 128-cell recorded flow. Octaves smaller
// than a pixel footprint (in ln r) fade to their mean, so unresolved eddies
// integrate to the ensemble average instead of aliasing.
BH_INLINE TurbulenceSample turbulence_field(float r, float phi, BH_TIME t, float spin, float log_footprint) {
    TurbulenceSample result;
    result.field = 0.0f;
    result.variance = 0.0f;
    float log_r = BH_LOG(r);
    float turns = phi * 0.15915494309189535f;
    float kappa = TURB_KAPPA0, m = TURB_M0, life = TURB_LIFE0, amplitude = 0.8318f;
    for (int octave = 0; octave < 4; ++octave) {
        float resolved = BH_MAX(0.0f, BH_MIN(1.0f, (1.15f - kappa * log_footprint) / 0.9f));
        if (resolved <= 0.0f) break;
        float weight = amplitude * resolved;
        result.field += weight * turb_octave(log_r, turns, t, spin, kappa, m, life,
                                          0x5bd1e995u * uint(octave + 1));
        result.variance += weight * weight;
        // Per-octave rms falls as l^(5/6) and eddy turnover time as l^(2/3).
        kappa *= 2.0f;
        m *= 2.0f;
        life *= 0.63f;
        amplitude *= 0.5612f;
    }
    return result;
}

// Local photospheric heating relative to its annular mean. `contrast` (0..1)
// sets the log-normal width: the recorded midplane pressure is compressed by
// radiative diffusion (exponent beta) and the unresolved cascade adds sigma.
// E[A^beta] = exp(-0.437 beta (1 - beta)) for the packaged flow statistics.
BH_INLINE float turbulent_heating(float activity, TurbulenceSample eddies, float contrast) {
    float beta = 0.70f * contrast;
    float sigma = 0.50f * contrast;
    float large = BH_EXP(beta * BH_LOG(BH_MAX(activity, 1e-4f)) + 0.437f * beta * (1.0f - beta));
    return large * BH_EXP(sigma * eddies.field - 0.5f * sigma * sigma * eddies.variance);
}
