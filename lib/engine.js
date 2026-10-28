/*
 * In-memory card engine: name lookup, collection availability, card similarity and tag exploration.
 * Pure data in, plain objects out, so it runs the same in the background page and in Node tests.
 */
(function (g) {
  const MC = (g.MC = g.MC || {});
  const norm = (s) => MC.normName(s);

  // Structural Tagger roots: they describe how a card is printed or worded, not what it does.
  const META_ROOT_SLUGS = [
    'card-names', 'cycle', 'flavors-of-vanilla', 'type-errata', 'unique-type-line',
    'staple-with-set-s-mechanic', 'cheaper-than-mv', 'more-expensive-than-mv',
    'triggered-ability', 'activated-ability', 'typal', 'repeatable-crime',
  ];
  const MAIN_TYPES = ['Artifact', 'Battle', 'Creature', 'Enchantment', 'Instant', 'Kindred', 'Land', 'Planeswalker', 'Sorcery', 'Tribal'];
  const NUM_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
  const NUM_RE = /\{(\d+)\}|(\d+)|\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g;
  const DRAWBACK_RE = /can't|cannot|sacrifice|lose|discard|skip|doesn't untap|enters( the battlefield)? tapped|counter it unless|you don't control|opponent (draws|gains|creates)|additional cost|any player may|blight|pay \{|pay \d|return (a|an|two) .* you control to/;

  class Engine {
    constructor() {
      this.cards = new Map();   // oid -> card
      this.list = [];           // index -> card
      this.index = new Map();   // oid -> index
      this.byName = new Map();  // normalized name -> oid
      this.tags = new Map();
      this.cardTags = new Map();
      this.settings = Object.assign({}, MC.DEFAULT_SETTINGS);
      this.decks = [];
      this.owned = new Map();
      this.ownedProxy = new Map();
      this.unmatched = [];
      this.usage = new Map();
      this.collectionInfo = null;
      this._resetDerived();
    }

    _resetDerived() {
      this._feat = null;        // per-index text features (built lazily)
      this._post = null;
      this._loose = null;
      this._idf = null;
      this._anc = new Map();
      this._exp = new Map();
      this._subCount = null;
      this._meta = null;
    }

    /* ------------------------------------------------------------ data loading */

    setCards(cards) {
      this.cards = new Map();
      this.list = [];
      this.index = new Map();
      this.byName = new Map();
      for (const c of cards) {
        this.index.set(c.oid, this.list.length);
        this.list.push(c);
        this.cards.set(c.oid, c);
      }
      // Full names win over face names when two cards collide.
      for (const c of this.list) this.byName.set(norm(c.name), c.oid);
      for (const c of this.list) {
        const parts = new Set([...(c.faces || []), ...c.name.split(' // ')]);
        for (const p of parts) { const k = norm(p); if (!this.byName.has(k)) this.byName.set(k, c.oid); }
      }
      this._resetDerived();
      this._rebuildUser();
    }

    setTags(tags, cardTagEntries) {
      this.tags = new Map();
      for (const t of tags) this.tags.set(t.id, Object.assign({}, t, { parents: [...t.parents], children: [...t.children] }));
      // The file lists links from both sides; make them symmetric and drop links to unknown tags.
      for (const t of this.tags.values()) {
        for (const p of t.parents) { const pt = this.tags.get(p); if (pt && !pt.children.includes(t.id)) pt.children.push(t.id); }
        for (const c of t.children) { const ct = this.tags.get(c); if (ct && !ct.parents.includes(t.id)) ct.parents.push(t.id); }
      }
      for (const t of this.tags.values()) {
        t.parents = t.parents.filter((x) => this.tags.has(x));
        t.children = t.children.filter((x) => this.tags.has(x));
      }
      this.cardTags = new Map(cardTagEntries);
      this.tagBySlug = new Map();
      for (const t of this.tags.values()) this.tagBySlug.set(t.slug, t.id);
      this._resetDerived();
    }

    setUser({ settings, decks, collection }) {
      this.settings = Object.assign({}, MC.DEFAULT_SETTINGS, settings || {});
      this.settings.boards = Object.assign({}, MC.DEFAULT_SETTINGS.boards, (settings && settings.boards) || {});
      this.decks = decks || [];
      this.collectionInfo = collection || null;
      this._rebuildUser();
    }

    _rebuildUser() {
      this.owned = new Map();      // real copies
      this.ownedProxy = new Map(); // playtest (proxy) copies in the collection
      this.unmatched = [];
      const fill = (src, into) => {
        for (const [name, qty] of Object.entries(src || {})) {
          const oid = this.lookup(name);
          if (oid) into.set(oid, (into.get(oid) || 0) + qty);
          else if (!this.unmatched.includes(name)) this.unmatched.push(name);
        }
      };
      fill(this.collectionInfo && this.collectionInfo.items, this.owned);
      if (this.settings.includePlaytest !== false) fill(this.collectionInfo && this.collectionInfo.proxies, this.ownedProxy);
      this.usage = new Map();
      for (const d of this.decks) {
        if (!this.deckCounts(d)) continue;
        const perOid = new Map();
        for (const e of d.cards) {
          if (!this.entryCounts(e)) continue;
          const oid = this.lookup(e.n);
          if (!oid) continue;
          perOid.set(oid, (perOid.get(oid) || 0) + e.q);
        }
        for (const [oid, q] of perOid) {
          let arr = this.usage.get(oid);
          if (!arr) this.usage.set(oid, (arr = []));
          arr.push({ id: d.publicId, name: d.name, format: d.format, q });
        }
      }
    }

    deckCounts(d) {
      return !!(d && d.cards && !d.excluded && this.settings.formats[d.format] !== false);
    }

    entryCounts(e) {
      return !!this.settings.boards[e.b] && (this.settings.countProxies || !e.p);
    }

    lookup(name) {
      if (!name) return null;
      const k = norm(name);
      return this.byName.get(k) || this.byName.get(k.split(' // ')[0]) || null;
    }

    /* ------------------------------------------------------------ availability */

    isBasic(oid) {
      const c = this.cards.get(oid);
      return !!c && /\bBasic\b/.test(c.type) && /\bLand\b/.test(c.type);
    }

    /**
     * Copies of a card and how many are free for the deck `currentDeckId`.
     * Moxfield decks cannot say whether they hold a real or a playtest copy, so other decks are
     * assumed to take real copies first. `realFree` is therefore the number of real copies that
     * are free for certain, and `free` counts real and playtest copies together.
     */
    availability(oid, currentDeckId) {
      const owned = this.owned.get(oid) || 0;
      const proxy = this.ownedProxy.get(oid) || 0;
      const total = owned + proxy;
      const uses = (this.usage.get(oid) || []).filter((u) => u.id !== currentDeckId);
      const used = uses.reduce((s, u) => s + u.q, 0);
      return {
        owned, proxy, total, used,
        free: Math.max(0, total - used),
        realFree: Math.max(0, owned - used),
        over: Math.max(0, used - total),
        uses, basic: this.isBasic(oid),
      };
    }

    /**
     * ok: enough real copies are free for certain. playtest: enough copies are free only when
     * playtest copies count. short: some copies are free, not enough. used: none are free.
     * missing: no copies at all.
     */
    static status(av, need) {
      if (av.basic) return 'basic';
      if (av.total === 0) return 'missing';
      if (av.realFree >= need) return 'ok';
      if (av.free >= need) return 'playtest';
      if (av.free > 0) return 'short';
      return 'used';
    }

    /** Status of every card in a deck that is open in the browser. */
    deckView(deck) {
      const id = deck.publicId;
      const needByOid = new Map();
      for (const e of deck.cards) {
        if (!this.entryCounts(e)) continue;
        const oid = this.lookup(e.n);
        if (oid) needByOid.set(oid, (needByOid.get(oid) || 0) + e.q);
      }
      const entries = {};
      const summary = { ok: 0, playtest: 0, short: 0, used: 0, missing: 0, basic: 0, unknown: 0, proxy: 0 };
      const problems = [];
      for (const e of deck.cards) {
        const oid = this.lookup(e.n);
        const counted = this.entryCounts(e);
        const need = counted ? needByOid.get(oid) || e.q : e.q;
        let info;
        if (!oid) info = { name: e.n, board: e.b, need, status: 'unknown' };
        else {
          const av = this.availability(oid, id);
          const status = e.p && !this.settings.countProxies && !av.basic ? 'proxy' : Engine.status(av, need);
          info = { oid, name: e.n, board: e.b, need, status, owned: av.owned, proxy: av.proxy, free: av.free, realFree: av.realFree, uses: av.uses };
        }
        // Moxfield's deck page marks each card element with data-hash = card.id (e.m).
        const key = e.m || e.u;
        if (key) {
          entries[`${e.b}|${key}`] = info;
          if (!entries[key] || counted) entries[key] = info;
        }
        if (counted || e.b === 'maybeboard') {
          if (summary[info.status] !== undefined && counted) summary[info.status] += 1;
          if (['playtest', 'short', 'used', 'missing'].includes(info.status)) problems.push(info);
        }
      }
      return {
        deck: { publicId: id, name: deck.name, format: deck.format, ci: this.deckColorIdentity(deck), author: deck.author },
        entries,
        byName: Object.fromEntries(Object.values(entries).map((x) => [norm(x.name), x])),
        summary,
        problems,
      };
    }

    deckColorIdentity(deck) {
      const cmd = deck.cards.filter((e) => e.b === 'commanders');
      if (cmd.length) {
        const s = new Set();
        for (const e of cmd) { const c = this.cards.get(this.lookup(e.n)); if (c) c.ci.forEach((x) => s.add(x)); }
        return [...s];
      }
      return deck.ci && deck.ci.length ? deck.ci : null;
    }

    /* ------------------------------------------------------------ tags */

    get metaTags() {
      if (this._meta) return this._meta;
      const s = new Set();
      for (const slug of META_ROOT_SLUGS) {
        const id = this.tagBySlug && this.tagBySlug.get(slug);
        if (id) for (const d of this.descendants(id)) s.add(d);
      }
      return (this._meta = s);
    }

    isHidden(tagId) {
      const t = this.tags.get(tagId);
      if (!t) return true;
      if (this.settings.hiddenTags.includes(tagId)) return true;
      if (this.settings.hideCycleTags && /^cycle(-|$)/.test(t.slug)) return true;
      return false;
    }

    /** Map ancestorId -> distance, for one tag (cycle safe). */
    ancestors(tagId) {
      let m = this._anc.get(tagId);
      if (m) return m;
      m = new Map();
      let frontier = [tagId];
      for (let depth = 1; frontier.length && depth < 12; depth++) {
        const next = [];
        for (const id of frontier) {
          const t = this.tags.get(id);
          if (!t) continue;
          for (const p of t.parents) if (p !== tagId && !m.has(p)) { m.set(p, depth); next.push(p); }
        }
        frontier = next;
      }
      this._anc.set(tagId, m);
      return m;
    }

    descendants(tagId) {
      const out = new Set([tagId]);
      const stack = [tagId];
      while (stack.length) {
        const t = this.tags.get(stack.pop());
        if (!t) continue;
        for (const c of t.children) if (!out.has(c)) { out.add(c); stack.push(c); }
      }
      return out;
    }

    /** A card's tags, direct and inherited, as tagId -> weight. */
    expandedTags(oid) {
      let m = this._exp.get(oid);
      if (m) return m;
      m = new Map();
      for (const [tid, w] of this.cardTags.get(oid) || []) {
        m.set(tid, Math.max(m.get(tid) || 0, w));
        for (const [a, d] of this.ancestors(tid)) {
          const aw = w * (d === 1 ? 0.45 : d === 2 ? 0.25 : 0.15);
          if ((m.get(a) || 0) < aw) m.set(a, aw);
        }
      }
      this._exp.set(oid, m);
      return m;
    }

    /** Cards per tag over the whole card pool, counting descendants. */
    get subtreeCount() {
      if (this._subCount) return this._subCount;
      const m = new Map();
      for (const c of this.list) for (const t of this.expandedTags(c.oid).keys()) m.set(t, (m.get(t) || 0) + 1);
      return (this._subCount = m);
    }

    tagIdf(tagId) {
      const n = this.list.length || 1;
      return Math.log(1 + n / (1 + (this.subtreeCount.get(tagId) || 0)));
    }

    tagView(tagId) {
      const t = this.tags.get(tagId);
      if (!t) return null;
      return { id: t.id, slug: t.slug, label: t.label, desc: t.desc, total: this.subtreeCount.get(t.id) || 0 };
    }

    /** A card's direct tags, most specific first, with their parent chain. */
    cardTagList(oid) {
      const out = [];
      for (const [tid] of this.cardTags.get(oid) || []) {
        if (this.isHidden(tid)) continue;
        const v = this.tagView(tid);
        if (!v) continue;
        v.meta = this.metaTags.has(tid);
        v.path = [...this.ancestors(tid).entries()].sort((a, b) => b[1] - a[1]).map(([id]) => this.tags.get(id)).filter(Boolean).map((x) => x.label);
        out.push(v);
      }
      out.sort((a, b) => (a.meta - b.meta) || (a.total - b.total));
      return out;
    }

    /* ------------------------------------------------------------ text features */

    _buildText() {
      if (this._feat) return;
      const subtypes = new Set();
      for (const c of this.list) {
        for (const part of c.type.split(' // ')) {
          const i = part.indexOf('—');
          if (i >= 0) for (const w of part.slice(i + 1).trim().split(/\s+/)) if (/^[A-Z][a-z'-]+$/.test(w)) subtypes.add(w);
        }
      }
      ['Treasure', 'Food', 'Clue', 'Blood', 'Map', 'Powerstone', 'Gold', 'Incubator'].forEach((x) => subtypes.add(x));
      this._subtypes = subtypes;
      const subRe = new RegExp(`\\b(${[...subtypes].sort((a, b) => b.length - a.length).map((s) => s.replace(/[-']/g, '\\$&')).join('|')})s?\\b`, 'g');

      const vocab = new Map();
      const df = [];
      const feats = new Array(this.list.length);
      for (let i = 0; i < this.list.length; i++) {
        const f = this._features(this.list[i], subRe);
        const ids = new Set();
        for (const b of f.grams) {
          let id = vocab.get(b);
          if (id === undefined) { id = vocab.size; vocab.set(b, id); df[id] = 0; }
          ids.add(id);
        }
        for (const id of ids) df[id]++;
        f.ids = Int32Array.from(ids);
        delete f.grams;
        feats[i] = f;
      }
      const n = this.list.length;
      const idf = df.map((d) => Math.log(1 + n / d));
      const post = new Map();
      const loose = new Map();
      for (let i = 0; i < n; i++) {
        const f = feats[i];
        let s = 0;
        for (const id of f.ids) {
          s += idf[id] * idf[id];
          if (df[id] <= 2500) { let p = post.get(id); if (!p) post.set(id, (p = [])); p.push(i); }
        }
        f.norm = Math.sqrt(s) || 1;
        if (f.loose) { let l = loose.get(f.loose); if (!l) loose.set(f.loose, (l = [])); l.push(i); }
      }
      this._feat = feats;
      this._idf = idf;
      this._post = post;
      this._loose = loose;
    }

    _features(c, subRe) {
      let t = c.text || '';
      const names = new Set([c.name, ...(c.faces || []), ...c.name.split(' // ')]);
      if (/Legendary/.test(c.type)) for (const n of [...names]) { const s = n.split(', ')[0]; if (s !== n && s.length >= 3) names.add(s); }
      for (const n of [...names].sort((a, b) => b.length - a.length)) if (n) t = t.split(n).join('~');
      t = t.replace(/\s*\([^)]*\)/g, '').replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
      const lines = [];
      for (let raw of t.split('\n')) {
        raw = raw.trim();
        if (!raw || raw === '//') continue;
        if (!/[.:"]/.test(raw) && raw.length < 90 && /,|;/.test(raw)) lines.push(...raw.split(/[,;]\s*/).map((x) => x.trim()).filter(Boolean));
        else lines.push(raw);
      }
      const exactLines = lines.map((l) => l.toLowerCase());
      const numify = (l) => l.replace(/\{(\d+)\}/g, '{#}').replace(/\d+/g, '#').replace(/\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/g, '#');
      const looseLines = lines.map((l) => numify(l
        .replace(subRe, 'TYPE')
        .replace(/\b(white|blue|black|red|green|colorless|multicolored)\b/gi, 'COLOR')
        .replace(/\b(Plains|Island|Swamp|Mountain|Forest)(walk|cycling)\b/g, 'TYPE$2')
        .replace(/\{[WUBRG](\/[WUBRGP])?\}/g, '{C}')
        .toLowerCase()));
      const exact = exactLines.join('\n');
      const nums = [];
      for (const m of exact.matchAll(NUM_RE)) nums.push({ v: m[1] != null ? +m[1] : m[2] != null ? +m[2] : NUM_WORDS[m[3]], cost: m[1] != null });
      const grams = new Set();
      for (const l of looseLines) {
        const toks = l.match(/[a-z~#{}+\-/']+/g) || [];
        for (let k = 0; k + 1 < toks.length; k++) grams.add(toks[k] + ' ' + toks[k + 1]);
        if (toks.length === 1) grams.add(toks[0]);
      }
      for (const k of c.kw || []) grams.add('kw:' + k.toLowerCase());
      const front = c.type.split(' // ')[0];
      const head = front.split('—')[0];
      const main = MAIN_TYPES.filter((x) => new RegExp(`\\b${x}\\b`).test(head));
      const subs = (front.split('—')[1] || '').trim().split(/\s+/).filter(Boolean);
      const cost0 = (c.cost || '').split(' // ')[0];
      const num = (v) => (v != null && /^\d+$/.test(String(v)) ? +v : null);
      return {
        exact,
        exactSet: new Set(exactLines),
        tmpl: exactLines.map(numify).join('\n'),
        loose: looseLines.join('\n'),
        nums,
        grams,
        main: main.join(' '),
        mainSet: new Set(main),
        subs,
        legendary: /Legendary/.test(head),
        pips: (cost0.match(/\{[WUBRG](\/[WUBRGP])?\}/g) || []).length,
        cost: c.cost || '',
        cmc: c.cmc || 0,
        pow: num(c.pow),
        tou: num(c.tou),
        loy: num(c.loy),
        colors: [...(c.colors || [])].sort().join(''),
      };
    }

    _textSim(a, b) {
      if (!a.ids.length && !b.ids.length) return a.main === b.main ? 1 : 0; // both vanilla
      if (!a.ids.length || !b.ids.length) return 0;
      const set = new Set(a.ids);
      let s = 0;
      for (const id of b.ids) if (set.has(id)) s += this._idf[id] * this._idf[id];
      return s / (a.norm * b.norm);
    }

    _tagVector(oid) {
      const v = new Map();
      for (const [t, w] of this.expandedTags(oid)) {
        if (this.settings.hiddenTags.includes(t)) continue;
        const meta = this.metaTags.has(t) ? 0.25 : 1;
        v.set(t, w * meta * this.tagIdf(t));
      }
      let s = 0;
      for (const x of v.values()) s += x * x;
      return { v, norm: Math.sqrt(s) || 1 };
    }

    _tagSim(a, b) {
      if (!a.v.size || !b.v.size) return { sim: 0, shared: [] };
      let s = 0;
      const shared = [];
      for (const [t, x] of a.v) {
        const y = b.v.get(t);
        if (y) { s += x * y; shared.push([t, Math.min(x, y)]); }
      }
      return { sim: s / (a.norm * b.norm), shared };
    }

    /** Is b a functional reprint, strictly better, strictly worse or a close variant of a? */
    classify(a, b, ca, cb) {
      // Instants and sorceries compare with each other; speed becomes one more dimension.
      const speed = (f) => (f.mainSet.has('Instant') ? 1 : f.mainSet.has('Sorcery') ? 0 : null);
      const spell = (f) => f.main.replace(/\b(Instant|Sorcery)\b/, 'Spell');
      if (spell(a) !== spell(b)) return null;
      const speedDelta = speed(a) != null && speed(b) != null ? speed(b) - speed(a) : 0;
      // A card without a mana cost (suspend-only, for example) is not comparable on cost.
      const uncastable = (f) => f.cost === '' && !f.mainSet.has('Land');
      if (uncastable(a) !== uncastable(b)) return null;
      const why = [];
      const ci = (c) => c.ci.join('');
      if (!speedDelta && a.exact === b.exact && a.cost === b.cost && a.pow === b.pow && a.tou === b.tou && a.loy === b.loy && a.legendary === b.legendary) {
        const diff = [];
        if (a.subs.join(' ') !== b.subs.join(' ')) diff.push(`type ${b.subs.join(' ') || '(none)'}`);
        return { cls: 'reprint', why: ['Same rules text, cost and stats', ...diff] };
      }
      if (a.tmpl === b.tmpl && a.nums.length === b.nums.length) {
        const d = [];
        d.push(['mana value', a.cmc - b.cmc]);
        if (a.cmc === b.cmc) d.push(['colored pips', a.pips - b.pips]);
        if (a.pow != null && b.pow != null) d.push(['power', b.pow - a.pow]);
        if (a.tou != null && b.tou != null) d.push(['toughness', b.tou - a.tou]);
        if (a.loy != null && b.loy != null) d.push(['loyalty', b.loy - a.loy]);
        a.nums.forEach((n, i) => d.push([n.cost ? 'ability cost' : 'number in text', n.cost ? n.v - b.nums[i].v : b.nums[i].v - n.v]));
        if (a.legendary !== b.legendary) d.push(['legendary', a.legendary ? 1 : -1]);
        if (speedDelta) d.push(['speed (instant vs. sorcery)', speedDelta]);
        const up = d.filter((x) => x[1] > 0);
        const down = d.filter((x) => x[1] < 0);
        const colorNote = ci(ca) !== ci(cb) ? [`color identity ${ci(cb) || 'colorless'}`] : [];
        const fmt = (x) => `${x[1] > 0 ? 'better' : 'worse'} ${x[0]}`;
        if (up.length && !down.length) return { cls: 'better', why: [...up.map(fmt), ...colorNote] };
        if (down.length && !up.length) return { cls: 'worse', why: [...down.map(fmt), ...colorNote] };
        if (!up.length && !down.length) {
          if (a.exact === b.exact && a.cost !== b.cost) return { cls: 'variant', why: ['Same text, different colors', ...colorNote] };
          return { cls: 'variant', why: ['Same template', ...colorNote] };
        }
        return { cls: 'variant', why: ['Trade-off: ' + [...up, ...down].map(fmt).join(', '), ...colorNote] };
      }
      // Same abilities plus or minus whole lines (for example an extra keyword).
      const sub = (x, y) => { for (const l of x.exactSet) if (!y.exactSet.has(l)) return false; return y.exactSet.size > x.exactSet.size; };
      const costOK = (x, y) => y.cmc <= x.cmc && (y.cmc < x.cmc || y.pips <= x.pips) && speed(y) === speed(x);
      const statsOK = (x, y) => (x.pow == null || y.pow == null || y.pow >= x.pow) && (x.tou == null || y.tou == null || y.tou >= x.tou);
      if (a.exactSet.size && sub(a, b) && costOK(a, b) && statsOK(a, b)) {
        const extra = [...b.exactSet].filter((l) => !a.exactSet.has(l));
        if (!extra.some((l) => DRAWBACK_RE.test(l))) return { cls: 'better', why: ['Same, plus: ' + extra.join('; ')] };
        why.push('Same, plus a possible drawback: ' + extra.join('; '));
        return { cls: 'variant', why };
      }
      if (b.exactSet.size && sub(b, a) && costOK(b, a) && statsOK(b, a)) {
        const missing = [...a.exactSet].filter((l) => !b.exactSet.has(l));
        if (!missing.some((l) => DRAWBACK_RE.test(l))) return { cls: 'worse', why: ['Same, minus: ' + missing.join('; ')] };
        return { cls: 'variant', why: ['Same, without: ' + missing.join('; ')] };
      }
      if (a.loose === b.loose) {
        const diffs = [];
        if (a.cmc !== b.cmc) diffs.push(`mana value ${b.cmc}`);
        if (ci(ca) !== ci(cb)) diffs.push(`color identity ${ci(cb) || 'colorless'}`);
        if (a.subs.join(' ') !== b.subs.join(' ')) diffs.push(`type ${b.subs.join(' ')}`);
        if (speedDelta) diffs.push(speedDelta > 0 ? 'instant speed' : 'sorcery speed');
        return { cls: 'variant', why: ['Same effect, different ' + (diffs.length ? diffs.join(', ') : 'numbers or token/creature types')] };
      }
      return null;
    }

    /* ------------------------------------------------------------ similarity search */

    /**
     * opts: { pool: 'owned'|'available'|'all', ci: ['W',...]|null, legal: 'commander'|null,
     *         cmcDelta: number|null, sameType: bool, spectrum: 0..1, exclude: [oid], deckId, limit }
     */
    similar(oid, opts = {}) {
      this._buildText();
      const i = this.index.get(oid);
      if (i === undefined) return null;
      const src = this.list[i];
      const a = this._feat[i];
      const aTags = this._tagVector(oid);
      const s = Math.min(1, Math.max(0, opts.spectrum == null ? 0.5 : opts.spectrum));
      const W = { text: 0.6 - 0.4 * s, tag: 0.2 + 0.45 * s, cmc: 0.1, type: 0.1 - 0.05 * s };
      const exclude = new Set(opts.exclude || []);
      exclude.add(oid);
      const ciSet = opts.ci ? new Set(opts.ci) : null;
      const pool = opts.pool || 'owned';
      const srcBasic = this.isBasic(oid);

      let cand;
      if (pool === 'all') {
        cand = new Set(this._loose.get(a.loose) || []);
        const ids = [...a.ids].filter((id) => this._post.has(id)).sort((x, y) => this._idf[y] - this._idf[x]).slice(0, 30);
        for (const id of ids) for (const j of this._post.get(id)) cand.add(j);
        const tagIds = [...aTags.v.entries()].filter(([t]) => (this.subtreeCount.get(t) || 0) < 2500).sort((x, y) => y[1] - x[1]).slice(0, 12).map(([t]) => t);
        const want = new Set(tagIds.flatMap((t) => [...this.descendants(t)]));
        if (want.size) for (const [o, tl] of this.cardTags) if (tl.some(([t]) => want.has(t))) { const j = this.index.get(o); if (j !== undefined) cand.add(j); }
      } else {
        cand = new Set();
        for (const o of this.ownedOids()) { const j = this.index.get(o); if (j !== undefined) cand.add(j); }
      }

      const groups = { reprint: [], better: [], worse: [], variant: [], role: [] };
      for (const j of cand) {
        const c = this.list[j];
        if (exclude.has(c.oid)) continue;
        if (!srcBasic && this.isBasic(c.oid)) continue;
        if (ciSet && !c.ci.every((x) => ciSet.has(x))) continue;
        if (opts.legal && !c.legal.includes(opts.legal)) continue;
        const b = this._feat[j];
        if (opts.sameType && a.main && b.main && ![...a.mainSet].some((x) => b.mainSet.has(x))) continue;
        let av = null;
        if (pool !== 'all') {
          av = this.availability(c.oid, opts.deckId);
          if (pool === 'available' && !(av.free > 0 || av.basic)) continue;
        }
        const cls = this.classify(a, b, src, c);
        if (opts.cmcDelta != null && Math.abs(c.cmc - src.cmc) > opts.cmcDelta && !cls) continue;
        const text = this._textSim(a, b);
        const tag = this._tagSim(aTags, this._tagVector(c.oid));
        const cmc = Math.exp(-Math.abs(c.cmc - src.cmc) / 1.5);
        const inter = [...a.mainSet].filter((x) => b.mainSet.has(x)).length;
        const uni = new Set([...a.mainSet, ...b.mainSet]).size || 1;
        const type = inter / uni;
        const score = W.text * text + W.tag * tag.sim + W.cmc * cmc + W.type * type;
        if (!cls && score < 0.18) continue;
        const r = { j, score, text, tag: tag.sim, shared: tag.shared, cls: cls && cls.cls, why: cls ? cls.why : [] };
        groups[cls ? cls.cls : 'role'].push(r);
      }
      const limit = opts.limit || 40;
      const out = {};
      for (const [k, arr] of Object.entries(groups)) {
        arr.sort((x, y) => y.score - x.score);
        out[k] = arr.slice(0, k === 'role' ? limit : 25).map((r) => this._result(r, opts.deckId, pool));
      }
      return { source: this.cardSummary(oid, opts.deckId), groups: out, weights: W, considered: cand.size };
    }

    _result(r, deckId) {
      const c = this.list[r.j];
      const shared = r.shared
        .filter(([t]) => !this.isHidden(t) && !this.metaTags.has(t))
        .sort((x, y) => y[1] - x[1])
        .slice(0, 4)
        .map(([t]) => ({ id: t, label: this.tags.get(t).label }));
      const why = r.why.slice();
      if (!why.length) why.push(`text ${(r.text * 100).toFixed(0)}% · tags ${(r.tag * 100).toFixed(0)}%`);
      return Object.assign(this.cardSummary(c.oid, deckId), { score: +r.score.toFixed(3), why, shared });
    }

    cardSummary(oid, deckId) {
      const c = this.cards.get(oid);
      if (!c) return null;
      const av = this.availability(oid, deckId);
      return {
        oid, name: c.name, cost: c.cost, cmc: c.cmc, type: c.type, img: c.img, uri: c.uri, ci: c.ci,
        pow: c.pow, tou: c.tou, owned: av.owned, proxy: av.proxy, total: av.total, free: av.free, realFree: av.realFree,
        used: av.used, uses: av.uses, basic: av.basic,
      };
    }

    cardInfo(oid, deckId) {
      const c = this.cards.get(oid);
      if (!c) return null;
      return Object.assign(this.cardSummary(oid, deckId), { text: c.text, legal: c.legal, tags: this.cardTagList(oid) });
    }

    searchNames(q, limit = 12) {
      const k = norm(q);
      if (k.length < 2) return [];
      const starts = [];
      const contains = [];
      for (const c of this.list) {
        const n = norm(c.name);
        if (n.startsWith(k)) starts.push(c);
        else if (contains.length < limit && n.includes(k)) contains.push(c);
        if (starts.length >= limit) break;
      }
      return [...starts, ...contains].slice(0, limit).map((c) => ({ oid: c.oid, name: c.name, owned: this.owned.get(c.oid) || 0, proxy: this.ownedProxy.get(c.oid) || 0 }));
    }

    /* ------------------------------------------------------------ exploration */

    _poolCards(opts) {
      const ciSet = opts.ci ? new Set(opts.ci) : null;
      const src = opts.pool === 'all' ? this.list.map((c) => c.oid) : this.ownedOids();
      const out = [];
      for (const oid of src) {
        const c = this.cards.get(oid);
        if (!c) continue;
        if (ciSet && !c.ci.every((x) => ciSet.has(x))) continue;
        if (opts.legal && !c.legal.includes(opts.legal)) continue;
        if (opts.type && !new RegExp(`\\b${opts.type}\\b`).test(c.type)) continue;
        if (opts.pool === 'available') { const av = this.availability(oid, opts.deckId); if (!(av.free > 0)) continue; }
        out.push(oid);
      }
      return out;
    }

    _poolTagCounts(oids) {
      const m = new Map();
      for (const oid of oids) for (const t of this.expandedTags(oid).keys()) m.set(t, (m.get(t) || 0) + 1);
      return m;
    }

    /**
     * Tag listing for exploration.
     * opts.parent: tag id to list children of. opts.mode: 'functions' (top-level functional groups)
     * or 'all' (every tag, searchable). opts.query filters by slug, label, alias and description.
     */
    exploreTags(opts = {}) {
      const oids = this._poolCards(opts);
      const counts = this._poolTagCounts(oids);
      const meta = this.metaTags;
      const row = (t) => ({
        id: t.id, label: t.label, desc: t.desc, count: counts.get(t.id) || 0,
        children: t.children.filter((c) => (counts.get(c) || 0) > 0 && !this.isHidden(c)).length,
        meta: meta.has(t.id),
      });
      let list;
      if (opts.parent) {
        const p = this.tags.get(opts.parent);
        list = p ? p.children.map((id) => this.tags.get(id)) : [];
      } else if (opts.mode === 'all' || opts.query) {
        list = [...this.tags.values()];
        if (opts.query) {
          const q = opts.query.toLowerCase();
          list = list.filter((t) => t.slug.includes(q) || t.label.toLowerCase().includes(q) || t.aliases.some((a) => a.includes(q)) || (t.desc || '').toLowerCase().includes(q));
        }
      } else {
        list = [...this.tags.values()].filter((t) => !t.parents.length && t.children.length);
      }
      const rows = list.filter((t) => t && !this.isHidden(t.id) && (counts.get(t.id) || 0) > 0).map(row);
      if (!opts.parent && opts.mode !== 'all' && !opts.query) rows.sort((x, y) => (x.meta - y.meta) || (y.count - x.count));
      else rows.sort((x, y) => y.count - x.count);
      const parent = opts.parent ? this.tags.get(opts.parent) : null;
      return {
        poolSize: oids.length,
        parent: parent && { id: parent.id, label: parent.label, desc: parent.desc, count: counts.get(parent.id) || 0, parents: parent.parents.map((p) => ({ id: p, label: this.tags.get(p).label })) },
        tags: rows.slice(0, opts.limit || 400),
      };
    }

    /** Cards in the pool under a tag, grouped by the child tag they come from. */
    exploreTagCards(opts) {
      const t = this.tags.get(opts.tagId);
      if (!t) return null;
      const oids = new Set(this._poolCards(opts));
      const groupOf = new Map();  // child tag id -> Set(oid)
      const direct = new Set();
      const childSubtrees = t.children.filter((c) => !this.isHidden(c)).map((c) => [c, this.descendants(c)]);
      const self = this.descendants(t.id);
      for (const oid of oids) {
        const tl = this.cardTags.get(oid) || [];
        if (!tl.some(([x]) => self.has(x))) continue;
        let placed = false;
        for (const [c, sub] of childSubtrees) {
          if (tl.some(([x]) => sub.has(x))) {
            let s = groupOf.get(c);
            if (!s) groupOf.set(c, (s = new Set()));
            s.add(oid);
            placed = true;
          }
        }
        if (!placed || tl.some(([x]) => x === t.id)) direct.add(oid);
      }
      const card = (oid) => this.cardSummary(oid, opts.deckId);
      const sortCards = (arr) => arr.map(card).sort((x, y) => x.cmc - y.cmc || x.name.localeCompare(y.name));
      const groups = [...groupOf.entries()]
        .map(([c, s]) => ({ id: c, label: this.tags.get(c).label, cards: sortCards([...s]) }))
        .sort((x, y) => y.cards.length - x.cards.length);
      const all = new Set([...direct, ...[...groupOf.values()].flatMap((s) => [...s])]);
      return {
        tag: { id: t.id, label: t.label, desc: t.desc, parents: t.parents.map((p) => ({ id: p, label: this.tags.get(p).label })) },
        direct: sortCards([...direct]),
        groups,
        total: all.size,
        flat: opts.flat ? sortCards([...all]) : undefined,
      };
    }

    /** Every card you have at least one copy of, real or playtest. */
    ownedOids() {
      return [...new Set([...this.owned.keys(), ...this.ownedProxy.keys()])];
    }

    stats() {
      const sum = (m) => { let s = 0; for (const q of m.values()) s += q; return s; };
      let proxyOnly = 0;
      for (const o of this.ownedProxy.keys()) if (!this.owned.has(o)) proxyOnly++;
      return {
        cards: this.list.length,
        tags: this.tags.size,
        taggedCards: this.cardTags.size,
        decks: this.decks.length,
        decksCounted: this.decks.filter((d) => this.deckCounts(d)).length,
        ownedUnique: this.owned.size + proxyOnly,
        ownedCopies: sum(this.owned),
        playtestUnique: this.ownedProxy.size,
        playtestOnly: proxyOnly,
        playtestCopies: sum(this.ownedProxy),
        unmatched: this.unmatched.length,
      };
    }
  }

  MC.Engine = Engine;
})(typeof globalThis !== 'undefined' ? globalThis : this);
