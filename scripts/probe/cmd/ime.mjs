// ime：输入法用例 IME-1…10（research/08-补充-3 §5.2）。
// 用 CDP 的 Input.imeSetComposition / Input.insertText 驱动 Chromium 自己的输入法控制器——页面看到的
// compositionstart/update/end、beforeinput(insertCompositionText)、keydown(key="Process", keyCode=229, isComposing=true) 与真输入法一致
// （见 docs/IME-CASES.md「通路验证」）。做不到的（候选窗位置、真实输入法的怪癖）列人工清单。
// 判定分三档：失败(FAIL)＝必须修；提醒(WARN)＝防御性用例（compositionend 先于 keydown 的次序，线上少见）；通过(PASS)。
import { launchApp, removeDir } from '../lib/launch.mjs';
import { prepareProfile } from '../lib/profile.mjs';
import {
  EVENT_LOGGER_SOURCE, clearEventLog, clickSelector, clickText, evaluate, focusSelector, ime, installEventLogger, pressKey, readEventLog, screenshot, sleep, waitUntil,
} from '../lib/page.mjs';
import { buildPrefs, fakeServiceFiles } from '../lib/seed.mjs';
import { INPUT_SELECTOR } from '../lib/targets.mjs';
import { percentile } from '../lib/stats.mjs';
import { writeJson } from '../lib/ctx.mjs';
import { startFakeAnthropic, reply } from '../fake-anthropic.mjs';

const LONG_REPLY = '这是一段很长的流式回复，用来在输入法组合期间不停地触发重新渲染。'.repeat(120);

/* ───────────── 小工具 ───────────── */

const NAV = { new: '1', tasks: '2', agents: '3', tools: '4', models: '5', history: '6', settings: '7' };
const sel = JSON.stringify;
const valueOf = (s, selector) => evaluate(s, `(document.querySelector(${sel(selector)}) || {}).value`);

async function interactive(s, selector = INPUT_SELECTOR, timeoutMs = 30000) {
  await waitUntil(s, `(() => { const e = document.querySelector(${sel(selector)}); return !!e && !e.matches(':disabled') && !e.closest('[inert]') && e.getClientRects().length > 0; })()`, { timeoutMs, label: `${selector} 可输入` });
}

/** 栖枝的首页输入框有「闲聊 / 工作」开关，默认「工作」（发出去的是制定计划的提示词，界面也更重）。
 *  这些用例要的是萤火那样的普通对话，所以发送前先切到闲聊；没有这个开关（萤火）时什么都不做。 */
async function chatMode(s) {
  const has = await evaluate(s, `!!document.querySelector('.env-kind input[value="chat"]')`).catch(() => false);
  if (!has) return;
  await clickSelector(s, '.env-kind .segmented__opt:has(input[value="chat"])');
  await sleep(120);
}

async function goto(s, view) {
  await pressKey(s, NAV[view], { mods: ['alt'] });
  await sleep(450);
}

async function clearField(s, selector) {
  await focusSelector(s, selector);
  await pressKey(s, 'a', { mods: ['ctrl'] });
  await pressKey(s, 'Backspace');
}

/** 清掉一次测试留下的输入法与文本状态。 */
async function reset(s, selector) {
  await ime.cancel(s).catch(() => {});
  await sleep(30);
  await clearField(s, selector).catch(() => {});
  await clearEventLog(s);
}

/** 取最近一次 keydown 的记录。defaultPrevented 由页面里的 setTimeout(0) 回填；隐藏窗口里这个定时器要 40–100 ms 才跑，所以轮询等它。 */
const lastKeydown = async (s, wantKey) => {
  const deadline = performance.now() + 800;
  let kd;
  do {
    await sleep(30);
    const log = await readEventLog(s);
    kd = [...log].reverse().find((e) => e.type === 'keydown' && (!wantKey || e.code === wantKey));
  } while (kd && kd.defaultPrevented === undefined && performance.now() < deadline);
  return kd;
};

const VARIANT_NOTE = {
  A: '变体 A（Chromium+TSF 实测形态：key=Process, keyCode=229, isComposing=true）',
  B: '变体 B（输入法放行 Enter/Esc：keyCode=13/27, isComposing=true）',
  C: '变体 C（compositionend 先于 keydown：keyCode=229, isComposing=false）',
};

