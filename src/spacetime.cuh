#pragma once
#include "vec_math.cuh"

// ============================================================================
//  Kerr spacetime in Boyer-Lindquist coordinates (G = c = M = 1).
//
//  Null geodesics are integrated in the Hamiltonian formulation:
//      2H = g^{ab} p_a p_b = 0   (photons)
//  State y = (r, theta, phi, p_r, p_theta).  p_t = -E and p_phi = L are
//  constants of motion (the metric is stationary & axisymmetric), so they are
//  carried as parameters.  The momentum derivatives use the exact (closed-form)
//  gradient of the inverse metric -- this avoids hand-derived Christoffel
//  symbols while keeping H conserved to ~1e-10 along each ray, and is faster
//  and more accurate than finite differencing.
// ============================================================================

namespace kerr {

__device__ __forceinline__ real horizon_radius(real a) {
    return 1.0 + sqrt(fmax(0.0, 1.0 - a * a));
}

// Inner-most stable circular orbit (equatorial, prograde) -> default disk edge.
__host__ __device__ __forceinline__ real isco_prograde(real a) {
    real z1 = 1.0 + cbrt(1.0 - a * a) * (cbrt(1.0 + a) + cbrt(1.0 - a));
    real z2 = sqrt(3.0 * a * a + z1 * z1);
    return 3.0 + z2 - sqrt((3.0 - z1) * (3.0 + z1 + 2.0 * z2));
}

// --- Contravariant (inverse) metric components ---
__device__ __forceinline__ void inverse_metric(real r, real th, real a,
        real& gtt, real& gtp, real& gpp, real& grr, real& gthth) {
    real ct = cos(th), st = sin(th);
    real s2 = st * st; if (s2 < 1e-14) s2 = 1e-14;
    real c2 = ct * ct;
    real r2 = r * r, a2 = a * a;
    real Sigma = r2 + a2 * c2;
    real Delta = r2 - 2.0 * r + a2;
    real A = (r2 + a2) * (r2 + a2) - a2 * Delta * s2;
    real SD = Sigma * Delta;
    gtt   = -A / SD;
    gtp   = -2.0 * a * r / SD;
    gpp   = (Delta - a2 * s2) / (SD * s2);
    grr   = Delta / Sigma;
    gthth = 1.0 / Sigma;
}

// --- Covariant metric components (used to build the observer tetrad) ---
__device__ __forceinline__ void covariant_metric(real r, real th, real a,
        real& gtt, real& gtp, real& gpp, real& grr, real& gthth) {
    real ct = cos(th), st = sin(th);
    real s2 = st * st; if (s2 < 1e-14) s2 = 1e-14;
    real c2 = ct * ct;
    real r2 = r * r, a2 = a * a;
    real Sigma = r2 + a2 * c2;
    real Delta = r2 - 2.0 * r + a2;
    gtt   = -(1.0 - 2.0 * r / Sigma);
    gtp   = -2.0 * a * r * s2 / Sigma;
    gpp   = ((r2 + a2) + 2.0 * a2 * r * s2 / Sigma) * s2;
    grr   = Sigma / Delta;
    gthth = Sigma;
}

// Right-hand side of the geodesic equations.  y = (r, th, phi, pr, pth).
//
// The momentum derivatives are  dp_r/dl = -1/2 d(2H)/dr  and
// dp_th/dl = -1/2 d(2H)/dtheta, where 2H = g^{ab} p_a p_b.  Because the inverse
// Kerr metric is a smooth rational function of (r, theta), its gradient is
// computed in closed form below -- this is both faster (no 8x metric
// re-evaluation per call) and more accurate (no finite-difference truncation or
// round-off) than numerical differencing.
__device__ __forceinline__ void geodesic_rhs(const real y[5], real pt, real pph,
                                             real a, real dy[5]) {
    real r = y[0], th = y[1], pr = y[3], pth = y[4];
    real ct = cos(th), st = sin(th);
    real s2 = st * st; if (s2 < 1e-14) s2 = 1e-14;
    real sc = st * ct;                 // sin(th) cos(th) = 1/2 sin(2 th)
    real c2 = ct * ct;
    real r2 = r * r, a2 = a * a;

    real Sigma = r2 + a2 * c2;
    real Delta = r2 - 2.0 * r + a2;
    real A     = (r2 + a2) * (r2 + a2) - a2 * Delta * s2;
    real SD    = Sigma * Delta;

    // --- Inverse metric components (gtt is only needed via its gradient) ---
    real gtp   = -2.0 * a * r / SD;
    real gpp   = (Delta - a2 * s2) / (SD * s2);
    real grr   = Delta / Sigma;
    real gthth = 1.0 / Sigma;

    dy[0] = grr * pr;                 // dr/dl
    dy[1] = gthth * pth;             // dtheta/dl
    dy[2] = gtp * pt + gpp * pph;    // dphi/dl

    // --- Building-block derivatives ---
    real Sig_r = 2.0 * r;
    real Del_r = 2.0 * r - 2.0;
    real A_r   = 4.0 * r * (r2 + a2) - a2 * Del_r * s2;
    real SD_r  = Sig_r * Delta + Sigma * Del_r;

    real Sig_t = -2.0 * a2 * sc;            // dSigma/dtheta
    real A_t   = -2.0 * a2 * Delta * sc;    // dA/dtheta   (Delta_theta = 0)
    real SD_t  = Sig_t * Delta;             // d(Sigma*Delta)/dtheta
    real s2_t  = 2.0 * sc;                  // d(sin^2 theta)/dtheta

    real invSD2 = 1.0 / (SD * SD);
    real invS2  = 1.0 / (Sigma * Sigma);

    // --- d(inverse metric)/dr ---
    real Npp   = Delta - a2 * s2;           // gpp numerator (times s2)
    real gtt_r = -(A_r * SD - A * SD_r) * invSD2;
    real gtp_r = -2.0 * a * (SD - r * SD_r) * invSD2;
    real gpp_r = (Del_r * SD - Npp * SD_r) * invSD2 / s2;
    real grr_r = (Del_r * Sigma - Delta * Sig_r) * invS2;
    real gth_r = -Sig_r * invS2;

    // --- d(inverse metric)/dtheta ---
    real denom   = SD * s2;
    real denom_t = SD_t * s2 + SD * s2_t;
    real gtt_t = -(A_t * SD - A * SD_t) * invSD2;
    real gtp_t = 2.0 * a * r * SD_t * invSD2;
    real gpp_t = ((-a2 * s2_t) * denom - Npp * denom_t) / (denom * denom);
    real grr_t = -Delta * Sig_t * invS2;
    real gth_t = -Sig_t * invS2;

    real dHr = gtt_r*pt*pt + 2.0*gtp_r*pt*pph + gpp_r*pph*pph
             + grr_r*pr*pr + gth_r*pth*pth;
    real dHt = gtt_t*pt*pt + 2.0*gtp_t*pt*pph + gpp_t*pph*pph
             + grr_t*pr*pr + gth_t*pth*pth;

    dy[3] = -0.5 * dHr;
    dy[4] = -0.5 * dHt;
}

// ---------------------------------------------------------------------------
//  Adaptive Cash-Karp RKF45 step.  Returns the estimated max error; on output
//  y_out holds the 5th-order solution for step h.
// ---------------------------------------------------------------------------
__device__ __forceinline__ real rkck_step(const real y[5], real pt, real pph,
                                          real a, real h, real y_out[5]) {
    // Cash-Karp coefficients.
    const real b21 = 0.2;
    const real b31 = 3.0/40.0,    b32 = 9.0/40.0;
    const real b41 = 0.3,         b42 = -0.9,        b43 = 1.2;
    const real b51 = -11.0/54.0,  b52 = 2.5,         b53 = -70.0/27.0,  b54 = 35.0/27.0;
    const real b61 = 1631.0/55296.0, b62 = 175.0/512.0, b63 = 575.0/13824.0,
               b64 = 44275.0/110592.0, b65 = 253.0/4096.0;
    const real c1 = 37.0/378.0, c3 = 250.0/621.0, c4 = 125.0/594.0, c6 = 512.0/1771.0;
    const real d1 = 2825.0/27648.0, d3 = 18575.0/48384.0, d4 = 13525.0/55296.0,
               d5 = 277.0/14336.0, d6 = 0.25;

    real k1[5], k2[5], k3[5], k4[5], k5[5], k6[5], tmp[5];
    geodesic_rhs(y, pt, pph, a, k1);
    for (int i = 0; i < 5; ++i) tmp[i] = y[i] + h*(b21*k1[i]);
    geodesic_rhs(tmp, pt, pph, a, k2);
    for (int i = 0; i < 5; ++i) tmp[i] = y[i] + h*(b31*k1[i] + b32*k2[i]);
    geodesic_rhs(tmp, pt, pph, a, k3);
    for (int i = 0; i < 5; ++i) tmp[i] = y[i] + h*(b41*k1[i] + b42*k2[i] + b43*k3[i]);
    geodesic_rhs(tmp, pt, pph, a, k4);
    for (int i = 0; i < 5; ++i) tmp[i] = y[i] + h*(b51*k1[i] + b52*k2[i] + b53*k3[i] + b54*k4[i]);
    geodesic_rhs(tmp, pt, pph, a, k5);
    for (int i = 0; i < 5; ++i) tmp[i] = y[i] + h*(b61*k1[i] + b62*k2[i] + b63*k3[i] + b64*k4[i] + b65*k5[i]);
    geodesic_rhs(tmp, pt, pph, a, k6);

    real err = 0.0;
    for (int i = 0; i < 5; ++i) {
        real y5 = y[i] + h*(c1*k1[i] + c3*k3[i] + c4*k4[i] + c6*k6[i]);
        real y4 = y[i] + h*(d1*k1[i] + d3*k3[i] + d4*k4[i] + d5*k5[i] + d6*k6[i]);
        y_out[i] = y5;
        real scale = fabs(y[i]) + fabs(h*k1[i]) + 1e-12;
        real e = fabs(y5 - y4) / scale;
        if (e > err) err = e;
    }
    return err;
}

// ---------------------------------------------------------------------------
//  Build the locally-non-rotating (ZAMO) orthonormal tetrad at (r, th) and
//  emit the initial photon 4-momentum for a ray whose direction in that frame
//  is (n_r, n_th, n_ph)  (unit spatial vector, frame energy = 1).
//  Outputs the conserved p_t, p_phi and the initial p_r, p_theta.
// ---------------------------------------------------------------------------
__device__ __forceinline__ void init_photon(real r, real th, real a,
        real n_r, real n_th, real n_ph,
        real& pt, real& pph, real& pr, real& pth) {
    real gtt, gtp, gpp, grr, gthth;
    covariant_metric(r, th, a, gtt, gtp, gpp, grr, gthth);

    real omega = -gtp / gpp;                          // frame-dragging angular velocity
    real alpha = sqrt(fmax(1e-12, gtp*gtp/gpp - gtt)); // lapse

    // Contravariant photon momentum p^mu = e_(0)^mu + n^i e_(i)^mu  (E_loc = 1).
    real pt_up  = 1.0 / alpha;
    real pph_up = omega / alpha + n_ph / sqrt(gpp);
    real pr_up  = n_r  / sqrt(grr);
    real pth_up = n_th / sqrt(gthth);

    // Lower indices.
    pt  = gtt * pt_up + gtp * pph_up;
    pph = gtp * pt_up + gpp * pph_up;
    pr  = grr * pr_up;
    pth = gthth * pth_up;
}

} // namespace kerr
