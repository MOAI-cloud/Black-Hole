#pragma once
#include "vec_math.cuh"

namespace diskmaterial {

__host__ __device__ __forceinline__ float smooth_edge(float x) {
    x = clampf(x, 0, 1);
    return x * x * (3 - 2 * x);
}

__host__ __device__ __forceinline__ float taper(real r, real inner, real outer) {
    return smooth_edge((float)((r - inner) / (real)0.5)) *
           smooth_edge((float)((outer - r) / ((real)0.18 * outer)));
}

struct Transfer {
    float weight;
    float temperature_scale;
};

// `heating` is the local flux relative to its annular mean (a unit-mean
// log-normal from the turbulent cascade). In the thin sheet, optically thick
// clumps cover part of each surface element. Redistribute the local thermal
// flux across the covered area: covering * T^4 = heating.
__host__ __device__ __forceinline__ Transfer surface(float contrast, float heating, float edge) {
    const float covering = 1 - contrast * expf(-2.5f * heating);
    const float temp = covering > 0 ? sqrtf(sqrtf(heating / covering)) : 0;
    return {covering * edge, temp};
}

// Split the heating enhancement between emitting column and temperature. In
// the optically thin limit, weight * T^4 = heating.
__host__ __device__ __forceinline__ Transfer volume(float heating) {
    const float column = sqrtf(heating);
    return {column, sqrtf(sqrtf(column))};
}

} // namespace diskmaterial
