import './styles.css';
import { BlackHoleScene } from './BlackHoleScene';
import { getHealth, requestRender } from './renderApi';
import { loadPpmTexture } from './ppmTexture';
import { DEFAULT_SETTINGS, type RenderMode, type RenderSettings } from './types';

type NumericSettingKey = {
  [Key in keyof RenderSettings]: RenderSettings[Key] extends number ? Key : never;
}[keyof RenderSettings];

interface NumericControlDescriptor {
  key: NumericSettingKey;
  label: string;
  min: number;
  max: number;
  step: number;
  precision: number;
}

interface NumericControlBinding {
  range: HTMLInputElement;
  value: HTMLElement;
  descriptor: NumericControlDescriptor;
}

const settings: RenderSettings = { ...DEFAULT_SETTINGS };
const controlsByKey = new Map<NumericSettingKey, NumericControlBinding>();
const cameraKeys = new Set<NumericSettingKey>(['camR', 'camTheta', 'camPhi', 'fov']);
let activeRender = false;
let autoPreviewTimer: number | undefined;

function byId<ElementType extends HTMLElement>(id: string): ElementType {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing element #${id}`);
  }
  return element as ElementType;
}

const sceneCanvas = byId<HTMLCanvasElement>('sceneCanvas');
const healthStatus = byId('healthStatus');
const cameraReadout = byId('cameraReadout');
const renderState = byId('renderState');
const previewButton = byId<HTMLButtonElement>('previewButton');
const finalButton = byId<HTMLButtonElement>('finalButton');
const latestRender = byId<HTMLImageElement>('latestRender');
const emptyRender = byId('emptyRender');
const renderLog = byId('renderLog');
const metaSize = byId('metaSize');
const metaSamples = byId('metaSamples');
const metaTime = byId('metaTime');
const thinDisk = byId<HTMLInputElement>('thinDisk');
const noDoppler = byId<HTMLInputElement>('noDoppler');
const autoPreview = byId<HTMLInputElement>('autoPreview');

const numericGroups: Array<{ hostId: string; controls: NumericControlDescriptor[] }> = [
  {
    hostId: 'cameraControls',
    controls: [
      { key: 'camR', label: 'Radius', min: 4, max: 140, step: 0.5, precision: 1 },
      { key: 'camTheta', label: 'Theta', min: 4, max: 176, step: 0.25, precision: 1 },
      { key: 'camPhi', label: 'Phi', min: 0, max: 360, step: 0.25, precision: 1 },
      { key: 'fov', label: 'FOV', min: 18, max: 95, step: 0.5, precision: 1 }
    ]
  },
  {
    hostId: 'physicsControls',
    controls: [
      { key: 'spin', label: 'Spin', min: 0, max: 0.999, step: 0.001, precision: 3 },
      { key: 'skyBright', label: 'Sky', min: 0, max: 3, step: 0.05, precision: 2 },
      { key: 'exposure', label: 'Exposure', min: 0.1, max: 4, step: 0.05, precision: 2 }
    ]
  },
  {
    hostId: 'diskControls',
    controls: [
      { key: 'diskOuter', label: 'Outer R', min: 8, max: 64, step: 0.5, precision: 1 },
      { key: 'diskTemp', label: 'Temp K', min: 2500, max: 24000, step: 100, precision: 0 },
      { key: 'diskBright', label: 'Bright', min: 0, max: 32, step: 0.25, precision: 2 },
      { key: 'diskNoise', label: 'Noise', min: 0, max: 1, step: 0.01, precision: 2 },
      { key: 'diskThick', label: 'Height', min: 0.05, max: 3, step: 0.05, precision: 2 },
      { key: 'diskFlare', label: 'Flare', min: 0, max: 0.25, step: 0.005, precision: 3 },
      { key: 'diskAbsorb', label: 'Opacity', min: 0, max: 2.5, step: 0.05, precision: 2 }
    ]
  },
  {
    hostId: 'renderControls',
    controls: [
      { key: 'width', label: 'Width', min: 320, max: 1920, step: 16, precision: 0 },
      { key: 'height', label: 'Height', min: 180, max: 1080, step: 12, precision: 0 },
      { key: 'spp', label: 'Samples', min: 1, max: 32, step: 1, precision: 0 }
    ]
  }
];

const presets: Array<{ label: string; settings: Partial<RenderSettings> }> = [
  { label: 'Film', settings: { spin: 0.6, camR: 60, camTheta: 87, camPhi: 34, diskTemp: 6500, noDoppler: true } },
  { label: 'Physical', settings: { spin: 0.99, camR: 62, camTheta: 85, camPhi: 128, diskTemp: 12000, noDoppler: false } },
  { label: 'Top', settings: { spin: 0.9, camR: 72, camTheta: 18, camPhi: 45, fov: 42, noDoppler: false } },
  { label: 'Close', settings: { spin: 0.96, camR: 28, camTheta: 81, camPhi: 230, fov: 58, diskBright: 14 } }
];

function formatValue(value: number, precision: number): string {
  return precision === 0 ? Math.round(value).toString() : value.toFixed(precision);
}

function setNumericSetting<Key extends NumericSettingKey>(key: Key, value: number): void {
  settings[key] = value as RenderSettings[Key];
}

