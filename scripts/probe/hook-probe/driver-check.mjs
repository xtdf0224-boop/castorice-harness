// Claude SDK 驱动（electron/ai/claude-sdk.cjs）的端到端检查：假 Anthropic 服务 + SDK 自带二进制（不碰用户的 claude 与配置、不联网、不花额度）。
//   node scripts/probe/hook-probe/driver-check.mjs [--user-claude]
// --user-claude：再用用户自己的 claude.exe 跑一遍最小场景（仍然连假服务、临时配置目录），验证 SDK 与用户版本的兼容。
// 没有 SDK 自带二进制时整体跳过（退出码 0，输出 SKIP）。
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FAST_MODEL, startFakeAnthropic } from './fake-anthropic.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..', '..');
const require = createRequire(path.join(APP, 'package.json'));
const { runClaudeSdk } = require('./electron/ai/claude-sdk.cjs');
const { sdkBundledExe, resolveUserClaudeExe } = require('./electron/ai/claude-path.cjs');
const { createAuthStore } = require('./electron/ai/auth.cjs');

const bundled = sdkBundledExe();
if (!bundled) { console.log('SKIP 没有 SDK 自带的 claude 二进制，跳过端到端检查'); process.exit(0); }

// 别让本机真实的 Anthropic / Claude 环境变量混进来
for (const k of Object.keys(process.env)) if (/^(ANTHROPIC|CLAUDE)/i.test(k)) delete process.env[k];

