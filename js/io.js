/* Diecast Vault — export (JSON / CSV), import (JSON) and image processing */
window.DV = window.DV || {};

DV.io = (() => {
  const { normalize } = DV.store;

  function download(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportJSON(items) {
    const payload = {
      app: 'Diecast Vault',
      version: 1,
      exportedAt: new Date().toISOString(),
      count: items.length,
      items,
    };
    download('diecast_collection.json', JSON.stringify(payload, null, 2), 'application/json');
  }

  // Quote every cell and neutralise spreadsheet formula injection (=, +, -, @).
  const csvCell = (value) => {
    let s = value == null ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };

  function exportCSV(items) {
    const header = ['#', 'List', 'Diecast Brand', 'Car Brand', 'Model', 'Scale', 'Series', 'Condition', 'Shelved', 'Photo', 'Date Added'];
    const lines = items.map((it, i) => [
      i + 1,
      it.wishlist ? 'Wishlist' : 'Collection',
      it.diecastBrand,
      it.carBrand,
      it.model,
      it.scale,
      it.series,
      it.condition,
      it.shelved ? 'Yes' : 'No',
      it.image.startsWith('data:') ? '(uploaded photo — see JSON backup)' : it.image,
      new Date(it.createdAt).toISOString().slice(0, 10),
    ].map(csvCell).join(','));
    // BOM so Excel opens UTF-8 correctly; CRLF per RFC 4180.
    download('diecast_collection.csv', '﻿' + [header.map(csvCell).join(','), ...lines].join('\r\n'), 'text/csv;charset=utf-8');
  }

  /** Parses an exported file (or a bare array). Throws with a user-facing message on failure. */
  function parseImport(text) {
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('That file isn’t valid JSON.');
    }
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
    if (!list) throw new Error('No collection found in that file.');
    const items = list.map(normalize).filter(Boolean);
    if (!items.length) throw new Error('The file didn’t contain any valid models.');
    return { items, skipped: list.length - items.length };
  }

  function readText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Couldn’t read that file.'));
      reader.readAsText(file);
    });
  }

  /* ─── Image compression ─────────────────────────────────── */
  /** Approximate decoded size of a base64 data URL, in bytes. */
  const dataURLBytes = (url) => Math.round((url.length - url.indexOf(',') - 1) * 0.75);

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('That image couldn’t be read.'));
      img.src = src;
    });
  }

  // WebP is ~30% smaller than JPEG at the same quality; Safari can't encode it and returns PNG instead.
  let webp = null;
  function encode(canvas, quality) {
    if (webp !== false) {
      const out = canvas.toDataURL('image/webp', quality);
      webp = out.startsWith('data:image/webp');
      if (webp) return out;
    }
    return canvas.toDataURL('image/jpeg', quality);
  }

  /**
   * Downscales and re-encodes an image until it fits the byte budget:
   * steps quality down first, then resolution, never below MIN_IMAGE_EDGE.
   */
  async function compressImage(src, { maxEdge = DV.config.MAX_IMAGE_EDGE, maxBytes = DV.config.MAX_IMAGE_BYTES } = {}) {
    const img = await loadImage(src);
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    if (!w || !h) throw new Error('That image couldn’t be read.');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let edge = Math.min(maxEdge, Math.max(w, h));
    let best = '';
    for (;;) {
      const scale = edge / Math.max(w, h);
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      ctx.fillStyle = '#161920'; // background for transparent PNGs
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      for (const q of [0.82, 0.72, 0.62]) {
        const out = encode(canvas, q);
        if (!best || out.length < best.length) best = out;
        if (dataURLBytes(out) <= maxBytes) return best;
      }
      if (edge <= DV.config.MIN_IMAGE_EDGE) return best;
      edge = Math.max(DV.config.MIN_IMAGE_EDGE, Math.round(edge * 0.8));
    }
  }

  /** Compresses an uploaded image file into a compact data URL. */
  async function imageToDataURL(file) {
    if (!file || !file.type.startsWith('image/')) throw new Error('Please choose an image file.');
    const url = URL.createObjectURL(file);
    try {
      return await compressImage(url);
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Recompresses an already-stored data URL if it's over budget; returns the smaller of old and new. */
  async function shrinkDataURL(url) {
    if (!url.startsWith('data:image/') || dataURLBytes(url) <= DV.config.MAX_IMAGE_BYTES) return url;
    try {
      const out = await compressImage(url);
      return out.length < url.length ? out : url;
    } catch {
      return url;
    }
  }

  return { exportJSON, exportCSV, parseImport, readText, imageToDataURL, shrinkDataURL, dataURLBytes };
})();
