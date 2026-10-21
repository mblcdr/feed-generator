'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../lib/analyzer');

const URL_ = 'https://shop.test/list';
const nav = `<nav><ul class="menu">${['Men', 'Women', 'Kids', 'Sale'].map((n) => `<li><a href="/${n}">${n}</a></li>`).join('')}</ul></nav>`;
const footer = `<footer><ul>${['About', 'Contact', 'Jobs'].map((n) => `<li><a href="/${n}">${n}</a></li>`).join('')}</ul></footer>`;
const card = (i, cls = 'card') => `<div class="${cls}"><a href="/p/${i}"><img src="/i/${i}.jpg"><h3>Product ${i}</h3></a><span class="price">€ ${10 + i},00</span></div>`;
const page = (body) => `<html><body>${nav}<main>${body}</main>${footer}</body></html>`;

function run(html, opts) {
  const ctx = A.createContext(html, URL_);
  return { ctx, result: A.analyze(ctx, opts) };
}

test('simple grid: confident, exact selector, decoys ignored', () => {
  const { result } = run(page(`<div class="grid">${[1, 2, 3, 4, 5, 6].map((i) => card(i)).join('')}</div>`));
  assert.equal(result.confident, true);
  assert.equal(result.candidates[0].count, 6);
  assert.equal(result.candidates[0].selectorExact, true);
});

test('cards wrapped in rows of 3: picks the cards, not the rows', () => {
  const row = (a) => `<div class="row">${a.map((i) => card(i)).join('')}</div>`;
  const { result } = run(page(row([1, 2, 3]) + row([4, 5, 6]) + row([7, 8, 9])));
  assert.equal(result.candidates[0].count, 9);
  assert.match(result.candidates[0].selector, /card/);
});

test('modifier / state classes do not split the group', () => {
  const items = [1, 2, 3, 4, 5, 6].map((i) => card(i, i === 1 ? 'card card--featured is-active' : i % 2 ? 'card card--sale' : 'card'));
  const { result } = run(page(items.join('')));
  assert.equal(result.candidates[0].count, 6);
});

test('wrapper vs wrapped with equal counts prefers the wrapper (so the whole item is used)', () => {
  const items = [1, 2, 3, 4].map((i) => `<li class="cell">${card(i)}</li>`);
  const { result } = run(page(`<ul class="cells">${items.join('')}</ul>`));
  assert.equal(result.candidates[0].count, 4);
  assert.match(result.candidates[0].selector, /cell/);
});

test('repeated sub-components (variant swatches) do not replace the real cards', () => {
  const withSwatches = (i) => `<div class="tile"><a href="/p/${i}"><img src="/i/${i}.jpg"><h3>Item ${i}</h3></a><span class="price">€ ${i + 20}</span>${[1, 2, 3].map((c) => `<a class="swatch" href="/p/${i}?c=${c}"><img src="/c/${c}.png" width="60"></a>`).join('')}</div>`;
  const { result } = run(page([1, 2, 3, 4, 5].map(withSwatches).join('')));
  assert.equal(result.candidates[0].count, 5);
  assert.match(result.candidates[0].selector, /tile/);
});

test('expected count: groups below it are demoted and the user is asked', () => {
  const html = page(`<div class="a">${[1, 2, 3].map((i) => card(i)).join('')}</div><div class="b">${[4, 5, 6, 7, 8, 9, 10, 11].map((i) => card(i, 'tile')).join('')}</div>`);
  const { result } = run(html, { expected: 6 });
  assert.equal(result.candidates[0].count, 8);
  const { result: tooMany } = run(html, { expected: 50 });
  assert.equal(tooMany.confident, false);
  assert.match(tooMany.reason, /expected at least 50/);
});

test('two equally good sections make the result ambiguous', () => {
  const html = page(`<section class="men">${[1, 2, 3, 4].map((i) => card(i, 'mcard')).join('')}</section><section class="women">${[11, 12, 13, 14].map((i) => card(i, 'wcard')).join('')}</section>`);
  const { result } = run(html);
  assert.equal(result.confident, false);
  assert.match(result.reason, /More than one section/);
  assert.ok(result.candidates.length >= 2);
});

