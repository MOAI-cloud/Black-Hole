#pragma once
#include "vec_math.cuh"
#include <vector>
#include <cmath>

// ============================================================================
//  Physically based blackbody colour.
//
//  A temperature -> linear-sRGB lookup table is built on the host by
//  integrating Planck's law against analytic approximations of the CIE 1931
//  colour-matching functions (Wyman, Sloan & Shirley, JCGT 2013).  Each entry
//  is normalised to unit luminance (Y = 1) so that brightness can be applied
//  separately from chromaticity.
// ============================================================================

namespace bb {

constexpr int    LUT_N    = 1024;
constexpr double LUT_TMIN = 500.0;     // Kelvin
constexpr double LUT_TMAX = 40000.0;   // Kelvin

// Single Gaussian lobe used by the CIE CMF approximation.
inline double globe(double x, double mu, double s1, double s2) {
    double t = (x - mu) * (x < mu ? s1 : s2);
    return std::exp(-0.5 * t * t);
}

inline void cie_xyz_bar(double lam /*nm*/, double& X, double& Y, double& Z) {
    X = 1.056 * globe(lam, 599.8, 0.0264, 0.0323)
      + 0.362 * globe(lam, 442.0, 0.0624, 0.0374)
      - 0.065 * globe(lam, 501.1, 0.0490, 0.0382);
    Y = 0.821 * globe(lam, 568.8, 0.0213, 0.0247)
      + 0.286 * globe(lam, 530.9, 0.0613, 0.0322);
    Z = 1.217 * globe(lam, 437.0, 0.0845, 0.0278)
      + 0.681 * globe(lam, 459.0, 0.0385, 0.0725);
}

// Planck spectral radiance (arbitrary scale; only the shape matters here).
inline double planck(double lam_nm, double T) {
    double lam = lam_nm * 1e-9;           // metres
    const double c2 = 1.438776877e-2;     // h c / k_B  [m K]
    return 1.0 / (lam*lam*lam*lam*lam * (std::exp(c2 / (lam * T)) - 1.0));
}

// Build the LUT: returns LUT_N * 3 floats of Y-normalised linear sRGB.
inline std::vector<float> build_lut() {
    std::vector<float> lut(LUT_N * 3);
    for (int i = 0; i < LUT_N; ++i) {
        double f = (double)i / (LUT_N - 1);
        double T = LUT_TMIN * std::pow(LUT_TMAX / LUT_TMIN, f); // log spaced
        double X = 0, Y = 0, Z = 0;
        for (double lam = 380.0; lam <= 780.0; lam += 2.0) {
            double xb, yb, zb;
            cie_xyz_bar(lam, xb, yb, zb);
            double P = planck(lam, T);
            X += P * xb; Y += P * yb; Z += P * zb;
        }
        // XYZ -> linear sRGB (D65).
        double R =  3.2406 * X - 1.5372 * Y - 0.4986 * Z;
        double G = -0.9689 * X + 1.8758 * Y + 0.0415 * Z;
        double B =  0.0557 * X - 0.2040 * Y + 1.0570 * Z;
        R = R < 0 ? 0 : R; G = G < 0 ? 0 : G; B = B < 0 ? 0 : B;
        double Ynorm = (Y > 1e-12) ? Y : 1.0;          // normalise to unit luminance
        lut[i*3+0] = (float)(R / Ynorm);
        lut[i*3+1] = (float)(G / Ynorm);
        lut[i*3+2] = (float)(B / Ynorm);
    }
    return lut;
}

// Device-side lookup with linear interpolation over log temperature.
__device__ __forceinline__ float3 lookup(const float* lut, float T) {
    float Tc = clampf(T, (float)LUT_TMIN, (float)LUT_TMAX);
    float f = logf(Tc / (float)LUT_TMIN) / logf((float)LUT_TMAX / (float)LUT_TMIN);
    float x = f * (LUT_N - 1);
    int i0 = (int)x; if (i0 < 0) i0 = 0; if (i0 > LUT_N - 2) i0 = LUT_N - 2;
    float t = x - i0;
    float3 c0 = make_float3(lut[i0*3+0], lut[i0*3+1], lut[i0*3+2]);
    float3 c1 = make_float3(lut[(i0+1)*3+0], lut[(i0+1)*3+1], lut[(i0+1)*3+2]);
    return c0 * (1.0f - t) + c1 * t;
}

} // namespace bb

// ---- Scalar ACES filmic curve (Narkowicz fit), maps [0,inf) -> [0,1] ----
__device__ __forceinline__ float aces_scalar(float x) {
    const float a = 2.51f, b = 0.03f, c = 2.43f, d = 0.59f, e = 0.14f;
    return clampf((x * (a * x + b)) / (x * (c * x + d) + e), 0.f, 1.f);
}

// ---- Hue-preserving ACES filmic tonemap + sRGB gamma ----
// The classic per-channel ACES curve desaturates saturated highlights toward
// white, which washes out the disk's red/blue Doppler colours.  Instead we
// tonemap the luminance and keep the original chromaticity, then blend back
// toward the per-channel result only in the brightest highlights so intense
// cores still bloom cleanly to white without clipping/hue-shift artefacts.
__device__ __forceinline__ float3 aces_tonemap(float3 c) {
    const float a = 2.51f, b = 0.03f, cc = 2.43f, d = 0.59f, e = 0.14f;
    // Per-channel ACES (highlights converge to white).
    float3 num = c * (a * c + make_float3(b, b, b));
    float3 den = c * (cc * c + make_float3(d, d, d)) + make_float3(e, e, e);
    float3 perCh = make_float3(clampf(num.x/den.x, 0.f, 1.f),
                               clampf(num.y/den.y, 0.f, 1.f),
                               clampf(num.z/den.z, 0.f, 1.f));
    // Hue-preserving: tonemap luminance, scale chroma to match.
    float luma = 0.2126f*c.x + 0.7152f*c.y + 0.0722f*c.z;
    float scale = aces_scalar(luma) / fmaxf(luma, 1e-6f);
    float3 hue = make_float3(c.x*scale, c.y*scale, c.z*scale);
    // Blend: vivid (hue-preserving) in the mids, white-converging in highlights.
    float t = aces_scalar(luma); t *= t;
    float3 o = hue * (1.0f - t) + perCh * t;
    return make_float3(clampf(o.x, 0.f, 1.f), clampf(o.y, 0.f, 1.f), clampf(o.z, 0.f, 1.f));
}

__device__ __forceinline__ float linear_to_srgb(float v) {
    v = clampf(v, 0.f, 1.f);
    return (v <= 0.0031308f) ? 12.92f * v : 1.055f * powf(v, 1.0f/2.4f) - 0.055f;
}

// Quantize a linear-light channel to 8-bit sRGB, adding signed dither (in LSB
// units) and clamping.  A ~1-LSB triangular dither breaks up the visible
// banding that otherwise appears in smooth dark gradients (sky, disk falloff).
__device__ __forceinline__ unsigned char quantize8(float v, float dither) {
    float x = linear_to_srgb(v) * 255.0f + dither + 0.5f;
    return (unsigned char)(x < 0.f ? 0.f : (x > 255.f ? 255.f : x));
}
