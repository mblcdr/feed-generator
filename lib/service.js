'use strict';
// Orchestration: analysis sessions, creating feeds, refreshing them, merging new items.

const crypto = require('node:crypto');
const store = require('./store');
const images = require('./images');
const { fetchRenderedPage, normalizeInputUrl } = require('./fetcher');
const A = require('./analyzer');
const Paging = require('./paging');
const Fuzzy = require('../public/fuzzy');
const Discount = require('../public/discount');
const Delivery = require('../public/delivery');
const { touch, GROUPS } = require('./sync');

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const DEFAULT_MAX_ITEMS = 1000; // stored items per feed unless changed (null = unlimited)
const MAX_DISCARDED_IDS = 5000; // remembered ids of trimmed items so they are not re-added on the next refresh
const MIN_REFRESH_MS = parseInt(process.env.MIN_REFRESH_MS || '60000', 10);
const MAX_REFRESH_MS = 30 * 24 * 3600 * 1000;

/** Stored-items limit of a feed: a number, or null for unlimited. Feeds created before the option existed get the default. */
const maxItemsOf = (feed) => (feed.maxItems === undefined ? DEFAULT_MAX_ITEMS : feed.maxItems);

/** "90s", "5m", "2h", "1d" (a bare number means minutes) -> milliseconds. */
function parseInterval(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/i.exec(String(text == null ? '' : text));
  if (!m) throw new HttpError(400, 'Use a number with a unit, e.g. 30m, 2h or 1d.');
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[(m[2] || 'm').toLowerCase()];
  const ms = Math.round(parseFloat(m[1]) * unit);
  if (ms < MIN_REFRESH_MS) throw new HttpError(400, `The interval must be at least ${Math.round(MIN_REFRESH_MS / 1000) >= 60 ? Math.round(MIN_REFRESH_MS / 60000) + ' minute(s)' : Math.round(MIN_REFRESH_MS / 1000) + ' second(s)'}.`);
  if (ms > MAX_REFRESH_MS) throw new HttpError(400, 'The interval can be at most 30 days.');
  return ms;
}

// ---------------------------------------------------------------- analysis sessions
// The rendered page is cached for a while so that picking a candidate or pasting an example
// doesn't need to load the (slow) page again.

const SESSION_TTL = 20 * 60 * 1000;
const MAX_SESSIONS = 4;
const sessions = new Map();

function pruneSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.touched > SESSION_TTL) sessions.delete(id);
  while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
}

function getSession(id) {
  pruneSessions();
  const s = sessions.get(id);
  if (s) s.touched = Date.now();
  return s || null;
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function cleanExpected(v) {
  if (v === undefined || v === null || v === '') return 0;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5000) throw new HttpError(400, 'The number of items must be a whole number between 1 and 5000.');
  return n;
}

/**
 * The paging of a list from the address of its first page and whatever was typed for the second page
 * (full address, address without scheme, or a path/query relative to the first page). Returns null when empty.
 */
