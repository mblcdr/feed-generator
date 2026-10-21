'use strict';
// Turns one "item" element (a product card, a list row, ...) into a plain object:
//   { id, title, url, image, price, oldPrice, delivery, details[] }
// Everything here is heuristic: it only looks at the markup of the element itself.

const crypto = require('node:crypto');
const { norm, isEl, attr, descendants, spacedText, rawText, absUrl, normalizeUrl } = require('./dom');

// ---------------------------------------------------------------- price detection

const CUR =
  "(?:[$€£¥₹₩₽₺₫₪฿₴₦]|(?<![A-Za-z])(?:US\\$|CA\\$|AU\\$|A\\$|R\\$|USD|EUR|GBP|CHF|SEK|NOK|DKK|PLN|CZK|HUF|RON|TRY|JPY|CNY|INR|CAD|AUD|NZD|BRL|MXN|AED|SAR|kr|zł|Kč|Ft|lei|RM|Rs)\\.?(?![A-Za-z]))";
const { NUM, parseAmount } = require('../public/discount'); // shared with the browser
const PRICE_SRC = `${CUR}\\s?-?\\s?${NUM}|${NUM}\\s?-?\\s?${CUR}`;
const PRICE_TEST = new RegExp(PRICE_SRC); // no g flag: safe to reuse with .test/.exec

