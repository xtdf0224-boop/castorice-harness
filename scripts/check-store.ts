/* 模块检查（store）：npm run check:store
   无 GUI、无网络、不碰用户数据。覆盖：库的读写与全文检索、迁移（萤火 / 栖枝旧 localStorage）、尾部加载与分页（10,000 条消息、
   30% 的工具调用带 >5 KB 输出）、备份、数据目录、用量汇总（今日/本周、估算标记）、并发写入、状态⇄库的增量 diff，
   以及 persist.ts 在假桥上的端到端流程。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { produce } from 'immer';
import * as sb from '../src/lib/storeBridge';
import type { AppState, Artifact, Message, Run, RunEvent, TerminalLine, Task, ToolCall, UsageRecord } from '../src/lib/types';
import { ensureRunLoaded, ensureTail, flushSave, flushSaveAsync, freezeWrites, loadState, persistMode, saveSoon, TAIL_BIG, TAIL_SMALL, whenReady, __resetForTests } from '../src/state/persist';
import { store } from '../src/state/store';

type Any = any;

let failed = 0;
let checks = 0;
function ok(name: string, cond: boolean, detail = '') {
  checks += 1;
  if (!cond) { failed += 1; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); } else console.log(`  ok  ${name}${detail ? ` — ${detail}` : ''}`);
}
function eq(name: string, got: unknown, want: unknown) {
  const same = JSON.stringify(got) === JSON.stringify(want);
  checks += 1;
  if (!same) { failed += 1; console.error(`  FAIL ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); } else console.log(`  ok  ${name}`);
}
function section(s: string) { console.log(`\n${s}`); }
const ms = (t0: number) => Math.round(performance.now() - t0);

/* ───────────── 加载被测模块（cjs） ───────────── */

const nodeRequire = createRequire(path.join(process.cwd(), 'package.json'));
const dbm: Any = nodeRequire('./electron/store/db.cjs');
const dirsm: Any = nodeRequire('./electron/store/dirs.cjs');
const { AlightDb } = dbm;

const ROOT = fs.mkdtempSync(path.join(process.env.ALIGHT_CHECK_TMP ?? os.tmpdir(), 'alight-check-store-'));
let tmpN = 0;
const tmp = (name = 'd') => { const d = path.join(ROOT, `${name}-${tmpN++}`); fs.mkdirSync(d, { recursive: true }); return d; };
const openDb = (dir = tmp('db')) => new AlightDb(path.join(dir, 'alight.db'));

/* ───────────── 造数据 ───────────── */

const T0 = Date.UTC(2026, 9, 1);
const mkTask = (id: string, over: Partial<Task> = {}): Task => ({ id, title: `任务 ${id}`, goal: `目标 ${id}`, createdAt: T0, updatedAt: T0, agentIds: ['orchestrator'], runIds: [], messages: [], kind: 'work', ...over });
const mkMsg = (id: string, role: Message['role'], at: number, text: string, over: Partial<Message> = {}): Message => ({ id, role, at, text, ...over });
const mkRun = (id: string, taskId: string, status: Run['status'], over: Partial<Run> = {}): Run => ({
  id, taskId, attempt: 1, status, createdAt: T0, startedAt: T0, activeMs: 0, plan: [], planReady: true, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [],
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: 1_000_000, series: [] }, cursor: { phase: 'executing', step: 0 }, ...over,
});
const mkCall = (id: string, runId: string, at: number, output?: string, over: Partial<ToolCall> = {}): ToolCall => ({
  id, runId, stepId: 's1', agentId: 'coder', tool: 'shell', title: `调用 ${id}`, input: { command: `echo ${id}` }, output, status: 'ok', startedAt: at, ...over,
});
const mkArt = (id: string, runId: string): Artifact => ({ id, runId, stepId: 's1', name: `${id}.md`, kind: 'report', content: `# ${id}`, createdAt: T0 });
const mkLine = (id: string, runId: string, at: number): TerminalLine => ({ id, runId, at, stream: 'stdout', text: `line ${id}` });
const mkEvent = (id: string, at: number, runId?: string): RunEvent => ({ id, at, runId, kind: 'run', level: 'info', text: `事件 ${id}` });
const big = (n: number, ch = 'x') => ch.repeat(n);

type Shape = Pick<AppState, 'tasks' | 'taskOrder' | 'runs' | 'events'>;
const empty = (): Shape => ({ tasks: {}, taskOrder: [], runs: {}, events: [] });

/* ═══════════════════════ 1. 切词与查询 ═══════════════════════ */

section('1. 全文检索的切词与查询');
eq('CJK 逐字补空格', dbm.segment('遐蝶abc'), ' 遐  蝶 abc');
eq('两个字的词是相邻短语', dbm.ftsQuery('遐蝶'), '"遐 蝶"');
eq('英文边输边搜（前缀）', dbm.ftsQuery('read file'), '"read"* "file"*');
eq('只有标点：没有可搜内容', dbm.ftsQuery('!! ??'), null);
eq('引号被去掉，不会拼出坏语法', dbm.ftsQuery('a"b'), '"a b"*');
eq('混排：数字字母与汉字分开', dbm.ftsQuery('GPT5遐蝶'), '"GPT5 遐 蝶"');

/* ═══════════════════════ 2. 库：读写与全文检索 ═══════════════════════ */

section('2. 库：读写、检索、删除');
{
  const db = openDb();
  const st = db.status();
  eq('新库是空的', st.counts, { tasks: 0, messages: 0, runs: 0, toolCalls: 0, events: 0, usage: 0 });
  ok('node:sqlite 带 FTS5', db.get("SELECT 1 AS ok FROM pragma_module_list WHERE name = 'fts5'")?.ok === 1);
  ok('WAL 模式', db.get('PRAGMA journal_mode').journal_mode === 'wal');

  const r1 = db.save({
    tasks: [mkTask('t1', { runIds: ['r1'] })],
    runs: [mkRun('r1', 't1', 'completed')],
    messages: [
      { taskId: 't1', m: mkMsg('m1', 'user', T0 + 1, '请帮我整理遐蝶的资料') },
      { taskId: 't1', m: mkMsg('m2', 'agent', T0 + 2, 'Reading readFile and the GPT5 notes', { agentId: 'orchestrator' }) },
      { taskId: 't1', m: mkMsg('m3', 'system', T0 + 3, '系统提示：遐蝶不该被搜到') },
      { taskId: 't1', m: mkMsg('m4', 'agent', T0 + 4, '流式回复中遐蝶', { streaming: true }) },
    ],
    taskOrder: ['t1'],
  });
  eq('保存无跳过', [r1.ok, r1.skipped], [true, 0]);

  const ids = (q: string, opts: Any = {}) => db.search({ q, ...opts }).hits.map((h: Any) => h.messageId);
  eq('两个字的词能搜到（trigram 做不到）', ids('遐蝶'), ['m1']);
  eq('单个汉字也能搜到', ids('蝶'), ['m1']);
  eq('相邻才算：倒过来的词搜不到', ids('蝶遐'), []);
  eq('英文前缀', ids('read'), ['m2']);
  eq('驼峰词整体匹配（不拆）', ids('readFile'), ['m2']);
  eq('混排查询', ids('GPT5'), ['m2']);
  eq('系统消息不进索引', ids('系统提示'), []);
  eq('流式中的消息等它结束才进索引', ids('流式'), []);
  const hit = db.search({ q: '遐蝶' }).hits[0];
  ok('命中给出摘录与位置', hit.snippet.slice(hit.hitStart, hit.hitStart + hit.hitLength) === '遐蝶', JSON.stringify(hit));

  db.save({ messages: [{ taskId: 't1', m: mkMsg('m4', 'agent', T0 + 4, '回复结束：遐蝶在花海', { agentId: 'orchestrator' }) }] });
  eq('流式结束后进索引', ids('花海'), ['m4']);
  db.save({ messages: [{ taskId: 't1', m: mkMsg('m4', 'agent', T0 + 4, '改成别的内容', { agentId: 'orchestrator' }) }] });
  eq('改了正文：旧词消失', ids('花海'), []);
  eq('改了正文：新词出现', ids('别的'), ['m4']);
  eq('按任务过滤', ids('遐蝶', { taskId: 'nope' }), []);

  db.save({ deleteMessages: ['m1'] });
  eq('删除消息：索引同步清掉', ids('遐蝶'), []);
  db.save({ tasks: [mkTask('t2')], messages: [{ taskId: 't2', m: mkMsg('x1', 'user', T0 + 9, '另一个任务里的遐蝶') }] });
  eq('另一个任务的消息可搜', ids('遐蝶'), ['x1']);
  db.save({ deleteTasks: ['t2'] });
  eq('删任务：级联清掉消息与索引', [ids('遐蝶'), db.get('SELECT COUNT(*) AS n FROM msg_fts_docsize').n === db.get('SELECT COUNT(*) AS n FROM messages WHERE fts = 1').n], [[], true]);

  // 单条出错不拖垮整批
  const r2 = db.save({ messages: [{ taskId: 'ghost', m: mkMsg('g1', 'user', T0, 'orphan') }, { taskId: 't1', m: mkMsg('m9', 'user', T0 + 10, '正常的一条') }] });
  eq('任务不存在的消息被跳过，其余照常写入', [r2.skipped, db.get("SELECT COUNT(*) AS n FROM messages WHERE id = 'm9'").n], [1, 1]);
  db.close();
}

/* ═══════════════════════ 3. 状态 ⇄ 库：增量 diff ═══════════════════════ */

