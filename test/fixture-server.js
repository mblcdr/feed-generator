'use strict';
// A tiny fake online store used by the tests:
//   /            JS-rendered product grid (async fetch after a delay, lazy images, split prices, decoys)
//   /hard        plain list without prices/images: automatic detection should ask the user for help
//   /paged       server-rendered list, 6 items per page, 20 items; ?page=N, /paged/page/N/ and ?start=OFFSET all work.
//                /paged-loop answers page numbers beyond the end with the last page again, /paged-empty with an empty page
//   /__add-paged?n=3  -> new items appear at the *front* of the paged list
//   /api/products, POST /__add?n=3  -> adds new products to the shop
//   /img/<id>.svg                   -> tiny generated images

const http = require('node:http');

const NAMES = ['Aero Runner', 'Trail Blazer', 'City Walker', 'Cloud Stepper', 'Dune Racer', 'Echo Court', 'Flux Trainer', 'Gale Force', 'Harbor Slip', 'Ion Sprint', 'Jet Lite', 'Kite Low', 'Lunar High', 'Mesa Hiker', 'Nova Skate'];

function createShop() {
  const products = [];
  const add = () => {
    const n = products.length + 1;
    products.push({
      id: n,
      name: `${NAMES[(n - 1) % NAMES.length]} ${n}`,
      price: (50 + n * 3.5).toFixed(2).replace('.', ','),
      old: n % 3 === 0 ? (80 + n * 3.5).toFixed(2).replace('.', ',') : null,
      delivery: n % 2 ? 'Free delivery tomorrow' : 'Delivered in 3-5 days',
      brand: ['Acme', 'Globex', 'Initech'][n % 3],
    });
  };
  for (let i = 0; i < 12; i++) add();
  return { products, add };
}

const PAGE_SIZE = 6;

function createPagedShop() {
  const items = [];
  let next = 1;
  const add = (n = 1) => {
    for (let i = 0; i < n; i++, next++) items.unshift({ id: next, name: `Paged Item ${next}`, price: (10 + next * 2).toFixed(2).replace('.', ',') });
  };
  add(20);
  return { items, add, pages: () => Math.ceil(items.length / PAGE_SIZE) };
}

