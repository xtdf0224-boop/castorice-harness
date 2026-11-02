// X17 钩子探针（V0α 出口测试）。
// 问题：Claude Agent SDK 里 PreToolUse 钩子能不能当"放行主路径"？
//   ① default / acceptEdits / bypassPermissions / plan / dontAsk / auto 下是否都触发；
//   ② allow / deny / ask / defer / 抛异常 各是什么语义（与 canUseTool 谁先谁后）；
//   ③ 子 agent（Agent 工具）里的工具调用是否触发、带什么标记；
//   ④ AskUserQuestion、ExitPlanMode 经 canUseTool 的形态与回写方式。
// 做法：本机假 Anthropic 服务（127.0.0.1 随机端口，SSE，按脚本回 tool_use）+ ANTHROPIC_BASE_URL + 假 key +
//   临时 CLAUDE_CONFIG_DIR，跑 SDK 自带二进制（不碰用户的 claude 与配置，不联网，不花额度）。
//
//   node scripts/probe/hook-probe/probe.mjs [--out <dir>] [--only <子串>] [--list] [--timeout <ms>]
// 输出：<out>/results.json（全部原始记录）与 <out>/tables.md（可直接贴进 docs/HOOK-PROBE.md 的表与日志摘录）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FAST_MODEL, startFakeAnthropic } from './fake-anthropic.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..', '..');
const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const OUT = path.resolve(flag('--out') || path.join(os.tmpdir(), 'alight-hook-probe-out'));
const ONLY = flag('--only');
const RUN_TIMEOUT = Number(flag('--timeout')) || 60000;
fs.mkdirSync(OUT, { recursive: true });

