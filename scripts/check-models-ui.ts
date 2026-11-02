/* 模块检查（models · MB2 界面与实时列表）：npm run check:models-ui
   无 GUI、无网络、不花额度。覆盖 MODELS-SPEC §15.4 里归界面一侧的部分：
     T-UI   分组计数与页签 · 已接入置顶排序 · 搜索（别名、模型名、拼音、首字母）· 输入法组合期间不过滤 · 紧凑行与完整卡片的渲染 ·
            套餐端点下 API 页签禁用 · 模型选择器的分区与 100 行窗口 · 缺失服务的「（已删除）」占位 · 任务菜单精选与「更多…」 ·
            添加服务表单的校验与主进程逐项对表 · 页面偏好（localStorage）的容错
     T-LIST / T-CACHE 增补  同一服务的并发请求合并、失败后短时间不重复请求（解析器与缓存的主体在 check-services）
   浏览器里的交互（点击、输入法、焦点、截图）在 scripts/smoke/ui/models-ui.mjs（需要 Chrome 与 vite dev，不进 verify）。 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* ── 页面偏好要用 localStorage：先换成可控的替身（必须在 prefs.ts 第一次读取之前） ── */
const lsData = new Map<string, string>();
let lsBroken = false;
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => { if (lsBroken) throw new Error('blocked'); return lsData.get(k) ?? null; },
  setItem: (k: string, v: string) => { if (lsBroken) throw new Error('blocked'); lsData.set(k, String(v)); },
  removeItem: (k: string) => { lsData.delete(k); },
  clear: () => lsData.clear(), key: () => null, length: 0,
} as unknown as Storage;

import { allProviders, PROVIDER_BY_ID, hasProvider, readiness, type ProviderInfo } from '../src/lib/providers';
import { AGENT_DEFS, PRESET_SERVICES, serviceOf, setCustomServices, type ServiceDef } from '../src/lib/services';
import { initialModels } from '../src/state/models';
import { emptyState } from '../src/state/seed';
import { store } from '../src/state/store';
import type { ModelState } from '../src/lib/types';
import { MenuSelect, composedText, filterGroups, windowGroups, type MenuGroup } from '../src/components/ui/MenuSelect';
import { standaloneRecs } from '../src/state/agents';
import { STANDING_RANK, TAB_ORDER, buildBrowse, defaultTab, highlightParts, matchService, modelSummary, queryWords, standaloneAgents, statusOf } from '../src/components/views/models/browse';
import { ChoiceTabs } from '../src/components/views/models/ChoiceTabs';
import { EFFORT_KINDS, FORBIDDEN_BODY_KEYS, defToForm, emptyForm, emptyModelRow, formFieldOf, formToDef, parseExtraBody, previewGrade, urlInfo, validateForm, type EditorForm } from '../src/components/views/models/editor';
import { BACK_VALUE, MORE_PREFIX, curatedMenuGroups, moreEngine, moreMenuGroups, orderEngines } from '../src/components/views/models/menu';
import { agoText, buildPickerGroups, listStateText, pickerOption, type PickerModel } from '../src/components/views/models/ModelPicker';
import { hanChars, knowsHan, pinyinOf } from '../src/components/views/models/pinyin';
import { __resetPrefs, PREFS_KEY, getPrefs, noteRecent, sanitizePrefs, setPrefs } from '../src/components/views/models/prefs';
import { GradeBadges, ServiceTile, tileGrade } from '../src/components/views/models/ServiceTile';
import { ProviderCard } from '../src/components/views/models/ProviderCard';
import { ConnectedTile } from '../src/components/views/models/ConnectedTile';
import { cardStatus } from '../src/components/views/models/cardState';
import { EndpointField } from '../src/components/views/models/EndpointField';
import { withHonorTags } from '../src/components/views/config/ModelField';

/* eslint-disable @typescript-eslint/no-explicit-any */
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
const req = createRequire(path.resolve('package.json'));

const ids = (list: Array<{ p: ProviderInfo }>) => list.map((r) => r.p.id);
const P = (id: string) => PROVIDER_BY_ID[id];

/** A model state with some services set up the way a person's machine would be. */
function scenario(): ModelState {
  const m = initialModels();
  const key = (id: string, hint = '••••1234') => { m.providers[id].keyHint = hint; m.keyHints = { ...(m.keyHints ?? {}), [id]: hint }; };
  key('deepseek'); key('kimi'); key('openrouter');
  m.providers.kimi.test = { ok: true, at: 1, ms: 900, message: 'ok', auth: 'api' };
  m.providers.deepseek.test = { ok: true, at: 1, ms: 900, message: 'ok', auth: 'api' };
  // a key saved in a slot (the page's keyHint is per region) but the service is not usable: needs attention
  m.keyHints = { ...(m.keyHints ?? {}), 'qwen:global': '••••9999' };
  // a failed test
  m.providers.openrouter.test = { ok: false, at: 1, ms: 100, message: '密钥无效', auth: 'api' };
  // a command-line tool found and signed in
  m.providers.claude.auth = 'cli'; m.providers.claude.driver = 'claude-code';
  m.providers.claude.cli = { found: true, login: 'yes', at: 1 };
  m.defaultEngine = 'kimi';
  return m;
}

/* ═══════════════════════════ 拼音表 ═══════════════════════════ */

section('T-UI 拼音与首字母：目录里的每个汉字都有读音');
{
  const texts: string[] = [];
  for (const p of allProviders()) texts.push(p.name, p.vendor, ...p.aliases, ...p.models.map((x) => x.label ?? ''));
  for (const a of AGENT_DEFS) texts.push(a.label);
  const missing = hanChars(texts.join('')).filter((c) => !knowsHan(c));
  ok('服务名、厂商名、别名、模型名里的汉字，拼音表都收了（新增汉字时这里会失败，提醒补表）', missing.length === 0, missing.join(''));
  eq('通义千问', pinyinOf('通义千问'), { full: 'tongyiqianwen', initials: 'tyqw' });
  eq('ASCII 与汉字混着：MiniMax 稀宇', pinyinOf('MiniMax 稀宇'), { full: 'minimaxxiyu', initials: 'minimaxxy' });
  eq('表里没有的汉字原样保留（不丢、不崩）', pinyinOf('龘a'), { full: '龘a', initials: '龘a' });
}

/* ═══════════════════════════ 搜索 ═══════════════════════════ */

