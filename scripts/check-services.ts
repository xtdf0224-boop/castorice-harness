/* 模块检查（models · MB1）：npm run check:services
   无 GUI、无网络、不花额度：全部请求只发往 127.0.0.1 上的假服务（scripts/fixtures/fake-llm.cjs），密钥是假的，safeStorage 是替身。
   覆盖 MODELS-SPEC §15.4 里归后端底座的部分：
     T-REG 注册表与预设校验 · T-URL checkBaseUrl · T-HDR 头 / 体 / 模型名 · T-EFF 推理强度 golden（页面与主进程两份实现）
     T-WIRE 适配器 · T-DIAL 方言 · T-RETRY 重试与降级 · T-SEC 密钥与脱敏、svc:save 模糊测试 · T-NET 网络规则与本机探测
     T-PLAN 套餐通道 · T-MIG 迁移 · T-ENV 环境变量 · T-IPC 表面积
   Electron 里的那一半（真正的 startStream、net.fetch、伪造的 StartSpec）在 scripts/fixtures/services-electron-main.cjs，本脚本会在 electron 可用时启动它。 */
// 必须最先：它在页面代码（desktop.ts 在加载时读 window.alightDesktop）被加载之前把桥放好
import { impl as bridge } from './fixtures/state-bridge';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { effortLevels, effortRequest, resolveEffort as pageResolveEffort, wireFields, type Effort } from '../src/lib/effort';
import { PROVIDERS, PROVIDER_BY_ID, contextOf, defaultProviderConfig, driverOf, hasProvider, permissionSupport, readiness, DRIVERS } from '../src/lib/providers';
import { AGENT_DEFS, PRESET_SERVICES, checkBaseUrl as pageCheckBaseUrl, gradeOf, keyHintFor, serviceOf, setCustomServices, setCustomMirror, type ServiceDef } from '../src/lib/services';
import { choiceEfforts, engineChoices, initialModels, modelActions, modelOptions, refreshModels, restoreModels } from '../src/state/models';
import { emptyState } from '../src/state/seed';
import { getPendingLegacy, pinModel, refreshModelList, removeCustomService, saveCustomService, tasksUsing } from '../src/state/services';
import { store } from '../src/state/store';
import {
  addCustom as pageAddCustom, agentServices, allAgentRecs, glyphOf as pageGlyph, loadRegistry as pageLoadRegistry, pickExe as pagePickExe, probeOf, pseudoServiceOf, removeAgent as pageRemoveAgent, runProbe as pageRunProbe, standaloneRecs, userAgents,
} from '../src/state/agents';

/* eslint-disable @typescript-eslint/no-explicit-any */
let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (!cond) { failed += 1; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); } else { passed += 1; console.log(`  ok  ${name}`); }
}
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) { failed += 1; console.error(`  FAIL ${name}\n    got:  ${a}\n    want: ${b}`); } else { passed += 1; console.log(`  ok  ${name}`); }
}
const section = (name: string) => console.log(`\n${name}`);

const req = createRequire(path.resolve('package.json'));
const net = req('./electron/ai/net.cjs');
const effortWire = req('./electron/ai/effort-wire.cjs');
const servicesMod = req('./electron/ai/services.cjs');
const validateMod = req('./electron/ai/services-validate.cjs');
const secrets = req('./electron/ai/secrets.cjs');
const api = req('./electron/ai/api.cjs');
const { createScrubber } = req('./electron/ai/scrub.cjs');
const { buildCompatEnv } = req('./electron/ai/compat-env.cjs');
const { startFake } = req('./scripts/fixtures/fake-llm.cjs');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-services-check-'));
const mk = (name: string) => { const d = path.join(work, name); fs.mkdirSync(d, { recursive: true }); return d; };
const stable = (v: unknown): string => {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stable((v as any)[k])}`).join(',')}}`;
  return JSON.stringify(v);
};
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

/* ═══════════════ 共用的替身：safeStorage、注册表、假服务上的自定义服务 ═══════════════ */

const fakeSafe = {
  isAsyncEncryptionAvailable: async () => true,
  encryptStringAsync: async (s: string) => Buffer.from(`ENC:${Buffer.from(s, 'utf8').toString('base64')}`),
  decryptStringAsync: async (b: Buffer) => { const t = b.toString(); if (!t.startsWith('ENC:')) throw new Error('bad blob'); return { result: Buffer.from(t.slice(4), 'base64').toString('utf8'), shouldReEncrypt: false }; },
};
const keyDir = mk('keys');
secrets.__setDeps({ dir: keyDir, safeStorage: fakeSafe });

const yes = async () => true;
let regSeq = 0;
/** A fresh registry on its own (temp) user folder, wired into secrets.cjs the way the app does it. */
function newRegistry() {
  const dir = mk(`user-${regSeq++}`);
  const reg = servicesMod.createRegistry({ userDir: dir, secrets });
  secrets.configure(reg.secretsConfig());
  return { reg, dir };
}
/** A custom service whose address is the fake server. */
const fakeDef = (fake: any, extra: Record<string, unknown> = {}) => ({
  name: '假服务', endpoints: [{ id: 'main', label: '本机假服务', kind: 'local', baseUrl: fake.baseUrl, compatUrl: fake.origin }],
  auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'fake-model', ctx: 32768 }], wire: { maxTokensField: 'max_tokens', defaultMaxOut: 4096, testMaxTokens: 128 }, ...extra,
});
async function withFake<T>(opts: Record<string, unknown>, fn: (fake: any) => Promise<T>): Promise<T> {
  const fake = await startFake(opts);
  try { return await fn(fake); } finally { await fake.close(); }
}
/** Save a custom service on the fake and return its id. */
async function addFake(reg: any, fake: any, extra: Record<string, unknown> = {}) {
  const r = await reg.saveService(fakeDef(fake, extra), { confirm: yes });
  if (!r.ok) throw new Error(`addFake: ${r.error}`);
  return r.value.id as string;
}
/** Save a key the way the app does (index.cjs saveKeyOp): the native "where will this key go" question first, then the slot. */
async function saveFor(reg: any, id: string, key: string, endpoint?: string) {
  const service = reg.get(id);
  const ep = endpoint ? reg.endpointOf(service, endpoint) : reg.defaultEndpoint(service, 'api') || service.endpoints[0];
  if (!(await reg.confirmKeyDestination(service, ep, yes))) throw new Error('saveFor: refused');
  await reg.releaseLegacySlot(service, ep);
  return secrets.save(reg.slotFor(service, ep), key);
}
/** Resolve + run one API request against a registry; collects events like the page would. */
async function runApi(reg: any, spec: Record<string, unknown>, o: { key?: string; internal?: Record<string, unknown> } = {}) {
  const rr = reg.resolveApi({ driver: 'api', messages: [{ role: 'user', content: '你好' }], maxTokens: 1000, ...spec }, o.internal);
  if (!rr.ok) return { resolved: rr, events: [] as any[], error: undefined as any };
  const events: any[] = [];
  const sc = createScrubber(o.key || undefined, (e: any) => events.push(e));
  // what startStream (index.cjs) does before the adapter runs: the resolver's notices (a degraded level…) go out first
  for (const n of rr.r.notices) sc.emit({ type: 'notice', level: n.level, text: n.text });
  let error: any;
  let result: any;
  try {
    result = await (rr.r.protocol === 'anthropic' ? api.streamAnthropic : api.streamOpenAI)(rr.r, o.key || '', sc.emit, new AbortController().signal);
    sc.emit({ type: 'done', text: result.text, stopReason: result.stopReason });
  } catch (e) { error = e; sc.emit({ type: 'error', message: (e as Error).message, code: (e as any).code }); }
  return { resolved: rr, events, error, result };
}
const textOf = (events: any[], type: string) => events.filter((e) => e.type === type).map((e) => e.text).join('');

/* ═══════════════════════════ T-REG：注册表 ═══════════════════════════ */

