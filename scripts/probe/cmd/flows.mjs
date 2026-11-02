// flows：验收流程 ①–⑪ 的断言版（施工图 §7.3；T）。
//   node scripts/probe/run.mjs flows --app-dir <--mode development 构建的副本> [--only 1,2,8] [--json <结果.json>] [--out <失败截图目录>]
// 一次启动跑完所有流程（每个流程开头用 applyFixture 把世界重置）；模型走本机假 Anthropic 服务（x_probe，API 方式），不花额度、不碰真实账号.
// 能自动断言的都断言；做不到的（真模型、真输入法、命令行路线需要真 claude.exe）在报告的 manual / unresolved 里点名.
//   ① 闲聊：假服务回 ⟦face:relaxed｜react:butterfly⟧…，气泡 / 流式过程中没有 ⟦、data-expr 对、同回合 ≤1 贴纸、中段标签被剥掉
//   ② 闲聊失败：httpError(500) → 报错卡无头像无贴纸，她的一句在卡外；报错不进下一轮的历史
//   ③ 工作：计划待批 → 批准 → 完成；计划卡 / 步骤 / 遗物卡原样、无意象；旁白写进对话流
//   ④ 待批卡：须亲批、卡内无头像、卡外一句；两步确认（API 方式没有工具，命令行路线的真实往返见 unresolved）
//   ⑤ 话量 s/m/l：点左栏单选，配额与口吻关（纯事实）
//   ⑥ 假服务记录的 system：话量块 / 标签协议 / 底线条款，口吻关后不再有「遐蝶」
//   ⑦ D-01…D-10 的运行时 DOM 断言（computed style、祖先 overflow、渲染边长、字号地板）
//   ⑧ Agent 页：停用审查 → 一句、3 秒收起；改模型 → 立刻一句；切话量页首语变化；四种引擎的牌面三态与说明
//   ⑨ 主动搭话与总闸：拨钟，静默 / 话量 / 安静时段 / 深夜 / 口吻关各自挡住；未回应不再说第二次
//   ⑩ 危机回合：无贴纸、无落蝶、头像 gentle、无胶囊
//   ⑪ 落蝶：「谢谢」在她陈述之后命中、不调模型；「好」在她提了个提议之后不命中
import path from 'node:path';
import { writeJson } from '../lib/ctx.mjs';
import { launchApp, removeDir } from '../lib/launch.mjs';
import { prepareProfile } from '../lib/profile.mjs';
import { clickSelector, evaluate, screenshot, sleep, waitUntil } from '../lib/page.mjs';
import { fakeServiceFiles } from '../lib/seed.mjs';
import { DEFAULT_CLOCK, applyFixture, clockSource, closeToasts, fxPrefs, runStep, setClock, waitDevApi, waitForQuiet } from '../lib/fx.mjs';
import { byLevel, httpError, reply, startFakeAnthropic } from '../fake-anthropic.mjs';

const J = JSON.stringify;
const ENGINE = `({ kind: 'live', provider: 'x_probe', auth: 'api', model: 'claude-probe-1', label: '探针假服务 · API' })`;
const GOAL = '整理 v0.2 的发布说明：按主题归类改动。';

/* ───────────── 页面侧小工具 ───────────── */

const st = (s, expr) => evaluate(s, `(() => { const S = window.__alight.store.get(); return ${expr}; })()`);
const tasks = (s) => st(s, 'JSON.stringify(Object.values(S.tasks).map((t) => ({ id: t.id, kind: t.kind, title: t.title, messages: t.messages, runIds: t.runIds })))').then(JSON.parse);
const task = async (s, id) => (await tasks(s)).find((t) => t.id === id);
const textOfPage = (s) => evaluate(s, 'document.body.innerText');

/** 页面里常驻的标签泄漏记录器：任何时刻 DOM 文字里出现 ⟦ / face: / react: 就记一笔. */
const LEAK_RECORDER = `(() => {
  if (window.__leakRec) { window.__leakRec.hits.length = 0; return; }
  const rec = (window.__leakRec = { hits: [] });
  const bad = /⟦|〚|face:|react:/;
  const check = () => { const t = (document.body.innerText || '').replace(/surface:/g, ''); const m = bad.exec(t); if (m) rec.hits.push(t.slice(Math.max(0, m.index - 20), m.index + 40)); };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true });
})()`;

async function reset(t, name = 'chat-empty', opts = {}) {
  const { s } = t;
  const o = { level: 'm', persona: true, theme: 'night', wallpaper: false, ...opts };
  if (!(await applyFixture(s, name, o))) throw new Error(`不认识的状态 ${name}`);
  await sleep(300);
  await closeToasts(s);
  t.fake.reset([], reply('好的，已收到。', { tokenDelayMs: 4 }));
}

async function newChat(t, goal) {
  return evaluate(t.s, `window.__alight.actions.createTask({ title: '', goal: ${J(goal)}, kind: 'chat', engine: ${ENGINE}, agentIds: ['orchestrator'], start: false })`);
}
const say = (t, id, text) => evaluate(t.s, `window.__alight.actions.sendMessage(${J(id)}, ${J(text)})`);

/** 等她的回复写完（最后一条她的话不在流式、有字，且至少 n 条她的话）. */
async function waitHer(t, id, n = 1, timeoutMs = 25000) {
  await waitUntil(t.s, `(() => { const S = window.__alight.store.get(); const ms = (S.tasks[${J(id)}] || {}).messages || []; const her = ms.filter((m) => m.role === 'agent' && m.kind !== 'error' && m.kind !== 'note' && (m.text || '').trim()); return her.length >= ${n} && !ms.some((m) => m.streaming); })()`, { timeoutMs, label: `${id} 的第 ${n} 条回复写完` });
  await sleep(250);
}
const herOf = (tk) => (tk?.messages ?? []).filter((m) => m.role === 'agent' && m.kind !== 'error' && m.kind !== 'note' && (m.text || '').trim());

/** 页面里把某条她的话所在的 <article> 拆成事实（头像表情、角标、贴纸、文字）. */
const articleFacts = (s, needle) => evaluate(s, `(() => {
  const a = [...document.querySelectorAll('article.ws-msg')].find((x) => (x.innerText || '').includes(${J(needle)}));
  if (!a) return null;
  const av = a.querySelector('[data-her-avatar]');
  return JSON.stringify({ expr: av ? av.dataset.expr : null, badge: !!a.querySelector('[data-badge]'), stickers: [...a.querySelectorAll('[data-sticker]')].map((x) => x.dataset.sticker), her: a.hasAttribute('data-her'), text: a.innerText.slice(0, 200) });
})()`).then((x) => (x ? JSON.parse(x) : null));

/** 重载页面（保留用户数据目录与 init 脚本里的拨钟）：回到「刚启动」的模块内存状态. */
async function reloadApp(t) {
  await t.s.send('Page.reload');
  await sleep(800);
  await waitDevApi(t.s);
  await waitUntil(t.s, `!!window.__alight.store.get().models.providers.x_probe`, { timeoutMs: 20000, label: '重载后假服务登记成 x_probe' });
  await sleep(1800);
}

function check(list, name, pass, detail = '', severity = 'must') { list.push({ name, pass: !!pass, severity, detail }); }

/* ───────────── 流程 ───────────── */

const FLOWS = [];
const flow = (n, title, fn) => FLOWS.push({ n, title, fn });

