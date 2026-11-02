/* 「待你」的一行（首页与「待你」页共用）。点开就在行内处理：
   待批 → 拒绝 / 批准一次（高风险先「放行…」再确认）；待回复 → 选项或自己写；计划 → 批准 / 再改改；
   失败 → 去看看 / 再试一次 / 知道了；回合结束 → 去看看 / 知道了。
   批准没有单键、没有全局键：每个动作都是显式的点击. 放行、排序只由确定性代码与这些控件决定. */
import { CircleHelp, Hand, ListChecks, MailOpen, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useId, useState } from 'react';
import { guardEnter } from '../../../lib/ime';
import { useTwoStep } from '../../../lib/twoStep';
import type { Approval, QueueItem, QueueKind, Question, Run } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { QUEUE_LABEL, waitingText } from '../../../state/queue';
import { answerQuestion, decidePlan } from '../../../state/runActions';
import { useApp } from '../../../state/store';
import { cx } from '../../ui';
import { MUST } from './queueSplit';

export const QUEUE_ICON: Record<QueueKind, LucideIcon> = { approval: Hand, question: CircleHelp, plan: ListChecks, failed: TriangleAlert, 'turn-done': MailOpen };
export const OPEN_LABEL: Record<QueueKind, string> = { approval: '查看', question: '回答', plan: '查看', failed: '查看', 'turn-done': '查看' };

