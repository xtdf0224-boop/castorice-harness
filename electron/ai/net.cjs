'use strict';
// Network rules for model access (MODELS-SPEC §6.5, §12). Everything here is a pure check or a fetch with limits;
// nothing imports Electron at load time (so check-services runs it in plain Node), and nothing logs a URL's secrets.
//
//   checkBaseUrl      the only gate a service address passes through (https, or http on the loopback only)
//   checkHeaderName / checkHeaderValue / checkModelId / checkExtraBody
//   expandUrl         {placeholder} → value, with the value pattern-checked, then checkBaseUrl again
//   fetchStream       fetch for streamed replies (first-byte timeout, redirect:'error', never follows a redirect)
//   fetchLimited      fetch for lists / probes (timeout and a hard byte cap)

/* ───────────── addresses ───────────── */

const MAX_URL = 512;
/** http is allowed for these hosts and nothing else (D1: no LAN http). */
const LOOPBACK_HTTP = new Set(['127.0.0.1', 'localhost', '[::1]']);
const META_NAMES = new Set(['metadata.google.internal', 'metadata.goog']);

/** Dotted quad → [a,b,c,d], or null. (URL has already turned 0x7f.1 / 2130706433 style hosts into this form.) */
function ipv4Parts(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}

/** [::ffff:a9fe:a9fe] (an IPv4-mapped IPv6 literal) → [169,254,169,254], or null. */
function mappedV4(host) {
  const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}

function isMetadataHost(host) {
  const h = host.replace(/\.$/, '');
  if (META_NAMES.has(h)) return true;
  if (h === '[fd00:ec2::254]') return true;
  const v4 = ipv4Parts(h) || mappedV4(h);
  if (!v4) return false;
  if (v4[0] === 169 && v4[1] === 254) return true;                        // 169.254.0.0/16 (cloud metadata, link-local)
  if (v4[0] === 100 && v4[1] === 100 && v4[2] === 100 && v4[3] === 200) return true; // Alibaba Cloud metadata
  return false;
}

/** A private / internal https host: allowed, but saving asks the user first. */
function isPrivateHost(host) {
  const h = host.replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true;
  const v4 = ipv4Parts(h) || mappedV4(h);
  if (v4) {
    const [a, b] = v4;
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.startsWith('[')) {
    const inner = h.slice(1, -1).toLowerCase();
    return inner === '::1' || /^f[cd][0-9a-f]{2}:/.test(inner) || /^fe[89ab][0-9a-f]:/.test(inner);
  }
  return false;
}

/**
 * The one gate a service address goes through.
 * @param {unknown} input
 * @returns {{ url: string, private: boolean, host: string, loopback: boolean } | null}
 */
function checkBaseUrl(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > MAX_URL) return null;
  // a query string or a fragment never belongs to an API root (also catches an empty `?` / `#` that URL would drop)
  if (/[?#]/.test(s)) return null;
  if (/[\u0000- \u007f\\]/.test(s)) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === 'http:') {
    if (!LOOPBACK_HTTP.has(u.hostname)) return null;
  } else if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.hash || u.search) return null;
  if (!u.hostname || isMetadataHost(u.hostname)) return null;
  if (u.port !== '') { const n = Number(u.port); if (!(n >= 1 && n <= 65535)) return null; }
  const url = u.toString().replace(/\/+$/, '');
  return { url, private: u.protocol === 'https:' && isPrivateHost(u.hostname), host: u.host, loopback: LOOPBACK_HTTP.has(u.hostname) };
}

/** True when the (already checked) address is plain http on the loopback. */
const isLoopbackHttp = (url) => { try { const u = new URL(url); return u.protocol === 'http:' && LOOPBACK_HTTP.has(u.hostname); } catch { return false; } };

/** A comparable form of an address (for "is this the same endpoint as that one"). */
function canonUrl(input) {
  const c = checkBaseUrl(input);
  return c ? c.url.toLowerCase() : '';
}

/**
 * Whitespace of every kind (NBSP, BOM, ideographic space…), control and invisible format characters never belong in a stored address.
 * checkBaseUrl trims and so lets them through; whatever is SAVED must not depend on that, or two readers of the same text could
 * see two different hosts (the confirmation said nothing while the request went to the trimmed one).
 */
