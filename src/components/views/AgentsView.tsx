/* Agent 页（施工图 §4.3）：塔罗牌桌。
   页头（她的一句）→ 此刻同行 + 队伍行迹 → 四张命途牌（遐蝶主牌居二、三张小牌）→ 牌背（选中那张的详情）.
   工具档只能收紧，遐蝶沿用全局；各引擎遵守与否如实写在牌面与牌背（lib/providers.ts 的 honor*）. 写 store 一律走 actions. */
import { TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useReducedMotion } from '../../lib/hooks';
import type { AgentId } from '../../lib/types';
import { actions } from '../../state/actions';
import { useVoice } from '../../state/selectors';
import { useApp } from '../../state/store';
import '../../styles/agents-tarot.css';
import '../../styles/models-agents.css';
import { engineChoices } from '../../state/models';
import { Button } from '../ui';
import { AgentHead } from './config/AgentHead';
import { shortName, useAgentSay, type HerLine } from './config/agentLines';
import { CardBack, type Respond } from './config/CardBack';
import { AGENT_ORDER, dispatchOrder, isWatching, sameCompanions, sameList, sameTrail, sameWeek, selectAgentWeek, selectCompanions, selectTeamTrail } from './config/companions';
import { CrewNow, CrewStrip, TeamTrailCard, headLine, useCrewLine } from './config/CrewNow';
import { driverBadge, driverOfAgent, tierFace, useHonorEnv } from './config/honorUi';
import { TarotDefs } from './config/TarotDefs';
import { TarotTable, type CardInfo } from './config/TarotCards';
import { sameRecord, selectAgentStats } from './config/util';

/** 牌桌里每张牌在第几列（遐蝶主牌居二，D：样稿 A）. */
const SLOT: Record<AgentId, number> = { researcher: 0, orchestrator: 1, coder: 2, reviewer: 3 };
const weekOf = (s: Parameters<typeof selectAgentWeek>[0]) => selectAgentWeek(s);

/** Agent roster as a tarot spread: who takes part in tasks, which model each one runs on, and how far each one's tools are tightened. */
export interface AgentsViewProps {
  /** 一进页就选中的那张牌（缺省：在做的那张，否则检索）；check:ui 用它渲染每张牌的牌背. */
  initial?: AgentId;
}

