// Shared CUDA/GLSL implementation. Bilinear reconstruction in phi and log(r).
// Shift adjacent Eulerian dumps to the same orbital phase before blending:
// the measured pattern travels ~0.8 circular-orbit speeds outside 6 M.
BH_INLINE float flow_window(FLOW_SAMPLER atlas, float u, float v, float age, float speed, float north) {
    float frame = BH_MIN(30.99999f, age * 0.2f);
    float lo = BH_FLOOR(frame);
    float f = frame - lo;
    FLOW_PAIR past = FLOW_SAMPLE(atlas, u - f * speed, v, lo);
    FLOW_PAIR next = FLOW_SAMPLE(atlas, u + (1.0f - f) * speed, v, lo + 1.0f);
    float previous_power = north*past.x*past.x + (1.0f-north)*past.y*past.y;
    float next_power = north*next.x*next.x + (1.0f-north)*next.y*next.y;
    return 9.0f * ((1.0f-f)*previous_power + f*next_power);
}

BH_INLINE float flow_field(FLOW_SAMPLER atlas, float r, float phi, BH_TIME time_m, float spin, float height) {
    float v = (BH_LOG(r) - 0.501468433f) / (0.022244052f * 190.0f);
    // The recorded flow ends at 113 M. Return to the annular mean outside it.
    float edge = BH_MAX(0.0f, BH_MIN(1.0f, (1.0f - v)*15.0f));
    if (edge <= 0.0f) return 1.0f;
    float rr = BH_MAX(r, 1.90f);
    // Ingoing Kerr-Schild azimuth and time, with their integration constants
    // fixed at 10 M. The source spacetime has spin +0.5.
    float lp = BH_LOG((rr - 1.866025404f) / 8.133974596f);
    float lm = BH_LOG((rr - 0.133974596f) / 9.866025404f);
    float turns = (phi + 0.288675135f*(lp - lm)) * 0.159154943f;
    float time_offset = 1.154700538f*(1.866025404f*lp - 0.133974596f*lm);
    float r32 = r*BH_SQRT(r);
    BH_TIME t = BH_TIME(85.0f + time_offset) + time_m * BH_TIME((r32 + 0.5f)/(r32 + spin));
    BH_TIME cycle = BH_FLOOR_TIME(t / BH_TIME(135.0f));
    float age = float(t - cycle * BH_TIME(135.0f));
    BH_TIME rotation = cycle * BH_TIME(0.38196601125);
    turns -= float(rotation - BH_FLOOR_TIME(rotation));
    float speed = (0.8f - 0.42f*BH_EXP(-BH_MAX(0.0f, r-3.0f)*0.625f)) *
                  0.795774715f / (r32 + 0.5f);
    float north = BH_MAX(0.0f, BH_MIN(1.0f, 0.5f + 0.5f*height));
    float activity = flow_window(atlas, turns, v, age, speed, north);
    if (age < 20.0f) {
        // Overlap two forward-running windows. Both weights and their first
        // derivatives agree across the wrap, including at negative ray times.
        float f = age / 20.0f;
        f = f*f*(3.0f - 2.0f*f);
        float tail = flow_window(atlas, turns + 0.38196601125f, v, age + 135.0f, speed, north);
        activity = (1.0f-f)*tail + f*activity;
    }
    return 1.0f + edge*(activity - 1.0f);
}

// A small radial displacement entrains the unresolved eddies in the recorded
// pressure filaments, correlating the turbulent cascade across scales.
BH_INLINE float flow_grain_radius(float r, float activity) {
    return r * BH_EXP(0.035f * (BH_SQRT(activity) - 1.0f));
}