flow(1, '闲聊：开头标签、中段标签、流式过程不泄漏、贴纸 ≤1', async (t) => {
  const { s, fake } = t;
  const c = [];
  await reset(t);
  fake.reset([], reply('⟦face:relaxed｜react:butterfly⟧嗯……听起来是件好事。\n\n后来呢，⟦face:shy⟧慢慢说就好。', { tokenDelayMs: 14, chunkChars: 3 }));
  await evaluate(s, LEAK_RECORDER);
  const id = await newChat(t, '今天终于把发布说明写完了。');
  await waitHer(t, id);
  const her = herOf(await task(s, id)).at(-1);
  check(c, '存下来的话里没有 ⟦ / face: / react:', !/⟦|〚|face:|react:/.test(her.text), her.text);
  check(c, '中段的 ⟦face:shy⟧ 被剥掉，正文连起来读得通', /后来呢，慢慢说就好/.test(her.text) || /后来呢，\s*慢慢说就好/.test(her.text), her.text);
  check(c, '开头标签定下神色：expr = relaxed', her.expr === 'relaxed', `expr=${her.expr}`);
  const hits = await evaluate(s, 'JSON.stringify(window.__leakRec.hits)').then(JSON.parse);
  check(c, '流式写的整个过程里，页面文字从没出现过标签（含写到一半的 ⟦）', hits.length === 0, hits.slice(0, 2).join(' | '));
  const f = await articleFacts(s, '听起来是件好事');
  check(c, '她的话在 [data-her] 里、头像在', f?.her === true && f.expr !== null, J(f));
  check(c, '同回合贴纸 ≤1', (f?.stickers.length ?? 0) <= 1, J(f?.stickers));
  if (f?.stickers.length) check(c, '带贴纸的消息：头像 gentle、无角标（D19）', f.expr === 'gentle' && f.badge === false, J(f));
  else check(c, '没带贴纸的消息：头像 = 标签里的 relaxed，带角标', f?.expr === 'relaxed' && f.badge === true, J(f));
  check(c, 'DOM 文字里没有 ⟦', !/⟦|〚/.test(await textOfPage(s)));
  return { checks: c };
});

flow(2, '闲聊失败：报错卡无头像无贴纸，她的一句在卡外，报错不进下一轮历史', async (t) => {
  const { s, fake } = t;
  const c = [];
  await reset(t);
  fake.reset([], httpError(500, '服务暂时不可用', 'api_error'));
  const id = await newChat(t, '帮我看看发布说明。');
  await waitUntil(s, `!!document.querySelector('[data-card="error"]')`, { timeoutMs: 60000, label: '报错卡出现' });
  await sleep(500);
  const tk = await task(s, id);
  const err = tk.messages.find((m) => m.kind === 'error');
  const lead = tk.messages.find((m) => m.kind === 'note' && /^fail\./.test(m.src?.scene ?? ''));
  check(c, '有一条 kind=error 的失败事实', !!err, J(tk.messages.map((m) => `${m.kind}:${m.text.slice(0, 12)}`)));
  check(c, '另有一条她的一句（kind=note，出处 fail.*）——拆成两条', !!lead, J(tk.messages.map((m) => `${m.kind}:${m.src?.scene ?? ''}`)));
  const dom = await evaluate(s, `JSON.stringify((() => {
    const card = document.querySelector('[data-card="error"]');
    const lead = document.querySelector('.her-leadrow');
    return { cardHasAvatar: !!card.querySelector('[data-her-avatar],[data-sticker],[data-expr],[data-badge]'), leadBefore: !!lead && !!(lead.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING),
      leadAvatar: lead ? (() => { const a = lead.querySelector('[data-her-avatar]'); return a ? { w: Math.round(a.getBoundingClientRect().width), expr: a.dataset.expr } : null; })() : null, stickers: document.querySelectorAll('[data-sticker]').length };
  })())`).then(JSON.parse);
  check(c, '报错卡里没有头像 / 贴纸 / 表情 / 角标', !dom.cardHasAvatar);
  check(c, '她的一句在卡外、在报错卡之前', dom.leadBefore);
  // 闲聊回不上话走 chat.error → fail.c，台词库里三档都标 confused（线路出了问题，§3.4-1「外部原因失败 → confused」）；工作里的非外部失败（fail.w 等）才是 gentle
  const wantExpr = ['fail.ext', 'fail.c'].includes(lead?.src?.scene) ? 'confused' : 'gentle';
  check(c, `卡外那一句带 40 px 头像、${wantExpr}（HerLead 的 LEAD_AVATAR；场景 ${lead?.src?.scene}）`, dom.leadAvatar?.w === 40 && dom.leadAvatar?.expr === wantExpr, J({ ...dom.leadAvatar, scene: lead?.src?.scene }));
  check(c, '整页没有贴纸', dom.stickers === 0);
  // 下一轮：失败事实不进模型的历史（chatHistory 跳过 error）
  fake.reset([], reply('收到。', { tokenDelayMs: 4 }));
  await say(t, id, '再试一次。');
  await fake.waitForRequests(1, 20000);
  const body = JSON.stringify(fake.requests.at(-1)?.body?.messages ?? []);
  check(c, '下一轮发给模型的历史里没有「没能回复：」的报错文字', !/没能回复/.test(body), body.slice(0, 200));
  return { checks: c };
});

