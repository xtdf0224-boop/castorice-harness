/* 模型接入目录: every model service the app knows (the eight of the first release and the rest of the catalog, plus the custom
   services the user added), how each can be reached (API key, or a CLI agent that signs in with an account or uses the vendor's key),
   their endpoints and suggested models. Model names are suggestions — any model id the vendor accepts can be typed in.

   The data is NOT written here any more: it comes from electron/ai/catalog/*.json (via lib/services.ts) and from the custom services
   the main process hands over. This file keeps the export surface the UI was built on (PROVIDERS, PROVIDER_BY_ID, DRIVERS, modelInfo,
   readiness…) and builds it from that data. */
import type { Agent, DriverId, ModelState, PermissionMode, ProviderConfig, ProviderId, TaskEngine, ToolDef, ToolId, ToolPermission } from './types';
import { TIERABLE_TOOLS, effectiveTier } from './tiers';
import {
  AGENT_DEFS, DRIVER_DEFS, allServices, defaultEndpointOf, serviceOf, subscribeServices,
  type AcpAgentDef, type EndpointKind, type ModelDef, type PlaceholderDef, type ServiceDef, type ServiceGroup,
} from './services';

/** `label`: the product name with its version (Claude Sonnet 5.5); `ctx`: context window in tokens, when documented. */
export interface ModelOption { id: string; label?: string; note?: string; ctx?: number; maxOut?: number; status?: ModelDef['status']; retiresAt?: string; caps?: ModelDef['caps'] }
export interface RegionOption {
  id: string;
  label: string;
  /** OpenAI-compatible base (…/v1) or, for Claude, the Messages API root. May hold {placeholders}; '' = no API address (command-line only). */
  baseUrl: string;
  /** The vendor's Anthropic-compatible endpoint, used to drive Claude Code with this vendor's key. */
  compatUrl?: string;
  /** payg: pay as you go · plan: a subscription channel (command-line tools only) · local: this machine. */
  kind: EndpointKind;
  /** This region keeps its own key (国内 / 国际 / 套餐 keys are not interchangeable). */
  separateKey?: boolean;
  params?: PlaceholderDef[];
  note?: string;
  /** Models of this channel only. */
  models?: ModelOption[];
  experimental?: boolean;
}

export interface DriverInfo {
  id: DriverId;
  label: string;
  bin: string;
  install: string;
  /** 'account': the CLI signs in with its own account; 'key': it uses the vendor's API key saved here. */
  auth: 'account' | 'key';
  /** How approvals work: per call (the workbench asks you), or by sandbox only. */
  approvals: 'per-call' | 'sandbox';
  note: string;
  homepage: string;
}

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  vendor: string;
  glyph: string;
  protocol: 'openai' | 'anthropic';
  regions: RegionOption[];
  models: ModelOption[];
  /** CLI model suggestions ('' first = the CLI's own default). */
  cliModels: Partial<Record<DriverId, ModelOption[]>>;
  keyUrl: string;
  keyHelp: string;
  drivers: DriverId[];
  /* ── from the service catalog (MODELS-SPEC §4) ── */
  def: ServiceDef;
  kind: ServiceDef['kind'];
  group: ServiceGroup;
  aliases: string[];
  /** Window assumed for a model the catalog does not know. */
  defaultCtx: number;
  /** Works without a saved key (a local server). */
  keyOptional: boolean;
  modelHint?: string;
  docsUrl?: string;
  hidden: boolean;
  verified: string;
  unverified: string[];
}

/* ═══════════════════════════ drivers ═══════════════════════════ */

/** The three ACP tools of the first release keep their original wording, word for word. */
const LEGACY_DRIVER_INFO: Record<'kimi' | 'qwen' | 'mcode', DriverInfo> = {
  kimi: {
    id: 'kimi', label: 'Kimi Code CLI', bin: 'kimi', install: 'npm install -g @moonshot-ai/kimi-code',
    auth: 'account', approvals: 'per-call', homepage: 'https://moonshotai.github.io/kimi-code/',
    note: '用 Kimi 会员账号登录（需含 Kimi Code 额度）。通过 ACP 协议对接，操作前会征求确认。',
  },
  qwen: {
    id: 'qwen', label: 'Qwen Code', bin: 'qwen', install: 'npm install -g @qwen-code/qwen-code',
    auth: 'key', approvals: 'per-call', homepage: 'https://github.com/QwenLM/qwen-code',
    note: 'Qwen Code 使用阿里云百炼的 API Key（下面「API 密钥」里保存的那个）。通过 ACP 协议对接，操作前会征求确认。',
  },
  mcode: {
    id: 'mcode', label: 'MiniMax Code', bin: 'mcode', install: 'npm install -g @minimax-ai/code',
    auth: 'account', approvals: 'per-call', homepage: 'https://github.com/MiniMax-AI/minimax-code',
    note: '用 MiniMax 账号登录（国内账号；海外账号请在终端运行 mcode login --region global）。通过 ACP 协议对接，操作前会征求确认。',
  },
};

