#include "render.h"
#include "vec_math.cuh"
#include "spacetime.cuh"
#include "celestial_sphere.cuh"
#include "disk_profile.h"
#include "disk_column.cuh"
#include "photosphere.cuh"
#include "disk_material.cuh"
#include "disk_turbulence.cuh"
#include "flow/atlas.h"
#include "flow/sampling.cuh"
#include "blackbody.cuh"
#include "camera_optics.cuh"
#include "starfield.cuh"
#include "png_writer.h"

#include <algorithm>
#include <cstdio>
#include <cmath>
#include <cstring>
#include <vector>

// ============================================================================
// Device parameters and diagnostics.
// ============================================================================
struct DevParams {
    int    width, height, spp;
    real   a;
    real   cam_r, cam_th, cam_ph, observer_time, shutter;
    real   tan_half_fov;
    real   aspect;
    real   fwd[3], right[3], up[3];

    int    disk_enabled;
    int    kinematic_doppler;
    int    gravitational_redshift;
    int    disk_advect;
    int    disk_model;
    real   disk_in, disk_out, disk_temp, disk_bright, disk_noise;

    int    disk_vol;
    bool   disk_photosphere;
    photosphere::Shape surface;
    real   disk_h, disk_flare, disk_absorb;

    const float* disk_flux;
    int    disk_flux_n;
    real   disk_flux_log_span;

    cudaTextureObject_t flow;
    cudaTextureObject_t starmap;
    int    sm_w, sm_h;
    real   sky_bright;
    // Companion star at infinity: unit direction (BL Cartesian, z = spin
    // axis), cos(angular radius) (> 1 disables it) and central radiance.
    float  comp_dir[3];
    float  comp_cos;
    float3 comp_radiance;
    bool   sky_visible;

    // Pixel width at the camera distance, divided by r, gives the ln r
    // footprint used to integrate unresolved turbulent eddies.
    real   pixel_footprint;

    real   rtol, atol, min_step, max_step;
    int    max_iter;
    real   r_capture, r_escape;
    real   exposure;
};

struct DevStats {
    int maxerr_bits;
    unsigned long long forced_accepts;
    unsigned long long rejected_steps;
    unsigned long long unfinished_rays;
    unsigned long long finite_sky_samples;
};

// ============================================================================
// Disk model.
// ============================================================================
__device__ __forceinline__ real legacy_disk_temperature(
        real r, real r_in, real T0) {
    if (r <= r_in) return T0;
    real x = sqrt(r_in / r);
    real f = (r_in / r) * (r_in / r) * (r_in / r) * ((real)1.0 - x);
    const real norm = (real)0.05665;
    real t = f / norm;
    return T0 * pow(fmax(t, (real)0.0), (real)0.25);
}

__device__ __forceinline__ real nt_flux_lookup(real r, const DevParams& p) {
    if (!p.disk_flux || p.disk_flux_n < 2 || p.disk_flux_log_span <= 0.0)
        return 0.0;
    if (r <= p.disk_in) return 0.0;
    if (r >= p.disk_out) r = p.disk_out;

    real u = log(r / p.disk_in) / p.disk_flux_log_span;
    u = fmin((real)1.0, fmax((real)0.0, u));
    real x = u * (p.disk_flux_n - 1);
    int i0 = (int)floor(x);
    if (i0 < 0) i0 = 0;
    if (i0 > p.disk_flux_n - 2) i0 = p.disk_flux_n - 2;
    real f = x - i0;
    return (real)p.disk_flux[i0] * ((real)1.0 - f) +
           (real)p.disk_flux[i0 + 1] * f;
}

__device__ __forceinline__ real disk_temperature(real r, const DevParams& p) {
    if (p.disk_model == DISK_MODEL_NOVIKOV_THORNE && p.disk_flux) {
        const real F = nt_flux_lookup(r, p);
        return p.disk_temp * pow(fmax(F, (real)0.0), (real)0.25);
    }
    return legacy_disk_temperature(r, p.disk_in, p.disk_temp);
}

// Local heating relative to the annular mean: the recorded flow at large
// scales and a sheared turbulent cascade below its grid (log-normal, mean 1).
__device__ __forceinline__ float disk_heating(real r, real phi, real emission_time, const DevParams& p,
                                              float height = 0.f) {
    if (p.disk_noise == 0) return 1.f;
    const real t = p.disk_advect ? emission_time : 0;
    const float activity = grmhd::flow_field(p.flow, (float)r, (float)phi, t, (float)p.a, height);
    const auto eddies = turbulence::turbulence_field(grmhd::flow_grain_radius((float)r, activity),
                                                     (float)phi, t, (float)p.a,
                                                     (float)(p.pixel_footprint / r));
    return turbulence::turbulent_heating(activity, eddies, (float)p.disk_noise);
}

// The fitted atmosphere on the outside of the settled body emits and
// transmits through the same gray optical depth (formal slab solution).
__device__ __forceinline__ void add_photosphere(const real* hit, real pt, real pph,
        const DevParams& p, const float* lut, real observer_time, bool outer_layer,
        bool immersed, float3& color, real& trans) {
    const real r = hit[0];
    const auto sh = kerr::disk_shift(r, hit[1], p.a, pt, pph, p.kinematic_doppler,
                                     p.gravitational_redshift);
    if (sh.g > 0) {
        const real mu = outer_layer ? fmin((real)1, fabs(hit[4])/(r*sh.nu_fluid))
                                    : photosphere::emission_cosine(hit, p.a, p.surface, sh.nu_fluid);
        const real depth = outer_layer ? photosphere::photosphereDepth(r, p.disk_in, p.disk_out) : 0;
        const real opacity = outer_layer ? -expm1(-depth/fmax(mu,(real)1e-5)) : (real)1;
        const real nominal = p.disk_h * (1 + p.disk_flare * (r-p.disk_in));
        const real signed_height = r*cos(hit[1])/fmax((real)1e-8, nominal*(real).8);
        const real power = disk_heating(r, hit[2], observer_time + hit[5], p,
                                        (float)fmax((real)-1, fmin((real)1, signed_height)));
        const real temperature = disk_temperature(r,p) * sqrt(sqrt(power));
        const real angular = immersed ? (real)1 : photosphere::photosphereLimb(mu);
        color = color + bb::lookup(lut, (float)(sh.g * temperature)) *
                        (float)(trans * p.disk_bright * angular * opacity);
        trans *= 1 - opacity;
    }
    if (!outer_layer) trans = 0;
}

