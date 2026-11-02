/* 主动搭话、每日问候、休息关照（施工图 §3.6b，V2）。
   · 一律只写「前台闲聊任务」；工作任务运行中不往它的对话流写这些话（会污染运行记录与 chatHistory）.
     没有前台闲聊任务：proactive / greet 静默；rest / late 降级为一次性 toast（带「今天别再提醒」，同样计入 G9）.
   · 所有话先过 voiceGate（话语总闸）；canNudge 是纯函数，全部条件满足才说.
   · 不轮询：每次相关事件（消息进出、窗口焦点 / 可见性、设置、quietUntil、草稿、输入法）重算一个一次性 setTimeout，
     到期再过一遍 canNudge；窗口隐藏时不排. 由 shell.ts 的 startShellSync() 在 whenReady() 之后启动 startProactive().
   · 来源：默认 nudge.* 模板（零 token，Message.proactive=true，src 记出处）；proactiveTopics 开才调 live.reply(taskId,{nudge:true})，
     模型可回 silent，由 E 删消息. lifeGreeting 走 greet.* 模板，不再调模型.
   · 系统行（「静默 N 分钟（真实时长）· 她主动开口 · 今天 1/3」「已连续使用 2 小时 · 休息关照」）不是第二种消息：
     由她这条话的 src.slots（sys / silent / today / cap / hours）派生；voiceGate 返回 line 时只出一条 role='system' 的系统行消息. */
import { subscribeDraft } from '../lib/draft';
import { subscribeComposing } from '../lib/ime';
import { settleExpr } from '../lib/mood';
import { CONTINUOUS_GAP_MS, awayMs, continuousMinutes, continuousSince, lastInputAt, previousSeen } from '../lib/presence';
import type { AppState, ExprId, Message, Task } from '../lib/types';
import { say2, voiceSeed, type Say2Result } from '../lib/voice';
import { cnCount } from '../lib/voice-lines';
import { toast as pushToast, touch } from './engine';
import { isReplying, reply } from './live';
import { openingFor } from './brief';
import { isHerMessage, makeGateSnap, selectQueue } from './selectors';
import { store, uid } from './store';
import {
  NUDGE_DAY_CAP, NUDGE_SESSION_CAP, REST_AFTER_MIN, REST_IGNORE_MS, dayKey, gateStats, greetedToday, isCrisisDay, noteAnswered, noteChip, noteRestReaction, noteSpoken, restChip, sceneCountToday, settleIgnored, voiceGate,
  type GateKind, type GateSnap,
} from './voiceGate';

/** 用户在该任务里静默多久才可能主动开口. */
export const NUDGE_QUIET_MS = 8 * 60_000;
/** 条件由否变是（回到窗口、清掉草稿、输入法组合结束、早上回到过夜开着的窗口）时，到期点已过也不当场开口：再给这么一点缓冲. */
export const NUDGE_GRACE_MS = 45_000;
/** 允许主动开口的钟点：08:00 ≤ 钟点 < 22:00（深夜走 late.*）. */
export const NUDGE_FROM_HOUR = 8;
export const NUDGE_TO_HOUR = 22;
/** 默认小话题（nudge.* 模板，圣经 §5.9）. */
export const NUDGE_TOPICS = ['nudge.photo', 'nudge.flower', 'nudge.book', 'nudge.doll', 'nudge.letter', 'nudge.myth'] as const;

/* ───────────── canNudge（纯函数） ───────────── */

export interface NudgeSnap {
  /** 总闸快照（taskId = 前台闲聊任务）. */
  gate: GateSnap;
  visible: boolean;
  focused: boolean;
  /** 前台闲聊任务；没有 = 不说. */
  task?: { id: string; chat: boolean; lastAt: number; userSpoke: boolean; replying: boolean };
  /** 全局有待批审批 / 待答问题 / 待批计划. */
  pendingAny: boolean;
  /** 今天已主动几次 / 该任务本会话几次 / 上一次主动没得到回应. */
  today: number;
  session: number;
  unansweredPrev: boolean;
}

export interface NudgeVerdict { ok: boolean; why?: string }

