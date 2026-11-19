// Scene-linear camera PSF. The unscattered core and three normalized wings
// sum to one. Scattered radiance scales with exposure like the direct image.
FILM_FN float film_irradiance(float direct, float near_wing, float middle_wing, float far_wing) {
    return 0.86f * direct + 0.048f * near_wing + 0.050f * middle_wing + 0.042f * far_wing;
}

// Colorimetry stays in linear sRGB with its D65 white: no chromatic
// adaptation toward the disk's own temperature, so cooler thermal gas keeps
// its orange-red hue instead of being neutralized into beige.
FILM_FN FILM_RGB film_balance(FILM_RGB c) {
    return FILM_MAKE_RGB(FILM_MAX(0.f, c.x), FILM_MAX(0.f, c.y), FILM_MAX(0.f, c.z));
}

FILM_FN float film_shoulder(float x) {
    // Sigmoid in log exposure, with a print-like slope through the midtones.
    if (x <= 0.f) return 0.f;
    return 1.f / (1.f + FILM_POW(0.63f / x, 1.28f));
}

FILM_FN float film_channel(float x, float peak, float peak_response) {
    // Keep color differences through the upper midtones. Only the deep
    // shoulder approaches print white, leaving blue-hot parcels distinguishable.
    float chroma = 0.10f + 0.86f / (1.f + 0.037f*peak*peak);
    float ratio = FILM_POW(x / FILM_MAX(peak, 0.000001f), 1.35f);
    return chroma * peak_response * ratio + (1.f - chroma) * film_shoulder(x);
}
