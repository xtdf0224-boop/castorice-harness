/* 保存与读取（V0α · 模块 B2「存储」）。
   桌面版：任务、运行、消息、事件、用量都存在主进程的 SQLite 库里（electron/store，通过 src/lib/storeBridge.ts）。
   - 启动只读每个任务的尾部（最近若干条消息）和各运行的摘要，**绝不把整份历史读进渲染进程**；
     打开一个任务时补足它的尾部、取回当前运行的工具调用/产物/终端；更早的消息由对话页向上翻页再取。
   - 运行中增量保存：Syncer 把状态和「库里已有的」对一遍，只送变了的实体（每秒至多一批）。
   - 第一次启动：从旧 localStorage（alight/v1 与萤火的 firefly-harness/v1）一次性迁移——只读不删，迁移后打标记。
   - 偏好（设置、工具策略、Agent、模型接入）仍放 localStorage（启动时要同步拿到，不能等库），同时镜像进库。
   浏览器开发版（没有桥）和库打不开时，退回 localStorage 整份存取（萤火的原逻辑）。
   On load, a run that was mid-step is paused, never silently resumed. */
import { produce, type Draft } from 'immer';
import { EFFORT_LABEL, type Effort } from '../lib/effort';
import { previousSeen, startPresence } from '../lib/presence';
import { PROVIDER_BY_ID } from '../lib/providers';
import * as sb from '../lib/storeBridge';
import { legacyToolsOf, migrateToolsToTiers } from '../lib/tiers';
import type { AgentEngine, AgentTiers, AppState, Level, MemoryItem, Message, PetSettings, PetVoiceIds, PetVoiceProvider, Run, Settings, Task, TierableToolId, ToolId } from '../lib/types';
import { EVENT_CAP, pauseRun, toast } from './engine';
import { normalizeAfterLoad } from './live';
import { restoreModels } from './models';
import { BOOT_LIVE_REV, LEGACY_PREFS_KEY, PREFS_KEY, themeOf } from './prefsKeys';
import { DEFAULT_PET, DEFAULT_SETTINGS, emptyState, syncPersonaAgent } from './seed';
import { store } from './store';
import { startUsageSync } from './usage';

const KEY = 'alight/v1';
/** 萤火的键：从萤火分出来的第一次启动沿用它的数据。 */
const LEGACY_KEY = 'firefly-harness/v1';
/** 已把 localStorage 里的任务迁进库的标记（旧键保留不删）。 */
const MIGRATED_KEY = 'alight/migrated-to-db';
/** 已迁移过的用户遇到库打不开、退回 localStorage 的时刻。库恢复后据此把退回期间新建的任务和消息补进库（reconcileFallback）. */
const FALLBACK_KEY = 'alight/fallback-since';
const VERSION = 1;
/** Bumped when the saved task history changes shape.
 *  2: the 演示模式 simulator is gone, so older saves are cleaned on load (see dropDemoData). */
const DATA_REV = 2;

/** Bumped when a setting's meaning changes; older saved values for it are replaced by the new default.
 *  2: the wallpaper transparency model changed (halo glass), so 壁纸可见度 / 面板通透度 restart at their defaults.
 *  3: 话量 / 口吻 / 主动说话拆成 level / persona / proactive（migrateSettings）.
 *  4: 剧情框默认改成「闲聊」（用户 2026-10-28 定）；0.2.0-beta.1 存下的 'off' 是当时的默认，换成新默认（migrateSettings）.
 *  5: 昼开屏默认改回「实时」（用户 2026-10-29 定）；beta.4 / beta.5 存下的 bootVideo true 是当时的默认，换成 false（migrateSettings；早预加载见 prefsKeys.BOOT_LIVE_REV）.
 *  6: 新增 settings.pet（桌宠，docs/PET-PLAN.md §3）. 旧存档没有这一块：补默认值（全关），没有要改的旧值，migrateSettings 无事可做；
 *     存档里的 pet 块一律走 pickPet 逐字段校验，从萤火分出来时带过来的 pet 块（键位、名单、声音都是萤火的）丢掉. */
const SETTINGS_REV = 6;
/** Bumped when a tool's default policy becomes stricter.
 *  2: 抓取网页 asks first (fetched pages can carry injected instructions and a fetch can carry data out). */
const POLICY_REV = 2;
/** Bumped when the shape of an agent's saved tools changes.
 *  2: 每 Agent 的工具档（tiers）取代 tools 清单；旧存档的 tools 在 applyPrefs 里一次性迁成 tiers（不在清单里 → 黑档）. 本版仍双写 tools（D17）. */
const AGENTS_REV = 2;
/** 「记得小事」的上限（施工图 §3.9）：条数、每条字数. */
export const MEMORY_MAX_ITEMS = 20;
export const MEMORY_MAX_CHARS = 80;

/** 启动时：最近更新的这么多个任务读尾部 TAIL_BIG 条，其余读 TAIL_SMALL 条（至少 1 条——空消息会被当成新对话去打招呼；打开时再补到 TAIL_BIG）。
 *  聊天上下文取最近 30 条用户/助手消息（live.ts），所以 TAIL_BIG 要比 30 宽裕。 */
export const TAIL_BIG = 80;
export const TAIL_SMALL = 4;
const BIG_TASKS = 12;
/** 保存节流：一批改动最多等这么久。 */
const FLUSH_MS = 1000;
const RETRY_MS = 4000;

type Prefs = Pick<AppState, 'settings' | 'navCollapsed'> & {
  settingsRev?: number;
  policyRev?: number;
  agentsRev?: number;
  /** 记得小事 / 安静一小时（AppState 上的独立字段，施工图 §2.2）. */
  memory?: MemoryItem[];
  quietUntil?: number;
  console: Pick<AppState['console'], 'open' | 'height' | 'tab'>;
  tools: Array<{ id: string; permission: string }>;
  agents: Array<{ id: string; enabled: boolean; tools?: ToolId[]; tiers?: AgentTiers; engine?: AgentEngine }>;
  models?: Pick<AppState['models'], 'providers' | 'defaultEngine'>;
};

type Saved = Partial<Prefs> & Pick<AppState, 'tasks' | 'taskOrder' | 'runs' | 'events'> & { version: number; rev?: number };
type Loose = Record<string, unknown>;

