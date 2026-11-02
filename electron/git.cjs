// 加固的 git 调用（V0α · 模块 B5「安全」，G02）。
//
// 威胁：用户打开的目录可能来自别处（下载的仓库、第三方克隆）。仓库自带的 .git/config 可以设
// core.fsmonitor / filter.*.clean / core.hooksPath 之类的“会执行命令”的键，.git/hooks 里可以放钩子。
// 一次看似无害的 `git status` / `git add -A` 就可能跑起对方的代码。这里的做法：
//
//   1. 永远用绝对路径的 git.exe（自己从 PATH 里的绝对目录找，不让 Windows 先在 cwd 里找 git.exe）。
//   2. 环境清洗：去掉全部 GIT_*，关系统与全局配置（GIT_CONFIG_NOSYSTEM=1、GIT_CONFIG_GLOBAL=NUL），不弹终端提示。
//   3. 命令行固定前缀：-c core.longpaths=true -c core.autocrlf=false -c core.fsmonitor=false -c gc.auto=0
//      -c core.hooksPath=NUL（命令行配置优先于仓库配置），并关掉 maintenance / 签名与 gpg.program / 扩展协议。
//   4. 只放行白名单子命令（管道命令：add → write-tree → commit-tree → update-ref，外加只读查询）；
//      危险选项（--output、--ext-diff、--textconv、--upload-pack…）一律拒绝，diff 类命令自动补 --no-ext-diff --no-textconv。
//   5. 两种模式：
//      A. 私有 GIT_DIR（opts.gitDir，影子仓库 <dataDir>/shadow/<目录哈希>.git）：git 完全不读被打开目录里的 .git/config，
//         写类命令（add / update-index / read-tree / write-tree / commit-tree / update-ref / init）只在这个模式下放行。
//      B. 仓库自带 .git（不给 gitDir）：只放行只读查询；先检查它的配置里有没有 filter.* / include / core.worktree 这类
//         无法用 -c 逐个抵消的键，有就拒绝（GIT_UNSAFE_CONFIG）；加 --no-optional-locks，不改用户的索引。
//         键值取 git 自己的解析结果（`git config --file <config> --list -z`，只读、不跑 filter），不靠自己写的解析器去猜——
//         手写解析器会被超长文件 / 同一行多个段头 / 以反斜杠结尾的注释行绕过；git 解析不了、文件过大都按不安全处理。
//   6. 超时与输出上限；错误不吞：非 0 退出码、超时、超限、找不到 git 都以带 code 的 Error 抛出。
//
// detectRepo 自己探测 .git（不信宿主传来的 isGitRepo），只读文件系统，不启动 git。
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const IS_WIN = process.platform === 'win32';
const NULL_DEVICE = IS_WIN ? 'NUL' : '/dev/null';

function fail(code, message, extra) {
  const err = new Error(message);
  err.code = code;
  if (extra) Object.assign(err, extra);
  return err;
}

/* ───────────── 路径工具 ───────────── */

function realpath(p) {
  try { return (fs.realpathSync.native || fs.realpathSync)(p); } catch { return null; }
}

/** child 是否位于 parent 之内（含相等）。大小写按平台. */
function isInside(child, parent) {
  const a = path.resolve(child);
  const b = path.resolve(parent);
  const rel = path.relative(IS_WIN ? b.toLowerCase() : b, IS_WIN ? a.toLowerCase() : a);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function samePath(a, b) {
  const x = path.resolve(a);
  const y = path.resolve(b);
  return IS_WIN ? x.toLowerCase() === y.toLowerCase() : x === y;
}

function readSmall(file, max = 262144) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(max);
    const n = fs.readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

/* ───────────── git 配置解析（只读文本，不执行任何东西） ───────────── */

/**
 * 最小的 git-config 解析：[section "sub"] key = value，支持 # ; 注释、引号。键名与 section 小写，subsection 保持原样.
 * 这只是 git 自己的解析不可用时的后备（找不到 git），所以刻意往“多报”的方向偏：
 *   · 逐物理行扫描，不做全局续行合并（git 不续行注释，合并会把下一行的段头吞进注释，见 C 类绕过）；
 *   · 段头后面还有别的段头（`[core][filter "evil"]`）就继续按段头解析，直到剩下的不是段头；
 *   · 调用方负责读全文（超过上限按不安全处理，见 readConfigFile），这里不截断.
 * 判断“仓库配置里有没有会执行命令的键”不要靠它：用 repoConfigEntries（git 自己的解析结果）.
 */
function parseGitConfig(text) {
  const entries = [];
  let section = '';
  let sub = null;
  const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/;
  for (const raw of String(text || '').split(/\r?\n/)) {
    let line = raw.trim();
    for (;;) {
      if (!line || line[0] === '#' || line[0] === ';') { line = ''; break; }
      const h = header.exec(line);
      if (!h) break;
      section = h[1].toLowerCase();
      sub = h[2] === undefined ? null : h[2].replace(/\\(.)/g, '$1');
      // 旧写法 [section.sub]
      if (sub === null && section.includes('.')) { const i = section.indexOf('.'); sub = section.slice(i + 1); section = section.slice(0, i); }
      line = line.slice(h[0].length).trim();
    }
    if (!line || !section) continue;
    const kv = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*(.*))?$/.exec(line);
    if (!kv) continue;
    const value = kv[2] === undefined ? true : stripValue(kv[2]);
    entries.push({ section, sub, key: kv[1].toLowerCase(), value });
  }
  return entries;
}

