import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { stickerOf } from '../components/her/logic';
import { isClosure } from '../lib/closure';
import { useNow } from '../lib/hooks';
import { hasDraft } from '../lib/draft';
import { isComposingNow, subscribeComposing } from '../lib/ime';
import { continuousMinutes, continuousSince } from '../lib/presence';
import { orchestratorWord } from '../lib/mood';
import { isOpenRun } from '../lib/status';
import type { AgentActivity, AgentId, AppState, Approval, Distance, ExprId, Message, QueueItem, Run, RunStatus, Task } from '../lib/types';
import { say, voiceSeed, type Slots, type VoiceCtx } from '../lib/voice';
import { persistMode } from './persist';
import { deriveQueue, queueReady, sameQueue } from './queue';
import { shallow, useApp } from './store';
import { isCrisisDay, unansweredHer, type GateSnap } from './voiceGate';

export type TaskStatus = RunStatus | 'draft';

export const currentTask = (s: AppState): Task | undefined => (s.selectedTaskId ? s.tasks[s.selectedTaskId] : undefined);

/** The run shown in the workspace: the selected one if it belongs to the task, else the latest. */
export function currentRun(s: AppState): Run | undefined {
  const task = currentTask(s);
  if (!task) return undefined;
  const id = s.selectedRunId && task.runIds.includes(s.selectedRunId) ? s.selectedRunId : task.runIds[task.runIds.length - 1];
  return id ? s.runs[id] : undefined;
}

export function latestRun(s: AppState, task: Task): Run | undefined {
  const id = task.runIds[task.runIds.length - 1];
  return id ? s.runs[id] : undefined;
}

export function taskStatus(s: AppState, task: Task): TaskStatus {
  return latestRun(s, task)?.status ?? 'draft';
}

export const openRuns = (s: AppState): Run[] => Object.values(s.runs).filter((r) => isOpenRun(r.status));

/** Pending approvals across every task, oldest first. */
export function pendingApprovals(s: AppState): Approval[] {
  return Object.values(s.runs).flatMap((r) => r.approvals.filter((a) => a.status === 'pending')).sort((a, b) => a.createdAt - b.createdAt);
}

/** `done` counts steps that really ran to completion; skipped steps (rejected approval, disabled tool)
 *  are counted apart so "4/5" never hides a step that did not run. `finished` = done + skipped. */
export function stepProgress(run?: Run) {
  if (!run) return { done: 0, skipped: 0, finished: 0, total: 0, current: -1 };
  const done = run.plan.filter((st) => st.status === 'done').length;
  const skipped = run.plan.filter((st) => st.status === 'skipped').length;
  const current = run.plan.findIndex((st) => st.status === 'running' || st.status === 'awaiting');
  return { done, skipped, finished: done + skipped, total: run.plan.length, current };
}

/** What an agent is doing in the context of a run. */
export function agentActivity(_s: AppState, run: Run | undefined, agentId: AgentId): AgentActivity {
  if (!run || !isOpenRun(run.status)) return 'idle';
  if (run.live?.agentId !== agentId) return 'idle';
  if (run.status === 'paused') return 'paused';
  if (run.status === 'awaiting') return 'waiting';
  return run.live.activity;
}

/** 编排者（遐蝶）在这次运行里的出场方式（唯一来源）. 运行还开着、别的 Agent 在做 = watching；她自己在执行（接手 / 汇总）= doing（带第几步）；其余 = idle（没有运行 / 运行已结束 / 此刻没人在做）.
 *  word 只在 watching / doing 时有值——页头胶囊、右栏名牌下的状态词、右栏「活跃 Agent」里她那一行、Agent 页缎带都读它；idle 时各处照旧用阶段词 / 闲时词. */
export interface OrchestratorPresence { kind: 'idle' | 'watching' | 'doing'; stepIndex?: number; word?: string }
const IDLE_PRESENCE: OrchestratorPresence = { kind: 'idle' };
export function selectOrchestratorPresence(s: AppState, runId: string | undefined): OrchestratorPresence {
  const run = runId ? s.runs[runId] : undefined;
  if (!run || !isOpenRun(run.status) || !run.live) return IDLE_PRESENCE;
  if (run.live.agentId !== 'orchestrator') return { kind: 'watching', word: orchestratorWord({ watching: true }) };
  const own = run.plan.find((st) => (st.ranAs ?? st.agentId) === 'orchestrator' && (st.status === 'running' || st.status === 'awaiting'));
  return { kind: 'doing', stepIndex: own?.index, word: orchestratorWord({ stepIndex: own?.index }) };
}
const samePresence = (a: OrchestratorPresence, b: OrchestratorPresence) => a.kind === b.kind && a.stepIndex === b.stepIndex && a.word === b.word;
export const useOrchestratorPresence = (runId: string | undefined): OrchestratorPresence => useApp((s) => selectOrchestratorPresence(s, runId), samePresence);

