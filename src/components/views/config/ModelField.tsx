/* 牌背里的「模型」与「推理强度」（原 AgentCard 的这一段原样搬来，逻辑不变）：
   模型菜单沿用任务菜单的精选 + 「更多…」；菜单里每个选项右侧多一个小标，写这个引擎遵守档位的方式（honorSummary 的短标签，§4.3-4）；
   遐蝶行写「跟随任务（编排 Agent 总用新建任务时选的模型）」. */
import { Cpu, Gauge, TriangleAlert } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { Effort } from '../../../lib/effort';
import { PROVIDER_BY_ID, engineLabel, honorDriver } from '../../../lib/providers';
import type { Agent, AgentEngine, ModelState, ProviderId } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { choiceEfforts, effortMenu, engineChoices, menuValue, parseMenuValue } from '../../../state/models';
import { refreshModelList } from '../../../state/services';
import { useApp } from '../../../state/store';
import { Button } from '../../ui';
import { MenuSelect, type MenuGroup } from '../../ui/MenuSelect';
import { BACK_VALUE, curatedMenuGroups, moreEngine, moreMenuGroups } from '../models/menu';
import { noteRecent, usePrefs } from '../models/prefs';
import { engineShort } from './honorUi';

/** 「Claude Sonnet 5.5 · Claude Code」: the engine as saved on the agent, whether or not its way is ready any more. */
export function engineText(models: ModelState, e: AgentEngine) {
  const [provider, auth] = e.key.split(':');
  const p = PROVIDER_BY_ID[provider as ProviderId];
  if (!p) return e.key;
  return engineLabel(p, auth === 'api' ? 'api' : 'cli', auth === 'api' ? undefined : models.providers[p.id].driver, e.model);
}

/** 每个模型选项后面加一个「遵守方式」小标（同一个引擎的选项都一样）. */
export function withHonorTags(groups: MenuGroup[], models: ModelState): MenuGroup[] {
  return groups.map((g) => ({
    ...g,
    options: g.options.map((o) => {
      if (o.keepOpen || !o.value.includes(':')) return o;
      const text = engineShort(honorDriver(models, { key: parseMenuValue(o.value).key }));
      return text ? { ...o, tags: [...(o.tags ?? []), { text, title: '这个引擎遵守工具档位的方式' }] } : o;
    }),
  }));
}

export function ModelField({ agent, onChanged }: {
  agent: Agent;
  /** 改了模型之后（让她回一句）. engine = 新的；undefined = 改回跟随任务. */
  onChanged?: (engine: AgentEngine | undefined) => void;
}) {
  const modelId = useId();
  const effortId = useId();
  const models = useApp((s) => s.models);
  const isOrchestrator = agent.id === 'orchestrator';
  const engine = agent.engine;
  const choices = engineChoices(models);
  const choice = engine ? choices.find((c) => c.key === engine.key) : undefined;
  const levels = engine && choice ? choiceEfforts(models, choice, engine.model) : [];
  // With dozens of services the menu is curated like the task box's (MODELS-SPEC §14.7): pinned + in use + recent per engine, 「更多…」 for the whole list.
  const prefs = usePrefs();
  const [scope, setScope] = useState<string | null>(null);
  const groups = useMemo(
    () => withHonorTags(scope
      ? moreMenuGroups(models, scope)
      : [{ options: [{ value: '', label: '跟随任务', sub: '用新建任务时选的模型' }] }, ...curatedMenuGroups(models, prefs, engine ? { key: engine.key, model: engine.model } : undefined)], models),
    [models, prefs, scope, engine],
  );

  // Switching the model keeps the 强度 only if the new model still offers it.
  const onModel = (v: string) => {
    const more = moreEngine(v);
    if (more) {
      setScope(more);
      const c = choices.find((x) => x.key === more);
      if (c?.auth === 'api') void refreshModelList(c.provider);
      return;
    }
    if (v === BACK_VALUE) { setScope(null); return; }
    if (!v) { actions.setAgentEngine(agent.id, undefined); onChanged?.(undefined); return; }
    const { key, model } = parseMenuValue(v);
    noteRecent(key, model);
    const next = choices.find((c) => c.key === key);
    const kept = engine?.effort && next && choiceEfforts(models, next, model).includes(engine.effort) ? engine.effort : undefined;
    const e: AgentEngine = { key, model, effort: kept };
    actions.setAgentEngine(agent.id, e);
    onChanged?.(e);
  };

  return (
    <div className="tarot-model">
      <div className="tarot-field">
        {isOrchestrator ? (
          <>
            <p className="label">模型</p>
            <p className="agent-follow"><Cpu size={14} aria-hidden />跟随任务：编排 Agent 总用新建任务时选的模型</p>
          </>
        ) : (
          <>
            <label className="label" htmlFor={modelId}>模型</label>
            <MenuSelect variant="field" id={modelId} label={`${agent.name} 的模型`} icon={Cpu} value={engine ? menuValue(engine.key, engine.model) : ''} groups={groups}
              display={engine ? engineText(models, engine) : undefined} onChange={onModel} minWidth={440}
              searchable={!!scope} maxRows={100} onOpenChange={(o) => { if (!o) setScope(null); }} />
            {engine && !choice && (
              <div className="agent-warn" role="alert">
                <TriangleAlert size={14} aria-hidden />
                <span>这个模型现在不可用，它的步骤会改用任务的模型</span>
                <Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>
              </div>
            )}
            {!engine && <p className="tarot-hint">没有单独指定，它的步骤用新建任务时选的模型。</p>}
          </>
        )}
      </div>

      {engine && choice && (
        <div className="tarot-field">
          <label className="label" htmlFor={effortId}>推理强度</label>
          {levels.length > 0 ? (
            <MenuSelect variant="field" id={effortId} label={`${agent.name} 的推理强度`} icon={Gauge} value={engine.effort && levels.includes(engine.effort) ? engine.effort : ''}
              options={effortMenu(levels)} minWidth={260}
              onChange={(v) => actions.setAgentEngine(agent.id, { ...engine, effort: (v || undefined) as Effort | undefined })} />
          ) : (
            <p className="agent-follow"><Gauge size={14} aria-hidden />这个模型不能调节推理强度</p>
          )}
        </div>
      )}
    </div>
  );
}
