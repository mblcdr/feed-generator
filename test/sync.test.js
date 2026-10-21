'use strict';
// Two real server processes with their own data folders sync their configuration (no browser needed).

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const nodes = [];

function startNode(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-sync-'));
  const proc = spawn(process.execPath, ['server.js'], { cwd: ROOT, env: { ...process.env, PORT: String(port), DATA_DIR: dir, SYNC_INTERVAL_MS: '3600000' }, stdio: 'ignore' });
  const node = { port, dir, proc, url: `http://127.0.0.1:${port}` };
  nodes.push(node);
  return node;
}

async function call(node, method, url, body) {
  const res = await fetch(node.url + url, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw Object.assign(new Error(data.error), { status: res.status });
  return data;
}

async function waitUp(node) {
  for (let i = 0; i < 100; i++) {
    try {
      await call(node, 'GET', '/api/feeds');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('server did not start');
}

function writeFeed(node, id, extra = {}) {
  fs.mkdirSync(path.join(node.dir, 'feeds'), { recursive: true });
  const feed = {
    id, name: 'Shoes', url: 'https://shop.example.com/shoes', finalUrl: 'https://shop.example.com/shoes', host: 'shop.example.com',
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', expectedCount: null, maxItems: 1000,
    pattern: { selector: 'li.p', selectorExact: true, source: 'auto', sample: '<li class="p">x</li>', lastCount: 3 },
    fetchCount: 1, lastFetch: null, items: [{ id: 'u:a', title: 'A', url: 'https://shop.example.com/a', seq: 1, pos: 0 }],
    sync: { details: 1, pattern: 1, wanted: 1, ignored: 1, settings: 1 }, ...extra,
  };
  fs.writeFileSync(path.join(node.dir, 'feeds', id + '.json'), JSON.stringify(feed));
}

const feedsOf = async (node) => (await call(node, 'GET', '/api/feeds')).feeds;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

let A, B, C;
const ID = 'aaaaaaaaaaaaaaaa';

before(async () => {
  A = startNode(3961);
  B = startNode(3962);
  C = startNode(3963);
  writeFeed(A, ID);
  await Promise.all([A, B, C].map(waitUp));
});

after(() => {
  for (const n of nodes) {
    n.proc.kill();
    fs.rmSync(n.dir, { recursive: true, force: true });
  }
});

test('peer addresses are normalized and a wrong one reports an error', async () => {
  const out = await call(A, 'PUT', '/api/sync/peers', { peers: ['127.0.0.1:3962/'] });
  assert.deepEqual(out.peers.map((p) => p.url), ['http://127.0.0.1:3962']);
  await assert.rejects(call(A, 'PUT', '/api/sync/peers', { peers: ['ftp://x'] }), /http/);
  const bad = await call(A, 'PUT', '/api/sync/peers', { peers: ['127.0.0.1:3962', '127.0.0.1:3999', '127.0.0.1:3961'] });
  const done = await call(A, 'POST', '/api/sync/now');
  const by = Object.fromEntries(done.peers.map((p) => [p.url, p]));
  assert.equal(bad.peers.length, 3);
  assert.equal(by['http://127.0.0.1:3962'].ok, true);
  assert.equal(by['http://127.0.0.1:3999'].ok, false);
  assert.match(by['http://127.0.0.1:3961'].error, /itself/);
});

test('a feed and the global lists reach a peer that did not know us', async () => {
  const f = (await feedsOf(B)).find((x) => x.id === ID);
  assert.ok(f, 'feed exists on B');
  assert.equal(f.name, 'Shoes');
  assert.equal(f.itemCount, 0, 'items are not synced');
  await call(A, 'PUT', '/api/settings/wanted', { phrases: ['nike air'] });
  await call(A, 'POST', '/api/sync/now');
  assert.deepEqual((await call(B, 'GET', '/api/feeds')).wanted.phrases, ['nike air']);
});

test('B answered back, so edits on B reach A (one-way address is enough); groups merge separately', async () => {
  await call(A, 'PUT', '/api/feeds/' + ID, { name: 'Sneakers' });
  await settle(30);
  await call(B, 'PUT', `/api/feeds/${ID}/wanted`, { phrases: ['red'] });
  await call(A, 'POST', '/api/sync/now');
  const f = (await feedsOf(A)).find((x) => x.id === ID);
  assert.equal(f.name, 'Sneakers');
  assert.deepEqual(f.wanted, ['red']);
  assert.equal((await feedsOf(B)).find((x) => x.id === ID).name, 'Sneakers');
});

test('settings and the newest edit of a list win', async () => {
  await call(B, 'PUT', `/api/feeds/${ID}/settings`, { maxItems: 50, autoRefresh: { enabled: true, interval: '2h' } });
  await settle(30);
  await call(A, 'PUT', '/api/settings/wanted', { phrases: ['adidas'] });
  await call(A, 'POST', '/api/sync/now');
  const f = (await feedsOf(A)).find((x) => x.id === ID);
  assert.equal(f.maxItems, 50);
  assert.equal(f.autoRefresh.interval, '2h');
  assert.deepEqual((await call(B, 'GET', '/api/feeds')).wanted.phrases, ['adidas']);
});

test('a deleted feed is deleted everywhere and stays deleted', async () => {
  await call(B, 'DELETE', '/api/feeds/' + ID);
  await call(A, 'POST', '/api/sync/now');
  assert.equal((await feedsOf(A)).length, 0);
  await call(A, 'POST', '/api/sync/now');
  assert.equal((await feedsOf(B)).length, 0);
});

test('changes travel on through a chain (A - B - C)', async () => {
  await call(B, 'PUT', '/api/sync/peers', { peers: ['127.0.0.1:3963'] });
  await call(B, 'POST', '/api/sync/now');
  await call(A, 'PUT', '/api/settings/ignored', { phrases: ['/refurb/i'] });
  await call(A, 'POST', '/api/sync/now'); // A -> B, and B passes it on to C by itself
  for (let i = 0; i < 40; i++) {
    if ((await call(C, 'GET', '/api/feeds')).ignored.phrases.length) break;
    await settle(100);
  }
  assert.deepEqual((await call(C, 'GET', '/api/feeds')).ignored.phrases, ['/refurb/i']);
});

test('a message of the wrong shape is refused', async () => {
  await assert.rejects(call(B, 'POST', '/api/sync/exchange', { hello: 1 }), /sync message/);
});