__device__ __forceinline__ float3 sample_sky(const DevParams& p, float3 D) {
    float3 color = make_float3(0.f, 0.f, 0.f);
    if (p.starmap)
        color = sky::sample_equirect_tex(p.starmap, D) * (float)p.sky_bright;
    const float c = D.x * p.comp_dir[0] + D.y * p.comp_dir[1] + D.z * p.comp_dir[2];
    if (c > p.comp_cos) {
        // Linear limb darkening, u = 0.6, as in the WebGL viewer.
        const float edge = (1.f - c * c) / fmaxf(1e-12f, 1.f - p.comp_cos * p.comp_cos);
        color = color + p.comp_radiance * (0.4f + 0.6f * sqrtf(fmaxf(0.f, 1.f - edge)));
    }
    return color;
}

__device__ __forceinline__ float3 propagation_dir(
        const real y[kerr::STATE_N], real pt, real pph, real a) {
    real dyv[kerr::STATE_N];
    kerr::geodesic_rhs(y, pt, pph, a, dyv);
    real r = y[0], th = y[1], ph = y[2];
    real st = sin(th), ct = cos(th), sp = sin(ph), cp = cos(ph);
    real vr = dyv[0], vth = r * dyv[1], vph = r * st * dyv[2];
    float3 Dr  = make_float3((float)(st * cp), (float)(st * sp), (float)ct);
    float3 Dth = make_float3((float)(ct * cp), (float)(ct * sp), (float)-st);
    float3 Dph = make_float3((float)-sp, (float)cp, 0.f);
    float3 D = Dr * (float)vr + Dth * (float)vth + Dph * (float)vph;
    real dl = sqrt((real)(D.x * D.x + D.y * D.y + D.z * D.z)) + (real)1e-20;
    return D * (float)((real)1.0 / dl);
}