flow(3, '工作：计划待批 → 批准 → 完成（计划卡 / 遗物卡原样，旁白写进对话流）', async (t) => {
  const { s, fake } = t;
  const c = [];
  await reset(t);
  const plan = '收到……我先把需求理一遍。\n\n```json\n{"steps":[{"title":"整理改动","detail":"把 38 条改动按主题归类","agent":"orchestrator"},{"title":"写发布说明","detail":"写成一页 Markdown","agent":"orchestrator"}]}\n```';
  fake.reset([reply(plan, { tokenDelayMs: 3 }), reply('已整理：新增、调整、修复三类。', { tokenDelayMs: 3 }), reply('发布说明已写好。', { tokenDelayMs: 3 }), reply('全部完成：共两步。', { tokenDelayMs: 3 })], reply('好的。'));
  const id = await evaluate(s, `window.__alight.actions.createTask({ title: '整理发布说明', goal: ${J(GOAL)}, kind: 'work', engine: ${ENGINE}, agentIds: ['orchestrator'], start: true })`);
  await waitUntil(s, `(() => { const S = window.__alight.store.get(); const t = S.tasks[${J(id)}]; const r = t && S.runs[t.runIds.at(-1)]; return !!r && r.planApproval && r.planApproval.status === 'pending'; })()`, { timeoutMs: 40000, label: '计划等你批准' });
  await closeToasts(s);
  await sleep(500);
  const dom1 = await evaluate(s, `JSON.stringify((() => {
    const plan = document.querySelector('[data-card="plan"]');
    return { planText: plan ? plan.innerText : '', planAvatar: plan ? !!plan.querySelector('[data-her-avatar],[data-sticker],[data-badge]') : null, approve: [...document.querySelectorAll('button')].some((b) => /批准计划/.test(b.innerText)) };
  })())`).then(JSON.parse);
  check(c, '计划卡在，两步的标题原样（说明写在「执行步骤」页，计划卡只列标题）', /第 1 步[\s\S]*整理改动/.test(dom1.planText) && /第 2 步[\s\S]*写发布说明/.test(dom1.planText), dom1.planText.slice(0, 160));
  check(c, '计划卡里没有头像 / 贴纸 / 角标，也没有意象词', dom1.planAvatar === false && !/[蝶花灯星针线缝冥河]/.test(dom1.planText.replace(/任务计划|批准|计划/g, '')), dom1.planText.slice(0, 100));
  check(c, '有「批准计划」按钮', dom1.approve);
  const mid = await task(s, id);
  check(c, '计划之前有她的引言（plan 消息）', mid.messages.some((m) => m.kind === 'plan' && m.role === 'agent'), J(mid.messages.map((m) => m.kind)));
  await clickSelector(s, 'button.btn--primary').catch(() => {});   // 兜底，下面按文字点
  await evaluate(s, `(() => { const b = [...document.querySelectorAll('button')].find((x) => /批准计划/.test(x.innerText)); if (b) b.click(); return !!b; })()`);
  await waitUntil(s, `(() => { const S = window.__alight.store.get(); const t = S.tasks[${J(id)}]; const r = t && S.runs[t.runIds.at(-1)]; return !!r && r.status === 'completed'; })()`, { timeoutMs: 60000, label: '运行完成' });
  await sleep(800);
  await closeToasts(s);
  const done = await task(s, id);
  const scenes = done.messages.filter((m) => m.role === 'agent' && m.kind === 'note').map((m) => m.src?.scene);
  check(c, '开始时写了一句（task.start）', scenes.some((x) => x === 'task.start'), J(scenes));
  check(c, '完成时写了一句（done.*）', scenes.some((x) => /^done\./.test(x ?? '')), J(scenes));
  const dom2 = await evaluate(s, `JSON.stringify((() => {
    const relic = document.querySelector('[data-card="relic"]');
    const plan = document.querySelector('[data-card="plan"]');
    return { relic: !!relic, relicAvatar: relic ? !!relic.querySelector('[data-her-avatar],[data-sticker],[data-badge]') : null, relicText: relic ? relic.innerText.slice(0, 160) : '', folded: !!plan && plan.getAttribute('data-folded') === 'true', planText: plan ? plan.innerText : '' };
  })())`).then(JSON.parse);
  check(c, '完成后出遗物卡，卡内无头像 / 贴纸', dom2.relic && dom2.relicAvatar === false, dom2.relicText);
  // 计划不在等批准时，窄栏下收成一行摘要（「计划 · 2 步　2/2 完成 ▸ 展开」），步骤标题不在 innerText 里：
  // 收着时只核摘要；点「展开」后比对步骤标题；再到「执行步骤」页核对每一步的标题与顺序.
  if (dom2.folded) check(c, '计划不在等批准时收成一行摘要：写着步数和完成数', /计划\s*·\s*2\s*步/.test(dom2.planText) && /2\/2\s*完成/.test(dom2.planText), dom2.planText.slice(0, 80));
  await evaluate(s, `(() => { const p = document.querySelector('[data-card="plan"][data-folded="true"] .ws-plan__sum'); if (p) p.click(); return !!p; })()`);
  await sleep(350);
  const planText = await evaluate(s, `(document.querySelector('[data-card="plan"]') || {}).innerText || ''`);
  check(c, '计划卡（展开后）的步骤标题没变，顺序不变', /整理改动[\s\S]*写发布说明/.test(planText), planText.slice(0, 160));
  await evaluate(s, `(() => { const b = [...document.querySelectorAll('[role="tab"]')].find((x) => /执行步骤/.test(x.innerText)); if (b) b.click(); return !!b; })()`);
  await sleep(450);
  const stepsText = await evaluate(s, `(document.querySelector('.ws-steps') || {}).innerText || ''`);
  check(c, '「执行步骤」页：两步的标题原样、顺序不变，共 2 步', /共\s*2\s*步/.test(stepsText) && /整理改动[\s\S]*写发布说明/.test(stepsText), stepsText.slice(0, 160));
  return { checks: c, manual: ['真模型下计划 JSON 的遵守率（eval-voice 抽样）'] };
});

flow(4, '待批卡：须亲批、卡内无头像、卡外一句、两步确认', async (t) => {
  const { s } = t;
  const c = [];
  await reset(t, 'work-approval-high');
  await sleep(500);
  const d = await evaluate(s, `JSON.stringify((() => {
    const card = document.querySelector('[data-card="approval"]');
    if (!card) return null;
    const lead = document.querySelector('.her-leadrow, .her-lead');
    const la = lead && lead.querySelector('[data-her-avatar]');
    return {
      text: card.innerText, avatarIn: !!card.querySelector('[data-her-avatar],[data-sticker],[data-expr],[data-badge]'),
      leadBefore: !!lead && !!(lead.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING), leadW: la ? Math.round(la.getBoundingClientRect().width) : null, leadExpr: la ? la.dataset.expr : null,
      cmd: (card.querySelector('pre, code') || {}).innerText || '',
    };
  })())`).then((x) => JSON.parse(x ?? 'null'));
  check(c, '待批（高）：审批卡在', !!d);
  if (!d) return { checks: c };
  check(c, '标注「须亲批」', /须亲批/.test(d.text), d.text.slice(0, 120));
  check(c, '指令原样、完整', /Alight-Setup-0\.1\.1\.exe/.test(d.cmd) && /Alight-Setup-0\.1\.4\.exe/.test(d.cmd), d.cmd);
  check(c, '卡内没有头像 / 贴纸 / 表情 / 角标', !d.avatarIn);
  check(c, '卡外一句在卡之前，40 px 头像、gentle', d.leadBefore && d.leadW === 40 && d.leadExpr === 'gentle', J({ before: d.leadBefore, w: d.leadW, e: d.leadExpr }));
  // 两步确认：第一次按「批准」只进入确认态，不会直接批
  const before = await st(s, `Object.values(S.runs)[0].approvals.filter((a) => a.status === 'pending').length`);
  await evaluate(s, `(() => { const b = [...document.querySelectorAll('[data-card="approval"] button')].find((x) => /批准/.test(x.innerText)); if (b) b.click(); return !!b; })()`);
  await sleep(400);
  const after1 = await st(s, `Object.values(S.runs)[0].approvals.filter((a) => a.status === 'pending').length`);
  check(c, '第一次按「批准」没有直接放行（两步确认）', before === 1 && after1 === 1, `待批 ${before} → ${after1}`);
  const label = await evaluate(s, `(() => { const card = document.querySelector('[data-card="approval"]'); return card ? [...card.querySelectorAll('button')].map((b) => b.innerText.trim()).join('|') : ''; })()`);
  check(c, '进入确认态后按钮文字变了（要再确认一次）', /确认|再按|真的/.test(label), label);
  const none = await evaluate(s, `!document.querySelector('[data-card="approval"] [data-her-avatar]')`);
  check(c, '确认态里卡内仍然没有头像', none);
  return { checks: c, unresolved: ['命令行路线（claude-compat + 真 claude.exe）的真实往返：待批卡由 hook-probe/driver-check（E）覆盖，Electron 探针里没有挂真命令行'] };
});

