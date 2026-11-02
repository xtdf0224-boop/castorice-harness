/* 阶段一：渲染。把昼开屏的「背景层」（文字与光尘除外）逐帧渲染成无损母版（FFV1 mkv，分段）。
   原理：无 HMR 的 vite dev（端口 5332，源码镜像见 make-render-src.sh）+ 无头 Chrome（软件渲染 --disable-gpu，CSS 视口与 DPR 见 geometry.json：2140x1020 @1.5 = 3210x1530 设备像素）
   打开 ?bootcap=day（DOM 蒙版路径，与 0.1.3 逐像素相同），逐帧 window.__boot.seek(t, { leaveAt: 1e9 }) → Page.captureScreenshot → 直接把 PNG 管给 ffmpeg(ffv1)。
   第 i 帧 = 场景时刻 t = i / fps（fps = geometry.json，现为 60），i = 0 … 444（T_END = 7.4 s 是最后一帧）。

   用法（先 bash make-render-src.sh patch）：
     node render.mjs                              全量 445 帧 → perf-work/bootvideo/master/seg_000.mkv …（每段 120 帧，可断点续渲：已完成的段跳过）
     node render.mjs --frames 0-19 --out DIR      只渲一段范围到 DIR（量耗时 / 复现性检查用；DIR 里存 seg 与 png 哈希）
     --mode patch|hook   patch（默认）= 镜像 src-render-patch（HEAD + 关光尘、藏文字的补丁）；hook = 镜像 src-render-hook，调 seek(t,{leaveAt:1e9,layers:'bg'})（I 的 DEV 钩子）
     --scale 0.846（默认取 geometry.json；改了就要自己指定新的 --out）  --seg 120  --fps 60  --w 1774  --h 846  --keep-png DIR（顺便把每帧 PNG 存下来，调试用）
   重任务纪律：持 perf-work/av/.heavy-lock；开跑前等别的渲染 / 编码 / 高负载结束（最多 60 分钟）；低优先级；ffmpeg -threads 4；不碰 GPU。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WORK, FFMPEG, sleep, log, lowerPriority, waitQuiet, takeLock, release, startVite, launchChrome } from './lib.mjs';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); if (i < 0) return d; const v = args[i + 1]; args.splice(i, 2); return v; };
const flag = (n) => { const i = args.indexOf('--' + n); if (i < 0) return false; args.splice(i, 1); return true; };
const MODE = opt('mode', 'hook');
const GEO = JSON.parse(fs.readFileSync(new URL('./geometry.json', import.meta.url), 'utf8'));
const SCALE = Number(opt('scale', GEO.scale));
const FPS = Number(opt('fps', GEO.fps)), SEG = Number(opt('seg', 120));
const DPR = Number(opt('dpr', GEO.dpr ?? 1));
const CH = Number(opt('h', SCALE === GEO.scale ? GEO.cssHeight ?? GEO.height : Math.round(1000 * SCALE / DPR)));            // CSS 视口（设备像素 = CSS x DPR）
const CW = Number(opt('w', SCALE === GEO.scale ? GEO.cssWidth ?? GEO.width : Math.round((2098 * CH / 1000) / 2) * 2));
const VW = CW, VH = CH;
const T_END = 7.4, NFRAMES = Math.round(T_END * FPS) + 1;         // 889
const range = (opt('frames', `0-${NFRAMES - 1}`)).split('-').map(Number);
const OUT = opt('out', path.join(WORK, 'master'));
const KEEP_PNG = opt('keep-png', null);
const PORT = Number(opt('port', 5332));
const NOWAIT = flag('no-wait');
const SRC = path.join(WORK, `src-render-${MODE}`);
lowerPriority();

function ffv1Writer(file) {
  const tmp = file + '.part.mkv';
  const p = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-threads', '4', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'png', '-i', '-',
    '-vf', 'format=bgr0', '-c:v', 'ffv1', '-level', '3', '-coder', '1', '-context', '1', '-g', '1', '-slices', '4', '-slicecrc', '1', '-threads', '4', '-r', String(FPS), tmp],
  { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('close', (c) => (c === 0 ? res() : rej(new Error('ffmpeg exit ' + c)))));
  return {
    write: async (buf) => { if (!p.stdin.write(buf)) await new Promise((r) => p.stdin.once('drain', r)); },
    finish: async () => { p.stdin.end(); await done; fs.renameSync(tmp, file); },
    abort: () => { try { p.kill(); } catch { /* ignore */ } },
  };
}

