/* 模型服务注册表（页面这一份）: the types the page and the main process share for model services (MODELS-SPEC §4), the presets the app
   ships (electron/ai/catalog/*.json, imported here for names, models and reasoning levels), the custom services the main process hands
   over (svc:list), and a few pure helpers: the compatibility grade, the address check for forms, which key hint belongs to which region.

   The MAIN PROCESS is the authority (electron/ai/services.cjs): the page sends ids (service, endpoint, params, model, effort); the address,
   headers, body fields and environment are produced there. Nothing in this file is ever sent as a request. */
import intlJson from '../../electron/ai/catalog/intl.json';
import cnJson from '../../electron/ai/catalog/cn.json';
import hubJson from '../../electron/ai/catalog/hub.json';
import localJson from '../../electron/ai/catalog/local.json';
import agentsJson from '../../electron/ai/catalog/acp-agents.json';
import driversJson from '../../electron/ai/catalog/drivers.json';
import type { Effort } from './effort';
import type { PermissionMode } from './types';

/* ═══════════════════════════ types ═══════════════════════════ */

/** Presets keep the first-release ids (claude…doubao); custom services start with `x_`. /^[a-z][a-z0-9_-]{0,31}$/ */
export type ServiceId = string;
/** /^[a-z][a-z0-9-]{0,15}$/ */
export type EndpointId = string;
/** `kimi` / `qwen` / `mcode` are permanent aliases of `acp:kimi` etc. (tasks saved before keep their `engine.driver`). */
export type DriverId = 'claude-code' | 'codex' | 'dsh' | 'claude-compat' | 'kimi' | 'qwen' | 'mcode' | `acp:${string}`;
/** openai-responses / gemini / converse are reserved names: the main process refuses to save them. */
export type ProtocolId = 'openai-chat' | 'anthropic' | 'openai-responses' | 'gemini' | 'converse' | 'none';
export type ServiceKind = 'preset' | 'custom' | 'agent';
/** The groups of the 模型接入 page. 'cli' is for command-line agents only. */
export type ServiceGroup = 'intl' | 'cn' | 'hub' | 'local' | 'cli';
/** payg: pay as you go · plan: a subscription channel (command-line tools only, never the API way) · local: this machine. */
export type EndpointKind = 'payg' | 'plan' | 'local';

/** A {placeholder} in an address. `pattern` must not accept . / @ : (the main process checks four probe strings). */
export interface PlaceholderDef { name: string; label: string; pattern: string; example?: string }

export interface AuthDef {
  /** both = x-api-key and Authorization: Bearer together. */
  scheme: 'bearer' | 'x-api-key' | 'api-key' | 'header' | 'both' | 'none';
  header?: string;
  /** The service can be used without a key (a local server). A saved key is still sent. */
  keyOptional?: boolean;
  keyPrefixHint?: string;
  keyMin?: number;
}

export type ThinkSource = 'reasoning_content' | 'reasoning' | 'reasoning_details' | 'think-tag' | 'content-parts';

export interface WireDef {
  chatPath?: string;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens' | 'auto';
  streamUsage?: 'include_usage' | 'none';
  thinkIn?: ThinkSource[];
  contentParts?: boolean;
  dropFields?: string[];
  anthropicVersion?: string;
  defaultThinking?: { type: 'adaptive'; display: 'summarized' | 'omitted' };
  defaultMaxOut?: number;
  testMaxTokens?: number;
}

export interface CompatDef { autoCompactWindow?: number; experimental?: boolean; note?: string }

export interface EndpointDef {
  id: EndpointId;
  label: string;
  kind: EndpointKind;
  /** openai-chat protocol root (…/v1) or the Anthropic protocol root. May hold {placeholders}. */
  baseUrl?: string;
  /** The vendor's own Anthropic-compatible root (no /v1): what the claude-compat driver talks to. */
  compatUrl?: string;
  responsesUrl?: string;
  params?: PlaceholderDef[];
  /** This endpoint keeps its own key in the slot `${serviceId}:${endpointId}`. */
  separateKey?: boolean;
  /** Models of this channel only (a plan opens just some). */
  models?: ModelDef[];
  compat?: CompatDef;
  auth?: AuthDef;
  wire?: WireDef;
  note?: string;
}

export type EffortStyle = 'anthropic' | 're' | 're-think' | 'think-switch' | 'enable-thinking' | 'minimax' | 'openrouter' | 'none';

