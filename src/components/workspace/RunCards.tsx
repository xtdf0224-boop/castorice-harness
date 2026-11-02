/* 遗物卡与未竟之信（施工图 §4.4 RunCallout，样稿 C 的 .letter2）——内容层：一字不加戏、无头像、无贴纸、无意象.
   · RelicCard（run 完成，data-card="relic"）：横幅（右收尖）标题 = 任务标题 +「遗物卡」；四格「已成 / 未竟 / 留存 / 放下」= 完成步数 / 跳过·失败步数 /
     产物数 + 文件改动数 / 重试次数（stepCounts、run.artifacts、attempt、PlanStep.carried）；用时 activeMs、花费 costUsd；
     「收下」（actions.markSeen，卡折成一行）/「再改改」（回到对话输入框追问）/「查看产物」（沿用）.
   · LetterCard（run 失败，data-card="letter"）：灰紫横幅「未竟之信 · 停在第 N 步」；步骤行；2×2「什么没了 / 原因 / 幸存的 / 下一步」；
     「从失败处重试」（沿用 retryRun）/「放下」（actions.layDown(runId) → laidDownAt，卡折成「已放下 hh:mm · 改回再试」）/「查看错误」（沿用）.
   卡外她那一句由调用方（RunCallout）用 HerLead 放在卡上方. 成品证据芯片 / 缩略图 / 嘱托条延后（施工图 §8-4）. */
import { CircleAlert, CircleCheck, Eye, Info, Leaf, Package, Route, Terminal, Undo2, type LucideIcon } from 'lucide-react';
import { useReducer, type ReactNode } from 'react';
import { failureHint } from '../../lib/failure';
import { clock } from '../../lib/format';
import type { PlanStep } from '../../lib/types';
import { actions } from '../../state/actions';
import { hhmm } from '../her/logic';
import { shallow, useApp } from '../../state/store';
import '../../styles/engine-cards.css';
import { Button } from '../ui';
import { stepCounts } from './shared';

/** 「收下」过的运行：卸载再挂载（切标签页）时仍折着. 纯观看状态，不进 store. */
const takenRuns = new Set<string>();

