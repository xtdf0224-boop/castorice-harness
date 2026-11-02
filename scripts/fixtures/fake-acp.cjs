'use strict';
// 假的 ACP 代理：JSON-RPC over stdio（MODELS-SPEC §15.3）。check-services（T-ACP）、check-engine、electron-check、services-electron-main 共用。
// 用 process.execPath 启动：node fake-acp.cjs；行为由环境变量控制。
//
// FAKE_ACP_MODE：逗号分隔的开关（可以组合，例如 "config-options,usage"）
//   config-options   session/new 返回 configOptions：model（分组选项）/ thought_level / mode；session/set_config_option 返回完整列表
//   legacy-modes     只有旧的 modes（默认；FAKE_ACP_MODES / FAKE_ACP_CURRENT 控制）
//   both-modes       config-options 之外同时返回旧的 modes（FAKE_ACP_CONFIG_MODES 给配置选项里的 mode 另一份取值，造出两边不一致）
//   models-legacy    session/new 带旧的 models: { availableModels, currentModelId }（+ session/set_model）
//   auth-required    initialize 给出 agent 型 authMethods；authenticate 之前 session/new|load|resume 报 -32000 "Authentication required"
//   auth-terminal    authMethods 只有 terminal 型（客户端不能替它登录）
//   auth-many        两个 agent 型 authMethods（不该猜）
//   auth-fails       authenticate 本身报错
//   resume-only      sessionCapabilities.resume，没有 loadSession
//   load-only        loadSession，没有 resume
//   resume-and-load  两样都有（resume 应该优先）
//   resume-fails     session/resume 报错（有 loadSession 就退到 session/load，否则退到 session/new）
//   load-fails       session/load 报错
//   perm-hyphen      权限选项 id / kind 写成 allow-once / reject-once
//   perm-unknown     权限选项里有未知 kind（allow_forever），reject_once 正常
//   perm-noreject    权限选项全是未知 kind
//   blocking-ext     收到 prompt 后发 cursor/ask_question（请求，会一直等答复）
//   elicit           收到 prompt 后发 elicitation/create
//   usage            结束前发 usage_update { used, size, cost }
//   slow             session/prompt 永不回应，也不理 session/cancel（验证 3 秒后杀进程）
//   slow-cancel      session/prompt 不回应，直到 session/cancel 才以 cancelled 结束
//   no-init          永不回应 initialize（验证探测超时）
//   set-config-fails session/set_config_option 报错
//   config-update    prompt 时发 config_option_update（改 model 的当前值）
//   cancel-request   记录 $/cancel_request（RPC 日志里本来就有；此开关让 prompt 一直挂着直到收到它）
//   exit-early       initialize 之后立刻退出（验证“意外退出”）
//   stdout-noise     每行前先打一行非 JSON 垃圾
// 旧的环境变量（hook-probe 版）：FAKE_ACP_MODES（JSON，availableModes 的 id）、FAKE_ACP_CURRENT（currentModeId）、FAKE_ACP_LOG（set_mode 参数追加到这个文件）、
//   FAKE_ACP_FAIL_MODES（这些 modeId 的 set_mode 报错）、FAKE_ACP_PROMPT_LOG、FAKE_ACP_PERM_KIND（收到 prompt 后先发这个 kind 的权限请求）、
//   FAKE_ACP_PERM_LOG（权限答复追加到这个文件）、FAKE_ACP_ENV_DUMP + FAKE_ACP_ENV_KEYS（启动时把这些变量的值写进 DUMP 文件）。
// 新的：FAKE_ACP_RPC_LOG（收到的每个请求 / 通知 / 对我们请求的答复，一行一个 JSON）、FAKE_ACP_INFO（agentInfo，JSON）、FAKE_ACP_PID_FILE（把自己的进程号写进去，验证被杀）、
//   FAKE_ACP_ENV_KEYS 里写 * = 同时列出环境里所有变量的名字。
const fs = require('node:fs');
const readline = require('node:readline');

