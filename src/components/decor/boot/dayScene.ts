/* 开屏 · 昼「花海」。DOM 舞台（官方立绘＋蒙版、花海条、枝条与枝上白花、落蝶）＋ fx 画布，时刻 t 的纯函数。
   分镜见 design/boot/STORYBOARD.md §3；这里是 design/boot/proto/index.html 昼版的移植。
   舞台是 1600×1000 的设计坐标（按窗高缩放、左上对齐）；绽开用 CSS 径向蒙版让「立绘与花海一起从脚下长出」。
   SVG 里的 id 都带 bt- 前缀（应用的 Sprite 里已有 alt-* 符号，文档内 id 必须唯一）。 */
import { E, TAU, bez, bezD, clamp, cubic, invFlight, lerp, mulberry32, pathAt, popCurve, sstep, win } from './bootMath';
import { bootImpl } from './bootImpl';
import { prepareDayTransitionComp } from './dayTrComp';
import { bakePlate } from './plateBake';
import { FL_PAD, bakeArt, bakeBk, bakeFlowers, bakeStrip, decodeImage, nextTask } from './dayBake';
import { bootGovernor } from './governor';
import { TILE_FROM, classifyTiles, dirtyRects, makeGrid, nearRowOf, type TileGrid } from './bloomTiles';
import { BLOOM_CENTERS, BLOOM_FEATHER, BLOOM_FEATHER_SOFT, BLOOM_FLAT, BLOOM_FLOWER_MARGIN, BLOOM_FOG, BLOOM_MAIN_DELAY, BLOOM_PETALS, BLOOM_P, BLOOM_T, T_FREE, beamBase, beamFrame, bloomBox, bloomE, bloomFlat, bloomFogAlpha, bloomLayers, bloomMaskCss, bloomOpen, bloomRadius, BEAM_ROT, BEAM_TOP } from './dayBloom';
import { DC, SHADOW_BLUR, SHADOW_DY, SHADOW_LOWRES, SHADOW_PAD, SHADOW_RGBA, WIN_EDGE_PAD, WIN_EDGE_SOFT, WIN_SOFT, winEdgeAlpha, winSoft } from './dayConst';
import type { Seg } from './bootMath';
import { BOOT_MAX_DPR, boxRect, f1, fadeTo, loadImg, lsEm, q1, qa, radialSprite, rangeRect, reveal, revealBase, settleReveal, svgToCanvas, unionRect } from './bootDom';
import type { BootScene, Rect, SceneOptions, SceneTransition, SceneVideo, TrOptions } from './bootTypes';
import { ARCH_BOTTOM_RADIUS, DAY_EN_COLOR, DAY_TITLE_COLOR, FIG_STAGE, PAPER_FEATHER, archClip, archClipCss, archClipRect, artFit, bfBox, bfFlight, brandGoal, daySegs, createTwigFx, decoXf, dustDots, flightPath, flipAt, flipCss, flipRectAt, flipTo, paperEdge, parseRgb, stageToScreen, tintColor, titleGroupAt, trState, twigFootScreen, twigOpen, type ArchClip, type BfPose, type Flip, type TitleGroup, type TwigFx } from './transition';

/** 昼的时间表（秒）。审查后整体提前 0.6 s（蝶的出生 / 展翅 / 飞行 / 枝条），1.7–2.8 s 不再有一段几乎不动的空档；之后的文字时刻都相对落地时刻 L. */
export const DT = { cam: 6.0, bloom: BLOOM_T, twig: [1.3, 4.4], thorn: [1.1, 2.0], glow: 2.0, dot: [2.2, 2.65], unfurl: [2.4, 2.9], fly: [2.8, 5.0] } as const;
/* R5（节奏）：绽开改成前快后慢之后，画面约 1.2 s 就「开完」，蝶与枯枝要到 3.4 s 才出现，中间约 2.2 s 什么都不发生、左边 40% 的画面只是空雾。
   用分镜 D1 原本的事件把空档填上：枯枝 1.3 s 起从左上角在空雾里描出来（一直描到 4.4 s，蝶落地前 0.6 s 描完——左半屏有一个持续的生长事件）、荆棘光脉冲放在 1.1–2.0 s
   （绽开的圆已经铺开之后，不再是 0.3 s 时圆心一滴孤立的紫「墨渍」）、蝶的出生光晕 2.0 s 起。验收（check-boot）：1.0 s 以后任意连续 1 s 里至少有一个叙事事件在进行. */
export const DAY_EVENTS: ReadonlyArray<readonly [string, number, number]> = [
  ['bloom', 0, 2.7], ['thorn', 1.1, 2.0], ['twig', 1.3, 4.4], ['birth', 2.0, 2.9], ['fly', 2.8, 5.0],
];
/** 枝条描画的缓动：墨迹起笔就看得见（不是 inout 那种 10% 时间里几乎不动的慢起步）. */
export const TWIG_E = cubic(0.3, 0, 0.35, 1);
/** 枝条主干起点在屏外（舞台 (−50, 14)）：描画进度从 TWIG_P0 起，一开始枝尖就已经探进画面，1.3 s 起就看得见这一笔. */
export const TWIG_P0 = 0.1;
export const twigProgress = (t: number) => TWIG_P0 * sstep(win(t, DT.twig[0] - 0.1, DT.twig[0] + 0.1)) + (1 - TWIG_P0) * TWIG_E(win(t, DT.twig[0], DT.twig[1]));
/** 落地时刻（蝶在枝梢停稳）. */
const L = DT.fly[1];
export const T_END = L + 2.4;
/** 视频版的「清晰立绘层」（docs/BOOT-VIDEO.md §1.2 修订）：视频只承载环境层（底板 / 光晕 / 光束 / 花海条 / 枝 / 绽开期的立绘与雾），官方立绘与近景散花在绽开收完（T_FREE = 2.7 s）后改由实时 DOM 叠在视频之上，
    按设备像素清晰合成（视频受「不放大超过原图」限制只有 0.846 像素 / 舞台单位，拉到屏上要放大约 1.8 倍，立绘会发糊）。
    ovPre：DOM 立绘层提前栅格（opacity .001）；ovFrom → ovTo：DOM 立绘层从 0 淡入到 1（此时视频里还有立绘，是一次约 300 ms 的「对焦」）；ovTo 起视频母版里不再有立绘 / 近景散花。
    蝶 / 花瓣 / 轨迹 / 各种落蝶光晕 / 雪点全程实时（它们叠在立绘上方，烘进视频会被 DOM 立绘盖住）。 */
/** vidSettle：等合成器缓过来的判据（相邻 rAF 间隔 ≤ SETTLE_QUIET_DT ms 连续两次，最多等 SETTLE_MAX_MS）. */
const SETTLE_QUIET_DT = 20;
const SETTLE_MAX_MS = 260;
/** 蝶的预热开始时刻（视频版）. */
const BF_WARM_FROM = 1.6;
export const DAY_VID = { ovPre: 1.4, ovFrom: 2.7, ovTo: 3.0 } as const;
/** 视频期间枝从这一刻起由实时层画（= 描画开始前 0.1 s，twigProgress 的 sstep 起点）；镜头缩放（world 的 transform）同样从这一刻起写. */
const TWIG_LIVE_FROM = DT.twig[0] - 0.1;
/* 绽开中心 DC、窗的轮廓 / 软边 / 落影常量与 winEdgeAlpha / winSoft 搬到了 dayConst.ts（昼的合成器通道 dayComp.ts 也要用，避免成环）；这里原样 re-export. */
export { DC, winEdgeAlpha, WIN_EDGE_PAD, WIN_SOFT, winSoft, WIN_EDGE_SOFT, SHADOW_DY, SHADOW_BLUR, SHADOW_RGBA, SHADOW_LOWRES, SHADOW_PAD };
/* 绽开的纯函数（半径 / 花瓣 / 中心 / 羽化 / 蒙版并集的层列表 / 撤蒙版时刻 / 光束）搬到了 dayBloom.ts（开屏的 DOM 路径与画布路径共用同一份公式）；这里原样 re-export. */
export { BLOOM_FEATHER, BLOOM_P, bloomE, bloomRadius, BLOOM_CENTERS, BLOOM_MAIN_DELAY, BLOOM_FLOWER_MARGIN, BLOOM_FOG, bloomFogAlpha, BLOOM_PETALS, BLOOM_FLAT, BLOOM_FEATHER_SOFT };
const REST_ROT = (-6 * Math.PI) / 180;
const REST_K = 1.5;
const K = 'bt-';

/** 给 SVG 的 id / url(#…) / href="#…" 加前缀. */
const SVG_IDS = ['glowBlue', 'gWi', 'gSheen', 'wF', 'wH', 'wingB', 'bBody', 'petalW', 'petalR', 'pt5', 'pt6', 'fl3', 'fl2', 'fl', 'twSh', 'snSh', 'twm'];
const idRe = new RegExp(`(id="|url\\(#|href="#)(${SVG_IDS.join('|')})(?=["')])`, 'g');
const pre = (s: string) => s.replace(idRe, `$1${K}$2`);

/** 蝶与安提灵花的 defs（逐字取自样稿 mockups/day/index.html） */
const DEFS = pre(`<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
  <radialGradient id="glowBlue" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#7cc8f7" stop-opacity=".85"/><stop offset="1" stop-color="#7cc8f7" stop-opacity="0"/></radialGradient>
  <linearGradient id="gWi" x1="0" y1="0" x2="1" y2=".4"><stop offset="0" stop-color="#a6e6fb"/><stop offset=".3" stop-color="#6cc4f4"/><stop offset=".7" stop-color="#3a82dc"/><stop offset="1" stop-color="#2b55b8"/></linearGradient>
  <linearGradient id="gSheen" x1="0" y1="1" x2="1" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#e6fbff" stop-opacity=".6"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <path id="wF" d="M1 -1.2C2.6 -13 12 -25.5 26 -29.6C30.6 -30.6 33.6 -27.6 32.2 -22.6C30.6 -14 24.2 -6.6 14.6 -2.6C9 -.6 4.2 .9 1 1.2Z"/>
  <path id="wH" d="M1 2.8C9 2 18.6 4.4 22.6 10.6C25.2 16.8 20.2 23.6 12.6 22.6C6.4 21.6 2.4 13.2 1 5.6Z"/>
  <g id="wingB">
    <use href="#wF" fill="#111a3b"/><use href="#wH" fill="#111a3b"/>
    <use href="#wF" transform="translate(.5 .1) scale(.8)" fill="url(#gWi)"/><use href="#wH" transform="translate(.5 .3) scale(.79)" fill="url(#gWi)"/>
    <path d="M2 -1C9 -8 17 -15 24 -20M2 .2C11 -3 20 -9 27 -14M2 3C8 3.4 14 7.6 16.6 14" fill="none" stroke="#10307e" stroke-opacity=".34" stroke-width=".55" stroke-linecap="round"/>
    <path d="M4 -3C9 -11 15 -17 22 -21C19.4 -14 13 -8 6 -2.4Z" fill="url(#gSheen)" opacity=".5"/>
  </g>
  <g id="bBody"><path d="M0 -9.5V12" stroke="#0e1230" stroke-width="2.3" stroke-linecap="round"/><circle cx="0" cy="-10" r="1.7" fill="#0e1230"/><path d="M-.5 -10.8C-1.5 -15 -4.5 -18 -8 -19M.5 -10.8C1.5 -15 4.5 -18 8 -19" fill="none" stroke="#0e1230" stroke-width=".9" stroke-linecap="round"/></g>
  <linearGradient id="petalW" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".7" stop-color="#f6f2fc"/><stop offset="1" stop-color="#dcd2f0"/></linearGradient>
  <radialGradient id="petalR" cx=".5" cy=".85" r=".9"><stop offset="0" stop-color="#e5dcf6"/><stop offset=".6" stop-color="#f8f5fd"/><stop offset="1" stop-color="#ffffff"/></radialGradient>
  <path id="pt5" d="M0 -1.2C-3.9 -2.6 -5.2 -8 -2.4 -9.7C-1.2 -10.3 1.2 -10.3 2.4 -9.7C5.2 -8 3.9 -2.6 0 -1.2Z"/>
  <path id="pt6" d="M0 -1.4C-2.4 -3.2 -2.8 -8 -.9 -9.8C-.3 -10.3 .3 -10.3 .9 -9.8C2.8 -8 2.4 -3.2 0 -1.4Z"/>
  <symbol id="fl" viewBox="-10 -10 20 20" overflow="visible">
    <g fill="url(#petalR)" stroke="rgba(120,100,170,.4)" stroke-width=".5">
      <use href="#pt5"/><use href="#pt5" transform="rotate(72)"/><use href="#pt5" transform="rotate(144)"/><use href="#pt5" transform="rotate(216)"/><use href="#pt5" transform="rotate(288)"/>
    </g>
    <g stroke="rgba(150,125,200,.35)" stroke-width=".35" fill="none"><path d="M0 -2.4V-8"/><path d="M0 -2.4V-8" transform="rotate(72)"/><path d="M0 -2.4V-8" transform="rotate(144)"/><path d="M0 -2.4V-8" transform="rotate(216)"/><path d="M0 -2.4V-8" transform="rotate(288)"/></g>
    <circle r="1.9" fill="#f1d58a"/><circle r="1.9" fill="none" stroke="#c9a24d" stroke-width=".35"/>
    <g fill="#b98a30"><circle cx="0" cy="-1" r=".28"/><circle cx=".9" cy=".5" r=".28"/><circle cx="-.9" cy=".5" r=".28"/><circle cx=".2" cy=".15" r=".28"/></g>
  </symbol>
  <symbol id="fl2" viewBox="-10 -10 20 20" overflow="visible">
    <g fill="url(#petalR)" stroke="rgba(120,100,170,.4)" stroke-width=".5">
      <use href="#pt6"/><use href="#pt6" transform="rotate(51)"/><use href="#pt6" transform="rotate(103)"/><use href="#pt6" transform="rotate(154)"/><use href="#pt6" transform="rotate(206)"/><use href="#pt6" transform="rotate(257)"/><use href="#pt6" transform="rotate(309)"/>
    </g>
    <circle r="1.5" fill="#f4e0a0"/><circle r="1.5" fill="none" stroke="#c9a24d" stroke-width=".3"/>
  </symbol>
  <symbol id="fl3" viewBox="-10 -10 20 20" overflow="visible">
    <g fill="url(#petalR)" stroke="rgba(120,100,170,.4)" stroke-width=".5">
      <path d="M0 2C-5 0 -6.4 -6.4 -2.6 -8.4C-1 -9.2 -.2 -8 0 -6.4C.2 -8 1 -9.2 2.6 -8.4C6.4 -6.4 5 0 0 2Z"/>
      <path d="M0 2C-2.6 -1.4 -2 -6 0 -6.4C2 -6 2.6 -1.4 0 2Z" fill="#fff"/>
    </g>
    <circle cy="1.4" r="1" fill="#f1d58a"/>
  </symbol>
</defs></svg>`);

const SEG_MAIN1: Seg = [[-50, 14], [60, 24], [168, 68], [254, 148]];
const SEG_MAIN2: Seg = [[254, 148], [294, 184], [342, 212], [398, 240]];

/** 枝杈显现窗口的上限（主干进度的长度）与最末一根（sf，接在 sa 的枝梢）的窗口. */
const TWIG_WIN = 0.28;
const TWIG_WIN_F = 0.16;
interface TwigSub { p: Seg; w0: number; w1: number; t?: number }
interface Twig { html: string; /** 主体（.bd-twbody 里面的内容，不含 mask）与它用到的两个滤镜：烘焙成位图时单独组一张 SVG（见 createDayScene 的 bakeTwig）. */ body: string; filters: string; main1: Seg; main2: Seg; subs: TwigSub[]; attach: number[]; /** 每根枝杈的显现窗口（主干进度的长度）；画布版与 SVG 版共用. */ win: number[]; FL: Array<[[number, number], number, number, string]>; land: [number, number]; order: number[] }