section('T-UI 搜索：别名、模型名、拼音、首字母；前缀优于子串');
{
  const all = allProviders();
  const hits = (q: string) => all.filter((p) => matchService(p, q)).map((p) => p.id);
  eq('qianwen → Qwen', hits('qianwen'), ['qwen']);
  eq('tongyi → Qwen', hits('tongyi'), ['qwen']);
  eq('首字母 tyqw → Qwen', hits('tyqw'), ['qwen']);
  eq('中文别名 通义 → Qwen', hits('通义'), ['qwen']);
  eq('doubao / 豆包 → 豆包', [hits('doubao'), hits('豆包')], [['doubao'], ['doubao']]);
  ok('深度求索 / shendu → DeepSeek', hits('深度求索').includes('deepseek') && hits('shendu').includes('deepseek'));
  ok('谷歌 / google / argon → Gemini', ['谷歌', 'google', 'argon'].every((q) => hits(q).includes('gemini')));
  ok('模型名：sonnet → Claude，并说明是模型匹配', matchService(P('claude'), 'sonnet')?.via?.startsWith('模型：') === true);
  ok('端点名：「国际」不会误匹配无关服务（地区只作最低档）', (matchService(P('gpt'), 'zzz') ?? null) === null);
  const gptFirst = all.map((p) => ({ id: p.id, s: matchService(p, 'gpt')?.score ?? 0 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
  ok('前缀优于子串：搜 gpt，GPT 排在第一', gptFirst[0]?.id === 'gpt', JSON.stringify(gptFirst.slice(0, 3)));
  ok('多个词要全部匹配', matchService(P('qwen'), 'qianwen 阿里') !== null && matchService(P('qwen'), 'qianwen openai') === null);
  ok('大小写与全角不敏感', matchService(P('claude'), 'ＣＬＡＵＤＥ') !== null && matchService(P('claude'), 'CLAUDE') !== null);
  ok('空查询：全部命中（分数 0）', all.every((p) => matchService(p, '   ')?.score === 0));
  eq('queryWords', queryWords('  Foo  bar '), ['foo', 'bar']);
  eq('高亮：只切文字，不生成 HTML', highlightParts('<b>Claude</b> Sonnet', 'son'), [{ text: '<b>Claude</b> ', hit: false }, { text: 'Son', hit: true }, { text: 'net', hit: false }]);
  eq('高亮：重叠的词合并', highlightParts('abcdef', 'abc cde'), [{ text: 'abcde', hit: true }, { text: 'f', hit: false }]);
  eq('高亮：没有词 / 没有命中就整段原样', [highlightParts('abc', ''), highlightParts('abc', 'x')], [[{ text: 'abc', hit: false }], [{ text: 'abc', hit: false }]]);
  ok('模型摘要：前两个预设模型，超过两个加省略号；没有预设的服务说明去哪里选', modelSummary(P('claude')).endsWith('…') && /拉取模型列表|本机/.test(modelSummary(P('groq'))) && /本机/.test(modelSummary(P('ollama'))));
}

/* ═══════════════════════════ 分组、计数、已接入置顶 ═══════════════════════════ */

section('T-UI 分组计数、页签与「已接入」置顶排序');
{
  const m = scenario();
  const providers = allProviders();
  const base = { providers, models: m, defaultProvider: 'kimi', showUnverified: false };
  const b = buildBrowse({ ...base, tab: 'all', query: '' });
  const visible = providers.filter((p) => !p.hidden);
  eq('页签顺序', TAB_ORDER, ['connected', 'all', 'intl', 'cn', 'hub', 'local', 'cli']);
  eq('计数不含 hidden 预设：全部 = 可见服务 + 独立命令行代理', b.counts.all, visible.length + standaloneAgents().length);
  eq('各组计数 = 该组可见服务数；命令行 = 独立代理数', [b.counts.intl, b.counts.cn, b.counts.hub, b.counts.local, b.counts.cli], [7, 11, 13, 6, standaloneAgents().length]);
  eq('目录的预设数：39 个，其中 2 个默认隐藏（vercel、dmr）', [PRESET_SERVICES.length, PRESET_SERVICES.filter((s) => s.hidden).length], [39, 2]);
  // 已接入：默认引擎 → 已连通 → 已配置 → 需要处理
  const order = b.connected.map((r) => `${r.p.id}:${r.status.standing}`);
  eq('已接入的排序：默认(kimi) → 已连通(deepseek) → 已配置(claude 命令行已登录) → 需要处理(qwen 只存了密钥、openrouter 测试失败；同档按目录顺序)', order, ['kimi:default', 'deepseek:ok', 'claude:ready', 'qwen:attention', 'openrouter:attention']);
  eq('counts.connected 与区块一致', b.counts.connected, b.connected.length);
  ok('排序是稳定的：同档按目录顺序', STANDING_RANK.default < STANDING_RANK.ok && STANDING_RANK.ok < STANDING_RANK.ready && STANDING_RANK.ready < STANDING_RANK.attention);
  const inGroups = new Set(b.groups.flatMap((g) => ids(g.rows)));
  ok('已接入的服务在它自己的分组里不再重复出现', b.connected.every((r) => !inGroups.has(r.p.id)) && b.groups.flatMap((g) => g.rows).every((r) => !r.status.connected));
  eq('分组里的紧凑行数 = 可见服务 − 已接入', [...inGroups].length, visible.length - b.connected.length);
  eq('默认页签：有已接入就是已接入，没有就是全部', [defaultTab(b), defaultTab({ counts: { ...b.counts, connected: 0 } })], ['connected', 'all']);
  // 页签是一个分组时：该组已接入的在上面单列，其余是行
  const intl = buildBrowse({ ...base, tab: 'intl', query: '' });
  eq('国际页签：已接入的那一个（Claude）单列，其余是行', [ids(intl.groups.find((g) => g.group === 'intl')!.connectedHere), intl.groups.find((g) => g.group === 'intl')!.rows.length], [['claude'], 6]);
  // 搜索看全部，不看页签
  const q = buildBrowse({ ...base, tab: 'cn', query: 'google' });
  eq('有搜索词：不受页签限制（看全部）', [q.tab, q.matches, ids(q.groups.flatMap((g) => g.rows))], ['all', 1, ['gemini']]);
  eq('搜索里已接入的命中也在已接入区块', ids(buildBrowse({ ...base, tab: 'all', query: 'deepseek' }).connected), ['deepseek']);
  // 未核实的预设
  const hiddenHit = buildBrowse({ ...base, tab: 'all', query: 'vercel' });
  eq('隐藏预设命中：不显示，但报「另有 N 个未核实的预设匹配」', [hiddenHit.matches, hiddenHit.hiddenMatches], [0, 1]);
  const shownHit = buildBrowse({ ...base, tab: 'all', query: 'vercel', showUnverified: true });
  eq('打开「显示未核实的预设」后它出现，计数跟着变', [shownHit.matches, shownHit.hiddenMatches, shownHit.counts.hub, buildBrowse({ ...base, tab: 'all', query: '', showUnverified: true }).counts.all], [1, 0, 14, b.counts.all + 2]);
  // 打开的服务留在原处
  const g1 = buildBrowse({ ...base, tab: 'all', query: '', keepInPlace: { id: 'qwen', wasConnected: false } });
  ok('打开着的、打开时没接入的服务：就算中途接入了，仍待在它的分组行里（页面不在手下跳）', ids(g1.groups.flatMap((g) => g.rows)).includes('qwen') && !ids(g1.connected).includes('qwen'));
  const g2 = buildBrowse({ ...base, tab: 'all', query: '', keepInPlace: { id: 'gpt', wasConnected: true } });
  ok('新保存的服务（wasConnected）：直接在已接入里', ids(g2.connected).includes('gpt'));
  // 状态判定
  eq('statusOf：没有任何配置的服务不算已接入', [statusOf(P('gpt'), m, 'kimi').connected, statusOf(P('gpt'), m, 'kimi').standing], [false, undefined]);
  eq('statusOf：只存了密钥（别的地区的槽）但还不能用 → 需要处理', [statusOf(P('qwen'), m, 'kimi').connected, statusOf(P('qwen'), m, 'kimi').standing, statusOf(P('qwen'), m, 'kimi').ready], [true, 'attention', false]);
  eq('statusOf：命令行已找到', statusOf(P('claude'), m, 'kimi').cliFound, true);
  // 没有命令行工具的服务：永远是 API 方式
  eq('没有命令行工具的服务（Together）：显示的方式恒为 api', statusOf(P('together'), { ...m, providers: { ...m.providers, together: { ...m.providers.together, auth: 'cli' } } }, undefined).auth, 'api');
  // 本机服务：不需要密钥，选了模型就就绪
  const m2 = scenario();
  m2.providers.ollama.model = 'qwen3:32b';
  ok('keyOptional 的本机服务：选了模型就就绪、算已接入', readiness(P('ollama'), m2.providers.ollama, 'api').ready && statusOf(P('ollama'), m2, undefined).connected);
}

/* ═══════════════════════════ 下拉：过滤、窗口、输入法 ═══════════════════════════ */

section('T-UI 下拉菜单：过滤、100 行窗口、输入法组合期间不过滤');
{
  const mk = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ value: `${prefix}-${i}`, label: `${prefix} 模型 ${i}`, sub: `${prefix}/m${i}` }));
  const groups: MenuGroup[] = [{ label: '置顶', options: mk(2, 'pin') }, { label: '实时', options: mk(498, 'live') }];
  const w = windowGroups(groups, 100);
  eq('500 项只渲染 100 行：先放满前面的分区', [w.groups.flatMap((g) => g.options).length, w.hidden, w.groups.map((g) => g.options.length)], [100, 400, [2, 98]]);
  eq('不超过上限：原样返回', windowGroups(groups, 600).hidden, 0);
  eq('没有上限：原样返回', windowGroups(groups, undefined).groups, groups);
  const f = filterGroups(groups, 'live 模型 49');
  eq('过滤：每个词都要出现（label / sub / meta / keywords / 标签 / 分组名）：49、149…449、490–497 共 13 项', f.flatMap((g) => g.options).filter((o) => /^live 模型 \d+$/.test(o.label) && /49/.test(o.label)).length, 13);
  eq('过滤：空查询原样；没有命中的分区消失', [filterGroups(groups, '  ') === groups, filterGroups(groups, 'zzzz').length], [true, 0]);
  eq('过滤匹配 keywords 与标签文字', filterGroups([{ options: [{ value: 'a', label: 'A', keywords: '别名甲', tags: [{ text: '预览' }] }] }], '别名甲').length + filterGroups([{ options: [{ value: 'a', label: 'A', tags: [{ text: '预览' }] }] }], '预览').length, 2);
  eq('过滤 + 窗口：搜出来的结果同样受 100 行限制', windowGroups(filterGroups(groups, 'live'), 100).hidden, 398);

  const commits: string[] = [];
  const drafts: string[] = [];
  const t = composedText((v) => commits.push(v), (v) => drafts.push(v));
  t.change('t');
  t.start();
  t.change('to', true);
  t.change('tong', true);
  eq('组合期间：只更新草稿，不提交过滤', [commits, drafts], [['t'], ['t', 'to', 'tong']]);
  ok('组合期间 composing 为真', t.composing === true);
  t.end('通');
  eq('compositionend：提交', [commits, t.composing], [['t', '通'], false]);
  t.change('通义', false);
  eq('组合结束后的普通输入：立刻提交', commits, ['t', '通', '通义']);
  // 个别浏览器：input 事件带 isComposing 标记但没有 compositionstart
  const c2: string[] = [];
  const t2 = composedText((v) => c2.push(v));
  t2.change('x', true);
  t2.end('xy');
  eq('只有 isComposing 标记也不提交，直到 compositionend', c2, ['xy']);
  ok('MenuSelect 导出 useComposedText 给搜索框用', typeof MenuSelect === 'function');
}

