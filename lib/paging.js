'use strict';
// Paging: work out from the address of the first page and the address of the second page how the
// site numbers its pages, so that page 3, 4, ... can be requested. Nothing here is specific to query
// strings: the two addresses are compared as plain text, the part that was added or changed is located
// and the number inside it is the page number. This handles
//   ?q=shoes -> ?q=shoes&page=2           (parameter added)
//   ?page=1  -> ?page=2                   (number replaced)
//   ?start=0 -> ?start=24                 (offset instead of page number: the step is taken from the difference)
//   /shoes/  -> /shoes/page/2/            (path segment added)
//   /shoes   -> /shoes/p2.html, /shoes-2  (anything else that carries a number)

const isDigit = (c) => c >= '0' && c <= '9';
const DIGITS_ONLY = /^\d+$/;

/** Safety net for a crawl: never request more pages than this in one run. */
const MAX_PAGES = 50;

class PagingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PagingError';
    this.status = 400;
  }
}

/** Address of page `n` (1 = the first page as typed, 2 = the second page as typed, 3+ computed from the template). */
function pageUrl(paging, n) {
  if (n <= 1) return paging.firstUrl;
  if (n === 2) return paging.secondUrl;
  return withValue(paging, paging.start + (n - 2) * paging.step);
}

function withValue(paging, value) {
  const text = String(value);
  return paging.prefix + (paging.pad ? text.padStart(paging.pad, '0') : text) + paging.suffix;
}

/**
 * Compare the first and second page address (both absolute http(s) URLs as produced by `new URL().href`)
 * and return { firstUrl, secondUrl, prefix, suffix, start, step, pad } where page n >= 2 lives at
 * prefix + (start + (n - 2) * step) + suffix. Throws PagingError when no page number can be found.
 */
function inferPaging(firstUrl, secondUrl) {
  const a = firstUrl;
  const b = secondUrl;
  let ua;
  let ub;
  try {
    ua = new URL(a);
    ub = new URL(b);
  } catch {
    throw new PagingError('The second page address is not a valid web address.');
  }
  if (a === b) throw new PagingError('The second page address is the same as the first one. Enter the address of page 2.');
  if (ua.origin !== ub.origin) throw new PagingError('The second page has to be on the same site as the first page.');

  // Longest common start and end; the end may not overlap the start.
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a[p] === b[p]) p++;
  let s = 0;
  while (s < max - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // A number is never split: "page=10" -> "page=11" differs in one digit only, but the page number is the whole 10 / 11.
  while (p > ua.origin.length && isDigit(a[p - 1])) p--;
  while (s > 0 && isDigit(a[a.length - s])) s--;

  const mid1 = a.slice(p, a.length - s);
  const mid2 = b.slice(p, b.length - s);
  const head = a.slice(0, p);
  const tail = a.slice(a.length - s);

  let prefix;
  let suffix;
  let start;
  let step;
  let pad = 0;

  if (DIGITS_ONLY.test(mid1) && DIGITS_ONLY.test(mid2)) {
    // A number was replaced by a bigger one: page=1 -> page=2, start=0 -> start=24, /1/ -> /2/.
    const n1 = parseInt(mid1, 10);
    const n2 = parseInt(mid2, 10);
    if (n2 <= n1) throw new PagingError('The second page number has to be higher than the first one.');
    prefix = head;
    suffix = tail;
    start = n2;
    step = n2 - n1;
    if (mid2.length > 1 && mid2[0] === '0') pad = mid2.length;
  } else {
    // Something that contains a number was added (or replaced a word): the number is the page.
    const runs = [...mid2.matchAll(/\d+/g)];
    if (!runs.length) throw new PagingError('Could not find a page number in the second address. It should be the address of page 2 of the same list, e.g. the "next page" link.');
    const run = runs.find((r) => parseInt(r[0], 10) === 2) || runs[runs.length - 1];
    const v = parseInt(run[0], 10);
    prefix = head + mid2.slice(0, run.index);
    suffix = mid2.slice(run.index + run[0].length) + tail;
    start = v;
    // page=2 counts pages from 1, page=1 counts from 0, anything else (24, 20, ...) is an offset of one page.
    step = v <= 2 ? 1 : v;
    if (run[0].length > 1 && run[0][0] === '0') pad = run[0].length;
  }

  const paging = { firstUrl: a, secondUrl: b, prefix, suffix, start, step, pad };
  // The template has to reproduce the address that was typed in for page 2.
  if (withValue(paging, start) !== b) throw new PagingError('Could not work out how paging works from those two addresses.');
  return paging;
}

/** Example addresses for the UI: where pages 3 and 4 will be fetched from. */
function describePaging(paging) {
  return { page3: pageUrl(paging, 3), page4: pageUrl(paging, 4) };
}

module.exports = { inferPaging, pageUrl, describePaging, PagingError, MAX_PAGES };
