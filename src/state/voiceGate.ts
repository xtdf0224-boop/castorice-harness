/* 话语总闸（施工图 §3.6a，R-CI I-25 / I-22 / I-16）：所有说话入口都调它，全文只有这一个入口.
   规则 G1–G11 见 voiceGate() 里的逐条标注；记账靠 noteSpoken / noteDismiss / noteAccepted / noteCrisis；
   状态存 localStorage `alight/voicegate`（纯观看偏好；读失败按「已说满」处理，只会更保守地少说话），
   I-22 的 sessionCap 只放模块内存，不落盘（8 小时后回落）.

   几处对施工图的澄清（都在 notes 里报告了）：
   · G1 对 kind==='lead'（审批卡 / 报错卡外那一句）：退后原因若正是它自己要说的事（approval / question / plan / failed），不降成 min——
     否则每一句 approve.ask 都出现在「审批待批」的退后状态里，会被永远压成最短句；ime / quiet 照常压.
   · G9 的「每满 2 小时 ≤1」与「本连续使用期不再提」同时实现：前者防跨段重复，后者防同段重复.
   · 「出现后 5 分钟内既没点按钮也没停下」= 记账后 5 分钟（proactive.ts 在她开口时排的一次性定时器调 settleIgnored），仍有输入且没有点任何按钮.
     「有反应」= 点关闭 / 退出项（noteDismiss）、点「去歇一会儿」（noteAccepted）、或在对话里发了话（noteRestReaction）；任何一种都清掉 pendingAt.
     settleIgnored 在 G9 里那一次调用排在 too-soon 之后，到那里早已过了 30 分钟窗口，只负责清掉陈旧的 pendingAt，不会累加；累加全靠那个定时器. */
import { useSyncExternalStore } from 'react';
import { continuousSince, lastInputAt } from '../lib/presence';
import type { AppState, Level, Settings } from '../lib/types';
import type { RetreatWhy } from './selectors';

/** 功能话：回用户、事件通知（待你 / 完成 / 失败）、卡外那一句 —— 不计预算. */
export type GateKind = 'reply' | 'event' | 'lead'
  /** 非功能话. */
  | 'proactive' | 'greet' | 'aside'
  /** 安全类：预算拦不住，只会降级. */
  | 'rest' | 'late';

/** her = 以她的口吻说；min = 最短中性句；line = 只出一行系统行，无角色话；chip = 只在右栏状态牌亮标记；silent = 什么都不出. */
export type GateMode = 'her' | 'min' | 'line' | 'chip' | 'silent';

/** 只读快照（§3.6a）。selectors.makeGateSnap() 从 store 拼；测试直接手写. */
export interface GateSnap {
  /** 请求的档位（调用方想用的话量）. */
  level: Level;
  persona: boolean;
  proactive: Settings['proactive'];
  lifeGreeting: boolean;
  quietUntil: number;
  /** 「她退半步」状态（审批 / 提问 / 待批计划 / 失败 / 输入法）. */
  retreated: boolean;
  composing: boolean;
  /** 前台闲聊任务. */
  taskId?: string;
  hasDraft: boolean;
  /** 连续使用分钟数（presence）. */
  continuousMinutes: number;
  /* 以下为 V2 追加的可选字段 */
  /** 退后原因（lead 判断用）. */
  retreatWhy?: RetreatWhy;
  /** 前台任务里已有一条未被回应的非功能话（G7）. */
  unanswered?: boolean;
  /** 这一段连续使用的起点（缺省 now − continuousMinutes）. */
  continuousSince?: number;
}

export interface GateResult { ok: boolean; mode: GateMode; level: Level; why?: string }

/* ───────────── 常量 ───────────── */

