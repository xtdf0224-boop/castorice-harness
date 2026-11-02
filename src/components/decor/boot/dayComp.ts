/* 昼 · 转场的合成器通道（纯函数，不碰 DOM）：把 dayScene.prepareTransition 里原来「每个节拍写一遍样式」的东西，描述成通道（channels.ts）——
   原生缓动（2 个关键帧 + cubic-bezier，合成器自己算）或折线（自适应采样），由 sampler.ts 变成 WAAPI 关键帧、dayScene 挂到元素上。
   每条通道的 truth 就是 legacy 路径那一行样式写入的纯函数（同一批 trState / archClip / decoXf / paperEdge / winSoft / winEdgeAlpha / bfFlight），
   所以实时、导出、legacy 三者一致；scripts/check-boot.ts 对每条通道逐点对拍。
   昼的难点是「窗」：一个整屏大的拱形裁切框从全屏收成右侧拱窗。合成器能做的写法（实测，见 docs/BOOT-COMPOSITOR.md）：
     · 窗的裁切 = .bd-bloom 上的 clip-path:polygon() 动画（64 个顶点：上两个圆角各 24 段、下两个各 6 段，弦高误差 0.19 px）；
     · 窗里的立绘 / 分身 / 光环 / 花海条 / 临时底 = 各自一层，只动 transform / opacity；
     · 窗左缘的软边（原来是 bloom 的 mask-image，每个节拍重写）= 窗内一条「窗左缘下面那些东西」的拷贝（壁纸色 + 底色层 + 底图位图），静态渐变遮罩（不透明 → 透明）、整条随软边宽度 scaleX（遮罩跟着缩放）、内层反向缩放钉回屏幕；
     · 窗的轮廓（白框 / 1 px 描边 / 点状窗台）= 分件：直边是细条（translate + scale，无遮罩），上两个圆角是小件各自的 polygon 环；
     · 底板的「纸面补集」遮罩（原来每个节拍重写三个整屏元素的 mask-image）= 三份底板拷贝：左边一条（不动）/ 斜坡窄条（静态渐变遮罩随持有者平移，内容反向平移）/ 实心主体
       （overflow:hidden 的持有者 translateX + 内层反向 translateX）——纸面始终在，由底板的移动露出来；
       legacy 的底板是「底色层 + 底图层」两层各按 1 − bg 淡出，所以每份拷贝也是「底色层（纯色）+ 底图位图（不带底色）」两层各按 1 − bg 淡出（合成一张带底色的位图再按 1 − bg² 淡出会偏亮偏灰 bg(1 − bg)·(底图 − 底色)，最大约 7 级）；
       纸面不再被前缘遮罩，前缘右边与羽化带里由一层「壁纸色」擦除层（boot__wall：在底板下面、应用上面）把它擦掉——legacy 里那里是纸面被遮罩、露出壁纸. */

import { E, SSTEP_BEZIER, clamp, lerp, sstep, win } from './bootMath';
import type { Seg } from './bootMath';
import type { Rect, TransitionKind } from './bootTypes';
import { TOL_ALPHA, TOL_PX, knotsOf, nativeChannel, polyChannel, type Bezier4, type CssProps, type NativeChannel, type PolyChannel } from './channels';
import { DC, SHADOW_BLUR, WIN_SOFT, winEdgeAlpha, winSoft } from './dayConst';
import { ART_E, FLIP_E, WIN_E, trDuration, type Span } from './trCore';
import { ARCH_BOTTOM_RADIUS, PAPER_FEATHER, archClip, archClipRect, daySegs, decoXf, paperEdge, stageToScreen, type ArchClip, type ArtFit } from './transitionDay';
import { bfFlight, flipTo as TR_flipTo, titleGroupAt as TR_titleGroupAt, trState, type BfGoal, type BfPose } from './transition';

export interface DayCompInput {
  kind: TransitionKind;
  /** 舞台缩放（H / 1000）：1 屏幕 px = 1/k 个舞台单位. */
  k: number;
  /** 屏宽（CSS px）. */
  W: number;
  /** .bd-bloom 的盒子宽（舞台单位；高 1000）. */
  boxW: number;
  /** 拱窗（舞台单位）与立绘落位. */
  stageArch: Rect;
  fit: ArtFit;
  /** 离开时世界层（镜头）的缩放：被打断时 > 1，收窗的同时推回 1. */
  z0: number;
  /** 主栏纸面的左缘（屏幕 px）；没有 = 不拆底板（只整体淡出）. */
  mainLeft?: number;
  /** 窗里花海条的高（舞台单位）. */
  flwH: number;
}

export const OUTLINE_RING = { out: 6, in: 4.5, rBot: 22 } as const;       // 白框：窗外 4.5–6 个屏幕 px，下角半径 22 px
export const OUTLINE_PURPLE = { out: 0, in: -1 } as const;                // 1 px 描边：窗内 0–1 px
export const HEM_H = 9;                                                    // 点状窗台高（屏幕 px）
/** 窗左缘薄纱元素的宽（舞台单位）= 软边最大宽度；软边宽度小于 VEIL_FW_MIN（舞台单位）时薄纱整条（smoothstep）淡出，渐变的有效宽度取 √(fw² + VEIL_FW_SOFT²).
    VEIL_FW_MIN 原来是 16：窗减速到软边宽度 5–6 个单位（完整版 tr ≈ 0.47、快速版 ≈ 0.40，legacy 在那里还是 5–6 px 的渐显）时薄纱的不透明度只有 sstep(5.5 / 16) = 0.27，
    渐显变成窗左缘一个 1 px 的硬台阶（沿窗高约 2/3，逐像素差 −50 / −32 / −28 / −25 级，实时持续 50–100 ms）；改成 6：fw ≥ 6（legacy 的软边 > 0.5 px 才画，对应 fw ≈ 4）时薄纱基本全开. */
export const VEIL_W = WIN_SOFT.max;
export const VEIL_FW_MIN = 6;
/** 薄纱的缩放容限：软边宽度差 1 个舞台单位（宽度 ≥ 16 的渐变里差 6%，看不出）；内层反向缩放 b = 1 / s 的容限：可见的那 fw 宽里钉住的位图错位 = (p − l) · s · δb ≤ 90 · 0.005 ≈ 0.45 px（最坏情形；实际可见的是 fw 宽、s 小时更小）（位图是平滑的底板渐变）. */
/** 渐变有效宽度 √(fw² + VEIL_FW_SOFT²) 里的平滑量（fw = 20 时只多 7%）. */
export const VEIL_FW_SOFT = 8;
export const VEIL_TOL_S = 1 / WIN_SOFT.max;
export const VEIL_TOL_B = 0.005;

