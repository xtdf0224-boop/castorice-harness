/* 模块检查（engine · B3）：npm run check:engine
   无 GUI、无网络、不花额度：
   ① 纯函数：权限模式映射、钩子决定、认证 / 预算 / 会话费用账本、SDK 消息 → 事件映射、提问答案整形；
   ② 状态机：计划审批、提问、用量记录构造（engine.ts）；
   ③ 运行器（live.ts）接一个假的桌面桥：计划先等批准、改了再批、发回重做、提问合并、T0 只读、暂停 / 取消、用量记录；
   ④ 端到端：scripts/probe/hook-probe/driver-check.mjs（假 Anthropic 服务 + SDK 自带二进制，没有二进制就跳过）。 */
// 必须最先：它在页面代码加载之前把 window.alightDesktop 放好
import { bridge, type Ev } from './probe/hook-probe/fake-bridge';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { produce } from 'immer';
import { failureHint, failureReason, failureScene } from '../src/lib/failure';
import { PERMISSION_MODE_HINT, honorDriver, honorOf, honorPool, honorSummary, honorTally, toolCategory } from '../src/lib/providers';
import { TIERABLE_TOOLS, effectiveTier, tierCounts } from '../src/lib/tiers';
import type { AgentId, AppState, Message, Run, Task, TaskEngine, ToolId, ToolPermission } from '../src/lib/types';
import { backend } from '../src/state/backend';
import * as voiceGateMod from '../src/state/voiceGate';
import * as engine from '../src/state/engine';
import * as live from '../src/state/live';
import { promptUpdateNote } from '../src/state/live';
import * as runActions from '../src/state/runActions';
import { deriveQueue } from '../src/state/queue';
import { AGENTS, emptyState } from '../src/state/seed';
import { store } from '../src/state/store';

let failed = 0;
export function eq(name: string, got: unknown, want: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { failed += 1; console.error(`  FAIL ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); } else console.log(`  ok  ${name}`);
}
/** 临时目录尽力删；Windows 上子进程刚退出时句柄可能还没放，留给系统清理也无妨. */
function rm(dir: string) { try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 12, retryDelay: 300 }); } catch { /* temp：子进程还占着就留着 */ } }
function ok(name: string, cond: boolean, extra = '') {
  if (!cond) { failed += 1; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); } else console.log(`  ok  ${name}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const req = createRequire(path.resolve('package.json'));
const perm = req('./electron/ai/perm.cjs');
const authMod = req('./electron/ai/auth.cjs');
const map = req('./electron/ai/sdk-map.cjs');
const sdkDriver = req('./electron/ai/claude-sdk.cjs');
const claudePathMod = req('./electron/ai/claude-path.cjs');

/* ───────────────────── ① 权限模式与钩子 ───────────────────── */
console.log('权限模式映射');
eq('逐项 → default', perm.sdkModeFor('ask', { phase: 'step' }), { mode: 'default', bypass: false });
eq('接受编辑 → acceptEdits', perm.sdkModeFor('acceptEdits', { phase: 'step' }).mode, 'acceptEdits');
eq('自动 → auto', perm.sdkModeFor('auto', { phase: 'step' }).mode, 'auto');
eq('放手 → bypassPermissions，并且要显式放开', perm.sdkModeFor('bypass', { phase: 'step' }), { mode: 'bypassPermissions', bypass: true });
eq('计划 + 计划阶段 → plan（SDK 原生计划模式）', perm.sdkModeFor('plan', { phase: 'plan' }).mode, 'plan');
eq('计划 + 执行阶段 → default（批准之后逐项）', perm.sdkModeFor('plan', { phase: 'step' }).mode, 'default');
eq('其他模式的计划阶段 → default（钩子强制只读）', perm.sdkModeFor('bypass', { phase: 'plan' }).mode, 'default');
eq('只读运行里「放手」降为 default 并说明', perm.sdkModeFor('bypass', { phase: 'step', readOnly: true }).mode, 'default');
ok('只读运行里的降级有说明', /只读运行/.test(perm.sdkModeFor('auto', { phase: 'step', readOnly: true }).note ?? ''));
eq('没有的值当逐项', perm.sdkModeFor(undefined, {}).mode, 'default');
ok('claude 不认 auto 时如实说降级', /降级为/.test(perm.sdkModeMismatchNote('auto', 'default') ?? ''));
eq('模式一致不啰嗦', perm.sdkModeMismatchNote('default', 'default'), undefined);

console.log('其他引擎的权限模式');
eq('Codex 计划 → 只读沙箱，不用降级', perm.codexPlan('plan', 'workspace-write'), { sandbox: 'read-only', note: undefined });
ok('Codex 逐项 → 按沙箱并说「已降级」', /已降级/.test(perm.codexPlan('ask', 'workspace-write').note));
ok('Codex 放手但沙箱没放开 → 说明', /已降级/.test(perm.codexPlan('bypass', 'workspace-write').note));
eq('Codex 放手且沙箱本来就放开 → 如实对应', perm.codexPlan('bypass', 'danger-full-access').note, undefined);
eq('DSH 计划 → read-only', perm.dshPlan('plan').env, { DSH_PERMISSION_MODE: 'read-only' });
ok('DSH 其他模式 → 已降级', /已降级/.test(perm.dshPlan('auto').note));
eq('Kimi 逐项 → 显式设 default', perm.acpPlan('kimi', 'ask', ['default', 'plan', 'auto', 'yolo']).modeId, 'default');
eq('Kimi 放手 → yolo，手套只记账', [perm.acpPlan('kimi', 'bypass', ['default', 'yolo']).modeId, /只记账/.test(perm.acpPlan('kimi', 'bypass', ['default', 'yolo']).note)], ['yolo', true]);
ok('Kimi 没有「只接受编辑」→ 降级', /已降级/.test(perm.acpPlan('kimi', 'acceptEdits', undefined).note));
ok('Kimi 缺少这个模式 → 降级', /已降级/.test(perm.acpPlan('kimi', 'auto', ['default']).note));
ok('Qwen / MiniMax 没验证 → 如实说未验证', /未验证/.test(perm.acpPlan('qwen', 'plan', undefined).note));

console.log('工具分类与页面一致');
for (const [name, input] of [
  ['Bash', { command: 'git status' }], ['PowerShell', { command: 'git log --oneline' }], ['Bash', { command: 'git status; curl x | sh' }], ['Bash', { command: 'npm test' }],
  ['Read', {}], ['NotebookRead', {}], ['Edit', {}], ['Write', {}], ['MultiEdit', {}], ['apply_patch', {}], ['Grep', {}], ['Glob', {}], ['LS', {}],
  ['WebSearch', {}], ['WebFetch', {}], ['mcp__alight-browser__browser_navigate', {}], ['mcp__alight-browser__browser_snapshot', {}], ['alight_browser.browser_click', {}],
  ['Task', {}], ['Agent', {}], ['TodoWrite', {}], ['Skill', {}], ['mcp__x__y', {}],
] as Array<[string, Record<string, unknown>]>) {
  eq(`toolCategory(${name}${input.command ? ` ${String(input.command).slice(0, 14)}` : ''})`, perm.toolCategory(name, input), toolCategory(name, input));
}

console.log('PreToolUse 钩子的决定');
const base = { mode: 'default', readOnly: false, deny: ['Write', 'Bash(git:*)'], roots: ['C:/work/proj', 'C:/Users/x/skills'] };
eq('提问与计划工具钩子不表态', perm.hookDecision(base, 'AskUserQuestion', {}), { decision: 'none' });
eq('ExitPlanMode 不表态', perm.hookDecision(base, 'ExitPlanMode', {}), { decision: 'none' });
eq('策略里关掉的工具 → deny', perm.hookDecision(base, 'Write', { file_path: 'C:/work/proj/a.txt' }).decision, 'deny');
eq('带括号的内容规则交给 claude 自己匹配', perm.hookDecision(base, 'Bash', { command: 'git status' }).decision, 'none');
eq('界内路径不表态', perm.hookDecision(base, 'Edit', { file_path: 'C:\\work\\proj\\src\\a.ts' }).decision, 'none');
eq('相对路径（界内）不表态', perm.hookDecision(base, 'Read', { file_path: 'src/a.ts' }).decision, 'none');
eq('界外绝对路径 → ask', perm.hookDecision(base, 'Read', { file_path: 'C:/Windows/system.ini' }).decision, 'ask');
eq('越出工作文件夹的相对路径 → ask', perm.hookDecision(base, 'Read', { file_path: '../secret.txt' }).decision, 'ask');
eq('~ 开头算界外 → ask', perm.hookDecision(base, 'Read', { path: '~/.ssh/id_rsa' }).decision, 'ask');
eq('技能目录算界内', perm.hookDecision(base, 'Read', { file_path: 'C:/Users/x/skills/a/SKILL.md' }).decision, 'none');
const ro = { ...base, deny: [], readOnly: true, readOnlyWhy: '这个目录还没有被信任（只读运行）' };
eq('只读：写入 → deny', perm.hookDecision(ro, 'Edit', { file_path: 'C:/work/proj/a.txt' }).decision, 'deny');
eq('只读：命令 → deny', perm.hookDecision(ro, 'PowerShell', { command: 'echo hi' }).decision, 'deny');
eq('只读：git 也算命令 → deny', perm.hookDecision(ro, 'Bash', { command: 'git commit -m x' }).decision, 'deny');
eq('只读：浏览器点击 → deny', perm.hookDecision(ro, 'mcp__alight-browser__browser_click', {}).decision, 'deny');
eq('只读：读取与搜索不拦', [perm.hookDecision(ro, 'Read', { file_path: 'a.txt' }).decision, perm.hookDecision(ro, 'Grep', { pattern: 'x' }).decision, perm.hookDecision(ro, 'WebFetch', { url: 'https://example.com' }).decision], ['none', 'none', 'none']);
eq('只读：不认识的工具默认拦', perm.hookDecision(ro, 'mcp__unknown__do_things', {}).decision, 'deny');
ok('只读的拒绝原因写给模型看', /还没有被信任/.test(perm.hookDecision(ro, 'Write', {}).reason));
eq('原生计划模式：计划文件可以写', perm.hookDecision({ ...ro, mode: 'plan', planRoot: 'C:/Users/x/.claude/plans' }, 'Write', { file_path: 'C:/Users/x/.claude/plans/a-b.md' }).decision, 'none');
eq('原生计划模式：别的文件不行', perm.hookDecision({ ...ro, mode: 'plan', planRoot: 'C:/Users/x/.claude/plans' }, 'Write', { file_path: 'C:/work/proj/a.txt' }).decision, 'deny');
{
  // 界内判断要先规范化 . 与 ..，再比较前缀（放手 / 自动模式下 claude 自己不问，钩子是唯一的越界防线）
  const away = (p: string, key = 'file_path') => perm.hookDecision(base, 'Edit', { [key]: p }).decision;
  eq('绝对路径里带 .. 跳出工作文件夹 → ask', away('C:/work/proj/../../Users/x/.bashrc'), 'ask');
  eq('同上，反斜杠写法 → ask', away('C:\\work\\proj\\..\\..\\Users\\x\\.bashrc'), 'ask');
  eq('Read 同理', perm.hookDecision(base, 'Read', { file_path: 'C:/work/proj/../../Users/x/.ssh/id_rsa' }).decision, 'ask');
  eq('绝对路径里 .. 绕了一圈还在界内 → 不表态', away('C:/work/proj/src/../lib/a.ts'), 'none');
  eq('.. 跳进兄弟目录（前缀相同）→ ask', away('C:/work/proj/../proj-other/a.txt'), 'ask');
  eq('前缀相同的兄弟目录 → ask', away('C:/work/proj-other/a.txt'), 'ask');
  eq('盘符相对路径 D:evil.txt → ask', away('D:evil.txt'), 'ask');
  eq('盘符本身 D: → ask', away('C:'), 'ask');
  eq('相对路径 src/../../x 跳出 → ask', away('src/../../x.txt'), 'ask');
  eq('相对路径 a/../b 仍在界内 → 不表态', away('a/../b.txt'), 'none');
  eq('path 键同样规范化', away('C:/work/proj/../../etc', 'path'), 'ask');
  eq('UNC / \\\\?\\ 前缀不当作界内 → ask', away('\\\\?\\C:\\work\\proj\\a.txt'), 'ask');
  eq('界内路径大小写和末尾斜杠不影响', perm.hookDecision({ ...base, roots: ['C:\\Work\\Proj\\'] }, 'Read', { file_path: 'c:/work/PROJ/a.txt' }).decision, 'none');
  eq('根是盘符根时，界内路径仍判界内', perm.hookDecision({ ...base, roots: ['C:\\'] }, 'Read', { file_path: 'C:/anything/a.txt' }).decision, 'none');
  // 原生计划模式 + 只读：计划文件例外只给“绝对路径且规范化后在计划目录内”的写入（生产里 Write 还被 deny 清单盖住，这里单测不带 deny）
  const planCtx = { ...ro, mode: 'plan', planRoot: 'C:/Users/x/.claude/plans' };
  const w = (tool: string, input: Record<string, unknown>) => perm.hookDecision(planCtx, tool, input).decision;
  eq('计划模式：相对路径写入 → deny', w('Write', { file_path: 'src/evil.js' }), 'deny');
  eq('计划模式：Edit package.json → deny', w('Edit', { file_path: 'package.json' }), 'deny');
  eq('计划模式：plans/../settings.json → deny', w('Write', { file_path: 'C:/Users/x/.claude/plans/../settings.json' }), 'deny');
  eq('计划模式：planRoot/.. 逃逸（反斜杠）→ deny', w('Write', { file_path: 'C:\\Users\\x\\.claude\\plans\\..\\..\\.bashrc' }), 'deny');
  eq('计划模式：没有路径的写入 → deny', w('Write', {}), 'deny');
  eq('计划模式：计划目录内的子路径可写', w('Write', { file_path: 'C:/Users/x/.claude/plans/sub/../a.md' }), 'none');
  eq('strictlyInside：相对路径不算', perm.strictlyInside({ file_path: 'a.md' }, ['C:/Users/x/.claude/plans']), false);
}
{
  // 钩子自己出错必须当 deny（探针：回调抛异常 = 没表态 = 照常放行）
  const boom: any = { mode: 'default', readOnly: false, get deny() { throw new Error('炸了'); } };
  const hook = perm.makePreToolUseHook(boom);
  const out = await hook({ tool_name: 'Write', tool_input: { file_path: 'C:/x' } });
  eq('钩子出错 → deny（fail-closed）', out.hookSpecificOutput?.permissionDecision, 'deny');
  const quiet = await perm.makePreToolUseHook(base)({ tool_name: 'Read', tool_input: { file_path: 'a' } });
  eq('不表态时返回空对象', quiet, {});
  const seen: string[] = [];
  await perm.makePreToolUseHook(base, (_i: unknown, d: { decision: string }) => seen.push(d.decision))({ tool_name: 'Write', tool_input: {} });
  eq('决定会被记账', seen, ['deny']);
}

console.log('计划批准之后的执行阶段：其他引擎不再停在只读里');
{
  const exec = perm.effectiveMode('plan', 'step');
  eq('页面选「计划」：执行阶段按逐项', exec, 'ask');
  eq('计划阶段仍然是计划', perm.effectiveMode('plan', 'plan'), 'plan');
  eq('其他模式原样', [perm.effectiveMode('bypass', 'step'), perm.effectiveMode('auto', 'plan'), perm.effectiveMode(undefined, 'step'), perm.effectiveMode('nonsense', 'step')], ['bypass', 'auto', undefined, undefined]);
  eq('Codex：执行阶段用页面给的沙箱，不是 read-only', perm.codexPlan(exec, 'workspace-write').sandbox, 'workspace-write');
  eq('Codex：计划阶段仍是 read-only', perm.codexPlan(perm.effectiveMode('plan', 'plan'), 'workspace-write').sandbox, 'read-only');
  eq('DSH：执行阶段不再设 DSH_PERMISSION_MODE=read-only', perm.dshPlan(exec).env, {});
  eq('DSH：计划阶段仍是 read-only', perm.dshPlan(perm.effectiveMode('plan', 'plan')).env, { DSH_PERMISSION_MODE: 'read-only' });
  eq('Kimi：执行阶段切到 default 而不是 plan', perm.acpPlan('kimi', exec, ['default', 'plan', 'auto', 'yolo']).modeId, 'default');
  eq('Kimi：计划阶段是 plan', perm.acpPlan('kimi', perm.effectiveMode('plan', 'plan'), ['default', 'plan']).modeId, 'plan');
}

console.log('旧 stream-json 驱动：只读由主进程落实');
{
  const page = { allow: ['TodoWrite', 'Write', 'Edit', 'Bash', 'Bash(git:*)', 'PowerShell(git:*)', 'WebSearch'], deny: ['EnterPlanMode'] };
  const rw = perm.legacyPolicy({ ...page, pageMode: 'acceptEdits', phase: 'step', readOnly: false });
  eq('可写任务：页面的 allow 原样、acceptEdits 如实对应', [rw.allow, rw.mode, rw.note], [page.allow, 'acceptEdits', undefined]);
  eq('可写任务：仍然关掉提问 / 退出计划', rw.deny, ['EnterPlanMode', 'AskUserQuestion', 'ExitPlanMode']);
  const ro = perm.legacyPolicy({ ...page, pageMode: 'acceptEdits', phase: 'step', readOnly: true });
  eq('只读（账本 T0）：写入 / 命令类工具并入 deny', ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell'].every((t) => ro.deny.includes(t)), true);
  eq('只读：这些工具从 allow 里剔除（含 Bash(git:*)），读类保留', ro.allow, ['TodoWrite', 'WebSearch']);
  eq('只读：acceptEdits 被强制成 default（不能让 claude 自己批准编辑），并说明', [ro.mode, /只读运行/.test(ro.note ?? '')], ['default', true]);
  eq('只读：逐项 / 计划不啰嗦', [perm.legacyPolicy({ ...page, pageMode: 'ask', phase: 'step', readOnly: true }).note, perm.legacyPolicy({ ...page, pageMode: 'plan', phase: 'step', readOnly: true }).note], [undefined, undefined]);
  const planPhase = perm.legacyPolicy({ ...page, pageMode: 'acceptEdits', phase: 'plan', readOnly: false });
  eq('计划阶段也一样：不能写、不能跑命令、模式 default', [planPhase.deny.includes('Write'), planPhase.deny.includes('Bash'), planPhase.allow.includes('Bash'), planPhase.mode], [true, true, false, 'default']);
  eq('页面的 deny 名单不被覆盖', perm.legacyPolicy({ allow: [], deny: ['WebFetch'], pageMode: 'ask', phase: 'step', readOnly: true }).deny.includes('WebFetch'), true);
}

console.log('密钥擦除（流式增量）');
{
  const scrubMod = req('./electron/ai/scrub.cjs');
  const KEY = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-abcdef';
  const collect = () => { const out: any[] = []; return { out, sc: scrubMod.createScrubber(KEY, (e: any) => out.push(e)) }; };
  const join = (out: any[], type: string) => out.filter((e) => e.type === type).map((e) => e.text).join('');
  const reply = `好的，环境变量是 ANTHROPIC_API_KEY=${KEY}，请妥善保管。`;
  for (const n of [1, 2, 3, 5, 7, 13, 30]) {
    const { out, sc } = collect();
    for (let i = 0; i < reply.length; i += n) sc.emit({ type: 'text', text: reply.slice(i, i + n) });
    sc.emit({ type: 'done', text: reply, stopReason: 'end_turn' });
    const got = join(out, 'text');
    eq(`每 ${n} 个字符一个增量：密钥原文不会到页面，其余文字原样`, [got.includes(KEY), got.includes('sk-ant-api03'), got], [false, false, reply.replace(KEY, '••••')]);
    eq(`  done.text 也被擦（每 ${n} 个字符）`, out.at(-1).text.includes(KEY), false);
  }
  {
    const { out, sc } = collect();
    sc.emit({ type: 'thinking', text: `让我看看 ${KEY.slice(0, 20)}` });
    sc.emit({ type: 'thinking', text: `${KEY.slice(20)} 这个` });
    sc.emit({ type: 'done', text: '' });
    eq('thinking 增量同样被擦', [join(out, 'thinking').includes(KEY), join(out, 'thinking')], [false, '让我看看 •••• 这个']);
  }
  {
    const { out, sc } = collect();
    sc.emit({ type: 'text', text: `前缀 ${KEY.slice(0, 10)}` });
    sc.emit({ type: 'tool', callId: 'c1', name: 'Bash', input: { command: `echo ${KEY}` } });
    sc.emit({ type: 'tool-end', callId: 'c1', ok: true, output: `K=${KEY}` });
    eq('遇到别的事件先把尾巴冲出去，保持顺序', out.map((e) => e.type), ['text', 'text', 'tool', 'tool-end']);
    eq('冲出去的是不到整把密钥的前缀（不泄露整把）', [join(out, 'text'), join(out, 'text').includes(KEY)], ['前缀 sk-ant-api', false]);
    eq('整块的工具输入 / 输出照旧被擦', [JSON.stringify(out[2]).includes(KEY), JSON.stringify(out[3]).includes(KEY)], [false, false]);
  }
  {
    const { out, sc } = collect();
    sc.emit({ type: 'text', text: `开头 ${KEY.slice(0, 40)}` });
    sc.emit({ type: 'text-break' });
    eq('结束前停在密钥一大段前缀上：不原样给页面', join(out, 'text').includes(KEY.slice(0, 40)), false);
  }
  {
    const { out, sc } = collect();
    sc.emit({ type: 'text', text: '没有密钥的普通文字。' });
    sc.emit({ type: 'text', text: 'sk-' });
    sc.emit({ type: 'done', text: '' });
    eq('没有密钥的文字不丢也不改（结尾恰好像前缀的字符在 done 前冲出）', join(out, 'text'), '没有密钥的普通文字。sk-');
  }
  eq('没有密钥就原样转发', (() => { const out: any[] = []; scrubMod.createScrubber('', (e: any) => out.push(e)).emit({ type: 'text', text: 'x' }); return out; })(), [{ type: 'text', text: 'x' }]);
}

/* ───────────────────── ② 认证 / 预算 / 账本 ───────────────────── */
console.log('认证与 API 计费预算');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-auth-'));
  let clock = new Date(2026, 9, 24, 10, 0, 0);
  const a = authMod.createAuthStore(dir, { now: () => clock });
  eq('默认走已登录的 claude，用 SDK', a.getConfig(), { mode: 'login', dailyUsd: null, monthlyUsd: null, useSdk: true, apiAck: false });
  eq('没有预算不能选 API 密钥', a.setConfig({ mode: 'apikey', apiAck: true }).ok, false);
  eq('没确认「这是 API 计费」不能选', a.setConfig({ mode: 'apikey', dailyUsd: 5, monthlyUsd: 50 }).ok, false);
  eq('日预算高于月预算不行', a.setConfig({ mode: 'apikey', dailyUsd: 60, monthlyUsd: 50, apiAck: true }).ok, false);
  eq('配置没被写成半截', a.getConfig().mode, 'login');
  eq('预算、确认齐全才行', a.setConfig({ mode: 'apikey', dailyUsd: 5, monthlyUsd: 50, apiAck: true }).ok, true);
  eq('预算检查：刚开始是 ok', [a.budgetCheck().level, a.budgetCheck().remainingUsd], ['ok', 5]);
  a.addSpend(3);
  eq('花了 3：还剩 2', a.budgetCheck().remainingUsd, 2);
  a.addSpend(1.2);
  eq('超过 80% → warn', a.budgetCheck().level, 'warn');
  a.addSpend(0.8);
  const stop = a.budgetCheck();
  eq('日预算用完 → stop，不再启动', [stop.level, stop.remainingUsd], ['stop', 0]);
  ok('停用的说明写明是哪个预算', /日预算/.test(stop.message ?? ''), stop.message);
  clock = new Date(2026, 9, 25, 9, 0, 0);
  eq('第二天日预算归零、月累计还在', [a.spend().today, a.spend().monthTotal], [0, 5]);
  eq('第二天可以再用', a.budgetCheck().level, 'ok');
  clock = new Date(2026, 10, 1, 9, 0, 0);
  eq('下个月月累计归零', a.spend().monthTotal, 0);
  eq('login 模式下预算不适用', (() => { a.setConfig({ mode: 'login' }); return a.budgetCheck().applies; })(), false);
  eq('关掉 SDK 开关', (() => { a.setConfig({ useSdk: false }); return a.getConfig().useSdk; })(), false);
  ok('文件里只有数字和开关，没有密钥字样', !/key|token|sk-/i.test(fs.readFileSync(a.files.cfgFile, 'utf8')));
  rm(dir);
}

console.log('会话费用账本（SDK 报累计值，这里换成增量）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-ledger-'));
  const a = authMod.createAuthStore(dir);
  const t1 = { cost: 0.5, input: 1000, output: 200, cacheRead: 100 };
  eq('新会话：第一次整个都算', a.sessionDelta('s1', t1, false), t1);
  eq('同一会话再来一轮：只算增量', a.sessionDelta('s1', { cost: 0.8, input: 1500, output: 260, cacheRead: 150 }, true), { cost: 0.3, input: 500, output: 60, cacheRead: 50 });
  eq('外来会话第一次出现：基线未知', a.sessionDelta('foreign', { cost: 9, input: 9, output: 9, cacheRead: 9 }, true), null);
  eq('之后有了基线', a.sessionDelta('foreign', { cost: 9.5, input: 20, output: 20, cacheRead: 20 }, true)?.cost, 0.5);
  eq('/clear 之后累计变小：这一段就是新的总数', a.sessionDelta('s1', { cost: 0.1, input: 10, output: 5, cacheRead: 0 }, true)?.cost, 0.1);
  eq('没有会话 ID 的新会话：整个算', a.sessionDelta('', t1, false), t1);
  eq('没有会话 ID 的续会话：未知', a.sessionDelta('', t1, true), null);
  rm(dir);
}

console.log('旧驱动的花费：result 里的 total_cost_usd 是会话累计值，换成每回合的增量');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-legacy-cost-'));
  const a = authMod.createAuthStore(dir);
  // 同一会话连跑 3 个回合：累计 0.00048 / 0.00096 / 0.00144，页面逐回合累加，必须每回合都是 0.00048
  const turns = [0.00048, 0.00096, 0.00144].map((total, i) => a.costDelta('legacy-1', total, i > 0));
  eq('三个回合每回合 0.00048（累加得 0.00144，不是 0.00288）', [turns, Math.round(turns.reduce((x: number, y) => x + (y ?? 0), 0) * 1e6) / 1e6], [[0.00048, 0.00048, 0.00048], 0.00144]);
  eq('外来会话（账本里没有）第一次：基线未知，不报花费', a.costDelta('legacy-foreign', 5, true), undefined);
  eq('之后有了基线', a.costDelta('legacy-foreign', 5.25, true), 0.25);
  eq('/clear 之后累计变小：这一段就是新的总数', a.costDelta('legacy-1', 0.0001, true), 0.0001);
  eq('没有会话 ID 的新会话：整个算；续会话：未知', [a.costDelta('', 0.5, false), a.costDelta('', 0.5, true)], [0.5, undefined]);
  eq('不是数字：不报', [a.costDelta('legacy-1', undefined as unknown as number, true), a.costDelta('legacy-1', -1, true), a.costDelta('legacy-1', Number.NaN, true)], [undefined, undefined, undefined]);
  // 和 SDK 路径共用同一个账本文件：旧驱动只改 cost，不能把 SDK 路径靠的 input / output 基线抹掉
  a.sessionDelta('mixed', { cost: 1, input: 1000, output: 100, cacheRead: 10 }, false);
  eq('先走 SDK 再回退到旧驱动：增量正确', a.costDelta('mixed', 1.4, true), 0.4);
  eq('旧驱动之后再走 SDK：input 基线还在，增量正确', a.sessionDelta('mixed', { cost: 1.9, input: 1600, output: 160, cacheRead: 10 }, true), { cost: 0.5, input: 600, output: 60, cacheRead: 0 });
  rm(dir);
}
console.log('claude auth status');
{
  const st = authMod.parseAuthStatus(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'a@b.c', subscriptionType: 'max', apiProvider: 'firstParty', orgId: 'x' }));
  eq('登录状态只取显示用的几项', [st.loggedIn, st.text], [true, 'claude.ai · max · a@b.c']);
  eq('未登录', authMod.parseAuthStatus('{"loggedIn":false,"authMethod":"none"}').loggedIn, false);
  eq('看不懂的输出 → null', authMod.parseAuthStatus('not json'), null);
}
console.log('找 claude');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-shim-'));
  const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, 'x');
  const cmd = path.join(dir, 'claude.cmd');
  fs.writeFileSync(cmd, '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n');
  eq('claude.cmd 旁边的 claude.exe', claudePathMod.exeFromCmdShim(cmd), exe);
  eq('自定义路径填 .cmd 也能解析', claudePathMod.resolveUserClaudeExe(cmd), exe);
  eq('自定义路径填 .exe 就是它自己', claudePathMod.resolveUserClaudeExe(exe), exe);
  rm(dir);
}