/** A command-line agent as a driver (MODELS-SPEC §5.7): account login or the vendor's key; every request is asked per call. */
export function agentDriverInfo(a: AcpAgentDef): DriverInfo {
  return {
    id: `acp:${a.id}`,
    label: a.label,
    bin: a.bin[0],
    install: a.install.npm ? `npm install -g ${a.install.npm}` : (a.install.script ?? a.install.note ?? ''),
    auth: a.auth.mode === 'env-key' ? 'key' : 'account',
    approvals: 'per-call',
    note: a.auth.loginHint,
    homepage: a.docsUrl,
  };
}

const builtinDrivers = Object.fromEntries(DRIVER_DEFS.map((d) => [d.id, {
  id: d.id, label: d.label, bin: d.bin, install: d.install, auth: d.auth, approvals: d.approvals, note: d.note, homepage: d.homepage,
} as DriverInfo]));

export const DRIVERS: Record<DriverId, DriverInfo> = {
  ...builtinDrivers,
  ...LEGACY_DRIVER_INFO,
  ...Object.fromEntries(AGENT_DEFS.map((a) => [`acp:${a.id}`, agentDriverInfo(a)])),
} as Record<DriverId, DriverInfo>;

/** Register a driver at run time (an agent the user added). */
export function registerDriver(info: DriverInfo) { (DRIVERS as Record<string, DriverInfo>)[info.id] = info; }
/** The driver's description, or a plain stand-in for an id this build does not know (a task saved by another version). */
export function driverOf(id: string | undefined): DriverInfo {
  const d = id ? (DRIVERS as Record<string, DriverInfo | undefined>)[id] : undefined;
  return d ?? { id: (id ?? 'claude-compat') as DriverId, label: id ?? '命令行', bin: '', install: '', auth: 'account', approvals: 'per-call', note: '这个版本不认识这个命令行工具。', homepage: '' };
}

/* ═══════════════════════════ services → ProviderInfo ═══════════════════════════ */

const asOption = (m: ModelDef): ModelOption => {
  const o: ModelOption = { id: m.id };
  if (m.label) o.label = m.label;
  if (m.note) o.note = m.note;
  if (m.ctx) o.ctx = m.ctx;
  if (m.maxOut) o.maxOut = m.maxOut;
  if (m.status) o.status = m.status;
  if (m.retiresAt) o.retiresAt = m.retiresAt;
  if (m.caps) o.caps = m.caps;
  return o;
};

/** '*' = every model of the service, a string = one of them, an object = inline ('' id = the tool's own default). */
function expandCliModels(def: ServiceDef): Partial<Record<DriverId, ModelOption[]>> {
  const out: Partial<Record<DriverId, ModelOption[]>> = {};
  for (const [driver, list] of Object.entries(def.cliModels ?? {})) {
    const rows: ModelOption[] = [];
    for (const x of list ?? []) {
      if (x === '*') rows.push(...def.models.map(asOption));
      else if (typeof x === 'string') { const m = def.models.find((y) => y.id === x); if (m) rows.push(asOption(m)); } else rows.push(asOption(x));
    }
    out[driver as DriverId] = rows;
  }
  return out;
}

const NO_ADDRESS: RegionOption = { id: '', label: '（尚未载入）', baseUrl: '', kind: 'payg' };

function toInfo(def: ServiceDef): ProviderInfo {
  const regions: RegionOption[] = def.endpoints.length
    ? def.endpoints.map((e) => ({
      id: e.id, label: e.label, baseUrl: e.baseUrl ?? '', compatUrl: e.compatUrl, kind: e.kind, separateKey: e.separateKey, params: e.params, note: e.note,
      models: e.models?.map(asOption), experimental: e.compat?.experimental,
    }))
    : [NO_ADDRESS];
  return {
    id: def.id, name: def.name, vendor: def.vendor, glyph: def.glyph, protocol: def.protocol === 'anthropic' ? 'anthropic' : 'openai',
    regions, models: def.models.map(asOption), cliModels: expandCliModels(def),
    keyUrl: def.keyUrl ?? def.docsUrl ?? '', keyHelp: def.keyHelp, drivers: def.drivers,
    def, kind: def.kind, group: def.group, aliases: def.aliases ?? [], defaultCtx: def.defaultCtx ?? DEFAULT_CONTEXT,
    keyOptional: !!def.auth.keyOptional || def.auth.scheme === 'none', modelHint: def.modelHint, docsUrl: def.docsUrl,
    hidden: !!def.hidden, verified: def.verified, unverified: def.unverified ?? [],
  };
}

const infoCache = new WeakMap<ServiceDef, ProviderInfo>();
const infoFor = (def: ServiceDef): ProviderInfo => {
  let i = infoCache.get(def);
  if (!i) { i = toInfo(def); infoCache.set(def, i); }
  return i;
};

/** The services the UI lists: the first-release eight first, then the rest of the catalog, then the user's own. Hidden (unchecked) presets are not in it. Rebuilt in place when the custom list changes. */
export const PROVIDERS: ProviderInfo[] = [];
const everyone = new Map<string, ProviderInfo>();
const deletedInfo = new Map<string, ProviderInfo>();