flow(5, '话量 少/中/多：点左栏单选，贴纸配额，口吻关 = 纯事实', async (t) => {
  const { s, fake } = t;
  const c = [];
  const CAP = { s: 1, m: 2, l: 4 };
  for (const level of ['s', 'm', 'l']) {
    await reset(t, 'chat-empty', { level: level === 's' ? 'm' : 's' });   // 先放在别的档，再用左栏点过去
    await evaluate(s, `(() => { const b = [...document.querySelectorAll('.side-nav__voice-opts button[role="radio"]')].find((x) => x.innerText.trim() === ${J({ s: '少', m: '中', l: '多' }[level])}); if (b) b.click(); return !!b; })()`);
    await sleep(300);
    await closeToasts(s);
    const got = await st(s, 'JSON.stringify({ level: S.settings.level, distance: S.settings.distance, persona: S.settings.persona })').then(JSON.parse);
    const checked = await evaluate(s, `[...document.querySelectorAll('.side-nav__voice-opts button[role="radio"]')].filter((b) => b.getAttribute('aria-checked') === 'true').map((b) => b.innerText.trim()).join()`);
    check(c, `点「${{ s: '少', m: '中', l: '多' }[level]}」：level=${level}，aria-checked 只在它身上，distance 垫片 = ${level === 'l' ? 2 : 1}`, got.level === level && got.distance === (level === 'l' ? 2 : 1) && checked === { s: '少', m: '中', l: '多' }[level], J({ got, checked }));
    // 配额：连发 5 句，假服务每句都带贴纸建议；整会话贴纸数不得超过该档上限
    fake.reset([], reply('⟦face:shy｜react:like⟧嗯，我在听。', { tokenDelayMs: 3 }));
    const id = await newChat(t, '先说一件小事。');
    await waitHer(t, id, 1);
    for (let i = 2; i <= 5; i++) { await say(t, id, ['再说一点。', '还有一件。', '最后一件。', '就这些。'][i - 2]); await waitHer(t, id, i); }
    const n = await evaluate(s, `document.querySelectorAll('[data-sticker]').length`);
    check(c, `${level} 档：5 轮回复里贴纸总数 ≤ ${CAP[level]}（实际 ${n}）`, n <= CAP[level], `n=${n}`);
    const tk = await task(s, id);
    const reacts = herOf(tk).filter((m) => m.react).length;
    check(c, `${level} 档：存下来带 react 的话 ≤ ${CAP[level]}（${reacts}）`, reacts <= CAP[level], `react=${reacts}`);
  }
  // 口吻关：左栏的话量仍可点；她说的是纯事实，没有头像、表情、贴纸
  await reset(t, 'chat-empty', { level: 'm' });
  await evaluate(s, `window.__alight.actions.setPersona(false)`);
  await sleep(200);
  await closeToasts(s);
  fake.reset([], reply('⟦face:shy｜react:like⟧已收到。', { tokenDelayMs: 3 }));
  const id = await newChat(t, '帮我看看发布说明。');
  await waitHer(t, id, 1);
  const dom = await evaluate(s, `JSON.stringify({ avatars: document.querySelectorAll('.ws-conv [data-her-avatar]').length, stickers: document.querySelectorAll('[data-sticker]').length, leak: /⟦|face:|react:/.test((document.body.innerText || '').replace(/surface:/g, '')) })`).then(JSON.parse);
  check(c, '口吻关：对话里没有她的头像、没有贴纸，标签也不外露', dom.avatars === 0 && dom.stickers === 0 && !dom.leak, J(dom));
  const her = herOf(await task(s, id)).at(-1);
  check(c, '口吻关：存下来的话没有 persona / expr / react', !her.persona && !her.expr && !her.react, J({ p: her.persona, e: her.expr, r: her.react }));
  return { checks: c, manual: ['话量「少」的配额只在完成 / 道谢才出贴纸；真模型下是否守「少 ≤26 字」看 eval-voice'] };
});

flow(6, '假服务记录的 system：话量块、标签协议、底线条款；口吻关后不再有「遐蝶」', async (t) => {
  const { s, fake } = t;
  const c = [];
  const LV = { s: '少', m: '中', l: '多' };
  for (const level of ['s', 'm', 'l']) {
    await reset(t, 'chat-empty', { level });
    fake.reset([], reply('好的。', { tokenDelayMs: 3 }));
    const id = await newChat(t, '随便聊聊。');
    await waitHer(t, id, 1);
    const sys = fake.requests.at(-1)?.system ?? '';
    check(c, `${level} 档：system 里有「【话量：${LV[level]}】」`, sys.includes(`【话量：${LV[level]}】`), sys.slice(0, 120));
    if (level === 'm') {
      check(c, '含「遐蝶」', /遐蝶/.test(sys));
      check(c, '含开头标签协议（⟦face:）', /⟦face:/.test(sys));
      check(c, '含「诚实与边界」', /诚实与边界/.test(sys));
      check(c, '含求助热线 12356', /12356/.test(sys));
      check(c, '含底线条款（不挽留）', /挽留/.test(sys));
      check(c, '不含「流萤 / 萨姆 / 萤火 / 措辞正式」', !/流萤|萨姆|萤火|措辞正式/.test(sys));
    }
  }
  await reset(t, 'chat-empty', { level: 'm' });
  await evaluate(s, `window.__alight.actions.setPersona(false)`);
  await sleep(200);
  fake.reset([], reply('好的。', { tokenDelayMs: 3 }));
  const id = await newChat(t, '随便聊聊。');
  await waitHer(t, id, 1);
  const sys = fake.requests.at(-1)?.system ?? '';
  check(c, '口吻关：system 不含「遐蝶」', !/遐蝶/.test(sys), sys.slice(0, 160));
  check(c, '口吻关：system 不含标签协议', !/⟦face:/.test(sys));
  // 夜昼块
  await reset(t, 'chat-empty', { level: 'm', theme: 'day' });
  fake.reset([], reply('好的。', { tokenDelayMs: 3 }));
  const id2 = await newChat(t, '随便聊聊。');
  await waitHer(t, id2, 1);
  const day = fake.requests.at(-1)?.system ?? '';
  await reset(t, 'chat-empty', { level: 'm', theme: 'night' });
  fake.reset([], reply('好的。', { tokenDelayMs: 3 }));
  const id3 = await newChat(t, '随便聊聊。');
  await waitHer(t, id3, 1);
  const night = fake.requests.at(-1)?.system ?? '';
  check(c, '昼与夜的 system 不同（夜昼块），且都是同一个人', day !== night && /遐蝶/.test(day) && /遐蝶/.test(night));
  return { checks: c };
});

