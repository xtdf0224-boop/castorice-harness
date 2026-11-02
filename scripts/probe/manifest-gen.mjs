#!/usr/bin/env node
// 生成验收截图清单 design/chat/accept/manifest.json（施工图 §7.4）。清单是数据；要改状态 / 点击序列，改这个脚本再重新生成，别手改 JSON.
//   node scripts/probe/manifest-gen.mjs [--out <manifest.json>]
// 命名：<区>-<状态>-<night|day>-<s|m|l>[-nowall].png（口吻关的两个状态直接叫 agent-plain / chat-plain，不再加后缀）.
//   · 核心矩阵：7 个状态 × 夜昼 × 少中多 = 42 张（agent-default、chat-reply、work-plan-pending、work-approval-high、work-done、work-failed、return-brief）
//   · 其余状态：默认中档，夜昼各一张（含 agent-reviewer-off 的 +0.5 s / +4 s 两张、Agent 页三个宽度、avatar-crop）
//   · 每个状态再各一张 -nowall（壁纸关，中档），供 Q1 判断；avatar-crop、+4 s 那张、宽度变体不出 -nowall（对照板 / 重复）
//   · chat-latenight 用 date 把页面时钟拨到 23:42（其余默认 16:20）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = path.resolve(here, '..', '..', '..', 'design', 'chat', 'accept', 'manifest.json');

const THEMES = ['night', 'day'];
const LEVELS = ['s', 'm', 'l'];

const PICK = (agent) => `click:article[data-agent="${agent}"] .tarot-pick`;
const SWITCH = 'click:#tarot-back-panel .tarot-sw';
const LATE = '2026-10-27T23:42:00';
const TOP = 'eval:for (const e of document.querySelectorAll("*")) { if (e.scrollTop > 0 && e.tagName !== "TEXTAREA") e.scrollTop = 0; } document.scrollingElement && document.scrollingElement.scrollTo(0, 0)';

/** [区-状态 文件名前缀, 状态名(fixture), 额外字段]. */
const CORE = [
  ['agent-default', 'agents-idle', {}],
  ['chat-reply', 'chat-reply', {}],
  ['work-plan-pending', 'work-plan-pending', {}],
  ['work-approval-high', 'work-approval-high', {}],
  ['work-done', 'work-done', {}],
  ['work-failed', 'work-failed', {}],
  ['return-brief', 'return-brief', {}],
];

const OTHERS = [
  ['agent-busy', 'agents-busy', {}],
  ['agent-reviewer-off', 'agents-idle', { steps: [PICK('reviewer'), SWITCH], wait: 120, note: '点牌、点启用开关后约 0.5 s：她的即时回应还在' }],
  ['agent-reviewer-off-4s', 'agents-idle', { steps: [PICK('reviewer'), SWITCH], wait: 3800, noWall: false, note: '同上约 4 s 后：即时回应已收起（3 秒）' }],
  ['agent-model-menu', 'agents-idle', { steps: [PICK('researcher'), 'click:#tarot-back-panel[data-agent="researcher"] .tarot-model button.mselect-field', 'wait:350'], note: '点研究员牌，再在它的牌背里展开模型菜单（菜单里的模型名应是像真的名字，不是夹具占位名）' }],
  ['agent-back-orchestrator', 'agents-back-orchestrator', { steps: [PICK('orchestrator')] }],
  ['agent-back-coder-codex', 'agents-back-coder-codex', { steps: [PICK('coder')] }],
  ['agent-back-researcher-api', 'agents-back-researcher-api', { steps: [PICK('researcher')] }],
  ['agent-takeover', 'agents-takeover', {}],
  ['agent-nomodel', 'agents-nomodel', {}],
  ['agent-plain', 'agents-plain', { persona: false }],
  // 第 2 轮补拍：以下几张都先 scrollTop=0（保险；applyFixture 对非对话页本身也会把滚动拉回顶），拍「牌桌 + 页头」整页
  ['agent-plain-top', 'agents-plain', { persona: false, steps: [TOP], note: '口吻关：主牌用命途图标 AgentMark、牌名「编排 Agent」；页头无她的头像' }],
  ['agent-nomodel-top', 'agents-nomodel', { steps: [TOP], note: '没有可用模型：页头的提示条' }],
  ['agent-coder-codex', 'agents-coder-codex', { steps: [TOP], note: '编码 Agent 单独用 Codex：牌面「只认 N 项」（不点牌）' }],
  ['agent-coder-dsh', 'agents-coder-dsh', { steps: [TOP], note: '编码 Agent 单独用 DSH：牌面「不受此处限制」（不点牌）' }],
  ['chat-empty', 'chat-empty', {}],
  ['chat-streaming', 'chat-streaming', {}],
  ['chat-sticker', 'chat-sticker', {}],
  ['chat-landing', 'chat-landing', { note: '落蝶：她上一句是陈述句，用户回「谢谢」→ 气泡下挂线框蝶 + 「落蝶」+「让她回一句」' }],
  ['chat-storybox', 'chat-storybox', {}],
  ['chat-pills', 'chat-pills', {}],
  ['chat-folded', 'chat-folded', {}],
  ['chat-error', 'chat-error', {}],
  ['chat-crisis', 'chat-crisis', {}],
  ['chat-latenight', 'chat-latenight', { date: LATE }],
  ['chat-plain', 'chat-plain', { persona: false }],
  ['work-running', 'work-running', {}],
  ['work-approval-mid', 'work-approval-mid', {}],
  ['work-question', 'work-question', {}],
  ['work-laiddown', 'work-laiddown', {}],
  ['return-quiet', 'return-quiet', {}],
  ['settings-voice', 'settings-voice', { steps: ['scroll:.distance-cards'] }],
  ['avatar-crop', 'avatar-crop', { noWall: true, wait: 700, note: '头像三种尺寸 × 六个表情 + 完整龛，用来人看荆棘冠' }],
];