/** Split a class/id string into lowercase words ("priceBox-old" -> price, box, old). */
function words(str) {
  return String(str || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}
const PRICE_WORDS = new Set(['price', 'prijs', 'preis', 'prix', 'precio', 'prezzo', 'cost']);
const OLD_WORDS = new Set([
  'old', 'was', 'before', 'original', 'strike', 'struck', 'striked', 'compare', 'rrp', 'msrp', 'crossed',
  'through', 'previous', 'slash', 'oldprice', 'wasprice',
]);
const UNIT_WORDS = new Set(['unit', 'unitprice', 'per', 'baseprice']);

function classWords(node) {
  return words(attr(node, 'class') + ' ' + (attr(node, 'id') || ''));
}
function hasPriceHint(node) {
  if (attr(node, 'itemprop') === 'price' || attr(node, 'data-price') != null) return true;
  return classWords(node).some((w) => PRICE_WORDS.has(w));
}

// A label right before the price ("Previous price", "Was", "Vorher") marks it as the old one.
const OLD_LABEL = /(previous|\bwas\b|before|original(ly)?|\bold\b|\brrp\b|\bmsrp\b|list price|vorige|eerder|oude|voorheen|adviesprijs|vorher|\bstatt\b|avant|antes|anterior)/i;

function precededByOldLabel(node, root) {
  let n = node;
  for (let level = 0; level < 4 && n && n !== root && n.parent; level++, n = n.parent) {
    let sib = n.prev;
    for (let k = 0; k < 2 && sib; k++, sib = sib.prev) {
      const t = sib.type === 'text' ? norm(sib.data) : isEl(sib) ? spacedText(sib) : '';
      if (t && t.length <= 40 && !PRICE_TEST.test(t)) return OLD_LABEL.test(t);
    }
  }
  return false;
}

function isOldPrice(node, root) {
  for (let n = node; n && n.type === 'tag'; n = n.parent) {
    if (n.name === 'del' || n.name === 's' || n.name === 'strike') return true;
    if (/line-through/i.test(attr(n, 'style') || '')) return true;
    if (classWords(n).some((w) => OLD_WORDS.has(w))) return true;
    if (n === root) break;
  }
  return OLD_LABEL.test(rawText(node).replace(PRICE_TEST, '')) || precededByOldLabel(node, root);
}
function isUnitPrice(node, ctxText) {
  if (classWords(node).some((w) => UNIT_WORDS.has(w))) return true;
  return /(\/|\bper\s|\bpro\s|\bpar\s)\s?(kg|g|l|ml|cl|100\s?(g|ml)|stuk|piece|unit|st\.?|m2|m)\b/i.test(ctxText);
}
const INSTALLMENT = /(\/\s?(mo|month|maand|monat|mois)\b|per month|a month|monthly|\bmo\.?\b|maandelijks|monatlich)/i;

function extractPrices(item) {
  const found = [];
  (function rec(n) {
    let childHas = false;
    for (const c of n.children || []) if (isEl(c) && rec(c)) childHas = true;
    if (childHas) return true;
    const t = rawText(n);
    if (!t) return false;
    const m = PRICE_TEST.exec(t);
    if (!m) return false;
    found.push({
      node: n,
      text: norm(m[0]),
      old: isOldPrice(n, item),
      unit: isUnitPrice(n, t),
      installment: INSTALLMENT.test(t),
    });
    return true;
  })(item);

  const usable = found.filter((f) => !f.unit && !f.installment);
  const pool = usable.length ? usable : found;
  const current = pool.find((f) => !f.old) || pool[0] || null;
  let old = null;
  if (current) {
    const cur = parseAmount(current.text);
    old = pool.find((f) => f.old && f !== current && (isNaN(cur) || parseAmount(f.text) > cur)) || null;
  }
  const nodes = found.map((f) => f.node);

  let price = current ? current.text : null;
  if (!price) {
    // Fallbacks: structured data / data attributes without a currency symbol in the text.
    for (const d of [item, ...descendants(item)]) {
      const prop = attr(d, 'itemprop');
      const v = prop === 'price' ? attr(d, 'content') || rawText(d) : attr(d, 'data-price');
      if (v && /\d/.test(v) && v.length <= 20) {
        const cur = descendants(item).find((x) => attr(x, 'itemprop') === 'priceCurrency');
        const curText = cur ? attr(cur, 'content') || rawText(cur) : '';
        price = norm(`${curText} ${v}`);
        nodes.push(d);
        break;
      }
    }
  }
  if (!price) {
    // A price-looking element holding just a number ("12.95"), currency rendered elsewhere.
    const el = descendants(item).find((d) => hasPriceHint(d) && !isOldPrice(d, item) && /^\D{0,3}\d[\d.,\s]*\D{0,3}$/.test(rawText(d)));
    if (el) {
      price = rawText(el);
      nodes.push(el);
    }
  }
  return { price, oldPrice: old ? old.text : null, nodes };
}

// ---------------------------------------------------------------- links

const HEADING = /^h[1-6]$/;
const BAD_LINK = /(add[-_]?to[-_]?(cart|bag|basket|wishlist|compare)|wish-?list|[?&]compare|\/cart\b|\/basket\b|\/login\b|\/account\b)/i;

function chooseLink(item, base) {
  const anchors = [];
  if (item.name === 'a') anchors.push(item);
  for (const d of descendants(item)) if (d.name === 'a') anchors.push(d);
  const cands = [];
  for (const a of anchors) {
    const url = absUrl(attr(a, 'href'), base);
    if (!url || BAD_LINK.test(url)) continue;
    cands.push({ node: a, url });
  }
  if (!cands.length) return null;
  const self = cands.find((c) => c.node === item);
  if (self) return self;

  const rank = (c) => {
    for (let p = c.node.parent; p && p !== item; p = p.parent) if (HEADING.test(p.name)) return 0;
    const inner = descendants(c.node);
    if (inner.some((d) => HEADING.test(d.name))) return 0;
    if (inner.some((d) => d.name === 'img' || d.name === 'picture')) return 1;
    return 2;
  };
  let best = null;
  for (const c of cands) {
    c.rank = rank(c);
    c.len = spacedText(c.node).length;
    if (!best || c.rank < best.rank || (c.rank === best.rank && c.len > best.len)) best = c;
  }
  return best;
}

// ---------------------------------------------------------------- images

function parseSrcset(s) {
  const out = [];
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && /[\s,]/.test(s[i])) i++;
    if (i >= n) break;
    let j = i;
    while (j < n && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j);
    i = j;
    let desc = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      let k = i;
      while (k < n && s[k] !== ',') k++;
      desc = s.slice(i, k).trim();
      i = k + 1;
    }
    if (!url) continue;
    const w = /(\d+(?:\.\d+)?)w/.exec(desc);
    const x = /(\d+(?:\.\d+)?)x/.exec(desc);
    out.push({ url, w: w ? parseFloat(w[1]) : 0, x: x ? parseFloat(x[1]) : 0 });
  }
  return out;
}

