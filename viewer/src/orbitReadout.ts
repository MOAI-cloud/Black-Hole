import { byId } from './controls';
import { kerrRadii } from './geometry';
import type { RenderSettings } from './types';

// Two reference fluid elements in the equatorial source plane. Their coordinate
// angular velocities use the same prograde Kerr law as the emitting parcels.
export function setupOrbitReadout(settings: RenderSettings, time: () => number) {
  const panel = byId('diskPanel');
  const clock = byId('flowClock');
  const innerPath = document.querySelector<HTMLElement>('.inner-path')!;
  const outerPath = document.querySelector<HTMLElement>('.outer-path')!;
  let innerOmega = 0;
  let outerOmega = 0;
  let key = '';
  let lastTime = -1;

  function update() {
    if (document.hidden || panel.hidden || byId('app').classList.contains('focus')) return;
    const current = time();
    const config = settings.spin + '/' + settings.diskOuter + '/' + settings.staticDiskPattern;
    if (key === config && current === lastTime) return;
    if (key !== config) {
      key = config;
      const { horizon, isco } = kerrRadii(settings.spin);
      const width = settings.diskOuter - isco;
      const inner = isco + .15 * width;
      const outer = isco + .8 * width;
      innerOmega = 1 / (inner ** 1.5 + settings.spin);
      outerOmega = 1 / (outer ** 1.5 + settings.spin);
      for (const [prefix, r, omega] of [['inner', inner, innerOmega], ['outer', outer, outerOmega]] as const) {
        byId(prefix + 'Radius').textContent = 'r ' + r.toFixed(1) + ' M';
        byId(prefix + 'Period').textContent = (2 * Math.PI / omega).toFixed(0) + ' M';
      }
      innerPath.style.width = 91 * inner / outer + '%';
      byId('flowHorizon').style.width = 91 * horizon / outer + '%';
    }
    lastTime = current;
    clock.textContent = 't ' + current.toFixed(0) + ' M';
    const phaseTime = settings.staticDiskPattern ? 0 : current;
    innerPath.style.setProperty('--phase', (-phaseTime * innerOmega) % (2 * Math.PI) + 'rad');
    outerPath.style.setProperty('--phase', (-phaseTime * outerOmega + 2.1) % (2 * Math.PI) + 'rad');
  }
  update();
  const interval = window.setInterval(update, 125);
  return () => window.clearInterval(interval);
}
