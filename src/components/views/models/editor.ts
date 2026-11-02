/* 添加 / 编辑自定义服务的表单逻辑（MODELS-SPEC §9、§14.5）：表单 ⇄ ServiceDef、页面一侧的校验与提示。
   纯函数，没有 React。**页面的校验只是体验**：主进程（svc:save → services-validate.cjs）会把整份定义重新校验一遍，
   密钥发往哪个主机、内网地址、套餐地址也由它判定并确认；这里只是让错误出现在对的输入框旁边，而不是点了保存才知道。 */
import type { Effort } from '../../../lib/effort';
import { PRESET_SERVICES, checkBaseUrl, gradeOf, isModelId, type EffortSpec, type Grade, type ModelDef, type ServiceDef } from '../../../lib/services';

/* ═══════════════════════════ the form ═══════════════════════════ */

export type EffortKind = 'none' | 're' | 're-think' | 'think-switch' | 'enable-thinking' | 'anthropic';
export const EFFORT_KINDS: Array<{ value: EffortKind; label: string; sub: string }> = [
  { value: 'none', label: '不调节', sub: '不发任何推理字段（默认，最稳妥）' },
  { value: 're', label: 'reasoning_effort', sub: '低 / 中 / 高…，可选「关闭思考」' },
  { value: 're-think', label: 'thinking.type + reasoning_effort', sub: '开关思考，并带档位' },
  { value: 'think-switch', label: '仅开关 thinking.type', sub: '只能开或关，没有档位' },
  { value: 'enable-thinking', label: 'enable_thinking', sub: '开关思考，可同时带 reasoning_effort' },
  { value: 'anthropic', label: 'output_config.effort', sub: 'Anthropic 协议的写法' },
];
export const LEVELS: Array<Exclude<Effort, 'off' | 'ultra'>> = ['low', 'medium', 'high', 'xhigh', 'max'];

export interface ModelRow {
  id: string;
  ctx: string;
  maxOut: string;
  effort: EffortKind;
  levels: Array<Exclude<Effort, 'off' | 'ultra'>>;
  canOff: boolean;
  /** enable-thinking only: also send reasoning_effort. */
  effortField: boolean;
}

export type Scheme = 'bearer' | 'x-api-key' | 'api-key' | 'header' | 'both' | 'none';
export const SCHEMES: Array<{ value: Scheme; label: string; sub?: string }> = [
  { value: 'bearer', label: 'Bearer', sub: 'Authorization: Bearer <密钥>（OpenAI 式）' },
  { value: 'x-api-key', label: 'x-api-key', sub: 'x-api-key: <密钥>（Anthropic 式）' },
  { value: 'api-key', label: 'api-key', sub: 'api-key: <密钥>（Azure 式）' },
  { value: 'header', label: '自定义头名…', sub: '你指定头的名字' },
  { value: 'both', label: '两种都发', sub: 'x-api-key 与 Authorization: Bearer 同时发（Anthropic 兼容端点说不清时用）' },
  { value: 'none', label: '无鉴权', sub: '只能用于本机地址' },
];

export interface EditorForm {
  name: string;
  protocol: 'openai-chat' | 'anthropic';
  baseUrl: string;
  compatUrl: string;
  scheme: Scheme;
  header: string;
  keyOptional: boolean;
  key: string;
  models: ModelRow[];
  maxTokensField: 'auto' | 'max_tokens' | 'max_completion_tokens';
  headers: Array<{ name: string; value: string }>;
  extraBody: string;
  thinkReasoningDetails: boolean;
  thinkContentParts: boolean;
}

export const emptyModelRow = (id = ''): ModelRow => ({ id, ctx: '', maxOut: '', effort: 'none', levels: [], canOff: false, effortField: false });

export function emptyForm(protocol: EditorForm['protocol'] = 'openai-chat'): EditorForm {
  return {
    name: '', protocol, baseUrl: '', compatUrl: '', scheme: protocol === 'anthropic' ? 'x-api-key' : 'bearer', header: '', keyOptional: false, key: '',
    models: [emptyModelRow()], maxTokensField: 'auto', headers: [], extraBody: '', thinkReasoningDetails: false, thinkContentParts: false,
  };
}

/* ═══════════════════════════ addresses ═══════════════════════════ */

const isLoopbackHost = (host: string) => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(host);

export interface UrlInfo {
  ok: boolean;
  host?: string;
  /** http on this machine. */
  local?: boolean;
  /** An https host inside a private network. */
  private?: boolean;
  /** 「Kimi 的「Kimi Code 套餐」」 when this is a vendor's plan address (never allowed as an API service). */
  planOwner?: string;
  /** Hints the main process also gives (but the person sees them while typing). */
  note?: string;
  error?: string;
}

