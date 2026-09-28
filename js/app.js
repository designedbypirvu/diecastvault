/* Diecast Vault — application controller: state, rendering, interactions */
(() => {
  const C = DV.config;
  const { store, io } = DV;

  /* ─── Helpers ──────────────────────────────────────────────── */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c]);

  const fold = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const byText = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  /** Replaces <i data-lucide="name"> placeholders inside root with inline SVGs. */
  function hydrateIcons(root = document) {
    if (!window.lucide) return;
    $$('i[data-lucide]', root).forEach((el) => {
      const key = el.dataset.lucide.replace(/(^|-)([a-z0-9])/g, (_, __, c) => c.toUpperCase());
      const node = lucide.icons[key];
      if (!node) return;
      const svg = lucide.createElement(node);
      svg.setAttribute('class', `icon ${el.className}`.trim());
      svg.setAttribute('aria-hidden', 'true');
      el.replaceWith(svg);
    });
  }

  function countBy(items, key) {
    const counts = new Map();
    items.forEach((it) => counts.set(it[key], (counts.get(it[key]) || 0) + 1));
    return [...counts].sort((a, b) => b[1] - a[1] || byText(a[0], b[0]));
  }

  const conditionOf = (value) => C.CONDITIONS.find((c) => c.value === value) || C.CONDITIONS[1];
  const initials = (s) => String(s).split(/[\s-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const fmtDate = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

  /* ─── State ────────────────────────────────────────────────── */
  const prefs = store.loadPrefs();
  const state = {
    items: [],
    section: 'collection',   // 'collection' | 'wishlist'
    search: '',
    diecast: '',
    car: '',
    shelf: '',               // '' | 'on' | 'off'
    chase: false,            // only TH / Chase models
    sort: C.SORTS.some((s) => s.value === prefs.sort) ? prefs.sort : 'newest',
    view: prefs.view === 'list' ? 'list' : 'grid',
  };
  const isWish = () => state.section === 'wishlist';
  /** Items in the list currently being browsed (owned collection or wishlist). */
  const sectionItems = () => state.items.filter((it) => Boolean(it.wishlist) === isWish());

  let visible = [];          // items currently shown, in display order
  let lastVisibleKey = '';
  let storageWarned = false;

  const els = {
    topbar: $('#topbar'),
    stats: $('#stats'),
    tabs: $('#sectionTabs'),
    addLabel: $('#addBtn .btn__label'),
    search: $('#search'),
    filterDiecast: $('#filterDiecast'),
    filterCar: $('#filterCar'),
    sort: $('#sort'),
    chips: $('#chips'),
    resultCount: $('#resultCount'),
    clearFilters: $('#clearFilters'),
    deleteAll: $('#deleteAll'),
    grid: $('#grid'),
    empty: $('#emptyState'),
    toasts: $('#toasts'),
    importInput: $('#importInput'),
    exportMenu: $('#exportMenu'),
    exportBtn: $('#exportBtn'),
    formModal: $('#formModal'),
    form: $('#carForm'),
    detailModal: $('#detailModal'),
    detailCard: $('#detailCard'),
    confirmModal: $('#confirmModal'),
    accountMenu: $('#accountMenu'),
    accountBtn: $('#accountBtn'),
  };

  /* ─── Persistence ──────────────────────────────────────────── */
  // Local edits and incoming cloud changes take turns, so neither overwrites the other.
  let committing = 0;
  let idleWaiters = [];
  const whenIdle = () => new Promise((resolve) => (committing ? idleWaiters.push(resolve) : resolve()));

  /** Saves and applies a new item list. Resolves false (and changes nothing) if the browser is out of space. */
  async function commit(next) {
    committing++;
    try {
      const result = await store.save(next);
      if (result === 'quota') {
        toast('Browser storage is full. Export a backup and remove some models, or free up space on this device.', { type: 'error' });
        return false;
      }
      if (result === 'unavailable' && !storageWarned) {
        storageWarned = true;
        toast('Storage is blocked in this browser — changes will be lost when you close the tab.', { type: 'error' });
      }
      state.items = next;
      renderAll();
      return true;
    } finally {
      if (!--committing) { idleWaiters.forEach((r) => r()); idleWaiters = []; }
    }
  }

  /** Applies a change from the sync layer to the latest list; update(items) returns null for "no change". */
  async function applyRemote(update) {
    while (committing) await whenIdle();
    const next = update(state.items);
    if (!next) return;
    state.items = next;
    renderAll();
    await store.save(next, { remote: true });
  }

  const savePrefs = () => store.savePrefs({ sort: state.sort, view: state.view });

  const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

  /** Recompresses stored photos that are over the size budget (e.g. saved by an older version, or imported). */
  let compacting = false;
  async function compactPhotos() {
    if (compacting) return;
    const heavy = state.items.filter((it) => it.image.startsWith('data:') && io.dataURLBytes(it.image) > C.MAX_IMAGE_BYTES);
    if (!heavy.length) return;
    compacting = true;
    try {
      const shrunk = new Map(); // original data URL -> compressed one
      let saved = 0;
      for (const it of heavy) {
        const image = await io.shrinkDataURL(it.image);
        if (image !== it.image) {
          shrunk.set(it.image, image);
          saved += io.dataURLBytes(it.image) - io.dataURLBytes(image);
        }
      }
      if (!shrunk.size) return;
      // Apply to the current list so edits made meanwhile are kept; a photo replaced meanwhile won't match.
      const next = state.items.map((it) => (shrunk.has(it.image) ? { ...it, image: shrunk.get(it.image) } : it));
      if (await commit(next)) {
        toast(`Compressed ${shrunk.size} photo${shrunk.size === 1 ? '' : 's'} — freed ${fmtBytes(saved)}.`, { type: 'info' });
      }
    } finally {
      compacting = false;
    }
  }

  /* ─── Filtering & sorting ──────────────────────────────────── */
  function getVisible() {
    const terms = fold(state.search).split(/\s+/).filter(Boolean);
    const list = sectionItems().filter((it) => {
      if (state.diecast && it.diecastBrand !== state.diecast) return false;
      if (state.car && it.carBrand !== state.car) return false;
      if (state.shelf && it.shelved !== (state.shelf === 'on')) return false;
      if (state.chase && !it.chase) return false;
      if (!terms.length) return true;
      const hay = fold(`${it.diecastBrand} ${it.carBrand} ${it.model} ${it.year} ${it.series}`);
      return terms.every((t) => hay.includes(t));
    });
    const sorters = {
      newest: (a, b) => b.createdAt - a.createdAt,
      oldest: (a, b) => a.createdAt - b.createdAt,
      car: (a, b) => byText(a.carBrand, b.carBrand) || byText(a.model, b.model),
      model: (a, b) => byText(a.model, b.model) || byText(a.carBrand, b.carBrand),
      // oldest model year first; cars without a year go last
      year: (a, b) => (a.year || '9999').localeCompare(b.year || '9999') || byText(a.carBrand, b.carBrand) || byText(a.model, b.model),
    };
    return list.sort(sorters[state.sort]);
  }

  const hasFilters = () => Boolean(state.search.trim() || state.diecast || state.car || state.shelf || state.chase);

  /* ─── Rendering: stats ─────────────────────────────────────── */
  function renderStats() {
    const items = state.items.filter((i) => !i.wishlist);
    const wishes = state.items.filter((i) => i.wishlist);
    const total = items.length;
    const [topDiecast] = countBy(items, 'diecastBrand');
    const [topCar] = countBy(items, 'carBrand');
    const latestWish = wishes.reduce((a, b) => (!a || b.createdAt > a.createdAt ? b : a), null);
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const uniq = (k) => new Set(items.map((i) => i[k])).size;

    const tiles = [
      {
        label: 'Total models', icon: 'layers', value: total, numeric: true, accent: true,
        sub: total ? `${uniq('carBrand')} car brands · ${uniq('scale')} scale${uniq('scale') === 1 ? '' : 's'}` : 'Start your collection',
      },
      {
        label: 'Top diecast brand', icon: 'factory', value: topDiecast?.[0] ?? '—',
        sub: topDiecast ? `${topDiecast[1]} model${topDiecast[1] === 1 ? '' : 's'} · ${pct(topDiecast[1])}%` : 'No models yet',
        meter: topDiecast ? pct(topDiecast[1]) : 0,
      },
      {
        label: 'Top car brand', icon: 'car-front', value: topCar?.[0] ?? '—',
        sub: topCar ? `${topCar[1]} model${topCar[1] === 1 ? '' : 's'} · ${pct(topCar[1])}%` : 'No models yet',
        meter: topCar ? pct(topCar[1]) : 0,
      },
      {
        label: 'Wishlist', icon: 'heart', value: wishes.length, numeric: true, goto: 'wishlist',
        sub: latestWish ? `Latest: ${latestWish.carBrand} ${latestWish.model}` : 'Nothing on your wishlist yet',
      },
    ];

    els.stats.innerHTML = tiles.map((t) => {
      const tag = t.goto ? 'a' : 'article';
      const attrs = t.goto ? ` href="#sectionTabs" data-goto="${t.goto}" aria-label="${esc(`${t.label}: ${t.value}. Open wishlist`)}"` : '';
      return `
      <${tag} class="stat${t.accent ? ' stat--accent' : ''}${t.goto ? ' stat--link' : ''}"${attrs}>
        <div class="stat__head"><span>${esc(t.label)}</span><i data-lucide="${t.icon}"></i></div>
        <p class="stat__value${t.numeric ? ' is-num' : ''}" ${t.numeric ? `data-count="${t.value}"` : ''} title="${esc(t.value)}">${t.numeric ? '0' : esc(t.value)}</p>
        <p class="stat__sub">${esc(t.sub)}</p>
        ${t.meter != null ? `<div class="stat__meter"><span style="--w:${t.meter}%"></span></div>` : ''}
        ${t.goto ? '<span class="stat__go" aria-hidden="true">View wishlist<i data-lucide="arrow-right"></i></span>' : ''}
      </${tag}>`;
    }).join('');
    hydrateIcons(els.stats);
    $$('[data-count]', els.stats).forEach(countUp);
  }

  function countUp(el) {
    const target = Number(el.dataset.count);
    const from = Number(el.dataset.from || 0);
    if (reducedMotion.matches || target === from) { el.textContent = target; return; }
    const start = performance.now();
    const dur = 900;
    const tick = (now) => {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 4);
      el.textContent = Math.round(from + (target - from) * eased);
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /* ─── Rendering: filters & chips ───────────────────────────── */
  function fillFilterSelect(select, entries, allLabel, current) {
    select.innerHTML = `<option value="">${esc(allLabel)}</option>` +
      [...entries].sort((a, b) => byText(a[0], b[0]))
        .map(([v, n]) => `<option value="${esc(v)}">${esc(v)} (${n})</option>`).join('');
    select.value = current;
  }

  function renderFilterOptions() {
    const items = sectionItems();
    const diecast = countBy(items, 'diecastBrand');
    const car = countBy(items, 'carBrand');
    if (state.diecast && !diecast.some(([v]) => v === state.diecast)) state.diecast = '';
    if (state.car && !car.some(([v]) => v === state.car)) state.car = '';
    fillFilterSelect(els.filterDiecast, diecast, 'All manufacturers', state.diecast);
    fillFilterSelect(els.filterCar, car, 'All car brands', state.car);
  }

  function renderChips() {
    const items = sectionItems();
    const chips = [
      { type: 'all', label: 'All', count: items.length },
      ...(isWish() ? [] : [
        { type: 'shelf', value: 'on', label: 'On shelf', count: items.filter((i) => i.shelved).length },
        { type: 'shelf', value: 'off', label: 'Not shelved', count: items.filter((i) => !i.shelved).length },
      ]),
      ...(items.some((i) => i.chase) ? [{ type: 'chase', value: 'on', label: 'TH / Chase', count: items.filter((i) => i.chase).length }] : []),
      ...countBy(items, 'diecastBrand').slice(0, 2).map(([v, n]) => ({ type: 'diecast', value: v, label: v, count: n })),
      ...countBy(items, 'carBrand').slice(0, 5).map(([v, n]) => ({ type: 'car', value: v, label: v, count: n })),
    ];
    els.chips.hidden = items.length === 0;
    els.chips.innerHTML = chips.map((c) => `
      <button type="button" class="chip chip--${c.type}" data-chip-type="${c.type}" data-chip-value="${esc(c.value ?? '')}" aria-pressed="false">
        ${c.type === 'diecast' ? '<i data-lucide="factory"></i>' : c.type === 'chase' ? '<i data-lucide="flame"></i>' : c.value === 'on' ? '<i data-lucide="library"></i>' : ''}${esc(c.label)}<span class="chip__count">${c.count}</span>
      </button>`).join('');
    hydrateIcons(els.chips);
    syncChipState();
  }

  function syncChipState() {
    $$('.chip', els.chips).forEach((chip) => {
      const { chipType: type, chipValue: value } = chip.dataset;
      const active = type === 'all' ? !state.diecast && !state.car && !state.shelf && !state.chase
        : type === 'shelf' ? state.shelf === value
        : type === 'chase' ? state.chase
        : type === 'diecast' ? state.diecast === value
        : state.car === value;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });
  }

  /* ─── Rendering: cards ─────────────────────────────────────── */
  const cardEls = new Map(); // id -> element, reused across filter changes so images never reload

  function mediaHTML(item, { eager = false } = {}) {
    const src = store.isSafeImage(item.image) ? item.image : '';
    return `
      <div class="media__ph" aria-hidden="true">
        <span class="media__initials">${esc(initials(item.carBrand) || 'DV')}</span>
        <i data-lucide="car-front"></i>
      </div>
      ${src ? `<img src="${esc(src)}" alt="${esc(`${item.carBrand} ${item.model}`)}" ${eager ? '' : 'loading="lazy"'} decoding="async" referrerpolicy="no-referrer">` : ''}`;
  }

  function conditionPill(value) {
    const c = conditionOf(value);
    return `<span class="pill pill--${c.tone}" title="${esc(c.value)}"><i data-lucide="${c.icon}"></i>${esc(c.short)}</span>`;
  }

  function createCard(item) {
    const el = document.createElement('article');
    el.className = 'card';
    el.tabIndex = 0;
    el.dataset.id = item.id;
    el.dataset.sig = cardSig(item);
    el.setAttribute('aria-label', `${item.diecastBrand} ${item.carBrand} ${item.model}${item.year ? ` (${item.year})` : ''}, ${item.scale}`);
    el.innerHTML = `
      <div class="card__media media" data-media>
        ${mediaHTML(item)}
        <span class="badge">${esc(item.diecastBrand)}</span>
        <span class="scale-tag">${esc(item.scale)}</span>
        <div class="card__actions">
          ${item.wishlist ? `<button type="button" class="icon-btn icon-btn--glass icon-btn--got" data-action="acquire" aria-label="Got ${esc(item.model)} — move to collection" title="Got it — move to collection"><i data-lucide="package-plus"></i></button>` : ''}
          <button type="button" class="icon-btn icon-btn--glass" data-action="edit" aria-label="Edit ${esc(item.model)}" title="Edit"><i data-lucide="pencil"></i></button>
          <button type="button" class="icon-btn icon-btn--glass icon-btn--danger" data-action="delete" aria-label="Delete ${esc(item.model)}" title="Delete"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <div class="card__body">
        <h3 class="card__title"><span class="card__make">${esc(item.carBrand)}</span> ${esc(item.model)}${item.year ? ` <span class="card__year">${esc(item.year)}</span>` : ''}</h3>
        <div class="card__inline-actions">
          ${item.wishlist ? `<button type="button" class="icon-btn card__btn icon-btn--got" data-action="acquire" aria-label="Got ${esc(item.model)} — move to collection" title="Got it — move to collection"><i data-lucide="package-plus"></i></button>` : ''}
          <button type="button" class="icon-btn card__btn" data-action="edit" aria-label="Edit ${esc(item.model)}" title="Edit"><i data-lucide="pencil"></i></button>
          <button type="button" class="icon-btn card__btn icon-btn--danger" data-action="delete" aria-label="Delete ${esc(item.model)}" title="Delete"><i data-lucide="trash-2"></i></button>
        </div>
        <div class="card__meta">
          <span class="card__series">${esc(item.series || 'No series')}</span>
          <span class="card__pills">
            <span class="pill pill--brand">${esc(item.diecastBrand)}</span>
            <span class="pill pill--scale${item.scale === C.SCALES[0] ? ' is-default' : ''}">${esc(item.scale)}</span>
            ${item.chase ? '<span class="pill pill--chase" title="Treasure Hunt / Chase"><i data-lucide="flame"></i>TH</span>' : ''}
            ${item.shelved ? '<span class="pill pill--shelf" title="On the display shelf"><i data-lucide="library"></i>On shelf</span>' : ''}
            ${conditionPill(item.condition)}
          </span>
        </div>
      </div>`;
    hydrateIcons(el);
    return el;
  }

  const cardSig = (item) => `${item.updatedAt}${item.wishlist ? 'w' : ''}`;

  /** Creates/updates/removes card elements to mirror state.items. */
  function syncCards() {
    const ids = new Set(state.items.map((i) => i.id));
    for (const [id, el] of cardEls) {
      if (!ids.has(id)) { el.remove(); cardEls.delete(id); }
    }
    state.items.forEach((item) => {
      const existing = cardEls.get(item.id);
      if (existing && existing.dataset.sig === cardSig(item)) return;
      const el = createCard(item);
      if (existing) existing.replaceWith(el);
      cardEls.set(item.id, el);
    });
  }

  function renderResults({ force = false } = {}) {
    visible = getVisible();
    const key = visible.map((i) => i.id).join('|');
    els.grid.dataset.view = state.view;

    if (force || key !== lastVisibleKey) {
      lastVisibleKey = key;
      const frag = document.createDocumentFragment();
      visible.forEach((item, idx) => {
        const el = cardEls.get(item.id);
        el.style.setProperty('--i', Math.min(idx, 14));
        el.classList.remove('is-entering');
        void el.offsetWidth; // restart entrance animation
        el.classList.add('is-entering');
        frag.appendChild(el);
      });
      els.grid.replaceChildren(frag);
    }

    const total = sectionItems().length;
    els.resultCount.innerHTML = total
      ? (hasFilters()
        ? `Showing <b>${visible.length}</b> of ${total} ${isWish() ? 'on your wishlist' : 'models'}`
        : `<b>${total}</b> model${total === 1 ? '' : 's'} ${isWish() ? 'on your wishlist' : 'in your vault'}`)
      : '';
    els.clearFilters.hidden = !hasFilters();
    els.deleteAll.hidden = !total || hasFilters(); // it wipes the whole list, so don't offer it beside a filtered view
    syncChipState();
    renderEmpty();
  }

  function renderTabs() {
    const wishes = state.items.filter((i) => i.wishlist).length;
    const counts = { collection: state.items.length - wishes, wishlist: wishes };
    $$('[data-section]', els.tabs).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.section === state.section)));
    $$('[data-count-for]', els.tabs).forEach((c) => { c.textContent = counts[c.dataset.countFor]; });
    els.addLabel.textContent = isWish() ? 'Add wish' : 'Add model';
    els.search.placeholder = isWish() ? 'Search your wishlist…' : 'Search models & brands…';
  }

  function renderEmpty() {
    const total = sectionItems().length;
    if (visible.length) { els.empty.hidden = true; return; }
    els.empty.hidden = false;
    if (!total && isWish()) {
      els.empty.innerHTML = `
        <div class="empty__art empty__art--wish"><i data-lucide="heart"></i></div>
        <h2>Your wishlist is empty</h2>
        <p>Keep track of the castings you’re hunting for. When you find one, tap <b>Got it</b> to move it into your collection.</p>
        <div class="empty__actions">
          <button type="button" class="btn btn--primary" data-empty="add"><i data-lucide="plus"></i>Add to wishlist</button>
        </div>`;
    } else if (!total && state.items.length) {
      els.empty.innerHTML = `
        <div class="empty__art"><i data-lucide="warehouse"></i></div>
        <h2>No models in your collection yet</h2>
        <p>Add a model you own, or mark one from your wishlist as <b>Got it</b>.</p>
        <div class="empty__actions">
          <button type="button" class="btn btn--primary" data-empty="add"><i data-lucide="plus"></i>Add a model</button>
          <button type="button" class="btn btn--ghost" data-empty="wishlist"><i data-lucide="heart"></i>Open wishlist</button>
        </div>`;
    } else if (!total) {
      els.empty.innerHTML = `
        <div class="empty__art"><i data-lucide="warehouse"></i></div>
        <h2>Your vault is empty</h2>
        <p>Add your first model, import a JSON backup, or load the demo collection to explore.</p>
        <div class="empty__actions">
          <button type="button" class="btn btn--primary" data-empty="add"><i data-lucide="plus"></i>Add a model</button>
          <button type="button" class="btn btn--ghost" data-empty="import"><i data-lucide="upload"></i>Import JSON</button>
          <button type="button" class="btn btn--ghost" data-empty="demo"><i data-lucide="sparkles"></i>Load demo</button>
        </div>`;
    } else {
      const q = state.search.trim();
      els.empty.innerHTML = `
        <div class="empty__art"><i data-lucide="search-x"></i></div>
        <h2>No matches${q ? ` for “${esc(q)}”` : ''}</h2>
        <p>Try a different search term or loosen your filters.</p>
        <div class="empty__actions">
          <button type="button" class="btn btn--ghost" data-empty="clear"><i data-lucide="rotate-ccw"></i>Clear filters</button>
        </div>`;
    }
    hydrateIcons(els.empty);
  }

  function renderAll() {
    syncCards();
    renderStats();
    renderTabs();
    renderFilterOptions();
    renderChips();
    renderResults({ force: true });
  }

  /* ─── Toasts ───────────────────────────────────────────────── */
  function toast(message, { type = 'success', action, duration = 4200 } = {}) {
    const icon = { success: 'check-circle-2', error: 'alert-triangle', info: 'info' }[type] || 'info';
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = `<i data-lucide="${icon}"></i><p>${esc(message)}</p>${action ? `<button type="button" class="toast__action">${esc(action.label)}</button>` : ''}`;
    hydrateIcons(el);
    const dismiss = () => {
      if (el.classList.contains('is-leaving')) return;
      el.classList.add('is-leaving');
      el.addEventListener('animationend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    };
    if (action) {
      $('.toast__action', el).addEventListener('click', () => { action.run(); dismiss(); });
    }
    els.toasts.appendChild(el);
    // Re-show the manual popover so toasts sit above any open modal in the top layer.
    if (els.toasts.showPopover) {
      try {
        if (els.toasts.matches(':popover-open')) els.toasts.hidePopover();
        els.toasts.showPopover();
      } catch { /* popover unsupported — falls back to a fixed element */ }
    }
    setTimeout(dismiss, action ? duration + 2500 : duration);
  }

  /* ─── Modals (native <dialog> with animated close) ─────────── */
  function openModal(dialog) {
    if (dialog.open) return;
    dialog.classList.remove('is-closing');
    dialog.showModal();
    document.body.classList.add('has-modal');
  }

  function closeModal(dialog) {
    if (!dialog.open || dialog.classList.contains('is-closing')) return;
    const finish = () => {
      dialog.classList.remove('is-closing');
      dialog.close();
      if (!$('dialog[open]')) document.body.classList.remove('has-modal');
    };
    if (reducedMotion.matches) { finish(); return; }
    dialog.classList.add('is-closing');
    setTimeout(finish, 200);
  }

  $$('dialog.modal').forEach((dialog) => {
    // iOS scrolls the (overflow: hidden) dialog to reveal the focused control while the sheet is still
    // sliding in from below, leaving the sheet shifted up once the animation ends. Keep it pinned.
    dialog.addEventListener('scroll', () => { dialog.scrollTop = 0; dialog.scrollLeft = 0; });
    dialog.addEventListener('cancel', (e) => { e.preventDefault(); closeModal(dialog); });
    // Close when clicking the backdrop (the dialog element itself, outside the card)
    dialog.addEventListener('mousedown', (e) => { dialog._downOnBackdrop = e.target === dialog; });
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog && dialog._downOnBackdrop) closeModal(dialog);
      if (e.target.closest('[data-close]')) closeModal(dialog);
    });
  });

  /**
   * Promise-based confirm dialog. Resolves to the chosen action value, or null if dismissed.
   * With `confirmText`, the last (primary) action stays disabled until that word is typed.
   */
  async function ask({ title, body, icon = 'alert-triangle', tone = 'danger', actions, confirmText }) {
    const dlg = els.confirmModal;
    // Chained asks: let the previous one finish its close animation before reusing the dialog
    if (dlg.open) await new Promise((r) => dlg.addEventListener('close', r, { once: true }));
    const input = $('#confirmInput', dlg);
    input.hidden = !confirmText;
    input.value = '';
    input.placeholder = confirmText ? `Type ${confirmText}` : '';
    $('#confirmTitle', dlg).textContent = title;
    $('#confirmBody', dlg).textContent = body;
    const iconWrap = $('#confirmIcon', dlg);
    iconWrap.className = `confirm__icon confirm__icon--${tone}`;
    iconWrap.innerHTML = `<i data-lucide="${icon}"></i>`;
    $('#confirmActions', dlg).innerHTML = actions.map((a, i) =>
      `<button type="button" class="btn btn--${a.variant || 'ghost'}" data-value="${i}">${esc(a.label)}</button>`).join('');
    hydrateIcons(dlg);
    const primary = $$('[data-value]', dlg).pop();
    if (confirmText) primary.disabled = true;

    return new Promise((resolve) => {
      const onClick = (e) => {
        const btn = e.target.closest('[data-value]');
        if (!btn) return;
        cleanup();
        closeModal(dlg);
        resolve(actions[Number(btn.dataset.value)].value);
      };
      const onInput = () => { primary.disabled = input.value.trim().toUpperCase() !== confirmText; };
      const onKey = (e) => { if (e.key === 'Enter' && !primary.disabled) primary.click(); };
      const onClose = () => { cleanup(); resolve(null); };
      const cleanup = () => {
        dlg.removeEventListener('click', onClick);
        dlg.removeEventListener('close', onClose);
        input.removeEventListener('input', onInput);
        input.removeEventListener('keydown', onKey);
      };
      dlg.addEventListener('click', onClick);
      dlg.addEventListener('close', onClose, { once: true });
      if (confirmText) {
        input.addEventListener('input', onInput);
        input.addEventListener('keydown', onKey);
      }
      openModal(dlg);
      (confirmText ? input : primary)?.focus();
    });
  }

  /* ─── Add / edit form ──────────────────────────────────────── */
  const form = {
    editingId: null,
    wishlist: false,
    photo: '',
    diecast: $('#fDiecast'),
    diecastCustom: $('#fDiecastCustom'),
    car: $('#fCar'),
    carCustom: $('#fCarCustom'),
    model: $('#fModel'),
    year: $('#fYear'),
    scale: $('#fScale'),
    scaleCustom: $('#fScaleCustom'),
    series: $('#fSeries'),
    seriesCustom: $('#fSeriesCustom'),
    conditions: $('#fCondition'),
    preview: $('#photoPreview'),
    file: $('#fFile'),
    url: $('#fUrl'),
    dropzone: $('#dropzone'),
    photoClear: $('#photoClear'),
  };

  function brandOptions(presets, used, placeholder) {
    const extras = [...new Set(used)].filter((b) => b && !presets.includes(b) && b !== 'Unknown').sort(byText);
    return `<option value="" disabled>${esc(placeholder)}</option>
      <optgroup label="Popular">${presets.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}</optgroup>
      ${extras.length ? `<optgroup label="From your collection">${extras.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('')}</optgroup>` : ''}
      <option value="${C.CUSTOM}">Other / Custom…</option>`;
  }

  /** Selects a value in a preset <select>, falling back to its custom text input. */
  function setChoice(select, input, value) {
    const known = value && $$('option', select).some((o) => o.value === value && o.value !== C.CUSTOM);
    select.value = known ? value : value ? C.CUSTOM : '';
    input.value = known ? '' : value || '';
    toggleCustom(select, input, false);
  }

  function toggleCustom(select, input, focus = true) {
    const show = select.value === C.CUSTOM;
    input.hidden = !show;
    if (show && focus) input.focus();
  }

  const readChoice = (select, input) => (select.value === C.CUSTOM ? input.value.trim() : select.value);

  function setPhoto(src, { tab } = {}) {
    form.photo = src && store.isSafeImage(src) ? src : '';
    form.preview.classList.remove('is-broken', 'is-loaded');
    form.preview.innerHTML = mediaHTML({ carBrand: readChoice(form.car, form.carCustom) || 'DV', model: '', image: form.photo }, { eager: true });
    hydrateIcons(form.preview);
    form.photoClear.hidden = !form.photo;
    if (tab) setPhotoTab(tab);
  }

  function setPhotoTab(tab) {
    $$('[data-photo-tab]', els.form).forEach((b) => b.setAttribute('aria-selected', String(b.dataset.photoTab === tab)));
    $$('[data-photo-pane]', els.form).forEach((p) => { p.hidden = p.dataset.photoPane !== tab; });
  }

  function clearErrors() {
    $$('.field.has-error', els.form).forEach((f) => f.classList.remove('has-error'));
    $$('.field__error', els.form).forEach((p) => { p.textContent = ''; });
  }

  function setError(name, message) {
    const field = $(`[data-field="${name}"]`, els.form);
    field.classList.add('has-error');
    $('.field__error', field).textContent = message;
  }

  function openForm(item = null) {
    form.editingId = item?.id ?? null;
    form.wishlist = item ? item.wishlist : isWish();
    els.form.reset();
    clearErrors();

    form.diecast.innerHTML = brandOptions(C.DIECAST_BRANDS, state.items.map((i) => i.diecastBrand), 'Select manufacturer');
    form.car.innerHTML = brandOptions(C.CAR_BRANDS, state.items.map((i) => i.carBrand), 'Select car brand');
    form.scale.innerHTML = C.SCALES.map((s) => `<option value="${s}">${s}</option>`).join('') + `<option value="${C.CUSTOM}">Other</option>`;
    const seriesUsed = [...new Set(state.items.map((i) => i.series))].filter((s) => s && !C.SERIES.includes(s)).sort(byText);
    form.series.innerHTML = `<option value="">None</option>
      ${C.SERIES.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}
      ${seriesUsed.length ? `<optgroup label="From your collection">${seriesUsed.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}</optgroup>` : ''}
      <option value="${C.CUSTOM}">Custom…</option>`;
    form.conditions.innerHTML = C.CONDITIONS.map((c) => `
      <label class="pill-option pill-option--${c.tone}">
        <input type="radio" name="condition" value="${esc(c.value)}" ${c.value === 'Loose' ? 'checked' : ''}>
        <span><i data-lucide="${c.icon}"></i>${esc(c.value)}</span>
      </label>`).join('');

    setChoice(form.diecast, form.diecastCustom, item?.diecastBrand ?? '');
    setChoice(form.car, form.carCustom, item?.carBrand ?? '');
    setChoice(form.scale, form.scaleCustom, item?.scale ?? '1:64');
    form.model.value = item?.model ?? '';
    form.year.value = item?.year ?? '';
    setChoice(form.series, form.seriesCustom, item?.series ?? '');
    if (item) {
      const radio = $$('input[name="condition"]', form.conditions).find((r) => r.value === item.condition);
      if (radio) radio.checked = true;
    }
    $(`input[name="shelved"][value="${item?.shelved ? 'yes' : 'no'}"]`, els.form).checked = true;
    $('#fChase', els.form).checked = Boolean(item?.chase);
    $('#fShelfField').hidden = form.wishlist; // you can't shelve a car you don't own yet

    const img = item?.image ?? '';
    const pasted = Boolean(img) && !img.startsWith('data:') && !DV.sync.isHostedPhoto(img); // a link typed in, not an upload
    form.url.value = pasted ? img : '';
    setPhoto(img, { tab: pasted ? 'url' : 'upload' });

    $('#formEyebrow').textContent = item ? (form.wishlist ? 'Edit wish' : 'Edit entry') : (form.wishlist ? 'New wish' : 'New entry');
    $('#formTitle').textContent = item ? `${item.carBrand} ${item.model}` : (form.wishlist ? 'Add to wishlist' : 'Add a model');
    $('#formSubmit span').textContent = item ? 'Save changes' : (form.wishlist ? 'Add to wishlist' : 'Add to collection');

    hydrateIcons(els.form);
    closeModal(els.detailModal);
    openModal(els.formModal);
    requestAnimationFrame(() => (item ? form.model : form.diecast).focus());
  }

  let submitting = false;
  async function submitForm(e) {
    e.preventDefault();
    if (submitting) return;
    clearErrors();
    const data = {
      diecastBrand: readChoice(form.diecast, form.diecastCustom),
      carBrand: readChoice(form.car, form.carCustom),
      model: form.model.value.trim(),
      year: form.year.value.trim(),
      scale: readChoice(form.scale, form.scaleCustom),
      series: readChoice(form.series, form.seriesCustom),
      condition: $('input[name="condition"]:checked', form.conditions)?.value ?? 'Loose',
      shelved: !form.wishlist && $('input[name="shelved"]:checked', els.form)?.value === 'yes',
      wishlist: form.wishlist,
      chase: $('#fChase', els.form).checked,
      image: form.photo,
    };

    const errors = [];
    if (!data.diecastBrand) errors.push(['diecastBrand', form.diecast.value === C.CUSTOM ? 'Enter the manufacturer name.' : 'Choose a diecast manufacturer.']);
    if (!data.carBrand) errors.push(['carBrand', form.car.value === C.CUSTOM ? 'Enter the car brand.' : 'Choose a car brand.']);
    if (!data.model) errors.push(['model', 'Enter the model name.']);
    if (data.year && !(/^\d{4}$/.test(data.year) && data.year >= 1885 && data.year <= new Date().getFullYear() + 2)) errors.push(['year', 'Enter a 4-digit year, e.g. 1997.']);
    if (!data.scale) errors.push(['scale', 'Enter the scale, e.g. 1:87.']);
    if (errors.length) {
      errors.forEach(([k, m]) => setError(k, m));
      const first = $('.field.has-error', els.form);
      ($('input:not([hidden])', first) || $('select', first))?.focus();
      return;
    }

    const now = Date.now();
    let next;
    let message;
    if (form.editingId) {
      next = state.items.map((it) => (it.id === form.editingId ? { ...it, ...data, updatedAt: now } : it));
      message = `Saved changes to ${data.carBrand} ${data.model}.`;
    } else {
      next = [{ id: store.uid(), ...data, createdAt: now, updatedAt: now }, ...state.items];
      message = `${data.carBrand} ${data.model} added to your ${data.wishlist ? 'wishlist' : 'vault'}.`;
    }
    submitting = true;
    try {
      if (await commit(next)) {
        closeModal(els.formModal);
        toast(message);
      }
    } finally {
      submitting = false;
    }
  }

  async function handleImageFile(file) {
    if (!file) return;
    if (file.size > 25 * 1024 * 1024) { toast('That image is over 25 MB — please pick a smaller one.', { type: 'error' }); return; }
    form.dropzone.classList.add('is-busy');
    try {
      const photo = await io.imageToDataURL(file);
      setPhoto(photo);
      form.url.value = '';
      const size = io.dataURLBytes(photo);
      if (file.size > size * 1.5) toast(`Photo compressed: ${fmtBytes(file.size)} → ${fmtBytes(size)}.`, { type: 'info', duration: 2600 });
    } catch (err) {
      toast(err.message, { type: 'error' });
    } finally {
      form.dropzone.classList.remove('is-busy');
      form.file.value = '';
    }
  }

  /* ─── Detail / preview modal ───────────────────────────────── */
  let detailId = null;

  function openDetail(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    detailId = id;
    const idx = visible.findIndex((i) => i.id === id);
    const cond = conditionOf(item.condition);
    const rows = [
      ['Diecast brand', item.diecastBrand, 'factory'],
      ['Car brand', item.carBrand, 'car-front'],
      ['Model', item.model, 'tag'],
      ['Year', item.year || '—', 'calendar'],
      ['Scale', item.scale, 'ruler'],
      ['Series', item.series || '—', 'layers'],
      ['Condition', cond.value, cond.icon],
      ...(item.chase ? [['Special', 'TH / Chase', 'flame']] : []),
      [item.wishlist ? 'Wishlisted' : 'Added', fmtDate(item.createdAt), 'calendar-days'],
    ];
    const shelfRow = item.wishlist ? '' : `
          <div>
            <dt><i data-lucide="library"></i>Display shelf</dt>
            <dd class="specs__switch">
              <span>${item.shelved ? 'On the shelf' : 'Not shelved'}</span>
              <button type="button" class="switch" role="switch" aria-checked="${item.shelved}" aria-label="On the display shelf" data-detail="shelf"></button>
            </dd>
          </div>`;
    const footer = item.wishlist ? `
          <button type="button" class="btn btn--ghost btn--danger" data-detail="delete"><i data-lucide="trash-2"></i>Delete</button>
          <button type="button" class="btn btn--ghost" data-detail="edit"><i data-lucide="pencil"></i>Edit</button>
          <button type="button" class="btn btn--primary" data-detail="acquire"><i data-lucide="package-plus"></i>Got it</button>` : `
          <button type="button" class="btn btn--ghost btn--danger" data-detail="delete"><i data-lucide="trash-2"></i>Delete</button>
          <button type="button" class="btn btn--primary" data-detail="edit"><i data-lucide="pencil"></i>Edit model</button>`;
    els.detailCard.innerHTML = `
      <div class="detail__media media" data-media>
        ${mediaHTML(item, { eager: true })}
        <span class="badge">${esc(item.diecastBrand)}</span>
        ${visible.length > 1 && idx !== -1 ? `
          <button type="button" class="icon-btn icon-btn--glass detail__nav detail__nav--prev" data-nav="-1" aria-label="Previous model"><i data-lucide="chevron-left"></i></button>
          <button type="button" class="icon-btn icon-btn--glass detail__nav detail__nav--next" data-nav="1" aria-label="Next model"><i data-lucide="chevron-right"></i></button>
          <span class="detail__count">${idx + 1} / ${visible.length}</span>` : ''}
      </div>
      <div class="detail__info">
        <header class="modal__head">
          <div>
            <p class="eyebrow">${item.wishlist ? 'Wishlist · ' : ''}${esc(item.scale)} · ${esc(item.diecastBrand)}</p>
            <h2><span class="card__make">${esc(item.carBrand)}</span> ${esc(item.model)}${item.year ? ` <span class="card__year">${esc(item.year)}</span>` : ''}</h2>
          </div>
          <button type="button" class="icon-btn" data-close aria-label="Close"><i data-lucide="x"></i></button>
        </header>
        <dl class="specs">
          ${rows.map(([k, v, ic]) => `<div><dt><i data-lucide="${ic}"></i>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}
          ${shelfRow}
        </dl>
        <footer class="modal__foot">${footer}
        </footer>
      </div>`;
    hydrateIcons(els.detailCard);
    openModal(els.detailModal);
  }

  async function toggleShelf(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    const shelved = !item.shelved;
    const next = state.items.map((it) => (it.id === id ? { ...it, shelved, updatedAt: Date.now() } : it));
    if (!(await commit(next))) return;
    openDetail(id);
    toast(shelved ? `${item.carBrand} ${item.model} is on the shelf.` : `${item.carBrand} ${item.model} taken off the shelf.`);
  }

  /** Moves a wishlist entry into the collection, dated now so it shows up as the newest addition. */
  async function acquire(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item?.wishlist) return;
    const now = Date.now();
    const next = state.items.map((it) => (it.id === id ? { ...it, wishlist: false, createdAt: now, updatedAt: now } : it));
    if (!(await commit(next))) return;
    closeModal(els.detailModal);
    toast(`${item.carBrand} ${item.model} moved to your collection.`, {
      action: {
        label: 'Undo',
        run: () => {
          // Only undo if it hasn't been edited since, so later changes aren't thrown away
          if (state.items.find((i) => i.id === id)?.updatedAt !== now) return;
          commit(state.items.map((it) => (it.id === id ? item : it)));
        },
      },
    });
  }

  function stepDetail(dir) {
    const idx = visible.findIndex((i) => i.id === detailId);
    if (idx === -1 || visible.length < 2) return;
    openDetail(visible[(idx + dir + visible.length) % visible.length].id);
  }

  /* ─── Delete ───────────────────────────────────────────────── */
  async function deleteItem(id) {
    const item = state.items.find((i) => i.id === id);
    if (!item) return;
    const choice = await ask({
      title: item.wishlist ? 'Remove from wishlist?' : 'Delete this model?',
      body: `${item.diecastBrand} ${item.carBrand} ${item.model} will be removed from your ${item.wishlist ? 'wishlist' : 'collection'}.`,
      icon: 'trash-2',
      actions: [{ label: 'Cancel', value: null }, { label: 'Delete', value: 'delete', variant: 'danger' }],
    });
    if (choice !== 'delete') return;
    const index = state.items.indexOf(item);
    if (!(await commit(state.items.filter((i) => i.id !== id)))) return;
    closeModal(els.detailModal);
    toast(`Deleted ${item.carBrand} ${item.model}.`, {
      type: 'info',
      action: {
        label: 'Undo',
        run: () => {
          if (state.items.some((i) => i.id === id)) return;
          const restored = [...state.items];
          restored.splice(Math.min(index, restored.length), 0, item);
          commit(restored);
        },
      },
    });
  }

  /**
   * Wipes the list being viewed, with a last-chance undo. The collection sits behind three
   * confirmations; the wishlist (nothing owned is lost) behind one.
   */
  async function deleteAll() {
    const wish = isWish();
    const items = sectionItems();
    const others = state.items.filter((i) => Boolean(i.wishlist) !== wish);
    const count = items.length;
    if (!count) return;
    const plural = `${count} model${count === 1 ? '' : 's'}`;
    const restore = () => { if (!state.items.some((i) => Boolean(i.wishlist) === wish)) commit([...items, ...state.items]); };

    if (wish) {
      const choice = await ask({
        title: 'Clear your wishlist?',
        body: `All ${plural} on your wishlist will be removed. Your collection isn’t affected.`,
        icon: 'trash-2',
        actions: [{ label: 'Cancel', value: null }, { label: 'Clear wishlist', value: 'delete', variant: 'danger' }],
      });
      if (choice !== 'delete' || !(await commit(others))) return;
      clearFilters();
      toast(`Cleared ${plural} from your wishlist.`, { type: 'info', duration: 8000, action: { label: 'Undo', run: restore } });
      return;
    }

    const first = await ask({
      title: `Delete all ${plural}?`,
      body: 'Every model and photo in your vault will be removed from this device. Download a backup first if you might want them back.',
      icon: 'trash-2',
      actions: [{ label: 'Cancel', value: null }, { label: 'Download backup', value: 'backup' }, { label: 'Continue', value: 'next', variant: 'danger' }],
    });
    if (first === 'backup') { exportAs('json'); return; }
    if (first !== 'next') return;

    const second = await ask({
      title: 'Are you absolutely sure?',
      body: `This empties the entire vault: ${plural}, including any you added yourself, not just the demos.`,
      icon: 'alert-triangle',
      actions: [{ label: 'Keep my collection', value: null }, { label: 'Yes, delete everything', value: 'next', variant: 'danger' }],
    });
    if (second !== 'next') return;

    const third = await ask({
      title: 'Final check',
      body: 'Type DELETE to confirm.',
      icon: 'bomb',
      confirmText: 'DELETE',
      actions: [{ label: 'Cancel', value: null }, { label: 'Delete all', value: 'delete', variant: 'danger' }],
    });
    if (third !== 'delete') return;

    if (!(await commit(others))) return;
    clearFilters();
    toast(`Deleted all ${plural}.`, {
      type: 'info',
      duration: 8000,
      action: { label: 'Undo', run: restore },
    });
  }

  /* ─── Import / export ──────────────────────────────────────── */
  async function importFile(file) {
    if (!file) return;
    let parsed;
    try {
      parsed = io.parseImport(await io.readText(file));
    } catch (err) {
      toast(err.message, { type: 'error' });
      return;
    }
    const { items, skipped } = parsed;
    const note = skipped ? ` (${skipped} invalid entr${skipped === 1 ? 'y' : 'ies'} skipped)` : '';

    let mode = 'replace';
    if (state.items.length) {
      mode = await ask({
        title: `Import ${items.length} model${items.length === 1 ? '' : 's'}?`,
        body: `Merge adds them to your current ${state.items.length} models (matching entries are updated). Replace swaps your whole collection for the file’s contents.`,
        icon: 'database-backup',
        tone: 'info',
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Replace all', value: 'replace', variant: 'danger' },
          { label: 'Merge', value: 'merge', variant: 'primary' },
        ],
      });
      if (!mode) return;
    }

    const previous = state.items;
    let next = items;
    let message = `Imported ${items.length} models${note}.`;
    if (mode === 'merge') {
      const byId = new Map(previous.map((i) => [i.id, i]));
      let added = 0;
      items.forEach((i) => { if (!byId.has(i.id)) added++; byId.set(i.id, i); });
      next = [...byId.values()];
      message = `Merged: ${added} added, ${items.length - added} updated${note}.`;
    }
    if (await commit(next)) {
      toast(message, previous.length ? { action: { label: 'Undo', run: () => commit(previous) } } : {});
      compactPhotos();
    }
  }

  async function exportAs(kind) {
    if (!state.items.length) { toast('Nothing to export yet — add a model first.', { type: 'info' }); return; }
    let list = [...state.items].sort((a, b) => b.createdAt - a.createdAt);
    if (kind === 'csv') {
      io.exportCSV(list);
      toast(`Exported ${list.length} models as CSV.`);
      return;
    }
    const hosted = list.filter((it) => DV.sync.isHostedPhoto(it.image)).length;
    let failed = 0;
    if (hosted) {
      toast(`Preparing backup — downloading ${hosted} photo${hosted === 1 ? '' : 's'}…`, { type: 'info', duration: 3000 });
      ({ items: list, failed } = await io.inlinePhotos(list, DV.sync.isHostedPhoto));
    }
    io.exportJSON(list);
    if (failed) toast(`Exported ${list.length} models, but ${failed} photo${failed === 1 ? '' : 's'} couldn’t be downloaded — those are saved as links.`, { type: 'error' });
    else toast(`Exported ${list.length} models as JSON.`);
  }

  /* ─── Account & sync status ────────────────────────────────── */
  function setAccountMenu(open) {
    els.accountMenu.classList.toggle('is-open', open);
    els.accountBtn.setAttribute('aria-expanded', String(open));
    if (open) $('[role="menuitem"]', els.accountMenu).focus();
  }

  const ago = (t) => {
    const s = Math.round((Date.now() - t) / 1000);
    if (s < 45) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    return fmtDate(t);
  };

  function syncStatusText(s) {
    const waiting = s.pending ? `${s.pending} change${s.pending === 1 ? '' : 's'} waiting` : '';
    if (s.state === 'syncing') return s.progress || 'Syncing…';
    if (s.state === 'offline') return `Offline${waiting ? ` — ${waiting}` : ''}`;
    if (s.state === 'error') return `Couldn’t sync — retrying${waiting ? ` (${waiting})` : ''}`;
    if (waiting) return waiting;
    return s.lastSynced ? `Synced ${ago(s.lastSynced)}` : 'Synced';
  }

  let accountKey = null; // which account the avatar was last drawn for
  function renderAccount(s) {
    els.accountMenu.hidden = s.state === 'disabled';
    if (s.state === 'disabled') return;
    const signedIn = Boolean(s.user);
    const avatar = $('#accountAvatar');
    els.accountMenu.dataset.sync = s.state;
    els.accountBtn.setAttribute('aria-haspopup', signedIn ? 'menu' : 'false');
    els.accountBtn.title = signedIn ? syncStatusText(s) : 'Sign in with Google to sync your devices';
    $('#accountStatus').textContent = syncStatusText(s);
    if (!signedIn) setAccountMenu(false);

    if ((s.user?.id ?? '') === accountKey) return; // only rebuild the avatar when the account changes
    accountKey = s.user?.id ?? '';
    const meta = s.user?.user_metadata || {};
    const name = meta.full_name || meta.name || s.user?.email || '';
    $('#accountLabel').textContent = signedIn ? (name.split(' ')[0] || 'Account') : 'Sign in';
    $('#accountName').textContent = name;
    $('#accountEmail').textContent = s.user?.email || '';
    avatar.innerHTML = !signedIn ? '<i data-lucide="log-in"></i>'
      : meta.avatar_url ? `<img src="${esc(meta.avatar_url)}" alt="" referrerpolicy="no-referrer">`
      : `<span>${esc(initials(name) || '?')}</span>`;
    hydrateIcons(avatar);
    if (s.welcome) toast(`Signed in as ${name} — syncing your collection.`, { type: 'info' });
  }

  function setExportMenu(open) {
    els.exportMenu.classList.toggle('is-open', open);
    els.exportBtn.setAttribute('aria-expanded', String(open));
    if (open) $('[role="menuitem"]', els.exportMenu).focus();
  }

  /* ─── Filter setters ───────────────────────────────────────── */
  function setFilter(patch) {
    Object.assign(state, patch);
    els.filterDiecast.value = state.diecast;
    els.filterCar.value = state.car;
    renderResults();
  }

  function clearFilters() {
    els.search.value = '';
    setFilter({ search: '', diecast: '', car: '', shelf: '', chase: false });
  }

  /** Switches between the owned collection and the wishlist; filters start fresh on each side. */
  function setSection(section) {
    if (section === state.section) return;
    state.section = section;
    els.search.value = '';
    Object.assign(state, { search: '', diecast: '', car: '', shelf: '', chase: false });
    renderTabs();
    renderFilterOptions();
    renderChips();
    renderResults({ force: true });
  }

  function setView(view) {
    state.view = view;
    $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));
    savePrefs();
    renderResults({ force: true });
  }

  /* ─── Event wiring ─────────────────────────────────────────── */
  function bindEvents() {
    // Header
    $('#addBtn').addEventListener('click', () => openForm());
    $('#importBtn').addEventListener('click', () => els.importInput.click());
    els.importInput.addEventListener('change', () => { importFile(els.importInput.files[0]); els.importInput.value = ''; });

    els.exportBtn.addEventListener('click', (e) => { e.stopPropagation(); setExportMenu(!els.exportMenu.classList.contains('is-open')); });
    els.exportMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-export]');
      if (!item) return;
      setExportMenu(false);
      exportAs(item.dataset.export);
    });
    document.addEventListener('click', (e) => { if (!els.exportMenu.contains(e.target)) setExportMenu(false); });

    els.accountBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!DV.sync.status().user) DV.sync.signIn();
      else setAccountMenu(!els.accountMenu.classList.contains('is-open'));
    });
    els.accountMenu.addEventListener('click', (e) => {
      const item = e.target.closest('[data-account]');
      if (!item) return;
      setAccountMenu(false);
      if (item.dataset.account === 'sync') DV.sync.syncNow();
      else DV.sync.signOut().then(() => toast('Signed out. This device keeps its copy of your collection.', { type: 'info' }));
    });
    document.addEventListener('click', (e) => { if (!els.accountMenu.contains(e.target)) setAccountMenu(false); });

    // Collection / wishlist
    els.tabs.addEventListener('click', (e) => {
      const tab = e.target.closest('[data-section]');
      if (tab) setSection(tab.dataset.section);
    });
    els.tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const tabs = $$('[data-section]', els.tabs);
      const next = tabs[(tabs.indexOf(document.activeElement) + 1) % tabs.length];
      next.focus();
      setSection(next.dataset.section);
    });
    els.stats.addEventListener('click', (e) => {
      const link = e.target.closest('[data-goto]');
      if (!link) return;
      e.preventDefault();
      setSection(link.dataset.goto);
      els.tabs.scrollIntoView({ behavior: reducedMotion.matches ? 'auto' : 'smooth', block: 'start' });
    });

    // Controls
    els.search.addEventListener('input', () => setFilter({ search: els.search.value }));
    els.filterDiecast.addEventListener('change', () => setFilter({ diecast: els.filterDiecast.value }));
    els.filterCar.addEventListener('change', () => setFilter({ car: els.filterCar.value }));
    els.sort.addEventListener('change', () => { state.sort = els.sort.value; savePrefs(); renderResults(); });
    $$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
    els.clearFilters.addEventListener('click', clearFilters);
    els.deleteAll.addEventListener('click', deleteAll);

    els.chips.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      const { chipType: type, chipValue: value } = chip.dataset;
      if (type === 'all') setFilter({ diecast: '', car: '', shelf: '', chase: false });
      else if (type === 'chase') setFilter({ chase: !state.chase });
      else if (type === 'shelf') setFilter({ shelf: state.shelf === value ? '' : value });
      else if (type === 'diecast') setFilter({ diecast: state.diecast === value ? '' : value });
      else setFilter({ car: state.car === value ? '' : value });
    });

    // Cards
    els.grid.addEventListener('click', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const action = e.target.closest('[data-action]')?.dataset.action;
      const id = card.dataset.id;
      if (action === 'edit') openForm(state.items.find((i) => i.id === id));
      else if (action === 'delete') deleteItem(id);
      else if (action === 'acquire') acquire(id);
      else openDetail(id);
    });
    els.grid.addEventListener('keydown', (e) => {
      if (!e.target.classList.contains('card')) return;
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(e.target.dataset.id); }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteItem(e.target.dataset.id); }
    });
    // Cursor-follow highlight
    els.grid.addEventListener('pointermove', (e) => {
      const card = e.target.closest('.card');
      if (!card) return;
      const r = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${e.clientX - r.left}px`);
      card.style.setProperty('--my', `${e.clientY - r.top}px`);
    });

    // Empty state
    els.empty.addEventListener('click', (e) => {
      const act = e.target.closest('[data-empty]')?.dataset.empty;
      if (act === 'add') openForm();
      if (act === 'import') els.importInput.click();
      if (act === 'clear') clearFilters();
      if (act === 'wishlist') setSection('wishlist');
      if (act === 'demo') commit(DV.seed()).then((ok) => ok && toast('Demo collection loaded.'));
    });

    // Detail modal
    els.detailCard.addEventListener('click', (e) => {
      const nav = e.target.closest('[data-nav]');
      if (nav) { stepDetail(Number(nav.dataset.nav)); return; }
      const act = e.target.closest('[data-detail]')?.dataset.detail;
      if (act === 'edit') openForm(state.items.find((i) => i.id === detailId));
      if (act === 'delete') deleteItem(detailId);
      if (act === 'shelf') toggleShelf(detailId);
      if (act === 'acquire') acquire(detailId);
    });
    els.detailModal.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight') stepDetail(1);
      if (e.key === 'ArrowLeft') stepDetail(-1);
    });

    // Form
    els.form.addEventListener('submit', submitForm);
    form.diecast.addEventListener('change', () => toggleCustom(form.diecast, form.diecastCustom));
    form.car.addEventListener('change', () => { toggleCustom(form.car, form.carCustom); if (!form.photo) setPhoto(''); });
    form.scale.addEventListener('change', () => toggleCustom(form.scale, form.scaleCustom));
    form.series.addEventListener('change', () => toggleCustom(form.series, form.seriesCustom));
    els.form.addEventListener('input', (e) => {
      const field = e.target.closest('.field.has-error');
      if (field) { field.classList.remove('has-error'); $('.field__error', field).textContent = ''; }
    });
    els.form.addEventListener('change', (e) => {
      const field = e.target.closest('.field.has-error');
      if (field) { field.classList.remove('has-error'); $('.field__error', field).textContent = ''; }
    });

    $$('[data-photo-tab]', els.form).forEach((b) => b.addEventListener('click', () => setPhotoTab(b.dataset.photoTab)));
    form.file.addEventListener('change', () => handleImageFile(form.file.files[0]));
    ['dragenter', 'dragover'].forEach((t) => form.dropzone.addEventListener(t, (e) => { e.preventDefault(); form.dropzone.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach((t) => form.dropzone.addEventListener(t, () => form.dropzone.classList.remove('is-drag')));
    form.dropzone.addEventListener('drop', (e) => { e.preventDefault(); handleImageFile(e.dataTransfer.files[0]); });

    let urlTimer;
    form.url.addEventListener('input', () => {
      clearTimeout(urlTimer);
      urlTimer = setTimeout(() => {
        const v = form.url.value.trim();
        setPhoto(/^https?:\/\/\S+$/i.test(v) ? v : '');
      }, 250);
    });
    form.photoClear.addEventListener('click', () => { form.url.value = ''; setPhoto(''); });

    // Images: fade in on load, fall back to the placeholder on error (load/error don't bubble — use capture)
    document.addEventListener('load', (e) => {
      if (e.target.tagName === 'IMG') e.target.closest('[data-media]')?.classList.add('is-loaded');
    }, true);
    document.addEventListener('error', (e) => {
      if (e.target.tagName !== 'IMG') return;
      const media = e.target.closest('[data-media]');
      if (!media) return;
      media.classList.add('is-broken');
      e.target.remove();
    }, true);

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && els.exportMenu.classList.contains('is-open')) { setExportMenu(false); els.exportBtn.focus(); return; }
      if (e.key === 'Escape' && els.accountMenu.classList.contains('is-open')) { setAccountMenu(false); els.accountBtn.focus(); return; }
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (typing || $('dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); els.search.focus(); els.search.select(); }
      if (e.key.toLowerCase() === 'n') { e.preventDefault(); openForm(); }
      if (e.key.toLowerCase() === 'w') { e.preventDefault(); setSection(isWish() ? 'collection' : 'wishlist'); }
    });

    // Background spotlight follows the cursor (pointer devices only)
    if (matchMedia('(hover: hover)').matches && !reducedMotion.matches) {
      const root = document.documentElement;
      let frame = 0;
      window.addEventListener('pointermove', (e) => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          root.style.setProperty('--px', `${e.clientX}px`);
          root.style.setProperty('--py', `${e.clientY}px`);
          root.style.setProperty('--spot', '1');
        });
      }, { passive: true });
      document.addEventListener('pointerleave', () => root.style.setProperty('--spot', '0'));
    }

    // Sticky header state
    const onScroll = () => els.topbar.classList.toggle('is-scrolled', window.scrollY > 8);
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();

    // Keep multiple tabs in sync
    store.onExternalChange(async () => {
      state.items = (await store.load()) ?? [];
      renderAll();
    });
  }

  /* ─── Boot ─────────────────────────────────────────────────── */
  async function init() {
    let items = null;
    try {
      items = await store.load();
    } catch {
      /* unreadable storage — start from the demo set rather than a blank screen */
    }
    if (items === null) {
      items = DV.seed();
      DV.sync.rememberDemo(items);
      store.save(items);
    }
    state.items = items;

    els.sort.innerHTML = C.SORTS.map((s) => `<option value="${s.value}">${esc(s.label)}</option>`).join('');
    els.sort.value = state.sort;
    $$('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));

    hydrateIcons();
    bindEvents();
    renderAll();
    requestAnimationFrame(() => document.body.classList.add('is-ready'));
    compactPhotos();
    DV.sync.init({ getItems: () => state.items, apply: applyRemote, ask, toast, onStatus: renderAccount });
  }

  init();
})();