function resolvePaging(firstUrl, raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  let second;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) second = normalizeInputUrl(text);
  else if (/^[/?#]/.test(text)) second = new URL(text, firstUrl).href;
  else second = normalizeInputUrl(new URL(firstUrl).protocol + '//' + text);
  return Paging.inferPaging(firstUrl, second);
}

const pagingInfo = (paging) => (paging ? { secondUrl: paging.secondUrl, ...Paging.describePaging(paging) } : null);

function publicCandidate(c) {
  return {
    id: c.id,
    source: c.source,
    count: c.count,
    score: Math.round(c.score * 100) / 100,
    metrics: c.metrics,
    selector: c.selector,
    selectorExact: c.selectorExact,
    belowExpected: !!c.belowExpected,
    preview: c.preview,
    sampleHtml: c.sampleHtml,
  };
}

/** Load the page (or reuse the session) and rank candidate item groups. */
async function analyze({ url, expectedCount, pagingUrl, exampleHtml, sessionId }) {
  const normalized = normalizeInputUrl(url);
  const paging = resolvePaging(normalized, pagingUrl); // fails early on an unusable second address
  // With paging the number of items is spread over several pages, so one page can't be expected to hold them all.
  const expected = paging ? 0 : cleanExpected(expectedCount);

  let session = sessionId ? getSession(sessionId) : null;
  if (session && session.url !== normalized) session = null;
  let fresh = false;
  if (!session) {
    fresh = true;
    const page = await fetchRenderedPage(url); // the typed address: lets the fetcher fall back from https to http
    const ctx = A.createContext(page.html, page.finalUrl);
    session = {
      id: crypto.randomBytes(8).toString('hex'),
      url: normalized,
      fetchUrl: page.requestedUrl || normalized, // the address that actually worked (may be http after a fallback)
      page: { finalUrl: page.finalUrl, title: page.title, status: page.status, size: page.html.length },
      ctx,
      candidates: new Map(),
      touched: Date.now(),
    };
    sessions.set(session.id, session);
    pruneSessions();
  }
  const base = {
    sessionId: session.id,
    pageTitle: session.page.title,
    finalUrl: session.page.finalUrl,
    httpStatus: session.page.status,
    paging: pagingInfo(paging && resolvePaging(session.fetchUrl, pagingUrl)),
  };

  if (exampleHtml && String(exampleHtml).trim()) {
    const cand = A.matchExample(session.ctx, exampleHtml, { expected });
    if (!cand) {
      return { ...base, example: null, message: 'Nothing on the page resembled that example. Make sure you copied the whole element (outerHTML) of one item.' };
    }
    cand.id = 'x' + (session.candidates.size + 1);
    session.candidates.set(cand.id, cand);
    const out = { ...base, example: publicCandidate(cand) };
    if (fresh) {
      // The cached page had expired: the client needs the new session's regular candidates too.
      const result = A.analyze(session.ctx, { expected });
      for (const c of result.candidates) session.candidates.set(c.id, c);
      out.candidates = result.candidates.map(publicCandidate);
    }
    return out;
  }

  const result = A.analyze(session.ctx, { expected });
  for (const k of [...session.candidates.keys()]) if (k.startsWith('c')) session.candidates.delete(k);
  for (const c of result.candidates) session.candidates.set(c.id, c);
  let reason = result.reason;
  if (!result.candidates.length) {
    if (session.page.status && session.page.status >= 400) {
      reason = `The site answered with HTTP ${session.page.status}; it may be blocking automated browsers. ${reason}`;
    } else if (session.page.size < 20000) {
      reason = `The page returned very little content (${Math.round(session.page.size / 1024)} KB); the site may be blocking automated browsers or asking for a login. ${reason}`;
    }
  }
  return {
    ...base,
    confident: result.confident,
    reason,
    recommended: result.recommended,
    candidates: result.candidates.map(publicCandidate),
  };
}

// ---------------------------------------------------------------- feeds

/** Compiled ignore rules for a feed: the global ones plus the feed's own. */
const ignoreRulesFor = (feed, globalIgnored) => Fuzzy.compileRules([...(globalIgnored || []), ...(feed.ignored || [])]);

/** Hidden by an ignore rule, by the feed's minimum discount or by its delivery filter. */
const isHidden = (item, ignore, feed) =>
  (ignore.length > 0 && Fuzzy.matchesRules(item, ignore)) || Discount.belowDiscount(item, feed.minDiscount) || Delivery.belowDelivery(item, feed.deliveryFilter);

function summary(feed, globalIgnored = []) {
  const ignore = ignoreRulesFor(feed, globalIgnored);
  const visible = feed.items.filter((i) => !isHidden(i, ignore, feed));
  const newCount = feed.fetchCount > 1 ? visible.filter((i) => i.seq === feed.fetchCount).length : 0;
  return {
    id: feed.id,
    name: feed.name,
    url: feed.url,
    host: feed.host,
    expectedCount: feed.expectedCount || null,
    pagingUrl: feed.paging ? feed.paging.secondUrl : '',
    wanted: feed.wanted || [],
    ignored: feed.ignored || [],
    maxItems: maxItemsOf(feed),
    minDiscount: feed.minDiscount || null,
    deliveryFilter: feed.deliveryFilter || null,
    autoRefresh: feed.autoRefresh || { enabled: false, interval: '', intervalMs: 0 },
    starredCount: visible.filter((i) => i.starred).length,
    createdAt: feed.createdAt,
    updatedAt: feed.updatedAt,
    itemCount: feed.items.length,
    hiddenCount: feed.items.length - visible.length,
    newCount,
    lastFetch: feed.lastFetch || null,
  };
}

function sortItems(items) {
  items.sort((a, b) => b.seq - a.seq || a.pos - b.pos);
}

const droppedImages = new WeakMap(); // feed object -> image URLs of items trimmed by the last merge

/** Discard the oldest non-starred items beyond the feed's limit and remember their ids. Returns the removed items. */
function trimItems(feed) {
  const max = maxItemsOf(feed);
  if (!max || feed.items.length <= max) return [];
  const removed = [];
  for (let i = feed.items.length - 1; i >= 0 && feed.items.length > max; i--) {
    if (feed.items[i].starred) continue; // starred items are kept even beyond the limit
    removed.push(feed.items[i]);
    feed.items.splice(i, 1);
  }
  feed.discarded = [...(feed.discarded || []), ...removed.map((i) => i.id)].slice(-MAX_DISCARDED_IDS);
  const stillUsed = new Set(feed.items.map((i) => i.image));
  droppedImages.set(feed, removed.map((i) => i.image).filter((u) => u && !stillUsed.has(u)));
  return removed;
}

/** Call after the feed has been saved: delete cached images of items that were trimmed away. */
function cleanupDropped(feed) {
  const urls = droppedImages.get(feed);
  if (urls && urls.length) images.remove(urls).catch(() => {});
  droppedImages.delete(feed);
}

/**
 * Merge freshly extracted items into the feed. Existing items are updated in place, never duplicated;
 * items that were trimmed away earlier are not re-added. Returns how many new items were added (and kept).
 * `older` marks the new items as history (see below) instead of as news from this fetch.
 */
function mergeItems(feed, fresh, { older = false } = {}) {
  const now = new Date().toISOString();
  const seq = (feed.fetchCount || 0) + 1;
  const byId = new Map(feed.items.map((i) => [i.id, i]));
  const gone = new Set(feed.discarded || []);
  const addedIds = [];
  fresh.forEach((it, pos) => {
    const ex = byId.get(it.id);
    if (ex) {
      for (const k of ['title', 'url', 'image', 'price', 'oldPrice', 'delivery']) if (it[k]) ex[k] = it[k];
      else if (k === 'oldPrice') ex.oldPrice = null; // a sale that ended
      if (it.details && it.details.length) ex.details = it.details;
      ex.lastSeen = now;
    } else if (!gone.has(it.id)) {
      // `older`: items found by paging back through the list. They rank below everything fetched so far and are never "New".
      const item = { ...it, firstSeen: now, lastSeen: now, seq: older ? 0 : seq, pos };
      feed.items.push(item);
      byId.set(item.id, item);
      addedIds.push(item.id);
    }
  });
  feed.fetchCount = seq;
  feed.updatedAt = now;
  sortItems(feed.items);
  const removed = new Set(trimItems(feed).map((i) => i.id));
  return addedIds.filter((id) => !removed.has(id)).length;
}

function pickMembersForPattern(ctx, pattern) {
  let members = A.selectBySelector(ctx, pattern.selector);
  let usedSample = false;
  const previous = (pattern.lastCount || 0);
  if ((members.length === 0 || (previous >= 8 && members.length < previous * 0.5)) && pattern.sample) {
    // The stored selector stopped working (site redesign / changed class names): look for the sample instead.
    const cand = A.matchExample(ctx, pattern.sample, { expected: 0 });
    if (cand && cand.count > members.length) {
      members = cand.members;
      pattern.selector = cand.selector;
      pattern.selectorExact = cand.selectorExact;
      usedSample = true;
    }
  }
  return { members, usedSample };
}

async function createFeed({ sessionId, candidateId, name, url, expectedCount, pagingUrl }) {
  const session = getSession(sessionId);
  if (!session) throw new HttpError(410, 'The analysis expired. Please submit the form again.');
  const cand = session.candidates.get(candidateId);
  if (!cand) throw new HttpError(400, 'Unknown candidate.');
  const cleanName = String(name || '').trim().slice(0, 80);
  if (!cleanName) throw new HttpError(400, 'Please enter a name.');
  const expected = cleanExpected(expectedCount);
  const paging = resolvePaging(session.fetchUrl, pagingUrl);

  const items = A.itemsFromMembers(session.ctx, cand.members);
  if (!items.length) throw new HttpError(422, 'Could not read any items from that selection.');

  const now = new Date().toISOString();
  const feed = {
    id: store.newId(),
    name: cleanName,
    url: session.fetchUrl,
    finalUrl: session.page.finalUrl,
    host: hostOf(session.page.finalUrl || session.url),
    createdAt: now,
    updatedAt: now,
    expectedCount: expected || null,
    maxItems: DEFAULT_MAX_ITEMS,
    pattern: {
      selector: cand.selector,
      selectorExact: cand.selectorExact,
      source: cand.source,
      sample: cand.source === 'example' ? cand.sample : A.sampleOf(session.ctx, cand.members[0]),
      lastCount: cand.count,
    },
    fetchCount: 0,
    lastFetch: null,
    items: [],
  };
  if (paging) feed.paging = paging; // the further pages are fetched by a refresh with backfill (the client starts it)
  touch(feed, ...Object.keys(GROUPS));
  const added = mergeItems(feed, items);
  feed.lastFetch = { at: now, ok: true, found: items.length, added };
  await store.saveFeed(feed);
  cleanupDropped(feed);
  images.prefetch(feed.items.map((i) => i.image), feed.finalUrl);
  return feed;
}

/** Replace the extraction pattern of an existing feed using a candidate of a fresh analysis. */
async function updatePattern(id, { sessionId, candidateId }) {
  return store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) throw new HttpError(404, 'Feed not found.');
    const session = getSession(sessionId);
    if (!session) throw new HttpError(410, 'The analysis expired. Please start again.');
    const cand = session.candidates.get(candidateId);
    if (!cand) throw new HttpError(400, 'Unknown candidate.');
    const items = A.itemsFromMembers(session.ctx, cand.members);
    if (!items.length) throw new HttpError(422, 'Could not read any items from that selection.');
    feed.pattern = {
      selector: cand.selector,
      selectorExact: cand.selectorExact,
      source: cand.source,
      sample: cand.source === 'example' ? cand.sample : A.sampleOf(session.ctx, cand.members[0]),
      lastCount: cand.count,
    };
    touch(feed, 'pattern');
    feed.finalUrl = session.page.finalUrl;
    const added = mergeItems(feed, items);
    feed.lastFetch = { at: feed.updatedAt, ok: true, found: items.length, added };
    await store.saveFeed(feed);
    cleanupDropped(feed);
    images.prefetch(feed.items.map((i) => i.image), feed.finalUrl);
    return feed;
  });
}

