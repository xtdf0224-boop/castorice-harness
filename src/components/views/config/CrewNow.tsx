/* 此刻同行 + 队伍行迹（借样稿 C，施工图 §4.3）。
   · 此刻同行：四个状态节点（在做 / 待命 / 做完 / 歇着），不画连线、不画顺序（顺序只在牌面罗马序号一处）+ 底部一行：
     她对这次运行的那一句（useCrewLine：nomodel / takeover / wait / busy.pipe / busy.self / idle）有运行时先放在页头（AgentHead 的第二个气泡），这里不重复，改写一行行迹摘要；
     没有运行时页头仍是 agents.lead，这里放 agents.idle 那句；
   · 队伍行迹：最近 2 行（数据取 run.plan，不取 events）+「在行迹里看全部 N 条」；停用接手的步骤写「由遐蝶接手」.
   · 矮窗口（内高 <920）里完整版沉到牌背之后，牌桌顶上改放一条紧凑的 CrewStrip（四枚 20 px 命途图标 + 名 + 状态词，右端「最近」一行 ›）：「谁在干活」不用往下滚才看到.
   Agent 身份图标处处用官方命途图标（AgentMark）；她自己的节点用 HerAvatar. 她的一句不带贴纸（D19）. */
import { ArrowRight, Route, Sparkles } from 'lucide-react';
import { actions } from '../../../state/actions';
import type { Agent, AgentId, StepStatus } from '../../../lib/types';
import { AgentMark } from '../../her/AgentMark';
import { HerAvatar } from '../../her/HerAvatar';
import { cx } from '../../ui';
import { shortName, useAgentSay, type HerLine } from './agentLines';
import { AGENT_ORDER, isWatching, ribbonOf, type Companions, type TeamTrail } from './companions';

const pad = (n: number) => String(n).padStart(2, '0');
const clock = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const STEP_STATE: Record<StepStatus, { text: string; tone: 'run' | 'wait' | 'ok' | 'bad' | 'idle' }> = {
  running: { text: '运行中', tone: 'run' },
  awaiting: { text: '待你点头', tone: 'wait' },
  done: { text: '完成', tone: 'ok' },
  failed: { text: '没过', tone: 'bad' },
  skipped: { text: '跳过', tone: 'idle' },
  cancelled: { text: '已取消', tone: 'idle' },
  pending: { text: '排队', tone: 'idle' },
};

/** 节点上的一句短状态（一行放得下）；完整的「在做什么」在她的一句与 title 里. 遐蝶「在旁看着」与主牌缎带同一个说法. */
function nodeWord(c: Companions['agents'][AgentId], watching = false): string {
  if (watching) return '在旁看着';
  if (c.state === 'busy') return c.activity === 'waiting' ? '待你点头' : c.activity === 'paused' ? '已暂停' : c.stepIndex !== undefined ? `第 ${c.stepIndex + 1} 步` : '在做';
  if (c.state === 'queued') return `排第 ${(c.nextIndex ?? 0) + 1} 步`;
  return c.state === 'off' ? '歇着' : c.text;
}

const ringOf = (c: Companions['agents'][AgentId]) => (c.state === 'busy' ? (c.activity === 'waiting' ? 'wait' : 'work') : 'idle') as 'idle' | 'work' | 'wait';

/** 她对这次运行说的那句（页头与此刻同行共用，只取一次）：kind 决定页头用不用它——
 *  nomodel > takeover（她替停用的同伴做）> wait / busy / self（有运行在走）> idle（没有运行：页头仍是 agents.lead，同行里是 agents.idle）. */
export type CrewKind = 'nomodel' | 'takeover' | 'wait' | 'busy' | 'self' | 'idle';
export interface CrewLine { kind: CrewKind; line?: HerLine }

