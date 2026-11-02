// 工作区信任阶梯（V0α · 模块 B5「安全」，G01 最小集）。
//
//   T0 受限      新目录默认：只读（读文件、问答），不写入、不运行命令、不读仓库自带的 hooks / MCP / 技能配置。
//   T1 我的目录  用户在确认框里点了「这是我自己的目录」：按所选权限模式写文件、运行命令；
//                仓库里“可执行”的配置（项目 MCP、hooks、env、apiKeyHelper、技能的 allowed-tools）依旧不加载（那是 T2，V0β）。
//   T2 完全信任  V0β：在 T1 上逐项批准。V0α 只认存盘里已有的 T2 记录，不提供授予入口。
//
// 信任键 = realpath(git 顶层)，无仓库时用目录本身（见 git.cjs 的 detectRepoSync，自己探测 .git，不信宿主的 isGitRepo）：
//   · 仓库里的任意子目录 → 同一个键（信任的是整个仓库）；
//   · linked worktree → 主仓库的键（必须通过 .git/worktrees 的回指校验，不能靠写个 .git 文件冒充）；
//   · 非仓库目录 → 它自己，不向子目录继承（“按子目录列出”）；
//   · 主目录 / 磁盘根上的 .git 不算仓库顶层，也不允许被授予信任（范围太大）。
// 存于 <userData>/trust.json；文件损坏时一律按 T0 处理（不放行），下一次写入前把坏文件改名备份。
// 例外：栖枝自己新建的「练习目录」（<userData>/workspaces/ 之下，selfRoots）一律是 T1——它们是应用自己建的空文件夹、可丢弃，
//   每次新任务都弹确认框没有意义；这些目录不进 trust.json，也不在设置里的“信任的目录”列表里出现。
//
// 第三方克隆的识别规则（命中任一即 suspect=true；界面据此默认只读、要求用户额外勾一下确认；主进程授予时也会核对 acknowledged）：
//   R1 vendor-path     目录的真实路径里有 vendor / third_party / third-party / thirdparty / node_modules / site-packages / bower_components 这一段；
//   R2 foreign-remote  目录自己是 git 仓库、有远端，而这些远端的 host/owner 都不在“我的账号”清单里。
//                      清单来自 trust.json 的 owners：每次授予 T1 时自动记下该仓库远端的 host/owner，也可手写。
//                      清单为空时无从判断，此条不触发；本地路径远端不触发；账号口令会先从 URL 里剥掉再显示；
//   R3 exec-config     仓库带可执行配置：.git/config 里的 core.fsmonitor / core.hooksPath / core.sshCommand / filter.*.clean|smudge|process /
//                      diff.*.textconv|command / merge.*.driver / include / alias 里的 ! 命令 / credential.helper 等，
//                      .git/hooks 里有非 .sample 的钩子，.mcp.json 里有服务器，.claude/settings*.json 里有 hooks / env / apiKeyHelper /
//                      statusLine / mcpServers…，.claude/hooks 目录，.codex/config.toml。
//   DESIGN §3.6.1 的第 1 条（“历史会话里从未出现”）不在这里判：对一个新建项目它必然成立，只在首次启动页的批量扫描里有意义，
//   需要存储层的会话数据，留给 V0β。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const git = require('./git.cjs');

const IS_WIN = process.platform === 'win32';
const CASE_INSENSITIVE = IS_WIN || process.platform === 'darwin';

const VENDOR_SEGMENTS = new Set(['vendor', 'third_party', 'third-party', 'thirdparty', 'node_modules', 'site-packages', 'bower_components']);
/** git 配置里“会执行命令”的键（section.key，子段名不参与匹配） */
const EXEC_GIT_KEYS = new Set([
  'core.fsmonitor', 'core.hookspath', 'core.sshcommand', 'core.editor', 'core.pager', 'core.askpass', 'core.gitproxy',
  'credential.helper', 'diff.external', 'gpg.program', 'sequence.editor', 'uploadpack.packobjectshook',
  'filter.clean', 'filter.smudge', 'filter.process', 'diff.textconv', 'diff.command', 'merge.driver', 'mergetool.cmd', 'difftool.cmd',
]);
const CLAUDE_EXEC_KEYS = ['hooks', 'env', 'apiKeyHelper', 'statusLine', 'mcpServers', 'enableAllProjectMcpServers', 'enabledMcpjsonServers',
  'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper', 'fileSuggestion'];

