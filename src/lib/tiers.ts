/* 每 Agent 的工具档（施工图 §2.1）：纯函数，不读 store.
   档序 auto < confirm < off；有效档 = max(全局档, 本 Agent 覆盖)，永远不会比全局宽松.
   遐蝶（orchestrator）恒无覆盖；'other' 不开放覆盖（执行链无法按名字封它，现状也是豁免）. */
import type { Agent, AgentTiers, TierableToolId, ToolDef, ToolId, ToolPermission } from './types';

export const TIER_RANK = { auto: 0, confirm: 1, off: 2 } as const;

/** 可覆盖的工具，按工具页的惯常顺序（= seed 的 TOOLS 顺序，去掉 other）. */
export const TIERABLE_TOOLS: readonly TierableToolId[] = [
  'read_file', 'write_file', 'code_search', 'shell', 'web_search', 'web_fetch', 'git', 'browser_read', 'browser_act',
];
/** 全部工具（含 other）. */
export const ALL_TOOLS: readonly ToolId[] = [...TIERABLE_TOOLS, 'other'];

export const isTierable = (tool: ToolId): tool is TierableToolId => (TIERABLE_TOOLS as readonly string[]).includes(tool);

type AgentLike = Pick<Agent, 'id' | 'tiers'>;

/** 全局档；工具表里没有这个工具时按「需确认」（宁严勿宽）. */
function globalTier(tool: ToolId, globals: ToolDef[]): ToolPermission {
  return globals.find((t) => t.id === tool)?.permission ?? 'confirm';
}

/** 本 Agent 对这个工具的覆盖（编排 Agent 与 'other' 恒为 undefined；脏值丢弃）. */
function overrideOf(agent: AgentLike, tool: ToolId): 'confirm' | 'off' | undefined {
  if (agent.id === 'orchestrator' || !isTierable(tool)) return undefined;
  const v = agent.tiers?.[tool];
  return v === 'confirm' || v === 'off' ? v : undefined;
}

/** 本工具自己的有效档 = max(全局档, 本 Agent 覆盖)，不含工具之间的牵连. */
function ownTier(agent: AgentLike, tool: ToolId, globals: ToolDef[]): ToolPermission {
  const g = globalTier(tool, globals);
  const o = overrideOf(agent, tool);
  return o && TIER_RANK[o] > TIER_RANK[g] ? o : g;
}

/** 有效档 = max(全局档, 本 Agent 覆盖). git 命令就是执行命令（Bash / PowerShell）：执行命令有效档是黑，整个 Bash 都被禁用，git 也就用不了，所以 git 的有效档也是黑. */
export function effectiveTier(agent: AgentLike, tool: ToolId, globals: ToolDef[]): ToolPermission {
  if (tool === 'git' && ownTier(agent, 'shell', globals) === 'off') return 'off';
  return ownTier(agent, tool, globals);
}

/** 牌背「沿用全局 / 本 Agent 收紧 / 被全局禁用」. git 被执行命令的黑档带着一起关时，来源跟执行命令走. */
export function tierSource(agent: AgentLike, tool: ToolId, globals: ToolDef[]): 'global' | 'tightened' | 'global-off' {
  if (tool === 'git' && ownTier(agent, 'shell', globals) === 'off' && ownTier(agent, 'git', globals) !== 'off') return tierSource(agent, 'shell', globals);
  const g = globalTier(tool, globals);
  if (g === 'off') return 'global-off';
  const o = overrideOf(agent, tool);
  return o && TIER_RANK[o] > TIER_RANK[g] ? 'tightened' : 'global';
}

/** 每个工具的有效档（policySpec / onPermission 用）. */
export function effectiveTierMap(agent: AgentLike, globals: ToolDef[]): Record<ToolId, ToolPermission> {
  const out = {} as Record<ToolId, ToolPermission>;
  for (const t of ALL_TOOLS) out[t] = effectiveTier(agent, t, globals);
  return out;
}

/** 想把某工具调到 want：undefined 或不比全局更严 → 删除该覆盖；编排 Agent / 'other' → 'refused'. 返回新的 tiers（不改入参）. */
export function tightenTier(agent: AgentLike, tool: ToolId, want: ToolPermission | undefined, globals: ToolDef[]): AgentTiers | 'refused' {
  if (agent.id === 'orchestrator' || !isTierable(tool)) return 'refused';
  const next: AgentTiers = { ...(agent.tiers ?? {}) };
  if (want === undefined || TIER_RANK[want] <= TIER_RANK[globalTier(tool, globals)]) delete next[tool];
  else next[tool] = want === 'off' ? 'off' : 'confirm';
  return next;
}

/** 牌面「白 4 银 2 黑 4」：不含 'other'. */
export function tierCounts(agent: AgentLike, globals: ToolDef[]): { auto: number; confirm: number; off: number } {
  const n = { auto: 0, confirm: 0, off: 0 };
  for (const t of TIERABLE_TOOLS) n[effectiveTier(agent, t, globals)] += 1;
  return n;
}

/** 双写 prefs.tools 用（D17）：非 off 的工具，按惯常顺序，不含 'other'（旧清单从不含它）. 编排 Agent 原样返回它的 tools. */
export function legacyToolsOf(agent: Agent): ToolId[] {
  if (agent.id === 'orchestrator') return agent.tools;
  return TIERABLE_TOOLS.filter((t) => agent.tiers?.[t] !== 'off');
}

/** 旧 tools 清单 → tiers：不在清单里 → off；未知 id 丢弃；'other' 不动. 不是数组 → undefined（调用方用新种子默认）. */
export function migrateToolsToTiers(tools: unknown): AgentTiers | undefined {
  if (!Array.isArray(tools)) return undefined;
  const keep = new Set(tools.filter((x): x is string => typeof x === 'string'));
  const tiers: AgentTiers = {};
  for (const t of TIERABLE_TOOLS) if (!keep.has(t)) tiers[t] = 'off';
  return tiers;
}
