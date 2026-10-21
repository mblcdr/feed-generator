'use strict';
// Background auto refresh: every tick, refresh the feeds whose own interval has elapsed
// (see service.isDue). Runs only while the server is running. Feeds are refreshed one at a time.

const store = require('./store');
const service = require('./service');

const TICK_MS = parseInt(process.env.SCHEDULER_TICK_MS || '30000', 10);
let timer = null;
let busy = false;

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const now = Date.now();
    for (const feed of await store.listFeeds()) {
      if (!service.isDue(feed, now)) continue;
      try {
        await service.refreshFeed(feed.id);
      } catch (e) {
        // The failure is already stored on the feed (lastFetch) and shown in the UI.
        console.warn(`Auto refresh of "${feed.name}" failed: ${e.message}`);
      }
    }
  } catch (e) {
    console.error('Scheduler error:', e);
  } finally {
    busy = false;
  }
}

function start() {
  if (timer) return;
  timer = setInterval(tick, TICK_MS);
  timer.unref();
  setTimeout(tick, 3000).unref(); // catch up on feeds that became due while the app was off
}

function stop() {
  clearInterval(timer);
  timer = null;
}

module.exports = { start, stop, tick };
