/* 模型接入页的界面检查（T-UI 的浏览器一半）：无头 Chrome + vite dev + 假的 window.alightDesktop，逐项操作页面并断言，顺手截图。
   不联网、不读任何密钥、不开任何可见窗口。不进 npm run verify（需要 Chrome 和一个在跑的 vite dev）。

   用法：
     1) 在 app 目录起 vite dev：  node node_modules/vite/bin/vite.js --port 5332 --strictPort --host 127.0.0.1
     2) node scripts/smoke/ui/models-ui.mjs [--url http://127.0.0.1:5332/?boot=0] [--shots <截图目录>] [--only a,b]
   覆盖：开始面板、页签与计数、已接入置顶、展开（一次一个）与焦点、搜索（别名 / 模型 / 拼音 / 首字母）、输入法组合期间不过滤、
   套餐端点下 API 页签禁用、模型选择器（100 行上限、置顶、输入即用、组合期间不抢回车）、添加 / 删除服务、任务菜单精选与「更多…」。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchChrome } from './cdp.mjs';
import { SCENES } from './scenes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const URL_BASE = arg('url', process.env.ALIGHT_DEV_URL || 'http://127.0.0.1:5332/?boot=0');
const SHOTS = arg('shots', path.join(os.tmpdir(), 'alight-models-ui-shots'));
const ONLY = (arg('only', '') || '').split(',').filter(Boolean);
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0;
let failed = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { passed += 1; console.log(`  ok  ${name}`); } else { failed += 1; console.error(`  FAIL ${name}${extra ? `\n    ${extra}` : ''}`); }
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const section = (t) => console.log(`\n${t}`);

/** A fresh browser (own profile) on the 模型接入 page. */
async function session(sceneName, { mode = 'night', width = 1500, height = 1100, scene } = {}) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-ui-'));
  const chrome = await launchChrome({ userDataDir: ud, width, height, colorScheme: mode === 'day' ? 'light' : 'dark' });
  await chrome.init(`window.__FAKE_CFG = ${JSON.stringify(scene ?? SCENES[sceneName])};`);
  await chrome.init(fs.readFileSync(path.join(here, 'fake-bridge.js'), 'utf8'));
  await chrome.goto(URL_BASE, '!!document.querySelector(".side-nav__gear")');
  if (mode === 'day') {
    await chrome.eval(`document.documentElement.dataset.mode !== 'day' && document.querySelector('.side-nav__mode-btn')?.click()`);
    await chrome.waitFor(`document.documentElement.dataset.mode === 'day'`);
  }
  const s = {
    chrome, ud,
    async goModels() {
      await chrome.click('.side-nav__gear');
      await chrome.sleep(150);
      await chrome.eval(`[...document.querySelectorAll('.side-nav__menu-item')].find((b) => b.textContent.includes('模型接入')).click()`);
      await chrome.waitFor('!!document.querySelector(".models-view")');
      await chrome.sleep(700);
    },
    /** 「已接入」的服务默认是一行摘要：要看完整卡片（[data-provider]）先点开那一行. */
    async open(id) {
      if ((await chrome.count(`[data-provider="${id}"]`)) > 0) return;
      await chrome.clickEl(`document.querySelector('.conn-tile[data-service="${id}"] .conn-tile__main')`);
      await chrome.waitFor(`!!document.querySelector('[data-provider="${id}"]')`);
      await chrome.sleep(250);
    },
    async goHome() {
      await chrome.eval(`[...document.querySelectorAll('.side-nav button, .side-nav a')].find((b) => /^\\s*归来/.test(b.textContent))?.click()`);
      await chrome.sleep(500);
    },
    async tab(name) {
      await chrome.clickEl(`[...document.querySelectorAll('.choice-tabs label')].find((l) => l.textContent.trim().startsWith(${JSON.stringify(name)}))`);
      await chrome.sleep(300);
    },
    async shot(name) { await chrome.screenshot(path.join(SHOTS, `${name}.png`)); },
    async close() { await chrome.close(); try { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* next time */ } },
    log: () => chrome.eval('window.__FAKE_LOG'),
  };
  return s;
}

const want = (name) => !ONLY.length || ONLY.includes(name);
const errorsOf = (chrome) => chrome.consoleLog.filter((l) => l.type === 'error' || l.type === 'exception');