/** Prefer the smallest image that is still reasonably sharp (>= 400px wide). */
function pickFromSrcset(s) {
  const list = parseSrcset(s || '').filter((c) => usableImageUrl(c.url));
  if (!list.length) return null;
  const withW = list.filter((c) => c.w);
  if (withW.length) {
    const big = withW.filter((c) => c.w >= 400).sort((a, b) => a.w - b.w);
    return (big[0] || withW.sort((a, b) => b.w - a.w)[0]).url;
  }
  const withX = list.filter((c) => c.x).sort((a, b) => a.x - b.x);
  if (withX.length) return (withX.filter((c) => c.x <= 2).pop() || withX[0]).url;
  return list[0].url;
}

const PLACEHOLDER = /(^|\/)(spacer|pixel|blank|transparent|placeholder|loader|loading|lazy|dummy|1x1)[^/]*\.(gif|png|svg|jpe?g|webp)(\?|$)/i;
const ICON_IMG = /(^|[\/_\-. ])(logo|icon|sprite|badge|flag|avatar|rating|stars?|wish-?list|favou?rite|arrow|payment|trust|social|spinner)([\/_\-. ]|$)/i;

function usableImageUrl(u) {
  if (!u) return false;
  const s = String(u).trim();
  if (!s || /^(about|javascript|blob):/i.test(s)) return false;
  if (/^data:/i.test(s)) return /^data:image\/(jpeg|png|webp|avif)/i.test(s) && s.length > 2000;
  return !PLACEHOLDER.test(s);
}

const SINGLE_SRC_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-image', 'data-img', 'data-fallback-src'];
const SRCSET_ATTRS = ['data-srcset', 'data-lazy-srcset', 'data-original-set', 'srcset'];

function imgCandidate(img) {
  for (const a of SINGLE_SRC_ATTRS) {
    const v = attr(img, a);
    if (v && usableImageUrl(v)) return v.trim();
  }
  for (const a of SRCSET_ATTRS) {
    const v = pickFromSrcset(attr(img, a));
    if (v) return v;
  }
  if (img.parent && img.parent.name === 'picture') {
    for (const s of (img.parent.children || []).filter((c) => c.name === 'source')) {
      const v = pickFromSrcset(attr(s, 'srcset') || attr(s, 'data-srcset'));
      if (v) return v;
    }
  }
  const src = attr(img, 'src');
  return src && usableImageUrl(src) ? src.trim() : null;
}

function tinyImage(img) {
  const w = /^\d+$/.test(attr(img, 'width') || '') ? parseInt(attr(img, 'width'), 10) : null;
  const h = /^\d+$/.test(attr(img, 'height') || '') ? parseInt(attr(img, 'height'), 10) : null;
  return (w != null && w <= 48) || (h != null && h <= 48);
}

