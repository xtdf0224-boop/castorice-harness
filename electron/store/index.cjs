// 存储层（V0α · 模块 B2「存储」）。
// SQLite（node:sqlite）会话库 + append-only 事件日志 + FTS5 + VACUUM INTO 备份；任务级用量 usage（只存数字）。
// 页面通过 desktop.call('store:…' / 'usage:…') 调用（见 src/lib/storeBridge.ts）；通道在 register(handle) 里登记，
// handle 已做来源检查（只有栖枝自己的页面能调）。每个处理器返回 { ok: true, … } 或 { ok: false, error }，不抛异常。
// 库逻辑在 db.cjs，目录逻辑在 dirs.cjs（两者都不依赖 electron，可以在 Node 里直接测）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, dialog, shell, BrowserWindow } = require('electron');
const { AlightDb } = require('./db.cjs');
const dirs = require('./dirs.cjs');

/** @type {AlightDb | null} */
let db = null;
let where = { dir: '', source: 'default' };

function userData() { return app.getPath('userData'); }

/** 懒打开：第一次有人要用时才开（启动不被拖慢）。打不开就抛，调用方得到 { ok: false, error }。 */
function open() {
  if (db) return db;
  const resolved = dirs.resolveDataDir({ userData: userData() });
  fs.mkdirSync(resolved.dir, { recursive: true });
  const opened = new AlightDb(path.join(resolved.dir, dirs.DB_FILE));
  db = opened;
  where = resolved;
  return opened;
}

function close() {
  if (!db) return;
  const d = db;
  db = null;
  d.close();
}

