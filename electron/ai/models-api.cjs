'use strict';
// Live model lists (MODELS-SPEC §8): svc:models / svc:model-detail.
//
//   · progressive enhancement — the presets are the floor, the live list adds to it, the user can always type an id; a list that cannot
//     be fetched (no key, offline, 404) never breaks a chat;
//   · whatever comes back is UNTRUSTED data (I10): ids must pass the same rule as everywhere (checkModelId), text is cleaned and capped,
//     at most 1000 entries and 8 MB per answer, anything of the wrong shape is a failure that leaves the old cache alone;
//   · the key is read only for the request, goes to the endpoint's own address, never into the cache or an error;
//   · nothing here runs on its own: the page asks (a click, or opening 模型接入 for services that are already configured).
//
// The cache is userData/model-cache.json: { v:1, entries:{ "service|endpoint|params|••••abcd": { at, models:[…] } } } — no keys (only the hint).
const net = require('./net.cjs');
const atomic = require('./atomic.cjs');
const { authHeaders } = require('./api.cjs');
const { scrubValue } = require('./scrub.cjs');

const MAX_MODELS = 1000;
const MAX_PAGES = 10;
const CACHE_MAX_BYTES = 4 * 1024 * 1024;
const TTL_LOCAL = 30_000;
const TTL_DEFAULT = 6 * 3600 * 1000;
/** A list that just failed is not asked for again for this long (unless the person pressed 刷新): a dead server is not hammered by every dropdown that opens. */
const FAIL_MEMORY_MS = 15_000;
const SCALE = ['low', 'medium', 'high', 'xhigh', 'max'];
/** ids that are not chat models (embedding, speech, images…); a heuristic — a wrongly dropped model can still be typed in. */
const NOT_CHAT = /embed|rerank|whisper|tts|speech|transcri|moderation|dall-e|image|video|sora|realtime|audio|ocr|guard/i;

/* ───────────── cleaning (I10) ───────────── */

const text = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 1 && v < 2 ** 31 ? Math.floor(v) : undefined);
const firstNum = (o, keys) => { for (const k of keys) { const n = num(o && o[k]); if (n) return n; } return undefined; };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** One raw entry → a ModelDef the page can show, or null (bad id). */
function finish(raw) {
  if (!raw || !net.checkModelId(raw.id)) return null;
  const m = { id: raw.id };
  const label = text(raw.label, 80); if (label && label !== raw.id) m.label = label;
  const note = text(raw.note, 120); if (note) m.note = note;
  if (num(raw.ctx)) m.ctx = num(raw.ctx);
  if (num(raw.maxOut)) m.maxOut = num(raw.maxOut);
  if (raw.caps) { const c = {}; for (const k of ['tools', 'vision', 'reasoning']) if (typeof raw.caps[k] === 'boolean') c[k] = raw.caps[k]; if (Object.keys(c).length) m.caps = c; }
  if (['active', 'preview', 'retiring', 'deprecated', 'retired'].includes(raw.status)) m.status = raw.status;
  if (typeof raw.retiresAt === 'string' && /^\d{4}-\d{2}-\d{2}/.test(raw.retiresAt)) m.retiresAt = raw.retiresAt.slice(0, 10);
  if (raw.effort && isObj(raw.effort)) {
    const levels = (Array.isArray(raw.effort.levels) ? raw.effort.levels : []).filter((l) => l === 'off' || SCALE.includes(l));
    if (levels.length && ['anthropic', 're', 're-think', 'think-switch', 'enable-thinking', 'minimax', 'openrouter'].includes(raw.effort.style)) {
      m.effort = { style: raw.effort.style, levels: ['off', ...SCALE].filter((l) => levels.includes(l)) };
      if (['none', 'disabled', 'between_tools'].includes(raw.effort.offWire)) m.effort.offWire = raw.effort.offWire;
      if (SCALE.includes(raw.effort.default) || raw.effort.default === 'on') m.effort.default = raw.effort.default;
    }
  }
  m.source = 'live';
  return m;
}

