/* 归来简（V0α · 模块 B4「交互」，Q07 简版）。
   离开 ≥ settings.returnAfterMin 分钟、且期间有事件，才出一张纸；否则整张纸换成一句「现在没有在等阁下的事了。」
   全部来自 AppState 里的运行记录与消息，不调用模型、不耗额度、不阻塞输入；每一行都带 taskId / runId，数字可以追回记录：
   · done    = 离开期间结束的、成功的运行（每个运行一行）
   · failed  = 离开期间结束的、失败的运行
   · replies = 离开期间有新回复的闲聊（每个闲聊一行）
   · waiting = 此刻仍在等阁下的待批 / 待回复 / 计划（等于「待你」队列里这三类的条数）
   · notice  = 离开期间运行里记下的、已经继续的出错（每个运行一行，只列不计入句子）
   「离开」怎么判定：presence.ts（B2）盯着键盘鼠标，沉默 ≥ returnAfterMin 分钟后再有操作，就把 AppState.lastSeen 设成离开的那一刻；
   冷启动时 persist.ts 把 lastSeen 设成上一次会话最后一次操作。shell.ts 看到 lastSeen 变了，就用 detectAway 记下一次离开窗口（awayWindow）. */
import type { AppState } from '../lib/types';
import { say, voiceSeed } from '../lib/voice';
import { deriveQueue } from './queue';
import { distanceOf } from './selectors';

export interface BriefLine { at: number; kind: 'done' | 'failed' | 'reply' | 'notice'; text: string; taskId?: string; runId?: string }

export interface ReturnBrief {
  quiet: boolean;
  from?: number;
  to?: number;
  /** 离开期间发生的事（最多 5 行，多的折叠为 more）. */
  lines: BriefLine[];
  more: number;
  /** 由 say('return.brief', …) 生成的一段话（距离 0 时是一行数字）；quiet 时是 say('return.quiet') 的那一句. */
  text: string;
  /** 句子里的数字，全部能在 lines / 队列里点出来. */
  counts: { done: number; failed: number; replies: number; waiting: number; notices: number; away: number };
}

const MIN = 60_000;
export const clampReturnMin = (m: number) => Math.min(120, Math.max(5, Math.round(Number.isFinite(m) ? m : 30)));
/** 简报从「回来」那一刻起算多久还新鲜（再久就不当成这次的归来了）. */
export const BRIEF_FRESH_MS = 3 * 60 * MIN;
const MAX_LINES = 5;
const LINE_RANK: Record<BriefLine['kind'], number> = { failed: 0, done: 1, reply: 2, notice: 3 };

/** 离开了几分钟：按分钟边界相减（与笺上「15:39 到 16:19」的 HH:mm 同一个取整），不对毫秒四舍五入——
 *  否则 15:39:50 到 16:19:20 笺上写 40 分钟，句子里却读成「四十一分钟」（第 2 轮评审）. */
export const awayMinutes = (from: number, to: number): number => Math.max(1, Math.floor(to / MIN) - Math.floor(from / MIN));

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 时间顺序；同一时刻按类别、再按记录 id 定序，结果不依赖遍历顺序. */
const byTime = (a: BriefLine, b: BriefLine) => a.at - b.at || cmp(a.kind, b.kind) || cmp(a.runId ?? a.taskId ?? '', b.runId ?? b.taskId ?? '');

const speakOpts = (s: AppState, now: number) => ({
  distance: distanceOf(s.settings),
  callName: s.settings.callName,
  seed: voiceSeed(now, '归来', 0),
});

export function deriveBrief(s: AppState, lastSeen: number | undefined, now: number): ReturnBrief {
  const quietBrief = (): ReturnBrief => ({
    quiet: true, lines: [], more: 0, text: say('return.quiet', {}, speakOpts(s, now)),
    counts: { done: 0, failed: 0, replies: 0, waiting: 0, notices: 0, away: 0 },
  });
  if (lastSeen === undefined || !Number.isFinite(lastSeen) || !Number.isFinite(now) || now <= lastSeen) return quietBrief();
  const awayMs = now - lastSeen;
  if (awayMs < clampReturnMin(s.settings.returnAfterMin) * MIN) return quietBrief();

  const all: BriefLine[] = [];
  const inWindow = (t: number | undefined): t is number => t !== undefined && t > lastSeen && t <= now;

  for (const run of Object.values(s.runs)) {
    const task = s.tasks[run.taskId];
    if (!task) continue;
    if (inWindow(run.endedAt)) {
      if (run.status === 'completed') all.push({ at: run.endedAt, kind: 'done', text: `${task.title} 完成`, taskId: task.id, runId: run.id });
      else if (run.status === 'failed') all.push({ at: run.endedAt, kind: 'failed', text: `${task.title} 没能走到最后`, taskId: task.id, runId: run.id });
    }
    const soft = (run.errors ?? []).filter((e) => !e.fatal && inWindow(e.at));
    if (soft.length) {
      all.push({ at: Math.max(...soft.map((e) => e.at)), kind: 'notice', text: `${task.title} · ${soft.length} 次出错，已继续，行迹已留`, taskId: task.id, runId: run.id });
    }
  }
  for (const task of Object.values(s.tasks)) {
    if (task.kind !== 'chat') continue;
    const replies = task.messages.filter((m) => m.role === 'agent' && m.kind !== 'error' && !m.streaming && inWindow(m.at));
    if (replies.length) all.push({ at: replies[replies.length - 1].at, kind: 'reply', text: `${task.title} 有新的回复`, taskId: task.id });
  }

  const queue = deriveQueue(s);
  const waitingItems = queue.filter((i) => i.kind === 'approval' || i.kind === 'question' || i.kind === 'plan');
  const newlyWaiting = waitingItems.filter((i) => inWindow(i.since)).length;
  if (!all.length && !newlyWaiting) return quietBrief();

  all.sort(byTime);
  const count = (k: BriefLine['kind']) => all.filter((l) => l.kind === k).length;
  const counts = { done: count('done'), failed: count('failed'), replies: count('reply'), waiting: waitingItems.length, notices: count('notice'), away: awayMinutes(lastSeen, now) };

  // 超过 5 行：失败 > 完成 > 回复 > 提示，同类取最近的；最后仍按时间顺序摆.
  const keep = all.length <= MAX_LINES
    ? all
    : [...all].sort((a, b) => LINE_RANK[a.kind] - LINE_RANK[b.kind] || b.at - a.at || byTime(a, b)).slice(0, MAX_LINES).sort(byTime);

  return {
    quiet: false,
    from: lastSeen,
    to: now,
    lines: keep,
    more: all.length - keep.length,
    text: say('return.brief', { away: counts.away, done: counts.done, failed: counts.failed, replies: counts.replies, waiting: counts.waiting, queue: queue.length }, speakOpts(s, now)),
    counts,
  };
}

