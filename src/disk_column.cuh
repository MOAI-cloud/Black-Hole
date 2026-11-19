#pragma once
#include "vec_math.cuh"

namespace diskcolumn {

// Mean exp(-z²/2H²) over a segment and the corresponding density-weighted
// position in [0,1]. The vertical coordinate z/H varies linearly on this short
// affine segment. This integrates an entire thin layer even if its midpoint
// lies outside the disk.
struct Column {
    real density;
    real fraction;
};

__host__ __device__ __forceinline__ Column gaussian(real start, real end) {
    if (fmin(start, end) > 8 || fmax(start, end) < -8) return {0, (real)0.5};
    const real delta = end - start;
    const real mid = (start + end) * (real)0.5;
    if (fabs(delta) < (real)0.15) {
        // Two-point Gauss quadrature avoids cancellation in nearly horizontal
        // segments, including a ray exactly parallel to the layer.
        constexpr real offset = (real)0.28867513459481287;
        const real left = mid - offset * delta, right = mid + offset * delta;
        const real a = exp(-left * left * (real)0.5);
        const real b = exp(-right * right * (real)0.5);
        return {(a + b) * (real)0.5, (real)0.5 + offset * (b - a) / (a + b)};
    }
    constexpr real inv_sqrt2 = (real)0.7071067811865475;
    constexpr real sqrt_pi_2 = (real)1.2533141373155003;
    const real lo = fmin(start, end), hi = fmax(start, end);
    real difference;
    if (lo >= 0) difference = erfc(lo * inv_sqrt2) - erfc(hi * inv_sqrt2);
    else if (hi <= 0) difference = erfc(-hi * inv_sqrt2) - erfc(-lo * inv_sqrt2);
    else difference = erf(hi * inv_sqrt2) - erf(lo * inv_sqrt2);
    const real integral = sqrt_pi_2 * difference;
    const real centroid = (exp(-lo * lo * (real)0.5) - exp(-hi * hi * (real)0.5)) / integral;
    const real fraction = fmax((real)0, fmin((real)1, (centroid - start) / delta));
    return {integral / fabs(delta), fraction};
}

// Clip the ray to the finite disk annulus before evaluating its Gaussian
// column. The returned density includes the fraction of the original step
// spent inside the disk, so the transfer still uses the full affine step.
__host__ __device__ __forceinline__ Column sample(real r0, real th0, real r1, real th1,
                                                  real inner, real outer, real height, real flare) {
    if (fmax(r0, r1) < inner || fmin(r0, r1) > outer) return {0, (real)0.5};
    real begin = 0, end = 1;
    if (r0 != r1 && (r0 < inner || r1 < inner || r0 > outer || r1 > outer)) {
        const real a = (inner - r0) / (r1 - r0);
        const real b = (outer - r0) / (r1 - r0);
        begin = fmax((real)0, fmin(a, b));
        end = fmin((real)1, fmax(a, b));
    }
    const real ra = r0 + (r1 - r0) * begin;
    const real rb = r0 + (r1 - r0) * end;
    const real za = ra * cos(th0 + (th1 - th0) * begin);
    const real zb = rb * cos(th0 + (th1 - th0) * end);
    const Column part = gaussian(za / (height * (1 + flare * (ra - inner))),
                                 zb / (height * (1 + flare * (rb - inner))));
    return {part.density * (end - begin), begin + part.fraction * (end - begin)};
}

} // namespace diskcolumn
