// Bundle a TypeScript module with esbuild and import it, so Node's built-in
// test runner can exercise the viewer's physics code without a browser.
import { build } from 'esbuild';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

export async function loadTs(relativeEntry) {
  const result = await build({
    entryPoints: [path.join(root, relativeEntry)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node18',
    write: false,
    external: ['three'],
    logLevel: 'silent'
  });
  // Stay inside the package so bare imports such as 'three' still resolve.
  const cache = path.join(root, 'node_modules', '.cache');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(path.join(cache, 'gargantua-ts-'));
  const file = path.join(directory, 'module.mjs');
  try {
    await writeFile(file, result.outputFiles[0].text);
    return await import(pathToFileURL(file).href);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
