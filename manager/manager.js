/* Manage data page: Scryfall data, collection, decks and settings. */
/* global UI, MC, browser */
const { h, clear, send } = UI;
const $ = (id) => document.getElementById(id);
let settings = null;
let decks = [];

function showJob(job) {
  $('job').hidden = !job;
  if (!job) return;
  $('job-text').textContent = `${job.name}: ${job.text || ''}`;
  const bar = document.querySelector('#job .progress');
  bar.classList.toggle('indeterminate', job.pct == null);
  bar.firstElementChild.style.width = job.pct == null ? '' : `${Math.round(job.pct * 100)}%`;
}

function showLast(last) {
  if (!last) return;
  $('last').className = `small callout ${last.ok ? '' : 'error'}`;
  $('last').textContent = `${last.name}: ${last.text}`;
}

async function run(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    const r = await fn();
    return r;
  } catch (e) {
    showLast({ name: 'Error', ok: false, text: e.message });
    return null;
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function saveSettings(patch) {
  settings = await send('setSettings', { patch });
}

/* ---------------------------------------------------------------- status */

async function refreshStatus() {
  const st = await send('status');
  settings = st.settings;
  showJob(st.job);
  const ci = st.cardsInfo;
  const ti = st.tagsInfo;
  $('scry-status').textContent = ci
    ? `${ci.count.toLocaleString()} cards (Scryfall file of ${UI.fmtDate(ci.updatedAt)}), ${ti ? ti.count.toLocaleString() + ' tags (file of ' + UI.fmtDate(ti.updatedAt) + ')' : 'no tags yet'}. Downloaded ${UI.fmtDate(ci.syncedAt)}.`
    : 'No card data yet. Download it to start.';
  const col = st.collection;
  $('col-status').textContent = col
    ? `${col.unique.toLocaleString()} different cards, ${col.total.toLocaleString()} real copies` +
      (col.proxyTotal ? `, plus ${col.proxyTotal.toLocaleString()} playtest copies of ${col.proxyUnique.toLocaleString()} cards` : '') +
      `, from ${col.source}, ${UI.fmtDate(col.syncedAt)}. ${st.stats.unmatched} names not matched.`
    : 'No collection loaded yet.';
  const um = clear($('unmatched'));
  for (const n of st.unmatched) um.appendChild(h('div', n));
  $('unmatched-wrap').hidden = !st.unmatched.length;
  $('decks-sync-status').textContent = st.decksSyncedAt ? `Last deck sync: ${UI.fmtDate(st.decksSyncedAt)}.` : '';
  $('username').value = settings.username || '';
  $('col-id').value = settings.collectionId || '';
  $('auto-days').value = settings.autoRefreshDays;
  $('count-proxies').checked = !!settings.countProxies;
  $('include-playtest').checked = settings.includePlaytest !== false;
  $('highlight').checked = settings.highlight !== false;
  $('hide-cycle').checked = !!settings.hideCycleTags;
  renderBoards();
  await renderDecks();
  await renderHiddenTags();
}

function renderBoards() {
  const box = clear($('boards'));
  const labels = { mainboard: 'Mainboard', commanders: 'Commanders', companions: 'Companions', sideboard: 'Sideboard', maybeboard: 'Maybeboard', signatureSpells: 'Signature spells', attractions: 'Attractions', stickers: 'Stickers', contraptions: 'Contraptions', planes: 'Planes', schemes: 'Schemes', tokens: 'Tokens' };
  for (const [k, label] of Object.entries(labels)) {
    box.appendChild(h('label', h('input', {
      type: 'checkbox', checked: !!settings.boards[k],
      on: { change: (e) => saveSettings({ boards: Object.assign({}, settings.boards, { [k]: e.target.checked }) }) },
    }), ` ${label}`));
  }
}

/* ---------------------------------------------------------------- decks */

async function renderDecks() {
  decks = await send('decksList');
  const formats = [...new Set(decks.map((d) => d.format))].sort();
  const fbox = clear($('formats'));
  if (!formats.length) fbox.appendChild(h('span.muted.small', 'Sync your decks to see their formats.'));
  for (const f of formats) {
    const n = decks.filter((d) => d.format === f).length;
    fbox.appendChild(h('label', h('input', {
      type: 'checkbox', checked: settings.formats[f] !== false,
      on: { change: (e) => saveSettings({ formats: Object.assign({}, settings.formats, { [f]: e.target.checked }) }).then(renderDecks) },
    }), ` ${f} (${n})`));
  }
  const sel = $('deck-filter');
  const cur = sel.value;
  clear(sel).appendChild(h('option', { value: '' }, 'all'));
  for (const f of formats) sel.appendChild(h('option', { value: f }, f));
  sel.value = formats.includes(cur) ? cur : '';
  drawDeckTable();
}

function drawDeckTable() {
  const tbody = clear(document.querySelector('#decks tbody'));
  const f = $('deck-filter').value;
  const q = $('deck-search').value.trim().toLowerCase();
  const list = decks.filter((d) => (!f || d.format === f) && (!q || d.name.toLowerCase().includes(q)));
  if (!list.length) tbody.appendChild(h('tr', h('td.muted', { colSpan: 7 }, decks.length ? 'No decks match.' : 'No decks yet. Enter your user name and press "Sync all decks".')));
  for (const d of list) {
    const formatOff = settings.formats[d.format] === false;
    const tr = h(`tr${d.counted ? '' : '.excluded'}`,
      h('td', h('input', {
        type: 'checkbox', checked: !d.excluded, disabled: formatOff, title: formatOff ? 'This format is turned off above' : 'Uncheck to exclude this deck',
        on: { change: async (e) => { await send('decksSetExcluded', { publicId: d.publicId, excluded: !e.target.checked }); await renderDecks(); } },
      })),
      h('td', h('a', { href: `https://moxfield.com/decks/${d.publicId}`, target: '_blank' }, d.name || d.publicId), d.manual ? h('span.muted', ' (added by hand)') : null),
      h('td', d.format),
      h('td', d.cardCount == null ? h('span.muted', 'not synced') : String(d.cardCount)),
      h('td', UI.fmtDate(d.lastUpdatedAtUtc)),
      h('td', UI.fmtDate(d.syncedAt)),
      h('td', h('div.row',
        h('button.small', { on: { click: (e) => run(e.target, async () => { await send('decksSyncOne', { publicId: d.publicId }); await renderDecks(); }) } }, 'Sync'),
        d.manual ? h('button.small', { title: 'Remove this deck from the local data', on: { click: async () => { await send('decksRemove', { publicId: d.publicId }); await renderDecks(); } } }, 'Remove') : null)));
    tbody.appendChild(tr);
  }
}

/* ---------------------------------------------------------------- tags */

async function renderHiddenTags() {
  const box = clear($('hidden-tags'));
  const list = await send('hiddenTags');
  if (!list.length) box.appendChild(h('span.muted.small', 'None. Hide a tag with the × next to it in the sidebar Explore tab.'));
  for (const t of list) {
    box.appendChild(h('a.chip', { href: '#', title: 'Show this tag again', on: { click: async (e) => { e.preventDefault(); await send('unhideTag', { id: t.id }); renderHiddenTags(); } } }, `${t.label} ×`));
  }
}

/* ---------------------------------------------------------------- wiring */

$('scry-sync').addEventListener('click', (e) => run(e.target, async () => { await send('scryfallSync'); await refreshStatus(); }));
$('auto-days').addEventListener('change', (e) => saveSettings({ autoRefreshDays: Math.max(0, Number(e.target.value) || 0) }));

for (const [id, kind] of [['file-cards', 'cards'], ['file-tags', 'tags']]) {
  $(id).addEventListener('change', (e) => run(e.target, async () => {
    const file = e.target.files[0];
    if (!file) return;
    const progress = (p) => showJob(Object.assign({ name: `Import ${kind}` }, p));
    try {
      const n = await MC.importScryfallFile(file, kind, progress);
      await send('reloadCards');
      showLast({ name: `Import ${kind}`, ok: true, text: `${n.toLocaleString()} ${kind} loaded from ${file.name}.` });
    } finally {
      showJob(null);
      e.target.value = '';
    }
    await refreshStatus();
  }));
}

$('col-file').addEventListener('change', (e) => run(e.target, async () => {
  const file = e.target.files[0];
  if (!file) return;
  const mode = document.querySelector('input[name="col-mode"]:checked').value;
  const text = await file.text();
  const r = await send('collectionImport', { text, mode, label: file.name });
  showLast({
    name: 'Collection import', ok: true,
    text: `${r.rows.toLocaleString()} rows read, ${r.skipped} skipped. ${r.unique.toLocaleString()} different cards, ${r.total.toLocaleString()} real copies` +
      (r.proxyTotal ? `, ${r.proxyTotal.toLocaleString()} playtest copies of ${r.proxyUnique.toLocaleString()} cards.` : '.'),
  });
  e.target.value = '';
  await refreshStatus();
}));

$('col-sync').addEventListener('click', (e) => run(e.target, async () => {
  await saveSettings({ collectionId: $('col-id').value.trim(), username: $('username').value.trim() || settings.username });
  await send('collectionSync');
  await refreshStatus();
}));

$('col-clear').addEventListener('click', (e) => run(e.target, async () => {
  if (!confirm('Remove the collection from local data? Your Moxfield collection is not changed.')) return;
  await send('collectionClear');
  await refreshStatus();
}));

$('username').addEventListener('change', (e) => saveSettings({ username: e.target.value.trim() }));
$('decks-sync').addEventListener('click', (e) => run(e.target, async () => {
  await saveSettings({ username: $('username').value.trim() });
  await send('decksSyncAll', { force: false });
  await refreshStatus();
}));
$('decks-sync-force').addEventListener('click', (e) => run(e.target, async () => {
  await saveSettings({ username: $('username').value.trim() });
  await send('decksSyncAll', { force: true });
  await refreshStatus();
}));
$('deck-add-btn').addEventListener('click', (e) => run(e.target, async () => {
  const id = MC.parseDeckId($('deck-add').value);
  if (!id) return;
  await send('decksSyncOne', { publicId: id, manual: true });
  $('deck-add').value = '';
  await renderDecks();
}));
$('deck-filter').addEventListener('change', drawDeckTable);
$('deck-search').addEventListener('input', drawDeckTable);

$('count-proxies').addEventListener('change', (e) => saveSettings({ countProxies: e.target.checked }));
$('include-playtest').addEventListener('change', (e) => saveSettings({ includePlaytest: e.target.checked }));
$('highlight').addEventListener('change', (e) => saveSettings({ highlight: e.target.checked }));
$('hide-cycle').addEventListener('change', (e) => saveSettings({ hideCycleTags: e.target.checked }));

$('clear-all').addEventListener('click', (e) => run(e.target, async () => {
  if (!confirm('Delete all local data: card data, tags, collection, decks and settings? Nothing on Moxfield changes.')) return;
  await send('clearAll');
  await refreshStatus();
}));

browser.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    showJob(msg.job);
    if (msg.last) showLast(msg.last);
  }
});

refreshStatus().catch((e) => showLast({ name: 'Error', ok: false, text: e.message }));
