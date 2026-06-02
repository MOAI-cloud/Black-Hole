#pragma once
#include "config.h"
#include "star_map.h"
#include <vector>
#include <string>

// One frame of an animation: camera placement + output file.
struct AnimFrame {
    double cam_r;
    double cam_theta;   // degrees
    double cam_phi;     // degrees
    std::string output; // PNG path
};

// Renders one frame.
//   lut : host-built blackbody LUT (LUT_N*3 floats).
//   sky : equirectangular HDR/PPM star map (use sky.valid() == false for a
//         black background).
//   hdr_out : if non-null, receives width*height*3 linear-radiance floats
//             (post-exposure, pre-tonemap) for HDR (.hdr) export.
// Returns width*height*3 bytes of sRGB, top-to-bottom.
std::vector<unsigned char> render_image(const RenderConfig& cfg,
                                        const std::vector<float>& lut,
                                        const StarMap& sky,
                                        std::vector<float>* hdr_out = nullptr);

// Renders a sequence of frames in one process, reusing the device-side LUT and
// star map across all frames. Writes each frame's PNG. Returns 0 on success.
int render_animation(const RenderConfig& base,
                     const std::vector<AnimFrame>& frames,
                     const std::vector<float>& lut,
                     const StarMap& sky);
