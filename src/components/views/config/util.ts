/* Shared helpers for the roster / tools / history / settings views: stat selectors, stable-equality
   helpers for useApp, and the permission icons. Nothing here touches the store except through selectors. */
import { Ban, ShieldCheck, Zap, type LucideIcon } from 'lucide-react';
import { isOpenRun } from '../../../lib/status';
import type { AgentActivity, AppState, ToolPermission } from '../../../lib/types';
import { runCounts } from '../../../lib/storeBridge';
import { agentActivity } from '../../../state/selectors';
import { shallow } from '../../../state/store';

export const PERM_ICON: Record<ToolPermission, LucideIcon> = { auto: Zap, confirm: ShieldCheck, off: Ban };

export type Dict<T> = Record<string, T | undefined>;

/** Equality for selectors that build a new record each call: same keys, shallow-equal values. */
export function sameRecord<T>(a: Dict<T>, b: Dict<T>) {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => k in b && shallow(a[k], b[k]));
}

/** Equality for selectors that build a new array of plain row objects each call. */
export function sameList<T>(a: readonly T[], b: readonly T[]) {
  return a === b || (a.length === b.length && a.every((x, i) => shallow(x, b[i])));
}

export interface CallStat { steps: number; calls: number; errors: number }
const blank = (): CallStat => ({ steps: 0, calls: 0, errors: 0 });

/** Agent 页的统计：在 CallStat 之外多「被挡」与「接手」.
 *  denied 只数得到页面里带工具调用的运行；只读了摘要的运行（toolCalls 为空）没有分项，deniedExact=false，界面写「—」或「≥N」（§4.3，不动存储层的 SQL）.
 *  taken：指给这个 Agent、却由别人（遐蝶）接手执行并做完的步骤数（PlanStep.agentId ≠ ranAs，§2.1.4）. */
export interface AgentStat extends CallStat { denied: number; deniedExact: boolean; taken: number }
const blankAgent = (): AgentStat => ({ ...blank(), denied: 0, deniedExact: true, taken: 0 });

/** 启动时只有最近要用的运行带工具调用，其余只读了摘要（toolCalls 为空）：它们的调用数从存储层的登记簿里取. */
function summaryOnly(runId: string, toolCalls: readonly unknown[]) {
  return toolCalls.length === 0 ? runCounts(runId) : undefined;
}

/** Per agent, across every run: finished steps (carried-over steps are not counted twice; a step another agent took over counts for whoever ran it;
 *  a completed run adds one for the orchestrator's own ordering + summary), tool calls, failed calls, calls that were turned down. */
export function selectAgentStats(s: AppState): Dict<AgentStat> {
  const out: Dict<AgentStat> = {};
  for (const run of Object.values(s.runs)) {
    for (const st of run.plan) {
      if (st.status !== 'done' || st.carried) continue;
      (out[st.ranAs ?? st.agentId] ??= blankAgent()).steps++;
      if (st.ranAs && st.ranAs !== st.agentId) (out[st.agentId] ??= blankAgent()).taken++;
    }
    // 编排自己的排序与汇总（plan 生成 + 汇总）不在 plan[] 里：每个做完的运行记遐蝶一步（与近 7 天小柱同口径，按 run.endedAt 计一次）.
    if (run.status === 'completed' && run.endedAt) (out.orchestrator ??= blankAgent()).steps++;
    const lean = summaryOnly(run.id, run.toolCalls);
    if (lean) {
      for (const [agentId, n] of Object.entries(lean.byAgent)) {
        const stat = (out[agentId] ??= blankAgent());
        stat.calls += n.calls;
        stat.errors += n.errors;
        if (n.calls > 0) stat.deniedExact = false;
      }
      continue;
    }
    for (const c of run.toolCalls) {
      const stat = (out[c.agentId] ??= blankAgent());
      stat.calls++;
      if (c.status === 'error') stat.errors++;
      if (c.status === 'denied') stat.denied++;
    }
  }
  return out;
}

/** Per tool, across every run. */
export function selectToolStats(s: AppState): Dict<CallStat> {
  const out: Dict<CallStat> = {};
  for (const run of Object.values(s.runs)) {
    const lean = summaryOnly(run.id, run.toolCalls);
    if (lean) {
      for (const [tool, n] of Object.entries(lean.byTool)) {
        const stat = (out[tool] ??= blank());
        stat.calls += n.calls;
        stat.errors += n.errors;
      }
      continue;
    }
    for (const c of run.toolCalls) {
      const stat = (out[c.tool] ??= blank());
      stat.calls++;
      if (c.status === 'error') stat.errors++;
    }
  }
  return out;
}

export interface Presence { taskId: string; runId: string; title: string; activity: AgentActivity }

/** The open run each agent is currently the live agent of (first one wins). */
export function selectPresence(s: AppState): Dict<Presence> {
  const out: Dict<Presence> = {};
  for (const run of Object.values(s.runs)) {
    if (!isOpenRun(run.status)) continue;
    const id = run.live?.agentId;
    const task = s.tasks[run.taskId];
    if (!id || !task || out[id]) continue;
    out[id] = { taskId: task.id, runId: run.id, title: task.title, activity: agentActivity(s, run, id) };
  }
  return out;
}
