'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { extractItem, parseSrcset, pickFromSrcset, parseAmount } = require('../lib/extractor');
const { normalizeUrl } = require('../lib/dom');

const BASE = 'https://shop.test/cat/';
function extract(html) {
  const $ = cheerio.load(`<body>${html}</body>`);
  return extractItem($('body').children()[0], BASE);
}

test('title, link, image, price from a typical card', () => {
  const it = extract(`<article class="card"><a href="/p/1"><img src="/img/1.jpg" alt="Alt"><h3>Blue Shirt</h3></a><span class="price">€ 24,95</span></article>`);
  assert.equal(it.title, 'Blue Shirt');
  assert.equal(it.url, 'https://shop.test/p/1');
  assert.equal(it.image, 'https://shop.test/img/1.jpg');
  assert.equal(it.price, '€ 24,95');
  assert.equal(it.oldPrice, null);
});

test('price formats', () => {
  const price = (txt) => extract(`<div><a href="/x">Thing</a><b>${txt}</b></div>`).price;
  assert.equal(price('$1,299.00'), '$1,299.00');
  assert.equal(price('1.299,00 €'), '1.299,00 €');
  assert.equal(price('199 kr'), '199 kr');
  assert.equal(price('£5'), '£5');
  assert.equal(price('USD 12.50'), 'USD 12.50');
  assert.equal(price('<span>€</span><span>12</span>,<sup>95</sup>'), '€12,95');
  assert.equal(price('Save 20%'), null);
});

test('old price via <del>, class, or preceding label; unit and installment prices ignored', () => {
  let it = extract(`<div><a href="/x">Tee</a><del>€ 99,00</del><ins>€ 79,00</ins></div>`);
  assert.deepEqual([it.price, it.oldPrice], ['€ 79,00', '€ 99,00']);
  it = extract(`<div><a href="/x">Tee</a><span class="price-new">€ 10</span><span class="price-old">€ 15</span></div>`);
  assert.deepEqual([it.price, it.oldPrice], ['€ 10', '€ 15']);
  it = extract(`<div><a href="/x">Tee</a><b>€ 899</b><div><span>Previous price </span><span>€ 999</span></div></div>`);
  assert.deepEqual([it.price, it.oldPrice], ['€ 899', '€ 999']);
  it = extract(`<div><a href="/x">Tee</a><span class="price">€ 20</span><span class="unit-price">€ 2,00 / kg</span><span>or € 5 / month</span></div>`);
  assert.equal(it.price, '€ 20');
  assert.equal(it.oldPrice, null);
});

test('price-looking class with bare number and itemprop fallbacks', () => {
  assert.equal(extract(`<div><a href="/x">Tee</a><span class="product-price">12.95</span></div>`).price, '12.95');
  assert.equal(extract(`<div><a href="/x">Tee</a><meta itemprop="priceCurrency" content="EUR"><meta itemprop="price" content="33.00"></div>`).price, 'EUR 33.00');
});

test('lazy images: data-src beats placeholder src, srcset picks a sharp size, icons are skipped', () => {
  const PX = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  assert.equal(extract(`<div><a href="/x">Tee</a><img src="${PX}" data-src="/real.jpg"></div>`).image, 'https://shop.test/real.jpg');
  assert.equal(extract(`<div><a href="/x">Tee</a><img srcset="/s.jpg 200w, /m.jpg 480w, /l.jpg 1200w" src="/s.jpg"></div>`).image, 'https://shop.test/m.jpg');
  assert.equal(extract(`<div><a href="/x">Tee</a><img class="wishlist-icon" src="/heart.svg"><img src="/photo.jpg"></div>`).image, 'https://shop.test/photo.jpg');
  assert.equal(extract(`<div><a href="/x">Tee</a><picture><source srcset="/a.webp 1x, /a@2x.webp 2x"><img src="${PX}"></picture></div>`).image, 'https://shop.test/a@2x.webp');
  assert.equal(extract(`<div><a href="/x">Tee</a><div style="background-image:url('/bg.jpg')"></div></div>`).image, 'https://shop.test/bg.jpg');
});

