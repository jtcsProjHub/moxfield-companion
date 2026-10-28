/* Small promise wrapper around IndexedDB. Stores use out-of-line keys. */
(function (g) {
  const MC = (g.MC = g.MC || {});
  const DB_NAME = 'moxfield-companion';
  const VERSION = 1;
  const STORES = ['cards', 'tags', 'cardTags', 'decks', 'meta'];
  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function done(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Transaction aborted'));
    });
  }

  function reqP(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  MC.db = {
    async get(store, key) {
      const db = await open();
      return reqP(db.transaction(store).objectStore(store).get(key));
    },
    async put(store, key, value) {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      return done(tx);
    },
    async del(store, key) {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      return done(tx);
    },
    async values(store) {
      const db = await open();
      return reqP(db.transaction(store).objectStore(store).getAll());
    },
    /** Returns [[key, value], ...]. */
    async entries(store) {
      const db = await open();
      const os = db.transaction(store).objectStore(store);
      const [keys, vals] = await Promise.all([reqP(os.getAllKeys()), reqP(os.getAll())]);
      return keys.map((k, i) => [k, vals[i]]);
    },
    async count(store) {
      const db = await open();
      return reqP(db.transaction(store).objectStore(store).count());
    },
    /** Clear a store and write all entries in one transaction (all or nothing). */
    async replaceAll(store, entries) {
      const db = await open();
      const tx = db.transaction(store, 'readwrite');
      const os = tx.objectStore(store);
      os.clear();
      for (const [k, v] of entries) os.put(v, k);
      return done(tx);
    },
    async clearAll() {
      const db = await open();
      const tx = db.transaction(STORES, 'readwrite');
      for (const s of STORES) tx.objectStore(s).clear();
      return done(tx);
    },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