/* ───────── 窗的几何（tr 的纯函数）───────── */

export interface WinAt { st: ReturnType<typeof trState>; c: ArchClip; r: Rect; zw: number }

/** 按 tr 记忆的纯函数（同一批通道的采样会反复在同一个 tr 上求同一个几何：窗的矩形、左缘、速度…）. */
function memo<T>(fn: (tr: number) => T): (tr: number) => T {
  const m = new Map<number, T>();
  return (tr) => { let v = m.get(tr); if (v === undefined) { v = fn(tr); m.set(tr, v); } return v; };
}

export function dayGeom(inp: DayCompInput) {
  const { kind, k, boxW, stageArch, z0 } = inp;
  const S = daySegs(kind);
  const botR = ARCH_BOTTOM_RADIUS / k;
  const at = memo((tr: number): WinAt => {
    const st = trState('day', kind, tr);
    const c = archClip(st.art, boxW, 1000, stageArch, botR, st.winL);
    return { st, c, r: archClipRect(c, boxW, 1000), zw: lerp(z0, 1, st.art) };
  });
  /** 窗左缘要用的两个进度——只算这两条缓动，不算整个 trState（约 25 条缓动；速度要在每个采样点的前后各取一次，折线采样时是几千次）：与 trState 里的 winL / art 同一个式子. */
  const winLAt = (tr: number): number => WIN_E(win(tr, S.win[0], S.win[1]));
  const artAt = (tr: number): number => ART_E(win(tr, S.art[0], S.art[1]));
  /** 窗左缘（舞台单位）= archClip 的 l. */
  const leftStage = (tr: number): number => lerp(0, stageArch.x, winLAt(tr));
  /** 窗左缘（屏幕像素）= stageToScreen(archClipRect(archClip(…)), zw).x. */
  const scrLeft = memo((tr: number): number => k * (DC.A[0] + lerp(z0, 1, artAt(tr)) * (leftStage(tr) - DC.A[0])));
  /** 窗左缘的移动速度（px/s，数值微分，与 legacy 的 winLeftSpeed 同一个公式）. */
  const speed = memo((tr: number): number => Math.abs(scrLeft(tr + 0.008) - scrLeft(tr - 0.008)) / 0.016);
  /** 底板纸面前缘（屏幕 px，渐变归零处）：窗的左缘让开多少、底板撤多少. */
  const plateEdge = memo((tr: number): number => paperEdge(scrLeft(tr), 0, winLAt(tr)));
  return { at, scrLeft, speed, plateEdge, leftStage, artAt };
}

/** 窗 polygon 的坐标个数（64 个顶点）. */
export const POLY_LEN = 4 * (25 + 7);

/** 窗的轮廓折线（顺时针，舞台单位）：上两个圆角各 n 段、下两个各 nb 段；顶点数固定 = 2(n+1) + 2(nb+1). */
export function archPolygon(c: ArchClip, boxW: number, n = 24, nb = 6): number[] {
  const l = c.l;
  const t = c.t;
  const r = boxW - c.r;
  const b = 1000 - c.b;
  const rt = c.rTop;
  const rb = c.rBot;
  const pts: number[] = [];
  const arc = (cx: number, cy: number, rad: number, a0: number, a1: number, m: number) => { for (let i = 0; i <= m; i++) { const a = a0 + (a1 - a0) * (i / m); pts.push(cx + rad * Math.cos(a), cy + rad * Math.sin(a)); } };
  arc(l + rt, t + rt, rt, Math.PI, 1.5 * Math.PI, n);
  arc(r - rt, t + rt, rt, 1.5 * Math.PI, 2 * Math.PI, n);
  arc(r - rb, b - rb, rb, 0, 0.5 * Math.PI, nb);
  arc(l + rb, b - rb, rb, 0.5 * Math.PI, Math.PI, nb);
  return pts;
}
export const polygonCss = (v: readonly number[]): string => { let s = 'polygon('; for (let i = 0; i < v.length; i += 2) s += `${i ? ',' : ''}${v[i].toFixed(2)}px ${v[i + 1].toFixed(2)}px`; return `${s})`; };

/** 一个圆环扇形（外弧 ro、内弧 ri，同一个圆心，角度 a0 → a1）：外弧顺行、内弧逆行，闭合成一条带. */
export function ringSector(cx: number, cy: number, ro: number, ri: number, a0: number, a1: number, n: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * (i / n); pts.push(cx + ro * Math.cos(a), cy + ro * Math.sin(a)); }
  const r2 = Math.max(0, ri);
  for (let i = n; i >= 0; i--) { const a = a0 + (a1 - a0) * (i / n); pts.push(cx + r2 * Math.cos(a), cy + r2 * Math.sin(a)); }
  return pts;
}

/* ───────── CSS 写法 ───────── */

const PXs = (n: number) => n.toFixed(3);
export const cssClip = (v: number[]): CssProps => ({ clipPath: polygonCss(v) });
const cssOp = (v: number[]): CssProps => ({ opacity: clamp(v[0], 0, 1).toFixed(4) });
const cssTx = (v: number[]): CssProps => ({ transform: `translateX(${PXs(v[0])}px)` });
const cssTy = (v: number[]): CssProps => ({ transform: `translateY(${PXs(v[0])}px)` });
const cssScale = (v: number[]): CssProps => ({ scale: v[0].toFixed(5) });
const cssTranslateInd = (v: number[]): CssProps => ({ translate: `${PXs(v[0])}px ${PXs(v[1])}px` });
const cssDeco = (v: number[]): CssProps => ({ transform: `translate(${PXs(v[0])}px, ${PXs(v[1])}px) scale(${v[2].toFixed(5)})` });
const cssZoom = (v: number[]): CssProps => ({ transform: `scale(${v[0].toFixed(5)})` });
/** 细条：translate(x, y) scale(sx, sy)，元素原点在左上角. */
const cssBar = (v: number[]): CssProps => ({ transform: `translate(${PXs(v[0])}px, ${PXs(v[1])}px) scale(${v[2].toFixed(5)}, ${v[3].toFixed(5)})` });
const cssTranslate2 = (v: number[]): CssProps => ({ transform: `translate(${PXs(v[0])}px, ${PXs(v[1])}px)` });
const LIN = [0, 0, 1, 1] as const;
const lin = (x: number) => x;