/** 备忘的独立备份键：0.1.4 整份重写 prefs 时不认 memory，旧版不读也不写这个键，回滚再升回来时靠它找回. */
const MEMORY_KEY = 'alight/memory';
/** 桌宠设置的独立备份键（同上）：beta.6 整份重写 prefs 时不认 settings.pet，丢了音色 ID、名单、热键；它不读也不写这个键，升回来时（主存档里没有 pet 块）靠它找回. 读回来照样走 pickPet 校验. */
const PET_KEY = 'alight/pet';
function read<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : undefined;
  } catch { return undefined; }
}
function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, value: string) { try { localStorage.setItem(key, value); } catch { /* 存储被禁用：只在内存里继续 */ } }

/** Settings that exist and have the right kind of value; anything else (removed keys, garbage) is ignored.
 *  legacy = 偏好来自萤火：视觉模式要换成栖枝的名字. */
function pickSettings(raw: unknown, legacy = false): Partial<Settings> {
  const out: Loose = {};
  if (raw && typeof raw === 'object') {
    for (const [key, def] of Object.entries(DEFAULT_SETTINGS)) {
      // pet 是一整块对象：typeof 一样就放行，会把任何形状（萤火的旧块、手改坏的）原样带进来，所以单独走 pickPet.
      if (key === 'pet') continue;
      const v = (raw as Loose)[key];
      if (typeof v === typeof def && (!(key in ENUMS) || ENUMS[key].includes(v as string))) out[key] = v;
    }
    // 萤火的存档（legacy）里的 pet 块丢掉，用默认值：热键、名单、声音、实时陪玩的设置都是萤火那边的.
    const pet = (raw as Loose).pet;
    if (!legacy && pet && typeof pet === 'object' && !Array.isArray(pet)) out.pet = pickPet(pet);
    if (legacy) {
      const mode = themeOf((raw as Loose).mode, true);
      if (mode) out.mode = mode; else delete out.mode;
    }
  }
  return out as Partial<Settings>;
}

const ONE_OF = <T extends string | number>(v: unknown, allowed: readonly T[], def: T): T => (allowed.includes(v as T) ? v as T : def);
const NUM = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const STR = (v: unknown, def: string, max = 200) => (typeof v === 'string' ? v.slice(0, max) : def);
/** 一个语音模型 id（eleven_v4、speech-2.8-hd）；别的写法一律当作「推荐的那个」. */
const MODEL_ID = (v: unknown) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v) ? v : '');
const EXE_NAMES = (v: unknown) => (Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 200) : []);

/** 存下的模型选择：认得的才带上；不认得（或没选）就不要这个键，和 DEFAULT_PET 同样没有它. */
const engineField = <K extends 'vision' | 'web'>(key: K, raw: unknown): Partial<Record<K, AgentEngine>> => {
  const e = validEngine(raw);
  return (e ? { [key]: e } : {}) as Partial<Record<K, AgentEngine>>;
};

/** 每个语音服务各自的音色 ID. 旧存档只有一个 voiceId（属于当时选的那个服务）：迁进当前服务那一格；已经有 voiceIds 的以它为准. */
function voiceIdsOf(v: Loose, provider: PetVoiceProvider): PetVoiceIds {
  const ids = v.voiceIds && typeof v.voiceIds === 'object' && !Array.isArray(v.voiceIds) ? v.voiceIds as Loose : {};
  const out: PetVoiceIds = { elevenlabs: STR(ids.elevenlabs, '').trim(), minimax: STR(ids.minimax, '').trim(), edge: STR(ids.edge, '').trim() };
  if (!('voiceIds' in v) && typeof v.voiceId === 'string' && v.voiceId.trim()) out[provider] = STR(v.voiceId, '').trim();
  return out;
}

/** 桌宠设置：每个字段都对着默认值校验，旧存档、手改坏的存档、萤火的存档都弄不坏桌宠. 与 actions.setPet 的整理同口径（scripts/pet-brain-check.ts 对照着测）. */
export function pickPet(raw: unknown): PetSettings {
  const d = DEFAULT_PET;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Loose;
  const obj = (x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? x as Loose : {});
  const v = obj(r.voice);
  const vm = obj(v.models);
  const rt = obj(r.realtime);
  const provider = ONE_OF(v.provider, ['elevenlabs', 'minimax', 'edge'] as const, d.voice.provider);
  return {
    enabled: typeof r.enabled === 'boolean' ? r.enabled : d.enabled,
    scale: Math.round(NUM(r.scale, 0.6, 1.6, d.scale) * 100) / 100,
    watch: typeof r.watch === 'boolean' ? r.watch : d.watch,
    proactivity: ONE_OF(r.proactivity, ['off', 'low', 'normal', 'high'] as const, d.proactivity),
    cooldownSec: Math.round(NUM(r.cooldownSec, 60, 3600, d.cooldownSec)),
    imagesPerHour: Math.round(NUM(r.imagesPerHour, 0, 240, d.imagesPerHour)),
    ...engineField('vision', r.vision),
    ...engineField('web', r.web),
    voice: {
      enabled: typeof v.enabled === 'boolean' ? v.enabled : d.voice.enabled,
      provider,
      voiceIds: voiceIdsOf(v, provider),
      volume: Math.round(NUM(v.volume, 0, 100, d.voice.volume)),
      fallback: typeof v.fallback === 'boolean' ? v.fallback : d.voice.fallback,
      models: { elevenlabs: MODEL_ID(vm.elevenlabs), minimax: MODEL_ID(vm.minimax) },
    },
    realtime: {
      listen: ONE_OF(rt.listen, ['auto', 'key'] as const, d.realtime.listen),
      sensitivity: Math.round(NUM(rt.sensitivity, 0, 100, d.realtime.sensitivity)),
      fastVoice: typeof rt.fastVoice === 'boolean' ? rt.fastVoice : d.realtime.fastVoice,
      autoOffMin: Math.round(NUM(rt.autoOffMin, 5, 120, d.realtime.autoOffMin)),
    },
    hotkeyAsk: STR(r.hotkeyAsk, d.hotkeyAsk, 40).trim() || d.hotkeyAsk,
    hotkeyPause: STR(r.hotkeyPause, d.hotkeyPause, 40).trim() || d.hotkeyPause,
    neverWatch: EXE_NAMES(r.neverWatch),
    gameAllow: EXE_NAMES(r.gameAllow),
    gameDeny: EXE_NAMES(r.gameDeny),
    follow: typeof r.follow === 'boolean' ? r.follow : d.follow,
    fpsCap: ONE_OF(r.fpsCap, [30, 60] as const, d.fpsCap),
  };
}

/** 独立备份里的桌宠设置（没有、不是对象就是 undefined）；读出来逐字段校验. */
function backedUpPet(): PetSettings | undefined {
  const b = read<unknown>(PET_KEY);
  return b && typeof b === 'object' && !Array.isArray(b) ? pickPet(b) : undefined;
}