export function useCrewLine(agents: Agent[], comps: Companions, noModel: boolean): CrewLine {
  const { say } = useAgentSay();
  const nameOf = (id: AgentId) => { const a = agents.find((x) => x.id === id); return a ? shortName(a) : id; };
  const others = AGENT_ORDER.filter((id) => id !== 'orchestrator');
  const waiting = others.find((id) => comps.agents[id].state === 'busy' && comps.agents[id].activity === 'waiting');
  const busy = others.find((id) => comps.agents[id].state === 'busy');
  const orch = comps.agents.orchestrator;
  const orchBusy = orch.state === 'busy';
  const selfSlots = { ...(orch.asFor ? { who: nameOf(orch.asFor) } : {}), doing: orch.text, step: (orch.stepIndex ?? 0) + 1, total: comps.step?.total ?? '' };
  if (noModel) return { kind: 'nomodel', line: say('agents.idle.nomodel', { who: '同伴们' }) };
  if (orchBusy && orch.asFor) return { kind: 'takeover', line: say(['agents.takeover', 'agents.busy.self'], selfSlots) };
  if (waiting) return { kind: 'wait', line: say('agents.wait', { who: nameOf(waiting) }) };
  if (busy) return { kind: 'busy', line: say(['agents.busy.pipe', 'agents.busy'], { who: nameOf(busy), doing: comps.agents[busy].text, step: (comps.agents[busy].stepIndex ?? 0) + 1, total: comps.step?.total ?? '' }) };
  if (orchBusy) return { kind: 'self', line: say('agents.busy.self', selfSlots) };
  return { kind: 'idle', line: say('agents.idle', { who: '同伴们' }) };
}

/** 页头要不要拿这句换掉第二个气泡：只有「有运行在走 / 接手 / 没模型」且这句真取到了台词. 没取到（场景还没写）就留着 agents.lead，不替她编. */
export const headLine = (crew: CrewLine): HerLine | undefined => (crew.kind === 'idle' ? undefined : crew.line);

/** 行迹摘要（页头已经说了那句时，同行底部改写这一行事实）：已完成几步 / 共几步，谁在做什么. */
function trailSummary(agents: Agent[], comps: Companions): string {
  const nameOf = (id: AgentId) => { const a = agents.find((x) => x.id === id); return a ? shortName(a) : id; };
  if (!comps.open || !comps.step) return comps.taskTitle ? '这个任务没有进行中的步骤。' : '没有进行中的步骤。';
  const live = AGENT_ORDER.find((id) => comps.agents[id].state === 'busy');
  const who = live ? `${nameOf(live)}：${comps.agents[live].text}` : '';
  return `已结束 ${comps.step.done} / ${comps.step.total} 步${who ? ` · ${who}` : ''}`;
}

export function CrewNow({ agents, comps, persona, crew }: { agents: Agent[]; comps: Companions; persona: boolean; crew: CrewLine }) {
  const byId = (id: AgentId) => agents.find((a) => a.id === id);
  const nameOf = (id: AgentId) => { const a = byId(id); return a ? shortName(a) : id; };
  const watching = isWatching(comps);
  // 页头已经替她说了这句（有运行在走 / 接手 / 没模型）：这里不再重复同一句，改写一行行迹摘要；页头没说（没有运行）才在这里放她的一句.
  const line = headLine(crew) ? undefined : crew.line;
  const summary = headLine(crew) ? trailSummary(agents, comps) : '';

  return (
    <section className="tarot-crew" aria-label="此刻同行" data-open={comps.open ? 'true' : 'false'}>
      <header className="tarot-crew__head">
        <span className="tarot-banner"><Sparkles size={13} aria-hidden="true" />此刻同行</span>
        <small className="tarot-crew__task">
          {comps.taskTitle ? <>{comps.taskTitle}{comps.step ? <>　第 <b>{comps.step.index + 1}</b> / {comps.step.total} 步</> : null}</> : '没有进行中的任务'}
        </small>
      </header>
      <ul className="tarot-nodes">
        {AGENT_ORDER.map((id) => {
          const c = comps.agents[id];
          const agent = byId(id);
          const hero = id === 'orchestrator';
          return (
            <li key={id} className={cx('tarot-node', `is-${c.state}`)} data-agent={id} data-state={c.state} title={agent?.name ? `${agent.name}：${c.text}` : c.text}>
              <span className={cx('tarot-node__av', `is-${ringOf(c)}`)} data-her={hero && persona ? '' : undefined}>
                {hero && persona ? <HerAvatar size={38} ring="none" /> : <AgentMark agent={id} size={32} state={c.state === 'busy' ? 'busy' : c.state === 'done' ? 'done' : c.state === 'off' ? 'off' : 'idle'} />}
              </span>
              <span className="tarot-node__txt">
                <b>{nameOf(id)}</b>
                <small>{nodeWord(c, hero && watching)}</small>
              </span>
            </li>
          );
        })}
      </ul>
      {line && (
        <div className="tarot-crew__say" data-her={persona ? '' : undefined}>
          {persona && <HerAvatar size={32} expr={line.expr} ring={ringOf(comps.agents.orchestrator)} />}
          <p className="tarot-bubble">{line.text}</p>
        </div>
      )}
      {summary && <p className="tarot-crew__sum">{summary}</p>}
    </section>
  );
}