function rebuild() {
  PROVIDERS.splice(0, PROVIDERS.length, ...allServices().map(infoFor));
  everyone.clear();
  for (const def of allServices({ hidden: true })) everyone.set(def.id, infoFor(def));
}
subscribeServices(rebuild);

/** Every service by id, hidden presets included. An id that no longer exists (a deleted custom service that a task still names) reads as a placeholder named 「（已删除）」. */
export const PROVIDER_BY_ID: Record<ProviderId, ProviderInfo> = new Proxy({} as Record<ProviderId, ProviderInfo>, {
  get(_t, key) {
    if (typeof key !== 'string') return undefined;
    const hit = everyone.get(key);
    if (hit) return hit;
    let gone = deletedInfo.get(key);
    if (!gone) { gone = toInfo(serviceOf(key)); deletedInfo.set(key, gone); }
    return gone;
  },
  has: (_t, key) => typeof key === 'string' && everyone.has(key),
  ownKeys: () => [...everyone.keys()],
  getOwnPropertyDescriptor: (_t, key) => (typeof key === 'string' && everyone.has(key) ? { enumerable: true, configurable: true, writable: true, value: everyone.get(key) } : undefined),
});
/** Does a service with this id exist (a deleted one does not)? */
export const hasProvider = (id: string) => everyone.has(id);
/** Every service including the hidden presets, in list order (for the 「显示未核实的预设」 switch). */
export const allProviders = (): ProviderInfo[] => allServices({ hidden: true }).map(infoFor);

rebuild();

/* ═══════════════════════════ models ═══════════════════════════ */

const allModelsOf = (p: ProviderInfo): ModelOption[] =>
  [...p.models, ...Object.values(p.cliModels).flat(), ...p.regions.flatMap((r) => r.models ?? [])].filter((m): m is ModelOption => !!m && !!m.id);

/** The catalog entry for a model id (API or any CLI list), ignoring a trailing [1m]. */
export function modelInfo(p: ProviderInfo, model: string): ModelOption | undefined {
  if (!model) return undefined;
  const all = allModelsOf(p);
  return all.find((m) => m.id === model) ?? all.find((m) => m.id.replace(/\[1m\]$/i, '') === model.replace(/\[1m\]$/i, '') && !!m.label);
}

/** 「Claude Sonnet 5.5」 for claude-sonnet-5-5 / sonnet[1m]; the id itself for models not in the catalog. */
export function modelName(p: ProviderInfo, model: string): string {
  return modelInfo(p, model)?.label ?? model;
}

/** 「1M 上下文」 style note for a model's window, when documented. */
export function ctxLabel(tokens: number | undefined): string {
  if (!tokens) return '';
  // 1,050,000 reads as 1M, not 1.1M: round down to a tenth of a million.
  return tokens >= 1_000_000 ? `${Math.floor(tokens / 100_000) / 10}M 上下文`.replace('.0M', 'M') : `${Math.round(tokens / 1000)}K 上下文`;
}

/** A CLI's own model name in the catalog's style: 「GPT-5.6-Sol」 → 「GPT-5.6 Sol」. */
export function tidyModelLabel(label: string): string {
  return label.replace(/^([A-Za-z]+-[\d.]+)-(?=[A-Za-z])/, '$1 ');
}

/** A CLI's English one-line description → a short note in the menu's words (or nothing). */
export function shortModelNote(desc: string | undefined): string | undefined {
  if (!desc) return undefined;
  if (/older|previous|legacy/i.test(desc)) return '上一代';
  if (/frontier|most capable|flagship|strongest/i.test(desc)) return '旗舰';
  if (/fast|affordable|efficient|cheap|quick/i.test(desc)) return '快速';
  if (/workhorse|balanced|general|everyday/i.test(desc)) return '主力';
  return /[一-鿿]/.test(desc) && desc.length <= 12 ? desc : undefined;
}

export function defaultProviderConfig(p: ProviderInfo): ProviderConfig {
  // a service with no command-line tool still needs SOME driver value; readiness() says it has none
  const driver = p.drivers[0] ?? 'claude-compat';
  const ep = defaultEndpointOf(p.def);
  return {
    id: p.id,
    // a stand-alone command-line agent has no API way at all
    auth: p.kind === 'agent' ? 'cli' : 'api',
    driver,
    region: ep?.id ?? p.regions[0].id,
    baseUrl: '',
    model: p.def.defaultModel ?? p.models[0]?.id ?? '',
    cliModel: p.cliModels[driver]?.[0]?.id ?? '',
    cliPath: '',
  };
}

/** Context window of a model: documented value, else the service's default (1M for the first-release eight, 128K for custom services, small for local ones). */
export const DEFAULT_CONTEXT = 1_000_000;
export function contextOf(p: ProviderInfo, model: string): { tokens: number; known: boolean } {
  const id = model.replace(/\[1m\]$/i, '');
  const hit = allModelsOf(p).find((m) => m.id === id || m.id === model);
  if (model.endsWith('[1m]')) return { tokens: DEFAULT_CONTEXT, known: true };
  return hit?.ctx ? { tokens: hit.ctx, known: true } : { tokens: p.defaultCtx, known: false };
}