/** 取值有限的设置：存档里有别的字符串就当没存（用默认）. */
const ENUMS: Record<string, readonly string[]> = {
  level: ['s', 'm', 'l'],
  proactive: ['auto', 'on', 'off'],
  storyBox: ['off', 'chat', 'all'],
};

/**
 * 设置迁移（SETTINGS_REV 2 → 3，施工图 §2.1.3）：话量 distance/persona → level/persona，lifeNudge → proactive.
 * 读 **raw** `prefs.settings`，不读 pickSettings 的结果（pickSettings 以 DEFAULT_SETTINGS 为白名单，旧键一旦从默认里删掉就读不到）.
 * 两条加载路径都要调：loadState（localStorage 偏好）与库镜像恢复（applySnapshot，localStorage 被清时走这条）.
 * rev 3 的存档话量已是新口径，只做 3 → 4：剧情框存的 'off' 是 0.2.0-beta.1 的旧默认（它只发了一天，没人来得及选），换成新默认「闲聊」.
 * 4 → 5：bootVideo 存的 true 是 beta.4 / beta.5 的默认（存档整份写 settings，分不出是默认还是自己选的），换回新默认 false；rev 4 存的剧情框 'off' 是默认改了之后自己选的，不动.
 * 5 → 6：新增 settings.pet，没有旧口径可迁——旧存档里没有这一块，pickSettings 不返回它，emptyState 的默认值（全关）原样生效；这里什么也不用补.
 * rev >= 6 什么都不改（level、pet 等已由 pickSettings 读入）.
 * 「有效距离」口径与 selectors.effectiveDistance 一致：persona===false → 0，否则 distance（缺省 1）——
 * 因为 SideNav 的 setSetting('distance') 不同步 persona，存量里有 distance:1 + persona:false、distance:0 + persona:true 的组合，不能只看 distance.
 * eff=0 → persona=false、level='m'；eff=1 → persona 保持、level='m'；eff=2 → persona 保持、level='l'.
 * lifeGreeting：旧存档里是 false 的保持 false（用户没开过，不替他打开）；根本没存过的按旧默认 false（新装默认 true 只给新装）.
 */
export function migrateSettings(raw: unknown, rev: number): Partial<Settings> {
  // 没存过设置（全新安装）：没有「旧口径」可迁，新装默认原样生效.
  if (rev >= SETTINGS_REV || !raw || typeof raw !== 'object') return {};
  const r = raw as Loose;
  const out: Partial<Settings> = {};
  if (rev < 3) {
    const distance = typeof r.distance === 'number' && Number.isFinite(r.distance) ? r.distance : 1;
    const eff = r.persona === false ? 0 : distance;
    out.level = (eff >= 2 ? 'l' : 'm') as Level;
    out.proactive = r.lifeNudge === true ? 'on' : 'auto';
    out.lifeGreeting = typeof r.lifeGreeting === 'boolean' ? r.lifeGreeting : false;
    if (eff <= 0) out.persona = false;
  }
  if (rev < 4 && r.storyBox === 'off') out.storyBox = 'chat';
  if (rev < BOOT_LIVE_REV && r.bootVideo === true) out.bootVideo = false;
  return out;
}

/** An agent's saved model, if it still names a vendor, a way (`claude:cli`) and a known effort. */
function validEngine(raw: unknown): AgentEngine | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const { key, model, effort } = raw as Loose;
  if (typeof key !== 'string' || typeof model !== 'string') return undefined;
  const [provider, auth, ...rest] = key.split(':');
  if (!Object.hasOwn(PROVIDER_BY_ID, provider) || (auth !== 'api' && auth !== 'cli') || rest.length) return undefined;
  return { key, model, effort: typeof effort === 'string' && Object.hasOwn(EFFORT_LABEL, effort) ? effort as Effort : undefined };
}

const strip = (o: object, keys: string[]) => { for (const k of keys) delete (o as Loose)[k]; };

/** Saves from before the simulator was removed: keep what real models did, drop the 演示 tasks (they
 *  have no model) and everything they made, and remove fields that no longer exist. */
function dropDemoData(saved: Saved) {
  const real = new Set<string>();
  for (const [id, run] of Object.entries(saved.runs)) {
    if (saved.tasks[run.taskId] && (run as unknown as Loose).source === 'live') real.add(id);
    else delete saved.runs[id];
  }
  // A message is the user's own history when it was not made by the simulator — or belongs to a real
  // run (the old cancel notice was tagged simulated even on real runs).
  const kept = (m: Message) => (!(m as unknown as Loose).simulated || (!!m.runId && real.has(m.runId))) && !(m.runId && !real.has(m.runId));
  for (const [id, task] of Object.entries(saved.tasks)) {
    task.runIds = task.runIds.filter((runId) => real.has(runId));
    task.messages = task.messages.filter(kept);
    // Demo tasks have nothing real left. A real chat that was switched to 演示模式 keeps its history
    // (engine stays unset; the UI asks for a model).
    const own = task.messages.some((m) => m.role === 'user' || m.role === 'agent');
    if (!task.engine && !task.runIds.length && !own) { delete saved.tasks[id]; continue; }
    if (!task.engine && (task as unknown as Loose).source !== 'live' && !task.runIds.length && !task.messages.some((m) => (m as unknown as Loose).live)) { delete saved.tasks[id]; continue; }
    strip(task, ['scenarioId', 'source']);
    for (const m of task.messages) strip(m, ['simulated', 'live']);
  }
  for (const run of Object.values(saved.runs)) {
    strip(run, ['source', 'fixStepIndex']);
    strip(run.cursor, ['beat', 'beatElapsed', 'beatStarted']);
    for (const c of run.toolCalls) strip(c, ['simulated', 'expectedMs']);
    for (const a of run.artifacts) strip(a, ['simulated']);
  }
  saved.events = (saved.events ?? []).filter((e) => (!e.runId || real.has(e.runId)) && (e.kind as string) !== 'connection' && !e.text.includes('（模拟'));
}

/** 萤火的消息里 persona 是 firefly / sam，换成栖枝的 night / day（否则落在不认识的值上）. */
function renamePersonas(saved: Saved) {
  for (const task of Object.values(saved.tasks)) {
    for (const m of task.messages) {
      const p = themeOf((m as unknown as Loose).persona, true);
      if (p) m.persona = p; else delete m.persona;
    }
  }
}

/* ───────────── 模式与状态 ───────────── */

