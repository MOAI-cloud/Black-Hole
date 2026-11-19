import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
export const nativeBuildDir = path.join(repoRoot, 'build', 'viewer-native');

const executable = process.platform === 'win32' ? 'gargantua.exe' : 'gargantua';
export function buildExecutables(buildDir) {
  return [path.join(buildDir, executable), path.join(buildDir, 'Release', executable)];
}

export function rendererPath() {
  if (process.env.GARGANTUA_BIN) return path.resolve(process.env.GARGANTUA_BIN);
  const candidates = [
    ...buildExecutables(path.join(repoRoot, 'build')),
    ...buildExecutables(nativeBuildDir)
  ];
  return candidates.find(existsSync) ?? candidates[0];
}

// Single-precision build beside the chosen renderer, used for interactive
// refinement. Captures keep the double-precision renderer.
export function fastRendererPath() {
  if (process.env.GARGANTUA_FAST_BIN) return path.resolve(process.env.GARGANTUA_FAST_BIN);
  const primary = rendererPath();
  const sibling = path.join(path.dirname(primary), path.basename(primary).replace('gargantua', 'gargantua_fast'));
  return existsSync(sibling) ? sibling : primary;
}