const sdk = await import(pathToFileURL(path.join(APP, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs')).href);
const SDK_VERSION = JSON.parse(fs.readFileSync(path.join(APP, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
const fake = await startFakeAnthropic();

/* ───────────── 脚本零件 ───────────── */

const brief = (v, n = 160) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s && s.length > n ? `${s.slice(0, n)}…` : s; };
const shellName = (req) => (req.tools.includes('Bash') ? 'Bash' : 'PowerShell');

const T = {
  text: (s) => ({ blocks: [{ type: 'text', text: s }] }),
  write: (file, content = 'probe\n') => ({ blocks: [{ type: 'text', text: '试写一个文件。' }, { type: 'tool_use', name: 'Write', input: { file_path: file, content } }] }),
  shell: (cmd) => ({ blocks: (req) => [{ type: 'text', text: '试跑一条命令。' }, { type: 'tool_use', name: shellName(req), input: { command: cmd, description: 'probe' } }] }),
  tool: (name, input) => ({ blocks: [{ type: 'tool_use', name, input }] }),
  toolIfPresent: (name, input) => ({ blocks: (req) => (req.tools.includes(name) ? [{ type: 'tool_use', name, input }] : [{ type: 'text', text: `（本轮没有 ${name} 工具）` }]) }),
};

const QUESTION = { questions: [{ question: '封面选哪一张？', header: '封面', options: [{ label: 'A 夜景', description: '第一张' }, { label: 'B 白昼', description: '第二张' }], multiSelect: false }] };

/** 钩子策略：返回 undefined/'none' = 不表态；{decision, reason}；'throw' = 钩子自己出错。 */
const HOOK = {
  none: () => 'none',
  allow: () => ({ decision: 'allow', reason: 'probe-allow' }),
  deny: () => ({ decision: 'deny', reason: 'probe-deny: 栖枝钩子拒绝了这次调用' }),
  ask: () => ({ decision: 'ask', reason: 'probe-ask' }),
  defer: () => ({ decision: 'defer', reason: 'probe-defer' }),
  throw: () => 'throw',
  /** 只放行 AskUserQuestion / ExitPlanMode 以外的（用来试"钩子 allow 会不会让问答跳过 canUseTool"） */
  allowAll: () => ({ decision: 'allow', reason: 'probe-allow-all' }),
  denyShell: (i) => (/^(Bash|PowerShell)$/.test(i.tool_name) ? { decision: 'deny', reason: 'probe-deny-shell' } : 'none'),
  denyInSub: (i) => (i.agent_id ? { decision: 'deny', reason: 'probe-deny-in-subagent' } : 'none'),
};

/** canUseTool 策略。 */
const CAN = {
  allow: (name, input) => ({ behavior: 'allow', updatedInput: input }),
  deny: () => ({ behavior: 'deny', message: 'probe-can-deny: 用户在栖枝里拒绝了这次操作' }),
  answer: (name, input) => (name === 'AskUserQuestion'
    ? { behavior: 'allow', updatedInput: { ...input, answers: { [input.questions?.[0]?.question ?? '?']: 'B 白昼' } } }
    : { behavior: 'allow', updatedInput: input }),
  planDeny: (name, input) => (name === 'ExitPlanMode' ? { behavior: 'deny', message: 'probe: 计划还要改，请把第 2 步拆开' } : { behavior: 'allow', updatedInput: input }),
  planAcceptEdits: (name, input) => (name === 'ExitPlanMode'
    ? { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }] }
    : { behavior: 'allow', updatedInput: input }),
};

/* ───────────── 一次运行 ───────────── */

async function runScenario(sc) {
  fake.reset();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-probe-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  const cfg = path.join(root, 'cfg'); fs.mkdirSync(cfg);
  const ctx = { cwd, file: (n) => path.join(cwd, n) };
  const t0 = Date.now();
  const events = [];
  const ev = (kind, data) => events.push({ ms: Date.now() - t0, kind, ...data });
  fake.queue(sc.turns(ctx));

  const hookPolicy = HOOK[sc.hook || 'none'];
  const canPolicy = CAN[sc.can || 'allow'];
  const observe = (name) => ({ hooks: [async (input, toolUseID) => { ev(name, { tool: input.tool_name, mode: input.permission_mode, agent_id: input.agent_id, tool_use_id: toolUseID, reason: input.reason }); return {}; }] });
  const hooks = {
    PreToolUse: [{ hooks: [async (input, toolUseID) => {
      ev('hook:PreToolUse', { tool: input.tool_name, mode: input.permission_mode, agent_id: input.agent_id, agent_type: input.agent_type, tool_use_id: toolUseID, input: brief(input.tool_input) });
      const d = hookPolicy(input);
      if (d === 'throw') { ev('hook:returns', { decision: 'THROW' }); throw new Error('probe: hook callback failed'); }
      if (d === 'none' || !d) { ev('hook:returns', { decision: 'none' }); return {}; }
      ev('hook:returns', { decision: d.decision });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: d.decision, permissionDecisionReason: d.reason } };
    }] }],
    PermissionRequest: [observe('hook:PermissionRequest')],
    PermissionDenied: [observe('hook:PermissionDenied')],
    PostToolUse: [observe('hook:PostToolUse')],
    PostToolUseFailure: [observe('hook:PostToolUseFailure')],
  };

  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(ANTHROPIC|CLAUDE)/i.test(k)) env[k] = v;
  Object.assign(env, {
    ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-fake-probe-key-not-real', CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_SMALL_FAST_MODEL: FAST_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: FAST_MODEL,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
  });

  const info = { init: null, statusModes: [], result: null, messageTypes: {}, stderr: '', error: null, timedOut: false };
  const options = {
    cwd, env, settingSources: [], strictMcpConfig: true, persistSession: false,
    permissionMode: sc.mode, allowDangerouslySkipPermissions: sc.mode === 'bypassPermissions' || undefined,
    hooks,
    canUseTool: async (name, input, opts) => {
      const d = canPolicy(name, input, opts);
      ev('canUseTool', { tool: name, agentID: opts.agentID, toolUseID: opts.toolUseID, title: opts.title, displayName: opts.displayName, decisionReason: opts.decisionReason, defaultToNo: opts.defaultToNo, suggestions: opts.suggestions ? opts.suggestions.length : 0, input: brief(input, 300), returns: d.behavior, updatedPermissions: d.updatedPermissions ? d.updatedPermissions.map((u) => `${u.type}:${u.mode || ''}`) : undefined });
      return d;
    },
    stderr: (d) => { info.stderr = (info.stderr + d).slice(-1500); },
    ...(sc.mcp ? { mcpServers: { stub: { type: 'stdio', command: process.execPath, args: [path.join(HERE, 'mcp-stub.mjs'), path.join(cwd, 'mcp-ran.txt')] } } } : {}),
    ...(sc.options || {}),
  };
  if (sc.noCanUseTool) delete options.canUseTool;
  if (sc.classifier) fake.setClassifier(sc.classifier);

  // 流式输入（多轮）：steps = [{ send }, { setMode }, …]，每个 result 之后执行下一步；全部做完关闭输入
  let prompt = sc.prompt || '探针：按脚本执行。';
  let pushUser = null;
  let closeInput = null;
  if (sc.steps) {
    const inbox = [];
    let wake = null;
    let closed = false;
    pushUser = (text) => { inbox.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null }); wake?.(); };
    closeInput = () => { closed = true; wake?.(); };
    prompt = (async function* gen() {
      while (true) {
        while (!inbox.length) { if (closed) return; await new Promise((r) => { wake = r; }); }
        yield inbox.shift();
      }
    })();
  }
  const q = sdk.query({ prompt, options });
  let stepIndex = 0;
  const nextStep = async () => {
    while (sc.steps && stepIndex < sc.steps.length) {
      const st = sc.steps[stepIndex++];
      if (st.send) { ev('step:send', { text: st.send }); pushUser(st.send); return; }
      if (st.setMode) { ev('step:setPermissionMode', { mode: st.setMode }); try { await q.setPermissionMode(st.setMode); } catch (e) { ev('step:setPermissionMode-error', { error: String(e && e.message || e) }); } }
      if (st.interrupt) { ev('step:interrupt', {}); try { await q.interrupt(); } catch (e) { ev('step:interrupt-error', { error: String(e && e.message || e) }); } }
    }
    closeInput();
  };
  if (sc.steps) await nextStep();
  const timer = setTimeout(() => { info.timedOut = true; ev('timeout', {}); try { closeInput?.(); q.close(); } catch { /* gone */ } }, RUN_TIMEOUT);
  try {
    for await (const m of q) {
      if (m.type === 'result' && sc.steps) { ev('result', { subtype: m.subtype, text: brief(m.result, 80), queued: m.queued_turn_count }); await nextStep(); }
      info.messageTypes[`${m.type}${m.subtype ? `/${m.subtype}` : ''}`] = (info.messageTypes[`${m.type}${m.subtype ? `/${m.subtype}` : ''}`] || 0) + 1;
      if (m.type === 'system' && m.subtype === 'init') info.init = { model: m.model, permissionMode: m.permissionMode, tools: m.tools, apiKeySource: m.apiKeySource, version: m.claude_code_version };
      else if (m.type === 'system' && m.subtype === 'status' && m.permissionMode) { info.statusModes.push(m.permissionMode); ev('status', { permissionMode: m.permissionMode }); }
      else if (m.type === 'system' && /permission|hook_response/.test(m.subtype || '')) ev(`sys:${m.subtype}`, { text: brief(m, 300) });
      else if (m.type === 'result') info.result = { subtype: m.subtype, is_error: m.is_error, text: brief(m.result, 200), cost: m.total_cost_usd, denials: (m.permission_denials || []).map((d) => `${d.tool_name}`), stop_reason: m.stop_reason };
    }
  } catch (e) { info.error = String(e && e.message || e); }
  clearTimeout(timer);

  // 事后：文件是否真的写了、命令是否真的跑了
  const files = {};
  for (const f of sc.check || []) files[f] = fs.existsSync(path.join(cwd, f));
  const toolResults = fake.requests.flatMap((r) => (r.toolResults || []).map((x) => ({ req: r.n, ...x })));
  const firstReq = fake.requests.find((r) => !r.side);
  const out = {
    name: sc.name, mode: sc.mode, hook: sc.hook || 'none', can: sc.can || 'allow', note: sc.note,
    ms: Date.now() - t0, info, events, files, toolResults,
    requests: fake.requests.map((r) => ({ n: r.n, side: r.side, model: r.model, tools: r.tools?.length, sys: r.system, replied: r.replied, results: r.toolResults?.length, url: r.url })),
    toolsInFirstRequest: firstReq ? firstReq.tools : [],
    scriptLeft: fake.pending(),
  };
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  return out;
}

