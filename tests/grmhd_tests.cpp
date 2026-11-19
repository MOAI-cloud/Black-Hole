#include "flow/atlas.h"

#include <algorithm>
#include <cmath>
#include <cstdio>

namespace {
struct Pair { float x, y; };

Pair bilinear(const unsigned char* atlas, float u, float v, float frame) {
    const float x = (u - std::floor(u)) * grmhd::azimuths - .5f;
    const float y = std::clamp(v * grmhd::radii - .5f, 0.f, float(grmhd::radii - 1));
    const int ix = int(std::floor(x)), iy = int(y);
    const float fx = x - ix, fy = y - iy;
    Pair result{};
    for (int j = 0; j < 2; ++j) {
        const int row = std::min(iy + j, grmhd::radii - 1);
        for (int k = 0; k < 2; ++k) {
            const int col = (ix + k + grmhd::azimuths) % grmhd::azimuths;
            const size_t i = ((size_t(frame) * grmhd::radii + row) * grmhd::azimuths + col) * 2;
            const float weight = (j ? fy : 1-fy) * (k ? fx : 1-fx) / 255.f;
            result.x += weight * atlas[i];
            result.y += weight * atlas[i+1];
        }
    }
    return result;
}

#define BH_INLINE inline
#define BH_TIME double
#define BH_SQRT std::sqrt
#define BH_LOG std::log
#define BH_EXP std::exp
#define BH_MAX std::max
#define BH_MIN std::min
#define BH_FLOOR std::floor
#define BH_FLOOR_TIME std::floor
#define FLOW_SAMPLER const unsigned char*
#define FLOW_PAIR Pair
#define FLOW_SAMPLE bilinear
#include "flow/sampling.inl"

int failures = 0;
void check(bool pass, const char* name) {
    if (!pass) { ++failures; std::fprintf(stderr, "FAIL %s\n", name); }
}
}

int main() {
    constexpr double pi = 3.14159265358979323846;
    // Each hemisphere has a separate data-derived residual and unit mean,
    // so changing material leaves the nominal radial flux law in place.
    double north_south = 0, temporal = 0;
    const int samples = grmhd::frames * grmhd::radii * grmhd::azimuths;
    for (int t = 0; t < grmhd::frames; ++t) {
        for (int r = 0; r < grmhd::radii; ++r) {
            double mean[2]{};
            for (int p = 0; p < grmhd::azimuths; ++p) {
                const int i = ((t * grmhd::radii + r) * grmhd::azimuths + p) * 2;
                for (int k = 0; k < 2; ++k) mean[k] += std::pow(grmhd::atlas[i+k] / 85., 2);
                north_south += std::abs(grmhd::atlas[i+1] - grmhd::atlas[i]);
                if (t) temporal += std::abs(grmhd::atlas[i] - grmhd::atlas[i-2*grmhd::radii*grmhd::azimuths]);
            }
            check(std::abs(mean[0]/128 - 1) < .005 && std::abs(mean[1]/128 - 1) < .005,
                  "flux budget of source annulus");
        }
    }
    check(north_south / samples > 10 && temporal / samples > 5, "distinct evolved flow and hemispheres");

    // Pure orbital advection preserves each ring's Fourier amplitudes,
    // even if every ring rotates at a different rate.
    double growth = 0, initial_power = 0;
    for (int r = 50; r < 115; r += 4) {
        for (int mode = 1; mode <= 12; ++mode) {
            for (int t = 0; t < grmhd::frames-6; t += 5) {
                double amplitude[2]{};
                for (int sample = 0; sample < 2; ++sample) {
                    double cosine = 0, sine = 0;
                    const int frame = t + 6*sample;
                    for (int p = 0; p < 128; ++p) {
                        const float pixel = grmhd::atlas[((frame*grmhd::radii + r)*128 + p)*2] / 85.f;
                        cosine += pixel*pixel*std::cos(2*pi*p*mode/128);
                        sine += pixel*pixel*std::sin(2*pi*p*mode/128);
                    }
                    amplitude[sample] = std::hypot(cosine, sine);
                }
                initial_power += amplitude[0];
                growth += std::abs(amplitude[0] - amplitude[1]);
            }
        }
    }
    check(growth / initial_power > .2, "intrinsic turbulence beyond orbital rotation");

    for (float height : {-1.f, 1.f}) {
        for (int ri : {40, 75, 112}) {
            const float r = std::exp(.5014684328f + (ri + .5f) * .02224405155f);
            const float lp = std::log((r-1.866025404f)/8.133974596f);
            const float lm = std::log((r-.133974596f)/9.866025404f);
            for (int p = 0; p < 128; p += 13) {
                const float phi = (p + .5f)*2*pi/128 - .288675135f*(lp-lm);
                const double time = 65 - 85 - 1.154700538f*(1.866025404f*lp - .133974596f*lm);
                const float value = flow_field(grmhd::atlas, r, phi, time, .5f, height);
                const int i = ((13*grmhd::radii + ri)*128 + p)*2 + int(height < 0);
                check(std::abs(value - std::pow(grmhd::atlas[i]/85., 2)) < .00015,
                      "Boyer-Lindquist event samples original source cell");
            }
        }
    }
    for (float phi = 0; phi < 6.28f; phi += .1f) {
        for (double t : {-220., -85., 50., 185.}) {
            const float a = flow_field(grmhd::atlas, 10.f, phi, t-.0001, .5f, 1.f);
            const float b = flow_field(grmhd::atlas, 10.f, phi, t+.0001, .5f, 1.f);
            check(std::abs(a-b) < .001, "forward record continuity at positive and negative epochs");
            check(std::abs(b-flow_field(grmhd::atlas, 10.f, phi+2*pi, t+.0001, .5f, 1.f)) < .0001,
                  "azimuth periodicity");
        }
    }
    check(flow_field(grmhd::atlas, 150.f, 1.f, 0., .99f, 0.f) == 1, "outer annular mean");
    if (!failures) std::puts("GRMHD flux, time evolution and coordinate sampling passed.");
    return failures ? 1 : 0;
}