/* ───────────── 离开窗口：什么时候算「离开过」 ───────────── */

export interface AwayWindow { from: number; to: number }

let current: AwayWindow | undefined;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const awayWindow = {
  get: (): AwayWindow | undefined => current,
  subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  set(w: AwayWindow | undefined) { current = w; emit(); },
  /** 看过了：离开首页之后，这封信不再回来. */
  clear() { if (current) { current = undefined; emit(); } },
};

/** 纯函数：离开的那一刻（presence.ts 记下的 AppState.lastSeen）到回来的这一刻，够不够久算一次「离开」. */
export function detectAway(leftAt: number, returnedAt: number, thresholdMin: number): AwayWindow | undefined {
  return Number.isFinite(leftAt) && returnedAt - leftAt >= clampReturnMin(thresholdMin) * MIN ? { from: leftAt, to: returnedAt } : undefined;
}

/* ───────────── 问候 / 归来分工（施工图 §3.3「问候 / 归来分工」，R-CI I-08）：openingFor ───────────── */

export type GreetScene = 'greet.am' | 'greet.noon' | 'greet.eve' | 'greet.late';
/** 开屏之后这一次该给什么：
 *  · first —— 从未打开过，FirstRun 出 greet.first（一次，带 AI 小标）；
 *  · brief —— 出归来笺（事实先行）；awayGreeting = 离开 ≥3 天且无待你无失败，笺头加一句 greet.away（不说「好久不见」）；
 *    brief 时不抽 greet.away 里需要 noPending 的行；
 *  · greet —— 其余：每天第一次打开按时辰问候，同日再开不再问候；
 *  · none —— 什么都不出（lifeGreeting 关、同日已问候、没有可说的）. */
export type Opening =
  | { kind: 'first' }
  | { kind: 'brief'; awayGreeting: boolean }
  | { kind: 'greet'; scene: GreetScene }
  | { kind: 'none' };

export interface OpeningFacts {
  /** 有没有上一次会话的「最后一次操作」时刻（presence.previousSeen > 0）. */
  hasLastSeen: boolean;
  /** 已有的任务数. */
  taskCount: number;
  /** 离开了多久（毫秒；presence.awayMs）. */
  awayMs: number;
  /** 此刻在等你的事：待批 / 待答 / 计划待批（deriveQueue 前三类）与失败. */
  pending: number;
  failed: number;
  /** 离开期间完成的运行数. */
  done: number;
  lifeGreeting: boolean;
  /** 今天是否已按时辰问候过（voiceGate.greetedToday）. */
  greetedToday: boolean;
  now: number;
}

/** 离开多久以上算「很久」，笺头加 greet.away. */
export const AWAY_GREETING_MS = 3 * 24 * 3_600_000;

/** 钟点 → 问候场景：05–11 点早、11–17 点午、17–22 点晚、其余深夜（时钟判断，不断言夜昼）. */
export function greetSceneAt(now: number): GreetScene {
  const h = new Date(now).getHours();
  return h >= 5 && h < 11 ? 'greet.am' : h >= 11 && h < 17 ? 'greet.noon' : h >= 17 && h < 22 ? 'greet.eve' : 'greet.late';
}

export function openingFor(f: OpeningFacts): Opening {
  if (!f.hasLastSeen && f.taskCount === 0) return { kind: 'first' };
  const calm = f.pending === 0 && f.failed === 0;
  if (f.awayMs >= AWAY_GREETING_MS && calm) return { kind: 'brief', awayGreeting: true };
  if (f.pending > 0 || f.failed > 0 || f.done > 0) return { kind: 'brief', awayGreeting: false };
  if (!f.lifeGreeting || f.greetedToday) return { kind: 'none' };
  return { kind: 'greet', scene: greetSceneAt(f.now) };
}
