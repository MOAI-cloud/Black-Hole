#pragma once
#include "../vec_math.cuh"

namespace grmhd {
#define BH_INLINE __device__ __forceinline__
#define BH_TIME real
#define BH_SQRT sqrtf
#define BH_LOG logf
#define BH_EXP expf
#define BH_MAX fmaxf
#define BH_MIN fminf
#define BH_FLOOR floorf
#define BH_FLOOR_TIME floor
#define FLOW_SAMPLER cudaTextureObject_t
#define FLOW_PAIR float2
#define FLOW_SAMPLE(a,u,v,i) tex3D<float2>(a,u,v,((i)+0.5f)/32.0f)
#include "sampling.inl"
#undef FLOW_SAMPLE
#undef FLOW_PAIR
#undef FLOW_SAMPLER
#undef BH_FLOOR_TIME
#undef BH_FLOOR
#undef BH_MIN
#undef BH_MAX
#undef BH_EXP
#undef BH_LOG
#undef BH_SQRT
#undef BH_TIME
#undef BH_INLINE
}