export function AgentsView({ initial }: AgentsViewProps) {
  const agents = useApp((s) => s.agents);
  const stats = useApp(selectAgentStats, sameRecord);
  const week = useApp(weekOf, sameWeek);
  const taskId = useApp((s) => s.selectedTaskId);
  const comps = useApp(useCallback((s) => selectCompanions(s, taskId), [taskId]), sameCompanions);
  const runId = comps.runId;
  const order = useApp(useCallback((s) => dispatchOrder(s, runId), [runId]), sameList);
  const trail = useApp(useCallback((s) => selectTeamTrail(s, runId, 2), [runId]), sameTrail);
  const noModel = useApp((s) => engineChoices(s.models).length === 0);
  const env = useHonorEnv();
  const { persona } = useVoice();
  const { say } = useAgentSay();
  const crew = useCrewLine(agents, comps, noModel);
  const reduced = useReducedMotion();

  // 进页默认选中「在做的那张，否则检索」——「在做的」以运行里实际执行的那位为准（含遐蝶，接手停用同伴的步骤时也是她）.
  // 定下来之后不再跟着谁在做而跳（页面在读的人手底下换牌背会很烦）；进页时状态还没到（还没有任何在做的）就先用检索，
  // 第一次出现在做的那位时补定一次，之后点过牌就不再动.
  const busyId = AGENT_ORDER.find((id) => comps.agents[id].state === 'busy');
  const [pick, setPick] = useState<{ id: AgentId | null; n: number }>(() => ({ id: initial ?? busyId ?? null, n: 0 }));
  useEffect(() => {
    if (pick.id === null && busyId) setPick((p) => (p.id === null ? { ...p, id: busyId } : p));
  }, [pick.id, busyId]);
  const selected: AgentId = pick.id && agents.some((a) => a.id === pick.id) ? pick.id : 'researcher';
  const choose = (id: AgentId) => setPick((p) => ({ id, n: p.n + 1 }));

  // 点牌后把牌背整个带进视野（减少动态时直接跳）；只在用户点牌 / 翻回时（n 变了）才滚，进页时不滚.
  const back = useRef<HTMLDivElement>(null);
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  useEffect(() => {
    if (pick.n === 0) return;
    back.current?.scrollIntoView?.({ behavior: reducedRef.current ? 'auto' : 'smooth', block: 'start' });
  }, [pick.n]);

  // 即时回应：改模型 / 档位 / 启用后她回一句，3 秒后收起（纯组件局部状态，不进 store）.
  const [reply, setReply] = useState<HerLine | null>(null);
  const turns = useRef(0);
  useEffect(() => {
    if (!reply) return;
    const t = window.setTimeout(() => setReply(null), 3000);
    return () => window.clearTimeout(t);
  }, [reply]);
  const respond: Respond = useCallback((scenes, slots = {}, honor, pick) => {
    turns.current += 1;
    const hit = say(scenes, slots, { facts: honor ? { honor } : undefined, n: turns.current, pick });
    if (hit) setReply(hit);
  }, [say]);

  const cards: CardInfo[] = AGENT_ORDER.flatMap((id) => {
    const agent = agents.find((a) => a.id === id);
    if (!agent) return [];
    const driver = driverOfAgent(env, agent);
    const rank = order.indexOf(id);
    // 有运行、同伴在做、遐蝶自己没在执行：缎带写「在旁看着」，不写「空闲」.
    const watching = id === 'orchestrator' && isWatching(comps);
    return [{ agent, comp: comps.agents[id], face: tierFace(agent, env, driver), badge: driverBadge(agent), watching, numeral: id === 'orchestrator' ? undefined : ['I', 'II', 'III'][rank] }];
  });
  const current = agents.find((a) => a.id === selected);
  const currentDriver = current ? driverOfAgent(env, current) : undefined;

  return (
    <div className="view agents-view tarot" data-persona={persona ? 'on' : 'off'}>
      <TarotDefs />
      <AgentHead agents={agents} comps={comps} status={headLine(crew)} />
      {noModel && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body"><p className="callout__text">{headLine(crew) ? '还没有可用的模型' : '还没有可用的模型。先到「模型接入」接入一个，这里才能给 Agent 选模型。'}</p></div>
          <div className="callout__actions"><Button size="sm" variant="secondary" onClick={() => actions.navigate('models')}>去模型接入</Button></div>
        </div>
      )}
      <div className="tarot-now">
        <CrewNow agents={agents} comps={comps} persona={persona} crew={crew} />
        <TeamTrailCard agents={agents} trail={trail} taskTitle={comps.taskTitle} />
      </div>
      <TarotTable
        cards={cards} selected={selected} persona={persona}
        strip={<CrewStrip agents={agents} comps={comps} trail={trail} />}
        onPick={(id) => { setReply(null); choose(id); }}
        onFlip={(id) => { actions.setAgentEnabled(id, true); choose(id); const a = agents.find((x) => x.id === id); respond('agents.on', { who: a ? shortName(a) : '' }); }}
      />
      <div ref={back} className="tarot-backwrap" style={{ scrollMarginTop: 8 }}>
        {current && (
          <CardBack
            key={current.id} agent={current} env={env} driver={currentDriver} face={tierFace(current, env, currentDriver)}
            comp={comps.agents[current.id]} stat={stats[current.id]} week={week[current.id]} slot={SLOT[current.id]} reply={reply} respond={respond}
          />
        )}
      </div>
    </div>
  );
}
