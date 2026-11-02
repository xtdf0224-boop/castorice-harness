/* 存储桥（V0α · 模块 B2「存储」）：页面和主进程 SQLite 库（electron/store）之间的 typed 封装。
   - 读：启动快照（每个任务只带尾部）、向上翻页、某个运行的工具调用/产物/终端、大输出全文、全文检索。
   - 写：Syncer 把「状态 → 库」做成增量 diff（只送变了的实体），失败不丢账。
   - 用量：recordUsage / usageSummary（只存数字）。
   浏览器开发版没有桥时：读写都退回 localStorage（用量记在 localStorage 的小环里），页面照常工作。 */
import type { Artifact, AppState, Message, Run, RunEvent, TerminalLine, Task, ToolCall, UsageRecord, UsageSummary } from './types';

/* ───────────── 通道调用 ───────────── */

export type StoreReply<T = object> = ({ ok: true } & T) | { ok: false; error: string; code?: string };

/** 每次现取（不在模块加载时固化），这样测试可以在 import 之后再放进假桥。 */
function bridge() {
  return typeof window !== 'undefined' ? window.alightDesktop : undefined;
}

/** 有桌面存储（SQLite）可用。浏览器开发版为 false。 */
export function storeAvailable(): boolean {
  return typeof bridge()?.call === 'function';
}

