#pragma once
// ============================================================================
//  Radiance HDR (.hdr / RGBE) writer.  Stores linear, high-dynamic-range
//  radiance with a shared exponent per pixel.  No external dependencies.
//  Uses the new-style RLE scanline encoding that all HDR viewers accept.
// ============================================================================
#include <cstdint>
#include <cstdio>
#include <cmath>
#include <string>
#include <vector>

namespace hdr {

// Convert a linear float RGB pixel to 4-byte RGBE.
inline void float_to_rgbe(float r, float g, float b, uint8_t out[4]) {
    float v = r > g ? r : g;
    if (b > v) v = b;
    if (v < 1e-32f) { out[0] = out[1] = out[2] = out[3] = 0; return; }
    int e;
    float m = frexpf(v, &e) * 256.0f / v;   // mantissa scale
    out[0] = (uint8_t)(r * m);
    out[1] = (uint8_t)(g * m);
    out[2] = (uint8_t)(b * m);
    out[3] = (uint8_t)(e + 128);
}

// rgb: width*height*3 linear floats, row-major, top-to-bottom.
inline bool write(const std::string& path, int w, int h, const std::vector<float>& rgb) {
    if ((int)rgb.size() != w * h * 3) return false;
    FILE* f = fopen(path.c_str(), "wb");
    if (!f) return false;

    fprintf(f, "#?RADIANCE\n");
    fprintf(f, "FORMAT=32-bit_rle_rgbe\n");
    fprintf(f, "EXPOSURE=1.0\n\n");
    fprintf(f, "-Y %d +X %d\n", h, w);

    std::vector<uint8_t> scan((size_t)w * 4);
    for (int y = 0; y < h; ++y) {
        // Convert row to RGBE.
        for (int x = 0; x < w; ++x) {
            size_t i = ((size_t)y * w + x) * 3;
            uint8_t px[4];
            float_to_rgbe(rgb[i], rgb[i+1], rgb[i+2], px);
            scan[x] = px[0];
            scan[w + x] = px[1];
            scan[2*w + x] = px[2];
            scan[3*w + x] = px[3];
        }
        // New-style RLE header.
        uint8_t hdrb[4] = { 2, 2, (uint8_t)(w >> 8), (uint8_t)(w & 0xFF) };
        if (w < 8 || w >= 32768) {
            // Fallback: flat (non-RLE) scanline.
            for (int x = 0; x < w; ++x) {
                uint8_t px[4] = { scan[x], scan[w+x], scan[2*w+x], scan[3*w+x] };
                fwrite(px, 1, 4, f);
            }
            continue;
        }
        fwrite(hdrb, 1, 4, f);
        // RLE-encode each of the 4 component planes independently.
        for (int ch = 0; ch < 4; ++ch) {
            const uint8_t* comp = &scan[(size_t)ch * w];
            int x = 0;
            while (x < w) {
                int run_start = x;
                int run_len = 1;
                while (x + run_len < w && run_len < 127 &&
                       comp[x + run_len] == comp[x]) run_len++;
                if (run_len >= 4) {
                    // Encode a run.
                    uint8_t b0 = (uint8_t)(128 + run_len);
                    fputc(b0, f); fputc(comp[run_start], f);
                    x += run_len;
                } else {
                    // Encode a literal dump up to the next run of >=4.
                    int dump = 0;
                    int j = x;
                    while (j < w && dump < 128) {
                        int k = 1;
                        while (j + k < w && k < 4 && comp[j + k] == comp[j]) k++;
                        if (k >= 4) break;     // a run starts here
                        dump++; j++;
                    }
                    fputc((uint8_t)dump, f);
                    for (int d = 0; d < dump; ++d) fputc(comp[x + d], f);
                    x += dump;
                }
            }
        }
    }
    fclose(f);
    return true;
}

} // namespace hdr
