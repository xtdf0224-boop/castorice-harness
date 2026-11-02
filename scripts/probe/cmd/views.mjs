// views：夜、昼两套主题 × 全部视图的巡检（无头、不弹窗、不花额度）。
//   node scripts/probe/run.mjs views [--tmp <目录>] [--out <截图目录>] [--json <结果.json>]
// 逐项检查（每个视图、每套主题）：
//   · 进得去（页面标题变成该视图的名字）、<html data-mode> 与当前主题一致；
//   · 这一步里控制台没有新的错误（console.error / 未捕获异常 / 资源加载失败，含 ERR_FILE_NOT_FOUND 的 url）；
//   · 署名（[data-credit]）：至少一处可见、完整在视口内、外框不与 .console / .side-nav / .app__main / .status-panel 相交
//     （昼的署名写在她的拱窗里：必须落在 .daystage__arch / .status-panel__arch 之内；夜在窄窗里写在右栏底部 .status-panel__foot）。
//     壁纸层 pointer-events:none，elementFromPoint 点不到它，所以用外框相交，不用 elementFromPoint；
//   · 主题是用界面上的「切换到昼 / 夜」按钮切的（不是改设置文件），所以「能切到夜/昼」本身也在这里验证。
// 来源：B1 的署名断言（scratchpad credit-check）搬进探针，并并入「控制台无错误」。
import path from 'node:path';
import { launchApp, removeDir } from '../lib/launch.mjs';
import { clickText, evaluate, pressKey, screenshot, sleep, waitUntil } from '../lib/page.mjs';
import { prepareProfile } from '../lib/profile.mjs';
import { buildPrefs, buildStateBlob } from '../lib/seed.mjs';
import { INPUT_SELECTOR } from '../lib/targets.mjs';
import { writeJson } from '../lib/ctx.mjs';

const NAV = { new: '1', tasks: '2', agents: '3', tools: '4', models: '5', history: '6', settings: '7' };
const TITLE = { new: '归来', queue: '待你', task: '整理发布说明', tasks: '任务列表', agents: 'Agent', tools: '工具与技能', models: '模型接入', history: '行迹', settings: '设置' };
const VIEWS = ['new', 'queue', 'task', 'tasks', 'agents', 'tools', 'models', 'history', 'settings'];

/** 页面里求值：署名元素的可见性与外框相交。返回每个署名一条记录。 */
const CREDIT_CHECK = `(() => {
  const vis = (el) => { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; let p = el; while (p) { if (+getComputedStyle(p).opacity === 0) return false; p = p.parentElement; } const r = el.getBoundingClientRect(); return r.width > 4 && r.height > 4; };
  const credits = [...document.querySelectorAll('[data-credit]')].filter(vis);
  const ui = ['.console', '.side-nav', '.app__main', '.status-panel'].map((s) => [s, document.querySelector(s)]).filter(([, e]) => e && vis(e));
  const W = innerWidth, H = innerHeight;
  const hit = (a, b) => !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  return JSON.stringify(credits.map((c) => {
    const r = c.getBoundingClientRect();
    const inside = r.left >= 0 && r.top >= 0 && r.right <= W && r.bottom <= H;
    const host = c.closest('.daystage__arch, .status-panel__arch, .status-panel__foot, .tarot-card');
    const over = ui.filter(([, e]) => hit(r, e.getBoundingClientRect()) && !(host && e.contains(host))).map(([s]) => s);
    let withinHost = true;
    if (host) { const h = host.getBoundingClientRect(); withinHost = r.left >= h.left - 1 && r.right <= h.right + 1 && r.top >= h.top - 1 && r.bottom <= h.bottom + 1; }
    return { kind: c.dataset.credit, text: c.textContent.slice(0, 30), rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], inside, overlaps: over, withinHost };
  }));
})()`;

