/* 昼 · 开屏的烘焙（0.1.4）：把绽开段里「每拍都要重新光栅」的几样东西预先画成位图——
   · 立绘（.s0-art）连同它的两条遮罩 → 一张位图（bakeArt）；
   · 花海条（.pstrip：背景图 + brightness/saturate 滤镜 + 竖向遮罩 + 不透明度 + 宽窗口的横向遮罩）→ 一张位图（bakeStrip），近景 / 预览两处共用；
   · 近景散花（svg.s0-fl：13 朵花 + 3 组 blur）→ 一张位图（bakeFlowers）；
   · 立绘的模糊光晕（img.bk：blur(60px) saturate(1.1)，2.7 s 后静止却每帧是一个大渲染面）→ 1/8 分辨率位图（bakeBk，低分辨率上糊）。
   位图都按「舞台单位 × 密度 S」画（S = 舞台缩放 k × 像素比），与 DOM 版同一套数值；解码走 createImageBitmap（后台线程），不在主线程同步解码（H1：2.6 s 的整体冻结就是主线程解码 splash 图）.
   每个函数一次只做几毫秒的画布命令（命令走 GPU），调用方在任务之间让出（nextTask），整套烘焙不出现 > 10 ms 的主线程任务. */
import { mk } from './bootDom';
import { HALO_PAD, bakeHalo } from './plateBake';

/** 让出主线程到下一个宏任务（MessageChannel：不像 setTimeout(0) 那样有 ≥ 1–4 ms 的钳制）. */
export function nextTask(): Promise<void> {
  return new Promise((res) => {
    try {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { ch.port1.close(); res(); };
      ch.port2.postMessage(0);
    } catch { setTimeout(res, 0); }
  });
}

export interface Decoded { src: CanvasImageSource; w: number; h: number; how: 'fetch' | 'xhr' | 'img' | 'element' }

/** 把一张图解码成 ImageBitmap（解码在后台线程）：优先 fetch → blob → createImageBitmap；file:// 的 fetch 被拒就试 XHR；再退 createImageBitmap(<img>)；都不行 = 用 <img> 本身（主线程首次绘制时解码，老行为）. */
export async function decodeImage(url: string, el?: HTMLImageElement): Promise<Decoded | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const r = await fetch(url);
      if (r.ok) { const b = await createImageBitmap(await r.blob()); return { src: b, w: b.width, h: b.height, how: 'fetch' }; }
    } catch { /* file:// 不让 fetch */ }
    try {
      const blob = await new Promise<Blob>((res, rej) => {
        const x = new XMLHttpRequest();
        x.open('GET', url);
        x.responseType = 'blob';
        x.onload = () => ((x.status === 200 || x.status === 0) && x.response ? res(x.response as Blob) : rej(new Error(`xhr ${x.status}`)));
        x.onerror = () => rej(new Error('xhr'));
        x.send();
      });
      const b = await createImageBitmap(blob);
      return { src: b, w: b.width, h: b.height, how: 'xhr' };
    } catch { /* 也不行 */ }
    if (el && el.complete && el.naturalWidth) {
      try { const b = await createImageBitmap(el); return { src: b, w: b.width, h: b.height, how: 'img' }; } catch { /* 退到元素本身 */ }
    }
  }
  if (el && el.complete && el.naturalWidth) return { src: el, w: el.naturalWidth, h: el.naturalHeight, how: 'element' };
  return null;
}

const ctx2d = (c: HTMLCanvasElement): CanvasRenderingContext2D => c.getContext('2d') as CanvasRenderingContext2D;
/** 画布边长的上限（像素）：再大的窗口按比例缩小密度，免得单张位图太大. */
export const MAX_SIDE = 4096;
const sized = (w: number, S: number, h: number): [number, number, number] => {
  const s = Math.min(S, MAX_SIDE / Math.max(w, h));
  return [Math.max(2, Math.ceil(w * s)), Math.max(2, Math.ceil(h * s)), s];
};

/** 花海条 .pstrip（.s0-pf）的位图：宽 elW × 高 210 个舞台单位。CSS 的次序：背景图（1700px auto，位置 -40px 0）→ filter: brightness(1.2) saturate(.8) → mask-image: linear-gradient(0deg, #000, rgba(0,0,0,.85) 42%, transparent) → opacity .85；
    宽窗口（wide = wExt > 1600）时容器 .bd-near1 / .bd-pre 还有一条横向遮罩 linear-gradient(90deg, #000 0, #000 1380px, transparent 1640px)——烘进位图，容器上的遮罩撤掉。
    elW = .pstrip 元素的宽：预览条（.bd-pre 里）被 resize 写成 wExt，近景条（.bd-bloom > .bd-near1 里）保持样式表里的 1600——0.1.3 就是这样，位图跟着它走. */
