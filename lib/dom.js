'use strict';
// Small DOM helpers shared by the analyzer and the extractor.
// All helpers work on raw domhandler nodes (what cheerio wraps), not on cheerio objects.

const cheerio = require('cheerio');

function norm(s) {
  return String(s == null ? '' : s).replace(/[\s   ]+/g, ' ').trim();
}

const isEl = (n) => !!n && n.type === 'tag';

function attr(node, name) {
  return node && node.attribs ? node.attribs[name] : undefined;
}

/** Parse + strip everything that can never be part of a visible item. */
function loadClean(html, { fragment = false } = {}) {
  const $ = fragment ? cheerio.load(html, null, false) : cheerio.load(html);
  $('script,style,noscript,template,svg,iframe,head,canvas,object,embed,link,title,dialog').remove();
  $('[hidden],[style*="display:none"],[style*="display: none"]').remove();
  return $;
}

/** All descendant elements in document order. */
function descendants(node) {
  const out = [];
  const stack = (node.children || []).slice().reverse();
  while (stack.length) {
    const n = stack.pop();
    if (!isEl(n)) continue;
    out.push(n);
    const ch = n.children;
    if (ch) for (let i = ch.length - 1; i >= 0; i--) stack.push(ch[i]);
  }
  return out;
}

/** Text with a space between elements ("<div>A</div><div>B</div>" -> "A B"). */
function spacedText(node) {
  let out = '';
  (function rec(n) {
    for (const c of n.children || []) {
      if (c.type === 'text') out += c.data;
      else if (isEl(c)) {
        out += ' ';
        rec(c);
        out += ' ';
      }
    }
  })(node);
  return norm(out);
}

/** Text without added separators ("12,<sup>95</sup>" -> "12,95"). */
function rawText(node) {
  let out = '';
  (function rec(n) {
    for (const c of n.children || []) {
      if (c.type === 'text') out += c.data;
      else if (isEl(c)) rec(c);
    }
  })(node);
  return norm(out);
}

function isAncestor(anc, node) {
  for (let p = node.parent; p; p = p.parent) if (p === anc) return true;
  return false;
}

// ---------------------------------------------------------------- URLs

function absUrl(href, base) {
  if (!href) return null;
  const h = String(href).trim();
  if (!h || /^(javascript|mailto|tel|data|blob|about):/i.test(h) || h.startsWith('#')) return null;
  try {
    const u = new URL(h, base);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const TRACKING_PARAM = /^(utm_.+|gclid|fbclid|msclkid|mc_cid|mc_eid|ref|ref_|referrer|_ga|_gl|igshid|spm|scm|sid|sessionid|session_id|phpsessid|jsessionid|osCsid)$/i;
// Last path segments that say nothing about *which* item it is, so the query string must be kept.
const GENERIC_LAST = /^(index|default|product|products|item|items|detail|details|view|show|p|dp|pd|listing|article|catalog|catalogue|shop|store|goods|go|redirect|out|click|search)$/i;

/**
 * Stable identity for an item link. Product URLs usually carry the identity in the path
 * (".../p/kivik-s59494387", "/itm/4072959"), while the query string is often per-visit tracking
 * (eBay, Etsy, ...). So the query is only kept for generic paths like "/product.php?id=5".
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    const segs = u.pathname.split('/').filter(Boolean);
    const last = segs[segs.length - 1] || '';
    const scripted = /\.(php|aspx?|jsp|cgi|pl)$/i.test(last);
    const keepQuery = segs.length === 0 || scripted || GENERIC_LAST.test(last.replace(/\.[a-z0-9]+$/i, ''));
    if (!keepQuery) {
      u.search = '';
    } else {
      for (const [k, v] of [...u.searchParams.entries()]) {
        if (TRACKING_PARAM.test(k) || v.length > 40) u.searchParams.delete(k);
      }
      u.searchParams.sort();
    }
    let s = u.href;
    if (u.pathname.length > 1 && u.pathname.endsWith('/') && !u.search) s = s.replace(/\/$/, '');
    return s;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- class / signature helpers

const SAFE_CLASS = /^[A-Za-z_][A-Za-z0-9_-]*$/;
// State-like or layout-index classes that differ between otherwise identical siblings.
const STATE_CLASS =
  /^(?:active|selected|current|open|opened|show|shown|visible|hidden|loaded|loading|lazyloaded|lazyload|lazy|first|last|odd|even|hover|focus|focused|disabled|animated|fade|in|out|clearfix|(?:is|has|no|was)-.+|.+-(?:active|selected|loaded|loading|hidden|visible)|js-(?:active|loaded|hidden|open|visible)|ng-.+|slick-(?:active|current|cloned|center)|swiper-slide-.+|(?:first|last)-(?:child|item)|item-\d+|col-(?:xs-|sm-|md-|lg-|xl-)?\d+|row-\d+)$/i;
// Generated (CSS-in-JS) class names that change between deploys.
const GENERATED_CLASS = /^(?:css|sc|jsx|emotion|svelte|astro|chakra)-[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*$|^sc-[A-Za-z]{5,}$/;

function stableClasses(node) {
  const raw = String(attr(node, 'class') || '').split(/\s+/).filter(Boolean);
  let cls = raw.filter((c) => SAFE_CLASS.test(c) && !STATE_CLASS.test(c) && !GENERATED_CLASS.test(c));
  const noModifier = cls.filter((c) => !c.includes('--'));
  if (noModifier.length) cls = noModifier;
  return cls.slice(0, 4);
}

function sigOf(tag, cls) {
  return tag + cls.map((c) => '.' + c).join('');
}

module.exports = {
  norm,
  isEl,
  attr,
  loadClean,
  descendants,
  spacedText,
  rawText,
  isAncestor,
  absUrl,
  normalizeUrl,
  stableClasses,
  sigOf,
};
