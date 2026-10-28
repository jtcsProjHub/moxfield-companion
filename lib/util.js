/* Shared helpers. Works in the background page, extension pages and Node (tests). */
(function (g) {
  const MC = (g.MC = g.MC || {});

  MC.sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /** Normalize a card name for lookups: case, accents, curly quotes, spacing. */
  MC.normName = function (name) {
    if (!name) return '';
    return String(name)
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[‘’‛]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  };

  /** RFC 4180 CSV parser. Returns an array of rows (arrays of strings). */
  MC.parseCSV = function (text) {
    const rows = [];
    let row = [];
    let field = '';
    let i = 0;
    let inQuotes = false;
    const n = text.length;
    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }
      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === ',') { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
      field += c; i++;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ''));
  };

  /**
   * Parse a collection from a Moxfield CSV export, any CSV with a quantity and a name
   * column, or a plain list ("4 Lightning Bolt", "4x Lightning Bolt (M10) 146").
   * Rows marked as proxies (Moxfield "playtest" cards) go to `proxies`, not `items`.
   * Returns { items: {name: qty}, proxies: {name: qty}, rows, skipped }.
   */
  MC.parseCollectionText = function (text) {
    const items = {};
    const proxies = {};
    let rows = 0;
    let skipped = 0;
    const add = (name, qty, proxy) => {
      name = (name || '').trim();
      if (!name || !(qty > 0)) { skipped++; return; }
      const into = proxy ? proxies : items;
      into[name] = (into[name] || 0) + qty;
      rows++;
    };
    text = text.replace(/^﻿/, '');
    const nl = text.indexOf('\n');
    const firstLine = nl < 0 ? text : text.slice(0, nl);
    if (/,/.test(firstLine) && /name/i.test(firstLine)) {
      const table = MC.parseCSV(text);
      const header = table.shift().map((h) => h.trim().toLowerCase());
      const nameCol = header.findIndex((h) => h === 'name' || h === 'card name' || h === 'card');
      let qtyCol = header.findIndex((h) => h === 'count' || h === 'quantity' || h === 'qty');
      const proxyCol = header.indexOf('proxy');
      if (nameCol < 0) throw new Error('The CSV has no "Name" column.');
      for (const r of table) {
        const proxy = proxyCol >= 0 && /^true$/i.test(r[proxyCol] || '');
        const qty = qtyCol >= 0 ? parseInt(r[qtyCol], 10) : 1;
        add(r[nameCol], qty, proxy);
      }
    } else {
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || /^(\/\/|#)/.test(line)) continue;
        const m = line.match(/^(\d+)\s*x?\s+(.+?)(\s+\([A-Za-z0-9]+\).*)?$/i);
        if (m) add(m[2], parseInt(m[1], 10));
        else add(line.replace(/\s+\([A-Za-z0-9]+\).*$/, ''), 1);
      }
    }
    return { items, proxies, rows, skipped };
  };

  MC.fmtDate = function (iso) {
    if (!iso) return 'never';
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };

  /** Moxfield format names mapped to Scryfall legality keys. */
  MC.FORMAT_TO_LEGALITY = {
    commander: 'commander', standard: 'standard', modern: 'modern', pauper: 'pauper',
    legacy: 'legacy', vintage: 'vintage', pioneer: 'pioneer', historic: 'historic',
    brawl: 'brawl', standardbrawl: 'standardbrawl', oathbreaker: 'oathbreaker',
    premodern: 'premodern', oldschool: 'oldschool', duel: 'duel', penny: 'penny',
    explorer: 'explorer', alchemy: 'alchemy', timeless: 'timeless', gladiator: 'gladiator',
    paupercommander: 'paupercommander', predh: 'predh', future: 'future',
  };

  MC.COLOR_NAMES = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };

  MC.COMMANDER_FORMATS =new Set(['commander', 'brawl', 'standardbrawl', 'oathbreaker', 'duel', 'paupercommander', 'predh']);

  MC.DEFAULT_SETTINGS = {
    username: '',
    collectionId: '',
    formats: {},            // format -> false to exclude; missing means included
    boards: {               // which deck boards consume collection copies
      mainboard: true, commanders: true, companions: true, sideboard: true,
      signatureSpells: true, maybeboard: false, attractions: true, stickers: true,
      contraptions: true, planes: false, schemes: false, tokens: false,
    },
    countProxies: false,     // false: deck entries marked as proxy do not use up copies
    includePlaytest: true,   // count playtest (proxy) copies from the collection as owned copies
    autoRefreshDays: 7,      // Scryfall bulk refresh interval, 0 = never
    hiddenTags: [],          // tag ids hidden from every view
    hideCycleTags: true,
    highlight: true,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