/** 'desktop'：任务在 SQLite 库里；'local'：整份存 localStorage（浏览器开发版，或库打不开）。 */
let mode: 'local' | 'desktop' = 'local';
/** idle：还没 loadState；booting：桌面版正在读库；ready：可以保存、可以补读. */
let phase: 'idle' | 'booting' | 'ready' = 'idle';
let bootStarted = false;
/** 数据目录刚换走：这个页面再往库里写，写进去的是别人的库（只带着增量，建出残缺的任务行）。冻结之后一切保存都是空操作，页面马上会重新载入. */
let frozen = false;
/** 还没迁移的旧 blob（loadState 读偏好时顺便读到的，boot 迁移时用，用完即丢）. */
let legacyPending: { key: string; blob: Saved } | undefined;
const waiters: Array<() => void> = [];

const syncer = new sb.Syncer();
/** 只读了摘要、还没取回工具调用/产物/终端的运行. */
const lean = new Set<string>();
const loadingRuns = new Map<string, Promise<void>>();
const toppingUp = new Map<string, Promise<void>>();

function release() {
  while (waiters.length) waiters.pop()!();
}

/** 存储就绪：桌面版读完库的尾部（失败则已退回本地存储）. 浏览器开发版立刻就绪. 最多等 timeoutMs. */
export function whenReady(timeoutMs = 3000): Promise<void> {
  if (phase === 'ready' || (phase === 'idle' && !sb.storeAvailable())) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, timeoutMs);
    waiters.push(() => { clearTimeout(t); resolve(); });
  });
}

export function persistMode(): { mode: 'local' | 'desktop'; ready: boolean } {
  return { mode, ready: phase === 'ready' || (phase === 'idle' && !sb.storeAvailable()) };
}

/* ───────────── 读取 ───────────── */

function readLegacy(): { key: string; blob: Saved } | undefined {
  for (const key of [KEY, LEGACY_KEY]) {
    const blob = read<Saved>(key);
    if (blob && blob.version === VERSION && blob.tasks && blob.runs) return { key, blob };
  }
  return undefined;
}

/** 把一份旧 blob 里的任务、运行、事件放进草稿（整份读入内存；只用于浏览器开发版与库打不开时）. */
function applySaved(d: Draft<AppState>, saved: Saved, now: number) {
  for (const [id, t] of Object.entries(saved.tasks)) if (!d.tasks[id]) d.tasks[id] = t;
  for (const [id, r] of Object.entries(saved.runs)) if (!d.runs[id]) d.runs[id] = r;
  const have = new Set(d.taskOrder);
  for (const id of saved.taskOrder) if (saved.tasks[id] && !have.has(id)) d.taskOrder.push(id);
  d.events = [...(saved.events ?? []), ...d.events];
  for (const run of Object.values(d.runs)) {
    if (run.status === 'running' || run.status === 'queued') {
      if (run.status === 'queued') run.status = 'running';
      pauseRun(d, run, 'reload', now);
    }
  }
  // Runs saved before the window became 1M.
  for (const run of Object.values(d.runs)) if (run.usage.contextLimit === 200_000) run.usage.contextLimit = 1_000_000;
  normalizeAfterLoad(d);
}

/** 偏好 → 草稿（settings 在 emptyState 里已经合并过；模型接入另算）. */
function applyPrefs(d: Draft<AppState>, prefs: Partial<Prefs>) {
  d.navCollapsed = !!prefs.navCollapsed;
  d.console.open = !!prefs.console?.open;
  d.console.height = prefs.console?.height ?? d.console.height;
  d.console.tab = prefs.console?.tab ?? d.console.tab;
  for (const t of prefs.tools ?? []) {
    const tool = d.tools.find((x) => x.id === t.id);
    if (!tool || !(t.permission === 'auto' || t.permission === 'confirm' || t.permission === 'off')) continue;
    // A tool whose default became stricter keeps an old 自动 only if it was saved after the change.
    if ((prefs.policyRev ?? 1) < 2 && t.id === 'web_fetch' && t.permission === 'auto') continue;
    tool.permission = t.permission;
  }
  const agentsRev = prefs.agentsRev ?? 1;
  for (const a of prefs.agents ?? []) {
    const agent = d.agents.find((x) => x.id === a.id);
    if (!agent) continue;
    agent.enabled = a.id === 'orchestrator' ? true : !!a.enabled;
    if (a.id === 'orchestrator') {
      // 编排 Agent 恒无覆盖（沿用全局档）；tools 只是旧版的垫片.
      if (Array.isArray(a.tools)) agent.tools = d.tools.map((t) => t.id).filter((id) => a.tools!.includes(id));
      agent.tiers = undefined;
    } else if (agentsRev >= 2) {
      // 新口径：tiers 就是真源（没有这个字段 = 用户把覆盖都清了，不是「没存过」，不能退回种子默认）.
      agent.tiers = validTiers(a.tiers);
      agent.tools = legacyToolsOf(agent);
    } else if (Array.isArray(a.tools)) {
      // 旧存档：tools 是「可用工具清单」，不在清单里 = 该 Agent 黑档；未知 id 丢弃，'other' 不动.
      agent.tiers = nonEmpty(migrateToolsToTiers(a.tools));
      agent.tools = legacyToolsOf(agent);
    }
    // 旧存档没存过 tools 的 Agent 用新种子默认（emptyState 已经放好了）.
    // The 编排 Agent always follows the task's model.
    agent.engine = a.id === 'orchestrator' ? undefined : validEngine(a.engine);
  }
  // 记得小事、安静一小时（施工图 §2.2）. 读不到合法值就用 emptyState 里的默认.
  // prefs 里没有 memory（回滚到 0.1.4 改过设置、整份 prefs 被它重写）→ 退回独立键 alight/memory：旧版不读也不写它.
  const mem = validMemory(prefs.memory) ?? validMemory(read<unknown>(MEMORY_KEY));
  if (mem) d.memory = mem;
  if (typeof prefs.quietUntil === 'number' && Number.isFinite(prefs.quietUntil) && prefs.quietUntil >= 0) d.quietUntil = prefs.quietUntil;
}