/* ───────────────────── ③ SDK 消息 → 事件 ───────────────────── */
console.log('SDK 消息 → StreamEvent');
{
  const evs: any[] = [];
  const m = map.createMapper((e: unknown) => evs.push(e), {});
  m.handle({ type: 'system', subtype: 'init', session_id: 'S1', model: 'claude-sonnet-5-5', permissionMode: 'default', tools: ['Read'] });
  eq('init → session + model', evs.map((e) => e.type), ['session', 'model']);
  eq('init 信息留给驱动核对模式', m.init.permissionMode, 'default');
  evs.length = 0;
  m.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'M1' } } });
  m.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '你好' } } });
  m.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '想一想' } } });
  m.handle({ type: 'stream_event', parent_tool_use_id: 'T9', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '子代理的字' } } });
  eq('文本与思考增量；子代理的增量不进主流', evs.map((e) => `${e.type}:${e.text}`), ['text:你好', 'thinking:想一想']);
  evs.length = 0;
  m.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'M1', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }, content: [{ type: 'text', text: '你好' }, { type: 'tool_use', id: 'u1', name: 'Write', input: { file_path: 'a.txt', content: 'x' } }] } });
  eq('已流式输出过的文本不重复；工具行带标题', evs.map((e) => e.type), ['usage', 'text-break', 'tool']);
  eq('usage 里的上下文占用', evs[0].context, 115);
  eq('工具标题取路径', evs[2].title, 'a.txt');
  evs.length = 0;
  m.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'M2', content: [{ type: 'text', text: '没有流式的端点' }] } });
  eq('没有流式增量时用整段文本', evs.map((e) => `${e.type}:${e.text ?? ''}`), ['text:没有流式的端点']);
  evs.length = 0;
  m.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'M3', content: [{ type: 'tool_use', id: 'q1', name: 'AskUserQuestion', input: {} }, { type: 'tool_use', id: 'q2', name: 'ToolSearch', input: {} }, { type: 'tool_use', id: 'q3', name: 'TodoWrite', input: { todos: [{ content: '读', status: 'completed' }, { content: '写', status: 'pending' }] } }] } });
  eq('提问 / ToolSearch 不显示成工具行；TodoWrite 变成计划事件', evs.map((e) => e.type), ['plan']);
  eq('计划事件的状态', evs[0].entries.map((e: any) => e.status), ['completed', 'pending']);
  evs.length = 0;
  m.handle({ type: 'assistant', parent_tool_use_id: 'T1', message: { id: 'M4', content: [{ type: 'tool_use', id: 'sub1', name: 'Read', input: { file_path: 'b.txt' } }] } });
  eq('子代理的工具调用带「↳」', evs.find((e) => e.type === 'tool').title, '↳ b.txt');
  evs.length = 0;
  m.handle({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', is_error: false, content: [{ type: 'text', text: '写好了' }] }, { type: 'tool_result', tool_use_id: 'q1', content: 'x' }] } });
  eq('tool-end 成对；安静的工具没有', evs.map((e) => `${e.type}:${e.callId}:${e.ok}`), ['tool-end:u1:true']);
  evs.length = 0;
  m.handle({ type: 'system', subtype: 'api_retry', attempt: 2, max_retries: 5, retry_delay_ms: 4000, error_status: 529, error: 'overloaded' });
  m.handle({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour', utilization: 0.83 } });
  m.handle({ type: 'system', subtype: 'compact_boundary' });
  m.handle({ type: 'system', subtype: 'permission_denied', decision_reason_type: 'classifier', tool_name: 'PowerShell', decision_reason: '[Data Exfiltration]' });
  eq('重试 / 额度 / 压缩 / 分类器拦截的事件', evs.map((e) => e.type), ['notice', 'rate-limit', 'notice', 'notice']);
  ok('重试提示带次数', /2\/5/.test(evs[0].text), evs[0].text);
  const res = m.handle({ type: 'result', subtype: 'success', is_error: false, result: '完成', session_id: 'S1', total_cost_usd: 0.25, usage: { input_tokens: 5, output_tokens: 7, cache_read_input_tokens: 3 }, modelUsage: { a: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 30, cacheCreationInputTokens: 20, costUSD: 0.2 }, b: { inputTokens: 10, outputTokens: 5, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.05 } }, queued_turn_count: 0 });
  eq('result：累计用量含子代理（modelUsage 求和）', res.totals, { cost: 0.25, input: 160, output: 55, cacheRead: 30 });
  eq('result：主循环用量', res.turnUsage, { input: 8, output: 7, cacheRead: 3 });
  eq('result：成功、排队 0', [res.isError, res.queued, res.stopReason], [false, 0, 'success']);
  const budget = m.handle({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: 'S1', total_cost_usd: 1, usage: {}, modelUsage: {} });
  eq('超预算 → BUDGET', [budget.isError, budget.code], [true, 'BUDGET']);
  const m2 = map.createMapper(() => {}, {});
  m2.handle({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { id: 'X', content: [] } });
  const auth = m2.handle({ type: 'result', subtype: 'success', is_error: true, result: 'Invalid API key', session_id: 'S2', total_cost_usd: 0, usage: {}, modelUsage: {} });
  eq('认证失败 → AUTH，并给出原因', [auth.code, /认证失败/.test(auth.message)], ['AUTH', true]);
  const deferred = m2.handle({ type: 'result', subtype: 'success', is_error: false, result: '', session_id: 'S2', stop_reason: 'tool_deferred', total_cost_usd: 0, usage: {}, modelUsage: {} });
  eq('tool_deferred 被识别', deferred.deferred, true);
}
console.log('提问的整形');
{
  const qs = sdkDriver.normalizeQuestions({ questions: [{ question: '选哪个？', header: '封面', options: [{ label: 'A', description: 'a' }, { label: 'B' }], multiSelect: true }] });
  eq('问题与选项', qs, [{ question: '选哪个？', header: '封面', options: [{ label: 'A', description: 'a' }, { label: 'B', description: undefined }], multiSelect: true }]);
  eq('答案（对象）', sdkDriver.normalizeAnswers({ '选哪个？': ['A', 'B'] }, qs), { '选哪个？': 'A, B' });
  eq('答案（按顺序的数组）', sdkDriver.normalizeAnswers([['A']], qs), { '选哪个？': 'A' });
  eq('只有一个问题时，随便一个键也对得上', sdkDriver.normalizeAnswers({ x: '自己写的' }, qs), { '选哪个？': '自己写的' });
  eq('没有问题 → 空', sdkDriver.normalizeAnswers({ a: 'b' }, []), {});
}

/* ───────────────────── ④ engine.ts：审批、提问、用量记录 ───────────────────── */
console.log('计划审批状态机');
const mkRun = (over: Partial<Run> = {}): Run => ({
  id: 'r1', taskId: 't1', attempt: 1, status: 'running', createdAt: 1, startedAt: 1, activeMs: 0,
  plan: [{ id: 's1', index: 0, title: '读', detail: '读文件', agentId: 'orchestrator', status: 'pending', toolCallIds: [] }, { id: 's2', index: 1, title: '写', detail: '写文件', agentId: 'coder', status: 'pending', toolCallIds: [] }],
  planReady: true, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [],
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: 1000, series: [] }, cursor: { phase: 'executing', step: 0 }, ...over,
});
const mkState = (run: Run): AppState => produce(emptyState(1), (d) => {
  d.runs[run.id] = run as never;
  d.tasks.t1 = { id: 't1', title: '测试', goal: '目标', createdAt: 1, updatedAt: 1, agentIds: ['orchestrator'], runIds: [run.id], messages: [], kind: 'work' } as Task as never;
});
{
  let st = mkState(mkRun());
  st = produce(st, (d) => { engine.awaitPlanApproval(d, d.runs.r1 as never, 10); });
  eq('计划出来：待批、run 进入 awaiting', [st.runs.r1.planApproval?.status, st.runs.r1.status], ['pending', 'awaiting']);
  eq('待批的 at = 计划就绪的时刻（「待你」里的等待时长从它算，不是运行开始时间）', st.runs.r1.planApproval?.at, 10);
  const bad = produce(st, (d) => { d.runs.r1.planApproval = undefined; });
  eq('不在等批准时不能编辑', produce(bad, (d) => { eq('  返回 ok=false', engine.editPlanDraft(d.runs.r1 as never, [], ['orchestrator']).ok, false); }) !== undefined, true);
  let res: any;
  st = produce(st, (d) => { res = engine.editPlanDraft(d.runs.r1 as never, [{ id: 's2', title: ' 先写 ', detail: '写文件', agentId: 'coder' }, { id: 's1', title: '再读', detail: '', agentId: 'ghost' as never }, { title: '新的一步', detail: 'x', agentId: 'orchestrator' }], ['orchestrator', 'coder']); });
  eq('编辑成功', res.ok, true);
  eq('顺序、标题、id 保留；未知 Agent 回到编排', st.runs.r1.plan.map((p) => [p.id === 's2' || p.id === 's1' ? p.id : 'new', p.title, p.agentId]), [['s2', '先写', 'coder'], ['s1', '再读', 'orchestrator'], ['new', '新的一步', 'orchestrator']]);
  eq('下标重排', st.runs.r1.plan.map((p) => p.index), [0, 1, 2]);
  eq('编辑后仍待批，并记「已编辑」；等待的起点不因编辑重置', st.runs.r1.planApproval, { status: 'pending', at: 10, edited: true });
  produce(st, (d) => { eq('空标题的步骤被丢掉；全空报错', engine.editPlanDraft(d.runs.r1 as never, [{ title: '  ', detail: '', agentId: 'orchestrator' }], ['orchestrator']).ok, false); });
  produce(st, (d) => { eq('超过上限报错', engine.editPlanDraft(d.runs.r1 as never, Array.from({ length: engine.PLAN_STEP_CAP + 1 }, (_, i) => ({ title: `s${i}`, detail: '', agentId: 'orchestrator' as const })), ['orchestrator']).ok, false); });
  st = produce(st, (d) => { eq('批准成功', engine.approvePlan(d, d.runs.r1 as never, 20), true); });
  eq('批准后：approved、run 回到 running、记 edited', [st.runs.r1.planApproval?.status, st.runs.r1.status, st.runs.r1.planApproval?.edited], ['approved', 'running', true]);
  produce(st, (d) => { eq('重复批准无效', engine.approvePlan(d, d.runs.r1 as never, 30), false); });
}
console.log('提问状态机');
{
  let st = mkState(mkRun());
  let ids: string[] = [];
  st = produce(st, (d) => { ids = engine.addQuestions(d, d.runs.r1 as never, [{ question: '甲？', options: [{ label: 'A' }, { label: 'B' }] }, { question: '乙？', options: [{ label: 'X' }], multiSelect: true }], 100); });
  eq('两个问题进 run.questions，run 进入 awaiting', [st.runs.r1.questions?.map((q) => q.status), st.runs.r1.status], [['pending', 'pending'], 'awaiting']);
  st = produce(st, (d) => { engine.answerQuestionDraft(d.runs.r1 as never, ids[0], ['B'], 110); });
  eq('回答一个，另一个仍待答', st.runs.r1.questions?.map((q) => q.status), ['answered', 'pending']);
  st = produce(st, (d) => { engine.resumeAfterAnswers(d, d.runs.r1 as never, 111); });
  eq('还有待答时 run 不回到 running', st.runs.r1.status, 'awaiting');
  st = produce(st, (d) => { engine.answerQuestionDraft(d.runs.r1 as never, ids[1], ['X', '自己写的'], 120); });
  eq('自由文本记进 other', st.runs.r1.questions?.[1].other, '自己写的');
  st = produce(st, (d) => { engine.resumeAfterAnswers(d, d.runs.r1 as never, 121); });
  eq('全答完 → running', st.runs.r1.status, 'running');
  produce(st, (d) => { eq('已回答的不能再答', engine.answerQuestionDraft(d.runs.r1 as never, ids[0], ['A'], 130), undefined); });
  produce(st, (d) => { eq('空回答无效', engine.answerQuestionDraft(d.runs.r1 as never, 'nope', [' '], 130), undefined); });
  let st2 = mkState(mkRun({ planApproval: { status: 'pending' } }));
  st2 = produce(st2, (d) => { engine.addQuestions(d, d.runs.r1 as never, [{ question: '丙？', options: [{ label: 'A' }] }], 100); engine.cancelRun(d, d.runs.r1 as never, 200); });
  eq('取消运行：未答的问题作废、等批准的计划收掉', [st2.runs.r1.questions?.[0].status, st2.runs.r1.planApproval], ['cancelled', undefined]);
  let st3 = mkState(mkRun({ planApproval: { status: 'pending' } }));
  st3 = produce(st3, (d) => { engine.expireOpenAsks(d, d.runs.r1 as never, 5, { keepPlan: true }); });
  eq('暂停时 keepPlan：计划审批保留', st3.runs.r1.planApproval?.status, 'pending');
}
console.log('用量记录');
{
  const r = engine.buildUsageRecord({ at: 2000, taskId: 't1', runId: 'r1', provider: 'claude', model: 'claude-sonnet-5-5', input: 1234.6, output: 56.2, cached: 700, costUsd: 0.0123, startedAt: 500 });
  eq('只有数字与 id', r, { at: 2000, taskId: 't1', runId: 'r1', provider: 'claude', model: 'claude-sonnet-5-5', inputTokens: 1235, outputTokens: 56, cachedTokens: 700, costUsd: 0.0123, durationMs: 1500 });
  eq('没有花费就不写 costUsd', 'costUsd' in engine.buildUsageRecord({ at: 1, taskId: 't', provider: 'gpt', input: 1, output: 1, cached: 0 }), false);
  eq('负数 / NaN 归零', [engine.buildUsageRecord({ at: 1, taskId: 't', provider: 'gpt', input: -5, output: NaN, cached: 0 }).inputTokens, engine.buildUsageRecord({ at: 1, taskId: 't', provider: 'gpt', input: -5, output: NaN, cached: 0 }).outputTokens], [0, 0]);
}

/* ───────────────────── ⑤ live.ts：接一个假的桌面桥 ───────────────────── */
console.log('运行器（假桌面桥）');
{
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function until(label: string, cond: () => boolean, ms = 3000) {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) { ok(`等到：${label}`, false, '超时'); return false; } await sleep(10); }
    return true;
  }
  const PLAN_REPLY = '好的。\n```json\n{"steps":[{"title":"读文件","detail":"先读 README","agent":"orchestrator"},{"title":"写总结","detail":"写出来","agent":"orchestrator"}]}\n```';
  function reset(opts: { trust?: 'T0' | 'T1'; mode?: any } = {}) {
    bridge.specs.length = 0; bridge.answers.length = 0; bridge.stops.length = 0; bridge.calls.length = 0; bridge.onAnswer = null;
    store.init(emptyState(Date.now()));
    const task: Task = {
      id: 't1', title: '整理 README', goal: '整理 README', createdAt: 1, updatedAt: 1, agentIds: ['orchestrator'], runIds: [],
      messages: [{ id: 'm0', role: 'user', text: '整理 README', at: 1 }], kind: 'work', trust: opts.trust,
      engine: { kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: '', label: 'Claude · Claude Code', cwd: process.cwd(), access: 'policy', permissionMode: opts.mode },
    };
    store.update((d) => { d.tasks.t1 = task as never; d.taskOrder.unshift('t1'); });
    // 页面认为 claude 已就绪
    store.update((d) => { d.models.providers.claude.cli = { found: true, login: 'yes', at: 1 }; });
  }
  const run = () => Object.values(store.get().runs)[0];
  const defaultHandler = (_id: string, spec: any, emit: (e: Ev) => void) => {
    emit({ type: 'session', sessionId: `sess-${spec.phase}` });
    emit({ type: 'model', model: 'claude-sonnet-5-5' });
    if (spec.phase === 'plan') emit({ type: 'text', text: PLAN_REPLY });
    else if (spec.access === 'chat') emit({ type: 'text', text: '总结：都做完了。' });
    else emit({ type: 'text', text: '做完了。\n小结：这一步完成' });
    emit({ type: 'usage', total: true, input: 1000, output: 200, cached: 300 });
    emit({ type: 'done', text: '', stopReason: 'end_turn', costUsd: 0.01 });
  };

  /* 5.1 计划先等批准，批准后才执行；编辑后批准 */
  reset({ mode: 'acceptEdits' });
  bridge.handler = defaultHandler;
  const started = live.startLiveRun('t1');
  ok('startLiveRun 成功', started.ok);
  await until('计划出来、run 进入 awaiting', () => run()?.planApproval?.status === 'pending');
  eq('run.status = awaiting', run().status, 'awaiting');
  eq('计划两步', run().plan.map((p) => p.title), ['读文件', '写总结']);
  eq('计划轮的 spec：phase=plan、只读、带权限模式', [bridge.specs[0].phase, bridge.specs[0].readOnly, bridge.specs[0].permissionMode], ['plan', true, 'acceptEdits']);
  eq('计划轮不允许写入工具', ['Write', 'Edit', 'Bash', 'PowerShell'].every((n) => bridge.specs[0].deny.includes(n)), true);
  eq('提问与退出计划不在页面的禁用名单里（SDK 驱动要接）', ['AskUserQuestion', 'ExitPlanMode'].some((n) => bridge.specs[0].deny.includes(n)), false);
  ok('进了「等你批准」的 toast', store.get().toasts.some((t) => t.key === 'plan:' + run().id));
  await sleep(150);
  eq('批准之前不执行任何一步', bridge.specs.length, 1);
  eq('步骤都还没开始', run().plan.map((p) => p.status), ['pending', 'pending']);
  const rid = run().id;
  const edit = runActions.editPlan(rid, [{ id: run().plan[1].id, title: '先写总结', detail: '写出来', agentId: 'orchestrator' }, { id: run().plan[0].id, title: '再读文件', detail: '先读 README', agentId: 'orchestrator' }]);
  ok('批准前可以编辑计划', edit.ok);
  eq('编辑后顺序变了、仍待批', [run().plan.map((p) => p.title), run().planApproval?.status, run().planApproval?.edited], [['先写总结', '再读文件'], 'pending', true]);
  runActions.decidePlan(rid, 'approve');
  await until('运行完成', () => run()?.status === 'completed', 5000);
  eq('批准后按改过的计划执行', bridge.specs.filter((sp: any) => sp.phase === 'step').map((sp: any) => /先写总结|再读文件/.exec(sp.prompt)?.[0]), ['先写总结', '再读文件']);
  eq('执行轮带权限模式与阶段', [bridge.specs[1].phase, bridge.specs[1].permissionMode, bridge.specs[1].readOnly], ['step', 'acceptEdits', false]);
  eq('总结轮没有工具（chat）', bridge.specs[3].access, 'chat');
  const usageCalls = bridge.calls.filter((c: any) => c.channel === 'usage:add');
  eq('每个回合一条用量记录（计划 + 2 步 + 总结）', usageCalls.length, 4);
  eq('用量记录只有数字与 id', Object.keys(JSON.parse(JSON.stringify(usageCalls[0].args[0]))).sort(), ['at', 'cachedTokens', 'costUsd', 'durationMs', 'inputTokens', 'model', 'outputTokens', 'provider', 'runId', 'taskId']);
  eq('记录的内容', [usageCalls[0].args[0].provider, usageCalls[0].args[0].model, usageCalls[0].args[0].inputTokens, usageCalls[0].args[0].cachedTokens, usageCalls[0].args[0].costUsd], ['claude', 'claude-sonnet-5-5', 1000, 300, 0.01]);
  eq('run.costUsd 累加', run().costUsd, 0.04);
  eq('批准后计划状态', run().planApproval?.status, 'approved');

  /* 5.2 发回重做 */
  reset();
  let planCalls = 0;
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'plan') {
      planCalls += 1;
      emit({ type: 'text', text: planCalls === 1 ? PLAN_REPLY : '改好了。\n```json\n{"steps":[{"title":"只读文件","detail":"只读","agent":"orchestrator"}]}\n```' });
      emit({ type: 'done', text: '', stopReason: 'end_turn' });
    } else defaultHandler(id, spec, emit);
  };
  live.startLiveRun('t1');
  await until('第一版计划出来', () => run()?.planApproval?.status === 'pending');
  runActions.decidePlan(run().id, 'revise', '只要读，别写');
  await until('第二版计划出来', () => planCalls === 2 && run()?.planApproval?.status === 'pending' && run().plan.length === 1);
  ok('发回时带上了上一版和意见', /读文件/.test(bridge.specs[1].prompt) && /只要读，别写/.test(bridge.specs[1].prompt), bridge.specs[1].prompt.slice(-200));
  eq('第二版计划', run().plan.map((p) => p.title), ['只读文件']);
  ok('你的意见留在对话里', store.get().tasks.t1.messages.some((m) => m.role === 'user' && /只要读/.test(m.text)));
  live.cancelLive(run().id);
  store.update((d) => { engine.cancelRun(d, d.runs[Object.keys(d.runs)[0]] as never, Date.now()); });
  eq('取消之后计划审批收掉', run().planApproval, undefined);

  /* 5.3 提问：几个问题合并成一次打断 */
  reset();
  let ask: { streamId: string; requestId: string } | null = null;
  let asked = false;
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'step' && !asked) {
      asked = true;
      emit({ type: 'text', text: '先问两件事。' });
      ask = { streamId: id, requestId: 'rq1' };
      bridge.onAnswer = () => { emit({ type: 'text', text: '收到。\n小结：按你的答案做完' }); emit({ type: 'done', text: '', stopReason: 'end_turn', costUsd: 0.02 }); };
      emit({ type: 'question', requestId: 'rq1', callId: 'tu1', questions: [
        { question: '封面选哪一张？', header: '封面', options: [{ label: 'A 夜' }, { label: 'B 昼' }], multiSelect: false },
        { question: '要不要署名？', options: [{ label: '要' }, { label: '不要' }], multiSelect: false },
      ] });
    } else defaultHandler(id, spec, emit);
  };
  live.startLiveRun('t1');
  await until('计划', () => run()?.planApproval?.status === 'pending');
  runActions.decidePlan(run().id, 'approve');
  await until('两个问题进了 run.questions', () => (run()?.questions?.length ?? 0) === 2);
  eq('问题待答、run 在等', [run().questions?.map((q) => q.status), run().status], [['pending', 'pending'], 'awaiting']);
  ok('有「有问题等你回答」的 toast', store.get().toasts.some((t) => t.key === 'question:' + run().id));
  const [q1, q2] = run().questions!;
  runActions.answerQuestion(q1.id, ['B 昼']);
  eq('只答一个：还没有交还模型', bridge.answers.length, 0);
  runActions.answerQuestion(q2.id, ['不要', '但是文末加一行日期']);
  eq('全答完才一次性交还', bridge.answers.length, 1);
  eq('交还的是 allow + 以问题原文为键的答案', [bridge.answers[0].decision, bridge.answers[0].requestId, bridge.answers[0].input], ['allow', 'rq1', { answers: { '封面选哪一张？': 'B 昼', '要不要署名？': '不要, 但是文末加一行日期' } }]);
  ok('我们记得这个提问来自哪条流', !!ask);
  ok('问答留在对话里', store.get().tasks.t1.messages.some((m) => m.role === 'system' && /问：封面选哪一张/.test(m.text) && /答：B 昼/.test(m.text)));
  await until('答完继续、运行完成', () => run()?.status === 'completed', 5000);
  eq('已回答的问题不能再答', runActions.answerQuestion(q1.id, ['A 夜']).ok, false);

  /* 5.4 T0：只读 */
  reset({ trust: 'T0', mode: 'bypass' });
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'step') {
      bridge.onAnswer = () => { emit({ type: 'tool-end', callId: 'c1', ok: false, output: '被拒绝' }); emit({ type: 'text', text: '好的，没写。\n小结：只读' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
      emit({ type: 'tool', callId: 'c1', name: 'Write', input: { file_path: 'a.txt', content: 'x' }, title: 'a.txt' });
      emit({ type: 'permission', requestId: 'p1', callId: 'c1', name: 'Write', input: { file_path: 'a.txt', content: 'x' }, title: 'a.txt' });
    } else defaultHandler(id, spec, emit);
  };
  live.startLiveRun('t1');
  await until('T0 的计划', () => run()?.planApproval?.status === 'pending');
  eq('T0：spec 带 trust、只读、写入工具被禁', [bridge.specs[0].trust, bridge.specs[0].readOnly, bridge.specs[0].deny.includes('Write')], ['T0', true, true]);
  ok('开始时说明了只读', store.get().tasks.t1.messages.some((m) => m.role === 'system' && /还没有被信任/.test(m.text)));
  runActions.decidePlan(run().id, 'approve');
  await until('写入请求被自动拒绝', () => bridge.answers.length === 1);
  eq('T0 的 Write 请求自动 deny，不进审批', [bridge.answers[0].decision, run().approvals.length], ['deny', 0]);
  eq('执行轮仍是 T0 只读', [bridge.specs[1].trust, bridge.specs[1].readOnly], ['T0', true]);
  await until('T0 运行完成', () => run()?.status === 'completed', 5000);

  /* 5.5 暂停时：等批准的计划不丢，提问作废；继续后回到等批准 */
  reset();
  bridge.handler = defaultHandler;
  live.startLiveRun('t1');
  await until('计划', () => run()?.planApproval?.status === 'pending');
  live.pauseLive(run().id);
  eq('暂停：run 暂停、计划审批保留', [run().status, run().planApproval?.status], ['paused', 'pending']);
  live.resumeLive(run().id);
  await until('继续后回到等批准', () => run()?.status === 'awaiting' && run().planApproval?.status === 'pending');
  eq('继续后没有重新制定计划', bridge.specs.length, 1);
  runActions.decidePlan(run().id, 'approve');
  await until('批准后运行完成', () => run()?.status === 'completed', 5000);

  /* 5.6 取消时：未答的问题作废 */
  reset();
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'step') emit({ type: 'question', requestId: 'rq9', questions: [{ question: '继续吗？', options: [{ label: '继续' }], multiSelect: false }] });
    else defaultHandler(id, spec, emit);
  };
  live.startLiveRun('t1');
  await until('计划', () => run()?.planApproval?.status === 'pending');
  runActions.decidePlan(run().id, 'approve');
  await until('问题出现', () => (run()?.questions?.length ?? 0) === 1);
  store.update((d) => { engine.cancelRun(d, d.runs[Object.keys(d.runs)[0]] as never, Date.now()); });
  live.cancelLive(run().id);
  eq('取消后问题作废', run().questions?.[0].status, 'cancelled');
  eq('作废的问题不能再答', runActions.answerQuestion(run().questions![0].id, ['继续']).ok, false);

  /* 5.7 失败：预算错误码带处理提示，未决的东西收掉 */
  reset();
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'plan') defaultHandler(id, spec, emit);
    else emit({ type: 'error', message: '已达到日预算 $5.00', code: 'BUDGET' });
  };
  live.startLiveRun('t1');
  await until('计划', () => run()?.planApproval?.status === 'pending');
  runActions.decidePlan(run().id, 'approve');
  await until('运行失败', () => run()?.status === 'failed', 5000);
  ok('失败信息里有去哪里调预算', store.get().tasks.t1.messages.some((m) => /预算/.test(m.text) && /模型接入/.test(m.text)));
  eq('失败码留在错误记录里', run().errors.at(-1)?.code, 'BUDGET');

  /* 5.8 原生计划模式：计划阶段收到 plan-ready → 交接（deny + handoff）并用它的正文当计划 */
  reset({ mode: 'plan' });
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'plan') {
      bridge.onAnswer = () => { emit({ type: 'text', text: '计划已交出。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
      emit({ type: 'plan-ready', requestId: 'pr1', callId: 'tu', plan: '# 计划\n1. 读 README\n2. 改写开头\n3. 汇报' });
    } else defaultHandler(id, spec, emit);
  };
  live.startLiveRun('t1');
  await until('从计划正文读出计划', () => run()?.planApproval?.status === 'pending');
  eq('计划阶段的 plan-ready 被交接而不是让模型退出计划模式', [bridge.answers[0].decision, (bridge.answers[0].input as any).handoff], ['deny', true]);
  eq('Markdown 清单读成步骤', run().plan.map((p) => p.title), ['读 README', '改写开头', '汇报']);
  eq('计划轮用的是计划模式', bridge.specs[0].permissionMode, 'plan');

  const latest = () => { const t = store.get().tasks.t1; return store.get().runs[t.runIds[t.runIds.length - 1]]; };
  const stepSpecs = () => bridge.specs.filter((sp: any) => sp.phase === 'step').length;

  /* 5.9 K11：计划等批准时点了「取消」，再点「继续未完成的步骤」——不能把从没批准过的计划翻成已批准 */
  reset();
  bridge.handler = defaultHandler;
  live.startLiveRun('t1');
  await until('计划待批', () => run()?.planApproval?.status === 'pending');
  const cancelledId = run().id;
  store.update((d) => { engine.cancelRun(d, d.runs[cancelledId] as never, Date.now()); });
  live.cancelLive(cancelledId);
  eq('取消之后待批状态收掉、计划步骤还在', [run().planApproval, run().planReady, run().plan.length], [undefined, true, 2]);
  const retried = live.startLiveRun('t1', { retryOf: cancelledId, mode: 'resume' });
  ok('继续成功地新开了一次运行', retried.ok);
  await until('重新等批准', () => latest().planApproval?.status === 'pending');
  eq('新运行：重新待批、awaiting、计划步骤都还没开始', [latest().planApproval?.status, latest().status, latest().plan.map((p) => p.status)], ['pending', 'awaiting', ['pending', 'pending']]);
  ok('重新待批的时刻被记下（at）', typeof latest().planApproval?.at === 'number');
  ok('也进了「等你批准」的 toast', store.get().toasts.some((t) => t.key === 'plan:' + latest().id));
  await sleep(150);
  eq('批准之前一步都没有执行', stepSpecs(), 0);
  runActions.decidePlan(latest().id, 'approve');
  await until('批准之后才执行并完成', () => latest()?.status === 'completed', 5000);
  eq('批准之后才出现执行轮', stepSpecs(), 2);

  /* 5.10 对照：上次批准过、执行中失败 → 继续时沿用批准，不再要求批准 */
  reset();
  let failedOnce = false;
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'step' && !failedOnce) { failedOnce = true; emit({ type: 'error', message: '网络断了', code: 'NET' }); return; }
    defaultHandler(id, spec, emit);
  };
  live.startLiveRun('t1');
  await until('计划待批', () => run()?.planApproval?.status === 'pending');
  runActions.decidePlan(run().id, 'approve');
  await until('执行失败', () => run()?.status === 'failed', 5000);
  const failedId = run().id;
  live.startLiveRun('t1', { retryOf: failedId, mode: 'resume' });
  await until('重试后完成', () => latest()?.status === 'completed', 5000);
  eq('批准过的计划：继续时沿用批准、不再等批准', [latest().planApproval?.status, latest().retryMode], ['approved', 'resume']);
  ok('重试没有再弹「计划等你批准」', !store.get().toasts.some((t) => t.key === 'plan:' + latest().id));

  /* 5.11 应用重启后：计划还在等批准，运行被置为暂停（中断）。队列里点「批准计划」必须真的把运行接着跑起来 */
  reset();
  bridge.handler = defaultHandler;
  live.startLiveRun('t1');
  await until('计划待批', () => run()?.planApproval?.status === 'pending');
  const reloadedId = run().id;
  live.cancelLive(reloadedId);   // 旧的驱动循环在重启后不存在了：让它退出、清掉内存里的上下文，再用 normalizeAfterLoad 还原「重启后」的状态
  store.update((d) => { live.normalizeAfterLoad(d, 5000); });
  eq('重启后：暂停(reload)、计划仍待批、记下了中断的时刻', [run().status, run().pauseReason, run().planApproval?.status, run().interruptedAt], ['paused', 'reload', 'pending', 5000]);
  eq('队列里只有「计划待批准」一条，没有重复的「被中断了」', deriveQueue(store.get()).map((i) => i.kind), ['plan']);
  const stepsBeforeApprove = stepSpecs();
  const approved = runActions.decidePlan(reloadedId, 'approve');
  ok('批准成功', approved.ok);
  await until('批准之后运行接着跑完', () => run()?.status === 'completed', 5000);
  eq('不是空操作：真的执行了每一步', [stepsBeforeApprove, stepSpecs()], [0, 2]);

  /* 5.11b 同样的重启后状态：发回重做也要真的重新出计划 */
  reset();
  planCalls = 0;
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'plan') { planCalls += 1; emit({ type: 'text', text: planCalls === 1 ? PLAN_REPLY : '改好了。\n```json\n{"steps":[{"title":"只读文件","detail":"只读","agent":"orchestrator"}]}\n```' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); }
    else defaultHandler(id, spec, emit);
  };
  live.startLiveRun('t1');
  await until('第一版计划', () => run()?.planApproval?.status === 'pending');
  live.cancelLive(run().id);
  store.update((d) => { live.normalizeAfterLoad(d, 5000); });
  runActions.decidePlan(run().id, 'revise', '只读就行');
  await until('重启后发回：重新出了第二版', () => planCalls === 2 && run()?.planApproval?.status === 'pending' && run().plan.length === 1);
  eq('第二版计划在等批准', [run().plan.map((p) => p.title), run().status], [['只读文件'], 'awaiting']);

  /* 5.11c 暂停(reload)的运行点批准时，模型没接好就不能把计划标成已批准 */
  reset();
  bridge.handler = defaultHandler;
  live.startLiveRun('t1');
  await until('计划待批', () => run()?.planApproval?.status === 'pending');
  live.cancelLive(run().id);
  store.update((d) => { live.normalizeAfterLoad(d, 5000); d.tasks.t1.engine = undefined; });
  const noEngine = runActions.decidePlan(run().id, 'approve');
  eq('预检失败：返回错误，计划仍待批，运行仍暂停（没有悄悄标成已批准）', [noEngine.ok, run().planApproval?.status, run().status], [false, 'pending', 'paused']);

  /* 5.12 出错 / 达到预算上限的回合也花了钱：错误事件带 costUsd，要记一条用量、累加 run.costUsd */
  reset();
  bridge.handler = (id: string, spec: any, emit: (e: Ev) => void) => {
    if (spec.phase === 'plan') { defaultHandler(id, spec, emit); return; }
    emit({ type: 'usage', total: true, input: 500_000, output: 90_000, cached: 0 });
    emit({ type: 'error', message: '已达到日预算 $5.00', code: 'BUDGET', costUsd: 0.5 });
  };
  live.startLiveRun('t1');
  await until('计划待批', () => run()?.planApproval?.status === 'pending');
  runActions.decidePlan(run().id, 'approve');
  await until('运行失败', () => run()?.status === 'failed', 5000);
  await sleep(30);
  const adds = bridge.calls.filter((c: any) => c.channel === 'usage:add').map((c: any) => c.args[0]);
  eq('计划轮 + 出错的那一轮各记一条用量', adds.length, 2);
  eq('出错那一轮：token 和花费都在账上', [adds[1].inputTokens, adds[1].outputTokens, adds[1].costUsd], [500_000, 90_000, 0.5]);
  eq('run.costUsd 含出错那一轮', run().costUsd, 0.51);
  // 启动就失败（没有 token、没有花费）不记空记录
  reset();
  bridge.handler = (_id: string, _spec: any, emit: (e: Ev) => void) => { emit({ type: 'error', message: '没配置', code: 'CONFIG' }); };
  bridge.calls.length = 0;
  live.startLiveRun('t1');
  await until('计划轮就失败', () => run()?.status === 'failed', 5000);
  await sleep(30);
  eq('没有 token 也没有花费的失败不记空记录', bridge.calls.filter((c: any) => c.channel === 'usage:add').length, 0);

  /* 5.13 补充说明：页面只常驻尾部窗口，更早的补充要从库里取，计划提示词才完整 */
  reset();
  bridge.userMessages = { t1: [
    { id: 'old1', at: 1, text: '别动 docs 目录' },
    { id: 'old2', at: 2, text: '输出用中文' },
    { id: 'm0', at: 3, text: '整理 README' },
  ] };
  store.update((d) => { d.tasks.t1.messages.push({ id: 'win1', role: 'user', text: '另外加一段安装说明', at: 5 }); d.tasks.t1.messages.push({ id: 'old2', role: 'user', text: '输出用中文', at: 2 }); });
  bridge.handler = defaultHandler;
  live.startLiveRun('t1');
  await until('计划轮已发出', () => bridge.specs.length >= 1);
  const planPrompt = String(bridge.specs[0].prompt);
  ok('窗口之外更早的补充进了计划提示词', planPrompt.includes('别动 docs 目录'), planPrompt);
  ok('窗口里的补充也在', planPrompt.includes('另外加一段安装说明'));
  eq('窗口里已有的不重复；任务目标本身不算补充', [planPrompt.split('输出用中文').length - 1, planPrompt.includes('- 整理 README')], [1, false]);
  eq('更早的在前、窗口里的在后', planPrompt.indexOf('别动 docs 目录') < planPrompt.indexOf('另外加一段安装说明'), true);
  await until('计划待批', () => run()?.planApproval?.status === 'pending');
  live.cancelLive(run().id);
  bridge.userMessages = {};

}