/* ═══════════════════════════ 页面偏好 ═══════════════════════════ */

section('T-UI 页面偏好（localStorage）：校验、最近用过、存储不可用也不崩');
{
  const bad = sanitizePrefs({ tab: 'evil', collapsed: { '../x': true, cn: true, hub: 'yes' }, showUnverified: 'no', autoRefresh: false, recentEngines: [1, 'a:api', '', 'b:cli'], recentModels: { 'a:api': ['m1', 2, 'm2'], '': 'x' } });
  eq('乱七八糟的存档：未知页签、非法键、错类型都被丢掉或换成默认', bad, { collapsed: { cn: true }, showUnverified: false, autoRefresh: false, recentEngines: ['a:api', 'b:cli'], recentModels: { 'a:api': ['m1', 'm2'], '': [] } });
  eq('不是对象：全默认', sanitizePrefs('x'), { collapsed: {}, showUnverified: false, autoRefresh: true, recentEngines: [], recentModels: {} });
  lsData.clear(); __resetPrefs();
  noteRecent('a:api', 'm1'); noteRecent('b:api', 'm2'); noteRecent('a:api', 'm3'); noteRecent('a:api', 'm1');
  eq('最近用过：最近的在前，同一个只留一份', [getPrefs().recentEngines, getPrefs().recentModels['a:api']], [['a:api', 'b:api'], ['m1', 'm3']]);
  for (let i = 0; i < 20; i++) noteRecent(`e${i}:api`, `m${i}`);
  eq('引擎最多记 8 个', getPrefs().recentEngines.length, 8);
  for (let i = 0; i < 20; i++) noteRecent('x:api', `mm${i}`);
  eq('每个引擎的模型最多记 8 个', getPrefs().recentModels['x:api'].length, 8);
  noteRecent('cli:codex', '');
  ok('命令行「默认模型」（空 id）只挪引擎，不记模型', getPrefs().recentEngines[0] === 'cli:codex' && !getPrefs().recentModels['cli:codex']);
  setPrefs({ tab: 'cn', collapsed: { local: true } });
  ok('写进 localStorage 的 alight/models-ui，读回来一致', JSON.parse(lsData.get(PREFS_KEY) ?? '{}').tab === 'cn');
  __resetPrefs();
  eq('重新读取：偏好还在', [getPrefs().tab, getPrefs().collapsed], ['cn', { local: true }]);
  lsBroken = true; __resetPrefs();
  let threw = false;
  try { getPrefs(); setPrefs({ showUnverified: true }); noteRecent('z:api', 'm'); } catch { threw = true; }
  ok('localStorage 读写抛错（无痕窗口、存储被禁）：不崩，用默认值与内存里的值', !threw && getPrefs().showUnverified === true);
  lsBroken = false; lsData.clear(); __resetPrefs();
}

/* ═══════════════════════════ 模型选择器 ═══════════════════════════ */

section('T-UI 模型选择器：分区、置顶、当前值、标签、状态行');
{
  const models: PickerModel[] = [
    { id: 'p1', label: '预设一', ctx: 1_000_000, source: 'preset', status: 'preview' }, { id: 'p2', source: 'preset', unlisted: true }, { id: 'p3', source: 'preset', status: 'retiring', retiresAt: '2026-12-01' },
    { id: 'l1', label: 'Live One', ctx: 200_000, source: 'live', caps: { vision: true, tools: true } }, { id: 'l2', source: 'live' }, { id: 'l3', source: 'live' },
  ];
  const labels = (g: MenuGroup[]) => g.map((x) => x.label);
  const toggles: Array<[string, boolean]> = [];
  const g = buildPickerGroups(models, { value: 'typed-id', pinned: ['l2', 'p1', 'gone'], onPin: (id, on) => toggles.push([id, on]) });
  eq('分区顺序：置顶 → 当前 → 预设 → 实时', labels(g), ['置顶', '当前', '预设', '实时 · 2']);
  eq('置顶按置顶的顺序，不在列表里的丢掉；一个模型只出现一次', [g[0].options.map((o) => o.value), g.flatMap((x) => x.options).map((o) => o.value).sort()], [['l2', 'p1'], ['l1', 'l2', 'l3', 'p1', 'p2', 'p3', 'typed-id']]);
  eq('当前值不在列表里（手填的）：照样显示在「当前」', g[1].options.map((o) => o.value), ['typed-id']);
  g[0].options[0].star?.onToggle();
  eq('★ 切换：已置顶的取消，调用方收到 (id, on)', toggles, [['l2', false]]);
  const live1 = g[3].options.find((o) => o.value === 'l1')!;
  eq('实时区的行：上下文缩写、标签（支持图片、工具），区里不再写「实时」', [live1.meta, live1.tags?.map((t) => t.text)], ['200K', ['支持图片', '工具']]);
  eq('置顶区里的实时模型带「实时」标', g[0].options[0].tags?.map((t) => t.text), ['实时']);
  const p1 = g[0].options.find((o) => o.value === 'p1')!;
  eq('预设：显示名为主、id 为副行；1M 缩写；预览标', [p1.label, p1.sub, p1.meta, p1.tags?.map((t) => t.text)], ['预设一', 'p1', '1M', ['预览']]);
  eq('此账号列表里没有 / 将下线', [pickerOption(models[1]).tags?.map((t) => t.text), pickerOption(models[2]).tags?.map((t) => t.text), pickerOption(models[2]).tags?.[0].title], [['此账号列表里没有'], ['将下线'], '预计 2026-12-01 下线']);
  eq('没有 onPin：没有 ★', buildPickerGroups(models, { value: '' }).flatMap((x) => x.options).some((o) => o.star), false);
  eq('分区只在有内容时出现', labels(buildPickerGroups([], { value: '' })), []);
  // 状态行
  const now = 1_800_000_000_000;
  eq('agoText', [agoText(now - 5_000, now), agoText(now - 6 * 60_000, now), agoText(now - 3 * 3600_000, now), agoText(now - 2 * 86400_000, now)], ['刚刚', '6 分钟前', '3 小时前', '2 天前']);
  eq('状态行：实时', listStateText({ at: now - 360_000, source: 'live' }, false, now), { text: '实时 · 6 分钟前', tone: 'ok' });
  eq('状态行：缓存 / 已过期', [listStateText({ at: now - 60_000, source: 'cache' }, false, now).text, listStateText({ at: now - 60_000, source: 'cache', stale: true }, false, now).text], ['缓存 · 1 分钟前', '缓存 · 1 分钟前，已过期']);
  eq('状态行：失败带原因，有缓存就说先用缓存', [listStateText({ at: now, source: 'static', error: '密钥无效', code: 'AUTH' }, false, now).text, listStateText({ at: now, source: 'cache', error: '服务端出错', code: 'SERVER' }, false, now).text], ['实时列表拉取失败：密钥无效', '实时列表拉取失败：服务端出错 · 先用缓存']);
  eq('状态行：没密钥 / 套餐 / 没有列表接口 / 拉取中 / 从没拉过', [
    listStateText({ at: now, source: 'static', error: 'x', code: 'NO_KEY' }, false, now).text, listStateText({ at: now, source: 'static', error: 'x', code: 'PLAN_KEY' }, false, now).text, listStateText({ at: now, source: 'static', error: 'x', code: 'NO_LIST' }, false, now).text,
    listStateText(undefined, true, now).text, listStateText(undefined, false, now).text,
  ], ['保存密钥后可以拉取模型列表', '套餐通道不能拉取列表，请手动填写模型 ID', '这个服务没有模型列表接口，请手动填写模型 ID', '正在拉取模型列表…', '还没有拉取过实时列表']);
  ok('取回来的名字当纯文本：标签与名字里的 HTML 不被解释', renderToStaticMarkup(createElement(GradeBadges, { grade: tileGrade(P('claude')), showAll: true })).includes('<span') && !renderToStaticMarkup(createElement(GradeBadges, { grade: { chat: true, tune: false, work: 'no', why: { work: '<img src=x onerror=alert(1)>' } } })).includes('<img'));
}

/* ═══════════════════════════ 任务菜单精选 ═══════════════════════════ */

