#include "render.h"
#include "vec_math.cuh"
#include "spacetime.cuh"
#include "blackbody.cuh"
#include "starfield.cuh"
#include "png_writer.h"

#include <cstdio>
#include <cmath>

// ============================================================================
//  Device parameters (POD, safe to pass to a kernel by value).
// ============================================================================
struct DevParams {
    int    width, height, spp;
    real   a;                 // spin
    real   cam_r, cam_th, cam_ph;
    real   tan_half_fov;      // tan(fov_x / 2)
    real   aspect;            // width / height
    // camera orientation in the ZAMO spatial frame (treated as Cartesian
    // basis e1=r_hat, e2=theta_hat, e3=phi_hat)
    real   fwd[3], right[3], up[3];

    int    disk_enabled, doppler;
    real   disk_in, disk_out, disk_temp, disk_bright, disk_noise;
    // volumetric (thick) disk
    int    disk_vol;
    real   disk_h, disk_flare, disk_absorb;
    real   T_ref;             // temperature normalisation for brightness

    // optional equirect star map, sampled through a hardware texture object
    cudaTextureObject_t starmap;
    int    sm_w, sm_h;
    real   sky_bright;

    real   tol, max_step;
    int    max_iter;
    real   r_horizon, r_escape;
    real   exposure;
};

// ---- Accretion disk: Novikov-Thorne / Shakura-Sunyaev temperature profile ----
__device__ __forceinline__ real disk_temperature(real r, real r_in, real T0) {
    if (r <= r_in) return T0;
    real x = sqrt(r_in / r);
    real f = (r_in / r) * (r_in / r) * (r_in / r) * (1.0 - x); // (r_in/r)^3 (1 - sqrt(r_in/r))
    const real norm = 0.05665; // peak of f  -> keeps peak temperature ~ T0
    real t = f / norm;
    return T0 * pow(fmax(t, 0.0), 0.25);
}

// ---- Redshift factor g = nu_obs / nu_emit at a disk element (r, theta) ----
// The orbiting gas is modelled as moving on prograde circular orbits with the
// equatorial Keplerian angular velocity Omega(r); the emitter 4-velocity is
// normalised with the metric evaluated at the ACTUAL polar angle, so a
// geometrically thick disk gets the correct height-dependent gravitational and
// transverse-Doppler shift rather than an equatorial approximation.
__device__ __forceinline__ real disk_redshift(real r, real th, real a,
                                              real pt, real pph, int doppler) {
    real gtt, gtp, gpp, grr, gthth;
    kerr::covariant_metric(r, th, a, gtt, gtp, gpp, grr, gthth);
    real Omega = doppler ? (1.0 / (r * sqrt(r) + a)) : 0.0; // prograde Keplerian
    real denom = -(gtt + 2.0 * Omega * gtp + Omega * Omega * gpp);
    if (denom <= 0.0) return 0.0;          // inside ergo/photon region: invalid
    real ut = 1.0 / sqrt(denom);
    real e_dot_u = ut * (pt + Omega * pph);
    if (e_dot_u >= 0.0) return 0.0;
    return -1.0 / e_dot_u;                  // camera frame energy normalised to 1
}

// ---- Procedural disk turbulence (filaments / mottling) ----
__device__ __forceinline__ real disk_pattern(real r, real phi) {
    float u = (float)(log(r) * 5.0);
    float v = (float)(phi * 3.0);
    float n = 0.0f, amp = 0.6f, fr = 1.0f;
    for (int o = 0; o < 4; ++o) {
        n += amp * sky::vnoise(u * fr, v * fr + 31.4f);
        amp *= 0.5f; fr *= 2.1f;
    }
    return (real)n; // ~0..1.1
}

