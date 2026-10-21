'use strict';
// End-to-end: real server + real headless Chrome against the fixture shop.
// Run with `npm test` (needs the browser from `npm run setup`).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const fixture = require('./fixture-server');

const APP_PORT = 39000 + Math.floor(Math.random() * 900);
const BASE = `http://127.0.0.1:${APP_PORT}`;
let shop;
let proc;
let dataDir;

async function call(method, url, body) {
  const res = await fetch(BASE + url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test.before(async () => {
  shop = await fixture.start();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedgen-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir, MIN_REFRESH_MS: '1000', SCHEDULER_TICK_MS: '500' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => /running at/.test(String(d)) && resolve());
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});

test.after(async () => {
  proc.kill('SIGTERM');
  shop.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let feedId;

test('serves the web app', async () => {
  const res = await fetch(BASE + '/');
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Feed Generator/);
  assert.equal((await fetch(BASE + '/../server.js')).status === 200, false);
});

test('no feeds initially', async () => {
  const { json } = await call('GET', '/api/feeds');
  assert.deepEqual(json.feeds, []);
});

test('analyze: finds the JS-rendered product grid confidently and ignores decoys', async () => {
  const { status, json } = await call('POST', '/api/analyze', { url: shop.url + '/' });
  assert.equal(status, 200);
  assert.equal(json.confident, true, json.reason);
  const best = json.candidates[0];
  assert.equal(best.count, 12);
  assert.equal(best.id, json.recommended);
  const first = best.preview[0];
  assert.match(first.title, /^[A-Z][a-z]+ [A-Za-z]+ 12$/); // newest first
  assert.equal(first.image, shop.url + '/img/12.svg'); // lazy data-src, not the 1px placeholder
  assert.match(first.price, /€\s?\d+,\d{2}/);
  assert.match(first.delivery, /deliver/i);
  assert.ok(first.url.startsWith(shop.url + '/p/12'));
});

test('analyze: an expected item count the page cannot satisfy asks the user', async () => {
  const { json } = await call('POST', '/api/analyze', { url: shop.url + '/', expectedCount: 40 });
  assert.equal(json.confident, false);
  assert.match(json.reason, /expected at least 40/);
  assert.ok(json.candidates.length > 0);
});

test('analyze: validates input', async () => {
  assert.equal((await call('POST', '/api/analyze', { url: '' })).status, 400);
  assert.equal((await call('POST', '/api/analyze', { url: 'ftp://x.y' })).status, 400);
  assert.equal((await call('POST', '/api/analyze', { url: shop.url, expectedCount: 'abc' })).status, 400);
});

test('create feed, persist to disk, list it', async () => {
  const a = (await call('POST', '/api/analyze', { url: shop.url + '/', expectedCount: 10 })).json;
  assert.equal(a.confident, true);
  const { status, json } = await call('POST', '/api/feeds', { sessionId: a.sessionId, candidateId: a.recommended, name: 'Sneakers', url: shop.url + '/', expectedCount: 10 });
  assert.equal(status, 201);
  feedId = json.feed.id;
  assert.equal(json.feed.items.length, 12);
  assert.equal(json.feed.name, 'Sneakers');
  assert.ok(fs.existsSync(path.join(dataDir, 'feeds', feedId + '.json')));
  const list = (await call('GET', '/api/feeds')).json.feeds;
  assert.equal(list.length, 1);
  assert.equal(list[0].itemCount, 12);
  assert.equal(list[0].newCount, 0);
  assert.equal(list[0].expectedCount, 10);
});

test('refresh without changes adds nothing (deduplicated)', async () => {
  const { json } = await call('POST', `/api/feeds/${feedId}/refresh`);
  assert.equal(json.added, 0);
  assert.equal(json.found, 12);
  assert.equal(json.feed.items.length, 12);
});

test('refresh with new products adds only the new ones, newest first', async () => {
  const before = (await call('GET', `/api/feeds/${feedId}`)).json.feed;
  const firstSeen = Object.fromEntries(before.items.map((i) => [i.id, i.firstSeen]));
  await fetch(shop.url + '/__add?n=3', { method: 'POST' });
  const { json } = await call('POST', `/api/feeds/${feedId}/refresh`);
  assert.equal(json.added, 3);
  assert.equal(json.feed.items.length, 15);
  assert.deepEqual(json.feed.items.slice(0, 3).map((i) => i.title.split(' ').pop()), ['15', '14', '13']);
  for (const it of json.feed.items.slice(3)) assert.equal(it.firstSeen, firstSeen[it.id]);
  const sum = (await call('GET', '/api/feeds')).json.feeds[0];
  assert.equal(sum.newCount, 3);
});

test('wanted phrases (global + per feed) feed the global Wanted list', async () => {
  assert.equal((await call('PUT', '/api/settings/wanted', { phrases: 'nope' })).status, 400);
  assert.equal((await call('PUT', '/api/settings/wanted', { phrases: ['x'.repeat(81)] })).status, 400);
  const set = await call('PUT', '/api/settings/wanted', { phrases: ['  kite   low ', '', 'Kite Low', 'zzz nothing'] });
  assert.deepEqual(set.json.phrases, ['kite low', 'zzz nothing']);

  let w = (await call('GET', '/api/wanted')).json;
  assert.deepEqual(w.phrases, ['kite low', 'zzz nothing']);
  assert.equal(w.items.length, 1);
  assert.match(w.items[0].title, /^Kite Low 12$/);
  assert.equal(w.items[0].feedId, feedId);
  assert.equal(w.items[0].feedName, 'Sneakers');
  assert.equal(w.items[0].matchedBy, 'kite low');
  let list = (await call('GET', '/api/feeds')).json;
  assert.equal(list.wanted.count, 1);

  assert.equal((await call('PUT', `/api/feeds/${feedId}/wanted`, { phrases: ['harbour slip'] })).status, 200); // typo on purpose
  w = (await call('GET', '/api/wanted')).json;
  assert.deepEqual(w.items.map((i) => i.title).sort(), ['Harbor Slip 9', 'Kite Low 12']);
  const feed = (await call('GET', `/api/feeds/${feedId}`)).json.feed;
  assert.deepEqual(feed.wanted, ['harbour slip']);
  list = (await call('GET', '/api/feeds')).json;
  assert.deepEqual(list.feeds[0].wanted, ['harbour slip']);
  assert.equal((await call('PUT', '/api/feeds/0123456789abcdef/wanted', { phrases: [] })).status, 404);

  await call('PUT', '/api/settings/wanted', { phrases: [] });
  await call('PUT', `/api/feeds/${feedId}/wanted`, { phrases: [] });
  assert.equal((await call('GET', '/api/wanted')).json.items.length, 0);
});

test('stars persist, survive refreshes and are validated', async () => {
  const feed = (await call('GET', `/api/feeds/${feedId}`)).json.feed;
  const target = feed.items[4];
  assert.equal((await call('POST', `/api/feeds/${feedId}/star`, { itemId: target.id, starred: true })).status, 200);
  let after = (await call('GET', `/api/feeds/${feedId}`)).json.feed;
  assert.equal(after.items.find((i) => i.id === target.id).starred, true);
  assert.equal(after.items.filter((i) => i.starred).length, 1);
  assert.equal((await call('GET', '/api/feeds')).json.feeds[0].starredCount, 1);

  const refreshed = (await call('POST', `/api/feeds/${feedId}/refresh`)).json.feed;
  assert.equal(refreshed.items.find((i) => i.id === target.id).starred, true, 'star survives a refresh');

  assert.equal((await call('POST', `/api/feeds/${feedId}/star`, { itemId: target.id, starred: false })).status, 200);
  after = (await call('GET', `/api/feeds/${feedId}`)).json.feed;
  assert.equal(after.items.filter((i) => i.starred).length, 0);
  assert.equal((await call('POST', `/api/feeds/${feedId}/star`, { itemId: 'u:missing', starred: true })).status, 404);
  assert.equal((await call('POST', `/api/feeds/${feedId}/star`, { itemId: target.id })).status, 400);
});

test('ignore rules (global + per feed, phrase or regex) hide items everywhere', async () => {
  assert.equal((await call('PUT', '/api/settings/ignored', { phrases: ['/(/'] })).status, 400);
  assert.equal((await call('PUT', `/api/feeds/${feedId}/ignored`, { phrases: ['/x/qq'] })).status, 400);
  assert.deepEqual((await call('PUT', '/api/settings/ignored', { phrases: ['/kite\\s+low/i'] })).json.phrases, ['/kite\\s+low/i']);
  assert.equal((await call('PUT', `/api/feeds/${feedId}/ignored`, { phrases: ['jet lyte'] })).status, 200); // fuzzy typo

  let list = (await call('GET', '/api/feeds')).json;
  assert.deepEqual(list.ignored.phrases, ['/kite\\s+low/i']);
  assert.equal(list.feeds[0].hiddenCount, 2); // Kite Low 12 (global regex) + Jet Lite 11 (feed phrase)
  assert.deepEqual(list.feeds[0].ignored, ['jet lyte']);

  await call('PUT', '/api/settings/wanted', { phrases: ['kite low', 'jet lite', 'ion sprint'] });
  const w = (await call('GET', '/api/wanted')).json;
  assert.deepEqual(w.items.map((i) => i.title), ['Ion Sprint 10'], 'ignored items never show up as wanted');

  for (const url of ['/api/settings/wanted', '/api/settings/ignored', `/api/feeds/${feedId}/ignored`]) await call('PUT', url, { phrases: [] });
  assert.equal((await call('GET', '/api/feeds')).json.feeds[0].hiddenCount, 0);
});

test('image proxy caches images on disk', async () => {
  const feed = (await call('GET', `/api/feeds/${feedId}`)).json.feed;
  const img = feed.items[0].image;
  const res = await fetch(`${BASE}/img?u=${encodeURIComponent(img)}&r=${encodeURIComponent(shop.url)}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/svg+xml');
  assert.match(await res.text(), /<svg/);
  assert.ok(fs.readdirSync(path.join(dataDir, 'images')).length >= 2);
  // served from cache even when the origin is gone
  const bad = await fetch(`${BASE}/img?u=${encodeURIComponent('http://127.0.0.1:1/nothing.png')}`);
  assert.equal(bad.status, 502);
});

test('hard page: asks for help, then an example item resolves it', async () => {
  const a = (await call('POST', '/api/analyze', { url: shop.url + '/hard' })).json;
  assert.equal(a.confident, false);
  assert.ok(a.candidates.length >= 1);
  const ex = (await call('POST', '/api/analyze', { url: shop.url + '/hard', sessionId: a.sessionId, exampleHtml: '<li><a href="/x/1">Plain item 1</a> <span>10</span></li>' })).json;
  assert.equal(ex.sessionId, a.sessionId, 'the cached page is reused');
  assert.equal(ex.example.count, 8);
  assert.equal(ex.example.source, 'example');
  const created = await call('POST', '/api/feeds', { sessionId: a.sessionId, candidateId: ex.example.id, name: 'Plain', url: shop.url + '/hard' });
  assert.equal(created.status, 201);
  assert.equal(created.json.feed.items.length, 8);
  assert.equal(created.json.feed.items[0].title, 'Plain item 1');
  const refreshed = await call('POST', `/api/feeds/${created.json.feed.id}/refresh`);
  assert.equal(refreshed.json.added, 0);
  await call('DELETE', `/api/feeds/${created.json.feed.id}`);
});

test('example that matches nothing gives a helpful message', async () => {
  const a = (await call('POST', '/api/analyze', { url: shop.url + '/hard' })).json;
  const ex = (await call('POST', '/api/analyze', { url: shop.url + '/hard', sessionId: a.sessionId, exampleHtml: '<section><video></video><canvas></canvas></section>' })).json;
  assert.equal(ex.example, null);
  assert.match(ex.message, /resembled/);
});

test('fix pattern replaces the selector and keeps existing items', async () => {
  const a = (await call('POST', '/api/analyze', { url: shop.url + '/' })).json;
  const { status, json } = await call('POST', `/api/feeds/${feedId}/pattern`, { sessionId: a.sessionId, candidateId: a.recommended });
  assert.equal(status, 200);
  assert.equal(json.feed.items.length, 15);
});

test('a broken selector is recovered from the stored sample', async () => {
  const file = path.join(dataDir, 'feeds', feedId + '.json');
  const feed = JSON.parse(fs.readFileSync(file, 'utf8'));
  feed.pattern.selector = 'div.does-not-exist > span';
  fs.writeFileSync(file, JSON.stringify(feed));
  const { status, json } = await call('POST', `/api/feeds/${feedId}/refresh`);
  assert.equal(status, 200);
  assert.equal(json.found, 15);
  assert.notEqual(json.feed.pattern.selector, 'div.does-not-exist > span');
});

test('unreachable site: error is reported and stored items survive', async () => {
  const file = path.join(dataDir, 'feeds', feedId + '.json');
  const feed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const saved = feed.url;
  feed.url = 'http://127.0.0.1:1/';
  fs.writeFileSync(file, JSON.stringify(feed));
  const { status, json } = await call('POST', `/api/feeds/${feedId}/refresh`);
  assert.equal(status, 502);
  assert.ok(json.error);
  const after = (await call('GET', `/api/feeds/${feedId}`)).json.feed;
  assert.equal(after.items.length, 15);
  assert.equal(after.lastFetch.ok, false);
  after.url = saved;
  fs.writeFileSync(file, JSON.stringify(after));
});

test('rejects cross-origin requests and bad hosts', async () => {
  const evil = await fetch(BASE + '/api/feeds', { method: 'POST', headers: { origin: 'http://evil.example' } });
  assert.equal(evil.status, 403);
  const status = await new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: APP_PORT, path: '/api/feeds', headers: { host: 'evil.example' } }, (r) => {
      r.resume();
      resolve(r.statusCode);
    });
  });
  assert.equal(status, 403);
});

async function newFeed(name) {
  const a = (await call('POST', '/api/analyze', { url: shop.url + '/' })).json;
  const { json } = await call('POST', '/api/feeds', { sessionId: a.sessionId, candidateId: a.recommended, name, url: shop.url + '/' });
  return json.feed;
}

test('feed settings are validated; new feeds default to 1000 stored items and no auto refresh', async () => {
  const feed = await newFeed('Settings');
  const sum = (await call('GET', '/api/feeds')).json.feeds.find((f) => f.id === feed.id);
  assert.equal(sum.maxItems, 1000);
  assert.equal(sum.autoRefresh.enabled, false);
  const put = (body) => call('PUT', `/api/feeds/${feed.id}/settings`, body);
  assert.equal((await put({ maxItems: 0 })).status, 400);
  assert.equal((await put({ maxItems: 'abc' })).status, 400);
  assert.equal((await put({ maxItems: 1.5 })).status, 400);
  assert.equal((await put({ autoRefresh: { enabled: true, interval: '' } })).status, 400);
  assert.equal((await put({ autoRefresh: { enabled: true, interval: 'soon' } })).status, 400);
  assert.equal((await put({ autoRefresh: { enabled: true, interval: '0s' } })).status, 400);
  assert.equal((await put({ autoRefresh: { enabled: true, interval: '400d' } })).status, 400);
  const ok = await put({ maxItems: null, autoRefresh: { enabled: false, interval: '5m' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.feed.autoRefresh.intervalMs, 300000);
  assert.equal((await call('GET', '/api/feeds')).json.feeds.find((f) => f.id === feed.id).maxItems, null);
  assert.equal((await put({})).status, 200);
  assert.equal((await call('PUT', '/api/feeds/0123456789abcdef/settings', { maxItems: 5 })).status, 404);
  await call('DELETE', `/api/feeds/${feed.id}`);
});

test('max items: oldest are discarded, starred are kept, discarded items do not come back', async () => {
  const feed = await newFeed('Trim'); // the shop lists 15 products at this point
  const items = feed.items;
  assert.ok(items.length >= 15);
  const oldest = items[items.length - 1];
  await call('POST', `/api/feeds/${feed.id}/star`, { itemId: oldest.id, starred: true });

  const trimmed = (await call('PUT', `/api/feeds/${feed.id}/settings`, { maxItems: 5 })).json.feed;
  assert.equal(trimmed.items.length, 5);
  assert.deepEqual(trimmed.items.slice(0, 4).map((i) => i.id), items.slice(0, 4).map((i) => i.id), 'newest kept');
  assert.equal(trimmed.items[4].id, oldest.id, 'starred item survives although it is the oldest');
  assert.ok(trimmed.discarded.length >= items.length - 5);

  // The site still lists everything: a refresh must neither re-add discarded items nor report them as new.
  const r = (await call('POST', `/api/feeds/${feed.id}/refresh`)).json;
  assert.equal(r.added, 0);
  assert.equal(r.feed.items.length, 5);

  // A genuinely new product arrives: it is added and pushes out the oldest non-starred item.
  await fetch(shop.url + '/__add?n=1', { method: 'POST' });
  const r2 = (await call('POST', `/api/feeds/${feed.id}/refresh`)).json;
  assert.equal(r2.added, 1);
  assert.equal(r2.feed.items.length, 5);
  assert.ok(r2.feed.items[0].seq > r2.feed.items[1].seq);
  assert.ok(r2.feed.items.some((i) => i.id === oldest.id));
  await call('DELETE', `/api/feeds/${feed.id}`);
});

test('auto refresh runs in the background at the configured interval', async () => {
  const feed = await newFeed('Auto');
  const before = feed.items.length;
  const set = await call('PUT', `/api/feeds/${feed.id}/settings`, { autoRefresh: { enabled: true, interval: '1s' } });
  assert.equal(set.json.feed.autoRefresh.intervalMs, 1000);
  await fetch(shop.url + '/__add?n=2', { method: 'POST' });
  let got = before;
  for (let i = 0; i < 60 && got < before + 2; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    got = (await call('GET', `/api/feeds/${feed.id}`)).json.feed.items.length;
  }
  assert.equal(got, before + 2, 'two new items were picked up without any request to refresh');
  await call('PUT', `/api/feeds/${feed.id}/settings`, { autoRefresh: { enabled: false, interval: '1s' } });
  await call('DELETE', `/api/feeds/${feed.id}`);
});

test('delete feed', async () => {
  assert.equal((await call('DELETE', `/api/feeds/${feedId}`)).status, 200);
  assert.equal((await call('GET', `/api/feeds/${feedId}`)).status, 404);
  assert.equal((await call('GET', '/api/feeds/..%2f..%2fetc')).status, 404);
  assert.deepEqual((await call('GET', '/api/feeds')).json.feeds, []);
});
