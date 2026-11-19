#pragma once
// ============================================================================
//  Equirectangular star-map loader.  Supports:
//    * Radiance HDR  (.hdr / .pic)  -> linear HDR radiance (preferred)
//    * Binary PPM    (.ppm, P6)     -> 8-bit sRGB, converted to linear
//  Returned data is texture-ready linear RGBA, row-major, top-to-bottom.
//  No external dependencies.
// ============================================================================
#include <cstdint>
#include <array>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <string>
#include <vector>

struct StarMap {
    int w = 0, h = 0;
    std::vector<float> rgba;
    bool valid() const { return w > 0 && h > 0 && rgba.size() == (size_t)w * h * 4; }
};

namespace starmap {

inline float srgb_to_linear(uint8_t v) {
    float s = v / 255.0f;
    return (s <= 0.04045f) ? s / 12.92f : std::pow((s + 0.055f) / 1.055f, 2.4f);
}

// ---- Radiance HDR (RGBE) reader ----
inline bool load_hdr(FILE* f, StarMap& out) {
    char line[512];
    // Header: lines until a blank line.
    while (fgets(line, sizeof(line), f)) {
        if (line[0] == '\n' || line[0] == '\r') break;
    }
    // Resolution line, e.g. "-Y 1024 +X 2048".
    if (!fgets(line, sizeof(line), f)) return false;
    int w = 0, h = 0;
    char vertical, horizontal;
    if (sscanf(line, " %cY %d %cX %d", &vertical, &h, &horizontal, &w) != 4 ||
        (vertical != '+' && vertical != '-') ||
        (horizontal != '+' && horizontal != '-')) return false;
    if (w <= 0 || h <= 0) return false;

    out.w = w; out.h = h;
    out.rgba.resize((size_t)w * h * 4);
    std::vector<uint8_t> scan((size_t)w * 4);

    for (int y = 0; y < h; ++y) {
        // Read header of the scanline.
        int c0 = fgetc(f), c1 = fgetc(f), c2 = fgetc(f), c3 = fgetc(f);
        if (c3 == EOF) return false;
        bool new_rle = (c0 == 2 && c1 == 2 && ((c2 << 8) | c3) == w && w >= 8 && w < 32768);
        if (new_rle) {
            for (int ch = 0; ch < 4; ++ch) {
                int x = 0;
                while (x < w) {
                    int cnt = fgetc(f);
                    if (cnt <= 0) return false;
                    if (cnt > 128) {           // run
                        int val = fgetc(f);
                        cnt -= 128;
                        if (val == EOF || cnt > w - x) return false;
                        while (cnt-- > 0) scan[x++ * 4 + ch] = (uint8_t)val;
                    } else {                   // dump
                        if (cnt > w - x) return false;
                        while (cnt-- > 0) {
                            int val = fgetc(f);
                            if (val == EOF) return false;
                            scan[x++ * 4 + ch] = (uint8_t)val;
                        }
                    }
                }
            }
        } else {
            // Flat / old-style scanline; we already consumed 4 bytes (pixel 0).
            scan[0] = (uint8_t)c0; scan[1] = (uint8_t)c1;
            scan[2] = (uint8_t)c2; scan[3] = (uint8_t)c3;
            for (int x = 1; x < w; ++x) {
                int a = fgetc(f), b = fgetc(f), cc = fgetc(f), d = fgetc(f);
                if (d == EOF) return false;
                scan[x*4+0]=(uint8_t)a; scan[x*4+1]=(uint8_t)b;
                scan[x*4+2]=(uint8_t)cc; scan[x*4+3]=(uint8_t)d;
            }
        }
        // RGBE -> float.
        for (int x = 0; x < w; ++x) {
            uint8_t R = scan[x*4+0], G = scan[x*4+1], B = scan[x*4+2], E = scan[x*4+3];
            float fexp = (E == 0) ? 0.0f : ldexpf(1.0f, (int)E - (128 + 8));
            const int row = vertical == '-' ? y : h - 1 - y;
            const int column = horizontal == '+' ? x : w - 1 - x;
            size_t idx = ((size_t)row * w + column) * 4;
            out.rgba[idx+0] = (R + 0.5f) * fexp;
            out.rgba[idx+1] = (G + 0.5f) * fexp;
            out.rgba[idx+2] = (B + 0.5f) * fexp;
            out.rgba[idx+3] = 1.0f;
        }
    }
    return true;
}

// ---- Binary PPM (P6) reader ----
inline bool load_ppm(FILE* f, StarMap& out) {
    char magic[3] = {0};
    if (fscanf(f, "%2s", magic) != 1 || strcmp(magic, "P6") != 0) return false;
    auto skip_ws = [&]() {
        int c;
        for (;;) {
            c = fgetc(f);
            if (c == '#') { while ((c = fgetc(f)) != EOF && c != '\n') {} }
            else if (c == ' ' || c == '\t' || c == '\n' || c == '\r') continue;
            else { ungetc(c, f); break; }
        }
    };
    int w, h, maxv;
    skip_ws(); if (fscanf(f, "%d", &w) != 1) return false;
    skip_ws(); if (fscanf(f, "%d", &h) != 1) return false;
    skip_ws(); if (fscanf(f, "%d", &maxv) != 1) return false;
    int separator = fgetc(f);
    if (separator == '\r') {
        const int next = fgetc(f);
        if (next != '\n' && next != EOF) ungetc(next, f);
    } else if (separator != '\n' && separator != ' ' && separator != '\t') {
        return false;
    }
    if (w <= 0 || h <= 0 || maxv != 255) return false;

    std::array<float, 256> linear{};
    for (size_t i = 0; i < linear.size(); ++i) linear[i] = srgb_to_linear((uint8_t)i);
    std::vector<uint8_t> row((size_t)w * 3);
    out.w = w; out.h = h;
    out.rgba.resize((size_t)w * h * 4);
    for (int y = 0; y < h; ++y) {
        if (fread(row.data(), 1, row.size(), f) != row.size()) return false;
        float* pixel = out.rgba.data() + (size_t)y * w * 4;
        for (size_t i = 0; i < row.size(); i += 3, pixel += 4) {
            pixel[0] = linear[row[i]];
            pixel[1] = linear[row[i + 1]];
            pixel[2] = linear[row[i + 2]];
            pixel[3] = 1.0f;
        }
    }
    return true;
}

inline StarMap load(const std::string& path) {
    StarMap m;
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) { fprintf(stderr, "star map: cannot open %s\n", path.c_str()); return m; }

    // Sniff format.
    int c0 = fgetc(f), c1 = fgetc(f);
    rewind(f);
    bool ok = false;
    if (c0 == '#' || c0 == '?') ok = load_hdr(f, m);         // #?RADIANCE
    else if (c0 == 'P' && c1 == '6') ok = load_ppm(f, m);
    else ok = load_hdr(f, m);                                 // try HDR anyway
    fclose(f);

    if (!ok || !m.valid()) {
        fprintf(stderr, "star map: failed to parse %s (use .hdr or binary .ppm)\n",
                path.c_str());
        m = StarMap{};
    } else {
        printf("Loaded star map %s (%dx%d)\n", path.c_str(), m.w, m.h);
    }
    return m;
}

} // namespace starmap
