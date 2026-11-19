#pragma once
#include "vec_math.cuh"

// ============================================================================
// Kerr spacetime in Boyer-Lindquist coordinates (G = c = M = 1).
//
// Null geodesics are integrated in Hamiltonian form with conserved p_t and
// p_phi.  State layout:
//   y = (r, theta, phi, p_r, p_theta, t)
//
// Keeping coordinate time t in the state enables time-dependent emission and
// light-travel-time effects while preserving the original momentum layout.
// ============================================================================

namespace kerr {

constexpr int STATE_N = 6;

__host__ __device__ __forceinline__ real horizon_radius(real a) {
    return (real)1.0 + sqrt(fmax((real)0.0, ((real)1 - a) * ((real)1 + a)));
}

// Keep the numerical capture surface inside the innermost equatorial
// photon orbit even for near-extremal spin. The observer or a custom
// emitting surface can lie between this radius and the usual cutoff.
__host__ __device__ __forceinline__ real capture_radius(real a, real disk_in) {
    const real horizon = horizon_radius(a);
    const real r_ph = (real)2 * ((real)1 + cos((real)(2.0 / 3.0) * acos(-a)));
    const real boundary = disk_in > horizon ? fmin(r_ph, disk_in) : r_ph;
    return horizon + fmin((real)0.0008 * horizon, (real)0.1 * (boundary - horizon));
}

__host__ __device__ __forceinline__ real metric_delta(real r, real a) {
    // This form avoids subtracting order-one terms at the extremal horizon.
    const real gap = r - (real)1;
    return gap * gap - ((real)1 - a) * ((real)1 + a);
}

// Innermost stable circular orbit (equatorial, prograde).
__host__ __device__ __forceinline__ real isco_prograde(real a) {
    real z1 = (real)1.0 + cbrt((real)1.0 - a * a) *
        (cbrt((real)1.0 + a) + cbrt((real)1.0 - a));
    real z2 = sqrt((real)3.0 * a * a + z1 * z1);
    return (real)3.0 + z2 -
        sqrt(((real)3.0 - z1) * ((real)3.0 + z1 + (real)2.0 * z2));
}

__host__ __device__ __forceinline__ void inverse_metric(
        real r, real th, real a,
        real& gtt, real& gtp, real& gpp, real& grr, real& gthth) {
    real ct = cos(th), st = sin(th);
    real s2 = st * st;
    if (s2 < (real)1e-14) s2 = (real)1e-14;
    real c2 = ct * ct;
    real r2 = r * r, a2 = a * a;
    real Sigma = r2 + a2 * c2;
    real Delta = metric_delta(r, a);
    real A = (r2 + a2) * (r2 + a2) - a2 * Delta * s2;
    real SD = Sigma * Delta;
    gtt   = -A / SD;
    gtp   = -(real)2.0 * a * r / SD;
    gpp   = (Delta - a2 * s2) / (SD * s2);
    grr   = Delta / Sigma;
    gthth = (real)1.0 / Sigma;
}

__host__ __device__ __forceinline__ void covariant_metric(
        real r, real th, real a,
        real& gtt, real& gtp, real& gpp, real& grr, real& gthth) {
    real ct = cos(th), st = sin(th);
    real s2 = st * st;
    if (s2 < (real)1e-14) s2 = (real)1e-14;
    real c2 = ct * ct;
    real r2 = r * r, a2 = a * a;
    real Sigma = r2 + a2 * c2;
    real Delta = metric_delta(r, a);
    gtt   = -((real)1.0 - (real)2.0 * r / Sigma);
    gtp   = -(real)2.0 * a * r * s2 / Sigma;
    gpp   = ((r2 + a2) + (real)2.0 * a2 * r * s2 / Sigma) * s2;
    grr   = Sigma / Delta;
    gthth = Sigma;
}

// 2H = g^{ab} p_a p_b.  A true null ray has H = 0.
__host__ __device__ __forceinline__ real hamiltonian(
        const real y[STATE_N], real pt, real pph, real a) {
    real gtt, gtp, gpp, grr, gthth;
    inverse_metric(y[0], y[1], a, gtt, gtp, gpp, grr, gthth);
    const real pr = y[3], pth = y[4];
    return (real)0.5 * (gtt * pt * pt + (real)2.0 * gtp * pt * pph +
                       gpp * pph * pph + grr * pr * pr + gthth * pth * pth);
}

// Carter constant for null geodesics, expressed in covariant momenta.
__host__ __device__ __forceinline__ real carter_constant(
        const real y[STATE_N], real pt, real pph, real a) {
    const real th = y[1];
    const real st = sin(th), ct = cos(th);
    real s2 = st * st;
    if (s2 < (real)1e-14) s2 = (real)1e-14;
    const real E = -pt;
    return y[4] * y[4] + ct * ct * (pph * pph / s2 - a * a * E * E);
}

// RHS of Hamilton equations.
__host__ __device__ __forceinline__ void geodesic_rhs(
        const real y[STATE_N], real pt, real pph, real a,
        real dy[STATE_N]) {
    // Separated Kerr Hamiltonian:
    // 2 Sigma H = Delta pr^2 + pth^2 + B^2/sin^2(theta) - P^2/Delta.
    // Keep the H terms so intermediate RK stages also follow the full
    // Hamilton equations when their momenta drift off the null surface.
    const real r = y[0], th = y[1], pr = y[3], pth = y[4];
    const real st = sin(th), ct = cos(th);
    const real s2 = fmax(st * st, (real)1e-14);
    const real inv_s2 = (real)1 / s2;
    const real a2 = a * a, r2a2 = r * r + a2;
    const real delta = metric_delta(r, a);
    const real inv_sigma = (real)1 / (r * r + a2 * ct * ct);
    const real E = -pt, aE = a * E;
    const real P = r2a2 * E - a * pph;
    const real P_delta = P / delta;
    const real B = pph - aE * s2;
    const real B_s2 = B * inv_s2;
    const real two_H = (delta * pr * pr + pth * pth +
                        B * B_s2 - P * P_delta) * inv_sigma;

    dy[0] = delta * pr * inv_sigma;
    dy[1] = pth * inv_sigma;
    dy[2] = (a * P_delta + B_s2) * inv_sigma;
    dy[5] = (r2a2 * P_delta + a * B) * inv_sigma;
    dy[3] = ((real)2 * r * E * P_delta -
             (r - (real)1) * (pr * pr + P_delta * P_delta) +
             r * two_H) * inv_sigma;
    const real L_s2 = pph * inv_s2;
    dy[4] = st * ct * (L_s2 * L_s2 - aE * aE - a2 * two_H) * inv_sigma;
}

// Adaptive Cash-Karp embedded RK4/5 step.  The returned value is a normalized
// error ratio.  err <= 1 means the step satisfies atol + rtol * scale.
__host__ __device__ __forceinline__ real rkck_step(
        const real y[STATE_N], real pt, real pph, real a, real h,
        real atol, real rtol, real y_out[STATE_N]) {
    const real b21 = (real)0.2;
    const real b31 = (real)(3.0/40.0), b32 = (real)(9.0/40.0);
    const real b41 = (real)0.3, b42 = (real)-0.9, b43 = (real)1.2;
    const real b51 = (real)(-11.0/54.0), b52 = (real)2.5,
               b53 = (real)(-70.0/27.0), b54 = (real)(35.0/27.0);
    const real b61 = (real)(1631.0/55296.0), b62 = (real)(175.0/512.0),
               b63 = (real)(575.0/13824.0), b64 = (real)(44275.0/110592.0),
               b65 = (real)(253.0/4096.0);
    const real c1 = (real)(37.0/378.0), c3 = (real)(250.0/621.0),
               c4 = (real)(125.0/594.0), c6 = (real)(512.0/1771.0);
    const real d1 = (real)(2825.0/27648.0), d3 = (real)(18575.0/48384.0),
               d4 = (real)(13525.0/55296.0), d5 = (real)(277.0/14336.0),
               d6 = (real)0.25;

    real k1[STATE_N], k2[STATE_N], k3[STATE_N], k4[STATE_N],
         k5[STATE_N], k6[STATE_N], tmp[STATE_N];

    geodesic_rhs(y, pt, pph, a, k1);
    for (int i = 0; i < STATE_N; ++i) tmp[i] = y[i] + h * (b21 * k1[i]);
    geodesic_rhs(tmp, pt, pph, a, k2);
    for (int i = 0; i < STATE_N; ++i)
        tmp[i] = y[i] + h * (b31 * k1[i] + b32 * k2[i]);
    geodesic_rhs(tmp, pt, pph, a, k3);
    for (int i = 0; i < STATE_N; ++i)
        tmp[i] = y[i] + h * (b41 * k1[i] + b42 * k2[i] + b43 * k3[i]);
    geodesic_rhs(tmp, pt, pph, a, k4);
    for (int i = 0; i < STATE_N; ++i)
        tmp[i] = y[i] + h * (b51 * k1[i] + b52 * k2[i] +
                             b53 * k3[i] + b54 * k4[i]);
    geodesic_rhs(tmp, pt, pph, a, k5);
    for (int i = 0; i < STATE_N; ++i)
        tmp[i] = y[i] + h * (b61 * k1[i] + b62 * k2[i] +
                             b63 * k3[i] + b64 * k4[i] + b65 * k5[i]);
    geodesic_rhs(tmp, pt, pph, a, k6);

    real err = (real)0.0;
    for (int i = 0; i < STATE_N; ++i) {
        const real y5 = y[i] + h * (c1 * k1[i] + c3 * k3[i] +
                                    c4 * k4[i] + c6 * k6[i]);
        // Subtract embedded slopes before adding the base coordinate. This
        // retains the local error even after t or phi has grown large.
        const real delta = h * ((c1 - d1) * k1[i] + (c3 - d3) * k3[i] +
                                (c4 - d4) * k4[i] - d5 * k5[i] +
                                (c6 - d6) * k6[i]);
        y_out[i] = y5;

        // phi and t can grow without bound.  Their absolute coordinate value
        // should not relax the local error tolerance, so scale them from the
        // local step instead of |y|.
        real scale_mag;
        if (i == 2 || i == 5)
            scale_mag = (real)1.0 + fabs(h * k1[i]);
        else
            scale_mag = fmax(fabs(y[i]), fabs(y5));

        const real denom_err = atol + rtol * fmax(scale_mag, (real)1e-12);
        const real e = fabs(delta) / denom_err;
        if (!isfinite(y5) || !isfinite(e)) return (real)INFINITY;
        if (e > err) err = e;
    }
    return err;
}

// Locate an equatorial event inside an accepted step. A secant estimate
// starts the search; the integrated angular velocity gives a Newton step.
// The bracket also covers nearly tangent crossings and extended polar angles.
__host__ __device__ __forceinline__ void equatorial_crossing(
        const real y0[STATE_N], const real y1[STATE_N], real pt, real pph,
        real a, real h, real atol, real rtol, real hit[STATE_N]) {
    const real half_pi = (real)(0.5 * M_PI);
    const real midpoint = (real)0.5 * (y0[1] + y1[1]);
    const real target = half_pi + (real)M_PI * round((midpoint - half_pi) / (real)M_PI);
    real lo = 0, hi = 1;
    real fraction = (target - y0[1]) / (y1[1] - y0[1]);
    for (int i = 0; i < 20; ++i) {
        rkck_step(y0, pt, pph, a, h * fraction, atol, rtol, hit);
        const real residual = hit[1] - target;
        if (fabs(residual) <= atol + rtol * (real)0.1) return;
        if ((residual < 0) == (y0[1] < target)) lo = fraction;
        else hi = fraction;
        const real c = cos(hit[1]);
        const real sigma = hit[0] * hit[0] + a * a * c * c;
        const real slope = h * hit[4] / sigma;
        const real next = slope != 0 ? fraction - residual / slope : lo;
        fraction = next > lo && next < hi ? next : (lo + hi) * (real)0.5;
    }
}

// A unit-frequency photon in the ZAMO tetrad. The default time component
// describes light propagating forward. For an observer's line of sight use
// time_sign = -1. The screen direction then points along the tracing path,
// and the physical photon four-momentum is the negative of its tangent.
__host__ __device__ __forceinline__ void init_photon(
        real r, real th, real a, real n_r, real n_th, real n_ph,
        real& pt, real& pph, real& pr, real& pth, int time_sign = 1) {
    real gtt, gtp, gpp, grr, gthth;
    covariant_metric(r, th, a, gtt, gtp, gpp, grr, gthth);
    const real omega = -gtp / gpp;
    const real s = sin(th);
    const real alpha = sqrt(metric_delta(r, a) * fmax(s * s, (real)1e-14) / gpp);
    pph = sqrt(gpp) * n_ph;
    pt = -time_sign * alpha - omega * pph;
    pr = sqrt(grr) * n_r;
    pth = sqrt(gthth) * n_th;
}

struct ShiftInfo {
    real g;
    real nu_fluid;
};

// The physical wavevector is minus the past-directed tracing tangent p, so
// its frequency in the emitter frame is +p_mu u^mu. Camera frequency is one.
__host__ __device__ __forceinline__ ShiftInfo disk_shift(
        real r, real th, real a, real pt, real pph,
        bool use_kinematic, bool use_gravity) {
    real gtt, gtp, gpp, grr, gthth;
    covariant_metric(r, th, a, gtt, gtp, gpp, grr, gthth);

    const real omega_gas = (real)1 / (r * sqrt(r) + a);
    const real norm = -(gtt + omega_gas * ((real)2 * gtp + omega_gas * gpp));
    if (!(norm > 0)) return {0, 0};
    const real nu_fluid = (pt + omega_gas * pph) / sqrt(norm);
    if (!(nu_fluid > 0)) return {0, 0};
    if (use_gravity && use_kinematic) return {(real)1 / nu_fluid, nu_fluid};
    if (!use_gravity && !use_kinematic) return {(real)1, nu_fluid};

    const real omega_zamo = -gtp / gpp;
    const real s = sin(th);
    const real alpha = sqrt(metric_delta(r, a) * fmax(s * s, (real)1e-14) / gpp);
    const real nu_zamo = (pt + omega_zamo * pph) / alpha;
    if (!(nu_zamo > 0)) return {0, 0};
    return {use_gravity ? (real)1 / nu_zamo : nu_zamo / nu_fluid, nu_fluid};
}

// The separated radial potential is R = P^2 - Delta K. Once its first and
// second derivatives are positive, its positive third derivative (24 r E^2)
// rules out a larger turning point for an outgoing ray.
__host__ __device__ __forceinline__ bool escapes_outward(
        real r, real pr, real pt, real pph, real a, real K) {
    if (pr <= 0) return false;
    const real E = -pt;
    const real EP = E * ((r * r + a * a) * E - a * pph);
    return (real)2 * r * EP > (r - (real)1) * K &&
           (real)2 * EP + (real)4 * r * r * E * E > K;
}

} // namespace kerr
