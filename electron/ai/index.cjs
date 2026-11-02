// Model access for the page: IPC handlers for keys, CLI detection / login, folders, and streamed
// runs. The page describes what to run; this process decides which program or URL that means, adds
// the key, and streams events back. Nothing here runs unless the user started it from the page.
const { app, ipcMain, dialog, shell, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const secrets = require('./secrets.cjs');
const { resolveCommand, forgetCommand, prefetchCommands, runOnce, isWin, spawnCli, killTree } = require('./proc.cjs');
const { streamOpenAI, streamAnthropic } = require('./api.cjs');
const { runClaude } = require('./claude.cjs');
const { runClaudeSdk } = require('./claude-sdk.cjs');
const { runCodex } = require('./codex.cjs');
const { runAcp } = require('./acp.cjs');
const { runDsh } = require('./dsh.cjs');
const { createAuthStore, parseAuthStatus } = require('./auth.cjs');
const claudePath = require('./claude-path.cjs');
const perm = require('./perm.cjs');
const skills = require('./skills.cjs');
const browser = require('./browser.cjs');
const { createScrubber } = require('./scrub.cjs');
const services = require('./services.cjs');
const acpAgents = require('./acp-agents.cjs');
const net = require('./net.cjs');
const { buildCompatEnv } = require('./compat-env.cjs');

/** Claude 的认证路径 / API 预算 / 会话费用账本（只存数字和开关）。 */
let authStoreCache = null;
const authStore = () => (authStoreCache || (authStoreCache = createAuthStore(app.getPath('userData'))));

/** The programs this app may start. The page picks a driver id; the binary and fixed args live here — in catalog/drivers.json (Claude Code,
 *  Codex, DeepSeek Harness) and catalog/acp-agents.json (every command-line agent that speaks ACP: Kimi, Qwen Code, MiniMax Code, Gemini CLI…). */
/** @returns {{ bin: string, bins: string[], label: string, login: string[] | null, loginHint: string, acpArgs?: string[], agent?: string } | null} */
function driverDef(id) {
  const cat = services.catalog();
  const builtin = cat.driverById.get(String(id));
  if (builtin && ['claude-code', 'codex', 'dsh'].includes(builtin.id)) return { bin: builtin.bin, bins: [builtin.bin], label: builtin.id === 'codex' ? 'Codex' : builtin.label, login: builtin.loginArgs, loginHint: builtin.loginHint };
  // A command-line agent (the catalog's, or one the user added): its names, login command and fixed arguments come from its definition.
  const agentId = services.agentIdOfDriver(id);
  return agentId ? acpAgents.instance().driverDef(agentId) : null;
}

/** Where the DeepSeek Harness desktop app keeps its CLI when it is not on PATH. */
function dshCandidates() {
  const rel = path.join('resources', 'runtime', 'cli', 'bin', 'dsh.cmd');
  // Only places a normal user cannot plant a dsh.cmd for someone else; anything else goes in 命令路径.
  const roots = [
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness'),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'DeepSeek Harness'),
  ].filter(Boolean);
  return roots.map((r) => path.join(r, rel));
}

/** CLIs that AIROOM installed for its members live under its data folder, off PATH:
 *  <data>/members/<bin>/<version>/node_modules/.bin/<bin>.cmd — newest version first. */
function managedCandidates(bin) {
  const roots = [process.env.AIROOM_DATA_DIR, process.env.APPDATA && path.join(process.env.APPDATA, 'AIROOM', 'data')].filter(Boolean);
  const out = [];
  for (const root of roots) {
    const dir = path.join(root, 'members', bin);
    let versions = [];
    try { versions = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const v of versions) out.push(path.join(dir, v, 'node_modules', '.bin', `${bin}.cmd`));
  }
  return out;
}

function exeFor(driverId, custom) {
  // Command-line agents: PATH, AIROOM's managed copy, the 命令路径 setting, the file a user-added agent was registered with, or npx / uvx with a pinned spec.
  const agentId = services.agentIdOfDriver(driverId);
  if (agentId) return acpAgents.instance().exeFor(agentId, custom);
  const d = driverDef(driverId);
  if (!d) return null;
  if (custom) return fs.existsSync(custom) && /\.(cmd|exe|bat)$/i.test(custom) ? custom : null;
  for (const bin of d.bins) { const found = resolveCommand(bin); if (found) return found; }
  const extra = [...d.bins.flatMap((b) => managedCandidates(b)), ...(driverId === 'dsh' ? dshCandidates() : [])];
  return extra.find((p) => fs.existsSync(p)) || null;
}

/** 检测和登录用的 claude：用户自己的优先，没有就用 SDK 随包的（界面会说明）。 */
function claudeExe(custom) {
  const own = exeFor('claude-code', custom);
  if (own) return { exe: own, bundled: false };
  const bundled = claudePath.sdkBundledExe();
  return bundled ? { exe: bundled, bundled: true } : { exe: null, bundled: false };
}

const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);

/* The page no longer sends a request body, an address or environment variables (MODELS-SPEC I1): reasoning fields come from effort-wire.cjs,
   addresses from services.cjs, environments from compat-env.cjs / the agent's own definition. What is left here is the last internal
   assertion over an environment the main process built itself: only names it expects, nothing else. */
