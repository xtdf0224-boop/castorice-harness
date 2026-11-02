/* 夜 · 转场的合成器通道（纯函数，不碰 DOM）：把 nightScene.prepareTransition 里原来「每个节拍写一遍样式」的东西，描述成通道（channels.ts）——
   原生缓动（2 个关键帧 + cubic-bezier，合成器自己算）或折线（自适应采样），由 sampler.ts 变成 WAAPI 关键帧、nightScene 挂到元素上。
   每条通道的 truth 就是 legacy 路径那一行样式写入的纯函数（同一批 trState / holeEdge / dissolveAlpha / flipAt / bfFlight），所以实时、导出、legacy 三者一致；
   scripts/check-boot.ts 对每条通道逐点对拍。 */
import { E, SSTEP_BEZIER, clamp, sstep } from './bootMath';
import type { Seg } from './bootMath';
import type { Rect, TransitionKind } from './bootTypes';
import { TOL_ALPHA, TOL_PX, cssOpacity, cssTranslateScale, cssTranslateX, knotsOf, nativeChannel, polyChannel, type Channel, type CssProps, type NativeChannel, type PolyChannel } from './channels';
import { FLIP_E, PAN_E, trDuration } from './trCore';
import { bfFlight, flipAt, flipTo, titleGroupAt, trState, type BfGoal, type BfPose, type Flip, type TitleGroup } from './transition';
import { dissolveAlpha, nightSegs, plateResidual, type PlateFit } from './transitionNight';

export interface NightCompInput {
  kind: TransitionKind;
  /** 离开时场景的时刻. */
  from: number;
  /** 定格了（底图是 drawPlate 的，只水平平移）；否则被打断（位图整个仿射到首页取景）. */
  settled: boolean;
  /** 左栏是竖栏、壁纸开着：有「洞」和取景平移. */
  push: boolean;
  /** 左栏宽（push 时才有意义）. */
  navW: number;
  txFrom: number;
  txTo: number;
  /** 被打断时位图的仿射（push && !settled）. */
  aff: PlateFit | null;
  /** 三层暗纱此刻的不透明度（shade-top、shade、shade-bot）. */
  shadeBase: [number, number, number];
  /** 淡出的小件：[不透明度起点, 上浮像素]（sub、rule、enter、skip、ver、sweep）. */
  fades: Array<{ base: number; dy: number }>;
  /** 署名：有 FLIP 就走；crBase = 此刻的不透明度. */
  fcr?: Flip;
  crBase: number;
  /** 蝶（有蝶才有）. */
  bf?: { start: BfPose; goal: BfGoal; path: Seg; glow0: number; over0: number };
}

export interface NightBfChannels {
  /** 容器：translate · rotate · scale 的位姿（蝶的方框中心、转角、翼展 × 拍翅）. */
  pose: PolyChannel;
  glowA: PolyChannel;
  bodyA: PolyChannel;
  overA: PolyChannel;
}

export interface NightChannels {
  dur: number;
  hole?: NativeChannel;
  holeInv?: NativeChannel;
  bg?: NativeChannel;
  plate?: Channel;
  shades: Array<NativeChannel | undefined>;
  fx: NativeChannel;
  fades: NativeChannel[];
  credit: Channel;
  backdrop?: Channel;
  bf?: NightBfChannels;
}

const cssFade = (hasDy: boolean) => (v: number[]): CssProps => (hasDy ? { opacity: Math.max(0, v[0]).toFixed(4), transform: `translateY(${v[1].toFixed(3)}px)` } : { opacity: Math.max(0, v[0]).toFixed(4) });
const cssCredit = (v: number[]): CssProps => ({ transform: `translate(${v[0].toFixed(3)}px, ${v[1].toFixed(3)}px) scale(${v[2].toFixed(5)})`, opacity: Math.min(1, Math.max(0, v[3])).toFixed(4) });
const cssBackdrop = (v: number[]): CssProps => ({ translate: `${v[0].toFixed(3)}px ${v[1].toFixed(3)}px`, scale: v[2].toFixed(5) });

