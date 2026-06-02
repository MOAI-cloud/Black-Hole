#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Cinematic fly-around of Gargantua, encoded to a high-quality MP4.
#
#   * Smooth 360-degree orbit (azimuth sweep) that loops seamlessly.
#   * A gentle inclination "bob" and a slow dolly-in so the shot feels alive.
#   * Real gravitationally-lensed Milky Way background (falls back to the
#     procedural starfield if the map is missing).
#   * High-bitrate yuv420p H.264 so it plays everywhere.
#
# Requires: built ./build/gargantua  and  ffmpeg on PATH.
#
# Usage: ./render_animation.sh [frames] [width] [height] [spp] [fps]
#   defaults: 240 frames, 1920x1080, spp=12, 30 fps  (~8 s loop)
#
# Quick previews:
#   ./render_animation.sh 120 1280 720 4 30      # fast draft
# Showcase quality:
#   ./render_animation.sh 360 2560 1440 16 30    # 1440p, slow
# ---------------------------------------------------------------------------
set -euo pipefail

FRAMES="${1:-240}"
W="${2:-1920}"
H="${3:-1080}"
SPP="${4:-12}"
FPS="${5:-30}"

OUT_DIR="frames"
BIN="./build/gargantua"
OUT_MP4="gargantua.mp4"

# --- Scene / look ----------------------------------------------------------
SPIN=0.95              # high spin -> tight photon ring + strong frame dragging
DISK_TEMP=10000        # inner-edge temperature (K)
DISK_BRIGHT=14
DISK_NOISE=0.5
FOV=42
EXPOSURE=1.05
SKY_BRIGHT=1.25
STARMAP="milkyway.ppm" # real ESO Milky Way panorama (equirectangular)

# Camera path bounds (units of M).
CAM_R_START=70         # begin a little farther out ...
CAM_R_END=46           # ... and slowly dolly in
CAM_THETA_MID=86       # near edge-on for the signature top+bottom arcs
CAM_THETA_AMP=5        # inclination bob amplitude (degrees)

[ -x "$BIN" ] || { echo "Build first: cmake --build build -j"; exit 1; }
[ -f "$STARMAP" ] || { echo "Note: $STARMAP not found, using procedural starfield."; STARMAP=""; }

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR"/frame_*.png

echo "Rendering $FRAMES frames at ${W}x${H}, spp=$SPP, spin=$SPIN ..."

# All frames render in ONE process: the blackbody LUT and the (large) star map
# are uploaded to the GPU once, eliminating per-frame load/alloc overhead. The
# smooth orbit + dolly-in + inclination bob camera path lives in the binary.
ARGS=(--width "$W" --height "$H" --spp "$SPP"
      --spin "$SPIN" --fov "$FOV"
      --cam-theta "$CAM_THETA_MID" --orbit-theta-amp "$CAM_THETA_AMP"
      --orbit-r0 "$CAM_R_START" --orbit-r1 "$CAM_R_END"
      --disk-temp "$DISK_TEMP" --disk-bright "$DISK_BRIGHT" --disk-noise "$DISK_NOISE"
      --exposure "$EXPOSURE"
      --frames "$FRAMES" --anim-dir "$OUT_DIR")
[ -n "$STARMAP" ] && ARGS+=(--starmap "$STARMAP" --sky-bright "$SKY_BRIGHT")

"$BIN" "${ARGS[@]}"

echo "Encoding $OUT_MP4 ..."
ffmpeg -y -framerate "$FPS" -i "$OUT_DIR/frame_%04d.png" \
       -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p \
       -movflags +faststart "$OUT_MP4"

echo "Done -> $OUT_MP4  ($FRAMES frames @ ${FPS}fps, ${W}x${H})"