flow(7, 'D-01…D-10 运行时 DOM 断言（computed style、祖先 overflow、渲染边长、字号地板）', async (t) => {
  const { s } = t;
  const c = [];
  const SCAN = `JSON.stringify((() => {
    const out = { fails: [] };
    const fail = (rule, where) => out.fails.push(rule + ' @ ' + where);
    const CARD = new Set(['plan', 'step', 'tool', 'approval', 'error', 'relic', 'letter', 'brief']);
    // D-01
    for (const card of document.querySelectorAll('[data-card]')) if (CARD.has(card.dataset.card) && card.querySelector('[data-her-avatar],[data-sticker],[data-expr],[data-badge]')) fail('D-01', card.dataset.card);
    // D-02
    for (const sk of document.querySelectorAll('[data-sticker]')) if (!sk.closest('[data-her]')) fail('D-02 贴纸不在 data-her 里', sk.dataset.sticker);
    const arts = new Map();
    for (const sk of document.querySelectorAll('[data-sticker]')) { const a = sk.closest('article'); if (a) arts.set(a, (arts.get(a) || 0) + 1); }
    for (const [a, n] of arts) { if (n > 1) fail('D-02 一条消息 >1 贴纸', String(n)); if (a.querySelector('[data-badge]') || [...a.querySelectorAll('[data-her-avatar]')].some((x) => x.dataset.expr !== 'gentle')) fail('D19 贴纸消息头像', a.className); }
    // D-03 sq：computed 的裁切
    for (const av of document.querySelectorAll('[data-her-avatar][data-shape="sq"]')) {
      const clip = av.querySelector('.hface__clip'); const img = av.querySelector('img.hface__img');
      if (!img || !clip) { fail('D-03 sq 缺图', ''); continue; }
      const cw = av.getBoundingClientRect().width; const iw = img.getBoundingClientRect().width; const il = parseFloat(getComputedStyle(img).left); const it = parseFloat(getComputedStyle(img).top);
      if (cw < 1) continue;
      if (Math.abs(iw / cw - 1.351) > 0.02) fail('D-03 图宽 / 容器宽 ≠ 1.351', (iw / cw).toFixed(3));
      if (Math.abs(il / cw + 0.179) > 0.01) fail('D-03 left ≠ -17.9%', (il / cw).toFixed(3));
      if (Math.abs(it) > 0.6) fail('D-03 top ≠ 0', String(it));
      const r = av.getBoundingClientRect();
      if (r.width <= 72 && !av.querySelector('[data-badge]') && !av.closest('article') ) { /* 页头 / 右栏的小头像由静态检查按规则覆盖 */ }
      if (iw > 349.5) fail('D-04 sq 图宽 >349', String(iw));
    }
    // D-03 full：图片外接盒必须完整落在所有祖先的 overflow 裁切框里
    for (const av of document.querySelectorAll('[data-her-avatar][data-shape="full"]')) {
      const img = av.querySelector('img'); if (!img) continue;
      const r = img.getBoundingClientRect();
      for (let p = img.parentElement; p; p = p.parentElement) {
        const cs = getComputedStyle(p);
        if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
        const pr = p.getBoundingClientRect();
        if (r.left < pr.left - 1 || r.right > pr.right + 1 || r.top < pr.top - 1 || r.bottom > pr.bottom + 1) fail('D-03 full 头像被祖先 overflow 裁切', (p.className || p.tagName).toString().slice(0, 40) + ' img=' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ' box=' + [pr.left, pr.top, pr.right, pr.bottom].map(Math.round));
      }
      if (r.width > 349.5) fail('D-04 full 图宽 >349', String(r.width));
    }
    // D-04：所有 img 渲染边长 ≤ 自然边长
    for (const img of document.images) {
      if (!img.complete || !img.naturalWidth) continue;
      const r = img.getBoundingClientRect(); if (r.width < 1) continue;
      if (r.width > img.naturalWidth + 0.5 || r.height > img.naturalHeight + 0.5) fail('D-04 渲染边长 > 自然边长', img.src.split('/').pop() + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' > ' + img.naturalWidth + 'x' + img.naturalHeight);
      // 背景大拱窗 .daystage__fig（昼）/ .nightstage__fig（夜，壁纸关）是装饰层、不是「她的立绘」：渲染 923 < 原图 1181（上一条已守「不超过原图」），不套「立绘 ≤349」.
      if (/face-|figure-official/.test(img.src) && !img.classList.contains('daystage__fig') && !img.classList.contains('nightstage__fig') && r.width > 349.5) fail('D-04 立绘类 >349', img.src.split('/').pop() + ' ' + Math.round(r.width));
      if (/sticker-/.test(img.src) && r.width > 120.5) fail('D-04 贴纸 >120', Math.round(r.width) + '');
    }
    // D-05
    for (const m of document.querySelectorAll('[data-agent-mark]')) { const i = m.tagName === 'IMG' ? m : m.querySelector('img'); if (!i || !/her\\/path-/.test(i.src)) fail('D-05', i ? i.src : '无 img'); }
    // D-06
    const text = (document.body.innerText || '').replace(/surface:/g, '');
    if (/银手套|黑档|黑色审批卡/.test(text)) fail('D-06 禁词', (/银手套|黑档|黑色审批卡/.exec(text) || [''])[0]);
    if (/⟦|〚|face:|react:/.test(text)) fail('D-06 标签残留', (/⟦|〚|face:|react:/.exec(text) || [''])[0]);
    // D-09：牌面字号 ≥12、不截断
    for (const face of document.querySelectorAll('.tarot-face')) {
      const walker = document.createTreeWalker(face, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!(n.textContent || '').trim()) continue;
        const el = n.parentElement; const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        if (parseFloat(cs.fontSize) < 12) fail('D-09 牌面字号 <12', (n.textContent || '').trim().slice(0, 8) + ' ' + cs.fontSize);
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) fail('D-09 牌面文字被截断', (n.textContent || '').trim().slice(0, 12));
      }
    }
    out.counts = { avatars: document.querySelectorAll('[data-her-avatar]').length, stickers: document.querySelectorAll('[data-sticker]').length, cards: document.querySelectorAll('[data-card]').length, faces: document.querySelectorAll('.tarot-face').length };
    return out;
  })())`;
  const STATES = ['chat-reply', 'chat-sticker', 'chat-error', 'chat-crisis', 'chat-folded', 'work-approval-high', 'work-done', 'work-failed', 'work-plan-pending', 'work-running', 'return-brief', 'agents-idle', 'agents-busy', 'agents-codex', 'agents-dsh'];
  let n = 0;
  const fails = [];
  const seen = { avatars: 0, stickers: 0, cards: 0, faces: 0 };
  for (const theme of ['night', 'day']) {
    for (const fx of STATES) {
      await reset(t, fx, { level: 'm', theme });
      await sleep(450);
      const r = await evaluate(s, SCAN).then(JSON.parse);
      n += 1;
      for (const k of Object.keys(seen)) seen[k] += r.counts[k];
      for (const f of r.fails) fails.push(`${theme}/${fx}: ${f}`);
    }
  }
  check(c, '扫描不是空转：这些页面上共有头像 / 贴纸 / 内容层卡 / 牌面（各自 >0）', seen.avatars > 40 && seen.stickers >= 2 && seen.cards > 20 && seen.faces >= 16, J(seen));
  check(c, `${n} 个页面（夜昼 × ${STATES.length} 个状态）：D-01 / D-02 / D-03 / D-04 / D-05 / D-06 / D-09 在真实 DOM 上无违规`, fails.length === 0, fails.slice(0, 8).join('\n         '));
  // D-03 full 的龛：右栏立绘龛（HerHeader）单独看一遍（夜 + 昼，宽窗口）
  const niche = [];
  for (const theme of ['night', 'day']) {
    await reset(t, 'chat-reply', { level: 'm', theme });
    await sleep(500);
    const r = await evaluate(s, `JSON.stringify((() => {
      const av = document.querySelector('.status-panel [data-her-avatar][data-shape="full"], [data-her-avatar][data-shape="full"]');
      if (!av) return { has: false };
      const img = av.querySelector('img'); const r = img.getBoundingClientRect();
      const chain = []; for (let p = img.parentElement; p; p = p.parentElement) { const cs = getComputedStyle(p); if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') { const pr = p.getBoundingClientRect(); chain.push({ cls: (p.className || '').toString().slice(0, 30), ok: r.left >= pr.left - 1 && r.right <= pr.right + 1 && r.top >= pr.top - 1 && r.bottom <= pr.bottom + 1 }); } }
      return { has: true, w: Math.round(r.width), chain, credit: !!document.querySelector('[data-credit]') };
    })())`).then(JSON.parse);
    niche.push([theme, r]);
  }
  check(c, '右栏立绘龛：有 full 头像，宽 ≤349，任何裁切祖先都没切到图（整张原图不裁；原图冠顶本身贴边）', niche.every(([, r]) => r.has && r.w <= 349 && r.chain.every((x) => x.ok)), J(niche));
  // D-10：同一外环状态、不同表情，外环样式相同（对照板里六个表情）
  await applyFixture(s, 'avatar-crop', { level: 'm', persona: true, theme: 'night', wallpaper: false });
  await sleep(800);
  const rings = await evaluate(s, `JSON.stringify((() => {
    const bySize = {};
    for (const av of document.querySelectorAll('#fx-avatar-crop [data-her-avatar][data-shape="sq"]')) {
      const w = Math.round(av.getBoundingClientRect().width);
      const clip = av.querySelector('.hface__clip'); const cs = getComputedStyle(clip); const cs2 = getComputedStyle(av);
      (bySize[w] ||= []).push({ expr: av.dataset.expr, ring: av.dataset.ring, style: [cs.boxShadow, cs.borderColor, cs.outlineColor, cs2.boxShadow, cs2.outlineColor].join('|') });
    }
    return bySize;
  })())`).then(JSON.parse);
  const sizes = Object.keys(rings);
  check(c, 'D-10：同尺寸、同外环状态下，六个表情的外环样式完全相同（外环不随表情变色）', sizes.length >= 3 && sizes.every((w) => rings[w].length === 6 && new Set(rings[w].map((x) => x.style)).size === 1), J(rings).slice(0, 300));
  // D-03：对照板里三种尺寸 × 六个表情的裁切（同上扫描，另算）
  const crop = await evaluate(s, SCAN).then(JSON.parse);
  check(c, 'avatar-crop 对照板：sq 裁切 / 尺寸 / full 龛都合规', crop.fails.length === 0, crop.fails.slice(0, 4).join(' | '));
  await applyFixture(s, 'none');
  // 署名：Agent 页主牌 data-credit="moon"，落在牌内，没压住别的 UI
  await reset(t, 'agents-idle', { level: 'm', theme: 'night' });
  await sleep(500);
  const moon = await evaluate(s, `JSON.stringify((() => {
    const el = document.querySelector('[data-credit="moon"]'); if (!el) return null;
    const r = el.getBoundingClientRect(); const host = el.closest('.tarot-card'); const h = host.getBoundingClientRect();
    return { inside: r.left >= h.left - 1 && r.right <= h.right + 1 && r.top >= h.top - 1 && r.bottom <= h.bottom + 1, visible: r.width > 4 && r.height > 4, text: el.innerText };
  })())`).then((x) => JSON.parse(x ?? 'null'));
  check(c, 'D-08：Agent 页主牌署名 data-credit="moon" 可见、落在牌内', !!moon && moon.inside && moon.visible && /官方/.test(moon.text), J(moon));
  return { checks: c, manual: ['荆棘冠是否被裁：用 avatar-crop 与右栏龛截图人看一眼（computed 只能证明外接盒没被切）'] };
});