/* ───────────── 场景表 ───────────── */

const MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'];
const scenarios = [];

// A. Write × 模式 × 钩子决定（Write 是最典型的"需要许可"的写入）
for (const mode of MODES) {
  for (const hook of ['none', 'allow', 'deny', 'ask', 'defer', 'throw']) {
    scenarios.push({ name: `A.write/${mode}/hook=${hook}`, group: 'A', mode, hook, check: ['out.txt'], turns: (c) => [T.write(c.file('out.txt')), T.text('结束。')] });
  }
}
// B. 命令工具（PowerShell/Bash）× 模式 × 钩子（none/deny）
for (const mode of ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto']) {
  for (const hook of ['none', 'deny', 'allow']) {
    scenarios.push({ name: `B.shell/${mode}/hook=${hook}`, group: 'B', mode, hook, check: ['shell-ran.txt'], turns: () => [T.shell('echo x > shell-ran.txt'), T.text('结束。')] });
  }
}
// B2. 计划模式里的命令工具会过安全分类器（和自动模式同一套）：分类器怎么答、钩子 allow 能不能跳过它
for (const classifier of ['allow', 'block']) {
  for (const hook of ['none', 'allow']) {
    scenarios.push({ name: `B2.shell-in-plan/classifier=${classifier}/hook=${hook}`, group: 'B2', mode: 'plan', hook, classifier, check: ['shell-ran.txt'], turns: () => [T.shell('echo x > shell-ran.txt'), T.text('结束。')] });
  }
}
// C. 子 agent
for (const mode of ['default', 'bypassPermissions']) {
  for (const hook of ['none', 'denyInSub']) {
    scenarios.push({
      name: `C.subagent/${mode}/hook=${hook}`, group: 'C', mode, hook, check: ['sub.txt'],
      turns: (c) => [
        T.tool('Agent', { description: '探针子代理', prompt: '把 sub.txt 写出来。', subagent_type: 'general-purpose' }),
        T.write(c.file('sub.txt')), T.text('子代理完成。'), T.text('主线完成。'),
      ],
    });
  }
}
// D. AskUserQuestion
scenarios.push({ name: 'D.ask/default/hook=none/can=answer', group: 'D', mode: 'default', hook: 'none', can: 'answer', turns: () => [T.tool('AskUserQuestion', QUESTION), T.text('收到答案。')] });
scenarios.push({ name: 'D.ask/default/hook=allowAll/can=answer', group: 'D', mode: 'default', hook: 'allowAll', can: 'answer', note: '钩子对 AskUserQuestion 说 allow：canUseTool 还会不会被调用', turns: () => [T.tool('AskUserQuestion', QUESTION), T.text('收到答案。')] });
scenarios.push({ name: 'D.ask/bypassPermissions/hook=none/can=answer', group: 'D', mode: 'bypassPermissions', hook: 'none', can: 'answer', turns: () => [T.tool('AskUserQuestion', QUESTION), T.text('收到答案。')] });
scenarios.push({ name: 'D.ask/acceptEdits/hook=none/can=answer', group: 'D', mode: 'acceptEdits', hook: 'none', can: 'answer', turns: () => [T.tool('AskUserQuestion', QUESTION), T.text('收到答案。')] });
scenarios.push({ name: 'D.ask/default/hook=none/can=deny', group: 'D', mode: 'default', hook: 'none', can: 'deny', turns: () => [T.tool('AskUserQuestion', QUESTION), T.text('用户拒答。')] });
scenarios.push({ name: 'D.ask/plan/hook=none/can=answer', group: 'D', mode: 'plan', hook: 'none', can: 'answer', turns: () => [T.tool('AskUserQuestion', QUESTION), T.text('收到答案。')] });
scenarios.push({ name: 'D.ask/default/no-canUseTool', group: 'D', mode: 'default', hook: 'none', noCanUseTool: true, note: '没有 canUseTool 时问题会怎样', turns: () => [T.tool('AskUserQuestion', QUESTION), T.text('结束。')] });
// E. 计划模式与 ExitPlanMode（ExitPlanMode 是延迟工具：要先 ToolSearch 选中；计划正文在计划文件里，不在工具输入里）
const planFlow = (c) => [
  { blocks: (req) => (req.planFile
    ? [{ type: 'text', text: '先把计划写进计划文件。' }, { type: 'tool_use', name: 'Write', input: { file_path: req.planFile, content: '# 计划\n1. 读文件\n2. 写 after-plan.txt\n3. 汇报\n' } }]
    : [{ type: 'text', text: '（没找到计划文件路径）' }]) },
  T.tool('ToolSearch', { query: 'select:ExitPlanMode', max_results: 3 }),
  T.tool('ExitPlanMode', {}),
  T.write(c.file('after-plan.txt')),
  T.text('结束。'),
];
for (const [can, hook, note] of [
  ['allow', 'none', '批准计划，不带 updatedPermissions：之后的 Write 钩子看到什么模式、要不要问'],
  ['planDeny', 'none', '驳回计划（带一句话）：模型收到什么、模式是否仍是 plan'],
  ['planAcceptEdits', 'none', '批准计划并 setMode acceptEdits：之后的 Write 不再问'],
  ['allow', 'allowAll', '钩子对所有工具 allow：ExitPlanMode 还问不问'],
]) {
  scenarios.push({ name: `E.plan-flow/hook=${hook}/can=${can}`, group: 'E', mode: 'plan', hook, can, check: ['after-plan.txt'], note, turns: (c) => planFlow(c) });
}
scenarios.push({ name: 'E.plan/Write-in-plan/can=allow', group: 'E', mode: 'plan', hook: 'none', can: 'allow', check: ['plan-write.txt'], note: '计划模式里直接写一般文件', turns: (c) => [T.write(c.file('plan-write.txt')), T.text('结束。')] });
// F. 流式输入：中途改权限模式、追加用户消息
scenarios.push({
  name: 'F.stream/setPermissionMode', group: 'F', mode: 'default', hook: 'none', can: 'allow', check: ['one.txt', 'two.txt'],
  note: '第一句在 default（会问），然后 setPermissionMode(acceptEdits)，第二句的写入不再问',
  steps: [{ send: '第一句：写 one.txt' }, { setMode: 'acceptEdits' }, { send: '第二句：写 two.txt' }],
  turns: (c) => [T.write(c.file('one.txt')), T.text('第一句完成。'), T.write(c.file('two.txt')), T.text('第二句完成。')],
});
scenarios.push({
  name: 'F.stream/interrupt', group: 'F', mode: 'default', hook: 'none', can: 'allow',
  note: '打断后还能继续发下一句吗',
  steps: [{ send: '第一句' }, { interrupt: true }, { send: '第二句' }],
  turns: () => [T.text('第一句回答。'), T.text('第二句回答。')],
});
// A2. 自动模式（安全分类器是一次真实的模型请求：<severity>N</severity>）
for (const classifier of ['allow', 'block', 'garbage']) {
  for (const hook of ['none', 'allow', 'deny']) {
    scenarios.push({ name: `A2.auto-shell/classifier=${classifier}/hook=${hook}`, group: 'A2', mode: 'auto', hook, classifier, check: ['shell-ran.txt'], turns: () => [T.shell('echo x > shell-ran.txt'), T.text('结束。')] });
  }
}
scenarios.push({ name: 'A2.auto-write/classifier=block/hook=none', group: 'A2', mode: 'auto', hook: 'none', classifier: 'block', check: ['out.txt'], turns: (c) => [T.write(c.file('out.txt')), T.text('结束。')] });

