/* 仅开发（import.meta.env.DEV）：给截图评审用的示例状态。生产构建里没有这个文件（App.tsx 里的动态 import 被整段摘掉）。
   用法：npx vite --port 5321，然后打开
     /?fixture=demo&view=new            首页「归来」
     /?fixture=demo&view=task           任务页（审批待你）
     /?fixture=demo&view=settings       设置
   其它参数：mode=night|day · boot=0（不播开屏）· probe=notext（隐去文字只留光晕，对比度度量用）· wallpaper=off。
   每处示例数据都标「示例数据」：右上角一枚虚线徽记 + 任务与对话里写明的示例文案；这些全是假的，不来自任何真实运行。

   验收用的状态（施工图 §7.3，T）：window.__alight.applyFixture(name, opts?) → boolean（名字不认识返回 false）. 探针加载页面后直接 evaluate 它；
   opts = { level: 's'|'m'|'l', persona: boolean, theme: 'night'|'day', wallpaper: boolean }，缺省保持 / 取默认（中档、口吻开、夜、壁纸开）.
   状态一律是「注入」的（运行中、高风险待批、失败、被打断都不会被 normalizeAfterLoad 改掉——那个只在载入存档时跑）；
   她的话全部来自 say2()（台词库，按 level / persona / theme 取），不调模型、不碰话语总闸的预算.
   名字清单见 FIXTURE_NAMES（也挂在 window.__alight.fixtures 上）. 每次 applyFixture 都先把世界清空：任务 / 运行 / 提示 / 记忆 / 安静时段 / 设置里
   会被状态改动的几项（剧情框、贴纸、她退半步…）一律回到默认，所以一个页面里连续切状态不会互相残留. */
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { EXPR_IDS } from '../../lib/expr';
import type {
  AgentEngine, AgentId, Approval, AppState, ExprId, Level, Message, ModelState, PermissionMode, PlanStep, Question, Run, RunErrorRecord, StepStatus, StickerId, Task,
  TaskEngine, ThemeId, ToolCall, Usage, UsageSummary, ViewId,
} from '../../lib/types';
import { say2, voiceSeed, type Slots, type VoiceFacts } from '../../lib/voice';
import { CLAUSES, renderLine } from '../../lib/voice-lines';
import { actions } from '../../state/actions';
import { awayWindow, greetSceneAt } from '../../state/brief';
import { AGENTS, TOOLS, syncPersonaAgent } from '../../state/seed';
import { store } from '../../state/store';
import { HerAvatar } from '../her/HerAvatar';

const MIN = 60_000;

const usage = (used: number): Usage => ({ inputTokens: 184_000, outputTokens: 21_400, cachedTokens: 96_000, contextUsed: used, contextLimit: 200_000, series: [0, 12, 30, 41, 66, 72, 90, 118, 150, 205] });

function step(i: number, title: string, status: PlanStep['status'], at: number, agentId: PlanStep['agentId'] = 'coder', toolCallIds: string[] = []): PlanStep {
  return { id: `demo_s${i}_${title.length}`, index: i, title, detail: `（示例数据）${title}`, agentId, status, toolCallIds, startedAt: status === 'pending' ? undefined : at, endedAt: status === 'done' ? at + 3 * MIN : undefined, activeMs: status === 'done' ? 3 * MIN : undefined };
}

function run(id: string, taskId: string, status: Run['status'], now: number, o: Partial<Run> = {}): Run {
  return {
    id, taskId, attempt: 1, status, createdAt: now - 30 * MIN, startedAt: now - 28 * MIN, activeMs: 14 * MIN + 22_000,
    plan: [], planReady: true, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [], usage: usage(81_000),
    cursor: { phase: 'executing', step: 1 }, engineLabel: 'Claude · Claude Code', ...o,
  };
}

const engine = (cwd?: string): Task['engine'] => ({ kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: '', label: 'Claude · Claude Code', cwd, permissionMode: 'ask' });

function applyDemo() {
  const now = Date.now();
  store.update((d) => {
    const s = d as unknown as AppState;
    const msg = (id: string, role: Message['role'], text: string, at: number, extra: Partial<Message> = {}): Message => ({ id, role, text, at, ...extra });

    // ── 绝区零 GODS v3：运行中，等一件须亲批的事 ──
    const gods: Task = {
      id: 'demo_gods', title: '绝区零 GODS v3', goal: '按甲方意见出 v3，战斗过程别抽帧（示例数据）', createdAt: now - 32 * MIN, updatedAt: now - 4 * MIN,
      agentIds: ['orchestrator', 'coder'], runIds: ['demo_r_gods'], kind: 'work', engine: engine('G:/Claude Code Workplace/zzz-edit'),
      messages: [
        msg('m1', 'user', '按甲方意见出 v3，战斗过程别抽帧（示例数据）', now - 31 * MIN),
        msg('m2', 'agent', '这次的嘱托，我抄下了三条……成品先落在暂存区，验收后再提升。（示例数据）', now - 30 * MIN, { agentId: 'orchestrator', runId: 'demo_r_gods', kind: 'reply' }),
      ],
    };
    const godsRun = run('demo_r_gods', 'demo_gods', 'awaiting', now, {
      plan: [step(0, '读 EDL 与上一版', 'done', now - 28 * MIN), step(1, '渲染 51 段（复用 44）', 'awaiting', now - 24 * MIN), step(2, '混音＋探针＋遗物卡', 'pending', now)],
      toolCalls: [{ id: 'demo_tc1', runId: 'demo_r_gods', stepId: 'demo_s1_10', agentId: 'coder', tool: 'shell', title: 'ffmpeg 渲染 31/51', input: {}, status: 'awaiting', startedAt: now - 5 * MIN, approvalId: 'demo_ap1' } as ToolCall],
      approvals: [{
        id: 'demo_ap1', runId: 'demo_r_gods', taskId: 'demo_gods', stepId: 'demo_s1_10', toolCallId: 'demo_tc1', agentId: 'coder', tool: 'shell',
        title: '删除 4 个旧版成片母带', reason: '这一步删掉的，无法照原样取回……请阁下先看清单。（示例数据）', preview: 'del zzz-edit/out/GODS_v1.mp4 GODS_v2a.mp4 GODS_v2b.mp4 GODS_v2c.mp4',
        previewKind: 'command', risk: 'high', status: 'pending', createdAt: now - 69 * MIN,
      }],
      live: { agentId: 'coder', activity: 'waiting', text: '等阁下批准删除清单' },
    });

    // ── 星铁混剪：在途 ──
    const hsr: Task = { id: 'demo_hsr', title: '星铁混剪 v11 导出规格', goal: '导出规格（示例数据）', createdAt: now - 3 * 3600_000, updatedAt: now - 2 * MIN, agentIds: ['orchestrator', 'coder'], runIds: ['demo_r_hsr'], kind: 'work', engine: engine('G:/Claude Code Workplace/hsr-edit'), messages: [msg('h1', 'user', '导出规格先按上一版（示例数据）', now - 3 * 3600_000)] };
    const hsrRun = run('demo_r_hsr', 'demo_hsr', 'running', now, {
      plan: [step(0, '读取上一版规格', 'done', now - 20 * MIN), step(1, '重新编码', 'running', now - 10 * MIN), step(2, '核对码率', 'pending', now)],
      live: { agentId: 'coder', activity: 'tool', text: '编码第 31 / 51 段' },
    });

    // ── 遐蝶壁纸 v7：完成，并问了一个问题 ──
    const wall: Task = { id: 'demo_wall', title: '遐蝶壁纸 v7', goal: '壁纸（示例数据）', createdAt: now - 26 * 3600_000, updatedAt: now - 20 * MIN, agentIds: ['orchestrator'], runIds: ['demo_r_wall'], kind: 'work', engine: engine('G:/Claude Code Workplace/遐蝶壁纸'), messages: [msg('w1', 'user', '出三个版本供选（示例数据）', now - 26 * 3600_000)] };
    const wallRun = run('demo_r_wall', 'demo_wall', 'completed', now, {
      endedAt: now - 20 * MIN, plan: [step(0, '出三个候选', 'done', now - 60 * MIN), step(1, '整理对照', 'done', now - 50 * MIN)],
      cursor: { phase: 'done', step: 1 },
      questions: [{ id: 'demo_q1', runId: 'demo_r_wall', taskId: 'demo_wall', header: '封面', question: '封面选哪一张', options: [{ label: '夜景' }, { label: '日景' }, { label: '官方立绘' }], status: 'pending', createdAt: now - 75 * MIN }],
    });

    const osu: Task = { id: 'demo_osu', title: '下一站 4K 谱', goal: '示例数据', createdAt: now - 5 * 24 * 3600_000, updatedAt: now - 5 * 24 * 3600_000, agentIds: ['orchestrator'], runIds: [], kind: 'work', engine: engine('G:/Claude Code Workplace/osu-mania-gen'), messages: [] };
    const la: Task = { id: 'demo_la', title: '线性代数 HW4 的第三题', goal: '示例数据', createdAt: now - 6 * 24 * 3600_000, updatedAt: now - 6 * 24 * 3600_000, agentIds: ['orchestrator'], runIds: [], kind: 'chat', engine: engine(), messages: [msg('l1', 'user', '第三题的特征值怎么看（示例数据）', now - 6 * 24 * 3600_000)] };

    s.tasks = { [gods.id]: gods, [hsr.id]: hsr, [wall.id]: wall, [osu.id]: osu, [la.id]: la };
    s.taskOrder = [gods.id, hsr.id, wall.id, osu.id, la.id];
    s.runs = { [godsRun.id]: godsRun, [hsrRun.id]: hsrRun, [wallRun.id]: wallRun };
    s.selectedTaskId = gods.id;
    s.events = [
      { id: 'e1', at: now - 22 * MIN, runId: 'demo_r_wall', kind: 'run', level: 'success', text: '运行 #1 完成：遐蝶壁纸 v7（示例数据）' },
      { id: 'e2', at: now - 14 * MIN, runId: 'demo_r_hsr', kind: 'step', level: 'info', text: '读取上一版规格 完成（示例数据）' },
    ];
    s.usage = { today: { costUsd: 1.9, tokens: 412_000, turns: 14 }, week: { costUsd: 8.6, tokens: 2_100_000, turns: 63 }, estimated: true };
    // 假装刚离开了 41 分钟（归来简读它）
    s.lastSeen = now - 41 * MIN;
  });
  awayWindow.set({ from: Date.now() - 41 * MIN, to: Date.now() - 20_000 });
}

