// Claude 驱动（Agent SDK 版，K01）。对外和 claude.cjs 的 runClaude 同一个控制器接口：
//   { send(text), answer(requestId, decision, input), interrupt(), stop(), done: Promise }
// 并发出同样的 StreamEvent，另有 question / plan-ready / rate-limit / context，done 带 costUsd。
//
// 设计要点（都经过 scripts/probe/hook-probe 的假 Anthropic 服务验证，结论见 docs/HOOK-PROBE.md）：
// - 默认用用户自己的 claude.exe（pathToClaudeCodeExecutable）；栖枝不碰令牌、不读凭据。找不到才退回 SDK 随包二进制并说明。
// - settingSources ['user']、strictMcpConfig；浏览器 MCP 用 mcpServers 对象直传，不写临时文件。
// - PreToolUse 钩子是"放行主路径"：在引擎所有判定之前运行，bypassPermissions / auto 下也生效；钩子出错一律当 deny。
// - canUseTool 只负责：AskUserQuestion（→ question 事件，回答后 allow + updatedInput.answers）、
//   ExitPlanMode（→ plan-ready）、以及需要人点头的普通工具（→ permission 事件，沿用审批卡）。
// - SDK 加载失败 / 启动就崩（版本不匹配）/ 用户关掉开关 → 退回旧的 stream-json 驱动（deps.fallback），并发 notice。
//
// 本文件不引用 Electron，可以在普通 node 里被 check-engine / 探针直接跑。
const perm = require('./perm.cjs');
const { createMapper } = require('./sdk-map.cjs');
const { resolveClaudeForSdk } = require('./claude-path.cjs');
const { spawn } = require('node:child_process');
const { summarizeInput, killTree } = require('./proc.cjs');

let sdkPromise = null;
/** 主进程是 CJS，SDK 是 ESM：动态 import，只加载一次。 */
function loadSdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
/** 页面的 deny 清单是给旧驱动写的：SDK 驱动要处理提问和计划，把这两个放出来. */
const SDK_UNDENY = new Set(['askuserquestion', 'exitplanmode']);

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);

function normalizeQuestions(input) {
  const qs = input && Array.isArray(input.questions) ? input.questions : [];
  return qs.map((q) => ({
    question: String((q && q.question) || ''),
    header: q && q.header ? String(q.header).slice(0, 24) : undefined,
    options: (Array.isArray(q && q.options) ? q.options : []).map((o) => ({ label: String((o && o.label) || ''), description: o && o.description ? String(o.description) : undefined })),
    multiSelect: !!(q && q.multiSelect),
  }));
}

/** 页面回传的答案 → claude 要的 { 问题原文: 答案 }（多选用逗号连接）。接受对象或按顺序的数组。 */
function normalizeAnswers(raw, questions) {
  const out = {};
  const texts = (questions || []).map((q) => String((q && q.question) || ''));
  const join = (v) => (Array.isArray(v) ? v.map(String).join(', ') : String(v ?? ''));
  if (Array.isArray(raw)) {
    raw.forEach((v, i) => { if (texts[i] !== undefined) out[texts[i]] = join(v); });
  } else if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw);
    for (const [k, v] of entries) {
      if (texts.includes(k)) out[k] = join(v);
      else if (texts.length === 1 && entries.length === 1) out[texts[0]] = join(v);
    }
  }
  return out;
}

/** 从 SDK 的 canUseTool 选项里挑出给人看的一句标题. */
function permissionTitle(toolName, input, o) {
  // 和旧驱动一致：优先显示输入里最有信息的一项（路径 / 命令 / 网址），页面会在前面加工具名
  const base = summarizeInput(input) || (o && (o.title || o.displayName)) || toolName;
  return o && o.agentID ? `[子代理] ${base}` : base;
}

const EXIT_MODES = new Set(['default', 'acceptEdits', 'auto', 'plan']);

