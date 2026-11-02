/* 右侧运行状态面板：运行、活跃 Agent、模型、上下文、Token、待确认操作。
   每个分区自己订阅所需的最小切片，所以运行时间每秒走字、回复一个字一个字流出来时，只有对应的分区重绘。 */
import { BellOff, CheckCircle2, ChevronDown, ChevronRight, ChevronUp, Cpu, Eye, PauseCircle, Radar, TriangleAlert, X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type Ref } from 'react';
import { EFFORT_LABEL } from '../../lib/effort';
import { clock, percent, tokens } from '../../lib/format';
import { EXPR_NAME } from '../../lib/expr';
import { useMedia, useNow, useReducedMotion } from '../../lib/hooks';
import { mood as idleMood } from '../../lib/persona';
import { moodWord, type MoodWordCtx } from '../../lib/mood';
import { DRIVERS, PROVIDER_BY_ID, contextOf, modelName, readiness } from '../../lib/providers';
import { AGENT_ACTIVITY, isOpenRun, type StatusMeta } from '../../lib/status';
import type { AgentId, AppState, Approval, ExprId, Level, Run, Settings, TaskEngine, Tone } from '../../lib/types';
import { actions } from '../../state/actions';
import { defaultChoice, engineChoices } from '../../state/models';
import { agentActivity, currentRun, herOpened, personaOn, openRuns, pendingApprovals, runLabel, selectTrail, stepProgress, TRAIL_EMPTY, useHerCrisis, wallMs, type TrailKind, type TrailNode } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { AgentMark } from '../her/AgentMark';
import { AiTag } from '../her/AiTag';
import { ExprBadge } from '../her/ExprBadge';
import { HerAvatar } from '../her/HerAvatar';
import { NamePlate } from '../her/NamePlate';
import { isAsking, runStatusMeta } from '../workspace/shared';
import { isWatching, ribbonOf, selectCompanions } from '../views/config/companions';
import { WSwitch } from '../views/settings/WSwitch';
import { Words } from './Words';
import { Butterfly } from '../decor/marks';
import { wallpaperFor } from '../decor/wallpapers';
import { Badge, Button, EmptyState, IconButton, Meter, Segmented, Sparkline, StatusChip, cx } from '../ui';
import { ApprovalCard } from './ApprovalCard';
import { DRAWER_QUERY } from './queries';
import '../../styles/shell-her.css';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

const PAUSE_REASON: Record<NonNullable<Run['pauseReason']>, string> = {
  user: '你暂停了运行',
  reload: '页面重新载入后暂停',
};

/** 面板展示哪个运行：任务视图里是当前任务的运行，其他视图里是最近开始的进行中运行。 */
function panelRunId(s: AppState): string | undefined {
  if (s.view === 'task') return currentRun(s)?.id;
  let best: Run | undefined;
  for (const r of openRuns(s)) {
    if (!best || (r.startedAt ?? r.createdAt) > (best.startedAt ?? best.createdAt)) best = r;
  }
  return best?.id;
}