export interface EffortSpec {
  style: EffortStyle;
  /** Levels the UI offers; 'off' = thinking can be switched off. [] = this model cannot be tuned. */
  levels: Effort[];
  /** The model's own default: a level, or 'on' (thinking is on and has no levels). Only for the menu text. */
  default?: Effort | 'on';
  offWire?: 'none' | 'disabled' | 'between_tools';
  effortField?: boolean;
  note?: string;
}
export interface EffortRule { match: string; flags?: string; effort: string }

export interface ModelDef {
  id: string;
  label?: string;
  note?: string;
  ctx?: number;
  maxOut?: number;
  effort?: string | EffortSpec;
  caps?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  status?: 'active' | 'preview' | 'retiring' | 'deprecated' | 'retired';
  retiresAt?: string;
  /** Runtime only (never in a preset file). */
  source?: 'preset' | 'live' | 'user';
  /** Runtime only: a preset model that this account's live list does not contain (not "retired": lists are per account). */
  unlisted?: boolean;
}

export type ModelsParser = 'openai' | 'anthropic' | 'deepseek' | 'kimi' | 'mistral' | 'openrouter' | 'vercel' | 'ollama' | 'lmstudio' | 'gemini';
export interface ModelsApiDef {
  path: string;
  from?: 'base' | 'origin';
  parser: ModelsParser;
  auth: 'required' | 'optional' | 'none';
  authOverride?: AuthDef;
  query?: Record<string, string>;
  chatOnly?: boolean;
  onlyEndpoints?: EndpointId[];
  detail?: { path: string; method: 'GET' | 'POST' };
  ttlMs?: number;
}

export interface ServiceDef {
  id: ServiceId;
  kind: ServiceKind;
  name: string;
  vendor: string;
  /** 1–2 characters. */
  glyph: string;
  group: ServiceGroup;
  aliases?: string[];
  protocol: ProtocolId;
  endpoints: EndpointDef[];
  auth: AuthDef;
  headers?: Record<string, string>;
  wire?: WireDef;
  /** Custom services only: extra request-body fields (≤ 4 KB, checked by the main process). */
  extraBody?: Record<string, unknown>;
  models: ModelDef[];
  defaultModel?: string;
  modelHint?: string;
  effortProfiles?: Record<string, EffortSpec>;
  effortRules?: EffortRule[];
  effortDefault?: string;
  /** Model suggestions per command-line driver: '*' = every model, a string = a model of this service, an object = inline ('' = the tool's own default). */
  cliModels?: Partial<Record<DriverId, Array<string | ModelDef>>>;
  modelsApi?: ModelsApiDef;
  /** The first one is the default driver. claude-compat also needs an endpoint with a compatUrl. */
  drivers: DriverId[];
  /** Window assumed for a model the catalog does not know: 1M for the first-release eight, 128K for custom services, small for local ones. */
  defaultCtx?: number;
  keyUrl?: string;
  keyHelp: string;
  docsUrl?: string;
  flags?: { claudeAuthPath?: boolean; ctxWarnBelow?: number; probePort?: number };
  /** Last date the preset was checked against the vendor's docs (YYYY-MM-DD). */
  verified: string;
  /** What is still unchecked, in plain words. */
  unverified?: string[];
  hidden?: boolean;
}

/** A command-line agent that speaks ACP. */
export interface AcpAgentDef {
  id: string;
  label: string;
  /** Bound to a service: shown as that service card's 「命令行」 way. Without it: a stand-alone agent. */
  vendor?: ServiceId;
  legacyDriver?: 'kimi' | 'qwen' | 'mcode';
  bin: string[];
  args: string[];
  auth: { mode: 'own-login' | 'env-key' | 'none'; loginArgs?: string[]; loginHint: string };
  binding:
    | { mode: 'none' }
    | { mode: 'env'; keyEnv: string; env: Record<string, string>; defaultModel?: string; optional?: boolean };
  install: { npm?: string; script?: string; note?: string };
  perm: { level: 'verified' | 'unverified'; modeMap?: Partial<Record<PermissionMode, string>> };
  registryId?: string;
  verified: string;
  docsUrl: string;
  unverified?: string[];
  hidden?: boolean;
  source?: 'preset' | 'registry' | 'custom';
}

