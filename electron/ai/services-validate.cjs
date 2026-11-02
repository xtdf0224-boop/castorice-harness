'use strict';
// validateService / validateAgent (MODELS-SPEC §4 "校验规则"): one validator for the presets in catalog/*.json and for the
// custom services a user saves. A preset that fails stops the app from starting (and the check names the id and the field);
// a custom service that fails is refused with { ok:false, error, field } and nothing is written.
//
// The result is a NORMALIZED COPY built from known fields only, so unknown keys, `__proto__` and friends never survive.
// Pure: no Electron, no disk.
const net = require('./net.cjs');
const { ORDER } = require('./effort-wire.cjs');

const STYLES_LIST = ['anthropic', 're', 're-think', 'think-switch', 'enable-thinking', 'minimax', 'openrouter', 'none'];

const GROUPS = ['intl', 'cn', 'hub', 'local', 'cli'];
const API_PROTOCOLS = ['openai-chat', 'anthropic'];
const RESERVED_PROTOCOLS = ['openai-responses', 'gemini', 'converse'];
const SCHEMES = ['bearer', 'x-api-key', 'api-key', 'header', 'both', 'none'];
const THINK_SOURCES = ['reasoning_content', 'reasoning', 'reasoning_details', 'think-tag', 'content-parts'];
const MODEL_STATUS = ['active', 'preview', 'retiring', 'deprecated', 'retired'];
const OFF_WIRES = ['none', 'disabled', 'between_tools'];
const MODELS_PARSERS = ['openai', 'anthropic', 'deepseek', 'kimi', 'mistral', 'openrouter', 'vercel', 'ollama', 'lmstudio', 'gemini'];
const BUILTIN_DRIVERS = ['claude-code', 'claude-compat', 'codex', 'dsh'];
const LEGACY_ACP_DRIVERS = ['kimi', 'qwen', 'mcode'];
const CORE_BODY_FIELDS = new Set(['model', 'messages', 'stream', 'system', 'max_tokens', 'max_completion_tokens']);

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENDPOINT_ID_RE = /^[a-z][a-z0-9-]{0,15}$/;
const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,24}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const INT_MAX = 2 ** 31 - 1;

class Bad extends Error {
  constructor(field, message) { super(message); this.field = field; }
}
const bad = (field, message) => { throw new Bad(field, message); };

/* ───────────── small helpers ───────────── */

