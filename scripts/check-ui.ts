/* 模块检查（Agent 页 · 塔罗牌桌）：npm run check:ui
   无 GUI、无网络、不花额度、不起子进程。静态渲染（react-dom/server，样式桩掉）+ 对 agents-tarot.css 的静态扫描，覆盖施工图 §7.1 的 check:ui 一行：
     · 四张牌的顺序、命途图标（D-05：src 必须来自 her/path-*）、牌面五行与字号地板（D-09；computed-style 版见文末说明）
     · 白 / 银 / 黑计数与三态（全遵守 / 只认 N 项 / 不受此处限制 / API 隐藏）——DSH 与 Codex 下牌面没有「白 / 银 / 黑 + 数字」
     · 遐蝶牌背：沿用全局、只读；子 Agent 牌背：只能收紧（低于全局档的段禁用）、来源小字、被全局禁用
     · 各引擎 × 权限模式的说明（Claude Code × 5 个模式、Codex、DSH、API）与工具页的 HonorGuide
     · persona=false 版、扣下的牌、停用接手、页内没有贴纸、D-06 全文本扫描、aria-live 的即时回应容器
     · companions.ts 的选择器：选哪个运行、各状态、行迹、近 7 天、牌面序号、缎带
   牌面字的 computed-style（getComputedStyle 的 font-size ≥12、scrollWidth ≤ clientWidth）要真浏览器才有：这里用 CSS 静态扫描 + 文字长度上限替代，
   真测量在合并后的 probe（T）里，用 ALIGHT_UI_DUMP=<目录> 可以把这里渲染出的页面片段存下来看或喂给截图脚本. */
import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* ── 页面偏好要用 localStorage（模型菜单的最近用过）：换成替身 ── */
const lsData = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => lsData.get(k) ?? null,
  setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
  removeItem: (k: string) => { lsData.delete(k); },
  clear: () => lsData.clear(), key: () => null, length: 0,
} as unknown as Storage;

import { ART_DIR, ART_MAX, FACE_CROP_CSS, FACE_SRC, ICON_SRC, PATH_NAME, PATH_OF, PATH_SRC, STICKER_SRC } from '../src/lib/expr';
import { PERMISSION_MODE_LABEL, honorOf, honorSummary, honorTally } from '../src/lib/providers';
import { TIERABLE_TOOLS, tierCounts } from '../src/lib/tiers';
import type { AgentId, AppState, DriverId, Level, ModelState, PermissionMode, PlanStep, Run, RunStatus, Settings, StepStatus, Task, TaskEngine, ThemeId, ToolCall } from '../src/lib/types';
import { initialModels } from '../src/state/models';
import { emptyState, DEFAULT_SETTINGS } from '../src/state/seed';
import { store } from '../src/state/store';
import { AgentsView } from '../src/components/views/AgentsView';
import { ToolsView } from '../src/components/views/ToolsView';
import { HonorGuide, GUIDE_MODES } from '../src/components/views/config/HonorGuide';
import { AGENT_ORDER, dayStart, dispatchOrder, pickRun, ribbonOf, selectAgentWeek, selectCompanions, selectTeamTrail } from '../src/components/views/config/companions';
import { driverBadge, engineShort, tierFace, toolRows, type HonorEnv } from '../src/components/views/config/honorUi';
import { splitBubbles, shortName } from '../src/components/views/config/agentLines';
import { selectAgentStats } from '../src/components/views/config/util';
import { noteCounts } from '../src/lib/storeBridge';

let failed = 0;
let passed = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (!cond) { failed += 1; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); } else { passed += 1; if (!process.env.QUIET) console.log(`  ok  ${name}`); }
}
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) { failed += 1; console.error(`  FAIL ${name}\n    got:  ${a}\n    want: ${b}`); } else { passed += 1; if (!process.env.QUIET) console.log(`  ok  ${name}`); }
}
const section = (name: string) => console.log(`\n${name}`);

/* ═══════════════════════════ 一个够用的 HTML 解析（只吃 React 静态渲染出的规整标记） ═══════════════════════════ */

interface N { tag: string; attrs: Record<string, string>; kids: Array<N | string>; parent?: N }
const VOID = new Set(['img', 'br', 'input', 'hr', 'meta', 'link', 'source', 'wbr']);
const decode = (t: string) => t.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
function parse(html: string): N {
  const root: N = { tag: '#root', attrs: {}, kids: [] };
  let cur = root;
  const re = /<!--[\s\S]*?-->|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[\w:.-]+(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[1]) { // 闭合
      let n: N | undefined = cur;
      while (n && n.tag !== m[1]) n = n.parent;
      if (n?.parent) cur = n.parent;
    } else if (m[2]) {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([\w:.-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = a[2] === undefined ? '' : decode(a[2]);
      const node: N = { tag: m[2], attrs, kids: [], parent: cur };
      cur.kids.push(node);
      if (!VOID.has(m[2]) && !m[4]) cur = node;
    } else if (m[5] !== undefined) cur.kids.push(decode(m[5]));
  }
  return root;
}
const hasClass = (n: N, c: string) => (n.attrs.class ?? '').split(/\s+/).includes(c);
function all(n: N, pred: (x: N) => boolean, out: N[] = []): N[] {
  for (const k of n.kids) if (typeof k !== 'string') { if (pred(k)) out.push(k); all(k, pred, out); }
  return out;
}
const byClass = (n: N, c: string) => all(n, (x) => hasClass(x, c));
const byAttr = (n: N, a: string, v?: string) => all(n, (x) => a in x.attrs && (v === undefined || x.attrs[a] === v));
const textOf = (n: N): string => n.kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join('');
const within = (n: N, pred: (x: N) => boolean) => { for (let p = n.parent; p; p = p.parent) if (pred(p)) return true; return false; };
const kidsEl = (n: N) => n.kids.filter((k): k is N => typeof k !== 'string');

/* ═══════════════════════════ 夹具 ═══════════════════════════ */

const NOW = new Date(2026, 9, 27, 14, 30, 0).getTime();   // 本地时间：钟点台词与本地日分桶都不受时区影响
const HOUR = 3_600_000;
const DAY = 86_400_000;

function modelsReady(): ModelState {
  const m = initialModels();
  const cli = (id: string, driver: DriverId) => { m.providers[id].auth = 'cli'; m.providers[id].driver = driver; m.providers[id].cli = { found: true, login: 'yes', at: 1 }; };
  cli('claude', 'claude-code');
  cli('gpt', 'codex');
  cli('deepseek', 'dsh');
  m.providers.kimi.driver = 'kimi';
  m.providers.kimi.keyHint = '••••1234';
  m.keyHints = { kimi: '••••1234', deepseek: '••••1234' };
  return m;
}

const engineOf = (provider: string, auth: 'cli' | 'api', driver?: DriverId, permissionMode?: PermissionMode): TaskEngine =>
  ({ kind: 'live', provider, auth, driver, model: '', label: `${provider} · ${driver ?? auth}`, permissionMode });
const CLAUDE_CODE = (mode?: PermissionMode) => engineOf('claude', 'cli', 'claude-code', mode);
const CODEX = engineOf('gpt', 'cli', 'codex');
const DSH = engineOf('deepseek', 'cli', 'dsh');

interface StepSpec { agent: AgentId; status: StepStatus; title?: string; ranAs?: AgentId; carried?: boolean; endedAgo?: number }
interface RunSpec { status: RunStatus; steps: StepSpec[]; live?: { agent: AgentId; activity: 'idle' | 'thinking' | 'tool' | 'waiting' | 'paused'; text: string }; calls?: Array<Pick<ToolCall, 'agentId' | 'status'>>; taskEngine?: TaskEngine; id?: string; taskId?: string; createdAgo?: number }

function addRun(s: AppState, spec: RunSpec): Run {
  const taskId = spec.taskId ?? 'T1';
  const id = spec.id ?? 'R1';
  const created = NOW - (spec.createdAgo ?? 2 * HOUR);
  const plan: PlanStep[] = spec.steps.map((st, i) => ({
    id: `${id}-S${i}`, index: i, title: st.title ?? `第 ${i + 1} 步的活`, detail: '', agentId: st.agent, status: st.status, toolCallIds: [],
    startedAt: st.status === 'pending' ? undefined : created + i * 60_000,
    endedAt: st.status === 'done' || st.status === 'failed' ? (st.endedAgo !== undefined ? NOW - st.endedAgo : created + i * 60_000 + 50_000) : undefined,
    ranAs: st.ranAs, carried: st.carried,
  }));
  const toolCalls: ToolCall[] = (spec.calls ?? []).map((c, i) => ({ id: `${id}-C${i}`, runId: id, stepId: plan[0]?.id ?? '', agentId: c.agentId, tool: 'shell', title: '执行命令', input: {}, status: c.status, startedAt: created }));
  const run: Run = {
    id, taskId, attempt: 1, status: spec.status, createdAt: created, startedAt: created, endedAt: ['completed', 'failed', 'cancelled'].includes(spec.status) ? created + 10 * 60_000 : undefined, activeMs: 60_000,
    live: spec.live ? { agentId: spec.live.agent, activity: spec.live.activity, text: spec.live.text } : undefined,
    plan, planReady: true, toolCalls, approvals: [], artifacts: [], errors: [], terminal: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: 0, series: [] }, cursor: { phase: 'executing', step: 0 },
  };
  const task: Task = s.tasks[taskId] ?? { id: taskId, title: '渲染成片', goal: '渲染 51 段', createdAt: created, updatedAt: created, agentIds: ['orchestrator', 'researcher', 'coder', 'reviewer'], runIds: [], messages: [], kind: 'work' };
  task.runIds.push(id);
  if (spec.taskEngine) task.engine = spec.taskEngine;
  s.tasks[taskId] = task;
  if (!s.taskOrder.includes(taskId)) s.taskOrder.push(taskId);
  s.runs[id] = run;
  s.selectedTaskId = taskId;
  return run;
}

interface World { persona?: boolean; level?: Level; mode?: ThemeId; edit?: (s: AppState) => void }
function world(o: World = {}): AppState {
  const persona = o.persona ?? true;
  const level = o.level ?? 'm';
  const settings: Settings = { ...DEFAULT_SETTINGS, persona, level, mode: o.mode ?? 'night', distance: persona ? (level === 'l' ? 2 : 1) : 0 };
  const s = emptyState(NOW, settings);
  s.models = modelsReady();
  s.tools = s.tools.map((t) => ({ ...t }));   // emptyState 里的 tools 是共享的 TOOLS 常量：改全局档前先拷一份，别污染别的夹具
  o.edit?.(s);
  return s;
}
const BUSY_CODER: RunSpec = {
  status: 'running', taskEngine: CLAUDE_CODE(),
  steps: [{ agent: 'researcher', status: 'done' }, { agent: 'coder', status: 'running', title: '渲染成片' }, { agent: 'reviewer', status: 'pending', title: '验收' }],
  live: { agent: 'coder', activity: 'tool', text: '渲染第 31 段，共 51 段' },
};