const refreshing = new Map();

/**
 * Fetch the page again (and, when the feed has paging, the pages behind it) and add items that are not in the feed yet.
 * Concurrent calls share one run. `backfill` pages on through items that are already stored and files what it finds
 * as older items; it is used after paging was set up or the list was edited.
 */
function refreshFeed(id, { backfill = false } = {}) {
  const running = refreshing.get(id);
  if (running && !backfill) return running;
  const p = (running ? running.catch(() => {}) : Promise.resolve()).then(() => doRefresh(id, { backfill })).finally(() => {
    if (refreshing.get(id) === p) refreshing.delete(id);
  });
  refreshing.set(id, p);
  return p;
}

/**
 * Page 2, 3, ... of a feed with paging. Stops when the number of items the feed asks for is reached, when a page
 * has no items we haven't seen in this run (it is empty, or the site repeats its last page for page numbers beyond the end),
 * or - unless `backfill` - when a page shows items that are already in the feed: everything behind it is known then.
 */
async function crawlPages(feed, pattern, firstItems, { backfill = false } = {}) {
  const stored = new Set([...feed.items.map((i) => i.id), ...(feed.discarded || [])]);
  const target = feed.expectedCount || 0;
  const items = firstItems.slice();
  const seen = new Set(items.map((i) => i.id));
  const knownOn = (list) => list.some((i) => stored.has(i.id));
  let pages = 1;
  let warning = null;
  let done = (target && items.length >= target) || (!backfill && knownOn(firstItems));
  for (let n = 2; !done && n <= Paging.MAX_PAGES; n++) {
    let page;
    try {
      page = await fetchRenderedPage(Paging.pageUrl(feed.paging, n));
    } catch (e) {
      warning = `Page ${n} could not be loaded: ${e.message}`;
      break;
    }
    pages = n;
    const ctx = A.createContext(page.html, page.finalUrl);
    const list = A.itemsFromMembers(ctx, A.selectBySelector(ctx, pattern.selector));
    const fresh = list.filter((i) => !seen.has(i.id));
    if (!fresh.length) {
      if (!list.length && page.status && page.status >= 400) warning = `Page ${n} answered HTTP ${page.status}.`;
      pages = n - 1;
      break;
    }
    for (const it of fresh) {
      seen.add(it.id);
      items.push(it);
    }
    done = (target && items.length >= target) || (!backfill && knownOn(list));
  }
  return { items, pages, warning };
}