function stripValue(v) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === '\\' && i + 1 < v.length) { out += v[i + 1]; i++; continue; }
    if (c === '"') { quoted = !quoted; continue; }
    if (!quoted && (c === '#' || c === ';')) break;
    out += c;
  }
  return quoted ? out : out.trim();
}

/** 把 URL 里的账号口令去掉，只留 host/owner/repo，供界面显示与比较。无法判断归属（本地路径）时 host 为空. */
function describeRemote(url) {
  const raw = String(url || '').trim();
  if (!raw) return null;
  let host = '';
  let p = '';
  let m;
  if ((m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.*)$/i.exec(raw))) { host = m[1]; p = m[2]; }
  else if ((m = /^(?:[^@/\\]+@)?([^/\\:]+):(?!\/\/)(.*)$/.exec(raw)) && !/^[A-Za-z]$/.test(m[1])) { host = m[1]; p = m[2]; }
  else return { host: '', owner: '', repo: '', display: '（本地路径）' };
  p = p.replace(/\.git\/?$/i, '').replace(/^\/+|\/+$/g, '');
  const parts = p.split('/').filter(Boolean);
  const owner = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
  const repo = parts[parts.length - 1] || '';
  host = host.toLowerCase();
  return { host, owner: owner.toLowerCase(), repo, display: [host, owner, repo].filter(Boolean).join('/') };
}

/* ───────────── 找 git ───────────── */

let cachedGit = null;
/**
 * 解析 git 可执行文件的绝对路径。只看 PATH 里的绝对目录（空项、相对项、'.' 一律跳过），
 * 也跳过位于被操作目录之内的项——Windows 的 CreateProcess 会先在 cwd 里找同名 exe，这里绕开.
 */
function resolveGit(opts = {}) {
  const cacheable = !opts.pathEnv && !opts.cwd && !opts.noCache;
  if (cacheable && cachedGit) return cachedGit;
  const names = IS_WIN ? ['git.exe'] : ['git'];
  const found = (dir) => { for (const n of names) { const f = path.join(dir, n); try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ } } return null; };
  const override = !opts.pathEnv && process.env.ALIGHT_GIT;
  if (override && path.isAbsolute(override)) { try { if (fs.statSync(override).isFile()) return override; } catch { /* fall through */ } }
  const pathEnv = opts.pathEnv !== undefined ? opts.pathEnv : (process.env.PATH ?? process.env.Path ?? '');
  const here = opts.cwd ? path.resolve(opts.cwd) : null;
  const procCwd = path.resolve(process.cwd());
  const dirs = [];
  for (const e of String(pathEnv).split(path.delimiter)) {
    const dir = e.trim().replace(/^"(.*)"$/, '$1');
    if (!dir || !path.isAbsolute(dir)) continue;
    if (samePath(dir, procCwd)) continue;
    if (here && isInside(dir, here)) continue;
    dirs.push(dir);
  }
  if (IS_WIN && opts.pathEnv === undefined) {
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (base) dirs.push(path.join(base, 'Git', 'cmd'), path.join(base, 'Git', 'bin'));
    }
  }
  for (const d of dirs) {
    const f = found(d);
    if (f) { if (cacheable) cachedGit = f; return f; }
  }
  throw fail('GIT_NOT_FOUND', '找不到 git。请安装 Git for Windows，并确认它在系统 PATH 里。');
}

