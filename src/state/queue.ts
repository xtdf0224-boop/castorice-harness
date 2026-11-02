/* 「待你」队列（V0α · 模块 B4「交互」，Q01）。
   确定性：同一份 AppState 永远得到同一个顺序；无随机、无模型。数据源缺失时界面显示「—」而不是 0（见 queueReady）。
   类别：待批（approval）/ 待回复（question）/ 计划待批（plan）/ 失败与中断（failed）/ 回合结束待查看（turn-done）。
   排序：rank 升序，再按 since 升序（等得最久的在前），最后按 key 定序——所以结果与对象遍历顺序无关。
   一份数据，三个出口：左栏「待你 · N」、任务栏角标、系统通知，数字必须相等（check-interaction 用 1,000 个随机状态验证）。

   「已看过」的规则（失败与回合结束）：只看每个任务的最新一次运行；任务的 lastSeenAt（任务页打开着、窗口在前台时更新）
   不早于它结束的时刻，就当作已看过，不再出现。lastSeenAt 缺失（旧存档）一律当作已看过，避免第一次启动就冒出一长串. */
import type { AppState, QueueItem, QueueKind, Run, Task } from '../lib/types';
import { waitText } from '../lib/voice';

export const QUEUE_RANK: Record<QueueKind, number> = { approval: 0, question: 1, plan: 2, failed: 3, 'turn-done': 4 };
export const QUEUE_LABEL: Record<QueueKind, string> = { approval: '待批', question: '待回复', plan: '计划待批', failed: '失败', 'turn-done': '待查看' };

const clip = (t: string, n: number) => { const a = Array.from(t.replace(/\s+/g, ' ').trim()); return a.length > n ? `${a.slice(0, n).join('')}…` : a.join(''); };

/** 数据已经就绪（任务与运行表都在）。未就绪时界面写「—」，不写 0. */
export function queueReady(s: AppState | undefined): s is AppState {
  return !!s && !!s.tasks && !!s.runs && typeof s.tasks === 'object' && typeof s.runs === 'object';
}

/** 任务的最新一次运行（只看它是否失败/做完）. */
function latestRunOf(s: AppState, task: Task): Run | undefined {
  const id = task.runIds[task.runIds.length - 1];
  return id ? s.runs[id] : undefined;
}