// I. MCP 工具（经 mcpServers 对象直传的 stdio 服务；工具名 mcp__stub__ping）
for (const mode of ['default', 'bypassPermissions', 'auto']) {
  for (const hook of ['none', 'deny']) {
    scenarios.push({ name: `I.mcp/${mode}/hook=${hook}`, group: 'I', mode, hook, mcp: true, classifier: 'allow', check: ['mcp-ran.txt'], turns: () => [T.tool('mcp__stub__ping', {}), T.text('结束。')] });
  }
}
// G. 钩子结果传回模型的原话
scenarios.push({ name: 'G.deny-reason/default/hook=deny', group: 'G', mode: 'default', hook: 'deny', check: ['out.txt'], turns: (c) => [T.write(c.file('out.txt')), T.text('结束。')] });
scenarios.push({ name: 'G.deny-reason/default/can=deny', group: 'G', mode: 'default', hook: 'none', can: 'deny', check: ['out.txt'], turns: (c) => [T.write(c.file('out.txt')), T.text('结束。')] });
// H. 读取类工具（default 下不需要许可的调用，钩子是否仍触发）
scenarios.push({ name: 'H.read/default/hook=deny', group: 'H', mode: 'default', hook: 'deny', turns: (c) => [T.tool('Read', { file_path: c.file('nothing.txt') }), T.text('结束。')] });
scenarios.push({ name: 'H.read/bypassPermissions/hook=none', group: 'H', mode: 'bypassPermissions', hook: 'none', turns: (c) => [T.tool('Read', { file_path: c.file('nothing.txt') }), T.text('结束。')] });

