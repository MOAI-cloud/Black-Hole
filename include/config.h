#pragma once

// ============================================================================
//  Render configuration shared between host and device-facing code.
// ============================================================================

enum DiskModel : int {
    DISK_MODEL_LEGACY = 0,
    DISK_MODEL_NOVIKOV_THORNE = 1,
};

struct RenderConfig {
    // --- Image ---
    int    width        = 1920;
    int    height       = 1080;
    int    spp          = 4;

    // --- Black hole (geometric units: G = c = M = 1) ---
    double spin         = 0.5;      // a/M in [0,1)

    // --- Camera ---
    double cam_r        = 62.0;
    double cam_theta    = 83.2;     // degrees, 90 = equatorial
    double cam_phi      = 115.0;      // degrees
    double fov          = 47.810610;     // horizontal FOV in degrees
    double yaw          = 0.0;
    double pitch        = 0.0;
    double roll         = -2.0;      // rotate the camera's right/up basis about its viewing axis, degrees
    double observer_time = 0.0;     // Boyer-Lindquist camera event time (M)
    double shutter       = 0.0;     // full rectangular exposure in coordinate time (M)
    double frame_dt      = 1.0;     // coordinate time between animation frames (M)

    // --- Accretion disk ---
    int    disk_enabled = 1;
    double disk_inner   = -1.0;     // < 0 => prograde ISCO
    double disk_outer   = 26.0;
    double disk_temp    = 5600.0;   // peak effective temperature for NT model
    double disk_brightness = 4.0;
    double disk_noise   = 0.5;      // turbulent contrast: log-normal heating width 0.5 * disk_noise (plus the recorded flow)
    int    disk_model   = DISK_MODEL_NOVIKOV_THORNE;

    // Frequency-shift controls.  Keeping them separate makes the semantics
    // explicit: the kinematic term is the gas motion relative to a ZAMO, while
    // the gravitational term is the ZAMO-to-observer shift.
    int    kinematic_doppler     = 1;
    int    gravitational_redshift = 1;

    // Evolve the simulated pressure field and its subgrid material and
    // account for light-travel time.  Disable for a deliberately frozen texture.
    int    disk_advect = 1;

    // --- Emitting geometry ---
    int    disk_volumetric = 0;
    bool   disk_photosphere = true;
    double disk_thickness  = 0.35;
    double disk_flare      = 0.035;
    double disk_absorption = 0.4;

    // --- Background ---
    const char* starmap = nullptr;
    double sky_brightness = 1.0;

    // A binary companion star at infinity on the celestial sphere: direction
    // (polar angle and azimuth, degrees), angular radius (degrees), T_eff (K).
    int    companion = 0;
    double companion_theta = 90.0;
    double companion_phi = 0.0;
    double companion_radius = 1.0;
    double companion_temp = 5800.0;
    // Disk colour correction f: a diluted blackbody f^-4 B(f T_eff), so a
    // star of equal colour temperature is f^4 brighter per unit area.
    double disk_color_correction = 1.0;

    // --- Integration ---
    // RK error is controlled with atol + rtol * scale.
    double tolerance     = 1e-7;    // relative tolerance (rtol)
    double abs_tolerance = 1e-10;   // absolute tolerance (atol)
    double min_step      = 1e-7;
    double max_step      = 2.0;
    int    max_iter      = 200000;

    // --- Post processing ---
    double exposure     = 1.0;
    bool   cinematic    = false;    // add optical halation and film shoulder to PNG

    // --- Output ---
    const char* output  = "gargantua.png";
    const char* hdr_output = nullptr;
};