flow(8, 'Agent 页：停用 → 一句并 3 秒收起；改模型 → 立刻一句；切话量；四种引擎的牌面三态', async (t) => {
  const { s } = t;
  const c = [];
  await reset(t, 'agents-idle', { level: 'm' });
  await sleep(500);
  const replyText = () => evaluate(s, `(document.querySelector('.tarot-reply') || {}).innerText || ''`);
  // 停用审查
  await runStep(s, 'click:article[data-agent="reviewer"] .tarot-pick');
  await sleep(300);
  const live = await evaluate(s, `(document.querySelector('.tarot-reply') || {}).getAttribute ? document.querySelector('.tarot-reply').getAttribute('aria-live') : null`);
  check(c, '即时回应容器 aria-live=polite（D-07）', live === 'polite', String(live));
  await runStep(s, 'click:#tarot-back-panel .tarot-sw');
  await sleep(350);
  const t1 = await replyText();
  const off = await st(s, `S.agents.find((a) => a.id === 'reviewer').enabled`);
  check(c, '点开关：审查已停用', off === false);
  check(c, '点开关后 0.4 秒内她回了一句', t1.trim().length > 0, `reply=${J(t1)}`);
  const isDown = await evaluate(s, `document.querySelector('article[data-agent="reviewer"]').classList.contains('is-down')`);
  const ribbon = await evaluate(s, `document.querySelector('article[data-agent="reviewer"] .tarot-ribbon').innerText`);
  check(c, '牌扣下，缎带「已歇下」', isDown && /已歇下/.test(ribbon), ribbon);
  const t2 = await replyText();
  await sleep(3600);
  const t3 = await replyText();
  check(c, '3 秒后那句收起（再等 3.6 秒后为空）', t2.trim().length > 0 && t3.trim().length === 0, `${J(t2)} → ${J(t3)}`);
  await runStep(s, 'click:article[data-agent="reviewer"] .tarot-flip');
  await sleep(350);
  const back = await st(s, `S.agents.find((a) => a.id === 'reviewer').enabled`);
  check(c, '「翻回正面」恢复启用，并回一句', back === true && (await replyText()).trim().length > 0);
  // 遐蝶不可扣：点开关回 agents.locked
  await runStep(s, 'click:article[data-agent="orchestrator"] .tarot-pick');
  await sleep(900); // 点牌会平滑滚到牌背：滚动没停时算出的坐标会点空（曾偶发「locked 回复为空」）
  await runStep(s, 'click:#tarot-back-panel .tarot-sw');
  await sleep(300);
  const lockedSay = await replyText();
  const orch = await st(s, `S.agents.find((a) => a.id === 'orchestrator').enabled`);
  check(c, '遐蝶的开关点了不会停用，她回一句（locked）', orch === true && lockedSay.trim().length > 0, J(lockedSay));
  // 改模型：研究员牌背里换一个模型
  await runStep(s, 'click:article[data-agent="researcher"] .tarot-pick');
  await sleep(900);
  await runStep(s, 'click:.tarot-model button.mselect-field');
  await sleep(400);
  const opts = await evaluate(s, `[...document.querySelectorAll('[role="option"]')].map((o) => o.innerText.trim().replace(/\\s+/g, ' ').slice(0, 30))`);
  check(c, '模型菜单有选项（首项「跟随任务」）', opts.length >= 2 && /跟随任务/.test(opts[0]), J(opts.slice(0, 4)));
  if (opts.length >= 2) {
    await evaluate(s, `(() => { const o = [...document.querySelectorAll('[role="option"]')].filter((x) => !/跟随任务|更多/.test(x.innerText))[0]; if (o) o.click(); return !!o; })()`);
    await sleep(350);
    const eng = await st(s, `JSON.stringify(S.agents.find((a) => a.id === 'researcher').engine || null)`).then(JSON.parse);
    const r3 = await replyText();
    check(c, '改模型：agent.engine 写进去了', !!eng?.key, J(eng));
    check(c, '改模型：立刻回了一句', r3.trim().length > 0, J(r3));
  }
  // 切话量：页首语变化
  const lead = (level) => evaluate(s, `(() => { window.__alight.actions.setLevel(${J(level)}); return true; })()`).then(async () => { await sleep(350); await closeToasts(s); return evaluate(s, `(document.querySelector('.tarot .agent-head, .agents-view .agent-head, .tarot-lead, .agent-head__say') || document.querySelector('.view.agents-view')).innerText.slice(0, 200)`); });
  const lm = await lead('m'); const ls = await lead('s'); const ll = await lead('l');
  check(c, '切话量后页首语变化（少 / 中 / 多三种各不相同）', new Set([lm, ls, ll]).size === 3, J([ls.slice(0, 30), lm.slice(0, 30), ll.slice(0, 30)]));
  // 四种引擎：coder 牌的牌面三态与牌背说明
  await evaluate(s, `window.__alight.actions.setLevel('m')`);
  await runStep(s, 'click:article[data-agent="coder"] .tarot-pick');
  const ENG = [
    ['Claude Code', 'claude:cli', (f, n) => /白\d\s*银\d\s*黑\d/.test(f) && /逐项/.test(n)],
    ['Codex', 'gpt:cli', (f, n) => /只认\s*\d+\s*项/.test(f) && !/[白银黑]\d/.test(f) && /写文件|联网/.test(n)],
    ['DSH', 'deepseek:cli', (f) => /不受此处限制/.test(f) && !/[白银黑]\d/.test(f)],
    // API：牌面写「不使用工具」、没有档位行和汇总卡；牌背那句必须明说「不用工具」或「只用所选模型」
    // （现文案：口吻开 =「它只用上面选的模型思考和写作。」，口吻关 =「API 方式不使用工具…」）. 不是恒真：另三种引擎的说明里没有这两种说法.
    ['API', 'claude:api', (f, n, x) => /不使用工具/.test(f) && !/[白银黑]\d/.test(f) && /不使用工具|无工具|只用[^。]*模型/.test(n) && x.tools === 0 && x.sums === 0],
  ];
  for (const [name, key, ok] of ENG) {
    await evaluate(s, `window.__alight.actions.setAgentEngine('coder', { key: ${J(key)}, model: '' })`);
    await sleep(350);
    const faceText = await evaluate(s, `document.querySelector('article[data-agent="coder"] .tarot-tiers, article[data-agent="coder"] .tarot-face').innerText.replace(/\\s+/g, '')`);
    const note = await evaluate(s, `((document.querySelector('#tarot-back-panel .tarot-honor') || document.querySelector('#tarot-back-panel .tarot-note')) || {}).innerText || ''`);
    const sums = await evaluate(s, `document.querySelectorAll('#tarot-back-panel .tarot-sum:not(.is-none)').length`);
    const toolRows = await evaluate(s, `document.querySelectorAll('#tarot-back-panel .tarot-tool').length`);
    check(c, `${name}：牌面与说明如实（牌面「${faceText.slice(0, 16)}」）`, ok(faceText, note, { sums, tools: toolRows }), `牌面=${faceText} 说明=${note.slice(0, 80)} 汇总卡=${sums} 工具行=${toolRows}`);
  }
  return { checks: c };
});