/** 一个检查点。severity: must（失败=FAIL）| advisory（失败=WARN）| info。 */
function check(list, name, pass, detail, severity = 'must') {
  list.push({ name, pass: !!pass, severity, detail });
}

function verdict(checks) {
  if (checks.some((c) => !c.pass && c.severity === 'must')) return 'FAIL';
  if (checks.some((c) => !c.pass && c.severity === 'advisory')) return 'WARN';
  return 'PASS';
}

/** 从 localStorage 的旧存储格式里读出所有用户消息的文字；读不到返回 null。 */
async function userMessages(s, target) {
  try {
    const blob = JSON.parse(await evaluate(s, `localStorage.getItem(${sel(target.keys.state)}) || 'null'`));
    if (!blob?.tasks) return null;
    return Object.values(blob.tasks).flatMap((tk) => (tk.messages ?? []).filter((m) => m.role === 'user').map((m) => m.text));
  } catch { return null; }
}

async function readPrefs(s, target) {
  try { return JSON.parse(await evaluate(s, `localStorage.getItem(${sel(target.keys.prefs)}) || 'null'`)); } catch { return null; }
}

/** 打开 设置 › 称呼 输入框所在页。 */
const CALL_NAME = 'input[aria-label*="称呼"]';
// 栖枝的模型下拉自带搜索框，输入的文字可以直接当模型 ID 用（最后一行「用「xxx」作为模型 ID」）：它就是「模型 ID 框」。萤火是下拉里的「自定义模型…」+ 单独的输入框。
const MODEL_ID = 'input[aria-label*="模型 ID"], .mselect-pop__search input';

async function openCustomModelField(s) {
  await goto(s, 'models');
  await waitUntil(s, `document.title.startsWith('模型接入')`);
  // 第一张卡片（Claude）的「模型」下拉
  await clickSelector(s, 'button.mselect-field[aria-label^="模型"]');
  await sleep(250);
  // 栖枝：下拉一打开搜索框就在；萤火：当前值若不在预置列表里也会显示成「…自定义」，要点的是下面那条「自定义模型…」
  const hasSearch = await evaluate(s, `!!document.querySelector('.mselect-pop__search input')`);
  if (!hasSearch) await clickText(s, '自定义模型', { selector: '[role=option], [role=menuitem], li, button', within: 'body' });
  await waitUntil(s, `!!document.querySelector(${sel(MODEL_ID)})`, { timeoutMs: 5000, label: '出现自定义模型 ID 输入框' });
}

/* ───────────── 用例 ───────────── */

const CASES = [];
const def = (id, title, mode, fn) => CASES.push({ id, title, mode, fn });

def('IME-1', '主输入框：组合态按回车选字，不发送', '自动＋人工', async (t) => {
  const { s, fake } = t;
  const checks = [];
  await goto(s, 'new');
  await interactive(s);
  for (const v of ['A', 'B']) {
    await reset(s, INPUT_SELECTOR);
    await focusSelector(s, INPUT_SELECTOR);
    await ime.compose(s, 'ni');
    await ime.key(s, 'Enter', v);
    const kd = await lastKeydown(s, 'Enter');
    const value = await valueOf(s, INPUT_SELECTOR);
    check(checks, `${VARIANT_NOTE[v]}：回车没有发送`, fake.messageCount === 0, `请求数 ${fake.messageCount}`);
    check(checks, `${VARIANT_NOTE[v]}：组合文字还在输入框里`, value === 'ni', `value=${JSON.stringify(value)}`);
    check(checks, `${VARIANT_NOTE[v]}：回车没有被应用当成自己的 Enter（defaultPrevented 为假）`, kd && !kd.defaultPrevented, `keydown=${JSON.stringify(kd)}`);
  }
  // 变体 C：先选字再收到 keydown
  await reset(s, INPUT_SELECTOR);
  await focusSelector(s, INPUT_SELECTOR);
  await ime.compose(s, 'ni');
  await ime.commit(s, '你');
  await ime.key(s, 'Enter', 'C');
  await sleep(300);
  check(checks, `${VARIANT_NOTE.C}：keyCode=229 的回车没有发送`, fake.messageCount === 0, `请求数 ${fake.messageCount}；应用应同时检查 keyCode===229`, 'advisory');
  await reset(s, INPUT_SELECTOR);
  return { checks };
});