/** The built-in drivers (catalog/drivers.json). */
export interface DriverDef {
  id: string; label: string; bin: string; install: string; auth: 'account' | 'key'; approvals: 'per-call' | 'sandbox'; note: string; homepage: string;
  loginArgs: string[] | null; loginHint: string;
}

/* ───────────── userData/services.json, as the page sees it (svc:list) ───────────── */

export interface UserServicesList {
  custom: ServiceDef[];
  /** Agents the user registered (the main process strips executable paths). */
  agents: Array<Partial<AcpAgentDef> & { id: string }>;
  /** A preset's address the user changed. */
  overrides: Record<ServiceId, { endpoint: EndpointId; baseUrl: string; confirmedHost: string }>;
  pinned: Record<ServiceId, string[]>;
  /** Which region the old single-slot key of a service belongs to (see MODELS-SPEC §11.3). */
  keyBindings: Record<ServiceId, EndpointId>;
}

/* ───────────── page ↔ main process ───────────── */

export interface SvcOk<T> { ok: true; value: T }
export interface SvcError { ok: false; error: string; field?: string }
export type SvcResult<T> = SvcOk<T> | SvcError;

export interface ModelsListResult {
  /** false = the list could not be fetched (`error`); `models` is then the cache or the presets. */
  ok: boolean;
  /** live: just fetched · cache: an earlier fetch · static: the presets only. */
  source: 'live' | 'cache' | 'static';
  at: number;
  models: ModelDef[];
  error?: string;
  /** A short stable reason: AUTH · AUTH_SCOPE · QUOTA · SERVER · SHAPE (not a model list) · NO_KEY (save a key first) · NO_LIST (the service has no list) · PLAN_KEY · ADDRESS · UNKNOWN · ENDPOINT · or a network code. */
  code?: string;
  /** The cache has expired (a refresh is running or failed). */
  stale?: boolean;
  /** The service sent more than 1000 models; the first 1000 are here. */
  truncated?: boolean;
}

export interface ProbeFound { service: ServiceId; endpoint: EndpointId; port: number; models: string[] }

/** What `window.alightDesktop.services` offers. All of it goes through the sender-checked handlers in the main process. */
export interface ServicesBridge {
  list(): Promise<UserServicesList>;
  /** Create or update a custom service. The main process validates EVERYTHING again; a new host for a saved key asks the user in a native dialog. */
  save(def: Partial<ServiceDef> & { id?: ServiceId }): Promise<SvcResult<ServiceDef>>;
  /** Delete a custom service with its keys, pinned models and cached lists. (The page counts the tasks that use it; the main process does not know them.) */
  remove(id: ServiceId): Promise<SvcResult<{ clearedSlots: number }>>;
  /** Change the address of a preset's endpoint (null = back to the default). Another host for a saved key asks the user natively. */
  setOverride(id: ServiceId, endpoint: EndpointId, baseUrl: string | null): Promise<SvcResult<null>>;
  pin(id: ServiceId, model: string, on: boolean): Promise<SvcResult<string[]>>;
  /** One-time carry-over of settings from the first-release page state (regions of old single-slot keys, typed addresses). Idempotent. */
  migrate(req: { regions: Record<ServiceId, EndpointId>; baseUrls: Record<ServiceId, string> }): Promise<SvcResult<{ bound: ServiceId[]; applied: ServiceId[]; rejected: Array<{ id: ServiceId; reason: string }> }>>;
  /** `cacheOnly`: answer from the cache (or the presets) without any request; `fresh`: skip the cache. Never throws. */
  models(req: { service: ServiceId; endpoint?: EndpointId; params?: Record<string, string>; fresh?: boolean; cacheOnly?: boolean }): Promise<ModelsListResult>;
  modelDetail(req: { service: ServiceId; endpoint?: EndpointId; params?: Record<string, string>; model: string }): Promise<SvcResult<ModelDef>>;
  probeLocal(): Promise<ProbeFound[]>;
}

