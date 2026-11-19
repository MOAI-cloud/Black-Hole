import './styles.css';
import { SKIES, loadSkyTexture, type SkyId } from './skies';
import { setupOrbitReadout } from './orbitReadout';
import { BlackHoleScene, type LensingModel } from './BlackHoleScene';
import { byId, buildInspector, showInspectorTabs } from './controls';
import { BLACK_HOLES, findBlackHole } from './blackHoles';
import { buildCatalogStrip, renderObjectPanel } from './catalogPanel';
import { SCENARIOS } from './scenarios/registry';
import type { Scenario, ScenarioContext } from './scenarios/types';
import { fitImage, setupCaptures } from './captures';
import { mountIcons, icon } from './icons';
import { connectGamepad } from './gamepad';
import { getHealth, refineView } from './renderApi';
import { DEFAULT_SETTINGS, type RenderSettings, type RenderMode } from './types';

const settings: RenderSettings = { ...DEFAULT_SETTINGS };
const canvas = byId<HTMLCanvasElement>('sceneCanvas');
const viewport = byId('viewport');
const autoPreview = byId<HTMLInputElement>('autoPreview');
const quality = byId<HTMLSelectElement>('quality');
const lensing = byId<HTMLSelectElement>('lensingModel');
const skySelect = byId<HTMLSelectElement>('skySelect');
const playback = byId<HTMLSelectElement>('playbackRate');
const loader = document.querySelector<HTMLElement>('gargantua-loader');
const refinedFrame = byId<HTMLImageElement>('refinedFrame');
const title = byId('viewTitle');
const notice = byId('sceneNotice');
const pause = byId<HTMLButtonElement>('pauseButton');
const orbit = byId<HTMLButtonElement>('orbitButton');
const focus = byId<HTMLButtonElement>('focusButton');
const help = byId<HTMLDialogElement>('helpDialog');
const subtitle = byId('viewSubtitle');

type Mode = 'sandbox' | 'catalog' | 'scenarios';
let mode: Mode = 'sandbox';
let sandboxSettings: RenderSettings | null = null;
let activeObject = BLACK_HOLES[0].id;
let activeView = 0;
let scenario: Scenario | null = null;
let scenarioId = SCENARIOS[0]?.id ?? '';
let scenarioRequest = 0;

const presets = [
  { name: 'Equatorial orbit', image: 'equatorial', camR: DEFAULT_SETTINGS.camR, camTheta: DEFAULT_SETTINGS.camTheta, camPhi: DEFAULT_SETTINGS.camPhi, fov: DEFAULT_SETTINGS.fov, roll: DEFAULT_SETTINGS.roll },
  { name: 'Polar orbit', image: 'polar', camR: 56, camTheta: 14, camPhi: 80, fov: 46, roll: 0 },
  { name: 'Inner orbit', image: 'inner', camR: 14, camTheta: 73, camPhi: 212, fov: 70, roll: -11 },
  { name: 'Wide field', image: 'wide', camR: 89, camTheta: 63, camPhi: 138, fov: 43, roll: 3 }
];
const presetButtons: HTMLButtonElement[] = [];
let selectedPreset = 0;
let scene: BlackHoleScene | undefined;
let paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
let autoOrbit = false;
let contextLost = false;
let refineTimer = 0;
let refineRequest: AbortController | null = null;
let stillUrl: string | null = null;
let stillBlob: Blob | null = null;
let stillTime = 0;
let legacyRenderer = false;
let refining = false;
let telemetryFrame = 0;
let lastFps = '— FPS';
let liveModel: LensingModel = 'kerr';
let slowWindows = 0;

mountIcons();

