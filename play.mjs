#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { startup } from './viewer/server/startup.mjs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRoot, nativeBuildDir, buildExecutables, rendererPath } from './viewer/server/renderer-paths.mjs';

const probe = promisify(execFile);
const viewer = fileURLToPath(new URL('./viewer/', import.meta.url));
const headless = process.argv.includes('--no-open');

if (process.argv.includes('--help')) {
  console.log('Usage: node play.mjs [--no-open] [--web-only]\nStarts the local viewer. Set RENDER_API_PORT to use a fixed port or GARGANTUA_BIN to use a custom renderer.');
  process.exit(0);
}
if (process.argv.slice(2).some((arg) => !['--no-open', '--web-only'].includes(arg))) {
  console.error('Unknown option. Use node play.mjs --help.');
  process.exit(1);
}
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 18 || (major === 18 && minor < 19)) {
  console.error('Gargantua needs Node.js 18.19 or newer.');
  process.exit(1);
}

async function modified(relativePath) {
  const file = path.resolve(viewer, relativePath);
  try {
    const info = await stat(file);
    if (!info.isDirectory()) return info.mtimeMs;
    const entries = await readdir(file);
    const times = await Promise.all(entries.map((entry) => modified(path.join(relativePath, entry))));
    return Math.max(info.mtimeMs, ...times);
  } catch (error) {
    if (error.code === 'ENOENT') return 0;
    throw error;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
}

async function npm(args) {
  const code = await run('npm', args, { cwd: viewer, shell: process.platform === 'win32' });
  if (code !== 0) throw new Error(`npm ${args[0]} exited with code ${code}`);
}

async function prepareRenderer() {
  if (process.argv.includes('--web-only')) process.env.GARGANTUA_WEB_ONLY = '1';
  if (process.env.GARGANTUA_WEB_ONLY === '1' || process.env.GARGANTUA_BIN) return;

  const latestSource = Math.max(...await Promise.all(['../src', '../include', '../cmake', '../CMakeLists.txt'].map(modified)));
  const candidates = [...buildExecutables(path.join(repoRoot, 'build')), ...buildExecutables(nativeBuildDir)];
  for (const candidate of candidates) {
    if (await modified(candidate) < latestSource) continue;
    const help = await probe(candidate, ['--help'], { timeout: 3000 }).catch(() => null);
    if (help?.stdout.includes('--time') && help.stdout.includes('--device-info')) {
      process.env.GARGANTUA_BIN = candidate;
      return;
    }
  }

  const gpu = await probe('nvidia-smi', ['-L'], { timeout: 3000 }).catch(() => null);
  if (!gpu?.stdout.includes('GPU ') && !existsSync('/dev/nvhost-gpu') && !existsSync('/dev/nvidia0')) return;
  if (!await probe('cmake', ['--version'], { timeout: 3000 }).catch(() => null)) {
    console.log('Install CMake and the CUDA toolkit to build the local ray tracer.');
    return;
  }

  console.log('Preparing the CUDA ray tracer for this GPU…');
  const configure = await run('cmake', ['-S', repoRoot, '-B', nativeBuildDir, '-DGARGANTUA_BUILD_TESTS=OFF'],
    { stdio: 'inherit' });
  if (configure === 0) {
    const build = await run('cmake', ['--build', nativeBuildDir, '--target', 'gargantua', 'gargantua_fast', '--config', 'Release', '--parallel'],
      { stdio: 'inherit' });
    const binary = buildExecutables(nativeBuildDir).find(existsSync);
    if (build === 0 && binary) {
      process.env.GARGANTUA_BIN = binary;
      return;
    }
  }
  console.log(existsSync(rendererPath())
    ? 'The CUDA build failed. Trying the existing renderer.'
    : 'The CUDA build failed. Starting the live WebGL viewer.');
}

function openViewer(url) {
  const candidates = [];
  if (process.platform === 'win32') {
    for (const root of [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)) {
      candidates.push(path.join(root, 'Google/Chrome/Application/chrome.exe'),
        path.join(root, 'Microsoft/Edge/Application/msedge.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
  } else {
    for (const name of ['google-chrome', 'microsoft-edge', 'chromium', 'chromium-browser', 'brave-browser']) {
      for (const dir of (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)) candidates.push(path.join(dir, name));
    }
  }
  function launch(command, args, fallback) {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', fallback);
    child.once('exit', (code) => { if (code) fallback(); });
    child.unref();
  }
  function defaultBrowser() {
    const command = process.platform === 'win32' ? 'rundll32.exe'
      : process.platform === 'darwin' ? 'open' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    launch(command, args, () => console.log(`Open ${url} in your browser to play.`));
  }
  const app = candidates.find(existsSync);
  if (app) launch(app, [`--app=${url}`], defaultBrowser);
  else defaultBrowser();
}

async function play() {
  startup.ready = false;
  process.env.RENDER_API_PORT ??= process.env.PORT ?? '0';
  const { server, viewerUrl } = await import('./viewer/server/render-server.mjs');
  if (!headless) openViewer(viewerUrl);
  try {
    const [lock, installed, compiler, bundler] = await Promise.all([
      'package-lock.json', 'node_modules/.package-lock.json',
      'node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js'
    ].map(modified));
    const install = !compiler || !bundler || installed < lock;
    if (install) {
      startup.message = 'Installing viewer dependencies…';
      await npm(['ci', '--include=dev', '--no-audit', '--no-fund']);
    }

    const sources = ['../src/flow', '../src/disk_turbulence.inl', '../src/photosphere.inl', '../src/film_response.inl', 'src', 'public', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts'];
    const newest = Math.max(...await Promise.all(sources.map(modified)));
    if (install || newest >= await modified('dist/index.html')) {
      Object.assign(startup, { step: 2, message: 'Building the viewer…' });
      await npm(['run', 'build']);
    }
    Object.assign(startup, { step: 3, message: 'Preparing the local renderer…' });
    await prepareRenderer();
    startup.ready = true;
    console.log(`Gargantua is running at ${viewerUrl}\nPress Ctrl+C to quit.`);
  } catch (error) {
    startup.failed = true;
    startup.message = 'Startup failed. Check the launcher terminal, then run node play.mjs again.';
    if (headless) server.close();
    else setTimeout(() => server.close(), 3000);
    throw error;
  }
}

play().catch((error) => {
  console.error(`Gargantua could not start: ${error.message}`);
  process.exitCode = 1;
});
