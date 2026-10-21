'use strict';
// Sync of the configuration between instances of this app (feeds, wanted / ignored lists, per-feed settings; never the items).
//
// Model: every instance keeps a list of peer addresses. A sync with a peer is one request, POST <peer>/api/sync/exchange:
// we send our configuration, the peer merges it into its own and answers with its merged configuration, which we merge too.
// Both sides therefore converge after one round trip, and neither needs to know the other in advance (adding B on A is enough).
//
// Merge rules (last write wins, per piece of configuration):
//   * a feed's configuration is split in groups (GROUPS); each group carries the time of its last local edit (feed.sync[group]),
//     so renaming a feed on one instance and editing its wanted list on another both survive;
//   * the global wanted / ignored lists are one piece each (settings.sync[kind]);
//   * a deleted feed leaves a tombstone (settings.deletedFeeds), so it is deleted everywhere and not brought back;
//   * a feed that is new to an instance is created without items and refreshed in the background.
// Times are the wall clock of the instance that made the edit, so the clocks of the instances should be roughly right.
// An instance only pushes again when a merge actually changed something, which is what stops the ping-pong.

const crypto = require('node:crypto');
const store = require('./store');
const images = require('./images');

const SYNC_INTERVAL_MS = parseInt(process.env.SYNC_INTERVAL_MS || String(5 * 60 * 1000), 10);
const REQUEST_TIMEOUT_MS = 20000;
const PUSH_DELAY_MS = 1500;
const MAX_PEERS = 20;
const LISTS = ['wanted', 'ignored'];

/** The fields of a feed that are synced, grouped by what is edited together. */
const GROUPS = {
  details: ['name', 'url', 'expectedCount', 'paging'],
  pattern: ['pattern'],
  wanted: ['wanted'],
  ignored: ['ignored'],
  settings: ['maxItems', 'minDiscount', 'deliveryFilter', 'autoRefresh'],
};

const service = () => require('./service'); // lazy: service stamps its edits with touch() from here

class SyncError extends Error {
  status = 400;
}

/** Record a local edit of these groups of a feed (call before saving it). */
function touch(feed, ...groups) {
  const now = Date.now();
  feed.sync = feed.sync || {};
  for (const g of groups) feed.sync[g] = now;
}

// ---------------------------------------------------------------- what goes over the wire

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max;
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;
const httpUrl = (v) => {
  try {
    return str(v, 2048) && /^https?:$/.test(new URL(v).protocol);
  } catch {
    return false;
  }
};

async function instanceId() {
  return store.withLock('settings', async () => {
    const s = await store.readSettings();
    if (s.instanceId) return s.instanceId;
    s.instanceId = crypto.randomBytes(8).toString('hex');
    await store.saveSettings(s);
    return s.instanceId;
  });
}

function exportFeed(feed) {
  const out = { id: feed.id, createdAt: feed.createdAt, sync: feed.sync || {} };
  for (const fields of Object.values(GROUPS)) for (const k of fields) if (feed[k] !== undefined) out[k] = feed[k];
  return out;
}

async function buildState() {
  const [feeds, settings, id] = await Promise.all([store.listFeeds(), store.readSettings(), instanceId()]);
  const lists = {};
  for (const kind of LISTS) lists[kind] = { at: settings.sync[kind] || 0, items: settings[kind] };
  return { version: 1, instanceId: id, lists, deleted: settings.deletedFeeds, feeds: Object.fromEntries(feeds.map((f) => [f.id, exportFeed(f)])) };
}

/** Validated values of one group from untrusted input: an object with only the fields that are set, or null when it is unusable. */
function sanitizeGroup(group, src) {
  const out = {};
  const svc = service();
  try {
    if (group === 'details') {
      if (!str(src.name, 80) || !httpUrl(src.url)) return null;
      out.name = src.name.trim();
      out.url = src.url;
      if (src.expectedCount != null) {
        if (!int(src.expectedCount, 1, 5000)) return null;
        out.expectedCount = src.expectedCount;
      } else out.expectedCount = null;
      const p = src.paging;
      if (p != null) {
        const ok = isObj(p) && httpUrl(p.firstUrl) && httpUrl(p.secondUrl) && typeof p.prefix === 'string' && typeof p.suffix === 'string' && int(p.start, 0, 1e9) && int(p.step, 1, 1e9) && int(p.pad, 0, 20);
        if (!ok) return null;
        out.paging = { firstUrl: p.firstUrl, secondUrl: p.secondUrl, prefix: p.prefix, suffix: p.suffix, start: p.start, step: p.step, pad: p.pad };
      }
    } else if (group === 'pattern') {
      const p = src.pattern;
      if (!isObj(p) || !str(p.selector, 2000)) return null;
      out.pattern = { selector: p.selector, selectorExact: !!p.selectorExact, source: p.source === 'example' ? 'example' : 'auto', sample: typeof p.sample === 'string' ? p.sample.slice(0, 200000) : '', lastCount: int(p.lastCount, 0, 1e6) ? p.lastCount : 0 };
    } else if (group === 'wanted' || group === 'ignored') {
      out[group] = svc.cleanPhrases(src[group] === undefined ? [] : src[group], { rules: group === 'ignored' });
    } else if (group === 'settings') {
      if (src.maxItems !== undefined) {
        if (src.maxItems !== null && !int(src.maxItems, 1, 100000)) return null;
        out.maxItems = src.maxItems;
      }
      if (src.minDiscount != null) {
        if (typeof src.minDiscount !== 'number' || !(src.minDiscount > 0 && src.minDiscount <= 100)) return null;
        out.minDiscount = src.minDiscount;
      }
      if (src.deliveryFilter != null) {
        const f = require('../public/delivery').cleanFilter(src.deliveryFilter);
        if (!f) return null;
        out.deliveryFilter = f;
      }
      const ar = src.autoRefresh;
      if (ar !== undefined) {
        if (!isObj(ar)) return null;
        const interval = typeof ar.interval === 'string' ? ar.interval.trim() : '';
        const enabled = !!ar.enabled;
        out.autoRefresh = { enabled, interval, intervalMs: enabled || interval ? svc.parseInterval(interval) : 0 };
      }
    }
  } catch {
    return null; // e.g. a phrase this version rejects: leave that group as it is
  }
  return out;
}