export interface AcpProbeResult {
  ok: boolean;
  agentInfo?: { name: string; version: string };
  protocolVersion?: number;
  authMethods: Array<{ id: string; type: 'agent' | 'terminal' | 'other' }>;
  caps: { loadSession: boolean; resume: boolean; list: boolean; close: boolean; configOptions: boolean; mcpHttp: boolean; image: boolean };
  error?: string;
  at?: number;
  deep?: boolean;
  cached?: boolean;
  notFound?: boolean;
  notProbed?: boolean;
  timedOut?: boolean;
  needsLogin?: boolean;
  /** Only after 「读取模型与模式」: what the agent offers in a session. */
  summary?: {
    models: Array<{ id: string; label: string; note: string }>; currentModel: string;
    efforts: Array<{ id: string; label: string; level: string | null }>; currentEffort: string;
    modes: Array<{ id: string; label: string; note: string }>; currentMode: string;
  };
}
/** One row of acp:registry (the official agent registry). */
export interface RegistryRow {
  id: string; name: string; version: string; description: string; license: string; repository: string;
  dist: 'npx' | 'uvx' | 'binary'; hasSha256: boolean;
  /** The command exactly as it would run ('' for a binary entry). */
  command: string;
  addable: boolean; reason: string;
  /** The preset agent that already covers this entry ('' = none). */
  preset: string;
  installed: boolean; installedVersion: string; updateAvailable: boolean;
  /** Binary entries: where to download, and the checksum when the registry gives one. */
  downloads: Array<{ platform: string; url: string; sha256: string }>;
}
/** The command-line agent channels (electron/ai/acp-agents.cjs registers the handlers). */
export interface AcpBridge {
  probe(req: { agent: string; deep?: boolean; fresh?: boolean; cacheOnly?: boolean }): Promise<AcpProbeResult>;
  registry(req: { fresh?: boolean }): Promise<{ ok: true; value: RegistryRow[]; at?: number; stale?: boolean; error?: string } | SvcError>;
  addFromRegistry(req: { id: string }): Promise<SvcResult<{ id: string; install: string }>>;
  pickExe(): Promise<SvcResult<{ token: string; name: string }>>;
  addCustom(req: { token: string; label: string; args: string[]; envNames: string[] }): Promise<SvcResult<{ id: string }>>;
  remove(id: string): Promise<SvcResult<null>>;
}

/** The test of a connection, step by step (models → chat). */
export interface TestStep { name: 'models' | 'chat' | 'cli'; ok: boolean; ms: number; detail: string }

/** Per-provider settings the page keeps, v2 (see ProviderConfig in types.ts; this is the shape the migration targets). */
export interface CustomMirror { id: ServiceId; name: string; glyph: string; group: ServiceGroup }

/* ═══════════════════════════ presets ═══════════════════════════ */

/** The first-release eight keep their place at the head of every list. */
const LEGACY_ORDER = ['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'doubao'];

const rawPresets = [...(intlJson as unknown as ServiceDef[]), ...(cnJson as unknown as ServiceDef[]), ...(hubJson as unknown as ServiceDef[]), ...(localJson as unknown as ServiceDef[])];
/** All presets (hidden ones included) in display order: the first-release eight, then catalog order. */
export const PRESET_SERVICES: ServiceDef[] = [
  ...LEGACY_ORDER.map((id) => rawPresets.find((s) => s.id === id)).filter((s): s is ServiceDef => !!s),
  ...rawPresets.filter((s) => !LEGACY_ORDER.includes(s.id)),
];
export const AGENT_DEFS = agentsJson as unknown as AcpAgentDef[];
export const DRIVER_DEFS = driversJson as unknown as DriverDef[];

const presetById = new Map(PRESET_SERVICES.map((s) => [s.id, s]));
export const isPresetId = (id: string) => presetById.has(id);

/* ═══════════════════════════ the runtime registry (custom services) ═══════════════════════════ */

let customList: ServiceDef[] = [];
let mirrorList: CustomMirror[] = [];
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version += 1; listeners.forEach((l) => l()); };

/** A stand-in built from the persisted minimum (name, glyph, group) until the main process answers: shows the name, cannot run. */
function stubOf(m: CustomMirror): ServiceDef {
  return {
    id: m.id, kind: 'custom', name: m.name, vendor: '自定义', glyph: m.glyph, group: m.group, protocol: 'openai-chat', endpoints: [], auth: { scheme: 'bearer' },
    models: [], drivers: [], keyHelp: '自定义服务', verified: '1970-01-01',
  };
}