flow(9, '主动搭话与总闸：拨钟；少档 / 安静时段 / 深夜 / 口吻关各自挡住；对照组放行；说一次后未回应不再说', async (t) => {
  const { s } = t;
  const c = [];
  const nudges = async () => (await tasks(s)).flatMap((x) => x.messages).filter((m) => m.proactive === true || /^nudge\./.test(m.src?.scene ?? '')).length;
  /** 每个情形都重载页面：总闸的「今天已说几次 / 上一次没得到回应」记在模块内存与 localStorage 里，不重载就会互相串. */
  const scenario = async ({ opts, mutate = '', clock = '2026-10-27T14:12:00' }) => {
    await reloadApp(t);
    await evaluate(s, `localStorage.removeItem('alight/voicegate'), true`);
    await setClock(s, '2026-10-27T14:00:00');
    await reset(t, 'chat-reply', opts);   // 她最后一句话在 14:00 前后
    if (mutate) await evaluate(s, `(() => { ${mutate} return true; })()`);
    await sleep(300);
    await setClock(s, clock);             // 先拨钟，再让总闸重算（设置变动触发重排）
    await evaluate(s, `window.__alight.actions.setProactive('off'); window.__alight.actions.setProactive('on')`);
  };
  const blocked = async (name, spec) => {
    await scenario(spec);
    await sleep(2500);
    const n = await nudges();
    check(c, `挡住：${name}`, n === 0, `出现了 ${n} 条主动话`);
  };
  await blocked('话量「少」不闲聊（只有休息关照）', { opts: { level: 's' } });
  await blocked('安静一小时（quietUntil）', { opts: { level: 'l' }, mutate: `window.__alight.actions.quietFor(60);` });
  await blocked('深夜 23:30（22:00–08:00 不主动）', { opts: { level: 'l' }, clock: '2026-10-27T23:30:00' });
  await blocked('口吻关', { opts: { level: 'l', persona: false } });
  // 对照组：同样的设置，没有任何挡路的条件 → 必须说
  await scenario({ opts: { level: 'l' } });
  const ok1 = await waitUntil(s, `(() => { const S = window.__alight.store.get(); return Object.values(S.tasks).some((t) => t.messages.some((m) => m.proactive === true)); })()`, { timeoutMs: 60000 }).catch(() => false);   // 到期点已过时调度器再给 NUDGE_GRACE_MS（45 s）缓冲才开口
  check(c, '对照组放行：话量「多」+ 静默 ≥8 分钟 + 白天 → 她主动开了口', !!ok1, '8 秒内没有出现 proactive 消息（隐藏窗口的可见 / 焦点判断或定时器可能不满足，见 unresolved）');
  if (ok1) {
    await sleep(500);
    const dom = await evaluate(s, `JSON.stringify((() => {
      const sys = document.querySelector('[data-sysl]'); const pills = [...document.querySelectorAll('.her-pills button')];
      return { sys: sys ? sys.innerText : '', kind: sys ? sys.dataset.sysl : '', pills: pills.map((b) => b.innerText.trim()), exitLast: pills.length ? pills[pills.length - 1].classList.contains('pill--exit') : null };
    })())`).then(JSON.parse);
    check(c, '系统行在前：「静默 N 分钟 · 她主动开口 · 今天 1/3 · 今天别再说」', /静默/.test(dom.sys) && /她主动开口/.test(dom.sys) && /今天别再说/.test(dom.sys) && dom.kind === 'nudge', dom.sys);
    check(c, '胶囊 ≤3，最后一个是退出项，没有「再聊一会儿」', dom.pills.length >= 1 && dom.pills.length <= 3 && dom.exitLast === true && !dom.pills.some((p) => /再聊|陪我|等一下/.test(p)), J(dom.pills));
    const n1 = await nudges();
    await setClock(s, '2026-10-27T14:30:00');
    await evaluate(s, `window.__alight.actions.setProactive('off'); window.__alight.actions.setProactive('on')`);
    await sleep(2500);
    const n2 = await nudges();
    check(c, '说过一次、没有得到回应：不再说第二次', n2 === n1, `${n1} → ${n2}`);
  }
  await evaluate(s, `window.__probeClock.set(null)`);
  return {
    checks: c,
    unresolved: ['voiceGate 的 G1–G11 逐条与每小时预算、同场景缩档、日上限 3 次：只在 check:logic（V2，纯函数表驱动）覆盖；这里是接线层的黑盒验证（拨钟 + 真定时器），没有注入假定时器'],
  };
});

flow(10, '危机回合：无贴纸、无落蝶、头像 gentle、无胶囊', async (t) => {
  const { s, fake } = t;
  const c = [];
  await reset(t);
  fake.reset([], reply('⟦face:shy｜react:butterfly⟧我在这里。你现在身边有人吗？', { tokenDelayMs: 6, chunkChars: 3 }));
  const id = await newChat(t, '我真的不想活了。');
  await waitHer(t, id);
  await sleep(400);
  const tk = await task(s, id);
  const her = herOf(tk).at(-1);
  check(c, '这一回合标 crisis，神色固定 gentle，丢弃 react', her.crisis === true && her.expr === 'gentle' && !her.react, J({ crisis: her.crisis, expr: her.expr, react: her.react }));
  const dom = await evaluate(s, `JSON.stringify({ stickers: document.querySelectorAll('[data-sticker]').length, badges: document.querySelectorAll('.ws-conv [data-badge]').length, landing: document.querySelectorAll('.her-landing').length, pills: document.querySelectorAll('.her-pills button').length, story: !!document.querySelector('[data-story-box]'), leak: /⟦|face:|react:/.test((document.body.innerText || '').replace(/surface:/g, '')), exprs: [...document.querySelectorAll('.ws-conv [data-her-avatar]')].map((a) => a.dataset.expr) })`).then(JSON.parse);
  check(c, '没有贴纸、没有角标、没有落蝶、没有胶囊、没有剧情框', dom.stickers === 0 && dom.badges === 0 && dom.landing === 0 && dom.pills === 0 && !dom.story, J(dom));
  check(c, '对话里的头像都是 gentle，标签不外露', dom.exprs.every((e) => e === 'gentle') && !dom.leak, J(dom));
  // 危机后用户说「谢谢」：不落蝶（上一回合是 crisis）
  fake.reset([], reply('我在。', { tokenDelayMs: 4 }));
  const n0 = fake.messageCount;
  await say(t, id, '谢谢');
  await sleep(1500);
  const tk2 = await task(s, id);
  const last = tk2.messages.filter((m) => m.role === 'user').at(-1);
  check(c, '危机回合之后的「谢谢」不落蝶，照常回复', last.reaction !== 'landing' && fake.messageCount > n0, J({ reaction: last.reaction, req: `${n0}→${fake.messageCount}` }));
  return { checks: c, manual: ['危机当天不再主动搭话（crisisDay）：check:logic 的 canNudge 表驱动已覆盖'] };
});

