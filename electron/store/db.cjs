// 存储层核心（V0α · 模块 B2「存储」）。纯 node:sqlite，不依赖 electron，所以 scripts/check-store.ts 可以直接在 Node 里测它。
//
// 布局（<dataDir>/alight.db，WAL）：
//   tasks            任务本体（meta = 除 messages 以外的 JSON）
//   messages         消息（seq = 插入顺序，是翻页游标；text 全量）
//   runs             运行（meta = 除 toolCalls / terminal / artifacts 以外的 JSON，大字段已封顶）
//   tool_calls       工具调用（输出 >5 KB：只在行里放摘要，全文进 tool_outputs，按需取）
//   tool_outputs     大输出全文
//   artifacts / terminal_lines   产物与终端行（按行存，append / upsert，不整体重写）
//   events           append-only 事件日志
//   usage            任务级用量（task_usage：只有数字，没有任何内容）
//   msg_fts          消息全文检索（FTS5 contentless；中日韩逐字切词，所以两个字的词也搜得到）
//   kv               小开关与偏好镜像
//
// 页面启动只拿「每个任务的尾部消息 + 各运行的摘要」，绝不整份读入渲染进程（K08）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA_VERSION = 1;

/** 工具输出超过这个长度（字符）就只在行里放摘要，全文另存、按需取（K08）。 */
const OUTPUT_INLINE_MAX = 5 * 1024;
const OUTPUT_SUMMARY_LEN = 1200;
/** 全文本身的上限，再大的截断并标注（不会让一条 cat 出来的巨型输出撑爆库）。 */
const OUTPUT_FULL_MAX = 1_000_000;
/** 一条消息正文的上限。 */
const TEXT_MAX = 2_000_000;
/** 运行元数据里任何一个字符串字段的上限（计划结果、审批预览、错误详情…）。 */
const FIELD_MAX = 20_000;
/** 工具输入里每个字符串字段的上限（输入多半是命令或要写的文件内容，文件本身在磁盘上）。 */
const INPUT_FIELD_MAX = 5000;
/** 进全文索引的单条消息长度上限。 */
const FTS_TEXT_MAX = 50_000;

const OPEN_STATUSES = ['running', 'queued', 'paused', 'awaiting'];

/* ───────────── 小工具 ───────────── */