section('T-UI 任务菜单（§14.7）：默认引擎 → 最近用过 → 其余；每个引擎只放精选，末尾「更多…」');
{
  const m = scenario();
  m.providers.deepseek.test = undefined;
  m.defaultEngine = 'deepseek';
  m.pinned = { openrouter: ['p/a', 'p/b'] };
  m.liveApi = { openrouter: Array.from({ length: 300 }, (_, i) => ({ id: `lab/model-${i}`, source: 'live' as const })), kimi: [] };
  m.providers.openrouter.model = 'lab/model-7';
  m.providers.openrouter.test = undefined;
  const prefs = { recentEngines: ['openrouter:api', 'kimi:api'], recentModels: { 'openrouter:api': ['lab/model-9', 'lab/model-8', 'lab/model-7', 'lab/model-6', 'lab/model-5', 'lab/model-4', 'lab/model-3', 'lab/model-2'] } };
  const groups = curatedMenuGroups(m, prefs, { key: 'kimi:api', model: 'kimi-k3' });
  eq('引擎顺序：默认(DeepSeek) → 最近用过的(OpenRouter、Kimi) → 其余(Claude Code)', groups.map((x) => x.label?.split(' · ')[0]), ['DeepSeek', 'OpenRouter', 'Kimi', 'Claude']);
  const or = groups[1].options;
  ok('OpenRouter 的 300 个实时模型不灌进菜单：精选 + 最近 + 当前配置，最多一屏', or.length <= 10, `${or.length}`);
  ok('最近用过的模型最多 6 个', or.filter((o) => /lab\/model-\d/.test(o.value)).length <= 7);
  ok('末尾是「更多…」，keepOpen，带总数', or[or.length - 1].value === `${MORE_PREFIX}openrouter:api` && or[or.length - 1].keepOpen === true && /^3\d\d 个模型/.test(or[or.length - 1].sub ?? ''), JSON.stringify(or[or.length - 1]));
  ok('当前选中的（Kimi 的 kimi-k3）一定在它那组里', groups[2].options.some((o) => o.value === 'kimi:api|kimi-k3'));
  ok('每个选项值是 引擎|模型', groups.flatMap((x) => x.options).filter((o) => !o.keepOpen).every((o) => /^[a-z_0-9]+:(api|cli)\|/.test(o.value)));
  ok('模型很少的引擎（DeepSeek 2 个）：精选已含配置的那个，另一个由「更多…」给', groups[0].options.some((o) => o.value === 'deepseek:api|deepseek-flash'));
  const more = moreMenuGroups(m, 'openrouter:api');
  eq('「更多…」视图：先是「返回精选」，再是这个引擎的全部模型', [more[0].options[0].value, more[0].options[0].keepOpen, more[1].options.length > 300 - 1], [BACK_VALUE, true, true]);
  eq('moreEngine 只认「更多…」的值', [moreEngine(`${MORE_PREFIX}a:api`), moreEngine('a:api|x'), moreEngine(BACK_VALUE)], ['a:api', undefined, undefined]);
  eq('不存在的引擎：空', moreMenuGroups(m, 'nope:api'), []);
  const choices = [{ key: 'a:api' }, { key: 'b:api' }, { key: 'c:api' }, { key: 'd:api' }] as any[];
  eq('orderEngines：默认在前、最近的次之（忽略不在的）、其余按原顺序', orderEngines(choices, 'c:api', ['d:api', 'zzz', 'c:api']).map((c) => c.key), ['c:api', 'd:api', 'a:api', 'b:api']);
  // 命令行引擎：「默认（… 自己选）」排头
  const m3 = scenario();
  const cli = curatedMenuGroups(m3, { recentEngines: [], recentModels: {} }).find((g) => /Claude/.test(g.label ?? '') && /Claude Code/.test(g.label ?? ''));
  ok('命令行引擎：「默认（工具自己选）」在最前', !!cli && /默认/.test(cli.options[0].label) && cli.options[0].value.endsWith('|'), JSON.stringify(cli?.options[0]));
}

/* ═══════════════════════════ Agent 页的模型菜单：遵守小标 ═══════════════════════════ */

section('T-UI Agent 页模型菜单：每个选项右侧带「这个引擎怎么遵守档位」的小标（施工图 §4.3-4）');
{
  const m = scenario();
  m.providers.kimi.driver = 'kimi';
  const groups = withHonorTags(curatedMenuGroups(m, { recentEngines: [], recentModels: {} }), m);
  const rows = groups.flatMap((g) => g.options.filter((o) => !o.keepOpen).map((o) => ({ key: o.value.split('|')[0], tags: (o.tags ?? []).map((t) => t.text) })));
  ok('Claude Code（命令行）的选项带「逐项遵守」', rows.filter((r) => r.key === 'claude:cli').length > 0 && rows.filter((r) => r.key === 'claude:cli').every((r) => r.tags.includes('逐项遵守')));
  ok('API 方式的选项带「无工具」', rows.filter((r) => r.key.endsWith(':api')).length > 0 && rows.filter((r) => r.key.endsWith(':api')).every((r) => r.tags.includes('无工具')));
  ok('「更多…」行（keepOpen）与「跟随任务」行不加小标', groups.flatMap((g) => g.options).filter((o) => o.keepOpen || !o.value.includes(':')).every((o) => !(o.tags ?? []).some((t) => /遵守|无工具|不受限|试了才拦|只认/.test(t.text))));
  const before = JSON.stringify(curatedMenuGroups(m, { recentEngines: [], recentModels: {} }));
  withHonorTags(curatedMenuGroups(m, { recentEngines: [], recentModels: {} }), m);
  ok('只加标签、不改原菜单（纯函数，原来的分组不被改动）', before === JSON.stringify(curatedMenuGroups(m, { recentEngines: [], recentModels: {} })));
}

/* ═══════════════════════════ 缺失服务的占位 ═══════════════════════════ */

section('T-UI 缺失服务：「（已删除）」占位，任务不崩');
{
  const gone = serviceOf('x_vanished');
  eq('serviceOf：缺失的服务返回占位', [gone.name, gone.vendor, gone.endpoints.length, gone.drivers], ['（已删除）', '（已删除）', 0, []]);
  eq('PROVIDER_BY_ID 对缺失的 id 不返回 undefined（页面里 .name 不会崩）', [P('x_vanished').name, P('x_vanished').regions.length, hasProvider('x_vanished')], ['（已删除）', 1, false]);
  eq('已删除的服务：模型摘要、容量、标签都能算', [modelSummary(P('x_vanished')), P('x_vanished').keyOptional, tileGrade(P('x_vanished')).chat], ['先拉取模型列表，或输入模型 ID', false, false]);
  // 自定义服务进出
  const custom: ServiceDef = { id: 'x_t1', kind: 'custom', name: '我的中转站', vendor: '自定义', glyph: '我', group: 'hub', protocol: 'openai-chat', endpoints: [{ id: 'main', label: '服务', kind: 'payg', baseUrl: 'https://api.example.com/v1' }], auth: { scheme: 'bearer' }, models: [{ id: 'm1' }], drivers: [], keyHelp: '', verified: '2026-10-24' };
  setCustomServices([custom]);
  ok('自定义服务加入后：出现在 allProviders，名字拼音也能搜到（wodezhongzhuan / wdzz）', allProviders().some((p) => p.id === 'x_t1') && !!matchService(P('x_t1'), 'wodezhongzhuan') && !!matchService(P('x_t1'), 'wdzz'));
  eq('自定义服务排在它那组的末尾', allProviders().filter((p) => p.group === 'hub').map((p) => p.id).slice(-1), ['x_t1']);
  setCustomServices([]);
  ok('删除后：回到占位', P('x_t1').name === '（已删除）' && !hasProvider('x_t1'));
}

/* ═══════════════════════════ 渲染：紧凑行、完整卡片、页签 ═══════════════════════════ */

