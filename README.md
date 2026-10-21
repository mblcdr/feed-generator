# Feed Generator

A local web app that turns **online-store listing pages into an RSS-like feed**.
You give it a page URL (a category / search results page), it loads the page in a real headless Chrome
(so JavaScript-rendered content, lazy images and infinite scroll are included), finds the repeating
"item" elements, extracts image / title / price / delivery info / link from each of them and stores
them on disk. You then browse the items in a clean list UI, refresh a feed to pull in only the
*new* items, and click an item to open the original product page in a new tab.

* Backend: Node.js (plain `http` server, no framework), `puppeteer` (headless Chrome), `cheerio` (HTML parsing).
* Frontend: dependency-free vanilla JS single page app (`public/`), responsive, light/dark.
* Storage: JSON files on disk (`data/`), plus a local image cache.

> **⚠️ No login.** The app has no authentication. By default it listens on all network interfaces, so anyone on your local network can open it, change or delete feeds
> and make your machine load arbitrary web pages. Only run it on a network you trust, never forward its port to the internet or put it behind a public reverse proxy
> without adding your own authentication, and use `HOST=127.0.0.1` (or `BIND_ADDR=127.0.0.1` with Docker) to restrict it to this computer.

> **⚖️ Scraping disclaimer.** This tool loads web pages with an automated browser and extracts data from them. Many websites forbid automated access or copying of their
> content in their Terms of Service or `robots.txt`, and scraping may also be restricted by copyright, database or data-protection law in your jurisdiction.
> It is intended for personal, low-volume use. You alone are responsible for how you use it: check the terms of every site you add, keep refresh intervals reasonable,
> and do not use it to bypass access controls, overload a site, or redistribute scraped content. The authors are not affiliated with any site you scrape and accept
> no liability for your use of the software.

## Quick start

```bash
npm install
npm run setup        # downloads Chrome for Testing for puppeteer (once). Skip if you have Chrome/Chromium/Edge/Brave
npm start            # http://localhost:3000, also reachable from the local network (no login: trusted networks only; HOST=127.0.0.1 npm start = this computer only)
npm run start:lan    # same, but also prints this computer's network addresses
```

> `npm install` may *not* download the browser (newer npm versions block puppeteer's postinstall script),
> which is why `npm run setup` exists. If no browser is found the UI shows a warning and the server logs one.

### Run with Docker

```bash
docker compose up -d --build      # first build takes a few minutes; then open http://localhost:5959 (change with HOST_PORT)
docker compose logs -f            # follow the log
docker compose down               # stop (data is kept in the `feed-data` volume)
```

* **Prebuilt image / Portainer**: `.github/workflows/docker.yml` builds an Intel + ARM image on every push to `main` (and `v*` tags) and pushes it to `ghcr.io/<owner>/<repo>`.
  `compose.ghcr.yaml` is the same stack but pulls that image: replace `OWNER/REPO` in it (lowercase) or set `FEED_IMAGE`. In Portainer use *Stacks → Add stack → Repository* with compose path
  `compose.ghcr.yaml` and set `HOST_PORT` etc. under *Environment variables*. Make the package public (GitHub → Packages → Package settings), or add ghcr.io as a registry in Portainer with a token.
* The image is `node:22-alpine` + Alpine's `chromium` (works on Intel and Apple Silicon; Puppeteer's own Chrome download isn't available for Linux arm64).
  It runs as the unprivileged `node` user with `CHROME_NO_SANDBOX=1` (Chromium's sandbox can't run inside a container; the container is the boundary).
* Feeds, `settings.json` and the image cache live in the `feed-data` volume mounted at `/data`. Back up: `docker run --rm -v feed-generator_feed-data:/data -v "$PWD":/backup alpine tar czf /backup/feed-data.tgz -C /data .`
  (the volume name is prefixed with the compose project name, check `docker volume ls`). To use a folder instead, replace the volume with `./data:/data` and make it writable for uid 1000.
* The port is published on all interfaces by default (`BIND_ADDR=0.0.0.0`) and `ALLOWED_HOSTS` defaults to `lan`, so the app and other instances (sync) can reach it from the local network
  (private IPv4 addresses, `nas:3000`, `*.local`, `*.lan`). The app has **no login**: use a trusted network and don't forward the port. Settings go in a `.env` file next to `compose.yaml` or the shell:
  `HOST_PORT`, `BIND_ADDR` (`127.0.0.1` = this computer only), `FEED_LANG` (e.g. `nl-NL`), `TZ`, `ALLOWED_HOSTS` (add names with `lan,my.domain:3000`).
* `.dockerignore` keeps `node_modules`, `data` and tests out of the build context. Running without Docker (`npm start`) and with Docker use separate data folders.

Configuration (environment variables):

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = this computer only) |
| `ALLOWED_HOSTS` | `lan` | Extra `Host` header values accepted besides localhost, comma separated (e.g. `nas.local:3000`), `lan` (any local-network address/name) or `*` (see Security) |
| `CHROME_NO_SANDBOX` | – | `1` adds `--no-sandbox --disable-dev-shm-usage --disable-gpu` to Chrome (set in the Docker image) |
| `DATA_DIR` | `./data` | Where feeds and cached images are stored |
| `CHROME_PATH` | – | Use this browser executable instead of auto-discovery |
| `FEED_LANG` | system locale | `Accept-Language` sent by the headless browser (affects currency/language on some stores) |
| `SYNC_INTERVAL_MS` | `300000` | How often the configuration is synced with the other instances besides syncing after every edit (see Sync, item 17) |
| `MIN_REFRESH_MS` | `60000` | Smallest allowed auto-refresh interval (lowered by the tests) |
| `SCHEDULER_TICK_MS` | `30000` | How often the scheduler checks for due feeds (lowered by the tests) |
| `HEADFUL` | – | `HEADFUL=1` shows the browser window while fetching (can help with some bot walls) |