function page(s: AppState, props: { initial?: AgentId } = {}, label?: string): { html: string; dom: N } {
  store.init(s);
  const html = renderToStaticMarkup(createElement(AgentsView, props));
  const dump = process.env.ALIGHT_UI_DUMP;
  if (dump && label) { fs.mkdirSync(dump, { recursive: true }); fs.writeFileSync(path.join(dump, `${label}-${s.settings.mode}.html`), html); }
  return { html, dom: parse(html) };
}
const card = (d: N, id: AgentId) => byAttr(d, 'data-agent', id).find((x) => x.tag === 'article')!;
const faceOf = (d: N, id: AgentId) => byClass(card(d, id), 'tarot-face')[0];
const cardText = (d: N, id: AgentId) => textOf(faceOf(d, id));
const back = (d: N) => byClass(d, 'tarot-back')[0];
const env = (s: AppState): HonorEnv => {
  const engine = s.selectedTaskId ? s.tasks[s.selectedTaskId]?.engine : undefined;
  return { models: s.models, tools: s.tools, taskEngine: engine, mode: engine?.permissionMode ?? 'ask' };
};
const TIER_TEXT = /[白银黑]\s*\d/;

/* ═══════════════════════════ 契约常量与 expr.ts ═══════════════════════════ */

section('T-UI expr.ts：Node 里取 base 不抛，路径与尺寸规则');
{
  ok('ART_DIR 在 Node 下是相对路径（没有 import.meta.env 也不抛）', ART_DIR.startsWith('./') || ART_DIR.startsWith('/'), ART_DIR);
  eq('六个官方表情与图标、贴纸路径格式', [FACE_SRC('gentle').endsWith('art/her/face-gentle.webp'), ICON_SRC('shy').endsWith('art/her/icon-shy.webp'), STICKER_SRC('like').endsWith('art/her/sticker-like.webp')], [true, true, true]);
  eq('命途：遐蝶记忆、检索智识、编码巡猎、审查存护', AGENT_ORDER.map((id) => PATH_NAME[PATH_OF[id]]), ['记忆', '智识', '巡猎', '存护']);
  eq('命途图标 <48 px 用 -s，≥48 用中图', [PATH_SRC('hunt', 32).endsWith('path-hunt-s.webp'), PATH_SRC('hunt', 56).endsWith('path-hunt.webp')], [true, true]);
  ok('头像裁切与 D4 的数值一致（135.1 / -17.9）', FACE_CROP_CSS.width === 135.1 && FACE_CROP_CSS.left === -17.9 && ART_MAX.face === 349);
}

/* ═══════════════════════════ 选择器 ═══════════════════════════ */

section('T-UI companions：选哪个运行、各状态、牌面序号、缎带');
{
  const s = world();
  eq('没有运行：全员空闲，没有 runId', [selectCompanions(s).runId, AGENT_ORDER.map((id) => selectCompanions(s).agents[id].state)], [undefined, ['idle', 'idle', 'idle', 'idle']]);
  eq('没有运行：派活顺序 = 默认 检索 → 编码 → 审查', dispatchOrder(s), ['researcher', 'coder', 'reviewer']);

  const b = world();
  addRun(b, BUSY_CODER);
  const c = selectCompanions(b, 'T1');
  eq('编码在做、检索做完、审查排在第 3 步', [c.agents.coder.state, c.agents.researcher.state, c.agents.reviewer.state, c.agents.reviewer.nextIndex], ['busy', 'done', 'queued', 2]);
  eq('在做的话取 live.text；正在做的是第 2 步（0 起为 1）', [c.agents.coder.text, c.agents.coder.stepIndex, c.step], ['渲染第 31 段，共 51 段', 1, { index: 1, total: 3, done: 1 }]);
  eq('遐蝶没在做：空闲', c.agents.orchestrator.state, 'idle');
  eq('缎带：在做 · 第 2 步 / 第 3 步 · 待命 / 本轮做完', [ribbonOf(true, c.agents.coder).text, ribbonOf(true, c.agents.reviewer).text, ribbonOf(true, c.agents.researcher).text], ['在做 · 第 2 步', '第 3 步 · 待命', '本轮做完']);

  const w = world();
  addRun(w, { ...BUSY_CODER, status: 'awaiting', live: { agent: 'coder', activity: 'waiting', text: '等待确认：删除 4 个旧版成片母带' } });
  eq('等待确认：缎带「待你」，金色', ribbonOf(true, selectCompanions(w, 'T1').agents.coder), { text: '待你', tone: 'wait' });
  eq('已停用 → 「已歇下」（不管运行里怎样）', ribbonOf(false, { state: 'idle', text: '空闲' }), { text: '已歇下', tone: 'off' });
  eq('暂停 → 「已暂停」', ribbonOf(true, { state: 'busy', text: 'x', activity: 'paused' }).text, '已暂停');

  // 派活顺序取该运行里首次出现的顺序
  const o = world();
  addRun(o, { status: 'running', steps: [{ agent: 'reviewer', status: 'pending' }, { agent: 'coder', status: 'pending' }], live: { agent: 'orchestrator', activity: 'thinking', text: '拆解目标、制定计划' } });
  eq('牌面序号：plan 里先出现的先编号，没出现的按默认补在后面', dispatchOrder(o, 'R1'), ['reviewer', 'coder', 'researcher']);
  eq('遐蝶在做：state busy、没有 stepIndex，缎带只写「在做」', [selectCompanions(o, 'T1').agents.orchestrator.state, ribbonOf(true, selectCompanions(o, 'T1').agents.orchestrator).text], ['busy', '在做']);

  // 选运行的规则：当前任务进行中 > 最近活动的进行中 > 最近结束 > 无
  const p = world();
  addRun(p, { id: 'RA', taskId: 'TA', status: 'completed', steps: [{ agent: 'coder', status: 'done' }], createdAgo: 5 * HOUR });
  eq('只有结束的运行：取最近结束的', pickRun(p)?.id, 'RA');
  addRun(p, { id: 'RB', taskId: 'TB', status: 'running', steps: [{ agent: 'coder', status: 'running' }], live: { agent: 'coder', activity: 'thinking', text: 'x' }, createdAgo: 3 * HOUR });
  addRun(p, { id: 'RC', taskId: 'TC', status: 'running', steps: [{ agent: 'coder', status: 'running' }], live: { agent: 'coder', activity: 'thinking', text: 'x' }, createdAgo: 1 * HOUR });
  eq('没有偏好任务：进行中里取最近活动的（RC）', pickRun(p)?.id, 'RC');
  eq('偏好任务有进行中的运行：取它（TB），不管谁更新', pickRun(p, 'TB')?.id, 'RB');
  eq('偏好任务的运行已结束：回到「最近活动的进行中」', pickRun(p, 'TA')?.id, 'RC');

  // 停用接手
  const t = world({ edit: (st) => { st.agents.find((a) => a.id === 'reviewer')!.enabled = false; } });
  addRun(t, { status: 'completed', steps: [{ agent: 'coder', status: 'done' }, { agent: 'reviewer', status: 'done', ranAs: 'orchestrator', title: '验收' }] });
  const tc = selectCompanions(t, 'T1');
  eq('审查停用：state off，带「接手 1 步」', [tc.agents.reviewer.state, tc.agents.reviewer.takenOver, tc.agents.reviewer.text], ['off', 1, '歇着，步骤交还遐蝶']);
  eq('遐蝶接手执行了一步：它的「完成」里算这一步', [tc.agents.orchestrator.state, tc.agents.orchestrator.text], ['done', '做完 1 步']);
}

section('T-UI selectTeamTrail / selectAgentWeek / selectAgentStats');
{
  const s = world();
  addRun(s, {
    status: 'running',
    steps: [
      { agent: 'researcher', status: 'done', endedAgo: 3 * HOUR }, { agent: 'coder', status: 'done', endedAgo: 2 * HOUR, ranAs: 'orchestrator', title: '接手的一步' },
      { agent: 'coder', status: 'running', title: '渲染' }, { agent: 'reviewer', status: 'pending', title: '验收' },
    ],
    live: { agent: 'coder', activity: 'tool', text: '渲染' },
  });
  const tr = selectTeamTrail(s, 'R1', 2);
  eq('行迹：最近有动静的 2 步（新的在前），总数 = 计划步数', [tr.rows.map((r) => r.index), tr.total], [[2, 1], 4]);
  eq('行迹的行：第 3 步在跑，第 2 步由遐蝶接手', [tr.rows[0].status, tr.rows[1].ranAs], ['running', 'orchestrator']);
  eq('不够 n 行时用还没开始的补足（n=4：…… 最后是排队的审查）', selectTeamTrail(s, 'R1', 4).rows.map((r) => r.status), ['running', 'done', 'done', 'pending']);
  eq('没有运行：空', selectTeamTrail(s, undefined, 2), { rows: [], total: 0 });

  // 近 7 天：本地日分桶，只数 done、排除 carried，记在执行者名下
  const w = world();
  const noon = (back: number) => dayStart(NOW) + 12 * HOUR - back * DAY;
  const run = addRun(w, { status: 'completed', steps: [{ agent: 'coder', status: 'done' }, { agent: 'coder', status: 'done' }, { agent: 'coder', status: 'done', carried: true }, { agent: 'researcher', status: 'done' }, { agent: 'reviewer', status: 'done', ranAs: 'orchestrator' }, { agent: 'coder', status: 'failed' }, { agent: 'coder', status: 'done' }] });
  [0, 0, 0, 2, 3, 0, 8].forEach((back, i) => { run.plan[i].endedAt = noon(back); });
  const week = selectAgentWeek(w, NOW);
  eq('编码：今天 2 步（carried 与失败不数），8 天前的出界', week.coder, [0, 0, 0, 0, 0, 0, 2]);
  eq('检索：2 天前 1 步；审查的一步由遐蝶接手，记在遐蝶名下（3 天前）；做完的运行再给遐蝶记一步编排（按 run.endedAt，今天）', [week.researcher, week.orchestrator], [[0, 0, 0, 0, 1, 0, 0], [0, 0, 0, 1, 0, 0, 1]]);
  eq('每个 Agent 都是 7 个桶', AGENT_ORDER.map((id) => week[id].length), [7, 7, 7, 7]);

  // 统计：被挡与接手
  const st = world();
  addRun(st, { status: 'completed', steps: [{ agent: 'coder', status: 'done' }, { agent: 'reviewer', status: 'done', ranAs: 'orchestrator' }], calls: [{ agentId: 'coder', status: 'denied' }, { agentId: 'coder', status: 'error' }, { agentId: 'coder', status: 'ok' }] });
  const stats = selectAgentStats(st);
  eq('完成步骤记在执行者名下（遐蝶 = 接手的 1 步 + 这个做完的运行的编排 1 步）；停用接手的步骤计入「接手」', [stats.coder?.steps, stats.orchestrator?.steps, stats.reviewer?.steps, stats.reviewer?.taken], [1, 2, 0, 1]);
  const orun = world();
  addRun(orun, { status: 'completed', steps: [{ agent: 'coder', status: 'done' }] });
  addRun(orun, { id: 'R2', status: 'running', steps: [{ agent: 'coder', status: 'running' }], live: { agent: 'coder', activity: 'tool', text: '写' } });
  eq('遐蝶的编排步骤：只数做完的运行（每个一步），没做完的不数；牌背不再是 0 / 空柱', [selectAgentStats(orun).orchestrator?.steps, selectAgentWeek(orun, NOW).orchestrator.reduce((a, b) => a + b, 0)], [1, 1]);
  eq('被挡（denied）与调用数：有页内工具调用时是精确的', [stats.coder?.calls, stats.coder?.denied, stats.coder?.deniedExact], [3, 1, true]);

  // 只读了摘要的运行：denied 没有分项，deniedExact=false
  const lean = world();
  addRun(lean, { id: 'RL', status: 'completed', steps: [{ agent: 'coder', status: 'done' }] });
  noteCounts({ RL: { calls: 5, errors: 1, artifacts: 0, lines: 0, byAgent: { coder: { calls: 5, errors: 1 } }, byTool: { shell: { calls: 5, errors: 1 } } } });
  const ls = selectAgentStats(lean);
  eq('摘要运行：调用数取登记簿，被挡不一定是全部', [ls.coder?.calls, ls.coder?.errors, ls.coder?.deniedExact], [5, 1, false]);
}