/** 蝶容器的 CSS：位姿 = translate(x, y) rotate(rot) scale(sx, sy)（元素的原点在它自己的中心）. */
export const cssBfPose = (v: number[]): CssProps => ({ transform: `translate(${v[0].toFixed(3)}px, ${v[1].toFixed(3)}px) rotate(${v[2].toFixed(5)}rad) scale(${v[3].toFixed(5)}, ${v[4].toFixed(5)})` });

export function nightChannels(inp: NightCompInput): NightChannels {
  const { kind } = inp;
  const dur = trDuration(kind);
  const S = nightSegs(kind);
  const stAt = (tr: number) => trState('night', kind, tr);
  const out: NightChannels = { dur, shades: [], fx: undefined as unknown as NativeChannel, fades: [], credit: undefined as unknown as Channel };

  // ── 洞：左栏面板推过的地方，底板让出一块（holeEdge = pan · max(navW, 取景平移露出的暗带)）──
  const lx = inp.aff ? inp.aff.x : inp.txTo - inp.txFrom;
  const xmax = inp.push ? Math.max(inp.navW, Math.max(0, lx)) : 0;
  if (xmax > 0.01) {
    out.hole = nativeChannel({ name: 'hole', dur, span: S.pan, bezier: PAN_E.bezier!, ease: PAN_E, from: [0], to: [xmax], css: cssTranslateX });
    out.holeInv = nativeChannel({ name: 'holeInv', dur, span: S.pan, bezier: PAN_E.bezier!, ease: PAN_E, from: [0], to: [-xmax], css: cssTranslateX });
  }

  // ── 底图（canvas.boot__bg）：定格 → 水平平移到首页取景；被打断 → 位图仿射到首页取景 ──
  if (inp.push) {
    if (inp.aff) out.bg = nativeChannel({ name: 'bg', dur, span: S.pan, bezier: PAN_E.bezier!, ease: PAN_E, from: [0, 0, 1], to: [inp.aff.x, inp.aff.y, inp.aff.s], css: cssTranslateScale, tol: [TOL_PX, TOL_PX, 0.0002] });
    else if (inp.settled && Math.abs(inp.txTo - inp.txFrom) > 1e-6) out.bg = nativeChannel({ name: 'bg', dur, span: S.pan, bezier: PAN_E.bezier!, ease: PAN_E, from: [0], to: [inp.txTo - inp.txFrom], css: cssTranslateX });
  }

  // ── 底板整张溶掉：完整版 E.ease（原生）；快速版按亮度差整形（dissolveFast，折线）──
  if (kind === 'full') {
    out.plate = nativeChannel({ name: 'plate', dur, span: S.dissolve, bezier: E.ease.bezier!, ease: E.ease, from: [1], to: [0], css: cssOpacity, tol: [TOL_ALPHA] });
  } else {
    out.plate = polyChannel({
      name: 'plate', dur, knots: knotsOf(dur, S.dissolve), tol: [TOL_ALPHA], css: cssOpacity,
      truth: (tr) => { const st = stAt(tr); return [1 - dissolveAlpha(kind, st, inp.from)]; },
    });
  }

  // ── 暗纱三层 ──
  out.shades = inp.shadeBase.map((b, i) => (b > 0 ? nativeChannel({ name: `shade${i}`, dur, span: S.shade, bezier: FLIP_E.bezier!, ease: FLIP_E, from: [b], to: [0], css: cssOpacity, tol: [TOL_ALPHA] }) : undefined));

  // ── 前景画布与小件的淡出（smoothstep 的 ambient）──
  out.fx = nativeChannel({ name: 'fx', dur, span: S.ambient, bezier: SSTEP_BEZIER, ease: sstep, from: [1], to: [0], css: cssOpacity, tol: [TOL_ALPHA] });
  out.fades = inp.fades.map((f, i) => nativeChannel({
    name: `fade${i}`, dur, span: S.ambient, bezier: SSTEP_BEZIER, ease: sstep,
    from: f.dy ? [f.base, 0] : [f.base], to: f.dy ? [0, f.dy] : [0], css: cssFade(!!f.dy), tol: f.dy ? [TOL_ALPHA, TOL_PX] : [TOL_ALPHA],
  }));

  // ── 署名 ──
  if (inp.fcr) {
    const f = inp.fcr;
    const w = 220;       // 署名文字的宽度量级（px）：缩放分量的容限按它换算
    out.credit = polyChannel({
      name: 'credit', dur, knots: knotsOf(dur, S.credit, S.creditOut), tol: [TOL_PX, TOL_PX, TOL_PX / w, TOL_ALPHA], css: cssCredit,
      truth: (tr) => { const st = stAt(tr); const g = flipAt(f, st.credit); return [g.x, g.y, g.s, (inp.crBase + (1 - inp.crBase) * st.credit) * (1 - st.creditOut)]; },
    });
  } else {
    out.credit = nativeChannel({ name: 'credit', dur, span: S.ambient, bezier: SSTEP_BEZIER, ease: sstep, from: [inp.crBase], to: [0], css: cssOpacity, tol: [TOL_ALPHA] });
  }

  // ── 首页壁纸层（夜）：与位图一起套同一个剩余变换（individual translate / scale 属性，不碰它自己的 transform 过渡）──
  if (inp.push) {
    if (inp.aff) {
      const aff = inp.aff;
      out.backdrop = polyChannel({
        name: 'backdrop', dur, knots: knotsOf(dur, S.pan), tol: [TOL_PX, TOL_PX, 0.0002], css: cssBackdrop,
        truth: (tr) => { const b = plateResidual(aff, stAt(tr).pan); return [b.x, b.y, b.k]; },
      });
    } else if (inp.settled && Math.abs(inp.txTo - inp.txFrom) > 1e-6) {
      out.backdrop = nativeChannel({ name: 'backdrop', dur, span: S.pan, bezier: PAN_E.bezier!, ease: PAN_E, from: [inp.txFrom - inp.txTo, 0, 1], to: [0, 0, 1], css: cssBackdrop });
    }
  }

  // ── 蝶：容器（位姿）与三层的不透明度 ──
  if (inp.bf) {
    const { start, goal, path, glow0, over0 } = inp.bf;
    const poseAt = (tr: number) => { const st = stAt(tr); const p = bfFlight(start, goal, path, st.fly, st.flap, tr); const a = p.alpha * (1 - st.swapOut); return { st, p, a }; };
    const S2 = nightSegs(kind);
    const knots = knotsOf(dur, S2.fly, S2.swap, S2.swapOut);
    // 容限：位置 0.25 px；转角按蝶的半对角线换算；缩放按 100 px 的方框换算
    const unit0 = Math.max(start.w, goal.w) / 100;
    const halfDiag = 64 * unit0;
    const tolRot = TOL_PX / halfDiag;
    const tolS = TOL_PX / 50;
    const pose = polyChannel({
      name: 'bfPose', dur, knots, css: cssBfPose, tol: [TOL_PX, TOL_PX, tolRot, tolS, tolS],
      truth: (tr) => { const { p } = poseAt(tr); const u = p.w / 100; return [p.x, p.y, p.rot, Math.max(0.02, p.flap) * u, u]; },
    });
    const alpha = (name: string, f: (st: ReturnType<typeof stAt>, a: number) => number) => polyChannel({
      name, dur, knots, css: cssOpacity, tol: [TOL_ALPHA],
      truth: (tr) => { const { st, a } = poseAt(tr); return [clamp(f(st, a), 0, 1)]; },
    });
    out.bf = {
      pose,
      glowA: alpha('bfGlow', (st, a) => (glow0 + (0.5 - glow0) * Math.sin(Math.PI * clamp(st.fly))) * a),
      bodyA: alpha('bfBody', (_st, a) => a),
      overA: alpha('bfOver', (st, a) => (over0 + (0.3 - over0) * Math.sin(Math.PI * clamp(st.fly))) * a),
    };
  }
  return out;
}

