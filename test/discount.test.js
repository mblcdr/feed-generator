'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { discountOf, belowDiscount } = require('../public/discount');

test('discount from the old and the current price', () => {
  assert.equal(discountOf({ price: '€ 75,00', oldPrice: '€ 100,00' }), 25);
  assert.equal(discountOf({ price: '$1,299.00', oldPrice: '$1,999.00' }), 35);
  assert.equal(discountOf({ price: '€ 10', oldPrice: '€ 8' }), null, 'old price below the price is no discount');
});

test('discount from a badge when there is no old price', () => {
  assert.equal(discountOf({ price: '€ 9', details: ['Brand X', '-20%'] }), 20);
  assert.equal(discountOf({ price: '€ 9', details: ['15,5% korting'] }), 15.5);
  assert.equal(discountOf({ price: '€ 9', details: ['Brand X'] }), null);
});

test('belowDiscount hides items under the minimum, and everything without a discount', () => {
  const sale = { price: '70', oldPrice: '100' };
  assert.equal(belowDiscount(sale, 30), false);
  assert.equal(belowDiscount(sale, 31), true);
  assert.equal(belowDiscount({ price: '70' }, 10), true);
  assert.equal(belowDiscount({ price: '70' }, null), false);
});
