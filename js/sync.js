/* Diecast Vault — cloud sync: Google sign-in, Supabase database + photo storage.
   The browser keeps its own copy (store.js) so the app opens instantly and works offline;
   this module pushes local edits up and pulls other devices' edits down. Last edit wins. */
window.DV = window.DV || {};

DV.sync = (() => {
  const C = DV.config;
  const { store } = DV;

  const enabled = Boolean(C.SUPABASE_URL && C.SUPABASE_KEY && window.supabase?.createClient);
  const BUCKET = 'photos';
  const LINK_KEY = 'diecastvault.sync.link.v1';       // { userId, cursor } — which account this device mirrors
  const PENDING_KEY = 'diecastvault.sync.pending.v1'; // { id: seq } — local edits not yet in the cloud
  const DEMO_KEY = 'diecastvault.demo.v1';            // ids of the demo cars, never uploaded
  const SIGNING_IN_KEY = 'diecastvault.signingIn';     // set across the Google redirect
  const PAGE = 1000;
  const CHUNK = 100;
  const PHOTO_CONCURRENCY = 4;

  const readJSON = (key, fallback) => {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  };
  const writeJSON = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  };

  let client = null;
  let hooks = null;          // { getItems, apply, ask, toast, onStatus } from app.js
  let user = null;
  let link = readJSON(LINK_KEY, {});
  let pending = readJSON(PENDING_KEY, {});
  let seq = Math.max(0, ...Object.values(pending));
  let channel = null;
  let timer = 0;
  let running = null;
  let again = false;
  let failures = 0;
  const status = { state: enabled ? 'signed-out' : 'disabled', user: null, pending: 0, lastSynced: 0, progress: '' };

  const savePending = () => writeJSON(PENDING_KEY, pending);
  const saveLink = () => writeJSON(LINK_KEY, link);

  function setStatus(patch) {
    Object.assign(status, patch, { pending: Object.keys(pending).length, user });
    hooks?.onStatus({ ...status });
  }

  function markPending(ids) {
    ids.forEach((id) => { pending[id] = ++seq; });
    savePending();
    setStatus({});
  }

  /** Photos we host are public URLs under our bucket. */
  const photoPrefix = enabled ? `${C.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/` : null;
  const isHostedPhoto = (url) => Boolean(photoPrefix && typeof url === 'string' && url.startsWith(photoPrefix));

  /* ─── Scheduling ─────────────────────────────────────────────── */
  function schedule(delay = 800) {
    if (!user) return;
    clearTimeout(timer);
    timer = setTimeout(run, delay);
  }

  /** One sync pass at a time; a request during a pass queues exactly one more. */
  async function run() {
    if (!user) return;
    if (running) { again = true; return running; }
    running = (async () => {
      setStatus({ state: 'syncing', progress: '', error: '' });
      try {
        if (link.userId !== user.id) await firstLink();
        else {
          await pull();
          await push();
        }
        failures = 0;
        if (user) setStatus({ state: 'synced', lastSynced: Date.now(), progress: '' });
      } catch (err) {
        failures++;
        console.warn('[sync]', err);
        setStatus({ state: navigator.onLine === false ? 'offline' : 'error', progress: '', error: err?.message || String(err) });
        schedule(Math.min(5 * 60_000, 15_000 * 2 ** (failures - 1)));
      }
    })();
    await running;
    running = null;
    if (again) { again = false; schedule(0); }
  }

  /* ─── Rows ↔ items ───────────────────────────────────────────── */
  const toRow = (item) => ({ user_id: user.id, id: item.id, data: item, updated_at: item.updatedAt, deleted: false });
  const tombstone = (id) => ({ user_id: user.id, id, data: {}, updated_at: Date.now(), deleted: true });
  const fromRow = (row) => store.normalize({ ...row.data, id: row.id, updatedAt: row.updated_at });
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  async function fetchSince(cursor) {
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      let q = client.from('cars').select('id, data, updated_at, deleted, synced_at')
        .order('synced_at', { ascending: true }).order('id', { ascending: true })
        .range(from, from + PAGE - 1);
      if (cursor) q = q.gt('synced_at', cursor);
      const { data, error } = await q;
      if (error) throw error;
      rows.push(...data);
      if (data.length < PAGE) return rows;
    }
  }

  /** Folds cloud rows into the local list. Returns the new list, or null if nothing changed. */
  function merge(items, rows) {
    const map = new Map(items.map((it) => [it.id, it]));
    let changed = false;
    rows.forEach((row) => {
      const local = map.get(row.id);
      if (row.deleted) {
        if (local && row.updated_at >= local.updatedAt) {
          map.delete(row.id);
          delete pending[row.id];
          changed = true;
        }
        return;
      }
      const remote = fromRow(row);
      if (!remote) return;
      const newer = !local || row.updated_at > local.updatedAt || (row.updated_at === local.updatedAt && !pending[row.id]);
      if (newer) {
        delete pending[row.id];
        if (!local || !same(local, remote)) { map.set(row.id, remote); changed = true; }
      }
    });
    savePending();
    return changed ? [...map.values()].sort((a, b) => b.createdAt - a.createdAt) : null;
  }

  async function pull() {
    const rows = await fetchSince(link.cursor);
    if (!rows.length) return;
    await hooks.apply((items) => merge(items, rows));
    link.cursor = rows[rows.length - 1].synced_at;
    saveLink();
  }

  /* ─── Photos ─────────────────────────────────────────────────── */
  async function uploadPhoto(item) {
    const blob = await (await fetch(item.image)).blob();
    const ext = { 'image/webp': 'webp', 'image/png': 'png' }[blob.type] || 'jpg';
    const path = `${user.id}/${item.id}/${Date.now().toString(36)}.${ext}`;
    const { error } = await client.storage.from(BUCKET).upload(path, blob, {
      contentType: blob.type || 'image/jpeg',
      cacheControl: '31536000', // every upload gets a new path, so it can be cached forever
      upsert: false,
    });
    if (error) throw error;
    return client.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  }

  /** Uploads photos still stored inline, then swaps them for their cloud URL on this device too. */
  async function uploadPhotos(ids) {
    const items = new Map(hooks.getItems().map((it) => [it.id, it]));
    const todo = ids.map((id) => items.get(id)).filter((it) => it?.image.startsWith('data:'));
    if (!todo.length) return;
    const uploaded = new Map(); // id -> { from, to }
    const total = todo.length;
    let done = 0;
    let failed = 0;
    const next = () => todo.shift();
    const worker = async () => {
      for (let it = next(); it; it = next()) {
        try {
          uploaded.set(it.id, { from: it.image, to: await uploadPhoto(it) });
        } catch (err) {
          failed++;
          console.warn('[sync] photo upload failed', it.id, err);
        }
        done++;
        if (total > 3) setStatus({ progress: `Uploading photos ${done}/${total}` });
      }
    };
    await Promise.all(Array.from({ length: PHOTO_CONCURRENCY }, worker));
    if (uploaded.size) {
      // Same edit time: this is the same photo, just stored elsewhere now.
      await hooks.apply((list) => {
        let changed = false;
        const out = list.map((it) => {
          const u = uploaded.get(it.id);
          if (!u || it.image !== u.from) return it;
          changed = true;
          return { ...it, image: u.to };
        });
        return changed ? out : null;
      });
    }
    if (failed && !uploaded.size) throw new Error('Photo upload failed');
  }

  /* ─── Push ───────────────────────────────────────────────────── */
  async function push() {
    const batch = Object.entries(pending);
    if (!batch.length) return;
    await uploadPhotos(batch.map(([id]) => id));

    const items = new Map(hooks.getItems().map((it) => [it.id, it]));
    const rows = [];
    batch.forEach(([id]) => {
      const it = items.get(id);
      if (!it) rows.push(tombstone(id));
      else if (!it.image.startsWith('data:')) rows.push(toRow(it)); // photo not uploaded yet: retry later
    });

    const rejected = [];
    const sent = new Map(batch);
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      if (rows.length > CHUNK) setStatus({ progress: `Saving ${Math.min(i + CHUNK, rows.length)}/${rows.length} models` });
      const { data, error } = await client.from('cars').upsert(chunk, { onConflict: 'user_id,id' }).select('id');
      if (error) throw error;
      const accepted = new Set(data.map((r) => r.id));
      chunk.forEach((r) => {
        if (!accepted.has(r.id)) rejected.push(r.id);
        // Drop from the queue unless it was edited again while we were uploading.
        if (pending[r.id] === sent.get(r.id)) delete pending[r.id];
      });
      savePending();
      setStatus({});
    }

    // The cloud refused these because another device saved a newer edit: take that one.
    if (rejected.length) {
      const { data, error } = await client.from('cars').select('id, data, updated_at, deleted, synced_at').in('id', rejected);
      if (error) throw error;
      await hooks.apply((list) => merge(list, data));
    }
  }

  /* ─── First sign-in on this device ───────────────────────────── */
  async function firstLink() {
    const rows = await fetchSince(null);
    const remoteIds = new Set(rows.map((r) => r.id));
    const demo = new Set(readJSON(DEMO_KEY, []));
    const items = hooks.getItems();
    const localOnly = items.filter((it) => !remoteIds.has(it.id) && !(demo.has(it.id) && it.updatedAt === it.createdAt));
    const cloudCount = rows.filter((r) => !r.deleted).length;

    let upload = false;
    if (localOnly.length) {
      const n = localOnly.length;
      const models = `${n} model${n === 1 ? '' : 's'}`;
      upload = await hooks.ask({
        title: cloudCount ? `Add ${models} from this device?` : `Upload ${models} to your account?`,
        body: cloudCount
          ? `Your account already has ${cloudCount} models. This device has ${models} that aren’t in it yet. Skipping removes them from this device.`
          : `Your account is empty. Upload what’s on this device, or skip and import a backup instead.`,
        icon: 'cloud-upload',
        tone: 'info',
        actions: [
          { label: 'Skip', value: 'skip' },
          { label: 'Upload', value: 'upload', variant: 'primary' },
        ],
      });
      if (!upload) {
        // Dialog dismissed: leave this device exactly as it was.
        await signOut();
        hooks.toast('Sign-in cancelled — nothing on this device was changed.', { type: 'info' });
        return;
      }
      upload = upload === 'upload';
    }

    const keep = new Set(upload ? localOnly.map((it) => it.id) : []);
    pending = {};
    await hooks.apply((list) => {
      const base = list.filter((it) => remoteIds.has(it.id) || keep.has(it.id));
      return merge(base, rows) || (base.length !== list.length ? base : null);
    });
    // Upload the kept local-only models, plus any this device edited more recently than the cloud.
    const byId = new Map(rows.map((r) => [r.id, r]));
    const newer = hooks.getItems().filter((it) => byId.has(it.id) && it.updatedAt > byId.get(it.id).updated_at);
    markPending([...keep, ...newer.map((it) => it.id)]);
    link = { userId: user.id, cursor: rows.length ? rows[rows.length - 1].synced_at : null };
    saveLink();
    await push();
  }

  /* ─── Live updates ───────────────────────────────────────────── */
  function listen() {
    channel?.unsubscribe();
    channel = client.channel(`cars:${user.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cars', filter: `user_id=eq.${user.id}` }, () => schedule(400))
      .subscribe();
  }

  function onSession(session) {
    const next = session?.user ?? null;
    if (next?.id === user?.id) return;
    user = next;
    if (!user) {
      channel?.unsubscribe();
      channel = null;
      setStatus({ state: 'signed-out' });
      return;
    }
    listen();
    let welcome = false;
    try {
      welcome = sessionStorage.getItem(SIGNING_IN_KEY) === '1';
      sessionStorage.removeItem(SIGNING_IN_KEY);
    } catch { /* ignore */ }
    setStatus({ state: 'syncing', welcome });
    status.welcome = false;
    schedule(0);
  }

  /* ─── Public API ─────────────────────────────────────────────── */
  function init(appHooks) {
    hooks = appHooks;
    store.onLocalWrite(({ changed, removed }) => { markPending([...changed, ...removed]); schedule(); });
    if (!enabled) { setStatus({}); return; }

    client = window.supabase.createClient(C.SUPABASE_URL, C.SUPABASE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    });
    client.auth.onAuthStateChange((event, session) => {
      // Tidy the ?code=… left in the address bar by the Google redirect.
      if (session && /[?&]code=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash);
      // Supabase warns against awaiting its API inside this callback — defer.
      setTimeout(() => onSession(session), 0);
    });

    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') schedule(300); });
    window.addEventListener('online', () => schedule(300));
    setInterval(() => { if (document.visibilityState === 'visible') schedule(0); }, 2 * 60_000);
    setStatus({});
  }

  async function signIn() {
    if (!client) return;
    if (location.protocol === 'file:') {
      hooks.toast('Sign-in needs the app to be opened from a web address, not a file on disk.', { type: 'error' });
      return;
    }
    try { sessionStorage.setItem(SIGNING_IN_KEY, '1'); } catch { /* ignore */ }
    const { error } = await client.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: location.origin + location.pathname },
    });
    if (error) hooks.toast(`Couldn’t start sign-in: ${error.message}`, { type: 'error' });
  }

  async function signOut() {
    await client?.auth.signOut();
    onSession(null);
  }

  /** Remembers which cars are the demo set, so a fresh device never uploads them. */
  const rememberDemo = (items) => writeJSON(DEMO_KEY, items.map((it) => it.id));

  return { enabled, init, signIn, signOut, syncNow: () => schedule(0), rememberDemo, isHostedPhoto, status: () => ({ ...status }) };
})();