def('IME-2', '主输入框：选字后再按回车，恰好发送一次，不重复', '自动＋人工', async (t) => {
  const { s, fake } = t;
  const checks = [];
  await goto(s, 'new');
  await interactive(s);
  await chatMode(s);
  fake.reset([], reply('收到。', { tokenDelayMs: 5 }));
  // 之前的用例（IME-1 变体 C 在萤火上会真的发出一条）可能已经在历史里留下同样的字，所以数「增量」
  const beforeCount = (await userMessages(s, t.target))?.filter((x) => x === '你').length ?? 0;
  await focusSelector(s, INPUT_SELECTOR);
  await ime.compose(s, 'ni');
  await ime.commit(s, '你');
  // 选字后立刻回车（不等待），再连按一次回车
  await pressKey(s, 'Enter');
  await pressKey(s, 'Enter');
  await fake.waitForRequests(1, 15000).catch(() => {});
  const quiet = await fake.expectNoMoreRequests(1, 1200);
  check(checks, '选字后回车：恰好发送一次', fake.messageCount === 1 && quiet, `请求数 ${fake.messageCount}`);
  check(checks, '发出去的文字是选好的字，不是拼音', fake.requests[0]?.lastUserText === '你', `lastUserText=${JSON.stringify(fake.requests[0]?.lastUserText)}`);
  await sleep(1500); // 任务历史 1 秒节流后落盘
  const saved = await userMessages(s, t.target);
  if (saved) {
    const added = saved.filter((x) => x === '你').length - beforeCount;
    check(checks, '落盘的任务历史里这次只新增了一条用户消息「你」', added === 1, `新增 ${added} 条（用户消息共 ${saved.length} 条）`);
  }
  else check(checks, '任务历史不在 localStorage（已迁到别处），重复消息检查改人工', true, '没法从 localStorage 读到任务历史', 'info');
  return { checks };
});

def('IME-3', '单行输入框回车即提交（称呼、模型 ID）：组合态回车不提交', '自动＋人工', async (t) => {
  const { s, app, target } = t;
  const checks = [];
  // 3a 称呼
  await goto(s, 'settings');
  await waitUntil(s, `!!document.querySelector(${sel(CALL_NAME)})`, { timeoutMs: 8000, label: '设置页的称呼输入框' }).catch(() => {});
  if (await evaluate(s, `!!document.querySelector(${sel(CALL_NAME)})`)) {
    for (const [v, text] of [['A', 'nia'], ['B', 'nib'], ['C', 'nic']]) {
      await clearEventLog(s);
      const before = (await readPrefs(s, target))?.settings?.callName;
      await focusSelector(s, CALL_NAME);
      await pressKey(s, 'a', { mods: ['ctrl'] });
      await ime.compose(s, text);
      if (v === 'C') await ime.commit(s, '你');
      await ime.key(s, 'Enter', v);
      const kd = await lastKeydown(s, 'Enter');
      await sleep(1500); // 偏好 1 秒节流后落盘
      const after = (await readPrefs(s, target))?.settings?.callName;
      const committed = after !== undefined && before !== undefined ? after !== before : null;
      const sev = v === 'C' ? 'advisory' : 'must';
      check(checks, `称呼框 ${VARIANT_NOTE[v]}：回车没有提交`, kd && !kd.defaultPrevented && committed !== true, `defaultPrevented=${kd?.defaultPrevented}，提交前后 callName：${JSON.stringify(before)} → ${JSON.stringify(after)}`, sev);
      await ime.cancel(s).catch(() => {});
      await app.page.send('Page.reload');
      await interactive(s, CALL_NAME, 15000).catch(() => {});
      await goto(s, 'settings');
      await waitUntil(s, `!!document.querySelector(${sel(CALL_NAME)})`, { timeoutMs: 8000 }).catch(() => {});
    }
  } else {
    check(checks, '设置页找到「称呼」输入框', false, `选择器 ${CALL_NAME} 没有匹配；若界面改了名字，请更新 scripts/probe/cmd/ime.mjs`, 'advisory');
  }
  // 3b 自定义模型 ID
  for (const [v, text] of [['A', 'nia'], ['B', 'nib'], ['C', 'nic']]) {
    try {
      await app.page.send('Page.reload');
      await interactive(s);
      await openCustomModelField(s);
      await clearEventLog(s);
      await focusSelector(s, MODEL_ID);
      await ime.compose(s, text);
      if (v === 'C') await ime.commit(s, '你');
      await ime.key(s, 'Enter', v);
      const kd = await lastKeydown(s, 'Enter');
      await sleep(250);
      const still = await evaluate(s, `!!document.querySelector(${sel(MODEL_ID)})`);
      check(checks, `模型 ID 框 ${VARIANT_NOTE[v]}：回车没有提交（输入框仍在）`, still && kd && !kd.defaultPrevented, `输入框仍在=${still}，defaultPrevented=${kd?.defaultPrevented}`, v === 'C' ? 'advisory' : 'must');
    } catch (e) {
      check(checks, `模型 ID 框 变体 ${v}：能走到自定义模型输入框`, false, e.message, 'advisory');
    }
  }
  return { checks, manual: ['可执行文件名（命令路径）与服务地址框没有回车提交逻辑，无需测；新增的单行输入框请照此补用例'] };
});