function Section({ title, right, className, innerRef, flash, focusable, children }: {
  title: string;
  right?: ReactNode;
  className?: string;
  innerRef?: Ref<HTMLElement>;
  flash?: boolean;
  focusable?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className={cx('status-panel__section', className, flash && 'is-flash')} aria-labelledby={id} ref={innerRef} tabIndex={focusable ? -1 : undefined}>
      <div className="status-panel__head">
        <h2 className="label status-panel__heading" id={id}>{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** 空态文案：每句占一行（各自 nowrap，不在 272 px 里把词拆开，也不留一两个字的孤行）. */
const lines = (...t: string[]) => t.map((x) => <span key={x} className="status-panel__ln">{x}</span>);

/* ───────────── 运行 ───────────── */

/** 步骤条：一步一段，按每一步自己的状态上色（已完成 淡绿、失败的那一步 红、当前 流光、未执行 灰）；
   放下之后整条灰阶，不再用强调色. 超过 24 步时几步并成一段（有失败取失败，有当前取当前）. */
function StepBar({ run, laid, valueText }: { run: Run; laid: boolean; valueText: string }) {
  const total = run.plan.length;
  const n = Math.min(24, Math.max(1, total));
  const failedId = run.status === 'failed' ? run.failure?.stepId : undefined;
  const kinds = Array.from({ length: n }, (_, i) => {
    const group = run.plan.slice(Math.floor((i * total) / n), Math.max(Math.floor((i * total) / n) + 1, Math.floor(((i + 1) * total) / n)));
    if (!laid && group.some((st) => st.status === 'failed' || st.id === failedId)) return 'failed';
    if (group.some((st) => st.status === 'running' || st.status === 'awaiting')) return 'now';
    if (group.every((st) => st.status === 'done' || st.status === 'skipped')) return group.every((st) => st.status === 'skipped') ? 'skip' : 'done';
    return 'idle';
  });
  const finished = run.plan.filter((st) => st.status === 'done' || st.status === 'skipped').length;
  return (
    <div className={cx('stepbar', laid && 'is-laid')} role="meter" aria-label="步骤进度" aria-valuemin={0} aria-valuemax={total} aria-valuenow={finished} aria-valuetext={valueText}>
      {kinds.map((k, i) => <span key={i} className={cx('stepbar__seg', `is-${k}`)} />)}
    </div>
  );
}

function RunSection({ runId, taskView, viewTaskId }: { runId: string; taskView: boolean; viewTaskId: string | undefined }) {
  const run = useApp((s) => s.runs[runId]);
  const taskTitle = useApp((s) => { const r = s.runs[runId]; return r ? s.tasks[r.taskId]?.title : undefined; });
  const open = !!run && isOpenRun(run.status);
  const now = useNow(1000, open);
  if (!run) return null;

  // 放下之后：灰色「已放下」，不再是红色「执行失败」（与页头、左栏同一个说法）；时刻并进胶囊，不再另起一行.
  // 等的只是一个回答时叫「待回复」（批准与计划仍叫「等待确认」）.
  const laid = run.status === 'failed' && !!run.laidDownAt;
  const baseMeta = runStatusMeta(run.status, run.laidDownAt, isAsking(run));
  const meta: StatusMeta = laid ? { ...baseMeta, label: `已放下 · ${hhmm(run.laidDownAt!)}` } : baseMeta;
  const { total, current } = stepProgress(run);
  // Counted here from the plan so the numbers stay right whichever way stepProgress treats skipped steps:
  // `done` = actually executed, `skipped` = rejected / disabled, `finished` = how far through the plan the run is.
  const done = run.plan.filter((p) => p.status === 'done').length;
  const skipped = run.plan.filter((p) => p.status === 'skipped').length;
  const finished = done + skipped;
  const planning = open && !run.planReady;
  const foreign = !taskView || viewTaskId !== run.taskId;

  let currentText: string | undefined;
  if (planning) currentText = run.live?.text ?? '拆解目标、制定计划';
  else if (run.status === 'failed' && run.failure) {
    const failed = run.plan.find((p) => p.id === run.failure!.stepId);
    currentText = failed ? `${laid ? '停在' : '失败于'}第 ${failed.index + 1} 步 · ${failed.title}` : run.failure.message;
  } else if (open && current >= 0) currentText = `第 ${current + 1} 步 · ${run.plan[current].title}`;
  else if (run.status === 'completed') currentText = skipped > 0 ? `已完成 ${done} 步，${skipped} 步已跳过` : `全部 ${total} 步已完成`;

  return (
    <Section title="运行">
      {foreign && taskTitle && (
        <p className="status-panel__viewing">
          <span>正在查看：</span>
          <button type="button" className="shell-link" title={taskTitle} onClick={() => actions.openTask(run.taskId)}>{taskTitle}</button>
        </p>
      )}
      <div className={cx('status-panel__run', run.status === 'running' && 'is-breathing')}>
        <div className="status-panel__runhead">
          <span className="status-panel__chip" data-celebrate-target={taskView ? undefined : ''}>
            <StatusChip meta={meta} size="lg" glow={false} />
          </span>
          <span className="status-panel__runno">{runLabel(run)}</span>
        </div>
        {run.status === 'paused' && run.pauseReason && (
          <p className="status-panel__note">
            <PauseCircle size={14} aria-hidden />
            <span>{PAUSE_REASON[run.pauseReason]}</span>
          </p>
        )}
        <dl className="kv">
          <dt>运行时间</dt>
          <dd className="mono">{clock(run.activeMs)}</dd>
          <dt>总耗时</dt>
          <dd className="mono">{clock(wallMs(run, now))}</dd>
          <dt>步骤</dt>
          <dd>
            {planning || total === 0 ? '计划生成中' : `${finished} / ${total}`}
            {!planning && skipped > 0 && <span className="status-panel__skipped">（含 {skipped} 步已跳过）</span>}
          </dd>
        </dl>
        {!planning && total > 0 && (
          <StepBar
            run={run}
            laid={laid}
            valueText={skipped > 0 ? `已完成 ${done} 步，跳过 ${skipped} 步，共 ${total} 步` : `已完成 ${done} 步，共 ${total} 步`}
          />
        )}
        {currentText && <p className="status-panel__step">{currentText}</p>}
      </div>
    </Section>
  );
}

/* ───────────── Agent ───────────── */

function AgentRow({ runId, agentId }: { runId: string; agentId: AgentId }) {
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  // An agent with its own model shows that one (the run keeps a snapshot); everyone else runs on the task's.
  const engineText = useApp((s) => {
    const r = s.runs[runId];
    const e = r ? r.agentEngines?.[agentId] ?? s.tasks[r.taskId]?.engine : undefined;
    return e ? engineSummary(e) : undefined;
  });
  const activity = useApp((s) => agentActivity(s, s.runs[runId], agentId));
  const liveText = useApp((s) => {
    const r = s.runs[runId];
    return r && isOpenRun(r.status) && r.live?.agentId === agentId ? r.live.text : undefined;
  });
  const persona = useApp((s) => personaOn(s));
  // 遐蝶这一行与 Agent 页主牌缎带读同一份（ribbonOf / isWatching）：有同伴在做、她自己没动手时写「在旁看着」，不再「待命」配「空闲」；
  // 她动手时写「在做 · 第 N 步」. 只在这个运行就是 Agent 页选中的那个运行时才用.
  const lead = useApp((s) => {
    if (agentId !== 'orchestrator') return null;
    const c = selectCompanions(s, s.runs[runId]?.taskId);
    if (c.runId !== runId) return null;
    const watching = isWatching(c);
    const rb = ribbonOf(true, c.agents.orchestrator, watching);
    return { watching, text: rb.text, busy: c.agents.orchestrator.state === 'busy' };
  }, shallow);
  if (!agent) return null;
  const base = AGENT_ACTIVITY[activity];
  const meta: StatusMeta = lead?.watching ? { label: '在旁看着', tone: 'neutral', icon: Eye } : base;
  // 与 Agent 页同一套身份语言：官方命途图标（<48 用 -s 版；昼里着成牌面的深紫）；遐蝶那一行是她的头像.
  const her = agentId === 'orchestrator' && persona;
  const state = activity === 'idle' ? 'idle' : 'busy';
  return (
    <li className={cx('status-panel__agent', liveText !== undefined && 'is-live', lead?.watching && 'is-watching')} data-tone={meta.tone}>
      <span className={cx('status-panel__mark', her && 'is-her')} role="img" aria-label={`${agent.name}：${meta.label}`}>
        {her ? <HerAvatar size={28} expr="gentle" ring="none" /> : <AgentMark agent={agentId} size={24} state={state} />}
        <span className={cx('status-panel__mark-dot', meta.live && 'is-live')} aria-hidden />
      </span>
      <div className="status-panel__agent-main">
        <div className="status-panel__agent-top">
          <span className="status-panel__agent-name truncate">{agent.name}</span>
          <StatusChip meta={meta} size="sm" />
        </div>
        <p className="status-panel__agent-text">{lead && (lead.watching || lead.busy) ? lead.text : liveText ?? '待命'}</p>
        {lead?.busy && liveText ? <p className="status-panel__agent-model">{liveText}</p> : null}
        {engineText && <p className="status-panel__agent-model">{engineText}</p>}
      </div>
    </li>
  );
}

function AgentSection({ runId }: { runId: string }) {
  const agentIds = useApp((s) => { const r = s.runs[runId]; return r ? s.tasks[r.taskId]?.agentIds : undefined; }, shallow);
  if (!agentIds || agentIds.length === 0) return null;
  return (
    <Section title="活跃 Agent">
      {/* 昼里命途图标着成牌面深紫（同 Agent 页的 tarot-plum；那份定义只在 Agent 页里，这里自带一份，id 不同） */}
      <svg width="0" height="0" aria-hidden="true" focusable="false" style={{ position: 'absolute' }}>
        <filter id="panel-plum" colorInterpolationFilters="sRGB">
          <feColorMatrix type="matrix" values="0 0 0 0 0.294 0 0 0 0 0.149 0 0 0 0 0.439 0 0 0 1 0" />
        </filter>
      </svg>
      <ul className="status-panel__agents">
        {agentIds.map((id) => <AgentRow key={id} runId={runId} agentId={id} />)}
      </ul>
    </Section>
  );
}

/* ───────────── 模型 ───────────── */

/** What a model block needs to know about a way of running: a task's engine or the default choice. */
type EngineFacts = Pick<TaskEngine, 'provider' | 'auth' | 'driver' | 'model' | 'effort'> & { cwd?: string };

/** 「Claude Code」 or 「API 密钥」. */
function wayName(e: EngineFacts) {
  return e.auth === 'api' ? 'API 密钥' : DRIVERS[e.driver ?? PROVIDER_BY_ID[e.provider].drivers[0]].label;
}

/** The model's version name; 「跟随 Claude Code」 when the tool picks it (the full sentence is the title of the value). */
function modelText(e: EngineFacts) {
  if (e.model) return modelName(PROVIDER_BY_ID[e.provider], e.model);
  return e.auth === 'api' ? PROVIDER_BY_ID[e.provider].name : `跟随 ${wayName(e)}`;
}

/** One line for an agent row: 「Claude Sonnet 5.5 · Claude Code · 强度 高」. */
function engineSummary(e: EngineFacts) {
  const model = e.model ? modelName(PROVIDER_BY_ID[e.provider], e.model) : e.auth === 'api' ? PROVIDER_BY_ID[e.provider].name : '';
  return [model, wayName(e) + (model ? '' : ' · 默认模型'), e.effort && `强度 ${EFFORT_LABEL[e.effort]}`].filter(Boolean).join(' · ');
}

function EngineFactsList({ engine }: { engine: EngineFacts }) {
  const ctx = contextOf(PROVIDER_BY_ID[engine.provider], engine.model);
  return (
    <>
      <dl className="kv">
        <dt>服务</dt>
        <dd>{PROVIDER_BY_ID[engine.provider].name}</dd>
        <dt>方式</dt>
        <dd>{wayName(engine)}</dd>
        <dt>模型</dt>
        <dd className="status-panel__model" title={engine.model || engine.auth === 'api' ? undefined : `默认模型，由 ${wayName(engine)} 决定`}>{modelText(engine)}</dd>
        <dt>推理强度</dt>
        <dd>{engine.effort ? EFFORT_LABEL[engine.effort] : '默认'}</dd>
        <dt>上下文窗口</dt>
        <dd className="mono">{ctx.known ? '' : '约 '}{tokens(ctx.tokens)}</dd>
      </dl>
      {engine.cwd && <p className="status-panel__muted mono truncate" title={engine.cwd}>{engine.cwd}</p>}
    </>
  );
}

function ModelSection() {
  const taskOpen = useApp((s) => s.view === 'task' && !!s.selectedTaskId && !!s.tasks[s.selectedTaskId]);
  const engine = useApp((s) => (s.view === 'task' && s.selectedTaskId ? s.tasks[s.selectedTaskId]?.engine : undefined));
  const models = useApp((s) => s.models);

  if (taskOpen) {
    if (!engine) {
      return (
        <Section title="模型">
          <p className="status-panel__alert"><TriangleAlert size={14} aria-hidden /><span>这个任务还没有设置模型。</span></p>
          <Button size="sm" variant="secondary" icon={Cpu} onClick={() => actions.navigate('models')}>去模型接入</Button>
        </Section>
      );
    }
    // The way it was set up with may have lost its login or key since.
    const usable = engineChoices(models).some((c) => c.key === `${engine.provider}:${engine.auth}`);
    if (!usable) {
      const reason = readiness(PROVIDER_BY_ID[engine.provider], models.providers[engine.provider], engine.auth).reason;
      return (
        <Section title="模型">
          <p className="status-panel__alert">
            <TriangleAlert size={14} aria-hidden />
            <span>这个任务用的「{PROVIDER_BY_ID[engine.provider].name} · {wayName(engine)}」现在用不了{reason ? `：${reason}` : ''}。</span>
          </p>
          <EngineFactsList engine={engine} />
          <Button size="sm" variant="secondary" icon={Cpu} onClick={() => actions.navigate('models')}>去模型接入</Button>
        </Section>
      );
    }
    return (
      <Section title="模型">
        <EngineFactsList engine={engine} />
      </Section>
    );
  }

  const choice = defaultChoice(models);
  if (!choice) {
    return (
      <Section title="模型">
        <EmptyState
          compact
          icon={Cpu}
          title="还没有接入模型"
          body="用命令行工具登录，或填一个 API 密钥，就能开始对话和任务。"
          actions={<Button size="sm" variant="secondary" onClick={() => actions.navigate('models')}>去模型接入</Button>}
        />
      </Section>
    );
  }
  return (
    <Section title="模型" right={<Badge tone="neutral">新任务默认</Badge>}>
      <EngineFactsList engine={choice} />
      <p className="status-panel__muted">
        新任务先用这个。可以在<button type="button" className="shell-link" onClick={() => actions.navigate('models')}>模型接入</button>里更改。
      </p>
    </Section>
  );
}

/* ───────────── 上下文 / Token ───────────── */

function ContextSection({ runId }: { runId: string }) {
  const usage = useApp((s) => s.runs[runId]?.usage);
  const cli = useApp((s) => { const r = s.runs[runId]; return !!r && s.tasks[r.taskId]?.engine?.auth === 'cli'; });
  if (!usage) return null;
  if (!usage.contextLimit || (cli && !usage.contextUsed)) {
    return (
      <Section title="上下文">
        <p className="status-panel__figure">
          {usage.contextLimit ? <span className="mono tabular">窗口 {tokens(usage.contextLimit)}</span> : <span>窗口大小未知</span>}
        </p>
        <p className="status-panel__muted words">
          <Words text={cli ? '这个命令行 Agent 不报告每次请求的上下文用量，由它自己管理和压缩。' : '这个模型没有报告上下文用量。'} />
        </p>
      </Section>
    );
  }
  const pct = percent(usage.contextUsed, usage.contextLimit);
  const tone: Tone = pct > 90 ? 'danger' : pct > 75 ? 'warning' : 'running';
  return (
    <Section title="上下文">
      <Meter value={usage.contextUsed} max={usage.contextLimit} label="上下文使用量" tone={tone} segments={24} valueText={`已使用 ${pct}%`} />
      <p className="status-panel__figure">
        <span className="mono tabular">{tokens(usage.contextUsed)} / {tokens(usage.contextLimit)}</span>
        <span aria-hidden="true"> · </span>
        <span className="tabular">{pct}%</span>
        {pct > 75 && (
          <span className={cx('status-panel__warn', pct > 90 && 'is-danger')}>
            <TriangleAlert size={12} aria-hidden />
            {pct > 90 ? '即将用满' : '用量偏高'}
          </span>
        )}
      </p>
    </Section>
  );
}

function TokenSection({ runId }: { runId: string }) {
  const usage = useApp((s) => s.runs[runId]?.usage);
  if (!usage) return null;
  const stats: Array<[string, number, boolean?]> = [
    ['输入', usage.inputTokens],
    ['输出', usage.outputTokens],
    ['缓存命中', usage.cachedTokens],
    ['合计', usage.inputTokens + usage.outputTokens, true],
  ];
  return (
    <Section title="Token 消耗">
      <dl className="status-panel__stats">
        {stats.map(([label, value, strong]) => (
          <div key={label} className={cx('status-panel__stat', strong && 'is-total')}>
            <dt>{label}</dt>
            <dd className="mono tabular">{tokens(value)}</dd>
          </div>
        ))}
      </dl>
      <Sparkline values={usage.series} label="Token 累计曲线" width={282} height={36} />
    </Section>
  );
}

/* ───────────── 待确认操作 ───────────── */

function ApprovalsSection({ approvals, innerRef, flash }: { approvals: Approval[]; innerRef: Ref<HTMLElement>; flash: boolean }) {
  const count = approvals.length;
  return (
    <Section
      title="待确认操作"
      className={cx('status-panel__section--approvals', count > 0 && 'has-pending')}
      innerRef={innerRef}
      flash={flash}
      focusable
      right={count > 0 ? <Badge tone="warning">{count}<span className="sr-only"> 个待确认</span></Badge> : undefined}
    >
      {count > 0 ? (
        <ul className="status-panel__approvals">
          {approvals.map((a) => <li key={a.id}><ApprovalCard approval={a} compact showTask /></li>)}
        </ul>
      ) : (
        <p className="status-panel__none"><CheckCircle2 size={14} aria-hidden /><span>没有待确认的操作</span></p>
      )}
    </Section>
  );
}

/* ───────────── 她（页头） ───────────── */

const PORTRAIT_KEY = 'alight/her-portrait';
type PortraitPref = 'open' | 'closed';
const readPortrait = (): PortraitPref | undefined => {
  try { const v = localStorage.getItem(PORTRAIT_KEY); return v === 'open' || v === 'closed' ? v : undefined; } catch { return undefined; }
};
const writePortrait = (v: PortraitPref) => { try { localStorage.setItem(PORTRAIT_KEY, v); } catch { /* 记不住就算了 */ } };

/** 副标只准官方称号（NamePlate 的约束）：夜「冥河的女儿」，昼「拥抱新生的祈望」. */
const SUB_TITLE = { night: '冥河的女儿', day: '拥抱新生的祈望' } as const;

const sameTrail = (a: TrailNode[], b: TrailNode[]) =>
  a === b || (a.length === b.length && a.every((n, i) => n.kind === b[i].kind && n.at === b[i].at && n.expr === b[i].expr && n.label === b[i].label));

/** 她这一路的神色（V2 的 selectTrail；这里只读，不自己推导）. */
function useTrail(taskId: string | undefined): TrailNode[] {
  return useApp((s) => selectTrail(s, taskId), sameTrail);
}

const DONE_WORD_MS = 20 * 60_000;

const hhmm = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 右栏最上面：她（官方表情，整张不裁）与此刻的状态。状态只读运行记录：在途 / 待你 / 已完成 / 候场……不编感受.
   龛的拱形是外框装饰（边线），不是图片的裁切框：图片本身直角，任何祖先都不对它 overflow:hidden（D-03）.
   昼：宿主仍是 .status-panel__arch（含 data-credit="arch"）；夜：.status-panel__host，署名在页脚 .status-panel__foot. */
function HerHeader({ runId }: { runId?: string }) {
  const mode = useApp((s) => s.settings.mode);
  const persona = useApp((s) => personaOn(s));
  const level = useApp((s) => s.settings.level ?? 'm');
  const lifeMood = useApp((s) => s.settings.lifeMood);
  const taskId = useApp((s) => (s.view === 'task' ? s.selectedTaskId : undefined));
  const chat = useApp((s) => (s.view === 'task' && s.selectedTaskId ? s.tasks[s.selectedTaskId]?.kind === 'chat' : false));
  const writing = useApp((s): '' | 'writing' | 'thinking' => {
    const t = s.view === 'task' && s.selectedTaskId ? s.tasks[s.selectedTaskId] : undefined;
    const m = t?.messages[t.messages.length - 1];
    return m?.role === 'agent' && m.streaming ? (m.text ? 'writing' : 'thinking') : '';
  });
  const status = useApp((s) => (runId ? s.runs[runId]?.status : undefined));
  const planning = useApp((s) => { const r = runId ? s.runs[runId] : undefined; return !!r && isOpenRun(r.status) && !r.planReady; });
  const trail = useTrail(taskId);
  const crisis = useHerCrisis(taskId);
  const [pref, setPref] = useState<PortraitPref | undefined>(readPortrait);
  const compactHeight = useMedia('(max-height: 819px)');
  const nicheId = useId();
  // 收起 / 展开会在两个分支间换按钮（父节点与类型都不同，DOM 不复用）：被按下的那颗随之卸载，焦点要交给另一个分支里对应的那颗，不然落到 body.
  const herRef = useRef<HTMLElement>(null);
  const refocusToggle = useRef(false);

  const laidAt = useApp((s) => (runId ? s.runs[runId]?.laidDownAt : undefined));
  const asking = useApp((s) => isAsking(runId ? s.runs[runId] : undefined));
  const endedAt = useApp((s) => (runId ? s.runs[runId]?.endedAt : undefined));
  // Agent 页：名牌旁的词与页头同一个（AgentHead 用 moodWord 的 agents 面），不再右栏「在做」、页头「在场」.
  const agentsMode = useApp((s): '' | 'leading' | 'leading-wait' | 'present' | 'idle' => {
    if (s.view !== 'agents') return '';
    const c = selectCompanions(s, s.selectedTaskId);
    const orch = c.agents.orchestrator;
    if (orch.state === 'busy') return orch.activity === 'waiting' ? 'leading-wait' : 'leading';
    return (['researcher', 'coder', 'reviewer'] as const).some((id) => c.agents[id].state === 'busy') ? 'present' : 'idle';
  });
  const now = useNow(60_000, status === 'completed');
  const meta = status ? runStatusMeta(status, laidAt, asking) : undefined;
  const label = meta ? (status === 'awaiting' ? '待你' : status === 'running' ? '在途' : meta.label) : undefined;
  const expr: ExprId = trail.length ? trail[trail.length - 1].expr : 'gentle';
  const laid = status === 'failed' && !!laidAt;
  const dot: 'work' | 'wait' | undefined = agentsMode
    ? (agentsMode === 'leading' ? 'work' : agentsMode === 'leading-wait' ? 'wait' : undefined)
    : status === 'awaiting' || status === 'paused' ? 'wait' : status === 'running' || planning || (chat && writing) ? 'work' : undefined;
  const ring = dot ?? 'idle';
  const idle = lifeMood ? idleMood(mode, 'idle') : undefined;
  const wordCtx: MoodWordCtx = agentsMode
    ? { surface: 'agents', agents: agentsMode === 'idle' ? 'idle' : agentsMode === 'present' ? 'present' : 'leading' }
    : chat
    ? { surface: 'chat', streaming: writing === 'writing', thinking: writing === 'thinking', idleMood: idle, crisis }
    : {
      // 放下之后她不在收拾，是静下来了：用闲时词（没有就「歇着」）.
      surface: 'work', idleMood: laid ? idle ?? '歇着' : idle, crisis,
      phase: planning ? 'planning' : status === 'running' ? 'running' : status === 'awaiting' || status === 'paused' ? 'awaiting' : laid ? 'idle' : status === 'failed' ? 'failed' : status === 'completed' ? 'done' : 'idle',
    };
  // 完成：moodWord 不写词（状态字已写「已完成」），但名牌旁与收起行得有这个胶囊——先「在收尾」（与中栏同一个词），过一阵换成闲时词.
  const settled = status === 'completed' && !agentsMode && !chat && !crisis && (!endedAt || now - endedAt < DONE_WORD_MS);
  const word = persona ? (settled ? '在收尾' : moodWord(status === 'completed' && !agentsMode && !chat ? { ...wordCtx, phase: 'idle' } : wordCtx)) : undefined;
  const folded = persona && (pref ? pref === 'closed' : level === 's');
  const toggle = () => { const next: PortraitPref = folded ? 'open' : 'closed'; refocusToggle.current = true; setPref(next); writePortrait(next); };
  useEffect(() => {
    if (!refocusToggle.current) return;
    refocusToggle.current = false;
    const btn = herRef.current?.querySelector<HTMLElement>(folded ? '.herpanel-toggle' : '.herpanel-niche__fold');
    btn?.focus({ preventScroll: true });
  }, [folded]);
  // 工作页有运行时龛里的立绘缩到 160（等比、整张、不裁冠），神色一路与运行卡才能在首屏里；没有运行时才用大龛.
  const faceSize = runId ? 160 : compactHeight ? 168 : 208;

  const stateLine = meta && label ? (
    <p className="status-panel__her-state" data-tone={meta.tone}>
      {status === 'running' ? <Butterfly size={20} variant="wire" className="status-panel__her-bf" /> : null}
      <b>{label}</b>
      {status !== 'running' && status !== 'awaiting' ? <span className="sr-only">：{meta.label}</span> : null}
    </p>
  ) : null;
  // 角色开着时运行状态只在运行卡里写一次；页头只给读屏留一份.
  const stateSr = meta && label ? <span className="sr-only">运行状态：{label}</span> : null;

  let body: ReactNode;
  if (!persona) {
    // 角色口吻关掉：牌名「编排 Agent」、命途图标代替头像，不出表情.
    body = (
      <div className="herpanel-row" data-plain="true">
        <AgentMark agent="orchestrator" size={36} state={dot ? 'busy' : 'idle'} />
        <div className="herpanel-row__text">
          <p className="status-panel__her-name">编排 Agent</p>
          {stateLine}
        </div>
      </div>
    );
  } else if (folded) {
    // 收起：头像 44 | 名牌（神色词里的色点就是「在做 / 待你」）+ 小字署名 | 展开. 状态文字留给读屏与悬停，不再单占一行.
    body = (
      <div className="herpanel-row" title={meta && label ? `${label}：${meta.label}` : undefined}>
        <HerAvatar size={44} expr={expr} ring={ring} />
        <div className="herpanel-row__text">
          <NamePlate size="sm" word={word} dot={dot} />
          {label ? <span className="sr-only">{label}</span> : null}
          {mode === 'day' ? <span className="status-panel__arch-credit" data-credit="arch">表情：官方 © miHoYo</span> : null}
        </div>
        <button type="button" className="herpanel-toggle" aria-expanded={false} title="展开她的头像" onClick={toggle}>展开<ChevronDown size={12} aria-hidden /></button>
      </div>
    );
  } else {
    // 龛：外框是拱形边线，里面一圈浅拱线 + 顶上一只小蝶是装饰；图片直角、整张不裁，徽章落在龛内右上（≤ 48 px，含描边）.
    body = (
      <div className="herpanel-niche" id={nicheId} data-compact={runId ? 'true' : undefined}>
        <button type="button" className="herpanel-niche__fold" aria-expanded aria-controls={nicheId} aria-label="收起立绘" title="收起她的头像，只留一行" onClick={toggle}>
          <ChevronUp size={12} aria-hidden />收起
        </button>
        <span className="herpanel-niche__arch" aria-hidden="true" />
        <span className="herpanel-niche__bf" aria-hidden="true"><Butterfly size={16} variant="wire" /></span>
        <HerAvatar size={faceSize} shape="full" expr={expr} />
        <span className="herpanel-niche__badge" aria-hidden="true" title={`神色：${EXPR_NAME[expr]}`}>
          <ExprBadge expr={expr} size={36} />
        </span>
      </div>
    );
  }

  const info = persona && !folded ? (
    <div className="herpanel-info">
      {/* 危机回合：与对话区的名牌一样不出称号（夜「冥河的女儿」带死亡意象），状态词保留 */}
      <NamePlate size="md" sub={crisis ? undefined : SUB_TITLE[mode]} />
      <div className="herpanel-info__line">
        <AiTag />
        {word ? (
          <span data-word className="hnp__word">
            {dot ? <span aria-hidden="true" className={`hnp__dot hnp__dot--${dot}`} /> : null}
            {word}
          </span>
        ) : null}
        {stateSr}
      </div>
    </div>
  ) : null;

  return (
    <header ref={herRef} className="status-panel__her herpanel" data-her data-mode={mode} data-folded={folded ? 'true' : 'false'} data-persona={persona ? 'on' : 'off'}>
      {mode === 'day' ? (
        <div className="status-panel__arch" data-folded={folded ? 'true' : 'false'}>
          {body}
          <span className="status-panel__hem" aria-hidden="true" />
          {persona && folded ? null : <span className="status-panel__arch-credit" data-credit="arch">{persona ? '表情：官方 © miHoYo' : '命途图标：官方 © miHoYo'}</span>}
        </div>
      ) : (
        <div className="status-panel__host" data-folded={folded ? 'true' : 'false'}>{body}</div>
      )}
      {info}
    </header>
  );
}

/* ───────────── 神色一路 ───────────── */

const TRAIL_LABEL: Record<TrailKind, string> = { expr: '说话', plan: '计划', start: '开工', retry: '重试', thanks: '道谢', pending: '待批', end: '收尾' };

/** 闲聊：最近几句（≤5）的神色：32 px 的官方图标 + 神色词，当前一个带运行状态环；工作：计划 / 开工 / 重试 / 道谢 / 待批 五类节点，
   每个节点是 36 px 的 HerAvatar（脸加角标，施工图 §4.5）+ 标签 + 等宽时间.
   只读 selectTrail：节点来自消息与运行记录，不读事件正文，也不自己编神色. */
function TrailSection({ taskId, chat }: { taskId: string; chat: boolean }) {
  const trail = useTrail(taskId);
  const opened = useApp((s) => herOpened(s, taskId));
  const ring = useApp((s): 'work' | 'wait' | 'idle' => {
    const t = s.tasks[taskId];
    const m = t?.messages[t.messages.length - 1];
    if (m?.role === 'agent' && m.streaming) return 'work';
    const r = currentRun(s);
    return r && (r.status === 'awaiting' || r.status === 'paused') ? 'wait' : r && isOpenRun(r.status) ? 'work' : 'idle';
  });
  if (chat) {
    const last = trail.slice(-5);
    const now = last[last.length - 1];
    return (
      <Section title="神色一路" right={last.length > 0 ? <span className="status-panel__muted">最近 {last.length} 句</span> : undefined}>
        {!now ? (
          <p className="status-panel__muted words"><Words text={opened ? TRAIL_EMPTY.opened : TRAIL_EMPTY.silent} /></p>
        ) : (
          <>
            <ol className="trail-icons" data-her data-ring={ring} aria-label="最近几句话的神色，旧的在前">
              {last.map((n, i) => (
                <li key={`${n.at}:${i}`} className={cx(n === now && 'is-now')} title={`${n === now ? '此刻' : `第 ${i + 1} 句`}：${EXPR_NAME[n.expr]}`}>
                  <span className="trail-icons__ico"><ExprBadge expr={n.expr} size={32} /></span>
                  <span className="trail-icons__label">{EXPR_NAME[n.expr]}</span>
                </li>
              ))}
            </ol>
            <p className="trail-now">此刻　<b>{EXPR_NAME[now.expr]}</b></p>
          </>
        )}
      </Section>
    );
  }
  if (trail.length === 0) return null;
  return (
    <Section title="神色一路" right={<span className="status-panel__muted">每个节点一个</span>}>
      <ol className="trail-nodes" data-her data-ring={ring}>
        {trail.slice(-6).map((n, i, all) => (
          <li key={`${n.kind}:${n.at}:${i}`} className={cx(i === all.length - 1 && 'is-now')} title={`神色：${EXPR_NAME[n.expr]}`}>
            <span className="trail-nodes__ico"><HerAvatar size={36} expr={n.expr} ring={i === all.length - 1 ? ring : 'none'} /></span>
            <span className="trail-nodes__label">{n.label ?? TRAIL_LABEL[n.kind]}</span>
            <span className="trail-nodes__time mono tabular">{hhmm(n.at)}</span>
          </li>
        ))}
      </ol>
    </Section>
  );
}

/* ───────────── 控制卡：她在旁边 ───────────── */

const LEVELS: Array<{ value: Level; label: string }> = [{ value: 's', label: '少' }, { value: 'm', label: '中' }, { value: 'l', label: '多' }];
const LEVEL_HINT: Record<Level, string> = { s: '短，但仍是她', m: '会接话（默认）', l: '站近一些，愿意讲小事' };
const PROACTIVE_OPTIONS: Array<{ value: Settings['proactive']; label: string }> = [{ value: 'auto', label: '自动' }, { value: 'on', label: '开' }, { value: 'off', label: '关' }];
const STORY_OPTIONS: Array<{ value: Settings['storyBox']; label: string }> = [{ value: 'off', label: '关' }, { value: 'chat', label: '闲聊' }, { value: 'all', label: '全部' }];

/** 副标按「·」分段，每段是一个不拆的短语块（272 px 里不把「分钟」拆开）. */
function proactiveNote(level: Level, p: Settings['proactive']): ReactNode {
  const parts = level === 's' ? ['话量为「少」', '只在该休息时提醒']
    : p === 'off' ? ['不主动开口', '该休息时只出一行字']
      : [...(p === 'auto' && level !== 'l' ? ['多档才开口'] : []), '每天≤3次', '静默8分钟'];
  return parts.map((t, i) => <span key={t}>{i > 0 ? ' · ' : ''}<span className="herctl__nb">{t}</span></span>);
}

/** 话量、角色口吻、她主动说话、记得小事、安静一小时、折叠她的话、她退半步、剧情框. 闲聊页与工作页都有；抽屉里同样. */
function ControlCard({ taskId }: { taskId: string }) {
  const st = useApp((s) => ({
    level: s.settings.level ?? 'm', persona: personaOn(s), proactive: s.settings.proactive ?? 'auto', memoryOn: !!s.settings.memoryOn,
    stepBack: s.settings.stepBack !== false, storyBox: s.settings.storyBox ?? 'chat', quietUntil: s.quietUntil ?? 0, fold: !!s.tasks[taskId]?.foldHer,
  }), shallow);
  const now = useNow(30_000, st.quietUntil > 0);
  const quiet = st.quietUntil > now;
  return (
    <Section title={st.persona ? '她在旁边' : '回复设置'} className="status-panel__section--ctl">
      <div className="herctl">
        {st.persona && (
          <div className="herctl__row">
            <div className="herctl__k">话量<small>{LEVEL_HINT[st.level]}</small></div>
            <Segmented<Level> size="sm" label="她的话量" value={st.level} onChange={(v) => actions.setLevel(v)} options={LEVELS} />
          </div>
        )}
        <WSwitch label="角色口吻" description={st.persona ? '她用自己的口吻说话' : '关着：只说事实，不出表情'} checked={st.persona} onChange={(v) => actions.setPersona(v)} />
        {st.persona && (
          <>
            <div className="herctl__row">
              <div className="herctl__k">她主动说话<small>{proactiveNote(st.level, st.proactive)}</small></div>
              {st.level === 's'
                ? <span className="herctl__lock">仅休息关照</span>
                : <Segmented<Settings['proactive']> size="sm" label="她主动说话" value={st.proactive} onChange={(v) => actions.setProactive(v)} options={PROACTIVE_OPTIONS} />}
            </div>
            <WSwitch label="记得小事" description="邀请制 · 只记这场对话" checked={st.memoryOn} onChange={(v) => actions.setSetting('memoryOn', v)} />
            <div className="herctl__row">
              <div className="herctl__k">随时让她退后</div>
              <div className="herctl__btns">
                <Button size="sm" variant="secondary" icon={BellOff} onClick={() => actions.quietFor(quiet ? 0 : 60)}>{quiet ? '解除安静' : '安静一小时'}</Button>
                <Button size="sm" variant="secondary" icon={st.fold ? ChevronDown : ChevronRight} aria-pressed={st.fold} onClick={() => actions.toggleFold(taskId)}>折叠她的话</Button>
              </div>
            </div>
            <WSwitch label="她退半步" description="审批、报错时她自己退后" checked={st.stepBack} onChange={(v) => actions.setSetting('stepBack', v)} />
            <div className="herctl__row">
              <div className="herctl__k">剧情框<small>把最新一句放大；默认关</small></div>
              <Segmented<Settings['storyBox']> size="sm" label="剧情框" value={st.storyBox} onChange={(v) => actions.setSetting('storyBox', v)} options={STORY_OPTIONS} />
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

/* ───────────── 面板 ───────────── */

export function StatusPanel() {
  const runId = useApp(panelRunId);
  const taskView = useApp((s) => s.view === 'task');
  const chatView = useApp((st) => (st.view === 'task' && st.selectedTaskId ? st.tasks[st.selectedTaskId]?.kind === 'chat' : false));
  const viewTaskId = useApp((s) => (s.view === 'task' ? s.selectedTaskId : undefined));
  const hasTask = useApp((s) => s.view === 'task' && !!s.selectedTaskId && !!s.tasks[s.selectedTaskId]);
  const persona = useApp((s) => personaOn(s));
  const approvals = useApp(pendingApprovals, shallow);
  const drawerOpen = useApp((s) => s.statusDrawerOpen);
  const focusAt = useApp((s) => (s.focusRequest?.target === 'approvals' ? s.focusRequest.at : 0));
  const drawer = useMedia(DRAWER_QUERY);
  const reduced = useReducedMotion();
  const wallpaperOn = useApp((s) => s.settings.wallpaper);

  const asideRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const approvalsRef = useRef<HTMLElement | null>(null);
  // 初值是 0 而不是挂载时的 focusAt：从没有右栏的页面（首页 / 待你）点「去确认」，请求和面板的挂载在同一次渲染里，面板一挂上来就得处理它.
  // 过期的请求（3 秒前）不理，免得以后挂载时误触发.
  const handledAt = useRef(0);
  const rafRef = useRef(0);
  const flashTimer = useRef<number | undefined>(undefined);
  const [flash, setFlash] = useState(false);

  // 抽屉打开时：焦点交给关闭按钮，其余界面设为 inert（键盘和读屏都够不到遮罩后面的内容），
  // 关闭后撤销 inert 并把焦点还给原来的控件。
  useEffect(() => {
    if (!drawer || !drawerOpen) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const behind = Array.from(document.querySelectorAll<HTMLElement>('.app > :not(.status-panel):not(.app__drawer-scrim)'))
      .filter((el) => !el.hasAttribute('inert'));
    behind.forEach((el) => el.setAttribute('inert', ''));
    const raf = requestAnimationFrame(() => {
      const aside = asideRef.current;
      if (aside && !aside.contains(document.activeElement)) aside.querySelector<HTMLElement>('[data-drawer-close]')?.focus({ preventScroll: true });
    });
    return () => {
      cancelAnimationFrame(raf);
      behind.forEach((el) => el.removeAttribute('inert'));
      if (previous && previous !== document.body && document.contains(previous)) previous.focus({ preventScroll: true });
    };
  }, [drawer, drawerOpen]);

  // 抽屉是模态的：Tab / Shift+Tab 在抽屉内首尾之间循环（Esc 由 App 处理）。
  const trapTab = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Tab' || !drawer || !drawerOpen) return;
    const aside = asideRef.current;
    if (!aside) return;
    const list = Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden');
    if (list.length === 0) return;
    const first = list[0];
    const last = list[list.length - 1];
    const active = document.activeElement as HTMLElement | null;
    const inList = !!active && list.includes(active);
    // A focused non-tabbable element (e.g. the approvals section) counts as sitting between its neighbours.
    const hasAfter = !!active && list.some((el) => !!(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING));
    const hasBefore = !!active && list.some((el) => !!(active.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING));
    if (!e.shiftKey && (active === last || (!inList && !hasAfter))) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && (active === first || active === aside || (!inList && !hasBefore))) { e.preventDefault(); last.focus(); }
  };

  // 「去确认」之类的请求：滚到待确认分区、聚焦第一张待批卡的首选按钮（先看清单/拒绝，绝不落在批准上）、短暂高亮。
  useEffect(() => {
    if (!focusAt || focusAt === handledAt.current) return;
    handledAt.current = focusAt;
    if (Date.now() - focusAt > 3000) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const section = approvalsRef.current;
      const scroller = scrollRef.current;
      if (!section || !scroller) return;
      scroller.scrollTo({ top: Math.max(0, section.offsetTop - 8), behavior: reduced ? 'auto' : 'smooth' });
      (section.querySelector<HTMLElement>('button[data-first-focus]') ?? section).focus({ preventScroll: true });
      setFlash(true);
      window.clearTimeout(flashTimer.current);
      flashTimer.current = window.setTimeout(() => setFlash(false), 1200);
    });
  }, [focusAt, reduced]);

  useEffect(() => () => {
    cancelAnimationFrame(rafRef.current);
    window.clearTimeout(flashTimer.current);
  }, []);

  const approvalsSection = <ApprovalsSection approvals={approvals} innerRef={approvalsRef} flash={flash} />;
  const pendingFirst = approvals.length > 0;

  return (
    // 作为抽屉打开时是模态对话框（背后有遮罩）；停靠在右侧时仍是普通的 complementary 地标，所以不加 role。
    <aside
      className="status-panel"
      aria-label="运行状态"
      ref={asideRef}
      role={drawer && drawerOpen ? 'dialog' : undefined}
      aria-modal={drawer && drawerOpen ? true : undefined}
      onKeyDown={trapTab}
    >
      {drawer && (
        <div className="status-panel__bar">
          <span className="label">运行状态</span>
          <IconButton icon={X} label="关闭状态面板" size="sm" data-drawer-close onClick={() => actions.toggleStatusDrawer(false)} />
        </div>
      )}
      <HerHeader runId={runId} />
      <div className="status-panel__scroll" ref={scrollRef}>
        {runId && taskView && persona && hasTask && !chatView && <TrailSection taskId={viewTaskId!} chat={false} />}
        {runId ? (
          <RunSection runId={runId} taskView={taskView} viewTaskId={viewTaskId} />
        ) : taskView && chatView && persona && hasTask ? (
          // 闲聊没有运行：这里换成她这一路的神色（原来是「闲聊没有运行」的空态）.
          <TrailSection taskId={viewTaskId!} chat />
        ) : (
          <Section title="运行">
            {taskView && chatView ? (
              <EmptyState compact icon={Radar} title="闲聊没有运行" body={lines("闲聊只是对话，不改动文件。", "要动手做事，新建一个「工作」。")} />
            ) : taskView ? (
              <EmptyState compact icon={Radar} title="这个任务还没有运行" body={lines("在工作区点「开始」后，", "这里会显示运行状态。")} />
            ) : (
              <EmptyState compact icon={Radar} title="没有进行中的运行" body={lines("开始一个任务后，", "这里会显示运行状态。")} />
            )}
          </Section>
        )}
        {/* 有待确认操作时提到最前面：它会让整个运行停下来，不该藏在滚动区下方。 */}
        {pendingFirst && approvalsSection}
        {taskView && hasTask && <ControlCard taskId={viewTaskId!} />}
        {runId && <AgentSection runId={runId} />}
        <ModelSection />
        {runId && <ContextSection runId={runId} />}
        {runId && <TokenSection runId={runId} />}
        {!pendingFirst && approvalsSection}
      </div>
      {/* 夜：主栏铺满到右栏，署名一律写在右栏底部：官方表情在前；壁纸开着再接「画面：AI 辅助同人图」（decor.css 隐藏壁纸层上的那一份）. */}
      <footer className="status-panel__foot">
        <p className="status-panel__wall-credit" data-credit="panel" title={wallpaperOn ? wallpaperFor('night').credit.label : undefined}>
          {/* 两个块级行，各自不换行（272 px 宽里不把「画面」拆开）；全文在 title 里 */}
          <span className="status-panel__wall-credit-line">{persona ? '表情：官方 © miHoYo' : '命途图标：官方 © miHoYo'}</span>
          {wallpaperOn ? <span className="status-panel__wall-credit-line">画面：AI 辅助同人 · 非官方</span> : null}
        </p>
      </footer>
    </aside>
  );
}