/* ───────── 通道 ───────── */

export interface OutlineBand {
  /** 窗外的偏移（舞台单位的倍数 u，外 / 内）：正 = 窗外. */
  out: number;
  inn: number;
  /** 下角的半径：undefined = 跟着窗的 rBot；数 = 固定的屏幕 px. */
  rBotPx?: number;
}

export interface OutlinePieces {
  /** 直边（细条）：[x, y, sx, sy]. */
  bars: { L: PolyChannel; R: PolyChannel; T: PolyChannel; B: PolyChannel };
  /** 上两个圆角：位置（translate）与形状（polygon，小件）. */
  cornersPos: { TL: PolyChannel; TR: PolyChannel };
  cornersShape: { TL: PolyChannel; TR: PolyChannel };
  /** 下两个圆角（半径随 p 长的描边才有；白框的下角半径固定，只需平移）. */
  botPos: { BL: PolyChannel; BR: PolyChannel };
  botShape?: { BL: PolyChannel; BR: PolyChannel };
}

/** 角件的盒子边长（舞台单位）：上圆角最大半径 345 + 外延 6 + 余量. */
export const CORNER_BOX = 372;
/** 细条元素的长边（舞台单位；比窗口大就行，由 scale 缩到需要的长度）. */
export const BAR_LEN = 2400;

export interface DayChannels extends DayCommonChannels {
  /** 窗：bloom 的裁切 polygon；世界层缩放（被打断时 z0 > 1）. */
  clip: PolyChannel;
  zoom?: PolyChannel;
  /** 立绘 / 分身：translate（原生缓动）+ scale（折线）. */
  artTr: NativeChannel;
  artSc: PolyChannel;
  artOp: NativeChannel;
  figOp: PolyChannel;
  /** 窗里临时件：底色 / 雾 / 光环 / 花海条. */
  under: PolyChannel;
  underFlw: PolyChannel;
  fog: PolyChannel;
  deco: PolyChannel;
  flwTy: NativeChannel;
  /** 窗左缘的薄纱：元素 translateX(窗左缘) scaleX(软边宽度 / VEIL_W)（静态渐变遮罩跟着一起缩放 = 软边宽度随速度变），内层 scaleX(1 / s) translateX(−l) 钉回屏幕；不透明度随软边宽度淡入淡出. */
  veilTf: PolyChannel;
  veilInv: PolyChannel;
  veilOn: PolyChannel;
  /** 底板：主体 / 斜坡的平移（含内层反向）与整体淡出. */
  plate?: { body: PolyChannel; bodyInv: PolyChannel; ramp: PolyChannel; rampInv: PolyChannel };
  /** 底板各层（底色层、底图位图）自己的不透明度：1 − bg（legacy 里底色 / 底图 / 柔光三层各按 1 − bg 淡出，叠起来对下面的覆盖是 1 − bg²）. */
  bgFade: NativeChannel;
  /** 窗的轮廓、落影的不透明度（与 legacy 的 frame.opacity 同一个）与左侧的速度衰减. */
  fo: PolyChannel;
  foAl: PolyChannel;
  /** 拱窗里真立绘等的交接用的 fo 之外的：无. */
  ring?: OutlinePieces;
  stroke?: OutlinePieces;
  /** 窗的上圆角半径（舞台单位）：上两个圆角（白框 + 描边的弧）不再是 polygon 遮罩小件，而是两张小画布每个节拍按这个半径重画一次（遮罩小件每帧重新光栅，实测是轮廓里最贵的一项）. */
  rtAt: (tr: number) => number;
  /** 窗左缘的速度衰减 aL（winEdgeAlpha）：legacy 的轮廓遮罩（左边起 aL、到窗内 WIN_EDGE_SOFT 处升到 1）——左上圆角的弧延伸到窗内几百个单位，不能整件乘 aL，要在画布里按这条渐变画. */
  aLAt: (tr: number) => number;
  /** 窗的下圆角半径（舞台单位）：描边的下面两个弧同样每个节拍在小画布里重画. */
  rbAt: (tr: number) => number;
  /** 窗台（点状）：持有者与内层的平移；窗台是两条叠放的内层条（见 hemTopAlpha）：上层带静态的左缘渐变遮罩、不透明度 hemTop；下层整条，不透明度 foAl. */
  hemHolder: PolyChannel;
  hemInner: PolyChannel;
  hemTop: PolyChannel;
  /** 左缘落影条：位置 + 高度. */
  shL: PolyChannel;
  shLop: PolyChannel;
}

export interface DayChannelOpts {
  /** 窗里 .s0-art 的像素尺寸（舞台单位，用来换算缩放的容限）. */
  artSize?: number;
}

/** 窗有没有都要的通道：场景淡出（枝 / 雪 / 近景 / 版本号 / 横线 / 前景画布）、题辞等淡出、署名淡出；没有窗时的整体淡出（bloom / 底板，E.ease）.
    起点不透明度各元素不同（base），所以给的是「淡出规格 + 按 base 造通道的函数」. */
export interface FadeSpec { span: Span; bezier: Bezier4; ease: (x: number) => number }
export interface DayCommonChannels {
  dur: number;
  scene: NativeChannel;
  textOut: NativeChannel;
  ambient: NativeChannel;
  bgFlow: NativeChannel;
  /** base → 0 的淡出：which = scene（枝 / 雪 / 近景…，E.ease）/ textOut（题辞等，E.ease）/ ambient（署名，线性）；base ≤ 0 不建. */
  fade: (which: 'scene' | 'textOut' | 'ambient', base: number) => NativeChannel | undefined;
}
export function dayCommonChannels(kind: TransitionKind): DayCommonChannels {
  const dur = trDuration(kind);
  const S = daySegs(kind);
  const spec: Record<'scene' | 'textOut' | 'ambient', FadeSpec> = {
    scene: { span: S.scene, bezier: E.ease.bezier!, ease: E.ease },
    textOut: { span: S.textOut, bezier: E.ease.bezier!, ease: E.ease },
    ambient: { span: S.ambient, bezier: LIN, ease: lin },
  };
  const mk = (name: string, f: FadeSpec, base: number) => nativeChannel({ name, dur, span: f.span, bezier: f.bezier, ease: f.ease, from: [base], to: [0], css: cssOp, tol: [TOL_ALPHA] });
  return {
    dur,
    scene: mk('scene', spec.scene, 1),
    textOut: mk('textOut', spec.textOut, 1),
    ambient: mk('ambient', spec.ambient, 1),
    bgFlow: nativeChannel({ name: 'bgFlow', dur, span: S.bgF, bezier: E.ease.bezier!, ease: E.ease, from: [1], to: [0], css: cssOp, tol: [TOL_ALPHA] }),
    fade: (which, base) => (base > 0.001 ? mk(`${which}@${base.toFixed(3)}`, spec[which], base) : undefined),
  };
}