test('same products shown twice (carousel clone) is not ambiguous', () => {
  const html = page(`<div class="grid">${[1, 2, 3, 4].map((i) => card(i)).join('')}</div><div class="clone">${[1, 2, 3, 4].map((i) => card(i, 'card2')).join('')}</div>`);
  assert.equal(run(html).result.confident, true);
});

test('plain text list is offered but not trusted', () => {
  const html = `<html><body><ul>${[1, 2, 3, 4].map((i) => `<li><a href="/x/${i}">Plain ${i}</a></li>`).join('')}</ul></body></html>`;
  const { result } = run(html);
  assert.equal(result.confident, false);
  assert.ok(result.candidates.length >= 1);
});

test('table rows', () => {
  const rows = [1, 2, 3, 4].map((i) => `<tr class="product-row"><td><img src="/i/${i}.jpg"></td><td><a href="/p/${i}">Gadget ${i}</a></td><td>$${i + 4}.99</td></tr>`);
  const { result } = run(page(`<table><tbody>${rows.join('')}</tbody></table>`));
  assert.equal(result.candidates[0].count, 4);
  assert.match(result.candidates[0].selector, /product-row/);
});

test('page without anything repeating returns no candidates', () => {
  const { result } = run('<html><body><h1>Hello</h1><p>Nothing here</p></body></html>');
  assert.equal(result.candidates.length, 0);
  assert.equal(result.confident, false);
});

test('example matching finds siblings, tolerates optional parts and different text', () => {
  const items = [1, 2, 3, 4, 5].map((i) => `<li class="prod"><a href="/p/${i}">Thing ${i}</a>${i % 2 ? '<span class="badge">New</span>' : ''}<b>€ ${i}</b></li>`);
  const ctx = A.createContext(page(`<ul class="x">${items.join('')}</ul><ul class="y"><li><a href="/o">Other</a></li><li><a href="/o2">Other 2</a></li></ul>`), URL_);
  const c = A.matchExample(ctx, `<li class="prod"><a href="/p/99">Whatever</a><b>€ 5</b></li>`);
  assert.equal(c.count, 5);
  assert.equal(c.source, 'example');
  assert.equal(c.selectorExact, true);
});

test('example without classes still matches structurally', () => {
  const items = [1, 2, 3].map((i) => `<div><a href="/p/${i}"><img src="/i${i}.jpg"></a><p>Title ${i}</p><span>€ ${i}</span></div>`);
  const ctx = A.createContext(page(`<section>${items.join('')}</section>`), URL_);
  const c = A.matchExample(ctx, `<div><a href="/p/0"><img src="/i0.jpg"></a><p>Sample</p><span>€ 9</span></div>`);
  assert.equal(c.count, 3);
});

test('example that resembles nothing returns null', () => {
  const ctx = A.createContext(page(`<div class="grid">${[1, 2, 3].map((i) => card(i)).join('')}</div>`), URL_);
  assert.equal(A.matchExample(ctx, `<section><video></video><canvas></canvas></section>`), null);
  assert.equal(A.matchExample(ctx, `just text`), null);
});

test('stored selector is re-applied to a fresh page; hashed class names are ignored when building it', () => {
  const html = (n) => page(`<div class="grid">${Array.from({ length: n }, (_, i) => card(i + 1, 'card css-1a2b3c')).join('')}</div>`);
  const first = run(html(4));
  const sel = first.result.candidates[0].selector;
  assert.doesNotMatch(sel, /css-1a2b3c/);
  const ctx2 = A.createContext(html(7), URL_);
  assert.equal(A.selectBySelector(ctx2, sel).length, 7);
});

test('base href and relative URLs', () => {
  const html = `<html><head><base href="https://cdn.shop.test/base/"></head><body><div class="grid">${[1, 2, 3].map((i) => card(i)).join('')}</div></body></html>`;
  const ctx = A.createContext(html, URL_);
  const items = A.itemsFromMembers(ctx, A.analyze(ctx).candidates[0].members);
  assert.equal(items[0].url, 'https://cdn.shop.test/p/1');
});

test('hidden elements are ignored', () => {
  const html = page(`<div class="grid">${[1, 2, 3].map((i) => card(i)).join('')}<div class="card" style="display:none"><a href="/h">Hidden</a></div><div class="card" hidden><a href="/h2">Hidden 2</a></div></div>`);
  const { result } = run(html);
  assert.equal(result.candidates[0].count, 3);
});
