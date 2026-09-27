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
    const header = ['#', 'Diecast Brand', 'Car Brand', 'Model', 'Scale', 'Series / Year', 'Condition', 'Shelved', 'Photo', 'Date Added'];
    const lines = items.map((it, i) => [
      i + 1,
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

  /** Downscales an image file and returns a compact base64 JPEG data URL. */
  function imageToDataURL(file, maxEdge = DV.config.MAX_IMAGE_EDGE) {
    return new Promise((resolve, reject) => {
      if (!file || !file.type.startsWith('image/')) {
        reject(new Error('Please choose an image file.'));
        return;
      }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#161920';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.84));
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('That image couldn’t be read.'));
      };
      img.src = url;
    });
  }

  return { exportJSON, exportCSV, parseImport, readText, imageToDataURL };
})();
