/* Bookkeeping that every part of the state layer shares: the event log, toasts and screen-reader
   announcements, the run clock (active time), and the controls that act on any run (pause on reload,
   cancel). Carrying a task out is live.ts's job — nothing in here talks to a model or runs a command.
   All functions take an immer draft, so they can be called from inside any store.update. */
import type { Draft } from 'immer';
import type { AgentId, AppState, PlanStep, ProviderId, Question, Run, RunEvent, Toast, UsageRecord } from '../lib/types';
import { uid } from './store';

type D = Draft<AppState>;
type DRun = Draft<Run>;

export const TICK_MS = 200;
export const EVENT_CAP = 600;

/* ───────────────────────── feedback helpers ───────────────────────── */

export function pushEvent(d: D, e: Omit<RunEvent, 'id' | 'at'> & { at?: number }) {
  d.events.push({ id: uid('evt'), at: e.at ?? Date.now(), ...e });
  if (d.events.length > EVENT_CAP) d.events.splice(0, d.events.length - EVENT_CAP);
}

export function toast(d: D, t: Omit<Toast, 'id' | 'createdAt' | 'ttl'> & { ttl?: number }) {
  const ttl = t.ttl ?? (t.tone === 'danger' ? 9000 : t.tone === 'warning' ? 7000 : 4500);
  if (t.key) dropToasts(d, t.key);
  d.toasts.push({ id: uid('toast'), createdAt: Date.now(), ...t, ttl });
  if (d.toasts.length > 3) d.toasts.splice(0, d.toasts.length - 3);
}

/** Remove toasts whose subject has been dealt with. */
export function dropToasts(d: D, key: string) {
  if (d.toasts.some((x) => x.key === key)) d.toasts = d.toasts.filter((x) => x.key !== key);
}

export function announce(d: D, text: string) {
  d.announcement = { text, at: Date.now() };
}

/** A task counts as updated whenever something visible happens to it (not on every tick). */
export function touch(d: D, taskId: string, now: number) {
  const task = d.tasks[taskId];
  if (task) task.updatedAt = now;
}

/* ───────────────────────── run clock ───────────────────────── */

/** Real active time (excludes paused / awaiting): counted on the run and on the step it is working on. */
function addActive(run: DRun, dt: number) {
  run.activeMs += dt;
  if (run.cursor.phase !== 'executing') return;
  const step = run.plan[run.cursor.step];
  if (step && (step.status === 'running' || step.status === 'pending')) step.activeMs = (step.activeMs ?? 0) + dt;
}

export const needsTick = (s: AppState) => Object.values(s.runs).some((r) => r.status === 'running');

/** live.ts moves the runs themselves; the clock only counts the time they spend running. */
export function tick(d: D, _now: number, dt: number) {
  for (const run of Object.values(d.runs)) if (run.status === 'running') addActive(run, dt);
}

/* ───────────────────────── run controls ───────────────────────── */

export function findApproval(d: D | AppState, approvalId: string) {
  for (const run of Object.values(d.runs)) {
    const approval = run.approvals.find((a) => a.id === approvalId);
    if (approval) return { run, approval };
  }
  return undefined;
}

export function pauseRun(d: D, run: DRun, reason: 'user' | 'reload', now: number) {
  if (run.status !== 'running' && run.status !== 'awaiting') return false;
  run.pausedFrom = run.status;
  run.status = 'paused';
  run.pauseReason = reason;
  // 重启中断不 touch 任务（不是使用者的操作）：「被中断了」的时刻单独记，否则任务页开着时 lastSeenAt 不早于 updatedAt，这次中断就永远进不了「待你」
  if (reason === 'reload') run.interruptedAt = now;
  if (run.live) run.live.activity = 'paused';
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: reason === 'user' ? 'info' : 'warn',
    text: reason === 'reload' ? `页面重新载入，运行 #${run.attempt} 已暂停` : `运行 #${run.attempt} 已暂停` });
  if (reason !== 'reload') touch(d, run.taskId, now);
  return true;
}

/** Remove toasts whose action would resume this run. */
export function dropResumeToasts(d: D, runId: string) {
  const stale = (t: Draft<Toast>) => t.action?.command.type === 'resume-run' && t.action.command.runId === runId;
  if (d.toasts.some(stale)) d.toasts = d.toasts.filter((t) => !stale(t));
}

