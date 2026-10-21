'use strict';
// Finds the repeating "item" elements in a rendered page.
//
// Pipeline:
//   createContext(html, url)  -> parse, clean and index every element once
//   analyze(ctx, {expected})  -> group repeating siblings, score how "product-like" each group is,
//                                return ranked candidates + whether the best one is trustworthy
//   matchExample(ctx, html)   -> find elements that look like a user-supplied example item
//   selectBySelector(ctx, s)  -> re-apply a stored CSS selector to a fresh page
//   itemsFromMembers(...)     -> run the extractor over the matched elements

const { isEl, attr, loadClean, descendants, isAncestor, stableClasses, sigOf } = require('./dom');
const { extractItem, chooseLink, chooseImage, PRICE_TEST, hasPriceHint } = require('./extractor');

const CANDIDATE_TAGS = new Set(['div', 'li', 'article', 'section', 'a', 'tr', 'td', 'figure', 'form', 'dl']);
const CHROME_TAGS = new Set(['nav', 'header', 'footer', 'menu']);
const CHROME_ROLES = new Set(['navigation', 'banner', 'contentinfo']);
const HEADING = /^h[1-6]$/;
const MAX_ITEMS = 1500;
const RAW_CAP = 300;

// ---------------------------------------------------------------- indexing