def('IME-4', 'Esc 在组合态：只取消组合，不关闭弹窗、不放弃行内编辑', '自动＋人工', async (t) => {
  const { s } = t;
  const checks = [];
  for (const v of ['A', 'B']) {
    try {
      await s.send('Page.reload');
      await interactive(s);
      await openCustomModelField(s);
      await clearEventLog(s);
      await focusSelector(s, MODEL_ID);
      await ime.compose(s, 'ni');
      await ime.key(s, 'Escape', v);
      const kd = await lastKeydown(s, 'Escape');
      await sleep(250);
      const still = await evaluate(s, `!!document.querySelector(${sel(MODEL_ID)})`);
      check(checks, `模型 ID 框 ${VARIANT_NOTE[v]}：Esc 没有关掉输入框`, still && kd && !kd.defaultPrevented, `输入框仍在=${still}，defaultPrevented=${kd?.defaultPrevented}`);
      if (v === 'A') {
        // 正向对照：没有组合时 Esc 必须仍然能放弃（别把守卫写成永远吞掉 Esc）
        await ime.cancel(s);
        await sleep(60);
        await pressKey(s, 'Escape');
        await sleep(250);
        const gone = !(await evaluate(s, `!!document.querySelector(${sel(MODEL_ID)})`));
        check(checks, '对照：没有组合时 Esc 仍能放弃行内编辑', gone, `输入框已关闭=${gone}`);
      }
    } catch (e) {
      check(checks, `变体 ${v}：能走到自定义模型输入框`, false, e.message, 'advisory');
    }
  }
  return { checks, manual: ['对话框（删除确认、信任弹框）里没有文本框时不涉及组合；若新增带文本框的弹框，需补用例'] };
});

def('IME-5', '单键快捷操作：焦点在可编辑控件时一律禁用；组合态不触发', '自动', async (t) => {
  const { s } = t;
  const checks = [];
  await goto(s, 'new');
  await interactive(s);
  await reset(s, INPUT_SELECTOR);
  await focusSelector(s, INPUT_SELECTOR);
  // 不在组合：在输入框里直接敲这些单键，字符应当进输入框，且没有任何全局处理器拦截（defaultPrevented 为假）
  const keys = ['y', 'n', 'a', 'x', '1', '2', '3', ' '];
  await clearEventLog(s);
  for (const k of keys) await pressKey(s, k);
  await sleep(400); // defaultPrevented 由页面里的 setTimeout(0) 回填，隐藏窗口里要 40–100 ms
  const log = await readEventLog(s);
  const intercepted = log.filter((e) => e.type === 'keydown' && e.defaultPrevented).map((e) => e.key);
  const typed = await valueOf(s, INPUT_SELECTOR);
  check(checks, '输入框有焦点、没有组合：y n a x 1 2 3 空格 都当字符输入', typed === 'ynax123 ', `value=${JSON.stringify(typed)}`);
  check(checks, '这些单键没有被全局快捷键拦截（defaultPrevented 为假）', intercepted.length === 0, `被拦截的键：${JSON.stringify(intercepted)}`);
  // 组合态：变体 B（输入法放行了字母键本身）——快捷键注册表必须因「组合中」而不触发
  await reset(s, INPUT_SELECTOR);
  await focusSelector(s, INPUT_SELECTOR);
  await ime.compose(s, 'ni');
  await clearEventLog(s);
  for (const k of ['y', 'n', '1', '2']) {
    const vk = { y: 89, n: 78, 1: 49, 2: 50 }[k];
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: k, code: /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: /\d/.test(k) ? `Digit${k}` : `Key${k.toUpperCase()}`, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  }
  await sleep(400);
  const log2 = await readEventLog(s);
  const hit2 = log2.filter((e) => e.type === 'keydown' && e.defaultPrevented).map((e) => e.key);
  check(checks, '组合态下 y n 1 2 没有被快捷键拦截', hit2.length === 0, `被拦截的键：${JSON.stringify(hit2)}`);
  await reset(s, INPUT_SELECTOR);
  return { checks, manual: ['「焦点落在批准卡本身时 Enter/Y/N/数字才生效」的正向用例需要一张待批准的卡：待 V0α 集成后用假服务的 tool_use 触发审批，补一条自动用例'] };
});

