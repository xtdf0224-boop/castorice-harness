/* 计划审批（K11）：计划出来之后先等你批准，批准之后才执行（萤火是直接执行）。
   PlanDecision 是计划面板底部的一条：批准计划 / 改一改 / 发回重做（带一句意见）。
   PlanEditor 在「改一改」时替换步骤列表：改标题、说明、负责的 Agent，调顺序，删步骤，加步骤。批准时会记上「已编辑」。
   意见框里的回车经过输入法守卫。批准没有单键。 */
import { ArrowDown, ArrowUp, ListChecks, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { guardEnter } from '../../lib/ime';
import type { AgentId, PlanStep } from '../../lib/types';
import { PLAN_STEP_CAP } from '../../state/engine';
import { decidePlan, editPlan, type PlanDraftStep } from '../../state/runActions';
import { shallow, useApp } from '../../state/store';
import '../../styles/engine-cards.css';
import { Button, IconButton } from '../ui';

export function PlanDecision({ runId, editing, onEditing }: { runId: string; editing: boolean; onEditing: (v: boolean) => void }) {
  const approval = useApp((s) => s.runs[runId]?.planApproval);
  const [revising, setRevising] = useState(false);
  const [note, setNote] = useState('');
  const noteId = useId();
  if (approval?.status !== 'pending') return null;

  const send = () => { decidePlan(runId, 'revise', note.trim() || undefined); setRevising(false); setNote(''); };
  return (
    <div className="eng-plan" role="group" aria-label="计划审批">
      <p className="eng-plan__lead">
        计划已经拟好。批准之后才会开始执行；也可以先改一改，或者发回去让它重做。
        {approval.edited ? '　（已按你的修改更新）' : ''}
      </p>
      {revising && (
        <div className="eng-plan__revise">
          <input
            id={noteId} className="input" value={note} aria-label="想改的地方" placeholder="想改哪里，写在这里……" autoComplete="off" spellCheck={false}
            onChange={(e) => setNote(e.target.value)} onKeyDown={(e) => { guardEnter(e, send); }}
          />
          <Button variant="primary" size="sm" icon={Send} onClick={send}>发回去</Button>
          <Button size="sm" variant="ghost" onClick={() => { setRevising(false); setNote(''); }}>算了</Button>
        </div>
      )}
      {!editing && (
        <div className="eng-plan__bar">
          <Button variant="primary" icon={ListChecks} onClick={() => { decidePlan(runId, 'approve'); }}>批准计划</Button>
          <Button variant="secondary" icon={Pencil} onClick={() => { setRevising(false); onEditing(true); }}>改一改</Button>
          {!revising && <Button variant="ghost" onClick={() => setRevising(true)}>发回重做……</Button>}
        </div>
      )}
    </div>
  );
}

interface Draft { key: string; id?: string; title: string; detail: string; agentId: AgentId }
let draftSeq = 0;
const toDraft = (st: PlanStep): Draft => ({ key: `d${++draftSeq}`, id: st.id, title: st.title, detail: st.detail, agentId: st.agentId });

export function PlanEditor({ runId, onDone }: { runId: string; onDone: () => void }) {
  const plan = useApp((s) => s.runs[runId]?.plan);
  const roster = useApp((s) => {
    const taskId = s.runs[runId]?.taskId;
    const t = taskId ? s.tasks[taskId] : undefined;
    return s.agents.filter((a) => a.id === 'orchestrator' || (a.enabled && t?.agentIds.includes(a.id))).map((a) => ({ id: a.id, name: a.name }));
  }, shallow);
  const [steps, setSteps] = useState<Draft[]>(() => (plan ?? []).map(toDraft));
  const base = useId();

  const set = (key: string, patch: Partial<Draft>) => setSteps((list) => list.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) => setSteps((list) => {
    const j = i + d;
    if (j < 0 || j >= list.length) return list;
    const next = list.slice();
    [next[i], next[j]] = [next[j], next[i]];
    return next;
  });
  const valid = steps.length > 0 && steps.every((x) => x.title.trim());
  const save = () => {
    const out: PlanDraftStep[] = steps.map((x) => ({ id: x.id, title: x.title, detail: x.detail, agentId: x.agentId }));
    if (editPlan(runId, out).ok) onDone();
  };

  return (
    <div className="eng-plan" role="group" aria-label="编辑计划">
      <ol className="eng-editor" style={{ padding: 0 }}>
        {steps.map((x, i) => (
          <li key={x.key} className="eng-step">
            <span className="eng-step__n" aria-hidden>{i + 1}</span>
            <div className="eng-step__body">
              <input className="input" value={x.title} maxLength={40} aria-label={`第 ${i + 1} 步的标题`} placeholder="这一步叫什么" autoComplete="off" spellCheck={false}
                onChange={(e) => set(x.key, { title: e.target.value })} />
              <textarea className="input" value={x.detail} maxLength={300} aria-label={`第 ${i + 1} 步的说明`} placeholder="做什么、产出什么" spellCheck={false}
                onChange={(e) => set(x.key, { detail: e.target.value })} />
              {roster.length > 1 && (
                <label className="eng-step__agent" htmlFor={`${base}-a${i}`}>
                  负责
                  <select id={`${base}-a${i}`} className="input" value={x.agentId} onChange={(e) => set(x.key, { agentId: e.target.value as AgentId })}>
                    {roster.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </label>
              )}
            </div>
            <div className="eng-step__tools">
              <IconButton icon={ArrowUp} size="sm" label="上移" disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton icon={ArrowDown} size="sm" label="下移" disabled={i === steps.length - 1} onClick={() => move(i, 1)} />
              <IconButton icon={Trash2} size="sm" label="删掉这一步" disabled={steps.length <= 1} onClick={() => setSteps((list) => list.filter((y) => y.key !== x.key))} />
            </div>
          </li>
        ))}
      </ol>
      <div className="eng-plan__bar">
        <Button variant="primary" disabled={!valid} onClick={save}>保存修改</Button>
        <Button variant="ghost" onClick={onDone}>放弃修改</Button>
        <Button variant="secondary" size="sm" icon={Plus} disabled={steps.length >= PLAN_STEP_CAP}
          onClick={() => setSteps((list) => [...list, { key: `d${++draftSeq}`, title: '', detail: '', agentId: 'orchestrator' }])}>加一步</Button>
        <span className="eng-note">最多 {PLAN_STEP_CAP} 步。保存之后还要点「批准计划」才会开始。</span>
      </div>
    </div>
  );
}
