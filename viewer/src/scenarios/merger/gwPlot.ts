import type { MergerSolution } from './merger';
import { C5_OVER_G_WATTS } from './units';
import { sampleIndex, valueAt, type Polarizations } from './waveform';

interface Frame { x: number; y: number; w: number; h: number }

const AMBER = '#ffad69';
const BLUE = '#8fbfff';
const GRID = 'rgba(255,255,255,0.08)';
const AXIS = 'rgba(255,255,255,0.22)';
const LABEL = '#a3a7a8';
const INK = '#f0f0ed';

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

function formatSeconds(seconds: number, span: number): string {
  if (span < 0.2) return (seconds * 1000).toFixed(Math.abs(seconds * 1000) < 10 && span < 0.05 ? 1 : 0) + ' ms';
  return seconds.toFixed(span < 2 ? 2 : span < 20 ? 1 : 0) + ' s';
}

/** Colormap for the time–frequency map: black → ember → amber → white. */
function heat(value: number): [number, number, number] {
  const v = Math.max(0, Math.min(1, value));
  const stops: [number, number, number, number][] = [
    [0, 9, 11, 13], [0.35, 70, 30, 34], [0.6, 196, 92, 40], [0.82, 255, 173, 105], [1, 255, 244, 225]
  ];
  for (let i = 1; i < stops.length; i++) {
    if (v <= stops[i][0]) {
      const [p0, r0, g0, b0] = stops[i - 1];
      const [p1, r1, g1, b1] = stops[i];
      const f = (v - p0) / (p1 - p0);
      return [r0 + f * (r1 - r0), g0 + f * (g1 - g0), b0 + f * (b1 - b0)];
    }
  }
  return [255, 244, 225];
}

export interface PlotData {
  solution: MergerSolution;
  polarizations: Polarizations;
  /** Source-time window of the 3D view, M. */
  window: [number, number];
  inclinationDeg: number;
}

/**
 * Live gravitational-wave plots: strain at Earth, a Q-scan style time–frequency
 * map with the (l,m) harmonics, and the orbital separation with the GW luminosity.
 */
export class GWPlot {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly cache = document.createElement('canvas');
  private readonly observer: ResizeObserver;
  private data: PlotData | null = null;
  private frames: { strain: Frame; spectrum: Frame | null; orbit: Frame | null } | null = null;
  private dirty = true;
  private cursor = NaN;
  private font = '10px "IBM Plex Mono", monospace';
  private spectrumRange: [number, number] = [0, 1];
  private dragging = false;