/** 单位：u = 1 个屏幕 px 的舞台单位 = 1 / k. */
export function dayChannels(inp: DayCompInput): DayChannels {
  const { kind, k, W, boxW, stageArch, fit, mainLeft } = inp;
  const dur = trDuration(kind);
  const S = daySegs(kind);
  const g = dayGeom(inp);
  const u = 1 / k;
  const stAt = memo((tr: number) => trState('day', kind, tr));
  const knotsWin = knotsOf(dur, S.win, S.art);

  const out = {} as DayChannels;
  out.rtAt = (tr) => g.at(tr).c.rTop;
  out.aLAt = (tr) => winEdgeAlpha(g.speed(tr));
  out.rbAt = (tr) => g.at(tr).c.rBot;
  out.clip = polyChannel({ name: 'winClip', dur, knots: knotsWin, tol: new Array(POLY_LEN).fill(TOL_PX), css: cssClip, truth: (tr) => archPolygon(g.at(tr).c, boxW), start: S.win[0] });   // 窗在 S.win[0] 之前就是整个盒子（p = 0 的多边形 = 整个矩形）：不必在起步的头几帧里建
  if (Math.abs(inp.z0 - 1) > 1e-6) out.zoom = polyChannel({ name: 'zoom', dur, knots: knotsOf(dur, S.art), tol: [0.0002], css: cssZoom, truth: (tr) => [g.at(tr).zw], start: S.art[0] });

  // ── 立绘 / 分身 ──
  out.artTr = nativeChannel({ name: 'artTr', dur, span: S.art, bezier: ART_E.bezier!, ease: ART_E, from: [0, 0], to: [fit.dx / k, fit.dy / k], css: cssTranslateInd });
  out.artSc = polyChannel({ name: 'artSc', dur, knots: knotsOf(dur, S.art), tol: [TOL_PX / 1280], css: cssScale, truth: (tr) => [Math.pow(fit.r, stAt(tr).art)], start: S.art[0] });
  out.artOp = nativeChannel({ name: 'artOp', dur, span: S.wash, bezier: SSTEP_BEZIER, ease: sstep, from: [1], to: [0], css: cssOp, tol: [TOL_ALPHA] });
  out.figOp = polyChannel({ name: 'figOp', dur, knots: knotsOf(dur, S.figOn, S.figOut), tol: [TOL_ALPHA], css: cssOp, truth: (tr) => { const s = stAt(tr); return [s.figOn * (1 - s.figOut)]; }, start: S.figOn[0] });
  out.under = polyChannel({ name: 'under', dur, knots: knotsOf(dur, S.wash, S.wOut), tol: [TOL_ALPHA], css: cssOp, truth: (tr) => { const s = stAt(tr); return [s.wash * (1 - s.wOut)]; }, start: S.wash[0] });
  out.underFlw = polyChannel({ name: 'underFlw', dur, knots: knotsOf(dur, S.wash, S.wOut), tol: [TOL_ALPHA], css: cssOp, truth: (tr) => { const s = stAt(tr); return [0.88 * s.wash * (1 - s.wOut)]; }, start: S.wash[0] });
  out.fog = polyChannel({ name: 'fog', dur, knots: knotsOf(dur, S.washTop, S.wOut), tol: [TOL_ALPHA], css: cssOp, truth: (tr) => { const s = stAt(tr); return [0.95 * s.washTop * (1 - s.wOut)]; }, start: S.washTop[0] });
  out.deco = polyChannel({ name: 'deco', dur, knots: knotsOf(dur, S.art), tol: [TOL_PX, TOL_PX, TOL_PX / 365], css: cssDeco, truth: (tr) => { const m = decoXf(stAt(tr).art, fit, k); return [m.x, m.y, m.a]; }, start: S.washTop[0] });
  // 花海条的纹理钉在终态位置，框跟着窗的底边走：整条在窗宽方向铺满 bloom（窗的 polygon 负责左右裁切），只需竖直平移（窗底边 = 1000 − p·(1000 − (arch.y + arch.h))）
  out.flwTy = nativeChannel({ name: 'flwTy', dur, span: S.art, bezier: ART_E.bezier!, ease: ART_E, from: [1000 - inp.flwH], to: [stageArch.y + stageArch.h - inp.flwH], css: cssTy });

  // ── 窗左缘的薄纱：legacy 在 bloom 上写 mask-image: linear-gradient(90deg, transparent l, #000 l + fw)——窗里的内容从左缘起 fw 宽渐显，露出下面的东西（底板层 / 壁纸）。
  //    comp：窗内一条「下面的东西」的拷贝（壁纸色 + 底色层 + 底图位图，各自按 1 − bg 淡出，与下面真的底板同一个式子），静态渐变遮罩（不透明 → 透明，宽 VEIL_W）；
  //    fw 随速度变，所以整条元素 scaleX(fw / VEIL_W)（遮罩跟着缩放），内层反向缩放 + 平移钉回屏幕；fw < VEIL_FW_MIN 时（legacy 的「软边 > 0.5 px 才画」）整条淡出 ──
  const veilFw = memo((tr: number): number => (g.artAt(tr) === 0 ? 0 : winSoft(g.speed(tr))));
  /** 渐变的有效宽度 = √(fw² + FW_SOFT²)（≥ FW_SOFT 的平滑版；max(fw, FW_SOFT) 在拐点处有个折角，而 fw 变得很快，折线采样守不住容限）：fw ≫ FW_SOFT 时就是 fw. */
  const veilS = (tr: number): number => Math.hypot(veilFw(tr), VEIL_FW_SOFT) / VEIL_W;
  out.veilTf = polyChannel({ name: 'veilTf', dur, knots: knotsWin, tol: [TOL_PX, VEIL_TOL_S], minSeg: 0.0004, css: (v) => ({ transform: `translateX(${PXs(v[0])}px) scaleX(${v[1].toFixed(5)})` }), start: S.win[0], truth: (tr) => [g.leftStage(tr), veilS(tr)] });
  // 内层：scaleX(1 / s) translateX(−l)（先平移再缩放：p ↦ (p − l) / s，与外层相乘 = 恒等）。向量取 [1 / s, l]（都是量级不大的数；写成 translateX(−l / s) scaleX(1 / s) 的话平移量会大到 10⁴ 级，逐点对拍的容限没法满足）
  out.veilInv = polyChannel({ name: 'veilInv', dur, knots: knotsWin, tol: [VEIL_TOL_B, TOL_PX], minSeg: 0.0002, css: (v) => ({ transform: `scaleX(${v[0].toFixed(5)}) translateX(${PXs(-v[1])}px)` }), start: S.win[0], truth: (tr) => [1 / veilS(tr), g.leftStage(tr)] });
  out.veilOn = polyChannel({ name: 'veilOn', dur, knots: knotsWin, tol: [TOL_ALPHA * 3], css: cssOp, start: S.win[0], minSeg: 0.0002, truth: (tr) => [sstep(clamp(veilFw(tr) / VEIL_FW_MIN, 0, 1))] });

  // ── 底板：主体 / 斜坡的平移（只有知道主栏左缘才拆）──
  const edgeKnots = knotsOf(dur, S.win, S.art, [S.win[0] + 0.9 * (S.win[1] - S.win[0]), S.win[1]] as const);
  if (mainLeft !== undefined) {
    const F = PAPER_FEATHER;
    const mk = (name: string, css: (v: number[]) => CssProps) => polyChannel({ name, dur, knots: edgeKnots, tol: [TOL_PX], css, truth: (tr) => [g.plateEdge(tr)], start: S.win[0] });
    out.plate = {
      body: mk('plateBody', (v) => ({ transform: `translateX(${PXs(Math.max(0, v[0]))}px)` })),
      bodyInv: mk('plateBodyInv', (v) => ({ transform: `translateX(${PXs(-Math.max(0, v[0]))}px)` })),
      ramp: mk('plateRamp', (v) => ({ transform: `translateX(${PXs(v[0] - F)}px)` })),
      rampInv: mk('plateRampInv', (v) => ({ transform: `translateX(${PXs(F - v[0])}px)` })),
    };
  }
  out.bgFade = nativeChannel({ name: 'bgFade', dur, span: S.bg, bezier: SSTEP_BEZIER, ease: sstep, from: [1], to: [0], css: cssOp, tol: [TOL_ALPHA] });
  // ── 窗的轮廓 / 落影的不透明度：legacy 的 frame.opacity = sstep(winL, 0–0.12) · (1 − wOut) · gate(窗宽 < 85% 屏宽) ──
  const foAt = memo((tr: number) => {
    const a = g.at(tr);
    const wr = stageToScreen(a.r, a.zw, DC.A, k);
    const gate = sstep(win(1 - wr.w / W, 0.15, 0.3));
    return sstep(win(a.st.winL, 0, 0.12)) * (1 - a.st.wOut) * gate;
  });
  /** 轮廓 / 落影第一次看得见的时刻（fo > 0.001）：这些件的动画到这之前不必建（起步的几帧里只建窗 / 立绘 / 底板）. */
  let foStart = dur;
  for (let i = 0; i <= 480; i++) { const tr = (dur * i) / 480; if (foAt(tr) > 0.001) { foStart = Math.max(0, tr - 0.02); break; } }
  const foKnots = knotsOf(dur, S.win, S.art, S.wOut);
  out.fo = polyChannel({ name: 'fo', dur, knots: foKnots, tol: [TOL_ALPHA], css: cssOp, truth: (tr) => [foAt(tr)], start: foStart, minSeg: 0.0004 });
  // 左侧件（左直边、上左 / 下左圆角、落影条）再乘一个随左缘速度的衰减 aL（winEdgeAlpha）
  out.foAl = polyChannel({ name: 'foAl', dur, knots: foKnots, tol: [TOL_ALPHA], css: cssOp, truth: (tr) => [foAt(tr) * winEdgeAlpha(g.speed(tr))], start: foStart, minSeg: 0.0004 });

  // ── 窗台（点状）：持有者的右缘跟窗的右缘、内层条跟窗的左缘（纹理原点 = 左缘）──
  // 持有者：宽 BAR_LEN，translateX(r − BAR_LEN)，overflow:hidden；内层条 translateX(l − holder.x) = l − r + BAR_LEN，纹理原点在 l
  out.hemHolder = polyChannel({ name: 'hemHolder', dur, knots: knotsWin, tol: [TOL_PX, TOL_PX], css: cssTranslate2, start: foStart, truth: (tr) => { const r = g.at(tr).r; return [r.x + r.w - BAR_LEN, r.y + r.h - HEM_H * u]; } });
  out.hemInner = polyChannel({ name: 'hemInner', dur, knots: knotsWin, tol: [TOL_PX], css: cssTx, start: foStart, truth: (tr) => { const r = g.at(tr).r; return [r.x - (r.x + r.w - BAR_LEN)]; } });
  // 窗台的左缘渐隐（legacy 的轮廓遮罩盖着整个轮廓 frame，窗台也在里面；上一轮只给窗台补了 fo，左端就成了满饱和的方头硬条）：上层条 = 静态渐变遮罩 + 这条不透明度，下层条 = foAl
  out.hemTop = polyChannel({ name: 'hemTop', dur, knots: foKnots, tol: [TOL_ALPHA], css: cssOp, start: foStart, minSeg: 0.0004, truth: (tr) => [hemTopAlpha(foAt(tr), winEdgeAlpha(g.speed(tr)))] });

  // ── 左缘落影条：贴着窗左缘（translate），竖直范围 = 左直边（scaleY）；不透明度 = foAl × 让位系数（shadowHandover：窗左缘越接近终态，终态拱窗自己的静态落影越多地露出来，落影条只补它不够的那部分）──
  out.shLop = polyChannel({ name: 'shLop', dur, knots: foKnots, tol: [TOL_ALPHA], css: cssOp, start: foStart, truth: (tr) => { const a = g.at(tr); return [foAt(tr) * winEdgeAlpha(g.speed(tr)) * shadowHandover(stageArch.x - a.r.x, u)]; } });
  out.shL = polyChannel({
    name: 'shL', dur, knots: knotsWin, tol: [TOL_PX, TOL_PX, TOL_PX / 1000], css: (v) => ({ transform: `translate(${PXs(v[0])}px, ${PXs(v[1])}px) scale(1, ${v[2].toFixed(5)})` }), start: foStart,
    truth: (tr) => { const a = g.at(tr); const y0 = a.r.y + a.c.rTop * 0.5; const y1 = a.r.y + a.r.h - a.c.rBot + SHADOW_TAIL * u; return [a.r.x, y0, Math.max(0.0001, (y1 - y0) / 1000)]; },
  });

  // ── 轮廓：白框与 1 px 描边 ──
  const band = (b: OutlineBand): OutlinePieces => outlinePieces(inp, g, b, u, knotsWin, foStart);
  out.ring = band({ out: OUTLINE_RING.out, inn: OUTLINE_RING.in, rBotPx: OUTLINE_RING.rBot });
  out.stroke = band({ out: OUTLINE_PURPLE.out, inn: OUTLINE_PURPLE.in });

  Object.assign(out, dayCommonChannels(kind));
  return out;
}