const TIER_TOOLS: readonly string[] = ['read_file', 'write_file', 'code_search', 'shell', 'web_search', 'web_fetch', 'git', 'browser_read', 'browser_act'];
const nonEmpty = (t: AgentTiers | undefined): AgentTiers | undefined => (t && Object.keys(t).length ? t : undefined);
/** 存档里的覆盖逐项校验：键 ∈ 可覆盖的工具，值 ∈ confirm | off；空了就是没有覆盖. */
function validTiers(raw: unknown): AgentTiers | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: AgentTiers = {};
  for (const [k, v] of Object.entries(raw as Loose)) if (TIER_TOOLS.includes(k) && (v === 'confirm' || v === 'off')) out[k as TierableToolId] = v;
  return nonEmpty(out);
}
/** 备忘逐条校验：id / text / at 要有，text 去空白后 1–80 字，最多 20 条. 不是数组 → undefined（用默认）. */
function validMemory(raw: unknown): MemoryItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: MemoryItem[] = [];
  for (const m of raw as Loose[]) {
    if (!m || typeof m !== 'object' || typeof m.id !== 'string' || typeof m.text !== 'string' || typeof m.at !== 'number') continue;
    // 与 actions.addMemory 同口径：按码点（Array.from）算字数；读档时超长宁可截断，也不整条丢掉用户亲手写的话.
    let text = m.text.trim();
    const cps = Array.from(text);
    if (cps.length > MEMORY_MAX_CHARS) text = cps.slice(0, MEMORY_MAX_CHARS).join('').trim();
    if (!text) continue;
    out.push({ id: m.id, text, at: m.at, ...(typeof m.taskId === 'string' && m.taskId ? { taskId: m.taskId } : {}) });
    if (out.length >= MEMORY_MAX_ITEMS) break;
  }
  return out;
}

/** 启动时同步读到的状态：偏好、模型接入、上次看到你的时间. 桌面版任务稍后由 boot() 异步读尾部补进来. */
export function loadState(now: number): AppState {
  const viaDb = sb.storeAvailable();
  const migrated = !!lsGet(MIGRATED_KEY);
  // 任务已经在库里（或马上要迁进库）就不再把整份旧 blob 读进内存：只在还没迁移、又要拿偏好时读一次.
  const legacy = viaDb && migrated ? undefined : readLegacy();
  const own = read<Prefs>(PREFS_KEY);
  const firefly = own ? undefined : read<Prefs>(LEGACY_PREFS_KEY);
  const prefs: Partial<Prefs> = own ?? firefly ?? legacy?.blob ?? {};
  const fromFirefly = !own && (!!firefly || legacy?.key === LEGACY_KEY);
  // 浏览器开发版：旧 blob 就是任务本体，按萤火的老办法整份读入.
  const saved = !viaDb && legacy ? legacy.blob : undefined;
  if (saved) {
    if (legacy!.key === LEGACY_KEY) renamePersonas(saved);
    if ((saved.rev ?? 1) < DATA_REV) dropDemoData(saved);
  }
  const models = restoreModels(prefs.models);

  const savedSettings = pickSettings(prefs.settings, fromFirefly);
  if ((prefs.settingsRev ?? 1) < 2) {
    savedSettings.wallpaperVisibility = DEFAULT_SETTINGS.wallpaperVisibility;
    savedSettings.panelGlass = DEFAULT_SETTINGS.panelGlass;
  }
  Object.assign(savedSettings, migrateSettings(prefs.settings, prefs.settingsRev ?? 1));
  // 主存档里没有（可用的）pet 块——回滚到 beta.6 再升回来时它被丢了——就用独立备份，照样逐字段校验.
  if (!savedSettings.pet) { const b = backedUpPet(); if (b) savedSettings.pet = b; }
  const base = emptyState(now, { ...DEFAULT_SETTINGS, ...savedSettings });
  const state = produce(base, (d) => {
    if (saved) applySaved(d, saved, now);
    d.models = models;
    applyPrefs(d, prefs);
    if (previousSeen) d.lastSeen = previousSeen;
    syncPersonaAgent(d);
  });

  if (viaDb) {
    mode = 'desktop';
    legacyPending = legacy;
    lastPrefs = prefsJson(state);
    if (!bootStarted) {
      bootStarted = true;
      phase = 'booting';
      // 等 main.tsx 把状态放进 store 再读库.
      setTimeout(() => { void boot(); }, 0);
    }
  } else {
    mode = 'local';
    lastPrefs = prefsJson(state);
    if (typeof window !== 'undefined') setTimeout(startServices, 0);
  }
  return state;
}

/* ───────────── 桌面版：启动读库 ───────────── */

let servicesStarted = false;
/** 用量同步、「离开又回来」、可见性保存——桌面版读完库后、浏览器开发版加载后都要开. */
function startServices() {
  if (servicesStarted || typeof window === 'undefined') return;
  servicesStarted = true;
  startUsageSync();
  startPresence(() => store.get().settings.returnAfterMin ?? 30, (leftAt) => store.update((d) => { d.lastSeen = leftAt; }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSave(); });
}

