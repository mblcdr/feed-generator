'use strict';
// Feed Generator - local web app. Start with `npm start`, then open http://localhost:3000

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const store = require('./lib/store');
const images = require('./lib/images');
const service = require('./lib/service');
const scheduler = require('./lib/scheduler');
const sync = require('./lib/sync');
const { closeBrowser, findBrowser, FetchError } = require('./lib/fetcher');

const PORT = parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0'; // reachable from the local network; HOST=127.0.0.1 for this computer only
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
// Extra Host header values to accept (e.g. a LAN name when running in Docker): ALLOWED_HOSTS="nas.local:3000,192.168.1.5:3000" or "*".
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS === undefined ? 'lan' : process.env.ALLOWED_HOSTS).split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);
// The keyword "lan" in ALLOWED_HOSTS accepts local-network Host values: private IPv4 addresses (10/8, 172.16/12, 192.168/16, link-local,
// 100.64/10 as used by Tailscale), single-label names (nas:3000) and *.local / *.lan / *.home.arpa. IP literals can't be DNS-rebound.
const LAN_HOST_RE = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+|[a-z0-9-]+|[a-z0-9.-]+\.(local|lan|home\.arpa))(:\d+)?$/i;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(data),
    'cache-control': 'no-store',
  });
  res.end(data);
}

function readJson(req, limit = 3 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new service.HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new service.HttpError(400, 'Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

/** Refuse requests that don't originate from this app (DNS rebinding / cross-site requests). */
function guard(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!LOCAL_HOST_RE.test(host) && !ALLOWED_HOSTS.includes('*') && !ALLOWED_HOSTS.includes(host) && !(ALLOWED_HOSTS.includes('lan') && LAN_HOST_RE.test(host))) {
    throw new service.HttpError(403, 'Forbidden host. Set ALLOWED_HOSTS to the address you use to open the app.');
  }
  const origin = req.headers.origin;
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === req.headers.host;
    } catch {
      /* invalid origin */
    }
    if (!ok) throw new service.HttpError(403, 'Cross-origin requests are not allowed.');
  }
}

