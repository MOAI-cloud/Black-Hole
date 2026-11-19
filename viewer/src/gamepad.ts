type GamepadAction = 'pause' | 'preset' | 'focus';

interface GamepadControls {
  move(deltaAzimuthDeg: number, deltaInclinationDeg: number, zoomFactor: number): void;
  action(action: GamepadAction): void;
  enabled(): boolean;
}

const actions: ReadonlyArray<[number, GamepadAction]> = [[0, 'pause'], [5, 'preset'], [3, 'focus']];

function trigger(pad: Gamepad, index: number) {
  return Math.max(0, ((pad.buttons[index]?.value ?? 0) - 0.08) / 0.92);
}

export function connectGamepad(controls: GamepadControls): () => void {
  let frame = 0;
  let previousTime = 0;
  let previousButtons = 0;
  let padIndex = -1;
  let focused = true;

  function readPad() {
    // Embedded browsers can deny this API through Permissions Policy.
    try {
      return navigator.getGamepads?.().find((pad) => pad?.connected && pad.mapping === 'standard');
    } catch {
      return undefined;
    }
  }

  function buttons(pad: Gamepad) {
    let mask = 0;
    for (const [index] of actions) {
      if (pad.buttons[index]?.pressed) mask |= 1 << index;
    }
    return mask;
  }

  function update(time: number) {
    frame = 0;
    if (document.hidden || !focused) return;
    const pad = readPad();
    if (!pad) {
      padIndex = -1;
      return;
    }
    const dt = Math.max(0, Math.min(0.05, (time - previousTime) / 1000));
    previousTime = time;
    const pressed = buttons(pad);
    const newlyPressed = pad.index === padIndex ? pressed & ~previousButtons : 0;
    padIndex = pad.index;
    previousButtons = pressed;
    frame = requestAnimationFrame(update);
    if (controls.enabled() && !document.querySelector('dialog[open]') &&
        !document.activeElement?.closest('input,select,textarea,form,[contenteditable="true"],[contenteditable=""]')) {
      const x = pad.axes[0] ?? 0;
      const y = pad.axes[1] ?? 0;
      const radius = Math.hypot(x, y);
      const strength = Math.max(0, (Math.min(radius, 1) - 0.16) / 0.84);
      const orbit = strength > 0 ? 85 * dt * strength * strength / radius : 0;
      const distance = trigger(pad, 6) - trigger(pad, 7);
      if (dt > 0 && (orbit || distance)) controls.move(x * orbit, y * orbit, Math.exp(distance * dt * 1.35));
      for (const [index, action] of actions) {
        if (newlyPressed & (1 << index)) controls.action(action);
      }
    }
  }

  function refresh() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    padIndex = -1;
    if (document.hidden || !focused) return;
    const pad = readPad();
    if (!pad) return;
    padIndex = pad.index;
    previousButtons = buttons(pad);
    previousTime = performance.now();
    frame = requestAnimationFrame(update);
  }

  function blur() { focused = false; refresh(); }
  function focus() { focused = true; refresh(); }
  window.addEventListener('gamepadconnected', refresh);
  window.addEventListener('gamepaddisconnected', refresh);
  window.addEventListener('blur', blur);
  window.addEventListener('focus', focus);
  document.addEventListener('visibilitychange', refresh);
  refresh();
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('gamepadconnected', refresh);
    window.removeEventListener('gamepaddisconnected', refresh);
    window.removeEventListener('blur', blur);
    window.removeEventListener('focus', focus);
    document.removeEventListener('visibilitychange', refresh);
  };
}
