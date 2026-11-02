'use strict';
// The service registry (MODELS-SPEC §3): which model services, endpoints, drivers and command-line agents exist, and how a request the
// page describes by ids turns into a URL, headers, a body and a key slot. The page only names things (service, endpoint, params, model,
// effort); the address, the headers, the body fields and the environment are all produced HERE from data the app shipped
// (catalog/*.json) or the user saved through svc:save (userData/services.json). That is invariant I1.
//
//   catalog (presets, validated at load)  +  services.json (custom services, address overrides, key bindings, pinned models)
//        │
//        ├─ resolveApi(spec)      → everything api.cjs needs for one chat request
//        ├─ resolveCompat(spec)   → address / model / window for the claude-compat driver (compat-env.cjs builds the env)
//        ├─ resolveAgent(spec)    → the ACP agent, its environment template, the key slot
//        └─ saveService / removeService / setOverride / pin / migrate / probeLocal   (the svc:* channels)
//
// Nothing in here imports Electron at load time; register() and the default confirm dialog load it lazily, so check-services can run
// the whole module in plain Node against a temp folder.
const path = require('node:path');
const net = require('./net.cjs');
const effortWire = require('./effort-wire.cjs');
const atomic = require('./atomic.cjs');
const { validateService, validateAgent, envNameProblem, envValueProblem, ID_RE } = require('./services-validate.cjs');

/* ═════════════════════════ the catalog ═════════════════════════ */

const RAW = {
  intl: require('./catalog/intl.json'),
  cn: require('./catalog/cn.json'),
  hub: require('./catalog/hub.json'),
  local: require('./catalog/local.json'),
  agents: require('./catalog/acp-agents.json'),
  drivers: require('./catalog/drivers.json'),
};
/** The eight services of the first release keep their place at the head of every list (menus and cards stay where users know them). */
const LEGACY_ORDER = ['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'doubao'];

const deepFreeze = (o) => {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); for (const k of Object.keys(o)) deepFreeze(o[k]); }
  return o;
};

/** Validate and index everything under catalog/. Throws (naming file, id and field) when a preset is wrong: the app must not start on bad data. */
function loadCatalog() {
  const fail = (where, id, r) => { throw new Error(`模型预设目录有错：${where}${id ? ` · ${id}` : ''}${r.field ? ` · ${r.field}` : ''}：${r.error}`); };
  const agents = [];
  const agentById = new Map();
  for (const a of RAW.agents) {
    const r = validateAgent(a);
    if (!r.ok) fail('acp-agents.json', a && a.id, r);
    if (agentById.has(r.value.id)) fail('acp-agents.json', r.value.id, { error: 'id 重复' });
    agents.push(r.value);
    agentById.set(r.value.id, r.value);
  }
  const legacyAgent = new Map();
  for (const a of agents) if (a.legacyDriver) legacyAgent.set(a.legacyDriver, a);
  const agentIds = new Set(agentById.keys());

  const presets = [];
  const byId = new Map();
  for (const file of ['intl', 'cn', 'hub', 'local']) {
    for (const s of RAW[file]) {
      const r = validateService(s, { mode: 'preset', agentIds });
      if (!r.ok) fail(`${file}.json`, s && s.id, r);
      if (byId.has(r.value.id)) fail(`${file}.json`, r.value.id, { error: 'id 与别的预设重复' });
      presets.push(r.value);
      byId.set(r.value.id, r.value);
    }
  }
  for (const a of agents) if (a.vendor && !byId.has(a.vendor)) fail('acp-agents.json', a.id, { field: 'vendor', error: `绑定的服务「${a.vendor}」不存在` });

  const drivers = [];
  const driverById = new Map();
  for (const d of RAW.drivers) {
    for (const k of ['id', 'label', 'bin', 'install', 'auth', 'approvals', 'note', 'homepage']) if (typeof d[k] !== 'string' || !d[k]) fail('drivers.json', d && d.id, { field: k, error: '缺字段' });
    if (!['account', 'key'].includes(d.auth) || !['per-call', 'sandbox'].includes(d.approvals)) fail('drivers.json', d.id, { error: 'auth / approvals 的取值不对' });
    if (driverById.has(d.id)) fail('drivers.json', d.id, { error: 'id 重复' });
    const copy = { id: d.id, label: d.label, bin: d.bin, install: d.install, auth: d.auth, approvals: d.approvals, note: d.note, homepage: d.homepage, loginArgs: Array.isArray(d.loginArgs) ? d.loginArgs.slice() : null, loginHint: String(d.loginHint || '') };
    drivers.push(copy);
    driverById.set(copy.id, copy);
  }

  // Display order: the first-release eight first (as users know them), then the rest in file order.
  const ordered = [...LEGACY_ORDER.map((id) => byId.get(id)).filter(Boolean), ...presets.filter((s) => !LEGACY_ORDER.includes(s.id))];
  return deepFreeze({ presets: ordered, byId, agents, agentById, legacyAgent, drivers, driverById });
}

let catalogCache = null;
const catalog = () => catalogCache || (catalogCache = loadCatalog());
catalog(); // fail at startup, not on the first request

/** A legacy page driver name ('kimi' | 'qwen' | 'mcode' | 'acp' + spec.acp | 'acp:<id>') → the agent's id, or ''. */
function agentIdOfDriver(driver, legacyAcp) {
  const d = String(driver || '');
  if (d === 'acp') return String(legacyAcp || '');
  if (d.startsWith('acp:')) return d.slice(4);
  const a = catalog().legacyAgent.get(d);
  return a ? a.id : '';
}
/** The driver id as services list it in `drivers` ('kimi' stays 'kimi'; 'acp:gemini' stays 'acp:gemini'). */
function listedDriver(driver, legacyAcp) {
  const d = String(driver || '');
  if (d === 'acp') return String(legacyAcp || '');
  return d;
}

/* ═════════════════════════ small helpers ═════════════════════════ */

const TODAY = () => new Date().toISOString().slice(0, 10);
const MODEL_RE_1M = /\[1m\]$/i;
const stableStringify = (v) => {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const isRec = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** id slug for a custom service: ASCII letters / digits of the name, else "svc"; always x_-prefixed, ≤ 32 chars. */
function slugId(name, taken) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'svc';
  let id = `x_${base}`;
  for (let n = 2; taken(id); n++) id = `x_${base.slice(0, 20 - String(n).length - 1)}-${n}`.slice(0, 32);
  return id;
}

const err = (code, error, extra = {}) => ({ ok: false, code, error, ...extra });