section('3. Syncer：状态到库的增量 diff');
{
  const db = openDb();
  const syncer = new sb.Syncer();
  const flush = (s: Shape) => {
    const d = syncer.diff(s);
    if (!d) return undefined;
    const r = db.save(d.batch);
    if (r.skipped) throw new Error(`skipped ${r.skipped}: ${r.errors.join('; ')}`);
    d.commit();
    return d.batch;
  };
  eq('空状态：没有改动', syncer.diff(empty()), undefined);

  const bigOut = big(9000);
  const s1: Shape = produce(empty(), (d) => {
    d.tasks.t1 = mkTask('t1', { runIds: ['r1'], messages: [mkMsg('a', 'user', T0 + 1, '你好'), mkMsg('b', 'agent', T0 + 2, '回复', { streaming: true })] });
    d.tasks.t2 = mkTask('t2', { kind: 'chat' });
    d.taskOrder = ['t2', 't1'];
    d.runs.r1 = mkRun('r1', 't1', 'running', {
      toolCalls: [mkCall('c1', 'r1', T0 + 3, 'short'), mkCall('c2', 'r1', T0 + 4, bigOut)],
      terminal: [mkLine('l1', 'r1', T0 + 3), mkLine('l2', 'r1', T0 + 4)], artifacts: [mkArt('art1', 'r1')],
    });
    d.events = [mkEvent('e1', T0 + 5, 'r1')];
  });
  const b1 = flush(s1)!;
  eq('第一批：2 个任务、3 条消息以内、1 个运行、2 个调用、2 行终端、1 个产物、1 个事件', [b1.tasks?.length, b1.messages?.length, b1.runs?.length, b1.toolCalls?.length, b1.terminal?.length, b1.artifacts?.length, b1.events?.length], [2, 2, 1, 2, 2, 1, 1]);
  eq('提交后再 diff：没有改动', syncer.diff(s1), undefined);
  ok('库里的大输出是摘要 + 全文另存', db.get("SELECT length(output) AS n FROM tool_calls WHERE id = 'c2'").n < 1300 && db.output('c2').output.length === 9000);

  // 只变一条流式消息：只送这一条
  const s2 = produce(s1, (d) => { d.tasks.t1.messages[1].text = '回复更长了一些'; });
  const b2 = flush(s2)!;
  eq('流式消息每次只送变了的那条', [b2.messages?.length, b2.tasks, b2.runs, b2.toolCalls], [1, undefined, undefined, undefined]);

  // 运行时钟 tick：只送运行摘要，不重送工具调用
  const s3 = produce(s2, (d) => { d.runs.r1.activeMs = 1200; });
  const b3 = flush(s3)!;
  eq('运行时钟走动：只送运行本体', [b3.runs?.length, b3.toolCalls, b3.terminal, b3.messages], [1, undefined, undefined, undefined]);

  // 终端追加走快速路径
  const s4 = produce(s3, (d) => { d.runs.r1.terminal.push(mkLine('l3', 'r1', T0 + 6)); d.events.push(mkEvent('e2', T0 + 7, 'r1')); });
  const b4 = flush(s4)!;
  eq('终端追加与事件追加：只送新的', [b4.terminal?.map((l) => l.id), b4.events?.map((e) => e.id)], [['l3'], ['e2']]);

  // 删除：消息被过滤掉（regenerate）、任务被删
  const s5 = produce(s4, (d) => { d.tasks.t1.messages = d.tasks.t1.messages.filter((m) => m.id !== 'b'); });
  const b5 = flush(s5)!;
  eq('消息被移除：送删除', [b5.deleteMessages, b5.messages], [['b'], undefined]);
  const s6 = produce(s5, (d) => { delete d.tasks.t2; d.taskOrder = ['t1']; });
  const b6 = flush(s6)!;
  eq('任务被删：送删除与新顺序', [b6.deleteTasks, b6.taskOrder], [['t2'], ['t1']]);
  eq('库里 t2 没了、t1 还在', [db.get("SELECT COUNT(*) AS n FROM tasks WHERE id = 't2'").n, db.get("SELECT COUNT(*) AS n FROM tasks WHERE id = 't1'").n], [0, 1]);

  // 清空全部任务 → 事件日志一并清
  const s7 = produce(s6, (d) => { d.tasks = {}; d.taskOrder = []; d.runs = {}; d.events = []; });
  const b7 = flush(s7)!;
  eq('清除所有任务记录：任务、运行、事件都清', [b7.deleteTasks, b7.clearEvents], [['t1'], true]);
  eq('库里一个不剩', db.status().counts, { tasks: 0, messages: 0, runs: 0, toolCalls: 0, events: 0, usage: 0 });

  // 失败不丢账：没 commit 就会重送
  const s8 = produce(empty(), (d) => { d.tasks.k = mkTask('k', { messages: [mkMsg('k1', 'user', T0, 'k')] }); d.taskOrder = ['k']; });
  const d8 = syncer.diff(s8)!;
  ok('没确认写入前不记账', !!syncer.diff(s8) && syncer.diff(s8)!.size === d8.size);
  d8.commit();
  eq('确认后不再重送', syncer.diff(s8), undefined);
  db.close();
}

section('3b. 读回来的状态不会被原样写回；摘要不会盖掉全文');
{
  const db = openDb();
  const src = new sb.Syncer();
  const bigOut = big(20000, 'y');
  const s: Shape = produce(empty(), (d) => {
    d.tasks.t1 = mkTask('t1', { runIds: ['r1', 'r2'], messages: [mkMsg('a', 'user', T0 + 1, 'q'), mkMsg('b', 'agent', T0 + 2, 'ans')] });
    d.taskOrder = ['t1'];
    d.runs.r1 = mkRun('r1', 't1', 'completed', { toolCalls: [mkCall('c1', 'r1', T0 + 3, bigOut), mkCall('c2', 'r1', T0 + 4, 'tiny')], terminal: [mkLine('l1', 'r1', T0)], artifacts: [mkArt('a1', 'r1')] });
    d.runs.r2 = mkRun('r2', 't1', 'paused', { attempt: 2, toolCalls: [mkCall('c3', 'r2', T0 + 5, bigOut)] });
    d.events = [mkEvent('e1', T0 + 6)];
  });
  const d0 = src.diff(s)!;
  db.save(d0.batch);
  d0.commit();

  const snap: Any = db.load();
  eq('快照：运行 r1 是摘要（没带调用），r2 是进行中的（带全部调用）', [snap.lean, snap.runs.find((r: Run) => r.id === 'r1').toolCalls.length, snap.runs.find((r: Run) => r.id === 'r2').toolCalls.length], [['r1'], 0, 1]);
  eq('摘要运行的计数（含按 Agent、按工具的分项，统计页对没读进页面的运行用它）', snap.counts.r1, { calls: 2, errors: 0, artifacts: 1, lines: 1, byAgent: { coder: { calls: 2, errors: 0 } }, byTool: { shell: { calls: 2, errors: 0 } } });
  const r2call = snap.runs.find((r: Run) => r.id === 'r2').toolCalls[0] as ToolCall;
  ok('进行中运行里的大输出只是摘要，并登记了全文长度', (r2call.output ?? '').length < 1300 && snap.big.c3 === 20000);

  // 页面这边：用快照建状态
  const syncer = new sb.Syncer();
  syncer.adopt({ tasks: snap.tasks, runs: snap.runs, events: snap.events, order: snap.taskOrder });
  const state: Shape = { tasks: Object.fromEntries(snap.tasks.map((t: Task) => [t.id, t])), taskOrder: snap.taskOrder, runs: Object.fromEntries(snap.runs.map((r: Run) => [r.id, r])), events: snap.events };
  sb.noteBig(r2call ? [r2call] : [], snap.big);
  eq('读回的状态原样不写回', syncer.diff(state), undefined);

  // 取回 r1 的重量级部分，并入状态：仍然不该有写入
  const detail: Any = db.loadRun('r1');
  sb.noteBig(detail.toolCalls, detail.big);
  syncer.adoptRunParts('r1', detail);
  const withDetail = produce(state, (d) => { d.runs.r1.toolCalls = detail.toolCalls; d.runs.r1.artifacts = detail.artifacts; d.runs.r1.terminal = detail.terminal; });
  eq('取回工具调用/产物/终端后：没有写入', syncer.diff(withDetail), undefined);

  // 页面这段时间自己新增了一行终端、改了一个调用的状态（输出仍是摘要）
  const c1 = withDetail.runs.r1.toolCalls.find((c) => c.id === 'c1')!;
  ok('c1 的输出被识别为折叠摘要', sb.outputSize(c1) === 20000);
  const edited = produce(withDetail, (d) => {
    d.runs.r1.toolCalls.find((c) => c.id === 'c1')!.status = 'error';
    d.runs.r1.terminal.push(mkLine('l2', 'r1', T0 + 9));
  });
  const d1 = syncer.diff(edited)!;
  eq('只送改了的调用与新的终端行', [d1.batch.toolCalls?.map((c) => c.id), d1.batch.terminal?.map((l) => l.id)], [['c1'], ['l2']]);
  eq('改了状态的折叠调用带 keepOutput', d1.batch.toolCalls?.[0].keepOutput, true);
  db.save(d1.batch);
  d1.commit();
  ok('库里 c1 的全文还在（没被摘要盖掉），状态已更新', db.output('c1').output.length === 20000 && db.get("SELECT status FROM tool_calls WHERE id = 'c1'").status === 'error');

  // 向上翻页补进来的消息登记为已存
  const older = mkMsg('z', 'user', T0 - 5, 'older');
  syncer.adoptMessages('t1', [older]);
  const olderState = produce(edited, (d) => { d.tasks.t1.messages = [older, ...d.tasks.t1.messages]; });
  eq('补进来的更早消息不会被判成新消息', syncer.diff(olderState)?.batch.messages, undefined);
  db.close();
}

