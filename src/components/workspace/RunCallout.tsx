/* The state callout under the header: one message per run state, plus every pending approval of
   the run as a full ApprovalCard (preview capped and laid out beside the facts, see workspace.css,
   so the plan and tabs stay in view while the run waits). Failed runs use role="alert";
   everything else role="status".
   她的话层与内容层（AGENT-VOICE-PLAN §3.1、§4.4）：审批卡 / 提问卡 / 遗物卡 / 未竟之信是内容层——本体不变、无头像无贴纸；
   卡外那一句由 HerLead 放在卡的上方（approve.* / question.w / done.w / fail.*，40 px 头像 + 名牌 + 神色词 + 气泡）.
   E 已经把这句写进对话流的话，这里用同一句，不另编；同一句只在一处出现——这里画了，Conversation 就把那一条从对话流里让出来
   （见 Conversation 的 ownedKey）。放下之后卡上方换成一句承接（laid.down，缺就用 stop.w），失败那句回到对话流里.
   计划卡 / 审批卡 / 提问卡已经在页内时，顶部不再重复写「等待你的确认 / 计划等你批准」（第 1 轮评审）.
   运行中她的旁白（phase.* / task.start）不再吸顶（第 2 轮评审：吸顶那一行压在下面的 Agent 输出上、把整行切成半行）——
   它就是对话流里的一条普通旁白，随工作流一句一行往下排；计划卡在窄栏下收成一行，对话区因此在首屏就有位置. */