async function serveImage(url, res) {
  const target = url.searchParams.get('u') || '';
  const referer = url.searchParams.get('r') || undefined;
  try {
    const { file, type } = await images.getImage(target, referer);
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    res.writeHead(502, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('Image unavailable: ' + e.message);
  }
}

function serveStatic(url, res) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    fs.createReadStream(file).pipe(res);
  });
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method;
  let m;

  if (pathname === '/api/status' && method === 'GET') {
    return sendJson(res, 200, { browser: !!(await findBrowser()) });
  }
  if (pathname === '/api/feeds' && method === 'GET') {
    return sendJson(res, 200, await service.listSummaries());
  }
  if (pathname === '/api/wanted' && method === 'GET') {
    return sendJson(res, 200, await service.getWanted());
  }
  if (pathname === '/api/settings/wanted' && method === 'PUT') {
    const body = await readJson(req);
    return sendJson(res, 200, { phrases: await service.setGlobalList('wanted', body.phrases) });
  }
  if (pathname === '/api/settings/ignored' && method === 'PUT') {
    const body = await readJson(req);
    return sendJson(res, 200, { phrases: await service.setGlobalList('ignored', body.phrases) });
  }
  if (pathname === '/api/sync' && method === 'GET') {
    return sendJson(res, 200, await sync.listPeers());
  }
  if (pathname === '/api/sync/peers' && method === 'PUT') {
    return sendJson(res, 200, await sync.setPeers((await readJson(req)).peers));
  }
  if (pathname === '/api/sync/now' && method === 'POST') {
    await sync.syncNow();
    return sendJson(res, 200, await sync.listPeers());
  }
  if (pathname === '/api/sync/exchange' && method === 'POST') {
    return sendJson(res, 200, await sync.exchange(await readJson(req, 50 * 1024 * 1024)));
  }
  if (pathname === '/api/analyze' && method === 'POST') {
    return sendJson(res, 200, await service.analyze(await readJson(req)));
  }
  if (pathname === '/api/feeds' && method === 'POST') {
    const feed = await service.createFeed(await readJson(req));
    return sendJson(res, 201, { feed });
  }
  if ((m = /^\/api\/feeds\/([a-f0-9]+)$/.exec(pathname))) {
    if (method === 'GET') return sendJson(res, 200, { feed: await service.getFeed(m[1]) });
    if (method === 'PUT') return sendJson(res, 200, await service.updateFeed(m[1], await readJson(req)));
    if (method === 'DELETE') {
      await service.removeFeed(m[1]);
      return sendJson(res, 200, { ok: true });
    }
  }
  if ((m = /^\/api\/feeds\/([a-f0-9]+)\/refresh$/.exec(pathname)) && method === 'POST') {
    const body = await readJson(req);
    const { feed, added, found } = await service.refreshFeed(m[1], { backfill: body.backfill === true });
    return sendJson(res, 200, { feed, added, found });
  }
  if ((m = /^\/api\/feeds\/([a-f0-9]+)\/wanted$/.exec(pathname)) && method === 'PUT') {
    const body = await readJson(req);
    return sendJson(res, 200, { phrases: await service.setFeedList(m[1], 'wanted', body.phrases) });
  }
  if ((m = /^\/api\/feeds\/([a-f0-9]+)\/ignored$/.exec(pathname)) && method === 'PUT') {
    const body = await readJson(req);
    return sendJson(res, 200, { phrases: await service.setFeedList(m[1], 'ignored', body.phrases) });
  }
  if ((m = /^\/api\/feeds\/([a-f0-9]+)\/settings$/.exec(pathname)) && method === 'PUT') {
    return sendJson(res, 200, { feed: await service.setFeedSettings(m[1], await readJson(req)) });
  }
  if ((m = /^\/api\/feeds\/([a-f0-9]+)\/star$/.exec(pathname)) && method === 'POST') {
    const body = await readJson(req);
    return sendJson(res, 200, await service.setStar(m[1], body.itemId, body.starred));
  }
  if ((m = /^\/api\/feeds\/([a-f0-9]+)\/pattern$/.exec(pathname)) && method === 'POST') {
    const feed = await service.updatePattern(m[1], await readJson(req));
    return sendJson(res, 200, { feed });
  }
  throw new service.HttpError(404, 'Unknown API route.');
}

const server = http.createServer(async (req, res) => {
  try {
    guard(req);
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/img' && req.method === 'GET') return await serveImage(url, res);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      // A configuration edit is passed on to the other instances (see lib/sync.js); refreshes and stars are not configuration.
      if (req.method !== 'GET' && !/\/(analyze|refresh|star|now|exchange)$|\/peers$/.test(url.pathname)) sync.schedulePush();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') throw new service.HttpError(405, 'Method not allowed.');
    return serveStatic(url, res);
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500 && !(e instanceof FetchError)) console.error(e);
    if (!res.headersSent) sendJson(res, status, { error: e.message || 'Internal error' });
    else res.end();
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Start with another one, e.g.  PORT=3001 npm start`);
  else console.error(e);
  process.exit(1);
});

store.ensureDirs().then(() => {
  server.listen(PORT, HOST, async () => {
    console.log(`Feed Generator running at http://${HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
    if (HOST !== '127.0.0.1') console.log('Reachable from the local network (no login: trusted networks only). HOST=127.0.0.1 limits it to this computer.');
    console.log(`Data directory: ${store.DATA_DIR}`);
    scheduler.start();
    sync.start();
    const browser = await findBrowser();
    if (browser) console.log(`Browser: ${browser}`);
    else console.warn('\n! No Chrome/Chromium found. Run "npm run setup" (or set CHROME_PATH) before adding feeds.\n');
  });
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  scheduler.stop();
  sync.stop();
  server.close();
  await closeBrowser();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