function Cell({ icon: Icon, label, children }: { icon: LucideIcon; label: string; children: ReactNode }) {
  return (
    <div className="her-card__cell">
      <dt><Icon size={14} aria-hidden />{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function RelicCard({ taskId, runId, interactive }: { taskId: string; runId: string; interactive: boolean }) {
  const d = useApp((s) => {
    const r = s.runs[runId];
    if (!r) return undefined;
    const c = stepCounts(r.plan);
    return {
      title: s.tasks[taskId]?.title ?? '',
      done: c.done, skipped: c.skipped, failed: r.plan.filter((x) => x.status === 'failed').length, total: c.total,
      artifacts: r.artifacts.length, diffs: r.artifacts.filter((a) => a.kind === 'diff').length,
      retries: Math.max(0, r.attempt - 1), carried: r.plan.filter((x) => x.carried).length,
      sec: Math.floor(r.activeMs / 1000), cost: r.costUsd,
    };
  }, shallow);
  // 是否已收下每次渲染都按 runId 去 takenRuns 里查（不在挂载时抄一份进 state）：同一位置换了一次运行（页头「查看运行」）时，
  // 卡被复用，折叠态也跟着那次运行走，不会把 B 的「已收下」带到 A 上。
  const [, rerender] = useReducer((n: number) => (n + 1) & 0xffff, 0);
  const taken = takenRuns.has(runId);
  if (!d) return null;

  if (taken) {
    return (
      <article className="her-card her-card--folded" data-card="relic" aria-label="遗物卡（已收下）">
        <span className="her-card__fold-title">{d.title || '任务'} · 遗物卡</span>
        <span className="her-card__fold-note">已收下</span>
        <button type="button" className="her-act" onClick={() => { takenRuns.delete(runId); rerender(); }}>展开</button>
      </article>
    );
  }

  const unfinished = d.skipped + d.failed;
  // 纸面（遗物卡本体）只放事实；按钮在纸外，用界面自己的按钮样式.
  return (
    <div className="her-card-set">
      <article className="her-card her-relic" data-card="relic" aria-label="遗物卡" role="status">
        <div className="her-card__banner"><b>{d.title || '任务'}</b><small>遗物卡</small></div>
        <div className="her-card__body">
          <dl className="her-card__grid">
            <Cell icon={CircleCheck} label="已成">完成 {d.done} / {d.total} 步</Cell>
            <Cell icon={Eye} label="未竟">{unfinished > 0 ? `${unfinished} 步未执行${d.failed ? `（其中 ${d.failed} 步失败）` : ''}` : '没有'}</Cell>
            <Cell icon={Package} label="留存">产物 {d.artifacts} 个{d.diffs > 0 ? `，文件改动 ${d.diffs} 处` : ''}</Cell>
            <Cell icon={Leaf} label="放下">{d.retries > 0 || d.carried > 0 ? `${d.retries > 0 ? `重试 ${d.retries} 次` : ''}${d.retries > 0 && d.carried > 0 ? '，' : ''}${d.carried > 0 ? `沿用 ${d.carried} 步` : ''}` : '没有'}</Cell>
          </dl>
          <p className="her-card__meta">
            用时 {clock(d.sec * 1000)}
            {d.cost !== undefined && d.cost > 0 && <> · 花费 ${d.cost < 0.01 ? '<0.01' : d.cost.toFixed(2)}</>}
          </p>
        </div>
      </article>
      <div className="her-card__actions">
        <Button
          variant="primary" size="sm" icon={CircleCheck}
          onClick={() => { actions.markSeen(taskId); takenRuns.add(runId); rerender(); }}
        >收下</Button>
        {interactive && <Button size="sm" onClick={() => { actions.setWorkspaceTab('conversation'); actions.requestFocus('composer'); }}>再改改</Button>}
        {d.artifacts > 0 && <Button size="sm" icon={Package} onClick={() => actions.setWorkspaceTab('artifacts')}>查看产物</Button>}
      </div>
    </div>
  );
}

const STEP_MARK: Partial<Record<PlanStep['status'], { icon: LucideIcon; label: string; tone: 'ok' | 'bad' | 'idle' }>> = {
  done: { icon: CircleCheck, label: '完成', tone: 'ok' },
  failed: { icon: CircleAlert, label: '没过', tone: 'bad' },
};

export function LetterCard({ taskId: _taskId, runId, interactive, ready, noModel }: { taskId: string; runId: string; interactive: boolean; ready: boolean; noModel: string }) {
  const d = useApp((s) => {
    const r = s.runs[runId];
    if (!r) return undefined;
    const fail = r.plan.find((x) => x.id === r.failure?.stepId);
    return {
      steps: r.plan, failStep: fail?.index ?? -1, failTitle: fail?.title ?? '', message: r.failure?.message ?? '',
      code: r.errors.find((e) => e.fatal)?.code, hint: failureHint(r), done: r.plan.filter((x) => x.status === 'done').length,
      artifacts: r.artifacts.length, laidDownAt: r.laidDownAt,
    };
  }, shallow);
  if (!d) return null;

  if (d.laidDownAt) {
    return (
      <article className="her-card her-card--folded" data-card="letter" aria-label="未竟之信（已放下）" role="status">
        <span className="her-card__fold-title">未竟之信 · {d.failStep >= 0 ? `停在第 ${d.failStep + 1} 步` : '已停下'}</span>
        <span className="her-card__fold-note">已放下 {hhmm(d.laidDownAt)}</span>
        {interactive && (
          <button type="button" className="her-act" disabled={!ready} title={ready ? undefined : noModel} onClick={() => actions.retryRun(runId, 'resume')}>
            <Undo2 size={13} aria-hidden />改回再试
          </button>
        )}
      </article>
    );
  }

  // 步骤行：太长就只留失败那一步和它前两步，其余折成一句.
  const MAX = 6;
  const from = d.steps.length > MAX && d.failStep >= 0 ? Math.max(0, d.failStep - 2) : 0;
  const shown = d.steps.length > MAX ? d.steps.slice(from, from + MAX - (from > 0 ? 1 : 0)) : d.steps;
  const hidden = d.steps.length - shown.length;
  return (
    <div className="her-card-set">
      <article className="her-card her-letter" data-card="letter" aria-label="未竟之信" role="alert">
        <div className="her-card__banner her-card__banner--letter"><b>未竟之信</b><small>{d.failStep >= 0 ? `停在第 ${d.failStep + 1} 步` : '没能走完'}</small></div>
        <div className="her-card__body">
          <ol className="her-letter__steps" aria-label="步骤">
            {shown.map((st) => {
              const mark = STEP_MARK[st.status];
              const Icon = mark?.icon ?? CircleAlert;
              const tone = mark?.tone ?? 'idle';
              return (
                <li key={st.id} className="her-letter__step" data-tone={tone}>
                  <Icon size={14} aria-hidden /><span>{st.title}</span><em>{mark?.label ?? (st.status === 'skipped' ? '跳过' : '未执行')}</em>
                </li>
              );
            })}
          </ol>
          {hidden > 0 && <p className="her-card__meta">另有 {hidden} 步未列出。</p>}
          <dl className="her-card__grid">
            <Cell icon={Eye} label="什么没了">{d.failTitle ? `第 ${d.failStep + 1} 步「${d.failTitle}」没有走完。` : '运行在制定计划或汇总时停下了。'}</Cell>
            <Cell icon={Info} label="原因">{d.message || '没有记录原因。'}{d.code && <span className="her-card__code"> （{d.code}）</span>}</Cell>
            <Cell icon={Package} label="幸存的">已完成 {d.done} 步{d.artifacts > 0 ? `，产物 ${d.artifacts} 个` : ''}都留着。</Cell>
            <Cell icon={Route} label="下一步">{d.hint ? `${d.hint}也可以先放下。` : '从失败的那一步接着做，或者先放下。'}</Cell>
          </dl>
        </div>
      </article>
      {interactive && (
        <div className="her-card__actions">
          <Button variant="primary" size="sm" disabled={!ready} title={ready ? undefined : noModel} onClick={() => actions.retryRun(runId, 'resume')}>从失败处重试</Button>
          <Button size="sm" onClick={() => actions.layDown(runId)}>放下</Button>
          <Button variant="ghost" size="sm" icon={Terminal} onClick={() => actions.openConsole('errors')}>查看错误</Button>
        </div>
      )}
    </div>
  );
}
