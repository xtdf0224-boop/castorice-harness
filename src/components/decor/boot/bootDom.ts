/* 开屏场景共用的 DOM / 画布小工具：图片加载、径向精灵、火种 SVG、文字「按时间设样式」. */
import { SEED_BASE_FILL, SEED_BASE_STROKE, SEED_STROKES } from '../marks';
import { E, win } from './bootMath';
import type { Rect } from './bootTypes';
import { preloadedImg } from './preload';

export const mk = (w = 2, h = 2): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** 开屏画布的渲染像素比上限：底图本身只有 2560 宽，DPR 1.5 的 2560×1600 画布并不会更清楚，却要多填 40% 的像素（Intel 集显上是转场掉帧的一部分）.
    转场里叠在上面的画布（蝶、光尘）跟开屏画布同尺寸，同样适用. */
export const BOOT_MAX_DPR = 1.25;

/** 加载一张图：main.tsx 一开始就预加载并 decode 过的（preload.ts）直接复用同一个 Image，没有的才现场加载. */
export function loadImg(url: string): Promise<HTMLImageElement> {
  const warm = preloadedImg(url);
  if (warm) return warm;
  return new Promise((res, rej) => {
    const i = new Image();
    i.decoding = 'async';
    i.onload = () => res(i);
    i.onerror = () => rej(new Error(`boot: cannot load ${url}`));
    i.src = url;
  });
}

export function svgToCanvas(svg: string, w: number, h: number): Promise<HTMLCanvasElement> {
  return loadImg(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`).then((im) => {
    const c = mk(w, h);
    c.getContext('2d')!.drawImage(im, 0, 0, w, h);
    return c;
  });
}

/** 径向精灵：中心到边缘按 stops（[位置, CSS 色]）渐变。辉光、雪、涟漪都预渲染成小精灵，逐帧只 drawImage. */
export function radialSprite(size: number, stops: ReadonlyArray<readonly [number, string]>): HTMLCanvasElement {
  const c = mk(size, size);
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) gr.addColorStop(o, col);
  g.fillStyle = gr;
  g.fillRect(0, 0, size, size);
  return c;
}

/** 火种五笔（与 marks.tsx 同一份路径；非官方图标，自绘简化）. */
export const seedSVG = (size: number): string =>
  `<svg class="seed" width="${size}" height="${size}" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><g fill="currentColor">${SEED_STROKES.map((d) => `<path class="s" d="${d}"/>`).join('')}<path class="b" d="${SEED_BASE_FILL}"/></g><path class="b" d="${SEED_BASE_STROKE}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`;

export const f1 = (n: number) => (Math.round(n * 10) / 10).toString();

export const q1 = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T => root.querySelector<T>(sel) as T;
export const qa = <T extends Element = HTMLElement>(root: ParentNode, sel: string): T[] => Array.from(root.querySelectorAll<T>(sel));

/** 文字入场：不透明、上浮、模糊按 ease 曲线随 t 推进（不用 CSS animation，逐帧可重现）. */
export function reveal(node: HTMLElement, t: number, t0: number, dur: number, o: { y?: number; blur?: number; to?: number } = {}) {
  const p = E.ease(win(t, t0, t0 + dur));
  const y = o.y ?? 8;
  const bl = o.blur ?? 6;
  const to = o.to ?? 1;
  node.style.opacity = (p * to).toFixed(3);
  node.style.transform = p >= 1 ? 'none' : `translateY(${((1 - p) * y).toFixed(2)}px)`;
  node.style.filter = bl && p < 1 ? `blur(${((1 - p) * bl).toFixed(2)}px)` : 'none';
}

/** 火种五笔依次点亮；点完后底座也亮，整体辉光随之上来再「呼」一口. */
export function seedStrokes(paths: SVGElement[], base: SVGElement[], t: number, t0: number, step: number, dur: number, glowNode: SVGElement | null, glowMax: number) {
  paths.forEach((p, i) => { p.style.opacity = (0.12 + 0.88 * E.ease(win(t, t0 + i * step, t0 + i * step + dur))).toFixed(3); });
  const allDone = t0 + 4 * step + dur;
  base.forEach((b) => { b.style.opacity = (0.3 + 0.7 * E.ease(win(t, t0 + 4 * step, allDone))).toFixed(3); });
  if (glowNode) {
    const gp = E.ease(win(t, t0, allDone));
    const bump = 1 + 0.3 * Math.sin(Math.PI * win(t, allDone, allDone + 0.4));
    glowNode.style.filter = `drop-shadow(0 0 8px rgb(124 200 247 / ${(glowMax * gp * bump).toFixed(3)}))`;
  }
}

export const fadeTo = (n: HTMLElement, t: number, t0: number, d: number, to: number) => { n.style.opacity = (to * E.ease(win(t, t0, t0 + d))).toFixed(3); };

/* ───────── 转场用：量矩形（屏幕像素） ───────── */

/** 元素方框. */
export const boxRect = (n: Element): Rect => { const b = n.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
/** 元素里文字的紧矩形（行内盒，不含行距）. */
export const rangeRect = (n: Element): Rect => { const r0 = document.createRange(); r0.selectNodeContents(n); const b = r0.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; };
export const unionRect = (rs: Rect[]): Rect => {
  const l = Math.min(...rs.map((r) => r.x));
  const t = Math.min(...rs.map((r) => r.y));
  return { x: l, y: t, w: Math.max(...rs.map((r) => r.x + r.w)) - l, h: Math.max(...rs.map((r) => r.y + r.h)) - t };
};
/** 字距（em）. */
export const lsEm = (n: HTMLElement) => { const c = getComputedStyle(n); const f = parseFloat(c.fontSize) || 1; return c.letterSpacing === 'normal' ? 0 : parseFloat(c.letterSpacing) / f; };

/* ───────── 转场用：播到一半的 reveal ───────── */

/** reveal 播到一半的状态（不透明度 / 上浮 / 模糊）。快速转场（开屏还没播完就被打断）时标题常常还没浮现出来或只出了一半：
    带着走的要从这个状态把 reveal 收完，不带的要从这个状态淡出——绝不能从 0 或 1 起跳（评审 R2：打断瞬间一个大号模糊的「栖枝」一帧冒出来）. */
export interface RevealBase { op: number; y: number; blur: number }
export function revealBase(n: HTMLElement): RevealBase {
  const op = parseFloat(n.style.opacity || '0');
  const y = /translateY\((-?[\d.]+)px\)/.exec(n.style.transform || '');
  const b = /blur\(([\d.]+)px\)/.exec(n.style.filter || '');
  return { op: Number.isFinite(op) ? op : 0, y: y ? parseFloat(y[1]) : 0, blur: b ? parseFloat(b[1]) : 0 };
}
/** 把一段 reveal 收完：k 从 0 到 1 时不透明度 → 1、模糊 → 0（withY：上浮 → 0；FLIP 的元素自己的 transform 是 FLIP，不碰）。已经收完的不写（保持原样）. */
export function settleReveal(n: HTMLElement, b: RevealBase, k: number, withY = true) {
  if (b.op >= 0.999 && b.blur < 0.01 && b.y < 0.01) return;
  n.style.opacity = (b.op + (1 - b.op) * k).toFixed(3);
  const bl = b.blur * (1 - k);
  n.style.filter = bl > 0.05 ? `blur(${bl.toFixed(2)}px)` : 'none';
  if (withY) { const y = b.y * (1 - k); n.style.transform = y > 0.05 ? `translateY(${y.toFixed(2)}px)` : 'none'; }
}
