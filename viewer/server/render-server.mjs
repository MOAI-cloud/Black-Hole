import { createReadStream, existsSync } from 'node:fs';
import { mkdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const viewerRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(viewerRoot, '..');
const renderDir = path.join(viewerRoot, 'renders');
const distDir = path.join(viewerRoot, 'dist');
const binaryPath = process.env.GARGANTUA_BIN
  ? path.resolve(process.env.GARGANTUA_BIN)
  : path.join(repoRoot, 'build', 'gargantua');
const port = Number.parseInt(process.env.RENDER_API_PORT ?? process.env.PORT ?? '8787', 10);

const starmapCandidates = ['milkyway.ppm', 'starmap.ppm']
  .map((fileName) => path.join(repoRoot, fileName));

let renderQueue = Promise.resolve();

await mkdir(renderDir, { recursive: true });

function findStarmap() {
  return starmapCandidates.find((candidate) => existsSync(candidate)) ?? null;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
  });
  response.end(JSON.stringify(payload, null, 2));
}

function sendText(response, statusCode, message) {
  response.writeHead(statusCode, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*'
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

  return {
    mode,
    width: clampInteger(input?.width, finalMode ? 1280 : 640, 160, finalMode ? 1920 : 960),
    height: clampInteger(input?.height, finalMode ? 720 : 360, 90, finalMode ? 1080 : 540),
    spp: clampInteger(input?.spp, finalMode ? 8 : 1, 1, finalMode ? 32 : 4),
    spin: clampNumber(input?.spin, 0.9, 0, 0.999, 5),
    camR: clampNumber(input?.camR, 60, 3, 220, 4),
    camTheta: clampNumber(input?.camTheta, 84, 1, 179, 4),
    camPhi: normalizeAngle(input?.camPhi, 0),
    fov: clampNumber(input?.fov, 45, 15, 110, 4),
    diskTemp: clampNumber(input?.diskTemp, 9000, 1500, 30000, 2),
    diskBright: clampNumber(input?.diskBright, 12, 0, 60, 4),
    diskOuter: clampNumber(input?.diskOuter, 22, 6, 90, 4),
    diskNoise: clampNumber(input?.diskNoise, 0.45, 0, 1, 4),
    diskThick: clampNumber(input?.diskThick, 0.5, 0.02, 5, 4),
    diskFlare: clampNumber(input?.diskFlare, 0.05, 0, 0.5, 4),
    diskAbsorb: clampNumber(input?.diskAbsorb, 0.4, 0, 5, 4),
    skyBright: clampNumber(input?.skyBright, 1, 0, 5, 4),
    exposure: clampNumber(input?.exposure, 1, 0.05, 10, 4),
    thin: Boolean(input?.thin),
    noDoppler: Boolean(input?.noDoppler)
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

function buildRenderArgs(settings, outputPath, starmapPath) {
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
    '--sky-bright', String(settings.skyBright),
    '--exposure', String(settings.exposure),
    '--tol', settings.mode === 'final' ? '1e-7' : '2e-6',
    '-o', outputPath
  ];

  if (starmapPath) {
    args.push('--starmap', starmapPath);
  }
  if (settings.thin) {
    args.push('--thin');
  }
  if (settings.noDoppler) {
    args.push('--no-doppler');
  }

  return args;
}

function runRenderer(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(binaryPath, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
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

function enqueueRender(task) {
  const queuedTask = renderQueue.then(task, task);
  renderQueue = queuedTask.catch(() => undefined);
  return queuedTask;
}

async function handleRender(request, response) {
  if (!existsSync(binaryPath)) {
    sendJson(response, 503, {
      ok: false,
      error: `Renderer binary not found at ${binaryPath}. Build it with: cmake --build build -j`
    });
    return;
  }

  const body = await readJsonRequest(request);
  const settings = normalizeSettings(body);
  const starmapPath = findStarmap();
  const renderId = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const fileName = `${settings.mode}-${renderId}.png`;
  const outputPath = path.join(renderDir, fileName);
  const args = buildRenderArgs(settings, outputPath, starmapPath);
  const timeoutMs = settings.mode === 'final' ? 20 * 60 * 1000 : 4 * 60 * 1000;

  try {
    const result = await enqueueRender(() => runRenderer(args, timeoutMs));
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
    sendJson(response, 500, {
      ok: false,
      error: error instanceof Error ? error.message : 'Renderer failed',
      stdout: error?.stdout ?? '',
      stderr: error?.stderr ?? ''
    });
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
      'cache-control': cacheControl,
      'access-control-allow-origin': '*'
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendText(response, 404, 'Not found');
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
    ['.png', 'image/png']
  ]);
  await serveFile(response, filePath, contentTypes.get(extension) ?? 'application/octet-stream', 'public, max-age=3600');
}

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`);

  if (request.method === 'OPTIONS') {
    response.writeHead(204, {
      'access-control-allow-origin': '*',
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
        binaryExists: existsSync(binaryPath),
        binaryPath,
        starmap: starmapPath ? { name: path.basename(starmapPath) } : null,
        renderDir
      });
      return;
    }

    if (request.method === 'GET' && requestUrl.pathname === '/api/starmap') {
      const starmapPath = findStarmap();
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

server.listen(port, '127.0.0.1', () => {
  console.log(`Gargantua render API listening on http://127.0.0.1:${port}`);
  console.log(`Renderer binary: ${binaryPath}`);
});