// ---- Volumetric disk density at cylindrical (r, z) with azimuth phi ----
// Gaussian vertical profile (scale height flares with radius) times soft
// radial edges and turbulent mottling.  Returns 0..~1.
__device__ __forceinline__ real disk_density(real r, real z, real phi,
                                             const DevParams& p) {
    if (r < p.disk_in || r > p.disk_out) return 0.0;
    real H = p.disk_h * (1.0 + p.disk_flare * (r - p.disk_in));
    real zz = z / H;
    real vert = exp(-0.5 * zz * zz);
    real edge_in  = clampf((float)((r - p.disk_in) / 0.8), 0.f, 1.f);
    real edge_out = clampf((float)((p.disk_out - r) / (0.18 * p.disk_out)), 0.f, 1.f);
    real patt = 1.0 - p.disk_noise + p.disk_noise * disk_pattern(r, phi);
    // mild radial concentration toward the inner disk
    real radial = sqrt(p.disk_in / r);
    return vert * edge_in * edge_out * patt * radial;
}

// ---- Sample the background star map (black if none was supplied) ----
__device__ __forceinline__ float3 sample_sky(const DevParams& p, float3 D) {
    if (p.starmap)
        return sky::sample_equirect_tex(p.starmap, D) * (float)p.sky_bright;
    return make_float3(0.f, 0.f, 0.f);
}

// ---- Cartesian propagation direction at the current geodesic state ----
__device__ __forceinline__ float3 propagation_dir(const real y[5], real pt,
                                                  real pph, real a) {
    real dyv[5];
    kerr::geodesic_rhs(y, pt, pph, a, dyv);
    real r = y[0], th = y[1], ph = y[2];
    real st = sin(th), ct = cos(th), sp = sin(ph), cp = cos(ph);
    real vr = dyv[0], vth = r * dyv[1], vph = r * st * dyv[2];
    float3 Dr  = make_float3(st*cp, st*sp, ct);
    float3 Dth = make_float3(ct*cp, ct*sp, -st);
    float3 Dph = make_float3(-sp, cp, 0.f);
    float3 D = Dr*(float)vr + Dth*(float)vth + Dph*(float)vph;
    real dl = sqrt((real)(D.x*D.x + D.y*D.y + D.z*D.z)) + 1e-20;
    return D * (float)(1.0/dl);
}

