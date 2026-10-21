'use strict';
// Local image cache so feeds keep their pictures offline and hot-link protection doesn't matter.
// Files live in data/images/<sha1(url)> with a small <sha1>.json sidecar holding the content type.

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { DATA_DIR } = require('./store');

const IMAGES_DIR = path.join(DATA_DIR, 'images');
const MAX_BYTES = 10 * 1024 * 1024;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const keyFor = (url) => crypto.createHash('sha1').update(url).digest('hex');
const inflight = new Map();

async function fromCache(key) {
  try {
    const meta = JSON.parse(await fs.readFile(path.join(IMAGES_DIR, key + '.json'), 'utf8'));
    const file = path.join(IMAGES_DIR, key);
    await fs.access(file);
    return { file, type: meta.type };
  } catch {
    return null;
  }
}

async function download(url, referer, key) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'image/avif,image/webp,image/*,*/*;q=0.8', ...(referer ? { referer } : {}) },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!type.startsWith('image/')) throw new Error('Not an image');
  const declared = parseInt(res.headers.get('content-length') || '0', 10);
  if (declared > MAX_BYTES) throw new Error('Image too large');

  const chunks = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('Image too large');
    chunks.push(chunk);
  }
  await fs.mkdir(IMAGES_DIR, { recursive: true });
  const file = path.join(IMAGES_DIR, key);
  const tmp = `${file}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, Buffer.concat(chunks));
  await fs.rename(tmp, file);
  await fs.writeFile(path.join(IMAGES_DIR, key + '.json'), JSON.stringify({ type, url }));
  return { file, type };
}

/** Returns { file, type } for the image, downloading it first if it isn't cached. Throws when unavailable. */
async function getImage(url, referer) {
  if (!/^https?:\/\//i.test(url)) throw new Error('Unsupported image URL');
  const key = keyFor(url);
  const cached = await fromCache(key);
  if (cached) return cached;
  if (!inflight.has(key)) {
    const p = download(url, referer, key).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return inflight.get(key);
}

/** Warm the cache in the background (small concurrency, failures ignored). */
function prefetch(urls, referer, concurrency = 4) {
  const queue = [...new Set(urls.filter((u) => u && /^https?:\/\//i.test(u)))];
  const worker = async () => {
    while (queue.length) {
      const u = queue.shift();
      await getImage(u, referer).catch(() => {});
    }
  };
  for (let i = 0; i < concurrency; i++) worker();
}

async function remove(urls) {
  for (const u of urls) {
    if (!u || !/^https?:\/\//i.test(u)) continue;
    const key = keyFor(u);
    await fs.unlink(path.join(IMAGES_DIR, key)).catch(() => {});
    await fs.unlink(path.join(IMAGES_DIR, key + '.json')).catch(() => {});
  }
}

module.exports = { getImage, prefetch, remove, IMAGES_DIR };
