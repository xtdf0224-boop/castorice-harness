// 转场专项探针（开机动画 → 转场 → 首页，真 Electron 无头；夜昼 × 完整 / 打断 / 点击 / 减少动态，不丢键、焦点交给首页输入框、玻璃与计算样式恢复、无遗留动画与内联样式；--osr 下另有夜 / 昼的「收尾不闪」两个场景）。
//   node scripts/probe/transition/tr-probe.mjs --app-dir <应用副本目录> [--only night-auto,day-key-early] [--shots <目录>] [--osr]
// 应用副本 = dist + electron + build + package.json + 指向 node_modules 的目录联接（perf-work/harness/mk-app.sh 造；不要对用户正在用的 dist/ 跑）。
// 每个场景：同一份种子配置（假密钥、bootAnimation 开、bootEnter auto）、每次启动都强制播开屏（alight.boot.always=1）。结果写到 <临时目录>/tr-probe-result.json。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const args = process.argv.slice(2);
const argv = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const LIBAPP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const APP = path.resolve(argv('--app-dir') ?? process.env.ALIGHT_TR_APP ?? '');
if (!argv('--app-dir') && !process.env.ALIGHT_TR_APP) { console.error('用法：node scripts/probe/transition/tr-probe.mjs --app-dir <应用副本目录>'); process.exit(2); }
const SCRATCH = process.env.ALIGHT_TR_TMP ? path.resolve(process.env.ALIGHT_TR_TMP) : path.join(os.tmpdir(), 'alight-tr-probe');
fs.mkdirSync(SCRATCH, { recursive: true });
process.env.ALIGHT_PROBE_TMP = path.join(SCRATCH, 'probe-tmp');
fs.mkdirSync(process.env.ALIGHT_PROBE_TMP, { recursive: true });
const L = (f) => pathToFileURL(path.join(LIBAPP, 'scripts/probe/lib', f)).href;
const { launchApp, removeDir } = await import(L('launch.mjs'));
const { findByUserDataDir } = await import(L('proc.mjs'));
const { evaluate, waitUntil, pressKey, screenshot, sleep } = await import(L('page.mjs'));
const { prepareProfile } = await import(L('profile.mjs'));
const { buildPrefs, storageScript } = await import(L('seed.mjs'));
const { TARGETS, INPUT_SELECTOR } = await import(L('targets.mjs'));

const target = TARGETS.alight;
const only = argv('--only')?.split(',');
const OSR = args.includes('--osr');
const shotsDir = argv('--shots') ?? path.join(SCRATCH, 'tr-shots');
fs.mkdirSync(shotsDir, { recursive: true });

const results = [];
let fails = 0;
const add = (scn, name, pass, detail = '') => {
  results.push({ scn, name, pass: !!pass, detail });
  if (!pass) fails += 1;
  console.log(`${pass ? '✓' : '✗'} [${scn}] ${name}${detail ? `  —  ${detail}` : ''}`);
};

// ── 页面内：时间线记录 ──
const TIMELINE = `
  const tl = (globalThis.__tl = []);
  const inputs = (globalThis.__inputs = []);
  let last = '';
  const snap = () => {
    const b = document.querySelector('.boot');
    if (b && globalThis.__bootSeen === undefined) globalThis.__bootSeen = performance.now();
    const sig = (document.documentElement.dataset.boot || '-') + '|' + (b ? b.className.replace(/\\s+/g, ' ') : 'none');
    if (sig !== last) { last = sig; tl.push([performance.now(), sig]); }
  };
  setInterval(snap, 4);
  const frames = (globalThis.__frames = []);
  const raf = (t) => { if (frames.length < 20000) frames.push(t); requestAnimationFrame(raf); };
  requestAnimationFrame(raf);
  globalThis.__bootAge = () => (globalThis.__bootSeen === undefined ? -1 : performance.now() - globalThis.__bootSeen);
  document.addEventListener('input', (e) => { const t = e.target; if (t && t.matches && t.matches('textarea.pbox__input')) inputs.push([performance.now(), t.value]); }, true);
  document.addEventListener('keydown', (e) => { (globalThis.__keys = globalThis.__keys || []).push([performance.now(), e.key, document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 30) : 'none']); }, true);
`;