export async function runViews(ctx) {
  const v = ctx.values;
  const width = Number(v.width ?? 1600);
  const height = Number(v.height ?? 1000);
  const outDir = ctx.outDir;
  const results = [];
  let fails = 0;
  const add = (name, pass, detail = '') => {
    results.push({ name, pass: !!pass, detail });
    if (!pass) fails += 1;
    ctx.log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `\n     ${detail}` : ''}`);
  };

  const state = buildStateBlob({ tasks: [{ id: 'T-demo-1', title: TITLE.task, messages: 24, seed: 3 }, { id: 'T-demo-2', title: '检查构建脚本', messages: 8, seed: 5 }] });
  const prefs = buildPrefs({ settings: { ...ctx.target.themeSetting('night') } });
  const prof = await prepareProfile(ctx, { prefs, state, label: 'views', log: ctx.log });
  const app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, viewport: { width, height } });
  try {
    const s = app.page;
    await waitUntil(s, `(() => { const e = document.querySelector(${JSON.stringify(INPUT_SELECTOR)}); return !!e && !e.closest('[inert]'); })()`, { timeoutMs: 30000 });
    let seen = app.consoleLog.length;
    const newErrors = () => {
      const fresh = app.consoleLog.slice(seen).filter((e) => e.level === 'error');
      seen = app.consoleLog.length;
      return fresh.map((e) => `[${e.kind}] ${e.text.slice(0, 160)}${e.url ? `  ← ${e.url}` : ''}`);
    };

    for (const theme of ['night', 'day']) {
      if (theme === 'day') {
        // 用界面上的按钮切（左栏底部：「切换到昼（花海）」），不是改设置文件
        const toggled = await clickText(s, '切换到昼', { within: 'nav' }).then(() => true).catch(async () => {
          return evaluate(s, `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('切换到昼')); if (!b) return false; b.click(); return true; })()`);
        });
        add('用左栏的按钮切到昼', toggled === true || !!toggled);
        await waitUntil(s, `document.documentElement.dataset.mode === 'day'`, { timeoutMs: 5000 }).catch(() => {});
        await sleep(1200);
      }
      const mode = await evaluate(s, 'document.documentElement.dataset.mode');
      add(`主题是「${theme}」（<html data-mode>=${mode}）`, mode === theme);
      for (const view of VIEWS) {
        const tag = `${theme} · ${view}`;
        try {
          if (view === 'queue') await clickText(s, '待你', { within: 'nav' });
          else if (view === 'task') {
            await pressKey(s, NAV.tasks, { mods: ['alt'] });
            await sleep(500);
            await clickText(s, TITLE.task, { within: 'main' });
          } else await pressKey(s, NAV[view], { mods: ['alt'] });
          await waitUntil(s, `document.title.startsWith(${JSON.stringify(TITLE[view])})`, { timeoutMs: 15000, label: `进入「${view}」` });
          await sleep(1800);
          const errs = newErrors();
          add(`${tag}：控制台没有新错误`, errs.length === 0, errs.slice(0, 4).join('\n     '));
          const credits = JSON.parse(await evaluate(s, CREDIT_CHECK));
          const bad = credits.filter((c) => !c.inside || c.overlaps.length || !c.withinHost);
          add(`${tag}：署名可见、在视口内、没被盖住（${credits.length} 处：${credits.map((c) => c.kind).join('/') || '无'}）`,
            credits.length >= 1 && bad.length === 0,
            credits.length === 0 ? '没有找到可见的 [data-credit]' : bad.map((c) => `${c.kind} ${c.rect.join(',')} 压住它的：${c.overlaps.join('+') || '（出了视口或没落在拱窗里）'}`).join('\n     '));
          if (outDir) await screenshot(s, path.join(outDir, `views-${theme}-${view}.png`));
        } catch (e) {
          add(`${tag}：能进入并检查`, false, e.message);
        }
      }
    }
    // 主进程这一路：切主题走了 app:theme，页面巡检里也调了 store: / usage: / trust: 通道；主进程不能有未捕获异常
    const mainErr = (app.stderr ?? []).join('').split('\n').filter((l) => /UnhandledPromiseRejection|Uncaught (Exception|Error)|TypeError:|ReferenceError:|Error: /.test(l));
    add('主进程（stderr）没有未捕获异常', mainErr.length === 0, mainErr.slice(0, 3).join('\n     '));
  } finally {
    await app.close({ graceMs: 6000 });
    removeDir(prof.userDataDir);
  }
  ctx.log(`\n视图巡检：${fails ? '失败' : '通过'}（${results.length - fails}/${results.length} 项通过）`);
  if (v.json) writeJson(v.json, { target: ctx.target.id, at: new Date().toISOString(), pass: fails === 0, results });
  return fails ? 1 : 0;
}