async function doRefresh(id, { backfill = false } = {}) {
  const initial = await store.readFeed(id);
  if (!initial) throw new HttpError(404, 'Feed not found.');

  let page;
  try {
    page = await fetchRenderedPage(initial.url);
  } catch (e) {
    await recordFailure(id, e.message);
    throw e;
  }
  const ctx = A.createContext(page.html, page.finalUrl);
  const pattern = { ...initial.pattern };
  const { members } = pickMembersForPattern(ctx, pattern);
  const first = A.itemsFromMembers(ctx, members);
  if (!first.length) {
    const hint = page.status && page.status >= 400 ? ` (the site answered HTTP ${page.status})` : '';
    const msg = `No items found on the page anymore${hint}. Use "Fix pattern" if the site layout changed.`;
    await recordFailure(id, msg);
    throw new HttpError(422, msg);
  }
  // The further pages are fetched outside the feed's lock: this can take minutes and must not block starring, editing, ...
  const crawl = initial.paging ? await crawlPages(initial, pattern, first, { backfill }) : { items: first, pages: 1, warning: null };

  return store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) throw new HttpError(404, 'Feed not found.');
    if (feed.pattern.selector === initial.pattern.selector) {
      feed.pattern.selector = pattern.selector; // rewritten from the sample when the old one stopped matching
      feed.pattern.selectorExact = pattern.selectorExact;
    }
    feed.finalUrl = page.finalUrl;
    feed.pattern.lastCount = members.length;
    const added = mergeItems(feed, crawl.items, { older: backfill });
    feed.lastFetch = { at: feed.updatedAt, ok: true, found: crawl.items.length, added };
    if (initial.paging) feed.lastFetch.pages = crawl.pages;
    if (crawl.warning) feed.lastFetch.warning = crawl.warning;
    await store.saveFeed(feed);
    cleanupDropped(feed);
    const ids = new Set(crawl.items.map((i) => i.id));
    images.prefetch(feed.items.filter((i) => (backfill ? ids.has(i.id) : i.seq === feed.fetchCount)).map((i) => i.image), feed.finalUrl);
    return { feed, added, found: crawl.items.length };
  });
}