const list = ONLY ? scenarios.filter((s) => s.name.includes(ONLY)) : scenarios;
if (argv.includes('--list')) { for (const s of scenarios) console.log(s.name); await fake.close(); process.exit(0); }

/* ───────────── 跑 + 出表 ───────────── */

const results = [];
for (const sc of list) {
  process.stdout.write(`[${results.length + 1}/${list.length}] ${sc.name} … `);
  let r;
  try { r = await runScenario(sc); } catch (e) { r = { name: sc.name, mode: sc.mode, hook: sc.hook, error: String(e && e.message || e), events: [], info: {}, files: {}, toolResults: [], requests: [] }; }
  r.group = sc.group;
  results.push(r);
  const hooks = r.events.filter((e) => e.kind === 'hook:PreToolUse').length;
  const cans = r.events.filter((e) => e.kind === 'canUseTool').length;
  process.stdout.write(`init=${r.info?.init?.permissionMode ?? '?'} hook×${hooks} can×${cans} files=${JSON.stringify(r.files)} ${r.ms}ms${r.info?.timedOut ? ' TIMEOUT' : ''}${r.error ? ` ERR ${r.error}` : ''}\n`);
}
await fake.close();
fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify({ sdkVersion: SDK_VERSION, at: new Date().toISOString(), results }, null, 1));

