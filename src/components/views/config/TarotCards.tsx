/* 牌桌：四张命途牌（施工图 §4.3）。遐蝶是主牌（月面 = 官方立绘的圆形裁切，就近署名），其余三张小牌用官方命途图标.
   牌面只留五行，字号地板 12.5 px、不截断：① 序号 + 驱动小标　② 月面　③ 牌名 + 命途单词　④ 档位一行　⑤ 缎带.
   英文命途副题、模型名、honor 说明都在牌背. 整张牌是一个按钮（.tarot-pick 盖在牌上），「翻回正面」是另一个按钮.
   DOM：.tarot-face（D-09 的断言对象）、data-agent-mark（来自 AgentMark，D-05）、data-credit="moon"（D16）. */
import { useEffect, useRef, type ReactNode } from 'react';
import { FIGURE_OFFICIAL_SRC, PATH_NAME, PATH_OF, TYPE_QUANTUM_SRC } from '../../../lib/expr';
import type { Agent, AgentId } from '../../../lib/types';
import { AgentMark } from '../../her/AgentMark';
import { cx } from '../../ui';
import { shortName } from './agentLines';
import { ribbonOf, type Companion } from './companions';
import type { TierFace } from './honorUi';

export interface CardInfo {
  agent: Agent;
  comp: Companion;
  face: TierFace;
  badge: '跟随' | '命令行' | 'API';
  /** 有运行、同伴在做、她自己没在执行（遐蝶主牌）：缎带写「在旁看着」. */
  watching?: boolean;
  /** 罗马序号（三张小牌的派活顺序）；主牌没有. */
  numeral?: string;
}

const MARK_STATE = { busy: 'busy', done: 'done', idle: 'idle', queued: 'idle', off: 'off' } as const;

function Ornaments() {
  return (
    <span className="tarot-orn" aria-hidden="true">
      <svg className="tarot-orn__c tarot-orn__c--l" viewBox="0 0 100 100"><use href="#tarot-corner" /></svg>
      <svg className="tarot-orn__c tarot-orn__c--r" viewBox="0 0 100 100"><use href="#tarot-corner" /></svg>
      <svg className="tarot-orn__l tarot-orn__l--l" viewBox="0 0 100 90"><use href="#tarot-leaf" /></svg>
      <svg className="tarot-orn__l tarot-orn__l--r" viewBox="0 0 100 90"><use href="#tarot-leaf" /></svg>
    </span>
  );
}

function Card({ info, selected, persona, onPick, onFlip }: {
  info: CardInfo; selected: boolean; persona: boolean; onPick: (id: AgentId) => void; onFlip: (id: AgentId) => void;
}) {
  const { agent, comp, face, badge, numeral, watching } = info;
  const hero = agent.id === 'orchestrator';
  const down = !agent.enabled;
  const path = PATH_NAME[PATH_OF[agent.id]];
  const ribbon = ribbonOf(agent.enabled, comp, watching);
  const name = shortName(agent);
  const longName = name.length > 3;
  // 扣下 / 翻回时牌面翻一下（只在这一次渲染里带 is-turn；页面刚打开时不翻）.
  const was = useRef(down);
  const turned = was.current !== down;
  useEffect(() => { was.current = down; }, [down]);
  const label = down
    ? `${agent.name}，${path}命途，已扣下，${ribbon.text}`
    : `${agent.name}，${path}命途，${badge}，${face.line}，${ribbon.text}`;

  return (
    <article
      className={cx('tarot-card', hero ? 'is-hero' : 'is-mate', hero && persona && 'is-figure', selected && 'is-selected', down && 'is-down', ribbon.tone === 'busy' && 'is-work', ribbon.tone === 'wait' && 'is-wait')}
      data-agent={agent.id}
      data-state={down ? 'off' : comp.state}
      data-slot={hero ? 'hero' : 'mate'}
    >
      <div className={cx('tarot-face', turned && 'is-turn')} key={down ? 'down' : 'up'}>
        <Ornaments />
        <span className="tarot-top" aria-hidden="true">
          {hero ? (
            <span className="tarot-top__l">
              <img className="tarot-type" src={TYPE_QUANTUM_SRC} alt="" width={26} height={26} draggable={false} />
              {persona && <span className="tarot-num tarot-num--mark"><AgentMark agent={agent.id} size={22} /></span>}
            </span>
          ) : <span className="tarot-num">{numeral}</span>}
          {down ? <svg className="tarot-crescent-s" viewBox="0 0 24 24"><use href="#tarot-crescent" /></svg> : <span className={cx('tarot-seal', badge === '跟随' && 'is-follow')}>{badge}</span>}
        </span>

        <span className={cx('tarot-moon', !(hero && persona && !down) && !down && 'is-mark')} aria-hidden="true">
          {down ? (
            <svg className="tarot-moon__crescent" viewBox="0 0 24 24" aria-hidden="true"><use href="#tarot-crescent" /></svg>
          ) : hero && persona ? (
            <span className="tarot-moon__fig" style={{ backgroundImage: `url("${FIGURE_OFFICIAL_SRC}")` }} />
          ) : (
            <span className="tarot-moon__mark"><AgentMark agent={agent.id} size={hero ? 72 : 56} state={MARK_STATE[comp.state]} /></span>
          )}
        </span>

        <span className="tarot-title" aria-hidden="true">
          <span className={cx('tarot-name', longName && 'is-long')}>{name}</span>
          <span className="tarot-path">{down ? '步骤交还遐蝶' : path}</span>
        </span>

        {down ? (
          <button type="button" className="tarot-flip" onClick={() => onFlip(agent.id)}>翻回正面</button>
        ) : (
          <span className="tarot-tiers" data-kind={face.kind} aria-hidden="true">
            {face.kind === 'all' ? (['auto', 'confirm', 'off'] as const).map((t) => (
              <span key={t} className={cx('tarot-tier', `is-${t}`)}><i aria-hidden="true" />{t === 'auto' ? '白' : t === 'confirm' ? '银' : '黑'}{face.counts[t]}</span>
            )) : face.line}
          </span>
        )}

        <span className={cx('tarot-ribbon', `is-${ribbon.tone}`)} aria-hidden="true">{ribbon.text}</span>
      </div>

      {/* 整张牌的点击区：盖在牌上，名字里带全部要点. 「翻回正面」在它上面（z-index），自己是一个按钮. */}
      <button type="button" className="tarot-pick" aria-pressed={selected} aria-controls="tarot-back-panel" aria-label={label} onClick={() => onPick(agent.id)} />

      {hero && persona && <span className="tarot-credit" data-credit="moon">立绘：官方 © miHoYo</span>}
    </article>
  );
}

export function TarotTable({ cards, selected, persona, onPick, onFlip, strip }: {
  cards: CardInfo[]; selected: AgentId; persona: boolean; onPick: (id: AgentId) => void; onFlip: (id: AgentId) => void;
  /** 牌桌顶上的一条同行简版（矮窗口才显示，CSS 控制）. */
  strip?: ReactNode;
}) {
  return (
    <div className="tarot-table" role="group" aria-label="命途牌，点一张看牌背">
      {strip}
      {cards.map((info) => (
        <Card key={info.agent.id} info={info} selected={info.agent.id === selected} persona={persona} onPick={onPick} onFlip={onFlip} />
      ))}
    </div>
  );
}