/* ───────────── 路径与键 ───────────── */

const caseKey = (p) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

/** 范围太大、不能整体信任的目录：磁盘根、用户主目录、Windows 目录、Program Files、ProgramData. */
function isRootLike(dir) {
  const real = git.realpath(dir) || dir;
  if (git.isBroadDir(real)) return true;
  if (IS_WIN) {
    for (const v of [process.env.SystemRoot, process.env.windir, process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData]) {
      if (v && git.samePath(real, v)) return true;
    }
  }
  return false;
}

function vendorSegment(real) {
  for (const seg of real.split(/[\\/]+/)) if (VENDOR_SEGMENTS.has(seg.toLowerCase())) return seg;
  return null;
}

/* ───────────── 可执行配置扫描（只读文件文本） ───────────── */

function readJson(file) {
  const text = git.readSmall(file, 262144);
  if (!text.trim()) return { empty: true };
  try { return { value: JSON.parse(text) }; } catch { return { broken: true }; }
}

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

/**
 * @param {{ workDirs: string[], repo?: object | null }} where  要扫的工作目录（仓库顶层与所选目录，去重）与 detectRepoSync 的结果
 * @returns {string[]} 简短说明，例如 ".git/config：core.fsmonitor"
 */
function execConfigFindings(where) {
  const found = [];
  const repo = where.repo && where.repo.isRepo ? where.repo : null;
  const commonDir = repo ? repo.commonDir : null;
  if (commonDir) {
    const keys = new Set();
    // 键值以 git 自己的解析结果为准（自己解析会被超长文件 / 同行多段头 / 注释续行绕过）；git 解析不了、文件过大都当作“有可执行配置”.
    const cfg = where.config || git.repoConfigEntries(repo);
    for (const p of cfg.problems) keys.add(p);
    for (const e of cfg.entries) {
      const k = `${e.section}.${e.key}`;
      if (EXEC_GIT_KEYS.has(k)) {
        // core.fsmonitor = false / true 不是命令
        if (k === 'core.fsmonitor' && (e.value === true || /^(false|true|0|1|no|yes|off|on)$/i.test(String(e.value)))) continue;
        if (k === 'core.hookspath' && !String(e.value).trim()) continue;
        keys.add(e.sub ? `${e.section}.${e.sub}.${e.key}` : k);
      } else if (e.section === 'include' || e.section === 'includeif') keys.add(`${e.section}.${e.key}`);
      else if (e.section === 'alias' && typeof e.value === 'string' && e.value.startsWith('!')) keys.add(`alias.${e.key}`);
    }
    if (keys.size) found.push(`.git/config：${[...keys].slice(0, 5).join('、')}${keys.size > 5 ? ` 等 ${keys.size} 项` : ''}`);
    try {
      const hooks = fs.readdirSync(path.join(commonDir, 'hooks')).filter((n) => !n.endsWith('.sample') && isFile(path.join(commonDir, 'hooks', n)));
      if (hooks.length) found.push(`.git/hooks：${hooks.slice(0, 4).join('、')}`);
    } catch { /* no hooks dir */ }
  }
  for (const workDir of where.workDirs) {
    const mcp = path.join(workDir, '.mcp.json');
    if (isFile(mcp)) {
      const r = readJson(mcp);
      if (r.broken) found.push('.mcp.json：无法解析');
      else if (!r.empty) {
        const n = r.value && typeof r.value === 'object' && r.value.mcpServers && typeof r.value.mcpServers === 'object' ? Object.keys(r.value.mcpServers).length : 0;
        if (n) found.push(`.mcp.json：${n} 个 MCP 服务器`);
      }
    }
    for (const name of ['settings.json', 'settings.local.json']) {
      const f = path.join(workDir, '.claude', name);
      if (!isFile(f)) continue;
      const r = readJson(f);
      if (r.broken) { found.push(`.claude/${name}：无法解析`); continue; }
      if (r.empty || !r.value || typeof r.value !== 'object') continue;
      const hit = CLAUDE_EXEC_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(r.value, k));
      if (hit.length) found.push(`.claude/${name}：${hit.join('、')}`);
    }
    if (isDir(path.join(workDir, '.claude', 'hooks'))) found.push('.claude/hooks');
    if (isFile(path.join(workDir, '.codex', 'config.toml'))) found.push('.codex/config.toml');
  }
  return found;
}

