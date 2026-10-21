'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseDate, availability, belowDelivery, cleanFilter } = require('../public/delivery');

const NOW = new Date(2026, 9, 19); // 19 Oct 2026
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');

test('dates in several languages and formats', () => {
  assert.equal(ymd(parseDate('Delivery in April 2027', NOW).date), '2027-4-1');
  assert.equal(parseDate('Delivery in April 2027', NOW).precise, false);
  assert.equal(ymd(parseDate('voraussichtlich lieferbar ab Januar 2027', NOW).date), '2027-1-1');
  assert.equal(ymd(parseDate('Verwacht 17 november 2026', NOW).date), '2026-11-17');
  assert.equal(ymd(parseDate('Release: 05.03.2027', NOW).date), '2027-3-5');
  assert.equal(ymd(parseDate('ships 2027-02-14', NOW).date), '2027-2-14');
  assert.equal(ymd(parseDate('Available March 3rd', NOW).date), '2027-3-3');
  assert.equal(ymd(parseDate('ab Mai', NOW).date), '2027-5-1', 'month without a year is the next one');
  assert.equal(parseDate('it may arrive soon', NOW), null);
  assert.equal(parseDate('Free delivery', NOW), null);
});

test('availability', () => {
  assert.equal(availability({ delivery: 'Delivery in April 2027' }, NOW).state, 'later');
  assert.equal(availability({ delivery: 'Delivery tomorrow' }, NOW).state, 'now');
  assert.equal(availability({ delivery: 'Delivery tomorrow, 20 October' }, NOW).state, 'now');
  assert.equal(availability({ delivery: 'In stock' }, NOW).state, 'now');
  assert.equal(availability({ delivery: 'Ausverkauft' }, NOW).state, 'unavailable');
  assert.equal(availability({ delivery: 'nicht lieferbar' }, NOW).state, 'unavailable');
  assert.equal(availability({ delivery: 'Sold out, expected April 2027' }, NOW).state, 'later');
  assert.equal(availability({ delivery: 'Delivered since March 2026' }, NOW).state, 'now');
  assert.equal(availability({ delivery: 'October 2026' }, NOW).state, 'later', 'this month is not yet certain');
  assert.equal(availability({}, NOW), null);
});

test('belowDelivery', () => {
  const april = { delivery: 'Delivery in April 2027' };
  const stock = { delivery: 'In stock' };
  assert.equal(belowDelivery(april, { mode: 'months', months: 6 }, NOW), false);
  assert.equal(belowDelivery(april, { mode: 'months', months: 5 }, NOW), true);
  assert.equal(belowDelivery(stock, { mode: 'months', months: 6 }, NOW), true);
  assert.equal(belowDelivery(stock, { mode: 'now' }, NOW), false);
  assert.equal(belowDelivery(april, { mode: 'now' }, NOW), true);
  assert.equal(belowDelivery({ title: 'x' }, { mode: 'now' }, NOW), true);
  assert.equal(belowDelivery(april, null, NOW), false);
});

test('cleanFilter', () => {
  assert.deepEqual(cleanFilter({ mode: 'now' }), { mode: 'now' });
  assert.deepEqual(cleanFilter({ mode: 'months', months: 3 }), { mode: 'months', months: 3 });
  assert.equal(cleanFilter(null), null);
  assert.equal(cleanFilter({ mode: 'months', months: 0 }), undefined);
  assert.equal(cleanFilter({ mode: 'months', months: 1.5 }), undefined);
  assert.equal(cleanFilter('x'), undefined);
});