/* Image parts in messages (the 桌宠 asks about a screenshot). First bytes of a real file, to see the data is what its mime says. */
const IMAGE_MAGIC = { 'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]), 'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_B64 = Math.ceil(MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGES_PER_MESSAGE = 2;
/** …and over the whole request: a conversation does not carry old screenshots around. */
const MAX_IMAGES_TOTAL = 4;
const MAX_PARTS = 16;
/** The 桌宠's quick lane (StartSpec.pet): short answers, so a short output limit. */
const PET_MAX_TOKENS = 600;

/* ═════════════════════════ the registry ═════════════════════════ */

const EMPTY_USER = () => ({ services: [], agents: [], overrides: {}, keyBindings: {}, pinned: {}, confirmed: {}, retired: [], migrated: false });
const MAX_CUSTOM = 64;
const MAX_AGENTS = 32;
const USER_FILE_MAX = 512 * 1024;
/** Ids of deleted custom services are never handed out again: a task that still names one must not silently land on a different service. */
const RETIRED_MAX = 256;

/**
 * @param {{ userDir: string | (() => string), secrets?: object, now?: () => number, confirm?: (o: object) => Promise<boolean> }} opts
 */
function createRegistry(opts) {
  const secrets = opts.secrets || require('./secrets.cjs');
  const userDirOf = typeof opts.userDir === 'function' ? opts.userDir : () => opts.userDir;
  const fileOf = () => path.join(userDirOf(), 'services.json');
  const cat = catalog();
  let user = null;                       // loaded lazily
  const customById = new Map();
  const removeHooks = [];

  /* ───────────── the user's file ───────────── */

  function load() {
    user = EMPTY_USER();
    customById.clear();
    const file = fileOf();
    const r = atomic.readJson(file, { maxBytes: USER_FILE_MAX });
    if (r.state === 'corrupt' || r.state === 'toobig') {
      const aside = atomic.setAside(file);
      console.warn(`services.json 损坏或过大，已改名留底：${aside || '(改名失败)'}`);
      return;
    }
    if (r.state !== 'ok' || !isRec(r.data)) return;
    const d = r.data;
    const agentIds = new Set(cat.agentById.keys());
    for (const raw of Array.isArray(d.services) ? d.services.slice(0, MAX_CUSTOM) : []) {
      const v = validateService(raw, { mode: 'custom', agentIds });
      if (!v.ok || customById.has(v.value.id) || cat.byId.has(v.value.id)) { console.warn(`services.json 里的自定义服务已跳过：${raw && raw.id} ${v.ok ? '重复' : v.error}`); continue; }
      user.services.push(v.value);
      customById.set(v.value.id, v.value);
    }
    for (const a of Array.isArray(d.agents) ? d.agents.slice(0, MAX_AGENTS) : []) if (isRec(a) && typeof a.id === 'string' && /^[a-z][a-z0-9-]{1,24}$/.test(a.id)) user.agents.push(a);
    if (isRec(d.overrides)) {
      for (const id of Object.keys(d.overrides)) {
        const o = d.overrides[id];
        const s = cat.byId.get(id);
        if (!s || !isRec(o)) continue;
        const ep = s.endpoints.find((e) => e.id === o.endpoint);
        const c = typeof o.baseUrl === 'string' ? net.checkBaseUrl(o.baseUrl) : null;
        // confirmedHost '' = the user has not said yes to this host yet (it is asked at the first key); a missing field counts the same
        if (ep && c && !(ep.params && ep.params.length)) user.overrides[id] = { endpoint: ep.id, baseUrl: c.url, confirmedHost: typeof o.confirmedHost === 'string' ? o.confirmedHost.slice(0, 100) : '' };
      }
    }
    if (isRec(d.keyBindings)) {
      for (const id of Object.keys(d.keyBindings)) {
        const s = cat.byId.get(id) || customById.get(id);
        if (s && typeof d.keyBindings[id] === 'string' && s.endpoints.some((e) => e.id === d.keyBindings[id])) user.keyBindings[id] = d.keyBindings[id];
      }
    }
    if (isRec(d.pinned)) {
      for (const id of Object.keys(d.pinned)) {
        if (!(cat.byId.has(id) || customById.has(id)) || !Array.isArray(d.pinned[id])) continue;
        const list = d.pinned[id].filter((m) => net.checkModelId(m)).slice(0, 50);
        if (list.length) user.pinned[id] = [...new Set(list)];
      }
    }
    if (isRec(d.confirmed)) {
      for (const id of Object.keys(d.confirmed)) {
        if (!customById.has(id) || !Array.isArray(d.confirmed[id])) continue;
        user.confirmed[id] = d.confirmed[id].filter((h) => typeof h === 'string' && h.length <= 100).slice(0, 40);
      }
    }
    if (Array.isArray(d.retired)) user.retired = [...new Set(d.retired.filter((x) => typeof x === 'string' && /^x_[a-z0-9_-]{0,30}$/.test(x)))].slice(-RETIRED_MAX);
    user.migrated = d.migrated === true;
  }
  const state = () => { if (!user) load(); return user; };

  function persist() {
    const u = state();
    atomic.writeJson(fileOf(), { v: 1, services: u.services, agents: u.agents, overrides: u.overrides, keyBindings: u.keyBindings, pinned: u.pinned, confirmed: u.confirmed, retired: u.retired, migrated: u.migrated }, { maxBytes: USER_FILE_MAX });
  }

  /* ───────────── lookups ───────────── */

  // Stand-alone command-line agents (acp-agents.cjs) are services too (acp_<id>): the resolver is set once the agents module exists.
  let pseudoResolver = () => undefined;
  const get = (id) => {
    if (typeof id !== 'string') return undefined;
    const preset = cat.byId.get(id);
    if (preset) return preset;
    state();
    return customById.get(id) || pseudoResolver(id);
  };
  const list = ({ hidden = false } = {}) => [...cat.presets.filter((s) => hidden || !s.hidden), ...state().services];
  const endpointOf = (service, id) => (service ? service.endpoints.find((e) => e.id === id) : undefined);
  /** A command-line agent of the shipped catalog. (Agents the user registered live in services.json, MB3's part; they are not runnable yet.) */
  const agentOf = (id) => cat.agentById.get(id);

  const slotFor = (service, ep) => (ep && ep.separateKey ? `${service.id}:${ep.id}` : service.id);

  function isKnown(slot) {
    if (typeof slot !== 'string') return false;
    const i = slot.indexOf(':');
    const service = get(i < 0 ? slot : slot.slice(0, i));
    if (!service) return false;
    if (i < 0) return true;
    const ep = endpointOf(service, slot.slice(i + 1));
    return !!ep && !!ep.separateKey;
  }
  function keyMin(slot) {
    const i = slot.indexOf(':');
    const service = get(i < 0 ? slot : slot.slice(0, i));
    if (!service) return 8;
    const ep = i < 0 ? undefined : endpointOf(service, slot.slice(i + 1));
    const auth = { ...service.auth, ...(ep && ep.auth) };
    return auth.keyOptional ? 1 : auth.keyMin || 8;
  }
  const secretsConfig = () => ({ isKnown, keyMin });

  /**
   * Which slot the OLD single key (the one slot named after the service) may be read through for this endpoint:
   *   - an endpoint with its own slot (separateKey) falls back to the old slot only when migration bound the old key to it;
   *   - an endpoint that SHARES the old slot (no separateKey: GLM / Doubao pay-as-you-go) must not read it when the old key was bound to a
   *     different region (a plan key is billed differently and must never be taken for a pay-as-you-go key).
   */
  function legacyFallback(service, ep) {
    const bound = state().keyBindings[service.id];
    const primary = slotFor(service, ep);
    if (primary !== service.id) return bound === ep.id;
    return !bound || bound === ep.id;
  }

  /** Every host an endpoint can send its key to (baseUrl, compatUrl, responsesUrl), in the one spelling approvals are stored in. */
  const hostsOfEndpoint = (ep) => [...new Set([ep.baseUrl, ep.compatUrl, ep.responsesUrl].filter(Boolean).map((a) => net.hostOfAddress(a)).filter(Boolean))];

  /**
   * The host a saved key may NOT go to yet, or ''. A key is only ever sent to a host the user said yes to in a native dialog:
   *   - a custom service: every host of the endpoint (its confirmed list, written at the first key / when the address moved);
   *   - a preset whose address the user changed: the new host (confirmedHost) — the preset's own host needs no approval.
   * Only a key that exists matters: with no key saved there is nothing to send, and the question is asked at the first key.
   */
  function destinationProblem(service, ep) {
    if (!service || !ep) return '';
    const u = state();
    const hints = secrets.hints();
    const primary = slotFor(service, ep);
    if (!hints[primary] && !(primary !== service.id && legacyFallback(service, ep) && hints[service.id])) return '';
    if (service.kind === 'custom') {
      const known = new Set(u.confirmed[service.id] || []);
      for (const h of hostsOfEndpoint(ep)) if (!known.has(h)) return h;
      return '';
    }
    const ov = u.overrides[service.id];
    if (ov && ov.endpoint === ep.id && cat.byId.has(service.id)) {
      const h = net.hostOfAddress(ov.baseUrl);
      if (h && h !== net.hostOfAddress(ep.baseUrl) && h !== ov.confirmedHost) return h;
    }
    return '';
  }

  /** The key for (service, endpoint): its own slot, else — for the endpoint the old single key belonged to — the old slot. Null when the host is not approved. */
  async function readKey(service, ep) {
    if (destinationProblem(service, ep)) return null;
    const primary = slotFor(service, ep);
    if (primary === service.id && !legacyFallback(service, ep)) return null;
    const key = await secrets.get(primary);
    if (key) return key;
    if (primary !== service.id && legacyFallback(service, ep)) return (await secrets.get(service.id)) || null;
    return null;
  }
  /** '••••abcd' for the key that readKey would return, without decrypting. */
  function keyHintFor(service, ep, hints) {
    const primary = slotFor(service, ep);
    if (primary === service.id && !legacyFallback(service, ep)) return undefined;
    if (hints[primary]) return hints[primary];
    if (primary !== service.id && legacyFallback(service, ep)) return hints[service.id];
    return undefined;
  }
  /** Which slots `clearKey(provider, endpoint)` removes: the endpoint's own, and the old single slot when it was this endpoint's (never another region's). */
  function slotsToClear(service, ep) {
    const primary = slotFor(service, ep);
    if (primary === service.id && !legacyFallback(service, ep)) return [];
    const out = [primary];
    if (primary !== service.id && state().keyBindings[service.id] === ep.id) out.push(service.id);
    return out;
  }
  function dropBinding(service, ep) {
    const u = state();
    if (u.keyBindings[service.id] === ep.id) { delete u.keyBindings[service.id]; persist(); }
  }
  /**
   * Before a NEW key is written to the slot an endpoint shares with the service (GLM / Doubao pay-as-you-go), an old key that migration
   * bound to another region moves to that region's own slot first: saving a pay-as-you-go key must not overwrite the plan key.
   */
  async function releaseLegacySlot(service, ep) {
    const u = state();
    const bound = u.keyBindings[service.id];
    if (!bound || bound === ep.id || slotFor(service, ep) !== service.id) return;
    const bep = endpointOf(service, bound);
    if (bep && bep.separateKey) {
      const own = slotFor(service, bep);
      const old = await secrets.get(service.id);
      if (old && !(await secrets.get(own))) await secrets.save(own, old);
    }
    delete u.keyBindings[service.id];
    persist();
  }

  /* ───────────── models and context windows ───────────── */

  const modelsOf = (service, ep) => (ep && ep.models ? ep.models : service.models);
  const findModel = (service, ep, id) => {
    const bare = String(id).replace(MODEL_RE_1M, '');
    return modelsOf(service, ep).find((m) => m.id === id) || service.models.find((m) => m.id === id) || modelsOf(service, ep).find((m) => m.id === bare);
  };
  /** The model suggestions for a CLI driver ('*' = every model, a string = a model of the service, an object = inline). */
  function cliModelsFor(service, driver) {
    const raw = service.cliModels && service.cliModels[driver];
    if (!raw) return [];
    const out = [];
    for (const x of raw) {
      if (x === '*') out.push(...service.models);
      else if (typeof x === 'string') { const m = service.models.find((y) => y.id === x); if (m) out.push(m); } else out.push(x);
    }
    return out;
  }
  /** Context window: documented value, else the service default (1M for the first-release eight, as before). */
  function ctxOf(service, ep, model) {
    if (MODEL_RE_1M.test(model)) return { tokens: 1_000_000, known: true };
    const all = [...(ep && ep.models ? ep.models : []), ...service.models, ...Object.keys(service.cliModels || {}).flatMap((d) => cliModelsFor(service, d))];
    const hit = all.find((m) => m.id === model);
    return hit && hit.ctx ? { tokens: hit.ctx, known: true } : { tokens: service.defaultCtx || 1_000_000, known: false };
  }

  /* ───────────── picking the endpoint ───────────── */

  /** Old page builds describe the region only through the address they computed. Match it against OUR addresses; it is never used as a destination. */
  function inferEndpoint(service, wanted, kind) {
    if (typeof wanted !== 'string' || !wanted) return undefined;
    const want = net.canonUrl(wanted);
    if (!want) return undefined;
    const ov = state().overrides[service.id];
    for (const ep of service.endpoints) {
      const cands = kind === 'compat' ? [ep.compatUrl] : [ep.baseUrl, ov && ov.endpoint === ep.id ? ov.baseUrl : undefined];
      if (cands.some((c) => c && !net.placeholderNames(c).length && net.canonUrl(c) === want)) return ep;
    }
    return undefined;
  }
  function defaultEndpoint(service, kind) {
    if (kind === 'compat') return service.endpoints.find((e) => e.compatUrl && e.kind !== 'plan') || service.endpoints.find((e) => e.compatUrl);
    return service.endpoints.find((e) => e.baseUrl && e.kind !== 'plan') || service.endpoints.find((e) => e.baseUrl);
  }
  /** spec.endpoint (new pages) → else what an old page's address matches → else the service's first suitable endpoint. */
  function pickEndpoint(service, spec, kind, legacyAddress) {
    if (typeof spec.endpoint === 'string' && spec.endpoint) {
      const ep = endpointOf(service, spec.endpoint);
      return ep ? { ep } : { error: err('ENDPOINT', '这家服务没有这个地区 / 通道。') };
    }
    return { ep: inferEndpoint(service, legacyAddress, kind) || defaultEndpoint(service, kind) };
  }

  /* ───────────── resolveApi ───────────── */

  /**
   * The conversation as the page sent it. A message's content is a string, or a list of parts (the 桌宠 asks about a screenshot):
   * { type: 'text', text } and { type: 'image', mime: 'image/jpeg' | 'image/png', data: base64 }. Everything else is refused, not
   * stringified: a picture must never turn into "[object Object]" in a prompt. Text-only lists become one string.
   * @returns {{ ok: true, messages: Array<{ role: string, content: string | Array<object> }> } | { ok: false, error: string }}
   */
  function cleanMessages(list) {
    const out = [];
    let images = 0;
    for (const m of Array.isArray(list) ? list.slice(-2000) : []) {
      if (!isRec(m)) continue;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const c = m.content;
      if (Array.isArray(c)) {
        const parts = cleanParts(c, role);
        if (!parts.ok) return parts;
        images += parts.images;
        if (images > MAX_IMAGES_TOTAL) return { ok: false, error: `一次请求最多带 ${MAX_IMAGES_TOTAL} 张图片。` };
        out.push({ role, content: parts.images ? parts.parts : parts.parts.map((p) => p.text).join('\n') });
      } else if (c !== null && c !== undefined && typeof c === 'object') {
        return { ok: false, error: '消息内容的形状不对：应该是文字，或文字和图片的列表。' };
      } else out.push({ role, content: String(c ?? '') });
    }
    return { ok: true, messages: out };
  }

  /** One list of parts → the cleaned parts, or the Chinese reason it is refused. */
  function cleanParts(list, role) {
    if (list.length > MAX_PARTS) return { ok: false, error: '一条消息里的内容太多。' };
    const parts = [];
    let images = 0;
    for (const p of list) {
      if (!isRec(p)) return { ok: false, error: '消息里有不支持的内容。' };
      if (p.type === 'text') {
        if (typeof p.text !== 'string') return { ok: false, error: '消息里的文字不是文字。' };
        if (p.text) parts.push({ type: 'text', text: p.text });
        continue;
      }
      if (p.type !== 'image') return { ok: false, error: '消息里有不支持的内容类型。' };
      if (role !== 'user') return { ok: false, error: '图片只能放在用户的消息里。' };
      const bad = imageProblem(p);
      if (bad) return { ok: false, error: bad };
      if (++images > MAX_IMAGES_PER_MESSAGE) return { ok: false, error: `一条消息最多 ${MAX_IMAGES_PER_MESSAGE} 张图片。` };
      parts.push({ type: 'image', mime: String(p.mime), data: p.data });
    }
    if (!parts.length) return { ok: false, error: '消息内容是空的。' };
    return { ok: true, parts, images };
  }

  /** Why an image part is refused (JPEG or PNG, real base64, at most 4 MB decoded, bytes that match the declared type), or ''. */
  function imageProblem(p) {
    if (!own(IMAGE_MAGIC, String(p.mime))) return '图片只支持 JPEG 或 PNG。';
    const d = p.data;
    if (typeof d !== 'string' || !d) return '图片没有内容。';
    if (d.length > MAX_IMAGE_B64) return '单张图片超过 4 MB，请缩小后再发。';
    if (d.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(d)) return '图片数据不是有效的 Base64。';
    const bytes = (d.length / 4) * 3 - (d.endsWith('==') ? 2 : d.endsWith('=') ? 1 : 0);
    if (bytes > MAX_IMAGE_BYTES) return '单张图片超过 4 MB，请缩小后再发。';
    const magic = IMAGE_MAGIC[p.mime];
    if (!Buffer.from(d.slice(0, 16), 'base64').subarray(0, magic.length).equals(magic)) return '图片内容和声明的格式不符。';
    return '';
  }

  /** An old page sent the reasoning body itself; recover the LEVEL it stands for by matching it against what we would generate. */
  function legacyLevel(spec, effortSpec, protocol, service) {
    if (!isRec(spec.extraBody)) return undefined;
    const want = stableStringify(spec.extraBody);
    const dflt = protocol === 'anthropic' && service.wire && service.wire.defaultThinking ? stableStringify({ thinking: { type: service.wire.defaultThinking.type, display: service.wire.defaultThinking.display } }) : '';
    if (dflt && want === dflt) return undefined;
    for (const level of effortSpec.levels) if (stableStringify(effortWire.wire(effortSpec, level)) === want) return level;
    return undefined;
  }

  /**
   * Everything one API chat request needs, from the ids the page sent.
   * @param {object} spec  the page's StartSpec (only provider / endpoint / params / model / effort / system / messages / maxTokens / pet are read)
   * @param {{ test?: boolean, live?: Array<object> }} [internal]  main-process-only switches (the page cannot set them)
   */
  function resolveApi(spec, internal = {}) {
    const service = get(String(spec.provider || ''));
    if (!service) return err('UNKNOWN', '未知的模型服务。');
    const picked = pickEndpoint(service, spec, 'api', spec.baseUrl);
    if (picked.error) return picked.error;
    const ep = picked.ep;
    if (!ep) return err('ENDPOINT', '这家服务没有可用的 API 地址。');
    // I4: a plan key is for the vendor's own coding tools only; the page may ask, the answer is no
    if (ep.kind === 'plan') return err('PLAN_KEY', `「${ep.label}」是套餐通道：套餐 Key 只能给命令行编码工具用，不能直接调用 API。请改用命令行方式。`);
    if (!ep.baseUrl) return err('ENDPOINT', `「${ep.label}」没有 API 地址，只能用命令行方式。`);
    const ov = state().overrides[service.id];
    const useOverride = ov && ov.endpoint === ep.id;
    const addr = net.expandUrl(useOverride ? ov.baseUrl : ep.baseUrl, ep.params, spec.params);
    if (!addr.ok) return err('ADDRESS', addr.error, { field: addr.field });
    // 校验失败的地址绝不发密钥：非 https 且不是本机
    const model = String(spec.model || '');
    if (!model) return err('MODEL', '请先选择模型。');
    if (!net.checkModelId(model)) return err('MODEL', '模型名里有不支持的字符。');
    const modelDef = findModel(service, ep, model);
    const wire = { ...service.wire, ...ep.wire };
    const auth = { ...service.auth, ...ep.auth };
    const protocol = service.protocol;
    const base = addr.url;
    const url = protocol === 'anthropic'
      ? (/\/v1$/.test(base) ? `${base}/messages` : `${base}/v1/messages`)
      : `${base}${wire.chatPath || '/chat/completions'}`;
    // output limit: min(the model's, the service's default cap); thinking counts against it, so the cap is generous
    const cap = Math.min(modelDef && modelDef.maxOut ? modelDef.maxOut : Infinity, wire.defaultMaxOut || 8192);
    // The 桌宠's quick lane: the page asks for a short answer and gets at most PET_MAX_TOKENS (never from a connection test).
    const pet = spec.pet === true && !internal.test;
    const asked = Number.isFinite(spec.maxTokens) && spec.maxTokens > 0 ? Math.floor(spec.maxTokens) : Math.min(cap, 8192);
    const maxTokens = internal.test ? clamp(wire.testMaxTokens || 256, 16, cap) : clamp(pet ? Math.min(asked, PET_MAX_TOKENS) : asked, Math.min(256, cap), cap);
    // reasoning
    const planProto = protocol === 'anthropic' ? 'anthropic' : 'openai';
    const effSpec = effortWire.resolveEffort(service, model, internal.live);
    const level = typeof spec.effort === 'string' && spec.effort ? spec.effort : legacyLevel(spec, effSpec, planProto, service);
    // a connection test asks for the plainest request there is: no reasoning fields at all
    const eff = internal.test
      ? { spec: effSpec, level: undefined, fields: {}, notices: [] }
      : effortWire.plan({ service, model, level, protocol: planProto, live: internal.live });
    let messages;
    if (internal.test) messages = [{ role: 'user', content: '连通性测试：请只回复两个字母 OK。' }];
    else {
      const cm = cleanMessages(spec.messages);
      if (!cm.ok) return err('MESSAGES', cm.error);
      messages = cm.messages;
      // A model the list says cannot take pictures is not sent one (an unknown model is tried: many lists carry no capability at all).
      if (messages.some((m) => Array.isArray(m.content)) && modelDef && modelDef.caps && modelDef.caps.vision === false) return err('VISION', `${model} 不能看图，请换一个能看图的模型。`);
    }
    return {
      ok: true,
      r: {
        service, endpoint: ep, protocol, url, baseUrl: base, host: addr.check.host, private: addr.check.private,
        headers: { ...(service.headers || {}) },
        auth: { scheme: auth.scheme, header: auth.header, keyOptional: !!auth.keyOptional || auth.scheme === 'none' },
        slot: slotFor(service, ep),
        model, modelDef, maxTokens, cap, pet,
        wire: {
          maxTokensField: wire.maxTokensField || 'max_tokens',
          streamUsage: wire.streamUsage || 'include_usage',
          thinkIn: wire.thinkIn || ['reasoning_content', 'reasoning', 'think-tag'],
          contentParts: !!wire.contentParts,
          dropFields: wire.dropFields || [],
          anthropicVersion: wire.anthropicVersion || '2023-06-01',
        },
        effort: { spec: eff.spec, level: eff.level, fields: eff.fields },
        notices: eff.notices,
        extraBody: service.extraBody || {},
        system: internal.test ? '' : typeof spec.system === 'string' ? spec.system : '',
        messages,
        provider: service.id,
      },
    };
  }

  /* ───────────── resolveCompat / resolveAgent ───────────── */

  const envModelOf = (env, ...names) => {
    for (const n of names) {
      const v = isRec(env) && typeof env[n] === 'string' ? env[n].replace(MODEL_RE_1M, '') : '';
      if (v && net.checkModelId(v)) return v;
    }
    return '';
  };

  /** claude-compat: the vendor's Anthropic-compatible address, the model, the window. The environment itself is built by compat-env.cjs. */
  function resolveCompat(spec) {
    const service = get(String(spec.provider || ''));
    if (!service) return err('UNKNOWN', '未知的模型服务。');
    const env = isRec(spec.env) ? spec.env : undefined;
    const picked = pickEndpoint(service, spec, 'compat', env && env.ANTHROPIC_BASE_URL);
    if (picked.error) return picked.error;
    const ep = picked.ep;
    if (!ep || !ep.compatUrl) {
      const alt = service.endpoints.find((e) => e.compatUrl);
      return err('ENDPOINT', alt ? `「${ep ? ep.label : '这个地区'}」没有 Claude Code 兼容端点，请把服务地区切到「${alt.label}」。` : `${service.name} 没有可用的 Anthropic 兼容端点。`);
    }
    const addr = net.expandUrl(ep.compatUrl, ep.params, spec.params);
    if (!addr.ok) return err('ADDRESS', addr.error, { field: addr.field });
    const model = String(spec.model || '') || envModelOf(env, 'ANTHROPIC_SMALL_FAST_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL') || ((cliModelsFor(service, 'claude-compat')[0] || {}).id || '') || service.defaultModel || (service.models[0] || {}).id || '';
    if (!model) return err('MODEL', '请先选择模型。');
    if (!net.checkModelId(model)) return err('MODEL', '模型名里有不支持的字符。');
    const auth = { ...service.auth, ...ep.auth };
    return {
      ok: true,
      service, endpoint: ep, url: addr.url, model, ctx: ctxOf(service, ep, model),
      autoCompactWindow: ep.compat && ep.compat.autoCompactWindow, experimental: !!(ep.compat && ep.compat.experimental),
      slot: slotFor(service, ep), keyOptional: !!auth.keyOptional || auth.scheme === 'none',
    };
  }

  /** Expand {baseUrl} {model} {endpoint} in an agent's environment template. Only these three; values are checked strings. */
  function expandEnvTemplate(template, vars) {
    return String(template).replace(/\{(\w+)\}/g, (all, n) => (own(vars, n) ? vars[n] : all));
  }

  /** The ACP agent a driver names, the service it belongs to, and the environment it needs (without the key). */
  function resolveAgent(spec) {
    const service = get(String(spec.provider || ''));
    if (!service) return err('UNKNOWN', '未知的模型服务。');
    const id = agentIdOfDriver(spec.driver, spec.acp || spec.agent);
    const agent = agentOf(id);
    if (!agent) return err('AGENT', '未知的命令行工具。');
    // the service must list this tool: the key of vendor A is never handed to a tool that belongs to vendor B
    if (!service.drivers.includes(listedDriver(spec.driver, spec.acp || spec.agent)) && !service.drivers.includes(`acp:${id}`)) return err('AGENT', `${service.name} 不支持这个命令行工具。`);
    const out = { ok: true, service, agent, env: {}, keyEnv: '', slot: '', keyOptional: true };
    if (agent.binding.mode !== 'env') return out;
    const env = isRec(spec.env) ? spec.env : undefined;
    const picked = pickEndpoint(service, spec, 'api', env && env.OPENAI_BASE_URL);
    if (picked.error) return picked.error;
    const ep = picked.ep;
    if (!ep || !ep.baseUrl) return err('ENDPOINT', `${service.name} 没有可用的 API 地址。`);
    const ov = state().overrides[service.id];
    const addr = net.expandUrl(ov && ov.endpoint === ep.id ? ov.baseUrl : ep.baseUrl, ep.params, spec.params);
    if (!addr.ok) return err('ADDRESS', addr.error, { field: addr.field });
    const model = String(spec.model || '') || envModelOf(env, 'OPENAI_MODEL') || agent.binding.defaultModel || '';
    if (model && !net.checkModelId(model)) return err('MODEL', '模型名里有不支持的字符。');
    const vars = { baseUrl: addr.url, model, endpoint: ep.id };
    for (const [k, v] of Object.entries(agent.binding.env)) {
      if (envNameProblem(k) || envValueProblem(v)) continue;
      const value = expandEnvTemplate(v, vars);
      if (value.length <= 2000 && !/[\u0000-\u001f]/.test(value)) out.env[k] = value;
    }
    out.keyEnv = agent.binding.keyEnv;
    out.slot = slotFor(service, ep);
    out.endpoint = ep;
    out.keyOptional = !!agent.binding.optional;
    return out;
  }

  /* ───────────── custom services: save / remove ───────────── */

  /** Fill what the form leaves out. (The validator still checks every field.) */
  function withDefaults(raw) {
    const d = { ...raw };
    d.kind = 'custom';
    const eps = Array.isArray(d.endpoints) ? d.endpoints : [];
    const loopback = eps.length > 0 && eps.every((e) => isRec(e) && typeof e.baseUrl === 'string' && net.isLoopbackHttp(e.baseUrl));
    if (!d.vendor) d.vendor = loopback ? '本机' : '自定义';
    if (!d.glyph && typeof d.name === 'string' && d.name) d.glyph = [...d.name][0];
    if (!d.group) d.group = loopback ? 'local' : 'hub';
    if (!d.protocol) d.protocol = 'openai-chat';
    if (!d.auth) d.auth = { scheme: 'bearer' };
    if (d.endpoints) {
      d.endpoints = eps.map((e) => (isRec(e) ? { ...e, kind: e.kind || (typeof e.baseUrl === 'string' && net.isLoopbackHttp(e.baseUrl) || typeof e.compatUrl === 'string' && net.isLoopbackHttp(e.compatUrl) ? 'local' : 'payg') } : e));
    }
    if (!d.wire) d.wire = { maxTokensField: 'auto', defaultMaxOut: 16000, testMaxTokens: 512 };
    if (!d.defaultCtx) d.defaultCtx = loopback ? 8192 : 128000;
    if (!d.verified) d.verified = TODAY();
    if (d.keyHelp === undefined) d.keyHelp = '自定义服务';
    if (!d.drivers) d.drivers = [];
    return d;
  }

  /**
   * Preset plan-endpoint addresses (baseUrl AND compatUrl; the ones no pay-as-you-go endpoint shares): no address may turn them into an API
   * way. A trailing /v1 is ignored (the Anthropic protocol appends it itself) and anything below a plan address counts as that address.
   */
  const planCache = {};
  const normAddr = (a) => { const c = net.canonUrl(a); return c ? c.replace(/\/v1$/, '') : ''; };
  function planAddresses() {
    if (planCache.v) return planCache.v;
    const payg = new Set();
    const plans = [];
    for (const sv of cat.presets) {
      for (const e of sv.endpoints) {
        for (const a of [e.baseUrl, e.compatUrl]) {
          if (!a || net.placeholderNames(a).length) continue;
          const n = normAddr(a);
          if (!n) continue;
          if (e.kind === 'plan') plans.push({ n, name: sv.name, label: e.label }); else payg.add(n);
        }
      }
    }
    return (planCache.v = { payg, plans: plans.filter((p) => !payg.has(p.n)) });
  }
  function planAddressOwner(url) {
    const want = normAddr(url);
    if (!want) return '';
    const { payg, plans } = planAddresses();
    if (payg.has(want)) return '';
    for (const p of plans) if (want === p.n || want.startsWith(`${p.n}/`)) return `${p.name} 的「${p.label}」`;
    return '';
  }

  const keySlotsOf = (id) => Object.keys(secrets.hints()).filter((k) => k === id || k.startsWith(`${id}:`));

  /**
   * Validate and store a custom service. Anything that would send a saved key to a NEW host, and every internal (private) address, needs the
   * user's yes in a native dialog the page cannot press (`confirm`).
   * @returns {Promise<{ ok: true, value: object } | { ok: false, error: string, field?: string }>}
   */
  async function saveService(raw, o = {}) {
    if (!isRec(raw)) return { ok: false, error: '服务配置不是对象' };
    const u = state();
    const agentIds = new Set(cat.agentById.keys());
    const draft = withDefaults(raw);
    const wanted = typeof raw.id === 'string' && raw.id ? raw.id : '';
    const prev = wanted ? customById.get(wanted) : undefined;
    if (wanted && cat.byId.has(wanted)) return { ok: false, error: '预设服务不能被覆盖', field: 'id' };
    if (wanted && !prev && u.retired.includes(wanted)) return { ok: false, error: '这个 id 属于一个已删除的服务，不会再用', field: 'id' };
    if (!prev && u.services.length >= MAX_CUSTOM) return { ok: false, error: `自定义服务最多 ${MAX_CUSTOM} 个` };
    const nameForSlug = typeof draft.name === 'string' ? draft.name : '';
    draft.id = wanted || slugId(nameForSlug, (id) => cat.byId.has(id) || customById.has(id) || u.retired.includes(id));
    const v = validateService(draft, { mode: 'custom', agentIds });
    if (!v.ok) return v;
    const def = v.value;
    // I4 (helper, not a boundary): the address of a vendor's plan channel cannot become an API service
    for (const e of def.endpoints) {
      for (const a of [e.baseUrl, e.compatUrl]) {
        if (!a || net.placeholderNames(a).length) continue;
        const owner = planAddressOwner(a);
        if (owner) return { ok: false, error: `这是 ${owner} 的套餐地址：套餐 Key 只能给命令行编码工具用，不能保存为 API 服务。`, field: 'endpoints' };
      }
    }
    // where a saved key would go: a host the user has not approved yet needs a native yes (a service with no key yet asks at the first key)
    const approved = new Set(u.confirmed[def.id] || []);
    const hasKey = prev ? keySlotsOf(def.id).length > 0 : false;
    const newHosts = hasKey ? v.hosts.filter((h) => !approved.has(h)) : [];
    const newPrivate = v.private.filter((h) => !approved.has(h));
    const asks = [];
    if (newHosts.length) asks.push({ title: '密钥将发往新的主机', message: `「${def.name}」已保存的 API Key 之后会发往：${newHosts.join('、')}。继续？`, detail: `原来的主机：${[...approved].join('、') || '（无记录）'}。只有你信任的服务才应该收到这把密钥。` });
    if (newPrivate.length) asks.push({ title: '这是内网地址', message: `「${def.name}」的地址 ${newPrivate.join('、')} 在内网里。继续保存？`, detail: '栖枝只放行 https 的内网主机；请确认这台机器是你自己的，证书可信。' });
    if (asks.length) {
      if (!o.confirm) return { ok: false, error: '需要你在弹窗里确认，已取消' };
      for (const a of asks) if (!(await o.confirm(a))) return { ok: false, error: '已取消' };
    }
    // write (and put everything back if the disk refuses)
    const before = { services: u.services, approved: u.confirmed[def.id] };
    u.services = prev ? u.services.map((s) => (s.id === def.id ? def : s)) : [...u.services, def];
    customById.set(def.id, def);
    const nextApproved = [...new Set([...approved, ...newHosts, ...newPrivate])].slice(0, 40);
    if (nextApproved.length) u.confirmed[def.id] = nextApproved; else delete u.confirmed[def.id];
    try { persist(); } catch (e) {
      u.services = before.services;
      if (prev) customById.set(def.id, prev); else customById.delete(def.id);
      if (before.approved) u.confirmed[def.id] = before.approved; else delete u.confirmed[def.id];
      return { ok: false, error: `没能写入服务配置：${e && e.message || e}` };
    }
    return { ok: true, value: def };
  }

  /**
   * Before a key is stored, the user confirms (natively) where it will go — once per host, and again whenever the address moved:
   *   - a custom service: EVERY endpoint that shares the key's slot (an endpoint added while no key existed is not asked about at save time);
   *   - a preset whose address the user changed: the new host.
   * The hosts are the canonical (punycode, lower case) ones; the dialog shows exactly those.
   * @returns {Promise<boolean>}
   */
  async function confirmKeyDestination(service, ep, confirm) {
    const u = state();
    const slot = slotFor(service, ep);
    if (service.kind === 'custom') {
      const hosts = [...new Set(service.endpoints.filter((e) => slotFor(service, e) === slot).flatMap(hostsOfEndpoint))];
      const known = new Set(u.confirmed[service.id] || []);
      const fresh = hosts.filter((h) => !known.has(h));
      if (!fresh.length) return true;
      if (!confirm) return false;
      const yes = await confirm({ title: '确认密钥发往的主机', message: `「${service.name}」的 API Key 会发往：${fresh.join('、')}。继续保存？`, detail: '只有你信任的服务才应该收到这把密钥。以后改了服务地址，栖枝会再问你。' });
      if (!yes) return false;
      u.confirmed[service.id] = [...new Set([...known, ...hosts])].slice(0, 40);
      try { persist(); } catch { /* the confirmation is just not remembered */ }
      return true;
    }
    const ov = cat.byId.has(service.id) ? u.overrides[service.id] : undefined;
    if (!ov) return true;
    const oep = endpointOf(service, ov.endpoint);
    if (!oep || slotFor(service, oep) !== slot) return true;
    const host = net.hostOfAddress(ov.baseUrl);
    const presetHost = net.hostOfAddress(oep.baseUrl);
    if (!host || host === presetHost || host === ov.confirmedHost) return true;
    if (!confirm) return false;
    const yes = await confirm({ title: '确认密钥发往的主机', message: `「${service.name}」的 API Key 会发往你改过的地址：${host}（原来是 ${presetHost}）。继续保存？`, detail: '这是中转站用户的常见做法，也是密钥外流的最短路径。只有你信任的主机才应该收到它。' });
    if (!yes) return false;
    const prev = ov.confirmedHost;
    ov.confirmedHost = host;
    try { persist(); } catch { ov.confirmedHost = prev; return false; }
    return true;
  }

  const onRemove = (fn) => { removeHooks.push(fn); };

  /** Delete a custom service with everything that belongs to it: key slots, pinned models, address records, cached lists. */
  function removeService(id) {
    const u = state();
    if (typeof id !== 'string' || !id) return { ok: false, error: '没有指定服务' };
    if (cat.byId.has(id)) return { ok: false, error: '预设服务不能删除（可以在设置里隐藏）' };
    if (!customById.has(id)) return { ok: false, error: '没有这个服务' };
    const slots = keySlotsOf(id).length;
    const prevState = { services: u.services, pinned: u.pinned[id], keyBindings: u.keyBindings[id], confirmed: u.confirmed[id], retired: u.retired };
    try { secrets.clearService(id); } catch (e) { return { ok: false, error: `没能删除保存的密钥：${e && e.message || e}` }; }
    u.services = u.services.filter((s) => s.id !== id);
    customById.delete(id);
    delete u.pinned[id]; delete u.keyBindings[id]; delete u.confirmed[id]; delete u.overrides[id];
    u.retired = [...u.retired.filter((x) => x !== id), id].slice(-RETIRED_MAX);
    try { persist(); } catch (e) {
      u.retired = prevState.retired;
      u.services = prevState.services; customById.set(id, prevState.services.find((s) => s.id === id));
      if (prevState.pinned) u.pinned[id] = prevState.pinned;
      if (prevState.keyBindings) u.keyBindings[id] = prevState.keyBindings;
      if (prevState.confirmed) u.confirmed[id] = prevState.confirmed;
      return { ok: false, error: `没能写入服务配置：${e && e.message || e}` };
    }
    for (const fn of removeHooks) { try { fn(id); } catch { /* a cache that could not be cleaned */ } }
    return { ok: true, value: { clearedSlots: slots } };
  }

  /* ───────────── address overrides, pinned models, migration ───────────── */

  /**
   * A preset's address changed by the user ("服务地址" in 高级). null / '' removes the override.
   * A host the user has not approved yet is asked about in a native dialog when it would receive a saved key, or when it is an internal
   * (private) address. With no key saved yet the question waits for the first key (confirmKeyDestination); until then readKey refuses.
   * There is no "trusted" shortcut: the page (and so anything injected into it) is the only caller.
   * @param {{ confirm?: (o: object) => Promise<boolean> }} [o]
   */
  async function setOverride(id, endpointId, baseUrl, o = {}) {
    const service = cat.byId.get(id);
    if (!service) return { ok: false, error: '只有预设服务可以改地址（自定义服务请直接编辑）' };
    const ep = endpointOf(service, endpointId);
    if (!ep) return { ok: false, error: '没有这个地区 / 通道' };
    const u = state();
    if (baseUrl === null || baseUrl === undefined || baseUrl === '') {
      if (u.overrides[id]) { const was = u.overrides[id]; delete u.overrides[id]; try { persist(); } catch (e) { u.overrides[id] = was; return { ok: false, error: `没能写入：${e && e.message || e}` }; } }
      return { ok: true, value: null };
    }
    if (!ep.baseUrl || (ep.params && ep.params.length)) return { ok: false, error: '这个地区的地址由参数决定，不能直接改' };
    if (ep.kind === 'plan') return { ok: false, error: '套餐通道的地址不能改' };
    const c = net.checkBaseUrl(baseUrl);
    if (!c) return { ok: false, error: '服务地址不符合安全规则：只允许 https，或本机（127.0.0.1 / localhost / [::1]）的 http', field: 'baseUrl' };
    if (ep.kind === 'local' ? !c.url.startsWith('http://') : c.url.startsWith('http://')) return { ok: false, error: ep.kind === 'local' ? '本机服务的地址要用 http://127.0.0.1' : '这个服务的地址必须是 https', field: 'baseUrl' };
    // I4 (helper, not a boundary): a vendor's plan address cannot become the API address of a pay-as-you-go endpoint either
    const owner = planAddressOwner(c.url);
    if (owner) return { ok: false, error: `这是 ${owner} 的套餐地址：套餐 Key 只能给命令行编码工具用，不能当作 API 地址。`, field: 'baseUrl' };
    const presetHost = net.hostOfAddress(ep.baseUrl);
    const prev = u.overrides[id];
    const known = new Set([presetHost, prev && prev.confirmedHost].filter(Boolean));
    const isNew = !known.has(c.host);
    const keyed = keySlotsOf(id).length > 0;
    let confirmedHost = isNew ? '' : c.host;
    if (isNew && (keyed || c.private)) {
      const parts = [];
      if (keyed) parts.push(`「${service.name}」已保存的 API Key 之后会发往 ${c.host}（原来是 ${presetHost}）。`);
      if (c.private) parts.push(`${c.host} 是内网地址，栖枝只放行 https 的内网主机。`);
      const title = keyed ? '密钥将发往新的主机' : '这是内网地址';
      if (!o.confirm) return { ok: false, error: '需要你在弹窗里确认，已取消' };
      const yes = await o.confirm({ title, message: `${parts.join('')}继续？`, detail: keyed ? '这是中转站用户的常见做法，也是密钥外流的最短路径。只有你信任的主机才应该收到它。' : '请确认这台机器是你自己的，证书可信。' });
      if (!yes) return { ok: false, error: '已取消' };
      confirmedHost = c.host;
    }
    u.overrides[id] = { endpoint: ep.id, baseUrl: c.url, confirmedHost };
    try { persist(); } catch (e) { if (prev) u.overrides[id] = prev; else delete u.overrides[id]; return { ok: false, error: `没能写入：${e && e.message || e}` }; }
    return { ok: true, value: null };
  }

  function pin(id, model, on) {
    const service = get(id);
    if (!service) return { ok: false, error: '没有这个服务' };
    if (!net.checkModelId(model)) return { ok: false, error: '模型名不合法' };
    const u = state();
    const cur = u.pinned[id] || [];
    const next = on ? [...cur.filter((m) => m !== model), model].slice(-50) : cur.filter((m) => m !== model);
    const prev = u.pinned[id];
    if (next.length) u.pinned[id] = next; else delete u.pinned[id];
    try { persist(); } catch (e) { if (prev) u.pinned[id] = prev; else delete u.pinned[id]; return { ok: false, error: `没能写入：${e && e.message || e}` }; }
    return { ok: true, value: next };
  }

  /**
   * One-time carry-over from the old page settings (MODELS-SPEC §13): which region each old single-slot key belonged to, and the
   * "服务地址" fields users typed. An existing record is never overwritten. The request comes from the page, so it is NOT trusted:
   * an address goes through setOverride like any other (a new host that would receive a saved key is confirmed natively), and once a
   * carry-over has been processed the main process remembers it and takes no more.
   * @param {{ regions?: Record<string, string>, baseUrls?: Record<string, string> }} req
   * @param {{ confirm?: (o: object) => Promise<boolean> }} [o]
   */
  async function migrate(req, o = {}) {
    const r = isRec(req) ? req : {};
    const regions = isRec(r.regions) ? r.regions : {};
    const baseUrls = isRec(r.baseUrls) ? r.baseUrls : {};
    const u = state();
    const bound = [];
    const applied = [];
    const rejected = [];
    if (u.migrated) return { ok: true, value: { bound, applied, rejected, done: true } };
    const hints = secrets.hints();
    let dirty = false;
    for (const id of Object.keys(regions).slice(0, 100)) {
      const service = cat.byId.get(id);
      const region = regions[id];
      if (!service || typeof region !== 'string') continue;
      const ep = endpointOf(service, region);
      if (!ep || !ep.separateKey || !hints[id] || u.keyBindings[id]) continue;
      u.keyBindings[id] = ep.id;
      bound.push(id);
      dirty = true;
    }
    for (const id of Object.keys(baseUrls).slice(0, 100)) {
      const service = cat.byId.get(id);
      const url = baseUrls[id];
      if (!service || typeof url !== 'string' || !url.trim() || u.overrides[id]) continue;
      const ep = (typeof regions[id] === 'string' && endpointOf(service, regions[id])) || defaultEndpoint(service, 'api');
      if (!ep) { rejected.push({ id, reason: '找不到对应的地区' }); continue; }
      const res = await setOverride(id, ep.id, url.trim(), { confirm: o.confirm });
      if (res.ok) applied.push(id); else rejected.push({ id, reason: res.error });
    }
    if (Object.keys(regions).length || Object.keys(baseUrls).length) { u.migrated = true; dirty = true; }
    if (dirty) { try { persist(); } catch (e) { return { ok: false, error: `没能写入：${e && e.message || e}` }; } }
    return { ok: true, value: { bound, applied, rejected } };
  }

  /* ───────────── what the page may see ───────────── */

  const stripAgent = (a) => {
    const { exe: _exe, ...rest } = a;
    if (rest.registry && typeof rest.registry === 'object') rest.registry = { id: rest.registry.id, version: rest.registry.version, dist: rest.registry.dist };
    return rest;
  };
  function snapshot() {
    const u = state();
    return JSON.parse(JSON.stringify({ custom: u.services, agents: u.agents.map(stripAgent), overrides: u.overrides, pinned: u.pinned, keyBindings: u.keyBindings }));
  }

  /* ───────────── local service probe ───────────── */

  /** Ports of the local presets (those are the places a local model server usually listens), as probe candidates. */
  function localCandidates() {
    const out = [];
    for (const s of cat.presets) {
      if (s.group !== 'local') continue;
      for (const e of s.endpoints) {
        if (e.kind !== 'local' || !e.baseUrl) continue;
        const port = Number(new URL(e.baseUrl).port);
        if (!port) continue;
        out.push({ service: s.id, endpoint: e.id, port, paths: s.modelsApi && s.modelsApi.parser === 'ollama' ? ['/api/tags', '/v1/models'] : ['/v1/models'] });
      }
    }
    return out;
  }

  /** {object:'list', data:[{id}]} or Ollama's {models:[{name}]} → model ids; null when the body is not a model list. */
  function modelIdsFromList(json) {
    if (!isRec(json)) return null;
    let ids = null;
    if (json.object === 'list' && Array.isArray(json.data)) ids = json.data.map((m) => (isRec(m) ? m.id : undefined));
    else if (Array.isArray(json.models) && json.models.length >= 0 && !('object' in json) && json.models.every((m) => isRec(m) && typeof m.name === 'string')) ids = json.models.map((m) => m.name);
    if (!ids) return null;
    return ids.filter((x) => typeof x === 'string' && net.checkModelId(x)).slice(0, 100);
  }

  /**
   * GET each candidate port on 127.0.0.1: no credentials, no redirects, ≤ 1 s, ≤ 1 MB; only a body that really is a model list counts
   * (8000 / 8080 are often something else). 4 at a time.
   * @param {{ candidates?: Array<{ service: string, endpoint: string, port: number, paths: string[] }> }} [o]
   */
  async function probeLocal(o = {}) {
    const cands = o.candidates || localCandidates();
    const found = [];
    let next = 0;
    const worker = async () => {
      for (;;) {
        const c = cands[next++];
        if (!c) return;
        for (const p of c.paths) {
          let res;
          try { res = await net.fetchLimited(`http://127.0.0.1:${c.port}${p}`, { method: 'GET', headers: { accept: 'application/json' } }, { timeoutMs: 1000, maxBytes: 1024 * 1024 }); } catch { continue; }
          if (!res.ok) continue;
          const ids = modelIdsFromList(res.json);
          if (ids) { found.push({ service: c.service, endpoint: c.endpoint, port: c.port, models: ids }); break; }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, cands.length) }, worker));
    return found.sort((a, b) => cands.findIndex((c) => c.port === a.port) - cands.findIndex((c) => c.port === b.port));
  }

  return {
    catalog: cat, get, list, endpointOf, agentOf, slotFor, isKnown, keyMin, secretsConfig, readKey, keyHintFor, slotsToClear, dropBinding, releaseLegacySlot, destinationProblem, planAddressOwner,
    persist, setPseudoResolver: (fn) => { pseudoResolver = typeof fn === 'function' ? fn : () => undefined; },
    cliModelsFor, ctxOf, defaultEndpoint, resolveApi, resolveCompat, resolveAgent, cleanMessages,
    saveService, confirmKeyDestination, removeService, onRemove, setOverride, pin, migrate, snapshot, probeLocal, localCandidates, modelIdsFromList,
    overrideOf: (id) => state().overrides[id], pinnedOf: (id) => (state().pinned[id] || []).slice(), bindingOf: (id) => state().keyBindings[id],
    reload: () => { user = null; load(); },
    userFile: fileOf,
    _state: state,
  };
}

/* ═════════════════════════ the app's registry + IPC ═════════════════════════ */

let shared = null;
/** The registry of the running app (user data in Electron's userData folder); also tells secrets.cjs which slots exist. */
function instance() {
  if (!shared) {
    shared = createRegistry({ userDir: () => require('electron').app.getPath('userData') });
    require('./secrets.cjs').configure(shared.secretsConfig());
    // The command-line agents (catalog + the user's) on this registry; each stand-alone one is a service named acp_<id>.
    // Required here, not at the top of the file: acp-agents.cjs requires this one.
    const acpAgents = require('./acp-agents.cjs');
    const agents = acpAgents.createAcpAgents({ registry: shared, userData: () => require('electron').app.getPath('userData') });
    shared.setPseudoResolver((id) => agents.pseudoServiceById(id));
    acpAgents.__setInstance(agents);
  }
  return shared;
}
/** Tests: replace the shared registry. */
function __setInstance(reg) { shared = reg; if (reg) require('./secrets.cjs').configure(reg.secretsConfig()); }

/** A native yes/no the page cannot press. */
async function nativeConfirm(e, o) {
  const { dialog, BrowserWindow } = require('electron');
  const win = e && e.sender ? BrowserWindow.fromWebContents(e.sender) : null;
  const box = { type: 'warning', buttons: ['继续', '取消'], defaultId: 1, cancelId: 1, noLink: true, title: o.title || '栖枝', message: String(o.message || ''), detail: o.detail ? String(o.detail) : undefined };
  const r = win ? await dialog.showMessageBox(win, box) : await dialog.showMessageBox(box);
  return r.response === 0;
}

/** The live-list service of the running app (cache in userData/model-cache.json). */
let modelsApiShared = null;
function modelsApi(reg = instance()) {
  if (!modelsApiShared || modelsApiShared.registry !== reg) {
    modelsApiShared = require('./models-api.cjs').createModelsApi({
      registry: reg,
      cacheFile: () => path.join(require('electron').app.getPath('userData'), 'model-cache.json'),
      tooSoon: (key, ms, now) => tooSoon(key, ms, now),
    });
    modelsApiShared.registry = reg;
  }
  return modelsApiShared;
}

const lastCall = new Map();
/** At most one call per `ms` for a key (§12.5). */
function tooSoon(key, ms, now = Date.now()) {
  const last = lastCall.get(key) || 0;
  if (now - last < ms) return true;
  lastCall.set(key, now);
  return false;
}

const short = (v, n) => (typeof v === 'string' && v.length <= n ? v : null);

/**
 * Register the svc:* channels. `handle` is the sender-checked wrapper from index.cjs.
 * @param {(channel: string, fn: Function) => void} handle
 * @param {{ confirm?: (e: object, o: object) => Promise<boolean>, registry?: object }} [deps]
 */
function register(handle, deps = {}) {
  const reg = deps.registry || instance();
  const confirmFor = (e) => (o) => (deps.confirm ? deps.confirm(e, o) : nativeConfirm(e, o));
  handle('svc:list', () => reg.snapshot());
  handle('svc:save', (e, def) => reg.saveService(def, { confirm: confirmFor(e) }));
  handle('svc:remove', (_e, id) => reg.removeService(short(id, 64) || ''));
  handle('svc:override', (e, id, endpoint, baseUrl) => reg.setOverride(short(id, 64) || '', short(endpoint, 32) || '', typeof baseUrl === 'string' ? baseUrl.slice(0, 600) : null, { confirm: confirmFor(e) }));
  handle('svc:pin', (_e, id, model, on) => reg.pin(short(id, 64) || '', short(model, 120) || '', !!on));
  handle('svc:migrate', (e, req) => reg.migrate(req, { confirm: confirmFor(e) }));
  let lastProbe = [];
  handle('svc:probe-local', async () => {
    if (tooSoon('probe-local', 10_000)) return lastProbe;
    lastProbe = await reg.probeLocal();
    return lastProbe;
  });
  // the live model lists (svc:models) and one model's details (svc:model-detail)
  handle('svc:models', (_e, req) => modelsApi(reg).listModels(req));
  handle('svc:model-detail', (_e, req) => modelsApi(reg).modelDetail(req));
}

module.exports = {
  catalog, createRegistry, instance, __setInstance, register, modelsApi, loadCatalog, agentIdOfDriver, listedDriver, nativeConfirm, tooSoon,
  slugId, stableStringify, ID_RE,
};