/** 目录的“第三方克隆”嫌疑. @returns {{ suspect: boolean, reasons: Array<{ code: string, detail: string, items?: string[] }> }} */
function classify({ base, real, repo, owners }) {
  const reasons = [];
  const seg = vendorSegment(base);
  if (seg) reasons.push({ code: 'vendor-path', detail: seg });
  const config = repo && repo.isRepo ? git.repoConfigEntries(repo) : null;
  if (config) {
    const remotes = [];
    for (const e of config.entries) {
      if (e.section === 'remote' && e.key === 'url' && typeof e.value === 'string') { const d = git.describeRemote(e.value); if (d) remotes.push(d); }
    }
    const judged = remotes.filter((d) => d.host && d.owner);
    const known = new Set((owners || []).map((o) => String(o).toLowerCase()));
    if (judged.length && known.size && !judged.some((d) => known.has(`${d.host}/${d.owner}`))) {
      reasons.push({ code: 'foreign-remote', detail: judged[0].display, items: [...new Set(judged.map((d) => d.display))].slice(0, 4) });
    }
  }
  const workDirs = [...new Set([base, real].map((d) => caseKey(path.resolve(d))))].map((k) => [base, real].find((d) => caseKey(path.resolve(d)) === k));
  const exec = execConfigFindings({ workDirs, repo, config });
  if (exec.length) reasons.push({ code: 'exec-config', detail: exec[0], items: exec.slice(0, 6) });
  return { suspect: reasons.length > 0, reasons };
}

/* ───────────── 存储 ───────────── */

const EMPTY = () => ({ version: 1, entries: {}, owners: [] });

function cleanData(raw) {
  const data = EMPTY();
  if (raw && typeof raw === 'object') {
    if (raw.entries && typeof raw.entries === 'object') {
      for (const [key, e] of Object.entries(raw.entries)) {
        if (!key || !e || typeof e !== 'object') continue;
        if (e.level !== 'T1' && e.level !== 'T2') continue;
        data.entries[key] = {
          level: e.level,
          dir: typeof e.dir === 'string' ? e.dir : key,
          grantedAt: Number(e.grantedAt) || 0,
          isRepo: !!e.isRepo,
          ...(typeof e.remote === 'string' ? { remote: e.remote } : {}),
        };
      }
    }
    if (Array.isArray(raw.owners)) data.owners = raw.owners.filter((o) => typeof o === 'string' && o.length < 200).slice(0, 200);
  }
  return data;
}

/**
 * 信任存储。file 可以是路径或返回路径的函数（默认实例用 Electron 的 userData，测试用临时文件）.
 */
