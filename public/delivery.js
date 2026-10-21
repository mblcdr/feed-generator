// Delivery / release date of an item, shared by the browser (window.Delivery) and the server (require) so both always agree.
// Reads the delivery text ("Delivery in April 2027", "voraussichtlich lieferbar ab Januar 2027", "17.10.2026", "in stock", ...).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Delivery = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = {
    1: ['january', 'januar', 'jan', 'janvier', 'januari', 'enero', 'gennaio'],
    2: ['february', 'februar', 'feb', 'février', 'fevrier', 'februari', 'febrero', 'febbraio'],
    3: ['march', 'märz', 'maerz', 'mars', 'maart', 'marzo', 'mar'],
    4: ['april', 'apr', 'avril', 'abril', 'aprile'],
    5: ['may', 'mai', 'mei', 'mayo', 'maggio'],
    6: ['june', 'juni', 'jun', 'juin', 'junio', 'giugno'],
    7: ['july', 'juli', 'jul', 'juillet', 'julio', 'luglio'],
    8: ['august', 'aug', 'août', 'aout', 'augustus', 'agosto'],
    9: ['september', 'sept', 'sep', 'septembre', 'setembre', 'settembre'],
    10: ['october', 'oktober', 'okt', 'oct', 'octobre', 'octubre', 'ottobre'],
    11: ['november', 'nov', 'novembre', 'noviembre'],
    12: ['december', 'dezember', 'dez', 'dec', 'décembre', 'decembre', 'diciembre', 'dicembre'],
  };
  const MONTH_OF = {};
  for (const m of Object.keys(MONTHS)) for (const n of MONTHS[m]) MONTH_OF[n] = Number(m);
  // Too ambiguous without a year or a day next to them ("may arrive", "mar").
  const AMBIGUOUS = new Set(['may', 'mar']);

  const MON = '((?<![\\p{L}])(?:' + Object.keys(MONTH_OF).sort((a, b) => b.length - a.length).join('|') + ')(?![\\p{L}])\\.?)';
  const monthNo = (s) => MONTH_OF[s.toLowerCase().replace(/\.$/, '')];

  const NEGATIVE = /(?<![\p{L}])(?:sold\s?out|out\s+of\s+stock|unavailable|not\s+available|not\s+in\s+stock|coming\s+soon|pre-?order|ausverkauft|nicht\s+(?:mehr\s+)?lieferbar|nicht\s+verfügbar|vergriffen|bald\s+verfügbar|uitverkocht|niet\s+(?:op\s+voorraad|leverbaar|beschikbaar)|binnenkort|épuisé|indisponible|bientôt|agotado|no\s+disponible|esaurito|non\s+disponibile)(?![\p{L}])/iu;
  const SOON = /(?<![\p{L}])(?:today|tomorrow|heute|morgen|vandaag|demain|hoy|mañana|oggi|domani|days?|tage?n?|dagen|jours|werktag\w*|werkdag\w*|hours?|stunden|uur)(?![\p{L}])/iu;
  const POSITIVE = /(?<![\p{L}])(?:in\s+stock|available\s+now|ships?|shipping|delivery|delivered|immediately|ready\s+to\s+ship|auf\s+lager|sofort|lieferbar|versandfertig|versand|lieferung|op\s+voorraad|direct\s+leverbaar|leverbaar|bezorgd|verzending|en\s+stock|disponible|livraison|en\s+existencias|disponibile)(?![\p{L}])/iu;

  const day = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addMonths = (d, n) => {
    const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
    r.setDate(Math.min(d.getDate(), new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()));
    return r;
  };
  const valid = (y, m, d) => {
    const t = new Date(y, m - 1, d);
    return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? t : null;
  };

  /**
   * The date named in a delivery text: { date, precise, yearGiven } or null. Without a year the next occurrence is assumed.
   * `precise` is false for a month only ("April 2027"): date is then its first day.
   */
  function parseDate(text, now) {
    text = String(text || '');
    const today = day(now || new Date());
    const fullYear = (y) => (y < 100 ? 2000 + y : y);
    // Year missing: this year, or next year when that would be more than 45 days in the past.
    const infer = (m, d) => {
      let t = valid(today.getFullYear(), m, d);
      if (t && today - t > 45 * 864e5) t = valid(today.getFullYear() + 1, m, d);
      return t;
    };
    let m;
    if ((m = /(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)/.exec(text))) {
      const t = valid(+m[1], +m[2], +m[3]);
      if (t) return { date: t, precise: true };
    }
    if ((m = /(?<!\d)(\d{1,2})[./-](\d{1,2})[./-](\d{4}|\d{2})(?!\d)/.exec(text))) {
      const t = valid(fullYear(+m[3]), +m[2], +m[1]);
      if (t) return { date: t, precise: true };
    }
    if ((m = new RegExp('(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|er|e)?\\.?\\s*(?:of\\s+|de\\s+)?' + MON + '(?:,?\\s*(\\d{4}))?(?!\\d)', 'iu').exec(text))) {
      const mo = monthNo(m[2]);
      const t = m[3] ? valid(+m[3], mo, +m[1]) : infer(mo, +m[1]);
      if (t && (m[3] || !AMBIGUOUS.has(m[2].toLowerCase()))) return { date: t, precise: true };
    }
    if ((m = new RegExp(MON + '\\s+(\\d{1,2})(?:st|nd|rd|th)?(?!\\d)(?:,?\\s*(\\d{4}))?', 'iu').exec(text))) {
      const mo = monthNo(m[1]);
      const t = m[3] ? valid(+m[3], mo, +m[2]) : infer(mo, +m[2]);
      if (t) return { date: t, precise: true };
    }
    if ((m = /(?<!\d)(\d{1,2})\.(\d{1,2})\.(?!\d)/.exec(text))) {
      const t = infer(+m[2], +m[1]);
      if (t) return { date: t, precise: true };
    }
    if ((m = new RegExp(MON + ',?\\s*(?:de\\s+)?(\\d{4})(?!\\d)', 'iu').exec(text))) {
      return { date: new Date(+m[2], monthNo(m[1]) - 1, 1), precise: false };
    }
    if ((m = new RegExp(MON, 'iu').exec(text)) && !AMBIGUOUS.has(m[1].toLowerCase())) {
      const mo = monthNo(m[1]);
      let y = today.getFullYear();
      if (mo < today.getMonth() + 1) y++;
      return { date: new Date(y, mo - 1, 1), precise: false };
    }
    return null;
  }

  /**
   * Availability of an item from its delivery text:
   * { state: 'now' } | { state: 'later', date } | { state: 'unavailable' } | null (nothing recognizable).
   */
  function availability(item, now) {
    now = now || new Date();
    const text = String((item && item.delivery) || '');
    if (!text) return null;
    const today = day(now);
    const neg = NEGATIVE.test(text);
    if (SOON.test(text) && !neg) return { state: 'now' };
    const d = parseDate(text, now);
    let past = false;
    if (d) {
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      if (d.precise ? d.date > today : d.date >= startOfMonth) return { state: 'later', date: d.date > today ? d.date : today };
      past = true;
    }
    if (neg) return { state: 'unavailable' };
    if (past || POSITIVE.test(text)) return { state: 'now' };
    return null;
  }

  /** Normalized filter ({ mode: 'now' } | { mode: 'months', months }) or null; throws nothing, invalid input gives undefined. */
  function cleanFilter(f) {
    if (f === null || f === undefined || f === '') return null;
    if (typeof f !== 'object') return undefined;
    if (f.mode === 'now') return { mode: 'now' };
    if (f.mode === 'months' && typeof f.months === 'number' && f.months >= 1 && f.months <= 120 && Number.isInteger(f.months)) return { mode: 'months', months: f.months };
    return undefined;
  }

  /** True when the item should be hidden by the feed's delivery filter (filter = null: no filter). */
  function belowDelivery(item, filter, now) {
    if (!filter) return false;
    now = now || new Date();
    const a = availability(item, now);
    if (filter.mode === 'now') return !(a && a.state === 'now');
    if (!a || a.state !== 'later') return true;
    return a.date > addMonths(day(now), filter.months);
  }

  /** Does this item have a delivery date in the future? (Decides whether a feed offers the filter.) */
  const hasUpcoming = (item, now) => {
    const a = availability(item, now);
    return !!a && a.state === 'later';
  };

  return { parseDate, availability, cleanFilter, belowDelivery, hasUpcoming };
});