def('IME-6', '流式输出重渲染中打拼音：预编辑文字不丢、不重复、组合不被打断', '自动', async (t) => {
  const { s, fake } = t;
  const checks = [];
  fake.reset([], reply(LONG_REPLY, { tokenDelayMs: 20, chunkChars: 6 }));
  await goto(s, 'new');
  await interactive(s);
  await chatMode(s);
  await focusSelector(s, INPUT_SELECTOR);
  await s.send('Input.insertText', { text: '请开始一段很长的回复' });
  await pressKey(s, 'Enter');
  await fake.waitForRequests(1, 15000);
  await sleep(1200);
  await interactive(s); // 任务页的输入框
  await installEventLogger(s);
  await focusSelector(s, INPUT_SELECTOR);
  const frames = [];
  const steps = ['n', 'ni', 'nih', 'niha', 'nihao'];
  const streaming0 = await evaluate(s, 'document.body.innerText.length');
  for (const text of steps) {
    await ime.compose(s, text);
    await sleep(140);
    frames.push({ want: text, got: await valueOf(s, INPUT_SELECTOR) });
  }
  const mid = await readEventLog(s);
  const starts = mid.filter((e) => e.type === 'compositionstart').length;
  const endsMid = mid.filter((e) => e.type === 'compositionend').length;
  const streaming1 = await evaluate(s, 'document.body.innerText.length');
  check(checks, '组合期间输入框内容逐步等于预编辑文字（没被重渲染冲掉）', frames.every((f) => f.got === f.want), JSON.stringify(frames));
  check(checks, '组合期间没有多余的 compositionend / 重复的 compositionstart', endsMid === 0 && starts === 1, `compositionstart ${starts} 次，compositionend ${endsMid} 次`);
  check(checks, '测试确实发生在流式输出期间（页面文字在增长）', streaming1 > streaming0, `页面文字 ${streaming0} → ${streaming1}`, 'advisory');
  await ime.commit(s, '你好');
  await sleep(300);
  const finalValue = await valueOf(s, INPUT_SELECTOR);
  check(checks, '选字提交后输入框恰好是「你好」（不重复、不残留拼音）', finalValue === '你好', `value=${JSON.stringify(finalValue)}`);
  await reset(s, INPUT_SELECTOR);
  return { checks };
});