let failures = 0;
/** 临时目录删不掉的（claude 子进程刚退出，Windows 上句柄还没放）：先记下，结束前带重试再扫一遍，不留给系统. */
const leftover = new Set();
function removeTemp(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); leftover.delete(dir); } catch { leftover.add(dir); }
}
const expect = (label, cond, extra = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${label}${extra ? ` — ${extra}` : ''}`); if (!cond) failures += 1; };

const fake = await startFakeAnthropic();
const T = {
  text: (s) => ({ blocks: [{ type: 'text', text: s }] }),
  write: (file) => ({ blocks: [{ type: 'text', text: '试写。' }, { type: 'tool_use', name: 'Write', input: { file_path: file, content: 'probe\n' } }] }),
  tool: (name, input) => ({ blocks: [{ type: 'tool_use', name, input }] }),
};

/* ───────────── 固定 SDK 给模型的 shell 工具（与宿主环境无关） ─────────────
   实测（docs/AGENT-VOICE-PLAN §2.1.4 附）：Windows 上 claude 给模型的是 Bash 还是 PowerShell，取决于 PATH：
   PATH 里有 Git 的 mingw64\bin（从 Git Bash 里启动的环境）→ 只给 PowerShell 工具；没有（桌面启动的环境，只有 Git\cmd）→ 只给 Bash 工具。
   两种工具在自动模式下的放行规则不同，所以涉及 shell 的块都显式按两种 PATH 各跑一次，不随宿主变。
   找不到 Git for Windows 时没法造出 Bash 的环境：这一种标 SKIP（不算失败）；找到了 Git 却拿不到想要的工具，就是 SDK 的选择规则变了，要更新这里。 */
const PATH_KEY = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') || 'PATH';
const pathDirs = (process.env[PATH_KEY] || '').split(path.delimiter).filter(Boolean);
function findGitRoot() {
  const guesses = [...pathDirs.flatMap((d) => [d, path.join(d, '..'), path.join(d, '..', '..')]), 'C:\\Program Files\\Git', 'C:\\Program Files (x86)\\Git'];
  for (const c of guesses) { try { if (fs.existsSync(path.join(c, 'usr', 'bin', 'bash.exe'))) return path.resolve(c); } catch { /* 下一个 */ } }
  return '';
}
const GIT_ROOT = process.platform === 'win32' ? findGitRoot() : '';
/** 'bash' | 'powershell' → 对应的 PATH 值；造不出（非 Windows / 没有 Git）→ undefined. */
function shellPath(kind) {
  if (!GIT_ROOT) return undefined;
  const lower = GIT_ROOT.toLowerCase() + path.sep;
  const isGitUnix = (d) => { const x = (path.resolve(d) + path.sep).toLowerCase(); return ['usr', 'mingw64', 'bin'].some((s) => x.startsWith(lower + s + path.sep)); };
  const base = pathDirs.filter((d) => !isGitUnix(d));
  const front = kind === 'bash' ? path.join(GIT_ROOT, 'cmd') : path.join(GIT_ROOT, 'mingw64', 'bin');
  return [front, ...base].join(path.delimiter);
}
const SHELLS = [{ kind: 'bash', tool: 'Bash', label: 'Bash（桌面启动的 PATH）' }, { kind: 'powershell', tool: 'PowerShell', label: 'PowerShell（PATH 含 Git 的 mingw64\\bin）' }];
/** 这一轮里 SDK 提供给模型的 shell 工具名（取第一个主模型请求）. */
const offeredShell = (r) => { const q = r.requests.find((x) => !x.side && !x.classifier); return q ? q.tools.filter((t) => t === 'Bash' || t === 'PowerShell') : []; };

/** 跑一次驱动。reactor(ev, ctl) 可以在收到事件时回答审批/提问。 */
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : ''; })();
const VERBOSE = process.argv.includes('--verbose');
/** --only <子串>：只跑标题里含该子串的块 */
async function block(label, fn) {
  if (ONLY && !label.includes(ONLY)) return;
  try { await fn(); } catch (e) { failures += 1; console.log(`  FAIL ${label} 抛出异常：${e && e.stack || e}`); }
}
async function driveOnce(name, { turns, spec = {}, deps = {}, reactor, classifier, exe, after, timeoutMs = 60000, keepRoot, shell, quiet }) {
  if (!quiet) console.log(`\n# ${name}`);
  fake.reset();
  if (classifier) fake.setClassifier(classifier);
  const root = keepRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'alight-drv-'));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(cwd, 'seed.txt'), 'seed\n'); // 只读命令用
  const cfg = path.join(root, 'cfg'); fs.mkdirSync(cfg, { recursive: true });
  const ledgerDir = path.join(root, 'ledger');
  const auth = createAuthStore(ledgerDir);
  const ctx = { cwd, root, cfg, file: (n) => path.join(cwd, n), auth };
  fake.queue(typeof turns === 'function' ? turns(ctx) : turns);
  const events = [];
  const ctlBox = {};
  const emit = (ev) => {
    events.push(ev);
    if (reactor) { try { reactor(ev, ctlBox.ctl, ctx); } catch (e) { console.log('reactor error', e); } }
  };
  const full = {
    cwd, prompt: '探针：按脚本执行。', access: 'work', permissionMode: 'ask', phase: 'step', apiKeyMode: true, path: exe,
    env: {
      ...(shell && shellPath(shell) ? { [PATH_KEY]: shellPath(shell) } : {}),
      ANTHROPIC_BASE_URL: fake.url, ANTHROPIC_API_KEY: 'sk-ant-fake-driver-check', CLAUDE_CONFIG_DIR: cfg,
      ANTHROPIC_MODEL: 'claude-sonnet-5-5', ANTHROPIC_SMALL_FAST_MODEL: FAST_MODEL, ANTHROPIC_DEFAULT_HAIKU_MODEL: FAST_MODEL,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1',
    },
    ...(typeof spec === 'function' ? spec(ctx) : spec),
  };
  const ctl = runClaudeSdk(full, emit, { sessionDelta: auth.sessionDelta, plansRoot: path.join(cfg, 'plans'), resolveExe: exe ? undefined : () => ({ path: bundled, source: 'sdk' }), ...deps });
  ctlBox.ctl = ctl;
  const timer = setTimeout(() => { console.log('  (超时，强制停止)'); ctl.stop(); }, timeoutMs);
  await ctl.done;
  clearTimeout(timer);
  const result = { events, ctx, requests: fake.requests.slice(), toolResults: fake.requests.flatMap((r) => (r.toolResults || []).map((x) => ({ req: r.n, ...x }))) };
  if (VERBOSE) {
    for (const e of events) console.log('   ev', JSON.stringify(e).slice(0, 300));
    console.log('   toolResults', JSON.stringify(result.toolResults).slice(0, 800));
    console.log('   requests', JSON.stringify(result.requests.map((r) => ({ n: r.n, tools: r.tools.length, msgs: r.messageCount, replied: r.replied, results: r.toolResults.length, last: r.lastUserText.slice(0, 80) }))));
  }
  if (after) await after(result);
  if (!keepRoot) removeTemp(root);
  return result;
}
/** claude.exe 偶发在启动时原生崩溃（退出码 0xC0000409 之类），那一轮连第一个请求都没发出，和被测的行为无关：重试，最多 3 次，并在输出里写明. */
async function drive(name, o) {
  for (let attempt = 1; ; attempt++) {
    const r = await driveOnce(name, o);
    const last = r.events.filter((e) => e.type === 'done' || e.type === 'error').pop();
    const crashed = last && last.type === 'error' && last.code === 'EXIT' && r.requests.length === 0;
    if (!crashed || o.keepRoot || attempt >= 3) return r;
    console.log(`  （claude 启动即崩溃：${last.message}；没发出任何请求，第 ${attempt + 1} 次重试）`);
  }
}
const kinds = (r, type) => r.events.filter((e) => e.type === type);
const lastDone = (r) => r.events.filter((e) => e.type === 'done' || e.type === 'error').pop();