/** 左缘落影条下端多延伸（屏幕 px）：窗的落影向下偏 14 px、模糊 34 px. */
export const SHADOW_TAIL = 14;

/** 补误差函数 erfc（Abramowitz–Stegun 7.1.26，|误差| < 1.5e-7；x ≥ 0 用，负数按对称补齐）. */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * z);
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-z * z);
  return x >= 0 ? y : 2 - y;
}

/** 窗的左缘落影条的「让位」系数 w(d)：d = 终态拱窗左缘 − 窗左缘（舞台单位，≥ 0）。窗收到位时，终态拱窗自己的落影（静态、画在终态位置）会在窗左缘外露出来：
    它在窗左缘外 e 处的深度是 0.2·G(d + e)，而 legacy 的落影一直跟着窗，那里应是 0.2·G(e)（G = 高斯尾，σ = 模糊半径 / 2）。落影条按 w 打折，在窗边（e = 0，最深、最显眼）处恰好补齐：
    1 − (1 − 0.2·G(d))(1 − 0.1·w) = 0.1 ⇒ w = (1 − 2·G(d)) / (1 − 0.2·G(d))——d = 0 时 0（全交给静态的那份）、d ≳ 2.5σ 时 1.
    以前是按窗左缘离终态 130 → 45 个单位淡出（45 单位 ≈ 2.8σ，静态落影在那里还几乎没有）：窗边外有一段几十毫秒没有落影，比 legacy 浅 8–14 级. */