function createTrustStore(fileOrGetter, opts = {}) {
  const getFile = typeof fileOrGetter === 'function' ? fileOrGetter : () => fileOrGetter;
  /** 应用自己建的练习目录的根（默认实例是 <userData>/workspaces）. */
  const selfRoots = () => {
    try {
      const r = typeof opts.selfRoots === 'function' ? opts.selfRoots() : opts.selfRoots;
      return (Array.isArray(r) ? r : []).filter((x) => typeof x === 'string' && x);
    } catch { return []; }
  };
  /** real 是不是在某个练习目录根「之下」（根本身不算）. */
  function inSelfRoot(real) {
    const b = caseKey(path.resolve(real));
    for (const root of selfRoots()) {
      const a = caseKey(path.resolve(git.realpath(root) || root));
      if (b !== a && b.startsWith(a.endsWith(path.sep) ? a : a + path.sep)) return true;
    }
    return false;
  }

  function read() {
    const file = getFile();
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
      if (e && e.code === 'ENOENT') return { ok: true, data: EMPTY() };
      return { ok: false, corrupt: false, reason: String(e && e.message) };
    }
    try { return { ok: true, data: cleanData(JSON.parse(text)) }; } catch { return { ok: false, corrupt: true, reason: '信任记录文件已损坏' }; }
  }

  function write(data) {
    const file = getFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const body = JSON.stringify(data, null, 2);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      // 个别机器上 AppData 被过滤驱动重定向，rename 会失败（EXDEV / EPERM）：原地写。
      try { fs.writeFileSync(file, body, 'utf8'); } finally { try { fs.unlinkSync(tmp); } catch { /* leave it */ } }
    }
  }

  /** 把目录解析成 { real, repo, key, scope }；目录不存在时 real 为 null. */
  function resolve(dir) {
    if (typeof dir !== 'string' || !dir || dir.length > 2000 || dir.includes('\0') || !path.isAbsolute(dir)) return { ok: false, error: '需要一个绝对路径的目录。', code: 'BAD_PATH' };
    const real = git.realpath(dir);
    if (!real || !isDir(real)) return { ok: false, error: '这个目录不存在。', code: 'NOT_FOUND', exists: false };
    const repo = git.detectRepoSync(real);
    const base = repo.isRepo ? repo.top : real;
    const baseReal = git.realpath(base) || base;
    return { ok: true, real, repo, base: baseReal, key: caseKey(path.resolve(baseReal)), scope: repo.isRepo ? 'repo' : 'dir' };
  }

  function levelOf(dir) {
    const r = resolve(dir);
    if (!r.ok) return 'T0';
    if (inSelfRoot(r.real)) return 'T1';
    const s = read();
    if (!s.ok) return 'T0';
    const e = s.data.entries[r.key];
    return e ? e.level : 'T0';
  }

  /** 给界面用的完整判断：级别、仓库范围、第三方克隆嫌疑. */
  function inspect(dir) {
    const r = resolve(dir);
    if (!r.ok) return { dir: typeof dir === 'string' ? dir : '', key: '', level: 'T0', exists: false, isRepo: false, scope: 'dir', suspect: false, reasons: [], rootLike: false, error: r.error };
    if (inSelfRoot(r.real)) return { dir: r.real, key: r.key, level: 'T1', exists: true, isRepo: false, scope: 'dir', practice: true, suspect: false, reasons: [], rootLike: false };
    const s = read();
    const e = s.ok ? s.data.entries[r.key] : undefined;
    const cls = classify({ base: r.base, real: r.real, repo: r.repo, owners: s.ok ? s.data.owners : [] });
    return {
      dir: r.real,
      key: r.key,
      level: e ? e.level : 'T0',
      exists: true,
      isRepo: !!r.repo.isRepo,
      scope: r.scope,
      ...(r.repo.isRepo ? { top: r.base, kind: r.repo.kind } : {}),
      suspect: cls.suspect,
      reasons: cls.reasons,
      rootLike: isRootLike(r.real),
      ...(s.ok ? {} : { storeError: s.reason }),
    };
  }

  /**
   * 授予信任。V0α 只开放 T1。
   * 疑似第三方克隆必须带 acknowledged:true（界面上额外的勾选），否则拒绝.
   */
  function grant(dir, level = 'T1', opts = {}) {
    if (level !== 'T1') return { ok: false, error: level === 'T2' ? '完全信任（T2）要逐项批准，后续版本才开放。' : '只能授予「我的目录」（T1）。', code: 'BAD_LEVEL' };
    const r = resolve(dir);
    if (!r.ok) return { ok: false, error: r.error, code: r.code };
    if (isRootLike(r.real) || isRootLike(r.base)) return { ok: false, error: '这个目录范围太大（磁盘根或用户主目录），请选具体的项目目录。', code: 'TOO_BROAD' };
    const info = inspect(dir);
    if (info.suspect && !(opts && opts.acknowledged === true)) return { ok: false, error: '这个目录看起来是别处克隆来的，需要先确认。', code: 'NEEDS_ACK', reasons: info.reasons };
    let s = read();
    let backup;
    if (!s.ok) {
      if (!s.corrupt) return { ok: false, error: `读不了信任记录：${s.reason}`, code: 'STORE_READ' };
      backup = `${getFile()}.corrupt-${Date.now()}`;
      try { fs.renameSync(getFile(), backup); } catch (e) { return { ok: false, error: `信任记录已损坏，且无法备份：${e.message}`, code: 'STORE_CORRUPT' }; }
      s = { ok: true, data: EMPTY() };
    }
    const data = s.data;
    const remotes = [];
    if (r.repo.isRepo) {
      for (const e of git.repoConfigEntries(r.repo).entries) {
        if (e.section === 'remote' && e.key === 'url' && typeof e.value === 'string') { const d = git.describeRemote(e.value); if (d) remotes.push(d); }
      }
    }
    const prior = data.entries[r.key];
    data.entries[r.key] = {
      level: prior && prior.level === 'T2' ? 'T2' : 'T1',
      dir: r.base,
      grantedAt: prior ? prior.grantedAt || Date.now() : Date.now(),
      isRepo: !!r.repo.isRepo,
      ...(remotes[0] ? { remote: remotes[0].display } : {}),
    };
    for (const d of remotes) {
      if (d.host && d.owner) { const o = `${d.host}/${d.owner}`; if (!data.owners.includes(o)) data.owners.push(o); }
    }
    try { write(data); } catch (e) { return { ok: false, error: `写不进信任记录：${e.message}`, code: 'STORE_WRITE' }; }
    return { ok: true, key: r.key, level: data.entries[r.key].level, dir: r.base, ...(backup ? { backedUp: backup } : {}) };
  }

  /** 已授予的目录（T1/T2）. */
  function list() {
    const s = read();
    if (!s.ok) return { ok: false, error: s.reason, entries: [] };
    const entries = Object.entries(s.data.entries).map(([key, e]) => ({
      key, dir: e.dir, level: e.level, grantedAt: e.grantedAt, isRepo: e.isRepo, exists: isDir(e.dir), ...(e.remote ? { remote: e.remote } : {}),
    })).sort((a, b) => b.grantedAt - a.grantedAt);
    return { ok: true, entries };
  }

  /** 撤销：参数可以是 list() 给出的 key，也可以是目录路径. */
  function revoke(keyOrDir) {
    const s = read();
    if (!s.ok) return { ok: false, error: s.reason };
    let key = typeof keyOrDir === 'string' && Object.prototype.hasOwnProperty.call(s.data.entries, keyOrDir) ? keyOrDir : null;
    if (!key) { const r = resolve(keyOrDir); if (r.ok && s.data.entries[r.key]) key = r.key; }
    if (!key) return { ok: true, removed: false };
    delete s.data.entries[key];
    try { write(s.data); } catch (e) { return { ok: false, error: `写不进信任记录：${e.message}` }; }
    return { ok: true, removed: true, key };
  }

  return { levelOf, inspect, grant, list, revoke, read, resolve };
}

