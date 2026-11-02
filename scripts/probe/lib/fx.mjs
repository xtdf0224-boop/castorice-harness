// 验收探针的公共件（施工图 §7.3，T）：shot / shots / flows 共用。
//   · 固定钟点：init 脚本改写 Date，页面里 __probeClock.set('2026-10-27T23:42:00') 随时拨钟（本地时间，无时区后缀）；
//   · 注入状态：window.__alight.applyFixture(name, opts)（src/components/decor/devFixture.ts，只在 --mode development 构建里有）；
//   · 步骤串：'click:<css>' 'clicktext:<文字>' 'scroll:<css>' 'wait:<ms>' 'key:<键>' 'hover:<css>' 'eval:<js>'（manifest 与 --click 共用）；
//   · 截图前：关 toast、等动画收完（data-motion 不动，靠等待）。
// 不写应用代码、不碰仓库 dist：被测应用目录一律由 --app-dir 给（构建副本）。
import fs from 'node:fs';
import path from 'node:path';
import { buildPrefs } from './seed.mjs';
import { clickSelector, clickText, evaluate, mouseClick, pressKey, screenshot, sleep, waitUntil } from './page.mjs';
import { INPUT_SELECTOR } from './targets.mjs';

export const DEFAULT_CLOCK = '2026-10-27T16:20:00';

/** 页面里改写 Date：不带参数的 new Date() / Date.now() 返回「拨钟后的现在」，时间照走. */
export function clockSource(iso) {
  return `(() => {
  const R = Date; let off = 0;
  const set = (v) => { off = v == null ? 0 : new R(v).getTime() - R.now(); };
  function F(...a) { if (!new.target) return new R(R.now() + off).toString(); return a.length ? new R(...a) : new R(R.now() + off); }
  F.prototype = R.prototype; F.now = () => R.now() + off; F.parse = R.parse; F.UTC = R.UTC;
  Object.defineProperty(F, 'name', { value: 'Date' });
  globalThis.Date = F; globalThis.__probeClock = { set, real: R };
  ${iso ? `set(${JSON.stringify(iso)});` : ''}
})();`;
}

/** 验收用的偏好：关开屏、出错不自动开控制台、指定夜昼；其余走应用默认. settingsRev / agentsRev 对齐当前版本（不触发旧存档迁移）. */
export function fxPrefs({ theme = 'night', settings = {}, fakeApi } = {}) {
  // 没指定假服务时（shot / shots）用像真的模型名，别让占位名 claude-probe-1 进模型菜单与截图
  const p = buildPrefs({ settings: { mode: theme, bootAnimation: false, openConsoleOnError: false, lifeGreeting: false, ...settings }, fakeApi: fakeApi ?? { baseUrl: '', model: 'claude-sonnet-5-5' } });
  p.settingsRev = 5;
  p.agentsRev = 2;
  return p;
}

/** 等 App 渲染完成且开发把手（__alight.applyFixture）就绪. */
export async function waitDevApi(s, timeoutMs = 40000) {
  await waitUntil(s, `(() => { const e = document.querySelector(${JSON.stringify(INPUT_SELECTOR)}); return !!e && !e.closest('[inert]') && typeof window.__alight?.applyFixture === 'function'; })()`, { timeoutMs, label: '页面就绪并有 __alight.applyFixture（要用 --mode development 构建的副本）' });
}

export async function setClock(s, iso) {
  await evaluate(s, `window.__probeClock ? (window.__probeClock.set(${JSON.stringify(iso ?? null)}), true) : false`);
}

/** 应用一个注入状态. 返回 true / false（名字不认识）. */
export async function applyFixture(s, name, opts = {}) {
  const r = await evaluate(s, `(() => { const a = window.__alight; if (!a || typeof a.applyFixture !== 'function') return 'noapi'; return a.applyFixture(${JSON.stringify(name)}, ${JSON.stringify(opts)}) ? 'ok' : 'unknown'; })()`);
  if (r === 'noapi') throw new Error('页面里没有 __alight.applyFixture：被测副本要用 --mode development 构建（见 docs/ 或探针 usage）');
  return r === 'ok';
}

export const closeToasts = (s) => evaluate(s, `(window.__alight?.clearToasts?.(), document.querySelectorAll('.toast').length)`);

export async function setViewport(s, width, height, scale = 1) {
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
}

/* ───────────── 步骤串 ───────────── */

/** 一步：字符串 'click:css' 等，或 { click: css } / { wait: ms } 对象. */
export function parseStep(step) {
  if (typeof step === 'object' && step) {
    const [k] = Object.keys(step);
    return { op: k, arg: step[k] };
  }
  const m = /^(click|clicktext|scroll|wait|key|hover|eval|focus):([\s\S]*)$/.exec(String(step));
  if (!m) throw new Error(`不认识的步骤：${step}`);
  return { op: m[1], arg: m[2] };
}

