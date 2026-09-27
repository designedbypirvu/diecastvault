/* Diecast Vault — persistence layer (IndexedDB, localStorage fallback) + item normalisation */
window.DV = window.DV || {};

DV.store = (() => {
  const { STORAGE_KEY, PREFS_KEY, CONDITIONS } = DV.config;

  const uid = () =>
    (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);

  const str = (v) => (v == null ? '' : String(v).trim());

  const isSafeImage = (url) => /^(https?:\/\/|data:image\/[a-z0-9.+-]+;base64,)/i.test(url);

  function normalizeCondition(value) {
    const v = str(value).toLowerCase();
    const exact = CONDITIONS.find((c) => c.value.toLowerCase() === v);
    if (exact) return exact.value;
    if (/mint|box|card|sealed|moc|nib/.test(v)) return CONDITIONS[0].value;
    if (/custom/.test(v)) return CONDITIONS[2].value;
    return CONDITIONS[1].value;
  }

  function toTime(v, fallback) {
    const n = typeof v === 'number' ? v : Date.parse(v);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /** Coerces any object into a valid collection item, or returns null if unusable. */
  function normalize(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const now = Date.now();
    const image = str(raw.image);
    const item = {
      id: str(raw.id) || uid(),
      diecastBrand: str(raw.diecastBrand),
      carBrand: str(raw.carBrand),
      model: str(raw.model),
      scale: str(raw.scale) || '1:64',
      series: str(raw.series),
      condition: normalizeCondition(raw.condition),
      shelved: raw.shelved === true || /^(true|yes|1)$/i.test(str(raw.shelved)),
      image: isSafeImage(image) ? image : '',
      createdAt: toTime(raw.createdAt, now),
      updatedAt: 0,
    };
    item.updatedAt = toTime(raw.updatedAt, item.createdAt);
    if (!item.model || (!item.carBrand && !item.diecastBrand)) return null;
    item.diecastBrand ||= 'Unknown';
    item.carBrand ||= 'Unknown';
    return item;
  }

  /* Items live in IndexedDB (hundreds of MB available) — localStorage caps out around 5 MB,
     which only fits a dozen or so photos. localStorage is kept as a fallback and migrated from. */
  const DB_NAME = 'diecastvault';
  const ITEMS = 'items';
  const META = 'meta';

  let backend = 'idb';        // 'idb' | 'local'
  let db = null;
  let persisted = new Map();  // id -> item object last written, so saves only touch what changed
  let queue = Promise.resolve();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(DB_NAME) : null;

  const done = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const finished = (tx) => new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('Transaction aborted'));
  });

  function openDB() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) { reject(new Error('IndexedDB unavailable')); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(ITEMS, { keyPath: 'id' });
        req.result.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB blocked'));
    });
  }

  const isQuota = (err) => err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);

  function loadLocal() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(normalize).filter(Boolean) : [];
    } catch {
      return null;
    }
  }

  function saveLocal(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      return 'ok';
    } catch (err) {
      return isQuota(err) ? 'quota' : 'unavailable';
    }
  }

  async function writeIDB(items) {
    const next = new Map(items.map((it) => [it.id, it]));
    const tx = db.transaction([ITEMS, META], 'readwrite');
    const os = tx.objectStore(ITEMS);
    next.forEach((it, id) => { if (persisted.get(id) !== it) os.put(it); });
    persisted.forEach((_, id) => { if (!next.has(id)) os.delete(id); });
    tx.objectStore(META).put(true, 'initialized');
    await finished(tx);
    persisted = next;
  }

  /** @returns {Promise<Array|null>} items, or null when nothing has ever been saved. */
  async function load() {
    if (!db && backend === 'idb') {
      try {
        db = await openDB();
        navigator.storage?.persist?.().catch(() => {});
      } catch {
        backend = 'local';
      }
    }
    if (backend === 'local') return loadLocal();

    const tx = db.transaction([ITEMS, META], 'readonly');
    const [rows, initialized] = await Promise.all([
      done(tx.objectStore(ITEMS).getAll()),
      done(tx.objectStore(META).get('initialized')),
    ]);

    if (!initialized) {
      // First run on IndexedDB: carry over a collection saved by the old localStorage version.
      const legacy = loadLocal();
      if (legacy === null) return null;
      try {
        await writeIDB(legacy);
      } catch {
        backend = 'local';
        return legacy;
      }
      try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
      return legacy;
    }

    const items = rows.map(normalize).filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
    persisted = new Map(items.map((it) => [it.id, it]));
    return items;
  }

  /** Writes are queued so they land in order. @returns {Promise<'ok'|'quota'|'unavailable'>} */
  function save(items) {
    const run = queue.then(async () => {
      if (backend === 'local') return saveLocal(items);
      try {
        await writeIDB(items);
        channel?.postMessage('changed');
        return 'ok';
      } catch (err) {
        return isQuota(err) ? 'quota' : 'unavailable';
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  /** Calls back when another tab changes the collection. */
  function onExternalChange(callback) {
    channel?.addEventListener('message', callback);
    window.addEventListener('storage', (e) => { if (backend === 'local' && e.key === STORAGE_KEY) callback(); });
  }

  function loadPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
    } catch {
      return {};
    }
  }

  function savePrefs(prefs) {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* preferences are a convenience — ignore */
    }
  }

  return { uid, normalize, isSafeImage, load, save, onExternalChange, loadPrefs, savePrefs };
})();
