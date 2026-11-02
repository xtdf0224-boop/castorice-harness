/* 推理强度. One scale in the UI (默认 / 关闭思考 / 低 / 中 / 高 / 很高 / 最高 / 极限); each vendor and CLI
   accepts a subset and spells it its own way. This file says which levels a model offers (menus) and — for the legacy
   callers — how a level becomes a request.

   API way: the levels and the spelling come from the service catalog (electron/ai/catalog/*.json: effortProfiles, effortRules,
   effortDefault, per-model entries). The MAIN PROCESS builds the real request body from the level alone
   (electron/ai/effort-wire.cjs, which implements the same tables); this file mirrors it for the menus, and
   scripts/fixtures/effort-golden.json (dumped from the first-release code) keeps both identical. CLI way: Claude Code / claude-compat
   use fixed levels, Codex reports its own, ACP agents are not tunable from here yet. */
import { maybeService, type EffortSpec, type ServiceDef } from './services';
import type { DriverId, ProviderId } from './types';

export type Effort = 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra';

export const EFFORT_LABEL: Record<Effort, string> = {
  off: '关闭思考', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极限',
};
export const EFFORT_HINT: Partial<Record<Effort, string>> = {
  off: '不思考，最快',
  max: '最慢、最费额度',
  ultra: 'Codex 会自动分派子任务',
};
const ORDER: Effort[] = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
export const sortEfforts = (list: Effort[]) => ORDER.filter((e) => list.includes(e));

/** A model as the UI lists it (static catalog or a CLI's live list). */
export interface LiveModel {
  id: string;
  label: string;
  note?: string;
  efforts?: string[];
  defaultEffort?: string;
  isDefault?: boolean;
}

type Body = Record<string, unknown>;

/* ───────────── API way: resolve (MODELS-SPEC §7.2) ───────────── */

const NONE: EffortSpec = { style: 'none', levels: [] };
const ruleCache = new Map<string, RegExp | null>();
function ruleRegex(match: string, flags?: string): RegExp | null {
  const key = `${flags ?? ''}/${match}`;
  if (!ruleCache.has(key)) {
    let re: RegExp | null = null;
    try { if (match.length <= 120) re = new RegExp(match, /^[imsu]*$/.test(flags ?? '') ? flags ?? '' : ''); } catch { re = null; }
    ruleCache.set(key, re);
  }
  return ruleCache.get(key) ?? null;
}
const profileFrom = (s: ServiceDef, ref: string | EffortSpec | undefined): EffortSpec | undefined =>
  (typeof ref === 'string' ? (s.effortProfiles && Object.hasOwn(s.effortProfiles, ref) ? s.effortProfiles[ref] : undefined) : ref);
const normalize = (spec: EffortSpec): EffortSpec => (spec.style === 'none' ? NONE : { ...spec, levels: sortEfforts(spec.levels.filter((l) => l !== 'ultra')) });

/**
 * Which levels a model offers and how its request is spelled: the model's own entry → the live list (account facts beat rules) →
 * the preset's rules (never on a custom service) → the service default → nothing (never guess). Same order as effort-wire.cjs.
 */
export function resolveEffort(service: ServiceDef | undefined, model: string, live?: Array<{ id: string; effort?: EffortSpec }>): EffortSpec {
  if (!service) return NONE;
  const own = service.models.find((m) => m.id === model && m.effort);
  if (own) { const p = profileFrom(service, own.effort); if (p) return normalize(p); }
  const lm = live?.find((m) => m.id === model && m.effort);
  if (lm?.effort) return normalize(lm.effort);
  if (service.kind !== 'custom') {
    for (const rule of service.effortRules ?? []) {
      const re = ruleRegex(rule.match, rule.flags);
      if (re && re.test(model)) { const p = profileFrom(service, rule.effort); return p ? normalize(p) : NONE; }
    }
  }
  if (service.effortDefault && service.effortDefault !== 'none') { const p = profileFrom(service, service.effortDefault); if (p) return normalize(p); }
  return NONE;
}

