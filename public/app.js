(() => {
  'use strict';

  // ------------------------------------------------------------------ helpers

  const PAGE = 48; // items rendered per chunk in the feed list

  /** Tiny hyperscript helper. Text is always inserted as text nodes (feed content is untrusted). */
  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v; // static SVG strings only
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const $ = (sel, root = document) => root.querySelector(sel);

  const ICON = {
    menu: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h16"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4"/></svg>',
    wrench: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a4 4 0 0 0 5 5L11 20a2.1 2.1 0 0 1-3-3l8.7-8.7a4 4 0 0 0-2-2z"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>',
    image: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="m21 16-5-5-8 8"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 16.9 6.8 19.7l1-5.9L3.5 9.7l5.9-.8z"/></svg>',
    want: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h12v17L12 16.5l-6 4z"/><path d="M12 7.5v5M9.5 10h5"/></svg>',
    box: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8"/></svg>',
  };
  const icon = (name) => h('span', { html: ICON[name], style: 'display:inline-flex' });

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new Error('Could not reach the local server. Is it still running?');
    }
    let data = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON error body */
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  function timeAgo(iso) {
    if (!iso) return 'never';
    const sec = (Date.parse(iso) - Date.now()) / 1000;
    const abs = Math.abs(sec);
    if (abs < 45) return 'just now';
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    if (abs < 3600) return rtf.format(Math.round(sec / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(sec / 3600), 'hour');
    if (abs < 86400 * 30) return rtf.format(Math.round(sec / 86400), 'day');
    return new Date(iso).toLocaleDateString();
  }

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
  const isHttp = (u) => /^https?:\/\//i.test(u || '');

  function toast(message, kind) {
    const el = h('div', { class: 'toast' + (kind === 'error' ? ' error' : '') }, message);
    $('#toasts').append(el);
    setTimeout(() => el.remove(), kind === 'error' ? 7000 : 4000);
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise((resolve) => {
      const dlg = $('#dialog');
      const done = (v) => {
        dlg.close();
        resolve(v);
      };
      dlg.replaceChildren(
        h('h2', {}, title),
        h('p', {}, text),
        h(
          'div',
          { class: 'row' },
          h('button', { class: 'btn', type: 'button', onclick: () => done(false) }, 'Cancel'),
          h('button', { class: 'btn btn-danger solid', type: 'button', onclick: () => done(true) }, okLabel)
        )
      );
      dlg.addEventListener('cancel', () => resolve(false), { once: true });
      dlg.showModal();
    });
  }

  // ------------------------------------------------------------------ state

  const state = {
    feeds: [], // summaries, newest first
    cache: new Map(), // id -> full feed
    autoRefreshed: new Set(), // feeds already refreshed during this page session
    refreshing: new Set(),
    backfilling: new Set(), // refreshing feeds that page through the whole list (slow)
    route: null,
    filter: '',
    starredOnly: false,
    globalWanted: { phrases: [], count: 0 },
    globalIgnored: [],
    wantedData: null, // { phrases, items } of the global Wanted feed (loaded on demand)
    add: null,
    browserOk: true,
  };
  const WANTED = 'wanted'; // feedView id of the global Wanted feed
  let feedView = null; // mounted feed screen: { id, refs, rendered, observer }

  const appEl = $('#app');
  const mainEl = $('#main');

  async function loadFeeds() {
    const data = await api('GET', '/api/feeds');
    state.feeds = data.feeds;
    state.globalWanted = { phrases: data.wanted.phrases, count: data.wanted.count };
    state.globalIgnored = data.ignored.phrases;
  }

  // ------------------------------------------------------------------ routing

  function parseRoute() {
    const m = /^#\/(feed|fix|edit)\/([a-f0-9]+)$/.exec(location.hash);
    if (m) return { name: m[1], id: m[2] };
    if (location.hash === '#/add') return { name: 'add' };
    if (location.hash === '#/wanted') return { name: 'wanted' };
    if (location.hash === '#/settings') return { name: 'settings' };
    return { name: 'home' };
  }

  function go(hash) {
    if (location.hash === hash) render();
    else location.hash = hash;
  }

  function render() {
    let route = parseRoute();
    const known = (id) => state.feeds.some((f) => f.id === id);
    if (route.name === 'home' || (route.name === 'wanted' && !state.feeds.length) || ((route.name === 'feed' || route.name === 'fix' || route.name === 'edit') && !known(route.id))) {
      route = state.feeds.length ? { name: 'feed', id: state.feeds[0].id } : { name: 'home' };
      history.replaceState(null, '', route.name === 'feed' ? '#/feed/' + route.id : '#/');
    }
    state.route = route;
    appEl.classList.remove('nav-open');
    renderSidebar();
    if (route.name !== 'feed' && route.name !== 'wanted') teardownFeedView();
    if (route.name === 'feed') showFeed(route.id);
    else if (route.name === 'wanted') showWanted();
    else if (route.name === 'fix') showAdd(route.id);
    else if (route.name === 'edit') showEdit(route.id);
    else if (route.name === 'settings') showSettings();
    else if (route.name === 'add') showAdd(null);
    else showEmpty();
    window.scrollTo(0, 0);
  }

  // ------------------------------------------------------------------ sidebar

  function renderSidebar() {
    const list = $('#feed-list');
    const onWanted = state.route && state.route.name === 'wanted';
    const gw = state.globalWanted;
    if (!state.feeds.length) return list.replaceChildren();
    list.replaceChildren(
      h(
        'a',
        { class: 'feed-link wanted-link' + (onWanted ? ' selected' : ''), href: '#/wanted', 'aria-current': onWanted ? 'page' : null },
        h('div', { class: 'feed-name' }, h('span', { html: ICON.star, class: 'star-ico' }), h('span', {}, 'Wanted'), gw.count > 0 && h('span', { class: 'pill' }, String(gw.count))),
        h('div', { class: 'feed-host' }, 'Matches from all feeds'),
        h('div', { class: 'feed-meta' }, plural(gw.phrases.length, 'global phrase'))
      ),
      ...state.feeds.map((f) => {
        const selected = state.route && ['feed', 'fix', 'edit'].includes(state.route.name) && state.route.id === f.id;
        const failed = f.lastFetch && f.lastFetch.ok === false;
        return h(
          'a',
          { class: 'feed-link' + (selected ? ' selected' : ''), href: '#/feed/' + f.id, 'aria-current': selected ? 'page' : null },
          h('div', { class: 'feed-name' }, h('span', {}, f.name), f.newCount > 0 && h('span', { class: 'pill' }, `${f.newCount} new`)),
          h('div', { class: 'feed-host' }, f.host),
          h(
            'div',
            { class: 'feed-meta' },
            state.refreshing.has(f.id) ? [h('span', { class: 'spinner' }), 'Updating…'] : [`${plural(f.itemCount, 'item')} · ${failed ? 'update failed' : timeAgo(f.updatedAt)}`]
          )
        );
      })
    );
  }

  $('#btn-add').addEventListener('click', () => go('#/add'));
  $('#btn-settings').addEventListener('click', () => go('#/settings'));
  $('#scrim').addEventListener('click', () => appEl.classList.remove('nav-open'));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') appEl.classList.remove('nav-open');
  });

  function topbar() {
    return h(
      'div',
      { class: 'topbar' },
      h('button', { class: 'btn btn-ghost icon-btn', type: 'button', 'aria-label': 'Show feeds', onclick: () => appEl.classList.add('nav-open') }, icon('menu')),
      h('div', { class: 'brand' }, h('span', { class: 'logo' }), h('span', {}, 'Feeds'))
    );
  }

  // ------------------------------------------------------------------ item cards

  function imageSrc(url, feed) {
    if (!url) return null;
    if (url.startsWith('data:')) return url;
    return '/img?u=' + encodeURIComponent(url) + '&r=' + encodeURIComponent((feed && (feed.finalUrl || feed.url)) || '');
  }

  function thumb(url, feed) {
    const box = h('div', { class: 'thumb' + (url ? '' : ' noimg') }, h('span', { html: ICON.image, style: 'display:contents' }));
    if (url) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer', src: imageSrc(url, feed) });
      let stage = 0;
      img.addEventListener('error', () => {
        // 1st failure: the local proxy/cache couldn't get it - try the original address directly.
        if (stage === 0 && isHttp(url)) {
          stage = 1;
          img.src = url;
        } else box.classList.add('noimg');
      });
      box.prepend(img);
    }
    return box;
  }

  /** Keep every in-memory copy of an item (feed cache + Wanted list + the card's own object) in sync. */
  function setStarLocal(feedId, it, value) {
    it.starred = value;
    const feed = state.cache.get(feedId);
    const orig = feed && feed.items.find((i) => i.id === it.id);
    if (orig) orig.starred = value;
    if (state.wantedData) for (const w of state.wantedData.items) if (w.feedId === feedId && w.id === it.id) w.starred = value;
  }

  function starButton(it, feedId) {
    const btn = h('button', { class: 'star-btn', type: 'button', html: ICON.star });
    const paint = () => {
      btn.classList.toggle('on', !!it.starred);
      btn.setAttribute('aria-pressed', String(!!it.starred));
      const label = it.starred ? 'Remove star' : 'Star this item';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      const card = btn.closest('.item');
      if (card) card.classList.toggle('starred', !!it.starred);
    };
    paint();
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const next = !it.starred;
      setStarLocal(feedId, it, next);
      paint();
      if (feedView) paintStarFilter();
      try {
        await api('POST', `/api/feeds/${feedId}/star`, { itemId: it.id, starred: next });
      } catch (err) {
        setStarLocal(feedId, it, !next);
        paint();
        if (feedView) paintStarFilter();
        toast(`Couldn't save the star: ${err.message}`, 'error');
      }
    });
    return btn;
  }

  /** ctx: { feedId, ref (feed-like object for the image referer), isNew, showFeed } */
  function itemCard(it, ctx) {
    const linked = isHttp(it.url);
    const main = h(
      linked ? 'a' : 'div',
      linked ? { class: 'item-main', href: it.url, target: '_blank', rel: 'noopener noreferrer' } : { class: 'item-main' },
      thumb(it.image, ctx.ref),
      h(
        'div',
        { class: 'info' },
        it.matchedBy && h('div', { class: 'match-tag' }, `Wanted · ${it.matchedBy}`),
        h('div', { class: 'title' }, it.title || it.url || 'Untitled'),
        (it.price || it.oldPrice) &&
          h('div', { class: 'price-row' }, it.price && h('span', { class: 'price' + (it.oldPrice ? ' on-sale' : '') }, it.price), it.oldPrice && h('s', { class: 'old-price' }, it.oldPrice)),
        it.delivery && h('div', { class: 'delivery' }, icon('box'), h('span', {}, it.delivery)),
        it.details && it.details.length > 0 && h('ul', { class: 'chips' }, it.details.map((d) => h('li', { title: d }, d))),
        ctx.showFeed && it.feedName && h('div', { class: 'feed-tag' }, `from ${it.feedName}`)
      )
    );
    const want = h('button', { class: 'want-btn', type: 'button', title: 'Add to wanted list', 'aria-label': 'Add to wanted list', html: ICON.want });
    want.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openWantDialog(it, ctx);
    });
    return h('div', { class: 'item' + (it.starred ? ' starred' : '') }, main, ctx.isNew && h('span', { class: 'pill badge-new' }, 'New'), want, starButton(it, ctx.feedId));
  }

  // ------------------------------------------------------------------ feed screen (also used for the global Wanted feed)

  function teardownFeedView() {
    if (feedView && feedView.observer) feedView.observer.disconnect();
    feedView = null;
    if (panelDialog.open) panelDialog.close();
  }

  function mountFeedView(id) {
    teardownFeedView();
    state.filter = '';
    const isW = id === WANTED;
    const refs = {};
    refs.title = h('h1', {});
    refs.sub = h('div', { class: 'sub' });
    refs.btnUpdate = h('button', { class: 'btn btn-primary', type: 'button', title: 'Fetch the page again and add new items', 'aria-label': 'Update feed', onclick: () => refresh(id) });
    refs.status = h('span', { class: 'status' });
    refs.search = h('input', { type: 'text', placeholder: 'Filter items…', 'aria-label': 'Filter items', autocomplete: 'off' });
    refs.starBtn = h('button', { class: 'btn btn-sm toggle', type: 'button', title: 'Show only starred items' });
    refs.panel = h('div', { class: 'config-row' });
    refs.items = h('div', { class: 'items' });
    refs.after = h('div', {});
    refs.sentinel = h('div', { class: 'sentinel' });

    let t;
    refs.search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        state.filter = refs.search.value;
        renderItems();
      }, 150);
    });
    refs.starBtn.addEventListener('click', () => {
      state.starredOnly = !state.starredOnly;
      paintStarFilter();
      renderItems();
    });

    const head = h(
      'div',
      { class: 'feed-head' },
      h(
        'div',
        { class: 'feed-title-row' },
        h('div', { class: 'feed-title' }, refs.title, refs.sub),
        !isW &&
          h(
            'div',
            { class: 'feed-actions' },
            refs.btnUpdate,
            h('button', { class: 'btn', type: 'button', title: 'Change the name, web address, number of items or paging', 'aria-label': 'Edit feed', onclick: () => go('#/edit/' + id) }, icon('pencil'), h('span', { class: 'lbl' }, 'Edit')),
            h('button', { class: 'btn', type: 'button', title: 'Re-select which elements are the items', 'aria-label': 'Fix pattern', onclick: () => go('#/fix/' + id) }, icon('wrench'), h('span', { class: 'lbl' }, 'Fix pattern')),
            h('button', { class: 'btn btn-danger', type: 'button', title: 'Delete this feed', 'aria-label': 'Delete feed', onclick: () => deleteFeed(id) }, icon('trash'), h('span', { class: 'lbl' }, 'Delete'))
          )
      ),
      h('div', { class: 'feed-tools' }, h('div', { class: 'search' }, refs.search), refs.starBtn, refs.status)
    );

    mainEl.replaceChildren(topbar(), head, refs.panel, refs.items, refs.after, refs.sentinel);
    const view = { id, refs, rendered: 0, rows: [], observer: null, openPanel: null, hidden: 0 };
    view.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) appendMore();
      },
      { rootMargin: '700px' }
    );
    view.observer.observe(refs.sentinel);
    feedView = view;
  }

  const skeletons = () => Array.from({ length: 6 }, () => h('div', { class: 'skeleton' }));

  async function showFeed(id) {
    if (!feedView || feedView.id !== id) mountFeedView(id);
    const view = feedView;
    if (state.cache.has(id)) {
      updateFeedView();
    } else {
      view.refs.items.replaceChildren(...skeletons());
      updateHeader();
      try {
        const { feed } = await api('GET', '/api/feeds/' + id);
        state.cache.set(id, feed);
      } catch (e) {
        if (feedView !== view) return;
        view.refs.items.replaceChildren();
        view.refs.after.replaceChildren(h('div', { class: 'banner error' }, e.message));
        return;
      }
      if (feedView !== view) return;
      updateFeedView();
    }
    if (!state.autoRefreshed.has(id)) {
      state.autoRefreshed.add(id);
      refresh(id, { auto: true });
    }
  }

  async function loadWanted() {
    state.wantedData = await api('GET', '/api/wanted');
    state.globalWanted.phrases = state.wantedData.phrases;
  }

  async function showWanted() {
    if (!feedView || feedView.id !== WANTED) mountFeedView(WANTED);
    const view = feedView;
    if (state.wantedData) updateFeedView();
    else {
      view.refs.items.replaceChildren(...skeletons());
      updateHeader();
    }
    try {
      await loadWanted();
    } catch (e) {
      if (feedView !== view) return;
      view.refs.items.replaceChildren();
      view.refs.after.replaceChildren(h('div', { class: 'banner error' }, e.message));
      return;
    }
    if (feedView === view) updateFeedView();
  }

  function starredCount(view) {
    if (view.id === WANTED) return state.wantedData ? state.wantedData.items.filter((i) => i.starred).length : 0;
    const feed = state.cache.get(view.id);
    return feed ? visibleItemsOf(feed).filter((i) => i.starred).length : 0;
  }

  /** Compiled ignore rules for a feed: the global ones plus its own. */
  const ignoreRulesFor = (feed) => Fuzzy.compileRules([...state.globalIgnored, ...((feed && feed.ignored) || [])]);

  /** Hidden by an ignore rule, the feed's minimum discount or its delivery filter (same rule as the server's). */
  const isHidden = (it, rules, feed) =>
    (rules.length > 0 && Fuzzy.matchesRules(it, rules)) || Discount.belowDiscount(it, feed.minDiscount) || Delivery.belowDelivery(it, feed.deliveryFilter);

  function visibleItemsOf(feed) {
    const rules = ignoreRulesFor(feed);
    return rules.length || feed.minDiscount || feed.deliveryFilter ? feed.items.filter((i) => !isHidden(i, rules, feed)) : feed.items;
  }

  function paintStarFilter() {
    const view = feedView;
    if (!view) return;
    const n = starredCount(view);
    const b = view.refs.starBtn;
    b.classList.toggle('active', state.starredOnly);
    b.setAttribute('aria-pressed', String(state.starredOnly));
    b.replaceChildren(h('span', { html: ICON.star, class: 'star-ico' }), h('span', {}, n ? `Starred · ${n}` : 'Starred'));
  }

  function updateHeader() {
    if (!feedView) return;
    const { id, refs } = feedView;
    if (id === WANTED) {
      refs.title.textContent = 'Wanted';
      const n = state.wantedData ? state.wantedData.items.length : state.globalWanted.count;
      refs.sub.replaceChildren(h('span', {}, `${plural(n, 'matching item')} across all feeds`));
      refs.status.replaceChildren();
      paintStarFilter();
      return;
    }
    const feed = state.cache.get(id);
    const sum = state.feeds.find((f) => f.id === id);
    if (!sum) return;
    const busy = state.refreshing.has(id);
    refs.title.textContent = sum.name;
    const shown = feed ? visibleItemsOf(feed).length : sum.itemCount - (sum.hiddenCount || 0);
    const hidden = feed ? feed.items.length - shown : sum.hiddenCount || 0;
    refs.sub.replaceChildren(
      h('a', { href: sum.url, target: '_blank', rel: 'noopener noreferrer', title: sum.url }, sum.host),
      h('span', { 'aria-hidden': 'true' }, '·'),
      h('span', {}, `${plural(shown, 'item')}${hidden ? ` (${hidden} hidden)` : ''} · Updated ${timeAgo(feed ? feed.updatedAt : sum.updatedAt)}`)
    );
    refs.btnUpdate.disabled = busy;
    refs.btnUpdate.replaceChildren(busy ? h('span', { class: 'spinner' }) : icon('refresh'), h('span', { class: 'lbl' }, busy ? 'Updating…' : 'Update'));
    const lf = (feed && feed.lastFetch) || sum.lastFetch;
    refs.status.className = 'status';
    if (busy) refs.status.replaceChildren(h('span', { class: 'spinner' }), state.backfilling.has(id) ? 'Loading more pages… this can take a while' : 'Checking for new items…');
    else if (lf && lf.ok === false) {
      refs.status.classList.add('err');
      refs.status.replaceChildren(`Last update failed: ${lf.error}`);
    } else if (lf && lf.warning) {
      refs.status.classList.add('warn');
      refs.status.replaceChildren(lf.warning);
    } else refs.status.replaceChildren();
    paintStarFilter();
  }

  const searchText = (it) => [it.title, it.price, it.delivery, it.feedName, ...(it.details || [])].join(' ').toLowerCase();

  /** Rows to render: section headers and items, honouring the text filter and the starred filter. */
  function buildModel(view) {
    const q = state.filter.trim().toLowerCase();
    const pass = (it) => (!state.starredOnly || it.starred) && (!q || searchText(it).includes(q));

    if (view.id === WANTED) {
      if (!state.wantedData) return null;
      const all = state.wantedData.items;
      const rows = all
        .filter(pass)
        .map((it) => ({ it, ctx: { feedId: it.feedId, ref: { finalUrl: it.feedUrl }, isNew: it.isNew, showFeed: true } }));
      return { rows, itemCount: rows.length, baseCount: all.length };
    }

    const feed = state.cache.get(view.id);
    if (!feed) return null;
    const matcher = Fuzzy.compile([...state.globalWanted.phrases, ...(feed.wanted || [])]);
    const ignore = ignoreRulesFor(feed);
    const wanted = [];
    const regular = [];
    let hidden = 0;
    for (const it of feed.items) {
      if (isHidden(it, ignore, feed)) {
        hidden++;
        continue;
      }
      if (!pass(it)) continue;
      const matchedBy = Fuzzy.match(it, matcher);
      if (matchedBy) wanted.push({ ...it, matchedBy });
      else regular.push(it);
    }
    const ctx = (it) => ({ feedId: feed.id, ref: feed, isNew: feed.fetchCount > 1 && it.seq === feed.fetchCount, showFeed: false });
    const rows = [];
    if (wanted.length) {
      rows.push({ header: 'Wanted', count: wanted.length });
      for (const it of wanted) rows.push({ it, ctx: ctx(it) });
      if (regular.length) rows.push({ header: 'Everything else', count: regular.length });
    }
    for (const it of regular) rows.push({ it, ctx: ctx(it) });
    return { rows, itemCount: wanted.length + regular.length, baseCount: feed.items.length - hidden, hidden };
  }

  const KIND = {
    wanted: {
      placeholder: 'e.g. nike air max 90',
      label: 'Wanted',
      title: (isW) => (isW ? 'Wanted phrases · all feeds' : 'Wanted in this feed'),
      hint: (isW) => (isW ? 'Items from any feed that match one of these phrases are collected in the Wanted feed and shown first in their own feed. Matching is fuzzy: typos, plurals and partial words still match, e.g. “airmax” finds “Air Max”.' : 'Items in this feed matching these phrases are shown first, in a Wanted section. They also appear in the global Wanted feed.'),
    },
    ignored: {
      placeholder: 'phrase or /regex/i',
      label: 'Ignored',
      title: (isW) => (isW ? 'Ignored · all feeds' : 'Ignored in this feed'),
      hint: (isW) => `Items matching a rule are hidden ${isW ? 'in every feed and from the Wanted feed' : 'from this feed and from the Wanted feed'}. A rule is a fuzzy phrase (typos and plurals match) or a regular expression between slashes, e.g. /refurbished|second hand/i. Ignoring wins over wanted. Hidden items stay stored.`,
    },
  };

  const globalList = (kind) => (kind === 'wanted' ? state.globalWanted.phrases : state.globalIgnored);
  const panelDialog = $('#panel-dialog');

  function closePanelDialog() {
    if (panelDialog.open) panelDialog.close();
  }
  panelDialog.addEventListener('close', () => {
    if (feedView) feedView.openPanel = null;
  });
  panelDialog.addEventListener('click', (e) => {
    if (e.target === panelDialog) closePanelDialog(); // click on the backdrop
  });

  /** Body of the Wanted / Ignored modal: explanation, current entries, add form. */
  function listBody(view, kind, hidden) {
    const isW = view.id === WANTED;
    const feed = isW ? null : state.cache.get(view.id);
    const cfg = KIND[kind];
    const global = globalList(kind);
    const own = isW ? global : feed[kind] || [];
    const globals = isW ? [] : global;

    const input = h('input', { type: 'text', placeholder: cfg.placeholder, maxlength: kind === 'ignored' ? '200' : '80', 'aria-label': `New ${kind} entry`, autocomplete: 'off', spellcheck: 'false' });
    const form = h(
      'form',
      {
        class: 'phrase-form',
        onsubmit: async (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (!v) return;
          if (await savePhrases(kind, [...own, v])) {
            const again = $('.phrase-form input', panelDialog);
            if (again) {
              again.value = '';
              again.focus();
            }
          }
        },
      },
      input,
      h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Add')
    );
    const chip = (p, removable) =>
      h('span', { class: 'phrase' + (removable ? '' : ' muted') + (p.startsWith('/') ? ' rx' : '') }, p, removable && h('button', { type: 'button', 'aria-label': `Remove ${p}`, onclick: () => savePhrases(kind, own.filter((x) => x !== p)) }, '×'));

    return h(
      'div',
      { class: 'panel-body' },
      h('p', { class: 'hint' }, cfg.hint(isW)),
      kind === 'ignored' && !isW && hidden > 0 && h('p', { class: 'hint' }, `${plural(hidden, 'item')} currently hidden in this feed.`),
      own.length > 0 ? h('div', { class: 'phrases' }, own.map((p) => chip(p, true))) : h('p', { class: 'hint' }, 'Nothing added yet.'),
      form,
      globals.length > 0 && h('div', { class: 'global-note' }, h('span', { class: 'hint' }, 'Global entries also apply here: '), h('span', { class: 'phrases inline' }, globals.map((p) => chip(p, false))), ' ', h('a', { href: '#/wanted', onclick: closePanelDialog }, 'Edit'))
    );
  }

  /** Body of the Feed settings modal. */
  function settingsBody(view, feed) {
    const sum = state.feeds.find((f) => f.id === view.id) || {};
    const ar = feed.autoRefresh || { enabled: false, interval: '' };

    const max = h('input', { id: 'set-max', type: 'number', min: '1', max: '100000', step: '1', placeholder: 'No limit', value: sum.maxItems == null ? '' : String(sum.maxItems), 'aria-label': 'Maximum items to keep' });
    const on = h('input', { type: 'checkbox', checked: ar.enabled || null, id: 'ar-on' });
    const interval = h('input', { type: 'text', placeholder: '5m', value: ar.interval || '', maxlength: '12', 'aria-label': 'Refresh interval', autocomplete: 'off', disabled: ar.enabled ? null : true });
    on.addEventListener('change', () => {
      interval.disabled = !on.checked;
      if (on.checked && !interval.value.trim()) interval.value = '30m';
    });
    const error = h('div', { class: 'banner error', hidden: true, role: 'alert' });
    const save = h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Save settings');
    const form = h(
      'form',
      {
        class: 'settings-form',
        onsubmit: async (e) => {
          e.preventDefault();
          error.hidden = true;
          const raw = max.value.trim();
          const body = { maxItems: raw === '' ? null : Number(raw), autoRefresh: { enabled: on.checked, interval: interval.value.trim() } };
          save.disabled = true;
          try {
            const { feed: updated } = await api('PUT', `/api/feeds/${view.id}/settings`, body);
            state.cache.set(view.id, updated);
            state.wantedData = null;
            await loadFeeds().catch(() => {});
            renderSidebar();
            closePanelDialog();
            toast('Feed settings saved');
            if (feedView === view) updateFeedView();
          } catch (err) {
            error.textContent = err.message;
            error.hidden = false;
            save.disabled = false;
          }
        },
      },
      error,
      h('div', { class: 'field' }, h('label', { for: 'set-max' }, 'Keep at most this many items'), max, h('div', { class: 'hint' }, 'When the limit is reached the oldest items are discarded (starred items are always kept). Leave empty for no limit.')),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'check', for: 'ar-on' }, on, 'Refresh automatically'),
        h('div', { class: 'interval-row' }, 'every', interval, h('span', { class: 'hint' }, 'e.g. 30m, 2h, 1d (minimum 1m)')),
        h('div', { class: 'hint' }, 'Runs in the background while this app is running, even when this page is closed.')
      ),
      h('div', {}, save)
    );
    return h('div', { class: 'panel-body' }, form);
  }

  /** Body of the minimum discount modal: items discounted less than the entered percentage are hidden. */
  function discountBody(view, feed) {
    const input = h('input', { id: 'set-discount', type: 'number', min: '1', max: '100', step: 'any', placeholder: 'e.g. 30', value: feed.minDiscount ? String(feed.minDiscount) : '', 'aria-label': 'Minimum discount in percent' });
    const error = h('div', { class: 'banner error', hidden: true, role: 'alert' });
    const known = feed.items.filter((i) => Discount.discountOf(i) != null).length;
    const save = async (value) => {
      error.hidden = true;
      try {
        const { feed: updated } = await api('PUT', `/api/feeds/${view.id}/settings`, { minDiscount: value });
        state.cache.set(view.id, updated);
        state.wantedData = null;
        await loadFeeds().catch(() => {});
        renderSidebar();
        closePanelDialog();
        toast(value ? `Showing items discounted ${value}% or more` : 'Discount filter removed');
        if (feedView === view) updateFeedView();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    };
    const form = h(
      'form',
      {
        class: 'settings-form',
        onsubmit: (e) => {
          e.preventDefault();
          const raw = input.value.trim();
          save(raw === '' ? null : Number(raw));
        },
      },
      error,
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'set-discount' }, 'Only show items discounted at least'),
        h('div', { class: 'interval-row' }, input, '%'),
        h('div', { class: 'hint' }, `A number from 1 to 100. Items without a recognized discount are hidden too (${known} of ${feed.items.length} items have one now). Hidden items stay stored; remove the filter to see them again.`)
      ),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Save filter'), feed.minDiscount && h('button', { class: 'btn btn-sm', type: 'button', onclick: () => save(null) }, 'Remove filter'))
    );
    return h('div', { class: 'panel-body' }, form);
  }

  /** Body of the delivery modal: show everything, only what is available now, or only what comes out within x months. */
  function deliveryBody(view, feed) {
    const cur = feed.deliveryFilter;
    const radio = (value, label, checked) => h('label', { class: 'radio-row' }, h('input', { type: 'radio', name: 'set-delivery', value, checked }), ' ', label);
    const all = radio('all', 'Show everything', !cur);
    const now = radio('now', 'Only items available right now', !!cur && cur.mode === 'now');
    const months = h('input', { id: 'set-delivery-months', type: 'number', min: '1', max: '120', step: '1', placeholder: 'e.g. 6', value: cur && cur.mode === 'months' ? String(cur.months) : '', 'aria-label': 'Number of months' });
    const within = h('label', { class: 'radio-row' }, h('input', { type: 'radio', name: 'set-delivery', value: 'months', checked: !!cur && cur.mode === 'months' }), ' Only items coming out within ', months, ' months');
    months.addEventListener('focus', () => (within.firstChild.checked = true));
    const error = h('div', { class: 'banner error', hidden: true, role: 'alert' });
    const known = feed.items.filter((i) => Delivery.hasUpcoming(i)).length;
    const save = async (value) => {
      error.hidden = true;
      try {
        const { feed: updated } = await api('PUT', `/api/feeds/${view.id}/settings`, { deliveryFilter: value });
        state.cache.set(view.id, updated);
        state.wantedData = null;
        await loadFeeds().catch(() => {});
        renderSidebar();
        closePanelDialog();
        toast(!value ? 'Delivery filter removed' : value.mode === 'now' ? 'Showing items available now' : `Showing items coming out within ${value.months} months`);
        if (feedView === view) updateFeedView();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
      }
    };
    const form = h(
      'form',
      {
        class: 'settings-form',
        onsubmit: (e) => {
          e.preventDefault();
          const mode = form.elements['set-delivery'].value;
          if (mode === 'all') return save(null);
          if (mode === 'now') return save({ mode: 'now' });
          const n = Number(months.value);
          if (!Number.isInteger(n) || n < 1) {
            error.textContent = 'Enter a whole number of months.';
            error.hidden = false;
            return;
          }
          save({ mode: 'months', months: n });
        },
      },
      error,
      h('div', { class: 'field' }, all, now, within, h('div', { class: 'hint' }, `Items without a recognized delivery date or availability are hidden when a filter is on (${known} of ${feed.items.length} items have an upcoming date now). Hidden items stay stored; choose "Show everything" to see them again.`)),
      h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Save filter'))
    );
    return h('div', { class: 'panel-body' }, form);
  }

  function panelTitle(view, kind) {
    if (kind === 'delivery') return 'Delivery';
    if (kind === 'discount') return 'Minimum discount';
    return kind === 'settings' ? 'Feed settings' : KIND[kind].title(view.id === WANTED);
  }

  /** Fill (or refresh) the open modal, keeping whatever the user is typing. */
  function renderPanelDialog(hidden) {
    const view = feedView;
    const kind = view.openPanel;
    const feed = view.id === WANTED ? null : state.cache.get(view.id);
    const typed = $('.phrase-form input', panelDialog);
    const keep = typed ? { value: typed.value, focused: document.activeElement === typed } : null;
    const body = kind === 'settings' ? settingsBody(view, feed) : kind === 'discount' ? discountBody(view, feed) : kind === 'delivery' ? deliveryBody(view, feed) : listBody(view, kind, hidden);
    panelDialog.replaceChildren(
      h('div', { class: 'modal-head' }, h('h2', {}, panelTitle(view, kind)), h('button', { class: 'btn btn-ghost icon-btn', type: 'button', 'aria-label': 'Close', onclick: closePanelDialog }, '✕')),
      body
    );
    const again = $('.phrase-form input', panelDialog);
    if (again && keep) {
      again.value = keep.value;
      if (keep.focused) again.focus();
    }
  }

  function openPanel(kind) {
    const view = feedView;
    if (!view) return;
    view.openPanel = kind;
    renderPanelDialog(view.hidden || 0);
    if (!panelDialog.open) panelDialog.showModal();
    const input = $('.phrase-form input', panelDialog) || $('#set-max', panelDialog) || $('#set-discount', panelDialog) || $('input[name="set-delivery"]:checked', panelDialog);
    if (input) input.focus();
  }

  /** The compact row of configuration chips under the filter box; each opens its settings modal. */
  function renderPanels(hidden) {
    const view = feedView;
    const isW = view.id === WANTED;
    const feed = isW ? null : state.cache.get(view.id);
    if (!isW && !feed) return view.refs.panel.replaceChildren();
    view.hidden = hidden;
    const own = (kind) => (isW ? globalList(kind) : feed[kind] || []);
    const chip = (kind, ...content) => h('button', { class: 'cfg-chip', type: 'button', 'aria-haspopup': 'dialog', title: `${panelTitle(view, kind)} — click to edit`, onclick: () => openPanel(kind) }, ...content);
    const count = (n) => h('span', { class: 'pill' }, String(n));

    const chips = [chip('wanted', 'Wanted', count(own('wanted').length)), chip('ignored', 'Ignored', count(own('ignored').length))];
    if (!isW) {
      const sum = state.feeds.find((f) => f.id === view.id) || {};
      const ar = feed.autoRefresh || {};
      const details = [ar.enabled ? `Auto ${ar.interval}` : null, sum.maxItems == null ? 'No limit' : `Max ${sum.maxItems}`].filter(Boolean).join(', ');
      // Only offered for feeds where a discount is recognized (or where a filter is already set, so it can be removed).
      if (feed.minDiscount || feed.items.some((i) => Discount.discountOf(i) != null)) {
        chips.push(chip('discount', 'Discount', h('span', { class: 'cfg-detail' }, feed.minDiscount ? `≥ ${feed.minDiscount}%` : 'any')));
      }
      // Only offered for feeds that show delivery dates in the future (or where a filter is already set).
      if (feed.deliveryFilter || feed.items.some((i) => Delivery.hasUpcoming(i))) {
        const f = feed.deliveryFilter;
        chips.push(chip('delivery', 'Delivery', h('span', { class: 'cfg-detail' }, !f ? 'any' : f.mode === 'now' ? 'available now' : `≤ ${f.months} mo`)));
      }
      chips.push(chip('settings', 'Feed settings', h('span', { class: 'cfg-detail' }, details)));
    }
    view.refs.panel.replaceChildren(...chips);
    if (view.openPanel && panelDialog.open) renderPanelDialog(hidden);
  }

  /** Save a wanted/ignored list of the current view (global in the Wanted view, otherwise the feed's own). */
  async function savePhrases(kind, list) {
    const view = feedView;
    if (!view) return false;
    const isW = view.id === WANTED;
    try {
      const r = await api('PUT', isW ? `/api/settings/${kind}` : `/api/feeds/${view.id}/${kind}`, { phrases: list });
      if (isW) {
        if (kind === 'wanted') state.globalWanted.phrases = r.phrases;
        else state.globalIgnored = r.phrases;
      } else {
        const feed = state.cache.get(view.id);
        if (feed) feed[kind] = r.phrases;
      }
      state.wantedData = null;
      if (isW) await loadWanted().catch(() => {});
      loadFeeds().then(() => {
        renderSidebar();
        if (feedView === view) updateHeader();
      }).catch(() => {});
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
    if (feedView === view) updateFeedView();
    return true;
  }

  async function ensureFeed(id) {
    if (!state.cache.has(id)) state.cache.set(id, (await api('GET', '/api/feeds/' + id)).feed);
    return state.cache.get(id);
  }

  /** Add a phrase to the global wanted list or to one feed's wanted list (from the item's + button). */
  async function addWanted(scope, feedId, phrase) {
    try {
      if (scope === 'global') {
        const r = await api('PUT', '/api/settings/wanted', { phrases: [...state.globalWanted.phrases, phrase] });
        state.globalWanted.phrases = r.phrases;
      } else {
        const feed = await ensureFeed(feedId);
        const r = await api('PUT', `/api/feeds/${feedId}/wanted`, { phrases: [...(feed.wanted || []), phrase] });
        feed.wanted = r.phrases;
      }
    } catch (e) {
      toast(e.message, 'error');
      return false;
    }
    state.wantedData = null;
    await loadFeeds().catch(() => {});
    renderSidebar();
    toast(`Added “${phrase}” to the ${scope === 'global' ? 'global' : 'feed'} wanted list`);
    if (feedView) {
      if (feedView.id === WANTED) await loadWanted().catch(() => {});
      updateFeedView();
    }
    return true;
  }

  function openWantDialog(it, ctx) {
    const dlg = $('#dialog');
    const feedName = it.feedName || (state.feeds.find((f) => f.id === ctx.feedId) || {}).name || 'this feed';
    const suggestion = String(it.title || '').replace(/[“”"]/g, '').split(/\s+/).filter(Boolean).slice(0, 4).join(' ').replace(/[,.;:]+$/, '');
    const input = h('input', { type: 'text', value: suggestion, maxlength: '80', 'aria-label': 'Wanted phrase', autocomplete: 'off', spellcheck: 'false' });
    const inFeedView = !(state.route && state.route.name === 'wanted');
    const radio = (value, label, checked) => h('label', { class: 'check' }, h('input', { type: 'radio', name: 'scope', value, checked: checked || null }), label);
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          const phrase = input.value.trim();
          if (!phrase) return;
          const scope = form.elements.scope.value;
          if (await addWanted(scope, ctx.feedId, phrase)) dlg.close();
        },
      },
      h('h2', {}, 'Add to wanted list'),
      h('p', {}, 'Items matching this phrase (fuzzy) are collected in the Wanted feed. Edit it to make it broader or narrower.'),
      h('div', { class: 'field' }, input),
      h('div', { class: 'field scope' }, radio('feed', `Only in “${feedName}”`, inFeedView), radio('global', 'In all feeds', !inFeedView)),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'), h('button', { class: 'btn btn-primary', type: 'submit' }, 'Add'))
    );
    dlg.replaceChildren(form);
    dlg.showModal();
    input.select();
  }

  function renderItems() {
    const view = feedView;
    if (!view) return;
    const model = buildModel(view);
    if (!model) return;
    view.rows = model.rows;
    view.rendered = 0;
    view.refs.items.replaceChildren();
    view.refs.after.replaceChildren();
    renderPanels(model.hidden || 0);
    if (!model.itemCount) {
      const isW = view.id === WANTED;
      const filtered = state.starredOnly || state.filter.trim();
      let msg;
      let action = null;
      if (model.baseCount && filtered) msg = state.starredOnly && !state.filter.trim() ? 'No starred items here yet. Tap the star on an item to keep it.' : 'No items match your filters.';
      else if (isW) msg = state.globalWanted.phrases.length || model.baseCount ? 'Nothing matches your wanted phrases yet. New matches from any feed show up here.' : 'Add a phrase above to collect matching items from all your feeds here.';
      else {
        msg = 'No items in this feed yet.';
        action = h('button', { class: 'btn', type: 'button', onclick: () => refresh(view.id) }, 'Update now');
      }
      view.refs.after.append(h('div', { class: 'empty' }, msg, action));
      return;
    }
    appendMore();
  }

  function appendMore() {
    const view = feedView;
    if (!view || view.rendered >= view.rows.length) return;
    let added = 0;
    while (view.rendered < view.rows.length && added < PAGE) {
      const row = view.rows[view.rendered++];
      if (row.header) view.refs.items.append(h('div', { class: 'section-head' }, h('h2', {}, row.header), h('span', { class: 'pill soft' }, row.count)));
      else {
        view.refs.items.append(itemCard(row.it, row.ctx));
        added++;
      }
    }
    // Re-arm the observer: if the sentinel is still in view it fires again and loads the next chunk.
    view.observer.unobserve(view.refs.sentinel);
    view.observer.observe(view.refs.sentinel);
  }

  function updateFeedView() {
    updateHeader();
    renderItems();
  }

  async function refresh(id, { auto = false, backfill = false } = {}) {
    if (state.refreshing.has(id)) return;
    state.refreshing.add(id);
    if (backfill) state.backfilling.add(id);
    renderSidebar();
    if (feedView && feedView.id === id) updateHeader();
    try {
      const { feed, added } = await api('POST', `/api/feeds/${id}/refresh`, backfill ? { backfill: true } : undefined);
      state.cache.set(id, feed);
      state.wantedData = null; // matches may have changed; reloaded when the Wanted feed is shown
      await loadFeeds();
      if (backfill) {
        const pages = (feed.lastFetch && feed.lastFetch.pages) || 1;
        toast(added > 0 ? `${plural(added, 'more item')} loaded from ${plural(pages, 'page')} in ${feed.name}` : `No more items found for ${feed.name}`);
      } else if (added > 0) {
        const matcher = Fuzzy.compile([...state.globalWanted.phrases, ...(feed.wanted || [])]);
        const ignore = ignoreRulesFor(feed);
        const fresh = feed.items.filter((i) => i.seq === feed.fetchCount && !Fuzzy.matchesRules(i, ignore));
        const wanted = fresh.filter((i) => Fuzzy.match(i, matcher)).length;
        if (fresh.length) toast(`${plural(fresh.length, 'new item')} in ${feed.name}${wanted ? ` · ${wanted} wanted` : ''}`);
        else if (!auto) toast('No new items');
      } else if (!auto) toast('No new items');
      if (feed.lastFetch && feed.lastFetch.warning) toast(feed.lastFetch.warning, 'error');
    } catch (e) {
      if (e.status === 404) {
        await loadFeeds().catch(() => {});
      } else {
        toast(`Couldn't update: ${e.message}`, 'error');
        const cached = state.cache.get(id);
        if (cached) cached.lastFetch = { ok: false, at: new Date().toISOString(), error: e.message };
        const sum = state.feeds.find((f) => f.id === id);
        if (sum) sum.lastFetch = { ok: false, at: new Date().toISOString(), error: e.message };
      }
    } finally {
      state.refreshing.delete(id);
      state.backfilling.delete(id);
      renderSidebar();
      if (feedView && feedView.id === id) {
        if (state.feeds.some((f) => f.id === id)) updateFeedView();
        else render();
      } else if (feedView && feedView.id === WANTED) {
        const view = feedView;
        loadWanted()
          .then(() => feedView === view && updateFeedView())
          .catch(() => {});
      } else state.wantedData = null;
    }
  }

  async function deleteFeed(id) {
    const sum = state.feeds.find((f) => f.id === id);
    if (!sum) return;
    const ok = await confirmDialog('Delete this feed?', `“${sum.name}” and its ${plural(sum.itemCount, 'saved item')} will be removed from this computer.`, 'Delete');
    if (!ok) return;
    try {
      await api('DELETE', '/api/feeds/' + id);
    } catch (e) {
      if (e.status !== 404) return toast(e.message, 'error');
    }
    state.cache.delete(id);
    state.wantedData = null;
    await loadFeeds();
    toast('Feed deleted');
    go('#/');
  }

  // ------------------------------------------------------------------ add feed / fix pattern

  function showAdd(fixId) {
    let params = { url: '', name: '', count: '', paging: '' };
    if (fixId) {
      const f = state.feeds.find((x) => x.id === fixId);
      params = { url: f.url, name: f.name, count: f.expectedCount || '', paging: f.pagingUrl || '' };
    }
    state.add = { phase: 'form', fixId, params, error: null, analysis: null, exampleCand: null, exampleMsg: null, exampleText: '', busy: false };
    renderAdd();
    if (!state.browserOk) return;
    api('GET', '/api/status')
      .then((s) => {
        if (!s.browser) {
          state.browserOk = false;
          renderAdd();
        }
      })
      .catch(() => {});
  }

  function renderAdd() {
    const add = state.add;
    if (!add) return;
    let body;
    if (add.phase === 'edit') body = editView(add);
    else if (add.phase === 'form') body = addForm(add);
    else if (add.phase === 'working') body = workingView(add);
    else body = resolveView(add);
    mainEl.replaceChildren(topbar(), h('div', { class: 'page-add' }, body));
    const first = $('input[name="url"]', mainEl);
    if (first && add.phase === 'form' && !first.value) first.focus({ preventScroll: true });
  }

  const COUNT_HINT = 'If you know how many items the page lists (at least), we use it to tell the real list apart from similar-looking elements. With a second page address below, this is the number of items to collect over all pages.';

  function pagingInput(value) {
    return h('input', { type: 'text', name: 'paging', id: 'f-paging', inputmode: 'url', placeholder: 'https://shop.example.com/category/shoes?page=2', autocomplete: 'off', spellcheck: 'false', value: value || '' });
  }

  function pagingField(input) {
    return h(
      'div',
      { class: 'field' },
      h('label', { for: 'f-paging' }, 'Address of the second page', h('span', { class: 'optional' }, 'optional')),
      input,
      h('div', { class: 'hint' }, 'If the list continues on more pages, paste the address of page 2. We compare it with the address above to find where the page number sits (in the query string, the path or anywhere else), then load page after page until the number of items is reached, a page has no new items, or we reach items you already have.')
    );
  }

  function addForm(add) {
    const fix = !!add.fixId;
    const url = h('input', { type: 'text', name: 'url', inputmode: 'url', placeholder: 'https://shop.example.com/category/shoes', required: true, autocomplete: 'off', spellcheck: 'false', value: add.params.url, readonly: fix || null });
    const name = h('input', { type: 'text', name: 'name', placeholder: 'Shoes at Example', required: true, maxlength: '80', autocomplete: 'off', value: add.params.name, readonly: fix || null });
    const count = h('input', { type: 'number', name: 'count', min: '1', max: '5000', step: '1', placeholder: 'e.g. 24', inputmode: 'numeric', value: add.params.count });
    const paging = pagingInput(add.params.paging);
    let nameTouched = !!add.params.name;
    name.addEventListener('input', () => (nameTouched = true));
    // An auto-suggested name is selected on focus so typing replaces it.
    name.addEventListener('focus', () => {
      if (!nameTouched && name.value) name.select();
    });
    url.addEventListener('blur', () => {
      if (nameTouched || name.value.trim() || !url.value.trim()) return;
      try {
        const u = new URL(/^[a-z]+:\/\//i.test(url.value.trim()) ? url.value.trim() : 'https://' + url.value.trim());
        name.value = u.hostname.replace(/^www\./, '');
      } catch {
        /* leave empty */
      }
    });

    const form = h(
      'form',
      { novalidate: true, onsubmit: (e) => submitForm(e, { url, name, count, paging: fix ? null : paging }) },
      add.error && h('div', { class: 'banner error', role: 'alert' }, add.error),
      !state.browserOk && h('div', { class: 'banner warn' }, 'No Chrome/Chromium browser was found. Run “npm run setup” in the project folder (or set CHROME_PATH) and restart the server.'),
      h('div', { class: 'field' }, h('label', { for: 'f-url' }, 'Web address'), url),
      !fix && h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Name'), name),
      h(
        'div',
        { class: 'field' },
        h('label', { for: 'f-count' }, 'Number of items', h('span', { class: 'optional' }, 'optional')),
        count,
        h('div', { class: 'hint' }, COUNT_HINT)
      ),
      !fix && pagingField(paging),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit' }, fix ? 'Analyze page again' : 'Find items'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => go(fix ? '#/feed/' + add.fixId : '#/') }, 'Cancel')
      )
    );
    url.id = 'f-url';
    name.id = 'f-name';
    count.id = 'f-count';

    return h(
      'div',
      { class: 'card add-card' },
      h('h1', {}, fix ? `Fix pattern · ${add.params.name}` : 'Add feed'),
      h('p', { class: 'lead' }, fix ? 'We load the page again and let you pick which repeating elements are the items. Items you already have are kept.' : 'Enter the address of a page that lists items, such as the category page of an online store. We open it like a browser would, find the repeating items and turn them into a feed.'),
      form
    );
  }

  // ------------------------------------------------------------------ start screen without feeds

  function showEmpty() {
    mainEl.replaceChildren(
      topbar(),
      h(
        'div',
        { class: 'page-add empty-state' },
        h('h1', {}, 'No feeds yet'),
        h('p', { class: 'lead' }, 'Add your first feed to see its items here.'),
        h('div', { class: 'form-actions' }, h('button', { class: 'btn btn-primary', type: 'button', onclick: () => go('#/add') }, 'Add feed')),
        h('p', { class: 'hint' }, 'Already use Feed Generator somewhere else? ', h('a', { href: '#/settings' }, 'Sync with that instance'), ' from the settings (cog button) instead.')
      )
    );
  }

  // ------------------------------------------------------------------ settings (site wide)

  let settingsPoll = null;

  function showSettings() {
    clearInterval(settingsPoll);
    const box = h('div', { class: 'card add-card' });
    const view = { box, error: null, busy: false, data: null };
    mainEl.replaceChildren(topbar(), h('div', { class: 'page-add' }, box));
    const paint = () => {
      if (parseRoute().name !== 'settings') return clearInterval(settingsPoll);
      box.replaceChildren(...settingsView(view, paint).filter(Boolean)); // replaceChildren would print null / false as text
    };
    const load = async () => {
      try {
        view.data = await api('GET', '/api/sync');
        paint();
      } catch (e) {
        view.error = e.message;
        paint();
      }
    };
    paint();
    load();
    // While a sync runs (or just after peers were added) the result shows up here by itself.
    settingsPoll = setInterval(() => {
      if (!view.busy && !document.querySelector('#f-peer:focus')) load();
    }, 4000);
  }

  function settingsView(view, paint) {
    const data = view.data;
    const run = async (fn) => {
      view.busy = true;
      view.error = null;
      paint();
      try {
        view.data = await fn();
        await loadFeeds().catch(() => {});
        state.wantedData = null;
        renderSidebar();
      } catch (e) {
        view.error = e.message;
      }
      view.busy = false;
      paint();
    };
    const savePeers = (peers) => run(() => api('PUT', '/api/sync/peers', { peers }));

    const input = h('input', { type: 'text', id: 'f-peer', placeholder: '192.168.1.20:3000', inputmode: 'url', autocomplete: 'off', spellcheck: 'false', disabled: view.busy });
    const addForm = h(
      'form',
      {
        class: 'peer-add',
        onsubmit: (e) => {
          e.preventDefault();
          const v = input.value.trim();
          if (v) savePeers([...data.peers.map((p) => p.url), v]);
        },
      },
      input,
      h('button', { class: 'btn btn-primary', type: 'submit', disabled: view.busy || !data }, 'Add')
    );

    const peerRow = (p) => {
      const s = p.at ? (p.ok ? `Synced ${timeAgo(p.at)}` : `Failed ${timeAgo(p.at)}: ${p.error}`) : 'Waiting for the first sync…';
      return h(
        'li',
        { class: 'peer' + (p.at && !p.ok ? ' failed' : '') },
        h('div', { class: 'peer-info' }, h('div', { class: 'peer-url' }, p.url), h('div', { class: 'peer-state' }, s)),
        h('button', { class: 'btn btn-ghost btn-danger icon-btn', type: 'button', title: 'Stop syncing with this instance', 'aria-label': 'Remove ' + p.url, disabled: view.busy, onclick: () => savePeers(data.peers.map((x) => x.url).filter((u) => u !== p.url)) }, icon('trash'))
      );
    };

    return [
      h('h1', {}, 'Settings'),
      h('p', { class: 'lead' }, 'Settings that apply to the whole app.'),
      view.error && h('div', { class: 'banner error', role: 'alert' }, view.error),
      h('h2', { class: 'section-title' }, 'Sync with other instances'),
      h(
        'p',
        { class: 'hint' },
        'Enter the address and port of another Feed Generator. Feeds (with their pattern), the wanted and ignored lists and the feed settings are then kept the same on all of them; the newest edit wins and deleting a feed deletes it everywhere. Items and stars are not synced: every instance loads its own. You only need to add the other instance on one side. The other instance must accept this address (',
        h('code', {}, 'ALLOWED_HOSTS'),
        ' when it is not on localhost).'
      ),
      addForm,
      !data
        ? h('div', { class: 'working' }, h('span', { class: 'spinner lg' }))
        : data.peers.length
          ? h('ul', { class: 'peers' }, data.peers.map(peerRow))
          : h('p', { class: 'hint' }, 'No other instances yet.'),
      data && data.peers.length > 0 && h('div', { class: 'form-actions' }, h('button', { class: 'btn', type: 'button', disabled: view.busy, onclick: () => run(() => api('POST', '/api/sync/now')) }, view.busy ? [h('span', { class: 'spinner' }), 'Syncing…'] : [icon('refresh'), 'Sync now'])),
      data && h('p', { class: 'hint' }, `Syncs automatically after every change and every ${Math.round(data.intervalMs / 60000)} minutes.`),
    ];
  }

  // ------------------------------------------------------------------ edit feed

  function showEdit(id) {
    const f = state.feeds.find((x) => x.id === id);
    state.add = { phase: 'edit', editId: id, params: { url: f.url, name: f.name, count: f.expectedCount || '', paging: f.pagingUrl || '' }, error: null, busy: false };
    renderAdd();
  }

  function editView(add) {
    const url = h('input', { type: 'text', name: 'url', id: 'f-url', inputmode: 'url', required: true, autocomplete: 'off', spellcheck: 'false', value: add.params.url });
    const name = h('input', { type: 'text', name: 'name', id: 'f-name', required: true, maxlength: '80', autocomplete: 'off', value: add.params.name });
    const count = h('input', { type: 'number', name: 'count', id: 'f-count', min: '1', max: '5000', step: '1', placeholder: 'e.g. 24', inputmode: 'numeric', value: add.params.count });
    const paging = pagingInput(add.params.paging);

    const read = () => ({ url: url.value.trim(), name: name.value.trim(), count: count.value.trim(), paging: paging.value.trim() });
    const save = async (reselect) => {
      const params = read();
      add.params = params;
      const fail = (m) => {
        add.error = m;
        renderAdd();
      };
      if (!params.name) return fail('Please enter a name for this feed.');
      if (!params.url) return fail('Please enter a web address.');
      if (params.count && !(Number.isInteger(Number(params.count)) && Number(params.count) >= 1 && Number(params.count) <= 5000)) return fail('The number of items must be a whole number between 1 and 5000.');
      const before = state.feeds.find((x) => x.id === add.editId);
      $('.page-add').querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        const { feed, recrawl } = await api('PUT', `/api/feeds/${add.editId}`, { name: params.name, url: params.url, expectedCount: params.count ? Number(params.count) : null, pagingUrl: params.paging });
        state.cache.set(feed.id, feed);
        state.wantedData = null;
        await loadFeeds();
        if (state.add !== add) return;
        if (reselect) return go('#/fix/' + feed.id);
        toast('Feed saved');
        go('#/feed/' + feed.id);
        if (recrawl) refresh(feed.id, { backfill: true });
        else if (before && feed.url !== before.url) refresh(feed.id);
      } catch (err) {
        if (state.add !== add) return;
        if (err.status === 404) {
          await loadFeeds().catch(() => {});
          return render();
        }
        fail(err.message);
      }
    };

    const form = h(
      'form',
      { novalidate: true, onsubmit: (e) => (e.preventDefault(), save(false)) },
      add.error && h('div', { class: 'banner error', role: 'alert' }, add.error),
      h('div', { class: 'field' }, h('label', { for: 'f-name' }, 'Name'), name),
      h('div', { class: 'field' }, h('label', { for: 'f-url' }, 'Web address'), url, h('div', { class: 'hint' }, 'If you change the address the items you have are kept; the next update reads the new page with the same pattern. Use “Re-select items” if the new page is laid out differently.')),
      h('div', { class: 'field' }, h('label', { for: 'f-count' }, 'Number of items', h('span', { class: 'optional' }, 'optional')), count, h('div', { class: 'hint' }, COUNT_HINT)),
      pagingField(paging),
      h(
        'div',
        { class: 'form-actions' },
        h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save changes'),
        h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => go('#/feed/' + add.editId) }, 'Cancel'),
        h('button', { class: 'btn', type: 'button', title: 'Save, then pick again which elements are the items', onclick: () => save(true) }, icon('wrench'), 'Re-select items…')
      )
    );
    return h('div', { class: 'card add-card' }, h('h1', {}, `Edit feed · ${add.params.name}`), h('p', { class: 'lead' }, 'Saving keeps all items you already have. When paging or the number of items changed, the pages behind the first one are loaded afterwards.'), form);
  }

  const WORKING_STEPS = [
    [0, 'Loading the page in a browser…'],
    [7000, 'Waiting for dynamic content and scrolling to load lazy items…'],
    [18000, 'Still working — some sites are slow…'],
    [40000, 'Almost there. Big pages can take up to a minute.'],
  ];

  function workingView(add) {
    const msg = h('p', {}, WORKING_STEPS[0][1]);
    const started = Date.now();
    const timer = setInterval(() => {
      if (state.add !== add || add.phase !== 'working' || !msg.isConnected) return clearInterval(timer);
      const step = [...WORKING_STEPS].reverse().find(([t]) => Date.now() - started >= t);
      if (!add.customMessage) msg.textContent = step[1];
    }, 1000);
    add.setMessage = (m) => {
      add.customMessage = true;
      msg.textContent = m;
    };
    return h('div', { class: 'card add-card' }, h('div', { class: 'working' }, h('span', { class: 'spinner lg' }), h('h2', {}, add.fixId ? 'Analyzing page…' : 'Finding items…'), msg));
  }

  async function submitForm(e, fields) {
    e.preventDefault();
    const add = state.add;
    if (add.phase !== 'form') return;
    const params = { url: fields.url.value.trim(), name: fields.name.value.trim(), count: fields.count.value.trim(), paging: fields.paging ? fields.paging.value.trim() : add.params.paging || '' };
    add.params = params;
    const fail = (m) => {
      add.error = m;
      renderAdd();
    };
    if (!params.url) return fail('Please enter a web address.');
    if (!add.fixId && !params.name) return fail('Please enter a name for this feed.');
    if (params.count && !(Number.isInteger(Number(params.count)) && Number(params.count) >= 1 && Number(params.count) <= 5000)) return fail('The number of items must be a whole number between 1 and 5000.');

    add.error = null;
    add.phase = 'working';
    renderAdd();
    try {
      const analysis = await api('POST', '/api/analyze', { url: params.url, expectedCount: params.count ? Number(params.count) : undefined, pagingUrl: params.paging || undefined });
      if (state.add !== add) return; // user navigated away
      add.analysis = analysis;
      if (analysis.confident && !add.fixId) {
        add.setMessage && add.setMessage(`Found ${plural(analysis.candidates[0].count, 'item')} — saving…`);
        await useCandidate(add, analysis.recommended);
        return;
      }
      add.phase = 'resolve';
      renderAdd();
    } catch (err) {
      if (state.add !== add) return;
      add.phase = 'form';
      add.error = err.message;
      renderAdd();
    }
  }

  async function useCandidate(add, candidateId) {
    const { params, analysis } = add;
    try {
      let feed;
      if (add.fixId) {
        ({ feed } = await api('POST', `/api/feeds/${add.fixId}/pattern`, { sessionId: analysis.sessionId, candidateId }));
      } else {
        ({ feed } = await api('POST', '/api/feeds', {
          sessionId: analysis.sessionId,
          candidateId,
          name: params.name,
          url: params.url,
          expectedCount: params.count ? Number(params.count) : undefined,
          pagingUrl: params.paging || undefined,
        }));
      }
      state.cache.set(feed.id, feed);
      state.autoRefreshed.add(feed.id); // it was just fetched
      await loadFeeds();
      toast(add.fixId ? `Pattern updated · ${plural(feed.items.length, 'item')} in feed` : `Feed “${feed.name}” created with ${plural(feed.items.length, 'item')}${feed.paging ? ' — loading more pages…' : ''}`);
      go('#/feed/' + feed.id);
      if (feed.paging) refresh(feed.id, { backfill: !add.fixId }); // page 1 is in; the pages behind it follow
    } catch (err) {
      if (state.add !== add) return;
      if (err.status === 410) {
        add.phase = 'form';
        add.error = err.message;
      } else {
        add.phase = 'resolve';
        toast(err.message, 'error');
      }
      renderAdd();
    }
  }

  const pct = (x) => Math.round(x * 100) + '%';

  function miniItem(it, analysis) {
    return h(
      'div',
      { class: 'mini' },
      thumb(it.image, { finalUrl: analysis.finalUrl }),
      h('div', {}, h('div', { class: 'mini-title' }, it.title || it.url || 'Untitled'), h('div', { class: 'mini-sub' }, [it.price, it.delivery].filter(Boolean).join(' · ') || 'No price found'))
    );
  }

  function candidateCard(c, n, add) {
    const m = c.metrics;
    const expected = Number(add.params.count) || 0;
    const use = h('button', { class: 'btn btn-primary btn-sm', type: 'button' }, 'Use this');
    use.addEventListener('click', async () => {
      $('.page-add').querySelectorAll('button').forEach((b) => (b.disabled = true));
      use.replaceChildren(h('span', { class: 'spinner' }), 'Saving…');
      await useCandidate(add, c.id);
    });
    return h(
      'article',
      { class: 'card cand' + (c.source === 'example' ? ' example' : '') },
      h(
        'div',
        { class: 'cand-top' },
        h(
          'div',
          {},
          h(
            'div',
            { class: 'cand-title' },
            c.source === 'example' ? 'Matches for your example' : `Option ${n}`,
            h('span', { class: 'pill soft' }, plural(c.count, 'item')),
            c.source !== 'example' && n === 1 && h('span', { class: 'pill good' }, 'Best guess'),
            c.belowExpected && h('span', { class: 'pill warn' }, `fewer than ${expected}`)
          ),
          h('div', { class: 'cand-sub' }, `images ${pct(m.fImg)} · prices ${pct(m.fPrice)} · links ${pct(m.fLink)}`)
        ),
        use
      ),
      h('div', { class: 'mini-list' }, c.preview.map((it) => miniItem(it, add.analysis))),
      h('details', {}, h('summary', {}, 'Show the HTML of the first element'), h('div', { class: 'hint', style: 'margin-top:8px' }, 'Selector: ' + c.selector), h('pre', { class: 'code' }, c.sampleHtml))
    );
  }

  function resolveView(add) {
    const a = add.analysis;
    const cands = [];
    if (add.exampleCand) cands.push(add.exampleCand);
    cands.push(...a.candidates);
    let n = 0;

    const text = h('textarea', { rows: '7', placeholder: '<li class="product">…</li>', spellcheck: 'false', 'aria-label': 'HTML of one example item' });
    text.value = add.exampleText;
    text.addEventListener('input', () => (add.exampleText = text.value));
    const find = h('button', { class: 'btn btn-primary', type: 'button' }, 'Find similar items');
    find.addEventListener('click', async () => {
      if (!add.exampleText.trim()) {
        add.exampleMsg = 'Paste the HTML of one item first.';
        add.exampleCand = null;
        return renderAdd();
      }
      find.disabled = true;
      find.replaceChildren(h('span', { class: 'spinner' }), 'Searching…');
      try {
        const r = await api('POST', '/api/analyze', {
          url: add.params.url,
          expectedCount: add.params.count ? Number(add.params.count) : undefined,
          pagingUrl: add.params.paging || undefined,
          sessionId: a.sessionId,
          exampleHtml: add.exampleText,
        });
        if (state.add !== add) return;
        if (r.sessionId !== a.sessionId) {
          // The cached page had expired and was reloaded; adopt the fresh candidate list.
          a.sessionId = r.sessionId;
          a.candidates = r.candidates || a.candidates;
        }
        add.exampleCand = r.example || null;
        add.exampleMsg = r.example ? null : r.message;
      } catch (err) {
        if (state.add !== add) return;
        add.exampleMsg = err.message;
        add.exampleCand = null;
      }
      renderAdd();
      const card = $('.cand.example');
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    return h(
      'div',
      {},
      h(
        'div',
        { class: 'resolve-head' },
        h('h1', {}, add.fixId ? 'Choose the items' : 'Help us find the items'),
        h('p', {}, add.fixId ? 'Pick the option that lists the items you want, or paste an example item.' : a.reason ? `${a.reason} Pick the option that lists your items, or paste an example item below.` : 'Pick the option that lists your items, or paste an example item below.')
      ),
      a.paging && h('div', { class: 'banner info' }, `Paging found: page 3 would be loaded from ${a.paging.page3}`),
      a.httpStatus >= 400 && h('div', { class: 'banner warn' }, `The site answered with HTTP ${a.httpStatus}. It may be blocking automated browsers, so the results below could be incomplete.`),
      cands.length > 0 ? h('div', { class: 'cands' }, cands.map((c) => candidateCard(c, c.source === 'example' ? 0 : ++n, add))) : h('div', { class: 'banner info' }, 'No repeating elements that look like items were found on this page. Try pasting the HTML of one item below.'),
      h(
        'section',
        { class: 'card example-box' },
        h('h2', {}, 'Paste an example item'),
        h('p', {}, 'None of the options right? Show us one item and we will look for everything that resembles it.'),
        h('ol', {}, h('li', {}, 'Open the page in your browser, right-click one item and choose Inspect.'), h('li', {}, 'Right-click the element that wraps the whole item → Copy → Copy outerHTML.'), h('li', {}, 'Paste it here.')),
        text,
        add.exampleMsg && h('div', { class: 'banner warn', style: 'margin:12px 0 0' }, add.exampleMsg),
        h('div', { class: 'row' }, find)
      ),
      h('div', { class: 'back-link' }, h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => { add.phase = 'form'; renderAdd(); } }, '← Change address or number of items'))
    );
  }

  // ------------------------------------------------------------------ start

  window.addEventListener('hashchange', render);

  /** Pick up background (server-side) auto refreshes and edits made elsewhere. */
  async function pollFeeds() {
    if (document.hidden) return;
    try {
      await loadFeeds();
    } catch {
      return;
    }
    let changed = false;
    for (const sum of state.feeds) {
      const cached = state.cache.get(sum.id);
      if (!cached || state.refreshing.has(sum.id)) continue;
      const mine = cached.lastFetch && cached.lastFetch.at;
      const theirs = sum.lastFetch && sum.lastFetch.at;
      if (mine === theirs) continue;
      try {
        const { feed } = await api('GET', '/api/feeds/' + sum.id);
        state.cache.set(sum.id, feed);
        changed = true;
        if (feed.fetchCount > cached.fetchCount && sum.newCount > 0) toast(`Auto update: ${plural(sum.newCount, 'new item')} in ${feed.name}`);
      } catch {
        /* try again on the next poll */
      }
    }
    renderSidebar();
    if (!feedView) return;
    if (changed) {
      state.wantedData = null;
      if (feedView.id === WANTED) await loadWanted().catch(() => {});
      updateFeedView();
    } else updateHeader();
  }
  setInterval(pollFeeds, 30000);
  document.addEventListener('visibilitychange', pollFeeds);

  (async function init() {
    try {
      await loadFeeds();
    } catch (e) {
      mainEl.replaceChildren(h('div', { class: 'page-add' }, h('div', { class: 'banner error' }, e.message)));
      return;
    }
    render();
  })();
})();