function bgImage(node) {
  const style = attr(node, 'style') || '';
  const m = /background(?:-image)?\s*:[^;]*url\((['"]?)(.*?)\1\)/i.exec(style);
  if (m && usableImageUrl(m[2])) return m[2].trim();
  for (const a of ['data-bg', 'data-background', 'data-background-image', 'data-lazy-bg']) {
    const v = attr(node, a);
    if (v && usableImageUrl(v)) return v.replace(/^url\((['"]?)(.*?)\1\)$/i, '$2').trim();
  }
  return null;
}

function chooseImage(item, base) {
  const all = descendants(item);
  for (const img of all) {
    if (img.name !== 'img') continue;
    if (tinyImage(img)) continue;
    const src = imgCandidate(img);
    if (!src) continue;
    if (ICON_IMG.test(src + ' ' + (attr(img, 'alt') || '') + ' ' + (attr(img, 'class') || ''))) continue;
    const abs = absUrl(src, base) || (/^data:/i.test(src) ? src : null);
    if (abs) return abs;
  }
  for (const n of [item, ...all]) {
    const bg = bgImage(n);
    if (bg) {
      const abs = absUrl(bg, base);
      if (abs) return abs;
    }
  }
  return null;
}

// ---------------------------------------------------------------- title

const TITLE_WORDS = new Set(['title', 'name', 'heading', 'headline']);
const NOT_TITLE_WORDS = new Set(['brand', 'vendor', 'manufacturer', 'category', 'cat', 'subtitle', 'sub', 'author', 'seller', 'store', 'shop', 'label', 'badge']);

function validTitle(t) {
  if (!t || t.length < 2) return false;
  if (/^[\d\s.,:;()\/\-–%]*$/.test(t)) return false;
  // Text that is nothing but a price ("€ 12,95", "from $5") is not a title.
  if (t.replace(new RegExp(PRICE_SRC, 'g'), '').replace(/[\s\-–:]|from|vanaf|ab|à partir de/gi, '').length < 2) return false;
  return true;
}

/** Sites often truncate the visible title ("A Light in the ..."); the full text is in a title/alt attribute. */
function expandTruncated(text, item) {
  if (!/(…|\.\.\.)$/.test(text)) return text;
  const prefix = text.replace(/\s*(…|\.\.\.)$/, '').toLowerCase();
  if (prefix.length < 3) return text;
  let best = text;
  for (const d of [item, ...descendants(item)]) {
    for (const v of [attr(d, 'title'), d.name === 'img' ? attr(d, 'alt') : null, attr(d, 'aria-label')]) {
      const full = norm(v);
      if (full.length > best.length && full.toLowerCase().startsWith(prefix)) best = full;
    }
  }
  return best;
}

function chooseTitle(item, linkNode) {
  const found = chooseTitleRaw(item, linkNode);
  return { ...found, text: expandTruncated(found.text, item) };
}

function chooseTitleRaw(item, linkNode) {
  const all = descendants(item);
  const heading = all.find((d) => HEADING.test(d.name) && validTitle(spacedText(d)));
  if (heading) return { text: spacedText(heading), node: heading };

  const prop = all.find((d) => attr(d, 'itemprop') === 'name' && d.name !== 'meta' && validTitle(spacedText(d)));
  if (prop) return { text: spacedText(prop), node: prop };

  const byClass = all.find((d) => {
    const w = classWords(d);
    return w.some((x) => TITLE_WORDS.has(x)) && !w.some((x) => NOT_TITLE_WORDS.has(x)) && validTitle(spacedText(d));
  });
  if (byClass) return { text: spacedText(byClass), node: byClass };

  if (linkNode) {
    const t = norm(attr(linkNode, 'title') || attr(linkNode, 'aria-label'));
    if (validTitle(t)) return { text: t, node: null };
  }
  const img = all.find((d) => d.name === 'img' && norm(attr(d, 'alt')).length >= 4);
  if (img) return { text: norm(attr(img, 'alt')), node: null };

  if (linkNode) {
    const t = spacedText(linkNode);
    if (validTitle(t) && !PRICE_TEST.test(t)) return { text: t, node: linkNode };
  }
  // Longest leaf text.
  let best = null;
  for (const d of all) {
    if (d.children && d.children.some(isEl)) continue;
    const t = spacedText(d);
    if (validTitle(t) && (!best || t.length > best.text.length)) best = { text: t, node: d };
  }
  return best || { text: '', node: null };
}

// ---------------------------------------------------------------- delivery & details

// Keywords must start a word: "Brettspielversand" (a shop name) is not delivery info, "Versand" / "Gratisversand" are.
const DELIVERY_RE = new RegExp(
  '(?<!\\p{L})(' +
    [
      'deliver', 'shipping', 'shipped', 'ships\\b', 'ship to', 'dispatch', 'arrives?\\b', 'pick-?\\s?up', 'collect(?:ion)?\\b',
      'in stock', 'out of stock', 'sold out', 'availability', 'back-?\\s?order', 'pre-?\\s?order', 'free returns?',
      'bezorg', 'verzend', 'levering', 'geleverd', 'voorraad', 'uitverkocht', 'morgen in huis',
      'lieferung', 'geliefert', 'lieferbar', 'versand', 'lieferzeit', 'auf lager', 'verfügbar', 'gratis-?versand', 'gratis-?lieferung',
      'voraussichtlich', 'vorbestell', 'ausverkauft', 'vergriffen', 'erscheint', 'erscheinungstermin',
      'leverbaar', 'beschikbaar', 'verwacht', 'binnenkort',
      'not available', 'unavailable', 'available (?:from|on|now|soon|for)', 'coming soon', 'expected', 'release date', 'restock',
      'livraison', 'livré', 'expédi', 'disponible', 'en stock', 'bientôt',
      'envío', 'entrega', 'disponibilidad', 'spedizione', 'consegna', 'disponibile',
    ].join('|') +
    ')',
  'iu'
);

/** `extra`: delivery texts found outside the visible text (tooltips, microdata), see extractHidden. */
function extractDelivery(item, excluded, extra = []) {
  const out = [];
  (function rec(n) {
    let childHas = false;
    for (const c of n.children || []) if (isEl(c) && rec(c)) childHas = true;
    if (childHas) return true;
    if (n === item || excluded.has(n)) return false;
    const t = spacedText(n);
    if (t.length > 0 && t.length <= 140 && DELIVERY_RE.test(t)) {
      out.push({ node: n, text: t });
      return true;
    }
    return false;
  })(item);
  const seen = new Set();
  const texts = [];
  for (const o of [...out, ...extra.map((text) => ({ text }))]) {
    const k = o.text.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      texts.push(o.text);
    }
  }
  return { text: texts.slice(0, 2).join(' · ') || null, nodes: out.map((o) => o.node) };
}

// ---------------------------------------------------------------- information that is not visible text
// Pages hide crucial facts in attributes: an empty <i title="Voraussichtlich lieferbar ab Januar 2027"> availability dot, a
// badge <span title="-20%">, an icon <img alt="Versandkostenfrei">, microdata <meta itemprop="availability" content="InStock">.
// Every element of the item is checked for such text; it is only used when it adds something and is not interface chrome.

const TIP_ATTRS = ['title', 'aria-label', 'data-original-title', 'data-bs-original-title', 'data-bs-title', 'data-title', 'data-tooltip', 'data-tip', 'data-balloon', 'alt'];
const MONTHS =
  'januar|january|januari|janvier|enero|februar|february|februari|février|febrero|märz|maerz|march|maart|mars|marzo|april|avril|abril|mai|may|mei|juni|june|juin|junio|juli|july|juillet|julio|august|augustus|août|agosto|september|septembre|septiembre|oktober|october|octobre|octubre|november|novembre|noviembre|dezember|december|décembre|diciembre';
const DATE_RE = new RegExp(`(?<!\\p{L})(?:${MONTHS})(?!\\p{L})|(?<!\\d)(?:19|20)\\d{2}(?!\\d)|(?<!\\d)\\d{1,2}[./]\\d{1,2}(?:[./]\\d{2,4})?(?!\\d)|\\bQ[1-4]\\b|\\b(?:KW|CW)\\s?\\d{1,2}\\b`, 'iu');
const DISCOUNT_RE = /[-−–]\s?\d{1,3}(?:[.,]\d+)?\s?%|\d{1,3}(?:[.,]\d+)?\s?%\s?(?:off|rabatt|korting|reduction|remise|descuento|sconto|günstiger|discount)|(?<!\p{L})(?:save|sparen|spare|rabatt|discount|korting|reduziert|gesenkt|angebot|aktion|deal)(?!\p{L})/iu;
// Tooltips of controls and decorations: not information about the item.
const UI_TIP = /wish ?list|wunschliste|merk(?:liste|zettel)|favou?rit|vergleich|compare|warenkorb|winkelwagen|\bcart\b|basket|\bzoom|\bshare\b|teilen|schlie(?:ß|ss)en|\bclose\b|\bnext\b|\bprev(?:ious)?\b|vorherige|nächste|zur produktseite|\bmenu\b|menü|\bopen\b|öffnen|\bimage\b|\bbild\b|\bfoto\b|\bpicture\b|\blogo\b/i;
const AVAILABILITY = {
  instock: 'In stock', outofstock: 'Out of stock', soldout: 'Sold out', preorder: 'Pre-order', presale: 'Pre-order', backorder: 'Back-order',
  limitedavailability: 'Limited availability', discontinued: 'Discontinued', onlineonly: 'Online only', instoreonly: 'In store only',
};

/** { delivery: [texts], chips: [texts] } found in attributes of the item's elements. */
function extractHidden(item, title, prices) {
  const delivery = [];
  const chips = [];
  const seen = new Set();
  const lt = letters(title);
  const known = prices.filter(Boolean).map(letters);
  const walk = (n) => {
    if (SKIP_DETAIL_TAGS.has(n.name) || isButtonish(n)) return;
    const own = spacedText(n);
    const lown = letters(own);
    const found = [];
    if (n.attribs && /^availability$/i.test(n.attribs.itemprop || '')) {
      const raw = String(n.attribs.content || n.attribs.href || own).replace(/^.*\//, '').toLowerCase().replace(/[^a-z]/g, '');
      if (AVAILABILITY[raw]) found.push({ v: AVAILABILITY[raw], itemprop: true });
    }
    for (const a of TIP_ATTRS) {
      if (a === 'alt' && !['img', 'area', 'input'].includes(n.name)) continue;
      const v = norm(attr(n, a));
      if (v.length >= 3 && v.length <= MAX_FRAGMENT) found.push({ v });
    }
    for (const { v, itemprop } of found) {
      const lv = letters(v);
      const k = v.toLowerCase();
      if (!lv || seen.has(k)) continue;
      seen.add(k);
      if (lt.length >= 3 && lv.length >= 3 && (lt.includes(lv) || lv.includes(lt))) continue; // the title again (link title, image alt)
      if (own && lown.includes(lv)) continue; // the visible text again
      if (known.includes(lv)) continue;
      const isDelivery = DELIVERY_RE.test(v);
      const hasPrice = PRICE_TEST.test(v) && /\p{L}{4,}/u.test(v); // a bare amount is the price field's business
      const isInfo = hasPrice || DISCOUNT_RE.test(v) || DATE_RE.test(v);
      if (itemprop || isDelivery) delivery.push(v);
      else if (isInfo) chips.push(v);
      else if (!own && !UI_TIP.test(v) && v.split(/\s+/).length >= 2) chips.push(v); // a text-less icon / dot / badge that says something
    }
    for (const c of n.children || []) if (isEl(c)) walk(c);
  };
  walk(item);
  return { delivery, chips };
}

const INLINE_TAGS = new Set(['b', 'i', 'em', 'strong', 'span', 'small', 'sup', 'sub', 'u', 'mark', 'abbr', 'time', 'font', 'br', 'wbr']);
const SKIP_DETAIL_TAGS = new Set(['button', 'select', 'option', 'textarea', 'fieldset', 'legend', 'label']);
// "Price:", "Previous price", "Vorheriger Bestpreis" - a label whose value lives in the price fields
const PRICE_LABEL = /^(?:(?:previous|old|was|original|regular|sale|current|now|from|best|lowest|list|vorheriger|vorige|eerdere|oude|alter|bisheriger|ancien)\s)?[\p{L}-]*(?:price|prijs|preis|prix|precio|prezzo)s?:?$/iu;
const CART_RE =
  /^(add to (cart|basket|bag)|buy( now)?|quick ?view|quick ?shop|compare|wish ?list|add to wish ?list|view( details| product)?|more( info)?|(mehr|meer|read more|learn more|lees meer|en savoir plus)( erfahren| info| lezen)?|details|select options|toevoegen aan winkelwagen|in winkelwagen|bestellen|bekijk|in den warenkorb|ajouter au panier)$/i;

function isInlineOnly(n) {
  for (const c of n.children || []) {
    if (isEl(c) && (!INLINE_TAGS.has(c.name) || !isInlineOnly(c))) return false;
  }
  return true;
}

// Elements that break a run of text into separate pieces (lists, headings, tables, forms, media).
const STRUCTURAL_TAGS = new Set(['ul', 'ol', 'dl', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'form', 'select', 'video', 'audio', 'picture', 'figure']);
const BUTTON_WORDS = new Set(['btn', 'button', 'cta']);
const isButtonish = (n) => n.name === 'button' || classWords(n).some((w) => BUTTON_WORDS.has(w));

const MAX_FRAGMENT = 140;

/**
 * Is this element one run of prose ("Am Sa, 17.10. um 05:36 bei Shop")? Styling must not split a sentence:
 * an element that carries text of its own is read as ONE fragment together with the links, emphasis, line
 * breaks and small badges inside it - as long as it stays short and holds no price, button, list, heading or table.
 */
function isProse(n, excluded) {
  if (n.name === 'a' || isInlineOnly(n)) {
    // plain inline run (or a link): fine as long as nothing excluded sits inside
  } else if (!(n.children || []).some((c) => c.type === 'text' && /[\p{L}\p{N}]/u.test(c.data))) {
    return false; // no text of its own: a layout wrapper, its children are judged one by one
  }
  const inner = descendants(n);
  if (inner.some((d) => SKIP_DETAIL_TAGS.has(d.name) || STRUCTURAL_TAGS.has(d.name) || isButtonish(d))) return false;
  if (spacedText(n).length > MAX_FRAGMENT) return false;
  const used = inner.filter((d) => excluded.has(d));
  if (!used.length) return 'prose';
  // A price or delivery text inline within the sentence ("17,90 € am 20.09. bei Shop"): that information is
  // already shown in its own field, and what is left of the sentence is meaningless without it.
  return used.every((d) => INLINE_TAGS.has(d.name) || d.name === 'a') ? 'covered' : false;
}

/** Letters/digits only, lowercase, accents removed: "Bücher.de" -> "bucherde". */
const letters = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

function isSubsequence(small, big) {
  let i = 0;
  for (const ch of big) if (ch === small[i]) i++;
  return i === small.length;
}

/**
 * Pages often put a tiny logo-like badge in front of a name: "SO" before "Spiele-Offensive", "Amz" before
 * "Amazon", "SPF" before "Spielefürst". A short token that sits in its own element and only abbreviates the
 * first word that follows adds nothing to the sentence.
 */
function abbreviates(token, followingText) {
  const tok = letters(token);
  const first = letters(followingText.split(' ')[0] || '');
  return tok.length >= 2 && tok.length <= 5 && tok.length < first.length && tok[0] === first[0] && isSubsequence(tok, first);
}

/** The pieces of a run of prose in reading order; `own` marks text that is the entire content of one element. */
function proseSegments(n, out = []) {
  for (const c of n.children || []) {
    if (c.type === 'text') {
      const t = norm(c.data);
      if (t) out.push({ text: t, own: false });
    } else if (isEl(c) && c.name !== 'br' && c.name !== 'wbr') {
      if (!(c.children || []).some(isEl)) {
        const t = spacedText(c);
        if (t) out.push({ text: t, own: true });
      } else proseSegments(c, out);
    }
  }
  return out;
}

/** One sentence from an element: segments joined, redundant abbreviation badges dropped, spacing tidied. */
function proseText(n) {
  const segs = proseSegments(n);
  const kept = segs.filter((seg, i) => !(seg.own && /^\p{L}{2,5}$/u.test(seg.text) && i + 1 < segs.length && abbreviates(seg.text, segs[i + 1].text)));
  return kept
    .map((seg) => seg.text)
    .join(' ')
    .replace(/\s+([,.;:!?%)\]])/g, '$1') // "12 , 95" -> "12, 95"
    .replace(/([(\[])\s+/g, '$1')
    .replace(/(\d)\s*:\s*(?=\d)/g, '$1:') // "05 : 36" -> "05:36"
    .replace(/^(?:[\s\/|·,]|[\-–](?!\d))+|[\s\/|·,\-–]+$/g, ''); // separators at the ends, but "-20%" keeps its minus
}

function extractDetails(item, excluded, title, hidden = []) {
  const out = [];
  const seen = new Set([title.toLowerCase()]);
  const add = (t) => {
    const k = t.toLowerCase();
    if (seen.has(k) || k === title.toLowerCase()) return;
    seen.add(k);
    out.push(t);
  };
  hidden.slice(0, 2).forEach(add); // facts found in attributes come first
  const consider = (raw) => {
    const t = norm(raw);
    if (t.length < 2 || t.length > MAX_FRAGMENT) return;
    // numbers and symbols only are noise - except a discount badge such as "-20%"
    if (/^[\d\s.,:;()\/\-–%★☆•|]*$/.test(t) && !/^[-−–]?\s?\d{1,3}\s?%$/.test(t)) return;
    if ((PRICE_TEST.test(t) && !/%/.test(t)) || CART_RE.test(t.replace(/[\s→»›>…]+$/u, '')) || PRICE_LABEL.test(t)) return;
    add(t);
  };
  const rec = (n) => {
    if (out.length >= 4 || excluded.has(n) || SKIP_DETAIL_TAGS.has(n.name) || isButtonish(n)) return;
    const prose = n !== item && isProse(n, excluded);
    if (prose) {
      if (prose === 'prose') consider(proseText(n));
      return;
    }
    for (const c of n.children || []) {
      if (c.type === 'text') {
        // A lone short lowercase word between elements ("am", "bei", "by") only connects other parts: not a chip.
        if (!/^\p{Ll}{1,4}$/u.test(norm(c.data))) consider(c.data);
      } else if (isEl(c)) rec(c);
    }
  };
  rec(item);
  return out;
}

// ---------------------------------------------------------------- public

const PRICE_LABEL_SRC = '(?:(?:current |sale |now |from )?(?:price|prijs|preis|prix|precio|prezzo):?\\s*)';
const TRAILING_PRICE = new RegExp(
  `(?:\\s*[,;|–—-]\\s*${PRICE_LABEL_SRC}?(?:${PRICE_SRC})\\s*$)|(?:\\s+${PRICE_LABEL_SRC}(?:${PRICE_SRC})\\s*$)`,
  'i'
);

/** "Trainers in black, Price £185.00" -> "Trainers in black" */
function stripTrailingPrice(title) {
  const head = title.replace(TRAILING_PRICE, '').trim();
  return head.length >= 3 ? head : title;
}

const clip = (s, n) => (s && s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

function extractItem(item, base) {
  const link = chooseLink(item, base);
  const image = chooseImage(item, base);
  const t = chooseTitle(item, link && link.node);
  const title = clip(stripTrailingPrice(t.text), 250) || '';
  if (!title && !image) return null;
  if (!link && !title) return null;

  const { price, oldPrice, nodes: priceNodes } = extractPrices(item);
  const excluded = new Set(priceNodes);
  if (t.node && t.node !== item) excluded.add(t.node);
  const hidden = extractHidden(item, title, [price, oldPrice]);
  const delivery = extractDelivery(item, excluded, hidden.delivery);
  for (const n of delivery.nodes) excluded.add(n);
  const details = extractDetails(item, excluded, title, hidden.chips);

  const url = link ? link.url : null;
  const id = url
    ? 'u:' + normalizeUrl(url)
    : 'h:' + crypto.createHash('sha1').update(title + '|' + (image || '')).digest('hex').slice(0, 16);

  return {
    id,
    title,
    url,
    image,
    price: price || null,
    oldPrice: oldPrice || null,
    delivery: clip(delivery.text, 200) || null,
    details: details.map((d) => clip(d, 140)),
  };
}

module.exports = {
  extractItem,
  chooseLink,
  chooseImage,
  PRICE_TEST,
  hasPriceHint,
  parseSrcset,
  pickFromSrcset,
  parseAmount,
  words,
};