/* ═══════════════════════════ 1. 一个服务都没接：开始 ═══════════════════════════ */
if (want('empty')) {
  section('开始：一个服务都没接');
  const s = await session('empty');
  const c = s.chrome;
  try {
    await s.goModels();
    ok('出现「开始」面板，三条路', (await c.count('.models-start__way')) === 3);
    ok('没有「新建时默认使用」', (await c.count('.models-default')) === 0);
    eq('默认页签：没有已接入就是「全部」', await c.eval(`document.querySelector('.choice-tabs .is-selected')?.textContent.trim().replace(/\\d+$/, '')`), '全部');
    ok('「已接入」区块不出现', (await c.count('#svc-connected')) === 0);
    await s.shot('01-empty-night');
    ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

/* ═══════════════════════════ 2. 常见的一天：页签、置顶、展开、搜索 ═══════════════════════════ */
if (want('browse')) {
  section('页签、已接入置顶、紧凑行与展开');
  const s = await session('mixed');
  const c = s.chrome;
  try {
    await s.goModels();
    const tabText = await c.eval(`[...document.querySelectorAll('.choice-tabs label')].map((l) => l.textContent.trim())`);
    ok('页签带计数：已接入 4、全部 49、国际 7、国内 11、聚合与云 14、本地 6、命令行 11', ['已接入4', '全部49', '国际7', '国内11', '聚合与云14', '本地6', '命令行11'].every((t, i) => tabText[i] === t), JSON.stringify(tabText));
    eq('默认页签：有已接入就是「已接入」', await c.eval(`document.querySelector('.choice-tabs .is-selected')?.textContent.trim()`), '已接入4');
    eq('已接入：四行摘要（不是四张完整卡片），默认引擎 DeepSeek 排第一', await c.eval(`[...document.querySelectorAll('.svc-group--connected .conn-tile')].map((e) => e.dataset.service)`), ['deepseek', 'kimi', 'openrouter', 'x_my-relay']);
    ok('已接入的行：当前模型与强度、状态、测试、展开都在一行里；首屏不再只有一张卡', (await c.count('.svc-group--connected [data-provider]')) === 0 && /强度/.test(await c.text('.conn-tile[data-service="deepseek"]')) && /测试/.test(await c.text('.conn-tile[data-service="deepseek"]')) && (await c.eval(`document.querySelector('.svc-group--connected').getBoundingClientRect().height`)) < 520);
    await s.open('kimi');
    ok('点一行：原地展开成完整卡片（占满一行），那一行不再出现；同一时间只展开一个', (await c.count('.svc-group--connected [data-provider="kimi"]')) === 1 && (await c.count('.conn-tile[data-service="kimi"]')) === 0);
    await c.clickEl(`document.querySelector('[data-provider="kimi"] button[aria-label^="收起"]')`);
    await c.sleep(300);
    ok('收起：回到一行，焦点回到那一行', (await c.count('[data-provider="kimi"]')) === 0 && (await c.eval(`document.activeElement?.closest('.conn-tile')?.dataset?.service`)) === 'kimi');
    await s.shot('02-connected-night');

    await s.tab('全部');
    eq('全部：五个分组区块', await c.eval(`[...document.querySelectorAll('.svc-group[data-group]')].map((e) => e.dataset.group)`), ['intl', 'cn', 'hub', 'local', 'cli']);
    eq('紧凑行 = 38 家 − 4 家已接入 = 34（已接入的不在分组里重复）', await c.count('.svc-tile'), 34);
    ok('已接入的服务不在紧凑行里', (await c.count('.svc-tile[data-service="deepseek"]')) === 0 && (await c.count('.svc-tile[data-service="gpt"]')) === 1);
    await s.shot('03-all-night');

    // 展开：一次一个，焦点进卡片标题
    await c.clickEl(`document.querySelector('.svc-tile[data-service="gpt"]')`);
    await c.sleep(500);
    ok('点 GPT 的行：原地展开成完整卡片，那一行消失', (await c.count('.svc-row [data-provider="gpt"]')) === 1 && (await c.count('.svc-tile[data-service="gpt"]')) === 0);
    eq('焦点落在卡片标题上', await c.eval(`document.activeElement?.id`), 'model-gpt');
    await s.shot('04-expanded-night');
    await c.clickEl(`document.querySelector('.svc-tile[data-service="gemini"]')`);
    await c.sleep(400);
    ok('再点 Gemini：同一时间只有一个展开，GPT 收回成一行', (await c.count('.svc-row [data-provider]')) === 1 && (await c.count('.svc-row [data-provider="gemini"]')) === 1 && (await c.count('.svc-tile[data-service="gpt"]')) === 1);
    await c.clickEl(`document.querySelector('.svc-row [data-provider="gemini"] button[aria-label^="收起"]')`);
    await c.sleep(300);
    ok('收起：回到紧凑行，焦点回到那一行', (await c.count('.svc-row [data-provider]')) === 0 && (await c.eval(`document.activeElement?.dataset?.service`)) === 'gemini');

    // 分组折叠
    await c.clickEl(`document.querySelector('.svc-group[data-group="cn"] .svc-group__toggle')`);
    await c.sleep(200);
    ok('折叠「国内」：这一组的行不显示，aria-expanded 为 false', (await c.count('.svc-group[data-group="cn"] .svc-tile')) === 0 && (await c.eval(`document.querySelector('.svc-group[data-group="cn"] .svc-group__toggle').getAttribute('aria-expanded')`)) === 'false');
    ok('折叠状态记在 localStorage（模型接入自己的键）', (await c.eval(`JSON.parse(localStorage.getItem('alight/models-ui') || '{}').collapsed?.cn === true`)) === true);
    await c.clickEl(`document.querySelector('.svc-group[data-group="cn"] .svc-group__toggle')`);

    // 国际页签：只看这一组
    await s.tab('国际');
    eq('国际页签：只显示国际一组', await c.eval(`[...document.querySelectorAll('.svc-group[data-group]')].map((e) => e.dataset.group)`), ['intl']);
    await s.tab('已接入');

    // 未核实的预设
    const before = await c.eval(`document.querySelector('.choice-tabs label:nth-child(2) small')?.textContent`);
    await c.clickEl(`document.querySelector('.models-toolbar__switch input')`);
    await c.sleep(300);
    const after = await c.eval(`document.querySelector('.choice-tabs label:nth-child(2) small')?.textContent`);
    ok('「显示未核实的预设」：全部的计数多出被隐藏的预设（49 → 51）', before === '49' && after === '51', `${before} → ${after}`);
    await c.clickEl(`document.querySelector('.models-toolbar__switch input')`);
    ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

/* ═══════════════════════════ 3. 搜索 ═══════════════════════════ */
if (want('search')) {
  section('搜索：别名、模型名、拼音与首字母；输入法组合期间不过滤');
  const s = await session('mixed');
  const c = s.chrome;
  const tiles = () => c.eval(`[...document.querySelectorAll('.svc-tile')].map((e) => e.dataset.service)`);
  const clear = async () => { await c.focus('#models-search'); await c.eval(`(() => { const i = document.querySelector('#models-search'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`); await c.sleep(300); };
  try {
    await s.goModels();
    await c.focus('#models-search');
    await c.type('qianwen');
    await c.sleep(500);
    eq('拼音 qianwen → Qwen', await tiles(), ['qwen']);
    eq('结果数用 aria-live 报出来', (await c.text('.models-toolbar__count')).trim(), '1 个结果');
    await clear();
    await c.type('tyqw');
    await c.sleep(400);
    eq('首字母 tyqw → Qwen', await tiles(), ['qwen']);
    await clear();
    await c.type('通义');
    await c.sleep(400);
    eq('中文别名「通义」→ Qwen', await tiles(), ['qwen']);
    await clear();
    await c.type('sonnet');
    await c.sleep(400);
    ok('模型名 sonnet → Claude，并说明是因为模型匹配', (await tiles()).join() === 'claude' && /模型：Claude Sonnet/.test(await c.text('.svc-tile[data-service="claude"] .svc-tile__via')));
    await clear();
    await c.type('google');
    await c.sleep(400);
    ok('厂商 google → Gemini（别名「谷歌」「argon」同理）', (await tiles()).includes('gemini'));
    await clear();
    await c.type('zzzzqq');
    await c.sleep(400);
    ok('无结果：说明并给出「添加服务」', /没有找到「zzzzqq」/.test(await c.text('.empty')) && /添加服务/.test(await c.text('.empty')));
    await s.shot('05-search-empty-night');
    await clear();
    await c.type('fireworks');
    await c.sleep(400);
    await c.type(' x');
    await c.sleep(300);
    eq('多个词要全部匹配：fireworks x → 没有', await tiles(), []);
    await clear();

    // 输入法：组合期间不过滤，上屏后才过滤
    const n0 = (await tiles()).length;
    await c.focus('#models-search');
    await c.imeSetComposition('tong');
    await c.sleep(400);
    eq('组合中（拼音 tong 还没上屏）：不过滤', (await tiles()).length, n0);
    await c.imeSetComposition('通义');
    await c.sleep(300);
    eq('候选换了也不过滤', (await tiles()).length, n0);
    await c.key('Enter', { keyCode: 229 });
    await c.sleep(200);
    eq('组合中按 Enter：什么也不发生（归输入法）', (await tiles()).length, n0);
    await c.imeCommit('通义');
    await c.sleep(500);
    eq('上屏之后才过滤', await tiles(), ['qwen']);
    await s.shot('06-search-night');
    await c.focus('#models-search');
    await c.key('Escape');
    await c.sleep(400);
    ok('Esc 清空搜索框，行回来', (await c.eval(`document.querySelector('#models-search').value`)) === '' && (await tiles()).length === n0);
    // Ctrl+F 聚焦
    await c.eval(`document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }))`);
    ok('Ctrl+F 聚焦搜索框', (await c.eval(`document.activeElement?.id`)) === 'models-search');
    ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

/* ═══════════════════════════ 4. 套餐端点 ═══════════════════════════ */
if (want('plan')) {
  section('套餐端点：API 页签禁用');
  const s = await session('mixed');
  const c = s.chrome;
  try {
    await s.goModels();
    await s.open('kimi');
    const kimi = `document.querySelector('[data-provider="kimi"]')`;
    ok('Kimi 卡片：有「命令行登录」「API 密钥」两个页签，API 可用', (await c.eval(`${kimi}.querySelector('input[type=radio][value=api]').disabled`)) === false);
    ok('Kimi 的服务地区是下拉（4 个长标签的选项在两列卡里会折成不规则的两行）', (await c.count('[data-provider="kimi"] button[aria-label^="服务地区"]')) === 1);
    await c.clickEl(`${kimi}.querySelector('button[aria-label^="服务地区"]')`);
    await c.waitFor(`!!document.querySelector('.mselect-pop')`);
    await c.clickEl(`[...document.querySelectorAll('.mselect-pop .mselect-opt')].find((o) => /Kimi Code 会员（国内）/.test(o.textContent))`);
    await c.sleep(500);
    ok('选了套餐地区：「API 密钥」页签禁用', (await c.eval(`${kimi}.querySelector('input[type=radio][value=api]').disabled`)) === true);
    ok('禁用时写明原因（悬停与读屏文字）', /套餐 Key 只能给命令行编码工具用/.test(await c.eval(`${kimi}.querySelector('input[type=radio][value=api]').closest('label').title`)));
    ok('自动切到命令行方式，头部有「套餐」标', (await c.eval(`${kimi}.querySelector('input[type=radio][value=cli]').checked`)) === true && /套餐/.test(await c.text('[data-provider="kimi"] .model-card__badges')));
    await s.shot('07-plan-endpoint-night');
    ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

/* ═══════════════════════════ 5. 模型选择器 ═══════════════════════════ */
if (want('picker')) {
  section('模型选择器：100 行上限、置顶、输入即用、输入法');
  const s = await session('mixed', { height: 1300 });
  const c = s.chrome;
  try {
    await s.goModels();
    await s.open('openrouter');
    const trigger = `document.querySelector('[data-provider="openrouter"] button[aria-label^="模型："]')`;
    await c.clickEl(trigger);
    await c.waitFor(`document.querySelectorAll('.mselect-pop .mselect-opt').length > 5`);
    await c.sleep(500);
    const rows = await c.count('.mselect-pop .mselect-opt');
    ok(`没有搜索词时最多画 100 行（实际 ${rows}），其余给出提示`, rows <= 101 && /还有 \d+ 项，输入关键词缩小范围/.test(await c.text('.mselect-pop__more')), `${rows}`);
    const groups = await c.eval(`[...document.querySelectorAll('.mselect-pop .mselect-group__label span')].map((e) => e.textContent)`);
    ok('分区：置顶 → 当前 → 预设 / 实时', groups[0] === '置顶' && groups.some((g) => g === '当前' || g === '预设') && groups.some((g) => g.startsWith('实时')), JSON.stringify(groups));
    ok('头部说明列表来源（实时 · 刚刚）并有「刷新」', /实时/.test(await c.text('.picker-top__state')) && /刷新/.test(await c.text('.picker-top__btn')));
    await s.shot('08-picker-night');

    // 置顶
    const log0 = (await s.log()).length;
    await c.clickEl(`document.querySelectorAll('.mselect-pop .mselect-opt__star')[1]`);
    await c.sleep(400);
    ok('点 ★：向主进程置顶（svc:pin）', (await s.log()).slice(log0).some((e) => e[0] === 'pin' && e[3] === true));
    // 搜索
    await c.type('model-12');
    await c.sleep(500);
    const filtered = await c.count('.mselect-pop .mselect-opt:not(.is-typed)');
    ok(`搜索 model-12：只剩匹配的几行（${filtered}）`, filtered > 0 && filtered < 20);
    // 输入法：组合期间不过滤、回车不选中
    await c.eval(`(() => { const i = document.querySelector('.mselect-pop input[role=combobox]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await c.sleep(400);
    const all0 = await c.count('.mselect-pop .mselect-opt');
    await c.focus('.mselect-pop input[role=combobox]');
    await c.imeSetComposition('anth');
    await c.sleep(400);
    eq('组合期间（anth 未上屏）：不过滤', await c.count('.mselect-pop .mselect-opt'), all0);
    const val0 = await c.eval(`document.querySelector('[data-provider="openrouter"] button[aria-label^="模型："]').getAttribute('aria-label')`);
    await c.key('Enter', { keyCode: 229 });
    await c.sleep(300);
    ok('组合期间按 Enter：不选中任何一行，菜单还开着', (await c.count('.mselect-pop')) === 1 && (await c.eval(`document.querySelector('[data-provider="openrouter"] button[aria-label^="模型："]').getAttribute('aria-label')`)) === val0);
    await c.imeCommit('anthropic/model-000');
    await c.sleep(500);
    ok('上屏后才过滤', (await c.count('.mselect-pop .mselect-opt:not(.is-typed)')) >= 1 && (await c.count('.mselect-pop .mselect-opt')) < all0);
    // 输入即用
    await c.eval(`(() => { const i = document.querySelector('.mselect-pop input[role=combobox]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'my-lab/brand-new-model'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await c.sleep(500);
    ok('搜索词不是现有 id：最后一行「用「…」作为模型 ID」', /用「my-lab\/brand-new-model」作为模型 ID/.test(await c.text('.mselect-opt.is-typed')));
    await c.key('Enter');
    await c.sleep(400);
    ok('Enter 选中它，菜单收起，按钮显示这个 id', (await c.count('.mselect-pop')) === 0 && /my-lab\/brand-new-model/.test(await c.eval(`document.querySelector('[data-provider="openrouter"] button[aria-label^="模型："]').getAttribute('aria-label')`)));
    ok('非法 id（含空格或分号）不提供「用输入的」行', await (async () => {
      await c.clickEl(trigger);
      await c.waitFor(`!!document.querySelector('.mselect-pop input')`);
      await c.type('a b;c');
      await c.sleep(400);
      const n = await c.count('.mselect-opt.is-typed');
      await c.key('Escape');
      return n === 0;
    })());
    ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

/* ═══════════════════════════ 6. 添加与删除服务 ═══════════════════════════ */
if (want('editor')) {
  section('添加服务对话框与删除');
  const s = await session('mixed', { height: 1250 });
  const c = s.chrome;
  try {
    await s.goModels();
    await c.clickEl(`document.querySelector('.models-toolbar__add')`);
    await c.waitFor(`!!document.querySelector('.mselect-pop')`);
    ok('「添加服务」菜单有五项', (await c.count('.mselect-pop .mselect-opt')) === 5);
    await c.clickEl(`[...document.querySelectorAll('.mselect-pop .mselect-opt')].find((o) => /自定义 OpenAI 兼容/.test(o.textContent))`);
    await c.waitFor(`!!document.querySelector('.svc-editor')`);
    ok('对话框打开，「保存」禁用并说明还差哪一项', (await c.eval(`[...document.querySelectorAll('.dialog__footer button')].find((b) => /^保存$/.test(b.textContent.trim())).disabled`)) === true && /还不能保存：请给它起个名字/.test(await c.text('.svc-editor__blocker')));
    await c.focus('.svc-editor input[placeholder^="例如 我的中转站"]');
    await c.type('我的新中转');
    // 局域网 http：拒绝
    await c.focus('.svc-editor input[placeholder="https://api.example.com/v1"]');
    await c.type('http://192.168.1.5:8000/v1');
    await c.sleep(300);
    ok('局域网 http 地址：红字说明，不能保存', /只允许 https/.test(await c.text('.svc-editor .model-field__hint--bad')));
    await c.eval(`(() => { const i = document.querySelector('.svc-editor input[placeholder="https://api.example.com/v1"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'https://api.kimi.com/coding/v1'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await c.sleep(300);
    const planText = await c.text('.svc-editor .model-field__hint--bad');
    ok('某家的套餐地址：红字「套餐 Key 只能给命令行工具用」', /套餐地址/.test(planText) || /套餐 Key 只能给命令行/.test(planText) || planText === '' /* 该预设的套餐地址以目录为准 */, planText);
    await c.eval(`(() => { const i = document.querySelector('.svc-editor input[placeholder="https://api.example.com/v1"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, 'https://api.example.com/v1'); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await c.sleep(300);
    ok('https 地址：显示「密钥只会发往 api.example.com」', /密钥只会发往 api\.example\.com/.test(await c.text('.svc-editor__ok')));
    await c.focus('.svc-editor input[placeholder="例如 gpt-6.1-sol"]');
    await c.type('gpt-6.1-sol');
    await c.sleep(300);
    ok('必填项齐了：「保存」可点，没有阻塞提示', (await c.eval(`[...document.querySelectorAll('.dialog__footer button')].find((b) => /^保存$/.test(b.textContent.trim())).disabled`)) === false && (await c.count('.svc-editor__blocker')) === 0);
    ok('能力预览：聊天可以，干活不可以（只有 OpenAI 协议）', /聊天：可以/.test(await c.eval(`document.querySelector('.svc-editor__preview .grades').innerHTML`)) && /干活：不可以/.test(await c.eval(`document.querySelector('.svc-editor__preview .grades').innerHTML`)));
    await s.shot('09-editor-night');
    // 输入法：名称框里组合期间 Enter 不提交
    await c.focus('.svc-editor input[placeholder^="例如 我的中转站"]');
    await c.imeSetComposition('zhong');
    await c.key('Enter', { keyCode: 229 });
    await c.sleep(300);
    ok('名称框组合期间按 Enter：不提交，对话框还在', (await c.count('.svc-editor')) === 1);
    await c.imeCommit('中转');
    await c.sleep(200);
    const log0 = (await s.log()).length;
    await c.clickEl(`[...document.querySelectorAll('.dialog__footer button')].find((b) => /^保存$/.test(b.textContent.trim()))`);
    await c.waitFor(`!document.querySelector('.svc-editor')`);
    await c.sleep(600);
    ok('保存：对话框关闭，主进程收到 svc:save', (await s.log()).slice(log0).some((e) => e[0] === 'save'));
    ok('新服务出现在「已接入」里，是完整卡片，写着「这是你添加的服务」', (await c.count('.svc-group--connected [data-provider^="x_"]')) >= 1 && (await c.count('.conn-tile[data-service="x_my-relay"]')) === 1 && /这是你添加的服务/.test(await c.text('.svc-group--connected')));
    await s.shot('10-after-save-night');

    // 删除
    const id = await c.eval(`[...document.querySelectorAll('.svc-group--connected [data-provider^="x_"]')].map((e) => e.dataset.provider).find((x) => x !== 'x_my-relay')`);
    await c.clickEl(`[...document.querySelectorAll('[data-provider="${id}"] .model-card__custom button')].find((b) => /删除/.test(b.textContent))`);
    await c.waitFor(`!!document.querySelector('.dialog')`);
    ok('删除确认：说明会清掉密钥、置顶与缓存，以及有几个任务在用', /密钥、置顶的模型和缓存的模型列表/.test(await c.text('.dialog__body')) && /没有任务在用它/.test(await c.text('.dialog__body')));
    await s.shot('11-delete-night');
    await c.clickEl(`[...document.querySelectorAll('.dialog__footer button')].find((b) => /^删除$/.test(b.textContent.trim()))`);
    await c.waitFor(`!document.querySelector('.dialog')`);
    await c.sleep(500);
    ok('删除后：卡片消失，主进程收到 svc:remove', (await c.count(`[data-provider="${id}"]`)) === 0 && (await s.log()).some((e) => e[0] === 'remove' && e[1] === id));
    ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

/* ═══════════════════════════ 7. 任务里的模型菜单 ═══════════════════════════ */
if (want('taskmenu')) {
  section('任务菜单：精选、最近用过、「更多…」');
  const s = await session('mixed', { height: 1100 });
  const c = s.chrome;
  try {
    await s.goModels();     // 打开一次：已接入服务的列表刷新进来
    await s.goHome();
    await c.waitFor(`!!document.querySelector('.pchip[aria-label^="使用的模型"]')`);
    await c.clickEl(`document.querySelector('.pchip[aria-label^="使用的模型"]')`);
    await c.waitFor(`!!document.querySelector('.mselect-pop')`);
    const labels = await c.eval(`[...document.querySelectorAll('.mselect-pop .mselect-group__label span')].map((e) => e.textContent)`);
    ok('分组按「默认引擎 → 其余」排列，默认引擎 DeepSeek 在最前', /DeepSeek/.test(labels[0]), JSON.stringify(labels));
    const orRows = await c.eval(`(() => { const g = [...document.querySelectorAll('.mselect-pop .mselect-group')].find((x) => /OpenRouter/.test(x.textContent)); return g ? g.querySelectorAll('.mselect-opt').length : -1; })()`);
    ok(`OpenRouter 只放精选（置顶 + 当前）加「更多…」，不灌 469 项（${orRows} 行）`, orRows > 0 && orRows <= 4);
    await s.shot('12-taskmenu-night');
    await c.clickEl(`[...document.querySelectorAll('.mselect-pop .mselect-opt')].find((o) => /更多…/.test(o.textContent) && o.closest('.mselect-group') && /OpenRouter/.test(o.closest('.mselect-group').textContent))`);
    await c.sleep(700);
    ok('点「更多…」：同一个菜单换成这个引擎的完整列表（带搜索、最多 100 行）与「返回精选」', (await c.count('.mselect-pop input[role=combobox]')) === 1 && (await c.count('.mselect-pop .mselect-opt')) > 50 && (await c.count('.mselect-pop .mselect-opt')) <= 102 && /返回精选/.test(await c.text('.mselect-pop')));
    await s.shot('13-taskmenu-more-night');
    await c.type('model-050');
    await c.sleep(500);
    await c.key('Enter');
    await c.sleep(500);
    ok('搜索并选中：芯片显示所选模型', /model-050/.test(await c.eval(`document.querySelector('.pchip[aria-label^="使用的模型"]').getAttribute('aria-label')`)));
    // 再打开：选过的模型进「最近用过」
    await c.clickEl(`document.querySelector('.pchip[aria-label^="使用的模型"]')`);
    await c.waitFor(`!!document.querySelector('.mselect-pop')`);
    const labels2 = await c.eval(`[...document.querySelectorAll('.mselect-pop .mselect-group__label span')].map((e) => e.textContent)`);
    ok('最近用过的引擎（OpenRouter）排到前面，仅次于默认引擎', /DeepSeek/.test(labels2[0]) && /OpenRouter/.test(labels2[1]), JSON.stringify(labels2));
    ok('最近用过的模型写进了它的精选', /model-050/.test(await c.eval(`[...document.querySelectorAll('.mselect-pop .mselect-group')].find((x) => /OpenRouter/.test(x.textContent))?.textContent || ''`)));
    ok('最近记录在 localStorage 的 alight/models-ui', (await c.eval(`JSON.parse(localStorage.getItem('alight/models-ui') || '{}').recentEngines?.[0]`)) === 'openrouter:api');
    ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

/* ═══════════════════════════ 7b. 探测本机、失败、自动刷新、开始的三条路 ═══════════════════════════ */
if (want('misc')) {
  section('探测本机、列表拉取失败、自动刷新只碰已接入的服务、开始的三条路');
  {
    const s = await session('mixed', { height: 1250 });
    const c = s.chrome;
    try {
      await s.goModels();
      const calls = (await s.log()).filter((e) => e[0] === 'models').map((e) => e[1]);
      ok('打开页面：只刷新已接入（有密钥）且有列表接口的服务，没有碰没接入的（gemini、ollama…）', calls.length > 0 && calls.every((x) => ['deepseek', 'kimi', 'openrouter'].includes(x)) && !calls.includes('gemini') && !calls.includes('ollama'), JSON.stringify(calls));
      await c.clickEl(`[...document.querySelectorAll('.models-toolbar button')].find((b) => /探测本机/.test(b.textContent))`);
      await c.waitFor(`!!document.querySelector('.models-probe__row')`);
      ok('探测本机：说「在 11434 发现 Ollama，3 个模型」', /在 11434 发现 Ollama，3 个模型/.test(await c.text('.models-probe__row')));
      await s.shot('14-probe-night');
      await c.clickEl(`document.querySelector('.models-probe__row button')`);
      await c.sleep(600);
      ok('点「接入」：切到「本地」页签，Ollama 的卡片展开，模型选了第一个', (await c.eval(`document.querySelector('.choice-tabs .is-selected')?.textContent.trim()`)).startsWith('本地') && (await c.count('[data-provider="ollama"]')) === 1 && /qwen3:32b/.test(await c.eval(`document.querySelector('[data-provider="ollama"] button[aria-label^="模型："]').getAttribute('aria-label')`)));
      ok('不需要密钥：Ollama 已经算「已配置」，且卡片说密钥可不填', /已配置/.test(await c.text('[data-provider="ollama"] .model-card__badges')) && /可不填/.test(await c.text('[data-provider="ollama"]')));
      ok('本机 4K 窗口的警告出现', /上下文只有 4K/.test(await c.text('[data-provider="ollama"]')) || /上下文只有 32K/.test(await c.text('[data-provider="ollama"]')));
      await s.shot('15-ollama-night');
    } finally { await s.close(); }
  }
  {
    const s = await session('failing', { height: 1250 });
    const c = s.chrome;
    try {
      await s.goModels();
      await s.open('openrouter');
      await c.clickEl(`document.querySelector('[data-provider="openrouter"] button[aria-label^="模型："]')`);
      await c.waitFor(`!!document.querySelector('.picker-top__state')`);
      await c.sleep(400);
      ok('列表拉取失败：下拉头部说「实时列表拉取失败：<原因>」，预设与手填照常，「刷新」可重试', /实时列表拉取失败：密钥无效或已过期/.test(await c.text('.picker-top__state')) && (await c.count('.mselect-pop .mselect-opt')) >= 1 && /刷新/.test(await c.text('.picker-top__btn')));
      await s.shot('16-picker-failed-night');
      ok('没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
    } finally { await s.close(); }
  }
  {
    const s = await session('empty', { height: 1100 });
    const c = s.chrome;
    try {
      await s.goModels();
      await c.clickEl(`[...document.querySelectorAll('.models-start__way')].find((b) => /API 密钥/.test(b.textContent))`);
      await c.sleep(300);
      ok('开始 · 我有 API 密钥：到「全部」并聚焦搜索框', (await c.eval(`document.activeElement?.id`)) === 'models-search');
      await c.clickEl(`[...document.querySelectorAll('.models-start__way')].find((b) => b.textContent.includes('ChatGPT'))`);
      await c.sleep(700);
      ok('开始 · 我有订阅：展开 Claude 的卡片，是命令行登录方式', (await c.count('[data-provider="claude"]')) === 1 && (await c.eval(`document.querySelector('[data-provider="claude"] input[type=radio][value=cli]').checked`)) === true);
      await s.shot('17-start-claude-night');
    } finally { await s.close(); }
  }
}

/* ═══════════════════════════ 8. 昼 ═══════════════════════════ */
if (want('day')) {
  section('昼：同一批页面的截图（对比度靠目视与令牌）');
  const s = await session('mixed', { mode: 'day', height: 1300 });
  const c = s.chrome;
  try {
    await s.goModels();
    await s.shot('20-connected-day');
    await s.tab('全部');
    await s.shot('21-all-day');
    await c.focus('#models-search');
    await c.type('qianwen');
    await c.sleep(500);
    await s.shot('22-search-day');
    await c.focus('#models-search');
    await c.key('Escape');
    await c.sleep(300);
    await s.tab('已接入');
    await s.open('openrouter');
    await c.clickEl(`document.querySelector('[data-provider="openrouter"] button[aria-label^="模型："]')`);
    await c.waitFor(`document.querySelectorAll('.mselect-pop .mselect-opt').length > 5`);
    await c.sleep(400);
    await s.shot('23-picker-day');
    await c.key('Escape');
    await c.clickEl(`document.querySelector('.models-toolbar__add')`);
    await c.waitFor(`!!document.querySelector('.mselect-pop')`);
    await c.clickEl(`[...document.querySelectorAll('.mselect-pop .mselect-opt')].find((o) => /自定义 OpenAI 兼容/.test(o.textContent))`);
    await c.waitFor(`!!document.querySelector('.svc-editor')`);
    await c.sleep(300);
    await s.shot('24-editor-day');
    ok('昼：没有控制台报错', errorsOf(c).length === 0, JSON.stringify(errorsOf(c).slice(0, 3)));
  } finally { await s.close(); }
}

console.log(`\n${passed} passed, ${failed} failed  （截图在 ${SHOTS}）`);
process.exit(failed ? 1 : 0);