function installNoText() {
  const st = document.createElement('style');
  st.textContent = `
    *, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important; caret-color: transparent !important; }
    svg text, svg text * { fill: transparent !important; }
    svg.lucide, .alt-ic, .brand-mark, .butterfly, .seed, .her-avatar, .landing { opacity: 0 !important; }
    input::placeholder, textarea::placeholder { color: transparent !important; }`;
  document.head.appendChild(st);
}

function badge() {
  const el = document.createElement('div');
  el.textContent = '样稿 · 示例数据';
  el.setAttribute('aria-hidden', 'true');
  const narrow = window.innerWidth < 700;   // 徽记放在底部正中（控制台条中间是空的），不压在拱窗、顶栏与署名上；窄窗口里抬高一点
  el.style.cssText = `position:fixed;${narrow ? 'bottom:56px' : 'bottom:10px'};left:50%;transform:translateX(-50%);z-index:90;height:20px;padding:0 10px;font:500 11px/18px var(--font-sans);letter-spacing:.06em;color:var(--text);border:1px dashed var(--line-strong);border-radius:10px;background:rgb(var(--veil-rgb)/.66);pointer-events:none;text-shadow:none`;
  document.body.appendChild(el);
}

/* ═══════════════════════════ 验收状态（施工图 §7.3） ═══════════════════════════ */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const ORCH: AgentId = 'orchestrator';

export interface FixtureOpts {
  level?: Level;
  persona?: boolean;
  theme?: ThemeId;
  wallpaper?: boolean;
}

interface Ctx {
  now: number;
  level: Level;
  persona: boolean;
  theme: ThemeId;
  call: string;
}

interface Built {
  view: ViewId;
  taskId?: string;
  /** return-brief：假装刚离开了这么多分钟. */
  away?: number;
  /** 选中哪张牌（Agent 页）——只用来给探针点；真正选牌靠 --click. */
  note?: string;
}

type Build = (c: Ctx, s: AppState) => Built;

/* ── 小零件 ── */

let seq = 0;
const nid = (p: string) => `fx_${p}_${(seq += 1)}`;

const FIXED_DAY = new Date(2026, 9, 27);
/** 固定种子：同一状态每次抽到同一句（不随日期变）. */
const seedOf = (n: number | string) => voiceSeed(FIXED_DAY, 'fixture', n);

function sayAt(c: Ctx, scene: string, slots: Slots = {}, o: { mode?: 'chat' | 'work'; facts?: VoiceFacts; n?: number | string } = {}) {
  return say2(scene, slots, { level: c.level, mode: o.mode ?? 'chat', theme: c.theme, persona: c.persona, callName: c.call, facts: o.facts, seed: seedOf(o.n ?? scene) });
}

const userMsg = (text: string, at: number): Message => ({ id: nid('u'), role: 'user', text, at });

interface HerOpts {
  mode?: 'chat' | 'work';
  kind?: Message['kind'];
  runId?: string;
  facts?: VoiceFacts;
  /** 贴纸：undefined = 不带；StickerId = 带（调用方保证合规）. */
  react?: StickerId;
  expr?: ExprId;
  proactive?: boolean;
  crisis?: boolean;
  n?: number | string;
  /** 口吻关时用的朴素句（persona=false 且台词库没有对应事实句时）. */
  plain?: string;
}

/** 她的一句（来自台词库）；口吻关时是纯事实 / 朴素句，没有 persona、expr. 台词库里没有这个场景时返回 undefined. */
function herMsg(c: Ctx, scene: string, slots: Slots, at: number, o: HerOpts = {}): Message | undefined {
  const r = sayAt(c, scene, slots, o);
  const text = (r.text || o.plain || '').trim();
  if (!text) return undefined;
  const m: Message = { id: nid('h'), role: 'agent', agentId: ORCH, runId: o.runId, kind: o.kind ?? 'reply', text, at, src: r.src };
  if (o.proactive) m.proactive = true;
  if (c.persona && !r.silent) {
    m.persona = c.theme;
    m.expr = o.expr ?? r.expr ?? 'gentle';
    if (o.react) m.react = o.react;
    if (o.crisis) { m.crisis = true; m.expr = 'gentle'; delete m.react; }
  }
  return m;
}

/** 手写的一句（台词库里没有的内容话：对用户问题的实质回答）. 口吻关时去掉 persona. */
function herText(c: Ctx, text: string, at: number, o: HerOpts & { plainText?: string } = {}): Message {
  const m: Message = { id: nid('h'), role: 'agent', agentId: ORCH, runId: o.runId, kind: o.kind ?? 'reply', text: c.persona ? text : (o.plainText ?? text), at };
  if (c.persona) {
    m.persona = c.theme;
    m.expr = o.expr ?? 'gentle';
    if (o.react) m.react = o.react;
    if (o.crisis) { m.crisis = true; m.expr = 'gentle'; delete m.react; }
  }
  return m;
}

const pushAll = (list: Message[], ...ms: Array<Message | undefined>) => { for (const m of ms) if (m) list.push(m); };

/** 子 Agent 的话：内容层语气，没有她的口吻（D5）. */
const subMsg = (agentId: AgentId, runId: string, text: string, at: number): Message => ({ id: nid('s'), role: 'agent', agentId, runId, kind: 'reply', text, at });

const usageOf = (used: number): Usage => ({ inputTokens: 96_000, outputTokens: 11_200, cachedTokens: 40_000, contextUsed: used, contextLimit: 200_000, series: [0, 8, 21, 40, 52, 66, 80, 96, 118, 140] });