/** Agent 页三个宽度（夜昼各一张，中档）；1280×800 另加「点牌后牌背进入视口」与「运行中 / 接手」两张（页头她的那句在首屏）. */
const WIDTHS = [
  ['agent-default-1280', 'agents-idle', { width: 1280, height: 800 }],
  ['agent-default-1100', 'agents-idle', { width: 1100, height: 720 }],
  ['agent-default-960', 'agents-idle', { width: 960, height: 640 }],
  ['agent-busy-1280', 'agents-busy', { width: 1280, height: 800, note: '1280×800：她对这次运行的那句（页头第二个气泡）在首屏可见' }],
  ['agent-takeover-1280', 'agents-takeover', { width: 1280, height: 800, note: '1280×800：接手时页头她的那句在首屏可见' }],
  ['agent-back-1280', 'agents-back-coder-codex', { width: 1280, height: 800, steps: [PICK('coder')], note: '1280×800 的通过标准：四张牌文字不糊不截断；点牌后牌背完整进入视口' }],
];

function entry(prefix, fixture, theme, level, extra, wall) {
  const { steps = [], wait, persona = true, date, width, height, note } = extra;
  const e = { file: `${prefix}-${theme}-${level}${wall ? '' : '-nowall'}.png`, fixture, theme, level, persona, wallpaper: wall };
  if (steps.length) e.steps = steps;
  if (wait !== undefined) e.wait = wait;
  if (date) e.date = date;
  if (width) { e.width = width; e.height = height; }
  if (note) e.note = note;
  return e;
}

export function build() {
  const shots = [];
  for (const [prefix, fixture, extra] of CORE) for (const theme of THEMES) for (const level of LEVELS) shots.push(entry(prefix, fixture, theme, level, extra, true));
  for (const [prefix, fixture, extra] of OTHERS) for (const theme of THEMES) shots.push(entry(prefix, fixture, theme, 'm', extra, true));
  for (const [prefix, fixture, extra] of WIDTHS) for (const theme of THEMES) shots.push(entry(prefix, fixture, theme, 'm', extra, true));
  // -nowall：每个状态一张（中档）
  const nowall = [...CORE, ...OTHERS].filter(([prefix, , extra]) => !extra.noWall && !prefix.endsWith('-4s'));
  for (const [prefix, fixture, extra] of nowall) for (const theme of THEMES) shots.push(entry(prefix, fixture, theme, 'm', extra, false));
  return shots;
}

export function manifest() {
  const shots = build();
  return {
    version: 1,
    generatedBy: 'scripts/probe/manifest-gen.mjs',
    spec: 'docs/AGENT-VOICE-PLAN.md §7.4',
    defaults: { width: 1440, height: 900, wait: 900, date: '2026-10-27T16:20:00' },
    howTo: '被测副本用 --mode development 构建；node scripts/probe/run.mjs shots --app-dir <副本> [--only <正则>] [--resume]',
    counts: { core: CORE.length * THEMES.length * LEVELS.length, total: shots.length },
    shots,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const out = path.resolve(values.out ?? DEFAULT_OUT);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const m = manifest();
  fs.writeFileSync(out, `${JSON.stringify(m, null, 2)}\n`, 'utf8');
  process.stdout.write(`已写 ${out}：核心矩阵 ${m.counts.core} 张，共 ${m.counts.total} 张\n`);
}