function refreshState() {
  const live = !!scene && !contextLost;
  const still = !!stillUrl;
  byId('liveLabel').textContent = still ? (refining ? 'Refining Kerr still' : 'Kerr still') : !live ? 'Reference still' : paused ? 'Paused' : 'Live viewport';
  byId('liveTag').classList.toggle('still', !live || still || paused);
  byId('engineLabel').textContent = still ? 'CUDA · Kerr geodesics' : refining ? 'Tracing Kerr refinement…' :
    live ? (scenario ? `WebGL 2 · ${scenario.title}` : settings.emission === 'synchrotron'
      ? `WebGL 2 · Kerr geodesics · ${settings.observeGHz} GHz synchrotron`
      : liveModel === 'kerr' ? 'WebGL 2 · Kerr geodesics' : 'WebGL 2 · Schwarzschild lensing') : 'Reference image · CUDA render';
  byId('fps').textContent = live && !still && !paused ? lastFps : '— FPS';
  pause.disabled = orbit.disabled = !live;
  byId<HTMLButtonElement>('stepBack').disabled = byId<HTMLButtonElement>('stepForward').disabled = !live;
  const stopped = paused || still;
  pause.setAttribute('aria-pressed', String(stopped));
  pause.title = stopped ? 'Resume animation (Space)' : 'Pause animation (Space)';
  pause.setAttribute('aria-label', pause.title);
  pause.innerHTML = icon(stopped ? 'play' : 'pause');
  orbit.setAttribute('aria-pressed', String(autoOrbit));
  byId<HTMLButtonElement>('snapshotButton').disabled = !live && !still;
}

function clearRefinement() {
  window.clearTimeout(refineTimer);
  refineRequest?.abort();
  refineRequest = null;
  refining = false;
  if (stillUrl) {
    if (!scene || contextLost) notice.hidden = false;
    refinedFrame.hidden = true;
    refinedFrame.removeAttribute('src');
    URL.revokeObjectURL(stillUrl);
    stillUrl = null;
    stillBlob = null;
    scene?.setPaused(paused);
  }
}

function observerTime() {
  return legacyRenderer ? 0 : stillUrl ? stillTime : scene?.getObserverTime() ?? 0;
}

