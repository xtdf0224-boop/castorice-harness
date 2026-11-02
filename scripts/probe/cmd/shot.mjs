// shot：给指定视图/主题/尺寸截图（无头、不弹窗）。供集成者与评审对照样稿 design/mockups/*/shots 用。
//   node scripts/probe/run.mjs shot --view new --theme night --out <目录>
//   验收状态（要用 --mode development 构建的副本，--app-dir 指向它）：
//   node scripts/probe/run.mjs shot --app-dir <副本> --fixture work-approval-high --level m --persona on --theme day --wallpaper off
//        --click "click:.tarot-pick" --wait 900 --date 2026-10-27T23:42:00 --width 1440 --height 900 --out <目录> --file x.png
// 窗口不可见时合成器不出帧，截图走 Page.captureScreenshot(fromSurface)：会强制出一帧，CSS 动画停在当前时刻；
// 想截「动效状态」请加 --wait 毫秒。落雪/蝴蝶等 rAF 驱动的画布在不可见窗口里只会走很慢，截图里它们的位置不代表真实运行。
import path from 'node:path';
import { launchApp, newUserDataDir, removeDir } from '../lib/launch.mjs';
import { clickText, evaluate, pressKey, screenshot, sleep, waitUntil } from '../lib/page.mjs';
import { prepareProfile } from '../lib/profile.mjs';
import { buildPrefs, buildStateBlob } from '../lib/seed.mjs';
import { INPUT_SELECTOR } from '../lib/targets.mjs';
import { DEFAULT_CLOCK, applyFixture, clockSource, fxPrefs, runSteps, setViewport, settleAndShoot, waitDevApi, waitForQuiet } from '../lib/fx.mjs';

const NAV = { new: '1', tasks: '2', agents: '3', tools: '4', models: '5', history: '6', settings: '7' };
const TITLE = { new: ['归来', '新建'], queue: ['待你'], tasks: ['任务列表'], agents: ['Agent'], tools: ['工具与技能'], models: ['模型接入'], history: ['行迹'], settings: ['设置'] };

/** --fixture：注入一个验收状态再截图. */
async function runFixtureShot(ctx) {
  const v = ctx.values;
  const theme = String(v.theme ?? 'night');
  const level = String(v.level ?? 'm');
  const persona = String(v.persona ?? 'on') !== 'off';
  const wallpaper = String(v.wallpaper ?? 'on') !== 'off';
  const width = Number(v.width ?? 1440);
  const height = Number(v.height ?? 900);
  const outDir = ctx.outDir ?? path.resolve(process.cwd(), 'probe-shots');
  const file = path.join(outDir, v.file ?? `${v.fixture}-${theme}-${level}${persona ? '' : '-plain'}${wallpaper ? '' : '-nowall'}.png`);
  const clock = v.date ? String(v.date) : DEFAULT_CLOCK;
  await waitForQuiet(ctx);
  const prefs = fxPrefs({ theme });
  const entries = JSON.stringify({ [ctx.target.keys.prefs]: JSON.stringify(prefs) });
  const userDataDir = newUserDataDir('shot');
  ctx.step(`启动（主题 ${theme}，${width}×${height}，钟点 ${clock}）`);
  const app = await launchApp({
    appDir: ctx.appDir, userDataDir, keepData: true, viewport: { width, height },
    init: [`try { const e = ${entries}; for (const k of Object.keys(e)) localStorage.setItem(k, e[k]); } catch (err) { console.error('probe seed failed ' + err); }`, clockSource(clock)],
  });
  try {
    const s = app.page;
    await waitDevApi(s);
    await setViewport(s, width, height);
    const ok = await applyFixture(s, String(v.fixture), { level, persona, theme, wallpaper });
    if (!ok) throw new Error(`不认识的状态：${v.fixture}`);
    await sleep(500);
    await runSteps(s, v.click ?? []);
    const facts = await settleAndShoot(s, file, { wait: Number(v.wait ?? 900) });
    ctx.log(`截图 ${file}
  ${JSON.stringify(facts)}`);
    const errs = app.errors();
    if (errs.length) ctx.log(`  控制台错误 ${errs.length} 条：${errs[0].text.slice(0, 160)}`);
    return 0;
  } finally {
    await app.close({ graceMs: 6000 });
    removeDir(userDataDir);
  }
}

export async function runShot(ctx) {
  const v = ctx.values;
  if (v.fixture) return runFixtureShot(ctx);
  const view = String(v.view ?? 'new');
  const theme = String(v.theme ?? 'night');
  const width = Number(v.width ?? 1440);
  const height = Number(v.height ?? 900);
  const scale = Number(v.scale ?? 1);
  if (!(view in TITLE) && view !== 'task') throw new Error(`未知的 --view：${view}`);
  const outDir = ctx.outDir ?? path.resolve(process.cwd(), 'probe-shots');
  const file = path.join(outDir, v.file ?? `${view}-${theme}.png`);

  const withTasks = v.seed === 'tasks' || view === 'task';
  const state = withTasks ? buildStateBlob({ tasks: [{ id: 'T-demo-1', title: '整理发布说明', messages: 24, seed: 3 }, { id: 'T-demo-2', title: '检查构建脚本', messages: 8, seed: 5 }] }) : undefined;
  const prefs = buildPrefs({ settings: { ...ctx.target.themeSetting(theme) } });
  ctx.step(`准备配置目录（主题 ${theme}${withTasks ? '，带 2 个示例任务' : ''}）`);
  const prof = await prepareProfile(ctx, { prefs, state, label: 'shot', log: ctx.log });
  const app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, viewport: { width, height, deviceScaleFactor: scale } });
  try {
    const s = app.page;
    await waitUntil(s, `(() => { const e = document.querySelector(${JSON.stringify(INPUT_SELECTOR)}); return !!e && !e.closest('[inert]'); })()`, { timeoutMs: 30000 });
    if (view !== 'new') {
      if (view === 'queue') await clickText(s, '待你', { within: 'nav, aside, body' });
      else if (view === 'task') {
        await pressKey(s, NAV.tasks, { mods: ['alt'] });
        await sleep(500);
        await clickText(s, '整理发布说明', { within: 'main' });
      } else await pressKey(s, NAV[view], { mods: ['alt'] });
      const wants = view === 'task' ? ['整理发布说明'] : TITLE[view];
      await waitUntil(s, `${JSON.stringify(wants)}.some((t) => document.title.startsWith(t))`, { timeoutMs: 15000, label: `进入「${view}」` });
    }
    await sleep(Number(v.wait ?? 1200));
    await screenshot(s, file);
    const info = await evaluate(s, `JSON.stringify({ title: document.title, theme: document.documentElement.dataset.mode || document.documentElement.dataset.theme, w: innerWidth, h: innerHeight, dpr: devicePixelRatio })`);
    ctx.log(`截图 ${file}\n  ${info}`);
    const errs = app.errors();
    if (errs.length) ctx.log(`  控制台错误 ${errs.length} 条：${errs[0].text.slice(0, 160)}`);
    return 0;
  } finally {
    await app.close({ graceMs: 6000 });
    removeDir(prof.userDataDir);
  }
}