const cell = (b) => (b ? '是' : '否');
const md = [];
md.push(`SDK ${SDK_VERSION}，自带二进制 ${results.find((r) => r.info?.init)?.info.init.version ?? '?'}，${new Date().toISOString()}。\n`);

function table(group, title, cols) {
  const rows = results.filter((r) => r.group === group);
  if (!rows.length) return;
  md.push(`### ${title}\n`);
  md.push(`| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |`);
  md.push(`|---|---|---|---|---|---|---|`);
  for (const r of rows) {
    const pre = r.events.filter((e) => e.kind === 'hook:PreToolUse' && e.tool !== undefined);
    const toolEv = pre.filter((e) => cols.tool ? e.tool === cols.tool : true);
    const ran = Object.keys(r.files).length ? Object.values(r.files).some(Boolean) : r.events.some((e) => e.kind === 'hook:PostToolUse');
    const can = r.events.filter((e) => e.kind === 'canUseTool');
    const ret = r.events.filter((e) => e.kind === 'hook:returns').map((e) => e.decision).join('/');
    const tr = r.toolResults.map((x) => `${x.is_error ? '【错】' : ''}${x.content.replace(/\s+/g, ' ').slice(0, 110)}`).join(' ⏐ ');
    md.push(`| \`${r.name}\` | ${r.info?.init?.permissionMode ?? '?'} | ${toolEv.length ? `是 ×${toolEv.length}` : '否'} | ${ret || '—'} | ${can.length ? `是 ×${can.length}` : '否'} | ${cell(ran)} | ${tr || '—'} |`);
  }
  md.push('');
}
table('A', 'A. Write × 模式 × 钩子决定', {});
table('B', 'B. 命令工具 × 模式 × 钩子决定', {});
table('A2', 'A2. 自动模式 × 分类器回答 × 钩子决定（命令工具）', {});
table('B2', 'B2. 计划模式里的命令工具 × 分类器回答 × 钩子决定', {});
table('C', 'C. 子 agent', {});
table('D', 'D. AskUserQuestion', {});
table('E', 'E. ExitPlanMode / 计划模式', {});
table('F', 'F. 流式输入：中途改模式、打断', {});
table('G', 'G. 拒绝原因如何回到模型', {});
table('I', 'I. MCP 工具', {});
table('H', 'H. 只读工具', {});

md.push('### 原始日志摘录（事件序列，毫秒从场景开始算）\n');
for (const r of results.filter((x) => /A\.write\/(default|bypassPermissions|plan|auto)\/hook=(none|deny|ask)|C\.subagent|D\.ask\/default\/hook=(none|allowAll)|E\.plan\/hook=none\/can=(allow|planAcceptEdits)/.test(x.name))) {
  md.push(`#### ${r.name}\n`);
  md.push('```text');
  md.push(`init.permissionMode=${r.info?.init?.permissionMode} tools=${(r.toolsInFirstRequest || []).join(',')}`);
  for (const e of r.events) {
    const { ms, kind, ...rest } = e;
    md.push(`${String(ms).padStart(5)} ms  ${kind.padEnd(22)} ${JSON.stringify(rest)}`);
  }
  for (const x of r.toolResults) md.push(`  → 模型收到 tool_result（请求#${x.req}${x.is_error ? '，is_error' : ''}）：${x.content.replace(/\s+/g, ' ').slice(0, 260)}`);
  md.push(`  files=${JSON.stringify(r.files)} result=${JSON.stringify(r.info?.result)}`);
  md.push('```\n');
}
fs.writeFileSync(path.join(OUT, 'tables.md'), md.join('\n'));
console.log(`\n结果：${path.join(OUT, 'results.json')}\n表格：${path.join(OUT, 'tables.md')}`);