function scheduleRefinement() {
  const hadRefinement = refining || !!stillUrl;
  clearRefinement();
  if (hadRefinement) refreshState();
  if (!autoPreview.checked || autoPreview.disabled || (autoOrbit && !paused) || document.hidden) return;
  // The native renderer traces the thermal disk; synchrotron and scenarios are WebGL-only.
  if (settings.emission !== 'thermal' || scenario) return;
  refineTimer = window.setTimeout(async () => {
    const request = new AbortController();
    refineRequest = request;
    refining = true;
    refreshState();
    const time = observerTime();
    const pose = { ...settings, shutter: 0 };
    const { clientWidth, clientHeight } = viewport;
    const display = async (mode: RenderMode, size: { width: number; height: number }, spp: number) => {
      const blob = await refineView({ ...pose, ...size, spp }, mode, time, request.signal);
      request.signal.throwIfAborted();
      const url = URL.createObjectURL(blob);
      try {
        const image = new Image();
        image.src = url;
        await image.decode();
        request.signal.throwIfAborted();
        const previous = stillUrl;
        stillUrl = url;
        stillBlob = blob;
        stillTime = time;
        refinedFrame.src = url;
        refinedFrame.hidden = false;
        notice.hidden = true;
        if (previous) URL.revokeObjectURL(previous);
        scene?.setPaused(true);
        refreshState();
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
    };
    try {
      await display('preview', fitImage(clientWidth, clientHeight, 960, 540), 1);
      if (quality.value !== 'performance') {
        const high = quality.value === 'high';
        const scale = high ? 2 : 1.5;
        const w = clientWidth * scale, h = clientHeight * scale;
        const long = high ? 3840 : 2560, short = high ? 2160 : 1440;
        const size = fitImage(w, h, w >= h ? long : short, w >= h ? short : long);
        await display('final', size, high ? 12 : 6);
      }
    } catch (error) {
      if (!request.signal.aborted) {
        autoPreview.checked = false;
        byId('healthStatus').textContent = error instanceof Error ? error.message : 'Kerr refinement failed.';
      }
    } finally {
      if (refineRequest === request) {
        refineRequest = null;
        refining = false;
        refreshState();
      }
    }
  }, 700);
}

function updateObserver() {
  byId('distance').textContent = settings.camR.toFixed(1);
  byId('inclination').textContent = settings.camTheta.toFixed(1) + '°';
  byId('azimuth').textContent = settings.camPhi.toFixed(1) + '°';
}

function nameView(index: number, freeViewName = 'Free orbit') {
  selectedPreset = index;
  presetButtons.forEach((button, i) => button.setAttribute('aria-pressed', String(index === i)));
  if (mode !== 'sandbox') return;
  title.textContent = index < 0 ? freeViewName : presets[index].name;
  subtitle.hidden = true;
}

const refreshControls = buildInspector(settings, camera => {
  if (camera) nameView(-1);
  scene?.setSettings(settings, { syncCamera: camera });
  refreshControls();
  updateObserver();
  scheduleRefinement();
});

function presetFov(verticalDegrees: number) {
  // Keep the complete preset composition visible when the viewport is narrow.
  const aspect = viewport.clientWidth / Math.max(1, viewport.clientHeight);
  const tangent = Math.tan(verticalDegrees * Math.PI / 360) * Math.max(1, 1.5 / Math.max(.1, aspect));
  return Math.min(95, 2 * Math.atan(tangent) * 180 / Math.PI);
}

function setPreset(index: number) {
  const { camR, camTheta, camPhi, fov, roll } = presets[index];
  Object.assign(settings, { camR, camTheta, camPhi, roll, fov: presetFov(fov) });
  nameView(index);
  scene?.setSettings(settings, { syncCamera: true });
  updateObserver();
  refreshControls(true);
  scheduleRefinement();
}

presets.forEach((preset, i) => {
  const button = document.createElement('button');
  button.className = 'preset';
  button.type = 'button';
  button.innerHTML = `<img src="/presets/${preset.image}.webp" alt="" /><span>${preset.name}</span><i>${icon('tick')}</i>`;
  button.title = `${preset.name} (${i + 1}) · ${preset.camR} M · ${preset.camTheta}°`;
  button.addEventListener('click', () => setPreset(i));
  byId('presetStrip').append(button);
  presetButtons.push(button);
});

settings.fov = presetFov(presets[0].fov);
function showReferenceStill(message: string) {
  clearRefinement();
  scene?.dispose();
  scene = undefined;
  canvas.hidden = true;
  lensing.disabled = playback.disabled = true;
  notice.textContent = message;
  notice.hidden = false;
  autoPreview.disabled = true;
  refreshState();
}

try {
  scene = new BlackHoleScene(canvas, settings, camera => {
    Object.assign(settings, camera);
    if (title.textContent !== 'Free orbit') nameView(-1);
    // Orbit damping emits multiple changes per gesture; update only camera readouts.
    if (!telemetryFrame) telemetryFrame = requestAnimationFrame(() => {
      telemetryFrame = 0;
      updateObserver();
      refreshControls(true);
    });
    scheduleRefinement();
  }, ({ fps, scale }) => {
    lastFps = Math.round(fps) + ' FPS';
    if (!paused && !stillUrl) byId('fps').textContent = lastFps;
    byId('fps').title = `${canvas.width} × ${canvas.height} · ${Math.round(scale * 100)}% viewport scale`;
    if (lensing.value === 'auto' && liveModel === 'kerr' && !paused && !stillUrl && !document.hidden) {
      slowWindows = fps < 30 ? slowWindows + 1 : 0;
      if (slowWindows >= 3) applyLensingModel('schwarzschild');
    }
  }, () => {
    showReferenceStill('The live shader is unavailable on this graphics device.');
    void updateHealth();
  });
  liveModel = scene.automaticModel;
  scene.setLensingModel(liveModel);
  scene.setPaused(paused);
  scene.setPlaybackRate(Number(playback.value));
} catch (error) {
  console.error('Could not initialize the live viewport.', error);
  showReferenceStill('WebGL 2 is unavailable. Enable graphics acceleration to explore this view.');
}
let skyRequest = 0;
for (const sky of SKIES) skySelect.add(new Option(sky.label, sky.id));

function showSkyInfo(id: SkyId) {
  const entry = SKIES.find(sky => sky.id === id)!;
  const thumb = byId<HTMLImageElement>('skyThumb');
  thumb.src = entry.thumbnail;
  const credit = byId('skyCredit');
  credit.replaceChildren();
  if (entry.source) {
    const source = document.createElement('a');
    source.href = entry.source;
    source.target = '_blank';
    source.rel = 'noreferrer';
    source.textContent = entry.credit;
    credit.append(source);
  } else {
    credit.textContent = entry.credit;
  }
}

async function selectSky(id: SkyId) {
  const request = ++skyRequest;
  skySelect.value = id;
  skySelect.setAttribute('aria-busy', 'true');
  try {
    if (scene) {
      const texture = await loadSkyTexture(id);
      if (request !== skyRequest) { texture.dispose(); return; }
      scene.setStarTexture(texture);
    }
    settings.background = id;
    showSkyInfo(id);
    scheduleRefinement();
  } catch {
    if (request !== skyRequest) return;
    skySelect.value = settings.background;
    showSkyInfo(settings.background);
    notice.textContent = 'Could not load this sky. Select it again to retry.';
    notice.hidden = false;
  } finally {
    if (request === skyRequest) skySelect.removeAttribute('aria-busy');
  }
}
skySelect.addEventListener('change', () => {
  if (scene && !contextLost) notice.hidden = true;
  void selectSky(skySelect.value as SkyId);
});
playback.addEventListener('change', () => {
  scene?.setPlaybackRate(Number(playback.value));
  if (scene && paused) togglePause();
  if (stillUrl || refining) {
    autoPreview.checked = false;
    scheduleRefinement();
  }
});
const disconnectReadout = setupOrbitReadout(settings, () => stillUrl ? stillTime : scene?.getObserverTime() ?? 0);

export const ready = (async () => {
  loader?.setAttribute('step', '6');
  loader?.setAttribute('message', 'Loading the sky map…');
  await selectSky(settings.background);
  loader?.setAttribute('step', '7');
  loader?.setAttribute('message', 'Drawing the first frame…');
  if (scene && !contextLost) {
    try {
      await scene.whenFrameReady();
    } catch (error) {
      if (scene) {
        console.error('Could not prepare the first live frame.', error);
        showReferenceStill('The live scene could not be loaded. Reload the viewer to retry.');
        void updateHealth();
      }
    }
  }
})();

nameView(0);
refreshControls();
updateObserver();
refreshState();

const captures = setupCaptures(settings, observerTime, async () => {
  if (stillBlob) return stillBlob;
  if (!scene || contextLost) throw new Error('The live viewport is unavailable.');
  return scene.capture();
});
byId<HTMLButtonElement>('snapshotButton').disabled = !scene;

function togglePause() {
  if (!scene || contextLost) return;
  if (stillUrl) {
    autoPreview.checked = false;
    paused = false;
  } else {
    paused = !paused;
  }
  scene.setPaused(paused);
  scheduleRefinement();
  refreshState();
}

function toggleOrbit() {
  if (!scene || contextLost) return;
  autoOrbit = !autoOrbit;
  if (autoOrbit) {
    paused = false;
    scene.setPaused(false);
  }
  scene.setAutoOrbit(autoOrbit);
  scheduleRefinement();
  refreshState();
}

function stepTime(delta: number) {
  if (!scene || contextLost) return;
  const time = stillUrl ? stillTime : scene.getObserverTime();
  paused = true;
  scene.setPaused(true);
  scene.setObserverTime(time + delta);
  scheduleRefinement();
  refreshState();
}

function toggleFocus() {
  const active = byId('app').classList.toggle('focus');
  focus.setAttribute('aria-pressed', String(active));
  focus.setAttribute('aria-label', active ? 'Exit focus view' : 'Focus view');
  focus.title = active ? 'Exit focus view (H)' : 'Focus view (H)';
  focus.innerHTML = icon(active ? 'collapse' : 'expand');
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await document.documentElement.requestFullscreen();
  } catch {
    toggleFocus();
  }
}