/** G5 每小时预算（非功能话，不含 rest/late）. */
export const HOURLY_BUDGET: Record<Level, number> = { s: 4, m: 10, l: 20 };
/** 今天最多主动搭话几次 / 每个任务本会话几次（§3.6b）. */
export const NUDGE_DAY_CAP = 3;
export const NUDGE_SESSION_CAP = 2;
/** G9：连续使用多久才触发休息关照 / 很晚；每满多久最多一次；出现后多久没反应算被忽略. */
export const REST_AFTER_MIN = 120;
export const REST_EVERY_MS = 120 * 60_000;
export const REST_IGNORE_MS = 5 * 60_000;
/** G8：3 秒内连关两次；sessionCap 8 小时后回落. */
export const DISMISS_PAIR_MS = 3000;
export const SESSION_CAP_TTL_MS = 8 * 3_600_000;
const SKIP_ALL = 99;
const STORE_KEY = 'alight/voicegate';

const LEVELS: Level[] = ['s', 'm', 'l'];
const downLevel = (l: Level, n = 1): Level => LEVELS[Math.max(0, LEVELS.indexOf(l) - n)];
const FUNCTIONAL: ReadonlySet<GateKind> = new Set<GateKind>(['reply', 'event', 'lead']);
const SAFETY: ReadonlySet<GateKind> = new Set<GateKind>(['rest', 'late']);
const isRestScene = (scene: string) => /^(nudge\.rest|late(\.|$)|sys\.(rest|late))/.test(scene);

/* ───────────── 状态 ───────────── */

interface RestState {
  /** 「今天别再提醒」生效的那个夜晚 / 白天键，以及点的那一天（整天都不再提）. */
  dismissedKey: string;
  dismissedDay: string;
  /** 上一次开口的夜晚 / 白天键（夜里每晚 ≤1）. */
  spokeKey: string;
  lastAt: number;
  /** 开口时那一段连续使用的起点（本连续使用期不再提）. */
  contSince: number;
  /** 开口后还没人反应的时刻；0 = 没有. */
  pendingAt: number;
  ignoredStreak: number;
}
interface GateState {
  day: string;
  proactive: { count: number; lastAt: number; unanswered: Record<string, true>; session: Record<string, number> };
  hourly: number[];
  sameScene: Record<string, number>;
  rest: RestState;
  crisisDay: string;
  /** 今天点过「今天别再说」. */
  enough: boolean;
  /** 今天已按时辰问候过. */
  greetDay: string;
}

const fresh = (): GateState => ({
  day: '',
  proactive: { count: 0, lastAt: 0, unanswered: {}, session: {} },
  hourly: [],
  sameScene: {},
  rest: { dismissedKey: '', dismissedDay: '', spokeKey: '', lastAt: 0, contSince: 0, pendingAt: 0, ignoredStreak: 0 },
  crisisDay: '',
  enough: false,
  greetDay: '',
});

/** 读不到（存储不可用 / 损坏）时按「已说满」：主动话今天用完、预算用满；安全类不受影响. */
function saturated(now: number): GateState {
  const s = fresh();
  s.day = dayKey(now);
  s.proactive.count = NUDGE_DAY_CAP;
  s.hourly = Array.from({ length: HOURLY_BUDGET.l }, () => now);
  s.greetDay = s.day;
  return s;
}

export interface GateStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
let storageOverride: GateStorage | null | undefined;
let mem: GateState | undefined;
let loadFailed = false;
/** I-22 的本会话降档（只在内存）. */
let sessionDrop = 0;
let sessionDropAt = 0;
let lastXAt = 0;

function backing(): GateStorage | undefined {
  if (storageOverride !== undefined) return storageOverride ?? undefined;
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
function rec<T>(v: unknown, pick: (x: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {};
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) { const y = pick(x); if (y !== undefined) out[k] = y; }
  return out;
}

function parse(raw: string): GateState | undefined {
  try {
    const o = JSON.parse(raw) as Record<string, any>;
    if (!o || typeof o !== 'object') return undefined;
    const p = o.proactive ?? {}; const r = o.rest ?? {};
    return {
      day: str(o.day),
      proactive: {
        count: num(p.count), lastAt: num(p.lastAt),
        unanswered: rec(p.unanswered, (x) => (x ? (true as const) : undefined)),
        session: rec(p.session, (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)),
      },
      hourly: Array.isArray(o.hourly) ? o.hourly.filter((x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)).slice(-60) : [],
      sameScene: rec(o.sameScene, (x) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)),
      rest: {
        dismissedKey: str(r.dismissedKey), dismissedDay: str(r.dismissedDay), spokeKey: str(r.spokeKey), lastAt: num(r.lastAt), contSince: num(r.contSince),
        pendingAt: num(r.pendingAt), ignoredStreak: num(r.ignoredStreak),
      },
      crisisDay: str(o.crisisDay),
      enough: !!o.enough,
      greetDay: str(o.greetDay),
    };
  } catch { return undefined; }
}

