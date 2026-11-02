'use strict';
// Agent Client Protocol client (JSON-RPC 2.0 over stdio) for every command-line agent that speaks it: Kimi Code, Qwen Code, MiniMax Code,
// Gemini CLI, OpenCode, Goose… (catalog/acp-agents.json, the agents the user registered, a custom command). One process per turn; a later
// turn resumes or loads the session when the agent can. Permission requests come back to the workbench.
//
// What this file implements (MODELS-SPEC §10.3):
//   initialize          protocol 1; fs and terminal stay false; auth.terminal / elicitation / boolean options are NOT declared
//   authenticate        only for an `agent`-type method, only when a session call says authentication is needed; otherwise the user is told
//                       to sign in in a terminal (the workbench never signs in for anyone)
//   session             session/resume (preferred) → session/load → session/new, with a notice when the agent cannot resume
//   configOptions       model / thought_level / mode options → session/set_config_option (the agent answers with the COMPLETE list);
//                       agents without configOptions fall back to the older modes + session/set_mode (Kimi is one of them in the checks)
//   permissions         option kinds are normalized (allow-once == allow_once); an option of an unknown kind is never chosen; read-only runs
//                       refuse write / command / MCP requests here, in the main process, and a verified agent that cannot be put into a
//                       read-only mode is not started at all (fail closed)
//   usage_update        → the `context` event (how full the window is)
//   cancel              session/cancel + $/cancel_request, and the process tree is killed 3 s later if the agent has not stopped
//   other requests      answered with -32601 (elicitation, cursor/ask_question…: they BLOCK until answered) plus a notice
const { spawnCli, killTree, parseJson, flattenOutput } = require('./proc.cjs');
const perm = require('./perm.cjs');

const KIND_TO_TOOL = { read: 'read_file', edit: 'write_file', delete: 'write_file', move: 'write_file', search: 'code_search', execute: 'shell', fetch: 'web_fetch', think: 'think' };
/** ACP reports MCP tools as kind "other" with the real name in the title (mcp__alight-browser__browser_click). */
const toolName = (kind, title) => KIND_TO_TOOL[kind] || (title && /^[\w.-]+$/.test(title) ? title : kind || 'other');
/** 只读运行里仍可以问页面的工具种类（读 / 搜索 / 思考 / 抓取网页）；其余种类的权限请求主进程直接拒绝. */
const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);

/* ═════════════════════════ protocol helpers (pure; check-services tests them) ═════════════════════════ */

/** 'allow-once' / 'Allow_Once' → 'allow_once' (Cursor's docs write the hyphen; the schema writes the underscore). */
const normKind = (k) => String(k == null ? '' : k).trim().toLowerCase().replace(/[-\s]+/g, '_');
const OPTION_KINDS = new Set(['allow_once', 'allow_always', 'reject_once', 'reject_always']);

/**
 * Which option means "yes" and which means "no". An option whose kind is not one of the four (after normalizing) is neither: it is never
 * chosen — not as allow, not as a fallback. No allow option → the answer to an "allow" is "cancelled" (fail closed).
 * @returns {{ allow?: string, reject?: string, unknown: number }}
 */
function pickPermissionOptions(options) {
  const list = Array.isArray(options) ? options.filter((o) => o && typeof o === 'object' && typeof o.optionId === 'string' && o.optionId) : [];
  const first = (kind) => list.find((o) => normKind(o.kind) === kind);
  const allow = first('allow_once') || first('allow_always');
  const reject = first('reject_once') || first('reject_always');
  return { allow: allow && allow.optionId, reject: reject && reject.optionId, unknown: list.filter((o) => !OPTION_KINDS.has(normKind(o.kind))).length };
}

const clean = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n);

/** The effort ladder the workbench knows; an agent's own value names that are not on it are shown but cannot be chosen. */
const LADDER = { off: 'off', none: 'off', low: 'low', medium: 'medium', med: 'medium', high: 'high', xhigh: 'xhigh', x_high: 'xhigh', extra_high: 'xhigh', max: 'max', maximum: 'max', ultra: 'ultra' };
function mapEffort(token) {
  const t = String(token == null ? '' : token).trim().toLowerCase().replace(/[-\s]+/g, '_');
  return Object.prototype.hasOwnProperty.call(LADDER, t) ? LADDER[t] : null;
}

