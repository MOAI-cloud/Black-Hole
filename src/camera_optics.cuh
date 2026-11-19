#pragma once

#include "blackbody.cuh"
#include "starfield.cuh"

namespace camera_optics {

#define FILM_FN __device__ __forceinline__
#define FILM_MAX fmaxf
#define FILM_POW powf
#define FILM_RGB float3
#define FILM_MAKE_RGB mkc
#include "film_response.inl"
#undef FILM_FN
#undef FILM_MAX
#undef FILM_POW
#undef FILM_RGB
#undef FILM_MAKE_RGB

__device__ __forceinline__ uchar3 encode_pixel(float3 c, unsigned seed) {
    const float dr = sky::hash_f(seed ^ 0x9e3779b9u) - sky::hash_f(seed ^ 0x85ebca6bu);
    const float dg = sky::hash_f(seed ^ 0xc2b2ae35u) - sky::hash_f(seed ^ 0x27d4eb2fu);
    const float db = sky::hash_f(seed ^ 0x165667b1u) - sky::hash_f(seed ^ 0xd3a2646cu);
    return make_uchar3(quantize8(c.x, dr), quantize8(c.y, dg), quantize8(c.z, db));
}

// Integrate the radiance of every subpixel before downsampling. In particular
// a distant hot star carries its full flux into the wings of the lens PSF.
__global__ void collect(const float3* hdr, int w, int h, float3* seed, int sw, int sh, int bin) {
    const int x = blockIdx.x * blockDim.x + threadIdx.x;
    const int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= sw || y >= sh) return;
    float3 sum = mkc(0, 0, 0);
    int count = 0;
    for (int dy = 0; dy < bin && bin * y + dy < h; ++dy) {
        for (int dx = 0; dx < bin && bin * x + dx < w; ++dx) {
            sum = sum + hdr[(bin * y + dy) * w + bin * x + dx];
            ++count;
        }
    }
    seed[y * sw + x] = sum * (1.f / count);
}

__device__ __forceinline__ float3 lerp_color(float3 a, float3 b, float t) {
    return a * (1.f - t) + b * t;
}

__device__ __forceinline__ float3 linear_sample(const float3* image, int size, int stride, float coord) {
    coord = clampf(coord, 0, (float)(size - 1));
    const int i = (int)coord;
    return lerp_color(image[i * stride], image[min(i + 1, size - 1) * stride], coord - i);
}

__global__ void blur(const float3* source, int w, int h, float3* out, float spacing, bool horizontal) {
    const int x = blockIdx.x * blockDim.x + threadIdx.x;
    const int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= w || y >= h) return;
    const float3* line = horizontal ? source + y * w : source + x;
    const int size = horizontal ? w : h, stride = horizontal ? 1 : w;
    const int pos = horizontal ? x : y;
    constexpr float weight[5] = {70.f, 56.f, 28.f, 8.f, 1.f};
    float3 sum = source[y * w + x] * weight[0];
    for (int i = 1; i <= 4; ++i) {
        const float3 a = linear_sample(line, size, stride, pos - i * spacing);
        const float3 b = linear_sample(line, size, stride, pos + i * spacing);
        sum = sum + (a + b) * weight[i];
    }
    out[y * w + x] = sum * (1.f / 256.f);
}

__device__ __forceinline__ float3 interpolate(const float3* field, int w, int h, float x, float y) {
    y = clampf(y, 0, (float)(h - 1));
    const int iy = (int)y;
    return lerp_color(linear_sample(field + iy * w, w, 1, x),
                      linear_sample(field + min(iy + 1, h - 1) * w, w, 1, x), y - iy);
}

struct Wing {
    const float3* field;
    int width, height;
    float inv_stride;

    __device__ float3 sample(int x, int y) const {
        return interpolate(field, width, height, (x + .5f) * inv_stride - .5f, (y + .5f) * inv_stride - .5f);
    }
};

__global__ void display(const float3* hdr, int w, int h, Wing near_wing, Wing middle_wing, Wing far_wing, uchar3* out) {
    const int x = blockIdx.x * blockDim.x + threadIdx.x;
    const int y = blockIdx.y * blockDim.y + threadIdx.y;
    if (x >= w || y >= h) return;
    const int index = y * w + x;
    const float3 d = hdr[index];
    const float3 n = near_wing.sample(x, y);
    const float3 m = middle_wing.sample(x, y);
    const float3 f = far_wing.sample(x, y);
    const float3 irradiance = mkc(film_irradiance(d.x, n.x, m.x, f.x),
                                  film_irradiance(d.y, n.y, m.y, f.y),
                                  film_irradiance(d.z, n.z, m.z, f.z));
    const float3 balanced = film_balance(irradiance);
    const float peak = fmaxf(balanced.x, fmaxf(balanced.y, balanced.z));
    const float peak_response = film_shoulder(peak);
    const float3 mapped = mkc(film_channel(balanced.x, peak, peak_response),
                              film_channel(balanced.y, peak, peak_response),
                              film_channel(balanced.z, peak, peak_response));
    out[index] = encode_pixel(mapped, sky::hash_u((x * 1973u + y * 9277u) | 1u));
}

} // namespace camera_optics
