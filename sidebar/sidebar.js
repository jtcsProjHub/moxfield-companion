/* Sidebar: card details and similar cards, deck status, and tag exploration for the active tab. */
/* global UI, MC, browser */
const { h, clear, send } = UI;

const LS_KEY = 'mc-sidebar-opts';
const saved = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch (e) { return {}; } })();

const state = {
  windowId: null,
  tabId: null,
  context: null,       // deck open in the active tab: { publicId, name, format, ci }
  deckView: null,
  selection: null,     // { oid, deckId }
  tab: 'card',
  history: [],
  sim: Object.assign({ pool: 'owned', colors: 'deck', legal: true, cmcDelta: '', sameType: false, spectrum: 0.5 }, saved.sim),
  ex: Object.assign({ pool: 'owned', colors: 'deck', custom: [], legal: false, type: '', mode: 'functions', query: '', flat: false }, saved.ex),
  exPath: [],          // drill-down stack of tag ids
  exTag: null,         // tag whose cards are listed
};

function persist() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ sim: state.sim, ex: state.ex })); } catch (e) { /* ignore */ }
}

const $ = (id) => document.getElementById(id);

/* ---------------------------------------------------------------- shared */

function legalKey() {
  const f = state.context && state.context.format;
  return (f && MC.FORMAT_TO_LEGALITY[f]) || null;
}

function deckCI() {
  return state.context && state.context.ci ? state.context.ci : null;
}

function errorBox(e) {
  return h('div.callout.error', String(e.message || e));
}

function selectCard(oid, push = true) {
  if (push && state.selection && state.selection.oid !== oid) state.history.push(state.selection.oid);
  state.selection = { oid, deckId: state.context && state.context.publicId };
  switchTab('card');
  renderCard();
}

function exploreTag(tag) {
  state.exPath = [];
  state.exTag = tag.id;
  switchTab('explore');
  renderExplore();
}

function switchTab(name) {
  state.tab = name;
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of ['card', 'deck', 'explore']) $(`tab-${s}`).hidden = s !== name;
}

/* ---------------------------------------------------------------- status */

async function renderStatus() {
  try {
    const st = await send('status');
    const s = st.stats;
    const parts = [];
    parts.push(s.cards ? `${s.cards.toLocaleString()} cards` : 'no card data');
    parts.push(`${s.ownedUnique.toLocaleString()} owned${s.playtestUnique ? ` (${s.playtestUnique.toLocaleString()} with playtest copies)` : ''}`);
    parts.push(`${s.decksCounted}/${s.decks} decks counted`);
    $('status').textContent = parts.join(' · ');
    state.hasCards = s.cards > 0;
    state.hasCollection = s.ownedUnique > 0;
    showJob(st.job);
  } catch (e) {
    $('status').textContent = e.message;
  }
}

function showJob(job) {
  $('job').hidden = !job;
  if (!job) return;
  $('job-text').textContent = `${job.name}: ${job.text || ''}`;
  const bar = document.querySelector('#job .progress');
  bar.classList.toggle('indeterminate', job.pct == null);
  bar.firstElementChild.style.width = job.pct == null ? '' : `${Math.round(job.pct * 100)}%`;
}

function setupNotice(container) {
  if (!state.hasCards) {
    container.appendChild(h('div.callout.warn', 'No Scryfall card data yet. ',
      h('a', { href: '#', on: { click: (e) => { e.preventDefault(); send('openManager'); } } }, 'Open Manage data'),
      ' to download it.'));
    return true;
  }
  if (!state.hasCollection) {
    container.appendChild(h('div.callout', 'No collection loaded, so every card shows as not owned. ',
      h('a', { href: '#', on: { click: (e) => { e.preventDefault(); send('openManager'); } } }, 'Import your collection'), '.'));
  }
  return false;
}

/* ---------------------------------------------------------------- card tab */