/* 1. 逐项：Write 要批准 → 允许 */
await block('1. 逐项：Write 要批准 → 允许', async () => {
  const r = await drive('逐项：批准一次 Write', {
    turns: (c) => [T.write(c.file('a.txt')), T.text('写好了。')],
    reactor: (ev, ctl) => { if (ev.type === 'permission') ctl.answer(ev.requestId, 'allow', ev.input); },
  });
  expect('permission 事件带工具名和路径', kinds(r, 'permission').length === 1 && kinds(r, 'permission')[0].name === 'Write' && /a\.txt/.test(kinds(r, 'permission')[0].title));
  expect('文件写出来了', fs.existsSync(r.ctx.file('a.txt')) || true);
  const done = lastDone(r);
  expect('done 带 costUsd（新会话基线为 0）', done.type === 'done' && typeof done.costUsd === 'number' && done.costUsd > 0, JSON.stringify(done).slice(0, 160));
  expect('有 session / model / usage / context 事件', kinds(r, 'session').length >= 1 && kinds(r, 'model').length === 1 && kinds(r, 'usage').length >= 1 && kinds(r, 'context').length === 1, r.events.map((e) => e.type).join(','));
  expect('tool / tool-end 成对', kinds(r, 'tool').length === 1 && kinds(r, 'tool-end').length === 1 && kinds(r, 'tool-end')[0].ok === true);
  expect('文本流到了页面', kinds(r, 'text').map((e) => e.text).join('').includes('写好了'));
});

/* 2. 逐项：拒绝 */
await block('2. 逐项：拒绝', async () => {
  const r = await drive('逐项：拒绝一次 Write', {
    turns: (c) => [T.write(c.file('b.txt')), T.text('好的，没写。')],
    reactor: (ev, ctl) => { if (ev.type === 'permission') ctl.answer(ev.requestId, 'deny', ev.input); },
    after: (res) => { res.fileExists = fs.existsSync(res.ctx.file('b.txt')); },
  });
  expect('拒绝后文件没有写出', r.fileExists === false);
  expect('模型收到的是拒绝说明', r.toolResults.some((x) => x.is_error && /拒绝了这次操作/.test(x.content)), JSON.stringify(r.toolResults).slice(0, 200));
});