async function main() {
  const [f0, f1] = range;
  fs.mkdirSync(OUT, { recursive: true });
  if (KEEP_PNG) fs.mkdirSync(KEEP_PNG, { recursive: true });
  await waitQuiet(NOWAIT);
  await takeLock();
  log(`lock taken; mode=${MODE} frames ${f0}-${f1} -> ${OUT}`);
  let vite, chrome;
  try {
    vite = await startVite(SRC, PORT);
    chrome = await launchChrome(VW, VH, DPR);
    const { send } = chrome;
    await send('Page.enable'); await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: DPR, mobile: false });
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/?bootcap=day` });
    for (let i = 0; i < 400; i++) { const r = await send('Runtime.evaluate', { expression: 'typeof window.__boot', returnByValue: true }); if (r.result.value === 'object') break; await sleep(100); }
    const ev = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('page error: ' + JSON.stringify(r.exceptionDetails).slice(0, 400)); return r.result.value; };
    const info = await ev('({ theme: window.__boot.theme, duration: window.__boot.duration, w: innerWidth, h: innerHeight, dpr: devicePixelRatio })');
    log('page', JSON.stringify(info));
    if (info.theme !== 'day' || Math.abs(info.duration - T_END) > 1e-9 || info.w !== VW || info.h !== VH || info.dpr !== DPR) throw new Error('unexpected page state ' + JSON.stringify(info));
    const seekOpts = MODE === 'hook' ? "{ leaveAt: 1e9, layers: 'vid' }" : '{ leaveAt: 1e9 }';      // vid = 视频母版：环境层 + 绽开期的立绘；蝶 / 雪点 / 光尘 / 文字不画，B 类 fx 不画，2.7+ 的立绘由实时 DOM 层承担

    const manifest = [];
    const t0 = Date.now();
    let done = 0;
    for (let s0 = Math.floor(f0 / SEG) * SEG; s0 <= f1; s0 += SEG) {
      const a = Math.max(s0, f0), b = Math.min(s0 + SEG - 1, f1);
      const segName = `seg_${String(s0 / SEG).padStart(3, '0')}.mkv`;
      const segFile = path.join(OUT, segName);
      const shaFile = segFile + '.png-sha256.txt';
      if (fs.existsSync(segFile) && fs.existsSync(shaFile) && (a === s0 && (b === s0 + SEG - 1 || b === NFRAMES - 1))) { log('skip existing', segName); continue; }
      const w = ffv1Writer(segFile);
      const shas = [];
      try {
        for (let k = a; k <= b; k++) {
          const t = k / FPS;
          const r0 = await send('Runtime.evaluate', { expression: `window.__boot.seek(${t}, ${seekOpts})`, awaitPromise: true, returnByValue: true });
          if (r0.exceptionDetails) throw new Error('seek error: ' + JSON.stringify(r0.exceptionDetails).slice(0, 300));
          const r = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
          const png = Buffer.from(r.data, 'base64');
          shas.push(`${k} ${crypto.createHash('sha256').update(png).digest('hex')}`);
          if (KEEP_PNG) fs.writeFileSync(path.join(KEEP_PNG, `f${String(k).padStart(4, '0')}.png`), png);
          await w.write(png);
          done++;
          if (done % 20 === 0 || k === b) log(`frame ${k}  (${done} done, ${((Date.now() - t0) / done / 1000).toFixed(2)} s/frame)`);
        }
        await w.finish();
      } catch (e) { w.abort(); throw e; }
      fs.writeFileSync(shaFile, shas.join('\n') + '\n');
      manifest.push({ seg: segName, from: a, to: b });
    }
    log(`done ${done} frames in ${((Date.now() - t0) / 1000).toFixed(0)} s (${((Date.now() - t0) / Math.max(done, 1) / 1000).toFixed(2)} s/frame)`);
  } finally {
    if (chrome) await chrome.close();
    if (vite) { vite.kill(); }
    release();
    log('lock released; chrome + vite stopped');
  }
}

main().catch((e) => { console.error(e); release(); process.exit(1); });
