import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat, unlink, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fastRendererPath, repoRoot, rendererPath } from './renderer-paths.mjs';
import { serveStartup, startup } from './startup.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(__dirname, '..');
const renderDir = path.join(viewerRoot, 'renders');
const distDir = path.join(viewerRoot, 'dist');
const port = Number.parseInt(process.env.RENDER_API_PORT ?? process.env.PORT ?? '8787', 10);

// Requests select catalog entries. Only these local maps are passed to CUDA.
const skyFiles = new Map([
  ['milky-way', 'milkyway.ppm'],
  ['star-field', 'starmap.ppm'],
  ['infrared', 'skies/infrared.ppm'],
  ['gamma-ray', 'skies/gamma-ray.ppm'],
  ['dark', null]
]);

let renderQueue = Promise.resolve();

await mkdir(renderDir, { recursive: true });

function findStarmap(background) {
  // Older clients leave the choice to the server.
  if (background == null) return findStarmap('milky-way') ?? findStarmap('star-field');
  const filename = skyFiles.get(background);
  if (!filename) return null;
  const file = path.join(repoRoot, filename);
  return existsSync(file) ? file : null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store'
  });
  response.end(message);
}

function clampNumber(value, fallback, minimum, maximum, decimals = 4) {
  const numberValue = Number(value);
  const safeValue = Number.isFinite(numberValue) ? numberValue : fallback;
  const clamped = Math.min(maximum, Math.max(minimum, safeValue));
  return Number(clamped.toFixed(decimals));
}

function clampInteger(value, fallback, minimum, maximum) {
  const numberValue = Number(value);
  const safeValue = Number.isFinite(numberValue) ? Math.round(numberValue) : fallback;
  return Math.min(maximum, Math.max(minimum, safeValue));
}

function normalizeAngle(value, fallback) {
  const numberValue = Number(value);
  const safeValue = Number.isFinite(numberValue) ? numberValue : fallback;
  const wrapped = ((safeValue % 360) + 360) % 360;
  return Number(wrapped.toFixed(4));
}

function normalizeSettings(input) {
  const mode = input?.mode === 'final' ? 'final' : 'preview';
  const finalMode = mode === 'final';
  const longEdge = finalMode ? 7680 : 960;
  const shortEdge = finalMode ? 4320 : 540;
  const width = clampInteger(input?.width, finalMode ? 3840 : 640, 1, 100000);
  const height = clampInteger(input?.height, finalMode ? 2160 : 360, 1, 100000);
  const scale = Math.min(1, longEdge / Math.max(width, height), shortEdge / Math.min(width, height));
  const photosphere = input?.photosphere === true && input?.thin !== false;

  return {
    mode,
    background: input?.background ?? 'milky-way',
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    spp: clampInteger(input?.spp, finalMode ? 12 : 1, 1, finalMode ? 64 : 4),
    spin: clampNumber(input?.spin, 0.9, 0, 0.999, 5),
    camR: clampNumber(input?.camR, 60, 3, 1000, 4),
    camTheta: clampNumber(input?.camTheta, 84, 1, 179, 4),
    camPhi: normalizeAngle(input?.camPhi, 0),
    roll: clampNumber(input?.roll, 0, -180, 180, 4),
    fov: clampNumber(input?.fov, 45, 1, 179, 4),
    observerTime: clampNumber(input?.observerTime, 0, -1e12, 1e12, 5),
    shutter: finalMode ? clampNumber(input?.shutter, 0, 0, 64, 5) : 0,
    // Physical presets reach ~10^7 K X-ray disks; the native LUT continues
    // the Rayleigh-Jeans tail above 10^6 K.
    diskTemp: clampNumber(input?.diskTemp, 5200, 1500, 1e8, 2),
    diskBright: clampNumber(input?.diskBright, 6, 0, 60, 4),
    diskOuter: clampNumber(input?.diskOuter, 22, 6, 90, 4),
    diskNoise: clampNumber(input?.diskNoise, 0.5, 0, 1, 4),
    diskThick: clampNumber(input?.diskThick, photosphere ? 0.70 : 0.24, 0.02, 5, 4),
    diskFlare: clampNumber(input?.diskFlare, photosphere ? 0.07 : 0.05, 0, 0.5, 4),
    diskAbsorb: clampNumber(input?.diskAbsorb, 0.4, 0, 5, 4),
    skyBright: clampNumber(input?.skyBright, 1, 0, 5, 4),
    exposure: clampNumber(input?.exposure, 1, 0.05, 10, 4),
    cinematic: input?.cinematic === true,
    thin: photosphere || Boolean(input?.thin),
    photosphere,
    noDoppler: Boolean(input?.noDoppler),
    noRedshift: Boolean(input?.noRedshift),
    staticDiskPattern: Boolean(input?.staticDiskPattern),
    diskModel: input?.diskModel === 'legacy' ? 'legacy' : 'nt',
    diskEnabled: input?.diskEnabled !== false,
    emission: input?.emission === 'synchrotron' ? 'synchrotron' : 'thermal',
    diskColorCorrection: clampNumber(input?.diskColorCorrection, 1, 1, 4, 4),
    companion: input?.companion === true,
    companionTheta: clampNumber(input?.companionTheta, 90, 0, 180, 4),
    companionPhi: normalizeAngle(input?.companionPhi, 0),
    companionRadius: clampNumber(input?.companionRadius, 1, 0.001, 89, 5),
    companionTemp: clampNumber(input?.companionTemp, 5800, 1000, 100000, 1)
  };
}