const ADDRESS_BAD_CHARS = /[\p{White_Space}\p{Cc}\p{Cf}]/u;

/**
 * The host a stored address (maybe with {placeholders}) sends a key to, in the one spelling the confirmations, the saved
 * approvals and the runtime check all use: lower case, punycode, no default port. '' when the address is not acceptable.
 */
function hostOfAddress(addr) {
  if (typeof addr !== 'string' || ADDRESS_BAD_CHARS.test(addr)) return '';
  if (placeholderNames(addr).length) {
    // a template: the real host only exists once a request fills it in; the approval is for the template's host
    const m = /^https?:\/\/([^/]*)/.exec(addr);
    return m ? m[1].toLowerCase() : '';
  }
  const c = checkBaseUrl(addr);
  return c ? c.host : '';
}

/* ───────────── {placeholders} in addresses ───────────── */

const PLACEHOLDER = /\{([A-Za-z][A-Za-z0-9]{0,23})\}/g;
/** A substituted value is one DNS-label-like token whatever the declared pattern says. */
const SAFE_VALUE = /^[A-Za-z0-9_-]{1,63}$/;

const placeholderNames = (template) => [...String(template).matchAll(PLACEHOLDER)].map((m) => m[1]);

/** Structure rules for a template (the substituted value can never change the registrable domain). Returns an error string or ''. */
function templateProblem(template) {
  const t = String(template);
  if (!placeholderNames(t).length) return '';
  const m = /^(https?):\/\/([^/]*)(\/.*)?$/.exec(t);
  if (!m) return '地址格式不对';
  const hostPort = m[2];
  if (!placeholderNames(hostPort).length) return '';   // placeholders only in the path
  if (/[@[\]]/.test(hostPort)) return '带占位符的主机里不能有 @ 或 IPv6 写法';
  const colon = hostPort.indexOf(':');
  const hostOnly = colon < 0 ? hostPort : hostPort.slice(0, colon);
  if (colon >= 0 && /[{}]/.test(hostPort.slice(colon))) return '端口里不能有占位符';
  const labels = hostOnly.split('.');
  if (labels.length < 3) return '带占位符的主机至少要有三段（占位符 + 固定的域名）';
  // the last two labels (the registrable domain) are literal text
  if (/[{}]/.test(labels.slice(-2).join('.'))) return '占位符不能出现在主机的最后两段';
  // each placeholder sits inside one label, bounded by a dot, a dash or the host edges
  for (const label of labels) {
    if (!/[{}]/.test(label)) continue;
    const stripped = label.replace(/\{[A-Za-z][A-Za-z0-9]{0,23}\}/g, '\u0001');
    if (/[{}]/.test(stripped)) return '占位符写法不对';
    if (!/^[A-Za-z0-9\u0001-]+$/.test(stripped)) return '占位符所在的一段只能含字母、数字、-';
    if (/\u0001[A-Za-z0-9]|[A-Za-z0-9]\u0001/.test(stripped)) return '占位符必须独占一段，或与相邻内容用 - 隔开';
  }
  return '';
}

/**
 * Fill {placeholders} and run the result through checkBaseUrl.
 * @param {string} template
 * @param {Array<{ name: string, pattern: string }>} defs
 * @param {Record<string, unknown>} params
 * @returns {{ ok: true, url: string, check: object } | { ok: false, error: string, field?: string }}
 */
function expandUrl(template, defs, params) {
  const bad = templateProblem(template);
  if (bad) return { ok: false, error: bad };
  const p = params && typeof params === 'object' ? params : {};
  let failure = null;
  const filled = String(template).replace(PLACEHOLDER, (all, name) => {
    if (failure) return all;
    const def = (defs || []).find((d) => d && d.name === name);
    if (!def) { failure = { ok: false, error: `地址里的 {${name}} 没有声明`, field: name }; return all; }
    const v = Object.hasOwn(p, name) ? p[name] : undefined;
    if (typeof v !== 'string' || !v) { failure = { ok: false, error: `请填写「${def.label || name}」`, field: name }; return all; }
    let re;
    try { re = new RegExp(def.pattern); } catch { failure = { ok: false, error: `「${def.label || name}」的格式规则无效`, field: name }; return all; }
    if (!SAFE_VALUE.test(v) || !re.test(v)) { failure = { ok: false, error: `「${def.label || name}」格式不对${def.example ? `，例如 ${def.example}` : ''}`, field: name }; return all; }
    return v;
  });
  if (failure) return failure;
  const check = checkBaseUrl(filled);
  if (!check) return { ok: false, error: '服务地址不符合安全规则（只允许 https，或本机的 http）' };
  return { ok: true, url: check.url, check };
}

