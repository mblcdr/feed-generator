'use strict';
// Loads a page in a real (headless) Chrome so that JavaScript-rendered content,
// lazy-loaded images and infinite-scroll lists are all part of the returned HTML.

const fs = require('node:fs');
const puppeteer = require('puppeteer');

const MAX_PARALLEL = 2;
const HARD_TIMEOUT_MS = 100_000;

class FetchError extends Error {
  constructor(message, status = 502, raw = '') {
    super(message);
    this.name = 'FetchError';
    this.status = status;
    this.raw = raw;
  }
}

const SYSTEM_BROWSERS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

/** CHROME_PATH, then the browser puppeteer downloaded (`npm run setup`), then a system Chrome/Chromium/Edge/Brave. */
async function findBrowser() {
  const env = process.env.CHROME_PATH;
  if (env && fs.existsSync(env)) return env;
  try {
    const p = await puppeteer.executablePath(); // async since puppeteer 24
    if (typeof p === 'string' && p && fs.existsSync(p)) return p;
  } catch {
    /* no bundled browser */
  }
  return SYSTEM_BROWSERS.find((p) => fs.existsSync(p)) || null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- browser lifecycle

let browserPromise = null;

function getBrowser() {
  // The promise is assigned synchronously: with `await findBrowser()` before it, two concurrent first calls
  // (parallel fetches, scheduler) each launched their own browser and only the last one was ever tracked/closed.
  if (!browserPromise) {
    const p = (async () => {
      const executablePath = await findBrowser();
      if (!executablePath) {
        throw new FetchError(
          'No Chrome/Chromium browser found. Run "npm run setup" to download one, or set CHROME_PATH to an existing browser.',
          500
        );
      }
      const b = await puppeteer.launch({
        executablePath,
        headless: !process.env.HEADFUL, // HEADFUL=1 shows the browser window (helps with some bot walls)
        args: [
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--mute-audio',
          '--hide-scrollbars',
          // Inside a container Chromium can't use its own sandbox and /dev/shm is tiny (set by the Docker image).
          ...(process.env.CHROME_NO_SANDBOX ? ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : []),
        ],
      }).catch((e) => {
        throw e instanceof FetchError ? e : new FetchError('Could not start the browser: ' + e.message, 500);
      });
      b.on('disconnected', () => {
        if (browserPromise === p) browserPromise = null;
      });
      return b;
    })();
    browserPromise = p;
    p.catch(() => {
      if (browserPromise === p) browserPromise = null;
    });
  }
  return browserPromise;
}

async function closeBrowser() {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    await (await p).close();
  } catch {
    /* already gone */
  }
}

// ---------------------------------------------------------------- tiny concurrency limiter

let running = 0;
const waiting = [];
async function limited(fn) {
  if (running >= MAX_PARALLEL) await new Promise((res) => waiting.push(res));
  running++;
  try {
    return await fn();
  } finally {
    running--;
    const next = waiting.shift();
    if (next) next();
  }
}

// ---------------------------------------------------------------- page helpers

async function settle(page, timeout = 12_000) {
  try {
    await page.waitForNetworkIdle({ idleTime: 800, timeout });
  } catch {
    /* some pages never go idle (analytics, websockets) - carry on */
  }
}

/** Click a cookie-consent "accept" button if there is an obvious one. */
async function dismissConsent(page) {
  try {
    const clicked = await page.evaluate(() => {
      const known = [
        '#onetrust-accept-btn-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#didomi-notice-agree-button',
        '.fc-cta-consent',
        '[data-testid="uc-accept-all-button"]',
        'button[id*="accept-all" i]',
        'button[id*="acceptAll" i]',
      ];
      for (const sel of known) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      const texts = new Set([
        'accept all', 'accept all cookies', 'accept cookies', 'accept', 'i accept', 'i agree', 'agree', 'allow all',
        'allow all cookies', 'got it', 'alles accepteren', 'accepteren', 'alle cookies accepteren', 'akkoord',
        'alle akzeptieren', 'akzeptieren', 'zustimmen', 'tout accepter', 'accepter', 'accepter et fermer',
        'aceptar todo', 'aceptar', 'accetta tutto', 'accetta',
      ]);
      const consentish = /cookie|consent|gdpr|privacy|cmp|banner|notice|onetrust|didomi|usercentrics/i;
      const nodes = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"], a:not([href]), a[href^="#"]');
      for (const el of nodes) {
        const t = (el.innerText || el.value || '').trim().toLowerCase();
        if (!texts.has(t) || el.offsetParent === null) continue;
        let p = el;
        for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
          if (consentish.test((p.id || '') + ' ' + (typeof p.className === 'string' ? p.className : ''))) {
            el.click();
            return true;
          }
        }
      }
      return false;
    });
    if (clicked) await sleep(700);
  } catch {
    /* best effort */
  }
}

