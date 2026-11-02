'use strict';
// Command-line agents (ACP) as a registry (MODELS-SPEC §10, §12): the 19 presets of catalog/acp-agents.json, the agents the user added (from the
// official ACP registry, pinned to one version, or a command of their own), and everything the 模型接入 page may do with them:
//
//   list / get / pseudoService(s)   the definitions, and the stand-alone ones as pseudo-services (group 「命令行」) for the page
//   launch / exeFor / driverDef     what program to start for a run, with which fixed arguments (never from the page)
//   resolveEnv                      the environment of a run: from the definition only (the page's env / keyEnv are never read)
//   probe / liveModels              acp:probe — `initialize` only, or (deep) one session/new to read the models and modes; cached for 1 hour
//   registry / addFromRegistry      acp:registry, acp:add-registry — browse the official registry (≤ 1 MB, cached 24 h); add = a native yes
//                                   every time, exact pinned version, nothing is executed by adding
//   pickExe / addCustom             acp:pick-exe, acp:add-custom — a file dialog hands back a one-time token (never a path); the main process
//                                   re-checks the file; arguments are plain words; no shell
//   remove                          acp:remove — only agents the user added
//
// User-added agents live in userData/services.json (`agents[]`, written through the service registry's file; executable paths exist ONLY there:
// the page cannot read them and cannot send one). Nothing here imports Electron at load time, so check-services runs it in plain Node.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const atomic = require('./atomic.cjs');
const net = require('./net.cjs');
const proc = require('./proc.cjs');
const acp = require('./acp.cjs');
const { validateAgent, envNameProblem, ARG_RE } = require('./services-validate.cjs');

/* ═════════════════════════ constants ═════════════════════════ */

const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json';
const REGISTRY_MAX_BYTES = 1024 * 1024;
const REGISTRY_TTL_MS = 24 * 3600_000;
const PROBE_TTL_MS = 3600_000;
const PROBE_MS = 15_000;
const PROBE_DEEP_MS = 20_000;
const TOKEN_TTL_MS = 10 * 60_000;
const MAX_USER_AGENTS = 32;
const USER_FILE_MAX = 512 * 1024;
const AGENT_ID_RE = /^[a-z][a-z0-9-]{1,24}$/;
/** The old driver names show the tool's own short name. */
const LEGACY_LABELS = { kimi: 'Kimi Code', qwen: 'Qwen Code', mcode: 'MiniMax Code' };
/** An npm / PyPI spec that names ONE version (a tag such as @latest, or a range, is refused: the version must not move under the user). */
const NPX_SPEC = /^(?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*@\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/i;
const UVX_SPEC = /^[a-z0-9][\w.-]*(?:@|==)\d+\.\d+\.\d+(?:[-+.][\w.-]+)?$/i;
const EXE_EXT = /\.(exe|cmd|bat)$/i;

const today = () => new Date().toISOString().slice(0, 10);
const isRec = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const clean = acp.clean;
const err = (error, extra = {}) => ({ ok: false, error, ...extra });

/* ═════════════════════════ pure helpers ═════════════════════════ */

/** 1–2 characters for a tile, the way the service tiles do it: 「Gemini CLI」→ Ge, 「OpenCode」→ Op, a Chinese name → its first character. (src/components/views/models/agent-services.ts has the same rule.) */
function glyphOf(label) {
  const s = String(label || '').trim();
  const a = [...(s.split(/[\s（(·\-_]+/).filter(Boolean)[0] || '?')];
  if (/\p{Script=Han}/u.test(a[0])) return a[0];
  return `${a[0].toUpperCase()}${(a[1] || '').toLowerCase()}`;
}

/** The fixed arguments of a run: the definition's own, behind `npx --yes <pinned spec>` / `uvx <pinned spec>` for an agent from the official registry. */
function launchArgs(def, registryInfo) {
  if (registryInfo) return registryInfo.dist === 'uvx' ? [registryInfo.spec, ...def.args] : ['--yes', registryInfo.spec, ...def.args];
  return def.args.slice();
}

/** One line for the confirmation dialog and the card: the command exactly as it will run. */
function commandLine(def, registryInfo) {
  if (registryInfo) return `${registryInfo.dist} ${launchArgs(def, registryInfo).join(' ')}`;
  return [def.bin[0], ...def.args].join(' ');
}

/** The only variables a probe process gets from this app's environment: enough to start a program, nothing that looks like a secret. */
const KEEP_ENV = new Set(['path', 'pathext', 'systemroot', 'systemdrive', 'windir', 'comspec', 'temp', 'tmp', 'tmpdir', 'userprofile', 'home', 'appdata', 'localappdata', 'programdata',
  'programfiles', 'programfiles(x86)', 'programw6432', 'username', 'userdomain', 'computername', 'os', 'processor_architecture', 'number_of_processors', 'lang', 'lc_all', 'shell', 'term', 'commonprogramfiles',
  'commonprogramfiles(x86)', 'commonprogramw6432', 'allusersprofile', 'public', 'homedrive', 'homepath']);
function minimalEnv(base, extra) {
  const out = {};
  for (const k of Object.keys(base || {})) if (KEEP_ENV.has(k.toLowerCase()) && typeof base[k] === 'string') out[k] = base[k];
  return { ...out, ...(extra || {}) };
}

/** Spawn with an exact environment (spawnCli always inherits this app's whole environment; a probe must not hand that to a third-party program). */
function spawnWithEnv(exe, args, { cwd, env, onLine, onErr }) {
  const opts = { cwd, windowsHide: true, env, stdio: ['pipe', 'pipe', 'pipe'] };
  let child;
  if (proc.isWin && /\.(cmd|bat)$/i.test(exe)) {
    const line = [proc.q(exe), ...args.map(proc.q)].join(' ');
    child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...opts, windowsVerbatimArguments: true });
  } else {
    child = spawn(exe, args, opts);
  }
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    if (buf.length > 4 * 1024 * 1024) buf = buf.slice(-1024 * 1024);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1); if (line.trim()) onLine(line); }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => onErr && onErr(d));
  child.stdin.on('error', () => {});
  return child;
}

