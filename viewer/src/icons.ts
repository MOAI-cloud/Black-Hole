// Small, uniform control glyphs stay legible at compact viewport sizes.
const paths: Record<string, string> = {
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M6 9h.1M10 9h.1M14 9h.1M18 9h.1M6 12h.1M10 12h.1M14 12h.1M18 12h.1M8 15h8"/>',
  camera: '<path d="M3 7.5h4.5l2-3h5l2 3H21v12H3z"/><circle cx="12" cy="13" r="3.5"/>',
  expand: '<path d="M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5"/>',
  collapse: '<path d="M4 9h5V4m6 0v5h5M9 20v-5H4m11 5v-5h5"/>',
  pause: '<path d="M8 5v14m8-14v14" stroke-width="3.2"/>',
  play: '<path d="m7 4 13 8-13 8z" fill="currentColor" stroke="none"/>',
  orbit: '<ellipse cx="12" cy="12" rx="10.5" ry="5" transform="rotate(-30 12 12)"/><circle cx="12" cy="12" r="2.6"/><circle cx="3" cy="16.5" r="1.8" fill="currentColor"/>',
  sliders: '<path d="M3 6h5m4 0h9M3 12h10m4 0h4M3 18h2m4 0h12"/><circle cx="10" cy="6" r="2"/><circle cx="15" cy="12" r="2"/><circle cx="7" cy="18" r="2"/>',
  reset: '<path d="M4 10a8 8 0 1 1 1.3 7.2M4 4v6h6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  mouse: '<rect x="6" y="2" width="12" height="20" rx="6"/><path d="M12 5v4"/>',
  tick: '<path d="m5 12 4 4 10-10"/>'
};
export function icon(name: string): string {
  return '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">' + paths[name] + '</svg>';
}

export function mountIcons(): void {
  for (const host of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    host.innerHTML = icon(host.dataset.icon!);
  }
}