section('T-UI 渲染：紧凑行与完整卡片（服务端渲染，不需要 DOM）');
{
  const m = scenario();
  store.init(emptyState(Date.now()));
  store.update((d) => { d.models = m as any; });
  const html = (el: any) => renderToStaticMarkup(el);
  const text = (s: string) => s.replace(/<[^>]+>/g, '');
  /** the <input> tag of the radio with this value (attribute order is React's business) */
  const radio = (s: string, value: string) => (new RegExp(`<input[^>]*value="${value}"[^>]*>`).exec(s) ?? [''])[0];
  const tile = html(createElement(ServiceTile, { row: { p: P('gemini'), status: statusOf(P('gemini'), m, undefined) }, query: 'gem', onOpen: () => {} }));
  ok('紧凑行是一个 button，aria-expanded=false，带名称、厂商、模型摘要、三枚小标、「接入」', /<button[^>]*aria-expanded="false"/.test(tile) && /Gemini/.test(text(tile)) && /Google/.test(tile) && /Argon/.test(text(tile)) && /接入/.test(tile), tile.slice(0, 700));
  // 一行只说例外：能力齐全的服务不挂「聊天 / 强度 / 干活」三枚小标（每行都挂着，真正缺的那一项反而被淹没）
  ok('紧凑行只显示例外：Gemini 能力齐全 → 没有小标；打开的完整卡片才列全三项（聊天 / 强度 / 干活）', !/class="grade /.test(tile) && ['聊天', '强度', '干活'].every((w) => renderToStaticMarkup(createElement(GradeBadges, { grade: tileGrade(P('gemini')), showAll: true })).includes(w)));
  ok('「调参」改名「强度」（调参读作调超参数）', !/调参/.test(renderToStaticMarkup(createElement(GradeBadges, { grade: { chat: true, tune: false, work: 'no', why: {} }, showAll: true }))) && /强度/.test(renderToStaticMarkup(createElement(GradeBadges, { grade: { chat: true, tune: false, work: 'no', why: {} } }))));
  ok('搜索词在名字里被 <mark> 标出（纯文本切片）', /<mark class="svc-mark">Gem<\/mark>/.test(tile));
  ok('未核实的预设：一个中性的小问号（不是琥珀色徽章），悬停列出具体哪几点，读屏有文字', /class="svc-unverified"/.test(tile) && /aria-label="有几项还没有逐项核实"/.test(tile) && /title="还没有逐项核实/.test(tile) && !/badge--warning/.test(tile));
  {
    const cohere = html(createElement(ServiceTile, { row: { p: P('cohere'), status: statusOf(P('cohere'), m, undefined) }, query: '', onOpen: () => {} }));
    ok('不能用的小标灰显并说明（Cohere 没有命令行：干活），而且只有这一枚', /is-off/.test(cohere) && /干活/.test(cohere) && !/>聊天</.test(cohere));
  }
  // 「已接入」不再一律摊成完整配置卡：一行摘要（徽记 · 名称 · 模型与强度 · 状态 · 测试 · 展开）
  {
    const ct = html(createElement(ConnectedTile, { info: P('deepseek'), disabled: false, onOpen: () => {} }));
    ok('已接入的紧凑行：一个按钮（aria-expanded=false）+ 名称 + 当前模型 + 强度 + 状态 + 测试；不用 svc-tile 这个类（那是没接入的行）',
      /class="conn-tile conn-tile--/.test(ct) && /data-service="deepseek"/.test(ct) && /<button[^>]*class="conn-tile__main"[^>]*aria-expanded="false"/.test(ct) && /DeepSeek/.test(text(ct)) && /强度/.test(text(ct)) && /测试/.test(text(ct)) && !/svc-tile/.test(ct) && !/model-card/.test(ct), ct.slice(0, 500));
    const st = cardStatus(P('deepseek'), m.providers.deepseek);
    ok('状态由 cardStatus 给（卡片头部与紧凑行共用）：有密钥有模型 → 已配置 / 已连通', st.auth === 'api' && st.ready.ready && ['已配置', '已连通'].includes(st.stateText), JSON.stringify(st));
    const noKey = cardStatus(P('gemini'), m.providers.gemini);
    ok('没接好的服务：未接入，说明原因', !noKey.ready.ready && noKey.stateText === '未接入' && !!noKey.ready.reason);
    // 有密钥却用不了的服务（套餐地区只能走命令行）：状态是 off，原因进悬停——紧凑行把它标成琥珀色「待处理」，颜色只留给要动手处理的事
    const plan = cardStatus(P('kimi'), { ...m.providers.kimi, region: 'code', auth: 'api' });
    ok('套餐地区 + API：状态 off，原因说明只能用命令行', plan.state === 'off' && /套餐/.test(plan.ready.reason ?? ''), JSON.stringify(plan));
    ok('能用的服务，紧凑行的状态不是警示色', /badge--(info|success)/.test(ct) && !/badge--warning/.test(ct), ct.slice(0, 600));
  }
  // 服务地区：3 个以内且标签短才用单选组；Kimi（4 个、标签很长）改下拉，不再折成不规则的两行
  {
    const kimi = html(createElement(EndpointField, { info: P('kimi'), cfg: m.providers.kimi, disabled: false }));
    ok('Kimi 的服务地区是下拉（4 个选项 / 长标签），不是分段控件', /aria-haspopup="listbox"/.test(kimi) && !/role="radiogroup"/.test(kimi), kimi.slice(0, 300));
    const two = html(createElement(EndpointField, { info: P('deepseek'), cfg: m.providers.deepseek, disabled: false }));
    ok('只有一个地区的服务不出这个字段', two === '');
    const gl = html(createElement(EndpointField, { info: P('glm'), cfg: m.providers.glm, disabled: false }));
    ok('GLM（4 个地区）也是下拉', /aria-haspopup="listbox"/.test(gl));
  }
  // 全部可见服务的紧凑行与卡片都能渲染
  let renderErrors = 0;
  for (const p of allProviders()) {
    try { html(createElement(ServiceTile, { row: { p, status: statusOf(p, m, undefined) }, query: '', onOpen: () => {} })); html(createElement(ProviderCard, { info: p, disabled: false })); } catch (e) { renderErrors += 1; console.error(`    ${p.id}: ${(e as Error).message}`); }
  }
  eq('每一家（含隐藏的预设）的紧凑行与完整卡片都能渲染', renderErrors, 0);

  const card = (id: string, patch?: (c: any) => void) => {
    store.update((d) => { patch?.((d.models as any).providers[id]); });
    return html(createElement(ProviderCard, { info: P(id), disabled: false }));
  };
  // 旧八家：体验不变（两个页签、API 密钥窗格里有密钥、模型、推理强度）
  const ds = card('deepseek');
  ok('旧八家（DeepSeek）：命令行登录 / API 密钥两个页签、密钥、模型、推理强度、测试连接', /命令行登录/.test(ds) && /API 密钥/.test(ds) && /已保存/.test(ds) && /模型/.test(ds) && /推理强度/.test(ds) && /测试连接/.test(ds));
  ok('卡片头：默认标、核实日期；DeepSeek 没有未核实点', /核实于 10-24/.test(ds) && !/未核实/.test(ds));
  // 套餐端点：API 页签禁用
  store.update((d) => { (d.models as any).providers.kimi.auth = 'api'; (d.models as any).providers.kimi.region = 'code'; });
  const kimiPlan = html(createElement(ProviderCard, { info: P('kimi'), disabled: false }));
  ok('套餐端点：「API 密钥」页签 disabled，写明「套餐 Key 只能给命令行编码工具用」', /disabled=""/.test(radio(kimiPlan, 'api')) && /套餐 Key 只能给命令行编码工具用/.test(kimiPlan) && /改用命令行方式/.test(kimiPlan), (/<input[^>]*value="api"[^>]*>/.exec(kimiPlan) ?? [''])[0]);
  ok('套餐端点：头部有「套餐」标', /<span class="badge badge--neutral"[^>]*>套餐<\/span>/.test(kimiPlan));
  store.update((d) => { (d.models as any).providers.kimi.region = 'cn'; });
  ok('按量端点：API 页签可用', !/disabled=""/.test(radio(card('kimi'), 'api')));
  // 没有命令行工具的服务：没有「命令行登录」页签
  const together = card('together');
  ok('没有命令行工具的服务（Together）：不出现「命令行登录」页签', !/命令行登录/.test(together) && /API 密钥/.test(together));
  // 占位符
  store.update((d) => { (d.models as any).providers.azure.region = 'openai'; });
  const az = html(createElement(ProviderCard, { info: P('azure'), disabled: false }));
  ok('带占位符的端点（Azure）：出现「资源名」输入框，带例子', /资源名/.test(az) && /例如 my-resource/.test(az));
  store.update((d) => { (d.models as any).providers.azure.params = { resource: 'Bad.Name' }; });
  ok('占位符不合 pattern：行内提示「格式不对」', /格式不对/.test(html(createElement(ProviderCard, { info: P('azure'), disabled: false }))));
  store.update((d) => { (d.models as any).providers.azure.params = { resource: 'my-resource' }; });
  ok('占位符合格：没有格式提示', !/格式不对/.test(html(createElement(ProviderCard, { info: P('azure'), disabled: false }))));
  // 本机服务：可空密钥与上下文警告
  store.update((d) => { (d.models as any).providers.ollama.model = 'qwen3:32b'; });
  const ol = html(createElement(ProviderCard, { info: P('ollama'), disabled: false }));
  ok('本机服务（Ollama）：密钥「可不填」', /密钥（可不填）/.test(ol));
  ok('本机服务：上下文只有 4K 的警告，带 OLLAMA_CONTEXT_LENGTH', /上下文只有 4K，做 Agent 至少要 32K/.test(ol) && /OLLAMA_CONTEXT_LENGTH/.test(ol));
  ok('没有密钥页面的服务，链接写「官方文档」', /官方文档/.test(ol) && !/去获取密钥/.test(ol));
  ok('卡片头有「本机」之类的事实，且 Ollama 是已就绪', /已配置/.test(ol));
  // 推理强度第一项：默认（最高）
  const kimiCard = card('kimi', (c) => { c.model = 'kimi-k3.1-pro'; });
  ok('推理强度：第一项写真实默认档（Kimi k3 默认最高）', /默认（最高）/.test(kimiCard));
  // 自定义服务：编辑 / 删除
  setCustomServices([{ id: 'x_card', kind: 'custom', name: '卡片测试', vendor: '自定义', glyph: '卡', group: 'hub', protocol: 'openai-chat', endpoints: [{ id: 'main', label: '服务', kind: 'payg', baseUrl: 'https://api.example.com/v1' }], auth: { scheme: 'bearer' }, models: [{ id: 'm1' }], drivers: [], keyHelp: '自定义服务', verified: '2026-10-24' }]);
  store.update((d) => { (d.models as any).providers.x_card = { id: 'x_card', auth: 'api', driver: 'claude-compat', region: 'main', baseUrl: '', model: 'm1', cliModel: '', cliPath: '' }; });
  const cu = html(createElement(ProviderCard, { info: P('x_card'), disabled: false }));
  ok('自定义服务：有「这是你添加的服务」与编辑、删除；没有预设才有的「恢复默认地址」', /这是你添加的服务/.test(cu) && /编辑/.test(cu) && /删除/.test(cu) && !/恢复默认地址/.test(cu));
  setCustomServices([]);
  // 页签组件
  const tabs = html(createElement(ChoiceTabs as any, { label: '分组', value: 'all', onChange: () => {}, options: [{ value: 'connected', label: '已接入', count: 4 }, { value: 'all', label: '全部', count: 49 }, { value: 'x', label: '禁用', disabled: true, hint: '原因' }] }));
  ok('分组页签：单选组，带计数，禁用项 disabled 并有说明文字给读屏', /role="radiogroup"/.test(tabs) && /<small class="segmented__count">49<\/small>/.test(tabs) && /disabled=""/.test(radio(tabs, 'x')) && /：原因/.test(tabs), tabs.slice(0, 900));
  // 能力小标
  const gb = html(createElement(GradeBadges, { grade: tileGrade(P('openrouter')) }));
  ok('OpenRouter（只有 OpenAI 协议 + 聚合站的 Anthropic 兼容端点，厂商没有官方支持）：干活（实验）', /干活（实验）/.test(gb), gb);
  eq('standaloneAgents 与页面状态里的代理一致（预设 11 个）', [standaloneAgents().length, standaloneRecs().length], [11, 11]);
}

/* ═══════════════════════════ 添加服务表单 ═══════════════════════════ */

section('T-UI 添加服务表单：校验、表单 ⇄ 定义、与主进程逐项对表');
{
  const good = (over: Partial<EditorForm> = {}): EditorForm => ({ ...emptyForm('openai-chat'), name: '我的中转站', baseUrl: 'https://api.example.com/v1', models: [{ ...emptyModelRow('gpt-6.1-sol'), ctx: '1050000' }], ...over });
  eq('空表单：名称、地址、模型三项挡住', Object.keys(validateForm(emptyForm()).errors).sort(), ['baseUrl', 'models', 'name']);
  ok('填全了：通过', validateForm(good()).ok);
  const errOf = (over: Partial<EditorForm>, key: string) => validateForm(good(over)).errors[key];
  ok('名称过长 / 有控制字符', !!errOf({ name: 'x'.repeat(41) }, 'name') && !!errOf({ name: 'a\nb' }, 'name'));
  ok('http 非回环 / 局域网 / 元数据地址 / 带 ? / 不是网址：都拒绝', ['http://192.168.1.2/v1', 'http://example.com/v1', 'https://169.254.169.254/', 'https://a.com/v1?key=1', 'ftp://a.com', 'not a url'].every((u) => !!errOf({ baseUrl: u }, 'baseUrl')));
  const lan = urlInfo('http://192.168.1.2:1234/v1');
  ok('局域网 http 的提示：只允许 https，说明怎么办', !lan.ok && /前面加一层 https|装在本机/.test(lan.error ?? ''));
  ok('https 内网主机：通过但给黄字提示', validateForm(good({ baseUrl: 'https://10.0.0.5/v1' })).ok && validateForm(good({ baseUrl: 'https://10.0.0.5/v1' })).warnings.some((w) => /内网/.test(w)));
  eq('回环 http：算本机', [urlInfo('http://127.0.0.1:11434/v1').local, urlInfo('http://localhost:1234/v1').local, urlInfo('http://[::1]:8000/v1').local, urlInfo('https://api.example.com/v1').local], [true, true, true, false]);
  ok('「无鉴权」「不需要密钥」只能用于本机', !!errOf({ scheme: 'none' }, 'auth') && !!errOf({ keyOptional: true }, 'auth') && !validateForm(good({ baseUrl: 'http://127.0.0.1:11434/v1', scheme: 'none' })).errors.auth);
  ok('自定义头名：格式与禁用表', !!errOf({ scheme: 'header', header: '' }, 'header') && !!errOf({ scheme: 'header', header: 'Cookie' }, 'header') && !!errOf({ scheme: 'header', header: 'Authorization' }, 'header') && !errOf({ scheme: 'header', header: 'X-Api-Token' }, 'header'));
  ok('模型 ID：非法字符 / 重复 / 空行带数字', !!errOf({ models: [emptyModelRow('a b')] }, 'model-0') && !!errOf({ models: [emptyModelRow('a'), emptyModelRow('a')] }, 'model-1') && !!errOf({ models: [{ ...emptyModelRow(''), ctx: '8192' }] }, 'model-0') && !errOf({ models: [emptyModelRow('@cf/meta/llama-3'), emptyModelRow('~vendor/latest'), emptyModelRow('a/b:c')] }, 'model-0'));
  ok('上下文 / 最大输出：必须是整数，窗口至少 1024', !!errOf({ models: [{ ...emptyModelRow('m'), ctx: '12' }] }, 'ctx-0') && !!errOf({ models: [{ ...emptyModelRow('m'), ctx: 'abc' }] }, 'ctx-0') && !!errOf({ models: [{ ...emptyModelRow('m'), maxOut: '-1' }] }, 'maxOut-0') && !errOf({ models: [{ ...emptyModelRow('m'), ctx: '128000', maxOut: '16000' }] }, 'ctx-0'));
  ok('有推理写法却一个档位都没勾', !!errOf({ models: [{ ...emptyModelRow('m'), effort: 're', levels: [] }] }, 'model-0') && !errOf({ models: [{ ...emptyModelRow('m'), effort: 're', levels: ['low'] }] }, 'model-0') && !errOf({ models: [{ ...emptyModelRow('m'), effort: 'think-switch' }] }, 'model-0'));
  ok('额外请求头：重复、非法名字、值太长、超过 8 项', !!errOf({ headers: [{ name: 'X-A', value: '1' }, { name: 'x-a', value: '2' }] }, 'header-1') && !!errOf({ headers: [{ name: 'Host', value: 'x' }] }, 'header-0') && !!errOf({ headers: [{ name: 'X-A', value: 'é' }] }, 'header-0') && !!errOf({ headers: Array.from({ length: 9 }, (_, i) => ({ name: `X-H${i}`, value: '1' })) }, 'headers'));
  ok('额外请求体：非对象 / 禁用键 / 非法 JSON / 太大 / __proto__', !parseExtraBody('[1]').ok && !parseExtraBody('{"model":"x"}').ok && !parseExtraBody('{bad').ok && !parseExtraBody(`{"a":"${'x'.repeat(5000)}"}`).ok && !parseExtraBody('{"max_tokens":1}').ok && parseExtraBody('{"reasoning_format":"parsed"}').ok && parseExtraBody('').ok);
  const netMod = req('./electron/ai/net.cjs');
  ok('额外请求体的禁用键：页面的清单里每一个，主进程也拒绝', FORBIDDEN_BODY_KEYS.every((k) => netMod.checkExtraBody({ [k]: 1 }).ok === false), FORBIDDEN_BODY_KEYS.filter((k) => netMod.checkExtraBody({ [k]: 1 }).ok).join());
  ok('Anthropic 协议的服务再填 Anthropic 兼容地址：拒绝', !!validateForm(good({ protocol: 'anthropic', compatUrl: 'https://x.com/a' })).errors.compatUrl);
  // 套餐地址：页面与主进程是同一条规则
  const servicesMod = req('./electron/ai/services.cjs');
  const secrets = req('./electron/ai/secrets.cjs');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-models-ui-'));
  const regDir = (n: string) => { const d = path.join(work, n); fs.mkdirSync(d, { recursive: true }); return d; };
  secrets.__setDeps({ dir: regDir('keys'), safeStorage: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s: string) => Buffer.from(s), decryptStringAsync: async (b: Buffer) => ({ result: b.toString(), shouldReEncrypt: false }) } });
  const reg = servicesMod.createRegistry({ userDir: regDir('user'), secrets });
  secrets.configure(reg.secretsConfig());
  const yes = async () => true;
  const plans = PRESET_SERVICES.flatMap((s) => s.endpoints.filter((e) => e.kind === 'plan' && e.baseUrl && !/\{/.test(e.baseUrl)).map((e) => ({ s, e })));
  let agree = 0;
  const disagree: string[] = [];
  for (const { s, e } of plans) {
    const page = !!urlInfo(e.baseUrl!).planOwner;
    const main = await reg.saveService({ name: `套餐 ${s.id}`, endpoints: [{ id: 'main', label: 'x', kind: 'payg', baseUrl: e.baseUrl }], models: [{ id: 'm1' }] }, { confirm: yes });
    const refused = main.ok === false && /套餐地址/.test(main.error);
    if (page === refused) agree += 1; else disagree.push(`${s.id}/${e.id} 页面${page} 主进程${refused}`);
  }
  ok(`每个预设套餐地址：页面的判断与主进程一致（${plans.length} 个，其中与按量端点共用地址的 MiniMax M Plan 除外）`, plans.length > 5 && agree === plans.length, disagree.join('；'));
  // 页面通过的表单，主进程也接受；页面挡住的，主进程也拒绝
  const cases: Array<[string, EditorForm, boolean]> = [
    ['一般的中转站', good(), true],
    ['Anthropic 协议', good({ protocol: 'anthropic', scheme: 'x-api-key', baseUrl: 'https://api.example.com' }), true],
    ['带 Anthropic 兼容地址', good({ compatUrl: 'https://api.example.com/anthropic' }), true],
    ['本机 Ollama，无需密钥', good({ name: '本机 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', keyOptional: true, models: [emptyModelRow('qwen3:32b')] }), true],
    ['无鉴权的本机服务', good({ baseUrl: 'http://127.0.0.1:8000/v1', scheme: 'none', models: [emptyModelRow('m')] }), true],
    ['自定义头名', good({ scheme: 'header', header: 'X-Api-Token' }), true],
    ['带推理写法的模型', good({ models: [{ ...emptyModelRow('m1'), effort: 're', levels: ['low', 'high'], canOff: true }, { ...emptyModelRow('m2'), effort: 'think-switch' }, { ...emptyModelRow('m3'), effort: 'enable-thinking', levels: ['low'], effortField: true }, { ...emptyModelRow('m4'), effort: 're-think', levels: ['high'] }] }), true],
    ['额外请求头与请求体', good({ headers: [{ name: 'X-Team', value: 'alpha' }], extraBody: '{"reasoning_format":"parsed"}', maxTokensField: 'max_completion_tokens', thinkReasoningDetails: true, thinkContentParts: true }), true],
    ['局域网 http', good({ baseUrl: 'http://192.168.1.5:8000/v1' }), false],
    ['云上元数据地址', good({ baseUrl: 'https://169.254.169.254/v1' }), false],
    ['Kimi 套餐地址', good({ baseUrl: plans.find((x) => x.s.id === 'kimi')!.e.baseUrl! }), false],
    ['无鉴权但是公网', good({ scheme: 'none' }), false],
    ['非法模型 ID', good({ models: [emptyModelRow('bad id;rm')] }), false],
    ['禁用的头名', good({ scheme: 'header', header: 'Host' }), false],
    ['额外请求体里有 model', good({ extraBody: '{"model":"x"}' }), false],
    ['没有模型', good({ models: [emptyModelRow()] }), false],
  ];
  const mismatches: string[] = [];
  for (const [name, form, want] of cases) {
    const page = validateForm(form).ok;
    const def: any = formToDef(form);
    // the page would not send an invalid extra body at all; what the main process says about a raw one is checked here too
    if (!parseExtraBody(form.extraBody).ok) { try { def.extraBody = JSON.parse(form.extraBody); } catch { /* not JSON: the page refuses it before it gets here */ } }
    const main = await reg.saveService(def, { confirm: yes });
    if (page !== want) mismatches.push(`${name}：页面 ${page}（应 ${want}）`);
    if (main.ok !== want) mismatches.push(`${name}：主进程 ${main.ok}（应 ${want}）${main.ok ? '' : ` ${main.error}`}`);
  }
  eq(`表单校验与主进程保存逐项对表（${cases.length} 例）`, mismatches, []);
  // 表单 → 定义
  const d = formToDef(good({ compatUrl: 'https://api.example.com/anthropic', models: [{ ...emptyModelRow('m1'), ctx: '8192', effort: 're', levels: ['high', 'low'], canOff: true }, { ...emptyModelRow('m2'), effort: 'think-switch' }, { ...emptyModelRow('m3'), effort: 'enable-thinking', levels: ['medium'], effortField: true }] })) as any;
  eq('定义：端点按地址决定 kind，Anthropic 兼容地址存进端点并带上 claude-compat', [d.endpoints[0].kind, d.endpoints[0].compatUrl, d.drivers, d.protocol], ['payg', 'https://api.example.com/anthropic', ['claude-compat'], 'openai-chat']);
  eq('定义：re 风格档位按量表排序，能关闭就带 off 与 offWire none', d.models[0].effort, { style: 're', levels: ['off', 'low', 'high'], offWire: 'none' });
  eq('定义：think-switch 只有 off；enable-thinking 带 effortField', [d.models[1].effort, d.models[2].effort], [{ style: 'think-switch', levels: ['off'] }, { style: 'enable-thinking', levels: ['medium'], effortField: true }]);
  eq('定义：上下文转成数字，没填的不写', [d.models[0].ctx, d.models[1].ctx], [8192, undefined]);
  eq('新建时推荐列表接口：openai → /models；11434 → ollama /api/tags；anthropic → /v1/models', [d.modelsApi, (formToDef(good({ baseUrl: 'http://127.0.0.1:11434/v1', keyOptional: true })) as any).modelsApi, (formToDef(good({ protocol: 'anthropic', baseUrl: 'https://x.com' })) as any).modelsApi?.path], [{ path: '/models', from: 'base', parser: 'openai', auth: 'optional', chatOnly: true }, { path: '/api/tags', from: 'origin', parser: 'ollama', auth: 'none' }, '/v1/models']);
  const local = formToDef(good({ baseUrl: 'http://127.0.0.1:8000/v1', scheme: 'none', models: [emptyModelRow('m')] })) as any;
  eq('本机服务：kind local、窗口按 8K 估、keyOptional', [local.endpoints[0].kind, local.defaultCtx, local.auth.keyOptional, local.wire.defaultMaxOut], ['local', 8192, true, 8192]);
  // 往返与编辑时保留表单不管的字段
  const saved = await reg.saveService(formToDef(good({ headers: [{ name: 'X-Team', value: 'alpha' }], extraBody: '{"reasoning_format":"parsed"}', models: [{ ...emptyModelRow('m1'), effort: 're', levels: ['low', 'high'] }] })), { confirm: yes });
  const back = defToForm(saved.value);
  eq('往返：定义 → 表单 保留所有可编辑的项', [back.name, back.baseUrl, back.headers, JSON.parse(back.extraBody), back.models[0].effort, back.models[0].levels], ['我的中转站', 'https://api.example.com/v1', [{ name: 'X-Team', value: 'alpha' }], { reasoning_format: 'parsed' }, 're', ['low', 'high']]);
  const withExtra: ServiceDef = { ...saved.value, endpoints: [...saved.value.endpoints, { id: 'second', label: '备用', kind: 'payg', baseUrl: 'https://b.example.com/v1' }], models: [{ ...saved.value.models[0], label: '带名字', note: '备注', caps: { vision: true } }] };
  const edited = formToDef({ ...defToForm(withExtra), name: '改了名字' }, withExtra) as any;
  eq('编辑：表单不管的字段（第二个端点、模型的 label / note / caps、id）原样保留', [edited.id, edited.name, edited.endpoints.length, edited.models[0].label, edited.models[0].note, edited.models[0].caps], [saved.value.id, '改了名字', 2, '带名字', '备注', { vision: true }]);
  const reSaved = await reg.saveService(edited, { confirm: yes });
  ok('编辑后的定义主进程接受，id 不变', reSaved.ok && reSaved.value.id === saved.value.id && reSaved.value.name === '改了名字');
  eq('换协议：模型的推理写法清空（页面做），能力预览跟着变', [previewGrade(good({ models: [{ ...emptyModelRow('m'), effort: 're', levels: ['low'] }] })).tune, previewGrade(good()).tune], [true, false]);
  ok('能力预览：只有 OpenAI 协议没有兼容地址 → 干活不可用并说明；填了兼容地址 → 实验', previewGrade(good()).work === 'no' && /只有 OpenAI 协议/.test(previewGrade(good()).why.work ?? '') && previewGrade(good({ compatUrl: 'https://api.example.com/anthropic' })).work === 'experimental');
  eq('主进程拒绝的字段名 → 表单里的哪个输入框', ['name', 'endpoints[0].baseUrl', 'endpoints[0].compatUrl', 'models[2].id', 'models[1].ctx', 'auth.header', 'auth.keyOptional', 'headers.X-A', 'extraBody', 'weird', undefined].map((f) => formFieldOf(f as string | undefined)), ['name', 'baseUrl', 'compatUrl', 'model-2', 'ctx-1', 'header', 'auth', 'headers', 'extraBody', '_form', '_form']);
  ok('推理强度写法五选一（再加 Anthropic 协议的写法）', EFFORT_KINDS.map((k) => k.value).join() === 'none,re,re-think,think-switch,enable-thinking,anthropic');
  secrets.__setDeps(null);
  secrets.configure(null);
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* next time */ }
}

/* ═══════════════════════════ T-LIST / T-CACHE 增补 ═══════════════════════════ */

section('T-LIST / T-CACHE 增补：同一服务的并发请求合并；失败后短时间不重复请求');
{
  const servicesMod = req('./electron/ai/services.cjs');
  const secrets = req('./electron/ai/secrets.cjs');
  const mapi = req('./electron/ai/models-api.cjs');
  const { startFake } = req('./scripts/fixtures/fake-llm.cjs');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-models-list-'));
  const dir = (n: string) => { const d = path.join(work, n); fs.mkdirSync(d, { recursive: true }); return d; };
  secrets.__setDeps({ dir: dir('keys'), safeStorage: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s: string) => Buffer.from(s), decryptStringAsync: async (b: Buffer) => ({ result: b.toString(), shouldReEncrypt: false }) } });
  const reg = servicesMod.createRegistry({ userDir: dir('user'), secrets });
  secrets.configure(reg.secretsConfig());
  const openaiList = { object: 'list', data: [{ id: 'live-a' }, { id: 'live-b' }] };
  let mode = 'ok';
  const fake = await startFake({ models: () => (mode === 'ok' ? { '/v1/models': openaiList } : { '/v1/models': 500 }) });
  try {
    const saved = await reg.saveService({ name: '列表测试', endpoints: [{ id: 'main', label: '本机', kind: 'local', baseUrl: fake.baseUrl }], auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'fake-model' }], modelsApi: { path: '/models', parser: 'openai', auth: 'none' } }, { confirm: async () => true });
    const id = saved.value.id as string;
    let clock = 1_800_000_000_000;
    const mk = () => mapi.createModelsApi({ registry: reg, secrets, cacheFile: path.join(dir(`c${Math.random()}`), 'model-cache.json'), now: () => clock, tooSoon: () => false });
    // 并发合并
    let api = mk();
    const [a, b, c] = await Promise.all([api.listModels({ service: id }), api.listModels({ service: id }), api.listModels({ service: id, fresh: true })]);
    ok('三个下拉同时问同一个服务：只发一次请求，三个都拿到结果', fake.requests.length === 1 && a.source === 'live' && b.source === 'live' && c.source === 'live' && a.models.length === 3, `${fake.requests.length}`);
    ok('请求结束后不再占着「在途」表', api._inflight.size === 0);
    // 失败：短时间不重复请求，fresh 绕过，过了记忆期再试
    fake.reset();
    mode = 'fail';
    api = mk();
    const f1 = await api.listModels({ service: id });
    const f2 = await api.listModels({ service: id });
    ok('服务出错：第一次请求，第二次直接说同样的话、不再请求', f1.ok === false && f1.code === 'SERVER' && f2.code === 'SERVER' && fake.requests.length === 1, `${fake.requests.length} ${f1.code} ${f2.code}`);
    await api.listModels({ service: id, fresh: true });
    ok('按了「刷新」（fresh）：绕过失败记忆，重新请求', fake.requests.length === 2);
    clock += mapi.FAIL_MEMORY_MS + 1000;
    await api.listModels({ service: id });
    ok(`过了 ${mapi.FAIL_MEMORY_MS / 1000} 秒记忆期：再问一次`, fake.requests.length === 3);
    // 恢复后：成功清掉失败记忆，缓存命中
    mode = 'ok';
    clock += mapi.FAIL_MEMORY_MS + 1000;
    const okR = await api.listModels({ service: id });
    const again = await api.listModels({ service: id });
    ok('服务恢复：成功，之后命中缓存，不再请求', okR.source === 'live' && again.source === 'cache' && fake.requests.length === 4 && api._failed.size === 0, `${fake.requests.length}`);
    // 有旧缓存时失败：带着缓存返回，并标过期；失败记忆下同样
    mode = 'fail';
    clock += 31_000;
    const stale = await api.listModels({ service: id });
    const stale2 = await api.listModels({ service: id });
    ok('有旧缓存时服务出错：返回缓存并标 stale，错误原因在；重复问不再请求', stale.source === 'cache' && stale.stale === true && !!stale.error && stale2.source === 'cache' && stale2.stale === true && fake.requests.length === 5, `${fake.requests.length}`);
  } finally { await fake.close(); }
  secrets.__setDeps(null);
  secrets.configure(null);
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* next time */ }
}