/** A list of raw entries from a response: `{data:[…]}`, `{models:[…]}` or the array itself. */
function itemsOf(json, ...keys) {
  if (Array.isArray(json)) return json;
  if (isObj(json)) for (const k of keys) if (Array.isArray(json[k])) return json[k];
  return null;
}
const hasModality = (v, what) => Array.isArray(v) && v.some((x) => String(x).toLowerCase() === what);
const effortLevelsFrom = (list) => {
  const levels = [];
  for (const e of Array.isArray(list) ? list : []) {
    const s = String(e && (e.reasoningEffort || e.effort || e.id || e)).toLowerCase();
    if (SCALE.includes(s)) levels.push(s); else if (s === 'none' || s === 'off') levels.push('off');
  }
  return [...new Set(levels)];
};

/* ───────────── the ten parsers: response JSON → raw entries ───────────── */

const parsers = {
  openai(json) {
    const items = itemsOf(json, 'data', 'models');
    if (!items) return null;
    return items.map((it) => {
      if (typeof it === 'string') return { id: it };
      if (!isObj(it)) return null;
      const tags = Array.isArray(it.metadata && it.metadata.tags) ? it.metadata.tags.map(String) : [];
      const caps = {};
      const inMods = (it.architecture && it.architecture.input_modalities) || it.input_modalities;
      if (inMods) caps.vision = hasModality(inMods, 'image');
      if (Array.isArray(it.features)) caps.tools = it.features.includes('function-calling');
      else if (Array.isArray(it.providers) && it.providers.length) caps.tools = it.providers.some((p) => p && p.supports_tools === true);
      if (tags.includes('vision')) caps.vision = true;
      const out = (it.architecture && it.architecture.output_modalities) || it.output_modalities;
      const kind = String(it.type || (it.architecture && it.architecture.modality) || '').toLowerCase();
      return {
        id: it.id, ctx: firstNum(it, ['context_length', 'context_window', 'max_context_length', 'max_model_len', 'context_size']) || firstNum(it.top_provider, ['context_length']),
        maxOut: firstNum(it, ['max_output_tokens', 'max_completion_tokens']) || firstNum(it.top_provider, ['max_completion_tokens']), caps,
        _skip: (Array.isArray(out) && !hasModality(out, 'text')) || /embed|rerank|image|audio|speech|moderation|video/.test(kind) || tags.some((t) => /embed|rerank/.test(t)),
      };
    });
  },
  anthropic(json) {
    const items = itemsOf(json, 'data');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it)) return null;
      const cap = isObj(it.capabilities) ? it.capabilities : {};
      const sup = (x) => x === true || (isObj(x) && x.supported === true);
      const m = { id: it.id, label: it.display_name, ctx: num(it.max_input_tokens), maxOut: num(it.max_tokens), caps: {} };
      if (isObj(cap.image_input)) m.caps.vision = sup(cap.image_input);
      if (it.lifecycle === 'deprecated' || it.lifecycle === 'retired') m.status = it.lifecycle;
      if (typeof it.retires_at === 'string') { m.retiresAt = it.retires_at; if (!m.status) m.status = 'retiring'; }
      if (isObj(cap.effort)) {
        const levels = SCALE.filter((l) => sup(cap.effort[l]));
        if (levels.length) {
          const types = isObj(cap.thinking) && isObj(cap.thinking.types) ? cap.thinking.types : {};
          const offWire = sup(types.disabled) ? 'disabled' : sup(types.between_tools) ? 'between_tools' : undefined;
          m.effort = { style: 'anthropic', levels: offWire ? ['off', ...levels] : levels, ...(offWire ? { offWire } : {}) };
        }
      }
      return m;
    });
  },
  deepseek(json) {
    const items = itemsOf(json, 'data');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it)) return null;
      const m = { id: it.id, label: it.name, ctx: num(it.context_window), maxOut: num(it.max_output_tokens), caps: { vision: hasModality(it.input_modalities, 'image') } };
      if (isObj(it.effort)) {
        const levels = effortLevelsFrom(it.effort.supported_levels).filter((l) => l !== 'off');
        if (levels.length) m.effort = { style: 're-think', levels: ['off', ...levels], ...(SCALE.includes(it.effort.default_level) ? { default: it.effort.default_level } : {}) };
      }
      return m;
    });
  },
  kimi(json) {
    const items = itemsOf(json, 'data');
    if (!items) return null;
    return items.map((it) => (isObj(it) ? { id: it.id, ctx: num(it.context_length), caps: { vision: it.supports_image_in === true, reasoning: it.supports_reasoning === true } } : null));
  },
  mistral(json) {
    const items = itemsOf(json, 'data');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it) || it.archived === true) return null;
      const c = isObj(it.capabilities) ? it.capabilities : {};
      return { id: it.id, label: it.name, ctx: num(it.max_context_length), caps: { tools: c.function_calling === true, vision: c.vision === true } };
    });
  },
  openrouter(json) {
    const items = itemsOf(json, 'data');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it)) return null;
      const arch = isObj(it.architecture) ? it.architecture : {};
      if (Array.isArray(arch.output_modalities) && !hasModality(arch.output_modalities, 'text')) return null;
      const sp = Array.isArray(it.supported_parameters) ? it.supported_parameters : [];
      const m = {
        id: it.id, label: it.name, ctx: num(it.context_length), maxOut: num(it.top_provider && it.top_provider.max_completion_tokens),
        caps: { tools: sp.includes('tools'), reasoning: sp.includes('reasoning'), vision: hasModality(arch.input_modalities, 'image') },
      };
      if (typeof it.expiration_date === 'string') { m.status = 'retiring'; m.retiresAt = it.expiration_date; }
      const r = isObj(it.reasoning) ? it.reasoning : null;
      if (r && Array.isArray(r.supported_efforts)) {
        const levels = effortLevelsFrom(r.supported_efforts);   // 'none' → off, 'minimal' dropped
        if (levels.length) m.effort = { style: 'openrouter', levels, ...(SCALE.includes(r.default_effort) ? { default: r.default_effort } : {}) };
      }
      return m;
    });
  },
  vercel(json) {
    const items = itemsOf(json, 'data');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it) || it.type !== 'language') return null;
      const tags = Array.isArray(it.tags) ? it.tags : [];
      const m = { id: it.id, ctx: num(it.context_window), maxOut: num(it.max_tokens), caps: { tools: tags.includes('tool-use'), reasoning: tags.includes('reasoning'), vision: tags.includes('vision') } };
      if (it.deprecated_at) { m.status = 'deprecated'; if (typeof it.deprecated_at === 'string') m.retiresAt = it.deprecated_at; }
      return m;
    });
  },
  ollama(json) {
    const items = itemsOf(json, 'models');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it) || typeof it.name !== 'string') return null;
      const d = isObj(it.details) ? it.details : {};
      return { id: it.name, note: [d.parameter_size, d.quantization_level].filter((x) => typeof x === 'string').join(' ') };
    });
  },
  lmstudio(json) {
    const items = itemsOf(json, 'models', 'data');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it)) return null;
      const kind = String(it.type || '').toLowerCase();
      if (kind && kind !== 'llm' && kind !== 'vlm') return null;
      const cap = isObj(it.capabilities) ? it.capabilities : {};
      const loaded = Array.isArray(it.loaded_instances) ? it.loaded_instances.find((x) => isObj(x) && isObj(x.config) && num(x.config.context_length)) : null;
      const m = {
        id: it.id || it.key || it.model_key, label: it.display_name, ctx: (loaded && num(loaded.config.context_length)) || num(it.max_context_length),
        caps: { tools: it.trained_for_tool_use === true || cap.trained_for_tool_use === true, vision: it.vision === true || cap.vision === true || kind === 'vlm' },
      };
      const opts = isObj(cap.reasoning) ? effortLevelsFrom(cap.reasoning.allowed_options) : [];
      if (opts.length) m.effort = { style: 're', levels: opts, ...(opts.includes('off') ? { offWire: 'none' } : {}), ...(isObj(cap.reasoning) && SCALE.includes(cap.reasoning.default) ? { default: cap.reasoning.default } : {}) };
      return m;
    });
  },
  gemini(json) {
    const items = itemsOf(json, 'models');
    if (!items) return null;
    return items.map((it) => {
      if (!isObj(it) || typeof it.name !== 'string') return null;
      const id = it.name.replace(/^models\//, '');
      const methods = Array.isArray(it.supportedGenerationMethods) ? it.supportedGenerationMethods : [];
      if (!methods.includes('generateContent') || !/^gemini-/.test(id) || /image|tts|live|embedding/.test(id)) return null;
      return { id, label: it.displayName, ctx: num(it.inputTokenLimit), maxOut: num(it.outputTokenLimit) };
    });
  },
};