async function readJsonRequest(request) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > 64 * 1024) {
      throw new Error('Request body is too large');
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function buildRenderArgs(settings, outputPath, starmapPath, supportsPhotosphere, fast = false) {
  const args = [
    '--width', String(settings.width),
    '--height', String(settings.height),
    '--spp', String(settings.spp),
    '--spin', String(settings.spin),
    '--cam-r', String(settings.camR),
    '--cam-theta', String(settings.camTheta),
    '--cam-phi', String(settings.camPhi),
    '--fov', String(settings.fov),
    '--disk-out', String(settings.diskOuter),
    '--disk-temp', String(settings.diskTemp),
    '--disk-bright', String(settings.diskBright),
    '--disk-noise', String(settings.diskNoise),
    '--disk-thick', String(settings.diskThick),
    '--disk-flare', String(settings.diskFlare),
    '--disk-absorb', String(settings.diskAbsorb),
    '--disk-model', settings.diskModel,
    '--sky-bright', String(settings.skyBright),
    '--exposure', String(settings.exposure),
    // Single precision cannot honour the capture tolerance; its preview
    // tolerance already converges to within a fraction of an 8-bit level.
    '--tol', settings.mode === 'final' && !fast ? '1e-7' : '2e-6',
    '--atol', settings.mode === 'final' && !fast ? '1e-10' : '1e-9',
    '-o', outputPath
  ];

  if (starmapPath) args.push('--starmap', starmapPath);
  if (supportsPhotosphere || settings.roll) args.push('--roll', String(settings.roll));
  if (settings.observerTime) args.push('--time', String(settings.observerTime));
  if (settings.shutter) args.push('--shutter', String(settings.shutter));
  if (settings.cinematic) args.push('--cinematic');
  if (settings.photosphere) args.push('--photosphere');
  else if (settings.thin) args.push('--thin');
  else if (supportsPhotosphere) args.push('--volume');
  if (!settings.diskEnabled) args.push('--no-disk');
  if (settings.diskColorCorrection !== 1) args.push('--disk-color-correction', String(settings.diskColorCorrection));
  if (settings.companion) {
    args.push('--companion', String(settings.companionTheta), String(settings.companionPhi),
      String(settings.companionRadius), String(settings.companionTemp));
  }
  if (settings.noDoppler) args.push('--no-kinematic-doppler');
  if (settings.noRedshift) args.push('--no-redshift');
  if (settings.staticDiskPattern) args.push('--static-disk-pattern');

  return args;
}

const children = new Set();
process.once('exit', () => {
  for (const child of children) child.kill('SIGKILL');
});
// Handle termination explicitly so a GPU worker also exits on terminal close.
for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.once(signal, () => process.exit(code));
}