export function canNudge(snap: NudgeSnap, now: number): NudgeVerdict {
  const no = (why: string): NudgeVerdict => ({ ok: false, why });
  const g = snap.gate;
  if (isCrisisDay(now)) return no('crisis-day');                                      // D18：危机当天恒假
  if (!g.persona) return no('persona-off');
  if (g.proactive === 'off') return no('proactive-off');
  if (g.quietUntil > now) return no('quiet');
  if (!snap.visible) return no('hidden');
  if (!snap.focused) return no('no-focus');
  if (!snap.task || !snap.task.chat) return no('no-chat-task');
  if (snap.task.replying) return no('replying');
  if (g.hasDraft) return no('draft');
  if (g.composing) return no('ime');
  if (snap.pendingAny) return no('pending');
  if (!snap.task.userSpoke) return no('user-never-spoke');
  if (now - snap.task.lastAt < NUDGE_QUIET_MS) return no('too-soon');
  const h = new Date(now).getHours();
  if (h < NUDGE_FROM_HOUR || h >= NUDGE_TO_HOUR) return no('night');
  if (snap.session >= NUDGE_SESSION_CAP) return no('session-cap');
  if (snap.today >= NUDGE_DAY_CAP) return no('day-cap');
  if (snap.unansweredPrev) return no('unanswered');
  const v = voiceGate('proactive', 'nudge', g, now);                                    // G1–G11
  if (!v.ok || v.mode !== 'her') return no(`gate:${v.why ?? v.mode}`);
  return { ok: true };
}

/** 下一次该在什么时刻重新过一遍 canNudge：最后一条消息 + 8 分钟，落在 08:00–22:00 内；今晚已过 22:00 → undefined（明早有新消息再排）.
 *  到期点已经过了：graceMs=0 就是「现在」（纯计算）；调度时传 NUDGE_GRACE_MS，给用户一点缓冲再开口. */
export function nextNudgeAt(lastAt: number, now: number, graceMs = 0): number | undefined {
  let due = lastAt + NUDGE_QUIET_MS;
  if (due < now) due = now + graceMs;
  const d = new Date(due);
  if (d.getHours() >= NUDGE_TO_HOUR) return undefined;
  if (d.getHours() < NUDGE_FROM_HOUR) { d.setHours(NUDGE_FROM_HOUR, 0, 0, 0); due = d.getTime(); }
  return due;
}

/* ───────────── 环境与快照 ───────────── */

interface Env { visible(): boolean; focused(): boolean }
const defaultEnv: Env = {
  visible: () => typeof document !== 'undefined' && document.visibilityState === 'visible',
  focused: () => typeof document !== 'undefined' && typeof document.hasFocus === 'function' && document.hasFocus(),
};
let env: Env = defaultEnv;
/** 测试用：替换「窗口可见 / 有焦点」的判断（undefined = 还原）. */
export function setProactiveEnvForTest(e?: Partial<Env>): void { env = e ? { ...defaultEnv, ...e } : defaultEnv; }

/** 前台闲聊任务：任务页开着、选中的是闲聊. */
export function foregroundChat(s: AppState): Task | undefined {
  if (s.view !== 'task' || !s.selectedTaskId) return undefined;
  const t = s.tasks[s.selectedTaskId];
  return t && t.kind === 'chat' ? t : undefined;
}

export function buildNudgeSnap(s: AppState, now: number): NudgeSnap {
  const t = foregroundChat(s);
  const last = t?.messages[t.messages.length - 1];
  const st = gateStats(now, t?.id);
  return {
    gate: makeGateSnap(s, now, t?.id),
    visible: env.visible(),
    focused: env.focused(),
    task: t ? { id: t.id, chat: true, lastAt: last?.at ?? t.updatedAt ?? 0, userSpoke: t.messages.some((m) => m.role === 'user'), replying: isReplying(t.id) || !!last?.streaming } : undefined,
    pendingAny: selectQueue(s).some((i) => i.kind === 'approval' || i.kind === 'question' || i.kind === 'plan'),
    today: st.today,
    session: st.session,
    unansweredPrev: st.unanswered,
  };
}

/* ───────────── 写进对话 ───────────── */