const clockOf = (at: number) => { const d = new Date(at); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const clip = (t: string, n: number) => { const a = Array.from(t); return a.length > n ? `${a.slice(0, n).join('')}…` : t; };

/** 一行展开后的内容：就在行内处理（批准 / 回答 / 批计划 / 再试）. 首页归来笺里的「待你」行与待你页的行共用. */
export function QueueDetail({ item }: { item: QueueItem }) {
  const run = useApp((s) => (item.runId ? s.runs[item.runId] : undefined));
  const approval = useApp((s) => (item.kind === 'approval' ? s.runs[item.runId ?? '']?.approvals.find((a) => a.id === item.refId) : undefined));
  const question = useApp((s) => (item.kind === 'question' ? s.runs[item.runId ?? '']?.questions?.find((q) => q.id === item.refId) : undefined));
  const chatError = useApp((s) => {
    if (item.kind !== 'failed' || item.runId) return undefined;
    const m = s.tasks[item.taskId]?.messages;
    return m && m.length ? m[m.length - 1].text : undefined;
  });
  return (
    <>
      {item.kind === 'approval' && approval && <ApprovalDetail a={approval} item={item} />}
      {item.kind === 'question' && question && <QuestionDetail q={question} />}
      {item.kind === 'plan' && run && <PlanDetail run={run} item={item} />}
      {item.kind === 'failed' && <FailedDetail item={item} run={run} text={run?.failure?.message ?? chatError ?? item.sub} />}
      {item.kind === 'turn-done' && <DoneDetail item={item} />}
    </>
  );
}

export function QueueRow({ item, now, compact }: { item: QueueItem; now: number; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const Icon = QUEUE_ICON[item.kind];
  const urgent = useApp((s) => item.kind === 'approval' && s.runs[item.runId ?? '']?.approvals.find((a) => a.id === item.refId)?.risk === 'high');

  return (
    <li className={cx('qrow', `qrow--${item.kind}`, urgent && 'is-urgent', open && 'is-open', compact && 'is-compact')}>
      <div className="qrow__head">
        <span className="qrow__icon" aria-hidden><Icon size={18} /></span>
        <div className="qrow__text">
          <span className="qrow__title" id={`${uid}-t`}>{item.title}</span>
          <span className="qrow__meta">
            <span>{item.sub}</span>
            <span className="qrow__sep" aria-hidden />
            <span className="qrow__kind">{QUEUE_LABEL[item.kind]}</span>
            {urgent && <><span className="qrow__sep" aria-hidden /><span className="qrow__tag">须亲批</span></>}
            <span className="qrow__sep" aria-hidden />
            {/* 失败、待查看的事谈不上「在等」：写它发生的时刻，不写「等 N 分」；等着你亲批 / 回答的才写等了多久 */}
            <span className="qrow__wait">{MUST.has(item.kind) ? `等 ${waitingText(item.since, now)}` : clockOf(item.since)}</span>
          </span>
        </div>
        <button type="button" className="qrow__open" aria-expanded={open} aria-controls={`${uid}-d`} aria-describedby={`${uid}-t`} onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : OPEN_LABEL[item.kind]}
        </button>
      </div>
      {open && (
        <div className="qrow__detail" id={`${uid}-d`} tabIndex={-1}>
          <QueueDetail item={item} />
        </div>
      )}
    </li>
  );
}

const go = (item: QueueItem, focus?: 'approvals' | 'plan') => { actions.openTask(item.taskId, item.runId); if (focus) actions.requestFocus(focus); };

function ApprovalDetail({ a, item }: { a: Approval; item: QueueItem }) {
  // 高风险的放行要点两次：第二次要来得不太快、焦点也不在按钮上（双击 / 按住 Enter 不能一步通过），五秒不确认退回去；见 lib/twoStep
  const step = useTwoStep(5000);
  const sure = step.armed;
  const risky = a.risk === 'high';
  return (
    <>
      {a.reason && <p className="qrow__why">{a.reason}</p>}
      {a.preview && <pre className="qrow__pre" tabIndex={0} aria-label="将要执行的内容">{clip(a.preview, 1600)}</pre>}
      {risky && sure && <p className="qrow__warn" role="alert">这一步可能无法收回。请看过上面的内容再决定。</p>}
      <div className="qrow__actions">
        <button type="button" className="qbtn" onClick={() => actions.decideApproval(a.id, 'reject')}>拒绝</button>
        {risky && !sure
          ? <button type="button" className="qbtn qbtn--primary" onClick={(e) => { step.press(e.currentTarget.closest<HTMLElement>('.qrow__detail')); }}>放行…</button>
          : <button type="button" className="qbtn qbtn--primary" onClick={() => { if (risky && step.press() !== 'confirm') return; actions.decideApproval(a.id, 'approve'); }}>{risky ? '确认放行' : '批准一次'}</button>}
        <button type="button" className="qbtn qbtn--ghost" onClick={() => go(item, 'approvals')}>去任务页</button>
      </div>
    </>
  );
}

function QuestionDetail({ q }: { q: Question }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState('');
  const multi = !!q.multiSelect;
  const send = (labels: string[]) => {
    const answer = [...labels, ...(other.trim() ? [other.trim()] : [])];
    if (answer.length) void answerQuestion(q.id, answer);
  };
  return (
    <>
      <p className="qrow__why">{q.question}</p>
      {q.options.length > 0 && (
        <ul className="qrow__options" aria-label="选项">
          {q.options.map((o) => {
            const on = picked.includes(o.label);
            return (
              <li key={o.label}>
                <button type="button" className={cx('qopt', on && 'is-on')} aria-pressed={multi ? on : undefined}
                  onClick={() => (multi ? setPicked((p) => (on ? p.filter((x) => x !== o.label) : [...p, o.label])) : void answerQuestion(q.id, [o.label]))}>
                  <strong>{o.label}</strong>
                  {o.description && <small>{o.description}</small>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="qrow__other">
        <input className="input" value={other} aria-label="自己写答案" placeholder={q.options.length ? '或者自己写……' : '写下答案……'} onChange={(e) => setOther(e.target.value)}
          onKeyDown={(e) => { guardEnter(e, () => send(picked)); }} />
        {(multi || !q.options.length || other.trim()) && (
          <button type="button" className="qbtn qbtn--primary" disabled={!picked.length && !other.trim()} onClick={() => send(picked)}>提交</button>
        )}
      </div>
    </>
  );
}

function PlanDetail({ run, item }: { run: Run; item: QueueItem }) {
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const steps = run.plan.slice(0, 8);
  return (
    <>
      {steps.length > 0 && (
        <ol className="qrow__steps">
          {steps.map((st) => <li key={st.id}>{st.title}</li>)}
          {run.plan.length > steps.length && <li className="is-more">另 {run.plan.length - steps.length} 步……</li>}
        </ol>
      )}
      {revising && (
        <div className="qrow__other">
          <input className="input" value={note} aria-label="想改的地方" placeholder="想改哪里，写在这里……" onChange={(e) => setNote(e.target.value)}
            onKeyDown={(e) => { guardEnter(e, () => { void decidePlan(run.id, 'revise', note.trim() || undefined); }); }} />
          <button type="button" className="qbtn qbtn--primary" onClick={() => { void decidePlan(run.id, 'revise', note.trim() || undefined); }}>发回去</button>
        </div>
      )}
      <div className="qrow__actions">
        <button type="button" className="qbtn" onClick={() => setRevising((v) => !v)} aria-pressed={revising}>再改改</button>
        <button type="button" className="qbtn qbtn--primary" onClick={() => { void decidePlan(run.id, 'approve'); }}>批准计划</button>
        <button type="button" className="qbtn qbtn--ghost" onClick={() => go(item, 'plan')}>去任务页</button>
      </div>
    </>
  );
}

function FailedDetail({ item, run, text }: { item: QueueItem; run?: Run; text: string }) {
  return (
    <>
      <p className="qrow__why">{clip(text, 400)}</p>
      <div className="qrow__actions">
        {run?.status === 'failed' && <button type="button" className="qbtn" onClick={() => actions.retryRun(run.id, 'resume')}>再试一次</button>}
        {run?.status === 'paused' && <button type="button" className="qbtn" onClick={() => actions.resumeRun(run.id)}>继续</button>}
        <button type="button" className="qbtn qbtn--primary" onClick={() => go(item)}>去看看</button>
        <button type="button" className="qbtn qbtn--ghost" onClick={() => actions.markSeen(item.taskId)}>知道了</button>
      </div>
    </>
  );
}

function DoneDetail({ item }: { item: QueueItem }) {
  return (
    <div className="qrow__actions">
      <button type="button" className="qbtn qbtn--primary" onClick={() => go(item)}>去看看</button>
      <button type="button" className="qbtn qbtn--ghost" onClick={() => actions.markSeen(item.taskId)}>知道了</button>
    </div>
  );
}
