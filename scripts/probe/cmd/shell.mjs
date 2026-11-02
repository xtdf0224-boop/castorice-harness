// shell：壳这一路的检查（经主进程 Node 调试端口驱动，不显示窗口）：
//   · 主进程发 app:visibility（窗口被藏进托盘 / 最小化 / 重新显示）→ 页面的 document.visibilityState / hidden / <html data-window-hidden>、CSS 动画暂停；
//   · 主进程发 app:covered（被全屏程序盖住）→ <html data-window-covered>、CSS 动画暂停，但页面仍算可见；
//   · 页面调 desktop.app.setTheme → 主进程的 nativeTheme 与窗口底色；非法值被忽略；
//   · 主进程 stderr 没有未捕获异常。
// 为什么要经主进程发：主窗口 backgroundThrottling:false，页面自己看不出窗口被藏起来了（见 src/lib/windowVisibility.ts）；探针模式下主进程不主动发 app:visibility。
import { launchApp, removeDir } from '../lib/launch.mjs';
import { evaluate, sleep, waitUntil } from '../lib/page.mjs';
import { prepareProfile } from '../lib/profile.mjs';
import { buildPrefs } from '../lib/seed.mjs';
import { INPUT_SELECTOR } from '../lib/targets.mjs';
import { CdpConnection } from '../lib/cdp.mjs';

export async function runShell(ctx) {
  if (ctx.target.id !== 'alight') { ctx.log('shell 只用于栖枝。'); return 2; }
  let fails = 0;
  const ok = (name, pass, detail = '') => {
    ctx.log(`${pass ? '✓' : '✗'} ${name}${pass ? '' : `\n     ${detail}`}`);
    if (!pass) fails += 1;
  };

  const prof = await prepareProfile(ctx, { prefs: buildPrefs({ settings: { mode: 'night' } }), label: 'shell', log: ctx.log });
  const app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, inspectMain: true, viewport: { width: 1440, height: 900 } });
  try {
    const s = app.page;
    await waitUntil(s, `!!document.querySelector(${JSON.stringify(INPUT_SELECTOR)})`, { timeoutMs: 30000 });
    const list = await (await fetch(`http://127.0.0.1:${app.inspectPort}/json/list`)).json();
    const conn = await CdpConnection.connect(list[0].webSocketDebuggerUrl);
    const main = async (expr) => {
      const r = await conn.send('Runtime.evaluate', { expression: expr, returnByValue: true });
      if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300));
      return r.result.value;
    };
    const electron = `process.mainModule.require('electron')`;
    const win = `${electron}.BrowserWindow.getAllWindows()[0]`;
    const state = () => evaluate(s, `document.visibilityState + '/' + document.hidden + '/' + (document.documentElement.dataset.windowHidden ?? '')`);

    ok('起点：页面可见', (await state()) === 'visible/false/', await state());
    await main(`${win}.webContents.send('app:visibility', false)`);
    await sleep(300);
    ok('主进程发 hidden → visibilityState=hidden、document.hidden=true、<html data-window-hidden>', (await state()) === 'hidden/true/1', await state());
    ok('CSS 动画被暂停（每个在跑的动画元素 animation-play-state=paused）',
      await evaluate(s, `[...document.querySelectorAll('*')].filter((e) => getComputedStyle(e).animationName !== 'none').every((e) => getComputedStyle(e).animationPlayState === 'paused')`));
    await main(`${win}.webContents.send('app:visibility', true)`);
    await sleep(300);
    ok('再发 visible → 恢复', (await state()) === 'visible/false/', await state());

    // 被全屏程序盖住（窗口还显示着）：只停动效，不算隐藏。放一块会「呼吸」的面板（base.css 的 .is-breathing）当样本
    await evaluate(s, `(() => { const d = document.createElement('div'); d.id = 'probe-breathe'; d.className = 'is-breathing'; d.style.cssText = 'position:fixed;left:0;top:0;width:40px;height:40px'; document.body.appendChild(d); return 1; })()`);
    const breathe = () => evaluate(s, `getComputedStyle(document.getElementById('probe-breathe')).animationPlayState`);
    const coveredState = () => evaluate(s, `document.visibilityState + '/' + document.hidden + '/' + (document.documentElement.dataset.windowCovered ?? '')`);
    ok('起点：没被盖住，样本面板在呼吸', (await coveredState()) === 'visible/false/' && (await breathe()) === 'running', `${await coveredState()} ${await breathe()}`);
    await main(`${win}.webContents.send('app:covered', true)`);
    await sleep(300);
    ok('主进程发 covered → <html data-window-covered>，页面仍算可见（document.hidden=false）', (await coveredState()) === 'visible/false/1', await coveredState());
    ok('…CSS 动画暂停（样本面板 animation-play-state=paused）', (await breathe()) === 'paused', await breathe());
    await main(`${win}.webContents.send('app:covered', false)`);
    await sleep(300);
    ok('再发 covered=false → 恢复，接着呼吸', (await coveredState()) === 'visible/false/' && (await breathe()) === 'running', `${await coveredState()} ${await breathe()}`);
    await evaluate(s, `document.getElementById('probe-breathe').remove()`);

    // 主题：页面调 setTheme → 主进程 nativeTheme / 窗口底色
    const themeNow = () => main(`JSON.stringify({ src: ${electron}.nativeTheme.themeSource, bg: ${win}.getBackgroundColor() })`).then(JSON.parse);
    await evaluate(s, `window.alightDesktop.app.setTheme('day')`);
    await sleep(400);
    const day = await themeNow();
    ok('setTheme(day) → nativeTheme=light、窗口底色 #dcd5ee', day.src === 'light' && /dcd5ee/i.test(day.bg), JSON.stringify(day));
    await evaluate(s, `window.alightDesktop.app.setTheme('night')`);
    await sleep(400);
    const night = await themeNow();
    ok('setTheme(night) → nativeTheme=dark、窗口底色 #0e0c19', night.src === 'dark' && /0e0c19/i.test(night.bg), JSON.stringify(night));
    await evaluate(s, `window.alightDesktop.app.setTheme('bogus')`);
    await sleep(300);
    ok('非法主题值被忽略', (await themeNow()).src === 'dark');
    conn.close();

    const mainErr = (app.stderr ?? []).join('').split('\n').filter((l) => /UnhandledPromiseRejection|Uncaught|TypeError:|ReferenceError:/.test(l));
    ok('主进程（stderr）没有未捕获异常', mainErr.length === 0, mainErr.slice(0, 2).join(' | '));
  } finally {
    await app.close({ graceMs: 6000 });
    removeDir(prof.userDataDir);
  }
  ctx.log(`\n壳检查：${fails ? '失败' : '通过'}`);
  return fails ? 1 : 0;
}
