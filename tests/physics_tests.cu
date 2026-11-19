#include "spacetime.cuh"
#include "celestial_sphere.cuh"
#include "disk_profile.h"
#include "disk_column.cuh"
#include "photosphere.cuh"
#include "disk_material.cuh"
#include "disk_turbulence.cuh"
#include "blackbody.cuh"

#include <cmath>
#include <cstdio>
#include <cstdlib>

namespace {

int failures = 0;

void expect_near(const char* name, double got, double want, double tol) {
    const double err = std::fabs(got - want);
    if (err > tol || !std::isfinite(got)) {
        std::fprintf(stderr, "FAIL %-32s got %.16g expected %.16g (tol %.3g)\n",
                     name, got, want, tol);
        ++failures;
    } else {
        std::printf("PASS %-32s %.12g\n", name, got);
    }
}

void expect_true(const char* name, bool ok) {
    if (!ok) {
        std::fprintf(stderr, "FAIL %s\n", name);
        ++failures;
    } else {
        std::printf("PASS %s\n", name);
    }
}

bool adaptive_step(real y[kerr::STATE_N], real pt, real pph, real a,
                   real& h, real rtol, real atol, real max_step,
                   real* accepted_error = nullptr) {
    real yn[kerr::STATE_N];
    real err = 0.0;
    for (int tries = 0; tries < 30; ++tries) {
        err = kerr::rkck_step(y, pt, pph, a, h, atol, rtol, yn);
        if (err <= 1.0) {
            for (int i = 0; i < kerr::STATE_N; ++i) y[i] = yn[i];
            const real grow = fmin((real)4.0,
                fmax((real)0.2, (real)0.9 * pow((real)1.0 / fmax(err, (real)1e-14), (real)0.2)));
            h = fmin(max_step, h * grow);
            if (accepted_error) *accepted_error = err;
            return true;
        }
        const real shrink = fmax((real)0.1,
            fmin((real)0.5, (real)0.9 * pow((real)1.0 / fmax(err, (real)1e-14), (real)0.25)));
        h *= shrink;
        if (h < (real)1e-10) return false;
    }
    return false;
}

void test_initial_null_and_invariants() {
    const real a = 0.9;
    const real r0 = 30.0;
    const real th0 = 1.15;
    real nr = -0.91, nth = 0.17, nph = 0.378;
    const real inv = 1.0 / sqrt(nr * nr + nth * nth + nph * nph);
    nr *= inv; nth *= inv; nph *= inv;

    real pt, pph, pr, pth;
    kerr::init_photon(r0, th0, a, nr, nth, nph, pt, pph, pr, pth);
    real y[kerr::STATE_N] = {r0, th0, 0.0, pr, pth, 0.0};

    const real H0 = kerr::hamiltonian(y, pt, pph, a);
    const real Q0 = kerr::carter_constant(y, pt, pph, a);
    expect_true("initial photon is null", std::fabs((double)H0) < 2e-12);

    real h = 0.15;
    double maxH = 0.0;
    double maxQrel = 0.0;
    double maxErr = 0.0;
    int accepted = 0;

    for (int i = 0; i < 12000; ++i) {
        real err = 0.0;
        if (!adaptive_step(y, pt, pph, a, h, 2e-9, 2e-12, 0.5, &err)) break;
        ++accepted;
        maxErr = std::max(maxErr, (double)err);
        const double H = std::fabs((double)kerr::hamiltonian(y, pt, pph, a));
        const double Q = (double)kerr::carter_constant(y, pt, pph, a);
        maxH = std::max(maxH, H);
        maxQrel = std::max(maxQrel,
            std::fabs(Q - (double)Q0) / std::max(1.0, std::fabs((double)Q0)));

        if (y[0] < kerr::horizon_radius(a) * 1.001 || y[0] > 200.0) break;
    }

    expect_true("invariant trace accepted steps", accepted > 20);
    expect_true("Hamiltonian stays near zero", maxH < 2e-7);
    expect_true("Carter constant is conserved", maxQrel < 2e-6);
    expect_true("normalized accepted RK error <= 1", maxErr <= 1.000001);
    expect_true("coordinate time accumulated", y[5] > 0.0);
}

enum class Fate { captured, escaped, unfinished };

// The exact impact parameter is b = L/E. Construct the finite-radius
// line of sight in the camera tetrad, then integrate into the observer's past.
Fate trace_equatorial(real a, real b) {
    const real r0 = 100.0;
    const real th0 = M_PI * 0.5;
    real gtt, gtp, gpp, grr, gthth;
    kerr::covariant_metric(r0, th0, a, gtt, gtp, gpp, grr, gthth);
    const real omega = -gtp / gpp, alpha = sqrt(-gtt - omega * gtp);
    const real nph = -b * alpha / ((1 - b * omega) * sqrt(gpp));
    const real nr = -sqrt(1 - nph * nph);

    real pt, pph, pr, pth;
    kerr::init_photon(r0, th0, a, nr, 0, nph, pt, pph, pr, pth, -1);
    real y[kerr::STATE_N] = {r0, th0, 0, pr, pth, 0};
    real h = 0.25;
    const real r_capture = kerr::capture_radius(a, 0);
    const real K = (pph + a * pt) * (pph + a * pt); // Q=0 at the equator
    bool early_escape = false;
    for (int i = 0; i < 200000; ++i) {
        if (!adaptive_step(y, pt, pph, a, h, 2e-8, 1e-11, 0.75))
            return Fate::unfinished;
        if (kerr::escapes_outward(y[0], y[3], pt, pph, a, K)) early_escape = true;
        if (y[0] < r_capture)
            return early_escape ? Fate::unfinished : Fate::captured;
        if (y[3] > 0 && y[0] > r0 + 1)
            return early_escape ? Fate::escaped : Fate::unfinished;
    }
    return Fate::unfinished;
}

void test_past_light_cone_and_shift() {
    const real a = 0.98, r = 6, th = 1.2;
    real pt, pph, pr, pth;
    kerr::init_photon(r, th, a, -1, 0, 0, pt, pph, pr, pth, -1);
    real y[kerr::STATE_N] = {r, th, 0, pr, pth, 0}, dy[kerr::STATE_N];
    kerr::geodesic_rhs(y, pt, pph, a, dy);
    expect_near("past-directed null norm", kerr::hamiltonian(y, pt, pph, a), 0, 1e-13);
    expect_true("camera ray enters the past", dy[0] < 0 && dy[5] < 0);
    real gtt, gtp, gpp, grr, gthth;
    kerr::covariant_metric(r, th, a, gtt, gtp, gpp, grr, gthth);
    expect_near("ZAMO frame dragging", dy[2] / dy[5], -gtp / gpp, 1e-14);
    expect_true("past-directed azimuth is negative", dy[2] < 0);

    // At the same Schwarzschild radius a ZAMO sees a gas speed 1/sqrt(r-2).
    // An approaching tangential photon has the special-relativistic blue shift.
    const real radius = 8, equator = M_PI * 0.5;
    const real speed = 1 / sqrt(radius - 2);
    for (int nph : {-1, 1}) {
        kerr::init_photon(radius, equator, 0, 0, 0, nph, pt, pph, pr, pth, -1);
        const auto shift = kerr::disk_shift(radius, equator, 0, pt, pph, true, true);
        const real expected = sqrt(1 - speed * speed) / (1 + nph * speed);
        expect_near(nph < 0 ? "approaching Doppler blue shift" : "receding Doppler red shift",
                    shift.g, expected, 2e-13);
        expect_near("same-radius ZAMO shift",
            kerr::disk_shift(radius, equator, 0, pt, pph, false, true).g, 1, 2e-13);
    }
    kerr::init_photon(60, equator, 0, -1, 0, 0, pt, pph, pr, pth, -1);
    const auto full = kerr::disk_shift(10, equator, 0, pt, pph, true, true);
    const auto gravity = kerr::disk_shift(10, equator, 0, pt, pph, false, true);
    const auto motion = kerr::disk_shift(10, equator, 0, pt, pph, true, false);
    expect_near("finite-camera transverse shift", full.g, sqrt(0.7 / (1 - 2.0 / 60)), 2e-13);
    expect_near("redshift factorization", gravity.g * motion.g, full.g, 2e-13);
}

void test_crossing_and_error() {
    const real a = 0.95, r = 8, th = M_PI / 2 - 0.008;
    real pt, pph, pr, pth;
    kerr::init_photon(r, th, a, -0.8, 0.6, 0, pt, pph, pr, pth, -1);
    real y[kerr::STATE_N] = {r, th, 0, pr, pth, 0}, yn[kerr::STATE_N], hit[kerr::STATE_N];
    const real h = 0.22, atol = 1e-12, rtol = 1e-9;
    const real err = kerr::rkck_step(y, pt, pph, a, h, atol, rtol, yn);
    expect_true("disk crossing bracketed", yn[1] > M_PI / 2 && err <= 1);
    kerr::equatorial_crossing(y, yn, pt, pph, a, h, atol, rtol, hit);
    expect_near("disk crossing on equator", hit[1], M_PI / 2, 1.1e-10);
    expect_true("retarded emission event", hit[5] > yn[5] && hit[5] < 0);
    y[2] = y[5] = 1e12;
    expect_near("RK error respects time origins",
                kerr::rkck_step(y, pt, pph, a, h, atol, rtol, yn), err, 1e-14);
    y[3] = NAN;
    expect_true("invalid RK trial rejected",
                std::isinf(kerr::rkck_step(y, pt, pph, a, h, atol, rtol, yn)));
}

void test_photosphere() {
    const photosphere::Shape shape{3, 22, .75, .07, .25};
    const real coreEdge = photosphere::photosphereCoreEdge(shape.inner, shape.outer);
    expect_true("closed emitting annulus", shape.field(3, 0) == 0 && shape.field(coreEdge, 0) == 0 &&
                shape.field(2.9, 0) > 0 && shape.field(22.1, 0) > 0 && shape.field(9, 0) < 0);
    for (real r : {3.02, 6., 12., 17.98}) {
        const real eps = 1e-6;
        const real numerical = (shape.field(r+eps, 0) - shape.field(r-eps, 0)) / (2*eps);
        expect_near("photosphere radial normal", -photosphere::photosphereSlope2(
                    r, shape.inner, shape.outer, shape.height, shape.flare), numerical, 2e-10);
    }
    double flux = 0;
    for (int i = 0; i < 10000; ++i) {
        const double mu = (i + .5) / 10000.;
        flux += 2 * mu * photosphere::photosphereLimb(mu) / 10000.;
    }
    expect_near("angular flux normalization", flux, 1, 2e-9);
    expect_true("scattering limb darkens at grazing incidence",
                photosphere::photosphereLimb(0) < .5 * photosphere::photosphereLimb(1));

    const real r = 8, spin = .72, h = .22;
    const real faceMu = sqrt(-shape.field(r, 0));
    real muTop = 0;
    for (int sign : {1, -1}) {
        const real theta = acos(sign * (faceMu + .01));
        real pt, pph, pr, pth;
        kerr::init_photon(r, theta, spin, -.6, sign*.8, 0, pt, pph, pr, pth, -1);
        real y[kerr::STATE_N] = {r, theta, 0, pr, pth, 0}, yn[kerr::STATE_N], hit[kerr::STATE_N];
        kerr::rkck_step(y, pt, pph, spin, h, 1e-12, 1e-9, yn);
        const bool found = photosphere::first_hit(shape, y, yn, pt, pph, spin, h, 1e-12, 1e-9, hit);
        expect_true("photosphere intercept before equator", found && sign*cos(hit[1]) > 0);
        if (!found) continue;
        expect_near("geodesic event lies on photosphere", shape.field(hit[0], cos(hit[1])), 0, 2e-9);
        expect_true("surface clock on past cone", yn[5] < hit[5] && hit[5] < 0);
        const real nu = kerr::disk_shift(hit[0], hit[1], spin, pt, pph, true, true).nu_fluid;
        const real mu = photosphere::emission_cosine(hit, spin, shape, nu);
        expect_true("emitter-frame emission angle", mu > .4 && mu < .95);
        if (sign > 0) muTop = mu;
        else expect_near("opposite faces have reflected normals", mu, muTop, 1e-12);
    }

    real pt, pph, pr, pth;
    kerr::init_photon(coreEdge+.02, M_PI/2, spin, -1, 0, 0, pt, pph, pr, pth, -1);
    real y[kerr::STATE_N] = {coreEdge+.02, M_PI/2, 0, pr, pth, 0}, yn[kerr::STATE_N], hit[kerr::STATE_N];
    kerr::rkck_step(y, pt, pph, spin, h, 1e-12, 1e-9, yn);
    const bool edge = photosphere::first_hit(shape, y, yn, pt, pph, spin, h, 1e-12, 1e-9, hit);
    expect_true("equatorial ray hits outer rim", edge);
    // Near the tangent endpoint H scales as (R_edge-r)^2. Finite precision
    // in cos(pi/2) gives an O(sqrt(epsilon)) radial contact uncertainty.
    if (edge) expect_near("radial rim contact", hit[0], coreEdge, 2e-7);

    const real tau = photosphere::photosphereDepth((shape.outer+coreEdge)*.5, shape.inner, shape.outer);
    expect_near("atmosphere tapers to vacuum", photosphere::photosphereDepth(shape.outer, 3, 22), 0, 0);
    expect_true("outer atmosphere crosses unit depth", tau > 0 && tau < 1 &&
                photosphere::photosphereDepth(coreEdge, 3, 22) > 100);
    // Both endpoints and midpoint miss this deliberately sub-step thin layer.
    const photosphere::Shape narrow{3, 22, .00005, .07, .001};
    const real theta = M_PI/2-.004;
    kerr::init_photon(r, theta, spin, 0, 1, 0, pt, pph, pr, pth, -1);
    real crossing[kerr::STATE_N] = {r, theta, 0, pr, pth, 0};
    kerr::rkck_step(crossing, pt, pph, spin, h, 1e-12, 1e-9, yn);
    const bool crossed = photosphere::first_hit(narrow, crossing, yn, pt, pph, spin, h, 1e-12, 1e-9, hit);
    expect_true("thin photosphere resolves first of both faces", crossed && cos(hit[1]) > 0);

    // Place the outer settling point just beyond a real equatorial crossing.
    // Here H is O(1e-9 M) and linear interpolation in theta misses the disk.
    const real rStart = 19.37, thetaStart = M_PI/2-.015, step = .95;
    kerr::init_photon(rStart, thetaStart, spin, -.6, .8, 0, pt, pph, pr, pth, -1);
    real grazing[kerr::STATE_N] = {rStart, thetaStart, 0, pr, pth, 0}, plane[kerr::STATE_N];
    kerr::rkck_step(grazing, pt, pph, spin, step, 1e-12, 1e-9, yn);
    kerr::equatorial_crossing(grazing, yn, pt, pph, spin, step, 1e-12, 1e-9, plane);
    const real widthFraction = (photosphere::photosphereCoreEdge(3., 22.)-3.)/19.;
    const real outer = 3 + (plane[0]+.0001-3)/widthFraction;
    const photosphere::Shape settling{3, outer, .75, .07, .25};
    const bool rim = photosphere::first_hit(settling, grazing, yn, pt, pph, spin, step,
                                            1e-12, 1e-9, hit);
    expect_true("grazing ray resolves the settled outer face", rim);
    if (rim) expect_near("settled face clock vs equator", hit[5], plane[5], 2e-7);
}

void test_volume_column() {
    const auto crossing = diskcolumn::gaussian(-18, 6);
    const double area = sqrt(2 * M_PI) * 0.5 * (erf(6 / sqrt(2.0)) - erf(-18 / sqrt(2.0)));
    const double moment = exp(-162) - exp(-18);
    expect_near("full disk column on long crossing", crossing.density * 24, area, 5e-13);
    expect_near("retarded column sample location", crossing.fraction, (18 + moment / area) / 24, 1e-13);
    const auto reverse = diskcolumn::gaussian(6, -18);
    expect_near("column orientation symmetry", reverse.density, crossing.density, 1e-13);
    expect_near("reverse column centroid", reverse.fraction, 1 - crossing.fraction, 1e-13);
    expect_near("ray parallel to disk layer", diskcolumn::gaussian(1.1, 1.1).density, exp(-1.21 / 2), 1e-13);
    const auto edge = diskcolumn::sample(3, M_PI/2, 9, M_PI/2, 5, 8, 0.1, 0.1);
    expect_near("clipped annular column", edge.density, 0.5, 1e-13);
    expect_near("clipped annular centroid", edge.fraction, 3.5 / 6, 1e-13);
    expect_true("vacuum steps skip disk transfer",
                diskcolumn::sample(25, M_PI/2, 24, M_PI/2, 3, 18, 0.1, 0).density == 0);
}

void test_disk_turbulence() {
    using turbulence::turbulence_field;
    using turbulence::turbulent_heating;
    // Eddies follow the local Kerr rate: a comoving tracer sees much less
    // change over 3% of an orbit than a fixed observer, who sees them stream by.
    for (float r : {3.8f, 8.f, 14.f}) {
        const double omega = diskprofile::circular_orbit(r, 0.9).Omega;
        const double duration = 0.03 * 2 * M_PI / omega;
        double comoving = 0, stationary = 0;
        for (int epoch = 0; epoch < 8; ++epoch) {
            const double t = 13 + epoch * 0.145 * 2 * M_PI / omega;
            for (int j = 0; j < 256; ++j) {
                const float phi = (float)(2 * M_PI * j / 256);
                const float initial = turbulence_field(r, phi, t, .9f, 0).field;
                comoving += std::abs(turbulence_field(r, phi + (float)(duration * omega), t + duration, .9f, 0).field - initial);
                stationary += std::abs(turbulence_field(r, phi, t + duration, .9f, 0).field - initial);
            }
        }
        expect_true("eddies follow the local Kerr rate", comoving < 0.40 * stationary);
        expect_true("a fixed observer sees eddies stream past", stationary / (8 * 256) > 0.3);
    }
    // Unit variance, unit-mean log-normal heating and its calibrated width.
    double sum = 0, sum2 = 0, heat = 0, log_heat2 = 0, radial_variance = 0;
    constexpr int nr = 180, nph = 269;
    for (int i = 0; i < nr; ++i) {
        const float r = (float)(2.4 * exp((i + .5) / nr * log(22.0 / 2.4)));
        double annulus = 0;
        for (int j = 0; j < nph; ++j) {
            const float phi = (float)(2 * M_PI * (j + .5) / nph);
            const auto sample = turbulence_field(r, phi, 87, .91f, 0);
            sum += sample.field;
            sum2 += sample.field * sample.field;
            // Small-scale factor alone: divide out the calibrated large-scale term.
            const double q = turbulent_heating(1.f, sample, 1.f) / turbulent_heating(1.f, {0, 0}, 1.f);
            heat += q;
            log_heat2 += log(q) * log(q);
            annulus += q;
        }
        radial_variance += pow(annulus / nph - 1, 2);
    }
    const double n = (double)nr * nph;
    expect_near("zero-mean eddy field", sum / n, 0, 0.05);
    expect_near("unit-variance eddy field", sqrt(sum2 / n), 1, 0.08);
    expect_near("unit-mean turbulent heating", heat / n, 1, 0.03);
    expect_near("log-normal heating width", sqrt(log_heat2 / n), 0.5, 0.06);
    expect_true("no artificial bright or empty rings", sqrt(radial_variance / nr) < 0.12);
    // Recorded flow with the stored statistics: the compressed large scales
    // keep the annular mean (E[A^beta] calibration).
    const double beta_mean = 0.5 * (turbulent_heating(0.25f, {0, 0}, 1.f) + turbulent_heating(1.75f, {0, 0}, 1.f));
    expect_true("compressed flow contrast", beta_mean > 0.85 && beta_mean < 1.15);
    expect_near("no contrast without clumping", turbulent_heating(4.f, turbulence_field(8, 1, 22, .9f, 0), 0.f), 1, 1e-6);
    // Eddies smaller than the footprint integrate to their mean.
    const auto unresolved = turbulence_field(8, 1, 22, .91f, 1.0f);
    expect_near("sub-pixel eddies integrate to the mean", unresolved.field, 0, 0);
    expect_near("sub-pixel eddies carry no variance", unresolved.variance, 0, 0);
    expect_near("periodic eddy azimuth", turbulence_field(9, -0.12f, -38, .9f, 0).field,
                turbulence_field(9, (float)(2 * M_PI - .12), -38, .9f, 0).field, 2e-3);
    // Continuity exactly at generation renewals, including the 65535 -> 0
    // generation wrap at a negative retarded time. At a band's guiding radius
    // the octave is that band alone.
    double renewal_jump = 0;
    for (int octave : {0, 3}) {
        const float kappa = TURB_KAPPA0 * (1 << octave), m = TURB_M0 * (1 << octave);
        const float life = TURB_LIFE0 * powf(0.63f, (float)octave);
        const unsigned layer = 0x5bd1e995u * (octave + 1);
        for (int band : {6, 11, 15}) {
            const unsigned id = turbulence::turb_hash((unsigned)(band + 4096) * 0x9e3779b9u ^ layer);
            const double period = 2 * M_PI * (exp(1.5 * TURB_BAND * band) + 0.9);
            const float r = (float)exp(TURB_BAND * band);
            for (int epoch : {0, 5}) {
                const double t = (epoch - (double)turbulence::turb_unit(id)) * life * period;
                for (int j = 0; j < 64; ++j) {
                    const float phi = (float)(2 * M_PI * (j + .5) / 64);
                    renewal_jump = std::max(renewal_jump, (double)std::abs(
                        turbulence::turb_octave(logf(r), phi / (float)(2 * M_PI), t + 1e-6, .9f, kappa, m, life, layer) -
                        turbulence::turb_octave(logf(r), phi / (float)(2 * M_PI), t - 1e-6, .9f, kappa, m, life, layer)));
                }
            }
        }
    }
    expect_true("smooth eddy renewal", renewal_jump < 2e-3);
    // Random events: no jumps in time or across radial band seams.
    unsigned seed = 7;
    double time_jump = 0, radial_jump = 0;
    for (int k = 0; k < 40000; ++k) {
        seed = seed * 1664525u + 1013904223u;
        const float r = 2.5f + 30.f * (seed >> 8) / 16777216.f;
        seed = seed * 1664525u + 1013904223u;
        const float phi = (float)(2 * M_PI) * (seed >> 8) / 16777216.f;
        seed = seed * 1664525u + 1013904223u;
        const double t = -4000.0 + 8000.0 * (seed >> 8) / 16777216.0;
        time_jump = std::max(time_jump, (double)std::abs(turbulence_field(r, phi, t + 1e-5, .9f, 0).field -
                                                         turbulence_field(r, phi, t - 1e-5, .9f, 0).field));
        radial_jump = std::max(radial_jump, (double)std::abs(turbulence_field(r * 1.00002f, phi, t, .9f, 0).field -
                                                             turbulence_field(r * 0.99998f, phi, t, .9f, 0).field));
    }
    std::printf("     max eddy change over 2e-5 M %.3g, over a 4e-5 radial step %.3g\n", time_jump, radial_jump);
    expect_true("continuous eddy evolution", time_jump < 0.01);
    expect_true("continuous across radial bands", radial_jump < 0.15);
    for (float c : {0.f, .9f, 1.f}) {
        for (float heating : {1e-8f, .3f, 1.f, 14.f}) {
            const auto surface = diskmaterial::surface(c, heating, 1);
            const auto volume = diskmaterial::volume(heating);
            expect_true("surface covering fraction", surface.weight >= 0 && surface.weight <= 1);
            expect_near("surface thermal flux", surface.weight * pow(surface.temperature_scale, 4), heating, 5e-6);
            expect_near("volume thermal flux", volume.weight * pow(volume.temperature_scale, 4), heating, 5e-6);
        }
    }
}

void test_disk_flux() {
    const DiskProfile profile = diskprofile::build_novikov_thorne(0, 6, 60);
    expect_true("Schwarzschild flux table", profile.valid());
    if (!profile.valid()) return;
    expect_near("zero-torque inner boundary", profile.flux.front(), 0, 1e-14);
    expect_near("NT peak flux normalization", *std::max_element(profile.flux.begin(),
                profile.flux.end()), 1, 1e-7);
    // Integrating (E-Omega*L) dL/dr in closed form for a=0 provides an
    // independent reference for the table's radial shape.
    auto primitive = [](double x) {
        const double k = sqrt(3.0);
        return x - 0.5 * k * log((x - k) / (x + k));
    };
    auto flux = [&](size_t i) {
        const double r = 6 * exp(profile.log_span * i / (profile.flux.size() - 1));
        return (primitive(sqrt(r)) - primitive(sqrt(6.0))) /
               (pow(r, 3.5) * (1 - 3 / r));
    };
    expect_near("Schwarzschild NT radial shape", profile.flux[3000] / profile.flux[1000],
                flux(3000) / flux(1000), 2e-6);
}

void test_celestial_direction() {
    for (const double a : {0.0, 0.9, 0.9999}) {
        for (const double th : {0.024, 1.5}) {
            const real r = 100;
            const real nth = -0.12, nph = th < 0.1 ? 0.0001 : 0.16;
            const real nr = sqrt(1 - nth * nth - nph * nph);
            real pt, pph, pr, pth;
            kerr::init_photon(r, th, a, nr, nth, nph, pt, pph, pr, pth, -1);
            real y[kerr::STATE_N] = {r, th, 0.72, pr, pth, 0};
            const real Q = kerr::carter_constant(y, pt, pph, a);
            const real K = Q + (pph + a * pt) * (pph + a * pt);
            expect_true("vacuum tail starts outside turn",
                        r >= kerr::sky_tail_radius(a, pt, pph, Q, 22) &&
                        kerr::escapes_outward(r, pr, pt, pph, a, K));
            vec3 sky{};
            const bool resolved = kerr::celestial_direction(y, pt, pph, a, K, 1e-10, sky);
            expect_true("compact arc resolves to infinity", resolved);
            if (!resolved) continue;

            // Independent affine integration, including a near-polar turning
            // point, followed by a Cartesian tangent far in the weak field.
            real h = 0.05;
            for (int i = 0; i < 20000 && y[0] < 1e6; ++i) {
                if (!adaptive_step(y, pt, pph, a, h, 5e-12, 1e-14, y[0] * 0.1)) break;
            }
            expect_true("affine reference reaches far sky", y[0] >= 1e6);
            real dy[kerr::STATE_N];
            kerr::geodesic_rhs(y, pt, pph, a, dy);
            const real st = sin(y[1]), ct = cos(y[1]), sp = sin(y[2]), cp = cos(y[2]);
            const vec3 er{st * cp, st * sp, ct}, eth{ct * cp, ct * sp, -st}, eph{-sp, cp, 0};
            const vec3 affine = normalize(er * dy[0] + eth * (y[0] * dy[1]) +
                                          eph * (y[0] * st * dy[2]));
            expect_near("asymptotic sky vs affine tangent", length(sky - affine), 0, 2e-9);
        }
    }
}

void test_visible_radiance() {
    // Compare lookup and interpolation against direct optical photometry.
    // The common wavelength interval and Planck scale cancel in this ratio.
    auto y_band = [](double T) {
        double y_sum = 0;
        for (double lambda = 380; lambda <= 780; lambda += 2) {
            double x, y, z;
            bb::cie_xyz_bar(lambda, x, y, z);
            y_sum += y * bb::planck(lambda, T);
        }
        return y_sum;
    };
    const auto lut = bb::build_lut(9000.0);
    for (double T : {2700.0, 9000.0, 25000.0, 2e6}) {
        const float3 rgb = bb::lookup(lut.data(), (float)T);
        const double luma = 0.2126 * rgb.x + 0.7152 * rgb.y + 0.0722 * rgb.z;
        expect_near("visible blackbody photometry", luma / (y_band(T) / y_band(9000)),
                    1, 1.2e-3);
    }
    const float3 cold = bb::lookup(lut.data(), 0);
    expect_true("cold boundary emits no light", cold.x == 0 && cold.y == 0 && cold.z == 0);
}

} // namespace