async function recordFailure(id, message) {
  await store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) return;
    feed.lastFetch = { at: new Date().toISOString(), ok: false, error: message };
    await store.saveFeed(feed);
  });
}

async function removeFeed(id) {
  return store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) throw new HttpError(404, 'Feed not found.');
    await store.deleteFeed(id);
    images.remove(feed.items.map((i) => i.image)).catch(() => {});
    // The tombstone keeps other instances (see lib/sync.js) from bringing the feed back.
    await store.withLock('settings', async () => {
      const settings = await store.readSettings();
      settings.deletedFeeds[id] = Date.now();
      await store.saveSettings(settings);
    });
  });
}

// ---------------------------------------------------------------- wanted phrases & stars

/** Trim, de-duplicate (case-insensitive) and validate a list of phrases; `rules` also validates regexes. */
function cleanPhrases(input, { rules = false } = {}) {
  if (!Array.isArray(input)) throw new HttpError(400, 'phrases must be a list of text values.');
  const seen = new Set();
  const out = [];
  for (const p of input) {
    if (typeof p !== 'string') throw new HttpError(400, 'phrases must be text.');
    const t = p.trim().replace(/\s+/g, ' ');
    if (!t) continue;
    if (t.length > 200 || (!rules && t.length > 80)) throw new HttpError(400, `A ${rules ? 'rule' : 'phrase'} can be at most ${rules ? 200 : 80} characters.`);
    if (rules) {
      const problem = Fuzzy.validateRule(t);
      if (problem) throw new HttpError(400, problem);
    }
    const k = t.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(t);
    }
  }
  if (out.length > 100) throw new HttpError(400, 'At most 100 entries are allowed.');
  return out;
}