// ============================================================================
//  Main render kernel.  One thread per pixel; loops over sub-samples.
// ============================================================================
__global__ void render_kernel(DevParams p, const float* lut, uchar3* out,
                              float3* hdr, float* maxerr) {
    int px = blockIdx.x * blockDim.x + threadIdx.x;
    int py = blockIdx.y * blockDim.y + threadIdx.y;
    if (px >= p.width || py >= p.height) return;

    float3 accum = make_float3(0, 0, 0);
    float  thread_maxerr = 0.f;       // worst accepted-step error for this pixel

    // Per-pixel Cranley-Patterson rotation of a low-discrepancy (R2) sequence:
    // gives well-stratified, decorrelated jitter at any sample count.
    unsigned pix_seed = sky::hash_u((px * 1973u + py * 9277u) | 1u);
    float rot_x = sky::hash_f(pix_seed);
    float rot_y = sky::hash_f(pix_seed ^ 0x68bc21ebu);
    const float R2_A1 = 0.7548776662466927f;   // 1/g   (g = plastic constant)
    const float R2_A2 = 0.5698402909980532f;   // 1/g^2

    for (int s = 0; s < p.spp; ++s) {
        // --- Stratified jittered pixel sample (R2 + rotation, wrapped to [-.5,.5)) ---
        real jx = 0.0, jy = 0.0;
        if (p.spp > 1) {
            float fx = R2_A1 * (s + 1) + rot_x; fx -= floorf(fx);
            float fy = R2_A2 * (s + 1) + rot_y; fy -= floorf(fy);
            jx = (real)fx - 0.5; jy = (real)fy - 0.5;
        }
        real ndcx = (2.0 * (px + 0.5 + jx) / p.width  - 1.0) * p.tan_half_fov;
        real ndcy = (1.0 - 2.0 * (py + 0.5 + jy) / p.height) * (p.tan_half_fov / p.aspect);

        // --- Ray direction in the local ZAMO spatial frame ---
        real dx = p.fwd[0] + ndcx * p.right[0] + ndcy * p.up[0];
        real dy = p.fwd[1] + ndcx * p.right[1] + ndcy * p.up[1];
        real dz = p.fwd[2] + ndcx * p.right[2] + ndcy * p.up[2];
        real inv = 1.0 / sqrt(dx*dx + dy*dy + dz*dz);
        real n_r = dx * inv, n_th = dy * inv, n_ph = dz * inv;

        // --- Initial photon momentum ---
        real pt, pph, pr, pth;
        kerr::init_photon(p.cam_r, p.cam_th, p.a, n_r, n_th, n_ph, pt, pph, pr, pth);

        real y[5] = { p.cam_r, p.cam_th, p.cam_ph, pr, pth };
        real h = 0.25;
        float3 color = make_float3(0, 0, 0);  // accumulated emission (front-to-back)
        real   trans = 1.0;                   // remaining transmittance
        bool   done  = false;

        for (int it = 0; it < p.max_iter && !done; ++it) {
            // Adaptive RKF45 step with rejection.
            real yn[5], err;
            for (int tries = 0; tries < 12; ++tries) {
                err = kerr::rkck_step(y, pt, pph, p.a, h, yn);
                if (err < p.tol || h < 1e-6) break;
                h *= fmax(0.2, 0.9 * pow(p.tol / fmax(err, 1e-30), 0.25));
            }
            thread_maxerr = fmaxf(thread_maxerr, (float)err);

            real r_old = y[0], th_old = y[1];
            real r_new = yn[0], th_new = yn[1];

            if (p.disk_enabled && p.disk_vol) {
                // ---- Volumetric emission/absorption over this segment ----
                // Evaluate at the segment midpoint.
                real rm  = 0.5 * (r_old + r_new);
                real thm = 0.5 * (th_old + th_new);
                real phm = 0.5 * (y[2] + yn[2]);
                real zm  = rm * cos(thm);
                real dens = disk_density(rm, zm, phm, p);
                if (dens > 1e-4) {
                    // Proper spatial length of the segment (metric-weighted).
                    real gtt,gtp,gpp,grr,gthth;
                    kerr::covariant_metric(rm, thm, p.a, gtt,gtp,gpp,grr,gthth);
                    real dr = r_new - r_old, dth = th_new - th_old, dph = yn[2]-y[2];
                    real ds = sqrt(fmax(0.0, grr*dr*dr + gthth*dth*dth + gpp*dph*dph));
                    real g = disk_redshift(rm, thm, p.a, pt, pph, p.doppler);
                    if (g > 0.0 && ds > 0.0) {
                        real T_loc = disk_temperature(rm, p.disk_in, p.disk_temp);
                        real T_obs = g * T_loc;
                        float3 chroma = bb::lookup(lut, (float)T_obs);
                        // Beaming + gravitational shift folded into (T_obs/T_ref)^4.
                        // VOL_SCALE normalises path-integrated emission so the
                        // brightness control matches the thin-disk scale.
                        const real VOL_SCALE = 0.45;
                        real tr = T_obs / p.T_ref, tr2 = tr * tr;
                        real emis = VOL_SCALE * p.disk_bright * (tr2 * tr2) * dens;
                        real alpha = p.disk_absorb * dens;        // absorption coeff
                        real seg_t = exp(-alpha * ds);            // segment transmittance
                        // Front-to-back: integrated emission over the segment.
                        real wgt = trans * emis * (1.0 - seg_t) / fmax(alpha, 1e-6);
                        color = color + chroma * (float)wgt;
                        trans *= seg_t;
                        if (trans < 0.01) { done = true; break; } // optically thick
                    }
                }
            } else if (p.disk_enabled) {
                // ---- Thin disk: first equatorial crossing wins ----
                // NOTE: this opaque single-crossing model intentionally shows
                // only the primary image of the disk; the lensed secondary
                // image (the disk's underside arcing over/under the shadow)
                // is produced only by the volumetric path.
                real c_old = cos(th_old), c_new = cos(th_new);
                if (c_old * c_new < 0.0) {
                    real frac = c_old / (c_old - c_new);
                    real r_hit = r_old + frac * (r_new - r_old);
                    if (r_hit >= p.disk_in && r_hit <= p.disk_out) {
                        real ph_hit = y[2] + frac * (yn[2] - y[2]);
                        real g = disk_redshift(r_hit, (real)(M_PI * 0.5), p.a, pt, pph, p.doppler);
                        if (g > 0.0) {
                            real T_loc = disk_temperature(r_hit, p.disk_in, p.disk_temp);
                            real T_obs = g * T_loc;
                            float3 chroma = bb::lookup(lut, (float)T_obs);
                            real tr = T_obs / p.T_ref, tr2 = tr * tr;
                            real lum = p.disk_bright * (tr2 * tr2);
                            real patt = 1.0 - p.disk_noise + p.disk_noise * disk_pattern(r_hit, ph_hit);
                            real edge_in  = clampf((float)((r_hit - p.disk_in) / (0.6)), 0.f, 1.f);
                            real edge_out = clampf((float)((p.disk_out - r_hit) / (0.18 * p.disk_out)), 0.f, 1.f);
                            lum *= patt * edge_in * edge_out;
                            color = chroma * (float)lum;
                        }
                        trans = 0.0; done = true; break;
                    }
                }
            }

            // Accept step.
            for (int i = 0; i < 5; ++i) y[i] = yn[i];

            // --- Captured by the horizon (remaining transmittance -> black) ---
            if (y[0] < p.r_horizon * 1.0008) { done = true; break; }

            // --- Escaped to infinity: add the lensed star map behind the disk ---
            if (y[0] > p.r_escape) {
                if (p.starmap) {
                    float3 D = propagation_dir(y, pt, pph, p.a);
                    color = color + sample_sky(p, D) * (float)trans;
                }
                done = true; break;
            }

            // --- Step-size control for the next step ---
            real grow = 0.9 * pow(p.tol / fmax(err, 1e-30), 0.2);
            grow = fmin(5.0, fmax(0.2, grow));
            h *= grow;
            real hcap = 0.35 * y[0];
            if (y[0] < p.disk_out * 1.3) {
                // Sample the disk volume finely, especially near the equator.
                real zabs = fabs(y[0] * cos(y[1]));
                real Hloc = p.disk_h * (1.0 + p.disk_flare * fmax(0.0, y[0]-p.disk_in));
                hcap = fmin(hcap, (zabs < 4.0*Hloc && p.disk_vol) ? 0.10 : 0.25);
            }
            h = fmin(h, fmin(p.max_step, hcap));
        }

        accum = accum + color;
    }

    // --- Resolve sub-samples, expose, tonemap, gamma ---
    float3 c = accum * (1.0f / p.spp);
    c = c * (float)p.exposure;
    if (hdr) hdr[py * p.width + px] = c;     // linear HDR radiance (pre-tonemap)
    c = aces_tonemap(c);
    // Per-channel triangular (TPDF) dither, ~+/-1 LSB, from the per-pixel hash:
    // removes 8-bit banding in smooth gradients without adding visible grain.
    float d0 = sky::hash_f(pix_seed ^ 0x9e3779b9u) - sky::hash_f(pix_seed ^ 0x85ebca6bu);
    float d1 = sky::hash_f(pix_seed ^ 0xc2b2ae35u) - sky::hash_f(pix_seed ^ 0x27d4eb2fu);
    float d2 = sky::hash_f(pix_seed ^ 0x165667b1u) - sky::hash_f(pix_seed ^ 0xd3a2646cu);
    out[py * p.width + px] = make_uchar3(
        quantize8(c.x, d0), quantize8(c.y, d1), quantize8(c.z, d2));

    // Report the frame's worst accepted-step error (bit-monotone atomicMax on
    // a non-negative float) so the host can flag potential lensing artefacts.
    if (maxerr)
        atomicMax((int*)maxerr, __float_as_int(thread_maxerr));
}

