cmake_minimum_required(VERSION 3.20)

project(Gargantua LANGUAGES CXX CUDA)

# ---- Standards ----
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

# ---- CUDA architecture ----
# Default to "native" so it targets the GPU in this machine (RTX 5090 = sm_120).
# Override with: cmake -DCMAKE_CUDA_ARCHITECTURES=120 ..
if(NOT DEFINED CMAKE_CUDA_ARCHITECTURES)
  set(CMAKE_CUDA_ARCHITECTURES native)
endif()

add_executable(gargantua
  src/main.cu
  src/render_kernel.cu
)

target_include_directories(gargantua PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

# Use double precision for geodesic integration accuracy by default.
target_compile_definitions(gargantua PRIVATE)

# Release optimisation flags for nvcc + host compiler.
target_compile_options(gargantua PRIVATE
  $<$<COMPILE_LANGUAGE:CUDA>:-O3>
  $<$<COMPILE_LANGUAGE:CUDA>:--use_fast_math>
  $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr>
  $<$<COMPILE_LANGUAGE:CXX>:-O3>
)

# Allow large register usage / separable compilation is not required here.
set_target_properties(gargantua PROPERTIES
  CUDA_SEPARABLE_COMPILATION OFF
)
