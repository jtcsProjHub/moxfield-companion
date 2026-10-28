/* Background page: owns the data, runs sync jobs, answers the content script, sidebar and manager. */
/* global MC, browser */
const engine = new MC.Engine();
const liveDecks = new Map();   // deckId -> { deck, at }
const tabContext = new Map();  // tabId -> { deckId, name, format, ci }
const tabSelection = new Map(); // tabId -> { oid, deckId }
const sidebarPorts = new Map(); // windowId -> Set(port)
let job = null;                // { name, text, pct }
let lastJobResult = null;

/* ---------------------------------------------------------------- loading */

async function getSettings() {
  const s = (await MC.db.get('meta', 'settings')) || {};
  return Object.assign({}, MC.DEFAULT_SETTINGS, s, { boards: Object.assign({}, MC.DEFAULT_SETTINGS.boards, s.boards || {}) });
}

async function loadUser() {
  const [settings, decks, collection] = await Promise.all([getSettings(), MC.db.values('decks'), MC.db.get('meta', 'collection')]);
  engine.setUser({ settings, decks, collection });
}

async function loadCards() {
  const [cards, tags, cardTags] = await Promise.all([MC.db.values('cards'), MC.db.values('tags'), MC.db.entries('cardTags')]);
  engine.setCards(cards);
  engine.setTags(tags, cardTags);
}

const ready = (async () => {
  await loadCards();
  await loadUser();
})();

/* ---------------------------------------------------------------- messaging helpers */

function broadcast(msg) {
  browser.runtime.sendMessage(msg).catch(() => {});
}

async function notifyMoxfieldTabs(msg) {
  const tabs = await browser.tabs.query({ url: ['*://moxfield.com/*', '*://www.moxfield.com/*'] });
  for (const t of tabs) browser.tabs.sendMessage(t.id, msg).catch(() => {});
}

async function userChanged() {
  await loadUser();
  broadcast({ type: 'userChanged' });
  notifyMoxfieldTabs({ type: 'userChanged' });
}

/** Run one long job at a time and report progress to every extension page. */
async function runJob(name, fn) {
  if (job) throw new Error(`Busy: ${job.name} is still running.`);
  job = { name, text: 'Starting…', pct: null };
  broadcast({ type: 'progress', job });
  const progress = (p) => { job = Object.assign({ name }, p); broadcast({ type: 'progress', job }); };
  try {
    const result = await fn(progress);
    lastJobResult = { name, ok: true, text: typeof result === 'string' ? result : 'Done', at: new Date().toISOString() };
    return result;
  } catch (e) {
    lastJobResult = { name, ok: false, text: e.message || String(e), at: new Date().toISOString() };
    throw e;
  } finally {
    job = null;
    broadcast({ type: 'progress', job: null, last: lastJobResult });
  }
}

/* When Moxfield refuses a direct request, retry it from an open moxfield.com tab. */
MC.moxfieldTabFetch = async (url) => {
  const tabs = await browser.tabs.query({ url: ['*://moxfield.com/*', '*://www.moxfield.com/*'] });
  for (const t of tabs) {
    try {
      const r = await browser.tabs.sendMessage(t.id, { type: 'pageFetch', url });
      if (r && r.ok) return r.data;
      if (r && r.status === 404) { const e = new Error('Not found on Moxfield.'); e.status = 404; throw e; }
    } catch (e) {
      if (e.status === 404) throw e;
    }
  }
  throw new Error('Moxfield refused the request. Open moxfield.com in a tab and try again.');
};

/* ---------------------------------------------------------------- jobs */

async function syncScryfall() {
  return runJob('Scryfall data', async (progress) => {
    const n = await MC.syncScryfallCards(progress);
    const t = await MC.syncScryfallTags(progress);
    progress({ text: 'Indexing…', pct: null });
    await loadCards();
    await loadUser();
    broadcast({ type: 'userChanged' });
    notifyMoxfieldTabs({ type: 'userChanged' });
    return `${n.toLocaleString()} cards and ${t.toLocaleString()} tags loaded.`;
  });
}