// ============================================================================
//  Host entry point.
// ============================================================================
static void ck(cudaError_t e, const char* what) {
    if (e != cudaSuccess) {
        fprintf(stderr, "CUDA error (%s): %s\n", what, cudaGetErrorString(e));
        exit(1);
    }
}

// --- RAII device buffer: frees itself, so error paths never leak memory. ---
template <class T>
struct DevBuf {
    T* p = nullptr;
    DevBuf() = default;
    explicit DevBuf(size_t n) { if (n) ck(cudaMalloc(&p, n * sizeof(T)), "cudaMalloc"); }
    ~DevBuf() { if (p) cudaFree(p); }
    DevBuf(const DevBuf&) = delete;
    DevBuf& operator=(const DevBuf&) = delete;
    DevBuf(DevBuf&& o) noexcept : p(o.p) { o.p = nullptr; }
    DevBuf& operator=(DevBuf&& o) noexcept {
        if (this != &o) { if (p) cudaFree(p); p = o.p; o.p = nullptr; }
        return *this;
    }
    T* get() const { return p; }
};

// --- Equirect star map uploaded as a hardware texture (RAII). ---
struct SkyTexture {
    cudaTextureObject_t tex = 0;
    cudaArray_t         arr = nullptr;
    int w = 0, h = 0;

