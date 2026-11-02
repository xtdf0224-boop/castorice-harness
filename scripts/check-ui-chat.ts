/* 模块检查（对话 / 工作 / 归来 的 DOM 契约）：npm run check:ui-chat
   无 GUI、无网络、不花额度、不起子进程。静态渲染（react-dom/server，样式桩掉）：用 devFixture 里的验收状态（T 自己的 applyFixture，
   与 probe shots / flows 用的是同一份）把世界摆好，再渲染 Workspace / ReturnView / AgentsView / StatusPanel，对 §4.7 的 DOM 契约逐条扫描。
   覆盖施工图 §7.1 的 check:ui-chat 一行：
     · HerAvatar：data-expr ∈ 六个官方表情；size ≤ 72 的 sq 有 [data-badge]（带贴纸的消息除外）；sq 的裁切数值与 FACE_CROP_CSS 一致（D-03）
     · 审批卡 / 报错卡 / 遗物卡 / 未竟之信 / 计划 / 步骤 / 工具行 / 归来笺正文：[data-card] 内没有 [data-her-avatar] / [data-sticker] / [data-expr] / [data-badge]（D-01）
     · 含 [data-sticker] 的消息：头像 gentle 且无角标；贴纸只在 [data-her] 里、每条 ≤1、整页 ≤ 话量上限；口吻关 / 贴纸关 / 危机回合为 0（D-02、D18、D19）
     · 旧消息（没有 expr）：固定 gentle、无角标（§2.3）
     · 渲染边长 ≤ 自然边长（D-04）、命途图标来自 her/path-*（D-05）、全文本扫描无「银手套 / 黑档 / 黑色审批卡」与标签残留（D-06）、aria-live（D-07）
     · 外环只编码运行状态（D-10，CSS 静态扫描）
   「每个状态 × 话量 × 口吻 × 夜昼」全部渲染一遍：12 种组合 × 全部验收状态. 失败按规则聚合，只打印前几条现场. 更细的运行时断言（computed style、
   祖先 overflow、动画）在 probe flows ⑦. */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ComponentType } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

/* ── 浏览器全局的最小垫片（matchMedia / localStorage；参照 perf-work/av/C1/c1-ssr-selftest.ts） ── */
const lsData = new Map<string, string>();
const g = globalThis as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => lsData.get(k) ?? null,
  setItem: (k: string, v: string) => { lsData.set(k, String(v)); },
  removeItem: (k: string) => { lsData.delete(k); },
  clear: () => lsData.clear(), key: () => null, length: 0,
} as unknown as Storage;
g.window = Object.assign(g.window ?? {}, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }),
  addEventListener() {}, removeEventListener() {},
  localStorage: g.localStorage,
});
g.document = g.document ?? { visibilityState: 'visible', hasFocus: () => true, documentElement: { dataset: {} }, addEventListener() {}, removeEventListener() {} };

import { ART_MAX, EXPR_IDS, FACE_CROP_CSS, PATH_OF } from '../src/lib/expr';
import type { Approval, AppState, Level, Message, ThemeId } from '../src/lib/types';
import { actions } from '../src/state/actions';
import { DEFAULT_SETTINGS, emptyState } from '../src/state/seed';
import { store } from '../src/state/store';
import { FIXTURE_NAMES, applyFixture, type FixtureOpts } from '../src/components/decor/devFixture';
import { StatusPanel } from '../src/components/shell/StatusPanel';
import { AgentsView } from '../src/components/views/AgentsView';
import { ReturnView } from '../src/components/views/ReturnView';
import { Conversation } from '../src/components/workspace/Conversation';
import { Workspace } from '../src/components/workspace/Workspace';
import { HerAvatar } from '../src/components/her/HerAvatar';
import { StickerImg } from '../src/components/her/StickerImg';
import { AgentMark } from '../src/components/her/AgentMark';
import { SysLine } from '../src/components/her/SysLine';
import { approvalTagText, isIrreversible, pillAfterOf, sysKindOf } from '../src/components/her/logic';
import { ApprovalCard } from '../src/components/shell/ApprovalCard';

