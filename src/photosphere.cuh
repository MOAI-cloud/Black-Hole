#pragma once
#include "spacetime.cuh"

namespace photosphere {
#define PS_INLINE __host__ __device__ __forceinline__
#define PS_REAL real
#define PS_MIN fmin
#define PS_MAX fmax
#include "photosphere.inl"

struct Shape {
    real inner, outer, height, flare, max_opening;
    PS_INLINE real field(real r, real mu) const {
        return mu * mu - photosphereOpening2(r, inner, outer, height, flare);
    }
};

struct Arc {
    real r0, m0, dr0, dm0, r1, m1, dr1, dm1;

    PS_INLINE static real coordinate(real f, real x0, real v0, real x1, real v1) {
        const real l = 1-f;
        return l*l*((1+2*f)*x0+f*v0) + f*f*((3-2*f)*x1-l*v1);
    }
    PS_INLINE real latitude(real f) const { return coordinate(f,m0,dm0,m1,dm1); }
    PS_INLINE real radius(real f) const { return coordinate(f,r0,dr0,r1,dr1); }
    PS_INLINE real field(real f, const Shape& shape) const { return shape.field(radius(f),latitude(f)); }
};

// The accepted affine segment is short near the emitting annulus. Cubic
// Hermite dense output determines the first contact. One RK integration then
// reconstructs the full emission event including its clock and momenta.
PS_INLINE bool first_hit(const Shape& shape, const real* y, const real* next, real pt, real pph,
                         real spin, real h, real atol, real rtol, real* hit) {
    const real r0 = y[0], r1 = next[0];
    if (fmin(r0,r1) > shape.outer + h || fmax(r0,r1) < shape.inner - h) return false;
    const real m0 = cos(y[1]), m1 = cos(next[1]);
    if (m0 * m1 > 0 && fmin(fabs(m0), fabs(m1)) > shape.max_opening + (real).012) return false;
    const real f0 = shape.field(r0,m0);
    if (f0 <= 0) {
        for (int j = 0; j < kerr::STATE_N; ++j) hit[j] = y[j];
        return true;
    }
    const real sig0 = r0*r0 + spin*spin*m0*m0, sig1 = r1*r1 + spin*spin*m1*m1;
    const Arc arc{r0, m0, h*kerr::metric_delta(r0,spin)*y[3]/sig0, -h*sin(y[1])*y[4]/sig0,
                  r1, m1, h*kerr::metric_delta(r1,spin)*next[3]/sig1, -h*sin(next[1])*next[4]/sig1};
    const real fm = arc.field((real).5, shape), f1 = shape.field(r1,m1);
    real hi = 1;
    if (fm <= 0) hi = (real).5;
    else if (f1 > 0) {
        hi = photosphereMinimum(f0, fm, f1);
        if (arc.field(hi, shape) > 0) {
            if (m0 * m1 >= 0) return false;
            // At the shallow outer taper the entire surface can lie between
            // samples. A linear equator estimate can miss both faces. Locate
            // the zero of the cubic latitude and test its radius explicitly.
            real left = 0, right = 1;
            for (int j = 0; j < 23; ++j) {
                const real f = (left+right)*(real).5;
                const real mu = arc.latitude(f);
                if ((mu > 0) == (m0 > 0)) left = f; else right = f;
            }
            hi = (left+right)*(real).5;
            if (shape.field(arc.radius(hi),0) > 0) return false;
        }
    }
    real lo = 0;
    for (int j = 0; j < 23; ++j) {
        const real mid = (lo + hi)*(real).5;
        if (arc.field(mid,shape) <= 0) hi = mid; else lo = mid;
    }
    const real step = h*(lo+hi)*(real).5;
    kerr::rkck_step(y, pt, pph, spin, step, atol, rtol, hit);
    // Dense output and Cash-Karp have slightly different interpolation
    // errors. Correct significant residuals along the actual geodesic. Use
    // the unsquared face equation so this remains conditioned as H -> 0.
    const real r = hit[0], mu = cos(hit[1]);
    const real opening2 = photosphereOpening2(r, shape.inner, shape.outer, shape.height, shape.flare);
    if (opening2 > 0) {
        const real dense_mu = arc.latitude((lo+hi)*(real).5);
        const real face = fabs(dense_mu) > (real)1e-8 ? dense_mu : m0;
        const real opening = sqrt(opening2), sign = face >= 0 ? (real)1 : (real)-1;
        const real residual = sign*mu-opening;
        if (fabs(residual) > fmax(atol,(real)1e-10)) {
            const real sigma = r*r+spin*spin*mu*mu;
            const real slope = photosphereSlope2(r,shape.inner,shape.outer,shape.height,shape.flare);
            const real derivative = (-sign*sin(hit[1])*hit[4] -
                                     slope*kerr::metric_delta(r,spin)*hit[3]/(2*opening))/sigma;
            if (fabs(derivative) > (real)1e-12) {
                const real refined = step-residual/derivative;
                if (refined >= 0 && refined <= h && fabs(refined-step) < (real).02*h)
                    kerr::rkck_step(y, pt, pph, spin, refined, atol, rtol, hit);
            }
        }
    }
    return true;
}

PS_INLINE real emission_cosine(const real* hit, real spin, const Shape& shape, real nu) {
    const real r = hit[0], mu = cos(hit[1]);
    const real dR = -photosphereSlope2(r, shape.inner, shape.outer, shape.height, shape.flare);
    const real dTheta = -2*mu*sin(hit[1]);
    const real delta = kerr::metric_delta(r,spin), sigma = r*r + spin*spin*mu*mu;
    // The normal covector dF=(0,F_r,F_theta,0) is orthogonal to circular gas.
    // Contract with the actual Kerr wavevector in the local emitter frame.
    const real denom = nu * sqrt(sigma * (delta*dR*dR + dTheta*dTheta));
    return denom > 0 ? fmin((real)1, fabs(delta*dR*hit[3]+dTheta*hit[4])/denom) : (real)0;
}
#undef PS_INLINE
#undef PS_REAL
#undef PS_MIN
#undef PS_MAX
} // namespace photosphere