/** The custom services the main process holds (svc:list). Replaces the whole list; subscribers (providers.ts) rebuild. */
export function setCustomServices(list: ServiceDef[]) {
  customList = list.filter((s) => s && typeof s.id === 'string' && !presetById.has(s.id));
  // the mirror is what the page remembers of the user's own services; the stand-alone command-line agents are derived, not remembered
  mirrorList = customList.filter((s) => s.kind !== 'agent').map((s) => ({ id: s.id, name: s.name, glyph: s.glyph, group: s.group }));
  bump();
}
/** Before the main process has answered: show the services this page knew last time (name, glyph, group). */
export function setCustomMirror(mirror: CustomMirror[]) {
  if (customList.length) return;
  mirrorList = mirror.filter((m) => m && typeof m.id === 'string' && /^x_[a-z0-9_-]{0,30}$/.test(m.id) && !presetById.has(m.id)).slice(0, 64);
  bump();
}
export const customMirror = (): CustomMirror[] => mirrorList.slice();
export const customServices = (): ServiceDef[] => customList.slice();
export const servicesVersion = () => version;
export function subscribeServices(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }

/** Presets (hidden ones only when asked) followed by the custom services. */
export function allServices(opts: { hidden?: boolean } = {}): ServiceDef[] {
  const stubs = mirrorList.filter((m) => !customList.some((s) => s.id === m.id)).map(stubOf);
  return [...PRESET_SERVICES.filter((s) => opts.hidden || !s.hidden), ...customList, ...stubs];
}
export function maybeService(id: string): ServiceDef | undefined {
  return presetById.get(id) ?? customList.find((s) => s.id === id) ?? (() => { const m = mirrorList.find((x) => x.id === id); return m ? stubOf(m) : undefined; })();
}
/** The service with this id; for one that no longer exists (a deleted custom service a task still points at) a placeholder named 「（已删除）」. */
export function serviceOf(id: string): ServiceDef {
  return maybeService(id) ?? { ...stubOf({ id, name: '（已删除）', glyph: '·', group: 'hub' }), vendor: '（已删除）' };
}
export const isDeletedService = (id: string) => !maybeService(id);

/* ═══════════════════════════ pure helpers ═══════════════════════════ */

const isHttpLoopback = (u: URL) => u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n <= 255) ? p : null;
}
function mapped(host: string): number[] | null {
  const m = /^\[::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})\]$/i.exec(host);
  if (!m) return null;
  const hi = parseInt(m[1], 16);
  const lo = parseInt(m[2], 16);
  return [hi >> 8, hi & 255, lo >> 8, lo & 255];
}
function isMetadata(host: string) {
  const h = host.replace(/\.$/, '');
  if (h === 'metadata.google.internal' || h === 'metadata.goog' || h === '[fd00:ec2::254]') return true;
  const v4 = ipv4(h) ?? mapped(h);
  return !!v4 && ((v4[0] === 169 && v4[1] === 254) || (v4[0] === 100 && v4[1] === 100 && v4[2] === 100 && v4[3] === 200));
}
function isPrivate(host: string) {
  const h = host.replace(/\.$/, '');
  if (h === 'localhost' || /\.(localhost|local|internal|lan)$/.test(h) || h.endsWith('.home.arpa')) return true;
  const v4 = ipv4(h) ?? mapped(h);
  if (v4) { const [a, b] = v4; return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127); }
  if (h.startsWith('[')) { const inner = h.slice(1, -1).toLowerCase(); return inner === '::1' || /^f[cd][0-9a-f]{2}:/.test(inner) || /^fe[89ab][0-9a-f]:/.test(inner); }
  return false;
}

/**
 * The same rule the main process applies (electron/ai/net.cjs), for form hints only — the main process decides.
 * https, or http on 127.0.0.1 / localhost / [::1]; no credentials, query or fragment; never a cloud metadata address.
 */