let passed = 0;
let failed = 0;
function ok(name: string, cond: boolean, extra = '') {
  if (!cond) { failed += 1; console.error(`  FAIL ${name}${extra ? ` — ${extra}` : ''}`); } else { passed += 1; if (!process.env.QUIET) console.log(`  ok  ${name}`); }
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
    if (m[1]) {
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
function all(n: N, pred: (x: N) => boolean, out: N[] = []): N[] {
  for (const k of n.kids) if (typeof k !== 'string') { if (pred(k)) out.push(k); all(k, pred, out); }
  return out;
}
const byAttr = (n: N, a: string, v?: string) => all(n, (x) => a in x.attrs && (v === undefined || x.attrs[a] === v));
const textOf = (n: N): string => n.kids.map((k) => (typeof k === 'string' ? k : textOf(k))).join('');
const upto = (n: N, pred: (x: N) => boolean): N | undefined => { for (let p: N | undefined = n.parent; p; p = p.parent) if (pred(p)) return p; return undefined; };
const hasClass = (n: N, c: string) => (n.attrs.class ?? '').split(/\s+/).includes(c);
const px = (style: string | undefined, prop: string): number | undefined => {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([\\d.]+)px`).exec(style ?? '');
  return m ? Number(m[1]) : undefined;
};

/* ═══════════════════════════ 渲染 ═══════════════════════════ */

const NOW = Date.now();
const fresh = (): AppState => emptyState(NOW, { ...DEFAULT_SETTINGS });

interface Page { html: string; panel: string; dom: N; panelDom: N; view: string; taskId?: string; state: AppState }

/** 摆好一个状态再渲染它所在的页面（task → Workspace；new → ReturnView；agents → AgentsView）+ 右栏. 渲染不了的页面（设置 / avatar-crop）返回 undefined. */
function render(fixture: string, o: FixtureOpts = {}, edit?: (s: AppState) => void): Page | undefined {
  store.init(fresh());
  if (!applyFixture(fixture, o)) throw new Error(`状态 ${fixture} 不存在`);
  if (edit) store.update((d) => { edit(d as unknown as AppState); });
  const state = store.get();
  const comp: ComponentType | undefined = state.view === 'task' ? Workspace : state.view === 'new' ? ReturnView : state.view === 'agents' ? AgentsView : undefined;
  if (!comp) return undefined;
  const html = renderToStaticMarkup(createElement(comp));
  const panel = renderToStaticMarkup(createElement(StatusPanel));
  return { html, panel, dom: parse(html), panelDom: parse(panel), view: state.view, taskId: state.selectedTaskId, state };
}

/* ═══════════════════════════ 规则（按规则聚合失败） ═══════════════════════════ */

const failures = new Map<string, string[]>();
const tallies = new Map<string, number>();
function rule(name: string, cond: boolean, where: string) {
  tallies.set(name, (tallies.get(name) ?? 0) + 1);
  if (!cond) { const l = failures.get(name) ?? []; l.push(where); failures.set(name, l); }
}

const CARD_KINDS = new Set(['plan', 'step', 'tool', 'approval', 'error', 'relic', 'letter', 'brief']);
const STICKER_CAP: Record<Level, number> = { s: 1, m: 2, l: 4 };
const NATURAL_FACE = 527;
const BAD_WORDS = /银手套|黑档|黑色审批卡/;
const TAG_LEAK = /⟦|〚|face:|react:/;

function scan(p: Page, where: string, o: { level: Level; persona: boolean; fixture: string }) {
  const doms: Array<[string, N, string]> = [['主栏', p.dom, p.html], ['右栏', p.panelDom, p.panel]];

  for (const [part, dom, html] of doms) {
    const at = `${where} ${part}`;
    // D-01：内容层卡里没有头像 / 贴纸 / 表情 / 角标
    for (const card of byAttr(dom, 'data-card')) {
      if (!CARD_KINDS.has(card.attrs['data-card'])) continue;
      const bad = all(card, (x) => 'data-her-avatar' in x.attrs || 'data-sticker' in x.attrs || 'data-expr' in x.attrs || 'data-badge' in x.attrs);
      rule('D-01 内容层卡内无头像 / 贴纸 / 表情 / 角标', bad.length === 0, `${at} data-card=${card.attrs['data-card']}`);
    }
    // D-02：贴纸只在 data-her 里、每条消息 ≤1
    const stickers = byAttr(dom, 'data-sticker');
    for (const st of stickers) rule('D-02 贴纸只出现在 [data-her] 里', !!upto(st, (x) => 'data-her' in x.attrs), `${at} ${st.attrs['data-sticker']}`);
    const perArticle = new Map<N, number>();
    for (const st of stickers) { const a = upto(st, (x) => x.tag === 'article'); if (a) perArticle.set(a, (perArticle.get(a) ?? 0) + 1); }
    for (const [a, n] of perArticle) rule('D-02 每条消息最多一张贴纸', n <= 1, `${at} ${(a.attrs.class ?? '').slice(0, 40)} ×${n}`);
    // 带贴纸的消息：头像 gentle、无角标（D19）
    for (const st of stickers) {
      const a = upto(st, (x) => x.tag === 'article');
      if (!a) continue;
      const av = byAttr(a, 'data-her-avatar');
      rule('D19 含贴纸的消息：头像 gentle 且无角标', av.every((x) => x.attrs['data-expr'] === 'gentle') && byAttr(a, 'data-badge').length === 0, at);
    }
    // D-03：sq 裁切数值；≤72 有角标
    for (const av of byAttr(dom, 'data-her-avatar')) {
      const expr = av.attrs['data-expr'];
      rule('D-03 data-expr 是六个官方表情之一', (EXPR_IDS as readonly string[]).includes(expr), `${at} data-expr=${expr}`);
      if (av.attrs['data-shape'] === 'sq') {
        const img = all(av, (x) => x.tag === 'img' && hasClass(x, 'hface__img'))[0];
        const st = img?.attrs.style ?? '';
        rule('D-03 sq 头像的裁切数值 = FACE_CROP_CSS', st.includes(`width:${FACE_CROP_CSS.width}%`) && st.includes(`left:${FACE_CROP_CSS.left}%`) && /top:0/.test(st), `${at} ${st.slice(0, 120)}`);
        const size = px(av.attrs.style, 'width');
        rule('D-04 sq 头像容器边长 × 1.351 ≤ 349', size !== undefined && size * (FACE_CROP_CSS.width / 100) <= ART_MAX.face + 0.5, `${at} size=${size}`);
        const art = upto(av, (x) => x.tag === 'article');
        const sticky = art ? byAttr(art, 'data-sticker').length > 0 : false;
        // 设计内的例外（都不是漏画）：带贴纸的消息（D19）；折叠成一行的她的话（24px，只留头像）；页头的头像在「还没有她的话」时没有神色可显示
        // （chat-empty，§2.3：旧 / 无 expr 固定 gentle 不画角标）与危机回合（D18：无角标）.
        const folded = !!upto(av, (x) => hasClass(x, 'her-fold'));
        const headerNoExpr = !!upto(av, (x) => hasClass(x, 'chat-ws__face')) && (o.fixture === 'chat-empty' || o.fixture === 'chat-crisis');
        const crisisMsg = o.fixture === 'chat-crisis' && part === '主栏';
        if (size !== undefined && size <= 72 && !sticky && !folded && !headerNoExpr && !crisisMsg) rule('D-03 size≤72 的 sq 头像有 [data-badge]（贴纸 / 折叠 / 危机 / 空聊页头除外）', byAttr(av, 'data-badge').length > 0, `${at} size=${size} expr=${expr}`);
        if (o.fixture === 'chat-crisis') rule('D18 危机回合：头像 gentle（主栏另外无角标）', expr === 'gentle' && (part === '右栏' || byAttr(av, 'data-badge').length === 0), at);
      } else if (av.attrs['data-shape'] === 'full') {
        const w = px(av.attrs.style, 'width');
        rule('D-04 full 头像边长 ≤ 349', w !== undefined && w <= ART_MAX.face, `${at} w=${w}`);
        rule('D-03 full 头像本身不带 overflow', !/overflow/.test(av.attrs.style ?? ''), at);
      }
    }
    // D-04：所有 <img> 的显式边长 ≤ 自然边长
    for (const img of all(dom, (x) => x.tag === 'img')) {
      const src = img.attrs.src ?? '';
      const w = Number(img.attrs.width ?? px(img.attrs.style, 'width') ?? 0);
      if (!w) continue;
      const cap = /face-/.test(src) ? ART_MAX.face : /icon-/.test(src) ? ART_MAX.icon : /sticker-/.test(src) ? ART_MAX.sticker : /path-/.test(src) ? 128 : NATURAL_FACE;
      rule('D-04 img 渲染边长 ≤ 自然边长（贴纸 ≤120、角标 ≤136、立绘 ≤349）', w <= cap, `${at} ${src.split('/').pop()} w=${w}`);
    }
    // D-05：命途图标来自 her/path-*
    for (const m of byAttr(dom, 'data-agent-mark')) {
      const src = (m.tag === 'img' ? m : all(m, (x) => x.tag === 'img')[0])?.attrs.src ?? '';
      rule('D-05 data-agent-mark 的 src 来自 her/path-*', /her\/path-/.test(src), `${at} ${src}`);
    }
    // D-06：全文本扫描
    const body = html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/surface:/g, '');
    rule('D-06 无「银手套 / 黑档 / 黑色审批卡」', !BAD_WORDS.test(body), at);
    rule('D-06 无表情标签残留（⟦ / face: / react:）', !TAG_LEAK.test(body), `${at} ${(TAG_LEAK.exec(body) ?? [''])[0]}`);
    // D-07：aria-live 不是 assertive
    for (const el of byAttr(dom, 'aria-live')) rule('D-07 aria-live 为 polite（或 off），不抢焦点', el.attrs['aria-live'] !== 'assertive', at);
    // 口吻关：没有她的头像 / 贴纸
    if (!o.persona) {
      rule('口吻关：没有她的头像', byAttr(dom, 'data-her-avatar').length === 0, `${at}`);
      rule('口吻关：没有贴纸', byAttr(dom, 'data-sticker').length === 0, at);
    }
  }
  // 整页贴纸数 ≤ 话量上限
  const total = byAttr(p.dom, 'data-sticker').length + byAttr(p.panelDom, 'data-sticker').length;
  rule('D-02 整页贴纸数 ≤ 话量上限（少 1 / 中 2 / 多 4）', total <= STICKER_CAP[o.level], `${where} ${total} > ${STICKER_CAP[o.level]}`);
  // Agent 页没有贴纸（D19）
  if (p.view === 'agents') rule('D19 Agent 页没有 [data-sticker]', total === 0, where);
}

/* ═══════════════════════════ 1. 状态清单与清单文件 ═══════════════════════════ */

section('T-CHAT 验收状态：施工图 §7.3 列的名字都在，且都能摆出来');
const REQUIRED = [
  'agents-idle', 'agents-busy', 'agents-reviewer-off', 'agents-takeover', 'agents-dsh', 'agents-codex', 'agents-api', 'agents-nomodel', 'agents-plain', 'agents-back-orchestrator', 'agents-back-coder-codex', 'agents-back-researcher-api', 'agents-coder-codex', 'agents-coder-dsh',
  'chat-empty', 'chat-reply', 'chat-sticker', 'chat-error', 'chat-landing', 'chat-storybox', 'chat-pills', 'chat-folded', 'chat-crisis', 'chat-streaming', 'chat-latenight', 'chat-plain',
  'work-plan-pending', 'work-running', 'work-approval-mid', 'work-approval-high', 'work-question', 'work-done', 'work-failed', 'work-laiddown', 'work-interrupted', 'work-takeover',
  'return-brief', 'return-quiet', 'settings-voice', 'avatar-crop',
];
{
  const missing = REQUIRED.filter((n) => !FIXTURE_NAMES.includes(n));
  ok('FIXTURE_NAMES 含全部必需状态', missing.length === 0, missing.join('、'));
  ok('不认识的状态名返回 false（不抛）', (() => { store.init(fresh()); return applyFixture('no-such-state') === false; })());
  const bad: string[] = [];
  for (const n of REQUIRED) {
    if (n === 'avatar-crop') continue;   // 要真 DOM（createRoot），只在 probe 里拍
    try { store.init(fresh()); if (!applyFixture(n, {})) bad.push(n); } catch (e) { bad.push(`${n}（${(e as Error).message}）`); }
  }
  ok('每个状态都能摆出来（applyFixture 返回 true）', bad.length === 0, bad.join('、'));
}

section('T-CHAT 截图清单：manifest.json 与状态、命名、数量对得上');
{
  const file = path.resolve(process.cwd(), '..', 'design', 'chat', 'accept', 'manifest.json');
  if (!fs.existsSync(file)) {
    ok('design/chat/accept/manifest.json 存在（node scripts/probe/manifest-gen.mjs 生成）', false, file);
  } else {
    const m = JSON.parse(fs.readFileSync(file, 'utf8')) as { shots: Array<{ file: string; fixture: string; theme: string; level: string; wallpaper: boolean; persona?: boolean }> };
    const names = m.shots.map((s) => s.file);
    ok('文件名无重复', new Set(names).size === names.length);
    ok('命名 <区>-<状态>-<night|day>-<s|m|l>[-nowall].png', names.every((n) => /^(agent|chat|work|return|settings|avatar)-[a-z0-9-]+-(night|day)-(s|m|l)(-nowall)?\.png$/.test(n)), names.filter((n) => !/^(agent|chat|work|return|settings|avatar)-[a-z0-9-]+-(night|day)-(s|m|l)(-nowall)?\.png$/.test(n)).slice(0, 3).join('、'));
    ok('每条的 fixture 都是已知状态', m.shots.every((s) => FIXTURE_NAMES.includes(s.fixture)), m.shots.filter((s) => !FIXTURE_NAMES.includes(s.fixture)).map((s) => s.fixture).join('、'));
    const CORE = ['agent-default', 'chat-reply', 'work-plan-pending', 'work-approval-high', 'work-done', 'work-failed', 'return-brief'];
    const core = CORE.flatMap((c) => (['night', 'day'] as const).flatMap((t) => (['s', 'm', 'l'] as const).map((l) => `${c}-${t}-${l}.png`)));
    ok('核心矩阵 7 状态 × 夜昼 × 少中多 = 42 张齐全', core.length === 42 && core.every((n) => names.includes(n)), core.filter((n) => !names.includes(n)).join('、'));
    const states = new Set(names.filter((n) => !n.endsWith('-nowall.png')).map((n) => n.replace(/-(night|day)-[sml]\.png$/, '')));
    const noNowall = new Set(['avatar-crop', 'agent-reviewer-off-4s', 'agent-default-1280', 'agent-default-1100', 'agent-default-960', 'agent-back-1280', 'agent-busy-1280', 'agent-takeover-1280']);
    const lacking = [...states].filter((st) => !noNowall.has(st) && !(['night', 'day'] as const).every((t) => names.includes(`${st}-${t}-m-nowall.png`)));
    ok('每个状态都有 -nowall（壁纸关）夜昼各一张（对照板 / +4 s / 宽度变体除外）', lacking.length === 0, lacking.join('、'));
    ok('Agent 页另有 1280×800 / 1100×720 / 960×640 三个宽度', ['1280', '1100', '960'].every((w) => names.includes(`agent-default-${w}-night-m.png`) && names.includes(`agent-default-${w}-day-m.png`)));
    ok('avatar-crop 夜昼各一张', names.includes('avatar-crop-night-m.png') && names.includes('avatar-crop-day-m.png'));
    ok('口吻关的两个状态存在（agent-plain、chat-plain）', ['agent-plain', 'chat-plain'].every((c) => names.includes(`${c}-night-m.png`)));
  }
}

/* ═══════════════════════════ 2. 全部状态 × 话量 × 口吻 × 夜昼：DOM 契约扫描 ═══════════════════════════ */

section('T-CHAT D-01…D-10：每个状态 × 话量 × 口吻 × 夜昼，渲染后扫 DOM');
{
  const levels: Level[] = ['s', 'm', 'l'];
  const themes: ThemeId[] = ['night', 'day'];
  const renderable = REQUIRED.filter((n) => n !== 'avatar-crop' && n !== 'settings-voice');
  let pages = 0;
  const t0 = Date.now();
  for (const fixture of renderable) {
    for (const level of levels) for (const persona of [true, false]) for (const theme of themes) {
      const where = `${fixture}/${level}/${persona ? '口吻开' : '口吻关'}/${theme}`;
      try {
        const p = render(fixture, { level, persona, theme });
        if (!p) { rule('页面能渲染', false, where); continue; }
        pages += 1;
        scan(p, where, { level, persona, fixture });
      } catch (e) {
        rule('页面能渲染（不抛）', false, `${where}：${(e as Error).message.slice(0, 160)}`);
      }
    }
  }
  const names = [...tallies.keys()];
  for (const name of names) {
    const bad = failures.get(name) ?? [];
    const states = [...new Set(bad.map((w) => w.split('/')[0]))];
    ok(`${name}（${tallies.get(name)} 处检查）`, bad.length === 0, `${bad.length} 处不符（状态：${states.join('、')}）；例：${bad.slice(0, 3).join(' | ')}`);
  }
  console.log(`  （渲染了 ${pages} 个页面，用时 ${Math.round((Date.now() - t0) / 100) / 10} s）`);
}

/* ═══════════════════════════ 3. 具体状态的内容断言（状态是「真」的） ═══════════════════════════ */

section('T-CHAT 状态真实性：每个状态在 DOM 里长成它该有的样子');
{
  const at = (name: string, o: FixtureOpts = {}) => { const p = render(name, { level: 'm', persona: true, theme: 'night', ...o }); if (!p) throw new Error(`${name} 渲染不出`); return p; };

  // 工作：计划待批
  let p = at('work-plan-pending');
  ok('计划待批：计划卡 + 「批准计划」按钮', byAttr(p.dom, 'data-card', 'plan').length === 1 && /批准计划/.test(textOf(p.dom)), '');
  ok('计划待批：运行是 awaiting + planApproval pending', Object.values(p.state.runs)[0].status === 'awaiting' && Object.values(p.state.runs)[0].planApproval?.status === 'pending');
  // 运行中
  p = at('work-running');
  ok('运行中：run=running，有在跑的工具调用', Object.values(p.state.runs)[0].status === 'running' && Object.values(p.state.runs)[0].toolCalls.some((c) => c.status === 'running'));
  ok('运行中：工具行 data-card=tool 存在，且原样写着工具标题', byAttr(p.dom, 'data-card', 'tool').length >= 1 && /写入 RELEASE-NOTES\.md/.test(textOf(p.dom)));
  ok('运行中：子 Agent 的话用命途图标 + 名字，没有她的头像', (() => {
    const art = all(p.dom, (x) => x.tag === 'article' && /读了 38 条提交记录/.test(textOf(x)))[0];
    return !!art && byAttr(art, 'data-agent-mark', 'researcher').length >= 1 && byAttr(art, 'data-her-avatar').length === 0;
  })());
  // 待批（中 / 高）
  p = at('work-approval-mid');
  ok('待批（中）：审批卡 + 卡外她的一句', byAttr(p.dom, 'data-card', 'approval').length === 1 && /her-leadrow|her-lead/.test(p.html));
  p = at('work-approval-high');
  ok('待批（高）：审批卡标「须亲批」，指令原样', byAttr(p.dom, 'data-card', 'approval').length === 1 && /须亲批/.test(textOf(p.dom)) && /Alight-Setup-0\.1\.1\.exe/.test(textOf(p.dom)));
  ok('待批（高）：待批审批 risk=high', Object.values(p.state.runs)[0].approvals.some((a) => a.status === 'pending' && a.risk === 'high'));
  ok('待批（高）：卡外一句在卡之前、不在卡里', (() => {
    const lead = p.html.indexOf('her-lead');
    const card = p.html.indexOf('data-card="approval"');
    return lead >= 0 && lead < card;
  })());
  // 提问
  p = at('work-question');
  ok('提问：有待答问题', Object.values(p.state.runs)[0].questions?.some((q) => q.status === 'pending') === true && /「已知问题」要不要写进发布说明/.test(textOf(p.dom)));
  // 完成 / 失败 / 放下
  p = at('work-done');
  ok('完成：遗物卡 data-card=relic', byAttr(p.dom, 'data-card', 'relic').length === 1 && /已成/.test(textOf(p.dom)));
  p = at('work-failed');
  ok('失败：未竟之信 data-card=letter + 报错卡 data-card=error', byAttr(p.dom, 'data-card', 'letter').length === 1 && byAttr(p.dom, 'data-card', 'error').length >= 1);
  p = at('work-laiddown');
  ok('放下：卡折成一行「已放下」', /已放下/.test(textOf(p.dom)));
  p = at('work-interrupted');
  ok('被打断：运行是 paused（reload），卡外她说一句「停下了」', Object.values(p.state.runs)[0].status === 'paused' && Object.values(p.state.runs)[0].pauseReason === 'reload' && /停下/.test(textOf(p.dom)));
  p = at('work-takeover');
  ok('接手：审查已停用、它的步骤由遐蝶执行（ranAs）', p.state.agents.find((a) => a.id === 'reviewer')?.enabled === false && Object.values(p.state.runs)[0].plan.some((s) => s.agentId === 'reviewer' && s.ranAs === 'orchestrator'));

  // 闲聊
  p = at('chat-reply');
  ok('闲聊：有她的话（头像 56、名牌、副标「冥河的女儿」）', byAttr(p.dom, 'data-her-avatar').length >= 1 && /冥河的女儿/.test(textOf(p.dom)) && p.html.includes('width:56px'));
  ok('闲聊：每条她的话（有 expr 的）头像带角标', (() => {
    const arts = all(p.dom, (x) => x.tag === 'article' && byAttr(x, 'data-her-avatar').length > 0 && !hasClass(x, 'is-cont'));
    return arts.length >= 2 && arts.every((a) => byAttr(a, 'data-badge').length > 0);
  })());
  p = at('chat-sticker');
  ok('贴纸：恰有一张贴纸，且头像 gentle 无角标', byAttr(p.dom, 'data-sticker').length === 1);
  p = at('chat-sticker', { persona: true });
  ok('贴纸关（settings.stickers=false）：0 张', (() => { const q = render('chat-sticker', { level: 'm', persona: true }, (s) => { s.settings.stickers = false; }); return !!q && byAttr(q.dom, 'data-sticker').length === 0; })());
  p = at('chat-crisis');
  ok('危机回合：无贴纸、无角标、头像 gentle，正文含热线', byAttr(p.dom, 'data-sticker').length === 0 && byAttr(p.dom, 'data-badge').length === 0 && /12356/.test(textOf(p.dom)) && byAttr(p.dom, 'data-her-avatar').every((a) => a.attrs['data-expr'] === 'gentle'));
  p = at('chat-error');
  ok('闲聊失败：报错卡无头像，她的一句在卡外（40px 头像）', (() => {
    const err = byAttr(p.dom, 'data-card', 'error')[0];
    return !!err && byAttr(err, 'data-her-avatar').length === 0 && p.html.includes('her-leadrow') && p.html.indexOf('her-leadrow') < p.html.indexOf('data-card="error"') && p.html.includes('width:40px');
  })());
  p = at('chat-storybox');
  ok('剧情框（r3 重做，施工图 §4.4）：最新一句在框里；名牌 lg 骑在框上边线，副标固定官方称号「死荫的侍女」；没有框外头像（框体本身就是她在说话）；这一句有表情时名行带「小图标 + 表情名」胶囊', (() => {
    const m = /<section[^>]*data-story-box[\s\S]*?<\/section>/.exec(p.html);
    if (!m) return false;
    const box = m[0];
    return /data-nameplate="true" data-size="lg"/.test(box) && /data-nameplate-sub="true"[^>]*>死荫的侍女</.test(box) && !/data-her-avatar/.test(box) && /data-expr-chip="[a-z]+"/.test(box);
  })());
  p = at('chat-reply');
  ok('剧情框：默认关（气泡态）', !/data-story-box/.test(p.html));
  p = at('chat-folded');
  ok('折叠她的话：aria-expanded=false', /her-msg--fold/.test(p.html) && /aria-expanded="false"/.test(p.html));
  p = at('chat-pills');
  ok('休息关照：系统行在她的话之前、胶囊 ≤3 且最后是退出项、没有「再聊一会儿」', (() => {
    const sys = p.html.indexOf('data-sysl="rest"');
    const her = p.html.indexOf('data-sysl="rest"') >= 0 ? p.html.indexOf('her-bub', sys) : -1;
    const pills = all(p.dom, (x) => x.tag === 'button' && 'data-pill' in x.attrs);
    return sys > 0 && her > sys && pills.length >= 2 && pills.length <= 3 && hasClass(pills[pills.length - 1], 'pill--exit') && !/再聊一会儿/.test(p.html);
  })());
  p = at('chat-latenight');
  ok('夜深提醒：系统行 data-sysl=late', /data-sysl="late"/.test(p.html));
  p = at('chat-streaming');
  ok('流式中：最后一条她的话在写（streaming），文字没有标签残留', Object.values(p.state.tasks)[0].messages.some((m) => m.streaming) && !TAG_LEAK.test(p.html));
  p = at('chat-empty');
  ok('空闲聊：没有消息、没有她的话气泡', Object.values(p.state.tasks)[0].messages.length === 0);
  p = at('chat-plain', { persona: false });
  ok('口吻关（chat-plain）：没有她的头像 / 贴纸 / 神色词，编排用命途图标', byAttr(p.dom, 'data-her-avatar').length === 0 && byAttr(p.dom, 'data-sticker').length === 0 && byAttr(p.dom, 'data-agent-mark', 'orchestrator').length >= 1);

  // 话量对「少 / 中 / 多」确实不同（chat-reply 最后一句的字数递增）
  const lens = (['s', 'm', 'l'] as const).map((level) => {
    const q = render('chat-reply', { level, persona: true });
    const ms = q ? Object.values(q.state.tasks)[0].messages.filter((m) => m.role === 'agent') : [];
    return Array.from(ms[ms.length - 1]?.text ?? '').length;
  });
  ok('话量：chat-reply 她最后一句字数 少 < 中 < 多（少 ≤26 字）', lens[0] < lens[1] && lens[1] < lens[2] && lens[0] <= 26, `字数 ${lens.join(' / ')}`);

  // 归来
  p = at('return-brief');
  ok('归来笺：纸面 + 邮戳，头在她的话层、正文（data-card=brief）无头像', /brief-paper/.test(p.html) && /归来/.test(textOf(p.dom)) && byAttr(p.dom, 'data-card', 'brief').every((c) => byAttr(c, 'data-her-avatar').length === 0));
  ok('归来笺：待你里有须亲批的删除一项', /删除 4 个旧版安装包/.test(textOf(p.dom)));
  p = at('return-quiet');
  ok('归来（安静）：没有归来简（有内容的纸面 .brief-paper 与 data-card=brief 都不在；安静时只有 QuietPaper 的一句事实）', !/class="brief-paper"/.test(p.html) && !/data-card="brief"/.test(p.html) && /class="quiet-paper"/.test(p.html));

  ok('归来（安静）：夹具不是首次运行——有已完成、已看过的任务，写「离开 35 分钟，没有新事，也没有在等你的。」而不是「还没有任务」', Object.keys(p.state.tasks).length >= 2 && /离开 35 分钟，没有新事，也没有在等你的/.test(textOf(p.dom)) && !/还没有任务/.test(textOf(p.dom)), textOf(p.dom).slice(0, 160));

  // Agent 页
  p = at('agents-idle');
  ok('Agent 页：4 张牌（遐蝶居中放大）', byAttr(p.dom, 'data-agent').filter((x) => x.tag === 'article').length === 4);
  ok('Agent 页：每张牌都有命途图标，且是它自己的命途（遐蝶 记忆 / 检索 智识 / 编码 巡猎 / 审查 存护），来自 her/path-*', (['orchestrator', 'researcher', 'coder', 'reviewer'] as const).every((id) => {
    const card = all(p.dom, (x) => x.tag === 'article' && x.attrs['data-agent'] === id)[0];
    const marks = card ? byAttr(card, 'data-agent-mark') : [];
    return marks.length >= 1 && marks.every((m) => m.attrs['data-agent-mark'] === id) && marks.every((m) => new RegExp(`her/path-${PATH_OF[id]}`).test((m.tag === 'img' ? m : all(m, (x) => x.tag === 'img')[0])?.attrs.src ?? ''));
  }));
  p = at('agents-takeover');
  ok('Agent 页（接手）：审查牌扣下', all(p.dom, (x) => x.tag === 'article' && x.attrs['data-agent'] === 'reviewer' && hasClass(x, 'is-down')).length === 1);
  for (const [name, honest] of [['agents-dsh', true], ['agents-codex', false]] as const) {
    p = at(name);
    const faces = all(p.dom, (x) => hasClass(x, 'tarot-face')).map(textOf).join(' ');
    ok(`Agent 页（${name}）：牌面没有「白 / 银 / 黑 + 数字」${honest ? '' : '（Codex 部分遵守：写「只认 N 项」）'}`, !/[白银黑]\s*\d/.test(faces) && (honest ? /不受此处限制/.test(faces) : /只认 \d+ 项/.test(faces)), faces.slice(0, 120));
  }
  p = at('agents-api');
  ok('Agent 页（API）：牌面不显示分档', !/[白银黑]\s*\d/.test(all(p.dom, (x) => hasClass(x, 'tarot-face')).map(textOf).join(' ')));
  p = at('agents-nomodel');
  ok('Agent 页（没有模型）：顶上有「还没有可用的模型」', /还没有可用的模型/.test(textOf(p.dom)));
  p = at('agents-plain', { persona: false });
  ok('Agent 页（口吻关）：牌名「编排 Agent」、无她的立绘、无 data-credit=moon', /编排 Agent/.test(textOf(p.dom)) && byAttr(p.dom, 'data-credit', 'moon').length === 0);
  p = at('agents-back-coder-codex');
  ok('Agent 页（编码用 Codex）：牌背写明只认写文件和联网', /Codex|只认/.test(textOf(p.dom)));
  // 第 2 轮补拍的牌桌：编码 Agent 单独换 Codex / DSH（不点牌），牌面各写各的
  for (const [name, re] of [['agents-coder-codex', /只认 \d+ 项/], ['agents-coder-dsh', /不受此处限制/]] as const) {
    p = at(name);
    const coder = all(p.dom, (x) => x.tag === 'article' && x.attrs['data-agent'] === 'coder')[0];
    const face = coder ? all(coder, (x) => hasClass(x, 'tarot-face')).map(textOf).join(' ') : '';
    ok(`Agent 页（${name}）：编码牌牌面 ${re.source}，且没有「白 / 银 / 黑 + 数字」`, !!coder && re.test(face) && !/[白银黑]\s*\d/.test(face), face.slice(0, 120));
  }
  // 夹具不能把占位模型名带进界面（模型菜单、牌背里都会露出来）
  for (const name of ['agents-idle', 'agents-nomodel', 'agents-back-researcher-api', 'agents-coder-codex']) {
    p = at(name);
    ok(`夹具（${name}）：模型名里没有占位名 probe`, !/probe/i.test(JSON.stringify(p.state.models)) && !/probe/i.test(textOf(p.dom)));
  }
  // 落蝶（§4.4）：她上一句是陈述句，用户回「谢谢」→ 气泡下挂线框蝶 + 「落蝶」+「让她回一句」
  p = at('chat-landing');
  ok('落蝶：最后一条是用户的「谢谢」且带 reaction=landing，前一条是她的陈述句（不以问号结尾）', (() => {
    const ms = Object.values(p.state.tasks)[0].messages;
    const last = ms[ms.length - 1];
    const prev = ms[ms.length - 2];
    return last.role === 'user' && last.reaction === 'landing' && /谢谢/.test(last.text) && prev.role === 'agent' && !/[？?]\s*$/.test(prev.text);
  })());
  ok('落蝶：DOM 里有 .her-landing（线框蝶 18 + 「落蝶」+「让她回一句」按钮）', (() => {
    const lan = all(p.dom, (x) => hasClass(x, 'her-landing'))[0];
    if (!lan) return false;
    const btn = all(lan, (x) => x.tag === 'button');
    return /落蝶/.test(textOf(lan)) && btn.length === 1 && /让她回一句/.test(textOf(btn[0])) && all(lan, (x) => x.tag === 'svg').length >= 1;
  })());
}

/* ═══════════════════════════ 4. 组件级：旧消息、头像尺寸、贴纸尺寸 ═══════════════════════════ */

section('T-CHAT 旧消息（没有 expr）与组件边界');
{
  store.init(fresh());
  applyFixture('chat-empty', { level: 'm', persona: true, theme: 'night' });
  const tid = store.get().selectedTaskId as string;
  const t0 = NOW - 3_600_000;
  const msgs: Message[] = [
    { id: 'u1', role: 'user', text: '早', at: t0 },
    { id: 'old1', role: 'agent', agentId: 'orchestrator', text: '旧消息没有表情', at: t0 + 1000, persona: 'night', kind: 'reply' },
    { id: 'new1', role: 'agent', agentId: 'orchestrator', text: '新消息有表情', at: t0 + 400_000, persona: 'night', kind: 'reply', expr: 'surprised' },
    { id: 'stk', role: 'agent', agentId: 'orchestrator', text: '带贴纸', at: t0 + 800_000, persona: 'night', kind: 'reply', expr: 'shy', react: 'butterfly' },
    { id: 'off', role: 'agent', agentId: 'orchestrator', text: '口吻关时说的话', at: t0 + 1_200_000, kind: 'reply' },
  ];
  store.update((d) => { d.tasks[tid].messages = msgs; });
  const html = renderToStaticMarkup(createElement(Conversation, { taskId: tid, active: true, chat: true }));
  const arts = html.split(/<article class="ws-msg /);
  const art = (needle: string) => arts.find((a) => a.includes(needle)) ?? '';
  ok('旧消息：gentle、无角标', /data-expr="gentle"/.test(art('旧消息没有表情')) && !/data-badge/.test(art('旧消息没有表情')));
  ok('新消息：surprised + 角标', /data-expr="surprised"/.test(art('新消息有表情')) && /data-badge/.test(art('新消息有表情')));
  ok('带贴纸：头像 gentle、无角标、贴纸在 data-her 里', /data-expr="gentle"/.test(art('带贴纸')) && !/data-badge/.test(art('带贴纸')) && /data-sticker="butterfly"/.test(art('带贴纸')));
  ok('口吻关时说的话：没有头像（内容层语气）', !/data-her-avatar/.test(art('口吻关时说的话')));
  ok('全文本扫描：无标签残留、无禁词', !TAG_LEAK.test(html.replace(/surface:/g, '')) && !BAD_WORDS.test(html));
}
{
  const sq = renderToStaticMarkup(createElement(HerAvatar, { size: 56, expr: 'relaxed' }));
  ok('HerAvatar sq 56：带角标、裁切数值在行内', /data-badge/.test(sq) && sq.includes(`width:${FACE_CROP_CSS.width}%`));
  ok('HerAvatar 容器封顶 258（图 ≤349）', /width:258px/.test(renderToStaticMarkup(createElement(HerAvatar, { size: 900 }))));
  ok('HerAvatar full 封顶 349、无 overflow', (() => { const h = renderToStaticMarkup(createElement(HerAvatar, { size: 800, shape: 'full' })); return /width:349px/.test(h) && !/overflow/.test(h); })());
  ok('StickerImg 封顶 120', /width="120"/.test(renderToStaticMarkup(createElement(StickerImg, { id: 'like', size: 500 }))));
  // 系统行的数字来自 proactive.ts 写进 src.slots 的 silent / today / cap（不是 minutes / count）：两套名字都要认，否则「静默 8 分钟 · 今天 1/3」会丢数字
  ok('系统行认 proactive.ts 的槽位名（silent / today / cap）', (() => { const h = renderToStaticMarkup(createElement(SysLine, { kind: 'nudge', scene: 'nudge.doll', slots: { silent: 8, today: 1, cap: 3 } })); return /静默 8 分钟/.test(h) && /今天 1\/3/.test(h); })());
  ok('系统行也认 minutes / count 的写法；没有数字就不编', (() => {
    const a = renderToStaticMarkup(createElement(SysLine, { kind: 'nudge', scene: 'nudge.doll', slots: { minutes: 12, count: 2, cap: 3 } }));
    const b = renderToStaticMarkup(createElement(SysLine, { kind: 'nudge', scene: 'nudge.doll', slots: {} }));
    return /静默 12 分钟/.test(a) && /今天 2\/3/.test(a) && !/静默/.test(b) && !/今天 \d/.test(b);
  })());
  ok('AgentMark：<48 用 -s 图', /path-hunt-s\.webp/.test(renderToStaticMarkup(createElement(AgentMark, { agent: 'coder', size: 20 }))));
}

/* ═══════════════════════════ 5. CSS 静态扫描（D-10 外环只编码运行状态） ═══════════════════════════ */

section('T-CHAT D-10：外环颜色只来自运行状态（CSS 静态扫描）');
{
  const dir = path.resolve(process.cwd(), 'src', 'styles');
  const files = ['her.css', 'shell-her.css', 'agents-tarot.css'].filter((f) => fs.existsSync(path.join(dir, f)));
  ok('her.css 在', files.includes('her.css'));
  const offenders: string[] = [];
  const ringVars: string[] = [];
  for (const f of files) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const sel = m[1].trim();
      const body = m[2];
      // 按 data-expr 选中、又改了边框 / 外环 / 描边 / 光晕颜色的规则 = 外环在编码表情
      if (/\[data-expr/.test(sel) && /(box-shadow|border(-color)?|outline(-color)?)\s*:/.test(body)) offenders.push(`${f}: ${sel.slice(0, 60)}`);
      if (/\[data-ring/.test(sel)) for (const v of body.matchAll(/var\((--[\w-]+)\)/g)) ringVars.push(v[1]);
    }
  }
  ok('没有按 [data-expr] 改外环颜色的规则', offenders.length === 0, offenders.slice(0, 3).join(' | '));
  ok('[data-ring] 只引用 --ring-idle / --ring-work / --ring-wait', ringVars.every((v) => /^--ring-(idle|work|wait)$/.test(v)), [...new Set(ringVars.filter((v) => !/^--ring-(idle|work|wait)$/.test(v)))].join('、'));
}

/* ═══════════════════════════ 6. 动画规矩（施工图 §7.2） ═══════════════════════════ */

section('T-CHAT 动画规矩：窗口隐藏时暂停、减少动态时关闭（CSS 静态扫描）');
{
  const dir = path.resolve(process.cwd(), 'src', 'styles');
  const base = fs.readFileSync(path.join(dir, 'base.css'), 'utf8');
  ok('base.css 有全局的 html[data-window-hidden] * { animation-play-state: paused }（新动画自动被它管住）', /html\[data-window-hidden\]\s*\*[^{]*\{[^}]*animation-play-state:\s*paused/.test(base));
  // 被全屏程序盖住（窗口还显示着）：同样全局暂停——被盖住的窗口照样按刷新率出帧，会和全屏游戏抢合成（design/pet/bench/jitter）
  ok('base.css 被盖住时（html[data-window-covered] *）也全局暂停 CSS 动画', /html\[data-window-covered\]\s*\*[^{]*\{[^}]*animation-play-state:\s*paused/.test(base));
  {
    const src = (p: string) => fs.readFileSync(path.resolve(process.cwd(), p), 'utf8');
    const main = src('electron/main.cjs');
    const pre = src('electron/preload.cjs');
    const vis = src('src/lib/windowVisibility.ts');
    const amb = src('src/components/decor/Ambience.tsx');
    ok('主进程据桌宠报的前台程序（pet.frontApp：全屏或认得的游戏、在同一块屏上）判断被盖住，桌宠没开时退回「切走满 AWAY_MS」，探针模式从不算被盖住',
      /pet\.frontApp\(\)/.test(main) && /\(front\.fullscreen !== 'no' \|\| front\.isGame\) && onMyScreen\(/.test(main) && /Date\.now\(\) - blurredAt >= AWAY_MS/.test(main) && /if \(PROBE \|\|[^\n]*win\.isFocused\(\)\) return false/.test(main));
    ok('…变了就发 app:covered，页面每次第一帧好了都照实再发一遍，前台程序一变也重新判断',
      /webContents\.send\('app:covered', covered\)/.test(main) && /announceVisibility\(\);\s*announceCovered\(true\);/.test(main) && /onFrontApp: \(\) => announceCovered\(\)/.test(main));
    ok('preload 转给页面（onCovered），页面给 <html> 打 data-window-covered、不碰 document.hidden',
      /ipcRenderer\.on\('app:covered'/.test(pre) && /onCovered: \(fn\)/.test(pre) && /dataset\.windowCovered = '1'/.test(vis) && !/windowCovered[^\n]*document\.hidden/.test(vis));
    ok('落雪和蝶被盖住时也不动（Ambience 的 motion 带 !covered）', /fall: [^\n]*!covered/.test(amb) && /fly: [^\n]*!covered/.test(amb));
  }
  ok('base.css 有全局的减少动态规则（:root[data-motion="reduced"] * 的 animation-duration 近 0）——新动画自动被它管住', /:root\[data-motion="reduced"\]\s*\*[^{]*\{[^}]*animation-duration:\s*0\.001ms/.test(base));
  // 新样式文件里的动画：都是有限次的（没有 infinite 的常驻动画：省电、也不会在窗口隐藏时白白唤醒）
  const infinite: string[] = [];
  let animating = 0;
  for (const f of ['her.css', 'shell-her.css', 'agents-tarot.css'].filter((x) => fs.existsSync(path.join(dir, x)))) {
    const css = fs.readFileSync(path.join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const a = /(?:^|;)\s*animation\s*:\s*([^;]+)/.exec(m[2]);
      if (!a || /^none/.test(a[1].trim())) continue;
      animating += 1;
      if (/infinite/.test(a[1])) infinite.push(`${f}: ${m[1].trim().slice(0, 50)}`);
    }
  }
  ok(`新样式里的 ${animating} 条动画声明都是有限次的（没有 infinite 的常驻动画）`, infinite.length === 0, infinite.slice(0, 4).join(' | '));
}

/* ═══════════════════════════ 7. 验收状态只存在于开发构建 ═══════════════════════════ */

section('T-CHAT devFixture 只进开发构建（生产包里没有 window.__alight / applyFixture）');
{
  const walk = (d: string, out: string[] = []): string[] => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, out); else if (/\.(ts|tsx)$/.test(e.name)) out.push(f);
    }
    return out;
  };
  const src = path.resolve(process.cwd(), 'src');
  const importers = walk(src).filter((f) => /from\s+['"][^'"]*devFixture['"]|import\(\s*['"][^'"]*devFixture['"]\s*\)/.test(fs.readFileSync(f, 'utf8')));
  ok('src 里只有 App.tsx 引用 devFixture', importers.length === 1 && importers[0].endsWith('App.tsx'), importers.join('、'));
  const app = fs.readFileSync(path.join(src, 'App.tsx'), 'utf8');
  ok('引用写在 if (import.meta.env.DEV) 里（生产构建会把整段摘掉）', /import\.meta\.env\.DEV\)\s*void import\(\s*'\.\/components\/decor\/devFixture'\s*\)/.test(app));
  const fx = fs.readFileSync(path.join(src, 'components', 'decor', 'devFixture.ts'), 'utf8');
  ok('devFixture 只在 applyDevQuery 里挂 window.__alight（没有顶层副作用）', (fx.match(/window as unknown as \{ __alight/g) ?? []).length === 1 && !/^window\./m.test(fx));
}

/* ═══════════════════════════ 8. C1 回归（第 6 轮复核确认的问题） ═══════════════════════════ */

section('C1 回归：审批标签说「这一次要做的事」，不把高风险类别等同于不可逆');
{
  const ap = (o: Partial<Approval>): Approval => ({
    id: 'ap_t', runId: 'r', taskId: 't', stepId: 's', toolCallId: 'c', agentId: 'orchestrator', tool: 'shell', title: '运行命令', reason: '测试',
    preview: 'ls', previewKind: 'command', risk: 'high', status: 'pending', createdAt: NOW, ...o,
  });
  const safeCmds = ['ls', 'git status', 'ls -la && cat a.txt', 'git rm --cached a.txt', 'npm rm left-pad'];
  ok('shell 高风险的 ls / git status 等：标签是「待批 · 须亲批」，不写不可逆', safeCmds.every((c) => approvalTagText(ap({ preview: c })) === '待批 · 须亲批'),
    safeCmds.map((c) => `${c}=>${approvalTagText(ap({ preview: c }))}`).join(' | '));
  const irrev = ['rm -rf build', 'ls && rm a.txt', 'del release\\a.exe', 'Remove-Item -Recurse x', 'git push --force', 'git push origin main -f', 'git push --force-with-lease', 'git reset --hard HEAD~1', 'git clean -fd', 'git branch -D old', 'git stash drop', 'DROP TABLE users'];
  ok('能判定的不可逆命令都写「须亲批 · 不可逆」', irrev.every((c) => isIrreversible({ previewKind: 'command', preview: c })), irrev.filter((c) => !isIrreversible({ previewKind: 'command', preview: c })).join(' | '));
  ok('git（类别只是中）的 push --force 也写「须亲批 · 不可逆」', approvalTagText(ap({ tool: 'git', risk: 'medium', preview: 'git push --force origin main' })) === '须亲批 · 不可逆');
  const fine = ['git push origin main', 'git push -u origin feature', 'git push --tags', 'git log --oneline', 'git status'];
  ok('git push（不带 force）/ git log / git status 不判不可逆', fine.every((c) => !isIrreversible({ previewKind: 'command', preview: c })), fine.filter((c) => isIrreversible({ previewKind: 'command', preview: c })).join(' | '));
  ok('中风险的 diff 预览写「待批」；diff 预览里出现 rm 字样不下断言', approvalTagText(ap({ risk: 'medium', previewKind: 'diff', preview: '+rm -rf x' })) === '待批' && !isIrreversible({ previewKind: 'diff', preview: '-rm -rf x' }));
  store.init(fresh());
  const cardText = (a: Approval) => textOf(parse(renderToStaticMarkup(createElement(ApprovalCard, { approval: a }))));
  const lsCard = cardText(ap({ preview: 'ls' }));
  ok('审批卡（ls，shell 高风险）：标签「待批 · 须亲批」，没有「不可逆」', /待批 · 须亲批/.test(lsCard) && !/不可逆/.test(lsCard), lsCard.slice(0, 80));
  const pushCard = cardText(ap({ tool: 'git', risk: 'medium', preview: 'git push --force' }));
  ok('审批卡（git push --force，类别中）：标签「须亲批 · 不可逆」', /须亲批 · 不可逆/.test(pushCard), pushCard.slice(0, 80));
  const delCard = cardText(ap({ preview: 'del release\\a.exe' }));
  ok('审批卡（del，shell 高风险）：标签「须亲批 · 不可逆」', /须亲批 · 不可逆/.test(delCard));
}

section('C1 回归：系统行与问候的归类（sysKindOf / pillAfterOf）');
{
  const mk = (scene: string | undefined, o: Partial<Message> = {}): Message => ({
    id: 'm', role: 'agent', agentId: 'orchestrator', text: '嗯。', at: NOW, kind: 'note', persona: 'night', ...o,
    ...(scene ? { src: { id: scene, mode: 'chat' as const, scene } } : {}),
  });
  const greets = ['greet.am', 'greet.noon', 'greet.eve', 'greet.away', 'greet.first'];
  ok('休息关照降成的系统行 sys.rest → 休息关照（不是「她主动开口」）', sysKindOf(mk('sys.rest', { role: 'system', proactive: true, agentId: undefined })) === 'rest');
  ok('很晚降成的系统行 sys.late → 夜深提醒', sysKindOf(mk('sys.late', { role: 'system', proactive: true, agentId: undefined })) === 'late');
  ok('每日问候 greet.am / noon / eve / away / first（proactive:true）不带系统行', greets.every((sc) => sysKindOf(mk(sc, { proactive: true })) === undefined));
  ok('每日问候之后不出胶囊', greets.every((sc) => pillAfterOf(mk(sc, { proactive: true })) === 'other'));
  ok('greet.late 仍按「夜深」归（系统行 + 夜深胶囊）', sysKindOf(mk('greet.late', { proactive: true })) === 'late' && pillAfterOf(mk('greet.late', { proactive: true })) === 'late');
  ok('nudge.photo 模板话 → 她主动开口 + 搭话胶囊', sysKindOf(mk('nudge.photo', { proactive: true })) === 'nudge' && pillAfterOf(mk('nudge.photo', { proactive: true })) === 'nudge');
  ok('nudge.rest → 休息关照；late.c → 夜深', sysKindOf(mk('nudge.rest', { proactive: true })) === 'rest' && sysKindOf(mk('late.c', { proactive: true })) === 'late');
  ok('模型自己想的主动话（proactive 且没有出处）→ 她主动开口', sysKindOf(mk(undefined, { proactive: true })) === 'nudge');
  ok('普通回复没有系统行', sysKindOf(mk(undefined)) === undefined && sysKindOf(mk('done.w')) === undefined);
}

section('C1 回归：源码守卫（问候不调模型 / 遗物卡折叠态 / 退半步 / 焦点 / 小图光晕）');
{
  const read = (...f: string[]) => fs.readFileSync(path.resolve(process.cwd(), 'src', ...f), 'utf8');
  const stripC = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const chat = stripC(read('components', 'workspace', 'ChatWorkspace.tsx'));
  ok('ChatWorkspace 不再调 reply({greet:true})（问候只走 proactive.maybeGreet 的模板，先过总闸）', !/greet\s*:\s*true/.test(chat) && !/state\/live/.test(chat) && !/setTimeout/.test(chat));
  const cards = stripC(read('components', 'workspace', 'RunCards.tsx'));
  ok('RelicCard 的「已收下」每次渲染按 runId 查 takenRuns，不在挂载时抄进 state（切换运行不串）', /const taken = takenRuns\.has\(runId\)/.test(cards) && !/useState\(\(\) => takenRuns/.test(cards));
  const conv = stripC(read('components', 'workspace', 'Conversation.tsx'));
  ok('Conversation 的「她退半步」用 useRetreat（订阅输入法态 + quiet 到点翻回），不自己拼 selectRetreat', /useRetreat\(taskId\)/.test(conv) && !/selectRetreat/.test(conv) && !/compositionstart/.test(conv));
  ok('剧情框「收起」把焦点交给输入框（requestFocus composer）', /collapseStory[\s\S]{0,260}actions\.requestFocus\('composer'\)/.test(conv) && /onCollapse=\{collapseStory\}/.test(conv));
  const ma = stripC(read('components', 'workspace', 'MessageActions.tsx'));
  ok('「记住这个」表单收起后把焦点还给触发按钮（她的话 / 用户的话两处）', (ma.match(/giveBackFocus\(/g) ?? []).length >= 3 && /ref=\{memBtn\}/.test(ma) && /ref=\{openBtn\}/.test(ma));
  ok('「记住这个」输入框按 Esc 可关闭', /e\.key === 'Escape'[\s\S]{0,160}onDone\(\)/.test(ma));
  const css = fs.readFileSync(path.resolve(process.cwd(), 'src', 'styles', 'her.css'), 'utf8');
  ok('her.css：小图的 --hmark-tint 不用 none 占位（busy 的 var(--hmark-tint) drop-shadow(…) 才是合法滤镜列表）', !/--hmark-tint:\s*none/.test(css.replace(/\/\*[\s\S]*?\*\//g, '')));

  // 第 8 轮：对话流顶部——没有整条淡出（data-cut / makeCutMgr / IntersectionObserver）、吸顶名牌是不透明实底、下沿以下没有渐隐带
  const noC = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '');
  const wsCss = noC(fs.readFileSync(path.resolve(process.cwd(), 'src', 'styles', 'workspace.css'), 'utf8'));
  const herCss = noC(css);
  ok('对话流顶部：没有 data-cut / makeCutMgr / IntersectionObserver（气泡永远按正常版面显示，不藏不淡）', !/data-cut|makeCutMgr|cutMgr|IntersectionObserver/.test(conv + herCss + wsCss));
  const headRule = /\.her-stickhead\s*\{([^}]*)\}/.exec(herCss)?.[1] ?? '';
  ok('吸顶名牌条是不透明实底（var(--solid)），没有 backdrop-filter / 半透明玻璃', /background:\s*var\(--solid\)/.test(headRule) && !/backdrop-filter|--surface|--glass/.test(headRule));
  ok('滚动区遮罩 ≤ 6px，有吸顶名牌（data-stick）时不遮；名牌下沿没有渐隐带', /transparent 0, #000 [1-6]px/.test(wsCss) && /\.ws-conv__scroll\[data-stick\]\s*\{[^}]*mask-image:\s*none/.test(wsCss) && !/--her-stick/.test(conv + herCss + wsCss));
  ok('吸顶名牌按「本组最后一个元素的下沿」退场（HEAD_LEAVE），每次提交都重算，不只在 onScroll', /HEAD_LEAVE/.test(conv) && /useLayoutEffect\(\(\) => \{ syncHead\(\); \}\)/.test(conv));
  ok('吸顶名牌出现 / 退场没有过渡（reduced 下直接切换）', !/\.her-stickhead[^{]*\{[^}]*transition/.test(herCss));
}

console.log(`\n${failed ? 'FAILED' : 'OK'}：${passed} 通过，${failed} 失败`);
void actions;
process.exit(failed ? 1 : 0);
