// Discount of an item in percent, shared by the browser (window.Discount) and the server (require) so both always agree.
// From the current and the old price when both are known, otherwise from a discount badge such as "-20%" or "20% off".
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Discount = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NUM = '(?:\\d{1,3}(?:[.,\\s\\u00a0\\u202f]\\d{3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)';
  const BADGE = /[-−–]\s?(\d{1,3}(?:[.,]\d+)?)\s?%|(\d{1,3}(?:[.,]\d+)?)\s?%\s?(?:off|rabatt|korting|reduction|remise|descuento|sconto|günstiger|discount)/i;

  /** The first amount in a price text ("€ 1.299,50" -> 1299.5), NaN when there is none. */
  function parseAmount(text) {
    const m = new RegExp(NUM).exec(text);
    if (!m) return NaN;
    const s = m[0];
    const dec = /[.,](\d{1,2})$/.exec(s);
    if (dec) return parseFloat(s.slice(0, dec.index).replace(/\D/g, '') + '.' + dec[1]);
    return parseFloat(s.replace(/\D/g, ''));
  }

  /** Discount in percent (0-100, one decimal) or null when the item shows none. */
  function discountOf(item) {
    const cur = parseAmount(item.price);
    const old = parseAmount(item.oldPrice);
    if (cur >= 0 && old > cur) return Math.round((1 - cur / old) * 1000) / 10;
    for (const d of item.details || []) {
      const m = BADGE.exec(d);
      const pct = m && parseFloat((m[1] || m[2]).replace(',', '.'));
      if (pct > 0 && pct <= 100) return pct;
    }
    return null;
  }

  /** True when the item should be hidden by a "minimum discount" filter (min = null/0: no filter). */
  const belowDiscount = (item, min) => !!min && !((discountOf(item) || 0) >= min);

  return { NUM, parseAmount, discountOf, belowDiscount };
});
