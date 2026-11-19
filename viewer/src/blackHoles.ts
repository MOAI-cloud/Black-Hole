import { LIGHT_YEAR, PARSEC, colorCorrection, diskPeakTemperature, gravitationalRadius } from './astro';

/** Angular size of GM/c² seen from Earth, in microarcseconds. */
const microarcseconds = (massSolar: number, metres: number) => gravitationalRadius(massSolar) / metres * 180 / Math.PI * 3600e6;
import type { RenderSettings } from './types';

// Real black holes with literature parameters. Disk temperatures follow from
// mass, spin and Eddington ratio through the Novikov–Thorne flux and the
// Done et al. (2012) colour correction; companions use measured stellar radii
// and orbital separations. Unknown spins are labelled as assumptions.

export interface Reference { label: string; url: string }

export interface ObjectView {
  name: string;
  note: string;
  settings: Partial<RenderSettings>;
}

export interface BlackHoleEntry {
  id: string;
  name: string;
  kind: string;
  massSolar: number;
  massText: string;
  spin: number;
  spinText: string;
  distanceText: string;
  /** Local (non-cosmological) distance for angular sizes seen from Earth. */
  distanceMeters?: number;
  accretionText: string;
  summary: string;
  striking: string;
  facts: [string, string][];
  references: Reference[];
  /** Shared by every view of this object. */
  base: Partial<RenderSettings>;
  views: ObjectView[];
  accent: string;
}

/** Colour temperature of a thin disk's hottest annulus and its hardening factor. */
function thinDisk(massSolar: number, spin: number, eddingtonRatio: number) {
  const effective = diskPeakTemperature(massSolar, spin, eddingtonRatio);
  const correction = colorCorrection(effective);
  return { temperature: Math.round(effective * correction), correction };
}

const phoenix = thinDisk(1e11, 0.9, 0.005), phoenixTemp = phoenix.temperature;
const ton = thinDisk(6.6e10, 0.9, 0.048), tonTemp = ton.temperature;
const cyg = thinDisk(21.2, 0.9985, 0.02), cygTemp = cyg.temperature;
const v404 = thinDisk(9.0, 0.92, 0.5), v404Temp = v404.temperature;

