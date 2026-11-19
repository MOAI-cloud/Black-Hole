import { kerrRadii } from './geometry';
import type { RenderSettings } from './types';

export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error('Missing element #' + id);
  return el as T;
}

type NumberKey = { [K in keyof RenderSettings]: RenderSettings[K] extends number ? K : never }[keyof RenderSettings];
type Slider = [key: NumberKey, label: string, min: number, max: number, step: number, digits: number, unit?: string];

const groups: Record<string, Slider[]> = {
  physicsControls: [
    ['spin', 'Spin parameter', 0, 0.999, 0.001, 3],
    ['exposure', 'Exposure', 0.1, 4, 0.05, 2, '×'],
    ['skyBright', 'Sky brightness', 0, 3, 0.05, 2, '×']
  ],
  diskControls: [
    ['diskNoise', 'Clumping', 0, 1, 0.01, 2],
    ['diskOuter', 'Outer radius', 8, 64, 0.5, 1, ' M'],
    ['diskTemp', 'Peak temperature', 2500, 24000, 100, 0, ' K'],
    ['diskBright', 'Emission scale', 0, 32, 0.25, 2],
    ['diskThick', 'Scale height', 0.05, 3, 0.05, 2, ' M'],
    ['diskFlare', 'Flaring', 0, 0.25, 0.005, 3],
    ['diskAbsorb', 'Absorption', 0, 2.5, 0.05, 2]
  ],
  cameraControls: [
    ['camR', 'Distance', 4, 1000, 0.25, 1, ' M'],
    ['camTheta', 'Inclination', 1, 179, 0.1, 1, '°'],
    ['camPhi', 'Azimuth', 0, 360, 0.1, 1, '°'],
    ['roll', 'Camera roll', -180, 180, 0.5, 1, '°'],
    ['fov', 'Vertical field of view', 18, 95, 0.5, 1, '°']
  ]
};

let selectTab: (id: string) => void = () => {};

/** Show one inspector tab panel, e.g. 'objectTab'. */
export function selectInspectorTab(id: string): void { selectTab(id); }

/** Show only the listed inspector tabs, keeping the current one if still visible. */
export function showInspectorTabs(ids: string[], preferred?: string): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
  for (const tab of tabs) tab.hidden = !ids.includes(tab.id);
  const current = tabs.find(tab => tab.getAttribute('aria-selected') === 'true');
  if (preferred) selectTab(preferred);
  else if (!current || current.hidden) selectTab(ids[0]);
}

export function buildInspector(settings: RenderSettings, change: (camera: boolean) => void) {
  const refreshers: Array<() => void> = [];
  const cameraRefreshers: Array<() => void> = [];
  for (const [id, descriptors] of Object.entries(groups)) {
    const camera = id === 'cameraControls';
    for (const [key, label, min, max, step, digits, unit = ''] of descriptors) {
      const row = document.createElement('label');
      row.className = 'range-row';
      const text = document.createElement('span');
      text.className = 'range-label';
      text.textContent = label;
      const value = document.createElement('output');
      value.className = 'range-value';
      const range = document.createElement('input');
      range.type = 'range';
      range.id = key;
      range.setAttribute('aria-label', label);
      Object.assign(range, { min, max, step });
      row.append(text, value, range);
      byId(id).append(row);

      const render = () => {
        const current = settings[key];
        const next = current.toFixed(digits) + unit;
        if (value.textContent === next) return;
        value.textContent = next;
        range.value = String(current);
        range.setAttribute('aria-valuetext', next);
        range.style.setProperty('--fill', 100 * (current - min) / (max - min) + '%');
      };
      refreshers.push(render);
      if (camera) cameraRefreshers.push(render);
      range.addEventListener('input', () => {
        settings[key] = range.valueAsNumber;
        render();
        change(camera);
      });
    }
  }

  function toggle(id: string, read: () => boolean, write: (checked: boolean) => void) {
    const input = byId<HTMLInputElement>(id);
    refreshers.push(() => { input.checked = read(); });
    input.addEventListener('change', () => { write(input.checked); change(false); });
  }
  toggle('doppler', () => !settings.noDoppler, v => { settings.noDoppler = !v; });
  toggle('cinematic', () => settings.cinematic, v => { settings.cinematic = v; });
  toggle('redshift', () => !settings.noRedshift, v => { settings.noRedshift = !v; });
  const geometry = byId<HTMLSelectElement>('diskGeometry');
  geometry.addEventListener('change', () => {
    settings.thin = geometry.value !== 'volume';
    settings.photosphere = geometry.value === 'photosphere';
    change(false);
  });
  refreshers.push(() => {
    geometry.value = settings.thin ? (settings.photosphere ? 'photosphere' : 'thin') : 'volume';
    for (const [key, active] of [['diskThick', geometry.value !== 'thin'], ['diskFlare', geometry.value !== 'thin'],
      ['diskAbsorb', geometry.value === 'volume']] as const) {
      byId<HTMLInputElement>(key).closest('label')!.hidden = !active;
    }
  });
  toggle('staticDiskPattern', () => settings.staticDiskPattern, v => { settings.staticDiskPattern = v; });
  toggle('legacyDiskModel', () => settings.diskModel === 'legacy', v => { settings.diskModel = v ? 'legacy' : 'nt'; });

  refreshers.push(() => {
    const { horizon, isco } = kerrRadii(settings.spin);
    byId('horizonValue').textContent = horizon.toFixed(2) + ' M';
    byId('iscoValue').textContent = isco.toFixed(2) + ' M';
    byId('horizonCircle').style.width = 100 * horizon / isco + '%';
  });
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
  const select = (current: HTMLButtonElement) => {
    for (const tab of tabs) {
      const active = tab === current;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      byId(tab.getAttribute('aria-controls')!).hidden = !active;
    }
  };
  selectTab = id => select(byId<HTMLButtonElement>(id));
  tabs.forEach(tab => {
    tab.addEventListener('click', () => select(tab));
    tab.addEventListener('keydown', event => {
      const visible = tabs.filter(candidate => !candidate.hidden);
      const i = visible.indexOf(tab), n = visible.length;
      const next = { ArrowLeft: (i + n - 1) % n, ArrowRight: (i + 1) % n, Home: 0, End: n - 1 }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      select(visible[next]);
      visible[next].focus();
    });
  });

  return (cameraOnly = false) => (cameraOnly ? cameraRefreshers : refreshers).forEach(render => render());
}