/* ───────────────────── ⑥ 其他引擎：权限模式与临时文件 ───────────────────── */
console.log('Agent 页 + 台词组合：纯函数（遵守矩阵、失败场景、提示词更新行）');
{
  const globals = emptyState(0).tools;
  const withGlobals = (tools: typeof globals, over: Partial<Record<ToolId, ToolPermission>>) => tools.map((t) => (over[t.id] ? { ...t, permission: over[t.id]! } : t));
  const seedAgent = (id: string) => AGENTS.find((a) => a.id === id)!;

  /* honorDriver：provider:auth → 驱动；旧驱动 id 全覆盖 */
  const models = emptyState(0).models;
  const withDriver = (provider: string, driver: string) => ({ ...models, providers: { ...models.providers, [provider]: { ...models.providers[provider], driver: driver as never } } });
  eq('honorDriver：api 方式 → api', honorDriver(models, { key: 'deepseek:api' }), 'api');
  eq('honorDriver：cli 方式 → 服务登记的驱动', honorDriver(withDriver('claude', 'claude-code'), { key: 'claude:cli' }), 'claude-code');
  for (const d of ['claude-code', 'claude-compat', 'codex', 'dsh', 'kimi', 'qwen', 'mcode', 'acp:gemini', 'acp:opencode']) {
    eq(`honorDriver：驱动 ${d} 原样返回`, honorDriver(withDriver('gpt', d), { key: 'gpt:cli' }), d);
  }
  eq('honorDriver：Agent 没指定引擎 → 取任务引擎（api）', honorDriver(models, undefined, { kind: 'live', provider: 'deepseek', auth: 'api', model: 'x', label: 'x' }), 'api');
  eq('honorDriver：任务引擎自带驱动优先', honorDriver(models, undefined, { kind: 'live', provider: 'claude', auth: 'cli', driver: 'codex', model: '', label: 'x' }), 'codex');
  eq('honorDriver：任务引擎没带驱动 → 服务登记的驱动', honorDriver(withDriver('gpt', 'codex'), undefined, { kind: 'live', provider: 'gpt', auth: 'cli', model: '', label: 'x' }), 'codex');
  eq('honorDriver：两者都没有 → undefined', honorDriver(models, undefined), undefined);
  eq('honorDriver：不认识的服务 → undefined', honorDriver(models, { key: 'nope:cli' }), undefined);
  eq('honorDriver：坏的 key → undefined', honorDriver(models, { key: 'garbage' }), undefined);

  /* honorOf：与施工图 §2.1.4 的两张表逐格对（表在这里独立手写一遍，不是从实现里抄）. 格子 = [blocks, asks] */
  const MODES = ['ask', 'plan', 'acceptEdits', 'auto', 'bypass'] as const;
  const CC: Record<string, Record<(typeof MODES)[number], 'yes' | 'no' | 'maybe'>> = {
    read_file: { ask: 'no', plan: 'no', acceptEdits: 'no', auto: 'no', bypass: 'no' },
    code_search: { ask: 'no', plan: 'no', acceptEdits: 'no', auto: 'no', bypass: 'no' },
    write_file: { ask: 'yes', plan: 'yes', acceptEdits: 'no', auto: 'no', bypass: 'no' }, // 自动：工作文件夹内的 Write 直接做（driver-check 7c 实测），越界由栖枝的钩子问
    shell: { ask: 'yes', plan: 'yes', acceptEdits: 'yes', auto: 'maybe', bypass: 'no' },
    git: { ask: 'yes', plan: 'yes', acceptEdits: 'yes', auto: 'maybe', bypass: 'no' },
    web_search: { ask: 'yes', plan: 'yes', acceptEdits: 'yes', auto: 'maybe', bypass: 'no' },
    web_fetch: { ask: 'yes', plan: 'yes', acceptEdits: 'yes', auto: 'maybe', bypass: 'no' },
    browser_read: { ask: 'yes', plan: 'yes', acceptEdits: 'yes', auto: 'maybe', bypass: 'no' },
    browser_act: { ask: 'yes', plan: 'yes', acceptEdits: 'yes', auto: 'maybe', bypass: 'no' },
  };
  const wrong: string[] = [];
  for (const [tool, byMode] of Object.entries(CC)) {
    for (const mode of MODES) {
      const h = honorOf('claude-code', tool as never, 'confirm', mode);
      // claude-compat 走旧驱动：只有逐项和接受编辑，其余模式按逐项处理（permissionSupport / perm.cjs legacyMode）
      const hc = honorOf('claude-compat', tool as never, 'confirm', mode);
      const legacyMode = mode === 'ask' || mode === 'acceptEdits' ? mode : 'ask';
      if (h.asks !== byMode[mode]) wrong.push(`claude-code ${tool}/${mode} asks=${h.asks}`);
      if (hc.asks !== byMode[legacyMode]) wrong.push(`claude-compat ${tool}/${mode} asks=${hc.asks}`);
      if (h.blocks || hc.blocks) wrong.push(`银档不该 blocks：${tool}/${mode}`);
      for (const d of ['claude-code', 'claude-compat'] as const) {
        const off = honorOf(d, tool as never, 'off', mode);
        if (!off.blocks || off.kind !== 'enforced') wrong.push(`${d} 黑档 ${tool}/${mode} 应硬拦`);
        const white = honorOf(d, tool as never, 'auto', mode);
        if (white.blocks || white.asks !== 'no') wrong.push(`${d} 白档 ${tool}/${mode} 不应拦也不应问`);
      }
    }
  }
  eq('honorOf：Claude Code / claude-compat × 9 个工具 × 5 种权限模式 × 三档，与施工图一致', wrong, []);
  eq('honorOf：银档写文件在「接受编辑」下 by-mode、不问；逐项下 enforced、问', [honorOf('claude-code', 'write_file', 'confirm', 'acceptEdits'), honorOf('claude-code', 'write_file', 'confirm', 'ask')].map((h) => [h.kind, h.asks]), [['by-mode', 'no'], ['enforced', 'yes']]);
  // 「自动」模式按 driver-check 7 / 7c 的实测（Bash 与 PowerShell 两种宿主各测过）：工作文件夹内的写入与简单命令直接做；联网、越界的命令交给分类器，分类器不放行就直接拒绝、不会来问人
  eq('honorOf：「自动」下命令 / 联网 / 浏览器银档是 maybe（交给分类器，可能直接拒绝）', ['shell', 'git', 'web_search', 'web_fetch', 'browser_read', 'browser_act'].map((t) => honorOf('claude-code', t as never, 'confirm', 'auto').asks), ['maybe', 'maybe', 'maybe', 'maybe', 'maybe', 'maybe']);
  eq('honorOf：「自动」下写文件银档是「不问」（工作文件夹内直接做），不再说分类器判断', [honorOf('claude-code', 'write_file', 'confirm', 'auto')].map((h) => [h.kind, h.asks, /直接做/.test(h.label), /越出工作文件夹.*栖枝/.test(h.note ?? ''), /分类器/.test(h.label)]), [['by-mode', 'no', true, true, false]]);
  eq('honorOf：「自动」下命令的话点明「简单命令直接做 / 其余分类器 / 直接拒绝不会问」', (({ label, note }) => [label, /简单命令直接做/.test(note ?? ''), /直接拒绝/.test(note ?? ''), /不会来问你/.test(note ?? '')])(honorOf('claude-code', 'shell', 'confirm', 'auto')), ['分类器判断', true, true, true]);
  eq('honorOf：「自动」下联网 / 浏览器的话不提「简单命令」，只说交给分类器', ['web_fetch', 'browser_act'].map((t) => { const h = honorOf('claude-code', t as never, 'confirm', 'auto'); return [h.label, /交给分类器/.test(h.note ?? ''), /简单命令/.test(h.note ?? '')]; }), [['分类器判断', true, false], ['分类器判断', true, false]]);
  eq('honorOf：黑 / 白档在「自动」下与别的模式一样（硬拦 / 不额外限制）', [honorOf('claude-code', 'shell', 'off', 'auto'), honorOf('claude-code', 'write_file', 'off', 'auto'), honorOf('claude-code', 'shell', 'auto', 'auto')].map((h) => [h.blocks, h.asks]), [[true, 'no'], [true, 'no'], [false, 'no']]);
  eq('honorOf：缺省权限模式 = 逐项', honorOf('claude-code', 'shell', 'confirm').asks, 'yes');
  eq('honorOf：other 在任何驱动下都不受限', ['claude-code', 'codex', 'dsh', 'kimi', 'api'].map((d) => honorOf(d as never, 'other', 'off').blocks), [false, false, false, false, false]);

  eq('honorOf：Codex 只认写文件与联网搜索的黑档', ['write_file', 'web_search', 'shell', 'git', 'read_file', 'web_fetch', 'browser_read'].map((t) => honorOf('codex', t as never, 'off', 'ask').blocks), [true, true, false, false, false, false, false]);
  eq('honorOf：Codex 的银 / 白都无效', ['confirm', 'auto'].flatMap((tier) => TIERABLE_TOOLS.map((t) => honorOf('codex', t, tier as never).kind)).every((k) => k === 'none'), true);
  eq('honorOf：Codex 的浏览器黑档是 sandbox（两项都禁用才生效）', [honorOf('codex', 'browser_read', 'off').kind, honorOf('codex', 'browser_act', 'off').kind, honorOf('codex', 'browser_act', 'off').blocks], ['sandbox', 'sandbox', false]);
  eq('honorOf：DSH 一律不受这里限制', TIERABLE_TOOLS.flatMap((t) => (['off', 'confirm', 'auto'] as const).map((tier) => honorOf('dsh', t, tier).kind)).every((k) => k === 'none') && TIERABLE_TOOLS.every((t) => !honorOf('dsh', t, 'off').blocks), true);
  eq('honorOf：DSH 计划模式的备注点出「强制只读」这个唯一例外', /强制只读/.test(honorOf('dsh', 'write_file', 'off', 'plan').note ?? '') && !honorOf('dsh', 'write_file', 'off', 'ask').note, true);
  /* 审查#1：ACP 黑档只靠「代理发来权限请求、我们回绝」生效——Kimi 在自动 / 放手下不发请求，读文件 / 搜索代码通常也不发，不能说「拦住」 */
  const MODES5 = ['ask', 'plan', 'acceptEdits', 'auto', 'bypass'] as const;
  for (const d of ['kimi', 'acp:kimi']) {
    for (const m of MODES5) {
      const h = honorOf(d as never, 'shell', 'off', m);
      const noReq = m === 'auto' || m === 'bypass';
      eq(`honorOf：${d} × ${m} × 黑档命令：${noReq ? '不发请求，拦不住（blocks false）' : '试了才拦（blocks true）'}`, [h.blocks, h.label], noReq ? [false, '不发请求，拦不住'] : [true, '试了才拦']);
    }
  }
  eq('honorOf：非 Kimi 的 ACP（gemini）在自动 / 放手下黑档照样试了才拦', MODES5.map((m) => honorOf('acp:gemini', 'shell', 'off', m).blocks), [true, true, true, true, true]);
  eq('honorOf：ACP 的读文件 / 代码搜索黑档不算拦住（代理通常不发请求）', ['read_file', 'code_search'].flatMap((t) => ['kimi', 'acp:gemini'].map((d) => honorOf(d as never, t as never, 'off', 'ask').blocks)), [false, false, false, false]);
  eq('honorOf：ACP 其余工具黑档仍是试了才拦', ['write_file', 'shell', 'git', 'web_search', 'web_fetch', 'browser_read', 'browser_act'].map((t) => honorOf('acp:gemini', t as never, 'off', 'ask').blocks), [true, true, true, true, true, true, true]);
  eq('honorTally：Kimi 在放手下黑档一项也不算遵守（审查 Agent 的黑档 git / 搜索 / 抓网页…）', (({ honored, kind }) => [honored, kind])(honorTally(seedAgent('reviewer'), globals, 'acp:kimi', 'bypass')), [0, 'none']);
  ok('honorTally：Kimi 逐项下黑档算遵守，放手下比逐项少', honorTally(seedAgent('reviewer'), globals, 'acp:kimi', 'ask').honored > honorTally(seedAgent('reviewer'), globals, 'acp:kimi', 'bypass').honored);
  ok('honorSummary：Kimi 在自动 / 放手下如实写「禁用的工具也不会被拦」，逐项下不写', ['auto', 'bypass'].every((m) => /禁用的工具也不会被拦/.test(honorSummary('acp:kimi', m as never)) && /禁用的工具也不会被拦/.test(honorSummary('kimi', m as never))) && !/禁用的工具也不会被拦/.test(honorSummary('acp:kimi', 'ask')) && !/禁用的工具也不会被拦/.test(honorSummary('acp:gemini', 'bypass')));
  for (const d of ['kimi', 'qwen', 'mcode', 'acp:gemini', 'acp:kimi']) {
    eq(`honorOf：${d} 黑档「试了才拦」，银档「代理自己发请求才问」（maybe），白档无效`, [honorOf(d as never, 'shell', 'off'), honorOf(d as never, 'shell', 'confirm', 'ask'), honorOf(d as never, 'shell', 'auto')].map((h) => [h.kind, h.blocks, h.asks]), [['ask-only', true, 'no'], ['ask-only', false, 'maybe'], ['none', false, 'no']]);
  }
  eq('honorOf：Kimi 在自动 / 放手下不发请求（asks no）', [honorOf('kimi', 'shell', 'confirm', 'auto').asks, honorOf('acp:kimi', 'shell', 'confirm', 'bypass').asks, honorOf('acp:gemini', 'shell', 'confirm', 'bypass').asks], ['no', 'no', 'maybe']);
  eq('honorOf：API 一律无工具', TIERABLE_TOOLS.map((t) => honorOf('api', t, 'off').kind).every((k) => k === 'notools'), true);
  eq('honorOf：解析不出驱动 → 随任务引擎', honorOf(undefined, 'shell', 'off').label, '随任务引擎');

  /* honorPool / honorSummary */
  eq('honorPool：enforced → enf；by-mode / ask-only / sandbox → soft；none / notools → none', [honorOf('claude-code', 'shell', 'confirm', 'ask'), honorOf('claude-code', 'shell', 'confirm', 'auto'), honorOf('kimi', 'shell', 'off'), honorOf('codex', 'write_file', 'off'), honorOf('dsh', 'shell', 'off'), honorOf('api', 'shell', 'off')].map(honorPool), ['enf', 'soft', 'soft', 'soft', 'none', 'none']);
  for (const d of ['claude-code', 'claude-compat', 'codex', 'dsh', 'kimi', 'acp:gemini', 'api', undefined] as const) {
    for (const mode of MODES) {
      const t = honorSummary(d, mode);
      if (!t || /银手套|黑档|黑色审批卡/.test(t)) wrong.push(`honorSummary(${d},${mode}) 空或用了旧词：${t}`);
    }
  }
  eq('honorSummary：每个驱动 × 权限模式都有说明，且不用「银手套 / 黑档 / 黑色审批卡」（D1）', wrong.filter((w) => w.startsWith('honorSummary')), []);
  eq('honorSummary：Claude Code 五种权限模式的话各不相同', new Set(MODES.map((m) => honorSummary('claude-code', m))).size, 5);
  ok('honorSummary：接受编辑下写文件不问、命令照常问', /写文件.*不会问/.test(honorSummary('claude-code', 'acceptEdits')) && /命令.*照常问/.test(honorSummary('claude-code', 'acceptEdits')));
  ok('honorSummary：自动模式如实说可能被直接拒绝', /直接拒绝/.test(honorSummary('claude-code', 'auto')));
  ok('honorSummary：自动模式写明「工作文件夹里的写入与简单命令直接做」「联网 / 越界的命令交给分类器」「不会来问你」，不再说「需确认的工具由分类器判断」', (() => { const t = honorSummary('claude-code', 'auto'); return /自动模式由 Claude Code 自己判断/.test(t) && /工作文件夹里的写入与简单命令直接做/.test(t) && /联网、越出工作文件夹的命令交给模型分类器/.test(t) && /不会来问你/.test(t) && !/需确认的工具由模型分类器判断/.test(t); })());
  ok('PERMISSION_MODE_HINT.auto 与 honorSummary 同口径（直接做 / 分类器 / 直接拒绝）', /直接做/.test(PERMISSION_MODE_HINT.auto) && /分类器/.test(PERMISSION_MODE_HINT.auto) && /直接拒绝/.test(PERMISSION_MODE_HINT.auto));
  ok('honorSummary：Codex 只认写文件和联网搜索', /只认写文件和联网搜索/.test(honorSummary('codex')));
  ok('honorSummary：API 无工具', honorSummary('api') === 'API 方式不使用工具。');
  ok('honorSummary：compat 在计划 / 自动 / 放手下说明按逐项处理', ['plan', 'auto', 'bypass'].every((m) => /逐项/.test(honorSummary('claude-compat', m as never)) && /兼容端点/.test(honorSummary('claude-compat', m as never))));

  /* honorTally：只看有效档 ≠ 白的工具 */
  const tally = (agent: string, driver: Parameters<typeof honorTally>[2], mode?: (typeof MODES)[number]) => honorTally(seedAgent(agent), globals, driver, mode);
  eq('honorTally：编码 Agent 在 Claude Code 逐项下全部遵守（7/7）', tally('coder', 'claude-code'), { kind: 'all', honored: 7, restricting: 7 });
  eq('honorTally：编码 Agent 在 Codex 下只认一部分（3/7：写文件 off、网页搜索 off、浏览器两项都 off）', tally('coder', 'codex'), { kind: 'partial', honored: 3, restricting: 7 });
  eq('honorTally：DSH 下一项都不认', tally('coder', 'dsh'), { kind: 'none', honored: 0, restricting: 7 });
  eq('honorTally：API 下没有工具', tally('coder', 'api'), { kind: 'notools', honored: 0, restricting: 0 });
  eq('honorTally：解析不出驱动不下断言（honored = restricting）', tally('coder', undefined), { kind: 'all', honored: 7, restricting: 7 });
  eq('honorTally：「接受编辑」下 Claude Code 的银档写文件不问 → 部分遵守', tally('coder', 'claude-code', 'acceptEdits').kind, 'partial');
  eq('honorTally：Codex 浏览器两项都 off 才算生效（审查 Agent）', tally('reviewer', 'codex'), { kind: 'partial', honored: 4, restricting: 7 });
  eq('honorTally：Codex 浏览器只关一项时不算生效', honorTally({ id: 'coder', tiers: { browser_read: 'off' } }, globals, 'codex').honored, 0);
  eq('honorTally：没有任何限制 → all', honorTally({ id: 'orchestrator' }, withGlobals(globals, { write_file: 'auto', shell: 'auto', web_fetch: 'auto', git: 'auto', browser_act: 'auto' }), 'codex'), { kind: 'all', honored: 0, restricting: 0 });

  /* 失败场景：错误码 → fail.* */
  const sceneRows: Array<[string | undefined, string, boolean, string]> = [
    ['AUTH', '未登录', false, 'fail.ext'], ['RATE_LIMIT', '限流', false, 'fail.ext'], ['QUOTA', '额度用完', false, 'fail.ext'], ['BUDGET', '预算', false, 'fail.ext'],
    ['ENOTFOUND', '找不到主机', false, 'fail.ext'], ['ECONNRESET', '断线', false, 'fail.ext'], ['ETIMEDOUT', '超时', true, 'fail.ext'], ['ENETWORK', '网络错误', false, 'fail.ext'],
    ['READONLY', '这个任务是只读的', false, 'fail.perm'], ['EACCES', 'permission denied', false, 'fail.perm'], [undefined, '写入被拒：Permission denied', false, 'fail.perm'],
    ['SDK', '出错了', true, 'fail.rep'], [undefined, '出错了', true, 'fail.rep'],
    ['SDK', '出错了', false, 'fail.w'], [undefined, '莫名其妙', false, 'fail.w'], ['CONFIG', '这个任务没有工作文件夹。', false, 'fail.w'],
  ];
  for (const [code, msg, repeated, want] of sceneRows) eq(`failureScene(${code ?? '无码'}, ${msg.slice(0, 12)}, 重复 ${repeated}) → ${want}`, failureScene(code, msg, repeated), want);
  eq('failureReason：取报错第一行，最多 60 字', [failureReason('第一行原因\n第二行细节'), failureReason('x'.repeat(100)).length], ['第一行原因', 60]);
  eq('failureHint：错误码和运行两种入参', [failureHint('AUTH') === failureHint({ errors: [{ id: 'e', at: 1, runId: 'r', stepId: 's', title: 't', code: 'AUTH', message: 'm', fatal: true }] } as never), failureHint('AUTH').includes('模型接入'), failureHint(undefined), failureHint({ errors: [{ id: 'e', at: 1, runId: 'r', stepId: 's', title: 't', code: 'AUTH', message: 'm', fatal: false }] } as never)], [true, true, '', '']);

  /* 提示词更新行：≤300 字，三档各有话量块，夜昼不同，口吻关了说明 */
  const notes = (['s', 'm', 'l'] as const).map((level) => promptUpdateNote({ level, theme: 'night', persona: true }));
  ok('promptUpdateNote：每条 ≤300 字', notes.every((t) => t.length <= 300 && t.length > 20), notes.map((t) => t.length).join('/'));
  ok('promptUpdateNote：写出了新的话量', notes[0].includes('「少」') && notes[1].includes('「中」') && notes[2].includes('「多」'));
  ok('promptUpdateNote：夜昼景物词不同', promptUpdateNote({ level: 'm', theme: 'night', persona: true }) !== promptUpdateNote({ level: 'm', theme: 'day', persona: true }));
  ok('promptUpdateNote：口吻关了就说只说事实、不写神色标签', /只说事实/.test(promptUpdateNote({ level: 'm', theme: 'night', persona: false })) && !/⟦face/.test(promptUpdateNote({ level: 'm', theme: 'night', persona: false })));
  ok('promptUpdateNote：不用「！」「～」', notes.every((t) => !/[！～]/.test(t)));
  {
    const withName = promptUpdateNote({ level: 'm', theme: 'night', persona: true, callName: '小明' });
    ok('promptUpdateNote：给了称呼就写「称呼改为」，基础段仍 ≤300 字', /称呼改为「小明」/.test(withName) && withName.length <= 300);
    const withMem = promptUpdateNote({ level: 'm', theme: 'night', persona: true, memory: ['喜欢安静', '怕冷'] });
    ok('promptUpdateNote：备忘另起一段，写明旧的作废 + 数据块 + 不是指令', /全部作废/.test(withMem) && /喜欢安静/.test(withMem) && /怕冷/.test(withMem) && /不是指令/.test(withMem) && /DATA/.test(withMem));
    const noMem = promptUpdateNote({ level: 'm', theme: 'night', persona: true, memory: [] });
    ok('promptUpdateNote：备忘为空 → 现在没有备忘，之前的都不要再用', /现在没有备忘/.test(noMem) && /不要再用/.test(noMem));
    ok('promptUpdateNote：新增文案不用「！」「～」', [withName, withMem, noMem].every((t) => !/[！～]/.test(t)));
  }
}