/** 枝条（样稿 s0 的生成代码，改为返回数据以便逐部分动画）：主干＋5 根枝杈＋白花＋落蝶蓝晕. */
export function buildTwig(): Twig {
  const B = bez;
  const D = bezD;
  const nrm = (p: Seg, t: number): [number, number] => { const d = D(p, t); const l = Math.hypot(d[0], d[1]) || 1; return [-d[1] / l, d[0] / l]; };
  const Wd = (w0: number, w1: number, u: number) => w0 + (w1 - w0) * Math.pow(u, 0.85);
  const taper = (p: Seg, w0: number, w1: number) => {
    const n = 36;
    const L: string[] = [];
    const Rr: string[] = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const q = B(p, t);
      const nn = nrm(p, t);
      const w = Wd(w0, w1, t) / 2;
      L.push(`${f1(q[0] + nn[0] * w)} ${f1(q[1] + nn[1] * w)}`);
      Rr.push(`${f1(q[0] - nn[0] * w)} ${f1(q[1] - nn[1] * w)}`);
    }
    return `M${L.join('L')}L${Rr.reverse().join('L')}Z`;
  };
  const side = (p: Seg, w0: number, w1: number, t0: number, t1: number, off: number, up: boolean) => {
    const n = 22;
    let d = '';
    for (let i = 0; i <= n; i++) {
      const t = t0 + ((t1 - t0) * i) / n;
      const q = B(p, t);
      let nn = nrm(p, t);
      const w = (Wd(w0, w1, t) / 2) * off;
      if (up && nn[1] > 0) nn = [-nn[0], -nn[1]];
      d += `${i ? 'L' : 'M'}${f1(q[0] + nn[0] * w)} ${f1(q[1] + nn[1] * w)}`;
    }
    return d;
  };
  const main1 = SEG_MAIN1;
  const main2 = SEG_MAIN2;
  const sub = (seg: Seg, t: number, v: readonly [readonly [number, number], readonly [number, number], readonly [number, number]], w0: number, w1: number): TwigSub => {
    const p0 = B(seg, t);
    return { p: [p0, [p0[0] + v[0][0], p0[1] + v[0][1]], [p0[0] + v[1][0], p0[1] + v[1][1]], [p0[0] + v[2][0], p0[1] + v[2][1]]], w0, w1, t };
  };
  const sa = sub(main1, 0.3, [[12, -14], [38, -26], [74, -28]], 3.6, 1.0);
  const sb = sub(main1, 0.54, [[2, 26], [-8, 46], [-26, 62]], 3.8, 1.0);
  const sc = sub(main1, 1.0, [[8, 24], [-4, 50], [-30, 66]], 4.6, 1.1);
  const sd = sub(main2, 0.26, [[14, -20], [34, -30], [62, -32]], 3.4, 1.0);
  const se = sub(main2, 0.56, [[6, 20], [2, 38], [-16, 52]], 2.6, 0.9);
  const sf: TwigSub = { p: [sa.p[3], [sa.p[3][0] + 4, sa.p[3][1] - 12], [sa.p[3][0] + 16, sa.p[3][1] - 20], [sa.p[3][0] + 34, sa.p[3][1] - 16]], w0: 1.9, w1: 0.7 };
  const subs = [sa, sb, sc, sd, se, sf];
  // 主干＋枝杈的显现顺序（相对主干进度 0..1）：附着点处开始长出。
  // 遮罩的进度是主干的**弧长比例**（pathLength = 1），不是贝塞尔参数：attach 必须取附着点在主干折线上的弧长比例，否则枝杈比主干前沿早出现，
  // 线宽 30 的圆头描边会让附着点周围一整块圆盘凭空冒出来（一座孤岛，主干前沿稍后才追上接上，实测一帧里墨面积涨 18–40 倍，就是「出来卡卡的」）.
  const arcN = 1200;
  const cum1: number[] = [0];
  const cum2: number[] = [0];
  for (let i = 1; i <= arcN; i++) {
    const a = B(main1, (i - 1) / arcN);
    const b = B(main1, i / arcN);
    cum1.push(cum1[i - 1] + Math.hypot(b[0] - a[0], b[1] - a[1]));
    const c = B(main2, (i - 1) / arcN);
    const d = B(main2, i / arcN);
    cum2.push(cum2[i - 1] + Math.hypot(d[0] - c[0], d[1] - c[1]));
  }
  const arcTotal = cum1[arcN] + cum2[arcN];
  const arcAt = (cum: number[], base: number, t: number): number => {
    const x = Math.min(1, Math.max(0, t)) * arcN;
    const i = Math.min(arcN - 1, Math.floor(x));
    return (base + cum[i] + (cum[i + 1] - cum[i]) * (x - i)) / arcTotal;
  };
  const attachMain: number[] = [arcAt(cum1, 0, 0.3), arcAt(cum1, 0, 0.54), arcAt(cum1, 0, 1), arcAt(cum2, cum1[arcN], 0.26), arcAt(cum2, cum1[arcN], 0.56)];
  // 枝杈的显现窗口：不超过 .28，且 attach + win ≤ 1（旧版 se 在 gp = 1 时只画到 79%，4.4 s 整枝撤遮罩时剩下 21% 一下补满）；sf 从 sa 的枝梢起（sa 画满的那一刻）
  const wins = attachMain.map((a) => Math.min(TWIG_WIN, 1 - a));
  const attach = [...attachMain, attachMain[0] + wins[0]];
  wins.push(TWIG_WIN_F);
  const filters = `<filter id="${K}twSh" x="-5%" y="-10%" width="110%" height="130%"><feDropShadow dx="0" dy="2.5" stdDeviation="2.2" flood-color="#3c2a64" flood-opacity=".22"/></filter>` +
    `<filter id="${K}snSh" x="-10%" y="-60%" width="120%" height="220%"><feDropShadow dx="0" dy="1" stdDeviation=".9" flood-color="#6a58a0" flood-opacity=".38"/></filter>`;
  let h = `<defs>${filters}`;
  const cl = (p: Seg) => `M${p[0][0]} ${p[0][1]}C${p[1][0]} ${p[1][1]} ${p[2][0]} ${p[2][1]} ${p[3][0]} ${p[3][1]}`;
  const mainD = `M${main1[0][0]} ${main1[0][1]}C${main1[1][0]} ${main1[1][1]} ${main1[2][0]} ${main1[2][1]} ${main1[3][0]} ${main1[3][1]}C${main2[1][0]} ${main2[1][1]} ${main2[2][0]} ${main2[2][1]} ${main2[3][0]} ${main2[3][1]}`;
  h += `<mask id="${K}twm" maskUnits="userSpaceOnUse" x="-300" y="-300" width="2200" height="1600"><g fill="none" stroke="#fff" stroke-width="30" stroke-linecap="round" stroke-linejoin="round">` +
    `<path id="${K}mk0" d="${mainD}" pathLength="1" stroke-dasharray="1 3" stroke-dashoffset="1"/>` +
    subs.map((s, i) => `<path id="${K}mk${i + 1}" d="${cl(s.p)}" pathLength="1" stroke-dasharray="1 3" stroke-dashoffset="1"/>`).join('') + '</g></mask></defs>';
  h += `<g class="bd-twbody" mask="url(#${K}twm)">`;
  const bodyAt = h.length;
  h += `<g filter="url(#${K}twSh)" fill="#33243f">`;
  h += `<path d="${taper(main1, 11.5, 7.6)}"/><path d="${taper(main2, 7.6, 2.2)}"/>`;
  subs.forEach((s) => { h += `<path d="${taper(s.p, s.w0, s.w1)}"/>`; });
  h += '</g>';
  h += '<g fill="none" stroke-linecap="round">';
  h += `<path d="${side(main1, 11.5, 7.6, 0.02, 0.98, 0.34, false)}" stroke="#12091a" stroke-opacity=".55" stroke-width=".9" stroke-dasharray="14 6 5 9"/>`;
  h += `<path d="${side(main1, 11.5, 7.6, 0.05, 0.96, -0.42, false)}" stroke="#ffffff" stroke-opacity=".17" stroke-width=".8" stroke-dasharray="9 8 17 6"/>`;
  h += `<path d="${side(main2, 7.6, 2.2, 0.04, 0.9, 0.3, false)}" stroke="#12091a" stroke-opacity=".5" stroke-width=".8" stroke-dasharray="10 6 4 8"/>`;
  h += '</g>';
  const cap = (p: Seg, w0: number, w1: number, t0: number, t1: number, hh: number) => {
    const n = 18;
    const top: string[] = [];
    const bump: string[] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const t = t0 + (t1 - t0) * u;
      const q = B(p, t);
      let nn = nrm(p, t);
      const w = Wd(w0, w1, t) / 2;
      if (nn[1] > 0) nn = [-nn[0], -nn[1]];
      const bmp = hh * Math.pow(Math.sin(Math.PI * u), 0.75) * (0.85 + 0.3 * Math.sin(u * 9));
      top.push(`${f1(q[0] + nn[0] * w * 0.8)} ${f1(q[1] + nn[1] * w * 0.8)}`);
      bump.push(`${f1(q[0] + nn[0] * (w * 0.8 + bmp))} ${f1(q[1] + nn[1] * (w * 0.8 + bmp))}`);
    }
    return `M${top.join('L')}L${bump.reverse().join('L')}Z`;
  };
  h += `<g fill="#fff" filter="url(#${K}snSh)">`;
  ([[main1, 11.5, 7.6, 0.14, 0.32, 4.4], [main1, 11.5, 7.6, 0.5, 0.64, 3.6], [main1, 11.5, 7.6, 0.82, 0.99, 4.2], [main2, 7.6, 2.2, 0.06, 0.24, 3.4], [main2, 7.6, 2.2, 0.42, 0.56, 2.6]] as Array<[Seg, number, number, number, number, number]>).forEach((c) => { h += `<path d="${cap(c[0], c[1], c[2], c[3], c[4], c[5])}"/>`; });
  h += `<path d="${cap(sd.p, 3.4, 1, 0.14, 0.6, 2.4)}"/><path d="${cap(sa.p, 3.6, 1, 0.2, 0.62, 2.4)}"/>`;
  const body = `${h.slice(bodyAt)}</g>`;
  h += '</g></g>';
  // 白花（安提灵）：枝梢与节点，大小各异（样稿 flw）
  const FL: Twig['FL'] = [[sa.p[3], 24, 14, 'fl'], [sb.p[3], 28, -20, 'fl2'], [sc.p[3], 30, 30, 'fl'], [sd.p[3], 22, -8, 'fl2'], [se.p[3], 17, 10, 'fl3'], [sf.p[3], 14, 50, 'fl'], [B(main1, 0.3), 15, 0, 'fl3'], [B(main1, 1), 14, 20, 'fl2'], [B(sc.p, 0.5), 12, 0, 'fl3']] as unknown as Twig['FL'];
  FL.forEach((f, i) => { h += `<use class="bd-tf" data-i="${i}" href="#${K}${f[3]}" x="${f1(f[0][0] - f[1] / 2)}" y="${f1(f[0][1] - f[1] / 2)}" width="${f[1]}" height="${f[1]}" transform="rotate(${f[2]} ${f1(f[0][0])} ${f1(f[0][1])})"/>`; });
  // 落蝶：腹端与细足落在 main2 上缘（t≈.80），翅半举
  const tl = 0.8;
  const q = B(main2, tl);
  let nn = nrm(main2, tl);
  if (nn[1] > 0) nn = [-nn[0], -nn[1]];
  const wd = Wd(7.6, 2.2, tl) / 2;
  const fx = q[0] + nn[0] * wd * 0.7;
  const fy = q[1] + nn[1] * wd * 0.7;
  h += `<ellipse class="bd-twglow" cx="${f1(fx)}" cy="${f1(fy - 34)}" rx="78" ry="52" fill="url(#${K}glowBlue)" opacity="0"/>`;
  return { html: h, body, filters, main1, main2, subs, attach, win: wins, FL, land: [fx, fy], order: [] };
}

interface DayBloom { x: number; y: number; s: number; rot: number; t0: number; kind: number }
interface DayPetal { x: number; y: number; t0: number; vx: number; vy: number; amp: number; per: number; ph: number; s: number; rot: number; spin: number; life: number; c: boolean }
interface DaySnow { left: number; top: number; s: number; op: number; big: boolean; vy: number; vx: number; amp: number; per: number; ph: number }
interface DayBf { x: number; y: number; rot: number; sc: number; flap: number; pose: number; alpha: number; flying: boolean; qf: number }

