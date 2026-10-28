/* Scryfall bulk data: oracle cards and oracle tags (Tagger), streamed into IndexedDB. */
(function (g) {
  const MC = (g.MC = g.MC || {});
  const BULK_INDEX = 'https://api.scryfall.com/bulk-data';

  // Layouts and set types that are not real deck cards.
  const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'vanguard', 'planar', 'scheme', 'reversible_card_token']);
  const SKIP_SET_TYPES = new Set(['token', 'memorabilia', 'minigame']);
  const WEIGHTS = { very_strong: 1, strong: 0.85, median: 0.7, weak: 0.4 };

  /**
   * Yield one parsed JSON object per line of a (possibly gzipped) JSON Lines response.
   * A legacy JSON array with one object per line also works.
   */
  MC.iterJsonLines = async function* (response, onBytes) {
    const raw = response.body.getReader();
    let read = 0;
    const first = await raw.read();
    if (first.done) return;
    const head = first.value;
    const gz = head.length > 1 && head[0] === 0x1f && head[1] === 0x8b;
    const counted = new ReadableStream({
      start(ctl) { read += head.length; onBytes && onBytes(read); ctl.enqueue(head); },
      async pull(ctl) {
        const { done, value } = await raw.read();
        if (done) { ctl.close(); return; }
        read += value.length;
        onBytes && onBytes(read);
        ctl.enqueue(value);
      },
      cancel(reason) { return raw.cancel(reason); },
    });
    let stream = counted;
    if (gz) stream = stream.pipeThrough(new DecompressionStream('gzip'));
    const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    const parseLine = (line) => {
      line = line.trim();
      if (!line || line === '[' || line === ']') return null;
      if (line.endsWith(',')) line = line.slice(0, -1);
      return JSON.parse(line);
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const obj = parseLine(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (obj) yield obj;
      }
    }
    const last = parseLine(buf);
    if (last) yield last;
  };

  /** Keep only what the add-on needs from a Scryfall card object. Returns null to skip. */
  MC.slimCard = function (c) {
    if (SKIP_LAYOUTS.has(c.layout) || SKIP_SET_TYPES.has(c.set_type)) return null;
    // Alchemy rebalanced cards are digital only. Do not filter on c.games: the printing that
    // oracle_cards picks for an old card can be an MTGO-only reprint.
    if (c.set_type === 'alchemy' || /^A-/.test(c.name || '')) return null;
    const faces = c.card_faces || [];
    const oid = c.oracle_id || (faces[0] && faces[0].oracle_id);
    if (!oid) return null;
    const f0 = faces[0] || {};
    const text = c.oracle_text != null && !faces.length
      ? c.oracle_text
      : faces.map((f) => f.oracle_text || '').join('\n//\n') || c.oracle_text || '';
    const img = (c.image_uris && c.image_uris.normal) || (f0.image_uris && f0.image_uris.normal) || '';
    const legal = [];
    for (const [k, v] of Object.entries(c.legalities || {})) if (v === 'legal' || v === 'restricted') legal.push(k);
    return {
      oid,
      name: c.name,
      faces: faces.length ? faces.map((f) => f.name) : undefined,
      layout: c.layout,
      cost: c.mana_cost != null && c.mana_cost !== '' ? c.mana_cost : faces.map((f) => f.mana_cost || '').filter(Boolean).join(' // '),
      cmc: c.cmc || 0,
      type: c.type_line || faces.map((f) => f.type_line).join(' // '),
      text,
      pow: c.power != null ? c.power : f0.power,
      tou: c.toughness != null ? c.toughness : f0.toughness,
      loy: c.loyalty != null ? c.loyalty : f0.loyalty,
      colors: c.colors || f0.colors || [],
      ci: c.color_identity || [],
      kw: c.keywords || [],
      legal,
      img,
      uri: c.scryfall_uri,
      rank: c.edhrec_rank || null,
      gc: !!c.game_changer,
    };
  };

  /** Turn a Scryfall tag object into a stored tag and its taggings. */
  MC.slimTag = function (t) {
    return {
      tag: {
        id: t.id,
        slug: t.slug,
        label: t.label || t.slug,
        desc: t.description || '',
        parents: t.parent_ids || [],
        children: t.child_ids || [],
        aliases: t.aliases || [],
        direct: (t.taggings || []).length,
      },
      taggings: (t.taggings || []).map((x) => [x.oracle_id, WEIGHTS[x.weight] || 0.7]),
    };
  };

  async function bulkInfo(type) {
    const res = await fetch(BULK_INDEX, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`Scryfall bulk index: HTTP ${res.status}`);
    const list = await res.json();
    const info = (list.data || []).find((d) => d.type === type);
    if (!info) throw new Error(`Scryfall has no "${type}" bulk file.`);
    return {
      url: info.jsonl_download_uri || info.download_uri,
      size: info.compressed_size || info.size || 0,
      updatedAt: info.updated_at,
    };
  }

  async function download(info, label, progress) {
    const res = await fetch(info.url);
    if (!res.ok) throw new Error(`${label}: HTTP ${res.status}`);
    const total = info.size || Number(res.headers.get('content-length')) || 0;
    let lastReport = 0;
    const onBytes = (n) => {
      const now = Date.now();
      if (now - lastReport < 250) return;
      lastReport = now;
      progress && progress({ text: `${label}: ${(n / 1e6).toFixed(1)}${total ? ' / ' + (total / 1e6).toFixed(1) : ''} MB`, pct: total ? n / total : null });
    };
    return MC.iterJsonLines(res, onBytes);
  }

  /** Download oracle cards and replace the local card store. */
  MC.syncScryfallCards = async function (progress) {
    const info = await bulkInfo('oracle_cards');
    return storeCards(await download(info, 'Oracle cards', progress), info, progress);
  };

  /** Download Tagger's oracle tags and replace the local tag stores. */
  MC.syncScryfallTags = async function (progress) {
    const info = await bulkInfo('oracle_tags');
    return storeTags(await download(info, 'Oracle tags', progress), info, progress);
  };

  /** Import a bulk file the user downloaded (File or Blob). kind: 'cards' or 'tags'. */
  MC.importScryfallFile = async function (file, kind, progress) {
    const res = new Response(file.stream ? file.stream() : file);
    const total = file.size || 0;
    const onBytes = (n) => progress && progress({ text: `${file.name || kind}: ${(n / 1e6).toFixed(1)} / ${(total / 1e6).toFixed(1)} MB`, pct: total ? n / total : null });
    const iter = MC.iterJsonLines(res, onBytes);
    const info = { updatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : null };
    return kind === 'tags' ? storeTags(iter, info, progress) : storeCards(iter, info, progress);
  };

  async function storeCards(iter, info, progress) {
    const entries = [];
    for await (const c of iter) {
      if (c.object === 'tag') throw new Error('This is the oracle tags file, not the oracle cards file.');
      const s = MC.slimCard(c);
      if (s) entries.push([s.oid, s]);
    }
    if (entries.length < 1000) throw new Error(`Oracle cards file looks incomplete (${entries.length} cards).`);
    progress && progress({ text: `Saving ${entries.length} cards…`, pct: null });
    await MC.db.replaceAll('cards', entries);
    await MC.db.put('meta', 'cardsInfo', { updatedAt: info.updatedAt, syncedAt: new Date().toISOString(), count: entries.length });
    return entries.length;
  }

  async function storeTags(iter, info, progress) {
    const tagEntries = [];
    const byCard = new Map();
    for await (const t of iter) {
      if (t.object === 'card') throw new Error('This is the oracle cards file, not the oracle tags file.');
      if (t.type && t.type !== 'oracle') continue;
      const { tag, taggings } = MC.slimTag(t);
      tagEntries.push([tag.id, tag]);
      for (const [oid, w] of taggings) {
        let arr = byCard.get(oid);
        if (!arr) byCard.set(oid, (arr = []));
        arr.push([tag.id, w]);
      }
    }
    if (tagEntries.length < 100) throw new Error(`Oracle tags file looks incomplete (${tagEntries.length} tags).`);
    progress && progress({ text: `Saving ${tagEntries.length} tags…`, pct: null });
    await MC.db.replaceAll('tags', tagEntries);
    await MC.db.replaceAll('cardTags', [...byCard.entries()]);
    await MC.db.put('meta', 'tagsInfo', { updatedAt: info.updatedAt, syncedAt: new Date().toISOString(), count: tagEntries.length });
    return tagEntries.length;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
