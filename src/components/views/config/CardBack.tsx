/* 牌背：选中那张牌的详情（施工图 §4.3）。
   页眉（牌背 · 名 + 英文命途副题 + 她的话摘要 + 启用开关）→ 白 / 银 / 黑汇总卡（随引擎分三态，兼筛选）→ 工具行（两列，三段开关，只能收紧）
   → 模型 → 一段「此刻实际会怎样」的说明（honorSummary，逐引擎、逐权限模式）→ 统计与近 7 天小柱.
   她的话：摘要随牌与引擎取场景；改模型 / 档位 / 启用后回一句（agents.setmodel|white|silver|black|on|off|locked）：状态在 AgentsView（3 秒后收起，不进 store），
   这里只负责显示（aria-live="polite"）与触发；不带贴纸. */
import { Download, Eye, FilePen, FileText, GitBranch, Globe, Lock, MousePointerClick, Search, Terminal, type LucideIcon } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { PATH_NAME, PATH_OF } from '../../../lib/expr';
import { PERMISSION_MODE_LABEL, honorOf, honorPool, honorSummary, type HonorDriver } from '../../../lib/providers';
import { TIER_RANK, tierSource } from '../../../lib/tiers';
import type { Agent, AgentEngine, ToolId, ToolPermission } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { useApp } from '../../../state/store';
import { HerAvatar } from '../../her/HerAvatar';
import { Button, cx } from '../../ui';
import { shortName, useAgentSay, type HerLine } from './agentLines';
import type { Companion } from './companions';
import { ModelField, engineText } from './ModelField';
import { TierGlyph } from './TarotDefs';
import { TIER_CHAR, TIER_NAME, TIER_SENTENCE, driverName, poolOfTally, honorLabel, rowHonored, toolRows, type HonorEnv, type TierFace, type ToolRowInfo } from './honorUi';
import type { AgentStat } from './util';

const PATH_EN = { remembrance: 'REMEMBRANCE', erudition: 'ERUDITION', hunt: 'THE HUNT', preservation: 'PRESERVATION' } as const;
const TOOL_ICON: Partial<Record<ToolId, LucideIcon>> = {
  read_file: FileText, write_file: FilePen, code_search: Search, shell: Terminal, web_search: Globe, web_fetch: Download, git: GitBranch, browser_read: Eye, browser_act: MousePointerClick,
};
const SOURCE_TEXT = { global: '沿用全局', tightened: '本 Agent 收紧', 'global-off': '被全局禁用' } as const;
const ROLE_SCENE: Partial<Record<Agent['id'], string>> = { researcher: 'agents.res', coder: 'agents.cod', reviewer: 'agents.rev' };

/* ───────────── 小件 ───────────── */

/** 启用开关：自绘 button[role=switch]. 遐蝶用 aria-disabled 且仍可点击（点了回 agents.locked）——不能用 ui 的 Switch，disabled 会吞事件. */
export function CardToggle({ on, locked, onToggle, onLocked, name }: { on: boolean; locked?: boolean; onToggle: (v: boolean) => void; onLocked: () => void; name: string }) {
  const id = useId();
  const { persona } = useAgentSay();
  return (
    <div className="tarot-toggle">
      <span className="tarot-toggle__text">
        <label htmlFor={id} className="tarot-toggle__label">启用</label>
        <small id={`${id}-d`}>{locked ? '编排 Agent 必须启用' : (persona ? '停用后由遐蝶接手' : '停用后由编排 Agent 接手')}</small>
      </span>
      <button
        id={id} type="button" role="switch" aria-checked={on} aria-disabled={locked || undefined} aria-describedby={`${id}-d`} aria-label={`${name} 启用`}
        className={cx('tarot-sw', on && 'is-on', locked && 'is-locked')}
        onClick={() => (locked ? onLocked() : onToggle(!on))}
      >
        <span className="tarot-sw__thumb" aria-hidden="true" />
        {locked ? <Lock size={11} aria-hidden="true" className="tarot-sw__lock" /> : null}
      </button>
    </div>
  );
}

