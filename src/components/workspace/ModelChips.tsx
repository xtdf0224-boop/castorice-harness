/* 模型 + 强度 chips, shared by the home box and the chat box.
   模型: one menu grouped by service and way (Claude · API, GPT · Codex CLI…) listing concrete models by
   their version names — the CLI's live list when it has one (Codex), otherwise the catalog. 强度: only the
   levels the chosen model or tool accepts; hidden when it cannot be tuned.

   With dozens of services the menu is curated (MODELS-SPEC §14.7): the default engine, then the ones used lately, then the rest; per engine only the
   pinned models, the one in use and the recent ones, and a last row 「更多…」 that swaps that engine's whole list (searchable) into the same menu. */
import { Cpu, Gauge, Settings2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DRIVERS, PROVIDER_BY_ID, hasProvider, modelName } from '../../lib/providers';
import { EFFORT_HINT, EFFORT_LABEL, type Effort } from '../../lib/effort';
import type { DriverId, ModelState, ProviderId } from '../../lib/types';
import { actions } from '../../state/actions';
import { apiDefaultEffortLabel, choiceEfforts, effortMenu, engineChoices, menuValue, parseMenuValue } from '../../state/models';
import { refreshModelList } from '../../state/services';
import { useApp } from '../../state/store';
import { MenuSelect, type MenuGroup } from '../ui/MenuSelect';
import { BACK_VALUE, curatedMenuGroups, moreEngine, moreMenuGroups } from '../views/models/menu';
import { noteRecent, usePrefs } from '../views/models/prefs';

export interface ModelPick {
  /** EngineChoice key (`claude:cli`); '' = nothing picked yet. */
  key: string;
  /** Concrete model id ('' = the tool's default). */
  model: string;
  effort?: Effort;
  /** The CLI tool the task actually runs on (it may differ from what 模型接入 is set to now). */
  driver?: DriverId;
}

/** 「Claude Sonnet 5.5 · Claude Code」, or 「Claude Code · 默认模型」 when the tool picks the model itself. */
function pickText(models: ModelState, pick: ModelPick) {
  const [id, auth] = pick.key.split(':');
  // a custom service that was deleted: the task still reads, it just cannot be sent to
  if (!hasProvider(id)) return '（已删除）';
  const p = PROVIDER_BY_ID[id as ProviderId];
  const way = auth === 'api' ? 'API' : DRIVERS[pick.driver ?? models.providers[p.id].driver].label;
  if (pick.model) return `${modelName(p, pick.model)} · ${way}`;
  return `${auth === 'api' ? p.name : way} · 默认模型`;
}

export function ModelChips({ pick, onPick }: { pick: ModelPick; onPick: (p: ModelPick) => void }) {
  const models = useApp((s) => s.models);
  const choices = engineChoices(models);
  const listed = choices.find((c) => c.key === pick.key);
  // The vendor's tool was switched on 模型接入 after this task started (DSH → Claude Code): the task still
  // runs on its own tool, so the menu entry of the new tool is a different choice, not the current one.
  const moved = !!(listed && pick.driver && listed.driver && pick.driver !== listed.driver);
  const choice = moved ? undefined : listed;
  const levels = choice ? choiceEfforts(models, choice, pick.model) : [];
  const value = moved ? `${pick.key}@${pick.driver}|${pick.model}` : menuValue(pick.key, pick.model);
  const text = pickText(models, pick);
  const prefs = usePrefs();
  // 「更多…」: the engine whose whole list is shown in place of the curated one
  const [scope, setScope] = useState<string | null>(null);

  const groups = useMemo(() => {
    const out: Array<MenuGroup> = scope ? moreMenuGroups(models, scope) : curatedMenuGroups(models, prefs, { key: pick.key, model: pick.model });
    // The model in use is not in the list: a custom id that was changed, a way that was signed out or
    // removed. Keep showing it, labelled for what it is, so the chip never claims something else.
    if (!scope && text && !out.some((g) => g.options.some((o) => o.value === value))) {
      out.push({
        label: '当前使用',
        options: [{ value, label: choice ? `${text}（当前）` : moved ? `${text}（当前）` : `${text}（不可用）`, sub: pick.model || undefined, disabled: !choice }],
      });
    }
    return out;
  }, [models, prefs, scope, value, text, choice, pick.key, pick.model]);

  if (!choices.length && !text) {
    return (
      <button type="button" className="pchip pchip--action" onClick={() => actions.navigate('models')}>
        <Cpu size={13} aria-hidden />先接入一个模型
      </button>
    );
  }

  // the first entry says what the model's own default really is (「默认（最高）」), when that is known
  const first = choice?.auth === 'api' ? apiDefaultEffortLabel(models, choice.provider, pick.model) : { label: '默认', sub: '用模型自己的默认强度' };
  const effortOptions = (() => { const m = effortMenu(levels, first.label); return [{ ...m[0], sub: first.sub }, ...m.slice(1)]; })();

  const onModel = (v: string) => {
    const more = moreEngine(v);
    if (more) {
      setScope(more);
      // the engine's list is brought up to date when it is opened (it is one that is set up, or it would not be here)
      const c = choices.find((x) => x.key === more);
      if (c?.auth === 'api') void refreshModelList(c.provider);
      return;
    }
    if (v === BACK_VALUE) { setScope(null); return; }
    const next = parseMenuValue(v);
    if (next.key === pick.key && next.model === pick.model) return;
    const c = choices.find((x) => x.key === next.key);
    if (!c) return;
    noteRecent(next.key, next.model);
    const nextLevels = choiceEfforts(models, c, next.model);
    // Keep the level when the new model has it; a different way starts from the default set on 模型接入.
    const keep = pick.effort && nextLevels.includes(pick.effort) ? pick.effort : undefined;
    const fallback = next.key !== pick.key && c.effort && nextLevels.includes(c.effort) ? c.effort : undefined;
    onPick({ key: next.key, model: next.model, effort: keep ?? fallback });
  };

  const footer = (
    <button type="button" className="model-manage" onClick={() => actions.navigate('models')}>
      <Settings2 size={13} aria-hidden />管理模型接入
    </button>
  );

  return (
    <>
      <MenuSelect
        variant="chip" icon={Cpu} label="使用的模型" value={value} groups={groups} onChange={onModel}
        display={text ? (choice || moved ? text : `${text}（不可用）`) : undefined} placeholder="选择模型"
        title={text ? `使用的模型：${text}${pick.model ? `\n模型 ID：${pick.model}` : ''}` : '选择要用的模型'}
        footer={footer} minWidth={320} searchable={!!scope} maxRows={100} popClassName="mselect-pop--wide" onOpenChange={(o) => { if (!o) setScope(null); }}
      />
      {choice && levels.length > 0 && (
        <MenuSelect
          variant="chip" icon={Gauge} label="推理强度" value={pick.effort ?? ''} options={effortOptions}
          display={`强度 · ${pick.effort ? EFFORT_LABEL[pick.effort] : first.label}`}
          title={pick.effort ? `推理强度：${EFFORT_LABEL[pick.effort]}${EFFORT_HINT[pick.effort] ? `（${EFFORT_HINT[pick.effort]}）` : ''}` : '推理强度：用模型自己的默认'}
          onChange={(v) => onPick({ ...pick, effort: (v || undefined) as Effort | undefined })}
          minWidth={220}
        />
      )}
    </>
  );
}