const canon = (u: string) => { const r = checkBaseUrl(u); return r ? r.url.toLowerCase() : ''; };
let planIndex: Map<string, string> | undefined;
/** Addresses of the vendors' plan channels that no pay-as-you-go endpoint shares (MiniMax's 「M Plan」 is one that does). */
function planOwners(): Map<string, string> {
  if (planIndex) return planIndex;
  const shared = new Set<string>();
  for (const s of PRESET_SERVICES) for (const e of s.endpoints) if (e.kind !== 'plan' && e.baseUrl && !/\{/.test(e.baseUrl)) shared.add(canon(e.baseUrl));
  planIndex = new Map();
  for (const s of PRESET_SERVICES) for (const e of s.endpoints) {
    if (e.kind === 'plan' && e.baseUrl && !/\{/.test(e.baseUrl)) { const c = canon(e.baseUrl); if (c && !shared.has(c) && !planIndex.has(c)) planIndex.set(c, `${s.name} 的「${e.label}」`); }
  }
  return planIndex;
}

export function urlInfo(input: string): UrlInfo {
  const s = input.trim();
  if (!s) return { ok: false };
  const r = checkBaseUrl(s);
  if (!r) {
    if (/^http:\/\//i.test(s)) return { ok: false, error: '只允许 https；http 只有 127.0.0.1、localhost 或 [::1]（这台电脑）才行。局域网里的服务请前面加一层 https，或装在本机。' };
    if (/[?#]/.test(s)) return { ok: false, error: '地址里不能带 ? 或 #（参数请放在请求头或额外请求体里）。' };
    return { ok: false, error: '这不是一个可用的服务地址：要以 https:// 开头，例如 https://api.example.com/v1。' };
  }
  const local = /^http:/i.test(r.url) && isLoopbackHost(r.host);
  const owner = planOwners().get(r.url.toLowerCase());
  return { ok: true, host: r.host, local, private: r.private, planOwner: owner, note: r.private ? '这是内网地址：只放行 https 的内网主机，保存时会再问你一次。' : undefined };
}

/** The listing address and parser a new custom service should start with (MODELS-SPEC §9.3: `:11434` → ollama, the rest openai-style). */
export function recommendedModelsApi(form: Pick<EditorForm, 'protocol' | 'baseUrl'>): ServiceDef['modelsApi'] | undefined {
  const r = checkBaseUrl(form.baseUrl);
  if (!r) return undefined;
  if (form.protocol === 'anthropic') return { path: /\/v1$/.test(r.url) ? '/models' : '/v1/models', from: 'base', parser: 'anthropic', auth: 'optional' };
  if (/:11434$/.test(r.host)) return { path: '/api/tags', from: 'origin', parser: 'ollama', auth: 'none' };
  return { path: '/models', from: 'base', parser: 'openai', auth: 'optional', chatOnly: true };
}

/* ═══════════════════════════ validation ═══════════════════════════ */

export const FORBIDDEN_BODY_KEYS = ['model', 'messages', 'stream', 'stream_options', 'system', 'tools', 'tool_choice', 'functions', 'function_call', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'input', 'prompt', 'n'];
const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const HEADER_FORBIDDEN = /^(host|cookie|set-cookie|content-.*|proxy-.*|connection|transfer-encoding|upgrade|te|trailer|expect|origin|referer|user-agent|accept|accept-encoding|authorization|x-api-key|api-key|x-goog-api-key|anthropic-version)$/i;
const CTRL = /[\u0000-\u001f\u007f]/;
const INT_MAX = 2 ** 31 - 1;

export interface FormCheck {
  ok: boolean;
  /** field → message. Fields: name · baseUrl · compatUrl · auth · header · key · models · model-<i> · ctx-<i> · maxOut-<i> · headers · header-<i> · extraBody. */
  errors: Record<string, string>;
  /** Not blocking: the plan address, a private host, a key that will go to… */
  warnings: string[];
  url: UrlInfo;
  compat?: UrlInfo;
  /** Everything points at this machine. */
  local: boolean;
}

const intIn = (s: string, lo: number, hi: number) => /^\d{1,10}$/.test(s.trim()) && Number(s) >= lo && Number(s) <= hi;

export function validateForm(form: EditorForm): FormCheck {
  const errors: Record<string, string> = {};
  const warnings: string[] = [];
  const name = form.name.trim();
  if (!name) errors.name = '请给它起个名字（1–40 个字）';
  else if (name.length > 40 || CTRL.test(name)) errors.name = '名称最长 40 个字，不能有换行等控制字符';

  const url = urlInfo(form.baseUrl);
  if (!form.baseUrl.trim()) errors.baseUrl = '请填服务地址';
  else if (!url.ok) errors.baseUrl = url.error ?? '地址不可用';
  else if (url.planOwner) errors.baseUrl = `这是 ${url.planOwner} 的套餐地址：套餐 Key 只能给命令行工具用，不能存成 API 服务。`;
  else if (url.note) warnings.push(url.note);

  let compat: UrlInfo | undefined;
  if (form.compatUrl.trim()) {
    compat = urlInfo(form.compatUrl);
    if (form.protocol === 'anthropic') errors.compatUrl = 'Anthropic 协议的服务本身就是 Anthropic 兼容地址，不用再填';
    else if (!compat.ok) errors.compatUrl = compat.error ?? '地址不可用';
    else if (compat.planOwner) errors.compatUrl = `这是 ${compat.planOwner} 的套餐地址：套餐 Key 只能给命令行工具用。`;
    else if (compat.note) warnings.push(compat.note);
  }
  const local = url.ok && !!url.local && (!compat || !compat.ok || !!compat.local);

  if (form.scheme === 'header') {
    const h = form.header.trim();
    if (!HEADER_NAME.test(h)) errors.header = '头名只能是字母、数字和连字符，字母开头，最长 40 个字符';
    else if (HEADER_FORBIDDEN.test(h)) errors.header = `「${h}」不能当鉴权头用（它由别的设置决定，或是不允许自定义的头）`;
  }
  if (form.scheme === 'none' && !local) errors.auth = '「无鉴权」只能用于本机地址（127.0.0.1、localhost）';
  if (form.keyOptional && !local) errors.auth = '「不需要密钥」只能用于本机地址（127.0.0.1、localhost）';

  // models
  const rows = form.models.filter((m) => m.id.trim() || m.ctx.trim() || m.maxOut.trim());
  if (!rows.length) errors.models = '至少填一个模型 ID（不知道有哪些的话，保存后在卡片里「刷新」拉取列表）';
  const seen = new Set<string>();
  form.models.forEach((m, i) => {
    const id = m.id.trim();
    if (!id && !m.ctx.trim() && !m.maxOut.trim()) return;
    if (!id) errors[`model-${i}`] = '模型 ID 不能为空';
    else if (!isModelId(id)) errors[`model-${i}`] = '模型 ID 里有不支持的字符（只能用字母、数字和 . _ - : / @ ~ [ ]，最长 100 位）';
    else if (seen.has(id)) errors[`model-${i}`] = `「${id}」重复了`;
    seen.add(id);
    if (m.ctx.trim() && !intIn(m.ctx, 1024, INT_MAX)) errors[`ctx-${i}`] = '上下文窗口填 token 数，至少 1024';
    if (m.maxOut.trim() && !intIn(m.maxOut, 1, INT_MAX)) errors[`maxOut-${i}`] = '最大输出填 token 数';
    if ((m.effort === 're' || m.effort === 're-think' || m.effort === 'anthropic') && !m.levels.length && !m.canOff) errors[`model-${i}`] = errors[`model-${i}`] ?? '这种推理写法要至少勾一个档位（或「支持关闭」）';
  });
  if (form.models.length > 500) errors.models = '最多 500 个模型';

  // headers
  const names = new Set<string>();
  form.headers.forEach((h, i) => {
    const n = h.name.trim();
    if (!n && !h.value.trim()) return;
    if (!HEADER_NAME.test(n) || HEADER_FORBIDDEN.test(n)) errors[`header-${i}`] = `请求头「${n.slice(0, 30)}」的名字不合法，或是不允许自定义的头`;
    else if (names.has(n.toLowerCase())) errors[`header-${i}`] = `「${n}」重复了`;
    else if (!/^[ -~]{0,256}$/.test(h.value)) errors[`header-${i}`] = '值只能是不超过 256 个可打印 ASCII 字符';
    names.add(n.toLowerCase());
  });
  if (form.headers.filter((h) => h.name.trim()).length > 8) errors.headers = '额外请求头最多 8 项';

  // extra body
  const extra = parseExtraBody(form.extraBody);
  if (!extra.ok) errors.extraBody = extra.error;

  return { ok: Object.keys(errors).length === 0, errors, warnings, url, compat, local };
}

export function parseExtraBody(text: string): { ok: true; value: Record<string, unknown> | undefined } | { ok: false; error: string } {
  const t = text.trim();
  if (!t) return { ok: true, value: undefined };
  if (t.length > 4096) return { ok: false, error: '额外请求体最长 4 KB' };
  let v: unknown;
  try { v = JSON.parse(t); } catch { return { ok: false, error: '这不是合法的 JSON' }; }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: '额外请求体必须是一个 JSON 对象，例如 {"reasoning_format":"parsed"}' };
  for (const k of Object.keys(v as object)) {
    if (FORBIDDEN_BODY_KEYS.includes(k)) return { ok: false, error: `不能覆盖「${k}」：它由栖枝按这次请求决定` };
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,40}$/.test(k) || k === '__proto__') return { ok: false, error: `字段名「${k.slice(0, 30)}」不合法` };
  }
  return { ok: true, value: Object.keys(v as object).length ? (v as Record<string, unknown>) : undefined };
}

/** Which input a field name from the main process's refusal belongs to (`endpoints[0].baseUrl`, `models[2].id`…). */
export function formFieldOf(field: string | undefined): string {
  if (!field) return '_form';
  if (field === 'name') return 'name';
  if (/^endpoints.*compatUrl/.test(field) || field === 'drivers') return 'compatUrl';
  if (/^endpoints/.test(field)) return 'baseUrl';
  const m = /^models\[(\d+)\]\.(id|ctx|maxOut)/.exec(field);
  if (m) return m[2] === 'id' ? `model-${m[1]}` : `${m[2]}-${m[1]}`;
  if (field === 'models' || field === 'defaultModel') return 'models';
  if (field === 'auth.header') return 'header';
  if (/^auth/.test(field)) return 'auth';
  if (/^headers\./.test(field) || field === 'headers') return 'headers';
  if (field === 'extraBody') return 'extraBody';
  return '_form';
}

/* ═══════════════════════════ form ⇄ definition ═══════════════════════════ */

function specOf(m: ModelRow, protocol: EditorForm['protocol']): EffortSpec | undefined {
  if (m.effort === 'none') return undefined;
  const levels: Effort[] = [...(m.canOff ? (['off'] as Effort[]) : []), ...LEVELS.filter((l) => m.levels.includes(l))];
  switch (m.effort) {
    case 're': return { style: 're', levels, ...(m.canOff ? { offWire: 'none' as const } : {}) };
    case 're-think': return { style: 're-think', levels };
    case 'think-switch': return { style: 'think-switch', levels: ['off'] };
    case 'enable-thinking': return { style: 'enable-thinking', levels, effortField: m.effortField };
    case 'anthropic': return protocol === 'anthropic' ? { style: 'anthropic', levels, ...(m.canOff ? { offWire: 'disabled' as const } : {}) } : undefined;
    default: return undefined;
  }
}

const rowOf = (def: ServiceDef, m: ModelDef): ModelRow => {
  const spec = typeof m.effort === 'string' ? def.effortProfiles?.[m.effort] : m.effort;
  const kind = (spec && (spec.style === 'minimax' || spec.style === 'openrouter') ? 'none' : spec?.style) as EffortKind | undefined;
  return {
    id: m.id, ctx: m.ctx ? String(m.ctx) : '', maxOut: m.maxOut ? String(m.maxOut) : '',
    effort: kind && EFFORT_KINDS.some((k) => k.value === kind) ? kind : 'none',
    levels: spec ? LEVELS.filter((l) => spec.levels.includes(l)) : [], canOff: !!spec && spec.levels.includes('off') && spec.style !== 'think-switch', effortField: !!spec?.effortField,
  };
};

export function defToForm(def: ServiceDef): EditorForm {
  const ep = def.endpoints[0];
  return {
    name: def.name, protocol: def.protocol === 'anthropic' ? 'anthropic' : 'openai-chat', baseUrl: ep?.baseUrl ?? '', compatUrl: ep?.compatUrl ?? '',
    scheme: def.auth.scheme, header: def.auth.header ?? '', keyOptional: !!def.auth.keyOptional, key: '',
    models: def.models.length ? def.models.map((m) => rowOf(def, m)) : [emptyModelRow()],
    maxTokensField: def.wire?.maxTokensField ?? 'auto',
    headers: Object.entries(def.headers ?? {}).map(([name, value]) => ({ name, value })),
    extraBody: def.extraBody ? JSON.stringify(def.extraBody, null, 2) : '',
    thinkReasoningDetails: !!def.wire?.thinkIn?.includes('reasoning_details'), thinkContentParts: !!def.wire?.contentParts,
  };
}

/**
 * The definition to send to svc:save. When editing, everything the form does not manage (more endpoints, a listing address, reasoning
 * profiles, labels and notes of models…) is kept from the existing definition.
 */
export function formToDef(form: EditorForm, editing?: ServiceDef): Partial<ServiceDef> & { id?: string } {
  const url = urlInfo(form.baseUrl);
  const compatUrl = form.compatUrl.trim();
  const local = !!url.local && (!compatUrl || !!urlInfo(compatUrl).local);
  const base = editing ? { ...editing } : {};
  const prevEp = editing?.endpoints[0];
  const ep: ServiceDef['endpoints'][number] = {
    ...(prevEp ?? {}), id: prevEp?.id ?? 'main', label: prevEp?.label ?? (local ? '本机' : '服务地址'), kind: local ? 'local' : 'payg', baseUrl: form.baseUrl.trim(),
  };
  // a vendor's Anthropic-compatible address a person typed in: Claude Code can use it, but nobody has vouched for it — 「实验」
  if (form.protocol === 'openai-chat' && compatUrl) { ep.compatUrl = compatUrl; ep.compat = { ...(prevEp?.compat ?? {}), experimental: true }; } else { delete ep.compatUrl; delete ep.compat; }
  const prevModels = new Map((editing?.models ?? []).map((m) => [m.id, m]));
  const models: ModelDef[] = form.models.filter((m) => m.id.trim()).map((m) => {
    const prev = prevModels.get(m.id.trim());
    const out: ModelDef = { ...(prev ?? {}), id: m.id.trim() };
    delete out.effort; delete out.ctx; delete out.maxOut; delete out.source;
    if (m.ctx.trim()) out.ctx = Number(m.ctx);
    if (m.maxOut.trim()) out.maxOut = Number(m.maxOut);
    const spec = specOf(m, form.protocol);
    if (spec) out.effort = spec;
    return out;
  });
  const thinkIn = ['reasoning_content', 'reasoning', 'think-tag', ...(form.thinkReasoningDetails ? ['reasoning_details'] : [])] as NonNullable<ServiceDef['wire']>['thinkIn'];
  const wire: NonNullable<ServiceDef['wire']> = {
    ...(editing?.wire ?? {}),
    maxTokensField: form.maxTokensField, defaultMaxOut: editing?.wire?.defaultMaxOut ?? (local ? 8192 : 16000), testMaxTokens: editing?.wire?.testMaxTokens ?? (local ? 1024 : 512),
  };
  if (form.thinkReasoningDetails) wire.thinkIn = thinkIn; else if (wire.thinkIn?.includes('reasoning_details')) delete wire.thinkIn;
  if (form.thinkContentParts) wire.contentParts = true; else delete wire.contentParts;
  const auth: ServiceDef['auth'] = { scheme: form.scheme, ...(form.scheme === 'header' ? { header: form.header.trim() } : {}), ...(form.keyOptional || form.scheme === 'none' ? { keyOptional: true } : {}) };
  const headers: Record<string, string> = {};
  for (const h of form.headers) if (h.name.trim()) headers[h.name.trim()] = h.value;
  const extra = parseExtraBody(form.extraBody);
  const drivers = (editing?.drivers ?? []).filter((d) => d !== 'claude-compat');
  const def: Partial<ServiceDef> & { id?: string } = {
    ...base,
    name: form.name.trim(), protocol: form.protocol, endpoints: [ep, ...(editing?.endpoints.slice(1) ?? [])], auth, wire, models,
    defaultCtx: editing?.defaultCtx ?? (local ? 8192 : 128000),
    drivers: ep.compatUrl ? ['claude-compat', ...drivers] : drivers,
  };
  if (Object.keys(headers).length) def.headers = headers; else delete def.headers;
  if (extra.ok && extra.value) def.extraBody = extra.value; else delete def.extraBody;
  if (!editing) { const api = recommendedModelsApi(form); if (api) def.modelsApi = api; }
  // a model that was the default and is gone from the list
  if (def.defaultModel && !models.some((m) => m.id === def.defaultModel)) delete def.defaultModel;
  return def;
}

/** The capability marks the dialog previews (聊天 / 强度 / 干活): derived from the form like everywhere else, never typed in. */
export function previewGrade(form: EditorForm): Grade {
  const def = formToDef(form) as ServiceDef;
  const first = def.models?.[0];
  const levels = first?.effort && typeof first.effort === 'object' ? first.effort.levels : [];
  const check = validateForm(form);
  const g = gradeOf({ ...def, id: 'x_preview', kind: 'custom', models: def.models ?? [], endpoints: def.endpoints ?? [], drivers: def.drivers ?? [], protocol: def.protocol ?? 'openai-chat', auth: def.auth ?? { scheme: 'bearer' } } as ServiceDef,
    { keySaved: true, model: first?.id, levels: levels as Effort[] });
  if (!check.url.ok) g.chat = false;
  return g;
}