/**
 * @param {object} spec
 *   cwd, prompt, system, sessionId, model, effort, env, path(自定义 claude 路径), addDirs[], access('chat'|'work'),
 *   allow[], deny[], mcp({command,args,env}), permissionMode(页面的五种), phase('plan'|'step'|'chat'),
 *   readOnly, trust('T0'|'T1'|'T2'), apiKeyMode(true=环境里的 ANTHROPIC_API_KEY 是用户明示要用的), maxBudgetUsd,
 *   onlyTools(string[]：只有这些工具存在、别的一律在这里拒绝，不问页面；桌宠的联网答疑用，见 ai/index.cjs)
 * @param {(ev:object)=>void} emit
 * @param {{ sdk?: object, load?: Function, resolveExe?: Function, sessionDelta?: Function, addSpend?: Function, fallback?: Function, plansRoot?: string }} deps
 */
function runClaudeSdk(spec, emit, deps = {}) {
  let impl = null;
  let doneResolve;
  const done = new Promise((r) => { doneResolve = r; });
  const queued = [];
  const call = (method, args) => { if (impl) impl[method](...args); else queued.push([method, args]); };

  const adopt = (ctl) => {
    impl = ctl;
    ctl.done.then(() => doneResolve());
    for (const [m, args] of queued.splice(0)) ctl[m](...args);
  };

  (async () => {
    let sdk;
    try {
      sdk = deps.sdk || await (deps.load || loadSdk)();
    } catch (e) {
      if (deps.fallback) {
        emit({ type: 'notice', level: 'warn', text: `Claude Agent SDK 没能加载（${String(e && e.message || e).slice(0, 120)}），改用旧的 stream-json 驱动：提问卡和计划审批在这个驱动下不可用。` });
        adopt(deps.fallback(spec, emit));
      } else {
        emit({ type: 'error', message: `Claude Agent SDK 没能加载：${String(e && e.message || e)}`, code: 'SDK' });
        doneResolve();
      }
      return;
    }
    adopt(startSdkRun(sdk, spec, emit, deps));
  })();

  return {
    done,
    send: (text) => call('send', [text]),
    answer: (requestId, decision, input) => call('answer', [requestId, decision, input]),
    interrupt: () => call('interrupt', []),
    stop: () => call('stop', []),
  };
}

