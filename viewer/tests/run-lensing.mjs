// Run the production WebGL shaders in an installed Chromium-family browser.
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../', import.meta.url));
const names = process.platform === 'win32' ? ['chrome.exe', 'msedge.exe']
  : ['chromium', 'chromium-browser', 'google-chrome', 'microsoft-edge', 'msedge'];
const candidates = process.env.CHROME_BIN ? [process.env.CHROME_BIN] : [
  ...names.flatMap(name => (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name))),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  path.join(process.env.ProgramFiles ?? '', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env['ProgramFiles(x86)'] ?? '', 'Microsoft/Edge/Application/msedge.exe'),
];
let browser;
for (const candidate of candidates) {
  try {
    await access(candidate, constants.X_OK);
    browser = candidate;
    break;
  } catch { /* Try the next executable. */ }
}
if (!browser) throw new Error('Set CHROME_BIN to an installed Chromium, Google Chrome or Microsoft Edge executable.');

const profile = await mkdtemp(path.join(tmpdir(), 'gargantua-shadow-'));
let server, child, timeout;
try {
  let settle;
  const completion = new Promise(resolve => { settle = resolve; });
  server = await createServer({
    root, configFile: false, logLevel: 'error',
    server: { host: '127.0.0.1', port: 41713, strictPort: false },
    optimizeDeps: { entries: ['tests/shadow.html'] },
    plugins: [{
      name: 'shadow-test-result',
      configureServer(vite) {
        vite.middlewares.use('/__shadow_result', async (req, res) => {
          if (req.method !== 'POST') { res.writeHead(405).end(); return; }
          let body = '';
          for await (const chunk of req) body += chunk;
          res.writeHead(204).end();
          settle(JSON.parse(body));
        });
      }
    }]
  });
  await server.listen();
  const port = server.httpServer.address().port;
  const args = ['--headless', '--enable-gpu', '--enable-unsafe-swiftshader', '--no-first-run',
    '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    `--user-data-dir=${profile}`, `http://127.0.0.1:${port}/tests/shadow.html?report`];
  const software = process.env.GARGANTUA_TEST_SOFTWARE === '1';
  if (software) args.unshift('--use-gl=angle', '--use-angle=swiftshader');
  child = spawn(browser, args, { stdio: 'ignore' });
  child.once('error', error => settle({ status: 'failed', message: error.message }));
  child.once('exit', code => settle({ status: 'failed', message: `Browser exited with code ${code}` }));
  const seconds = software ? 300 : 90;
  timeout = setTimeout(() => settle({ status: 'failed', message: `Browser shadow regression timed out after ${seconds} seconds.` }), seconds * 1000);
  const result = await completion;
  if (result.status !== 'passed') throw new Error(result.message);
  console.log(result.message);
} finally {
  clearTimeout(timeout);
  child?.kill();
  await server?.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
