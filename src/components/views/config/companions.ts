/* Agent 页的数据选择器（施工图 §4.3）：此刻同行、队伍行迹、近 7 天小柱、牌面序号与缎带文案.
   纯函数，只读 AppState；放在这里是因为只有 Agent 页用。useApp 配 sameCompanions / sameTrail / sameWeek 使用（每次都会新建对象）. */
import { isOpenRun } from '../../../lib/status';
import type { AgentActivity, AgentId, AppState, PlanStep, Run, RunStatus, StepStatus } from '../../../lib/types';
import { agentActivity } from '../../../state/selectors';
import { shallow } from '../../../state/store';

/** 牌桌与此刻同行里的固定顺序（也是 `s.agents` 的种子顺序）. */
export const AGENT_ORDER: readonly AgentId[] = ['orchestrator', 'researcher', 'coder', 'reviewer'];
/** 没有运行时三张小牌的默认派活顺序. */
export const DEFAULT_DISPATCH: readonly AgentId[] = ['researcher', 'coder', 'reviewer'];

export type CompState = 'busy' | 'queued' | 'done' | 'idle' | 'off';

export interface Companion {
  state: CompState;
  /** 一句状态：在做什么 / 排在哪一步 / 做完几步 / 空闲 / 歇着. */
  text: string;
  /** 排在第几步（0 起，PlanStep.index）：queued 时有. */
  nextIndex?: number;
  /** 正在做的步骤（0 起）：busy 时尽量给. */
  stepIndex?: number;
  /** busy 时的细分：thinking / tool / waiting（等你）/ paused. */
  activity?: AgentActivity;
  /** 它被停用、步骤由遐蝶接手：该运行里指给它的步骤数. */
  takenOver?: number;
  /** busy 且是替别人做（停用接手）：原本指给的那个 Agent；她替它做事时自称，不说第三人称. */
  asFor?: AgentId;
}

export interface Companions {
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  status?: RunStatus;
  /** 运行是否还在进行（queued / running / paused / awaiting）. */
  open: boolean;
  /** 正在做的那一步（0 起）、总步数与已结束的步数（完成 / 跳过）. */
  step?: { index: number; total: number; done: number };
  agents: Record<AgentId, Companion>;
}

const stamp = (r: Run) => Math.max(r.createdAt, r.startedAt ?? 0, r.endedAt ?? 0);
const executorOf = (st: Pick<PlanStep, 'agentId' | 'ranAs'>): AgentId => st.ranAs ?? st.agentId;

/** 选哪个运行：当前任务的进行中运行 > 最近活动的进行中运行 > 最近结束的运行 > 无. */
export function pickRun(s: AppState, preferTaskId?: string): Run | undefined {
  const mine = preferTaskId ? s.tasks[preferTaskId]?.runIds.at(-1) : undefined;
  const mineRun = mine ? s.runs[mine] : undefined;
  if (mineRun && isOpenRun(mineRun.status)) return mineRun;
  let open: Run | undefined;
  let closed: Run | undefined;
  for (const r of Object.values(s.runs)) {
    if (isOpenRun(r.status)) { if (!open || stamp(r) > stamp(open)) open = r; }
    else if (r.endedAt && (!closed || r.endedAt > (closed.endedAt ?? 0))) closed = r;
  }
  return open ?? closed;
}