function renderPaged(paged, from, title) {
  const cards = paged.items.slice(from, from + PAGE_SIZE).map((p) => `<article class="product-card"><a class="product-link" href="/p/${p.id}"><div class="img-wrap"><img src="/img/${p.id}.svg" alt="${p.name}"></div><h3 class="product-title">${p.name}</h3></a><div class="price-box"><span class="price"><span class="cur">€</span><span class="amt">${p.price}</span></span></div><p class="delivery">Free delivery tomorrow</p></article>`);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><header><nav><ul class="menu"><li><a href="/men">Men</a></li><li><a href="/women">Women</a></li><li><a href="/kids">Kids</a></li></ul></nav></header><main><h1>${title}</h1><div class="product-grid">${cards.join('')}</div></main></body></html>`;
}

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Shop</title></head><body>
<header><nav><ul class="menu"><li><a href="/men">Men</a></li><li><a href="/women">Women</a></li><li><a href="/kids">Kids</a></li><li><a href="/sale">Sale</a></li></ul></nav></header>
<main><h1>Sneakers</h1><div id="grid" class="product-grid"><p>Loading…</p></div></main>
<aside class="recs"><h2>You may also like</h2>
  <div class="rec-row">
    <div class="rec"><a href="/p/r1"><img src="/img/r1.svg" alt="Rec one"><span>Rec one</span></a><span class="price">€ 10,00</span></div>
    <div class="rec"><a href="/p/r2"><img src="/img/r2.svg" alt="Rec two"><span>Rec two</span></a><span class="price">€ 12,00</span></div>
    <div class="rec"><a href="/p/r3"><img src="/img/r3.svg" alt="Rec three"><span>Rec three</span></a><span class="price">€ 14,00</span></div>
  </div>
</aside>
<footer><ul class="foot"><li><a href="/about">About us</a></li><li><a href="/contact">Contact</a></li><li><a href="/privacy">Privacy</a></li></ul></footer>
<script>
  const PX = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const io = new IntersectionObserver((entries) => entries.forEach((e) => {
    if (e.isIntersecting) { e.target.src = e.target.dataset.src; io.unobserve(e.target); }
  }), { rootMargin: '0px' });
  setTimeout(async () => {
    const items = await (await fetch('/api/products')).json();
    const grid = document.getElementById('grid');
    grid.innerHTML = items.map((p, i) => '<article class="product-card' + (i === 0 ? ' first' : '') + (i % 2 ? ' is-odd' : '') + '">'
      + '<a class="product-link" href="/p/' + p.id + '?utm_source=feed"><div class="img-wrap"><img class="lazy" data-src="/img/' + p.id + '.svg" src="' + PX + '" alt="' + p.name + '"></div>'
      + '<h3 class="product-title">' + p.name + '</h3></a>'
      + '<div class="price-box">' + (p.old ? '<span class="old-price"><del>€ ' + p.old + '</del></span>' : '')
      + '<span class="price"><span class="cur">€</span><span class="amt">' + p.price + '</span></span></div>'
      + '<p class="delivery">' + p.delivery + '</p><p class="brand">' + p.brand + '</p><button>Add to cart</button></article>').join('');
    grid.querySelectorAll('img.lazy').forEach((img) => io.observe(img));
  }, 1200);
</script></body></html>`;

const HARD = `<!doctype html><html><head><title>Plain list</title></head><body>
<h1>Listings</h1>
<ul class="listing">${Array.from({ length: 8 }, (_, i) => `<li><a href="/x/${i + 1}">Plain item ${i + 1}</a> <span>${10 + i}</span></li>`).join('')}</ul>
<ul class="other"><li><a href="/a">Alpha</a></li><li><a href="/b">Beta</a></li></ul>
</body></html>`;

function svg(label) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="#8a85ff"/><text x="150" y="160" font-size="48" text-anchor="middle" fill="#fff">${label}</text></svg>`;
}

function start(port = 0) {
  const shop = createShop();
  const paged = createPagedShop();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html' }).end(PAGE);
    if (url.pathname === '/hard') return res.writeHead(200, { 'content-type': 'text/html' }).end(HARD);
    let pm = /^\/(paged|paged-loop|paged-empty)(?:\/page\/(\d+)\/?)?$/.exec(url.pathname);
    if (pm) {
      let page = Number(pm[2] || url.searchParams.get('page') || 1);
      if (url.searchParams.has('start')) page = Math.floor(Number(url.searchParams.get('start')) / PAGE_SIZE) + 1;
      if (pm[1] === 'paged-loop') page = Math.min(page, paged.pages());
      const from = (page - 1) * PAGE_SIZE;
      const body = pm[1] === 'paged-empty' && page > paged.pages() ? renderPaged({ items: [] }, 0, 'Paged shop') : renderPaged(paged, from, 'Paged shop');
      return res.writeHead(200, { 'content-type': 'text/html' }).end(body);
    }
    if (url.pathname === '/__add-paged') {
      paged.add(Number(url.searchParams.get('n') || 1));
      return res.writeHead(200).end('ok');
    }
    if (url.pathname === '/api/products') return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(shop.products.slice().reverse()));
    if (url.pathname === '/__add') {
      for (let i = 0; i < Number(url.searchParams.get('n') || 1); i++) shop.add();
      return res.writeHead(200).end('ok');
    }
    const m = /^\/img\/(\w+)\.svg$/.exec(url.pathname);
    if (m) return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(svg(m[1]));
    res.writeHead(404).end('nope');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({ server, shop, paged, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` })));
}

module.exports = { start };
