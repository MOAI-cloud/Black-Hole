#include "config.h"
#include "render.h"
#include "blackbody.cuh"
#include "png_writer.h"
#include "hdr_writer.h"
#include "star_map.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

static void usage(const char* prog) {
    RenderConfig d;   // authoritative defaults (single source of truth)
    printf(
"Gargantua - physically based Kerr black-hole ray tracer (CUDA)\n\n"
"Usage: %s [options]\n"
"  --width N            image width            (default %d)\n"
"  --height N           image height           (default %d)\n"
"  --spp N              samples per pixel       (default %d)\n"
"  --spin A             Kerr spin a/M in [0,1)  (default %.2g)\n"
"  --cam-r R            camera radius (M)        (default %.4g)\n"
"  --cam-theta DEG      camera polar angle       (default %.4g)\n"
"  --cam-phi DEG        camera azimuth           (default %.4g)\n"
"  --fov DEG            field of view            (default %.4g)\n"
"  --yaw DEG --pitch DEG  aim offsets            (default 0)\n"
"  --disk-in R          inner radius (M, <0=ISCO)(default ISCO)\n"
"  --disk-out R         outer radius (M)         (default %.4g)\n"
"  --disk-temp K        inner temperature (K)    (default %.5g)\n"
"  --disk-bright X      emission scale           (default %.4g)\n"
"  --disk-noise X       turbulence 0..1          (default %.2g)\n"
"  --disk-thick X       vertical scale height (M)(default %.2g)\n"
"  --disk-flare X       scale-height flaring     (default %.2g)\n"
"  --disk-absorb X      disk opacity coefficient (default %.2g)\n"
"  --thin               use a thin (non-volumetric) disk\n"
"  --no-doppler         disable Doppler shift\n"
"  --no-disk            hide the accretion disk\n"
"  --starmap FILE       equirect HDR/PPM star map background\n"
"  --sky-bright X       star-map brightness scale (default %.2g)\n"
"  --exposure X         exposure                 (default %.2g)\n"
"  --tol X              integrator tolerance     (default %.1g)\n"
"  -o FILE              output PNG               (default %s)\n"
"  --hdr FILE           also write a Radiance .hdr (linear HDR)\n"
"\n"
" Animation (renders a smooth orbiting fly-around in ONE process):\n"
"  --frames N           render N frames -> DIR/frame_%%04d.png\n"
"  --anim-dir DIR       output directory          (default frames)\n"
"  --orbit-r0 R         dolly start radius (M)    (default --cam-r)\n"
"  --orbit-r1 R         dolly end radius (M)      (default --cam-r)\n"
"  --orbit-theta-amp D  inclination bob amplitude (default 0)\n"
"  -h, --help           show this help\n",
        prog, d.width, d.height, d.spp, d.spin, d.cam_r, d.cam_theta, d.cam_phi,
        d.fov, d.disk_outer, d.disk_temp, d.disk_brightness, d.disk_noise,
        d.disk_thickness, d.disk_flare, d.disk_absorption, d.sky_brightness,
        d.exposure, d.tolerance, d.output);
}

