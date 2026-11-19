#pragma once
#include "vec_math.cuh"

// ============================================================================
//  Equirectangular star-map background.  Sampled by the escape direction of
//  each ray, so the black hole's lensing automatically warps the stars into
//  the characteristic Einstein ring around the shadow.  Also exposes the value
//  noise / hashing helpers used by the disk turbulence and sample jitter.
// ============================================================================

namespace sky {

__device__ __forceinline__ unsigned hash_u(unsigned x) {
    x ^= x >> 16; x *= 0x7feb352dU;
    x ^= x >> 15; x *= 0x846ca68bU;
    x ^= x >> 16; return x;
}
__device__ __forceinline__ float hash_f(unsigned x) {
    return (hash_u(x) & 0x00FFFFFF) / (float)0x01000000;
}
__device__ __forceinline__ unsigned cell_hash(int i, int j) {
    return hash_u((unsigned)i * 73856093u ^ (unsigned)j * 19349663u);
}

// Smooth disk noise with a periodic azimuthal lattice.
__device__ __forceinline__ float vnoise(float u, float v, int period) {
    int i = (int)floorf(u), j = (int)floorf(v);
    float fu = u - i, fv = v - j;
    if (j == period) j = 0;
    const int next_j = j + 1 < period ? j + 1 : 0;
    float a = hash_f(cell_hash(i,   j));
    float b = hash_f(cell_hash(i+1, j));
    float c = hash_f(cell_hash(i,   next_j));
    float d = hash_f(cell_hash(i+1, next_j));
    float su = fu*fu*(3-2*fu), sv = fv*fv*(3-2*fv);
    return (a*(1-su)+b*su)*(1-sv) + (c*(1-su)+d*su)*sv;
}

// --- Hardware-filtered sample of an equirect star map via a texture object ---
// The texture is created with normalized coords, linear filtering, longitude
// wrap and latitude clamp, so this is a single cached tex2D fetch.
__device__ __forceinline__ float3 sample_equirect_tex(cudaTextureObject_t tex,
                                                       float3 dir) {
    const float PI = 3.14159265358979f;
    float lon = atan2f(dir.y, dir.x);
    float lat = asinf(clampf(dir.z, -1.f, 1.f));
    float u = (lon / (2.f*PI) + 0.5f);          // 0..1 (wraps in x)
    float v = (0.5f - lat / PI);                // 0..1, v=0 at +z (top)
    float4 c = tex2D<float4>(tex, u, v);
    return make_float3(c.x, c.y, c.z);
}

} // namespace sky