const ENV_KEYS = /^(ANTHROPIC_(BASE_URL|MODEL|DEFAULT_(FABLE|OPUS|SONNET|HAIKU)_MODEL|SMALL_FAST_MODEL)|OPENAI_(BASE_URL|MODEL)|KIMI_MODEL_(NAME|BASE_URL|PROVIDER_TYPE|MAX_CONTEXT_SIZE)|API_TIMEOUT_MS|CLAUDE_CODE_(DISABLE_NONESSENTIAL_TRAFFIC|MAX_OUTPUT_TOKENS|SUBAGENT_MODEL|AUTO_COMPACT_WINDOW|MAX_CONTEXT_TOKENS|EFFORT_LEVEL))$/;
const KEY_ENVS = new Set(['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'KIMI_MODEL_API_KEY']);
/** Set by the main process for claude-compat only (never from the page). */
const COMPAT_ENV_EXTRA = new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB']);
/** Names that may appear in the environment of a run: the known list, plus the names the agent's definition declares. */
function envProblem(env, extraNames = []) {
  const allowed = new Set([...KEY_ENVS, ...COMPAT_ENV_EXTRA, ...extraNames]);
  for (const k of Object.keys(env)) if (!ENV_KEYS.test(k) && !allowed.has(k)) return k;
  return '';
}

function workspaceRoot() { return path.join(app.getPath('userData'), 'workspaces'); }
/** 桌宠联网答疑的工作文件夹 = workspaceFolder('pet') 给出的那个（应用自己建的空目录）. */
function petWorkspace() { return path.join(workspaceRoot(), 'pet'); }
/** Windows 上不分大小写；两边都过一遍 realpath（目录被换成联接点也还是同一个地方才算）. */
function samePath(a, b) {
  const norm = (p) => { let r = path.resolve(p); try { r = fs.realpathSync(r); } catch { /* not there */ } return isWin ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}
/** 桌宠的运行里，命令行模型能用的工具. */
const PET_WEB_TOOLS = new Set(['WebSearch', 'WebFetch']);

function checkDir(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) return null;
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/* Secrets never go back to the page: whole strings are scrubbed, and streamed text / thinking deltas are
   scrubbed statefully (a key split across two deltas would otherwise slip through). See scrub.cjs. */

/* ───────────── streamed runs ───────────── */

const streams = new Map(); // id → { ctl, sender, stopRequested }
let streamSeq = 0;

const PHASES = new Set(['plan', 'step', 'chat']);
const TRUST = new Set(['T0', 'T1', 'T2']);
/** 两个信任级别里较低的那个（T0 < T1 < T2）；other 为空就是 level. */
const lowerTrust = (level, other) => (other && Number(other[1]) < Number(level[1]) ? other : level);

/** The message when a saved key is not allowed to go to the host an address now points at (see services.cjs destinationProblem). */
const hostBlockedText = (service, host) => `${service.name} 的服务地址现在指向 ${host}，这个主机还没有经过你确认，所以不会发送密钥。请到「模型接入」里重新保存这个服务的密钥，栖枝会先问你一次。`;

/** The live model list of a service from the cache only (never the network): [{ id, effort }] for the entries that carry a spec. */
async function liveEffortsOf(reg, service, ep, spec) {
  if (!service.modelsApi || !ep) return undefined;
  try {
    const lm = await services.modelsApi(reg).listModels({ service: service.id, endpoint: ep.id, params: spec.params, cacheOnly: true });
    const list = lm && Array.isArray(lm.models) ? lm.models.filter((m) => m && typeof m.id === 'string' && m.effort && typeof m.effort === 'object').map((m) => ({ id: m.id, effort: m.effort })) : [];
    return list.length ? list : undefined;
  } catch { return undefined; }
}

/** 页面用 StartSpec 描述要跑什么；这里决定真正启动哪个程序、注入密钥、选驱动。ID 同步返回，真正的启动在后面异步进行（读密钥可能是异步的）。 */
function startStream(sender, spec, internal = {}) {
  const id = `s${Date.now().toString(36)}${(++streamSeq).toString(36)}`;
  const emit = (ev) => { if (!sender.isDestroyed()) sender.send('ai:event', { id, ...ev }); };
  const entry = { ctl: null, sender, stopRequested: null };
  streams.set(id, entry);
  const end = () => { streams.delete(id); };
  const attach = (ctl) => {
    entry.ctl = ctl;
    ctl.done.then(end);
    // 启动期间用户已经点了停止：补上
    if (entry.stopRequested) { if (entry.stopRequested === 'interrupt') ctl.interrupt(); else ctl.stop(); }
  };
  const fail = (message, code = 'CONFIG') => { setImmediate(() => { emit({ type: 'error', message, code }); end(); }); return id; };

  const run = async () => {
    const notices = [];
    const queueNotice = (text, level = 'info') => { notices.push({ type: 'notice', level, text }); };
    const reg = services.instance();
    const provider = String(spec.provider || '');
    const service = reg.get(provider);
    if (!service) return fail('未知的模型服务。');

    // 'api' is the new spelling; the page used to say api-openai / api-anthropic — the protocol now comes from the service
    if (spec.driver === 'api' || spec.driver === 'api-openai' || spec.driver === 'api-anthropic') {
      // Address, headers, body fields, output limit and reasoning fields are all decided here from the registry; whatever the page
      // sent as baseUrl / extraBody is not read for that (a legacy baseUrl only helps pick WHICH of the registry's own endpoints).
      let rr = reg.resolveApi(spec, { test: !!internal.test });
      if (!rr.ok) return fail(rr.error, rr.code === 'PLAN_KEY' ? 'PLAN_KEY' : 'CONFIG');
      // What this account's live model list says about the model (cache only, no network): the menus on the page are built from the same
      // list, so a level the page offers is a level the request sends. A service with no live list simply has no entries.
      const live = await liveEffortsOf(reg, service, rr.r.endpoint, spec);
      if (live) { rr = reg.resolveApi(spec, { test: !!internal.test, live }); if (!rr.ok) return fail(rr.error, rr.code === 'PLAN_KEY' ? 'PLAN_KEY' : 'CONFIG'); }
      const r = rr.r;
      const blocked = reg.destinationProblem(service, r.endpoint);
      if (blocked) return fail(hostBlockedText(service, blocked), 'CONFIG');
      const key = await reg.readKey(service, r.endpoint);
      if (!key && !r.auth.keyOptional) return fail(r.endpoint.separateKey ? `这个地区（${r.endpoint.label}）还没有保存 ${service.name} 的 API Key。` : '还没有保存这个服务的 API Key。');
      const ac = new AbortController();
      entry.ctl = { stop: () => ac.abort(), interrupt: () => ac.abort() };
      // A gateway can echo the key back in an error, and a key can be split across two streamed deltas: everything goes through the scrubber.
      const scrub = createScrubber(key || undefined, emit);
      for (const n of r.notices) scrub.emit({ type: 'notice', level: n.level, text: n.text });
      const runApi = r.protocol === 'anthropic' ? streamAnthropic : streamOpenAI;
      runApi(r, key || '', scrub.emit, ac.signal)
        .then((res) => scrub.emit({ type: 'done', text: res.text, stopReason: res.stopReason }))
        .catch((e) => {
          if (e.code === 'ABORTED') scrub.emit({ type: 'done', text: '', stopReason: 'interrupted' });
          else scrub.emit({ type: 'error', message: e.message || String(e), code: e.code || 'API_ERROR' });
        })
        .finally(end);
      if (entry.stopRequested) ac.abort();
      return id;
    }

    // Which program: a built-in driver, or a command-line agent (legacy 'kimi' | 'qwen' | 'mcode', 'acp' + spec.acp, or 'acp:<id>')
    const agentId = services.agentIdOfDriver(spec.driver, spec.acp || spec.agent);
    const driverId = agentId || (spec.driver === 'claude-compat' ? 'claude-code' : spec.driver);
    const drv = driverDef(agentId ? `acp:${agentId}` : driverId);
    if (!drv || (agentId && !drv.acpArgs)) return fail('未知的命令行工具。');
    // the service must list this driver: a vendor's key is never handed to another vendor's tool
    if (!agentId && !service.drivers.includes(spec.driver)) return fail(`${service.name} 不支持这个命令行工具。`);
    // 桌宠的运行（spec.pet）：带工具的（联网答疑）只用 Claude Code —— 只有它能在这里把工具集限制成 WebSearch / WebFetch（SDK 驱动和旧驱动
    // 各自落实，不靠页面）；Codex、DeepSeek Harness、ACP 代理做不到，遇到 pet + work 直接拒绝（先于找不找得到命令）.
    const petRun = spec.pet === true && !internal.test;
    if (petRun && spec.access !== 'chat' && driverId !== 'claude-code') return fail('桌宠的联网答疑只用 Claude Code：这个命令行工具没法把可用的工具限制成只有联网搜索，所以不让它带工具运行。', 'CONFIG');
    // Claude Code（自己的登录）可以走 Agent SDK：这时没有 claude 命令也能用 SDK 随包的二进制，所以"找不到"留给驱动判断。
    const authCfg = authStore().getConfig();
    const sdkRoute = spec.driver === 'claude-code' && authCfg.useSdk;
    const exe = exeFor(agentId ? `acp:${agentId}` : driverId, spec.path);
    if (!exe && !sdkRoute) return fail(`找不到 ${drv.label} 命令。请先安装，或在「模型接入」里填写它的路径。`, 'ENOENT');
    const cwd = checkDir(spec.cwd);
    if (!cwd) return fail('工作文件夹不存在，请重新选择。', 'ENOENT');
    // 桌宠的运行：不管有没有工具，cwd 都必须正好是应用自己建的 pet 工作文件夹；带工具的（联网答疑）一律只读，工具集只有 WebSearch / WebFetch.
    // 这个文件夹在 <userData>/workspaces/ 下，信任账本本来就当它是 T1（应用自己建的空目录）：不弹「目录未信任」，也不需要为它放宽别的目录.
    if (petRun && !samePath(cwd, petWorkspace())) return fail('桌宠只在栖枝自己的 pet 工作文件夹里运行命令行模型。', 'CONFIG');
    const onlyTools = petRun && spec.access !== 'chat' ? [...PET_WEB_TOOLS] : undefined;

    // The environment is built HERE: the page's env / keyEnv are not read (MODELS-SPEC I1, §12.4).
    const env = {};
    let emitOut = emit;
    let compatModel;
    let declared = [];
    let agentDef;
    if (spec.driver === 'claude-compat') {
      // Another vendor's Anthropic-compatible endpoint (the registry's own address), with that vendor's key.
      const c = reg.resolveCompat(spec);
      if (!c.ok) return fail(c.error);
      compatModel = c.model;
      const blocked = reg.destinationProblem(service, c.endpoint);
      if (blocked) return fail(hostBlockedText(service, blocked), 'CONFIG');
      const key = await reg.readKey(service, c.endpoint);
      if (!key && !c.keyOptional) return fail('这个方式需要 API Key，请先在「模型接入」里保存。');
      // keep its sessions and settings apart from the user's own Claude Code
      const dir = path.join(app.getPath('userData'), 'claude-compat', provider);
      fs.mkdirSync(dir, { recursive: true });
      Object.assign(env, buildCompatEnv({ url: c.url, model: c.model, ctx: c.ctx, autoCompactWindow: c.autoCompactWindow, configDir: dir }));
      // a keyless local server still needs SOME token for Claude Code to start (the vendors' guides use the service name)
      env.ANTHROPIC_AUTH_TOKEN = key || service.id;
      // The agent's shell inherits the key; never let it come back to the page (tool output, text…).
      if (key) emitOut = createScrubber(key, emit).emit;
    } else if (agentId) {
      // a catalog agent goes through the service registry; one the user added has no vendor and is resolved from its own definition
      const a = acpAgents.instance().resolveEnv(spec);
      if (!a.ok) return fail(a.error);
      agentDef = a.agent;
      Object.assign(env, a.env);
      declared = [...Object.keys(a.env), ...(a.keyEnv ? [a.keyEnv] : [])];
      if (a.keyEnv) {
        const blocked = reg.destinationProblem(a.service, a.endpoint);
        if (blocked) return fail(hostBlockedText(a.service, blocked), 'CONFIG');
        const key = await reg.readKey(a.service, a.endpoint);
        if (!key && !a.keyOptional) return fail('这个方式需要 API Key，请先在「模型接入」里保存。');
        if (key) { env[a.keyEnv] = key; emitOut = createScrubber(key, emit).emit; }
      }
    }
    const badEnv = envProblem(env, declared);
    if (badEnv) return fail(`内部错误：环境变量 ${badEnv} 不在允许的名单里，已拒绝启动。`, 'CONFIG');
    if (spec.sessionId && !/^[\w.:-]{1,100}$/.test(String(spec.sessionId))) return fail('会话 ID 格式不对。');
    if (spec.effort && !EFFORTS.has(String(spec.effort))) return fail('不支持的强度档位。');
    // Model names go on the command line (and into URLs): the same rule as for the API way.
    if (spec.model && !net.checkModelId(String(spec.model))) return fail('模型名里有不支持的字符。');

    // 输入框里的权限模式、信任级别、阶段（计划 / 执行）：只认已知值
    const pmode = perm.PAGE_MODES.includes(spec.permissionMode) ? spec.permissionMode : undefined;
    // 信任级别以主进程的账本（electron/trust.cjs）为准：页面报的级别最多只能把它往下调，不能抬高——
    // 页面被带偏（或输入框有 bug）报 'T1' 也不能让没确认过的目录变成可写. 闲聊没有工具，沿用页面报的.
    const pageTrust = TRUST.has(spec.trust) ? spec.trust : undefined;
    const trust = spec.access === 'chat' ? pageTrust : lowerTrust(require('../trust.cjs').levelOf(cwd), pageTrust);
    const phase = PHASES.has(spec.phase) ? spec.phase : undefined;
    const readOnly = !!spec.readOnly || trust === 'T0' || petRun;
    // 页面选了「计划」：只有计划阶段是只读的，批准之后的执行阶段按逐项处理（Codex / DSH / ACP 都用这个，不要再停在只读里）
    const effMode = perm.effectiveMode(pmode, phase);
    // 账本说是 T0、页面却没报 T0（旧任务、建任务之后撤销了信任）：以账本为准按只读运行，并说明，免得用户以为是故障
    if (spec.access !== 'chat' && !spec.readOnly && !petRun && trust === 'T0' && pageTrust !== 'T0') queueNotice('这个目录当前没有被信任（可能刚在设置里撤销了），这次按只读运行。要让它动手，请先在输入框里确认信任这个目录。', 'warn');
    // DeepSeek Harness has no per-call approvals: chat and 只读 run it in its read-only mode.
    if (driverId === 'dsh') {
      const plan = perm.dshPlan(effMode);
      Object.assign(env, plan.env);
      if (spec.access === 'chat' || readOnly || phase === 'plan') env.DSH_PERMISSION_MODE = 'read-only';
      else if (plan.note && effMode && effMode !== 'ask') queueNotice(plan.note);
    }

    // claude-compat carries its model in the environment (ANTHROPIC_MODEL…); the other drivers take it as an argument
    const common = { exe, cwd, prompt: String(spec.prompt || ''), system: spec.system ? String(spec.system) : '', sessionId: spec.sessionId || undefined, model: compatModel ? undefined : spec.model || undefined, effort: spec.effort || undefined, env };
    const emitCli = (ev) => emitOut(ev);
    // 浏览器控制: hand the agent the alight-browser MCP server (not in chat, not for DSH).
    const ep = spec.browser && spec.access !== 'chat' && !readOnly && driverId !== 'dsh' ? browser.getEndpoint() : null;
    const mcp = ep ? browser.mcpLaunch(ep) : null;
    try {
      if (driverId === 'claude-code') {
        // 桌宠只放行 WebSearch / WebFetch（别的写在 allow 里也不算），也不带技能文件夹.
        const allow = (spec.allow || []).filter((t) => /^[\w*:().\- ]{1,80}$/.test(t) && (!petRun || PET_WEB_TOOLS.has(t)));
        const deny = (spec.deny || []).filter((t) => /^[\w*:().\- ]{1,80}$/.test(t));
        // The skills folder lives outside the working folder: let Claude Code read it.
        const addDirs = spec.skills && !petRun ? [skills.root()] : [];
        const access = spec.access === 'chat' ? 'chat' : 'work';

        // 认证路径：默认是用户自己登录的 claude；「API 密钥」是明示选项，带日 / 月硬预算，按量计费
        let apiKeyMode = false;
        let maxBudgetUsd;
        let sdkPmode = pmode;
        if (spec.driver === 'claude-code' && authCfg.mode === 'apikey') {
          const check = authStore().budgetCheck();
          if (check.level === 'stop') return fail(check.message, 'BUDGET');
          // 预算靠 SDK 的 maxBudgetUsd 兜底、花费靠 SDK 的会话账本核算：旧驱动做不到，就不让 API 密钥走旧驱动
          if (!sdkRoute) return fail('API 密钥路径需要用 Agent SDK 驱动（预算靠它核算和兜底）。请到「模型接入」关掉「改用旧驱动」，或改回已登录的 claude。', 'CONFIG');
          const key = await Promise.resolve(secrets.get('claude'));
          if (!key) return fail('你选择了用 API 密钥，但还没有保存 Claude 的 API Key。请到「模型接入」里保存，或改回已登录的 claude。', 'CONFIG');
          env.ANTHROPIC_API_KEY = key;
          emitOut = createScrubber(key, emit).emit;
          apiKeyMode = true;
          // 模型运行的命令（Bash / PowerShell、钩子、MCP stdio）默认继承环境，读得到这把真密钥，提示注入一句 curl 就能外传：
          // 让 claude 把凭据从子进程环境里剥掉（claude 自己调 API 不受影响）。实测副作用：claude 因此把权限模式强制回 default，
          // 所以这条路径只开逐项 / 计划——接受编辑、自动、放手在这里如实降级，不假装生效.
          env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1';
          if (pmode === 'acceptEdits' || pmode === 'auto' || pmode === 'bypass') {
            sdkPmode = 'ask';
            queueNotice(`API 密钥路径下命令不能自动放行：为防止命令读到密钥，「${perm.MODE_LABEL[pmode]}」已降级为逐项确认。`);
          }
          maxBudgetUsd = check.remainingUsd;
          queueNotice(`这次用 API 密钥，按用量计费（不是订阅额度）。今日 $${check.today.toFixed(2)} / $${check.dailyUsd}，本月 $${check.monthTotal.toFixed(2)} / $${check.monthlyUsd}。`);
          if (check.level === 'warn') queueNotice(check.message, 'warn');
        }
        const outEmit = emitCli;

        const legacy = (s2, e2) => {
          if (apiKeyMode) {
            e2({ type: 'error', message: 'Agent SDK 驱动没能启动，而 API 密钥路径不能退回旧驱动（预算无法核算）。请检查 claude 的版本，或先改回已登录的 claude。', code: 'CONFIG' });
            return { done: Promise.resolve(), send() {}, answer() {}, interrupt() {}, stop() {} };
          }
          const own = claudePath.resolveUserClaudeExe(spec.path) || exe;
          if (!own) { e2({ type: 'error', message: '找不到 claude 命令，旧的 stream-json 驱动也没法启动。', code: 'ENOENT' }); return { done: Promise.resolve(), send() {}, answer() {}, interrupt() {}, stop() {} }; }
          // 旧驱动没有钩子也没有提问卡：AskUserQuestion / ExitPlanMode 仍然关掉；只读（账本 T0 / 只读任务 / 计划阶段）由主进程自己落实，
          // 不能只信页面给的 allow / deny（旧任务、建任务后撤销了信任，页面不会重新问也不会发 T0）
          const lp = perm.legacyPolicy({ allow, deny, pageMode: pmode, phase, readOnly });
          const m = { mode: lp.mode, note: lp.note };
          if (m.note) e2({ type: 'notice', level: 'info', text: m.note });
          const mcpJson = mcp && /\.exe$/i.test(own) ? JSON.stringify({ mcpServers: { 'alight-browser': { type: 'stdio', command: mcp.command, args: mcp.args, env: mcp.env } } }) : undefined;
          if (mcp && !mcpJson) e2({ type: 'notice', level: 'warn', text: '旧驱动找不到 claude.exe，没法把栖枝浏览器交给它，这次不能操作浏览器。' });
          return runClaude({ ...common, exe: own, access, allow: lp.allow, deny: lp.deny, addDirs, mcpJson, onlyTools, permissionMode: m.mode, costDelta: (sid, total, resumed) => authStore().costDelta(sid, total, resumed) }, e2);
        };

        if (sdkRoute) {
          const configDir = env.CLAUDE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
          for (const n of notices.splice(0)) outEmit(n);
          attach(runClaudeSdk({
            cwd, prompt: common.prompt, system: common.system, sessionId: common.sessionId, model: common.model, effort: common.effort, env, path: spec.path || undefined,
            addDirs, access, allow, deny, mcp, permissionMode: sdkPmode, phase, readOnly, trust, apiKeyMode, maxBudgetUsd, onlyTools,
          }, outEmit, {
            sessionDelta: (sid, totals, resumed) => authStore().sessionDelta(sid, totals, resumed),
            addSpend: (usd) => authStore().addSpend(usd),
            plansRoot: path.join(configDir, 'plans'),
            fallback: legacy,
          }));
        } else {
          if (spec.driver === 'claude-code') outEmit({ type: 'notice', level: 'info', text: '已按设置改用旧的 stream-json 驱动：提问卡、计划审批和权限钩子不可用。' });
          for (const n of notices.splice(0)) outEmit(n);
          attach(legacy(spec, outEmit));
        }
        return id;
      }

      for (const n of notices.splice(0)) emitCli(n);
      if (driverId === 'codex') {
        const base = spec.sandbox === 'danger-full-access' || spec.sandbox === 'workspace-write' || spec.sandbox === 'read-only' ? spec.sandbox : 'workspace-write';
        const plan = perm.codexPlan(effMode, readOnly || spec.access === 'chat' ? 'read-only' : base);
        if (plan.note && spec.access !== 'chat' && !readOnly) emitCli({ type: 'notice', level: 'info', text: plan.note });
        attach(runCodex({ ...common, sandbox: phase === 'plan' ? 'read-only' : plan.sandbox, webSearch: !!spec.webSearch, mcp }, emitCli));
      } else if (driverId === 'dsh') {
        attach(runDsh(common, emitCli));
      } else {
        attach(runAcp({ ...common, args: drv.acpArgs, access: spec.access === 'chat' ? 'chat' : 'work', label: drv.label, mcp, agent: agentId, agentDef,
          // npx / uvx agents start in an empty folder of the app's own (a repository's .npmrc / uv.toml must not decide where the package comes from)
          spawnCwd: acpAgents.instance().spawnCwdFor(agentId),
          // 只读（T0 / 只读任务 / 计划阶段 / 闲聊）：acp.cjs 要把这个意思落实——设不成只读相关的模式就不启动，写入 / 命令类权限请求直接拒绝
          readOnly: readOnly || phase === 'plan' || spec.access === 'chat',
          // 闲聊没有工具：不进计划模式（那会改变回答的写法），只保证不停在上次残留的 auto / yolo 上（default）
          pageMode: spec.access === 'chat' ? undefined : phase === 'plan' || readOnly ? 'plan' : effMode }, emitCli));
      }
    } catch (e) {
      return fail(`启动失败：${e.message}`, 'SPAWN');
    }
    return id;
  };
  run().catch((e) => fail(`启动失败：${e && e.message || e}`, 'SPAWN'));
  return id;
}

/* ───────────── live model lists ───────────── */

const modelCache = new Map(); // driver → { at, list }

/** Codex knows which models the signed-in account can use and their effort levels (app-server model/list). */
function codexModels(exe) {
  return new Promise((resolve) => {
    let done = false;
    let child;
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { killTree(child); } catch { /* gone */ } resolve(v); };
    const timer = setTimeout(() => finish(null), 20000);
    const send = (o) => { try { child.stdin.write(`${JSON.stringify(o)}\n`); } catch { /* closed */ } };
    child = spawnCli(exe, ['app-server'], {
      cwd: os.homedir(),
      onLine: (line) => {
        let ev; try { ev = JSON.parse(line); } catch { return; }
        if (ev.id === 1) { send({ jsonrpc: '2.0', method: 'initialized', params: {} }); send({ jsonrpc: '2.0', id: 2, method: 'model/list', params: {} }); }
        else if (ev.id === 2) {
          const data = (ev.result && ev.result.data) || [];
          finish(data.filter((m) => !m.hidden && typeof m.id === 'string').map((m) => ({
            id: m.id,
            label: String(m.displayName || m.id),
            note: String(m.description || '').slice(0, 80),
            efforts: (m.supportedReasoningEfforts || []).map((e) => String(e.reasoningEffort || e)).filter((e) => EFFORTS.has(e)),
            defaultEffort: EFFORTS.has(m.defaultReasoningEffort) ? m.defaultReasoningEffort : undefined,
            isDefault: !!m.isDefault,
          })));
        }
      },
    });
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'Alight', title: '栖枝', version: '2.0.0' } } });
  });
}