// ============================================================================
// Main render kernel. One thread per pixel; samples are serial within thread.
// ============================================================================
__global__ void render_kernel(DevParams p, const float* lut, uchar3* out,
                              float3* hdr, DevStats* stats, int x0, int y0) {
    const int px = x0 + blockIdx.x * blockDim.x + threadIdx.x;
    const int py = y0 + blockIdx.y * blockDim.y + threadIdx.y;
    const bool active = px < p.width && py < p.height;

    float3 accum = make_float3(0.f, 0.f, 0.f);
    float thread_maxerr = 0.f;
    unsigned thread_forced = 0;
    unsigned thread_rejected = 0;
    unsigned thread_unfinished = 0;
    unsigned thread_finite_sky = 0;

    unsigned pix_seed = 1u;
    if (active) {
        pix_seed = sky::hash_u((px * 1973u + py * 9277u) | 1u);
        const float rot_x = sky::hash_f(pix_seed);
        const float rot_y = sky::hash_f(pix_seed ^ 0x68bc21ebu);
        const float R2_A1 = 0.7548776662466927f;
        const float R2_A2 = 0.5698402909980532f;

        const int shutter_rotation = p.shutter > 0 ? (int)(pix_seed % p.spp) : 0;
        for (int s = 0; s < p.spp; ++s) {
            // Sample the same finite exposure at every pixel. Rotate its
            // temporal strata relative to the spatial low-discrepancy samples.
            real observer_time = p.observer_time;
            if (p.shutter > 0) {
                const unsigned stratum = ((unsigned)s + (unsigned)shutter_rotation) % p.spp;
                observer_time += p.shutter * (((real)stratum + (real)0.5) / p.spp - (real)0.5);
            }
            real jx = 0.0, jy = 0.0;
            if (p.spp > 1) {
                float fx = R2_A1 * (s + 1) + rot_x;
                float fy = R2_A2 * (s + 1) + rot_y;
                fx -= floorf(fx);
                fy -= floorf(fy);
                jx = (real)fx - (real)0.5;
                jy = (real)fy - (real)0.5;
            }

            real ndcx = ((real)2.0 * (px + (real)0.5 + jx) / p.width - (real)1.0) *
                        p.tan_half_fov;
            real ndcy = ((real)1.0 - (real)2.0 * (py + (real)0.5 + jy) / p.height) *
                        (p.tan_half_fov / p.aspect);

            real dx = p.fwd[0] + ndcx * p.right[0] + ndcy * p.up[0];
            real dy = p.fwd[1] + ndcx * p.right[1] + ndcy * p.up[1];
            real dz = p.fwd[2] + ndcx * p.right[2] + ndcy * p.up[2];
            real inv = (real)1.0 / sqrt(dx * dx + dy * dy + dz * dz);
            real n_r = dx * inv, n_th = dy * inv, n_ph = dz * inv;

            real pt, pph, pr, pth;
            kerr::init_photon(p.cam_r, p.cam_th, p.a,
                              n_r, n_th, n_ph, pt, pph, pr, pth, -1);

            real y[kerr::STATE_N] = {p.cam_r, p.cam_th, p.cam_ph, pr, pth, 0.0};
            const real Q = kerr::carter_constant(y, pt, pph, p.a);
            const real L_minus_aE = pph + p.a * pt;
            const real radial_K = Q + L_minus_aE * L_minus_aE;
            real sky_start = p.sky_visible
                ? kerr::sky_tail_radius(p.a, pt, pph, Q, p.disk_enabled ? p.disk_out : 0)
                : (real)INFINITY;
            real h = fmin((real)0.25, p.max_step);
            float3 color = make_float3(0.f, 0.f, 0.f);
            real trans = 1.0;
            bool done = (!p.sky_visible && !p.disk_enabled) ||
                        (y[0] <= p.r_capture && y[3] < 0);

            for (int it = 0; it < p.max_iter && !done; ++it) {
                if (!p.sky_visible && y[0] > p.disk_out &&
                    kerr::escapes_outward(y[0], y[3], pt, pph, p.a, radial_K)) {
                    done = true;
                    break;
                }

                if (y[0] >= sky_start &&
                    kerr::escapes_outward(y[0], y[3], pt, pph, p.a, radial_K)) {
                    vec3 direction;
                    if (kerr::celestial_direction(y, pt, pph, p.a, radial_K,
                                                  p.atol + p.rtol, direction)) {
                        const float3 D = make_float3((float)direction.x, (float)direction.y,
                                                     (float)direction.z);
                        color = color + sample_sky(p, D) * (float)trans;
                        done = true;
                        break;
                    }
                    // Continue with the affine solver if the compact arc cannot
                    // satisfy the chosen tolerance at this precision.
                    sky_start = (real)INFINITY;
                }
                real yn[kerr::STATE_N];
                real err = 0.0;
                bool accepted = false;

                for (int tries = 0; tries < 16; ++tries) {
                    err = kerr::rkck_step(y, pt, pph, p.a, h,
                                          p.atol, p.rtol, yn);
                    if (err <= (real)1.0) {
                        accepted = true;
                        break;
                    }

                    ++thread_rejected;
                    if (h <= p.min_step * (real)1.000001) {
                        if (isfinite(err)) {
                            ++thread_forced;
                            accepted = true;
                        }
                        break;
                    }

                    real shrink = (real)0.9 *
                        pow((real)1.0 / fmax(err, (real)1e-30), (real)0.25);
                    shrink = fmax((real)0.1, fmin((real)0.5, shrink));
                    h = fmax(p.min_step, h * shrink);
                }

                if (!accepted) {
                    // No valid state exists at the current step size.
                    // Stop at the last good transfer sample.
                    break;
                }

                const real h_used = h;
                thread_maxerr = fmaxf(thread_maxerr, (float)err);

                const real r_old = y[0], th_old = y[1];
                const real r_new = yn[0], th_new = yn[1];

                if (p.disk_enabled && p.disk_vol) {
                    const auto column = diskcolumn::sample(r_old, th_old, r_new, th_new, p.disk_in,
                                                          p.disk_out, p.disk_h, p.disk_flare);
                    const real f = column.fraction;
                    const real rm = r_old + f * (r_new - r_old);
                    const real thm = th_old + f * (th_new - th_old);
                    const real phm = y[2] + f * (yn[2] - y[2]);
                    const real tm = observer_time + y[5] + f * (yn[5] - y[5]);
                    if (column.density > (real)1e-8) {
                        const real H = p.disk_h * (1 + p.disk_flare * (rm - p.disk_in));
                        const float height = (float)(rm * cos(thm) / H);
                        const real matter_time = tm;
                        const float heating = disk_heating(rm, phm, matter_time, p,
                                                           fmaxf(-1.f, fminf(1.f, height)));
                        const auto material = diskmaterial::volume(heating);
                        const real dens = column.density * material.weight *
                            diskmaterial::taper(rm, p.disk_in, p.disk_out) * sqrt(p.disk_in / rm);
                        const kerr::ShiftInfo sh = kerr::disk_shift(
                            rm, thm, p.a, pt, pph,
                            p.kinematic_doppler, p.gravitational_redshift);

                        if (sh.g > 0.0 && sh.nu_fluid > 0.0) {
                            // Covariant optical-depth path factor.  With camera
                            // photon energy normalized to one, the fluid-frame
                            // distance per affine parameter is proportional to
                            // -k_mu u^mu = nu_fluid.
                            const real fluid_path = sh.nu_fluid * fabs(h_used);
                            if (fluid_path > 0.0) {
                                const real T_loc = disk_temperature(rm, p) * material.temperature_scale;
                                const real T_obs = sh.g * T_loc;
                                float3 radiance = bb::lookup(lut, (float)T_obs);

                                const real VOL_SCALE = (real)0.45;
                                real emis = VOL_SCALE * p.disk_bright * dens;
                                real alpha = p.disk_absorb * dens;
                                real seg_t = exp(-alpha * fluid_path);

                                // Correct formal-solution limit as alpha -> 0:
                                // (1-exp(-alpha*L))/alpha -> L.
                                real emit_path = alpha > (real)1e-8
                                    ? -expm1(-alpha * fluid_path) / alpha
                                    : fluid_path;
                                real wgt = trans * emis * emit_path;
                                color = color + radiance * (float)wgt;
                                trans *= seg_t;
                                if (trans < (real)0.0001) {
                                    done = true;
                                    break;
                                }
                            }
                        }
                    }
                } else if (p.disk_enabled && p.disk_photosphere) {
                    real core[kerr::STATE_N], layer[kerr::STATE_N];
                    const bool hit_core = photosphere::first_hit(p.surface, y, yn, pt, pph, p.a,
                                                               h_used, p.atol, p.rtol, core);
                    const real core_edge = photosphere::photosphereCoreEdge(p.disk_in, p.disk_out);
                    if (fmax(r_old,r_new)+h_used > core_edge && fmin(r_old,r_new)-h_used < p.disk_out &&
                        cos(th_old)*cos(th_new) < 0) {
                        kerr::equatorial_crossing(y, yn, pt, pph, p.a, h_used, p.atol, p.rtol, layer);
                        if (layer[0] > core_edge && layer[0] < p.disk_out &&
                            (!hit_core || layer[5] > core[5])) {
                            add_photosphere(layer, pt, pph, p, lut, observer_time, true, false, color, trans);
                        }
                    }
                    if (hit_core) {
                        const bool immersed = it == 0 && p.surface.field(y[0], cos(y[1])) < 0;
                        add_photosphere(core, pt, pph, p, lut, observer_time, false, immersed, color, trans);
                    }
                    if (trans < 1e-4) {
                        done = true;
                        break;
                    }
                } else if (p.disk_enabled) {
                    const real c_old = cos(th_old), c_new = cos(th_new);
                    if (c_old * c_new < 0.0) {
                        real hit[kerr::STATE_N];
                        kerr::equatorial_crossing(y, yn, pt, pph, p.a, h_used,
                                                  p.atol, p.rtol, hit);
                        const real r_hit = hit[0];
                        if (r_hit >= p.disk_in && r_hit <= p.disk_out) {
                            const kerr::ShiftInfo sh = kerr::disk_shift(
                                r_hit, (real)(M_PI * 0.5), p.a, pt, pph,
                                p.kinematic_doppler, p.gravitational_redshift);
                            if (sh.g > 0.0) {
                                const float heating = disk_heating(r_hit, hit[2], observer_time + hit[5], p);
                                const auto material = diskmaterial::surface((float)p.disk_noise, heating,
                                    diskmaterial::taper(r_hit, p.disk_in, p.disk_out));
                                const real T_loc = disk_temperature(r_hit, p) * material.temperature_scale;
                                const float3 radiance = bb::lookup(lut, (float)(sh.g * T_loc));
                                color = color + radiance * (float)(trans * material.weight * p.disk_bright);
                                trans *= (real)1 - material.weight;
                                if (trans < (real)0.0001) {
                                    done = true;
                                    break;
                                }
                            }
                        }
                    }
                }

                real eddy_step_cap = p.max_step;
                if (p.disk_enabled && p.disk_vol && p.disk_noise > 0 &&
                    r_new >= p.disk_in && r_new <= p.disk_out) {
                    const real H = p.disk_h * (1 + p.disk_flare * (r_new - p.disk_in));
                    const real height = r_new * cos(th_new);
                    const real dz = height - r_old * cos(th_old);
                    if (fabs(height) < 5 * H) {
                        // Resolve the finest visible eddies along a volume ray,
                        // using its radial and comoving azimuthal displacement.
                        const real omega = p.disk_advect ? 1 / (r_new * sqrt(r_new) + p.a) : 0;
                        const real dphase = (yn[2] - y[2]) - omega * (yn[5] - y[5]);
                        // An octave has kappa radial cells per unit ln r and
                        // TURB_M0/TURB_KAPPA0 times as many around an orbit.
                        // Take four transfer samples per cell.
                        const real kappa = turbulence::finest_kappa((float)(p.pixel_footprint / r_new));
                        const real plane_stride = fmax(fabs(r_new - r_old) * 4 * kappa / r_new,
                                                       fabs(dphase) * 4 * (TURB_M0 / TURB_KAPPA0) * kappa / (2 * M_PI));
                        const real stride = fmax(plane_stride, fabs(dz) / ((real)0.3 * H));
                        if (stride > (real)1e-8) eddy_step_cap = h_used / stride;
                    } else if (height * dz < 0) {
                        // Do not jump across the entire vertically stratified layer.
                        eddy_step_cap = h_used * (fabs(height) - 4 * H) / fabs(dz);
                    }
                }
                for (int i = 0; i < kerr::STATE_N; ++i) y[i] = yn[i];

                if (y[0] <= p.r_capture && y[3] < 0) {
                    done = true;
                    break;
                }

                if (y[0] > p.r_escape) {
                    if (p.sky_visible) {
                        ++thread_finite_sky;
                        float3 D = propagation_dir(y, pt, pph, p.a);
                        color = color + sample_sky(p, D) * (float)trans;
                    }
                    done = true;
                    break;
                }

                real grow = (real)0.9 *
                    pow((real)1.0 / fmax(err, (real)1e-30), (real)0.2);
                grow = fmin((real)5.0, fmax((real)0.2, grow));

                real hcap = (real)0.35 * y[0];
                if (p.disk_enabled && y[0] < p.disk_out * (real)1.3) {
                    const real zabs = fabs(y[0] * cos(y[1]));
                    const real Hloc = p.disk_h *
                        ((real)1.0 + p.disk_flare *
                         fmax((real)0.0, y[0] - p.disk_in));
                    hcap = fmin(hcap,
                        (zabs < (real)4.0 * Hloc && p.disk_vol)
                            ? (real)0.10 : (real)0.25);
                }

                hcap = fmin(hcap, eddy_step_cap);
                real proposed = fmin(p.max_step, h * grow);
                proposed = fmin(proposed, hcap);
                // If geometry requires a step below min_step, allow it.  The
                // minimum is a rejection floor, not permission to overshoot.
                h = (hcap < p.min_step)
                    ? hcap
                    : fmax(p.min_step, proposed);
                if (!(h > 0.0)) {
                    done = true;
                    break;
                }
            }

            if (!done) ++thread_unfinished;
            accum = accum + color;
        }

        float3 c = accum * (1.0f / p.spp);
        c = c * (float)p.exposure;
        if (hdr) hdr[py * p.width + px] = c;
        if (out) out[py * p.width + px] = camera_optics::encode_pixel(aces_tonemap(c), pix_seed);
    }

    // Warp-level reduction cuts global diagnostic atomics by ~32x without a
    // block-wide synchronization, so partial image-edge warps remain safe.
    for (int offset = 16; offset > 0; offset >>= 1) {
        thread_maxerr = fmaxf(thread_maxerr,
            __shfl_down_sync(0xffffffffu, thread_maxerr, offset));
        thread_forced += __shfl_down_sync(0xffffffffu, thread_forced, offset);
        thread_rejected += __shfl_down_sync(0xffffffffu, thread_rejected, offset);
        thread_unfinished += __shfl_down_sync(0xffffffffu, thread_unfinished, offset);
        thread_finite_sky += __shfl_down_sync(0xffffffffu, thread_finite_sky, offset);
    }
    const int linear_tid = threadIdx.y * blockDim.x + threadIdx.x;
    if ((linear_tid & 31) == 0 && stats) {
        atomicMax(&stats->maxerr_bits, __float_as_int(thread_maxerr));
        if (thread_forced)
            atomicAdd(&stats->forced_accepts, (unsigned long long)thread_forced);
        if (thread_finite_sky)
            atomicAdd(&stats->finite_sky_samples, (unsigned long long)thread_finite_sky);
        if (thread_unfinished)
            atomicAdd(&stats->unfinished_rays, (unsigned long long)thread_unfinished);
        if (thread_rejected)
            atomicAdd(&stats->rejected_steps, (unsigned long long)thread_rejected);
    }
}