function startSdkRun(sdk, spec, emit, deps) {
  const found = (deps.resolveExe || resolveClaudeForSdk)(spec.path);
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });
  // 输入队列（流式输入：追加的话、改模式、打断都要它）；finish() 会用到，所以放在最前面
  const inbox = [];
  let wake = null;
  let closed = false;
  let finished = false;
  let interrupted = false;
  let sentTurns = 0;
  let results = 0;
  let sawInit = false;
  let stderr = '';
  let streamTokens = { input: 0, output: 0, cached: 0 };
  let streamCost = 0;
  let costKnown = false;
  /** 这次运行累计花费（已知才有）。错误 / 中断收尾的事件也要带上，否则出错的回合（常常是花得最多的）不进用量账. */
  const costNow = () => (costKnown ? Math.round(streamCost * 1e6) / 1e6 : undefined);
  let settle = null;
  // 自己 spawn claude 并留着子进程句柄：SDK 的 close() 在 Windows 上是「关 stdin → 等 ~2 秒 → 再等 5 秒 → 只对 claude.exe 发 SIGKILL」，
  // 既不中断在途的工具，也不杀进程树，PowerShell 等子进程会照样跑完。stop() 要靠这个句柄 taskkill /T 立即杀树（旧驱动就是这样）。
  let proc = null;
  let q = null;
  const waiting = new Map();
  let reqSeq = 0;

  const finish = (ev) => {
    if (finished) return;
    finished = true;
    clearTimeout(settle);
    for (const w of waiting.values()) w.resolve({ behavior: 'deny', message: '运行已结束。', interrupt: true });
    waiting.clear();
    closeInput();
    emit(ev);
    resolveDone();
    // 收尾后进程还没退就关掉它（done 先于进程退出）
    setTimeout(() => { try { q && q.close(); } catch { /* 已经关了 */ } }, 2500);
  };

  if (found.source === 'none') {
    setImmediate(() => finish({ type: 'error', message: found.note, code: 'ENOENT' }));
    return { done, send() {}, answer() {}, interrupt() {}, stop() {} };
  }

  const readOnly = !!spec.readOnly || spec.trust === 'T0' || spec.phase === 'plan';
  const readOnlyWhy = spec.trust === 'T0' ? '这个目录还没有被信任（只读运行）' : spec.readOnly ? '这个任务是只读的' : '现在是计划阶段，只做只读调研，批准计划之后才会动手';
  const chat = spec.access === 'chat';
  const mode = perm.sdkModeFor(spec.permissionMode, { phase: spec.phase === 'plan' ? 'plan' : 'step', readOnly: readOnly && spec.phase !== 'plan' });

  const roots = [spec.cwd, ...(spec.addDirs || [])].filter(Boolean);
  // stopped：取消 / 中断之后钩子一律 deny——别让已经被叫停的这一轮再发起新的写入和命令
  // 桌宠的联网答疑：工具集只有这几个（options.tools），钩子和 canUseTool 也各拒绝一遍别的，哪一层失灵另一层还在.
  const only = Array.isArray(spec.onlyTools) && spec.onlyTools.length ? new Set(spec.onlyTools.map((t) => String(t).toLowerCase())) : null;
  const hookCtx = { mode: mode.mode, readOnly, readOnlyWhy, deny: spec.deny, roots, planRoot: mode.mode === 'plan' ? deps.plansRoot : undefined, stopped: false, onlyTools: only || undefined };
  const hook = perm.makePreToolUseHook(hookCtx);

  const mapper = createMapper(emit, { sessionId: spec.sessionId });

  /* ───────── 输入队列（流式输入：追加的话、改模式、打断都要它） ───────── */
  function closeInput() { closed = true; if (wake) wake(); }
  const userMessage = (text) => ({
    type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null,
    // 以 / 开头的话不当成斜杠命令（claude 会把 /clear 之类当真）
    ...(String(text).trimStart().startsWith('/') ? { client_composed: true } : {}),
  });
  const push = (text) => { sentTurns += 1; inbox.push(userMessage(text)); if (wake) wake(); };
  async function* inputStream() {
    while (true) {
      while (!inbox.length) { if (closed) return; await new Promise((r) => { wake = r; }); }
      yield inbox.shift();
    }
  }

  /* ───────── 提问 / 计划 / 普通审批 ───────── */
  const canUseTool = (toolName, input, o) => new Promise((resolve) => {
    if (finished) { resolve({ behavior: 'deny', message: '运行已结束。', interrupt: true }); return; }
    if (only && !only.has(String(toolName).toLowerCase())) { resolve({ behavior: 'deny', message: `这次运行只能用 ${spec.onlyTools.join(' / ')}，不能用「${toolName}」。` }); return; }
    const requestId = `sdk_${++reqSeq}`;
    const settleWith = (r) => { if (waiting.delete(requestId)) resolve(r); };
    const kind = toolName === 'AskUserQuestion' ? 'question' : toolName === 'ExitPlanMode' ? 'plan' : 'tool';
    waiting.set(requestId, { kind, input: input || {}, resolve: settleWith, toolName });
    if (o && o.signal) o.signal.addEventListener('abort', () => settleWith({ behavior: 'deny', message: '已中止。', interrupt: true }), { once: true });
    const callId = o && o.toolUseID;
    if (kind === 'question') {
      emit({ type: 'question', requestId, callId, questions: normalizeQuestions(input) });
    } else if (kind === 'plan') {
      emit({ type: 'plan-ready', requestId, callId, plan: String((input && input.plan) || '') });
    } else {
      emit({
        type: 'permission', requestId, callId, name: toolName, input: input || {}, title: permissionTitle(toolName, input, o),
        reason: (o && o.decisionReason) || '', blockedPath: (o && o.blockedPath) || '',
      });
    }
  });

  function answer(requestId, decision, input) {
    const w = waiting.get(requestId);
    if (!w) return;
    const allow = decision === 'allow';
    if (w.kind === 'question') {
      if (!allow) { w.resolve({ behavior: 'deny', message: '使用者没有回答这个问题。请不要重复追问：按你的判断继续，或说明你需要什么信息。' }); return; }
      w.resolve({ behavior: 'allow', updatedInput: { ...w.input, answers: normalizeAnswers(input && input.answers, w.input.questions) } });
      return;
    }
    if (w.kind === 'plan') {
      if (!allow) {
        if (input && input.handoff) {
          w.resolve({ behavior: 'deny', message: '计划已交给栖枝收取，批准之后才会执行。这一轮到此为止：请不要再提交计划，也不要开始动手，用一两句话说明计划要点即可。' });
          return;
        }
        const note = input && typeof input.note === 'string' && input.note.trim() ? `：${input.note.trim().slice(0, 500)}` : '';
        w.resolve({ behavior: 'deny', message: `使用者还没有批准这份计划${note}。请按反馈修改计划，再提交一次。` });
        return;
      }
      // 批准之后用什么模式执行：页面指定 > 页面模式（计划/放手 → 逐项）
      const asked = input && typeof input.mode === 'string' ? input.mode : '';
      const pm = spec.permissionMode;
      const next = EXIT_MODES.has(asked) && asked !== 'plan' ? asked : pm === 'acceptEdits' ? 'acceptEdits' : pm === 'auto' ? 'auto' : 'default';
      w.resolve({ behavior: 'allow', updatedInput: w.input, updatedPermissions: [{ type: 'setMode', mode: next, destination: 'session' }] });
      return;
    }
    if (allow) {
      const given = input && typeof input === 'object' && Object.keys(input).length ? input : w.input;
      w.resolve({ behavior: 'allow', updatedInput: given });
    } else {
      w.resolve({ behavior: 'deny', message: '使用者在栖枝里拒绝了这次操作。请换一种不需要它的做法，或说明为什么需要。' });
    }
  }

  /* ───────── 组装 SDK 选项 ───────── */
  const env = { ...process.env, ...(spec.env || {}) };
  if (!spec.apiKeyMode) {
    // 登录路径：别让环境里残留的密钥把订阅悄悄换成 API 计费
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'alight-desk/0.1';

  const deny = (spec.deny || []).filter((t) => !SDK_UNDENY.has(String(t).toLowerCase()));
  const abort = new AbortController();
  const options = {
    abortController: abort,
    cwd: spec.cwd,
    env,
    settingSources: ['user'],
    strictMcpConfig: true,
    includePartialMessages: true,
    permissionMode: mode.mode,
    hooks: { PreToolUse: [{ hooks: [hook] }] },
    canUseTool,
    stderr: (d) => { stderr = (stderr + d).slice(-4000); },
  };
  if (found.path) options.pathToClaudeCodeExecutable = found.path;
  if (mode.bypass) options.allowDangerouslySkipPermissions = true;
  options.spawnClaudeCodeProcess = (o) => {
    const child = spawn(o.command, o.args, { cwd: o.cwd, env: o.env, signal: o.signal, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    // 自定义 spawn 时 SDK 不再读 stderr：这里读（既要排空管道，也要留着给错误提示用）
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.stderr.on('error', () => {});
    proc = child;
    return child;
  };
  if (spec.model) options.model = spec.model;
  if (spec.effort && EFFORTS.has(spec.effort)) options.effort = spec.effort;
  if (spec.sessionId) options.resume = spec.sessionId;
  if (spec.addDirs && spec.addDirs.length) options.additionalDirectories = spec.addDirs;
  if (chat) options.tools = [];
  else if (only) {
    options.tools = spec.onlyTools.map(String);
    options.allowedTools = options.tools.slice();
    if (deny.length) options.disallowedTools = deny;
  } else {
    if (spec.allow && spec.allow.length) options.allowedTools = spec.allow;
    if (deny.length) options.disallowedTools = deny;
  }
  if (spec.system) options.systemPrompt = { type: 'preset', preset: 'claude_code', append: spec.system };
  if (mode.mode === 'plan') {
    options.planModeInstructions = '请先只读地了解工作文件夹里的情况，然后在回复里按使用者消息要求的格式给出计划。不需要写计划文件，也不要调用 ExitPlanMode：计划会由栖枝收取，交给使用者批准之后才执行。';
  }
  if (spec.mcp && !chat) options.mcpServers = { 'alight-browser': { type: 'stdio', command: spec.mcp.command, args: spec.mcp.args, env: spec.mcp.env } };
  if (typeof spec.maxBudgetUsd === 'number' && spec.maxBudgetUsd > 0) options.maxBudgetUsd = spec.maxBudgetUsd;

  if (found.source === 'sdk' && found.note) emit({ type: 'notice', level: 'info', text: found.note });
  if (mode.note) emit({ type: 'notice', level: 'info', text: mode.note });

  /* ───────── 跑 ───────── */
  push(spec.prompt || '');
  try {
    q = sdk.query({ prompt: inputStream(), options });
  } catch (e) {
    setImmediate(() => finish({ type: 'error', message: `无法启动 Claude Code：${String(e && e.message || e)}`, code: 'SPAWN' }));
    return { done, send() {}, answer() {}, interrupt() {}, stop() {} };
  }

  const pump = async () => {
    try {
      for await (const m of q) {
        if (m.type === 'system' && m.subtype === 'init') {
          sawInit = true;
          const mismatch = perm.sdkModeMismatchNote(mode.mode, m.permissionMode);
          if (mismatch && !interrupted) emit({ type: 'notice', level: 'warn', text: mismatch });
        }
        if (finished) continue;
        if (settle && (m.type === 'stream_event' || m.type === 'assistant')) { clearTimeout(settle); settle = null; }
        const res = mapper.handle(m);
        if (res) await onResult(res);
      }
      if (!finished) {
        if (interrupted) finish({ type: 'done', text: mapper.lastTurnText || mapper.turnText, stopReason: 'interrupted', sessionId: mapper.sessionId, costUsd: costNow() });
        else if (!sawInit && deps.fallback && !/conversation found|--resume/i.test(stderr)) startFallback('没有收到启动信息');
        else finish({ type: 'error', message: stderr.trim() ? `Claude Code 意外结束：${stderr.trim().split(/\r?\n/).slice(-4).join('\n')}` : 'Claude Code 意外结束了。', code: 'EXIT', sessionId: mapper.sessionId, costUsd: costNow() });
      }
    } catch (e) {
      if (finished) return;
      if (interrupted) { finish({ type: 'done', text: mapper.lastTurnText || mapper.turnText, stopReason: 'interrupted', sessionId: mapper.sessionId, costUsd: costNow() }); return; }
      if (!sawInit && deps.fallback && !/conversation found|--resume/i.test(`${stderr}\n${e && e.message}`)) { startFallback(String(e && e.message || e)); return; }
      const tail = stderr.trim().split(/\r?\n/).slice(-5).join('\n');
      const msg = String(e && e.message || e);
      finish({ type: 'error', message: tail ? `${msg}\n${tail}` : msg, code: /ENOENT/.test(msg) ? 'SPAWN' : 'EXIT', sessionId: mapper.sessionId, costUsd: costNow() });
    }
  };

  /** 启动阶段就崩了（多半是 SDK 和用户的 claude 版本不合）：退回旧驱动，只退一次. */
  function startFallback(why) {
    if (finished) return;
    finished = true;
    clearTimeout(settle);
    closeInput();
    try { q.close(); } catch { /* 已经关了 */ }
    emit({ type: 'notice', level: 'warn', text: `Agent SDK 驱动没能启动（${why.slice(0, 100)}），改用旧的 stream-json 驱动：提问卡和计划审批在这个驱动下不可用。` });
    const legacy = deps.fallback(spec, emit);
    legacy.done.then(() => resolveDone());
    redirect = legacy;
    for (const [m, args] of pendingAfterFallback.splice(0)) legacy[m](...args);
  }
  let redirect = null;
  const pendingAfterFallback = [];

  async function onResult(res) {
    results += 1;
    const delta = deps.sessionDelta ? deps.sessionDelta(res.sessionId, res.totals, !!spec.sessionId) : (spec.sessionId ? null : { ...res.totals });
    let costNote = false;
    if (delta) {
      streamTokens = { input: streamTokens.input + delta.input, output: streamTokens.output + delta.output, cached: streamTokens.cached + delta.cacheRead };
      streamCost += delta.cost;
      costKnown = true;
    } else {
      streamTokens = { input: streamTokens.input + res.turnUsage.input, output: streamTokens.output + res.turnUsage.output, cached: streamTokens.cached + res.turnUsage.cacheRead };
      if (spec.apiKeyMode) { streamCost += res.totals.cost; costKnown = true; costNote = true; }
    }
    emit({ type: 'usage', total: true, input: streamTokens.input, output: streamTokens.output, cached: streamTokens.cached });
    if (costNote) emit({ type: 'notice', level: 'warn', text: '这个会话不是栖枝创建的，这次花费无法单独核算，预算账本按累计值保守计入。' });
    if (spec.apiKeyMode && deps.addSpend && delta) deps.addSpend(delta.cost);
    else if (spec.apiKeyMode && deps.addSpend && costNote) deps.addSpend(res.totals.cost);
    // 上下文占用（便宜的"摘要"版本）
    try {
      const ctx = await withTimeout(q.getContextUsage({ detail: 'summary' }), 2500);
      // 控制请求的返回是驼峰（totalTokens / rawMaxTokens），消息里的 SDKContextUsage 是蛇形；两种都认
      const used = ctx && (typeof ctx.totalTokens === 'number' ? ctx.totalTokens : ctx.total_tokens);
      const limit = ctx && (typeof ctx.rawMaxTokens === 'number' ? ctx.rawMaxTokens : ctx.raw_max_tokens);
      if (typeof used === 'number' && typeof limit === 'number' && limit > 0) emit({ type: 'context', used, limit });
    } catch { /* 取不到就不报 */ }

    const pendingSends = Math.max(0, sentTurns - results);
    const queuedTurns = res.queued !== undefined ? res.queued : pendingSends;
    clearTimeout(settle);
    const doneNow = (stopReason) => finish({ type: 'done', text: mapper.lastTurnText || res.turnText, stopReason, sessionId: res.sessionId, costUsd: costNow() });
    if (res.deferred) {
      finish({ type: 'error', message: '这次调用被推迟了（claude 报告 tool_deferred），没有执行。', code: 'DEFERRED', sessionId: res.sessionId, costUsd: costNow() });
    } else if (res.isError && !interrupted) {
      finish({ type: 'error', message: res.message, code: res.code, sessionId: res.sessionId, costUsd: costNow() });
    } else if (interrupted || (queuedTurns === 0 && pendingSends === 0)) {
      doneNow(interrupted ? 'interrupted' : res.stopReason);
    } else {
      emit({ type: 'text-break' });
      mapper.nextTurn();
      // claude 说队列里没有了，但我们发出的话比收到的回合多：要么并进了这一轮，要么下一轮马上开始。
      // 等一小会儿：有新动静（clearTimeout）就继续等，没有就收尾。
      if (queuedTurns === 0) settle = setTimeout(() => doneNow(res.stopReason), 2000);
    }
  }

  void pump();

  const ctl = {
    done,
    send(text) {
      if (redirect) { redirect.send && redirect.send(text); return; }
      if (finished) return;
      clearTimeout(settle);
      push(text);
    },
    answer(requestId, decision, input) {
      if (redirect) { redirect.answer && redirect.answer(requestId, decision, input); return; }
      answer(requestId, decision, input);
    },
    interrupt() {
      if (redirect) { redirect.interrupt(); return; }
      if (finished) return;
      interrupted = true;
      hookCtx.stopped = true;
      for (const w of waiting.values()) w.resolve({ behavior: 'deny', message: '使用者中断了运行。', interrupt: true });
      waiting.clear();
      try { Promise.resolve(q.interrupt()).catch(() => {}); } catch { /* 进程已经没了 */ }
      setTimeout(() => { if (!finished) closeInput(); }, 1500);
      setTimeout(() => { if (!finished) { try { q.close(); } catch { /* 已关 */ } } }, 5000);
    },
    stop() {
      if (redirect) { redirect.stop(); return; }
      if (finished) return;
      interrupted = true;
      hookCtx.stopped = true;
      for (const w of waiting.values()) w.resolve({ behavior: 'deny', message: '运行被停止。', interrupt: true });
      waiting.clear();
      // 取消 / 删任务 / 退出：在途的命令必须当场停。顺序要紧——
      //  1) 先发 interrupt（stdin 还开着才发得出去），让 claude 自己中止在途的工具；
      //  2) 关输入，再同步杀掉整棵进程树（taskkill /T /F）：SDK 的 close() 不杀子进程，退出时的 stopAll() 也等不起异步；
      //  3) 最后 abort / close 收尾（进程已经没了，它们只做清理）。
      try { Promise.resolve(q.interrupt()).catch(() => {}); } catch { /* 进程已经没了 */ }
      closeInput();
      if (proc) killTree(proc);
      try { abort.abort(); } catch { /* 已中止 */ }
      try { q.close(); } catch { /* 已关 */ }
    },
  };
  return ctl;
}

module.exports = { runClaudeSdk, loadSdk, normalizeQuestions, normalizeAnswers, SDK_UNDENY };
