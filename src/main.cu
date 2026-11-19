#include "config.h"
#include "render.h"
#include "blackbody.cuh"
#include "png_writer.h"
#include "hdr_writer.h"
#include "star_map.h"
#include "spacetime.cuh"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <cmath>
#include <string>
#include <vector>

static void usage(const char* prog) {
    RenderConfig d;
    std::printf(
"Gargantua - physically based Kerr black-hole ray tracer (CUDA)\n\n"
"Usage: %s [options]\n"
"  --device-info          check CUDA availability and print the active GPU\n"
"  --width N              image width              (default %d)\n"
"  --height N             image height             (default %d)\n"
"  --spp N                samples per pixel        (default %d)\n"
"  --spin A               Kerr spin a/M in [0,1)  (default %.2g)\n"
"  --cam-r R              camera radius (M)        (default %.4g)\n"
"  --cam-theta DEG        camera polar angle       (default %.4g)\n"
"  --cam-phi DEG          camera azimuth           (default %.4g)\n"
"  --time T               observer coordinate time (M, default 0)\n"
"  --shutter T            exposure duration in M, sampled across spp (default 0)\n"
"  --fov DEG              field of view            (default %.4g)\n"
"  --yaw DEG --pitch DEG  aim offsets              (default 0)\n"
"  --roll DEG             camera roll around the viewing axis (default %.2g)\n"
"  --disk-in R            inner radius (M, <0=ISCO)\n"
"  --disk-out R           outer radius (M)         (default %.4g)\n"
"  --disk-temp K          peak effective temp (K)  (default %.5g)\n"
"  --disk-bright X        emission scale           (default %.4g)\n"
"  --disk-noise X         flow contrast 0..1       (default %.2g)\n"
"  --disk-model NAME      nt | legacy              (default nt)\n"
"  --disk-thick X         vertical scale height(M) (default %.2g)\n"
"  --disk-flare X         scale-height flaring     (default %.2g)\n"
"  --disk-absorb X        opacity coefficient      (default %.2g)\n"
"  --photosphere          optically thick flared surface (default)\n"
"  --thin                 use a partially covered equatorial sheet\n"
"  --volume               integrate the emitting and absorbing volume\n"
"  --no-kinematic-doppler remove gas-motion Doppler term\n"
"  --no-doppler           alias for --no-kinematic-doppler\n"
"  --no-redshift          remove gravitational frequency shift\n"
"  --static-disk-pattern  hold plasma parcels at their time-zero phases\n"
"  --no-disk              hide the accretion disk\n"
"  --starmap FILE         equirect HDR/PPM background\n"
"  --sky-bright X         star-map brightness      (default %.2g)\n"
"  --companion TH PH R T  companion star on the sky: polar angle, azimuth and\n"
"                         angular radius (degrees) and temperature (K)\n"
"  --disk-color-correction F  disk spectral hardening f (dilution f^-4)\n"
"  --exposure X           exposure                 (default %.2g)\n"
"  --cinematic            film shoulder and optical halation in PNG output\n"
"  --tol X                RK relative tolerance    (default %.1g)\n"
"  --atol X               RK absolute tolerance    (default %.1g)\n"
"  --min-step X           minimum affine step      (default %.1g)\n"
"  --max-step X           maximum affine step      (default %.2g)\n"
"  --max-iter N           per-ray step cap         (default %d)\n"
"  -o FILE                output PNG               (default %s)\n"
"  --hdr FILE             also write linear Radiance HDR\n"
"\n"
" Animation:\n"
"  --frames N             render N frames -> DIR/frame_%%04d.png\n"
"  --frame-dt T           coordinate time per frame (M, default 1)\n"
"  --fixed-camera         animate the disk at the supplied observer pose\n"
"  --anim-dir DIR         output directory         (default frames)\n"
"  --orbit-r0 R           dolly start radius\n"
"  --orbit-r1 R           dolly end radius\n"
"  --orbit-theta-amp D    inclination bob amplitude\n"
"  -h, --help             show this help\n",
        prog, d.width, d.height, d.spp, d.spin, d.cam_r, d.cam_theta,
        d.cam_phi, d.fov, d.roll, d.disk_outer, d.disk_temp, d.disk_brightness,
        d.disk_noise, d.disk_thickness, d.disk_flare, d.disk_absorption,
        d.sky_brightness, d.exposure, d.tolerance, d.abs_tolerance,
        d.min_step, d.max_step, d.max_iter, d.output);
}

