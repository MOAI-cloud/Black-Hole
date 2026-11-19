import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { copyFile, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

function call(url, options = {}, settings) {
  return new Promise((resolve, reject) => {
    const req = request(url, { ...options, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.once('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end(settings && JSON.stringify(settings));
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gargantua-viewer-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const serverDir = path.join(root, 'viewer', 'server');
  await mkdir(serverDir, { recursive: true });
  for (const module of ['render-server.mjs', 'renderer-paths.mjs', 'startup.mjs']) {
    await copyFile(new URL(module, import.meta.url), path.join(serverDir, module));
  }
  return root;
}

test('web-only launcher starts on an available port without CUDA', { timeout: 10000 }, async (t) => {
  const root = await fixture(t);
  await copyFile(new URL('../../play.mjs', import.meta.url), path.join(root, 'play.mjs'));
  // Represent a prebuilt viewer. This launch must not install packages or invoke CMake.
  for (const file of ['node_modules/typescript/bin/tsc', 'node_modules/vite/bin/vite.js', 'dist/index.html']) {
    const mock = path.join(root, 'viewer', file);
    await mkdir(path.dirname(mock), { recursive: true });
    await writeFile(mock, 'Gargantua');
  }
  const child = childProcess.spawn(process.execPath, [path.join(root, 'play.mjs'), '--web-only', '--no-open'], {
    env: { ...process.env, RENDER_API_PORT: '0' }, stdio: ['ignore', 'pipe', 'inherit']
  });
  const closed = once(child, 'exit');
  t.after(async () => { child.kill(); await closed; });
  let url;
  let output = '';
  for await (const chunk of child.stdout) {
    output += chunk;
    url = output.match(/running at (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
    if (url) break;
  }
  assert.ok(url, output);
  assert.equal((await call(url)).body.toString(), 'Gargantua');
  const health = JSON.parse((await call(url + '/api/health')).body);
  assert.equal(health.rendererAvailable, false);
  assert.equal((await call(url + '/api/render', { method: 'POST' })).status, 503);
  const foreign = await call(url + '/api/render', { method: 'POST', headers: { origin: 'https://external.example' } });
  assert.equal(foreign.status, 403);
  assert.equal(foreign.headers['access-control-allow-origin'], undefined);
  const local = await call(url + '/api/render', { method: 'OPTIONS', headers: { origin: 'http://localhost:5173' } });
  assert.equal(local.status, 204);
  assert.equal(local.headers['access-control-allow-origin'], 'http://localhost:5173');
});

test('startup reports progress, failure and readiness while keeping loading artwork available', async (t) => {
  const root = await fixture(t);
  const viewer = path.join(root, 'viewer');
  const art = Buffer.from('test loading image');
  for (const dir of ['public', 'dist']) {
    await mkdir(path.join(viewer, dir));
    await writeFile(path.join(viewer, dir, 'gargantua.webp'), art);
  }
  await writeFile(path.join(viewer, 'dist/index.html'), 'ready viewer');
  const { startup } = await import(pathToFileURL(path.join(viewer, 'server/startup.mjs')));
  Object.assign(startup, { ready: false, failed: false, step: 2, message: 'Building the viewer…' });
  process.env.RENDER_API_PORT = '0';
  const { server, viewerUrl } = await import(pathToFileURL(path.join(viewer, 'server/render-server.mjs')));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const status = async () => JSON.parse((await call(viewerUrl + '/api/startup')).body);
  const artwork = async () => {
    const response = await call(viewerUrl + '/gargantua.webp');
    assert.equal(response.headers['content-type'], 'image/webp');
    assert.deepEqual(response.body, art);
  };
  assert.deepEqual(await status(), startup);
  assert.match((await call(viewerUrl)).body.toString(), /<gargantua-loader launcher>/);
  assert.equal((await call(viewerUrl + '/api/render', { method: 'POST' })).status, 503);
  await artwork();
  Object.assign(startup, { failed: true, message: 'Startup failed.' });
  assert.deepEqual(await status(), startup);
  assert.match((await call(viewerUrl + '/index.html')).body.toString(), /gargantua-loader/);
  Object.assign(startup, { ready: true, failed: false });
  assert.deepEqual(await status(), startup);
  assert.equal((await call(viewerUrl)).body.toString(), 'ready viewer');
  await artwork();
});

test('abandoned jobs yield the GPU, transient refinements are removed, and captures remain retrievable',
  { timeout: 10000 }, async (t) => {
    const root = await fixture(t);
    const program = path.join(root, 'fixture-renderer.mjs');
    const jobs = [];
    await writeFile(program, `
      import { writeFile } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      const args = process.argv.slice(2);
      if (args[0] === '--device-info') console.log('Test GPU');
      else if (args[0] === '--help') console.log('--thin --photosphere --volume --companion');
      else {
        if (args[args.indexOf('--cam-phi') + 1] === '99') await delay(30000);
        await writeFile(args[args.indexOf('-o') + 1], Buffer.from('89504e470d0a1a0a', 'hex'));
      }
    `);
    // Use a real child and cancellation signals on every OS, without a CUDA toolkit.
    const spawn = childProcess.spawn;
    t.mock.method(childProcess, 'spawn', (exe, args, options) => {
      assert.equal(exe, program);
      jobs.push(args);
      return spawn(process.execPath, [program, ...args], options);
    });
    syncBuiltinESMExports();
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
    process.env.GARGANTUA_BIN = program;
    process.env.GARGANTUA_WEB_ONLY = '0';
    process.env.RENDER_API_PORT = '0';
    const { server, viewerUrl } = await import(pathToFileURL(path.join(root, 'viewer/server/render-server.mjs')));
    t.after(() => { server.close(); server.closeAllConnections(); });
    const post = (settings, accept, signal) => call(viewerUrl + '/api/render',
      { method: 'POST', headers: { 'content-type': 'application/json', accept }, signal }, settings);
    const active = new AbortController();
    const pending = new AbortController();
    const first = post({ camPhi: 99 }, 'application/json', active.signal).catch((e) => e);
    const deadline = Date.now() + 3000;
    while (!jobs.some((args) => args.includes('--cam-phi'))) {
      assert.ok(Date.now() < deadline, 'the first job should have started');
      await delay(10);
    }
    const second = post({ camPhi: 98 }, 'application/json', pending.signal).catch((e) => e);
    await delay(50);
    pending.abort();
    assert.equal((await second).name, 'AbortError');
    active.abort();
    assert.equal((await first).name, 'AbortError');

    const preview = await post({ width: 960, height: 2048, fov: 12, observerTime: 7.5, shutter: 6 }, 'image/png');
    assert.equal(preview.headers['content-type'], 'image/png');
    const pixels = preview.body;
    const args = jobs.at(-1);
    const value = (flag) => args[args.indexOf(flag) + 1];
    assert.deepEqual([value('--width'), value('--height'), value('--fov'), value('--time')], ['450', '960', '12', '7.5']);
    assert.equal(args.includes('--shutter'), false);
    assert.equal(args.includes('--cinematic'), false);
    assert.ok(args.includes('--volume'));
    assert.equal(value('--disk-noise'), '0.5');
    assert.equal(args.includes('--no-disk'), false);
    assert.equal(args.includes('--companion'), false);
    assert.equal(jobs.some((entry) => entry[entry.indexOf('--cam-phi') + 1] === '98'), false);

    await mkdir(path.join(root, 'skies'));
    const infraredPath = path.join(root, 'skies/infrared.ppm');
    const infrared = Buffer.concat([Buffer.from('P6\n1 1\n255\n'), Buffer.from([1, 2, 3])]);
    await writeFile(infraredPath, infrared);
    const selected = await call(viewerUrl + '/api/starmap?background=infrared');
    assert.equal(selected.headers['content-type'], 'image/x-portable-pixmap');
    assert.deepEqual(selected.body, infrared);
    assert.equal((await post({ background: 'unlisted' }, 'image/png')).status, 400);
    assert.equal((await post({ background: 'gamma-ray' }, 'image/png')).status, 503);
    const refine = await post({ mode: 'final', spp: 4, width: 1920, height: 1080, background: 'infrared', cinematic: true, photosphere: true }, 'image/png');
    assert.equal(refine.headers['content-type'], 'image/png');
    assert.deepEqual(refine.body, pixels);
    assert.equal(jobs.at(-1)[jobs.at(-1).indexOf('--starmap') + 1], infraredPath);
    assert.ok(jobs.at(-1).includes('--cinematic'));
    assert.ok(jobs.at(-1).includes('--photosphere'));
    // Dormant black holes and binary companions reach the native renderer.
    await post({ diskEnabled: false, companion: true, companionTheta: 90, companionPhi: 180, companionRadius: 0.1884,
      companionTemp: 5850, diskColorCorrection: 1.7, diskTemp: 1.08e7 }, 'image/png');
    const native = jobs.at(-1);
    const flag = (name) => native[native.indexOf(name) + 1];
    assert.ok(native.includes('--no-disk'));
    assert.deepEqual(native.slice(native.indexOf('--companion') + 1, native.indexOf('--companion') + 5), ['90', '180', '0.1884', '5850']);
    assert.equal(flag('--disk-color-correction'), '1.7');
    assert.equal(flag('--disk-temp'), '10800000');
    // The millimetre synchrotron image is WebGL-only.
    assert.equal((await post({ emission: 'synchrotron' }, 'image/png')).status, 409);
    assert.equal(jobs.at(-1).includes('--thin'), false);
    assert.equal((await post({ thin: true, photosphere: false }, 'image/png')).status, 200);
    assert.ok(jobs.at(-1).includes('--thin'));
    // Fit oversized requests in the 8K envelope and keep portrait orientation.
    for (const [w, h] of [[7680, 4320], [4320, 7680], [15360, 8640], [10000, 10000]]) {
      const { status } = await post({ mode: 'final', width: w, height: h, background: 'dark' }, 'image/png');
      assert.equal(status, 200);
      const job = jobs.at(-1);
      const expected = w === h ? [4320, 4320] : w > h ? [7680, 4320] : [4320, 7680];
      assert.deepEqual([Number(job[job.indexOf('--width') + 1]), Number(job[job.indexOf('--height') + 1])], expected);
      assert.equal(job[job.indexOf('--spp') + 1], '12');
    }
    const capture = JSON.parse((await post({ mode: 'final', spp: 64, background: 'dark', shutter: 120 }, 'application/json')).body);
    assert.equal(capture.ok, true);
    assert.equal(capture.settings.spp, 64);
    assert.deepEqual([capture.render.width, capture.render.height], [3840, 2160]);
    assert.equal(capture.settings.background, 'dark');
    assert.equal(jobs.at(-1).includes('--starmap'), false);
    assert.equal(jobs.at(-1)[jobs.at(-1).indexOf('--shutter') + 1], '64');
    const saved = await call(viewerUrl + capture.render.url);
    assert.deepEqual(saved.body, pixels);
    assert.deepEqual(await readdir(path.join(root, 'viewer/renders')), [path.basename(capture.render.url)]);
  });
