'use strict';
// T-ACP（MODELS-SPEC §15.4）：通用 ACP 驱动与命令行代理登记，全部用假代理（scripts/fixtures/fake-acp.cjs）和回环上的假注册表，不联网、不开窗口。
//   scripts/check-services.ts 把自己的 ok / eq / section 交给 runTAcp；也可以单独跑：node scripts/fixtures/fake-acp-suite.cjs
//
// 覆盖：协议面（configOptions / 旧 modes / authenticate / resume 与 load / 权限选项归一化 / 阻塞的扩展请求 / usage_update / 取消 / 初始化超时）、
//       只读 fail-closed 与 Kimi 行为不变（check-engine ⑥ 的用例搬过来）、perm.cjs 读代理定义、
//       acp-agents.cjs（目录里的 19 个代理、伪服务、找程序、探测只做 initialize、官方注册表浏览 / 缓存 / 受限添加、自定义命令的令牌与参数校验、移除、IPC 表面）。
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..');
const FAKE = path.join(__dirname, 'fake-acp.cjs');
const isWin = process.platform === 'win32';

const readLines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(25); }
  return false;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function runTAcp(h) {
  const { ok, eq, section, mk } = h;
  const acpMod = require('../../electron/ai/acp.cjs');
  const perm = require('../../electron/ai/perm.cjs');
  const agentsMod = require('../../electron/ai/acp-agents.cjs');
  const servicesMod = h.servicesMod || require('../../electron/ai/services.cjs');
  const secrets = h.secrets || require('../../electron/ai/secrets.cjs');
  const net = require('../../electron/ai/net.cjs');
  const { runAcp } = acpMod;
  const catalog = servicesMod.catalog();
  const dir = mk('t-acp');

  /* ═════════════════════════ 纯函数 ═════════════════════════ */

  section('T-ACP 协议辅助函数');
  {
    const P = acpMod.pickPermissionOptions;
    eq('权限选项：标准写法', P([{ optionId: 'a', kind: 'allow_once' }, { optionId: 'r', kind: 'reject_once' }]), { allow: 'a', reject: 'r', unknown: 0 });
    eq('权限选项：连字符写法（Cursor 官方文档）归一化', P([{ optionId: 'allow-once', kind: 'allow-once' }, { optionId: 'reject-once', kind: 'reject-once' }]), { allow: 'allow-once', reject: 'reject-once', unknown: 0 });
    eq('权限选项：大小写与空白也归一化', P([{ optionId: 'a', kind: ' Allow-Always ' }, { optionId: 'r', kind: 'REJECT_ALWAYS' }]), { allow: 'a', reject: 'r', unknown: 0 });
    eq('权限选项：allow_once 优先于 allow_always', P([{ optionId: 'x', kind: 'allow_always' }, { optionId: 'y', kind: 'allow_once' }]).allow, 'y');
    eq('权限选项：未知 kind 既不是允许也不是拒绝', P([{ optionId: 'f', kind: 'allow_forever' }, { optionId: 'd', kind: 'deny' }]), { allow: undefined, reject: undefined, unknown: 2 });
    eq('权限选项：没有 optionId 的、不是对象的丢弃', P([{ kind: 'allow_once' }, null, 'x', { optionId: 3, kind: 'allow_once' }]).allow, undefined);
    eq('权限选项：不是数组', P(undefined), { allow: undefined, reject: undefined, unknown: 0 });
    eq('归一化 kind', [acpMod.normKind('allow-once'), acpMod.normKind(' Reject Once '), acpMod.normKind(null), acpMod.normKind('READ')], ['allow_once', 'reject_once', '', 'read']);

    eq('推理强度名字 → 量表', ['low', 'Medium', 'HIGH', 'x-high', 'extra_high', 'max', 'Maximum', 'none', 'off', 'ultra'].map(acpMod.mapEffort), ['low', 'medium', 'high', 'xhigh', 'xhigh', 'max', 'max', 'off', 'off', 'ultra']);
    eq('量表之外的名字认不出（不可选）', ['turbo', 'minimal', '', null, undefined, '__proto__', 'constructor'].map(acpMod.mapEffort), [null, null, null, null, null, null, null]);

    const grouped = [
      { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: 'a', options: [{ group: 'g1', name: '组一', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B', description: 'bb' }] }, { group: 'g2', name: '组二', options: [{ value: 'c', name: 'C' }] }] },
      { id: 'thought', name: '思考', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }, { value: 'turbo', name: 'Turbo' }] },
      { id: 'mode', name: '模式', category: 'mode', type: 'select', currentValue: 'plan', options: [{ value: 'plan', name: 'Plan' }, { value: 'code', name: 'Code' }] },
      { id: 'brave', name: 'Brave', type: 'boolean', currentValue: true },
      { id: 'custom', name: '自定义', category: '_x', type: 'select', currentValue: 'q', options: [{ value: 'q', name: 'Q' }] },
      { notAnOption: true }, null, { id: '', name: 'x' }, { id: 'y'.repeat(200), name: 'long' },
    ];
    const parsed = acpMod.parseConfigOptions(grouped);
    eq('配置选项：分组选项被摊平并保留组名；坏条目丢弃', [parsed.map((o) => o.id), parsed[0].values.map((v) => `${v.group}/${v.value}`)], [['model', 'thought', 'mode', 'brave', 'custom'], ['组一/a', '组一/b', '组二/c']]);
    eq('配置选项：boolean 保留但没有可选值', [parsed[3].type, parsed[3].values.length, parsed[3].current], ['boolean', 0, true]);
    const sum = acpMod.summarizeConfig(parsed);
    eq('配置摘要：模型 / 强度 / 模式', [sum.models.map((m) => m.id), sum.currentModel, sum.efforts.map((e) => `${e.id}:${e.level}`), sum.currentEffort, sum.modes.map((m) => m.id), sum.currentMode], [['a', 'b', 'c'], 'a', ['low:low', 'high:high', 'turbo:null'], 'high', ['plan', 'code'], 'plan']);
    eq('配置摘要：boolean 与自定义类不当成模型 / 强度 / 模式', acpMod.optionFor(parsed, 'brave'), undefined);
    eq('没有 category 时按 id 认 model / mode', [acpMod.optionFor(acpMod.parseConfigOptions([{ id: 'model', name: 'M', type: 'select', currentValue: 'x', options: [{ value: 'x', name: 'X' }] }]), 'model').id, acpMod.optionFor(acpMod.parseConfigOptions([{ id: 'foo', name: 'M', type: 'select', currentValue: 'x', options: [{ value: 'x', name: 'X' }] }]), 'model')], ['model', undefined]);
    const legacy = acpMod.summarizeConfig([], { modes: { currentModeId: 'm1', availableModes: [{ id: 'm1', name: 'One' }, { modeId: 'm2' }] }, models: { currentModelId: 'x1', availableModels: [{ modelId: 'x1', name: 'X1' }] } });
    eq('配置摘要：没有 configOptions 时读旧的 modes / models', [legacy.modes.map((m) => m.id), legacy.currentMode, legacy.models.map((m) => m.id), legacy.currentModel, legacy.source], [['m1', 'm2'], 'm1', ['x1'], 'x1', 'models']);

    const init = acpMod.parseInitialize({ protocolVersion: 1, agentInfo: { name: 'n', title: 'T', version: '1.2' }, authMethods: [{ id: 'a' }, { id: 'b', type: 'terminal' }, { id: 'c', type: 'weird' }, { nope: 1 }], agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {}, close: null }, mcpCapabilities: { http: true }, promptCapabilities: { image: true } } });
    eq('initialize：能力与认证方式', [init.caps, init.authMethods.map((m) => `${m.id}:${m.type}`), init.agentInfo], [{ loadSession: true, resume: true, list: false, close: false, mcpHttp: true, image: true }, ['a:agent', 'b:terminal', 'c:other'], { name: 'T', version: '1.2' }]);
    eq('initialize：什么都没有', acpMod.parseInitialize(undefined).caps, { loadSession: false, resume: false, list: false, close: false, mcpHttp: false, image: false });
    const E = (code, message, data) => Object.assign(new Error(message), { code, data });
    eq('认证错误的判断', [
      acpMod.isAuthRequired(E(-32000, 'Authentication required')), acpMod.isAuthRequired(E(-32603, 'please log in first')), acpMod.isAuthRequired(E(1, '需要登录')),
      acpMod.isAuthRequired(E(-32000, 'boom'), [{ id: 'a' }]), acpMod.isAuthRequired(E(-32000, 'boom'), []), acpMod.isAuthRequired(E(-32602, 'bad params'), [{ id: 'a' }]), acpMod.isAuthRequired(null),
    ], [true, true, true, true, false, false, false]);
  }

  section('T-ACP perm.cjs 读代理定义');
  {
    const kimi = catalog.agentById.get('kimi');
    eq('目录里只有 Kimi 的权限模式是验证过的（且登记了 modeMap）', catalog.agents.filter((a) => perm.acpVerified(a)).map((a) => a.id), ['kimi']);
    ok('verified 必须带 modeMap：没有 modeMap 的 verified 不算', !perm.acpVerified({ id: 'x', perm: { level: 'verified' } }) && !perm.acpVerified({ id: 'x', perm: { level: 'verified', modeMap: {} } }) && !perm.acpVerified(undefined) && !perm.acpVerified('no-such-agent'));
    eq('按 id 或按定义对象，结果一样', perm.acpPlan('kimi', 'bypass', ['default', 'yolo']), perm.acpPlan(kimi, 'bypass', ['default', 'yolo']));
    eq('Kimi 的提示语里仍叫 Kimi（旧文案）', [perm.acpPlan('kimi', 'bypass', ['yolo']).note, perm.acpPlan('kimi', 'acceptEdits').note, perm.acpPlan('kimi', 'auto', ['default']).note],
      ['Kimi 在这个模式下手套只记账、不拦截（已降级）。', 'Kimi 没有「只接受编辑」，按逐项确认处理（已降级）。', 'Kimi 这次没有提供「auto」模式，按它的默认处理（已降级）。']);
    const custom = { id: 'c-x', label: '某工具', perm: { level: 'verified', modeMap: { ask: 'ask', plan: 'planning', auto: 'autopilot', bypass: 'yolo', acceptEdits: 'edits' } } };
    eq('自己登记的、验证过的代理：模式名来自它的 modeMap', [perm.acpPlan(custom, 'plan', ['ask', 'planning']).modeId, perm.acpPlan(custom, 'acceptEdits', ['edits']).modeId, perm.acpPlan(custom, 'ask', undefined).modeId], ['planning', 'edits', 'ask']);
    ok('modeMap 里有单独的「接受编辑」就不再说降级', perm.acpPlan(custom, 'acceptEdits', ['edits']).note === undefined);
    ok('modeMap 里没登记的页面模式 → 按默认并说「已降级」', /已降级/.test(perm.acpPlan({ id: 'c-y', label: 'Y', perm: { level: 'verified', modeMap: { ask: 'a' } } }, 'plan', undefined).note));
    ok('没验证过的代理（目录里的其余 18 个）：不设模式，只说「未验证」', catalog.agents.filter((a) => a.id !== 'kimi').every((a) => perm.acpPlan(a, 'plan').modeId === undefined && /未验证/.test(perm.acpPlan(a, 'plan').note) && perm.acpPlan(a, 'ask').note === undefined));
    ok('catalog 里的 perm.level 只能是 verified / unverified', catalog.agents.every((a) => a.perm.level === 'verified' || a.perm.level === 'unverified'));
  }

  /* ═════════════════════════ 跑一个回合 ═════════════════════════ */

  let seq = 0;
  /**
   * @param {string} flags FAKE_ACP_MODE
   * @param {object} over  runAcp 的 spec；还有：answer（'allow' | 'deny'：自动回答转给页面的权限请求）、after(ctl, files)（启动后立即调用，不等待）
   * @param {object} env   给假代理的环境变量
   */
  async function go(flags, over = {}, env = {}) {
    const n = seq++;
    const files = { rpc: path.join(dir, `rpc-${n}.log`), modes: path.join(dir, `modes-${n}.log`), perm: path.join(dir, `perm-${n}.log`), prompt: path.join(dir, `prompt-${n}.log`), pid: path.join(dir, `pid-${n}.txt`) };
    const { answer, after, ...rest } = over;
    const spec = {
      exe: process.execPath, args: [FAKE], cwd: dir, prompt: 'hi', system: '', access: 'work', label: 'Fake', agent: undefined,
      env: { FAKE_ACP_MODE: flags, FAKE_ACP_RPC_LOG: files.rpc, FAKE_ACP_LOG: files.modes, FAKE_ACP_PERM_LOG: files.perm, FAKE_ACP_PROMPT_LOG: files.prompt, FAKE_ACP_PID_FILE: files.pid, ...env },
      ...rest,
    };
    const evs = [];
    const t0 = Date.now();
    const ctl = runAcp(spec, (e) => { evs.push(e); if (e.type === 'permission' && answer) setImmediate(() => ctl.answer(e.requestId, answer)); });
    if (after) after(ctl, files);
    await Promise.race([ctl.done, sleep(25_000)]);
    const rpc = readLines(files.rpc);
    return {
      evs, ctl, files, rpc, ms: Date.now() - t0,
      methods: rpc.filter((x) => x.method).map((x) => x.method),
      calls: (m) => rpc.filter((x) => x.method === m).map((x) => x.params),
      modes: readLines(files.modes).map((x) => x.modeId),
      perms: readLines(files.perm),
      prompted: fs.existsSync(files.prompt),
      notes: evs.filter((e) => e.type === 'notice').map((e) => e.text),
      done: evs.find((e) => e.type === 'done'), error: evs.find((e) => e.type === 'error'),
      forwarded: evs.some((e) => e.type === 'permission'),
      text: evs.filter((e) => e.type === 'text').map((e) => e.text).join(''),
    };
  }
  const outcomeOf = (r) => r.perms.map((p) => (p.outcome.outcome === 'selected' ? p.outcome.optionId : p.outcome.outcome));
  const anyNote = (r, re) => r.notes.some((t) => re.test(t));

  /* ═════════════════════════ 配置选项（模型 / 推理强度 / 模式） ═════════════════════════ */

  section('T-ACP 会话配置选项');
  {
    const r = await go('config-options', { agent: 'kimi', model: 'm-pro', effort: 'high', pageMode: 'plan', readOnly: true });
    const sets = r.calls('session/set_config_option').map((p) => `${p.configId}=${p.value}`);
    eq('configOptions：模型、强度、模式都来自选项，用 session/set_config_option 设置', sets, ['model=m-pro', 'effort=high', 'mode=plan']);
    ok('configOptions：有 configOptions 就不再用旧的 session/set_mode', !r.methods.includes('session/set_mode'));
    eq('configOptions：模式走的是配置选项（假代理记下 via:config），回合正常结束', [r.modes, !!r.done, r.evs.some((e) => e.type === 'model' && e.model === 'm-pro')], [['plan'], true, true]);
    ok('configOptions：boolean 选项从来不设', !r.calls('session/set_config_option').some((p) => p.configId === 'flag'));

    const same = await go('config-options', { agent: 'cline', model: 'm-fast', effort: 'medium' });
    eq('当前值已经是想要的就不重复设', same.calls('session/set_config_option'), []);

    const miss = await go('config-options', { agent: 'cline', model: 'no-such-model', effort: 'xhigh' });
    eq('模型列表里没有 / 强度没有这一档：不设，各说一句', [miss.calls('session/set_config_option'), anyNote(miss, /模型列表里没有「no-such-model」/), anyNote(miss, /没有「xhigh」这一档推理强度/), !!miss.done], [[], true, true, true]);
    const turbo = await go('config-options', { agent: 'cline', effort: 'turbo' });
    eq('代理自己的强度名（turbo）认不出：不可选', [turbo.calls('session/set_config_option'), anyNote(turbo, /没有「turbo」/)], [[], true]);
    const byName = await go('config-options', { agent: 'cline', model: 'PRO' });
    const viaEnv = await go('config-options', { agent: 'qwen', model: 'qwen3.7-plus' });
    eq('模型走环境变量的代理（Qwen 的 OPENAI_MODEL）：不去设它的配置选项，也不抱怨它的列表里没有这个模型', [viaEnv.calls('session/set_config_option').filter((p) => p.configId === 'model'), viaEnv.notes, viaEnv.evs.some((e) => e.type === 'model')], [[], [], false]);
    eq('模型按 id 或显示名（不分大小写）匹配', byName.calls('session/set_config_option').map((p) => p.value), ['m-pro']);

    const fail = await go('config-options,set-config-fails', { agent: 'cline', model: 'm-pro', effort: 'high' });
    eq('设模型 / 强度失败只是提示，回合照常进行', [anyNote(fail, /没能切到模型「m-pro」/), anyNote(fail, /没能设推理强度/), !!fail.done, fail.prompted], [true, true, true, true]);
    const failLock = await go('config-options,set-config-fails', { agent: 'kimi', pageMode: 'plan', readOnly: true }, { FAKE_ACP_CURRENT: 'yolo' });
    eq('只读 + 已验证的代理 + 会话停在 yolo + 设不上模式 → 不启动（fail-closed）', [failLock.error && failLock.error.code, failLock.prompted, !!failLock.done], ['ACP_READONLY', false, false]);
    const failSafe = await go('config-options,set-config-fails', { agent: 'kimi', pageMode: 'plan', readOnly: true });
    eq('同样设不上，但会话本来就在 default（安全的那个）→ 照常进行', [failSafe.error, failSafe.prompted, !!failSafe.done], [undefined, true, true]);

    const plainKimi = await go('', { agent: 'kimi', model: 'whatever' });
    eq('代理没有模型选项：不说话、不设（模型走别的办法，比如环境变量）', [plainKimi.notes, plainKimi.calls('session/set_config_option')], [[], []]);

    const legacyModels = await go('models-legacy', { agent: 'cline', model: 'm-pro' });
    eq('只有旧的 models 字段：用 session/set_model', legacyModels.calls('session/set_model'), [{ sessionId: 'acp-1', modelId: 'm-pro' }]);

    const both = await go('config-options,both-modes', { agent: 'kimi', pageMode: 'plan' });
    eq('两边都有 mode：配置选项里有这个模式就用配置选项，不再发 session/set_mode', [both.calls('session/set_config_option').map((p) => `${p.configId}=${p.value}`), both.methods.includes('session/set_mode')], [['mode=plan'], false]);
    const mixed = await go('config-options,both-modes', { agent: 'kimi', pageMode: 'plan' }, { FAKE_ACP_CONFIG_MODES: JSON.stringify(['default']) });
    eq('配置选项里没有、旧 modes 里有：按旧的 session/set_mode 设（以点名这个模式的那份列表为准）', [mixed.calls('session/set_mode'), mixed.calls('session/set_config_option').filter((p) => p.configId === 'mode'), !!mixed.done], [[{ sessionId: 'acp-1', modeId: 'plan' }], [], true]);
    const same2 = await go('config-options', { agent: 'kimi', pageMode: 'bypass' });
    eq('放手（Kimi 的 yolo）也走配置选项，并说手套只记账', [same2.modes, anyNote(same2, /只记账/)], [['yolo'], true]);
  }

  /* ═════════════════════════ 认证 ═════════════════════════ */

  section('T-ACP authenticate');
  {
    const r = await go('auth-required', { agent: 'kimi' });
    eq('需要登录：session/new 失败 → authenticate 一次 → 重试', r.methods, ['initialize', 'session/new', 'authenticate', 'session/new', 'session/prompt']);
    eq('authenticate 用的是代理给的 agent 型方法', [r.calls('authenticate'), !!r.done, anyNote(r, /需要登录，正在请它自己发起登录/)], [[{ methodId: 'agent-login' }], true, true]);

    const term = await go('auth-terminal', { agent: 'kimi' });
    ok('只有 terminal 型方法：不替用户登录，告诉他在终端里登录', !term.methods.includes('authenticate') && term.error && term.error.code === 'ACP_AUTH' && /请先在终端登录：kimi login/.test(term.error.message) && !term.prompted, JSON.stringify(term.error));
    const noArgs = await go('auth-terminal', { agent: 'gemini' });
    ok('没有 loginArgs 的代理：给登录提示', noArgs.error && noArgs.error.code === 'ACP_AUTH' && /还没有登录/.test(noArgs.error.message) && /Google/.test(noArgs.error.message), JSON.stringify(noArgs.error));

    const many = await go('auth-many', { agent: 'kimi' });
    ok('有两个 agent 型方法又没有允许表：不猜', !many.methods.includes('authenticate') && many.error && many.error.code === 'ACP_AUTH');
    const allowed = await go('auth-many', { agentDef: { ...catalog.agentById.get('kimi'), auth: { ...catalog.agentById.get('kimi').auth, methodIds: ['agent-key'] } }, agent: 'kimi' });
    eq('定义里有允许表：只用表里的方法', [allowed.calls('authenticate'), !!allowed.done], [[{ methodId: 'agent-key' }], true]);

    const keyDef = { ...catalog.agentById.get('kimi'), auth: { mode: 'env-key', loginHint: '' }, binding: { mode: 'env', keyEnv: 'MY_AGENT_KEY', env: {}, optional: true } };
    const keyed = await go('auth-many', { agentDef: keyDef, agent: 'kimi' }, { MY_AGENT_KEY: 'k-1234567890' });
    eq('保存了密钥并放进了环境：几个方法里只有一个是“密钥 / 令牌”的，就用它（Gemini 的 gemini-api-key 就是这样选的）', [keyed.calls('authenticate'), !!keyed.done], [[{ methodId: 'agent-key' }], true]);
    const unkeyed = await go('auth-many', { agentDef: keyDef, agent: 'kimi' });
    ok('没有密钥时同样的两个方法仍然不猜', !unkeyed.methods.includes('authenticate') && unkeyed.error && unkeyed.error.code === 'ACP_AUTH');
    // 真实代理的 authMethods（V7 实测）：Kimi 只有 terminal 型的 login；Gemini 有 4 个 agent 型
    const real = acpMod.parseInitialize({ protocolVersion: 1, authMethods: [{ id: 'oauth-personal', name: 'Log in with Google' }, { id: 'gemini-api-key', name: 'Gemini API key' }, { id: 'vertex-ai', name: 'Vertex AI' }, { id: 'gateway', name: 'AI API Gateway' }] });
    eq('Gemini 的四个方法都是 agent 型', real.authMethods.map((m) => `${m.id}:${m.type}`), ['oauth-personal:agent', 'gemini-api-key:agent', 'vertex-ai:agent', 'gateway:agent']);
    eq('只有 gemini-api-key 的名字像密钥', real.authMethods.filter((m) => /key|token/i.test(`${m.id} ${m.name}`)).map((m) => m.id), ['gemini-api-key']);

    const bad = await go('auth-fails', { agent: 'kimi' });
    ok('它自己的登录失败：说明，不继续', bad.error && bad.error.code === 'ACP_AUTH' && /没有完成/.test(bad.error.message) && !bad.prompted, JSON.stringify(bad.error));

    const plain = await go('', { agent: 'kimi' });
    ok('不需要登录：不调 authenticate', !plain.methods.includes('authenticate') && !!plain.done);
    const clientCaps = plain.calls('initialize')[0];
    eq('initialize：fs / terminal 声明为假，不声明 auth.terminal / elicitation / 布尔选项', [clientCaps.protocolVersion, clientCaps.clientCapabilities, clientCaps.clientInfo.name], [1, { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, 'Alight']);
  }

  /* ═════════════════════════ 会话：resume / load / new ═════════════════════════ */

  section('T-ACP 会话恢复');
  {
    const sys = { system: 'SYSTEM', sessionId: 'old-session' };
    const promptOf = (r) => (r.calls('session/prompt')[0].prompt[0].text);
    const rs = await go('resume-only', { agent: 'qwen', ...sys });
    eq('resume：只发 session/resume，不新建、不回放', [rs.methods, rs.evs.find((e) => e.type === 'session').sessionId, promptOf(rs)], [['initialize', 'session/resume', 'session/prompt'], 'old-session', 'hi']);
    const ld = await go('load-only', { agent: 'qwen', ...sys });
    eq('load：发 session/load，历史回放的更新被丢掉', [ld.methods, ld.text, promptOf(ld)], [['initialize', 'session/load', 'session/prompt'], '好的。', 'hi']);
    const both = await go('resume-and-load', { agent: 'qwen', ...sys });
    eq('两样都支持：resume 优先于 load', both.methods, ['initialize', 'session/resume', 'session/prompt']);
    const none = await go('', { agent: 'qwen', ...sys });
    ok('都不支持：新建会话，说「不支持恢复」，系统提示重新带上', none.methods.join() === 'initialize,session/new,session/prompt' && anyNote(none, /不支持恢复上次的会话/) && promptOf(none).startsWith('SYSTEM'), none.methods.join());
    const fails = await go('resume-only,resume-fails', { agent: 'qwen', ...sys });
    ok('resume 失败：退到新会话，说「没能恢复」，系统提示重新带上', fails.methods.join() === 'initialize,session/resume,session/new,session/prompt' && anyNote(fails, /没能恢复上次的会话/) && promptOf(fails).startsWith('SYSTEM'), fails.methods.join());
    const rl = await go('resume-and-load,resume-fails', { agent: 'qwen', ...sys });
    eq('resume 失败、代理还支持 load：改用 load，会话保住', [rl.methods, rl.evs.find((e) => e.type === 'session').sessionId, rl.notes.some((t) => /恢复/.test(t))], [['initialize', 'session/resume', 'session/load', 'session/prompt'], 'old-session', false]);
    const rlf = await go('resume-and-load,resume-fails,load-fails', { agent: 'qwen', ...sys });
    ok('两个都失败：新会话，说「没能恢复」，系统提示重新带上', rlf.methods.join() === 'initialize,session/resume,session/load,session/new,session/prompt' && anyNote(rlf, /没能恢复上次的会话/) && promptOf(rlf).startsWith('SYSTEM'), rlf.methods.join());
    const fresh = await go('resume-only', { agent: 'qwen', system: 'SYSTEM' });
    ok('没有旧会话 ID：新会话带系统提示', promptOf(fresh).startsWith('SYSTEM') && !anyNote(fresh, /恢复/));
  }

  /* ═════════════════════════ 权限请求 ═════════════════════════ */

  section('T-ACP 权限请求');
  {
    const P = { FAKE_ACP_PERM_KIND: 'edit' };
    const a = await go('perm-hyphen', { agent: 'qwen', answer: 'allow' }, P);
    eq('连字符写法：转给页面，允许 → allow-once', [a.forwarded, outcomeOf(a), !!a.done], [true, ['allow-once'], true]);
    const d = await go('perm-hyphen', { agent: 'qwen', answer: 'deny' }, P);
    eq('连字符写法：拒绝 → reject-once', outcomeOf(d), ['reject-once']);
    const u1 = await go('perm-unknown', { agent: 'qwen', answer: 'allow' }, P);
    eq('只有未知 kind 的“允许”选项：允许也不会被当成允许（cancelled）', outcomeOf(u1), ['cancelled']);
    const u2 = await go('perm-unknown', { agent: 'qwen', answer: 'deny' }, P);
    eq('未知 kind 的选项旁边的 reject_once 正常可用', outcomeOf(u2), ['reject']);
    const nr = await go('perm-noreject', { agent: 'qwen', answer: 'deny' }, P);
    eq('全是未知 kind：拒绝也是 cancelled，不去猜', outcomeOf(nr), ['cancelled']);

    const ro = await go('perm-hyphen', { agent: 'qwen', readOnly: true }, P);
    eq('只读运行：edit 请求由主进程直接拒绝（用归一化后的 reject 选项），不转给页面', [outcomeOf(ro), ro.forwarded, anyNote(ro, /只读运行/), anyNote(ro, /无法保证只读/)], [['reject-once'], false, true, true]);
    const roRead = await go('', { agent: 'qwen', readOnly: true, answer: 'allow' }, { FAKE_ACP_PERM_KIND: 'read' });
    eq('只读运行：读取类请求仍然转给页面', [roRead.forwarded, outcomeOf(roRead)], [true, ['allow']]);
    for (const kind of ['execute', 'delete', 'move', 'other', 'fetch-ish', '']) {
      const r = await go('', { agent: 'qwen', readOnly: true }, { FAKE_ACP_PERM_KIND: kind || 'x' });
      eq(`只读运行：「${kind || '(未知)'}」种类的请求当作写入，拒绝`, [outcomeOf(r), r.forwarded], [['reject'], false]);
    }
    const mixedCase = await go('', { agent: 'qwen', readOnly: true, answer: 'allow' }, { FAKE_ACP_PERM_KIND: 'READ' });
    eq('种类名大小写不敏感（READ 就是 read）', mixedCase.forwarded, true);
    const chat = await go('', { agent: 'qwen', access: 'chat', readOnly: true }, { FAKE_ACP_PERM_KIND: 'read' });
    eq('闲聊：任何权限请求都拒绝', [outcomeOf(chat), chat.forwarded], [['reject'], false]);
    const noUnknownNote = await go('', { agent: 'qwen', answer: 'allow' }, { FAKE_ACP_PERM_KIND: 'edit' });
    eq('非只读的普通运行：转给页面，允许 → allow', [outcomeOf(noUnknownNote), noUnknownNote.notes], [['allow'], []]);
  }

  /* ═════════════════════════ 阻塞的扩展请求、用量、噪声 ═════════════════════════ */

  section('T-ACP 扩展请求 / usage_update / 取消');
  {
    const b = await go('blocking-ext', { agent: 'qwen' });
    const ans = b.rpc.find((x) => x.response === 9101);
    eq('cursor/ask_question 是阻塞的：回 -32601，代理被放行，回合正常结束', [ans && ans.error && ans.error.code, !!b.done, anyNote(b, /想问一个栖枝暂不支持的问题/)], [-32601, true, true]);
    const e = await go('elicit', { agent: 'qwen' });
    eq('elicitation 同样：回 -32601 并说一句', [(e.rpc.find((x) => x.response === 9102) || {}).error && e.rpc.find((x) => x.response === 9102).error.code, !!e.done, e.notes.filter((t) => /暂不支持的问题/.test(t)).length], [-32601, true, 1]);

    const u = await go('usage', { agent: 'qwen' });
    eq('usage_update → context 事件（窗口用了多少）', [u.evs.filter((x) => x.type === 'context'), u.evs.some((x) => x.type === 'usage')], [[{ type: 'context', used: 1234, limit: 200000 }], false]);

    const noise = await go('stdout-noise', { agent: 'qwen' });
    eq('stdout 上夹杂的非 JSON 行被忽略', [!!noise.done, noise.text], [true, '好的。']);

    // 取消：session/cancel 与 $/cancel_request 都发，代理不理就在 3 秒后杀进程树
    const slow = await go('slow', { agent: 'qwen', after: async (ctl, files) => { await waitFor(() => fs.existsSync(files.prompt)); ctl.interrupt(); } });
    const promptReq = slow.rpc.find((x) => x.method === 'session/prompt');
    eq('取消：两种取消都发，requestId 就是 prompt 的请求号', [slow.methods.includes('session/cancel'), slow.calls('$/cancel_request'), promptReq && promptReq.id], [true, [{ requestId: promptReq && promptReq.id }], promptReq && promptReq.id]);
    ok('取消：代理不理会就杀进程（约 3 秒后），以 interrupted 结束', slow.done && slow.done.stopReason === 'interrupted' && slow.ms >= 2500 && slow.ms < 12000, `${slow.ms} ms ${JSON.stringify(slow.evs.slice(-1))}`);
    ok('取消：进程确实被杀了', await (async () => { const pid = Number(fs.readFileSync(slow.files.pid, 'utf8')); return waitFor(() => !alive(pid), 5000); })());
    const sc = await go('slow-cancel', { agent: 'qwen', after: async (ctl, files) => { await waitFor(() => fs.existsSync(files.prompt)); ctl.interrupt(); } });
    ok('代理配合 session/cancel：很快以 interrupted 结束', sc.done && sc.done.stopReason === 'interrupted' && sc.ms < 2500, `${sc.ms} ms`);
    const cr = await go('cancel-request', { agent: 'qwen', after: async (ctl, files) => { await waitFor(() => fs.existsSync(files.prompt)); ctl.interrupt(); } });
    ok('代理只认 $/cancel_request（以错误结束 prompt）：也算 interrupted，不当失败', cr.done && cr.done.stopReason === 'interrupted' && !cr.error && cr.ms < 2500, `${cr.ms} ms ${JSON.stringify(cr.evs.slice(-1))}`);
    const stopNow = await go('slow', { agent: 'qwen', after: async (ctl, files) => { await waitFor(() => fs.existsSync(files.prompt)); ctl.stop(); } });
    ok('stop()：直接杀进程，interrupted', stopNow.done && stopNow.done.stopReason === 'interrupted' && stopNow.ms < 2500, `${stopNow.ms} ms`);

    const noInit = await go('no-init', { agent: 'qwen', initTimeoutMs: 400 });
    ok('initialize 一直没回应：超时报错，进程被杀', noInit.error && noInit.error.code === 'ACP_ETIMEDOUT' && /initialize/.test(noInit.error.message) && await (async () => { const pid = Number(fs.readFileSync(noInit.files.pid, 'utf8')); return waitFor(() => !alive(pid), 5000); })(), JSON.stringify(noInit.error));
    const early = await go('exit-early', { agent: 'qwen' });
    ok('代理意外退出：报退出码', early.error && early.error.code === 'EXIT_3', JSON.stringify(early.error));
    const nobin = await go('', { agent: 'qwen', exe: path.join(dir, 'no-such-program.exe') });
    ok('程序启动不了：SPAWN 错误', nobin.error && nobin.error.code === 'SPAWN', JSON.stringify(nobin.error));
  }

  /* ═════════════════════════ 只读 fail-closed 与 Kimi 行为不变（check-engine ⑥ 的用例） ═════════════════════════ */

  section('T-ACP Kimi 行为与改造前一致 + 只读 fail-closed');
  {
    const k = (agent, pageMode, over = {}) => {
      const access = over.access ?? 'work';
      return go('', { agent, pageMode, access, readOnly: over.readOnly ?? access === 'chat', answer: over.answer }, {
        FAKE_ACP_MODES: JSON.stringify(over.modes ?? ['default', 'plan', 'auto', 'yolo']), FAKE_ACP_CURRENT: over.current ?? 'default', FAKE_ACP_FAIL_MODES: JSON.stringify(over.failModes ?? []),
        ...(over.permKind ? { FAKE_ACP_PERM_KIND: over.permKind } : {}),
      });
    };
    const k1 = await k('kimi', 'ask', { current: 'yolo' });
    eq('Kimi 逐项：显式设回 default（不继承残留的 yolo）', [k1.modes, !!k1.done], [['default'], true]);
    eq('Kimi 计划：plan', (await k('kimi', 'plan')).modes, ['plan']);
    const k3 = await k('kimi', 'bypass');
    eq('Kimi 放手：yolo，并说手套只记账', [k3.modes, anyNote(k3, /只记账/)], [['yolo'], true]);
    const k4 = await k('kimi', 'auto', { modes: ['default', 'plan'] });
    eq('Kimi 没有 auto：不设，说「已降级」', [k4.modes, anyNote(k4, /已降级/)], [[], true]);
    const k5 = await k('qwen', 'plan');
    eq('Qwen 没验证：不设，说「未验证」', [k5.modes, anyNote(k5, /未验证/)], [[], true]);
    eq('Kimi 已经在 plan 就不重复设', (await k('kimi', 'plan', { current: 'plan' })).modes, []);
    const kc = await k('kimi', undefined, { access: 'chat', current: 'yolo' });
    eq('闲聊（无工具）：会话停在 yolo 时设回 default', [kc.modes, !!kc.done], [['default'], true]);
    eq('闲聊：已经在 default 就不重复设', (await k('kimi', undefined, { access: 'chat' })).modes, []);
    eq('闲聊：没验证过模式的引擎不去碰、也不啰嗦', (await k('qwen', undefined, { access: 'chat' })).notes, []);
    const kr1 = await k('kimi', 'plan', { readOnly: true, current: 'yolo', failModes: ['plan'] });
    eq('只读：plan 设不上 → 退到 default', [kr1.modes, !!kr1.done, kr1.prompted], [['plan', 'default'], true, true]);
    const kr2 = await k('kimi', 'plan', { readOnly: true, current: 'yolo', failModes: ['plan', 'default'] });
    eq('只读：plan 和 default 都设不上 → 不启动（没有发 prompt），以错误结束', [kr2.error && kr2.error.code, kr2.prompted, !!kr2.done], ['ACP_READONLY', false, false]);
    const kr3 = await k('kimi', 'plan', { readOnly: true, current: 'yolo', modes: ['yolo', 'auto'] });
    eq('只读：Kimi 一个只读相关的模式都没提供 → 不启动', [kr3.error && kr3.error.code, kr3.prompted], ['ACP_READONLY', false]);
    ok('只读：不启动的错误说明里点名了需要的模式', /plan \/ default/.test(kr3.error.message), kr3.error.message);
    const kr4 = await k('kimi', 'plan', { readOnly: true, current: 'yolo', modes: ['yolo', 'default'] });
    eq('只读：没有 plan 但有 default → 退到 default 继续', [kr4.modes, !!kr4.done, kr4.prompted], [['default'], true, true]);
    const kq = await k('qwen', 'plan', { readOnly: true });
    eq('只读：Qwen 照常启动，并如实警告无法保证只读', [!!kq.done, anyNote(kq, /无法保证只读/)], [true, true]);
    const kp = await k('kimi', 'plan', { readOnly: true, permKind: 'edit' });
    eq('只读：edit 权限请求被自动拒绝，没有转给页面', [outcomeOf(kp), kp.forwarded, !!kp.done], [['reject'], false, true]);
    const kp2 = await k('qwen', 'plan', { readOnly: true, permKind: 'execute' });
    eq('只读：execute 权限请求被自动拒绝（Qwen 同样）', [outcomeOf(kp2), kp2.forwarded], [['reject'], false]);
    const kp3 = await k('kimi', 'plan', { readOnly: true, permKind: 'other' });
    eq('只读：认不出种类的（MCP 工具）按写入处理，拒绝', [outcomeOf(kp3), kp3.forwarded], [['reject'], false]);

    // 推广：任何“verified + modeMap”的代理（不只是 Kimi）都按同一套规则
    const verifiedDef = { id: 'c-ver', label: '已验证的假代理', bin: ['x'], args: [], auth: { mode: 'none', loginHint: '' }, binding: { mode: 'none' }, install: {}, verified: '2026-10-24', docsUrl: 'https://example.com/', perm: { level: 'verified', modeMap: { ask: 'ask', plan: 'planning', auto: 'autopilot', bypass: 'yolo' } } };
    const vEnv = { FAKE_ACP_MODES: JSON.stringify(['ask', 'planning', 'autopilot', 'yolo']), FAKE_ACP_CURRENT: 'yolo' };
    const v1 = await go('', { agentDef: verifiedDef, pageMode: 'plan', readOnly: true }, vEnv);
    eq('已验证的自定义代理：只读 + 计划 → 它自己的 planning 模式', [v1.modes, !!v1.done], [['planning'], true]);
    const v2 = await go('', { agentDef: verifiedDef, pageMode: 'plan', readOnly: true }, { ...vEnv, FAKE_ACP_FAIL_MODES: JSON.stringify(['planning', 'ask']) });
    eq('已验证的自定义代理：只读模式都设不上 → 不启动', [v2.error && v2.error.code, v2.prompted], ['ACP_READONLY', false]);
    const v3 = await go('', { agentDef: verifiedDef, pageMode: 'plan', readOnly: true }, { ...vEnv, FAKE_ACP_FAIL_MODES: JSON.stringify(['planning']) });
    eq('已验证的自定义代理：退到登记的 ask 模式继续', [v3.modes, !!v3.done], [['planning', 'ask'], true]);
    const unverifiedDef = { ...verifiedDef, perm: { level: 'unverified' } };
    const v4 = await go('', { agentDef: unverifiedDef, pageMode: 'bypass', readOnly: false }, vEnv);
    eq('没验证过的自定义代理：不设任何模式，说「未验证」', [v4.modes, anyNote(v4, /未验证/)], [[], true]);
    const v5 = await go('', { agentDef: unverifiedDef, readOnly: true }, { ...vEnv, FAKE_ACP_PERM_KIND: 'edit' });
    eq('没验证过的自定义代理 + 只读：写入请求被拒，并警告', [outcomeOf(v5), anyNote(v5, /无法保证只读/)], [['reject'], true]);
  }

  /* ═════════════════════════ 代理登记（acp-agents.cjs） ═════════════════════════ */

  section('T-ACP 代理定义与伪服务');
  const regDir = mk('acp-user');
  const probeEnvObj = {};
  let clock = 1_700_000_000_000;
  const npxWrapper = path.join(dir, 'npx.cmd');
  const fakeCmd = (name) => { const f = path.join(dir, name); fs.writeFileSync(f, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`); return f; };
  if (isWin) fs.writeFileSync(npxWrapper, `@echo off\r\n"${process.execPath}" "${FAKE}" %*\r\n`);
  const found = new Map();                       // 注入的“PATH”
  const reg = servicesMod.createRegistry({ userDir: regDir, secrets });
  secrets.configure(reg.secretsConfig());
  const ag = agentsMod.createAcpAgents({
    registry: reg, userData: regDir, now: () => clock, secrets, probeEnv: probeEnvObj, resolveCommand: (n) => found.get(n) || null,
    managedRoots: () => [path.join(dir, 'airoom')], dshRoots: () => [path.join(dir, 'dsh-home')], timeouts: { probe: 6000, deep: 8000 },
    registryUrl: 'http://127.0.0.1:1/never',   // replaced below
  });
  {
    eq('目录里的代理：19 个（隐藏的 dsh-acp 不在默认列表里）', [ag.list({ hidden: true }).length, ag.list().length, ag.list().some((a) => a.id === 'dsh-acp')], [19, 18, false]);
    ok('页面看到的定义里没有可执行文件路径', ag.list({ hidden: true }).every((a) => !('exe' in a)) && ag.list().every((a) => a.source === 'preset'));
    const ps = ag.pseudoServices();
    eq('伪服务：只有独立代理（没有 vendor 的 11 个），进「命令行」分组', [ps.length, ps.every((s) => s.group === 'cli' && s.kind === 'agent' && s.protocol === 'none' && /^acp_[a-z][a-z0-9-]+$/.test(s.id) && s.id.length <= 32)], [11, true]);
    eq('伪服务：每个只有一个驱动 acp:<id>，没有 API 地址，没有模型', [ps.every((s) => s.drivers.length === 1 && s.drivers[0] === `acp:${s.id.slice(4)}` && s.endpoints.length === 1 && !s.endpoints[0].baseUrl && s.models.length === 0), ps.map((s) => s.id).sort().slice(0, 4)], [true, ['acp_auggie', 'acp_cline', 'acp_codebuddy', 'acp_cursor']]);
    ok('伪服务：绑定了服务的代理（kimi / gemini…）不是伪服务', !ps.some((s) => ['acp_kimi', 'acp_gemini', 'acp_qwen', 'acp_mcode', 'acp_dsh-acp'].includes(s.id)));
    ok('伪服务：徽记 1–2 个字符且互不相同', ps.every((s) => [...s.glyph].length >= 1 && [...s.glyph].length <= 2) && new Set(ps.map((s) => s.glyph)).size === ps.length, ps.map((s) => s.glyph).join(' '));
    eq('徽记规则', [agentsMod.glyphOf('Gemini CLI'), agentsMod.glyphOf('OpenCode'), agentsMod.glyphOf('遐蝶助手'), agentsMod.glyphOf('  '), agentsMod.glyphOf('x')], ['Ge', 'Op', '遐', '?', 'X']);
    ok('pseudoServiceById 认 acp_ 前缀的独立代理，其余不认', !!ag.pseudoServiceById('acp_opencode') && !ag.pseudoServiceById('acp_kimi') && !ag.pseudoServiceById('opencode') && !ag.pseudoServiceById('acp_nope') && !ag.pseudoServiceById(7));
    ok('伪服务 id 符合 secrets 的槽位格式（自定义命令有密钥变量时要用）', ps.every((s) => secrets.SLOT_RE.test(s.id)));
    eq('driverDef：旧驱动名保留旧的显示名，新代理用目录里的', [ag.driverDef('kimi').label, ag.driverDef('qwen').label, ag.driverDef('mcode').label, ag.driverDef('gemini').label, ag.driverDef('gemini').acpArgs, ag.driverDef('nope')], ['Kimi Code', 'Qwen Code', 'MiniMax Code', 'Gemini CLI', ['--acp'], null]);
    eq('driverDef：登录命令', [ag.driverDef('kimi').login, ag.driverDef('gemini').login], [['login'], null]);
  }

  section('T-ACP 找到程序');
  {
    const none = ag.launch('opencode');
    ok('PATH 里没有：说明，不崩', !none.ok && none.code === 'ENOENT' && /opencode/.test(none.error), JSON.stringify(none));
    found.set('opencode', 'C:/fake/opencode.cmd');
    eq('PATH 上找到：程序与固定参数', (({ ok: o, exe, args }) => ({ o, exe, args }))(ag.launch('opencode')), { o: true, exe: 'C:/fake/opencode.cmd', args: ['acp'] });
    found.set('cursor-agent', 'C:/fake/cursor-agent.cmd');
    eq('多个候选命令名：按顺序找（agent 没有就用 cursor-agent）', ag.launch('cursor').exe, 'C:/fake/cursor-agent.cmd');
    const own = fakeCmd('my-opencode.cmd');
    eq('命令路径设置：真实存在的 .cmd 优先', ag.launch('opencode', { customPath: own }).exe, own);
    ok('命令路径设置：不存在 / 扩展名不对 → 拒绝（不退回 PATH）', !ag.launch('opencode', { customPath: path.join(dir, 'nope.cmd') }).ok && !ag.launch('opencode', { customPath: FAKE }).ok);
    // AIROOM 管理的副本
    const bin = path.join(dir, 'airoom', 'members', 'goose', '1.0.2', 'node_modules', '.bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.mkdirSync(path.join(dir, 'airoom', 'members', 'goose', '1.0.10', 'node_modules', '.bin'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'goose.cmd'), '@echo off\r\n');
    fs.writeFileSync(path.join(dir, 'airoom', 'members', 'goose', '1.0.10', 'node_modules', '.bin', 'goose.cmd'), '@echo off\r\n');
    ok('PATH 上没有时找 AIROOM 管理的副本，版本号按数字排序取最新（1.0.10 > 1.0.2）', /1\.0\.10/.test(String(ag.exeFor('goose'))), String(ag.exeFor('goose')));
    const dshHome = path.join(dir, 'dsh-home', 'resources', 'runtime', 'cli', 'bin');
    fs.mkdirSync(dshHome, { recursive: true });
    fs.writeFileSync(path.join(dshHome, 'dsh.cmd'), '@echo off\r\n');
    ok('dsh-acp：找得到 DeepSeek Harness 自带的命令行；别的代理不去那里找', ag.exeFor('dsh-acp') === path.join(dshHome, 'dsh.cmd') && ag.exeFor('cline') === null);
    eq('未知的代理', [ag.launch('nope').code, ag.launch(7).ok, ag.exeFor('nope')], ['AGENT', false, null]);
  }

  /* ───────────── 自定义命令 ───────────── */

  section('T-ACP 自定义命令');
  const yes = async () => true;
  const no = async () => false;
  let custom;
  {
    const exe = fakeCmd('my-agent.cmd');
    const asked = [];
    const pick = await ag.pickExe({}, async () => exe);
    ok('选择文件：页面只拿到一次性令牌和文件名，没有路径', pick.ok && /^[0-9a-f]{32}$/.test(pick.value.token) && pick.value.name === 'my-agent.cmd' && !JSON.stringify(pick).includes(dir.replace(/\\/g, '\\\\')) && Object.keys(pick.value).sort().join() === 'name,token', JSON.stringify(pick));
    ok('选择文件：取消 / 扩展名不对 / 文件不存在 / 相对路径都不发令牌', !(await ag.pickExe({}, async () => null)).ok && !(await ag.pickExe({}, async () => path.join(dir, 'x.txt'))).ok && !(await ag.pickExe({}, async () => path.join(dir, 'gone.cmd'))).ok && !(await ag.pickExe({}, async () => 'my-agent.cmd')).ok && !(await ag.pickExe({}, undefined)).ok);
    const txt = path.join(dir, 'notes.txt');
    fs.writeFileSync(txt, 'x');
    eq('选择文件：.txt 被拒，原因说清楚', (await ag.pickExe({}, async () => txt)).error, '只能登记 .exe / .cmd / .bat');

    const base = { label: '我的代理', args: ['--acp'], envNames: [] };
    const bad = async (patch, why) => { const r = await ag.addCustom({ token: pick.value.token, ...base, ...patch }, async (o) => { asked.push(o); return true; }); ok(`自定义命令：${why}`, !r.ok, JSON.stringify(r)); return r; };
    await bad({ label: '' }, '名称不能为空');
    await bad({ label: 'x'.repeat(61) }, '名称不超过 60 个字符');
    await bad({ args: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] }, '参数不超过 8 个');
    for (const arg of ['a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a"b', '%PATH%', 'a b', '$(x)', 'a;b', '`x`', 'x'.repeat(61), '', '..\\x']) await bad({ args: [arg] }, `参数「${arg.slice(0, 12)}」被拒`);
    await bad({ args: [5] }, '参数必须是字符串');
    await bad({ envNames: ['PATH'] }, '环境变量名 PATH 在禁用表里');
    await bad({ envNames: ['NODE_OPTIONS'] }, '环境变量名 NODE_OPTIONS 在禁用表里');
    await bad({ envNames: ['lower'] }, '环境变量名格式不对');
    await bad({ envNames: ['MY_KEY', 'OTHER_KEY'] }, '最多一个密钥变量');
    ok('这些失败都没有弹确认框，也没有写入', asked.length === 0 && ag.list().every((a) => a.source === 'preset'));
    const declined = await ag.addCustom({ token: pick.value.token, ...base }, no);
    ok('用户在原生弹窗里拒绝：不登记，令牌仍可再用', !declined.ok && ag.list().every((a) => a.source === 'preset') && ag._tokens.has(pick.value.token));
    const forged = await ag.addCustom({ token: 'f'.repeat(32), ...base, path: exe, exe }, yes);
    ok('伪造的令牌被拒（页面传来的路径 / exe 字段被忽略）', !forged.ok && ag.list().every((a) => a.source === 'preset'), JSON.stringify(forged));
    const good = await ag.addCustom({ token: pick.value.token, ...base, path: 'C:/Windows/System32/cmd.exe', exe: 'C:/Windows/System32/cmd.exe' }, async (o) => { asked.push(o); return true; });
    ok('登记成功；确认框里写着完整路径与“代你运行”', good.ok && /^c-[a-z0-9-]+$/.test(good.value.id) && asked.length === 1 && asked[0].message.includes(exe) && /代你运行这个程序/.test(asked[0].detail), JSON.stringify(good));
    custom = good.value.id;
    const again = await ag.addCustom({ token: pick.value.token, ...base }, yes);
    ok('令牌一次性：再用一次被拒', !again.ok && /过期/.test(again.error), JSON.stringify(again));
    const stored = JSON.parse(fs.readFileSync(path.join(regDir, 'services.json'), 'utf8'));
    const rec = stored.agents.find((a) => a.id === custom);
    ok('services.json 里存着可执行文件的绝对路径（只存在这里）', rec && rec.exe === exe && rec.source === 'custom' && rec.perm.level === 'unverified', JSON.stringify(rec));
    const pathJson = JSON.stringify(exe).slice(1, -1);
    ok('页面能看到的两处（ag.list 与 svc:list 的快照）都没有路径，只有文件名', !JSON.stringify(ag.list({ hidden: true })).includes(pathJson) && !JSON.stringify(reg.snapshot()).includes(pathJson) && !('exe' in ag.get(custom)) && JSON.stringify(reg.snapshot().agents).includes('my-agent.cmd'), JSON.stringify(reg.snapshot().agents));
    const l = ag.launch(custom);
    eq('启动：用登记的程序和固定参数（命令路径设置被忽略）', [l.ok && l.exe, l.args, ag.launch(custom, { customPath: 'C:/evil.cmd' }).exe], [exe, ['--acp'], exe]);
    eq('驱动与伪服务', [ag.driverDef(custom).acpArgs, ag.pseudoServiceById(`acp_${custom}`).vendor, ag.pseudoServiceById(`acp_${custom}`).auth], [['--acp'], '自定义命令', { scheme: 'none' }]);
    // 重新加载（重启应用）
    reg.reload();
    ok('重新读取 services.json 后仍在', !!ag.get(custom) && ag.launch(custom).ok);
    fs.renameSync(exe, `${exe}.moved`);
    const gone = ag.launch(custom);
    ok('登记的文件被删了：启动前就说清楚，不崩', !gone.ok && gone.code === 'ENOENT' && /找不到你登记的程序/.test(gone.error), JSON.stringify(gone));
    fs.renameSync(`${exe}.moved`, exe);

    // 带一个密钥变量的自定义命令
    const exe2 = fakeCmd('keyed-agent.cmd');
    const pick2 = await ag.pickExe({}, async () => exe2);
    const withKey = await ag.addCustom({ token: pick2.value.token, label: '带密钥的代理', args: [], envNames: ['MY_AGENT_KEY'] }, yes);
    const keyed = ag.get(withKey.value.id);
    eq('有密钥变量：只声明名字，值在卡片里保存的密钥（伪服务的槽）里', [keyed.binding, keyed.auth.mode, ag.pseudoServiceById(`acp_${withKey.value.id}`).auth], [{ mode: 'env', keyEnv: 'MY_AGENT_KEY', env: {}, optional: true }, 'env-key', { scheme: 'bearer', keyOptional: true }]);
    const env1 = ag.resolveEnv({ driver: `acp:${withKey.value.id}`, provider: `acp_${withKey.value.id}` });
    eq('resolveEnv：自定义命令的密钥变量与槽', [env1.ok, env1.keyEnv, env1.slot, env1.env, env1.keyOptional], [true, 'MY_AGENT_KEY', `acp_${withKey.value.id}`, {}, true]);
    ok('resolveEnv：页面传来的 env / keyEnv 不读；provider 对不上被拒', (() => { const r = ag.resolveEnv({ driver: `acp:${withKey.value.id}`, provider: `acp_${withKey.value.id}`, env: { PATH: 'C:/evil' }, keyEnv: 'ANTHROPIC_API_KEY' }); return r.ok && r.keyEnv === 'MY_AGENT_KEY' && !('PATH' in r.env); })() && !ag.resolveEnv({ driver: `acp:${withKey.value.id}`, provider: 'claude' }).ok);
    eq('resolveEnv：预设代理交给服务注册表（Kimi 不需要环境）', [ag.resolveEnv({ driver: 'kimi', provider: 'kimi' }).ok, ag.resolveEnv({ driver: 'kimi', provider: 'kimi' }).env, ag.resolveEnv({ driver: 'acp:nope', provider: 'kimi' }).ok], [true, {}, false]);
    // 过期的令牌
    const exe3 = fakeCmd('late-agent.cmd');
    const pick3 = await ag.pickExe({}, async () => exe3);
    clock += 11 * 60_000;
    const late = await ag.addCustom({ token: pick3.value.token, label: '迟到', args: [], envNames: [] }, yes);
    ok('令牌 10 分钟后过期', !late.ok && /过期/.test(late.error) && !ag._tokens.has(pick3.value.token), JSON.stringify(late));
    // 选了文件之后文件没了
    const exe4 = fakeCmd('vanish-agent.cmd');
    const pick4 = await ag.pickExe({}, async () => exe4);
    fs.unlinkSync(exe4);
    const vanished = await ag.addCustom({ token: pick4.value.token, label: '消失', args: [], envNames: [] }, yes);
    ok('选了之后文件没了：重新核对，拒绝', !vanished.ok && /文件不存在/.test(vanished.error), JSON.stringify(vanished));
    // 手工改坏的 services.json 条目被忽略
    const u = reg._state();
    u.agents.push({ id: 'c-evil', source: 'custom', label: 'x', exe: 'relative.exe', bin: ['x'], args: [], auth: { mode: 'none', loginHint: '' }, binding: { mode: 'none' }, install: {}, perm: { level: 'unverified' }, verified: '2026-10-24', docsUrl: 'https://example.com/' });
    u.agents.push({ id: 'c-evil2', source: 'custom', label: 'x', exe: 'C:/x/evil.txt', bin: ['x'], args: [], auth: { mode: 'none', loginHint: '' }, binding: { mode: 'none' }, install: {}, perm: { level: 'unverified' }, verified: '2026-10-24', docsUrl: 'https://example.com/' });
    u.agents.push({ id: 'r-evil3', source: 'registry', registry: { id: 'x', version: '1', dist: 'npx', spec: '@x/y@latest', confirmed: '@x/y@latest' }, label: 'x', bin: ['npx'], args: [], auth: { mode: 'none', loginHint: '' }, binding: { mode: 'none' }, install: {}, perm: { level: 'unverified' }, verified: '2026-10-24', docsUrl: 'https://example.com/' });
    u.agents.push({ id: 'kimi', source: 'custom', label: '冒充 Kimi', exe: 'C:/x/kimi.exe', bin: ['x'], args: [], auth: { mode: 'none', loginHint: '' }, binding: { mode: 'none' }, install: {}, perm: { level: 'verified', modeMap: { ask: 'default' } }, verified: '2026-10-24', docsUrl: 'https://example.com/' });
    u.agents.push({ id: 'c-wrongprefix', source: 'registry', label: 'x' }, 'not an object', null);
    ok('手工改坏的条目被忽略（相对路径、.txt、没固定版本、冒充预设 id、前缀不对）；预设 Kimi 仍是原来的', ag.get('c-evil') === undefined && ag.get('c-evil2') === undefined && ag.get('r-evil3') === undefined && ag.get('c-wrongprefix') === undefined && ag.get('kimi').source === 'preset' && ag.get('kimi').label === 'Kimi Code CLI' && ag.entries().filter((e) => e.def.id === 'kimi').length === 1);
    reg.reload();   // back to what is really on disk
  }

  /* ───────────── 探测 ───────────── */

  section('T-ACP acp:probe（只做 initialize）');
  if (!isWin) console.log('  skip 探测要用 .cmd 包装器启动假代理，只在 Windows 上跑');
  else {
    const rpc = path.join(dir, 'probe-rpc.log');
    const envDump = path.join(dir, 'probe-env.json');
    const pid = path.join(dir, 'probe-pid.txt');
    const set = (o) => { for (const k of Object.keys(probeEnvObj)) delete probeEnvObj[k]; Object.assign(probeEnvObj, { FAKE_ACP_RPC_LOG: rpc, FAKE_ACP_PID_FILE: pid }, o); try { fs.unlinkSync(rpc); } catch { /* none */ } };
    set({ FAKE_ACP_MODE: 'resume-and-load,config-options', FAKE_ACP_INFO: JSON.stringify({ name: 'fake', version: '3.1.4' }) });
    const p1 = await ag.probe({ agent: custom, fresh: true });
    eq('只发 initialize：不新建会话，不调模型', readLines(rpc).filter((x) => x.method).map((x) => x.method), ['initialize']);
    eq('能力表', [p1.ok, p1.agentInfo, p1.protocolVersion, p1.caps, p1.authMethods, p1.deep], [true, { name: 'fake', version: '3.1.4' }, 1, { loadSession: true, resume: true, list: true, close: true, configOptions: false, mcpHttp: true, image: true }, [], false]);
    ok('没有开会话时，configOptions 一栏是“未知”（false），不带摘要', !p1.summary && p1.caps.configOptions === false);
    const p1b = await ag.probe({ agent: custom });
    ok('1 小时内的第二次直接用缓存，没有再启动进程', p1b.cached === true && readLines(rpc).filter((x) => x.method === 'initialize').length === 1);
    const p1c = await ag.probe({ agent: custom, fresh: true });
    ok('fresh：重新探测', !p1c.cached && readLines(rpc).filter((x) => x.method === 'initialize').length === 2);
    clock += 61 * 60_000;
    const p1d = await ag.probe({ agent: custom });
    ok('缓存 1 小时后过期', !p1d.cached && readLines(rpc).filter((x) => x.method === 'initialize').length === 3);
    ok('cacheOnly：没探测过的代理 → 不启动任何进程，如实说', (await ag.probe({ agent: 'opencode', cacheOnly: true })).notProbed === true);

    const deep = await ag.probe({ agent: custom, deep: true, fresh: true });
    eq('读取模型与模式（deep）：多发一次 session/new，读 configOptions', [readLines(rpc).filter((x) => x.method).map((x) => x.method).slice(-2), deep.caps.configOptions, !!deep.summary], [['initialize', 'session/new'], true, true]);
    eq('deep 的摘要：模型 / 强度（认得的映射到量表）/ 模式', [deep.summary.models.map((m) => m.id), deep.summary.currentModel, deep.summary.efforts.map((e) => `${e.id}:${e.level}`), deep.summary.modes.map((m) => m.id), deep.summary.currentMode], [['m-fast', 'm-pro', 'm-old'], 'm-fast', ['low:low', 'medium:medium', 'high:high', 'turbo:null'], ['default', 'plan', 'auto', 'yolo'], 'default']);
    const newCall = readLines(rpc).find((x) => x.method === 'session/new');
    ok('deep 的会话：在 _acp-probe 临时目录里，没有 MCP 服务', /_acp-probe$/.test(newCall.params.cwd) && newCall.params.mcpServers.length === 0, JSON.stringify(newCall.params));
    const live = ag.liveModels(custom);
    eq('liveModels：同 Codex 的 LiveModel 形状，强度来自 thought_level', [live.map((m) => m.id), live[0].efforts, live[0].defaultEffort, live.map((m) => m.isDefault)], [['m-fast', 'm-pro', 'm-old'], ['low', 'medium', 'high'], 'medium', [true, false, false]]);
    ok('deep 结果也能回答浅探测的缓存询问', (await ag.probe({ agent: custom, cacheOnly: true })).ok === true);
    ok('没有 deep 探测过的代理没有模型列表（liveModels 不会自己启动进程）', ag.liveModels('opencode') === null);

    set({ FAKE_ACP_MODE: 'auth-required' });
    const auth = await ag.probe({ agent: custom, deep: true, fresh: true });
    eq('需要登录：initialize 的结果照给，deep 说清楚要先登录；认证方式只留 id 和类型', [auth.ok, auth.needsLogin, /先登录/.test(auth.error), auth.authMethods.map((m) => `${m.id}:${m.type}`)], [true, true, true, ['agent-login:agent']]);
    ok('探测从不调用 authenticate', !readLines(rpc).some((x) => x.method === 'authenticate'));

    // 环境：只给最小集，不把这个应用的环境交给第三方程序
    const saved = { A: process.env.ANTHROPIC_API_KEY, O: process.env.OPENAI_API_KEY, G: process.env.GEMINI_API_KEY };
    process.env.ANTHROPIC_API_KEY = 'sk-must-not-leak'; process.env.OPENAI_API_KEY = 'sk-must-not-leak-2'; process.env.GEMINI_API_KEY = 'sk-must-not-leak-3';
    set({ FAKE_ACP_ENV_DUMP: envDump, FAKE_ACP_ENV_KEYS: '*' });
    await ag.probe({ agent: custom, fresh: true });
    for (const [k, v] of Object.entries({ ANTHROPIC_API_KEY: saved.A, OPENAI_API_KEY: saved.O, GEMINI_API_KEY: saved.G })) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    const dump = JSON.parse(fs.readFileSync(envDump, 'utf8'));
    const names = dump.names.map((n) => n.toLowerCase());
    ok('探测进程的环境是最小集：没有 API 密钥类变量', !names.includes('anthropic_api_key') && !names.includes('openai_api_key') && !names.includes('gemini_api_key'), names.join(','));
    ok('探测进程的环境：PATH / SystemRoot 在（程序要能启动），工作目录是 _acp-probe', names.includes('path') && names.includes('systemroot') && /_acp-probe$/.test(dump.cwd), `${names.length} 个变量 cwd=${dump.cwd}`);

    // 超时：没有回应的进程被杀
    set({ FAKE_ACP_MODE: 'no-init' });
    const agFast = agentsMod.createAcpAgents({ registry: reg, userData: regDir, now: () => clock, secrets, probeEnv: probeEnvObj, timeouts: { probe: 600, deep: 600 } });
    const hung = await agFast.probe({ agent: custom, fresh: true });
    ok('超时：说明，不缓存', hung.ok === false && hung.timedOut === true && /没有回应/.test(hung.error) && (await agFast.probe({ agent: custom, cacheOnly: true })).notProbed === true, JSON.stringify(hung));
    ok('超时：进程被杀', await waitFor(() => { try { return !alive(Number(fs.readFileSync(pid, 'utf8'))); } catch { return false; } }, 5000));
    set({ FAKE_ACP_MODE: 'exit-early' });
    const crashed = await ag.probe({ agent: custom, fresh: true });
    ok('进程自己退出了：报退出码', crashed.ok === false && /意外退出（3）/.test(crashed.error), JSON.stringify(crashed));
    found.delete('opencode');
    const missing = await ag.probe({ agent: 'junie', fresh: true });
    ok('命令没装：notFound，不崩', missing.ok === false && missing.notFound === true && /junie/.test(missing.error), JSON.stringify(missing));
    ok('未知的代理 / 非字符串', (await ag.probe({ agent: 'nope' })).ok === false && (await ag.probe({ agent: 5 })).ok === false && (await ag.probe()).ok === false);
  }

  /* ───────────── 官方注册表 ───────────── */

  section('T-ACP 官方注册表（回环上的假注册表）');
  {
    const sha = 'a'.repeat(64);
    const body = {
      version: '1.0.0',
      agents: [
        { id: 'fake-npx', name: 'Fake Npx', version: '1.2.3', description: 'npx 代理\u0001带控制字符', license: 'MIT', repository: 'https://example.com/r', distribution: { npx: { package: '@fake/agent@1.2.3', args: ['--acp'] } } },
        { id: 'fake-latest', name: 'Fake Latest', version: '2.0.0', distribution: { npx: { package: '@fake/latest@latest' } } },
        { id: 'fake-uvx', name: 'Fake Uvx', version: '0.5.0', distribution: { uvx: { package: 'fake-uvx==0.5.0', args: ['serve'] } } },
        { id: 'fake-bin', name: 'Fake Binary', version: '3.0.0', distribution: { binary: { 'windows-x86_64': { archive: 'https://example.com/a.zip', cmd: 'a.exe', sha256: sha }, 'linux-x86_64': { archive: 'https://example.com/b.tgz', cmd: './b' } } } },
        { id: 'fake-bin2', name: 'Fake Binary No Sum', version: '3.1.0', distribution: { binary: { 'windows-x86_64': { archive: 'https://example.com/c.zip', cmd: 'c.exe' } } } },
        { id: 'gemini', name: 'Gemini CLI', version: '9.9.9', distribution: { npx: { package: '@google/gemini-cli@9.9.9', args: ['--acp'] } } },
        { id: 'bad id!', name: 'x', version: '1.0.0', distribution: { npx: { package: 'x@1.0.0' } } },
        { id: 'fake-badargs', name: 'Bad Args', version: '1.0.0', distribution: { npx: { package: '@fake/ba@1.0.0', args: ['--x=a b'] } } },
        { id: 'fake-nover', name: 'No Version Pkg', version: '4.5.6', distribution: { npx: { package: '@fake/nover' } } },
        { id: 'fake-empty', name: 'Nothing', version: '1.0.0', distribution: {} },
        'garbage', null, { name: 'no id' },
      ],
    };
    const state = { mode: 'ok', hits: 0, body };
    const server = http.createServer((rq, rs) => {
      state.hits += 1;
      if (state.mode === '500') { rs.writeHead(500); rs.end('boom'); return; }
      if (state.mode === 'html') { rs.writeHead(200, { 'content-type': 'text/html' }); rs.end('<html>not a registry</html>'); return; }
      if (state.mode === 'big') { rs.writeHead(200, { 'content-type': 'application/json' }); rs.end(`{"agents":[],"pad":"${'x'.repeat(1_200_000)}"}`); return; }
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(JSON.stringify(state.body));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}/registry.json`;
    const rdir = mk('acp-registry-user');
    const rreg = servicesMod.createRegistry({ userDir: rdir, secrets });
    secrets.configure(rreg.secretsConfig());
    const rag = agentsMod.createAcpAgents({ registry: rreg, userData: rdir, now: () => clock, secrets, registryUrl: url, resolveCommand: (n) => (n === 'npx' && isWin ? npxWrapper : n === 'uvx' ? 'C:/fake/uvx.exe' : null), probeEnv: probeEnvObj, timeouts: { probe: 6000, deep: 8000 } });
    try {
      ok('官方注册表的固定地址是 https 的 cdn.agentclientprotocol.com', /^https:\/\/cdn\.agentclientprotocol\.com\/registry\/v1\/latest\/registry\.json$/.test(agentsMod.REGISTRY_URL) && !!net.checkBaseUrl(agentsMod.REGISTRY_URL.replace(/\/registry\.json$/, '')));
      const pure = agentsMod.parseRegistry(body);
      eq('解析：能识别的条目留下，垃圾丢弃（坏 id、没有分发方式、非对象）', [pure.entries.map((e) => e.id), pure.skipped], [['fake-npx', 'fake-latest', 'fake-uvx', 'fake-bin', 'fake-bin2', 'gemini', 'fake-badargs', 'fake-nover'], 5]);
      const byId = Object.fromEntries(pure.entries.map((e) => [e.id, e]));
      eq('解析：npx 固定版本可添加，命令行原样写出', [byId['fake-npx'].addable, byId['fake-npx'].command, byId['fake-npx'].spec], [true, 'npx --yes @fake/agent@1.2.3 --acp', '@fake/agent@1.2.3']);
      ok('解析：描述里的控制字符被清掉', !/[\u0000-\u001f]/.test(byId['fake-npx'].description) && byId['fake-npx'].description.includes('带控制字符'));
      ok('解析：@latest 不固定版本，列出但不能添加，说明原因', byId['fake-latest'].addable === false && /没有固定到一个版本/.test(byId['fake-latest'].reason) && byId['fake-latest'].command === '');
      eq('解析：包名没写版本、条目有版本 → 用条目的版本固定', [byId['fake-nover'].addable, byId['fake-nover'].spec], [true, '@fake/nover@4.5.6']);
      eq('解析：uvx 用 ==', [byId['fake-uvx'].addable, byId['fake-uvx'].command], [true, 'uvx fake-uvx==0.5.0 serve']);
      ok('解析：参数里有空格 → 不能添加', byId['fake-badargs'].addable === false && /不是普通的词/.test(byId['fake-badargs'].reason));
      eq('解析：二进制只给 Windows 的下载地址与有没有校验值', [byId['fake-bin'].dist, byId['fake-bin'].addable, byId['fake-bin'].downloads.length, byId['fake-bin'].hasSha256, byId['fake-bin2'].hasSha256], ['binary', false, 1, true, false]);
      eq('npx / uvx 规格：浮动的写法都不通过', ['@a/b@1.2.3', 'b@1.0.0-rc.1', 'b@latest', 'b@^1.2.3', 'b@1', 'b', '@a/b', 'b@1.2.3 --evil', 'b@1.2.3;x'].map((s) => agentsMod.NPX_SPEC.test(s)), [true, true, false, false, false, false, false, false, false]);

      const l1 = await rag.registryList({});
      ok('浏览：解析、标出已有同名预设，写缓存', l1.ok && l1.value.length === 8 && l1.value.find((e) => e.id === 'gemini').preset === 'gemini' && fs.existsSync(rag.registryCacheFile()) && state.hits === 1, JSON.stringify(l1).slice(0, 200));
      await rag.registryList({});
      eq('24 小时内再浏览：用缓存，不再请求', state.hits, 1);
      state.mode = '500';
      const forced = await rag.registryList({ fresh: true });
      ok('刷新失败：显示上次的结果，标 stale 并说原因', forced.ok && forced.stale === true && /HTTP 500/.test(forced.error) && forced.value.length === 8, JSON.stringify(forced).slice(0, 200));
      state.mode = 'html';
      ok('内容不是注册表：同样退回缓存', (await rag.registryList({ fresh: true })).stale === true);
      state.mode = 'big';
      const big = await rag.registryList({ fresh: true });
      ok('超过 1 MB：放弃，退回缓存', big.stale === true && /太大|HTTP|不是注册表/.test(big.error), JSON.stringify(big).slice(0, 200));
      state.mode = 'ok'; state.hits = 0;
      clock += 25 * 3600_000;
      const expired = await rag.registryList({});
      ok('超过 24 小时：重新请求', expired.ok && !expired.stale && state.hits === 1);
      // 缓存损坏
      fs.writeFileSync(rag.registryCacheFile(), '{ not json');
      state.mode = '500';
      const noCache = await rag.registryList({});
      ok('缓存文件损坏且网络也失败：报错，损坏文件改名留底', !noCache.ok && !fs.existsSync(rag.registryCacheFile()) && fs.readdirSync(rdir).some((f) => f.startsWith('acp-registry.json.corrupt-')), JSON.stringify(noCache));
      state.mode = 'ok';
      await rag.registryList({ fresh: true });

      // 添加
      const asked = [];
      const confirm = async (o) => { asked.push(o); return true; };
      ok('添加：没有这个条目 / 已有同名预设 / 二进制 / 没固定版本 / 参数不合规，都拒绝且不弹确认', (await Promise.all([
        rag.addFromRegistry({ id: 'nope' }, confirm), rag.addFromRegistry({ id: 'gemini' }, confirm), rag.addFromRegistry({ id: 'fake-bin' }, confirm), rag.addFromRegistry({ id: 'fake-latest' }, confirm), rag.addFromRegistry({ id: 'fake-badargs' }, confirm),
        rag.addFromRegistry({ id: '' }, confirm), rag.addFromRegistry(null, confirm), rag.addFromRegistry({ id: 'fake-npx' }, undefined),
      ])).every((r) => !r.ok) && asked.length === 0);
      const gem = await rag.addFromRegistry({ id: 'gemini' }, confirm);
      ok('同名预设的提示是人话', /已经有这个代理的预设/.test(gem.error));
      const declined = await rag.addFromRegistry({ id: 'fake-npx' }, async (o) => { asked.push(o); return false; });
      ok('用户拒绝：不写入', !declined.ok && rag.list().every((a) => a.source === 'preset'));
      const asks = asked[asked.length - 1];
      ok('确认框写明：包 @ 版本、完整命令行、从 npm 下载并执行第三方程序、没有校验值、版本固定', /Fake Npx/.test(asks.message) && asks.message.includes('npx --yes @fake/agent@1.2.3 --acp') && /第三方程序/.test(asks.detail) && /无法校验/.test(asks.detail) && /版本固定为 1\.2\.3/.test(asks.detail) && /添加本身不会运行它/.test(asks.detail), JSON.stringify(asks));
      const added = await rag.addFromRegistry({ id: 'fake-npx' }, confirm);
      ok('确认后写入；返回的是将要运行的命令', added.ok && /^r-[a-z0-9-]+$/.test(added.value.id) && added.value.install === 'npx --yes @fake/agent@1.2.3 --acp', JSON.stringify(added));
      const rid = added.value.id;
      const rec = JSON.parse(fs.readFileSync(path.join(rdir, 'services.json'), 'utf8')).agents.find((a) => a.id === rid);
      eq('services.json：固定版本与你确认过的规格', [rec.registry, rec.source, rec.bin, rec.args, rec.perm.level], [{ id: 'fake-npx', version: '1.2.3', dist: 'npx', spec: '@fake/agent@1.2.3', confirmed: '@fake/agent@1.2.3' }, 'registry', ['npx'], ['--acp'], 'unverified']);
      const lau = rag.launch(rid);
      eq('启动：npx --yes <固定规格> <参数>', [lau.ok, lau.exe === npxWrapper || !isWin, lau.args], [true, true, ['--yes', '@fake/agent@1.2.3', '--acp']]);
      eq('页面能看到的 registry：id / 版本 / 方式 / 命令，没有 spec 之外的内部字段', ((x) => ({ ...x, command: undefined }))(rag.list().find((a) => a.id === rid).registry), { id: 'fake-npx', version: '1.2.3', dist: 'npx', command: undefined });
      eq('驱动参数', rag.driverDef(rid).acpArgs, ['--yes', '@fake/agent@1.2.3', '--acp']);
      // npx 在哪个目录里启动，就读哪个目录的 .npmrc（registry=…）：进程要在应用自己的空目录里启动，任务目录只作为会话的 cwd 交给代理
      const spawnAt = rag.spawnCwdFor(rid);
      ok('注册表代理（npx / uvx）：进程的启动目录是应用自己的空目录 _acp-run；预设、自定义、不存在的代理没有这个设定', /[\\/]workspaces[\\/]_acp-run$/.test(spawnAt) && fs.existsSync(spawnAt) && fs.readdirSync(spawnAt).length === 0 && rag.spawnCwdFor('gemini') === undefined && rag.spawnCwdFor('nope') === undefined, String(spawnAt));
      {
        const proj = mk('acp-evil-project');
        fs.writeFileSync(path.join(proj, '.npmrc'), 'registry=http://127.0.0.1:1/\n');
        const dumpFile = path.join(proj, '..', 'acp-spawn-cwd.json');
        const rr = await go('', { cwd: proj, spawnCwd: spawnAt, access: 'chat' }, { FAKE_ACP_ENV_DUMP: dumpFile });
        const dumped = JSON.parse(fs.readFileSync(dumpFile, 'utf8'));
        const here = (p) => fs.realpathSync(p).toLowerCase();
        ok('带恶意 .npmrc 的任务目录：进程在 _acp-run 里启动（读不到那个 .npmrc），会话的 cwd 仍是任务目录', here(dumped.cwd) === here(spawnAt) && rr.calls('session/new').some((p) => p.cwd === proj), JSON.stringify([dumped.cwd, rr.calls('session/new')]));
        const plain = await go('', { cwd: proj, access: 'chat' }, { FAKE_ACP_ENV_DUMP: dumpFile });
        ok('没有 spawnCwd（预设 / 自定义的代理）：照旧在任务目录里启动', here(JSON.parse(fs.readFileSync(dumpFile, 'utf8')).cwd) === here(proj) && !!plain.done);
      }
      eq('uvx 的命令行没有 --yes', agentsMod.launchArgs({ args: ['serve'] }, { dist: 'uvx', spec: 'fake-uvx==0.5.0' }), ['fake-uvx==0.5.0', 'serve']);

      // 注册表上出了新版本
      state.body = { ...body, agents: body.agents.map((a) => (a && a.id === 'fake-npx' ? { ...a, version: '1.3.0', distribution: { npx: { package: '@fake/agent@1.3.0', args: ['--acp'] } } } : a)) };
      const upd = await rag.registryList({ fresh: true });
      const row = upd.value.find((e) => e.id === 'fake-npx');
      ok('注册表有新版本：标出可更新，已装的仍固定在旧版本', row.installed && row.installedVersion === '1.2.3' && row.updateAvailable === true && rag.launch(rid).args[1] === '@fake/agent@1.2.3');
      asked.length = 0;
      const re = await rag.addFromRegistry({ id: 'fake-npx' }, confirm);
      ok('更新要重新确认；同一个条目原地更新，不多出一个', re.ok && re.value.id === rid && asked.length === 1 && /1\.3\.0/.test(asked[0].message) && rag.list().filter((a) => a.source === 'registry').length === 1 && rag.launch(rid).args[1] === '@fake/agent@1.3.0');
      // 手工改过 services.json（spec 与确认过的不一致）→ 不运行
      const raw = rreg._state().agents.find((a) => a.id === rid);
      raw.registry.spec = '@evil/pkg@6.6.6';
      const tampered = rag.launch(rid);
      ok('services.json 里的规格被改过（与确认过的不一致）：拒绝启动', !tampered.ok && tampered.code === 'UNCONFIRMED', JSON.stringify(tampered));
      raw.registry.spec = '@fake/agent@1.3.0';
      raw.registry.confirmed = '';
      ok('没有确认记录：拒绝启动', rag.launch(rid).code === 'UNCONFIRMED');
      raw.registry.confirmed = '@fake/agent@1.3.0';
      const noNpx = agentsMod.createAcpAgents({ registry: rreg, userData: rdir, now: () => clock, secrets, resolveCommand: () => null });
      ok('电脑上没有 npx：说明去装 Node.js', /Node\.js/.test(noNpx.launch(rid).error));

      // uvx 与数量上限
      const uv = await rag.addFromRegistry({ id: 'fake-uvx' }, confirm);
      eq('uvx 的确认框与启动', [/uvx（PyPI）/.test(asked[asked.length - 1].message), /PyPI/.test(asked[asked.length - 1].detail), rag.launch(uv.value.id).args], [true, true, ['fake-uvx==0.5.0', 'serve']]);
      const nv = await rag.addFromRegistry({ id: 'fake-nover' }, confirm);
      ok('包名没写版本的条目，用条目的版本固定后添加', nv.ok && nv.value.install === 'npx --yes @fake/nover@4.5.6');

      // 通过注册表代理做一次探测（用包装器代替 npx）：登记时确认过才会运行
      if (isWin) {
        for (const k of Object.keys(probeEnvObj)) delete probeEnvObj[k];
        Object.assign(probeEnvObj, { FAKE_ACP_MODE: 'config-options' });
        const pr = await rag.probe({ agent: rid, deep: true, fresh: true });
        ok('注册表代理的探测经 npx 启动（这里是包装器），拿到摘要', pr.ok && pr.summary && pr.summary.models.length === 3, JSON.stringify(pr).slice(0, 200));
      }
      // 移除
      const rm = rag.remove(rid);
      ok('移除：services.json 里没了，探测缓存清了', rm.ok && !rag.get(rid) && !JSON.parse(fs.readFileSync(path.join(rdir, 'services.json'), 'utf8')).agents.some((a) => a.id === rid));
      ok('移除：预设 / 不存在 / 非字符串被拒', !rag.remove('kimi').ok && !rag.remove('nope').ok && !rag.remove(undefined).ok && !!rag.get('kimi'));

      // 数量上限
      const cap = servicesMod.createRegistry({ userDir: mk('acp-cap'), secrets });
      secrets.configure(cap.secretsConfig());
      const capAg = agentsMod.createAcpAgents({ registry: cap, userData: mk('acp-cap-ud'), now: () => clock, secrets });
      const f = fakeCmd('cap-agent.cmd');
      let last;
      for (let i = 0; i < agentsMod.MAX_USER_AGENTS + 1; i += 1) {
        const t = await capAg.pickExe({}, async () => f);
        last = await capAg.addCustom({ token: t.value.token, label: `代理${i}`, args: [], envNames: [] }, yes);
        if (!last.ok) break;
      }
      ok(`自己添加的代理最多 ${agentsMod.MAX_USER_AGENTS} 个，id 不重复`, !last.ok && /最多 32/.test(last.error) && capAg.list().length === 18 + agentsMod.MAX_USER_AGENTS && new Set(capAg.entries().map((e) => e.def.id)).size === 18 + 1 + agentsMod.MAX_USER_AGENTS, JSON.stringify(last));
    } finally {
      await new Promise((r) => server.close(r));
    }
  }

  /* ───────────── IPC 表面 ───────────── */

  section('T-ACP IPC 通道');
  {
    const handlers = new Map();
    const ipcDir = mk('acp-ipc');
    const ipcReg = servicesMod.createRegistry({ userDir: ipcDir, secrets });
    secrets.configure(ipcReg.secretsConfig());
    const exe = fakeCmd('ipc-agent.cmd');
    const asked = [];
    const ipcAg = agentsMod.createAcpAgents({ registry: ipcReg, userData: ipcDir, now: () => clock, secrets });
    agentsMod.register((ch, fn) => handlers.set(ch, fn), { agents: ipcAg, confirm: async (_e, o) => { asked.push(o); return true; }, chooseFile: async () => exe, tooSoon: () => false });
    eq('登记的通道正好是规格里的六个', [...handlers.keys()].sort(), ['acp:add-custom', 'acp:add-registry', 'acp:pick-exe', 'acp:probe', 'acp:registry', 'acp:remove']);
    // preload 暴露的方法对得上这些通道
    const preload = fs.readFileSync(path.join(APP, 'electron', 'preload.cjs'), 'utf8');
    const used = [...preload.matchAll(/ipcRenderer\.invoke\('(acp:[\w-]+)'/g)].map((m) => m[1]).sort();
    eq('preload 的 acp 方法 → 通道，一一对应', used, [...handlers.keys()].sort());
    const picked = await handlers.get('acp:pick-exe')({}, 'ignored', { path: 'C:/evil.exe' });
    ok('pick-exe：经 chooseFile，返回令牌与文件名', picked.ok && picked.value.name === 'ipc-agent.cmd');
    const added = await handlers.get('acp:add-custom')({}, { token: picked.value.token, label: '通道测试', args: ['--acp'], envNames: [], path: 'C:/evil.exe', exe: 'C:/evil.exe', binding: { mode: 'env' } });
    ok('add-custom：只读 token / label / args / envNames，页面多传的 path / exe / binding 被忽略；确认框走原生确认', added.ok && ipcAg.launch(added.value.id).exe === exe && asked.length === 1, JSON.stringify(added));
    const bad = await handlers.get('acp:add-custom')({}, { token: picked.value.token, label: '再来', args: [{ x: 1 }, 'a'.repeat(100)], envNames: ['A'.repeat(100)] });
    ok('add-custom：类型不对 / 超长的参数被拒绝（不是悄悄丢掉）', !bad.ok);
    const p = await handlers.get('acp:probe')({}, { agent: 5, deep: 'yes' });
    ok('probe：agent 不是字符串 → 报错，不抛', p.ok === false);
    ok('probe：超长 agent 名 / 非对象请求 → 报错', (await handlers.get('acp:probe')({}, { agent: 'x'.repeat(100) })).ok === false && (await handlers.get('acp:probe')({}, null)).ok === false);
    const r1 = await handlers.get('acp:remove')({}, added.value.id);
    ok('remove：删除自己添加的', r1.ok && !ipcAg.get(added.value.id));
    ok('remove：预设 / 超长 / 非字符串被拒', !(await handlers.get('acp:remove')({}, 'kimi')).ok && !(await handlers.get('acp:remove')({}, 'x'.repeat(99))).ok && !(await handlers.get('acp:remove')({}, { id: 'kimi' })).ok);
    ok('add-registry：没有 id / 超长 id → 拒绝，不请求网络', !(await handlers.get('acp:add-registry')({}, {})).ok && !(await handlers.get('acp:add-registry')({}, { id: 'a'.repeat(99) })).ok);
    // 限速：tooSoon 为真时 fresh 变成缓存读取
    const limited = new Map();
    const lim = agentsMod.createAcpAgents({ registry: ipcReg, userData: ipcDir, now: () => clock, secrets });
    const seen = [];
    const limSpy = new Proxy(lim, { get: (t, k) => (k === 'probe' ? (r) => { seen.push(r); return t.probe(r); } : k === 'registryList' ? (r) => { seen.push(r); return Promise.resolve({ ok: true, value: [] }); } : t[k]) });
    agentsMod.register((ch, fn) => limited.set(ch, fn), { agents: limSpy, tooSoon: () => true });
    await limited.get('acp:probe')({}, { agent: 'opencode', fresh: true });
    await limited.get('acp:registry')({}, { fresh: true });
    eq('限速（同一个代理 2 秒、注册表 30 秒）：太快的 fresh 请求降级为读缓存', [seen[0].fresh, seen[1].fresh], [false, false]);
  }
}

module.exports = { runTAcp };

/* ═════════════════════════ 单独运行 ═════════════════════════ */

if (require.main === module) {
  (async () => {
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-acp-check-'));
    let failed = 0;
    let passed = 0;
    const secrets = require('../../electron/ai/secrets.cjs');
    const fakeSafe = {
      isAsyncEncryptionAvailable: async () => true,
      encryptStringAsync: async (s) => Buffer.from(`ENC:${Buffer.from(s, 'utf8').toString('base64')}`),
      decryptStringAsync: async (b) => ({ result: Buffer.from(b.toString().slice(4), 'base64').toString('utf8'), shouldReEncrypt: false }),
    };
    const keyDir = path.join(work, 'keys');
    fs.mkdirSync(keyDir, { recursive: true });
    secrets.__setDeps({ dir: keyDir, safeStorage: fakeSafe });
    const h = {
      secrets, servicesMod: require('../../electron/ai/services.cjs'),
      ok: (name, cond, extra = '') => { if (!cond) { failed += 1; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); } else { passed += 1; console.log(`  ok  ${name}`); } },
      eq: (name, got, want) => { const a = JSON.stringify(got); const b = JSON.stringify(want); if (a !== b) { failed += 1; console.error(`  FAIL ${name}\n    got:  ${a}\n    want: ${b}`); } else { passed += 1; console.log(`  ok  ${name}`); } },
      section: (name) => console.log(`\n${name}`),
      mk: (name) => { const d = path.join(work, name); fs.mkdirSync(d, { recursive: true }); return d; },
    };
    try { await runTAcp(h); } catch (e) { failed += 1; console.error('FAIL 套件抛出了异常', e && e.stack || e); }
    secrets.__setDeps(null);
    secrets.configure(null);
    try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { console.log(`  note 临时目录没删干净：${work}`); }
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  })();
}