pause.addEventListener('click', togglePause);
byId('stepBack').addEventListener('click', () => stepTime(-5));
byId('stepForward').addEventListener('click', () => stepTime(5));
orbit.addEventListener('click', toggleOrbit);
focus.addEventListener('click', toggleFocus);
byId('fullscreenButton').addEventListener('click', () => void toggleFullscreen());
byId('helpButton').addEventListener('click', () => help.showModal());
byId('captureButton').addEventListener('click', openCapture);
function applyLensingModel(model: LensingModel) {
  liveModel = model;
  slowWindows = 0;
  scene?.setLensingModel(model);
  refreshState();
}
lensing.addEventListener('change', () => {
  applyLensingModel(lensing.value === 'auto' ? scene?.automaticModel ?? 'kerr'
    : lensing.value === 'schwarzschild' ? 'schwarzschild' : 'kerr');
  scheduleRefinement();
});
quality.addEventListener('change', () => {
  scene?.setQuality(quality.value as 'auto' | 'performance' | 'high');
  scheduleRefinement();
});
autoPreview.addEventListener('change', scheduleRefinement);
canvas.addEventListener('webglcontextlost', () => {
  contextLost = true;
  clearRefinement();
  canvas.style.visibility = 'hidden';
  notice.textContent = 'Graphics context interrupted. Waiting for the viewport to recover…';
  notice.hidden = false;
  refreshState();
});
canvas.addEventListener('webglcontextrestored', () => {
  contextLost = false;
  canvas.style.visibility = '';
  notice.hidden = true;
  refreshState();
  scheduleRefinement();
});
const resizeObserver = new ResizeObserver(() => {
  if (mode === 'sandbox' && selectedPreset >= 0) {
    const next = presetFov(presets[selectedPreset].fov);
    if (Math.abs(next - settings.fov) > .01) {
      settings.fov = next;
      scene?.setSettings(settings, { syncCamera: true });
      refreshControls(true);
    }
  }
  scheduleRefinement();
});
resizeObserver.observe(viewport);
document.addEventListener('visibilitychange', scheduleRefinement);

