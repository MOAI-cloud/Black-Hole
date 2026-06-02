#pragma once
// ============================================================================
//  Render configuration shared between host and device.
// ============================================================================

struct RenderConfig {
    // --- Image ---
    int    width        = 1280;     // output width  in pixels
    int    height       = 720;      // output height in pixels
    int    spp          = 4;        // samples per pixel (anti-aliasing)

    // --- Black hole (geometric units: G = c = M = 1) ---
    double spin         = 0.9;      // a/M, Kerr spin parameter in [0, 1)

    // --- Camera ---
    double cam_r        = 60.0;     // camera radius in units of M
    double cam_theta    = 84.0;     // camera polar angle in degrees (90 = equatorial)
    double cam_phi      = 0.0;      // camera azimuth in degrees
    double fov          = 45.0;     // horizontal field of view in degrees
    double yaw          = 0.0;      // extra look yaw (deg), 0 = aim at centre
    double pitch        = 0.0;      // extra look pitch (deg)

    // --- Accretion disk (thin, equatorial) ---
    int    disk_enabled = 1;
    double disk_inner   = -1.0;     // inner radius (M); <0 => use ISCO
    double disk_outer   = 22.0;     // outer radius (M)
    double disk_temp    = 9000.0;   // characteristic temperature at inner edge (K)
    double disk_brightness = 12.0;  // emission scale multiplier
    int    doppler      = 1;        // 1 = apply Doppler + gravitational shift
    double disk_noise   = 0.45;     // 0..1 turbulence strength on brightness

    // --- Volumetric (thick) disk ---
    int    disk_volumetric = 1;     // 1 = emission/absorption volume integration
    double disk_thickness  = 0.5;   // vertical scale height (M) at inner edge
    double disk_flare      = 0.05;  // scale-height growth per unit radius (flaring)
    double disk_absorption = 0.4;   // opacity coefficient (optical depth scale)

    // --- Background ---
    const char* starmap = nullptr;  // equirect HDR/PPM star map file (black if unset)
    double sky_brightness = 1.0;    // multiplier applied to the background map


    // --- Integration ---
    double tolerance    = 1e-7;     // adaptive RKF45 relative tolerance
    double max_step     = 2.0;      // max affine step
    int    max_iter     = 200000;   // safety cap on integration steps

    // --- Post processing ---
    double exposure     = 1.0;      // linear exposure before tonemap

    // --- Output ---
    const char* output  = "gargantua.png";
    const char* hdr_output = nullptr;   // optional Radiance .hdr (linear HDR) file
};
