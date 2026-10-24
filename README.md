# Feed Generator

A local web app that turns **online-store listing pages into an RSS-like feed**. Give it a category or search-results URL: it renders the page in headless Chrome (JavaScript, lazy images and infinite scroll included), finds the repeating item elements, extracts image / title / price / delivery info / link and stores them on disk. Browse the items in a clean list, refresh a feed to pull in only the *new* ones, and click an item to open the product page.

* Backend: Node.js (plain `http` server), `puppeteer`, `cheerio`. Frontend: dependency-free vanilla JS SPA (`public/`). Storage: JSON files in `data/` plus an image cache.

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
npm start            # http://localhost:3000 (HOST=127.0.0.1 npm start = this computer only)
npm run start:lan    # same, but also prints this computer's network addresses
```

`npm install` may *not* download the browser (newer npm versions block puppeteer's postinstall script), which is why `npm run setup` exists. If no browser is found the UI shows a warning.

With Docker: `docker compose up -d --build`, then open http://localhost:5959. Details (prebuilt images, Portainer, backups, settings): [docs/docker.md](docs/docker.md).

### Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = this computer only) |
| `ALLOWED_HOSTS` | `lan` | Extra `Host` header values accepted besides localhost, comma separated (e.g. `nas.local:3000`), `lan` (any local-network address/name) or `*` (see Security notes) |
| `CHROME_NO_SANDBOX` | – | `1` adds `--no-sandbox --disable-dev-shm-usage --disable-gpu` to Chrome (set in the Docker image) |
| `DATA_DIR` | `./data` | Where feeds and cached images are stored |
| `CHROME_PATH` | – | Use this browser executable instead of auto-discovery |
| `FEED_LANG` | system locale | `Accept-Language` sent by the headless browser (affects currency/language on some stores) |
| `SYNC_INTERVAL_MS` | `300000` | How often the configuration is synced with other instances, besides after every edit |
| `MIN_REFRESH_MS` | `60000` | Smallest allowed auto-refresh interval (lowered by the tests) |
| `SCHEDULER_TICK_MS` | `30000` | How often the scheduler checks for due feeds (lowered by the tests) |
| `HEADFUL` | – | `HEADFUL=1` shows the browser window while fetching (can help with some bot walls) |

Browser discovery order: `CHROME_PATH` → puppeteer's downloaded Chrome → system Chrome / Chromium / Brave / Edge.

Tests: `npm test` (unit tests are instant; the two `e2e` tests start the real server + Chrome against a fixture shop and take a few minutes).

## Documentation

* [Behaviour](docs/behavior.md): everything the app does from the user's point of view (adding feeds, wanted / ignored phrases, stars, paging, sync, filters).
* [Architecture](docs/architecture.md): module overview, request flow, API, data model, sync, contributor notes.
* [Detection and extraction](docs/detection.md): how items are found, how fields are extracted, fuzzy matching.
* [Fetching and paging](docs/fetching.md): the headless-browser sequence and how page-number templates are inferred.
* [Running with Docker](docs/docker.md)

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


## License

[MIT](LICENSE)