function parse(s, fallback) {
  if (typeof s !== 'string' || !s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const orNull = (v) => (v === undefined ? null : v);

/** 切到 UTF-16 长度 max 以内，不把一个代理对劈成两半。 */
function clip(s, max) {
  if (s.length <= max) return s;
  let end = max;
  const c = s.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

function capText(s, max) {
  if (typeof s !== 'string' || s.length <= max) return s;
  return `${clip(s, max)}\n…（保存时截断，原长 ${s.length} 字符）`;
}

/** 递归把对象里过长的字符串封顶（只用于元数据；返回新对象，不改入参）。 */
function capDeep(v, max, depth = 0) {
  if (typeof v === 'string') return capText(v, max);
  if (!v || typeof v !== 'object' || depth > 8) return v;
  if (Array.isArray(v)) return v.map((x) => capDeep(x, max, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) if (x !== undefined) out[k] = capDeep(x, max, depth + 1);
  return out;
}

function summarize(output) {
  return `${clip(output, OUTPUT_SUMMARY_LEN)}\n…`;
}

/* ───────────── 中日韩切词（FTS） ───────────── */

// 汉字、假名、谚文、扩展 A/B+：每个字符自成一个词。unicode61 对它们不断词，整句会变成一个词，两个字的查询就搜不到。
const CJK = /[⺀-⿟぀-ヿㇰ-ㇿ㐀-䶿一-鿿가-힯豈-﫿]|[\ud840-\ud87f][\udc00-\udfff]/g;

/** 写进索引的文本：CJK 字符两侧补空格，其余交给 unicode61。 */
function segment(text) {
  return String(text).replace(CJK, ' $& ');
}

/**
 * 把用户输入变成 FTS5 查询：空白分隔的每一项是一个短语（CJK 逐字相邻），项与项之间是「且」；
 * 最后一个字符是拉丁字母或数字时加前缀星号，边输边搜。没有可搜内容返回 null。
 */
function ftsQuery(q) {
  const terms = String(q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
  const parts = [];
  for (const raw of terms) {
    const term = raw.replace(/"/g, ' ');
    if (!/[\p{L}\p{N}]/u.test(term)) continue;
    const seg = segment(term).trim().replace(/\s+/g, ' ');
    const prefix = /[A-Za-z0-9]$/.test(term) ? '*' : '';
    parts.push(`"${seg}"${prefix}`);
  }
  return parts.length ? parts.join(' ') : null;
}

/* ───────────── 本地时间边界（今日 / 本周） ───────────── */

function startOfDay(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
/** 本周从周一 00:00（本地时间）算起。 */
function startOfWeek(now) {
  const d = new Date(startOfDay(now));
  const back = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - back);
  return d.getTime();
}

/* ───────────── 库 ───────────── */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0,
  kind TEXT,
  meta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_updated ON tasks(updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  run_id TEXT,
  role TEXT NOT NULL,
  kind TEXT,
  at INTEGER NOT NULL,
  text TEXT NOT NULL,
  extra TEXT,
  fts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS messages_task ON messages(task_id, seq);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  attempt INTEGER,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER,
  ended_at INTEGER,
  cost_usd REAL,
  meta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, created_at);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status);
CREATE TABLE IF NOT EXISTS tool_calls (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  input TEXT,
  output TEXT,
  out_len INTEGER NOT NULL DEFAULT 0,
  meta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tool_calls_run ON tool_calls(run_id, seq);
CREATE INDEX IF NOT EXISTS tool_calls_task_time ON tool_calls(task_id, started_at);
CREATE TABLE IF NOT EXISTS tool_outputs (
  call_id TEXT PRIMARY KEY REFERENCES tool_calls(id) ON DELETE CASCADE,
  body TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifacts (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  meta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(run_id, seq);
CREATE TABLE IF NOT EXISTS terminal_lines (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  at INTEGER NOT NULL,
  stream TEXT NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS terminal_run ON terminal_lines(run_id, seq);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  at INTEGER NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL,
  level TEXT NOT NULL,
  text TEXT NOT NULL,
  ref_id TEXT
);
CREATE INDEX IF NOT EXISTS events_at ON events(at);
CREATE INDEX IF NOT EXISTS events_run ON events(run_id, seq);
CREATE TABLE IF NOT EXISTS usage (
  seq INTEGER PRIMARY KEY,
  at INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  run_id TEXT,
  provider TEXT NOT NULL,
  model TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL,
  cost_estimated INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  dedupe TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
  DELETE FROM msg_fts WHERE rowid = old.seq;
END;
`;

class AlightDb {
  /**
   * @param {string} file 库文件路径（目录要已存在）
   * @param {{ readOnly?: boolean }} [opts]
   */
  constructor(file, opts = {}) {
    this.file = file;
    this.readOnly = !!opts.readOnly;
    this.db = new DatabaseSync(file, { readOnly: this.readOnly });
    this.stmts = new Map();
    this.depth = 0;
    try {
      this.db.exec('PRAGMA busy_timeout = 5000');
      if (!this.readOnly) {
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
      }
      this.db.exec('PRAGMA foreign_keys = ON');
      this.db.exec('PRAGMA cache_size = -20000');
      if (!this.readOnly) this.migrate();
    } catch (e) {
      // 不是数据库 / 版本太新 / 损坏：别把文件句柄留着（Windows 上它会让「删掉坏文件」这条手动补救也删不掉）
      try { this.db.close(); } catch { /* 已经关了 */ }
      this.db = null;
      throw e;
    }
  }

  /* ── 基础 ── */

  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) { s = this.db.prepare(sql); this.stmts.set(sql, s); }
    return s;
  }
  run(sql, ...args) { return this.q(sql).run(...args); }
  get(sql, ...args) { return this.q(sql).get(...args); }
  all(sql, ...args) { return this.q(sql).all(...args); }

  /** 一个事务（可嵌套：内层直接并入外层）。出错回滚并抛出。 */
  tx(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* 已经回滚 */ }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  migrate() {
    const v = this.get('PRAGMA user_version').user_version;
    if (v > SCHEMA_VERSION) throw new Error(`数据库版本（${v}）比这个程序（${SCHEMA_VERSION}）新，请更新栖枝后再打开`);
    if (v < SCHEMA_VERSION) {
      this.db.exec(SCHEMA);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.kvSet('schema.created', String(Date.now()));
    }
  }

  close() {
    if (!this.db) return;
    try {
      if (!this.readOnly) {
        try { this.db.exec('PRAGMA optimize'); } catch { /* 不重要 */ }
        try { this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch { /* 有别的连接在读 */ }
      }
    } finally {
      this.stmts.clear();
      this.db.close();
      this.db = null;
    }
  }

  /* ── kv ── */

  kvGet(key) {
    const r = this.get('SELECT value FROM kv WHERE key = ?', key);
    return r ? r.value : undefined;
  }
  kvSet(key, value) {
    this.run(
      'INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      key, String(value), Date.now(),
    );
  }
  kvDelete(key) { this.run('DELETE FROM kv WHERE key = ?', key); }

  /* ── 行 ⇄ 对象 ── */

  messageRow(m) {
    const { id, role, runId, kind, at, text, ...extra } = m;
    return {
      id: str(id, 80), role: str(role, 12) || 'system', runId: runId ? str(runId, 80) : null, kind: kind ? str(kind, 16) : null,
      at: num(at), text: capText(typeof text === 'string' ? text : '', TEXT_MAX),
      extra: Object.keys(extra).length ? JSON.stringify(extra) : null,
    };
  }

  messageFromRow(r) {
    const m = { id: r.id, role: r.role, at: r.at, text: r.text };
    if (r.run_id) m.runId = r.run_id;
    if (r.kind) m.kind = r.kind;
    if (r.extra) Object.assign(m, parse(r.extra, {}));
    return m;
  }

  /** 调用行：输入封顶；输出超过 5 KB 的行里只放摘要。keepOutput = 页面手里只有摘要，别拿摘要盖掉全文。 */
  toolCallRow(c, keepOutput) {
    const { id, runId, startedAt, status, input, output, ...rest } = c;
    const inp = {};
    for (const [k, v] of Object.entries(input ?? {})) inp[k] = typeof v === 'string' ? capText(v, INPUT_FIELD_MAX) : v;
    let out = null;
    let outLen = 0;
    let full = null;
    if (typeof output === 'string') {
      outLen = output.length;
      if (output.length > OUTPUT_INLINE_MAX) {
        out = summarize(output);
        full = capText(output, OUTPUT_FULL_MAX);
      } else out = output;
    }
    return {
      id: str(id, 80), runId: str(runId, 80), startedAt: num(startedAt), status: str(status, 16) || 'ok',
      input: JSON.stringify(inp), output: out, outLen, full, keepOutput: !!keepOutput,
      meta: JSON.stringify(capDeep(rest, FIELD_MAX)),
    };
  }

  toolCallFromRow(r) {
    const c = { ...parse(r.meta, {}), id: r.id, runId: r.run_id, startedAt: r.started_at, status: r.status, input: parse(r.input, {}) };
    if (r.output !== null && r.output !== undefined) c.output = r.output;
    return c;
  }

  /* ── 保存 ── */

  /**
   * 一批改动（页面只送变了的）。返回 { ok, skipped, errors }：单条出错（例如任务已被删）跳过，不拖垮整批。
   * @param {object} b
   */
  save(b) {
    const errors = [];
    let skipped = 0;
    const guard = (what, fn) => {
      try { fn(); } catch (e) { skipped += 1; if (errors.length < 5) errors.push(`${what}: ${e.message}`); }
    };
    this.tx(() => {
      for (const id of b.deleteTasks ?? []) guard('deleteTask', () => this.deleteTask(String(id)));
      for (const t of b.tasks ?? []) guard('task', () => this.upsertTask(t));
      for (const r of b.runs ?? []) guard('run', () => this.upsertRun(r));
      for (const id of b.deleteRuns ?? []) guard('deleteRun', () => this.deleteRun(String(id)));
      for (const m of b.messages ?? []) guard('message', () => this.upsertMessage(m.taskId, m.m));
      for (const id of b.deleteMessages ?? []) guard('deleteMessage', () => this.run('DELETE FROM messages WHERE id = ?', String(id)));
      for (const c of b.toolCalls ?? []) guard('toolCall', () => this.upsertToolCall(c));
      for (const a of b.artifacts ?? []) guard('artifact', () => this.upsertArtifact(a));
      for (const l of b.terminal ?? []) guard('terminal', () => this.upsertTerminal(l));
      for (const e of b.events ?? []) guard('event', () => this.insertEvent(e));
      if (b.clearEvents) this.run('DELETE FROM events');
      if (Array.isArray(b.taskOrder)) this.kvSet('taskOrder', JSON.stringify(b.taskOrder));
      if (b.prefs !== undefined) this.kvSet('prefs', typeof b.prefs === 'string' ? b.prefs : JSON.stringify(b.prefs));
    });
    return { ok: true, skipped, errors };
  }

  upsertTask(t) {
    const { messages: _ignored, ...meta } = t.task ?? t;
    const id = str(meta.id, 80);
    if (!id) throw new Error('任务没有 id');
    this.run(
      `INSERT INTO tasks(id, title, created_at, updated_at, kind, meta) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at, kind = excluded.kind, meta = excluded.meta`,
      id, str(meta.title, 500), num(meta.createdAt), num(meta.updatedAt), meta.kind ? str(meta.kind, 12) : null, JSON.stringify(capDeep(meta, FIELD_MAX)),
    );
  }

  deleteTask(id) {
    this.run('DELETE FROM events WHERE run_id IN (SELECT id FROM runs WHERE task_id = ?)', id);
    this.run('DELETE FROM tasks WHERE id = ?', id);
  }

  upsertMessage(taskId, m) {
    const r = this.messageRow(m);
    if (!r.id) throw new Error('消息没有 id');
    const old = this.get('SELECT seq, text, fts FROM messages WHERE id = ?', r.id);
    const streaming = !!(m && m.streaming);
    const eligible = (r.role === 'user' || r.role === 'agent') && !streaming && r.text.trim().length > 0;
    let seq;
    if (old) {
      seq = old.seq;
      const textSame = old.text === r.text;
      const keepFts = textSame && ((old.fts === 1) === eligible);
      this.run('UPDATE messages SET task_id = ?, run_id = ?, role = ?, kind = ?, at = ?, text = ?, extra = ?, fts = ? WHERE seq = ?',
        taskId, r.runId, r.role, r.kind, r.at, r.text, r.extra, keepFts ? old.fts : 0, seq);
      if (keepFts) return;
      if (old.fts === 1) this.run('DELETE FROM msg_fts WHERE rowid = ?', seq);
    } else {
      seq = this.get(
        'INSERT INTO messages(id, task_id, run_id, role, kind, at, text, extra, fts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0) RETURNING seq',
        r.id, taskId, r.runId, r.role, r.kind, r.at, r.text, r.extra,
      ).seq;
    }
    if (eligible) {
      this.run('INSERT INTO msg_fts(rowid, body) VALUES (?, ?)', seq, segment(clip(r.text, FTS_TEXT_MAX)));
      this.run('UPDATE messages SET fts = 1 WHERE seq = ?', seq);
    }
  }

  upsertRun(r) {
    const run = r.run ?? r;
    const { toolCalls: _c, terminal: _t, artifacts: _a, ...meta } = run;
    const id = str(meta.id, 80);
    if (!id) throw new Error('运行没有 id');
    const taskId = str(meta.taskId, 80);
    this.run(
      `INSERT INTO runs(id, task_id, attempt, status, created_at, started_at, ended_at, cost_usd, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET task_id = excluded.task_id, attempt = excluded.attempt, status = excluded.status, created_at = excluded.created_at,
         started_at = excluded.started_at, ended_at = excluded.ended_at, cost_usd = excluded.cost_usd, meta = excluded.meta`,
      id, taskId, num(meta.attempt, 1), str(meta.status, 16) || 'queued', num(meta.createdAt), orNull(meta.startedAt ?? null), orNull(meta.endedAt ?? null),
      typeof meta.costUsd === 'number' ? meta.costUsd : null, JSON.stringify(capDeep(meta, FIELD_MAX)),
    );
  }

  deleteRun(id) {
    this.run('DELETE FROM events WHERE run_id = ?', id);
    this.run('DELETE FROM runs WHERE id = ?', id);
  }

  upsertToolCall(c) {
    const taskId = str(c.taskId, 80);
    const { taskId: _t, keepOutput, ...call } = c;
    const r = this.toolCallRow(call, keepOutput);
    if (r.keepOutput) {
      this.run(
        `INSERT INTO tool_calls(id, run_id, task_id, started_at, status, input, output, out_len, meta) VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, input = excluded.input, meta = excluded.meta`,
        r.id, r.runId, taskId, r.startedAt, r.status, r.input, r.meta,
      );
      return;
    }
    this.run(
      `INSERT INTO tool_calls(id, run_id, task_id, started_at, status, input, output, out_len, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, input = excluded.input, output = excluded.output, out_len = excluded.out_len, meta = excluded.meta`,
      r.id, r.runId, taskId, r.startedAt, r.status, r.input, r.output, r.outLen, r.meta,
    );
    if (r.full !== null) {
      this.run('INSERT INTO tool_outputs(call_id, body) VALUES (?, ?) ON CONFLICT(call_id) DO UPDATE SET body = excluded.body', r.id, r.full);
    } else {
      this.run('DELETE FROM tool_outputs WHERE call_id = ?', r.id);
    }
  }

  upsertArtifact(a) {
    const { id, runId, taskId, createdAt, content, ...rest } = a;
    this.run(
      `INSERT INTO artifacts(id, run_id, task_id, created_at, content, meta) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET content = excluded.content, meta = excluded.meta`,
      str(id, 80), str(runId, 80), str(taskId, 80), num(createdAt), capText(typeof content === 'string' ? content : '', TEXT_MAX), JSON.stringify(capDeep(rest, FIELD_MAX)),
    );
  }

  upsertTerminal(l) {
    this.run(
      `INSERT INTO terminal_lines(id, run_id, at, stream, text) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET text = excluded.text`,
      str(l.id, 80), str(l.runId, 80), num(l.at), str(l.stream, 8) || 'stdout', capText(typeof l.text === 'string' ? l.text : '', 20_000),
    );
  }

  insertEvent(e) {
    this.run(
      'INSERT OR IGNORE INTO events(id, at, run_id, kind, level, text, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      str(e.id, 80), num(e.at), e.runId ? str(e.runId, 80) : null, str(e.kind, 16) || 'run', str(e.level, 8) || 'info', capText(String(e.text ?? ''), 2000), e.refId ? str(e.refId, 80) : null,
    );
  }

  /* ── 读：启动尾部 ── */

  /**
   * 启动快照：所有任务的本体 + 每个任务最近的 tail 条消息（最近 bigTasks 个任务多取一些）+ 所有运行的摘要
   * （没有 toolCalls / terminal / artifacts；正在进行的运行除外，它们要能接着跑）+ 最近的事件。
   */
  load(opts = {}) {
    const tailBig = Math.max(1, Math.min(num(opts.tailBig, 80), 500));
    const tailSmall = Math.max(1, Math.min(num(opts.tailSmall, 12), tailBig));
    const bigTasks = Math.max(0, Math.min(num(opts.bigTasks, 12), 200));
    const eventsLimit = Math.max(0, Math.min(num(opts.eventsLimit, 300), 2000));

    const taskRows = this.all('SELECT id, meta FROM tasks ORDER BY updated_at DESC');
    const big = new Set(taskRows.slice(0, bigTasks).map((r) => r.id));
    const totals = new Map(this.all('SELECT task_id, COUNT(*) AS n FROM messages GROUP BY task_id').map((r) => [r.task_id, r.n]));

    const tasks = [];
    const paging = {};
    for (const r of taskRows) {
      const task = parse(r.meta, null);
      if (!task || typeof task !== 'object') continue;
      const limit = big.has(r.id) ? tailBig : tailSmall;
      const rows = this.all(
        'SELECT seq, id, run_id, role, kind, at, text, extra FROM messages WHERE task_id = ? ORDER BY seq DESC LIMIT ?', r.id, limit,
      ).reverse();
      task.id = r.id;
      task.messages = rows.map((x) => this.messageFromRow(x));
      tasks.push(task);
      paging[r.id] = { total: totals.get(r.id) ?? 0, oldestSeq: rows.length ? rows[0].seq : 0, loaded: rows.length };
    }

    const order = parse(this.kvGet('taskOrder'), []);
    const known = new Set(tasks.map((t) => t.id));
    const taskOrder = [];
    const seen = new Set();
    for (const id of Array.isArray(order) ? order : []) if (known.has(id) && !seen.has(id)) { seen.add(id); taskOrder.push(id); }
    // 没出现在顺序里的（旧版本残留、手工改库）按创建时间新到旧补在后面。
    for (const t of [...tasks].sort((a, b) => num(b.createdAt) - num(a.createdAt))) if (!seen.has(t.id)) { seen.add(t.id); taskOrder.push(t.id); }

    const counts = this.runCounts();
    const runs = [];
    const lean = [];
    const big2 = {};
    for (const r of this.all('SELECT id, status, meta FROM runs ORDER BY created_at')) {
      const run = parse(r.meta, null);
      if (!run || typeof run !== 'object') continue;
      run.id = r.id;
      run.toolCalls = [];
      run.terminal = [];
      run.artifacts = [];
      if (OPEN_STATUSES.includes(r.status)) {
        const d = this.loadRun(r.id);
        run.toolCalls = d.toolCalls;
        run.terminal = d.terminal;
        run.artifacts = d.artifacts;
        Object.assign(big2, d.big);
      } else lean.push(r.id);
      runs.push(run);
    }

    const events = this.all('SELECT id, at, run_id, kind, level, text, ref_id FROM events ORDER BY at DESC, seq DESC LIMIT ?', eventsLimit)
      .reverse().map((e) => this.eventFromRow(e));

    return { tasks, taskOrder, runs, lean, counts, big: big2, events, paging, prefs: this.kvGet('prefs') ?? null };
  }

  eventFromRow(e) {
    const ev = { id: e.id, at: e.at, kind: e.kind, level: e.level, text: e.text };
    if (e.run_id) ev.runId = e.run_id;
    if (e.ref_id) ev.refId = e.ref_id;
    return ev;
  }

  /** 每个运行里工具调用 / 错误 / 产物 / 终端行的条数，以及按 Agent、按工具的分项（没读进页面的部分也要能算进统计）. */
  runCounts() {
    const out = {};
    const get = (id) => (out[id] ??= { calls: 0, errors: 0, artifacts: 0, lines: 0, byAgent: {}, byTool: {} });
    for (const r of this.all(
      `SELECT run_id, json_extract(meta, '$.agentId') AS agent, json_extract(meta, '$.tool') AS tool, COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errs FROM tool_calls GROUP BY run_id, agent, tool`)) {
      const c = get(r.run_id);
      const n = Number(r.n);
      const e = Number(r.errs);
      c.calls += n;
      c.errors += e;
      if (r.agent) { const a = (c.byAgent[r.agent] ??= { calls: 0, errors: 0 }); a.calls += n; a.errors += e; }
      if (r.tool) { const t = (c.byTool[r.tool] ??= { calls: 0, errors: 0 }); t.calls += n; t.errors += e; }
    }
    for (const r of this.all('SELECT run_id, COUNT(*) AS n FROM artifacts GROUP BY run_id')) get(r.run_id).artifacts = Number(r.n);
    for (const r of this.all('SELECT run_id, COUNT(*) AS n FROM terminal_lines GROUP BY run_id')) get(r.run_id).lines = Number(r.n);
    return out;
  }

  /** 一个运行的重量级部分：工具调用（大输出只给摘要）、产物、终端最后 terminalTail 行。 */
  loadRun(runId, opts = {}) {
    const terminalTail = Math.max(0, Math.min(num(opts.terminalTail, 2000), 20000));
    const calls = this.all('SELECT id, run_id, started_at, status, input, output, out_len, meta FROM tool_calls WHERE run_id = ? ORDER BY seq', runId);
    const big = {};
    const toolCalls = calls.map((r) => {
      if (r.out_len > OUTPUT_INLINE_MAX) big[r.id] = r.out_len;
      return this.toolCallFromRow(r);
    });
    const artifacts = this.all('SELECT id, run_id, task_id, created_at, content, meta FROM artifacts WHERE run_id = ? ORDER BY seq', runId)
      .map((r) => ({ ...parse(r.meta, {}), id: r.id, runId: r.run_id, createdAt: r.created_at, content: r.content }));
    const total = this.get('SELECT COUNT(*) AS n FROM terminal_lines WHERE run_id = ?', runId).n;
    const terminal = this.all('SELECT id, run_id, at, stream, text FROM terminal_lines WHERE run_id = ? ORDER BY seq DESC LIMIT ?', runId, terminalTail)
      .reverse().map((r) => ({ id: r.id, runId: r.run_id, at: r.at, stream: r.stream, text: r.text }));
    return { toolCalls, artifacts, terminal, terminalTotal: total, big };
  }

  /** 工具调用的全文输出（没有单独存的，就是行里的原文）。 */
  output(callId) {
    const full = this.get('SELECT body FROM tool_outputs WHERE call_id = ?', callId);
    if (full) return { found: true, output: full.body };
    const row = this.get('SELECT output FROM tool_calls WHERE id = ?', callId);
    return row ? { found: true, output: row.output ?? '' } : { found: false, output: '' };
  }

  /** 某任务在时间区间内的工具调用（向上翻页时，把夹在这些消息之间的调用一起带回来）。 */
  callsInRange(taskId, fromAt, toAt, limit = 1500) {
    const rows = this.all(
      `SELECT id, run_id, started_at, status, input, output, out_len, meta FROM tool_calls
       WHERE task_id = ? AND started_at >= ? AND started_at <= ? ORDER BY started_at DESC, seq DESC LIMIT ?`,
      taskId, fromAt, toAt, limit,
    ).reverse();
    const big = {};
    const calls = rows.map((r) => {
      if (r.out_len > OUTPUT_INLINE_MAX) big[r.id] = r.out_len;
      return this.toolCallFromRow(r);
    });
    return { calls, big };
  }

  /**
   * 向上翻页：seq < beforeSeq 的 limit 条消息（老的在前），以及夹在它们之间的工具调用。
   * more = 还有更早的。
   */
  page(req) {
    const taskId = str(req.taskId, 80);
    const limit = Math.max(1, Math.min(num(req.limit, 60), 500));
    const before = typeof req.beforeSeq === 'number' && req.beforeSeq > 0 ? req.beforeSeq : Number.MAX_SAFE_INTEGER;
    const rows = this.all(
      'SELECT seq, id, run_id, role, kind, at, text, extra FROM messages WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?',
      taskId, before, limit + 1,
    );
    const more = rows.length > limit;
    if (more) rows.pop();
    rows.reverse();
    const out = { messages: rows.map((r) => this.messageFromRow(r)), more, oldestSeq: rows.length ? rows[0].seq : 0, calls: [], big: {} };
    if (req.withCalls !== false && rows.length) {
      const cursor = before === Number.MAX_SAFE_INTEGER ? undefined : this.get('SELECT at FROM messages WHERE seq = ?', before);
      const toAt = cursor ? cursor.at : Number.MAX_SAFE_INTEGER;
      const fromAt = more ? rows[0].at : 0;
      const c = this.callsInRange(taskId, fromAt, toAt);
      out.calls = c.calls;
      out.big = c.big;
    }
    return out;
  }

  /**
   * 一个任务里使用者发的消息（role = user，老的在前），最近 limit 条。页面只常驻每个任务的尾部窗口（启动时 4–80 条），
   * 更早的「补充说明」不在 task.messages 里；计划 / 执行的提示词要用全部的，所以单独提供这条查询（不改翻页游标）.
   */
  userMessages(req) {
    const taskId = str(req.taskId, 80);
    const limit = Math.max(1, Math.min(num(req.limit, 60), 200));
    const rows = this.all("SELECT id, at, text FROM messages WHERE task_id = ? AND role = 'user' ORDER BY seq DESC LIMIT ?", taskId, limit);
    return { messages: rows.reverse().map((r) => ({ id: r.id, at: r.at, text: r.text })) };
  }

  /* ── 全文检索 ── */

  /**
   * 搜消息正文。返回命中（相关度排序）：消息 id、任务、时间、带命中位置的摘录。
   * @param {{ q: string, limit?: number, offset?: number, taskId?: string }} req
   */
  search(req) {
    const match = ftsQuery(req.q);
    if (!match) return { hits: [], query: '' };
    const limit = Math.max(1, Math.min(num(req.limit, 30), 200));
    const offset = Math.max(0, num(req.offset, 0));
    const rows = req.taskId
      ? this.all(
        `SELECT m.id, m.task_id, m.run_id, m.role, m.at, m.text, t.title FROM msg_fts
         JOIN messages m ON m.seq = msg_fts.rowid LEFT JOIN tasks t ON t.id = m.task_id
         WHERE msg_fts MATCH ? AND m.task_id = ? ORDER BY msg_fts.rank LIMIT ? OFFSET ?`, match, String(req.taskId), limit, offset)
      : this.all(
        `SELECT m.id, m.task_id, m.run_id, m.role, m.at, m.text, t.title FROM msg_fts
         JOIN messages m ON m.seq = msg_fts.rowid LEFT JOIN tasks t ON t.id = m.task_id
         WHERE msg_fts MATCH ? ORDER BY msg_fts.rank LIMIT ? OFFSET ?`, match, limit, offset);
    const needles = String(req.q).trim().split(/\s+/).filter(Boolean).map((s) => s.toLowerCase());
    const hits = rows.map((r) => {
      const lower = r.text.toLowerCase();
      let at = -1;
      let len = 0;
      for (const n of needles) { const i = lower.indexOf(n); if (i >= 0 && (at < 0 || i < at)) { at = i; len = n.length; } }
      const from = Math.max(0, (at < 0 ? 0 : at) - 24);
      const to = Math.min(r.text.length, from + 120);
      return {
        messageId: r.id, taskId: r.task_id, runId: r.run_id ?? undefined, role: r.role, at: r.at, taskTitle: r.title ?? '',
        snippet: `${from > 0 ? '…' : ''}${r.text.slice(from, to)}${to < r.text.length ? '…' : ''}`,
        hitStart: at < 0 ? -1 : at - from + (from > 0 ? 1 : 0), hitLength: at < 0 ? 0 : len,
      };
    });
    return { hits, query: match };
  }

  /* ── 事件 ── */

  /** 事件日志查询（归来简的数字要能追到这里）。 */
  events(req = {}) {
    const limit = Math.max(1, Math.min(num(req.limit, 200), 5000));
    const since = num(req.since, 0);
    const rows = req.runId
      ? this.all('SELECT id, at, run_id, kind, level, text, ref_id FROM events WHERE run_id = ? AND at >= ? ORDER BY at DESC, seq DESC LIMIT ?', String(req.runId), since, limit)
      : this.all('SELECT id, at, run_id, kind, level, text, ref_id FROM events WHERE at >= ? ORDER BY at DESC, seq DESC LIMIT ?', since, limit);
    return rows.reverse().map((e) => this.eventFromRow(e));
  }

  /* ── 用量 ── */

  usageEnabled() { return this.kvGet('usage.enabled') !== '0'; }
  setUsageEnabled(on) { this.kvSet('usage.enabled', on ? '1' : '0'); }

  /**
   * 记一个结束的回合。只存数字与 id，不存任何内容。关着开关时什么都不做。
   * @returns {{ recorded: boolean }}
   */
  usageAdd(rec) {
    if (!this.usageEnabled()) return { recorded: false };
    const at = num(rec.at, Date.now());
    const input = Math.max(0, Math.round(num(rec.inputTokens)));
    const output = Math.max(0, Math.round(num(rec.outputTokens)));
    const cached = Math.max(0, Math.round(num(rec.cachedTokens)));
    const cost = typeof rec.costUsd === 'number' && Number.isFinite(rec.costUsd) && rec.costUsd >= 0 ? rec.costUsd : null;
    const taskId = str(rec.taskId, 80);
    const runId = rec.runId ? str(rec.runId, 80) : null;
    const dedupe = `${taskId}|${runId ?? ''}|${at}|${input}|${output}|${cached}`;
    const r = this.run(
      `INSERT OR IGNORE INTO usage(at, task_id, run_id, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd, cost_estimated, duration_ms, dedupe)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      at, taskId, runId, str(rec.provider, 32) || 'unknown', rec.model ? str(rec.model, 120) : null, input, output, cached, cost,
      rec.costEstimated || cost === null ? 1 : 0, typeof rec.durationMs === 'number' && Number.isFinite(rec.durationMs) ? Math.round(rec.durationMs) : null, dedupe,
    );
    return { recorded: Number(r.changes) > 0 };
  }

  /** 今日 / 本周（周一起，本地时间）。costUsd 只加有数字的；窗口里有任何未知或估算的成本 → estimated。 */
  usageSummary(now = Date.now()) {
    const day0 = startOfDay(now);
    const week0 = startOfWeek(now);
    const agg = (since) => {
      const r = this.get(
        `SELECT COUNT(*) AS turns, COALESCE(SUM(input_tokens + output_tokens), 0) AS tokens, ROUND(SUM(cost_usd), 6) AS cost,
                COALESCE(SUM(CASE WHEN cost_usd IS NULL OR cost_estimated = 1 THEN 1 ELSE 0 END), 0) AS guessed
         FROM usage WHERE at >= ? AND at <= ?`, since, now + 60_000);
      const o = { tokens: Number(r.tokens), turns: Number(r.turns) };
      if (r.cost !== null && r.cost !== undefined) o.costUsd = Number(r.cost);
      return { o, guessed: Number(r.guessed) > 0 };
    };
    const t = agg(day0);
    const w = agg(week0);
    return { today: t.o, week: w.o, estimated: w.guessed || t.guessed };
  }

  /** 最近的用量行（调试与「用量记录」列表用）。 */
  usageList(limit = 100) {
    return this.all(
      `SELECT at, task_id, run_id, provider, model, input_tokens, output_tokens, cached_tokens, cost_usd, cost_estimated, duration_ms
       FROM usage ORDER BY at DESC, seq DESC LIMIT ?`, Math.max(1, Math.min(num(limit, 100), 1000)),
    ).map((r) => ({
      at: r.at, taskId: r.task_id, runId: r.run_id ?? undefined, provider: r.provider, model: r.model ?? undefined,
      inputTokens: r.input_tokens, outputTokens: r.output_tokens, cachedTokens: r.cached_tokens,
      costUsd: r.cost_usd ?? undefined, costEstimated: r.cost_estimated === 1 ? true : undefined, durationMs: r.duration_ms ?? undefined,
    }));
  }

  usageClear() {
    const n = this.get('SELECT COUNT(*) AS n FROM usage').n;
    this.run('DELETE FROM usage');
    return { removed: Number(n) };
  }

  /* ── 旧数据导入（localStorage 的 alight/v1 与萤火的 firefly-harness/v1） ── */

  /** 把旧版整份 blob 导进来（一个事务）。重复导入同一份是幂等的。 */
  importLegacy(blob, from = 'localStorage') {
    const tasks = blob && typeof blob.tasks === 'object' && blob.tasks ? blob.tasks : {};
    const runs = blob && typeof blob.runs === 'object' && blob.runs ? blob.runs : {};
    const counts = { tasks: 0, messages: 0, runs: 0, toolCalls: 0, events: 0 };
    this.tx(() => {
      for (const task of Object.values(tasks)) {
        if (!task || typeof task !== 'object' || !task.id) continue;
        this.upsertTask(task);
        counts.tasks += 1;
        for (const m of Array.isArray(task.messages) ? task.messages : []) {
          if (!m || !m.id) continue;
          this.upsertMessage(task.id, m);
          counts.messages += 1;
        }
      }
      for (const run of Object.values(runs)) {
        if (!run || typeof run !== 'object' || !run.id || !run.taskId || !tasks[run.taskId]) continue;
        this.upsertRun(run);
        counts.runs += 1;
        for (const c of Array.isArray(run.toolCalls) ? run.toolCalls : []) { this.upsertToolCall({ ...c, runId: run.id, taskId: run.taskId }); counts.toolCalls += 1; }
        for (const a of Array.isArray(run.artifacts) ? run.artifacts : []) this.upsertArtifact({ ...a, runId: run.id, taskId: run.taskId });
        for (const l of Array.isArray(run.terminal) ? run.terminal : []) this.upsertTerminal({ ...l, runId: run.id });
      }
      for (const e of Array.isArray(blob && blob.events) ? blob.events : []) { this.insertEvent(e); counts.events += 1; }
      if (Array.isArray(blob && blob.taskOrder)) this.kvSet('taskOrder', JSON.stringify(blob.taskOrder.filter((id) => tasks[id])));
      this.kvSet('legacy.imported', JSON.stringify({ at: Date.now(), from, counts }));
    });
    return counts;
  }

  legacyImported() { return parse(this.kvGet('legacy.imported'), null); }

  /* ── 备份与体检 ── */

  /**
   * VACUUM INTO 备份到一个新文件（已存在则拒绝，绝不覆盖）。备份完用只读连接做 quick_check 并数一遍任务。
   * 注意：这是一次同步的整库拷贝，库很大时会占住主进程几秒。
   */
  backup(dest) {
    if (!path.isAbsolute(dest)) throw new Error('备份路径必须是绝对路径');
    if (fs.existsSync(dest)) throw new Error('目标文件已存在，不会覆盖');
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const started = Date.now();
    let tasks = -1;
    try {
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)');
      this.run('VACUUM INTO ?', dest);
      const check = new AlightDb(dest, { readOnly: true });
      let quick = 'unknown';
      try {
        quick = check.get('PRAGMA quick_check').quick_check;
        tasks = check.get('SELECT COUNT(*) AS n FROM tasks').n;
      } finally { check.close(); }
      if (quick !== 'ok') throw new Error(`备份没通过自检：${quick}`);
    } catch (e) {
      // 入口已经确认 dest 原先不存在，这里留下的半截 / 0 字节文件一定是这次写的：删掉。
      // （VACUUM INTO 中途失败——目标盘拔出、写满——SQLite 不会替我们删。留着的话，下一次会撞上 code=exists，
      //   被当成一个现成的库去「改用」；备份列表也会把它当成有效备份.）
      for (const suffix of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(dest + suffix, { force: true }); } catch { /* 删不掉就算了 */ } }
      throw e;
    }
    return { path: dest, bytes: fs.statSync(dest).size, tasks: Number(tasks), ms: Date.now() - started };
  }

  /** 整理（VACUUM）：回收删除任务后留下的空闲页。需要和库一样大的临时空间。 */
  compact() {
    const before = this.fileBytes();
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');
    return { before, after: this.fileBytes() };
  }

  fileBytes() {
    let n = 0;
    for (const suffix of ['', '-wal', '-shm']) { try { n += fs.statSync(this.file + suffix).size; } catch { /* 没有 */ } }
    return n;
  }

  /** 清空任务记录（保留偏好与用量；clearUsage 另行清）。 */
  eraseTasks() {
    this.tx(() => {
      this.run('DELETE FROM tasks');
      this.run('DELETE FROM events');
      this.kvDelete('taskOrder');
    });
  }

  /** light：启动时用，不数各表行数（大库上数一遍也要几十毫秒）。 */
  status(light = false) {
    const n = (t) => (light ? 0 : Number(this.get(`SELECT COUNT(*) AS n FROM ${t}`).n));
    return {
      schema: SCHEMA_VERSION,
      sqlite: this.get('SELECT sqlite_version() AS v').v,
      file: this.file,
      bytes: this.fileBytes(),
      counts: { tasks: n('tasks'), messages: n('messages'), runs: n('runs'), toolCalls: n('tool_calls'), events: n('events'), usage: n('usage') },
      legacy: this.legacyImported(),
      usageEnabled: this.usageEnabled(),
    };
  }
}

module.exports = {
  AlightDb, SCHEMA_VERSION, OUTPUT_INLINE_MAX, OUTPUT_SUMMARY_LEN, OPEN_STATUSES, FIELD_MAX,
  segment, ftsQuery, startOfDay, startOfWeek, summarize, capText,
};