/** The four probe strings a placeholder pattern must refuse (it must not be able to change a host suffix or a path). */
const PATTERN_PROBES = ['a.b', 'a/b', 'a@b', 'a:b'];
function patternProblem(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 120) return '格式规则无效';
  let re;
  try { re = new RegExp(pattern); } catch { return '格式规则不是合法的正则'; }
  if (PATTERN_PROBES.some((x) => re.test(x))) return '格式规则不能接受 . / @ : 这些字符';
  return '';
}

/* ───────────── headers, model ids, extra body ───────────── */

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const HEADER_FORBIDDEN = new Set([
  'host', 'content-length', 'content-type', 'accept', 'cookie', 'set-cookie', 'connection', 'transfer-encoding', 'te', 'upgrade', 'expect', 'origin',
  // Kimi Code's terms forbid altering the client User-Agent; one rule for every service
  'user-agent',
]);
/** Authentication is decided by `auth` alone: a static header may not carry it. */
const HEADER_AUTH_NAMES = new Set(['authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'anthropic-version']);

/** @param {{ auth?: boolean }} [o] auth: the name of the header that carries the key (auth.scheme 'header') */
function checkHeaderName(name, o = {}) {
  if (typeof name !== 'string' || !HEADER_NAME.test(name)) return false;
  const n = name.toLowerCase();
  if (HEADER_FORBIDDEN.has(n) || n.startsWith('proxy-') || n.startsWith('content-') || n.startsWith('sec-')) return false;
  if (!o.auth && HEADER_AUTH_NAMES.has(n)) return false;
  return true;
}
const checkHeaderValue = (v) => typeof v === 'string' && v.length <= 256 && /^[\x20-\x7e]*$/.test(v);

/** Model ids go into URLs, command lines and request bodies: one rule for the API and CLI paths. `~` and `@` are real ids (OpenRouter, Cloudflare). */
const MODEL_ID = /^[\w.\-:/@~[\]]{1,100}$/;
const checkModelId = (id) => typeof id === 'string' && MODEL_ID.test(id);

const EXTRA_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/;
const EXTRA_BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const EXTRA_FORBIDDEN_TOP = new Set([
  'model', 'messages', 'stream', 'stream_options', 'system', 'tools', 'tool_choice', 'functions', 'function_call',
  'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'input', 'prompt', 'n',
]);

/**
 * Extra request-body fields of a custom service (§9.5): a JSON object, ≤ 4 KB, depth ≤ 4.
 * @returns {{ ok: true, value: Record<string, unknown> } | { ok: false, error: string }}
 */
function checkExtraBody(obj) {
  if (obj === undefined || obj === null) return { ok: true, value: {} };
  if (typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: '额外请求体必须是 JSON 对象' };
  let text;
  try { text = JSON.stringify(obj); } catch { return { ok: false, error: '额外请求体不是合法的 JSON' }; }
  if (text.length > 4096) return { ok: false, error: '额外请求体不能超过 4 KB' };
  const walk = (v, depth, top) => {
    if (v === null || typeof v === 'boolean') return { ok: true, value: v };
    if (typeof v === 'number') return Number.isFinite(v) ? { ok: true, value: v } : { ok: false, error: '数字必须是有限值' };
    if (typeof v === 'string') return v.length <= 200 ? { ok: true, value: v } : { ok: false, error: '字符串值不能超过 200 个字符' };
    if (Array.isArray(v)) {
      if (v.length > 20) return { ok: false, error: '数组不能超过 20 项' };
      const out = [];
      for (const x of v) {
        if (x !== null && typeof x === 'object') return { ok: false, error: '数组里只能放字符串、数字、布尔值' };
        const r = walk(x, depth, false);
        if (!r.ok) return r;
        out.push(r.value);
      }
      return { ok: true, value: out };
    }
    if (typeof v === 'object') {
      if (depth >= 4) return { ok: false, error: '嵌套不能超过 4 层' };
      const out = {};
      for (const k of Object.keys(v)) {
        if (!EXTRA_KEY.test(k) || EXTRA_BAD_KEYS.has(k)) return { ok: false, error: `字段名「${k.slice(0, 20)}」不合法` };
        if (top && EXTRA_FORBIDDEN_TOP.has(k)) return { ok: false, error: `不能覆盖「${k}」` };
        const r = walk(v[k], depth + 1, false);
        if (!r.ok) return r;
        out[k] = r.value;
      }
      return { ok: true, value: out };
    }
    return { ok: false, error: '不支持的值类型' };
  };
  return walk(obj, 0, true);
}

/* ───────────── fetch ───────────── */

/** Where requests go out. Electron's net.fetch (Chromium's stack: it follows the system proxy) once the app is ready — verified by
 *  scripts/fixtures/v11-netfetch-main.cjs (proxy, redirect:'error', streaming, AbortSignal) — otherwise Node's global fetch. */
let forced = null;
function transport() {
  if (forced) return forced;
  try {
    // Plain Node returns the electron binary's path (a string) for require('electron'): no `net` then.
    const e = require('electron');
    if (e && e.net && typeof e.net.fetch === 'function' && e.app && e.app.isReady()) return { name: 'electron', fetch: (u, i) => e.net.fetch(u, i) };
  } catch { /* not running under Electron */ }
  return { name: 'node', fetch: (u, i) => fetch(u, i) };
}
/** Tests: pin the transport ('node' | null). */
function __forceTransport(name) { forced = name === 'node' ? { name: 'node', fetch: (u, i) => fetch(u, i) } : null; }
const transportName = () => transport().name;

const CHROMIUM_ERRORS = {
  ERR_NAME_NOT_RESOLVED: 'ENOTFOUND', ERR_CONNECTION_REFUSED: 'ECONNREFUSED', ERR_CONNECTION_RESET: 'ECONNRESET', ERR_CONNECTION_CLOSED: 'ECONNRESET',
  ERR_CONNECTION_TIMED_OUT: 'ETIMEDOUT', ERR_TIMED_OUT: 'ETIMEDOUT', ERR_INTERNET_DISCONNECTED: 'ENETDOWN', ERR_NETWORK_CHANGED: 'ENETDOWN',
  ERR_PROXY_CONNECTION_FAILED: 'EPROXY', ERR_TUNNEL_CONNECTION_FAILED: 'EPROXY', ERR_SSL_PROTOCOL_ERROR: 'ECERT', ERR_CERT_AUTHORITY_INVALID: 'ECERT',
  ERR_CERT_DATE_INVALID: 'ECERT', ERR_CERT_COMMON_NAME_INVALID: 'ECERT', ERR_ADDRESS_UNREACHABLE: 'ENETUNREACH', ERR_UNSAFE_PORT: 'EUNSAFEPORT',
};
const NET_TEXT = {
  ENOTFOUND: '找不到这个主机名（检查服务地址和网络）', ECONNREFUSED: '连接被拒绝（服务没有在运行，或端口不对）', ECONNRESET: '连接被中断', ETIMEDOUT: '连接超时',
  ECERT: '证书不被信任', EPROXY: '代理连不上', ENETDOWN: '网络不可用', ENETUNREACH: '网络不可达', EUNSAFEPORT: '这个端口被系统网络栈禁用（浏览器内核的限制），请换一个端口',
};
/** 「网络错误：连接被拒绝（服务没有在运行，或端口不对）[ECONNREFUSED]」 */
const netMessage = (code) => `网络错误：${NET_TEXT[code] ? `${NET_TEXT[code]} [${code}]` : code}`;
/** A fetch failure → a short code (Node: error.cause.code; Chromium: net::ERR_*). */
function errorCode(e) {
  const c = e && e.cause && e.cause.code;
  if (c) return String(c);
  const m = /net::(ERR_[A-Z_]+)/.exec(String(e && e.message));
  if (m) return CHROMIUM_ERRORS[m[1]] || m[1];
  return 'ENETWORK';
}
/** A redirect that redirect:'error' refused. */
function isRedirectError(e) {
  const m = String(e && (e.message || '')) + String(e && e.cause && e.cause.message || '');
  // Node: "unexpected redirect"; Chromium: "Attempted to redirect, but redirect policy was 'error'"
  return /redirect/i.test(m);
}

const FIRST_BYTE_MS = 90_000;

/**
 * Open a streamed (SSE) response. The key must only go to the address the registry resolved: never follow a redirect.
 * @param {string} url
 * @param {{ method?: string, headers: Record<string,string>, body?: string }} init
 * @param {{ signal?: AbortSignal, firstByteMs?: number }} [o]
 * @returns {Promise<Response>}
 */
async function fetchStream(url, init, o = {}) {
  const first = new AbortController();
  const timer = setTimeout(() => first.abort(), o.firstByteMs ?? FIRST_BYTE_MS);
  const outer = o.signal;
  const onAbort = () => first.abort();
  if (outer) { if (outer.aborted) first.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  try {
    return await transport().fetch(url, { method: init.method || 'POST', headers: init.headers, body: init.body, signal: first.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    if (outer && outer.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
    if (first.signal.aborted) throw Object.assign(new Error('连接超时：服务没有响应'), { code: 'ETIMEDOUT' });
    if (isRedirectError(e)) throw Object.assign(new Error('服务地址发生了重定向，为了保护密钥栖枝不会跟随。请把服务地址改成最终地址。'), { code: 'EREDIRECT' });
    const code = errorCode(e);
    throw Object.assign(new Error(netMessage(code)), { code });
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

/**
 * A small non-streaming request (model lists, probes): a timeout and a hard cap on the bytes read.
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string }} [init]
 * @param {{ timeoutMs?: number, maxBytes?: number, signal?: AbortSignal }} [o]
 * @returns {Promise<{ ok: boolean, status: number, text: string, json: unknown, truncated: boolean, headers: Headers }>}
 */
async function fetchLimited(url, init = {}, o = {}) {
  const timeoutMs = o.timeoutMs ?? 15_000;
  const maxBytes = o.maxBytes ?? 8 * 1024 * 1024;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const outer = o.signal;
  const onAbort = () => ac.abort();
  if (outer) { if (outer.aborted) ac.abort(); else outer.addEventListener('abort', onAbort, { once: true }); }
  try {
    let res;
    try {
      res = await transport().fetch(url, { method: init.method || 'GET', headers: init.headers || {}, body: init.body, signal: ac.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
    } catch (e) {
      if (outer && outer.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
      if (ac.signal.aborted) throw Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' });
      if (isRedirectError(e)) throw Object.assign(new Error('服务地址发生了重定向，栖枝不会跟随'), { code: 'EREDIRECT' });
      const code = errorCode(e);
      throw Object.assign(new Error(netMessage(code)), { code });
    }
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      try { await res.body?.cancel(); } catch { /* closing */ }
      throw Object.assign(new Error('响应太大，已放弃'), { code: 'ETOOBIG' });
    }
    const chunks = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > maxBytes) { truncated = true; await reader.cancel().catch(() => {}); break; }
          chunks.push(value);
        }
      } catch (e) {
        if (outer && outer.aborted) throw Object.assign(new Error('已取消'), { code: 'ABORTED' });
        if (ac.signal.aborted) throw Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' });
        throw Object.assign(new Error(netMessage(errorCode(e))), { code: errorCode(e) });
      }
    }
    if (truncated) throw Object.assign(new Error('响应太大，已放弃'), { code: 'ETOOBIG' });
    const text = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    return { ok: res.ok, status: res.status, text, json: parsed, truncated, headers: res.headers };
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  checkBaseUrl, isLoopbackHttp, canonUrl, hostOfAddress, ADDRESS_BAD_CHARS, isMetadataHost, isPrivateHost,
  PLACEHOLDER, placeholderNames, templateProblem, expandUrl, patternProblem, PATTERN_PROBES,
  checkHeaderName, checkHeaderValue, checkModelId, MODEL_ID, checkExtraBody, EXTRA_FORBIDDEN_TOP,
  fetchStream, fetchLimited, errorCode, netMessage, FIRST_BYTE_MS, transportName, __forceTransport,
};