// ---------------------------------------------------------------- merging

const valid = (v) => Number.isFinite(v) && v >= 0;

function applyGroup(feed, group, vals) {
  for (const k of GROUPS[group]) {
    if (k in vals) feed[k] = vals[k];
    else delete feed[k];
  }
  if (group === 'details') {
    feed.finalUrl = feed.url; // until the next fetch tells us where it really ends up
    feed.host = service().hostOf(feed.url);
  }
}

const pickGroup = (feed, group) => Object.fromEntries(GROUPS[group].filter((k) => feed[k] !== undefined).map((k) => [k, feed[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Merge the configuration of another instance into ours. Returns { changed, created: [feed ids that are new here] }. */
async function applyState(remote) {
  if (!isObj(remote) || remote.version !== 1 || !isObj(remote.feeds)) throw new SyncError('That is not a Feed Generator sync message (version mismatch?).');
  const svc = service();
  let changed = false;
  const created = [];

  // Global lists and tombstones.
  const settings = await store.withLock('settings', async () => {
    const s = await store.readSettings();
    let dirty = false;
    for (const kind of LISTS) {
      const r = isObj(remote.lists) && remote.lists[kind];
      if (!isObj(r) || !valid(r.at) || !Array.isArray(r.items)) continue;
      let items;
      try {
        items = svc.cleanPhrases(r.items, { rules: kind === 'ignored' });
      } catch {
        continue;
      }
      const mine = s.sync[kind] || 0;
      if (r.at > mine) {
        s[kind] = items;
        s.sync[kind] = r.at;
        dirty = true;
      } else if (r.at === 0 && mine === 0 && items.length && !same(items, s[kind])) {
        // Neither side was edited since lists became syncable: keep both lists (union) and make that the newest version.
        s[kind] = svc.cleanPhrases([...s[kind], ...items], { rules: kind === 'ignored' });
        s.sync[kind] = Date.now();
        dirty = true;
      }
    }
    if (isObj(remote.deleted)) {
      for (const [id, at] of Object.entries(remote.deleted)) {
        if (store.isValidId(id) && valid(at) && !(s.deletedFeeds[id] >= at)) {
          s.deletedFeeds[id] = at;
          dirty = true;
        }
      }
    }
    if (dirty) {
      await store.saveSettings(s);
      changed = true;
    }
    return s;
  });

  // Feeds deleted elsewhere.
  for (const id of Object.keys(settings.deletedFeeds)) {
    await store.withLock(id, async () => {
      const feed = await store.readFeed(id);
      if (!feed) return;
      await store.deleteFeed(id);
      images.remove(feed.items.map((i) => i.image)).catch(() => {});
      changed = true;
    });
  }

  // New and edited feeds.
  for (const [id, rf] of Object.entries(remote.feeds)) {
    if (!store.isValidId(id) || !isObj(rf) || id in settings.deletedFeeds) continue;
    const rsync = isObj(rf.sync) ? rf.sync : {};
    await store.withLock(id, async () => {
      const local = await store.readFeed(id);
      if (!local) {
        const groups = {};
        for (const g of Object.keys(GROUPS)) groups[g] = sanitizeGroup(g, rf);
        if (!groups.details || !groups.pattern) return; // not enough to build a feed from
        const now = new Date().toISOString();
        const feed = { id, createdAt: typeof rf.createdAt === 'string' && !Number.isNaN(Date.parse(rf.createdAt)) ? rf.createdAt : now, updatedAt: now, fetchCount: 0, lastFetch: null, items: [], sync: {} };
        feed.updatedAt = feed.createdAt;
        for (const [g, vals] of Object.entries(groups)) {
          if (!vals) continue;
          applyGroup(feed, g, vals);
          feed.sync[g] = valid(rsync[g]) ? rsync[g] : 0;
        }
        await store.saveFeed(feed);
        created.push(id);
        changed = true;
        return;
      }
      let modified = false;
      local.sync = local.sync || {};
      for (const g of Object.keys(GROUPS)) {
        const at = rsync[g];
        if (!valid(at) || !(at > (local.sync[g] || 0))) continue;
        const vals = sanitizeGroup(g, rf);
        if (!vals) continue;
        if (!same(vals, pickGroup(local, g))) applyGroup(local, g, vals);
        local.sync[g] = at;
        modified = true;
      }
      if (!modified) return;
      svc.trimItems(local); // a lower item limit applies at once
      await store.saveFeed(local);
      svc.cleanupDropped(local);
      changed = true;
    });
  }
  return { changed, created };
}

// ---------------------------------------------------------------- peers

const status = new Map(); // peer address -> { at, ok, error, feeds }
let running = null;
let queued = null;
let timer = null;
let pushTimer = null;

/** "192.168.1.20:3001", "nas.local" or "https://nas.example.com:8443/" -> "http://192.168.1.20:3001" (scheme defaults to http). */
function normalizePeer(input) {
  let text = String(input == null ? '' : input).trim();
  if (!text) throw new SyncError('Enter the address of the other instance, for example 192.168.1.20:3000.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'http://' + text;
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new SyncError(`"${input}" is not a valid address.`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SyncError('Only http:// and https:// addresses are supported.');
  if (!u.hostname) throw new SyncError(`"${input}" is not a valid address.`);
  return u.origin;
}

async function listPeers() {
  const settings = await store.readSettings();
  return {
    instanceId: await instanceId(),
    intervalMs: SYNC_INTERVAL_MS,
    syncing: !!running,
    peers: settings.peers.map((url) => ({ url, ...(status.get(url) || {}) })),
  };
}

async function setPeers(input) {
  if (!Array.isArray(input)) throw new SyncError('peers must be a list of addresses.');
  const peers = [...new Set(input.map(normalizePeer))];
  if (peers.length > MAX_PEERS) throw new SyncError(`At most ${MAX_PEERS} other instances can be added.`);
  await store.withLock('settings', async () => {
    const s = await store.readSettings();
    s.peers = peers;
    await store.saveSettings(s);
  });
  for (const url of [...status.keys()]) if (!peers.includes(url)) status.delete(url);
  schedulePush(0); // sync the new ones right away (the answer is read from listPeers)
  return listPeers();
}

async function syncPeer(url, mine) {
  let res;
  try {
    res = await fetch(url + '/api/sync/exchange', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(await buildState()),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new SyncError(timedOut ? 'No answer (timed out).' : `Could not connect (${(e.cause && (e.cause.code || e.cause.message)) || e.message}).`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new SyncError((body && body.error) || `The other instance answered HTTP ${res.status}. Is that a Feed Generator?`);
  if (!isObj(body) || body.version !== 1) throw new SyncError('The other instance did not answer like a Feed Generator of this version.');
  if (body.instanceId === mine) throw new SyncError('That address is this instance itself.');
  return applyState(body);
}

async function runAll() {
  const settings = await store.readSettings();
  const mine = await instanceId();
  const fresh = [];
  for (const url of settings.peers) {
    try {
      const { changed, created } = await syncPeer(url, mine);
      status.set(url, { at: new Date().toISOString(), ok: true, changed });
      fresh.push(...created);
    } catch (e) {
      status.set(url, { at: new Date().toISOString(), ok: false, error: e.message });
    }
  }
  // Feeds that came from a peer have no items yet: fetch them one after the other in the background.
  (async () => {
    for (const id of fresh) await service().refreshFeed(id).catch((e) => console.warn(`First update of synced feed ${id} failed: ${e.message}`));
  })();
}

/** Sync with all peers now. A call during a run waits for that run and then does one more, so it always sees the latest edits. */
function syncNow() {
  if (running) {
    if (!queued) queued = running.then(() => ((queued = null), syncNow()));
    return queued;
  }
  running = runAll()
    .catch((e) => console.error('Sync error:', e))
    .finally(() => {
      running = null;
    });
  return running;
}

/** Local configuration changed (or a peer's change was merged): tell the peers shortly. */
function schedulePush(delay = PUSH_DELAY_MS) {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(syncNow, delay);
  pushTimer.unref();
}

/** Handle POST /api/sync/exchange: merge what the peer sent and answer with our merged configuration. */
async function exchange(remote) {
  const { changed, created } = await applyState(remote);
  if (changed) schedulePush(); // other peers of ours may not know yet
  (async () => {
    for (const id of created) await service().refreshFeed(id).catch(() => {});
  })();
  return buildState();
}

function start() {
  if (timer) return;
  timer = setInterval(syncNow, SYNC_INTERVAL_MS);
  timer.unref();
  schedulePush(5000);
}

function stop() {
  clearInterval(timer);
  clearTimeout(pushTimer);
  timer = null;
}

module.exports = { GROUPS, SyncError, touch, buildState, applyState, exchange, normalizePeer, listPeers, setPeers, syncNow, schedulePush, start, stop };