section('3c. 随机操作：状态 → 库 → 读回，逐项对账');
{
  const db = openDb();
  const syncer = new sb.Syncer();
  let rng = 424242;
  const rand = () => { rng = (rng * 1103515245 + 12345) & 0x7fffffff; return rng / 0x7fffffff; };
  const pick = <T,>(a: T[]): T => a[Math.floor(rand() * a.length)];
  let n = 0;
  const nid = (p: string) => `${p}${++n}`;
  let clock = T0;
  const tick = () => (clock += 1 + Math.floor(rand() * 50));
  const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => x !== undefined).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x)])) : v);
  const same = (a: unknown, b: unknown) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  const texts = ['你好', '遐蝶在花海里', 'read the file', '代码 `x` 和 **加粗**', big(300, '字'), big(6000, 'b')];
  const outputs = [undefined, '', 'ok', big(200), big(5100), big(5200, 'é'), big(40_000, 'z')];

  let state: Shape = empty();
  const taskIds = () => Object.keys(state.tasks);
  const runIds = () => Object.keys(state.runs);

  const ops: Array<() => void> = [
    () => { const id = nid('t'); state = produce(state, (d) => { d.tasks[id] = mkTask(id, { kind: rand() < 0.5 ? 'chat' : 'work', createdAt: tick(), updatedAt: clock }); d.taskOrder.unshift(id); }); },
    () => { if (!taskIds().length) return; const t = pick(taskIds()); const id = nid('m'); state = produce(state, (d) => { d.tasks[t].messages.push(mkMsg(id, pick(['user', 'agent', 'system'] as const), tick(), pick(texts), rand() < 0.2 ? { streaming: true } : {})); d.tasks[t].updatedAt = clock; }); },
    () => { const t = taskIds().find((x) => state.tasks[x].messages.length && rand() < 0.5); if (!t) return; state = produce(state, (d) => { const m = pick(d.tasks[t].messages); m.text = pick(texts); m.streaming = false; }); },
    () => { const t = taskIds().find((x) => state.tasks[x].messages.length && rand() < 0.5); if (!t) return; const victim = pick(state.tasks[t].messages).id; state = produce(state, (d) => { d.tasks[t].messages = d.tasks[t].messages.filter((m) => m.id !== victim); }); },
    () => { const t = taskIds().find((x) => state.tasks[x].kind === 'work' && rand() < 0.5); if (!t) return; const id = nid('r'); state = produce(state, (d) => { d.runs[id] = mkRun(id, t, pick(['running', 'completed', 'paused', 'failed'] as const), { createdAt: tick(), attempt: d.tasks[t].runIds.length + 1 }); d.tasks[t].runIds.push(id); }); },
    () => { if (!runIds().length) return; const r = pick(runIds()); const id = nid('c'); state = produce(state, (d) => { d.runs[r].toolCalls.push(mkCall(id, r, tick(), pick(outputs))); }); },
    () => { const r = runIds().find((x) => state.runs[x].toolCalls.length && rand() < 0.5); if (!r) return; state = produce(state, (d) => { const c = pick(d.runs[r].toolCalls); c.status = pick(['ok', 'error', 'cancelled'] as const); c.output = pick(outputs); }); },
    () => { if (!runIds().length) return; const r = pick(runIds()); const id = nid('l'); state = produce(state, (d) => { d.runs[r].terminal.push(mkLine(id, r, tick())); }); },
    () => { if (!runIds().length) return; const r = pick(runIds()); const id = nid('a'); state = produce(state, (d) => { d.runs[r].artifacts.push(mkArt(id, r)); }); },
    () => { if (!runIds().length) return; const r = pick(runIds()); state = produce(state, (d) => { d.runs[r].activeMs += 100; d.runs[r].status = pick(['running', 'completed', 'paused'] as const); }); },
    () => { state = produce(state, (d) => { d.events.push(mkEvent(nid('e'), tick(), runIds().length && rand() < 0.5 ? pick(runIds()) : undefined)); }); },
    () => { if (taskIds().length < 3 || rand() < 0.75) return; const t = pick(taskIds()); state = produce(state, (d) => { for (const r of d.tasks[t].runIds) delete d.runs[r]; delete d.tasks[t]; d.taskOrder = d.taskOrder.filter((x) => x !== t); }); },
  ];

  // 加权：消息、调用多一些，删任务少一些。
  const weights = [2, 7, 3, 2, 2, 4, 3, 3, 1, 2, 2, 1];
  const wheel = weights.flatMap((w, i) => Array<number>(w).fill(i));
  const pickOp = () => ops[pick(wheel)];
  const mismatches: string[] = [];
  const reconcile = (step: number) => {
    const snap: Any = db.load({ tailBig: 5000, tailSmall: 5000, bigTasks: 1000, eventsLimit: 5000 });
    const note = (what: string) => { if (mismatches.length < 6) mismatches.push(`step ${step}: ${what}`); };
    if (!same([...snap.tasks.map((t: Task) => t.id)].sort(), taskIds().sort())) note('任务集合不一致');
    if (!same(snap.taskOrder, state.taskOrder)) note('任务顺序不一致');
    for (const t of snap.tasks as Task[]) {
      const want = state.tasks[t.id];
      if (!want) continue;
      const { messages: gotMsgs, ...gotMeta } = t;
      const { messages: wantMsgs, ...wantMeta } = want;
      if (!same(gotMeta, wantMeta)) note(`任务 ${t.id} 本体`);
      if (!same(gotMsgs, wantMsgs.map((m) => (m.streaming === undefined ? m : m)))) note(`任务 ${t.id} 消息（${gotMsgs.length} vs ${wantMsgs.length}）`);
    }
    for (const rid of runIds()) {
      const want = state.runs[rid];
      const got = (snap.runs as Run[]).find((r) => r.id === rid);
      if (!got) { note(`运行 ${rid} 丢了`); continue; }
      const { toolCalls: _a, terminal: _b, artifacts: _c, ...gm } = got;
      const { toolCalls: wc, terminal: wt, artifacts: wa, ...wm } = want;
      if (!same(gm, wm)) note(`运行 ${rid} 本体`);
      const d: Any = db.loadRun(rid);
      const expectCalls = wc.map((c) => ({ ...c, output: typeof c.output === 'string' && c.output.length > dbm.OUTPUT_INLINE_MAX ? dbm.summarize(c.output) : c.output }));
      if (!same(d.toolCalls, expectCalls)) note(`运行 ${rid} 工具调用（${d.toolCalls.length} vs ${wc.length}）`);
      for (const c of wc) if (typeof c.output === 'string' && c.output.length > dbm.OUTPUT_INLINE_MAX && db.output(c.id).output !== c.output) note(`调用 ${c.id} 的全文`);
      if (!same(d.terminal, wt)) note(`运行 ${rid} 终端`);
      if (!same(d.artifacts, wa)) note(`运行 ${rid} 产物`);
    }
    const dbRuns = new Set((snap.runs as Run[]).map((r) => r.id));
    for (const r of dbRuns) if (!state.runs[r]) note(`库里多出运行 ${r}`);
    const ev = new Set((snap.events as RunEvent[]).map((e) => e.id));
    for (const e of state.events) if (!ev.has(e.id) && !(e.runId && !state.runs[e.runId])) note(`事件 ${e.id} 没进库`);
  };

  let steps = 0;
  for (let i = 0; i < 400; i++) {
    pickOp()();
    steps += 1;
    if (i % 7 === 6) {
      const d = syncer.diff(state);
      if (d) { const r = db.save(d.batch); if (r.skipped) mismatches.push(`step ${i}: 跳过 ${r.skipped}：${r.errors.join('; ')}`); d.commit(); }
      if (i % 49 === 48) reconcile(i);
    }
  }
  const last = syncer.diff(state);
  if (last) { db.save(last.batch); last.commit(); }
  reconcile(steps);
  eq('随机 400 步：每个任务、消息、运行、调用（含大输出全文）、终端、产物、事件都与库一致', mismatches, []);
  const fc = db.status().counts;
  const bigCalls = Object.values(state.runs).flatMap((r) => r.toolCalls).filter((c) => (c.output ?? '').length > dbm.OUTPUT_INLINE_MAX).length;
  ok('随机测试确实覆盖了东西（有任务、消息、运行、折叠的大输出，也删过任务）', fc.tasks >= 3 && fc.messages >= 30 && fc.runs >= 5 && bigCalls >= 3 && n > fc.tasks + fc.messages + fc.toolCalls, JSON.stringify({ ...fc, bigCalls, idsIssued: n }));
  eq('对完账之后再 diff：没有改动', syncer.diff(state), undefined);
  db.close();
}

/* ═══════════════════════ 4. 长会话：分页与内存预算（数据层） ═══════════════════════ */

section('4. 10,000 条消息、30% 带 >5 KB 输出：尾部加载与分页');
{
  const db = openDb();
  const N = 10_000;
  const CALLS = 3_000;
  const t0 = performance.now();
  const task = mkTask('tbig', { runIds: ['rbig'], title: '超长会话', createdAt: T0, updatedAt: T0 + N * 1000 });
  db.save({ tasks: [task], runs: [mkRun('rbig', 'tbig', 'completed')], taskOrder: ['tbig'] });
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < N; i += 500) {
    const messages: Array<{ taskId: string; m: Message }> = [];
    const toolCalls: Array<ToolCall & { taskId: string }> = [];
    for (let k = i; k < Math.min(N, i + 500); k++) {
      messages.push({ taskId: 'tbig', m: mkMsg(`m${k}`, k % 2 === 0 ? 'user' : 'agent', T0 + k * 1000, `第 ${k} 条：${k % 7 === 0 ? '遐蝶' : '普通'}内容 ${big(40, '字')}`, k % 2 ? { agentId: 'orchestrator', runId: 'rbig' } : {}) });
      // 每 10 条消息夹 3 个工具调用，共 3,000 个，输出都在 6–30 KB 之间（>5 KB 折叠）
      if (k % 10 < 3) toolCalls.push({ ...mkCall(`c${k}`, 'rbig', T0 + k * 1000 + 500, big(6_000 + Math.floor(rnd() * 24_000), 'o')), taskId: 'tbig' });
    }
    db.save({ messages, toolCalls });
  }
  const seedMs = ms(t0);
  const counts = db.status().counts;
  eq('灌入 10,000 条消息、3,000 个工具调用', [counts.messages, counts.toolCalls], [N, CALLS]);
  console.log(`  ..  灌入耗时 ${seedMs} ms，库 ${(db.fileBytes() / 1048576).toFixed(0)} MB`);

  // 启动快照
  const tl = performance.now();
  const snap: Any = db.load({ tailBig: 80 });
  const cloneT = performance.now();
  const wire = structuredClone(snap); // 近似 IPC 的拷贝成本
  const loadMs = ms(tl);
  const wireBytes = JSON.stringify(wire).length;
  console.log(`  ..  load ${ms(tl) - ms(cloneT)} ms + 拷贝 ${ms(cloneT)} ms，载荷 ${(wireBytes / 1024).toFixed(0)} KB`);
  const tailTask = wire.tasks.find((t: Task) => t.id === 'tbig');
  eq('只带尾部 80 条', [tailTask.messages.length, tailTask.messages[0].id, tailTask.messages[79].id], [80, `m${N - 80}`, `m${N - 1}`]);
  eq('分页信息', wire.paging.tbig, { total: N, oldestSeq: N - 79, loaded: 80 });
  ok('启动载荷远小于全量（<1 MB）', wireBytes < 1024 * 1024, `${(wireBytes / 1024).toFixed(0)} KB`);
  ok('启动读库 + 拷贝 <1.5 s（预算：首屏 ≤2 s 含渲染）', loadMs < 1500, `${loadMs} ms`);
  eq('运行只有摘要（没读 3,000 个调用）', [wire.runs[0].toolCalls.length, wire.lean], [0, ['rbig']]);
  eq('但数字是全的', wire.counts.rbig.calls, CALLS);

  // 向上翻页：翻完整个会话，不重不漏
  const seen: string[] = [];
  const callSeen = new Set<string>();
  let before = wire.paging.tbig.oldestSeq as number;
  let pages = 0;
  let worst = 0;
  for (;;) {
    const tp = performance.now();
    const p: Any = db.page({ taskId: 'tbig', beforeSeq: before, limit: 200 });
    worst = Math.max(worst, performance.now() - tp);
    pages += 1;
    seen.unshift(...p.messages.map((m: Message) => m.id));
    for (const c of p.calls as ToolCall[]) callSeen.add(c.id);
    if (!p.more) break;
    before = p.oldestSeq;
  }
  eq('翻页翻完：尾部之前的 9,920 条一条不少', [seen.length, seen[0], seen[seen.length - 1], new Set(seen).size], [N - 80, 'm0', `m${N - 81}`, N - 80]);
  ok('每页（200 条 + 夹在其间的调用）<150 ms', worst < 150, `最慢 ${Math.round(worst)} ms，共 ${pages} 页`);
  const tailCalls = (db.callsInRange('tbig', tailTask.messages[0].at, Number.MAX_SAFE_INTEGER, 5000) as Any).calls as ToolCall[];
  for (const c of tailCalls) callSeen.add(c.id);
  eq('尾部区间 + 各页带回的调用合起来正好 3,000 个', callSeen.size, CALLS);
  const one = (db.page({ taskId: 'tbig', beforeSeq: N, limit: 500 }) as Any).calls[0] as ToolCall;
  ok('翻页带回的调用只有摘要（≤1.3 KB）', (one.output ?? '').length < 1300);
  ok('按需取全文能取回', db.output(one.id).output.length > 5000);

  // 点开这个任务：取回运行（3,000 个调用，输出都是摘要）
  const tr = performance.now();
  const detail: Any = db.loadRun('rbig');
  const dWire = JSON.stringify(structuredClone(detail)).length;
  console.log(`  ..  取回含 3,000 个调用的运行 ${ms(tr)} ms，载荷 ${(dWire / 1048576).toFixed(1)} MB`);
  eq('3,000 个调用都在，全是折叠摘要', [detail.toolCalls.length, Object.keys(detail.big).length], [CALLS, CALLS]);
  ok('取回运行的载荷 <8 MB（原始输出约 45 MB）', dWire < 8 * 1048576, `${(dWire / 1048576).toFixed(1)} MB`);

  // 全文检索在 10,000 条上
  const ts = performance.now();
  const found = db.search({ q: '遐蝶', limit: 30 });
  ok('在 10,000 条里搜两个字的词 <200 ms', ms(ts) < 200 && found.hits.length === 30, `${ms(ts)} ms`);
  db.close();
}

