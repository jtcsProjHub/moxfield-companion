/* Moxfield's public (undocumented) API, used gently: one request at a time. */
(function (g) {
  const MC = (g.MC = g.MC || {});
  const API = 'https://api2.moxfield.com';
  const GAP_MS = 700;
  let lastCall = 0;
  let queue = Promise.resolve();

  /**
   * Optional fallback transport (set by the background page): runs the request from an open
   * moxfield.com tab when a direct request is refused.
   */
  MC.moxfieldTabFetch = null;

  async function direct(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (res.status === 429) {
      const wait = Number(res.headers.get('Retry-After')) || 10;
      const err = new Error(`Moxfield rate limit, retry in ${wait}s`);
      err.retryAfter = wait;
      throw err;
    }
    if (res.status === 404) { const e = new Error('Not found on Moxfield (private, deleted, or wrong id).'); e.status = 404; throw e; }
    if (!res.ok) { const e = new Error(`Moxfield: HTTP ${res.status}`); e.status = res.status; throw e; }
    return res.json();
  }

  /** Serialized, rate-limited GET with one retry on 429 and a tab fallback on 403. */
  function getJSON(url) {
    const run = async () => {
      const wait = lastCall + GAP_MS - Date.now();
      if (wait > 0) await MC.sleep(wait);
      lastCall = Date.now();
      try {
        return await direct(url);
      } catch (e) {
        if (e.retryAfter) {
          await MC.sleep(Math.min(e.retryAfter, 60) * 1000);
          lastCall = Date.now();
          return direct(url);
        }
        if ((e.status === 403 || e.status === undefined) && MC.moxfieldTabFetch) {
          return MC.moxfieldTabFetch(url);
        }
        throw e;
      }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  }

  /** All public decks of a user (summaries only). */
  MC.moxfieldUserDecks = async function (userName, progress) {
    const out = [];
    for (let page = 1; page < 50; page++) {
      const q = new URLSearchParams({
        authorUserNames: userName, pageNumber: String(page), pageSize: '100',
        sortType: 'updated', sortDirection: 'descending',
      });
      const j = await getJSON(`${API}/v2/decks/search?${q}`);
      for (const d of j.data || []) {
        out.push({
          publicId: d.publicId,
          name: d.name,
          format: d.format || 'none',
          lastUpdatedAtUtc: d.lastUpdatedAtUtc,
          ci: d.colorIdentity || [],
        });
      }
      progress && progress({ text: `Deck list: ${out.length} of ${j.totalResults || '?'}`, pct: null });
      if (page >= (j.totalPages || 1)) break;
    }
    return out;
  };

  /** One deck with its cards, normalized. */
  MC.moxfieldDeck = async function (publicId) {
    const j = await getJSON(`${API}/v3/decks/all/${encodeURIComponent(publicId)}`);
    const cards = [];
    for (const [board, b] of Object.entries(j.boards || {})) {
      for (const e of Object.values((b && b.cards) || {})) {
        if (!e || !e.card) continue;
        cards.push({
          n: e.card.name,
          q: e.quantity || 1,
          b: board,
          p: !!e.isProxy,
          u: e.card.uniqueCardId || '',
          m: e.card.id || '',
        });
      }
    }
    return {
      publicId: j.publicId || publicId,
      name: j.name,
      format: j.format || 'none',
      lastUpdatedAtUtc: j.lastUpdatedAtUtc,
      author: (j.createdByUser && j.createdByUser.userName) || '',
      ci: j.colorIdentity || [],
      cards,
    };
  };

  /** The public collection id of a user, or null when the collection is not public. */
  MC.moxfieldUserCollectionId = async function (userName) {
    const j = await getJSON(`${API}/v1/users/${encodeURIComponent(userName)}`);
    return j.collectionVisibility === 'public' && j.collectionPublicId ? j.collectionPublicId : null;
  };

  /** A public collection, aggregated by card name. Proxy (playtest) copies go to `proxies`. */
  MC.moxfieldCollection = async function (collectionId, progress) {
    const items = {};
    const proxies = {};
    let total = 0;
    let proxyTotal = 0;
    for (let page = 1; page < 2000; page++) {
      const q = new URLSearchParams({
        pageNumber: String(page), pageSize: '100', sortType: 'cardName', sortDirection: 'ascending',
      });
      const j = await getJSON(`${API}/v1/collections/search/${encodeURIComponent(collectionId)}?${q}`);
      for (const e of j.data || []) {
        if (e.game && e.game !== 'paper') continue;
        const name = e.card && e.card.name;
        if (!name) continue;
        const q = e.quantity || 0;
        if (e.isProxy) { proxies[name] = (proxies[name] || 0) + q; proxyTotal += q; continue; }
        items[name] = (items[name] || 0) + q;
        total += q;
      }
      progress && progress({ text: `Collection: page ${page} of ${j.totalPages || '?'}`, pct: j.totalPages ? page / j.totalPages : null });
      if (page >= (j.totalPages || 1)) break;
    }
    return { items, proxies, total, proxyTotal };
  };

  /** Pull a deck id out of a URL or return the input. */
  MC.parseDeckId = function (s) {
    const m = String(s || '').match(/moxfield\.com\/decks\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : String(s || '').trim();
  };

  /** Pull a collection id out of a URL or return the input. */
  MC.parseCollectionId = function (s) {
    const m = String(s || '').match(/moxfield\.com\/collection\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : String(s || '').trim();
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