// 状态快照：一批选择器的计算样式（转场前后应当一致），加上内联样式残留与 boot-tr 动画残留
const SNAPSHOT = `(() => {
  const SELS = ['.side-nav', '.app__main', '.app__view', '.return-col', '.return-col > *', '.console', '.status-panel'];
  const props = ['opacity', 'transform', 'filter', 'backdropFilter', 'maskImage', 'visibility'];
  const rows = [];
  for (const sel of SELS) {
    const els = [...document.querySelectorAll(sel)];
    els.forEach((el, i) => {
      const cs = getComputedStyle(el);
      const row = { key: sel + '#' + i, tag: (el.getAttribute('class') || el.tagName).slice(0, 40) };
      for (const p of props) row[p] = cs[p];
      rows.push(row);
    });
  }
  const glass = getComputedStyle(document.querySelector('.return-col') || document.body, '::before').backdropFilter;
  const nav = document.querySelector('.side-nav');
  const navBF = nav ? getComputedStyle(nav).backdropFilter : null;
  const pbox = document.querySelector('.pbox__box');
  const pboxBF = pbox ? getComputedStyle(pbox).backdropFilter : null;
  const resid = [];
  for (const el of document.querySelectorAll('.app *')) {
    const st = el.getAttribute('style');
    if (st && /(^|;|\\s)(opacity|transform|filter|mask|visibility|backdrop)/.test(st)) resid.push((el.getAttribute('class') || el.tagName).slice(0, 30) + ' :: ' + st.slice(0, 80));
  }
  const anims = document.getAnimations().filter((a) => a.id === 'boot-tr').length;
  const allAnims = document.getAnimations().length;
  const ta = document.querySelector('textarea.pbox__input');
  return JSON.stringify({ rows, glass, navBF, pboxBF, resid, anims, allAnims, boot: !!document.querySelector('.boot'), dataBoot: document.documentElement.dataset.boot, active: document.activeElement ? document.activeElement.tagName + '.' + String(document.activeElement.className).slice(0, 30) : 'none', value: ta ? ta.value : null });
})()`;

const diffSnap = (a, b) => {
  const bad = [];
  const mapB = new Map(b.rows.map((r) => [r.key, r]));
  for (const r of a.rows) {
    const q = mapB.get(r.key);
    if (!q) { bad.push(`${r.key} 消失`); continue; }
    for (const p of ['opacity', 'transform', 'filter', 'backdropFilter', 'maskImage', 'visibility']) if (r[p] !== q[p]) bad.push(`${r.key}(${r.tag}).${p}: ${String(r[p]).slice(0, 40)} → ${String(q[p]).slice(0, 40)}`);
  }
  return bad;
};

// ── 公共 ──
const ctx = { appDir: APP, target };
const prefsFor = (theme, motion) => buildPrefs({ settings: { ...target.themeSetting(theme), bootAnimation: true, bootEnter: 'auto', motion: motion ?? 'full' } });

let profile;
const baseline = async () => {
  profile = await prepareProfile(ctx, { prefs: prefsFor('night'), label: 'trprobe', log: () => {} });
};

async function launchFor(theme, motion) {
  const prefs = prefsFor(theme, motion);
  const init = [
    storageScript({ [target.keys.prefs]: JSON.stringify(prefs), 'alight.boot.always': '1' }, { force: true }),
    TIMELINE,
  ];
  return launchApp({ appDir: APP, userDataDir: profile.userDataDir, keepData: true, viewport: { width: 1440, height: 900 }, init, env: OSR ? { ALIGHT_PROBE_OSR: '1' } : {} });
}