function syncControlValues(): void {
  for (const [key, binding] of controlsByKey) {
    const value = Number(settings[key]);
    binding.range.value = String(value);
    binding.value.textContent = formatValue(value, binding.descriptor.precision);
  }
  thinDisk.checked = settings.thin;
  noDoppler.checked = settings.noDoppler;
  cameraReadout.textContent = `r ${settings.camR.toFixed(1)} / theta ${settings.camTheta.toFixed(1)} / phi ${settings.camPhi.toFixed(1)}`;
}

function scheduleAutoPreview(): void {
  window.clearTimeout(autoPreviewTimer);
  if (!autoPreview.checked || activeRender) {
    return;
  }
  autoPreviewTimer = window.setTimeout(() => {
    void runRender('preview');
  }, 1000);
}

function createNumericControl(host: HTMLElement, descriptor: NumericControlDescriptor): void {
  const row = document.createElement('label');
  row.className = 'range-row';

  const label = document.createElement('span');
  label.className = 'range-label';
  label.textContent = descriptor.label;

  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(descriptor.min);
  range.max = String(descriptor.max);
  range.step = String(descriptor.step);
  range.value = String(settings[descriptor.key]);

  const value = document.createElement('output');
  value.className = 'range-value';
  value.textContent = formatValue(Number(settings[descriptor.key]), descriptor.precision);

  range.addEventListener('input', () => {
    const nextValue = Number.parseFloat(range.value);
    setNumericSetting(descriptor.key, nextValue);
    value.textContent = formatValue(nextValue, descriptor.precision);
    scene.setSettings(settings, { syncCamera: cameraKeys.has(descriptor.key) });
    syncControlValues();
    scheduleAutoPreview();
  });

  row.append(label, range, value);
  host.append(row);
  controlsByKey.set(descriptor.key, { range, value, descriptor });
}

function buildControls(): void {
  for (const group of numericGroups) {
    const host = byId(group.hostId);
    for (const descriptor of group.controls) {
      createNumericControl(host, descriptor);
    }
  }

  const presetStrip = byId('presetStrip');
  for (const preset of presets) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = preset.label;
    button.addEventListener('click', () => {
      Object.assign(settings, preset.settings);
      scene.setSettings(settings, { syncCamera: true });
      syncControlValues();
      scheduleAutoPreview();
    });
    presetStrip.append(button);
  }
}

function setRenderBusy(busy: boolean, label = busy ? 'Rendering' : 'Idle'): void {
  activeRender = busy;
  renderState.textContent = label;
  previewButton.disabled = busy;
  finalButton.disabled = busy;
}

function previewSettings(): RenderSettings {
  return {
    ...settings,
    width: Math.min(640, settings.width),
    height: Math.min(360, settings.height),
    spp: Math.min(1, settings.spp)
  };
}

async function runRender(mode: RenderMode): Promise<void> {
  if (activeRender) {
    return;
  }

  const requestSettings = mode === 'preview' ? previewSettings() : settings;
  setRenderBusy(true, mode === 'preview' ? 'Previewing' : 'Rendering');
  renderLog.textContent = '';

  try {
    const result = await requestRender(requestSettings, mode);
    latestRender.src = `${result.render.url}?t=${Date.now()}`;
    latestRender.hidden = false;
    emptyRender.hidden = true;
    metaSize.textContent = `${result.render.width} x ${result.render.height}`;
    metaSamples.textContent = `${result.render.spp}`;
    metaTime.textContent = `${(result.render.elapsedMs / 1000).toFixed(1)}s`;
    renderLog.textContent = [result.render.stdout, result.render.stderr].filter(Boolean).join('\n');
    setRenderBusy(false, 'Complete');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Render failed';
    renderLog.textContent = message;
    setRenderBusy(false, 'Failed');
  }
}

const scene = new BlackHoleScene(sceneCanvas, settings, (cameraValues) => {
  settings.camR = cameraValues.camR;
  settings.camTheta = cameraValues.camTheta;
  settings.camPhi = cameraValues.camPhi;
  settings.fov = cameraValues.fov;
  syncControlValues();
  scheduleAutoPreview();
});

buildControls();
syncControlValues();

thinDisk.addEventListener('change', () => {
  settings.thin = thinDisk.checked;
  scene.setSettings(settings);
  scheduleAutoPreview();
});

noDoppler.addEventListener('change', () => {
  settings.noDoppler = noDoppler.checked;
  scene.setSettings(settings);
  scheduleAutoPreview();
});

previewButton.addEventListener('click', () => {
  void runRender('preview');
});

finalButton.addEventListener('click', () => {
  void runRender('final');
});

void getHealth()
  .then(async (health) => {
    healthStatus.textContent = health.binaryExists ? 'CUDA renderer ready' : 'Build renderer';
    healthStatus.classList.toggle('warning', !health.binaryExists);
    if (health.starmap) {
      const texture = await loadPpmTexture('/api/starmap');
      scene.setStarTexture(texture);
      healthStatus.textContent = `${health.starmap.name} loaded`;
    }
  })
  .catch((error) => {
    healthStatus.textContent = 'API offline';
    healthStatus.classList.add('warning');
    renderLog.textContent = error instanceof Error ? error.message : 'Could not reach render API';
  });

window.addEventListener('beforeunload', () => scene.dispose());
