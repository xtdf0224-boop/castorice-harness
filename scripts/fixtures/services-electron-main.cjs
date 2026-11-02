'use strict';
// The half of the model-access checks (npm run check:services) that needs the REAL electron/ai/index.cjs inside a windowless Electron main process:
//   · startStream with forged specs (the page cannot choose where a key goes, nor the body, nor the environment)
//   · Electron's net.fetch as the transport (streaming, redirect:'error', the key scrubber on a real stream)
//   · the real safeStorage, a real child process (a fake ACP agent) that reports the environment it was started with
// No window is ever created; every request goes to 127.0.0.1; the keys are made up. Output: ALIGHT_SVC_OUT=<file> gets the JSON results.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-svc-electron-'));
app.setPath('userData', path.join(root, 'userData'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
// nothing from the developer's own environment may leak into what is being checked
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|OPENAI_|CLAUDE_CODE_|NODE_OPTIONS$)/i.test(k)) delete process.env[k];

const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: ok ? '' : String(detail === undefined ? '' : detail) }); };
const APP = path.resolve(__dirname, '..', '..');
const yes = async () => true;

app.whenReady().then(async () => {
  let fake;
  let fake2;
  try {
    const { startFake } = require('./fake-llm.cjs');
    const ai = require(path.join(APP, 'electron', 'ai', 'index.cjs'));
    const services = require(path.join(APP, 'electron', 'ai', 'services.cjs'));
    const secrets = require(path.join(APP, 'electron', 'ai', 'secrets.cjs'));
    const net = require(path.join(APP, 'electron', 'ai', 'net.cjs'));
    const { startStream, test, saveKeyOp, clearKeyOp, envProblem, driverDef } = ai.__test;
    const reg = services.instance();
    fake = await startFake({ script: 'openai-ok' });

    const run = (spec) => new Promise((resolve) => {
      const events = [];
      const sender = { isDestroyed: () => false, send: (_ch, ev) => { events.push(ev); if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve(events), 30); } };
      startStream(sender, spec);
      setTimeout(() => resolve(events.concat([{ type: 'timeout' }])), 25000);
    });
    const kinds = (evs, t) => evs.filter((e) => e.type === t);
    const textOf = (evs, t) => kinds(evs, t).map((e) => e.text).join('');
    const addService = async (extra) => {
      const r = await reg.saveService({
        name: `电子 ${Math.random().toString(36).slice(2, 7)}`,
        endpoints: [{ id: 'main', label: '本机假服务', kind: 'local', baseUrl: fake.baseUrl, compatUrl: fake.origin }],
        auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'fake-model', ctx: 32768 }], wire: { maxTokensField: 'max_tokens', defaultMaxOut: 4096, testMaxTokens: 128 }, ...extra,
      }, { confirm: yes });
      if (!r.ok) throw new Error(`addService: ${r.error}`);
      return r.value.id;
    };
    const msgs = [{ role: 'user', content: '你好' }];

    /* ───── transport ───── */
    const id = await addService({});
    const before = fake.requests.length;
    let evs = await run({ driver: 'api', provider: id, model: 'fake-model', messages: msgs, maxTokens: 1000 });
    rec('传输层是 Electron 的 net.fetch（Chromium 网络栈，跟系统代理）', net.transportName() === 'electron', net.transportName());
    rec('API 方式经 startStream 跑通：正文与用量', textOf(evs, 'text') === '你好，阁下。' && kinds(evs, 'done').length === 1 && kinds(evs, 'usage').length === 1, JSON.stringify(evs.slice(-3)));
    rec('没存密钥的 keyOptional 服务：不发鉴权头', fake.requests.length === before + 1 && !fake.requests[before].headers.authorization, JSON.stringify(fake.requests[before]?.headers));
    rec('本机 http 回环地址可用，请求体里没有 temperature', !('temperature' in fake.requests[before].body));

    /* ───── keys: first-key confirmation, slot, scrubbing ───── */
    const asked = [];
    const KEY = 'sk-fake-electron-SECRET-4242';
    const refused = await saveKeyOp(id, KEY, undefined, async (o) => { asked.push(o.title); return false; });
    rec('自定义服务第一次存密钥：先确认发往哪个主机，拒绝就不存', refused.ok === false && asked.length === 1 && !secrets.hints()[id], JSON.stringify(refused));
    const saved = await saveKeyOp(id, KEY, undefined, async (o) => { asked.push(o.title); return true; });
    rec('同意后加密保存，只返回末四位', saved.ok === true && saved.hint === '••••4242' && secrets.hints()[id] === '••••4242', JSON.stringify(saved));
    rec('密钥文件里没有明文', !fs.readFileSync(path.join(app.getPath('userData'), 'model-keys.json'), 'utf8').includes(KEY));
    const asked2 = [];
    await saveKeyOp(id, `${KEY}-2`, undefined, async (o) => { asked2.push(o.title); return false; });
    rec('同一主机之后再存：不再问', asked2.length === 0);
    await saveKeyOp(id, KEY, undefined, yes);
    fake.reset();
    evs = await run({ driver: 'api', provider: id, model: 'fake-model', messages: msgs, maxTokens: 1000 });
    rec('存了密钥：Authorization 带上，且密钥不在页面事件里', fake.requests[0]?.headers.authorization === `Bearer ${KEY}` && !JSON.stringify(evs).includes(KEY), JSON.stringify(fake.requests[0]?.headers));
    fake.script = 'echo-key-error'; fake.reset();
    evs = await run({ driver: 'api', provider: id, model: 'fake-model', messages: msgs, maxTokens: 1000 });
    rec('服务在 401 里回显密钥：页面事件里没有（API 路径过 scrubber）', kinds(evs, 'error').length === 1 && kinds(evs, 'error')[0].code === 'AUTH' && !JSON.stringify(evs).includes(KEY), JSON.stringify(evs).slice(0, 240));
    fake.script = 'echo-key-stream'; fake.reset();
    evs = await run({ driver: 'api', provider: id, model: 'fake-model', messages: msgs, maxTokens: 1000 });
    rec('流式文本把密钥切成两段：拼起来也没有', !textOf(evs, 'text').includes(KEY) && !JSON.stringify(evs).includes(KEY) && /••••/.test(textOf(evs, 'text')), textOf(evs, 'text'));
    const cleared = await clearKeyOp(id, undefined);
    rec('清除密钥', cleared.ok && !secrets.hints()[id]);

    /* ───── 审查修复：实时能力进主进程、没确认的主机不发密钥 ───── */
    {
      const orFx = JSON.parse(fs.readFileSync(path.join(__dirname, 'models', 'openrouter.json'), 'utf8'));
      fake2 = await startFake({ script: 'openai-ok', models: { '/v1/models': orFx } });
      const lr = await reg.saveService({
        name: '实时强度', endpoints: [{ id: 'main', label: '本机假服务', kind: 'local', baseUrl: fake2.baseUrl }],
        auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'anthropic/claude-opus-5-5' }],
        modelsApi: { path: '/models', parser: 'openrouter', auth: 'optional' }, wire: { maxTokensField: 'max_tokens', defaultMaxOut: 4096, testMaxTokens: 128 },
      }, { confirm: yes });
      const lid = lr.value.id;
      const chats = () => fake2.requests.filter((r) => r.method === 'POST');
      let e1 = await run({ driver: 'api', provider: lid, model: 'anthropic/claude-opus-5-5', effort: 'high', messages: msgs, maxTokens: 1000 });
      rec('还没拉过模型列表（没有缓存）：无规则的服务不能调，请求里没有推理字段，说一句「不能调节」', chats().length === 1 && !('reasoning' in chats()[0].body) && kinds(e1, 'notice').some((n) => /不能调节/.test(n.text)), JSON.stringify([chats()[0]?.body, kinds(e1, 'notice')]));
      const listed = await services.modelsApi(reg).listModels({ service: lid, fresh: true });
      rec('拉到实时列表（带账号能力）', listed.source === 'live' && listed.models.some((m) => m.id === 'anthropic/claude-opus-5-5' && m.effort), JSON.stringify(listed).slice(0, 240));
      fake2.reset();
      e1 = await run({ driver: 'api', provider: lid, model: 'anthropic/claude-opus-5-5', effort: 'high', messages: msgs, maxTokens: 1000 });
      rec('有缓存之后：startStream 用同一份实时能力，请求里是 reasoning.effort，不再说「不能调节」', chats().length === 1 && chats()[0].body.reasoning && chats()[0].body.reasoning.effort === 'high' && !kinds(e1, 'notice').some((n) => /不能调节/.test(n.text)), JSON.stringify([chats()[0]?.body, kinds(e1, 'notice')]));
      fake2.reset();
      e1 = await run({ driver: 'api', provider: lid, model: 'anthropic/claude-opus-5-5', messages: msgs, maxTokens: 1000 });
      rec('选「默认」：不发推理字段', chats().length === 1 && !('reasoning' in chats()[0].body));

      // 主机没经过确认：已存的密钥不发出去，页面看到一句说明
      const hostSvc = await reg.saveService({
        name: '没确认的主机', endpoints: [{ id: 'main', label: '本机假服务', kind: 'local', baseUrl: fake.baseUrl }],
        auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'fake-model' }], wire: { maxTokensField: 'max_tokens', defaultMaxOut: 4096, testMaxTokens: 128 },
      }, { confirm: yes });
      await secrets.save(hostSvc.value.id, 'sk-fake-unconfirmed-host-1');   // 绕开 saveKeyOp 的确认（页面按不到的路径）
      fake.reset();
      const eh = await run({ driver: 'api', provider: hostSvc.value.id, model: 'fake-model', messages: msgs, maxTokens: 1000 });
      rec('主机没确认过：不发请求，不带密钥，页面看到一句说明', fake.requests.length === 0 && kinds(eh, 'error').length === 1 && /还没有经过你确认/.test(kinds(eh, 'error')[0].message) && !JSON.stringify(eh).includes('sk-fake-unconfirmed'), JSON.stringify(eh).slice(0, 240));
      const okSave = await saveKeyOp(hostSvc.value.id, 'sk-fake-unconfirmed-host-1', undefined, yes);
      fake.reset();
      const eh2 = await run({ driver: 'api', provider: hostSvc.value.id, model: 'fake-model', messages: msgs, maxTokens: 1000 });
      rec('在界面里重新保存密钥（确认过主机）之后才发出去', okSave.ok && fake.requests.length === 1 && fake.requests[0].headers.authorization === 'Bearer sk-fake-unconfirmed-host-1' && kinds(eh2, 'done').length === 1, JSON.stringify(eh2).slice(0, 200));
      await clearKeyOp(hostSvc.value.id, undefined);
      fake.script = 'openai-ok'; fake.reset();
    }

    /* ───── forged specs ───── */
    fake.script = 'openai-ok'; fake.reset();
    evs = await run({
      driver: 'api-openai', provider: id, baseUrl: 'https://evil.example/v1', model: 'fake-model', messages: msgs, maxTokens: 1000,
      extraBody: { injected: 1, model: 'evil', reasoning_effort: 'max', thinking: { type: 'enabled' }, messages: [] },
      env: { OPENAI_BASE_URL: 'https://evil.example', NODE_OPTIONS: '--require x' }, keyEnv: 'OPENAI_API_KEY', acp: 'kimi', endpoint: 'main',
    });
    const body = fake.requests[0]?.body;
    rec('伪造的 StartSpec：请求仍然发往注册表里的地址（假服务），页面的 baseUrl 不生效', fake.requests.length === 1 && kinds(evs, 'done').length === 1, JSON.stringify(evs.slice(-2)));
    rec('伪造的 extraBody / model / messages 不进请求体', body && body.model === 'fake-model' && !('injected' in body) && !('reasoning_effort' in body) && !('thinking' in body) && body.messages.length === 1, JSON.stringify(body));
    for (const bad of ['nope', 'toString', '__proto__', 'constructor', '', undefined, 5, { a: 1 }]) {
      fake.reset();
      const e2 = await run({ driver: 'api', provider: bad, model: 'fake-model', messages: msgs });
      rec(`未知的 provider ${JSON.stringify(bad) ?? 'undefined'} 被拒，没有请求发出`, kinds(e2, 'error').length === 1 && fake.requests.length === 0, JSON.stringify(e2.slice(-1)));
    }
    let e3 = await run({ driver: 'api', provider: 'kimi', endpoint: 'code', model: 'k3.1-pro', messages: msgs });
    rec('套餐端点走 API：被拒，错误码 PLAN_KEY', kinds(e3, 'error')[0]?.code === 'PLAN_KEY', JSON.stringify(e3.slice(-1)));
    e3 = await run({ driver: 'api-openai', provider: 'qwen', baseUrl: 'https://coding.dashscope.aliyuncs.com/v1', model: 'qwen3.7-plus', messages: msgs });
    rec('旧页面只用 Coding Plan 的地址认地区：同样被拒', kinds(e3, 'error')[0]?.code === 'PLAN_KEY');
    e3 = await run({ driver: 'api', provider: id, model: 'a;b', messages: msgs });
    rec('API 路径也校验模型名', kinds(e3, 'error').length === 1 && fake.requests.length === 0);
    e3 = await run({ driver: 'api', provider: 'gpt', model: 'gpt-6-luna', messages: msgs });
    rec('没存密钥的预设服务：说明还没有密钥', kinds(e3, 'error')[0]?.message === '还没有保存这个服务的 API Key。', JSON.stringify(e3.slice(-1)));
    e3 = await run({ driver: 'api', provider: 'kimi', endpoint: 'global', model: 'kimi-k3', messages: msgs });
    rec('分地区存密钥的服务：说明是哪个地区', /国际/.test(kinds(e3, 'error')[0]?.message ?? ''), JSON.stringify(e3.slice(-1)));

    /* ───── notices from the resolver ───── */
    const eff = await addService({ models: [{ id: 'fake-model', effort: { style: 're', levels: ['low', 'high'] } }] });
    fake.script = 'openai-ok'; fake.reset();
    evs = await run({ driver: 'api', provider: eff, model: 'fake-model', effort: 'medium', messages: msgs });
    rec('档位降级的说明走页面事件，体里是 low', kinds(evs, 'notice').some((n) => n.text === '这个模型没有「中」，按「低」执行。') && fake.requests[0]?.body.reasoning_effort === 'low', JSON.stringify(kinds(evs, 'notice')));

    /* ───── ai:test ───── */
    fake.reset();
    const t1 = await test({ isDestroyed: () => false, send() {} }, { driver: 'api', provider: id, model: 'fake-model' });
    rec('连接测试：用服务自己的 testMaxTokens，只有一条测试消息，通过', t1.ok === true && fake.requests[0]?.body.max_tokens === 128 && fake.requests[0]?.body.messages.length === 1, JSON.stringify(t1));
    const t2 = await test({ isDestroyed: () => false, send() {} }, { driver: 'api', provider: 'kimi', endpoint: 'code', model: 'k3.1-pro' });
    rec('连接测试：套餐端点的 API 方式被拒（PLAN_KEY）', t2.ok === false && t2.code === 'PLAN_KEY', JSON.stringify(t2));

    /* ───── command-line agents: the environment is decided here ───── */
    const NODE = process.env.ALIGHT_NODE || 'node';
    const acpScript = path.join(APP, 'scripts', 'probe', 'hook-probe', 'fake-acp.cjs');
    const fakeCmd = (name) => { const f = path.join(root, name); fs.writeFileSync(f, `@echo off\r\n"${NODE}" "${acpScript}" %*\r\n`); return f; };
    const cmd = fakeCmd('agent.cmd');
    const work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    const dump = path.join(root, 'env-dump.json');
    const KEYS = 'OPENAI_BASE_URL,OPENAI_MODEL,OPENAI_API_KEY,NODE_OPTIONS,ANTHROPIC_API_KEY,PATH,GEMINI_API_KEY';
    const runAgent = async (spec) => {
      try { fs.unlinkSync(dump); } catch { /* none */ }
      process.env.FAKE_ACP_ENV_DUMP = dump;
      process.env.FAKE_ACP_ENV_KEYS = KEYS;
      const e = await run({ access: 'chat', cwd: work, prompt: '你好', path: cmd, ...spec });
      let env = null;
      try { env = JSON.parse(fs.readFileSync(dump, 'utf8')).env; } catch { /* the agent never started */ }
      return { evs: e, env };
    };
    const forged = { env: { PATH: 'C:/evil', NODE_OPTIONS: '--require evil.js', OPENAI_BASE_URL: 'https://evil.example/v1', OPENAI_API_KEY: 'sk-from-the-page', OPENAI_MODEL: 'page-model' }, keyEnv: 'ANTHROPIC_API_KEY' };
    let a = await runAgent({ driver: 'qwen', provider: 'qwen', ...forged });
    rec('Qwen 需要密钥：没存就说明，不会启动', kinds(a.evs, 'error')[0]?.message === '这个方式需要 API Key，请先在「模型接入」里保存。' && a.env === null, JSON.stringify(a.evs.slice(-1)));
    const QK = 'sk-qwen-fake-key-7777';
    const qs = await saveKeyOp('qwen', QK, 'cn', yes);
    rec('Qwen 国内站的密钥存进自己的槽 qwen:cn', qs.ok && !!secrets.hints()['qwen:cn'] && !secrets.hints().qwen, JSON.stringify(secrets.hints()));
    a = await runAgent({ driver: 'qwen', provider: 'qwen', endpoint: 'cn', model: 'qwen3.8-max', ...forged });
    rec('Qwen：环境 = 注册表的地址 + 所选模型 + 保存的密钥', a.env && a.env.OPENAI_BASE_URL === 'https://dashscope.aliyuncs.com/compatible-mode/v1' && a.env.OPENAI_MODEL === 'qwen3.8-max' && a.env.OPENAI_API_KEY === QK, JSON.stringify(a.env));
    rec('页面传来的 PATH / NODE_OPTIONS / 地址 / 密钥变量全部没有生效', a.env && a.env.PATH !== 'C:/evil' && a.env.NODE_OPTIONS === null && a.env.ANTHROPIC_API_KEY === null, JSON.stringify(a.env && { PATH: a.env.PATH?.slice(0, 20), N: a.env.NODE_OPTIONS, A: a.env.ANTHROPIC_API_KEY }));
    rec('代理跑完；密钥不在页面事件里', kinds(a.evs, 'done').length === 1 && !JSON.stringify(a.evs).includes(QK), JSON.stringify(a.evs.slice(-2)));
    a = await runAgent({ driver: 'acp', acp: 'qwen', provider: 'qwen', env: { OPENAI_BASE_URL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', OPENAI_MODEL: 'qwen3.7-plus' }, keyEnv: 'OPENAI_API_KEY' });
    rec("旧页面构建（driver:'acp' + env）认出国际站，国际站没存密钥所以不启动", kinds(a.evs, 'error').length === 1 && a.env === null, JSON.stringify(a.evs.slice(-1)));
    a = await runAgent({ driver: 'kimi', provider: 'kimi' });
    rec("旧驱动名 'kimi' 仍然映射到 Kimi 代理，且不需要环境", kinds(a.evs, 'done').length === 1 && a.env && a.env.OPENAI_API_KEY === null, JSON.stringify(a.evs.slice(-2)));
    a = await runAgent({ driver: 'acp', acp: 'kimi', provider: 'kimi' });
    rec("driver:'acp' + acp:'kimi' 同样可用", kinds(a.evs, 'done').length === 1);
    a = await runAgent({ driver: 'acp:gemini', provider: 'gemini' });
    rec('新代理 acp:gemini：可选密钥没存也能启动，环境里没有 GEMINI_API_KEY', kinds(a.evs, 'done').length === 1 && a.env && a.env.GEMINI_API_KEY === null, JSON.stringify(a.evs.slice(-2)));
    await saveKeyOp('gemini', 'AIza-fake-gemini-key-1', undefined, yes);
    a = await runAgent({ driver: 'acp:gemini', provider: 'gemini' });
    rec('存了密钥：GEMINI_API_KEY 由主进程放进去', a.env && a.env.GEMINI_API_KEY === 'AIza-fake-gemini-key-1' && !JSON.stringify(a.evs).includes('AIza-fake-gemini-key-1'), JSON.stringify(a.env));
    a = await runAgent({ driver: 'qwen', provider: 'doubao' });
    rec('一家的密钥不会交给另一家的工具（doubao + qwen 被拒）', kinds(a.evs, 'error').length === 1 && /不支持/.test(kinds(a.evs, 'error')[0].message), JSON.stringify(a.evs.slice(-1)));
    a = await runAgent({ driver: 'acp:nope', provider: 'kimi' });
    rec('不存在的代理被拒', kinds(a.evs, 'error').length === 1 && a.env === null);
    a = await runAgent({ driver: 'codex', provider: 'kimi' });
    rec('服务没有列出的内置驱动被拒（kimi + codex）', kinds(a.evs, 'error').length === 1);
    a = await runAgent({ driver: 'kimi', provider: 'kimi', model: 'a;b' });
    rec('命令行路径也校验模型名', kinds(a.evs, 'error').length === 1 && /模型名/.test(kinds(a.evs, 'error')[0].message), JSON.stringify(a.evs.slice(-1)));

    /* ───── small pieces ───── */
    rec('envProblem：已知的名字通过，PATH / NODE_OPTIONS 不通过', envProblem({ ANTHROPIC_BASE_URL: 'x', CLAUDE_CONFIG_DIR: 'x', ANTHROPIC_AUTH_TOKEN: 'x' }) === '' && envProblem({ PATH: 'x' }) === 'PATH' && envProblem({ NODE_OPTIONS: 'x' }) === 'NODE_OPTIONS' && envProblem({ GEMINI_API_KEY: 'x' }, ['GEMINI_API_KEY']) === '');
    const d1 = driverDef('acp:gemini');
    const d2 = driverDef('kimi');
    rec('driverDef：新代理与旧驱动名都认；claude-code / codex / dsh 照旧', d1 && d1.label === 'Gemini CLI' && d1.acpArgs[0] === '--acp' && d2 && d2.label === 'Kimi Code' && d2.acpArgs[0] === 'acp' && driverDef('codex').label === 'Codex' && driverDef('dsh').bin === 'dsh' && driverDef('claude-code').login.join() === 'auth,login' && driverDef('claude-compat') === null && driverDef('acp:nope') === null);
    rec('services.json 落在 userData 里，没有密钥', fs.existsSync(path.join(app.getPath('userData'), 'services.json')) && !fs.readFileSync(path.join(app.getPath('userData'), 'services.json'), 'utf8').includes(KEY));

    // redirect:'error' through the real stack
    fake.script = 'redirect-302'; fake.reset();
    const idr = await addService({});
    evs = await run({ driver: 'api', provider: idr, model: 'fake-model', messages: msgs });
    rec("net.fetch + redirect:'error'：不跟随，EREDIRECT，没有向重定向目标发请求", kinds(evs, 'error')[0]?.code === 'EREDIRECT' && !fake.requests.some((q) => q.path.startsWith('/elsewhere')), JSON.stringify(evs.slice(-1)));
    // a stop in the middle of a stream
    fake.script = 'openai-slow-stream'; fake.reset();
    const idp = await addService({});
    const stopEvs = await new Promise((resolve) => {
      const events = [];
      let sid;
      const sender = { isDestroyed: () => false, send: (_ch, ev) => { events.push(ev); if (ev.type === 'text' && !events.stopped) { events.stopped = true; ai.__test.streams.get(sid).ctl.interrupt(); } if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve(events), 30); } };
      sid = startStream(sender, { driver: 'api', provider: idp, model: 'fake-model', messages: msgs });
      setTimeout(() => resolve(events.concat([{ type: 'timeout' }])), 15000);
    });
    rec('流进行中点停止：以 interrupted 结束（net.fetch 的 AbortSignal）', kinds(stopEvs, 'done')[0]?.stopReason === 'interrupted', JSON.stringify(stopEvs.slice(-2)));
    void fake2;
  } catch (e) {
    rec('脚本跑到了最后', false, (e && e.stack) || e);
  }
  try { if (fake) await fake.close(); } catch { /* closing */ }
  try { if (fake2) await fake2.close(); } catch { /* closing */ }
  const out = process.env.ALIGHT_SVC_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(results));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* still in use: leave it in the temp folder */ }
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