const tlOf = async (s) => {
  const raw = JSON.parse(await evaluate(s, 'JSON.stringify({ tl: globalThis.__tl, seen: globalThis.__bootSeen, inputs: globalThis.__inputs, keys: globalThis.__keys || [], frames: globalThis.__frames || [] })'));
  const rel = raw.tl.map(([t, sig]) => [Math.round(t - raw.seen), sig]);
  const find = (re) => rel.find(([, sig]) => re.test(sig));
  const outAbs = raw.tl.find(([, sig]) => /is-out/.test(sig))?.[0];
  const goneAbs = raw.tl.find(([, sig]) => sig.startsWith('off|'))?.[0];
  let fr = null;
  if (outAbs !== undefined && goneAbs !== undefined) {
    const f = raw.frames.filter((t) => t >= outAbs - 5 && t <= goneAbs + 5);
    const gaps = f.slice(1).map((t, i) => t - f[i]);
    fr = { n: f.length, maxGap: Math.round(Math.max(0, ...gaps)), fps: Math.round((f.length / ((goneAbs - outAbs) / 1000)) * 10) / 10 };
  }
  return {
    fr, rel, inputs: raw.inputs, keys: raw.keys, seen: raw.seen,
    settled: find(/is-settled/)?.[0],
    out: find(/is-out/)?.[0],
    outKind: (find(/is-out--(full|fast|soft)/)?.[1].match(/is-out--(full|fast|soft)/) ?? [])[1],
    gone: rel.find(([, sig]) => sig.startsWith('off|'))?.[0],
  };
};

async function runScenario(name, { theme, motion, emulateReduced, plan }) {
  if (only && !only.includes(name)) return;
  console.log(`\n── ${name} ──`);
  let app;
  try {
    app = await launchFor(theme, motion);
    const s = app.page;
    if (emulateReduced) {
      await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await s.send('Page.reload');
    }
    await waitUntil(s, `document.documentElement.dataset.boot === 'on' && !!document.querySelector('.boot')`, { timeoutMs: 25000, label: '开屏出现' });
    await waitUntil(s, `!!document.querySelector(${JSON.stringify(INPUT_SELECTOR)})`, { timeoutMs: 20000, label: '输入框出现' });
    const mode = await evaluate(s, 'document.documentElement.dataset.mode');
    add(name, `主题 ${theme}`, mode === theme, `data-mode=${mode}`);
    const reducedOn = await evaluate(s, `document.documentElement.dataset.motion`);
    add(name, `运动档位符合预期（${reducedOn}）`, (motion === 'reduced' || emulateReduced) ? reducedOn === 'reduced' : reducedOn === 'full');
    await sleep(900);
    // 应用自己的入场动画（页面 translateY 之类）走完再取「转场前」快照
    await waitUntil(s, `(() => { const v = document.querySelector('.app__view'); return !v || getComputedStyle(v).transform === 'none'; })()`, { timeoutMs: 6000, label: '应用入场动画走完' }).catch(() => {});
    const pre = JSON.parse(await evaluate(s, SNAPSHOT));
    // 开屏 + 转场期间（data-boot=on）boot.css 把内容列里每一块的 backdrop-filter 关掉（块是 backdrop root、BF 在块里没有效果、却每帧多开一个渲染通道），
    // 昼还关掉主栏玻璃 .return-col::before 的（糊的是纸面，糊前糊后只差蝶纹的锐度）；夜的主栏玻璃糊的是壁纸，一直开着；结束随 data-boot 恢复
    add(name, theme === 'day' ? '转场前：昼的主栏玻璃 backdrop-filter 按设计关着（data-boot=on）' : '转场前：首页玻璃有 backdrop-filter', theme === 'day' ? pre.glass === 'none' : /blur/.test(pre.glass), pre.glass);
    add(name, '转场前：输入框的 backdrop-filter 按设计关着（块里的 BF 没有效果）', pre.pboxBF === 'none', String(pre.pboxBF));
    await plan({ s, app, pre, name, theme });
    // 收尾
    const errs = app.errors();
    add(name, '控制台没有错误', errs.length === 0, errs.slice(0, 4).map((e) => `[${e.kind}] ${e.text.slice(0, 200)}`).join(' | '));
    const failedReq = (app.requestsFailed ?? []).filter((r) => !r.canceled);
    if (failedReq.length) add(name, '没有失败的网络请求', false, JSON.stringify(failedReq.slice(0, 3)));
  } catch (e) {
    add(name, '场景没有抛错', false, e.stack ?? e.message);
  } finally {
    if (app) {
      const closed = await app.close({ graceMs: 8000 });
      add(name, '应用自行退出且无残留', !closed.forced && findByUserDataDir(profile.userDataDir).length === 0, `forced=${closed.forced}`);
    }
  }
}