/* ───────────── 探测仓库（不启动 git） ───────────── */

/** 范围太大、不能当“一个项目”的目录：磁盘根、用户主目录. */
function isBroadDir(dir) {
  const real = realpath(dir) || dir;
  const root = path.parse(real).root;
  if (samePath(real, root)) return true;
  for (const home of [os.homedir()]) {
    const h = home && (realpath(home) || home);
    if (h && samePath(real, h)) return true;
  }
  return false;
}

function hasHead(gitDir) {
  try { return fs.statSync(path.join(gitDir, 'HEAD')).isFile(); } catch { return false; }
}

/** 看 dir 里有没有 .git，有就返回仓库信息. */
function probeGitEntry(dir) {
  const g = path.join(dir, '.git');
  let st;
  try { st = fs.lstatSync(g); } catch { return null; }
  if (st.isDirectory()) {
    if (!hasHead(g)) return null; // 不是有效仓库：git 自己也会继续往上找
    return { kind: 'repo', top: dir, workDir: dir, gitDir: g, commonDir: g };
  }
  if (st.isSymbolicLink()) {
    const target = realpath(g);
    if (target && hasHead(target)) return { kind: 'gitfile', top: dir, workDir: dir, gitDir: target, commonDir: target };
    return null;
  }
  if (!st.isFile()) return null;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readSmall(g, 4096));
  if (!m) return null;
  const gitDir = path.resolve(dir, m[1]);
  if (!hasHead(gitDir)) return null;
  const cdText = readSmall(path.join(gitDir, 'commondir'), 4096).trim();
  if (cdText) {
    const commonDir = realpath(path.resolve(gitDir, cdText));
    // 真正的 linked worktree：gitdir 必须在 <common>/worktrees/ 之下，且回指文件指向本目录的 .git。
    // 否则任何人都能写个 .git 文件“声称”自己是你已信任仓库的 worktree 来继承信任。
    if (commonDir && path.basename(commonDir) === '.git' && isInside(gitDir, path.join(commonDir, 'worktrees'))) {
      const back = readSmall(path.join(gitDir, 'gitdir'), 4096).trim();
      if (back && samePath(path.resolve(gitDir, back), g)) {
        return { kind: 'worktree', top: path.dirname(commonDir), workDir: dir, gitDir, commonDir };
      }
    }
    return { kind: 'gitfile', top: dir, workDir: dir, gitDir, commonDir: gitDir };
  }
  // 子模块或 --separate-git-dir：以本目录为顶层
  return { kind: 'gitfile', top: dir, workDir: dir, gitDir, commonDir: gitDir };
}

/**
 * 从 dir 往上找最近的有效 .git。返回 { isRepo, dir, top?, workDir?, gitDir?, commonDir?, kind?, broad? }。
 * top = 信任键用的“仓库顶层”：linked worktree 返回主仓库的顶层；主目录/磁盘根上的 .git 不算（broad=true）.
 */