/* ═══════════════════════════ 烟测脚本（假服务上跑一遍） ═══════════════════════════ */

section('scripts/smoke/services-smoke.mjs：默认不联网；live 的三个条件；密钥不出现在输出里；套餐端点不发请求');
{
  const { spawn } = req('node:child_process');
  const { startFake } = req('./scripts/fixtures/fake-llm.cjs');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-smoke-check-'));
  const run = (args: string[], env: Record<string, string> = {}) => new Promise<{ code: number; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, ['scripts/smoke/services-smoke.mjs', ...args], { cwd: path.resolve('.'), env: { ...process.env, ALIGHT_SMOKE_OUT: path.join(work, 'out'), ...env }, windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => { out += d; });
    child.stderr.on('data', (d: Buffer) => { err += d; });
    child.on('close', (code: number) => resolve({ code, out, err }));
  });
  const dry = await run([]);
  ok('dry-run：退出码 0，每个（服务，端点）打印它会发的请求，头里的密钥打码', dry.code === 0 && /POST https:\/\/api\.moonshot\.cn\/v1\/chat\/completions/.test(dry.out) && /Bearer \*\*\*/.test(dry.out) && /全部 dry-run/.test(dry.out), dry.err.slice(0, 200));
  ok('dry-run：套餐端点只说明、不打请求（Kimi code、MiniMax plan…）', /kimi · code {2}套餐端点/.test(dry.out) && !/POST https:\/\/api\.kimi\.com/.test(dry.out));
  ok('dry-run：每个预设的地址都过了 checkBaseUrl（没有断言失败）', !/地址断言失败/.test(dry.out));
  const fake = await startFake({ script: 'openai-ok', models: { '/v1/models': { object: 'list', data: [{ id: 'm-a' }, { id: 'm-b' }] } } });
  try {
    const defFile = path.join(work, 'fake.json');
    fs.writeFileSync(defFile, JSON.stringify({ id: 'x_fakesmoke', name: '假服务', endpoints: [{ id: 'main', label: '本机', kind: 'local', baseUrl: fake.baseUrl }], auth: { scheme: 'bearer', keyOptional: true }, models: [{ id: 'm-a' }], modelsApi: { path: '/models', parser: 'openai', auth: 'optional' }, wire: { maxTokensField: 'auto', testMaxTokens: 64 } }));
    const KEY = 'sk-FAKE-smoke-key-0001';
    // 只有 --live 没有环境变量：仍是 dry-run，没有任何请求
    const noEnv = await run(['--live', '--only', 'x_fakesmoke', '--custom', defFile], { ALIGHT_SMOKE_KEY_X_FAKESMOKE: KEY });
    ok('只有 --live、没有 ALIGHT_SMOKE_LIVE=1：只做 dry-run，没有发请求', noEnv.code === 0 && fake.requests.length === 0 && /ALIGHT_SMOKE_LIVE=1/.test(noEnv.out), `${fake.requests.length}`);
    // 缺密钥环境变量：也只是 dry-run
    const noKey = await run(['--live', '--only', 'x_fakesmoke', '--custom', defFile], { ALIGHT_SMOKE_LIVE: '1' });
    ok('三个条件缺密钥环境变量：只做 dry-run，并说明缺哪个变量', noKey.code === 0 && fake.requests.length === 0 && /ALIGHT_SMOKE_KEY_X_FAKESMOKE/.test(noKey.out));
    const live = await run(['--live', '--only', 'x_fakesmoke', '--custom', defFile], { ALIGHT_SMOKE_LIVE: '1', ALIGHT_SMOKE_KEY_X_FAKESMOKE: KEY });
    eq('三个条件都满足：先拉列表、再一次最小对话（复用产品的适配器），带鉴权头', fake.requests.map((q: any) => `${q.method} ${q.path} ${q.headers.authorization ? 'auth' : 'noauth'}`), ['GET /v1/models auth', 'POST /v1/chat/completions auth']);
    ok('live：退出码 0，每步记耗时与结果，对话步有 finish 与 usage', live.code === 0 && /models +ok/.test(live.out) && /chat +ok/.test(live.out) && /finish=stop/.test(live.out) && /usage=11\/5/.test(live.out), live.out.slice(-400));
    const outFiles = fs.readdirSync(path.join(work, 'out'));
    ok('密钥既不在终端输出里，也不在结果文件里', !live.out.includes('FAKE-smoke-key') && !live.err.includes('FAKE-smoke-key') && outFiles.length === 1 && !fs.readFileSync(path.join(work, 'out', outFiles[0]), 'utf8').includes('FAKE-smoke-key'));
    // 失败：退出码 1
    fake.script = 'echo-key-error';
    const bad = await run(['--live', '--only', 'x_fakesmoke', '--custom', defFile], { ALIGHT_SMOKE_LIVE: '1', ALIGHT_SMOKE_KEY_X_FAKESMOKE: KEY });
    ok('服务回显密钥的报错：退出码 1，归类 AUTH，输出里仍没有密钥', bad.code === 1 && /AUTH/.test(bad.out) && !bad.out.includes('FAKE-smoke-key'), bad.out.slice(-300));
    // 一个套餐端点即使有密钥也不发
    fake.reset();
    const plan = await run(['--live', '--only', 'kimi'], { ALIGHT_SMOKE_LIVE: '1', ALIGHT_SMOKE_KEY_KIMI_CODE: 'sk-FAKE-plan-key-0002' });
    ok('套餐端点就算有密钥环境变量也不做 API 请求（那些 Key 只能给命令行工具）', /kimi · code {2}套餐端点/.test(plan.out) && !plan.out.includes('FAKE-plan-key') && fake.requests.length === 0);
  } finally { await fake.close(); }
  try { fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* next time */ }
}

/* ───────────── 收尾 ───────────── */

setCustomServices([]);
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(`${failed} failed`); process.exit(1); }