async function listModels({ driver, path: custom, fresh }) {
  // a command-line agent: whatever the last 「读取模型与模式」 saw (this never starts a process by itself)
  const agentId = services.agentIdOfDriver(driver);
  if (agentId) return acpAgents.instance().liveModels(agentId);
  if (driver !== 'codex') return null;
  const hit = modelCache.get(driver);
  if (hit && !fresh && Date.now() - hit.at < 3_600_000) return hit.list;
  const exe = exeFor(driver, custom);
  if (!exe) return null;
  const list = await codexModels(exe);
  if (list && list.length) modelCache.set(driver, { at: Date.now(), list });
  return list;
}

/* ───────────── detection & login ───────────── */

async function detect({ driver, path: custom }) {
  const d = driverDef(driver === 'claude-compat' ? 'claude-code' : driver);
  if (!d) return { found: false, detail: '未知的命令行工具' };
  for (const b of d.bins) forgetCommand(b);
  // look the names up off the main thread first (the page detects every CLI at startup); exeFor below then reads the cache
  await prefetchCommands([...d.bins, ...(d.agent ? ['npx', 'uvx'] : [])]);
  const isClaude = driver === 'claude-code' || driver === 'claude-compat';
  let exe;
  let bundled = false;
  if (isClaude) {
    // 默认用用户自己的 claude；没有的话用 SDK 随包的，并在界面里说明
    const c = claudeExe(custom);
    exe = c.exe;
    bundled = c.bundled;
  } else {
    exe = exeFor(driver, custom);
  }
  if (!exe) return { found: false, detail: custom ? '这个路径不存在，或不是可执行文件' : `PATH 里没有找到 ${d.bins.join(' 或 ')}` };
  const cwd = os.tmpdir();
  const v = await runOnce(exe, ['--version'], { cwd, timeoutMs: 20000 });
  const version = (v.out || v.err).split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
  const out = { found: true, path: exe, version: version.slice(0, 80), login: 'unknown' };
  if (bundled) out.detail = '没有找到你自己装的 claude，用的是栖枝随包的版本（登录状态仍然是你电脑上 claude 的登录，栖枝不碰令牌）。';
  if (driver === 'claude-code') {
    // 只显示 `claude auth status --json` 的结果；不读凭据文件，不替用户登录
    // 「已登录」路径会去掉环境里的 ANTHROPIC_API_KEY / AUTH_TOKEN，检测也要在同样的环境里看，免得显示成 api_key
    const s = await runOnce(exe, ['auth', 'status', '--json'], { cwd, env: { ANTHROPIC_API_KEY: undefined, ANTHROPIC_AUTH_TOKEN: undefined }, timeoutMs: 20000 });
    const st = parseAuthStatus(s.out);
    if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
      out.detail = `${out.detail ? `${out.detail} ` : ''}你的环境变量里设了 ANTHROPIC_API_KEY：栖枝走「已登录」路径时会忽略它，不会悄悄改成 API 计费。`;
    }
    if (st) {
      out.login = st.loggedIn ? 'yes' : 'no';
      out.account = st.text;
    }
  } else if (driver === 'codex') {
    const s = await runOnce(exe, ['login', 'status'], { cwd, timeoutMs: 20000 });
    const text = `${s.out}\n${s.err}`;
    if (/not logged in/i.test(text)) out.login = 'no';
    else if (/logged in/i.test(text)) { out.login = 'yes'; out.account = (text.match(/logged in using ([^\r\n]+)/i) || [])[1] || ''; }
  } else if (driver === 'claude-compat') {
    out.login = 'n/a';
  }
  return out;
}