const CWD = 'D:/projects/alight-notes';
const engineCC = (cwd?: string, permissionMode: PermissionMode = 'ask'): TaskEngine => ({ kind: 'live', provider: 'claude', auth: 'cli', driver: 'claude-code', model: '', label: 'Claude · Claude Code', cwd, permissionMode });
const engineCodex = (cwd?: string): TaskEngine => ({ kind: 'live', provider: 'gpt', auth: 'cli', driver: 'codex', model: '', label: 'GPT · Codex', cwd, permissionMode: 'ask' });
const engineDsh = (cwd?: string): TaskEngine => ({ kind: 'live', provider: 'deepseek', auth: 'cli', driver: 'dsh', model: '', label: 'DeepSeek · DeepSeek Harness', cwd, permissionMode: 'ask' });
const engineApi = (): TaskEngine => ({ kind: 'live', provider: 'claude', auth: 'api', model: 'claude-sonnet-5-5', label: 'Claude · API · Sonnet 5.5' });

/* ── 世界的重置 ── */

let baseModels: ModelState | undefined;

/** 在探针当前的模型接入状态上，把 Claude Code / Codex / DSH 标成「检测到且已登录」（让任务的模型是可用的，页面上没有「模型现在不可用」）. */
function modelsReady(): ModelState {
  baseModels ??= store.get().models;
  const m = structuredClone(baseModels) as ModelState;
  const cli = (id: string, driver: string) => {
    const p = m.providers[id];
    if (!p) return;
    p.auth = 'cli';
    p.driver = driver as typeof p.driver;
    p.cli = { found: true, login: 'yes', at: Date.now() };
  };
  cli('claude', 'claude-code');
  cli('gpt', 'codex');
  cli('deepseek', 'dsh');
  const claude = m.providers.claude;
  if (claude) { claude.keyHint ||= '••••0000'; claude.model ||= 'claude-sonnet-5-5'; }
  // 探针种子里的占位模型名（claude-probe-1）不该出现在截图里：换成像真的名字
  for (const p of Object.values(m.providers)) {
    if (/probe/i.test(p.model ?? '')) p.model = 'claude-sonnet-5-5';
    if (/probe/i.test(p.cliModel ?? '')) p.cliModel = '';
  }
  return m;
}

/** 一个模型都没有：所有服务都没有密钥、没有命令行、没有选模型. */
function modelsNone(): ModelState {
  baseModels ??= store.get().models;
  const m = structuredClone(baseModels) as ModelState;
  for (const p of Object.values(m.providers)) { p.keyHint = undefined; p.cli = undefined; p.model = ''; p.cliModel = ''; }
  m.keyHints = {};
  return m;
}

/** 额度栏的数字固定下来：state/usage.ts 会在启动后、每分钟、页面重新可见时用存储里的汇总覆盖 AppState.usage（探针的临时库是空的，会变成「—」），
 *  同一状态不同时刻的截图左栏就不一样. 注入过状态之后盯住它：被覆盖就立刻写回（只在 --mode development 的验收副本里有效）. */
const FX_USAGE: UsageSummary = { today: { costUsd: 0.62, tokens: 188_000, turns: 9 }, week: { costUsd: 4.1, tokens: 1_240_000, turns: 51 }, estimated: false };
let pinned: string | undefined;
let pinSubscribed = false;
function pinUsage() {
  pinned = JSON.stringify(FX_USAGE);
  if (pinSubscribed) return;
  pinSubscribed = true;
  store.subscribe(() => {
    if (pinned && JSON.stringify(store.get().usage) !== pinned) store.update((d) => { d.usage = structuredClone(FX_USAGE); });
  });
}

const derivedDistance = (persona: boolean, level: Level) => (persona === false ? 0 : level === 'l' ? 2 : 1);

function resetWorld(s: AppState, c: Ctx, wallpaper: boolean) {
  s.tasks = {};
  s.taskOrder = [];
  s.runs = {};
  s.events = [];
  s.toasts = [];
  s.selectedTaskId = undefined;
  s.selectedRunId = undefined;
  s.dialog = undefined;
  s.celebration = undefined;
  s.focusRequest = undefined;
  s.peek = false;
  s.statusDrawerOpen = false;
  s.workspaceTab = 'conversation';
  s.console = { ...s.console, open: false };
  s.quietUntil = 0;
  s.memory = [];
  s.lastSeen = undefined;
  s.agents = AGENTS.map((a) => ({ ...a, tiers: a.tiers ? { ...a.tiers } : undefined, tools: [...a.tools] }));
  s.tools = TOOLS.map((t) => ({ ...t }));
  s.models = modelsReady();
  s.usage = structuredClone(FX_USAGE);
  pinUsage();
  const st = s.settings;
  st.mode = c.theme;
  st.level = c.level;
  st.persona = c.persona;
  st.distance = derivedDistance(c.persona, c.level);
  st.wallpaper = wallpaper;
  st.callName = c.call;
  // 剧情框：应用默认是「闲聊」开（10-28 起），验收状态一律先关成气泡态（chat-reply 等就是气泡的样子），剧情框态由 chat-storybox 单独打开.
  st.storyBox = 'off';
  st.stickers = true;
  st.stepBack = true;
  st.memoryOn = false;
  st.proactive = 'auto';
  st.proactiveTopics = false;
  st.lifeGreeting = false;           // 打开空闲聊时的开场白会去调模型（假服务）；验收状态要确定，所以默认关
  st.openConsoleOnError = false;
  st.bootAnimation = false;
  syncPersonaAgent(s);
}

/* ── 任务 / 运行 / 步骤 ── */

function addChat(s: AppState, c: Ctx, id: string, title: string, messages: Message[], o: Partial<Task> = {}): Task {
  const last = messages.length ? messages[messages.length - 1].at : c.now;
  const t: Task = {
    id, title, goal: '', createdAt: (messages[0]?.at ?? c.now) - 60_000, updatedAt: last, agentIds: [ORCH], runIds: [], messages, kind: 'chat',
    engine: engineCC(), lastSeenAt: last, ...o,
  };
  s.tasks[id] = t;
  s.taskOrder.unshift(id);
  s.selectedTaskId = id;
  return t;
}

interface StepSpec { title: string; agent: AgentId; status: StepStatus; ranAs?: AgentId; note?: string; result?: string }

function planOf(runId: string, start: number, specs: StepSpec[]): PlanStep[] {
  let at = start;
  return specs.map((sp, i) => {
    const began = sp.status !== 'pending';
    const ended = sp.status === 'done' || sp.status === 'failed' || sp.status === 'skipped';
    const startedAt = began ? at : undefined;
    const dur = 3 * 60_000 + i * 20_000;
    if (began) at += ended ? dur + 20_000 : 0;
    return {
      id: `${runId}_s${i}`, index: i, title: sp.title, detail: `（示例数据）${sp.title}`, agentId: sp.agent, status: sp.status, toolCallIds: [],
      startedAt, endedAt: ended && startedAt ? startedAt + dur : undefined, activeMs: ended ? dur : undefined, note: sp.note, result: sp.result, ranAs: sp.ranAs,
    };
  });
}

const WORK_STEPS = (o: { a: StepStatus; b: StepStatus; c: StepStatus; ranC?: AgentId }): StepSpec[] => [
  { title: '收集这一版的改动记录', agent: 'researcher', status: o.a, result: '读了 38 条提交与 6 份讨论，按主题归了类。' },
  { title: '改写发布说明', agent: 'coder', status: o.b },
  { title: '核对版本号与下载链接', agent: 'reviewer', status: o.c, ranAs: o.ranC },
];

function mkRun(c: Ctx, id: string, taskId: string, status: Run['status'], plan: PlanStep[], o: Partial<Run> = {}): Run {
  const startedAt = plan.find((p) => p.startedAt)?.startedAt ?? c.now - 20 * 60_000;
  return {
    id, taskId, attempt: 1, status, createdAt: startedAt - 90_000, startedAt, activeMs: 11 * 60_000 + 40_000,
    plan, planReady: true, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [], usage: usageOf(81_000),
    cursor: { phase: 'executing', step: Math.max(0, plan.findIndex((p) => p.status === 'running' || p.status === 'awaiting')) },
    engineLabel: 'Claude · Claude Code', ...o,
  };
}