/**
 * configOptions as the agent sent them → a cleaned list. `select` options keep their values (grouped options are flattened, the group
 * name is kept); `boolean` options are kept but never set (the client does not advertise boolean support).
 * @returns {Array<{ id: string, name: string, description: string, category: string, type: 'select'|'boolean', current: unknown, values: Array<{ value: string, name: string, description: string, group?: string }> }>}
 */
function parseConfigOptions(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw.slice(0, 40)) {
    if (!o || typeof o !== 'object' || typeof o.id !== 'string' || !o.id || o.id.length > 120) continue;
    const values = [];
    const push = (x, group) => {
      if (!x || typeof x !== 'object' || typeof x.value !== 'string' || !x.value || x.value.length > 200 || values.length >= 400) return;
      const v = { value: x.value, name: clean(x.name || x.value, 120), description: clean(x.description, 300) };
      if (group) v.group = clean(group, 80);
      values.push(v);
    };
    if (o.type !== 'boolean') {
      for (const x of Array.isArray(o.options) ? o.options : []) {
        if (x && Array.isArray(x.options)) for (const y of x.options) push(y, x.name || x.group);
        else push(x);
      }
    }
    out.push({ id: o.id, name: clean(o.name || o.id, 120), description: clean(o.description, 300), category: typeof o.category === 'string' ? o.category.slice(0, 40) : '', type: o.type === 'boolean' ? 'boolean' : 'select', current: o.currentValue, values });
  }
  return out;
}

/** The option that plays a role (model / thought_level / mode): by `category`, else by the plain id. */
function optionFor(options, role) {
  const sel = options.filter((o) => o.type === 'select');
  return sel.find((o) => o.category === role) || sel.find((o) => !o.category && o.id === role);
}

/**
 * What the page may be shown about a session's options: the models, the effort levels (mapped onto the ladder, the rest marked), the modes.
 * `legacy*` come from the older `models` / `modes` fields of session/new for agents that have no configOptions.
 */
function summarizeConfig(options, legacy = {}) {
  const model = optionFor(options, 'model');
  const effort = optionFor(options, 'thought_level');
  const mode = optionFor(options, 'mode');
  const out = { models: [], currentModel: '', efforts: [], currentEffort: '', modes: [], currentMode: '', source: options.length ? 'configOptions' : '' };
  if (model) { out.models = model.values.map((v) => ({ id: v.value, label: v.name, note: v.description })); out.currentModel = typeof model.current === 'string' ? model.current : ''; }
  else if (legacy.models && Array.isArray(legacy.models.availableModels)) {
    out.models = legacy.models.availableModels.filter((m) => m && typeof m.modelId === 'string').slice(0, 400).map((m) => ({ id: m.modelId, label: clean(m.name || m.modelId, 120), note: clean(m.description, 300) }));
    out.currentModel = typeof legacy.models.currentModelId === 'string' ? legacy.models.currentModelId : '';
    if (out.models.length) out.source = out.source || 'models';
  }
  if (effort) {
    out.efforts = effort.values.map((v) => ({ id: v.value, label: v.name, level: mapEffort(v.value) || mapEffort(v.name) }));
    out.currentEffort = typeof effort.current === 'string' ? effort.current : '';
  }
  if (mode) { out.modes = mode.values.map((v) => ({ id: v.value, label: v.name, note: v.description })); out.currentMode = typeof mode.current === 'string' ? mode.current : ''; }
  else if (legacy.modes && Array.isArray(legacy.modes.availableModes)) {
    out.modes = legacy.modes.availableModes.map((m) => m && { id: m.id || m.modeId, label: clean(m.name || m.id || m.modeId, 120), note: clean(m.description, 300) }).filter((m) => m && typeof m.id === 'string' && m.id).slice(0, 100);
    out.currentMode = typeof legacy.modes.currentModeId === 'string' ? legacy.modes.currentModeId : '';
    if (out.modes.length) out.source = out.source || 'modes';
  }
  return out;
}

