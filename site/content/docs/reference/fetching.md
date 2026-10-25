---
title: "Fetching and paging"
description: "The headless-browser fetch sequence and how page-number templates are inferred from two addresses."
summary: ""
slug: "fetching"
draft: false
weight: 30
toc: true
---

## Fetching (`lib/fetcher.js`)

One lazily started headless Chrome shared by all requests (max 2 pages in parallel, one incognito context per fetch,
100 s hard timeout). Fonts/media are blocked; images are not. Sequence: `goto(domcontentloaded)` → network idle →
cookie-consent click → mouse-wheel scroll to the bottom repeatedly until the page height stops growing (max 20 s) →
network idle → wait for DOM element count to stabilise → `page.content()`. `Accept-Language` follows `FEED_LANG`/system locale
and `HeadlessChrome` is removed from the UA.

## Paging (`lib/paging.js`, `service.crawlPages`)

`inferPaging(first, second)` finds the longest common start and end of the two addresses (the end may not overlap the start), widens the changed part to whole
digit runs (so `page=10` → `page=11` is the number 10 → 11, not "0 → 1") and then either (a) both changed parts are numbers: replaced number, step = difference, or
(b) the second address contains something extra: the number inside it (preferably the one equal to 2, else the last) is the page number; `2` counts pages from 1,
`1` from 0, any other value is an offset of one page. The result must reproduce the second address exactly. `pageUrl(paging, n)` gives page 1 = first address,
page 2 = second address as typed, page ≥ 3 = template. The pages behind page 1 are fetched **outside** the feed's lock (they can take minutes) one after the other
through the normal fetcher, and are read with the feed's stored selector (no sample-based repair on pages ≥ 2).