const hoursText = (min: number) => `${cnCount(Math.max(1, Math.floor(min / 60)))}小时`;
const clockText = (now: number) => { const d = new Date(now); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 把一句模板话写成她的一条消息（kind:'note'，proactive 标记、src 记出处，expr 由 settleExpr 在此刻定下）. */
function appendHer(taskId: string, r: Say2Result, extra: Record<string, string | number>, opts: { proactive: boolean; level: 's' | 'm' | 'l' }, now: number): string | undefined {
  if (!r.text) return undefined;
  const id = uid('msg');
  store.update((d) => {
    const t = d.tasks[taskId];
    if (!t) return;
    const hers = t.messages.filter(isHerMessage);
    const expr: ExprId = settleExpr({
      candidate: r.expr ?? undefined, text: r.text, recent: hers.slice(-5).map((m) => m.expr ?? 'gentle'),
      lastAt: hers.length ? hers[hers.length - 1].at : 0, now, level: opts.level, kind: 'note',
    });
    const m: Message = {
      id, role: 'agent', agentId: 'orchestrator', text: r.text, at: now, kind: 'note', persona: d.settings.mode, expr, proactive: opts.proactive,
      src: { ...(r.src ?? { id: 'her', mode: 'chat' as const }), slots: { ...(r.src?.slots ?? {}), ...extra } },
    };
    t.messages.push(m);
    touch(d, taskId, now);
  });
  return id;
}

/** 只出一行系统行（voiceGate 返回 line）：role='system'，不是她的话. */
function appendLine(taskId: string, scene: string, text: string, extra: Record<string, string | number>, now: number): void {
  store.update((d) => {
    const t = d.tasks[taskId];
    if (!t) return;
    t.messages.push({ id: uid('msg'), role: 'system', text, at: now, proactive: true, src: { id: scene, mode: 'chat', scene, slots: extra } });
    touch(d, taskId, now);
  });
}

const sayOpts = (s: AppState, level: 's' | 'm' | 'l', now: number, taskId: string, index: number | string = 0) => ({
  level, mode: 'chat' as const, theme: s.settings.mode, persona: true, callName: s.settings.callName, seed: voiceSeed(now, taskId, index),
});

/* ───────────── 主动搭话 ───────────── */

/** 挑今天还没说过的小话题；每个话题在该档位都有台词才算（少档没有）. 种子 = 日期 + 任务. */
function pickTopic(s: AppState, level: 's' | 'm' | 'l', now: number, taskId: string): { scene: string; r: Say2Result } | undefined {
  const day = dayKey(now);
  let h = 0;
  for (const ch of `${day}|${taskId}`) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  for (let i = 0; i < NUDGE_TOPICS.length; i++) {
    const scene = NUDGE_TOPICS[(h + i) % NUDGE_TOPICS.length];
    if (sceneCountToday(scene, now) > 0) continue;
    const r = say2(scene, {}, sayOpts(s, level, now, taskId));
    if (r.text) return { scene, r };
  }
  return undefined;
}

/** 到点后真正过一遍 canNudge 再说. 返回写入的消息 id（用模型想话题时返回 'model'）. */
export function fireNudge(now: number = Date.now()): string | undefined {
  const s = store.get();
  const snap = buildNudgeSnap(s, now);
  if (!canNudge(snap, now).ok || !snap.task) return undefined;
  const taskId = snap.task.id;
  if (s.settings.proactiveTopics) {                                                     // 让她自己想话题：调一次模型，可回 silent，由 E 删消息
    noteSpoken('proactive', 'nudge.model', now, taskId);
    void reply(taskId, { nudge: true });
    return 'model';
  }
  const v = voiceGate('proactive', 'nudge', snap.gate, now);
  const topic = pickTopic(s, v.level, now, taskId);
  if (!topic) return undefined;
  const g = voiceGate('proactive', topic.scene, snap.gate, now);                       // 带上具体话题，G6 同场景缩档才有意义
  if (!g.ok || g.mode !== 'her') return undefined;
  let r = g.level === v.level ? topic.r : say2(topic.scene, {}, sayOpts(s, g.level, now, taskId));
  if (!r.text) r = topic.r;
  // silent：这一次真的静默了多久（条件一满足就开口，可能是几十分钟甚至一夜；系统行从不编数字）
  const silent = Math.max(Math.round(NUDGE_QUIET_MS / 60_000), Math.floor((now - snap.task.lastAt) / 60_000));
  const id = appendHer(taskId, r, { sys: 'nudge', silent, today: snap.today + 1, cap: NUDGE_DAY_CAP }, { proactive: true, level: g.level }, now);
  if (id) noteSpoken('proactive', topic.scene, now, taskId);
  return id;
}

/* ───────────── 每日问候 ───────────── */

/** 空的闲聊页，或隔了 ≥30 分钟没动静的闲聊页，且没有在回复. */
function greetable(t: Task, now: number): boolean {
  if (!t.messages.length) return true;
  const last = t.messages[t.messages.length - 1];
  return !last.streaming && now - last.at >= 30 * 60_000;
}

const SESSION_START = Date.now();

/** 用户自己打开应用 / 闲聊页时：每天第一次按时辰问候一句（greet.* 模板，零 token）. */
export function maybeGreet(now: number = Date.now()): string | undefined {
  const s = store.get();
  const t = foregroundChat(s);
  if (!t || !env.visible() || !env.focused() || isReplying(t.id) || !greetable(t, now)) return undefined;
  const queue = selectQueue(s);
  const opening = openingFor({
    hasLastSeen: previousSeen > 0, taskCount: Object.keys(s.tasks).length,
    awayMs: now - SESSION_START < 30 * 60_000 ? awayMs : 0,
    pending: queue.filter((i) => i.kind === 'approval' || i.kind === 'question' || i.kind === 'plan').length,
    failed: queue.filter((i) => i.kind === 'failed').length, done: 0,
    lifeGreeting: !!s.settings.lifeGreeting, greetedToday: greetedToday(now), now,
  });
  if (opening.kind !== 'greet') return undefined;
  const scene = opening.scene;
  const snap = makeGateSnap(s, now, t.id);
  const g = voiceGate('greet', scene, snap, now);
  if (!g.ok || g.mode !== 'her') return undefined;
  const r = say2(scene, {}, sayOpts(s, g.level, now, t.id));
  const id = appendHer(t.id, r, { sys: 'greet' }, { proactive: true, level: g.level }, now);
  if (id) noteSpoken('greet', scene, now, t.id);
  return id;
}

/* ───────────── 休息关照 / 很晚 ───────────── */

/** 连续使用 ≥120 分钟：钟点在 01:00–06:00 走 late.*（很晚），其余走 nudge.rest（休息关照）. 先过 voiceGate（G9）. */
export function fireRest(now: number = Date.now()): 'her' | 'line' | 'chip' | 'toast' | undefined {
  const s = store.get();
  const min = continuousMinutes(now);
  if (min < REST_AFTER_MIN) return undefined;
  const hour = new Date(now).getHours();
  const kind: GateKind = hour >= 1 && hour < 6 ? 'late' : 'rest';
  const scene = kind === 'late' ? 'late.c' : 'nudge.rest';
  const t = foregroundChat(s);
  const snap = makeGateSnap(s, now, t?.id);
  if (!env.visible()) return undefined;                                                 // 看不见就不说（回到窗口时重排）
  const g = voiceGate(kind, scene, snap, now);
  if (g.mode === 'silent') return undefined;
  const slots = kind === 'late' ? { clock: clockText(now) } : { hours: hoursText(min) };
  const sys = { sys: kind, hrs: Math.floor(min / 60) };       // hrs：给系统行用的数字（hours 是模板槽位「两小时」，别盖掉）
  if (g.mode === 'chip') {
    restChip.set({ kind, at: now });
    noteChip(scene, now);
    return 'chip';
  }
  const lineText = kind === 'late' ? `已经 ${clockText(now)} 了。` : `已连续使用 ${Math.floor(min / 60)} 小时。`;
  const sysScene = kind === 'late' ? 'sys.late' : 'sys.rest';
  if (!t) {                                                                              // 没有前台闲聊任务：降级为一次性 toast，带「今天别再提醒」
    if (g.why === 'quiet') return undefined;                                             // 用户明确要安静：不弹、不记账（reschedule 会把它推到安静结束之后）
    const r = g.mode === 'her' ? say2(scene, slots, sayOpts(s, g.level, now, 'toast')) : undefined;
    const title = r?.text || say2(sysScene, slots, sayOpts(s, 's', now, 'toast')).text || lineText;
    store.update((d) => pushToast(d, { tone: 'info', title, body: r?.text ? undefined : '起身活动一下吧。', key: 'rest', ttl: 12_000, action: { label: '今天别再提醒', command: { type: 'mute-rest' } } }));
    noteSpoken(kind, scene, now);
    armIgnoreTimer();
    return 'toast';
  }
  if (g.mode === 'her') {
    const r = say2(scene, slots, sayOpts(s, g.level, now, t.id));
    if (r.text) {
      appendHer(t.id, r, sys, { proactive: true, level: g.level }, now);
      noteSpoken(kind, scene, now, t.id);
      armIgnoreTimer();
      return 'her';
    }
  }
  // line（或模板缺失时的兜底）：只出一行系统行，无角色话
  appendLine(t.id, sysScene, say2(sysScene, slots, sayOpts(s, 's', now, t.id)).text || lineText, sys, now);
  noteSpoken(kind, scene, now, t.id);
  armIgnoreTimer();
  return 'line';
}

/* ───────────── 被忽略 / 有回应 的记账（G9-⑤、I-22） ───────────── */

/** 一个闲聊任务里最后一条用户消息的时间（0 = 没有）；只从后往前找到第一条就停. */
function lastUserAt(t: Task): number {
  for (let i = t.messages.length - 1; i >= 0; i--) if (t.messages[i].role === 'user') return t.messages[i].at;
  return 0;
}

/** 用户在对话里发了话 = 回应了她：清掉「上一次主动没得到回应」（让 NUDGE_SESSION_CAP 之内的下一次可以开口）、清掉休息关照的「等反应」.
 *  不依赖是谁发的（输入框、选项胶囊、命令都一样会在对话里多出一条用户消息），所以挂在 store 变化上，onChange 每次先调它. */
export function reconcileResponses(now: number = Date.now()): void {
  const t = foregroundChat(store.get());
  if (!t) return;
  const userAt = lastUserAt(t);
  if (!userAt) return;
  const st = gateStats(now, t.id);
  if (st.unanswered && userAt > st.lastAt) noteAnswered(t.id, now);
  noteRestReaction(userAt, now);
}

/** 休息关照开口后 5 分钟到点：先看看用户有没有在任何闲聊里回过话，再按「仍在操作」判被忽略（voiceGate.settleIgnored）. 导出给测试. */
export function settleRestIgnored(now: number = Date.now()): void {
  for (const t of Object.values(store.get().tasks)) if (t.kind === 'chat') { const u = lastUserAt(t); if (u) noteRestReaction(u, now); }
  settleIgnored(now, lastInputAt());
}

let ignoreTimer: number | undefined;
function clearIgnoreTimer() { if (ignoreTimer !== undefined && typeof window !== 'undefined') window.clearTimeout(ignoreTimer); ignoreTimer = undefined; }
/** 她刚开了口（对话 / 系统行 / toast）：排一个一次性定时器，5 分钟后判「被忽略」. voiceGate 里那一次 settleIgnored 排在 2 小时间隔检查之后，永远赶不上 30 分钟窗口，只靠这里. */
function armIgnoreTimer(): void {
  if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') return;
  clearIgnoreTimer();
  ignoreTimer = window.setTimeout(() => { ignoreTimer = undefined; settleRestIgnored(); }, REST_IGNORE_MS + 1000);
}

/* ───────────── 调度 ───────────── */

interface Sched { key: string; timer?: number; at?: number; fired?: boolean }
let nudgeSched: Sched = { key: '' };
let restSched: Sched = { key: '' };
let started = false;
let stopFn: (() => void) | undefined;
let greetKey = '';

const MAX_TIMEOUT = 2_147_000_000;
const clear = (sc: Sched) => { if (sc.timer !== undefined) window.clearTimeout(sc.timer); sc.timer = undefined; sc.at = undefined; sc.fired = false; };

function arm(sc: Sched, key: string, due: number | undefined, now: number, fire: () => void) {
  // 同一把钥匙：排着、已经响过、或根本没得排，都不重复排（响过之后要等条件变化——钥匙变了——才会再排，免得空转）
  if (sc.key === key && (sc.timer !== undefined || sc.fired || due === undefined)) return;
  clear(sc);
  sc.key = key;
  if (due === undefined) return;
  sc.at = due;
  sc.timer = window.setTimeout(() => { sc.timer = undefined; sc.fired = true; fire(); }, Math.min(MAX_TIMEOUT, Math.max(0, due - now)));
}

/** 重算两个一次性定时器（不轮询；窗口隐藏时都不排）. */
export function reschedule(now: number = Date.now()): void {
  const s = store.get();
  if (typeof window === 'undefined') return;
  const visible = env.visible();
  const set = s.settings;
  const t = foregroundChat(s);
  const last = t?.messages[t.messages.length - 1];

  // 主动搭话：前台闲聊 + 用户说过话 + 开关与话量匹配
  const nudgeOk = visible && !!t && t.messages.some((m) => m.role === 'user') && set.persona !== false && set.proactive !== 'off' && !isCrisisDay(now);
  let due: number | undefined;
  if (nudgeOk && last) {
    due = nextNudgeAt(last.at, now, NUDGE_GRACE_MS);
    if (due !== undefined && (s.quietUntil ?? 0) > due) due = (s.quietUntil ?? 0) + 1000;
  }
  const snapKey = nudgeOk && t ? buildNudgeSnap(s, now) : undefined;
  const nKey = `${nudgeOk}|${t?.id}|${last?.id}|${last?.at}|${last?.streaming ? 1 : 0}|${set.proactive}|${set.level}|${set.proactiveTopics}|${s.quietUntil ?? 0}`
    + `|${env.focused()}|${snapKey?.gate.hasDraft ? 1 : 0}|${snapKey?.gate.composing ? 1 : 0}|${snapKey?.pendingAny ? 1 : 0}|${snapKey?.task?.replying ? 1 : 0}|${snapKey?.today}|${snapKey?.session}|${snapKey?.unansweredPrev ? 1 : 0}`;
  arm(nudgeSched, nKey, due, now, () => { fireNudge(); reschedule(); });

  // 休息关照：连续使用 ≥120 分钟（起点 + 120 分钟）；每次输入（节流）与窗口事件都会来重排
  let restDue: number | undefined;
  if (visible) {                                                                       // persona 关也要排：到点只出系统行（voiceGate G2），安全类提醒不能消失
    // 没在用（最近 20 分钟无输入）就不排；在用就排在「这一段连续使用的起点 + 120 分钟」，已经过了就是现在
    if (now - lastInputAt() < CONTINUOUS_GAP_MS) restDue = continuousSince(now) + REST_AFTER_MIN * 60_000;
  }
  // 用户要了安静、又没有闲聊页可以出系统行：把休息关照推到安静结束之后，别用 toast 打断
  if (restDue !== undefined && !t && (s.quietUntil ?? 0) > restDue) restDue = (s.quietUntil ?? 0) + 1000;
  const rKey = `${visible}|${restDue ?? ''}|${set.persona}|${set.proactive}|${s.quietUntil ?? 0}|${t?.id}`;
  arm(restSched, rKey, restDue, now, () => { fireRest(); reschedule(); });
}

function onChange(): void {
  const now = Date.now();
  const s = store.get();
  reconcileResponses(now);
  reschedule(now);
  const t = foregroundChat(s);
  if (t) {
    const key = `${t.id}|${dayKey(now)}|${env.visible() && env.focused()}`;
    if (key !== greetKey) { greetKey = key; maybeGreet(now); }
  }
}

/** 测试用：清掉两个定时器与它们的钥匙. */
export function resetProactiveSchedForTest(): void {
  if (typeof window !== 'undefined') { clear(nudgeSched); clear(restSched); }
  clearIgnoreTimer();
  nudgeSched = { key: '' };
  restSched = { key: '' };
}

/** shell.ts 在 whenReady() 之后调用（startShellSync 在 main.tsx 里先于渲染运行，所以不能在那里直接开）. 重复调用无副作用. 返回停止函数. */
export function startProactive(): () => void {
  if (started || typeof window === 'undefined') return stopFn ?? (() => {});
  started = true;
  const unsubs: Array<() => void> = [store.subscribe(onChange), subscribeDraft(onChange), subscribeComposing(onChange)];
  const on = (target: Window | Document, type: string, fn: () => void, capture = false) => {
    target.addEventListener(type, fn, { passive: true, capture });
    unsubs.push(() => target.removeEventListener(type, fn, { capture }));
  };
  on(window, 'focus', onChange);
  on(window, 'blur', onChange);
  on(document, 'visibilitychange', onChange);
  // 输入不是 store 事件：节流到每分钟一次，只为让休息关照的定时器跟上「连续使用」
  let lastTouch = 0;
  const onInput = () => { const n = Date.now(); if (n - lastTouch >= 60_000) { lastTouch = n; reschedule(n); } };
  on(window, 'pointerdown', onInput, true);
  on(window, 'keydown', onInput, true);
  onChange();
  let stopped = false;
  stopFn = () => {
    if (stopped) return;
    stopped = true;
    for (const u of unsubs) u();
    clear(nudgeSched); clear(restSched); clearIgnoreTimer();
    nudgeSched = { key: '' }; restSched = { key: '' };
    started = false; greetKey = ''; stopFn = undefined;
  };
  return stopFn;
}
