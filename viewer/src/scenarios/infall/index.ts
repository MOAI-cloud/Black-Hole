import * as THREE from 'three';
import { distance, duration, gravitationalRadius, scientific, timeUnit, C } from '../../astro';
import { BLACK_HOLES } from '../../blackHoles';
import { blackbodyColor } from '../../emissionTextures';
import { PlotStrip, type Panel } from '../plot';
import type { Scenario, ScenarioFactory } from '../types';
import {
  integrateInfall, outgoingRedshift, sampleAtProperTime, sampleAtTime, zamoVelocity,
  type InfallSample, type InfallTrack
} from './geodesic';

type View = 'distant' | 'ride';

interface Options {
  hole: string;
  spin: number;
  massSolar: number;
  radius: number;
  theta: number;
  angular: number;
  bodyRadius: number;
  bodyTemp: number;
  beacon: number;
  view: View;
  disk: boolean;
}

const TRACK_SAMPLES = 2048;
const rad = Math.PI / 180;
const gravity = 9.80665;

// Kerr tortoise coordinate for radial null rays: d(r*)/dr = (r² + a²)/Δ.
function tortoise(r: number, a: number): number {
  const root = Math.sqrt(Math.max(0, 1 - a * a)), plus = 1 + root, minus = 1 - root;
  if (root < 1e-6) return r + 2 * Math.log(Math.max(1e-300, r - 1)) - 2 / (r - 1);
  return r + 2 * plus / (plus - minus) * Math.log(Math.max(1e-300, (r - plus) / 2))
           - 2 * minus / (plus - minus) * Math.log(Math.max(1e-300, (r - minus) / 2));
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export const createInfallScenario: ScenarioFactory = context => {
  const kerr = context.kerr;
  const sgr = BLACK_HOLES.find(entry => entry.id === 'sgr-a')!;
  const options: Options = {
    hole: sgr.id, spin: 0.6, massSolar: sgr.massSolar, radius: 12, theta: 90, angular: 0,
    bodyRadius: 0.55, bodyTemp: 6500, beacon: 4, view: 'distant', disk: false
  };
  let track: InfallTrack = integrateInfall({ spin: options.spin, radius: options.radius, theta: options.theta, angularMomentum: options.angular });
  let loopTime = 0, startTime = 0;
  let lastDrawn = -Infinity, lastPose = -Infinity;

  // --- Body track texture and Kerr program ------------------------------
  const data = new Float32Array(TRACK_SAMPLES * 3 * 4);
  const texture = new THREE.DataTexture(data, TRACK_SAMPLES, 3, THREE.RGBAFormat, THREE.FloatType);
  texture.minFilter = texture.magFilter = THREE.NearestFilter;
  const uniforms = {
    bodyTrack: { value: texture },
    bodyTrackSpan: { value: new THREE.Vector3(1, TRACK_SAMPLES, 0) },
    bodyLook: { value: new THREE.Vector4(options.bodyRadius, options.bodyTemp, 2, options.beacon) },
    bodyVisible: { value: true },
    observerBoost: { value: new THREE.Vector4(0, 0, 0, 0) }
  };
  const material = kerr.createMaterial({ INFALL: 1 }, uniforms);

  function uploadTrack() {
    const last = track.outside[track.outside.length - 1];
    const span = Math.max(1, last.t);
    for (let i = 0; i < TRACK_SAMPLES; i++) {
      const s = sampleAtTime(track, span * i / (TRACK_SAMPLES - 1));
      data.set([s.r, s.mu, s.phi, s.tau], 4 * i);
      data.set([s.ut, s.ur, s.uth, s.uphi], 4 * (TRACK_SAMPLES + i));
      data.set([s.stretch[0], s.stretch[1], s.stretch[2], 0], 4 * (2 * TRACK_SAMPLES + i));
    }
    texture.needsUpdate = true;
    uniforms.bodyTrackSpan.value.set(span, TRACK_SAMPLES, track.horizonOmega);
  }

  function updateLook() {
    // Emission scale: the body at rest has twice the disk's reference radiance.
    const reference = blackbodyColor(kerr.settings().diskTemp).log2Y;
    const scale = 2 * 2 ** (reference - blackbodyColor(options.bodyTemp).log2Y);
    uniforms.bodyLook.value.set(options.bodyRadius, options.bodyTemp, scale, options.beacon);
  }

  // Observer time at which the distant camera receives light emitted at t.
  const cameraRadius = () => Math.max(kerr.settings().camR, track.horizon + 1);
  const receptionTime = (s: InfallSample) => s.t - tortoise(s.r, options.spin) + tortoise(cameraRadius(), options.spin);
  /** Emission event whose light the distant camera receives at observer time T. */
  function seenAt(T: number): InfallSample {
    const s = track.outside;
    if (T <= receptionTime(s[0])) return { ...s[0], t: T - tortoise(cameraRadius(), options.spin) + tortoise(s[0].r, options.spin) };
    let lo = 0, hi = s.length - 1;
    if (T >= receptionTime(s[hi])) {
      // Beyond the tabulated track the body hugs the horizon: r* ≈ r*(r_last).
      return sampleAtTime(track, T - tortoise(cameraRadius(), options.spin) + tortoise(s[hi].r, options.spin));
    }
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (receptionTime(s[mid]) <= T) lo = mid; else hi = mid;
    }
    const a = receptionTime(s[lo]), b = receptionTime(s[hi]);
    return sampleAtTime(track, s[lo].t + (T - a) / (b - a) * (s[hi].t - s[lo].t));
  }

  // --- Plots ---------------------------------------------------------------
  const plot = new PlotStrip(context.plots, 'Radius, received redshift and tidal acceleration of the falling body');
  let radiusPanel: Panel, lightPanel: Panel, tidalPanel: Panel;
  function buildPlots() {
    const out = track.outside, inside = track.inside;
    const tauEnd = inside.length ? inside[inside.length - 1].tau : track.crossingTau;
    const tMax = Math.max(tauEnd * 1.6, track.crossingTau + 40);
    const cut = out.filter(s => s.t <= tMax);
    radiusPanel = {
      title: 'Radius: distant clock vs the body’s own clock', xLabel: 'time (M)', yLabel: 'r (M)',
      x: [0, tMax], y: [0, options.radius * 1.04],
      series: [
        { x: cut.map(s => s.t), y: cut.map(s => s.r), color: '#ffad69', label: 'coordinate time t' },
        { x: [...out.map(s => s.tau), ...inside.map(s => s.tau)], y: [...out.map(s => s.r), ...inside.map(s => s.r)],
          color: '#8fb7ff', label: 'proper time τ' }
      ],
      horizontal: [{ value: track.horizon, color: '#93c9a9', label: 'horizon' }],
      note: Number.isFinite(track.crossingTau) ? `crosses at τ = ${track.crossingTau.toFixed(1)} M` : undefined
    };
    const start = receptionTime(out[0]);
    const span = Math.max(80, (receptionTime(out[out.length - 1]) - start) * 1.15 + 40);
    const times: number[] = [], shifts: number[] = [];
    for (let i = 0; i <= 600; i++) {
      const T = start - 5 + span * i / 600;
      times.push(T - start);
      shifts.push(outgoingRedshift(track, seenAt(T)));
    }
    loopTime = start + span;
    startTime = start - 5;
    lightPanel = {
      title: 'Light received far away: frequency ratio g', xLabel: 'observer time since release seen (M)', yLabel: 'g',
      x: [-5, span], y: [1e-4, 1.5], logY: true,
      series: [{ x: times, y: shifts, color: '#ffcf70', label: 'outgoing light' },
        { x: [span * .45, span], y: [1e-1, 1e-1 * Math.exp(-track.surfaceGravity * span * .55)], color: '#ffffff40', dashed: true, label: 'e^(−κ t)' }],
      note: `κ = ${track.surfaceGravity.toFixed(4)} / M`
    };
    const rg = gravitationalRadius(options.massSolar);
    const radii = cut.map(s => s.r), tides = cut.map(s => Math.abs(s.tidal[0]) * 2 * C * C / (rg * rg) / gravity);
    const top = Math.max(...tides), bottom = Math.min(...tides);
    tidalPanel = {
      title: 'Tidal stretch across a 2 m body', xLabel: 'r (M)', yLabel: 'Δa (g)',
      x: [options.radius * 1.02, track.horizon * .9], y: [Math.min(bottom, 1e-3) / 3, Math.max(top, 1e3) * 3], logY: true,
      series: [{ x: radii, y: tides, color: '#ff8a7a', label: options.hole === 'custom' ? 'this mass' : BLACK_HOLES.find(h => h.id === options.hole)?.name ?? '' }],
      horizontal: [{ value: 1, color: '#93c9a9', label: '1 g' }, { value: 100, color: '#ff8a7a80', label: 'lethal ≈ 100 g' }],
      vertical: [{ value: track.horizon, color: '#93c9a9', label: 'horizon' }]
    };
  }

  // --- Controls --------------------------------------------------------------
  const controls = context.controls;
  controls.replaceChildren();
  const holeSection = element('section', 'panel-section');
  holeSection.append(element('h3', undefined, 'Black hole'));
  const holeRow = element('label', 'select-row');
  const holeSelect = element('select');
  for (const entry of BLACK_HOLES) holeSelect.add(new Option(`${entry.name} · ${scientific(entry.massSolar, 2)} M☉`, entry.id));
  holeSelect.value = options.hole;
  holeRow.append(element('span', undefined, 'Mass for units'), holeSelect);
  holeSection.append(holeRow);
  const sliders = element('div', 'control-stack');
  holeSection.append(sliders);
  const motion = element('section', 'panel-section');
  motion.append(element('h3', undefined, 'Release'));
  const motionSliders = element('div', 'control-stack');
  motion.append(motionSliders);
  const bodySection = element('section', 'panel-section');
  bodySection.append(element('h3', undefined, 'Falling body'));
  const bodySliders = element('div', 'control-stack');
  bodySection.append(bodySliders);
  const viewSection = element('section', 'panel-section');
  viewSection.append(element('h3', undefined, 'Observer'));
  const viewRow = element('label', 'select-row');
  const viewSelect = element('select');
  viewSelect.add(new Option('Distant camera', 'distant'));
  viewSelect.add(new Option('Ride along', 'ride'));
  viewRow.append(element('span', undefined, 'View'), viewSelect);
  const diskRow = element('label', 'toggle-row');
  const diskToggle = element('input');
  diskToggle.type = 'checkbox';
  diskToggle.setAttribute('role', 'switch');
  diskRow.append(element('span', undefined, 'Accretion disk'), diskToggle);
  const release = element('button', 'outline wide', 'Release again');
  release.type = 'button';
  viewSection.append(viewRow, diskRow, release);
  const notes = element('section', 'panel-section');
  notes.append(element('h3', undefined, 'Physics'), element('p', undefined,
    'The body follows an exact Kerr timelike geodesic, integrated in Mino time through the horizon. ' +
    'Each pixel samples it at that ray’s retarded emission time, so the camera sees light-travel delay, ' +
    'Doppler and gravitational shift (T_seen = g T) and the image freezing at the horizon, fading as e^(−κu). ' +
    'The beacon flashes at fixed intervals of the body’s proper time. Tidal deformation solves the geodesic-' +
    'deviation equation with the Kerr tidal eigenvalues for dust. The Ride along view boosts the camera to the ' +
    'body’s velocity: aberration and Doppler shift of the sky. Boyer–Lindquist time stops at the horizon, so ' +
    'the ride ends just outside it.'));
  controls.append(holeSection, motion, bodySection, viewSection, notes);

  const rebuildFns: Array<() => void> = [];
  function slider(host: HTMLElement, label: string, min: number, max: number, step: number, digits: number, unit: string,
                  read: () => number, write: (v: number) => void) {
    const row = element('label', 'range-row');
    const value = element('output', 'range-value');
    const range = element('input');
    range.type = 'range';
    Object.assign(range, { min, max, step });
    row.append(element('span', 'range-label', label), value, range);
    host.append(row);
    const render = () => {
      const v = read();
      value.textContent = v.toFixed(digits) + unit;
      range.value = String(v);
      range.style.setProperty('--fill', 100 * (v - min) / (max - min) + '%');
    };
    range.addEventListener('input', () => { write(range.valueAsNumber); render(); });
    range.addEventListener('change', () => restart());
    rebuildFns.push(render);
    render();
  }
  slider(sliders, 'Spin a/M', 0, 0.998, 0.001, 3, '', () => options.spin, v => { options.spin = v; });
  slider(motionSliders, 'Release radius', 4, 40, 0.5, 1, ' M', () => options.radius, v => { options.radius = v; });
  slider(motionSliders, 'Release inclination', 30, 150, 1, 0, '°', () => options.theta, v => { options.theta = v; });
  slider(motionSliders, 'Angular momentum', 0, 0.95, 0.01, 2, '× circular', () => options.angular, v => { options.angular = v; });
  slider(bodySliders, 'Body radius', 0.2, 2, 0.05, 2, ' M', () => options.bodyRadius, v => { options.bodyRadius = v; });
  slider(bodySliders, 'Surface temperature', 2500, 15000, 100, 0, ' K', () => options.bodyTemp, v => { options.bodyTemp = v; });
  slider(bodySliders, 'Beacon period', 1, 20, 0.5, 1, ' M (proper)', () => options.beacon, v => { options.beacon = v; });

  holeSelect.addEventListener('change', () => {
    const entry = BLACK_HOLES.find(candidate => candidate.id === holeSelect.value)!;
    options.hole = entry.id;
    options.massSolar = entry.massSolar;
    options.spin = Math.min(0.998, entry.spin);
    restart();
  });
  viewSelect.addEventListener('change', () => { options.view = viewSelect.value as View; restart(); });
  diskToggle.addEventListener('change', () => {
    options.disk = diskToggle.checked;
    kerr.updateSettings({ diskEnabled: options.disk });
    context.requestRedraw();
  });
  release.addEventListener('click', () => restart());

  // --- Readouts --------------------------------------------------------------
  const readouts = context.readouts;
  readouts.replaceChildren();
  const lines = Array.from({ length: 6 }, () => readouts.appendChild(element('div', 'readout-line')));
  function setLine(i: number, label: string, value: string) {
    const line = lines[i];
    if (line.dataset.text === label + value) return;
    line.dataset.text = label + value;
    line.replaceChildren(element('span', undefined, label), element('strong', undefined, value));
  }

  function restart() {
    track = integrateInfall({ spin: options.spin, radius: options.radius, theta: options.theta, angularMomentum: options.angular });
    uploadTrack();
    updateLook();
    for (const render of rebuildFns) render();
    holeSelect.value = options.hole;
    viewSelect.value = options.view;
    diskToggle.checked = options.disk;
    kerr.updateSettings({ spin: options.spin, diskEnabled: options.disk, emission: 'thermal', companion: false });
    uniforms.bodyVisible.value = options.view === 'distant';
    buildPlots();
    lastPose = -Infinity;
    context.setTime(options.view === 'ride' ? 0 : startTime);
    if (context.isPaused()) context.setPaused(false);
    context.requestRedraw();
  }

  function physical(m: number) { return duration(m * timeUnit(options.massSolar)); }

  function frame(T: number) {
    const ride = options.view === 'ride';
    let state: InfallSample;
    let seen: InfallSample | null = null;
    if (ride) {
      // The observer clock is the rider's proper time. Stop just outside r+.
      const limit = sampleAtProperTime(track, Infinity);
      let tau = T;
      state = sampleAtProperTime(track, tau);
      const floor = track.horizon + 0.03;
      if (state.r < floor) {
        let lo = 0, hi = limit.tau;
        for (let i = 0; i < 40; i++) {
          const mid = .5 * (lo + hi);
          if (sampleAtProperTime(track, mid).r > floor) lo = mid; else hi = mid;
        }
        tau = lo;
        state = sampleAtProperTime(track, tau);
        if (!context.isPaused()) context.setPaused(true);
      }
      if (Math.abs(tau - lastPose) > 1e-6) {
        lastPose = tau;
        kerr.updateSettings({
          camR: state.r, camTheta: Math.acos(Math.max(-1, Math.min(1, state.mu))) / rad,
          camPhi: ((state.phi / rad) % 360 + 360) % 360
        }, true);
      }
    } else {
      state = sampleAtTime(track, Math.max(0, T));
      seen = seenAt(T);
      if (T > loopTime && !context.isPaused()) context.setTime(startTime);
    }
    const tauNow = ride ? state.tau : Math.min(state.tau, track.crossingTau);
    setLine(0, ride ? 'Your clock τ' : 'Body clock τ', `${tauNow.toFixed(1)} M · ${physical(tauNow)}`);
    setLine(1, ride ? 'Outside time t' : 'Distant clock t', `${(ride ? state.t : T).toFixed(1)} M · ${physical(ride ? state.t : T)}`);
    setLine(2, 'Radius', `${state.r.toFixed(3)} M · ${distance(state.r * gravitationalRadius(options.massSolar))}`);
    if (ride) {
      const v = zamoVelocity(track, state);
      setLine(3, 'Speed vs local ZAMO', `${Math.hypot(v.vr, v.vth, v.vphi).toFixed(3)} c · γ ${v.gamma.toFixed(2)}`);
    } else {
      const g = outgoingRedshift(track, seen!);
      setLine(3, 'Light seen now', g > 1e-4 ? `g = ${g.toFixed(3)} · z = ${(1 / g - 1).toFixed(2)}` : 'g < 10⁻⁴ (frozen, faded)');
    }
    const rg = gravitationalRadius(options.massSolar);
    const tide = Math.abs(state.tidal[0]) * 2 * C * C / (rg * rg);
    setLine(4, 'Tidal stretch on 2 m', `${scientific(tide / gravity, 2)} g`);
    setLine(5, 'Dust-cloud stretch', `× ${state.stretch[0].toFixed(2)} radial · × ${state.stretch[2].toFixed(2)} across`);
    if (Math.abs(T - lastDrawn) > 0.05 || context.isPaused()) {
      lastDrawn = T;
      const cursorTau = Math.min(tauNow, track.crossingTau);
      radiusPanel.points = [{ x: ride ? state.t : T, y: state.r, color: '#ffad69' }, { x: cursorTau, y: state.r, color: '#8fb7ff' }];
      lightPanel.vertical = ride ? [] : [{ value: T - startTime - 5, color: '#ffffff60' }];
      lightPanel.points = ride || !seen ? [] : [{ x: T - startTime - 5, y: outgoingRedshift(track, seen), color: '#ffcf70' }];
      tidalPanel.points = [{ x: state.r, y: tide / gravity, color: '#ff8a7a' }];
      plot.draw([radiusPanel, lightPanel, tidalPanel]);
    }
  }

  const program = {
    material,
    update(timeM: number) {
      if (options.view !== 'ride') {
        uniforms.observerBoost.value.set(0, 0, 0, 0);
        return;
      }
      // The camera event's Boyer–Lindquist time and its velocity relative to the local ZAMO.
      const s = sampleAtProperTime(track, Math.max(0, Math.min(timeM, lastPose)));
      const timeUniform = material.uniforms.timeM;
      timeUniform.value = s.t;
      const v = zamoVelocity(track, s);
      const sinTheta = Math.sqrt(Math.max(0, 1 - s.mu * s.mu)), cos = Math.cos(s.phi), sin = Math.sin(s.phi);
      const radial = [sinTheta * cos, s.mu, -sinTheta * sin];
      const polar = [s.mu * cos, -sinTheta, -s.mu * sin];
      const orbital = [-sin, 0, -cos];
      const beta = [0, 1, 2].map(i => v.vr * radial[i] + v.vth * polar[i] + v.vphi * orbital[i]);
      uniforms.observerBoost.value.set(beta[0], beta[1], beta[2], v.gamma);
    },
    dispose() {
      material.dispose();
      texture.dispose();
    }
  };

  kerr.updateSettings({ emission: 'thermal', companion: false, diskEnabled: options.disk, spin: options.spin, cinematic: true,
    skyBright: Math.max(kerr.settings().skyBright, 0.55), diskTemp: 5600, diskBright: 4 });
  uploadTrack();
  updateLook();
  buildPlots();
  queueMicrotask(() => context.setTime(startTime));

  const scenario: Scenario = {
    id: 'infall',
    title: 'Falling into a black hole',
    program,
    camera: { camR: 27, camTheta: 76, camPhi: 58, fov: 44, roll: 0 },
    playbackRate: 6,
    frame,
    dispose() {
      plot.dispose();
      program.dispose();
      controls.replaceChildren();
      readouts.replaceChildren();
    }
  };
  return scenario;
};