/**
 * Response JSON → cleaned ModelDef[] (or null when the body is not a model list at all).
 * @param {string} parser
 * @param {unknown} json
 * @param {{ chatOnly?: boolean }} [o]
 * @returns {{ models: object[], truncated: boolean } | null}
 */
function parseList(parser, json, o = {}) {
  const fn = Object.hasOwn(parsers, parser) ? parsers[parser] : null;
  if (!fn) return null;
  const raw = fn(json);
  if (!raw) return null;
  const out = [];
  const seen = new Set();
  let truncated = false;
  for (const r of raw) {
    if (!r || r._skip) continue;
    if (o.chatOnly && typeof r.id === 'string' && NOT_CHAT.test(r.id)) continue;
    const m = finish(r);
    if (!m || seen.has(m.id)) continue;
    if (out.length >= MAX_MODELS) { truncated = true; break; }
    seen.add(m.id);
    out.push(m);
  }
  return { models: out, truncated };
}

/* ───────────── merge with the presets (§8.5) ───────────── */

/** Preset fields win; the live list fills what is missing and adds the rest. Presets the account's list does not have are kept and marked. */
function mergeModels(preset, live) {
  const liveBy = new Map(live.map((m) => [m.id, m]));
  const out = [];
  const used = new Set();
  for (const p of preset) {
    const l = liveBy.get(p.id);
    if (l) { used.add(p.id); out.push({ ...l, ...p, effort: p.effort ?? l.effort, caps: { ...(l.caps || {}), ...(p.caps || {}) }, source: 'preset' }); }
    else out.push({ ...p, source: 'preset', ...(live.length ? { unlisted: true } : {}) });
  }
  for (const l of live) if (!used.has(l.id)) out.push(l);
  return out;
}