/* ───────── 标题组（栖枝 / ALIGHT）：预烘焙的叠层 + 合成器位姿 ─────────
   原来每个节拍写 h1 / ALIGHT 的 transform、letter-spacing（重排）、渐变色标（每个节拍重画字面）、外发光（drop-shadow 的链，每拍重算）——主线程每帧都要样式 + 布局 + 绘制 + 提交。
   现在标题已完全浮现时（定格后，或晚于 7.2 s 被打断），转场把它换成预烘焙的叠层：
     · 位姿 = 整体 translate / scale（titleGroupAt 的 FLIP，折线）+ opacity（titleOut，原生线性）；
     · 字距的收拢 = 逐字的 translateX（栖枝：第二字；ALIGHT：六个字母各自，位置取自原整串排版的量值，保持字距微调一致）；letter-spacing 不再动；
     · 渐变 → 字标色 = 渐变字层 + 纯色字层叠放，上层 opacity = tint；外发光 = 透明字 + text-shadow 的光晕层，opacity = 1 − tint（只是字面之外的一圈，与字层独立）。
   这些全是合成器上的 transform / opacity，主线程不再碰标题。 */
export interface NightTitleInput {
  kind: TransitionKind;
  grp: TitleGroup;
  /** 「栖枝」/ ALIGHT 的盒子（屏幕像素）与 ALIGHT 的文字矩形. */
  h1Box: Rect;
  enBox: Rect;
  enSrc: Rect;
  /** 开屏里与字标里的字距（em）与字号（px）. */
  lsH1: number;
  lsEn: number;
  nameLS: number;
  subLS: number;
  fsH1: number;
  fsEn: number;
  /** ALIGHT 的字母数. */
  letters: number;
}