section('T-REG 注册表与预设');
{
  const cat = servicesMod.catalog();
  eq('39 个服务、19 个命令行代理、4 个内置驱动', [cat.presets.length, cat.agents.length, cat.drivers.length], [39, 19, 4]);
  eq('预设 id 全局唯一', new Set(cat.presets.map((s: any) => s.id)).size, 39);
  eq('隐藏的预设只有 vercel 和 dmr', cat.presets.filter((s: any) => s.hidden).map((s: any) => s.id).sort(), ['dmr', 'vercel']);
  eq('隐藏的代理只有 dsh-acp', cat.agents.filter((a: any) => a.hidden).map((a: any) => a.id), ['dsh-acp']);
  eq('首发的 8 家排在最前、顺序不变', cat.presets.slice(0, 8).map((s: any) => s.id), ['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'doubao']);
  ok('每个预设都带核实日期', cat.presets.every((s: any) => /^\d{4}-\d{2}-\d{2}$/.test(s.verified)));
  ok('预设 id 不以 x_ / acp_ 开头', cat.presets.every((s: any) => !/^(x_|acp_)/.test(s.id)));
  // 所有地址展开占位符后都过 checkBaseUrl；local 只回环 http，非 local 不得 http
  let badUrl = '';
  for (const s of cat.presets) for (const e of s.endpoints) for (const key of ['baseUrl', 'compatUrl', 'responsesUrl']) {
    const u: string | undefined = e[key];
    if (!u) continue;
    const c = net.checkBaseUrl(u.replace(net.PLACEHOLDER, 'x'));
    if (!c) badUrl = `${s.id}/${e.id}.${key}`;
    else if ((e.kind === 'local') !== c.url.startsWith('http://')) badUrl = `${s.id}/${e.id}.${key} (kind/协议不符)`;
  }
  eq('每个预设地址都过 checkBaseUrl，且 local ⇔ 回环 http', badUrl, '');
  // 占位符：正则拒绝 . / @ :
  let badPattern = '';
  for (const s of cat.presets) for (const e of s.endpoints) for (const p of e.params ?? []) for (const probe of ['a.b', 'a/b', 'a@b', 'a:b']) if (new RegExp(p.pattern).test(probe)) badPattern = `${s.id}.${p.name} 接受 ${probe}`;
  eq('占位符正则拒绝 . / @ :', badPattern, '');
  ok('带占位符的有 azure、bedrock、cloudflare', ['azure', 'bedrock', 'cloudflare'].every((id) => cat.byId.get(id).endpoints.some((e: any) => e.params?.length)));
  // drivers、cliModels、规则
  let badDriver = '';
  for (const s of cat.presets) for (const d of s.drivers) {
    if (d === 'claude-compat') { if (!s.endpoints.some((e: any) => e.compatUrl)) badDriver = `${s.id} 用 claude-compat 却没有 compatUrl`; } else if (d.startsWith('acp:') && !cat.agentById.has(d.slice(4))) badDriver = `${s.id} 引用了不存在的代理 ${d}`;
  }
  eq('drivers 引用都存在，claude-compat 的服务都有 compatUrl', badDriver, '');
  let badRule = '';
  for (const s of cat.presets) for (const r of s.effortRules ?? []) { try { new RegExp(r.match, r.flags); } catch { badRule = `${s.id}: ${r.match}`; } if (r.match.length > 120) badRule = `${s.id} 规则太长`; if (!s.effortProfiles?.[r.effort]) badRule = `${s.id} 规则指向不存在的档案 ${r.effort}`; }
  eq('effortRules 都能编译、≤120 字符、指向存在的档案', badRule, '');
  // 代理定义里的环境变量名 ⊂ 断言名单（禁用表不含）
  let badEnv = '';
  for (const a of cat.agents) if (a.binding.mode === 'env') for (const n of [a.binding.keyEnv, ...Object.keys(a.binding.env)]) if (validateMod.envNameProblem(n)) badEnv = `${a.id}: ${n}`;
  eq('代理定义里的环境变量名都合法、不在禁用表', badEnv, '');
  eq('旧驱动名 kimi / qwen / mcode 各映射到同名代理', ['kimi', 'qwen', 'mcode'].map((d) => servicesMod.agentIdOfDriver(d)), ['kimi', 'qwen', 'mcode']);
  eq("driver:'acp' + acp:'kimi' 与 'acp:gemini' 的映射", [servicesMod.agentIdOfDriver('acp', 'kimi'), servicesMod.agentIdOfDriver('acp:gemini'), servicesMod.agentIdOfDriver('claude-code'), servicesMod.agentIdOfDriver('acp', undefined)], ['kimi', 'gemini', '', '']);
  eq('Kimi 默认可见的 5 种方式里只有它是 verified', cat.agents.filter((a: any) => a.perm.level === 'verified').map((a: any) => a.id), ['kimi']);

  // 页面这一份与主进程这一份读的是同一批预设
  eq('页面的预设与主进程一致（id 与顺序）', PRESET_SERVICES.map((s) => s.id), cat.presets.map((s: any) => s.id));
  eq('页面 PROVIDERS 只含可见预设（37 个）', PROVIDERS.length, 37);
  ok('页面能按 id 取到隐藏的预设', hasProvider('vercel') && hasProvider('dmr') && !PROVIDERS.some((p) => p.id === 'vercel'));
  ok('每个页面服务的每个驱动都有 DRIVERS 描述（旧界面不会因 undefined 崩）', PROVIDERS.every((p) => p.drivers.every((d) => !!(DRIVERS as any)[d])));
  ok('19 个代理都生成了 acp:<id> 驱动描述', AGENT_DEFS.every((a) => !!(DRIVERS as any)[`acp:${a.id}`]));
  eq('旧 kimi 驱动的文案原样保留', [driverOf('kimi').label, driverOf('kimi').note], ['Kimi Code CLI', '用 Kimi 会员账号登录（需含 Kimi Code 额度）。通过 ACP 协议对接，操作前会征求确认。']);
  ok('每个页面模型都有名字（unit-check 的前提）', PROVIDERS.every((p) => [...p.models, ...Object.values(p.cliModels).flat()].every((m: any) => !m || !m.id || !!m.label)));
  eq("'*' 与字符串引用展开成完整的模型", PROVIDER_BY_ID.glm.cliModels['claude-compat']!.map((m) => m.label), ['GLM-5.3', 'GLM-5.3 Flash']);
  eq('已删除 / 未知的 id 读作「（已删除）」占位而不是 undefined', [PROVIDER_BY_ID['x_gone'].name, hasProvider('x_gone'), serviceOf('x_gone').name], ['（已删除）', false, '（已删除）']);

  // 校验：坏数据被拒绝，并说明字段
  const agentIds = new Set(cat.agentById.keys());
  const base = () => clone(cat.byId.get('gpt'));
  const refuse = (name: string, mutate: (d: any) => void, mode = 'preset', field?: RegExp) => {
    const d = base(); mutate(d);
    const r = validateMod.validateService(d, { mode, agentIds });
    ok(name, !r.ok && (!field || field.test(r.field ?? '')), r.ok ? '竟然通过了' : `${r.field}: ${r.error}`);
  };
  refuse('拒绝：非回环 http 地址', (d) => { d.endpoints[0].baseUrl = 'http://api.example.com/v1'; }, 'preset', /baseUrl/);
  refuse('拒绝：local 端点用 https', (d) => { d.endpoints[0].kind = 'local'; }, 'preset', /baseUrl/);
  refuse('拒绝：局域网 http', (d) => { d.endpoints[0] = { id: 'lan', label: '局域网', kind: 'local', baseUrl: 'http://192.168.1.5:11434/v1' }; }, 'preset', /baseUrl/);
  refuse('拒绝：占位符换掉主机后缀', (d) => { d.endpoints[0].baseUrl = 'https://{x}.com/v1'; d.endpoints[0].params = [{ name: 'x', label: 'x', pattern: '^[a-z]+$' }]; }, 'preset', /baseUrl/);
  refuse('拒绝：占位符正则接受点', (d) => { d.endpoints[0].baseUrl = 'https://{r}.api.example.com/v1'; d.endpoints[0].params = [{ name: 'r', label: 'r', pattern: '^[a-z.]+$' }]; }, 'preset', /pattern/);
  refuse('拒绝：地址里的占位符没声明', (d) => { d.endpoints[0].baseUrl = 'https://{r}.api.example.com/v1'; }, 'preset', /baseUrl/);
  refuse('拒绝：模型 id 重复', (d) => { d.models.push({ id: d.models[0].id }); }, 'preset', /models/);
  refuse('拒绝：模型 id 含空格', (d) => { d.models[0].id = 'a b'; }, 'preset', /models/);
  refuse('拒绝：规则指向不存在的档案', (d) => { d.effortRules = [{ match: 'x', effort: 'nope' }]; }, 'preset', /effortRules/);
  refuse('拒绝：规则正则不合法', (d) => { d.effortRules = [{ match: '(', effort: 'gpt' }]; }, 'preset', /effortRules/);
  refuse('拒绝：驱动引用了不存在的代理', (d) => { d.drivers = ['acp:nope']; }, 'preset', /drivers/);
  refuse('拒绝：claude-compat 却没有 compatUrl', (d) => { d.drivers = ['claude-compat']; }, 'preset', /drivers/);
  refuse('拒绝：自定义 header 鉴权缺头名', (d) => { d.auth = { scheme: 'header' }; }, 'preset', /auth/);
  refuse('拒绝：预留协议 openai-responses', (d) => { d.protocol = 'openai-responses'; }, 'preset', /protocol/);
  refuse('拒绝：dropFields 丢核心字段', (d) => { d.wire = { dropFields: ['messages'] }; }, 'preset', /dropFields/);
  refuse('拒绝：预设 id 以 x_ 开头', (d) => { d.id = 'x_gpt'; }, 'preset', /id/);
  refuse('拒绝：自定义 id 不以 x_ 开头', (d) => { d.id = 'mine'; d.kind = 'custom'; }, 'custom', /id/);
  refuse('拒绝：自定义服务带 effortRules', (d) => { d.id = 'x_mine'; d.kind = 'custom'; }, 'custom', /effortRules/);
  refuse('拒绝：自定义服务设默认思考', (d) => { d.id = 'x_mine'; d.kind = 'custom'; delete d.effortRules; delete d.effortProfiles; d.wire = { defaultThinking: { type: 'adaptive', display: 'summarized' } }; }, 'custom', /wire/);
  refuse('拒绝：glyph 超过 2 个字符', (d) => { d.glyph = 'abc'; }, 'preset', /glyph/);
}

/* ═══════════════════════════ T-URL：checkBaseUrl ═══════════════════════════ */

section('T-URL checkBaseUrl（主进程与页面两份对同一张表）');
{
  const table: Array<[string, string | null, boolean?]> = [
    ['https://api.openai.com/v1', 'https://api.openai.com/v1'],
    ['https://api.example.com/v1/', 'https://api.example.com/v1'],
    ['http://127.0.0.1:11434/v1', 'http://127.0.0.1:11434/v1'],
    ['http://localhost:1234/v1', 'http://localhost:1234/v1'],
    ['http://[::1]:8080', 'http://[::1]:8080'],
    ['https://my-resource.openai.azure.com/openai/v1', 'https://my-resource.openai.azure.com/openai/v1'],
    ['http://api.example.com/v1', null],
    ['http://192.168.1.5:11434/v1', null],
    ['http://127.0.0.2/', null],
    ['http://0.0.0.0:8080', null],
    ['https://user:pw@host/v1', null],
    ['https://host/v1#x', null],
    ['https://host/v1?key=1', null],
    ['https://host/v1?', null],
    ['https://169.254.169.254/', null],
    ['https://[fd00:ec2::254]/', null],
    ['https://100.100.100.200/', null],
    ['https://metadata.google.internal/', null],
    ['https://metadata.google.internal./x', null],
    ['http://2852039166/', null],
    ['https://[::ffff:169.254.169.254]/', null],
    ['ftp://host/', null],
    ['file:///c:/x', null],
    ['javascript:alert(1)', null],
    ['', null],
    ['https://host/v1 /x', null],
    ['https://host:99999/v1', null],
    [`https://${'a'.repeat(520)}.com/`, null],
    ['https://192.168.1.5:8443/v1', 'https://192.168.1.5:8443/v1', true],
    ['https://10.0.0.7/v1', 'https://10.0.0.7/v1', true],
    ['https://printer.local/v1', 'https://printer.local/v1', true],
  ];
  for (const [input, want, priv] of table) {
    const a = net.checkBaseUrl(input);
    const b = pageCheckBaseUrl(input);
    eq(`主进程 ${JSON.stringify(input).slice(0, 60)}`, a ? [a.url, !!a.private] : null, want ? [want, !!priv] : null);
    eq(`页面   ${JSON.stringify(input).slice(0, 60)}`, b ? [b.url, !!b.private] : null, want ? [want, !!priv] : null);
  }
  eq('非字符串输入', [net.checkBaseUrl(undefined), net.checkBaseUrl(42), net.checkBaseUrl({})], [null, null, null]);
  // 占位符展开
  const azure = servicesMod.catalog().byId.get('azure').endpoints[0];
  eq('占位符展开：Azure 资源名', net.expandUrl(azure.baseUrl, azure.params, { resource: 'my-resource' }).url, 'https://my-resource.openai.azure.com/openai/v1');
  for (const bad of ['a.evil.com', 'a/b', 'a@b', 'a:b', '', 'A B', '-', 'x'.repeat(70)]) {
    const r = net.expandUrl(azure.baseUrl, azure.params, { resource: bad });
    ok(`占位符值 ${JSON.stringify(bad).slice(0, 24)} 被拒`, !r.ok);
  }
  ok('占位符缺值被拒并点名', (() => { const r = net.expandUrl(azure.baseUrl, azure.params, {}); return !r.ok && /资源名/.test(r.error); })());
  ok('页面传来不是字符串的值被拒', !net.expandUrl(azure.baseUrl, azure.params, { resource: { toString: () => 'ok' } }).ok);
  const bed = servicesMod.catalog().byId.get('bedrock').endpoints[0];
  eq('Bedrock 的区域占位符（第二段）可用', net.expandUrl(bed.baseUrl, bed.params, { region: 'us-east-1' }).url, 'https://bedrock-runtime.us-east-1.amazonaws.com/openai/v1');
  const cf = servicesMod.catalog().byId.get('cloudflare').endpoints[0];
  eq('Cloudflare 的账号 ID 在路径里', net.expandUrl(cf.baseUrl, cf.params, { accountId: 'a'.repeat(32) }).url, `https://api.cloudflare.com/client/v4/accounts/${'a'.repeat(32)}/ai/v1`);
  ok('Cloudflare 账号 ID 不是 32 位十六进制被拒', !net.expandUrl(cf.baseUrl, cf.params, { accountId: 'zz' }).ok);
}

/* ═══════════════════════════ T-HDR：头、体、模型名 ═══════════════════════════ */

section('T-HDR 请求头 / 请求体 / 模型名');
{
  for (const n of ['X-Title', 'HTTP-Referer', 'anthropic-beta', 'OpenAI-Organization']) ok(`头名 ${n} 可用`, net.checkHeaderName(n));
  for (const n of ['Host', 'content-type', 'Content-Length', 'Cookie', 'Set-Cookie', 'Proxy-Authorization', 'proxy-x', 'Connection', 'Transfer-Encoding', 'TE', 'Upgrade', 'Expect', 'Origin', 'User-Agent', 'Authorization', 'x-api-key', 'api-key', 'x-goog-api-key', 'anthropic-version', 'a b', '1x', '', 'x'.repeat(41), 'X:Y', 'X\r\nY']) ok(`头名 ${JSON.stringify(n).slice(0, 30)} 被拒`, !net.checkHeaderName(n));
  ok('鉴权头名：x-goog-api-key 作为「鉴权头」可用', net.checkHeaderName('x-goog-api-key', { auth: true }));
  ok('鉴权头名：Host 仍被拒', !net.checkHeaderName('Host', { auth: true }));
  ok('头值：普通文本可用', net.checkHeaderValue('Alight/0.1 (+https://example.com)'));
  for (const v of ['a\r\nb', 'a\nb', 'x'.repeat(257), '中文', 'a\u0000b', 5 as any]) ok(`头值 ${JSON.stringify(v).slice(0, 24)} 被拒`, !net.checkHeaderValue(v));
  // 模型名：API 与命令行同一条
  for (const id of ['gpt-6.1-sol', '@cf/openai/gpt-oss-120b', '~anthropic/claude-opus-latest', 'a/b:c', 'sonnet[1m]', 'accounts/fireworks/models/llama-v3p1-8b-instruct', 'openai.gpt-oss-120b-1:0', 'MiniMax-M3.1-Flash']) ok(`模型名 ${id} 通过`, net.checkModelId(id));
  for (const id of ['a b', 'a;b', 'a`b', 'a$(x)', '', 'x'.repeat(101), 'a|b', 'a&b', 'a%b', '../x\\y', 'a\nb']) ok(`模型名 ${JSON.stringify(id).slice(0, 24)} 被拒`, !net.checkModelId(id));
  // extraBody
  ok('extraBody：普通字段通过', net.checkExtraBody({ extra_body: { google: { thinking_config: { include_thoughts: true } } }, reasoning_format: 'parsed', seed: 3 }).ok);
  for (const [name, body] of [
    ['禁用键 model', { model: 'x' }], ['禁用键 messages', { messages: [] }], ['禁用键 stream', { stream: false }], ['禁用键 stream_options', { stream_options: {} }], ['禁用键 max_tokens', { max_tokens: 1 }],
    ['禁用键 tools', { tools: [] }], ['禁用键 n', { n: 2 }], ['键名含空格', { 'a b': 1 }], ['键名 __proto__', JSON.parse('{"__proto__": {"x": 1}}')], ['键名 constructor', { constructor: 1 }],
    ['超过 4 KB', { a: 'x'.repeat(190), b: Array.from({ length: 20 }, () => 'y'.repeat(190)).join('') + 'z'.repeat(1000) }], ['嵌套 5 层', { a: { b: { c: { d: { e: 1 } } } } }],
    ['数组里放对象', { a: [{ x: 1 }] }], ['数组超过 20 项', { a: Array.from({ length: 21 }, () => 1) }], ['字符串超过 200', { a: 'x'.repeat(201) }], ['非有限数', { a: Infinity }],
  ] as Array<[string, any]>) ok(`extraBody 被拒：${name}`, !net.checkExtraBody(body).ok);
  ok('extraBody 非对象被拒', !net.checkExtraBody([1]).ok && !net.checkExtraBody('x').ok);
  ok('extraBody 的 __proto__ 不会污染原型', (() => { net.checkExtraBody(JSON.parse('{"__proto__": {"polluted": true}}')); return ({} as any).polluted === undefined; })());
}

/* ═══════════════════════════ T-EFF：推理强度 golden（I8 的核心） ═══════════════════════════ */

section('T-EFF 推理强度 golden（旧实现 → 页面 effort.ts 与主进程 effort-wire.cjs 各对一遍）');
{
  const golden = JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures/effort-golden.json'), 'utf8'));
  const SCALE: string[] = golden.scale;
  const cat = servicesMod.catalog();
  let pageLevelBad = 0; let pageBodyBad = 0; let mainLevelBad = 0; let mainBodyBad = 0; let items = 0;
  const firstBad: string[] = [];
  const note = (s: string) => { if (firstBad.length < 6) firstBad.push(s); };
  // 有意的改动（审查）：Claude 的默认档案与默认 adaptive thinking 只对 5 代的 id 生效（旧模型会拒绝 adaptive）。旧实现对任何 id 都发，
  // golden 里这些行（sonnet[1m]、haiku、qwen-plus、手填 id…）改成「没有档位、不发字段」。其余 8 家、5 代 id 的行仍与旧实现逐项一致。
  const CLAUDE5 = /^claude-(opus|sonnet|haiku|fable)-([5-9]|[1-9][0-9])/;
  const want = (e: any) => (e.provider === 'claude' && !CLAUDE5.test(e.model) ? { ...e, levels: [], bodies: Object.fromEntries(Object.keys(e.bodies).map((k) => [k, null])) } : e);
  for (const e0 of golden.api) {
    const e = want(e0);
    // —— 页面：levels 与 effortRequest（旧页面构建兼容的 extraBody）
    const levels = effortLevels(e.provider, 'api', undefined, e.model);
    items += 1;
    if (JSON.stringify(levels) !== JSON.stringify(e.levels)) { pageLevelBad += 1; note(`页面 levels ${e.provider}/${e.model}: ${JSON.stringify(levels)} ≠ ${JSON.stringify(e.levels)}`); }
    for (const key of ['', ...SCALE]) {
      items += 1;
      const r = effortRequest(e.provider, 'api', e.model, (key || undefined) as Effort | undefined);
      if (stable(r.extraBody ?? null) !== stable(e.bodies[key])) { pageBodyBad += 1; note(`页面 body ${e.provider}/${e.model}/${key || '默认'}: ${stable(r.extraBody ?? null)} ≠ ${stable(e.bodies[key])}`); }
    }
    // —— 主进程：同一个服务、同一个模型名
    const service = cat.byId.get(e.provider);
    const spec = effortWire.resolveEffort(service, e.model);
    items += 1;
    if (JSON.stringify(spec.levels) !== JSON.stringify(e.levels)) { mainLevelBad += 1; note(`主进程 levels ${e.provider}/${e.model}: ${JSON.stringify(spec.levels)} ≠ ${JSON.stringify(e.levels)}`); }
    for (const key of ['', ...SCALE]) {
      items += 1;
      let body: unknown;
      if (key === '') body = effortWire.plan({ service, model: e.model, level: undefined, protocol: service.protocol === 'anthropic' ? 'anthropic' : 'openai' }).fields;
      else if (spec.levels.includes(key)) body = effortWire.wire(spec, key);
      else body = null;
      if (key === '' && body && Object.keys(body as object).length === 0) body = null;
      if (stable(body) !== stable(e.bodies[key])) { mainBodyBad += 1; note(`主进程 body ${e.provider}/${e.model}/${key || '默认'}: ${stable(body)} ≠ ${stable(e.bodies[key])}`); }
    }
  }
  console.log(`  note golden 共 ${golden.api.length} 组（8 家 × 目录模型 × 手输 id），${items} 项对表`);
  eq('页面 effortLevels 与旧实现逐项一致', pageLevelBad, 0);
  eq('页面 effortRequest（含默认档）与旧实现逐项一致', pageBodyBad, 0);
  eq('主进程 resolveEffort 与旧实现逐项一致', mainLevelBad, 0);
  eq('主进程 wire / plan 与旧实现逐项一致', mainBodyBad, 0);
  if (firstBad.length) console.error(`    首批不一致：\n      ${firstBad.join('\n      ')}`);
  // CLI 一侧
  let cliBad = 0;
  for (const e of golden.cli) {
    const levels = effortLevels(e.provider, 'cli', e.driver, e.model);
    if (JSON.stringify(levels) !== JSON.stringify(e.levels)) cliBad += 1;
    for (const key of ['', ...SCALE]) { const r = effortRequest(e.provider, 'cli', e.model, (key || undefined) as Effort | undefined); if ((r.effort ?? null) !== e.flags[key]) cliBad += 1; }
  }
  eq('CLI 一侧（claude-code / claude-compat / codex / ACP / dsh）与旧实现一致', cliBad, 0);
  // 页面与主进程两份实现互相一致（预设里所有模型 × 所有档位）
  let diverge = '';
  for (const s of cat.presets) {
    const ids = new Set<string>([...s.models.map((m: any) => m.id), 'x-unknown-model', 'qwen3.8-max-0902', 'kimi-k3-256k']);
    for (const id of ids) {
      const a = pageResolveEffort(s as ServiceDef, id);
      const b = effortWire.resolveEffort(s, id);
      if (stable(a.levels) !== stable(b.levels) || a.style !== b.style) diverge = `${s.id}/${id}`;
      for (const l of b.levels) if (stable(wireFields(a, l)) !== stable(effortWire.wire(b, l))) diverge = `${s.id}/${id}/${l}`;
    }
  }
  eq('页面与主进程的解析 / 写法对全部预设模型一致', diverge, '');
  // 新服务的写法
  const lv = (provider: string, model: string) => effortWire.resolveEffort(cat.byId.get(provider), model).levels;
  eq('Gemini 4 Argon 低中高', lv('gemini', 'gemini-4-argon'), ['low', 'medium', 'high']);
  eq('Gemini 2.5 Flash 可关', lv('gemini', 'gemini-2.5-flash'), ['off', 'low', 'medium', 'high']);
  eq('Gemini 2.5 Flash 关闭 = reasoning_effort none', effortWire.wire(effortWire.resolveEffort(cat.byId.get('gemini'), 'gemini-2.5-flash'), 'off'), { reasoning_effort: 'none' });
  eq('Grok 4.7 到很高', lv('grok', 'grok-4.7'), ['low', 'medium', 'high', 'xhigh']);
  eq('Grok 4.5 到高', lv('grok', 'grok-4.5'), ['low', 'medium', 'high']);
  eq('Mistral 只有 关闭 / 高', lv('mistral', 'mistral-medium-3-5'), ['off', 'high']);
  eq('Muse 低到很高', lv('meta', 'muse-spark-1.3'), ['low', 'medium', 'high', 'xhigh']);
  eq('Cohere A+ 关闭 / 高', lv('cohere', 'command-a-plus-05-2026'), ['off', 'high']);
  eq('StepFun 5', lv('stepfun', 'step-5-preview'), ['low', 'medium', 'high']);
  eq('MiMo 只有开关', lv('mimo', 'mimo-v2.6-pro'), ['off']);
  eq('MiMo 开关 = thinking.type', [effortWire.wire(effortWire.resolveEffort(cat.byId.get('mimo'), 'mimo-v2.6-pro'), 'off'), effortWire.wire({ style: 'think-switch', levels: ['off'] }, 'low')], [{ thinking: { type: 'disabled' } }, { thinking: { type: 'enabled' } }]);
  eq('文心 / 混元 / 星火 不发任何字段（宁可不调）', ['ernie-5.1', 'hy3', 'spark-x2.5'].map((m, i) => effortWire.resolveEffort(cat.byId.get(['ernie', 'hunyuan', 'spark'][i]), m).levels), [[], [], []]);
  eq('聚合站的未知模型不调（宁可不调也不乱发）', effortWire.resolveEffort(cat.byId.get('openrouter'), 'meta/llama-4').levels, []);
  eq('openrouter 风格：reasoning.effort', [effortWire.wire({ style: 'openrouter', levels: ['low', 'high'] }, 'high'), effortWire.wire({ style: 'openrouter', levels: ['off', 'low'] }, 'off')], [{ reasoning: { effort: 'high' } }, { reasoning: { effort: 'none' } }]);
  // 实时列表（账号级事实）优先于规则
  const liveSpec = { style: 're', levels: ['low', 'high'] };
  eq('实时列表给的档位优先于规则', effortWire.resolveEffort(cat.byId.get('gpt'), 'gpt-6-astra', [{ id: 'gpt-6-astra', effort: liveSpec }]).levels, ['low', 'high']);
  eq('页面一份也一样', pageResolveEffort(cat.byId.get('gpt') as ServiceDef, 'gpt-6-astra', [{ id: 'gpt-6-astra', effort: liveSpec as any }]).levels, ['low', 'high']);
  // 自定义服务：不跑规则，只认模型自己的写法
  const custom = { kind: 'custom', effortRules: [{ match: '.*', effort: 'p' }], effortProfiles: { p: { style: 're', levels: ['low'] } }, models: [{ id: 'm1', effort: { style: 're', levels: ['low', 'high'] } }, { id: 'm2' }] };
  eq('自定义服务按模型自己的写法', effortWire.resolveEffort(custom, 'm1').levels, ['low', 'high']);
  eq('自定义服务没写就不调，不跑规则（防止 ReDoS）', effortWire.resolveEffort(custom, 'm2').levels, []);
  eq('页面的解析同样不跑自定义服务的规则', pageResolveEffort(custom as any, 'm2').levels, []);
}

/* ═══════════════════════════ T-WIRE：适配器（对假服务） ═══════════════════════════ */

section('T-WIRE 适配器：鉴权形态、输出上限、地址、头、体');
{
  const { reg } = newRegistry();
  // 预设的解析（不发请求）
  {
    const r = reg.resolveApi({ driver: 'api', provider: 'gpt', model: 'gpt-6.1-sol', effort: 'high', maxTokens: 32000, messages: [{ role: 'user', content: 'hi' }] });
    ok('GPT 预设：地址、路径、字段', r.ok && r.r.url === 'https://api.openai.com/v1/chat/completions' && r.r.wire.maxTokensField === 'max_completion_tokens' && r.r.maxTokens === 32000, JSON.stringify(r).slice(0, 200));
    eq('GPT 预设：推理字段', r.r.effort.fields, { reasoning_effort: 'high' });
    const c = reg.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-sonnet-5-5', maxTokens: 32000 });
    ok('Claude 预设：Messages 地址、x-api-key、版本头', c.ok && c.r.url === 'https://api.anthropic.com/v1/messages' && c.r.auth.scheme === 'x-api-key' && c.r.wire.anthropicVersion === '2023-06-01', JSON.stringify(c).slice(0, 200));
    eq('Claude 默认档：只要思考摘要', c.r.effort.fields, { thinking: { type: 'adaptive', display: 'summarized' } });
    const small = reg.resolveApi({ driver: 'api', provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b', params: { accountId: 'a'.repeat(32) }, maxTokens: 32000 });
    ok('输出上限被服务的默认上限夹住（Cloudflare 4096）', small.ok && small.r.maxTokens === 4096, JSON.stringify(small).slice(0, 160));
    const ds = reg.resolveApi({ driver: 'api', provider: 'deepseek', model: 'deepseek-flash', maxTokens: 999999 });
    eq('DeepSeek：模型上限 38.4 万，服务默认 3.2 万，取小', ds.r.maxTokens, 32000);
    eq('请求太小时抬到 256', reg.resolveApi({ driver: 'api', provider: 'deepseek', model: 'deepseek-flash', maxTokens: 10 }).r.maxTokens, 256);
    eq('没给上限：取 min(上限, 8192)', reg.resolveApi({ driver: 'api', provider: 'deepseek', model: 'deepseek-flash' }).r.maxTokens, 8192);
    eq('连接测试用服务自己的 testMaxTokens，且不带推理字段', (() => { const t = reg.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, { test: true }); return [t.r.maxTokens, t.r.effort.fields, t.r.messages.length]; })(), [256, {}, 1]);
    const u = reg.resolveApi({ driver: 'api', provider: 'nope', model: 'x' });
    eq('未知服务被拒', [u.ok, u.code], [false, 'UNKNOWN']);
    eq('空模型被拒', reg.resolveApi({ driver: 'api', provider: 'gpt', model: '' }).code, 'MODEL');
    eq('带分号的模型名被拒', reg.resolveApi({ driver: 'api', provider: 'gpt', model: 'a;b' }).code, 'MODEL');
    eq('@ 和 ~ 的模型名可用（Cloudflare / OpenRouter）', [reg.resolveApi({ driver: 'api', provider: 'openrouter', model: '~anthropic/claude-opus-latest' }).ok, reg.resolveApi({ driver: 'api', provider: 'cloudflare', model: '@cf/x/y', params: { accountId: 'b'.repeat(32) } }).ok], [true, true]);
    eq('未知地区被拒（而不是悄悄换一个）', reg.resolveApi({ driver: 'api', provider: 'kimi', endpoint: 'mars', model: 'kimi-k3' }).code, 'ENDPOINT');
    eq('Azure 缺资源名被拒并点名', (() => { const a = reg.resolveApi({ driver: 'api', provider: 'azure', endpoint: 'openai', model: 'my-deploy' }); return [a.code, a.field]; })(), ['ADDRESS', 'resource']);
    // 旧页面构建：只给 baseUrl（用来认地区），推理体用 extraBody
    const legacy = reg.resolveApi({ driver: 'api-openai', provider: 'kimi', baseUrl: 'https://api.moonshot.ai/v1', model: 'kimi-k3', maxTokens: 32000, extraBody: { reasoning_effort: 'max' } });
    ok('旧页面：baseUrl 只用来认地区（国际站），推理档位从 extraBody 反推', legacy.ok && legacy.r.endpoint.id === 'global' && legacy.r.url === 'https://api.moonshot.ai/v1/chat/completions' && legacy.r.effort.level === 'max', JSON.stringify(legacy).slice(0, 200));
    const forged = reg.resolveApi({ driver: 'api-openai', provider: 'claude', baseUrl: 'https://evil.example/v1', model: 'claude-sonnet-5-5', extraBody: { thinking: { type: 'enabled' }, injected: 1, reasoning_effort: 'high' } });
    ok('伪造的 baseUrl 不生效（回到注册表的地址）', forged.ok && forged.r.url === 'https://api.anthropic.com/v1/messages' && forged.r.host === 'api.anthropic.com');
    ok('伪造的 extraBody 不生效（没有对应档位就不发）', forged.ok && !('injected' in forged.r.effort.fields) && !('reasoning_effort' in forged.r.effort.fields) && stable(forged.r.effort.fields) === stable({ thinking: { type: 'adaptive', display: 'summarized' } }), JSON.stringify(forged.r.effort));
    // 每个非套餐端点都能解析出一个过 checkBaseUrl 的地址
    let badResolve = '';
    for (const s of servicesMod.catalog().presets) for (const e of s.endpoints) {
      if (e.kind === 'plan' || !e.baseUrl) continue;
      const params: Record<string, string> = {};
      for (const p of e.params ?? []) params[p.name] = p.name === 'accountId' ? 'c'.repeat(32) : p.name === 'region' ? 'us-east-1' : 'my-res';
      const m = (e.models?.[0] ?? s.models[0])?.id ?? 'some-model';
      const x = reg.resolveApi({ driver: 'api', provider: s.id, endpoint: e.id, params, model: m });
      if (!x.ok || !net.checkBaseUrl(x.r.url.replace(/\/(chat\/completions|v1\/messages|messages)$/, ''))) badResolve = `${s.id}/${e.id}: ${x.error}`;
    }
    eq('所有按量 / 本机端点都能解析出合法地址', badResolve, '');
  }

  // —— 对假服务发请求 ——
  await withFake({ script: 'openai-ok' }, async (fake) => {
    const scheme = async (auth: Record<string, unknown>, key: string) => {
      const id = await addFake(reg, fake, { name: `鉴权 ${Math.random().toString(36).slice(2, 7)}`, auth });
      fake.reset();
      const r = await runApi(reg, { provider: id, model: 'fake-model' }, { key });
      return { r, h: fake.requests[0]?.headers ?? {} };
    };
    let t = await scheme({ scheme: 'bearer' }, 'sk-fake-bearer-key');
    ok('bearer：Authorization: Bearer', t.h.authorization === 'Bearer sk-fake-bearer-key' && !t.h['x-api-key'] && t.r.result?.text === '你好，阁下。', JSON.stringify(t.h));
    t = await scheme({ scheme: 'x-api-key' }, 'sk-fake-xkey-key');
    ok('x-api-key', t.h['x-api-key'] === 'sk-fake-xkey-key' && !t.h.authorization);
    t = await scheme({ scheme: 'api-key' }, 'sk-fake-apik-key');
    ok('api-key（Azure / MiMo 的写法）', t.h['api-key'] === 'sk-fake-apik-key' && !t.h.authorization);
    t = await scheme({ scheme: 'header', header: 'x-goog-api-key' }, 'sk-fake-goog-key');
    ok('自定义头名 x-goog-api-key', t.h['x-goog-api-key'] === 'sk-fake-goog-key' && !t.h.authorization);
    t = await scheme({ scheme: 'both' }, 'sk-fake-both-key');
    ok('both：x-api-key 与 Bearer 同发', t.h['x-api-key'] === 'sk-fake-both-key' && t.h.authorization === 'Bearer sk-fake-both-key');
    t = await scheme({ scheme: 'bearer', keyOptional: true }, '');
    ok('keyOptional 且没存密钥：不发任何鉴权头，照样能聊', !t.h.authorization && !t.h['x-api-key'] && !t.h['api-key'] && t.r.result?.text === '你好，阁下。');
    t = await scheme({ scheme: 'bearer', keyOptional: true }, 'k');
    ok('keyOptional 但存了密钥：照常发', t.h.authorization === 'Bearer k');
    t = await scheme({ scheme: 'none' }, 'sk-ignored-key-123');
    ok('scheme none：即使传了密钥也不发', !t.h.authorization && !t.h['x-api-key']);

    // 请求体
    const id = await addFake(reg, fake, { name: '请求体' });
    fake.reset();
    await runApi(reg, { provider: id, model: 'fake-model', system: '你是遐蝶。', messages: [{ role: 'user', content: '甲' }, { role: 'assistant', content: '乙' }, { role: 'user', content: '丙' }], maxTokens: 3000 }, { key: 'sk-fake-body-key-1' });
    const body = fake.requests[0].body;
    eq('openai 体：model / messages / stream', [body.model, body.stream, body.messages.map((m: any) => m.role)], ['fake-model', true, ['system', 'user', 'assistant', 'user']]);
    ok('openai 体：stream_options.include_usage 与输出上限字段', body.stream_options?.include_usage === true && body.max_tokens === 3000 && !('max_completion_tokens' in body));
    ok('不发 temperature / top_p', !('temperature' in body) && !('top_p' in body));
    eq('path 与 content-type', [fake.requests[0].path, fake.requests[0].headers['content-type'], fake.requests[0].headers.accept], ['/v1/chat/completions', 'application/json', 'text/event-stream']);

    // 输出上限字段
    const fieldOf = async (wire: Record<string, unknown>, script?: string, spec: Record<string, unknown> = {}) => {
      const sid = await addFake(reg, fake, { name: `字段 ${Math.random().toString(36).slice(2, 7)}`, wire: { maxTokensField: 'max_tokens', defaultMaxOut: 32000, testMaxTokens: 128, ...wire } });
      fake.script = script || 'openai-ok';
      fake.reset();
      const r = await runApi(reg, { provider: sid, model: 'fake-model', maxTokens: 5000, ...spec }, { key: 'sk-fake-field-key-1' });
      return { r, reqs: fake.requests.map((q: any) => ({ ...q.body })) };
    };
    let f = await fieldOf({ maxTokensField: 'max_completion_tokens' });
    ok('maxTokensField = max_completion_tokens', 'max_completion_tokens' in f.reqs[0] && !('max_tokens' in f.reqs[0]));
    f = await fieldOf({ maxTokensField: 'auto' }, 'reject-max-tokens');
    ok('auto：先发 max_tokens，服务点名 max_completion_tokens 就换字段重发一次', f.reqs.length === 2 && 'max_tokens' in f.reqs[0] && 'max_completion_tokens' in f.reqs[1] && !('max_tokens' in f.reqs[1]) && !!f.r.result, JSON.stringify(f.reqs.map((q: any) => Object.keys(q))));
    ok('换字段重试发了一条 notice', f.r.events.some((e: any) => e.type === 'notice' && /max_completion_tokens/.test(e.text)), JSON.stringify(f.r.events.filter((e: any) => e.type === 'notice')));
    f = await fieldOf({ maxTokensField: 'max_tokens' }, 'reject-max-tokens');
    ok('明确写了 max_tokens 的服务不会自作主张换字段（报 PARAM）', f.reqs.length === 1 && f.r.error?.code === 'PARAM', `${f.reqs.length} ${f.r.error?.code}`);
    f = await fieldOf({ maxTokensField: 'max_completion_tokens' }, 'reject-max-completion-tokens');
    ok('明确写了 max_completion_tokens 也一样', f.reqs.length === 1 && f.r.error?.code === 'PARAM');
    f = await fieldOf({ maxTokensField: 'auto', defaultMaxOut: 32000 }, 'reject-big-max', { maxTokens: 20000 });
    ok('输出上限太大 → 改 8192 重发一次', f.reqs.length === 2 && f.reqs[0].max_tokens === 20000 && f.reqs[1].max_tokens === 8192 && !!f.r.result, JSON.stringify(f.reqs.map((q: any) => q.max_tokens)));
    f = await fieldOf({ streamUsage: 'none' });
    ok('streamUsage none：不发 stream_options', !('stream_options' in f.reqs[0]));
    f = await fieldOf({}, 'reject-stream-options');
    ok('服务拒绝 stream_options → 去掉重发一次，并说明', f.reqs.length === 2 && 'stream_options' in f.reqs[0] && !('stream_options' in f.reqs[1]) && f.r.events.some((e: any) => e.type === 'notice' && /stream_options/.test(e.text)));
    // dropFields 与 extraBody
    const withExtra = await addFake(reg, fake, { name: '额外体', wire: { maxTokensField: 'max_tokens', dropFields: ['presence_penalty'], defaultMaxOut: 8000 }, extraBody: { presence_penalty: 0.5, seed: 7, reasoning_format: 'parsed', reasoning_effort: 'low' }, models: [{ id: 'fake-model', effort: { style: 're', levels: ['low', 'high'] } }] });
    fake.script = 'openai-ok'; fake.reset();
    await runApi(reg, { provider: withExtra, model: 'fake-model', effort: 'high' }, { key: 'sk-fake-extra-key-1' });
    const eb = fake.requests[0].body;
    ok('extraBody 并入、dropFields 丢掉、推理字段赢', eb.seed === 7 && eb.reasoning_format === 'parsed' && !('presence_penalty' in eb) && eb.reasoning_effort === 'high', JSON.stringify(eb));
    // 静态头、chatPath
    const hdr = await addFake(reg, fake, { name: '静态头', headers: { 'X-Title': 'Alight', 'HTTP-Referer': 'https://alight.example' }, endpoints: [{ id: 'main', label: '根', kind: 'local', baseUrl: fake.origin }], wire: { chatPath: '/v1/chat/completions', maxTokensField: 'max_tokens', defaultMaxOut: 4096, testMaxTokens: 128 } });
    fake.reset();
    await runApi(reg, { provider: hdr, model: 'fake-model' }, { key: 'sk-fake-hdr-key-12' });
    ok('静态头原样带上，鉴权头仍由 auth 决定', fake.requests[0].headers['x-title'] === 'Alight' && fake.requests[0].headers['http-referer'] === 'https://alight.example' && fake.requests[0].headers.authorization === 'Bearer sk-fake-hdr-key-12');
    eq('chatPath 生效（LiteLLM 的 baseUrl 不带 /v1）', fake.requests[0].path, '/v1/chat/completions');

    // Anthropic 协议
    fake.script = 'anthropic-ok';
    const an = await addFake(reg, fake, { name: '安索', protocol: 'anthropic', auth: { scheme: 'x-api-key', keyOptional: true } });
    fake.reset();
    const ar = await runApi(reg, { provider: an, model: 'fake-model', system: '系统', maxTokens: 777 }, { key: 'sk-ant-fake-key-123' });
    const ah = fake.requests[0];
    ok('anthropic：/v1 结尾的地址 → /messages', ah.path === '/v1/messages', ah.path);
    ok('anthropic：x-api-key 与 anthropic-version 2023-06-01', ah.headers['x-api-key'] === 'sk-ant-fake-key-123' && ah.headers['anthropic-version'] === '2023-06-01' && !ah.headers.authorization);
    ok('anthropic：体里有 max_tokens / system / stream，没有 stream_options', ah.body.max_tokens === 777 && ah.body.system === '系统' && ah.body.stream === true && !('stream_options' in ah.body));
    eq('anthropic：文本、用量', [textOf(ar.events, 'text'), ar.events.find((e: any) => e.type === 'usage')?.input], ['你好，阁下。', 12]);
    const anRoot = await addFake(reg, fake, { name: '安索根', protocol: 'anthropic', endpoints: [{ id: 'main', label: '根', kind: 'local', baseUrl: fake.origin }], auth: { scheme: 'both', keyOptional: true }, wire: { anthropicVersion: '2026-10-21', defaultMaxOut: 4096, testMaxTokens: 128 } });
    fake.reset();
    await runApi(reg, { provider: anRoot, model: 'fake-model' }, { key: 'sk-ant-fake-key-456' });
    ok('anthropic：不带 /v1 的根 → /v1/messages；both 两个头；版本头可配', fake.requests[0].path === '/v1/messages' && fake.requests[0].headers['x-api-key'] === 'sk-ant-fake-key-456' && fake.requests[0].headers.authorization === 'Bearer sk-ant-fake-key-456' && fake.requests[0].headers['anthropic-version'] === '2026-10-21');
    fake.script = 'anthropic-thinking';
    fake.reset();
    const at = await runApi(reg, { provider: an, model: 'fake-model' }, { key: 'sk-ant-fake-key-123' });
    eq('anthropic：thinking_delta 进 thinking', [textOf(at.events, 'thinking'), textOf(at.events, 'text')], ['想一下。', '好的。']);
    fake.script = 'anthropic-error';
    const ae = await runApi(reg, { provider: an, model: 'fake-model' }, { key: 'sk-ant-fake-key-123' });
    ok('anthropic：错误事件 → error', ae.error?.code === 'overloaded_error' && ae.events.some((e: any) => e.type === 'error'));
    // 错误码分类
    const codeOf = async (script: string) => { fake.script = script; const sid = await addFake(reg, fake, { name: `码 ${script}` }); return (await runApi(reg, { provider: sid, model: 'fake-model' }, { key: 'sk-fake-code-key-1' })).error?.code; };
    eq('错误码：401 AUTH / 403 AUTH_SCOPE / 404 NOT_FOUND / 402 与 429 QUOTA / 500 SERVER', [await codeOf('echo-key-error'), await codeOf('status-403'), await codeOf('status-404'), await codeOf('status-402'), await codeOf('status-429'), await codeOf('status-500')], ['AUTH', 'AUTH_SCOPE', 'NOT_FOUND', 'QUOTA', 'QUOTA', 'SERVER']);
    eq('错误码：400 点名模型 MODEL / 其他 PARAM', [await codeOf('status-400-model'), await codeOf('status-400-param')], ['MODEL', 'PARAM']);
  });
}

/* ═══════════════════════════ I8：首发 8 家的请求逐项不变 ═══════════════════════════ */

section('I8 首发 8 家 × 地区 × 模型 × 档位：新解析出的请求 = 旧页面构建会发的请求（地址、体、头）');
{
  const { reg } = newRegistry();
  type Old = { protocol: 'openai' | 'anthropic'; regions: Array<[string, string]>; models: string[] };
  // 首发版本 providers.ts 里的地区与模型（套餐通道 Qwen coding 等不再允许直连 API，所以不在表里）
  const OLD: Record<string, Old> = {
    claude: { protocol: 'anthropic', regions: [['global', 'https://api.anthropic.com']], models: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-5-5'] },
    gpt: { protocol: 'openai', regions: [['global', 'https://api.openai.com/v1']], models: ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna'] },
    deepseek: { protocol: 'openai', regions: [['cn', 'https://api.deepseek.com']], models: ['deepseek-flash', 'deepseek-v4-pro'] },
    kimi: { protocol: 'openai', regions: [['cn', 'https://api.moonshot.cn/v1'], ['global', 'https://api.moonshot.ai/v1']], models: ['kimi-k3', 'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6'] },
    qwen: { protocol: 'openai', regions: [['cn', 'https://dashscope.aliyuncs.com/compatible-mode/v1'], ['global', 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1']], models: ['qwen3.7-plus', 'qwen3.8-max', 'qwen3.8-flash'] },
    glm: { protocol: 'openai', regions: [['cn', 'https://open.bigmodel.cn/api/paas/v4'], ['global', 'https://api.z.ai/api/paas/v4']], models: ['glm-5.3', 'glm-5.3-flash'] },
    minimax: { protocol: 'openai', regions: [['cn', 'https://api.minimax.cn/v1'], ['global', 'https://api.minimax.io/v1']], models: ['MiniMax-M3', 'MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M2.5'] },
    doubao: { protocol: 'openai', regions: [['cn', 'https://ark.cn-beijing.volces.com/api/v3']], models: ['doubao-seed-2-1-pro-260915', 'doubao-seed-2-1-lite-260915', 'doubao-seed-evolving'] },
  };
  const COMPLETION = new Set(['gpt', 'kimi', 'qwen', 'minimax']);
  const msgs = [{ role: 'user', content: '你好' }, { role: 'assistant', content: '在' }, { role: 'user', content: '继续' }];
  let n = 0; let bad = 0; const first: string[] = [];
  for (const [provider, o] of Object.entries(OLD)) for (const [region, baseUrl] of o.regions) for (const model of o.models) {
    const levels = [undefined, ...effortLevels(provider, 'api', undefined, model)] as Array<Effort | undefined>;
    for (const level of levels) {
      n += 1;
      const maxTokens = level === 'off' ? 8192 : 32000;
      const extraBody = effortRequest(provider, 'api', model, level).extraBody;
      // —— 首发版本的页面会发的 spec，和它的主进程会发的东西 ——
      const spec = { driver: o.protocol === 'anthropic' ? 'api-anthropic' : 'api-openai', provider, baseUrl, model, system: '系统提示', messages: msgs, maxTokens, extraBody };
      const oldBody: Record<string, unknown> = o.protocol === 'anthropic'
        ? { model, max_tokens: maxTokens, stream: true, messages: msgs.map((m) => ({ role: m.role, content: m.content })), system: '系统提示', ...(extraBody ?? {}) }
        : { model, messages: [{ role: 'system', content: '系统提示' }, ...msgs], stream: true, stream_options: { include_usage: true }, [COMPLETION.has(provider) ? 'max_completion_tokens' : 'max_tokens']: maxTokens, ...(extraBody ?? {}) };
      const oldUrl = o.protocol === 'anthropic' ? `${baseUrl}/v1/messages` : `${baseUrl}/chat/completions`;
      // —— 新主进程：旧页面构建的 spec（只给 baseUrl 与 extraBody）和新页面构建的 spec（只给 id 与档位）都要得到同样的东西 ——
      const viaOld = reg.resolveApi(spec);
      const viaNew = reg.resolveApi({ driver: 'api', provider, endpoint: region, model, effort: level, system: '系统提示', messages: msgs, maxTokens });
      for (const [label, res] of [['旧页面', viaOld], ['新页面', viaNew]] as const) {
        const body = res.ok ? (o.protocol === 'anthropic' ? api.buildAnthropicBody(res.r) : api.buildOpenAIBody(res.r)) : null;
        const same = res.ok && res.r.url === oldUrl && stable(body) === stable(oldBody);
        const hdr = res.ok ? api.buildHeaders(res.r, 'KEY', o.protocol === 'anthropic' ? { 'anthropic-version': res.r.wire.anthropicVersion } : {}) : {};
        const headersSame = res.ok && (o.protocol === 'anthropic' ? hdr['x-api-key'] === 'KEY' && hdr['anthropic-version'] === '2023-06-01' && !hdr.authorization : hdr.authorization === 'Bearer KEY' && !hdr['x-api-key']);
        if (!same || !headersSame) { bad += 1; if (first.length < 4) first.push(`${label} ${provider}/${region}/${model}/${level ?? '默认'}: ${res.ok ? `${res.r.url} ${stable(body)}` : res.error}\n        旧: ${oldUrl} ${stable(oldBody)}`); }
      }
    }
  }
  console.log(`  note 共 ${n} 个组合 × 两种页面构建`);
  eq('请求地址、请求体、鉴权头与首发版本逐项一致（含推理字段、输出上限字段）', bad, 0);
  if (first.length) console.error(`      ${first.join('\n      ')}`);
}

/* ═══════════════════════════ T-DIAL：方言 ═══════════════════════════ */

section('T-DIAL 方言：思考位置、Mistral 数组、保活行、结束判定');
await withFake({}, async (fake) => {
  const { reg } = newRegistry();
  const mk1 = async (wire: Record<string, unknown> = {}, name = '方言') => addFake(reg, fake, { name: `${name}${Math.random().toString(36).slice(2, 6)}`, wire: { maxTokensField: 'max_tokens', defaultMaxOut: 4096, testMaxTokens: 128, ...wire } });
  const run = async (script: string, wire: Record<string, unknown> = {}) => { fake.script = script; fake.reset(); const id = await mk1(wire); return runApi(reg, { provider: id, model: 'fake-model' }, { key: 'sk-fake-dial-key-1' }); };

  let r = await run('openai-reasoning-content');
  eq('reasoning_content → thinking，正文是 content', [textOf(r.events, 'thinking'), textOf(r.events, 'text')], ['先想一想。再想一想。', '答案是 42。']);
  r = await run('openai-reasoning');
  eq('reasoning（OpenRouter / Ollama 式）→ thinking', [textOf(r.events, 'thinking'), textOf(r.events, 'text')], ['先想一想。再想一想。', '答案是 42。']);
  r = await run('openai-think-tag');
  eq('<think> 标签（切在 delta 中间）→ thinking，标签不进正文', [textOf(r.events, 'thinking'), textOf(r.events, 'text')], ['内心独白', '正文在这里。']);
  r = await run('openai-think-tag', { thinkIn: ['reasoning_content'] });
  ok('thinkIn 不含 think-tag：<think> 当普通正文', /<think>/.test(textOf(r.events, 'text')) && textOf(r.events, 'thinking') === '', textOf(r.events, 'text'));
  r = await run('openai-reasoning-details');
  eq('默认 thinkIn 不含 reasoning_details：忽略它，正文不丢', [textOf(r.events, 'thinking'), textOf(r.events, 'text')], ['', '结论。']);
  r = await run('openai-reasoning-details', { thinkIn: ['reasoning_details', 'reasoning', 'reasoning_content', 'think-tag'] });
  eq('thinkIn 含 reasoning_details：text / summary 都读到', [textOf(r.events, 'thinking'), textOf(r.events, 'text')], ['细节一。摘要二。', '结论。']);
  // OpenRouter 同一段思考同时给 reasoning 和 reasoning_details：不能说两遍
  fake.script = (_req: any, res: any) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const d = (delta: any, fin?: string) => res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: fin ?? null }] })}\n\n`);
    d({ reasoning: '同一段', reasoning_details: [{ type: 'reasoning.text', text: '同一段' }] });
    d({ content: '好' }); d({}, 'stop'); res.write('data: [DONE]\n\n'); res.end();
  };
  fake.reset();
  const dupId = await mk1({ thinkIn: ['reasoning_details', 'reasoning', 'reasoning_content', 'think-tag'] });
  r = await runApi(reg, { provider: dupId, model: 'fake-model' }, { key: 'sk-fake-dial-key-1' });
  eq('同一段思考出现在两个字段：只算一次', textOf(r.events, 'thinking'), '同一段');

  // Mistral：content 是数组，正文不能丢
  r = await run('openai-mistral-parts', { contentParts: true, thinkIn: ['content-parts', 'reasoning_content', 'reasoning', 'think-tag'] });
  eq('Mistral 数组 content：thinking 块 → 思考，text 块 → 正文，引用块忽略，纯字符串照常', [textOf(r.events, 'thinking'), textOf(r.events, 'text')], ['思考甲。思考乙。', '正文甲。正文乙。正文丙。']);
  eq('Mistral：done.text 是完整正文', r.events.find((e: any) => e.type === 'done')?.text, '正文甲。正文乙。正文丙。');
  r = await run('openai-mistral-parts');
  eq('没开 contentParts 的服务遇到数组也照样解析（绝不因为不是字符串就丢）', textOf(r.events, 'text'), '正文甲。正文乙。正文丙。');
  r = await run('openai-comment-lines');
  eq(': keepalive 注释行被忽略', textOf(r.events, 'text'), '甲乙');
  r = await run('openai-no-finish');
  ok('没有 finish_reason 也没有 [DONE]：EINCOMPLETE', r.error?.code === 'EINCOMPLETE', r.error?.code);
  ok('EINCOMPLETE 时已收到的文本还在事件里', textOf(r.events, 'text') === '说到一半');
  r = await run('openai-done-only');
  ok('只有 [DONE]、已有正文：算完成', !r.error && r.result?.text === '完整的话。' && r.result?.stopReason === 'stop', JSON.stringify(r.error?.message));
  r = await run('openai-ok');
  const usage = r.events.find((e: any) => e.type === 'usage');
  eq('用量：prompt / completion / cached_tokens', [usage?.input, usage?.output, usage?.cached], [11, 5, 2]);
});

/* ═══════════════════════════ T-RETRY：重试与降级 ═══════════════════════════ */

section('T-RETRY 重试与降级');
await withFake({ rejectEfforts: ['max'] }, async (fake) => {
  const { reg } = newRegistry();
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const id = await addFake(reg, fake, { name: '强度', wire: { maxTokensField: 'max_tokens', defaultMaxOut: 8000, testMaxTokens: 128 }, models: [{ id: 'fake-model', effort: { style: 're', levels } }, { id: 'with-off', effort: { style: 're', levels: ['off', ...levels], offWire: 'none' } }] });
  const go = async (spec: Record<string, unknown>) => { fake.reset(); return runApi(reg, { provider: id, model: 'fake-model', ...spec }, { key: 'sk-fake-retry-key-1' }); };

  fake.script = 'reject-effort';
  let r = await go({ effort: 'high' });
  ok('接受的档位：一次成功，体里是 reasoning_effort', fake.requests.length === 1 && fake.requests[0].body.reasoning_effort === 'high' && !r.error);
  r = await go({ effort: 'max' });
  eq('服务拒绝 max → 降一档（xhigh）重发一次', fake.requests.map((q: any) => q.body.reasoning_effort), ['max', 'xhigh']);
  ok('降档重试发了说明', r.events.some((e: any) => e.type === 'notice' && /最高/.test(e.text) && /很高/.test(e.text)), JSON.stringify(r.events.filter((e: any) => e.type === 'notice')));
  ok('降档后成功', !r.error && r.result?.text === '你好，阁下。');
  fake.script = 'reject-effort';
  fake.reset();
  // 两档都拒绝：只降一次，然后报错（每种重试最多一次）
  await withFake({ rejectEfforts: ['max', 'xhigh'], script: 'reject-effort' }, async (f2) => {
    const sid = await addFake(reg, f2, { name: '强度二', wire: { maxTokensField: 'max_tokens', defaultMaxOut: 8000, testMaxTokens: 128 }, models: [{ id: 'fake-model', effort: { style: 're', levels } }] });
    const rr = await runApi(reg, { provider: sid, model: 'fake-model', effort: 'max' }, { key: 'sk-fake-retry-key-1' });
    ok('降一档仍被拒：不再重试，报 PARAM 并带服务的话', f2.requests.length === 2 && rr.error?.code === 'PARAM' && /reasoning_effort/.test(rr.error.message), `${f2.requests.length} ${rr.error?.code} ${rr.error?.message}`);
  });
  // 关闭思考失败不重试（意思相反）
  await withFake({ script: 'reject-all-effort' }, async (f3) => {
    const sid = await addFake(reg, f3, { name: '强度三', wire: { maxTokensField: 'max_tokens', defaultMaxOut: 8000, testMaxTokens: 128 }, models: [{ id: 'with-off', effort: { style: 're', levels: ['off', 'low', 'high'], offWire: 'none' } }] });
    const rr = await runApi(reg, { provider: sid, model: 'with-off', effort: 'off' }, { key: 'sk-fake-retry-key-1' });
    ok('off 被拒：不重试，直接报错', f3.requests.length === 1 && f3.requests[0].body.reasoning_effort === 'none' && !!rr.error, `${f3.requests.length}`);
    f3.reset();
    const rd = await runApi(reg, { provider: sid, model: 'with-off' }, { key: 'sk-fake-retry-key-1' });
    ok('选「默认」：不发任何推理字段', !rd.error && !('reasoning_effort' in f3.requests[0].body) && !('thinking' in f3.requests[0].body));
  });
  // 页面选的档位模型没有：向下取最近一档并告诉用户
  fake.script = 'openai-ok';
  const lowOnly = await addFake(reg, fake, { name: '低高', wire: { maxTokensField: 'max_tokens', defaultMaxOut: 8000, testMaxTokens: 128 }, models: [{ id: 'fake-model', effort: { style: 're', levels: ['low', 'high'] } }, { id: 'none-model' }] });
  fake.reset();
  r = await runApi(reg, { provider: lowOnly, model: 'fake-model', effort: 'medium' }, { key: 'sk-fake-retry-key-1' });
  ok('档位不在列表里：「中」降为「低」，体里是 low，并有说明', fake.requests[0].body.reasoning_effort === 'low' && r.events.some((e: any) => e.type === 'notice' && e.text === '这个模型没有「中」，按「低」执行。'), JSON.stringify(r.events.filter((e: any) => e.type === 'notice')));
  fake.reset();
  r = await runApi(reg, { provider: lowOnly, model: 'fake-model', effort: 'max' }, { key: 'sk-fake-retry-key-1' });
  eq('比最高档还高：取最高档', fake.requests[0].body.reasoning_effort, 'high');
  fake.reset();
  r = await runApi(reg, { provider: lowOnly, model: 'none-model', effort: 'high' }, { key: 'sk-fake-retry-key-1' });
  ok('模型不能调：不发字段，说明一句', !('reasoning_effort' in fake.requests[0].body) && r.events.some((e: any) => e.type === 'notice' && /不能调节/.test(e.text)));
  // 两种不同的重试可以叠加，但总共最多两次
  let n = 0;
  fake.script = (req: any, res: any) => {
    n += 1;
    const b = req.body;
    if (n === 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'stream_options not supported' } })); }
    if (n === 2) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens'." } })); }
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `bad reasoning_effort ${b.reasoning_effort}` } }));
  };
  const auto = await addFake(reg, fake, { name: '叠加', wire: { maxTokensField: 'auto', defaultMaxOut: 8000, testMaxTokens: 128 }, models: [{ id: 'fake-model', effort: { style: 're', levels } }] });
  fake.reset();
  r = await runApi(reg, { provider: auto, model: 'fake-model', effort: 'high' }, { key: 'sk-fake-retry-key-1' });
  ok('总共最多两次重试：第三个 400 直接报错', fake.requests.length === 3 && r.error?.code === 'PARAM', `${fake.requests.length} ${r.error?.code}`);
});

/* ═══════════════════════════ T-SEC：密钥与脱敏、svc:save 模糊测试 ═══════════════════════════ */

section('T-SEC 密钥槽位、旧槽回落、删除清槽、脱敏');
{
  const { reg, dir } = newRegistry();
  secrets.configure(reg.secretsConfig());
  const slotOk = (s: string) => secrets.isValidSlot(s);
  eq('槽位：合法的', ['claude', 'kimi', 'kimi:cn', 'qwen:coding', 'minimax:plan-global'].map(slotOk), [true, true, true, true, true]);
  eq('槽位：__proto__ / constructor / a:b:c / 超长 / 大写 / 未知端点 / 不分槽的端点 / 空', ['__proto__', 'constructor', 'claude:a:b', 'x'.repeat(33), 'Claude', 'kimi:mars', 'claude:global', '', ':cn', 'toString', 'hasOwnProperty'].map(slotOk), Array(11).fill(false));
  const keyFile = path.join(keyDir, 'model-keys.json');
  await secrets.save('claude', 'sk-ant-fake-aaaa-1111');
  eq('get 往返；没存过的是 null；未知 / __proto__ 是 null', [await secrets.get('claude'), await secrets.get('gpt'), await secrets.get('__proto__'), await secrets.get('constructor')], ['sk-ant-fake-aaaa-1111', null, null, null]);
  eq('hints 只含已存的、认识的槽', secrets.hints(), { claude: '••••1111' });
  let threw = 0;
  for (const bad of ['__proto__', 'kimi:mars', 'claude:global', 'nope', 'a:b:c']) { try { await secrets.save(bad, 'sk-fake-should-not-save'); } catch { threw += 1; } }
  eq('保存到非法槽一律抛错', threw, 5);
  ok('非法槽没有污染文件', !/__proto__|mars|nope/.test(fs.readFileSync(keyFile, 'utf8')));
  // 长度：keyOptional 放宽到 1，普通服务 8，keyMin 自定义
  await withFake({}, async (fake) => {
    const opt = await addFake(reg, fake, { name: '可空密钥', auth: { scheme: 'bearer', keyOptional: true } });
    const strict = await addFake(reg, fake, { name: '十二位', auth: { scheme: 'bearer', keyMin: 12 } });
    await secrets.save(opt, 'k');
    eq('keyOptional 的服务一位密钥也行', await secrets.get(opt), 'k');
    let short = false; try { await secrets.save('gpt', 'short'); } catch { short = true; }
    ok('普通服务短于 8 位被拒', short);
    short = false; try { await secrets.save(strict, 'elevenchars'); } catch { short = true; }
    ok('keyMin=12 的服务 11 位被拒', short);
    await secrets.save(strict, 'twelve-chars');
    eq('keyMin=12 的服务 12 位可存', await secrets.get(strict), 'twelve-chars');
    let space = false; try { await secrets.save('gpt', 'sk-has space-inside'); } catch { space = true; }
    ok('含空白的被拒', space);
  });
  // 国内 / 国际 / 套餐各自的槽，旧单槽按绑定回落（§11.3）
  {
    const kimi = reg.get('kimi');
    const cn = reg.endpointOf(kimi, 'cn');
    const gl = reg.endpointOf(kimi, 'global');
    await secrets.save('kimi', 'sk-legacy-kimi-key-1');
    eq('没有绑定时：国内读不到旧槽（不会悄悄拿别的地区的密钥）', await reg.readKey(kimi, cn), null);
    const mig = await reg.migrate({ regions: { kimi: 'cn', claude: 'global' } });
    eq('migrate：只给「有旧槽且该端点分槽」的服务记绑定', mig.value.bound, ['kimi']);
    eq('绑定的那个地区回落旧槽', await reg.readKey(kimi, cn), 'sk-legacy-kimi-key-1');
    eq('另一个地区仍然读不到', await reg.readKey(kimi, gl), null);
    await secrets.save('kimi:global', 'sk-new-kimi-global-1');
    eq('国际读自己的槽', await reg.readKey(kimi, gl), 'sk-new-kimi-global-1');
    eq('国内仍是旧槽（新槽优先，没有才回落）', await reg.readKey(kimi, cn), 'sk-legacy-kimi-key-1');
    const hints = secrets.hints();
    eq('页面一侧按地区挑提示：国内 = 旧槽，国际 = 新槽，套餐没有', [keyHintFor(serviceOf('kimi'), 'cn', hints, { kimi: 'cn' }), keyHintFor(serviceOf('kimi'), 'global', hints, { kimi: 'cn' }), keyHintFor(serviceOf('kimi'), 'code', hints, { kimi: 'cn' })], [hints.kimi, hints['kimi:global'], undefined]);
    for (const s of reg.slotsToClear(kimi, cn)) secrets.clear(s);
    reg.dropBinding(kimi, cn);
    eq('清掉国内：旧槽与绑定一起没了', [await reg.readKey(kimi, cn), reg.bindingOf('kimi'), await secrets.get('kimi')], [null, undefined, null]);
    eq('国际的不受影响', await reg.readKey(kimi, gl), 'sk-new-kimi-global-1');
    secrets.clear('kimi:global');
    const ms = await reg.migrate({ regions: { kimi: 'cn' } });
    eq('旧槽没了就不会再绑定（迁移幂等）', ms.value.bound, []);
  }
  // 删除服务：所有槽、置顶、记录一起清
  await withFake({ script: 'openai-ok' }, async (fake) => {
    const sid = await addFake(reg, fake, { name: '将删除', endpoints: [{ id: 'a', label: 'A', kind: 'local', baseUrl: fake.baseUrl, separateKey: true }, { id: 'b', label: 'B', kind: 'local', baseUrl: fake.baseUrl, separateKey: true }] });
    await secrets.save(sid, 'key-for-the-service-1'); await secrets.save(`${sid}:a`, 'key-for-the-a-slot-1'); await secrets.save(`${sid}:b`, 'key-for-the-b-slot-1');
    reg.pin(sid, 'fake-model', true);
    const r = reg.removeService(sid);
    eq('删除：清了 3 个槽', r.value?.clearedSlots, 3);
    ok('删除之后 hints 里没有它的槽，服务不在列表里，置顶也没了', !Object.keys(secrets.hints()).some((k) => k.startsWith(sid)) && !reg.get(sid) && reg.pinnedOf(sid).length === 0);
    ok('删除之后两个文件里都没有它的内容（services.json 只留下「已删除」的 id 记录）', (() => { const f = JSON.parse(fs.readFileSync(reg.userFile(), 'utf8')); return !f.services.some((s: any) => s.id === sid) && !(sid in f.pinned) && !(sid in f.keyBindings) && !(sid in f.confirmed) && !(sid in f.overrides) && f.retired.includes(sid); })() && !fs.readFileSync(keyFile, 'utf8').includes(`"${sid}`));
    eq('预设不能删', reg.removeService('claude').ok, false);
    eq('不存在的不能删', reg.removeService('x_nothing').ok, false);
    // 同名重建：不复用已删除服务的 id（任务里还指着旧 id，不能悄悄落到另一个服务上），也不会继承旧密钥
    const again = await addFake(reg, fake, { name: '将删除' });
    eq('同名重建：拿到新的 id，没有旧密钥', [again !== sid, await secrets.get(again), await secrets.get(sid)], [true, null, null]);
    const reuse = await reg.saveService(fakeDef(fake, { name: '偷用旧 id', id: sid }), { confirm: yes });
    ok('显式要求用已删除服务的 id：被拒', !reuse.ok && /已删除/.test(reuse.error ?? ''), JSON.stringify(reuse));
    ok('已删除的 id 记在 services.json 里（重启后仍然不复用）', JSON.parse(fs.readFileSync(reg.userFile(), 'utf8')).retired.includes(sid));
    reg.removeService(again);
  });
  // 脱敏：服务回显密钥（HTTP 错误体、流式文本里被切成两段）
  await withFake({}, async (fake) => {
    const id = await addFake(reg, fake, { name: '回显' });
    const key = 'sk-fake-echo-SECRET-9999-abcdef';
    fake.script = 'echo-key-error';
    let r = await runApi(reg, { provider: id, model: 'fake-model' }, { key });
    ok('HTTP 错误体回显密钥：页面事件里没有密钥原文', !JSON.stringify(r.events).includes(key) && !String(r.error?.message).includes(key), JSON.stringify(r.events).slice(0, 200));
    ok('且错误仍然可读（带 ••••）', /••••/.test(String(r.error?.message)) && r.error?.code === 'AUTH', String(r.error?.message));
    fake.script = 'echo-key-stream';
    r = await runApi(reg, { provider: id, model: 'fake-model' }, { key });
    const shown = textOf(r.events, 'text');
    ok('流式文本把密钥切成两段：拼起来也没有', !shown.includes(key) && !JSON.stringify(r.events).includes(key) && /••••/.test(shown), shown);
    fake.script = 'anthropic-http-401';
    const an = await addFake(reg, fake, { name: '安索回显', protocol: 'anthropic', auth: { scheme: 'x-api-key' } });
    r = await runApi(reg, { provider: an, model: 'fake-model' }, { key });
    ok('Anthropic 协议同样脱敏', !JSON.stringify(r.events).includes(key) && !String(r.error?.message).includes(key));
  });
  ok('services.json 里没有任何保存过的密钥', (() => { const t = fs.readFileSync(reg.userFile(), 'utf8'); return !/sk-fake|sk-legacy|sk-new|twelve-chars|key-for-the/.test(t); })());
  void dir;
}

section('T-SEC svc:save 模糊测试：一律 { ok:false }，磁盘与注册表不变');
await withFake({}, async (fake) => {
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  await addFake(reg, fake, { name: '基准服务' });
  const file = reg.userFile();
  const snapshot = () => fs.readFileSync(file, 'utf8');
  const base = () => fakeDef(fake, { name: '待测' });
  const ep = (e: Record<string, unknown>) => ({ endpoints: [{ id: 'main', label: '端点', kind: 'payg', baseUrl: 'https://relay.example.com/v1', ...e }] });
  const many = (n: number, make: (i: number) => any): any[] => Array.from({ length: n }, (_, i) => make(i));
  const bads: Array<[string, any]> = [
    ['字符串', 'oops'], ['null', null], ['数组', [1, 2]], ['空对象', {}],
    ['名称超长', { ...base(), name: 'x'.repeat(41) }], ['名称含控制字符', { ...base(), name: 'a\u0000b' }], ['名称不是文字', { ...base(), name: { a: 1 } }], ['名称为空', { ...base(), name: '' }],
    ['地址 http 非回环', { ...base(), ...ep({ baseUrl: 'http://relay.example.com/v1' }) }], ['地址是局域网 http', { ...base(), ...ep({ kind: 'local', baseUrl: 'http://192.168.1.9:11434/v1' }) }],
    ['地址带凭据', { ...base(), ...ep({ baseUrl: 'https://u:p@relay.example.com/v1' }) }], ['地址带查询串', { ...base(), ...ep({ baseUrl: 'https://relay.example.com/v1?key=1' }) }],
    ['地址是元数据服务', { ...base(), ...ep({ baseUrl: 'https://169.254.169.254/v1' }) }], ['地址是 file:', { ...base(), ...ep({ baseUrl: 'file:///c:/x' }) }],
    ['local 端点用 https', { ...base(), ...ep({ kind: 'local' }) }], ['payg 端点用回环 http', { ...base(), ...ep({ kind: 'payg', baseUrl: 'http://127.0.0.1:1/v1' }) }],
    ['端点没有任何地址', { ...base(), endpoints: [{ id: 'main', label: '空', kind: 'payg' }] }], ['端点 9 个', { ...base(), endpoints: many(9, (i) => ({ id: `e${i}`, label: 'e', kind: 'payg', baseUrl: 'https://relay.example.com/v1' })) }],
    ['端点 id 重复', { ...base(), endpoints: [{ id: 'a', label: 'a', kind: 'payg', baseUrl: 'https://relay.example.com/v1' }, { id: 'a', label: 'b', kind: 'payg', baseUrl: 'https://relay.example.com/v2' }] }],
    ['占位符正则接受点', { ...base(), ...ep({ baseUrl: 'https://{r}.relay.example.com/v1', params: [{ name: 'r', label: 'r', pattern: '^[a-z.]+$' }] }) }],
    ['占位符正则不合法', { ...base(), ...ep({ baseUrl: 'https://{r}.relay.example.com/v1', params: [{ name: 'r', label: 'r', pattern: '(' }] }) }],
    ['占位符占满注册域', { ...base(), ...ep({ baseUrl: 'https://relay.{r}/v1', params: [{ name: 'r', label: 'r', pattern: '^[a-z]+$' }] }) }],
    ['协议 converse', { ...base(), protocol: 'converse' }], ['协议 gemini', { ...base(), protocol: 'gemini' }], ['协议 openai-responses', { ...base(), protocol: 'openai-responses' }], ['协议乱写', { ...base(), protocol: 'soap' }],
    ['id 与预设冲突', { ...base(), id: 'claude' }], ['id 不以 x_ 开头', { ...base(), id: 'mine' }], ['id 含大写', { ...base(), id: 'x_ABC' }], ['id 太长', { ...base(), id: `x_${'a'.repeat(31)}` }],
    ['模型为空', { ...base(), models: [] }], ['模型 501 个', { ...base(), models: many(501, (i) => ({ id: `m${i}` })) }], ['模型 id 含空格', { ...base(), models: [{ id: 'a b' }] }],
    ['模型 id 重复', { ...base(), models: [{ id: 'm' }, { id: 'm' }] }], ['模型 id 含分号', { ...base(), models: [{ id: 'a;rm -rf' }] }], ['模型上下文不是整数', { ...base(), models: [{ id: 'm', ctx: 1.5 }] }],
    ['模型强度档案不存在', { ...base(), models: [{ id: 'm', effort: 'nope' }] }], ['模型强度风格乱写', { ...base(), models: [{ id: 'm', effort: { style: 'evil', levels: ['low'] } }] }],
    ['模型强度档位乱写', { ...base(), models: [{ id: 'm', effort: { style: 're', levels: ['mega'] } }] }], ['re 风格能关却没写 offWire', { ...base(), models: [{ id: 'm', effort: { style: 're', levels: ['off', 'low'] } }] }],
    ['头名含空格', { ...base(), headers: { 'Bad Header': 'x' } }], ['头里放 Authorization', { ...base(), headers: { Authorization: 'x' } }], ['头里放 Host', { ...base(), headers: { Host: 'evil' } }],
    ['头里放 User-Agent', { ...base(), headers: { 'User-Agent': 'x' } }], ['头值含换行', { ...base(), headers: { 'X-A': 'a\r\nb: c' } }], ['头超过 8 项', { ...base(), headers: Object.fromEntries(many(9, (i) => [`X-H${i}`, 'v'])) }],
    ['extraBody 含 model', { ...base(), extraBody: { model: 'evil' } }], ['extraBody 含 tools', { ...base(), extraBody: { tools: [] } }], ['extraBody 超 4 KB', { ...base(), extraBody: Object.fromEntries(many(25, (i) => [`k${i}`, 'v'.repeat(190)])) }],
    ['extraBody 嵌套 5 层', { ...base(), extraBody: { a: { b: { c: { d: { e: 1 } } } } } }], ['extraBody 不是对象', { ...base(), extraBody: [1] }],
    ['dropFields 丢 messages', { ...base(), wire: { dropFields: ['messages'] } }], ['dropFields 大写', { ...base(), wire: { dropFields: ['Stop'] } }], ['chatPath 含 ..', { ...base(), wire: { chatPath: '/v1/../x' } }],
    ['chatPath 不以 / 开头', { ...base(), wire: { chatPath: 'v1/chat' } }], ['maxTokensField 乱写', { ...base(), wire: { maxTokensField: 'max' } }], ['自定义服务设默认思考', { ...base(), wire: { defaultThinking: { type: 'adaptive', display: 'summarized' } } }],
    ['自定义服务写 effortRules', { ...base(), effortRules: [{ match: '.*', effort: 'p' }] }], ['鉴权 header 缺头名', { ...base(), auth: { scheme: 'header' } }], ['鉴权头名是 Host', { ...base(), auth: { scheme: 'header', header: 'Host' } }],
    ['鉴权 none + 非本机', { ...base(), ...ep({}), auth: { scheme: 'none' } }], ['keyOptional + 非本机', { ...base(), ...ep({}), auth: { scheme: 'bearer', keyOptional: true } }], ['鉴权方案乱写', { ...base(), auth: { scheme: 'ntlm' } }],
    ['驱动含 codex', { ...base(), drivers: ['codex'] }], ['驱动含不存在的代理', { ...base(), drivers: ['acp:nope'] }], ['claude-compat 却没有 compatUrl', { ...base(), ...ep({}), drivers: ['claude-compat'] }],
    ['glyph 太长', { ...base(), glyph: 'abc' }], ['group 乱写', { ...base(), group: 'moon' }], ['hidden 不是布尔', { ...base(), hidden: 'yes' }], ['verified 不是日期', { ...base(), verified: 'today' }],
    ['keyUrl 不是 https', { ...base(), keyUrl: 'http://x.example.com' }], ['modelsApi 解析器乱写', { ...base(), modelsApi: { path: '/models', parser: 'evil', auth: 'none' } }],
    ['modelsApi 路径含 ..', { ...base(), modelsApi: { path: '/../etc', parser: 'openai', auth: 'none' } }], ['整个对象超过 64 KB', { ...base(), keyHelp: 'x'.repeat(100), aliases: many(20, () => 'y'.repeat(40)), models: many(500, (i) => ({ id: `m${i}`, note: 'n'.repeat(120), label: 'l'.repeat(80) })) }],
  ];
  let wrong = 0;
  const wrongNames: string[] = [];
  const before = snapshot();
  for (const [name, def] of bads) {
    const r = await reg.saveService(def, { confirm: yes });
    if (r.ok || typeof r.error !== 'string') { wrong += 1; wrongNames.push(name); }
  }
  eq(`${bads.length} 个畸形 / 恶意配置全部被拒`, [wrong, wrongNames], [0, []]);
  ok('磁盘上的 services.json 一字未动', snapshot() === before);
  eq('注册表里仍然只有那一个自定义服务', reg.snapshot().custom.map((s: any) => s.name), ['基准服务']);
  // 通过的配置：只留已知字段、不污染原型
  const polluted = JSON.parse(`{"name":"带脏字段","evil":1,"__proto__":{"polluted":true},"endpoints":[{"id":"main","label":"本机","kind":"local","baseUrl":${JSON.stringify(fake.baseUrl)},"x":1}],"auth":{"scheme":"bearer","keyOptional":true},"models":[{"id":"m1","weird":2}]}`);
  const good = await reg.saveService(polluted, { confirm: yes });
  ok('带脏字段的合法配置被存下，但只留已知字段', good.ok && !('evil' in good.value) && !('x' in good.value.endpoints[0]) && !('weird' in good.value.models[0]) && ({} as any).polluted === undefined, JSON.stringify(good).slice(0, 200));
  ok('id 由名称生成：x_ 开头、≤32 位、不冲突', /^x_[a-z0-9_-]{1,30}$/.test(good.value.id));
  // 数量上限
  let created = 0;
  for (let i = 0; i < 70; i++) { const r = await reg.saveService(fakeDef(fake, { name: `批量${i}` }), { confirm: yes }); if (r.ok) created += 1; else break; }
  eq('自定义服务最多 64 个', reg.snapshot().custom.length, 64);
  ok('第 65 个被拒并说明', !(await reg.saveService(fakeDef(fake, { name: '第六十五' }), { confirm: yes })).ok);
  ok('services.json 不超过 512 KB', fs.statSync(file).size < 512 * 1024, String(fs.statSync(file).size));
  void created;
  // 损坏的文件改名留底，注册表从空开始
  fs.writeFileSync(file, '{not json');
  reg.reload();
  const aside = fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('services.json.corrupt-'));
  ok('损坏的 services.json 改名留底，注册表为空', aside.length === 1 && reg.snapshot().custom.length === 0 && fs.readFileSync(path.join(path.dirname(file), aside[0]), 'utf8') === '{not json');
  const r2 = await reg.saveService(fakeDef(fake, { name: '重新开始' }), { confirm: yes });
  ok('之后可以正常保存', r2.ok);
});

section('T-SEC 换主机要确认（原生对话框，页面按不到）');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  const asked: string[] = [];
  const spy = (answer: boolean) => async (o: any) => { asked.push(o.title); return answer; };
  const def = (host: string, extra: Record<string, unknown> = {}) => ({ name: '中转站', endpoints: [{ id: 'main', label: '中转', kind: 'payg', baseUrl: `https://${host}/v1` }], auth: { scheme: 'bearer' }, models: [{ id: 'gpt-x' }], ...extra });
  const created = await reg.saveService(def('relay-a.example.com'), { confirm: spy(true) });
  ok('新建一个还没存密钥的服务：不弹窗', created.ok && asked.length === 0);
  const id = created.value.id;
  const svc = reg.get(id);
  const ep = svc.endpoints[0];
  eq('第一次存密钥前确认一次主机', [await reg.confirmKeyDestination(svc, ep, spy(false)), asked.length], [false, 1]);
  asked.length = 0;
  eq('用户同意之后记下，再存不再问', [await reg.confirmKeyDestination(svc, ep, spy(true)), await reg.confirmKeyDestination(svc, ep, spy(false)), asked.length], [true, true, 1]);
  await secrets.save(id, 'sk-relay-key-123456');
  asked.length = 0;
  let r = await reg.saveService({ ...def('relay-b.example.com'), id }, { confirm: spy(false) });
  ok('已存密钥的服务改了主机：弹窗，拒绝就不改', !r.ok && asked.length === 1 && reg.get(id).endpoints[0].baseUrl === 'https://relay-a.example.com/v1', JSON.stringify(r));
  r = await reg.saveService({ ...def('relay-b.example.com'), id }, { confirm: spy(true) });
  ok('同意之后才改', r.ok && reg.get(id).endpoints[0].baseUrl === 'https://relay-b.example.com/v1');
  asked.length = 0;
  r = await reg.saveService({ ...def('relay-b.example.com'), id, name: '中转站改名' }, { confirm: spy(false) });
  ok('主机没变（只改名）：不再问', r.ok && asked.length === 0);
  r = await reg.saveService({ ...def('relay-c.example.com'), id }, {});
  ok('没有确认函数时一律拒绝（不会默认放行）', !r.ok && reg.get(id).endpoints[0].baseUrl === 'https://relay-b.example.com/v1');
  asked.length = 0;
  r = await reg.saveService({ ...def('10.0.0.5'), name: '内网站' }, { confirm: spy(false) });
  ok('内网 https 地址：保存前确认，拒绝就不存', !r.ok && asked[0] === '这是内网地址' && !reg.list().some((s: any) => s.name === '内网站'));
  r = await reg.saveService({ ...def('10.0.0.5'), name: '内网站' }, { confirm: spy(true) });
  ok('同意后可存', r.ok);
  asked.length = 0;
  r = await reg.saveService({ ...def('10.0.0.5'), name: '内网站', id: r.value.id, models: [{ id: 'gpt-y' }] }, { confirm: spy(false) });
  ok('同一个内网主机再改别的字段：不再问', r.ok && asked.length === 0);
  // 预设改地址（svc:override）
  asked.length = 0;
  await secrets.save('deepseek', 'sk-ds-key-1234567');
  let o = await reg.setOverride('deepseek', 'cn', 'https://relay-ds.example.com/v1', { confirm: spy(false) });
  ok('预设已存密钥时换主机：弹窗，拒绝就不改', !o.ok && !reg.overrideOf('deepseek') && asked.length === 1);
  o = await reg.setOverride('deepseek', 'cn', 'https://relay-ds.example.com/v1', { confirm: spy(true) });
  ok('同意后生效，resolveApi 用它', o.ok && reg.resolveApi({ driver: 'api', provider: 'deepseek', model: 'deepseek-flash' }).r.url === 'https://relay-ds.example.com/v1/chat/completions');
  eq('覆盖只对它那个端点生效', reg.resolveApi({ driver: 'api', provider: 'deepseek', endpoint: 'cn', model: 'deepseek-flash' }).r.host, 'relay-ds.example.com');
  asked.length = 0;
  o = await reg.setOverride('deepseek', 'cn', 'https://relay-ds.example.com/v1/', { confirm: spy(false) });
  ok('同一个主机再保存：不再问', o.ok && asked.length === 0);
  for (const [name, url] of [['http 非回环', 'http://relay.example.com/v1'], ['元数据地址', 'https://169.254.169.254/v1'], ['带查询串', 'https://x.example.com/v1?k=1'], ['file:', 'file:///x']] as const) {
    ok(`override 拒绝：${name}`, !(await reg.setOverride('deepseek', 'cn', url, { confirm: yes })).ok);
  }
  ok('override 拒绝套餐端点', !(await reg.setOverride('kimi', 'code', 'https://relay.example.com/v1', { confirm: yes })).ok);
  ok('override 拒绝带占位符的端点', !(await reg.setOverride('azure', 'openai', 'https://relay.example.com/v1', { confirm: yes })).ok);
  ok('override 拒绝本机端点用 https', !(await reg.setOverride('ollama', 'local', 'https://relay.example.com/v1', { confirm: yes })).ok);
  ok('本机端点可以改端口', (await reg.setOverride('ollama', 'local', 'http://127.0.0.1:11500/v1', { confirm: yes })).ok && reg.resolveApi({ driver: 'api', provider: 'ollama', model: 'x' }).r.url === 'http://127.0.0.1:11500/v1/chat/completions');
  ok('非本机端点不能用 http', !(await reg.setOverride('gpt', 'global', 'http://127.0.0.1:1/v1', { confirm: yes })).ok);
  ok('自定义服务不走 override', !(await reg.setOverride(id, 'main', 'https://x.example.com/v1', { confirm: yes })).ok);
  ok('null 恢复默认', (await reg.setOverride('deepseek', 'cn', null)).ok && !reg.overrideOf('deepseek') && reg.resolveApi({ driver: 'api', provider: 'deepseek', model: 'deepseek-flash' }).r.url === 'https://api.deepseek.com/chat/completions');
  // 置顶
  eq('置顶：加、去重、去掉', [reg.pin('gpt', 'gpt-6-luna', true).value, reg.pin('gpt', 'gpt-6-luna', true).value, reg.pin('gpt', 'gpt-6.1-sol', true).value, reg.pin('gpt', 'gpt-6-luna', false).value], [['gpt-6-luna'], ['gpt-6-luna'], ['gpt-6-luna', 'gpt-6.1-sol'], ['gpt-6.1-sol']]);
  ok('置顶拒绝非法模型名与不存在的服务', !reg.pin('gpt', 'a b', true).ok && !reg.pin('nope', 'x', true).ok);
  // 重新加载后仍在
  reg.reload();
  ok('重新加载：自定义服务、置顶、绑定仍在', reg.get(id)?.name === '中转站改名' && reg.pinnedOf('gpt').join() === 'gpt-6.1-sol');
}