function load(now: number): GateState {
  const st = backing();
  if (!st) { loadFailed = true; return saturated(now); }
  let raw: string | null;
  try { raw = st.getItem(STORE_KEY); } catch { loadFailed = true; return saturated(now); }
  if (raw === null) return fresh();                      // 第一次：没有记录 = 一切从零开始
  const s = parse(raw);
  if (!s) { loadFailed = true; return saturated(now); }
  return s;
}

function save() {
  if (!mem) return;
  const st = backing();
  if (!st) return;
  try { st.setItem(STORE_KEY, JSON.stringify(mem)); } catch { /* 存不了就只在内存里 */ }
}

const pad = (n: number) => String(n).padStart(2, '0');
export const dayKey = (t: number): string => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
/** 夜 = 当日 18:00 到次日 06:00 为一个 night 键（键 = 夜晚开始那天的日期）；白天返回 undefined. */
export function nightKey(t: number): string | undefined {
  const d = new Date(t); const h = d.getHours();
  if (h >= 18) return dayKey(t);
  if (h < 6) return dayKey(t - 86_400_000);
  return undefined;
}
const restKey = (t: number) => nightKey(t) ?? `d:${dayKey(t)}`;

/** 取状态并做日期翻转 / 滚动窗口修剪. */
function state(now: number): GateState {
  if (!mem) mem = load(now);
  const st = mem;
  const d = dayKey(now);
  if (st.day !== d) {
    st.day = d;
    st.proactive.count = 0;
    st.proactive.unanswered = {};
    st.proactive.session = {};
    st.sameScene = {};
    st.enough = false;
  }
  if (st.hourly.length) {
    const cut = now - 3_600_000;
    if (st.hourly.some((t) => t <= cut || t > now + 60_000)) st.hourly = st.hourly.filter((t) => t > cut && t <= now + 60_000);
  }
  return st;
}

/* ───────────── 对外的小查询 ───────────── */

/** 危机当天（D18）：非功能话一律 silent，canNudge 恒假. */
export const isCrisisDay = (now: number): boolean => state(now).crisisDay === dayKey(now);
/** 今天是否已按时辰问候过. */
export const greetedToday = (now: number): boolean => state(now).greetDay === dayKey(now);
/** 读取失败（存储不可用或损坏）时为 true：此时主动话按「已说满」处理. */
export const gateLoadFailed = (): boolean => loadFailed;

export interface GateStats { today: number; cap: number; session: number; sessionCap: number; unanswered: boolean; enough: boolean; hourly: number; lastAt: number; ignoredStreak: number }
/** 主动搭话的计数（系统行「今天 1/3」、canNudge 用）. */
export function gateStats(now: number, taskId?: string): GateStats {
  const st = state(now);
  return {
    today: st.proactive.count, cap: NUDGE_DAY_CAP, session: taskId ? st.proactive.session[taskId] ?? 0 : 0, sessionCap: NUDGE_SESSION_CAP,
    unanswered: taskId ? !!st.proactive.unanswered[taskId] : false, enough: st.enough, hourly: st.hourly.length, lastAt: st.proactive.lastAt,
    ignoredStreak: st.rest.ignoredStreak,
  };
}

