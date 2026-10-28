/* Small DOM helpers shared by the sidebar and the manager page. */
/* global browser */
(function (g) {
  const UI = (g.UI = {});

  /** h('div.class#id', {attrs, on: {click}}, ...children) */
  UI.h = function (sel, props, ...kids) {
    const m = sel.match(/^([a-z0-9]+)?((?:[.#][\w-]+)*)$/i);
    const el = document.createElement((m && m[1]) || 'div');
    if (m && m[2]) for (const part of m[2].match(/[.#][\w-]+/g)) {
      if (part[0] === '.') el.classList.add(part.slice(1)); else el.id = part.slice(1);
    }
    if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) { kids.unshift(props); props = null; }
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === 'on') for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (k) => {
      if (k == null || k === false) return;
      if (Array.isArray(k)) k.forEach(add);
      else el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    };
    kids.forEach(add);
    return el;
  };

  UI.clear = (el) => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  UI.send = async function (type, data) {
    const r = await browser.runtime.sendMessage(Object.assign({ type }, data || {}));
    if (!r) throw new Error('No answer from the background page.');
    if (!r.ok) throw new Error(r.error);
    return r.result;
  };

  UI.smallImg = (url) => (url ? url.replace('/normal/', '/small/') : '');

  /** Mana cost string to compact text, for example {2}{W}{U} -> 2WU. */
  UI.cost = (c) => (c || '').replace(/\{(\w+)(\/(\w))?\}/g, (_, a, __, b) => (b ? `(${a}/${b})` : a));

  UI.ciDots = function (ci) {
    const h = UI.h;
    if (!ci || !ci.length) return h('span.ci', h('i.pip.pip-C'));
    return h('span.ci', ci.map((c) => h(`i.pip.pip-${c}`)));
  };

  /**
   * Availability pill. Real copies first. "+1P" marks playtest copies.
   * Green: a real copy is free. Blue: only playtest copies are free. Orange: none are free.
   */
  UI.availPill = function (c) {
    const h = UI.h;
    const proxy = c.proxy || 0;
    const owned = proxy ? `${c.owned}+${proxy}P` : `${c.owned}`;
    const usesText = (c.uses || []).map((u) => `${u.name} ×${u.q}`).join(', ');
    if (c.basic) return h('span.pill.pill-basic', 'basic');
    if (!c.owned && !proxy) return h('span.pill.pill-missing', { title: 'Not in your collection' }, 'not owned');
    const title = `${c.owned} real${proxy ? ` and ${proxy} playtest` : ''} ${c.owned + proxy === 1 ? 'copy' : 'copies'}. ` +
      `Free: ${c.realFree} real for certain${proxy ? `, ${c.free} counting playtest copies` : ''}.` + (usesText ? ` In: ${usesText}` : '');
    if (c.realFree > 0) return h('span.pill.pill-ok', { title }, `${c.free}/${owned} free`);
    if (c.free > 0) return h('span.pill.pill-playtest', { title }, `${c.free}/${owned} free (playtest)`);
    return h('span.pill.pill-used', { title }, `0/${owned} free`);
  };

  /** One line for a card: thumbnail, name, cost, availability, details. */
  UI.cardRow = function (c, opts = {}) {
    const h = UI.h;
    const pill = UI.availPill(c);
    const row = h('div.card-row', { dataset: { oid: c.oid } },
      h('img.thumb', { src: UI.smallImg(c.img), loading: 'lazy', alt: '' }),
      h('div.card-main',
        h('div.card-line1',
          h('a.card-name', { href: '#', title: 'Show this card', on: { click: (e) => { e.preventDefault(); opts.onSelect && opts.onSelect(c); } } }, c.name),
          h('span.cost', UI.cost(c.cost)),
          pill),
        opts.why && c.why && c.why.length ? h('div.why', c.why.join(' · ')) : null,
        opts.tags && c.shared && c.shared.length
          ? h('div.chips', c.shared.map((t) => h('a.chip.chip-small', { href: '#', title: 'Explore this tag', on: { click: (e) => { e.preventDefault(); opts.onTag && opts.onTag(t); } } }, t.label)))
          : null));
    UI.attachPreview(row.querySelector('img.thumb'), c.img);
    return row;
  };

  /** Large image preview on hover. */
  let preview = null;
  UI.attachPreview = function (img, url) {
    if (!url) return;
    img.addEventListener('mouseenter', () => {
      if (!preview) { preview = UI.h('img#preview'); document.body.appendChild(preview); }
      preview.src = url;
      const r = img.getBoundingClientRect();
      const top = Math.min(window.innerHeight - 330, Math.max(4, r.top - 120));
      preview.style.top = `${top}px`;
      preview.style.display = 'block';
    });
    img.addEventListener('mouseleave', () => { if (preview) preview.style.display = 'none'; });
  };

  UI.fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'never');
})(typeof globalThis !== 'undefined' ? globalThis : this);