/* ═══════════════════════════ T-SEC（审查修复）：地址写法、共用槽、预设改地址、旧槽绑定、套餐地址、推理强度 ═══════════════════════════ */

section('T-SEC 地址写法绕过：存规范化的文本，主机一律从它里面取');
{
  const { reg, dir } = newRegistry();
  secrets.configure(reg.secretsConfig());
  const asked: Array<{ title: string; message: string }> = [];
  const spy = (answer: boolean) => async (o: any) => { asked.push({ title: o.title, message: o.message }); return answer; };
  const def = (url: string, extra: Record<string, unknown> = {}) => ({ name: '写法', endpoints: [{ id: 'main', label: '中转', kind: 'payg', baseUrl: url }], auth: { scheme: 'bearer' }, models: [{ id: 'm' }], ...extra });
  const created = await reg.saveService(def('https://relay-a.example.com/v1'), { confirm: spy(true) });
  const id = created.value.id;
  const svc0 = reg.get(id);
  await reg.confirmKeyDestination(svc0, svc0.endpoints[0], spy(true));
  await secrets.save(id, 'sk-writing-key-1234567');
  const before = () => JSON.stringify(reg.get(id).endpoints);
  const base0 = before();
  asked.length = 0;
  for (const [name, url] of [['前导空格', ' https://evil.example.com/v1'], ['前导 NBSP', ' https://evil.example.com/v1'], ['前导 BOM', '﻿https://evil.example.com/v1'], ['前导全角空格', '　https://evil.example.com/v1'], ['前导零宽空格', '​https://evil.example.com/v1'], ['尾部空格', 'https://evil.example.com/v1 '], ['中间空格', 'https://evil .example.com/v1'], ['制表符', '\thttps://evil.example.com/v1']] as const) {
    const r = await reg.saveService({ ...def(url), id }, { confirm: spy(true) });
    ok(`地址里有空白或不可见字符：${name} → 拒绝，原配置不动`, !r.ok && before() === base0, JSON.stringify(r));
  }
  eq('这些写法在校验这一步就被拒，没有走到确认', asked.length, 0);
  for (const [name, url] of [['大写 scheme 与主机', 'HTTPS://Evil.Example.COM/v1'], ['https:host 省略斜杠', 'https:evil.example.com/v1'], ['带默认端口与结尾斜杠', 'https://evil.example.com:443/v1/']] as const) {
    asked.length = 0;
    const r = await reg.saveService({ ...def(url), id }, { confirm: spy(false) });
    ok(`${name}：照样弹「密钥将发往新的主机」，说的是规范化的主机；拒绝则不改`, !r.ok && asked.length === 1 && asked[0].title === '密钥将发往新的主机' && asked[0].message.includes('evil.example.com') && !/COM|Evil|:443/.test(asked[0].message) && before() === base0, JSON.stringify([r, asked]));
  }
  asked.length = 0;
  const approved = await reg.saveService({ ...def('https:evil.example.com/v1'), id }, { confirm: spy(true) });
  eq('同意后存下的是规范化的文本', [approved.ok, reg.get(id).endpoints[0].baseUrl], [true, 'https://evil.example.com/v1']);
  asked.length = 0;
  const same = await reg.saveService({ ...def('HTTPS://EVIL.example.com:443/v1'), id }, { confirm: spy(false) });
  ok('换一种写法再存同一个主机：认得出是同一个，不再问', same.ok && asked.length === 0 && reg.get(id).endpoints[0].baseUrl === 'https://evil.example.com/v1');
  asked.length = 0;
  const idn = await reg.saveService({ ...def('https://例子.com/v1'), id }, { confirm: spy(false) });
  ok('国际化域名：弹窗显示 punycode 主机（防同形字），不显示原文', !idn.ok && /xn--fsqu00a\.com/.test(asked[0]?.message ?? '') && !/例子/.test(asked[0]?.message ?? ''), JSON.stringify(asked));
  asked.length = 0;
  const priv = await reg.saveService(def('HTTPS://10.0.0.5/v1', { name: '内网写法' }), { confirm: spy(false) });
  ok('大写 scheme 的内网地址：照样弹「这是内网地址」', !priv.ok && asked[0]?.title === '这是内网地址', JSON.stringify([priv, asked]));
  const privSp = await reg.saveService(def(' https://10.0.0.5/v1', { name: '内网空格' }), { confirm: spy(true) });
  ok('带前导空格的内网地址：被拒，没有悄悄存下', !privSp.ok && !reg.list().some((s: any) => s.name === '内网空格'));
  // 带占位符的模板：主机取自模板文本（小写），不是展开后的
  const tplParams = [{ name: 'region', label: '区域', pattern: '^[a-z]+$' }];
  const tplSave = await reg.saveService({ name: '模板', endpoints: [{ id: 'main', label: '模板', kind: 'payg', baseUrl: 'https://{region}.example.com/v1', params: tplParams }], auth: { scheme: 'bearer' }, models: [{ id: 'm' }] }, { confirm: spy(true) });
  const tsvc = tplSave.ok ? reg.get(tplSave.value.id) : null;
  asked.length = 0;
  if (tsvc) await reg.confirmKeyDestination(tsvc, tsvc.endpoints[0], spy(false));
  ok('占位符模板：确认里的主机是模板里的写法', !!tsvc && asked[0]?.message.includes('{region}.example.com'), JSON.stringify([tplSave.ok ? '' : tplSave.error, asked]));
  ok('占位符模板：大写的 scheme 不收（URL 解析器没法替它规范化）', !(await reg.saveService({ name: '模板二', endpoints: [{ id: 'main', label: '模板', kind: 'payg', baseUrl: 'HTTPS://{region}.example.com/v1', params: tplParams }], auth: { scheme: 'bearer' }, models: [{ id: 'm' }] }, { confirm: yes })).ok);
  // 运行时兜底：就算主机记录丢了（文件被改、被清），已存的密钥也不会发往没确认的主机
  const file = path.join(dir, 'services.json');
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  j.confirmed = {};
  fs.writeFileSync(file, JSON.stringify(j));
  reg.reload();
  const s1 = reg.get(id); const e1 = s1.endpoints[0];
  eq('主机记录没了：readKey 拒绝，并说得出是哪个主机', [await reg.readKey(s1, e1), reg.destinationProblem(s1, e1)], [null, 'evil.example.com']);
  eq('重新确认之后才读得出来', [await reg.confirmKeyDestination(s1, e1, spy(true)), await reg.readKey(s1, e1), reg.destinationProblem(s1, e1)], [true, 'sk-writing-key-1234567', '']);
  secrets.clear(id);
}