async function boot() {
  try {
    const st = await sb.getStatus(true);
    if (!st.ok) return fallback(`打不开数据库：${st.error}`);
    if (st.status.warning) store.update((d) => toast(d, { tone: 'warning', title: '数据目录暂时用不了', body: st.status.warning, key: 'store-dir', ttl: 0 }));
    if (!st.status.legacy) {
      const err = await migrate();
      if (err) return fallback(err);
    } else if (!lsGet(MIGRATED_KEY)) {
      lsSet(MIGRATED_KEY, JSON.stringify({ at: st.status.legacy.at, from: st.status.legacy.from, counts: st.status.legacy.counts }));
    }
    const snap = await sb.loadSnapshot({ tailBig: TAIL_BIG, tailSmall: TAIL_SMALL, bigTasks: BIG_TASKS });
    if (!snap.ok) return fallback(`读不了数据库：${snap.error}`);
    applySnapshot(snap.snapshot);
    reconcileFallback(snap.snapshot);
    legacyPending = undefined;
    startServices();
    store.subscribe(onStoreChange);
    onStoreChange();
    if (latest) schedule(300);
    release();
  } catch (e) {
    fallback(`读库时出错：${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 一次性迁移：把 localStorage 里的旧任务整份送进库（只读不删），成功后打标记. 返回错误说明或 undefined. */
async function migrate(): Promise<string | undefined> {
  // 这台电脑已经迁过一次（比如后来换了数据目录、或删了库重新开始）：不再把旧 localStorage 里的任务翻出来，免得删掉的任务复活.
  if (lsGet(MIGRATED_KEY)) {
    await sb.markLegacyNone('already-migrated');
    return undefined;
  }
  const legacy = legacyPending ?? readLegacy();
  if (!legacy) {
    await sb.markLegacyNone('none');
    return undefined;
  }
  const { key, blob } = legacy;
  if (key === LEGACY_KEY) renamePersonas(blob);
  if ((blob.rev ?? 1) < DATA_REV) dropDemoData(blob);
  const r = await sb.importLegacy({ tasks: blob.tasks, taskOrder: blob.taskOrder, runs: blob.runs, events: blob.events ?? [] }, key);
  if (!r.ok) return `旧数据没能迁进数据库：${r.error}`;
  lsSet(MIGRATED_KEY, JSON.stringify({ at: Date.now(), from: key, counts: r.counts }));
  return undefined;
}

/** 库用不了：整份退回 localStorage（旧逻辑），并明说. */
function fallback(reason: string) {
  mode = 'local';
  const legacy = legacyPending ?? readLegacy();
  legacyPending = undefined;
  const now = Date.now();
  phase = 'ready';
  // 已经迁进过库的用户：localStorage 里的旧 blob 是迁移前的陈年快照，库恢复后不会再被迁移（MIGRATED_KEY 挡着，防止删掉的任务复活）。
  // 记下退回的时刻（只记最早的一次），恢复后才知道哪些任务 / 消息是退回期间新写的，只把这些补进库.
  const migrated = !!lsGet(MIGRATED_KEY);
  if (migrated && !Number(lsGet(FALLBACK_KEY))) lsSet(FALLBACK_KEY, String(now));
  store.update((d) => {
    if (legacy) {
      if (legacy.key === LEGACY_KEY) renamePersonas(legacy.blob);
      if ((legacy.blob.rev ?? 1) < DATA_REV) dropDemoData(legacy.blob);
      applySaved(d, legacy.blob, now);
    }
    toast(d, { tone: 'warning', title: '这次先存在浏览器存储里', body: migrated
        ? `${reason}。现在看到的是迁移前保存的旧记录（库里较新的内容暂时看不到）；这段时间新建的任务和新写的消息会保存在浏览器存储里，数据库恢复后补进库。`
        : `${reason}。任务记录暂时保存在本机的浏览器存储中，数据库恢复后会再迁移。`, key: 'store-fallback', ttl: 0 });
  });
  startServices();
  release();
}

/**
 * 上一次启动退回过 localStorage、这次库又好了：把退回期间新建的任务（连同它们的运行）和旧任务上新写的消息补进库。
 * 只补「库里没有的」：任务看 createdAt 是否不早于退回的时刻（更早又不在库里的，是迁移后在库里删掉的，不能复活）；
 * 消息看 at 是否不早于退回的时刻。不碰库里已有的任何东西（不是 importLegacy 那种 upsert，那会拿陈旧版本盖掉库里较新的同 id 任务）.
 * 补进来的东西不登记成「已存」，Syncer 的下一次 diff 会把它们当作新实体写进库.
 */
function reconcileFallback(snap: sb.Snapshot) {
  const since = Number(lsGet(FALLBACK_KEY));
  if (!Number.isFinite(since) || since <= 0) return;
  const legacy = readLegacy();
  if (legacy) {
    const now = Date.now();
    const inDb = new Set(snap.tasks.map((t) => t.id));
    const runsInDb = new Set(snap.runs.map((r) => r.id));
    const blob = legacy.blob;
    store.update((d) => {
      const added: string[] = [];
      for (const [id, t] of Object.entries(blob.tasks)) {
        if (!inDb.has(id)) {
          if ((t.createdAt ?? 0) < since || d.tasks[id]) continue;
          d.tasks[id] = t;
          if (!d.taskOrder.includes(id)) d.taskOrder.unshift(id);
          for (const runId of t.runIds) { const r = blob.runs[runId]; if (r && !runsInDb.has(runId) && !d.runs[runId]) { d.runs[runId] = r; added.push(runId); } }
          continue;
        }
        const cur = d.tasks[id];
        if (!cur) continue;
        const have = new Set(cur.messages.map((m) => m.id));
        const fresh = t.messages.filter((m) => m.at >= since && !have.has(m.id));
        if (fresh.length) { cur.messages.push(...fresh); cur.updatedAt = Math.max(cur.updatedAt, t.updatedAt); }
        for (const runId of t.runIds) {
          const r = blob.runs[runId];
          if (!r || runsInDb.has(runId) || d.runs[runId] || r.createdAt < since) continue;
          d.runs[runId] = r;
          if (!cur.runIds.includes(runId)) cur.runIds.push(runId);
          added.push(runId);
        }
      }
      // 补进来的运行：当时没有收尾的（还在跑 / 等待），和读库一样置为暂停
      for (const runId of added) {
        const run = d.runs[runId];
        if (run && (run.status === 'running' || run.status === 'queued')) { if (run.status === 'queued') run.status = 'running'; pauseRun(d, run, 'reload', now); }
      }
      normalizeAfterLoad(d, now);
    });
  }
  lsSet(FALLBACK_KEY, '');
}

function applySnapshot(snap: sb.Snapshot) {
  const now = Date.now();
  // 这些刚从库里读出来，已经在库里了：登记成「已存」，只有读后整理改过的才会被写回.
  syncer.adopt({ tasks: snap.tasks, runs: snap.runs, events: snap.events, order: snap.taskOrder });
  lean.clear();
  for (const id of snap.lean) lean.add(id);

  // 读后整理（暂停进行中的运行、取消半截的调用、过期的审批…）在临时状态里做，只作用于刚读进来的这些.
  // （任务和运行要放在 base 里而不是在 recipe 里赋值：赋给草稿的新对象不会被代理，后面的改动会就地改写读进来的原对象，
  //   Syncer 登记的「已存版本」就跟着变了，改动再也送不出去。）
  const base: AppState = { ...emptyState(now), tasks: Object.fromEntries(snap.tasks.map((t) => [t.id, t])), runs: Object.fromEntries(snap.runs.map((r) => [r.id, r])) };
  const tmp = produce(base, (d) => {
    for (const run of Object.values(d.runs)) {
      if (run.status === 'running' || run.status === 'queued') {
        if (run.status === 'queued') run.status = 'running';
        pauseRun(d, run, 'reload', now);
      }
      if (run.usage.contextLimit === 200_000) run.usage.contextLimit = 1_000_000;
    }
    normalizeAfterLoad(d);
  });

  const dbPrefs = snap.prefs && !lsGet(PREFS_KEY) ? safeParse<Partial<Prefs>>(snap.prefs) : undefined;
  // 先标成就绪再提交：订阅者（左栏的「待你」、角标）在这次提交里就能看到「库已读完」.
  phase = 'ready';
  store.update((d) => {
    // 启动到现在这一小会儿里用户可能已经新建了任务：它们排在前面，读到的接在后面.
    for (const [id, t] of Object.entries(tmp.tasks)) if (!d.tasks[id]) d.tasks[id] = t as Task;
    for (const [id, r] of Object.entries(tmp.runs)) if (!d.runs[id]) d.runs[id] = r as Run;
    const have = new Set(d.taskOrder);
    for (const id of snap.taskOrder) if (tmp.tasks[id] && !have.has(id)) d.taskOrder.push(id);
    d.events = [...snap.events, ...tmp.events, ...d.events].slice(-EVENT_CAP);
    if (dbPrefs) {
      Object.assign(d.settings, pickSettings(dbPrefs.settings));
      Object.assign(d.settings, migrateSettings(dbPrefs.settings, dbPrefs.settingsRev ?? 1));
      if (!pickSettings(dbPrefs.settings).pet) { const b = backedUpPet(); if (b) d.settings.pet = b; }
      applyPrefs(d, dbPrefs);
      const m = restoreModels(dbPrefs.models);
      d.models.providers = m.providers;
      d.models.defaultEngine = m.defaultEngine;
    }
    syncPersonaAgent(d);
  });
}

function safeParse<T>(s: string): T | undefined {
  try { return JSON.parse(s) as T; } catch { return undefined; }
}

/* ───────────── 桌面版：按需补读 ───────────── */

/** 补足一个任务的尾部到 TAIL_BIG 条（启动时只读了少量；聊天上下文要用最近 30 条）. */
export function ensureTail(taskId: string): Promise<void> {
  if (mode !== 'desktop' || phase !== 'ready') return Promise.resolve();
  const running = toppingUp.get(taskId);
  if (running) return running;
  const t = store.get().tasks[taskId];
  const p = sb.pagingOf(taskId);
  if (!t || !p || p.loaded >= p.total || p.oldestSeq <= 0 || t.messages.length >= TAIL_BIG) return Promise.resolve();
  const job = (async () => {
    const r = await sb.pageMessages({ taskId, beforeSeq: p.oldestSeq, limit: TAIL_BIG - t.messages.length, withCalls: false });
    if (!r.ok || !r.messages.length) return;
    syncer.adoptMessages(taskId, r.messages);
    sb.notePaging(taskId, { total: p.total, oldestSeq: r.oldestSeq, loaded: p.loaded + r.messages.length });
    store.update((d) => {
      const task = d.tasks[taskId];
      if (!task) return;
      const have = new Set(task.messages.map((m) => m.id));
      task.messages = [...r.messages.filter((m) => !have.has(m.id)), ...task.messages];
    });
  })().finally(() => { toppingUp.delete(taskId); });
  toppingUp.set(taskId, job);
  return job;
}

/** 取回一个运行的工具调用（大输出只有摘要）、产物、终端最后 2000 行，并入状态（不会写回库）. */
export function ensureRunLoaded(runId: string): Promise<void> {
  if (mode !== 'desktop' || phase !== 'ready' || !lean.has(runId)) return Promise.resolve();
  const running = loadingRuns.get(runId);
  if (running) return running;
  const job = (async () => {
    const r = await sb.loadRunDetail(runId);
    if (!r.ok) return;
    lean.delete(runId);
    syncer.adoptRunParts(runId, r);
    store.update((d) => {
      const run = d.runs[runId];
      if (!run) return;
      // 取回的在前；页面这段时间自己新增或更新过的（同 id 以页面为准）接在后面.
      const mine = new Map(run.toolCalls.map((c) => [c.id, c]));
      const got = new Set(r.toolCalls.map((c) => c.id));
      run.toolCalls = [...r.toolCalls.map((c) => mine.get(c.id) ?? c), ...run.toolCalls.filter((c) => !got.has(c.id))];
      const myArts = new Map(run.artifacts.map((a) => [a.id, a]));
      const gotArts = new Set(r.artifacts.map((a) => a.id));
      run.artifacts = [...r.artifacts.map((a) => myArts.get(a.id) ?? a), ...run.artifacts.filter((a) => !gotArts.has(a.id))];
      const gotLines = new Set(r.terminal.map((l) => l.id));
      run.terminal = [...r.terminal, ...run.terminal.filter((l) => !gotLines.has(l.id))];
    });
  })().finally(() => { loadingRuns.delete(runId); });
  loadingRuns.set(runId, job);
  return job;
}

let lastSelection = '';
/** 选中的任务/运行变了：补足尾部、取回当前运行. 订阅 store，很便宜. */
function onStoreChange() {
  const s = store.get();
  const t = s.selectedTaskId ? s.tasks[s.selectedTaskId] : undefined;
  const key = t ? `${t.id}|${s.selectedRunId ?? ''}|${t.runIds.length}` : '';
  if (key === lastSelection) return;
  lastSelection = key;
  if (!t) return;
  void ensureTail(t.id);
  const runId = s.selectedRunId && t.runIds.includes(s.selectedRunId) ? s.selectedRunId : t.runIds[t.runIds.length - 1];
  if (runId) void ensureRunLoaded(runId);
}

/* ───────────── 保存 ───────────── */

let timer: number | undefined;
let latest: AppState | undefined;
let warned = false;
let lastPrefs = '';
let inflight: Promise<void> | undefined;
let again = false;
let failures = 0;
/** 浏览器存储模式：有还没写的改动. */
let dirtyLocal = false;

const cut = (v: unknown, max: number) => (typeof v === 'string' && v.length > max ? `${v.slice(0, max)}\n…（保存时截断）` : v);

/** A run as it is stored in localStorage: long tool inputs and outputs are cut; `lean` also drops the bulky parts. */
function slim(run: Run, leanMode: boolean): Run {
  return {
    ...run,
    terminal: leanMode ? [] : run.terminal,
    toolCalls: run.toolCalls.map((c) => ({
      ...c,
      input: Object.fromEntries(Object.entries(c.input ?? {}).map(([k, v]) => [k, cut(v, leanMode ? 500 : 4000)])),
      output: cut(c.output, leanMode ? 500 : 4000) as string | undefined,
    })),
    artifacts: leanMode ? run.artifacts.map((a) => ({ ...a, content: cut(a.content, 2000) as string })) : run.artifacts,
    plan: leanMode ? run.plan.map((st) => ({ ...st, result: cut(st.result, 4000) as string | undefined })) : run.plan,
  };
}

function prefsJson(s: AppState): string {
  const prefs: Prefs = {
    settingsRev: SETTINGS_REV,
    policyRev: POLICY_REV,
    agentsRev: AGENTS_REV,
    settings: s.settings,
    memory: s.memory,
    quietUntil: s.quietUntil,
    navCollapsed: s.navCollapsed,
    console: { open: s.console.open, height: s.console.height, tab: s.console.tab },
    tools: s.tools.map((t) => ({ id: t.id, permission: t.permission })),
    // tiers 是真源；tools 是 0.1.4 能读的等效清单（D17，本版双写、下版删）：只保证「在不在清单里」，不保证档位.
    agents: s.agents.map((a) => ({ id: a.id, enabled: a.enabled, tiers: a.id === 'orchestrator' ? undefined : a.tiers, tools: legacyToolsOf(a), engine: a.engine })),
    models: {
      // Never the key itself (it is not in the page); not even its hint, which is re-read from the desktop.
      providers: Object.fromEntries(Object.entries(s.models.providers).map(([id, c]) => [id, { ...c, keyHint: undefined }])) as AppState['models']['providers'],
      defaultEngine: s.models.defaultEngine,
    },
  };
  return JSON.stringify(prefs);
}

/** 偏好写 localStorage（启动要同步拿到）；没变就不写. 返回是否变了. */
function writePrefs(s: AppState): { json: string; changed: boolean } {
  const json = prefsJson(s);
  if (json === lastPrefs) return { json, changed: false };
  lsSet(PREFS_KEY, json);
  lsSet(MEMORY_KEY, JSON.stringify(s.memory));
  lsSet(PET_KEY, JSON.stringify(s.settings.pet));
  return { json, changed: true };
}

/** localStorage 整份保存（浏览器开发版，或库打不开时）. */
function writeLocal() {
  timer = undefined;
  dirtyLocal = false;
  const s = latest;
  if (!s) return;
  const p = writePrefs(s);
  lastPrefs = p.json;

  // Newest runs keep their detail; when the quota is hit, older runs are slimmed first, then everything.
  const order = Object.values(s.runs).sort((a, b) => (b.startedAt ?? b.createdAt) - (a.startedAt ?? a.createdAt));
  const attempt = (leanFrom: number) => {
    const runs: Record<string, Run> = {};
    order.forEach((r, i) => { runs[r.id] = slim(r, i >= leanFrom); });
    const saved: Saved = { version: VERSION, rev: DATA_REV, tasks: s.tasks, taskOrder: s.taskOrder, runs, events: s.events.slice(-200) };
    localStorage.setItem(KEY, JSON.stringify(saved));
  };
  for (const leanFrom of [Infinity, 10, 3, 0]) {
    try { attempt(leanFrom); return; } catch (e) {
      if (!(e instanceof DOMException) || !/quota/i.test(`${e.name} ${e.message}`)) return; // blocked, not full
    }
  }
  if (!warned) {
    warned = true;
    store.update((d) => toast(d, { tone: 'warning', title: '本地存储已满', key: 'storage-full',
      body: '任务记录太多，最新的改动没能保存。设置和模型接入不受影响；可以删除一些旧任务腾出空间。' }));
  }
}

/** 把和库里不一样的部分送过去（每次一批；上一批没回来就排队）. urgent：页面要关了，不排队直接发. */
function flushDb(urgent = false): Promise<void> {
  if (frozen) return Promise.resolve();
  if (inflight && !urgent) { again = true; return inflight; }
  const job = (async () => {
    try {
      const s = latest ?? store.get();
      const p = writePrefs(s);
      const d = syncer.diff(s);
      if (!d && !p.changed) return;
      const batch = d?.batch ?? {};
      if (p.changed) batch.prefs = p.json;
      const r = await sb.saveBatch(batch);
      if (r.ok) {
        d?.commit();
        lastPrefs = p.json;
        failures = 0;
        if (r.skipped) console.warn(`存储：${r.skipped} 条没写进去`, r.errors);
      } else {
        failures += 1;
        if (failures === 3) store.update((x) => toast(x, { tone: 'danger', title: '没能保存到数据库', body: `${r.error}。会继续重试；最近的改动暂时只在内存里。`, key: 'store-save', ttl: 0 }));
        schedule(RETRY_MS);
      }
    } catch (e) {
      console.error('存储：保存出错', e);
      schedule(RETRY_MS);
    }
  })();
  if (!urgent) inflight = job;
  return job.finally(() => {
    if (inflight === job) {
      inflight = undefined;
      if (again) { again = false; schedule(250); }
    }
  });
}

function schedule(ms = FLUSH_MS) {
  if (frozen || timer !== undefined || typeof window === 'undefined') return;
  timer = window.setTimeout(() => {
    timer = undefined;
    if (mode === 'desktop') void flushDb(); else writeLocal();
  }, ms);
}

/** Throttled save; only fields worth keeping trigger it. */
export function saveSoon(next: AppState, prev: AppState) {
  if (frozen) return;
  if (next.tasks === prev.tasks && next.runs === prev.runs && next.settings === prev.settings && next.tools === prev.tools
    && next.agents === prev.agents && next.console === prev.console && next.navCollapsed === prev.navCollapsed && next.taskOrder === prev.taskOrder
    && next.models === prev.models && next.events === prev.events
    && next.memory === prev.memory && next.quietUntil === prev.quietUntil) return;
  latest = next;
  if (mode === 'desktop' && phase !== 'ready') return; // 读库期间先记着，读完立刻排一次保存
  if (mode === 'local') dirtyLocal = true;
  schedule();
}

/** 页面要关了（pagehide）或藏起来了：立刻存. 不等结果. */
export function flushSave() {
  if (frozen) return;
  if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
  if (mode === 'desktop') {
    if (phase === 'ready') void flushDb(true);
    else if (latest) writePrefs(latest);
    return;
  }
  if (latest && dirtyLocal) writeLocal();
}

/** 存完再返回（换数据目录、备份之前用）. */
export async function flushSaveAsync(): Promise<void> {
  if (frozen) return;
  if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
  if (mode !== 'desktop' || phase !== 'ready') { if (latest && dirtyLocal) writeLocal(); return; }
  if (inflight) await inflight;
  await flushDb(true);
}

/** 数据目录切换成功之后立刻调：不再往库里写任何东西（页面随后重新载入，重新读新位置的库）. */
export function freezeWrites() {
  frozen = true;
  if (timer !== undefined) { window.clearTimeout(timer); timer = undefined; }
}

/** 测试用：丢掉模块内部状态. */
export function __resetForTests() {
  frozen = false;
  mode = 'local'; phase = 'idle'; bootStarted = false; legacyPending = undefined; lean.clear(); loadingRuns.clear(); toppingUp.clear();
  timer = undefined; latest = undefined; inflight = undefined; again = false; failures = 0; dirtyLocal = false; warned = false; lastPrefs = ''; lastSelection = ''; servicesStarted = false;
  syncer.forgetAll();
}