/** The capabilities an `initialize` result announces (the same shape the probe shows on the card). */
function parseInitialize(init) {
  const r = init && typeof init === 'object' ? init : {};
  const ac = r.agentCapabilities && typeof r.agentCapabilities === 'object' ? r.agentCapabilities : {};
  const sc = ac.sessionCapabilities && typeof ac.sessionCapabilities === 'object' ? ac.sessionCapabilities : {};
  const has = (v) => v !== undefined && v !== null && v !== false;
  const methods = (Array.isArray(r.authMethods) ? r.authMethods : []).filter((m) => m && typeof m.id === 'string' && m.id).slice(0, 12).map((m) => ({
    id: m.id.slice(0, 80), name: clean(m.name || m.id, 80), description: clean(m.description, 200),
    type: m.type === undefined || m.type === null || m.type === 'agent' ? 'agent' : m.type === 'terminal' ? 'terminal' : 'other',
  }));
  return {
    protocolVersion: Number.isInteger(r.protocolVersion) ? r.protocolVersion : undefined,
    agentInfo: r.agentInfo && typeof r.agentInfo === 'object' ? { name: clean(r.agentInfo.title || r.agentInfo.name, 80), version: clean(r.agentInfo.version, 40) } : undefined,
    authMethods: methods,
    caps: {
      loadSession: !!ac.loadSession, resume: has(sc.resume), list: has(sc.list), close: has(sc.close),
      mcpHttp: !!(ac.mcpCapabilities && ac.mcpCapabilities.http), image: !!(ac.promptCapabilities && ac.promptCapabilities.image),
    },
  };
}

/** A session call failed because the agent wants the user signed in. The schema names the error `auth_required` but gives no number in the docs we can read; -32000 is what the SDKs use. */
function isAuthRequired(e, authMethods = []) {
  if (!e) return false;
  const text = `${e.message || ''} ${e.data && (e.data.error || e.data.message) || ''}`;
  if (/auth[_ -]?required|authenticat|not (logged|signed) in|unauthori[sz]ed|(log|sign) ?in (is )?required|please (log|sign) ?in|credentials?|需要登录|尚未登录|未登录/i.test(text)) return true;
  // -32000 is also the generic "server error": only believe it when the agent offered a way to sign in
  return e.code === -32000 && authMethods.length > 0;
}

/** Methods the workbench never serves itself, and what to tell the user about each. */
const ASKING_METHOD = /elicit|ask_?question|create_?plan|ask_?user/i;

/* ═════════════════════════ the run ═════════════════════════ */

/**
 * spec: { exe, args, cwd, prompt, system, sessionId?, env, access: 'chat'|'work', label, model?, effort?,
 *         agent?: 代理 id（目录里的；旧调用方只传这个）, agentDef?: 主进程组装的代理定义（用户登记的代理走这个，perm 字段从这里读）,
 *         spawnCwd?: 进程自己的启动目录（注册表里 npx / uvx 的代理用应用自己的空目录；会话的工作目录仍是 cwd）,
 *         readOnly?, pageMode?: 页面的权限模式 → 创建 / 恢复会话后设置（做不到的发 notice「已降级」）, initTimeoutMs? }
 */