/** 三段档位开关（白 · 自动 / 银 · 需确认 / 黑 · 禁用）：低于全局档的段禁用并说明——这里只能收紧. */
export function TierSwitch({ name, value, min, onChange }: { name: string; value: ToolPermission; min: ToolPermission; onChange: (t: ToolPermission) => void }) {
  const group = useId();
  return (
    <div role="radiogroup" aria-label={`${name} 的档位`} className="tarot-seg">
      {(['auto', 'confirm', 'off'] as const).map((t) => {
        const blocked = TIER_RANK[t] < TIER_RANK[min];
        return (
          <label key={t} className={cx('tarot-seg__opt', `is-${t}`, t === value && 'is-on', blocked && 'is-blocked')}
            title={blocked ? `全局已是「${TIER_NAME[min]}」，这里只能收紧` : `${TIER_NAME[t]}：${TIER_SENTENCE[t]}`}>
            <input type="radio" className="sr-only" name={group} value={t} checked={t === value} disabled={blocked} onChange={() => onChange(t)} />
            <TierGlyph tier={t} size={13} />
            <span aria-hidden="true">{TIER_CHAR[t]}</span>
            <span className="sr-only">{TIER_NAME[t]}</span>
          </label>
        );
      })}
    </div>
  );
}

export function WeekBars({ week }: { week: number[] }) {
  const mx = Math.max(1, ...week);
  const total = week.reduce((a, b) => a + b, 0);
  return (
    <div className="tarot-week">
      <div className="tarot-week__bars" role="img" aria-label={`近 7 天完成步骤，从旧到新：${week.join('、')}，共 ${total} 步`}>
        {week.map((v, i) => <i key={i} data-v={v} style={{ height: `${Math.max(3, Math.round((v / mx) * 38))}px` }} />)}
      </div>
      <small>近 7 天 · 完成步骤</small>
    </div>
  );
}

/* ───────────── 牌背 ───────────── */

/** 让她回一句（AgentsView 里的状态）：场景（可给备选）、槽位、此刻的遵守池（agents.silver / black 取池用）. */
export type Respond = (scenes: string | string[], slots?: Record<string, string | number>, honor?: 'enf' | 'soft' | 'none', pick?: (lineId: string) => boolean) => void;

/** 停用的同一场景（agents.off）里，v3 是描述状态的一类（「X先歇着。它不在的时候，步骤不会派给它。」）：牌背常驻摘要用它；刚点开关时的即时回应用其余的——两句不来自同一组近义句. */
const isStateLine = (id: string) => /\.v3$/.test(id);

export interface CardBackProps {
  agent: Agent;
  env: HonorEnv;
  driver: HonorDriver | undefined;
  face: TierFace;
  comp: Companion;
  stat?: AgentStat;
  week: number[];
  /** 选中那张牌在牌桌里是第几列（0–3），指向它的小三角用. */
  slot: number;
  /** 她刚回的一句（3 秒后由 AgentsView 收起）. */
  reply: HerLine | null;
  respond: Respond;
}