  constructor(private readonly host: HTMLElement, private readonly onSeek: (sourceTime: number) => void) {
    this.canvas.className = 'merger-plot-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Gravitational-wave strain, time–frequency map and orbital separation');
    host.append(this.canvas);
    this.context = this.canvas.getContext('2d')!;
    const mono = getComputedStyle(host).getPropertyValue('--mono').trim();
    if (mono) this.font = `10px ${mono}`;
    this.observer = new ResizeObserver(() => { this.dirty = true; this.draw(); });
    this.observer.observe(host);
    const seek = (event: PointerEvent) => {
      const time = this.timeAt(event);
      if (time !== null) this.onSeek(time);
    };
    this.canvas.addEventListener('pointerdown', event => {
      this.dragging = true;
      this.canvas.setPointerCapture(event.pointerId);
      seek(event);
    });
    this.canvas.addEventListener('pointermove', event => { if (this.dragging) seek(event); });
    this.canvas.addEventListener('pointerup', () => { this.dragging = false; });
  }

  setData(data: PlotData): void {
    this.data = data;
    this.dirty = true;
    this.draw();
  }

  /** Move the cursor to a source time (M) and redraw the overlay. */
  setCursor(sourceTime: number): void {
    if (sourceTime === this.cursor && !this.dirty) return;
    this.cursor = sourceTime;
    this.draw();
  }

  private timeAt(event: PointerEvent): number | null {
    if (!this.data || !this.frames) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left, y = event.clientY - rect.top;
    const inside = (f: Frame | null) => f && x >= f.x && x <= f.x + f.w && y >= f.y - 16 && y <= f.y + f.h + 16;
    const { strain, spectrum, orbit } = this.frames;
    const [a, b] = this.data.window;
    if (inside(strain) || inside(orbit)) {
      const f = inside(strain) ? strain : orbit!;
      return a + (b - a) * Math.max(0, Math.min(1, (x - f.x) / f.w));
    }
    if (spectrum && inside(spectrum)) {
      const [s0, s1] = this.spectrumRange;
      return s0 + (s1 - s0) * Math.max(0, Math.min(1, (x - spectrum.x) / spectrum.w));
    }
    return null;
  }

  private layout(width: number, height: number) {
    const top = 22, bottom = 22, gap = 18;
    const h = Math.max(40, height - top - bottom);
    const usable = width - 16;
    let strainW = usable, spectrumW = 0, orbitW = 0;
    if (width >= 760) { strainW = usable * 0.46; spectrumW = usable * 0.31; orbitW = usable * 0.23 - 2 * gap; }
    else if (width >= 500) { strainW = usable * 0.58; spectrumW = usable * 0.42 - gap; }
    const left = 54;
    const strain: Frame = { x: left, y: top, w: strainW - left, h };
    const spectrum = spectrumW ? { x: strainW + gap + 38, y: top, w: spectrumW - 38, h } : null;
    const orbit = orbitW ? { x: strainW + spectrumW + 2 * gap + 34, y: top, w: orbitW - 34 - 34, h } : null;
    return { strain, spectrum, orbit };
  }

  private draw(): void {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    if (width < 40 || height < 40) return;
    const dpr = Math.min(2.5, window.devicePixelRatio || 1);
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = this.cache.width = Math.round(width * dpr);
      this.canvas.height = this.cache.height = Math.round(height * dpr);
      this.canvas.style.width = width + 'px';
      this.canvas.style.height = height + 'px';
      this.dirty = true;
    }
    if (this.dirty) this.renderStatic(width, height, dpr);
    const ctx = this.context;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.cache, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.drawCursor();
  }

  private renderStatic(width: number, height: number, dpr: number): void {
    this.dirty = false;
    const ctx = this.cache.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.cache.width, this.cache.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.frames = this.layout(width, height);
    if (!this.data) return;
    ctx.font = this.font;
    ctx.textBaseline = 'middle';
    this.drawStrain(ctx, this.frames.strain);
    if (this.frames.spectrum) this.drawSpectrum(ctx, this.frames.spectrum, dpr);
    if (this.frames.orbit) this.drawOrbit(ctx, this.frames.orbit);
  }

  private seconds(t: number): number { return t * this.data!.solution.secondsPerM; }

  private timeAxis(ctx: CanvasRenderingContext2D, f: Frame, t0: number, t1: number): void {
    const s0 = this.seconds(t0), s1 = this.seconds(t1), span = s1 - s0;
    const step = niceStep(span, Math.max(2, f.w / 85));
    ctx.textAlign = 'center';
    for (let s = Math.ceil(s0 / step) * step; s <= s1 + 1e-12; s += step) {
      const x = f.x + (s - s0) / span * f.w;
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(x, f.y); ctx.lineTo(x, f.y + f.h); ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(Math.abs(s) < step / 1e3 ? '0' : formatSeconds(s, span), x, f.y + f.h + 11);
    }
  }

  private title(ctx: CanvasRenderingContext2D, f: Frame, text: string, right?: string): void {
    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    ctx.fillText(text, f.x - (f === this.frames?.strain ? 46 : 30), f.y - 12);
    if (right) {
      ctx.fillStyle = LABEL;
      ctx.textAlign = 'right';
      ctx.fillText(right, f.x + f.w, f.y - 12);
    }
  }

  private drawStrain(ctx: CanvasRenderingContext2D, f: Frame): void {
    const { solution, polarizations, window, inclinationDeg } = this.data!;
    const [t0, t1] = window;
    const i0 = Math.max(0, sampleIndex(solution.t, t0) - 1), i1 = sampleIndex(solution.t, t1);
    let peak = 1e-30;
    for (let i = i0; i <= i1; i++) peak = Math.max(peak, Math.abs(polarizations.plus[i]), Math.abs(polarizations.cross[i]));
    const exponent = Math.floor(Math.log10(peak));
    const unit = 10 ** exponent;
    const range = Math.ceil(1.15 * peak / unit * 2) / 2;
    const yOf = (h: number) => f.y + f.h / 2 - h / unit / range * f.h / 2;
    const xOf = (t: number) => f.x + (t - t0) / (t1 - t0) * f.w;
    ctx.save();
    // Ringdown region.
    const xm = xOf(0);
    if (xm < f.x + f.w) {
      ctx.fillStyle = 'rgba(255,173,105,0.05)';
      ctx.fillRect(Math.max(f.x, xm), f.y, f.x + f.w - Math.max(f.x, xm), f.h);
    }
    this.timeAxis(ctx, f, t0, t1);
    ctx.textAlign = 'right';
    for (const v of [-range, -range / 2, 0, range / 2, range]) {
      const y = yOf(v * unit);
      ctx.strokeStyle = v === 0 ? AXIS : GRID;
      ctx.beginPath(); ctx.moveTo(f.x, y); ctx.lineTo(f.x + f.w, y); ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(v === 0 ? '0' : v.toFixed(Math.abs(v) < 1 ? 1 : 1), f.x - 6, y);
    }
    ctx.fillText(`×10${superscript(exponent)}`, f.x - 6, f.y - 2);
    ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
    for (const [series, color, widthPx, alpha] of [[polarizations.cross, BLUE, 1.1, 0.75], [polarizations.plus, AMBER, 1.5, 1]] as const) {
      ctx.strokeStyle = color;
      ctx.globalAlpha = alpha;
      ctx.lineWidth = widthPx;
      ctx.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = xOf(solution.t[i]), y = yOf(series[i]);
        if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    this.title(ctx, f, 'Strain at Earth', `h₊ · h× · ι ${inclinationDeg.toFixed(0)}° · ${formatDistance(solution.input.distance)}`);
    ctx.fillStyle = LABEL;
    ctx.textAlign = 'left';
    ctx.fillText('inspiral', f.x + 4, f.y + 8);
    if (xm > f.x + 40 && xm < f.x + f.w - 50) {
      ctx.textAlign = 'center';
      ctx.fillText('merger', xm, f.y + 8);
      ctx.textAlign = 'left';
      ctx.fillText('ringdown', Math.min(xm + 10, f.x + f.w - 52), f.y + f.h - 8);
    }
  }

  private drawSpectrum(ctx: CanvasRenderingContext2D, f: Frame, dpr: number): void {
    const { solution } = this.data!;
    const t0 = solution.start, t1 = solution.end;
    this.spectrumRange = [t0, t1];
    const toHz = 1 / (2 * Math.PI * solution.secondsPerM);
    const ring = solution.remnant.qnm['44'].omegaM * toHz;
    const fMin = Math.max(6, 0.55 * solution.frequency22[0] * toHz);
    const fMax = Math.max(4 * fMin, 1.25 * ring);
    const lf0 = Math.log(fMin), lf1 = Math.log(fMax);
    // Per-mode frequencies from the phase derivative.
    const tracks = solution.modes.map(mode => {
      const n = solution.t.length, freq = new Float64Array(n);
      for (let i = 1; i < n - 1; i++) freq[i] = -(mode.phase[i + 1] - mode.phase[i - 1]) / (solution.t[i + 1] - solution.t[i - 1]);
      freq[0] = freq[1]; freq[n - 1] = freq[n - 2];
      return { mode, freq };
    });
    const pw = Math.max(2, Math.round(f.w * dpr)), ph = Math.max(2, Math.round(f.h * dpr));
    const image = ctx.createImageData(pw, ph);
    const columns: Float64Array[] = [];
    const columnPeaks: number[] = [];
    let peak = 0;
    const sigma = 0.075;
    for (let x = 0; x < pw; x++) {
      const t = t0 + (t1 - t0) * (x + 0.5) / pw;
      const column = new Float64Array(ph);
      const i = sampleIndex(solution.t, t);
      for (const { mode, freq } of tracks) {
        const a = valueAt(solution.t, mode.amp, t);
        const w = freq[i];
        if (!(a > 0) || !(w > 0)) continue;
        const energy = (a * w) ** 2; // GW energy flux density in this harmonic
        const lf = Math.log(w * toHz);
        for (let y = 0; y < ph; y++) {
          const ly = lf1 - (lf1 - lf0) * (y + 0.5) / ph;
          const d = (ly - lf) / sigma;
          if (d * d < 30) column[y] += energy * Math.exp(-0.5 * d * d);
        }
      }
      let columnPeak = 0;
      for (let y = 0; y < ph; y++) columnPeak = Math.max(columnPeak, column[y]);
      peak = Math.max(peak, columnPeak);
      columns.push(column);
      columnPeaks.push(columnPeak);
    }
    // Normalize each time slice so the chirp stays legible across the band, while
    // a gentle power of the slice energy keeps the merger brightest. Harmonics
    // appear on a log scale relative to the dominant (2,2) track.
    for (let x = 0; x < pw; x++) {
      const slice = columnPeaks[x];
      const weight = slice > 0 ? (slice / peak) ** 0.12 : 0;
      for (let y = 0; y < ph; y++) {
        const relative = slice > 0 ? columns[x][y] / slice : 0;
        const v = weight * Math.max(0, 1 + Math.log10(Math.max(relative, 1e-3)) / 3);
        const [r, g, b] = heat(v ** 1.25);
        const k = 4 * (y * pw + x);
        image.data[k] = r; image.data[k + 1] = g; image.data[k + 2] = b; image.data[k + 3] = 255;
      }
    }
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.putImageData(image, Math.round(f.x * dpr), Math.round(f.y * dpr));
    ctx.restore();
    // Frequency axis (log2 ticks).
    ctx.textAlign = 'right';
    for (let hz = 2 ** Math.ceil(Math.log2(fMin)); hz <= fMax; hz *= 2) {
      const y = f.y + (lf1 - Math.log(hz)) / (lf1 - lf0) * f.h;
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      ctx.beginPath(); ctx.moveTo(f.x, y); ctx.lineTo(f.x + f.w, y); ctx.stroke();
      ctx.fillStyle = LABEL;
      ctx.fillText(hz >= 1000 ? (hz / 1000) + 'k' : String(hz), f.x - 5, y);
    }
    this.timeAxis(ctx, f, t0, t1);
    this.title(ctx, f, 'Frequency (Hz)', 'time–frequency map');
  }

  private drawOrbit(ctx: CanvasRenderingContext2D, f: Frame): void {
    const { solution, window } = this.data!;
    const [t0, t1] = window;
    const xOf = (t: number) => f.x + (t - t0) / (t1 - t0) * f.w;
    const i0 = Math.max(0, sampleIndex(solution.t, t0) - 1), i1 = sampleIndex(solution.t, t1);
    const rMax = Math.ceil(valueAt(solution.t, solution.r, t0) + 1);
    let lMax = 0;
    for (let i = i0; i <= i1; i++) lMax = Math.max(lMax, solution.luminosity[i]);
    const lMin = lMax * 1e-3;
    this.timeAxis(ctx, f, t0, t1);
    ctx.textAlign = 'right';
    for (const r of [0, rMax / 2, rMax]) {
      const y = f.y + f.h - r / rMax * f.h;
      ctx.strokeStyle = GRID;
      ctx.beginPath(); ctx.moveTo(f.x, y); ctx.lineTo(f.x + f.w, y); ctx.stroke();
      ctx.fillStyle = '#d9c3a6';
      ctx.fillText(r.toFixed(0), f.x - 5, y);
    }
    ctx.textAlign = 'left';
    for (const decade of [0, -1, -2, -3]) {
      const y = f.y + (-decade / 3) * f.h;
      ctx.fillStyle = BLUE;
      ctx.fillText(`10${superscript(Math.round(Math.log10(lMax * C5_OVER_G_WATTS)) + decade)}`, f.x + f.w + 5, y);
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(f.x, f.y, f.w, f.h); ctx.clip();
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = '#d9c3a6';
    ctx.beginPath();
    let started = false;
    for (let i = i0; i <= i1; i++) {
      if (solution.t[i] > Math.min(solution.dynamicsEnd, 0)) break;
      const x = xOf(solution.t[i]), y = f.y + f.h - solution.r[i] / rMax * f.h;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.strokeStyle = BLUE;
    ctx.beginPath();
    for (let i = i0; i <= i1; i++) {
      const l = Math.max(lMin, solution.luminosity[i]);
      const x = xOf(solution.t[i]), y = f.y + Math.log10(lMax / l) / 3 * f.h;
      if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.restore();
    this.title(ctx, f, 'Separation (M)', 'L (W)');
  }

  private drawCursor(): void {
    if (!this.data || !this.frames || !Number.isFinite(this.cursor)) return;
    const ctx = this.context;
    const { solution, polarizations, window } = this.data;
    const [t0, t1] = window;
    const mark = (f: Frame | null, a: number, b: number) => {
      if (!f || this.cursor < a || this.cursor > b) return;
      const x = f.x + (this.cursor - a) / (b - a) * f.w;
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, f.y); ctx.lineTo(x, f.y + f.h); ctx.stroke();
      return x;
    };
    const x = mark(this.frames.strain, t0, t1);
    mark(this.frames.spectrum, this.spectrumRange[0], this.spectrumRange[1]);
    mark(this.frames.orbit, t0, t1);
    if (x !== undefined) {
      const f = this.frames.strain;
      let peak = 1e-30;
      const i0 = sampleIndex(solution.t, t0), i1 = sampleIndex(solution.t, t1);
      for (let i = i0; i <= i1; i++) peak = Math.max(peak, Math.abs(polarizations.plus[i]), Math.abs(polarizations.cross[i]));
      const unit = 10 ** Math.floor(Math.log10(peak));
      const range = Math.ceil(1.15 * peak / unit * 2) / 2;
      const h = valueAt(solution.t, polarizations.plus, this.cursor);
      const y = f.y + f.h / 2 - h / unit / range * f.h / 2;
      ctx.fillStyle = AMBER;
      ctx.beginPath(); ctx.arc(x, y, 3.2, 0, 2 * Math.PI); ctx.fill();
    }
  }

  dispose(): void {
    this.observer.disconnect();
    this.canvas.remove();
  }
}

function superscript(n: number): string {
  const digits = '⁰¹²³⁴⁵⁶⁷⁸⁹';
  return (n < 0 ? '⁻' : '') + String(Math.abs(n)).split('').map(d => digits[Number(d)]).join('');
}

export function formatDistance(mpc: number): string {
  return mpc >= 1000 ? (mpc / 1000).toFixed(mpc >= 10000 ? 0 : 1) + ' Gpc' : mpc.toFixed(0) + ' Mpc';
}
