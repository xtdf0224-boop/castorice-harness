/* 任务里的模型菜单（输入框芯片、智能体页；MODELS-SPEC §14.7）。
   几十家服务、几百个模型时，菜单只放：默认引擎 → 最近用过的引擎（≤ 8）→ 其余就绪的引擎；
   每个引擎只放「置顶的模型 + 当前选中的 + 最近用过的（≤ 6）」，末尾一行「更多…」把这个引擎的完整列表（带搜索）换进同一个菜单。
   不把实时的全量列表灌进任务菜单。纯函数，check-models-ui 直接测。 */
import { PROVIDER_BY_ID, driverOf } from '../../../lib/providers';
import type { ModelState } from '../../../lib/types';
import { defaultChoice, engineChoices, menuValue, modelOptions, type EngineChoice } from '../../../state/models';
import type { MenuGroup, MenuOption } from '../../ui/MenuSelect';

export const MORE_PREFIX = '\u0001more:';
export const BACK_VALUE = '\u0001back';
const MAX_PINNED = 8;
const MAX_RECENT = 6;

export interface MenuPrefs { recentEngines: string[]; recentModels: Record<string, string[]> }

const wayOf = (c: EngineChoice) => (c.auth === 'api' ? 'API' : driverOf(c.driver ?? PROVIDER_BY_ID[c.provider].drivers[0]).label);
const groupLabel = (c: EngineChoice) => `${PROVIDER_BY_ID[c.provider].name} · ${wayOf(c)}`;
const groupHint = (c: EngineChoice) => (c.auth === 'api' ? 'API 密钥' : driverOf(c.driver ?? PROVIDER_BY_ID[c.provider].drivers[0]).auth === 'account' ? '账号登录' : '用 API 密钥');

/** Every model an engine offers, as menu rows (the full list; the 「更多…」 view). */
export function fullOptions(m: ModelState, c: EngineChoice): MenuOption[] {
  return modelOptions(m, c).map((x) => ({ value: menuValue(c.key, x.id), label: x.label, sub: x.id && x.id !== x.label ? x.id : undefined, meta: x.note, keywords: x.id }));
}

/** Engines in menu order: the default one, then the recently used (most recent first), then the rest in their usual order. */
export function orderEngines(choices: EngineChoice[], defaultKey: string | undefined, recent: string[]): EngineChoice[] {
  const out: EngineChoice[] = [];
  const add = (c: EngineChoice | undefined) => { if (c && !out.includes(c)) out.push(c); };
  add(choices.find((c) => c.key === defaultKey));
  for (const k of recent) add(choices.find((c) => c.key === k));
  for (const c of choices) add(c);
  return out;
}

/**
 * The task menu: per engine the pinned models, the one in use and the recent ones (≤ 6), then 「更多…」.
 * @param current  the engine key and model the chip shows now (always kept in the list)
 */
export function curatedMenuGroups(m: ModelState, prefs: MenuPrefs, current?: { key: string; model: string }): MenuGroup[] {
  const choices = engineChoices(m);
  const def = defaultChoice(m, choices);
  return orderEngines(choices, def?.key, prefs.recentEngines).map((c) => {
    const all = fullOptions(m, c);
    const byModel = new Map(all.map((o) => [o.value, o]));
    const pins = c.auth === 'api' ? (m.pinned?.[c.provider] ?? []).slice(0, MAX_PINNED) : [];
    const ids: string[] = [];
    const take = (id: string | undefined) => { if (id !== undefined && !ids.includes(id)) ids.push(id); };
    pins.forEach(take);
    if (current && current.key === c.key) take(current.model);
    (prefs.recentModels[c.key] ?? []).slice(0, MAX_RECENT).forEach(take);
    // the engine's own configured model is always there, so a fresh install still has something to pick
    take(c.model);
    // a command-line tool's 「默认（… 自己选）」 row leads
    const rows = ids.map((id) => byModel.get(menuValue(c.key, id))).filter((o): o is MenuOption => !!o);
    const first = all.find((o) => o.value === menuValue(c.key, ''));
    const options = [...(first && !rows.includes(first) ? [first] : []), ...rows];
    const shown = new Set(options.map((o) => o.value));
    if (all.some((o) => !shown.has(o.value))) options.push({ value: `${MORE_PREFIX}${c.key}`, label: '更多…', sub: `${all.length} 个模型，可搜索`, keepOpen: true });
    return { label: groupLabel(c), hint: groupHint(c), options };
  });
}

/** The 「更多…」 view of one engine: a way back, then every model (the menu windows and filters it). */
export function moreMenuGroups(m: ModelState, engineKey: string): MenuGroup[] {
  const c = engineChoices(m).find((x) => x.key === engineKey);
  if (!c) return [];
  return [
    { options: [{ value: BACK_VALUE, label: '‹ 返回精选', sub: groupLabel(c), keepOpen: true }] },
    { label: groupLabel(c), hint: groupHint(c), options: fullOptions(m, c) },
  ];
}

/** The engine a 「更多…」 row opens, or undefined. */
export const moreEngine = (value: string): string | undefined => (value.startsWith(MORE_PREFIX) ? value.slice(MORE_PREFIX.length) : undefined);