export function CardBack({ agent, env, driver, face, comp, stat, week, slot, reply, respond: say1 }: CardBackProps) {
  const { say, persona, level } = useAgentSay();
  const models = useApp((s) => s.models);
  const isOrch = agent.id === 'orchestrator';
  const path = PATH_OF[agent.id];
  const notools = face.kind === 'notools';
  const titleId = useId();

  const [filter, setFilter] = useState<ToolPermission | null>(null);
  const respond: Respond = (scenes, slots = {}, honor, pick) => say1(scenes, { who: shortName(agent), ...slots }, honor, pick);

  const rows = toolRows(agent, env, driver);
  const role = ROLE_SCENE[agent.id];

  // 她在页眉说的话：默认是这位同伴的自我介绍（角色场景；honor 池让 Codex / 命令行工具的介绍里自带「只认几项」的实话）——
  // 用户还没碰任何工具，不拿银档那句当开场（「这一项」没有着落，四张牌也会说成同一句）。档位的话只在点了某一行之后作为即时回应出现（onTier）.
  // API 没有角色介绍的变体，沿用 agents.comp.api；口吻关时事实版里仍把引擎实情放在最前.
  const summaryScenes = isOrch ? ['agents.self']
    : !agent.enabled ? ['agents.off']
      : driver === 'api' ? ['agents.comp.api', role]
        : persona ? [role]
          : driver === 'codex' ? ['agents.comp.two', role]
            : driver === 'dsh' ? ['agents.comp.none', role]
              : [role];
  const summary = say(summaryScenes.filter((x): x is string => !!x), { who: shortName(agent) }, { facts: { honor: poolOfTally(face.kind) }, ...(!agent.enabled && !isOrch ? { pick: isStateLine } : {}) });

  const onTier = (tool: ToolRowInfo, tier: ToolPermission) => {
    actions.setAgentTier(agent.id, tool.tool.id, tier);
    const pool = honorPool(honorOf(driver, tool.tool.id, tier, env.mode));
    respond(tier === 'auto' ? 'agents.white' : tier === 'confirm' ? 'agents.silver' : 'agents.black', { tool: tool.tool.name }, tier === 'auto' ? undefined : pool);
  };
  const onToggle = (on: boolean) => { actions.setAgentEnabled(agent.id, on); respond(on ? 'agents.on' : 'agents.off', {}, undefined, on ? undefined : (id) => !isStateLine(id)); };
  const onModel = (e: AgentEngine | undefined) => (e ? respond('agents.setmodel', { model: engineText(models, e) }) : respond('agents.follow'));

  const shown = (n: number) => (n > 0 ? String(n) : '0');
  const blocked = stat && !stat.deniedExact ? (stat.denied > 0 ? `≥${stat.denied}` : '—') : String(stat?.denied ?? 0);

  return (
    <section className="tarot-back" id="tarot-back-panel" aria-labelledby={titleId} data-agent={agent.id} data-pt={slot} data-kind={face.kind}>
      <span className="tarot-back__pt" aria-hidden="true" />
      <header className="tarot-back__head">
        <div className="tarot-back__title">
          <h2 id={titleId}>牌背 · {shortName(agent)}</h2>
          <small lang="en">{PATH_EN[path]}</small>
          <small className="tarot-back__role">{PATH_NAME[path]} · {agent.role}</small>
        </div>
        <div className="tarot-back__say">
          {summary && !reply && (
            <div className="tarot-say" data-her={persona ? '' : undefined}>
              {persona && <HerAvatar size={32} expr={summary.expr} ring="idle" />}
              <p className="tarot-say__text">{summary.text}</p>
            </div>
          )}
          <div className="tarot-reply" role="status" aria-live="polite">
            {reply && (
              <div className="tarot-say is-reply" data-her={persona ? '' : undefined} data-level={level}>
                {persona && <HerAvatar size={32} expr={reply.expr} ring="idle" />}
                <p className="tarot-say__text">{reply.text}</p>
              </div>
            )}
          </div>
        </div>
        <CardToggle on={agent.enabled} locked={isOrch} name={agent.name} onToggle={onToggle} onLocked={() => respond('agents.locked')} />
      </header>

      {notools ? (
        <p className="tarot-note tarot-note--notools">{persona && summary ? '它只用上面选的模型思考和写作。' : 'API 方式不使用工具，这里没有档位可调；它只用上面选的模型思考和写作。'}</p>
      ) : (
        <>
          <TierSummary face={face} rows={rows} driver={driver} filter={filter} onFilter={setFilter} />
          <ul className="tarot-tools" aria-label={`${agent.name} 的工具档`}>
            {rows.map((r) => {
              const Icon = TOOL_ICON[r.tool.id];
              const source = tierSource(agent, r.tool.id, env.tools);
              const honorText = driver === undefined || r.tier === 'auto' ? '' : honorLabel(r, driver);
              return (
                <li key={r.tool.id} className={cx('tarot-tool', r.dim && 'is-dim', filter && r.tier !== filter && 'is-muted')} data-tool={r.tool.id} data-tier={r.tier} data-source={source} title={r.honor.note}>
                  <span className="tarot-tool__ic" aria-hidden="true">{Icon && <Icon size={14} />}</span>
                  <span className="tarot-tool__txt">
                    <span className="tarot-tool__name">{r.tool.name}</span>
                    <small className="tarot-tool__note"><span>{SOURCE_TEXT[source]}</span>{honorText ? <span className="tarot-tool__honor">{honorText}</span> : null}</small>
                  </span>
                  {isOrch ? (
                    <span className="tarot-fixed" title="编排 Agent 沿用全局设置"><TierGlyph tier={r.tier} size={13} />{TIER_CHAR[r.tier]}</span>
                  ) : (
                    <TierSwitch name={r.tool.name} value={r.tier} min={r.tool.permission} onChange={(t) => onTier(r, t)} />
                  )}
                </li>
              );
            })}
          </ul>
          <p className="tarot-hint tarot-other">
            其他工具（子任务、MCP 等）按全局策略，不能在这里单独设置。
            {isOrch && <Button size="sm" variant="ghost" onClick={() => actions.navigate('tools')}>去工具页改全局</Button>}
          </p>
        </>
      )}

      <div className="tarot-back__cols">
        <div className="tarot-back__col">
          <ModelField agent={agent} onChanged={onModel} />
          {!notools && <HonorNote driver={driver} env={env} />}
        </div>
        <div className="tarot-back__col">
          <dl className="tarot-stats" aria-label={`${agent.name} 的统计`}>
            <div><dt>完成步骤</dt><dd>{shown(stat?.steps ?? 0)}</dd></div>
            {!notools && <div><dt>工具调用</dt><dd>{shown(stat?.calls ?? 0)}</dd></div>}
            {!notools && <div className={cx((stat?.errors ?? 0) > 0 && 'is-error')}><dt>出错</dt><dd>{shown(stat?.errors ?? 0)}</dd></div>}
            {!notools && <div><dt>被挡</dt><dd title={stat && !stat.deniedExact ? '只读了摘要的运行没有分项，这里不一定是全部' : undefined}>{blocked}</dd></div>}
          </dl>
          <WeekBars week={week} />
          {isOrch && <p className="tarot-hint tarot-orchnote">含编排的安排与汇总：每个做完的运行记一步。</p>}
          {!!stat?.taken && <p className="tarot-hint tarot-taken">由遐蝶接手 {stat.taken} 步（它停用期间指给它的步骤）</p>}
          {isOrch ? null : !agent.enabled && <p className="tarot-hint">已扣下：它的步骤由遐蝶接手执行，取档仍按这里设的。</p>}
          {comp.state === 'off' && comp.takenOver ? <p className="tarot-hint">当前运行里有 {comp.takenOver} 步由遐蝶接手。</p> : null}
        </div>
      </div>
    </section>
  );
}