section('T-SEC 同一个密钥槽覆盖的所有端点，存密钥时一并确认');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  const asked: Array<{ title: string; message: string }> = [];
  const spy = (answer: boolean) => async (o: any) => { asked.push({ title: o.title, message: o.message }); return answer; };
  const mkDef = (name: string, sep: boolean) => ({ name, endpoints: [{ id: 'a', label: 'A', kind: 'payg', baseUrl: 'https://good.example.com/v1', ...(sep ? { separateKey: true } : {}) }, { id: 'b', label: 'B', kind: 'payg', baseUrl: 'https://other.example.net/v1', compatUrl: 'https://compat.example.net/anthropic', ...(sep ? { separateKey: true } : {}) }], auth: { scheme: 'bearer' }, models: [{ id: 'm' }] });
  const created = await reg.saveService(mkDef('共用槽', false), { confirm: spy(true) });
  ok('没有密钥时加端点：不问（问题留到第一把密钥）', created.ok && asked.length === 0);
  const id = created.value.id;
  const svc = reg.get(id); const [A, B] = svc.endpoints;
  eq('两个端点共用一个槽', reg.slotFor(svc, A), reg.slotFor(svc, B));
  eq('存密钥确认一次：名单里是这个槽覆盖的所有端点的所有主机', [await reg.confirmKeyDestination(svc, A, spy(false)), asked.length], [false, 1]);
  ok('对话框里列出了 B 端点的两个主机（不是只有被点名的 A）', ['good.example.com', 'other.example.net', 'compat.example.net'].every((h) => asked[0].message.includes(h)), asked[0].message);
  asked.length = 0;
  eq('同意之后记下全部', [await reg.confirmKeyDestination(svc, A, spy(true)), await reg.confirmKeyDestination(svc, B, spy(false)), asked.length], [true, true, 1]);
  await secrets.save(id, 'sk-shared-slot-key-1');
  eq('两个端点的密钥都读得出来', [await reg.readKey(svc, A), await reg.readKey(svc, B)], ['sk-shared-slot-key-1', 'sk-shared-slot-key-1']);
  // 绕开确认直接写进槽（这是页面按不到的路径，这里只验证请求期的兜底）
  const raw = await reg.saveService(mkDef('绕开确认', false), { confirm: yes });
  const rsvc = reg.get(raw.value.id);
  await secrets.save(raw.value.id, 'sk-no-confirm-key-1');
  eq('没经过确认的主机：readKey 拒绝，resolveApi 仍可解析（错误由调用方说明）', [await reg.readKey(rsvc, rsvc.endpoints[1]), reg.destinationProblem(rsvc, rsvc.endpoints[1]), reg.resolveApi({ driver: 'api', provider: raw.value.id, endpoint: 'b', model: 'm' }).ok], [null, 'other.example.net', true]);
  // 各自有槽的端点：各问各的，没有存密钥的端点读不到别人的
  const sepd = await reg.saveService(mkDef('分槽', true), { confirm: yes });
  const ssvc = reg.get(sepd.value.id); const [SA, SB] = ssvc.endpoints;
  asked.length = 0;
  await reg.confirmKeyDestination(ssvc, SA, spy(true));
  ok('分槽：只问被点名那个端点的主机', asked.length === 1 && asked[0].message.includes('good.example.com') && !asked[0].message.includes('other.example.net'), asked[0]?.message);
  await secrets.save(reg.slotFor(ssvc, SA), 'sk-sepd-a-key-12345');
  eq('分槽：B 端点没有自己的密钥，读不到 A 的', [await reg.readKey(ssvc, SA), await reg.readKey(ssvc, SB)], ['sk-sepd-a-key-12345', null]);
  secrets.clear(id); secrets.clear(raw.value.id); secrets.clear(reg.slotFor(ssvc, SA));
}

