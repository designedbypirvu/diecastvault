/* Diecast Vault — persistence layer (localStorage) + item normalisation */
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

  /** @returns {Array|null} items, or null when nothing has ever been saved. */
  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw == null) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map(normalize).filter(Boolean) : [];
    } catch {
      return null;
    }
  }

  /** @returns {'ok'|'quota'|'unavailable'} */
  function save(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
      return 'ok';
    } catch (err) {
      const quota = err && (err.name === 'QuotaExceededError' || err.code === 22 || err.code === 1014);
      return quota ? 'quota' : 'unavailable';
    }
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

  return { uid, normalize, isSafeImage, load, save, loadPrefs, savePrefs };
})();