const flags = new Set(String(process.env.FAKE_ACP_MODE || '').split(',').map((s) => s.trim()).filter(Boolean));
const has = (f) => flags.has(f);
const modes = JSON.parse(process.env.FAKE_ACP_MODES || '["default","plan","auto","yolo"]');
let currentMode = process.env.FAKE_ACP_CURRENT || 'default';
const failModes = JSON.parse(process.env.FAKE_ACP_FAIL_MODES || '[]');
const configModes = JSON.parse(process.env.FAKE_ACP_CONFIG_MODES || JSON.stringify(modes));
const log = process.env.FAKE_ACP_LOG;
const promptLog = process.env.FAKE_ACP_PROMPT_LOG;
const permKind = process.env.FAKE_ACP_PERM_KIND;
const permLog = process.env.FAKE_ACP_PERM_LOG;
const rpcLog = process.env.FAKE_ACP_RPC_LOG;
if (process.env.FAKE_ACP_ENV_DUMP) {
  const dump = {};
  for (const k of String(process.env.FAKE_ACP_ENV_KEYS || '').split(',').filter(Boolean)) dump[k] = process.env[k] === undefined ? null : process.env[k];
  // FAKE_ACP_ENV_KEYS=* → also list the NAMES of every variable the process was started with (a probe must not hand over this app's whole environment)
  const names = String(process.env.FAKE_ACP_ENV_KEYS || '').split(',').includes('*') ? Object.keys(process.env) : undefined;
  fs.writeFileSync(process.env.FAKE_ACP_ENV_DUMP, JSON.stringify({ env: dump, names, argv: process.argv.slice(2), cwd: process.cwd() }));
}
if (process.env.FAKE_ACP_PID_FILE) fs.writeFileSync(process.env.FAKE_ACP_PID_FILE, String(process.pid));
const note = (o) => { if (rpcLog) fs.appendFileSync(rpcLog, `${JSON.stringify(o)}\n`); };
const send = (o) => {
  if (has('stdout-noise')) process.stdout.write('this is not json\n');
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...o })}\n`);
};

/* ───────────── state ───────────── */
const SESSION = 'acp-1';
let authenticated = !(has('auth-required') || has('auth-many') || has('auth-fails') || has('auth-terminal'));
let promptId = null;
const config = {
  model: 'm-fast', effort: 'medium', mode: currentMode,
};
const configOptions = () => [
  { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: config.model, options: [
    { group: 'recommended', name: '推荐', options: [{ value: 'm-fast', name: 'Fast', description: '快' }, { value: 'm-pro', name: 'Pro', description: '强' }] },
    { group: 'other', name: '其他', options: [{ value: 'm-old', name: 'Old' }] },
  ] },
  { id: 'effort', name: '思考', category: 'thought_level', type: 'select', currentValue: config.effort, options: [
    { value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'turbo', name: 'Turbo' },
  ] },
  { id: 'mode', name: '模式', category: 'mode', type: 'select', currentValue: config.mode, options: configModes.map((id) => ({ value: id, name: id })) },
  { id: 'flag', name: '开关', category: '_custom', type: 'boolean', currentValue: true },
];

const initResult = () => {
  const caps = { loadSession: has('load-only') || has('resume-and-load') };
  if (has('resume-only') || has('resume-and-load')) caps.sessionCapabilities = { resume: {}, list: {}, close: {} };
  caps.mcpCapabilities = { http: true, sse: false };
  caps.promptCapabilities = { image: true };
  const res = { protocolVersion: 1, agentCapabilities: caps, agentInfo: process.env.FAKE_ACP_INFO ? JSON.parse(process.env.FAKE_ACP_INFO) : { name: 'fake-acp', title: 'Fake ACP', version: '0.0.1' } };
  if (has('auth-required') || has('auth-many') || has('auth-fails')) {
    res.authMethods = [{ id: 'agent-login', name: '登录', description: '让代理自己登录', type: 'agent' }];
    if (has('auth-many')) res.authMethods.push({ id: 'agent-key', name: '密钥', type: 'agent' });
  }
  if (has('auth-terminal')) res.authMethods = [{ id: 'term', name: '终端登录', type: 'terminal', args: ['login'] }];
  return res;
};
const needsAuth = () => (has('auth-required') || has('auth-many') || has('auth-fails') || has('auth-terminal')) && !authenticated;
const sessionResult = () => {
  const r = {};
  if (has('config-options')) r.configOptions = configOptions();
  if (!has('config-options') || has('both-modes')) r.modes = { currentModeId: currentMode, availableModes: modes.map((id) => ({ id, name: id })) };
  if (has('models-legacy')) r.models = { currentModelId: config.model, availableModels: [{ modelId: 'm-fast', name: 'Fast' }, { modelId: 'm-pro', name: 'Pro' }] };
  return r;
};

const finishPrompt = () => {
  if (has('usage')) send({ method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'usage_update', used: 1234, size: 200000, cost: { amount: 0.5, currency: 'USD' } } } });
  if (has('config-update')) send({ method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'config_option_update', configOptions: configOptions().map((o) => (o.id === 'model' ? { ...o, currentValue: 'm-pro' } : o)) } } });
  send({ method: 'session/update', params: { sessionId: SESSION, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的。' } } } });
  send({ id: promptId, result: { stopReason: 'end_turn' } });
};
const permOptions = () => {
  if (has('perm-hyphen')) return [{ optionId: 'allow-once', name: '允许', kind: 'allow-once' }, { optionId: 'reject-once', name: '拒绝', kind: 'reject-once' }];
  if (has('perm-unknown')) return [{ optionId: 'yes-forever', name: '总是允许', kind: 'allow_forever' }, { optionId: 'reject', name: '拒绝', kind: 'reject_once' }];
  if (has('perm-noreject')) return [{ optionId: 'yes-forever', name: '总是允许', kind: 'allow_forever' }, { optionId: 'nope', name: '不', kind: 'deny' }];
  return [{ optionId: 'allow', name: '允许', kind: 'allow_once' }, { optionId: 'reject', name: '拒绝', kind: 'reject_once' }];
};

if (has('exit-early')) process.exit(3);

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.method) note({ method: m.method, params: m.params, id: m.id });
  else if (m.id !== undefined) note({ response: m.id, result: m.result, error: m.error });

  if (m.method === 'initialize') {
    if (has('no-init')) return;
    send({ id: m.id, result: initResult() });
  } else if (m.method === 'authenticate') {
    if (has('auth-fails')) { send({ id: m.id, error: { code: -32000, message: '登录失败' } }); return; }
    authenticated = true;
    send({ id: m.id, result: {} });
  } else if (m.method === 'session/new') {
    if (needsAuth()) { send({ id: m.id, error: { code: -32000, message: 'Authentication required' } }); return; }
    send({ id: m.id, result: { sessionId: SESSION, ...sessionResult() } });
  } else if (m.method === 'session/load' || m.method === 'session/resume') {
    if (needsAuth()) { send({ id: m.id, error: { code: -32000, message: 'Authentication required' } }); return; }
    if ((has('resume-fails') && m.method === 'session/resume') || (has('load-fails') && m.method === 'session/load')) { send({ id: m.id, error: { code: -32002, message: 'session not found' } }); return; }
    // load replays the history; resume must not
    if (m.method === 'session/load') send({ method: 'session/update', params: { sessionId: m.params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '（历史回放）' } } } });
    send({ id: m.id, result: sessionResult() });
  } else if (m.method === 'session/set_mode') {
    if (log) fs.appendFileSync(log, `${JSON.stringify(m.params)}\n`);
    if (failModes.includes(m.params && m.params.modeId)) send({ id: m.id, error: { code: -32000, message: 'mode not supported' } });
    else { currentMode = m.params.modeId; config.mode = currentMode; send({ id: m.id, result: {} }); }
  } else if (m.method === 'session/set_config_option') {
    if (has('set-config-fails')) { send({ id: m.id, error: { code: -32602, message: 'cannot set' } }); return; }
    const { configId, value } = m.params || {};
    if (configId === 'mode') {
      if (log) fs.appendFileSync(log, `${JSON.stringify({ modeId: value, via: 'config' })}\n`);
      if (failModes.includes(value)) { send({ id: m.id, error: { code: -32000, message: 'mode not supported' } }); return; }
      currentMode = value;
    }
    if (configId === 'model') config.model = value;
    if (configId === 'effort') config.effort = value;
    if (configId === 'mode') config.mode = value;
    send({ id: m.id, result: { configOptions: configOptions() } });
  } else if (m.method === 'session/set_model') {
    config.model = m.params.modelId;
    send({ id: m.id, result: {} });
  } else if (m.method === 'session/prompt') {
    if (promptLog) fs.appendFileSync(promptLog, 'prompt\n');
    promptId = m.id;
    if (has('slow') || has('slow-cancel') || has('cancel-request')) return;     // never answered here
    if (has('blocking-ext')) { send({ id: 9101, method: 'cursor/ask_question', params: { sessionId: SESSION, question: '继续吗？' } }); return; }
    if (has('elicit')) { send({ id: 9102, method: 'elicitation/create', params: { sessionId: SESSION, message: '请选择' } }); return; }
    if (permKind) {
      send({ id: 9001, method: 'session/request_permission', params: { sessionId: SESSION, toolCall: { toolCallId: 't1', kind: permKind, title: 'tool' }, options: permOptions() } });
    } else finishPrompt();
  } else if (m.method === 'session/cancel') {
    if (has('slow-cancel') && promptId !== null) send({ id: promptId, result: { stopReason: 'cancelled' } });
  } else if (m.method === '$/cancel_request') {
    if (has('cancel-request') && promptId !== null) send({ id: promptId, error: { code: -32800, message: 'request cancelled' } });
  } else if (m.id === 9001 && !m.method) {
    if (permLog) fs.appendFileSync(permLog, `${JSON.stringify(m.result)}\n`);
    finishPrompt();
  } else if ((m.id === 9101 || m.id === 9102) && !m.method) {
    // the answer to our blocking extension request (an error is what it should be): carry on
    if (permLog) fs.appendFileSync(permLog, `${JSON.stringify(m.error || m.result)}\n`);
    finishPrompt();
  } else if (m.id !== undefined && m.method) send({ id: m.id, error: { code: -32601, message: 'not supported' } });
});