/** One level → request-body fields for a spec's style (a page copy of effort-wire.cjs `wire`). Used by the legacy extraBody return and the golden check. */
export function wireFields(spec: EffortSpec, level: Effort): Body {
  if (spec.style === 'none') return {};
  const off = level === 'off';
  switch (spec.style) {
    case 'anthropic':
      return off
        ? { thinking: { type: spec.offWire === 'between_tools' ? 'between_tools' : 'disabled' }, output_config: { effort: 'low' } }
        : { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: level } };
    case 're': return { reasoning_effort: off ? 'none' : level };
    case 're-think': return off ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: level };
    case 'think-switch': return { thinking: { type: off ? 'disabled' : 'enabled' } };
    case 'enable-thinking': return off ? { enable_thinking: false } : spec.effortField ? { enable_thinking: true, reasoning_effort: level } : { enable_thinking: true };
    case 'minimax': return off ? { thinking: { type: 'disabled' } } : { reasoning_split: true, reasoning_effort: level };
    case 'openrouter': return { reasoning: { effort: off ? 'none' : level } };
    default: return {};
  }
}

/** The first menu entry: 「默认」 with what the model really defaults to (MODELS-SPEC §7.6). */
export function defaultEffortLabel(spec: EffortSpec): { label: string; sub: string } {
  if (spec.default === 'on') return { label: '默认（开启）', sub: '用模型自己的默认强度' };
  if (spec.default && spec.default in EFFORT_LABEL) return { label: `默认（${EFFORT_LABEL[spec.default as Effort]}）`, sub: spec.default === 'max' ? '模型默认就是最高：最慢、最费额度' : '用模型自己的默认强度' };
  return { label: '默认', sub: '用模型自己的默认强度' };
}

/* ───────────── what the menus ask ───────────── */

const CLAUDE_CODE: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_FALLBACK: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Levels offered for a way of running a model ([] = this one cannot be tuned). `liveApi`: the service's live model list, when there is one. */
export function effortLevels(provider: ProviderId, auth: 'api' | 'cli', driver: DriverId | undefined, model: string, live?: LiveModel[], liveApi?: Array<{ id: string; effort?: EffortSpec }>): Effort[] {
  if (auth === 'api') return sortEfforts(resolveEffort(maybeService(provider), model, liveApi).levels);
  if (driver === 'claude-code' || driver === 'claude-compat') return CLAUDE_CODE;
  if (driver === 'codex') {
    const hit = live?.find((m) => m.id === model) ?? (model ? undefined : live?.find((m) => m.isDefault));
    const list = (hit?.efforts ?? []).filter((e): e is Effort => e in EFFORT_LABEL && e !== 'off');
    return sortEfforts(list.length ? list : CODEX_FALLBACK);
  }
  // A command-line agent that speaks ACP: only what it reported itself (「读取模型与模式」 → its thought_level options, the ones the ladder knows); nothing is guessed.
  if (typeof driver === 'string' && (driver.startsWith('acp:') || driver === 'kimi' || driver === 'qwen' || driver === 'mcode')) {
    const hit = live?.find((m) => m.id === model) ?? (model ? undefined : live?.find((m) => m.isDefault));
    return sortEfforts((hit?.efforts ?? []).filter((e): e is Effort => e in EFFORT_LABEL && e !== 'off'));
  }
  return [];
}

/**
 * How a level reaches the model: CLI flag value, or API body fields.
 * For the API way the main process builds the real body from the LEVEL (the page only sends `effort`); `extraBody` is returned for the
 * first-release page builds, whose main process read it — the current main process ignores it. It goes away after the migration window.
 */
export function effortRequest(provider: ProviderId, auth: 'api' | 'cli', model: string, level: Effort | undefined): { effort?: string; extraBody?: Body } {
  const service = maybeService(provider);
  // Claude streams its thinking as text only when asked for a summary; ask for it even at the default effort — but only for a model known to
  // take adaptive thinking (older Claude models refuse it; an id nobody described gets no thinking field).
  if (!level) {
    const d = auth === 'api' && service?.protocol === 'anthropic' && resolveEffort(service, model).style === 'anthropic' ? service.wire?.defaultThinking : undefined;
    return d ? { extraBody: { thinking: { type: d.type, display: d.display } } } : {};
  }
  if (auth === 'cli') return { effort: level === 'off' ? undefined : level };
  const spec = resolveEffort(service, model);
  if (!spec.levels.includes(level)) return {};
  return { extraBody: wireFields(spec, level) };
}