/* ───────────── the official registry ───────────── */

/**
 * registry.json → entries. Only entries that name a way to start them (npx / uvx / binary) are kept; the fields are cleaned and cut. An npx / uvx entry whose
 * package is not pinned to one version, or whose arguments are not plain words, is listed but cannot be added (`addable: false`, with the reason).
 * @returns {{ entries: Array<object>, skipped: number }}
 */
function parseRegistry(json) {
  const list = isRec(json) && Array.isArray(json.agents) ? json.agents.slice(0, 300) : [];
  const entries = [];
  let skipped = 0;
  const https = (u, max) => (typeof u === 'string' && u.length <= max && /^https:\/\/[^\s]+$/.test(u) ? u : '');
  for (const a of list) {
    if (!isRec(a) || typeof a.id !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(a.id) || typeof a.name !== 'string' || !a.name.trim() || typeof a.version !== 'string' || !/^[\w.+-]{1,40}$/.test(a.version) || !isRec(a.distribution)) { skipped += 1; continue; }
    const dist = a.distribution;
    const e = { id: a.id, name: clean(a.name, 80), version: a.version, description: clean(a.description, 300), license: clean(a.license, 40), repository: https(a.repository, 200), dist: '', spec: '', args: [], addable: false, reason: '', hasSha256: false, command: '', downloads: [] };
    const argsOk = (xs) => Array.isArray(xs) && xs.length <= 8 && xs.every((x) => typeof x === 'string' && ARG_RE.test(x));
    if (isRec(dist.npx) && typeof dist.npx.package === 'string') {
      e.dist = 'npx';
      const pkg = dist.npx.package.trim();
      const spec = NPX_SPEC.test(pkg) ? pkg : (!/@/.test(pkg.replace(/^@/, '')) && /^[\w.+-]+$/.test(a.version) ? `${pkg}@${a.version}` : '');
      e.args = Array.isArray(dist.npx.args) ? dist.npx.args : [];
      if (!NPX_SPEC.test(spec)) e.reason = '它的包没有固定到一个版本，栖枝不会添加会自己变的命令';
      else if (!argsOk(e.args)) e.reason = '注册表给出的启动参数不是普通的词，栖枝不会添加';
      else { e.spec = spec; e.addable = true; }
    } else if (isRec(dist.uvx) && typeof dist.uvx.package === 'string') {
      e.dist = 'uvx';
      const pkg = dist.uvx.package.trim();
      const spec = UVX_SPEC.test(pkg) ? pkg : (/^[a-z0-9][\w.-]*$/i.test(pkg) && /^[\w.+-]+$/.test(a.version) ? `${pkg}@${a.version}` : '');
      e.args = Array.isArray(dist.uvx.args) ? dist.uvx.args : [];
      if (!UVX_SPEC.test(spec)) e.reason = '它的包没有固定到一个版本，栖枝不会添加会自己变的命令';
      else if (!argsOk(e.args)) e.reason = '注册表给出的启动参数不是普通的词，栖枝不会添加';
      else { e.spec = spec; e.addable = true; }
    } else if (isRec(dist.binary)) {
      e.dist = 'binary';
      e.reason = '这是二进制发行：栖枝暂时不自动下载。请自行下载安装后，用「自定义命令」登记';
      const rows = [];
      for (const k of Object.keys(dist.binary).slice(0, 16)) {
        const b = dist.binary[k];
        if (!isRec(b)) continue;
        rows.push({ platform: clean(k, 40), url: https(b.archive, 400), sha256: typeof b.sha256 === 'string' && /^[0-9a-f]{64}$/i.test(b.sha256) ? b.sha256.toLowerCase() : '' });
      }
      e.downloads = rows.filter((r) => /windows|win32/i.test(r.platform));
      e.hasSha256 = e.downloads.length > 0 && e.downloads.every((r) => !!r.sha256);
    } else { skipped += 1; continue; }
    e.args = e.args.filter((x) => typeof x === 'string' && ARG_RE.test(x)).slice(0, 8);
    if (e.spec) e.command = `${e.dist === 'uvx' ? 'uvx' : 'npx --yes'} ${[e.spec, ...e.args].join(' ')}`;
    entries.push(e);
  }
  return { entries, skipped };
}

/* ═════════════════════════ the registry of agents ═════════════════════════ */

/**
 * @param {{
 *   registry: object,                              the service registry (services.cjs createRegistry): catalog + the user's file
 *   userData: string | (() => string),             where acp-registry.json and the probe's scratch folder live
 *   now?: () => number, secrets?: object,
 *   fetchLimited?: Function, registryUrl?: string,  (tests point these at a loopback server)
 *   resolveCommand?: (name: string) => string | null,
 *   managedRoots?: () => string[], dshRoots?: () => string[],
 *   env?: Record<string, string | undefined>, probeEnv?: Record<string, string>,
 *   timeouts?: { probe?: number, deep?: number },
 *   confirm?: (e: object, o: { title: string, message: string, detail?: string }) => Promise<boolean>,
 *   chooseFile?: (e: object) => Promise<string | null>,
 * }} opts
 */
