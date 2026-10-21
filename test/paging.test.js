'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inferPaging, pageUrl, PagingError } = require('../lib/paging');

const pages = (a, b, ns = [1, 2, 3, 4, 10]) => {
  const p = inferPaging(new URL(a).href, new URL(b).href);
  return ns.map((n) => pageUrl(p, n));
};

test('a query parameter that is added', () => {
  assert.deepEqual(pages('https://s.example/c?q=shoes', 'https://s.example/c?q=shoes&page=2'), [
    'https://s.example/c?q=shoes',
    'https://s.example/c?q=shoes&page=2',
    'https://s.example/c?q=shoes&page=3',
    'https://s.example/c?q=shoes&page=4',
    'https://s.example/c?q=shoes&page=10',
  ]);
});

test('the first query parameter is added to an address without a query string', () => {
  assert.equal(pages('https://s.example/c', 'https://s.example/c?page=2')[2], 'https://s.example/c?page=3');
});

test('a parameter that was inserted before the others', () => {
  assert.equal(pages('https://s.example/c?q=x', 'https://s.example/c?page=2&q=x')[2], 'https://s.example/c?page=3&q=x');
});

test('a number that is replaced, also when the digits overlap (10 -> 11, 12 -> 22)', () => {
  assert.equal(pages('https://s.example/c?page=1', 'https://s.example/c?page=2')[4], 'https://s.example/c?page=10');
  assert.equal(pages('https://s.example/c?page=10', 'https://s.example/c?page=11')[2], 'https://s.example/c?page=12');
  assert.equal(pages('https://s.example/c?page=12', 'https://s.example/c?page=22')[2], 'https://s.example/c?page=32');
});

test('zero based pages and offsets', () => {
  assert.deepEqual(pages('https://s.example/c?page=0', 'https://s.example/c?page=1').slice(2), ['https://s.example/c?page=2', 'https://s.example/c?page=3', 'https://s.example/c?page=9']);
  assert.deepEqual(pages('https://s.example/c?start=0', 'https://s.example/c?start=24').slice(2), ['https://s.example/c?start=48', 'https://s.example/c?start=72', 'https://s.example/c?start=216']);
  // only the second address is known: 24 is taken as the size of one page
  assert.deepEqual(pages('https://s.example/c', 'https://s.example/c?offset=24').slice(2), ['https://s.example/c?offset=48', 'https://s.example/c?offset=72', 'https://s.example/c?offset=216']);
});

test('numbers in the path, not just in the query string', () => {
  assert.deepEqual(pages('https://s.example/shoes/', 'https://s.example/shoes/page/2/').slice(2), ['https://s.example/shoes/page/3/', 'https://s.example/shoes/page/4/', 'https://s.example/shoes/page/10/']);
  assert.equal(pages('https://s.example/shoes', 'https://s.example/shoes-2')[2], 'https://s.example/shoes-3');
  assert.equal(pages('https://s.example/shoes.html', 'https://s.example/shoes/p2.html')[2], 'https://s.example/shoes/p3.html');
  assert.equal(pages('https://s.example/shoes/1/list', 'https://s.example/shoes/2/list')[2], 'https://s.example/shoes/3/list');
  assert.equal(pages('https://s.example/c#top', 'https://s.example/c/2#top')[2], 'https://s.example/c/3#top');
});

test('zero padded numbers keep their width', () => {
  assert.equal(pages('https://s.example/c/01', 'https://s.example/c/02')[2], 'https://s.example/c/03');
  assert.equal(pages('https://s.example/c/09', 'https://s.example/c/10')[2], 'https://s.example/c/11');
});

test('numbers elsewhere in the address are left alone', () => {
  assert.equal(pages('https://s.example/c/2024/list?size=24', 'https://s.example/c/2024/list?size=24&page=2')[2], 'https://s.example/c/2024/list?size=24&page=3');
  assert.equal(pages('https://s.example/c/2024/list?page=1&size=24', 'https://s.example/c/2024/list?page=2&size=24')[2], 'https://s.example/c/2024/list?page=3&size=24');
});

test('the second address is reproduced exactly', () => {
  const a = 'https://s.example/c?page=1&sort=new';
  const b = 'https://s.example/c?page=2&sort=new';
  assert.equal(pageUrl(inferPaging(a, b), 2), b);
});

test('unusable second addresses are rejected with a message', () => {
  const bad = (a, b, re) => assert.throws(() => inferPaging(a, b), (e) => e instanceof PagingError && re.test(e.message));
  bad('https://s.example/c', 'https://s.example/c', /same as the first/);
  bad('https://s.example/c', 'https://other.example/c?page=2', /same site/);
  bad('https://s.example/c', 'https://s.example/d', /page number/);
  bad('https://s.example/c?page=3', 'https://s.example/c?page=2', /higher/);
  bad('https://s.example/c', 'not a url', /valid/);
});
