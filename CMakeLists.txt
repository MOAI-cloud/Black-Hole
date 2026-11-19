cmake_minimum_required(VERSION 3.20)

# CUDA initializes its architecture list during project(). Honor explicit
# targets (including cross-builds) and select the local GPU when supported.
if(CMAKE_VERSION VERSION_GREATER_EQUAL 3.24 AND
   NOT DEFINED CMAKE_CUDA_ARCHITECTURES AND "$ENV{CUDAARCHS}" STREQUAL "")
  set(CMAKE_CUDA_ARCHITECTURES native CACHE STRING "CUDA architectures to build")
endif()

project(Gargantua LANGUAGES CXX CUDA)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CUDA_STANDARD 17)
set(CMAKE_CUDA_STANDARD_REQUIRED ON)

if(NOT CMAKE_CONFIGURATION_TYPES AND NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

option(GARGANTUA_FAST_MATH
  "Enable CUDA --use_fast_math. Faster, but less suitable for validation runs."
  OFF)
option(GARGANTUA_BUILD_TESTS "Build numerical Kerr/geodesic regression tests" ON)

set(flow_source "${CMAKE_CURRENT_BINARY_DIR}/grmhd_atlas.cpp")
set(flow_asset "${CMAKE_CURRENT_SOURCE_DIR}/src/flow/accretion.bin")
add_custom_command(OUTPUT "${flow_source}"
  COMMAND "${CMAKE_COMMAND}" "-DINPUT=${flow_asset}" "-DOUTPUT=${flow_source}"
          -P "${CMAKE_CURRENT_SOURCE_DIR}/cmake/EmbedFlow.cmake"
  DEPENDS "${flow_asset}" cmake/EmbedFlow.cmake
  VERBATIM)
add_library(grmhd_atlas STATIC "${flow_source}")
target_include_directories(grmhd_atlas PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")

add_executable(gargantua
  src/main.cu
  src/render_kernel.cu
)

target_link_libraries(gargantua PRIVATE grmhd_atlas)

find_package(ZLIB QUIET)
if(ZLIB_FOUND)
  target_link_libraries(gargantua PRIVATE ZLIB::ZLIB)
  target_compile_definitions(gargantua PRIVATE GARGANTUA_HAVE_ZLIB)
endif()

target_include_directories(gargantua PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_compile_options(gargantua PRIVATE
  $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr>
)

if(GARGANTUA_FAST_MATH)
  target_compile_options(gargantua PRIVATE
    $<$<COMPILE_LANGUAGE:CUDA>:--use_fast_math>
  )
endif()

set_target_properties(gargantua PROPERTIES
  CUDA_SEPARABLE_COMPILATION OFF
)

# Single-precision geodesics for interactive refinement. Consumer GPUs run
# FP64 at a small fraction of the FP32 rate; at the preview tolerance this
# build matches the double-precision image to well under one 8-bit level.
add_executable(gargantua_fast
  src/main.cu
  src/render_kernel.cu
)
target_link_libraries(gargantua_fast PRIVATE grmhd_atlas)
if(ZLIB_FOUND)
  target_link_libraries(gargantua_fast PRIVATE ZLIB::ZLIB)
  target_compile_definitions(gargantua_fast PRIVATE GARGANTUA_HAVE_ZLIB)
endif()
target_include_directories(gargantua_fast PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/include
  ${CMAKE_CURRENT_SOURCE_DIR}/src
)
target_compile_definitions(gargantua_fast PRIVATE GARGANTUA_REAL=float)
target_compile_options(gargantua_fast PRIVATE
  $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr>
)
if(GARGANTUA_FAST_MATH)
  target_compile_options(gargantua_fast PRIVATE $<$<COMPILE_LANGUAGE:CUDA>:--use_fast_math>)
endif()
set_target_properties(gargantua_fast PROPERTIES CUDA_SEPARABLE_COMPILATION OFF)

if(GARGANTUA_BUILD_TESTS)
  enable_testing()

  add_executable(gargantua_physics_tests
    tests/physics_tests.cu
  )
  target_include_directories(gargantua_physics_tests PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/include
    ${CMAKE_CURRENT_SOURCE_DIR}/src
  )
  target_compile_options(gargantua_physics_tests PRIVATE
    $<$<COMPILE_LANGUAGE:CUDA>:--expt-relaxed-constexpr>
  )

  add_test(NAME gargantua_physics COMMAND gargantua_physics_tests)

  add_executable(grmhd_tests tests/grmhd_tests.cpp)
  target_include_directories(grmhd_tests PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")
  target_link_libraries(grmhd_tests PRIVATE grmhd_atlas)
  add_test(NAME grmhd_material COMMAND grmhd_tests)
endif()
