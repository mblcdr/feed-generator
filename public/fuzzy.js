// Fuzzy phrase matching, shared by the browser (window.Fuzzy) and the server (require).
//
// A phrase matches an item when EVERY word of the phrase fuzzy-matches some word of the item's text
// (title + details + delivery). A word matches when it is equal, a prefix, contained in a longer word,
// a plain inflection ("sneaker"/"sneakers"), within a small edit distance (typos), or part of the item text
// with spaces removed ("airmax" vs "air max"). Numbers must match exactly.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Fuzzy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function normalize(s) {
    return String(s == null ? '' : s)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  }

  /** Optimal-string-alignment distance (insert/delete/substitute/transpose), giving up above `max`. */
  function distance(a, b, max) {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev2 = null;
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const cur = [i];
      let rowMin = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
        if (prev2 && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
        cur[j] = v;
        if (v < rowMin) rowMin = v;
      }
      if (rowMin > max) return max + 1;
      prev2 = prev;
      prev = cur;
    }
    return prev[b.length];
  }

  const isNumeric = (s) => /^\p{N}+$/u.test(s);

  function wordMatches(q, t, flat) {
    if (q === t) return true;
    if (isNumeric(q) || isNumeric(t)) return false;
    if (q.length >= 3 && t.startsWith(q)) return true;
    if (q.length >= 4 && t.includes(q)) return true;
    if (t.length >= 4 && q.startsWith(t) && q.length - t.length <= 2) return true;
    if (q.length >= 5 && flat.includes(q)) return true;
    const max = q.length <= 3 ? 0 : q.length <= 6 ? 1 : 2;
    return max > 0 && distance(q, t, max) <= max;
  }

  /** Prepare phrases once: [{ raw, words, flat }]. Blank phrases are dropped. */
  function compile(phrases) {
    const out = [];
    for (const raw of phrases || []) {
      const words = normalize(raw).split(' ').filter(Boolean);
      if (words.length) out.push({ raw, words, flat: words.join('') });
    }
    return out;
  }

  function itemText(item) {
    return [item.title, ...(item.details || []), item.delivery].filter(Boolean).join(' ');
  }

  /** Returns the first matching phrase (as the user typed it) or null. */
  function match(item, compiled) {
    if (!compiled.length) return null;
    const tokens = normalize(itemText(item)).split(' ').filter(Boolean);
    if (!tokens.length) return null;
    const flat = tokens.join('');
    for (const p of compiled) {
      if (p.words.every((q) => tokens.some((t) => wordMatches(q, t, flat)))) return p.raw;
      if (p.words.length > 1 && p.flat.length >= 5 && flat.includes(p.flat)) return p.raw; // "air max" vs "airmax"

    }
    return null;
  }

  // ---- ignore rules: either a fuzzy phrase or a regular expression written as /pattern/flags

  const RULE_RE = /^\/(.+)\/([a-z]*)$/s;

  function parseRule(raw) {
    const text = String(raw == null ? '' : raw).trim();
    const m = RULE_RE.exec(text);
    if (!m) return { kind: 'phrase', text };
    try {
      // g/y make RegExp.test stateful, so they are dropped.
      return { kind: 'regex', text, re: new RegExp(m[1], m[2].replace(/[gy]/g, '')) };
    } catch (e) {
      return { kind: 'invalid', text, error: e.message };
    }
  }

  /** null when the rule is usable, otherwise a message for the user. */
  function validateRule(raw) {
    if (!String(raw == null ? '' : raw).trim()) return 'The rule is empty.';
    const r = parseRule(raw);
    return r.kind === 'invalid' ? (/^invalid/i.test(r.error) ? r.error : `Invalid regular expression: ${r.error}`) : null;
  }

  function compileRules(rules) {
    const out = [];
    for (const raw of rules || []) {
      const r = parseRule(raw);
      if (r.kind === 'regex') out.push({ kind: 'regex', re: r.re });
      else if (r.kind === 'phrase') {
        const c = compile([r.text]);
        if (c.length) out.push({ kind: 'phrase', compiled: c });
      }
    }
    return out;
  }

  /** True when any rule matches the item (regexes run against the title and the full searchable text). */
  function matchesRules(item, rules) {
    for (const r of rules) {
      if (r.kind === 'regex') {
        if ((item.title && r.re.test(item.title)) || r.re.test(itemText(item))) return true;
      } else if (match(item, r.compiled)) return true;
    }
    return false;
  }

  return { normalize, compile, match, distance, parseRule, validateRule, compileRules, matchesRules };
});