function detectRepoSync(dir) {
  const out = { isRepo: false };
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return out;
  const real = realpath(dir);
  if (!real) return out;
  try { if (!fs.statSync(real).isDirectory()) return out; } catch { return out; }
  out.dir = real;
  let cur = real;
  for (let depth = 0; depth < 96; depth++) {
    const hit = probeGitEntry(cur);
    if (hit) {
      if (isBroadDir(hit.top) || isBroadDir(hit.workDir)) { out.broad = true; return out; }
      return { isRepo: true, dir: real, ...hit };
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return out;
}

/** @returns {Promise<{ isRepo: boolean, top?: string }>} */
async function detectRepo(dir) { return detectRepoSync(dir); }

/* ───────────── spawnGit ───────────── */

/** 只读查询（两种模式都放行） */
const READ_COMMANDS = new Set([
  'rev-parse', 'rev-list', 'cat-file', 'ls-tree', 'for-each-ref', 'merge-base', 'count-objects', 'var', 'version',
  'log', 'show', 'diff-tree', 'diff', 'diff-index', 'diff-files', 'status', 'ls-files', 'check-ignore',
]);
/** 会写对象库 / 索引 / 引用的管道命令：只在私有 GIT_DIR 模式下放行 */
const WRITE_COMMANDS = new Set(['init', 'add', 'update-index', 'read-tree', 'write-tree', 'commit-tree', 'update-ref', 'symbolic-ref', 'mktree', 'hash-object']);
/** 这些命令会读工作区文件或比较内容：可能触发 filter / textconv / 外部 diff */
const DIFFING = new Set(['diff', 'diff-tree', 'diff-index', 'diff-files', 'show', 'log']);
/** 这些命令会为每个子模块 / 内嵌仓库另起一个 git 去看它有没有改动，那个子进程读的是子模块自己的配置（里面可以有 filter）→ 一律不下钻 */
const SUBMODULE_SPAWNING = new Set(['status', 'diff', 'diff-index', 'diff-files']);

/** 会执行外部程序、写任意文件或改变仓库发现方式的选项 */
const BAD_OPTION = /^--(output|exec|exec-path|upload-pack|receive-pack|open-files-in-pager|ext-diff|textconv|filters|paginate|git-dir|work-tree|namespace|super-prefix|config-env|prompt|show-signature)(=|$)/;
/** log / show / for-each-ref 的 %G? %GG %GS… 占位符会去调用 gpg（gpg.program 来自仓库配置）. */
const GPG_PLACEHOLDER = /%G/;

const MAX_CMDLINE = 30000;

function hardPrefix() {
  return [
    '--no-pager',
    '-c', 'core.longpaths=true',
    '-c', 'core.autocrlf=false',
    '-c', 'core.fsmonitor=false',
    '-c', 'gc.auto=0',
    '-c', `core.hooksPath=${NULL_DEVICE}`,
    '-c', 'maintenance.auto=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgsign=false',
    '-c', `gpg.program=${NULL_DEVICE}`,
    '-c', `gpg.openpgp.program=${NULL_DEVICE}`,
    '-c', `gpg.x509.program=${NULL_DEVICE}`,
    '-c', `gpg.ssh.program=${NULL_DEVICE}`,
    '-c', 'protocol.ext.allow=never',
    '-c', 'user.name=Alight',
    '-c', 'user.email=alight@localhost.invalid',
  ];
}

function cleanEnv(extra) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^GIT_/i.test(k) || v === undefined) continue;
    env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_SYSTEM = NULL_DEVICE;
  env.GIT_CONFIG_GLOBAL = NULL_DEVICE;
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_ATTR_NOSYSTEM = '1';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_PAGER = 'cat';
  env.LC_ALL = 'C';
  return Object.assign(env, extra);
}

/** 仓库自己的配置文件：公共目录的 config，加上 config.worktree（主仓库在公共目录，linked worktree 在它自己的 gitdir）. */
function repoConfigFiles(repo) {
  const seen = new Set();
  const files = [];
  for (const f of [path.join(repo.commonDir, 'config'), path.join(repo.gitDir, 'config.worktree'), path.join(repo.commonDir, 'config.worktree')]) {
    const k = path.resolve(f).toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    files.push(f);
  }
  return files;
}

/** 配置文件读全文的上限：超过它不再“读一半当全部”，调用方按不安全处理（fail-closed）. */
const CONFIG_READ_CAP = 8 * 1024 * 1024;

/** 读整个配置文件。@returns {{ exists: boolean, text: string, tooLarge?: boolean, unreadable?: boolean }} */
function readConfigFile(file) {
  let st;
  try { st = fs.statSync(file); } catch { return { exists: false, text: '' }; }
  if (!st.isFile()) return { exists: false, text: '' };
  if (st.size > CONFIG_READ_CAP) return { exists: true, text: '', tooLarge: true };
  try { return { exists: true, text: fs.readFileSync(file, 'utf8') }; } catch { return { exists: true, text: '', unreadable: true }; }
}

/** 仓库自己的配置文本（读全文，不截断；过大 / 读不了的文件算空，要判安全请用 repoConfigEntries）. */
function repoConfigText(repo) {
  let text = '';
  for (const f of repoConfigFiles(repo)) text += readConfigFile(f).text + '\n';
  return text;
}