    SkyTexture() = default;
    explicit SkyTexture(const StarMap& sky) {
        if (!sky.valid()) return;
        w = sky.w; h = sky.h;
        // CUDA textures support 1/2/4 channels (not 3): pad RGB -> RGBA.
        std::vector<float4> rgba((size_t)w * h);
        for (size_t i = 0; i < rgba.size(); ++i)
            rgba[i] = make_float4(sky.rgb[i*3+0], sky.rgb[i*3+1], sky.rgb[i*3+2], 1.0f);

        cudaChannelFormatDesc ch = cudaCreateChannelDesc<float4>();
        ck(cudaMallocArray(&arr, &ch, w, h), "malloc sky array");
        ck(cudaMemcpy2DToArray(arr, 0, 0, rgba.data(),
                               (size_t)w * sizeof(float4), (size_t)w * sizeof(float4),
                               h, cudaMemcpyHostToDevice), "copy sky array");

        cudaResourceDesc rd{}; rd.resType = cudaResourceTypeArray; rd.res.array.array = arr;
        cudaTextureDesc td{};
        td.addressMode[0]   = cudaAddressModeWrap;   // longitude wraps
        td.addressMode[1]   = cudaAddressModeClamp;  // latitude clamps at poles
        td.filterMode       = cudaFilterModeLinear;  // hardware bilinear
        td.readMode         = cudaReadModeElementType;
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

// Build the (host-side) device parameter block from a RenderConfig. Device
// pointers (lut/sky/out) are filled in by the caller.
static DevParams build_params(const RenderConfig& cfg) {
    DevParams p{};
    p.width  = cfg.width;  p.height = cfg.height;  p.spp = cfg.spp;
    p.a      = cfg.spin;
    p.cam_r  = cfg.cam_r;
    p.cam_th = cfg.cam_theta * M_PI / 180.0;
    p.cam_ph = cfg.cam_phi   * M_PI / 180.0;
    p.tan_half_fov = tan(cfg.fov * M_PI / 180.0 * 0.5);
    p.aspect = (double)cfg.width / (double)cfg.height;

    // Camera basis in the local Cartesian (r_hat, theta_hat, phi_hat) frame.
    double yaw = cfg.yaw * M_PI / 180.0, pitch = cfg.pitch * M_PI / 180.0;
    double f[3] = { -cos(pitch)*cos(yaw), -sin(pitch), cos(pitch)*sin(yaw) };
    double uph[3] = { 0.0, -1.0, 0.0 }; // up hint = north (decreasing theta)
    double rgt[3] = { f[1]*uph[2]-f[2]*uph[1], f[2]*uph[0]-f[0]*uph[2], f[0]*uph[1]-f[1]*uph[0] };
    double rl = sqrt(rgt[0]*rgt[0]+rgt[1]*rgt[1]+rgt[2]*rgt[2]);
    for (int i=0;i<3;++i) rgt[i]/=rl;
    double up[3] = { rgt[1]*f[2]-rgt[2]*f[1], rgt[2]*f[0]-rgt[0]*f[2], rgt[0]*f[1]-rgt[1]*f[0] };
    for (int i=0;i<3;++i){ p.fwd[i]=f[i]; p.right[i]=rgt[i]; p.up[i]=up[i]; }

    p.disk_enabled = cfg.disk_enabled;
    p.doppler      = cfg.doppler;
    p.disk_in  = (cfg.disk_inner > 0.0) ? cfg.disk_inner : kerr::isco_prograde(cfg.spin);
    p.disk_out = cfg.disk_outer;
    p.disk_temp = cfg.disk_temp;
    p.disk_bright = cfg.disk_brightness;
    p.disk_noise  = cfg.disk_noise;
    p.disk_vol    = cfg.disk_volumetric;
    p.disk_h      = cfg.disk_thickness;
    p.disk_flare  = cfg.disk_flare;
    p.disk_absorb = cfg.disk_absorption;
    p.T_ref       = cfg.disk_temp;
    p.sky_bright  = cfg.sky_brightness;

    p.tol = cfg.tolerance; p.max_step = cfg.max_step; p.max_iter = cfg.max_iter;
    p.r_horizon = 1.0 + sqrt(fmax(0.0, 1.0 - cfg.spin*cfg.spin));
    // Large escape radius so rays straighten out before the background is
    // sampled -> smooth, artefact-free lensing of the stars.
    p.r_escape  = fmax(20.0 * cfg.cam_r, 1500.0);
    p.exposure  = cfg.exposure;
    return p;
}

std::vector<unsigned char> render_image(const RenderConfig& cfg,
                                        const std::vector<float>& lut,
                                        const StarMap& sky,
                                        std::vector<float>* hdr_out) {
    DevParams p = build_params(cfg);

    // Device buffers (RAII: freed automatically, even on the error path).
    DevBuf<float> d_lut(lut.size());
    ck(cudaMemcpy(d_lut.get(), lut.data(), lut.size()*sizeof(float), cudaMemcpyHostToDevice), "copy lut");

    // Optional star map uploaded as a hardware texture.
    SkyTexture skytex(sky);
    if (skytex.valid()) { p.starmap = skytex.tex; p.sm_w = skytex.w; p.sm_h = skytex.h; }

    size_t npix = (size_t)cfg.width * cfg.height;
    DevBuf<uchar3> d_out(npix);
    DevBuf<float3> d_hdr(hdr_out ? npix : 0);
    DevBuf<float>  d_maxerr(1);
    ck(cudaMemset(d_maxerr.get(), 0, sizeof(float)), "clear maxerr");

    dim3 block(16, 16);
    dim3 grid((cfg.width + block.x - 1)/block.x, (cfg.height + block.y - 1)/block.y);

    printf("Rendering %dx%d, spp=%d, spin=%.3f, disk[%.3f, %.1f] M ...\n",
           cfg.width, cfg.height, cfg.spp, cfg.spin, p.disk_in, p.disk_out);

    cudaEvent_t t0, t1; cudaEventCreate(&t0); cudaEventCreate(&t1);
    cudaEventRecord(t0);
    render_kernel<<<grid, block>>>(p, d_lut.get(), d_out.get(), d_hdr.get(), d_maxerr.get());
    ck(cudaGetLastError(), "launch");
    ck(cudaDeviceSynchronize(), "sync");
    cudaEventRecord(t1); cudaEventSynchronize(t1);
    float ms = 0; cudaEventElapsedTime(&ms, t0, t1);
    float h_maxerr = 0.f;
    ck(cudaMemcpy(&h_maxerr, d_maxerr.get(), sizeof(float), cudaMemcpyDeviceToHost), "copy maxerr");
    printf("GPU render time: %.1f ms (worst step error %.2e, tol %.1e)\n",
           ms, h_maxerr, cfg.tolerance);
    if (h_maxerr > cfg.tolerance * 100.0)
        fprintf(stderr, "  warning: worst step error >> tolerance; lensing may show artefacts\n");

    std::vector<unsigned char> img(npix * 3);
    std::vector<uchar3> host(npix);
    ck(cudaMemcpy(host.data(), d_out.get(), npix*sizeof(uchar3), cudaMemcpyDeviceToHost), "copy out");
    for (size_t i = 0; i < npix; ++i) {
        img[i*3+0] = host[i].x; img[i*3+1] = host[i].y; img[i*3+2] = host[i].z;
    }

    if (hdr_out && d_hdr.get()) {
        std::vector<float3> hh(npix);
        ck(cudaMemcpy(hh.data(), d_hdr.get(), npix*sizeof(float3), cudaMemcpyDeviceToHost), "copy hdr");
        hdr_out->resize(npix * 3);
        for (size_t i = 0; i < npix; ++i) {
            (*hdr_out)[i*3+0] = hh[i].x;
            (*hdr_out)[i*3+1] = hh[i].y;
            (*hdr_out)[i*3+2] = hh[i].z;
        }
    }

    cudaEventDestroy(t0); cudaEventDestroy(t1);
    return img;
}

// ============================================================================
//  Animation: render many frames in one process. The blackbody LUT and the
//  star map are uploaded to the GPU ONCE, and the output buffer is reused, so
//  per-frame host overhead (map load, LUT rebuild, allocations) is eliminated.
// ============================================================================
int render_animation(const RenderConfig& base,
                     const std::vector<AnimFrame>& frames,
                     const std::vector<float>& lut,
                     const StarMap& sky) {
    if (frames.empty()) return 0;

    const int W = base.width, H = base.height;
    const size_t npix = (size_t)W * H;

    // Upload LUT once.
    DevBuf<float> d_lut(lut.size());
    ck(cudaMemcpy(d_lut.get(), lut.data(), lut.size()*sizeof(float), cudaMemcpyHostToDevice), "copy lut");

    // Upload star map once (if any) as a hardware texture.
    SkyTexture skytex(sky);

    DevBuf<uchar3> d_out(npix);
    DevBuf<float>  d_maxerr(1);

    dim3 block(16, 16);
    dim3 grid((W + block.x - 1)/block.x, (H + block.y - 1)/block.y);

    std::vector<uchar3> host(npix);
    std::vector<unsigned char> img(npix * 3);

    printf("Animation: %zu frames at %dx%d, spp=%d, spin=%.3f\n",
           frames.size(), W, H, base.spp, base.spin);

    for (size_t fi = 0; fi < frames.size(); ++fi) {
        RenderConfig cfg = base;
        cfg.cam_r     = frames[fi].cam_r;
        cfg.cam_theta = frames[fi].cam_theta;
        cfg.cam_phi   = frames[fi].cam_phi;

        DevParams p = build_params(cfg);
        if (skytex.valid()) { p.starmap = skytex.tex; p.sm_w = skytex.w; p.sm_h = skytex.h; }
        ck(cudaMemset(d_maxerr.get(), 0, sizeof(float)), "clear maxerr");

        cudaEvent_t t0, t1; cudaEventCreate(&t0); cudaEventCreate(&t1);
        cudaEventRecord(t0);
        render_kernel<<<grid, block>>>(p, d_lut.get(), d_out.get(), nullptr, d_maxerr.get());
        ck(cudaGetLastError(), "launch");
        ck(cudaDeviceSynchronize(), "sync");
        cudaEventRecord(t1); cudaEventSynchronize(t1);
        float ms = 0; cudaEventElapsedTime(&ms, t0, t1);
        cudaEventDestroy(t0); cudaEventDestroy(t1);

        float h_maxerr = 0.f;
        ck(cudaMemcpy(&h_maxerr, d_maxerr.get(), sizeof(float), cudaMemcpyDeviceToHost), "copy maxerr");

        ck(cudaMemcpy(host.data(), d_out.get(), npix*sizeof(uchar3), cudaMemcpyDeviceToHost), "copy out");
        for (size_t i = 0; i < npix; ++i) {
            img[i*3+0] = host[i].x; img[i*3+1] = host[i].y; img[i*3+2] = host[i].z;
        }
        if (!png::write(frames[fi].output.c_str(), W, H, img)) {
            fprintf(stderr, "Failed to write %s\n", frames[fi].output.c_str());
            return 1;
        }
        printf("  frame %3zu/%zu  phi=%6.1f  theta=%4.1f  r=%4.1f  (%.0f ms, err %.1e)\n",
               fi + 1, frames.size(), cfg.cam_phi, cfg.cam_theta, cfg.cam_r, ms, h_maxerr);
        fflush(stdout);
    }

    return 0;
}