export interface NightTitleChannels {
  h1Tf: PolyChannel;
  enTf: PolyChannel;
  /** 「栖枝」/ ALIGHT 整体淡出（titleOut）. */
  out: NativeChannel;
  /** 光晕层：1 → 0（tint）；纯色字层：0 → 1. */
  halo: NativeChannel;
  flat: NativeChannel;
  /** 「栖枝」第二个字、ALIGHT 各字母的 translateX（letter-spacing 的收拢）；第 0 个字母 / 第一个字不动. */
  h1Char: NativeChannel;
  enLetter: NativeChannel[];
}

export function nightTitleChannels(inp: NightTitleInput): NightTitleChannels {
  const { kind, grp } = inp;
  const dur = trDuration(kind);
  const S = nightSegs(kind);
  const stAt = (tr: number) => trState('night', kind, tr);
  const knots = knotsOf(dur, S.title);
  const tolS1 = TOL_PX / Math.max(40, grp.h1Src.w);
  const tolS2 = TOL_PX / Math.max(40, inp.enSrc.w);
  return {
    h1Tf: polyChannel({
      name: 'titleH1', dur, knots, tol: [TOL_PX, TOL_PX, tolS1], css: cssTranslateScale, start: S.title[0],
      truth: (tr) => { const g = titleGroupAt(grp, stAt(tr).title).h1Flip; return [g.x, g.y, g.s]; },
    }),
    enTf: polyChannel({
      name: 'titleEn', dur, knots, tol: [TOL_PX, TOL_PX, tolS2], css: cssTranslateScale, start: S.title[0],
      truth: (tr) => { const r = titleGroupAt(grp, stAt(tr).title).enRect; const f = flipTo(inp.enBox, inp.enSrc, r); return [f.x, f.y, f.s]; },
    }),
    out: nativeChannel({ name: 'titleOut', dur, span: S.titleOut, bezier: [0, 0, 1, 1], ease: (x) => x, from: [1], to: [0], css: cssOpacity, tol: [TOL_ALPHA] }),
    halo: nativeChannel({ name: 'titleHalo', dur, span: S.tint, bezier: E.inout.bezier!, ease: E.inout, from: [1], to: [0], css: cssOpacity, tol: [TOL_ALPHA] }),
    flat: nativeChannel({ name: 'titleFlat', dur, span: S.tint, bezier: E.inout.bezier!, ease: E.inout, from: [0], to: [1], css: cssOpacity, tol: [TOL_ALPHA] }),
    h1Char: nativeChannel({ name: 'titleH1Char', dur, span: S.title, bezier: FLIP_E.bezier!, ease: FLIP_E, from: [0], to: [(inp.nameLS - inp.lsH1) * inp.fsH1], css: cssTranslateX }),
    enLetter: Array.from({ length: inp.letters }, (_, i) => nativeChannel({ name: `titleEnL${i}`, dur, span: S.title, bezier: FLIP_E.bezier!, ease: FLIP_E, from: [0], to: [i * (inp.subLS - inp.lsEn) * inp.fsEn], css: cssTranslateX })),
  };
}