/**
 * 让 git 自己解析一个配置文件：`git config --file <f> --list -z`。只读，不会跑 filter / 钩子 / fsmonitor，
 * 也不读系统与全局配置（同一套清洗过的环境）。自己写的解析器和 git 的行为总会有出入（续行、同一行多个段头、超长文件…），
 * 判“有没有会执行命令的键”以 git 的结果为准.
 * @returns {{ ok: true, entries: object[] } | { ok: false, noGit?: boolean, reason: string }}
 */
function gitParsedConfig(file) {
  let exe;
  try { exe = resolveGit(); } catch (e) { return { ok: false, noGit: true, reason: e.message }; }
  let r;
  try {
    r = spawnSync(exe, ['config', '--file', file, '--list', '-z'], {
      cwd: os.tmpdir(), env: cleanEnv(), encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024 * 1024, shell: false,
    });
  } catch (e) { return { ok: false, reason: `启动 git 失败：${e.message}` }; }
  if (r.error) return { ok: false, noGit: r.error.code === 'ENOENT', reason: r.error.message };
  if (r.status !== 0) return { ok: false, reason: String(r.stderr || '').trim().split(/\r?\n/)[0].slice(0, 200) || `git 退出码 ${r.status}` };
  const entries = [];
  for (const rec of String(r.stdout || '').split('\0')) {
    if (!rec) continue;
    const nl = rec.indexOf('\n');
    const name = nl < 0 ? rec : rec.slice(0, nl);
    const first = name.indexOf('.');
    const last = name.lastIndexOf('.');
    if (first <= 0 || last === name.length - 1) continue;
    entries.push({
      section: name.slice(0, first),
      sub: first === last ? null : name.slice(first + 1, last),
      key: name.slice(last + 1),
      value: nl < 0 ? true : rec.slice(nl + 1),
    });
  }
  return { ok: true, entries };
}

/**
 * 仓库配置里全部的键值（供 unsafeRepoConfig 与 trust.cjs 用）。优先用 git 自己的解析结果；
 * git 拒绝解析（语法错）、文件过大 / 读不了，都记进 problems——调用方按“不安全”处理；
 * 只有找不到 git 时才退回自己的保守解析（此时机器上没有 git，也就没有东西会去执行这些配置）.
 * @param {{ noGit?: boolean }} [opts] noGit：测试用，强制走自己的解析
 * @returns {{ entries: object[], problems: string[] }}
 */
function repoConfigEntries(repo, opts = {}) {
  const entries = [];
  const problems = [];
  for (const f of repoConfigFiles(repo)) {
    const label = path.basename(f);
    const file = readConfigFile(f);
    if (!file.exists) continue;
    const viaGit = opts.noGit ? { ok: false, noGit: true, reason: '' } : gitParsedConfig(f);
    if (viaGit.ok) { entries.push(...viaGit.entries); continue; }
    if (!viaGit.noGit) problems.push(`${label} 无法解析`);
    if (file.tooLarge) { problems.push(`${label} 太大，无法检查`); continue; }
    if (file.unreadable) { problems.push(`${label} 读不了`); continue; }
    entries.push(...parseGitConfig(file.text));
  }
  return { entries, problems };
}

/** 仓库自己的配置里有没有无法用 -c 抵消的“会执行命令”的键（只在模式 B 检查）. */
function unsafeRepoConfig(repo) {
  const cfg = repoConfigEntries(repo);
  const problems = [...cfg.problems];
  for (const e of cfg.entries) {
    if (e.section === 'filter' && (e.key === 'clean' || e.key === 'smudge' || e.key === 'process')) problems.push(`filter.${e.sub ?? ''}.${e.key}`);
    else if (e.section === 'include' || e.section === 'includeif') problems.push(`${e.section}${e.sub ? `.${e.sub}` : ''}.${e.key}`);
    else if (e.section === 'core' && (e.key === 'worktree' || e.key === 'attributesfile')) problems.push(`core.${e.key}`);
  }
  return problems;
}

/**
 * 组装一次加固调用，不启动进程。spawnGit 用它；测试也用它去验证“同样的参数”下钩子与 fsmonitor 不会跑.
 * @returns {{ exe: string, args: string[], env: object, cwd: string, mode: 'private'|'repo' }}
 */