function openLogin({ driver, path: custom }) {
  const d = driverDef(driver);
  if (!d) return { ok: false, error: '未知的命令行工具' };
  if (!d.login) return { ok: false, error: d.loginHint };
  const exe = driver === 'claude-code' ? claudeExe(custom).exe : exeFor(driver, custom);
  if (!exe) return { ok: false, error: `找不到 ${d.bin} 命令` };
  if (!isWin) return { ok: false, error: `请在终端运行：${d.bin} ${d.login.join(' ')}` };
  // A small PowerShell script in a visible console: the user signs in there themselves. Not a .cmd:
  // cmd.exe reads batch files by byte offset, so Chinese lines after `chcp 65001` come out garbled
  // and half a line can even run as a command.
  // driver ids like `acp:gemini` contain a colon, which is not allowed in a Windows file name.
  const file = path.join(os.tmpdir(), `alight-login-${String(driver).replace(/[^\w.-]+/g, '_')}.ps1`);
  fs.writeFileSync(file, loginScript(d, exe), 'utf8');
  const child = spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `start "" powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${file}"`], { windowsVerbatimArguments: true, detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
  return { ok: true, command: `${d.bin} ${d.login.join(' ')}` };
}

/** The login window's script: UTF-8 with a BOM (what Windows PowerShell 5.1 needs), every value a
    single-quoted literal so nothing in a path or a hint can run as code. */