export const BLACK_HOLES: BlackHoleEntry[] = [
  {
    id: 'phoenix-a', name: 'Phoenix A*', kind: 'Ultramassive · cluster core', accent: '#ffb46a',
    massSolar: 1e11, massText: 'up to ~1 × 10¹¹ M☉ (indirect, uncertain)', spin: 0.9, spinText: '0.9 (assumed)',
    distanceText: 'z = 0.597 · light left 5.8 billion years ago',
    accretionText: '≈0.5% of Eddington (assumed): a cool, visible-light thin disk',
    summary: 'The central black hole of the Phoenix Cluster’s brightest galaxy, among the most massive known. Its mass is inferred from scaling relations rather than measured orbits.',
    striking: 'Scale. Its event horizon is ~2,000 AU across, roughly 16 times the diameter of the heliopause, yet the tidal stretch at the horizon is only ~10⁻¹² m/s² on a 2 m body. The innermost stable orbit takes about 5 months. At this mass even a near-critical accretion flow peaks near 10,000 K, so the disk glows in visible light.',
    facts: [['Mass', '~1 × 10¹¹ M☉'], ['Peak disk temperature', `${phoenixTemp.toLocaleString('en-US')} K`]],
    references: [
      { label: 'McDonald et al. 2012, Nature 488, 349', url: 'https://doi.org/10.1038/nature11379' }
    ],
    base: { massSolar: 1e11, spin: 0.9, diskTemp: phoenixTemp, diskColorCorrection: phoenix.correction, diskOuter: 48, diskThick: 0.22, diskFlare: 0.02, diskNoise: 0.5,
      diskBright: 4, background: 'milky-way', skyBright: 0.1, thin: true, photosphere: true, cinematic: true },
    views: [
      { name: 'Giant cool disk', note: 'Visible-light thermal disk, 80° inclination.',
        settings: { camR: 95, camTheta: 80, camPhi: 120, fov: 30, roll: -2 } },
      { name: 'Face-on scale', note: 'Looking down the spin axis at the whole disk.',
        settings: { camR: 120, camTheta: 18, camPhi: 90, fov: 42, roll: 0 } }
    ]
  },
  {
    id: 'ton-618', name: 'TON 618', kind: 'Hyperluminous quasar', accent: '#9fc8ff',
    massSolar: 6.6e10, massText: '4.1–6.6 × 10¹⁰ M☉ (broad-line estimates)', spin: 0.9, spinText: '0.9 (assumed)',
    distanceText: 'z = 2.219 · light left ~10.8 billion years ago',
    accretionText: '≈5% of Eddington (L ≈ 4 × 10⁴⁰ W)',
    summary: 'A radio-loud quasar whose disk outshines its host galaxy about a hundred thousand times over. Its mass comes from the widths of broad emission lines.',
    striking: 'Luminosity. It shines at roughly 10¹⁴ solar luminosities. The inner disk reaches ~20,000 K and glows blue-white, while the outer disk cools through yellow to deep orange.',
    facts: [['Mass', '6.6 × 10¹⁰ M☉'], ['Peak disk temperature', `${tonTemp.toLocaleString('en-US')} K`], ['Luminosity', '≈ 4 × 10⁴⁰ W']],
    references: [
      { label: 'Shemmer et al. 2004, ApJ 614, 547', url: 'https://doi.org/10.1086/423607' },
      { label: 'Ge et al. 2019, AJ 157, 148', url: 'https://doi.org/10.3847/1538-3881/ab0956' }
    ],
    base: { massSolar: 6.6e10, spin: 0.9, diskTemp: tonTemp, diskColorCorrection: ton.correction, diskOuter: 60, diskThick: 0.7, diskFlare: 0.03, diskNoise: 0.55,
      diskBright: 4, background: 'star-field', skyBright: 0.08, thin: true, photosphere: true, cinematic: true },
    views: [
      { name: 'Quasar disk', note: 'Temperature gradient across the disk at 75°.',
        settings: { camR: 110, camTheta: 75, camPhi: 60, fov: 34, roll: 0 } },
      { name: 'Inner disk', note: 'Close to the ~20,000 K inner edge.',
        settings: { camR: 24, camTheta: 70, camPhi: 200, fov: 62, roll: -8 } }
    ]
  },
  {
    id: 'm87', name: 'M87*', kind: 'Supermassive · first image', accent: '#ff8a3d',
    massSolar: 6.5e9, massText: '(6.5 ± 0.7) × 10⁹ M☉', spin: 0.9, spinText: '≈0.9 (model-dependent)',
    distanceText: '16.8 Mpc · 55 million light-years', distanceMeters: 16.8e6 * PARSEC,
    accretionText: '~10⁻⁵ of Eddington: hot, optically thin flow plus jet',
    summary: 'The black hole at the heart of Messier 87, imaged by the Event Horizon Telescope in 2017 at 1.3 mm. The ring is 42 μas across, a shadow about 2.6 times the horizon’s apparent size.',
    striking: 'The first black-hole photograph. Seen 17° from its jet axis, gas orbiting in a hot, magnetized flow produces a ring brightened on its southern side by Doppler beaming. A relativistic jet launched from the spin axis extends far beyond the galaxy.',
    facts: [['Ring diameter', '42 ± 3 μas'], ['Viewing angle', '17° from the jet axis'], ['1 M of time', '8.9 hours']],
    references: [
      { label: 'EHT Collaboration 2019, ApJL 875, L1', url: 'https://doi.org/10.3847/2041-8213/ab0ec7' },
      { label: 'EHT Collaboration 2019, ApJL 875, L5', url: 'https://doi.org/10.3847/2041-8213/ab0f43' }
    ],
    // Self-similar ADAF scalings n ∝ r^-1.5, T_e ∝ r^-1 (Narayan & Yi 1995).
    base: { massSolar: 6.5e9, spin: 0.9, emission: 'synchrotron', observeGHz: 230, riafDensity: 8e3, riafTemperature: 4e10,
      riafDensitySlope: 1.5, riafTemperatureSlope: 1.0,
      riafHeight: 0.5, riafBeta: 10, jet: false, hotspot: false, background: 'dark', skyBright: 0, cinematic: false, exposure: 0.9,
      angularScale: microarcseconds(6.5e9, 16.8e6 * PARSEC) },
    views: [
      { name: 'EHT 2017 view', note: '230 GHz, 17° from the jet axis, bright south.',
        settings: { camR: 300, camTheta: 163, camPhi: 0, fov: 6, roll: -90 } },
      { name: 'Telescope resolution', note: 'The same image through a 15 μas Gaussian beam, close to EHT reconstructions.',
        settings: { camR: 300, camTheta: 163, camPhi: 0, fov: 8, roll: -90, telescopeBeam: 15, exposure: 2 } },
      { name: 'Jet base at 86 GHz', note: 'Logarithmic display over 3.5 decades: the limb-brightened sheath beside the core.',
        settings: { camR: 400, camTheta: 163, camPhi: 0, fov: 40, roll: -90, exposure: 1, jet: true, observeGHz: 86, displayDecades: 3.5 } }
    ]
  },
  {
    id: 'sgr-a', name: 'Sagittarius A*', kind: 'Supermassive · Milky Way', accent: '#ffcf70',
    massSolar: 4.3e6, massText: '(4.297 ± 0.012) × 10⁶ M☉', spin: 0.9, spinText: '≳0.5 (EHT-favoured models)',
    distanceText: '8.28 kpc · 27,000 light-years', distanceMeters: 8.277e3 * PARSEC,
    accretionText: '~10⁻⁸ of Eddington: a faint, hot flow with near-infrared flares',
    summary: 'The black hole at the centre of our Galaxy. Stellar orbits such as S2 pin down its mass. The EHT imaged its 52 μas ring in 2022, and GRAVITY tracked flares orbiting just outside the innermost stable orbit.',
    striking: 'Its flares. Hot spots circle the black hole every ~30–70 minutes at a few times the ISCO, appearing and repeating as lensed images. One M of time is 21 seconds, so the 230 GHz image changes over minutes.',
    facts: [['Ring diameter', '51.8 ± 2.3 μas'], ['Flare orbit', '≈ 9 M, period ≈ 1 hour'], ['1 M of time', '21.2 s']],
    references: [
      { label: 'EHT Collaboration 2022, ApJL 930, L12', url: 'https://doi.org/10.3847/2041-8213/ac6674' },
      { label: 'GRAVITY Collaboration 2018, A&A 618, L10', url: 'https://doi.org/10.1051/0004-6361/201834294' },
      { label: 'GRAVITY Collaboration 2022, A&A 657, L12', url: 'https://doi.org/10.1051/0004-6361/202142465' }
    ],
    base: { massSolar: 4.3e6, spin: 0.9, emission: 'synchrotron', observeGHz: 230, riafDensity: 6e5, riafTemperature: 4e10,
      riafHeight: 0.5, riafBeta: 10, jet: false, hotspot: false, hotspotRadius: 9, background: 'dark', skyBright: 0, cinematic: false,
      exposure: 1, angularScale: microarcseconds(4.297e6, 8.277e3 * PARSEC) },
    views: [
      { name: 'EHT 2022 view', note: '230 GHz at a 30° inclination.',
        settings: { camR: 200, camTheta: 30, camPhi: 0, fov: 9, roll: 0 } },
      { name: 'Telescope resolution', note: 'The same image through the EHT’s ~20 μas beam.',
        settings: { camR: 200, camTheta: 30, camPhi: 0, fov: 11, roll: 0, telescopeBeam: 20, exposure: 1.8 } },
      { name: 'Orbiting flare', note: 'A hot spot at 9 M, lensed into primary and secondary images.',
        settings: { camR: 200, camTheta: 35, camPhi: 0, fov: 9, roll: 0, hotspot: true } },
      { name: 'Edge-on flow', note: 'The same flow seen from the equatorial plane.',
        settings: { camR: 200, camTheta: 88, camPhi: 0, fov: 9, roll: 0, exposure: 0.8 } }
    ]
  },
  {
    id: 'gaia-bh3', name: 'Gaia BH3', kind: 'Dormant · stellar mass', accent: '#ffe2a8',
    massSolar: 32.7, massText: '(32.7 ± 0.8) M☉', spin: 0, spinText: 'unknown (shown as 0)',
    distanceText: '590 pc · 1,926 light-years', distanceMeters: 1926 * LIGHT_YEAR,
    accretionText: 'None detected: dormant',
    summary: 'The most massive stellar black hole known in the Milky Way, found from the wobble of an old, metal-poor giant star in an 11.6-year orbit.',
    striking: 'Invisible but massive. With nothing falling in, it shows only through lensing. When its companion giant lines up behind it, the star’s light wraps into an Einstein ring.',
    facts: [['Companion', '0.76 M☉ metal-poor giant, 4.9 R☉, 5,200 K'], ['Orbit', '11.6 yr, e = 0.73, a = 16.2 AU'], ['Companion size from the hole', '0.16° across']],
    references: [
      { label: 'Gaia Collaboration (Panuzzo et al.) 2024, A&A 686, L2', url: 'https://doi.org/10.1051/0004-6361/202449763' }
    ],
    base: { massSolar: 32.7, spin: 0, diskEnabled: false, companion: true, companionTheta: 90, companionPhi: 180,
      companionRadius: 0.0813, companionTemp: 5212, diskTemp: 5212, diskBright: 6, background: 'milky-way', skyBright: 0.4, cinematic: true },
    views: [
      { name: 'Einstein ring', note: 'Companion directly behind the hole.',
        settings: { camR: 40, camTheta: 90, camPhi: 0, fov: 50, roll: 0 } },
      { name: 'Lensed Milky Way', note: 'Pure gravitational lensing of the sky.',
        settings: { camR: 30, camTheta: 70, camPhi: 40, fov: 70, roll: 0 } }
    ]
  },
  {
    id: 'cyg-x1', name: 'Cygnus X-1', kind: 'X-ray binary · first accepted', accent: '#8fb7ff',
    massSolar: 21.2, massText: '(21.2 ± 2.2) M☉', spin: 0.9985, spinText: '> 0.9985 (continuum fitting)',
    distanceText: '2.22 kpc · 7,200 light-years', distanceMeters: 2.22e3 * PARSEC,
    accretionText: '≈2% of Eddington, fed by the supergiant’s wind',
    summary: 'The first source widely accepted as a black hole. It orbits the blue supergiant HDE 226868 every 5.6 days.',
    striking: 'A near-extremal spin and a giant neighbour. The disk reaches the innermost stable orbit at ~1.2 M and glows at ~10⁷ K, so it looks blue-white in visible light. From the hole, the 22 R☉ companion fills about 50° of the sky.',
    facts: [['Companion', 'HDE 226868, O9.7 Iab, 40.6 M☉, 22 R☉, 31,000 K'], ['Separation', '0.24 AU (1.2 × 10⁶ M)'], ['Disk colour temperature', `${cygTemp.toExponential(2)} K`]],
    references: [
      { label: 'Miller-Jones et al. 2021, Science 371, 1046', url: 'https://doi.org/10.1126/science.abb3363' },
      { label: 'Zhao et al. 2021, ApJ 908, 117', url: 'https://doi.org/10.3847/1538-4357/abbcd6' }
    ],
    base: { massSolar: 21.2, spin: 0.9985, diskTemp: cygTemp, diskColorCorrection: cyg.correction, diskOuter: 30, diskThick: 0.22, diskFlare: 0.02, diskNoise: 0.5,
      diskBright: 4, companion: true, companionTheta: 104, companionPhi: 210, companionRadius: 25.03, companionTemp: 31000,
      background: 'milky-way', skyBright: 0.12, thin: true, photosphere: true, cinematic: true },
    views: [
      { name: 'Shadow on a supergiant', note: 'The hole silhouetted against HDE 226868, disk in front.',
        settings: { camR: 55, camTheta: 76, camPhi: 30, fov: 64, roll: -4 } },
      { name: 'Extremal spin', note: 'Close to the ISCO at 1.2 M.',
        settings: { camR: 12, camTheta: 72, camPhi: 330, fov: 74, roll: -10 } }
    ]
  },
  {
    id: 'v404-cyg', name: 'V404 Cygni', kind: 'X-ray binary · outbursts', accent: '#ff9a7a',
    massSolar: 9.0, massText: '9.0 (+0.2, −0.6) M☉', spin: 0.92, spinText: '≳0.92 (reflection fits, uncertain)',
    distanceText: '2.39 kpc · 7,800 light-years', distanceMeters: 2.39e3 * PARSEC,
    accretionText: 'Outburst at ≈50% of Eddington or more (2015)',
    summary: 'A low-mass X-ray binary that wakes violently every few decades. Its 2015 outburst was one of the brightest X-ray events ever recorded.',
    striking: 'Violence. In outburst the disk swells into a thick, turbulent, flaring flow near the Eddington limit. A jet precessing on minute timescales hinted at a disk tilted from the spin axis. The K-type companion fills about 22° of the sky.',
    facts: [['Companion', 'K3 III, 0.75 M☉, 6 R☉, 4,600 K'], ['Orbit', '6.47 days, 0.15 AU'], ['Inclination', '67°']],
    references: [
      { label: 'Khargharia, Froning & Robinson 2010, ApJ 716, 1105', url: 'https://doi.org/10.1088/0004-637X/716/2/1105' },
      { label: 'Miller-Jones et al. 2019, Nature 569, 374', url: 'https://doi.org/10.1038/s41586-019-1152-0' }
    ],
    base: { massSolar: 9, spin: 0.92, diskTemp: v404Temp, diskColorCorrection: v404.correction, diskOuter: 26, diskThick: 1.6, diskFlare: 0.08, diskNoise: 0.95,
      diskBright: 4, companion: true, companionTheta: 100, companionPhi: 222, companionRadius: 11.08, companionTemp: 4570,
      background: 'milky-way', skyBright: 0.12, thin: true, photosphere: true, cinematic: true },
    views: [
      { name: '2015 outburst', note: 'A thick, flaring near-Eddington disk at 67°.',
        settings: { camR: 48, camTheta: 67, camPhi: 20, fov: 52, roll: 0 } },
      { name: 'Companion view', note: 'The K giant beyond the swollen disk.',
        settings: { camR: 40, camTheta: 84, camPhi: 330, fov: 70, roll: -3 } }
    ]
  },
  {
    id: 'gaia-bh1', name: 'Gaia BH1', kind: 'Dormant · nearest known', accent: '#fff1c4',
    massSolar: 9.62, massText: '(9.62 ± 0.18) M☉', spin: 0, spinText: 'unknown (shown as 0)',
    distanceText: '480 pc · 1,560 light-years', distanceMeters: 480 * PARSEC,
    accretionText: 'None detected: dormant',
    summary: 'The nearest known black hole, found from the astrometric orbit of a Sun-like star in a 185.6-day orbit.',
    striking: 'A dark neighbour with a sun. Without accretion it is visible only through lensing. Line its companion up behind it and the star becomes a ring of light.',
    facts: [['Companion', 'G dwarf, 0.93 M☉, 0.99 R☉, 5,850 K'], ['Orbit', '185.6 days, e = 0.45, a = 1.4 AU'], ['Companion size from the hole', '0.38° across']],
    references: [
      { label: 'El-Badry et al. 2023, MNRAS 518, 1057', url: 'https://doi.org/10.1093/mnras/stac3140' }
    ],
    base: { massSolar: 9.62, spin: 0, diskEnabled: false, companion: true, companionTheta: 90, companionPhi: 180,
      companionRadius: 0.1884, companionTemp: 5850, diskTemp: 5850, diskBright: 6, background: 'milky-way', skyBright: 0.4, cinematic: true },
    views: [
      { name: 'Einstein ring', note: 'The Sun-like companion directly behind.',
        settings: { camR: 40, camTheta: 90, camPhi: 0, fov: 50, roll: 0 } },
      { name: 'Off axis', note: 'Slightly misaligned: two lensed images of the star.',
        settings: { camR: 40, camTheta: 86, camPhi: 6, fov: 50, roll: 0 } }
    ]
  }
];

export function findBlackHole(id: string): BlackHoleEntry | undefined {
  return BLACK_HOLES.find(entry => entry.id === id);
}