section('T-UI 牌面辅助：短名、驱动小标、她的话切气泡、honor 小标');
{
  eq('短名：检索 Agent → 检索；编排 Agent / 遐蝶原样', [shortName({ id: 'researcher', name: '检索 Agent' }), shortName({ id: 'orchestrator', name: '编排 Agent' }), shortName({ id: 'orchestrator', name: '遐蝶' })], ['检索', '编排 Agent', '遐蝶']);
  eq('驱动小标：没指定 = 跟随；命令行 / API', [driverBadge({}), driverBadge({ engine: { key: 'claude:cli', model: '' } }), driverBadge({ engine: { key: 'deepseek:api', model: 'x' } })], ['跟随', '命令行', 'API']);
  eq('切气泡：少档恒一个；两句各一个；三句把后两句并起来', [splitBubbles('甲。乙。', 1), splitBubbles('甲。乙。', 2), splitBubbles('甲。乙。丙。', 2)], [['甲。乙。'], ['甲。', '乙。'], ['甲。', '乙。丙。']]);
  eq('引擎遵守小标', [engineShort(undefined), engineShort('api'), engineShort('claude-code'), engineShort('claude-compat'), engineShort('codex'), engineShort('dsh'), engineShort('acp:kimi')], ['', '无工具', '逐项遵守', '逐项遵守', '只认写文件和联网', '不受限', '试了才拦']);
}

/* ═══════════════════════════ 牌面：顺序、命途图标、五行、字号 ═══════════════════════════ */

section('T-UI 牌桌：四张牌的顺序、命途图标（D-05）、五行、署名');
{
  const s = world();
  addRun(s, BUSY_CODER);
  const { dom, html } = page(s, {}, 'busy');
  const cards = byClass(dom, 'tarot-card');
  eq('四张牌的顺序：遐蝶、检索、编码、审查（DOM 顺序；遐蝶居二是 CSS order，窄屏 2×2 回到这个顺序）', cards.map((c) => c.attrs['data-agent']), ['orchestrator', 'researcher', 'coder', 'reviewer']);
  eq('牌名：遐蝶、检索、编码、审查（不带「Agent」后缀）', cards.map((c) => textOf(byClass(c, 'tarot-name')[0])), ['遐蝶', '检索', '编码', '审查']);
  eq('命途单词：记忆、智识、巡猎、存护', cards.map((c) => textOf(byClass(c, 'tarot-path')[0])), ['记忆', '智识', '巡猎', '存护']);
  eq('三张小牌的罗马序号 = 派活顺序（检索 I、编码 II、审查 III）；主牌没有序号', cards.map((c) => byClass(c, 'tarot-num').filter((x) => !hasClass(x, 'tarot-num--mark')).map(textOf).join('')), ['', 'I', 'II', 'III']);

  const marks = byAttr(dom, 'data-agent-mark');
  ok('命途图标：全部 data-agent-mark 的 src 都来自 her/path-*（D-05）', marks.length >= 8 && marks.every((m) => /art\/her\/path-(remembrance|erudition|hunt|preservation)(-s)?\.webp$/.test(m.attrs.src)), marks.map((m) => m.attrs.src).join(' '));
  ok('每张牌里都有自己命途的图标（主牌在左上角小圆，小牌在月面里）', cards.every((c) => byAttr(c, 'data-agent-mark', c.attrs['data-agent']).some((m) => m.attrs.src.includes(`path-${PATH_OF[c.attrs['data-agent'] as AgentId]}`))));
  ok('命途图标渲染边长：月面 56、主牌小圆 20，都不超过 128²（D-04）', marks.every((m) => Number(m.attrs.width) <= 128));

  // 五行
  const rows = (c: N) => kidsEl(faceOf(dom, c.attrs['data-agent'] as AgentId)).filter((k) => !hasClass(k, 'tarot-orn'));
  eq('牌面只有五行：序号与驱动小标 / 月面 / 牌名与命途 / 档位 / 缎带', cards.map((c) => rows(c).map((r) => (r.attrs.class ?? '').split(' ')[0])), cards.map(() => ['tarot-top', 'tarot-moon', 'tarot-title', 'tarot-tiers', 'tarot-ribbon']));
  ok('牌面里没有英文命途副题、模型名、honor 说明（都在牌背）', cards.every((c) => !/REMEMBRANCE|ERUDITION|THE HUNT|PRESERVATION|逐项遵守|Claude/.test(textOf(faceOf(dom, c.attrs['data-agent'] as AgentId)))));
  eq('驱动小标：都没单独指定模型 = 跟随', cards.map((c) => textOf(byClass(c, 'tarot-seal')[0])), ['跟随', '跟随', '跟随', '跟随']);
  const han = (t: string) => (t.match(/[一-鿿]/g) ?? []).length;
  ok('缎带文字 ≤ 9 个汉字（总长 ≤ 12 个字符）：在做 · 第 2 步 / 第 3 步 · 待命 / 本轮做完 / 空闲', cards.map((c) => textOf(byClass(c, 'tarot-ribbon')[0])).every((t) => han(t) <= 9 && [...t].length <= 12), cards.map((c) => textOf(byClass(c, 'tarot-ribbon')[0])).join('|'));
  ok('「在旁看着」≤ 9 个汉字，且只在 idle + watching 时出现', han(ribbonOf(true, { state: 'idle', text: '空闲' }, true).text) <= 9 && ribbonOf(true, { state: 'idle', text: '空闲' }, true).text === '在旁看着' && ribbonOf(true, { state: 'idle', text: '空闲' }).text === '空闲' && ribbonOf(true, { state: 'busy', text: 'x' }, true).text !== '在旁看着');
  ok('缎带全部状态的文案都 ≤ 9 个汉字', (['idle', 'queued', 'done', 'off', 'busy'] as const).every((state) => [undefined, 'waiting', 'paused', 'tool'].every((activity) => han(ribbonOf(true, { state, text: 'x', activity: activity as never, nextIndex: 30, stepIndex: 30 }).text) <= 9)));
  eq('缎带按状态：遐蝶在旁看着（有运行、同伴在做、她没在执行，不写「空闲」）、检索本轮做完、编码在做、审查排队', cards.map((c) => textOf(byClass(c, 'tarot-ribbon')[0])), ['在旁看着', '本轮做完', '在做 · 第 2 步', '第 3 步 · 待命']);
  ok('在做的牌带 is-work（蓝描边 + 光晕）；选中的是在做的那张（编码）', hasClass(card(dom, 'coder'), 'is-work') && hasClass(card(dom, 'coder'), 'is-selected') && byClass(dom, 'tarot-back')[0].attrs['data-agent'] === 'coder');
  const picks = byClass(dom, 'tarot-pick');
  ok('整张牌是一个按钮：aria-pressed 只有选中的那张为 true，aria-controls 指向牌背', picks.length === 4 && picks.filter((p) => p.attrs['aria-pressed'] === 'true').length === 1 && picks.every((p) => p.attrs['aria-controls'] === 'tarot-back-panel') && byAttr(dom, 'id', 'tarot-back-panel').length === 1);
  ok('牌的按钮名里带名字、命途、驱动、档位与缎带', /^编码 Agent，巡猎命途，跟随，白\d 银\d 黑\d，在做 · 第 2 步$/.test(picks[2].attrs['aria-label']), picks[2].attrs['aria-label']);

  // 署名：主牌的立绘圆形裁切就近署名（D16）；persona 关就没有
  const credit = byAttr(dom, 'data-credit', 'moon');
  ok('主牌就近署名 data-credit="moon"，写明官方', credit.length === 1 && /官方 © miHoYo/.test(textOf(credit[0])) && within(credit[0], (p) => hasClass(p, 'is-hero')));
  const fig = byClass(dom, 'tarot-moon__fig');
  ok('主牌月面 = 官方立绘 figure-official.webp 的圆形裁切（background-image，不是自绘）', fig.length === 1 && /figure-official\.webp/.test(fig[0].attrs.style ?? ''), fig[0]?.attrs.style);
  ok('Agent 页没有贴纸（D19）；没有 ⟦ / face: / react: 之类的标签残留', byAttr(dom, 'data-sticker').length === 0 && !/⟦|face:|react:/.test(html));
  ok('D-06 全文本扫描：没有「银手套」「黑档」「黑色审批卡」', !/银手套|黑档|黑色审批卡/.test(textOf(dom)));
  ok('D-01：页面里没有 data-card 内容卡，也就没有头像混进去', byAttr(dom, 'data-card').length === 0);
  ok('头像只出现在她的话层（data-her）里：[data-her-avatar] 都有 data-her 祖先', byAttr(dom, 'data-her-avatar').length >= 3 && byAttr(dom, 'data-her-avatar').every((a) => within(a, (p) => 'data-her' in p.attrs)));
  ok('D-10：外环只用运行状态（头像 data-ring ∈ idle / work / wait）', byAttr(dom, 'data-ring').every((a) => ['idle', 'work', 'wait', 'none'].includes(a.attrs['data-ring'])));
  ok('页面只放一份 SVG 定义（id 都带 tarot- 前缀、不重复）', (() => { const ids = byAttr(dom, 'id').map((x) => x.attrs.id).filter((i) => i.startsWith('tarot-') && i !== 'tarot-back-panel'); return ids.length > 0 && new Set(ids).size === ids.length; })());
  ok('D-04：立绘月面的渲染宽度 = 月面 ×3.194，始终小于原图 1181（CSS 里是比例，不是固定像素）', /3\.194/.test(fs.readFileSync(path.resolve('src/styles/agents-tarot.css'), 'utf8')));
}

/* ═══════════════════════════ 档位计数与三态 ═══════════════════════════ */

