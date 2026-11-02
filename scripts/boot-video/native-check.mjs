/* 硬规则 4 的实测：视频里每张官方素材被渲染成多少像素，对比素材原图。
   在源码镜像里开 ?bootcap=day，视口高 = 1000 x s（DPR 1），t 从 0 到 7.4 每 0.05 s 一步（seek），读 DOM 的 getBoundingClientRect（含所有祖先变换），
     · 立绘  img.s0-art：渲染边长（px）/ 原图边长（1600）
     · 花海条 .pstrip（background-size: 1700px auto，原图 1700 x 216）：渲染宽度 / 原图宽度 = 累计缩放（background-size 就是原图宽 1700px，1 单位 = 1 原图像素）
     · 光晕底图 img.bk（只是 60 px 模糊的背景，仅记录）
   输出每个素材在整个 [0, 7.4] 里的最大「渲染 / 原图」比，以及超过 1.0 的时间段。比值 > 1 = 放大超过原图 = 违反硬规则 4。
   用法：node native-check.mjs [--s 0.944,0.846] [--step 0.05] [--json OUT.json]    （源码镜像须已存在：make-render-src.sh patch）
   不弹窗：只开无头 Chrome（软件渲染）与 vite dev；轻量，仍按纪律持锁。 */
import fs from 'node:fs';
import path from 'node:path';
import { WORK, sleep, log, lowerPriority, waitQuiet, takeLock, release, startVite, launchChrome } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const SCALES = opt('s', '0.944').split(',').map(Number);
const STEP = Number(opt('step', 0.05));
const OUTJ = opt('json', null);
const MODE = opt('mode', 'patch');
const PORT = Number(opt('port', 5332));
const SRC = path.join(WORK, `src-render-${MODE}`);
const T_END = 7.4;

lowerPriority();
await waitQuiet(false);
await takeLock();
let vite, chrome;
const result = {};
try {
  vite = await startVite(SRC, PORT);
  chrome = await launchChrome(1980, 944);
  const { send } = chrome;
  await send('Page.enable'); await send('Runtime.enable');
  for (const s of SCALES) {
    const H = Math.round(1000 * s), W = Math.round(2097.5 * s / 2) * 2;
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?bootcap=day&_=${s}` });
    for (let i = 0; i < 400; i++) { const r = await send('Runtime.evaluate', { expression: 'typeof window.__boot', returnByValue: true }); if (r.result.value === 'object') break; await sleep(100); }
    const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; };
    const k = H / 1000;
    const rows = [];
    for (let t = 0; t <= T_END + 1e-9; t += STEP) {
      const tt = Math.min(T_END, Math.round(t * 1000) / 1000);
      const m = await ev(`(async () => {
        await window.__boot.seek(${tt}, { leaveAt: 1e9 });
        const art = document.querySelector('img.s0-art'), bk = document.querySelector('.bd-bg img.bk');
        const strips = [...document.querySelectorAll('.pstrip')].map((e) => ({ w: e.getBoundingClientRect().width / e.offsetWidth, op: getComputedStyle(e.parentElement).opacity, pop: getComputedStyle(e.parentElement.classList.contains('bd-pre') ? e.parentElement : e.parentElement).opacity }));
        const pre = document.querySelector('.bd-pre');
        return { art: art.getBoundingClientRect().width, artH: art.getBoundingClientRect().height, bk: bk.getBoundingClientRect().width, strips, preOp: parseFloat(pre.style.opacity || '1') };
      })()`);
      const strip = m.strips.map((x) => x.w * 1.0);
      rows.push({ t: tt, art: Math.max(m.art, m.artH) / 1600, bk: m.bk / 1600, strip: Math.max(...strip), preOp: m.preOp, strips: strip });
    }
    const over = (key) => {
      const segs = []; let cur = null;
      for (const r of rows) {
        if (r[key] > 1 + 1e-6) { if (!cur) cur = { from: r.t, to: r.t, max: r[key] }; cur.to = r.t; cur.max = Math.max(cur.max, r[key]); } else if (cur) { segs.push(cur); cur = null; }
      }
      if (cur) segs.push(cur);
      return segs;
    };
    const mx = (key) => rows.reduce((a, r) => (r[key] > a.v ? { v: r[key], t: r.t } : a), { v: -1, t: 0 });
    result[s] = { viewport: [W, H], k, art: { ...mx('art'), over: over('art') }, strip: { ...mx('strip'), over: over('strip') }, bk: { ...mx('bk'), note: 'blur(60px) 背景，仅记录' },
      splashMaxEdgePx: Math.round(mx('art').v * 1600 * 100) / 100, stripMaxPxPerNativePx: mx('strip').v, first: rows[0], atT0: rows[0] };
    log(`s=${s} (${W}x${H}): 立绘最大 ${(mx('art').v * 1600).toFixed(1)} px / 1600 (比 ${mx('art').v.toFixed(4)} @ t=${mx('art').t}); 花海条最大比 ${mx('strip').v.toFixed(4)} @ t=${mx('strip').t}; 超 1.0 的时段 ${JSON.stringify(over('strip'))}`);
    result[s].rows = rows;
  }
} finally {
  if (chrome) await chrome.close();
  if (vite) vite.kill();
  release();
}
if (OUTJ) fs.writeFileSync(OUTJ, JSON.stringify(result, null, 1));