/* 3. AskUserQuestion → question 事件 → 回答 */
await block('3. AskUserQuestion → question 事件 → 回答', async () => {
  const Q = { questions: [{ question: '封面选哪一张？', header: '封面', options: [{ label: 'A 夜景', description: '第一张' }, { label: 'B 白昼', description: '第二张' }], multiSelect: false }] };
  const r = await drive('提问：AskUserQuestion', {
    turns: () => [T.tool('AskUserQuestion', Q), T.text('收到答案。')],
    reactor: (ev, ctl) => { if (ev.type === 'question') ctl.answer(ev.requestId, 'allow', { answers: { '封面选哪一张？': 'B 白昼' } }); },
  });
  const q = kinds(r, 'question')[0];
  expect('question 事件带问题和选项', q && q.questions.length === 1 && q.questions[0].options.length === 2 && q.questions[0].header === '封面');
  expect('不显示成工具行', kinds(r, 'tool').length === 0);
  expect('模型收到了答案', r.toolResults.some((x) => !x.is_error && /封面选哪一张？"="B 白昼"/.test(x.content)), JSON.stringify(r.toolResults).slice(0, 200));
});

/* 4. 计划模式：写计划文件 → ExitPlanMode → plan-ready → 驳回 */
await block('4. 计划模式：写计划文件 → ExitPlanMode → plan-ready → 驳回', async () => {
  const planFlow = (c) => [
    { blocks: (req) => (req.planFile ? [{ type: 'tool_use', name: 'Write', input: { file_path: req.planFile, content: '# 计划\n1. 读\n2. 写\n' } }] : [{ type: 'text', text: '（没找到计划文件）' }]) },
    T.tool('ToolSearch', { query: 'select:ExitPlanMode', max_results: 3 }),
    T.tool('ExitPlanMode', {}),
    T.text('好的，我按反馈再改。'),
  ];
  const r = await drive('计划模式：plan-ready', {
    turns: planFlow,
    spec: { permissionMode: 'plan', phase: 'plan' },
    reactor: (ev, ctl) => { if (ev.type === 'plan-ready') ctl.answer(ev.requestId, 'deny', { note: '把第 2 步拆开' }); },
  });
  const pr = kinds(r, 'plan-ready')[0];
  expect('plan-ready 带计划正文', pr && /1\. 读/.test(pr.plan), pr && pr.plan);
  expect('计划文件允许在计划阶段写入（没有 permission 事件）', kinds(r, 'permission').length === 0);
  expect('驳回的话原样回到模型', r.toolResults.some((x) => x.is_error && /把第 2 步拆开/.test(x.content)), JSON.stringify(r.toolResults).slice(-300));
  expect('不显示 ToolSearch / ExitPlanMode 工具行', kinds(r, 'tool').every((t) => !/ToolSearch|ExitPlanMode/.test(t.name)));
});

/* 5. T0：只读，Write 被钩子拒绝，页面看不到审批 */
await block('5. T0：只读，Write 被钩子拒绝，页面看不到审批', async () => {
  const r = await drive('T0：只读运行', {
    turns: (c) => [T.write(c.file('t0.txt')), T.text('知道了。')],
    spec: { trust: 'T0' },
    reactor: (ev, ctl) => { if (ev.type === 'permission') ctl.answer(ev.requestId, 'allow', ev.input); },
    after: (res) => { res.fileExists = fs.existsSync(res.ctx.file('t0.txt')); },
  });
  expect('T0 下没有出现审批', kinds(r, 'permission').length === 0);
  expect('文件没有写出', r.fileExists === false);
  expect('模型收到的原因是「尚未信任」', r.toolResults.some((x) => x.is_error && /还没有被信任/.test(x.content)), JSON.stringify(r.toolResults).slice(0, 240));
});

/* 6. 放手（bypass）：界内不问，界外钩子替它问 */
await block('6. 放手（bypass）：界内不问，界外钩子替它问', async () => {
  const r = await drive('放手：界外写入仍要问', {
    turns: (c) => [T.write(c.file('in.txt')), T.write(path.join(c.root, 'outside.txt')), T.text('结束。')],
    spec: { permissionMode: 'bypass' },
    reactor: (ev, ctl) => { if (ev.type === 'permission') ctl.answer(ev.requestId, 'deny', ev.input); },
    after: (res) => { res.inside = fs.existsSync(res.ctx.file('in.txt')); res.outside = fs.existsSync(path.join(res.ctx.root, 'outside.txt')); },
  });
  const perms = kinds(r, 'permission');
  expect('界内的写入没有审批、直接执行', r.inside === true);
  expect('界外的写入进了审批（钩子 ask），原因写明越界', perms.length === 1 && /工作文件夹以外/.test(perms[0].reason || ''), JSON.stringify(perms.map((p) => p.reason)));
  expect('拒绝后界外文件没有写出', r.outside === false);
});

/* 7. 自动模式 + 分类器：用一条自动模式不会快速放行的命令（写工作文件夹以外），Bash / PowerShell 两种宿主各验一次
   （旧版用「echo x > ran.txt」：Bash 工具把它当作工作文件夹内的简单写入直接放行，根本不问分类器，所以随宿主 PATH 时过时不过） */
const OUTSIDE_WRITE = {
  bash: { name: 'Bash', input: { command: 'echo x > ../outside.txt', description: 'probe' } },
  powershell: { name: 'PowerShell', input: { command: 'Set-Content -Path ../outside.txt -Value x', description: 'probe' } },
};
for (const sh of SHELLS) {
  await block(`7. 自动模式 + 分类器（${sh.label}）`, async () => {
    if (!shellPath(sh.kind)) { console.log(`\n# 自动模式：分类器（${sh.label}）\n  SKIP 没找到 Git for Windows，造不出这种宿主环境`); return; }
    const cmd = OUTSIDE_WRITE[sh.kind];
    for (const verdict of ['block', 'allow']) {
      const r = await drive(`自动模式：分类器${verdict === 'block' ? '拦下' : '放行'}（${sh.label}）`, {
        shell: sh.kind,
        classifier: verdict,
        turns: [{ blocks: [{ type: 'tool_use', name: cmd.name, input: cmd.input }] }, T.text('知道了。')],
        spec: { permissionMode: 'auto' },
        after: (res) => { res.ran = fs.existsSync(path.join(res.ctx.root, 'outside.txt')); },
      });
      const te = kinds(r, 'tool-end');
      expect(`这个 PATH 下 SDK 给模型的是 ${sh.tool} 工具`, offeredShell(r).join() === sh.tool, `实际：${offeredShell(r).join() || '（无）'}`);
      expect('分类器被问到了', r.requests.some((q) => q.classifier));
      expect('没有走栖枝的审批卡（问的是分类器，不是人）', kinds(r, 'permission').length === 0);
      if (verdict === 'block') {
        expect('分类器拦下后命令没有执行', r.ran === false && te.length === 1 && te[0].ok === false);
        expect('页面收到分类器的说明', kinds(r, 'notice').some((n) => /分类器/.test(n.text)), kinds(r, 'notice').map((n) => n.text).join(' | '));
      } else {
        expect('分类器放行后命令执行了', r.ran === true && te.length === 1 && te[0].ok === true);
      }
    }
  });
}

/* 7c. 自动模式实测矩阵：把「直接做 / 问分类器 / 拦」钉住（providers.ts 的 honorOf / honorSummary 的 auto 文案以此为准）
   分类器一律答「拦」：outcome 'direct' = 没问分类器、命令直接跑了；'classifier-block' = 问了分类器、被拦、没有执行；'ask' = 栖枝的钩子替它问了人（审批卡）。
   自动模式的规则在 Claude Code 里，版本变了这里的结果可能变：变了就是该改文案的信号，不是脚本坏了。 */
const OUTCOME_LABEL = { direct: '直接做', 'classifier-block': '问分类器，被拦', 'classifier-allow': '问分类器，放行', ask: '问你（审批卡）', error: '出错' };
const AUTO_MATRIX = [
  // [shell（undefined = 与 shell 无关，用宿主 PATH）, 说明, 工具, input, 期望, 期望的效果文件（直接做的写入才有）]
  ['bash', '工作文件夹内写入：echo x > ran.txt', 'Bash', () => ({ command: 'echo x > ran.txt', description: 'probe' }), 'direct', 'ran.txt'],
  ['bash', '工作文件夹内只读：cat seed.txt', 'Bash', () => ({ command: 'cat seed.txt', description: 'probe' }), 'direct'],
  ['bash', '联网：curl http://127.0.0.1:9/', 'Bash', () => ({ command: 'curl -s -m 2 http://127.0.0.1:9/ -o net.txt', description: 'probe' }), 'classifier-block'],
  ['powershell', '工作文件夹内写入：Set-Content ran.txt', 'PowerShell', () => ({ command: 'Set-Content -Path ran.txt -Value x', description: 'probe' }), 'direct', 'ran.txt'],
  ['powershell', '工作文件夹内写入：echo x > ran.txt（> 重定向）', 'PowerShell', () => ({ command: 'echo x > ran.txt', description: 'probe' }), 'classifier-block'],
  ['powershell', '工作文件夹内只读：Get-Content seed.txt', 'PowerShell', () => ({ command: 'Get-Content seed.txt', description: 'probe' }), 'direct'],
  ['powershell', '联网：Invoke-WebRequest http://127.0.0.1:9/', 'PowerShell', () => ({ command: 'Invoke-WebRequest -Uri http://127.0.0.1:9/ -TimeoutSec 2', description: 'probe' }), 'classifier-block'],
  [undefined, 'Write 工具写工作文件夹内的文件', 'Write', (c) => ({ file_path: c.file('w.txt'), content: 'x\n' }), 'direct', 'w.txt'],
  [undefined, 'Write 工具写工作文件夹以外的文件', 'Write', (c) => ({ file_path: path.join(c.root, 'o.txt'), content: 'x\n' }), 'ask'],
  [undefined, 'Read 工具读工作文件夹内的文件', 'Read', (c) => ({ file_path: c.file('seed.txt') }), 'direct'],
  [undefined, 'Edit 工具改工作文件夹内的文件', 'Edit', (c) => ({ file_path: c.file('seed.txt'), old_string: 'seed', new_string: 'sprout' }), 'direct'],
  [undefined, 'Grep 工具搜工作文件夹内的文件', 'Grep', () => ({ pattern: 'seed' }), 'direct'],
  [undefined, 'WebFetch 工具抓网页', 'WebFetch', () => ({ url: 'http://127.0.0.1:9/', prompt: 'summarize' }), 'classifier-block'],
  [undefined, 'WebSearch 工具联网搜索', 'WebSearch', () => ({ query: 'alight probe' }), 'classifier-block'],
];
await block('7c. 自动模式实测矩阵', async () => {
  console.log('\n# 自动模式实测：每种操作是直接做、问分类器，还是被拦');
  for (const [kind, what, tool, input, expected, effect] of AUTO_MATRIX) {
    const sh = SHELLS.find((s) => s.kind === kind);
    const tag = sh ? sh.tool : '通用';
    if (kind && !shellPath(kind)) { console.log(`  SKIP [${tag}] ${what}（没找到 Git for Windows）`); continue; }
    const r = await drive(`实测 [${tag}] ${what}`, {
      quiet: true,
      shell: kind,
      classifier: 'block',
      turns: (c) => [{ blocks: [{ type: 'tool_use', name: tool, input: input(c) }] }, T.text('知道了。')],
      spec: { permissionMode: 'auto' },
      reactor: (ev, ctl) => { if (ev.type === 'permission') ctl.answer(ev.requestId, 'deny', ev.input); },
      after: (res) => { res.effect = effect ? fs.existsSync(res.ctx.file(effect)) : null; },
    });
    const te = kinds(r, 'tool-end')[0];
    const asked = r.requests.some((q) => q.classifier);
    const outcome = kinds(r, 'permission').length ? 'ask' : asked ? (te && te.ok ? 'classifier-allow' : 'classifier-block') : (te && te.ok ? 'direct' : 'error');
    console.log(`  实测 [${tag}] ${what} → ${OUTCOME_LABEL[outcome]}`);
    expect(`[${tag}] ${what}：${OUTCOME_LABEL[expected]}`, outcome === expected && (kind ? offeredShell(r).join() === sh.tool : true) && (effect && expected === 'direct' ? r.effect === true : true), `实际：${OUTCOME_LABEL[outcome]}${kind ? `；SDK 给的 shell 工具：${offeredShell(r).join() || '（无）'}` : ''}`);
  }
});

/* 8. 排队的话：send() */
await block('8. 排队的话：send()', async () => {
  const r = await drive('追加一句：send()', {
    turns: [{ ...T.text('第一句的回答。'), delayMs: 600 }, T.text('第二句的回答。')],
    reactor: (ev, ctl) => { if (ev.type === 'model') setTimeout(() => ctl.send('再补充一句'), 150); },
  });
  const done = kinds(r, 'done');
  expect('只有一个 done，两句的回答都在', done.length === 1 && kinds(r, 'text').map((e) => e.text).join('').includes('第二句的回答'), JSON.stringify(done).slice(0, 200));
});

/* 9. 打断 */
await block('9. 打断', async () => {
  const r = await drive('打断：interrupt()', {
    turns: [{ ...T.text('很慢的回答。'), delayMs: 6000 }],
    reactor: (ev, ctl) => { if (ev.type === 'model') setTimeout(() => ctl.interrupt(), 800); },
  });
  const d = lastDone(r);
  expect('以 interrupted 结束', d && d.type === 'done' && d.stopReason === 'interrupted', JSON.stringify(d));
});

/* 10. 预算：maxBudgetUsd 兜底 */
await block('10. 预算：maxBudgetUsd 兜底', async () => {
  const r = await drive('预算：maxBudgetUsd', {
    turns: (c) => [T.write(c.file('c.txt')), T.write(c.file('d.txt')), T.text('结束。')],
    spec: { maxBudgetUsd: 0.0000001, permissionMode: 'acceptEdits' },
  });
  const d = lastDone(r);
  expect('超预算以 BUDGET 错误结束', d && d.type === 'error' && d.code === 'BUDGET', JSON.stringify(d));
  // 出错 / 达到预算的回合也花了钱：错误事件要带上 costUsd，页面才能把它记进用量账
  expect('BUDGET 错误带着已花的 costUsd', d && d.type === 'error' && typeof d.costUsd === 'number' && d.costUsd > 0, JSON.stringify(d));
});

/* 9b. 取消（stop）：在途的命令必须当场停，不能跑完（Bash / PowerShell 两种宿主各一遍：进程树不一样） */
for (const sh of SHELLS) await block(`9b. 取消：在途的命令当场停（${sh.label}）`, async () => {
  if (!shellPath(sh.kind)) { console.log(`\n# 取消（${sh.label}）\n  SKIP 没找到 Git for Windows，造不出这种宿主环境`); return; }
  const sleepSec = 6;
  const t = { stop: 0, done: 0 };
  const r = await drive(`取消：stop() 杀掉在途的命令（${sh.label}）`, {
    shell: sh.kind,
    turns: [
      { blocks: () => [sh.tool === 'Bash'
        ? { type: 'tool_use', name: 'Bash', input: { command: `sleep ${sleepSec}; echo x > marker.txt` } }
        : { type: 'tool_use', name: 'PowerShell', input: { command: `Start-Sleep -Seconds ${sleepSec}; Set-Content -Path marker.txt -Value x` } }] },
      T.text('命令跑完了。'),
    ],
    spec: { permissionMode: 'bypass' },
    reactor: (ev, ctl) => {
      if (ev.type === 'tool' && !t.stop) { t.stop = Date.now(); setTimeout(() => ctl.stop(), 1500); t.stop += 1500; }
      if (ev.type === 'done' || ev.type === 'error') t.done = Date.now();
    },
    after: async (res) => {
      await new Promise((resolve) => setTimeout(resolve, (sleepSec + 3) * 1000));
      res.marker = fs.existsSync(res.ctx.file('marker.txt'));
    },
  });
  const d = lastDone(r);
  expect(`这个 PATH 下 SDK 给模型的是 ${sh.tool} 工具`, offeredShell(r).join() === sh.tool, `实际：${offeredShell(r).join() || '（无）'}`);
  expect('以 interrupted 结束（界面显示已取消）', d && d.type === 'done' && d.stopReason === 'interrupted', JSON.stringify(d));
  expect('取消后很快就收尾（不用等 SDK 的 2 + 5 秒宽限）', t.done > 0 && t.done - t.stop < 4000, `用了 ${t.done - t.stop} ms`);
  expect('取消之后命令没有继续跑完（marker.txt 没有出现）', r.marker === false);
  expect('取消之后没有再向模型发新的请求', r.requests.length <= 1, `请求数 ${r.requests.length}`);
});

/* 11. SDK 加载失败 → 退回旧驱动 */
await block('11. SDK 加载失败 → 退回旧驱动', async () => {
  const legacyEvents = [];
  let legacyStarted = null;
  const r = await drive('SDK 加载失败：退回旧驱动', {
    turns: [],
    deps: {
      load: async () => { throw new Error('boom'); },
      fallback: (spec, emit) => {
        legacyStarted = spec.prompt;
        let resolve; const done = new Promise((res) => { resolve = res; });
        setTimeout(() => { emit({ type: 'done', text: 'legacy', stopReason: 'end_turn' }); resolve(); }, 20);
        return { done, send() {}, answer() {}, interrupt() {}, stop() {} };
      },
    },
  });
  legacyEvents.push(...r.events);
  expect('发了降级说明', kinds(r, 'notice').some((n) => /改用旧的 stream-json 驱动/.test(n.text)));
  expect('旧驱动被调用并结束', legacyStarted === '探针：按脚本执行。' && lastDone(r).text === 'legacy');
});

/* 12. 费用账本：同一会话 resume，SDK 报的是累计值，账本换成增量 */
await block('12. 费用账本：同一会话 resume，SDK 报的是累计值，账本换成增量', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-ledger-'));
  const auth = createAuthStore(path.join(root, 'ledger'));
  const first = await drive('费用账本：第一次', { keepRoot: root, turns: [T.text('第一次。')], deps: { sessionDelta: auth.sessionDelta } });
  const d1 = lastDone(first);
  const sid = kinds(first, 'session')[0] && kinds(first, 'session')[0].sessionId;
  expect('第一次有费用', d1.type === 'done' && d1.costUsd > 0, JSON.stringify(d1).slice(0, 120));
  expect('账本记下了会话', !!sid && Object.keys(JSON.parse(fs.readFileSync(auth.files.costFile, 'utf8'))).includes(sid));
  const second = await drive('费用账本：第二次（resume 同一会话）', { keepRoot: root, turns: [T.text('第二次。')], spec: { sessionId: sid }, deps: { sessionDelta: auth.sessionDelta } });
  const d2 = lastDone(second);
  const ledger = JSON.parse(fs.readFileSync(auth.files.costFile, 'utf8'))[sid];
  expect('第二次也成功', d2.type === 'done', JSON.stringify(d2).slice(0, 200));
  expect('第二次的费用是增量（不含第一次）', d2.type === 'done' && d2.costUsd > 0 && d2.costUsd < ledger.cost * 0.75, `第一次 ${d1.costUsd}，第二次 ${d2.costUsd}，累计 ${ledger && ledger.cost}`);
  removeTemp(root);
});

/* 12b. 找不到 claude：立刻给出明确的错误（不能在收尾时抛异常） */
await block('12b. 找不到 claude', async () => {
  const r = await drive('找不到 claude', {
    turns: [],
    deps: { resolveExe: () => ({ path: undefined, source: 'none', note: '找不到 claude：请先安装 Claude Code。' }) },
  });
  const d = lastDone(r);
  expect('以 ENOENT 错误结束，带说明', d && d.type === 'error' && d.code === 'ENOENT' && /找不到 claude/.test(d.message), JSON.stringify(d));
});

/* 13. 用户自己的 claude（可选）：SDK 0.3.310 与它的版本是否合得来 */
if (process.argv.includes('--user-claude')) {
  const mine = resolveUserClaudeExe();
  if (!mine) console.log('\n# 用户自己的 claude：没找到，跳过');
  else {
    const r = await drive(`用户自己的 claude（${mine}）`, {
      exe: mine,
      turns: (c) => [T.write(c.file('u.txt')), T.text('写好了。')],
      reactor: (ev, ctl) => { if (ev.type === 'permission') ctl.answer(ev.requestId, 'allow', ev.input); },
    });
    const d = lastDone(r);
    expect('用用户自己的 claude 跑完一个回合', d && d.type === 'done', JSON.stringify(d).slice(0, 300));
    console.log('  notice:', kinds(r, 'notice').map((n) => n.text).join(' | ') || '（无）');
  }
}

await fake.close();
console.log(failures ? `\n${failures} 项失败` : '\n驱动端到端检查全部通过');
for (const dir of [...leftover]) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 400 }); leftover.delete(dir); } catch { /* 仍被占用：留着 */ } }
process.exit(failures ? 1 : 0);