function createAcpAgents(opts) {
  const reg = opts.registry;
  const nowFn = opts.now || Date.now;
  const userDataOf = typeof opts.userData === 'function' ? opts.userData : () => opts.userData;
  const secrets = opts.secrets || require('./secrets.cjs');
  const doFetch = opts.fetchLimited || net.fetchLimited;
  const registryUrl = opts.registryUrl || REGISTRY_URL;
  const resolveCommand = opts.resolveCommand || ((n) => proc.resolveCommand(n));
  const baseEnv = opts.env || process.env;
  const probeEnv = opts.probeEnv || {};   // test hook: variables added to the probe's (otherwise minimal) environment
  const probeMs = (opts.timeouts && opts.timeouts.probe) || PROBE_MS;
  const deepMs = (opts.timeouts && opts.timeouts.deep) || PROBE_DEEP_MS;
  const cat = reg.catalog;
  const probeCache = new Map();      // `${id}:${deep}` → { at, result }
  const tokens = new Map();          // one-time tokens of pick-exe → { file, name, exp }
  const hooks = [];

  /* ───────────── the user's agents (services.json → agents[]) ───────────── */

  const rawList = () => reg._state().agents;
  function persist() {
    if (typeof reg.persist === 'function') { reg.persist(); return; }
    const u = reg._state();
    atomic.writeJson(reg.userFile(), { v: 1, services: u.services, agents: u.agents, overrides: u.overrides, keyBindings: u.keyBindings, pinned: u.pinned, confirmed: u.confirmed, retired: u.retired }, { maxBytes: USER_FILE_MAX });
  }

  /** A stored user agent → { def, exe?, registry?, source } or null (the file was edited by hand, or an older/newer build wrote something else). */
  function normalizeUser(raw) {
    if (!isRec(raw) || typeof raw.id !== 'string') return null;
    const source = raw.source === 'registry' ? 'registry' : raw.source === 'custom' ? 'custom' : '';
    if (!source || cat.agentById.has(raw.id)) return null;
    if (!(source === 'custom' ? /^c-/ : /^r-/).test(raw.id)) return null;
    const v = validateAgent(raw);
    if (!v.ok) return null;
    const def = { ...v.value, source };
    if (source === 'custom') {
      if (typeof raw.exe !== 'string' || raw.exe.length > 520 || !path.isAbsolute(raw.exe) || !EXE_EXT.test(raw.exe) || /[\u0000-\u001f]/.test(raw.exe)) return null;
      return { def, source, exe: raw.exe };
    }
    const r = raw.registry;
    if (!isRec(r) || (r.dist !== 'npx' && r.dist !== 'uvx') || typeof r.spec !== 'string' || !(r.dist === 'npx' ? NPX_SPEC : UVX_SPEC).test(r.spec)
      || typeof r.id !== 'string' || r.id.length > 80 || typeof r.version !== 'string' || r.version.length > 40) return null;
    return { def, source, registry: { id: r.id, version: r.version, dist: r.dist, spec: r.spec, confirmed: typeof r.confirmed === 'string' ? r.confirmed : '' } };
  }
  function userEntries() {
    const out = [];
    const seen = new Set();
    for (const raw of rawList()) {
      const e = normalizeUser(raw);
      if (e && !seen.has(e.def.id)) { seen.add(e.def.id); out.push(e); }
    }
    return out;
  }

  const presetCopies = new Map();
  const presetEntry = (a) => {
    let d = presetCopies.get(a.id);
    if (!d) { d = { def: { ...a, source: 'preset' }, source: 'preset' }; presetCopies.set(a.id, d); }
    return d;
  };
  /** Every agent that can run: the catalog's, then the user's. */
  function entries() { return [...cat.agents.map(presetEntry), ...userEntries()]; }
  function entry(id) {
    if (typeof id !== 'string') return undefined;
    const p = cat.agentById.get(id);
    return p ? presetEntry(p) : userEntries().find((e) => e.def.id === id);
  }
  const get = (id) => { const e = entry(id); return e ? e.def : undefined; };
  /** What the page may see: definitions without executable paths, with `source`, and a registry agent's id / version / way of starting. */
  function list({ hidden = false } = {}) {
    return entries().filter((e) => hidden || !e.def.hidden).map((e) => {
      const d = JSON.parse(JSON.stringify(e.def));
      if (e.registry) d.registry = { id: e.registry.id, version: e.registry.version, dist: e.registry.dist, command: commandLine(e.def, e.registry) };
      return d;
    });
  }

  /* ───────────── pseudo-services (the 「命令行」 group) ───────────── */

  /** A stand-alone agent as a service card: no API address, no models of its own, one driver. Agents bound to a vendor (`vendor`) are NOT pseudo-services: they are a way inside that vendor's card. */
  function pseudoService(def) {
    const hasKey = def.binding && def.binding.mode === 'env' && !def.vendor;
    const s = {
      id: `acp_${def.id}`, kind: 'agent', name: String(def.label).slice(0, 40), vendor: def.source === 'registry' ? '官方注册表' : def.source === 'custom' ? '自定义命令' : '命令行代理',
      glyph: glyphOf(def.label), group: 'cli', aliases: [def.id, ...def.bin].slice(0, 6), protocol: 'none',
      endpoints: [{ id: 'cli', label: '命令行', kind: 'payg' }],
      auth: hasKey ? { scheme: 'bearer', keyOptional: true } : { scheme: 'none' },
      models: [], drivers: [`acp:${def.id}`], keyHelp: def.auth.loginHint || '', docsUrl: def.docsUrl, verified: def.verified, unverified: (def.unverified || []).slice(), hidden: !!def.hidden,
    };
    return s;
  }
  const standalone = (e) => !e.def.vendor;
  function pseudoServices({ hidden = false } = {}) {
    return entries().filter((e) => standalone(e) && (hidden || !e.def.hidden)).map((e) => pseudoService(e.def));
  }
  function pseudoServiceById(id) {
    if (typeof id !== 'string' || !id.startsWith('acp_')) return undefined;
    const e = entry(id.slice(4));
    return e && standalone(e) ? pseudoService(e.def) : undefined;
  }

  /* ───────────── finding the program ───────────── */

  const defaultManagedRoots = () => [baseEnv.AIROOM_DATA_DIR, baseEnv.APPDATA && path.join(baseEnv.APPDATA, 'AIROOM', 'data')].filter(Boolean);
  const defaultDshRoots = () => [
    baseEnv.LOCALAPPDATA && path.join(baseEnv.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    baseEnv.ProgramFiles && path.join(baseEnv.ProgramFiles, 'DeepSeek Harness'),
  ].filter(Boolean);

  /** CLIs that AIROOM installed for its members live under its data folder, off PATH: <data>/members/<bin>/<version>/node_modules/.bin/<bin>.cmd — newest version first. */
  function managedCandidates(bin) {
    const out = [];
    for (const root of (opts.managedRoots || defaultManagedRoots)()) {
      const dir = path.join(root, 'members', bin);
      let versions = [];
      try { versions = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
      versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      for (const v of versions) out.push(path.join(dir, v, 'node_modules', '.bin', `${bin}.cmd`));
    }
    return out;
  }
  const dshCandidates = () => (opts.dshRoots || defaultDshRoots)().map((r) => path.join(r, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'));

  /**
   * The program to start for an agent and its fixed arguments.
   * A preset: the first of its commands found on PATH (or AIROOM's managed copy, or DeepSeek Harness's own); `customPath` (the 命令路径 setting) wins when it is a real .exe / .cmd / .bat.
   * An agent the user registered: its own executable (the setting is ignored: the path was fixed when the user picked the file), or npx / uvx with the pinned spec the user confirmed.
   * @returns {{ ok: true, exe: string, args: string[], def: object, source: string } | { ok: false, error: string, code: string }}
   */
  function launch(id, { customPath } = {}) {
    const e = entry(id);
    if (!e) return { ok: false, code: 'AGENT', error: '未知的命令行工具。' };
    if (e.source === 'custom') {
      try { if (!fs.statSync(e.exe).isFile()) throw new Error('not a file'); } catch { return { ok: false, code: 'ENOENT', error: `找不到你登记的程序：${e.exe}。可以在「模型接入」里移除后重新登记。` }; }
      return { ok: true, exe: e.exe, args: launchArgs(e.def), def: e.def, source: 'custom' };
    }
    if (e.source === 'registry') {
      const r = e.registry;
      if (r.confirmed !== r.spec) return { ok: false, code: 'UNCONFIRMED', error: '这个命令还没有经过你的确认（或版本变了）。请在「模型接入」里重新添加并确认。' };
      const tool = resolveCommand(r.dist);
      if (!tool) return { ok: false, code: 'ENOENT', error: `找不到 ${r.dist}。${r.dist === 'npx' ? '请先安装 Node.js。' : '请先安装 uv（https://docs.astral.sh/uv/）。'}` };
      return { ok: true, exe: tool, args: launchArgs(e.def, r), def: e.def, source: 'registry' };
    }
    if (customPath) {
      if (typeof customPath === 'string' && fs.existsSync(customPath) && EXE_EXT.test(customPath)) return { ok: true, exe: customPath, args: launchArgs(e.def), def: e.def, source: 'preset' };
      return { ok: false, code: 'ENOENT', error: '命令路径不存在，或不是 .exe / .cmd / .bat。' };
    }
    for (const bin of e.def.bin) { const found = resolveCommand(bin); if (found) return { ok: true, exe: found, args: launchArgs(e.def), def: e.def, source: 'preset' }; }
    const extra = [...e.def.bin.flatMap(managedCandidates), ...(e.def.id === 'dsh-acp' ? dshCandidates() : [])];
    const hit = extra.find((p) => fs.existsSync(p));
    if (hit) return { ok: true, exe: hit, args: launchArgs(e.def), def: e.def, source: 'preset' };
    return { ok: false, code: 'ENOENT', error: `PATH 里没有找到 ${e.def.bin.join(' 或 ')}` };
  }
  const exeFor = (id, customPath) => { const l = launch(id, { customPath }); return l.ok ? l.exe : null; };

  /** What index.cjs's driverDef() returns for an agent: names, login command, and the fixed arguments of a run. */
  function driverDef(id) {
    const e = entry(id);
    if (!e) return null;
    const d = e.def;
    return { bin: d.bin[0], bins: d.bin, label: Object.hasOwn(LEGACY_LABELS, d.id) ? LEGACY_LABELS[d.id] : d.label, login: d.auth.loginArgs || null, loginHint: d.auth.loginHint, acpArgs: launchArgs(d, e.registry), agent: d.id };
  }

  /**
   * The environment of a run, from the definition only. A preset goes through the service registry's resolveAgent (it knows the vendor's endpoint and key slot);
   * an agent the user added has no vendor: its one optional key (custom commands may name ONE variable for it) lives in the slot of its pseudo-service.
   * @returns the same shape as registry.resolveAgent: { ok, service, agent, env, keyEnv, slot, keyOptional, endpoint }
   */
  function resolveEnv(spec) {
    const e = entry(agentIdOfSpec(spec));
    if (!e) return err('未知的命令行工具。', { code: 'AGENT' });
    if (e.source === 'preset') return reg.resolveAgent(spec);
    const service = pseudoService(e.def);
    if (String(spec.provider || '') !== service.id) return err('这个命令行工具不属于这项服务。', { code: 'AGENT' });
    const out = { ok: true, service, agent: e.def, env: {}, keyEnv: '', slot: '', keyOptional: true };
    if (e.def.binding.mode === 'env') { out.keyEnv = e.def.binding.keyEnv; out.slot = service.id; out.endpoint = service.endpoints[0]; }
    return out;
  }
  function agentIdOfSpec(spec) {
    const d = String(spec.driver || '');
    if (d === 'acp') return String(spec.acp || spec.agent || '');
    if (d.startsWith('acp:')) return d.slice(4);
    const legacy = cat.legacyAgent.get(d);
    return legacy ? legacy.id : '';
  }

  /* ───────────── acp:probe ───────────── */

  /** The probe's scratch folder: the agent starts here and nowhere else. */
  function probeDir() {
    const dir = path.join(userDataOf(), 'workspaces', '_acp-probe');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * The folder the PROCESS of an agent from the official registry (`npx --yes pkg@x.y.z` / `uvx pkg@x.y.z`) is started in: an empty folder of
   * the app's own, never the task's folder. A package manager reads its configuration from the folder it runs in — a `.npmrc` with another
   * `registry=` (or a `node_modules/.bin/<name>` that npx would pick before downloading) in a repository the user opened would make "the pinned
   * version" come from somewhere else. The task's folder reaches the agent only as the `cwd` of its ACP session.
   */
  function runDir() {
    const dir = path.join(userDataOf(), 'workspaces', '_acp-run');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /**
   * One short-lived process: `initialize`; with `deep`, also one `session/new` (cwd = the scratch folder, no MCP servers) to read configOptions / modes / models.
   * The process gets a minimal environment and is killed afterwards; a timeout kills it too.
   */
  function probeProcess(l, { deep, timeoutMs }) {
    return new Promise((resolve) => {
      let settled = false;
      let seq = 0;
      let stderr = '';
      const pending = new Map();
      let child;
      const timer = setTimeout(() => finish({ ok: false, timedOut: true, error: `${Math.round(timeoutMs / 1000)} 秒内没有回应（initialize${deep ? ' / 新建会话' : ''}），已结束它。` }), timeoutMs);
      const result = { ok: false, authMethods: [], caps: { loadSession: false, resume: false, list: false, close: false, configOptions: false, mcpHttp: false, image: false }, deep: !!deep };
      function finish(r) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const p of pending.values()) p.reject(new Error('closed'));
        pending.clear();
        try { proc.killTree(child); } catch { /* gone */ }
        resolve({ ...result, ...r });
      }
      const send = (o) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`); } catch { /* closed */ } };
      const request = (method, params) => new Promise((res, rej) => { const id = ++seq; pending.set(id, { resolve: res, reject: rej }); send({ id, method, params }); });
      const env = minimalEnv(baseEnv, probeEnv);
      try {
        child = spawnWithEnv(l.exe, l.args, {
          cwd: probeDir(), env,
          onErr: (d) => { stderr += d; if (stderr.length > 8000) stderr = stderr.slice(-8000); },
          onLine: (line) => {
            let msg; try { msg = JSON.parse(line); } catch { return; }
            if (!isRec(msg)) return;
            if (msg.id !== undefined && !msg.method) {
              const p = pending.get(msg.id);
              if (!p) return;
              pending.delete(msg.id);
              if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'ACP 错误'), { code: msg.error.code, data: msg.error.data })); else p.resolve(msg.result);
              return;
            }
            // the probe serves nothing: any request the agent makes is refused (so it never waits on us)
            if (msg.method && msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'not supported by the probe' } });
          },
        });
      } catch (e) { finish({ ok: false, error: `无法启动：${clean(e && e.message, 120)}` }); return; }
      child.on('error', (e) => finish({ ok: false, error: `无法启动：${clean(e.message, 120)}` }));
      child.on('close', (code) => { if (!settled) finish({ ok: false, error: stderr.trim() ? `意外退出（${code}）：${clean(stderr.trim().split(/\r?\n/).slice(-3).join(' / '), 240)}` : `意外退出（${code}）` }); });
      (async () => {
        const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'Alight', version: '2.0.0' } });
        const p = acp.parseInitialize(init);
        Object.assign(result, { ok: true, agentInfo: p.agentInfo, protocolVersion: p.protocolVersion, authMethods: p.authMethods.map((m) => ({ id: m.id, type: m.type, name: m.name })), caps: { ...result.caps, ...p.caps } });
        if (!deep) { finish({}); return; }
        try {
          const created = await request('session/new', { cwd: probeDir(), mcpServers: [] });
          const options = acp.parseConfigOptions(created && created.configOptions);
          const summary = acp.summarizeConfig(options, { modes: created && created.modes, models: created && created.models });
          result.caps.configOptions = options.length > 0;
          result.summary = summary;
          finish({});
        } catch (e) {
          // initialize worked; the session did not: say so (usually "sign in first")
          const needs = acp.isAuthRequired(e, p.authMethods);
          finish({ ok: true, needsLogin: needs, error: needs ? '需要先登录，登录后才能读取模型与模式。' : `没能新建会话：${clean(e && e.message, 160)}` });
        }
      })().catch((e) => finish({ ok: false, error: `initialize 失败：${clean(e && e.message, 160)}` }));
    });
  }

  /**
   * acp:probe. `cacheOnly`: answer from the 1-hour cache without starting anything (the card asks this when it opens). `fresh`: skip the cache.
   * @returns {Promise<object>} AcpProbeResult + { at, deep, summary?, needsLogin?, cached? }
   */
  async function probe(req = {}) {
    const id = typeof req.agent === 'string' ? req.agent : '';
    const e = entry(id);
    if (!e) return { ok: false, error: '未知的命令行工具。', authMethods: [], caps: noCaps() };
    const deep = !!req.deep;
    const key = `${id}:${deep ? 1 : 0}`;
    const hit = probeCache.get(key);
    // a deep result also answers a shallow question
    const deepHit = !deep ? probeCache.get(`${id}:1`) : undefined;
    const usable = (h) => h && nowFn() - h.at < PROBE_TTL_MS;
    if (req.cacheOnly) {
      const h = usable(hit) ? hit : usable(deepHit) ? deepHit : null;
      return h ? { ...h.result, cached: true } : { ok: false, notProbed: true, error: '还没有探测过。', authMethods: [], caps: noCaps() };
    }
    if (!req.fresh && usable(hit)) return { ...hit.result, cached: true };
    const l = launch(id);
    if (!l.ok) return { ok: false, notFound: l.code === 'ENOENT', error: l.error, authMethods: [], caps: noCaps() };
    const r = await probeProcess(l, { deep, timeoutMs: deep ? deepMs : probeMs });
    const result = { ...r, at: nowFn() };
    if (result.ok) probeCache.set(key, { at: result.at, result });
    return result;
  }
  const noCaps = () => ({ loadSession: false, resume: false, list: false, close: false, configOptions: false, mcpHttp: false, image: false });

  /** The models of an agent in the shape the page keeps for Codex (`LiveModel`), from the last deep probe (never starts a process: probes are the user's click). */
  function liveModels(id) {
    const h = probeCache.get(`${id}:1`);
    if (!h || nowFn() - h.at >= PROBE_TTL_MS || !h.result.summary || !h.result.summary.models.length) return null;
    const s = h.result.summary;
    const levels = s.efforts.map((x) => x.level).filter(Boolean);
    const cur = s.efforts.find((x) => x.id === s.currentEffort);
    return s.models.map((m) => ({ id: m.id, label: m.label, note: m.note ? m.note.slice(0, 80) : '', efforts: levels, defaultEffort: cur && cur.level ? cur.level : undefined, isDefault: m.id === s.currentModel }));
  }

  /* ───────────── the official registry ───────────── */

  const cacheFile = () => path.join(userDataOf(), 'acp-registry.json');
  function readRegistryCache() {
    const r = atomic.readJson(cacheFile(), { maxBytes: 2 * REGISTRY_MAX_BYTES });
    if (r.state === 'corrupt' || r.state === 'toobig') { atomic.setAside(cacheFile()); return null; }
    if (r.state !== 'ok' || !isRec(r.data) || !Number.isFinite(r.data.at) || !Array.isArray(r.data.agents)) return null;
    return { at: r.data.at, ...parseRegistry({ agents: r.data.agents }) };
  }
  function decorate(entriesIn) {
    const presetByRegistryId = new Map(cat.agents.filter((a) => a.registryId).map((a) => [a.registryId, a.id]));
    const mine = userEntries().filter((e) => e.registry);
    return entriesIn.map((e) => {
      const installed = mine.find((m) => m.registry.id === e.id);
      return { ...e, preset: presetByRegistryId.get(e.id) || '', installed: !!installed, installedVersion: installed ? installed.registry.version : '', updateAvailable: !!installed && installed.registry.version !== e.version };
    });
  }

  /**
   * acp:registry: the registry's entries (name, version, license, how it is started, whether a checksum exists), 24-hour cache. A failed fetch falls back to the
   * cache (marked stale) and says why. Only the fixed registry address is ever requested; the page cannot name a URL.
   */
  async function registryList({ fresh } = {}) {
    const cached = readRegistryCache();
    if (cached && !fresh && nowFn() - cached.at < REGISTRY_TTL_MS) return { ok: true, value: decorate(cached.entries), at: cached.at, stale: false };
    let res;
    try {
      res = await doFetch(registryUrl, { method: 'GET', headers: { accept: 'application/json' } }, { timeoutMs: 15_000, maxBytes: REGISTRY_MAX_BYTES });
    } catch (e) {
      const why = clean(e && e.message, 120);
      return cached ? { ok: true, value: decorate(cached.entries), at: cached.at, stale: true, error: `没能刷新（${why}），显示的是上次的结果。` } : err(`没能读取官方注册表：${why}`);
    }
    const parsed = res.ok && res.json ? parseRegistry(res.json) : null;
    if (!parsed || !parsed.entries.length) {
      const why = !res.ok ? `HTTP ${res.status}` : '内容不是注册表';
      return cached ? { ok: true, value: decorate(cached.entries), at: cached.at, stale: true, error: `没能刷新（${why}），显示的是上次的结果。` } : err(`没能读取官方注册表：${why}`);
    }
    const at = nowFn();
    try { atomic.writeJson(cacheFile(), { at, agents: res.json.agents.slice(0, 300) }, { maxBytes: 2 * REGISTRY_MAX_BYTES }); } catch { /* the list still works without its cache */ }
    return { ok: true, value: decorate(parsed.entries), at, stale: false };
  }

  const slugOf = (s, max) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max);
  function freshId(prefix, base) {
    const taken = new Set(entries().map((e) => e.def.id));
    const room = 25 - prefix.length;
    const root = slugOf(base, room - 3) || 'agent';
    let id = `${prefix}${root}`.slice(0, 25);
    for (let n = 2; taken.has(id); n += 1) id = `${prefix}${root.slice(0, room - String(n).length - 1)}-${n}`;
    return id;
  }

  /** Put a user agent into services.json (replacing the one with the same id); give the old file back when the disk refuses. */
  function store(raw) {
    const list = rawList();
    const before = list.slice();
    const i = list.findIndex((a) => isRec(a) && a.id === raw.id);
    if (i >= 0) list[i] = raw; else list.push(raw);
    try { persist(); } catch (e) { list.splice(0, list.length, ...before); throw e; }
  }

  /**
   * acp:add-registry: after a native yes (shown: name @ version, the exact command, that it downloads and runs third-party code, that no checksum can be verified),
   * the agent is written with `registry: { id, version, dist, spec, confirmed }`. Adding does not run anything. Binary entries are not added in this release.
   * @param {{ id: string }} req
   * @param {(o: object) => Promise<boolean>} confirm  a native yes/no (never the page)
   */
  async function addFromRegistry(req, confirm) {
    const rid = isRec(req) && typeof req.id === 'string' ? req.id : '';
    if (!rid || rid.length > 64) return err('没有指定要添加的代理。');
    const listing = await registryList({});
    if (!listing.ok) return listing;
    const e = listing.value.find((x) => x.id === rid);
    if (!e) return err('注册表里没有这个代理。可以先刷新注册表。');
    if (e.preset) return err('栖枝已经有这个代理的预设，直接使用预设就行（需要先自行安装它的命令）。');
    if (e.dist === 'binary') return err(e.reason, { code: 'BINARY' });
    if (!e.addable) return err(e.reason || '这个条目不能添加。');
    const users = rawList();
    const existing = users.find((a) => isRec(a) && a.source === 'registry' && isRec(a.registry) && a.registry.id === e.id);
    if (!existing && users.length >= MAX_USER_AGENTS) return err(`自己添加的命令行代理最多 ${MAX_USER_AGENTS} 个。`);
    if (!confirm) return err('需要你在弹窗里确认，已取消');
    const how = e.dist === 'uvx' ? 'uvx（PyPI）' : 'npx（npm）';
    const ok = await confirm({
      title: '添加命令行代理',
      message: `「${e.name}」${e.version} 会通过 ${how} 运行：\n${e.command}`,
      detail: `这会从 ${e.dist === 'uvx' ? 'PyPI' : 'npm'} 下载并执行第三方程序，包含它的依赖，权限和你的用户一样。\n注册表没有给校验值，栖枝无法校验它。\n版本固定为 ${e.version}，不会自动升级；注册表上有新版本时需要你再确认一次。\n添加本身不会运行它，第一次使用时才会。`,
    });
    if (!ok) return err('已取消');
    const id = existing ? existing.id : freshId('r-', e.id);
    const def = {
      id, label: e.name.slice(0, 60), bin: [e.dist], args: e.args,
      auth: { mode: 'own-login', loginHint: '这是从官方注册表添加的第三方代理：登录和配置请按它自己的文档在终端里完成。' },
      binding: { mode: 'none' }, install: { note: `来自 ACP 官方注册表：${e.command}` }, perm: { level: 'unverified' },
      registryId: e.id, verified: today(), docsUrl: e.repository || 'https://agentclientprotocol.com/', source: 'registry',
      registry: { id: e.id, version: e.version, dist: e.dist, spec: e.spec, confirmed: e.spec },
    };
    if (!normalizeUser(def)) return err('这个条目的内容不符合安全规则，没有添加。');
    try { store(def); } catch (x) { return err(`没能写入服务配置：${clean(x && x.message, 120)}`); }
    for (const k of [...probeCache.keys()]) if (k.startsWith(`${id}:`)) probeCache.delete(k);
    return { ok: true, value: { id, install: e.command } };
  }

  /* ───────────── a command of the user's own ───────────── */

  const prune = () => { const t = nowFn(); for (const [k, v] of tokens) if (v.exp <= t) tokens.delete(k); };
  /** A real executable file, absolute, with an allowed extension. */
  function exeProblem(file) {
    if (typeof file !== 'string' || !file || file.length > 520 || /[\u0000-\u001f]/.test(file) || !path.isAbsolute(file)) return '路径不合法';
    if (!EXE_EXT.test(file)) return '只能登记 .exe / .cmd / .bat';
    try { if (!fs.statSync(file).isFile()) return '这不是文件'; } catch { return '文件不存在'; }
    return '';
  }
  /**
   * acp:pick-exe: the user picks a file in a native dialog; the page gets a one-time token and the file's NAME (never its path).
   * @param {(e: object) => Promise<string | null>} choose  the native file dialog
   */
  async function pickExe(e, choose) {
    if (!choose) return err('这里不能选择文件。');
    prune();
    let file;
    try { file = await choose(e); } catch (x) { return err(`没能打开文件对话框：${clean(x && x.message, 100)}`); }
    if (!file) return err('已取消', { canceled: true });
    const problem = exeProblem(file);
    if (problem) return err(problem);
    if (tokens.size >= 8) tokens.delete(tokens.keys().next().value);
    const token = crypto.randomBytes(16).toString('hex');
    tokens.set(token, { file, name: path.basename(file), exp: nowFn() + TOKEN_TTL_MS });
    return { ok: true, value: { token, name: path.basename(file) } };
  }

  /**
   * acp:add-custom: the token (one-time, 10 minutes) names the file; the path itself can only come from there, whatever else the page sends is ignored.
   * Arguments are plain words, at most 8; at most ONE environment variable NAME may be declared (its value is the key saved on the card, never typed here).
   * @param {{ token: string, label: string, args: string[], envNames: string[] }} req
   */
  async function addCustom(req, confirm) {
    const r = isRec(req) ? req : {};
    prune();
    const tok = typeof r.token === 'string' ? tokens.get(r.token) : undefined;
    if (!tok || tok.exp <= nowFn()) return err('选择的文件已经过期，请重新选择。');
    const problem = exeProblem(tok.file);
    if (problem) { tokens.delete(r.token); return err(`${problem}，请重新选择。`); }
    const label = typeof r.label === 'string' ? r.label.trim() : '';
    if (!label || label.length > 60 || /[\u0000-\u001f\u007f]/.test(label)) return err('名称要 1–60 个字符。', { field: 'label' });
    const args = Array.isArray(r.args) ? r.args : [];
    if (args.length > 8) return err('参数最多 8 个。', { field: 'args' });
    for (const a of args) if (typeof a !== 'string' || !ARG_RE.test(a)) return err('参数只能是普通的词（字母、数字、. = : @ / - _），每个不超过 60 个字符。', { field: 'args' });
    const names = Array.isArray(r.envNames) ? r.envNames.filter((n) => n !== '' && n !== undefined) : [];
    if (names.length > 1) return err('一个自定义命令最多声明一个密钥变量。', { field: 'envNames' });
    for (const n of names) { const p = envNameProblem(n); if (p) return err(p, { field: 'envNames' }); }
    if (rawList().length >= MAX_USER_AGENTS) return err(`自己添加的命令行代理最多 ${MAX_USER_AGENTS} 个。`);
    if (!confirm) return err('需要你在弹窗里确认，已取消');
    const ok = await confirm({
      title: '登记命令行代理',
      message: `把 ${tok.file} 登记为命令行代理「${label}」？`,
      detail: `这等于让栖枝代你运行这个程序${args.length ? `（参数：${args.join(' ')}）` : ''}，权限和你的用户一样；栖枝不经 shell 启动它。${names.length ? `\n它会收到你在卡片里保存的密钥，放在环境变量 ${names[0]} 里。` : ''}`,
    });
    if (!ok) return err('已取消');
    tokens.delete(r.token);
    const base = path.basename(tok.file).replace(/\.(exe|cmd|bat)$/i, '');
    const id = freshId('c-', slugOf(label, 20) || slugOf(base, 20) || 'cmd');
    const def = {
      id, label, bin: [/^[\w.-]{1,40}$/.test(base) ? base : 'custom'], args,
      auth: { mode: names.length ? 'env-key' : 'own-login', loginHint: '这是你自己登记的命令：登录和配置请按它自己的文档在终端里完成。' },
      binding: names.length ? { mode: 'env', keyEnv: names[0], env: {}, optional: true } : { mode: 'none' },
      install: { note: `自定义命令：${path.basename(tok.file)}` }, perm: { level: 'unverified' }, verified: today(), docsUrl: 'https://agentclientprotocol.com/', source: 'custom', exe: tok.file,
    };
    const v = normalizeUser(def);
    if (!v) return err('这个命令的内容不符合安全规则，没有登记。');
    try { store(def); } catch (x) { return err(`没能写入服务配置：${clean(x && x.message, 120)}`); }
    return { ok: true, value: { id } };
  }

  /** acp:remove: only an agent the user added. Its saved key (custom commands with a key variable), its probe results and its entry go; tasks that named it keep working as readable history. */
  function remove(id) {
    if (typeof id !== 'string' || !id) return err('没有指定代理。');
    if (cat.agentById.has(id)) return err('预设的命令行代理不能移除。');
    const list = rawList();
    const i = list.findIndex((a) => isRec(a) && a.id === id);
    if (i < 0) return err('没有这个代理。');
    const before = list.slice();
    list.splice(i, 1);
    try { persist(); } catch (e) { list.splice(0, list.length, ...before); return err(`没能写入服务配置：${clean(e && e.message, 120)}`); }
    try { if (typeof secrets.clearService === 'function') secrets.clearService(`acp_${id}`); } catch { /* no key was saved */ }
    for (const k of [...probeCache.keys()]) if (k.startsWith(`${id}:`)) probeCache.delete(k);
    for (const fn of hooks) { try { fn(id); } catch { /* a cache that could not be cleaned */ } }
    return { ok: true, value: null };
  }

  /** The folder an agent's process starts in when that must not be the task's folder (an npx / uvx agent), else undefined. */
  const spawnCwdFor = (id) => { const e = entry(id); return e && e.source === 'registry' ? runDir() : undefined; };

  return {
    list, get, entry, entries, pseudoService, pseudoServices, pseudoServiceById, launch, exeFor, driverDef, resolveEnv,
    probe, liveModels, registryList, addFromRegistry, pickExe, addCustom, remove, onRemove: (fn) => { hooks.push(fn); },
    _tokens: tokens, _probeCache: probeCache, registryCacheFile: cacheFile, probeDir, runDir, spawnCwdFor,
  };
}

/* ═════════════════════════ the app's instance + IPC ═════════════════════════ */

let shared = null;
/** The agents of the running app (user data in Electron's userData folder, on the shared service registry). */
function instance() {
  if (!shared) {
    // Building the shared service registry also builds the agents on it (services.cjs → __setInstance below): one set of agents, not two.
    const registry = require('./services.cjs').instance();
    if (!shared) shared = createAcpAgents({ registry, userData: () => require('electron').app.getPath('userData') });
  }
  return shared;
}
function __setInstance(x) { shared = x; }

const str = (v, n) => (typeof v === 'string' && v.length <= n ? v : '');

/**
 * Register the acp:* channels. `handle` is the sender-checked wrapper from index.cjs.
 * @param {(channel: string, fn: Function) => void} handle
 * @param {{ agents?: object, confirm?: Function, chooseFile?: Function, tooSoon?: Function }} [deps]
 */
function register(handle, deps = {}) {
  const ag = deps.agents || instance();
  const svc = require('./services.cjs');
  const tooSoon = deps.tooSoon || svc.tooSoon;
  const confirmFor = (e) => (o) => (deps.confirm ? deps.confirm(e, o) : svc.nativeConfirm(e, o));
  handle('acp:probe', async (_e, req) => {
    const r = isRec(req) ? req : {};
    const agent = str(r.agent, 40);
    if (!agent) return { ok: false, error: '没有指定命令行工具。', authMethods: [], caps: {} };
    // a person clicking twice in a second gets the answer of the first click
    const fresh = !!r.fresh && !tooSoon(`acp-probe:${agent}`, 2000);
    return ag.probe({ agent, deep: !!r.deep, fresh, cacheOnly: !!r.cacheOnly });
  });
  handle('acp:registry', async (_e, req) => {
    const fresh = isRec(req) && !!req.fresh && !tooSoon('acp-registry', 30_000);
    return ag.registryList({ fresh });
  });
  handle('acp:add-registry', (e, req) => ag.addFromRegistry({ id: str(isRec(req) ? req.id : '', 64) }, confirmFor(e)));
  handle('acp:pick-exe', (e) => ag.pickExe(e, deps.chooseFile || (async (ev) => {
    const { dialog, BrowserWindow } = require('electron');
    const win = ev && ev.sender ? BrowserWindow.fromWebContents(ev.sender) : null;
    const opts = { title: '选择命令行代理的可执行文件', properties: ['openFile'], filters: [{ name: '可执行文件', extensions: ['exe', 'cmd', 'bat'] }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  })));
  handle('acp:add-custom', (e, req) => {
    const r = isRec(req) ? req : {};
    // only these four fields are read: a path (or anything else) the page adds is ignored
    return ag.addCustom({ token: str(r.token, 64), label: str(r.label, 80), args: Array.isArray(r.args) ? r.args.slice(0, 9).map((a) => str(a, 80) || '\u0000') : [], envNames: Array.isArray(r.envNames) ? r.envNames.slice(0, 3).map((n) => str(n, 60) || '\u0000') : [] }, confirmFor(e));
  });
  handle('acp:remove', (_e, id) => ag.remove(str(id, 40)));
}

module.exports = {
  createAcpAgents, instance, __setInstance, register,
  /** Pure helpers (tests, and the page-side copy of the pseudo-service rule is checked against these). */
  glyphOf, parseRegistry, launchArgs, commandLine, minimalEnv, NPX_SPEC, UVX_SPEC, REGISTRY_URL, LEGACY_LABELS, MAX_USER_AGENTS,
};