// ── 通用检查：转场结束之后 ──
async function afterChecks(name, s, pre, tl, expectText, expectKind, durRange) {
  await sleep(700);
  const post = JSON.parse(await evaluate(s, SNAPSHOT));
  add(name, '转场结束：开屏层已卸载，data-boot=off', !post.boot && post.dataBoot === 'off', `boot=${post.boot} data-boot=${post.dataBoot}`);
  add(name, '转场结束：没有遗留的转场动画（boot-tr）', post.anims === 0, `boot-tr=${post.anims}，全部动画=${post.allAnims}`);
  const newResid = post.resid.filter((r) => !pre.resid.includes(r));
  add(name, '转场结束：转场没有给应用元素留下内联 opacity/transform/filter/mask 样式（相对转场前新增）', newResid.length === 0, `新增 ${newResid.length}：${newResid.slice(0, 4).join(' | ')}（转场前本就有 ${pre.resid.length} 条，多为品牌标 SVG 的 drop-shadow）`);
  add(name, '转场结束：主栏玻璃的 backdrop-filter 已恢复（夜：与转场前一致；昼：开屏期间关着，结束后是 blur(12px) saturate(1.12)）', /blur/.test(post.glass) && (name.startsWith('day') ? true : post.glass === pre.glass), `前=${pre.glass} 后=${post.glass}`);
  add(name, '转场结束：输入框的 backdrop-filter 已恢复', /blur/.test(String(post.pboxBF)), `前=${pre.pboxBF} 后=${post.pboxBF}`);
  add(name, '转场结束：左栏面板的 backdrop-filter 与转场前一致', post.navBF === pre.navBF, `前=${pre.navBF} 后=${post.navBF}`);
  const diffs = diffSnap(pre, post);
  add(name, '转场结束：应用元素的计算样式（透明度/变换/滤镜/遮罩/可见性）与转场前一致', diffs.length === 0, diffs.slice(0, 5).join(' | '));
  if (expectText !== undefined) add(name, `输入框里是键入的「${expectText}」`, post.value === expectText, `实际=${JSON.stringify(post.value)}`);
  add(name, '焦点停在首页输入框', /TEXTAREA\.pbox__input/.test(post.active), post.active);
  if (expectKind) add(name, `转场种类 = ${expectKind}`, tl.outKind === expectKind, `实际=${tl.outKind}`);
  if (tl.fr) console.log(`   转场期间 rAF：${tl.fr.n} 帧，约 ${tl.fr.fps} fps，最长间隔 ${tl.fr.maxGap} ms`);
  if (durRange && tl.out !== undefined && tl.gone !== undefined) {
    const d = tl.gone - tl.out;
    add(name, `转场时长 ${d} ms 在 ${durRange[0]}–${durRange[1]} ms 内`, d >= durRange[0] && d <= durRange[1], `开屏 ${tl.out} ms 进入转场，${tl.gone} ms 交还`);
  }
  return post;
}

const shot = async (s, name, tag) => { try { await screenshot(s, path.join(shotsDir, `${name}-${tag}.png`)); } catch (e) { console.log(`   截图失败 ${tag}: ${e.message}`); } };

// ── 计划 ──
const planAuto = (expectKind, durRange) => async ({ s, pre, name }) => {
  // 不按键：等它播完 → 定格 → 约 3 s 后自己进入
  await waitUntil(s, `document.documentElement.dataset.boot === 'off'`, { timeoutMs: 40000, label: '开屏自己结束' });
  const tl = await tlOf(s);
  console.log(`   时间线：定格 ${tl.settled} ms；进入转场 ${tl.out} ms（${tl.outKind}）；交还 ${tl.gone} ms`);
  if (tl.settled !== undefined && tl.out !== undefined) add(name, `定格后约 3 s 自动进入（${tl.out - tl.settled} ms）`, tl.out - tl.settled >= 2800 && tl.out - tl.settled <= 3800);
  await afterChecks(name, s, pre, tl, '', expectKind, durRange);
};