const referenceScene = byId<HTMLSelectElement>('referenceScene');
referenceScene.addEventListener('change', () => {
  if (!referenceScene.value) return;
  const film = referenceScene.value === 'film';
  Object.assign(settings, {
    spin: film ? .5 : .99, camR: film ? 66 : 62, camTheta: film ? 86.5 : 85, camPhi: film ? 52 : 128,
    fov: presetFov(film ? 27 : 45), roll: film ? -1 : 0,
    diskTemp: film ? 5400 : 12000, diskBright: film ? 10 : 8, diskThick: film ? .25 : .5,
    diskOuter: film ? 25 : 22, diskNoise: film ? .65 : .55, diskFlare: film ? .025 : .045, diskAbsorb: .4, skyBright: film ? .075 : 1.2, exposure: 1,
    noDoppler: false, noRedshift: false, thin: film, photosphere: film, staticDiskPattern: false, diskModel: 'nt', cinematic: film
  });
  referenceScene.value = '';
  nameView(-1, film ? 'Film-inspired' : 'High-spin orbit');
  scene?.setSettings(settings, { syncCamera: true });
  updateObserver();
  refreshControls();
  scheduleRefinement();
});

byId('resetButton').addEventListener('click', () => {
  setMode('sandbox');
  const previousSky = settings.background;
  Object.assign(settings, DEFAULT_SETTINGS, { background: previousSky });
  void selectSky(DEFAULT_SETTINGS.background);
  playback.value = '12';
  scene?.setPlaybackRate(12);
  autoOrbit = false;
  paused = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  autoPreview.checked = !scene && !autoPreview.disabled;
  quality.value = 'auto';
  lensing.value = 'auto';
  applyLensingModel(scene?.automaticModel ?? 'kerr');
  scene?.setQuality('auto');
  scene?.setAutoOrbit(false);
  scene?.setPaused(paused);
  scene?.setObserverTime(0);
  setPreset(0);
  captures.syncDimensions();
  refreshControls();
  refreshState();
});

for (const dialog of document.querySelectorAll('dialog')) {
  dialog.querySelector('[data-close]')!.addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
  });
}
document.addEventListener('keydown', event => {
  if (event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.defaultPrevented || document.querySelector('dialog[open]')) return;
  const target = event.target as HTMLElement;
  if (target.closest('input,select,textarea,[contenteditable="true"]')) return;
  const key = event.key.toLowerCase();
  if (key === ' ' && target.closest('button,a,summary')) return;
  if (/^[1-4]$/.test(key)) { if (mode !== 'sandbox') return; setPreset(Number(key) - 1); }
  else if (key === ' ') togglePause();
  else if (key === '[' || key === ']') stepTime(key === '[' ? -5 : 5);
  else if (key === 'o') toggleOrbit();
  else if (key === 'h' || (key === 'escape' && byId('app').classList.contains('focus'))) toggleFocus();
  else if (key === 'f') void toggleFullscreen();
  else if (key === 'c') openCapture();
  else if (key === '?') help.showModal();
  else return;
  event.preventDefault();
});

