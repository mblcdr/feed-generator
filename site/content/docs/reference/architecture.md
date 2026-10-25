---
title: "Architecture"
description: "Module overview, request flow, JSON API, data model, sync and contributor notes for Feed Generator."
summary: ""
slug: "architecture"
draft: false
weight: 10
toc: true
---

```
server.js              HTTP server: static files, JSON API, /img image proxy, Host/Origin guard
lib/fetcher.js         puppeteer: render a URL completely -> { html, finalUrl, title, status, requestedUrl }
lib/dom.js             DOM helpers (cheerio/domhandler nodes), cleaning, URL normalization, class "signatures"
lib/analyzer.js        indexing, grouping, scoring, nesting resolution, example matching, selector building
lib/paging.js          infer the page-number template from the first and second page address, build the address of page n
lib/extractor.js       one item element -> { id, title, url, image, price, oldPrice, delivery, details[] }
lib/service.js         orchestration: analysis sessions, create/refresh/fix feeds, merge & dedupe
Dockerfile, compose.yaml, .dockerignore   container setup (Alpine + system Chromium, data in the /data volume)
lib/scheduler.js       background auto refresh (tick every 30 s, refreshes feeds that are due)
lib/sync.js            config sync between instances (peer list, exchange, merge); service.js stamps every config edit with `sync.touch`
lib/store.js           disk persistence (one JSON file per feed), atomic writes, per-feed mutex
lib/images.js          on-disk image cache + background prefetch
public/                index.html, styles.css, app.js (SPA), fuzzy.js, discount.js, delivery.js (shared by browser and server)
test/                  unit tests, e2e test, fixture-server.js (fake store used by the tests)
data/                  runtime data (git-ignored): feeds/<id>.json, images/<sha1>[.json], settings.json ({ wanted, ignored, sync, deletedFeeds, peers, instanceId })
```

## Request flow

```
Add feed submit ──POST /api/analyze {url, expectedCount}
   service.analyze → fetcher.fetchRenderedPage → analyzer.createContext → analyzer.analyze
   → session (cached rendered page + candidates, 20 min TTL, max 4) → response {sessionId, confident, recommended, candidates[]}
 confident? ──POST /api/feeds {sessionId, candidateId, name, url, expectedCount}   → feed created
 else user picks a candidate / pastes example (POST /api/analyze again with sessionId + exampleHtml; the cached page is reused)
 Update / auto-refresh ──POST /api/feeds/:id/refresh → fetch page, apply stored selector, merge items
```

## API

All routes use JSON. Errors are `{ "error": "message" }` with an HTTP status.

| Route | Description |
|---|---|
| `GET /api/status` | `{ browser: boolean }` – whether a Chrome was found |
| `GET /api/feeds` | `{ feeds: [summary], wanted: { phrases, count }, ignored: { phrases } }`; summary (no items): `id,name,url,host,expectedCount,pagingUrl,wanted,ignored,maxItems,autoRefresh,starredCount,createdAt,updatedAt,itemCount,hiddenCount,newCount,lastFetch`; `wanted.count` = size of the global Wanted feed; counts exclude ignored items (except `itemCount`) |
| `GET /api/wanted` | `{ phrases, items }` – global Wanted feed: matching items of all feeds, each extended with `matchedBy, feedId, feedName, feedUrl, isNew`; newest first |
| `PUT /api/settings/wanted` | `{phrases:[…]}` → `{phrases}` (trimmed, de-duplicated case-insensitively, ≤ 80 chars each, ≤ 100) |
| `PUT /api/feeds/:id/wanted` | `{phrases:[…]}` → `{phrases}` – the feed's own wanted phrases |
| `PUT /api/settings/ignored`, `PUT /api/feeds/:id/ignored` | `{phrases:[…]}` → `{phrases}` – ignore rules (phrase or `/regex/flags`, ≤ 200 chars, validated) |
| `PUT /api/feeds/:id/settings` | `{ maxItems?: number\|null, minDiscount?: number\|null, deliveryFilter?: object\|null, autoRefresh?: { enabled, interval } }` → `{feed}`; validates and applies (trims immediately) |
| `POST /api/feeds/:id/star` | `{itemId, starred: boolean}` – set/clear the star of an item |
| `GET /api/feeds/:id` | full feed including `items` |
| `POST /api/analyze` | `{url, expectedCount?, pagingUrl?, sessionId?, exampleHtml?}` → candidates (plus `paging: {secondUrl, page3, page4}` when paging is set), or `{example}` when `exampleHtml` is given. An unusable `pagingUrl` is rejected with 400 before the page is loaded |
| `POST /api/feeds` | `{sessionId, candidateId, name, url, expectedCount?, pagingUrl?}` → `201 {feed}` (page 1 only; the client then starts the backfill refresh) |
| `PUT /api/feeds/:id` | `{name?, url?, expectedCount?, pagingUrl?}` (omitted = unchanged, `pagingUrl: ""` removes paging) → `{feed, recrawl}`; `recrawl` is true when paging exists and the address, the paging or a higher number of items makes a backfill refresh worthwhile |
| `POST /api/feeds/:id/refresh` | `{backfill?: boolean}` → `{feed, added, found}` (`found` counts all pages); concurrent calls share one run, a `backfill` call waits for a running one and then runs itself |
| `POST /api/feeds/:id/pattern` | `{sessionId, candidateId}` – replace the pattern ("Fix pattern"), keeps existing items |
| `DELETE /api/feeds/:id` | removes the feed file and its cached images |
| `GET /api/sync`, `PUT /api/sync/peers`, `POST /api/sync/now` | `{ instanceId, intervalMs, syncing, peers: [{url, at, ok, error}] }`; `PUT {peers:[address…]}` replaces the peer list (addresses are normalized to `http(s)://host:port`) and starts a sync; `now` syncs and waits |
| `POST /api/sync/exchange` | peer-to-peer: body is the sender's configuration (`{version:1, instanceId, lists, deleted, feeds}`), the answer is the receiver's configuration after merging it |
| `GET /img?u=<url>&r=<referer>` | image proxy/cache (only `image/*`, ≤10 MB); the UI falls back to the original URL if it fails |

