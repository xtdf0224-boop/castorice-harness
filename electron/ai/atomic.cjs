'use strict';
// Small JSON files the main process owns (services.json, model-cache.json): read tolerantly, write atomically.
// Same three steps as secrets.cjs: write a temp file, rename it over the old one; if rename fails (an AppData filter driver can
// make it EXDEV) write in place, and if that fails put the old content back. A damaged file is renamed aside, never overwritten.
const fs = require('node:fs');
const path = require('node:path');

/**
 * @param {string} file
 * @param {{ maxBytes?: number }} [o]
 * @returns {{ state: 'ok', data: unknown } | { state: 'missing' | 'corrupt' | 'unreadable' | 'toobig' }}
 */
function readJson(file, o = {}) {
  let text;
  try {
    const st = fs.statSync(file);
    if (o.maxBytes && st.size > o.maxBytes) return { state: 'toobig' };
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { state: e && e.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
  try { return { state: 'ok', data: JSON.parse(text) }; } catch { return { state: 'corrupt' }; }
}

/** Throws on failure; the old file is left as it was (or put back). */
function writeJson(file, value, o = {}) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, o.indent ?? 2);
  if (o.maxBytes && Buffer.byteLength(body) > o.maxBytes) throw Object.assign(new Error('文件超过大小上限'), { code: 'ETOOBIG' });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try { fs.renameSync(tmp, file); return; } catch { /* in place below */ }
  let old = null;
  try { old = fs.readFileSync(file, 'utf8'); } catch { /* no old file */ }
  try {
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    if (old !== null) { try { fs.writeFileSync(file, old, { encoding: 'utf8', mode: 0o600 }); } catch { /* best effort */ } }
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* leave it */ }
  }
}

/** Rename a damaged file out of the way (keep it for the user); returns the new name or '' when that failed. */
function setAside(file) {
  const dest = `${file}.corrupt-${Date.now()}`;
  try { fs.renameSync(file, dest); return dest; } catch { return ''; }
}

module.exports = { readJson, writeJson, setAside };