function hardenedInvocation(args, opts = {}) {
  if (!Array.isArray(args) || args.length === 0 || args.length > 400) throw fail('GIT_ARGS', 'spawnGit：参数必须是非空数组');
  for (const a of args) if (typeof a !== 'string' || a.includes('\0')) throw fail('GIT_ARGS', 'spawnGit：参数必须是不含空字符的字符串');
  const sub = args[0];
  if (!/^[a-z][a-z-]*$/.test(sub)) throw fail('GIT_ARGS', `spawnGit：第一个参数必须是子命令（收到 ${JSON.stringify(sub.slice(0, 40))}）`);
  if (!READ_COMMANDS.has(sub) && !WRITE_COMMANDS.has(sub)) throw fail('GIT_FORBIDDEN', `spawnGit：不允许的子命令 ${sub}（只放行管道命令与只读查询）`);
  for (const a of args.slice(1)) {
    if (a === '--') break;
    if (BAD_OPTION.test(a)) throw fail('GIT_FORBIDDEN', `spawnGit：不允许的选项 ${a.split('=')[0]}`);
    if (a.startsWith('-') && GPG_PLACEHOLDER.test(a)) throw fail('GIT_FORBIDDEN', 'spawnGit：格式里的 %G… 占位符会调用 gpg，不允许');
  }
  if (args.join(' ').length > MAX_CMDLINE) throw fail('GIT_ARGS', 'spawnGit：命令行太长');

  const cwd = opts.cwd;
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw fail('GIT_CWD', 'spawnGit：cwd 必须是绝对路径');
  let cwdReal;
  try { cwdReal = fs.realpathSync.native(cwd); if (!fs.statSync(cwdReal).isDirectory()) throw new Error('x'); } catch { throw fail('GIT_CWD', `spawnGit：目录不存在 ${cwd}`); }

  const gitDirOpt = opts.gitDir;
  let extraEnv;
  let mode;
  const prefix = hardPrefix();
  if (gitDirOpt !== undefined && gitDirOpt !== null) {
    if (typeof gitDirOpt !== 'string' || !path.isAbsolute(gitDirOpt)) throw fail('GIT_BAD_GITDIR', 'spawnGit：gitDir 必须是绝对路径');
    const gitDir = path.resolve(gitDirOpt);
    // 影子仓库不能放进被快照的目录里（否则会把自己也快照进去）；先解析符号链接再比较
    const gd = realpath(gitDir) || gitDir;
    if (isInside(gd, cwdReal)) throw fail('GIT_BAD_GITDIR', 'spawnGit：私有 GIT_DIR 不能在被快照的目录之内');
    mode = 'private';
    extraEnv = { GIT_DIR: gitDir, GIT_WORK_TREE: cwdReal };
  } else {
    if (WRITE_COMMANDS.has(sub)) throw fail('GIT_FORBIDDEN', `spawnGit：${sub} 会写仓库，只能在私有 GIT_DIR（影子仓库）里用，不能直接动用户自己的 .git`);
    const repo = detectRepoSync(cwdReal);
    if (!repo.isRepo) throw fail('GIT_NOT_REPO', `spawnGit：${cwd} 不在 git 仓库里`);
    const problems = unsafeRepoConfig(repo);
    if (problems.length) throw fail('GIT_UNSAFE_CONFIG', `仓库配置里有会执行命令或改变路径的设置（${problems.slice(0, 4).join('、')}），拒绝直接在它上面跑 git。`, { problems });
    mode = 'repo';
    prefix.splice(1, 0, '--no-optional-locks');
    extraEnv = { GIT_DIR: repo.gitDir, GIT_WORK_TREE: repo.workDir };
  }

  const rest = args.slice(1);
  const lead = [];
  if (SUBMODULE_SPAWNING.has(sub) && !rest.some((a) => a === '--ignore-submodules' || a.startsWith('--ignore-submodules='))) lead.push('--ignore-submodules=all');
  if (DIFFING.has(sub)) {
    if (!rest.includes('--no-ext-diff')) lead.push('--no-ext-diff');
    if (!rest.includes('--no-textconv')) lead.push('--no-textconv');
  }
  return { exe: resolveGit({ cwd: cwdReal }), args: [...prefix, sub, ...lead, ...rest], env: cleanEnv(extraEnv), cwd: cwdReal, mode };
}

