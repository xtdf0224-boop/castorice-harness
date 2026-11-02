// 无头 Electron 检查：真正的 electron/ai/index.cjs（密钥保管、认证路径、预算、驱动选择、环境清理）接假 Anthropic 服务。
//   electron.exe scripts/probe/hook-probe/electron-check.cjs        （不开任何窗口；用临时 userData 与临时 CLAUDE_CONFIG_DIR）
// 由 check-engine 在 electron 二进制存在时调用；也可以单独跑。输出以 "ok " / "FAIL " 开头，最后一行 "RESULT <失败数>".
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const APP = path.resolve(__dirname, '..', '..', '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-electron-check-'));
app.setPath('userData', path.join(root, 'userData'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
// 子进程（claude）用临时配置目录，不碰用户的 ~/.claude；别让真实的密钥混进来
process.env.CLAUDE_CONFIG_DIR = path.join(root, 'claude-config');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
for (const k of Object.keys(process.env)) if (/^ANTHROPIC_|^CLAUDE_CODE_OAUTH/i.test(k)) delete process.env[k];
process.env.ANTHROPIC_API_KEY = 'sk-ant-LEAK-CANARY-should-never-be-sent';

let failures = 0;
const expect = (label, cond, extra = '') => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`); if (!cond) failures += 1; };

app.whenReady().then(async () => {
  try {
    const { startFakeAnthropic, FAST_MODEL } = await import(require('node:url').pathToFileURL(path.join(__dirname, 'fake-anthropic.mjs')).href);
    const fake = await startFakeAnthropic();
    // 页面不能再指定一次运行发往哪个地址（MODELS-SPEC I1）：假服务经进程环境接进去，就像用户自己设的 ANTHROPIC_BASE_URL。
    process.env.ANTHROPIC_BASE_URL = fake.url;
    process.env.ANTHROPIC_MODEL = 'claude-sonnet-5-5';
    process.env.ANTHROPIC_SMALL_FAST_MODEL = FAST_MODEL;
    const ai = require(path.join(APP, 'electron', 'ai', 'index.cjs'));
    const secrets = require(path.join(APP, 'electron', 'ai', 'secrets.cjs'));
    const services = require(path.join(APP, 'electron', 'ai', 'services.cjs'));
    const { authStore, startStream, streams, detect, claudeAuthView } = ai.__test;
    const work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    // 信任以主进程的账本为准（electron/trust.cjs）：测试目录先授予 T1，否则会被当 T0 只读
    const trustMod = require(path.join(APP, 'electron', 'trust.cjs'));
    const trustStore = trustMod.createTrustStore(path.join(app.getPath('userData'), 'trust.json'));
    expect('测试目录授予 T1（账本在 userData/trust.json）', trustStore.grant(work).ok === true);

    const run = (spec, react) => new Promise((resolve) => {
      const events = [];
      let id;
      const sender = {
        isDestroyed: () => false,
        send: (_ch, ev) => {
          events.push(ev);
          if (react) react(ev, id);
          if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve(events), 50);
        },
      };
      id = startStream(sender, {
        driver: 'claude-code', provider: 'claude', cwd: work, prompt: '探针：按脚本执行。', access: 'work', permissionMode: 'ask', phase: 'step',
        ...spec,
      });
      setTimeout(() => resolve(events.concat([{ type: 'timeout' }])), 60000);
    });
    const answerAllow = (ev, id) => { if (ev.type === 'permission') { const s = streams.get(id); s && s.ctl.answer(ev.requestId, 'allow', ev.input); } };
    const write = (name) => ({ blocks: [{ type: 'text', text: '试写。' }, { type: 'tool_use', name: 'Write', input: { file_path: path.join(work, name), content: 'probe\n' } }] });
    const say = (t) => ({ blocks: [{ type: 'text', text: t }] });
    const kinds = (evs, t) => evs.filter((e) => e.type === t);

    // 1. 检测：用临时配置目录，claude 报告未登录；解析出 login 状态
    const det = await detect({ driver: 'claude-code' });
    expect('detect 找到了 claude（用户自己的或随包的）', det.found === true, JSON.stringify(det).slice(0, 200));
    expect('临时配置目录下 claude 报告未登录', det.login === 'no', `login=${det.login}`);

    // 2. 登录路径：环境里残留的 ANTHROPIC_API_KEY 不能被带进去（金丝雀）
    fake.reset();
    fake.queue([say('不该有请求。')]);
    const r1 = await run({});
    expect('登录路径：环境里的密钥金丝雀没有发到任何地方', fake.requests.every((r) => !String(r.apiKey || '').includes('LEAK-CANARY')), JSON.stringify(fake.requests.map((r) => r.apiKey)));
    expect('登录路径：没登录时以认证错误结束（不是悄悄走 API 计费）', kinds(r1, 'error').length === 1 && kinds(r1, 'error')[0].code === 'AUTH', JSON.stringify(r1.slice(-2)));

    // 3. API 密钥路径：没有存密钥 → 说明；存了密钥、设了预算 → 能跑，计入账本
    authStore().setConfig({ mode: 'apikey', dailyUsd: 5, monthlyUsd: 50, apiAck: true });
    const r2 = await run({});
    expect('API 路径：没存密钥 → 明确的说明', kinds(r2, 'error').length === 1 && /还没有保存 Claude 的 API Key/.test(kinds(r2, 'error')[0].message), JSON.stringify(r2.slice(-1)));
    await Promise.resolve(secrets.save('claude', 'sk-ant-fake-electron-check-0000'));
    fake.reset();
    fake.queue([write('e1.txt'), say('写好了。')]);
    const r3 = await run({}, answerAllow);
    const done3 = kinds(r3, 'done')[0];
    expect('API 路径：跑完一个回合', !!done3, JSON.stringify(r3.slice(-2)));
    expect('API 路径：明示「按用量计费」', kinds(r3, 'notice').some((n) => /API 密钥，按用量计费/.test(n.text)), kinds(r3, 'notice').map((n) => n.text).join(' | '));
    expect('API 路径：注入的是保存的那把密钥，不是环境里的', fake.requests.filter((r) => !r.other).length > 0 && fake.requests.filter((r) => !r.other).every((r) => r.apiKey === 'sk-ant-fake-electron-check-0000'), JSON.stringify(fake.requests.map((r) => r.apiKey)));
    expect('API 路径：done 带 costUsd', done3 && done3.costUsd > 0, JSON.stringify(done3));
    expect('API 路径：文件写出来了（审批走通）', fs.existsSync(path.join(work, 'e1.txt')));
    const spent = authStore().spend();
    expect('账本记下了今天的花费', spent.today > 0 && Math.abs(spent.today - done3.costUsd) < 1e-6, JSON.stringify(spent));
    expect('密钥没有出现在页面收到的任何事件里', !JSON.stringify(r3).includes('sk-ant-fake-electron-check-0000'));
    expect('账本文件里没有密钥', !/sk-ant/.test(fs.readFileSync(authStore().files.spendFile, 'utf8') + fs.readFileSync(authStore().files.cfgFile, 'utf8')));

    // 3a. API 密钥路径：模型运行的命令读不到环境里的密钥（claude 把凭据从子进程环境里剥掉）；因此「放手」等自动放行档在这里降为逐项确认
    fake.reset();
    fake.queue([{ blocks: (req) => [{ type: 'text', text: '看看环境。' }, req.tools.includes('Bash') ? { type: 'tool_use', name: 'Bash', input: { command: 'echo "K=[$ANTHROPIC_API_KEY]" > envdump.txt' } } : { type: 'tool_use', name: 'PowerShell', input: { command: 'Set-Content -Path envdump.txt -Value ("K=[" + $env:ANTHROPIC_API_KEY + "]")' } }] }, say('好了。')]);
    const r3a = await run({ permissionMode: 'bypass' }, answerAllow);
    const dump = path.join(work, 'envdump.txt');
    expect('API 路径：「放手」降级为逐项，并说明原因', kinds(r3a, 'notice').some((n) => /已降级为逐项确认/.test(n.text)) && kinds(r3a, 'permission').length > 0, kinds(r3a, 'notice').map((n) => n.text).join(' | '));
    expect('API 路径：命令读不到环境里的密钥', fs.existsSync(dump) && !fs.readFileSync(dump, 'utf8').includes('sk-ant'), fs.existsSync(dump) ? fs.readFileSync(dump, 'utf8') : '没有生成文件');

    // 3b. 页面自称 T1，但主进程账本里这个目录是 T0：只读，写入被拒绝（页面报的级别只能往下调，不能抬高）
    const work2 = path.join(root, 'work-untrusted');
    fs.mkdirSync(work2, { recursive: true });
    fake.reset();
    fake.queue([{ blocks: [{ type: 'text', text: '试写。' }, { type: 'tool_use', name: 'Write', input: { file_path: path.join(work2, 'e2.txt'), content: 'probe\n' } }] }, say('结束。')]);
    const r3b = await run({ cwd: work2, trust: 'T1' }, answerAllow);
    expect('未信任目录：页面自称 T1 也写不出文件', !!kinds(r3b, 'done')[0] && !fs.existsSync(path.join(work2, 'e2.txt')), JSON.stringify(r3b.slice(-2)));

    // 4. 超预算：不再启动，错误码 BUDGET（进「待你·失败」）
    authStore().setConfig({ dailyUsd: 0.0005, monthlyUsd: 50 });
    fake.reset();
    const r4 = await run({});
    expect('超预算：以 BUDGET 结束，说明是哪个预算', kinds(r4, 'error')[0]?.code === 'BUDGET' && /日预算/.test(kinds(r4, 'error')[0].message), JSON.stringify(r4.slice(-1)));
    expect('超预算：没有向服务发任何请求', fake.requests.length === 0);

    // 5. 预算够但已用到 80%：提示一句
    authStore().setConfig({ dailyUsd: authStore().spend().today / 0.9, monthlyUsd: 50 });   // 今天已花的约 90%：落在 80%–100% 之间
    fake.reset();
    fake.queue([say('好。')]);
    const r5 = await run({});
    expect('快用完时给出提示', kinds(r5, 'notice').some((n) => /80%/.test(n.text)), kinds(r5, 'notice').map((n) => n.text).join(' | '));

    // 6. 路径页面的视图
    authStore().setConfig({ mode: 'login' });
    const view = await claudeAuthView();
    expect('视图：模式、密钥已存、用的 claude', view.config.mode === 'login' && view.keySaved === true && !!(view.exe.own || view.exe.bundled), JSON.stringify(view).slice(0, 300));

    // 7. 关掉 SDK 开关 → 旧驱动，并说明
    authStore().setConfig({ useSdk: false });
    fake.reset();
    fake.queue([say('旧驱动。')]);
    const r7 = await run({});
    expect('关掉 SDK：发了「改用旧驱动」的说明', kinds(r7, 'notice').some((n) => /旧的 stream-json 驱动/.test(n.text)), kinds(r7, 'notice').map((n) => n.text).join(' | '));

    // 8. 旧驱动（claude-compat，兼容端点）：账本里这个目录是 T0、页面却按「可写 + 接受编辑」下发 → 主进程自己落实只读（写入不出文件）
    //    这是旧任务（没有 trust 字段）或建任务后撤销了信任的真实情形：页面不会重新问，也不会发 T0
    // 兼容端点：一个自定义服务，Anthropic 兼容地址就是假服务（环境由主进程按注册表生成，页面的 env / keyEnv 不再算数）
    const compatSaved = await services.instance().saveService({
      name: '探针兼容', endpoints: [{ id: 'main', label: '探针', kind: 'local', baseUrl: fake.url, compatUrl: fake.url }],
      auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'claude-sonnet-5-5', ctx: 200000 }], drivers: ['claude-compat'],
    }, { confirm: async () => true });
    expect('兼容端点：自定义服务保存成功', compatSaved.ok === true, JSON.stringify(compatSaved));
    const compatId = compatSaved.value.id;
    // 与界面同一条路：先确认密钥发往的主机，再存（直接写进槽的密钥不会发往没确认过的主机）
    await ai.__test.saveKeyOp(compatId, 'sk-fake-compat-check-key-1234', undefined, async () => true);
    // 兼容环境把所有模型槽都钉成同一个模型，后台的小请求和主请求同名；假服务按「没有工具」认出它们（不消耗脚本）
    fake.sideByNoTools = true;
    fake.reset();
    fake.queue([{ blocks: [{ type: 'text', text: '试写。' }, { type: 'tool_use', name: 'Write', input: { file_path: path.join(work2, 'e3.txt'), content: 'probe\n' } }] }, say('结束。')]);
    const r8 = await run({
      driver: 'claude-compat', provider: compatId, cwd: work2, trust: 'T1', permissionMode: 'acceptEdits',
      allow: ['TodoWrite', 'Write', 'Edit', 'Bash'], deny: [],
    }, answerAllow);
    expect('旧驱动：跑完了（走的是假服务）', !!kinds(r8, 'done')[0] && fake.requests.length > 0, JSON.stringify(r8.slice(-2)));
    expect('旧驱动：账本 T0 + 页面按可写下发 → 写不出文件', !fs.existsSync(path.join(work2, 'e3.txt')));
    expect('旧驱动：说明这次按只读运行', kinds(r8, 'notice').some((n) => /没有被信任/.test(n.text)), kinds(r8, 'notice').map((n) => n.text).join(' | '));
    expect('旧驱动：密钥没有出现在页面事件里', !JSON.stringify(r8).includes('sk-fake-compat-check-key-1234'));
    // 对照：同样的下发，可写的受信目录 + 接受编辑 → 文件写得出来
    fake.reset();
    fake.queue([{ blocks: [{ type: 'text', text: '试写。' }, { type: 'tool_use', name: 'Write', input: { file_path: path.join(work, 'e4.txt'), content: 'probe\n' } }] }, say('结束。')]);
    const r8b = await run({
      driver: 'claude-compat', provider: compatId, cwd: work, trust: 'T1', permissionMode: 'acceptEdits',
      allow: ['TodoWrite', 'Write', 'Edit', 'Bash'], deny: [],
    }, answerAllow);
    expect('旧驱动对照：受信目录里同样的写入能成功', !!kinds(r8b, 'done')[0] && fs.existsSync(path.join(work, 'e4.txt')), JSON.stringify(r8b.slice(-2)));

    // 8b. 旧驱动的花费：同一会话再来一个回合，done.costUsd 是这一回合的增量（不是会话累计值，页面逐回合累加会重复计入）
    const sid8 = kinds(r8b, 'done')[0]?.sessionId;
    const c1 = kinds(r8b, 'done')[0]?.costUsd;
    fake.reset();
    fake.queue([say('第二轮。')]);
    const r8c = await run({
      driver: 'claude-compat', provider: compatId, cwd: work, trust: 'T1', permissionMode: 'ask', sessionId: sid8, deny: [],
    }, answerAllow);
    const c2 = kinds(r8c, 'done')[0]?.costUsd;
    expect('旧驱动：同一会话第二个回合也跑完了', !!sid8 && !!kinds(r8c, 'done')[0], JSON.stringify(r8c.slice(-2)));
    expect('旧驱动：第二个回合的 costUsd 是增量（比累计值小得多），不是累计值', typeof c1 === 'number' && typeof c2 === 'number' && c2 > 0 && c2 < c1 * 1.6, `第一回合 ${c1}，第二回合 ${c2}`);

    fake.sideByNoTools = false;

    // 9. 其他引擎的接线（假的 kimi / dsh 命令）：计划批准之后的执行阶段不再停在只读里；账本 T0 一律只读
    const NODE = process.env.ALIGHT_NODE || 'node';
    const fakeCmd = (name, script) => { const f = path.join(root, name); fs.writeFileSync(f, `@echo off\r\n"${NODE}" "${path.join(__dirname, script)}" %*\r\n`); return f; };
    const kimiCmd = fakeCmd('kimi.cmd', 'fake-acp.cjs');
    const dshCmd = fakeCmd('dsh.cmd', 'fake-dsh.cjs');
    const acpRun = async (spec, current = 'default') => {
      const log = path.join(root, `acp-${Math.random().toString(36).slice(2)}.log`);
      process.env.FAKE_ACP_LOG = log;
      process.env.FAKE_ACP_CURRENT = current;
      const evs = await run({ driver: 'acp', acp: 'kimi', provider: 'kimi', path: kimiCmd, ...spec });
      return { evs, modes: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).modeId) : [] };
    };
    const a1 = await acpRun({ permissionMode: 'plan', phase: 'step' }, 'yolo');
    expect('Kimi：页面选「计划」，批准后的执行阶段 → default（不是 plan）', kinds(a1.evs, 'done').length === 1 && a1.modes.join() === 'default', `${a1.modes.join()} ${JSON.stringify(a1.evs.slice(-2))}`);
    const a2 = await acpRun({ permissionMode: 'plan', phase: 'plan' }, 'yolo');
    expect('Kimi：计划阶段 → plan', a2.modes.join() === 'plan', a2.modes.join());
    const a3 = await acpRun({ permissionMode: 'bypass', phase: 'step', cwd: work2, trust: 'T1' }, 'yolo');
    expect('Kimi：账本 T0（页面自称 T1、放手）→ 仍然切到 plan', a3.modes.join() === 'plan' && kinds(a3.evs, 'notice').some((n) => /没有被信任/.test(n.text)), `${a3.modes.join()} ${kinds(a3.evs, 'notice').map((n) => n.text).join(' | ')}`);
    const a4 = await acpRun({ permissionMode: 'bypass', phase: 'step' }, 'default');
    expect('Kimi 对照：受信目录 + 放手 → yolo', a4.modes.join() === 'yolo', a4.modes.join());
    const dshRun = async (spec) => {
      process.env.FAKE_DSH_SEEN = path.join(root, `dsh-${Math.random().toString(36).slice(2)}.json`);
      await run({ driver: 'dsh', provider: 'deepseek', path: dshCmd, ...spec });
      return JSON.parse(fs.readFileSync(process.env.FAKE_DSH_SEEN, 'utf8')).mode;
    };
    expect('DSH：页面选「计划」，批准后的执行阶段 → 不是 read-only', (await dshRun({ permissionMode: 'plan', phase: 'step' })) === '');
    expect('DSH：计划阶段 → read-only', (await dshRun({ permissionMode: 'plan', phase: 'plan' })) === 'read-only');
    expect('DSH：账本 T0 → read-only', (await dshRun({ permissionMode: 'ask', phase: 'step', cwd: work2, trust: 'T1' })) === 'read-only');

    await fake.close();
  } catch (e) {
    expect('检查本身没有抛异常', false, String(e && e.stack || e));
  }
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 400 }); } catch { /* 临时目录，仍被占用就留着 */ }
  console.log(`RESULT ${failures}`);
  app.exit(failures ? 1 : 0);
});