/** Wall time of a run: from start to end, or to now while it is open. */
export function wallMs(run: Run, now: number) {
  if (!run.startedAt) return 0;
  return (run.endedAt ?? now) - run.startedAt;
}

export const runLabel = (run: Pick<Run, 'attempt'>) => `运行 #${run.attempt}`;

/* ───────────── 待你、她的话（B4） ───────────── */

let queueCache: { runs: AppState['runs']; tasks: AppState['tasks']; items: QueueItem[] } | undefined;
/** 待你队列：只依赖 runs 与 tasks，引擎每秒五次的计时提交不会让它重算出不同的结果（按引用缓存）. */
export function selectQueue(s: AppState): QueueItem[] {
  if (queueCache && queueCache.runs === s.runs && queueCache.tasks === s.tasks) return queueCache.items;
  const items = deriveQueue(s);
  queueCache = { runs: s.runs, tasks: s.tasks, items };
  return items;
}

/** 待你队列（key 与等待起点没变就不重绘）. */
export const useQueue = (): QueueItem[] => useApp(selectQueue, sameQueue);

/** 数据是否已经读完（桌面版启动时读库是异步的）。没读完时「待你」写「—」，首页也不说「没有在等的事」. */
export function useDataReady(): boolean {
  const [ready, setReady] = useState(() => persistMode().ready);
  useEffect(() => {
    if (ready) return;
    const id = window.setInterval(() => { if (persistMode().ready) { setReady(true); window.clearInterval(id); } }, 250);
    return () => window.clearInterval(id);
  }, [ready]);
  return ready;
}

/** 队列数据可用：状态里有任务与运行表，并且库已经读完. 左栏、待你页、首页共用. */
export function useQueueReady(): boolean {
  const shaped = useApp((s) => queueReady(s));
  return useDataReady() && shaped;
}

/** 旧 distance 垫片的有效值（D17）：关掉角色口吻（或旧存档 distance 0）= 0；话量多（或旧存档 distance 2）= 2；其余 1.
 *  新旧两个字段在正常状态里互相派生、结论一致；这里两边都认，是为了兼容只写了其中一个的旧存档与测试夹具. */
export function distanceOf(settings: Pick<AppState['settings'], 'persona' | 'distance' | 'level'>): Distance {
  if (settings.persona === false || settings.distance === 0) return 0;
  return settings.level === 'l' || settings.distance === 2 ? 2 : 1;
}
/** 她现在说话的距离：关掉人设（旧存档）等同于 0. */
export const effectiveDistance = (s: AppState): Distance => distanceOf(s.settings);
/** 角色口吻开着吗（组件一律用它，不自己读 settings.distance / effectiveDistance；施工图 §6-5）. */
export const personaOn = (s: AppState): boolean => distanceOf(s.settings) !== 0;