async function syncDecks({ force } = {}) {
  const settings = await getSettings();
  if (!settings.username) throw new Error('Set your Moxfield user name first.');
  return runJob('Deck sync', async (progress) => {
    const list = await MC.moxfieldUserDecks(settings.username, progress);
    const stored = new Map((await MC.db.entries('decks')));
    const seen = new Set();
    let fetched = 0;
    let skipped = 0;
    const todo = [];
    for (const d of list) {
      seen.add(d.publicId);
      const old = stored.get(d.publicId);
      const merged = Object.assign({}, old || {}, d, { excluded: old ? !!old.excluded : false, cards: old && old.cards, syncedAt: old && old.syncedAt });
      const formatOff = settings.formats[d.format] === false;
      if (merged.excluded || formatOff) { skipped++; await MC.db.put('decks', d.publicId, merged); continue; }
      if (!force && old && old.cards && old.lastUpdatedAtUtc === d.lastUpdatedAtUtc) { await MC.db.put('decks', d.publicId, merged); continue; }
      todo.push(merged);
    }
    for (let i = 0; i < todo.length; i++) {
      const d = todo[i];
      progress({ text: `Deck ${i + 1} of ${todo.length}: ${d.name}`, pct: (i + 1) / todo.length });
      const full = await MC.moxfieldDeck(d.publicId);
      await MC.db.put('decks', d.publicId, Object.assign({}, d, full, { excluded: d.excluded, syncedAt: new Date().toISOString(), mine: true }));
      fetched++;
    }
    // Decks that left the public list (deleted or made private) and were synced from search.
    let removed = 0;
    for (const [id, d] of stored) if (!seen.has(id) && d.mine && !d.manual) { await MC.db.del('decks', id); removed++; }
    await MC.db.put('meta', 'decksSyncedAt', new Date().toISOString());
    await userChanged();
    return `${list.length} public decks found, ${fetched} fetched, ${skipped} skipped (excluded or filtered), ${removed} removed.`;
  });
}

async function syncOneDeck(publicId, { manual } = {}) {
  const id = MC.parseDeckId(publicId);
  return runJob('Deck sync', async (progress) => {
    progress({ text: `Fetching deck ${id}…`, pct: null });
    const old = (await MC.db.get('decks', id)) || {};
    const full = await MC.moxfieldDeck(id);
    await MC.db.put('decks', id, Object.assign({}, old, full, {
      excluded: !!old.excluded, syncedAt: new Date().toISOString(), mine: true, manual: old.manual || !!manual,
    }));
    await userChanged();
    return `Synced "${full.name}" (${full.cards.length} entries).`;
  });
}

async function syncCollection() {
  const settings = await getSettings();
  let id = MC.parseCollectionId(settings.collectionId);
  if (!id && settings.username) {
    // The user profile names the collection when it is public.
    id = await MC.moxfieldUserCollectionId(settings.username);
    if (!id) throw new Error(`The collection of ${settings.username} is not public. Import a CSV export instead.`);
    await MC.db.put('meta', 'settings', Object.assign(settings, { collectionId: id }));
  }
  if (!id) throw new Error('Enter your Moxfield user name or your public collection link first.');
  return runJob('Collection sync', async (progress) => {
    const { items, proxies, total, proxyTotal } = await MC.moxfieldCollection(id, progress);
    if (!Object.keys(items).length && !Object.keys(proxies).length) throw new Error('The collection came back empty. Is it public?');
    await MC.db.put('meta', 'collection', { items, proxies, total, proxyTotal, source: `Moxfield collection ${id}`, syncedAt: new Date().toISOString() });
    await userChanged();
    return `${Object.keys(items).length.toLocaleString()} cards (${total.toLocaleString()} copies), plus ${proxyTotal.toLocaleString()} playtest copies of ${Object.keys(proxies).length.toLocaleString()} cards.`;
  });
}

async function importCollection(text, mode, label) {
  const parsed = MC.parseCollectionText(text);
  let items = parsed.items;
  let proxies = parsed.proxies;
  if (mode === 'add') {
    const old = (await MC.db.get('meta', 'collection')) || { items: {}, proxies: {} };
    const merge = (base, extra) => {
      const out = Object.assign({}, base || {});
      for (const [n, q] of Object.entries(extra)) out[n] = (out[n] || 0) + q;
      return out;
    };
    items = merge(old.items, parsed.items);
    proxies = merge(old.proxies, parsed.proxies);
  }
  const sum = (o) => Object.values(o).reduce((s, q) => s + q, 0);
  const total = sum(items);
  const proxyTotal = sum(proxies);
  await MC.db.put('meta', 'collection', { items, proxies, total, proxyTotal, source: label || 'Imported file', syncedAt: new Date().toISOString() });
  await userChanged();
  return {
    rows: parsed.rows, skipped: parsed.skipped, unique: Object.keys(items).length, total,
    proxyUnique: Object.keys(proxies).length, proxyTotal, unmatched: engine.unmatched.slice(0, 200),
  };
}