/** 牌桌顶上的一条紧凑同行（只在矮窗口里显示，CSS 控制）：不含她的话；完整版同行与行迹仍在牌背后面. */
const STRIP_WORD = (id: AgentId, c: Companions['agents'][AgentId], watching: boolean): string =>
  id === 'orchestrator' ? ribbonOf(true, c, watching).text :   // 遐蝶与主牌缎带同一个说法（在旁看着 / 在做 · 第 N 步 / 本轮做完 / 空闲）
  c.state === 'busy' ? (c.activity === 'waiting' ? '待你点头' : c.activity === 'paused' ? '已暂停' : '在做') : c.state === 'done' ? '做完' : c.state === 'off' ? '歇着' : '待命';

export function CrewStrip({ agents, comps, trail }: { agents: Agent[]; comps: Companions; trail: TeamTrail }) {
  const nameOf = (id: AgentId) => { const a = agents.find((x) => x.id === id); return a ? shortName(a) : id; };
  const watching = isWatching(comps);
  const last = trail.rows[0];
  const lastText = last ? `最近：${last.at ? clock(last.at) : '—'} ${nameOf(last.agentId)} ${last.title} · ${STEP_STATE[last.status].text}` : '';
  return (
    <div className="tarot-strip" role="group" aria-label="此刻同行，简版">
      <ul className="tarot-strip__who">
        {AGENT_ORDER.map((id) => {
          const c = comps.agents[id];
          return (
            <li key={id} className={cx('tarot-strip__chip', `is-${c.state}`)} data-agent={id} data-state={c.state} title={c.text}>
              <AgentMark agent={id} size={20} state={c.state === 'busy' ? 'busy' : c.state === 'done' ? 'done' : c.state === 'off' ? 'off' : 'idle'} />
              <b>{nameOf(id)}</b><small>{STRIP_WORD(id, c, watching)}</small>
            </li>
          );
        })}
      </ul>
      {last && (
        <button type="button" className="tarot-strip__last" title={`${lastText}，点开看行迹`} onClick={() => actions.navigate('history')}>
          <span>{lastText}</span><ArrowRight size={13} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function TeamTrailCard({ agents, trail, taskTitle }: { agents: Agent[]; trail: TeamTrail; taskTitle?: string }) {
  const nameOf = (id: AgentId) => { const a = agents.find((x) => x.id === id); return a ? shortName(a) : id; };
  return (
    <section className="tarot-trail" aria-label="队伍行迹">
      <header className="tarot-trail__head">
        <span className="tarot-trail__title"><Route size={15} aria-hidden="true" />队伍行迹</span>
        {taskTitle && <small className="tarot-trail__task">{taskTitle}</small>}
      </header>
      {trail.rows.length === 0 ? (
        <p className="tarot-hint tarot-trail__empty">还没有运行记录。派一件事下去，每一步谁做的、做到哪儿，会写在这里。</p>
      ) : (
        <ol className="tarot-trail__rows">
          {trail.rows.map((r) => {
            const st = STEP_STATE[r.status];
            return (
              <li key={r.stepId} className="tarot-trow" data-step={r.index} data-status={r.status}>
                <span className="tarot-trow__t">{r.at ? clock(r.at) : '—'}</span>
                <span className="tarot-trow__mk" aria-hidden="true"><AgentMark agent={r.agentId} size={22} /></span>
                <span className="tarot-trow__x">
                  <b>{nameOf(r.agentId)}</b> {r.title}
                  {r.ranAs && <small>由{nameOf(r.ranAs)}接手</small>}
                  {r.note && <small>{r.note}</small>}
                </span>
                <span className={cx('tarot-trow__s', `is-${st.tone}`)}>{st.text}</span>
              </li>
            );
          })}
        </ol>
      )}
      {trail.total > 0 && (
        <button type="button" className="tarot-trail__all" onClick={() => actions.navigate('history')}>
          在行迹里看全部 {trail.total} 条<ArrowRight size={14} aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