static bool finite_number(double x) {
    return std::isfinite(x);
}

static int validate_config(const RenderConfig& cfg, int anim_frames) {
    if (!finite_number(cfg.spin) || cfg.spin < 0.0 || cfg.spin >= 1.0) {
        std::fprintf(stderr, "Spin must be finite and in [0,1). Got %g\n", cfg.spin);
        return 1;
    }
    if (cfg.width < 1 || cfg.height < 1) {
        std::fprintf(stderr, "Image dimensions must be positive. Got %dx%d\n",
                     cfg.width, cfg.height);
        return 1;
    }
    if (cfg.spp < 1) {
        std::fprintf(stderr, "Samples per pixel must be >= 1. Got %d\n", cfg.spp);
        return 1;
    }
    if (!finite_number(cfg.fov) || cfg.fov <= 0.0 || cfg.fov >= 180.0) {
        std::fprintf(stderr, "Field of view must be finite and in (0,180). Got %g\n",
                     cfg.fov);
        return 1;
    }
    if (!finite_number(cfg.yaw) || !finite_number(cfg.pitch) ||
        !finite_number(cfg.roll) || !finite_number(cfg.cam_phi)) {
        std::fprintf(stderr, "Camera yaw, pitch, roll, and azimuth must be finite.\n");
        return 1;
    }
    if (!finite_number(cfg.cam_theta) || cfg.cam_theta <= 0.0 || cfg.cam_theta >= 180.0) {
        std::fprintf(stderr,
            "Camera polar angle must be finite and strictly between 0 and 180 degrees. Got %g\n",
            cfg.cam_theta);
        return 1;
    }

    const double r_plus = 1.0 + std::sqrt(std::max(0.0, 1.0 - cfg.spin * cfg.spin));
    if (!finite_number(cfg.cam_r) || cfg.cam_r <= r_plus * (1.0 + 1e-8)) {
        std::fprintf(stderr,
            "Camera radius must be outside the Kerr outer horizon r+=%.15g. Got %.15g\n",
            r_plus, cfg.cam_r);
        return 1;
    }

    const double disk_in = cfg.disk_inner > 0.0
        ? cfg.disk_inner
        : (double)kerr::isco_prograde((real)cfg.spin);
    if (cfg.disk_enabled) {
        if (!finite_number(disk_in) || disk_in <= r_plus * (1.0 + 1e-8)) {
            std::fprintf(stderr, "Disk inner radius must be outside the horizon. Got %g\n",
                         disk_in);
            return 1;
        }
        if (!finite_number(cfg.disk_outer) || cfg.disk_outer <= disk_in) {
            std::fprintf(stderr,
                "Disk outer radius must be greater than inner radius %.10g. Got %.10g\n",
                disk_in, cfg.disk_outer);
            return 1;
        }
        if (!finite_number(cfg.disk_temp) || cfg.disk_temp <= 0.0 ||
            !finite_number(cfg.disk_brightness) || cfg.disk_brightness < 0.0 ||
            !finite_number(cfg.disk_noise) || cfg.disk_noise < 0.0 || cfg.disk_noise > 1.0) {
            std::fprintf(stderr, "Invalid disk temperature/brightness/noise parameters.\n");
            return 1;
        }
        if ((cfg.disk_volumetric || cfg.disk_photosphere) &&
            (!finite_number(cfg.disk_thickness) || cfg.disk_thickness <= 0.0)) {
            std::fprintf(stderr, "Disk thickness must be > 0 for a photosphere or volume.\n");
            return 1;
        }
        if (!finite_number(cfg.disk_flare) || cfg.disk_flare < 0.0 ||
            !finite_number(cfg.disk_absorption) || cfg.disk_absorption < 0.0) {
            std::fprintf(stderr, "Disk flare and absorption must be finite and non-negative.\n");
            return 1;
        }
    }

    if (!finite_number(cfg.tolerance) || cfg.tolerance <= 0.0 ||
        !finite_number(cfg.abs_tolerance) || cfg.abs_tolerance <= 0.0 ||
        !finite_number(cfg.min_step) || cfg.min_step <= 0.0 ||
        !finite_number(cfg.max_step) || cfg.max_step <= 0.0 ||
        cfg.min_step > cfg.max_step || cfg.max_iter < 1) {
        std::fprintf(stderr,
            "Invalid integrator settings: require rtol>0, atol>0, 0<min_step<=max_step, max_iter>=1.\n");
        return 1;
    }
    if (cfg.companion && (!finite_number(cfg.companion_theta) || !finite_number(cfg.companion_phi) ||
        !finite_number(cfg.companion_radius) || cfg.companion_radius <= 0.0 || cfg.companion_radius >= 90.0 ||
        !finite_number(cfg.companion_temp) || cfg.companion_temp <= 0.0)) {
        std::fprintf(stderr, "Companion needs finite angles, a radius in (0,90) degrees and a positive temperature.\n");
        return 1;
    }
    if (!finite_number(cfg.disk_color_correction) || cfg.disk_color_correction < 1.0) {
        std::fprintf(stderr, "Disk colour correction must be >= 1.\n");
        return 1;
    }
    if (!finite_number(cfg.sky_brightness) || cfg.sky_brightness < 0.0 ||
        !finite_number(cfg.exposure) || cfg.exposure <= 0.0) {
        std::fprintf(stderr, "Sky brightness must be >=0 and exposure must be >0.\n");
        return 1;
    }
    const double end_time = cfg.observer_time + (anim_frames > 0 ? anim_frames - 1 : 0) * cfg.frame_dt;
    if (!finite_number(cfg.shutter) || cfg.shutter < 0 ||
        !finite_number(std::min(cfg.observer_time, end_time) - cfg.shutter * 0.5) ||
        !finite_number(std::max(cfg.observer_time, end_time) + cfg.shutter * 0.5) ||
        !finite_number(cfg.frame_dt) || !finite_number(end_time)) {
        std::fprintf(stderr, "Observation times must be finite and shutter duration nonnegative.\n");
        return 1;
    }
    if (anim_frames < 0) {
        std::fprintf(stderr, "Frame count must be >= 0. Got %d\n", anim_frames);
        return 1;
    }
    return 0;
}