async function ask<T = object>(channel: string, ...args: unknown[]): Promise<StoreReply<T>> {
  const call = bridge()?.call;
  if (!call) return { ok: false, error: '需要桌面版' };
  try {
    const r = await call<StoreReply<T>>(channel, ...args);
    return r && typeof r === 'object' && 'ok' in r ? r : { ok: false, error: '存储没有响应' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/* ───────────── 类型 ───────────── */

/** 一个运行的工具调用 / 错误 / 产物 / 终端行数（含没读进页面的），以及按 Agent、按工具的分项. */
export interface RunCounts {
  calls: number;
  errors: number;
  artifacts: number;
  lines: number;
  byAgent: Record<string, { calls: number; errors: number }>;
  byTool: Record<string, { calls: number; errors: number }>;
}
export interface Paging { total: number; oldestSeq: number; loaded: number }

export interface DiskReport {
  root: string;
  freeBytes?: number;
  totalBytes?: number;
  /** 所在盘剩余空间低于阈值（15 GB）。 */
  low: boolean;
  thresholdBytes: number;
  suggestions: Array<{ dir: string; root: string; freeBytes: number; totalBytes: number }>;
}

export interface StoreStatus {
  dataDir: string;
  dbFile: string;
  /** 目录从哪来：环境变量 / 设置 / 默认（userData）。 */
  source: 'env' | 'config' | 'default';
  envLocked: boolean;
  defaultDir: string;
  /** 设置的目录用不了、暂时退回默认位置时的说明（数据没丢）。 */
  warning?: string;
  configured?: string;
  disk: DiskReport;
  schema: number;
  sqlite: string;
  bytes: number;
  counts: { tasks: number; messages: number; runs: number; toolCalls: number; events: number; usage: number };
  legacy: { at: number; from: string; counts: Record<string, number> } | null;
  usageEnabled: boolean;
}

/** 启动快照：任务带尾部消息，运行只有摘要（进行中的运行除外）。 */
export interface Snapshot {
  tasks: Task[];
  taskOrder: string[];
  runs: Run[];
  /** 没读工具调用/产物/终端的运行（摘要）。 */
  lean: string[];
  counts: Record<string, RunCounts>;
  /** 输出被折叠成摘要的工具调用 → 全文长度。 */
  big: Record<string, number>;
  events: RunEvent[];
  paging: Record<string, Paging>;
  prefs: string | null;
}

export interface PageResult {
  messages: Message[];
  calls: ToolCall[];
  big: Record<string, number>;
  more: boolean;
  oldestSeq: number;
}

export interface RunDetail {
  toolCalls: ToolCall[];
  artifacts: Artifact[];
  terminal: TerminalLine[];
  terminalTotal: number;
  big: Record<string, number>;
}

export interface SearchHit {
  messageId: string;
  taskId: string;
  runId?: string;
  role: string;
  at: number;
  taskTitle: string;
  /** 带命中位置的摘录；hitStart/hitLength 是命中在摘录里的位置（找不到为 -1）。 */
  snippet: string;
  hitStart: number;
  hitLength: number;
}

export interface BackupInfo { path: string; bytes: number; tasks: number; ms: number }
export interface BackupItem { name: string; path: string; bytes: number; at: number }

export interface SaveBatch {
  tasks?: Array<Omit<Task, 'messages'>>;
  deleteTasks?: string[];
  messages?: Array<{ taskId: string; m: Message }>;
  deleteMessages?: string[];
  runs?: Array<Omit<Run, 'toolCalls' | 'terminal' | 'artifacts'>>;
  deleteRuns?: string[];
  /** keepOutput：页面手里只有摘要，别拿摘要盖掉库里的全文。 */
  toolCalls?: Array<ToolCall & { taskId: string; keepOutput?: boolean }>;
  artifacts?: Array<Artifact & { taskId: string }>;
  terminal?: TerminalLine[];
  events?: RunEvent[];
  clearEvents?: boolean;
  taskOrder?: string[];
  prefs?: unknown;
}

/* ───────────── 登记簿：页面手里的东西「是不是被折叠过」 ─────────────
   这些不进 AppState（types.ts 是底座，不加字段），而是按 id 记在这里。 */

const bigOutputs = new Map<string, { size: number; summary: string }>();
const leanCounts = new Map<string, RunCounts>();
const pagingByTask = new Map<string, Paging>();

/** 一个工具调用的输出在页面里只是摘要时，返回全文长度；否则 undefined。 */
export function outputSize(call: Pick<ToolCall, 'id' | 'output'>): number | undefined {
  const b = bigOutputs.get(call.id);
  return b && b.summary === call.output ? b.size : undefined;
}
/** 这个摘要字符串是不是从库里读出来的（用于「别拿摘要写回库」）。 */
export function isLoadedSummary(call: Pick<ToolCall, 'id' | 'output'>): boolean {
  const b = bigOutputs.get(call.id);
  return !!b && b.summary === call.output;
}
export function noteBig(calls: ToolCall[], big: Record<string, number>) {
  for (const c of calls) {
    const size = big[c.id];
    if (size !== undefined && typeof c.output === 'string') bigOutputs.set(c.id, { size, summary: c.output });
  }
}
export function noteCounts(counts: Record<string, RunCounts>) {
  for (const [id, c] of Object.entries(counts)) leanCounts.set(id, c);
}
/** 运行里的工具调用/错误/产物/终端行数（含没读进页面的）与分项；没有登记返回 undefined。统计页对「只读了摘要」的运行用它. */
export function runCounts(runId: string): RunCounts | undefined {
  return leanCounts.get(runId);
}
export function notePaging(taskId: string, p: Paging) { pagingByTask.set(taskId, p); }
export function pagingOf(taskId: string): Paging | undefined { return pagingByTask.get(taskId); }
export function forgetTaskRegistry(taskId: string) { pagingByTask.delete(taskId); }

/* ───────────── 读 ───────────── */

/** light：不数各表行数（启动时用；counts 全是 0）. */
export async function getStatus(light = false): Promise<StoreReply<{ status: StoreStatus }>> {
  const r = await ask<StoreStatus>('store:status', light ? { light: true } : {});
  if (!r.ok) return r;
  const { ok: _ok, ...status } = r;
  return { ok: true, status: status as StoreStatus };
}

export async function loadSnapshot(opts?: { tailBig?: number; tailSmall?: number; bigTasks?: number; eventsLimit?: number }): Promise<StoreReply<{ snapshot: Snapshot }>> {
  const r = await ask<Snapshot>('store:load', opts ?? {});
  if (!r.ok) return r;
  const { ok: _ok, ...snapshot } = r;
  noteCounts(snapshot.counts);
  for (const [id, p] of Object.entries(snapshot.paging)) notePaging(id, p);
  for (const run of snapshot.runs) noteBig(run.toolCalls, snapshot.big);
  return { ok: true, snapshot: snapshot as Snapshot };
}

/** 向上翻页：seq < beforeSeq 的 limit 条消息（老的在前）和夹在其间的工具调用。 */
export async function pageMessages(req: { taskId: string; beforeSeq: number; limit?: number; withCalls?: boolean }): Promise<StoreReply<PageResult>> {
  const r = await ask<PageResult>('store:page', req);
  if (r.ok) noteBig(r.calls, r.big);
  return r;
}

/** 某任务里使用者发的消息（老的在前，最近 limit 条）。页面只常驻尾部窗口，计划 / 执行的提示词要用全部的补充说明. */
export async function userMessages(taskId: string, limit?: number): Promise<StoreReply<{ messages: Array<{ id: string; at: number; text: string }> }>> {
  return ask('store:user-messages', { taskId, limit });
}

/** 某任务在 [fromAt, toAt] 时间内开始的工具调用（最多 limit 条，取最新的）。 */
export async function callsInRange(req: { taskId: string; fromAt: number; toAt?: number; limit?: number }): Promise<StoreReply<{ calls: ToolCall[]; big: Record<string, number> }>> {
  const r = await ask<{ calls: ToolCall[]; big: Record<string, number> }>('store:calls', req);
  if (r.ok) noteBig(r.calls, r.big);
  return r;
}

/** 一个运行的工具调用（大输出只给摘要）、产物、终端最后 terminalTail 行。 */
export async function loadRunDetail(runId: string, terminalTail?: number): Promise<StoreReply<RunDetail>> {
  const r = await ask<RunDetail>('store:run', { runId, terminalTail });
  if (r.ok) noteBig(r.toolCalls, r.big);
  return r;
}

/** 工具调用的全文输出。 */
export async function fullOutput(callId: string): Promise<string | undefined> {
  const r = await ask<{ found: boolean; output: string }>('store:output', callId);
  return r.ok && r.found ? r.output : undefined;
}

/** 搜消息正文（相关度排序）。CJK 逐字切词，两个字的词也能搜到。 */
export async function searchMessages(req: { q: string; limit?: number; offset?: number; taskId?: string }): Promise<SearchHit[]> {
  const r = await ask<{ hits: SearchHit[] }>('store:search', req);
  return r.ok ? r.hits : [];
}

/** 事件日志查询（since 起、可限定运行）。 */
export async function queryEvents(req: { since?: number; runId?: string; limit?: number } = {}): Promise<RunEvent[]> {
  const r = await ask<{ events: RunEvent[] }>('store:events', req);
  return r.ok ? r.events : [];
}

export async function importLegacy(blob: unknown, from: string): Promise<StoreReply<{ counts: Record<string, number>; already: boolean }>> {
  return ask('store:import', { blob, from });
}
/** 没有旧数据可迁时打上标记，下次启动不再检查 localStorage。 */
export async function markLegacyNone(from: string): Promise<void> {
  await ask('store:mark-legacy', { from });
}

export async function saveBatch(batch: SaveBatch): Promise<StoreReply<{ skipped: number; errors: string[] }>> {
  return ask('store:save', batch);
}

/* 短名（与 persist.ts / 文档里的叫法一致）. */
export const load = (opts?: Parameters<typeof loadSnapshot>[0]) => loadSnapshot(opts);
export const save = (batch: SaveBatch) => saveBatch(batch);
export const page = (req: Parameters<typeof pageMessages>[0]) => pageMessages(req);
export const backup = (dir?: string) => backupNow(dir);

/* ───────────── 数据目录、备份 ───────────── */

export async function diskReport(): Promise<StoreReply<{ dataDir: string; disk: DiskReport }>> {
  return ask('store:disk');
}
export async function pickDataDir(start?: string): Promise<string | null> {
  const r = await ask<{ dir: string | null }>('store:pick-dir', start);
  return r.ok ? r.dir : null;
}
/** 把库搬到新目录（复制 + 自检，旧文件原样留着）。成功后页面应当重新载入。 */
export async function setDataDir(dir: string, useExisting = false): Promise<StoreReply<{ dataDir: string; previous: string; copied: BackupInfo | null }>> {
  return ask('store:set-dir', { dir, useExisting });
}
export async function backupNow(dir?: string): Promise<StoreReply<BackupInfo>> {
  return ask('store:backup', dir ? { dir } : {});
}
export async function listBackups(): Promise<StoreReply<{ dir: string; items: BackupItem[] }>> {
  return ask('store:backups');
}
export async function openDataDir(which: 'data' | 'backups' = 'data'): Promise<StoreReply<{ dir: string }>> {
  return ask('store:open-dir', which);
}
export async function compactDb(): Promise<StoreReply<{ before: number; after: number }>> {
  return ask('store:compact');
}

/* ───────────── 用量（task_usage：只有数字） ───────────── */

const usageListeners = new Set<() => void>();
/** 用量变了（记了一条 / 开关 / 清除）时通知；usage.ts 用它刷新 AppState.usage。 */
export function onUsageChange(fn: () => void): () => void {
  usageListeners.add(fn);
  return () => { usageListeners.delete(fn); };
}
function usageChanged() { usageListeners.forEach((l) => l()); }

const USAGE_LOG = 'alight/usage-log';
const USAGE_ON = 'alight/usage-enabled';
const USAGE_LOG_MAX = 2000;

function lsGet(key: string): string | null { try { return localStorage.getItem(key); } catch { return null; } }
function lsSet(key: string, v: string) { try { localStorage.setItem(key, v); } catch { /* 存储被禁用：忽略 */ } }
function webLog(): UsageRecord[] {
  try { const v = JSON.parse(lsGet(USAGE_LOG) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

/** 一个回合结束时调用（live.ts）。只记数字与 id；设置里关着开关时什么都不做。返回是否记了。 */
export async function recordUsage(rec: UsageRecord): Promise<boolean> {
  const clean: UsageRecord = {
    at: rec.at, taskId: rec.taskId, runId: rec.runId, provider: rec.provider, model: rec.model,
    inputTokens: rec.inputTokens, outputTokens: rec.outputTokens, cachedTokens: rec.cachedTokens,
    costUsd: rec.costUsd, costEstimated: rec.costEstimated, durationMs: rec.durationMs,
  };
  let recorded = false;
  if (storeAvailable()) {
    const r = await ask<{ recorded: boolean }>('usage:add', clean);
    recorded = r.ok && r.recorded;
  } else if (lsGet(USAGE_ON) !== '0') {
    const log = webLog();
    const key = (x: UsageRecord) => `${x.taskId}|${x.runId ?? ''}|${x.at}|${x.inputTokens}|${x.outputTokens}|${x.cachedTokens}`;
    if (!log.some((x) => key(x) === key(clean))) {
      log.push(clean);
      lsSet(USAGE_LOG, JSON.stringify(log.slice(-USAGE_LOG_MAX)));
      recorded = true;
    }
  }
  if (recorded) usageChanged();
  return recorded;
}

/** 今日 / 本周的汇总。取不到返回 undefined。 */
export async function usageSummary(now = Date.now()): Promise<UsageSummary | undefined> {
  if (storeAvailable()) {
    const r = await ask<{ summary: UsageSummary }>('usage:summary');
    return r.ok ? r.summary : undefined;
  }
  return summarizeUsage(webLog(), now);
}

export async function usageEnabled(): Promise<boolean> {
  if (storeAvailable()) {
    const r = await ask<{ enabled: boolean }>('usage:enabled');
    return r.ok ? r.enabled : true;
  }
  return lsGet(USAGE_ON) !== '0';
}
export async function setUsageEnabled(on: boolean): Promise<boolean> {
  if (storeAvailable()) {
    const r = await ask<{ enabled: boolean }>('usage:enabled', on);
    usageChanged();
    return r.ok ? r.enabled : on;
  }
  lsSet(USAGE_ON, on ? '1' : '0');
  usageChanged();
  return on;
}
export async function clearUsage(): Promise<number> {
  let removed = 0;
  if (storeAvailable()) {
    const r = await ask<{ removed: number }>('usage:clear');
    removed = r.ok ? r.removed : 0;
  } else {
    removed = webLog().length;
    lsSet(USAGE_LOG, '[]');
  }
  usageChanged();
  return removed;
}

export function startOfDay(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 本周从周一 00:00（本地时间）算起。 */
export function startOfWeek(now: number): number {
  const d = new Date(startOfDay(now));
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.getTime();
}

/** 纯函数：把一批用量记录汇总成今日 / 本周。与库里的 SQL 汇总口径一致（浏览器开发版与测试用）。
 *  tokens = 输入 + 输出（缓存读取另计，不算在内）；costUsd 只加有数字的；窗口里有未知或估算的成本 → estimated。 */
export function summarizeUsage(records: UsageRecord[], now: number): UsageSummary {
  const win = (since: number) => {
    let tokens = 0, turns = 0, cost = 0, anyCost = false, guessed = false;
    for (const r of records) {
      if (r.at < since || r.at > now + 60_000) continue;
      turns += 1;
      tokens += Math.max(0, r.inputTokens) + Math.max(0, r.outputTokens);
      if (typeof r.costUsd === 'number' && Number.isFinite(r.costUsd) && r.costUsd >= 0) { cost += r.costUsd; anyCost = true; if (r.costEstimated) guessed = true; } else guessed = true;
    }
    const out: UsageSummary['today'] = { tokens, turns };
    if (anyCost) out.costUsd = Math.round(cost * 1e6) / 1e6;
    return { out, guessed };
  };
  const t = win(startOfDay(now));
  const w = win(startOfWeek(now));
  return { today: t.out, week: w.out, estimated: w.guessed || t.guessed };
}

/* ───────────── Syncer：状态 → 库 的增量 diff ───────────── */

const TASK_SKIP = new Set<'messages'>(['messages']);
const RUN_SKIP = new Set<'toolCalls' | 'terminal' | 'artifacts'>(['toolCalls', 'terminal', 'artifacts']);

/** 浅比较（跳过 skip 里的键）：用 immer 的结构共享，没变的子树引用相同。 */
function shallowChanged(a: object, b: object, skip: Set<string>): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k in x) if (!skip.has(k) && x[k] !== y[k]) return true;
  for (const k in y) if (!skip.has(k) && !(k in x)) return true;
  return false;
}

function without<T extends object, K extends string>(o: T, skip: Set<K>): Omit<T, K> {
  const out: Record<string, unknown> = {};
  for (const k in o) if (!skip.has(k as unknown as K)) out[k] = (o as Record<string, unknown>)[k];
  return out as Omit<T, K>;
}

export interface Diff {
  batch: SaveBatch;
  /** 库确认写入后调用：更新「已存」账本。写入失败就别调，下次 diff 会重送。 */
  commit(): void;
  /** 这一批大致有多少条（调试与测试用）。 */
  size: number;
}

/**
 * 记着「库里已经有的是哪一版」，每次拿当前状态对一遍，只给出变了的。
 * 账本只存对象引用（不复制数据）。消息窗口只是尾部：只有页面见过的 id 才可能被判为「已删除」。
 */
export class Syncer {
  private tasks = new Map<string, Task>();
  private msgs = new Map<string, Map<string, Message>>();
  private runs = new Map<string, Run>();
  private calls = new Map<string, ToolCall>();
  private arts = new Map<string, Artifact>();
  private term = new Map<string, { n: number; lastId?: string }>();
  private events = new Set<string>();
  private order: string[] = [];

  /** 这些实体刚从库里读出来（或刚取回），已经在库里了，不要写回去。 */
  adopt(input: { tasks?: Task[]; runs?: Run[]; events?: RunEvent[]; order?: string[] }) {
    for (const t of input.tasks ?? []) {
      this.tasks.set(t.id, t);
      const m = new Map<string, Message>();
      for (const x of t.messages) m.set(x.id, x);
      this.msgs.set(t.id, m);
    }
    for (const r of input.runs ?? []) this.adoptRun(r);
    for (const e of input.events ?? []) this.events.add(e.id);
    if (input.order) this.order = [...input.order];
  }

  private adoptRun(r: Run) {
    this.runs.set(r.id, r);
    for (const c of r.toolCalls) this.calls.set(c.id, c);
    for (const a of r.artifacts) this.arts.set(a.id, a);
    this.term.set(r.id, { n: r.terminal.length, lastId: r.terminal[r.terminal.length - 1]?.id });
  }

  /** 向上翻页补进来的更早消息：登记为已存（任务本体不变）。 */
  adoptMessages(taskId: string, older: Message[]) {
    let m = this.msgs.get(taskId);
    if (!m) { m = new Map(); this.msgs.set(taskId, m); }
    for (const x of older) m.set(x.id, x);
  }

  /** 运行的重量级部分取回后：只登记取回的那些（页面这段时间自己新增的还没写，不能算已存）。 */
  adoptRunParts(runId: string, parts: { toolCalls: ToolCall[]; artifacts: Artifact[]; terminal: TerminalLine[] }) {
    for (const c of parts.toolCalls) this.calls.set(c.id, c);
    for (const a of parts.artifacts) this.arts.set(a.id, a);
    const t = this.term.get(runId) ?? { n: 0 };
    // 终端行是追加的：取回的在前、页面新增的在后，所以前 n 条就是已存的。
    this.term.set(runId, { n: t.n + parts.terminal.length, lastId: t.n > 0 ? t.lastId : parts.terminal[parts.terminal.length - 1]?.id });
    const run = this.runs.get(runId);
    if (run) this.runs.set(runId, { ...run, toolCalls: [...parts.toolCalls], artifacts: [...parts.artifacts] } as Run);
  }

  forgetAll() {
    this.tasks.clear(); this.msgs.clear(); this.runs.clear(); this.calls.clear(); this.arts.clear(); this.term.clear(); this.events.clear(); this.order = [];
  }

  has(taskId: string) { return this.tasks.has(taskId); }

  diff(s: Pick<AppState, 'tasks' | 'taskOrder' | 'runs' | 'events'>): Diff | undefined {
    const b: SaveBatch = {};
    let size = 0;
    const apply: Array<() => void> = [];

    // 任务与消息
    for (const [id, t] of Object.entries(s.tasks)) {
      const saved = this.tasks.get(id);
      if (saved === t) continue;
      if (!saved || shallowChanged(saved, t, TASK_SKIP)) {
        (b.tasks ??= []).push(without(t, TASK_SKIP));
        size += 1;
      }
      const sm = this.msgs.get(id);
      if (!saved || !sm || saved.messages !== t.messages) {
        const sent = new Map(sm);
        const cur = new Set<string>();
        for (const m of t.messages) {
          cur.add(m.id);
          if (sm?.get(m.id) !== m) { (b.messages ??= []).push({ taskId: id, m }); sent.set(m.id, m); size += 1; }
        }
        if (sm) for (const mid of sm.keys()) if (!cur.has(mid)) { (b.deleteMessages ??= []).push(mid); sent.delete(mid); size += 1; }
        apply.push(() => { this.msgs.set(id, sent); });
      }
      apply.push(() => { this.tasks.set(id, t); });
    }
    const gone: string[] = [];
    for (const id of this.tasks.keys()) if (!(id in s.tasks)) gone.push(id);
    if (gone.length) { b.deleteTasks = gone; size += gone.length; }
    if (this.tasks.size > 0 && Object.keys(s.tasks).length === 0) b.clearEvents = true;

    // 运行、工具调用、产物、终端
    for (const [id, r] of Object.entries(s.runs)) {
      const saved = this.runs.get(id);
      if (saved === r) continue;
      if (!saved || shallowChanged(saved, r, RUN_SKIP)) { (b.runs ??= []).push(without(r, RUN_SKIP)); size += 1; }
      if (!saved || saved.toolCalls !== r.toolCalls) {
        for (const c of r.toolCalls) {
          if (this.calls.get(c.id) === c) continue;
          (b.toolCalls ??= []).push({ ...c, taskId: r.taskId, keepOutput: isLoadedSummary(c) || undefined });
          size += 1;
        }
      }
      if (!saved || saved.artifacts !== r.artifacts) {
        for (const a of r.artifacts) {
          if (this.arts.get(a.id) === a) continue;
          (b.artifacts ??= []).push({ ...a, taskId: r.taskId });
          size += 1;
        }
      }
      const info = this.term.get(id);
      if (!saved || saved.terminal !== r.terminal) {
        const lines = r.terminal;
        const fast = info && lines.length >= info.n && (info.n === 0 || lines[info.n - 1]?.id === info.lastId);
        const fresh = fast ? lines.slice(info.n) : lines;
        if (fresh.length) { (b.terminal ??= []).push(...fresh); size += fresh.length; }
      }
      apply.push(() => { this.adoptRun(r); });
    }
    for (const id of this.runs.keys()) if (!(id in s.runs)) { (b.deleteRuns ??= []).push(id); size += 1; }

    // 事件（只追加）
    const evs = s.events;
    let i = evs.length;
    while (i > 0 && !this.events.has(evs[i - 1].id)) i -= 1;
    if (i < evs.length) { b.events = evs.slice(i); size += evs.length - i; }

    // 任务顺序
    if (this.order.length !== s.taskOrder.length || this.order.some((x, k) => x !== s.taskOrder[k])) {
      b.taskOrder = [...s.taskOrder];
      size += 1;
    }

    if (size === 0 && !b.clearEvents) return undefined;

    const commit = () => {
      for (const f of apply) f();
      for (const id of gone) {
        for (const [rid, r] of this.runs) if (r.taskId === id) {
          this.runs.delete(rid); this.term.delete(rid);
          for (const c of r.toolCalls) this.calls.delete(c.id);
          for (const a of r.artifacts) this.arts.delete(a.id);
        }
        this.tasks.delete(id);
        this.msgs.delete(id);
      }
      for (const id of b.deleteRuns ?? []) {
        const r = this.runs.get(id);
        if (r) { for (const c of r.toolCalls) this.calls.delete(c.id); for (const a of r.artifacts) this.arts.delete(a.id); }
        this.runs.delete(id); this.term.delete(id);
      }
      this.events = new Set(evs.map((e) => e.id));
      this.order = [...s.taskOrder];
    };
    return { batch: b, commit, size };
  }
}
