'use strict';
// End-to-end: paging (second page address), crawling further pages and editing feeds.
// Real server + real headless Chrome against the paged fixture shop (6 items per page, 20 items).

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
  return { status: res.status, json: await res.json().catch(() => null) };
}

test.before(async () => {
  shop = await fixture.start();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feedgen-paging-'));
  proc = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(APP_PORT), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => /running at/.test(String(d)) && resolve());
    proc.on('exit', (c) => reject(new Error('server exited ' + c)));
  });
});

test.after(() => {
  proc.kill('SIGTERM');
  shop.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Analyze + create a feed (page 1 only); returns the created feed. */
async function create(name, url, extra = {}) {
  const a = (await call('POST', '/api/analyze', { url, ...extra })).json;
  assert.equal(a.confident, true, a.reason);
  const { status, json } = await call('POST', '/api/feeds', { sessionId: a.sessionId, candidateId: a.recommended, name, url, ...extra });
  assert.equal(status, 201, JSON.stringify(json));
  return json.feed;
}

const num = (i) => Number(i.title.split(' ').pop());

test('analyze: reports where the next pages will come from and rejects unusable second addresses', async () => {
  const { status, json } = await call('POST', '/api/analyze', { url: shop.url + '/paged', pagingUrl: shop.url + '/paged?page=2', expectedCount: 100 });
  assert.equal(status, 200);
  assert.equal(json.confident, true, 'the expected number is spread over several pages, a single page may hold fewer');
  assert.equal(json.paging.page3, shop.url + '/paged?page=3');
  assert.equal(json.paging.page4, shop.url + '/paged?page=4');
  // relative and scheme-less second addresses
  assert.equal((await call('POST', '/api/analyze', { url: shop.url + '/paged', pagingUrl: '?page=2' })).json.paging.page3, shop.url + '/paged?page=3');
  assert.equal((await call('POST', '/api/analyze', { url: shop.url + '/paged', pagingUrl: shop.url.replace('http://', '') + '/paged/page/2/' })).json.paging.page3, shop.url + '/paged/page/3/');
  for (const bad of [shop.url + '/paged', shop.url + '/hard', 'http://elsewhere.invalid/paged?page=2']) {
    const r = await call('POST', '/api/analyze', { url: shop.url + '/paged', pagingUrl: bad });
    assert.equal(r.status, 400, bad);
    assert.ok(r.json.error);
  }
});

let feedId;

test('create with paging, then a backfill refresh pages on until the number of items is reached', async () => {
  const feed = await create('Paged', shop.url + '/paged', { pagingUrl: shop.url + '/paged?page=2', expectedCount: 15 });
  feedId = feed.id;
  assert.equal(feed.items.length, 6);
  assert.equal(feed.paging.secondUrl, shop.url + '/paged?page=2');

  const { json } = await call('POST', `/api/feeds/${feedId}/refresh`, { backfill: true });
  assert.equal(json.feed.items.length, 18, 'three pages of 6: the third page reaches 15');
  assert.equal(json.feed.lastFetch.pages, 3);
  assert.equal(json.added, 12);
  assert.deepEqual(json.feed.items.map(num), [20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
  const sum = (await call('GET', '/api/feeds')).json.feeds[0];
  assert.equal(sum.newCount, 0, 'paged-in history is not news');
  assert.equal(sum.pagingUrl, shop.url + '/paged?page=2');
});

test('a normal refresh stops at the first page that shows known items', async () => {
  const { json } = await call('POST', `/api/feeds/${feedId}/refresh`);
  assert.equal(json.added, 0);
  assert.equal(json.feed.lastFetch.pages, 1);
  assert.equal(json.feed.items.length, 18);
});

test('new items on page 1 are added, known items on that page end the crawl, they are "New"', async () => {
  await fetch(shop.url + '/__add-paged?n=3', { method: 'POST' });
  const { json } = await call('POST', `/api/feeds/${feedId}/refresh`);
  assert.equal(json.added, 3);
  assert.equal(json.feed.lastFetch.pages, 1);
  assert.deepEqual(json.feed.items.slice(0, 4).map(num), [23, 22, 21, 20]);
  assert.equal((await call('GET', '/api/feeds')).json.feeds[0].newCount, 3);
});

test('paging works with numbers in the path, without a number of items, until the list ends', async () => {
  const feed = await create('Path paging', shop.url + '/paged/page/1/', { pagingUrl: shop.url + '/paged/page/2/' });
  assert.equal(feed.paging.prefix, shop.url + '/paged/page/');
  const { json } = await call('POST', `/api/feeds/${feed.id}/refresh`, { backfill: true });
  assert.equal(json.feed.items.length, 23);
  assert.equal(json.feed.lastFetch.pages, 4, 'page 5 is empty');
  assert.equal(json.feed.lastFetch.warning, undefined);
});

test('a site that repeats its last page does not make the crawl run on', async () => {
  const feed = await create('Loop', shop.url + '/paged-loop', { pagingUrl: shop.url + '/paged-loop?page=2' });
  const { json } = await call('POST', `/api/feeds/${feed.id}/refresh`, { backfill: true });
  assert.equal(json.feed.items.length, 23);
  assert.equal(json.feed.lastFetch.pages, 4);
});

test('offsets: the step is the size of the first jump', async () => {
  const feed = await create('Offsets', shop.url + '/paged?start=0', { pagingUrl: shop.url + '/paged?start=6' });
  const { json } = await call('POST', `/api/feeds/${feed.id}/refresh`, { backfill: true });
  assert.equal(json.feed.items.length, 23);
});

test('edit a feed: name, address, number of items and second page address', async () => {
  const plain = await create('Plain', shop.url + '/paged');
  assert.equal(plain.paging, undefined);

  let r = await call('PUT', `/api/feeds/${plain.id}`, { name: '  Renamed  ' });
  assert.equal(r.status, 200);
  assert.equal(r.json.feed.name, 'Renamed');
  assert.equal(r.json.recrawl, false);
  assert.equal(r.json.feed.items.length, 6, 'items are untouched');

  r = await call('PUT', `/api/feeds/${plain.id}`, { name: 'Renamed', url: shop.url + '/paged', expectedCount: 12, pagingUrl: shop.url + '/paged?page=2' });
  assert.equal(r.json.recrawl, true, 'paging was added');
  assert.equal(r.json.feed.expectedCount, 12);
  let sum = (await call('GET', '/api/feeds')).json.feeds.find((f) => f.id === plain.id);
  assert.equal(sum.pagingUrl, shop.url + '/paged?page=2');
  assert.equal(sum.name, 'Renamed');

  r = await call('PUT', `/api/feeds/${plain.id}`, { name: 'Renamed', url: shop.url + '/paged', expectedCount: 12, pagingUrl: shop.url + '/paged?page=2' });
  assert.equal(r.json.recrawl, false, 'nothing changed');
  r = await call('PUT', `/api/feeds/${plain.id}`, { expectedCount: 30 });
  assert.equal(r.json.recrawl, true, 'a higher number of items needs more pages');

  r = await call('PUT', `/api/feeds/${plain.id}`, { url: shop.url + '/paged-loop' });
  assert.equal(r.json.recrawl, true, 'a new address, the paging is recomputed from the stored second page');
  assert.equal(r.json.feed.host, '127.0.0.1:' + shop.port);

  assert.equal((await call('PUT', `/api/feeds/${plain.id}`, { name: '   ' })).status, 400);
  assert.equal((await call('PUT', `/api/feeds/${plain.id}`, { url: 'ftp://x.y' })).status, 400);
  assert.equal((await call('PUT', `/api/feeds/${plain.id}`, { expectedCount: 'many' })).status, 400);
  assert.equal((await call('PUT', `/api/feeds/${plain.id}`, { pagingUrl: shop.url + '/hard' })).status, 400);
  assert.equal((await call('PUT', '/api/feeds/0123456789abcdef', { name: 'x' })).status, 404);

  r = await call('PUT', `/api/feeds/${plain.id}`, { pagingUrl: '' });
  assert.equal(r.json.feed.paging, undefined);
  assert.equal(r.json.recrawl, false);
  sum = (await call('GET', '/api/feeds')).json.feeds.find((f) => f.id === plain.id);
  assert.equal(sum.pagingUrl, '');
});