const disconnectGamepad = connectGamepad({
  enabled: () => !!scene && !contextLost,
  move: (azimuth, inclination, zoom) => {
    settings.camPhi = (settings.camPhi + azimuth + 360) % 360;
    settings.camTheta = Math.min(179, Math.max(1, settings.camTheta + inclination));
    settings.camR = Math.min(1000, Math.max(4, settings.camR * zoom));
    if (title.textContent !== 'Free orbit') nameView(-1);
    scene?.setSettings(settings, { syncCamera: true });
    refreshControls(true);
    updateObserver();
    scheduleRefinement();
  },
  action: action => {
    if (action === 'focus') toggleFocus();
    else if (action === 'pause') togglePause();
    else if (mode === 'sandbox') setPreset((selectedPreset + 1) % presets.length);
  }
});

async function updateHealth() {
  try {
    const health = await getHealth();
    legacyRenderer = !!health.legacy;
    const available = health.rendererAvailable;
    const message = health.rendererMessage || (available ? 'CUDA renderer ready.' : 'CUDA renderer unavailable.');
    byId('healthStatus').textContent = message;
    captures.setAvailability(available, message);
    const nativeFallback = !scene && available && autoPreview.disabled;
    autoPreview.disabled = !available;
    if (nativeFallback) {
      notice.textContent = 'CUDA still mode. Choose a camera preset or adjust the observer in Camera.';
      autoPreview.checked = true;
      scheduleRefinement();
    }
  } catch {
    const message = 'CUDA service offline. Launch with node play.mjs for Kerr captures.';
    byId('healthStatus').textContent = message;
    captures.setAvailability(false, message);
    autoPreview.disabled = true;
  }
  if (autoPreview.disabled && autoPreview.checked) {
    autoPreview.checked = false;
    scheduleRefinement();
  }
}
function openCapture() {
  captures.open(settings.emission === 'thermal' && !scenario);
  void updateHealth();
}
void updateHealth();

// ---------------------------------------------------------------------------
// Modes: the sandbox, real black holes with literature parameters, scenarios.
function keepCapture(): Pick<RenderSettings, 'width' | 'height' | 'spp' | 'shutter'> {
  return { width: settings.width, height: settings.height, spp: settings.spp, shutter: settings.shutter };
}

function applySettings(next: RenderSettings) {
  const skyChanged = next.background !== settings.background;
  Object.assign(settings, next);
  if (skyChanged) void selectSky(next.background);
  scene?.setSettings(settings, { syncCamera: true });
  updateObserver();
  refreshControls();
  scheduleRefinement();
}

function setPlayback(rate: number) {
  const value = String(rate);
  if (![...playback.options].some(option => option.value === value)) {
    playback.add(new Option(`${rate} M/s`, value));
  }
  playback.value = value;
  scene?.setPlaybackRate(rate);
}

const highlightCatalog = buildCatalogStrip(id => applyObject(id, 0));

function applyObject(id: string, view: number) {
  const entry = findBlackHole(id);
  if (!entry) return;
  activeObject = id;
  activeView = Math.max(0, Math.min(view, entry.views.length - 1));
  const chosen = entry.views[activeView];
  const next: RenderSettings = { ...DEFAULT_SETTINGS, ...keepCapture(), ...entry.base, ...chosen.settings, blackHole: id };
  next.fov = presetFov(next.fov);
  title.textContent = entry.name;
  subtitle.textContent = `${chosen.name} · ${entry.massText}`;
  subtitle.hidden = false;
  highlightCatalog(id);
  renderObjectPanel(entry, activeView, index => applyObject(id, index));
  applySettings(next);
  scene?.setObserverTime(0);
  setPlayback(12);
}

function highlightScenario() {
  for (const button of document.querySelectorAll<HTMLButtonElement>('#scenarioPicker button')) {
    button.setAttribute('aria-pressed', String(button.dataset.id === scenarioId));
  }
}

for (const entry of SCENARIOS) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'view-button';
  button.dataset.id = entry.id;
  const name = document.createElement('strong');
  name.textContent = entry.title;
  const note = document.createElement('span');
  note.textContent = entry.summary;
  button.append(name, note);
  button.addEventListener('click', () => void openScenario(entry.id));
  byId('scenarioPicker').append(button);
}

function closeScenario() {
  if (!scenario) return;
  scene?.setFrameListener(null);
  scene?.setProgram(null);
  scenario.dispose();
  scenario = null;
  for (const id of ['scenarioControls', 'scenarioPlots', 'scenarioReadouts']) byId(id).replaceChildren();
  refreshState();
}