/* ---------------------------------------------------------------- live deck data */

async function getLiveDeck(deckId, force) {
  const hit = liveDecks.get(deckId);
  if (hit && !force && Date.now() - hit.at < 20000) return hit.deck;
  let deck;
  try {
    deck = await MC.moxfieldDeck(deckId);
  } catch (e) {
    const stored = await MC.db.get('decks', deckId);
    if (stored && stored.cards) deck = stored; else throw e;
  }
  liveDecks.set(deckId, { deck, at: Date.now() });
  return deck;
}

/* ---------------------------------------------------------------- message router */

const handlers = {
  async status() {
    const [cardsInfo, tagsInfo, collection, decksSyncedAt, settings] = await Promise.all([
      MC.db.get('meta', 'cardsInfo'), MC.db.get('meta', 'tagsInfo'), MC.db.get('meta', 'collection'),
      MC.db.get('meta', 'decksSyncedAt'), getSettings(),
    ]);
    return {
      stats: engine.stats(), cardsInfo, tagsInfo, decksSyncedAt, settings, job, lastJobResult,
      collection: collection && {
        source: collection.source, syncedAt: collection.syncedAt, total: collection.total, unique: Object.keys(collection.items || {}).length,
        proxyTotal: collection.proxyTotal || 0, proxyUnique: Object.keys(collection.proxies || {}).length,
      },
      unmatched: engine.unmatched.slice(0, 300),
    };
  },

  async deckView({ deckId, force }, sender) {
    const deck = await getLiveDeck(deckId, force);
    const view = engine.deckView(deck);
    const tabId = sender.tab && sender.tab.id;
    if (tabId != null) {
      tabContext.set(tabId, view.deck);
      broadcast({ type: 'context', tabId, deck: view.deck });
    }
    return view;
  },

  async deckSummary({ deckId, force }) {
    const deck = await getLiveDeck(deckId, !!force);
    return engine.deckView(deck);
  },

  async cardInfo({ oid, name, deckId }) {
    const id = oid || engine.lookup(name);
    return id ? engine.cardInfo(id, deckId) : null;
  },

  async similar({ oid, opts }) {
    return engine.similar(oid, opts || {});
  },

  async searchNames({ q }) {
    return engine.searchNames(q);
  },

  async exploreTags({ opts }) {
    return engine.exploreTags(opts || {});
  },

  async exploreTagCards({ opts }) {
    return engine.exploreTagCards(opts || {});
  },

  async select({ name, oid, deckId }, sender) {
    const id = oid || engine.lookup(name);
    if (!id) return { ok: false, reason: 'unknown card' };
    const tabId = sender.tab && sender.tab.id;
    const windowId = sender.tab && sender.tab.windowId;
    tabSelection.set(tabId, { oid: id, deckId });
    broadcast({ type: 'selected', tabId, oid: id, deckId });
    const ports = sidebarPorts.get(windowId);
    return { ok: true, sidebarOpen: !!(ports && ports.size) };
  },

  async tabState({ tabId }) {
    return { context: tabContext.get(tabId) || null, selection: tabSelection.get(tabId) || null };
  },

  async getSettings() {
    return getSettings();
  },

  async setSettings({ patch }) {
    const s = Object.assign(await getSettings(), patch);
    await MC.db.put('meta', 'settings', s);
    await userChanged();
    return s;
  },

  async decksList() {
    const decks = await MC.db.values('decks');
    return decks
      .map((d) => ({
        publicId: d.publicId, name: d.name, format: d.format, lastUpdatedAtUtc: d.lastUpdatedAtUtc,
        syncedAt: d.syncedAt, excluded: !!d.excluded, manual: !!d.manual, cardCount: d.cards ? d.cards.reduce((s, e) => s + e.q, 0) : null,
        counted: engine.deckCounts(d),
      }))
      .sort((a, b) => String(b.lastUpdatedAtUtc).localeCompare(String(a.lastUpdatedAtUtc)));
  },

  async decksSyncAll({ force }) { return syncDecks({ force }); },
  async decksSyncOne({ publicId, manual }) { return syncOneDeck(publicId, { manual }); },

  async decksSetExcluded({ publicId, excluded }) {
    const d = await MC.db.get('decks', publicId);
    if (!d) return false;
    d.excluded = !!excluded;
    await MC.db.put('decks', publicId, d);
    await userChanged();
    return true;
  },

  async decksRemove({ publicId }) {
    await MC.db.del('decks', publicId);
    await userChanged();
    return true;
  },

  async collectionSync() { return syncCollection(); },
  async collectionImport({ text, mode, label }) { return importCollection(text, mode, label); },
  async collectionClear() {
    await MC.db.del('meta', 'collection');
    await userChanged();
    return true;
  },

  async scryfallSync() { return syncScryfall(); },

  /** The manager page imported bulk files itself; reload them. */
  async reloadCards() {
    await loadCards();
    await userChanged();
    return engine.stats();
  },

  async hiddenTags() {
    const s = await getSettings();
    return s.hiddenTags.map((id) => ({ id, label: (engine.tags.get(id) || { label: id }).label }));
  },
  async hideTag({ id }) {
    const s = await getSettings();
    if (!s.hiddenTags.includes(id)) s.hiddenTags.push(id);
    await MC.db.put('meta', 'settings', s);
    await userChanged();
    return true;
  },
  async unhideTag({ id }) {
    const s = await getSettings();
    s.hiddenTags = s.hiddenTags.filter((x) => x !== id);
    await MC.db.put('meta', 'settings', s);
    await userChanged();
    return true;
  },

  async clearAll() {
    await MC.db.clearAll();
    liveDecks.clear();
    await loadCards();
    await userChanged();
    return true;
  },

  async openManager() {
    await browser.runtime.openOptionsPage();
    return true;
  },
};