int main(int argc, char** argv) {
    RenderConfig cfg;

    // Animation parameters (frames > 0 enables animation mode).
    int    anim_frames   = 0;
    std::string anim_dir = "frames";
    double orbit_r0 = -1.0, orbit_r1 = -1.0;   // <0 => use cfg.cam_r
    double orbit_theta_amp = 0.0;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto need = [&](const char* name) -> const char* {
            if (i + 1 >= argc) { fprintf(stderr, "Missing value for %s\n", name); exit(1); }
            return argv[++i];
        };
        if      (a == "--width")      cfg.width  = atoi(need("--width"));
        else if (a == "--height")     cfg.height = atoi(need("--height"));
        else if (a == "--spp")        cfg.spp    = atoi(need("--spp"));
        else if (a == "--spin")       cfg.spin   = atof(need("--spin"));
        else if (a == "--cam-r")      cfg.cam_r  = atof(need("--cam-r"));
        else if (a == "--cam-theta")  cfg.cam_theta = atof(need("--cam-theta"));
        else if (a == "--cam-phi")    cfg.cam_phi = atof(need("--cam-phi"));
        else if (a == "--fov")        cfg.fov    = atof(need("--fov"));
        else if (a == "--yaw")        cfg.yaw    = atof(need("--yaw"));
        else if (a == "--pitch")      cfg.pitch  = atof(need("--pitch"));
        else if (a == "--disk-in")    cfg.disk_inner = atof(need("--disk-in"));
        else if (a == "--disk-out")   cfg.disk_outer = atof(need("--disk-out"));
        else if (a == "--disk-temp")  cfg.disk_temp  = atof(need("--disk-temp"));
        else if (a == "--disk-bright")cfg.disk_brightness = atof(need("--disk-bright"));
        else if (a == "--disk-noise") cfg.disk_noise = atof(need("--disk-noise"));
        else if (a == "--disk-thick") cfg.disk_thickness = atof(need("--disk-thick"));
        else if (a == "--disk-flare") cfg.disk_flare = atof(need("--disk-flare"));
        else if (a == "--disk-absorb")cfg.disk_absorption = atof(need("--disk-absorb"));
        else if (a == "--thin")       cfg.disk_volumetric = 0;
        else if (a == "--no-doppler") cfg.doppler = 0;
        else if (a == "--no-disk")    cfg.disk_enabled = 0;
        else if (a == "--starmap")    cfg.starmap = need("--starmap");
        else if (a == "--sky-bright") cfg.sky_brightness = atof(need("--sky-bright"));
        else if (a == "--exposure")   cfg.exposure = atof(need("--exposure"));
        else if (a == "--tol")        cfg.tolerance = atof(need("--tol"));
        else if (a == "-o")           cfg.output = need("-o");
        else if (a == "--hdr")        cfg.hdr_output = need("--hdr");
        else if (a == "--frames")     anim_frames = atoi(need("--frames"));
        else if (a == "--anim-dir")   anim_dir = need("--anim-dir");
        else if (a == "--orbit-r0")   orbit_r0 = atof(need("--orbit-r0"));
        else if (a == "--orbit-r1")   orbit_r1 = atof(need("--orbit-r1"));
        else if (a == "--orbit-theta-amp") orbit_theta_amp = atof(need("--orbit-theta-amp"));
        else if (a == "-h" || a == "--help") { usage(argv[0]); return 0; }
        else { fprintf(stderr, "Unknown option: %s\n", a.c_str()); usage(argv[0]); return 1; }
    }

    if (cfg.spin < 0.0 || cfg.spin >= 1.0) {
        fprintf(stderr, "Spin must be in [0, 1). Got %f\n", cfg.spin); return 1;
    }
    if (cfg.width < 1 || cfg.height < 1) {
        fprintf(stderr, "Image dimensions must be positive. Got %dx%d\n",
                cfg.width, cfg.height); return 1;
    }
    if (cfg.spp < 1) {
        fprintf(stderr, "Samples per pixel must be >= 1. Got %d\n", cfg.spp); return 1;
    }
    if (cfg.fov <= 0.0 || cfg.fov >= 180.0) {
        fprintf(stderr, "Field of view must be in (0, 180). Got %f\n", cfg.fov); return 1;
    }
    if (cfg.cam_r <= cfg.spin /*>= horizon for a<1*/ || cfg.cam_r <= 1.0) {
        fprintf(stderr, "Camera radius must be outside the horizon. Got %f\n",
                cfg.cam_r); return 1;
    }
    if (cfg.tolerance <= 0.0) {
        fprintf(stderr, "Integrator tolerance must be positive. Got %g\n",
                cfg.tolerance); return 1;
    }
    if (anim_frames < 0) {
        fprintf(stderr, "Frame count must be >= 0. Got %d\n", anim_frames); return 1;
    }

    printf("Building blackbody colour LUT...\n");
    std::vector<float> lut = bb::build_lut();

    StarMap sky;
    if (cfg.starmap) {
        sky = starmap::load(cfg.starmap);
    }

    // --- Animation mode: render a smooth orbiting fly-around in one process. ---
    if (anim_frames > 0) {
        const double r0 = (orbit_r0 > 0.0) ? orbit_r0 : cfg.cam_r;
        const double r1 = (orbit_r1 > 0.0) ? orbit_r1 : cfg.cam_r;
        const double th_mid = cfg.cam_theta;

        std::vector<AnimFrame> frames;
        frames.reserve(anim_frames);
        for (int i = 0; i < anim_frames; ++i) {
            double t = (double)i / (double)anim_frames;          // 0..1, loops cleanly
            double phi = 360.0 * t;                              // full azimuth sweep
            double ease = 0.5 - 0.5 * cos(M_PI * t);             // ease in/out dolly
            double camr = r0 + (r1 - r0) * ease;
            double theta = th_mid + orbit_theta_amp * sin(2.0 * M_PI * t);

            char name[512];
            snprintf(name, sizeof(name), "%s/frame_%04d.png", anim_dir.c_str(), i);
            frames.push_back({ camr, theta, phi, std::string(name) });
        }

        int rc = render_animation(cfg, frames, lut, sky);
        if (rc == 0)
            printf("Wrote %d frames to %s/\n", anim_frames, anim_dir.c_str());
        return rc;
    }

    std::vector<float> hdrbuf;
    std::vector<unsigned char> img =
        render_image(cfg, lut, sky, cfg.hdr_output ? &hdrbuf : nullptr);

    if (!png::write(cfg.output, cfg.width, cfg.height, img)) {
        fprintf(stderr, "Failed to write %s\n", cfg.output);
        return 1;
    }
    printf("Wrote %s (%dx%d)\n", cfg.output, cfg.width, cfg.height);

    if (cfg.hdr_output) {
        if (!hdr::write(cfg.hdr_output, cfg.width, cfg.height, hdrbuf)) {
            fprintf(stderr, "Failed to write %s\n", cfg.hdr_output);
            return 1;
        }
        printf("Wrote %s (linear HDR)\n", cfg.hdr_output);
    }
    return 0;
}
