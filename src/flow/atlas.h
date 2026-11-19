#pragma once

namespace grmhd {
// Consecutive snapshots, logarithmic radial zones, then periodic azimuth.
constexpr int frames = 32, radii = 190, azimuths = 128;
extern const unsigned char atlas[frames * radii * azimuths * 2];
}