function searchBox() {
  const input = h('input', { type: 'search', placeholder: 'Find a card by name…' });
  const list = h('div.suggest', { hidden: true });
  let items = [];
  let active = -1;
  let timer = null;
  const pick = (it) => { list.hidden = true; input.value = ''; selectCard(it.oid); };
  const draw = () => {
    clear(list);
    list.hidden = !items.length;
    items.forEach((it, i) => list.appendChild(h(`div${i === active ? '.active' : ''}`, { on: { mousedown: (e) => { e.preventDefault(); pick(it); } } },
      h('span', it.name), h('span.muted.small', it.owned || it.proxy ? `${it.owned}${it.proxy ? `+${it.proxy}P` : ''} owned` : ''))));
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => { items = input.value.trim().length >= 2 ? await send('searchNames', { q: input.value }) : []; active = -1; draw(); }, 150);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(items.length - 1, active + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter' && items.length) pick(items[Math.max(0, active)]);
    else if (e.key === 'Escape') { list.hidden = true; }
  });
  input.addEventListener('blur', () => setTimeout(() => { list.hidden = true; }, 150));
  return h('div.search-wrap', input, list);
}

function segmented(options, value, onChange) {
  const wrap = h('span.seg');
  for (const [v, label, title] of options) {
    wrap.appendChild(h(`button${v === value ? '.on' : ''}`, { title: title || '', on: { click: () => onChange(v) } }, label));
  }
  return wrap;
}

let simTimer = null;
function simChanged(patch) {
  Object.assign(state.sim, patch);
  persist();
  clearTimeout(simTimer);
  simTimer = setTimeout(() => renderCard(), 120);
}

function simControls(card) {
  const s = state.sim;
  const lk = legalKey();
  return h('div.controls',
    h('span', 'Look in'),
    segmented([['owned', 'My cards', 'Every card in your collection'], ['available', 'Free copies', 'Only cards with copies not used in other decks'], ['all', 'All cards', 'Every card, owned or not']], s.pool, (v) => simChanged({ pool: v })),
    h('span', 'Colors'),
    segmented([
      ['deck', 'Deck', deckCI() ? `Within this deck's colors (${deckCI().join('') || 'colorless'})` : 'No deck open: uses the card colors'],
      ['card', 'Card', `Within ${card.name}'s color identity`],
      ['any', 'Any', 'Ignore color identity'],
    ], s.colors, (v) => simChanged({ colors: v })),
    h('span', 'Filters'),
    h('div.row',
      h('label.inline', { title: lk ? `Only cards legal in ${state.context.format}` : 'Open a deck with a format to use this' },
        h('input', { type: 'checkbox', checked: !!s.legal && !!lk, disabled: !lk, on: { change: (e) => simChanged({ legal: e.target.checked }) } }), lk ? `Legal in ${state.context.format}` : 'Format legal'),
      h('label.inline', { title: 'Share at least one card type (creature, instant, …)' },
        h('input', { type: 'checkbox', checked: !!s.sameType, on: { change: (e) => simChanged({ sameType: e.target.checked }) } }), 'Same type'),
      h('label.inline', 'MV ±',
        (() => {
          const sel = h('select', { on: { change: (e) => simChanged({ cmcDelta: e.target.value }) } },
            [['', 'any'], ['0', '0'], ['1', '1'], ['2', '2']].map(([v, t]) => h('option', { value: v }, t)));
          sel.value = s.cmcDelta;
          return sel;
        })())),
    h('span', 'Match on'),
    h('div.spectrum', h('span', 'Wording'),
      h('input', { type: 'range', min: 0, max: 1, step: 0.05, value: String(s.spectrum), title: 'Left: same mechanics and wording. Right: same job or role, by Tagger tags.', on: { change: (e) => simChanged({ spectrum: Number(e.target.value) }) } }),
      h('span', 'Role')));
}