function runRenderer(args, timeoutMs, signal, binary = rendererPath()) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const child = spawn(binary, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    children.add(child);
    let forceKill;
    const stop = () => {
      child.kill('SIGTERM');
      forceKill ??= setTimeout(() => child.kill('SIGKILL'), 2000).unref();
    };
    signal?.addEventListener('abort', stop, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = `${stdout}${chunk.toString('utf8')}`.slice(-24000);
    });

    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-24000);
    });

    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });

    child.on('close', (exitCode) => {
      clearTimeout(timeout);
      clearTimeout(forceKill);
      children.delete(child);
      signal?.removeEventListener('abort', stop);
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      const elapsedMs = Date.now() - startedAt;
      if (exitCode === 0 && !timedOut) {
        resolve({ elapsedMs, stdout, stderr });
        return;
      }

      const reason = timedOut
        ? `Renderer timed out after ${Math.round(timeoutMs / 1000)}s`
        : `Renderer exited with code ${exitCode}`;
      const error = new Error(reason);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

async function checkDevice() {
  if (process.env.GARGANTUA_WEB_ONLY === '1') {
    return { rendererAvailable: false, rendererMessage: 'Started in WebGL-only mode.' };
  }
  if (!existsSync(rendererPath())) {
    return { rendererAvailable: false, rendererMessage: 'Build the CUDA renderer to enable ray-traced captures.' };
  }
  try {
    const result = await runRenderer(['--device-info'], 8000);
    const help = await runRenderer(['--help'], 3000).catch(() => null);
    return { rendererAvailable: true, rendererMessage: result.stdout.trim(),
      supportsPhotosphere: help?.stdout.includes('--photosphere') ?? false,
      supportsCompanion: help?.stdout.includes('--companion') ?? false };
  } catch (error) {
    // Earlier builds supported capture before they had a capability query.
    if (error.stderr?.includes("Unknown option: --device-info")) {
      const temporary = await mkdtemp(path.join(tmpdir(), 'gargantua-probe-'));
      try {
        await runRenderer(['--width', '1', '--height', '1', '--spp', '1', '-o', path.join(temporary, 'probe.png')], 8000);
        return { rendererAvailable: true, rendererMessage: 'Legacy CUDA renderer (observation time fixed at 0 M)', legacy: true };
      } catch (probeError) {
        error = probeError;
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    }
    return { rendererAvailable: false, rendererMessage: error.stderr?.trim() || error.message };
  }
}

// Deduplicate simultaneous health/export requests while allowing a later
// build or GPU reconnect to become visible without restarting the viewer.
let deviceCheck;
let checkExpires = 0;
function deviceStatus() {
  if (Date.now() >= checkExpires) {
    deviceCheck = checkDevice();
    checkExpires = Date.now() + 10000;
  }
  return deviceCheck;
}

function enqueueRender(task) {
  const queuedTask = renderQueue.then(task, task);
  renderQueue = queuedTask.catch(() => undefined);
  return queuedTask;
}

async function handleRender(request, response) {
  const device = await deviceStatus();
  if (!device.rendererAvailable) {
    sendJson(response, 503, { ok: false, error: device.rendererMessage });
    return;
  }

  let body;
  try {
    body = await readJsonRequest(request);
  } catch (error) {
    sendJson(response, error instanceof SyntaxError ? 400 : 413, { ok: false, error: error.message });
    return;
  }
  const settings = normalizeSettings(body);
  if (!skyFiles.has(settings.background)) {
    sendJson(response, 400, { ok: false, error: 'Unknown sky background.' });
    return;
  }
  if (device.legacy && settings.observerTime !== 0) {
    sendJson(response, 409, { ok: false, error: 'Rebuild the CUDA renderer to capture at a nonzero observation time.' });
    return;
  }
  if (settings.emission !== 'thermal') {
    sendJson(response, 409, { ok: false, error: 'The native renderer traces thermal disks. Save the viewport PNG for the 230 GHz synchrotron view.' });
    return;
  }
  if ((settings.companion || !settings.diskEnabled) && !device.supportsCompanion) {
    sendJson(response, 409, { ok: false, error: 'Rebuild the CUDA renderer to capture companion stars and dormant black holes.' });
    return;
  }
  if (settings.photosphere && !device.supportsPhotosphere) {
    sendJson(response, 409, { ok: false, error: 'Rebuild the CUDA renderer to capture a finite-height photosphere, or select Thin sheet or Emitting volume.' });
    return;
  }
  const starmapPath = findStarmap(body?.background);
  if (!starmapPath && body?.background != null && settings.background !== 'dark') {
    sendJson(response, 503, { ok: false, error: 'The selected sky map is missing from the local installation.' });
    return;
  }
  const renderId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fileName = `${settings.mode}-${renderId}.png`;
  const outputPath = path.join(renderDir, fileName);
  // Interactive stills stream back as PNG and use the single-precision build,
  // as do captures that ask for it. Reference captures stay in double.
  const interactive = request.headers.accept === 'image/png';
  const binary = interactive || body?.precision === 'single' ? fastRendererPath() : rendererPath();
  const args = buildRenderArgs(settings, outputPath, starmapPath, device.supportsPhotosphere, binary !== rendererPath());
  // Scale the original full-HD, 32-sample budget to UHD captures.
  const work = settings.width * settings.height * settings.spp;
  const timeoutMs = settings.mode === 'final'
    ? 20 * 60 * 1000 * Math.max(1, work / (1920 * 1080 * 32))
    : 4 * 60 * 1000;

  const controller = new AbortController();
  const cancel = () => controller.abort();
  response.once('close', cancel);
  if (response.destroyed) cancel();
  try {
    const result = await enqueueRender(() => runRenderer(args, timeoutMs, controller.signal, binary));
    controller.signal.throwIfAborted();
    if (request.headers.accept === 'image/png') {
      try {
        const file = await stat(outputPath);
        response.writeHead(200, { 'content-type': 'image/png', 'content-length': file.size, 'cache-control': 'no-store' });
        await pipeline(createReadStream(outputPath), response);
      } finally {
        await unlink(outputPath).catch(() => {});
      }
      return;
    }
    sendJson(response, 200, {
      ok: true,
      render: {
        id: renderId,
        url: `/renders/${fileName}`,
        width: settings.width,
        height: settings.height,
        spp: settings.spp,
        mode: settings.mode,
        elapsedMs: result.elapsedMs,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim()
      },
      settings
    });
  } catch (error) {
    await unlink(outputPath).catch(() => {});
    if (controller.signal.aborted) return;
    sendJson(response, 500, {
      ok: false,
      error: error?.stderr?.trim() || error.message || 'Renderer failed',
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? ''
    });
  } finally {
    response.off('close', cancel);
  }
}

async function serveFile(response, filePath, contentType, cacheControl = 'no-store') {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      sendText(response, 404, 'Not found');
      return;
    }
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': fileStat.size,
      'cache-control': cacheControl
    });
    await pipeline(createReadStream(filePath), response);
  } catch {
    if (!response.headersSent) sendText(response, 404, 'Not found');
  }
}

