#pragma once
#include "vec_math.cuh"

namespace turbulence {

using uint = unsigned int;

// The eddy cascade comes from the same scalar source as the WebGL shaders.
// Native capture keeps orbital clocks and wrapped phases in geodesic precision,
// including at large observation times.
#define BH_INLINE __host__ __device__ __forceinline__
#define BH_TIME real
#define BH_FLOOR_TIME floor
#define BH_FLOOR floorf
#define BH_ABS fabsf
#define BH_LOG logf
#define BH_EXP expf
#define BH_SQRT sqrtf
#define BH_SIN sinf
#define BH_COS cosf
#define BH_MAX fmaxf
#define BH_MIN fminf
#include "disk_turbulence.inl"
#undef BH_MIN
#undef BH_MAX
#undef BH_COS
#undef BH_SIN
#undef BH_SQRT
#undef BH_EXP
#undef BH_LOG
#undef BH_ABS
#undef BH_FLOOR
#undef BH_FLOOR_TIME
#undef BH_TIME
#undef BH_INLINE

// Radial cells per unit ln r of the finest octave resolved at this footprint.
__host__ __device__ __forceinline__ float finest_kappa(float log_footprint) {
    float kappa = TURB_KAPPA0;
    for (int octave = 1; octave < 4; ++octave) {
        if (2.0f * kappa * log_footprint >= 1.15f) break;
        kappa *= 2.0f;
    }
    return kappa;
}

} // namespace turbulence