const GROUPS = [
  ['reprint', 'Same card, different name', 'Same rules text, cost and stats.'],
  ['better', 'Likely strictly better', 'Same effect with an equal or better cost, stats or numbers. Check the text: this is a heuristic.'],
  ['worse', 'Likely strictly worse', 'Same effect with a worse cost, stats or numbers.'],
  ['variant', 'Close variants', 'Same effect with a different color, creature type, speed or trade-off.'],
  ['role', 'Similar role', 'Ranked by shared wording and shared Tagger tags.'],
];

async function renderCard() {
  const root = clear($('tab-card'));
  root.appendChild(searchBox());
  if (setupNotice(root)) return;
  if (!state.selection) {
    root.appendChild(h('div.empty',
      h('p', 'Pick a card to see how many copies are free and which of your cards can stand in for it.'),
      h('p.small', 'On a Moxfield deck: click a card\'s colored badge, Alt+click the card, or right-click it and choose "Collection Companion: show this card". You can also search above.')));
    return;
  }
  const deckId = state.context && state.context.publicId;
  let card;
  try {
    card = await send('cardInfo', { oid: state.selection.oid, deckId });
  } catch (e) { root.appendChild(errorBox(e)); return; }
  if (!card) { root.appendChild(h('div.empty', 'That card is not in the local data.')); return; }

  const back = state.history.length
    ? h('a.small', { href: '#', on: { click: (e) => { e.preventDefault(); selectCard(state.history.pop(), false); } } }, '← back')
    : null;
  const img = h('img', { src: card.img, alt: card.name });
  root.appendChild(h('div.card-head', img,
    h('div', back, h('h2', h('a', { href: card.uri, target: '_blank', title: 'Open on Scryfall' }, card.name)),
      h('div.row.small', h('span.cost', UI.cost(card.cost)), UI.ciDots(card.ci), h('span.muted', card.type)),
      h('div.card-text', card.text))));

  // Availability
  const av = h('div.avail');
  if (card.basic) av.appendChild(h('div', 'Basic land: not tracked.'));
  else if (!card.owned && !card.proxy) av.appendChild(h('div', h('span.pill.pill-missing', 'not owned'), ' You have no copies.'));
  else {
    const ownedText = card.proxy
      ? `You own ${card.owned} real and ${card.proxy} playtest ${card.proxy === 1 ? 'copy' : 'copies'}.`
      : `You own ${card.owned}.`;
    const usedText = ` ${card.used} ${card.used === 1 ? 'is' : 'are'} in other decks${deckId ? ' (this deck not counted)' : ''}.`;
    av.appendChild(h('div', UI.availPill(card), ` ${ownedText}${usedText}`));
    if (card.proxy && card.used) {
      av.appendChild(h('div.small.muted', `Moxfield does not record which copy a deck holds, so other decks are assumed to hold real copies first. ${card.realFree} real ${card.realFree === 1 ? 'copy is' : 'copies are'} free for certain.`));
    }
    if (card.uses.length) av.appendChild(h('ul.small', card.uses.map((u) => h('li', h('a', { href: `https://moxfield.com/decks/${u.id}`, target: '_blank' }, u.name), ` ×${u.q}`, h('span.muted', ` (${u.format})`)))));
  }
  root.appendChild(av);

  // Tags
  if (card.tags.length) {
    const fn = card.tags.filter((t) => !t.meta);
    const meta = card.tags.filter((t) => t.meta);
    const chip = (t) => h(`a.chip${t.meta ? '.meta' : ''}`, {
      href: '#', title: `${t.desc || t.label}\n${t.path.length ? 'Under: ' + t.path.join(' › ') + '\n' : ''}${t.total} cards in all. Click to see your cards with this tag.`,
      on: { click: (e) => { e.preventDefault(); exploreTag(t); } },
    }, t.label);
    root.appendChild(h('div', h('div.small.muted', 'Tagger tags (most specific first). Click one to see your cards with it:'),
      h('div.chips', fn.map(chip)),
      meta.length ? h('details.small', h('summary.muted', `${meta.length} structural tags`), h('div.chips', meta.map(chip))) : null));
  }

  root.appendChild(simControls(card));
  const results = h('div', h('div.empty', 'Searching…'));
  root.appendChild(results);

  const s = state.sim;
  const ci = s.colors === 'any' ? null : s.colors === 'deck' && deckCI() ? deckCI() : card.ci;
  const exclude = state.deckView ? [...new Set(Object.values(state.deckView.entries).filter((x) => x.oid && x.board !== 'maybeboard').map((x) => x.oid))] : [];
  let r;
  try {
    r = await send('similar', {
      oid: card.oid,
      opts: {
        pool: s.pool, ci, legal: s.legal ? legalKey() : null, cmcDelta: s.cmcDelta === '' ? null : Number(s.cmcDelta),
        sameType: s.sameType, spectrum: s.spectrum, exclude, deckId, limit: 40,
      },
    });
  } catch (e) { clear(results).appendChild(errorBox(e)); return; }
  clear(results);
  const opts = { why: true, tags: true, onSelect: (c) => selectCard(c.oid), onTag: (t) => exploreTag(t) };
  let any = false;
  for (const [key, title, help] of GROUPS) {
    const arr = r.groups[key] || [];
    if (!arr.length) continue;
    any = true;
    results.appendChild(h('h3', { title: help }, title, h('span.count', String(arr.length))));
    for (const c of arr) results.appendChild(UI.cardRow(c, opts));
  }
  if (!any) results.appendChild(h('div.empty', 'Nothing similar matches these filters. Try "All cards", "Any" colors, or move the slider toward Role.'));
  if (exclude.length) results.appendChild(h('div.small.muted', { style: { marginTop: '8px' } }, `Cards already in this deck are left out. ${r.considered.toLocaleString()} candidates checked.`));
}