int main(int argc, char** argv) {
    if (argc == 2 && std::strcmp(argv[1], "--device-info") == 0) {
        int device = 0;
        cudaDeviceProp properties{};
        cudaError_t status = cudaGetDevice(&device);
        if (status == cudaSuccess) status = cudaGetDeviceProperties(&properties, device);
        if (status != cudaSuccess) {
            std::fprintf(stderr, "CUDA unavailable: %s\n", cudaGetErrorString(status));
            return EXIT_FAILURE;
        }
        std::printf("%s (compute %d.%d)\n", properties.name,
                    properties.major, properties.minor);
        return EXIT_SUCCESS;
    }

    RenderConfig cfg;

    int anim_frames = 0;
    bool fixed_camera = false;
    std::string anim_dir = "frames";
    double orbit_r0 = -1.0, orbit_r1 = -1.0;
    double orbit_theta_amp = 0.0;

    for (int i = 1; i < argc; ++i) {
        std::string a = argv[i];
        auto need = [&](const char* name) -> const char* {
            if (i + 1 >= argc) {
                std::fprintf(stderr, "Missing value for %s\n", name);
                std::exit(1);
            }
            return argv[++i];
        };

        if      (a == "--width")       cfg.width = std::atoi(need("--width"));
        else if (a == "--height")      cfg.height = std::atoi(need("--height"));
        else if (a == "--spp")         cfg.spp = std::atoi(need("--spp"));
        else if (a == "--spin")        cfg.spin = std::atof(need("--spin"));
        else if (a == "--cam-r")       cfg.cam_r = std::atof(need("--cam-r"));
        else if (a == "--cam-theta")   cfg.cam_theta = std::atof(need("--cam-theta"));
        else if (a == "--cam-phi")     cfg.cam_phi = std::atof(need("--cam-phi"));
        else if (a == "--shutter")      cfg.shutter = std::atof(need("--shutter"));
        else if (a == "--time")        cfg.observer_time = std::atof(need("--time"));
        else if (a == "--frame-dt")    cfg.frame_dt = std::atof(need("--frame-dt"));
        else if (a == "--fov")         cfg.fov = std::atof(need("--fov"));
        else if (a == "--yaw")         cfg.yaw = std::atof(need("--yaw"));
        else if (a == "--pitch")       cfg.pitch = std::atof(need("--pitch"));
        else if (a == "--roll")        cfg.roll = std::atof(need("--roll"));
        else if (a == "--disk-in")     cfg.disk_inner = std::atof(need("--disk-in"));
        else if (a == "--disk-out")    cfg.disk_outer = std::atof(need("--disk-out"));
        else if (a == "--disk-temp")   cfg.disk_temp = std::atof(need("--disk-temp"));
        else if (a == "--disk-bright") cfg.disk_brightness = std::atof(need("--disk-bright"));
        else if (a == "--disk-noise")  cfg.disk_noise = std::atof(need("--disk-noise"));
        else if (a == "--disk-thick")  cfg.disk_thickness = std::atof(need("--disk-thick"));
        else if (a == "--disk-flare")  cfg.disk_flare = std::atof(need("--disk-flare"));
        else if (a == "--disk-absorb") cfg.disk_absorption = std::atof(need("--disk-absorb"));
        else if (a == "--disk-model") {
            const std::string m = need("--disk-model");
            if (m == "nt" || m == "novikov-thorne" || m == "page-thorne")
                cfg.disk_model = DISK_MODEL_NOVIKOV_THORNE;
            else if (m == "legacy" || m == "ss")
                cfg.disk_model = DISK_MODEL_LEGACY;
            else {
                std::fprintf(stderr, "Unknown disk model '%s' (use nt or legacy)\n", m.c_str());
                return 1;
            }
        }
        else if (a == "--thin" || a == "--volume" || a == "--photosphere") {
            cfg.disk_volumetric = a == "--volume";
            cfg.disk_photosphere = a == "--photosphere";
        }
        else if (a == "--no-kinematic-doppler" || a == "--no-doppler")
            cfg.kinematic_doppler = 0;
        else if (a == "--no-redshift") cfg.gravitational_redshift = 0;
        else if (a == "--static-disk-pattern") cfg.disk_advect = 0;
        else if (a == "--no-disk")     cfg.disk_enabled = 0;
        else if (a == "--starmap")     cfg.starmap = need("--starmap");
        else if (a == "--sky-bright")  cfg.sky_brightness = std::atof(need("--sky-bright"));
        else if (a == "--companion") {
            cfg.companion = 1;
            cfg.companion_theta = std::atof(need("--companion"));
            cfg.companion_phi = std::atof(need("--companion"));
            cfg.companion_radius = std::atof(need("--companion"));
            cfg.companion_temp = std::atof(need("--companion"));
        }
        else if (a == "--disk-color-correction") cfg.disk_color_correction = std::atof(need("--disk-color-correction"));
        else if (a == "--cinematic")   cfg.cinematic = true;
        else if (a == "--exposure")    cfg.exposure = std::atof(need("--exposure"));
        else if (a == "--tol")         cfg.tolerance = std::atof(need("--tol"));
        else if (a == "--atol")        cfg.abs_tolerance = std::atof(need("--atol"));
        else if (a == "--min-step")    cfg.min_step = std::atof(need("--min-step"));
        else if (a == "--max-step")    cfg.max_step = std::atof(need("--max-step"));
        else if (a == "--max-iter")    cfg.max_iter = std::atoi(need("--max-iter"));
        else if (a == "-o")            cfg.output = need("-o");
        else if (a == "--hdr")         cfg.hdr_output = need("--hdr");
        else if (a == "--fixed-camera") fixed_camera = true;
        else if (a == "--frames")      anim_frames = std::atoi(need("--frames"));
        else if (a == "--anim-dir")    anim_dir = need("--anim-dir");
        else if (a == "--orbit-r0")    orbit_r0 = std::atof(need("--orbit-r0"));
        else if (a == "--orbit-r1")    orbit_r1 = std::atof(need("--orbit-r1"));
        else if (a == "--orbit-theta-amp")
            orbit_theta_amp = std::atof(need("--orbit-theta-amp"));
        else if (a == "-h" || a == "--help") {
            usage(argv[0]);
            return 0;
        } else {
            std::fprintf(stderr, "Unknown option: %s\n", a.c_str());
            usage(argv[0]);
            return 1;
        }
    }

    if (validate_config(cfg, anim_frames)) return 1;

    std::printf("Building blackbody colour LUT...\n");
    std::vector<float> lut = bb::build_lut(cfg.disk_temp);

    StarMap sky;
    if (cfg.starmap) sky = starmap::load(cfg.starmap);

    if (anim_frames > 0) {
        const double r0 = orbit_r0 > 0.0 ? orbit_r0 : cfg.cam_r;
        const double r1 = orbit_r1 > 0.0 ? orbit_r1 : cfg.cam_r;
        const double th_mid = cfg.cam_theta;

        const double r_plus = 1.0 + std::sqrt(std::max(0.0, 1.0 - cfg.spin * cfg.spin));
        if (!fixed_camera && (r0 <= r_plus || r1 <= r_plus)) {
            std::fprintf(stderr, "Animation camera radii must stay outside r+=%.10g\n", r_plus);
            return 1;
        }

        std::vector<AnimFrame> frames;
        frames.reserve((size_t)anim_frames);
        for (int i = 0; i < anim_frames; ++i) {
            double camr = cfg.cam_r, theta = cfg.cam_theta, phi = cfg.cam_phi;
            if (!fixed_camera) {
                const double t = (double)i / (double)anim_frames;
                phi = 360.0 * t;
                const double ease = 0.5 - 0.5 * std::cos(M_PI * t);
                camr = r0 + (r1 - r0) * ease;
                theta = th_mid + orbit_theta_amp * std::sin(2.0 * M_PI * t);
                if (theta <= 0.0 || theta >= 180.0) {
                    std::fprintf(stderr,
                        "Animation polar angle leaves valid range (0,180) at frame %d: %g\n",
                        i, theta);
                    return 1;
                }
            }

            char name[32];
            std::snprintf(name, sizeof(name), "frame_%04d.png", i);
            frames.push_back({camr, theta, phi, (std::filesystem::path(anim_dir) / name).string()});
        }

        std::error_code directory_error;
        std::filesystem::create_directories(anim_dir, directory_error);
        if (directory_error) {
            std::fprintf(stderr, "Cannot create animation directory %s: %s\n", anim_dir.c_str(),
                         directory_error.message().c_str());
            return 1;
        }
        const int rc = render_animation(cfg, frames, lut, sky);
        if (rc == 0)
            std::printf("Wrote %d frames to %s/\n", anim_frames, anim_dir.c_str());
        return rc;
    }

    std::vector<float> hdrbuf;
    std::vector<unsigned char> img =
        render_image(cfg, lut, sky, cfg.hdr_output ? &hdrbuf : nullptr);

    if (!png::write(cfg.output, cfg.width, cfg.height, img)) {
        std::fprintf(stderr, "Failed to write %s\n", cfg.output);
        return 1;
    }
    std::printf("Wrote %s (%dx%d)\n", cfg.output, cfg.width, cfg.height);

    if (cfg.hdr_output) {
        if (!hdr::write(cfg.hdr_output, cfg.width, cfg.height, hdrbuf)) {
            std::fprintf(stderr, "Failed to write %s\n", cfg.hdr_output);
            return 1;
        }
        std::printf("Wrote %s (linear HDR)\n", cfg.hdr_output);
    }
    return 0;
}