def('IME-7', '草稿与外部写入：组合期间不写入草稿；重启后文本正确', '自动', async (t) => {
  const { s, app, target } = t;
  const checks = [];
  await goto(s, 'new');
  await interactive(s);
  await reset(s, INPUT_SELECTOR);
  // 拦截 localStorage 写入，看组合中的拼音有没有被当草稿存下来
  await evaluate(s, `(() => { if (window.__lsw) return; window.__lsw = []; const orig = Storage.prototype.setItem; Storage.prototype.setItem = function (k, v) { window.__lsw.push({ k, v: String(v).slice(0, 400), t: performance.now() }); return orig.call(this, k, v); }; })()`);
  await focusSelector(s, INPUT_SELECTOR);
  for (const text of ['n', 'ni', 'nih', 'niha', 'nihao']) { await ime.compose(s, text); await sleep(450); }
  await sleep(1300); // 超过 1 秒的存盘节流
  const writes = JSON.parse(await evaluate(s, 'JSON.stringify(window.__lsw)'));
  const leak = writes.filter((w) => /draft|草稿/i.test(w.k) || w.v.includes('nihao') || /"text":"ni/.test(w.v));
  check(checks, '组合期间（持续 2.3 秒）没有把拼音写进任何 localStorage 草稿', leak.length === 0, `组合期间的 localStorage 写入共 ${writes.length} 次，疑似草稿 ${leak.length} 次${leak[0] ? `：${leak[0].k}` : ''}`);
  await ime.commit(s, '草稿');
  await sleep(2200);
  // 重启后：草稿是否还在（萤火基线没有草稿功能：这一项只报告，不判失败）
  await app.close({ graceMs: 6000 });
  const again = await launchApp({ appDir: t.ctx.appDir, userDataDir: t.userDataDir, keepData: true, viewport: { width: 1440, height: 900 } });
  try {
    await interactive(again.page);
    const restored = await valueOf(again.page, INPUT_SELECTOR);
    check(checks, `重启后输入框内容：${restored ? `恢复为 ${JSON.stringify(restored)}` : '为空（该版本没有草稿持久化）'}`, !restored || restored === '草稿', `重启后 value=${JSON.stringify(restored)}；如果有草稿功能，应当恢复为「草稿」`, 'info');
  } finally { await again.close({ graceMs: 6000 }); }
  t.app = null; // 已关闭，runCase 不要再关
  return { checks, manual: ['外部写入（点技能标签插入文字、粘贴）发生在组合期间的行为：需要真输入法按住拼音不提交，再点标签；预期是组合被正常提交或保留，不丢字、不重复'] };
});

def('IME-8', '候选窗位置', '人工', async (t) => {
  const { s } = t;
  const checks = [];
  await goto(s, 'new');
  await interactive(s);
  const info = JSON.parse(await evaluate(s, `(() => {
    const e = document.querySelector(${sel(INPUT_SELECTOR)});
    const chain = [];
    for (let n = e; n && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if ((cs.zoom && cs.zoom !== '1' && cs.zoom !== 'normal') || (cs.transform && cs.transform !== 'none') || (cs.filter && cs.filter !== 'none') || (cs.backdropFilter && cs.backdropFilter !== 'none')) {
        chain.push({ tag: n.tagName, cls: String(n.className).slice(0, 40), zoom: cs.zoom, transform: cs.transform, filter: cs.filter, backdrop: cs.backdropFilter });
      }
    }
    const r = e.getBoundingClientRect();
    return JSON.stringify({ inViewport: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, dpr: devicePixelRatio, chain });
  })()`));
  check(checks, '输入框完整落在视口内', info.inViewport, JSON.stringify(info), 'info');
  const risky = info.chain.filter((c) => c.zoom !== '1' || /matrix\((?!1, 0, 0, 1)/.test(c.transform));
  check(checks, '输入框的祖先没有 CSS zoom / 缩放变换（会让 TSF 候选窗坐标错位的常见原因）', risky.length === 0, `祖先里带 transform/filter/backdrop-filter 的：${info.chain.length} 个${risky.length ? `；其中 zoom/缩放变换：${JSON.stringify(risky)}` : ''}`, 'advisory');
  return { checks, manual: ['候选窗贴着光标：在 100%/125%/150% 缩放下，单行与多行（自动增高到 8 行）输入框里用微软拼音打字，候选窗应紧贴光标下方', '玻璃（backdrop-filter）与粒子层开着时同样检查', '窗口靠近屏幕底边时候选窗应翻到光标上方'] };
});

def('IME-9', 'maxLength 与组合态：在上限附近组合，不丢字、不错位截断', '自动＋人工', async (t) => {
  const { s } = t;
  const checks = [];
  await goto(s, 'settings');
  const ok = await waitUntil(s, `!!document.querySelector(${sel(CALL_NAME)})`, { timeoutMs: 8000 }).catch(() => false);
  if (!ok) { check(checks, '设置页找到「称呼」输入框', false, `选择器 ${CALL_NAME} 没有匹配`, 'advisory'); return { checks }; }
  const max = Number(await evaluate(s, `document.querySelector(${sel(CALL_NAME)}).maxLength`));
  check(checks, `称呼框有 maxLength（${max}）`, max > 0, `maxLength=${max}`, 'info');
  if (!(max > 0)) return { checks };
  const prefix = '一二三四五六七八九十甲乙丙丁戊己庚辛壬癸'.slice(0, max - 2);
  await focusSelector(s, CALL_NAME);
  await pressKey(s, 'a', { mods: ['ctrl'] });
  await s.send('Input.insertText', { text: prefix });
  await ime.compose(s, 'nihao');
  await sleep(100);
  const mid = await valueOf(s, CALL_NAME);
  await ime.commit(s, '你好吗');
  await sleep(150);
  const final = await valueOf(s, CALL_NAME);
  const expected = (prefix + '你好吗').slice(0, max);
  check(checks, `前缀 ${prefix.length} 字 + 组合 5 个拼音字母：组合中的显示`, true, `组合中 value=${JSON.stringify(mid)}（Chromium 允许组合文字暂时超出 maxLength，提交时截断）`, 'info');
  check(checks, `提交「你好吗」后正好截到 ${max} 字，保留的是前面的字，不错位`, final === expected, `value=${JSON.stringify(final)}，期望 ${JSON.stringify(expected)}`);
  await reset(s, CALL_NAME);
  return { checks, manual: ['真实微软拼音在上限附近的候选行为（有的输入法会在候选里就截断）需要人工确认一次'] };
});

def('IME-10', '重负载下组合态延迟（S4）：5 个会话同时流式输出，组合/提交往返 P95≤100 ms、P99≤200 ms', '自动＋人工', async (t) => {
  const { s, fake } = t;
  const checks = [];
  fake.reset([], reply(LONG_REPLY.repeat(3), { tokenDelayMs: 20, chunkChars: 6 }));
  // 开 5 个会话，各自在流式输出（每路约 50 事件/秒）
  for (let i = 1; i <= 5; i++) {
    await goto(s, 'new');
    await interactive(s);
    await chatMode(s);
    await focusSelector(s, INPUT_SELECTOR);
    await s.send('Input.insertText', { text: `并发会话 ${i}` });
    await pressKey(s, 'Enter');
    await fake.waitForRequests(i, 15000);
    await sleep(250);
  }
  await interactive(s);
  await installEventLogger(s);
  await focusSelector(s, INPUT_SELECTOR);
  const samples = { compose: [], key: [], commit: [] };
  const seq = ['w', 'wo', 'wo x', 'wo xi', 'wo xia'];
  for (let round = 0; round < 12; round++) {
    for (const text of seq) {
      const t0 = performance.now(); await ime.compose(s, text); samples.compose.push(performance.now() - t0);
      await sleep(25);
    }
    samples.key.push(await ime.key(s, 'Enter', 'A'));
    const t1 = performance.now(); await ime.commit(s, '我'); samples.commit.push(performance.now() - t1);
    await sleep(40);
  }
  const all = [...samples.compose, ...samples.key, ...samples.commit];
  const stats = { n: all.length, p50: percentile(all, 50), p95: percentile(all, 95), p99: percentile(all, 99), max: Math.max(...all) };
  const active = fake.requests.filter((r) => !r.aborted).length;
  check(checks, '测试期间 5 路流式输出同时在跑', fake.requests.length >= 5 && active >= 5, `假服务收到 ${fake.requests.length} 个请求，其中 ${active} 个仍在输出`, 'advisory');
  check(checks, `组合/按键/提交往返 P95 ≤100 ms`, stats.p95 <= 100, `n=${stats.n}，P50 ${stats.p50.toFixed(1)} ms，P95 ${stats.p95.toFixed(1)} ms，P99 ${stats.p99.toFixed(1)} ms，最大 ${stats.max.toFixed(1)} ms`);
  check(checks, `组合/按键/提交往返 P99 ≤200 ms`, stats.p99 <= 200, `P99 ${stats.p99.toFixed(1)} ms`);
  t.metrics = { s4: { ...Object.fromEntries(Object.entries(stats).map(([k, v]) => [k, Math.round(v * 10) / 10])), byKind: { compose: Math.round(percentile(samples.compose, 95)), key: Math.round(percentile(samples.key, 95)), commit: Math.round(percentile(samples.commit, 95)) } } };
  await reset(s, INPUT_SELECTOR);
  return { checks, manual: ['真输入法下同样的负载再测一次主观手感（候选窗跟手、没有字母漏进输入框）'] };
});

/* ───────────── 运行 ───────────── */

async function runCase(ctx, c, prof, fake) {
  const started = performance.now();
  const t = { ctx, fake, target: ctx.target, userDataDir: prof.userDataDir, metrics: undefined };
  let app;
  try {
    // 事件记录器作为 init 脚本：Page.reload 之后新文档里也有
    app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, viewport: { width: 1440, height: 900 }, init: [EVENT_LOGGER_SOURCE] });
    t.app = app; t.s = app.page;
    await interactive(t.s);
    await installEventLogger(t.s);
    fake.reset([], reply('好的，已收到。', { tokenDelayMs: 5 }));
    const out = await c.fn(t);
    const errors = (t.app ?? app).errors();
    return { id: c.id, title: c.title, mode: c.mode, verdict: c.mode === '人工' && verdict(out.checks) !== 'FAIL' ? 'MANUAL' : verdict(out.checks), checks: out.checks, manual: out.manual ?? [], metrics: t.metrics, consoleErrors: errors.map((e) => e.text.slice(0, 200)), ms: Math.round(performance.now() - started) };
  } catch (e) {
    let shot;
    try { if (ctx.outDir && t.s) shot = await screenshot(t.s, `${ctx.outDir}/${c.id}-error.png`); } catch { /* 页面已经没了 */ }
    return { id: c.id, title: c.title, mode: c.mode, verdict: 'ERROR', checks: [], manual: [], error: e.message, screenshot: shot, ms: Math.round(performance.now() - started) };
  } finally {
    if (t.app) await t.app.close({ graceMs: 6000 }).catch(() => {});
  }
}

