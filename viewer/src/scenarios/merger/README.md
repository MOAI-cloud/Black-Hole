# Binary black hole merger scenario

`createMergerScenario` (in `index.ts`) implements the viewer's `Scenario` contract
(`../types.ts`). It solves an aligned-spin binary black hole coalescence, shows the
lensed binary and its outgoing gravitational waves in 3D, and plots the strain at
Earth. Geometric units G = c = M = 1 with M the initial total mass; physical units
use IAU/CODATA constants and Planck 2018 cosmology for the redshift.

## Files

| File | Contents |
| --- | --- |
| `merger.ts` | `solveMerger(input)`: full inspiral–merger–ringdown solution |
| `eob.ts` | Effective-one-body Hamiltonian, factorized modes and flux |
| `ode.ts` | Dormand–Prince 5(4) integrator with Hermite dense output |
| `qnm.ts` | Kerr quasi-normal modes by Leaver's continued fractions |
| `remnant.ts` | NR fits: final mass, final spin, recoil, (2,2) peak values |
| `harmonics.ts` | Spin-weighted spherical harmonics _{-2}Y_lm |
| `waveform.ts` | h+, h× at Earth, strain scale, sampling helpers |
| `units.ts` | Constants and luminosity distance ↔ redshift |
| `binaryShader.ts`, `MergerProgram.ts` | Ray tracer through the binary spacetime |
| `gwPlot.ts` | Strain, time–frequency map, separation and luminosity |
| `panel.ts`, `merger.css` | Inspector controls and readouts |

## Physics

**Inspiral and plunge.** EOB dynamics with the TEOBResumS aligned-spin Hamiltonian
as written by Rettegno et al., Phys. Rev. D 101, 104027 (2020), arXiv:1911.10818:
5PN A potential with logarithms and the NR-informed a₆ᶜ(ν) = 3097.3ν² − 1330.6ν + 81.38,
resummed as a Padé (1,5); Padé (0,3) D potential; 3PN Q term; NLO spin–spin
centrifugal radius; NNLO gyro-gravitomagnetic ratios with the NR-informed c₃.
Hamilton's equations use the tortoise radial momentum. The evolution starts from
post-adiabatic initial data where the (2,2) mode reaches 20 Hz in the detector frame
(at least 14 M separation, at most 40 M).

**Radiation reaction.** Factorized and resummed energy flux of Damour, Iyer & Nagar,
Phys. Rev. D 79, 064004 (2009), arXiv:0811.2069, over all (l, m > 0) with l ≤ 4:
Newtonian prefactor (with the Kepler-corrected v_φ), effective source, tail factor
T_lm, residual phases δ_lm and the ρ_lm polynomials (ρ₂₂ through 3PN plus test-mass
4PN and 5PN terms). Leading spin–orbit terms: ρ₂₂ ⊃ −⅔[(1−ν)χ_S + δχ_A]x^{3/2} and
f₂₁ = δρ₂₁² − 3/2(χ_A + δχ_S)v, which together reproduce the 1.5PN spin–orbit flux.

**Merger.** Next-to-quasi-circular corrections to the (2,2) mode impose, at t₀ (one M
before the orbital-frequency peak, or where 2Ω reaches the NR peak frequency for large
aligned spins), the peak amplitude and frequency fits of Healy & Lousto, Phys. Rev. D
97, 084002 (2018), zero amplitude slope, and the amplitude curvature and frequency
derivative of the ringdown model (C² amplitude, C¹ frequency matching).

**Ringdown.** Backwards-One-Body model, McWilliams, Phys. Rev. Lett. 122, 191102
(2019), in the strain form used by Kankani & McWilliams (SEBOB, arXiv:2508.20418):
|h| = |h₀|(ω₀/ω)² sech((t−t_p)/τ)/sech((t₀−t_p)/τ), ω⁴ = ω₀⁴ + k[tanh((t−t_p)/τ) −
tanh((t₀−t_p)/τ)], driven by the remnant's exact Kerr quasi-normal frequency and
damping time. Higher modes join their own QNM with C¹ amplitude continuity at the
orbital frequency 0.16/M.

**Remnant.** Final spin: Rezzolla et al., ApJ 674, L29 (2008). Radiated energy:
Barausse, Morozova & Rezzolla, ApJ 758, 63 (2012). Recoil: Healy & Lousto (2018) for
the mass-asymmetry term and their in-plane angle, Campanelli et al., ApJ 659, L5
(2007) for the spin term. QNMs: Leaver, Proc. R. Soc. Lond. A 402, 285 (1985), seeded
by Berti, Cardoso & Will (2006), with continuation in spin.

