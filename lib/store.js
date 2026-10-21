'use strict';
// Disk persistence. One JSON file per feed: data/feeds/<id>.json (override the root with DATA_DIR).

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
const FEEDS_DIR = path.join(DATA_DIR, 'feeds');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const ID_RE = /^[a-f0-9]{16}$/;

const isValidId = (id) => typeof id === 'string' && ID_RE.test(id);
const newId = () => crypto.randomBytes(8).toString('hex');
const fileFor = (id) => path.join(FEEDS_DIR, id + '.json');

async function ensureDirs() {
  await fs.mkdir(FEEDS_DIR, { recursive: true });
}

async function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data));
  await fs.rename(tmp, file);
}

async function readFeed(id) {
  if (!isValidId(id)) return null;
  try {
    return JSON.parse(await fs.readFile(fileFor(id), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function saveFeed(feed) {
  if (!isValidId(feed.id)) throw new Error('Invalid feed id');
  await ensureDirs();
  await writeJsonAtomic(fileFor(feed.id), feed);
}

async function deleteFeed(id) {
  if (!isValidId(id)) return false;
  try {
    await fs.unlink(fileFor(id));
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}

async function listFeeds() {
  await ensureDirs();
  const names = (await fs.readdir(FEEDS_DIR)).filter((n) => n.endsWith('.json'));
  const feeds = [];
  for (const n of names) {
    try {
      feeds.push(JSON.parse(await fs.readFile(path.join(FEEDS_DIR, n), 'utf8')));
    } catch (e) {
      console.warn(`Skipping unreadable feed file ${n}: ${e.message}`);
    }
  }
  return feeds;
}

/**
 * Global settings:
 *   wanted / ignored   the global phrase lists
 *   sync               { wanted: ms, ignored: ms } time of the last local edit of each list (last write wins between instances)
 *   deletedFeeds       { feedId: ms } tombstones, so a deleted feed is not brought back by a peer
 *   peers              addresses of the other instances to sync with (local only, never synced)
 *   instanceId         random id of this instance (lets us notice when a peer is ourselves)
 */
async function readSettings() {
  let s = {};
  try {
    s = JSON.parse(await fs.readFile(SETTINGS_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
  return {
    wanted: Array.isArray(s.wanted) ? s.wanted : [],
    ignored: Array.isArray(s.ignored) ? s.ignored : [],
    sync: obj(s.sync),
    deletedFeeds: obj(s.deletedFeeds),
    peers: Array.isArray(s.peers) ? s.peers.filter((p) => typeof p === 'string') : [],
    instanceId: typeof s.instanceId === 'string' ? s.instanceId : null,
  };
}

async function saveSettings(settings) {
  await ensureDirs();
  await writeJsonAtomic(SETTINGS_FILE, settings);
}

// Per-feed mutex so that concurrent refresh / edit / delete requests can't interleave.
const locks = new Map();
function withLock(id, fn) {
  const prev = locks.get(id) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  locks.set(id, tail);
  tail.then(() => {
    if (locks.get(id) === tail) locks.delete(id);
  });
  return run;
}

module.exports = { DATA_DIR, FEEDS_DIR, isValidId, newId, readFeed, saveFeed, deleteFeed, listFeeds, readSettings, saveSettings, withLock, ensureDirs };