export const regionOf = (p: ProviderInfo, cfg: Pick<ProviderConfig, 'region'>) => p.regions.find((r) => r.id === cfg.region) ?? p.regions[0];
export const apiBaseUrl = (p: ProviderInfo, cfg: ProviderConfig) => cfg.baseUrl.trim() || regionOf(p, cfg).baseUrl;

/** Is this way of using the vendor set up? (A passing test is not required — just the ingredients.) */
export function readiness(p: ProviderInfo, cfg: ProviderConfig, auth: 'api' | 'cli'): { ready: boolean; reason?: string } {
  if (auth === 'api') {
    const ep = regionOf(p, cfg);
    // a plan key is for the vendor's own coding tools; the main process refuses it as well
    if (ep.kind === 'plan') return { ready: false, reason: '套餐 Key 只能给命令行编码工具用，请改用命令行方式' };
    if (!ep.baseUrl) return { ready: false, reason: '这个地区没有 API 地址，请改用命令行方式' };
    for (const prm of ep.params ?? []) {
      const v = cfg.params?.[prm.name] ?? '';
      let okValue = false;
      try { okValue = !!v && new RegExp(prm.pattern).test(v); } catch { okValue = false; }
      if (!okValue) return { ready: false, reason: `请填写「${prm.label}」${prm.example ? `（例如 ${prm.example}）` : ''}` };
    }
    if (!cfg.keyHint && !p.keyOptional) return { ready: false, reason: '还没有保存 API Key' };
    if (!cfg.model) return { ready: false, reason: '还没有选择模型' };
    return { ready: true };
  }
  const d = driverOf(cfg.driver);
  if (!p.drivers.length) return { ready: false, reason: '这家服务没有可用的命令行工具' };
  if (!p.drivers.includes(cfg.driver)) return { ready: false, reason: '请选择命令行工具' };
  if (!cfg.cli) return { ready: false, reason: `还没有检测 ${d.label}` };
  if (!cfg.cli.found) return { ready: false, reason: `没有找到 ${d.bin} 命令` };
  if (d.auth === 'key' && !cfg.keyHint && !p.keyOptional) return { ready: false, reason: `${d.label} 需要这家的 API Key` };
  if (cfg.driver === 'claude-compat' && !regionOf(p, cfg).compatUrl) {
    const alt = p.regions.find((r) => r.compatUrl);
    return { ready: false, reason: alt ? `「${regionOf(p, cfg).label}」没有 Claude Code 兼容端点，请把服务地区切到「${alt.label}」` : '这家没有 Claude Code 兼容端点' };
  }
  if (d.auth === 'account' && cfg.cli.login === 'no') return { ready: false, reason: `${d.label} 还没有登录` };
  return { ready: true };
}

/** 「Claude Sonnet 5.5 · Claude Code」, or 「GPT · Codex CLI」 when the tool picks the model. */
export function engineLabel(p: ProviderInfo, auth: 'api' | 'cli', driver: DriverId | undefined, model: string) {
  const how = auth === 'api' ? 'API' : driverOf(driver ?? p.drivers[0]).label;
  return model ? `${modelName(p, model)} · ${how}` : `${p.name} · ${how}`;
}