/* ───────────── 默认实例与 IPC ───────────── */

let defaultStore = null;
function store() {
  if (!defaultStore) {
    const userData = () => require('electron').app.getPath('userData');
    defaultStore = createTrustStore(() => path.join(userData(), 'trust.json'), { selfRoots: () => [path.join(userData(), 'workspaces')] });
  }
  return defaultStore;
}

/** 主进程内同步查询（live.ts 之外的二次校验）：@returns {'T0'|'T1'|'T2'} */
function levelOf(dir) { return store().levelOf(dir); }

/** @param handle 来源检查过的 ipcMain.handle 包装；@param injected 测试用：换掉默认的 userData 存储 */
function register(handle, injected) {
  const st = () => injected || store();
  const str = (v) => (typeof v === 'string' ? v : '');
  handle('trust:level', (_e, dir) => st().inspect(str(dir)));
  handle('trust:grant', (_e, dir, level, opts) => st().grant(str(dir), level === undefined ? 'T1' : level, opts && typeof opts === 'object' ? { acknowledged: opts.acknowledged === true } : {}));
  handle('trust:list', () => st().list());
  handle('trust:revoke', (_e, keyOrDir) => st().revoke(str(keyOrDir)));
}

module.exports = { register, levelOf, createTrustStore, classify, execConfigFindings, isRootLike, vendorSegment, VENDOR_SEGMENTS };