export function bakeStrip(bmp: Decoded, elW: number, wide: boolean, S: number): { cv: HTMLCanvasElement; s: number } {
  const [w, h, s] = sized(elW, S, 210);
  const cv = mk(w, h);
  const g = ctx2d(cv);
  g.setTransform(s, 0, 0, s, 0, 0);
  g.filter = 'brightness(1.2) saturate(.8)';
  g.drawImage(bmp.src, -40, 0, 1700, (1700 * bmp.h) / bmp.w);
  g.filter = 'none';
  g.globalCompositeOperation = 'destination-in';
  const v = g.createLinearGradient(0, 210, 0, 0);
  v.addColorStop(0, '#000'); v.addColorStop(0.42, 'rgba(0,0,0,.85)'); v.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = v;
  g.fillRect(0, 0, elW, 210);
  g.fillStyle = 'rgba(0,0,0,.85)';
  g.fillRect(0, 0, elW, 210);
  if (wide) {
    const hg = g.createLinearGradient(0, 0, 1640, 0);
    hg.addColorStop(0, '#000'); hg.addColorStop(1380 / 1640, '#000'); hg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = hg;
    g.fillRect(0, 0, elW, 210);
  }
  g.globalCompositeOperation = 'source-over';
  return { cv, s };
}

/** 立绘 .s0-art（1280 × 1280，左上在 (470, -62)）连同它的两条遮罩（mask-composite: intersect = 相乘）：横向 transparent 0–6%、.55 15%、#000 25%–57%、.5 65%、.16 73%、transparent 83%；竖向 transparent 0、#000 13%–100%. */
export function bakeArt(bmp: Decoded, S: number): { cv: HTMLCanvasElement; s: number } {
  const [w, h, s] = sized(1280, S, 1280);
  const cv = mk(w, h);
  const g = ctx2d(cv);
  g.setTransform(s, 0, 0, s, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(bmp.src, 0, 0, 1280, 1280);
  g.globalCompositeOperation = 'destination-in';
  const hg = g.createLinearGradient(0, 0, 1280, 0);
  const hs: Array<[number, string]> = [[0, 'rgba(0,0,0,0)'], [0.06, 'rgba(0,0,0,0)'], [0.15, 'rgba(0,0,0,.55)'], [0.25, '#000'], [0.57, '#000'], [0.65, 'rgba(0,0,0,.5)'], [0.73, 'rgba(0,0,0,.16)'], [0.83, 'rgba(0,0,0,0)'], [1, 'rgba(0,0,0,0)']];
  for (const [o, c] of hs) hg.addColorStop(o, c);
  g.fillStyle = hg;
  g.fillRect(0, 0, 1280, 1280);
  const vg = g.createLinearGradient(0, 0, 0, 1280);
  vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(0.13, '#000'); vg.addColorStop(1, '#000');
  g.fillStyle = vg;
  g.fillRect(0, 0, 1280, 1280);
  g.globalCompositeOperation = 'source-over';
  return { cv, s };
}

/** 近景散花 svg.s0-fl（1600 × 190，贴在近景容器底边）：13 朵花 + 3 组 blur。整体栅格成一张位图，四周留 FL_PAD 个舞台单位（原 svg 是 overflow: visible）. 返回的位图左上在 (-FL_PAD, 1000 - 190 - FL_PAD)。 */
export const FL_PAD = 40;
export async function bakeFlowers(host: HTMLElement, scatHtml: string, K: string, S: number): Promise<{ cv: HTMLCanvasElement; s: number } | null> {
  const need = ['petalR', 'pt5', 'pt6', 'fl', 'fl2', 'fl3'].map((i) => host.querySelector(`#${K}${i}`)?.outerHTML);
  if (need.some((x) => !x)) return null;
  const vw = 1600 + 2 * FL_PAD;
  const vh = 190 + 2 * FL_PAD;
  const [w, h, s] = sized(vw, S, vh);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-FL_PAD} ${-FL_PAD} ${vw} ${vh}" width="${w}" height="${h}"><defs>${need.join('')}</defs>${scatHtml}</svg>`;
  const img = new Image();
  img.decoding = 'async';
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  try { await img.decode(); } catch { return null; }
  const cv = mk(w, h);
  ctx2d(cv).drawImage(img, 0, 0, w, h);
  return { cv, s };
}

/** img.bk（left 640 / top 140 / width 1100，blur(60px) saturate(1.1)）的光晕：1/8 分辨率位图（plateBake.ts 的 bakeHalo：低分辨率上糊，合成时双线性放大），四周多留 3σ = 180 个舞台单位.
    返回位图与它在 .bd-bg 里的位置（舞台单位）. 不透明度由调用方每拍写（0.3·ease）. */
export function bakeBk(bmp: Decoded, S: number): { cv: HTMLCanvasElement; s: number; x: number; y: number; w: number; h: number } {
  const hl = bakeHalo(bmp.src, bmp.w, bmp.h, S / 8, true);        // 软件画布：随后要 toBlob 成 <img>（见 dayScene 的 mountBk）
  return { cv: hl.cv, s: hl.s, x: 640 - HALO_PAD, y: 140 - HALO_PAD, w: hl.w, h: hl.h };
}
