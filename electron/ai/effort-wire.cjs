'use strict';
// 推理强度 → request body fields for the API way (MODELS-SPEC §7). The page only ever sends a LEVEL; this file decides
// which fields that means for this service and model. The same tables are implemented once more on the page side
// (src/lib/effort.ts) for the menus; scripts/fixtures/effort-golden.json (made from the old code) keeps both honest.
//
//   resolveEffort(service, model, live)   → EffortSpec { style, levels, default?, offWire?, effortField? }
//   wire(spec, level)                     → body fields for one level
//   plan({ service, model, level, protocol, live }) → { spec, level, fields, notices }  (degrades a level the model does not take)
//   degradeOnce(spec, level)              → the next lower level, for the "400 names the reasoning field" retry

/** The scale the UI knows. 'ultra' is Codex only and never appears in an API spec's levels. */
const ORDER = ['off', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const LABEL = { off: '关闭思考', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: '极限' };
const STYLES = new Set(['anthropic', 're', 're-think', 'think-switch', 'enable-thinking', 'minimax', 'openrouter', 'none']);
const OFF_WIRES = new Set(['none', 'disabled', 'between_tools']);
/** The only top-level keys effort-wire may produce (the last internal assertion before a body leaves). */
const EXTRA_KEYS = new Set(['reasoning_effort', 'thinking', 'enable_thinking', 'reasoning_split', 'output_config', 'reasoning']);
const THINKING_TYPES = new Set(['enabled', 'disabled', 'adaptive', 'between_tools']);

const NONE_SPEC = Object.freeze({ style: 'none', levels: Object.freeze([]) });

const sortLevels = (list) => ORDER.filter((l) => list.includes(l));

/** Make an EffortSpec safe to use: known style, levels ⊂ scale (sorted, no 'ultra'), known offWire. */
function normalizeSpec(raw) {
  if (!raw || typeof raw !== 'object') return NONE_SPEC;
  const style = STYLES.has(raw.style) ? raw.style : 'none';
  const levels = style === 'none' ? [] : sortLevels(Array.isArray(raw.levels) ? raw.levels.filter((l) => ORDER.includes(l) && l !== 'ultra') : []);
  const out = { style, levels };
  if (raw.default === 'on' || (typeof raw.default === 'string' && ORDER.includes(raw.default))) out.default = raw.default;
  if (OFF_WIRES.has(raw.offWire)) out.offWire = raw.offWire;
  if (raw.effortField === true) out.effortField = true;
  if (typeof raw.note === 'string') out.note = raw.note.slice(0, 200);
  return out;
}

const ruleCache = new Map();
function ruleRegex(rule) {
  const key = `${rule.flags || ''}/${rule.match}`;
  if (ruleCache.has(key)) return ruleCache.get(key);
  let re = null;
  try { if (typeof rule.match === 'string' && rule.match.length <= 120) re = new RegExp(rule.match, /^[imsu]*$/.test(rule.flags || '') ? rule.flags || '' : ''); } catch { re = null; }
  ruleCache.set(key, re);
  return re;
}

/** The profile a model entry names (a name in effortProfiles, or an inline spec). */
function profileFrom(service, ref) {
  if (!ref) return undefined;
  if (typeof ref === 'string') return service.effortProfiles && Object.hasOwn(service.effortProfiles, ref) ? service.effortProfiles[ref] : undefined;
  return typeof ref === 'object' ? ref : undefined;
}

/**
 * Which levels a model offers and how its request is spelled (§7.2): first hit wins.
 * @param {object} service  a ServiceDef
 * @param {string} model
 * @param {Array<{ id: string, effort?: object }>} [live]  the live model list, when one is cached (account-level facts beat the rules)
 */
function resolveEffort(service, model, live) {
  const id = String(model || '');
  if (service) {
    // 1 + 2: this model's own entry (a user's custom service, or a preset that pins one)
    const own = (service.models || []).find((m) => m && m.id === id && m.effort);
    if (own) { const p = profileFrom(service, own.effort); if (p) return normalizeSpec(p); }
    // 3: what the live list says about this model for this account
    const lm = Array.isArray(live) ? live.find((m) => m && m.id === id && m.effort) : null;
    if (lm) return normalizeSpec(lm.effort);
    // 4: the preset's rules (never on a custom service: no user-written regex runs here)
    if (service.kind !== 'custom' && Array.isArray(service.effortRules)) {
      for (const rule of service.effortRules) {
        const re = rule && ruleRegex(rule);
        if (re && re.test(id)) { const p = profileFrom(service, rule.effort); return p ? normalizeSpec(p) : NONE_SPEC; }
      }
    }
    // 5: the service default
    if (service.effortDefault && service.effortDefault !== 'none') { const p = profileFrom(service, service.effortDefault); if (p) return normalizeSpec(p); }
  }
  // 6: do not guess
  return NONE_SPEC;
}

/** One level → the body fields for this spec's style (§7.3). Call it with a level the spec offers. */
function wire(spec, level) {
  if (!spec || spec.style === 'none' || !level) return {};
  const off = level === 'off';
  switch (spec.style) {
    case 'anthropic':
      return off
        ? { thinking: { type: spec.offWire === 'between_tools' ? 'between_tools' : 'disabled' }, output_config: { effort: 'low' } }
        : { thinking: { type: 'adaptive', display: 'summarized' }, output_config: { effort: level } };
    case 're':
      return { reasoning_effort: off ? 'none' : level };
    case 're-think':
      return off ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: level };
    case 'think-switch':
      return { thinking: { type: off ? 'disabled' : 'enabled' } };
    case 'enable-thinking':
      return off ? { enable_thinking: false } : spec.effortField ? { enable_thinking: true, reasoning_effort: level } : { enable_thinking: true };
    case 'minimax':
      return off ? { thinking: { type: 'disabled' } } : { reasoning_split: true, reasoning_effort: level };
    case 'openrouter':
      return { reasoning: { effort: off ? 'none' : level } };
    default:
      return {};
  }
}

