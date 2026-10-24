# Behaviour (user-visible requirements)

[← Back to the README](../README.md)

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
    and refreshed in the background. Each peer shows when it was last synced or why that failed. The other instance has to accept the `Host` it is called with (`ALLOWED_HOSTS`, see the Security notes in the README;
    `localhost` works as is). Existing feeds that were created separately on two instances are different feeds and both end up on both (delete the duplicates once).
18. **Minimum discount** (**Discount** chip, only shown for feeds where a discount is recognized or a filter is set): enter 1-100 to show only items discounted at least that much; **Remove filter** brings
    the rest back. The discount is `1 - price / oldPrice` when both are known, else the percentage of a badge such as `-20%` / `20% off` (`public/discount.js`, shared by browser and server). Items
    without a recognized discount count as below the minimum. Like ignored items they are hidden from the feed, the Wanted feed, the *N new* badge and the counts ("N hidden"), but stay stored. Saved
    per feed as `minDiscount` (part of the `settings` sync group, so it syncs between instances; `PUT /api/feeds/:id/settings {minDiscount: number|null}`).
19. **Delivery filter** (**Delivery** chip, only shown for feeds where an upcoming delivery date is recognized or a filter is set): choose *Show everything*, *Only items available right now* or
    *Only items coming out within x months*. The date is read from the item's delivery text in EN/NL/DE/FR/ES/IT (`April 2027`, `ab Januar 2027`, `17.10.2026`, `2027-02-14`, `3 March`; a month
    without a year means its next occurrence) and availability from wording such as `in stock`, `tomorrow`, `sold out`, `coming soon` (`public/delivery.js`, shared by browser and server). A month-only date counts
    from its first day; the current month is "not yet" available. Items without a recognized date/availability are hidden while a filter is on (like the discount filter, they stay stored and count in "N hidden").
    Saved per feed as `deliveryFilter` (`{mode:'now'}` | `{mode:'months', months}`; part of the `settings` sync group; `PUT /api/feeds/:id/settings {deliveryFilter}`).