/* ═══════════════════════ 5. 备份 ═══════════════════════ */

section('5. 备份（VACUUM INTO）');
{
  const dir = tmp('bk');
  const db = openDb(dir);
  db.save({ tasks: [mkTask('t1', { runIds: ['r1'] })], runs: [mkRun('r1', 't1', 'completed', { toolCalls: [] })], messages: [{ taskId: 't1', m: mkMsg('m1', 'user', T0, '备份里要有遐蝶') }], toolCalls: [{ ...mkCall('c1', 'r1', T0, big(8000)), taskId: 't1' }] });
  const dest = path.join(dir, 'backups', dirsm.backupName(Date.UTC(2026, 9, 24, 7, 30, 0)));
  const info = db.backup(dest);
  eq('备份文件名带本地时间', path.basename(dest).startsWith('alight-2026'), true);
  ok('备份落盘且通过自检', fs.existsSync(dest) && info.bytes > 0 && info.tasks === 1, JSON.stringify({ bytes: info.bytes, ms: info.ms }));
  const copy = new AlightDb(dest);
  eq('备份能独立打开：任务、全文检索、大输出都在', [copy.status().counts.tasks, copy.search({ q: '遐蝶' }).hits.length, copy.output('c1').output.length], [1, 1, 8000]);
  copy.close();
  let refused = '';
  try { db.backup(dest); } catch (e) { refused = (e as Error).message; }
  ok('不覆盖已存在的备份', refused.includes('已存在'), refused);
  eq('备份目录列表', dirsm.listBackups(path.join(dir, 'backups')).map((b: Any) => b.name), [path.basename(dest)]);
  const c = db.compact();
  ok('整理（VACUUM）能跑', c.after > 0);
  // 备份中途失败（目标盘写满 / 拔出）：SQLite 不会替我们删 INTO 的输出。半截文件必须清掉，否则下一次撞上 exists、被当成现成的库
  const failDest = path.join(dir, 'backups', 'alight-failing.db');
  const realRun = db.run.bind(db);
  (db as Any).run = (sql: string, ...args: unknown[]) => {
    if (/^VACUUM INTO/i.test(sql)) { fs.writeFileSync(String(args[0]), Buffer.alloc(0)); throw new Error('disk full（模拟）'); }
    return realRun(sql, ...args);
  };
  let failMsg = '';
  try { db.backup(failDest); } catch (e) { failMsg = (e as Error).message; }
  (db as Any).run = realRun;
  ok('VACUUM INTO 中途失败：抛错，并且清掉了留下的 0 字节文件', failMsg.includes('disk full') && !fs.existsSync(failDest), failMsg);
  eq('失败的备份不会出现在备份列表里', dirsm.listBackups(path.join(dir, 'backups')).map((b: Any) => b.name).includes('alight-failing.db'), false);
  const retry = db.backup(failDest);
  ok('清掉之后再试一次能成功（不再撞上 exists）', retry.tasks === 1 && fs.existsSync(failDest));
  db.close();
  // 打不开的库：构造函数失败时不留文件句柄（Windows 上留着会让手动删掉坏文件也删不掉）
  const junk = path.join(dir, 'junk.db');
  fs.writeFileSync(junk, 'this is not a database, just some text'.repeat(40));
  let junkErr = '';
  try { new AlightDb(junk); } catch (e) { junkErr = (e as Error).message; }
  ok('不是数据库的文件：打开时抛错', junkErr.length > 0, junkErr);
  let removed = true;
  try { fs.rmSync(junk, { force: false }); } catch { removed = false; }
  ok('抛错之后文件句柄已释放，坏文件能直接删掉', removed && !fs.existsSync(junk));
}

/* ═══════════════════════ 6. 用量 ═══════════════════════ */

section('6. 用量汇总（今日 / 本周 / 估算标记）');
{
  const db = openDb();
  const now = new Date(2026, 9, 21, 15, 0, 0).getTime(); // 周三 15:00 本地
  const L = (y: number, mo: number, d: number, h: number, mi = 0, s = 0) => new Date(y, mo, d, h, mi, s).getTime();
  eq('本周从周一 00:00 起（周日 → 上个周一）', new Date(sb.startOfWeek(L(2026, 9, 18, 23, 59))).getDate(), 12);
  eq('周三 → 本周一', new Date(sb.startOfWeek(now)).getDate(), 19);
  eq('与主进程用同一口径', [sb.startOfWeek(now), sb.startOfDay(now)], [dbm.startOfWeek(now), dbm.startOfDay(now)]);

  const recs: UsageRecord[] = [
    { at: L(2026, 9, 21, 10), taskId: 't', runId: 'r1', provider: 'claude', inputTokens: 1000, outputTokens: 200, cachedTokens: 9000, costUsd: 0.1 },
    { at: L(2026, 9, 21, 9), taskId: 't', runId: 'r2', provider: 'gpt', inputTokens: 500, outputTokens: 100, cachedTokens: 0 },
    { at: L(2026, 9, 20, 12), taskId: 't', provider: 'claude', inputTokens: 300, outputTokens: 50, cachedTokens: 0, costUsd: 0.2, costEstimated: true },
    { at: L(2026, 9, 19, 0, 0, 1), taskId: 't', provider: 'claude', inputTokens: 100, outputTokens: 10, cachedTokens: 0, costUsd: 0.3 },
    { at: L(2026, 9, 18, 23, 59), taskId: 't', provider: 'claude', inputTokens: 7000, outputTokens: 700, cachedTokens: 0, costUsd: 1.0 },
  ];
  for (const r of recs) eq(`记一条 ${new Date(r.at).toLocaleString('zh-CN')}`, db.usageAdd(r), { recorded: true });
  eq('同一回合重复上报只记一次', db.usageAdd(recs[0]), { recorded: false });
  const sum = db.usageSummary(now);
  eq('今日：2 回合、tokens=输入+输出（缓存不算）、只加有数字的成本', sum.today, { tokens: 1800, turns: 2, costUsd: 0.1 });
  eq('本周（周一起）：4 回合，成本只加有数字的，周日那条不算', sum.week, { tokens: 2260, turns: 4, costUsd: 0.6 });
  eq('窗口里有未知或估算的成本 → 估算', sum.estimated, true);
  eq('纯函数汇总与库一致', sb.summarizeUsage(recs, now), sum);
  eq('全是引擎报的实数：不标估算', db.usageSummary(L(2026, 9, 19, 12)).estimated, false);
  eq('没有任何成本数字：costUsd 缺省', (() => { const d2 = openDb(); d2.usageAdd({ at: now, taskId: 'x', provider: 'gpt', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }); const s = d2.usageSummary(now); d2.close(); return s.today.costUsd; })(), undefined);

  db.setUsageEnabled(false);
  eq('关着开关：不记', db.usageAdd({ at: now, taskId: 't', provider: 'claude', inputTokens: 5, outputTokens: 5, cachedTokens: 0 }), { recorded: false });
  eq('只存数字：库里没有任何内容列', db.all("SELECT name FROM pragma_table_info('usage')").map((c: Any) => c.name).sort(), ['at', 'cached_tokens', 'cost_estimated', 'cost_usd', 'dedupe', 'duration_ms', 'input_tokens', 'model', 'output_tokens', 'provider', 'run_id', 'seq', 'task_id']);
  db.setUsageEnabled(true);
  eq('清除用量记录', db.usageClear(), { removed: 5 });
  eq('清完是零', db.usageSummary(now).week, { tokens: 0, turns: 0 });
  db.close();
}

/* ═══════════════════════ 7. 并发写入 ═══════════════════════ */

section('7. 并发写入（两个连接，一个在 Worker 线程里）');
{
  const dir = tmp('conc');
  const file = path.join(dir, 'alight.db');
  const a = new AlightDb(file);
  a.save({ tasks: [mkTask('ta'), mkTask('tb')] });
  const modPath = path.join(process.cwd(), 'electron', 'store', 'db.cjs').replace(/\\/g, '/');
  const code = `
    const { parentPort, workerData } = require('node:worker_threads');
    const { AlightDb } = require(workerData.mod);
    const db = new AlightDb(workerData.file);
    for (let i = 0; i < workerData.n; i += 50) {
      const messages = [];
      for (let k = i; k < i + 50; k++) messages.push({ taskId: 'tb', m: { id: 'w' + k, role: 'user', at: k, text: '来自工作线程的第 ' + k + ' 条' } });
      db.save({ messages });
    }
    db.close();
    parentPort.postMessage('done');
  `;
  const worker = new Worker(code, { eval: true, workerData: { mod: modPath, file, n: 1500 } });
  const finished = new Promise<void>((res, rej) => { worker.on('message', () => res()); worker.on('error', rej); });
  let mainSkipped = 0;
  for (let i = 0; i < 1500; i += 50) {
    const messages: Array<{ taskId: string; m: Message }> = [];
    for (let k = i; k < i + 50; k++) messages.push({ taskId: 'ta', m: mkMsg(`p${k}`, 'user', k, `来自主线程的第 ${k} 条`) });
    mainSkipped += a.save({ messages }).skipped;
    if (i % 300 === 0) a.search({ q: '工作线程' }); // 写的同时读
    await new Promise((r) => setImmediate(r));
  }
  await finished;
  const n = (t: string) => a.get(`SELECT COUNT(*) AS n FROM messages WHERE task_id = '${t}'`).n;
  eq('两边各写 1,500 条，一条不少、没有「database is locked」', [n('ta'), n('tb'), mainSkipped], [1500, 1500, 0]);
  eq('库完整（quick_check）', a.get('PRAGMA quick_check').quick_check, 'ok');
  eq('两边的消息都进了全文索引', [a.search({ q: '主线程', limit: 1 }).hits.length, a.search({ q: '工作线程', limit: 1 }).hits.length], [1, 1]);
  a.close();
}

/* ═══════════════════════ 8. 数据目录 ═══════════════════════ */