function runAcp(spec, emit) {
  const def = perm.agentDef(spec.agentDef || spec.agent);
  const verified = perm.acpVerified(def);
  const label = spec.label || (def && def.label) || 'CLI';
  // ACP passes MCP servers as { name, command, args, env: [{ name, value }] }. The workbench's browser server is a stdio server, which is the
  // protocol's baseline every agent must accept; an http server would need `mcpCapabilities.http`, which nothing here uses.
  const mcpServers = spec.mcp ? [{ name: 'alight-browser', command: spec.mcp.command, args: spec.mcp.args, env: Object.entries(spec.mcp.env).map(([name, value]) => ({ name, value })) }] : [];
  let seq = 0;
  const pending = new Map();
  let sessionId = null;
  let stderr = '';
  let text = '';
  let finished = false;
  let stopped = false;
  let replaying = false;
  let fresh = true;
  let readOnlyNoted = false;
  let promptId = null;
  let authed = false;
  let authMethods = [];
  let caps = { loadSession: false, resume: false };
  let options = [];                 // parsed configOptions, replaced by every complete list the agent sends
  let legacy = {};                  // the older `modes` / `models` fields of the session result
  let currentMode = '';
  const noted = new Set();
  const calls = new Map();
  const permissions = new Map(); // our requestId → { rpcId, reply, allow, reject }
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    for (const p of pending.values()) p.reject(new Error('closed'));
    pending.clear();
    emit(ev);
    resolveDone();
    setTimeout(() => killTree(child), 300);
  };
  const noteOnce = (key, level, msg) => { if (noted.has(key)) return; noted.add(key); emit({ type: 'notice', level, text: msg }); };

  const send = (obj) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`); } catch { /* closed */ } };
  const request = (method, params, timeoutMs) => {
    const id = ++seq;
    const p = new Promise((resolve, reject) => {
      let t = null;
      if (timeoutMs) t = setTimeout(() => { pending.delete(id); reject(Object.assign(new Error(`${method} 超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`), { code: 'ETIMEDOUT' })); }, timeoutMs);
      pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
      send({ id, method, params });
    });
    p.id = id;
    return p;
  };

  const setOptions = (raw) => { if (Array.isArray(raw)) options = parseConfigOptions(raw); };

  const onUpdate = (u) => {
    if (!u) return;
    const kind = u.sessionUpdate;
    // The agent may change its own options at any time (the list is always the full state), also while a session is being replayed
    if (kind === 'config_option_update') { setOptions(u.configOptions); return; }
    if (kind === 'current_mode_update') { if (typeof u.currentModeId === 'string') currentMode = u.currentModeId; return; }
    if (replaying) return;
    const t = u.content && u.content.type === 'text' ? u.content.text : '';
    if (kind === 'agent_message_chunk' && t) { text += t; emit({ type: 'text', text: t }); }
    else if (kind === 'agent_thought_chunk' && t) emit({ type: 'thinking', text: t });
    else if (kind === 'usage_update') {
      // used = tokens in the window now, size = the window. (cost is cumulative for the session; a per-turn figure cannot be derived, so it is not mapped.)
      if (Number.isFinite(u.size) && u.size > 0 && Number.isFinite(u.used) && u.used >= 0) emit({ type: 'context', used: Math.round(u.used), limit: Math.round(u.size) });
    } else if (kind === 'tool_call') {
      calls.set(u.toolCallId, { kind: u.kind, title: u.title, input: u.rawInput });
      emit({ type: 'text-break' });
      emit({ type: 'tool', callId: u.toolCallId, name: toolName(u.kind, u.title), input: u.rawInput || {}, title: u.title || u.kind || '工具' });
      if (u.status === 'completed' || u.status === 'failed') emit({ type: 'tool-end', callId: u.toolCallId, ok: u.status === 'completed', output: acpContent(u.content) });
    } else if (kind === 'tool_call_update') {
      const old = calls.get(u.toolCallId);
      if (!old) {
        calls.set(u.toolCallId, { kind: u.kind, title: u.title, input: u.rawInput });
        emit({ type: 'tool', callId: u.toolCallId, name: toolName(u.kind, u.title), input: u.rawInput || {}, title: u.title || '工具' });
      }
      if (u.status === 'completed' || u.status === 'failed') emit({ type: 'tool-end', callId: u.toolCallId, ok: u.status === 'completed', output: acpContent(u.content) || (u.rawOutput ? flattenOutput(u.rawOutput) : '') });
    } else if (kind === 'plan' && Array.isArray(u.entries)) {
      emit({ type: 'plan', entries: u.entries.map((e) => ({ text: String(e.content || ''), status: e.status === 'completed' ? 'completed' : e.status === 'in_progress' ? 'in_progress' : 'pending' })) });
    }
  };

  const onPermissionRequest = (msg) => {
    const p = msg.params || {};
    const { allow, reject } = pickPermissionOptions(p.options);
    const reply = (optionId) => send({ id: msg.id, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
    if (spec.access === 'chat') { reply(reject); return; }
    const tc = p.toolCall || {};
    const known = calls.get(tc.toolCallId) || {};
    const kind = normKind(tc.kind || known.kind);
    // 只读（T0 / 只读任务 / 计划阶段）：写入、删除、移动、命令、MCP 工具一律在这里拒绝，不转给页面；认不出种类的当作写入（fail-closed）.
    if (spec.readOnly && !READ_KINDS.has(kind)) {
      reply(reject);
      if (!readOnlyNoted) { readOnlyNoted = true; emit({ type: 'notice', level: 'info', text: `这次是只读运行：${label} 想执行的「${tc.title || known.title || tc.kind || '操作'}」已自动拒绝。` }); }
      return;
    }
    const requestId = `acp_${msg.id}`;
    permissions.set(requestId, { rpcId: msg.id, reply, allow, reject });
    emit({ type: 'permission', requestId, callId: tc.toolCallId, name: toolName(kind, tc.title || known.title), input: tc.rawInput || known.input || {}, title: tc.title || known.title || '工具',
      paths: (Array.isArray(tc.locations) ? tc.locations : []).map((l) => l && l.path).filter((x) => typeof x === 'string') });
  };

  // `spawnCwd`: the folder the process itself starts in, when that must not be the task's folder (an npx / uvx agent: the task's folder may hold
  // a .npmrc / uv.toml that changes where the pinned package comes from). The session's working folder is `cwd` either way.
  const child = spawnCli(spec.exe, spec.args || [], {
    cwd: spec.spawnCwd || spec.cwd,
    env: spec.env,
    onErr: (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); },
    onLine: (line) => {
      const msg = parseJson(line);
      if (!msg || typeof msg !== 'object') return;
      if (msg.id !== undefined && !msg.method) {
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'ACP 错误'), { code: msg.error.code, data: msg.error.data }));
        else p.resolve(msg.result);
        return;
      }
      if (msg.method === 'session/update') { onUpdate(msg.params && msg.params.update); return; }
      if (msg.method === '$/cancel_request') {
        // the agent withdraws a request it sent us (usually a permission prompt): drop it, a late answer would go nowhere
        const rid = msg.params && msg.params.requestId;
        for (const [key, p] of permissions) if (p.rpcId === rid) permissions.delete(key);
        return;
      }
      if (msg.method === 'session/request_permission' && msg.id !== undefined) { onPermissionRequest(msg); return; }
      if (msg.method && msg.id !== undefined) {
        // We advertise no filesystem or terminal capability, no elicitation: whatever else the agent asks gets "method not found". Some of these
        // (elicitation, Cursor's ask_question / create_plan) BLOCK the agent until they are answered, so an answer must always go out.
        send({ id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } });
        if (ASKING_METHOD.test(String(msg.method))) noteOnce('ask', 'info', `${label} 想问一个栖枝暂不支持的问题（${String(msg.method).slice(0, 60)}），已回绝；它会按自己的办法继续。`);
        else noteOnce(`m:${msg.method}`, 'info', `${label} 发来了栖枝没有提供的请求「${String(msg.method).slice(0, 60)}」，已回绝。`);
      }
    },
  });

  child.on('error', (e) => finish({ type: 'error', message: `无法启动 ${label}：${e.message}`, code: 'SPAWN' }));
  child.on('close', (code) => {
    if (finished) return;
    if (stopped) { finish({ type: 'done', text, stopReason: 'interrupted', sessionId }); return; }
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    finish({ type: 'error', message: tail ? `${label} 退出（${code}）：${tail}` : `${label} 意外退出（${code}）`, code: `EXIT_${code}`, sessionId });
  });

  /* ───────────── authentication ───────────── */

  const loginMessage = () => {
    const bin = (def && def.bin && def.bin[0]) || 'CLI';
    const args = def && def.auth && Array.isArray(def.auth.loginArgs) ? def.auth.loginArgs : [];
    const hint = def && def.auth && def.auth.loginHint ? ` ${def.auth.loginHint}` : '';
    return args.length ? `${label} 还没有登录。请先在终端登录：${bin} ${args.join(' ')}（也可以点卡片上的「登录」）。` : `${label} 还没有登录。${hint || `请先按它自己的文档在终端里登录（${bin}）。`}`;
  };

  /** `authenticate` is for an `agent`-type method only (the agent runs its own sign-in); a `terminal`-type method needs a terminal we do not offer. */
  async function authenticate() {
    authed = true;
    const agentMethods = authMethods.filter((m) => m.type === 'agent');
    const allowed = def && def.auth && Array.isArray(def.auth.methodIds) ? def.auth.methodIds : null;
    const candidates = allowed ? agentMethods.filter((m) => allowed.includes(m.id)) : agentMethods;
    // several methods and no allow-list in the definition: do not guess which one to run
    let method = candidates.length === 1 ? candidates[0] : (allowed && candidates[0]) || null;
    // The user saved a key for this agent and it was put in its environment: of several methods, the one that is about a key / token is the one that uses it
    // (Gemini CLI offers Google login, API key, Vertex AI and a gateway — only "gemini-api-key" is the saved key). Several such methods: do not guess.
    if (!method && def && def.binding && def.binding.mode === 'env' && spec.env && spec.env[def.binding.keyEnv]) {
      const keyed = candidates.filter((m) => /key|token/i.test(`${m.id} ${m.name}`));
      if (keyed.length === 1) method = keyed[0];
    }
    if (!method) throw Object.assign(new Error(loginMessage()), { code: 'AUTH' });
    emit({ type: 'notice', level: 'info', text: `${label} 需要登录，正在请它自己发起登录（${method.name || method.id}）…` });
    try { await request('authenticate', { methodId: method.id }); } catch (e) {
      throw Object.assign(new Error(`${loginMessage()}（它的登录没有完成：${clean(e && e.message, 80)}）`), { code: 'AUTH' });
    }
  }
  /** Run a session call; if it fails because the user is not signed in, authenticate ONCE and run it again. */
  async function withAuth(fn) {
    try { return await fn(); } catch (e) {
      if (authed || (e && e.code === 'AUTH') || !isAuthRequired(e, authMethods)) throw e;
      await authenticate();
      return fn();
    }
  }

  /* ───────────── session ───────────── */

  function adopt(id, result, isFresh) {
    sessionId = id;
    fresh = isFresh;
    const r = result && typeof result === 'object' ? result : {};
    setOptions(r.configOptions);
    legacy = { modes: r.modes, models: r.models };
    currentMode = (r.modes && typeof r.modes.currentModeId === 'string' && r.modes.currentModeId) || '';
  }

  async function openSession() {
    let failure = '';
    if (spec.sessionId) {
      // resume first (no history replay), then load (the agent replays the history; those updates are dropped); either failing falls through to the next, then to a new session
      const ways = [];
      if (caps.resume) ways.push('session/resume');
      if (caps.loadSession) ways.push('session/load');
      for (const method of ways) {
        try {
          replaying = method === 'session/load';
          try { adopt(spec.sessionId, await withAuth(() => request(method, { sessionId: spec.sessionId, cwd: spec.cwd, mcpServers })), false); } finally { replaying = false; }
          return;
        } catch (e) {
          if (e && e.code === 'AUTH') throw e;
          sessionId = null;
          failure = clean(e && e.message, 80);
        }
      }
    }
    const created = await withAuth(() => request('session/new', { cwd: spec.cwd, mcpServers }));
    if (!created || typeof created.sessionId !== 'string' || !created.sessionId) throw new Error('没有拿到会话 ID');
    adopt(created.sessionId, created, true);
    if (spec.sessionId) emit({ type: 'notice', level: 'warn', text: failure ? `${label} 没能恢复上次的会话（${failure}），已开始新会话。` : `${label} 不支持恢复上次的会话，已开始新会话。` });
  }

  /* ───────────── model, effort, mode ───────────── */

  /** session/set_config_option; the agent answers with the COMPLETE list, which replaces ours. */
  async function setOption(configId, value) {
    const r = await request('session/set_config_option', { sessionId, configId, value });
    if (r && Array.isArray(r.configOptions)) setOptions(r.configOptions);
    else { const o = options.find((x) => x.id === configId); if (o) o.current = value; }
  }

  /** The model and 推理强度 the task asked for, when the agent offers them as session options. A failure is a notice, never fatal. */
  async function applyModelAndEffort() {
    const model = optionFor(options, 'model');
    const wantModel = typeof spec.model === 'string' ? spec.model.trim() : '';
    // An agent whose definition carries the model in its environment ({model} in a binding variable, e.g. Qwen Code's OPENAI_MODEL) already got it there:
    // its own model list is a different namespace, so neither set it from here nor complain that the list lacks it.
    const modelViaEnv = !!(def && def.binding && def.binding.mode === 'env' && Object.values(def.binding.env || {}).some((v) => String(v).includes('{model}')));
    if (wantModel && !modelViaEnv) {
      const lc = wantModel.toLowerCase();
      if (model) {
        const hit = model.values.find((v) => v.value === wantModel) || model.values.find((v) => v.value.toLowerCase() === lc || v.name.toLowerCase() === lc);
        if (!hit) noteOnce('model-miss', 'warn', `${label} 的模型列表里没有「${wantModel}」，沿用它现在的「${model.current}」。`);
        else if (hit.value !== model.current) {
          try { await setOption(model.id, hit.value); } catch (e) { noteOnce('model-fail', 'warn', `${label} 没能切到模型「${hit.value}」（${clean(e && e.message, 80)}），沿用它现在的模型。`); }
        }
      } else if (legacy.models && Array.isArray(legacy.models.availableModels) && legacy.models.availableModels.some((m) => m && m.modelId === wantModel) && legacy.models.currentModelId !== wantModel) {
        try { await request('session/set_model', { sessionId, modelId: wantModel }); } catch (e) { noteOnce('model-fail', 'warn', `${label} 没能切到模型「${wantModel}」（${clean(e && e.message, 80)}），沿用它现在的模型。`); }
      }
      // an agent without a model option takes its model some other way (an environment variable): nothing to say
    }
    const cur = optionFor(options, 'model');
    if (cur && !modelViaEnv && typeof cur.current === 'string' && cur.current) emit({ type: 'model', model: cur.current });

    const wantEffort = typeof spec.effort === 'string' ? spec.effort.trim() : '';
    const eff = optionFor(options, 'thought_level');
    if (wantEffort && eff) {
      const level = mapEffort(wantEffort);
      const hit = level ? eff.values.find((v) => mapEffort(v.value) === level || mapEffort(v.name) === level) : undefined;
      if (!hit) noteOnce('effort-miss', 'info', `${label} 没有「${wantEffort}」这一档推理强度，沿用它现在的设置。`);
      else if (hit.value !== eff.current) {
        try { await setOption(eff.id, hit.value); } catch (e) { noteOnce('effort-fail', 'warn', `${label} 没能设推理强度「${hit.value}」（${clean(e && e.message, 80)}），沿用它现在的设置。`); }
      }
    }
  }

  /**
   * The modes the agent offers and how to set one: through its configOptions (preferred) or the older session/set_mode. An agent can have both; a mode is set
   * the way the list that names it says (the union is what the mode plan checks against).
   */
  function modeSource() {
    const opt = optionFor(options, 'mode');
    const configIds = opt ? opt.values.map((v) => v.value) : undefined;
    const legacyIds = legacy.modes && Array.isArray(legacy.modes.availableModes) ? legacy.modes.availableModes.map((m) => m && (m.id || m.modeId)).filter(Boolean) : undefined;
    const ids = configIds || legacyIds ? [...new Set([...(configIds || []), ...(legacyIds || [])])] : undefined;
    return { ids, configIds, configId: opt && opt.id, current: (opt && typeof opt.current === 'string' && opt.current) || currentMode };
  }
  async function setMode(src, modeId) {
    if (src.configIds && src.configIds.includes(modeId)) await setOption(src.configId, modeId);
    else await request('session/set_mode', { sessionId, modeId });
    currentMode = modeId;
  }

  /** 权限模式：只有定义里 verified 且登记了 modeMap 的代理才切（Kimi 实测有 default / plan / auto / yolo）。创建会话后显式设一次，不继承用户配置里残留的 auto / yolo. */
  async function applyMode() {
    if (spec.access === 'chat' && !verified) return;   // 没有验证过模式的引擎：闲聊沿用它的默认，像以前一样不去碰
    const src = modeSource();
    const plan = perm.acpPlan(def || spec.agent, spec.pageMode, src.ids);
    // 只读 / 闲聊的已验证代理：模式设不上就不能让它带着残留的 auto / yolo 往下跑（那样它不会再发权限请求，上面的自动拒绝收不到任何东西）→ 失败即关闭.
    // 先试目标模式（plan），不行退到 default（default 会为写入 / 命令发权限请求，由上面的自动拒绝兜底），再不行就不启动.
    const lock = !!spec.readOnly && verified;
    if (lock) {
      const want = [];
      if (plan.modeId) want.push(plan.modeId);
      const fallback = (def.perm.modeMap.ask) || 'default';
      if (!want.includes(fallback) && (!src.ids || src.ids.includes(fallback))) want.push(fallback);
      let lastErr = null;
      for (const modeId of want) {
        if (src.current === modeId) { lastErr = null; break; }
        try { await setMode(src, modeId); lastErr = null; if (modeId !== want[0]) emit({ type: 'notice', level: 'warn', text: `${label} 没能切到「${want[0]}」模式，改用「${modeId}」：只读靠拒绝它发来的写入 / 命令请求来保证。` }); break; }
        catch (e) { lastErr = e; }
      }
      if (lastErr || !want.length) throw Object.assign(new Error(`这次要求只读，但没能把 ${label} 切到只读相关的模式（${String(lastErr && lastErr.message || `它没有提供 ${[def.perm.modeMap.plan, fallback].filter(Boolean).join(' / ')} 模式`).slice(0, 80)}），为安全起见没有开始。`), { code: 'READONLY' });
      if (plan.note) emit({ type: 'notice', level: 'info', text: plan.note });
      return;
    }
    if (spec.readOnly && !verified) {
      // 权限模式没有验证过的代理：这里只能如实说，只读靠它自己的逐项确认 + 上面对写入 / 命令请求的自动拒绝
      emit({ type: 'notice', level: 'warn', text: `${label} 的权限模式没有验证过，无法保证只读：它发来的写入 / 命令类权限请求会被自动拒绝，但它若自己放行了就拦不住。` });
      return;
    }
    if (plan.note) emit({ type: 'notice', level: 'info', text: plan.note });
    if (!plan.modeId || src.current === plan.modeId) return;
    try {
      await setMode(src, plan.modeId);
    } catch (e) {
      emit({ type: 'notice', level: 'warn', text: `${label} 没能切到「${plan.modeId}」模式（${String(e && e.message || e).slice(0, 80)}），按它当前的模式执行（已降级）。` });
    }
  }

  /* ───────────── the turn ───────────── */

  (async () => {
    try {
      const init = await request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'Alight', version: '2.0.0' } }, spec.initTimeoutMs === undefined ? (def && def.source === 'registry' ? 300_000 : 90_000) : spec.initTimeoutMs);   // npx / uvx download the package on the first run
      const parsed = parseInitialize(init);
      authMethods = parsed.authMethods;
      caps = parsed.caps;
      await openSession();
      emit({ type: 'session', sessionId });
      await applyModelAndEffort();
      // 闲聊也要设（已验证的代理）：它和工作运行共用同一个会话，会话可能还停在上次的 yolo / auto（那样闲聊的“无工具”只剩一句提示词）
      await applyMode();
      // A fresh session (never resumed, or the resume failed) needs the system prompt again.
      const prompt = fresh && spec.system ? `${spec.system}\n\n---\n\n${spec.prompt}` : spec.prompt;
      const turn = request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] });
      promptId = turn.id;
      const result = await turn;
      const reason = result && result.stopReason;
      if (reason === 'refusal') finish({ type: 'error', message: `${label} 拒绝了这次请求。`, code: 'REFUSAL', sessionId });
      else finish({ type: 'done', text, stopReason: stopped ? 'interrupted' : reason, sessionId });
    } catch (e) {
      if (finished) return;
      if (stopped) { finish({ type: 'done', text, stopReason: 'interrupted', sessionId }); return; }
      const tail = stderr.trim().split(/\r?\n/).slice(-4).join('\n');
      finish({ type: 'error', message: `${label}：${e.message}${tail ? `\n${tail}` : ''}`, code: e.code ? `ACP_${e.code}` : 'ACP', sessionId });
    }
  })();

  return {
    done,
    send: null,
    answer(requestId, decision) {
      const p = permissions.get(requestId);
      if (!p) return;
      permissions.delete(requestId);
      // "allow" with no allow option (or only options of a kind we do not know) is answered "cancelled": never a guess
      p.reply(decision === 'allow' ? p.allow : p.reject);
    },
    interrupt() {
      if (finished) return;
      stopped = true;
      for (const p of permissions.values()) p.reply(undefined);
      permissions.clear();
      if (sessionId) send({ method: 'session/cancel', params: { sessionId } });
      // JSON-RPC level cancellation of the prompt request itself (an agent that does not know it ignores the notification)
      if (promptId) send({ method: '$/cancel_request', params: { requestId: promptId } });
      setTimeout(() => { if (!finished) killTree(child); }, 3000);
    },
    stop() { if (!finished) { stopped = true; killTree(child); } },
  };
}

/** ACP tool-call content → text (diffs become a compact unified-looking block). */
function acpContent(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => {
    if (!c) return '';
    if (c.type === 'diff') return `--- ${c.path}\n+++ ${c.path}\n${String(c.oldText || '').split('\n').map((l) => `-${l}`).join('\n')}\n${String(c.newText || '').split('\n').map((l) => `+${l}`).join('\n')}`;
    if (c.type === 'content') return flattenOutput([c.content]);
    if (c.type === 'terminal') return `[终端 ${c.terminalId}]`;
    return flattenOutput([c]);
  }).filter(Boolean).join('\n').slice(0, 6000);
}

module.exports = {
  runAcp,
  /** Pure helpers, exported for check-services (T-ACP) and for acp-agents.cjs (the capability probe). */
  normKind, pickPermissionOptions, parseConfigOptions, optionFor, summarizeConfig, parseInitialize, isAuthRequired, mapEffort, READ_KINDS, clean,
};