**Lensing (3D view).** Null geodesics of H = ½η^{μν}p_μp_ν − Σᵢ Hᵢ(lᵢ·p)², the
superposed inverse metric of boosted Kerr–Schild black holes (exact for one hole,
first order in the overlap H₁H₂). Positions and velocities come from the EOB orbit at
each ray's own coordinate time, so the image includes light-travel delay. Between
t = −7 M and the end of the plunge the binary fades into the remnant Kerr black hole
(exact Kerr–Schild). Ingoing Kerr–Schild coordinates are singular on the past horizon,
so backward rays are stopped at 1.05 r₊ or when p_t diverges; affine steps are scaled
by the coordinate speed so these rays cannot be flung out numerically.

**Gravitational-wave field.** In the orbital plane h× = 0 and
h₊ = Σ c_lm A_lm(u) cos(Φ_lm(u) + mψ) with c_lm = _{-2}Y_lm(π/2,0) + (−1)^l _{-2}Y_{l,−m}(π/2,0),
evaluated at the retarded time u = t − r* (Schwarzschild tortoise coordinate) and
shown with its 1/r fall-off (scaled to 10 M). Only the direct and first lensed image
of the plane are drawn.

## Validation (`viewer/tests/merger.test.mjs`)

| Check | Result |
| --- | --- |
| Schwarzschild QNMs (2,2,0), (2,2,1), (3,3,0), (4,4,0) | exact to 2×10⁻⁶ |
| Kerr (2,2,0) at a = 0.7 / 0.9 | 0.532600 − 0.080793i / 0.671614 − 0.064869i |
| EOB binding energy vs 3PN at r = 60 M (q = 1, 4) | within 2×10⁻⁵ |
| EOB flux vs 3.5PN at r = 30 M (q = 1, 4) | within 0.05% |
| EOB dx/dt vs TaylorT4 at x = 0.045 | −0.08% |
| GW150914 (36+29 M☉): time from 35 Hz to x = 1/6, EOB vs TaylorT4 | 0.0973 s vs 0.0958 s |
| Equal mass: peak \|rh₂₂\|/M, Mω₂₂ | 0.3937, 0.3587 (NR: 0.3937, 0.3587) |
| Equal mass: L_peak | 1.00×10⁻³ c⁵/G (NR 1.026×10⁻³, −2.6%) |
| Equal mass: radiated energy, waveform vs NR fit | 4.90% vs 4.83% of M |
| Equal mass: χ_f, M_f | 0.6865, 0.9517 (SXS: 0.68646, 0.95162) |
| GW150914 at 410 Mpc: z, face-on peak strain, peak f | 0.087, 2.1×10⁻²¹, 163 Hz |
| GW150914 ringdown f₂₂₀, τ₂₂₀ | 252 Hz, 4.07 ms (LIGO-inferred: ≈251 Hz, ≈4 ms) |
| q = 4: L_peak, E_rad vs fits | −17%, −10% |
| χ₁ = χ₂ = +0.9: L_peak, E_rad vs fits | +12%, +17% |
| χ₁ = χ₂ = −0.9: L_peak, E_rad vs fits | −5%, +3% |
| Orbits from 14 M, χ = +0.9 / 0 / −0.9 | hang-up ordering holds (≈25 / 18 / 12) |
| Edge-on h×, face-on polarization | h× = 0; circular |

A full solve takes 25–140 ms in Node (longest for small total masses, which start
at larger separations). The ray tracer draws a 2190 × 1340 frame in about 12 ms on
an RTX 5090 (7 ms after merger).

## Limitations

* Spins are aligned with the orbital angular momentum; precession is not modelled.
* Only the (2,2) mode is NR-calibrated through merger. Higher modes use the
  factorized EOB amplitudes and BOB ringdowns, which is why peak luminosity and
  radiated energy are 10–25% off for large mass ratios and near-maximal aligned spins.
* Eccentricity, tides and matter are absent (black holes only).
* The 3D metric is an approximation to the binary spacetime; it does not solve
  Einstein's equations near merger. The waveform does not come from that metric:
  it comes from the EOB/BOB model above.
* The recoil is reported but the remnant is drawn at the centre of mass.