// ============================================================================
// Host-side helpers.
// ============================================================================
static void ck(cudaError_t e, const char* what) {
    if (e != cudaSuccess) {
        std::fprintf(stderr, "CUDA error (%s): %s\n", what, cudaGetErrorString(e));
        std::exit(1);
    }
}

// Give the display driver scheduling boundaries during large captures. Every
// sample still uses its absolute pixel coordinates and writes the full image.
static void trace_frame(const DevParams& p, const float* lut, uchar3* out,
                        float3* hdr, DevStats* stats) {
    const dim3 block(8, 16);
    const int blocks_x = (p.width - 1) / (int)block.x + 1;
    const int blocks_y = (p.height - 1) / (int)block.y + 1;
    constexpr int ray_budget = 1024 * 1024;
    const int tile_blocks = std::max(1, ray_budget / p.spp / (int)(block.x * block.y));
    const int tile_x = std::min(blocks_x, tile_blocks);
    const int tile_y = std::min(blocks_y, tile_blocks / tile_x);
    for (int by = 0; by < blocks_y; by += tile_y) {
        for (int bx = 0; bx < blocks_x; bx += tile_x) {
            const dim3 grid(std::min(tile_x, blocks_x - bx), std::min(tile_y, blocks_y - by));
            render_kernel<<<grid, block>>>(p, lut, out, hdr, stats, bx * block.x, by * block.y);
            ck(cudaGetLastError(), "launch geodesics");
        }
    }
}