section('T-SEC 预设改地址：先改后存、内网地址、套餐地址');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  secrets.clear('deepseek');
  const asked: Array<{ title: string; message: string }> = [];
  const spy = (answer: boolean) => async (o: any) => { asked.push({ title: o.title, message: o.message }); return answer; };
  const svc = reg.get('deepseek'); const ep = reg.endpointOf(svc, 'cn');
  // 页面（被带偏时）先把地址改走，等用户之后存密钥
  const o1 = await reg.setOverride('deepseek', 'cn', 'https://relay-ds2.example.com/v1', { confirm: spy(false) });
  ok('还没存密钥：不问，写下覆盖，但标记为「没人确认过这个主机」', o1.ok && asked.length === 0 && reg.overrideOf('deepseek').confirmedHost === '', JSON.stringify([o1, reg.overrideOf('deepseek')]));
  await secrets.save('deepseek', 'sk-ds-before-confirm-123');
  eq('此时密钥读不出来（不会发往那个主机）', [await reg.readKey(svc, ep), reg.destinationProblem(svc, ep)], [null, 'relay-ds2.example.com']);
  eq('用户在界面里存密钥那一步会被问；拒绝就不存', [await reg.confirmKeyDestination(svc, ep, spy(false)), asked.length, asked[0]?.title], [false, 1, '确认密钥发往的主机']);
  ok('问的是改过的主机，并说原来的主机', /relay-ds2\.example\.com/.test(asked[0].message) && /api\.deepseek\.com/.test(asked[0].message), asked[0].message);
  eq('没有确认函数时拒绝（不会默认放行）', await reg.confirmKeyDestination(svc, ep), false);
  eq('同意之后记下，读得出来', [await reg.confirmKeyDestination(svc, ep, spy(true)), await reg.readKey(svc, ep), reg.overrideOf('deepseek').confirmedHost], [true, 'sk-ds-before-confirm-123', 'relay-ds2.example.com']);
  asked.length = 0;
  eq('再存不再问', [await reg.confirmKeyDestination(svc, ep, spy(false)), asked.length], [true, 0]);
  ok('恢复默认地址：官方主机，密钥照常', (await reg.setOverride('deepseek', 'cn', null)).ok && (await reg.readKey(svc, ep)) === 'sk-ds-before-confirm-123');
  // 内网地址：有没有密钥都要问
  secrets.clear('deepseek');
  asked.length = 0;
  const p1 = await reg.setOverride('deepseek', 'cn', 'https://10.1.2.3/v1', { confirm: spy(false) });
  ok('没有密钥也要为内网地址确认；拒绝就不写', !p1.ok && asked[0]?.title === '这是内网地址' && !reg.overrideOf('deepseek'), JSON.stringify([p1, asked]));
  const p2 = await reg.setOverride('deepseek', 'cn', 'https://localhost:8443/v1', { confirm: spy(true) });
  ok('https 的 localhost 也算内网；同意后记下', p2.ok && reg.overrideOf('deepseek').confirmedHost === 'localhost:8443', JSON.stringify(reg.overrideOf('deepseek')));
  asked.length = 0;
  ok('同一个内网主机再保存：不再问', (await reg.setOverride('deepseek', 'cn', 'https://localhost:8443/v2', { confirm: spy(false) })).ok && asked.length === 0);
  ok('没有确认函数：内网地址一律拒绝', !(await reg.setOverride('deepseek', 'cn', 'https://10.9.9.9/v1', {})).ok);
  await reg.setOverride('deepseek', 'cn', null);
  // 套餐地址不能当 API 地址（预设改地址与迁移同一条规则）
  for (const [id, ep2, url] of [['qwen', 'cn', 'https://coding.dashscope.aliyuncs.com/v1'], ['qwen', 'cn', 'HTTPS://Coding.DashScope.aliyuncs.com/v1/'], ['kimi', 'cn', 'https://api.kimi.com/coding/v1'], ['glm', 'cn', 'https://open.bigmodel.cn/api/coding/paas/v4']] as const) {
    const r = await reg.setOverride(id, ep2, url, { confirm: yes });
    ok(`setOverride 拒绝套餐地址：${id} ← ${url}`, !r.ok && /套餐/.test(r.error ?? '') && !reg.overrideOf(id), JSON.stringify(r));
  }
  ok('套餐地址的子路径也算', !(await reg.setOverride('qwen', 'cn', 'https://coding.dashscope.aliyuncs.com/v1/chat', { confirm: yes })).ok);
  ok('MiniMax 套餐与按量同一地址：不拦', (await reg.setOverride('minimax', 'cn', 'https://api.minimax.cn/v1', { confirm: yes })).ok);
  await reg.setOverride('minimax', 'cn', null);
  const { reg: reg2 } = newRegistry();
  secrets.configure(reg2.secretsConfig());
  const mig = await reg2.migrate({ regions: { qwen: 'cn' }, baseUrls: { qwen: 'https://coding.dashscope.aliyuncs.com/v1' } }, { confirm: yes });
  ok('migrate 带来的套餐地址也被拒（进 rejected，并说明）', mig.value.applied.length === 0 && /套餐/.test(mig.value.rejected[0]?.reason ?? '') && !reg2.overrideOf('qwen'), JSON.stringify(mig));
  // 自定义服务：Anthropic 协议的套餐地址（baseUrl 与 compatUrl，带不带 /v1、带不带斜杠）
  const anth = (name: string, base: string, compat?: string) => ({ name, protocol: 'anthropic', endpoints: [{ id: 'main', label: '中转', kind: 'payg', baseUrl: base, ...(compat ? { compatUrl: compat } : {}) }], auth: { scheme: 'x-api-key' }, models: [{ id: 'm' }] });
  for (const [name, base, compat] of [['Kimi Code 带斜杠', 'https://api.kimi.com/coding/', undefined], ['Kimi Code 不带 v1', 'https://api.kimi.com/coding', undefined], ['Kimi Code 子路径', 'https://api.kimi.com/coding/v1/messages', undefined], ['通义套餐的 Anthropic 地址（compatUrl）', 'https://relay.example.com/v1', 'https://coding.dashscope.aliyuncs.com/apps/anthropic']] as const) {
    const r = await reg.saveService(anth(`套餐${name}`, base, compat), { confirm: yes });
    ok(`自定义服务不能用套餐地址：${name}`, !r.ok && /套餐/.test(r.error ?? ''), JSON.stringify(r));
  }
  ok('智谱的 Anthropic 地址与按量同一个：不拦', (await reg.saveService(anth('智谱中转', 'https://open.bigmodel.cn/api/anthropic'), { confirm: yes })).ok);
}

section('T-SEC 旧单槽的套餐 Key 不能被按量端点读出（GLM / 豆包）');
for (const sid of ['glm', 'doubao']) {
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  secrets.clear(sid); secrets.clear(`${sid}:coding`);
  const PLAN = `PLAN-KEY-${sid}-123456`; const PAYG = `PAYG-KEY-${sid}-123456`;
  await secrets.save(sid, PLAN);
  await reg.migrate({ regions: { [sid]: 'coding' } });
  const svc = reg.get(sid); const cn = reg.endpointOf(svc, 'cn'); const coding = reg.endpointOf(svc, 'coding');
  eq(`${sid}：迁移把旧 Key 绑给套餐`, reg.bindingOf(sid), 'coding');
  eq(`${sid}：按量端点读不到旧槽里的套餐 Key；套餐端点读得到`, [await reg.readKey(svc, cn), await reg.readKey(svc, coding)], [null, PLAN]);
  eq(`${sid}：提示（主进程与页面两份）：按量没有，套餐有`, [reg.keyHintFor(svc, cn, secrets.hints()), reg.keyHintFor(svc, coding, secrets.hints()), keyHintFor(serviceOf(sid), 'cn', secrets.hints(), { [sid]: 'coding' }), keyHintFor(serviceOf(sid), 'coding', secrets.hints(), { [sid]: 'coding' })], [undefined, secrets.hints()[sid], undefined, secrets.hints()[sid]]);
  eq(`${sid}：在按量端点「清除密钥」不会删掉套餐的 Key`, [reg.slotsToClear(svc, cn), reg.slotsToClear(svc, coding)], [[], [`${sid}:coding`, sid]]);
  await saveFor(reg, sid, PAYG, 'cn');
  eq(`${sid}：在按量端点存新 Key：套餐 Key 搬到自己的槽，不被覆盖`, [await secrets.get(`${sid}:coding`), await reg.readKey(svc, cn), await reg.readKey(svc, coding), reg.bindingOf(sid)], [PLAN, PAYG, PLAN, undefined]);
  secrets.clear(sid); secrets.clear(`${sid}:coding`);
}

section('T-EFF（审查修复）：实时能力进主进程、未知的 Claude id 不发 adaptive、400 去思考重试');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  // (a) 无静态规则的服务（OpenRouter）：实时列表给了档位，主进程要用同一份
  const spec = { driver: 'api', provider: 'openrouter', model: 'anthropic/claude-sonnet-5', effort: 'high' };
  const liveList = [{ id: 'anthropic/claude-sonnet-5', effort: { style: 'openrouter', levels: ['off', 'low', 'medium', 'high'] } }];
  const noLive = reg.resolveApi(spec, {});
  const withLive = reg.resolveApi(spec, { live: liveList });
  ok('没有实时列表：无规则的服务不能调，说一句「不能调节」（旧行为）', noLive.ok && Object.keys(noLive.r.effort.fields).length === 0 && noLive.r.notices.some((n: any) => /不能调节/.test(n.text)));
  eq('有实时列表（账号的能力）：请求里带 reasoning.effort，页面菜单与请求一致', [withLive.r.effort.fields, withLive.r.notices.length, effortLevels('openrouter', 'api', undefined, spec.model, undefined, liveList as any)], [{ reasoning: { effort: 'high' } }, 0, ['off', 'low', 'medium', 'high']]);
  // (b) Claude：只有 5 代的 id 发默认的 adaptive thinking；旧模型 / 手填 id 不发
  const claudeFields = (model: string, effort?: string) => reg.resolveApi({ driver: 'api', provider: 'claude', model, effort }, {}).r.effort.fields;
  eq('claude-opus-5-5 默认档：adaptive + 摘要', claudeFields('claude-opus-5-5'), { thinking: { type: 'adaptive', display: 'summarized' } });
  eq('claude-opus-6（以后的新代）同样认得', Object.keys(claudeFields('claude-opus-6')), ['thinking']);
  for (const m of ['claude-sonnet-4-5', 'claude-3-7-sonnet-latest', 'sonnet[1m]', 'qwen-plus', 'claude-haiku-4-5']) eq(`未知 / 旧的 id「${m}」：默认档不发任何思考字段`, [claudeFields(m), claudeFields(m, 'high')], [{}, {}]);
  eq('页面一侧（旧页面兼容的 extraBody）同样：旧 id 没有，5 代有', [effortRequest('claude', 'api', 'claude-sonnet-4-5', undefined), effortRequest('claude', 'api', 'claude-opus-5-5', undefined)], [{}, { extraBody: { thinking: { type: 'adaptive', display: 'summarized' } } }]);
  eq('页面菜单：旧 id 没有档位，5 代有', [effortLevels('claude', 'api', undefined, 'claude-sonnet-4-5'), effortLevels('claude', 'api', undefined, 'claude-opus-5-5')], [[], ['low', 'medium', 'high', 'xhigh', 'max']]);
  const liveClaude = [{ id: 'claude-sonnet-4-5', effort: { style: 'anthropic', levels: ['low', 'medium', 'high'] } }];
  eq('账号的实时能力说它能调：旧 id 也用 live 的档位与 adaptive', reg.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-sonnet-4-5' }, { live: liveClaude }).r.effort.fields, { thinking: { type: 'adaptive', display: 'summarized' } });
  // (c) 400 说 thinking / adaptive：即使是默认档也去掉思考字段重发一次
  const rr = reg.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-opus-5-5', messages: [{ role: 'user', content: '你好' }], maxTokens: 1000 }, {});
  const rejectThinking = (req: any, res: any, ctx: any) => (req.body && req.body.thinking
    ? ctx.json(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'thinking.type.adaptive is not supported for this model' } })
    : ctx.scripts['anthropic-ok'](req, res, ctx));
  for (const [label, level] of [['默认档', undefined], ['选了「高」', 'high']] as const) {
    await withFake({ script: rejectThinking }, async (fake) => {
      const r2 = reg.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-opus-5-5', effort: level, messages: [{ role: 'user', content: '你好' }], maxTokens: 1000 }, {});
      const events: any[] = [];
      let error: any; let result: any;
      try { result = await api.streamAnthropic({ ...r2.r, url: `${fake.origin}/v1/messages` }, 'sk-ant-fake-retry-key-1', (e: any) => events.push(e), new AbortController().signal); } catch (e) { error = e; }
      ok(`${label}：模型不接受 adaptive → 去掉思考字段重发一次，成功`, !error && fake.requests.length === 2 && !!fake.requests[0].body.thinking && !fake.requests[1].body.thinking && !fake.requests[1].body.output_config && !!result?.text, `${error?.message} ${fake.requests.length}`);
      ok(`${label}：发了说明，并说看不到思考摘要`, events.some((e) => e.type === 'notice' && /思考参数/.test(e.text) && /摘要/.test(e.text)), JSON.stringify(events.filter((e) => e.type === 'notice')));
    });
  }
  void rr;
  await withFake({ script: 'anthropic-ok' }, async (fake) => {
    const r3 = reg.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: '你好' }], maxTokens: 1000 }, {});
    await api.streamAnthropic({ ...r3.r, url: `${fake.origin}/v1/messages` }, 'sk-ant-fake-retry-key-1', () => {}, new AbortController().signal);
    ok('旧模型默认档：请求里一开始就没有 thinking 字段', fake.requests.length === 1 && !('thinking' in fake.requests[0].body), JSON.stringify(fake.requests[0]?.body));
  });
  // 400 提到 thinking 但这一档是「关闭思考」：意思相反，不重试
  await withFake({ script: rejectThinking }, async (fake) => {
    const r4 = reg.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'off', messages: [{ role: 'user', content: '你好' }], maxTokens: 1000 }, {});
    let error: any;
    try { await api.streamAnthropic({ ...r4.r, url: `${fake.origin}/v1/messages` }, 'sk-ant-fake-retry-key-1', () => {}, new AbortController().signal); } catch (e) { error = e; }
    ok('「关闭思考」被拒：不重试（意思相反），直接报错', fake.requests.length === 1 && !!error, `${fake.requests.length}`);
  });
}

/* ═══════════════════════════ T-NET：网络规则与本机探测 ═══════════════════════════ */

section('T-NET 重定向、超时、体积上限、本机探测');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  await withFake({ delayMs: 900 }, async (fake) => {
    const id = await addFake(reg, fake, { name: '网络' });
    fake.script = 'redirect-302'; fake.reset();
    let r = await runApi(reg, { provider: id, model: 'fake-model' }, { key: 'sk-fake-net-key-12' });
    ok("redirect:'error'：不跟随，报 EREDIRECT，也没有向重定向目标发过请求", r.error?.code === 'EREDIRECT' && !fake.requests.some((q: any) => q.path.startsWith('/elsewhere')), `${r.error?.code} ${fake.requests.map((q: any) => q.path)}`);
    ok('重定向的错误信息不含密钥', !JSON.stringify(r.events).includes('sk-fake-net-key-12'));
    api.__setLimits({ firstByteMs: 250, idleMs: 300 });
    try {
      fake.script = 'slow-first-byte'; fake.reset();
      const t0 = Date.now();
      r = await runApi(reg, { provider: id, model: 'fake-model' }, { key: 'sk-fake-net-key-12' });
      ok('首字节超时：ETIMEDOUT，很快就报', r.error?.code === 'ETIMEDOUT' && Date.now() - t0 < 800, `${r.error?.code} ${Date.now() - t0}ms`);
      fake.script = 'idle'; fake.reset();
      r = await runApi(reg, { provider: id, model: 'fake-model' }, { key: 'sk-fake-net-key-12' });
      ok('空闲超时：EIDLE，已收到的文本还在', r.error?.code === 'EIDLE' && textOf(r.events, 'text') === '开头', `${r.error?.code} ${textOf(r.events, 'text')}`);
    } finally { api.__setLimits(); }
    // 停止：流进行中 abort
    fake.script = 'openai-slow-stream'; fake.reset();
    const rr = reg.resolveApi({ driver: 'api', provider: id, model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] });
    const ac = new AbortController();
    const evs: any[] = [];
    const p = api.streamOpenAI(rr.r, 'sk-fake-net-key-12', (e: any) => { evs.push(e); if (evs.length === 1) ac.abort(); }, ac.signal).catch((e: any) => e);
    const res = await p;
    ok('停止：流进行中 abort 得到 ABORTED', res?.code === 'ABORTED', JSON.stringify(res?.code ?? res));
    // 非流式（列表、探测）：体积与时间上限
    const huge = await net.fetchLimited(`${fake.origin}/huge`, {}, { maxBytes: 8 * 1024 * 1024 }).catch((e: any) => e);
    eq('超过 8 MB 的响应体：放弃（ETOOBIG）', huge.code, 'ETOOBIG');
    const slow = await net.fetchLimited(`${fake.origin}/slow`, {}, { timeoutMs: 200 }).catch((e: any) => e);
    eq('非流式超时：ETIMEDOUT', slow.code, 'ETIMEDOUT');
    const redir = await net.fetchLimited(`${fake.origin}/redirect`, {}, {}).catch((e: any) => e);
    eq('非流式也不跟随重定向', redir.code, 'EREDIRECT');
    const small = await net.fetchLimited(`${fake.origin}/v1/models`, {}, {});
    ok('小响应正常：状态、文本、JSON', small.ok && small.status === 200 && small.json?.object === 'list' && small.text.length > 10);
    const nf = await net.fetchLimited(`${fake.origin}/nothing-here`, {}, {});
    ok('404 不抛错，由调用方看状态', !nf.ok && nf.status === 404);
    const refused = await net.fetchLimited('http://127.0.0.1:1/', {}, { timeoutMs: 1000 }).catch((e: any) => e);
    ok('连不上：ECONNREFUSED 之类的短代码', typeof refused.code === 'string' && /ECONN|EADDR|ENET|EPERM|ETIMEDOUT|ENOTFOUND/.test(refused.code), refused.code);
    eq('纯 Node 下传输层是 node fetch', net.transportName(), 'node');
  });

  // 本机探测
  const mkList = (models: any) => startFake({ models });
  const closed = await startFake(); const closedPort = closed.port; await closed.close();
  const olla = await mkList({ '/api/tags': { models: [{ name: 'qwen3:32b' }, { name: 'llama3.2:3b' }] } });
  const vllm = await mkList({ '/v1/models': { object: 'list', data: [{ id: 'meta/llama-3' }, { id: 'bad id with space' }, { id: 7 }] } });
  const html = await mkList({ '/v1/models': '<html><body>dev server</body></html>' });
  const badShape = await mkList({ '/v1/models': { object: 'list', data: 'nope' } });
  const notList = await mkList({ '/v1/models': { hello: 'world' } });
  const empty = await mkList({ '/v1/models': { object: 'list', data: [] } });
  try {
    const found = await reg.probeLocal({ candidates: [
      { service: 'ollama', endpoint: 'local', port: olla.port, paths: ['/api/tags', '/v1/models'] },
      { service: 'vllm', endpoint: 'local', port: vllm.port, paths: ['/v1/models'] },
      { service: 'llamacpp', endpoint: 'local', port: html.port, paths: ['/v1/models'] },
      { service: 'jan', endpoint: 'local', port: badShape.port, paths: ['/v1/models'] },
      { service: 'litellm', endpoint: 'local', port: notList.port, paths: ['/v1/models'] },
      { service: 'lmstudio', endpoint: 'local', port: closedPort, paths: ['/v1/models'] },
      { service: 'dmr', endpoint: 'local', port: empty.port, paths: ['/v1/models'] },
    ] });
    eq('只有真正的模型列表才算命中（HTML、形状不对、连不上都不算；空列表算服务在）', found.map((f: any) => f.service), ['ollama', 'vllm', 'dmr']);
    eq('Ollama 的 /api/tags 形状；模型名过 id 规则（坏名字丢掉）', [found[0].models, found[1].models, found[2].models], [['qwen3:32b', 'llama3.2:3b'], ['meta/llama-3'], []]);
    const all = [...olla.requests, ...vllm.requests, ...html.requests];
    ok('探测只发 GET，不带任何凭据 / cookie', all.length > 0 && all.every((q: any) => q.method === 'GET' && !q.headers.authorization && !q.headers.cookie && !q.headers['x-api-key']));
    eq('候选端口来自本机预设（Ollama / LM Studio / llama.cpp×2 / vLLM / Jan / LiteLLM / Docker）', reg.localCandidates().map((c: any) => c.port).sort((a: number, b: number) => a - b), [1234, 1337, 4000, 8000, 8080, 9931, 11434, 12434]);
    eq('Ollama 先试 /api/tags，其余只试 /v1/models', [reg.localCandidates().find((c: any) => c.port === 11434).paths, reg.localCandidates().find((c: any) => c.port === 1234).paths], [['/api/tags', '/v1/models'], ['/v1/models']]);
    eq('modelIdsFromList 对非列表返回 null', [reg.modelIdsFromList(null), reg.modelIdsFromList('x'), reg.modelIdsFromList({ object: 'list' }), reg.modelIdsFromList({ models: [{ nope: 1 }] }), reg.modelIdsFromList({ object: 'list', data: [{ id: 'a' }] })], [null, null, null, null, ['a']]);
  } finally { await Promise.all([olla, vllm, html, badShape, notList, empty].map((f) => f.close())); }
}

/* ═══════════════════════════ T-PLAN：套餐通道（I4） ═══════════════════════════ */