/**
 * 运行一次 git。
 * @param {string[]} args  第一个必须是白名单子命令
 * @param {{ cwd: string, gitDir?: string, input?: string|Buffer|NodeJS.ReadableStream, timeoutMs?: number, maxBytes?: number,
 *           okCodes?: number[], encoding?: 'utf8'|'buffer', signal?: AbortSignal }} opts
 * @returns {Promise<{ code: number, stdout: string|Buffer, stderr: string }>}
 */
function spawnGit(args, opts = {}) {
  return new Promise((resolve, reject) => {
    let inv;
    try { inv = hardenedInvocation(args, opts); } catch (e) { reject(e); return; }
    // git init 只会建 GIT_DIR 这一层；影子仓库放在 <dataDir>/shadow/ 下，上一层可能还不存在.
    if (args[0] === 'init' && inv.mode === 'private') {
      try { fs.mkdirSync(path.dirname(inv.env.GIT_DIR), { recursive: true }); } catch (e) { reject(fail('GIT_BAD_GITDIR', `建不了影子仓库的上级目录：${e.message}`)); return; }
    }
    const timeoutMs = Math.min(Math.max(Number(opts.timeoutMs) || 60000, 50), 600000);
    const maxBytes = Math.min(Math.max(Number(opts.maxBytes) || 8 * 1024 * 1024, 1024), 256 * 1024 * 1024);
    const okCodes = Array.isArray(opts.okCodes) ? opts.okCodes : [0];
    const label = `git ${args.slice(0, 3).join(' ')}${args.length > 3 ? ' …' : ''}`;

    let child;
    try {
      child = spawn(inv.exe, inv.args, { cwd: inv.cwd, env: inv.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
    } catch (e) { reject(fail('GIT_SPAWN', `启动 git 失败：${e.message}`)); return; }

    const out = [];
    let outBytes = 0;
    let errText = '';
    let settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener('abort', onAbort); fn(value); };
    const killNow = () => { try { child.kill(); } catch { /* already gone */ } };
    const timer = setTimeout(() => { killNow(); finish(reject, fail('GIT_TIMEOUT', `${label} 超过 ${Math.round(timeoutMs / 1000)} 秒没有结束，已终止。`, { timeoutMs })); }, timeoutMs);
    const onAbort = () => { killNow(); finish(reject, fail('GIT_ABORTED', `${label} 已取消。`)); };
    if (opts.signal) { if (opts.signal.aborted) { onAbort(); return; } opts.signal.addEventListener('abort', onAbort, { once: true }); }

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length;
      if (outBytes > maxBytes) { killNow(); finish(reject, fail('GIT_OUTPUT_LIMIT', `${label} 的输出超过 ${Math.round(maxBytes / 1024)} KB，已终止。`, { maxBytes })); return; }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk) => { if (errText.length < 262144) errText += chunk.toString('utf8'); });
    child.on('error', (e) => finish(reject, fail(e.code === 'ENOENT' ? 'GIT_NOT_FOUND' : 'GIT_SPAWN', `启动 git 失败：${e.message}`)));
    child.on('close', (code, signal) => {
      const buf = Buffer.concat(out);
      const result = { code: code ?? -1, stdout: opts.encoding === 'buffer' ? buf : buf.toString('utf8'), stderr: errText };
      if (code !== null && okCodes.includes(code)) { finish(resolve, result); return; }
      const why = errText.trim().split(/\r?\n/).slice(0, 4).join(' / ').slice(0, 400);
      finish(reject, fail('GIT_EXIT', `${label} 失败（退出码 ${code ?? signal}）${why ? `：${why}` : ''}`, { exitCode: code, signal, stderr: errText, stdout: result.stdout }));
    });

    child.stdin.on('error', () => { /* git 提前退出：以退出码为准 */ });
    const input = opts.input;
    if (input === undefined || input === null) child.stdin.end();
    else if (typeof input === 'string' || Buffer.isBuffer(input)) child.stdin.end(input);
    else if (typeof input.pipe === 'function') input.pipe(child.stdin);
    else child.stdin.end();
  });
}

module.exports = {
  spawnGit, hardenedInvocation, detectRepo, detectRepoSync, resolveGit,
  parseGitConfig, repoConfigText, repoConfigEntries, unsafeRepoConfig, describeRemote, isBroadDir, isInside, samePath, readSmall, realpath,
  NULL_DEVICE, READ_COMMANDS, WRITE_COMMANDS,
};
