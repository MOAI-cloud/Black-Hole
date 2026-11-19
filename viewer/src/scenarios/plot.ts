// Small canvas-2D plotting for scenario panels: crisp at any device pixel
// ratio, linear or logarithmic y, several series, guides and a time cursor.

export interface Series {
  x: ArrayLike<number>;
  y: ArrayLike<number>;
  color: string;
  label?: string;
  dashed?: boolean;
  width?: number;
}

export interface Guide { value: number; color: string; label?: string }

export interface Panel {
  title: string;
  xLabel: string;
  yLabel: string;
  x: [number, number];
  y: [number, number];
  logY?: boolean;
  series: Series[];
  horizontal?: Guide[];
  vertical?: Guide[];
  points?: { x: number; y: number; color: string }[];
  note?: string;
}

const ink = '#a3a7a8', grid = '#ffffff10', axis = '#ffffff2a';

function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const step0 = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map(f => f * magnitude).find(s => s >= step0) ?? 10 * magnitude;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9 * span; v += step) ticks.push(Math.abs(v) < 1e-12 * span ? 0 : v);
  return ticks;
}

function formatTick(value: number): string {
  const abs = Math.abs(value);
  if (abs !== 0 && (abs >= 1e4 || abs < 1e-2)) return value.toExponential(0).replace('e+', 'e');
  return String(Number(value.toPrecision(3)));
}

export class PlotStrip {
  private readonly canvas = document.createElement('canvas');
  private readonly context: CanvasRenderingContext2D;
  private readonly observer: ResizeObserver;
  private width = 1;
  private height = 1;

  constructor(host: HTMLElement, label: string) {
    this.canvas.className = 'scenario-plot-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', label);
    host.append(this.canvas);
    this.context = this.canvas.getContext('2d')!;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.canvas);
    this.resize();
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  draw(panels: Panel[]): void {
    const ctx = this.context, w = this.width, h = this.height;
    ctx.clearRect(0, 0, w, h);
    const gap = 18, panelWidth = (w - gap * (panels.length - 1)) / panels.length;
    panels.forEach((panel, index) => this.drawPanel(panel, index * (panelWidth + gap), 0, panelWidth, h));
  }

  private drawPanel(panel: Panel, left: number, top: number, width: number, height: number): void {
    const ctx = this.context;
    const pad = { l: 46, r: 8, t: 22, b: 30 };
    const x0 = left + pad.l, x1 = left + width - pad.r, y0 = top + pad.t, y1 = top + height - pad.b;
    if (x1 - x0 < 20 || y1 - y0 < 20) return;
    const ty = (v: number) => panel.logY ? Math.log10(Math.max(v, 1e-300)) : v;
    const [ya, yb] = [ty(panel.y[0]), ty(panel.y[1])];
    const sx = (v: number) => x0 + (v - panel.x[0]) / (panel.x[1] - panel.x[0]) * (x1 - x0);
    const sy = (v: number) => y1 - (ty(v) - ya) / (yb - ya) * (y1 - y0);
    ctx.font = '600 11px Inter, "Segoe UI", Arial, sans-serif';
    ctx.fillStyle = '#e4e2dc';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(panel.title, left + 2, top + 13);
    ctx.font = '10px "IBM Plex Mono", Consolas, monospace';
    ctx.fillStyle = ink;
    // Grid and ticks.
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    const xTicks = niceTicks(panel.x[0], panel.x[1], Math.max(2, Math.floor((x1 - x0) / 70)));
    for (const t of xTicks) { const X = Math.round(sx(t)) + .5; ctx.moveTo(X, y0); ctx.lineTo(X, y1); }
    const yTicks = panel.logY
      ? Array.from({ length: Math.floor(yb) - Math.ceil(ya) + 1 }, (_, i) => 10 ** (Math.ceil(ya) + i))
      : niceTicks(panel.y[0], panel.y[1], Math.max(2, Math.floor((y1 - y0) / 34)));
    const step = Math.max(1, Math.ceil(yTicks.length / Math.max(2, Math.floor((y1 - y0) / 26))));
    const shownY = yTicks.filter((_, i) => i % step === 0);
    for (const t of shownY) { const Y = Math.round(sy(t)) + .5; ctx.moveTo(x0, Y); ctx.lineTo(x1, Y); }
    ctx.stroke();
    ctx.strokeStyle = axis;
    ctx.strokeRect(x0 + .5, y0 + .5, x1 - x0 - 1, y1 - y0 - 1);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (const t of xTicks) ctx.fillText(formatTick(t), sx(t), y1 + 4);
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const t of shownY) ctx.fillText(panel.logY ? `1e${Math.round(Math.log10(t))}` : formatTick(t), x0 - 5, sy(t));
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(panel.xLabel, x1, y1 + 28);
    ctx.save();
    ctx.translate(left + 9, (y0 + y1) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(panel.yLabel, 0, -7);
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, x1 - x0, y1 - y0);
    ctx.clip();
    for (const guide of panel.horizontal ?? []) this.guide(guide, x0, x1, sy(guide.value), true);
    for (const guide of panel.vertical ?? []) this.guide(guide, y0, y1, sx(guide.value), false);
    for (const series of panel.series) {
      ctx.strokeStyle = series.color;
      ctx.lineWidth = series.width ?? 1.6;
      ctx.setLineDash(series.dashed ? [4, 3] : []);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < series.x.length; i++) {
        const X = sx(series.x[i]), v = series.y[i];
        if (!Number.isFinite(v) || (panel.logY && v <= 0)) { pen = false; continue; }
        const Y = Math.max(y0 - 50, Math.min(y1 + 50, sy(v)));
        if (pen) ctx.lineTo(X, Y); else ctx.moveTo(X, Y);
        pen = true;
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);
    for (const point of panel.points ?? []) {
      if (!Number.isFinite(point.y) || (panel.logY && point.y <= 0)) continue;
      ctx.fillStyle = point.color;
      ctx.beginPath();
      ctx.arc(sx(point.x), sy(point.y), 3.5, 0, 2 * Math.PI);
      ctx.fill();
    }
    ctx.restore();
    // Legend.
    let lx = x0 + 6;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    for (const series of panel.series.filter(s => s.label)) {
      ctx.fillStyle = series.color;
      ctx.fillRect(lx, y0 + 9, 10, 2);
      ctx.fillStyle = ink;
      ctx.fillText(series.label!, lx + 14, y0 + 10);
      lx += 22 + ctx.measureText(series.label!).width;
    }
    if (panel.note) {
      ctx.textAlign = 'right';
      ctx.fillStyle = ink;
      ctx.fillText(panel.note, x1 - 6, y1 - 10);
    }
  }

  private guide(guide: Guide, a: number, b: number, at: number, horizontal: boolean): void {
    const ctx = this.context;
    ctx.strokeStyle = guide.color;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(a, at); ctx.lineTo(b, at); } else { ctx.moveTo(at, a); ctx.lineTo(at, b); }
    ctx.stroke();
    ctx.setLineDash([]);
    if (guide.label) {
      ctx.fillStyle = guide.color;
      ctx.textAlign = horizontal ? 'right' : 'left';
      ctx.textBaseline = horizontal ? 'bottom' : 'top';
      ctx.fillText(guide.label, horizontal ? b - 4 : at + 4, horizontal ? at - 2 : a + 4);
    }
  }

  dispose(): void {
    this.observer.disconnect();
    this.canvas.remove();
  }
}