/* ───────────── the service ───────────── */

/** How long a cached list is fresh: the service's own ttlMs, else 30 s for a local server (models get loaded and unloaded all the time), else 6 h. */
const ttlFor = (api, ep) => api.ttlMs || (ep.kind === 'local' ? TTL_LOCAL : TTL_DEFAULT);

/**
 * @param {{ registry: object, secrets?: object, cacheFile: string | (() => string), now?: () => number }} deps
 */
function createModelsApi(deps) {
  const reg = deps.registry;
  const secrets = deps.secrets || require('./secrets.cjs');
  const cachePath = typeof deps.cacheFile === 'function' ? deps.cacheFile : () => deps.cacheFile;
  const now = deps.now || Date.now;
  const unavailable = new Set();      // service|endpoint that answered 404 / 405 this session: do not ask again
  const inflight = new Map();         // cache key → the request in progress (two dropdowns asking at once share one request)
  const failed = new Map();           // cache key → { at, why } of the last failure
  let cache = null;

  /* —— the cache file —— */
  function loadCache() {
    if (cache) return cache;
    cache = { v: 1, entries: {} };
    const r = atomic.readJson(cachePath(), { maxBytes: CACHE_MAX_BYTES });
    if (r.state === 'corrupt' || r.state === 'toobig') { atomic.setAside(cachePath()); return cache; }
    if (r.state === 'ok' && isObj(r.data) && isObj(r.data.entries)) {
      for (const k of Object.keys(r.data.entries).slice(0, 400)) {
        const e = r.data.entries[k];
        if (typeof k === 'string' && k.length < 300 && isObj(e) && typeof e.at === 'number' && Array.isArray(e.models)) {
          const models = e.models.map((m) => finish({ ...m, source: undefined })).filter(Boolean);
          cache.entries[k] = { at: e.at, models };
        }
      }
    }
    return cache;
  }
  function saveCache() {
    const c = loadCache();
    const keys = () => Object.keys(c.entries).sort((a, b) => c.entries[a].at - c.entries[b].at);
    for (;;) {
      const body = JSON.stringify(c);
      if (Buffer.byteLength(body) <= CACHE_MAX_BYTES || !keys().length) break;
      delete c.entries[keys()[0]];     // oldest first
    }
    try { atomic.writeJson(cachePath(), c, { indent: 0, maxBytes: CACHE_MAX_BYTES }); } catch { /* a cache that could not be written is just not a cache */ }
  }
  function dropService(id) {
    const c = loadCache();
    let n = 0;
    for (const k of Object.keys(c.entries)) if (k.startsWith(`${id}|`)) { delete c.entries[k]; n += 1; }
    for (const k of [...unavailable]) if (k.startsWith(`${id}|`)) unavailable.delete(k);
    if (n) saveCache();
  }
  if (reg.onRemove) reg.onRemove(dropService);

  const ttlOf = ttlFor;
  const keyOf = (service, ep, params, hint) => {
    const p = params && typeof params === 'object' ? Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&') : '';
    return `${service.id}|${ep.id}|${p ? Buffer.from(p).toString('base64').slice(0, 40) : '-'}|${hint || '-'}`;
  };

  const staticList = (service, ep) => (ep && ep.models ? ep.models : service.models).map((m) => ({ ...m, source: 'preset' }));

  /** The ordered steps behind one answer. */
  async function fetchAll(service, ep, api, key, base) {
    const auth = api.authOverride || { ...service.auth, ...ep.auth };
    const headers = { accept: 'application/json', ...(service.headers || {}), ...(api.auth !== 'none' && key ? authHeaders(auth, key) : {}) };
    const u = new URL(base);
    const root = api.from === 'origin' ? u.origin : base;
    const all = [];
    let truncated = false;
    let pageToken = '';
    let afterId = '';
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams(api.query || {});
      if (api.parser === 'anthropic' && afterId) q.set('after_id', afterId);
      if (api.parser === 'gemini' && pageToken) q.set('pageToken', pageToken);
      const url = `${root}${api.path}${q.toString() ? `?${q.toString()}` : ''}`;
      const res = await net.fetchLimited(url, { method: 'GET', headers }, { timeoutMs: 15_000, maxBytes: 8 * 1024 * 1024 });
      if (!res.ok) return { status: res.status, body: res.text };
      const parsed = parseList(api.parser, res.json, { chatOnly: api.chatOnly });
      if (!parsed) return { shape: true };
      for (const m of parsed.models) { if (all.length >= MAX_MODELS) { truncated = true; break; } if (!all.some((x) => x.id === m.id)) all.push(m); }
      truncated = truncated || parsed.truncated;
      const j = res.json;
      if (api.parser === 'anthropic' && isObj(j) && j.has_more === true && typeof j.last_id === 'string') { afterId = j.last_id; continue; }
      if (api.parser === 'gemini' && isObj(j) && typeof j.nextPageToken === 'string' && j.nextPageToken) { pageToken = j.nextPageToken; continue; }
      break;
    }
    return { models: all, truncated };
  }

  const reasonOf = (status) => {
    if (status === 401) return { code: 'AUTH', error: '密钥无效或已过期，没能拉取模型列表' };
    if (status === 403) return { code: 'AUTH_SCOPE', error: '没有权限拉取模型列表（账号或地区限制）' };
    if (status === 429) return { code: 'QUOTA', error: '请求太频繁，稍后再拉取模型列表' };
    if (status >= 500) return { code: 'SERVER', error: '服务端出错，没能拉取模型列表' };
    return { code: 'PARAM', error: `没能拉取模型列表（HTTP ${status}）` };
  };

  /**
   * svc:models. Never throws; a failure is { ok:false, error } with whatever cache or presets there are.
   * @param {{ service: string, endpoint?: string, params?: Record<string,string>, fresh?: boolean, cacheOnly?: boolean }} req
   * @returns {Promise<object>} ModelsListResult (+ code)
   */
  async function listModels(req) {
    const t = now();
    const r = req && typeof req === 'object' ? req : {};
    const service = reg.get(typeof r.service === 'string' ? r.service : '');
    if (!service) return { ok: false, source: 'static', at: t, models: [], error: '没有这个服务', code: 'UNKNOWN' };
    let ep;
    if (typeof r.endpoint === 'string' && r.endpoint) { ep = reg.endpointOf(service, r.endpoint); if (!ep) return { ok: false, source: 'static', at: t, models: [], error: '没有这个地区 / 通道', code: 'ENDPOINT' }; } else ep = reg.defaultEndpoint(service, 'api');
    if (!ep) return { ok: true, source: 'static', at: t, models: [] };
    const base = staticList(service, ep);
    // I4: a plan key is never sent to an API endpoint — not even to list models
    if (ep.kind === 'plan') return { ok: false, source: 'static', at: t, models: base, error: '套餐 Key 只能给命令行编码工具用，不能直接调用 API（包括拉取模型列表）', code: 'PLAN_KEY' };
    const api = service.modelsApi;
    if (!api || !ep.baseUrl || (api.onlyEndpoints && !api.onlyEndpoints.includes(ep.id))) return { ok: true, source: 'static', at: t, models: base };
    const ov = reg.overrideOf(service.id);
    const addr = net.expandUrl(ov && ov.endpoint === ep.id ? ov.baseUrl : ep.baseUrl, ep.params, r.params);
    if (!addr.ok) return { ok: false, source: 'static', at: t, models: base, error: addr.error, code: 'ADDRESS' };
    const hints = secrets.hints();
    const hint = api.auth === 'none' ? '-' : (reg.keyHintFor(service, ep, hints) || '-');
    const ck = keyOf(service, ep, r.params, hint);
    const entry = loadCache().entries[ck];
    const ttl = ttlOf(api, ep);
    const cached = (extra = {}) => ({ ok: true, source: 'cache', at: entry.at, models: mergeModels(base, entry.models), stale: t - entry.at > ttl, ...extra });
    if (r.cacheOnly) return entry ? cached() : { ok: true, source: 'static', at: t, models: base };
    if (unavailable.has(`${service.id}|${ep.id}`)) return { ok: true, source: 'static', at: t, models: base };
    const fresh = !!r.fresh && !deps.tooSoon?.(`models:${service.id}`, 3000, t);
    if (entry && !fresh && t - entry.at <= ttl) return cached();
    // already on its way (another dropdown asked a moment ago): share that request
    if (inflight.has(ck)) return inflight.get(ck);
    // it failed a moment ago and nobody pressed 刷新: say so again instead of asking again
    const lastFail = failed.get(ck);
    const failedResult = (why) => (entry ? { ...cached({ stale: true }), ...why } : { ok: false, source: 'static', at: t, models: base, ...why });
    if (lastFail && !fresh && t - lastFail.at < FAIL_MEMORY_MS) return failedResult(lastFail.why);
    const pull = async () => {
      // the key (when the list needs one, or can use one)
      let key = null;
      if (api.auth !== 'none') {
        // a saved key never goes to a host the user has not approved (a changed address waits for the question at the next key save)
        const blocked = typeof reg.destinationProblem === 'function' ? reg.destinationProblem(service, ep) : '';
        if (blocked) return { ok: false, source: 'static', at: t, models: base, error: `服务地址指向的主机（${blocked}）还没有经过你确认，不会发送密钥。请重新保存这个服务的密钥。`, code: 'HOST_UNCONFIRMED' };
        key = await reg.readKey(service, ep);
      }
      if (api.auth === 'required' && !key) {
        const why = { error: '保存密钥后可以拉取模型列表', code: 'NO_KEY' };
        return entry ? { ...cached(), ...why } : { ok: false, source: 'static', at: t, models: base, ...why };
      }
      const fail = (why) => { failed.set(ck, { at: t, why }); return failedResult(why); };
      let got;
      try { got = await fetchAll(service, ep, api, key, addr.url); } catch (e) {
        return fail({ error: String(scrubValue(String(e && e.message || e), key) || ''), code: (e && e.code) || 'NETWORK' });
      }
      if (got.shape) return fail({ error: entry ? '服务返回的不是模型列表，已保留上次的结果' : '服务返回的不是模型列表', code: 'SHAPE' });
      if (got.status) {
        if (got.status === 404 || got.status === 405) {
          unavailable.add(`${service.id}|${ep.id}`);
          return { ok: true, source: 'static', at: t, models: base, error: '这个服务没有模型列表接口，请手动填写模型 ID', code: 'NO_LIST' };
        }
        return fail(reasonOf(got.status));
      }
      failed.delete(ck);
      loadCache().entries[ck] = { at: t, models: got.models.map((m) => { const { source: _s, ...rest } = m; return rest; }) };
      saveCache();
      return { ok: true, source: 'live', at: t, models: mergeModels(base, got.models), ...(got.truncated ? { truncated: true } : {}) };
    };
    const running = pull().finally(() => inflight.delete(ck));
    inflight.set(ck, running);
    return running;
  }

  /** svc:model-detail: ONE model's details on demand (Ollama /api/show). Never automatic. */
  async function modelDetail(req) {
    const r = req && typeof req === 'object' ? req : {};
    const service = reg.get(typeof r.service === 'string' ? r.service : '');
    if (!service) return { ok: false, error: '没有这个服务' };
    const api = service.modelsApi;
    if (!api || !api.detail) return { ok: false, error: '这个服务没有模型详情接口' };
    if (!net.checkModelId(r.model)) return { ok: false, error: '模型名不合法' };
    const ep = (typeof r.endpoint === 'string' && r.endpoint ? reg.endpointOf(service, r.endpoint) : reg.defaultEndpoint(service, 'api'));
    if (!ep || !ep.baseUrl) return { ok: false, error: '没有可用的地址' };
    if (ep.kind === 'plan') return { ok: false, error: '套餐通道不能直接调用 API', code: 'PLAN_KEY' };
    const ov = reg.overrideOf(service.id);
    const addr = net.expandUrl(ov && ov.endpoint === ep.id ? ov.baseUrl : ep.baseUrl, ep.params, r.params);
    if (!addr.ok) return { ok: false, error: addr.error };
    // the detail path is relative to the server's origin (Ollama: POST /api/show)
    const root = new URL(addr.url).origin;
    try {
      const res = await net.fetchLimited(`${root}${api.detail.path}`, { method: api.detail.method, headers: { accept: 'application/json', 'content-type': 'application/json' }, body: api.detail.method === 'POST' ? JSON.stringify({ model: r.model }) : undefined }, { timeoutMs: 15_000, maxBytes: 2 * 1024 * 1024 });
      if (!res.ok || !isObj(res.json)) return { ok: false, error: `没能取到模型详情（HTTP ${res.status}）` };
      const j = res.json;
      const caps = Array.isArray(j.capabilities) ? j.capabilities.map(String) : [];
      let ctx;
      if (isObj(j.model_info)) for (const k of Object.keys(j.model_info)) if (/\.context_length$/.test(k)) { ctx = num(j.model_info[k]); if (ctx) break; }
      const m = finish({ id: r.model, ctx, caps: caps.length ? { tools: caps.includes('tools'), vision: caps.includes('vision'), reasoning: caps.includes('thinking') } : undefined });
      return m ? { ok: true, value: m } : { ok: false, error: '模型详情的格式不对' };
    } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
  }

  return { listModels, modelDetail, dropService, _cache: loadCache, _unavailable: unavailable, _failed: failed, _inflight: inflight };
}

module.exports = { ttlFor, TTL_LOCAL, TTL_DEFAULT, FAIL_MEMORY_MS, createModelsApi, parseList, parsers, mergeModels, finish, NOT_CHAT, MAX_MODELS };