// 在 settled 之前按键：打断（快速版）；之后按键：完整版
const planKey = ({ when, keys, expectKind, durRange, shotMid }) => async ({ s, pre, name }) => {
  if (when === 'early') await waitUntil(s, `globalThis.__bootAge() >= 2300`, { timeoutMs: 20000, label: '开屏播到 2.3 s' });
  else await waitUntil(s, `!!document.querySelector('.boot.is-settled')`, { timeoutMs: 30000, label: '定格' }).then(() => sleep(700));
  const first = keys[0];
  await pressKey(s, first);
  const sawOut = await waitUntil(s, `!!document.querySelector('.boot.is-out')`, { timeoutMs: 2000, intervalMs: 8, label: '进入转场' }).catch(() => false);
  add(name, '按键 → 立刻进入转场（is-out）', sawOut);
  // 转场开始的这一刻：焦点已交给输入框、覆盖层不挡指针、第一个键已在输入框里
  const mid0 = await evaluate(s, `(() => { const b = document.querySelector('.boot'); const ta = document.querySelector('textarea.pbox__input'); return JSON.stringify({ pe: b ? getComputedStyle(b).pointerEvents : null, active: document.activeElement === ta, value: ta ? ta.value : null, anims: document.getAnimations().filter((a) => a.id === 'boot-tr').length, cls: b ? b.className : null }); })()`).then(JSON.parse);
  add(name, '转场开始：焦点在首页输入框，第一个键已进输入框', mid0.active && mid0.value === first, JSON.stringify(mid0));
  add(name, '转场开始：覆盖层 pointer-events:none', mid0.pe === 'none', mid0.pe);
  let typed = first;
  // 每个键之后各取一次「转场在跑吗 / boot-tr 动画有几个」：软件渲染的无头页面慢（rAF 偶尔隔 0.5 s），最后一个键敲完时转场可能刚好收尾（is-out 还在、动画已撤）——
  // 只看最后一次会偶发 anims = 0 的误报（在已验收的第二轮构建上也复现）；只要敲字期间任何一次采样看到动画，或最后一次已不在转场里，就算数
  const sampleTr = () => evaluate(s, `(() => { const b = document.querySelector('.boot'); return JSON.stringify({ inTransition: !!b && b.classList.contains('is-out'), anims: document.getAnimations().filter((a) => a.id === 'boot-tr').length }); })()`).then(JSON.parse);
  let maxAnims = mid0.anims || 0;
  for (let i = 1; i < keys.length; i++) {
    await sleep(keys.delayMs ?? 180);
    if (i === 2 && shotMid) await shot(s, name, 'mid');
    await pressKey(s, keys[i]);
    typed += keys[i];
    maxAnims = Math.max(maxAnims, (await sampleTr()).anims);
  }
  const midState = await sampleTr();
  maxAnims = Math.max(maxAnims, midState.anims);
  add(name, '转场中继续敲字时转场仍在跑（应用侧有 boot-tr 动画）', midState.inTransition ? maxAnims > 0 : true, JSON.stringify({ ...midState, maxAnims }));
  await waitUntil(s, `document.documentElement.dataset.boot === 'off'`, { timeoutMs: 10000, label: '转场结束' });
  const tl = await tlOf(s);
  console.log(`   时间线：定格 ${tl.settled} ms；进入转场 ${tl.out} ms（${tl.outKind}）；交还 ${tl.gone} ms；输入框历史 ${JSON.stringify(tl.inputs.map(([, v]) => v))}`);
  await shot(s, name, 'end');
  await afterChecks(name, s, pre, tl, typed, expectKind, durRange);
  // 敲字没有因转场丢键：每个键都进了输入框（输入历史单调增长到 typed）
  add(name, '敲字过程没有丢键（输入历史逐字增长）', tl.inputs.map(([, v]) => v).join('>') === [...typed].map((_, i) => typed.slice(0, i + 1)).join('>'), tl.inputs.map(([, v]) => v).join('>'));
};

const planReducedAuto = () => async ({ s, pre, name }) => {
  await waitUntil(s, `!!document.querySelector('.boot.is-settled')`, { timeoutMs: 15000, label: '直接定格' });
  const tl0 = await tlOf(s);
  console.log(`   直接定格于 ${tl0.settled} ms`);
  add(name, '减少动态：开屏几乎立刻定格（< 1.5 s，没有播 8 s 动画）', tl0.settled !== undefined && tl0.settled < 1500, `${tl0.settled} ms`);
  await waitUntil(s, `document.documentElement.dataset.boot === 'off'`, { timeoutMs: 10000, label: '3 s 后自己进入' });
  const tl = await tlOf(s);
  console.log(`   时间线：定格 ${tl.settled} ms；进入 ${tl.out} ms（${tl.outKind}）；交还 ${tl.gone} ms`);
  add(name, '减少动态：定格约 3 s 后自己进入', tl.out - tl.settled >= 2800 && tl.out - tl.settled <= 3800, `${tl.out - tl.settled} ms`);
  await afterChecks(name, s, pre, tl, '', 'soft', [100, OSR ? 450 : 1500]);
};

