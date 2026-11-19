import { byId } from './controls';
import { requestRender } from './renderApi';
import type { RenderMode, RenderSettings } from './types';

export function fitImage(width: number, height: number, maxWidth: number, maxHeight: number) {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export function setupCaptures(settings: RenderSettings, getTime: () => number, snapshot: () => Promise<Blob>) {
  const dialog = byId<HTMLDialogElement>('captureDialog');
  const state = byId('renderState');
  const preview = byId<HTMLButtonElement>('previewButton');
  const final = byId<HTMLButtonElement>('finalButton');
  const cancel = byId<HTMLButtonElement>('cancelButton');
  const save = byId<HTMLButtonElement>('snapshotButton');
  const size = byId<HTMLSelectElement>('captureSize');
  const width = byId<HTMLInputElement>('widthInput');
  const height = byId<HTMLInputElement>('heightInput');
  const spp = byId<HTMLInputElement>('samplesInput');
  const shutter = byId<HTMLInputElement>('shutterInput');
  let controller: AbortController | null = null;
  let available = false;

  let nativeScene = true;
  let healthMessage = '';
  function sync() {
    preview.disabled = final.disabled = !available || !nativeScene || controller !== null;
    cancel.hidden = controller === null;
    byId('captureHealth').textContent = nativeScene ? healthMessage
      : 'Native capture traces the thermal disk. Save the viewport PNG for this view.';
  }

  function updateSize() {
    const w = width.valueAsNumber;
    const h = height.valueAsNumber;
    const long = Math.max(w, h);
    const short = Math.min(w, h);
    size.value = [1920, 3840, 7680].includes(long) && short === long * 9 / 16 ? String(long) : 'custom';
    height.setCustomValidity(short > 4320 ? 'An 8K image supports up to 4320 pixels on its shorter side.' : '');
    if (width.validity.valid && height.validity.valid) {
      settings.width = w;
      settings.height = h;
    }
  }

  function syncDimensions() {
    width.value = String(settings.width);
    height.value = String(settings.height);
    spp.value = String(settings.spp);
    shutter.value = String(settings.shutter);
    updateSize();
  }
  syncDimensions();
  size.addEventListener('change', () => {
    if (size.value === 'custom') { width.focus(); width.select(); return; }
    const long = Number(size.value);
    const short = long * 9 / 16;
    const portrait = height.valueAsNumber > width.valueAsNumber;
    width.value = String(portrait ? short : long);
    height.value = String(portrait ? long : short);
    updateSize();
  });
  width.addEventListener('input', updateSize);
  height.addEventListener('input', updateSize);
  for (const [input, key] of [[spp, 'spp'], [shutter, 'shutter']] as const) {
    input.addEventListener('input', () => {
      if (input.validity.valid) settings[key] = input.valueAsNumber;
    });
  }

  async function render(mode: RenderMode) {
    if (!available || controller || ![width, height, spp, shutter].every(input => input.reportValidity())) return;
    const request = new AbortController();
    controller = request;
    sync();
    state.textContent = mode === 'preview' ? 'Tracing preview…' : 'Tracing full-resolution frame…';
    byId('logDetails').hidden = true;
    byId('result').hidden = true;
    try {
      const params = { ...settings };
      if (mode === 'preview') {
        const portrait = params.height > params.width;
        Object.assign(params, fitImage(params.width, params.height, portrait ? 360 : 640, portrait ? 640 : 360), { spp: 1 });
      }
      const precision = byId<HTMLSelectElement>('capturePrecision').value === 'single' ? 'single' : 'double';
      const { render } = await requestRender(params, mode, getTime(), request.signal, precision);
      const image = byId<HTMLImageElement>('latestRender');
      image.src = render.url;
      const link = byId<HTMLAnchorElement>('saveRender');
      link.href = render.url;
      link.download = 'gargantua-' + render.id + '.png';
      byId('result').hidden = false;
      state.textContent = `${render.width} × ${render.height} · ${render.spp} spp · ${(render.elapsedMs / 1000).toFixed(2)} s`;
      byId('renderLog').textContent = [render.stdout, render.stderr].filter(Boolean).join('\n');
      byId('logDetails').hidden = false;
    } catch (error) {
      state.textContent = request.signal.aborted ? 'Capture cancelled.' : error instanceof Error ? error.message : 'Render failed.';
    } finally {
      controller = null;
      sync();
    }
  }

  preview.addEventListener('click', () => void render('preview'));
  final.addEventListener('click', () => void render('final'));
  cancel.addEventListener('click', () => controller?.abort());
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      const url = URL.createObjectURL(await snapshot());
      const link = document.createElement('a');
      link.href = url;
      link.download = 'gargantua-' + new Date().toISOString().replace(/[:.]/g, '-') + '.png';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (!controller) state.textContent = 'Viewport PNG saved.';
    } catch (error) {
      if (!controller) state.textContent = error instanceof Error ? error.message : 'Snapshot failed.';
    } finally {
      save.disabled = false;
    }
  });
  return {
    open: (native = true) => { nativeScene = native; sync(); if (!dialog.open) dialog.showModal(); },
    syncDimensions,
    setAvailability: (ready: boolean, message: string) => {
      available = ready;
      healthMessage = message;
      sync();
    }
  };
}
