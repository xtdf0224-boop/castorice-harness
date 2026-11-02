/* 通道（channel）：「一个元素的一组样式属性随转场时刻 tr 怎么变」的纯数据描述，是合成器路径的唯一真源之外的那一层——
   真源仍是 trState 与各场景 / 应用侧的纯函数（truth）；通道只是把它们打包成采样器（sampler.ts）能直接变成 WAAPI 关键帧的形状。
   三类：
   · native（原生缓动）：lerp(from, to, 缓动(win(tr, span)))。缓动是 cubic-bezier，关键帧只要 2–4 个加同一条曲线，合成器自己算，零采样误差；
   · poly（折线）：几何插值的缩放、飞行路径、拍翅、dissolveFast……按「误差 < 容限」自适应二分采样成线性关键帧，时间表段起止（knots）必取；
   · 阶梯（慢机器退路）：任何通道都能按调速器的档位改成 steps(1, jump-end) 的台阶，台阶长度 = 档位 × 刷新间隔、起点对齐 t0。
   向量 v 的各分量就是 css() 里各个函数的参数（translate 的 x / y、scale、不透明度……）——浏览器对「函数列表相同」的 transform 逐函数线性插值，
   所以在向量上线性插值与浏览器插值一致。
   本文件不碰 DOM，scripts/check-boot.ts 对每条通道（夜的 nightChannels 等纯函数造出来的）逐点对拍「关键帧求值 vs truth」（位置 < 0.25 px，不透明度 < 0.5 / 255）。 */
import { clamp, win } from './bootMath';
import type { Span } from './trCore';

export type CssProps = Record<string, string>;
export type Bezier4 = readonly [number, number, number, number];

/** 容限：位置 / 尺寸 0.25 px；不透明度 0.5 / 255；角度（弧度）按蝶的半宽换算后再放在各通道里. */
export const TOL_PX = 0.25;
export const TOL_ALPHA = 0.5 / 255;

interface ChannelBase {
  name: string;
  /** 转场总长（秒）. */
  dur: number;
  /** 向量 → 这个动画要写的 CSS 属性（transform / opacity / translate / scale…）. */
  css: (v: number[]) => CssProps;
  /** 各分量的容限（与 v 同长）. */
  tol: number[];
  /** 纯函数真值：tr → 向量（check-boot 用它对拍）. */
  truth: (tr: number) => number[];
}

export interface NativeChannel extends ChannelBase {
  kind: 'native';
  span: Span;
  bezier: Bezier4;
  from: number[];
  to: number[];
}

export interface PolyChannel extends ChannelBase {
  kind: 'poly';
  /** 必取的采样时刻（时间表段的起止、拐点），秒. */
  knots: number[];
  /** 值第一次可能与 tr = 0 时不同的时刻（秒；缺省 0）：起步分档创建动画时的 deadline. */
  start?: number;
  /** 采样的最小段长（秒；缺省 samplePoly 的 1.2 ms）：很陡的段（0 → 1 只用几十毫秒的淡入）要更细才能守住容限. */
  minSeg?: number;
}

export type Channel = NativeChannel | PolyChannel;

/** 原生缓动通道：truth 由 from/to 与缓动曲线直接算出（调用者给 ease：bootMath 的曲线函数，须与 bezier 同一条）. */
export function nativeChannel(o: { name: string; dur: number; span: Span; bezier: Bezier4; ease: (x: number) => number; from: number[]; to: number[]; css: (v: number[]) => CssProps; tol?: number[] }): NativeChannel {
  const { from, to, ease, span } = o;
  return {
    kind: 'native', name: o.name, dur: o.dur, span, bezier: o.bezier, from, to, css: o.css,
    tol: o.tol ?? from.map(() => TOL_PX),
    truth: (tr) => { const p = ease(win(tr, span[0], span[1])); return from.map((a, i) => a + (to[i] - a) * p); },
  };
}

/** 折线通道：truth 就是场景 / 应用侧那个纯函数. */
export function polyChannel(o: { name: string; dur: number; knots: number[]; truth: (tr: number) => number[]; css: (v: number[]) => CssProps; tol: number[]; start?: number; minSeg?: number }): PolyChannel {
  return { kind: 'poly', name: o.name, dur: o.dur, knots: o.knots, truth: o.truth, css: o.css, tol: o.tol, start: o.start, ...(o.minSeg !== undefined ? { minSeg: o.minSeg } : {}) };
}

/** 两个值相同的通道不必动画（opacity 1→1、translate 0→0）. */
export function isStatic(ch: Channel): boolean {
  if (ch.kind === 'native') return ch.from.every((a, i) => Math.abs(a - ch.to[i]) < 1e-9);
  return false;
}

/** 时间表里一串段（Span）的起止，去重排序后夹进 [0, dur]——折线通道的 knots. */
export function knotsOf(dur: number, ...spans: Span[]): number[] {
  const out = new Set<number>([0, dur]);
  for (const s of spans) { out.add(clamp(s[0], 0, dur)); out.add(clamp(s[1], 0, dur)); }
  return [...out].sort((a, b) => a - b);
}

/* ───────── 常用的 CSS 写法（数值格式固定，采样 / 对拍用同一个函数）───────── */

export const fx = (n: number, d = 3): string => (Math.abs(n) < 5e-4 && d <= 3 ? '0' : n.toFixed(d));
export const cssTranslateX = (v: number[]): CssProps => ({ transform: `translateX(${v[0].toFixed(3)}px)` });
export const cssTranslate = (v: number[]): CssProps => ({ transform: `translate(${v[0].toFixed(3)}px, ${v[1].toFixed(3)}px)` });
export const cssOpacity = (v: number[]): CssProps => ({ opacity: Math.min(1, Math.max(0, v[0])).toFixed(4) });
/** v = [x, y, s]：translate(x, y) scale(s)（FLIP / 位图仿射）. */
export const cssTranslateScale = (v: number[]): CssProps => ({ transform: `translate(${v[0].toFixed(3)}px, ${v[1].toFixed(3)}px) scale(${v[2].toFixed(5)})` });
/** v = [x, y, rot, sx, sy]：蝶的位姿. */
export const cssPose = (v: number[]): CssProps => ({ transform: `translate(${v[0].toFixed(3)}px, ${v[1].toFixed(3)}px) rotate(${v[2].toFixed(5)}rad) scale(${v[3].toFixed(5)}, ${v[4].toFixed(5)})` });