section('8. 数据目录：解析、退回、搬家、空间');
{
  const ud = tmp('userdata');
  eq('默认用 userData', dirsm.resolveDataDir({ userData: ud, env: {} }), { dir: ud, source: 'default' });
  const target = tmp('elsewhere');
  dirsm.writeConfig(ud, { dataDir: target });
  eq('设置里的目录优先', dirsm.resolveDataDir({ userData: ud, env: {} }), { dir: path.resolve(target), source: 'config' });
  const envDir = tmp('envdir');
  eq('环境变量 ALIGHT_DATA_DIR 最优先', dirsm.resolveDataDir({ userData: ud, env: { ALIGHT_DATA_DIR: envDir } }).source, 'env');
  const blocker = path.join(tmp('blk'), 'file.txt');
  fs.writeFileSync(blocker, 'x');
  dirsm.writeConfig(ud, { dataDir: path.join(blocker, 'sub') });
  const fb = dirsm.resolveDataDir({ userData: ud, env: {} });
  ok('配置的目录用不了：退回默认并说明数据没丢', fb.dir === ud && fb.source === 'default' && /没有丢/.test(fb.warning), fb.warning);
  const rep = dirsm.report(ud);
  ok('空间报告有数字', typeof rep.freeBytes === 'number' && rep.thresholdBytes === 15 * 1024 ** 3 && typeof rep.low === 'boolean', `${root(rep.root)} 剩 ${((rep.freeBytes ?? 0) / 1024 ** 3).toFixed(0)} GB`);
  ok('阈值是 15 GB', dirsm.LOW_SPACE_BYTES === 15 * 1024 ** 3);
  ok('建议的盘不含当前盘、都够大', dirsm.suggestions(rep.root).every((s: Any) => s.root.toLowerCase() !== String(rep.root).toLowerCase() && s.freeBytes >= dirsm.LOW_SPACE_BYTES));

  const db = openDb(ud);
  db.save({ tasks: [mkTask('t1')], messages: [{ taskId: 't1', m: mkMsg('m1', 'user', T0, '搬家前的消息') }] });
  const dest = tmp('moved');
  const moved = dirsm.moveData({ db, userData: ud, target: dest });
  ok('搬家 = 复制 + 自检 + 写配置；旧库原样留着', moved.copied.tasks === 1 && fs.existsSync(path.join(dest, 'alight.db')) && fs.existsSync(path.join(ud, 'alight.db')) && dirsm.readConfig(ud).dataDir === path.resolve(dest));
  let err = '';
  try { dirsm.moveData({ db, userData: ud, target: dest }); } catch (e) { err = (e as Any).code; }
  eq('目标里已有 alight.db：默认拒绝（不覆盖、不合并）', err, 'exists');
  const again = dirsm.moveData({ db, userData: ud, target: dest, useExisting: true });
  eq('确认后改用已有的那个', [again.dir, again.copied], [path.resolve(dest), null]);
  const back = dirsm.moveData({ db, userData: ud, target: ud, useExisting: true });
  eq('搬回默认位置：配置里不再记目录', [back.dir, dirsm.readConfig(ud).dataDir], [path.resolve(ud), undefined]);

  // 「改用目标里现成的库」要先校验：打不开的库写进配置之后，此后每次 open() 都抛错，界面里的「更改位置」自己也进不去
  const cfgBefore = JSON.stringify(dirsm.readConfig(ud));
  const reject = (label: string, dirName: string, make: (file: string) => void, pattern: RegExp) => {
    const d = tmp(dirName);
    make(path.join(d, 'alight.db'));
    let code = ''; let message = '';
    try { dirsm.moveData({ db, userData: ud, target: d, useExisting: true }); } catch (e) { code = (e as Any).code; message = (e as Error).message; }
    ok(`改用现成的库：${label} → 拒绝（invalid-db）`, code === 'invalid-db' && pattern.test(message), `${code} ${message}`);
    eq(`  ${label}：配置没有被改动`, JSON.stringify(dirsm.readConfig(ud)), cfgBefore);
  };
  reject('0 字节文件（上一次备份中途失败留下的）', 'inv-empty', (file) => fs.writeFileSync(file, ''), /空的|不是栖枝/);
  reject('不是数据库的文件', 'inv-junk', (file) => fs.writeFileSync(file, 'garbage '.repeat(500)), /不能用/);
  reject('更新版本的栖枝写出来的库（user_version 比程序新）', 'inv-newer', (file) => {
    const x = new AlightDb(file); x.close();
    const { DatabaseSync } = nodeRequire('node:sqlite'); const raw = new DatabaseSync(file); raw.exec('PRAGMA user_version = 99'); raw.close();
  }, /更新版本/);
  reject('别的程序的 SQLite 库（没有 tasks 表）', 'inv-foreign', (file) => {
    const { DatabaseSync } = nodeRequire('node:sqlite'); const raw = new DatabaseSync(file); raw.exec('CREATE TABLE other(a); PRAGMA user_version = 1'); raw.close();
  }, /不能用/);
  // 默认（不确认）时遇到坏库也直接说它不能用，不再问「要改用它吗」
  const badAsk = tmp('inv-ask');
  fs.writeFileSync(path.join(badAsk, 'alight.db'), '');
  let askCode = '';
  try { dirsm.moveData({ db, userData: ud, target: badAsk }); } catch (e) { askCode = (e as Any).code; }
  eq('目标里的库不能用：不问「要改用它吗」，直接 invalid-db', askCode, 'invalid-db');
  // 当前库打不开：没有 db 也没有 getDb 能打开它时，改用现成的好库、或搬回默认位置仍然可以
  const good = tmp('inv-good');
  const goodDb = new AlightDb(path.join(good, 'alight.db')); goodDb.save({ tasks: [mkTask('tg')] }); goodDb.close();
  let opened = 0;
  const brokenCurrent = () => { opened += 1; throw new Error('当前库打不开（模拟）'); };
  const useGood = dirsm.moveData({ getDb: brokenCurrent, userData: ud, target: good, useExisting: true });
  eq('当前库打不开：改用另一个现成的好库照样能切（没去打开当前库）', [useGood.dir, opened], [path.resolve(good), 0]);
  let copyErr = '';
  try { dirsm.moveData({ getDb: brokenCurrent, userData: ud, target: tmp('inv-copy') }); } catch (e) { copyErr = (e as Error).message; }
  ok('需要复制而当前库打不开：报当前库的错，不写配置', copyErr.includes('打不开') && opened === 1, copyErr);
  db.close();
}
function root(r: string) { return r || '?'; }

/* ═══════════════════════ 9. 通道层（index.cjs，假 electron） ═══════════════════════ */

section('9. 通道层：store:* / usage:* 经 register(handle)');
const handlers = new Map<string, (e: Any, ...a: Any[]) => Any>();
let userDataDir = tmp('chan-userdata');
/** 假「选择文件夹」对话框这一次返回的路径（null ＝ 取消）. */
let nextPick: string | null = null;
{
  const Module: Any = nodeRequire('node:module');
  const orig = Module._load;
  const fakeElectron = {
    app: { getPath: () => userDataDir },
    dialog: { showOpenDialog: async () => (nextPick ? { canceled: false, filePaths: [nextPick] } : { canceled: true, filePaths: [] }) },
    shell: { openPath: async () => '' },
    BrowserWindow: { fromWebContents: () => null },
  };
  Module._load = function patched(request: string, ...rest: unknown[]) { return request === 'electron' ? fakeElectron : orig.call(this, request, ...rest); };
  const indexMod: Any = nodeRequire('./electron/store/index.cjs');
  indexMod.register((channel: string, fn: Any) => { handlers.set(channel, fn); });
  Module._load = orig;
  (globalThis as Any).__storeIndex = indexMod;
}
const rawCall = (channel: string, ...args: unknown[]): Promise<Any> => {
  const h = handlers.get(channel);
  if (!h) return Promise.reject(new Error(`no handler ${channel}`));
  return Promise.resolve(h({ senderFrame: { url: 'app' }, sender: {} }, ...args));
};
{
  const expected = ['store:user-messages', 'store:status', 'store:load', 'store:save', 'store:page', 'store:calls', 'store:run', 'store:output', 'store:search', 'store:events', 'store:import', 'store:backup', 'store:backups', 'store:set-dir', 'store:disk', 'store:compact', 'usage:add', 'usage:summary', 'usage:enabled', 'usage:clear', 'usage:list'];
  eq('通道都登记了', expected.filter((c) => !handlers.has(c)), []);
  eq('通道名都符合预加载白名单', [...handlers.keys()].filter((c) => !/^(store|trust|usage|git|probe):[\w:.-]{1,60}$/.test(c)), []);

  const st = await rawCall('store:status');
  ok('status：数据库在 userData 里', st.ok && st.dataDir === userDataDir && st.source === 'default' && st.disk.root, `${st.sqlite}`);
  const bad = await rawCall('store:save', 'not-an-object');
  ok('参数不对：返回 { ok: false } 而不是抛异常', bad.ok === false && typeof bad.error === 'string', bad.error);
  const sv = await rawCall('store:save', { tasks: [mkTask('c1')], messages: [{ taskId: 'c1', m: mkMsg('cm1', 'user', T0, '通道里的消息') }] });
  eq('保存', [sv.ok, sv.skipped], [true, 0]);
  eq('检索', (await rawCall('store:search', { q: '通道' })).hits.map((h: Any) => h.messageId), ['cm1']);
  // 页面只常驻尾部窗口：计划 / 执行的提示词要的「全部补充说明」从这里取（只要使用者发的、老的在前）
  const um0 = await rawCall('store:user-messages', { taskId: 'c1' });
  eq('user-messages：只有使用者发的消息', [um0.ok, um0.messages.map((m: Any) => m.id)], [true, ['cm1']]);
  await rawCall('store:save', { messages: [
    { taskId: 'c1', m: mkMsg('um-b', 'agent', T0 + 1, '助手的回复') }, { taskId: 'c1', m: mkMsg('um-c', 'user', T0 + 2, '第二条补充') },
    { taskId: 'c1', m: mkMsg('um-d', 'system', T0 + 3, '系统消息') }, { taskId: 'c1', m: mkMsg('um-e', 'user', T0 + 4, '第三条补充') },
  ] });
  eq('user-messages：role=user 的，老的在前（助手 / 系统消息不算）', (await rawCall('store:user-messages', { taskId: 'c1' })).messages.map((m: Any) => m.id), ['cm1', 'um-c', 'um-e']);
  eq('user-messages：limit 取最近的几条（仍是老的在前）', (await rawCall('store:user-messages', { taskId: 'c1', limit: 2 })).messages.map((m: Any) => m.id), ['um-c', 'um-e']);
  eq('user-messages：别的任务的不混进来；参数不对返回 ok:false', [(await rawCall('store:user-messages', { taskId: 'no-such-task' })).messages, (await rawCall('store:user-messages', 'oops')).ok], [[], false]);
  eq('键名不合法被拒', (await rawCall('store:kv-set', '../evil', 'x')).ok, false);

  const bk = await rawCall('store:backup');
  ok('备份落在 <dataDir>/backups', bk.ok && bk.path.startsWith(path.join(userDataDir, 'backups')) && bk.tasks === 1, bk.path);
  eq('备份列表', (await rawCall('store:backups')).items.length, 1);

  const target = tmp('chan-moved');
  // 页面编出来的路径（没在选择框里选过）不能当数据目录或备份目录：被带偏的页面不能让数据库落到网络共享之类的地方
  const rogue = tmp('chan-rogue');
  const rogueMove = await rawCall('store:set-dir', { dir: rogue });
  ok('set-dir：没在选择框里选过的绝对路径被拒', rogueMove.ok === false && /选择框/.test(rogueMove.error) && !fs.existsSync(path.join(rogue, 'alight.db')), rogueMove.error);
  const rogueBackup = await rawCall('store:backup', { dir: rogue });
  ok('backup：没选过的目录被拒', rogueBackup.ok === false && !fs.existsSync(rogue + '/backups') && fs.readdirSync(rogue).length === 0, rogueBackup.error);
  nextPick = null;
  eq('取消选择框不批准任何目录', (await rawCall('store:pick-dir')).dir, null);
  eq('取消之后仍被拒', (await rawCall('store:set-dir', { dir: target })).ok, false);
  nextPick = target;
  eq('选择框选定的目录原样返回', (await rawCall('store:pick-dir')).dir, target);
  nextPick = null;
  const mv = await rawCall('store:set-dir', { dir: target });
  ok('换数据目录：复制过去、旧库留着', mv.ok && mv.copied.tasks === 1 && fs.existsSync(path.join(userDataDir, 'alight.db')), mv.error);
  const st2 = await rawCall('store:status');
  ok('之后读的是新位置', st2.dataDir === path.resolve(target) && st2.counts.tasks === 1 && st2.source === 'config', st2.dataDir);
  eq('新位置的数据可搜', (await rawCall('store:search', { q: '通道' })).hits.length, 1);
  const noDir = await rawCall('store:set-dir', { dir: 'relative/path' });
  eq('相对路径被拒', [noDir.ok, noDir.code], [false, 'bad-path']);
  const picked = tmp('chan-picked-backups');
  nextPick = picked;
  await rawCall('store:pick-dir');
  nextPick = null;
  const bk2 = await rawCall('store:backup', { dir: picked });
  ok('备份到选择框选定的目录（也含其子目录）', bk2.ok && bk2.path.startsWith(picked), bk2.error);
  // 回到默认位置，让后面的端到端测试用干净的目录
  await rawCall('store:set-dir', { dir: userDataDir, useExisting: true });

  const u = await rawCall('usage:add', { at: Date.now(), taskId: 'c1', provider: 'claude', inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0.5, 内容: '不该被存', prompt: 'secret' });
  eq('用量：记下', u.recorded, true);
  const us = await rawCall('usage:summary');
  eq('用量：汇总', [us.summary.today.turns, us.summary.today.costUsd, us.enabled], [1, 0.5, true]);
  const row = (await rawCall('usage:list', 1)).items[0];
  ok('用量：行里只有数字与 id，没有多余字段', row.taskId === 'c1' && !('prompt' in row) && !('内容' in row));
  await rawCall('usage:clear');
}

