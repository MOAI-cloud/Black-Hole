#pragma once
#include <cuda_runtime.h>
#include <math.h>

// ============================================================================
//  Minimal vector helpers.  `real` is the precision used for the geodesic
//  integration (double for physical accuracy).  Colour math uses float3.
//
//  Precision is selectable at compile time: define GARGANTUA_REAL=float (e.g.
//  -DGARGANTUA_REAL=float) to trade a little geodesic accuracy for a large
//  speedup on consumer GPUs where FP64 throughput is a fraction of FP32.
// ============================================================================

#ifndef GARGANTUA_REAL
#define GARGANTUA_REAL double
#endif

using real = GARGANTUA_REAL;

struct vec3 { real x, y, z; };

__host__ __device__ __forceinline__ vec3 mkv(real x, real y, real z) { return {x, y, z}; }
__host__ __device__ __forceinline__ vec3 operator+(vec3 a, vec3 b) { return {a.x+b.x, a.y+b.y, a.z+b.z}; }
__host__ __device__ __forceinline__ vec3 operator-(vec3 a, vec3 b) { return {a.x-b.x, a.y-b.y, a.z-b.z}; }
__host__ __device__ __forceinline__ vec3 operator*(vec3 a, real s) { return {a.x*s, a.y*s, a.z*s}; }
__host__ __device__ __forceinline__ vec3 operator*(real s, vec3 a) { return {a.x*s, a.y*s, a.z*s}; }
__host__ __device__ __forceinline__ real dot(vec3 a, vec3 b) { return a.x*b.x + a.y*b.y + a.z*b.z; }
__host__ __device__ __forceinline__ vec3 cross(vec3 a, vec3 b) {
    return {a.y*b.z - a.z*b.y, a.z*b.x - a.x*b.z, a.x*b.y - a.y*b.x};
}
__host__ __device__ __forceinline__ real length(vec3 a) { return sqrt(dot(a, a)); }
__host__ __device__ __forceinline__ vec3 normalize(vec3 a) {
    real l = length(a);
    real inv = (l > 0) ? (real)1 / l : (real)0;
    return a * inv;
}

// ---- float3 colour helpers ----
__host__ __device__ __forceinline__ float3 mkc(float r, float g, float b) { return make_float3(r, g, b); }
__host__ __device__ __forceinline__ float3 operator+(float3 a, float3 b) { return make_float3(a.x+b.x, a.y+b.y, a.z+b.z); }
__host__ __device__ __forceinline__ float3 operator*(float3 a, float s) { return make_float3(a.x*s, a.y*s, a.z*s); }
__host__ __device__ __forceinline__ float3 operator*(float s, float3 a) { return make_float3(a.x*s, a.y*s, a.z*s); }
__host__ __device__ __forceinline__ float3 operator*(float3 a, float3 b) { return make_float3(a.x*b.x, a.y*b.y, a.z*b.z); }

__host__ __device__ __forceinline__ float clampf(float v, float lo, float hi) {
    return v < lo ? lo : (v > hi ? hi : v);
}