const call = (c: Ctx, runId: string, stepId: string, agentId: AgentId, tool: ToolCall['tool'], title: string, status: ToolCall['status'], ago: number, o: Partial<ToolCall> = {}): ToolCall => ({
  id: nid('tc'), runId, stepId, agentId, tool, title, input: {}, status, startedAt: c.now - ago, endedAt: status === 'ok' || status === 'error' ? c.now - ago + 4000 : undefined, durationMs: status === 'ok' || status === 'error' ? 4000 : undefined, ...o,
});

function addWork(s: AppState, c: Ctx, name: string, title: string, goal: string, o: { engine?: TaskEngine; messages?: Message[] } = {}): Task {
  const id = `fx_${name}_task`;
  const t: Task = {
    id, title, goal, createdAt: c.now - 40 * 60_000, updatedAt: c.now - 60_000, agentIds: [ORCH, 'researcher', 'coder', 'reviewer'], runIds: [], messages: o.messages ?? [],
    kind: 'work', engine: o.engine ?? engineCC(CWD), trust: 'T1', lastSeenAt: c.now,
  };
  s.tasks[id] = t;
  s.taskOrder.unshift(id);
  s.selectedTaskId = id;
  return t;
}

const GOAL = '整理 v0.2 的发布说明：按主题归类改动，核对版本号和下载链接。';

/** 对话流的公共前半段：用户目标 → 她的理解引言（中、多档）→ 计划（所有档）. */
function workIntro(c: Ctx, runId: string, t0: number, steps: number): Message[] {
  const out: Message[] = [userMsg(GOAL, t0)];
  if (c.level !== 's') pushAll(out, herMsg(c, 'plan.intro', {}, t0 + 8_000, { mode: 'work', kind: 'note', runId, plain: '收到，先理解需求再列计划。' }));
  pushAll(out, herMsg(c, 'phase.plan', { steps }, t0 + 40_000, { mode: 'work', kind: 'plan', runId, plain: `计划已生成：${steps} 步。` }));
  return out;
}

/** 开始 → 阶段小反应（中档只在切换时一句，多档读 + 改各一句，少档没有）. */
function workAsides(c: Ctx, runId: string, t0: number, withEdit: boolean): Message[] {
  const out: Message[] = [];
  pushAll(out, herMsg(c, 'task.start', { t: '发布说明' }, t0, { mode: 'work', kind: 'note', runId, plain: '开始执行。' }));
  if (c.level === 'l') pushAll(out, herMsg(c, 'phase.read', {}, t0 + 60_000, { mode: 'work', kind: 'note', runId }));
  if (withEdit && c.level !== 's') pushAll(out, herMsg(c, 'phase.edit', {}, t0 + 150_000, { mode: 'work', kind: 'note', runId }));
  return out;
}

const DIFF = [
  '--- a/RELEASE-NOTES.md', '+++ b/RELEASE-NOTES.md', '@@ -1,6 +1,14 @@',
  '-# v0.2', '+# 栖枝 v0.2.0', ' ', '-- 若干修复', '+## 新增', '+- Agent 页重新设计为命途牌', '+- 对话里加入她的表情与官方贴纸',
  '+', '+## 调整', '+- 话量分「少 / 中 / 多」三档；计划、工具调用与审批的措辞不随话量变化', ' ',
].join('\n');

function approvalOf(c: Ctx, runId: string, taskId: string, step: PlanStep, tcId: string, o: Partial<Approval>): Approval {
  return {
    id: nid('ap'), runId, taskId, stepId: step.id, toolCallId: tcId, agentId: 'coder', tool: 'write_file', title: '写入 RELEASE-NOTES.md', reason: '把归好类的改动写进发布说明。',
    preview: DIFF, previewKind: 'diff', risk: 'medium', status: 'pending', createdAt: c.now - 2 * 60_000, ...o,
  };
}

/* ── 各个状态 ── */

/* 用户只说了「怕漏东西」，没贴原文：她不能说自己读过。三档与口吻关都是同样三处（版本号与日期、下载链接、已知问题），只让她那层话变长变短. {n} = 称呼. */
const SAY = {
  reply: (n: string) => ({
    s: '嗯，版本号、下载链接、「已知问题」，请对一遍。',
    m: `嗯……对着发布说明，最容易漏的通常是两三处：版本号与日期、下载链接，还有「已知问题」那一节。${n}挨个对一下就稳了。`,
    l: `嗯……先说结论：这类东西多半不会漏得很多。最容易落下的是三处：版本号与日期、下载链接，还有「已知问题」那一节。${n}挨个对一下就稳了。我没看到原文，对完若有拿不准的，贴给我就是。`,
  }),
  plain: '发布说明最容易漏的是三处：版本号与日期、下载链接、已知问题一节。逐项核对即可。',
} as const;

function chatExchange(c: Ctx, t: number): Message[] {
  const out: Message[] = [];
  if (c.persona) {
    pushAll(out, herMsg(c, greetSceneAt(c.now), {}, t - 26 * 60_000, { n: 'greet' }));
    out.push(userMsg('今天总算把发布说明写完了。', t - 24 * 60_000));
    pushAll(out, herMsg(c, 'chat.joy', {}, t - 23 * 60_000, { n: 'joy' }));
  } else {
    out.push(userMsg('今天总算把发布说明写完了。', t - 24 * 60_000));
    out.push({ id: nid('h'), role: 'agent', agentId: ORCH, kind: 'reply', text: '好的。需要的话，把发布说明贴过来，我帮你对一遍。', at: t - 23 * 60_000 });
  }
  out.push(userMsg('你觉得还差点什么吗，我怕漏了东西。', t - 90_000));
  out.push(herText(c, SAY.reply(c.call)[c.level], t - 40_000, { expr: 'gentle', plainText: SAY.plain }));
  return out;
}

/** 口吻关的状态：设置与上下文一起改（话量不动）. */
function plainOf(c: Ctx, s: AppState): Ctx {
  s.settings.persona = false;
  s.settings.distance = 0;
  syncPersonaAgent(s);
  return { ...c, persona: false };
}