const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n)}…` : t);

export function selectCompanions(s: AppState, preferTaskId?: string): Companions {
  const run = pickRun(s, preferTaskId);
  const open = !!run && isOpenRun(run.status);
  const task = run ? s.tasks[run.taskId] : undefined;
  const agents = {} as Record<AgentId, Companion>;
  const current = run && open ? run.plan.find((st) => st.status === 'running' || st.status === 'awaiting') : undefined;

  for (const id of AGENT_ORDER) {
    const def = s.agents.find((a) => a.id === id);
    const enabled = id === 'orchestrator' || def?.enabled !== false;
    const taken = run ? run.plan.filter((st) => st.agentId === id && st.ranAs && st.ranAs !== id).length : 0;
    if (!enabled) { agents[id] = { state: 'off', text: taken ? '歇着，步骤交还遐蝶' : '歇着', takenOver: taken || undefined }; continue; }
    if (!run) { agents[id] = { state: 'idle', text: '空闲' }; continue; }
    if (open && run.live?.agentId === id) {
      const own = run.plan.find((st) => executorOf(st) === id && (st.status === 'running' || st.status === 'awaiting'));
      const asFor = own?.ranAs && own.ranAs !== own.agentId ? own.agentId : undefined;
      // 接手的步骤，live.text 末尾带「（接手审查）」之类的括注：那是写给事件流的，她自己说话时不再重复.
      const doing = asFor ? (run.live.text || '').replace(/[（(]接手[^）)]*[）)]\s*$/, '').trim() : run.live.text;
      agents[id] = { state: 'busy', text: clip(doing || '在做', 24), activity: agentActivity(s, run, id), stepIndex: own?.index, asFor };
      continue;
    }
    const next = run.plan.find((st) => st.agentId === id && (st.status === 'pending' || st.status === 'awaiting'));
    if (open && next) { agents[id] = { state: 'queued', text: `第 ${next.index + 1} 步 · ${clip(next.title, 12)}`, nextIndex: next.index }; continue; }
    const done = run.plan.filter((st) => executorOf(st) === id && st.status === 'done' && !st.carried).length;
    if (done > 0) { agents[id] = { state: 'done', text: `做完 ${done} 步` }; continue; }
    agents[id] = id === 'orchestrator' && run.status === 'completed' ? { state: 'done', text: '汇总写完' } : { state: 'idle', text: '空闲' };
  }

  return {
    runId: run?.id, taskId: task?.id, taskTitle: task?.title, status: run?.status, open,
    step: run && current ? { index: current.index, total: run.plan.length, done: run.plan.filter((st) => st.status === 'done' || st.status === 'skipped').length } : undefined,
    agents,
  };
}

/** 遐蝶「在旁看着」：有运行、同伴在做、她自己没在执行。牌面缎带、同行节点、同行简版都读这一处，同一屏里不会一处写「空闲」一处写「在旁看着」. */
export function isWatching(comps: Companions): boolean {
  return comps.open && comps.agents.orchestrator.state === 'idle' && AGENT_ORDER.some((o) => o !== 'orchestrator' && comps.agents[o].state === 'busy');
}

const sameCompanion = (a: Companion, b: Companion) => shallow(a, b);
export function sameCompanions(a: Companions, b: Companions): boolean {
  if (a === b) return true;
  if (a.runId !== b.runId || a.taskId !== b.taskId || a.taskTitle !== b.taskTitle || a.status !== b.status || a.open !== b.open) return false;
  if (!shallow(a.step, b.step)) return false;
  return AGENT_ORDER.every((id) => sameCompanion(a.agents[id], b.agents[id]));
}

/** 三张小牌的派活顺序（罗马序号）：取该运行 plan[].agentId 的首次出现顺序（去重、只含三位同伴），没出现的按默认顺序补在后面；没有运行用默认. */
export function dispatchOrder(s: AppState, runId?: string): AgentId[] {
  const run = runId ? s.runs[runId] : undefined;
  const seen: AgentId[] = [];
  for (const st of run?.plan ?? []) if (st.agentId !== 'orchestrator' && !seen.includes(st.agentId)) seen.push(st.agentId);
  for (const id of DEFAULT_DISPATCH) if (!seen.includes(id)) seen.push(id);
  return seen;
}
export const sameList = <T,>(a: readonly T[], b: readonly T[]) => a === b || (a.length === b.length && a.every((x, i) => x === b[i]));

/* ───────────── 队伍行迹 ───────────── */

export interface TrailRow {
  stepId: string;
  index: number;
  agentId: AgentId;
  title: string;
  status: StepStatus;
  /** 最近一次动静：做完的时刻，否则开始的时刻；还没开始 = undefined. */
  at?: number;
  note?: string;
  /** 由谁接手执行（停用接手）. */
  ranAs?: AgentId;
}

export interface TeamTrail { rows: TrailRow[]; total: number }

/** 取 run.plan 里最近有动静的 n 步（新的在前）；不够 n 步时用还没开始的补足. total = 计划总步数（「看全部 N 条」）. */
export function selectTeamTrail(s: AppState, runId: string | undefined, n: number): TeamTrail {
  const run = runId ? s.runs[runId] : undefined;
  if (!run) return { rows: [], total: 0 };
  const rows: TrailRow[] = run.plan.map((st) => ({
    stepId: st.id, index: st.index, agentId: st.agentId, title: st.title, status: st.status,
    at: st.endedAt ?? st.startedAt, note: st.note, ranAs: st.ranAs && st.ranAs !== st.agentId ? st.ranAs : undefined,
  }));
  const started = rows.filter((r) => r.at !== undefined).sort((a, b) => (b.at ?? 0) - (a.at ?? 0) || b.index - a.index);
  const waiting = rows.filter((r) => r.at === undefined).sort((a, b) => a.index - b.index);
  return { rows: [...started, ...waiting].slice(0, n), total: rows.length };
}
export function sameTrail(a: TeamTrail, b: TeamTrail): boolean {
  return a === b || (a.total === b.total && a.rows.length === b.rows.length && a.rows.every((r, i) => shallow(r, b.rows[i])));
}

/* ───────────── 近 7 天完成步骤 ───────────── */

export type AgentWeek = Record<AgentId, number[]>;
const DAY = 86_400_000;

/** 本地日零点. */
export function dayStart(at: number): number { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.getTime(); }

/** 每个 Agent 近 7 天（含今天，旧 → 新）每天完成的步骤数：按 plan[].endedAt 的本地日分桶，只数 done，排除 carried；记在执行者名下（与「完成步骤」同口径）. */
export function selectAgentWeek(s: AppState, now: number = Date.now()): AgentWeek {
  const out = Object.fromEntries(AGENT_ORDER.map((id) => [id, new Array<number>(7).fill(0)])) as AgentWeek;
  const today = dayStart(now);
  for (const run of Object.values(s.runs)) {
    for (const st of run.plan) {
      if (st.status !== 'done' || st.carried || !st.endedAt) continue;
      const back = Math.round((today - dayStart(st.endedAt)) / DAY);
      if (back < 0 || back > 6) continue;
      const who = out[executorOf(st)];
      if (who) who[6 - back] += 1;
    }
    // 编排自己的排序与汇总（plan 生成 + 汇总）不在 plan[] 里：每个做完的运行按 run.endedAt 记遐蝶一步，与牌背「完成步骤」同口径.
    if (run.status === 'completed' && run.endedAt) {
      const back = Math.round((today - dayStart(run.endedAt)) / DAY);
      if (back >= 0 && back <= 6) out.orchestrator[6 - back] += 1;
    }
  }
  return out;
}
export function sameWeek(a: AgentWeek, b: AgentWeek): boolean {
  return a === b || AGENT_ORDER.every((id) => shallow(a[id], b[id]));
}

/* ───────────── 牌面缎带（≤9 个汉字） ───────────── */

/** 牌面缎带的话与状态：「空闲」「在旁看着」「在做 · 第 2 步」「待你」「第 3 步 · 待命」「已歇下」「已暂停」「本轮做完」. */
export function ribbonOf(enabled: boolean, c: Companion, watching = false): { text: string; tone: 'idle' | 'busy' | 'wait' | 'off' } {
  if (!enabled || c.state === 'off') return { text: '已歇下', tone: 'off' };
  // 有运行、同伴在做、她自己没在执行：不写「空闲」（页头写在场、右栏写在做，四处同一个说法）.
  if (watching && c.state === 'idle') return { text: '在旁看着', tone: 'idle' };
  if (c.state === 'busy') {
    if (c.activity === 'waiting') return { text: '待你', tone: 'wait' };
    if (c.activity === 'paused') return { text: '已暂停', tone: 'idle' };
    return { text: c.stepIndex !== undefined ? `在做 · 第 ${c.stepIndex + 1} 步` : '在做', tone: 'busy' };
  }
  if (c.state === 'queued') return { text: `第 ${(c.nextIndex ?? 0) + 1} 步 · 待命`, tone: 'idle' };
  if (c.state === 'done') return { text: '本轮做完', tone: 'idle' };
  return { text: '空闲', tone: 'idle' };
}