function str(v, field, max, o = {}) {
  if (typeof v !== 'string') bad(field, o.label ? `${o.label}不能为空` : `${field} 必须是文字`);
  if (v.length < (o.min ?? 1) || v.length > max) bad(field, `${o.label || field} 的长度要在 ${o.min ?? 1}–${max} 个字符之间`);
  if (!o.multiline && CONTROL.test(v)) bad(field, `${o.label || field} 里有不能显示的字符`);
  if (o.multiline && /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v)) bad(field, `${o.label || field} 里有不能显示的字符`);
  // an address that is saved and later sent a key to: no whitespace of any kind (NBSP, BOM…) and no invisible characters anywhere
  if (o.address && net.ADDRESS_BAD_CHARS.test(v)) bad(field, `${o.label || field} 里有空格或不可见的字符，请重新输入`);
  return v;
}
const optStr = (v, field, max, o = {}) => (v === undefined || v === null ? undefined : str(v, field, max, { min: 0, ...o }));
function int(v, field, min, max) {
  if (!Number.isInteger(v) || v < min || v > max) bad(field, `${field} 必须是 ${min}–${max} 之间的整数`);
  return v;
}
const optInt = (v, field, min, max) => (v === undefined || v === null ? undefined : int(v, field, min, max));
function oneOf(v, field, list) {
  if (!list.includes(v)) bad(field, `${field} 的取值不对`);
  return v;
}
function bool(v, field) {
  if (typeof v !== 'boolean') bad(field, `${field} 必须是 true 或 false`);
  return v;
}
function arr(v, field, max) {
  if (!Array.isArray(v)) bad(field, `${field} 必须是列表`);
  if (v.length > max) bad(field, `${field} 最多 ${max} 项`);
  return v;
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const obj = (v, field) => { if (!isObj(v)) bad(field, `${field} 必须是对象`); return v; };
const date = (v, field) => { if (typeof v !== 'string' || !DATE_RE.test(v) || Number.isNaN(Date.parse(v))) bad(field, `${field} 必须是 YYYY-MM-DD 日期`); return v; };
function httpsUrl(v, field) {
  const s = str(v, field, 300);
  let u;
  try { u = new URL(s); } catch { bad(field, `${field} 不是合法的网址`); }
  if (u.protocol !== 'https:') bad(field, `${field} 必须是 https 网址`);
  return s;
}

/* ───────────── effort specs ───────────── */

function normEffortSpec(raw, field) {
  obj(raw, field);
  const style = oneOf(raw.style, `${field}.style`, STYLES_LIST);
  const levels = arr(raw.levels ?? [], `${field}.levels`, 8).map((l, i) => oneOf(l, `${field}.levels[${i}]`, ORDER.filter((x) => x !== 'ultra')));
  const out = { style, levels: ORDER.filter((l) => levels.includes(l)) };
  if (raw.default !== undefined) {
    if (raw.default !== 'on') oneOf(raw.default, `${field}.default`, ORDER.filter((x) => x !== 'ultra' && x !== 'off'));
    out.default = raw.default;
  }
  if (raw.offWire !== undefined) out.offWire = oneOf(raw.offWire, `${field}.offWire`, OFF_WIRES);
  if (raw.effortField !== undefined) out.effortField = bool(raw.effortField, `${field}.effortField`);
  if (raw.note !== undefined) out.note = str(raw.note, `${field}.note`, 200);
  if (style === 'none' && out.levels.length) bad(field, `${field}：style 为 none 时不能有档位`);
  if (out.levels.includes('off')) {
    if (style === 're' && out.offWire !== 'none') bad(field, `${field}：re 风格要支持「关闭」必须写 offWire: "none"`);
    if (style === 'anthropic' && !['disabled', 'between_tools'].includes(out.offWire)) bad(field, `${field}：anthropic 风格要支持「关闭」必须写 offWire`);
  }
  return out;
}

/* ───────────── models ───────────── */

function normModel(raw, field, ctx) {
  obj(raw, field);
  const out = {};
  // '' is the CLI "tool default" entry; only cliModels uses it
  if (raw.id === '' && ctx.allowEmptyId) out.id = '';
  else {
    str(raw.id, `${field}.id`, 100);
    if (!net.checkModelId(raw.id)) bad(`${field}.id`, `模型名「${raw.id.slice(0, 30)}」里有不支持的字符（只能用字母、数字和 . _ - : / @ ~ [ ]）`);
    out.id = raw.id;
  }
  const label = optStr(raw.label, `${field}.label`, 80); if (label) out.label = label;
  const note = optStr(raw.note, `${field}.note`, 120); if (note) out.note = note;
  const ctxN = optInt(raw.ctx, `${field}.ctx`, 1, INT_MAX); if (ctxN) out.ctx = ctxN;
  const maxOut = optInt(raw.maxOut, `${field}.maxOut`, 1, INT_MAX); if (maxOut) out.maxOut = maxOut;
  if (raw.effort !== undefined) {
    if (typeof raw.effort === 'string') {
      if (!ctx.profiles || !Object.hasOwn(ctx.profiles, raw.effort)) bad(`${field}.effort`, `推理强度档案「${raw.effort}」不存在`);
      out.effort = raw.effort;
    } else out.effort = normEffortSpec(raw.effort, `${field}.effort`);
  }
  if (raw.caps !== undefined) {
    obj(raw.caps, `${field}.caps`);
    out.caps = {};
    for (const k of ['tools', 'vision', 'reasoning']) if (raw.caps[k] !== undefined) out.caps[k] = bool(raw.caps[k], `${field}.caps.${k}`);
  }
  if (raw.status !== undefined) out.status = oneOf(raw.status, `${field}.status`, MODEL_STATUS);
  if (raw.retiresAt !== undefined) out.retiresAt = date(raw.retiresAt, `${field}.retiresAt`);
  return out;
}

function normModels(list, field, max, ctx) {
  arr(list, field, max);
  const seen = new Set();
  return list.map((m, i) => {
    const v = normModel(m, `${field}[${i}]`, ctx);
    if (seen.has(v.id)) bad(`${field}[${i}].id`, `模型「${v.id}」重复了`);
    seen.add(v.id);
    return v;
  });
}

/* ───────────── auth / wire ───────────── */

function normAuth(raw, field) {
  obj(raw, field);
  const out = { scheme: oneOf(raw.scheme, `${field}.scheme`, SCHEMES) };
  if (out.scheme === 'header') {
    if (typeof raw.header !== 'string' || !net.checkHeaderName(raw.header, { auth: true })) bad(`${field}.header`, '自定义鉴权头的名字不合法（或是不允许使用的头）');
    out.header = raw.header;
  } else if (raw.header !== undefined) bad(`${field}.header`, '只有 scheme 为 header 时才需要头名');
  if (raw.keyOptional !== undefined) out.keyOptional = bool(raw.keyOptional, `${field}.keyOptional`);
  const hint = optStr(raw.keyPrefixHint, `${field}.keyPrefixHint`, 20); if (hint) out.keyPrefixHint = hint;
  const keyMin = optInt(raw.keyMin, `${field}.keyMin`, 1, 64); if (keyMin) out.keyMin = keyMin;
  return out;
}

function normWire(raw, field, ctx) {
  obj(raw, field);
  const out = {};
  if (raw.chatPath !== undefined) {
    const p = str(raw.chatPath, `${field}.chatPath`, 100);
    if (!/^\/[\w\-./]*$/.test(p) || p.includes('..') || p.includes('//')) bad(`${field}.chatPath`, '请求路径不合法');
    out.chatPath = p;
  }
  if (raw.maxTokensField !== undefined) out.maxTokensField = oneOf(raw.maxTokensField, `${field}.maxTokensField`, ['max_tokens', 'max_completion_tokens', 'auto']);
  if (raw.streamUsage !== undefined) out.streamUsage = oneOf(raw.streamUsage, `${field}.streamUsage`, ['include_usage', 'none']);
  if (raw.thinkIn !== undefined) out.thinkIn = arr(raw.thinkIn, `${field}.thinkIn`, 5).map((s, i) => oneOf(s, `${field}.thinkIn[${i}]`, THINK_SOURCES));
  if (raw.contentParts !== undefined) out.contentParts = bool(raw.contentParts, `${field}.contentParts`);
  if (raw.dropFields !== undefined) {
    out.dropFields = arr(raw.dropFields, `${field}.dropFields`, 20).map((f, i) => {
      if (typeof f !== 'string' || !/^[a-z_][a-z0-9_]{0,40}$/.test(f)) bad(`${field}.dropFields[${i}]`, '要丢弃的字段名不合法');
      if (CORE_BODY_FIELDS.has(f)) bad(`${field}.dropFields[${i}]`, `不能丢弃核心字段「${f}」`);
      return f;
    });
  }
  if (raw.anthropicVersion !== undefined) {
    const v = str(raw.anthropicVersion, `${field}.anthropicVersion`, 12);
    if (!DATE_RE.test(v)) bad(`${field}.anthropicVersion`, 'anthropic-version 必须是 YYYY-MM-DD');
    out.anthropicVersion = v;
  }
  if (raw.defaultThinking !== undefined) {
    if (ctx.mode === 'custom') bad(`${field}.defaultThinking`, '自定义服务不能设置默认思考');
    obj(raw.defaultThinking, `${field}.defaultThinking`);
    out.defaultThinking = { type: oneOf(raw.defaultThinking.type, `${field}.defaultThinking.type`, ['adaptive']), display: oneOf(raw.defaultThinking.display, `${field}.defaultThinking.display`, ['summarized', 'omitted']) };
  }
  const dm = optInt(raw.defaultMaxOut, `${field}.defaultMaxOut`, 256, 2_000_000); if (dm) out.defaultMaxOut = dm;
  const tm = optInt(raw.testMaxTokens, `${field}.testMaxTokens`, 16, 65536); if (tm) out.testMaxTokens = tm;
  return out;
}

/* ───────────── endpoints ───────────── */

function normParams(raw, field) {
  return arr(raw, field, 6).map((p, i) => {
    const f = `${field}[${i}]`;
    obj(p, f);
    if (typeof p.name !== 'string' || !/^[A-Za-z][A-Za-z0-9]{0,23}$/.test(p.name)) bad(`${f}.name`, '占位符名字不合法');
    const out = { name: p.name, label: str(p.label, `${f}.label`, 40), pattern: str(p.pattern, `${f}.pattern`, 120) };
    const problem = net.patternProblem(out.pattern);
    if (problem) bad(`${f}.pattern`, problem);
    const ex = optStr(p.example, `${f}.example`, 60); if (ex) out.example = ex;
    return out;
  });
}

/**
 * An address of an endpoint: placeholders are replaced by a neutral label for the check; real values are checked again when a request is built.
 * What is STORED is the canonical text (scheme and host in lower case, `https:host` spelled out…), never the raw input: the confirmations
 * ("this key goes to a new host"), the saved approvals and the runtime check all read the host from the stored text.
 */
function normUrl(v, field, endpointKind, params) {
  str(v, field, 512, { address: true, label: '服务地址' });
  const problem = net.templateProblem(v);
  if (problem) bad(field, problem);
  const names = net.placeholderNames(v);
  for (const n of names) if (!params.some((p) => p.name === n)) bad(field, `地址里的 {${n}} 没有在 params 里声明`);
  const probe = v.replace(net.PLACEHOLDER, 'x');
  const check = net.checkBaseUrl(probe);
  if (!check) bad(field, '服务地址不符合安全规则：只允许 https，或本机（127.0.0.1 / localhost / [::1]）的 http');
  const isHttp = check.url.startsWith('http://');
  if (endpointKind === 'local' && !isHttp) bad(field, '本机端点必须是 http://127.0.0.1（或 localhost / [::1]）');
  if (endpointKind !== 'local' && isHttp) bad(field, '只有「本机」类型的端点才能用 http');
  if (isHttp && names.length) bad(field, '本机地址不能带占位符');
  if (names.length) {
    // a template cannot be re-spelled by the URL parser (its placeholders would be replaced): it must already be in lower-case canonical shape
    const hostPart = (/^https:\/\/([^/]*)/.exec(v) || [])[1];
    if (hostPart === undefined || hostPart.replace(net.PLACEHOLDER, '') !== hostPart.replace(net.PLACEHOLDER, '').toLowerCase()) bad(field, '带占位符的地址要以小写的 https:// 开头，主机名用小写字母');
    return { value: v.replace(/\/+$/, ''), check, hasPlaceholder: true };
  }
  return { value: check.url, check, hasPlaceholder: false };
}

function normEndpoint(raw, field, ctx) {
  obj(raw, field);
  if (typeof raw.id !== 'string' || !ENDPOINT_ID_RE.test(raw.id)) bad(`${field}.id`, '端点 id 不合法');
  const out = { id: raw.id, label: str(raw.label, `${field}.label`, 40), kind: oneOf(raw.kind, `${field}.kind`, ['payg', 'plan', 'local']) };
  const params = raw.params === undefined ? [] : normParams(raw.params, `${field}.params`);
  if (params.length) out.params = params;
  if (raw.baseUrl !== undefined) out.baseUrl = normUrl(raw.baseUrl, `${field}.baseUrl`, out.kind, params).value;
  if (raw.compatUrl !== undefined) out.compatUrl = normUrl(raw.compatUrl, `${field}.compatUrl`, out.kind, params).value;
  if (raw.responsesUrl !== undefined) out.responsesUrl = normUrl(raw.responsesUrl, `${field}.responsesUrl`, out.kind, params).value;
  if (!out.baseUrl && !out.compatUrl) bad(field, '端点至少要有 baseUrl 或 compatUrl');
  if (raw.separateKey !== undefined) out.separateKey = bool(raw.separateKey, `${field}.separateKey`);
  if (raw.models !== undefined) out.models = normModels(raw.models, `${field}.models`, 500, { profiles: ctx.profiles });
  if (raw.compat !== undefined) {
    obj(raw.compat, `${field}.compat`);
    out.compat = {};
    const acw = optInt(raw.compat.autoCompactWindow, `${field}.compat.autoCompactWindow`, 1000, 10_000_000); if (acw) out.compat.autoCompactWindow = acw;
    if (raw.compat.experimental !== undefined) out.compat.experimental = bool(raw.compat.experimental, `${field}.compat.experimental`);
    const n = optStr(raw.compat.note, `${field}.compat.note`, 200); if (n) out.compat.note = n;
  }
  if (raw.auth !== undefined) out.auth = normAuth(raw.auth, `${field}.auth`);
  if (raw.wire !== undefined) out.wire = normWire(raw.wire, `${field}.wire`, ctx);
  const note = optStr(raw.note, `${field}.note`, 200); if (note) out.note = note;
  return out;
}

/* ───────────── cliModels / drivers ───────────── */

/** A driver id as the registry knows it: built-in, legacy ACP alias, or acp:<known agent>. */
function normDriverId(v, field, ctx) {
  const id = str(v, field, 40);
  if (BUILTIN_DRIVERS.includes(id) || LEGACY_ACP_DRIVERS.includes(id)) return id;
  const m = /^acp:([a-z][a-z0-9-]{1,24})$/.exec(id);
  if (m) { if (!ctx.agentIds || !ctx.agentIds.has(m[1])) bad(field, `命令行代理「${m[1]}」不存在`); return id; }
  return bad(field, `驱动「${id}」不认识`);
}

function normCliModels(raw, field, models, ctx) {
  obj(raw, field);
  const out = {};
  for (const key of Object.keys(raw)) {
    const driver = normDriverId(key, `${field}.${key}`, ctx);
    out[driver] = arr(raw[key], `${field}.${key}`, 60).map((m, i) => {
      const f = `${field}.${key}[${i}]`;
      if (typeof m === 'string') {
        if (m === '*') return '*';
        if (!models.some((x) => x.id === m)) bad(f, `引用的模型「${m}」不在 models 里`);
        return m;
      }
      return normModel(m, f, { profiles: ctx.profiles, allowEmptyId: true });
    });
  }
  return out;
}

/* ───────────── modelsApi ───────────── */

function normModelsApi(raw, field, endpoints) {
  obj(raw, field);
  const p = str(raw.path, `${field}.path`, 100);
  if (!/^\/[\w\-./]*$/.test(p) || p.includes('..')) bad(`${field}.path`, '模型列表路径不合法');
  const out = { path: p, parser: oneOf(raw.parser, `${field}.parser`, MODELS_PARSERS), auth: oneOf(raw.auth, `${field}.auth`, ['required', 'optional', 'none']) };
  if (raw.from !== undefined) out.from = oneOf(raw.from, `${field}.from`, ['base', 'origin']);
  if (raw.authOverride !== undefined) out.authOverride = normAuth(raw.authOverride, `${field}.authOverride`);
  if (raw.query !== undefined) {
    obj(raw.query, `${field}.query`);
    out.query = {};
    for (const k of Object.keys(raw.query)) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,30}$/.test(k) || ['__proto__', 'constructor', 'prototype'].includes(k)) bad(`${field}.query`, '查询参数名不合法');
      out.query[k] = str(raw.query[k], `${field}.query.${k}`, 60, { min: 0 });
    }
  }
  if (raw.chatOnly !== undefined) out.chatOnly = bool(raw.chatOnly, `${field}.chatOnly`);
  if (raw.onlyEndpoints !== undefined) {
    out.onlyEndpoints = arr(raw.onlyEndpoints, `${field}.onlyEndpoints`, 8).map((e, i) => {
      if (!endpoints.some((x) => x.id === e)) bad(`${field}.onlyEndpoints[${i}]`, `端点「${e}」不存在`);
      return e;
    });
  }
  if (raw.detail !== undefined) {
    obj(raw.detail, `${field}.detail`);
    const dp = str(raw.detail.path, `${field}.detail.path`, 100);
    if (!/^\/[\w\-./]*$/.test(dp) || dp.includes('..')) bad(`${field}.detail.path`, '详情路径不合法');
    out.detail = { path: dp, method: oneOf(raw.detail.method, `${field}.detail.method`, ['GET', 'POST']) };
  }
  const ttl = optInt(raw.ttlMs, `${field}.ttlMs`, 1000, 7 * 24 * 3600 * 1000); if (ttl) out.ttlMs = ttl;
  return out;
}