const FIXTURES: Record<string, Build> = {
  /* ── Agent 页 ── */
  'agents-idle': (c, s) => {
    // 过去几天各有几步做完（小柱有数）；最近一次已经结束 → 全员空闲 / 本轮做完
    const mk = (n: number, ago: number, agents: AgentId[]) => {
      const id = `fx_hist${n}`;
      const end = c.now - ago;
      const plan = agents.map((a, i): PlanStep => ({
        id: `${id}_s${i}`, index: i, title: ['收集资料', '改写说明', '核对结果'][i % 3], detail: '', agentId: a, status: 'done', toolCallIds: [],
        startedAt: end - (agents.length - i) * 4 * 60_000, endedAt: end - (agents.length - i - 1) * 4 * 60_000, activeMs: 200_000,
      }));
      s.runs[id] = mkRun(c, id, 'fx_hist_task', 'completed', plan, { endedAt: end, createdAt: end - 20 * 60_000, startedAt: end - 18 * 60_000 });
      return id;
    };
    const ids = [mk(1, 26 * HOUR, ['researcher', 'coder', 'reviewer']), mk(2, 2 * DAY + 3 * HOUR, ['researcher', 'coder']), mk(3, 4 * DAY, ['coder', 'reviewer', 'coder']), mk(4, 5 * DAY + HOUR, ['researcher'])];
    s.tasks.fx_hist_task = {
      id: 'fx_hist_task', title: '整理 v0.1 的发布说明', goal: GOAL, createdAt: c.now - 5 * DAY, updatedAt: c.now - 26 * HOUR, agentIds: [ORCH, 'researcher', 'coder', 'reviewer'], runIds: ids,
      messages: [], kind: 'work', engine: engineCC(CWD), trust: 'T1', lastSeenAt: c.now,
    };
    s.taskOrder = ['fx_hist_task'];
    s.selectedTaskId = 'fx_hist_task';
    return { view: 'agents' };
  },
  'agents-busy': (c, s) => {
    const t = addWork(s, c, 'busy', '整理 v0.2 的发布说明', GOAL);
    const id = 'fx_busy_run';
    const plan = planOf(id, c.now - 14 * 60_000, WORK_STEPS({ a: 'done', b: 'running', c: 'pending' }));
    s.runs[id] = mkRun(c, id, t.id, 'running', plan, {
      live: { agentId: 'coder', activity: 'tool', text: '改写发布说明' },
      toolCalls: [call(c, id, plan[0].id, 'researcher', 'web_search', '检索 38 条提交记录', 'ok', 12 * 60_000), call(c, id, plan[1].id, 'coder', 'read_file', '读取 RELEASE-NOTES.md', 'ok', 5 * 60_000), call(c, id, plan[1].id, 'coder', 'write_file', '写入 RELEASE-NOTES.md', 'running', 20_000)],
    });
    t.runIds = [id];
    return { view: 'agents' };
  },
  'agents-reviewer-off': (c, s) => {
    FIXTURES['agents-idle'](c, s);
    return { view: 'agents' };
  },
  'agents-takeover': (c, s) => {
    const t = addWork(s, c, 'take', '整理 v0.2 的发布说明', GOAL);
    const id = 'fx_take_run';
    const a = s.agents.find((x) => x.id === 'reviewer');
    if (a) a.enabled = false;
    const plan = planOf(id, c.now - 16 * 60_000, WORK_STEPS({ a: 'done', b: 'done', c: 'running', ranC: ORCH }));
    s.runs[id] = mkRun(c, id, t.id, 'running', plan, { live: { agentId: ORCH, activity: 'tool', text: '核对版本号（接手审查）' } });
    t.runIds = [id];
    return { view: 'agents' };
  },
  'agents-dsh': (c, s) => { FIXTURES['agents-busy'](c, s); s.tasks.fx_busy_task.engine = engineDsh(CWD); return { view: 'agents' }; },
  'agents-codex': (c, s) => { FIXTURES['agents-busy'](c, s); s.tasks.fx_busy_task.engine = engineCodex(CWD); return { view: 'agents' }; },
  'agents-api': (c, s) => { FIXTURES['agents-busy'](c, s); s.tasks.fx_busy_task.engine = engineApi(); return { view: 'agents' }; },
  'agents-nomodel': (c, s) => { FIXTURES['agents-idle'](c, s); s.models = modelsNone(); s.tasks.fx_hist_task.engine = undefined; return { view: 'agents' }; },
  /** 牌背：遐蝶（沿用全局、只读）. 探针再点 [data-agent="orchestrator"] .tarot-pick. */
  'agents-plain': (c, s) => FIXTURES['agents-idle'](plainOf(c, s), s),
  'agents-back-orchestrator': (c, s) => FIXTURES['agents-idle'](c, s),
  /** 牌背：编码 Agent 单独用 Codex（只认写文件和联网，其余自己管）. */
  'agents-back-coder-codex': (c, s) => {
    FIXTURES['agents-idle'](c, s);
    const a = s.agents.find((x) => x.id === 'coder');
    if (a) a.engine = { key: 'gpt:cli', model: '' } satisfies AgentEngine;
    return { view: 'agents' };
  },
  /** 牌桌（不点牌）：编码 Agent 单独用 Codex，牌面写「只认 N 项」. */
  'agents-coder-codex': (c, s) => FIXTURES['agents-back-coder-codex'](c, s),
  /** 牌桌（不点牌）：编码 Agent 单独用 DSH，牌面写「不受此处限制」. */
  'agents-coder-dsh': (c, s) => {
    FIXTURES['agents-idle'](c, s);
    const a = s.agents.find((x) => x.id === 'coder');
    if (a) a.engine = { key: 'deepseek:cli', model: '' } satisfies AgentEngine;
    return { view: 'agents' };
  },
  /** 牌背：检索 Agent 单独用 API（无工具、隐藏分档）. */
  'agents-back-researcher-api': (c, s) => {
    FIXTURES['agents-idle'](c, s);
    const a = s.agents.find((x) => x.id === 'researcher');
    if (a) a.engine = { key: 'claude:api', model: 'claude-sonnet-5-5' } satisfies AgentEngine;
    return { view: 'agents' };
  },

  /* ── 对话 ── */
  'chat-empty': (c, s) => { addChat(s, c, 'fx_chat_empty', '新的闲聊', [], { updatedAt: c.now, lastSeenAt: c.now }); return { view: 'task', taskId: 'fx_chat_empty' }; },
  'chat-reply': (c, s) => { addChat(s, c, 'fx_chat', '发布说明', chatExchange(c, c.now)); return { view: 'task', taskId: 'fx_chat' }; },
  'chat-sticker': (c, s) => {
    const t = c.now;
    const ms: Message[] = [userMsg('谢谢你，今天陪我改了这么久。', t - 70_000)];
    const m = herMsg(c, 'chat.thanks', {}, t - 30_000, { react: 'like', n: 'thanks' });
    if (m) { if (c.persona) m.expr = 'shy'; ms.push(m); } else ms.push({ id: nid('h'), role: 'agent', agentId: ORCH, kind: 'reply', text: '不客气。', at: t - 30_000 });
    addChat(s, c, 'fx_chat_sticker', '发布说明', [...chatExchange(c, t - 6 * 60_000), ...ms]);
    return { view: 'task', taskId: 'fx_chat_sticker' };
  },
  'chat-error': (c, s) => {
    const t = c.now;
    const ms = chatExchange(c, t - 4 * 60_000);
    ms.push(userMsg('那帮我把「已知问题」那一节也改一下。', t - 50_000));
    pushAll(ms, herMsg(c, 'fail.c', { reason: '服务暂时没有响应' }, t - 20_000, { kind: 'note', plain: '没能回复。原因在下面。' }));
    ms.push({ id: nid('e'), role: 'agent', agentId: ORCH, kind: 'error', at: t - 19_000, text: '没能回复：服务暂时没有响应（HTTP 500）。可以再发一次，已发出的话没有丢。' });
    addChat(s, c, 'fx_chat_error', '发布说明', ms);
    return { view: 'task', taskId: 'fx_chat_error' };
  },
  /** 落蝶（§4.4）：她上一句是陈述句，用户回「谢谢」→ 不调模型，用户气泡下挂线框蝶 + 「落蝶」+「让她回一句」. */
  'chat-landing': (c, s) => {
    const t = c.now;
    const ms = chatExchange(c, t - 3 * 60_000);
    const u = userMsg('谢谢', t - 20_000);
    u.reaction = 'landing';
    ms.push(u);
    addChat(s, c, 'fx_chat_landing', '发布说明', ms);
    return { view: 'task', taskId: 'fx_chat_landing' };
  },
  'chat-storybox': (c, s) => { FIXTURES['chat-reply'](c, s); s.settings.storyBox = 'chat'; return { view: 'task', taskId: 'fx_chat' }; },
  'chat-pills': (c, s) => {
    const t = c.now;
    const ms = chatExchange(c, t - 10 * 60_000);
    pushAll(ms, herMsg(c, 'nudge.rest', { hours: '两个钟头' }, t - 15_000, { proactive: true, facts: { hours: 2 }, n: 'rest', plain: '已连续使用两个小时。' }));
    const last = ms[ms.length - 1];
    if (last?.src) last.src = { ...last.src, slots: { ...(last.src.slots ?? {}), hours: '两个小时' } };
    addChat(s, c, 'fx_chat_pills', '发布说明', ms);
    return { view: 'task', taskId: 'fx_chat_pills' };
  },
  'chat-folded': (c, s) => { FIXTURES['chat-reply'](c, s); s.tasks.fx_chat.foldHer = true; return { view: 'task', taskId: 'fx_chat' }; },
  'chat-crisis': (c, s) => {
    const t = c.now;
    const ms: Message[] = [userMsg('今天又被甲方骂了，我真的不想活了。', t - 70_000)];
    const text = renderLine(CLAUSES['comfort.crisis.a'] ?? '', {}, c.call, c.theme);
    ms.push(herText(c, text, t - 30_000, { crisis: true, plainText: text }));
    addChat(s, c, 'fx_chat_crisis', '今天', ms);
    return { view: 'task', taskId: 'fx_chat_crisis' };
  },
  'chat-streaming': (c, s) => {
    const t = c.now;
    const ms = chatExchange(c, t - 4 * 60_000);
    ms.push(userMsg('那「已知问题」那一节你帮我想想怎么写。', t - 12_000));
    const m = herText(c, '嗯……这一节我觉得可以老实一点：先写现在已经知道、还没修的两件事，再写', t - 4_000, { expr: 'gentle' });
    m.streaming = true;
    ms.push(m);
    addChat(s, c, 'fx_chat_stream', '发布说明', ms);
    return { view: 'task', taskId: 'fx_chat_stream' };
  },
  /** 深夜：配合 --date 把时钟拨到 23:40 以后；这里只摆「夜深提醒」那一句与胶囊. */
  'chat-latenight': (c, s) => {
    const t = c.now;
    const ms = chatExchange(c, t - 8 * 60_000);
    pushAll(ms, herMsg(c, 'late.c', {}, t - 15_000, { proactive: true, n: 'late', plain: '已经很晚了。' }));
    addChat(s, c, 'fx_chat_late', '发布说明', ms);
    return { view: 'task', taskId: 'fx_chat_late' };
  },
  'chat-plain': (c, s) => { const p = plainOf(c, s); addChat(s, p, 'fx_chat_plain', '发布说明', chatExchange(p, p.now)); return { view: 'task', taskId: 'fx_chat_plain' }; },

  /* ── 工作 ── */
  'work-plan-pending': (c, s) => {
    const id = 'fx_plan_run';
    const t = addWork(s, c, 'plan', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now, WORK_STEPS({ a: 'pending', b: 'pending', c: 'pending' }));
    t.messages = workIntro(c, id, c.now - 3 * 60_000, plan.length);
    s.runs[id] = mkRun(c, id, t.id, 'awaiting', plan, {
      activeMs: 0, startedAt: undefined, cursor: { phase: 'planning', step: 0 }, planApproval: { status: 'pending', at: c.now - 60_000 }, live: undefined,
    });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },
  'work-running': (c, s) => {
    const id = 'fx_run_run';
    const t = addWork(s, c, 'run', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now - 14 * 60_000, WORK_STEPS({ a: 'done', b: 'running', c: 'pending' }));
    const msgs = workIntro(c, id, c.now - 16 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 14 * 60_000, true));
    msgs.push(subMsg('researcher', id, '读了 38 条提交记录和 6 份讨论，按「新增 / 调整 / 修复」归了类，结果写在 notes/changes.md。', c.now - 9 * 60_000));
    t.messages = msgs.sort((a, b) => a.at - b.at);
    s.runs[id] = mkRun(c, id, t.id, 'running', plan, {
      live: { agentId: 'coder', activity: 'tool', text: '改写发布说明' },
      toolCalls: [
        call(c, id, plan[0].id, 'researcher', 'web_search', '检索 38 条提交记录', 'ok', 12 * 60_000), call(c, id, plan[0].id, 'researcher', 'read_file', '读取 notes/changes.md', 'ok', 9 * 60_000),
        call(c, id, plan[1].id, 'coder', 'read_file', '读取 RELEASE-NOTES.md', 'ok', 5 * 60_000), call(c, id, plan[1].id, 'coder', 'write_file', '写入 RELEASE-NOTES.md', 'running', 20_000),
      ],
    });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },
  'work-approval-mid': (c, s) => {
    const id = 'fx_mid_run';
    const t = addWork(s, c, 'mid', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now - 14 * 60_000, WORK_STEPS({ a: 'done', b: 'awaiting', c: 'pending' }));
    const tc = call(c, id, plan[1].id, 'coder', 'write_file', '写入 RELEASE-NOTES.md', 'awaiting', 90_000);
    const ap = approvalOf(c, id, t.id, plan[1], tc.id, {});
    tc.approvalId = ap.id;
    const msgs = workIntro(c, id, c.now - 16 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 14 * 60_000, true));
    pushAll(msgs, herMsg(c, 'approve.ask', { what: '写入 RELEASE-NOTES.md' }, c.now - 85_000, { mode: 'work', kind: 'note', runId: id, plain: '待批：写入 RELEASE-NOTES.md。' }));
    t.messages = msgs.sort((a, b) => a.at - b.at);
    s.runs[id] = mkRun(c, id, t.id, 'awaiting', plan, { approvals: [ap], toolCalls: [tc], live: { agentId: 'coder', activity: 'waiting', text: '等你批准写入' } });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },
  'work-approval-high': (c, s) => {
    const id = 'fx_high_run';
    const t = addWork(s, c, 'high', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now - 14 * 60_000, WORK_STEPS({ a: 'done', b: 'awaiting', c: 'pending' }));
    const tc = call(c, id, plan[1].id, 'coder', 'shell', '删除 4 个旧版安装包', 'awaiting', 90_000, { toolName: 'PowerShell' });
    const ap = approvalOf(c, id, t.id, plan[1], tc.id, {
      tool: 'shell', title: '删除 4 个旧版安装包', reason: '发布说明里不再提供 0.1.x 的下载，安装包目录里的旧文件也一并清掉。这一步无法撤销。', risk: 'high', previewKind: 'command',
      preview: 'del release\\Alight-Setup-0.1.1.exe release\\Alight-Setup-0.1.2.exe release\\Alight-Setup-0.1.3.exe release\\Alight-Setup-0.1.4.exe',
    });
    tc.approvalId = ap.id;
    const msgs = workIntro(c, id, c.now - 16 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 14 * 60_000, true));
    pushAll(msgs, herMsg(c, 'approve.high', { what: '删除 4 个旧版安装包', why: '无法撤销' }, c.now - 85_000, { mode: 'work', kind: 'note', runId: id, plain: '待批：删除 4 个旧版安装包，无法撤销。' }));
    t.messages = msgs.sort((a, b) => a.at - b.at);
    s.runs[id] = mkRun(c, id, t.id, 'awaiting', plan, { approvals: [ap], toolCalls: [tc], live: { agentId: 'coder', activity: 'waiting', text: '等你批准删除' } });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },
  'work-question': (c, s) => {
    const id = 'fx_q_run';
    const t = addWork(s, c, 'q', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now - 14 * 60_000, WORK_STEPS({ a: 'done', b: 'awaiting', c: 'pending' }));
    const q: Question = {
      id: nid('q'), runId: id, taskId: t.id, header: '归类', question: '「已知问题」要不要写进发布说明？', createdAt: c.now - 80_000, status: 'pending',
      options: [{ label: '写进去', description: '如实列出两件还没修的事' }, { label: '只写在仓库的 issue 里' }, { label: '先不写' }],
    };
    const msgs = workIntro(c, id, c.now - 16 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 14 * 60_000, false));
    pushAll(msgs, herMsg(c, 'question.w', { what: '要不要写进已知问题' }, c.now - 75_000, { mode: 'work', kind: 'note', runId: id, plain: '有一个问题需要你选择。' }));
    t.messages = msgs.sort((a, b) => a.at - b.at);
    s.runs[id] = mkRun(c, id, t.id, 'awaiting', plan, { questions: [q], live: { agentId: 'coder', activity: 'waiting', text: '等你回答' } });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },
  'work-done': (c, s) => {
    const id = 'fx_done_run';
    const t = addWork(s, c, 'done', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now - 22 * 60_000, WORK_STEPS({ a: 'done', b: 'done', c: 'done' }));
    const msgs = workIntro(c, id, c.now - 25 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 22 * 60_000, true));
    msgs.push(subMsg('reviewer', id, '版本号、日期和 3 个下载链接都对过了，没有发现不一致。', c.now - 3 * 60_000));
    pushAll(msgs, herMsg(c, 'done.w', { t: '发布说明' }, c.now - 60_000, { mode: 'work', kind: 'note', runId: id, facts: { steps: 3, activeMs: 11 * 60_000, retries: 0 }, plain: '已完成：发布说明。' }));
    t.messages = msgs.sort((a, b) => a.at - b.at);
    s.runs[id] = mkRun(c, id, t.id, 'completed', plan, {
      endedAt: c.now - 50_000, costUsd: 0.42, activeMs: 11 * 60_000 + 40_000, cursor: { phase: 'done', step: 2 },
      artifacts: [
        { id: nid('art'), runId: id, stepId: plan[1].id, name: 'RELEASE-NOTES.md', kind: 'diff', language: 'diff', content: DIFF, createdAt: c.now - 4 * 60_000 },
        { id: nid('art'), runId: id, stepId: plan[0].id, name: 'notes/changes.md', kind: 'file', language: 'md', content: '# 改动归类\n\n- 新增：Agent 页、话量三档\n- 调整：对话头像\n', createdAt: c.now - 10 * 60_000 },
      ],
      toolCalls: [call(c, id, plan[1].id, 'coder', 'write_file', '写入 RELEASE-NOTES.md', 'ok', 4 * 60_000), call(c, id, plan[2].id, 'reviewer', 'read_file', '读取 RELEASE-NOTES.md', 'ok', 3 * 60_000)],
    });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },
  'work-failed': (c, s) => {
    const id = 'fx_fail_run';
    const t = addWork(s, c, 'fail', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now - 14 * 60_000, WORK_STEPS({ a: 'done', b: 'failed', c: 'pending' }));
    plan[1].note = '写入时被系统拒绝';
    const err: RunErrorRecord = { id: nid('err'), at: c.now - 70_000, runId: id, stepId: plan[1].id, title: '写入失败', code: 'EACCES', message: 'RELEASE-NOTES.md 没有写入权限（被系统拒绝）。', detail: "EACCES: permission denied, open 'D:/projects/alight-notes/RELEASE-NOTES.md'", fatal: true };
    const msgs = workIntro(c, id, c.now - 16 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 14 * 60_000, true));
    pushAll(msgs, herMsg(c, 'fail.perm', { reason: '系统拒绝了这次写入' }, c.now - 65_000, { mode: 'work', kind: 'note', runId: id, plain: '失败：系统拒绝了这次写入。' }));
    msgs.push({ id: nid('e'), role: 'agent', agentId: ORCH, runId: id, kind: 'error', at: c.now - 64_000, text: '第 2 步没有走完：RELEASE-NOTES.md 没有写入权限（被系统拒绝，EACCES）。做到的部分都留着，可以从失败处重试。' });
    t.messages = msgs.sort((a, b) => a.at - b.at);
    s.runs[id] = mkRun(c, id, t.id, 'failed', plan, {
      endedAt: c.now - 60_000, failure: { stepId: plan[1].id, message: 'RELEASE-NOTES.md 没有写入权限（被系统拒绝）。' }, errors: [err], cursor: { phase: 'executing', step: 1 },
      toolCalls: [call(c, id, plan[1].id, 'coder', 'write_file', '写入 RELEASE-NOTES.md', 'error', 90_000, { error: { code: 'EACCES', message: '没有写入权限（被系统拒绝）', recoverable: false } })],
    });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },
  'work-laiddown': (c, s) => {
    const b = FIXTURES['work-failed'](c, s);
    s.runs.fx_fail_run.laidDownAt = c.now - 30_000;
    return b;
  },
  /** 被打断：应用重启时运行还在跑，被置为暂停（pauseReason 'reload'）——进「待你」，她说一句「好，停下了」. */
  'work-interrupted': (c, s) => {
    const id = 'fx_int_run';
    const t = addWork(s, c, 'int', '整理 v0.2 的发布说明', GOAL);
    const plan = planOf(id, c.now - 14 * 60_000, WORK_STEPS({ a: 'done', b: 'running', c: 'pending' }));
    const msgs = workIntro(c, id, c.now - 16 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 14 * 60_000, true));
    pushAll(msgs, herMsg(c, 'stop.w', {}, c.now - 50_000, { mode: 'work', kind: 'note', runId: id, plain: '已停下，做到的部分都留着。' }));
    t.messages = msgs.sort((a, b) => a.at - b.at);
    s.runs[id] = mkRun(c, id, t.id, 'paused', plan, {
      pauseReason: 'reload', pausedFrom: 'running', interruptedAt: c.now - 60_000, live: { agentId: 'coder', activity: 'paused', text: '改写发布说明' },
      toolCalls: [call(c, id, plan[1].id, 'coder', 'write_file', '写入 RELEASE-NOTES.md', 'cancelled', 90_000)],
    });
    t.runIds = [id];
    t.lastSeenAt = c.now - 5 * 60_000;
    return { view: 'task', taskId: t.id };
  },
  'work-takeover': (c, s) => {
    const id = 'fx_take2_run';
    const t = addWork(s, c, 'take2', '整理 v0.2 的发布说明', GOAL);
    const a = s.agents.find((x) => x.id === 'reviewer');
    if (a) a.enabled = false;
    const plan = planOf(id, c.now - 16 * 60_000, WORK_STEPS({ a: 'done', b: 'done', c: 'running', ranC: ORCH }));
    const msgs = workIntro(c, id, c.now - 18 * 60_000, plan.length);
    msgs.push(...workAsides(c, id, c.now - 16 * 60_000, true));
    t.messages = msgs.sort((a2, b2) => a2.at - b2.at);
    s.runs[id] = mkRun(c, id, t.id, 'running', plan, { live: { agentId: ORCH, activity: 'tool', text: '核对版本号（接手审查）' } });
    t.runIds = [id];
    return { view: 'task', taskId: t.id };
  },

  /* ── 归来 ── */
  'return-brief': (c, s) => {
    const now = c.now;
    const mkTask = (id: string, title: string, run: Run, extra: Partial<Task> = {}) => {
      s.tasks[id] = { id, title, goal: GOAL, createdAt: now - 3 * HOUR, updatedAt: run.endedAt ?? now - 5 * 60_000, agentIds: [ORCH, 'researcher', 'coder', 'reviewer'], runIds: [run.id], messages: [], kind: 'work', engine: engineCC(CWD), trust: 'T1', lastSeenAt: now - 50 * 60_000, ...extra };
      s.taskOrder.push(id);
      s.runs[run.id] = run;
    };
    const p1 = planOf('fx_rb1', now - 70 * 60_000, WORK_STEPS({ a: 'done', b: 'done', c: 'done' }));
    mkTask('fx_rb_t1', '整理 v0.2 的发布说明', mkRun(c, 'fx_rb1', 'fx_rb_t1', 'completed', p1, { endedAt: now - 28 * 60_000, createdAt: now - 80 * 60_000, costUsd: 0.42 }));
    const p2 = planOf('fx_rb2', now - 50 * 60_000, WORK_STEPS({ a: 'done', b: 'failed', c: 'pending' }));
    mkTask('fx_rb_t2', '核对安装包签名', mkRun(c, 'fx_rb2', 'fx_rb_t2', 'failed', p2, { endedAt: now - 22 * 60_000, createdAt: now - 55 * 60_000, failure: { stepId: p2[1].id, message: '找不到签名证书。' } }));
    const p3 = planOf('fx_rb3', now - 30 * 60_000, WORK_STEPS({ a: 'done', b: 'awaiting', c: 'pending' }));
    const tc = call(c, 'fx_rb3', p3[1].id, 'coder', 'shell', '删除 4 个旧版安装包', 'awaiting', 12 * 60_000);
    const ap = approvalOf(c, 'fx_rb3', 'fx_rb_t3', p3[1], tc.id, { tool: 'shell', title: '删除 4 个旧版安装包', risk: 'high', previewKind: 'command', preview: 'del release\\Alight-Setup-0.1.*.exe', createdAt: now - 12 * 60_000, reason: '清理旧版安装包。' });
    tc.approvalId = ap.id;
    mkTask('fx_rb_t3', '清理发布目录', mkRun(c, 'fx_rb3', 'fx_rb_t3', 'awaiting', p3, { approvals: [ap], toolCalls: [tc], live: { agentId: 'coder', activity: 'waiting', text: '等你批准删除' } }));
    s.selectedTaskId = undefined;
    s.lastSeen = now - 41 * 60_000;
    return { view: 'new', away: 41 };
  },
  'return-quiet': (c, s) => {
    s.settings.lifeGreeting = c.persona;
    // 不是首次运行：两个已完成、已看过的任务（都在离开之前结束），离开 35 分钟，期间没有新事、没有待你、没有可看的项 → 安静归来「离开 35 分钟，没有新事，也没有在等你的。」
    const now = c.now;
    const mkDone = (id: string, title: string, runId: string, startAgo: number, endAgo: number, costUsd: number) => {
      const plan = planOf(runId, now - startAgo, WORK_STEPS({ a: 'done', b: 'done', c: 'done' }));
      const endedAt = now - endAgo;
      s.tasks[id] = { id, title, goal: GOAL, createdAt: now - startAgo - 5 * 60_000, updatedAt: endedAt, agentIds: [ORCH, 'researcher', 'coder', 'reviewer'], runIds: [runId], messages: [], kind: 'work', engine: engineCC(CWD), trust: 'T1', lastSeenAt: endedAt + 2 * 60_000 };
      s.taskOrder.push(id);
      s.runs[runId] = mkRun(c, runId, id, 'completed', plan, { endedAt, createdAt: now - startAgo - 90_000, costUsd, cursor: { phase: 'done', step: plan.length - 1 } });
    };
    mkDone('fx_rq_t1', '整理 v0.2 的发布说明', 'fx_rq1', 190 * MIN, 140 * MIN, 0.42);
    mkDone('fx_rq_t2', '核对安装包签名', 'fx_rq2', 120 * MIN, 85 * MIN, 0.18);
    s.selectedTaskId = undefined;
    s.lastSeen = now - 36 * MIN;
    return { view: 'new', away: 36 };   // 窗口 = 36 分钟前到 20 秒前，向下取整读作「35 分钟」
  },

  /* ── 其他页 ── */
  'settings-voice': () => ({ view: 'settings' }),
};

