# Detection and extraction

[← Back to the README](../README.md)

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

## Field extraction (`lib/extractor.js`)

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