/** Scroll down in steps so lazy loading and infinite scroll kick in; stop once the page stops growing. */
async function autoScroll(page, maxMs = 20_000) {
  const start = Date.now();
  let stableRounds = 0;
  let lastHeight = 0;
  while (Date.now() - start < maxMs) {
    // A real wheel event fires the same scroll/wheel listeners a user would trigger.
    await page.mouse.wheel({ deltaY: 700 }).catch(() => {});
    const { height, atBottom } = await page.evaluate(() => {
      const h = Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0);
      return { height: h, atBottom: window.scrollY + window.innerHeight >= h - 2 };
    });
    await sleep(250);
    if (!atBottom) {
      stableRounds = 0;
      lastHeight = height;
      continue;
    }
    // At the bottom: give lazy content a moment, then see if the page grew.
    await settle(page, 2_500);
    await sleep(500);
    const newHeight = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0));
    if (newHeight > lastHeight + 2) {
      lastHeight = newHeight;
      stableRounds = 0;
    } else if (++stableRounds >= 2) {
      break;
    }
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

/** Wait until the DOM stops changing size (late client-side renders). */
async function waitForDomStable(page, maxMs = 6_000) {
  const start = Date.now();
  let last = -1;
  let same = 0;
  while (Date.now() - start < maxMs) {
    const n = await page.evaluate(() => document.getElementsByTagName('*').length).catch(() => -1);
    if (n === last) {
      if (++same >= 2) return;
    } else {
      same = 0;
      last = n;
    }
    await sleep(500);
  }
}

function friendlyNavError(e, url) {
  const m = String(e && e.message);
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return `Could not resolve the address of ${new URL(url).host}. Check the URL and your connection.`;
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/.test(m)) return 'You appear to be offline.';
  if (/ERR_CONNECTION_REFUSED/.test(m)) return 'The server refused the connection.';
  if (/ERR_CERT/.test(m)) return 'The site has an invalid security certificate.';
  if (/ERR_TOO_MANY_REDIRECTS/.test(m)) return 'The site redirects in a loop.';
  return 'Could not load the page: ' + m.replace(/^net::/, '');
}

function normalizeInputUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) throw new FetchError('Please enter a web address.', 400);
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new FetchError('That does not look like a valid web address.', 400);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http and https addresses are supported.', 400);
  return u.href;
}

// ---------------------------------------------------------------- public

/**
 * Render `rawUrl` and return { html, finalUrl, title, status }.
 * Resolves only once network activity, lazy loading and late DOM changes have settled.
 */
async function fetchRenderedPage(rawUrl) {
  const url = normalizeInputUrl(rawUrl);
  const implicitScheme = !/^[a-z][a-z0-9+.-]*:\/\//i.test(String(rawUrl).trim());
  try {
    return await renderOnce(url);
  } catch (e) {
    // "shop.local" typed without a scheme defaults to https; fall back to http if the site doesn't speak TLS.
    if (implicitScheme && url.startsWith('https://') && /ERR_SSL|ERR_CONNECTION_(REFUSED|CLOSED|RESET)|ERR_CERT/.test(e.raw || '')) {
      return renderOnce('http://' + url.slice('https://'.length));
    }
    throw e;
  }
}

async function renderOnce(url) {
  return limited(async () => {
    const browser = await getBrowser();
    const context = await browser.createBrowserContext();
    let timer;
    const work = (async () => {
      const page = await context.newPage();
      await page.setViewport({ width: 1440, height: 900 });
      await page.mouse.move(700, 450);
      const ua = (await browser.userAgent()).replace('HeadlessChrome', 'Chrome');
      await page.setUserAgent(ua);
      const lang = process.env.FEED_LANG || Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
      await page.setExtraHTTPHeaders({ 'Accept-Language': `${lang},${lang.split('-')[0]};q=0.9,en;q=0.7` });
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const t = req.resourceType();
        const act = t === 'media' || t === 'font' ? req.abort() : req.continue();
        act.catch(() => {});
      });
      page.on('dialog', (d) => d.dismiss().catch(() => {}));

      let response = null;
      try {
        response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      } catch (e) {
        if (!(e && e.name === 'TimeoutError')) throw new FetchError(friendlyNavError(e, url), 502, String(e && e.message));
        // Slow page: carry on with whatever has loaded so far.
      }
      await settle(page);
      await dismissConsent(page);
      await autoScroll(page);
      await settle(page, 6_000);
      await waitForDomStable(page);

      let html;
      for (let attempt = 0; ; attempt++) {
        try {
          html = await page.content();
          break;
        } catch (e) {
          if (attempt >= 2) throw new FetchError('The page kept navigating while loading: ' + e.message);
          await sleep(1000); // client-side redirect in flight
        }
      }
      return {
        html,
        finalUrl: page.url() || url,
        title: await page.title().catch(() => ''),
        status: response ? response.status() : null,
        requestedUrl: url,
      };
    })();
    // If the hard timeout wins, `work` is still running; closing the context below makes it reject.
    work.catch(() => {});
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new FetchError('Loading the page took too long (over 100 seconds).', 504)), HARD_TIMEOUT_MS);
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      context.close().catch(() => {});
    }
  });
}

module.exports = { fetchRenderedPage, closeBrowser, findBrowser, normalizeInputUrl, FetchError };