/** say() 的 React 版：自带距离、称呼与日期种子. `index` 递增让同一天里同一场景连着出现时也换一条. */
export function useSay(project = '') {
  const distance = useApp(effectiveDistance);
  const callName = useApp((s) => s.settings.callName);
  const day = new Date(useNow(60_000)).toDateString();
  return useMemo(
    () => (scene: string, slots: Slots = {}, index: number | string = 0) =>
      say(scene, slots, { distance, callName, seed: voiceSeed(Date.now(), project, index) }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day` 只用来在跨过午夜时换一条
    [distance, callName, project, day],
  );
}

/* ───────────── 额度条 L0（Q03）：本次 / 今日 / 本周，一律「估算」，缺数据写「—」 ───────────── */

/** 一格：有费用写 $0.42，不到一分钱写 <$0.01；没有费用只有 token 就写 token 数；都没有写「—」. 永远不换算成百分比. */
export function quotaCell(costUsd: number | undefined, tokens: number | undefined): string {
  if (costUsd !== undefined && Number.isFinite(costUsd) && costUsd >= 0) return costUsd > 0 && costUsd < 0.01 ? '<$0.01' : `$${costUsd.toFixed(2)}`;
  if (tokens !== undefined && Number.isFinite(tokens) && tokens > 0) return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(1)}M tok` : tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k tok` : `${tokens} tok`;
  return '—';
}

/** 「本次」＝工作区里正在看的那次运行；没有就取最近创建的运行. 没有任何运行：undefined. */
export function thisRunUsage(s: AppState): { costUsd?: number; tokens: number } | undefined {
  let run = currentRun(s);
  if (!run) for (const r of Object.values(s.runs)) if (!run || r.createdAt > run.createdAt) run = r;
  if (!run) return undefined;
  return { costUsd: run.costUsd, tokens: (run.usage?.inputTokens ?? 0) + (run.usage?.outputTokens ?? 0) };
}

/* ───────────── 步骤 0 契约：她的话量 / 退后 / 神色一路（施工图 §3.4、§3.8、§5.1）。【桩】V2 接管 ───────────── */

/** 说话上下文 {level, persona, theme}：调用方不自己读 settings.distance，一律用它（或非 React 的 voiceNow()）. */
export function useVoice(): VoiceCtx {
  return useApp((s): VoiceCtx => ({ level: s.settings.level ?? 'm', persona: personaOn(s), theme: s.settings.mode }), shallow);
}


const HER_AGENTS: ReadonlySet<AgentId | undefined> = new Set<AgentId | undefined>([undefined, 'orchestrator']);
/** 她（遐蝶 / 编排）的话：agent 角色、编排署名、不是报错. 子 Agent 的话是内容层语气，不计入神色一路. */
export const isHerMessage = (m: Message) => m.role === 'agent' && HER_AGENTS.has(m.agentId) && m.kind !== 'error';

export type RetreatWhy = 'approval' | 'question' | 'plan' | 'failed' | 'ime' | 'quiet';

/** 任务当前要看的那次运行：选中的任务用工作区里选的，其余取最新. */
function runOfTask(s: AppState, taskId: string): Run | undefined {
  const t = s.tasks[taskId];
  if (!t) return undefined;
  if (s.selectedTaskId === taskId) return currentRun(s);
  return latestRun(s, t);
}

/** 她退半步（§3.8）：当前任务有 pending 审批 / 提问 / 待批计划、run 失败 / 等待，输入法正在组合，或 quietUntil > now.
 *  先看「内容」原因（审批 > 提问 > 计划 > 失败），再看 ime，最后 quiet. 纯函数（now / composing 可传，默认取现在）.
 *  stepBack 设置只管「视觉收起」那一层，由 C1 读；这里照实报状态. */
export function selectRetreat(
  s: AppState,
  taskId: string | undefined,
  now: number = Date.now(),
  composing: boolean = isComposingNow(),
): { retreated: boolean; why?: RetreatWhy } {
  const run = taskId ? runOfTask(s, taskId) : undefined;
  if (run) {
    if (run.approvals?.some((a) => a.status === 'pending')) return { retreated: true, why: 'approval' };
    if (run.questions?.some((q) => q.status === 'pending')) return { retreated: true, why: 'question' };
    if (run.planApproval?.status === 'pending') return { retreated: true, why: 'plan' };
    if (run.status === 'failed') return { retreated: true, why: 'failed' };
    if (run.status === 'awaiting') return { retreated: true, why: 'approval' };
  }
  if (composing) return { retreated: true, why: 'ime' };
  if ((s.quietUntil ?? 0) > now) return { retreated: true, why: 'quiet' };
  return { retreated: false };
}

/** 退后状态的 React 版：输入法组合态不在 store 里，单独订阅；quiet 到点自动翻回. */
export function useRetreat(taskId: string | undefined): { retreated: boolean; why?: RetreatWhy } {
  const composing = useSyncExternalStore(subscribeComposing, isComposingNow, isComposingNow);
  const base = useApp((s) => selectRetreat(s, taskId, Date.now(), false), (a, b) => a.retreated === b.retreated && a.why === b.why);
  const quietUntil = useApp((s) => s.quietUntil ?? 0);
  const [, tick] = useState(0);
  useEffect(() => {
    const left = quietUntil - Date.now();
    if (left <= 0) return;
    const id = window.setTimeout(() => tick((n) => n + 1), Math.min(left + 50, 2_147_000_000));
    return () => window.clearTimeout(id);
  }, [quietUntil]);
  if (base.retreated) return base;
  if (composing) return { retreated: true, why: 'ime' };
  return quietUntil > Date.now() ? { retreated: true, why: 'quiet' } : { retreated: false };
}

export type TrailKind = 'expr' | 'plan' | 'start' | 'retry' | 'thanks' | 'pending' | 'end';
export interface TrailNode { kind: TrailKind; at: number; expr: ExprId; label?: string }

/** 道谢：运行结束之后，用户有一句闭合语（落蝶标记，或按同一判据重算）. 取最晚的一句. */
function thanksNodeAt(t: Task, run: Run): number | undefined {
  const from = run.endedAt ?? 0;
  let found: number | undefined;
  let prev: Message | undefined;
  for (const m of t.messages) {
    if (m.role === 'user') {
      const hit = m.reaction === 'landing' || (!!prev && isClosure(m.text, { prev: { text: prev.text, kind: prev.kind, src: prev.src, crisis: prev.crisis } }));
      if (m.at >= from && hit) found = m.at;
    } else if (isHerMessage(m)) prev = m;
  }
  return found;
}

/** 右栏神色一路（§3.4）：闲聊 = 最近 5 条她的消息的 expr（缺则固定 gentle，不兜底），旧到新；
 *  工作 = 从 Run 派生的五个节点（计划就绪 / 开工 / 重试 / 道谢 / 待批），按时间排；不读 RunEvent.text. */
export function selectTrail(s: AppState, taskId: string | undefined): TrailNode[] {
  const t = taskId ? s.tasks[taskId] : undefined;
  if (!t) return [];
  if (t.kind === 'chat') {
    // 危机回合、带贴纸的那条消息头像固定 gentle 不画角标（D18 / D19）——右栏照同一口径记，免得头像写 gentle、右栏写「害羞」.
    const stickersOn = s.settings.stickers !== false;
    return t.messages.filter(isHerMessage).slice(-5).map((m): TrailNode => ({
      kind: 'expr', at: m.at, expr: m.crisis || stickerOf(m, stickersOn) ? 'gentle' : m.expr ?? 'gentle',
    }));
  }
  const run = runOfTask(s, t.id);
  if (!run) return [];
  const nodes: TrailNode[] = [];
  const pa = run.planApproval;
  if (run.planReady || pa) {
    nodes.push({ kind: 'plan', at: pa?.status === 'pending' && pa.at ? pa.at : run.startedAt ?? run.createdAt, expr: 'gentle', label: '计划就绪' });
  }
  const stepStart = Math.min(...run.plan.map((p) => p.startedAt ?? Infinity));
  const startAt = pa?.status === 'approved' && pa.at ? pa.at : Number.isFinite(stepStart) ? stepStart : undefined;
  if (startAt !== undefined) nodes.push({ kind: 'start', at: startAt, expr: 'gentle', label: '开工' });
  const soft = (run.errors ?? []).filter((e) => !e.fatal);
  const retryAt = soft.length ? Math.max(...soft.map((e) => e.at)) : run.retryOf ? run.startedAt ?? run.createdAt : undefined;
  if (retryAt !== undefined) nodes.push({ kind: 'retry', at: retryAt, expr: 'confused', label: '重试' });
  const thanksAt = thanksNodeAt(t, run);
  if (thanksAt !== undefined) nodes.push({ kind: 'thanks', at: thanksAt, expr: 'relaxed', label: '道谢' });
  // 收尾节点：做完（relaxed）/ 失败（gentle）/ 放下（gentle）. 从 Run 的状态与时刻派生，和她那一句、状态胶囊同一口径.
  if (run.status === 'completed') nodes.push({ kind: 'end', at: run.endedAt ?? run.startedAt ?? run.createdAt, expr: 'relaxed', label: '做完' });
  // 失败节点写场景名「没走通」（状态口吻，与待批 / 待答同类，不写情绪词「抱歉」）；放下时失败与放下是同一件事，合成一个「放下」节点，不并排列两个同时刻的节点.
  if (run.laidDownAt) nodes.push({ kind: 'end', at: run.laidDownAt, expr: 'gentle', label: '放下' });
  else if (run.status === 'failed') {
    const fatalAt = [...(run.errors ?? [])].reverse().find((e) => e.fatal)?.at;
    nodes.push({ kind: 'end', at: run.endedAt ?? fatalAt ?? run.startedAt ?? run.createdAt, expr: 'gentle', label: '没走通' });
  }
  // 等着的事：审批 = 待批，提问 = 待答（第 3 轮评审：提问卡等回答时不能写「待批」）. 两种同时在等时，节点时刻取最早的，标签按那一项的类型.
  const waits = [
    ...(run.approvals ?? []).filter((a) => a.status === 'pending').map((a) => ({ at: a.createdAt, label: '待批' })),
    ...(run.questions ?? []).filter((q) => q.status === 'pending').map((q) => ({ at: q.createdAt, label: '待答' })),
  ];
  if (waits.length) {
    const first = waits.reduce((a, b) => (b.at < a.at ? b : a));
    nodes.push({ kind: 'pending', at: first.at, expr: 'gentle', label: first.label });
  }
  return nodes.sort((a, b) => a.at - b.at);
}

/** 新闲聊的空态：她先开场（对话区的 HerOpening，不进对话流、不带神色记录）. 右栏「神色一路」空态据此写「刚开口，还没有神色变化」，
 *  而不是「她还没有开口」（第 2 轮评审：开场句已经说了，右栏不能说她没开口）. 口吻关着（personaOn 为假）时没有开场. */
export function herOpened(s: AppState, taskId: string | undefined): boolean {
  const t = taskId ? s.tasks[taskId] : undefined;
  return !!t && t.kind === 'chat' && t.messages.length === 0 && personaOn(s);
}
/** 神色一路的空态文案（右栏）. */
export const TRAIL_EMPTY = { opened: '刚开口，还没有神色变化。', silent: '她还没有开口。' } as const;

const sameTrail = (a: TrailNode[], b: TrailNode[]) =>
  a.length === b.length && a.every((n, i) => n.kind === b[i].kind && n.at === b[i].at && n.expr === b[i].expr && n.label === b[i].label);
/** 神色一路的 React 版（节点没变就不重绘）. */
export const useTrail = (taskId: string | undefined): TrailNode[] => useApp((s) => selectTrail(s, taskId), sameTrail);

/** 她此刻要不要「在听」（D18）：这个任务里今天有过危机回合，或总闸记了危机当天. 名牌旁的神色词（对话页头、顶栏、右栏龛）共用这一个结果，
 *  不回退到小状态的活动词（在读书……）. taskId 缺省只看危机当天. 纯函数（now 可传）. */
export function selectHerCrisis(s: AppState, taskId: string | undefined, now: number = Date.now()): boolean {
  if (isCrisisDay(now)) return true;
  const t = taskId ? s.tasks[taskId] : undefined;
  if (!t) return false;
  const day = new Date(now).toDateString();
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (new Date(m.at).toDateString() !== day) break;
    if (m.crisis) return true;
  }
  return false;
}
/** 神色词用的危机判断的 React 版（布尔值，没变就不重绘）. */
export const useHerCrisis = (taskId: string | undefined): boolean => useApp((s) => selectHerCrisis(s, taskId));

/* ───────────── 话语总闸的快照（施工图 §3.6a）：从 store 拼，voiceGate 只看这份 ───────────── */

/** 从 store 拼一份总闸快照。taskId 缺省 = 当前选中的任务. voiceGate.ts 自己不 import 本文件（免得经 persist → live 绕成环）. */
export function makeGateSnap(s: AppState, now: number, taskId: string | undefined = s.selectedTaskId): GateSnap {
  const set = s.settings;
  const composing = isComposingNow();
  const retreat = selectRetreat(s, taskId, now, composing);
  const t = taskId ? s.tasks[taskId] : undefined;
  return {
    level: set.level ?? 'm',
    persona: set.persona !== false && set.distance !== 0,
    proactive: set.proactive ?? (set.lifeNudge ? 'auto' : 'off'),
    lifeGreeting: !!set.lifeGreeting,
    quietUntil: s.quietUntil ?? 0,
    retreated: retreat.retreated && retreat.why !== 'ime',
    composing,
    taskId,
    hasDraft: taskId ? hasDraft(taskId) : false,
    continuousMinutes: continuousMinutes(now),
    retreatWhy: retreat.why,
    unanswered: t ? unansweredHer(t.messages) : false,
    continuousSince: continuousSince(now),
  };
}