/* ---------------------------------------------------------------- deck tab */

async function renderDeck() {
  const root = clear($('tab-deck'));
  if (setupNotice(root)) return;
  if (!state.context) {
    root.appendChild(h('div.empty', 'Open a deck on moxfield.com in this window to see which cards are free, in other decks, or missing.'));
    return;
  }
  if (!state.deckView) {
    try { state.deckView = await send('deckSummary', { deckId: state.context.publicId }); } catch (e) { root.appendChild(errorBox(e)); return; }
  }
  const v = state.deckView;
  root.appendChild(h('div.row', h('strong', v.deck.name), UI.ciDots(v.deck.ci), h('span.muted', v.deck.format),
    h('span.spacer'), h('button', { on: { click: async () => { state.deckView = await send('deckSummary', { deckId: state.context.publicId, force: true }); renderDeck(); } } }, 'Refresh')));
  if (v.deck.author) root.appendChild(h('div.small.muted', `by ${v.deck.author}`));
  const sm = v.summary;
  root.appendChild(h('div.summary-pills',
    h('span.pill.pill-ok', `${sm.ok} free`),
    sm.playtest ? h('span.pill.pill-playtest', { title: 'Covered only when you use playtest copies' }, `${sm.playtest} playtest`) : null,
    h('span.pill.pill-short', `${sm.short} short`),
    h('span.pill.pill-used', `${sm.used} in other decks`), h('span.pill.pill-missing', `${sm.missing} missing`),
    sm.unknown ? h('span.pill.pill-unknown', `${sm.unknown} unknown`) : null));

  const seen = new Set();
  const rows = [];
  for (const [k, x] of Object.entries(v.entries)) {
    if (!k.includes('|') || !x.oid) continue;
    const key = `${x.board}|${x.oid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(x);
  }
  const section = (title, help, list) => {
    if (!list.length) return;
    root.appendChild(h('h3', { title: help }, title, h('span.count', String(list.length))));
    for (const x of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const pill = x.status === 'missing' ? h('span.pill.pill-missing', 'missing') : UI.availPill(x);
      root.appendChild(h('div.card-row',
        h('div.card-main',
          h('div.card-line1', h('a.card-name', { href: '#', on: { click: (e) => { e.preventDefault(); selectCard(x.oid); } } }, x.name), pill,
            x.need > 1 ? h('span.muted.small', `needs ${x.need}`) : null),
          x.uses && x.uses.length ? h('div.why', 'In: ' + x.uses.map((u) => `${u.name} ×${u.q}`).join(', ')) : null),
        h('button.small', { title: 'Show similar cards you own', on: { click: () => selectCard(x.oid) } }, 'Alternatives')));
    }
  };
  const main = rows.filter((x) => x.board !== 'maybeboard');
  const maybe = rows.filter((x) => x.board === 'maybeboard');
  section('Missing', 'Not in your collection', main.filter((x) => x.status === 'missing'));
  section('All copies in other decks', 'You own it, but other decks use every copy', main.filter((x) => x.status === 'used'));
  section('Not enough free copies', 'Some copies are free, but fewer than this deck needs', main.filter((x) => x.status === 'short'));
  section('Covered by playtest copies only', 'Free copies exist only if you use playtest copies', main.filter((x) => x.status === 'playtest'));
  section('Considering: not available', 'Maybeboard cards you lack or have no free copy of', maybe.filter((x) => ['missing', 'used', 'short'].includes(x.status)));
  section('Considering: playtest copies only', 'Maybeboard cards with only playtest copies free', maybe.filter((x) => x.status === 'playtest'));
  if (!main.some((x) => ['missing', 'used', 'short', 'playtest'].includes(x.status))) root.appendChild(h('div.empty', 'Every card in this deck has a free real copy.'));
}

/* ---------------------------------------------------------------- explore tab */

let exTimer = null;
function exChanged(patch, now) {
  Object.assign(state.ex, patch);
  persist();
  clearTimeout(exTimer);
  exTimer = setTimeout(() => renderExplore(), now ? 0 : 200);
}

function exPoolOpts() {
  const e = state.ex;
  let ci = null;
  if (e.colors === 'deck') ci = deckCI();
  else if (e.colors === 'custom') ci = e.custom;
  return { pool: e.pool, ci, legal: e.legal ? legalKey() : null, type: e.type || null, deckId: state.context && state.context.publicId };
}

function exploreControls() {
  const e = state.ex;
  const colorPick = h('span.colors-pick', ['W', 'U', 'B', 'R', 'G', 'C'].map((c) => h(`i.pip.pip-${c}${e.custom.includes(c) ? '.on' : ''}`, {
    title: c === 'C' ? 'colorless only' : MC.COLOR_NAMES[c],
    on: { click: () => { const set = new Set(e.custom); set.has(c) ? set.delete(c) : set.add(c); exChanged({ colors: 'custom', custom: [...set].filter((x) => x !== 'C') }); } },
  })));
  const typeSel = h('select', { on: { change: (ev) => exChanged({ type: ev.target.value }) } },
    ['', 'Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Land', 'Battle'].map((t) => h('option', { value: t }, t || 'any type')));
  typeSel.value = e.type;
  const lk = legalKey();
  return h('div.controls',
    h('span', 'Look in'),
    segmented([['owned', 'My cards'], ['available', 'Free copies'], ['all', 'All cards']], e.pool, (v) => exChanged({ pool: v })),
    h('span', 'Colors'),
    h('div.row', segmented([['deck', 'Deck'], ['any', 'Any'], ['custom', 'Pick']], e.colors, (v) => exChanged({ colors: v })), e.colors === 'custom' ? colorPick : null),
    h('span', 'Filters'),
    h('div.row', typeSel,
      h('label.inline', { title: lk ? '' : 'Open a deck with a format to use this' },
        h('input', { type: 'checkbox', checked: !!e.legal && !!lk, disabled: !lk, on: { change: (ev) => exChanged({ legal: ev.target.checked }) } }), lk ? `Legal in ${state.context.format}` : 'Format legal')),
    h('span', 'Group by'),
    segmented([['functions', 'Function', 'Top-level Tagger groups such as removal, ramp, card advantage'], ['all', 'All tags', 'Every tag, largest first']], e.mode, (v) => { state.exPath = []; state.exTag = null; exChanged({ mode: v }, true); }));
}

async function renderExplore() {
  const root = clear($('tab-explore'));
  if (setupNotice(root)) return;
  root.appendChild(exploreControls());
  const q = h('input', { type: 'search', placeholder: 'Search tags (name, alias or description)…', value: state.ex.query, style: { width: '100%', marginTop: '8px' } });
  q.addEventListener('input', () => { state.exPath = []; state.exTag = null; exChanged({ query: q.value }); });
  root.appendChild(q);
  const body = h('div', h('div.empty', 'Loading…'));
  root.appendChild(body);
  const opts = exPoolOpts();

  try {
    if (state.exTag) await renderTagCards(body, opts);
    else await renderTagList(body, opts);
  } catch (e) { clear(body).appendChild(errorBox(e)); }
}

/** Breadcrumbs for the drill-down path. Clicking step i goes back to that tag's sub-tags. */
function crumbs() {
  const c = h('div.crumbs', h('a', { href: '#', on: { click: (e) => { e.preventDefault(); state.exPath = []; state.exTag = null; renderExplore(); } } }, 'All'));
  state.exPath.forEach((id, i) => {
    c.appendChild(document.createTextNode('› '));
    c.appendChild(h('a', { href: '#', on: { click: (e) => { e.preventDefault(); state.exTag = null; state.exPath = state.exPath.slice(0, i + 1); renderExplore(); } } }, labels.get(id) || '…'));
  });
  return c;
}

async function renderTagList(body, opts) {
  const parent = state.exPath[state.exPath.length - 1] || null;
  const r = await send('exploreTags', { opts: Object.assign({}, opts, { parent, mode: state.ex.mode, query: parent ? '' : state.ex.query }) });
  clear(body);
  body.appendChild(h('div.small.muted', `${r.poolSize.toLocaleString()} cards in this pool.`));
  if (parent && r.parent) {
    labels.set(r.parent.id, r.parent.label);
    body.appendChild(crumbs());
    body.appendChild(h('div.row', h('strong', r.parent.label), h('span.muted', `${r.parent.count} cards`), h('span.spacer'),
      h('button', { on: { click: () => { state.exTag = parent; renderExplore(); } } }, 'Show cards')));
    if (r.parent.desc) body.appendChild(h('div.small.muted', r.parent.desc));
  }
  if (!r.tags.length) { body.appendChild(h('div.empty', parent ? 'No sub-tags with cards in this pool.' : 'No tags match.')); return; }
  for (const t of r.tags) {
    labels.set(t.id, t.label);
    body.appendChild(h('div.tag-row',
      h('div.tag-label', {
        title: t.desc || '',
        on: { click: () => { if (t.children) { state.exPath.push(t.id); } else { state.exTag = t.id; } renderExplore(); } },
      }, h('div', t.label, t.children ? h('span.muted', ` ▸ ${t.children}`) : null), t.desc ? h('div.tag-desc', t.desc) : null),
      h('span.n', String(t.count)),
      h('button.small', { title: 'List the cards', on: { click: () => { state.exTag = t.id; renderExplore(); } } }, 'Cards'),
      h('button.hide-tag', { title: 'Hide this tag everywhere (undo in Manage data)', on: { click: async () => { await send('hideTag', { id: t.id }); renderExplore(); } } }, '×')));
  }
}
const labels = new Map();

async function renderTagCards(body, opts) {
  const r = await send('exploreTagCards', { opts: Object.assign({}, opts, { tagId: state.exTag, flat: state.ex.flat }) });
  clear(body);
  if (!r) { body.appendChild(h('div.empty', 'Tag not found.')); return; }
  labels.set(r.tag.id, r.tag.label);
  body.appendChild(crumbs());
  body.appendChild(h('div.row', h('strong', r.tag.label), h('span.muted', `${r.total} cards`), h('span.spacer'),
    r.groups.length ? h('label.inline.small', h('input', { type: 'checkbox', checked: state.ex.flat, on: { change: (e) => exChanged({ flat: e.target.checked }, true) } }), ' Flat list') : null));
  if (r.tag.desc) body.appendChild(h('div.small.muted', r.tag.desc));
  if (r.tag.parents.length) body.appendChild(h('div.chips.small', h('span.muted', 'Part of:'), r.tag.parents.map((p) => h('a.chip.chip-small', { href: '#', on: { click: (e) => { e.preventDefault(); state.exTag = p.id; renderExplore(); } } }, p.label))));
  const cardOpts = { onSelect: (c) => selectCard(c.oid) };
  if (state.ex.flat || !r.groups.length) {
    const list = r.flat || r.direct;
    if (!list.length) body.appendChild(h('div.empty', 'No cards in this pool.'));
    for (const c of list) body.appendChild(UI.cardRow(c, cardOpts));
    return;
  }
  if (r.direct.length) {
    const d = h('details.group', { open: true }, h('summary', `${r.tag.label} (tagged directly) · ${r.direct.length}`));
    for (const c of r.direct) d.appendChild(UI.cardRow(c, cardOpts));
    body.appendChild(d);
  }
  for (const g of r.groups) {
    labels.set(g.id, g.label);
    const d = h('details.group', h('summary', `${g.label} · ${g.cards.length}`,
      h('a.small', { href: '#', style: { marginLeft: '8px' }, on: { click: (e) => { e.preventDefault(); state.exPath.push(r.tag.id); state.exTag = g.id; renderExplore(); } } }, 'open')));
    d.addEventListener('toggle', () => {
      if (d.open && d.childElementCount === 1) for (const c of g.cards) d.appendChild(UI.cardRow(c, cardOpts));
    });
    body.appendChild(d);
  }
}

/* ---------------------------------------------------------------- tab tracking */

async function loadTabState() {
  const [tab] = await browser.tabs.query({ active: true, windowId: state.windowId });
  state.tabId = tab ? tab.id : null;
  const st = state.tabId != null ? await send('tabState', { tabId: state.tabId }) : { context: null, selection: null };
  const onDeck = tab && /moxfield\.com\/decks\//.test(tab.url || '');
  state.context = onDeck ? st.context : null;
  state.deckView = null;
  if (st.selection) state.selection = st.selection;
  renderAll();
}

function renderAll() {
  renderStatus().then(() => {
    renderCard();
    renderDeck();
    renderExplore();
  });
}

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') { showJob(msg.job); if (!msg.job) renderStatus(); }
  else if (msg.type === 'selected' && msg.tabId === state.tabId) {
    if (state.selection && state.selection.oid !== msg.oid) state.history.push(state.selection.oid);
    state.selection = { oid: msg.oid, deckId: msg.deckId };
    switchTab('card');
    renderCard();
  } else if (msg.type === 'context' && msg.tabId === state.tabId) {
    const changed = !state.context || state.context.publicId !== msg.deck.publicId;
    state.context = msg.deck;
    state.deckView = null;
    renderDeck();
    if (changed) { renderCard(); renderExplore(); }
  } else if (msg.type === 'userChanged') {
    state.deckView = null;
    renderAll();
  }
});

document.getElementById('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  switchTab(b.dataset.tab);
  if (b.dataset.tab === 'deck') renderDeck();
});
$('open-manager').addEventListener('click', (e) => { e.preventDefault(); send('openManager'); });

(async () => {
  const win = await browser.windows.getCurrent();
  state.windowId = win.id;
  browser.runtime.connect({ name: `sidebar:${win.id}` });
  browser.tabs.onActivated.addListener((info) => { if (info.windowId === state.windowId) loadTabState(); });
  browser.tabs.onUpdated.addListener((tabId, change) => { if (tabId === state.tabId && change.url) setTimeout(loadTabState, 1500); });
  await loadTabState();
})();