/** 同义名 / 截图名到状态名的别名（manifest 里可以直接写区-状态名）. */
const ALIASES: Record<string, string> = {
  'agents-default': 'agents-idle',
  'agents-model-menu': 'agents-idle',
  'agents-back-default': 'agents-idle',
};

/** 世界重置后给那一张图一个确定的标签，探针与报告里能看到当前状态. */
export const FIXTURE_NAMES: readonly string[] = [...Object.keys(FIXTURES), 'avatar-crop', ...Object.keys(ALIASES)];

/* ── avatar-crop：不是真实页面，是一张「头像三种尺寸 × 六个表情 + 完整龛」的对照板（用真实的 HerAvatar 画） ── */

let overlay: { el: HTMLElement; root: Root } | undefined;

function clearOverlay() {
  if (!overlay) return;
  try { overlay.root.unmount(); } catch { /* 已经卸了 */ }
  overlay.el.remove();
  overlay = undefined;
}

function showAvatarCrop() {
  clearOverlay();
  const el = document.createElement('div');
  el.id = 'fx-avatar-crop';
  el.style.cssText = 'position:fixed;inset:0;z-index:80;overflow:auto;padding:26px 34px;background:var(--bg-1);color:var(--text);font:13px/1.5 var(--font-sans);display:flex;gap:44px;align-items:flex-start';
  document.body.appendChild(el);
  const root = createRoot(el);
  const h = createElement;
  const label = (t: string) => h('div', { style: { fontSize: 12, color: 'var(--text-dim, var(--text))', opacity: 0.8, letterSpacing: '.06em' } }, t);
  const sizes = [24, 44, 56];
  const left = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 22 } },
    h('div', { style: { fontWeight: 600, fontSize: 15 } }, '头像 · 圆角方形裁切（取 527² 的 x70–460, y0–390），三种尺寸 × 六个官方表情'),
    ...sizes.map((px) => h('div', { key: px, style: { display: 'flex', flexDirection: 'column', gap: 8 } },
      label(`${px} px${px <= 72 ? '（带 136² 表情角标）' : ''}`),
      h('div', { style: { display: 'flex', gap: 30, alignItems: 'flex-end' } },
        ...EXPR_IDS.map((e) => h('div', { key: e, style: { display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' } },
          h(HerAvatar, { size: px, expr: e, ring: 'idle' }), h('span', { style: { fontSize: 11, opacity: 0.7 } }, e)))))));
  const right = h('div', { style: { display: 'flex', flexDirection: 'column', gap: 12, alignItems: 'flex-start' } },
    h('div', { style: { fontWeight: 600, fontSize: 15 } }, '完整龛（full，不裁）'),
    label('右栏的龛：整张官方原图，不裁；原图冠顶即贴边，龛内留白 ≥ 8 %'),
    h('div', { style: { padding: '26px 26px 18px', border: '2px solid var(--line-strong, currentColor)', borderRadius: '90px 90px 14px 14px', background: 'rgb(var(--veil-rgb, 20 18 40) / .5)' } },
      h(HerAvatar, { size: 240, expr: 'gentle', shape: 'full' })),
    h('div', { style: { display: 'flex', gap: 8, marginTop: 8 } }, ...EXPR_IDS.map((e) => h(HerAvatar, { key: e, size: 90, expr: e, shape: 'full' }))));
  root.render(h('div', { style: { display: 'flex', gap: 44, alignItems: 'flex-start' } }, left, right));
  overlay = { el, root };
}