export async function runStep(s, step) {
  const { op, arg } = parseStep(step);
  switch (op) {
    case 'click': await clickSelector(s, arg); await sleep(180); return;
    case 'clicktext': {
      const [text, within] = String(arg).split('@');
      await clickText(s, text, within ? { within } : {});
      await sleep(180);
      return;
    }
    case 'scroll': {
      const ok = await evaluate(s, `(() => { const e = document.querySelector(${JSON.stringify(arg)}); if (!e) return false; e.scrollIntoView({ block: 'start', behavior: 'instant' }); return true; })()`);
      if (!ok) throw new Error(`scroll：找不到 ${arg}`);
      await sleep(120);
      return;
    }
    case 'wait': await sleep(Number(arg)); return;
    case 'key': {
      const parts = String(arg).split('+');
      const key = parts.pop();
      await pressKey(s, key, { mods: parts.map((x) => x.toLowerCase()) });
      await sleep(120);
      return;
    }
    case 'hover': {
      const hit = await evaluate(s, `(() => { const e = document.querySelector(${JSON.stringify(arg)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
      if (!hit) throw new Error(`hover：找不到 ${arg}`);
      await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hit.x, y: hit.y });
      await sleep(180);
      return;
    }
    case 'focus': await evaluate(s, `document.querySelector(${JSON.stringify(arg)})?.focus({ preventScroll: true }), true`); return;
    case 'eval': await evaluate(s, String(arg)); await sleep(120); return;
    default: throw new Error(`不认识的步骤：${op}`);
  }
}

export async function runSteps(s, steps = []) {
  for (const st of steps) await runStep(s, st);
}

/* ───────────── 截图 ───────────── */

/** 截图前的体检：返回页面上的几个事实，shots 把它们写进报告（空白图、被 toast 挡住、控制台报错一眼能看出来）. */
export async function pageFacts(s) {
  return JSON.parse(await evaluate(s, `JSON.stringify((() => {
    const t = document.body.innerText || '';
    const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
    return {
      title: document.title, mode: document.documentElement.dataset.mode, motion: document.documentElement.dataset.motion, w: innerWidth, h: innerHeight,
      textLen: t.length, toasts: [...document.querySelectorAll('.toast')].filter(vis).length,
      herAvatars: document.querySelectorAll('[data-her-avatar]').length, stickers: document.querySelectorAll('[data-sticker]').length,
      overlay: !!document.getElementById('fx-avatar-crop'), boot: document.documentElement.dataset.boot,
    };
  })())`));
}

/** 动画收完再截：等 ms，关 toast，再等一帧；返回体检结果. */
export async function settleAndShoot(s, file, { wait = 900, clip } = {}) {
  await sleep(wait);
  for (let i = 0; i < 3; i++) {
    const n = await closeToasts(s);
    if (!n) break;
    await sleep(260);
  }
  await sleep(120);
  const facts = await pageFacts(s);
  const t0 = performance.now();
  await screenshot(s, file, clip ? { clip } : {});
  facts.shootMs = Math.round(performance.now() - t0);
  return facts;
}

export function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

export { mouseClick, sleep, evaluate, waitUntil };

/* ───────────── 开跑前的体检（规则：一次只开一个重任务；有游戏 / 渲染在跑就等） ───────────── */

import { spawnSync } from 'node:child_process';

const BUSY_NAMES = ['ffmpeg', 'StarRail', 'ZenlessZoneZero', 'YuanShen', 'GenshinImpact', 'r5apex', 'osu!', 'blender', 'HandBrake', 'obs64', 'Premiere Pro', 'AfterFX'];

/** 本机有没有别的重活在跑：返回原因列表（空 = 可以开跑）. 大 python（工作集 > 800 MB）也算. 其他 electron.exe 不算（用户的栖枝开着是正常的）. */
export function busyReasons() {
  const ps = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$n=@(${BUSY_NAMES.map((x) => `'${x}'`).join(',')}); $o=@(); foreach($p in Get-Process -ErrorAction SilentlyContinue){ if($n -contains $p.ProcessName){ $o+=$p.ProcessName } elseif($p.ProcessName -match '^python'){ if($p.WorkingSet64 -gt 800MB){ $o+=('python('+[int]($p.WorkingSet64/1MB)+'MB)') } } }; ($o | Sort-Object -Unique) -join ','`],
  { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return (ps.stdout || '').trim().split(',').filter(Boolean);
}

/** 有重活就每 5 分钟复查一次，最多等 60 分钟；还不行就抛错（调用方停下来写进报告，不要硬跑）. --no-preflight 跳过. */
export async function waitForQuiet(ctx, { everyMs = 300_000, maxMs = 3_600_000 } = {}) {
  if (ctx.values['no-preflight']) return;
  const t0 = Date.now();
  for (;;) {
    const busy = busyReasons();
    if (!busy.length) return;
    if (Date.now() - t0 >= maxMs) throw new Error(`本机一直有别的重活在跑（${busy.join('、')}），等了 ${Math.round((Date.now() - t0) / 60000)} 分钟，不硬跑`);
    ctx.log(`本机有别的重活在跑：${busy.join('、')}；5 分钟后复查（已等 ${Math.round((Date.now() - t0) / 60000)} 分钟）`);
    await sleep(everyMs);
  }
}