/** Marks the run, its steps, calls and approvals as cancelled. Stopping the agent itself is live.cancelLive's part. */
export function cancelRun(d: D, run: DRun, now: number) {
  if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') return false;
  const task = d.tasks[run.taskId];
  run.status = 'cancelled';
  run.endedAt = now;
  run.cursor.phase = 'done';
  run.live = undefined;
  run.pausedFrom = undefined;
  run.pauseReason = undefined;
  for (const step of run.plan) {
    if (step.status === 'running' || step.status === 'awaiting') { step.status = 'cancelled'; step.endedAt = now; step.note = '运行被取消时正在执行'; }
    else if (step.status === 'pending') step.status = 'cancelled';
  }
  for (const call of run.toolCalls) if (call.status === 'running' || call.status === 'awaiting') Object.assign(call, { status: 'cancelled', endedAt: now });
  for (const approval of run.approvals) {
    if (approval.status !== 'pending') continue;
    approval.status = 'expired';
    dropToasts(d, `approval:${approval.id}`);
  }
  expireOpenAsks(d, run, now);
  task?.messages.push({ id: uid('msg'), role: 'system', runId: run.id, at: now, text: `运行 #${run.attempt} 已取消。已生成的产物仍保留在「产物」中。` });
  pushEvent(d, { at: now, runId: run.id, kind: 'run', level: 'warn', text: `运行 #${run.attempt} 已取消` });
  touch(d, run.taskId, now);
  dropResumeToasts(d, run.id);
  return true;
}

/* ───────────────────────── 计划审批（K11） ───────────────────────── */

export const PLAN_STEP_CAP = 8;

/** 计划出来了：先停下来等使用者批准（萤火是直接执行，栖枝不是）。run 进入 awaiting. */
export function awaitPlanApproval(d: D, run: DRun, now: number) {
  // at = 计划就绪、开始等你的时刻（「待你」里的等待时长、通知的新旧都从它算；不能拿运行开始时间——规划本身可能就要好几分钟）
  run.planApproval = { status: 'pending', at: now, edited: run.planApproval?.edited };
  if (run.status === 'running') run.status = 'awaiting';
  run.live = { agentId: 'orchestrator', activity: 'waiting', text: '等你批准计划' };
  pushEvent(d, { at: now, runId: run.id, kind: 'step', level: 'warn', text: `计划已生成（${run.plan.length} 步），等你批准` });
  touch(d, run.taskId, now);
}

/** 批准（edited 在编辑时已经记上）。返回 false = 不在等批准. */
export function approvePlan(d: D, run: DRun, now: number) {
  if (run.planApproval?.status !== 'pending') return false;
  run.planApproval = { status: 'approved', at: now, edited: run.planApproval.edited };
  if (run.status === 'awaiting') run.status = 'running';
  run.live = { agentId: 'orchestrator', activity: 'thinking', text: '计划已批准，开始执行' };
  pushEvent(d, { at: now, runId: run.id, kind: 'step', level: 'success', text: run.planApproval.edited ? '你修改并批准了计划' : '你批准了计划' });
  dropToasts(d, `plan:${run.id}`);
  touch(d, run.taskId, now);
  return true;
}

export interface PlanDraftStep { id?: string; title: string; detail: string; agentId: AgentId }

/** 批准前编辑计划：改标题 / 说明 / 负责的 Agent，删步骤，调顺序，加步骤。只在等批准时允许. */
export function editPlanDraft(run: DRun, steps: PlanDraftStep[], allowed: AgentId[]): { ok: true } | { ok: false; error: string } {
  if (run.planApproval?.status !== 'pending') return { ok: false, error: '计划不在等批准的状态，不能再编辑。' };
  const clean = steps
    .map((x) => ({
      id: x.id,
      title: String(x.title ?? '').trim().slice(0, 40),
      detail: String(x.detail ?? '').trim().slice(0, 300),
      agentId: allowed.includes(x.agentId) ? x.agentId : ('orchestrator' as AgentId),
    }))
    .filter((x) => x.title);
  if (!clean.length) return { ok: false, error: '计划至少要有一步，并且每一步要有标题。' };
  if (clean.length > PLAN_STEP_CAP) return { ok: false, error: `计划最多 ${PLAN_STEP_CAP} 步。` };
  const old = new Map(run.plan.map((st) => [st.id, st]));
  run.plan = clean.map((x, index): PlanStep => {
    const prev = x.id ? old.get(x.id) : undefined;
    return { id: prev?.id ?? uid('step'), index, title: x.title, detail: x.detail, agentId: x.agentId, status: 'pending', toolCallIds: [] };
  }) as typeof run.plan;
  run.planApproval = { status: 'pending', at: run.planApproval.at, edited: true };   // 改计划不重置等待时钟
  return { ok: true };
}

