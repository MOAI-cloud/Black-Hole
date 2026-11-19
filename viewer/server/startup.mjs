import { readFile } from 'node:fs/promises';

// Direct API/dev-server launches are ready immediately. The desktop launcher
// changes this state before importing the HTTP server.
export const startup = { ready: true, failed: false, step: 1, message: 'Starting the simulator…' };

const shell = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#070809"><title>Gargantua · Black hole simulator</title>
<link rel="preload" as="image" href="/gargantua-preview.webp"><link rel="stylesheet" href="/loading.css"><script defer src="/loading.js"></script></head>
<body style="margin:0;background:#070809;color:#f5ede2"><gargantua-loader launcher>Loading Gargantua…</gargantua-loader></body></html>`;
const assets = new Map([
  ['/loading.css', 'text/css; charset=utf-8'], ['/loading.js', 'text/javascript; charset=utf-8'],
  ['/gargantua.webp', 'image/webp'], ['/gargantua-preview.webp', 'image/webp']
]);

export async function serveStartup(request, response, pathname) {
  if (pathname === '/api/startup' && request.method === 'GET') {
    response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify(startup));
    return true;
  }
  if (startup.ready) return false;
  let body = '';
  let code = 200;
  let type = 'text/html; charset=utf-8';
  if (request.method === 'GET' && ['/', '/index.html'].includes(pathname)) {
    body = shell;
  } else if (request.method === 'GET' && assets.has(pathname)) {
    type = assets.get(pathname);
    try { body = await readFile(new URL('../public' + pathname, import.meta.url)); }
    catch { code = 404; }
  } else {
    code = 503;
    type = 'application/json';
    body = JSON.stringify({ error: startup.message });
  }
  response.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  response.end(body);
  return true;
}