/* ═══════════════════════ 10. 浏览器开发版（没有桥）退回 localStorage ═══════════════════════ */

section('10. 没有桥：用量退回 localStorage');
{
  const mem = new Map<string, string>();
  (globalThis as Any).localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  eq('没有桥', sb.storeAvailable(), false);
  let changes = 0;
  const off = sb.onUsageChange(() => { changes += 1; });
  const now = Date.now();
  eq('记一条', await sb.recordUsage({ at: now, taskId: 't', provider: 'claude', inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0.25 }), true);
  eq('重复不记', await sb.recordUsage({ at: now, taskId: 't', provider: 'claude', inputTokens: 10, outputTokens: 5, cachedTokens: 0, costUsd: 0.25 }), false);
  eq('汇总', (await sb.usageSummary(now))?.today, { tokens: 15, turns: 1, costUsd: 0.25 });
  await sb.setUsageEnabled(false);
  eq('关开关后不记', await sb.recordUsage({ at: now + 1, taskId: 't', provider: 'claude', inputTokens: 1, outputTokens: 1, cachedTokens: 0 }), false);
  eq('变化通知触发过', changes >= 2, true);
  off();
  eq('大输出登记簿：不认识的调用没有折叠', sb.outputSize({ id: 'nope', output: 'x' }), undefined);
  eq('没有桥时翻页等读操作安全失败', (await sb.pageMessages({ taskId: 't', beforeSeq: 5 })).ok, false);
  mem.clear();
}

/* ═══════════════════════ 11. persist.ts 端到端（假桥 + 真库） ═══════════════════════ */

