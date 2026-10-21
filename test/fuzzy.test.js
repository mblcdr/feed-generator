'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Fuzzy = require('../public/fuzzy');

const m = (phrases, title, extra = {}) => Fuzzy.match({ title, ...extra }, Fuzzy.compile(phrases));

test('exact, case- and accent-insensitive', () => {
  assert.equal(m(['nike air max'], 'NIKE Air Max 90'), 'nike air max');
  assert.equal(m(['cafe'], 'Café Racer Jacket'), 'cafe');
});

test('typos, plurals, prefixes and spaces', () => {
  assert.equal(m(['sneaker'], 'White Sneakers'), 'sneaker');
  assert.equal(m(['sneakers'], 'White Sneaker'), 'sneakers');
  assert.equal(m(['adidas'], 'Addidas Samba'), 'adidas');
  assert.equal(m(['runn'], 'Running shoe'), 'runn');
  assert.equal(m(['air max'], 'Nike Airmax 270'), 'air max');
  assert.equal(m(['thinkpad'], 'Lenovo Think Pad E31'), 'thinkpad');
});

test('every word of the phrase must match; numbers must be exact', () => {
  assert.equal(m(['nike air max'], 'Nike Air Force 1'), null);
  assert.equal(m(['iphone 15'], 'iPhone 14 Pro'), null);
  assert.equal(m(['iphone 15'], 'Apple iPhone 15 Pro'), 'iphone 15');
});

test('short words are not matched loosely', () => {
  assert.equal(m(['cat'], 'Cot with mattress'), null);
  assert.equal(m(['tv'], 'Television set'), null);
});

test('details and delivery text are searched too', () => {
  assert.equal(m(['gore-tex'], 'Hiking boot', { details: ['Gore-Tex lining'] }), 'gore-tex');
  assert.equal(m(['pickup'], 'Lamp', { delivery: 'Free pickup today' }), 'pickup');
});

test('blank phrases are ignored; first matching phrase is reported', () => {
  assert.equal(Fuzzy.compile(['  ', '', '!!!']).length, 0);
  assert.equal(m(['zzz', 'lamp', 'desk'], 'Desk lamp'), 'lamp');
  assert.equal(m([], 'anything'), null);
});

test('edit distance', () => {
  assert.equal(Fuzzy.distance('kitten', 'sitting', 3), 3);
  assert.equal(Fuzzy.distance('ab', 'ba', 1), 1);
  assert.ok(Fuzzy.distance('abcdef', 'uvwxyz', 2) > 2);
});

test('ignore rules: fuzzy phrases and /regex/flags', () => {
  const rules = Fuzzy.compileRules(['refurbished', '/second[- ]hand/i', '/^EXACT/', '/(/', '  ']);
  assert.equal(rules.length, 3, 'invalid and blank rules are skipped');
  const hit = (title, extra) => Fuzzy.matchesRules({ title, ...extra }, rules);
  assert.equal(hit('Refurbised laptop'), true); // fuzzy
  assert.equal(hit('SECOND-HAND chair'), true); // regex with i flag
  assert.equal(hit('EXACT match'), true);
  assert.equal(hit('exact match'), false); // regex without i flag is case-sensitive
  assert.equal(hit('Brand new chair', { details: ['Condition: refurbished'] }), true);
  assert.equal(hit('Brand new chair'), false);
});

test('rule validation', () => {
  assert.equal(Fuzzy.validateRule('plain phrase'), null);
  assert.equal(Fuzzy.validateRule('/a|b/i'), null);
  assert.match(Fuzzy.validateRule('/(/'), /Invalid regular expression/);
  assert.match(Fuzzy.validateRule('/a/zz'), /Invalid/);
  assert.ok(Fuzzy.validateRule('   '));
  // g and y flags would make .test() stateful; they are ignored
  const r = Fuzzy.compileRules(['/cat/g']);
  assert.equal(Fuzzy.matchesRules({ title: 'cat' }, r), true);
  assert.equal(Fuzzy.matchesRules({ title: 'cat' }, r), true);
});