export function shadowHandover(d: number, u: number): number {
  if (d <= 0) return 0;
  const sigma = (SHADOW_BLUR / 2) * u;
  const G = 0.5 * erfc(d / (sigma * Math.SQRT2));
  return clamp((1 - 2 * G) / (1 - 0.2 * G), 0, 1);
}

/** 窗台上层条的不透明度（legacy 的窗台带轮廓遮罩：窗左缘起 aL、往窗里 WIN_EDGE_SOFT 个舞台单位线性升到 1，再乘 fo）.
    窗台的纹理是不透明的，所以一条整条的下层（不透明度 b = fo·aL）+ 一条带 0 → 1 静态渐变遮罩 r(x) 的上层（不透明度 u）叠起来是 1 − (1 − b)(1 − u·r) = b + u(1 − b)·r；
    要等于 legacy 的 fo·(aL + (1 − aL)·r)，u(1 − b) = P := fo·(1 − aL) ⇒ u = P / (1 − b)。1 − b 趋于 0 时（窗减速到 aL = 1、fo = 1）下层几乎不透明，上层取多少都看不出来，
    但这个商会在几毫秒里从 1 掉到 0（折线采样守不住容限）——所以分母取 √((1 − b)² + HEM_EPS²)：处处光滑，对 A 的误差 = P·(1 − y/√(y² + ε²)) ≤ 0.3·ε（y = 1 − b ≥ P），ε = 0.006 时 < 0.5/255. */
export const HEM_EPS = 0.006;
export function hemTopAlpha(fo: number, aL: number): number {
  const y = 1 - fo * aL;
  return clamp((fo * (1 - aL)) / Math.hypot(y, HEM_EPS), 0, 1);
}