/* ── 入口 ── */

const stateOf = (name: string): string => ALIASES[name] ?? name;

function ctxFrom(o: FixtureOpts): Ctx {
  const st = store.get().settings;
  return { now: Date.now(), level: o.level ?? 'm', persona: o.persona ?? true, theme: o.theme ?? (st.mode === 'day' ? 'day' : 'night'), call: st.callName || '阁下' };
}

export function applyFixture(name: string, opts: FixtureOpts = {}): boolean {
  const key = stateOf(name);
  if (key === 'none') { clearOverlay(); return true; }
  if (key !== 'avatar-crop' && !FIXTURES[key]) return false;
  clearOverlay();
  const c = ctxFrom(opts);
  const wallpaper = opts.wallpaper ?? true;
  if (key === 'avatar-crop') {
    store.update((d) => { resetWorld(d as unknown as AppState, c, wallpaper); });
    showAvatarCrop();
    return true;
  }
  const out: { built?: Built } = {};
  store.update((d) => {
    const s = d as unknown as AppState;
    resetWorld(s, c, wallpaper);
    out.built = FIXTURES[key](c, s);
  });
  const built = out.built;
  if (!built) return false;
  // 归来页：离开窗口由 awayWindow 给；其余页清掉它，免得上一个状态的笺留着
  if (built.away) awayWindow.set({ from: Date.now() - built.away * 60_000, to: Date.now() - 20_000 });
  else awayWindow.clear();
  if (built.view === 'task' && built.taskId) actions.openTask(built.taskId);
  else { actions.navigate(built.view); resetScroll(); }
  return true;
}