export function deriveQueue(s: AppState): QueueItem[] {
  if (!queueReady(s)) return [];
  const items: QueueItem[] = [];
  const seen = new Set<string>();
  const push = (it: Omit<QueueItem, 'rank'>) => {
    if (seen.has(it.key)) return;
    seen.add(it.key);
    items.push({ ...it, rank: QUEUE_RANK[it.kind] });
  };

  for (const run of Object.values(s.runs)) {
    const task = s.tasks[run.taskId];
    if (!task) continue; // 任务已删，留下的运行记录不算
    // 只要还标着 pending 就算：模型在等你的回答，却因为运行状态不对而看不见，会让它无声地一直等下去——
    // 宁可多出一条（点开处理失败时界面会说明），也不能少一条. 运行结束时把它们改成 expired / cancelled 是引擎（B3）的事.
    for (const a of run.approvals ?? []) {
      if (a.status !== 'pending') continue;
      push({ key: `approval:${a.id}`, kind: 'approval', taskId: task.id, runId: run.id, refId: a.id, title: a.title, sub: task.title, since: a.createdAt });
    }
    for (const q of run.questions ?? []) {
      if (q.status !== 'pending') continue;
      const head = q.header ? `${q.header}：${q.question}` : q.question;
      push({
        key: `question:${q.id}`, kind: 'question', taskId: task.id, runId: run.id, refId: q.id, title: clip(head, 80),
        sub: `${task.title}${q.options.length ? ` · ${q.options.length} 个选项` : ''}`, since: q.createdAt,
      });
    }
    const pa = run.planApproval;
    if (pa && pa.status === 'pending') {
      push({
        key: `plan:${run.id}`, kind: 'plan', taskId: task.id, runId: run.id, refId: run.id, title: '计划待批准',
        sub: `${task.title}${run.plan.length ? ` · ${run.plan.length} 步` : ''}`, since: pa.at ?? run.startedAt ?? run.createdAt,
      });
    }
  }

  for (const id of Object.keys(s.tasks)) {
    const task = s.tasks[id];
    const seenAt = task.lastSeenAt;
    if (seenAt === undefined) continue;
    const run = latestRunOf(s, task);
    if (run) {
      const interrupted = run.status === 'paused' && run.pauseReason === 'reload';
      // 重启时正等着批准计划的运行：「计划待批准」那一条就是该做的事（批准 / 发回之后运行会接着跑），不再重复出一条「被中断了」
      const planWaiting = run.planApproval?.status === 'pending';
      // 未竟之信「放下」之后（Run.laidDownAt）不再出现在待你里；「改回再试」是任务页上的动作
      if ((run.status === 'failed' || (interrupted && !planWaiting)) && !run.laidDownAt) {
        const at = run.endedAt ?? (interrupted ? run.interruptedAt ?? task.updatedAt : undefined) ?? run.startedAt ?? run.createdAt;
        if (seenAt < at) {
          push({
            key: `failed:${run.id}`, kind: 'failed', taskId: task.id, runId: run.id, refId: run.id,
            title: `${task.title} ${interrupted ? '被中断了' : '没能走到最后'}`,
            sub: clip(run.failure?.message ?? (interrupted ? '应用重启时它正在运行，需要你决定是否继续' : '原因见任务页'), 60), since: at,
          });
        }
      } else if (run.status === 'completed') {
        const at = run.endedAt ?? run.createdAt;
        if (seenAt < at) {
          push({ key: `turn-done:${run.id}`, kind: 'turn-done', taskId: task.id, runId: run.id, refId: run.id, title: task.title, sub: '回合结束', since: at });
        }
      }
    } else if (task.kind === 'chat') {
      // 闲聊没有运行记录：看最后一条消息. 失败的那条算「失败」，正常的算「回合结束」.
      const last = task.messages[task.messages.length - 1];
      if (last && last.role === 'agent' && !last.streaming && seenAt < last.at) {
        if (last.kind === 'error') {
          push({ key: `failed:${task.id}`, kind: 'failed', taskId: task.id, refId: task.id, title: `${task.title} 的回复没能送到`, sub: '原因见闲聊页', since: last.at });
        } else {
          push({ key: `turn-done:${task.id}`, kind: 'turn-done', taskId: task.id, refId: task.id, title: task.title, sub: '回复已到', since: last.at });
        }
      }
    }
  }

  return items.sort((a, b) => a.rank - b.rank || a.since - b.since || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 左栏「待你 · N · 最久 X」与任务栏角标用的汇总. */
export function queueSummary(items: QueueItem[], now: number): { count: number; oldestMs?: number; byKind: Record<QueueKind, number> } {
  const byKind: Record<QueueKind, number> = { approval: 0, question: 0, plan: 0, failed: 0, 'turn-done': 0 };
  for (const i of items) byKind[i.kind] += 1;
  if (!items.length) return { count: 0, byKind };
  return { count: items.length, oldestMs: Math.max(0, now - Math.min(...items.map((i) => i.since))), byKind };
}

/** 等了多久：「1 时 9 分」「不到 1 分」. */
export const waitingText = (since: number, now: number) => waitText(now - since);

/** 两份队列是否一样（selector 的 equal：key 与等待起点都相同才算相同，避免每秒重绘）. */
export function sameQueue(a: QueueItem[], b: QueueItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i].key !== b[i].key || a[i].since !== b[i].since || a[i].title !== b[i].title || a[i].sub !== b[i].sub) return false;
  return true;
}

/** 左栏与读屏用的文案，和 QueueView 页眉共用（check-interaction 直接测这个）. */
export function queueNavModel(ready: boolean, items: QueueItem[], now: number) {
  if (!ready) return { count: undefined as number | undefined, countText: '—', oldest: '', label: '待你：数据还没有读到' };
  const sum = queueSummary(items, now);
  const oldest = sum.oldestMs === undefined ? '' : `最久 ${waitText(sum.oldestMs)}`;
  return {
    count: sum.count,
    countText: String(sum.count),
    oldest,
    label: sum.count ? `待你 ${sum.count} 件，${oldest}` : '待你：现在没有等着的事',
  };
}

/* ───────────── 任务栏角标 ───────────── */

export interface BadgeSpec {
  /** 0 = 清除. */
  count: number;
  /** 画在徽章里的字：1–9，更多写「9+」. */
  text: string;
  /** 金色 = 有等着亲自批的事（待批、待回复、计划）；否则是淡紫. */
  tone: 'gold' | 'plain';
  /** 读屏与悬停文案，写全：待你 3 件：待批 1、待回复 1、待查看 1. */
  label: string;
}

export function badgeSpec(items: QueueItem[]): BadgeSpec {
  const count = items.length;
  if (!count) return { count: 0, text: '', tone: 'plain', label: '' };
  const by = queueSummary(items, 0).byKind;
  const parts = (['approval', 'question', 'plan', 'failed', 'turn-done'] as QueueKind[]).filter((k) => by[k] > 0).map((k) => `${QUEUE_LABEL[k]} ${by[k]}`);
  return {
    count,
    text: count > 9 ? '9+' : String(count),
    tone: by.approval + by.question + by.plan > 0 ? 'gold' : 'plain',
    label: `待你 ${count} 件：${parts.join('、')}`,
  };
}
