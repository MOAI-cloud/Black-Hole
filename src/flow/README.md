# Accretion flow movie

The packed data in `accretion.bin` is adapted from © 2024 Illinois Simulation Data Products, released under Creative Commons Attribution 4.0 International. Credit Vedant Dhruv, Ben Prather, George Wong and Charles F. Gammie, *A Survey of General Relativistic Magnetohydrodynamic Models for Black Hole Accretion Systems*, ApJS **277**, 16 (2025). [Data catalog](https://thz.astro.illinois.edu/v3_grmhd.html) · [Research paper](https://doi.org/10.3847/1538-4365/adaea6) · [CC BY 4.0 license](https://creativecommons.org/licenses/by/4.0/)

## Data reduction

The source is the Illinois v3 SANE torus at prograde spin +0.5. The renderer uses 32 consecutive dumps on the 288 × 128 × 128 FMKS grid, from `torus.out0.05400.h5` through `torus.out0.05431.h5`. They cover simulation time 27000–27155 GM/c³ at approximately 5 GM/c³ intervals. [First source snapshot](https://thz.astro.illinois.edu/v3_grmhd/SANE/a+0.5/288x128x128/torus.out0.05400.h5)

The reduction keeps all 128 azimuths, radial indices 0–189 (centers 1.67–111.80 GM/c²), and polar indices 60–67. It calculates the magnetic pressure in the fluid rest frame from the magnetic and velocity primitives in the FMKS metric. It integrates magnetic and thermal pressure on each side of the equator using the invariant coordinate volume, and divides each column by its azimuthal mean. The two hemispheres are stored separately.

The optical model uses a weighted local heating proxy, 84% magnetic pressure and 16% gas pressure. It caps exceptionally bright cells at nine times the annular mean and returns that energy to the same annulus. The stored channels use square-root companding. This reduction discards the absolute mass scale and the vertical structure outside the equatorial band. The renderer supplies its own effective temperature, photosphere shape and radial flux law. Fine, finite-lifetime emitting packets represent structure below the source grid scale.

Run `python3 tools/pack_grmhd.py PATH_TO_HDF5_FILES src/flow/accretion.bin` with NumPy and h5py to regenerate the asset. It contains 32 × 190 × 128 interleaved north/south unsigned byte pairs in row-major order. The SHA-256 is `6b98dc9001981ba46161d395e424afbf6ec62577081c7c817062e57cdf99959c`. A normal build uses the packaged asset offline.

## Space and time

The shared sampler converts Boyer–Lindquist emission events to source Kerr–Schild time and azimuth, choosing the same coordinate origins at 10 GM/c². At that radius, viewer emission time zero selects source epoch 27085 GM/c³. Each source dump contains a distinct evolved flow. Between dumps the renderer shifts both adjacent images toward the requested time before interpolation. A relative pattern speed was estimated by cross-correlating adjacent azimuthal pressure profiles. Its fit approaches 0.8 times the circular frequency outside 6 GM/c².

For indefinite playback the final 20 GM/c³ overlaps the first 20 GM/c³ of another forward-playing copy, rotated in azimuth. For other spins the viewer samples this same dataset at the ratio of local Kerr circular frequencies. Inside the source horizon this visualization uses the innermost finite coordinate offsets. At the outer edge the fluctuations taper to their annular mean.