function outlinePieces(inp: DayCompInput, g: ReturnType<typeof dayGeom>, b: OutlineBand, u: number, knots: number[], start: number): OutlinePieces {
  const dur = trDuration(inp.kind);
  const t = (tr: number) => g.at(tr);
  const eo = b.out * u;                       // 外缘离窗边（舞台单位，正 = 窗外）
  const ei = b.inn * u;                       // 内缘
  /** 外缘的下角半径：白框是固定的 22 个屏幕 px，描边跟着窗的 rBot. */
  const rob = (c: ArchClip) => (b.rBotPx !== undefined ? b.rBotPx * u : c.rBot);
  const lenTol = TOL_PX / BAR_LEN;
  const mkBar = (name: string, truth: (tr: number) => number[]) => polyChannel({ name, dur, knots, tol: [TOL_PX, TOL_PX, lenTol, lenTol], css: cssBar, truth, start });
  // 左 / 右直边：厚 th、长 BAR_LEN（scaleY 缩到需要的长度）：y 从上圆角结束处（t + rt）到下圆角开始处（b + eo − Ro_b）
  const vY = (a: WinAt) => { const y0 = a.r.y + a.c.rTop; const y1 = a.r.y + a.r.h + eo - rob(a.c); return [y0, Math.max(0.0001, (y1 - y0) / BAR_LEN)] as const; };
  const bars = {
    L: mkBar('barL', (tr) => { const a = t(tr); const [y0, sy] = vY(a); return [a.r.x - eo, y0, 1, sy]; }),
    R: mkBar('barR', (tr) => { const a = t(tr); const [y0, sy] = vY(a); return [a.r.x + a.r.w + ei, y0, 1, sy]; }),
    T: mkBar('barT', (tr) => { const a = t(tr); const x0 = a.r.x + a.c.rTop; const x1 = a.r.x + a.r.w - a.c.rTop; return [x0, a.r.y - eo, Math.max(0.0001, (x1 - x0) / BAR_LEN), 1]; }),
    B: mkBar('barB', (tr) => { const a = t(tr); const R = rob(a.c); const x0 = a.r.x - eo + R; const x1 = a.r.x + a.r.w + eo - R; return [x0, a.r.y + a.r.h + ei, Math.max(0.0001, (x1 - x0) / BAR_LEN), 1]; }),
  };
  const S = CORNER_BOX;
  // 上圆角：盒子 S × S；TL 的右下角 / TR 的左下角 = 圆心 (l + rt, t + rt) / (r − rt, t + rt)
  const tlPos = polyChannel({ name: 'cTLpos', dur, knots, tol: [TOL_PX, TOL_PX], css: cssTranslate2, start, truth: (tr) => { const a = t(tr); return [a.r.x + a.c.rTop - S, a.r.y + a.c.rTop - S]; } });
  const trPos = polyChannel({ name: 'cTRpos', dur, knots, tol: [TOL_PX, TOL_PX], css: cssTranslate2, start, truth: (tr) => { const a = t(tr); return [a.r.x + a.r.w - a.c.rTop, a.r.y + a.c.rTop - S]; } });
  const NA = 16;
  const tolPoly = new Array((NA + 1) * 4).fill(TOL_PX);
  const tlShape = polyChannel({ name: 'cTLshape', dur, knots, tol: tolPoly, css: cssClip, start, truth: (tr) => { const a = t(tr); const rt = a.c.rTop; return ringSector(S, S, rt + eo, rt + ei, Math.PI, 1.5 * Math.PI, NA); } });
  const trShape = polyChannel({ name: 'cTRshape', dur, knots, tol: tolPoly, css: cssClip, start, truth: (tr) => { const a = t(tr); const rt = a.c.rTop; return ringSector(0, S, rt + eo, rt + ei, 1.5 * Math.PI, 2 * Math.PI, NA); } });
  // 下圆角：圆心 (l − eo + Ro_b, b + eo − Ro_b) / (r + eo − Ro_b, b + eo − Ro_b)。白框的下角半径固定（22 px）：静态的带边框小件，只需平移（盒子 = 圆心所在象限的 Ro × Ro）；
  // 描边的下角半径随 p 长：SB × SB 的小件 + polygon
  const SB = (b.rBotPx !== undefined ? b.rBotPx : 40) * u;
  const cBL = (a: WinAt) => { const R = rob(a.c); return [a.r.x - eo + R, a.r.y + a.r.h + eo - R] as const; };
  const cBR = (a: WinAt) => { const R = rob(a.c); return [a.r.x + a.r.w + eo - R, a.r.y + a.r.h + eo - R] as const; };
  const blPos = polyChannel({ name: 'cBLpos', dur, knots, tol: [TOL_PX, TOL_PX], css: cssTranslate2, start, truth: (tr) => { const a = t(tr); const [cx, cy] = cBL(a); return [b.rBotPx !== undefined ? cx - SB : cx - SB, cy]; } });
  const brPos = polyChannel({ name: 'cBRpos', dur, knots, tol: [TOL_PX, TOL_PX], css: cssTranslate2, start, truth: (tr) => { const a = t(tr); const [cx, cy] = cBR(a); return [cx, cy]; } });
  const NB = 8;
  const tolB = new Array((NB + 1) * 4).fill(TOL_PX);
  const botShape = b.rBotPx === undefined ? {
    BL: polyChannel({ name: 'cBLshape', dur, knots, tol: tolB, css: cssClip, start, truth: (tr) => { const a = t(tr); const rb = a.c.rBot; return ringSector(SB, 0, rb + eo, rb + ei, 0.5 * Math.PI, Math.PI, NB); } }),
    BR: polyChannel({ name: 'cBRshape', dur, knots, tol: tolB, css: cssClip, start, truth: (tr) => { const a = t(tr); const rb = a.c.rBot; return ringSector(0, 0, rb + eo, rb + ei, 0, 0.5 * Math.PI, NB); } }),
  } : undefined;
  return { bars, cornersPos: { TL: tlPos, TR: trPos }, cornersShape: { TL: tlShape, TR: trShape }, botPos: { BL: blPos, BR: brPos }, botShape };
}

/* ───────── 蝶（SVG 的昼蝶：两片翅、身体、足）：合成器上的小组 ─────────
   legacy 每个节拍改一大张 SVG 的 transform 属性；现在是一个容器（位姿）里的四个小层：左翅、右翅（各自 rotate · scaleX 的拍翅 / 收翅）、身体（静态）、足（不透明度）. */
export const DAY_BF_SPAN = 66;

export interface DayBfInput {
  kind: TransitionKind;
  start: BfPose;
  goal: BfGoal;
  path: Seg;
  /** 离开时翅的收拢程度（0 展开 – 1 半举）. */
  fold0: number;
}

export interface DayBfChannels {
  pose: PolyChannel;
  alpha: PolyChannel;
  wingL: PolyChannel;
  wingR: PolyChannel;
  legs: PolyChannel;
}

const cssBfPose = (v: number[]): CssProps => ({ transform: `translate(${PXs(v[0])}px, ${PXs(v[1])}px) rotate(${v[2].toFixed(5)}rad) scale(${v[3].toFixed(5)})` });
const cssWingL = (v: number[]): CssProps => ({ transform: `scale(-1, 1) rotate(${v[0].toFixed(3)}deg) scale(${v[1].toFixed(5)}, 1)` });
const cssWingR = (v: number[]): CssProps => ({ transform: `rotate(${v[0].toFixed(3)}deg) scale(${v[1].toFixed(5)}, 1)` });