test('srcset parsing handles commas inside URLs', () => {
  const list = parseSrcset('https://cdn/x/w_300,h_200/a.jpg 300w, https://cdn/x/w_600,h_400/a.jpg 600w');
  assert.equal(list.length, 2);
  assert.equal(list[1].url, 'https://cdn/x/w_600,h_400/a.jpg');
  assert.equal(pickFromSrcset('a.jpg 100w, b.jpg 900w, c.jpg 450w'), 'c.jpg');
});

test('delivery / availability text and details', () => {
  const it = extract(`<li><a href="/x"><h2>Lamp</h2></a><p>Free delivery tomorrow</p><p>In stock</p><p>Brand: Lumio</p><button>Add to cart</button></li>`);
  assert.equal(it.delivery, 'Free delivery tomorrow · In stock');
  assert.deepEqual(it.details, ['Brand: Lumio']);
});

test('truncated titles are expanded from title/alt attributes; trailing price removed', () => {
  assert.equal(extract(`<article><h3><a href="/x" title="A Light in the Attic">A Light in the ...</a></h3></article>`).title, 'A Light in the Attic');
  assert.equal(extract(`<div><a href="/x" aria-label="Trainers in black, Price £185.00"><img src="/i.jpg"></a></div>`).title, 'Trainers in black');
  assert.equal(extract(`<div><a href="/x">Gift card €50</a></div>`).title, 'Gift card €50');
});

test('cart / wishlist links are not chosen as the item link', () => {
  const it = extract(`<div><a href="/cart/add?id=1">Add</a><a href="/p/9"><h3>Real</h3></a></div>`);
  assert.equal(it.url, 'https://shop.test/p/9');
});

test('item that is itself a link', () => {
  const it = extract(`<a href="/p/5"><img src="/5.jpg"><span>Boots</span><span>€ 80</span></a>`);
  assert.equal(it.url, 'https://shop.test/p/5');
  assert.equal(it.title, 'Boots');
  assert.equal(it.price, '€ 80');
});

test('ids ignore tracking and per-visit query strings', () => {
  assert.equal(normalizeUrl('https://www.ebay.com/itm/407?hash=abc&itmmeta=zzz'), 'https://www.ebay.com/itm/407');
  assert.equal(normalizeUrl('https://x.y/p/shoe/?utm_source=a#reviews'), 'https://x.y/p/shoe');
  assert.equal(normalizeUrl('https://x.y/product.php?id=5&utm_source=a&PHPSESSID=1'), 'https://x.y/product.php?id=5');
  assert.equal(normalizeUrl('https://x.y/?p=12'), 'https://x.y/?p=12');
});

test('parseAmount', () => {
  assert.equal(parseAmount('€ 1.299,50'), 1299.5);
  assert.equal(parseAmount('$1,299.00'), 1299);
  assert.equal(parseAmount('12,95'), 12.95);
  assert.equal(parseAmount('€45'), 45);
});

test('items with nothing usable yield null', () => {
  assert.equal(extract(`<div><span> </span></div>`), null);
});

test('a sentence split by styling stays ONE chip, including the link at the end, without the abbreviation badge', () => {
  const it = extract(`<div class="card"><a href="/p/1"><h3>Some Game</h3></a><span class="price">€ 10,00</span>
    <div class="meta text-muted">Am <strong>Sa, 17.10.</strong> um
      <strong>05:36</strong><br>bei<div class="abbr so">SO</div> <a href="/shop/so">Spiele-Offensive</a></div></div>`);
  assert.deepEqual(it.details, ['Am Sa, 17.10. um 05:36 bei Spiele-Offensive']);
});