/** 白 / 银 / 黑汇总卡：随引擎分三态（牌面同用 tierFace）. 点一张高亮该档（其余行变淡），再点取消. */
function TierSummary({ face, rows, driver, filter, onFilter }: { face: TierFace; rows: ToolRowInfo[]; driver: HonorDriver | undefined; filter: ToolPermission | null; onFilter: (t: ToolPermission | null) => void }) {
  if (face.kind === 'none') {
    return (
      <div className="tarot-sums is-none" role="note">
        <span className="tarot-sum is-none">
          <span className="tarot-sum__g"><TierGlyph tier="auto" size={16} /><TierGlyph tier="confirm" size={16} /><TierGlyph tier="off" size={16} /></span>
          <span className="tarot-sum__t">这位同伴用的命令行工具不听这里的档位</span>
          <small>下面的开关仍会存下，换成逐项遵守的引擎后生效。</small>
        </span>
      </div>
    );
  }
  // 部分遵守：写清楚是谁、认几项；一项都不认：直说「X 不听这一档」；全部遵守：用这一档本来的说法.
  const who = driverName(driver);
  const spaced = (w: string) => (/[A-Za-z]$/.test(w) ? `${w} ` : w);
  const only = (t: ToolPermission) => {
    if (face.kind !== 'partial' || t === 'auto') return undefined;
    const mine = rows.filter((r) => r.tier === t);
    if (mine.length === 0) return undefined;
    const n = mine.filter((r) => rowHonored(r, rows, driver)).length;
    if (n === 0) return `${spaced(who)}不听这一档`;
    return n < mine.length ? `${spaced(who)}只认其中 ${n} 项` : undefined;
  };
  return (
    <div className="tarot-sums" role="group" aria-label="按档位筛选工具">
      {(['auto', 'confirm', 'off'] as const).map((t) => (
        <button key={t} type="button" className={cx('tarot-sum', `is-${t}`, filter === t && 'is-on')} aria-pressed={filter === t} onClick={() => onFilter(filter === t ? null : t)}>
          <span className="tarot-sum__g"><TierGlyph tier={t} size={22} /></span>
          <span className="tarot-sum__n">{face.counts[t]}</span>
          <span className="tarot-sum__t">{TIER_NAME[t]}</span>
          <small>{only(t) ?? TIER_SENTENCE[t]}</small>
        </button>
      ))}
    </div>
  );
}

/** 一段话：此刻这个引擎、这个权限模式下，档位是否真的起作用（honorSummary；按工具分别写，不再有笼统的一句「此刻银档不会询问」）. */
export function HonorNote({ driver, env }: { driver: HonorDriver | undefined; env: HonorEnv }): ReactNode {
  const claude = driver === 'claude-code' || driver === 'claude-compat';
  return (
    <div className="tarot-honor" data-driver={driver ?? 'follow'}>
      <p className="tarot-honor__text">{honorSummary(driver, env.mode)}</p>
      {claude && <small>{env.taskEngine ? `按此刻选中任务的权限模式「${PERMISSION_MODE_LABEL[env.mode]}」说明。` : '没有选中任务，按「逐项」模式说明。'}</small>}
    </div>
  );
}