/** I-22 的有效档位：请求档 − sessionCap（8 小时后回落）. */
function capLevel(level: Level, now: number): Level {
  if (sessionDrop && now - sessionDropAt >= SESSION_CAP_TTL_MS) sessionDrop = 0;
  return sessionDrop ? downLevel(level, sessionDrop) : level;
}

/* ───────────── 总闸 ───────────── */

export function voiceGate(kind: GateKind, scene: string, snap: GateSnap, now: number): GateResult {
  const st = state(now);
  const functional = FUNCTIONAL.has(kind);
  const quiet = snap.quietUntil > now;
  const retreat = snap.retreated || snap.composing;
  const crisisToday = st.crisisDay === dayKey(now);
  const repeats = st.sameScene[scene] ?? 0;
  const skipped = repeats >= SKIP_ALL;
  // G8 优先于 G6：先扣 sessionCap（capped，预算与档位匹配都按它算），再按同日同场景缩一档（level，只影响说话的长短）
  const capped = capLevel(snap.level, now);
  const level = !skipped && repeats >= 2 ? downLevel(capped) : capped;
  const res = (mode: GateMode, why?: string, lv: Level = level): GateResult => ({ ok: mode !== 'silent', mode, level: lv, why });

  if (functional) {
    // G1：退后 / 安静 → 最短中性句（lead 的退后若正是它自己要说的事则不压）
    const own = kind === 'lead' && snap.retreated && !snap.composing && !quiet && !!snap.retreatWhy && snap.retreatWhy !== 'ime' && snap.retreatWhy !== 'quiet';
    if (quiet || (retreat && !own)) return res('min', quiet ? 'quiet' : 'retreat', 's');
    if (skipped) return res('min', 'skipped', 's');                       // G8：单条「这句不用说」——功能话不能整句消失，退成最短句
    return res('her', snap.persona ? undefined : 'persona-off');          // G2：persona=false 的功能话照出（走 voice-facts）
  }

  if (SAFETY.has(kind)) {
    // G9：触发条件（连续使用 ≥120 分钟；每晚 ≤1 / 白天每满 2 小时 ≤1；本连续使用期不再提；今天别再提醒）
    if (snap.continuousMinutes < REST_AFTER_MIN) return res('silent', 'not-due');
    if (st.rest.dismissedKey === restKey(now) || st.rest.dismissedDay === dayKey(now)) return res('silent', 'dismissed');
    const nk = nightKey(now);
    if (nk && st.rest.spokeKey === nk) return res('silent', 'once-per-night');
    if (st.rest.lastAt > 0 && now - st.rest.lastAt < REST_EVERY_MS) return res('silent', 'too-soon');
    const since = snap.continuousSince ?? now - snap.continuousMinutes * 60_000;
    if (st.rest.lastAt > 0 && st.rest.contSince > 0 && Math.abs(since - st.rest.contSince) < 5 * 60_000) return res('silent', 'continued');
    settleIgnored(now, lastInputAt());
    if (st.rest.ignoredStreak >= 3) return res('chip', 'ignored');       // ⑤ 连续 3 次被忽略：只在右栏状态牌亮标记
    if (quiet || retreat) return res('line', quiet ? 'quiet' : 'retreat');            // G1
    if (!snap.persona) return res('line', 'persona-off');                             // G2
    if (snap.proactive === 'off') return res('line', 'proactive-off');                // G4
    if (crisisToday) return res('line', 'crisis-day');                                // G10
    return res('her');                                                                // G11
  }

  // 非功能话：proactive / greet / aside
  if (quiet || retreat) return res('silent', quiet ? 'quiet' : 'retreat');            // G1
  if (crisisToday) return res('silent', 'crisis-day');                                // G10
  if (!snap.persona) return res('silent', 'persona-off');                             // G2
  if (kind === 'proactive') {
    if (snap.proactive === 'off') return res('silent', 'proactive-off');              // G4
    if (st.enough) return res('silent', 'enough');                                    // G8 enough
    const matches = snap.proactive === 'on' ? capped !== 's' : capped === 'l';                // G3 / D7：auto 只在多档，on 在中、多档，少档恒不说
    if (!matches) return res('silent', 'level-mismatch');
  }
  if (kind === 'greet' && !snap.lifeGreeting && !scene.startsWith('greet.first')) return res('silent', 'greeting-off');
  if (kind === 'greet' && /^greet\.(am|noon|eve|late)(\.|$)/.test(scene) && st.greetDay === dayKey(now)) return res('silent', 'greeted-today');
  if (skipped) return res('silent', 'skipped');                                       // G8 skip
  if (st.hourly.length >= HOURLY_BUDGET[capped]) return res('silent', 'hourly-budget');   // G5
  if (snap.unanswered) return res('silent', 'one-at-a-time');                         // G7
  return res('her');                                                                  // G11（level 已含 G6 / G8）
}