test('abbreviation badges are dropped only when they abbreviate the word that follows', () => {
  const sentence = (badge, name) => extract(`<div><a href="/p"><h3>Game</h3></a><div>Bought at <span>${badge}</span> <a href="/s">${name}</a></div></div>`).details[0];
  assert.equal(sentence('FW', 'FantasyWelt'), 'Bought at FantasyWelt');
  assert.equal(sentence('Amz', 'Amazon'), 'Bought at Amazon');
  assert.equal(sentence('SPF', 'Spielefürst'), 'Bought at Spielefürst');
  assert.equal(sentence('New', 'Nike Women'), 'Bought at New Nike Women', 'an unrelated word is kept');
  assert.equal(sentence('Sale', 'Summer Lounge'), 'Bought at Sale Summer Lounge');
});

test('a sentence that contains a price inline is dropped as a whole (the price has its own field)', () => {
  const it = extract(`<div><a href="/p"><h3>Game</h3></a><b>€ 20,00</b>
    <div class="line"><strong>€ 17,90</strong> am <strong>20.09.</strong> bei <a href="/s">Shop</a></div></div>`);
  assert.equal(it.price, '€ 20,00');
  assert.deepEqual(it.details, []);
});

test('layout wrappers are not merged into one chip; list entries stay separate', () => {
  let it = extract(`<div><a href="/p"><h3>Game</h3></a><div>Free gift <div class="price">€ 5</div><div>Brand X</div></div></div>`);
  assert.deepEqual(it.details, ['Free gift', 'Brand X']);
  it = extract(`<div><a href="/p"><h3>Game</h3></a><ul><li>Waterproof</li><li>Breathable</li></ul></div>`);
  assert.deepEqual(it.details, ['Waterproof', 'Breathable']);
  it = extract(`<div><a href="/p"><h3>Game</h3></a><span class="badge">Top seller</span><span class="badge">Limited</span></div>`);
  assert.deepEqual(it.details, ['Top seller', 'Limited']);
});

test('buttons, call-to-action links and price labels are not chips', () => {
  const it = extract(`<div><a href="/p"><h3>Game</h3></a><a class="btn btn-primary" href="/buy">Jetzt kaufen</a><a href="/p">Mehr →</a>
    <div class="label">Vorheriger Bestpreis</div><span>In 2 Farben</span></div>`);
  assert.deepEqual(it.details, ['In 2 Farben']);
  // ...but a promo badge that merely contains the word "price" is kept
  assert.deepEqual(extract(`<div><a href="/p"><h3>Sofa</h3></a><div>New Lower Price</div></div>`).details, ['New Lower Price']);
});

test('delivery keywords must start a word: shop names containing "versand" are not delivery info', () => {
  const delivery = (txt) => extract(`<div><a href="/p"><h3>Game</h3></a><p>${txt}</p></div>`).delivery;
  assert.equal(delivery('Brettspielversand'), null);
  assert.equal(delivery('Kostenloser Versand'), 'Kostenloser Versand');
  assert.equal(delivery('Gratisversand'), 'Gratisversand');
  assert.equal(delivery('Free delivery tomorrow'), 'Free delivery tomorrow');
});

test('delivery hidden in a tooltip of an empty element (availability dot) is found', () => {
  const it = extract(`<div class="card"><a href="/produkte/1-racket-dice"><img alt="Racket Dice (EN)" src="/a.jpg"><div class="card-title">Racket Dice (EN)</div>
    <div class="card-subtitle text-muted">GMT Games</div>
    <div class="d-flex"><div class="fw-bold">45,95 €</div>
    <i title="VORAUSSICHTLICH lieferbar ab Januar 2027" class="game-availability-dot bi bi-circle-fill ms-2 text-warning"></i></div></a></div>`);
  assert.equal(it.delivery, 'VORAUSSICHTLICH lieferbar ab Januar 2027');
  assert.deepEqual(it.details, ['GMT Games']);
  assert.equal(it.price, '45,95 €');
});