/* ───────────── the service ───────────── */

/**
 * @param {unknown} raw
 * @param {{ mode: 'preset'|'custom', agentIds?: Set<string> }} ctx
 * @returns {{ ok: true, value: object, hosts: string[], private: string[] } | { ok: false, error: string, field?: string }}
 */
function validateService(raw, ctx) {
  try {
    obj(raw, 'service');
    const mode = ctx.mode;
    const out = {};
    // identity
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) bad('id', '服务 id 不合法（小写字母开头，只含小写字母、数字、_、-，最长 32 位）');
    if (mode === 'preset' && (raw.id.startsWith('x_') || raw.id.startsWith('acp_'))) bad('id', '预设的 id 不能以 x_ 或 acp_ 开头');
    if (mode === 'custom' && !raw.id.startsWith('x_')) bad('id', '自定义服务的 id 必须以 x_ 开头');
    out.id = raw.id;
    out.kind = mode === 'preset' ? 'preset' : 'custom';
    if (raw.kind !== undefined && raw.kind !== out.kind) bad('kind', `kind 应为 ${out.kind}`);
    out.name = str(raw.name, 'name', 40, { label: '名称' });
    out.vendor = str(raw.vendor, 'vendor', 40, { label: '厂商' });
    if (typeof raw.glyph !== 'string' || [...raw.glyph].length < 1 || [...raw.glyph].length > 2 || CONTROL.test(raw.glyph)) bad('glyph', '徽记要 1–2 个字符');
    out.glyph = raw.glyph;
    out.group = oneOf(raw.group, 'group', GROUPS);
    if (raw.aliases !== undefined) out.aliases = arr(raw.aliases, 'aliases', 20).map((a, i) => str(a, `aliases[${i}]`, 40));
    // protocol
    if (RESERVED_PROTOCOLS.includes(raw.protocol)) bad('protocol', `协议 ${raw.protocol} 暂时不支持保存`);
    out.protocol = oneOf(raw.protocol, 'protocol', API_PROTOCOLS);
    // auth / headers / wire / extraBody
    out.auth = normAuth(raw.auth, 'auth');
    if (mode === 'custom' && out.auth.scheme === 'none') { /* checked after endpoints: only loopback endpoints may be keyless */ }
    if (raw.headers !== undefined) {
      obj(raw.headers, 'headers');
      const names = Object.keys(raw.headers);
      if (names.length > 8) bad('headers', '额外请求头最多 8 项');
      out.headers = {};
      for (const n of names) {
        if (!net.checkHeaderName(n)) bad(`headers.${n.slice(0, 20)}`, `请求头「${n.slice(0, 30)}」的名字不合法，或是不允许自定义的头`);
        if (!net.checkHeaderValue(raw.headers[n])) bad(`headers.${n}`, `请求头「${n}」的值不合法（只能是不超过 256 个可打印 ASCII 字符）`);
        out.headers[n] = raw.headers[n];
      }
    }
    // effort profiles first: models refer to them
    let profiles;
    if (raw.effortProfiles !== undefined) {
      obj(raw.effortProfiles, 'effortProfiles');
      profiles = {};
      for (const name of Object.keys(raw.effortProfiles)) {
        if (!/^[A-Za-z][\w-]{0,24}$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) bad('effortProfiles', `档案名「${name.slice(0, 20)}」不合法`);
        profiles[name] = normEffortSpec(raw.effortProfiles[name], `effortProfiles.${name}`);
      }
      out.effortProfiles = profiles;
    }
    const mctx = { mode, agentIds: ctx.agentIds, profiles };
    if (raw.wire !== undefined) out.wire = normWire(raw.wire, 'wire', mctx);
    if (raw.extraBody !== undefined) {
      if (mode !== 'custom') bad('extraBody', '只有自定义服务可以设置额外请求体');
      const r = net.checkExtraBody(raw.extraBody);
      if (!r.ok) bad('extraBody', r.error);
      if (Object.keys(r.value).length) out.extraBody = r.value;
    }
    // endpoints
    const eps = arr(raw.endpoints, 'endpoints', 8);
    if (eps.length < 1) bad('endpoints', '至少要有 1 个端点');
    out.endpoints = eps.map((e, i) => normEndpoint(e, `endpoints[${i}]`, mctx));
    const seenEp = new Set();
    for (const e of out.endpoints) { if (seenEp.has(e.id)) bad('endpoints', `端点 id「${e.id}」重复了`); seenEp.add(e.id); }
    if (mode === 'custom' && out.auth.scheme === 'none' && out.endpoints.some((e) => e.kind !== 'local')) bad('auth.scheme', '「无鉴权」只能用于本机地址');
    if (mode === 'custom' && out.auth.keyOptional && out.endpoints.some((e) => e.kind !== 'local')) bad('auth.keyOptional', '「不需要密钥」只能用于本机地址');
    // models
    out.models = normModels(raw.models ?? [], 'models', 500, mctx);
    if (mode === 'custom' && out.models.length < 1) bad('models', '至少要填一个模型');
    if (raw.defaultModel !== undefined) {
      const d = str(raw.defaultModel, 'defaultModel', 100);
      if (!out.models.some((m) => m.id === d)) bad('defaultModel', '默认模型不在 models 里');
      out.defaultModel = d;
    }
    const hint = optStr(raw.modelHint, 'modelHint', 160); if (hint) out.modelHint = hint;
    // effort
    if (raw.effortRules !== undefined) {
      if (mode === 'custom') bad('effortRules', '自定义服务不能写推理强度规则，请按模型逐个指定');
      out.effortRules = arr(raw.effortRules, 'effortRules', 30).map((r, i) => {
        const f = `effortRules[${i}]`;
        obj(r, f);
        const match = str(r.match, `${f}.match`, 120);
        let flags = '';
        if (r.flags !== undefined) { flags = str(r.flags, `${f}.flags`, 4, { min: 0 }); if (!/^[imsu]*$/.test(flags)) bad(`${f}.flags`, '正则标志只能是 i m s u'); }
        try { new RegExp(match, flags); } catch { bad(`${f}.match`, '规则不是合法的正则'); }
        if (typeof r.effort !== 'string' || !profiles || !Object.hasOwn(profiles, r.effort)) bad(`${f}.effort`, `规则指向的档案「${String(r.effort).slice(0, 20)}」不存在`);
        return flags ? { match, flags, effort: r.effort } : { match, effort: r.effort };
      });
    }
    if (raw.effortDefault !== undefined) {
      if (raw.effortDefault !== 'none' && (!profiles || !Object.hasOwn(profiles, raw.effortDefault))) bad('effortDefault', '默认档案不存在');
      out.effortDefault = raw.effortDefault;
    }
    // drivers / cli models
    if (mode === 'custom') {
      out.drivers = arr(raw.drivers ?? [], 'drivers', 6).map((d, i) => {
        const id = normDriverId(d, `drivers[${i}]`, mctx);
        if (!(id === 'claude-compat' || id.startsWith('acp:'))) bad(`drivers[${i}]`, '自定义服务只能用 claude-compat 或命令行代理');
        return id;
      });
    } else {
      out.drivers = arr(raw.drivers ?? [], 'drivers', 8).map((d, i) => normDriverId(d, `drivers[${i}]`, mctx));
    }
    if (out.drivers.includes('claude-compat') && !out.endpoints.some((e) => e.compatUrl)) bad('drivers', '用 claude-compat 至少要有一个端点填了 Anthropic 兼容地址');
    if (raw.cliModels !== undefined) out.cliModels = normCliModels(raw.cliModels, 'cliModels', out.models, mctx);
    if (raw.modelsApi !== undefined) out.modelsApi = normModelsApi(raw.modelsApi, 'modelsApi', out.endpoints);
    const dctx = optInt(raw.defaultCtx, 'defaultCtx', 1024, INT_MAX); if (dctx) out.defaultCtx = dctx;
    // links and texts
    if (raw.keyUrl !== undefined) out.keyUrl = httpsUrl(raw.keyUrl, 'keyUrl');
    if (raw.docsUrl !== undefined) out.docsUrl = httpsUrl(raw.docsUrl, 'docsUrl');
    out.keyHelp = str(raw.keyHelp ?? (mode === 'custom' ? '自定义服务' : ''), 'keyHelp', 600, { min: mode === 'custom' ? 0 : 1, multiline: true });
    if (raw.flags !== undefined) {
      obj(raw.flags, 'flags');
      out.flags = {};
      if (raw.flags.claudeAuthPath !== undefined) out.flags.claudeAuthPath = bool(raw.flags.claudeAuthPath, 'flags.claudeAuthPath');
      const warn = optInt(raw.flags.ctxWarnBelow, 'flags.ctxWarnBelow', 1, INT_MAX); if (warn) out.flags.ctxWarnBelow = warn;
      const port = optInt(raw.flags.probePort, 'flags.probePort', 1, 65535); if (port) out.flags.probePort = port;
    }
    out.verified = date(raw.verified, 'verified');
    if (raw.unverified !== undefined) out.unverified = arr(raw.unverified, 'unverified', 12).map((u, i) => str(u, `unverified[${i}]`, 300));
    if (raw.hidden !== undefined) out.hidden = bool(raw.hidden, 'hidden');
    // size (custom services are user data)
    if (mode === 'custom' && JSON.stringify(out).length > 64 * 1024) bad('service', '这个服务的配置超过 64 KB');
    // hosts the key would be sent to (for the "key goes to…" confirmation) and internal addresses — read from the stored (canonical) text by
    // the one function everything else uses (net.hostOfAddress), never cut out of the raw string
    const hosts = new Set();
    const priv = new Set();
    for (const e of out.endpoints) {
      for (const u of [e.baseUrl, e.compatUrl, e.responsesUrl]) {
        if (!u) continue;
        const c = net.checkBaseUrl(u.replace(net.PLACEHOLDER, 'x'));
        const host = net.hostOfAddress(u);
        if (!c || !host) bad('endpoints', '服务地址不符合安全规则');
        hosts.add(host);
        if (c.private) priv.add(host);
      }
    }
    return { ok: true, value: out, hosts: [...hosts], private: [...priv] };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message, field: e.field };
    throw e;
  }
}