section('11. persist.ts 端到端：萤火旧数据迁移、尾部加载、补读、增量保存');
{
  // 页面环境
  const mem = new Map<string, string>();
  const g = globalThis as Any;
  g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  g.window = g;
  g.addEventListener = () => {};
  g.document = { visibilityState: 'visible', addEventListener: () => {} };
  const saved: Any[] = [];
  g.alightDesktop = {
    onEvent: () => () => {},
    call: async (channel: string, ...args: unknown[]) => {
      const r = await rawCall(channel, ...structuredClone(args));
      if (channel === 'store:save' && r.ok) saved.push(args[0]);
      return structuredClone(r);
    },
  };
  ok('有桥', sb.storeAvailable());

  (globalThis as Any).__storeIndex.close();
  userDataDir = tmp('e2e-userdata');
  // 旧数据：萤火 v2.0.0 的 localStorage（视觉模式 firefly / sam；一个进行中的运行）
  const now = Date.now();
  const oldBig = big(30_000, 'q');
  const legacyBlob = {
    version: 1, rev: 2,
    tasks: {
      tOld: mkTask('tOld', { title: '萤火时代的任务', runIds: ['rOld'], updatedAt: now - 1000, messages: [mkMsg('o1', 'user', now - 5000, '旧消息里有遐蝶'), mkMsg('o2', 'agent', now - 4000, '旧回复', { persona: 'firefly' as Any, streaming: true }), mkMsg('o3', 'agent', now - 3000, '萨姆说', { persona: 'sam' as Any })] }),
      tChat: mkTask('tChat', { kind: 'chat', title: '闲聊', updatedAt: now - 9000, messages: [mkMsg('c1', 'user', now - 9000, 'hi')] }),
    },
    taskOrder: ['tChat', 'tOld'],
    runs: { rOld: mkRun('rOld', 'tOld', 'running', { startedAt: now - 4000, toolCalls: [mkCall('oc1', 'rOld', now - 3500, oldBig, { status: 'running' })], approvals: [] }) },
    events: [mkEvent('oe1', now - 3000, 'rOld')],
  };
  (legacyBlob.runs.rOld as Any).source = 'live';
  mem.set('firefly-harness/v1', JSON.stringify(legacyBlob));
  mem.set('firefly-harness/prefs', JSON.stringify({ settingsRev: 2, settings: { mode: 'sam', callName: '小明' }, navCollapsed: true }));

  const initial = loadState(now);
  eq('同步部分：偏好立刻可用，视觉模式 sam → day', [initial.settings.mode, initial.settings.callName, initial.navCollapsed], ['day', '小明', true]);
  eq('桌面版启动时不把任务整份读进来', Object.keys(initial.tasks), []);
  store.init(initial, saveSoon);
  eq('读库期间的模式', persistMode(), { mode: 'desktop', ready: false });
  await whenReady();
  eq('读完库', persistMode(), { mode: 'desktop', ready: true });

  let s = store.get();
  eq('旧任务迁进来了，顺序保持', [Object.keys(s.tasks).sort(), s.taskOrder], [['tChat', 'tOld'], ['tChat', 'tOld']]);
  eq('persona firefly/sam → night/day，半截的流式气泡收尾', s.tasks.tOld.messages.map((m) => [m.id, m.persona, !!m.streaming]), [['o1', undefined, false], ['o2', 'night', false], ['o3', 'day', false]]);
  ok('进行中的运行被暂停而不是接着跑', s.runs.rOld.status === 'paused' && s.runs.rOld.pauseReason === 'reload' && s.runs.rOld.toolCalls[0].status === 'cancelled');
  ok('进行中运行里的 30 KB 输出只是摘要', (s.runs.rOld.toolCalls[0].output ?? '').length < 1300 && sb.outputSize(s.runs.rOld.toolCalls[0]) === 30_000);
  ok('旧 localStorage 键原样保留，并打了迁移标记', mem.has('firefly-harness/v1') && mem.has('alight/migrated-to-db') && JSON.parse(mem.get('alight/migrated-to-db')!).from === 'firefly-harness/v1');
  const st = await rawCall('store:status');
  eq('库里有 2 个任务、4 条消息', [st.counts.tasks, st.counts.messages, st.legacy?.from], [2, 4, 'firefly-harness/v1']);
  await new Promise((r) => setTimeout(r, 100));
  ok('用量同步已启动（AppState.usage 有值）', !!store.get().usage && store.get().usage!.today.turns === 0, JSON.stringify(store.get().usage));

  // 读后整理（暂停运行）被保存下来
  saved.length = 0;
  await flushSaveAsync();
  const sentRuns = saved.flatMap((b) => (b.runs ?? []).map((r: Run) => `${r.id}:${r.status}`));
  const sentMsgs = saved.flatMap((b) => (b.messages ?? []).map((x: Any) => x.m.id));
  const sentCalls = saved.flatMap((b) => b.toolCalls ?? []) as Any[];
  eq('整理后的状态写回库，且只写变了的（运行暂停、半截气泡收尾、调用取消）', [sentRuns, sentMsgs, saved.flatMap((b) => b.tasks ?? []).length], [['rOld:paused'], ['o2'], 0]);
  eq('被取消的折叠调用带 keepOutput，库里的 30 KB 全文不被摘要盖掉', [sentCalls.map((c) => [c.id, c.status, c.keepOutput]), (await rawCall('store:output', 'oc1')).output.length], [[['oc1', 'cancelled', true]], 30_000]);
  const reload1: Any = await rawCall('store:load');
  eq('库里的运行状态已是 paused', reload1.runs.find((r: Run) => r.id === 'rOld').status, 'paused');

  // 加一批任务，让一部分任务只带短尾部
  const manyTasks: Task[] = [];
  const manyMsgs: Array<{ taskId: string; m: Message }> = [];
  for (let i = 0; i < 20; i++) {
    manyTasks.push(mkTask(`t${i}`, { kind: 'chat', title: `批量 ${i}`, createdAt: now - 100_000 + i, updatedAt: now - 100_000 + i * 10 }));
    for (let k = 0; k < 150; k++) manyMsgs.push({ taskId: `t${i}`, m: mkMsg(`t${i}m${k}`, k % 2 ? 'agent' : 'user', now - 100_000 + i * 1000 + k, `任务 ${i} 的第 ${k} 条`) });
  }
  await rawCall('store:save', { tasks: manyTasks, messages: manyMsgs, taskOrder: [...manyTasks.map((t) => t.id).reverse(), 'tChat', 'tOld'] });

  // 重启一次（新的页面环境，同一个库）：不再迁移，只读尾部
  store.update((d) => { d.view = 'new'; });
  __resetForTests();
  sb.forgetTaskRegistry('t0');
  saved.length = 0;
  const initial2 = loadState(Date.now());
  store.init(initial2, saveSoon);
  await whenReady();
  s = store.get();
  eq('第二次启动：任务从库里来', Object.keys(s.tasks).length, 22);
  ok(`最近更新的 12 个任务带 ${TAIL_BIG} 条，其余只带 ${TAIL_SMALL} 条（不为空）`, s.tasks.t19.messages.length === TAIL_BIG && s.tasks.t0.messages.length === TAIL_SMALL && TAIL_SMALL >= 1, `${s.tasks.t19.messages.length}/${s.tasks.t0.messages.length}`);
  eq('尾部是最新的那些、按时间顺序', [s.tasks.t0.messages[0].id, s.tasks.t0.messages[TAIL_SMALL - 1].id], [`t0m${150 - TAIL_SMALL}`, 't0m149']);
  eq('没有重复迁移', (await rawCall('store:status')).counts.tasks, 22);
  await flushSaveAsync();
  eq('什么都没改：启动之后不往库里写任务/消息', saved.flatMap((b) => [...(b.tasks ?? []), ...(b.messages ?? [])]).length, 0);

  // 打开一个短尾部的任务：补足到 80 条
  store.update((d) => { d.selectedTaskId = 't0'; d.view = 'task'; });
  await ensureTail('t0');
  s = store.get();
  const ids = s.tasks.t0.messages.map((m) => m.id);
  eq('补足尾部：80 条、连续、无重复、按顺序', [ids.length, ids[0], ids[79], new Set(ids).size, ids.every((id, i) => id === `t0m${70 + i}`)], [80, 't0m70', 't0m149', 80, true]);
  eq('补进来的不会被当成新消息写回', (await (async () => { saved.length = 0; await flushSaveAsync(); return saved.flatMap((b) => b.messages ?? []).length; })()), 0);
  ok('分页游标跟着前移', sb.pagingOf('t0')?.loaded === 80 && sb.pagingOf('t0')!.oldestSeq < 100000);

  // 打开旧任务：取回它那个（paused）运行的重量级部分；这个运行本来就带调用，已不是摘要
  store.update((d) => { d.selectedTaskId = 'tOld'; });
  await ensureRunLoaded('rOld');
  // 造一个摘要运行：把 rOld 改成已完成，写进库，重启后它就是摘要
  store.update((d) => { d.runs.rOld.status = 'completed'; d.runs.rOld.endedAt = Date.now(); });
  await flushSaveAsync();
  __resetForTests();
  saved.length = 0;
  store.init(loadState(Date.now()), saveSoon);
  await whenReady();
  s = store.get();
  eq('已完成的运行启动时只有摘要，数字是全的', [s.runs.rOld.toolCalls.length, sb.runCounts('rOld')?.calls], [0, 1]);
  store.update((d) => { d.selectedTaskId = 'tOld'; d.view = 'task'; });
  await ensureRunLoaded('rOld');
  s = store.get();
  const call = s.runs.rOld.toolCalls[0];
  ok('点开任务后取回了工具调用，大输出仍是折叠摘要', s.runs.rOld.toolCalls.length === 1 && sb.outputSize(call) === 30_000);
  ok('按需取全文', (await sb.fullOutput(call.id))?.length === 30_000);
  await flushSaveAsync();
  eq('取回的内容不写回库', saved.flatMap((b) => [...(b.toolCalls ?? []), ...(b.terminal ?? []), ...(b.artifacts ?? [])]).length, 0);

  // 新活动：只送变了的
  saved.length = 0;
  store.update((d) => { d.tasks.tOld.messages.push(mkMsg('new1', 'user', Date.now(), '新消息：遐蝶')); d.tasks.tOld.updatedAt = Date.now(); });
  await flushSaveAsync();
  const batch = saved.at(-1);
  eq('新消息：批里只有这条消息和任务本体', [batch?.messages?.map((x: Any) => x.m.id), batch?.tasks?.map((t: Task) => t.id), batch?.runs, batch?.toolCalls], [['new1'], ['tOld'], undefined, undefined]);
  eq('库里能搜到', (await rawCall('store:search', { q: '新消息' })).hits.map((h: Any) => h.messageId), ['new1']);

  // 删除任务
  saved.length = 0;
  store.update((d) => { delete d.tasks.tChat; d.taskOrder = d.taskOrder.filter((id) => id !== 'tChat'); });
  await flushSaveAsync();
  eq('删任务：送删除与新顺序', [saved.at(-1)?.deleteTasks, (await rawCall('store:status')).counts.tasks], [['tChat'], 21]);

  // 用量：recordUsage 之后 AppState.usage 刷新
  const before = store.get().usage?.today.turns ?? 0;
  await sb.recordUsage({ at: Date.now(), taskId: 'tOld', provider: 'claude', inputTokens: 100, outputTokens: 20, cachedTokens: 0, costUsd: 0.05 });
  await new Promise((r) => setTimeout(r, 50));
  eq('记一回合后额度条数据刷新', [store.get().usage?.today.turns, store.get().usage?.today.costUsd], [before + 1, 0.05]);

  // 换到一个全新的空库（比如删了库重新开始）：已经迁过一次，不会把旧 localStorage 里的任务翻出来
  (globalThis as Any).__storeIndex.close();
  userDataDir = tmp('e2e-fresh');
  __resetForTests();
  mem.set('alight/v1', JSON.stringify(legacyBlob));
  store.init(loadState(Date.now()), saveSoon);
  await whenReady();
  eq('空库 + 已迁移标记：旧任务不会复活', [Object.keys(store.get().tasks).length, persistMode().mode], [0, 'desktop']);
  mem.delete('alight/migrated-to-db');

  // 库打不开：退回 localStorage，并明说
  __resetForTests();
  const failing = g.alightDesktop.call;
  g.alightDesktop.call = async (channel: string, ...args: unknown[]) => (channel === 'store:status' ? { ok: false, error: '磁盘已满' } : failing(channel, ...args));
  mem.delete('alight/migrated-to-db');
  mem.set('alight/v1', JSON.stringify(legacyBlob));
  const initial3 = loadState(Date.now());
  store.init(initial3, saveSoon);
  await whenReady();
  s = store.get();
  ok('库打不开：旧数据照常可用，并提示这次存在浏览器存储里', persistMode().mode === 'local' && !!s.tasks.tOld && s.toasts.some((t) => t.key === 'store-fallback'), s.toasts.map((t) => t.title).join('/'));
  g.alightDesktop.call = failing;

  // 已迁移过的用户遇到库打不开：退回期间新建的任务、新写的消息，库恢复后要补进库，不能永远躺在 localStorage 里没人读
  (globalThis as Any).__storeIndex.close();
  userDataDir = tmp('e2e-fallback');
  const t0 = Date.now() - 60_000;
  // 库里（迁移之后）：tOld 一个任务；tGone 是迁移后在库里删掉的，还留在 localStorage 那份陈年快照里
  await rawCall('store:save', { tasks: [mkTask('tOld', { createdAt: t0 - 50_000, updatedAt: t0 - 40_000 })], messages: [{ taskId: 'tOld', m: mkMsg('d1', 'user', t0 - 40_000, '库里的消息') }], taskOrder: ['tOld'] });
  const stale = {
    version: 1, rev: 2,
    tasks: {
      tOld: mkTask('tOld', { createdAt: t0 - 50_000, updatedAt: t0 - 60_000, messages: [mkMsg('o1', 'user', t0 - 60_000, '迁移前的旧消息')] }),
      tGone: mkTask('tGone', { createdAt: t0 - 90_000, updatedAt: t0 - 90_000, messages: [mkMsg('g1', 'user', t0 - 90_000, '早就删掉的任务')] }),
    },
    taskOrder: ['tOld', 'tGone'], runs: {}, events: [],
  };
  mem.clear();
  mem.set('alight/v1', JSON.stringify(stale));
  mem.set('alight/migrated-to-db', JSON.stringify({ at: 1, from: 'alight/v1', counts: {} }));
  __resetForTests();
  g.alightDesktop.call = async (channel: string, ...args: unknown[]) => (channel === 'store:status' ? { ok: false, error: '磁盘已满' } : failing(channel, ...args));
  store.init(loadState(Date.now()), saveSoon);
  await whenReady();
  s = store.get();
  eq('退回：显示的是迁移前的旧记录', [persistMode().mode, Object.keys(s.tasks).sort()], ['local', ['tGone', 'tOld']]);
  ok('提示说了实话：看到的是旧记录，这段时间新写的会补进库', s.toasts.some((t) => t.key === 'store-fallback' && /迁移前/.test(t.body ?? '') && /补进库/.test(t.body ?? '')), s.toasts.map((t) => t.body).join('/'));
  const since = Number(mem.get('alight/fallback-since'));
  ok('记下了退回的时刻', since > 0, String(mem.get('alight/fallback-since')));
  store.update((d) => {
    d.tasks.tNew = mkTask('tNew', { createdAt: since + 5, updatedAt: since + 5, messages: [mkMsg('n1', 'user', since + 5, '回退期间新建的任务')] }) as never;
    d.taskOrder.unshift('tNew');
    d.tasks.tOld.messages.push(mkMsg('fb1', 'user', since + 6, '回退期间的追问'));
    d.tasks.tOld.updatedAt = since + 6;
  });
  await flushSaveAsync();
  ok('这些改动存进了 localStorage', !!JSON.parse(mem.get('alight/v1')!).tasks.tNew);
  // 库恢复
  __resetForTests();
  g.alightDesktop.call = failing;
  store.init(loadState(Date.now()), saveSoon);
  await whenReady();
  await flushSaveAsync();
  s = store.get();
  eq('库恢复：回退期间新建的任务和追问补进来了；迁移后在库里删掉的任务没有复活', [persistMode().mode, Object.keys(s.tasks).sort(), s.tasks.tOld.messages.map((m) => m.id)], ['desktop', ['tNew', 'tOld'], ['d1', 'fb1']]);
  const reloaded: Any = await rawCall('store:load');
  eq('补进了库（不只是页面里有）', [reloaded.tasks.map((t: Task) => t.id).sort(), (await rawCall('store:user-messages', { taskId: 'tOld' })).messages.map((m: Any) => m.id), (await rawCall('store:user-messages', { taskId: 'tNew' })).messages.map((m: Any) => m.id)], [['tNew', 'tOld'], ['d1', 'fb1'], ['n1']]);
  eq('补完之后标记清掉，不会再补第二次', mem.get('alight/fallback-since'), '');
  eq('库里已有的 d1 没被陈年快照盖掉（没有 o1）', s.tasks.tOld.messages.some((m) => m.id === 'o1'), false);

  // 数据目录换走之后立刻冻结：这个页面再也不往库里写（否则 1.6 秒的重载窗口里，增量会写进「改用」的那个库）
  store.update((d) => { d.tasks.tNew.messages.push(mkMsg('z1', 'user', Date.now(), '冻结前')); d.tasks.tNew.updatedAt = Date.now(); });
  freezeWrites();
  saved.length = 0;
  store.update((d) => { d.tasks.tNew.messages.push(mkMsg('z2', 'user', Date.now(), '冻结后')); d.tasks.tNew.updatedAt = Date.now(); });
  await flushSaveAsync();
  flushSave();
  await new Promise((r) => setTimeout(r, 1300));   // 超过保存节流（1 秒）
  eq('冻结之后：保存都是空操作，没有任何东西送去库里', saved.length, 0);
  __resetForTests();
}

