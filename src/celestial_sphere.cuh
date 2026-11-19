#pragma once
#include "spacetime.cuh"

namespace kerr {

// Outside the disk and beyond every radial turning point, compactify the
// remaining vacuum path with u = 1/r. The endpoint u=0 is infinity.
// Requiring b/r <= 1/4 keeps the radial integrands smooth on this last arc.
__host__ __device__ __forceinline__ real sky_tail_radius(
        real a, real pt, real pph, real Q, real disk_out) {
    if (pt == 0) return (real)INFINITY;
    const real angular_bound = sqrt(fmax((real)0, Q + pph * pph + a * a * pt * pt));
    return fmax(fmax((real)48, disk_out), (real)4 * angular_bound / fabs(pt));
}

struct SkyArc {
    vec3 n; // unit radial direction, in the frame with azimuthal drag removed
    vec3 v; // dn/dx, x runs from 0 to 1 along this Mino-time arc
};

// On the unit sphere the separated polar potential is -a²E² n_z²/2.
// This Cartesian equation is regular even if the arc crosses a polar axis.
__host__ __device__ __forceinline__ vec3 angular_acceleration(SkyArc s, real A) {
    const real force = A * s.n.z;
    vec3 accel = s.n * (-dot(s.v, s.v) - force * s.n.z);
    accel.z += force;
    return accel;
}

__host__ __device__ __forceinline__ SkyArc angular_step(SkyArc s, real A, real h) {
    const vec3 a1 = angular_acceleration(s, A);
    const real half = h * (real)0.5;
    const SkyArc s2{s.n + s.v * half, s.v + a1 * half};
    const vec3 a2 = angular_acceleration(s2, A);
    const SkyArc s3{s.n + s2.v * half, s.v + a2 * half};
    const vec3 a3 = angular_acceleration(s3, A);
    const SkyArc s4{s.n + s3.v * h, s.v + a3 * h};
    const vec3 a4 = angular_acceleration(s4, A);
    const real scale = h / (real)6;
    return {s.n + (s.v + (s2.v + s3.v) * (real)2 + s4.v) * scale,
            s.v + (a1 + (a2 + a3) * (real)2 + a4) * scale};
}

// Integrate the two radial quadratures, then advance the remaining polar
// motion through that Mino interval. At infinity the unit radial vector is
// also the asymptotic propagation direction used by the equirectangular sky.
__host__ __device__ inline bool celestial_direction(
        const real y[STATE_N], real pt, real pph, real a, real K, real tolerance,
        vec3& direction) {
    const real E = -pt, u0 = (real)1 / y[0];
    // Composite four-point Gauss-Legendre rule in inverse radius.
    const real nodes[] = {(real)0.06943184420297371, (real)0.33000947820757187,
                          (real)0.6699905217924281, (real)0.9305681557970262};
    const real weights[] = {(real)0.1739274225687269, (real)0.3260725774312731,
                            (real)0.3260725774312731, (real)0.1739274225687269};
    real mino_time = 0, drag_angle = 0;
    // Adaptive radial quadrature is usually resolved in the first refinement.
    // The comparison uses angular units for both the time and the drag.
    real previous_time = 0, previous_drag = 0;
    const real angular_scale = sqrt(fmax((real)0, K + (real)2 * a * E * pph)) + fabs(a * E);
    bool radial_converged = false;
    for (int intervals = 1; intervals <= 16; intervals *= 2) {
        mino_time = drag_angle = 0;
        const real du = u0 / intervals;
        for (int part = 0; part < intervals; ++part) {
            for (int i = 0; i < 4; ++i) {
                const real u = (part + nodes[i]) * du, u2 = u * u;
                const real D = (real)1 - (real)2 * u + a * a * u2;
                const real P = E + a * (a * E - pph) * u2;
                const real F = P * P - D * K * u2;
                if (!(F > 0)) return false;
                const real ds = du * weights[i] / sqrt(F);
                mino_time += ds;
                drag_angle += ds * a * u * ((real)2 * E - a * pph * u) / D;
            }
        }
        if (intervals > 1 && fabs(mino_time - previous_time) * angular_scale +
                             fabs(drag_angle - previous_drag) < tolerance * (real)0.25) {
            radial_converged = true;
            break;
        }
        previous_time = mino_time;
        previous_drag = drag_angle;
    }
    if (!radial_converged) return false;

    const real st = sin(y[1]), ct = cos(y[1]), sp = sin(y[2]), cp = cos(y[2]);
    const real safe_sin = copysign(fmax(fabs(st), (real)1e-7), st);
    const vec3 n = {st * cp, st * sp, ct};
    const vec3 etheta = {ct * cp, ct * sp, -st};
    const vec3 ephi = {-sp, cp, 0};
    const real ptheta = y[4];
    const SkyArc initial{n, (etheta * ptheta + ephi * (pph / safe_sin)) * mino_time};
    const real spin_time = a * E * mino_time;
    const real A = spin_time * spin_time;
    vec3 previous = initial.n;
    for (int steps = 1; steps <= 32; steps *= 2) {
        SkyArc state = initial;
        const real h = (real)1 / steps;
        for (int i = 0; i < steps; ++i) state = angular_step(state, A, h);
        const vec3 delta = state.n - previous;
        // Step doubling: the fourth-order error contracts by a factor of 16.
        if (steps > 1 && dot(delta, delta) < (real)16 * tolerance * tolerance) {
            const vec3 end = normalize(state.n + delta * ((real)1 / (real)15));
            const real cd = cos(drag_angle), sd = sin(drag_angle);
            direction = {cd * end.x - sd * end.y, sd * end.x + cd * end.y, end.z};
            return true;
        }
        previous = state.n;
    }
    return false;
}

} // namespace kerr