/** 非对话页：切状态后把滚过的容器拉回顶部（上一张图点牌会把 Agent 页滚到牌背，不该带到下一个状态里）. 对话页要贴底，不动. */
function resetScroll() {
  const top = () => {
    try {
      if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;   // 单测里的假 document
      for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) if (el.scrollTop > 0 && el.tagName !== 'TEXTAREA') el.scrollTop = 0;
      document.scrollingElement?.scrollTo(0, 0);
    } catch { /* 拉回顶部只是截图的便利，失败不影响状态 */ }
  };
  top();
  setTimeout(top, 80);
  setTimeout(top, 260);
}

export function applyDevQuery() {
  // 仅开发：给无头脚本（动效预算度量、验收探针）一个把手
  (window as unknown as { __alight?: unknown }).__alight = {
    store, actions, applyFixture, fixtures: FIXTURE_NAMES,
    /** 关掉所有提示（截图前用，等价于点 button[aria-label="关闭通知"]）. */
    clearToasts: () => store.update((d) => { d.toasts = []; }),
  };
  const q = new URLSearchParams(location.search);
  const demo = q.get('fixture') === 'demo';
  if (demo) applyDemo();
  const mode = q.get('mode');
  if (mode === 'day' || mode === 'night') actions.setSetting('mode', mode);
  if (q.get('wallpaper') === 'off') actions.setSetting('wallpaper', false);
  const view = q.get('view') as ViewId | null;
  if (view) {
    if (view === 'task') actions.openTask(q.get('task') ?? 'demo_gods');
    else actions.navigate(view);
  }
  if (q.get('boot') === '1') actions.playBoot();
  if (q.get('probe') === 'notext') installNoText();
  if (demo) badge();
}