const LIST_KINDS = { wanted: { rules: false }, ignored: { rules: true } };

async function setGlobalList(kind, phrases) {
  const clean = cleanPhrases(phrases, LIST_KINDS[kind]);
  await store.withLock('settings', async () => {
    const settings = await store.readSettings();
    settings[kind] = clean;
    settings.sync[kind] = Date.now();
    await store.saveSettings(settings);
  });
  return clean;
}

async function setFeedList(id, kind, phrases) {
  const clean = cleanPhrases(phrases, LIST_KINDS[kind]);
  return store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) throw new HttpError(404, 'Feed not found.');
    feed[kind] = clean;
    touch(feed, kind);
    await store.saveFeed(feed);
    return clean;
  });
}

/**
 * Edit a feed's name, web address, number of items and second page address (any of them may be left out to keep it).
 * Returns { feed, recrawl }; recrawl says the page list changed so the client should start a refresh with backfill.
 */
async function updateFeed(id, body) {
  body = body || {};
  return store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) throw new HttpError(404, 'Feed not found.');
    const before = { url: feed.url, expected: feed.expectedCount || 0, paging: JSON.stringify(feed.paging || null) };
    if ('name' in body) {
      const name = String(body.name || '').trim().slice(0, 80);
      if (!name) throw new HttpError(400, 'Please enter a name.');
      feed.name = name;
    }
    if ('url' in body) {
      const url = normalizeInputUrl(body.url);
      if (url !== feed.url) {
        feed.url = url;
        feed.finalUrl = url; // until the next fetch tells us where it really ends up
        feed.host = hostOf(url);
      }
    }
    if ('expectedCount' in body) feed.expectedCount = cleanExpected(body.expectedCount) || null;
    const pagingRaw = 'pagingUrl' in body ? body.pagingUrl : feed.paging && feed.paging.secondUrl;
    const paging = resolvePaging(feed.url, pagingRaw);
    if (paging) feed.paging = paging;
    else delete feed.paging;
    touch(feed, 'details');
    await store.saveFeed(feed);
    const recrawl = !!paging && (feed.url !== before.url || JSON.stringify(paging) !== before.paging || (feed.expectedCount || 0) > before.expected);
    return { feed, recrawl };
  });
}

/** Per-feed settings: { maxItems: number|null, minDiscount: percent|null, deliveryFilter: {mode:'now'}|{mode:'months',months}|null, autoRefresh: { enabled, interval } }. Returns the updated feed. */
async function setFeedSettings(id, body) {
  const patch = {};
  if (body && 'maxItems' in body) {
    const v = body.maxItems;
    if (v === null || v === '') patch.maxItems = null;
    else if (Number.isInteger(v) && v >= 1 && v <= 100000) patch.maxItems = v;
    else throw new HttpError(400, 'Maximum items must be a whole number between 1 and 100000, or empty for no limit.');
  }
  if (body && 'minDiscount' in body) {
    const v = body.minDiscount;
    if (v === null || v === '' || v === 0) patch.minDiscount = null;
    else if (typeof v === 'number' && v > 0 && v <= 100) patch.minDiscount = Math.round(v * 10) / 10;
    else throw new HttpError(400, 'The minimum discount must be a number between 0 and 100, or empty for no filter.');
  }
  if (body && 'deliveryFilter' in body) {
    const v = Delivery.cleanFilter(body.deliveryFilter);
    if (v === undefined) throw new HttpError(400, 'The delivery filter must be "available now" or a whole number of months between 1 and 120, or empty for no filter.');
    patch.deliveryFilter = v;
  }
  if (body && body.autoRefresh) {
    const ar = body.autoRefresh;
    const enabled = !!ar.enabled;
    const interval = String(ar.interval == null ? '' : ar.interval).trim();
    let intervalMs = 0;
    if (enabled || interval) intervalMs = parseInterval(interval);
    if (enabled && !intervalMs) throw new HttpError(400, 'Enter an interval such as 30m.');
    patch.autoRefresh = { enabled, interval, intervalMs };
  }
  return store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) throw new HttpError(404, 'Feed not found.');
    Object.assign(feed, patch);
    touch(feed, 'settings');
    trimItems(feed);
    await store.saveFeed(feed);
    cleanupDropped(feed);
    return feed;
  });
}