/** CLI tool names → the workbench's tool categories (for icons, policies and approvals). */
export function toolCategory(name: string, input?: Record<string, unknown>): import('./types').ToolId {
  const n = name.toLowerCase();
  const cmd = typeof input?.command === 'string' ? input.command.trim() : '';
  // alight-browser tools: mcp__alight-browser__browser_click (Claude Code), alight_browser.browser_click (Codex)…
  // Going to a new address (navigate, back) can reach a signed-in site or carry data out: it is an action.
  const b = n.match(/browser_(navigate|snapshot|scroll|back|screenshot|wait|click|type|press)/);
  if (b) return ['click', 'type', 'press', 'navigate', 'back'].includes(b[1]) ? 'browser_act' : 'browser_read';
  // A command is git only when it is nothing but git: `git status; curl …` is a shell command.
  if (/^(bash|powershell|shell|execute|run_shell_command|exec_command|local_shell)$/.test(n)) return /^git(\s|$)/.test(cmd) && !/[;&|<>`$\n\r]/.test(cmd) ? 'git' : 'shell';
  if (/^(read|notebookread|read_file|read_many_files)$/.test(n)) return 'read_file';
  if (/^(write|edit|multiedit|notebookedit|apply_patch|write_file|replace|edit_file)$/.test(n)) return 'write_file';
  if (/^(grep|glob|ls|search|code_search|list_directory|search_file_content|find)$/.test(n)) return 'code_search';
  if (/^(websearch|web_search|google_web_search)$/.test(n)) return 'web_search';
  if (/^(webfetch|web_fetch|fetch)$/.test(n)) return 'web_fetch';
  return 'other';
}

/** Claude Code tool names for each workbench tool, used to build --allowedTools / --disallowedTools. */
export const CLAUDE_TOOLS: Record<import('./types').ToolId, string[]> = {
  read_file: ['Read', 'NotebookRead'],
  write_file: ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'],
  shell: ['Bash', 'PowerShell'],
  code_search: ['Grep', 'Glob', 'LS'],
  web_search: ['WebSearch'],
  web_fetch: ['WebFetch'],
  git: ['Bash(git:*)', 'PowerShell(git:*)'],
  browser_read: ['browser_snapshot', 'browser_scroll', 'browser_screenshot', 'browser_wait'].map((t) => `mcp__alight-browser__${t}`),
  browser_act: ['browser_navigate', 'browser_back', 'browser_click', 'browser_type', 'browser_press'].map((t) => `mcp__alight-browser__${t}`),
  other: [],
};

/** Claude Code tools that make no sense when nobody is at its prompt.
 *  AskUserQuestion / ExitPlanMode 不在这里：Agent SDK 驱动会把它们接成提问卡和计划审批；
 *  旧的 stream-json 驱动没有这两样，主进程（electron/ai/index.cjs）自己把它们补进旧驱动的禁用名单。
 *  EnterPlanMode 仍然关掉：计划由栖枝的计划审批统一收取。 */
export const CLAUDE_HEADLESS_DENY = ['EnterPlanMode', 'EnterWorktree', 'ExitWorktree', 'CronCreate', 'CronDelete', 'ScheduleWakeup', 'RemoteTrigger'];

/* ───────────── 权限模式（输入框里常显的五种）在各引擎上做得到什么 ───────────── */

export const PERMISSION_MODE_LABEL: Record<PermissionMode, string> = { ask: '逐项', acceptEdits: '接受编辑', plan: '计划', auto: '自动', bypass: '放手' };
export const PERMISSION_MODE_HINT: Record<PermissionMode, string> = {
  ask: '每一步要确认的操作都会先问你。',
  acceptEdits: '工作文件夹里的编辑直接做，其余照常问。',
  plan: '先只读调研、出计划；你批准之后才动手，执行时逐项确认。',
  auto: '由 claude 自己判断：工作文件夹里的改动与简单命令直接做，其余交给模型分类器（会多用一点额度）；判断不了的会直接拒绝，不会来问你。',
  bypass: '不再逐项问；但「工具与技能」里关掉的、越出工作文件夹的文件路径、没有信任的目录仍然会被拦下或询问（命令里写的路径不在检查范围内）。',
};

/** 'full' 如实对应；'approx' 近似；'degraded' 做不到、已降级（界面和运行流里会如实说）；'unverified' 没验证过。 */
export type ModeSupport = { level: 'full' | 'approx' | 'degraded' | 'unverified'; note?: string };

/** 与 electron/ai/perm.cjs 里的映射一致（那里是真正生效的一份）。 */
export function permissionSupport(driver: DriverId | undefined, mode: PermissionMode, opts: { claudeLegacy?: boolean } = {}): ModeSupport {
  switch (driver) {
    case 'claude-code':
      if (opts.claudeLegacy) return mode === 'ask' ? { level: 'full' } : mode === 'acceptEdits' ? { level: 'full' } : { level: 'degraded', note: '旧驱动只有逐项和接受编辑，这次按逐项处理。' };
      return mode === 'auto' ? { level: 'full', note: '需要这个版本的 claude 支持自动模式；不支持会自动降级并提示。' } : { level: 'full' };
    case 'claude-compat':
      return mode === 'ask' || mode === 'acceptEdits' ? { level: 'full' } : { level: 'degraded', note: '兼容端点走旧驱动：只有逐项和接受编辑，其余按逐项处理。' };
    case 'codex':
      return mode === 'plan' ? { level: 'approx', note: '计划阶段是只读沙箱；批准计划之后按沙箱策略执行，不能逐项确认。' } : { level: 'degraded', note: 'Codex 的无头模式不能逐项确认，按沙箱策略执行。' };
    case 'dsh':
      return mode === 'plan' ? { level: 'approx', note: '计划阶段是只读模式；批准计划之后按它自己的权限配置执行，不能逐项确认。' } : { level: 'degraded', note: 'DeepSeek Harness 的无头模式不能逐项确认，按它自己的权限配置执行。' };
    case 'kimi':
    case 'acp:kimi':
      return mode === 'acceptEdits' ? { level: 'approx', note: 'Kimi 没有「只接受编辑」，按逐项确认处理。' } : mode === 'auto' || mode === 'bypass' ? { level: 'degraded', note: 'Kimi 在自动 / 放手下手套只记账、不拦截。' } : { level: 'full' };
    case 'qwen':
    case 'mcode':
      return mode === 'ask' ? { level: 'full' } : { level: 'unverified', note: '这个命令行工具的权限模式没有验证过，按它的默认逐项确认。' };
    default:
      // ACP agents the catalog lists (and any the user adds): nothing is verified until the probe says so — ask works, the rest is "按它的默认"
      if (typeof driver === 'string' && driver.startsWith('acp:')) return mode === 'ask' ? { level: 'full' } : { level: 'unverified', note: '这个命令行工具的权限模式没有验证过，按它的默认逐项确认。' };
      return { level: 'degraded', note: '这种接入方式没有工具，权限模式不适用。' };
  }
}

/* ───────────── 工具档的「遵守矩阵」（Agent 页，施工图 §2.1.4）：按「工具 × 权限模式」如实标注，不是引擎一个标签 ─────────────
   纯函数；旧 driverOf 一字不动. 驱动解析（honorDriver）只读 ModelState，不依赖 state/models.ts（避免循环引用）. */

/** DriverId 沿用 services.ts；'api' = 走 API，没有工具. */
export type HonorDriver = DriverId | 'api';
export type HonorKind = 'enforced' | 'by-mode' | 'sandbox' | 'ask-only' | 'none' | 'notools';
export interface Honor {
  kind: HonorKind;
  /** 黑档这里是否真的拦住. */
  blocks: boolean;
  /** 银档这里是否真的会问；'maybe' = 由分类器 / 代理自己决定，可能被静默拒绝. */
  asks: 'yes' | 'no' | 'maybe';
  /** 「逐项遵守」「只认写文件/联网」「试了才拦」「不受限」「无工具」. */
  label: string;
  note?: string;
}

/** 由 Agent.engine（`provider:auth`）或所跟随的任务引擎解出驱动. 解析不出 → undefined.
 *  Agent.engine 未指定 → 取 taskEngine；两者都没有 → undefined. */
export function honorDriver(models: ModelState, engine: { key?: string } | undefined, taskEngine?: TaskEngine): HonorDriver | undefined {
  if (engine?.key) {
    const at = engine.key.lastIndexOf(':');
    if (at < 0) return undefined;
    const provider = engine.key.slice(0, at);
    const auth = engine.key.slice(at + 1);
    if (auth === 'api') return 'api';
    if (auth === 'cli') return models.providers[provider]?.driver;
    return undefined;
  }
  if (taskEngine) {
    if (taskEngine.auth === 'api') return 'api';
    return taskEngine.driver ?? models.providers[taskEngine.provider]?.driver;
  }
  return undefined;
}

const isAcpLike = (d: string) => d === 'kimi' || d === 'qwen' || d === 'mcode' || d.startsWith('acp:');
const isKimi = (d: string) => d === 'kimi' || d === 'acp:kimi';
const READ_TOOLS: ToolId[] = ['read_file', 'code_search'];
const BROWSER_TOOLS: ToolId[] = ['browser_read', 'browser_act'];

const H_NONE: Honor = { kind: 'none', blocks: false, asks: 'no', label: '不受限' };

/** Claude Code「自动」模式的实测（scripts/probe/hook-probe/driver-check.mjs 的 7 / 7c 块；Bash 与 PowerShell 两种宿主各测一遍）：
 *  - 工作文件夹内的 Write / Edit / Read / Grep：直接做，既不问分类器也不问人（越出工作文件夹的 Write 由栖枝的钩子来问你）；
 *  - 命令：工作文件夹内的简单命令直接做（Bash 的 echo > 文件、cat、mkdir、rm；PowerShell 的 Set-Content、Get-Content、Remove-Item），
 *    其余交给分类器——联网、写工作文件夹以外、PowerShell 的 > 重定向与 New-Item 这类它不认作简单命令的；
 *  - WebFetch / WebSearch / MCP（浏览器）：一律交给分类器；
 *  - 分类器不放行、或判断不了，就直接拒绝，不会来问你。
 *  所以「自动」下 write_file 是「不问」（和接受编辑同一类），命令与联网才是 'maybe'. 版本变了以实测为准：check-engine 对表，driver-check 钉行为. */
const AUTO_WRITE: Honor = { kind: 'by-mode', blocks: false, asks: 'no', label: '自动下工作文件夹内直接做', note: '工作文件夹内的写入直接做、不问；越出工作文件夹的由栖枝来问你' };
const AUTO_SHELL: Honor = { kind: 'by-mode', blocks: false, asks: 'maybe', label: '分类器判断', note: '工作文件夹里的简单命令直接做；联网、越出工作文件夹等交给分类器，判断不了会直接拒绝，不会来问你' };
const AUTO_NET: Honor = { kind: 'by-mode', blocks: false, asks: 'maybe', label: '分类器判断', note: '交给分类器，判断不了会直接拒绝，不会来问你' };

/** 一个工具在某驱动、某档、某权限模式（缺省 = 逐项）下，设置是否真的起作用. */
export function honorOf(driver: HonorDriver | undefined, tool: ToolId, tier: ToolPermission, mode: PermissionMode = 'ask'): Honor {
  if (driver === undefined) return { kind: 'none', blocks: false, asks: 'no', label: '随任务引擎' };
  if (driver === 'api') return { kind: 'notools', blocks: false, asks: 'no', label: '无工具' };
  if (tool === 'other') return { ...H_NONE, note: '其他工具按全局策略，无法单独封' };

  if (driver === 'claude-code' || driver === 'claude-compat') {
    // claude-compat 走旧 stream-json 驱动（permissionSupport / perm.cjs legacyMode）：只有逐项和接受编辑，计划 / 自动 / 放手一律按逐项处理.
    if (driver === 'claude-compat' && mode !== 'ask' && mode !== 'acceptEdits') mode = 'ask';
    if (tier === 'off') return { kind: 'enforced', blocks: true, asks: 'no', label: '禁用生效', note: driver === 'claude-compat' ? '兼容端点只有禁用名单，没有钩子' : undefined };
    if (tier === 'auto') return { kind: 'enforced', blocks: false, asks: 'no', label: '不额外限制' };
    // confirm
    if (READ_TOOLS.includes(tool)) return { kind: 'by-mode', blocks: false, asks: 'no', label: '工作文件夹内不问', note: '读文件与代码搜索在工作文件夹内任何权限模式都不问' };
    if (tool === 'write_file') {
      switch (mode) {
        case 'ask': return { kind: 'enforced', blocks: false, asks: 'yes', label: '逐项遵守' };
        case 'plan': return { kind: 'enforced', blocks: false, asks: 'yes', label: '逐项遵守', note: '只读阶段直接拦，批准计划后逐项问' };
        case 'acceptEdits': return { kind: 'by-mode', blocks: false, asks: 'no', label: '接受编辑下不问', note: '工作文件夹内的写入直接做' };
        case 'auto': return AUTO_WRITE;
        case 'bypass': return { kind: 'by-mode', blocks: false, asks: 'no', label: '放手下不问' };
      }
    }
    // shell / git / web_* / browser_*
    switch (mode) {
      case 'ask': case 'plan': return { kind: 'enforced', blocks: false, asks: 'yes', label: '逐项遵守' };
      // 接受编辑：命令照常问；但 Claude Code 自己把工作文件夹内 mkdir / touch / mv / cp 这类文件系统命令也算「编辑」（该版本行为没有逐条核对），所以只在备注里提醒
      case 'acceptEdits': return { kind: 'enforced', blocks: false, asks: 'yes', label: '逐项遵守', note: tool === 'shell' ? '工作文件夹内 mkdir、touch、mv、cp 之类的文件系统命令，Claude Code 在接受编辑下可能直接做（没有逐条核对）' : undefined };
      case 'auto': return tool === 'shell' || tool === 'git' ? AUTO_SHELL : AUTO_NET;
      case 'bypass': return { kind: 'by-mode', blocks: false, asks: 'no', label: '放手下不问' };
    }
  }

  if (driver === 'codex') {
    if (tier === 'off' && tool === 'write_file') return { kind: 'sandbox', blocks: true, asks: 'no', label: '只读沙箱', note: '禁用写文件会改成只读沙箱' };
    if (tier === 'off' && tool === 'web_search') return { kind: 'sandbox', blocks: true, asks: 'no', label: '不联网', note: '禁用网页搜索会关掉联网搜索' };
    if (tier === 'off' && BROWSER_TOOLS.includes(tool)) return { kind: 'sandbox', blocks: false, asks: 'no', label: '两项都禁用才生效', note: '浏览器两项都禁用时整套才不挂载' };
    return { kind: 'none', blocks: false, asks: 'no', label: 'Codex 自己管' };
  }

  if (driver === 'dsh') {
    return { kind: 'none', blocks: false, asks: 'no', label: '不受这里限制', note: mode === 'plan' ? '只读 / 计划阶段会强制只读，这是唯一的例外' : undefined };
  }

  if (isAcpLike(driver)) {
    if (tier === 'auto') return { kind: 'none', blocks: false, asks: 'no', label: '不额外限制' };
    const noRequest = isKimi(driver) && (mode === 'auto' || mode === 'bypass');
    if (tier === 'off') {
      // 黑档只靠「代理发来权限请求、我们回绝」生效（live.ts onPermission）：代理不发请求就拦不住.
      // Kimi 在自动 / 放手下一概不发请求；读文件与代码搜索，ACP 代理通常也不发请求.
      if (noRequest) return { kind: 'none', blocks: false, asks: 'no', label: '不发请求，拦不住', note: 'Kimi 在自动 / 放手下不发权限请求，禁用的工具也不会被拦' };
      if (READ_TOOLS.includes(tool)) return { kind: 'none', blocks: false, asks: 'no', label: '不发请求，拦不住', note: '代理读文件与搜索代码通常不发权限请求，禁用也拦不住' };
      return { kind: 'ask-only', blocks: true, asks: 'no', label: '试了才拦', note: '代理仍能看到这个工具，试了才会被拒' };
    }
    if (noRequest) return { kind: 'ask-only', blocks: false, asks: 'no', label: '不发请求', note: 'Kimi 在自动 / 放手下不发权限请求' };
    return { kind: 'ask-only', blocks: false, asks: 'maybe', label: '代理自己发请求才问', note: '只有代理自己发来权限请求的调用才会问' };
  }

  return H_NONE;
}

/** 牌背 / 工具页顶部「引擎遵守情况」的一段话：逐引擎、逐权限模式. 文案不用「银手套 / 黑档 / 黑色审批卡」（D1）. */
export function honorSummary(driver: HonorDriver | undefined, mode: PermissionMode = 'ask'): string {
  if (driver === undefined) return '用任务的模型；命令行方式才有工具。';
  if (driver === 'api') return 'API 方式不使用工具。';
  if (driver === 'claude-code' || driver === 'claude-compat') {
    const base = '禁用的工具在任何权限模式下都会被拦住。';
    // 兼容端点走旧驱动：只有逐项和接受编辑，其余模式如实按逐项处理（与 honorOf 同一口径）
    if (driver === 'claude-compat' && mode !== 'ask' && mode !== 'acceptEdits') {
      return `${base}兼容端点只有逐项和接受编辑，当前的权限模式会按逐项处理：需确认的写文件、执行命令、联网和浏览器都会逐项问；读文件与代码搜索在工作文件夹内不问。`;
    }
    switch (mode) {
      case 'ask': return `${base}逐项模式下，需确认的写文件、执行命令、联网和浏览器都会逐项问；读文件与代码搜索在工作文件夹内不问。`;
      case 'plan': return `${base}计划模式先只读调研，批准计划后需确认的工具照常逐项问；读文件与代码搜索不问。`;
      case 'acceptEdits': return `${base}接受编辑下，需确认的写文件（工作文件夹内）不会问；执行命令、联网和浏览器照常问。`;
      case 'auto': return `${base}自动模式由 Claude Code 自己判断：工作文件夹里的写入与简单命令直接做，不会问；联网、越出工作文件夹的命令交给模型分类器，判断不了会直接拒绝，不会来问你。`;
      case 'bypass': return `${base}放手模式下，需确认的工具也不再问。`;
    }
  }
  if (driver === 'codex') return '只认写文件和联网搜索：禁用写文件会改成只读沙箱，禁用网页搜索会不联网；其余工具由 Codex 自己管，这里的设置不起作用。';
  if (driver === 'dsh') return '不受这里限制：DeepSeek Harness 按它自己的权限配置运行（只读 / 计划阶段会强制只读）。';
  if (isAcpLike(driver)) {
    const base = '只有代理自己发来权限请求的调用才会问；禁用的工具代理仍能看到，试了才会被拒。读文件和代码搜索代理通常不发请求，禁用也拦不住。';
    if (isKimi(driver) && (mode === 'auto' || mode === 'bypass')) return `${base}Kimi 在自动和放手模式下根本不发权限请求：禁用的工具也不会被拦，需确认的也不会问。`;
    return base;
  }
  return '这种接入方式没有验证过，设置不一定起作用。';
}

/** 牌面 / 汇总卡共用：只看有效档 ≠ 白的工具（有限制才谈遵守）. 被遵守 = 黑档且 blocks，或银档且 asks==='yes'. */
export function honorTally(
  agent: Pick<Agent, 'id' | 'tiers'>, globals: ToolDef[], driver: HonorDriver | undefined, mode: PermissionMode = 'ask',
): { kind: 'all' | 'partial' | 'none' | 'notools'; honored: number; restricting: number } {
  if (driver === 'api') return { kind: 'notools', honored: 0, restricting: 0 };
  let restricting = 0;
  let honored = 0;
  const tiers = Object.fromEntries(TIERABLE_TOOLS.map((t) => [t, effectiveTier(agent, t, globals)])) as Record<ToolId, ToolPermission>;
  // Codex 的浏览器只有两项都禁用、整套不挂载时才生效
  const browserOff = tiers.browser_read === 'off' && tiers.browser_act === 'off';
  for (const t of TIERABLE_TOOLS) {
    const tier = tiers[t];
    if (tier === 'auto') continue;
    restricting += 1;
    const h = honorOf(driver, t, tier, mode);
    const ok = tier === 'off' ? (h.blocks || (driver === 'codex' && BROWSER_TOOLS.includes(t) && browserOff)) : h.asks === 'yes';
    if (ok) honored += 1;
  }
  if (driver === undefined || restricting === 0 || honored === restricting) return { kind: 'all', honored: driver === undefined ? restricting : honored, restricting };
  return { kind: honored > 0 ? 'partial' : 'none', honored, restricting };
}

/** agents.* 台词取池：enf = 逐项遵守；soft = 看权限模式 / 代理自己决定 / 试了才拦；none = 不遵守或没有工具. */
export function honorPool(h: Honor): 'enf' | 'soft' | 'none' {
  if (h.kind === 'enforced') return 'enf';
  if (h.kind === 'by-mode' || h.kind === 'ask-only' || h.kind === 'sandbox') return 'soft';
  return 'none';
}