Browser discovery order (`lib/fetcher.js: findBrowser`): `CHROME_PATH` → puppeteer's downloaded Chrome →
system Chrome / Chromium / Brave / Edge.

Tests: `npm test` (unit tests are instant; `test/e2e.test.js` and `test/paging.e2e.test.js` start the real server + Chrome against a fixture shop and take a few minutes together).

## How it behaves (user-visible requirements)

1. **Add feed screen**: fields *Web address*, *Name*, optional *Number of items* and optional *Address of the second page* (see Paging, item 15).
   Scheme-less input defaults to `https://` and falls back to `http://` if the site doesn't speak TLS.
2. On submit the page is rendered completely (waits for network idle, scrolls to trigger lazy loading / infinite
   scroll, waits for the DOM to stop changing, dismisses obvious cookie banners).
3. The analyzer ranks groups of repeating elements by how product-like they are.
   * **Confident** (clear image + title + price + unique links, expected count satisfied, no equally good rival
     section) → the feed is created immediately and the feed screen opens.
   * **Not confident** → a *"Help us find the items"* screen lists up to 8 candidates (item count, % with
     image/price/link, 3 previewed items, the first element's HTML). The user picks one **or pastes the outerHTML of one
     example item**, from which all look-alikes on the page are found (shown as another candidate to confirm).
   * If *Number of items* is given it is a **minimum**: candidates with fewer repeats are heavily demoted, and if the best
     one has fewer the user is asked instead of auto-accepting. (With a second page address the number is spread over several pages,
     so detection ignores it and it only decides when paging stops.)
4. **Feed screen** (the start screen; without feeds the list is empty and the right side says to add the first feed): left panel lists feeds (name, host, item count,
   *N new* badge, last update), most recently added first and selected by default. Right side shows the feed items
   (image, title, price + struck-through old price, delivery/availability, extra detail chips, *New* badge). Tapping an
   item opens its link in a new tab. A filter box searches the stored items. Buttons: **Update**, **Edit**, **Fix pattern**, **Delete**.
   **Configuration chips**: under the filter box one wrapping row of compact chips — `Wanted (n)`, `Ignored (n)` and `Feed settings (Auto 30m, Max 1000)`
   (the Wanted feed shows only the first two, for the global lists). Each chip opens its own modal (Esc, ✕ or a click on the backdrop closes it; the
   phrase lists stay open so several entries can be added, Feed settings closes after saving). The modal is a single persistent `<dialog id="panel-dialog">`
   re-rendered by `renderPanelDialog` whenever the view updates, preserving what is being typed; leaving the screen closes it.
5. **Auto refresh**: the first time a feed is opened in a page session (page load) it is refreshed in the background
   while the stored items show immediately. A just-created feed is not refreshed again.
6. **Dedup**: items are identified by a normalized link (see `normalizeUrl`). A refresh updates existing items in place
   and only *adds* unseen ones; items that disappear from the site stay in the feed (history). New items are shown first.
7. Everything is persisted; stored items remain visible when the target site (or the internet) is unreachable.
   A failed refresh keeps the items and records the error (shown in the header + toast).
8. **Wanted phrases** (fuzzy search over fetched items):
   * *Per feed*: the **Wanted** chip under the feed header (opens a modal). Matching items are moved into a **Wanted** section shown
     before the regular section ("Everything else"); they are not duplicated.
   * *Global*: the **Wanted** entry pinned at the top of the feed list (`#/wanted`) has its own Wanted and Ignored chips (global lists). It lists every item
     from **all feeds** matching a global phrase *or* the item's own feed's phrases (each card says which phrase matched and
     which feed it came from). Global phrases also create a Wanted section inside each feed.
   * Matching runs on demand (nothing is stored per item), so editing phrases applies to all existing items immediately.
9. **Stars**: every item card has a star button (stored as `starred: true` on the item, survives refreshes). A **Starred** toggle
   next to the filter box shows only starred items, in feeds and in the Wanted feed.
10. **Ignored list** (per feed and global, edited via the **Ignored** chip like Wanted): a rule is a fuzzy phrase **or a regular expression written as
    `/pattern/flags`** (e.g. `/refurbished|second[- ]hand/i`; regexes are case-sensitive unless `i` is given; `g`/`y` are ignored).
    Matching items are hidden from the feed (header shows "N hidden"), from the Wanted feed, from the *N new* badges and from the
    starred count. They stay in storage, so removing the rule brings them back. **Ignoring wins over wanted.** Regexes are validated
    when saved (400 + message, the input keeps its text).
11. **Max items per feed** (**Feed settings** chip; default 1000, empty = unlimited): when the limit is exceeded the oldest items
    (by fetch, then page position) are discarded. **Starred items are never discarded** (so the feed can exceed the limit if many are
    starred). The ids of discarded items are remembered (`discarded`, last 5000) so a refresh does not re-add or re-announce items the
    site still lists. Lowering the limit trims immediately; cached images of discarded items are deleted.
12. **Auto refresh per feed** (**Feed settings** chip; off by default): interval such as `90s`, `5m`, `2h`, `1d` (bare number = minutes;
    minimum 1 minute, maximum 30 days). It is run by a **server-side scheduler** (`lib/scheduler.js`), so it works while the app is running even
    if no browser tab is open. The interval counts from the last attempt (success or failure). The open page polls every 30 s (and on tab focus)
    and shows a toast + the new items when a background refresh happened.
13. **"Add to wanted" button** (bookmark-plus icon next to the star on every item): opens a small dialog with a suggested phrase (first
    4 words of the title, editable) and a scope: this feed or all feeds (default depends on the screen you are on).
14. Mobile: the feed list becomes an off-canvas drawer (hamburger in the top bar).
15. **Paging** (optional *Address of the second page*, in Add feed and Edit feed): the server compares the first and the second address as plain text
    (`lib/paging.js`), finds what was added or changed and takes the number in it as the page number. It is not tied to query parameters:
    `?q=x` → `?q=x&page=2`, `?page=1` → `?page=2`, `/shoes/` → `/shoes/page/2/`, `/shoes` → `/shoes-2`, `?start=0` → `?start=24` (offsets: the step is the
    difference, or the number itself when only an offset is visible), zero-padded numbers all work. The second address may also be typed relative (`?page=2`)
    or without scheme. It must be on the same site and contain a number; otherwise saving fails with a message.
    Pages 3, 4, … are then loaded from that template by every refresh (manual, background, scheduler), using the feed's stored pattern for each page. The crawl stops
    * when *Number of items* is reached (whole pages are kept, so slightly more can be stored),
    * after a page that shows items the feed already has (the rest is known; a normal refresh therefore only reads page 1 unless the shop's new items fill it),
    * at a page with no items we haven't seen in this run (empty page, or a shop that repeats its last page for numbers beyond the end),
    * after 50 pages, or when a page can't be loaded (items found so far are kept and a warning is shown in the feed header).
    Without *Number of items* the list is read to its end. Right after creating a feed with paging, or after an edit that changed the address, the second
    page address or raised the number of items, the client runs a **backfill** refresh (`POST …/refresh {backfill:true}`): it pages on *through* items that are
    already stored and files what it finds as **older** items (`seq` 0: below everything else and never "New"). Page 1 is saved first, so the feed opens at once
    and fills while "Loading more pages…" is shown.
16. **Edit feed** (**Edit** button, `#/edit/<id>`): change the name, web address, number of items and second page address of an existing feed.
    Items are kept. A changed address is read with the stored pattern at the next update (use **Re-select items…**, which saves and opens Fix pattern, if the new page
    is laid out differently).
17. **Settings & sync** (cog button next to *Add feed*, `#/settings`): the page lists the **other instances** to sync with. Enter `host:port` (scheme defaults to `http://`); more than one
    can be added, and adding B on A is enough (B learns A's data from the same request). The synced configuration is: the feeds (name, address, number of items, paging, **pattern**), each feed's
    wanted / ignored lists and settings (max items, auto refresh), and the global wanted / ignored lists. **Items and stars are not synced**; a feed that arrives on an instance is created empty
    and refreshed in the background. Each peer shows when it was last synced or why that failed. The other instance has to accept the `Host` it is called with (`ALLOWED_HOSTS`, see Security
    notes; `localhost` works as is). Existing feeds that were created separately on two instances are different feeds and both end up on both (delete the duplicates once).
18. **Minimum discount** (**Discount** chip, only shown for feeds where a discount is recognized or a filter is set): enter 1-100 to show only items discounted at least that much; **Remove filter** brings
    the rest back. The discount is `1 - price / oldPrice` when both are known, else the percentage of a badge such as `-20%` / `20% off` (`public/discount.js`, shared by browser and server). Items
    without a recognized discount count as below the minimum. Like ignored items they are hidden from the feed, the Wanted feed, the *N new* badge and the counts ("N hidden"), but stay stored. Saved
    per feed as `minDiscount` (part of the `settings` sync group, so it syncs between instances; `PUT /api/feeds/:id/settings {minDiscount: number|null}`).
19. **Delivery filter** (**Delivery** chip, only shown for feeds where an upcoming delivery date is recognized or a filter is set): choose *Show everything*, *Only items available right now* or
    *Only items coming out within x months*. The date is read from the item's delivery text in EN/NL/DE/FR/ES/IT (`April 2027`, `ab Januar 2027`, `17.10.2026`, `2027-02-14`, `3 March`; a month
    without a year means its next occurrence) and availability from wording such as `in stock`, `tomorrow`, `sold out`, `coming soon` (`public/delivery.js`, shared by browser and server). A month-only date counts
    from its first day; the current month is "not yet" available. Items without a recognized date/availability are hidden while a filter is on (like the discount filter, they stay stored and count in "N hidden").
    Saved per feed as `deliveryFilter` (`{mode:'now'}` | `{mode:'months', months}`; part of the `settings` sync group; `PUT /api/feeds/:id/settings {deliveryFilter}`).

## Architecture

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

### Request flow

```
Add feed submit ──POST /api/analyze {url, expectedCount}
   service.analyze → fetcher.fetchRenderedPage → analyzer.createContext → analyzer.analyze
   → session (cached rendered page + candidates, 20 min TTL, max 4) → response {sessionId, confident, recommended, candidates[]}
 confident? ──POST /api/feeds {sessionId, candidateId, name, url, expectedCount}   → feed created
 else user picks a candidate / pastes example (POST /api/analyze again with sessionId + exampleHtml; the cached page is reused)
 Update / auto-refresh ──POST /api/feeds/:id/refresh → fetch page, apply stored selector, merge items
```

### API (all JSON; errors are `{ "error": "message" }` with an HTTP status)

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

### Data model (`data/feeds/<id>.json`)

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

### Sync (`lib/sync.js`)

Pull-and-push in one request, no central server, no extra dependencies. Every `exchange` sends our configuration, the peer merges it and answers with its merged configuration, which we merge too, so both sides
converge after one round trip. Sync runs ~1.5 s after any configuration edit (`server.js` calls `sync.schedulePush()` after non-GET API calls except analyze/refresh/star), every `SYNC_INTERVAL_MS`, and from
**Sync now**. A merge that changed something is passed on to our other peers, so A – B – C chains converge; a merge that changes nothing ends the chatter.
Merging is **last write wins** with timestamps (ms of the editing instance's clock, so keep clocks roughly right), at a granularity of: feed groups `details | pattern | wanted | ignored | settings` (`sync.GROUPS`,
stamps in `feed.sync`), and the two global lists (`settings.sync`). Deleting a feed writes a tombstone in `settings.deletedFeeds` (kept forever, tiny) that wins over any feed with that id. Untrusted input is validated per
group (`sanitizeGroup`); an invalid group is skipped. New edits **must** call `touch(feed, group)` before saving, otherwise they will be overwritten by the next sync. Not handled (by design): concurrent edits of the
*same* group at the same time lose the older one; there is no authentication (same trust model as the rest of the app).

## Detection algorithm (`lib/analyzer.js`)

1. **Prepare** (`dom.loadClean`): drop script/style/svg/iframe/head/…, hidden elements (`hidden`, inline `display:none`).
   `<base href>` is honoured for relative URLs.
2. **Index** every element once (`buildIndex`): signature (`tag.stable.classes`), counts of descendants, text length,
   images, links, headings, price hits (a price may be split over elements – a capped `raw` text of the subtree is
   tested), "inside nav/header/footer".
   *Stable classes* drop state-like (`is-*`, `active`, `col-6`, `swiper-slide-*` …), BEM modifiers (`--x`) and
   generated CSS-in-JS names (`css-1abc2`, `sc-xyz`).
3. **Group** candidate elements (div/li/article/section/a/tr/td/figure/form/dl/custom elements):
   key A = own signature + parent signature, key B = own signature only. Groups need ≥ 2 members.
4. **Score** (`evaluate`) from, over a sample of ≤ 40 members: share with a link / image / title / price, uniqueness of
   links and images, × a log-count bonus; ×1.25 / ×0.25 when ≥ / < the expected count; penalties for nav/footer
   position, huge items, non-unique links.
5. **Resolve nesting** between the top 60: a *row* of cards loses against the cards (inner group wins when ≥ 1.5× more
   numerous *and* at least about as item-like); repeated sub-components (swatches, variant links) lose against the
   cards; for equal counts the *wrapper* wins so the whole item is available to the extractor.
6. **Confidence**: best candidate has link ≥ 0.8, unique links ≥ 0.5, image ≥ 0.6, title ≥ 0.8, price ≥ 0.6, satisfies the
   expected count, and no disjoint rival (score ≥ 0.9×, count ≥ 0.6×, price ≥ 0.6, < 70 % shared links) exists.
7. **Selector** (`buildSelector`): tries own signature then up to 5 ancestor levels (`a > b > c`) and takes the first that
   matches *exactly* the chosen members.
8. **Example matching** (`matchExample`): same-tag elements are scored by 0.3·class similarity + 0.7·weighted Jaccard of
   descendant `tag.class` tokens; thresholds 0.75 → 0.6 → 0.45 until ≥ max(2, expected) matches; nested matches are collapsed.
9. **Refresh** (`service.pickMembersForPattern`): apply the stored selector; if it matches nothing (or < 50 % of last time
   for lists ≥ 8) the stored `sample` is run through example matching and the selector is rewritten.

### Field extraction (`lib/extractor.js`)

* **link**: the item itself if it's an `<a>`; else prefer anchors in/around a heading, then around an image, then longest text;
  cart/wishlist/compare/login links are ignored.
* **image**: `data-src`-style lazy attributes → `srcset` (smallest ≥ 400 px) → `<picture><source>` → `src`; placeholders
  (data URIs, `spacer.gif`, …) and icons/logos/badges/tiny images skipped; falls back to CSS `background-image`.
* **title**: heading → `itemprop=name` → class containing title/name → link `title`/`aria-label` → img `alt` → link text → longest
  leaf text. Truncated titles (`…`/`...`) are expanded from attributes; a trailing `, Price £12` is stripped.
* **price / oldPrice**: smallest elements whose text matches a currency pattern (symbols and ISO codes, `1.299,00 €`,
  `$1,299.00`, `199 kr`). Old price = `<del>/<s>`, class words like `old/was/compare`, `line-through`, or a preceding label
  (“Previous price”, “Was”, “Vorher” …). Unit prices (`/kg`) and installments (`/month`) are ignored. Fallbacks: `itemprop=price`,
  `data-price`, price-classed bare numbers.
* **delivery**: smallest elements (≤ 140 chars) matching shipping/availability words in EN/NL/DE/FR/ES/IT. Keywords must start a word, so a shop name like `Brettspielversand` is not delivery info (`Gratisversand` is whitelisted). Availability wording such as `lieferbar`, `voraussichtlich`, `ausverkauft`, `leverbaar`, `coming soon`, `available from` counts too (`available in 3 colours` does not).
* **hidden information** (`extractHidden`): every element of the item is also checked for text that isn't visible: `title`, `aria-label`, `alt` and tooltip
  attributes (`data-bs-original-title`, `data-tooltip`, …) and schema.org `itemprop=availability` microdata. Example: an empty
  `<i title="VORAUSSICHTLICH lieferbar ab Januar 2027" class="game-availability-dot">` becomes the item's delivery text. What is kept:
  delivery/availability wording → **delivery**; a discount (`-20%`, `Rabatt`), a price remark with words (`UVP war 39,99 €`) or a date/month → a **chip**
  (shown before the visible chips); on a *text-less* element (icon, dot, badge) any tooltip of two or more words that isn't interface chrome → a chip.
  Ignored: the title again (link title, image alt), the element's own visible text again, tooltips of buttons/forms, wishlist / compare / zoom / close style
  tooltips, a bare amount (the price field has it), and anything on an element with visible text unless it is delivery, price, discount or date information.
* **details**: up to 4 short text chips (badges, brand, ratings, dates…). Rules (all generic, `extractDetails` in `lib/extractor.js`):
  * **Styling never splits a sentence.** An element that carries text of its own is read as *one* chip together with the links, `<strong>`s,
    line breaks and small badges inside it (≤ 140 chars): `Am <strong>Sa, 17.10.</strong> um <strong>05:36</strong><br>bei <a>Shop</a>` →
    `Am Sa, 17.10. um 05:36 bei Shop` (`isProse` / `proseText`). Layout wrappers (no text of their own), lists, headings, tables, forms and
    buttons are *not* merged: list items and separate badges stay separate chips.
  * **Abbreviation badges are dropped**: a short token (2–5 letters) that is the whole content of its own element and merely abbreviates the first
    word after it (`SO` → `Spiele-Offensive`, `Amz` → `Amazon`; letters must appear in order, starting with the same letter) is redundant (`abbreviates`).
  * A sentence with an **inline price/delivery** inside is dropped as a whole (that info has its own field); lone short lowercase connective words
    between elements (`am`, `bei`, `by`) are never chips.
  * A bare discount badge (`-20%`) is a chip; other numbers/symbols only are noise.
  * Buttons / elements with `btn|button|cta` classes, cart verbs, "more →" links and price labels (`Previous price`, `Vorheriger Bestpreis`) are skipped.
    A promo badge that merely contains "price" (`New Lower Price`) is kept.
* **id**: `normalizeUrl(link)` – drops hash, tracking params and session ids, and **the whole query string unless the path is
  generic** (`/product.php?id=5`, `/?p=12`), because many shops append per-visit tracking (eBay, Etsy).

## Fuzzy wanted matching (`public/fuzzy.js`)

One UMD file used by the browser (`window.Fuzzy`) and the server (`require('../public/fuzzy')`) so both always agree.
A phrase matches an item when **every phrase word** matches some word of `title + details + delivery` (accent/case-insensitive):
equal; prefix (≥ 3 chars); contained in a longer word (≥ 4); simple inflection (`sneaker`/`sneakers`); within an edit distance of
1 (4–6 chars) or 2 (≥ 7 chars) with transpositions; contained in the space-less item text (≥ 5 chars); or the whole multi-word
phrase space-less (`air max` ↔ `airmax`). Words of ≤ 3 chars and numbers must match exactly (so `iphone 15` ≠ `iPhone 14`).
`compile(phrases)` once, then `match(item, compiled)` → first matching phrase or `null`.
`parseRule` / `validateRule` / `compileRules` / `matchesRules` implement ignore rules (phrase or `/regex/flags`; regexes run against the title and the
full searchable text). Server side the global Wanted feed is `service.collectWanted(feeds, globalPhrases)`; the feed screen does the same split client side
(`buildModel` in `public/app.js`), so keep both on `Fuzzy`.

## Fetching (`lib/fetcher.js`)

One lazily started headless Chrome shared by all requests (max 2 pages in parallel, one incognito context per fetch,
100 s hard timeout). Fonts/media are blocked; images are not. Sequence: `goto(domcontentloaded)` → network idle →
cookie-consent click → mouse-wheel scroll to the bottom repeatedly until the page height stops growing (max 20 s) →
network idle → wait for DOM element count to stabilise → `page.content()`. `Accept-Language` follows `FEED_LANG`/system locale
and `HeadlessChrome` is removed from the UA.

### Paging (`lib/paging.js`, `service.crawlPages`)

`inferPaging(first, second)` finds the longest common start and end of the two addresses (the end may not overlap the start), widens the changed part to whole
digit runs (so `page=10` → `page=11` is the number 10 → 11, not "0 → 1") and then either (a) both changed parts are numbers: replaced number, step = difference, or
(b) the second address contains something extra: the number inside it (preferably the one equal to 2, else the last) is the page number; `2` counts pages from 1,
`1` from 0, any other value is an offset of one page. The result must reproduce the second address exactly. `pageUrl(paging, n)` gives page 1 = first address,
page 2 = second address as typed, page ≥ 3 = template. The pages behind page 1 are fetched **outside** the feed's lock (they can take minutes) one after the other
through the normal fetcher, and are read with the feed's stored selector (no sample-based repair on pages ≥ 2).

## Security notes

The server binds to `0.0.0.0` by default (reachable from the local network; there is no login, so don't expose the port to the internet; `HOST=127.0.0.1` limits it to this computer), rejects requests whose `Host` isn't localhost, a local-network address/name (`ALLOWED_HOSTS=lan`, the default) or listed in `ALLOWED_HOSTS` (DNS rebinding; this stays active when `HOST` is changed) and any request with a
non-matching `Origin` (cross-site). `/img` serves cached images with a sandboxing CSP. Feed ids are validated (`^[a-f0-9]{16}$`)
before touching the file system. All third-party text is inserted into the UI via `textContent` (no `innerHTML` for data).

## Known limitations / ideas for future work

* Sites with bot protection (Cloudflare, Akamai, captcha, login walls) may return empty/blocked pages (reported as such). `HEADFUL=1`, a different `CHROME_PATH`
  or a persistent browser profile (not implemented) may help.
* Paging needs the address of page 2 to be given by hand: "next page" links and "Load more" buttons are not followed (only scrolling is), and the page number has to
  be part of the address. Pages are fetched one at a time (several seconds each) and one refresh reads at most 50 pages; there is no progress indicator beyond
  "Loading more pages…". A feed = one URL (plus its paging).
* Shadow-DOM content isn't serialized by `page.content()`.
* Image cache is never pruned except when a feed is deleted.
* Auto refresh only runs while the server process runs (no OS-level service); a feed that became due while the app was off is refreshed
  shortly after start-up.
* Wanted matching only looks at title/details/delivery (not price). The client re-reads `/api/wanted` whenever the Wanted view opens.
* Ideas: scheduled refresh, "Load more" clicking, price-drop highlighting (`oldPrice`/history already partly available), OPML/RSS export,
  per-feed multiple URLs, persistent browser profile, notifications for new items.

## Conventions / gotchas for contributors (and AI agents)

* Plain CommonJS, no build step, no framework. Keep the frontend dependency-free.
* `puppeteer.executablePath()` is **async** (puppeteer ≥ 24) – `findBrowser()` is async for that reason.
* Item detection must stay purely structural/heuristic (no site-specific code). Add a fixture + test in `test/analyzer.test.js`
  or `test/extractor.test.js` for every heuristic change; `test/fixture-server.js` can emulate async-rendered shops.
* Item removal (max items) must go through `trimItems` so ids are tombstoned in `feed.discarded`; otherwise old items flip-flop back in.
* Any change to `normalizeUrl` changes item ids → would duplicate items in existing feeds.
* The analyzer works on the *cleaned* DOM (`loadClean`); stored selectors are applied to the same cleaned DOM at refresh time, so keep both in sync.

## License

[MIT](LICENSE)