export function createDayScene(o: SceneOptions): BootScene {
  const { host } = o;
  const P = (n: string) => `${o.base}boot/${n}`;
  const splash = `${o.base}art/splash-official.webp`;
  const figUrl = `${o.base}art/figure-official.webp`;
  const flowersUrl = `${o.base}art/day-flowers.webp`;
  const TWIG = buildTwig();

  /* 底板（薰衣草底 + 渐变底图 + 柔光）装在一个 overflow:hidden 的「持有者」里（.boot__ph > .boot__ps）：转场（comp）里它被拆成「左边一条 / 斜坡窄条 / 实心主体」三份，
     主体与斜坡由持有者平移 + 内层反向平移给出硬边 / 羽化边，不再每个节拍写整屏的补集遮罩（见 dayComp.ts 与 prepareTransitionComp）。开屏里它只是一个不动的容器，画面与原来逐像素相同. */
  host.innerHTML = `${DEFS}
  <div class="boot__ph"><div class="boot__ps">
    <div class="boot__plate"></div>
    <div class="bd-stack">
      <div class="bd-bg"><img class="bk" src="${splash}" alt="" draggable="false"><div class="tri"></div><div class="edge"></div></div>
      <div class="s0-glow"></div>
    </div>
  </div></div>
  <div class="bd-stage">
    <div class="bd-beams"><div class="beam"></div><div class="beam"></div><div class="beam"></div></div>
    <div class="bd-world">
      <div class="bd-near1 bd-pre"><div class="pstrip s0-pf"></div></div>
      <div class="bd-bloom">
        <div class="bd-near1"><div class="pstrip s0-pf"></div></div>
        <img class="s0-art" src="${splash}" alt="" draggable="false">
        <div class="bd-near2"><svg class="s0-fl bd-scat" viewBox="0 0 1600 190" aria-hidden="true"></svg></div>
      </div>
      <canvas class="s0-twc" aria-hidden="true" style="display:none"></canvas>
      <svg class="s0-twig" viewBox="0 0 1600 1000" aria-hidden="true">${TWIG.html}</svg>
    </div>
    <div class="bd-snow"></div>
  </div>
  <canvas class="boot__fx" aria-hidden="true"></canvas>
  <div class="bd-bfwrap"><div class="bd-bfzoom"><svg class="bd-bfsvg" viewBox="0 0 1600 1000" aria-hidden="true">
    <g class="bd-bf" opacity="0"><g class="bd-bfi"><g class="bd-bwl"><use href="#${K}wingB"/></g><g class="bd-bwr"><use href="#${K}wingB"/></g><use href="#${K}bBody"/><path class="bd-bleg" d="M0 -4L-3.4 11.4M0 -2L2.8 11.6M.4 0L6.2 11.2" fill="none" stroke="#0e1230" stroke-width=".8" stroke-linecap="round" opacity="0"/></g></g>
  </svg></div></div>
  <div class="bd-text" aria-hidden="true">
    <div class="s0-left">
      <h1><span class="c">栖</span><span class="c">枝</span></h1>
      <div class="en"><i></i><span>ALIGHT</span><i></i></div>
      <div class="ban"><svg class="st4" viewBox="0 0 24 24"><path d="M12 1.5C12.6 7.5 16.5 11.4 22.5 12 16.5 12.6 12.6 16.5 12 22.5 11.4 16.5 7.5 12.6 1.5 12 7.5 11.4 11.4 7.5 12 1.5Z"/></svg><b>遐蝶的 Agent 工作台</b></div>
      <div class="s0-epi"><i></i><span>你所在之处，便是温柔的花海</span><i></i></div>
      <div class="s0-enter"><svg class="flame" viewBox="0 0 32 32"><path class="fb" d="M4.5 25.6c3.6-2.7 7.4-4 11.5-4s7.9 1.3 11.5 4" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/><g fill="currentColor"><polygon class="fs" points="5.2,24 2.8,11.6 9.2,23.4"/><polygon class="fs" points="9.6,22.6 8.9,6.6 13,22.2"/><polygon class="fs" points="14.3,21.8 16,2.6 17.7,21.8"/><polygon class="fs" points="19,22.2 23.1,6.6 22.4,22.6"/><polygon class="fs" points="22.8,23.4 29.2,11.6 26.8,24"/></g></svg><span>按任意键进入</span><i class="ln"></i></div>
    </div>
    <p class="s0-skip">Esc 或任意键跳过</p>
    <p class="s0-ver">ALIGHT · ${o.version}</p>
    <p class="s0-credit" data-credit="boot">${o.credit}</p>
  </div>`;

  const fx = q1<HTMLCanvasElement>(host, '.boot__fx');
  const fctx = fx.getContext('2d')!;
  qa(host, '.pstrip').forEach((n) => { n.style.backgroundImage = `url("${P('day-strip.webp')}")`; });

  const el = {
    ch: qa(host, '.s0-left h1 .c'),
    en: q1(host, '.s0-left .en'),
    enSpan: q1(host, '.s0-left .en span'),
    enLines: qa(host, '.s0-left .en i'),
    banner: q1(host, '.s0-left .ban'),
    epiLines: qa(host, '.s0-epi i'),
    epiSpan: q1(host, '.s0-epi span'),
    enter: q1(host, '.s0-enter'),
    flame: qa<SVGElement>(host, '.s0-enter .fs'),
    flameBase: q1<SVGElement>(host, '.s0-enter .fb'),
    ln: q1(host, '.s0-enter .ln'),
    skip: q1(host, '.s0-skip'),
    ver: q1(host, '.s0-ver'),
    credit: q1(host, '.s0-credit'),
    ph: q1(host, '.boot__ph'),
    dstage: q1(host, '.bd-stage'),
    stack: q1(host, '.bd-stack'),
    dtext: q1(host, '.bd-text'),
    pf: q1(host, '.s0-pf'),
    bfwrap: q1(host, '.bd-bfwrap'),
    bfzoom: q1(host, '.bd-bfzoom'),
    world: q1(host, '.bd-world'),
    bloom: q1(host, '.bd-bloom'),
    near1: q1(host, '.bd-near1:not(.bd-pre)'),
    pre: q1(host, '.bd-pre'),
    near2: q1(host, '.bd-near2'),
    bgd: q1(host, '.bd-bg'),
    bk: q1<HTMLImageElement>(host, '.bd-bg .bk'),
    beams: qa(host, '.beam'),
    twglow: q1<SVGElement>(host, '.bd-twglow'),
    twbody: q1<SVGElement>(host, '.bd-twbody'),
    snow: q1(host, '.bd-snow'),
    scat: q1<SVGElement>(host, '.bd-scat'),
    bf: q1<SVGElement>(host, '.bd-bf'),
    bfi: q1<SVGElement>(host, '.bd-bfi'),
    bwl: q1<SVGElement>(host, '.bd-bwl'),
    bwr: q1<SVGElement>(host, '.bd-bwr'),
    bleg: q1<SVGElement>(host, '.bd-bleg'),
    art: q1<HTMLImageElement>(host, '.s0-art'),
  };
  const mks = [0, 1, 2, 3, 4, 5, 6].map((i) => q1<SVGElement>(host, `#${K}mk${i}`));
  const tfs = qa<SVGElement>(host, '.bd-tf');

  /* ───────── 枝的烘焙 ─────────
     枝的主体（.bd-twbody：填充 + 两个 feDropShadow 滤镜 + 描边 + 白帽）是静止的，每一拍变的只是显现用的遮罩（mask 里 7 条描边的 dashoffset）。SVG 每拍要把整根枝连同滤镜重新栅格
     （图层 3300 × 2400，实测开屏里它占瓦片光栅的头一份）。这里把主体烘进一张位图（一次），每拍只在一张小画布里画 7 条带虚线的描边当遮罩、destination-in 一下：
     画布命令走 GPU，没有瓦片光栅。遮罩的语义与 SVG 一致（pathLength = 1、dasharray 1 3、dashoffset 1 − p ⇒ 路径起点起长度 p 的一段；round 帽、线宽 30）。
     只在 comp 实现、实时播放里做（导出模式逐帧确定、不等图片解码；加 ?twigbake 可在导出里也开，对拍用）；位图没好 / 失败时一直走 SVG 老路径. */
  const twc = q1<HTMLCanvasElement>(host, '.s0-twc');
  const twForce = typeof location !== 'undefined' && /[?&]twigbake\b/.test(location.search);
  interface TwBake { body: HTMLCanvasElement; mask: HTMLCanvasElement; g: CanvasRenderingContext2D; mg: CanvasRenderingContext2D; bx: number; by: number; S: number; paths: Path2D[]; lens: number[]; last: number }
  let tw: TwBake | null = null;
  let twTimer = 0;
  let twGp = 0;
  let twGen = 0;
  function twigBakeWanted(): boolean { return bootImpl() === 'comp' && (!o.capture || twForce); }
  function resetTwig() {
    twGen++;
    window.clearTimeout(twTimer);
    tw = null;
    twc.style.display = 'none';
    el.twbody.removeAttribute('display');
  }
  function scheduleTwig() {
    resetTwig();
    if (!twigBakeWanted()) return;
    twTimer = window.setTimeout(bakeTwig, o.capture ? 0 : 200);
  }
  function bakeTwig() {
    const gen = twGen;
    try {
      const bb = (el.twbody as unknown as SVGGraphicsElement).getBBox();
      if (!(bb.width > 1) || !(bb.height > 1)) return;
      const pad = 20;
      const bx = bb.x - pad;
      const by = bb.y - pad;
      const bw = bb.width + 2 * pad;
      const bh = bb.height + 2 * pad;
      const S = Math.min(k * R * 1.25, 2048 / Math.max(bw, bh));      // 镜头最多推到 1.18 倍：留 1.25 倍的余量
      const pw = Math.max(2, Math.ceil(bw * S));
      const ph = Math.max(2, Math.ceil(bh * S));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bx.toFixed(2)} ${by.toFixed(2)} ${bw.toFixed(2)} ${bh.toFixed(2)}" width="${pw}" height="${ph}"><defs>${TWIG.filters}</defs>${TWIG.body}</svg>`;
      const img = new Image();
      img.onload = () => {
        if (gen !== twGen) return;
        try {
          const body = document.createElement('canvas');
          body.width = pw; body.height = ph;
          (body.getContext('2d') as CanvasRenderingContext2D).drawImage(img, 0, 0, pw, ph);
          const mask = document.createElement('canvas');
          mask.width = pw; mask.height = ph;
          twc.width = pw; twc.height = ph;
          twc.style.cssText = `left:${bx.toFixed(2)}px;top:${by.toFixed(2)}px;width:${bw.toFixed(2)}px;height:${bh.toFixed(2)}px;display:none`;
          const g = twc.getContext('2d');
          const mg = mask.getContext('2d');
          if (!g || !mg) return;
          const lens = mks.map((m) => (m as unknown as SVGGeometryElement).getTotalLength());
          const paths = mks.map((m) => new Path2D(m.getAttribute('d') ?? ''));
          tw = { body, mask, g, mg, bx, by, S, paths, lens, last: -1 };
          el.twbody.setAttribute('display', 'none');
          drawTwig(twGp);
          (window as unknown as { __twigReady?: boolean }).__twigReady = true;
        } catch { tw = null; }
      };
      img.onerror = () => { if (gen === twGen) tw = null; };
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    } catch { tw = null; }
  }
  function drawTwig(gp: number) {
    const b = tw;
    if (!b) return;
    if (Math.abs(gp - b.last) < 1e-6) return;
    b.last = gp;
    if (gp <= 0.0005) { twc.style.display = 'none'; return; }
    twc.style.display = 'block';
    const { g, mg, S } = b;
    const w = twc.width;
    const h = twc.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, w, h);
    g.drawImage(b.body, 0, 0);
    if (gp >= 1) return;
    mg.setTransform(1, 0, 0, 1, 0, 0);
    mg.clearRect(0, 0, w, h);
    mg.setTransform(S, 0, 0, S, -b.bx * S, -b.by * S);
    mg.strokeStyle = '#fff';
    mg.lineWidth = 30;
    mg.lineCap = 'round';
    mg.lineJoin = 'round';
    b.paths.forEach((pth, i) => {
      const p = i === 0 ? gp : clamp((gp - TWIG.attach[i - 1]) / TWIG.win[i - 1]);
      if (p <= 0.0005) return;
      mg.setLineDash([p * b.lens[i], 4 * b.lens[i]]);
      mg.lineDashOffset = 0;
      mg.stroke(pth);
    });
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(b.mask, 0, 0);
    g.globalCompositeOperation = 'source-over';
  }

  /* ───────── 精灵 ───────── */
  const SPR: Record<string, HTMLCanvasElement> = {};
  SPR.glowWhite = radialSprite(64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,.4)'], [1, 'rgba(255,255,255,0)']]);
  SPR.dayGlow = radialSprite(128, [[0, 'rgba(124,200,247,.5)'], [1, 'rgba(124,200,247,0)']]);
  SPR.dayBlue = radialSprite(128, [[0, 'rgba(110,190,255,.9)'], [0.4, 'rgba(110,190,255,.35)'], [1, 'rgba(110,190,255,0)']]);
  SPR.thorn = radialSprite(256, [[0, 'rgba(176,132,255,.95)'], [0.35, 'rgba(150,110,240,.4)'], [1, 'rgba(140,100,230,0)']]);
  SPR.mist = radialSprite(256, [[0, 'rgba(240,233,250,0)'], [0.55, 'rgba(240,233,250,0)'], [0.93, 'rgba(240,233,250,.62)'], [1, 'rgba(240,233,250,0)']]);
  const flowerSprite = (id: string, px: number) => {
    const sym = host.querySelector(`#${K}${id}`)!;
    const defs = ['petalR', 'pt5', 'pt6'].map((i) => host.querySelector(`#${K}${i}`)!.outerHTML).join('');
    return svgToCanvas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="-12 -12 24 24" width="${px}" height="${px}"><defs>${defs}</defs>${sym.innerHTML}</svg>`, px, px);
  };

  /* ───────── 确定性数据 ───────── */
  /** 蝶的路径：自花束的小蓝花出发，贴着发辫下方、绕开画中大蓝蝶（≥90 px）与标题块（≥100 px），自右上落向枝梢 */
  const DAY_PATH: Array<[[number, number], [number, number], [number, number], [number, number]]> = [
    [[936, 520], [930, 480], [892, 452], [836, 446]],
    [[836, 446], [766, 440], [676, 424], [612, 392]],
    [[612, 392], [556, 362], [516, 312], [488, 252]],
    [[488, 252], [458, 214], [412, 184], [0, 0]],           // 终点在 init 里接到 BODY_REST
  ];
  let BODY_REST: [number, number] = [0, 0];
  const DAY_BLOOM: DayBloom[] = [];
  const DAY_PETALS: DayPetal[] = [];
  const DAY_LAND_PETALS: DayPetal[] = [];
  let DAY_TRAIL: Array<{ q: number; p: [number, number]; dx: number; dy: number; rad: number; op: number }> = [];
  const DAY_SNOWD: DaySnow[] = [];
  const DAY_MOTES = (() => {
    const r = mulberry32(55);
    const out: Array<{ x0: number; y0: number; s: number; vy: number; amp: number; per: number; ph: number; a: number }> = [];
    for (let i = 0; i < 40; i++) out.push({ x0: r(), y0: r(), s: 1 + r() * 1.5, vy: -(5 + r() * 5), amp: 5 + r() * 8, per: 4 + r() * 4, ph: r() * TAU, a: 0.25 + r() * 0.25 });
    return out;
  })();
  /** 绽开半径（舞台单位）：自脚下 120 px 的小圈起，0.3→2.7 s */
  const RB = bloomRadius;
  /** 椭圆的竖 / 横比：开头扁、随绽开长成圆（绽满时 = 1）. */
  const FLAT = bloomFlat;
  /** 圆边（椭圆边）扫过 (dx, dy) 处的时刻：RB(t) ≥ hypot(dx, dy / FLAT(t))；左边随 t 增、右边随 t 减，二分. */
  const invRB = (dx: number, dy: number, margin = 0) => { let lo: number = DT.bloom[0]; let hi: number = DT.bloom[1]; for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (RB(m) < Math.hypot(dx, dy / FLAT(m)) + margin) lo = m; else hi = m; } return (lo + hi) / 2; };

  function initDay() {
    // 休止位置：蝶身中心（symbol 坐标 (0,-12)，缩放 1.5，转 -6°）
    const [fx0, fy0] = TWIG.land;
    const c = Math.cos(REST_ROT);
    const s = Math.sin(REST_ROT);
    BODY_REST = [fx0 + (0 * c - -12 * REST_K * s), fy0 + (0 * s + -12 * REST_K * c)];
    DAY_PATH[3][3] = [BODY_REST[0], BODY_REST[1]];
    let r = mulberry32(4242);
    let guard = 0;
    while (DAY_BLOOM.length < 64 && guard++ < 4000) {
      const x = 60 + r() * 1500;
      const y = 540 + r() * 450;
      if (x < 480 && y > 270 && y < 740) continue;           // 标题块
      DAY_BLOOM.push({ x, y, s: 14 + r() * 20, rot: (r() - 0.5) * 1.2, t0: invRB(x - DC.C0[0], y - DC.C0[1], BLOOM_FLOWER_MARGIN) + 0.05, kind: guard % 3 });
    }
    r = mulberry32(909);
    for (let i = 0; i < 8; i++) {
      const x = 560 + r() * 900;
      const y = 420 + r() * 480;
      DAY_PETALS.push({ x, y, t0: invRB(x - DC.C0[0], y - DC.C0[1]), vx: -(14 + r() * 14), vy: -(8 + r() * 14), amp: 8 + r() * 14, per: 3 + r() * 3, ph: r() * TAU, s: 8 + r() * 5, rot: r() * TAU, spin: (r() - 0.5) * 0.8, life: 5 + r() * 2, c: r() < 0.5 });
    }
    // 落蝶时每朵花放出 1 片花瓣，顺西风（向左上）漂，与蝶同向；花按距落点由近及远依次绽开
    const order = TWIG.FL.map((f, i) => ({ i, d: Math.hypot(f[0][0] - fx0, f[0][1] - fy0) })).sort((a, b) => a.d - b.d);
    TWIG.order = order.map((x) => x.i);
    r = mulberry32(1234);
    order.forEach((oo, k) => {
      const f = TWIG.FL[oo.i];
      DAY_LAND_PETALS.push({ x: f[0][0], y: f[0][1], t0: L + 0.05 + k * 0.09 + 0.2, vx: -(16 + r() * 12), vy: -(10 + r() * 12), amp: 5 + r() * 6, per: 2 + r() * 2, ph: r() * TAU, s: 6 + r() * 3, rot: r() * TAU, spin: (r() - 0.5) * 1.2, life: 1.9, c: r() < 0.5 });
    });
    DAY_TRAIL = (() => {
      const rr = mulberry32(7);
      const n = 36;
      const out: typeof DAY_TRAIL = [];
      for (let k = 0; k < n; k++) { const q = (k + 0.15 + rr() * 0.7) / n; out.push({ q, p: pathAt(DAY_PATH, q).p, dx: (rr() - 0.5) * 10, dy: (rr() - 0.5) * 10, rad: 1.2 + rr() * 1.8, op: 0.5 + 0.4 * q }); }
      return out;
    })();
    // 样稿 s0 的 30 粒落雪（rng 71 的同一序列）：终帧与样稿逐点一致
    const rs = ((seed: number) => { let q = seed; return () => { q = (q * 16807) % 2147483647; return (q - 1) / 2147483646; }; })(71);
    const rd = mulberry32(2718);
    for (let i = 0; i < 30; i++) {
      let sz = 3 + rs() * 4.2;
      const big = i % 7 === 0;
      if (big) sz = 7 + rs() * 3;
      const left = rs() * 1600;
      const top = rs() * 1000;
      const op = 0.75 + rs() * 0.25;
      DAY_SNOWD.push({ left, top, s: sz, op, big, vy: 5 + rd() * 5, vx: 2 + rd() * 3, amp: 4 + rd() * 6, per: 5 + rd() * 5, ph: rd() * TAU });
    }
  }

  const ready = (async () => {
    const imgDone = (im: HTMLImageElement) => new Promise<void>((res) => { if (im.complete && im.naturalWidth) res(); else { im.onload = () => res(); im.onerror = () => res(); } });
    const loads: Promise<unknown>[] = [
      imgDone(el.art), imgDone(el.bk),
      loadImg(P('day-strip.webp')),
      flowerSprite('fl', 96).then((c) => { SPR.fl = c; }),
      flowerSprite('fl2', 96).then((c) => { SPR.fl2 = c; }),
      flowerSprite('fl3', 96).then((c) => { SPR.fl3 = c; }),
      Promise.all([document.fonts.load('500 20px "Cinzel"', 'ALIGHT'), document.fonts.load('600 40px "Noto Serif SC"', '栖枝遐蝶的'), document.fonts.load('700 40px "Noto Serif SC"', '栖枝')]).catch(() => undefined),
    ];
    await Promise.all(loads);
    await document.fonts.ready;
    if (!el.art.naturalWidth) throw new Error('boot: day splash failed to load');
    initDay();
    // 样稿 s0 的散花（花海条上方）与落雪点
    const SC0: Array<[number, number, number, number, string, number?]> = [[48, 168, 54, 12, 'fl', 1.4], [118, 150, 30, 40, 'fl2'], [178, 176, 22, 5, 'fl3'], [252, 160, 16, 18, 'fl'], [20, 120, 26, 60, 'fl3'], [88, 112, 14, 30, 'fl'], [304, 176, 11, 0, 'fl2'],
      [1330, 158, 20, 22, 'fl2'], [1388, 172, 46, 0, 'fl', 1.6], [1470, 150, 28, 30, 'fl'], [1548, 168, 62, 20, 'fl', 2.4], [1528, 112, 18, 46, 'fl3'], [1428, 124, 13, 10, 'fl2']];
    el.scat.innerHTML = SC0.map((it) => { const [x, y, s, rot, k, bl] = it; return `<g${bl ? ` style="filter:blur(${bl}px)"` : ''}><ellipse cx="${f1(x + s * 0.06)}" cy="${f1(y + s * 0.4)}" rx="${f1(s * 0.46)}" ry="${f1(s * 0.16)}" fill="rgba(110,84,168,.13)"/><use href="#${K}${k}" x="${f1(x - s / 2)}" y="${f1(y - s / 2)}" width="${s}" height="${s}" transform="rotate(${rot} ${f1(x)} ${f1(y)})"/></g>`; }).join('');
    el.snow.innerHTML = DAY_SNOWD.map((d) => `<i style="left:${d.left.toFixed(0)}px;top:${d.top.toFixed(0)}px;width:${d.s.toFixed(1)}px;height:${d.s.toFixed(1)}px;${d.big ? 'filter:blur(.8px);' : ''}"></i>`).join('');
  })();

  /* ───────── 画布与布局 ───────── */
  /** 底板的烘焙位图（plateBake.ts）：绽开结束（2.7 s）后底板是静止的，转场里每份拷贝都用它；尺寸一变就作废.
      0.1.4：prepare() 在开屏起跳后的空闲里用预解码的 ImageBitmap 烘好（终值 bk 不透明度 0.3），不再在 2.75 s 现烘（主线程同步解码 splash 图，实测 49–75 ms 的整体冻结）；
      转场起步时位图没备好、或被打断得早（bk 此刻的不透明度不是终值）就按此刻现烘（0.1.3 的行为）. */
  let baked: HTMLCanvasElement | null = null;
  let bakedOp = -1;
  /** 底板位图的渲染像素比：底板除了顶沿 9 px 的菱形与三角纹，全是低频的渐变 / 模糊，按 CSS 像素烘（比按设备像素烘少 56% 的像素与显存、转场里每份拷贝的带宽），合成器放大时是平滑的. */
  const BAKE_R = 1;
  const BK_FINAL = 0.3;
  const bkOpNow = () => parseFloat(el.bk.style.opacity || '0');
  function bakeNow(): HTMLCanvasElement {
    const op = bkOpNow();
    baked = bakePlate({ k, W, H, R: BAKE_R, wExt: Math.max(1600, W / k), bk: el.bk, bkW: el.bk.naturalWidth, bkH: el.bk.naturalHeight, bkOpacity: op, fill: false });
    bakedOp = op;
    return baked;
  }
  /** 转场起步要底板位图：预烘好的（bk 不透明度与此刻一致）直接用，否则现烘. */
  function getBake(): HTMLCanvasElement { return baked && Math.abs(bakedOp - bkOpNow()) < 0.0015 ? baked : bakeNow(); }
  let W = 0;
  let H = 0;
  let R = 1;
  let k = 1;      // 舞台缩放：按高适配，左上对齐；更宽的窗口在右侧留出背景

  function resize(w: number, h: number, dpr: number) {
    baked = null;
    bakedOp = -1;
    invalidateFast();                    // 尺寸变了：画布 / 位图作废（回到 DOM 路径），之后在空闲重烘
    W = w;
    H = h;
    dprIn = dpr || 1;
    R = o.capture ? 1 : Math.min(dpr || 1, BOOT_MAX_DPR, 2560 / w);
    fx.width = Math.max(2, Math.round(W * R));
    fx.height = Math.max(2, Math.round(H * R));
    k = H / 1000;
    const tf = `scale(${k})`;
    for (const n of [el.dstage, el.dtext, el.bfwrap, el.stack]) n.style.transform = tf;
    const ext = W / k;
    // 窗口比 16:10 更宽时，凡是带蒙版或要铺满的层都跟着加宽（蒙版是按元素盒子算的：盒子只有 1600 宽，右边就会出一条竖着的硬边）
    const wExt = `${Math.max(1600, ext)}px`;
    for (const n of [el.bgd, el.pf, el.dtext, el.bloom, el.near1, el.pre]) n.style.width = wExt;
    // 窗口比 16:10 更宽时，花海条在舞台右缘之外淡出（不镜像、不硬切）
    const m = ext > 1600 ? 'linear-gradient(90deg, #000 0, #000 1380px, transparent 1640px)' : 'none';
    el.near1.style.setProperty('mask-image', m);
    el.pre.style.setProperty('mask-image', m);
    scheduleTwig();
    if (prepareWanted) restartPrepare(150);
  }

  /* ───────── 0.1.4 · 绽开段的快路径（实时播放；地址里 ?bloomcv=1 在导出里也开，对拍用）─────────
     0.1.3 的昼开屏 [0, 2.7 s] 达不到 120 fps 的原因是 GPU 吃满，不是主线程：每拍写 `.bd-bloom` 的 mask-image（径向蒙版并集）让整屏三层（近景条 / 立绘 / 近景散花）重新光栅，
     加上三条花海条各一个 filter + 遮罩渲染面、img.bk 的 blur(60px) 渲染面、三道光束每拍改 left / 渐变 α 重光栅 1900 px 高的旋转层。实测只去掉蒙版约 99 次/秒，只去掉花海条 / 光晕 / 光束约 81 次/秒，两组都去才到 120。
     这里五件事一起做：
     ① 绽开画布 canvas.bd-bloomcv（放在 .bd-bloom 里，盖住三个子层）：每拍把三个预烘位图画上去，再 destination-in 一张 1/4 分辨率的蒙版画布（bloomLayers 的每层一个径向渐变，source-over 并集 = CSS 的 mask-composite: add），
        只清 / 画蒙版并集的包围盒；.bd-bloom 的 mask-image 保持 none，三个 DOM 子层 visibility:hidden。T_FREE（= 撤蒙版的时刻 2.7 s）前 0.25 s 子层先 visible + opacity .001 栅格好，T_FREE 同一个任务里换手；
     ② 三条花海条（.bd-pre / .bd-near1 里的 .pstrip）烘成位图（canvas.bd-stripcv 取代 .pstrip）；③ 近景散花 svg.s0-fl 同理；④ img.bk 烘成半分辨率位图（canvas.bkb）；
     ⑤ 光束：固定渐变 + will-change，每拍只写 transform / opacity（dayBloom.ts 的 beamFrame）。
     位图没备好 / 被打断 / 尺寸变了的时候，整套回到 0.1.3 的 DOM 路径（画面一致）. */
  /** 文字段 will-change 提升的开关（步骤 5）；测量用 ?textwc=0 关掉对照. */
  const TEXT_PROMOTE = !(typeof location !== 'undefined' && /[?&]textwc=0\b/.test(location.search));
  const fastWanted = (): boolean => bootImpl() === 'comp' && (!o.capture || (typeof location !== 'undefined' && /[?&]bloomcv\b/.test(location.search)));
  const subs = [el.near1, el.art, el.near2];
  const PRE_RASTER = 0.25;
  interface Bmp { cv: HTMLCanvasElement; s: number }
  interface BloomCv { cv: HTMLCanvasElement; g: CanvasRenderingContext2D; mk: HTMLCanvasElement; mg: CanvasRenderingContext2D; S: number; mq: number; art: Bmp; strip: Bmp; fl: Bmp; box: { x: number; y: number; w: number; h: number } | null; grid: TileGrid }
  let dprIn = 1;
  let fgen = 0;                          // 烘焙代数：resize / dispose 时 ++，进行中的烘焙作废
  let prepareWanted = false;
  let prepTimer = 0;
  let fastOn = false;                    // 快路径的光束 / 光晕 / 文字提升已启用（prepare 之后）
  let beamsFast = false;                 // 光束走 transform / opacity
  let bcv: BloomCv | null = null;        // 绽开画布与它的素材；null = DOM 路径
  let bcvOn = false;                     // 画布此刻是显示的（子层已隐藏）
  let bcvPre = false;                    // 已进入交班前 PRE_RASTER 的预栅格
  let domSettled = false;                // 被打断 / 已交班（实时）：本次开屏不再回画布
  let relaxedGov = false;
  let lateBake = false;                  // prepare 失败：绽开一结束退回 0.1.3 的现烘
  /* 视频版（docs/BOOT-VIDEO.md）：环境层（底板 / 光晕 / 光束 / 花海条 / 枝 / 绽开期的立绘）由 <video> 顶着；实时只画文字、光尘、蝶、雪点、叠在立绘上方的 fx（B 类），
     以及 2.7 s 起叠在视频之上的清晰立绘层（DAY_VID）. begin() 之后 vidOn = true；预光栅 / 交接 / 打断（settle）/ 退路之后为假. */
  let vidOn = false;
  let vidPre = false;                    // 已预光栅：被视频顶着的几层可见、opacity .001，叠在视频之上
  let vidMedia = -1;                     // 视频最近一次已呈现帧的媒体时间（videoRun 的 rVFC 里 note 进来；-1 = 还没有）
  let ovOn = false;                      // 清晰立绘层已提前栅格（host.is-ov）
  let twLiveInit = false;                // 视频期间枝的初始态已写（renderLive 第一拍）
  let fadeAnims: Animation[] = [];       // 交接淡入的 WAAPI 动画
  let layersBg = false;                  // 导出（layers:'bg' | 'vid'，视频母版用）：不画光尘、文字层隐藏
  let vidMaster = false;                 // 导出（layers:'vid'）：视频母版——蝶 / 雪点不画，fx 只画 A 类，T ≥ ovTo 不画立绘 / 近景散花
  let gone = false;
  let freeTimer = 0;
  /** 文字段 will-change：4.9 s 起提层，每个元素在自己的动画收完时撤（时刻同 renderDom 里各自的 win()；署名 0.6–1.2 s 就淡完了，不提）. */
  const WC_FROM = 4.9;
  let wcEls: Array<{ n: HTMLElement; end: number; on: boolean }> | undefined;
  const WC_END = (): Array<[HTMLElement, number]> => [
    [el.ch[0], L + 1.4], [el.ch[1], L + 1.58], [el.enSpan, L + 1.75], ...el.enLines.map((n): [HTMLElement, number] => [n, L + 1.45]), [el.banner, L + 1.7],
    ...el.epiLines.map((n): [HTMLElement, number] => [n, L + 1.95]), [el.epiSpan, T_END], [el.ver, L + 1.4], [el.enter, L + 2.2], [el.ln, T_END], [el.skip, L + 1.6],
  ];
  let pastBloom = false;                 // 实时播放已经过了 T_FREE：之后（比如尺寸变了重烘）不再造绽开画布
  const BK_STEPS = 76;
  let bkLast = '';                       // 光晕不透明度上一次写进去的字符串（没变就不写）
  const stripDom: HTMLCanvasElement[] = [];
  let flDom: HTMLCanvasElement | null = null;
  let bkb: { cv: HTMLElement; url?: string } | null = null;
  const fastInfo: Record<string, unknown> = { bloom: false, strips: false, flowers: false, bk: false, plate: false, decode: '', ms: 0 };
  try { (globalThis as unknown as { __alightDayFast?: unknown }).__alightDayFast = fastInfo; } catch { /* 不是浏览器 */ }
  /** 消融开关（测量用）：globalThis.__alightFastOff 或地址里 ?fastoff=bloom,strips,fl,bk,plate,beams,wc,hold,bkcanvas 关掉快路径的某几件，其余照常（bkcanvas = 光晕改回 <canvas> 挂载，复现 Present 停顿用；tiles = 绽开画布不用脏块；bkq = 光晕不透明度不量化）. */
  const fastOff = (() => {
    const set = new Set<string>();
    try {
      const g = (globalThis as unknown as { __alightFastOff?: string }).__alightFastOff;
      const m = /[?&]fastoff=([\w,]+)/.exec(typeof location !== 'undefined' ? location.search : '');
      for (const part of `${g ?? ''},${m ? m[1] : ''}`.split(',')) if (part) set.add(part);
    } catch { /* 默认全开 */ }
    return set;
  })();
  const mark = (name: string) => { (fastInfo.marks as Record<string, number>)[name] = +performance.now().toFixed(1); };
  fastInfo.marks = {};
  /** 绽开画布的像素密度（每舞台单位多少像素）= 舞台缩放 × 像素比（不受 BOOT_MAX_DPR 限制，上限 2560 宽）；?bloomdn=1.12 可调（测量用）. */
  const bloomDn = (): number => {
    let f = 1;
    try { const m = /[?&]bloomdn=([\d.]+)/.exec(location.search); if (m) f = Math.min(1.5, Math.max(0.5, Number(m[1]) || 1)); } catch { /* 默认 1 */ }
    return Math.min(dprIn, 2560 / Math.max(1, W)) * f;
  };

  /** 作废快路径的一切（resize / dispose）：画布与位图丢掉，子层、光晕、花海条回到 DOM 的样子. */
  function invalidateFast() {
    fgen++;
    window.clearTimeout(prepTimer);
    window.clearTimeout(freeTimer);
    restoreSubs();
    if (bcvOn && !o.capture && !fastOff.has('hold')) bootGovernor.setHold(true);        // 画布作废、回到 DOM 蒙版路径：节拍回到旧的 60 次/秒，直到新画布备好 / 绽开结束
    bcv?.cv.remove();
    bcv = null; bcvOn = false; bcvPre = false;
    for (const c of stripDom) c.remove();
    stripDom.length = 0;
    flDom?.remove(); flDom = null;
    bkb?.cv.remove(); if (bkb?.url) URL.revokeObjectURL(bkb.url); bkb = null;
    el.bk.style.display = '';
    for (const p of qa(host, '.pstrip.is-baked')) p.classList.remove('is-baked');
    el.scat.classList.remove('is-baked');
    fastInfo.bloom = fastInfo.strips = fastInfo.flowers = fastInfo.bk = fastInfo.plate = false;
  }
  function restoreSubs() { for (const n of subs) { n.style.visibility = ''; n.style.opacity = ''; } }

  /** 画布模式 → DOM：同一个任务里先把子层还成可见、不透明（蒙版字符串由调用方写），再隐藏画布——绝不先 cancel 再写（会闪一帧空白）. */
  function toDom() {
    restoreSubs();
    if (bcv) bcv.cv.style.visibility = 'hidden';
    bcvOn = false; bcvPre = false;
  }

  function handoff() {
    toDom();
    if (!o.capture) {
      // 绽开画布与预烘位图 0.5 s 后释放（交班后显存不涨）；导出模式可能往回 seek，不释放
      window.clearTimeout(freeTimer);
      freeTimer = window.setTimeout(() => { if (!bcvOn) { bcv?.cv.remove(); bcv = null; } }, 500);
      if (!relaxedGov) { relaxedGov = true; bootGovernor.relaxOnce(performance.now()); }
    }
  }

  /* ───────── 视频版：接管 / 预光栅 / 交接 / 打断 ───────── */
  /** 交接 / 打断时才露出的、此前由视频顶着的 DOM 层（立绘、近景散花、蝶、雪点一直是实时的，不在其中）. */
  const beamsWrap = q1(host, '.bd-beams');
  const twigSvg = q1(host, '.s0-twig');
  const vidLayers = (): HTMLElement[] => [el.ph, beamsWrap, el.near1];      // 枝（twig / twc）不在其中：它全程实时，叠在视频之上
  /** 镜头：舞台 / 蝶随 z 缩放（与 renderStage 同式）. */
  const camZ = (t: number) => 1 + 0.12 * (1 - E.camera(win(t, 0, DT.cam)));
  function setZ(n: HTMLElement, zz: number) { n.style.transformOrigin = `${DC.A[0]}px ${DC.A[1]}px`; n.style.transform = zz === 1 ? 'none' : `scale(${zz.toFixed(5)})`; }
  /** 雪点（样稿 s0 的 30 粒；终帧在样稿位置，之前按 (t−T_END) 倒推，T_END 后继续缓落）. */
  function renderSnow(t: number) {
    const ramp = E.ease(win(t, 2.4, 4.0));
    // 预热：雪点是 30 个 will-change 的合成层，opacity 从 0 起的那一拍才第一次栅格——实测在 2.4 s 前后撞出一次 29–37 ms 的呈现停顿（与蝶第一次出现的栅格叠在一起，单关哪一个都不消失，两个一起关才没有），
    // 而 2.4 s 正是枝尖最快的时候（≈ 450 px/s，一次停顿 = 一步跳 13 px）。BF_WARM_FROM 起先以 α .004（< 1 个色阶，看不出）画一遍，把栅格摊到枝还没进画面的安静时段；导出（capture）不预热，逐帧确定.
    const warm = !o.capture && ramp <= 0 && t >= BF_WARM_FROM ? '0.004' : '';
    const dt = t - T_END;
    const kids = el.snow.children;
    DAY_SNOWD.forEach((d, i) => {
      const n = kids[i] as HTMLElement | undefined;
      if (!n) return;
      const yy = ((((d.top + d.vy * dt + 20) % 1040) + 1040) % 1040) - 20;
      const xx = d.left + d.vx * dt + d.amp * (Math.sin((TAU * dt) / d.per + d.ph) - Math.sin(d.ph));
      n.style.transform = `translate(${(xx - d.left).toFixed(1)}px, ${(yy - d.top).toFixed(1)}px)`;
      n.style.opacity = warm || (d.op * ramp).toFixed(3);
    });
  }
  /** 蝶第一次出现前的预热帧：BF_WARM_FROM 起以 α .004 在出生点画一遍（见 renderLive 的注释）；导出不预热. */
  const bfWarm = (t: number): DayBf | null => bfDay(t) ?? (!o.capture && t >= BF_WARM_FROM ? ((w) => (w ? { ...w, alpha: 0.004 } : null))(bfDay(DT.dot[0] + 0.001)) : null);
  /** 清晰立绘层提前栅格的时刻（测量台可用 globalThis.__alightOvPre 改，消融用；默认 DAY_VID.ovPre）. */
  const ovPreAt = (): number => { const v = (globalThis as unknown as { __alightOvPre?: number }).__alightOvPre; return typeof v === 'number' ? v : DAY_VID.ovPre; };
  /** 视频期间每拍：文字 + 光尘 + 蝶 / 雪点 / B 类 fx + 清晰立绘层的镜头（环境层都在视频里）. */
  function renderLive(t: number) {
    renderDom(t);
    const z = camZ(t);
    // 枝（含白花 / 落蝶光晕）全程实时：母版里没有它。镜头与母版同一个 t（t = 视频已呈现帧的媒体时间 + 到上屏时刻的外推，MediaClock.at）；1.2 s 前枝不在画面里，只在第一拍把初始态写好（白花缩到 0 等）
    if (!twLiveInit) { twLiveInit = true; renderTwig(0); }
    if (t >= TWIG_LIVE_FROM || t >= ovPreAt()) setZ(el.world, z);
    if (t >= TWIG_LIVE_FROM) renderTwig(t);
    if (t >= ovPreAt()) {
      if (!ovOn) { ovOn = true; host.classList.add('is-ov'); el.bloom.style.setProperty('mask-image', 'none'); el.bloom.style.opacity = '0.001'; }
      setZ(el.near2, (1 + 1.5 * (z - 1)) / z);
      // 淡入的进度跟着「视频已呈现帧」的媒体时间走（不是外推后的场景时间）：视频母版里立绘组的 α 重映射（masterOvRemap）按帧的 t 算，两边同一个 q，羽化带才不会错位
      const p = win(vidMedia >= 0 ? Math.min(t, vidMedia) : t, DAY_VID.ovFrom, DAY_VID.ovTo);
      el.bloom.style.opacity = p >= 1 ? '' : (p <= 0 ? '0.001' : Math.max(0.001, E.ease(p)).toFixed(3));
    }
    setZ(el.bfzoom, z);
    // 蝶 2.2 s 才第一次出现，那一拍要栅格整个 SVG（symbol / 渐变 / 滤镜），实测在 2.4 s 前后撞出一次 35–55 ms 的呈现停顿：1.6 s 起先以 α .004（约 1 个色阶）在出生点画一遍，把栅格摊到安静的 1.6–2.2 s
    placeBf(bfWarm(t));
    if (t >= BF_WARM_FROM) renderSnow(t);
    renderFx(t, z, 'live');
  }
  function cancelFade() {
    if (!fadeAnims.length) return;
    for (const n of vidLayers()) n.style.opacity = '';
    for (const a of fadeAnims) a.cancel();
    fadeAnims = [];
  }
  function vidBegin() {
    if (vidOn || o.capture) return;
    vidOn = true;
    vidPre = false;
    try { void el.art.decode().catch(() => undefined); } catch { /* 老内核没有 decode() */ }       // 立绘解码放到后台线程（2.3 s 起要栅格它，别到那时才在栅格线程上解码）
    host.classList.add('is-vid');         // 底板 / 光束 / 花海条 / 枝 visibility:hidden（boot.css）：不栅格、不再每拍写样式；立绘层等 2.3 s 起（is-ov）
    el.bloom.style.setProperty('mask-image', 'none');
  }
  /** 媒体时间 ≥ 7.15 s：把 DOM 环境层写成 T_END 的最终态，让它们可见、opacity .001（叠在视频之上，不会被当作遮挡），提前栅格好. 立绘 / 近景散花 / 蝶 / 雪点早就是实时的，不在其中. */
  function vidPreraster() {
    if (!vidOn || vidPre) return;
    vidPre = true;
    host.classList.remove('is-vid');
    for (const n of vidLayers()) n.style.opacity = '0.001';
    renderStage(T_END);
  }
  /** 抵达最后一帧：同一个任务里补一次 render(T_END)（7.15 之后的微动），环境层的 opacity 用同一条时间线从 .001 升到 1；finished 之后 resolve. 之后场景回到普通模式. */
  function vidHandoff(fadeMs: number): Promise<void> {
    if (!vidOn) return Promise.resolve();
    vidPreraster();                        // 没预光栅过（rVFC 少了几次回调）就在这里补，同一个任务里直接交接
    vidOn = false;
    const ls = vidLayers();
    const fade = fadeMs > 0 && typeof ls[0].animate === 'function';
    const z = renderStage(T_END);
    renderFx(T_END, z);
    renderDom(T_END);
    if (!fade) { for (const n of ls) n.style.opacity = ''; return Promise.resolve(); }
    const anims = ls.map((n) => n.animate([{ opacity: 0.001 }, { opacity: 1 }], { duration: fadeMs, easing: 'linear', fill: 'forwards' }));
    fadeAnims = anims;
    const done = () => { if (fadeAnims === anims) cancelFade(); };
    return Promise.all(anims.map((a) => a.finished)).then(done, done);
  }
  /** 被打断 / 退路（视频期间离开开屏）：render(t) 写完整 DOM 帧（含枝、光束、花海条），环境层可见并 opacity .001，等 2 个 rAF 让它们栅格，之后 opacity 直接设 1（不做淡入，转场的运动会遮住差异）；
      A 类 fx（雾 / 荆棘脉冲 / 圆边雾圈 / 点花，只在 < 2.7 s）也等这一刻才画（视频帧里已经有它们，现在画会叠两层）. 调用方等它 resolve 再撤视频、起转场. t < 2.7 s 时立绘 / 近景散花也从这里起走蒙版字符串的慢路径. */
  function vidSettle(t: number): Promise<void> {
    vidOn = false;
    vidPre = false;
    ovOn = false;
    host.classList.remove('is-vid', 'is-ov');
    el.bloom.style.opacity = '';
    for (const n of vidLayers()) n.style.opacity = '0.001';
    const z = renderStage(t);
    renderFx(t, z, 'live');
    renderDom(t);
    return new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => {
      if (gone) { res(); return; }
      for (const n of vidLayers()) n.style.opacity = '';
      renderFx(t, z);
      // 栅格要等到合成器真的缓过来：这几层（底板 / 光晕 / 花海条 / 光束 / 枝，合计约 10 MP）在集显被别的 3D 负载占着时 2 个 rAF 不够，转场一起步就停 80–125 ms（实测 day-fast，旁边有 3D 负载）。
      // 再等到连续两个 rAF 间隔都 ≤ QUIET_DT（最多 SETTLE_MAX_MS）才放行——安静时多等 2 帧（≈ 12 ms），忙的时候把这一顿挪到转场开始之前（视频还停在最后一帧，不是转场里的卡）
      let last = performance.now();
      let calm = 0;
      const t0 = last;
      const step = (now: number) => {
        if (gone) { res(); return; }
        calm = now - last <= SETTLE_QUIET_DT ? calm + 1 : 0;
        last = now;
        if (calm >= 2 || now - t0 >= SETTLE_MAX_MS) { res(); return; }
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    })));
  }

  /** 被打断 / 离开开屏：把画布模式的东西在同一个任务里换回 t 时刻 DOM 路径的样子（蒙版字符串、子层可见）。
      返回 Promise = 刚变可见的子层还要等 2 个 rAF 栅格（合成器的 pending tree 在瓦片就绪前不激活，不会闪空白），调用方等它再起转场；不用等 = undefined. */
  function settle(t: number): Promise<void> | undefined {
    if (!o.capture) { domSettled = true; fgen++; window.clearTimeout(prepTimer); bootGovernor.setHold(false); }      // 还在烘的作废；本次开屏不再回画布
    if (vidOn) return vidSettle(t);
    if (fadeAnims.length) cancelFade();                // 交接的淡入还没跑完就被打断：DOM 层早已栅格好，直接定在不透明
    if (!bcv && !bcvOn) return undefined;
    const needWait = bcvOn && !bcvPre;
    el.bloom.style.setProperty('mask-image', bloomMaskCss(t));
    toDom();
    if (!o.capture) {
      domSettled = true;
      window.clearTimeout(freeTimer);
      freeTimer = window.setTimeout(() => { bcv?.cv.remove(); bcv = null; }, 500);
    }
    return needWait ? new Promise<void>((res) => requestAnimationFrame(() => requestAnimationFrame(() => res()))) : undefined;
  }

  /** 画一拍绽开画布：蒙版并集的包围盒 ∩ 画布内清 / 画——near1（花海条）→ 立绘 → near2（散花），再 destination-in 蒙版。
      1.5 s 起（TILE_FROM）改成「脏块」重绘（bloomTiles.ts）：实心核与空白两拍都不变，不重画——像素与整包围盒重绘逐位相同（微基准比对：差 ≤ 1 个预乘级），填充量少 55–80%. */
  function drawBloomCanvas(b: BloomCv, t: number, z: number) {
    const layers = bloomLayers(t);
    const bx = bloomBox(layers);
    const { g, S, mq } = b;
    const cw = b.cv.width;
    const ch = b.cv.height;
    // 蒙版画布（1/4 分辨率）：每层一个径向渐变，source-over（并集 1 − Π(1 − αi)，与 CSS 的 mask-composite: add 同式）
    const m = b.mg;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.globalCompositeOperation = 'source-over';
    m.clearRect(0, 0, b.mk.width, b.mk.height);
    for (const l of layers) {
      if (l.a <= 0.0004) continue;
      const r1 = Math.max(1, l.rx);
      const r2 = Math.max(1, l.ry);
      const r0 = Math.max(0, l.rx - l.f) / r1;
      const a = l.a.toFixed(3);
      m.save();
      m.translate(l.cx * mq, l.cy * mq);
      m.scale(1, r2 / r1);
      const gr = m.createRadialGradient(0, 0, 0, 0, 0, r1 * mq);
      gr.addColorStop(0, `rgba(0,0,0,${a})`);
      gr.addColorStop(Math.min(1, r0), `rgba(0,0,0,${a})`);
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      m.fillStyle = gr;
      m.fillRect(-r1 * mq, -r1 * mq, 2 * r1 * mq, 2 * r1 * mq);
      m.restore();
    }
    const [ax, ay] = DC.A;
    const zf = 1 + 1.5 * (z - 1);
    const zn = zf / z;
    // 近景条 / 近景散花：以 A 为原点放大 zf / z（与 DOM 的 setZ(near, zf / z) 同式）
    // 位图画布的尺寸是向上取整的（多出不到 1 px 的空边）：整张拿来拉伸会让内容整体错位最多 1 px，所以只取内容的那一块（源矩形 = 单位 × 密度，可以是小数）
    const near = (bm: Bmp, x: number, y: number, w: number, h: number) => {
      g.save();
      g.translate(ax, ay);
      g.scale(zn, zn);
      g.translate(-ax, -ay);
      g.drawImage(bm.cv, 0, 0, w * bm.s, h * bm.s, x, y, w, h);
      g.restore();
    };
    /** 在当前裁剪区里画一遍：近景条 → 立绘 → 近景散花，再 destination-in 蒙版画布里对应的那一块（rx, ry, rw, rh：画布像素，4 的倍数）. */
    const paint = (rx: number, ry: number, rw: number, rh: number) => {
      g.setTransform(S, 0, 0, S, 0, 0);
      near(b.strip, 0, 790, 1600, 210);
      g.drawImage(b.art.cv, 0, 0, 1280 * b.art.s, 1280 * b.art.s, 470, -62, 1280, 1280);
      near(b.fl, -FL_PAD, 1000 - 190 - FL_PAD, 1600 + 2 * FL_PAD, 190 + 2 * FL_PAD);
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'destination-in';
      g.imageSmoothingEnabled = true;
      g.drawImage(b.mk, rx / 4, ry / 4, rw / 4, rh / 4, rx, ry, rw, rh);
    };
    // 脏块的状态每拍都分类（切到分块模式时 grid.prev 必须是上一拍画布上真实的状态）
    const tiled = !o.capture && !fastOff.has('tiles') && t >= TILE_FROM;
    if (!o.capture && !fastOff.has('tiles')) classifyTiles(b.grid, layers.filter((l) => l.a > 0.0004), S);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    if (tiled) {
      for (const r of dirtyRects(b.grid, nearRowOf(S, ay, zn), cw, ch)) {
        g.save();
        g.beginPath();
        g.rect(r.x, r.y, r.w, r.h);
        g.clip();
        g.clearRect(r.x, r.y, r.w, r.h);
        paint(r.x, r.y, r.w, r.h);
        g.restore();
      }
      b.box = null;
      return;
    }
    if (!o.capture && !fastOff.has('tiles')) b.grid.prev.set(b.grid.cur);
    // 包围盒（画布像素，对齐到蒙版画布的 4 px 格）
    let box: { x: number; y: number; w: number; h: number } | null = null;
    if (bx) {
      const x0 = Math.max(0, Math.floor((bx.x0 * S) / 4 - 1)) * 4;
      const y0 = Math.max(0, Math.floor((bx.y0 * S) / 4 - 1)) * 4;
      const x1 = Math.min(Math.ceil(cw / 4) * 4, Math.ceil((bx.x1 * S) / 4 + 1) * 4);
      const y1 = Math.min(Math.ceil(ch / 4) * 4, Math.ceil((bx.y1 * S) / 4 + 1) * 4);
      if (x1 > x0 && y1 > y0) box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const pv = b.box;
    if (pv || box) {
      const ux = Math.min(pv ? pv.x : Infinity, box ? box.x : Infinity);
      const uy = Math.min(pv ? pv.y : Infinity, box ? box.y : Infinity);
      const ux1 = Math.max(pv ? pv.x + pv.w : 0, box ? box.x + box.w : 0);
      const uy1 = Math.max(pv ? pv.y + pv.h : 0, box ? box.y + box.h : 0);
      g.clearRect(ux, uy, ux1 - ux, uy1 - uy);
    }
    b.box = box;
    if (!box) return;
    g.save();
    g.beginPath();
    g.rect(box.x, box.y, box.w, box.h);
    g.clip();
    paint(box.x, box.y, box.w, box.h);
    g.restore();
  }

  /** 绽开：画布路径 / DOM 路径二选一（renderStage 每拍调）. */
  function renderBloom(t: number, z: number) {
    if (bloomOpen(t)) {
      pastBloom = true;
      if (bootGovernor.holding) bootGovernor.setHold(false);
      if (bcvOn || bcvPre) handoff();
      if (lateBake && !baked) { lateBake = false; window.setTimeout(() => { if (!baked) bakeNow(); }, 0); }
      el.bloom.style.setProperty('mask-image', 'none');
      el.bloom.style.visibility = 'visible';
      return;
    }
    const b = bcv;
    if (b && !domSettled) {
      if (!bcvOn) {
        bootGovernor.setHold(false);                // 画布备好了：锁定的 120 从这一拍起生效（备好之前走 DOM 蒙版路径，GPU 只撑得住旧的 60 次/秒）
        bootGovernor.quietFor(400);                 // 第一次画 4 MP 的画布 / 子层隐藏：起步那几拍不算「这台机器画不动」
        b.cv.style.visibility = 'visible';
        for (const n of subs) n.style.visibility = 'hidden';
        el.bloom.style.setProperty('mask-image', 'none');
        bcvOn = true;
      }
      drawBloomCanvas(b, t, z);
      if (t >= T_FREE - PRE_RASTER && !bcvPre) {
        bcvPre = true;
        bootGovernor.quietFor(400);                 // 三个 DOM 子层第一次栅格
        for (const n of subs) { n.style.visibility = 'visible'; n.style.opacity = '0.001'; }
      }
      el.bloom.style.visibility = 'visible';
      return;
    }
    if (bcvOn) { toDom(); }
    el.bloom.style.setProperty('mask-image', bloomMaskCss(t));
    el.bloom.style.visibility = 'visible';
  }

  /* ───────── prepare：解码 + 烘焙（任务切成小片，不挡起跳）───────── */
  function restartPrepare(delay: number) {
    window.clearTimeout(prepTimer);
    prepTimer = window.setTimeout(() => { void runPrepare(); }, delay);
  }
  function prepare(): Promise<void> {
    prepareWanted = true;
    if (!fastWanted() || !W) return Promise.resolve();
    setupFast();
    return runPrepare();
  }
  /** 光束 / 光晕 / 文字提升这些不依赖位图的部分：prepare 一调用就启用（第一帧起生效）. */
  function setupFast() {
    if (fastOn) return;
    fastOn = true;
    if (vidOn) return;                     // 视频模式：文字提升照常（fastOn），但没有绽开画布可等（不锁 hold）、光束在视频里（不提升）
    // 画布备好之前蒙版仍走 DOM 路径（每拍整屏三层重光栅，GPU 只撑得住旧的 60 次/秒）：锁定的 120 等画布备好再生效，否则 GPU 被压满、prepare 自己的画布命令也排在后面（实测 1.7 s 的整体停顿）
    if (!o.capture && !fastOff.has('hold')) bootGovernor.setHold(true);
    if (fastOff.has('beams')) return;
    el.beams.forEach((b, i) => {
      const { left, w } = beamBase(i);
      b.style.width = `${w}px`;
      b.style.left = `${left.toFixed(1)}px`;
      b.style.top = `${BEAM_TOP}px`;
      b.style.background = 'linear-gradient(90deg, rgba(255,248,255,0), rgba(255,248,255,1) 50%, rgba(255,248,255,0))';
      b.style.willChange = 'transform, opacity';
      b.style.opacity = '0';
    });
    beamsFast = true;
  }
  async function runPrepare() {
    if (!fastWanted()) return;
    const gen = fgen;
    const t0 = performance.now();
    const alive = () => gen === fgen;
    /* 视频模式（docs/BOOT-VIDEO.md §3.4）：只做转场 / 交接用得上的——立绘解码、光晕位图（bkb）、底板预烘；不做绽开画布 / 花海条画布 / 散花画布（< 2.7 s 的打断走 DOM 慢路径）. */
    const vid = vidOn;
    try {
      await ready;
      if (!alive() || !W) return;
      await nextTask();
      if (!alive()) return;
      const S = k * bloomDn();
      const wExtU = Math.max(1600, W / k);
      const wide = wExtU > 1600;
      // 解码（后台线程）：splash 图（立绘 / 光晕 / 底板共用）与花海条图
      mark('start');
      const sp = await decodeImage(splash, el.art);
      if (!alive()) return;
      if (!sp) throw new Error('day: splash decode');
      fastInfo.decode = sp.how;
      const stUrl = P('day-strip.webp');
      let st: Awaited<ReturnType<typeof decodeImage>> = null;
      if (!vid) {
        const stImg = await loadImg(stUrl);
        st = await decodeImage(stUrl, stImg);
        if (!alive()) return;
        if (!st) throw new Error('day: strip decode');
      }
      mark('decoded');
      await nextTask();
      if (!alive()) return;
      if (!vid && st) {
        // ② 花海条
        const near = bakeStrip(st, 1600, wide, S * 1.18);
        const pre = wide ? bakeStrip(st, wExtU, true, S * 1.18) : near;
        await nextTask();
        if (!alive()) return;
        // ① 的素材：立绘
        const art = bakeArt(sp, S);
        await nextTask();
        if (!alive()) return;
        // ③ 近景散花
        const fl = await bakeFlowers(host, el.scat.innerHTML, K, S * 1.18);
        if (!alive()) return;
        if (!fl) throw new Error('day: flowers bake');
        mark('baked');
        await nextTask();
        if (!alive()) return;
        // 装上：DOM 里的花海条画布（取代 .pstrip）、散花画布、绽开画布
        if (!fastOff.has('strips')) { mountStrips(near, pre, wide); fastInfo.strips = true; }
        if (!fastOff.has('fl')) { mountFlowers(fl); fastInfo.flowers = true; }
        if (!fastOff.has('bloom') && !(pastBloom && !o.capture)) {
          const cvW = Math.max(2, Math.ceil(wExtU * S));
          const cvH = Math.max(2, Math.ceil(1000 * S));
          const cv = document.createElement('canvas');
          cv.className = 'bd-bloomcv';
          cv.setAttribute('aria-hidden', 'true');
          cv.width = cvW; cv.height = cvH;
          cv.style.cssText = `width:${cvW / S}px;height:${cvH / S}px;visibility:hidden`;       // CSS 尺寸 = 缓冲 / 密度：缓冲像素与舞台单位的换算恰是 S（向上取整多出的不到 1 px 不会把内容拉偏）
          const mkc = document.createElement('canvas');
          mkc.width = Math.ceil(cvW / 4) + 1; mkc.height = Math.ceil(cvH / 4) + 1;
          const g = cv.getContext('2d');
          const mg = mkc.getContext('2d');
          if (!g || !mg) throw new Error('day: bloom canvas');
          el.bloom.appendChild(cv);
          bcv = { cv, g, mk: mkc, mg, S, mq: S / 4, art, strip: near, fl, box: null, grid: makeGrid(cvW, cvH) };
          fastInfo.bloom = true;
        } else bootGovernor.setHold(false);
      }
      mark('mounted');
      await nextTask();
      if (!alive()) return;
      // ④ 光晕
      if (!fastOff.has('bk')) {
        const bk = bakeBk(sp, S);
        if (!alive()) return;
        await mountBk(bk, gen);
        if (!alive()) return;
        fastInfo.bk = true;
        await nextTask();
        if (!alive()) return;
      }
      mark('bk');
      // 底板（H1：不在 2.75 s 现烘）
      if (!fastOff.has('plate')) {
        const bt = performance.now();
        baked = bakePlate({ k, W, H, R: BAKE_R, wExt: wExtU, bk: sp.src, bkW: sp.w, bkH: sp.h, bkOpacity: BK_FINAL, fill: false });
        bakedOp = BK_FINAL;
        fastInfo.plate = true;
        fastInfo.plateMs = +(performance.now() - bt).toFixed(1);
      } else lateBake = !o.capture;
      mark('plate');
      fastInfo.ms = +(performance.now() - t0).toFixed(1);
      // 解码出来的位图（splash 16 MB / 花海条）用完即放，不等 GC
      for (const d of [sp, st]) { if (!d) continue; try { (d.src as ImageBitmap).close?.(); } catch { /* 不是 ImageBitmap */ } }
    } catch (e) {
      if (alive()) {
        fastInfo.error = String(e);
        lateBake = !o.capture;      // 位图没备好：那一项一直走旧路径；底板退回 0.1.3 的做法（绽开一结束就现烘一次，见 renderBloom）
      }
    }
  }
  function mountStrips(near: Bmp, pre: Bmp, wide: boolean) {
    const one = (host2: HTMLElement, bm: Bmp) => {
      const ps = host2.querySelector<HTMLElement>('.pstrip');
      if (!ps) return;
      const c = document.createElement('canvas');
      c.className = 'bd-stripcv';
      c.setAttribute('aria-hidden', 'true');
      c.width = bm.cv.width; c.height = bm.cv.height;
      c.style.width = `${bm.cv.width / bm.s}px`;
      c.style.height = `${bm.cv.height / bm.s}px`;
      c.style.top = '790px';                    // 内容顶对齐（位图向上取整多出的边在下面）：与 .pstrip（bottom: 0，高 210）同一个位置
      c.style.bottom = 'auto';
      c.getContext('2d')?.drawImage(bm.cv, 0, 0);
      ps.classList.add('is-baked');
      ps.after(c);
      stripDom.push(c);
      if (wide) host2.style.setProperty('mask-image', 'none');      // 横向遮罩已烘进位图
    };
    one(el.pre, pre);
    one(el.near1, near);
  }
  function mountFlowers(fl: Bmp) {
    const c = document.createElement('canvas');
    c.className = 'bd-flcv';
    c.setAttribute('aria-hidden', 'true');
    c.width = fl.cv.width; c.height = fl.cv.height;
    c.style.cssText = `left:${-FL_PAD}px;top:${1000 - 190 - FL_PAD}px;width:${fl.cv.width / fl.s}px;height:${fl.cv.height / fl.s}px`;
    c.getContext('2d')?.drawImage(fl.cv, 0, 0);
    el.scat.classList.add('is-baked');
    el.scat.after(c);
    flDom = c;
  }
  /** 光晕位图装进 .bd-bg（在 img.bk 原位）。用 <img>（PNG blob）而不是 <canvas>：实测挂一张 1460 × 1460 个舞台单位的 canvas 进被 overflow:hidden 裁着的 .bd-bg 里，离屏测量台里 1.8 s 处必有一次 ≈ 500 ms 的 Present 停顿（只烘不挂就没有；
      与画布的内容、不透明度、img.bk 隐不隐藏都无关）；同一张位图当 <img> 挂上去没有这个问题. 编码失败退回 canvas. */
  async function mountBk(bk: { cv: HTMLCanvasElement; s: number; x: number; y: number; w: number; h: number }, gen: number) {
    const css = `left:${bk.x}px;top:${bk.y}px;width:${bk.cv.width / bk.s}px;height:${bk.cv.height / bk.s}px;opacity:${el.bk.style.opacity || '0'}`;
    let node: HTMLElement = bk.cv;
    let url: string | undefined;
    if (!fastOff.has('bkcanvas')) {
      try {
        const blob = await new Promise<Blob | null>((res) => bk.cv.toBlob(res, 'image/png'));
        if (blob) {
          url = URL.createObjectURL(blob);
          const im = new Image();
          im.decoding = 'async';
          im.alt = '';
          im.draggable = false;
          im.src = url;
          await im.decode();
          node = im;
        }
      } catch { node = bk.cv; if (url) { URL.revokeObjectURL(url); url = undefined; } }
    }
    if (gen !== fgen) { if (url) URL.revokeObjectURL(url); return; }
    node.className = 'bkb';
    node.setAttribute('aria-hidden', 'true');
    node.style.cssText = css;
    el.bk.after(node);
    el.bk.style.display = 'none';
    bkb = { cv: node, url };
  }

  /* ───────── 蝶 ───────── */
  function bfDay(t: number): DayBf | null {
    if (t < DT.dot[0]) return null;
    const unfurl = E.ease(win(t, DT.unfurl[0], DT.unfurl[1]));
    const qf = E.flight(win(t, DT.fly[0], DT.fly[1]));
    const phase = t < DT.fly[0] ? TAU * 1.6 * t : TAU * (1.6 * DT.fly[0] + 2.5 * (t - DT.fly[0]));
    const flapFl = 0.71 + 0.29 * Math.cos(phase);
    const tl = DT.fly[1];
    let x: number;
    let y: number;
    let rot: number;
    let sc: number;
    let flap: number;
    let pose: number;
    if (t < tl) {
      const { p, d } = pathAt(DAY_PATH, qf);
      x = p[0];
      y = p[1];
      pose = sstep((qf - 0.8) / 0.2);                                  // 翅从平展渐渐收成「半举」
      const ang = Math.atan2(d[1], d[0]) + Math.PI / 2;
      rot = t < DT.fly[0] ? 0 : lerp(ang, REST_ROT, pose);
      sc = t < DT.fly[0] ? lerp(0.62, 0.75, unfurl) : 0.75 + 0.75 * Math.pow(qf, 0.9);
      if (t >= DT.fly[0]) {
        const nl = Math.hypot(d[0], d[1]) || 1;
        const f = 18 * Math.sin(Math.PI * qf) * Math.sin((TAU * (t - DT.fly[0])) / 0.9) * (1 - pose);
        x += (-d[1] / nl) * f;
        y += (d[0] / nl) * f;
      }
      flap = lerp(flapFl, 1, E.settle(win(t, tl - 0.3, tl))) * (t < DT.fly[0] ? unfurl : 1);
    } else {
      x = BODY_REST[0];
      y = BODY_REST[1];
      rot = REST_ROT;
      sc = REST_K;
      pose = 1;
      const tr = t - tl;
      let f: number;
      if (tr < 2.1) { const s = Math.sin(Math.PI * (tr / 0.7)); f = 1 - 0.45 * s * s; } else f = 0.9 + 0.1 * Math.cos((TAU * (tr - 2.1)) / 3.2);
      flap = f / 0.9 > 1 ? 1 : f / 0.9;      // 休止时翅形与样稿 bfly-land 一致（flap=1）；呼吸只取 0.9–1.0 的轻微起伏
    }
    return { x, y, rot, sc, flap, pose, alpha: t < DT.fly[0] ? unfurl : 1, flying: t >= DT.fly[0] && t < tl, qf };
  }
  function placeBf(b: DayBf | null) {
    if (!b) { el.bf.setAttribute('opacity', '0'); return; }
    const rd = (b.rot * 180) / Math.PI;
    el.bf.setAttribute('opacity', b.alpha.toFixed(3));
    el.bfi.setAttribute('transform', `translate(${b.x.toFixed(2)} ${b.y.toFixed(2)}) rotate(${rd.toFixed(2)}) scale(${b.sc.toFixed(3)})`);
    const p = b.pose;
    const fl = Math.max(0.04, b.flap);
    el.bwl.setAttribute('transform', `scale(-1 1) rotate(${(-12 * p).toFixed(2)}) scale(${(lerp(1, 0.92, p) * fl).toFixed(3)} 1)`);
    el.bwr.setAttribute('transform', `rotate(${(-52 * p).toFixed(2)}) scale(${fl.toFixed(3)} 1)`);
    el.bleg.setAttribute('opacity', (p * p).toFixed(3));
  }

  /* ───────── 渲染 ───────── */
  /** 枝条 + 落蝶光晕 + 枝上白花（renderStage 与视频期间的 renderLive 共用：视频母版里不再有枝，枝由实时层按媒体时钟画，见 docs/BOOT-VIDEO.md §12）. */
  function renderTwig(t: number) {
    const gp = twigProgress(t);
    twGp = gp;
    if (tw) drawTwig(gp);
    const cls = (i: number, p: number) => {
      const m = mks[i];
      if (p <= 0.0005) { m.style.visibility = 'hidden'; } else { m.style.visibility = 'visible'; m.setAttribute('stroke-dashoffset', (1 - p).toFixed(4)); }
    };
    if (!tw) {
      cls(0, gp);
      TWIG.subs.forEach((_, i) => cls(i + 1, clamp((gp - TWIG.attach[i]) / TWIG.win[i])));
      if (gp >= 1) el.twbody.removeAttribute('mask'); else if (!el.twbody.getAttribute('mask')) el.twbody.setAttribute('mask', `url(#${K}twm)`);
      el.twbody.style.visibility = gp <= 0 ? 'hidden' : 'visible';
    }
    // 落蝶光晕（样稿 opacity .55）与枝上白花：5.65 s 起由近及远依次绽开（放大到 1.25× 再回落）
    el.twglow.setAttribute('opacity', (0.55 * E.out(win(t, L, L + 1.2))).toFixed(3));
    TWIG.order.forEach((idx, kk) => {
      const n = tfs[idx];
      const f = TWIG.FL[idx];
      const t0 = L + 0.05 + kk * 0.09;
      const s = popCurve(win(t, t0, t0 + 0.38));
      const cx = f[0][0];
      const cy = f[0][1];
      n.setAttribute('transform', s <= 0.001 ? 'translate(0 0) scale(0)' : `translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${f[2]}) scale(${s.toFixed(3)}) translate(${(-cx).toFixed(1)} ${(-cy).toFixed(1)})`);
    });
  }

  function renderStage(t: number) {
    const z = camZ(t);
    const zf = 1 + 1.5 * (z - 1);
    setZ(el.world, z);
    setZ(el.bfzoom, z);
    setZ(el.near1, zf / z);
    setZ(el.pre, zf / z);
    // 第一帧起花海条就在（α 0.15，0.4 s 里升到 0.35）：绽开的圆还很小时，前景不是一整屏空白；圆扫过它的时候这份预览淡出，把位置交给真正的花海条
    el.pre.style.opacity = ((0.15 + 0.2 * E.ease(win(t, 0, 0.4))) * (1 - sstep(win(t, 0.9, 2.2)))).toFixed(3);
    setZ(el.near2, zf / z);

    // 背景：蒙版光晕随绽开淡入；三道斜光束（早期氛围，7 s 前渐隐，终帧与样稿一致）
    // 光晕位图（bkb）不是合成层，它的不透明度每变一次，landing-host 就要把光晕那一大块（约 5 MP）重新光栅一遍、Viz 多出一个帧（开屏 0.3–1.4 s 实测每拍 4 个光栅任务）。
    // 实时播放时 α 取 0.3 / 76 的整数倍（≤ 0.5 个 8 位色阶的误差，看不出来；终值恰为 0.3，底板烘焙的比对不受影响）：2.4 s 里至多变 76 次，不是每拍一次；值没变就不写
    const bkRaw = 0.3 * E.ease(win(t, 0.3, 2.7));
    const bko = (bkb && !o.capture && !fastOff.has('bkq') ? (Math.round((bkRaw / 0.3) * BK_STEPS) / BK_STEPS) * 0.3 : bkRaw).toFixed(bkb && !o.capture && !fastOff.has('bkq') ? 4 : 3);
    if (bko !== bkLast) {
      bkLast = bko;
      el.bk.style.opacity = bko;
      if (bkb) bkb.cv.style.opacity = bko;
    }
    if (beamsFast) {
      // 0.1.4：渐变 / 宽 / 起点固定（setupFast），每拍只写 transform（屏幕系平移）与 opacity
      el.beams.forEach((b, i) => {
        const f = beamFrame(i, t);
        b.style.display = f.on ? 'block' : 'none';
        if (f.on) { b.style.transform = `translate3d(${f.dx.toFixed(2)}px, 0, 0) rotate(${BEAM_ROT}deg)`; b.style.opacity = f.opacity.toFixed(4); }
      });
    } else {
      const fa = E.ease(win(t, 0.1, 1.2)) * (1 - sstep(win(t, L - 1.1, L + 1.6)));
      el.beams.forEach((b, i) => {
        const ph = [0.3, 2.1, 4.0][i];
        const w = [150, 210, 120][i];
        const a = [0.16, 0.12, 0.1][i] * fa * (1 + 0.3 * Math.sin((TAU * t) / 14 + ph));
        const cx = 1600 * [0.78, 0.92, 0.64][i] + (12 * t + 30 * Math.sin((TAU * t) / 14 + ph)) * [1, -1, 1][i] * 0.8;
        b.style.display = a > 0.001 ? 'block' : 'none';
        b.style.width = `${w}px`;
        b.style.left = `${(cx - w / 2).toFixed(1)}px`;
        b.style.top = `${280 - 950}px`;
        b.style.background = `linear-gradient(90deg, rgba(255,248,255,0), rgba(255,248,255,${a.toFixed(3)}) 50%, rgba(255,248,255,0))`;
      });
    }
    // 绽开：立绘＋花海条一起从脚下长出（径向蒙版的并集：主圆 + 6 片花瓣 + 三个错开点开的中心；人物不单独淡入）。
    // 画布路径（位图备好之后）/ DOM 路径（CSS 蒙版，dayBloom.ts 的 bloomMaskCss，与 0.1.3 逐字相同）二选一
    renderBloom(t, z);
    // 枝条（墨迹向来蝶伸去）+ 落蝶光晕 + 枝上白花
    renderTwig(t);
    // 蝶（SVG：样稿的 wingB / bBody，落地姿态与样稿 bfly-land 同构）
    placeBf(bfWarm(t));

    // 雪点
    renderSnow(t);
    return z;
  }

  /** fx 画布画哪些：full = 全部；dust = 只光尘；live = 视频期间实时画的那部分（光尘 + 叠在立绘上方的 B 类：花瓣 / 轨迹 / 蝶的各种光晕 / 落蝶光环）；
      base = 视频母版里的那部分（A 类：起手的雾 / 荆棘脉冲 / 圆边雾圈 / 点花，全在绽开段、立绘之下或绽开期间，没有光尘）. */
  type FxMode = 'full' | 'dust' | 'live' | 'base';
  function renderFx(t: number, z: number, mode: FxMode = 'full') {
    const partA = mode === 'full' || mode === 'base';
    const partB = mode === 'full' || mode === 'live';
    const dustOnly = mode === 'dust';
    const main = fctx;
    let f = main;
    f.setTransform(R, 0, 0, R, 0, 0);
    f.clearRect(0, 0, W, H);
    f.globalAlpha = 1;
    f.globalCompositeOperation = 'source-over';
    const [ax, ay] = DC.A;
    // 起手的雾：前 0.3 s 压在已露区上（α 0.5，之后 0.6 s 里淡去），降低深色草地与浅色雾的反差（与雾底同色，未露区不受影响）
    {
      const fa = bloomFogAlpha(t);
      if (fa > 0.002 && partA) { f.globalAlpha = fa; f.fillStyle = 'rgb(236 230 246)'; f.fillRect(0, 0, W, H); f.globalAlpha = 1; }
    }
    // 光尘：窗口像素（视频期间 fx 只画光尘：它按窗口分数 x0*W、y0*H 定位，烘进视频会在非视频比例的窗口里错位；导出 layers:'bg' 不画它）
    if (!layersBg && mode !== 'base') {
      const s = H / 1080;
      f.globalCompositeOperation = 'lighter';
      const ramp = E.ease(win(t, 0.6, 2.2));
      for (const m of DAY_MOTES) {
        const mh = H + 40;
        const y = ((((m.y0 * H + m.vy * s * t) % mh) + mh) % mh) - 20;
        const x = m.x0 * W + m.amp * s * Math.sin((TAU * t) / m.per + m.ph);
        const r = m.s * s * 2.2;
        f.globalAlpha = m.a * ramp * 0.7;
        f.drawImage(SPR.glowWhite, x - r, y - r, 2 * r, 2 * r);
      }
      f.globalCompositeOperation = 'source-over';
      f.globalAlpha = 1;
    }
    if (dustOnly) return;
    f.setTransform(R * k, 0, 0, R * k, 0, 0);
    f.save();
    f.translate(ax, ay);
    f.scale(z, z);
    f.translate(-ax, -ay);
    const [cx0, cy0] = DC.C0;
    // 荆棘光脉冲：圆刚揭开脚下时（≈0.5 s）紫色荆棘光局部提亮一次；绽开边缘一圈柔白
    {
      const Rr = RB(t);
      const pp = win(t, DT.thorn[0], DT.thorn[1]);
      if (partA && pp > 0 && pp < 1) {
        const a = 0.36 * Math.sin(Math.PI * Math.pow(pp, 0.7));
        f.globalCompositeOperation = 'lighter';
        f.globalAlpha = a;
        const r = 210;
        f.drawImage(SPR.thorn, cx0 - r, cy0 - r * 0.5 - 20, 2 * r, r);
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
      if (partA && t > 0.1 && Rr < 1500) {
        // 圆边外只留一层很淡的雾（不再有一圈白色的光边：那像 PPT 的「圆形」转场，不像花海一圈圈绽开）
        const a = 0.3 * (1 - win(Rr, 700, 1500)) * E.ease(win(t, 0.1, 0.4));
        f.globalAlpha = a;
        const r = Rr + 60;
        f.save();
        f.translate(cx0, cy0);
        f.scale(1, FLAT(t));
        f.drawImage(SPR.mist, -r, -r, 2 * r, 2 * r);
        f.restore();
        f.globalAlpha = 1;
      }
    }
    // 点花：圆边经过时弹出白花，停留 0.4 s，0.6 s 内淡出
    for (const b of DAY_BLOOM) {
      const age = t - b.t0;
      if (!partA || age < 0 || age > 1.2) continue;
      const sc_ = popCurve(win(age, 0, 0.22));
      const al = 1 - win(age, 0.5, 1.1);
      const sp = [SPR.fl, SPR.fl2, SPR.fl3][b.kind];
      f.save();
      f.globalAlpha = al;
      f.translate(b.x, b.y);
      f.rotate(b.rot);
      f.scale(sc_, sc_);
      f.drawImage(sp, (-b.s / 2) * 1.2, (-b.s / 2) * 1.2, b.s * 1.2, b.s * 1.2);
      f.restore();
    }
    f.globalAlpha = 1;
    // 花瓣（≤12 片同时）：先自圆边升起，落蝶时再放出；顺西风向左上漂，α×0 于标题块包围盒
    const petal = (p: DayPetal, age: number, life: number) => {
      const al = 0.85 * Math.min(win(age, 0, 0.6), 1 - win(age, life - 1.0, life));
      const x0 = p.x + p.vx * age + p.amp * Math.sin((TAU * age) / p.per + p.ph);
      const y0 = p.y + p.vy * age;
      if (x0 < 520 && y0 > 280 && y0 < 740) return;
      f.save();
      f.globalAlpha = al;
      f.translate(x0, y0);
      f.rotate(p.rot + p.spin * age);
      f.fillStyle = p.c ? '#fbf6fb' : '#e7dcf6';
      f.strokeStyle = 'rgba(140,110,190,.4)';
      f.lineWidth = 0.6;
      f.beginPath();
      f.ellipse(0, 0, p.s, p.s * 0.52, 0, 0, TAU);
      f.fill();
      f.stroke();
      f.restore();
    };
    if (partB) {
      for (const p of DAY_PETALS) { const age = t - p.t0; if (age >= 0 && age <= p.life) petal(p, age, p.life); }
      for (const p of DAY_LAND_PETALS) { const age = t - p.t0; if (age >= 0 && age <= p.life) petal(p, age, p.life); }
    }
    f.globalAlpha = 1;
    // 轨迹：浅蓝光点，每粒 700 ms 淡入、1.2 s 后淡出（昼的终帧干净）
    for (const d of partB ? DAY_TRAIL : []) {
      const td = DT.fly[0] + (DT.fly[1] - DT.fly[0]) * invFlight(d.q) + 0.05;
      const age = t - td;
      if (age < 0 || age > 2.2) continue;
      const a = E.out(win(age, 0, 0.7)) * (1 - win(age, 1.2, 2.2));
      const rr = d.rad * 1.5;
      f.globalAlpha = a * d.op * 0.55;
      f.drawImage(SPR.dayGlow, d.p[0] + d.dx - rr * 4, d.p[1] + d.dy - rr * 4, rr * 8, rr * 8);
      f.globalAlpha = a * d.op;
      f.fillStyle = '#6fb2ea';
      f.beginPath();
      f.arc(d.p[0] + d.dx, d.p[1] + d.dy, rr, 0, TAU);
      f.fill();
    }
    f.globalAlpha = 1;
    // 蝶出生：花束小蓝花一圈柔光（半径 ≈46 px，一次）与亮点上浮；展翅时再给一次蓝花的柔光
    if (partB) {
      const [bx, by] = DC.BIRTH;
      const ra = win(t, DT.glow, DT.glow + 0.6);
      if (ra > 0 && ra < 1) { const r = 46 * (0.6 + 0.8 * ra); f.globalAlpha = 0.95 * (1 - ra); f.drawImage(SPR.dayBlue, bx - r, by - r, 2 * r, 2 * r); f.globalAlpha = 1; }
      const da = win(t, DT.dot[0], DT.dot[1]);
      if (da > 0 && da < 1) {
        const a = Math.sin(Math.PI * da);
        const yy = by - 12 * E.ease(da);
        f.globalAlpha = 0.9 * a;
        f.drawImage(SPR.dayBlue, bx - 12, yy - 12, 24, 24);
        f.fillStyle = '#4fa6ee';
        f.beginPath();
        f.arc(bx, yy, 3.2, 0, TAU);
        f.fill();
        f.globalAlpha = 1;
      }
      const ua = win(t, DT.unfurl[0], DT.unfurl[1] + 0.3);
      if (ua > 0 && ua < 1) { const r = 70 * (0.7 + 0.5 * ua); f.globalAlpha = 0.5 * Math.sin(Math.PI * ua); f.drawImage(SPR.dayBlue, bx - r, by - r, 2 * r, 2 * r); f.globalAlpha = 1; }
    }
    // 蝶身蓝晕（飞行）与落点蓝晕
    if (partB) {
      const b = bfDay(t);
      if (b && b.flying) { const gr = ((70 * b.sc) / REST_K) * 1.2 * 1.5; f.globalAlpha = 0.45 * b.alpha * (1 - win(t, L - 0.6, L)); f.drawImage(SPR.dayGlow, b.x - gr, b.y - gr, 2 * gr, 2 * gr);
        // 蝶身后垫一层白色柔光：蝶飞过粉紫色的龙翼时蓝压在粉紫上、图底分不开，白光把它托出来
        const wr = gr * 0.9;
        f.globalAlpha = 0.28 * b.alpha * (1 - win(t, L - 0.4, L));
        f.drawImage(SPR.glowWhite, b.x - wr, b.y - wr, 2 * wr, 2 * wr);
        f.globalAlpha = 1; }
      // 落地：沿枝向两端跑一道柔光（只一次，α≤.3，600 ms），同时枝梢与蝶脚处一次柔亮
      const lp = win(t, L, L + 0.6);
      if (lp > 0 && lp < 1) {
        const e = E.ease(lp);
        const fa = 0.3 * Math.sin(Math.PI * lp);
        const [fx, fy] = TWIG.land;
        const ptTip = bez(TWIG.main2, lerp(0.8, 1, e));
        const ptRoot = e < 0.45 ? bez(TWIG.main2, lerp(0.8, 0, e / 0.45)) : bez(TWIG.main1, lerp(1, 0.15, (e - 0.45) / 0.55));
        for (const [pt, rr] of [[ptTip, 34], [ptRoot, 46]] as Array<[[number, number], number]>) { f.globalAlpha = fa; f.drawImage(SPR.dayBlue, pt[0] - rr, pt[1] - rr, 2 * rr, 2 * rr); }
        f.globalAlpha = fa * 0.8;
        f.drawImage(SPR.dayBlue, fx - 60, fy - 60, 120, 120);
        f.globalAlpha = 1;
      }
    }
    // 每朵花绽开时一圈极淡的光环（半径 40→60，α .2→0）
    TWIG.order.forEach((idx, kk) => {
      const t0 = L + 0.05 + kk * 0.09;
      const p = win(t, t0 + 0.05, t0 + 0.75);
      if (!partB || p <= 0 || p >= 1) return;
      const [cx, cy] = TWIG.FL[idx][0];
      const rr = lerp(32, 52, E.out(p));
      f.globalAlpha = 0.28 * (1 - p);
      f.drawImage(SPR.glowWhite, cx - rr, cy - rr, 2 * rr, 2 * rr);
      f.globalAlpha = 1;
    });
    f.restore();
  }

  function renderDom(t: number) {
    // 文字段（5.2–7.0 s）：被动画的文字元素在 4.9 s 起各自成层（will-change），letter-spacing / clip-path / drop-shadow / 描边的重光栅只落在自己的小层上，
    // 不再重画整张 1708×1019 的 .bd-text 层；每个元素自己的动画收完就撤（boot.css 的 .is-wc）——静止后还挂着层会发虚，7.4 s 一起撤时会「对一下焦」
    {
      const want = fastOn && TEXT_PROMOTE && !fastOff.has('wc');
      if (want || wcEls) {
        wcEls ??= WC_END().map(([n, end]) => ({ n, end, on: false }));
        for (const w of wcEls) { const on = want && t >= WC_FROM && t < w.end; if (on !== w.on) { w.on = on; w.n.classList.toggle('is-wc', on); } }
      }
    }
    fadeTo(el.credit, t, 0.6, 0.6, 1);
    el.skip.style.opacity = (0.55 * E.ease(win(t, 1.0, 1.4)) * (1 - E.ease(win(t, L + 1.2, L + 1.6)))).toFixed(3);
    reveal(el.ch[0], t, L + 0.5, 0.9);
    reveal(el.ch[1], t, L + 0.68, 0.9);
    {
      const p = E.ease(win(t, L + 0.75, L + 1.75));
      el.enSpan.style.opacity = p.toFixed(3);
      el.enSpan.style.transform = p >= 1 ? 'none' : `translateY(${((1 - p) * 8).toFixed(2)}px)`;
      el.enSpan.style.filter = p < 1 ? `blur(${((1 - p) * 6).toFixed(2)}px)` : 'none';
      el.enSpan.style.letterSpacing = `${lerp(1.0, 0.78, p).toFixed(3)}em`;
      const pl = E.ease(win(t, L + 0.75, L + 1.45));
      el.enLines.forEach((i) => { i.style.transform = `scaleX(${pl.toFixed(3)})`; });
    }
    { const p = E.ease(win(t, L + 1.0, L + 1.7)); el.banner.style.clipPath = p >= 1 ? 'none' : `inset(0 ${((1 - p) * 100).toFixed(2)}% -30px 0)`; }
    {
      const pl = E.ease(win(t, L + 1.25, L + 1.95));
      el.epiLines.forEach((i) => { i.style.transform = `scaleX(${pl.toFixed(3)})`; });
      const p = E.ease(win(t, L + 1.65, L + 2.4));
      el.epiSpan.style.opacity = p.toFixed(3);
      el.epiSpan.style.transform = p >= 1 ? 'none' : `translateY(${((1 - p) * 6).toFixed(2)}px)`;
    }
    fadeTo(el.ver, t, L + 0.8, 0.6, 0.78);
    { const p = E.ease(win(t, L + 1.4, L + 2.2)); el.enter.style.opacity = p.toFixed(3); el.enter.style.transform = p >= 1 ? 'none' : `translateY(${((1 - p) * 8).toFixed(2)}px)`; }
    el.flame.forEach((s, i) => { const a = E.ease(win(t, L + 1.5 + i * 0.12, L + 1.5 + i * 0.12 + 0.3)); s.style.opacity = (0.25 + 0.75 * a).toFixed(3); });
    el.flameBase.style.opacity = (0.4 + 0.6 * E.ease(win(t, L + 1.5, L + 2.15))).toFixed(3);
    {
      const p = E.ease(win(t, L + 2.0, L + 2.5));
      const br = 0.78 + 0.22 * (0.5 - 0.5 * Math.cos((TAU * Math.max(0, t - (L + 2.5))) / 4.8));
      el.ln.style.transform = `scaleX(${p.toFixed(3)})`;
      el.ln.style.opacity = (p * (t > L + 2.5 ? br : 1)).toFixed(3);
    }
  }

  /* ───────── 转场（transition.ts）：官方立绘从全屏矩形收成右侧拱窗的形状并落到窗里的位置；蝶、标题、署名同夜版去向 ───────── */
  const BF_SPAN = 66;     // 昼蝶（wingB）平展时的翼展（symbol 单位）

  function prepareTransition(o: TrOptions): SceneTransition {
    settle(o.from);       // 绽开画布还在的话先换回 DOM 的状态（BootSplash 已经调过并等过栅格；这里幂等，给导出模式 / 直接调用兜底）
    // comp（合成器优先）：窗的裁切 / 立绘 / 底板 / 轮廓 / 落影 / 蝶都变成 WAAPI 通道（dayTrComp.ts + dayComp.ts）；legacy：下面原来的 JS 逐拍写样式
    if (bootImpl() === 'comp') {
      return prepareDayTransitionComp({
        host, fx, el, dayGlow: SPR.dayGlow, k, W, H, R, bloomEnd: DT.bloom[1],
        z0: (from) => 1 + 0.12 * (1 - E.camera(win(from, 0, DT.cam))),
        bfDay, figUrl, flowersUrl, renderScene: render, getBake,
      }, o);
    }
    const { kind, from, anchors } = o;
    const plate = q1(host, '.boot__plate');
    const glowEl = q1(host, '.s0-glow');
    const h1 = q1(host, '.s0-left h1');
    const S = daySegs(kind);

    // ── 立绘收进拱窗：花海绽满之后（2.7 s 起，含被打断的快速版）、拱窗在场（窗口够宽）时；否则立绘随底板一起溶掉 ──
    // 被打断时镜头还在推近（world 的缩放 z0 > 1）：收窗的同时把它推回 1，落点才对得上拱窗里的立绘
    const fit = from >= DT.bloom[1] && anchors.arch && anchors.fig ? artFit(k, anchors.fig) : undefined;
    const arch = anchors.arch;
    const boxW = Math.max(1600, W / k);                  // .bd-bloom 的盒子（舞台单位）：宽 = max(1600, 窗宽 / k)、高 1000
    const stageArch: Rect | undefined = arch ? { x: arch.x / k, y: arch.y / k, w: arch.w / k, h: arch.h / k } : undefined;
    const z0 = 1 + 0.12 * (1 - E.camera(win(from, 0, DT.cam)));
    el.art.style.transformOrigin = '0 0';
    // 人物分身：figure-official 的抠图，叠在原画（.s0-art）里同一个人的位置，随原画同一个变换一起走。
    // 原画的背景（瀑布、草地、巨瓣）在收窗运动里淡成窗里的薰衣草，人物本体不参与淡化——所以窗里最后换手的只有「两边像素一致」的人物
    let figEl: HTMLImageElement | undefined;
    if (fit && stageArch) {
      figEl = document.createElement('img');
      figEl.className = 'boot__fig';
      figEl.alt = '';
      figEl.draggable = false;
      figEl.src = figUrl;
      figEl.style.cssText = `left:${FIG_STAGE.x.toFixed(2)}px;top:${FIG_STAGE.y.toFixed(2)}px;width:${FIG_STAGE.w.toFixed(2)}px;transform-origin:${(470 - FIG_STAGE.x).toFixed(2)}px ${(-62 - FIG_STAGE.y).toFixed(2)}px;opacity:0`;
      el.art.after(figEl);
    }
    // 窗里临时的「薰衣草底」：与拱窗自己的底同一条竖向渐变（拱窗按窗高铺，所以与整个窗口的竖向位置对得上）。原画的背景在收窗运动里淡成它。
    // 光环（同拱窗里的 .daystage__halo）**跟着立绘走**（按终态位置摆好，再套 decoXf：p=1 恒等；它始终在她的头后面，不钉在终点位置先亮在右边）；
    // 脚下的白花海（同 .daystage__flowers：底部 17%、同一张图）**跟着窗的底边走**（宽 = 裁切框的宽、高 = 裁切框高的 17%）。
    const flwH = stageArch ? 0.17 * stageArch.h : 0;                                                       // 窗里花海条的高（拱窗高的 17%）
    const flwX = stageArch ? stageArch.x + (stageArch.w - flwH * (1280 / 155)) / 2 : 0;                    // 图（1280×155）在窗里居中时的左缘
    let archBg: HTMLDivElement | undefined;
    let archFog: HTMLDivElement | undefined;
    let archDeco: HTMLDivElement | undefined;
    let archFlw: HTMLDivElement | undefined;
    let frame: HTMLDivElement | undefined;
    let ring: HTMLElement | undefined;
    // 窗的落影画布（见 drawShadow）
    let shadowCv: HTMLCanvasElement | undefined;
    let shadowG: CanvasRenderingContext2D | null = null;
    let lowCv: HTMLCanvasElement | undefined;
    let lowG: CanvasRenderingContext2D | null = null;
    let shadowDrawn = false;
    let shadowPad = 0;
    let shadowSig = '';
    if (fit && stageArch && arch) {
      const OX = -400;
      const OY = -200;
      const hh = stageArch.h;
      const y0 = stageArch.y - OY;
      archBg = document.createElement('div');
      archBg.className = 'boot__archbg';
      archBg.style.cssText = `left:${OX}px;top:${OY}px;width:4000px;height:1400px;opacity:0;background:linear-gradient(180deg,#e4dcf4 ${y0.toFixed(1)}px,#efe9f8 ${(y0 + 0.4 * hh).toFixed(1)}px,#f8f4f8 ${(y0 + 0.72 * hh).toFixed(1)}px,#e9e1f3 ${(y0 + hh).toFixed(1)}px)`;
      // 窗里右上 1/3 的薰衣草雾：立绘放大时深色的巨瓣先挤进右上角（右上区亮度先暗约 5% 再亮），所以这一块比整个临时底提前 ≈ 0.14 s 淡起（washTop），盖在原画之上、人物分身之下
      archFog = document.createElement('div');
      archFog.className = 'boot__archbg';
      archFog.style.cssText = `left:${OX}px;top:${OY}px;width:4000px;height:1400px;opacity:0;background:linear-gradient(180deg,#e4dcf4 ${y0.toFixed(1)}px,#e8e1f5 ${(y0 + 0.22 * hh).toFixed(1)}px,rgb(239 233 248 / 0) ${(y0 + 0.62 * hh).toFixed(1)}px)`;
      el.art.after(archFog);
      const hs = 0.3503 * hh;
      archDeco = document.createElement('div');
      archDeco.className = 'boot__archdeco';
      archDeco.style.cssText = `left:0;top:0;width:0;height:0;opacity:0;transform-origin:0 0;--ku:${(1 / k).toFixed(5)}`;
      archDeco.innerHTML = `<i style="left:${(stageArch.x + 0.1964 * hh).toFixed(1)}px;top:${(stageArch.y + 0.2442 * hh).toFixed(1)}px;width:${hs.toFixed(1)}px;height:${hs.toFixed(1)}px"></i>`;
      archFlw = document.createElement('div');
      archFlw.className = 'boot__archflw';
      archFlw.style.opacity = '0';
      archFlw.style.backgroundImage = `url('${flowersUrl}')`;
      archFlw.style.backgroundSize = `auto ${flwH.toFixed(2)}px`;
      el.bloom.insertBefore(archFlw, el.bloom.firstChild);
      el.bloom.insertBefore(archDeco, el.bloom.firstChild);
      el.bloom.insertBefore(archBg, el.bloom.firstChild);
      // 窗的轮廓：1 px 浅紫描边、外一圈白框、落在纸面上的阴影、底部点状窗台——收窗一开始就画在裁切框上（同 decor.css 的 .daystage），
      // 收窗全程读得出这是一扇窗，不是人物被一把看不见的刀裁着（评审 R2）。与 .bd-world 同层、在 .bd-bloom 之上：随镜头一起走
      frame = document.createElement('div');
      frame.className = 'boot__archframe';
      frame.style.setProperty('--ku', (1 / k).toFixed(5));
      frame.style.opacity = '0';
      frame.innerHTML = '<i class="ring"></i><div class="in"><b class="hem"></b></div>';
      ring = frame.querySelector('i') as HTMLElement;
      el.bloom.after(frame);
      // 窗的落影（0 14 34 rgb(70 45 110 / .2)）原来是 frame 自己的 box-shadow：窗的几何每个节拍都在变，每个节拍都要把这个上下半径不等的大圆角
      // （Skia 没有解析的快速路径）的整片高斯模糊在整屏大的层上重画一遍——这是昼转场里最贵的一步：单独把这条阴影去掉，交错对照 8 轮 8 / 8 都更好
      // （出帧率中位 +17–21%、p95 间隔 −4…−6 ms、> 16.7 ms 的帧 −3.5 个百分点，GPU 光栅 + 渲染通道的工作量 41% → 32%）；去掉 mask-image、描边、窗台都没有这个效果。
      // 现在落影改在两张画布上画：低分辨率（1/SHADOW_LOWRES）的那张只画模糊的圆角矩形（阴影本来就是 σ 17 px 的低频），显示画布把它放大、再沿窗的轮廓裁掉里面
      // （阴影只在窗外；窗里本来就没有）——每个节拍只是几次画布操作，没有逐块光栅；几何不变的那段（窗停稳之后）连这几次也省了。
      shadowPad = SHADOW_PAD;
      const sD = k * R;
      shadowCv = document.createElement('canvas');
      shadowCv.className = 'boot__archshadow';
      shadowCv.setAttribute('aria-hidden', 'true');
      shadowCv.width = Math.max(2, Math.ceil((boxW + 2 * shadowPad) * sD));
      shadowCv.height = Math.max(2, Math.ceil((1000 + 2 * shadowPad) * sD));
      shadowCv.style.cssText = `left:${-shadowPad}px;top:${-shadowPad}px;width:${boxW + 2 * shadowPad}px;height:${1000 + 2 * shadowPad}px;opacity:0`;
      shadowG = shadowCv.getContext('2d');
      lowCv = document.createElement('canvas');
      lowCv.width = Math.max(2, Math.ceil(shadowCv.width / SHADOW_LOWRES));
      lowCv.height = Math.max(2, Math.ceil(shadowCv.height / SHADOW_LOWRES));
      lowG = lowCv.getContext('2d');
      // 落影放在世界层之前（舞台里、世界层之下）：与 frame（在世界层里、bloom 之后）相比，叠放上只差世界层里的 bd-pre / bloom——它们在窗的轮廓之外没有东西（bloom 被裁到窗里，
      // bd-pre 的花海条预览 2.2 s 就淡没了），窗里的落影又被挖掉了，所以画面不变；而画布若放进世界层里，会改变世界层里立绘的合成方式（半像素的位移 / 重采样）。
      // 世界层的镜头缩放（被打断时还在推近）按同一个原点同一个倍数套在画布上（renderTr 里）
      shadowCv.style.transformOrigin = `${DC.A[0]}px ${DC.A[1]}px`;
      el.world.before(shadowCv);
    }
    const fades: Array<[HTMLElement | SVGElement, number]> = [   // [元素, 起始不透明度]：随场景淡出
      [q1(host, '.s0-twig'), 1],
      [q1(host, '.s0-twc'), 1],
      [el.snow, 1],
      [el.near1, parseFloat(el.near1.style.opacity || '1')],
      [el.near2, 1],
      [el.ver, parseFloat(el.ver.style.opacity || '0')],
      ...el.enLines.map((n): [HTMLElement, number] => [n, 1]),
    ];
    // 题辞、横幅、提示：赶在纸面前缘到达 x = 200 之前淡完（textOut，0.03–0.20 s）——不被奶油纸压着淡出（压在纸上的那半边会泛粉）
    const textFades: Array<[HTMLElement, number]> = [
      [el.banner, 1],
      [q1(host, '.s0-epi'), 1],
      [el.enter, parseFloat(el.enter.style.opacity || '1')],
      [el.skip, parseFloat(el.skip.style.opacity || '0')],
    ];

    // ── 蝶 ──
    const b0 = bfDay(from);
    const hasBf = !!b0 && b0.alpha > 0.2 && !!anchors.mark;
    let start: BfPose | undefined;
    let goal: ReturnType<typeof brandGoal> | undefined;
    let path: ReturnType<typeof flightPath> | undefined;
    if (hasBf && b0 && anchors.mark) {
      const [ax, ay] = DC.A;
      // 蝶在 bfzoom（以 A 为原点放大 z）里的位置 → 屏幕像素；之后 bfzoom 不再缩放，蝶直接用屏幕位置
      start = { x: k * (ax + z0 * (b0.x - ax)), y: k * (ay + z0 * (b0.y - ay)), w: BF_SPAN * b0.sc * k * z0, rot: b0.rot, flap: b0.flap, alpha: b0.alpha };
      goal = brandGoal(anchors.mark);
      path = flightPath([start.x, start.y], [goal.x, goal.y], 1);
      el.bfzoom.style.transform = 'none';
    }
    const fold0 = b0 ? b0.pose : 0;
    const bfc = document.createElement('canvas');
    bfc.className = 'boot__bfc';
    bfc.setAttribute('aria-hidden', 'true');
    bfc.width = fx.width;
    bfc.height = fx.height;
    host.appendChild(bfc);
    const bx = bfc.getContext('2d')!;

    // ── 枝（品牌标那根细枝的分身；从蝶的落脚点往两头长） ──
    let twigFx: TwigFx | undefined;
    if (hasBf && anchors.mark && start && goal && path) twigFx = createTwigFx(host, anchors.mark, { stroke: '#4a2d68', wMain: 1.7, wSide: 1.2, open: twigOpen(start, goal, path, twigFootScreen(anchors.mark)) });

    // ── 标题与署名（FLIP；舞台缩放 k 要从平移里除掉） ──
    // 被打断时标题常常只浮现了一部分（或一点都没有）：不带的从它此刻的状态淡出、带着走的把 reveal 收完——绝不从 0 / 1 起跳
    const shown = (n: HTMLElement) => parseFloat(n.style.opacity || '0') > 0.5;
    const chBase = el.ch.map(revealBase);
    const enBase = revealBase(el.enSpan);
    const crBase = parseFloat(el.credit.style.opacity || '0') || 0;
    let fh1: Flip | undefined;
    let fen: Flip | undefined;
    const lsH1 = lsEm(h1);
    const lsEn = lsEm(el.enSpan);
    const h1Box = boxRect(h1);
    const h1Src = unionRect(el.ch.map(rangeRect));
    const enBox = boxRect(el.enSpan);
    const enSrc = rangeRect(el.enSpan);
    if (anchors.name && shown(el.ch[0])) fh1 = flipTo(h1Box, h1Src, anchors.name);
    if (anchors.sub && shown(el.enSpan)) fen = flipTo(enBox, enSrc, anchors.sub);
    const grpSrc: TitleGroup | undefined = fh1 && fen && anchors.name && anchors.sub ? { h1Box, h1Src, h1Dst: anchors.name, enSrc, enDst: anchors.sub } : undefined;
    const nameRgb = parseRgb(anchors.nameColor, [42, 27, 64]);
    const subRgb = parseRgb(anchors.subColor, [61, 39, 96]);
    // 署名不飞：最不重要的版权小字不该成为全屏位移最长的元素——开屏里的一行原地淡出，拱窗里的一行原地淡入
    h1.style.transformOrigin = '0 0';
    el.enSpan.style.transformOrigin = '0 0';

    /** 光尘拖尾：寿命 ≤ 100 ms 的几粒，点距随速度拉开、尺寸 / 亮度各随机 ±30%（dustDots）；标题周围不画. */
    function drawDust(st: ReturnType<typeof trState>, tr: number) {
      const f = bx;
      f.setTransform(R, 0, 0, R, 0, 0);
      f.clearRect(0, 0, W, H);
      if (!path || st.fly <= 0.01 || st.swapOut >= 1) return;
      const s1 = H / 1080;
      for (const d of dustDots(path, S.fly, tr, 7300, titleRects(tr))) {
        const r = 1.6 * s1 * 1.4 * d.r;
        f.globalAlpha = Math.min(1, d.a * 0.4);
        f.drawImage(SPR.dayGlow, d.x - r * 4, d.y - r * 4, r * 8, r * 8);
        f.globalAlpha = Math.min(1, d.a * 0.75);
        f.fillStyle = '#6fb2ea';
        f.beginPath();
        f.arc(d.x, d.y, r, 0, TAU);
        f.fill();
      }
      f.globalAlpha = 1;
    }

    /** 此刻的窗（裁切框露出的矩形；舞台单位，world 缩放之前）与 world 的缩放。p = 立绘的进度，pl = 窗的左缘（与拱顶圆角）的进度——更急. */
    const windowAt = (p: number, pl: number) => {
      const c = archClip(p, boxW, 1000, stageArch as Rect, ARCH_BOTTOM_RADIUS / k, pl);
      return { c, r: archClipRect(c, boxW, 1000), zw: lerp(z0, 1, p) };
    };

    /** 窗的落影：低分辨率画布上画模糊的圆角矩形（阴影的几何 = 窗的裁切框下移 14 px，σ = 34 px / 2）→ 放大到显示画布 → 沿窗的轮廓裁掉里面 →
        左缘高速时按 winEdgeAlpha 把左侧淡掉（与 frame 的 mask-image 同一条渐变：左缘以左 aL，之后 190 个舞台单位升到 1）。alpha = frame 的不透明度（0 时只清画布）. */
    function drawShadow(r: Rect, c: ArchClip, aL: number, alpha: number) {
      if (!shadowCv || !shadowG || !lowCv || !lowG) return;
      if (alpha <= 0.002) {
        if (shadowDrawn) { shadowG.clearRect(0, 0, shadowCv.width, shadowCv.height); shadowDrawn = false; shadowSig = ''; }
        return;
      }
      shadowCv.style.opacity = alpha.toFixed(3);
      // 几何没变（窗停稳之后的最后三成时间）就不重画：只有不透明度在走
      const sig = `${r.x.toFixed(2)},${r.y.toFixed(2)},${r.w.toFixed(2)},${r.h.toFixed(2)},${c.rTop.toFixed(2)},${c.rBot.toFixed(2)},${aL.toFixed(3)}`;
      if (shadowDrawn && sig === shadowSig) return;
      shadowSig = sig;
      const sD = k * R;                         // 显示画布：每舞台单位多少位图像素
      const sL = sD / SHADOW_LOWRES;            // 低分辨率画布
      const rad = (f: number): number[] => [c.rTop * f, c.rTop * f, c.rBot * f, c.rBot * f];
      const lg = lowG;
      lg.setTransform(1, 0, 0, 1, 0, 0);
      lg.clearRect(0, 0, lowCv.width, lowCv.height);
      const far = lowCv.width + 64;             // 形状画在画布之外，只让它的影子落进来
      lg.shadowColor = SHADOW_RGBA;
      lg.shadowBlur = (SHADOW_BLUR / k) * sL;   // canvas 的 shadowBlur 与 CSS box-shadow 的模糊半径同一个约定（σ = 半径 / 2）
      lg.shadowOffsetX = far;
      lg.shadowOffsetY = (SHADOW_DY / k) * sL;
      lg.fillStyle = '#000';
      lg.beginPath();
      lg.roundRect((r.x + shadowPad) * sL - far, (r.y + shadowPad) * sL, r.w * sL, r.h * sL, rad(sL));
      lg.fill();
      lg.shadowColor = 'transparent';
      const g = shadowG;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalCompositeOperation = 'source-over';
      g.clearRect(0, 0, shadowCv.width, shadowCv.height);
      // 只在窗的轮廓之外铺：evenodd 的外框（整张画布）+ 窗的圆角矩形（挖掉）
      g.save();
      g.beginPath();
      g.rect(0, 0, shadowCv.width, shadowCv.height);
      g.roundRect((r.x + shadowPad) * sD, (r.y + shadowPad) * sD, r.w * sD, r.h * sD, rad(sD));
      g.clip('evenodd');
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'low';           // 双线性就够了：低分辨率那张是 σ ≈ 4 px 的低频
      g.drawImage(lowCv, 0, 0, shadowCv.width, shadowCv.height);
      g.restore();
      if (aL < 0.999) {
        const x0 = (r.x + shadowPad) * sD;
        const x1 = (r.x + WIN_EDGE_SOFT + shadowPad) * sD;
        const gr = g.createLinearGradient(x0, 0, x1, 0);
        gr.addColorStop(0, `rgba(0,0,0,${(1 - aL).toFixed(3)})`);
        gr.addColorStop(1, 'rgba(0,0,0,0)');
        g.globalCompositeOperation = 'destination-out';
        g.fillStyle = gr;
        g.fillRect(0, 0, x1, shadowCv.height);
        g.globalCompositeOperation = 'source-over';
      }
      shadowDrawn = true;
    }

    /** 窗的左缘（屏幕像素）的移动速度（px/s，数值微分）：高速时窗的左侧轮廓让位给纸面的软边. */
    const winLeftAt = (t2: number) => { const s2 = trState('day', kind, t2); const { r, zw } = windowAt(s2.art, s2.winL); return stageToScreen(r, zw, DC.A, k).x; };
    const winLeftSpeed = (t2: number) => Math.abs(winLeftAt(t2 + 0.008) - winLeftAt(t2 - 0.008)) / 0.016;

    /** 底板（与它上面的光）的遮罩 = 纸面遮罩的补集：纸面的前缘 xe（屏幕 px，渐变归零处）以左的地方底板撤掉，前缘 PAPER_FEATHER 的羽化带里底板渐渐回来；
        纸面左缘 mL 以左的一条（左栏）不在纸面里，底板留着（由 bg 整体淡掉）。scale = 元素相对屏幕的缩放（舞台里的层要把 px 除以 k）. */
    function plateMask(xe: number, mL: number, scale: number): string {
      if (xe <= mL) return '';
      const F = PAPER_FEATHER;
      const pa = Math.min(1, (xe - mL) / F);
      const px = (v: number) => `${(v / scale).toFixed(2)}px`;
      const parts = ['#000 0', `#000 ${px(mL)}`, `rgb(0 0 0 / ${(1 - pa).toFixed(3)}) ${px(mL)}`];
      if (xe - F > mL) parts.push(`transparent ${px(xe - F)}`);
      parts.push(`#000 ${px(xe)}`);
      return `linear-gradient(90deg, ${parts.join(', ')})`;
    }

    function renderTr(tr: number) {
      const st = trState('day', kind, tr);
      let winLeft: number | undefined;
      // 立绘：裁切框从整个窗口收成拱窗，立绘同时放大落到窗里的位置。
      // 原画的背景（连同它的花海条）在收窗运动最快的一段（0.35–0.72 s）淡成窗里的薰衣草——运动遮住换景，而这时窗的轮廓早已画出来；
      // 人物由抠图分身接手，全程不淡。落定之后拱窗里真的立绘先在分身下面淡入、分身再淡出（两边像素一致）。
      if (fit && stageArch && figEl) {
        const p = st.art;
        // tr=0 那一帧不写任何变换（与开屏定格帧逐像素相同）；之后才一点点放大、收边
        const tf = p === 0 ? '' : `translate(${((fit.dx / k) * p).toFixed(2)}px, ${((fit.dy / k) * p).toFixed(2)}px) scale(${Math.pow(fit.r, p).toFixed(5)})`;
        el.art.style.transform = tf;
        figEl.style.transform = tf;
        const { c, r, zw } = windowAt(p, st.winL);
        const wr = stageToScreen(r, zw, DC.A, k);
        winLeft = wr.x;
        el.bloom.style.clipPath = p === 0 ? '' : archClipCss(c);
        { const fw = p === 0 ? 0 : winSoft(winLeftSpeed(tr)); el.bloom.style.setProperty('mask-image', fw > 0.5 ? `linear-gradient(90deg, transparent ${c.l.toFixed(1)}px, #000 ${(c.l + fw).toFixed(1)}px)` : 'none'); }
        el.world.style.transform = zw === 1 ? 'none' : `scale(${zw.toFixed(5)})`;      // 被打断时镜头还在推近：收窗的同时推回 1
        if (shadowCv) shadowCv.style.transform = el.world.style.transform;
        el.art.style.opacity = (1 - st.wash).toFixed(3);
        const under = (st.wash * (1 - st.wOut)).toFixed(3);
        if (archBg) archBg.style.opacity = under;
        if (archFog) archFog.style.opacity = (0.95 * st.washTop * (1 - st.wOut)).toFixed(3);
        if (archDeco) {
          const m = decoXf(p, fit, k);
          archDeco.style.opacity = under;
          archDeco.style.transform = `translate(${m.x.toFixed(2)}px, ${m.y.toFixed(2)}px) scale(${m.a.toFixed(5)})`;
        }
        if (archFlw) {
          // 花海条的纹理钉在终态的位置（只有它的框——窗的左缘与底边——随窗走）：窗收窄时花不会跟着缩放 / 漂移；
          // 图是左右镜像对称的、两端同色，水平平铺不会有接缝（窗还很宽时左边也铺满）
          const fs = archFlw.style;
          fs.left = `${r.x.toFixed(2)}px`; fs.top = `${(r.y + r.h - flwH).toFixed(2)}px`; fs.width = `${r.w.toFixed(2)}px`; fs.height = `${flwH.toFixed(2)}px`;
          fs.backgroundPosition = `${(flwX - r.x).toFixed(2)}px 100%`;
          fs.opacity = (0.88 * st.wash * (1 - st.wOut)).toFixed(3);
        }
        if (frame && ring) {
          const fs = frame.style;
          fs.left = `${r.x.toFixed(2)}px`; fs.top = `${r.y.toFixed(2)}px`; fs.width = `${r.w.toFixed(2)}px`; fs.height = `${r.h.toFixed(2)}px`;
          fs.borderRadius = `${c.rTop.toFixed(2)}px ${c.rTop.toFixed(2)}px ${c.rBot.toFixed(2)}px ${c.rBot.toFixed(2)}px`;
          // 窗的左缘动起来（winL）它就在；临时底撤下（wOut）时窗的轮廓一起淡出：下面真拱窗自己的描边 / 白框 / 阴影 / 窗台露出来，不会叠成双份。
          // R5：窗宽 > 屏宽 85% 时整圈轮廓 α = 0（窗还是全屏大小时，四周不能多出一圈贴着屏边的圆角框）；
          // 左侧竖边在高速移动时（> 1500 px/s，约 0.36 s 以前）描边 / 白框 / 投影 α ≤ 0.2——这时只由纸面的软边领跑，不是一根硬竖条快速划过「栖」「枝」与 ALIGHT；
          // 随减速在 0.34–0.50 s 补足。拱顶与右侧不受影响（遮罩只压左边起算的 190 个舞台单位）
          const gate = sstep(win(1 - wr.w / W, 0.15, 0.3));
          const fo = sstep(win(st.winL, 0, 0.12)) * (1 - st.wOut) * gate;
          fs.opacity = fo.toFixed(3);
          const aL = winEdgeAlpha(winLeftSpeed(tr));
          drawShadow(r, c, aL, fo);
          if (aL >= 0.999) fs.removeProperty('mask-image');
          else fs.setProperty('mask-image', `linear-gradient(90deg, rgb(0 0 0 / ${aL.toFixed(3)}) 0, rgb(0 0 0 / ${aL.toFixed(3)}) ${WIN_EDGE_PAD}px, #000 ${WIN_EDGE_PAD + WIN_EDGE_SOFT}px)`);
          ring.style.borderRadius = `${(c.rTop + 6 / k).toFixed(2)}px ${(c.rTop + 6 / k).toFixed(2)}px ${(22 / k).toFixed(2)}px ${(22 / k).toFixed(2)}px`;
        }
        figEl.style.opacity = (st.figOn * (1 - st.figOut)).toFixed(3);
      } else {
        el.bloom.style.opacity = (1 - st.bgF).toFixed(3);
      }
      // 底板与光：薰衣草底溶掉，露出首页壁纸层。有窗时底板的撤离跟着纸面的前缘走——底板的遮罩是纸面遮罩的补集（同一条边：窗让开多少、底板撤多少、纸露出多少），
      // 左半屏的亮度单调上升，不会先灰一下再被纸盖亮（评审 R4）；纸面左缘以左的那一条（左栏）留到纸面铺满之后（bg）再整体淡掉
      const withWin = !!(fit && stageArch && figEl);
      const bgA = withWin ? st.bg : st.bgF;
      glowEl.style.opacity = plate.style.opacity = el.bgd.style.opacity = (1 - bgA).toFixed(3);
      if (withWin && anchors.main && winLeft !== undefined) {
        const xe = paperEdge(winLeft, 0, st.winL);
        const m1 = plateMask(xe, anchors.main.x, 1);
        const mk = plateMask(xe, anchors.main.x, k);
        if (m1) { plate.style.setProperty('mask-image', m1); el.bgd.style.setProperty('mask-image', mk); glowEl.style.setProperty('mask-image', mk); }
        else { plate.style.removeProperty('mask-image'); el.bgd.style.removeProperty('mask-image'); glowEl.style.removeProperty('mask-image'); }
      }
      // 枝、白花、雪、光尘、提示：随场景淡出
      const a = st.scene;
      fx.style.opacity = (1 - a).toFixed(3);
      for (const [n, base] of fades) n.style.opacity = (base * (1 - a)).toFixed(3);
      for (const [n, base] of textFades) n.style.opacity = (base * (1 - st.textOut)).toFixed(3);
      // 标题：还没浮现出来（或只出了一半）的从它此刻的状态起——不带的从 base 淡出，带着走的把 reveal 收完，不会在打断的那一帧冒出来。
      // 「栖枝」与 ALIGHT 是一个整体（titleGroupAt）：以「栖」的左上角为组锚缩放，ALIGHT 前 35% 的行程里从居中收成左对齐；字色 / 阴影一路收敛到字标的样子（tint）
      const gone = st.titleOut >= 1 ? 'hidden' : '';
      const grp = grpSrc ? titleGroupAt(grpSrc, st.title) : undefined;
      if (fh1) {
        h1.style.transform = flipCss(grp ? grp.h1Flip : flipAt(fh1, st.title), k); h1.style.letterSpacing = `${lerp(lsH1, anchors.nameLS, st.title).toFixed(4)}em`; h1.style.opacity = (1 - st.titleOut).toFixed(3); h1.style.visibility = gone;
        h1.style.color = tintColor(DAY_TITLE_COLOR, nameRgb, st.tint);
        h1.style.textShadow = st.tint >= 0.999 ? 'none' : `0 2px 0 rgb(255 255 255 / ${(0.9 * (1 - st.tint)).toFixed(3)}), 0 10px 30px rgb(120 86 168 / ${(0.28 * (1 - st.tint)).toFixed(3)})`;
        el.ch.forEach((c, i) => settleReveal(c, chBase[i], st.title));
      } else el.ch.forEach((c, i) => { c.style.opacity = (chBase[i].op * (1 - a)).toFixed(3); });
      if (fen) {
        el.enSpan.style.transform = flipCss(grp ? flipTo(enBox, enSrc, grp.enRect) : flipAt(fen, st.title), k); el.enSpan.style.letterSpacing = `${lerp(lsEn, anchors.subLS, st.title).toFixed(4)}em`; el.enSpan.style.visibility = gone;
        el.enSpan.style.color = tintColor(DAY_EN_COLOR, subRgb, st.tint);
        el.enSpan.style.opacity = ((enBase.op + (1 - enBase.op) * st.title) * (1 - st.titleOut)).toFixed(3);
        el.enSpan.style.filter = enBase.blur * (1 - st.title) > 0.05 ? `blur(${(enBase.blur * (1 - st.title)).toFixed(2)}px)` : 'none';
      } else el.enSpan.style.opacity = (enBase.op * (1 - a)).toFixed(3);
      el.credit.style.opacity = (crBase * (1 - st.ambient)).toFixed(3);       // 署名不飞：原地淡出（拱窗里的真署名在 0.70–0.92 s 原地淡入）
      // 枝与蝶
      if (twigFx) twigFx.update(st.flyRaw, st.swapOut, start && goal && path && st.swapOut < 1 ? bfBox(bfFlight(start, goal, path, st.fly, st.flap, tr)) : null);
      if (start && goal && path && st.swapOut < 1) {
        const pose = bfFlight(start, goal, path, st.fly, st.flap, tr);
        placeBf({ x: pose.x / k, y: pose.y / k, rot: pose.rot, sc: pose.w / (BF_SPAN * k), flap: pose.flap, pose: fold0 * (1 - sstep(win(st.fly, 0, 0.35))), alpha: pose.alpha * (1 - st.swapOut), flying: true, qf: st.fly });
      } else if (hasBf) placeBf(null);
      drawDust(st, tr);
    }

    /** 此刻标题（栖枝、ALIGHT）占的矩形（尾流的障碍物，也是光尘不画的地方）. */
    function titleRects(tr: number): Rect[] {
      const st = trState('day', kind, tr);
      const out: Rect[] = [];
      if (st.titleOut >= 1) return out;
      const g = grpSrc ? titleGroupAt(grpSrc, st.title) : undefined;
      if (fh1) out.push(g ? g.h1Rect : flipRectAt(h1Box, h1Src, flipAt(fh1, st.title)));
      if (fen) out.push(g ? g.enRect : flipRectAt(enBox, enSrc, flipAt(fen, st.title)));
      return out;
    }

    /** 此刻在界面上方飞的东西：标题、副标题、蝶（应用侧的元素等它们飞过再浮现） */
    function obstacles(tr: number): Rect[] {
      const st = trState('day', kind, tr);
      const out = titleRects(tr);
      if (start && goal && path && st.swapOut < 1) { const pose = bfFlight(start, goal, path, st.fly, st.flap, tr); if (pose.alpha > 0.1) out.push(bfBox(pose)); }
      return out;
    }

    /** 此刻盖在界面上方的窗（屏幕像素）：应用侧的文字等它的边缘越过自己再浮现，不被一条竖直的边切掉一半（评审 R2：归来简的卡片被窗切着走）. */
    function cover(tr: number): Rect[] {
      if (!fit || !stageArch || !figEl) return [];
      const st = trState('day', kind, tr);
      const { r, zw } = windowAt(st.art, st.winL);
      return [stageToScreen(r, zw, DC.A, k)];
    }

    return {
      shared: { mark: hasBf, title: !!fh1, credit: false, creditFade: !!anchors.credit, push: false, fig: !!figEl, figFade: !figEl && !!anchors.fig && !!anchors.arch },
      render: renderTr,
      obstacles,
      cover,
      dispose() {
        bfc.remove();
        twigFx?.el.remove();
        figEl?.remove();
        archBg?.remove();
        archFog?.remove();
        archDeco?.remove();
        archFlw?.remove();
        frame?.remove();
        shadowCv?.remove();
        const back = (n: HTMLElement | SVGElement) => { n.style.transform = ''; n.style.transformOrigin = ''; n.style.visibility = ''; n.style.letterSpacing = ''; };
        back(h1); back(el.enSpan); back(el.credit); back(el.art);
        h1.style.opacity = '';
        el.art.style.opacity = '';
        el.bloom.style.clipPath = '';
        el.bloom.style.opacity = '';
        plate.style.opacity = '';
        el.bgd.style.opacity = '';
        q1(host, '.s0-glow').style.opacity = '';
        fx.style.opacity = '';
        for (const [n] of fades) n.style.opacity = '';
        for (const [n] of textFades) n.style.opacity = '';
        el.ch.forEach((c) => { c.style.opacity = ''; });
        h1.style.color = ''; h1.style.textShadow = ''; el.enSpan.style.color = '';
        for (const n of [plate, el.bgd, glowEl]) n.style.removeProperty('mask-image');
        render(from);
      },
    };
  }

  function render(t: number) {
    if (vidOn) { renderLive(t); return; }
    const z = renderStage(t);
    if (vidMaster) {
      // 视频母版：ovTo 起立绘 / 近景散花由实时 DOM 层承担，视频里不再有；fx 只画 A 类
      const cut = t >= DAY_VID.ovTo;
      el.art.style.visibility = cut ? 'hidden' : '';
      el.near2.style.visibility = cut ? 'hidden' : '';
      masterOvRemap(t);
      renderFx(t, z, 'base');
    } else renderFx(t, z);
    if (!layersBg) renderDom(t);
  }
  /** 视频母版里「立绘 + 近景散花」这一组的不透明度重映射，让 DOM 清晰层淡入（opacity q，叠在视频之上）时在羽化带里也恰好得到「清晰版的 over 结果」：
      立绘有一条很宽的 CSS 蒙版羽化（左 / 右两侧大半幅的 α 在 0–1 之间），直接把「视频里有立绘」与「DOM 层按 q 淡入」叠起来是两次 over，羽化带会比正确值暗（实测 10 个色阶、
      3.0 s 视频撤掉立绘时一个跳变）。设立绘组的合成 α = a，视频里该组的 α 取 f(a, q) = a (1 − q) / (1 − q a)，DOM 层 α = q a 叠上去：
        (1 − q a)·[(1 − f)·B + f·A_视频] + q a·A_DOM，B 的系数 = (1 − q a)(1 − f) = 1 − a，恰好；q = 0 时 f = a（与之前逐位相同），q = 1 时 f = 0（视频里没有立绘）。
      做法：立绘与近景散花装进一个 wrapper，wrapper 套一个只改 α 通道的 SVG feComponentTransfer（table，64 档；wrapper 在蒙版之后，滤镜看得到 a）。只在导出母版里有。 */
  let remap: { wrap: HTMLElement; fn: SVGElement } | null = null;
  const REMAP_N = 64;
  function masterOvRemap(t: number) {
    if (!remap) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(NS, 'svg');
      svg.setAttribute('width', '0'); svg.setAttribute('height', '0'); svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none';
      svg.innerHTML = `<filter id="${K}vq" x="-500" y="-500" width="3600" height="3000" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feComponentTransfer><feFuncA type="table" tableValues="0 1"/></feComponentTransfer></filter>`;
      host.appendChild(svg);
      const wrap = document.createElement('div');
      wrap.className = 'bd-vwrap';
      wrap.style.cssText = 'position:absolute;left:0;top:0;width:1600px;height:1000px;pointer-events:none';
      el.bloom.insertBefore(wrap, el.art);
      wrap.appendChild(el.art);
      wrap.appendChild(el.near2);
      remap = { wrap, fn: svg.querySelector('feFuncA') as SVGElement };
    }
    const q = E.ease(win(t, DAY_VID.ovFrom, DAY_VID.ovTo));
    if (q <= 0 || q >= 1) { remap.wrap.style.filter = 'none'; return; }
    const tv: string[] = [];
    for (let i = 0; i <= REMAP_N; i++) {
      const a = i / REMAP_N;
      tv.push((a * (1 - q) / (1 - q * a)).toFixed(5));
    }
    remap.fn.setAttribute('tableValues', tv.join(' '));
    remap.wrap.style.filter = `url(#${K}vq)`;
  }
  function setLayers(mode: 'all' | 'bg' | 'vid') {
    layersBg = mode !== 'all';
    vidMaster = mode === 'vid';
    el.dtext.style.visibility = layersBg ? 'hidden' : '';
    el.bfwrap.style.visibility = vidMaster ? 'hidden' : '';
    el.snow.style.visibility = vidMaster ? 'hidden' : '';
    twigSvg.style.display = vidMaster ? 'none' : '';        // 视频母版不含枝（枝身 + 白花 + 落蝶光晕整层由实时画；display:none，因为 twbody 的 visibility 是 JS 写的 visible，盖得过父层的 hidden）
    if (!vidMaster) { el.art.style.visibility = ''; el.near2.style.visibility = ''; }
  }
  const video: SceneVideo = { note: (mt: number) => { vidMedia = mt; }, begin: vidBegin, get active() { return vidOn; }, preraster: vidPreraster, handoff: vidHandoff };

  return {
    theme: 'day',
    duration: T_END,
    ready,
    video,
    setLayers,
    render,
    resize,
    prepare,
    settle,
    prepareTransition,
    dispose() {
      gone = true;
      for (const a of fadeAnims) { try { a.cancel(); } catch { /* 无所谓 */ } }
      fadeAnims = [];
      fgen++; window.clearTimeout(prepTimer); window.clearTimeout(freeTimer); bcv = null; bcvOn = false; stripDom.length = 0; flDom = null;
      if (bkb?.url) URL.revokeObjectURL(bkb.url);
      bkb = null;
      twGen++; window.clearTimeout(twTimer); tw = null; baked = null; host.innerHTML = ''; fx.width = 0; fx.height = 0;
    },
  };
}