export function dayBfChannels(inp: DayBfInput): DayBfChannels {
  const { kind, start, goal, path, fold0 } = inp;
  const dur = trDuration(kind);
  const S = daySegs(kind);
  const stAt = (tr: number) => trState('day', kind, tr);
  const poseAt = (tr: number) => { const st = stAt(tr); return { st, p: bfFlight(start, goal, path, st.fly, st.flap, tr) }; };
  const knots = knotsOf(dur, S.fly, S.swap, S.swapOut);
  const unit0 = Math.max(start.w, goal.w) / DAY_BF_SPAN;
  const halfDiag = 40 * unit0;
  const tolRot = TOL_PX / halfDiag;
  const tolS = TOL_PX / (DAY_BF_SPAN * 0.5);
  const fold = (st: ReturnType<typeof stAt>) => fold0 * (1 - sstep(win(st.fly, 0, 0.35)));
  const flapOf = (p: BfPose) => Math.max(0.04, p.flap);
  const tolWing = TOL_PX / 33;
  return {
    pose: polyChannel({ name: 'dbfPose', dur, knots, tol: [TOL_PX, TOL_PX, tolRot, tolS], css: cssBfPose, truth: (tr) => { const { p } = poseAt(tr); return [p.x, p.y, p.rot, p.w / DAY_BF_SPAN]; } }),
    alpha: polyChannel({ name: 'dbfAlpha', dur, knots, tol: [TOL_ALPHA], css: cssOp, truth: (tr) => { const { st, p } = poseAt(tr); return [p.alpha * (1 - st.swapOut)]; } }),
    // 左翅：scale(-1 1) rotate(-12p°) scale(lerp(1, .92, p)·fl, 1)；右翅：rotate(-52p°) scale(fl, 1)（p = 收翅程度）
    wingL: polyChannel({ name: 'dbfWingL', dur, knots, tol: [tolWing * 4, tolWing], css: cssWingL, truth: (tr) => { const { st, p } = poseAt(tr); const q = fold(st); return [-12 * q, lerp(1, 0.92, q) * flapOf(p)]; } }),
    wingR: polyChannel({ name: 'dbfWingR', dur, knots, tol: [tolWing * 4, tolWing], css: cssWingR, truth: (tr) => { const { st, p } = poseAt(tr); const q = fold(st); return [-52 * q, flapOf(p)]; } }),
    legs: polyChannel({ name: 'dbfLegs', dur, knots, tol: [TOL_ALPHA], css: cssOp, truth: (tr) => { const { st } = poseAt(tr); const q = fold(st); return [q * q]; } }),
  };
}

/* ───────── 标题组（栖枝 / ALIGHT）：预烘焙的叠层 + 合成器位姿（昼）─────────
   与夜（nightComp.ts 的 nightTitleChannels）同一个做法：标题已完全浮现时，换成三层叠放（光晕层 = 透明字 + text-shadow、起始字色层、字标色层）+ 整体位姿 + 逐字平移（字距的收拢），
   主线程不再每个节拍改 transform / letter-spacing / color / text-shadow（重排 + 重画带 30 px 模糊阴影的大字）。
   昼的标题在 .bd-text（舞台缩放 k）里：平移要除以 k（舞台单位），缩放不变. */
export interface DayTitleInput {
  kind: TransitionKind;
  k: number;
  grp: import('./transition').TitleGroup;
  h1Box: Rect;
  enBox: Rect;
  enSrc: Rect;
  lsH1: number;
  lsEn: number;
  nameLS: number;
  subLS: number;
  fsH1: number;
  fsEn: number;
  letters: number;
}

export interface DayTitleChannels {
  h1Tf: PolyChannel;
  enTf: PolyChannel;
  /** 三层各自的不透明度已经乘进了整体淡出（titleOut）：外包的位姿元素只有 transform，没有带子元素的不透明度组（少一个渲染面）. */
  aOut: NativeChannel;
  halo: PolyChannel;
  flat: PolyChannel;
  h1Char: NativeChannel;
  enLetter: NativeChannel[];
}

export function dayTitleChannels(inp: DayTitleInput): DayTitleChannels {
  const { kind, k, grp } = inp;
  const dur = trDuration(kind);
  const S = daySegs(kind);
  const stAt = (tr: number) => trState('day', kind, tr);
  const knots = knotsOf(dur, S.title);
  const tolS1 = TOL_PX / Math.max(40, grp.h1Src.w);
  const tolS2 = TOL_PX / Math.max(40, inp.enSrc.w);
  const cssFlip = (v: number[]): CssProps => ({ transform: `translate(${PXs(v[0])}px, ${PXs(v[1])}px) scale(${v[2].toFixed(5)})` });
  return {
    h1Tf: polyChannel({ name: 'dtH1', dur, knots, tol: [TOL_PX / k, TOL_PX / k, tolS1], css: cssFlip, start: S.title[0], truth: (tr) => { const g = TR_titleGroupAt(grp, stAt(tr).title).h1Flip; return [g.x / k, g.y / k, g.s]; } }),
    enTf: polyChannel({ name: 'dtEn', dur, knots, tol: [TOL_PX / k, TOL_PX / k, tolS2], css: cssFlip, start: S.title[0], truth: (tr) => { const r = TR_titleGroupAt(grp, stAt(tr).title).enRect; const f = TR_flipTo(inp.enBox, inp.enSrc, r); return [f.x / k, f.y / k, f.s]; } }),
    aOut: nativeChannel({ name: 'dtOut', dur, span: S.titleOut, bezier: [0, 0, 1, 1], ease: lin, from: [1], to: [0], css: cssOp, tol: [TOL_ALPHA] }),
    halo: polyChannel({ name: 'dtHalo', dur, knots: knotsOf(dur, S.tint, S.titleOut), tol: [TOL_ALPHA], css: cssOp, start: S.tint[0], truth: (tr) => { const s = stAt(tr); return [(1 - s.tint) * (1 - s.titleOut)]; } }),
    flat: polyChannel({ name: 'dtFlat', dur, knots: knotsOf(dur, S.tint, S.titleOut), tol: [TOL_ALPHA], css: cssOp, start: S.tint[0], truth: (tr) => { const s = stAt(tr); return [s.tint * (1 - s.titleOut)]; } }),
    h1Char: nativeChannel({ name: 'dtH1Char', dur, span: S.title, bezier: FLIP_E.bezier!, ease: FLIP_E, from: [0], to: [(inp.nameLS - inp.lsH1) * inp.fsH1], css: cssTx }),
    enLetter: Array.from({ length: inp.letters }, (_, i) => nativeChannel({ name: `dtEnL${i}`, dur, span: S.title, bezier: FLIP_E.bezier!, ease: FLIP_E, from: [0], to: [i * (inp.subLS - inp.lsEn) * inp.fsEn], css: cssTx })),
  };
}

/** 上圆角的弧（画布里画）：左上 = 圆心 (S, S)、角度 π → 1.5π；右上 = 圆心 (0, S)、角度 1.5π → 2π（盒子边长 S = CORNER_BOX，舞台单位）. 带的中线半径 = rt + (外缘 + 内缘) / 2，线宽 = 外缘 − 内缘. */
export function cornerArcs(rt: number, u: number): Array<{ color: string; r: number; w: number }> {
  const band = (b: { out: number; in: number }, color: string) => ({ color, r: Math.max(0, rt + ((b.out + b.in) / 2) * u), w: (b.out - b.in) * u });
  return [band(OUTLINE_RING, 'rgb(255 255 255 / 0.7)'), band(OUTLINE_PURPLE, 'rgb(120 100 170 / 0.42)')];
}