async function openScenario(id: string) {
  const entry = SCENARIOS.find(candidate => candidate.id === id);
  if (!entry || !scene || contextLost) return;
  closeScenario();
  const request = ++scenarioRequest;
  scenarioId = id;
  highlightScenario();
  clearRefinement();
  title.textContent = entry.title;
  subtitle.textContent = 'Preparing…';
  subtitle.hidden = false;
  const live = scene;
  const context: ScenarioContext = {
    renderer: live.getRenderer(),
    kerr: {
      createMaterial: (defines, uniforms) => live.createKerrMaterial(defines, uniforms),
      settings: () => settings,
      updateSettings: (patch, camera = false) => {
        Object.assign(settings, patch);
        live.setSettings(settings, { syncCamera: camera });
        if (camera) updateObserver();
      }
    },
    packedRadiance: live.packedRadiance,
    controls: byId('scenarioControls'),
    plots: byId('scenarioPlots'),
    readouts: byId('scenarioReadouts'),
    getTime: () => live.getObserverTime(),
    setTime: time => live.setObserverTime(time),
    setPaused: value => { if (value !== paused) togglePause(); },
    isPaused: () => paused,
    requestRedraw: () => live.requestRedraw()
  };
  if (entry.settings) {
    Object.assign(settings, entry.settings);
    live.setSettings(settings);
  }
  try {
    const created = await entry.create(context);
    if (request !== scenarioRequest || mode !== 'scenarios') { created.dispose(); return; }
    scenario = created;
    subtitle.textContent = entry.summary;
    Object.assign(settings, created.camera, { fov: presetFov(created.camera.fov) });
    live.setSettings(settings, { syncCamera: true });
    live.setObserverTime(0);
    live.setProgram(created.program);
    live.setFrameListener(time => created.frame(time));
    setPlayback(created.playbackRate);
    if (paused) togglePause();
    updateObserver();
    refreshControls(true);
    refreshState();
  } catch (error) {
    console.error('Could not open the scenario.', error);
    if (request === scenarioRequest) {
      notice.textContent = 'This scenario could not start. Choose it again to retry.';
      notice.hidden = false;
    }
  }
}

function setMode(next: Mode) {
  if (next === mode) return;
  if (mode === 'scenarios') { scenarioRequest++; closeScenario(); }
  if (mode === 'sandbox') sandboxSettings = { ...settings };
  mode = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#modeSwitch button')) {
    const active = button.dataset.mode === next;
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  byId('cameraPresets').hidden = next !== 'sandbox';
  byId('catalogSection').hidden = next !== 'catalog';
  byId('scenarioPlots').hidden = next !== 'scenarios';
  byId('scenarioReadouts').hidden = next !== 'scenarios';
  byId('app').dataset.mode = next;
  if (next === 'sandbox') {
    showInspectorTabs(['sceneTab', 'diskTab', 'cameraTab'], 'diskTab');
    if (sandboxSettings) applySettings({ ...sandboxSettings, ...keepCapture() });
    setPlayback(12);
    nameView(selectedPreset);
  } else if (next === 'catalog') {
    showInspectorTabs(['objectTab', 'sceneTab', 'diskTab', 'cameraTab'], 'objectTab');
    applyObject(activeObject, activeView);
  } else {
    showInspectorTabs(['scenarioTab', 'cameraTab'], 'scenarioTab');
    void openScenario(scenarioId);
  }
  refreshState();
}

const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('#modeSwitch button')];
modeButtons.forEach((button, i) => {
  button.addEventListener('click', () => setMode(button.dataset.mode as Mode));
  button.addEventListener('keydown', event => {
    const offset = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (!offset) return;
    event.preventDefault();
    const target = modeButtons[(i + offset + modeButtons.length) % modeButtons.length];
    target.focus();
    setMode(target.dataset.mode as Mode);
  });
});

// Development-only handle for inspecting live state from the console.
if (import.meta.env.DEV) {
  Object.assign(window, { __gargantua: { settings, get scene() { return scene; }, get scenario() { return scenario; } } });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  closeScenario();
  clearRefinement();
  skyRequest++;
  disconnectReadout();
  disconnectGamepad();
  resizeObserver.disconnect();
  scene?.dispose();
});