/** 参数检查：必须是普通对象。 */
function obj(v, what) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${what} 参数不对`);
  return v;
}

function snapshotInfo(light) {
  const d = open();
  return {
    dataDir: where.dir,
    dbFile: d.file,
    source: where.source,
    warning: where.warning,
    configured: where.configured,
    envLocked: where.source === 'env' || !!(process.env.ALIGHT_DATA_DIR && process.env.ALIGHT_DATA_DIR.trim()),
    defaultDir: userData(),
    disk: reportWithApproval(where.dir),
    ...d.status(!!light),
  };
}

/* 页面能让主进程写盘的路径只有两类：用户在系统选择框里亲手选的文件夹（store:pick-dir 的结果），和主进程自己给出的建议
   （store:disk 的 suggestions、默认位置）。set-dir / backup 只认这些（及其子目录）：页面即使被带偏，
   也没法让备份或数据库落到它自己编的路径（比如网络共享 \\主机\共享）。 */
const approvedDirs = new Set();
const normDir = (p) => { const r = path.resolve(String(p)); return process.platform === 'win32' ? r.toLowerCase() : r; };
function approveDir(p) { if (typeof p === 'string' && p && path.isAbsolute(p)) approvedDirs.add(normDir(p)); }
function isApprovedDir(p) {
  if (typeof p !== 'string' || !p || !path.isAbsolute(p)) return false;
  const n = normDir(p);
  for (const a of approvedDirs) if (n === a || n.startsWith(a.endsWith(path.sep) ? a : a + path.sep)) return true;
  return false;
}
function reportWithApproval(dir) {
  const rep = dirs.report(dir);
  for (const s of rep.suggestions || []) approveDir(s.dir);
  return rep;
}

function register(handle) {
  approveDir(userData());
  /** 登记一个通道：参数原样传入，结果包成 { ok: true, … }；任何异常变成 { ok: false, error }。 */
  const on = (channel, fn) => handle(channel, async (e, ...args) => {
    try {
      const r = await fn(e, ...args);
      return r && typeof r === 'object' && !Array.isArray(r) && 'ok' in r ? r : { ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : { value: r }) };
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), code: err && err.code };
    }
  });

  /* ── 启动、读 ── */
  on('store:status', (_e, opts) => snapshotInfo(!!(opts && typeof opts === 'object' && opts.light)));
  on('store:load', (_e, opts) => open().load(opts && typeof opts === 'object' ? opts : {}));
  on('store:page', (_e, req) => open().page(obj(req, 'page')));
  on('store:user-messages', (_e, req) => open().userMessages(obj(req, 'user-messages')));
  on('store:calls', (_e, req) => {
    const r = obj(req, 'calls');
    return open().callsInRange(String(r.taskId), Number(r.fromAt) || 0, Number(r.toAt) || Number.MAX_SAFE_INTEGER, Number(r.limit) || 1500);
  });
  on('store:run', (_e, req) => {
    const r = obj(req, 'run');
    return open().loadRun(String(r.runId), { terminalTail: r.terminalTail });
  });
  on('store:output', (_e, callId) => open().output(String(callId)));
  on('store:search', (_e, req) => open().search(obj(req, 'search')));
  on('store:events', (_e, req) => ({ events: open().events(req && typeof req === 'object' ? req : {}) }));

  /* ── 写 ── */
  on('store:save', (_e, batch) => open().save(obj(batch, 'save')));
  on('store:import', (_e, req) => {
    const r = obj(req, 'import');
    const d = open();
    const already = d.legacyImported();
    if (already && !r.force) return { counts: already.counts, already: true };
    return { counts: d.importLegacy(obj(r.blob, 'import.blob'), typeof r.from === 'string' ? r.from.slice(0, 80) : 'localStorage'), already: false };
  });
  on('store:mark-legacy', (_e, req) => {
    // 没有旧数据可迁时也打上标记，下次启动不再检查。
    const d = open();
    if (!d.legacyImported()) d.kvSet('legacy.imported', JSON.stringify({ at: Date.now(), from: String(obj(req, 'mark').from || 'none').slice(0, 80), counts: { tasks: 0, messages: 0, runs: 0, toolCalls: 0, events: 0 } }));
    return {};
  });

  /* ── 小开关 ── */
  on('store:kv-get', (_e, key) => {
    if (!/^[a-z][\w.-]{0,40}$/.test(String(key))) throw new Error('键名不合法');
    return { value: open().kvGet(String(key)) ?? null };
  });
  on('store:kv-set', (_e, key, value) => {
    if (!/^[a-z][\w.-]{0,40}$/.test(String(key))) throw new Error('键名不合法');
    const v = String(value ?? '');
    if (v.length > 65536) throw new Error('值太长');
    open().kvSet(String(key), v);
    return {};
  });

  /* ── 数据目录、空间、备份 ── */
  on('store:disk', () => ({ dataDir: where.dir || (open(), where.dir), disk: reportWithApproval(where.dir) }));

  on('store:pick-dir', async (e, start) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const defaultPath = typeof start === 'string' && start && fs.existsSync(start) ? start : (where.dir || userData());
    const opts = { title: '选择栖枝的数据目录', defaultPath, properties: ['openDirectory', 'createDirectory'] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const picked = r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
    if (picked) approveDir(picked);
    return { dir: picked };
  });

  on('store:set-dir', (_e, req) => {
    const r = obj(req, 'set-dir');
    if (process.env.ALIGHT_DATA_DIR && process.env.ALIGHT_DATA_DIR.trim()) throw new Error('数据目录由环境变量 ALIGHT_DATA_DIR 指定，在这里改不了。');
    // 相对路径交给 moveData（bad-path）；绝对路径必须是选择框选的或界面给的建议
    if (path.isAbsolute(String(r.dir || '')) && !isApprovedDir(String(r.dir))) throw new Error('只能改到你在选择框里选的文件夹，或界面给出的建议位置。请用「更改位置…」选一下。');
    // 不以 open() 开头：当前库打不开（损坏 / 被更新版本写过）时，界面也得能改走——只在需要复制时才打开它（moveData 里）
    const previous = where.dir || dirs.resolveDataDir({ userData: userData() }).dir;
    const moved = dirs.moveData({ getDb: open, userData: userData(), target: String(r.dir || ''), useExisting: !!r.useExisting });
    // 旧库原样留在原地；关掉当前连接，下一次调用会打开新位置的库。
    close();
    where = { dir: '', source: 'default' };
    return { dataDir: moved.dir, previous, copied: moved.copied };
  });

  on('store:backup', (_e, req) => {
    const d = open();
    const r = req && typeof req === 'object' ? req : {};
    if (r.dir !== undefined && !isApprovedDir(r.dir)) throw new Error('只能备份到你在选择框里选的文件夹。');
    const folder = typeof r.dir === 'string' && path.isAbsolute(r.dir) ? r.dir : path.join(where.dir, 'backups');
    return d.backup(path.join(folder, dirs.backupName()));
  });
  on('store:backups', () => {
    open();
    const folder = path.join(where.dir, 'backups');
    return { dir: folder, items: dirs.listBackups(folder) };
  });
  on('store:open-dir', async (_e, which) => {
    open();
    const target = which === 'backups' ? path.join(where.dir, 'backups') : where.dir;
    fs.mkdirSync(target, { recursive: true });
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
    return { dir: target };
  });
  on('store:compact', () => open().compact());

  /* ── 用量（task_usage：只有数字） ── */
  on('usage:add', (_e, rec) => open().usageAdd(obj(rec, 'usage')));
  on('usage:summary', () => ({ summary: open().usageSummary(), enabled: open().usageEnabled() }));
  on('usage:enabled', (_e, on2) => {
    const d = open();
    if (typeof on2 === 'boolean') d.setUsageEnabled(on2);
    return { enabled: d.usageEnabled() };
  });
  on('usage:list', (_e, limit) => ({ items: open().usageList(Number(limit) || 100) }));
  on('usage:clear', () => open().usageClear());
}

module.exports = { register, close };
