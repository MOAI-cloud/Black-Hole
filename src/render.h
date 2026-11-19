#pragma once
#include "config.h"
#include "star_map.h"
#include <vector>
#include <string>

struct AnimFrame {
    double cam_r;
    double cam_theta;
    double cam_phi;
    std::string output;
};

std::vector<unsigned char> render_image(const RenderConfig& cfg,
                                        const std::vector<float>& lut,
                                        const StarMap& sky,
                                        std::vector<float>* hdr_out = nullptr);

int render_animation(const RenderConfig& base,
                     const std::vector<AnimFrame>& frames,
                     const std::vector<float>& lut,
                     const StarMap& sky);