template <class T>
struct DevBuf {
    T* p = nullptr;
    DevBuf() = default;
    explicit DevBuf(size_t n) {
        if (n) ck(cudaMalloc(&p, n * sizeof(T)), "cudaMalloc");
    }
    ~DevBuf() { if (p) cudaFree(p); }
    DevBuf(const DevBuf&) = delete;
    DevBuf& operator=(const DevBuf&) = delete;
    DevBuf(DevBuf&& o) noexcept : p(o.p) { o.p = nullptr; }
    DevBuf& operator=(DevBuf&& o) noexcept {
        if (this != &o) {
            if (p) cudaFree(p);
            p = o.p;
            o.p = nullptr;
        }
        return *this;
    }
    T* get() const { return p; }
};

// Three sampled wings approximate the narrow core and long tail of a lens
// point-spread function. Each band is filtered before the next reduction.
struct FilmPass {
    struct Band {
        int bin = 1, stride = 1, width = 0, height = 0;
        float spacing = 0;
        DevBuf<float3> field;
        camera_optics::Wing wing() const { return {field.get(), width, height, 1.f / stride}; }
    };
    int w, h;
    Band bands[3];
    DevBuf<float3> scratch;

    FilmPass(int width, int height, bool enabled) : w(width), h(height) {
        if (!enabled) return;
        constexpr float radii[] = {.004f, .023f, .096f};
        int stride = 1, width_in = w, height_in = h;
        float previous_sigma = 0;
        for (int i = 0; i < 3; ++i) {
            Band& band = bands[i];
            const float sigma = radii[i] * std::min(w, h);
            // Keep at least 1.25 samples per standard deviation on the grid.
            while (band.bin < 8 && 2.5f * band.bin * stride <= sigma) band.bin *= 2;
            band.stride = stride * band.bin;
            band.width = (width_in + band.bin - 1) / band.bin;
            band.height = (height_in + band.bin - 1) / band.bin;
            band.field = DevBuf<float3>((size_t)band.width * band.height);
            const float bin_variance = (band.stride * band.stride - stride * stride) / 12.f;
            const float variance = std::max(0.f, sigma * sigma - previous_sigma * previous_sigma - bin_variance);
            band.spacing = std::sqrt(.5f * variance) / band.stride;
            stride = band.stride;
            width_in = band.width;
            height_in = band.height;
            previous_sigma = sigma;
        }
        scratch = DevBuf<float3>((size_t)bands[0].width * bands[0].height);
    }

    void run(const float3* hdr, uchar3* out) {
        const dim3 block(16, 16);
        const float3* source = hdr;
        int width_in = w, height_in = h;
        for (const Band& band : bands) {
            const int bw = band.width, bh = band.height;
            const dim3 grid((bw + 15) / 16, (bh + 15) / 16);
            camera_optics::collect<<<grid, block>>>(source, width_in, height_in, band.field.get(), bw, bh, band.bin);
            ck(cudaGetLastError(), "film radiance reduction");
            camera_optics::blur<<<grid, block>>>(band.field.get(), bw, bh, scratch.get(), band.spacing, true);
            ck(cudaGetLastError(), "horizontal film diffusion");
            camera_optics::blur<<<grid, block>>>(scratch.get(), bw, bh, band.field.get(), band.spacing, false);
            ck(cudaGetLastError(), "vertical film diffusion");
            source = band.field.get();
            width_in = bw;
            height_in = bh;
        }
        const dim3 full_grid((w + 15) / 16, (h + 15) / 16);
        camera_optics::display<<<full_grid, block>>>(hdr, w, h, bands[0].wing(), bands[1].wing(), bands[2].wing(), out);
        ck(cudaGetLastError(), "film display response");
    }
};

struct FlowTexture {
    cudaArray_t array = nullptr;
    cudaTextureObject_t texture = 0;

