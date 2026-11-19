// A finite disk runs out of column in its outskirts. The opaque body
// settles onto the plane before the final 14% of the annular span, where
// a thin atmosphere transmits according to its line-of-sight optical depth.
PS_INLINE PS_REAL photosphereCoreEdge(PS_REAL ri, PS_REAL ro) {
    return ro - PS_REAL(.14)*(ro-ri);
}

PS_INLINE PS_REAL photosphereDepth(PS_REAL r, PS_REAL ri, PS_REAL ro) {
    PS_REAL x = PS_MAX(PS_REAL(0), (ro-r)/(ro-photosphereCoreEdge(ri,ro)));
    return x*x / PS_MAX(PS_REAL(.0001), PS_REAL(1)-x);
}

// F(r,theta) = cos(theta)^2 - opening2(r) is negative inside the opaque gas.
// The flared body gradually settles onto the equator in its outer quarter.
// A smooth height taper avoids both a vertical end wall and a sharp surface
// normal at the join. The signed extension also brackets equatorial rim hits.
PS_INLINE PS_REAL photosphereOpening2(PS_REAL r, PS_REAL ri, PS_REAL ro, PS_REAL h, PS_REAL flare) {
    ro = photosphereCoreEdge(ri, ro);
    PS_REAL left = r - ri, right = ro - r;
    PS_REAL width = ro - ri;
    PS_REAL wi = PS_MIN(PS_REAL(.3) * ri, PS_REAL(.12) * width);
    PS_REAL t = PS_MIN(PS_REAL(1), right / (PS_REAL(.28) * width));
    PS_REAL o = t * t * (PS_REAL(3) - PS_REAL(2) * t);
    PS_REAL edges = (left / (wi + PS_MAX(left, PS_REAL(0)))) *
                    (t < PS_REAL(0) ? t : o * o);
    PS_REAL u = h * (PS_REAL(1) + flare * PS_MAX(left, PS_REAL(0))) / r;
    return edges * u * u / (PS_REAL(1) + PS_REAL(4) * u * u);
}

// Analytic radial derivative on the emitting body.
PS_INLINE PS_REAL photosphereSlope2(PS_REAL r, PS_REAL ri, PS_REAL ro, PS_REAL h, PS_REAL flare) {
    ro = photosphereCoreEdge(ri, ro);
    PS_REAL left = PS_MAX(PS_REAL(0), r - ri), right = PS_MAX(PS_REAL(0), ro - r);
    PS_REAL wi = PS_MIN(PS_REAL(.3) * ri, PS_REAL(.12) * (ro-ri));
    PS_REAL wo = PS_REAL(.28) * (ro-ri);
    PS_REAL t = PS_MIN(PS_REAL(1), right / wo);
    PS_REAL li = PS_REAL(1) / (left + wi);
    PS_REAL i = left * li, o = t*t*(PS_REAL(3)-PS_REAL(2)*t);
    PS_REAL u = h * (PS_REAL(1) + flare * left) / r;
    PS_REAL s = PS_REAL(1) / (PS_REAL(1) + PS_REAL(4)*u*u);
    return u*u*s * (wi*li*li*o*o - i*o*PS_REAL(12)*t*(PS_REAL(1)-t)/wo)
         + i*o*o * PS_REAL(2)*u*s*s * (h * flare - u) / r;
}
PS_INLINE PS_REAL photosphereLimb(PS_REAL mu) {
    // Plane-parallel scattering atmosphere, Laor, Netzer & Piran (1990).
    // 2 integral_0^1 mu L(mu) dmu = 1, conserving the specified surface flux.
    return (PS_REAL(1) + PS_REAL(2.06) * mu) / PS_REAL(2.373333333333333333);
}

// If a convex segment turns around between samples, also probe its estimated
// minimum. This catches a grazing entry followed by an exit in one ray step.
PS_INLINE PS_REAL photosphereMinimum(PS_REAL a, PS_REAL m, PS_REAL b) {
    PS_REAL curvature = a + b - PS_REAL(2)*m;
    if (curvature <= PS_REAL(0)) return PS_REAL(.5);
    return PS_MAX(PS_REAL(0), PS_MIN(PS_REAL(1), PS_REAL(.5) + PS_REAL(.25)*(a-b)/curvature));
}