const planReducedKey = () => async ({ s, pre, name }) => {
  await waitUntil(s, `!!document.querySelector('.boot.is-settled')`, { timeoutMs: 15000, label: '直接定格' });
  await sleep(500);
  await pressKey(s, 'm');
  await sleep(40);
  await pressKey(s, 'n');
  await waitUntil(s, `document.documentElement.dataset.boot === 'off'`, { timeoutMs: 5000, label: '交叉淡化结束' });
  const tl = await tlOf(s);
  console.log(`   时间线：定格 ${tl.settled} ms；进入 ${tl.out} ms（${tl.outKind}）；交还 ${tl.gone} ms`);
  const anims = await evaluate(s, `document.getAnimations().filter((a) => a.id === 'boot-tr').length`);
  add(name, '减少动态：没有 boot-tr 动画（不做位移转场）', anims === 0, `${anims}`);
  await afterChecks(name, s, pre, tl, 'mn', 'soft', [100, OSR ? 450 : 1500]);
};

// 开屏期间点击也能进入、点击不会误触下面的东西
const planClick = () => async ({ s, pre, name }) => {
  await waitUntil(s, `globalThis.__bootAge() >= 2300`, { timeoutMs: 20000 });
  const before = await evaluate(s, 'JSON.stringify({ view: document.title, hash: location.hash })');
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 120, y: 400 });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 120, y: 400, button: 'left', buttons: 1, clickCount: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 120, y: 400, button: 'left', clickCount: 1 });
  const sawOut = await waitUntil(s, `!!document.querySelector('.boot.is-out')`, { timeoutMs: 2000, intervalMs: 8 }).catch(() => false);
  add(name, '点击 → 进入转场', sawOut);
  await waitUntil(s, `document.documentElement.dataset.boot === 'off'`, { timeoutMs: 10000 });
  const after = await evaluate(s, 'JSON.stringify({ view: document.title, hash: location.hash })');
  add(name, '点击没有误触下面的按钮（页面标题没变）', before === after, `${before} → ${after}`);
  const tl = await tlOf(s);
  await afterChecks(name, s, pre, tl, undefined, 'fast', [550, 1000]);
};

