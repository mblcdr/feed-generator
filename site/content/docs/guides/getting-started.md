---
title: "Getting started"
description: "A step-by-step guide to running Feed Generator, adding your first feed and keeping it up to date."
summary: ""
slug: "getting-started"
draft: false
weight: 5
toc: true
---

This guide takes you from nothing to a working feed. For the full list of features see [Behaviour](../behavior/).

## 1. Start the app

With Docker (the image bundles Chromium):

```bash
docker compose up -d --build
```

Then open <http://localhost:5959>.

To skip the build, save this as `compose.yaml` and run `docker compose up -d`. It pulls the latest prebuilt image (Intel and ARM) and keeps your data in a volume, so it also works as a Portainer stack:

```yaml
services:
  feed-generator:
    image: ghcr.io/mblcdr/feed-generator:latest
    container_name: feed-generator
    init: true # reaps Chromium's child processes
    restart: unless-stopped
    ports:
      - "5959:3000" # use "127.0.0.1:5959:3000" for this computer only
    environment:
      ALLOWED_HOSTS: lan # any local-network address or name; add more, e.g. "lan,example.com:3000"
      # FEED_LANG: nl-NL # Accept-Language of the headless browser (default en-US)
      # TZ: Europe/Amsterdam
    volumes:
      - feed-data:/data # feeds, settings and cached images
    shm_size: 512m

volumes:
  feed-data:
```

To pin a version, replace `latest` with a release tag such as `1.2.0`. More options (backups, ports, versions) are in the [README](https://github.com/mblcdr/feed-generator#running-with-docker).

Without Docker you need Node.js 24 or newer:

```bash
npm install
npm run setup   # downloads Chrome for Testing once; skip if you have Chrome, Chromium, Edge or Brave
npm start       # http://localhost:3000
```

If no browser is found, the UI shows a warning. Point to one with `CHROME_PATH`.

{{< callout context="caution" title="No login" >}}
The app has no authentication and listens on your local network by default. Use it only on networks you trust and never expose its port to the internet. Restrict it to this computer with `HOST=127.0.0.1` (Node) or `BIND_ADDR=127.0.0.1` (Docker).
{{< /callout >}}

## 2. Add a feed

Click **Add feed** and fill in:

* **Web address**: a category or search results page of a shop, for example a listing of all games or sneakers.
* **Name**: how the feed appears in your list.
* **Number of items** (optional): roughly how many items the page shows. Helps the analyzer pick the right section.
* **Address of the second page** (optional): only for lists spread over several pages, see [Multi-page lists](#multi-page-lists).

The page is opened in headless Chrome, scrolled to trigger lazy loading and read completely. This can take some seconds.

## 3. Confirm the items

If the analyzer is confident, the feed is created right away. Otherwise you see a **Help us find the items** screen with up to 8 candidates, each showing an item count and a few previewed items. Either:

* pick the candidate that looks like your products, or
* paste the HTML of one example item (right-click an item in your browser, *Inspect*, then copy the element's *outer HTML*). Feed Generator finds all look-alikes on the page.

## 4. Browse and stay updated

Your feeds are listed on the left (on a phone, behind the menu button). Select one to see its items with image, title, price, old price and delivery information. Click an item to open the product page.

* **Update** fetches the page again. Only unseen items are added, shown first with a *New* badge. Items that disappear from the shop stay in your history.
* The filter box searches the stored items.
* The star on an item keeps it, and the **Starred** toggle shows only starred items.

### Refresh automatically

Open **Feed settings** under the filter box and set an auto refresh interval such as `30m`, `2h` or `1d`. A scheduler on the server refreshes the feed, even when no browser tab is open. You can also limit the **Max items** kept per feed (starred items are never discarded).

## 5. Find what you care about

* **Wanted**: add phrases like `air max` and matching items move to the top of the feed. Matching is fuzzy, so small typos and plurals still match. The *Wanted* entry at the top of the feed list collects matches from all feeds.
* **Ignored**: add phrases, or a regular expression such as `/refurbished|second[- ]hand/i`, to hide items. Ignoring wins over wanted, and hidden items stay stored.
* **Discount** and **Delivery** chips appear on feeds where those are recognized. Use them to show only items with at least a given discount, or items that are in stock or coming out soon.

The quickest way to add a wanted phrase is the bookmark button next to the star on an item.

## Multi-page lists

If the shop splits a list into pages, fill in **Address of the second page** when adding the feed (or later via **Edit**). Feed Generator compares both addresses, works out how the page number is built (`?page=2`, `/page/2/`, `?start=24`, and so on) and reads page after page. Right after creating the feed, older pages are filled in as history, and the screen shows *Loading more pages…* meanwhile. Details are in [Fetching and paging](../../reference/fetching/).

## Fixing a feed

* **Edit** changes the name, address, number of items or second page address. Items are kept.
* **Fix pattern** lets you pick the items again if the shop changed its layout, and keeps existing items.
* If a shop returns empty pages, it may use bot protection. Try `HEADFUL=1` to watch the browser, or a different `CHROME_PATH`.

## Using several machines

The cog button next to **Add feed** opens settings. Enter another instance as `host:port` and feeds, patterns and phrase lists are kept in sync between the two. Items and stars are not synced. See [Behaviour](../behavior/) for details.

## Use it responsibly

Many sites forbid automated access in their Terms of Service or `robots.txt`. Feed Generator is meant for personal, low-volume use. Check the terms of every site you add and keep refresh intervals reasonable.