flow(11, '落蝶：「谢谢」在她陈述之后命中（不调模型）；「好」在她提议之后不命中', async (t) => {
  const { s, fake } = t;
  const c = [];
  await reset(t);
  fake.reset([], reply('已经改好了，结果在上面。', { tokenDelayMs: 4 }));
  const id = await newChat(t, '把发布说明改一下。');
  await waitHer(t, id, 1);
  const n0 = fake.messageCount;
  await say(t, id, '谢谢');
  await sleep(1200);
  const tk = await task(s, id);
  const thanks = tk.messages.filter((m) => m.role === 'user').at(-1);
  check(c, '「谢谢」命中落蝶：reaction=landing', thanks.reaction === 'landing', J(thanks));
  check(c, '没有调模型（请求数不变）', fake.messageCount === n0, `${n0} → ${fake.messageCount}`);
  const dom = await evaluate(s, `JSON.stringify((() => { const l = document.querySelector('.her-landing'); const b = l && [...document.querySelectorAll('button')].find((x) => /让她回一句/.test(x.innerText)); return { has: !!l, live: l ? l.getAttribute('aria-live') : null, text: l ? l.innerText : '', ask: !!b }; })())`).then(JSON.parse);
  check(c, '用户那句下面有「落蝶」标记，aria-live=polite（D-07）', dom.has && /落蝶/.test(dom.text) && dom.live === 'polite', J(dom));
  check(c, '旁边有「让她回一句」', dom.ask);
  // 点「让她回一句」→ 走普通回复
  fake.reset([], reply('不客气。', { tokenDelayMs: 4 }));
  await evaluate(s, `(() => { const b = [...document.querySelectorAll('button')].find((x) => /让她回一句/.test(x.innerText)); if (b) b.click(); return !!b; })()`);
  await fake.waitForRequests(1, 15000).catch(() => {});
  check(c, '点「让她回一句」才调模型', fake.messageCount >= 1, `请求数 ${fake.messageCount}`);
  await waitHer(t, id, 2).catch(() => {});
  // 她提了个提议：「好」不能被吞（它是在同意）
  await reset(t);
  fake.reset([], reply('要不要我把已知问题那一节也改一下？', { tokenDelayMs: 4 }));
  const id2 = await newChat(t, '发布说明写完了。');
  await waitHer(t, id2, 1);
  fake.reset([], reply('好的，我来改。', { tokenDelayMs: 4 }));
  const m0 = fake.messageCount;
  await say(t, id2, '好');
  await fake.waitForRequests(1, 15000).catch(() => {});
  const tk2 = await task(s, id2);
  const good = tk2.messages.filter((m) => m.role === 'user').at(-1);
  check(c, '她问了「要不要…」之后，「好」不落蝶，照常回复', good.reaction !== 'landing' && fake.messageCount > m0, J({ reaction: good.reaction, req: `${m0}→${fake.messageCount}` }));
  // 弱闭合语「好」在她陈述（非事件类末句）之后：也不吞
  await reset(t);
  fake.reset([], reply('已经改好了，结果在上面。', { tokenDelayMs: 4 }));
  const id3 = await newChat(t, '把发布说明改一下。');
  await waitHer(t, id3, 1);
  fake.reset([], reply('嗯。', { tokenDelayMs: 4 }));
  const k0 = fake.messageCount;
  await say(t, id3, '好');
  await fake.waitForRequests(1, 15000).catch(() => {});
  const tk3 = await task(s, id3);
  const good2 = tk3.messages.filter((m) => m.role === 'user').at(-1);
  check(c, '弱闭合语「好」只在事件类末句之后才算；普通陈述之后不落蝶', good2.reaction !== 'landing' && fake.messageCount > k0, J({ reaction: good2.reaction, req: `${k0}→${fake.messageCount}` }));
  return { checks: c };
});

/* ───────────── 运行 ───────────── */

const sevMark = (k) => (k.pass ? '✓' : k.severity === 'must' ? '✗' : '△');

export async function runFlows(ctx) {
  const only = ctx.values.only ? new Set(String(ctx.values.only).split(',').map((x) => Number(x.trim()))) : null;
  await waitForQuiet(ctx);
  const fake = await startFakeAnthropic({ script: [], tokenDelayMs: 4 });
  ctx.step(`假 Anthropic 服务 ${fake.baseUrl}`);
  const prefs = fxPrefs({ theme: 'night', fakeApi: { baseUrl: fake.baseUrl, custom: true } });
  const prof = await prepareProfile(ctx, { prefs, label: 'flows', log: ctx.log, userFiles: fakeServiceFiles(fake.baseUrl), saveKey: false });
  const results = [];
  let app;
  try {
    app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, viewport: { width: 1440, height: 900 }, init: [clockSource()] });
    const s = app.page;
    await waitDevApi(s);
    await waitUntil(s, `!!window.__alight.store.get().models.providers.x_probe`, { timeoutMs: 20000, label: '假服务登记成 x_probe' });
    await sleep(2000);
    const t = { s, app, fake, ctx };
    for (const f of FLOWS) {
      if (only && !only.has(f.n)) continue;
      ctx.step(`流程 ${f.n}：${f.title}`);
      const seen = app.consoleLog.length;
      let r;
      try {
        r = await f.fn(t);
      } catch (e) {
        let shot;
        try { if (ctx.outDir) shot = await screenshot(s, path.join(ctx.outDir, `flow-${f.n}-error.png`)); } catch { /* 页面没了 */ }
        r = { checks: [], error: e.message, screenshot: shot };
      }
      const errors = app.consoleLog.slice(seen).filter((x) => x.level === 'error').map((x) => x.text.slice(0, 200));
      const checks = r.checks ?? [];
      const verdict = r.error ? 'ERROR' : checks.some((k) => !k.pass && k.severity === 'must') ? 'FAIL' : checks.some((k) => !k.pass) ? 'WARN' : 'PASS';
      results.push({ n: f.n, title: f.title, verdict, checks, error: r.error, manual: r.manual ?? [], unresolved: r.unresolved ?? [], consoleErrors: errors });
      ctx.log(`   → ${verdict}${r.error ? `：${r.error}` : ''}`);
      for (const k of checks) ctx.log(`     ${sevMark(k)} ${k.name}${k.pass ? '' : `\n         ${k.detail}`}`);
      if (errors.length) ctx.log(`     控制台新增错误 ${errors.length} 条：${errors[0]}`);
    }
    await applyFixture(s, 'none').catch(() => {});
  } finally {
    if (app) await app.close({ graceMs: 6000 }).catch(() => {});
    await fake.close();
    removeDir(prof.userDataDir);
  }
  const summary = Object.fromEntries(['PASS', 'WARN', 'FAIL', 'ERROR'].map((k) => [k, results.filter((r) => r.verdict === k).length]));
  ctx.log(`\n流程合计：通过 ${summary.PASS}，提醒 ${summary.WARN}，失败 ${summary.FAIL}，出错 ${summary.ERROR}`);
  const unresolved = results.flatMap((r) => r.unresolved.map((u) => `流程 ${r.n}：${u}`));
  if (unresolved.length) ctx.log(`做不到自动断言的（unresolved）：\n  - ${unresolved.join('\n  - ')}`);
  const out = { appDir: ctx.appDir, at: new Date().toISOString(), summary, results };
  if (ctx.values.json) writeJson(ctx.values.json, out);
  return summary.FAIL || summary.ERROR ? 1 : 0;
}