function loginScript(d, exe) {
  const ps = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const lines = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$Host.UI.RawUI.WindowTitle = ${ps(`${d.label} 登录 - 栖枝`)}`,
    `Write-Host ${ps(d.loginHint)} -ForegroundColor Cyan`,
    `Write-Host ${ps('完成后关闭这个窗口，回到栖枝点「检测」。栖枝不会替你登录，也不会读取或保存登录令牌。')}`,
    'Write-Host',
    `& ${ps(exe)} ${d.login.map(ps).join(' ')}`,
    '$code = $LASTEXITCODE',
    'Write-Host',
    `if ($code -eq 0) { Write-Host ${ps('登录命令已结束。上面显示已登录（Logged in）的话，就可以关闭窗口，回到栖枝点「检测」。')} -ForegroundColor Green }`,
    `else { Write-Host (${ps('登录命令退出（代码 ')} + $code + ${ps('）。如果上面已经显示登录成功，可以忽略；否则请再试一次。')}) -ForegroundColor Yellow }`,
    `Write-Host ${ps('提示：命令结束时如果出现 Assertion failed 之类的英文，是这个命令行工具退出时自己的提示，不影响登录结果。')} -ForegroundColor DarkGray`,
    'Write-Host',
    `[void](Read-Host ${ps('按回车关闭这个窗口')})`,
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** A tiny round trip that proves the connection works (one chat turn). */
function testChat(sender, spec) {
  return new Promise((settle) => {
    const started = Date.now();
    let text = '';
    let model = '';
    let timer;
    const resolve = (r) => { clearTimeout(timer); settle(r); };
    const isCli = !(spec.driver === 'api' || String(spec.driver).startsWith('api-'));
    let cwd = spec.cwd;
    if (isCli) {
      cwd = path.join(workspaceRoot(), '_connection-test');
      fs.mkdirSync(cwd, { recursive: true });
    }
    const id = startStream({
      isDestroyed: () => false,
      send: (_ch, ev) => {
        if (ev.type === 'text') text += ev.text;
        else if (ev.type === 'model') model = ev.model;
        else if (ev.type === 'done') resolve({ ok: true, text: (text || ev.text || '').trim().slice(0, 200), ms: Date.now() - started, model });
        else if (ev.type === 'error') resolve({ ok: false, error: ev.message, code: ev.code, ms: Date.now() - started });
      },
    }, { ...spec, cwd, access: 'chat', sandbox: 'read-only', prompt: '连通性测试：请只回复两个字母 OK。', messages: [{ role: 'user', content: '连通性测试：请只回复两个字母 OK。' }], maxTokens: 64, system: '' }, { test: true });
    timer = setTimeout(() => {
      const s = streams.get(id);
      if (s && s.ctl) s.ctl.stop();
      resolve({ ok: false, error: '超过 2 分钟没有完成', code: 'ETIMEDOUT', ms: Date.now() - started });
    }, 120_000);
  });
}

/**
 * 「测试连接」: for the API way two steps — 拉模型列表 (costs no tokens; it is only a hint: many services have no list, and a failure here does not fail
 * the test) then one tiny chat turn; for a command-line tool one step. `steps` lets the card say 「拉列表 ✓ 0.4 秒 · 对话 ✓ 1.2 秒」.
 */
async function test(sender, spec) {
  const isCli = !(spec.driver === 'api' || String(spec.driver).startsWith('api-'));
  const steps = [];
  if (!isCli) {
    const t0 = Date.now();
    try {
      const reg = services.instance();
      const service = reg.get(String(spec.provider || ''));
      if (service && service.modelsApi) {
        const r = await services.modelsApi(reg).listModels({ service: service.id, endpoint: spec.endpoint, params: spec.params, fresh: true });
        if (r.source === 'live') steps.push({ name: 'models', ok: true, ms: Date.now() - t0, detail: `${r.models.length} 个模型` });
        // a service that simply has no list (404), no key yet, or a plan channel is not a failed step: there was nothing to try
        else if (r.error && r.code !== 'NO_KEY' && r.code !== 'PLAN_KEY' && r.code !== 'NO_LIST') steps.push({ name: 'models', ok: false, ms: Date.now() - t0, detail: String(r.error).slice(0, 160) });
      }
    } catch { /* the list is only a hint */ }
  }
  const res = await testChat(sender, spec);
  steps.push({ name: isCli ? 'cli' : 'chat', ok: !!res.ok, ms: res.ms, detail: res.ok ? `回复「${res.text || '（空）'}」` : String(res.error || '').slice(0, 160) });
  return { ...res, steps };
}

/* ───────────── IPC ───────────── */

/** Only the app's own page may call the model / skills / browser handlers. main.cjs passes its identity check (isAppSender: the main
 *  window's own web contents, in its top frame, still on dist/index.html — either spelling of that address); it is the same one the
 *  shell and the 桌宠 use. Without one (this file loaded on its own in a check) the old rule holds: the frame's address is dist/index.html. */
const APP_URL = require('node:url').pathToFileURL(path.join(__dirname, '..', '..', 'dist', 'index.html')).href;
let appSender = null;
function fromApp(e) {
  if (appSender) return appSender(e) === true;
  const url = e && e.senderFrame && e.senderFrame.url;
  return typeof url === 'string' && url.split('#')[0] === APP_URL;
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('拒绝：调用不是来自栖枝页面');
    return fn(e, ...args);
  });
}

/* Keys live in slots: `<service>` or, for endpoints that each need their own key, `<service>:<endpoint>`. The page names (service, endpoint);
   the slot is computed here, so the page cannot invent one. */
function slotOfRequest(provider, endpoint) {
  const reg = services.instance();
  const service = reg.get(String(provider));
  if (!service) return { error: '未知的模型服务' };
  if (endpoint === undefined || endpoint === null || endpoint === '') return { service, slot: service.id, ep: reg.defaultEndpoint(service, 'api') || service.endpoints[0] };
  const ep = reg.endpointOf(service, String(endpoint));
  return ep ? { service, slot: reg.slotFor(service, ep), ep } : { error: '没有这个地区 / 通道' };
}
/** @param {(o: object) => Promise<boolean>} confirm  a native yes/no (never the page) */
async function saveKeyOp(provider, key, endpoint, confirm) {
  const s = slotOfRequest(provider, endpoint);
  if (s.error) return { ok: false, error: s.error };
  try {
    // a custom service's key goes to an address the user typed: ask once, natively, where it will go
    if (!(await services.instance().confirmKeyDestination(s.service, s.ep, confirm))) return { ok: false, error: '已取消' };
    // an old single key that belonged to another region must not be overwritten by this region's key (GLM / Doubao)
    await services.instance().releaseLegacySlot(s.service, s.ep);
    return { ok: true, hint: await secrets.save(s.slot, key) };
  } catch (err) { return { ok: false, error: err.message }; }
}
async function clearKeyOp(provider, endpoint) {
  const s = slotOfRequest(provider, endpoint);
  if (s.error) return { ok: false, error: s.error };
  const reg = services.instance();
  const slots = endpoint ? reg.slotsToClear(s.service, s.ep) : [s.slot];
  for (const slot of slots) secrets.clear(slot);
  if (endpoint) reg.dropBinding(s.service, s.ep);
  return { ok: true };
}

/** 模型接入页要看的：认证路径、预算与已花费、有没有存密钥、用的是哪个 claude. */
async function claudeAuthView() {
  const st = authStore();
  const cfg = st.getConfig();
  const hints = await Promise.resolve(secrets.hints());
  await prefetchCommands(['claude']);
  const own = claudePath.resolveUserClaudeExe();
  const bundled = claudePath.sdkBundledExe();
  const check = st.budgetCheck();
  return {
    config: cfg,
    keySaved: !!hints.claude,
    spend: { day: check.day, today: check.today, month: check.month, monthTotal: check.monthTotal },
    budget: { applies: check.applies, level: check.level, message: check.message, remainingUsd: check.remainingUsd },
    exe: { own: own || null, bundled: bundled || null },
  };
}

/** @param {{ isAppSender?: (e: object) => boolean }} [host]  the shell's identity check for the main page (see fromApp) */
function register(host) {
  if (host && typeof host.isAppSender === 'function') appSender = host.isAppSender;
  // V0α modules register their own channels through the same sender check.
  require('../store/index.cjs').register(handle);
  require('../trust.cjs').register(handle);
  // 模型接入: the service registry's channels (svc:*) — also tells secrets.cjs which key slots exist.
  services.register(handle);
  // 命令行代理: acp:probe / registry / add-registry / add-custom / pick-exe / remove
  acpAgents.register(handle);
  // The bridge the browser MCP server calls back to (127.0.0.1, random port and token).
  browser.startBridge().catch(() => {});
  handle('browser:open', () => browser.open());
  handle('browser:clear', () => browser.clearData());
  // secrets.cjs 正在换成 safeStorage 的异步 API：这里一律 await，同步版和异步版都能用
  handle('ai:info', async () => ({
    encryption: await Promise.resolve(secrets.available()),
    keys: await Promise.resolve(secrets.hints()),
    workspaceRoot: workspaceRoot(),
    platform: process.platform,
  }));
  handle('ai:key:save', (e, provider, key, endpoint) => saveKeyOp(provider, key, endpoint, (o) => services.nativeConfirm(e, o)));
  handle('ai:key:clear', (_e, provider, endpoint) => clearKeyOp(provider, endpoint));
  // Claude 的认证路径与 API 计费预算（页面经 desktop.call 调用；通道前缀 usage: 在 preload 的允许列表里）
  handle('usage:claude-auth:get', async () => claudeAuthView());
  handle('usage:claude-auth:set', async (_e, patch) => {
    const p = patch && typeof patch === 'object' ? patch : {};
    // 选用 API 密钥之前，密钥必须已经存好（先存密钥、再切路径，不会出现「选了却没有密钥」）
    if (p.mode === 'apikey') {
      const hints = await Promise.resolve(secrets.hints());
      if (!hints.claude) return { ok: false, error: '还没有保存 Claude 的 API Key：请先保存密钥，再选用 API 密钥。' };
    }
    const r = authStore().setConfig(p);
    return r.ok ? { ok: true, view: await claudeAuthView() } : r;
  });
  handle('ai:detect', (_e, req) => detect(req || {}));
  handle('ai:models', (_e, req) => listModels(req || {}).catch(() => null));
  handle('ai:login', (_e, req) => openLogin(req || {}));
  handle('ai:test', (e, spec) => test(e.sender, spec || {}));
  handle('ai:folder:pick', async (e, start) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: '选择工作文件夹', defaultPath: checkDir(start) || undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0];
  });
  handle('ai:folder:workspace', (_e, name) => {
    const safe = String(name || 'task').replace(/[^\w.-]+/g, '_').slice(0, 60) || 'task';
    const dir = path.join(workspaceRoot(), safe);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  });
  handle('ai:folder:open', (_e, dir) => (checkDir(dir) ? shell.openPath(dir) : '文件夹不存在'));
  handle('ai:start', (e, spec) => startStream(e.sender, spec || {}));
  handle('ai:input', (_e, id, text) => {
    const s = streams.get(id);
    if (!s || !s.ctl || !s.ctl.send) return false;
    s.ctl.send(String(text));
    return true;
  });
  handle('ai:answer', (_e, id, requestId, decision, input) => {
    const s = streams.get(id);
    if (!s || !s.ctl || !s.ctl.answer) return false;
    s.ctl.answer(String(requestId), decision === 'allow' ? 'allow' : 'deny', input);
    return true;
  });
  handle('skills:list', () => { try { return skills.list(); } catch (e) { return { root: '', skills: [], error: e.message }; } });
  handle('skills:import', (e) => skills.importSkill(e.sender));
  handle('skills:import:confirm', (_e, token) => skills.confirmImport(token));
  handle('skills:create', (_e, name) => { try { return skills.createSkill(name); } catch (e) { return { ok: false, error: e.message }; } });
  handle('skills:examples', () => { try { return skills.installExamples(); } catch (e) { return { ok: false, error: e.message }; } });
  handle('skills:enable', (_e, folder, enabled) => skills.setEnabled(String(folder), !!enabled));
  handle('skills:remove', (_e, folder) => skills.removeSkill(folder).catch((e) => ({ ok: false, error: e.message })));
  handle('skills:open', (_e, folder) => {
    const dir = folder ? skills.folderPath(folder) : skills.root();
    return dir ? shell.openPath(dir) : '找不到这个技能';
  });
  handle('ai:stop', (_e, id, how) => {
    const s = streams.get(id);
    if (!s) return false;
    // 还在启动（读密钥、加载 SDK）时点了停止：记下来，驱动一建好就执行
    if (!s.ctl) { s.stopRequested = how === 'interrupt' ? 'interrupt' : 'kill'; return true; }
    if (how === 'interrupt') s.ctl.interrupt(); else s.ctl.stop();
    return true;
  });
}

function stopAll() {
  for (const s of streams.values()) { try { s.ctl && s.ctl.stop(); } catch { /* gone */ } }
  streams.clear();
}

module.exports = {
  register, stopAll, handle,
  /** 仅供无头检查（scripts/probe/hook-probe/electron-check.cjs）：页面不会用到. */
  __test: {
    startStream, detect, claudeAuthView, authStore, streams, exeFor, driverDef, envProblem, test, saveKeyOp, clearKeyOp,
    fromApp, petWorkspace, samePath, setAppSender: (fn) => { appSender = typeof fn === 'function' ? fn : null; },
  },
};
