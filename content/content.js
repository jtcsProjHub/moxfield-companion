/* Content script for moxfield.com: marks each card in a deck with how many copies are free. */
/* global browser */
(() => {
  if (window.__mcCompanion) return;
  window.__mcCompanion = true;

  const STATUS_TEXT = {
    ok: 'Free real copies cover this deck',
    playtest: 'Enough free copies only if you use playtest copies',
    short: 'Some copies are free, but not enough for this deck',
    used: 'All your copies are in other decks',
    missing: 'Not in your collection',
    proxy: 'Marked as a proxy in this deck (not counted)',
    basic: 'Basic land',
    unknown: 'Card not found in the local Scryfall data',
  };

  let deckId = null;
  let view = null;
  let highlight = true;
  let lastRefresh = 0;
  let refreshTimer = null;
  let decorateTimer = null;
  let toastTimer = null;

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

  function send(msg) {
    return browser.runtime.sendMessage(msg).then((r) => {
      if (!r) return null;
      if (!r.ok) throw new Error(r.error);
      return r.result;
    });
  }

  function currentDeckId() {
    const m = location.pathname.match(/^\/decks\/([A-Za-z0-9_-]{10,})/);
    return m ? m[1] : null;
  }

  /** The card name shown by a deck element, in any Moxfield view. */
  function domName(el) {
    const link = el.querySelector('a[href^="/cards/"]');
    if (link && link.textContent.trim()) return link.textContent.trim();
    const ph = el.querySelector('.decklist-card-phantomsearch');
    if (ph && ph.textContent.trim()) return ph.textContent.trim();
    const img = el.querySelector('img[alt]');
    if (img && img.alt && !/^(front|back|transform)$/i.test(img.alt)) return img.alt;
    return null;
  }

  function entryFor(el) {
    if (!view) return null;
    const hash = el.getAttribute('data-hash');
    const board = (el.getAttribute('data-row-key') || '').split('-')[0];
    let info = (board && view.entries[`${board}|${hash}`]) || view.entries[hash];
    if (!info) {
      const n = domName(el);
      if (n) info = view.byName[norm(n)] || null;
    }
    return info;
  }

  /** "free/real" plus "+NP" for playtest copies. Example: 2/1+1P = 2 free of 1 real and 1 playtest. */
  function badgeText(info) {
    const owned = info.proxy ? `${info.owned}+${info.proxy}P` : `${info.owned}`;
    switch (info.status) {
      case 'ok':
      case 'playtest':
      case 'short':
      case 'used': return `${info.free}/${owned}`;
      case 'missing': return '0';
      case 'proxy': return 'proxy';
      case 'unknown': return '?';
      default: return '';
    }
  }

  function tooltip(info) {
    const lines = [info.name, STATUS_TEXT[info.status] || ''];
    if (info.owned != null && info.status !== 'basic') {
      if (info.proxy) {
        lines.push(`Owned ${info.owned} real + ${info.proxy} playtest · this deck uses ${info.need}`);
        lines.push(`Free for this deck: ${info.realFree} real for certain, ${info.free} counting playtest copies`);
      } else {
        lines.push(`Owned ${info.owned} · free for this deck ${info.free} · this deck uses ${info.need}`);
      }
      if (info.uses && info.uses.length) lines.push('Also in: ' + info.uses.map((u) => `${u.name} ×${u.q}`).join(', '));
    }
    lines.push('Click the badge to see this card and similar cards in the sidebar.');
    return lines.join('\n');
  }

  function decorate(el) {
    const info = entryFor(el);
    let badge = el.querySelector(':scope .mc-badge');
    if (!info || !highlight) {
      if (badge) badge.remove();
      el.removeAttribute('data-mc');
      if (!info && view) scheduleRefresh();
      return;
    }
    const text = badgeText(info);
    const tip = tooltip(info);
    if (el.getAttribute('data-mc') === info.status && badge && badge.textContent === text && badge.title === tip) return;
    el.setAttribute('data-mc', info.status);
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'mc-badge';
      badge.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectCard(badge.dataset.name);
      }, true);
      const link = el.querySelector('a.table-deck-row-link, a[href^="/cards/"]');
      const isRow = el.tagName === 'LI' || el.matches('[data-testid="deck-view-table-row"]:not(.decklist-card)');
      if (isRow && link && link.parentElement) {
        badge.classList.add('mc-inline');
        link.parentElement.appendChild(badge);
      } else {
        badge.classList.add('mc-overlay');
        if (getComputedStyle(el).position === 'static') el.style.position = 'relative';
        el.appendChild(badge);
      }
    }
    badge.dataset.name = info.name;
    badge.dataset.status = info.status;
    badge.textContent = text;
    badge.title = tip;
    badge.style.display = text ? '' : 'none';
  }

  function decorateAll() {
    if (!deckId) return;
    for (const el of document.querySelectorAll('[data-hash]')) decorate(el);
  }

  function scheduleDecorate() {
    clearTimeout(decorateTimer);
    decorateTimer = setTimeout(decorateAll, 250);
  }

  /** New cards appeared that the cached deck does not know: refetch, at most every 8 s. */
  function scheduleRefresh() {
    if (refreshTimer) return;
    const wait = Math.max(0, lastRefresh + 8000 - Date.now());
    refreshTimer = setTimeout(() => { refreshTimer = null; refresh(true); }, wait);
  }

  async function refresh(force) {
    deckId = currentDeckId();
    if (!deckId) { view = null; return; }
    lastRefresh = Date.now();
    try {
      const settings = await send({ type: 'getSettings' });
      highlight = settings ? settings.highlight !== false : true;
      view = await send({ type: 'deckView', deckId, force: !!force });
      decorateAll();
    } catch (e) {
      console.warn('[Collection Companion]', e.message);
    }
  }

  async function selectCard(name) {
    if (!name) return;
    try {
      const r = await send({ type: 'select', name, deckId });
      if (r && r.ok && !r.sidebarOpen) toast('Open the Collection Companion sidebar (toolbar button or Alt+Shift+M) to see this card.');
      if (r && !r.ok) toast(`"${name}" is not in the local card data.`);
    } catch (e) {
      toast(e.message);
    }
  }

  function toast(text) {
    let t = document.getElementById('mc-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'mc-toast';
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.add('mc-show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('mc-show'), 4500);
  }

  // Alt+click on any card in a deck selects it.
  document.addEventListener('click', (ev) => {
    if (!ev.altKey || !deckId) return;
    const el = ev.target.closest('[data-hash]');
    if (!el) return;
    const info = entryFor(el);
    const name = (info && info.name) || domName(el);
    if (!name) return;
    ev.preventDefault();
    ev.stopPropagation();
    selectCard(name);
  }, true);

  new MutationObserver(() => scheduleDecorate()).observe(document.documentElement, { childList: true, subtree: true });

  // Moxfield is a single-page app: watch for route changes.
  let lastPath = location.pathname;
  setInterval(() => {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      view = null;
      refresh(false);
    }
  }, 800);

  browser.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'userChanged') { refresh(false); return; }
    if (msg.type === 'pageFetch') {
      // Runs the request as the page would (used when a direct request is refused).
      const f = (typeof content !== 'undefined' && content.fetch) ? content.fetch.bind(content) : fetch;
      return f(msg.url, { credentials: 'include' }).then(async (r) => ({ ok: r.ok, status: r.status, data: r.ok ? await r.json() : null }))
        .catch((e) => ({ ok: false, error: e.message }));
    }
    if (msg.type === 'resolveTarget') {
      let el = null;
      try { el = browser.menus.getTargetElement(msg.targetElementId); } catch (e) { /* ignore */ }
      let name = null;
      const holder = el && el.closest('[data-hash]');
      if (holder) { const info = entryFor(holder); name = (info && info.name) || domName(holder); }
      if (!name && el) {
        if (el.tagName === 'IMG' && el.alt) name = el.alt;
        else if (el.closest('a')) name = el.closest('a').textContent.trim();
      }
      if (!name) name = msg.linkText || null;
      return Promise.resolve({ name, deckId });
    }
    return undefined;
  });

  refresh(false);
})();