// 转场收尾不闪：转场自然结束时 end() 取消动画、React 要到下一个宏任务才卸载开屏层——取消了覆盖层里的 fill:both 动画的话，覆盖层瞬间回到完整不透明的开屏定格画面，被画出一帧（整屏闪一下）。
// DOM 采样（rAF / setInterval）看不到这一帧（取消与卸载之间的那一帧在两个 rAF 之间被画出），所以用屏幕投射（Page.startScreencast）的小图逐帧和「定格开屏帧」比：
// 转场已经明显离开开屏（与开屏帧差 > 15）之后，不许再有一帧回到开屏（差 < 5）；最后一帧 = 首页（与终态帧差 0）。只在 --osr 下跑（隐藏窗口下 rAF 约 1 Hz，没有可比的帧）。
const planFlash = () => async ({ s, name }) => {
  if (!OSR) { add(name, '收尾不闪（需要 --osr：隐藏窗口下没有可比的帧，跳过）', true, '跳过'); return; }
  await waitUntil(s, `!!document.querySelector('.boot.is-settled')`, { timeoutMs: 30000, label: '定格' });
  await sleep(500);
  const frames = [];
  s.on('Page.screencastFrame', (p) => { frames.push(p.data); s.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {}); });
  await s.send('Page.startScreencast', { format: 'png', maxWidth: 160, maxHeight: 100, everyNthFrame: 1 });
  await sleep(500);
  await pressKey(s, 'x');
  await waitUntil(s, `document.documentElement.dataset.boot === 'off'`, { timeoutMs: 10000, label: '转场结束' });
  await sleep(700);
  await s.send('Page.stopScreencast');
  const dec = await evaluate(s, `(async () => {
    const frames = ${JSON.stringify(frames)};
    const out = [];
    for (const b64 of frames) {
      const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      out.push(g.getImageData(0, 0, c.width, c.height).data);
    }
    const A = out[0], B = out[out.length - 1];
    const d = (X, Y) => { let t = 0, n = 0; for (let i = 0; i < X.length; i += 4) { t += Math.abs(X[i] - Y[i]) + Math.abs(X[i + 1] - Y[i + 1]) + Math.abs(X[i + 2] - Y[i + 2]); n += 3; } return t / n; };
    return JSON.stringify(out.map((f) => [Math.round(d(f, A) * 10) / 10, Math.round(d(f, B) * 10) / 10]));
  })()`, { awaitPromise: true }).then(JSON.parse);
  const vsBoot = dec.map((x) => x[0]);
  const left = vsBoot.findIndex((v) => v > 15);
  const back = left < 0 ? [] : vsBoot.map((v, i) => [i, v]).filter(([i, v]) => i > left && v < 5);
  add(name, `屏幕投射取到足够的帧（${dec.length} 帧）且转场明显离开过开屏`, dec.length >= 20 && left >= 0, `vsBoot 序列末 20 帧：${vsBoot.slice(-20).join(',')}`);
  add(name, '转场收尾不闪：离开开屏之后没有任何一帧回到开屏定格画面（与开屏帧差 < 5）', back.length === 0, back.length ? `回到开屏的帧 #${back.map(([i, v]) => `${i}(${v})`).join(' #')}；vsBoot 末 14 帧：${vsBoot.slice(-14).join(',')}` : `最小 ${Math.min(...vsBoot.slice(left + 1))}`);
  add(name, '转场收尾：最后一帧就是首页（与终态帧差 0）', dec[dec.length - 1][1] === 0, `${dec[dec.length - 1][1]}`);
};

await baseline();
// 默认（隐藏窗口）下 rAF 只有约 1 Hz，转场结束要等下一帧：时长上限放宽 1.5 s，只验证功能；--osr 下才验证时长
const D_FULL = OSR ? [1000, 1700] : [1000, 3200];
const D_FAST = OSR ? [550, 1200] : [550, 2700];

await runScenario('night-auto', { theme: 'night', plan: planAuto('full', D_FULL) });
await runScenario('night-key-early', { theme: 'night', plan: planKey({ when: 'early', keys: ['x', 'y', 'z'], expectKind: 'fast', durRange: D_FAST, shotMid: true }) });
await runScenario('night-key-settled', { theme: 'night', plan: planKey({ when: 'settled', keys: ['q', 'r', 's'], expectKind: 'full', durRange: D_FULL, shotMid: true }) });
await runScenario('night-click-early', { theme: 'night', plan: planClick() });
await runScenario('day-auto', { theme: 'day', plan: planAuto('full', D_FULL) });
await runScenario('day-key-early', { theme: 'day', plan: planKey({ when: 'early', keys: ['x', 'y', 'z'], expectKind: 'fast', durRange: D_FAST, shotMid: true }) });
await runScenario('day-key-settled', { theme: 'day', plan: planKey({ when: 'settled', keys: ['q', 'r', 's'], expectKind: 'full', durRange: D_FULL, shotMid: true }) });
await runScenario('night-flash', { theme: 'night', plan: planFlash() });
await runScenario('day-flash', { theme: 'day', plan: planFlash() });
await runScenario('night-reduced-setting-auto', { theme: 'night', motion: 'reduced', plan: planReducedAuto() });
await runScenario('day-reduced-setting-key', { theme: 'day', motion: 'reduced', plan: planReducedKey() });
await runScenario('night-reduced-os-key', { theme: 'night', motion: 'system', emulateReduced: true, plan: planReducedKey() });

removeDir(profile.userDataDir);
removeDir(path.join(profile.userDataDir, '..', `${path.basename(profile.userDataDir)}-claude-config`));
fs.writeFileSync(path.join(SCRATCH, 'tr-probe-result.json'), JSON.stringify({ at: new Date().toISOString(), fails, results }, null, 2));
console.log(`\n转场专项：${fails ? '失败' : '通过'}（${results.length - fails}/${results.length} 项通过，${fails} 项失败）`);
process.exit(fails ? 1 : 0);