/* ───────────── 记账 ───────────── */

/** 说出口后记账。非功能话进每小时预算；proactive 另记今天 / 本会话次数与「未回应」；rest/late 记开口时刻等待反应. */
export function noteSpoken(kind: GateKind, scene: string, now: number, taskId?: string): void {
  const st = state(now);
  if ((st.sameScene[scene] ?? 0) < SKIP_ALL) st.sameScene[scene] = (st.sameScene[scene] ?? 0) + 1;
  if (!FUNCTIONAL.has(kind) && !SAFETY.has(kind)) st.hourly.push(now);
  if (kind === 'proactive') {
    st.proactive.count += 1;
    st.proactive.lastAt = now;
    if (taskId) { st.proactive.session[taskId] = (st.proactive.session[taskId] ?? 0) + 1; st.proactive.unanswered[taskId] = true; }
  }
  if (kind === 'greet') st.greetDay = dayKey(now);
  if (SAFETY.has(kind)) {
    st.rest.lastAt = now;
    st.rest.spokeKey = restKey(now);
    st.rest.contSince = continuousSince(now);
    st.rest.pendingAt = now;
  }
  save();
}

/** 休息关照只亮了右栏的标记（chip），没有进对话流：照样记下开口时刻（每晚 ≤1 / 每 2 小时 ≤1），但不等反应、不计入「被忽略」. */
export function noteChip(scene: string, now: number): void {
  const st = state(now);
  st.sameScene[scene] = Math.min(SKIP_ALL - 1, (st.sameScene[scene] ?? 0) + 1);
  st.rest.lastAt = now;
  st.rest.spokeKey = restKey(now);
  st.rest.contSince = continuousSince(now);
  st.rest.pendingAt = 0;
  save();
}

/** 今天这个场景已经说过几次（挑小话题时避开说过的）. */
export function sceneCountToday(scene: string, now: number): number {
  return state(now).sameScene[scene] ?? 0;
}

/** 用户回应了这个任务（发话 / 点胶囊）：清掉「上一次主动没得到回应」. */
export function noteAnswered(taskId: string, now: number = Date.now()): void {
  const st = state(now);
  if (st.proactive.unanswered[taskId]) { delete st.proactive.unanswered[taskId]; save(); }
}

/** I-22：用户关闭 / 跳过 / 「今天别再说」。
 *  x = 关闭 / 折叠她的非功能话（3 秒内连续两次 → 本会话降一档）；skip = 单条「这句不用说」（该场景当日不再）；
 *  enough = 「今天别再说」（当日 proactive 全部 silent；休息关照场景则是「今天别再提醒」）；
 *  later = 点了退出项（好，知道了）：不记次数，但休息关照场景下算「有反应」，清掉等待反应的 pendingAt. */