    explicit FlowTexture(bool enabled) {
        if (!enabled) return;
        auto extent = make_cudaExtent(grmhd::azimuths, grmhd::radii, grmhd::frames);
        auto channel = cudaCreateChannelDesc<uchar2>();
        ck(cudaMalloc3DArray(&array, &channel, extent), "allocate GRMHD movie");
        cudaMemcpy3DParms copy{};
        copy.srcPtr = make_cudaPitchedPtr(const_cast<unsigned char*>(grmhd::atlas),
            2 * grmhd::azimuths, 2 * grmhd::azimuths, grmhd::radii);
        copy.dstArray = array;
        copy.extent = extent;
        copy.kind = cudaMemcpyHostToDevice;
        ck(cudaMemcpy3D(&copy), "copy GRMHD movie");

        cudaResourceDesc resource{};
        resource.resType = cudaResourceTypeArray;
        resource.res.array.array = array;
        cudaTextureDesc sampler{};
        sampler.addressMode[0] = cudaAddressModeWrap;
        sampler.addressMode[1] = sampler.addressMode[2] = cudaAddressModeClamp;
        sampler.filterMode = cudaFilterModeLinear;
        sampler.readMode = cudaReadModeNormalizedFloat;
        sampler.normalizedCoords = 1;
        ck(cudaCreateTextureObject(&texture, &resource, &sampler, nullptr), "create GRMHD sampler");
    }
    ~FlowTexture() {
        if (texture) cudaDestroyTextureObject(texture);
        if (array) cudaFreeArray(array);
    }
    FlowTexture(const FlowTexture&) = delete;
    FlowTexture& operator=(const FlowTexture&) = delete;
};

struct SkyTexture {
    cudaTextureObject_t tex = 0;
    cudaArray_t arr = nullptr;
    int w = 0, h = 0;

    SkyTexture() = default;
    explicit SkyTexture(const StarMap& sky) {
        if (!sky.valid()) return;
        w = sky.w;
        h = sky.h;
        cudaChannelFormatDesc ch = cudaCreateChannelDesc<float4>();
        ck(cudaMallocArray(&arr, &ch, w, h), "malloc sky array");
        ck(cudaMemcpy2DToArray(arr, 0, 0, sky.rgba.data(),
                               (size_t)w * sizeof(float4),
                               (size_t)w * sizeof(float4), h,
                               cudaMemcpyHostToDevice), "copy sky array");

        cudaResourceDesc rd{};
        rd.resType = cudaResourceTypeArray;
        rd.res.array.array = arr;
        cudaTextureDesc td{};
        td.addressMode[0] = cudaAddressModeWrap;
        td.addressMode[1] = cudaAddressModeClamp;
        td.filterMode = cudaFilterModeLinear;
        td.readMode = cudaReadModeElementType;
        td.normalizedCoords = 1;
        ck(cudaCreateTextureObject(&tex, &rd, &td, nullptr), "create sky tex");
    }
    ~SkyTexture() {
        if (tex) cudaDestroyTextureObject(tex);
        if (arr) cudaFreeArray(arr);
    }
    SkyTexture(const SkyTexture&) = delete;
    SkyTexture& operator=(const SkyTexture&) = delete;
    bool valid() const { return tex != 0; }
};

static DevParams build_params(const RenderConfig& cfg) {
    DevParams p{};
    p.width = cfg.width;
    p.height = cfg.height;
    p.spp = cfg.spp;
    p.a = cfg.spin;
    p.observer_time = cfg.observer_time;
    p.shutter = cfg.shutter;
    p.cam_r = cfg.cam_r;
    p.cam_th = cfg.cam_theta * M_PI / 180.0;
    p.cam_ph = cfg.cam_phi * M_PI / 180.0;
    p.tan_half_fov = tan(cfg.fov * M_PI / 180.0 * 0.5);
    p.aspect = (double)cfg.width / (double)cfg.height;
    p.pixel_footprint = 2.0 * p.tan_half_fov * cfg.cam_r / cfg.width;

    const double yaw = cfg.yaw * M_PI / 180.0;
    const double pitch = cfg.pitch * M_PI / 180.0;
    double f[3] = {-cos(pitch) * cos(yaw), -sin(pitch),
                   cos(pitch) * sin(yaw)};
    double uph[3] = {0.0, -1.0, 0.0};
    double rgt[3] = {
        f[1] * uph[2] - f[2] * uph[1],
        f[2] * uph[0] - f[0] * uph[2],
        f[0] * uph[1] - f[1] * uph[0]
    };
    double rl = sqrt(rgt[0] * rgt[0] + rgt[1] * rgt[1] + rgt[2] * rgt[2]);
    if (rl < 1e-12) {
        // Looking almost exactly along the nominal north/south up hint.
        // Switch to a radial hint so the camera basis remains well-defined.
        uph[0] = 1.0; uph[1] = 0.0; uph[2] = 0.0;
        rgt[0] = f[1] * uph[2] - f[2] * uph[1];
        rgt[1] = f[2] * uph[0] - f[0] * uph[2];
        rgt[2] = f[0] * uph[1] - f[1] * uph[0];
        rl = sqrt(rgt[0] * rgt[0] + rgt[1] * rgt[1] + rgt[2] * rgt[2]);
    }
    for (int i = 0; i < 3; ++i) rgt[i] /= rl;
    double up[3] = {
        rgt[1] * f[2] - rgt[2] * f[1],
        rgt[2] * f[0] - rgt[0] * f[2],
        rgt[0] * f[1] - rgt[1] * f[0]
    };
    const double roll = std::remainder(cfg.roll, 360.0) * M_PI / 180.0;
    const double cr = cos(roll), sr = sin(roll);
    for (int i = 0; i < 3; ++i) {
        p.fwd[i] = f[i];
        p.right[i] = cr * rgt[i] + sr * up[i];
        p.up[i] = cr * up[i] - sr * rgt[i];
    }

    p.disk_enabled = cfg.disk_enabled;
    p.kinematic_doppler = cfg.kinematic_doppler;
    p.gravitational_redshift = cfg.gravitational_redshift;
    p.disk_advect = cfg.disk_advect;
    p.disk_model = cfg.disk_model;
    p.disk_in = cfg.disk_inner > 0.0
        ? cfg.disk_inner
        : kerr::isco_prograde((real)cfg.spin);
    p.disk_out = cfg.disk_outer;
    p.disk_temp = cfg.disk_temp;
    p.disk_bright = cfg.disk_brightness;
    p.disk_noise = cfg.disk_noise;
    p.disk_vol = cfg.disk_volumetric;
    p.disk_h = cfg.disk_thickness;
    p.disk_flare = cfg.disk_flare;
    p.disk_absorb = cfg.disk_absorption;
    p.disk_photosphere = cfg.disk_photosphere && !cfg.disk_volumetric;
    const real opening = p.disk_h * fmax((real)1 / p.disk_in,
        ((real)1 + p.disk_flare * (p.disk_out-p.disk_in)) / p.disk_out);
    p.surface = {p.disk_in, p.disk_out, p.disk_h, p.disk_flare,
                 opening / sqrt((real)1 + (real)4*opening*opening)};
    p.sky_bright = cfg.sky_brightness;
    p.comp_cos = 2.f;
    p.comp_radiance = make_float3(0.f, 0.f, 0.f);
    if (cfg.companion) {
        const double th = cfg.companion_theta * M_PI / 180.0, ph = cfg.companion_phi * M_PI / 180.0;
        p.comp_dir[0] = (float)(sin(th) * cos(ph));
        p.comp_dir[1] = (float)(sin(th) * sin(ph));
        p.comp_dir[2] = (float)cos(th);
        p.comp_cos = (float)cos(cfg.companion_radius * M_PI / 180.0);
    }
    p.sky_visible = cfg.starmap != nullptr || cfg.companion;

    p.rtol = cfg.tolerance;
    p.atol = cfg.abs_tolerance;
    p.min_step = cfg.min_step;
    p.max_step = cfg.max_step;
    p.max_iter = cfg.max_iter;
    p.r_capture = kerr::capture_radius(p.a, p.disk_enabled ? p.disk_in : (real)0);
    p.r_escape = fmax((real)(20.0 * cfg.cam_r), (real)1500.0);
    if (p.disk_enabled) p.r_escape = fmax(p.r_escape, p.disk_out * (real)1.1);
    p.exposure = cfg.exposure;
    return p;
}