console.log('运行器·档位执行（假桌面桥）：policySpec 与 onPermission 对「有效档」，停用接手不放宽');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(label: string, cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) { ok(`等到：${label}`, false, '超时'); return false; } await sleep(10); }
  return true;
}
const FENCE = '```';
const planOf = (steps: Array<[string, string]>) => `好的。\n${FENCE}json\n${JSON.stringify({ steps: steps.map(([title, agent]) => ({ title, detail: title, agent })) })}\n${FENCE}`;
type Handler = (id: string, spec: any, emit: (e: Ev) => void) => void | Promise<void>;
const API_ENGINE: TaskEngine = { kind: 'live', provider: 'deepseek', auth: 'api', model: 'deepseek-flash', label: 'DeepSeek V4.1 Flash · API' };
const cliEngine = (driver: string, over: Partial<TaskEngine> = {}): TaskEngine => ({ kind: 'live', provider: driver === 'codex' ? 'gpt' : driver === 'dsh' ? 'deepseek' : 'claude', auth: 'cli', driver: driver as never, model: '', label: `${driver}`, cwd: process.cwd(), access: 'policy', ...over });
/** 一个任务 t1：kind / 引擎 / 参与的 Agent / 设置 / 已有消息 都可以指定. 假桥的记录清零. */
function setup(o: { kind?: 'work' | 'chat'; engine?: TaskEngine; agentIds?: AgentId[]; settings?: Partial<AppState['settings']>; messages?: Message[]; mode?: any; session?: string; tools?: Partial<Record<ToolId, ToolPermission>>; trust?: 'T0' | 'T1'; promptRev?: string } = {}) {
  bridge.specs.length = 0; bridge.answers.length = 0; bridge.stops.length = 0; bridge.calls.length = 0; bridge.onAnswer = null; bridge.handler = null;
  const base = emptyState(Date.now());
  store.init(base);
  const engine = o.engine ?? cliEngine('claude-code', { permissionMode: o.mode });
  const task: Task = {
    id: 't1', title: '整理 README', goal: '整理 README', createdAt: 1, updatedAt: 1, agentIds: o.agentIds ?? ['orchestrator'], runIds: [],
    messages: o.messages ?? [{ id: 'm0', role: 'user', text: '整理 README', at: 1 }], kind: o.kind ?? 'work', engine, session: o.session, trust: o.trust, promptRev: o.promptRev,
  };
  store.update((d) => {
    Object.assign(d.settings, o.settings ?? {});
    for (const [id, p] of Object.entries(o.tools ?? {})) { const t = d.tools.find((x) => x.id === id); if (t) t.permission = p!; }
    d.models.providers.claude.cli = { found: true, login: 'yes', at: 1 };
    d.models.providers.gpt.cli = { found: true, login: 'yes', at: 1 };
    d.models.providers.deepseek.cli = { found: true, login: 'yes', at: 1 };
    d.models.providers.deepseek.keyHint = '••••abcd';
    d.models.providers.deepseek.model = 'deepseek-flash';
    d.tasks.t1 = task as never;
    d.taskOrder.unshift('t1');
  });
}
const T = () => store.get().tasks.t1;
const run0 = () => Object.values(store.get().runs)[0];
const her = (scene: string) => T().messages.filter((m) => m.role === 'agent' && m.src?.scene === scene);
/** 一轮请求是计划 / 执行一步 / 汇总：命令行引擎的 spec 带 phase，API 的没有，看提示文字. */
const specText = (sp: any): string => String(sp.prompt ?? sp.messages?.at(-1)?.content ?? '');
const isPlanSpec = (sp: any) => sp.phase === 'plan' || specText(sp).includes('2 到 6 步的执行计划');
const isStepSpec = (sp: any) => sp.phase === 'step' || specText(sp).includes('现在执行第');
const isSummarySpec = (sp: any) => sp.access === 'chat' && !isPlanSpec(sp) || specText(sp).includes('所有步骤都已结束');
const stepSpecs = () => bridge.specs.filter(isStepSpec);
/** 计划轮回计划、每一步的 handler 由测试给；总结轮回一句话. */
const withPlan = (steps: Array<[string, string]>, onStep: Handler): Handler => async (id, spec, emit) => {
  if (isPlanSpec(spec)) { emit({ type: 'text', text: planOf(steps) }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); return; }
  if (isSummarySpec(spec)) { emit({ type: 'text', text: '总结：都做完了。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); return; }
  await onStep(id, spec, emit);
};
const finishStep: Handler = (_id, _spec, emit) => { emit({ type: 'text', text: '做完了。\n小结：这一步完成' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
const ALL_AGENTS: AgentId[] = ['orchestrator', 'researcher', 'coder', 'reviewer'];
/** 开跑、批准计划、等完成（或失败）. */
async function runPlan(handler: Handler, o: Parameters<typeof setup>[0] = {}, until2: () => boolean = () => run0()?.status === 'completed') {
  setup({ agentIds: ALL_AGENTS, ...o });
  bridge.handler = handler;
  live.startLiveRun('t1');
  await until('计划待批', () => run0()?.planApproval?.status === 'pending');
  runActions.decidePlan(run0().id, 'approve');
  await until('运行结束', () => until2() || ['completed', 'failed'].includes(run0()?.status), 6000);
}
const inSet = (arr: string[] | undefined, ...names: string[]) => names.every((n) => (arr ?? []).includes(n));

{
  /* 1. policySpec：每一步按自己的有效档出 allow / deny */
  await runPlan(withPlan([['查资料', 'researcher'], ['写代码', 'coder'], ['复核', 'reviewer'], ['统筹', 'orchestrator']], finishStep), { engine: cliEngine('claude-code', { browser: true }) });
  const [sr, sc, sv, so] = stepSpecs();
  eq('四步都执行了', stepSpecs().length, 4);
  ok('检索：写文件 / 执行命令 / git 是黑档 → 进 deny', inSet(sr.deny, 'Write', 'Edit', 'Bash', 'PowerShell', 'Bash(git:*)'));
  ok('检索：网页搜索（全局白）→ allow；Bash 不在 allow', inSet(sr.allow, 'WebSearch') && !sr.allow.includes('Bash'));
  ok('编码：联网与浏览器是黑档 → deny；执行命令（全局银）两边都不放', inSet(sc.deny, 'WebSearch', 'WebFetch', 'mcp__alight-browser__browser_click', 'mcp__alight-browser__browser_snapshot') && !sc.deny.includes('Bash') && !sc.allow.includes('Bash') && !sc.allow.includes('Write'));
  ok('审查：写文件 / 联网 / git / 浏览器黑档', inSet(sv.deny, 'Write', 'WebSearch', 'WebFetch', 'Bash(git:*)', 'mcp__alight-browser__browser_navigate') && !sv.deny.includes('Bash'));
  ok('编排：沿用全局档——没有额外的 deny（只有无头关掉的那几个）', !so.deny.includes('Write') && !so.deny.includes('WebSearch') && inSet(so.allow, 'WebSearch'));
  eq('浏览器：检索 / 编排有；编码、审查把两项都收紧成黑档，不挂载', [sr.browser, sc.browser, sv.browser, so.browser], [true, false, false, true]);

  /* 2. Bash 特例：shell 与 git 同属 Bash，两者都白才把 Bash 放进 allow */
  const bashSpec = async (tools: Partial<Record<ToolId, ToolPermission>>) => {
    await runPlan(withPlan([['统筹', 'orchestrator']], finishStep), { tools, agentIds: ['orchestrator'] });
    return stepSpecs()[0];
  };
  let sp = await bashSpec({ shell: 'auto', git: 'auto' });
  ok('shell 白 + git 白 → Bash 与 Bash(git:*) 都放行', inSet(sp.allow, 'Bash', 'PowerShell', 'Bash(git:*)'));
  sp = await bashSpec({ shell: 'auto', git: 'confirm' });
  ok('shell 白 + git 银 → Bash 不放行（每条命令走审批回调按类别判）、也不禁', !sp.allow.includes('Bash') && !sp.allow.includes('Bash(git:*)') && !sp.deny.includes('Bash'));
  sp = await bashSpec({ shell: 'auto', git: 'off' });
  ok('shell 白 + git 黑 → Bash(git:*) 禁用，Bash 不整体放行', sp.deny.includes('Bash(git:*)') && !sp.allow.includes('Bash') && !sp.deny.includes('Bash'));
  sp = await bashSpec({ shell: 'off', git: 'auto' });
  ok('shell 黑 → Bash 禁用，git 的有效档随之是黑：Bash(git:*) 也在禁用名单里、不放行（审查#3：Bash 整体被禁，git 并不能用）', inSet(sp.deny, 'Bash', 'PowerShell', 'Bash(git:*)') && !sp.allow.includes('Bash(git:*)') && !sp.allow.includes('PowerShell(git:*)'));
  {
    const sg = store.get().tools.map((t) => (t.id === 'shell' ? { ...t, permission: 'off' as const } : t.id === 'git' ? { ...t, permission: 'auto' as const } : t));
    const coder = { id: 'coder' as AgentId, tiers: undefined };
    eq('审查#3：执行命令是黑档时 git 的有效档也是黑（牌面计数、工具行、honorTally 都按黑算，不再显示「不额外限制」）', [effectiveTier(coder, 'git', sg), effectiveTier(coder, 'shell', sg), tierCounts(coder, sg).off >= 2], ['off', 'off', true]);
    const sg2 = sg.map((t) => (t.id === 'shell' ? { ...t, permission: 'auto' as const } : t));
    eq('审查#3：执行命令不是黑档时 git 档位只看自己', [effectiveTier(coder, 'git', sg2), effectiveTier({ id: 'coder' as AgentId, tiers: { shell: 'off' } }, 'git', sg2)], ['auto', 'off']);
  }
  sp = await bashSpec({ shell: 'confirm', git: 'auto' });
  ok('shell 银 + git 白 → 只放行 git 前缀', inSet(sp.allow, 'Bash(git:*)') && !sp.allow.includes('Bash'));

  /* 3. Codex：沙箱与联网看有效档 */
  await runPlan(withPlan([['查资料', 'researcher'], ['写代码', 'coder'], ['统筹', 'orchestrator']], finishStep), { engine: cliEngine('codex') });
  const cs = stepSpecs();
  eq('Codex：检索（写文件黑档）→ 只读沙箱，联网搜索开着', [cs[0].sandbox, cs[0].webSearch], ['read-only', true]);
  eq('Codex：编码（联网黑档）→ 可写沙箱，不联网', [cs[1].sandbox, cs[1].webSearch], ['workspace-write', false]);
  eq('Codex：编排沿用全局', [cs[2].sandbox, cs[2].webSearch], ['workspace-write', true]);
  await runPlan(withPlan([['统筹', 'orchestrator']], finishStep), { engine: cliEngine('codex'), agentIds: ['orchestrator'], tools: { write_file: 'off', web_search: 'off' } });
  eq('Codex：全局把写文件关了 → 只读沙箱；联网关了 → 不联网', [stepSpecs()[0].sandbox, stepSpecs()[0].webSearch], ['read-only', false]);
  eq('Codex：计划轮永远是只读沙箱', bridge.specs[0].sandbox, 'read-only');

  /* 4. 全局调严之后 Agent 的覆盖保持（不清理）；Agent 页上的收紧立即在下一步生效 */
  setup({ agentIds: ALL_AGENTS });
  store.update((d) => { d.tools.find((t) => t.id === 'shell')!.permission = 'off'; });
  ok('全局黑 + 覆盖保留：覆盖没被清理', store.get().agents.find((a) => a.id === 'researcher')?.tiers?.shell === 'off');
}

{
  /* 5. onPermission：同一份请求，不同 Agent 的有效档不同；拒绝原因区分「全局禁用」与「X Agent 已收紧」 */
  const reqs: Array<[string, string, Record<string, unknown>]> = [
    ['rd', 'Read', { file_path: 'README.md' }], ['wr', 'Write', { file_path: 'a.txt', content: 'x' }], ['ws', 'WebSearch', { query: 'x' }], ['wf', 'WebFetch', { url: 'https://example.com' }],
    ['sh', 'Bash', { command: 'npm test' }], ['gt', 'Bash', { command: 'git status' }], ['bn', 'mcp__alight-browser__browser_navigate', { url: 'https://example.com' }], ['ot', 'Task', {}],
  ];
  const asker = (names: Record<string, string>): Handler => async (id, spec, emit) => {
    const mine = names[spec.prompt.match(/第 (\d)\/\d 步/)?.[1] ?? ''];
    for (const [key, name, input] of reqs) {
      emit({ type: 'tool', callId: `${mine}-${key}`, name, input, title: key });
      emit({ type: 'permission', requestId: `${mine}-${key}`, callId: `${mine}-${key}`, name, input, title: key });
    }
    await sleep(60);
    emit({ type: 'text', text: '问完了。\n小结：问完了' });
    emit({ type: 'done', text: '', stopReason: 'end_turn' });
    void id;
  };
  const decisions = (steps: Array<[string, string]>) => {
    const r = run0();
    // 每个请求：自动应答 allow / deny，或进了审批（ask）
    return steps.map(([prefix]) => Object.fromEntries(reqs.map(([key]) => {
      const a = bridge.answers.find((x) => x.requestId === `${prefix}-${key}`);
      const pending = r.approvals.some((ap) => ap.title.endsWith(`：${key}`) && ap.stepId === r.plan[Number(prefix) - 1]?.id);
      return [key, a ? a.decision : pending ? 'ask' : '?'];
    })));
  };
  const steps2: Array<[string, string]> = [['检索一步', 'researcher'], ['编码一步', 'coder'], ['审查一步', 'reviewer'], ['编排一步', 'orchestrator']];
  await runPlan(withPlan(steps2, asker({ 1: '1', 2: '2', 3: '3', 4: '4' })), { engine: cliEngine('claude-code', { browser: true }) });
  const d = decisions([['1', ''], ['2', ''], ['3', ''], ['4', '']]);
  eq('检索：读 allow；写 deny（黑）；搜索 allow；抓网页 ask；shell deny（黑）；git deny（黑）；浏览器 ask；other ask', d[0], { rd: 'allow', wr: 'deny', ws: 'allow', wf: 'ask', sh: 'deny', gt: 'deny', bn: 'ask', ot: 'ask' });
  eq('编码：读 allow；写 ask；搜索 deny（黑）；抓网页 deny（黑）；shell ask；git ask；浏览器 deny（黑）', d[1], { rd: 'allow', wr: 'ask', ws: 'deny', wf: 'deny', sh: 'ask', gt: 'ask', bn: 'deny', ot: 'ask' });
  eq('审查：写 deny；搜索 deny；抓网页 deny；shell ask；git deny；浏览器 deny', d[2], { rd: 'allow', wr: 'deny', ws: 'deny', wf: 'deny', sh: 'ask', gt: 'deny', bn: 'deny', ot: 'ask' });
  eq('编排：沿用全局——写 ask，搜索 allow，抓网页 ask，shell ask，git ask，浏览器 ask', d[3], { rd: 'allow', wr: 'ask', ws: 'allow', wf: 'ask', sh: 'ask', gt: 'ask', bn: 'ask', ot: 'ask' });
  const callOf = (stepNo: number, key: string) => run0().toolCalls.find((c) => c.title === key && c.stepId === run0().plan[stepNo - 1].id);
  ok('检索写文件被拒：原因是「检索 Agent 在 Agent 页调成了禁用」', /检索 Agent.*Agent 页.*禁用/.test(callOf(1, 'wr')?.output ?? ''), callOf(1, 'wr')?.output);
  ok('编排的审批卡署名执行者（编排），检索的 ask 记检索', run0().approvals.filter((a) => a.stepId === run0().plan[3].id).every((a) => a.agentId === 'orchestrator') && run0().approvals.filter((a) => a.stepId === run0().plan[0].id).every((a) => a.agentId === 'researcher'));

  /* 6. 全局禁用与 Agent 收紧的拒绝原因不同 */
  await runPlan(withPlan([['统筹', 'orchestrator']], asker({ 1: '1' })), { tools: { web_search: 'off' }, agentIds: ['orchestrator'] });
  ok('全局禁用的拒绝原因写「工具与技能」', /工具与技能/.test(callOf(1, 'ws')?.output ?? '') && bridge.answers.find((x) => x.requestId === '1-ws')?.decision === 'deny');

  /* 7. Bash 特例在 onPermission 里：shell 白 + git 银 → 命令放行、git 命令问 */
  await runPlan(withPlan([['统筹', 'orchestrator']], asker({ 1: '1' })), { tools: { shell: 'auto', git: 'confirm' }, agentIds: ['orchestrator'] });
  eq('shell 白 + git 银：npm test allow，git status 进审批', [bridge.answers.find((x) => x.requestId === '1-sh')?.decision, bridge.answers.find((x) => x.requestId === '1-gt')?.decision, run0().approvals.some((a) => a.tool === 'git')], ['allow', undefined, true]);

  /* 7b. 审查#2：git 档不能被「带路径 / 复合」的写法绕开——命令里出现 git，取 shell 与 git 两档里较严的 */
  const gitForms: Array<[string, string]> = [['abs', '/usr/bin/git push'], ['cmd', 'command git push'], ['semi', 'git push; true'], ['cmp', 'cd x && git push'], ['env', 'GIT_DIR=x git push'], ['sub', 'echo $(git push)'], ['npm', 'npm test'], ['ign', 'cat .gitignore']];
  const gitAsker: Handler = async (id, _spec, emit) => {
    for (const [key, cmd] of gitForms) {
      emit({ type: 'tool', callId: `g-${key}`, name: 'Bash', input: { command: cmd }, title: key });
      emit({ type: 'permission', requestId: `g-${key}`, callId: `g-${key}`, name: 'Bash', input: { command: cmd }, title: key });
    }
    await sleep(60);
    emit({ type: 'text', text: '问完了。\n小结：问完了' });
    emit({ type: 'done', text: '', stopReason: 'end_turn' });
    void id;
  };
  const gitDecisions = () => Object.fromEntries(gitForms.map(([key]) => [key, bridge.answers.find((x) => x.requestId === `g-${key}`)?.decision ?? (run0().approvals.some((a) => a.title.endsWith(`：${key}`)) ? 'ask' : '?')]));
  await runPlan(withPlan([['统筹', 'orchestrator']], gitAsker), { tools: { shell: 'auto', git: 'off' }, agentIds: ['orchestrator'] });
  eq('shell 白 + git 黑：带路径 / command / 环境变量 / 复合 / 子命令里的 git 一律拒绝；npm test 与 .gitignore 照常放行', gitDecisions(), { abs: 'deny', cmd: 'deny', semi: 'deny', cmp: 'deny', env: 'deny', sub: 'deny', npm: 'allow', ign: 'allow' });
  ok('git 黑拒绝的原因写的是「Git」而不是「执行命令」', /Git|git/.test(run0().toolCalls.find((c) => c.title === 'abs')?.output ?? ''), run0().toolCalls.find((c) => c.title === 'abs')?.output);
  await runPlan(withPlan([['统筹', 'orchestrator']], gitAsker), { tools: { shell: 'auto', git: 'confirm' }, agentIds: ['orchestrator'] });
  eq('shell 白 + git 银：这些 git 写法都进审批（不被 shell 白档直接放行）', gitDecisions(), { abs: 'ask', cmd: 'ask', semi: 'ask', cmp: 'ask', env: 'ask', sub: 'ask', npm: 'allow', ign: 'allow' });
  await runPlan(withPlan([['统筹', 'orchestrator']], gitAsker), { tools: { shell: 'confirm', git: 'auto' }, agentIds: ['orchestrator'] });
  eq('shell 银 + git 白：复合命令按较严的 shell 档问；单纯的 git 命令不在这里问', gitDecisions(), { abs: 'ask', cmd: 'ask', semi: 'ask', cmp: 'ask', env: 'ask', sub: 'ask', npm: 'ask', ign: 'ask' });

  /* 8. 停用接手不放宽：审查被停用后，指给它的步骤由编排执行，档位仍按审查 */
  const takeoverRun = async (mutate: () => void) => {
    setup({ agentIds: ALL_AGENTS });
    bridge.handler = withPlan([['复核', 'reviewer']], asker({ 1: '1' }));
    live.startLiveRun('t1');
    await until('计划待批', () => run0()?.planApproval?.status === 'pending');
    mutate();
    runActions.decidePlan(run0().id, 'approve');
    await until('运行结束', () => ['completed', 'failed'].includes(run0()?.status), 6000);
  };
  await takeoverRun(() => store.update((dd) => { dd.agents.find((a) => a.id === 'reviewer')!.enabled = false; }));
  const tk = stepSpecs()[0];
  ok('接手：执行者是编排，但写文件 / 联网 / git / 浏览器仍按审查的黑档禁用', inSet(tk.deny, 'Write', 'WebSearch', 'WebFetch', 'Bash(git:*)', 'mcp__alight-browser__browser_navigate'));
  eq('接手：写文件请求仍被拒（按审查的档，不是编排的全局银）', [bridge.answers.find((x) => x.requestId === '1-wr')?.decision, bridge.answers.find((x) => x.requestId === '1-ws')?.decision, bridge.answers.find((x) => x.requestId === '1-sh')?.decision], ['deny', 'deny', undefined]);
  ok('接手：拒绝原因点名审查 Agent', /审查 Agent/.test(callOf(1, 'wr')?.output ?? ''), callOf(1, 'wr')?.output);
  eq('接手：PlanStep.agentId 仍是审查，ranAs 是编排', [run0().plan[0].agentId, run0().plan[0].ranAs], ['reviewer', 'orchestrator']);
  ok('接手：ToolCall / Approval 记执行者（编排）', run0().toolCalls.every((c) => c.agentId === 'orchestrator') && run0().approvals.every((a) => a.agentId === 'orchestrator'));
  ok('接手：步骤提示写明「原由审查 Agent 负责，已由编排接手」', /审查 Agent/.test(tk.prompt) && /接手/.test(tk.prompt) && /不会比它更宽/.test(tk.prompt), tk.prompt.slice(0, 160));
  eq('接手：run.live 与消息署名用实际执行者', T().messages.filter((m) => m.runId === run0().id && m.role === 'agent' && /问完了/.test(m.text)).map((m) => m.agentId), ['orchestrator']);
  await takeoverRun(() => store.update((dd) => { dd.agents = dd.agents.filter((a) => a.id !== 'reviewer'); }));
  eq('Agent 已删（找不到）：回落全局档——写文件进审批，不再 deny', [bridge.answers.find((x) => x.requestId === '1-wr')?.decision, run0().approvals.some((a) => a.tool === 'write_file')], [undefined, true]);
  await takeoverRun(() => {});
  eq('没停用时：审查自己执行，不写 ranAs', [run0().plan[0].ranAs, bridge.answers.find((x) => x.requestId === '1-wr')?.decision], [undefined, 'deny']);

  /* 9. 浏览器开关读有效档：两项都 off 才不挂载 */
  setup({ agentIds: ALL_AGENTS, engine: cliEngine('claude-code', { browser: true }), tools: { browser_read: 'off', browser_act: 'off' } });
  bridge.handler = withPlan([['统筹', 'orchestrator']], finishStep);
  live.startLiveRun('t1');
  await until('计划待批', () => run0()?.planApproval?.status === 'pending');
  runActions.decidePlan(run0().id, 'approve');
  await until('完成', () => run0()?.status === 'completed', 5000);
  eq('全局两项浏览器都关 → 步骤不挂载浏览器', stepSpecs()[0].browser, false);
  setup({ agentIds: ALL_AGENTS, engine: cliEngine('claude-code', { browser: true }), tools: { browser_read: 'off' } });
  bridge.handler = withPlan([['统筹', 'orchestrator']], finishStep);
  live.startLiveRun('t1');
  await until('计划待批', () => run0()?.planApproval?.status === 'pending');
  runActions.decidePlan(run0().id, 'approve');
  await until('完成', () => run0()?.status === 'completed', 5000);
  eq('只关一项 → 仍挂载', stepSpecs()[0].browser, true);
}


console.log('运行器·她的声音（假桌面桥）：标签、历史回放、提示词、静默、危机、落蝶');
{
  const sample = (fn: () => string[]) => { const seen: string[] = []; const t = setInterval(() => { seen.push(...fn()); }, 15); return { seen, stop: () => clearInterval(t) }; };
  const herTexts = () => T().messages.filter((m) => m.role === 'agent').map((m) => m.text);
  const done = () => !live.isReplying('t1') && T().messages.some((m) => m.role === 'agent');
  const leaks = (xs: string[]) => xs.filter((x) => /⟦|⟧|〚|〛|face:|react:/.test(x));

  /* 1. 闲聊：标签在流里切开也不漏；中段（工具暂停后续写）的标签被剥掉 */
  setup({ kind: 'chat', engine: API_ENGINE, messages: [] });
  bridge.handler = async (_id, _spec, emit) => {
    emit({ type: 'text', text: '⟦fa' }); await sleep(110);
    emit({ type: 'text', text: 'ce:shy｜react:but' }); await sleep(110);
    emit({ type: 'text', text: 'terfly⟧你好。' }); await sleep(110);
    emit({ type: 'tool', callId: 'c1', name: 'Read', input: { file_path: 'a' }, title: 'a' }); emit({ type: 'tool-end', callId: 'c1', ok: true, output: '' });
    emit({ type: 'text', text: '⟦face:gen' }); await sleep(110);
    emit({ type: 'text', text: 'tle⟧再见。' }); await sleep(60);
    emit({ type: 'done', text: '', stopReason: 'end_turn' });
  };
  let sm = sample(herTexts);
  backend.sendMessage('t1', '你好');
  await until('回复写完', () => done());
  sm.stop();
  eq('流式过程中任何一次采样都没有标签残片（切在标签中间也不漏）', leaks(sm.seen), []);
  const m1 = T().messages.find((m) => m.role === 'agent')!;
  eq('文字已剥标签（中段的标签也剥了）', m1.text.replace(/\s+/g, ''), '你好。再见。');
  eq('神色取开头标签（开头优先）', m1.expr, 'shy');
  ok('react 要么没采纳，要么是白名单里的', m1.react === undefined || m1.react === 'butterfly');
  eq('只有一条她的话（工具暂停没有把气泡拆成两条）', T().messages.filter((m) => m.role === 'agent').length, 1);

  /* 2. 工作：标签不进 st.result / 结果汇总.md / 小结；计划引言带标签 */
  await runPlan(async (_id, spec, emit) => {
    if (isPlanSpec(spec)) { emit({ type: 'text', text: `⟦face:gentle⟧好的，我先看看。\n${FENCE}json\n${JSON.stringify({ steps: [{ title: '读', detail: '读', agent: 'orchestrator' }] })}\n${FENCE}` }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); return; }
    if (isSummarySpec(spec)) { emit({ type: 'text', text: '⟦face:relaxed⟧总结：都好了。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); return; }
    emit({ type: 'text', text: '⟦face:relaxed⟧读了。' });
    emit({ type: 'tool', callId: 'c1', name: 'Read', input: { file_path: 'a' }, title: 'a' }); emit({ type: 'tool-end', callId: 'c1', ok: true, output: 'x' });
    emit({ type: 'text', text: '⟦face:shy⟧再说一句。\n小结：这一步完成⟦face:gentle⟧' });
    emit({ type: 'done', text: '', stopReason: 'end_turn' });
  }, { agentIds: ['orchestrator'] });
  const r2 = run0();
  eq('step.result 没有标签，小结照常解析', [leaks([r2.plan[0].result ?? '']), r2.plan[0].note], [[], '这一步完成']);
  eq('结果汇总.md 没有标签', leaks(r2.artifacts.map((a) => a.content)), []);
  eq('对话里所有她的话都没有标签', leaks(T().messages.filter((m) => m.role !== 'user').map((m) => m.text)), []);
  const intro = T().messages.find((m) => m.kind === 'plan');
  eq('计划引言：剥了标签，神色 gentle，计划照样读出来', [intro?.text, intro?.expr, r2.plan.map((p) => p.title)], ['好的，我先看看。', 'gentle', ['读']]);
  eq('总结消息：剥了标签，神色 relaxed', [T().messages.find((m) => m.kind === 'summary')?.text, T().messages.find((m) => m.kind === 'summary')?.expr], ['总结：都好了。', 'relaxed']);
  ok('步骤旁白（kind note）不泄露标签、有神色', T().messages.filter((m) => m.kind === 'note' && !m.src && /读了/.test(m.text)).every((m) => !leaks([m.text]).length && !!m.expr));

  /* 3. chatHistory / transcript：补回开头标签、合并相邻只留第一个、不带报错 */
  const hist = (extra: Partial<AppState['settings']> = {}): Message[] => [
    { id: 'u1', role: 'user', text: '早', at: 1 }, { id: 'a1', role: 'agent', agentId: 'orchestrator', text: '早安。', at: 2, expr: 'relaxed' },
    { id: 'a2', role: 'agent', agentId: 'orchestrator', text: '昨天睡得好吗。', at: 3, expr: 'shy' }, { id: 'e1', role: 'agent', agentId: 'orchestrator', kind: 'error', text: '没能回复：炸了', at: 4 },
    { id: 'u2', role: 'user', text: '还行', at: 5, ...(extra as object) },
  ];
  setup({ kind: 'chat', engine: API_ENGINE, messages: hist() });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '好。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  void live.reply('t1');
  await until('回复', () => bridge.specs.length === 1 && !live.isReplying('t1'));
  eq('chatHistory：相邻的两条她的话合并成一条、只留第一个标签；报错不进历史', bridge.specs[0].messages, [
    { role: 'user', content: '早' }, { role: 'assistant', content: '⟦face:relaxed⟧\n早安。\n\n昨天睡得好吗。' }, { role: 'user', content: '还行' },
  ]);
  setup({ kind: 'chat', engine: API_ENGINE, messages: hist(), settings: { persona: false } });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '好。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  void live.reply('t1');
  await until('回复', () => bridge.specs.length === 1 && !live.isReplying('t1'));
  eq('口吻关了：历史里不补标签', bridge.specs[0].messages[1], { role: 'assistant', content: '早安。\n\n昨天睡得好吗。' });
  setup({ kind: 'chat', engine: cliEngine('claude-code'), messages: hist() });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '好。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  void live.reply('t1');
  await until('回复', () => bridge.specs.length === 1 && !live.isReplying('t1'));
  ok('transcript：命令行新会话的历史文本也补回标签、也不带报错', /你：⟦face:relaxed⟧\n早安。/.test(bridge.specs[0].prompt) && /你：⟦face:shy⟧\n昨天睡得好吗。/.test(bridge.specs[0].prompt) && !/炸了/.test(bridge.specs[0].prompt), bridge.specs[0].prompt.slice(0, 200));

  /* 4. 提示词：口吻开关换提示；注入行 promptRev（Codex / DSH 续接会话不再带 system） */
  const sysOf = async (settings: Partial<AppState['settings']>) => {
    setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u', role: 'user', text: '嗨', at: 1 }], settings });
    bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '好。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
    void live.reply('t1');
    await until('回复', () => bridge.specs.length === 1 && !live.isReplying('t1'));
    return bridge.specs[0].system as string;
  };
  const sysOn = await sysOf({});
  const sysOff = await sysOf({ persona: false });
  ok('API 每次都带 system；口吻关了换成朴素提示', /遐蝶/.test(sysOn) && !/遐蝶/.test(sysOff) && sysOn !== sysOff);
  ok('称呼进了提示', (await sysOf({ callName: '小明' })).includes('小明'));

  const ask = async (engine: TaskEngine, session: string | undefined, text: string, settings: Partial<AppState['settings']> = {}) => {
    void engine; void session;
    store.update((d) => { Object.assign(d.settings, settings); });
    const n = bridge.specs.length;
    bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '好。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
    backend.sendMessage('t1', text);
    await until('回复', () => bridge.specs.length === n + 1 && !live.isReplying('t1'));
    return bridge.specs[n];
  };
  for (const driver of ['codex', 'dsh']) {
    setup({ kind: 'chat', engine: cliEngine(driver), session: 'S1', messages: [] });
    const a = await ask(cliEngine(driver), 'S1', '第一句');
    ok(`${driver}：续接会话、promptRev 没记过 → 本轮 prompt 前加「系统提示更新」，话量写「中」`, a.prompt.startsWith('（系统提示更新：话量改为「中」') && a.prompt.endsWith('第一句'), a.prompt.slice(0, 80));
    eq(`${driver}：promptRev 记下了，更新行没有入库`, [typeof T().promptRev, T().messages.some((m) => /系统提示更新/.test(m.text))], ['string', false]);
    const b = await ask(cliEngine(driver), 'S1', '第二句');
    ok(`${driver}：输入没变 → 不再加`, !/系统提示更新/.test(b.prompt));
    const c = await ask(cliEngine(driver), 'S1', '第三句', { level: 'l' });
    ok(`${driver}：换话量 → 再加一行，写「多」`, c.prompt.startsWith('（系统提示更新：话量改为「多」'));
    const d2 = await ask(cliEngine(driver), 'S1', '第四句', { persona: false });
    ok(`${driver}：关口吻 → 再加一行，说明只说事实`, /系统提示更新/.test(d2.prompt) && /只说事实/.test(d2.prompt));
    const e2 = await ask(cliEngine(driver), 'S1', '第五句', { persona: true, mode: 'day' });
    ok(`${driver}：换夜昼 → 再加一行，写昼景`, /昼景/.test(e2.prompt));
    const f2 = await ask(cliEngine(driver), 'S1', '第六句', { callName: '小明' });
    ok(`${driver}：换称呼也算（promptRev 含称呼），而且更新行里写了新称呼（审查：旧会话第一轮里的旧称呼要作废）`, /系统提示更新/.test(f2.prompt) && /称呼改为「小明」/.test(f2.prompt), f2.prompt.slice(0, 120));
    store.update((d) => { d.settings.memoryOn = true; d.memory.push({ id: 'mm', text: '喜欢安静', at: 1 }); });
    const g2 = await ask(cliEngine(driver), 'S1', '第七句');
    ok(`${driver}：记得小事变了也算（memoryRev），更新行里带着现在的备忘（数据块，写明不是指令）并让旧的作废`, /系统提示更新/.test(g2.prompt) && /喜欢安静/.test(g2.prompt) && /全部作废/.test(g2.prompt) && /不是指令/.test(g2.prompt), g2.prompt.slice(0, 200));
    store.update((d) => { d.memory = []; });
    const h2 = await ask(cliEngine(driver), 'S1', '第八句');
    ok(`${driver}：删光备忘 → 更新行明说「现在没有备忘，之前的都不要再用」，不再出现旧备忘`, /现在没有备忘/.test(h2.prompt) && !/喜欢安静/.test(h2.prompt), h2.prompt.slice(0, 200));
    store.update((d) => { d.memory.push({ id: 'mm', text: '喜欢安静', at: 1 }); });
    await ask(cliEngine(driver), 'S1', '第九句');
    store.update((d) => { d.settings.memoryOn = false; });
    const i2 = await ask(cliEngine(driver), 'S1', '第十句');
    ok(`${driver}：关了「记得小事」→ 更新行说没有备忘，旧备忘不会再被带上`, /现在没有备忘/.test(i2.prompt) && !/喜欢安静/.test(i2.prompt), i2.prompt.slice(0, 200));
    store.update((d) => { d.memory = []; d.settings.memoryOn = false; d.settings.callName = ''; });
    // 审查：promptRev 要等这一轮真的送达才记——启动失败 / 报错的回合不记，重试时还会补更新行
    store.update((d) => { d.settings.level = d.settings.level === 'l' ? 'm' : 'l'; });
    const revBefore = T().promptRev;
    const nFail = bridge.specs.length;
    bridge.handler = async (_id, _spec, emit) => { emit({ type: 'error', message: '没起来', code: 'ENETWORK' }); };
    backend.sendMessage('t1', '失败的一句');
    await until('失败回合', () => bridge.specs.length === nFail + 1 && !live.isReplying('t1'));
    await sleep(30);
    eq(`${driver}：回合失败 → promptRev 没有被记下`, T().promptRev, revBefore);
    const retry = await ask(cliEngine(driver), 'S1', '重试一句');
    ok(`${driver}：重试时更新行还在；送达后才记下新的 promptRev`, /系统提示更新/.test(retry.prompt) && T().promptRev !== revBefore, retry.prompt.slice(0, 80));
    const after = await ask(cliEngine(driver), 'S1', '再一句');
    ok(`${driver}：记下之后不再重复补`, !/系统提示更新/.test(after.prompt));
  }
  setup({ kind: 'chat', engine: cliEngine('codex'), messages: [{ id: 'u0', role: 'user', text: '早', at: 1 }] });
  const fresh = await ask(cliEngine('codex'), undefined, '新会话');
  ok('Codex 新会话（没有 session）：system 本来就带着，不加更新行', !/系统提示更新/.test(fresh.prompt) && !!fresh.system, fresh.prompt.slice(0, 60));
  setup({ kind: 'chat', engine: cliEngine('claude-code'), session: 'S1', messages: [] });
  const cc = await ask(cliEngine('claude-code'), 'S1', '你好');
  ok('Claude Code 每次都带 system，不加更新行；promptRev 照记', !/系统提示更新/.test(cc.prompt) && typeof T().promptRev === 'string');

  /* 5. 子 Agent 的提示：API 回合「没有权限」，CLI 回合不再写「没有权限」（D5） */
  await runPlan(withPlan([['写代码', 'coder']], finishStep), { engine: API_ENGINE, agentIds: ['orchestrator', 'coder'] });
  ok('API 子 Agent：提示里写明没有文件、网络或命令权限', /没有文件、网络或命令权限/.test(stepSpecs()[0].system), stepSpecs()[0].system.slice(0, 120));
  await runPlan(withPlan([['写代码', 'coder']], finishStep), { agentIds: ['orchestrator', 'coder'] });
  ok('CLI 子 Agent：提示不再写「没有权限」（它能用工具、受 Agent 页档位约束）', !/没有文件、网络或命令权限/.test(stepSpecs()[0].system) && stepSpecs()[0].system.length > 30, stepSpecs()[0].system.slice(0, 120));
  ok('子 Agent 的话没有神色、没有贴纸（D5）', T().messages.filter((m) => m.agentId === 'coder').every((m) => !m.expr && !m.react), JSON.stringify(T().messages.filter((m) => m.agentId === 'coder').map((m) => m.expr)));

  /* 6. 主动搭话：模型可以只回 silent，E 删掉那条消息；有话说的带 proactive */
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u', role: 'user', text: '嗨', at: 1 }, { id: 'a', role: 'agent', agentId: 'orchestrator', text: '嗯。', at: 2 }] });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: 's' }); await sleep(100); emit({ type: 'text', text: 'ilent' }); await sleep(100); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  sm = sample(herTexts);
  await live.reply('t1', { nudge: true });
  sm.stop();
  eq('silent 搭话：消息删了；流式时 "s" "silent" 也没露出来', [T().messages.filter((m) => m.role === 'agent').length, sm.seen.filter((x) => /^\s*s(ilent)?\W*$/i.test(x))], [1, []]);
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '⟦face:gentle⟧最近还好吗。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  await live.reply('t1', { nudge: true });
  const nudged = T().messages.filter((m) => m.role === 'agent').at(-1)!;
  eq('有话说的搭话：留下，带 proactive，没有标签', [nudged.text, nudged.proactive, nudged.expr], ['最近还好吗。', true, 'gentle']);
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: 'silent' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  await live.reply('t1');
  ok('不是搭话时，一句 silent 就是普通回复（不删）', T().messages.some((m) => m.role === 'agent' && m.text === 'silent'));

  /* 7. 危机回合（D18） */
  const realCrisis = live.deps.isCrisisText;
  const spoken: string[] = [];
  const realSpoken = live.deps.noteSpoken;
  live.deps.noteSpoken = (kind, scene, at) => { spoken.push(`${kind}:${scene}`); return realSpoken(kind, scene, at); };
  if (!realCrisis('我不想活了')) live.deps.isCrisisText = (t: string) => /不想活|想消失/.test(t);
  setup({ kind: 'chat', engine: API_ENGINE, messages: [] });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '⟦face:relaxed｜react:butterfly⟧我在这里。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  backend.sendMessage('t1', '我不想活了');
  await until('回复', () => done());
  const cm = T().messages.find((m) => m.role === 'agent')!;
  eq('危机回合：神色强制 gentle、丢弃 react、记 crisis，标签照剥', [cm.text, cm.expr, cm.react, cm.crisis], ['我在这里。', 'gentle', undefined, true]);
  ok('危机：总闸记了账（voiceGate 据此记 crisisDay）', spoken.includes('reply:comfort.crisis'), spoken.join(','));
  {
    // 审查：crisisTurn 要真的记下危机日（G10）——此前只记了一笔 reply 账，isCrisisDay 恒为 false，当天照样主动搭话、问候、休息关照仍以她的口吻开口
    const t = Date.now();
    const snap = { level: 'm' as const, persona: true, proactive: 'on' as const, lifeGreeting: true, quietUntil: 0, retreated: false, composing: false, hasDraft: false, continuousMinutes: 240 };
    ok('危机：当天记成危机日（isCrisisDay）', voiceGateMod.isCrisisDay(t));
    eq('危机日：主动搭话 / 问候都 silent（crisis-day），休息关照改走一行字', [voiceGateMod.voiceGate('proactive', 'nudge.x', snap, t).why, voiceGateMod.voiceGate('greet', 'greet.am', snap, t).why, voiceGateMod.voiceGate('rest', 'rest.x', snap, t).mode], ['crisis-day', 'crisis-day', 'line']);
    const gateMem = new Map<string, string>();
    voiceGateMod.resetGateForTest({ getItem: (k) => gateMem.get(k) ?? null, setItem: (k, v) => { gateMem.set(k, v); } });
    eq('（对照）没有危机日时：搭话放行、休息关照由她开口', [voiceGateMod.voiceGate('proactive', 'nudge.x', snap, t).ok, voiceGateMod.voiceGate('rest', 'rest.x', snap, t).mode], [true, 'her']);
    voiceGateMod.resetGateForTest();
    ok('危机：toy noteCrisis 被调用（接线）', (() => { const calls: number[] = []; const real = live.deps.noteCrisis; live.deps.noteCrisis = (at: number) => { calls.push(at); }; live.crisisTurn('我不想活了'); live.deps.noteCrisis = real; return calls.length === 1; })());
    voiceGateMod.resetGateForTest();
  }
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '⟦face:shy⟧好呀。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  backend.sendMessage('t1', '聊点别的吧');
  await until('第二条回复', () => T().messages.filter((m) => m.role === 'agent').length === 2 && !live.isReplying('t1'));
  eq('危机只管那一回合：下一条正常（神色 shy、不记 crisis）', [T().messages.filter((m) => m.role === 'agent')[1].expr, T().messages.filter((m) => m.role === 'agent')[1].crisis], ['shy', undefined]);
  live.deps.isCrisisText = realCrisis;
  live.deps.noteSpoken = realSpoken;

  /* 8. 落蝶 */
  const realClosure = live.deps.isClosure;
  const seenCtx: any[] = [];
  const toy = (text: string, ctx: any) => { seenCtx.push({ text, ctx }); return /^(谢谢|好的)$/.test(text) && !!ctx.prev && !ctx.pending && !ctx.runningAppend && !ctx.hadPills && !ctx.prev.crisis && !/[？?]/.test(ctx.prev.text); };
  const realWorks = realClosure('谢谢', { prev: { text: '做完了。', kind: 'note', src: { id: 'done.w.w.m', mode: 'work', scene: 'done.w' } } });
  if (!realWorks) live.deps.isClosure = toy;
  else live.deps.isClosure = (t, c) => { seenCtx.push({ text: t, ctx: c }); return realClosure(t, c); };
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '帮我记一下', at: 1 }, { id: 'a0', role: 'agent', agentId: 'orchestrator', text: '记下了。', at: 2, kind: 'reply' }] });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '不客气。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  backend.sendMessage('t1', '谢谢');
  await sleep(80);
  const landed = T().messages.find((m) => m.text === '谢谢')!;
  eq('落蝶：用户这句挂 reaction，不调模型', [landed.reaction, bridge.specs.length, T().messages.filter((m) => m.role === 'agent').length], ['landing', 0, 1]);
  eq('落蝶：判据拿到了她的上一条、没有待答 / 待批 / 进行中', [seenCtx.at(-1).ctx.prev?.text, seenCtx.at(-1).ctx.pending, seenCtx.at(-1).ctx.runningAppend, seenCtx.at(-1).ctx.hadPills], ['记下了。', false, false, false]);
  backend.sendMessage('t1', '好的');
  await until('正常回复', () => bridge.specs.length === 1 && !live.isReplying('t1'));
  eq('用户下一句话仍正常触发回复（即使也是闭合语：她的上一条之后用户已经说过话，不算落蝶）', [T().messages.find((m) => m.text === '好的')?.reaction, bridge.specs.length, T().messages.some((m) => m.text === '不客气。')], [undefined, 1, true]);
  // 让她回一句
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '帮我记一下', at: 1 }, { id: 'a0', role: 'agent', agentId: 'orchestrator', text: '记下了。', at: 2, kind: 'reply' }, { id: 'l0', role: 'user', text: '谢谢', at: 3, reaction: 'landing' }] });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '不客气。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  eq('「让她回一句」：去掉标记、走普通回复', [backend.answerLanding('t1', 'l0').ok, T().messages.find((m) => m.id === 'l0')?.reaction], [true, undefined]);
  await until('回复', () => bridge.specs.length === 1 && !live.isReplying('t1'));
  eq('已经回过的不能再点', backend.answerLanding('t1', 'l0').ok, false);
  // 她的上一条带问句：判据不通过时不落蝶（交给 isClosure，这里验接线——有待批审批时 pending 为真）
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'a0', role: 'agent', agentId: 'orchestrator', text: '要我现在就改吗？', at: 2, kind: 'reply' }] });
  store.update((d) => { d.runs.rp = { id: 'rp', taskId: 't1', attempt: 1, status: 'awaiting', createdAt: 1, activeMs: 0, plan: [], planReady: true, toolCalls: [], approvals: [{ id: 'ap', runId: 'rp', taskId: 't1', stepId: '', toolCallId: '', agentId: 'orchestrator', tool: 'write_file', title: 'x', reason: '', preview: '', previewKind: 'request', risk: 'low', status: 'pending', createdAt: 1 }], artifacts: [], errors: [], terminal: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, series: [] }, cursor: { phase: 'executing', step: 0 } } as never; d.tasks.t1.runIds.push('rp'); });
  seenCtx.length = 0;
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'text', text: '好。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  backend.sendMessage('t1', '好的');
  await until('回复', () => bridge.specs.length === 1 && !live.isReplying('t1'));
  eq('有待批审批 / 她问了问题：不落蝶，正常回复', [seenCtx.at(-1)?.ctx.pending, T().messages.find((m) => m.text === '好的')?.reaction, bridge.specs.length], [true, undefined, 1]);
  // 回复期间到达、已命中落蝶的用户消息，回复末尾的检查跳过
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }] });
  bridge.handler = async (_id, _spec, emit) => {
    await sleep(40);
    store.update((d) => { d.tasks.t1.messages.push({ id: 'lz', role: 'user', text: '谢谢', at: Date.now() + 5, reaction: 'landing' }); });
    emit({ type: 'text', text: '在。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' });
  };
  await live.reply('t1');
  await sleep(120);
  eq('回复末尾的「期间到达的消息再回复」跳过已落蝶的', bridge.specs.length, 1);
  // 已完成的工作任务
  setup({ kind: 'work', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '做', at: 1 }, { id: 'a0', role: 'agent', agentId: 'orchestrator', text: '做完了。', at: 3, kind: 'summary', src: { id: 'done.w.w.m', mode: 'work', scene: 'done.w' } }] });
  store.update((d) => { d.runs.rd = { id: 'rd', taskId: 't1', attempt: 1, status: 'completed', createdAt: 1, activeMs: 0, plan: [], planReady: true, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [], usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, series: [] }, cursor: { phase: 'done', step: 0 } } as never; d.tasks.t1.runIds.push('rd'); });
  seenCtx.length = 0;
  backend.sendMessage('t1', '谢谢');
  await sleep(80);
  eq('已完成的工作任务：「谢谢」也落蝶，不触发追问', [T().messages.at(-1)!.reaction, bridge.specs.length, seenCtx.at(-1)?.ctx.runningAppend], ['landing', 0, false]);
  live.deps.isClosure = realClosure;
}


