'use strict';
// T-ACP, Electron half: the real index.cjs (startStream, driverDef, exeFor, detect) with the real service registry and agents, in a windowless Electron main,
// against the fake ACP agent. Launched by check-services.ts (ALIGHT_INT_OUT names the result file).
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

app.disableHardwareAcceleration();
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-acp-int-'));
app.setPath('userData', path.join(root, 'userData'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC_|OPENAI_|GEMINI_|CLAUDE_CODE_|NODE_OPTIONS$)/i.test(k)) delete process.env[k];
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: ok ? '' : String(detail === undefined ? '' : detail) }); };
const APP = path.resolve(__dirname, '..', '..');
const yes = async () => true;

app.whenReady().then(async () => {
  try {
    const ai = require(path.join(APP, 'electron', 'ai', 'index.cjs'));
    const services = require(path.join(APP, 'electron', 'ai', 'services.cjs'));
    const secrets = require(path.join(APP, 'electron', 'ai', 'secrets.cjs'));
    const acpAgents = require(path.join(APP, 'electron', 'ai', 'acp-agents.cjs'));
    const { startStream, saveKeyOp, driverDef, exeFor, envProblem, detect } = ai.__test;
    const reg = services.instance();
    const ag = acpAgents.instance();
    const NODE = process.env.ALIGHT_NODE || 'node';
    const fakeAcp = path.join(APP, 'scripts', 'fixtures', 'fake-acp.cjs');
    const cmd = path.join(root, 'agent.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n"${NODE}" "${fakeAcp}" %*\r\n`);
    const work = path.join(root, 'work');
    fs.mkdirSync(work, { recursive: true });
    const dump = path.join(root, 'env-dump.json');
    process.env.FAKE_ACP_ENV_DUMP = dump;
    process.env.FAKE_ACP_ENV_KEYS = 'MY_AGENT_KEY,OPENAI_API_KEY,ANTHROPIC_API_KEY,PATH';
    const run = (spec) => new Promise((resolve) => {
      const events = [];
      const sender = { isDestroyed: () => false, send: (_ch, ev) => { events.push(ev); if (ev.type === 'done' || ev.type === 'error') setTimeout(() => resolve(events), 30); } };
      startStream(sender, spec);
      setTimeout(() => resolve(events.concat([{ type: 'timeout' }])), 25000);
    });
    const kinds = (evs, t) => evs.filter((e) => e.type === t);
    const envOf = () => { try { return JSON.parse(fs.readFileSync(dump, 'utf8')).env; } catch { return null; } };
    const clearDump = () => { try { fs.unlinkSync(dump); } catch { /* none */ } };

    /* the service registry knows the stand-alone agents as services */
    rec('reg.get：独立代理是服务（acp_opencode），绑定了服务的代理不是（acp_kimi）', !!reg.get('acp_opencode') && reg.get('acp_opencode').group === 'cli' && reg.get('acp_kimi') === undefined && reg.get('acp_nope') === undefined);
    rec('伪服务的密钥槽被认作已知（isKnown）', reg.isKnown('acp_opencode') === true && reg.isKnown('acp_nope') === false);
    rec('driverDef：新代理 / 旧驱动名', driverDef('acp:opencode').label === 'OpenCode' && driverDef('acp:opencode').acpArgs[0] === 'acp' && driverDef('kimi').label === 'Kimi Code' && driverDef('acp:nope') === null && driverDef('codex').label === 'Codex');

    /* a stand-alone preset agent, started through the service card the page names */
    clearDump();
    let evs = await run({ driver: 'acp:opencode', provider: 'acp_opencode', path: cmd, cwd: work, access: 'chat', prompt: '你好' });
    rec('独立代理（OpenCode 的伪服务）跑通一个回合', kinds(evs, 'done').length === 1 && !!envOf(), JSON.stringify(evs.slice(-2)));
    clearDump();
    evs = await run({ driver: 'acp:opencode', provider: 'acp_opencode', path: cmd, cwd: work, access: 'chat', prompt: '你好', env: { OPENAI_API_KEY: 'sk-forged', PATH: 'C:/evil' }, keyEnv: 'ANTHROPIC_API_KEY' });
    const e1 = envOf();
    rec('页面伪造的 env / keyEnv 不生效', kinds(evs, 'done').length === 1 && e1 && e1.OPENAI_API_KEY === null && e1.ANTHROPIC_API_KEY === null && e1.PATH !== 'C:/evil', JSON.stringify(e1 && { O: e1.OPENAI_API_KEY, A: e1.ANTHROPIC_API_KEY }));
    evs = await run({ driver: 'acp:opencode', provider: 'acp_nope', path: cmd, cwd: work, access: 'chat', prompt: 'x' });
    rec('不存在的伪服务被拒', kinds(evs, 'error').length === 1, JSON.stringify(evs.slice(-1)));
    evs = await run({ driver: 'acp:opencode', provider: 'claude', path: cmd, cwd: work, access: 'chat', prompt: 'x' });
    rec('别家的服务不能借用这个代理（claude + acp:opencode 被拒）', kinds(evs, 'error').length === 1 && /不支持/.test(kinds(evs, 'error')[0].message), JSON.stringify(evs.slice(-1)));
    evs = await run({ driver: 'acp:goose', provider: 'acp_opencode', path: cmd, cwd: work, access: 'chat', prompt: 'x' });
    rec('伪服务不能驱动另一个代理（acp_opencode + acp:goose 被拒）', kinds(evs, 'error').length === 1, JSON.stringify(evs.slice(-1)));
    evs = await run({ driver: 'acp:opencode', provider: 'acp_opencode', cwd: work, access: 'chat', prompt: 'x' });
    rec('PATH 里没有的代理：说明去装，不崩', kinds(evs, 'error').length === 1 && /找不到 OpenCode 命令/.test(kinds(evs, 'error')[0].message), JSON.stringify(evs.slice(-1)));

    /* detection */
    const det = await detect({ driver: 'acp:opencode', path: cmd });
    rec('ai:detect 认新代理，用命令路径', det.found === true, JSON.stringify(det));
    rec('ai:detect：没装', (await detect({ driver: 'acp:goose' })).found === false);

    /* a command of the user's own, with one key variable */
    const picked = await ag.pickExe({}, async () => cmd);
    const added = await ag.addCustom({ token: picked.value.token, label: '我的代理', args: ['--acp'], envNames: ['MY_AGENT_KEY'] }, yes);
    const id = added.value.id;
    rec('登记自定义命令', added.ok && !!reg.get(`acp_${id}`), JSON.stringify(added));
    rec('driverDef / exeFor：用户登记的代理也认', driverDef(`acp:${id}`).label === '我的代理' && driverDef(`acp:${id}`).acpArgs[0] === '--acp' && exeFor(`acp:${id}`) === cmd);
    clearDump();
    evs = await run({ driver: `acp:${id}`, provider: `acp_${id}`, cwd: work, access: 'chat', prompt: '你好' });
    rec('自定义命令：没存密钥也能跑（密钥可不填），环境里没有 MY_AGENT_KEY', kinds(evs, 'done').length === 1 && envOf() && envOf().MY_AGENT_KEY === null, JSON.stringify(evs.slice(-2)));
    const KEY = 'k-agent-secret-424242';
    const saved = await saveKeyOp(`acp_${id}`, KEY, undefined, yes);
    rec('密钥存进伪服务的槽（页面只传服务 id）', saved.ok && !!secrets.hints()[`acp_${id}`], JSON.stringify(saved));
    clearDump();
    evs = await run({ driver: `acp:${id}`, provider: `acp_${id}`, cwd: work, access: 'chat', prompt: '你好' });
    rec('存了密钥：由主进程放进它声明的变量；密钥不进页面事件', kinds(evs, 'done').length === 1 && envOf() && envOf().MY_AGENT_KEY === KEY && !JSON.stringify(evs).includes(KEY), JSON.stringify(envOf()));
    clearDump();
    evs = await run({ driver: `acp:${id}`, provider: `acp_${id}`, cwd: work, access: 'chat', prompt: '你好', keyEnv: 'ANTHROPIC_API_KEY', env: { MY_AGENT_KEY: 'forged' } });
    rec('页面的 keyEnv / env 不改变这个密钥的去向', envOf() && envOf().MY_AGENT_KEY === KEY && envOf().ANTHROPIC_API_KEY === null);
    rec('envProblem：声明过的变量名被放行', envProblem({ MY_AGENT_KEY: 'x' }, ['MY_AGENT_KEY']) === '' && envProblem({ MY_AGENT_KEY: 'x' }) === 'MY_AGENT_KEY');
    const rm = ag.remove(id);
    rec('移除自定义命令：服务、密钥槽都没了', rm.ok && !reg.get(`acp_${id}`) && !secrets.hints()[`acp_${id}`], JSON.stringify(secrets.hints()));
    evs = await run({ driver: `acp:${id}`, provider: `acp_${id}`, cwd: work, access: 'chat', prompt: '你好' });
    rec('移除之后不能再发（任务可读不可再发）', kinds(evs, 'error').length === 1);

    /* the old names keep working through the same wiring, and the definition reaches runAcp */
    evs = await run({ driver: 'kimi', provider: 'kimi', path: cmd, cwd: work, access: 'chat', prompt: '你好' });
    rec("旧驱动名 'kimi' 仍然映射到 Kimi 代理", kinds(evs, 'done').length === 1, JSON.stringify(evs.slice(-1)));
    const modesLog = path.join(root, 'modes.log');
    process.env.FAKE_ACP_LOG = modesLog;
    process.env.FAKE_ACP_CURRENT = 'default';
    evs = await run({ driver: 'kimi', provider: 'kimi', path: cmd, cwd: work, cwd2: work, access: 'work', prompt: '你好', permissionMode: 'bypass', trust: 'T2' });
    rec('Kimi：放手 → 切到 yolo（定义里的 modeMap 起作用；目录要被信任账本认可，这里没有，所以按只读切 plan 也算数）', fs.existsSync(modesLog) && /"modeId":"(yolo|plan)"/.test(fs.readFileSync(modesLog, 'utf8')), fs.existsSync(modesLog) ? fs.readFileSync(modesLog, 'utf8') : 'no log');
    try { fs.unlinkSync(modesLog); } catch { /* none */ }
    evs = await run({ driver: 'acp:opencode', provider: 'acp_opencode', path: cmd, cwd: work, access: 'work', prompt: '你好', permissionMode: 'bypass', trust: 'T2' });
    rec('未验证的代理：放手不生效，只说一句未验证，不切模式', !fs.existsSync(modesLog) && kinds(evs, 'notice').some((n) => /未验证|无法保证只读/.test(n.text)), JSON.stringify(kinds(evs, 'notice')));
  } catch (e) {
    rec('脚本跑到了最后', false, (e && e.stack) || e);
  }
  const out = process.env.ALIGHT_INT_OUT;
  if (out) fs.writeFileSync(out, JSON.stringify(results));
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { /* temp */ }
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