/* ───────────── command-line agents (ACP) ───────────── */

/** Environment variable names an agent definition may set (MODELS-SPEC §12.4). */
const ENV_NAME = /^[A-Z][A-Z0-9_]{2,40}$/;
const ENV_DENY = [
  /^(PATH|PATHEXT|COMSPEC|SYSTEMROOT|SYSTEMDRIVE|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA)$/, /^PROGRAMFILES/, /^NODE_(OPTIONS|PATH|EXTRA_CA_CERTS|TLS_REJECT_UNAUTHORIZED)$/,
  /^SSL_CERT_/, /^(REQUESTS_CA_BUNDLE|CURL_CA_BUNDLE)$/, /^PYTHON/, /^PIP_/, /^LD_/, /^DYLD_/, /_PROXY$/, /^GIT_/, /^NPM_CONFIG_/, /^(CLAUDE_CONFIG_DIR|CODEX_HOME)$/,
];
function envNameProblem(name) {
  if (typeof name !== 'string' || !ENV_NAME.test(name)) return '环境变量名不合法';
  if (ENV_DENY.some((re) => re.test(name))) return `环境变量「${name}」不允许设置`;
  return '';
}
const ENV_TEMPLATE_VARS = new Set(['baseUrl', 'model', 'endpoint']);
function envValueProblem(v) {
  if (typeof v !== 'string' || v.length > 2000 || CONTROL.test(v)) return '环境变量的值不合法';
  for (const m of v.matchAll(/\{(\w+)\}/g)) if (!ENV_TEMPLATE_VARS.has(m[1])) return `模板里不认识 {${m[1]}}`;
  return '';
}
const ARG_RE = /^[\w.=:@/-]{1,60}$/;