## Data model (`data/feeds/<id>.json`)

```jsonc
{
  "id": "16 hex chars", "name": "…", "url": "address that works (may be http after fallback)", "finalUrl": "after redirects",
  "host": "example.com", "createdAt": "ISO", "updatedAt": "ISO (last successful fetch)", "expectedCount": 24,
  "paging": {                         // only when a second page address was given
    "firstUrl": "…?q=x", "secondUrl": "…?q=x&page=2",
    "prefix": "…?q=x&page=", "suffix": "",   // page n >= 2 = prefix + (start + (n-2)*step) + suffix
    "start": 2, "step": 1, "pad": 0          // pad = zero-padding width of the number (0 = none)
  },
  "pattern": {
    "selector": "ol.row > li",       // CSS selector re-applied on every refresh
    "selectorExact": true,           // selector matched exactly the chosen elements when it was created
    "source": "auto | example",
    "sample": "<outerHTML of an item>",   // used to re-find the items if the selector stops matching
    "lastCount": 20
  },
  "fetchCount": 3,                    // successful fetches; also the `seq` of the newest items
  "lastFetch": { "at": "ISO", "ok": true, "found": 20, "added": 3, "pages": 2, "warning": "…" }   // pages/warning only with paging; or { ok:false, error }
  "items": [{
    "id": "u:<normalized url> | h:<hash of title+image>", "title": "…", "url": "…", "image": "…",
    "price": "€ 12,95", "oldPrice": null, "delivery": "Free delivery tomorrow", "details": ["Brand: X"],
    "firstSeen": "ISO", "lastSeen": "ISO", "seq": 2, "pos": 0,        // sorted by seq desc, pos asc; seq 0 = paged-in history
    "starred": true                                                   // only present when starred
  }]
}
```

"New" = `fetchCount > 1 && item.seq === fetchCount` (items added by the latest successful fetch). The first fetch
doesn't mark everything as new.

## Sync (`lib/sync.js`)

Pull-and-push in one request, no central server, no extra dependencies. Every `exchange` sends our configuration, the peer merges it and answers with its merged configuration, which we merge too, so both sides
converge after one round trip. Sync runs ~1.5 s after any configuration edit (`server.js` calls `sync.schedulePush()` after non-GET API calls except analyze/refresh/star), every `SYNC_INTERVAL_MS`, and from
**Sync now**. A merge that changed something is passed on to our other peers, so A – B – C chains converge; a merge that changes nothing ends the chatter.
Merging is **last write wins** with timestamps (ms of the editing instance's clock, so keep clocks roughly right), at a granularity of: feed groups `details | pattern | wanted | ignored | settings` (`sync.GROUPS`,
stamps in `feed.sync`), and the two global lists (`settings.sync`). Deleting a feed writes a tombstone in `settings.deletedFeeds` (kept forever, tiny) that wins over any feed with that id. Untrusted input is validated per
group (`sanitizeGroup`); an invalid group is skipped. New edits **must** call `touch(feed, group)` before saving, otherwise they will be overwritten by the next sync. Not handled (by design): concurrent edits of the
*same* group at the same time lose the older one; there is no authentication (same trust model as the rest of the app).


## Conventions / gotchas for contributors (and AI agents)

* Plain CommonJS, no build step, no framework. Keep the frontend dependency-free.
* `puppeteer.executablePath()` is **async** (puppeteer ≥ 24) – `findBrowser()` is async for that reason.
* Item detection must stay purely structural/heuristic (no site-specific code). Add a fixture + test in `test/analyzer.test.js`
  or `test/extractor.test.js` for every heuristic change; `test/fixture-server.js` can emulate async-rendered shops.
* Item removal (max items) must go through `trimItems` so ids are tombstoned in `feed.discarded`; otherwise old items flip-flop back in.
* Any change to `normalizeUrl` changes item ids → would duplicate items in existing feeds.
* The analyzer works on the *cleaned* DOM (`loadClean`); stored selectors are applied to the same cleaned DOM at refresh time, so keep both in sync.