async function serveRender(response, urlPath) {
  const fileName = path.basename(urlPath);
  const filePath = path.join(renderDir, fileName);
  if (!filePath.startsWith(renderDir) || !fileName.endsWith('.png')) {
    sendText(response, 404, 'Not found');
    return;
  }
  await serveFile(response, filePath, 'image/png', 'public, max-age=86400');
}

async function serveDist(response, urlPath) {
  const cleanPath = urlPath === '/' ? '/index.html' : urlPath;
  const requestedPath = path.normalize(cleanPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(distDir, requestedPath);
  const extension = path.extname(filePath).toLowerCase();
  const contentTypes = new Map([
    ['.html', 'text/html; charset=utf-8'],
    ['.js', 'text/javascript; charset=utf-8'],
    ['.css', 'text/css; charset=utf-8'],
    ['.svg', 'image/svg+xml'],
    ['.png', 'image/png'],
    ['.jpg', 'image/jpeg'],
    ['.webp', 'image/webp'],
    ['.woff2', 'font/woff2']
  ]);
  const fingerprinted = cleanPath.startsWith('/assets/') && /-[\w-]{8,}\.\w+$/.test(cleanPath);
  const cache = fingerprinted ? 'public, max-age=31536000, immutable' : 'no-cache';
  await serveFile(response, filePath, contentTypes.get(extension) ?? 'application/octet-stream', cache);
}

export const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (await serveStartup(request, response, requestUrl.pathname)) return;
  const origin = request.headers.origin;
  if (origin !== undefined) {
    let local = false;
    try {
      const url = new URL(origin);
      local = ['http:', 'https:'].includes(url.protocol) &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    } catch { /* Opaque and malformed origins are outside the local viewer. */ }
    if (local) {
      response.setHeader('access-control-allow-origin', origin);
      response.setHeader('vary', 'Origin');
    } else if (request.method === 'POST' || request.method === 'OPTIONS') {
      sendJson(response, 403, { ok: false, error: 'Start renders from the local viewer.' });
      return;
    }
  }

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type'
    });
    response.end();
    return;
  }

  try {
    if (request.method === 'GET' && requestUrl.pathname === '/api/health') {
      const starmapPath = findStarmap();
      sendJson(response, 200, {
        ok: true,
        binaryExists: existsSync(rendererPath()),
        ...await deviceStatus(),
        binaryPath: rendererPath(),
        starmap: starmapPath ? { name: path.basename(starmapPath) } : null,
        renderDir
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/starmap') {
      const background = requestUrl.searchParams.get('background');
      if (background !== null && !skyFiles.has(background)) {
        sendText(response, 400, 'Unknown sky background');
        return;
      }
      if (background === 'dark') {
        response.writeHead(204).end();
        return;
      }
      const starmapPath = findStarmap(background);
      if (!starmapPath) {
        sendText(response, 404, 'No PPM starmap found');
        return;
      }
      await serveFile(response, starmapPath, 'image/x-portable-pixmap', 'public, max-age=3600');
      return;
    }

    if (request.method === 'POST' && requestUrl.pathname === '/api/render') {
      await handleRender(request, response);
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname.startsWith('/renders/')) {
      await serveRender(response, requestUrl.pathname);
      return;
    }

    if (request.method === 'GET' && existsSync(distDir)) {
      await serveDist(response, requestUrl.pathname);
      return;
    }

    sendText(response, 404, 'Not found');
  } catch (error) {
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Unexpected server error'
    });
  }
});

export const viewerUrl = await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => {
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});
if (startup.ready) console.log(`Gargantua is running at ${viewerUrl}\nPress Ctrl+C to quit.`);