section('T-UI 档位一行：白 / 银 / 黑计数，随引擎分三态');
{
  // Claude Code：逐项遵守，全部显示计数
  const s = world();
  addRun(s, BUSY_CODER);
  const e = env(s);
  const { dom } = page(s);
  for (const id of AGENT_ORDER) {
    const a = s.agents.find((x) => x.id === id)!;
    const c = tierCounts(a, s.tools);
    const want = `白${c.auto}银${c.confirm}黑${c.off}`.replace(/\s/g, '');
    ok(`Claude Code：${id} 牌面 = 「白${c.auto} 银${c.confirm} 黑${c.off}」（数字 = tierCounts）`, textOf(byClass(card(dom, id), 'tarot-tiers')[0]).replace(/\s/g, '') === want, textOf(byClass(card(dom, id), 'tarot-tiers')[0]));
  }
  const researcher = s.agents.find((x) => x.id === 'researcher')!;
  eq('种子：检索 = 白 4 银 2 黑 3，编码 = 白 2 银 3 黑 4，审查 = 白 2 银 1 黑 6，遐蝶沿用全局 = 白 4 银 5 黑 0',
    ['researcher', 'coder', 'reviewer', 'orchestrator'].map((id) => { const c = tierCounts(s.agents.find((x) => x.id === id)!, s.tools); return `${c.auto}${c.confirm}${c.off}`; }), ['423', '234', '216', '450']);
  eq('Claude Code 逐项：honorTally = all，牌面三态 all', tierFace(researcher, e, 'claude-code').kind, 'all');

  // Codex（任务引擎）：只认写文件和联网搜索 → 部分 / 不遵守，牌面没有「白/银/黑 + 数字」
  const cx = world();
  addRun(cx, { ...BUSY_CODER, taskEngine: CODEX });
  const cxp = page(cx, {}, 'codex').dom;
  ok('Codex fixture：四张牌的牌面都没有「白 / 银 / 黑 + 数字」（D-09）', AGENT_ORDER.every((id) => !TIER_TEXT.test(cardText(cxp, id))), AGENT_ORDER.map((id) => cardText(cxp, id)).join(' | '));
  eq('Codex：检索（写文件禁用能生效，其余不能）= 只认 1 项；遐蝶（全是需确认）= 不受此处限制', [textOf(byClass(card(cxp, 'researcher'), 'tarot-tiers')[0]), textOf(byClass(card(cxp, 'orchestrator'), 'tarot-tiers')[0])], ['只认 1 项', '不受此处限制']);

  // DSH
  const ds = world();
  addRun(ds, { ...BUSY_CODER, taskEngine: DSH });
  const dsp = page(ds, {}, 'dsh').dom;
  ok('DSH fixture：牌面没有「白 / 银 / 黑 + 数字」，写「不受此处限制」', AGENT_ORDER.every((id) => !TIER_TEXT.test(cardText(dsp, id)) && textOf(byClass(card(dsp, id), 'tarot-tiers')[0]) === '不受此处限制'));
  ok('DSH：牌背汇总卡折成一张说明卡，不画数字', byClass(back(dsp), 'tarot-sums').length === 1 && hasClass(byClass(back(dsp), 'tarot-sums')[0], 'is-none') && byClass(back(dsp), 'tarot-sum__n').length === 0 && /不听这里的档位/.test(textOf(back(dsp))));

  // 单个 Agent 指定了别的引擎：按它自己的引擎算，不跟任务
  const mixed = world({ edit: (st) => { st.agents.find((a) => a.id === 'researcher')!.engine = { key: 'deepseek:cli', model: '' }; } });
  addRun(mixed, BUSY_CODER);
  const mp = page(mixed).dom;
  eq('检索单独用 DSH：牌面不受限；编码跟随任务（Claude Code）：照常计数；驱动小标「命令行」/「跟随」', [textOf(byClass(card(mp, 'researcher'), 'tarot-tiers')[0]), /白2 ?银3 ?黑4/.test(cardText(mp, 'coder').replace(/\s/g, '')), textOf(byClass(card(mp, 'researcher'), 'tarot-seal')[0]), textOf(byClass(card(mp, 'coder'), 'tarot-seal')[0])], ['不受此处限制', true, '命令行', '跟随']);

  // API：隐藏分档与计数
  const ap = world({ edit: (st) => { st.agents.find((a) => a.id === 'coder')!.engine = { key: 'deepseek:api', model: 'deepseek-chat' }; } });
  addRun(ap, BUSY_CODER);
  const app = page(ap, {}, 'api').dom;
  const apBack = back(app);
  eq('API 的 Agent（编码，在做所以选中）：牌面写「不使用工具」，没有计数', [textOf(byClass(card(app, 'coder'), 'tarot-tiers')[0]), byClass(card(app, 'coder'), 'tarot-tier').length, TIER_TEXT.test(cardText(app, 'coder')), textOf(byClass(card(app, 'coder'), 'tarot-seal')[0])], ['不使用工具', 0, false, 'API']);
  ok('API：牌背没有汇总卡、没有工具行与三段开关，只留模型与统计（步骤）', apBack.attrs['data-kind'] === 'notools' && byClass(apBack, 'tarot-sums').length === 0 && byClass(apBack, 'tarot-tool').length === 0 && byAttr(apBack, 'role', 'radiogroup').length === 0 && byClass(apBack, 'tarot-note--notools').length === 1);
  eq('API：统计只有「完成步骤」，没有调用 / 出错 / 被挡', byClass(apBack, 'tarot-stats')[0] ? all(byClass(apBack, 'tarot-stats')[0], (x) => x.tag === 'dt').map(textOf) : [], ['完成步骤']);
  eq('honorTally(api) = notools', honorTally(s.agents[2], s.tools, 'api').kind, 'notools');
}

/* ═══════════════════════════ 牌背 ═══════════════════════════ */

section('T-UI 遐蝶牌背：沿用全局、只读、不可停用');
{
  const s = world();
  addRun(s, { status: 'running', taskEngine: CLAUDE_CODE(), steps: [{ agent: 'orchestrator', status: 'running' }], live: { agent: 'orchestrator', activity: 'thinking', text: '拆解目标、制定计划' } });
  const { dom } = page(s, {}, 'orch');
  const b = back(dom);
  ok('在做的是遐蝶：选中遐蝶，牌背标题「牌背 · 遐蝶」，英文副题 REMEMBRANCE', b.attrs['data-agent'] === 'orchestrator' && /牌背 · 遐蝶/.test(textOf(b)) && /REMEMBRANCE/.test(textOf(b)));
  const rows = byClass(b, 'tarot-tool');
  ok('工具行 9 项（不含 other），全部「沿用全局」，没有三段开关（只读）', rows.length === 9 && rows.every((r) => r.attrs['data-source'] === 'global') && byAttr(b, 'role', 'radiogroup').length === 0 && byClass(b, 'tarot-fixed').length === 9);
  ok('有「去工具页改全局」，另一句说明其他工具按全局策略', /去工具页改全局/.test(textOf(b)) && /其他工具（子任务、MCP 等）按全局策略/.test(textOf(b)));
  const sw = byAttr(b, 'role', 'switch')[0];
  ok('启用开关：aria-checked=true，aria-disabled=true 且没有 disabled（点了回 agents.locked），写「必须启用」', sw.attrs['aria-checked'] === 'true' && sw.attrs['aria-disabled'] === 'true' && !('disabled' in sw.attrs) && /必须启用/.test(textOf(b)));
  ok('模型：「跟随任务：编排 Agent 总用新建任务时选的模型」', /跟随任务：编排 Agent 总用新建任务时选的模型/.test(textOf(b)));
}

section('T-UI 子 Agent 牌背：只能收紧、来源小字、被全局禁用、汇总卡');
{
  const s = world({ edit: (st) => { st.tools.find((t) => t.id === 'web_fetch')!.permission = 'off'; } });
  addRun(s, { ...BUSY_CODER, live: { agent: 'researcher', activity: 'thinking', text: '读文档' }, steps: [{ agent: 'researcher', status: 'running' }, { agent: 'coder', status: 'pending' }] });
  const { dom } = page(s, {}, 'researcher');
  const b = back(dom);
  ok('选中检索（在做）：标题「牌背 · 检索」，命途「智识 · 检索资料…」', b.attrs['data-agent'] === 'researcher' && /牌背 · 检索/.test(textOf(b)) && /ERUDITION/.test(textOf(b)) && /智识 · 检索资料/.test(textOf(b)));
  const row = (id: string) => byClass(b, 'tarot-tool').find((r) => r.attrs['data-tool'] === id)!;
  const radios = (r: N) => byAttr(r, 'type', 'radio');
  const checked = (r: N) => radios(r).find((x) => 'checked' in x.attrs)?.attrs.value;
  eq('写文件：检索收紧到黑（种子），来源「本 Agent 收紧」', [checked(row('write_file')), row('write_file').attrs['data-source'], /本 Agent 收紧/.test(textOf(row('write_file')))], ['off', 'tightened', true]);
  eq('读文件：全局白，沿用全局；三段都可选（白、银、黑）', [checked(row('read_file')), row('read_file').attrs['data-source'], radios(row('read_file')).filter((x) => 'disabled' in x.attrs).length], ['auto', 'global', 0]);
  const shellRadios = radios(row('web_search'));
  eq('网页搜索：全局白 → 三段都可选', shellRadios.map((x) => 'disabled' in x.attrs), [false, false, false]);
  const gitRow = row('browser_act');
  eq('操作网页：全局「需确认」→ 「白」段禁用（只能收紧），银、黑可选', radios(gitRow).map((x) => 'disabled' in x.attrs), [true, false, false]);
  ok('被禁用的段说明为什么：全局已是「银 · 需确认」，这里只能收紧', byClass(gitRow, 'tarot-seg__opt').some((l) => /全局已是「银 · 需确认」，这里只能收紧/.test(l.attrs.title ?? '')));
  const fetchRow = row('web_fetch');
  eq('抓取网页：全局已禁用 → 来源「被全局禁用」，只有「黑」可选', [fetchRow.attrs['data-source'], /被全局禁用/.test(textOf(fetchRow)), radios(fetchRow).map((x) => 'disabled' in x.attrs)], ['global-off', true, [true, true, false]]);
  ok('每行开关是 radiogroup，名字带工具名；选项名是「白 · 自动」「银 · 需确认」「黑 · 禁用」', byAttr(row('shell'), 'role', 'radiogroup')[0].attrs['aria-label'] === '执行命令 的档位' && ['白 · 自动', '银 · 需确认', '黑 · 禁用'].every((t) => textOf(row('shell')).includes(t)));
  eq('9 个可覆盖的工具都在，other 不出行', byClass(b, 'tarot-tool').map((r) => r.attrs['data-tool']), [...TIERABLE_TOOLS]);

  // 汇总卡（claude-code，全遵守）：三张按钮带数字，aria-pressed
  const sums = byClass(b, 'tarot-sum');
  const researcher = s.agents.find((a) => a.id === 'researcher')!;
  const c = tierCounts(researcher, s.tools);
  eq('汇总卡：白 / 银 / 黑三张，数字 = tierCounts', [sums.length, sums.map((x) => textOf(byClass(x, 'tarot-sum__n')[0]))], [3, [String(c.auto), String(c.confirm), String(c.off)]]);
  ok('汇总卡是按钮：aria-pressed=false，点一张高亮该档（其余行变淡），再点取消', sums.every((x) => x.tag === 'button' && x.attrs['aria-pressed'] === 'false'));
  ok('扣牌 / 启用：开关是 switch，名字带 Agent 名，说明「停用后由遐蝶接手」（一行放得下，不挤出单字）', /停用后由遐蝶接手/.test(textOf(b)) && !/停用后，步骤由遐蝶接手/.test(textOf(b)) && byAttr(b, 'role', 'switch')[0].attrs['aria-label'] === '检索 Agent 启用' && byAttr(b, 'role', 'switch')[0].attrs['aria-checked'] === 'true');
  ok('即时回应容器存在：role=status、aria-live=polite（D-07），没有回应时是空的', (() => { const r = byClass(b, 'tarot-reply')[0]; return r.attrs['aria-live'] === 'polite' && r.attrs.role === 'status' && textOf(r) === ''; })());
  ok('她的摘要在页眉：带头像（只在 data-her 里），不带贴纸', byClass(b, 'tarot-say').length === 1 && byAttr(byClass(b, 'tarot-say')[0], 'data-her-avatar').length === 1 && 'data-her' in byClass(b, 'tarot-say')[0].attrs && byAttr(b, 'data-sticker').length === 0);

  // 近 7 天小柱与统计
  ok('统计：完成步骤 / 工具调用 / 出错 / 被挡 四项；小柱 7 根，口径「近 7 天 · 完成步骤」', all(byClass(b, 'tarot-stats')[0], (x) => x.tag === 'dt').map(textOf).join() === '完成步骤,工具调用,出错,被挡' && all(byClass(b, 'tarot-week__bars')[0], (x) => x.tag === 'i').length === 7 && /近 7 天 · 完成步骤/.test(textOf(b)));
  ok('小柱高度 3–38 px', all(byClass(b, 'tarot-week__bars')[0], (x) => x.tag === 'i').every((x) => { const h = Number(/height:(\d+)px/.exec(x.attrs.style)?.[1]); return h >= 3 && h <= 38; }));
}