section('12. 新字段往返（Agent 页 + 台词组合）：Message / Run / Task 的新字段，AppState.memory / quietUntil，迁移的第二条加载路径');
{
  const mem = new Map<string, string>();
  const g = globalThis as Any;
  g.localStorage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  g.window = g;
  g.addEventListener = () => {};
  g.document = { visibilityState: 'visible', addEventListener: () => {} };
  const saved: Any[] = [];
  g.alightDesktop = {
    onEvent: () => () => {},
    call: async (channel: string, ...args: unknown[]) => {
      const r = await rawCall(channel, ...structuredClone(args));
      if (channel === 'store:save' && r.ok) saved.push(args[0]);
      return structuredClone(r);
    },
  };
  (globalThis as Any).__storeIndex.close();
  userDataDir = tmp('e2e-newfields');
  __resetForTests();
  const now = Date.now();

  // ① 库里存取：Message 的新字段进 messages.extra，Run.laidDownAt 进 runs.meta，Task.foldHer / promptRev 进 tasks.meta——不改表
  const her: Message = mkMsg('hm1', 'agent', now - 3000, '收到。这就开始。', {
    agentId: 'orchestrator', kind: 'note', persona: 'night', expr: 'relaxed', react: 'butterfly', proactive: true, crisis: false,
    src: { id: 'task.start.w.m.n', slots: { t: '整理 README', n: 2 }, mode: 'work', idx: 1, scene: 'task.start' }, prevText: '换说法之前的原文',
  });
  const landed: Message = mkMsg('hm2', 'user', now - 2000, '谢谢', { reaction: 'landing' });
  const crisisMsg: Message = mkMsg('hm3', 'agent', now - 1000, '我在这里。', { agentId: 'orchestrator', expr: 'gentle', crisis: true });
  const t1 = mkTask('nf1', { kind: 'chat', foldHer: true, promptRev: 'k3j2h1', runIds: ['nfr1'], createdAt: now - 9000, updatedAt: now - 500, messages: [her, landed, crisisMsg] });
  const r1 = mkRun('nfr1', 'nf1', 'failed', { laidDownAt: now - 100, plan: [{ id: 'ps1', index: 0, title: '读文件', detail: '', agentId: 'researcher', ranAs: 'orchestrator', status: 'done', toolCallIds: [] } as Any] });
  const sv = await rawCall('store:save', { tasks: [(({ messages: _m, ...rest }) => rest)(t1)], messages: t1.messages.map((m) => ({ taskId: 'nf1', m })), runs: [r1], taskOrder: ['nf1'] });
  ok('新字段能存进库', sv.ok && sv.skipped === 0, JSON.stringify(sv));
  const back: Any = await rawCall('store:load');
  const bt = back.tasks.find((t: Task) => t.id === 'nf1');
  eq('Message：expr / react / proactive / src / prevText / crisis / reaction 原样读回', bt.messages.map((m: Message) => [m.id, m.expr, m.react, m.proactive, m.src, m.prevText, m.crisis, m.reaction]),
    [['hm1', 'relaxed', 'butterfly', true, her.src, '换说法之前的原文', false, undefined], ['hm2', undefined, undefined, undefined, undefined, undefined, undefined, 'landing'], ['hm3', 'gentle', undefined, undefined, undefined, undefined, true, undefined]]);
  eq('Task：foldHer / promptRev 读回', [bt.foldHer, bt.promptRev], [true, 'k3j2h1']);
  const br = back.runs.find((r: Run) => r.id === 'nfr1');
  eq('Run：laidDownAt 读回，PlanStep.ranAs 读回', [br.laidDownAt, br.plan[0].ranAs], [r1.laidDownAt, 'orchestrator']);
  eq('旧消息（没有新字段）读回来也没有，渲染时固定 gentle', Object.keys(bt.messages[1]).sort(), ['at', 'id', 'reaction', 'role', 'text']);

  // ② persist 端到端（桌面版，假桥）：只改 memory / 只改 quietUntil 也触发保存；重启后还在
  (globalThis as Any).__storeIndex.close();
  userDataDir = tmp('e2e-newfields-2');
  __resetForTests();
  mem.clear();
  store.init(loadState(Date.now()), saveSoon);
  await whenReady();
  const prefsSent = () => saved.flatMap((b) => (b.prefs ? [JSON.parse(b.prefs)] : []));
  saved.length = 0;
  store.update((d) => { d.settings.callName = '先动一个别的'; });
  await flushSaveAsync();
  const nBefore = prefsSent().length;
  ok('（前提）改设置会把偏好送去库里', nBefore >= 1);
  store.update((d) => { d.memory.push({ id: 'mem1', text: '只改了 memory', at: Date.now() }); });
  await flushSaveAsync();
  const afterMem = prefsSent();
  ok('只改 memory：偏好再送一次，里面有这条备忘', afterMem.length > nBefore && afterMem.at(-1).memory?.[0]?.text === '只改了 memory', JSON.stringify(afterMem.at(-1)?.memory));
  store.update((d) => { d.quietUntil = 9_999_000; });
  await flushSaveAsync();
  eq('只改 quietUntil：偏好再送一次', prefsSent().at(-1).quietUntil, 9_999_000);
  eq('偏好带着 settingsRev 6 / agentsRev 2', [prefsSent().at(-1).settingsRev, prefsSent().at(-1).agentsRev], [6, 2]);
  const lsPrefs = mem.get('alight/prefs');
  ok('localStorage 里的偏好同步更新（启动要同步读）', !!lsPrefs && JSON.parse(lsPrefs).memory?.length === 1 && JSON.parse(lsPrefs).quietUntil === 9_999_000);

  // 重启：localStorage 偏好在
  __resetForTests();
  const restarted = loadState(Date.now());
  eq('重启后（读 localStorage）：memory / quietUntil 还在', [restarted.memory.map((m) => m.text), restarted.quietUntil], [['只改了 memory'], 9_999_000]);

  // 审查：备忘长度口径——存时按码点、读时也按码点（含 emoji 的备忘重启后不能整条消失）；超长读档宁可截断也不丢
  const boot2 = async (dir: string) => {
    (globalThis as Any).__storeIndex.close();
    userDataDir = tmp(dir);
    __resetForTests();
    store.init(loadState(Date.now()), saveSoon);
    await whenReady();
  };
  mem.clear();
  await boot2('e2e-memlen');
  const emojiText = '好'.repeat(70) + '🦋'.repeat(10);
  ok('（前提）这条 70 汉字 + 10 个 emoji：80 个码点、90 个 UTF-16 单元', Array.from(emojiText).length === 80 && emojiText.length === 90);
  store.update((d) => { d.memory.push({ id: 'mem-emoji', text: emojiText, at: Date.now() }); });
  await flushSaveAsync();
  ok('（前提）这条备忘存进了 localStorage 的偏好', JSON.parse(mem.get('alight/prefs') ?? '{}').memory?.[0]?.text === emojiText);
  __resetForTests();
  eq('含 emoji 的备忘重启后还在（原样）', loadState(Date.now()).memory.find((m) => m.id === 'mem-emoji')?.text, emojiText);
  {
    const raw = JSON.parse(mem.get('alight/prefs')!);
    mem.set('alight/prefs', JSON.stringify({ ...raw, memory: [{ id: 'long', text: '长'.repeat(95), at: 1 }, { id: 'blank', text: '   ', at: 2 }, { id: 'ok1', text: '正常的', at: 3 }] }));
    __resetForTests();
    const trimmed = loadState(Date.now());
    eq('读档时超长的备忘截到 80 个码点，不整条丢；空白的丢；正常的留', [trimmed.memory.map((m) => m.id), Array.from(trimmed.memory[0].text).length], [['long', 'ok1'], 80]);
  }
  // 审查：回滚到 0.1.4 改了设置，它整份重写 prefs（没有 memory / quietUntil）；再升回来时备忘要能从独立键里找回
  await boot2('e2e-memroll');
  store.update((d) => { d.memory = [{ id: 'keep1', text: '用户亲手写的备忘', at: 5 }]; });
  await flushSaveAsync();
  ok('备忘另存了一份独立的键 alight/memory（旧版不读也不写）', JSON.parse(mem.get('alight/memory') ?? '[]')[0]?.text === '用户亲手写的备忘');
  {
    const old = JSON.parse(mem.get('alight/prefs')!);
    delete old.memory; delete old.quietUntil; delete old.agentsRev;
    old.settingsRev = 2;
    mem.set('alight/prefs', JSON.stringify(old));   // 0.1.4 重写后的样子
    __resetForTests();
    eq('回滚 → 0.1.4 重写 prefs → 升回来：备忘找回', loadState(Date.now()).memory.map((m) => m.text), ['用户亲手写的备忘']);
  }
  await boot2('e2e-memdel');
  store.update((d) => { d.memory = []; });
  await flushSaveAsync();
  __resetForTests();
  eq('用户删光备忘后不会被独立键「复活」（prefs 里是空数组，空数组是有效值）', loadState(Date.now()).memory, []);

  // ③ 迁移的第二条加载路径：localStorage 被清，偏好只在库里（prefs 镜像）. 旧口径（distance 2 + lifeNudge）要迁成 level l / proactive on；备忘与每 Agent 的档也走 applyPrefs
  (globalThis as Any).__storeIndex.close();
  userDataDir = tmp('e2e-newfields-3');
  __resetForTests();
  mem.clear();
  const oldPrefs = {
    settingsRev: 2, policyRev: 2, settings: { mode: 'night', callName: '阁下', distance: 2, persona: true, lifeNudge: true, lifeGreeting: false, bootVideo: true }, navCollapsed: false,
    console: { open: false, height: 280, tab: 'tools' }, tools: [],
    agents: [{ id: 'coder', enabled: true, tools: ['read_file', 'write_file', 'code_search', 'shell'] }],
    memory: [{ id: 'dm1', text: '库里的备忘', at: 1 }],
  };
  await rawCall('store:save', { prefs: JSON.stringify(oldPrefs) });
  store.init(loadState(Date.now()), saveSoon);
  await whenReady();
  let s = store.get();
  eq('库镜像路径：旧口径迁成新口径', [s.settings.level, s.settings.proactive, s.settings.persona, s.settings.lifeGreeting], ['l', 'on', true, false]);
  eq('库镜像路径：settingsRev < 5 存下的 bootVideo true 换回实时（与 localStorage 路径同一个 migrateSettings；4 / 5 的分界由 unit-check 钉住）', s.settings.bootVideo, false);
  eq('库镜像路径：每 Agent 的档由旧 tools 清单迁来', s.agents.find((a) => a.id === 'coder')?.tiers, { web_search: 'off', web_fetch: 'off', git: 'off', browser_read: 'off', browser_act: 'off' });
  eq('库镜像路径：备忘读回', s.memory.map((m) => m.text), ['库里的备忘']);
  // 库里是 distance 0 + persona true（旧口径里「少」）→ persona 关
  (globalThis as Any).__storeIndex.close();
  userDataDir = tmp('e2e-newfields-4');
  __resetForTests();
  mem.clear();
  await rawCall('store:save', { prefs: JSON.stringify({ ...oldPrefs, settings: { ...oldPrefs.settings, distance: 0, persona: true, lifeNudge: false } }) });
  store.init(loadState(Date.now()), saveSoon);
  await whenReady();
  s = store.get();
  eq('库镜像路径：distance 0（少）→ persona 关、level m、proactive auto', [s.settings.persona, s.settings.level, s.settings.proactive], [false, 'm', 'auto']);
  (globalThis as Any).__storeIndex.close();
  __resetForTests();
}

/* ═══════════════════════ 收尾 ═══════════════════════ */

try { (globalThis as Any).__storeIndex?.close(); } catch { /* 已关 */ }
try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch { /* 临时文件，系统会清 */ }
console.log(failed ? `\n${failed} of ${checks} checks failed` : `\nall ${checks} checks passed`);
process.exit(failed ? 1 : 0);