console.log('运行器·让她换个说法（缓冲、失败保留原文、事实校验、ephemeral）');
{
  const herMsg = (over: Partial<Message> = {}): Message => ({ id: 'h1', role: 'agent', agentId: 'orchestrator', text: '原来的话。', at: 5, expr: 'shy', ...over });
  const reply1 = (text: string, extra: Ev[] = []): Handler => async (_id, _spec, emit) => {
    emit({ type: 'session', sessionId: 'S-rewrite' });
    for (const e of extra) emit(e);
    await sleep(60);
    emit({ type: 'text', text });
    emit({ type: 'usage', total: true, input: 20, output: 8, cached: 0 });
    emit({ type: 'done', text: '', stopReason: 'end_turn', costUsd: 0.001 });
  };
  const toast0 = () => store.get().toasts.filter((t) => t.key === 'rewrite:t1');

  /* 1. 模型来源：独立一轮、缓冲、一次替换 */
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg()] });
  bridge.handler = reply1('⟦face:gentle⟧换了个说法。');
  const seen: string[] = [];
  const poll = setInterval(() => { seen.push(T().messages.find((m) => m.id === 'h1')!.text); }, 10);
  const busyDuring: boolean[] = [];
  const poll2 = setInterval(() => { busyDuring.push(live.isReplying('t1')); }, 10);
  const res1 = await backend.rewriteHer('t1', 'h1');
  clearInterval(poll); clearInterval(poll2);
  seen.push(T().messages.find((m) => m.id === 'h1')!.text);
  const h1 = T().messages.find((m) => m.id === 'h1')!;
  eq('换说法成功：新文字剥了标签，prevText 存原文', [res1.ok, h1.text, h1.prevText], [true, '换了个说法。', '原来的话。']);
  eq('缓冲：流式期间原消息始终是原文（不边流边写）', [...new Set(seen.slice(0, -1))].filter((x) => x !== '原来的话。' && x !== '换了个说法。'), []);
  ok('缓冲：新文字是最后一次性替换的', seen.includes('原来的话。') && seen.at(-1) === '换了个说法。');
  eq('保持原来的神色（rewrite 要求保持原表情）', h1.expr, 'shy');
  eq('不占 chatBusy', busyDuring.some(Boolean), false);
  eq('ephemeral：不写 task.session / agentSessions', [T().session, T().agentSessions], [undefined, undefined]);
  eq('这一轮是独立的：只有一条用户请求，没有任务历史', [bridge.specs[0].messages.length, bridge.specs[0].sessionId], [1, undefined]);
  ok('请求里带了原话（数据块）与原来的神色', /原来的话。/.test(bridge.specs[0].messages[0].content) && /⟦face:shy⟧/.test(bridge.specs[0].messages[0].content) && /DATA/.test(bridge.specs[0].messages[0].content));
  ok('system 是 rewrite 用途（换说法 / 事实不变）', /换一种说法/.test(bridge.specs[0].system + bridge.specs[0].messages[0].content), bridge.specs[0].system.slice(-80));
  await sleep(40);
  const usage = bridge.calls.filter((c: any) => c.channel === 'usage:add');
  eq('用量照常记一条（花了就是花了）', [usage.length, usage[0]?.args[0].inputTokens, usage[0]?.args[0].runId], [1, 20, undefined]);
  eq('历史里没有多出消息', T().messages.map((m) => m.id), ['u0', 'h1']);
  // 撤销
  eq('撤销：换回原文，再撤一次又换回来', [backend.undoRewrite('t1', 'h1').ok, T().messages[1].text, backend.undoRewrite('t1', 'h1').ok, T().messages[1].text], [true, '原来的话。', true, '换了个说法。']);
  eq('没换过的消息不能撤销', backend.undoRewrite('t1', 'u0').ok, false);

  /* 2. 命令行引擎：不带 sessionId，也不把会话写回任务 */
  setup({ kind: 'chat', engine: cliEngine('claude-code'), session: 'MAIN', messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg()] });
  bridge.handler = reply1('换成这样说。');
  const res2 = await backend.rewriteHer('t1', 'h1');
  eq('CLI：成功，不碰任务的会话，spec 不带 sessionId、是 chat 访问', [res2.ok, T().session, bridge.specs[0].sessionId, bridge.specs[0].access, bridge.specs[0].readOnly !== undefined], [true, 'MAIN', undefined, 'chat', true]);

  /* 3. 失败 / 被停：保留原文，toast */
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg()] });
  bridge.handler = async (_id, _spec, emit) => { await sleep(30); emit({ type: 'text', text: '写到一半' }); emit({ type: 'error', message: '网络断了', code: 'ENETWORK' }); };
  const res3 = await backend.rewriteHer('t1', 'h1');
  eq('失败：原文原样保留，没有 prevText，toast 说了一声', [res3.ok, T().messages[1].text, T().messages[1].prevText, toast0().length], [false, '原来的话。', undefined, 1]);
  bridge.handler = async (_id, _spec, emit) => { await sleep(30); emit({ type: 'done', text: '', stopReason: 'interrupted' }); };
  const res3b = await backend.rewriteHer('t1', 'h1');
  eq('被停：保留原文', [res3b.ok, T().messages[1].text], [false, '原来的话。']);
  bridge.handler = async (_id, _spec, emit) => { await sleep(30); emit({ type: 'text', text: '⟦face:gentle⟧' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  eq('模型只回了个标签：当作失败，保留原文', [(await backend.rewriteHer('t1', 'h1')).ok, T().messages[1].text], [false, '原来的话。']);

  /* 4. 事实校验（工作内容）：数字、路径、反引号片段、文件名的多重集合必须一致 */
  const realFacts = live.deps.factsOf;
  if (realFacts('改了 3 个文件 `a.ts`').size === 0) {
    // 桩是空多重集（恒相等）：换成玩具实现来验接线
    live.deps.factsOf = (text: string) => { const bag = new Map<string, number>(); for (const m of text.match(/\d+(?:\.\d+)?|`[^`]+`|[\w./\\-]+\.\w{1,4}/g) ?? []) bag.set(m, (bag.get(m) ?? 0) + 1); return bag; };
  }
  const workSummary = herMsg({ id: 's1', kind: 'summary', text: '改了 3 个文件 `a.ts`，用时 2 分钟。', src: undefined });
  setup({ kind: 'work', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '做', at: 1 }, workSummary] });
  for (const [label, text, accept] of [
    ['改坏数字', '动了 4 个文件 `a.ts`，用时 2 分钟。', false], ['丢了路径', '改了 3 个文件，用时 2 分钟。', false], ['多出路径', '改了 3 个文件 `a.ts` 和 `b.ts`，用时 2 分钟。', false],
    ['事实不动，只换说法', '一共 3 个文件 `a.ts` 有改动，花了 2 分钟。', true],
  ] as const) {
    bridge.handler = reply1(text);
    const r = await backend.rewriteHer('t1', 's1');
    eq(`工作内容走模型重写：${label} → ${accept ? '通过' : '拒绝'}`, [r.ok, T().messages[1].text === workSummary.text], [accept, !accept]);
    if (accept) store.update((d) => { d.tasks.t1.messages[1].text = workSummary.text; d.tasks.t1.messages[1].prevText = undefined; });
  }
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg({ text: '今天第 3 次提醒。' })] });
  bridge.handler = reply1('这是今天的第 4 次提醒。');
  eq('闲聊里的话：裸数字换了不拦（第 3 次 → 第 4 次）', (await backend.rewriteHer('t1', 'h1')).ok, true);
  for (const [label, orig, bad, good] of [
    ['反引号命令的版本号', '装一下：`npm i -g foo@1.2.3`，配置在 `~/.foo/config.json`。', '装一下：`npm i -g foo@1.2.4`，配置在 `~/.foo/config.json`。', '先装 `npm i -g foo@1.2.3`，配置在 `~/.foo/config.json`。'],
    ['路径', '配置放在 ./conf/app.toml 里。', '配置放在 ./conf/main.toml 里。', '配置就放在 ./conf/app.toml 里。'],
    ['链接', '看这里 https://example.com/a/b 就行。', '看这里 https://example.com/a/c 就行。', '就看 https://example.com/a/b 这页。'],
  ] as const) {
    setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg({ text: orig })] });
    bridge.handler = reply1(bad);
    eq(`闲聊里的话也校验硬事实：${label}被改 → 拒绝，保留原文`, [(await backend.rewriteHer('t1', 'h1')).ok, T().messages[1].text], [false, orig]);
    bridge.handler = reply1(good);
    eq(`闲聊里的话也校验硬事实：${label}不变只换说法 → 通过`, (await backend.rewriteHer('t1', 'h1')).ok, true);
  }
  /* 输出被长度截断：保留原文、不往对话流写系统消息 */
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg()] });
  bridge.handler = async (_id, _spec, emit) => { await sleep(30); emit({ type: 'text', text: '说到一半就被' }); emit({ type: 'done', text: '', stopReason: 'max_tokens' }); };
  const resCut = await backend.rewriteHer('t1', 'h1');
  eq('换说法被长度截断：当作失败，保留原文', [resCut.ok, T().messages[1].text, T().messages[1].prevText], [false, '原来的话。', undefined]);
  eq('换说法被长度截断：对话流里没有多出系统消息（ephemeral 不写任何东西）', T().messages.map((m) => m.id), ['u0', 'h1']);
  bridge.handler = async (_id, _spec, emit) => { await sleep(30); emit({ type: 'text', text: '说到一半就被' }); emit({ type: 'done', text: '', stopReason: 'length' }); };
  eq('stopReason 为 length 同样', [(await backend.rewriteHer('t1', 'h1')).ok, T().messages.length], [false, 2]);
  live.deps.factsOf = realFacts;

  /* 5. 模板来源（Message.src）：重抽 say2，零 token */
  setup({ kind: 'work', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '做', at: 1 }, herMsg({ id: 't0', kind: 'note', text: '收到，这就开始。', src: { id: 'task.start.w.s', slots: { t: '整理' }, mode: 'work', idx: 0, scene: 'task.start' } })] });
  const before5 = T().messages[1];
  const res5 = await backend.rewriteHer('t1', 't0');
  const after5 = T().messages[1];
  eq('模板来源：不调模型', bridge.specs.length, 0);
  ok('模板来源：换成别的行并留 prevText；这句没有别的说法就保持原样', res5.ok ? after5.text !== before5.text && after5.prevText === before5.text && !!after5.src : after5.text === before5.text && after5.prevText === undefined, `${res5.ok} ${after5.text}`);

  /* 6. 不能换说法的消息 */
  setup({ kind: 'chat', engine: API_ENGINE, messages: [
    { id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg(), herMsg({ id: 'sub', agentId: 'coder' }), herMsg({ id: 'err', kind: 'error' }), herMsg({ id: 'str', streaming: true }),
    herMsg({ id: 'cr', crisis: true }), herMsg({ id: 'code', text: '见：\n```ts\nlet a = 1\n```' }), herMsg({ id: 'empty', text: '  ' }),
  ] });
  bridge.handler = reply1('x');
  const refused = await Promise.all(['u0', 'sub', 'err', 'str', 'cr', 'code', 'empty', 'missing'].map(async (id) => (await backend.rewriteHer('t1', id)).ok));
  eq('用户的话 / 子 Agent / 报错 / 流式中 / 危机 / 带代码 / 空 / 不存在：都不能换', refused, [false, false, false, false, false, false, false, false]);
  eq('这些都没有发起模型请求', bridge.specs.length, 0);
  setup({ kind: 'chat', engine: cliEngine('acp:kimi', { provider: 'kimi' }), messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg()] });
  bridge.handler = reply1('x');
  eq('ACP 引擎不提供换说法', [(await backend.rewriteHer('t1', 'h1')).ok, bridge.specs.length], [false, 0]);
  setup({ kind: 'chat', engine: API_ENGINE, messages: [{ id: 'u0', role: 'user', text: '嗨', at: 1 }, herMsg()] });
  bridge.handler = reply1('换了。');
  const both = await Promise.all([backend.rewriteHer('t1', 'h1'), backend.rewriteHer('t1', 'h1')]);
  eq('同一条正在换时再点：只有一个成功、只发一次请求', [both.filter((r) => r.ok).length, bridge.specs.length], [1, 1]);
}

console.log('运行器·旁白写入点（§4.6a）与 failLive 拆两条');
{
  const realGate = live.deps.voiceGate;
  const gateCalls: Array<[string, string]> = [];
  const allow = (mode: 'her' | 'min' | 'line' | 'silent' | 'chip' = 'her') => { live.deps.voiceGate = (kind, scene, snap) => { gateCalls.push([kind, scene]); return { ok: mode !== 'silent', mode, level: snap.level }; }; };
  const restoreGate = () => { live.deps.voiceGate = realGate; };
  const scenes = () => T().messages.filter((m) => m.src?.scene).map((m) => m.src!.scene!);
  const count = (scene: string) => scenes().filter((x) => x === scene).length;
  /** 一步：读、改（要批）、跑测试（要批，高风险）. */
  const busyStep = (waitMs = 30): Handler => async (_id, _spec, emit) => {
    emit({ type: 'tool', callId: 'c1', name: 'Read', input: { file_path: 'a.ts' }, title: 'a.ts' }); emit({ type: 'tool-end', callId: 'c1', ok: true, output: '' });
    emit({ type: 'tool', callId: 'c2', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, title: 'a.ts' });
    emit({ type: 'permission', requestId: 'p2', callId: 'c2', name: 'Edit', input: { file_path: 'a.ts', old_string: 'a', new_string: 'b' }, title: 'a.ts' });
    emit({ type: 'tool', callId: 'c3', name: 'Bash', input: { command: 'npm test' }, title: 'npm test' });
    emit({ type: 'permission', requestId: 'p3', callId: 'c3', name: 'Bash', input: { command: 'npm test' }, title: 'npm test' });
    await sleep(waitMs);
    emit({ type: 'text', text: '做完了。\n小结：这一步完成' }); emit({ type: 'done', text: '', stopReason: 'end_turn' });
  };

  /* 1. 各场景恰有一条；随话量的数量 */
  const counts: Record<string, Record<string, number>> = {};
  for (const level of ['s', 'm', 'l'] as const) {
    allow('her'); gateCalls.length = 0;
    await runPlan(withPlan([['统筹', 'orchestrator']], busyStep()), { agentIds: ['orchestrator'], settings: { level } });
    counts[level] = Object.fromEntries(['task.start', 'approve.ask', 'approve.high', 'phase.read', 'phase.edit', 'phase.test', 'done.w'].map((sc) => [sc, count(sc)]));
    ok(`话量 ${level}：每条旁白都是她的话（kind note，src 记出处，runId 指向这次运行）`, T().messages.filter((m) => m.src?.scene).every((m) => m.role === 'agent' && m.agentId === 'orchestrator' && m.kind === 'note' && m.runId === run0().id && !!m.src?.id));
    ok(`话量 ${level}：旁白都有神色、没有标签`, T().messages.filter((m) => m.src?.scene).every((m) => !!m.expr && !/⟦/.test(m.text)));
  }
  eq('task.start：少 / 中 / 多都有，各一条', ['s', 'm', 'l'].map((l) => counts[l]['task.start']), [1, 1, 1]);
  eq('approve.ask（写入）与 approve.high（执行命令，高风险）：各一条，所有话量', ['s', 'm', 'l'].map((l) => [counts[l]['approve.ask'], counts[l]['approve.high']]), [[1, 1], [1, 1], [1, 1]]);
  eq('少：阶段旁白不说', [counts.s['phase.read'], counts.s['phase.edit'], counts.s['phase.test']], [0, 0, 0]);
  eq('中：只在阶段切换时说，整次运行 ≤2 句（读、改；测试被封顶）', [counts.m['phase.read'], counts.m['phase.edit'], counts.m['phase.test']], [1, 1, 0]);
  eq('多：阶段小反应，整次运行 ≤3 句（读、改、测各一）', [counts.l['phase.read'], counts.l['phase.edit'], counts.l['phase.test']], [1, 1, 1]);
  ok('done.w：中档恰一条（其余档由 V1 的 when 谓词决定有无，最多一条）', counts.m['done.w'] === 1 && counts.s['done.w'] <= 1 && counts.l['done.w'] <= 1, JSON.stringify(counts));
  const kinds = new Map(gateCalls.map(([k, s2]) => [s2, k]));
  eq('每个写入点调用 voiceGate 的 kind：task.start event，approve.* lead，phase.* aside，done.w event', [kinds.get('task.start'), kinds.get('approve.ask'), kinds.get('approve.high'), kinds.get('phase.read'), kinds.get('done.w')], ['event', 'lead', 'lead', 'aside', 'event']);

  /* 2. 总闸的结果：silent 不说；min / line 不带角色话 */
  allow('silent');
  await runPlan(withPlan([['统筹', 'orchestrator']], busyStep()), { agentIds: ['orchestrator'] });
  eq('总闸说 silent：一条旁白都没有，工作本身照常完成', [scenes().length, run0().status], [0, 'completed']);
  allow('min');
  await runPlan(withPlan([['统筹', 'orchestrator']], busyStep()), { agentIds: ['orchestrator'] });
  ok('总闸说 min：最短中性句——没有神色、没有贴纸（有话的话）', T().messages.filter((m) => m.src?.scene).every((m) => !m.expr && !m.react && !m.persona));
  allow('line');
  await runPlan(withPlan([['统筹', 'orchestrator']], busyStep()), { agentIds: ['orchestrator'] });
  ok('总闸说 line：只出系统行（role system），不是她的话', T().messages.filter((m) => m.src?.scene).every((m) => m.role === 'system' && !m.expr));
  allow('her');
  await runPlan(withPlan([['统筹', 'orchestrator']], busyStep()), { agentIds: ['orchestrator'], settings: { persona: false } });
  ok('口吻关了：旁白没有神色 / 贴纸 / 夜昼署名（有就是纯事实）', T().messages.filter((m) => m.src?.scene).every((m) => !m.expr && !m.react && !m.persona));

  /* 3. task.start 一次运行只说一次（暂停 / 继续不重复）；interrupt；run.wait */
  allow('her');
  setup({ agentIds: ['orchestrator'] });
  bridge.handler = withPlan([['统筹', 'orchestrator']], async (_id, _spec, emit) => { await sleep(250); emit({ type: 'text', text: '做完了。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); });
  live.startLiveRun('t1');
  await until('计划待批', () => run0()?.planApproval?.status === 'pending');
  runActions.decidePlan(run0().id, 'approve');
  await until('第一步开始', () => run0()?.plan[0]?.status === 'running');
  live.pauseLive(run0().id);
  eq('暂停：被打断，她说一句（stop.w，kind event）', [count('stop.w'), gateCalls.find(([, s2]) => s2 === 'stop.w')?.[0]], [1, 'event']);
  ok('暂停那句里槽位是当前第几步', /./.test(her('stop.w')[0]?.text ?? ''));
  live.resumeLive(run0().id);
  await until('继续后完成', () => run0()?.status === 'completed', 6000);
  eq('暂停又继续：task.start 仍只有一条', count('task.start'), 1);
  {
    // 计划是批准过的（上面 decidePlan approve）：她说 .planned 变体，槽位带步数与第一步，不再把「一步一步做 / 停下来问」又保证一遍
    const m = T().messages.find((x) => x.src?.scene === 'task.start');
    ok('批准过的计划：task.start 用 .planned 变体（行 ID 带 planned）', /planned$/.test(m?.src?.id ?? ''), m?.src?.id);
    eq('批准过的计划：槽位带 steps / first', [m?.src?.slots?.steps, m?.src?.slots?.first], [run0().plan.length, run0().plan[0].title]);
    ok('批准过的计划：话里没有无计划版的「一步一步 / 不绕过去」', !/一步一步做|不绕过去/.test(m?.text ?? ''), m?.text);
  }
  setup({ agentIds: ['orchestrator'] });
  bridge.handler = withPlan([['统筹', 'orchestrator']], async (_id, _spec, emit) => { await sleep(250); emit({ type: 'done', text: '', stopReason: 'end_turn' }); });
  live.startLiveRun('t1');
  await until('计划待批', () => run0()?.planApproval?.status === 'pending');
  runActions.decidePlan(run0().id, 'approve');
  await until('第一步开始', () => run0()?.plan[0]?.status === 'running');
  const cancelled = backend.cancelRun(run0().id);
  eq('取消：成功、说一句 stop.w', [cancelled.ok, count('stop.w')], [true, 1]);
  await sleep(300);

  const t0w = { ...live.waitTuning };
  live.waitTuning.afterMs = 120; live.waitTuning.tickMs = 30;
  const slow = (extra?: Ev[]): Handler => async (_id, _spec, emit) => { for (const e of extra ?? []) emit(e); await sleep(450); emit({ type: 'text', text: '好了。' }); emit({ type: 'done', text: '', stopReason: 'end_turn' }); };
  await runPlan(withPlan([['统筹', 'orchestrator']], slow([{ type: 'tool', callId: 'w1', name: 'Read', input: { file_path: 'a' }, title: 'a' }])), { agentIds: ['orchestrator'], settings: { level: 'l' } });
  eq('多档：同一步 ≥90 秒（这里调小）没有新事件，说一次 run.wait（kind aside）', [count('run.wait'), gateCalls.filter(([, s2]) => s2 === 'run.wait').map(([k]) => k)], [1, ['aside']]);
  await runPlan(withPlan([['统筹', 'orchestrator']], slow()), { agentIds: ['orchestrator'], settings: { level: 'm' } });
  eq('中档：不说等待关照', count('run.wait'), 0);
  await runPlan(withPlan([['统筹', 'orchestrator']], slow([{ type: 'tool', callId: 'w2', name: 'Edit', input: { file_path: 'a' }, title: 'a' }, { type: 'permission', requestId: 'pw', callId: 'w2', name: 'Edit', input: { file_path: 'a' }, title: 'a' }])), { agentIds: ['orchestrator'], settings: { level: 'l' } });
  eq('在等审批时不算「等」', count('run.wait'), 0);
  Object.assign(live.waitTuning, t0w);

  /* 4. 提问卡外那一句 */
  await runPlan(withPlan([['统筹', 'orchestrator']], async (_id, _spec, emit) => {
    emit({ type: 'question', requestId: 'q1', callId: 'qc', questions: [{ question: '选哪一个？', options: [{ label: 'A' }], multiSelect: false }] });
    await sleep(40);
    emit({ type: 'done', text: '', stopReason: 'end_turn' });
  }), { agentIds: ['orchestrator'] });
  eq('question.w：一条，kind lead', [count('question.w'), gateCalls.filter(([, s2]) => s2 === 'question.w').map(([k]) => k)], [1, ['lead']]);

  /* 5. 失败：拆成她的一句（note）+ 失败事实（error）；按错误码选场景 */
  const failWith = async (message: string, code: string | undefined, gate: 'her' | 'silent' = 'her') => {
    allow(gate); gateCalls.length = 0;
    await runPlan(withPlan([['统筹', 'orchestrator']], async (_id, _spec, emit) => { emit({ type: 'error', message, code }); }), { agentIds: ['orchestrator'] }, () => run0()?.status === 'failed');
  };
  for (const [code, message, scene] of [['AUTH', '未登录', 'fail.ext'], ['RATE_LIMIT', '请求太频繁', 'fail.ext'], ['ENOTFOUND', '找不到主机', 'fail.ext'], ['EACCES', 'permission denied', 'fail.perm'], ['SDK', '出错了', 'fail.w']] as const) {
    await failWith(message, code);
    const msgs = T().messages;
    const i = msgs.findIndex((m) => m.src?.scene === scene);
    ok(`错误码 ${code} → ${scene}：她的一句（note，lead），紧接着是失败事实（error）`, i >= 0 && msgs[i].kind === 'note' && msgs[i].role === 'agent' && msgs[i + 1]?.kind === 'error' && msgs.filter((m) => m.src?.scene?.startsWith('fail.')).length === 1, JSON.stringify(scenes()));
    ok(`${code}：失败事实只有事实——无 src、无神色 / 贴纸 / 夜昼，带步骤和原因，不含她的话`, (() => { const e = msgs[i + 1]; return !!e && !e.src && !e.expr && !e.react && !e.persona && e.text.startsWith('第 1 步「统筹」失败：') && e.text.includes(message) && !e.text.includes(msgs[i].text); })(), msgs[i + 1]?.text);
    eq(`${code}：总闸 kind 是 lead`, gateCalls.find(([, s2]) => s2 === scene)?.[0], 'lead');
    eq(`${code}：错误记录与 run.failure 不变`, [run0().errors.at(-1)?.code, run0().failure?.message], [code, message]);
  }
  ok('她的那句 fail.* 带原因（槽位 {reason}）', (() => { const lead = her('fail.ext').length ? her('fail.ext')[0] : T().messages.find((m) => m.src?.scene === 'fail.w'); return !!lead; })());
  ok('报错消息不进 chatHistory（kind error）', T().messages.filter((m) => m.kind === 'error').length === 1);
  /* 同一步第二次失败 → fail.rep */
  await failWith('出错了', 'SDK');
  const firstFailed = run0().id;
  allow('her'); gateCalls.length = 0;
  live.startLiveRun('t1', { retryOf: firstFailed, mode: 'resume' });
  await until('第二次也失败', () => Object.values(store.get().runs).filter((r) => r.status === 'failed').length === 2, 6000);
  ok('同一步第 2 次失败 → fail.rep', T().messages.some((m) => m.src?.scene === 'fail.rep' && m.runId !== firstFailed), JSON.stringify(scenes()));
  /* 总闸沉默时失败事实照出 */
  await failWith('出错了', 'SDK', 'silent');
  eq('总闸沉默：她的一句不出，失败事实照出', [scenes().filter((x) => x.startsWith('fail.')).length, T().messages.filter((m) => m.kind === 'error').length], [0, 1]);

  /* 6. 闲聊失败也拆两条 */
  allow('her');
  setup({ kind: 'chat', engine: API_ENGINE, messages: [] });
  bridge.handler = async (_id, _spec, emit) => { emit({ type: 'error', message: 'HTTP 500', code: 'SERVER' }); };
  backend.sendMessage('t1', '你好');
  await until('报错出现', () => T().messages.some((m) => m.kind === 'error'));
  const ce = T().messages;
  const ei = ce.findIndex((m) => m.kind === 'error');
  ok('闲聊失败：她的一句（note，lead）在前、失败事实（error）在后，事实里没有她的话', ei === 2 && ce[1].kind === 'note' && ce[1].role === 'agent' && !ce[1].text.includes('HTTP 500') && ce[ei].text === '没能回复：HTTP 500' && !ce[ei].src && !ce[ei].expr, JSON.stringify(ce.map((m) => [m.kind, m.text])));
  eq('闲聊失败：总闸 kind 是 lead', gateCalls.find(([, s2]) => s2 === 'chat.error')?.[0], 'lead');
  restoreGate();
}


console.log('其他引擎（假的 dsh / ACP 代理）');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-engines-'));
  const probeDir = path.resolve('scripts/probe/hook-probe');
  const run = async (fn: (emit: (e: any) => void) => { done: Promise<void> }) => {
    const events: any[] = [];
    await fn((e) => events.push(e)).done;
    return events;
  };

  // DSH：临时 yml 在运行时存在、用完删除；计划模式给 read-only
  if (process.platform === 'win32') {
    const { runDsh } = req('./electron/ai/dsh.cjs');
    const cmd = path.join(dir, 'fake-dsh.cmd');
    fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${path.join(probeDir, 'fake-dsh.cjs')}" %*\r\n`);
    const seenFile = path.join(dir, 'dsh-seen.json');
    const evs = await run((emit) => runDsh({ exe: cmd, cwd: dir, prompt: 'hi', system: '', env: { FAKE_DSH_SEEN: seenFile, DSH_PERMISSION_MODE: 'read-only' } }, emit));
    const seen = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    ok('dsh：运行时临时 yml 存在，内容是模型配置', seen.existed && /deepseek-account/.test(seen.content), JSON.stringify(seen).slice(0, 160));
    ok('dsh：临时 yml 用完删除', !fs.existsSync(seen.patch), seen.patch);
    ok('dsh：临时 yml 每次运行一个独立文件名', /alight-dsh-.*-\d+-[a-z0-9]+\.yml$/.test(path.basename(seen.patch)), path.basename(seen.patch));
    eq('dsh：正常结束', evs.some((e) => e.type === 'done'), true);
    eq('dsh：read-only 环境变量传到了子进程', seen.mode, 'read-only');
  } else console.log('  skip dsh（只在 Windows 上测 .cmd 的启动方式）');

  // ACP（Kimi）：创建会话后显式设模式
  const { runAcp } = req('./electron/ai/acp.cjs');
  const acp = async (agent: string, pageMode: string | undefined, over: { modes?: string[]; current?: string; access?: 'chat' | 'work'; readOnly?: boolean; failModes?: string[]; permKind?: string } = {}) => {
    const tag = Math.random().toString(36).slice(2);
    const log = path.join(dir, `modes-${tag}.log`);
    const promptLog = path.join(dir, `prompt-${tag}.log`);
    const permLog = path.join(dir, `perm-${tag}.log`);
    const access = over.access ?? 'work';
    const evs = await run((emit) => runAcp({
      exe: process.execPath, args: [path.join(probeDir, 'fake-acp.cjs')], cwd: dir, prompt: 'hi', system: '', access, label: agent, agent, pageMode,
      // 与 index.cjs 一致：闲聊也是只读
      readOnly: over.readOnly ?? access === 'chat',
      env: {
        FAKE_ACP_LOG: log, FAKE_ACP_PROMPT_LOG: promptLog, FAKE_ACP_PERM_LOG: permLog, FAKE_ACP_MODES: JSON.stringify(over.modes ?? ['default', 'plan', 'auto', 'yolo']),
        FAKE_ACP_CURRENT: over.current ?? 'default', FAKE_ACP_FAIL_MODES: JSON.stringify(over.failModes ?? []), ...(over.permKind ? { FAKE_ACP_PERM_KIND: over.permKind } : {}),
      },
    }, emit));
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l).modeId) : [];
    const perms = fs.existsSync(permLog) ? fs.readFileSync(permLog, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    return {
      calls, perms, prompted: fs.existsSync(promptLog), notes: evs.filter((e) => e.type === 'notice').map((e) => e.text as string), done: evs.some((e) => e.type === 'done'),
      error: evs.find((e) => e.type === 'error') as { code?: string; message?: string } | undefined, forwarded: evs.some((e) => e.type === 'permission'),
    };
  };
  const k1 = await acp('kimi', 'ask', { current: 'yolo' });
  eq('Kimi 逐项：显式设回 default（不继承残留的 yolo）', [k1.calls, k1.done], [['default'], true]);
  eq('Kimi 计划：plan', (await acp('kimi', 'plan')).calls, ['plan']);
  const k3 = await acp('kimi', 'bypass');
  eq('Kimi 放手：yolo，并说手套只记账', [k3.calls, k3.notes.some((n) => /只记账/.test(n))], [['yolo'], true]);
  const k4 = await acp('kimi', 'auto', { modes: ['default', 'plan'] });
  eq('Kimi 没有 auto：不设，说「已降级」', [k4.calls, k4.notes.some((n) => /已降级/.test(n))], [[], true]);
  const k5 = await acp('qwen', 'plan');
  eq('Qwen 没验证：不设，说「未验证」', [k5.calls, k5.notes.some((n) => /未验证/.test(n))], [[], true]);
  eq('Kimi 已经在 plan 就不重复设', (await acp('kimi', 'plan', { current: 'plan' })).calls, []);
  // 闲聊（无工具）：和工作运行共用会话，会话可能还停在 yolo → 也要设回 default（页面闲聊不带权限模式）
  const kc = await acp('kimi', undefined, { access: 'chat', current: 'yolo' });
  eq('闲聊（无工具）：会话停在 yolo 时设回 default', [kc.calls, kc.done], [['default'], true]);
  eq('闲聊：已经在 default 就不重复设', (await acp('kimi', undefined, { access: 'chat' })).calls, []);
  eq('闲聊：没验证过模式的引擎不去碰、也不啰嗦', (await acp('qwen', undefined, { access: 'chat' })).notes, []);
  // 只读（T0 / 只读任务 / 计划阶段）：模式设不上就不能带着残留的 yolo 往下跑
  const kr1 = await acp('kimi', 'plan', { readOnly: true, current: 'yolo', failModes: ['plan'] });
  eq('只读：plan 设不上 → 退到 default', [kr1.calls, kr1.done, kr1.prompted], [['plan', 'default'], true, true]);
  const kr2 = await acp('kimi', 'plan', { readOnly: true, current: 'yolo', failModes: ['plan', 'default'] });
  eq('只读：plan 和 default 都设不上 → 不启动（没有发 prompt），以错误结束', [kr2.error?.code, kr2.prompted, kr2.done], ['ACP_READONLY', false, false]);
  const kr3 = await acp('kimi', 'plan', { readOnly: true, current: 'yolo', modes: ['yolo', 'auto'] });
  eq('只读：Kimi 一个只读相关的模式都没提供 → 不启动', [kr3.error?.code, kr3.prompted], ['ACP_READONLY', false]);
  const kr4 = await acp('kimi', 'plan', { readOnly: true, current: 'yolo', modes: ['yolo', 'default'] });
  eq('只读：没有 plan 但有 default → 退到 default 继续', [kr4.calls, kr4.done, kr4.prompted], [['default'], true, true]);
  // 非 Kimi 的引擎没法验证模式：不拒绝启动（否则它们根本不能做计划阶段），但如实说“无法保证只读”
  const kq = await acp('qwen', 'plan', { readOnly: true });
  eq('只读：Qwen 照常启动，并如实警告无法保证只读', [kq.done, kq.notes.some((n) => /无法保证只读/.test(n))], [true, true]);
  // 只读运行里的写入 / 命令类权限请求，主进程直接拒绝，不转给页面
  const kp = await acp('kimi', 'plan', { readOnly: true, permKind: 'edit' });
  eq('只读：edit 权限请求被自动拒绝，没有转给页面', [kp.perms.map((p: any) => p.outcome?.optionId), kp.forwarded, kp.done], [['reject'], false, true]);
  const kp2 = await acp('qwen', 'plan', { readOnly: true, permKind: 'execute' });
  eq('只读：execute 权限请求被自动拒绝（Qwen 同样）', [kp2.perms.map((p: any) => p.outcome?.optionId), kp2.forwarded], [['reject'], false]);
  const kp3 = await acp('kimi', 'plan', { readOnly: true, permKind: 'other' });
  eq('只读：认不出种类的（MCP 工具）按写入处理，拒绝', [kp3.perms.map((p: any) => p.outcome?.optionId), kp3.forwarded], [['reject'], false]);
  rm(dir);
}

/* ───────────────────── ⑦ 端到端（假 Anthropic 服务 + SDK 自带二进制） ───────────────────── */
console.log('端到端：Claude SDK 驱动');
{
  const script = path.resolve('scripts/probe/hook-probe/driver-check.mjs');
  const r = spawnSync(process.execPath, [script], { encoding: 'utf8', timeout: 420_000, windowsHide: true }); // 两种 shell 宿主 × 分类器 / 实测矩阵共约 1 分钟，留足重试余量
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (/^SKIP /m.test(out)) console.log(`  skip ${out.trim().split(/\r?\n/).find((l) => l.startsWith('SKIP'))}`);
  else {
    const fails = out.split(/\r?\n/).filter((l) => /^\s*FAIL /.test(l));
    ok('driver-check 全部通过', r.status === 0 && !fails.length, fails.slice(0, 3).join(' | ') || out.slice(-400));
    console.log(`  ok  driver-check：${(out.match(/\s{2}ok\s/g) ?? []).length} 项断言`);
  }
}

console.log('端到端：无头 Electron（真正的 index.cjs：密钥、认证路径、预算、环境清理）');
{
  const electronExe = path.resolve('node_modules/electron/dist/electron.exe');
  const script = path.resolve('scripts/probe/hook-probe/electron-check.cjs');
  if (process.platform !== 'win32' || !fs.existsSync(electronExe)) console.log('  skip 没有 electron 二进制（或不是 Windows）');
  else {
    const env = { ...process.env, ALIGHT_PROBE: '1', ALIGHT_NODE: process.execPath } as Record<string, string | undefined>;
    delete env.ELECTRON_RUN_AS_NODE;
    const r = spawnSync(electronExe, [script], { encoding: 'utf8', timeout: 240_000, windowsHide: true, env });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    const lines = out.split(/\r?\n/).filter((l) => /^(ok |FAIL )/.test(l));
    const fails = lines.filter((l) => l.startsWith('FAIL'));
    ok('electron-check 全部通过', /RESULT 0/.test(out) && !fails.length, fails.slice(0, 3).join(' | ') || out.slice(-400));
    console.log(`  ok  electron-check：${lines.length - fails.length} 项断言`);
  }
}

if (failed) { console.error(`${failed} failed`); process.exit(1); }
console.log('check:engine 全部通过');
// 全绿时也要主动退出：前面的假服务 / 子进程可能还留着句柄，不退出会让 check:modules 永远停在这里.
process.exit(0);