/* ═══════════════════════════ 各引擎 × 权限模式的说明 ═══════════════════════════ */

section('T-UI 说明如实：Claude Code × 5 个权限模式 · Codex · DSH · ACP · API');
{
  const noteFor = (eng: TaskEngine | undefined, initial: AgentId = 'coder') => {
    const s = world();
    if (eng) addRun(s, { status: 'running', taskEngine: eng, steps: [{ agent: 'coder', status: 'running' }], live: { agent: 'coder', activity: 'thinking', text: 'x' } });
    return { s, dom: page(s, { initial }).dom };
  };
  const modes: Array<[PermissionMode, string]> = [['ask', '逐项'], ['plan', '计划'], ['acceptEdits', '接受编辑'], ['auto', '自动'], ['bypass', '放手']];
  for (const [mode, name] of modes) {
    const { dom } = noteFor(CLAUDE_CODE(mode));
    const b = back(dom);
    const text = textOf(byClass(b, 'tarot-honor__text')[0]);
    ok(`Claude Code · ${name}：牌背说明 = honorSummary('claude-code', '${mode}')`, text === honorSummary('claude-code', mode) && textOf(b).includes(`权限模式「${PERMISSION_MODE_LABEL[mode]}」`));
    const writeNote = textOf(byClass(byClass(b, 'tarot-tool').find((r) => r.attrs['data-tool'] === 'write_file')!, 'tarot-tool__note')[0]);
    const shellNote = textOf(byClass(byClass(b, 'tarot-tool').find((r) => r.attrs['data-tool'] === 'shell')!, 'tarot-tool__note')[0]);
    const want: Record<PermissionMode, [string, string]> = { ask: ['逐项遵守', '逐项遵守'], plan: ['逐项遵守', '逐项遵守'], acceptEdits: ['接受编辑下不问', '逐项遵守'], auto: ['直接做', '分类器判断'], bypass: ['放手下不问', '放手下不问'] };
    ok(`Claude Code · ${name}：编码的写文件行写「${want[mode][0]}」、执行命令行写「${want[mode][1]}」（按工具分别写，没有笼统的一句）`, writeNote.includes(want[mode][0]) && shellNote.includes(want[mode][1]), `${writeNote} | ${shellNote}`);
  }
  ok('接受编辑下：说明里写清「写文件不会问；执行命令照常问」', /需确认的写文件（工作文件夹内）不会问；执行命令、联网和浏览器照常问/.test(honorSummary('claude-code', 'acceptEdits')));
  ok('自动模式下：说明写「判断不了会直接拒绝」，不说「不会询问」', /判断不了会直接拒绝/.test(honorSummary('claude-code', 'auto')) && !/此刻银档不会询问/.test(honorSummary('claude-code', 'auto')));

  const cx = noteFor(CODEX);
  ok('Codex：说明「只认写文件和联网搜索」；编码（执行命令 = 需确认）这一行置灰并写「Codex 自己管」', textOf(byClass(back(cx.dom), 'tarot-honor__text')[0]) === honorSummary('codex') && /只认写文件和联网搜索/.test(textOf(back(cx.dom))) && (() => { const r = byClass(back(cx.dom), 'tarot-tool').find((x) => x.attrs['data-tool'] === 'shell')!; return hasClass(r, 'is-dim') && /Codex 自己管/.test(textOf(r)); })());
  ok('Codex：编码的 web_search 档是黑（种子）→ 「不联网」生效、不置灰', (() => { const r = byClass(back(cx.dom), 'tarot-tool').find((x) => x.attrs['data-tool'] === 'web_search')!; return !hasClass(r, 'is-dim') && /不联网/.test(textOf(r)); })());
  ok('Codex：汇总卡仍是数字（部分遵守），卡上小字说清是谁、认几项（「Codex 只认其中 N 项」或「Codex 不听这一档」），不用「N / M 项」', byClass(back(cx.dom), 'tarot-sum__n').length === 3 && /Codex (只认其中 \d+ 项|不听这一档)/.test(textOf(back(cx.dom))) && !/Codex(只认其中|不听这一档)/.test(textOf(back(cx.dom))) && !/只认 \d+ \/ \d+ 项/.test(textOf(back(cx.dom))));
  const ds = noteFor(DSH);
  ok('DSH：说明「不受这里限制」；每个非白行置灰并写「不受这里限制」', /不受这里限制/.test(textOf(byClass(back(ds.dom), 'tarot-honor__text')[0])) && byClass(back(ds.dom), 'tarot-tool').filter((r) => r.attrs['data-tier'] !== 'auto').every((r) => hasClass(r, 'is-dim') && /不受这里限制/.test(textOf(r))));
  const kimi = noteFor(engineOf('kimi', 'cli', 'kimi', 'ask'));
  ok('Kimi 等代理：说明「只有代理自己发来权限请求的调用才会问」，标「试了才拦」或「代理自己发请求才问」', /只有代理自己发来权限请求的调用才会问/.test(textOf(back(kimi.dom))) && /试了才拦|代理自己发请求才问/.test(textOf(back(kimi.dom))));
  const api = noteFor(engineOf('deepseek', 'api'));
  ok('API 方式（跟随任务，口吻开）：她的话说「走的是 API，只动脑、不动手」，说明行只留「它只用上面选的模型思考和写作」，不再把「没有档位可调」说两遍', /API/.test(textOf(byClass(back(api.dom), 'tarot-say')[0])) && /它只用上面选的模型思考和写作/.test(textOf(byClass(back(api.dom), 'tarot-note')[0])) && !/API 方式不使用工具/.test(textOf(back(api.dom))) && (textOf(back(api.dom)).match(/没有档位可调/g) ?? []).length === 1 && byClass(back(api.dom), 'tarot-honor').length === 0);
  const apiPlainS = world({ persona: false });
  addRun(apiPlainS, { status: 'running', taskEngine: engineOf('deepseek', 'api'), steps: [{ agent: 'coder', status: 'running' }], live: { agent: 'coder', activity: 'thinking', text: 'x' } });
  const apiPlain = page(apiPlainS, { initial: 'coder' }).dom;
  ok('API 方式（口吻关）：说明行仍是整句「API 方式不使用工具，这里没有档位可调」（事实版里只此一处）', /API 方式不使用工具，这里没有档位可调/.test(textOf(byClass(back(apiPlain), 'tarot-note')[0])) && (textOf(back(apiPlain)).match(/没有档位可调/g) ?? []).length >= 1);
  const lead = (dom: N) => textOf(byClass(back(dom), 'tarot-say')[0]);
  const plainCoder = page(world({ persona: true }), { initial: 'coder' }).dom;
  const plainRes = page(world({ persona: true }), { initial: 'researcher' }).dom;
  const plainRev = page(world({ persona: true }), { initial: 'reviewer' }).dom;
  ok('牌背上她的话默认是这位同伴的自我介绍：检索、编码、审查三张各不相同，也不是银档那句「这一项…」', new Set([lead(plainRes), lead(plainCoder), lead(plainRev)]).size === 3 && ![plainRes, plainCoder, plainRev].some((d) => /这一项要用时|银色/.test(lead(d))), [lead(plainRes), lead(plainCoder), lead(plainRev)].join(' | '));
  ok('Codex 银档的写文件 / 网页搜索：不写「Codex 自己管」，写「Codex 只认「禁用」…」；执行命令仍写自己管', (() => { const rows = byClass(back(cx.dom), 'tarot-tool'); const t = (id: string) => textOf(rows.find((r) => r.attrs['data-tool'] === id)!); const ws = rows.find((r) => r.attrs['data-tool'] === 'web_search')!; return !/Codex 自己管/.test(t('write_file')) && (ws.attrs['data-tier'] === 'off' || /Codex 只认「禁用」（不联网）/.test(textOf(ws))) && /Codex 自己管/.test(t('shell')); })());
  const none = noteFor(undefined);
  ok('没有选中任务、Agent 也没单独指定：用任务的模型；命令行方式才有工具（不下遵守与否的断言，行不置灰）', /用任务的模型；命令行方式才有工具/.test(textOf(back(none.dom))) && byClass(back(none.dom), 'tarot-tool').every((r) => !hasClass(r, 'is-dim')));
  ok('honorOf 对表：Claude Code 接受编辑下写文件银档 asks=no；Codex 黑档写文件 blocks', honorOf('claude-code', 'write_file', 'confirm', 'acceptEdits').asks === 'no' && honorOf('codex', 'write_file', 'off').blocks);
  ok('toolRows 的 dim 只给「有限制而引擎不认」的行', (() => { const { s } = noteFor(DSH); const rows = toolRows(s.agents[2], env(s), 'dsh'); return rows.filter((r) => r.dim).length === rows.filter((r) => r.tier !== 'auto').length; })());

  // 模型菜单里每个选项的遵守小标
  ok('模型菜单：选项右侧的遵守小标来自 engineShort（源码接线）', /engineShort\(honorDriver\(models, \{ key: parseMenuValue\(o\.value\)\.key \}\)\)/.test(fs.readFileSync(path.resolve('src/components/views/config/ModelField.tsx'), 'utf8')));
}

/* ═══════════════════════════ 工具页：HonorGuide ═══════════════════════════ */