static void attach_disk_profile(DevParams& p, const RenderConfig& cfg,
                                DiskProfile& profile, DevBuf<float>& d_profile) {
    profile = diskprofile::build(cfg, (double)p.disk_in, (double)p.disk_out);
    if (cfg.disk_model == DISK_MODEL_NOVIKOV_THORNE && profile.valid()) {
        d_profile = DevBuf<float>(profile.flux.size());
        ck(cudaMemcpy(d_profile.get(), profile.flux.data(),
                      profile.flux.size() * sizeof(float), cudaMemcpyHostToDevice),
           "copy Novikov-Thorne profile");
        p.disk_flux = d_profile.get();
        p.disk_flux_n = (int)profile.flux.size();
        p.disk_flux_log_span = (real)profile.log_span;
    } else if (cfg.disk_model == DISK_MODEL_NOVIKOV_THORNE) {
        p.disk_model = DISK_MODEL_LEGACY;
    }
}

static float stats_maxerr(const DevStats& s) {
    float f = 0.0f;
    static_assert(sizeof(f) == sizeof(s.maxerr_bits), "float/int size mismatch");
    std::memcpy(&f, &s.maxerr_bits, sizeof(f));
    return f;
}

// The LUT is normalized at the disk's reference temperature, so a companion
// of the same scale shares the disk's exposure (times the f^4 dilution).
static void attach_companion(DevParams& p, const RenderConfig& cfg, const std::vector<float>& lut) {
    if (!cfg.companion) return;
    const float scale = (float)(cfg.disk_brightness * pow(cfg.disk_color_correction, 4.0));
    p.comp_radiance = bb::lookup(lut.data(), (float)cfg.companion_temp) * scale;
}