export function noteDismiss(scene: string, how: 'x' | 'skip' | 'enough' | 'later', now: number): void {
  const st = state(now);
  const rest = isRestScene(scene);
  if (how === 'x') {
    if (lastXAt && now - lastXAt <= DISMISS_PAIR_MS) {
      if (sessionDrop && now - sessionDropAt >= SESSION_CAP_TTL_MS) sessionDrop = 0;
      sessionDrop = Math.min(2, sessionDrop + 1);
      sessionDropAt = now;
      lastXAt = 0;
    } else lastXAt = now;
    if (rest) st.rest.pendingAt = 0;                                    // 点了关闭 = 有反应，不算被忽略
  } else if (how === 'skip') {
    st.sameScene[scene] = SKIP_ALL;
    if (rest) st.rest.pendingAt = 0;
  } else if (how === 'enough') {
    if (rest) { st.rest.dismissedKey = restKey(now); st.rest.dismissedDay = dayKey(now); st.rest.pendingAt = 0; }
    else { st.enough = true; st.proactive.count = Math.max(st.proactive.count, NUDGE_DAY_CAP); }
  } else if (rest) {
    st.rest.pendingAt = 0;                                              // later：点了退出项也是反应
  }
  save();
}

/** 用户在休息关照开口之后，在对话里发了话（userAt 是那条用户消息的时间）：算有反应，不再等、不算被忽略. */
export function noteRestReaction(userAt: number, now: number = Date.now()): void {
  const st = state(now);
  if (st.rest.pendingAt > 0 && userAt > st.rest.pendingAt) { st.rest.pendingAt = 0; save(); }
}

/** 点了「去歇一会儿」类按钮：被忽略计数清零. */
export function noteAccepted(now: number): void {
  const st = state(now);
  st.rest.ignoredStreak = 0;
  st.rest.pendingAt = 0;
  save();
}

/** 危机回合（D18）：记下今天，当天非功能话一律 silent. */
export function noteCrisis(now: number): void {
  state(now).crisisDay = dayKey(now);
  save();
}

/** 休息关照开口后 5 分钟：既没点任何按钮、用户也还在操作 → 被忽略一次；没有输入（停下了）→ 不算. 定时器和下一次评估都会调它. */
export function settleIgnored(now: number, lastInput: number): void {
  const st = state(now);
  const at = st.rest.pendingAt;
  if (!at || now - at < REST_IGNORE_MS) return;
  st.rest.pendingAt = 0;
  // 仍在操作：最近 2 分钟有输入；隔太久（>30 分钟）才来评估的，不知道当时的情况，保守地不记
  if (now - at <= 30 * 60_000 && now - lastInput < 2 * 60_000) st.rest.ignoredStreak += 1;
  save();
}

/* ───────────── 右栏状态牌上的标记（chip） ───────────── */

export interface RestChip { kind: 'rest' | 'late'; at: number }
let chip: RestChip | undefined;
const chipSubs = new Set<() => void>();
export const restChip = {
  get: (): RestChip | undefined => chip,
  set(v: RestChip | undefined) { chip = v; chipSubs.forEach((fn) => fn()); },
  subscribe(fn: () => void) { chipSubs.add(fn); return () => { chipSubs.delete(fn); }; },
};
/** 右栏状态牌用：有没有休息关照标记（被忽略 3 次之后只亮这一枚）. */
export const useRestChip = (): RestChip | undefined => useSyncExternalStore(restChip.subscribe, restChip.get, restChip.get);

/* ───────────── 快照 ───────────── */

/** 前台任务里有没有一条未被回应的非功能话（G7）：最后一条她的话是主动 / 问候 / 休息类，且之后用户没发话. */
export function unansweredHer(messages: AppState['tasks'][string]['messages']): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user') return false;
    if (m.role === 'agent' || (m.role === 'system' && m.src)) {
      const scene = m.src?.scene ?? '';
      return !!m.proactive || /^(greet\.|nudge\.|late(\.|$)|sys\.(nudge|rest|late))/.test(scene);
    }
  }
  return false;
}

/* ───────────── 测试钩子 ───────────── */

/** 测试用：换存储（null = 不可用，undefined = 还原 localStorage）并清空内存状态与会话降档. */
export function resetGateForTest(storage?: GateStorage | null): void {
  storageOverride = storage;
  mem = undefined;
  loadFailed = false;
  sessionDrop = 0;
  sessionDropAt = 0;
  lastXAt = 0;
  chip = undefined;
}