/** Keep only the keys effort-wire may produce, with a sane `thinking`. Anything else is a bug and is dropped. */
function assertFields(fields) {
  const out = {};
  if (!fields || typeof fields !== 'object') return out;
  for (const k of Object.keys(fields)) {
    if (!EXTRA_KEYS.has(k)) continue;
    const v = fields[k];
    if (k === 'thinking') {
      if (!v || typeof v !== 'object' || !THINKING_TYPES.has(v.type)) continue;
      out.thinking = { type: v.type };
      if (v.display === 'summarized' || v.display === 'omitted') out.thinking.display = v.display;
    } else out[k] = v;
  }
  return out;
}

/** The highest offered level that is not above `level` (else the lowest offered). 'off' counts as the bottom of the scale. */
function nearestLevel(levels, level) {
  const want = ORDER.indexOf(level);
  const mine = sortLevels(levels);
  if (!mine.length) return undefined;
  const lower = mine.filter((l) => ORDER.indexOf(l) <= want);
  return lower.length ? lower[lower.length - 1] : mine[0];
}

/**
 * What goes into the body for a page-chosen level, and what to tell the user about it.
 * @param {{ service: object, model: string, level?: string, protocol?: string, live?: Array<object> }} a
 * @returns {{ spec: object, level?: string, fields: object, notices: Array<{ level: 'info'|'warn', text: string }> }}
 */
function plan(a) {
  const spec = resolveEffort(a.service, a.model, a.live);
  const notices = [];
  const wireOpts = (a.service && a.service.wire) || {};
  const defaults = () => {
    // The default level sends nothing, except the first-party Claude presets that ask for a visible thinking summary — and only for a model
    // known to take it (adaptive thinking is refused by older Claude models: an id nobody described gets no thinking field at all)
    const d = a.protocol === 'anthropic' && spec.style === 'anthropic' ? wireOpts.defaultThinking : undefined;
    return d ? { thinking: { type: d.type, display: d.display } } : {};
  };
  const level = typeof a.level === 'string' && ORDER.includes(a.level) && a.level !== 'ultra' ? a.level : undefined;
  if (!level) return { spec, level: undefined, fields: assertFields(defaults()), notices };
  if (!spec.levels.length) {
    notices.push({ level: 'info', text: '这个模型不能调节推理强度，已忽略所选的强度。' });
    return { spec, level: undefined, fields: assertFields(defaults()), notices };
  }
  let use = level;
  if (!spec.levels.includes(level)) {
    use = nearestLevel(spec.levels, level);
    notices.push({ level: 'info', text: `这个模型没有「${LABEL[level]}」，按「${LABEL[use]}」执行。` });
  }
  return { spec, level: use, fields: assertFields(wire(spec, use)), notices };
}

/**
 * The next level down for the retry after a 400 that names the reasoning field (§6.1 retry 3). 'off' is never retried (the opposite
 * intent), and there is nothing below the lowest level.
 * @returns {{ level: string, fields: object } | null}
 */
function degradeOnce(spec, level) {
  if (!spec || !level || level === 'off') return null;
  const idx = ORDER.indexOf(level);
  const lower = sortLevels(spec.levels).filter((l) => l !== 'off' && ORDER.indexOf(l) < idx);
  if (!lower.length) return null;
  const next = lower[lower.length - 1];
  return { level: next, fields: assertFields(wire(spec, next)) };
}

/** The text of a 400 that points at a reasoning field. */
const REASONING_COMPLAINT = /reasoning[_ ]?effort|thinking|enable_thinking|effort/i;

module.exports = { ORDER, LABEL, EXTRA_KEYS, NONE_SPEC, normalizeSpec, resolveEffort, wire, assertFields, nearestLevel, plan, degradeOnce, REASONING_COMPLAINT, sortLevels };