section('T-PLAN 套餐通道：API 直连一律拒绝');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  let n = 0; let apiBad = ''; let pageBad = ''; let compatBad = '';
  for (const s of servicesMod.catalog().presets) for (const e of s.endpoints) {
    if (e.kind !== 'plan') continue;
    n += 1;
    const x = reg.resolveApi({ driver: 'api', provider: s.id, endpoint: e.id, model: (e.models?.[0] ?? s.models[0])?.id ?? 'some-model' });
    if (x.ok || x.code !== 'PLAN_KEY') apiBad = `${s.id}/${e.id}`;
    const info = PROVIDER_BY_ID[s.id];
    const cfg = { ...defaultProviderConfig(info), region: e.id, keyHint: '••••abcd', model: 'some-model' };
    const rd = readiness(info, cfg, 'api');
    if (rd.ready || !/套餐/.test(rd.reason ?? '')) pageBad = `${s.id}/${e.id}`;
    if (e.compatUrl && s.drivers.includes('claude-compat')) { const c = reg.resolveCompat({ provider: s.id, endpoint: e.id, model: (e.models?.[0] ?? s.models[0])?.id ?? 'some-model' }); if (!c.ok) compatBad = `${s.id}/${e.id}: ${c.error}`; }
  }
  console.log(`  note 共 ${n} 个套餐端点`);
  ok('套餐端点不少于 12 个', n >= 12, String(n));
  eq('主进程：每个套餐端点的 resolveApi 都是 PLAN_KEY', apiBad, '');
  eq('页面：每个套餐端点的 readiness(api) 都是「改用命令行」', pageBad, '');
  eq('同一个套餐端点走命令行方式（claude-compat）是允许的', compatBad, '');
  eq('只有套餐端点的服务（星火），不带 endpoint 也是 PLAN_KEY', reg.resolveApi({ driver: 'api', provider: 'spark', model: 'spark-x2.5' }).code, 'PLAN_KEY');
  eq('伪造的地区 id 也拒绝（不会因为页面说「coding」就放行）', reg.resolveApi({ driver: 'api', provider: 'qwen', endpoint: 'coding', model: 'qwen3.7-plus' }).code, 'PLAN_KEY');
  eq('legacy 页面只给 baseUrl（Coding Plan 的地址）也是 PLAN_KEY', reg.resolveApi({ driver: 'api-openai', provider: 'qwen', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', model: 'qwen3.7-plus' }).code, 'PLAN_KEY');
  const g = gradeOf(serviceOf('kimi'), { endpoint: 'code', keySaved: true, levels: [] });
  ok('兼容小标：套餐端点「聊天」灰显并说明原因', g.chat === false && /命令行/.test(g.why.chat ?? ''));
  // 自定义服务不能把厂商的套餐地址存成 API 服务
  const defAt = (url: string, name: string) => ({ name, endpoints: [{ id: 'main', label: '中转', kind: 'payg', baseUrl: url }], auth: { scheme: 'bearer' }, models: [{ id: 'm' }] });
  for (const [name, url] of [['通义 Coding Plan', 'https://coding.dashscope.aliyuncs.com/v1'], ['同上带斜杠大写', 'HTTPS://Coding.DashScope.aliyuncs.com/v1/'], ['Kimi Code', 'https://api.kimi.com/coding/v1'], ['智谱 Coding', 'https://open.bigmodel.cn/api/coding/paas/v4']] as const) {
    const r = await reg.saveService(defAt(url, `套餐${name}`), { confirm: yes });
    ok(`自定义服务不能用套餐地址：${name}`, !r.ok && /套餐/.test(r.error ?? ''), JSON.stringify(r));
  }
  ok('MiniMax 的 M Plan 与按量同一地址：不拦（无法区分）', (await reg.saveService(defAt('https://api.minimax.cn/v1', '极简中转'), { confirm: yes })).ok);
  ok('普通地址不受影响', (await reg.saveService(defAt('https://relay.example.com/v1', '普通中转'), { confirm: yes })).ok);
}

/* ═══════════════════════════ T-MIG：迁移 ═══════════════════════════ */

section('T-MIG 旧配置迁移');
{
  const old8 = ['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'doubao'];
  const oldRegions: Record<string, string[]> = { claude: ['global'], gpt: ['global'], deepseek: ['cn'], kimi: ['cn', 'global'], qwen: ['cn', 'global', 'coding'], glm: ['cn', 'global', 'coding'], minimax: ['cn', 'global'], doubao: ['cn', 'coding'] };
  const oldDrivers: Record<string, string[]> = { claude: ['claude-code'], gpt: ['codex'], deepseek: ['dsh', 'claude-compat'], kimi: ['kimi', 'claude-compat'], qwen: ['qwen', 'claude-compat'], glm: ['claude-compat'], minimax: ['mcode', 'claude-compat'], doubao: ['claude-compat'] };
  const saved: any = {
    providers: Object.fromEntries(old8.map((id) => [id, { id, auth: id === 'claude' ? 'cli' : 'api', driver: oldDrivers[id][0], region: oldRegions[id][oldRegions[id].length - 1], baseUrl: '', model: `custom-${id}`, cliModel: '', cliPath: id === 'gpt' ? 'C:/tools/codex.cmd' : '', effort: 'high', cliEffort: 'low' }])),
    defaultEngine: 'kimi',
  };
  saved.providers.kimi.baseUrl = 'https://relay.example.com/v1';
  saved.providers.kimi.driver = 'kimi';
  saved.providers.deepseek.driver = 'claude-compat';
  const restored = restoreModels(saved);
  eq('v 补成 2；customMirror 补成空', [restored.v, restored.customMirror], [2, []]);
  ok('旧 8 家的 id 与字段原样保留（模型、地区、驱动、命令路径、强度）', old8.every((id) => {
    const a = restored.providers[id]; const b = saved.providers[id];
    return a.model === b.model && a.region === b.region && a.driver === b.driver && a.cliPath === b.cliPath && a.effort === b.effort && a.cliEffort === b.cliEffort && a.auth === b.auth;
  }));
  eq('旧的 driver: kimi 原样（已存任务的 engine.driver 不改写）', restored.providers.kimi.driver, 'kimi');
  eq('旧的服务地址留在页面上（镜像主进程的覆盖）', restored.providers.kimi.baseUrl, 'https://relay.example.com/v1');
  eq('默认引擎保留', restored.defaultEngine, 'kimi');
  ok('新预设拿到默认配置（含隐藏的，以后打开不丢）', ['gemini', 'grok', 'ollama', 'openrouter', 'vercel', 'dmr'].every((id) => !!restored.providers[id]) && restored.providers.gemini.model === 'gemini-4-argon');
  const pending = getPendingLegacy();
  eq('待交给主进程的：8 家的地区 + 手填的服务地址', [Object.keys(pending?.regions ?? {}).sort(), pending?.baseUrls], [[...old8].sort(), { kimi: 'https://relay.example.com/v1' }]);
  // 修复：不存在的地区 / 驱动
  const broken: any = { providers: { qwen: { ...saved.providers.qwen, region: 'mars', driver: 'codex' }, deepseek: { ...saved.providers.deepseek, region: 'cn' } } };
  const fixed = restoreModels(broken);
  eq('不存在的地区回到默认端点、不属于它的驱动回到第一个', [fixed.providers.qwen.region, fixed.providers.qwen.driver], ['cn', 'qwen']);
  eq('已经是 v2 且没有手填地址：没有待办', (restoreModels({ ...saved, v: 2, providers: { claude: saved.providers.claude } } as any), getPendingLegacy()), undefined);
  eq('没有任何旧状态：没有待办', (restoreModels(undefined), getPendingLegacy()), undefined);
  // 自定义服务：只存名字 / 徽记 / 分组，主进程没答之前也能显示
  setCustomMirror([{ id: 'x_mine', name: '我的中转', glyph: '我', group: 'hub' }]);
  const withCustom = restoreModels({ providers: { x_mine: { id: 'x_mine', auth: 'api', driver: 'claude-compat', region: 'main', baseUrl: '', model: 'gpt-x', cliModel: '', cliPath: '' } }, defaultEngine: 'x_mine', customMirror: [{ id: 'x_mine', name: '我的中转', glyph: '我', group: 'hub' }] } as any);
  ok('镜像里的自定义服务：配置与默认引擎保留，名字能显示', withCustom.providers.x_mine?.model === 'gpt-x' && withCustom.defaultEngine === 'x_mine' && PROVIDER_BY_ID.x_mine.name === '我的中转');
  setCustomServices([]);
  setCustomMirror([]);
  const gone = restoreModels({ providers: { x_mine: { id: 'x_mine', auth: 'api', driver: 'claude-compat', region: 'main', baseUrl: '', model: 'gpt-x', cliModel: '', cliPath: '' } }, defaultEngine: 'x_mine' } as any);
  eq('服务已不存在：默认引擎回到空，配置被丢弃', [gone.defaultEngine, gone.providers.x_mine], ['', undefined]);
  eq('已删除服务的任务头部读作（已删除）', PROVIDER_BY_ID.x_mine.name, '（已删除）');
  // 回滚：新状态经 JSON 往返后，旧版本的 restoreModels（按 8 个 id 取、不认识的丢掉）不崩、字段不丢
  {
    const wire = JSON.parse(JSON.stringify({ providers: Object.fromEntries(Object.entries(restored.providers).map(([id, c]) => [id, { ...c, keyHint: undefined }])), defaultEngine: restored.defaultEngine, v: restored.v, customMirror: restored.customMirror }));
    const oldRestore = (s: any) => {
      const out: Record<string, any> = {};
      for (const id of old8) {
        const o = s.providers[id];
        if (!o) continue;
        const m = { ...o, id, keyHint: undefined };
        if (!oldDrivers[id].includes(m.driver)) m.driver = oldDrivers[id][0];
        if (!oldRegions[id].includes(m.region)) m.region = oldRegions[id][0];
        out[id] = m;
      }
      return out;
    };
    const back = oldRestore(wire);
    ok('回滚到旧版本：8 家都读得回来，地区与驱动没有被旧规则打回默认', old8.every((id) => back[id].region === restored.providers[id].region && back[id].driver === restored.providers[id].driver && back[id].model === restored.providers[id].model));
  }
  // 主进程这一半：迁移记录落盘，重启后还在，幂等
  {
    const { reg, dir } = newRegistry();
    secrets.configure(reg.secretsConfig());
    await secrets.save('kimi', 'sk-legacy-kimi-key-2');
    const req = { regions: { kimi: 'global', qwen: 'cn', claude: 'global' }, baseUrls: { deepseek: 'https://relay.example.com/v1', gpt: 'http://evil.example.com/v1', nope: 'https://x.example.com', kimi: 'https://api.moonshot.ai/v1' } };
    const asked: string[] = [];
    await secrets.save('deepseek', 'sk-ds-migrate-key-1234');   // 已存密钥的服务换到新主机才要问
    const m1 = await reg.migrate(req, { confirm: async (o: any) => { asked.push(`${o.title}|${o.message}`); return true; } });
    eq('migrate：绑定旧单槽的地区', m1.value.bound, ['kimi']);
    eq('migrate：合法的手填地址被接收', m1.value.applied.sort(), ['deepseek', 'kimi']);
    ok('migrate：已存密钥的服务换到新主机，要先走原生确认（不再有免确认的 trusted 通道）；预设自己的主机不问', asked.length === 1 && /密钥将发往新的主机/.test(asked[0]) && /relay\.example\.com/.test(asked[0]), JSON.stringify(asked));
    eq('migrate：非法地址被拒并说明', m1.value.rejected.map((x: any) => x.id), ['gpt']);
    reg.reload();
    ok('重启后（重新读文件）：绑定与覆盖都在', reg.bindingOf('kimi') === 'global' && reg.overrideOf('deepseek')?.baseUrl === 'https://relay.example.com/v1' && reg.overrideOf('kimi')?.endpoint === 'global');
    eq('确认过的主机记在覆盖里（confirmedHost）', reg.overrideOf('deepseek')?.confirmedHost, 'relay.example.com');
    const m2 = await reg.migrate(req, { confirm: async () => { throw new Error('should not ask'); } });
    eq('第二次调用：主进程记得已经迁移过，什么都不再收（不弹窗）', [m2.value.bound, m2.value.applied, m2.value.rejected, m2.value.done], [[], [], [], true]);
    ok('migrated 标记落了盘', JSON.parse(fs.readFileSync(path.join(dir, 'services.json'), 'utf8')).migrated === true);
    eq('迁移后密钥读取：绑定的地区回落旧槽', await reg.readKey(reg.get('kimi'), reg.endpointOf(reg.get('kimi'), 'global')), 'sk-legacy-kimi-key-2');
    const file = JSON.parse(fs.readFileSync(path.join(dir, 'services.json'), 'utf8'));
    ok('services.json 的形状：v、services、agents、overrides、keyBindings、pinned', file.v === 1 && Array.isArray(file.services) && Array.isArray(file.agents) && typeof file.overrides === 'object' && file.keyBindings.kimi === 'global' && typeof file.pinned === 'object');
    ok('services.json 里没有密钥', !/sk-legacy/.test(JSON.stringify(file)));
    eq('畸形的迁移请求不抛错', await Promise.all([reg.migrate(null), reg.migrate('x'), reg.migrate({ regions: 5, baseUrls: [] }), reg.migrate({ regions: { kimi: {} }, baseUrls: { deepseek: 5 } })]).then((a) => a.map((x: any) => x.ok)), [true, true, true, true]);
  }
  // 页面被带偏时：svc:migrate 是页面能直接调的通道，不能成为改地址、带走密钥的后门
  {
    const { reg } = newRegistry();
    secrets.configure(reg.secretsConfig());
    await secrets.save('claude', 'sk-ant-migrate-attack-1');
    const asked: string[] = [];
    const no = async (o: any) => { asked.push(o.title); return false; };
    const evil = { baseUrls: { claude: 'https://evil.example.com' } };
    // 与 svc:override 同一条规则：已存密钥 → 原生确认，拒绝就不改
    const noDlg = await reg.migrate(evil, {});
    ok('页面传来的地址（已存密钥）：没有确认函数一律不改', noDlg.value.applied.length === 0 && noDlg.value.rejected[0]?.id === 'claude' && !reg.overrideOf('claude'), JSON.stringify(noDlg));
    reg.reload();   // 没有处理成功的请求，但标记已经立起来：之后不再接收地址
    const again = await reg.migrate(evil, { confirm: no });
    eq('处理过一次之后，主进程不再接收页面传来的地址（不弹窗，不改）', [again.value.done, again.value.applied, asked.length, reg.overrideOf('claude')], [true, [], 0, undefined]);
    const r2 = newRegistry().reg;
    secrets.configure(r2.secretsConfig());
    const declined = await r2.migrate(evil, { confirm: no });
    ok('用户在弹窗里拒绝：不改，原因是「已取消」', declined.value.applied.length === 0 && declined.value.rejected[0]?.reason === '已取消' && asked.length === 1 && !r2.overrideOf('claude'), JSON.stringify(declined));
    eq('密钥仍然只去官方地址', r2.resolveApi({ driver: 'api', provider: 'claude', model: 'claude-opus-5-5' }).r.host, 'api.anthropic.com');
    // 没有密钥的服务：写下覆盖，但这个主机还没人确认——之后存密钥要问，问之前密钥不会被读出去
    const r3 = newRegistry().reg;
    secrets.configure(r3.secretsConfig());
    secrets.clear('gpt');
    const quiet = await r3.migrate({ baseUrls: { gpt: 'https://relay-gpt.example.com/v1' } }, { confirm: no });
    ok('没有密钥的服务：写下覆盖，confirmedHost 为空（还没有人确认过这个主机）', quiet.value.applied[0] === 'gpt' && r3.overrideOf('gpt')?.confirmedHost === '', JSON.stringify([quiet, r3.overrideOf('gpt')]));
    await secrets.save('gpt', 'sk-gpt-saved-without-asking-1');
    eq('此时即使密钥在，也不会发往这个未确认的主机（readKey 拒绝）', [r3.destinationProblem(r3.get('gpt'), r3.endpointOf(r3.get('gpt'), 'global')), await r3.readKey(r3.get('gpt'), r3.endpointOf(r3.get('gpt'), 'global'))], ['relay-gpt.example.com', null]);
    const gpt = r3.get('gpt'); const gep = r3.endpointOf(gpt, 'global');
    eq('存密钥的那一步会问（confirmKeyDestination），拒绝则不通', [await r3.confirmKeyDestination(gpt, gep, async () => false), await r3.readKey(gpt, gep)], [false, null]);
    eq('同意之后才读得出来', [await r3.confirmKeyDestination(gpt, gep, yes), await r3.readKey(gpt, gep), r3.overrideOf('gpt').confirmedHost], [true, 'sk-gpt-saved-without-asking-1', 'relay-gpt.example.com']);
    secrets.clear('gpt');
  }
  restoreModels(undefined);
  void initialModels;
}

/* ═══════════════════════════ T-ENV：环境变量与命令行代理 ═══════════════════════════ */

section('T-ENV 环境变量、代理定义、claude-compat');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  for (const n of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'XAI_API_KEY', 'MISTRAL_API_KEY', 'MY_TOOL_TOKEN']) ok(`环境变量名 ${n} 可用`, !validateMod.envNameProblem(n));
  for (const n of ['PATH', 'Path', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_TLS_REJECT_UNAUTHORIZED', 'HTTPS_PROXY', 'http_proxy', 'ALL_PROXY', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'PIP_INDEX_URL', 'GIT_SSH_COMMAND', 'NPM_CONFIG_REGISTRY', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'SSL_CERT_FILE', 'TEMP', 'USERPROFILE', 'COMSPEC', 'PROGRAMFILES(X86)', 'AB', 'X'.repeat(42), 'a-b']) ok(`环境变量名 ${n} 被拒`, !!validateMod.envNameProblem(n));
  for (const v of ['{baseUrl}', 'https://x/{model}/{endpoint}', 'plain']) ok(`环境变量值模板 ${v} 可用`, !validateMod.envValueProblem(v));
  for (const v of ['{evil}', '${HOME}', 'a\nb', 'x'.repeat(2001), 5 as any]) ok(`环境变量值模板 ${JSON.stringify(v).slice(0, 20)} 被拒`, !!validateMod.envValueProblem(v));
  const goodAgent = clone(servicesMod.catalog().agentById.get('qwen'));
  ok('代理定义：合法的通过', validateMod.validateAgent(goodAgent).ok);
  for (const [name, mut] of [
    ['环境变量名在禁用表', (a: any) => { a.binding.env.NODE_OPTIONS = '--require x'; }], ['密钥变量名是 PATH', (a: any) => { a.binding.keyEnv = 'PATH'; }], ['模板里放 {evil}', (a: any) => { a.binding.env.OPENAI_MODEL = '{evil}'; }],
    ['参数含空格', (a: any) => { a.args = ['--x y']; }], ['参数含 &', (a: any) => { a.args = ['a&b']; }], ['参数超过 8 个', (a: any) => { a.args = Array(9).fill('a'); }], ['命令名含路径', (a: any) => { a.bin = ['..\\evil']; }],
    ['id 含大写', (a: any) => { a.id = 'Evil'; }], ['绑定模式乱写', (a: any) => { a.binding.mode = 'shell'; }], ['perm.level 乱写', (a: any) => { a.perm.level = 'trusted'; }],
  ] as Array<[string, (a: any) => void]>) { const a = clone(goodAgent); mut(a); ok(`代理定义被拒：${name}`, !validateMod.validateAgent(a).ok); }

  // 代理环境：来自定义，不来自页面
  const q = reg.resolveAgent({ provider: 'qwen', driver: 'qwen', model: 'qwen3.8-max', env: { PATH: 'C:/evil', NODE_OPTIONS: '--require evil.js', OPENAI_BASE_URL: 'https://evil.example/v1', OPENAI_API_KEY: 'sk-from-page', EXTRA: 'x' }, keyEnv: 'ANTHROPIC_API_KEY' });
  ok('Qwen：环境 = 注册表的地址 + 所选模型；页面的 PATH / NODE_OPTIONS / 地址 / 密钥都不生效', q.ok && stable(q.env) === stable({ OPENAI_BASE_URL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', OPENAI_MODEL: 'qwen3.8-max' }) && q.keyEnv === 'OPENAI_API_KEY' && q.slot === 'qwen:cn' && !q.keyOptional, JSON.stringify(q));
  const qLegacy = reg.resolveAgent({ provider: 'qwen', driver: 'acp', acp: 'qwen', env: { OPENAI_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', OPENAI_MODEL: 'qwen3.7-plus' }, keyEnv: 'OPENAI_API_KEY' });
  ok("旧页面构建（driver:'acp' + acp + env）：用 env 里的地址认出国际站、模型取 OPENAI_MODEL", qLegacy.ok && qLegacy.endpoint.id === 'global' && qLegacy.env.OPENAI_MODEL === 'qwen3.7-plus' && qLegacy.slot === 'qwen:global', JSON.stringify(qLegacy));
  ok('模型缺省时用代理定义的默认', reg.resolveAgent({ provider: 'qwen', driver: 'qwen' }).env.OPENAI_MODEL === 'qwen3.7-plus');
  ok('Kimi / MiniMax 的代理不需要环境', stable(reg.resolveAgent({ provider: 'kimi', driver: 'kimi' }).env) === '{}' && reg.resolveAgent({ provider: 'minimax', driver: 'acp', acp: 'mcode' }).ok);
  ok('新代理 acp:gemini：可选的密钥变量 GEMINI_API_KEY', (() => { const g = reg.resolveAgent({ provider: 'gemini', driver: 'acp:gemini' }); return g.ok && g.keyEnv === 'GEMINI_API_KEY' && g.keyOptional === true && g.slot === 'gemini'; })());
  eq('一家的密钥不会交给另一家的工具', [reg.resolveAgent({ provider: 'doubao', driver: 'qwen' }).ok, reg.resolveAgent({ provider: 'gpt', driver: 'acp:gemini' }).ok, reg.resolveAgent({ provider: 'kimi', driver: 'acp', acp: 'qwen' }).ok], [false, false, false]);
  eq('不存在的代理被拒', [reg.resolveAgent({ provider: 'kimi', driver: 'acp:nope' }).ok, reg.resolveAgent({ provider: 'kimi', driver: 'acp' }).ok], [false, false]);
  eq('hunyuan 的 baseUrl 缺失端点：解析代理环境时点名', reg.resolveAgent({ provider: 'qwen', driver: 'qwen', endpoint: 'mars' }).code, 'ENDPOINT');

  // claude-compat：地址来自注册表，环境由 compat-env 生成
  const c = reg.resolveCompat({ provider: 'kimi', model: 'kimi-k3', env: { ANTHROPIC_BASE_URL: 'https://evil.example/anthropic' } });
  ok('compat：页面给的 ANTHROPIC_BASE_URL 不是目的地（回到注册表的第一个可用端点）', c.ok && c.url === 'https://api.moonshot.cn/anthropic' && c.endpoint.id === 'cn', JSON.stringify(c));
  const cLegacy = reg.resolveCompat({ provider: 'kimi', env: { ANTHROPIC_BASE_URL: 'https://api.moonshot.ai/anthropic', ANTHROPIC_SMALL_FAST_MODEL: 'kimi-k3', ANTHROPIC_MODEL: 'kimi-k3[1m]' } });
  ok('旧页面构建：用 env 里的地址认出国际站，模型取 SMALL_FAST（去掉 [1m]）', cLegacy.ok && cLegacy.endpoint.id === 'global' && cLegacy.model === 'kimi-k3' && cLegacy.slot === 'kimi:global');
  eq('compat：不存在的地区被拒；没有 compatUrl 的地区点名可用的那个', [reg.resolveCompat({ provider: 'kimi', endpoint: 'mars', model: 'kimi-k3' }).code, reg.resolveCompat({ provider: 'siliconflow', endpoint: 'cn', model: 'some-model' }).ok], ['ENDPOINT', false]);
  ok('compat：套餐端点可用，密钥槽是它自己的', (() => { const x = reg.resolveCompat({ provider: 'kimi', endpoint: 'code', model: 'k3.1-pro' }); return x.ok && x.slot === 'kimi:code' && x.url === 'https://api.kimi.com/coding'; })());
  const env = buildCompatEnv({ url: c.url, model: 'kimi-k3', ctx: c.ctx, autoCompactWindow: c.autoCompactWindow, configDir: 'C:/ud/claude-compat/kimi' });
  // 旧 compatEnv（live.ts）的逐项语义
  const oldCompat = (url: string, model: string, ctx?: { tokens: number; known: boolean }) => {
    const big = !!ctx?.known && ctx.tokens >= 1_000_000;
    const main = big && !/\[1m\]$/i.test(model) ? `${model}[1m]` : model;
    const e: Record<string, string> = { ANTHROPIC_BASE_URL: url, ANTHROPIC_MODEL: main, ANTHROPIC_SMALL_FAST_MODEL: model, CLAUDE_CODE_SUBAGENT_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: main, ANTHROPIC_DEFAULT_OPUS_MODEL: main, ANTHROPIC_DEFAULT_HAIKU_MODEL: model, ANTHROPIC_DEFAULT_FABLE_MODEL: main, API_TIMEOUT_MS: '600000' };
    if (ctx?.known) e.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.min(ctx.tokens, 1_000_000));
    return e;
  };
  const subsetOfNew = (o: Record<string, string>, n: Record<string, string>) => Object.keys(o).every((k) => n[k] === o[k]);
  ok('compat 环境：旧 compatEnv 的每一项都原样在（Kimi K3，1M）', subsetOfNew(oldCompat(c.url, 'kimi-k3', c.ctx), env), JSON.stringify(env));
  ok('compat 环境：多出的只有配置目录与「不转发用户凭据」那几项', ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'].every((k) => k in env) && env.ANTHROPIC_API_KEY === '' && env.CLAUDE_CODE_OAUTH_TOKEN === '' && !('ANTHROPIC_AUTH_TOKEN' in env));
  let parity = 0; let checked = 0;
  for (const s of servicesMod.catalog().presets) {
    for (const e of s.endpoints) {
      if (!e.compatUrl || net.placeholderNames(e.compatUrl).length || !s.drivers.includes('claude-compat')) continue;
      for (const m of [...s.models, ...(e.models ?? [])].slice(0, 6)) {
        const r = reg.resolveCompat({ provider: s.id, endpoint: e.id, model: m.id });
        if (!r.ok) { parity += 1; continue; }
        const mine = buildCompatEnv({ url: r.url, model: r.model, ctx: r.ctx, autoCompactWindow: r.autoCompactWindow, configDir: 'C:/x' });
        const old = oldCompat(r.url, r.model, contextOf(PROVIDER_BY_ID[s.id], r.model));
        checked += 1;
        // the one deliberate change: DeepSeek compacts at 786432 (D6)
        if (s.id === 'deepseek') old.CLAUDE_CODE_AUTO_COMPACT_WINDOW = '786432';
        if (!subsetOfNew(old, mine)) parity += 1;
      }
    }
  }
  console.log(`  note 对照了 ${checked} 个（服务 × 端点 × 模型）`);
  eq('所有预设 × 端点 × 模型：compat 环境与旧 compatEnv 逐项一致（DeepSeek 的压缩窗口除外）', parity, 0);
  eq('D6：DeepSeek 的 CLAUDE_CODE_AUTO_COMPACT_WINDOW = 786432（唯一有意的行为变化）', buildCompatEnv({ ...(() => { const r = reg.resolveCompat({ provider: 'deepseek', model: 'deepseek-flash' }); return { url: r.url, model: r.model, ctx: r.ctx, autoCompactWindow: r.autoCompactWindow }; })(), configDir: 'C:/x' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, '786432');
  eq('未知上下文的模型不设压缩窗口', buildCompatEnv({ url: 'https://x.example.com', model: 'm', ctx: { tokens: 128000, known: false }, configDir: 'C:/x' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW, undefined);
  // 本机服务做 compat
  await withFake({}, async (fake) => {
    const id = await addFake(reg, fake, { name: '本机兼容', drivers: ['claude-compat'] });
    const x = reg.resolveCompat({ provider: id, model: 'fake-model' });
    ok('自定义的本机服务：compat 地址是 compatUrl，密钥可空', x.ok && x.url === fake.origin && x.keyOptional === true && x.slot === id, JSON.stringify(x));
  });
}

/* ═══════════════════════════ T-IPC：表面积 ═══════════════════════════ */

section('T-IPC 通道与 preload 的表面积');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  const channels: Record<string, (...a: any[]) => any> = {};
  servicesMod.register((c: string, fn: (...a: any[]) => any) => { channels[c] = fn; }, { registry: reg, confirm: async () => true });
  eq('register 登记的通道', Object.keys(channels).sort(), ['svc:list', 'svc:migrate', 'svc:model-detail', 'svc:models', 'svc:override', 'svc:pin', 'svc:probe-local', 'svc:remove', 'svc:save']);
  const garbage: any[] = [undefined, null, 5, true, 'x'.repeat(100_000), {}, [], [[]], { id: 5 }, JSON.parse('{"__proto__":{"a":1}}'), () => 1, Symbol.for('x')];
  let threw = '';
  const out: unknown[] = [];
  for (const ch of Object.keys(channels)) {
    if (ch === 'svc:probe-local') continue;
    for (const g of garbage) {
      try { out.push(await channels[ch]({ sender: null }, g, g, g, g)); } catch (e) { threw = `${ch}(${String(typeof g)}): ${(e as Error).message}`; }
    }
  }
  eq('任何畸形参数都不抛错（返回纯数据）', threw, '');
  ok('返回值都能 JSON 序列化（纯数据）', (() => { try { JSON.stringify(out); return true; } catch { return false; } })());
  ok('畸形 svc:save 一律 ok:false', (await Promise.all(garbage.map((g) => channels['svc:save']({}, g)))).every((r: any) => r && r.ok === false));
  eq('svc:list 不含密钥与可执行文件路径字段', (() => { const l = channels['svc:list']({}); return Object.keys(l).sort(); })(), ['agents', 'custom', 'keyBindings', 'overrides', 'pinned']);
  // 限速
  const t0 = Date.now();
  ok('tooSoon：同一 key 在间隔内第二次返回 true', servicesMod.tooSoon('probe-x', 10_000, t0) === false && servicesMod.tooSoon('probe-x', 10_000, t0 + 5_000) === true && servicesMod.tooSoon('probe-x', 10_000, t0 + 20_000) === false);

  // preload：只暴露规格里列出的通道
  const pre = fs.readFileSync(path.resolve('electron/preload.cjs'), 'utf8');
  const invoked = [...pre.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]);
  const allowed = new Set([
    'ai:info', 'ai:key:save', 'ai:key:clear', 'ai:detect', 'ai:models', 'ai:login', 'ai:test', 'ai:folder:pick', 'ai:folder:workspace', 'ai:folder:open', 'ai:start', 'ai:input', 'ai:answer', 'ai:stop',
    'app:prefs', 'app:notify', 'app:badge', 'app:theme', 'app:frame-ready', 'app:gpu:get', 'app:gpu:set', 'app:relaunch', 'browser:open', 'browser:clear',
    'skills:list', 'skills:import', 'skills:import:confirm', 'skills:create', 'skills:examples', 'skills:enable', 'skills:remove', 'skills:open',
    'svc:list', 'svc:save', 'svc:remove', 'svc:override', 'svc:pin', 'svc:migrate', 'svc:models', 'svc:model-detail', 'svc:probe-local',
    'acp:probe', 'acp:registry', 'acp:add-registry', 'acp:pick-exe', 'acp:add-custom', 'acp:remove',
    // 桌宠（electron/pet/index.cjs，docs/PET-PLAN.md §2）：主页面 ⇄ 主进程的专用对象 alightDesktop.pet；每个通道在那里都有发送方身份检查（scripts/pet-check.ts 测）
    'pet:config', 'pet:say', 'pet:frame', 'pet:ocr', 'pet:tts:voices', 'pet:tts:test', 'pet:tts:models', 'pet:tts:key', 'pet:tts:clear', 'pet:tts:keys', 'pet:rt', 'pet:game-state', 'pet:tale:save',
  ]);
  eq('preload 调用的通道 ⊂ 规格 §12.5 的表（加原有的）', invoked.filter((c) => !allowed.has(c)), []);
  ok('call() 的前缀白名单没有放宽（仍是 store|trust|usage|git|probe）', /\/\^\(store\|trust\|usage\|git\|probe\):\[\\w:\.-\]\{1,60\}\$\//.test(pre));
  ok('preload 暴露了 services 与 acp 两个专用对象', /services: \{/.test(pre) && /acp: \{/.test(pre));
  ok('桌宠也是专用对象（pet），call() 的白名单没有为它放宽', /\bpet: \{/.test(pre) && !/\(store\|trust\|usage\|git\|probe\|pet/.test(pre));
  const idx = fs.readFileSync(path.resolve('electron/ai/index.cjs'), 'utf8');
  eq('index.cjs 里只有 handle() 这一处直接登记 ipcMain.handle（都经过发送方校验）', (idx.match(/ipcMain\.handle\(/g) ?? []).length, 1);
  ok('services.cjs 不碰 ipcMain（只通过传入的 handle 登记）', !/ipcMain/.test(fs.readFileSync(path.resolve('electron/ai/services.cjs'), 'utf8')));
  ok('主进程不再读页面传来的 baseUrl / extraBody / env / keyEnv 去发请求或起进程', !/spec\.extraBody|spec\.keyEnv|Object\.entries\(spec\.env/.test(idx));
  ok('api.cjs 不再自己 fetch（都走 net.cjs 的 fetchStream）', !/\bfetch\(/.test(fs.readFileSync(path.resolve('electron/ai/api.cjs'), 'utf8').replace(/\/\/.*$/gm, '')));
}

/* ═══════════════════════════ T-LIST：模型列表解析（P2 后端，额外交付） ═══════════════════════════ */

section('T-LIST 模型列表：十个解析器、清洗、合并');
const mapi = req('./electron/ai/models-api.cjs');
const fx = (name: string) => JSON.parse(fs.readFileSync(path.resolve('scripts/fixtures/models', `${name}.json`), 'utf8'));
const byId = (list: any[], id: string) => list.find((m) => m.id === id);
{
  let p = mapi.parseList('openai', fx('openai'), { chatOnly: true });
  eq('openai + chatOnly：嵌入、语音、绘图、审核模型被滤掉', p.models.map((m: any) => m.id), ['gpt-6.1-sol', 'gpt-6-luna']);
  eq('openai 不过滤时全部保留（被误杀的模型用户仍能手填）', mapi.parseList('openai', fx('openai'), {}).models.length, 6);
  p = mapi.parseList('openai', fx('together'), { chatOnly: true });
  eq('Together：直接是数组，type 为 embedding / image 的丢掉，context_length 取上下文', [p.models.map((m: any) => m.id), p.models[0].ctx], [['meta-llama/Llama-4-70B-Instruct'], 131072]);
  p = mapi.parseList('openai', fx('huggingface'), { chatOnly: true });
  eq('Hugging Face：任一供应商支持工具就算支持', [byId(p.models, 'openai/gpt-oss-120b').caps.tools, byId(p.models, 'deepseek-ai/DeepSeek-V4-Flash').caps.tools], [true, false]);
  p = mapi.parseList('openai', fx('deepinfra'), { chatOnly: true });
  eq('DeepInfra：tags 里有 embeddings 的丢掉，vision 标记读到', [p.models.map((m: any) => m.id), p.models[0].caps.vision], [['deepseek-ai/DeepSeek-V4-Flash-0731'], true]);
  eq('NVIDIA：只有 id，嵌入与 guard 模型被滤掉', mapi.parseList('openai', fx('nvidia'), { chatOnly: true }).models.map((m: any) => m.id), ['meta/llama-3.1-8b-instruct']);

  p = mapi.parseList('anthropic', fx('anthropic-page1'), {});
  eq('Anthropic：Opus 不能关（没有 off），档位 low→max', [byId(p.models, 'claude-opus-5-5').effort], [{ style: 'anthropic', levels: ['low', 'medium', 'high', 'xhigh', 'max'] }]);
  eq('Anthropic：Sonnet 能关（between_tools），档位到 high', byId(p.models, 'claude-sonnet-5-5').effort, { style: 'anthropic', levels: ['off', 'low', 'medium', 'high'], offWire: 'between_tools' });
  eq('Anthropic：名称、窗口、输出上限、视觉', [byId(p.models, 'claude-opus-5-5').label, byId(p.models, 'claude-opus-5-5').ctx, byId(p.models, 'claude-opus-5-5').maxOut, byId(p.models, 'claude-opus-5-5').caps], ['Claude Opus 5.5', 1000000, 128000, { vision: true }]);
  p = mapi.parseList('anthropic', fx('anthropic-page2'), {});
  eq('Anthropic：Haiku 用 disabled 关闭', byId(p.models, 'claude-haiku-5-5').effort, { style: 'anthropic', levels: ['off', 'low', 'high'], offWire: 'disabled' });
  eq('Anthropic：弃用的模型带状态与下线日', [byId(p.models, 'claude-old-3').status, byId(p.models, 'claude-old-3').retiresAt], ['deprecated', '2026-11-30']);

  p = mapi.parseList('openrouter', fx('openrouter'), {});
  const opus = byId(p.models, 'anthropic/claude-opus-5-5');
  eq('OpenRouter：窗口、输出上限、工具 / 推理 / 视觉', [opus.ctx, opus.maxOut, opus.caps, opus.label], [1000000, 128000, { tools: true, vision: true, reasoning: true }, 'Anthropic: Claude Opus 5.5']);
  eq('OpenRouter：supported_efforts → 量表（none→off，minimal 丢弃），默认档', opus.effort, { style: 'openrouter', levels: ['off', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' });
  eq('OpenRouter：~ 开头的「系列最新」别名可用；只输出图片的丢掉；有下线日的标 retiring', [!!byId(p.models, '~anthropic/claude-opus-latest'), !!byId(p.models, 'black-forest-labs/flux-2'), byId(p.models, 'old-lab/old-model').status, byId(p.models, 'old-lab/old-model').retiresAt], [true, false, 'retiring', '2026-12-31']);

  p = mapi.parseList('deepseek', fx('deepseek'), {});
  eq('DeepSeek：supported_levels（none 表示可关）→ off + 档位，默认档', byId(p.models, 'deepseek-flash').effort, { style: 're-think', levels: ['off', 'low', 'high', 'max'], default: 'high' });
  eq('DeepSeek：minimal 丢弃；窗口、输出上限、视觉', [byId(p.models, 'deepseek-v4-pro').effort.levels, byId(p.models, 'deepseek-flash').ctx, byId(p.models, 'deepseek-flash').maxOut, byId(p.models, 'deepseek-flash').caps.vision, byId(p.models, 'deepseek-v4-pro').caps.vision], [['off', 'low', 'high', 'max'], 1000000, 384000, true, false]);
  p = mapi.parseList('kimi', fx('kimi'), {});
  eq('Kimi：context_length / 视觉 / 推理', [byId(p.models, 'kimi-k3').ctx, byId(p.models, 'kimi-k3').caps, byId(p.models, 'kimi-k2.7-code').caps.vision], [1048576, { vision: true, reasoning: true }, false]);
  p = mapi.parseList('mistral', fx('mistral'), {});
  eq('Mistral：archived 的跳过；max_context_length、function_calling、vision', [p.models.map((m: any) => m.id), byId(p.models, 'mistral-large-4-0').ctx, byId(p.models, 'mistral-large-4-0').caps, byId(p.models, 'mistral-small-2603').caps], [['mistral-large-4-0', 'mistral-small-2603'], 1000000, { tools: true, vision: true }, { tools: true, vision: false }]);
  p = mapi.parseList('vercel', fx('vercel'), {});
  eq('Vercel：只收 language；tags → 工具 / 推理 / 视觉；deprecated_at → 状态', [p.models.map((m: any) => m.id), byId(p.models, 'anthropic/claude-sonnet-5-5').caps, byId(p.models, 'google/gemini-3.5-flash-lite').status], [['anthropic/claude-sonnet-5-5', 'google/gemini-3.5-flash-lite'], { tools: true, vision: true, reasoning: true }, 'deprecated']);
  p = mapi.parseList('ollama', fx('ollama'), {});
  eq('Ollama：/api/tags 的 name 当 id，参数量与量化当备注', [p.models.map((m: any) => m.id), byId(p.models, 'qwen3:32b').note], [['qwen3:32b', 'llama3.2:3b', 'nomic-embed-text:latest'], '32.8B Q4_K_M']);
  p = mapi.parseList('lmstudio', fx('lmstudio'), {});
  const qw = byId(p.models, 'qwen3-32b');
  eq('LM Studio：只收 LLM / VLM；已加载实例的窗口优先；工具；推理选项映射', [p.models.map((m: any) => m.id), qw.ctx, qw.label, qw.caps.tools, qw.effort], [['qwen3-32b', 'gemma-4-vl'], 16384, 'Qwen3 32B', true, { style: 're', levels: ['off', 'low', 'medium', 'high'], offWire: 'none', default: 'medium' }]);
  eq('LM Studio：VLM 有视觉，没加载就取 max_context_length', [byId(p.models, 'gemma-4-vl').caps.vision, byId(p.models, 'gemma-4-vl').ctx], [true, 131072]);
  p = mapi.parseList('gemini', fx('gemini-page1'), {});
  eq('Gemini：去掉 models/ 前缀；图片、嵌入模型丢掉；窗口与输出上限', [p.models.map((m: any) => m.id), p.models[0].ctx, p.models[0].maxOut, p.models[0].label], [['gemini-4-argon'], 1048576, 65536, 'Gemini 4 Argon']);
  eq('Gemini：live 模型丢掉', mapi.parseList('gemini', fx('gemini-page2'), {}).models.map((m: any) => m.id), ['gemini-3.8-flash']);
  eq('不是列表的响应 → null（失败，不当空列表）', ['openai', 'anthropic', 'deepseek', 'kimi', 'mistral', 'openrouter', 'vercel', 'ollama', 'lmstudio', 'gemini'].map((k) => mapi.parseList(k, { hello: 'world' }, {})), Array(10).fill(null));
  eq('未知解析器 / 原型上的名字 → null', [mapi.parseList('evil', {}, {}), mapi.parseList('constructor', {}, {}), mapi.parseList('__proto__', {}, {})], [null, null, null]);

  // 清洗（I10）：恶意 / 畸形的列表
  const evilItems: any[] = [{ id: 'ok-1' }, { id: 'bad id' }, { id: 'a'.repeat(101) }, { id: 'x\u0000y' }, { id: { nested: 1 } }, null, 7, 'plain-string-id', { id: 'ok-2', name: 'L'.repeat(500) + '\u0007\n', ctx: -5, max_output_tokens: 1e12, context_length: 'many' }, { id: 'ok-1' }, { id: 'a;b' }, { id: '$(whoami)' }];
  for (let i = 0; i < 3000; i++) evilItems.push({ id: `bulk-${i}`, name: `<b onclick="x()">${i}</b>` });
  p = mapi.parseList('openrouter', { data: evilItems.map((x) => (x && typeof x === 'object' && !Array.isArray(x) ? { ...x, architecture: { output_modalities: ['text'] } } : x)) }, {});
  ok('条数上限 1000，并标记被截断', p.models.length === 1000 && p.truncated === true, `${p.models.length}`);
  ok('非法 id（空格、超长、控制字符、分号、$()、对象、重复）一律丢弃', p.models.every((m: any) => net.checkModelId(m.id)) && new Set(p.models.map((m: any) => m.id)).size === p.models.length && !p.models.some((m: any) => /[\s;$()]/.test(m.id)));
  const ok2 = byId(p.models, 'ok-2');
  ok('label 截到 80 字符并去掉控制字符；越界的数字丢掉', ok2.label.length <= 80 && !/[\u0000-\u001f]/.test(ok2.label) && ok2.ctx === undefined && ok2.maxOut === undefined);
  ok('备注 / 名称里的 HTML 只是文字（不执行，原样当纯文本交给界面）', typeof byId(p.models, 'bulk-0').label === 'string' && byId(p.models, 'bulk-0').label.includes('<b'));
  ok('清洗后每条都带 source:live', p.models.every((m: any) => m.source === 'live'));

  // 合并：预设优先，实时补缺，实时独有的追加；预设里有而账号列表里没有的留着并标记
  const presetList = [{ id: 'a', label: '预设甲', ctx: 100, note: '旗舰' }, { id: 'b', label: '预设乙' }, { id: 'gone', label: '只在预设里' }];
  const liveList = [{ id: 'a', label: 'live-a', ctx: 999, maxOut: 50, caps: { tools: true }, source: 'live' }, { id: 'b', ctx: 7, source: 'live' }, { id: 'c', source: 'live' }];
  const merged = mapi.mergeModels(presetList, liveList);
  eq('合并：预设的 label / ctx 赢，缺的 maxOut / caps 由实时补，source 记为 preset', [merged[0].label, merged[0].ctx, merged[0].maxOut, merged[0].caps, merged[0].source], ['预设甲', 100, 50, { tools: true }, 'preset']);
  eq('合并：预设没写 ctx 时用实时的', merged[1].ctx, 7);
  eq('合并：实时独有的追加在后面；预设独有的保留并标记 unlisted', [merged.map((m: any) => m.id), merged[2].unlisted, merged[3].source], [['a', 'b', 'gone', 'c'], true, 'live']);
  eq('合并：实时列表为空时不标 unlisted', mapi.mergeModels(presetList, [])[0].unlisted, undefined);
  eq('TTL：本机 30 秒，其余 6 小时，服务自己的 ttlMs 优先', [mapi.ttlFor({}, { kind: 'local' }), mapi.ttlFor({}, { kind: 'payg' }), mapi.ttlFor({ ttlMs: 5000 }, { kind: 'payg' })], [30_000, 6 * 3600 * 1000, 5000]);
}

section('T-CACHE svc:models：缓存、失败保留旧值、不发请求的情形、分页、详情');
{
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  let seq = 0;
  const mkApi = (extra: Record<string, unknown> = {}) => {
    let clock = 1_800_000_000_000;
    const cacheFile = path.join(mk(`cache-${seq++}`), 'model-cache.json');
    const api = mapi.createModelsApi({ registry: reg, secrets, cacheFile, now: () => clock, tooSoon: () => false, ...extra });
    return { api, cacheFile, tick: (ms: number) => { clock += ms; } };
  };
  const listSvc = async (fake: any, modelsApi: Record<string, unknown>, extra: Record<string, unknown> = {}) => addFake(reg, fake, { name: `列表 ${Math.random().toString(36).slice(2, 6)}`, modelsApi, ...extra });
  const OPENAI_API = { path: '/models', parser: 'openai', auth: 'optional', chatOnly: true };

  await withFake({ models: { '/v1/models': fx('openai') } }, async (fake) => {
    const id = await listSvc(fake, OPENAI_API);
    const { api, cacheFile, tick } = mkApi();
    let r = await api.listModels({ service: id });
    ok('实时：source live，预设 + 实时合并，GET /v1/models', r.ok && r.source === 'live' && fake.requests.length === 1 && fake.requests[0].method === 'GET' && fake.requests[0].path === '/v1/models', JSON.stringify(r).slice(0, 200));
    eq('实时：过滤后的模型在预设之后；预设里有而列表里没有的标 unlisted', [r.models.map((m: any) => m.id), r.models[0].unlisted], [['fake-model', 'gpt-6.1-sol', 'gpt-6-luna'], true]);
    ok('没有密钥：optional 的列表不带任何鉴权头', !fake.requests[0].headers.authorization && !fake.requests[0].headers['x-api-key']);
    r = await api.listModels({ service: id });
    ok('第二次：缓存命中，不再发请求', r.source === 'cache' && r.stale === false && fake.requests.length === 1);
    tick(31_000);
    r = await api.listModels({ service: id });
    ok('本机服务 30 秒后过期：重新拉取', r.source === 'live' && fake.requests.length === 2);
    r = await api.listModels({ service: id, cacheOnly: true });
    ok('cacheOnly：只读缓存、不发请求', r.source === 'cache' && fake.requests.length === 2);
    tick(31_000);
    r = await api.listModels({ service: id, cacheOnly: true });
    ok('cacheOnly 遇到过期的缓存：照样给出，标 stale', r.source === 'cache' && r.stale === true && fake.requests.length === 2);
    r = await api.listModels({ service: id, fresh: true });
    ok('fresh：绕过缓存', r.source === 'live' && fake.requests.length === 3);
    // 密钥换了 → 缓存键不同（不同账号的列表可能不同），且带上鉴权头
    await saveFor(reg, id, 'sk-fake-list-key-AAAA');
    fake.reset();
    r = await api.listModels({ service: id });
    ok('存了密钥：键变了，重新拉取，并带 Authorization', r.source === 'live' && fake.requests.length === 1 && fake.requests[0].headers.authorization === 'Bearer sk-fake-list-key-AAAA');
    await saveFor(reg, id, 'sk-fake-list-key-BBBB');
    r = await api.listModels({ service: id });
    ok('换一把密钥（末四位变了）：不用上一个账号的缓存', r.source === 'live' && fake.requests.length === 2);
    const file = fs.readFileSync(cacheFile, 'utf8');
    ok('缓存文件里没有密钥（只有末四位提示）', !file.includes('sk-fake-list-key') && /••••BBBB/.test(file), file.slice(0, 200));
    ok('缓存文件格式：v1，entries[键].at / models', (() => { const c = JSON.parse(file); const k = Object.keys(c.entries)[0]; return c.v === 1 && typeof c.entries[k].at === 'number' && Array.isArray(c.entries[k].models) && c.entries[k].models.every((m: any) => !('source' in m)); })());
  });

  // 用「会变」的假服务测各种失败（GET 的内容由函数决定）
  let mode = 'ok';
  await withFake({ models: () => (mode === 'ok' ? { '/v1/models': fx('openai') } : mode === '401' ? { '/v1/models': 401 } : mode === '500' ? { '/v1/models': 500 } : mode === 'html' ? { '/v1/models': '<html>nope</html>' } : mode === '404' ? { '/nothing': {} } : { '/v1/models': { hello: 'world' } }) }, async (fake) => {
    const id = await listSvc(fake, OPENAI_API);
    await saveFor(reg, id, 'sk-fake-keep-key-1234');
    const { api, tick } = mkApi();
    mode = 'ok';
    let r = await api.listModels({ service: id });
    ok('先拉一次成功', r.source === 'live' && r.models.length === 3);
    const fail = async (m: string, label: string, code: string) => {
      mode = m; tick(31_000);
      const x = await api.listModels({ service: id });
      ok(`${label}：保留旧缓存、标 stale、带原因`, x.source === 'cache' && x.stale === true && x.models.length === 3 && !!x.error && x.code === code, `${x.source} ${x.stale} ${x.models?.length} ${x.error} ${x.code}`);
    };
    await fail('401', '401', 'AUTH');
    await fail('500', '500', 'SERVER');
    await fail('html', '返回 HTML', 'SHAPE');
    await fail('notlist', '返回的不是列表', 'SHAPE');
    ok('这些失败的原因里没有密钥', !JSON.stringify(await api.listModels({ service: id })).includes('sk-fake-keep-key-1234'));
    // 回来之后恢复
    mode = 'ok'; tick(31_000);
    r = await api.listModels({ service: id });
    ok('服务恢复后重新拉取成功', r.source === 'live' && r.models.length === 3);
  });
  // 服务关掉之后
  {
    const fakeGone = await startFake({ models: { '/v1/models': fx('openai') } });
    const id = await listSvc(fakeGone, OPENAI_API);
    const { api, tick } = mkApi();
    const a = await api.listModels({ service: id });
    await fakeGone.close();
    tick(31_000);
    const b = await api.listModels({ service: id });
    ok('断网 / 连不上：显示上次的缓存并标 stale，说明原因', a.source === 'live' && b.source === 'cache' && b.stale === true && /网络错误/.test(b.error ?? '') && b.models.length === a.models.length, JSON.stringify(b).slice(0, 220));
    const fresh = mkApi();
    const c = await fresh.api.listModels({ service: id });
    ok('从没拉成功过又连不上：只有预设，ok:false', c.ok === false && c.source === 'static' && c.models.length === 1, JSON.stringify(c).slice(0, 200));
  }

  // 不发请求的情形
  await withFake({ models: { '/v1/models': fx('openai') } }, async (fake) => {
    const reqd = await listSvc(fake, { path: '/models', parser: 'openai', auth: 'required' }, { auth: { scheme: 'bearer' } });
    const { api } = mkApi();
    let r = await api.listModels({ service: reqd });
    ok('auth 为 required 而没有密钥：不发请求，说明「保存密钥后可拉取」', r.ok === false && r.code === 'NO_KEY' && r.source === 'static' && fake.requests.length === 0, JSON.stringify(r).slice(0, 200));
    const none = await listSvc(fake, { path: '/models', parser: 'openai', auth: 'none' }, { auth: { scheme: 'bearer' } });
    await saveFor(reg, none, 'sk-fake-should-not-be-sent');
    fake.reset();
    r = await api.listModels({ service: none });
    ok('auth 为 none：即使存了密钥也不带', r.source === 'live' && !fake.requests[0].headers.authorization);
    r = await api.listModels({ service: 'kimi', endpoint: 'code' });
    ok('套餐端点：不发请求，PLAN_KEY，给出该套餐开放的模型', r.ok === false && r.code === 'PLAN_KEY' && r.models.map((m: any) => m.id).join() === 'k3.1-pro,k3,kimi-for-coding');
    r = await api.listModels({ service: 'kimi', endpoint: 'code', fresh: true });
    ok('套餐端点加 fresh 也一样', r.code === 'PLAN_KEY');
    r = await api.listModels({ service: 'openai-nope' });
    ok('不存在的服务', r.ok === false && r.code === 'UNKNOWN');
    r = await api.listModels({ service: 'kimi', endpoint: 'mars' });
    ok('不存在的地区', r.ok === false && r.code === 'ENDPOINT');
    r = await api.listModels({ service: 'azure', endpoint: 'openai', params: { resource: 'my-resource' } });
    ok('没有 modelsApi 的服务（Azure）：只有预设，不发请求', r.ok === true && r.source === 'static');
    r = await api.listModels({ service: 'bedrock', endpoint: 'runtime', params: { region: 'us-east-1' } });
    ok('onlyEndpoints 之外的端点（Bedrock runtime）：不发请求', r.ok === true && r.source === 'static' && r.models.length === 1);
    r = await api.listModels({ service: 'gpt' });
    ok('预设服务需要密钥而没存：不发请求', r.code === 'NO_KEY' && r.models.length === 3);
    r = await api.listModels({ service: 'azure', endpoint: 'openai', params: { resource: 'a.evil.com' } });
    ok('带占位符的地址里地区 / 资源名不合格：拒绝', r.ok === true || r.code === 'ADDRESS');
    r = await api.listModels(null);
    ok('畸形请求不抛错', r.ok === false);
    for (const bad of [5, 'x', [], { service: {} }, { service: 'gpt', endpoint: 5 }]) { r = await api.listModels(bad); ok(`畸形请求 ${JSON.stringify(bad)} 不抛错`, typeof r === 'object' && r !== null); }
  });

  // 404 / 405：这个服务没有列表，会话内不再问
  await withFake({ models: { '/v1/models': 404 } }, async (fake) => {
    const id = await listSvc(fake, OPENAI_API);
    const { api } = mkApi();
    let r = await api.listModels({ service: id });
    ok('404：没有列表接口，说明；只有预设', r.ok === true && r.source === 'static' && r.code === 'NO_LIST' && fake.requests.length === 1);
    r = await api.listModels({ service: id });
    r = await api.listModels({ service: id, fresh: true });
    ok('之后不再反复重试', fake.requests.length === 1 && r.source === 'static');
  });

  // 分页
  await withFake({ models: (_req: any, rec: any) => ({ '/v1/models': rec.query.after_id ? fx('anthropic-page2') : fx('anthropic-page1') }) }, async (fake) => {
    const id = await listSvc(fake, { path: '/v1/models', from: 'origin', parser: 'anthropic', auth: 'optional', query: { limit: '1000' } }, { protocol: 'anthropic', auth: { scheme: 'x-api-key' } });
    await saveFor(reg, id, 'sk-ant-fake-page-key-1');
    const { api } = mkApi();
    const r = await api.listModels({ service: id });
    ok('Anthropic 分页：has_more / last_id → after_id 翻到底', r.source === 'live' && fake.requests.length === 2 && fake.requests[1].query.after_id === 'claude-sonnet-5-5' && fake.requests[0].query.limit === '1000', JSON.stringify(fake.requests.map((q: any) => q.query)));
    eq('Anthropic：4 个模型 + 预设', r.models.map((m: any) => m.id), ['fake-model', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-old-3']);
    ok('Anthropic：x-api-key 鉴权', fake.requests[0].headers['x-api-key'] === 'sk-ant-fake-page-key-1');
    // 账号级事实优先于规则：实时给的档位被 resolveEffort 采用
    const live = r.models.map((m: any) => ({ id: m.id, effort: m.effort }));
    eq('实时列表的档位被推理强度解析采用', effortWire.resolveEffort(reg.get(id), 'claude-haiku-5-5', live).levels, ['off', 'low', 'high']);
    eq('页面一份同样', pageResolveEffort(reg.get(id), 'claude-haiku-5-5', live).levels, ['off', 'low', 'high']);
  });
  await withFake({ models: (_req: any, rec: any) => ({ '/v1beta/models': rec.query.pageToken ? fx('gemini-page2') : fx('gemini-page1') }) }, async (fake) => {
    const id = await listSvc(fake, { path: '/v1beta/models', from: 'origin', parser: 'gemini', auth: 'required', authOverride: { scheme: 'header', header: 'x-goog-api-key' }, query: { pageSize: '1000' } });
    await saveFor(reg, id, 'AIza-fake-gemini-list-key');
    const { api } = mkApi();
    const r = await api.listModels({ service: id });
    ok('Gemini 分页（nextPageToken → pageToken），列表用 x-goog-api-key 而不是 Bearer', r.source === 'live' && fake.requests.length === 2 && fake.requests[1].query.pageToken === 'tok-2' && fake.requests[0].headers['x-goog-api-key'] === 'AIza-fake-gemini-list-key' && !fake.requests[0].headers.authorization, JSON.stringify(fake.requests.map((q: any) => [q.query, Object.keys(q.headers).filter((h) => /key|auth/.test(h))])));
    eq('Gemini：两页合并', r.models.map((m: any) => m.id), ['fake-model', 'gemini-4-argon', 'gemini-3.8-flash']);
  });

  // 恶意列表：条数、控制字符、非法 id、形状不对
  const evilData = { data: [...Array.from({ length: 3000 }, (_, i) => ({ id: i % 7 === 0 ? `bad id ${i}` : `m-${i}`, name: `n${'x'.repeat(200)}\u0001` })), { id: 'a;b' }] };
  await withFake({ models: { '/v1/models': evilData } }, async (fake) => {
    const id = await listSvc(fake, { path: '/models', parser: 'openrouter', auth: 'none' });
    const { api, cacheFile } = mkApi();
    const r = await api.listModels({ service: id });
    ok('恶意列表：截到 1000 条（加预设），id 全合法，名称无控制字符且 ≤80', r.source === 'live' && r.truncated === true && r.models.length <= 1001 && r.models.every((m: any) => net.checkModelId(m.id) && (!m.label || (m.label.length <= 80 && !/[\u0000-\u001f]/.test(m.label)))), `${r.models.length}`);
    ok('缓存文件也是清洗过的', (() => { const c = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); const e = Object.values<any>(c.entries)[0]; return e.models.length <= 1000 && e.models.every((m: any) => net.checkModelId(m.id)); })());
  });

  // 缓存体积上限与损坏
  await withFake({ models: { '/v1/models': fx('openai') } }, async (fake) => {
    const id = await listSvc(fake, OPENAI_API);
    const { api, cacheFile } = mkApi();
    const c = api._cache();
    const fat = Array.from({ length: 900 }, (_, i) => ({ id: `fat-model-${i}`, label: 'L'.repeat(80), note: 'N'.repeat(120), ctx: 1000 + i }));
    for (let i = 0; i < 40; i++) c.entries[`old-${i}|x|-|-`] = { at: 1000 + i, models: fat };
    await api.listModels({ service: id });
    const size = fs.statSync(cacheFile).size;
    const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    ok('缓存文件超过 4 MB 时从最旧的开始淘汰，新结果留着', size <= 4 * 1024 * 1024 && !after.entries['old-0|x|-|-'] && Object.keys(after.entries).some((k) => k.startsWith(`${id}|`)), `${size} ${Object.keys(after.entries).length}`);
    fs.writeFileSync(cacheFile, '{broken');
    const fresh = mapi.createModelsApi({ registry: reg, secrets, cacheFile, now: () => 1_800_000_000_000, tooSoon: () => false });
    const r = await fresh.listModels({ service: id });
    const aside = fs.readdirSync(path.dirname(cacheFile)).filter((n) => n.startsWith('model-cache.json.corrupt-'));
    ok('损坏的缓存文件改名留底，照常工作', r.source === 'live' && aside.length === 1);
    // 删除服务：缓存里它的条目一起清
    const del = await listSvc(fake, OPENAI_API);
    await fresh.listModels({ service: del });
    ok('服务有了缓存条目', Object.keys(fresh._cache().entries).some((k) => k.startsWith(`${del}|`)));
    reg.removeService(del);
    ok('删除服务：缓存里它的条目也清掉', !Object.keys(fresh._cache().entries).some((k) => k.startsWith(`${del}|`)) && !fs.readFileSync(cacheFile, 'utf8').includes(`${del}|`));
  });

  // 限速（§12.5）：同一服务 3 秒内再要 fresh，当作普通读缓存
  await withFake({ models: { '/v1/models': fx('openai') } }, async (fake) => {
    const id = await listSvc(fake, OPENAI_API);
    const seen: number[] = [];
    const { api } = mkApi({ tooSoon: (key: string, ms: number) => { seen.push(ms); return fake.requests.length >= 1 && key === `models:${id}`; } });
    await api.listModels({ service: id, fresh: true });
    await api.listModels({ service: id, fresh: true });
    ok('3 秒内重复 fresh：只发了一次请求', fake.requests.length === 1 && seen.every((ms) => ms === 3000), `${fake.requests.length}`);
  });

  // 详情（Ollama /api/show）
  await withFake({ script: (_req: any, res: any) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(fx('ollama-show'))); } }, async (fake) => {
    const id = await listSvc(fake, { path: '/api/tags', from: 'origin', parser: 'ollama', auth: 'none', detail: { path: '/api/show', method: 'POST' } });
    const { api } = mkApi();
    let r = await api.modelDetail({ service: id, model: 'qwen3:32b' });
    ok('modelDetail：POST /api/show {model}，取上下文与能力', r.ok && r.value.ctx === 40960 && r.value.caps.tools === true && r.value.caps.reasoning === true && r.value.caps.vision === false && fake.requests[0].method === 'POST' && fake.requests[0].path === '/api/show' && fake.requests[0].body.model === 'qwen3:32b', JSON.stringify(r).slice(0, 240));
    r = await api.modelDetail({ service: id, model: 'a b' });
    ok('modelDetail：模型名不合法被拒', r.ok === false);
    r = await api.modelDetail({ service: 'gpt', model: 'gpt-6-luna' });
    ok('modelDetail：没有详情接口的服务被拒', r.ok === false);
    r = await api.modelDetail({ service: 'nope', model: 'x' });
    ok('modelDetail：未知服务被拒', r.ok === false);
  });
}

/* ═══════════════════════════ T-STATE：页面状态与主进程注册表互相跑一遍（无 IPC） ═══════════════════════════ */

section('T-STATE 页面的 models 状态 × 主进程注册表：迁移、按地区的密钥、服务地址、自定义服务、模型列表');
{
  secrets.__setDeps({ dir: mk('state-keys'), safeStorage: fakeSafe });   // 一个干净的密钥库：前面的章节存过别的密钥
  const { reg } = newRegistry();
  secrets.configure(reg.secretsConfig());
  const mapiLocal = mapi.createModelsApi({ registry: reg, secrets, cacheFile: path.join(mk('state-cache'), 'model-cache.json'), tooSoon: () => false });
  const calls: string[] = [];
  const dialogs: string[] = [];   // the native questions the main process asked (the bridge answers yes, as the user would)
  const slotOfReq = (provider: string, endpoint?: string) => { const s = reg.get(provider); const ep = endpoint ? reg.endpointOf(s, endpoint) : undefined; return { s, ep, slot: ep ? reg.slotFor(s, ep) : provider }; };
  let testSpec: any;
  Object.assign(bridge, {
    info: async () => ({ encryption: true, keys: secrets.hints(), workspaceRoot: 'C:/w', platform: 'win32' }),
    saveKey: async (provider: string, key: string, endpoint?: string) => { calls.push(`saveKey ${provider} ${endpoint}`); try { const { s: sv, ep: e0, slot: sl } = slotOfReq(provider, endpoint); const e1 = e0 || reg.defaultEndpoint(sv, 'api') || sv.endpoints[0]; if (!(await reg.confirmKeyDestination(sv, e1, yes))) return { ok: false, error: '已取消' }; await reg.releaseLegacySlot(sv, e1); return { ok: true, hint: await secrets.save(sl, key) }; } catch (e) { return { ok: false, error: (e as Error).message }; } },
    clearKey: async (provider: string, endpoint?: string) => { const { s, ep, slot } = slotOfReq(provider, endpoint); for (const x of endpoint ? reg.slotsToClear(s, ep) : [slot]) secrets.clear(x); if (endpoint) reg.dropBinding(s, ep); return { ok: true }; },
    test: async (spec: any) => { testSpec = spec; return { ok: true, text: 'OK', ms: 5 }; },
    // the stand-alone command-line agents are services with the command-line way on: the page looks for their programs at start; none is installed here
    detect: async () => ({ found: false, login: 'unknown', detail: '（检查里没有命令行工具）' }),
    services: {
      list: async () => reg.snapshot(),
      save: (def: any) => reg.saveService(def, { confirm: yes }),
      remove: async (id: string) => reg.removeService(id),
      setOverride: async (id: string, endpoint: string, url: string | null) => { calls.push(`override ${id} ${endpoint} ${url}`); return reg.setOverride(id, endpoint, url, { confirm: yes }); },
      pin: async (id: string, model: string, on: boolean) => reg.pin(id, model, on),
      migrate: async (r: any) => { calls.push('migrate'); return reg.migrate(r, { confirm: async (o: any) => { dialogs.push(o.title); return true; } }); },
      models: (r: any) => mapiLocal.listModels(r),
      probeLocal: async () => reg.probeLocal({ candidates: [] }),
    },
  });
  store.init(emptyState(Date.now()));

  // 一份首发版本的存档：Kimi 选了国际站，手填了服务地址；旧的单槽密钥存在 kimi 下
  await secrets.save('kimi', 'sk-legacy-kimi-key-9999');
  const old: any = { providers: { kimi: { id: 'kimi', auth: 'api', driver: 'kimi', region: 'global', baseUrl: 'https://relay.example.com/v1', model: 'kimi-k3', cliModel: '', cliPath: '' }, qwen: { id: 'qwen', auth: 'api', driver: 'qwen', region: 'cn', baseUrl: '', model: 'qwen3.8-max', cliModel: '', cliPath: '' } }, defaultEngine: 'kimi' };
  store.update((d) => { d.models = restoreModels(old) as any; });
  await refreshModels();
  let m = store.get().models;
  ok('启动：迁移已交给主进程（一次），页面的待办清空', calls.filter((c) => c === 'migrate').length === 1 && getPendingLegacy() === undefined);
  eq('已存旧密钥的 Kimi 手填了新主机：迁移时走了一次原生确认', dialogs, ['密钥将发往新的主机']);
  eq('主进程记下了：旧单槽密钥属于国际站；手填地址属于国际站', [reg.bindingOf('kimi'), reg.overrideOf('kimi')?.endpoint, reg.overrideOf('kimi')?.baseUrl], ['global', 'global', 'https://relay.example.com/v1']);
  eq('页面：槽位提示、绑定、覆盖都读回来了', [m.keyHints?.kimi, m.keyBindings?.kimi, m.overrides?.kimi?.endpoint], ['••••9999', 'global', 'global']);
  eq('页面：Kimi 国际站有密钥提示，服务地址仍显示用户填的', [m.providers.kimi.keyHint, m.providers.kimi.baseUrl], ['••••9999', 'https://relay.example.com/v1']);
  ok('其余服务没有密钥提示', Object.entries(m.providers).filter(([id, c]) => id !== 'kimi' && (c as any).keyHint).length === 0);
  eq('Kimi 现在能用（国际站、有密钥、选了模型）', engineChoices(m).map((c) => c.key), ['kimi:api']);
  // 换地区：密钥、地址都跟着地区走
  modelActions.set('kimi', { region: 'cn' });
  m = store.get().models;
  eq('换到国内站：没有这个地区的密钥，也没有它的地址覆盖', [m.providers.kimi.keyHint, m.providers.kimi.baseUrl], [undefined, '']);
  eq('国内站没有密钥：不再就绪', engineChoices(m).length, 0);
  ok('在国内站存密钥：带上地区，存进 kimi:cn', await modelActions.saveKey('kimi', 'sk-new-kimi-cn-key-1234') && calls.includes('saveKey kimi cn') && !!secrets.hints()['kimi:cn']);
  m = store.get().models;
  eq('页面：国内站有了自己的提示；国际站的提示不变', [m.providers.kimi.keyHint, m.keyHints?.['kimi:cn'], m.keyHints?.kimi], ['••••1234', '••••1234', '••••9999']);
  modelActions.set('kimi', { region: 'global' });
  eq('切回国际站：提示回到旧槽的，地址覆盖也回来', [store.get().models.providers.kimi.keyHint, store.get().models.providers.kimi.baseUrl], ['••••9999', 'https://relay.example.com/v1']);
  await modelActions.clearKey('kimi');
  m = store.get().models;
  eq('清掉国际站的密钥：旧槽与绑定一起没了；国内站的不受影响', [m.providers.kimi.keyHint, m.keyBindings?.kimi, !!secrets.hints()['kimi:cn'], await secrets.get('kimi')], [undefined, undefined, true, null]);

  // 「服务地址」：停下 0.7 秒后才提交；不合格的不发；清空恢复默认
  calls.length = 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  modelActions.set('deepseek', { baseUrl: 'https://relay-ds.example.com/v1' });
  modelActions.set('deepseek', { baseUrl: 'https://relay-ds.example.com/v1/' });
  await sleep(100);
  eq('打字过程中不提交', calls.filter((c) => c.startsWith('override')).length, 0);
  await sleep(900);
  eq('停下之后只提交一次，主进程有了覆盖', [calls.filter((c) => c.startsWith('override')).length, reg.overrideOf('deepseek')?.baseUrl], [1, 'https://relay-ds.example.com/v1']);
  modelActions.set('deepseek', { baseUrl: 'http://not-allowed.example.com/v1' });
  await sleep(900);
  eq('不合格的地址（非回环 http）不发给主进程，覆盖不变', [calls.filter((c) => c.startsWith('override')).length, reg.overrideOf('deepseek')?.baseUrl], [1, 'https://relay-ds.example.com/v1']);
  modelActions.set('deepseek', { baseUrl: '' });
  await sleep(900);
  ok('清空：恢复默认地址', !reg.overrideOf('deepseek'));
  // 测试连接：只带 id
  await secrets.save('deepseek', 'sk-ds-state-key-1234');
  store.update((d) => { d.models.providers.deepseek.keyHint = '••••1234'; });
  modelActions.set('deepseek', { baseUrl: 'https://relay-ds2.example.com/v1' });
  await modelActions.test('deepseek', 'api');
  eq('连接测试前先提交挂起的地址；spec 里只有 id（没有地址、体、环境）', [reg.overrideOf('deepseek')?.baseUrl, testSpec], ['https://relay-ds2.example.com/v1', { driver: 'api', provider: 'deepseek', endpoint: 'cn', model: 'deepseek-flash' }]);
  modelActions.set('deepseek', { baseUrl: '' }); await sleep(900);
  store.update((d) => { d.models.providers.kimi.cli = { found: true, login: 'yes', at: 1 }; d.models.providers.kimi.auth = 'cli'; });
  await modelActions.test('kimi', 'cli');
  eq('命令行方式的 spec：驱动、地区，没有 acp / env / keyEnv', [testSpec.driver, testSpec.endpoint, 'acp' in testSpec, 'env' in testSpec, 'keyEnv' in testSpec], ['kimi', 'global', false, false, false]);
  store.update((d) => { d.models.providers.qwen.cli = { found: true, login: 'n/a', at: 1 }; d.models.providers.qwen.auth = 'cli'; d.models.providers.qwen.driver = 'claude-compat'; d.models.providers.qwen.keyHint = '••••abcd'; });
  await modelActions.test('qwen', 'cli');
  eq('claude-compat 的 spec：模型走 model 字段，地址与环境留给主进程', [testSpec.driver, testSpec.model, 'env' in testSpec, 'baseUrl' in testSpec], ['claude-compat', 'qwen3.8-max', false, false]);

  // 自定义服务：保存、出现在列表、有默认配置；模型列表；删除、占位、默认引擎回落、任务数
  await withFake({ models: { '/v1/models': fx('anthropic-page1') } }, async (fake) => {
    const saved = await saveCustomService({ name: '页面里的中转', endpoints: [{ id: 'main', label: '本机', kind: 'local', baseUrl: fake.baseUrl }], auth: { scheme: 'bearer', keyOptional: true }, protocol: 'anthropic',
      models: [{ id: 'claude-haiku-5-5' }], modelsApi: { path: '/v1/models', from: 'origin', parser: 'anthropic', auth: 'none' } } as any);
    ok('saveCustomService 成功，返回规范化后的服务', saved.ok && /^x_/.test((saved as any).value.id));
    const id = (saved as any).value.id as string;
    m = store.get().models;
    ok('新服务进了 PROVIDERS，拿到默认配置，名字能显示', PROVIDERS.some((p) => p.id === id) && m.providers[id]?.model === 'claude-haiku-5-5' && m.providers[id].region === 'main' && PROVIDER_BY_ID[id].name === '页面里的中转' && (m.customMirror ?? []).some((x) => x.id === id));
    eq('keyOptional 的本机服务：不用密钥就就绪', engineChoices(m).map((c) => c.provider).includes(id), true);
    ok('兼容小标：聊天可用、没有命令行方式所以「干活」不可用', (() => { const g = gradeOf(serviceOf(id), { keySaved: false, levels: [] }); return g.chat && g.work === 'no'; })());
    // 模型列表进状态；实时给的档位被选择菜单采用
    const lr = await refreshModelList(id);
    m = store.get().models;
    ok('refreshModelList：合并后的列表和来源进了状态', lr?.source === 'live' && (m.liveApi?.[id] ?? []).length === 3 && m.listMeta?.[id]?.source === 'live', JSON.stringify(m.listMeta?.[id]));
    const choice = engineChoices(m).find((c) => c.provider === id)!;
    eq('任务菜单的模型选项里有实时模型', modelOptions(m, choice).map((o) => o.id), ['claude-haiku-5-5', 'claude-opus-5-5', 'claude-sonnet-5-5']);
    eq('推理强度菜单采用实时列表给的档位（账号级事实）', [choiceEfforts(m, choice, 'claude-opus-5-5'), choiceEfforts(m, choice, 'claude-sonnet-5-5')], [['low', 'medium', 'high', 'xhigh', 'max'], ['off', 'low', 'medium', 'high']]);
    // 默认引擎与任务引用
    modelActions.setDefault(id);
    store.update((d) => { (d.tasks as any).t1 = { id: 't1', title: 'x', engine: { kind: 'live', provider: id, auth: 'api', model: 'claude-haiku-5-5', label: 'x' } }; });
    eq('删除前：有 1 个任务在用它', tasksUsing(id), 1);
    await pinModel(id, 'claude-haiku-5-5', true);
    eq('置顶存进状态', store.get().models.pinned?.[id], ['claude-haiku-5-5']);
    const rm = await removeCustomService(id);
    m = store.get().models;
    ok('删除成功', rm.ok);
    ok('删除后：不在列表里；任务读作（已删除）；默认引擎回落', !PROVIDERS.some((p) => p.id === id) && PROVIDER_BY_ID[id].name === '（已删除）' && m.defaultEngine === '' && !hasProvider(id));
    store.update((d) => { delete (d.tasks as any).t1; });
  });
  setCustomServices([]);
  restoreModels(undefined);
  for (const k of Object.keys(bridge)) delete bridge[k];
}

/* ═══════════════════════════ Electron 里的那一半 ═══════════════════════════ */

section('Electron 里的那一半：真正的 startStream、net.fetch、伪造的 StartSpec、真实子进程（无窗口）');
{
  let electronExe: unknown = '';
  try { electronExe = req('electron'); } catch { /* handled below */ }
  if (typeof electronExe !== 'string' || !fs.existsSync(electronExe)) {
    console.log('  note 找不到 electron 可执行文件，这一半跳过');
  } else {
    const spawnElectron = (script: string, outVar: string, name: string, minItems: number) => {
      const out = path.join(work, `${name}.json`);
      const env: Record<string, string> = { ...(process.env as Record<string, string>), ALIGHT_PROBE: '1', [outVar]: out, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
      delete env.ELECTRON_RUN_AS_NODE;
      const r = spawnSync(electronExe as string, [path.resolve(script), `--user-data-dir=${mk(`ud-${name}`)}`, '--disable-gpu', '--no-first-run'], { env, encoding: 'utf8', timeout: 170_000, windowsHide: true });
      if (!fs.existsSync(out)) { ok(`${name}：Electron 脚本跑完并写出结果`, false, `exit ${r.status} signal ${r.signal}\n${(r.stdout || '').slice(-600)}\n${(r.stderr || '').slice(0, 600)}`); return; }
      const results = JSON.parse(fs.readFileSync(out, 'utf8')) as Array<{ name: string; ok: boolean; detail?: string }>;
      for (const x of results) ok(x.name, x.ok, x.detail);
      ok(`${name}：至少跑了 ${minItems} 项`, results.length >= minItems, String(results.length));
    };
    spawnElectron('scripts/fixtures/services-electron-main.cjs', 'ALIGHT_SVC_OUT', 'services-electron', 45);
    spawnElectron('scripts/fixtures/v11-netfetch-main.cjs', 'ALIGHT_V11_OUT', 'v11-netfetch', 8);
    // command-line agents through the real wiring: stand-alone agents as services, forged environments, the user's own commands, the old driver names
    spawnElectron('scripts/fixtures/acp-int-main.cjs', 'ALIGHT_INT_OUT', 'acp-electron', 23);
  }
}

/* ═══════════════════════════ T-ACP：通用 ACP 驱动与命令行代理登记（MB3） ═══════════════════════════ */

// 协议面、权限与只读、代理登记、探测、官方注册表、自定义命令、IPC 通道：scripts/fixtures/fake-acp-suite.cjs（假代理 + 回环上的假注册表，单独也能跑）
await req('./scripts/fixtures/fake-acp-suite.cjs').runTAcp({ ok, eq, section, mk, servicesMod, secrets });

section('T-ACP 页面这一半：伪服务的规则与主进程一致，页面动作走桥');
{
  const acpMod = req('./electron/ai/acp-agents.cjs');
  const pageUser = mk('acp-page-user');
  const pageReg = servicesMod.createRegistry({ userDir: pageUser, secrets });
  secrets.configure(pageReg.secretsConfig());
  const probeEnv: Record<string, string> = {};
  const pageAg = acpMod.createAcpAgents({ registry: pageReg, userData: mk('acp-page-ud'), secrets, probeEnv, timeouts: { probe: 6000, deep: 8000 } });
  eq('页面的 AGENT_DEFS 就是主进程目录里的 19 个', [AGENT_DEFS.length, AGENT_DEFS.map((a) => a.id).join()], [19, servicesMod.catalog().agents.map((a: any) => a.id).join()]);
  eq('「命令行」分组：页面与主进程各算一遍，11 个伪服务逐项一致', [standaloneRecs().length, stable(standaloneRecs().map(pseudoServiceOf)) === stable(pageAg.pseudoServices())], [11, true]);
  eq('agentServices() 就是这 11 个', agentServices().map((s) => s.id), pageAg.pseudoServices().map((s: any) => s.id));
  ok('徽记规则页面与主进程一致（目录里所有代理的名字）', allAgentRecs().every((a) => pageGlyph(a.label) === acpMod.glyphOf(a.label)) && pageGlyph('遐蝶助手') === '遐' && pageGlyph('Gemini CLI') === 'Ge');
  ok('伪服务进页面的服务列表后，每个都有 ProviderInfo 可读（setCustomServices 接受它们）', (() => {
    setCustomServices(agentServices());
    const okAll = agentServices().every((s) => hasProvider(s.id) && PROVIDER_BY_ID[s.id].group === 'cli' && PROVIDER_BY_ID[s.id].drivers[0] === `acp:${s.id.slice(4)}` && DRIVERS[PROVIDER_BY_ID[s.id].drivers[0]].auth === 'account');
    const cfg = defaultProviderConfig(PROVIDER_BY_ID.acp_opencode);
    setCustomServices([]);
    return okAll && cfg.driver === 'acp:opencode';
  })());
  eq('权限模式：除 Kimi 外的代理页面上都是「未验证」', [permissionSupport('acp:opencode', 'plan').level, permissionSupport('acp:opencode', 'ask').level, permissionSupport('acp:kimi', 'bypass').level, permissionSupport('kimi', 'ask').level], ['unverified', 'full', 'degraded', 'full']);

  if (process.platform !== 'win32') console.log('  skip 页面动作要用 .cmd 包装器启动假代理，只在 Windows 上跑');
  else {
    const exe = path.join(mk('acp-page-bin'), 'page-agent.cmd');
    fs.writeFileSync(exe, `@echo off\r\n"${process.execPath}" "${path.resolve('scripts/fixtures/fake-acp.cjs')}" %*\r\n`);
    bridge.services = { list: async () => pageReg.snapshot() };
    bridge.acp = {
      probe: (r: any) => pageAg.probe(r), registry: (r: any) => pageAg.registryList(r), pickExe: () => pageAg.pickExe({}, async () => exe),
      addCustom: (r: any) => pageAg.addCustom(r, yes), addFromRegistry: (r: any) => pageAg.addFromRegistry(r, yes), remove: async (id: string) => pageAg.remove(id),
    };
    const picked = await pagePickExe();
    ok('页面拿到的是令牌与文件名，没有路径', picked.ok && picked.name === 'page-agent.cmd' && !JSON.stringify(picked).includes('acp-page-bin'), JSON.stringify(picked));
    const added = picked.ok ? await pageAddCustom({ token: picked.token, label: '页面里加的', args: ['--acp'], envNames: [] }) : picked;
    ok('登记成功', added.ok, JSON.stringify(added));
    const id = added.ok ? added.id : '';
    ok('页面读回自己添加的代理，并为它登记了驱动', userAgents().some((a) => a.id === id && a.source === 'custom') && !!DRIVERS[`acp:${id}`] && DRIVERS[`acp:${id}`].label === '页面里加的');
    ok('用户添加的代理的伪服务：页面与主进程一致，也进「命令行」分组', stable(pseudoServiceOf(userAgents().find((a) => a.id === id)!)) === stable(pageAg.pseudoServiceById(`acp_${id}`)) && agentServices().length === 12);
    for (const k of Object.keys(probeEnv)) delete probeEnv[k];
    Object.assign(probeEnv, { FAKE_ACP_MODE: 'config-options,resume-only' });
    await pageRunProbe(id, true);
    const pr = probeOf(id);
    ok('页面动作 runProbe（读取模型与模式）：结果进页面状态', pr?.state === 'done' && pr.result.ok && pr.result.summary?.models.length === 3 && pr.result.caps.resume === true && pr.deep === true, JSON.stringify(pr).slice(0, 240));
    const liveList = store.get().models.live?.[`acp:${id}`];
    ok('读取模型与模式之后，代理自己的模型列表进了页面状态（和 Codex 的账号模型同一个地方），强度只留量表里有的', !!liveList && liveList.map((m) => m.id).join() === 'm-fast,m-pro,m-old' && liveList[0].efforts?.join() === 'low,medium,high' && liveList[0].isDefault === true && liveList[0].defaultEffort === 'medium', JSON.stringify(liveList));
    ok('这个列表出现在任务的模型菜单里（modelOptions 对 CLI 方式读 live[driver]）', (() => {
      const pid = `acp_${id}`;
      setCustomServices(agentServices());
      store.update((d) => { (d.models.providers as any)[pid] = defaultProviderConfig(PROVIDER_BY_ID[pid]); });
      try { return modelOptions(store.get().models, { provider: pid, auth: 'cli', driver: `acp:${id}` }).some((m) => m.id === 'm-pro'); } finally { store.update((d) => { delete (d.models.providers as any)[pid]; }); setCustomServices([]); }
    })());
    await pageRunProbe(id, false);
    ok('浅探测不带摘要', probeOf(id)?.state === 'done' && !(probeOf(id) as any).result.summary);
    bridge.acp.registry = async () => ({ ok: true, value: [{ id: 'a', name: 'A', version: '1.0.0', dist: 'npx', addable: true }, 'junk', null, { id: 7 }], at: 5, stale: true, error: '没能刷新' });
    const listed = await pageLoadRegistry(true);
    ok('页面读注册表：只留下形状对的行，带上 at / stale / error', listed.ok && listed.listing.rows.length === 1 && listed.listing.stale === true && listed.listing.at === 5 && listed.listing.error === '没能刷新', JSON.stringify(listed));
    bridge.acp.registry = async () => ({ ok: false, error: '没能读取官方注册表：HTTP 500' });
    const failedList = await pageLoadRegistry(false);
    ok('注册表读不到：一句人话，不抛', !failedList.ok && /HTTP 500/.test(failedList.error), JSON.stringify(failedList));
    bridge.acp.registry = async () => { throw new Error("Error invoking remote method 'acp:registry': Error: 拒绝"); };
    const thrown = await pageLoadRegistry(false);
    ok('通道被拒（还没登记）：去掉 Electron 的前缀，不抛', !thrown.ok && thrown.error === 'Error: 拒绝', JSON.stringify(thrown));
    ok('移除：页面状态和主进程都清了', (await pageRemoveAgent(id)) === true && !userAgents().some((a) => a.id === id) && !pageAg.get(id) && probeOf(id) === undefined && agentServices().length === 11);
    delete bridge.acp;
    delete bridge.services;
  }
}

/* __NEXT__ */

/* ───────────── 收尾 ───────────── */

secrets.__setDeps(null);
secrets.configure(null);
try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { console.log(`  note 临时目录没删干净：${work}`); }
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(`${failed} failed`); process.exit(1); }