section('T-UI 工具页：引擎遵守情况由 honorSummary 生成（逐引擎、逐权限模式）');
{
  for (const mode of GUIDE_MODES) {
    const dom = parse(renderToStaticMarkup(createElement(HonorGuide, { mode })));
    const t = textOf(byClass(dom, 'tools-honor__row').find((r) => r.attrs['data-engine'] === 'claude-code')!);
    ok(`Claude Code · ${PERMISSION_MODE_LABEL[mode]}：整段 = honorSummary`, t.includes(honorSummary('claude-code', mode)));
  }
  const dom = parse(renderToStaticMarkup(createElement(HonorGuide, { mode: 'ask', onMode: () => undefined })));
  const t = textOf(dom);
  ok('Codex / DSH / API / 代理各一行，文案与 honorSummary 一致', [['codex', 'codex'], ['dsh', 'dsh'], ['api', 'api'], ['acp', 'acp:kimi']].every(([id, d]) => textOf(byClass(dom, 'tools-honor__row').find((r) => r.attrs['data-engine'] === id)!).includes(honorSummary(d as never))));
  ok('Codex「只认写文件和联网搜索」、DSH「不受这里限制」、API「不使用工具」', /只认写文件和联网搜索/.test(t) && /不受这里限制/.test(t) && /API 方式不使用工具/.test(t));
  {
    // 回归：权限模式组曾是 role=radio 的 button（无方向键、五个都在 Tab 序里）；现用原生 radio，方向键与 roving 由浏览器负责
    const group = byAttr(dom, 'role', 'radiogroup')[0];
    const inputs = byAttr(group, 'type', 'radio');
    ok('权限模式选择：5 个原生 radio（同一 name），恰有当前一个 checked，且不再用 role=radio 的 button',
      inputs.length === 5 && new Set(inputs.map((x) => x.attrs.name)).size === 1 && !!inputs[0].attrs.name
      && inputs.filter((x) => 'checked' in x.attrs).length === 1 && inputs.find((x) => 'checked' in x.attrs)!.attrs.value === 'ask'
      && byAttr(dom, 'role', 'radio').length === 0 && all(group, (x) => x.tag === 'button').length === 0);
    eq('权限模式选择：radio 顺序 = GUIDE_MODES，标签文字 = PERMISSION_MODE_LABEL', [inputs.map((x) => x.attrs.value), byClass(group, 'tools-honor__mode').map(textOf)], [[...GUIDE_MODES], GUIDE_MODES.map((m) => PERMISSION_MODE_LABEL[m])]);
    const src = fs.readFileSync(path.resolve('src/components/views/config/HonorGuide.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    ok('权限模式选择（源码）：没有 role="radio"，radio 的 onChange 回调 onMode', !/role="radio"/.test(src) && /type="radio"[^>]*onChange=\{\(\) => onMode\(m\)\}/.test(src));
  }
  ok('D-06：没有「银手套」「黑档」「黑色审批卡」；说明每个 Agent 只能收紧', !/银手套|黑档|黑色审批卡/.test(t) && /只能收紧，不能放宽/.test(t));
  const s = world();
  store.init(s);
  let rendered = '';
  let err = '';
  try { rendered = renderToStaticMarkup(createElement(ToolsView)); } catch (e) { err = String(e); }
  ok('ToolsView 整页能静态渲染，顶部是 HonorGuide，工具列表 10 行', !err && byClass(parse(rendered), 'tools-honor').length === 1 && byClass(parse(rendered), 'tools-row').length === 10, err);
  ok('ToolsView：策略说明不再说「每次调用前出现在待确认操作」', !/每次调用前出现在/.test(rendered));
}

/* ═══════════════════════════ persona=false、扣下、停用接手 ═══════════════════════════ */

section('T-UI persona=false：月面是命途图标、牌名「编排 Agent」、无表情无贴纸无立绘');
{
  const s = world({ persona: false });
  addRun(s, BUSY_CODER);
  const { dom, html } = page(s, {}, 'plain');
  eq('主牌牌名「编排 Agent」', textOf(byClass(card(dom, 'orchestrator'), 'tarot-name')[0]), '编排 Agent');
  ok('主牌月面是 AgentMark(remembrance) 大图，不是立绘，也没有署名位', byClass(card(dom, 'orchestrator'), 'tarot-moon__fig').length === 0 && byAttr(card(dom, 'orchestrator'), 'data-agent-mark', 'orchestrator').length >= 1 && byAttr(dom, 'data-credit').length === 0);
  ok('页面里没有她的头像、表情角标、贴纸（[data-her-avatar] / [data-expr] / [data-sticker] 都是 0）', byAttr(dom, 'data-her-avatar').length === 0 && byAttr(dom, 'data-expr').length === 0 && byAttr(dom, 'data-sticker').length === 0 && !/data-badge/.test(html));
  ok('页头改成命途图标 40，一句取事实版（非空、没有遐蝶口吻）', byClass(dom, 'tarot-head__mark').length === 1 && textOf(byClass(dom, 'tarot-bubble')[0]).length > 5 && !/遐蝶/.test(textOf(byClass(dom, 'tarot-head')[0])));
  ok('有运行时那一句在页头（第二个气泡，事实版）；此刻同行底部不重复，只写一行行迹摘要；没有头像；牌背摘要同样没有头像', byClass(byClass(dom, 'tarot-head')[0], 'tarot-bubble').length === 2 && /渲染第 31 段/.test(textOf(byClass(byClass(dom, 'tarot-head')[0], 'tarot-bubble')[1])) && byClass(byClass(dom, 'tarot-crew')[0], 'tarot-bubble').length === 0 && /已结束 1 \/ 3 步/.test(textOf(byClass(byClass(dom, 'tarot-crew')[0], 'tarot-crew__sum')[0])) && byAttr(byClass(dom, 'tarot-crew')[0], 'data-her-avatar').length === 0 && byAttr(back(dom), 'data-her-avatar').length === 0);
  ok('其余（牌面、牌背、汇总卡、统计）不变', byClass(dom, 'tarot-card').length === 4 && byClass(back(dom), 'tarot-sum').length === 3 && byClass(back(dom), 'tarot-tool').length === 9);
  ok('persona=false：D-06 与标签残留扫描', !/银手套|黑档|黑色审批卡|⟦|face:|react:/.test(html));
}

section('T-UI 扣下的牌与停用接手');
{
  const s = world({ edit: (st) => { st.agents.find((a) => a.id === 'reviewer')!.enabled = false; } });
  addRun(s, { status: 'completed', taskEngine: CLAUDE_CODE(), steps: [{ agent: 'coder', status: 'done' }, { agent: 'reviewer', status: 'done', ranAs: 'orchestrator', title: '验收' }] });
  const { dom } = page(s, { initial: 'reviewer' }, 'takeover');
  const c = card(dom, 'reviewer');
  ok('审查扣下：牌带 is-down，缎带「已歇下」，写「步骤交还遐蝶」，有「翻回正面」按钮', hasClass(c, 'is-down') && textOf(byClass(c, 'tarot-ribbon')[0]) === '已歇下' && /步骤交还遐蝶/.test(textOf(c)) && byClass(c, 'tarot-flip')[0]?.tag === 'button' && /翻回正面/.test(textOf(c)));
  ok('扣下的牌没有档位一行（牌面照样只有五行：序号 / 月面 / 牌名 / 翻回 / 缎带）', byClass(c, 'tarot-tiers').length === 0 && !TIER_TEXT.test(textOf(c)));
  ok('「翻回正面」按钮在整张牌的点击区之外（不嵌套按钮），层级更高', !within(byClass(c, 'tarot-flip')[0], (p) => p.tag === 'button') && !within(byClass(c, 'tarot-pick')[0], () => false));
  const b = back(dom);
  ok('牌背：启用开关为关；统计里写「由遐蝶接手 1 步」；还说明取档仍按这里设的', byAttr(b, 'role', 'switch')[0].attrs['aria-checked'] === 'false' && /由遐蝶接手 1 步/.test(textOf(b)) && /取档仍按这里设的/.test(textOf(b)));
  ok('此刻同行：审查节点是「歇着」', (() => { const n = byClass(dom, 'tarot-node').find((x) => x.attrs['data-agent'] === 'reviewer')!; return n.attrs['data-state'] === 'off' && /歇着/.test(textOf(n)); })());
  ok('行迹：停用接手的步骤标「由遐蝶接手」', /由遐蝶接手/.test(textOf(byClass(dom, 'tarot-trail')[0])));
  eq('遐蝶不会被扣下：主牌没有 is-down、没有翻回按钮', [hasClass(card(dom, 'orchestrator'), 'is-down'), byClass(card(dom, 'orchestrator'), 'tarot-flip').length], [false, 0]);
}

section('T-UI 评审修正：接手态自称、默认选中、没有模型的空闲句、停用后两句不重复');
{
  const TAKEOVER: RunSpec = {
    status: 'running', taskEngine: CLAUDE_CODE(),
    steps: [{ agent: 'coder', status: 'done' }, { agent: 'reviewer', status: 'running', ranAs: 'orchestrator', title: '核对版本号' }],
    live: { agent: 'orchestrator', activity: 'tool', text: '核对版本号（接手审查）' },
  };
  const offReviewer = (st: AppState) => { st.agents.find((a) => a.id === 'reviewer')!.enabled = false; };
  // 事实版（persona=false）：编排自己在做，不说第三人称，也不「在旁边看着」
  const sp = world({ persona: false, edit: offReviewer });
  addRun(sp, TAKEOVER);
  const pp = page(sp, {}, 'takeover-plain');
  const headBubbles = (d: N) => byClass(byClass(d, 'tarot-head')[0], 'tarot-bubble').map(textOf);
  const crewText = headBubbles(pp.dom).at(-1) ?? '';
  eq('接手态（persona 关）：页头第二个气泡换成接手句「审查已停用，它的步骤由编排 Agent 接手：核对版本号。」（不再是介绍队伍的那句）', crewText, '审查已停用，它的步骤由编排 Agent 接手：核对版本号。');
  ok('接手态：没有「遐蝶正在」「在旁边看着」的自相矛盾；同行底部不重复这一句', !/遐蝶正在|旁边看着/.test(crewText) && byClass(byClass(pp.dom, 'tarot-crew')[0], 'tarot-bubble').length === 0 && /已结束 1 \/ 2 步/.test(textOf(byClass(byClass(pp.dom, 'tarot-crew')[0], 'tarot-crew__sum')[0])));
  const stripWord = (d: N, id: string) => textOf(byClass(byClass(byClass(d, 'tarot-table')[0], 'tarot-strip')[0], 'tarot-strip__chip').find((c) => c.attrs['data-agent'] === id)!.kids.map((k) => k as N).find((k) => k.tag === 'small')!);
  eq('接手态：同行简版里遐蝶写「在做 · 第 2 步」，与主牌缎带同一个说法', [stripWord(pp.dom, 'orchestrator'), textOf(byClass(card(pp.dom, 'orchestrator'), 'tarot-ribbon')[0])], ['在做 · 第 2 步', '在做 · 第 2 步']);
  const comps = selectCompanions(sp);
  eq('接手态：编排 busy，asFor = 审查，说话用的在做什么不带「（接手…）」括注', [comps.agents.orchestrator.state, comps.agents.orchestrator.asFor, comps.agents.orchestrator.text], ['busy', 'reviewer', '核对版本号']);
  eq('接手态：默认选中以实际执行者为准，是遐蝶（主牌 is-selected + is-work），牌背是遐蝶', [hasClass(card(pp.dom, 'orchestrator'), 'is-selected'), hasClass(card(pp.dom, 'orchestrator'), 'is-work'), back(pp.dom).attrs['data-agent']], [true, true, 'orchestrator']);
  // 口吻版：同行里若有她的一句，不得是第三人称 + 旁观的矛盾句
  const sh = world({ edit: offReviewer });
  addRun(sh, TAKEOVER);
  const ph = page(sh, {}, 'takeover');
  const hb = byClass(byClass(ph.dom, 'tarot-crew')[0], 'tarot-bubble')[0];
  ok('接手态（口吻开）：同行里她的一句（若有）不是「遐蝶正在…我在旁边看着」；页头这一句也不是', (!hb || !/遐蝶正在|旁边看着/.test(textOf(hb))) && !/遐蝶正在|旁边看着/.test(headBubbles(ph.dom).at(-1) ?? ''), hb ? textOf(hb) : '(无)');
  const watch = page((() => { const x = world(); addRun(x, BUSY_CODER); return x; })()).dom;
  eq('有运行、检索在做、遐蝶没在执行：主牌缎带「在旁看着」', textOf(byClass(card(watch, 'orchestrator'), 'tarot-ribbon')[0]), '在旁看着');
  eq('同一屏里遐蝶的状态只有一个说法：同行简版的胶囊与同行节点也写「在旁看着」', [stripWord(watch, 'orchestrator'), textOf(byClass(byClass(watch, 'tarot-crew')[0], 'tarot-node').find((n) => n.attrs['data-agent'] === 'orchestrator')!)], ['在旁看着', '遐蝶在旁看着']);

  // 没有可用的模型：不能说「随时能接活」
  const sn = world({ persona: false, edit: (st) => { st.models = initialModels(); } });
  const pn = page(sn, {}, 'nomodel');
  const nbs = headBubbles(pn.dom);
  const nb = nbs.at(-1);
  ok('没有接入模型（persona 关）：页头那句换成事实句，不说「空闲」「随时」，指向「模型接入」；不再是介绍队伍的那句', !!nb && !/空闲|随时|接活|谁歇着|可以在这里停用/.test(nb) && /模型接入/.test(nb) && byClass(byClass(pn.dom, 'tarot-crew')[0], 'tarot-bubble').length === 0, nb ?? '(无)');
  const sn2 = world({ edit: (st) => { st.models = initialModels(); } });
  const pn2 = page(sn2, {}, 'nomodel');
  const nb2 = byClass(byClass(pn2.dom, 'tarot-crew')[0], 'tarot-bubble')[0];
  ok('没有接入模型（口吻开）：同行与页头的话（若有）都不承诺「随时能接活」', (!nb2 || !/随时能接活/.test(textOf(nb2))) && !/随时能接活/.test(headBubbles(pn2.dom).join('')), nb2 ? textOf(nb2) : '(无)');

  // 进页状态还没到：先用检索，等第一个「在做」出现时补定的逻辑在 AgentsView（pick.id === null 时）
  const src = fs.readFileSync(path.resolve('src/components/views/AgentsView.tsx'), 'utf8');
  ok('默认选中：以运行里实际执行者为准（含遐蝶），进页时还没有在做的就先检索、之后第一次出现再补定一次', /pick\.id === null && busyId/.test(src) && !/id !== 'orchestrator'\) \?\?/.test(src));
}

/* ═══════════════════════════ 此刻同行与队伍行迹 ═══════════════════════════ */

section('T-UI 此刻同行与队伍行迹（页面里）');
{
  const s = world();
  addRun(s, BUSY_CODER);
  const { dom } = page(s);
  const crew = byClass(dom, 'tarot-crew')[0];
  const nodes = byClass(crew, 'tarot-node');
  eq('四个节点：遐蝶、检索、编码、审查；状态 idle / done / busy / queued', [nodes.map((n) => n.attrs['data-agent']), nodes.map((n) => n.attrs['data-state'])], [['orchestrator', 'researcher', 'coder', 'reviewer'], ['idle', 'done', 'busy', 'queued']]);
  ok('同行只表状态：没有连线、没有顺序（节点里没有序号）', byClass(crew, 'tarot-conn').length === 0 && !/[①②③]|第 [一二三] 位/.test(textOf(crew)));
  ok('节点上一行短状态：编码「第 2 步」、检索「做完 1 步」、审查「排第 3 步」；完整的「在做什么」在 title 与她的一句里', /第 2 步/.test(textOf(nodes[2])) && /做完 1 步/.test(textOf(nodes[1])) && /排第 3 步/.test(textOf(nodes[3])) && /渲染第 31 段，共 51 段/.test(nodes[2].attrs.title ?? '') && /渲染第 31 段，共 51 段/.test(byClass(byClass(dom, 'tarot-head')[0], 'tarot-bubble').map(textOf).join('')));
  ok('头：任务标题与「第 2 / 3 步」', /渲染成片/.test(textOf(byClass(crew, 'tarot-crew__head')[0])) && /第 2 \/ 3 步/.test(textOf(byClass(crew, 'tarot-crew__head')[0])));
  ok('她对这次运行说的那句在页头（带头像、第二个气泡，不是介绍队伍的那句），第一个气泡仍是队伍介绍；同行底部不重复，只写行迹摘要', (() => { const h = byClass(dom, 'tarot-head')[0]; const bs = byClass(h, 'tarot-bubble').map(textOf); return bs.length === 2 && /四位/.test(bs[0]) && /渲染第 31 段/.test(bs[1]) && !/谁歇着/.test(bs[1]) && byAttr(h, 'data-her-avatar').length === 1; })() && byClass(crew, 'tarot-crew__say').length === 0 && /编码：渲染第 31 段/.test(textOf(byClass(crew, 'tarot-crew__sum')[0])));
  { // 话量少：页头只有一个气泡，就只说这一句
    const sd = page((() => { const x = world({ level: 's' }); addRun(x, BUSY_CODER); return x; })()).dom;
    const bs = byClass(byClass(sd, 'tarot-head')[0], 'tarot-bubble').map(textOf);
    ok('话量少 + 有运行：页头一个气泡，是她对这次运行说的那句', bs.length === 1 && /渲染第 31 段/.test(bs[0]), bs.join(' | '));
    const wd = world(); addRun(wd, { ...BUSY_CODER, status: 'awaiting', live: { agent: 'coder', activity: 'waiting', text: '等你点头' } });
    const wb = byClass(byClass(page(wd).dom, 'tarot-head')[0], 'tarot-bubble').map(textOf);
    ok('有同伴在等你：页头第二个气泡换成「等你」那一句（agents.wait）', wb.length === 2 && /编码/.test(wb[1]) && /批准|点头/.test(wb[1]), wb.join(' | '));
  }
  const trail = byClass(dom, 'tarot-trail')[0];
  eq('队伍行迹：两行 + 「在行迹里看全部 3 条」', [byClass(trail, 'tarot-trow').length, /在行迹里看全部 3 条/.test(textOf(trail))], [2, true]);
  ok('行迹每行带命途图标（AgentMark）、时间、状态词', byClass(trail, 'tarot-trow').every((r) => byAttr(r, 'data-agent-mark').length === 1 && /\d\d:\d\d|—/.test(textOf(byClass(r, 'tarot-trow__t')[0]))) && /运行中/.test(textOf(trail)));
  // 矮窗口的同行简版：牌桌里一条，四枚 20 px 命途图标 + 名 + 状态词，右端「最近：…」点开是行迹
  const strip = byClass(byClass(dom, 'tarot-table')[0], 'tarot-strip')[0];
  eq('同行简版（牌桌顶上）：四位，顺序遐蝶、检索、编码、审查', byClass(strip, 'tarot-strip__chip').map((c) => c.attrs['data-agent']), ['orchestrator', 'researcher', 'coder', 'reviewer']);
  ok('同行简版：每位一枚 AgentMark(20)，状态词是「在做 / 待命 / 做完 / 歇着」之一，右端是按钮「最近：…」', byAttr(strip, 'data-agent-mark').length === 4 && byAttr(strip, 'data-agent-mark').every((m) => m.attrs.width === '20') && /在做/.test(textOf(strip)) && /做完/.test(textOf(strip)) && /在旁看着/.test(textOf(strip)) && byClass(strip, 'tarot-strip__last')[0]?.tag === 'button' && /最近：\d\d:\d\d/.test(textOf(strip)));
  // 无运行
  const idle = page(world(), {}, 'idle').dom;
  ok('没有运行：同行一句取 agents.idle，行迹写空态，没有「看全部」', /没有进行中的任务/.test(textOf(byClass(idle, 'tarot-crew')[0])) && /还没有运行记录/.test(textOf(byClass(idle, 'tarot-trail')[0])) && !/看全部/.test(textOf(byClass(idle, 'tarot-trail')[0])));
  ok('没有运行时默认选中检索，牌背是检索；页头仍是 agents.lead（两个气泡，第二个是「都在这里调」），同行底部放 agents.idle 一句，没有行迹摘要', back(idle).attrs['data-agent'] === 'researcher' && byClass(byClass(idle, 'tarot-head')[0], 'tarot-bubble').length === 2 && /都在这里调/.test(textOf(byClass(byClass(idle, 'tarot-head')[0], 'tarot-bubble')[1])) && byClass(byClass(idle, 'tarot-crew')[0], 'tarot-bubble').length === 1 && byClass(byClass(idle, 'tarot-crew')[0], 'tarot-crew__sum').length === 0);
}

/* ═══════════════════════════ 她的话随话量、夜昼 ═══════════════════════════ */

section('T-UI 她的话：页头气泡数随话量，夜昼、没有挽留、没有感叹号');
{
  const lead = (level: Level) => byClass(page(world({ level })).dom, 'tarot-head')[0];
  eq('页头气泡：少 1 个；中、多 ≤2 个', [byClass(lead('s'), 'tarot-bubble').length, byClass(lead('m'), 'tarot-bubble').length <= 2, byClass(lead('l'), 'tarot-bubble').length <= 2], [1, true, true]);
  const night = textOf(page(world({ level: 'l', mode: 'night' })).dom);
  const day = textOf(page(world({ level: 'l', mode: 'day' })).dom);
  ok('夜昼各一套（多档页头句至少有一处不同，或同一句——不断言钟点）', night.length > 100 && day.length > 100);
  ok('页面文字里没有感叹号与「～」', !/[！!～~]/.test(night) && !/[！!～~]/.test(day));
  ok('不挽留：页面里没有「别走」「再陪我」「留下」', !/别走|再陪我|不要走|留下来/.test(night + day));
  ok('页头标题是「Agent」（D13）', textOf(byClass(lead('m'), 'view__title')[0]) === 'Agent');
}

/* ═══════════════════════════ CSS 静态扫描（D-09 的静态版） ═══════════════════════════ */

section('T-UI agents-tarot.css：牌面字号地板 12.5 px、不截断、五行');
{
  const css = fs.readFileSync(path.resolve('src/styles/agents-tarot.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
  const FACE = /\.tarot-(?:face|top|num|seal|crescent-s|moon|title|name|path|tiers|tier|ribbon|flip|credit)(?![\w-])/;
  const faceRules = rules.filter((r) => FACE.test(r.sel));
  ok('扫到了牌面相关的规则', faceRules.length >= 20, String(faceRules.length));
  const sizes = faceRules.flatMap((r) => [...r.body.matchAll(/(?:^|[;\s])font(?:-size)?\s*:\s*([^;]+)/g)].map((m) => ({ sel: r.sel, v: m[1] })));
  const px = sizes.map((x) => ({ sel: x.sel, n: Number(/(\d+(?:\.\d+)?)px/.exec(x.v)?.[1]), v: x.v }));
  ok('牌面里每一处字号都是 px 且 ≥ 12.5（地板；微标 11 px 不用于牌面）', px.length >= 9 && px.every((x) => Number.isFinite(x.n) && x.n >= 12.5), px.filter((x) => !(x.n >= 12.5)).map((x) => `${x.sel}:${x.v}`).join(' | '));
  ok('牌面里没有用 em / rem / % 写字号（不会被悄悄缩小）', sizes.every((x) => !/font-size\s*:[^;]*(em|rem|%)/.test(`font-size:${x.v}`) && !/^[\d.]+(em|rem)/.test(x.v.trim())));
  ok('牌面不用省略号、不用行数截断（text-overflow:ellipsis / line-clamp）', faceRules.every((r) => !/text-overflow\s*:\s*ellipsis|line-clamp/.test(r.body)));
  ok('牌面各行不 overflow:hidden（不截断；缎带、牌名换行而不是裁掉）', faceRules.filter((r) => /\.tarot-(?:face|top|title|name|path|tiers|ribbon)(?![\w-])/.test(r.sel) && !/::after|:hover/.test(r.sel)).every((r) => !/overflow(?:-x)?\s*:\s*hidden/.test(r.body)));
  ok('只有短小标（驱动小标、单档计数、翻回按钮）用 nowrap；缎带与牌名允许换行', faceRules.filter((r) => /white-space\s*:\s*nowrap/.test(r.body)).every((r) => /tarot-(?:seal|tier|flip)(?![\w-])/.test(r.sel)));
  ok('牌桌 4 列一排（≥640 容器：1280 窗口主栏约 740、960 窗口约 690 都是一排，主牌居中放大）、2×2 只在 <640；档位一行不折行；牌名换行、缎带 min-height 而非固定 height', /@container tarot \(min-width: 640px\) \{\s*\.tarot-table \{[^}]*minmax\(0, 1fr\) minmax\(0, 1\.26fr\) minmax\(0, 1fr\) minmax\(0, 1fr\)/.test(css) && !/min-width: (?:7[0-9]{2}|8[0-9]{2})px\) \{\s*\.tarot-table/.test(css) && /\.tarot-tiers \{[^}]*flex-wrap: nowrap/.test(css) && /\.tarot-ribbon[^{]*\{[^}]*min-height/.test(css) && !/\.tarot-ribbon[^{]*\{[^}]*[^-]height\s*:\s*\d/.test(css));
  ok('一排里最窄的小牌（卡片内宽 ≤140 px）：用卡片容器查询收紧左右内边距、缎带内边距，档位三组之间仍留 6 px（符号到自己的字 2 px，不连成一块），字号不动（仍 ≥12.5）', /@container tcard \(max-width: 140px\) \{\s*\.tarot-face \{ padding-inline: 6px; \}\s*\.tarot-tiers \{ gap: 2px 6px; \}[\s\S]*?\.tarot-ribbon \{ margin-inline: 2px; padding-inline: 8px; \}/.test(css) && /\.tarot-card \{[^}]*container: tcard \/ inline-size/.test(css));
  ok('牌桌上下内边距收紧（≤16 px，矮窗口里再加 44 px 的同行简版位），1280×800 里牌桌 + 简版合计不超过约 420 px', /\.tarot-table \{[^}]*padding: 14px 14px 16px/.test(css) && /@container tarot \(min-width: 640px\) \{\s*\.tarot-table \{[^}]*padding: 16px 14px 16px/.test(css));
  ok('同行简版：<660 容器只收起右端「最近」、<560 才收起状态词（640–660 的一排里仍带状态词）', /@container tarot \(max-width: 659px\) \{ \.tarot-strip__last \{ display: none; \} \}/.test(css) && /@container tarot \(max-width: 559px\) \{ \.tarot-strip__chip small \{ display: none; \} \}/.test(css));
  ok('昼景：牌桌底色比 r2 深一档（#e7dcf4→#dacced，带下沿内阴影），牌的投影加深（0 14px 28px / .32 + 0 3px 6px / .2）', /:root\[data-mode="day"\] \.tarot-table \{[^}]*linear-gradient\(180deg, #e7dcf4, #dacced\)[^}]*inset 0 -8px 24px rgb\(90 55 130 \/ 0\.10\)/.test(css) && /:root\[data-mode="day"\] \.tarot \{[^}]*--card-shadow: 0 14px 28px rgb\(60 32 100 \/ 0\.32\), 0 3px 6px rgb\(60 32 100 \/ 0\.2\)/.test(css));
  ok('动画只有翻牌：keyframes 只有 tarot-turn；reduced / window-hidden 交给 base.css，卡片 transform 另有 reduced 兜底', [...css.matchAll(/@keyframes\s+([\w-]+)/g)].map((m) => m[1]).join() === 'tarot-turn' && /data-motion="reduced"\] \.tarot-card/.test(css));
  ok('矮窗口（内高 <920，含 1440×900）：牌桌与牌背先于「此刻同行」，整张牌背不用滚动就露出来（order，DOM 顺序不变）', /@media \(max-height: 919px\)[^}]*\.tarot-now \{ order: 5; \}/.test(css));
  ok('昼里月面里的官方命途图标保持官方原样（不套 brightness(.5) 压暗）；浅底上的小图仍走 tarot-plum', /:root\[data-mode="day"\] \.tarot-moon\.is-mark \.hmark \{ --hmark-tint: none; \}/.test(css) && /\.tarot-num--mark img \{ filter: url\(#tarot-plum\)/.test(css));
  ok('容器 ≥800（1440 宽）：月面放大（主牌 62cqw ≥ 136 px、小牌 58cqw），牌的高宽比收紧，余量匀给各行', /@container tarot \(min-width: 800px\) \{[^}]*\.tarot-card \{ aspect-ratio: 1 \/ 1\.46; \}[\s\S]*?\.tarot-card\.is-hero \.tarot-moon \{ --m: 62cqw; \}[\s\S]*?\.tarot-face \{ justify-content: space-between; \}/.test(css) && /3\.194/.test(css));
  ok('矮窗口（内高 <920）里牌桌顶上有一条 28 px 的同行简版（padding-top 44），高窗口不显示；完整版仍沉到牌背之后', /\.tarot-strip \{ display: none; \}/.test(css) && /@media \(max-height: 919px\) \{\s*\.tarot \.tarot-table \{ padding-top: 44px; \}\s*\.tarot-strip \{[^}]*height: 28px;[^}]*display: flex/.test(css) && /\.tarot-strip__chip \{[^}]*height: 28px/.test(css));
  ok('夜的牌桌也有水印（淡紫 6%）和桌沿内描边（含米金线），不画连线', /\.tarot-table \{[^}]*data:image\/svg\+xml[^}]*%23d8c8f0' fill-opacity='\.06'[^}]*inset 0 0 0 6px rgb\(18 14 34 \/ 0\.35\), inset 0 0 0 7px rgb\(200 185 154 \/ 0\.28\)/.test(css));
  ok('主牌左上两枚徽记 28 px、带浅底与米金描边', /\.tarot-top__l \.tarot-type, \.tarot-top__l \.tarot-num--mark \{ width: 28px; height: 28px; box-shadow: inset 0 0 0 1px var\(--card-tan\)/.test(css));
  ok('昼的牌桌有桌沿内描边（含米金线）和 6–7% 的蝶 / 星点水印，不画连线', /:root\[data-mode="day"\] \.tarot-table \{[^}]*data:image\/svg\+xml[^}]*fill-opacity='\.07'[^}]*inset 0 0 0 6px #ece3f7, inset 0 0 0 7px rgb\(200 185 154 \/ 0\.5\)/.test(css));
  ok('启用开关：说明换到开关下面（12 px、≤120 px 宽、一行放得下）；工具行来源小字两段（永远各占一行，不再有挂在行首的「·」）', /\.tarot-toggle \{[^}]*width: max-content/.test(css) && /\.tarot-toggle__text small \{[^}]*max-width: 120px[^}]*white-space: nowrap/.test(css) && /\.tarot-tool__note > span \{ white-space: nowrap; \}/.test(css) && !/tarot-tool__honor::before/.test(css) && /\.tarot-tool__note \{[^}]*flex-direction: column/.test(css) && !/\.tarot-tool__note \{[^}]*flex-direction: row/.test(css));
  ok('颜色一律来自令牌（牌框 card-frame / card-ground / card-tan、环 ring-*、档位 tier-*、silver）', ['--card-frame', '--card-ground', '--card-tan', '--ring-work', '--ring-wait', '--tier-auto', '--tier-off', '--silver'].every((t) => css.includes(`var(${t})`)));
  ok('夜昼各一套局部变量（徽记着色 / 牌框装饰）', /:root\[data-mode="day"\] \.tarot \{/.test(css));
}

/* ═══════════════════════════ 接线（源码守卫） ═══════════════════════════ */

section('T-UI 接线：写 store 一律走 actions，不直接 store.update / store.set');
{
  const dir = path.resolve('src/components/views');
  const files = ['AgentsView.tsx', 'ToolsView.tsx', ...fs.readdirSync(path.join(dir, 'config')).filter((f) => /\.(tsx|ts)$/.test(f)).map((f) => `config/${f}`)];
  const src = Object.fromEntries(files.map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  ok('Agent 页与工具页的组件里没有 store.update / store.set', Object.entries(src).every(([, t]) => !/store\.(update|set)\(/.test(t)));
  ok('档位开关 → actions.setAgentTier(agent.id, 工具, 档)；不再调旧的 setAgentTools', /actions\.setAgentTier\(agent\.id, tool\.tool\.id, tier\)/.test(src['config/CardBack.tsx']) && !Object.values(src).some((t) => /setAgentTools/.test(t)));
  ok('启用开关 → actions.setAgentEnabled；翻回正面 → actions.setAgentEnabled(id, true)；遐蝶点开关只回话不动 store', /actions\.setAgentEnabled\(agent\.id, on\)/.test(src['config/CardBack.tsx']) && /actions\.setAgentEnabled\(id, true\)/.test(src['AgentsView.tsx']) && /onLocked=\{\(\) => respond\('agents\.locked'\)\}/.test(src['config/CardBack.tsx']));
  ok('改模型 → actions.setAgentEngine（沿用旧逻辑），之后让她回一句 agents.setmodel / agents.follow', /actions\.setAgentEngine\(agent\.id, e\)/.test(src['config/ModelField.tsx']) && /agents\.setmodel/.test(src['config/CardBack.tsx']) && /agents\.follow/.test(src['config/CardBack.tsx']));
  ok('即时回应：3 秒后收起（setTimeout 3000）、只在 AgentsView 里存局部状态', /setTimeout\(\(\) => setReply\(null\), 3000\)/.test(src['AgentsView.tsx']));
  ok('点牌后 scrollIntoView 到牌背（减少动态时 auto），只在用户点牌时滚（pick.n 变了），进页与默认选中不滚', /scrollIntoView\?\.\(\{ behavior: reducedRef\.current \? 'auto' : 'smooth', block: 'start' \}\)/.test(src['AgentsView.tsx']) && /\[pick\.n\]/.test(src['AgentsView.tsx']) && /if \(pick\.n === 0\) return;/.test(src['AgentsView.tsx']));
  ok('话量 / 口吻只经 useVoice（不自己读 settings.distance）', !Object.values(src).some((t) => /settings\.distance|effectiveDistance/.test(t)));
  ok('旧的 AgentCard / ToolChip / DISABLED_META 已整体删除', !fs.existsSync(path.join(dir, 'config/AgentCard.tsx')) && !Object.values(src).some((t) => /import[^;]*AgentCard|<AgentCard|ToolChip|DISABLED_META/.test(t)));
}

/* ═══════════════════════════ ALIGHT_UI_DUMP：夜昼 × 几个状态的页面片段，喂给截图脚本 ═══════════════════════════ */
if (process.env.ALIGHT_UI_DUMP) {
  for (const mode of ['night', 'day'] as const) {
    page(world({ mode }), {}, 'idle');
    for (const level of ['s', 'l'] as const) page(world({ mode, level }), {}, `idle-${level}`);
    const busy = world({ mode }); addRun(busy, BUSY_CODER); page(busy, {}, 'busy');
    const wait = world({ mode }); addRun(wait, { ...BUSY_CODER, status: 'awaiting', live: { agent: 'coder', activity: 'waiting', text: '等待确认：删除 4 个旧版成片母带' } }); page(wait, {}, 'wait');
    const off = world({ mode, edit: (st) => { st.agents.find((a) => a.id === 'reviewer')!.enabled = false; } });
    addRun(off, { status: 'completed', taskEngine: CLAUDE_CODE(), steps: [{ agent: 'coder', status: 'done' }, { agent: 'reviewer', status: 'done', ranAs: 'orchestrator', title: '验收' }] });
    page(off, { initial: 'reviewer' }, 'takeover');
    const cx = world({ mode }); addRun(cx, { ...BUSY_CODER, taskEngine: CODEX }); page(cx, {}, 'codex');
    const plain = world({ mode, persona: false }); addRun(plain, BUSY_CODER); page(plain, {}, 'plain');
    { const tw = world({ mode }); addRun(tw, { ...BUSY_CODER, taskEngine: CLAUDE_CODE('acceptEdits') }); store.init(tw); fs.mkdirSync(process.env.ALIGHT_UI_DUMP, { recursive: true }); fs.writeFileSync(path.join(process.env.ALIGHT_UI_DUMP, `tools-${mode}.html`), renderToStaticMarkup(createElement(ToolsView))); }
    const orch = world({ mode }); addRun(orch, { status: 'running', taskEngine: CLAUDE_CODE(), steps: [{ agent: 'orchestrator', status: 'running' }], live: { agent: 'orchestrator', activity: 'thinking', text: '拆解目标、制定计划' } }); page(orch, {}, 'orch');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