/* ───────────────────────── 提问（K12） ───────────────────────── */

export interface AskedQuestion { question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }

/** AskUserQuestion 的问题进 run.questions（pending），run 进入 awaiting。返回新问题的 id（同一次提问的几个问题合并成一次打断）. */
export function addQuestions(d: D, run: DRun, asked: AskedQuestion[], now: number): string[] {
  run.questions ??= [];
  const ids: string[] = [];
  for (const q of asked) {
    const item: Question = {
      id: uid('qst'), runId: run.id, taskId: run.taskId, header: q.header, question: q.question || '（没有写问题）',
      options: q.options.map((o) => ({ label: o.label, description: o.description })), multiSelect: q.multiSelect || undefined, status: 'pending', createdAt: now,
    };
    run.questions.push(item);
    ids.push(item.id);
  }
  if (run.status === 'running') run.status = 'awaiting';
  const first = asked[0];
  run.live = { agentId: 'orchestrator', activity: 'waiting', text: `等你回答：${(first?.question || '问题').slice(0, 40)}` };
  pushEvent(d, { at: now, runId: run.id, kind: 'agent', level: 'warn', text: `有 ${asked.length} 个问题等你回答` });
  touch(d, run.taskId, now);
  return ids;
}

/** 记下一个问题的回答（还没把整组交还模型）。返回这个问题；找不到或已处理返回 undefined. */
export function answerQuestionDraft(run: DRun, questionId: string, answer: string[], now: number) {
  const q = run.questions?.find((x) => x.id === questionId);
  if (!q || q.status !== 'pending') return undefined;
  const given = answer.map((a) => String(a).trim()).filter(Boolean).slice(0, 12);
  if (!given.length) return undefined;
  q.status = 'answered';
  q.answer = given;
  q.answeredAt = now;
  const free = given.filter((a) => !q.options.some((o) => o.label === a));
  q.other = free.length ? free.join('、') : undefined;
  return q;
}

/** 回答完了：没有待答的问题时，run 回到 running. */
export function resumeAfterAnswers(d: D, run: DRun, now: number) {
  if (run.questions?.some((q) => q.status === 'pending')) return;
  if (run.status === 'awaiting' && !run.approvals.some((a) => a.status === 'pending') && run.planApproval?.status !== 'pending') {
    run.status = 'running';
    run.live = { agentId: 'orchestrator', activity: 'thinking', text: '收到回答，继续' };
  }
  dropToasts(d, `question:${run.id}`);
  touch(d, run.taskId, now);
}

/** 运行结束 / 取消 / 失败 / 暂停时，还没人回答的提问作废；等批准的计划在运行结束时一并收掉. */
export function expireOpenAsks(d: D, run: DRun, now: number, opts: { keepPlan?: boolean } = {}) {
  for (const q of run.questions ?? []) if (q.status === 'pending') { q.status = 'cancelled'; q.answeredAt = now; }
  if (!opts.keepPlan && run.planApproval?.status === 'pending') run.planApproval = undefined;
  dropToasts(d, `question:${run.id}`);
  if (!opts.keepPlan) dropToasts(d, `plan:${run.id}`);
}

/* ───────────────────────── 用量记录（K14 采集） ───────────────────────── */

/** 一个回合结束时的 UsageRecord（只有数字，没有内容）。costUsd 只用引擎报告的；没有就 undefined. */
export function buildUsageRecord(a: {
  at: number; taskId: string; runId?: string; provider: ProviderId; model?: string;
  input: number; output: number; cached: number; costUsd?: number; startedAt?: number;
}): UsageRecord {
  const rec: UsageRecord = {
    at: a.at, taskId: a.taskId, runId: a.runId, provider: a.provider, model: a.model || undefined,
    inputTokens: Math.max(0, Math.round(a.input) || 0), outputTokens: Math.max(0, Math.round(a.output) || 0), cachedTokens: Math.max(0, Math.round(a.cached) || 0),
  };
  if (typeof a.costUsd === 'number' && Number.isFinite(a.costUsd) && a.costUsd >= 0) rec.costUsd = a.costUsd;
  if (a.startedAt !== undefined) rec.durationMs = Math.max(0, a.at - a.startedAt);
  return rec;
}