export async function runIme(ctx) {
  const only = ctx.values.only ? new Set(String(ctx.values.only).toUpperCase().split(',').map((x) => x.trim())) : null;
  const fake = await startFakeAnthropic({ script: [], tokenDelayMs: 5 });
  ctx.step(`假 Anthropic 服务 ${fake.baseUrl}`);
  // 假服务登记成自定义服务（栖枝的请求地址在桌面端的服务表里，页面写的地址不算）；萤火没有服务表，仍按旧办法把地址写在偏好里
  const custom = ctx.target.id === 'alight';
  const prof = await prepareProfile(ctx, {
    prefs: buildPrefs({ fakeApi: { baseUrl: fake.baseUrl, custom } }), label: 'ime', log: ctx.log,
    ...(custom ? { userFiles: fakeServiceFiles(fake.baseUrl), saveKey: false } : {}),
  });
  const results = [];
  try {
    for (const c of CASES) {
      if (only && !only.has(c.id)) continue;
      ctx.step(`${c.id} ${c.title}`);
      const r = await runCase(ctx, c, prof, fake);
      results.push(r);
      ctx.log(`   → ${r.verdict}${r.error ? `：${r.error}` : ''}`);
      for (const k of r.checks) ctx.log(`     ${k.pass ? '✓' : k.severity === 'must' ? '✗' : k.severity === 'advisory' ? '△' : '·'} ${k.name}${k.pass ? '' : `\n         ${k.detail}`}`);
      if (r.metrics) ctx.log(`     指标 ${JSON.stringify(r.metrics)}`);
    }
  } finally {
    await fake.close();
    removeDir(prof.userDataDir);
  }
  const summary = Object.fromEntries(['PASS', 'WARN', 'FAIL', 'ERROR', 'MANUAL'].map((k) => [k, results.filter((r) => r.verdict === k).length]));
  ctx.log(`\n合计：通过 ${summary.PASS}，提醒 ${summary.WARN}，失败 ${summary.FAIL}，出错 ${summary.ERROR}，纯人工 ${summary.MANUAL}（提醒＝防御性用例，不算失败；纯人工＝只做了前置检查，见 docs/IME-CASES.md §5）`);
  const out = { target: ctx.target.id, appDir: ctx.appDir, at: new Date().toISOString(), summary, results };
  if (ctx.values.json) writeJson(ctx.values.json, out); else process.stdout.write(`${JSON.stringify(out)}\n`);
  return summary.FAIL || summary.ERROR ? 1 : 0;
}