std::vector<unsigned char> render_image(const RenderConfig& cfg,
                                        const std::vector<float>& lut,
                                        const StarMap& sky,
                                        std::vector<float>* hdr_out) {
    DevParams p = build_params(cfg);
    attach_companion(p, cfg, lut);
    FlowTexture flow(cfg.disk_noise != 0 && p.disk_enabled);
    p.flow = flow.texture;

    DevBuf<float> d_lut(lut.size());
    ck(cudaMemcpy(d_lut.get(), lut.data(), lut.size() * sizeof(float),
                  cudaMemcpyHostToDevice), "copy lut");

    DiskProfile profile;
    DevBuf<float> d_profile;
    attach_disk_profile(p, cfg, profile, d_profile);

    SkyTexture skytex(sky);
    if (skytex.valid()) {
        p.starmap = skytex.tex;
        p.sm_w = skytex.w;
        p.sm_h = skytex.h;
    }

    const size_t npix = (size_t)cfg.width * cfg.height;
    DevBuf<uchar3> d_out(npix);
    DevBuf<float3> d_hdr((hdr_out || cfg.cinematic) ? npix : 0);
    FilmPass film(cfg.width, cfg.height, cfg.cinematic);
    DevBuf<DevStats> d_stats(1);
    ck(cudaMemset(d_stats.get(), 0, sizeof(DevStats)), "clear stats");

    std::printf("Rendering %dx%d, spp=%d, spin=%.3f, disk[%.3f, %.1f] M, model=%s ...\n",
                cfg.width, cfg.height, cfg.spp, cfg.spin,
                (double)p.disk_in, (double)p.disk_out,
                p.disk_model == DISK_MODEL_NOVIKOV_THORNE ? "NT" : "legacy");

    cudaEvent_t t0, t1;
    cudaEventCreate(&t0);
    cudaEventCreate(&t1);
    cudaEventRecord(t0);
    trace_frame(p, d_lut.get(), cfg.cinematic ? nullptr : d_out.get(), d_hdr.get(), d_stats.get());
    if (cfg.cinematic) film.run(d_hdr.get(), d_out.get());
    ck(cudaDeviceSynchronize(), "sync");
    cudaEventRecord(t1);
    cudaEventSynchronize(t1);

    float ms = 0.0f;
    cudaEventElapsedTime(&ms, t0, t1);

    DevStats h_stats{};
    ck(cudaMemcpy(&h_stats, d_stats.get(), sizeof(DevStats), cudaMemcpyDeviceToHost),
       "copy stats");
    const float h_maxerr = stats_maxerr(h_stats);
    std::printf("GPU render time: %.1f ms (max normalized RK err %.3g, rejected %llu, forced %llu, unfinished %llu, finite-sky fallbacks %llu)\n",
                ms, h_maxerr,
                (unsigned long long)h_stats.rejected_steps,
                (unsigned long long)h_stats.forced_accepts,
                (unsigned long long)h_stats.unfinished_rays,
                (unsigned long long)h_stats.finite_sky_samples);
    if (h_stats.forced_accepts > 0 || h_maxerr > 1.001f)
        std::fprintf(stderr,
            "  warning: one or more rays required forced RK acceptance; consider smaller --min-step or looser tolerances\n");

    std::vector<unsigned char> img(npix * 3);
    static_assert(sizeof(uchar3) == 3);
    ck(cudaMemcpy(img.data(), d_out.get(), img.size(),
                  cudaMemcpyDeviceToHost), "copy out");

    if (hdr_out && d_hdr.get()) {
        static_assert(sizeof(float3) == 3 * sizeof(float));
        hdr_out->resize(npix * 3);
        ck(cudaMemcpy(hdr_out->data(), d_hdr.get(), hdr_out->size() * sizeof(float),
                      cudaMemcpyDeviceToHost), "copy hdr");
    }

    cudaEventDestroy(t0);
    cudaEventDestroy(t1);
    return img;
}

int render_animation(const RenderConfig& base,
                     const std::vector<AnimFrame>& frames,
                     const std::vector<float>& lut,
                     const StarMap& sky) {
    if (frames.empty()) return 0;

    const int W = base.width, H = base.height;
    const size_t npix = (size_t)W * H;

    DevBuf<float> d_lut(lut.size());
    ck(cudaMemcpy(d_lut.get(), lut.data(), lut.size() * sizeof(float),
                  cudaMemcpyHostToDevice), "copy lut");

    DevParams base_params = build_params(base);
    FlowTexture flow(base.disk_noise != 0 && base_params.disk_enabled);
    DiskProfile profile;
    DevBuf<float> d_profile;
    attach_disk_profile(base_params, base, profile, d_profile);

    SkyTexture skytex(sky);
    DevBuf<uchar3> d_out(npix);
    DevBuf<float3> d_hdr(base.cinematic ? npix : 0);
    FilmPass film(W, H, base.cinematic);
    DevBuf<DevStats> d_stats(1);

    std::vector<unsigned char> img(npix * 3);

    std::printf("Animation: %zu frames at %dx%d, spp=%d, spin=%.3f\n",
                frames.size(), W, H, base.spp, base.spin);

    for (size_t fi = 0; fi < frames.size(); ++fi) {
        RenderConfig cfg = base;
        cfg.observer_time += fi * cfg.frame_dt;
        cfg.cam_r = frames[fi].cam_r;
        cfg.cam_theta = frames[fi].cam_theta;
        cfg.cam_phi = frames[fi].cam_phi;

        DevParams p = build_params(cfg);
        attach_companion(p, cfg, lut);
        p.flow = flow.texture;
        p.disk_model = base_params.disk_model;
        p.disk_flux = base_params.disk_flux;
        p.disk_flux_n = base_params.disk_flux_n;
        p.disk_flux_log_span = base_params.disk_flux_log_span;
        if (skytex.valid()) {
            p.starmap = skytex.tex;
            p.sm_w = skytex.w;
            p.sm_h = skytex.h;
        }
        ck(cudaMemset(d_stats.get(), 0, sizeof(DevStats)), "clear stats");

        cudaEvent_t t0, t1;
        cudaEventCreate(&t0);
        cudaEventCreate(&t1);
        cudaEventRecord(t0);
        trace_frame(p, d_lut.get(), cfg.cinematic ? nullptr : d_out.get(), d_hdr.get(), d_stats.get());
        if (cfg.cinematic) film.run(d_hdr.get(), d_out.get());
        ck(cudaDeviceSynchronize(), "sync");
        cudaEventRecord(t1);
        cudaEventSynchronize(t1);

        float ms = 0.0f;
        cudaEventElapsedTime(&ms, t0, t1);
        cudaEventDestroy(t0);
        cudaEventDestroy(t1);

        DevStats h_stats{};
        ck(cudaMemcpy(&h_stats, d_stats.get(), sizeof(DevStats),
                      cudaMemcpyDeviceToHost), "copy stats");
        const float h_maxerr = stats_maxerr(h_stats);

        ck(cudaMemcpy(img.data(), d_out.get(), img.size(),
                      cudaMemcpyDeviceToHost), "copy out");
        if (!png::write(frames[fi].output.c_str(), W, H, img)) {
            std::fprintf(stderr, "Failed to write %s\n", frames[fi].output.c_str());
            return 1;
        }

        std::printf("  frame %3zu/%zu  phi=%6.1f theta=%4.1f r=%4.1f  (%.0f ms, err %.2g, forced %llu, unfinished %llu, finite-sky fallbacks %llu)\n",
                    fi + 1, frames.size(), cfg.cam_phi, cfg.cam_theta, cfg.cam_r,
                    ms, h_maxerr,
                    (unsigned long long)h_stats.forced_accepts,
                    (unsigned long long)h_stats.unfinished_rays,
                    (unsigned long long)h_stats.finite_sky_samples);
        std::fflush(stdout);
    }

    return 0;
}
