/* Agent 页页头（施工图 §4.3）：标题「Agent」（D13：probe 以此为选择器）+ 她的一句 agents.lead（少 1 / 中 ≤2 / 多 ≤2 个气泡）.
   页头跟着状态走（r3）：有运行在走 / 她接手 / 还没有模型时，第二个气泡换成她对这次运行说的那句（nomodel > takeover > busy > idle，见 CrewNow 的 useCrewLine）；
   少档只有一个气泡，就只说这一句；没有运行时仍是 agents.lead. 这一句没取到台词（场景还没写）就保持 agents.lead，不替她编.
   persona=false：头像换成 AgentMark 40，一句取事实版，无遐蝶口吻、无表情、无贴纸. 页头不带贴纸（D19）. */
import { Bot } from 'lucide-react';
import { moodWord } from '../../../lib/mood';
import type { Agent } from '../../../lib/types';
import { AgentMark } from '../../her/AgentMark';
import { HerAvatar } from '../../her/HerAvatar';
import { NamePlate } from '../../her/NamePlate';
import { useAgentSay, splitBubbles, type HerLine } from './agentLines';
import type { Companions } from './companions';

export function AgentHead({ agents, comps, status }: { agents: Agent[]; comps: Companions; status?: HerLine }) {
  const { say, persona, level } = useAgentSay();
  const lead = say('agents.lead');
  const orch = comps.agents.orchestrator;
  const others = (['researcher', 'coder', 'reviewer'] as const).some((id) => comps.agents[id].state === 'busy');
  const word = moodWord({ surface: 'agents', agents: orch.state === 'busy' ? 'leading' : others ? 'present' : 'idle' });
  const ring = orch.state === 'busy' ? (orch.activity === 'waiting' ? 'wait' : 'work') : 'idle';
  const inTeam = agents.filter((a) => a.enabled).length;
  const intro = lead ? splitBubbles(lead.text, level === 's' ? 1 : 2) : [];
  // 状态句取代第二个气泡（少档取代唯一的那个）；第一个气泡仍是队伍的介绍.
  const bubbles = status ? (level === 's' || intro.length === 0 ? [status.text] : [intro[0], status.text]) : intro;
  const expr = status?.expr ?? lead?.expr;

  return (
    <header className="tarot-head view__header">
      <div className="view__heading tarot-head__title">
        <h1 className="view__title"><Bot size={20} aria-hidden="true" />Agent</h1>
        <p className="view__desc">{agents.length} 位同伴 · {inTeam} 位在队<br />点一张牌，看牌背</p>
      </div>
      {bubbles.length > 0 && (
        <div className="tarot-head__her" data-her={persona ? '' : undefined}>
          {persona ? (
            <HerAvatar size={56} expr={expr} ring={ring} />
          ) : (
            <span className="tarot-head__mark"><AgentMark agent="orchestrator" size={40} /></span>
          )}
          <div className="tarot-head__say">
            {persona && <NamePlate size="sm" name={agents.find((a) => a.id === 'orchestrator')?.name} word={word} dot={ring === 'work' ? 'work' : ring === 'wait' ? 'wait' : undefined} />}
            <div className="tarot-bubbles">
              {bubbles.map((b) => <p key={b} className="tarot-bubble">{b}</p>)}
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