/** @returns {{ ok: true, value: object } | { ok: false, error: string, field?: string }} */
function validateAgent(raw, ctx = {}) {
  try {
    obj(raw, 'agent');
    if (typeof raw.id !== 'string' || !AGENT_ID_RE.test(raw.id)) bad('id', '代理 id 不合法');
    const out = { id: raw.id, label: str(raw.label, 'label', 60) };
    if (raw.vendor !== undefined) { if (typeof raw.vendor !== 'string' || !ID_RE.test(raw.vendor)) bad('vendor', 'vendor 必须是服务 id'); out.vendor = raw.vendor; }
    if (raw.legacyDriver !== undefined) out.legacyDriver = oneOf(raw.legacyDriver, 'legacyDriver', LEGACY_ACP_DRIVERS);
    out.bin = arr(raw.bin, 'bin', 4).map((b, i) => { if (typeof b !== 'string' || !/^[\w.-]{1,40}$/.test(b)) bad(`bin[${i}]`, '命令名不合法'); return b; });
    if (!out.bin.length) bad('bin', '至少要有一个命令名');
    out.args = arr(raw.args, 'args', 8).map((a, i) => { if (typeof a !== 'string' || !ARG_RE.test(a)) bad(`args[${i}]`, '参数不合法'); return a; });
    obj(raw.auth, 'auth');
    out.auth = { mode: oneOf(raw.auth.mode, 'auth.mode', ['own-login', 'env-key', 'none']), loginHint: str(raw.auth.loginHint, 'auth.loginHint', 400, { min: 0 }) };
    if (raw.auth.loginArgs !== undefined) out.auth.loginArgs = arr(raw.auth.loginArgs, 'auth.loginArgs', 6).map((a, i) => { if (typeof a !== 'string' || !ARG_RE.test(a)) bad(`auth.loginArgs[${i}]`, '参数不合法'); return a; });
    obj(raw.binding, 'binding');
    if (raw.binding.mode === 'none') out.binding = { mode: 'none' };
    else {
      oneOf(raw.binding.mode, 'binding.mode', ['env']);
      const p = envNameProblem(raw.binding.keyEnv); if (p) bad('binding.keyEnv', p);
      const env = {};
      obj(raw.binding.env ?? {}, 'binding.env');
      const names = Object.keys(raw.binding.env ?? {});
      if (names.length > 8) bad('binding.env', '环境变量最多 8 个');
      for (const n of names) { const pn = envNameProblem(n); if (pn) bad(`binding.env.${n.slice(0, 20)}`, pn); const pv = envValueProblem(raw.binding.env[n]); if (pv) bad(`binding.env.${n}`, pv); env[n] = raw.binding.env[n]; }
      out.binding = { mode: 'env', keyEnv: raw.binding.keyEnv, env };
      if (raw.binding.defaultModel !== undefined) { if (!net.checkModelId(raw.binding.defaultModel)) bad('binding.defaultModel', '默认模型名不合法'); out.binding.defaultModel = raw.binding.defaultModel; }
      if (raw.binding.optional !== undefined) out.binding.optional = bool(raw.binding.optional, 'binding.optional');
    }
    obj(raw.install, 'install');
    out.install = {};
    for (const k of ['npm', 'script', 'note']) { const v = optStr(raw.install[k], `install.${k}`, 400, { multiline: true }); if (v) out.install[k] = v; }
    obj(raw.perm, 'perm');
    out.perm = { level: oneOf(raw.perm.level, 'perm.level', ['verified', 'unverified']) };
    if (raw.perm.modeMap !== undefined) {
      obj(raw.perm.modeMap, 'perm.modeMap');
      out.perm.modeMap = {};
      for (const k of Object.keys(raw.perm.modeMap)) { oneOf(k, 'perm.modeMap', ['ask', 'acceptEdits', 'plan', 'auto', 'bypass']); out.perm.modeMap[k] = str(raw.perm.modeMap[k], `perm.modeMap.${k}`, 40); }
    }
    const rid = optStr(raw.registryId, 'registryId', 60); if (rid) out.registryId = rid;
    out.verified = date(raw.verified, 'verified');
    out.docsUrl = httpsUrl(raw.docsUrl, 'docsUrl');
    if (raw.unverified !== undefined) out.unverified = arr(raw.unverified, 'unverified', 12).map((u, i) => str(u, `unverified[${i}]`, 400));
    if (raw.hidden !== undefined) out.hidden = bool(raw.hidden, 'hidden');
    void ctx;
    return { ok: true, value: out };
  } catch (e) {
    if (e instanceof Bad) return { ok: false, error: e.message, field: e.field };
    throw e;
  }
}

module.exports = {
  validateService, validateAgent, envNameProblem, envValueProblem, ENV_NAME, ENV_DENY, ARG_RE,
  GROUPS, API_PROTOCOLS, SCHEMES, THINK_SOURCES, BUILTIN_DRIVERS, LEGACY_ACP_DRIVERS, MODELS_PARSERS, ID_RE, ENDPOINT_ID_RE,
};