int main() {
    expect_near("Schwarzschild horizon", kerr::horizon_radius(0.0), 2.0, 1e-14);
    expect_near("Kerr a=0.9 horizon", kerr::horizon_radius(0.9),
                1.0 + std::sqrt(0.19), 1e-13);
    expect_near("Schwarzschild ISCO", kerr::isco_prograde(0.0), 6.0, 1e-13);
    expect_near("Kerr a=0.9 ISCO", kerr::isco_prograde(0.9),
                2.320883041761887, 2e-12);

    const double near_extremal = 1.0 - 1e-12;
    const double photon_radius = 2 * (1 + cos((2.0 / 3.0) * acos(-near_extremal)));
    const double capture = kerr::capture_radius(near_extremal, 0);
    expect_true("capture inside extreme photon orbit",
                capture > kerr::horizon_radius(near_extremal) && capture < photon_radius);
    expect_true("near-extremal lapse is real", kerr::metric_delta(capture, near_extremal) > 0);

    test_initial_null_and_invariants();
    test_past_light_cone_and_shift();
    test_crossing_and_error();
    test_photosphere();
    test_disk_flux();
    test_volume_column();
    test_disk_turbulence();
    test_visible_radiance();
    test_celestial_direction();

    const double bc = 3.0 * std::sqrt(3.0);
    expect_true("Schwarzschild ray below b_c is captured",
                trace_equatorial(0, bc - 0.04) == Fate::captured);
    expect_true("Schwarzschild ray above b_c escapes",
                trace_equatorial(0, bc + 0.04) == Fate::escaped);

    // Equatorial circular photon orbits: r_ph and b = a +/- r_ph^(3/2).
    const double a = 0.9;
    for (int sign : {-1, 1}) {
        const double rph = 2 * (1 + cos((2.0 / 3.0) * acos(-sign * a)));
        const double crit = a + sign * rph * sqrt(rph);
        expect_true(sign > 0 ? "prograde Kerr capture" : "retrograde Kerr capture",
                    trace_equatorial(a, crit - sign * 0.02) == Fate::captured);
        expect_true(sign > 0 ? "prograde Kerr escape" : "retrograde Kerr escape",
                    trace_equatorial(a, crit + sign * 0.02) == Fate::escaped);
    }

    if (failures) {
        std::fprintf(stderr, "\n%d physics test(s) failed.\n", failures);
        return EXIT_FAILURE;
    }
    std::printf("\nAll Gargantua physics tests passed.\n");
    return EXIT_SUCCESS;
}