browser.runtime.onMessage.addListener((msg, sender) => {
  const h = msg && handlers[msg.type];
  if (!h) return undefined;
  return ready.then(() => h(msg, sender)).then(
    (result) => ({ ok: true, result }),
    (e) => ({ ok: false, error: e.message || String(e) }),
  );
});

/* ---------------------------------------------------------------- sidebar tracking */

browser.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith('sidebar:')) return;
  const windowId = Number(port.name.slice(8));
  if (!sidebarPorts.has(windowId)) sidebarPorts.set(windowId, new Set());
  sidebarPorts.get(windowId).add(port);
  port.onDisconnect.addListener(() => sidebarPorts.get(windowId).delete(port));
});

browser.tabs.onRemoved.addListener((tabId) => {
  tabContext.delete(tabId);
  tabSelection.delete(tabId);
});

/* ---------------------------------------------------------------- toolbar, menus, alarms */

browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

browser.menus.create({
  id: 'mc-select',
  title: 'Collection Companion: show this card',
  contexts: ['link', 'image'],
  documentUrlPatterns: ['*://moxfield.com/*', '*://www.moxfield.com/*'],
});

browser.menus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'mc-select') return;
  // open() must run synchronously inside the user action.
  browser.sidebarAction.open();
  browser.tabs.sendMessage(tab.id, { type: 'resolveTarget', targetElementId: info.targetElementId, linkText: info.linkText })
    .then((r) => {
      if (!r || !r.name) return;
      return handlers.select({ name: r.name, deckId: r.deckId }, { tab });
    })
    .catch(() => {});
});

browser.alarms.create('scryfall-refresh', { periodInMinutes: 360, delayInMinutes: 2 });
browser.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== 'scryfall-refresh') return;
  await ready;
  const s = await getSettings();
  if (!s.autoRefreshDays) return;
  const info = await MC.db.get('meta', 'cardsInfo');
  const age = info ? (Date.now() - new Date(info.syncedAt).getTime()) / 86400000 : Infinity;
  if (age >= s.autoRefreshDays && !job) syncScryfall().catch(() => {});
});

browser.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') browser.runtime.openOptionsPage();
});
