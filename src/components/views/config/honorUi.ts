/* Agent 页 / 工具页对「遵守矩阵」（lib/providers.ts 的 honor*）的界面侧用法：
   取驱动与权限模式（此刻选中的任务）、牌面三态、工具行说明与置灰、模型菜单里每个选项的遵守小标. 纯函数 + 一个读 store 的 hook. */
import {
  honorDriver, honorOf, honorPool, honorTally,
  type Honor, type HonorDriver,
} from '../../../lib/providers';
import { TIERABLE_TOOLS, effectiveTier, tierCounts } from '../../../lib/tiers';
import type { Agent, ModelState, PermissionMode, TaskEngine, ToolDef, ToolId, ToolPermission } from '../../../lib/types';
import { shallow, useApp } from '../../../state/store';

export interface HonorEnv {
  models: ModelState;
  tools: ToolDef[];
  /** 此刻选中任务的引擎（Agent 没单独指定模型时跟它）. */
  taskEngine?: TaskEngine;
  /** 此刻选中任务的权限模式；没有任务 = 逐项. */
  mode: PermissionMode;
}

export function useHonorEnv(): HonorEnv {
  return useApp((s): HonorEnv => {
    const engine = s.selectedTaskId ? s.tasks[s.selectedTaskId]?.engine : undefined;
    return { models: s.models, tools: s.tools, taskEngine: engine, mode: engine?.permissionMode ?? 'ask' };
  }, shallow);
}

export const driverOfAgent = (env: HonorEnv, agent: Pick<Agent, 'engine'>): HonorDriver | undefined =>
  honorDriver(env.models, agent.engine, env.taskEngine);

/** 牌面与汇总卡共用的一个结论（施工图 §4.3）：三态 + 数字. */
export interface TierFace {
  kind: 'all' | 'partial' | 'none' | 'notools';
  counts: { auto: number; confirm: number; off: number };
  honored: number;
  restricting: number;
  /** 牌面一行的文字：「白4 银2 黑4」「只认 N 项」「不受此处限制」「不使用工具」. */
  line: string;
}

export function tierFace(agent: Pick<Agent, 'id' | 'tiers'>, env: HonorEnv, driver: HonorDriver | undefined): TierFace {
  const counts = tierCounts(agent, env.tools);
  const t = honorTally(agent, env.tools, driver, env.mode);
  const line = t.kind === 'all' ? `白${counts.auto} 银${counts.confirm} 黑${counts.off}`
    : t.kind === 'partial' ? `只认 ${t.honored} 项`
      : t.kind === 'none' ? '不受此处限制' : '不使用工具';
  return { kind: t.kind, counts, honored: t.honored, restricting: t.restricting, line };
}

/** 牌上「驱动小标」（≤4 字）：没单独指定模型 = 跟随；命令行 / API. */
export function driverBadge(agent: Pick<Agent, 'engine'>): '跟随' | '命令行' | 'API' {
  const key = agent.engine?.key;
  if (!key) return '跟随';
  return key.endsWith(':api') ? 'API' : '命令行';
}

/** 汇总卡小字里的「谁」：Claude Code / Codex / DSH；其余命令行工具统称「这个命令行工具」. */
export function driverName(driver: HonorDriver | undefined): string {
  if (driver === 'codex') return 'Codex';
  if (driver === 'dsh') return 'DSH';
  if (driver === 'claude-code' || driver === 'claude-compat') return 'Claude Code';
  return '这个命令行工具';
}

/** 模型菜单里每个选项右侧的遵守小标（honorSummary 的短标签，§4.3-4）. */
export function engineShort(driver: HonorDriver | undefined): string {
  if (driver === undefined) return '';
  if (driver === 'api') return '无工具';
  if (driver === 'claude-code' || driver === 'claude-compat') return '逐项遵守';
  if (driver === 'codex') return '只认写文件和联网';
  if (driver === 'dsh') return '不受限';
  return '试了才拦';
}

export interface ToolRowInfo {
  tool: ToolDef;
  /** 有效档（全局与本 Agent 覆盖取严）. */
  tier: ToolPermission;
  honor: Honor;
  /** 该引擎不遵守这一行：整行置灰 .32 并写 honor.label. */
  dim: boolean;
}

/** 牌背工具行：每个可覆盖的工具（不含 other）. */
export function toolRows(agent: Pick<Agent, 'id' | 'tiers'>, env: HonorEnv, driver: HonorDriver | undefined): ToolRowInfo[] {
  const rows: ToolRowInfo[] = [];
  for (const id of TIERABLE_TOOLS) {
    const tool = env.tools.find((t) => t.id === id);
    if (!tool) continue;
    const tier = effectiveTier(agent, id, env.tools);
    const honor = honorOf(driver, id as ToolId, tier, env.mode);
    // 白档本来就没有限制，谈不上「不遵守」；解析不出驱动（跟随任务）时不下断言.
    const dim = driver !== undefined && driver !== 'api' && tier !== 'auto' && honorPool(honor) === 'none';
    rows.push({ tool, tier, honor, dim });
  }
  return rows;
}

/** 工具行小字里的遵守说明. Codex 只认「禁用」的写文件 / 网页搜索：银档时别写「Codex 自己管」（那会和「只认写文件和联网搜索」打架），写清它认的是哪一档. */
export function honorLabel(row: ToolRowInfo, driver: HonorDriver | undefined): string {
  if (driver === 'codex' && row.tier === 'confirm' && row.dim) {
    if (row.tool.id === 'write_file') return 'Codex 只认「禁用」（改只读沙箱）';
    if (row.tool.id === 'web_search') return 'Codex 只认「禁用」（不联网）';
  }
  return row.honor.label;
}

/** 这一行的设置在此引擎下是否真起作用（与 honorTally 同口径）：黑档 = blocks（Codex 浏览器两项都禁用例外），银档 = asks==='yes'. 白档不谈. */
export function rowHonored(row: ToolRowInfo, rows: ToolRowInfo[], driver: HonorDriver | undefined): boolean {
  if (row.tier === 'auto') return false;
  if (row.tier === 'confirm') return row.honor.asks === 'yes';
  if (row.honor.blocks) return true;
  const off = (id: ToolId) => rows.find((r) => r.tool.id === id)?.tier === 'off';
  return driver === 'codex' && (row.tool.id === 'browser_read' || row.tool.id === 'browser_act') && off('browser_read') && off('browser_act');
}

/** 牌背台词取池（agents.silver / agents.black 的 .enf / .soft / .none）：按整张牌的遵守结论. */
export function poolOfTally(kind: TierFace['kind']): 'enf' | 'soft' | 'none' {
  return kind === 'all' ? 'enf' : kind === 'partial' ? 'soft' : 'none';
}

export const TIER_NAME: Record<ToolPermission, string> = { auto: '白 · 自动', confirm: '银 · 需确认', off: '黑 · 禁用' };
export const TIER_CHAR: Record<ToolPermission, string> = { auto: '白', confirm: '银', off: '黑' };
export const TIER_SENTENCE: Record<ToolPermission, string> = { auto: '直接做，不额外限制', confirm: '先问你再做', off: '这位同伴不能用' };