test('tooltips are read from any element and from aria-label / alt, next to visible delivery text', () => {
  const delivery = (inner) => extract(`<div><a href="/p"><h3>Game</h3></a>${inner}</div>`).delivery;
  assert.equal(delivery('<span class="dot" aria-label="Auf Lager"></span>'), 'Auf Lager');
  assert.equal(delivery('<img src="/i/truck.png" alt="Lieferung in 2-3 Werktagen">'), 'Lieferung in 2-3 Werktagen');
  assert.equal(delivery('<span data-bs-original-title="Ships from May 5" class="x"></span>'), 'Ships from May 5');
  assert.equal(delivery('<p>Free delivery</p><i title="Erscheint am 15.03.2027"></i>'), 'Free delivery · Erscheint am 15.03.2027');
});

test('tooltips with a discount, a price remark or a date become chips; other text-less tooltips need two words', () => {
  const details = (inner) => extract(`<div><a href="/p"><h3>Game</h3></a>${inner}</div>`).details;
  assert.deepEqual(details('<span class="badge" title="-20% Rabatt"></span>'), ['-20% Rabatt']);
  assert.deepEqual(details('<i title="UVP war 39,99 €"></i>'), ['UVP war 39,99 €']);
  assert.deepEqual(details('<span class="icon" title="Neuheit im März"></span>'), ['Neuheit im März']);
  assert.deepEqual(details('<i title="Spiel des Jahres Gewinner"></i>'), ['Spiel des Jahres Gewinner']);
  assert.deepEqual(details('<i title="Neu"></i>'), [], 'a single word says too little');
});

test('tooltips that only repeat or operate the page are ignored', () => {
  const it = extract(`<div><a href="/p" title="Game ansehen"><img src="/a.jpg" alt="Game"><h3 title="Game">Game</h3></a>
    <button title="Zur Wunschliste hinzufügen" class="wish"><i title="Merkzettel öffnen"></i></button>
    <span title="Vergleichen der Produkte"></span><span class="price" title="12,95 €">12,95 €</span>
    <span title="Brand X">Brand X</span><i title="Bild vergrößern bitte"></i><span title="Zum Produkt">Mehr zum Produkt Game</span></div>`);
  assert.deepEqual(it.details, ['Brand X', 'Mehr zum Produkt Game']);
  assert.equal(it.delivery, null);
});

test('a tooltip on an element with visible text only counts when it carries delivery, price or date information', () => {
  const it = extract(`<div><a href="/p"><h3>Game</h3></a><span title="Das ist ein Spiel für Kinder">Kids</span><span title="Lieferbar ab 3. Mai">Bald</span></div>`);
  assert.equal(it.delivery, 'Lieferbar ab 3. Mai');
  assert.deepEqual(it.details, ['Kids', 'Bald']);
});

test('schema.org availability microdata is read', () => {
  const it = extract(`<div><a href="/p"><h3>Game</h3></a><meta itemprop="availability" content="https://schema.org/PreOrder"></div>`);
  assert.equal(it.delivery, 'Pre-order');
});

test('a bare discount badge is a chip, bare numbers are still noise', () => {
  const it = extract(`<div><a href="/p"><h3>Game</h3></a><span class="b">-20%</span><span>12</span><span>★★★★☆</span></div>`);
  assert.deepEqual(it.details, ['-20%']);
});

test('more availability wording is recognised as delivery information', () => {
  const delivery = (txt) => extract(`<div><a href="/p"><h3>Game</h3></a><p>${txt}</p></div>`).delivery;
  for (const txt of ['Nicht lieferbar', 'Voraussichtlich ab Mai', 'Ausverkauft', 'Vorbestellung möglich', 'Binnenkort leverbaar', 'Coming soon', 'Not available', 'Available from May']) {
    assert.equal(delivery(txt), txt, txt);
  }
  assert.equal(delivery('Available in 3 colours'), null, 'availability of options is not delivery');
});