function usableHref(h) {
  return !!h && !/^\s*(#|javascript:|mailto:|tel:)/i.test(h);
}

function createContext(html, pageUrl) {
  const baseMatch = /<base\s[^>]*?href\s*=\s*["']([^"']+)["']/i.exec(html);
  let base = pageUrl;
  try {
    if (baseMatch) base = new URL(baseMatch[1], pageUrl).href;
  } catch {
    /* keep page url */
  }
  const $ = loadClean(html);
  return { $, base, index: buildIndex($) };
}

function buildIndex($) {
  const list = [];
  const infos = new Map();
  let counter = 0;

  function visit(node, parent) {
    const tag = node.name;
    const cls = stableClasses(node);
    const info = {
      el: node,
      parent,
      tag,
      cls,
      sig: sigOf(tag, cls),
      idx: counter++,
      depth: parent ? parent.depth + 1 : 0,
      desc: 0,
      text: 0,
      imgs: tag === 'img' ? 1 : 0,
      links: tag === 'a' && usableHref(attr(node, 'href')) ? 1 : 0,
      prices: 0,
      headings: HEADING.test(tag) ? 1 : 0,
      chrome: parent ? parent.chrome : false,
    };
    if (CHROME_TAGS.has(tag) || CHROME_ROLES.has(attr(node, 'role'))) info.chrome = true;
    if (/background(-image)?\s*:[^;]*url\(/i.test(attr(node, 'style') || '') || attr(node, 'data-bg') || attr(node, 'data-background-image')) {
      info.imgs += 1;
    }
    const priceHint = hasPriceHint(node);
    const attrPrice = priceHint && (attr(node, 'itemprop') === 'price' || attr(node, 'data-price') != null);
    infos.set(node, info);
    list.push(info);

    // `raw` is the (capped) text of the subtree without separators, so a price split over
    // several elements ("<span>$</span>69.00") is still recognised on the element wrapping it.
    let raw = '';
    let childPrices = 0;
    for (const c of node.children || []) {
      if (c.type === 'text') {
        const t = c.data.trim();
        if (!t) continue;
        info.text += t.length;
        if (raw.length < RAW_CAP) raw += c.data.replace(/\s+/g, ' ');
      } else if (isEl(c)) {
        const ci = visit(c, info);
        info.desc += 1 + ci.desc;
        info.text += ci.text;
        info.imgs += ci.imgs;
        info.links += ci.links;
        info.headings += ci.headings;
        childPrices += ci.prices;
        if (raw.length < RAW_CAP) raw += ci.raw;
      }
    }
    raw = raw.length > RAW_CAP ? raw.slice(0, RAW_CAP) : raw;
    info.raw = raw;
    if (childPrices > 0) info.prices = childPrices;
    else if (attrPrice || PRICE_TEST.test(raw) || (priceHint && /\d/.test(raw))) info.prices = 1;
    return info;
  }

  for (const top of $.root()[0].children || []) if (isEl(top)) visit(top, null);
  return { list, infos };
}

// ---------------------------------------------------------------- grouping

function isCandidateTag(tag) {
  return CANDIDATE_TAGS.has(tag) || tag.includes('-');
}

function collectGroups(index, minCount) {
  const a = new Map();
  const b = new Map();
  for (const info of index.list) {
    if (!info.parent || !isCandidateTag(info.tag)) continue;
    if (!(info.links || info.imgs || info.text >= 3) || info.desc > 800) continue;
    const ka = info.sig + '|' + info.parent.sig;
    if (!a.has(ka)) a.set(ka, []);
    a.get(ka).push(info);
    if (info.cls.length) {
      if (!b.has(info.sig)) b.set(info.sig, []);
      b.get(info.sig).push(info);
    }
  }
  const seen = new Set();
  const out = [];
  for (const members of [...b.values(), ...a.values()]) {
    if (members.length < minCount) continue;
    const key = members.map((m) => m.idx).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(members);
  }
  return out;
}

/** Fraction of members that have another member as an ancestor. */
function nestedFraction(members) {
  const set = new Set(members.map((m) => m.idx));
  let nested = 0;
  for (const m of members) {
    for (let p = m.parent; p; p = p.parent) {
      if (set.has(p.idx)) {
        nested++;
        break;
      }
    }
  }
  return nested / members.length;
}

/** Fraction of `inner` members that sit inside one of `outer` members. */
function insideFraction(inner, outerSet) {
  const sample = inner.length > 40 ? inner.slice(0, 40) : inner;
  let n = 0;
  for (const m of sample) {
    for (let p = m.parent; p; p = p.parent) {
      if (outerSet.has(p.idx)) {
        n++;
        break;
      }
    }
  }
  return n / sample.length;
}

// ---------------------------------------------------------------- scoring

const ratio = (n, d) => (d ? n / d : 0);
const uniqueRatio = (arr) => {
  const v = arr.filter(Boolean);
  return v.length ? new Set(v).size / v.length : 0;
};

function evaluate(ctx, members, expected) {
  const n = members.length;
  const sample = n > 40 ? members.slice(0, 40) : members;
  const links = [];
  const imgs = [];
  for (const m of sample) {
    const l = chooseLink(m.el, ctx.base);
    links.push(l ? l.url : null);
    imgs.push(chooseImage(m.el, ctx.base));
  }
  const fLink = ratio(links.filter(Boolean).length, sample.length);
  const fImg = ratio(imgs.filter(Boolean).length, sample.length);
  const fPrice = ratio(sample.filter((m) => m.prices > 0).length, sample.length);
  const fTitle = ratio(sample.filter((m) => m.text >= 8 || m.headings > 0).length, sample.length);
  const uniqLink = uniqueRatio(links);
  const uniqImg = uniqueRatio(imgs);
  const avgText = sample.reduce((s, m) => s + m.text, 0) / sample.length;
  const avgDesc = sample.reduce((s, m) => s + m.desc, 0) / sample.length;
  const chromeFrac = ratio(sample.filter((m) => m.chrome).length, sample.length);

  let score = 1.0 * fImg + 1.0 * fLink + 0.8 * fTitle + 2.2 * fPrice + 0.8 * uniqLink + 0.3 * uniqImg;
  score *= 1 + 0.15 * Math.log2(Math.min(n, 64));
  if (expected) score *= n >= expected ? 1.25 : 0.25;
  if (chromeFrac > 0.5) score *= 0.5;
  if (avgText > 600 || avgDesc > 150) score *= 0.5;
  if (avgText < 4 && fImg < 0.5) score *= 0.5;
  if (uniqLink < 0.5) score *= 0.4;

  return {
    members,
    count: n,
    score,
    metrics: { fImg, fLink, fPrice, fTitle, uniqLink },
    linkSet: new Set(links.filter(Boolean)),
  };
}

// ---------------------------------------------------------------- selectors

function chainSelector(info, depth) {
  const parts = [];
  let cur = info;
  for (let i = 0; i <= depth && cur; i++, cur = cur.parent) parts.unshift(cur.sig);
  return parts.join(' > ');
}

function selectMembers(ctx, selector) {
  let nodes;
  try {
    nodes = ctx.$(selector).toArray();
  } catch {
    return [];
  }
  const infos = nodes.map((n) => ctx.index.infos.get(n)).filter(Boolean);
  return outermost(infos);
}

/** Drop members that are nested inside other members. */
function outermost(infos) {
  const set = new Set(infos.map((i) => i.idx));
  return infos.filter((i) => {
    for (let p = i.parent; p; p = p.parent) if (set.has(p.idx)) return false;
    return true;
  });
}

/** Shortest selector (own signature, then with ancestors) matching exactly the given members. */
function buildSelector(ctx, members) {
  const want = new Set(members.map((m) => m.idx));
  const first = members[0];
  let best = { selector: first.sig, exact: false, score: -1 };
  for (let depth = 0; depth <= 5; depth++) {
    const selector = chainSelector(first, depth);
    let got;
    try {
      got = ctx.$(selector).toArray().map((n) => ctx.index.infos.get(n)).filter(Boolean);
    } catch {
      continue;
    }
    const gotSet = new Set(got.map((g) => g.idx));
    let inter = 0;
    for (const i of gotSet) if (want.has(i)) inter++;
    const jac = inter / (want.size + gotSet.size - inter);
    if (jac === 1) return { selector, exact: true };
    if (jac > best.score) best = { selector, exact: false, score: jac };
    if (!first.parent) break;
  }
  return { selector: best.selector, exact: false };
}

// ---------------------------------------------------------------- public: analyze

function outerHtml(ctx, info, max = 4000) {
  const html = ctx.$.html(info.el);
  return html.length > max ? html.slice(0, max) + '…' : html;
}

function previewOf(ctx, members, n = 3) {
  const out = [];
  for (const m of members) {
    const it = extractItem(m.el, ctx.base);
    if (it) out.push(it);
    if (out.length >= n) break;
  }
  return out;
}

function toCandidate(ctx, ev, extra = {}) {
  const sel = buildSelector(ctx, ev.members);
  return {
    members: ev.members,
    count: ev.count,
    score: ev.score,
    metrics: ev.metrics,
    selector: sel.selector,
    selectorExact: sel.exact,
    preview: previewOf(ctx, ev.members),
    sampleHtml: outerHtml(ctx, ev.members[0]),
    linkSet: ev.linkSet,
    ...extra,
  };
}

function analyze(ctx, { expected = 0 } = {}) {
  const minCount = 2;
  const evaluated = [];
  for (const members of collectGroups(ctx.index, minCount)) {
    const n = members.length;
    const withLink = members.filter((m) => m.links > 0).length / n;
    const withImg = members.filter((m) => m.imgs > 0).length / n;
    if (withLink < 0.3 && withImg < 0.3) continue;
    if (nestedFraction(members) > 0.2) continue;
    const avgDesc = members.slice(0, 40).reduce((s, m) => s + m.desc, 0) / Math.min(n, 40);
    if (avgDesc > 500) continue;
    evaluated.push(evaluate(ctx, members, expected));
  }
  evaluated.sort((x, y) => y.score - x.score);

  // Resolve nesting between the strongest groups: rows vs. cards, wrapper vs. wrapped.
  const top = evaluated.slice(0, 60);
  const dropped = new Set();
  const sets = top.map((e) => new Set(e.members.map((m) => m.idx)));
  for (let i = 0; i < top.length; i++) {
    for (let j = 0; j < top.length; j++) {
      if (i === j || dropped.has(i) || dropped.has(j)) continue;
      const outer = top[i];
      const inner = top[j];
      if (insideFraction(inner.members, sets[i]) < 0.8) continue;
      if (inner.count >= outer.count * 1.5) {
        // Outer is a row/section of inner items - unless the inner group is just a repeated
        // sub-component of each item (swatches, variant links), which scores clearly lower.
        if (inner.score >= outer.score * 0.9) dropped.add(i);
        else dropped.add(j);
      } else if (outer.count >= inner.count * 1.5) dropped.add(j); // inner is a sub-part of the item
      else if (outer.score >= inner.score * 0.97) dropped.add(j); // same count: prefer the wrapper
      else dropped.add(i);
    }
  }
  const survivors = top.filter((_, i) => !dropped.has(i));

  const shown = survivors.slice(0, 8);
  const candidates = shown.map((ev, i) => toCandidate(ctx, ev, { id: 'c' + (i + 1), source: 'auto' }));
  candidates.forEach((c) => {
    c.belowExpected = !!expected && c.count < expected;
  });

  // Is the best candidate trustworthy enough to skip asking the user?
  let confident = false;
  let reason = '';
  const best = candidates[0];
  if (!best) {
    reason = 'No repeating elements that look like items were found.';
  } else {
    const m = best.metrics;
    const clear = m.fLink >= 0.8 && m.uniqLink >= 0.5 && m.fImg >= 0.6 && m.fTitle >= 0.8 && m.fPrice >= 0.6;
    if (!clear) reason = 'The best match does not clearly look like a list of purchasable items.';
    else if (expected && best.count < expected) reason = `The best match has ${best.count} items but you expected at least ${expected}.`;
    else {
      const rival = candidates.slice(1).find((c) => {
        if (c.metrics.fPrice < 0.6 || c.score < best.score * 0.9 || c.count < best.count * 0.6) return false;
        const overlap = [...c.linkSet].filter((l) => best.linkSet.has(l)).length / Math.max(1, Math.min(c.linkSet.size, best.linkSet.size));
        return overlap < 0.7;
      });
      if (rival) reason = 'More than one section of the page looks like a list of items.';
      else confident = true;
    }
  }
  return { candidates, confident, reason, recommended: best ? best.id : null };
}

// ---------------------------------------------------------------- public: example matching

function tokenCounts(root) {
  const map = new Map();
  let total = 0;
  for (const d of descendants(root)) {
    const cls = stableClasses(d);
    const tok = d.name + (cls.length ? '.' + cls.slice(0, 2).join('.') : '');
    map.set(tok, (map.get(tok) || 0) + 1);
    total++;
  }
  return { map, total };
}

function weightedJaccard(a, b) {
  let inter = 0;
  let union = 0;
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) || 0;
    const y = b.get(k) || 0;
    inter += Math.min(x, y);
    union += Math.max(x, y);
  }
  return union ? inter / union : 1;
}

function setJaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  const union = A.size + B.size - inter;
  return union ? inter / union : 1;
}

function parseExample(exampleHtml) {
  const $ = loadClean(String(exampleHtml || ''), { fragment: true });
  let root = ($.root()[0].children || []).find(isEl);
  while (root && (root.name === 'html' || root.name === 'body')) {
    const next = (root.children || []).find(isEl);
    if (!next) break;
    root = next;
  }
  return root ? { $, root } : null;
}

/**
 * Find all elements in the page that look like the pasted example.
 * Returns a candidate (same shape as analyze() candidates) or null.
 */
function matchExample(ctx, exampleHtml, { expected = 0 } = {}) {
  const ex = parseExample(exampleHtml);
  if (!ex) return null;
  const { root } = ex;
  const exCls = stableClasses(root);
  const exTokens = tokenCounts(root);
  const need = Math.max(2, expected || 0);

  const sims = [];
  for (const info of ctx.index.list) {
    if (info.tag !== root.name) continue;
    if (info.desc > exTokens.total * 2.5 + 5 || info.desc < exTokens.total * 0.4 - 2) continue;
    const structSim = weightedJaccard(exTokens.map, tokenCounts(info.el).map);
    const classSim = setJaccard(exCls, info.cls);
    sims.push({ info, sim: 0.3 * classSim + 0.7 * structSim });
  }

  let chosen = [];
  for (const t of [0.75, 0.6, 0.45]) {
    const matched = outermostBySim(sims.filter((s) => s.sim >= t));
    if (matched.length > chosen.length) chosen = matched;
    if (matched.length >= need) {
      chosen = matched;
      break;
    }
  }
  if (!chosen.length) return null;

  const members = chosen.map((s) => s.info).sort((a, b) => a.idx - b.idx);
  const ev = evaluate(ctx, members, expected);
  const cand = toCandidate(ctx, ev, { id: null, source: 'example', sample: String(exampleHtml).slice(0, 20000) });
  cand.belowExpected = !!expected && cand.count < expected;
  return cand;
}

/** Remove nested matches, keeping the one that resembles the example more. */
function outermostBySim(list) {
  const sorted = list.slice().sort((a, b) => b.sim - a.sim);
  const keep = [];
  for (const s of sorted) {
    const clash = keep.some((k) => isAncestor(k.info.el, s.info.el) || isAncestor(s.info.el, k.info.el));
    if (!clash) keep.push(s);
  }
  return keep;
}

// ---------------------------------------------------------------- public: apply stored pattern

function itemsFromMembers(ctx, members) {
  const seen = new Set();
  const items = [];
  for (const m of members) {
    const it = extractItem(m.el, ctx.base);
    if (!it || seen.has(it.id)) continue;
    seen.add(it.id);
    items.push(it);
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

function sampleOf(ctx, member) {
  return outerHtml(ctx, member, 20000);
}

module.exports = {
  createContext,
  analyze,
  matchExample,
  selectBySelector: selectMembers,
  itemsFromMembers,
  sampleOf,
  MAX_ITEMS,
};