export function checkBaseUrl(input: string): { url: string; private: boolean; host: string } | null {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (!s || s.length > 512 || /[?#]/.test(s) || /[\u0000- \u007f\\]/.test(s)) return null;
  let u: URL;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol === 'http:') { if (!isHttpLoopback(u)) return null; } else if (u.protocol !== 'https:') return null;
  if (u.username || u.password || u.hash || u.search || !u.hostname || isMetadata(u.hostname)) return null;
  if (u.port !== '') { const n = Number(u.port); if (!(n >= 1 && n <= 65535)) return null; }
  return { url: u.toString().replace(/\/+$/, ''), private: u.protocol === 'https:' && isPrivate(u.hostname), host: u.host };
}

/** A model id as every path (API, command line, lists) accepts it. */
export const MODEL_ID_RE = /^[\w.\-:/@~[\]]{1,100}$/;
export const isModelId = (id: unknown): id is string => typeof id === 'string' && MODEL_ID_RE.test(id);

/** The slot a key is stored under (the main process computes the same). */
export const slotFor = (service: Pick<ServiceDef, 'id'>, ep: Pick<EndpointDef, 'id' | 'separateKey'> | undefined) => (ep && ep.separateKey ? `${service.id}:${ep.id}` : service.id);

/** '••••abcd' for the key a (service, endpoint) would use: its own slot, else — for the region the old single key belonged to — the old slot. */
export function keyHintFor(service: ServiceDef, endpointId: string, hints: Record<string, string>, bindings: Record<string, string>): string | undefined {
  const ep = service.endpoints.find((e) => e.id === endpointId);
  const primary = slotFor(service, ep);
  // an endpoint that shares the old single slot (GLM / Doubao pay-as-you-go) shows nothing while the old key is bound to another region
  const bound = bindings[service.id];
  const legacy = primary !== service.id ? bound === endpointId : !bound || bound === endpointId;
  if (primary === service.id && !legacy) return undefined;
  if (hints[primary]) return hints[primary];
  if (primary !== service.id && legacy) return hints[service.id];
  return undefined;
}

/** The first endpoint the API way can use (not a plan), else the first with an address, else the first. */
export function defaultEndpointOf(s: ServiceDef): EndpointDef | undefined {
  return s.endpoints.find((e) => e.baseUrl && e.kind !== 'plan') ?? s.endpoints.find((e) => e.baseUrl) ?? s.endpoints[0];
}

/* ───────────── compatibility grade (MODELS-SPEC §1.3), derived from the data, never typed in ───────────── */

export interface Grade {
  /** 聊天：can be used as a chat / text model. */
  chat: boolean;
  /** 强度：the chosen model has reasoning levels. */
  tune: boolean;
  /** 干活：can read / write files and run commands. 'experimental' = through an endpoint the vendor does not officially support for Claude Code. */
  work: 'yes' | 'experimental' | 'no';
  /** Why a badge is grey (tooltip text). */
  why: { chat?: string; tune?: string; work?: string };
}

/**
 * @param opts.endpoint  the selected endpoint id (default: the first usable one)
 * @param opts.keySaved  a key is saved for it
 * @param opts.levels    the reasoning levels of the selected model (effort.ts)
 * @param opts.agentFound  a command-line agent of this service was detected
 */
export function gradeOf(service: ServiceDef, opts: { endpoint?: string; keySaved?: boolean; levels?: Effort[]; agentFound?: boolean; model?: string } = {}): Grade {
  const ep = service.endpoints.find((e) => e.id === opts.endpoint) ?? defaultEndpointOf(service);
  const why: Grade['why'] = {};
  const apiOk = !!ep && !!ep.baseUrl && ep.kind !== 'plan' && (service.protocol === 'openai-chat' || service.protocol === 'anthropic');
  if (!apiOk) why.chat = ep && ep.kind === 'plan' ? '套餐 Key 只能给命令行编码工具用，不能直接调用 API' : '没有可用的 API 地址';
  else if (!service.models.length && !opts.model) why.chat = '先拉取模型列表，或输入模型 ID';
  else if (!(opts.keySaved || service.auth.keyOptional)) why.chat = '还没有保存 API Key';
  const tune = !!opts.levels && opts.levels.length > 0;
  if (!tune) why.tune = '这个模型不能调节推理强度（或栖枝还不认识它的写法）';
  // 干活 needs a driver: the vendor's own tool or an ACP agent (yes), or Claude Code on the vendor's Anthropic-compatible address
  const compatEp = service.drivers.includes('claude-compat') ? service.endpoints.find((e) => e.compatUrl && (!opts.endpoint || e.id === opts.endpoint)) : undefined;
  let work: Grade['work'] = 'no';
  if (service.drivers.some((d) => d !== 'claude-compat')) work = 'yes';
  else if (compatEp) work = compatEp.compat?.experimental ? 'experimental' : 'yes';
  if (work === 'no') why.work = service.protocol === 'openai-chat' && !service.endpoints.some((e) => e.compatUrl) ? '只有 OpenAI 协议，没有 Anthropic 兼容地址，不能当命令行代理的后端' : '没有可用的命令行方式';
  else if (work === 'experimental') why.work = '厂商没有官方支持把 Claude Code 接到这里，标为实验';
  return { chat: !why.chat, tune, work, why };
}