/** Is this feed's auto refresh due? (Interval counts from the last attempt, successful or not.) */
function isDue(feed, now = Date.now()) {
  const ar = feed.autoRefresh;
  if (!ar || !ar.enabled || !ar.intervalMs) return false;
  const last = Date.parse((feed.lastFetch && feed.lastFetch.at) || feed.updatedAt || feed.createdAt);
  return !(now - last < ar.intervalMs);
}

async function setStar(id, itemId, starred) {
  if (typeof itemId !== 'string' || typeof starred !== 'boolean') throw new HttpError(400, 'itemId and starred are required.');
  return store.withLock(id, async () => {
    const feed = await store.readFeed(id);
    if (!feed) throw new HttpError(404, 'Feed not found.');
    const item = feed.items.find((i) => i.id === itemId);
    if (!item) throw new HttpError(404, 'Item not found.');
    if (starred) item.starred = true;
    else delete item.starred;
    await store.saveFeed(feed);
    return { itemId, starred };
  });
}

/** Items of all feeds matching the global phrases or the feed's own phrases (ignored items excluded). */
function collectWanted(feeds, globalPhrases, globalIgnored = []) {
  const items = [];
  for (const feed of feeds) {
    const compiled = Fuzzy.compile([...globalPhrases, ...(feed.wanted || [])]);
    if (!compiled.length) continue;
    const ignore = ignoreRulesFor(feed, globalIgnored);
    for (const it of feed.items) {
      const matchedBy = Fuzzy.match(it, compiled);
      if (!matchedBy || isHidden(it, ignore, feed)) continue;
      items.push({
        ...it,
        matchedBy,
        feedId: feed.id,
        feedName: feed.name,
        feedUrl: feed.finalUrl || feed.url,
        isNew: feed.fetchCount > 1 && it.seq === feed.fetchCount,
      });
    }
  }
  items.sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0));
  return items;
}

async function getWanted() {
  const [feeds, settings] = await Promise.all([store.listFeeds(), store.readSettings()]);
  return { phrases: settings.wanted, items: collectWanted(feeds, settings.wanted, settings.ignored) };
}

async function listSummaries() {
  const [feeds, settings] = await Promise.all([store.listFeeds(), store.readSettings()]);
  feeds.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return {
    feeds: feeds.map((f) => summary(f, settings.ignored)),
    wanted: { phrases: settings.wanted, count: collectWanted(feeds, settings.wanted, settings.ignored).length },
    ignored: { phrases: settings.ignored },
  };
}

async function getFeed(id) {
  const feed = await store.readFeed(id);
  if (!feed) throw new HttpError(404, 'Feed not found.');
  return feed;
}

module.exports = {
  HttpError,
  analyze,
  createFeed,
  updatePattern,
  updateFeed,
  refreshFeed,
  removeFeed,
  listSummaries,
  getFeed,
  getWanted,
  setGlobalList,
  setFeedList,
  setFeedSettings,
  isDue,
  parseInterval,
  setStar,
  collectWanted,
  summary,
  mergeItems, // exported for tests
  // used by lib/sync.js
  cleanPhrases,
  trimItems,
  cleanupDropped,
  hostOf,
};
