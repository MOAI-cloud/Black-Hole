#pragma once

#include "config.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <vector>

// Host-side Novikov-Thorne / Page-Thorne flux profile builder.
//
// The profile is tabulated uniformly in log(r) and normalized so that the
// maximum emitted flux is 1.  The renderer then interprets disk_temp as the
// peak effective temperature, T_eff(r) = disk_temp * F(r)^(1/4).

struct DiskProfile {
    double r_in = 0.0;
    double r_out = 0.0;
    double log_span = 0.0;
    std::vector<float> flux;

    bool valid() const {
        return r_in > 0.0 && r_out > r_in && log_span > 0.0 && flux.size() >= 2;
    }
};

namespace diskprofile {

struct CircularOrbit {
    double E = 0.0;
    double L = 0.0;
    double Omega = 0.0;
    bool valid = false;
};

// Prograde equatorial circular geodesic in Kerr, M=1.
inline CircularOrbit circular_orbit(double r, double a) {
    CircularOrbit o;
    if (!(r > 0.0) || !std::isfinite(r) || !std::isfinite(a)) return o;

    const double sr = std::sqrt(r);
    const double r32 = r * sr;
    const double rad = r32 - 3.0 * sr + 2.0 * a;
    if (!(rad > 0.0)) return o;

    const double root = std::sqrt(rad);
    const double r34 = std::pow(r, 0.75);
    const double denom = r34 * root;
    if (!(denom > 0.0)) return o;

    o.E = (r32 - 2.0 * sr + a) / denom;
    o.L = (r * r - 2.0 * a * sr + a * a) / denom;
    o.Omega = 1.0 / (r32 + a);
    o.valid = std::isfinite(o.E) && std::isfinite(o.L) && std::isfinite(o.Omega);
    return o;
}

inline double dL_dr(double r, double a, double r_floor) {
    const double h = std::max(1e-6, 2e-5 * r);
    const double rm = std::max(r_floor, r - h);
    const double rp = r + h;
    const CircularOrbit om = circular_orbit(rm, a);
    const CircularOrbit op = circular_orbit(rp, a);
    if (!om.valid || !op.valid || !(rp > rm)) return 0.0;
    return (op.L - om.L) / (rp - rm);
}

inline double dOmega_dr(double r, double a) {
    const double sr = std::sqrt(r);
    const double d = r * sr + a;
    return -1.5 * sr / (d * d);
}

inline DiskProfile build_novikov_thorne(double a, double r_in, double r_out,
                                        int n = 4096) {
    DiskProfile out;
    out.r_in = r_in;
    out.r_out = r_out;
    out.log_span = std::log(r_out / r_in);
    if (!(r_in > 0.0) || !(r_out > r_in) || n < 16 || !(out.log_span > 0.0))
        return out;

    std::vector<double> r((size_t)n);
    std::vector<double> integrand((size_t)n, 0.0);
    std::vector<double> integral((size_t)n, 0.0);
    std::vector<double> raw((size_t)n, 0.0);

    // Stay infinitesimally outside the no-torque boundary for derivatives.
    const double deriv_floor = r_in * (1.0 + 1e-8);

    for (int i = 0; i < n; ++i) {
        const double u = (double)i / (double)(n - 1);
        r[(size_t)i] = r_in * std::exp(out.log_span * u);
        const double rr = std::max(r[(size_t)i], deriv_floor);
        const CircularOrbit o = circular_orbit(rr, a);
        if (!o.valid) continue;
        const double emol = o.E - o.Omega * o.L;
        integrand[(size_t)i] = emol * dL_dr(rr, a, deriv_floor);
    }

    for (int i = 1; i < n; ++i) {
        const double dr = r[(size_t)i] - r[(size_t)i - 1];
        integral[(size_t)i] = integral[(size_t)i - 1] +
            0.5 * dr * (integrand[(size_t)i - 1] + integrand[(size_t)i]);
    }

    double peak = 0.0;
    for (int i = 1; i < n; ++i) {
        const double rr = r[(size_t)i];
        const CircularOrbit o = circular_orbit(rr, a);
        if (!o.valid) continue;
        const double emol = o.E - o.Omega * o.L;
        if (!(emol > 0.0)) continue;

        // Page-Thorne flux shape (Mdot and 4*pi overall normalization omitted).
        // For the equatorial thin-disk surface in Boyer-Lindquist coordinates,
        // the determinant factor entering this radial flux expression reduces
        // to r.  Only the radial shape matters here because we normalize it.
        const double F = -dOmega_dr(rr, a) * integral[(size_t)i] /
                         (rr * emol * emol);
        raw[(size_t)i] = std::max(0.0, F);
        peak = std::max(peak, raw[(size_t)i]);
    }

    if (!(peak > 0.0) || !std::isfinite(peak)) {
        out.flux.clear();
        return out;
    }

    out.flux.resize((size_t)n);
    for (int i = 0; i < n; ++i)
        out.flux[(size_t)i] = (float)std::max(0.0, raw[(size_t)i] / peak);
    out.flux[0] = 0.0f;
    return out;
}

inline DiskProfile build(const RenderConfig& cfg, double r_in, double r_out) {
    if (cfg.disk_model != DISK_MODEL_NOVIKOV_THORNE)
        return DiskProfile{};
    DiskProfile p = build_novikov_thorne(cfg.spin, r_in, r_out);
    if (!p.valid())
        std::fprintf(stderr,
            "warning: failed to build Novikov-Thorne profile; using legacy disk profile\n");
    return p;
}

} // namespace diskprofile