import { CirclePlay, Cpu, ListChecks, Loader, Play, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { DRIVERS } from '../../lib/providers';
import { RUN_STATUS } from '../../lib/status';
import { APPROVE_SCENES, leadMsgOf, NOTE_SLACK, QUESTION_SCENES } from '../her/logic';
import { HerLead } from '../her/HerLead';
import { hasScene } from '../../lib/voice';
import type { Approval, Question, RunStatus, TaskEngine } from '../../lib/types';
import { actions } from '../../state/actions';
import { shallow, useApp } from '../../state/store';
import { Button, cx } from '../ui';
import { ApprovalCard } from '../shell/ApprovalCard';
import { ModelNotice } from './ModelNotice';
import { QuestionCard } from './QuestionCard';
import { LetterCard, RelicCard } from './RunCards';
import { RUN_OPEN, stepCounts, useTaskEngine } from './shared';

const NO_APPROVALS: Approval[] = [];
const NO_QUESTIONS: Question[] = [];
const NO_MODEL = '这个任务的模型现在不可用';

type CalloutTone = 'neutral' | 'running' | 'success' | 'warning' | 'danger' | 'paused';

function Callout({ tone, icon: Icon, title, children, actions: buttons, role = 'status', live, spin }: {
  tone: CalloutTone; icon: LucideIcon; title: ReactNode; children?: ReactNode; actions?: ReactNode;
  role?: 'status' | 'alert'; live?: boolean; spin?: boolean;
}) {
  return (
    <div className={cx('callout', `callout--${tone}`, live && 'ws-callout--live')} role={role}>
      <Icon className={cx('callout__icon', spin && 'spin')} size={18} aria-hidden />
      <div className="callout__body">
        <p className="callout__title">{title}</p>
        {children}
      </div>
      {buttons && <div className="callout__actions">{buttons}</div>}
    </div>
  );
}

/** 失败原因只取第一行、最多 80 字，给卡外那一句的 {reason} 槽位. */
const firstLine = (text?: string) => (text ?? '').split(/\r?\n/)[0].slice(0, 80);

const PAUSE_TEXT: Record<'user' | 'reload', string> = {
  user: '你暂停了运行。',
  reload: '页面重新载入后已暂停。',
};

/** What the model may do on its own, said the way this way of running really works. */
function accessNote(engine: TaskEngine) {
  if (engine.auth === 'api') return '用 API 方式时，结果只在对话里给出，不会改动文件或执行命令。';
  const driver = engine.driver && DRIVERS[engine.driver];
  if (!driver) return '';
  return driver.approvals === 'per-call'
    ? '写文件、执行命令等操作按「工具与技能」里的设置执行，需要确认的会先问你。'
    : `${driver.label} 按沙箱策略执行，不会逐项征求你的确认。`;
}

export interface RunCalloutProps {
  taskId: string;
  /** The run being viewed. Undefined = the task has not run yet. */
  runId?: string;
  /** The latest run. Action buttons only appear when the viewed run is the latest one. */
  latestId?: string;
}

export function RunCallout({ taskId, runId, latestId }: RunCalloutProps) {
  const run = useApp((s) => {
    const r = runId ? s.runs[runId] : undefined;
    if (!r) return undefined;
    return {
      status: r.status, pauseReason: r.pauseReason, planReady: r.planReady, plan: r.plan, failure: r.failure,
      // Only needed once the run has finished; keeping it 0 while running avoids a render per second.
      sec: r.status === 'completed' ? Math.floor(r.activeMs / 1000) : 0,
      artifacts: r.artifacts.length,
      planPending: r.planApproval?.status === 'pending',
      // 卡外那一句选哪个场景要用：致命错误码、重试次数.
      failCode: r.status === 'failed' ? r.errors.find((e) => e.fatal)?.code : undefined,
      retries: Math.max(0, r.attempt - 1),
      laidDown: !!r.laidDownAt,
    };
  }, shallow);
  const taskTitle = useApp((s) => s.tasks[taskId]?.title ?? '');
  const doneLead = useApp((s) => leadMsgOf(s.tasks[taskId]?.messages, runId, 'done')?.text.trim());
  const failLead = useApp((s) => leadMsgOf(s.tasks[taskId]?.messages, runId, 'fail')?.text.trim());
  const asking = useApp((s) => (runId ? s.runs[runId]?.questions?.filter((q) => q.status === 'pending') : undefined) ?? NO_QUESTIONS, shallow);
  const pending = useApp((s) => (runId ? s.runs[runId]?.approvals.filter((a) => a.status === 'pending') : undefined) ?? NO_APPROVALS, shallow);
  // 待批 / 待答的那一句：E 写进对话流的最近一条（不早于此刻待批的那一项），没有就查台词库.
  const approveLead = useApp((s) => leadMsgOf(s.tasks[taskId]?.messages, runId, APPROVE_SCENES, (pending[0]?.createdAt ?? 0) - NOTE_SLACK));
  const questionLead = useApp((s) => leadMsgOf(s.tasks[taskId]?.messages, runId, QUESTION_SCENES, (asking[0]?.createdAt ?? 0) - NOTE_SLACK));
  const { engine, state } = useTaskEngine(taskId);
  const lead = useApp((s) => s.agents.find((a) => a.id === 'orchestrator')?.name ?? '编排 Agent');
  const interactive = !!runId && runId === latestId;
  const ready = state === 'ready';

  if (!runId || !run) {
    if (!ready || !engine) return <div className="ws-callouts"><ModelNotice taskId={taskId} chat={false} /></div>;
    return (
      <Callout tone="neutral" icon={CirclePlay} title="准备就绪">
        <p className="callout__text">点击开始后，{lead}会先制定计划。{accessNote(engine)}</p>
        <p className="ws-callout__tag">
          <span className="engine-tag" title={`使用的模型：${engine.label}`}><Cpu size={11} aria-hidden />将由 {engine.label} 执行</span>
        </p>
      </Callout>
    );
  }

  const status: RunStatus = run.status;
  const approvalCards = pending.length > 0 && (status === 'awaiting' || status === 'paused') && (
    <>
      <HerLead
        scene={pending.some((a) => a.risk === 'high') ? 'approve.high' : 'approve.ask'} text={approveLead?.text.trim()} quiet ring="wait"
        slots={{ what: pending.length > 1 ? `${pending[0].title} 等 ${pending.length} 项` : pending[0].title }}
      />
      <div className="ws-approvals" role="group" aria-label="待确认的操作">
        {pending.map((a) => <ApprovalCard key={a.id} approval={a} />)}
      </div>
    </>
  );
  // 模型的提问：同一次提问的几个问题合并成一张卡
  const questionCards = asking.length > 0 && status === 'awaiting' && (
    <>
      <HerLead scene="question.w" text={questionLead?.text.trim()} quiet ring="wait" slots={{ what: asking[0].header || asking[0].question }} />
      <div className="ws-approvals" role="group" aria-label="等你回答的问题">
        <QuestionCard questions={asking} />
      </div>
    </>
  );

  let callout: ReactNode = null;
  switch (status) {
    case 'queued':
      callout = <Callout tone="neutral" icon={RUN_STATUS.queued.icon} title="排队中"><p className="callout__text">等待开始执行。</p></Callout>;
      break;

    case 'running':
      if (!run.planReady) {
        callout = <Callout tone="running" icon={Loader} spin live title={`${lead}正在制定计划…`} />;
      }
      break;

    case 'awaiting': {
      // 计划卡（页内）/ 审批卡 / 提问卡已经在页里，顶部不再把同一件事说第二遍.
      if (run.planPending || pending.length > 0 || asking.length > 0) break;
      const onlyPlan = run.planPending && !pending.length && !asking.length;
      const onlyAsk = !run.planPending && !pending.length && asking.length > 0;
      callout = (
        <Callout
          tone="warning" icon={onlyPlan ? ListChecks : RUN_STATUS.awaiting.icon}
          title={onlyPlan ? '计划等你批准' : onlyAsk ? '有问题等你回答' : '等待你的确认'}
          actions={run.planPending && interactive ? <Button size="sm" onClick={() => actions.requestFocus('plan')}>去看计划</Button> : undefined}
        >
          {run.planPending && <p className="callout__text">计划已经拟好。批准之后才会开始执行；可以先改，也可以发回重做。</p>}
          {pending.length > 0 && (
            <p className="callout__text">
              {pending.length > 1 ? `${pending.length} 项操作等待批准：` : '待批准：'}
              {pending.map((a) => `「${a.title}」`).join('、')}
            </p>
          )}
          {asking.length > 0 && <p className="callout__text">{asking.length} 个问题等你回答，答完它才会继续。</p>}
        </Callout>
      );
      break;
    }

    case 'paused':
      callout = (
        <Callout
          tone="paused" icon={RUN_STATUS.paused.icon} title="运行已暂停"
          actions={interactive && (
            <Button variant="primary" size="sm" icon={Play} disabled={!ready} title={ready ? undefined : NO_MODEL} onClick={() => actions.resumeRun(runId)}>继续</Button>
          )}
        >
          <p className="callout__text">
            {PAUSE_TEXT[run.pauseReason ?? 'user']}
            {pending.length > 0 && `还有 ${pending.length} 项操作待确认。`}
          </p>
        </Callout>
      );
      break;

    case 'failed': {
      const step = run.plan.find((st) => st.id === run.failure?.stepId);
      const ext = run.failCode === 'AUTH' || run.failCode === 'RATE_LIMIT' || run.failCode === 'QUOTA' || run.failCode === 'NETWORK';
      callout = (
        <>
          {run.laidDown ? (
            // 放下之后：失败那句回对话流里，卡上方换一句承接（V1 的 laid.down，没有就用 stop.w）.
            <HerLead scene={hasScene('laid.down') ? 'laid.down' : 'stop.w'} quiet word={null} slots={{ what: step?.title || taskTitle }} />
          ) : (
            <HerLead
              scene={ext ? 'fail.ext' : 'fail.w'} text={failLead} quiet
              slots={{ reason: firstLine(run.failure?.message), step: (step?.index ?? 0) + 1, title: step?.title ?? '' }}
            />
          )}
          <LetterCard taskId={taskId} runId={runId} interactive={interactive} ready={ready} noModel={NO_MODEL} />
        </>
      );
      break;
    }

    case 'cancelled':
      callout = <Callout tone="neutral" icon={RUN_STATUS.cancelled.icon} title="运行已取消"><p className="callout__text">已生成的产物仍然保留。</p></Callout>;
      break;

    case 'completed': {
      callout = (
        <>
          <HerLead
            scene="done.w" text={doneLead} slots={{ t: taskTitle }}
            facts={{ retries: run.retries, steps: stepCounts(run.plan).total, activeMs: run.sec * 1000 }}
          />
          <RelicCard taskId={taskId} runId={runId} interactive={interactive} />
        </>
      );
      break;
    }
  }

  // The latest run is stopped and its model cannot run again: say so (and where to fix it) under the result.
  const notice = interactive && !ready && (status === 'paused' || !RUN_OPEN.has(status)) ? <ModelNotice taskId={taskId} chat={false} /> : null;
  if (!callout && !approvalCards && !questionCards && !notice) return null;
  return <div className="ws-callouts">{callout}{questionCards}{approvalCards}{notice}</div>;
}
