/* 开屏 · 夜「蝶落枝头」。Canvas 2D（光场 multiply + lighter 特效）＋DOM 文字，时刻 t 的纯函数。
   分镜见 design/boot/STORYBOARD.md §2；这里是 design/boot/proto/index.html 夜版的移植（逻辑逐段对应）。
   层（自下而上）：bg 画布（原图＋人物岛＋光场＋水面碎光＋点灯）→ 顶/左/下暗纱（DOM，缓出渐变）→ 颗粒 → fx 画布（雪、蝶、轨迹、落点）→ 文字。
   暗纱：v3 起整条骨龙在素材里已溶成一团无轮廓的柔雾（tools/make_night_layers.py），DOM 暗纱用 smoothstep 色标羽化，再盖一层细颗粒。 */
import { E, TAU, clamp, easedStops, grainTile, invFlight, lerp, mulberry32, pathAt, sstep, win } from './bootMath';
import type { Seg } from './bootMath';
import { BOOT_MAX_DPR, boxRect, fadeTo, loadImg, lsEm, mk, q1, qa, radialSprite, rangeRect, reveal, revealBase, seedStrokes, seedSVG, settleReveal, svgToCanvas, unionRect } from './bootDom';
import type { BackdropXf, BootScene, Rect, SceneOptions, SceneTransition, TrOptions } from './bootTypes';
import { bootImpl } from './bootImpl';
import { tp } from './prof';
import { bootGovernor } from './governor';
import { nightChannels, nightTitleChannels } from './nightComp';
import { learnedRefresh } from './pacer';
import { ClockGroup } from './sampler';
import type { Channel } from './channels';
import { NIGHT_EN_COLOR, bfBox, bfFlight, brandGoal, createTwigFx, dissolveAlpha, dustDots, flightPath, flipAt, flipCss, flipRectAt, flipRight, flipTo, holeClip, holeEdge, navPushable, nightSegs, parseRgb, plateFit, plateResidual, tintColor, tintGlow, tintGradient, titleGroupAt, trDuration, trState, twigFootScreen, twigOpen, wallpaperTx, type BfPose, type Flip, type TitleGroup, type TwigFx } from './transition';

const T_END = 7.6;
/** 夜的时间表（秒） */
// 暗纱（shade）等落地那一拍的柔光脉冲（4.9–5.4 s）走完再收：落点不能在高潮刚发生时四周就熄灯
export const NT = { cam: 5.6, dot: [2.15, 2.62], unfurl: [2.5, 3.0], fly: [3.0, 4.9], shade: [5.0, 6.8], seed: 5.4, ground: [2.0, 5.6] } as const;
export const NP = {
  finger: [0.443, 0.654],
  birth: [0.415, 0.6],                 // 新蝶出生点：离画中指尖蝶 ≥ 0.03 W
  dotFrom: [0.431, 0.628],             // 光点从画中蝶的左上翅缘脱出
  land: [0.2373, 0.8216],              // 休止位置：身体与细足落在枝梢上（比样稿的锚点低 6 px@1080，让细足压在枝梢上）
  landRot: (-14 * Math.PI) / 180,      // 分镜 §1.1：休止姿态 rotate(−14°)，侧身半合翅
  /** 路径 A（审查后）：自指尖前出发，小弧（最高处 v≥0.59，不再爬到标题块旁）→ 越过花环上缘斜落 → 枯枝；形状与样稿 s0 的点线一致（一条清爽的斜线）。三段弧长接近，点距均匀 */
  pathA: [
    [[0.415, 0.6], [0.39, 0.5907], [0.3716, 0.6375], [0.351, 0.6593]],
    [[0.351, 0.6593], [0.3305, 0.681], [0.3107, 0.7044], [0.2917, 0.7306]],
    [[0.2917, 0.7306], [0.2727, 0.7567], [0.2578, 0.7843], [0.2373, 0.8216]],
  ] as readonly Seg[],
  /** 河道光前沿：自她指尖下的 G1 起，顺流向远处（u, v, 到达时间） */
  river: [[0.5, 0.78, 0.3], [0.46, 0.755, 0.34], [0.415, 0.735, 0.45], [0.375, 0.715, 0.65], [0.34, 0.7, 0.85], [0.3, 0.68, 1.0], [0.269, 0.66, 1.15], [0.228, 0.628, 1.35], [0.188, 0.595, 1.55], [0.157, 0.569, 1.75], [0.126, 0.543, 1.95], [0.085, 0.52, 2.15], [0.04, 0.5, 2.35]] as ReadonlyArray<readonly [number, number, number]>,
  /** 花环：G1 在她指尖正下方，之后顺流 G2→G3→G4，间隔 ≥ 0.45 s */
  wreaths: [{ u: 0.415, v: 0.735, hw: 0.085, t: 0.3 }, { u: 0.269, v: 0.66, hw: 0.042, t: 0.85 }, { u: 0.188, v: 0.595, hw: 0.032, t: 1.35 }, { u: 0.126, v: 0.543, hw: 0.022, t: 1.8 }],
  /** 水面多边形与排除椭圆（与 tools/make_night_layers.py 同一份） */
  water: [[0, 0.47], [0.1, 0.46], [0.2, 0.475], [0.25, 0.495], [0.3, 0.52], [0.35, 0.535], [0.4, 0.55], [0.45, 0.565], [0.455, 0.6], [0.47, 0.7], [0.53, 0.705], [0.545, 0.72], [0.58, 0.74], [0.595, 0.8], [0.6, 0.86], [0.56, 0.915], [0.45, 0.925], [0.36, 0.92], [0.36, 0.745], [0.2, 0.745], [0, 0.76]] as ReadonlyArray<readonly [number, number]>,
  waterHoles: [[0.415, 0.738, 0.092, 0.05], [0.268, 0.652, 0.05, 0.026], [0.188, 0.586, 0.04, 0.021], [0.128, 0.541, 0.03, 0.015]] as ReadonlyArray<readonly [number, number, number, number]>,
};
/** night-island.json：人物岛在 2560×1440 底图里的位置（make_night_layers.py 写出） */
const ISL = { x: 1028, y: 18, w: 1532, h: 1390 };
const IMG_W = 2560;
const IMG_H = 1440;

interface Blob { u: number; v: number; t: number; rad: number; a: number }
interface Glint { seed: number; T: number; ph: number; L: number; len: number; th: number; a: number; ck: number; cp: [number, number, number] }
/** 轨迹的一粒光点。op = 飞行时的亮度，opRest = 定格时的亮度（只随离落点的远近单调增）；dense 的那 14 粒只为 t≈4.2 s 的截图帧加密，落地后收回 */
interface TrailDot { q: number; du: number; dv: number; op: number; opRest: number; rad: number; hz: boolean; dense: boolean; hzKeep: boolean; fade: boolean; keep: boolean; uv: [number, number] }

/** 定格时一粒光点的亮度：越近落点越亮，严格随进度 q 单调增（最亮的几粒挨着落点）. */
export const trailRestOpacity = (q: number) => 0.3 + 0.7 * Math.pow(clamp(q), 1.25);
/** 定格时轨迹只留 7 粒：离落点的路程（按 1920×1080 的像素算）按 1.34 的几何级数拉开——72、97、129、173、232、311、417 px（第一粒在蝶翼之外：蝶的方框半宽约 50 px，R5 起最近一粒 ≥ 70 px、
    与第二粒隔 24 px 以上，不再「••」并排贴在翅尖），沿真实飞行路径 A 取点（不是弦线），每粒再沿路径法向左右交替抖 ±6–10 px（REST_TAIL.jitter），
    尺寸与亮度各随机 ±30%；其余的光点在蝶落定后 0.6–1.4 s 里淡掉。原来 36 + 14 粒近乎等距地排成一条虚线，读成加载指示（评审 R4）；7 粒落在同一条直的斜线上仍读成虚线（评审 R5）. */
export const REST_TAIL = { n: 7, s0: 72, ratio: 1.34, jitter: [6, 10] as const } as const;
export const restTailDist = (k: number) => REST_TAIL.s0 * Math.pow(REST_TAIL.ratio, k);
/** 路径 A 上离落点 s px 处的进度 q（弧长按 1920×1080 的像素算）. */
export function pathQAtDistFromEnd(s: number): number {
  const N = 600;
  const pts = Array.from({ length: N + 1 }, (_, i) => pathAt(NP.pathA, Math.min(0.9999, i / N)).p);
  let acc = 0;
  const cum = [0];
  for (let i = 1; i <= N; i++) { acc += Math.hypot((pts[i][0] - pts[i - 1][0]) * 1920, (pts[i][1] - pts[i - 1][1]) * 1080); cum.push(acc); }
  const target = acc - s;
  if (target <= 0) return 0;
  let i = 1;
  while (i < N && cum[i] < target) i++;
  return (i - 1 + (target - cum[i - 1]) / Math.max(1e-9, cum[i] - cum[i - 1])) / N;
}
/** 落点的涟漪：落在枝下的水面上（中心比蝶的中心低 82 px），上缘比蝶的方框下缘（中心下 43 px）还低——不再套在蝶身上读成「悬停在水面上」（评审 R4）. */
export const RIPPLE = { cy: 82, rings: [[50, 14], [98, 29]] as ReadonlyArray<readonly [number, number]>, sclMax: 1.18, alpha: [0.12, 0.08] as ReadonlyArray<number> } as const;
export const REST_BF_HALF_H = 43;
interface Flake { li: number; i: number; n: number; x0: number; y0: number; rad: number; vy: number; vx: number; a: number; amp: number; per: number; ph: number }
interface BfNight { u: number; v: number; rot: number; size: number; flapX: number; alpha: number; flying: boolean; qf: number }

export function createNightScene(o: SceneOptions): BootScene {
  const { host } = o;
  const P = (n: string) => `${o.base}boot/${n}`;

  /* ───────── DOM ───────── */
  const gtile = grainTile();
  // comp（合成器优先）实现：底板多两层包装——.boot__hole（overflow:hidden 的「洞」持有者，转场里 translateX(X)）与 .boot__plate-body（内层反向 translateX(−X)，净位移为 0），
  // 洞的硬边由合成器的矩形裁切 + 反向平移得到（不再每拍写 clip-path）。legacy 保持原来的 DOM.
  const comp = bootImpl() === 'comp';
  host.classList.toggle('is-comp', comp);
  const plateInner = `
      <canvas class="boot__bg" aria-hidden="true"></canvas>
      <div class="boot__shade-top"></div>
      <div class="boot__shade"></div><div class="boot__shade-bot"></div>
      <div class="boot__grain"></div>`;
  host.innerHTML = `
    <div class="boot__plate">${comp ? `<div class="boot__hole"><div class="boot__plate-body">${plateInner}</div></div>` : plateInner}
    </div>
    <canvas class="boot__fx" aria-hidden="true"></canvas>
    <div class="boot__title" aria-hidden="true">
      <h1><span class="c">栖</span><span class="c">枝</span></h1>
      <h1 class="sweep">栖枝</h1>
      <p class="boot__en">ALIGHT</p>
      <div class="boot__rule"><i></i>${seedSVG(14)}<i></i></div>
      <p class="boot__sub">遐蝶的 Agent 工作台</p>
    </div>
    <p class="boot__enter" aria-hidden="true">${seedSVG(44)}<span>按任意键进入</span></p>
    <p class="boot__skip" aria-hidden="true">Esc 或任意键跳过</p>
    <p class="boot__ver" aria-hidden="true">ALIGHT · ${o.version}</p>
    <p class="boot__credit" data-credit="boot" aria-hidden="true">${o.credit}</p>`;

  const bg = q1<HTMLCanvasElement>(host, '.boot__bg');
  const fx = q1<HTMLCanvasElement>(host, '.boot__fx');
  const shadeTop = q1(host, '.boot__shade-top');
  const shade = q1(host, '.boot__shade');
  const shadeBot = q1(host, '.boot__shade-bot');
  const grain = q1(host, '.boot__grain');
  const el = {
    h1: q1(host, '.boot__title h1:not(.sweep)'),
    ch: qa(host, '.boot__title h1:not(.sweep) .c'),
    sweep: q1(host, '.boot__title h1.sweep'),
    en: q1(host, '.boot__en'),
    rule: qa(host, '.boot__rule i'),
    ruleSeed: qa<SVGElement>(host, '.boot__rule .seed path'),
    sub: q1(host, '.boot__sub'),
    enterTxt: q1(host, '.boot__enter > span'),
    enterSeed: q1<SVGElement>(host, '.boot__enter .seed'),
    enterStrokes: qa<SVGElement>(host, '.boot__enter .seed .s'),
    enterBase: qa<SVGElement>(host, '.boot__enter .seed .b'),
    skip: q1(host, '.boot__skip'),
    ver: q1(host, '.boot__ver'),
    credit: q1(host, '.boot__credit'),
    title: q1(host, '.boot__title'),
  };

  // 暗纱：smoothstep 色标（边缘羽化干净，没有马赫带）；整套只写一次
  const VEIL = '14 10 34';
  const VEIL2 = '11 9 24';
  shadeTop.style.background = `linear-gradient(180deg, ${easedStops(VEIL2, 0.86, 0, 14)})`;
  shadeTop.style.setProperty('mask-image', `linear-gradient(90deg, #000 0%, ${easedStops('0 0 0', 1, 0, 10, 52, 84)})`);
  shade.style.background = [
    `linear-gradient(90deg, ${easedStops(VEIL, 0.5, 0, 12, 0, 56)})`,
    `radial-gradient(ellipse 40vw 44vh at 20.6vw 47vh, ${easedStops(VEIL, 0.74, 0, 14)})`,
    `radial-gradient(ellipse 20.6vw 7vh at 16.9vw 90.6vh, ${easedStops(VEIL, 0.55, 0, 10)})`,
    `linear-gradient(90deg, rgb(${VEIL} / 0) 0%, rgb(${VEIL} / 0) 53.75%, ${easedStops(VEIL, 0, 0.19, 10, 53.75, 72)})`,
  ].join(', ');
  shadeBot.style.background = `linear-gradient(0deg, ${easedStops(VEIL2, 0.55, 0, 12)})`;
  shadeBot.style.setProperty('mask-image', `linear-gradient(90deg, transparent 0%, transparent 22%, ${easedStops('0 0 0', 0, 1, 10, 22, 56)})`);
  if (gtile) grain.style.backgroundImage = `url("${gtile}")`;

  const bctx = bg.getContext('2d', { alpha: false })!;
  const fctx = fx.getContext('2d')!;
  const lm = mk();
  const lL = mk();            // 光场（半分辨率）
  const glc = mk();           // 水面碎光层（用水面蒙版裁剪后再叠加）
  const lmg = lm.getContext('2d')!;
  const lLg = lL.getContext('2d')!;
  const glg = glc.getContext('2d')!;

  /* ───────── 精灵 ───────── */
  const SPR: Record<string, HTMLCanvasElement> = {};
  (() => {
    const stops: Array<[number, string]> = [];
    const n = 12;
    for (let i = 0; i <= n; i++) { const r = i / n; const a = Math.max(0, (Math.exp(-3.2 * r * r) - Math.exp(-3.2)) / (1 - Math.exp(-3.2))); stops.push([r, `rgba(255,255,255,${a.toFixed(4)})`]); }
    SPR.blob = radialSprite(256, stops);
    SPR.plateau = radialSprite(256, [[0, 'rgba(255,255,255,1)'], [0.5, 'rgba(255,255,255,1)'], [0.78, 'rgba(255,255,255,.35)'], [1, 'rgba(255,255,255,0)']]);
    SPR.glowBlue = radialSprite(128, [[0, 'rgba(143,208,255,1)'], [0.35, 'rgba(143,208,255,.45)'], [1, 'rgba(143,208,255,0)']]);
    SPR.hz = radialSprite(64, [[0, 'rgba(124,200,247,.9)'], [0.4, 'rgba(124,200,247,.35)'], [1, 'rgba(124,200,247,0)']]);
    SPR.snow = radialSprite(32, [[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,.85)'], [0.7, 'rgba(255,255,255,.25)'], [1, 'rgba(255,255,255,0)']]);
    SPR.land = radialSprite(256, [[0, 'rgba(159,216,255,.16)'], [0.22, 'rgba(143,208,255,.46)'], [0.5, 'rgba(122,143,232,.2)'], [1, 'rgba(122,127,232,0)']]);
    SPR.shadow = radialSprite(128, [[0, 'rgba(12,10,30,.6)'], [0.5, 'rgba(12,10,30,.45)'], [1, 'rgba(12,10,30,0)']]);
    // 水面碎光：水平细亮线，上下再羽化
    const c = mk(64, 8);
    const g = c.getContext('2d')!;
    const gr = g.createLinearGradient(0, 0, 64, 0);
    gr.addColorStop(0, 'rgba(207,230,255,0)'); gr.addColorStop(0.5, 'rgba(207,230,255,1)'); gr.addColorStop(1, 'rgba(207,230,255,0)');
    g.fillStyle = gr; g.fillRect(0, 2, 64, 4);
    const gv = g.createLinearGradient(0, 0, 0, 8);
    gv.addColorStop(0, 'rgba(0,0,0,0)'); gv.addColorStop(0.5, 'rgba(0,0,0,1)'); gv.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'destination-in'; g.fillStyle = gv; g.fillRect(0, 0, 64, 8);
    SPR.glint = c;
    // 火种第五笔点亮时的十字微光
    const x = mk(64, 64);
    const xg = x.getContext('2d')!;
    const h = xg.createLinearGradient(0, 32, 64, 32);
    h.addColorStop(0, 'rgba(212,236,255,0)'); h.addColorStop(0.5, 'rgba(255,255,255,1)'); h.addColorStop(1, 'rgba(212,236,255,0)');
    xg.fillStyle = h; xg.fillRect(0, 30, 64, 4);
    const v = xg.createLinearGradient(32, 0, 32, 64);
    v.addColorStop(0, 'rgba(212,236,255,0)'); v.addColorStop(0.5, 'rgba(255,255,255,1)'); v.addColorStop(1, 'rgba(212,236,255,0)');
    xg.fillStyle = v; xg.fillRect(30, 0, 4, 64);
    const rg = xg.createRadialGradient(32, 32, 0, 32, 32, 12);
    rg.addColorStop(0, 'rgba(255,255,255,.95)'); rg.addColorStop(1, 'rgba(255,255,255,0)');
    xg.fillStyle = rg; xg.fillRect(0, 0, 64, 64);
    SPR.cross = x;
  })();

  /* 蓝闪蝶（Sprite.tsx 的 alt-bf 路径；与样稿终帧同一只），矢量渲染成 480×384 的位图一次 */
  const WING_A = 'M20 15.2C17.2 7.2 9.6 2 4.6 4.2 2 5.5 2.6 10.8 7.2 15.4c3.5 3 8 2.4 12.8-.2z';
  const WING_B = 'M20 16.6C14.9 16.8 9 19.2 8.8 24c-.1 4.4 4.2 5.8 7.2 3.2 2.6-2.3 3.5-6.6 4-10.6z';
  const VEIN = 'M19 15C14.6 11.4 10 8 6.4 6.4M19 15.2C14.4 14.8 10 13.4 7.4 11.2M19.2 16.8C15.6 18.6 12 21.2 10.6 24.6M19.4 17.2C18 20 16.8 23.4 16.4 26.2';
  const MIR = 'transform="translate(40 0) scale(-1 1)"';
  const BF_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 32" width="480" height="384"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#62cdf0"/><stop offset=".55" stop-color="#6f9aee"/><stop offset="1" stop-color="#7a63e0"/></linearGradient></defs>
<g stroke="#1b1e52" stroke-opacity=".62" stroke-width="1.3" stroke-linejoin="round" fill="url(#g)"><path d="${WING_A}"/><path d="${WING_B}"/><path ${MIR} d="${WING_A}"/><path ${MIR} d="${WING_B}"/></g>
<g stroke="#1b1e52" stroke-width=".8" opacity=".6" fill="none" stroke-linecap="round"><path d="${VEIN}"/><path ${MIR} d="${VEIN}"/></g>
<path d="M20 9.6v17.4" stroke="#1b1e52" stroke-opacity=".78" stroke-width="1.8" stroke-linecap="round"/><path d="M20 10c-.7-2.6-2.2-4.2-4.2-5M20 10c.7-2.6 2.2-4.2 4.2-5" stroke="#1b1e52" stroke-opacity=".7" stroke-width=".9" fill="none" stroke-linecap="round"/></svg>`;

  /* ───────── 确定性数据（只在创建时算一次） ───────── */
  const BLOBS: Blob[] = (() => {
    const out: Blob[] = [];
    const r = NP.river;
    for (let i = 0; i < r.length; i++) out.push({ u: r[i][0], v: r[i][1], t: r[i][2], rad: i < 3 ? 0.2 : i > r.length - 3 ? 0.2 : 0.16, a: 1 });
    out.push({ u: 0.47, v: 0.66, t: 0.4, rad: 0.13, a: 1 });        // 指尖与手
    out.push({ u: 0.56, v: 0.58, t: 0.55, rad: 0.2, a: 0.95 });     // 手臂
    out.push({ u: 0.64, v: 0.52, t: 0.8, rad: 0.26, a: 0.95 });     // 躯干
    out.push({ u: 0.63, v: 0.72, t: 1.0, rad: 0.27, a: 0.9 });      // 腰腿
    out.push({ u: 0.57, v: 0.25, t: 1.45, rad: 0.22, a: 0.9 });     // 脸与发
    out.push({ u: 0.8, v: 0.46, t: 1.85, rad: 0.28, a: 0.85 });     // 发尾
    return out;
  })();
  const inWater = (x: number, y: number) => {
    let c = false;
    const p = NP.water;
    for (let i = 0, j = p.length - 1; i < p.length; j = i++) {
      if (((p[i][1] > y) !== (p[j][1] > y)) && (x < ((p[j][0] - p[i][0]) * (y - p[i][1])) / (p[j][1] - p[i][1]) + p[i][0])) c = !c;
    }
    if (!c) return false;
    for (const [cu, cv, ru, rv] of NP.waterHoles) if (((x - cu) / ru) ** 2 + ((y - cv) / rv) ** 2 < 1) return false;
    return true;
  };
  const frontT = (u: number) => {
    const rv = NP.river;
    if (u >= rv[0][0]) return rv[0][2];
    for (let i = 0; i < rv.length - 1; i++) if (u >= rv[i + 1][0]) return lerp(rv[i + 1][2], rv[i][2], (u - rv[i + 1][0]) / (rv[i][0] - rv[i + 1][0]));
    return rv[rv.length - 1][2] + (rv[rv.length - 1][0] - u) * 3;
  };
  const GLINTS: Glint[] = (() => {
    const r = mulberry32(20241024);
    const out: Glint[] = [];
    for (let i = 0; i < 36; i++) out.push({ seed: 1000 + i * 977, T: 2.6 + r() * 2.2, ph: r() * 4, L: 1.6 + r() * 0.8, len: 0.006 + r() * 0.014, th: 1.2 + r() * 0.6, a: 0.28 + r() * 0.17, ck: -1, cp: [0.3, 0.6, 3] });
    return out;
  })();
  /** 碎光的位置：只落在水面多边形内（并避开花环）；同一个周期 k 只算一次 */
  const glintPos = (g: Glint, k: number): [number, number, number] => {
    if (g.ck === k) return g.cp;
    const rr = mulberry32(g.seed + k * 7919);
    let res: [number, number, number] = [0.3, 0.6, 3];
    for (let n = 0; n < 60; n++) {
      const u = rr() * 0.6;
      const v = 0.46 + rr() * 0.47;
      if (inWater(u, v)) { res = [u, v, frontT(u) + (v > 0.78 ? 0.8 : 0)]; break; }
    }
    g.ck = k;
    g.cp = res;
    return res;
  };
  /** 光点轨迹（沿路径 A）：36 粒均匀 ＋ 截图帧附近（q 0.40–0.66）再加密 14 粒、更亮 */
  const TRAIL: TrailDot[] = (() => {
    const r = mulberry32(11);
    const n = 36;
    const out: TrailDot[] = [];
    let di = 0;
    const push = (q: number, dense: boolean) => {
      const p = pathAt(NP.pathA, q).p;
      const k = dense ? di++ : 0;
      out.push({
        q, du: (r() - 0.5) * 12 * (1 - q * 0.5), dv: (r() - 0.5) * 12 * (1 - q * 0.5),
        op: Math.min(1, (0.5 + 0.5 * q) * (dense ? 1.25 : 1)), opRest: trailRestOpacity(q),
        rad: (1.5 + q * 2.2 * (0.6 + r() * 0.6)) * (dense ? 1.1 : 1), hz: dense ? true : out.length % 3 === 1,
        dense, hzKeep: dense && k % 3 === 0, fade: dense && k % 2 === 1, keep: false, uv: p,
      });
    };
    for (let k = 0; k < n; k++) push((k + 0.15 + r() * 0.7) / n, false);
    for (let k = 0; k < 14; k++) push(0.4 + (0.26 * (k + 0.2 + r() * 0.6)) / 14, true);
    // 定格时留下的 7 粒：把最靠近目标进度的 7 粒（非加密的）挪到按几何级数拉开的位置，尺寸 / 亮度各随机 ±30%
    const rj = mulberry32(61);
    const used = new Set<number>();
    for (let k = 0; k < REST_TAIL.n; k++) {
      const q = pathQAtDistFromEnd(restTailDist(k));
      let best = -1;
      out.forEach((d, i) => { if (!d.dense && !used.has(i) && (best < 0 || Math.abs(d.q - q) < Math.abs(out[best].q - q))) best = i; });
      if (best < 0) continue;
      used.add(best);
      const d = out[best];
      d.q = q;
      const pa = pathAt(NP.pathA, q);
      d.uv = pa.p;
      // 沿路径法向左右交替偏开 6–10 px（设计单位 = 1778 宽的图像素）：相邻两粒不在同一条线上
      const tx = pa.d[0] * 1778;
      const ty = pa.d[1] * 1000;
      const tl = Math.hypot(tx, ty) || 1;
      const off = (k % 2 ? -1 : 1) * lerp(REST_TAIL.jitter[0], REST_TAIL.jitter[1], rj());
      d.du = (-ty / tl) * off;
      d.dv = (tx / tl) * off;
      d.keep = true;
      d.hz = true;
      d.rad = (1.5 + q * 2.2) * (0.7 + 0.6 * rj());
      d.opRest = Math.min(1, trailRestOpacity(q) * (0.7 + 0.6 * rj()));
    }
    return out;
  })();
  const SNOW: Flake[] = (() => {
    const r = mulberry32(77);
    const out: Flake[] = [];
    const L = [{ n: 50, rad: [0.8, 1.2], vy: [10, 14], a: [0.25, 0.35], sw: [6, 16] }, { n: 30, rad: [1.4, 2.0], vy: [18, 24], a: [0.35, 0.5], sw: [6, 16] }, { n: 10, rad: [2.6, 4.0], vy: [34, 44], a: [0.22, 0.3], sw: [8, 16] }];
    L.forEach((l, li) => {
      for (let i = 0; i < l.n; i++) out.push({ li, i, n: l.n, x0: r(), y0: r(), rad: lerp(l.rad[0], l.rad[1], r()), vy: lerp(l.vy[0], l.vy[1], r()), vx: lerp(4, 10, r()), a: lerp(l.a[0], l.a[1], r()), amp: lerp(l.sw[0], l.sw[1], r()), per: lerp(5, 9, r()), ph: r() * TAU });
    });
    return out;
  })();
  /* ───────── 状态 ───────── */
  const IMG: { base?: HTMLImageElement; island?: HTMLImageElement; water?: HTMLImageElement; bf?: HTMLCanvasElement; bfGlow?: HTMLCanvasElement } = {};
  let W = 0;
  let H = 0;
  let R = 1;
  let imgW = 0;
  let imgH = 0;
  let tx = 0;
  let tbox: { l: number; t: number; r: number; b: number } | null = null;
  let seedPt: [number, number] | null = null;   // 火种第五笔的屏幕位置（布局时量一次，逐帧不再读布局）
  let auxOn = false;                            // 光场与碎光画布是否分配了内存（定格后释放）
  let bgFinal = false;                          // 背景画布已经画成最终的样子（comp：6.85 s 之后不再重画）
  let noBf = false;                             // 转场开始：停枝的蝶从 fx 画布撤下（由转场的蝶画布接手飞行）

  const ready = (async () => {
    const loads: Promise<unknown>[] = [
      loadImg(P('night-base.jpg')).then((i) => { IMG.base = i; }),
      loadImg(P('night-island.webp')).then((i) => { IMG.island = i; }),
      loadImg(P('night-water.png')).then((i) => { IMG.water = i; }),
      svgToCanvas(BF_SVG, 480, 384).then((c) => {
        IMG.bf = c;
        // 同形的柔光（预先模糊一次）：翅面之外一圈淡淡的光，像画中指尖那只发光的蝶，而不是一张贴纸
        const g = mk(480 + 160, 384 + 160);
        const gx = g.getContext('2d')!;
        gx.filter = 'blur(22px)';
        gx.drawImage(c, 80, 80);
        gx.filter = 'none';
        IMG.bfGlow = g;
      }),
      Promise.all([document.fonts.load('500 20px "Cinzel"', 'ALIGHT'), document.fonts.load('600 40px "Noto Serif SC"', '栖枝遐蝶的')]).catch(() => undefined),
    ];
    await Promise.all(loads);
    await document.fonts.ready;
  })();

  function setAux(on: boolean) {
    if (on === auxOn) return;
    auxOn = on;
    if (on) {
      lm.width = lL.width = Math.max(2, Math.ceil(W / 2));
      lm.height = lL.height = Math.max(2, Math.ceil(H / 2));
      glc.width = bg.width;
      glc.height = bg.height;
    } else {
      lm.width = lL.width = glc.width = 2;
      lm.height = lL.height = glc.height = 2;
    }
  }

  function layout() {
    imgW = Math.max(W, 1.7778 * H);
    imgH = imgW / 1.7778;
    tx = clamp(0.57 * (W - imgW), W - imgW, 160);
    const rr = [...el.ch, el.en, el.sub].map((n) => { const r0 = document.createRange(); r0.selectNodeContents(n); return r0.getBoundingClientRect(); });
    tbox = rr.reduce((a, r1) => ({ l: Math.min(a.l, r1.left), t: Math.min(a.t, r1.top), r: Math.max(a.r, r1.right), b: Math.max(a.b, r1.bottom) }), { l: 1e9, t: 1e9, r: -1e9, b: -1e9 });
    const rc = el.enterSeed.getBoundingClientRect();
    seedPt = [rc.left + rc.width * (45.6 / 48), rc.top + rc.height * (13.6 / 48)];
  }

  function resize(w: number, h: number, dpr: number) {
    W = w;
    H = h;
    R = o.capture ? 1 : Math.min(dpr || 1, BOOT_MAX_DPR, 2560 / w);
    for (const c of [bg, fx]) { c.width = Math.max(2, Math.round(W * R)); c.height = Math.max(2, Math.round(H * R)); }
    auxOn = false;
    setAux(true);
    bgFinal = false;
    layout();
  }

  /* ───────── 相机与蝶 ───────── */
  function nightCam(t: number) {
    const e = E.camera(win(t, 0, NT.cam));
    const z = 1 + 0.12 * (1 - e);
    const wu1 = W / imgW;
    const wv1 = H / imgH;
    const u0f = -tx / imgW;
    const cu = u0f + wu1 / 2 - 0.04 * (1 - e);
    const cv = wv1 / 2 + 0.02 * (1 - e);                     // 竖向 +0.02：冠顶上方留 ≈4.6% H
    const wu = wu1 / z;
    const wv = wv1 / z;
    const u0 = clamp(cu - wu / 2, 0, Math.max(0, 1 - wu));
    const v0 = clamp(cv - wv / 2, 0, Math.max(0, 1 - wv));
    return { e, z, u0, v0, sx: z * imgW, sy: z * imgH };
  }

  /** 蝶 · 夜：光点自画中指尖蝶的左上翅缘脱出 → 在出生点展翅 → 沿路径 A 飞 → 落枝（休止姿态） */
  function bfNight(t: number): BfNight | null {
    if (t < NT.unfurl[0]) return null;
    const unfurl = E.ease(win(t, NT.unfurl[0], NT.unfurl[1]));
    const qf = E.flight(win(t, NT.fly[0], NT.fly[1]));
    const phase = t < NT.fly[0] ? TAU * 1.6 * t : TAU * (1.6 * NT.fly[0] + 2.5 * (t - NT.fly[0]));
    const flapFl = 0.71 + 0.29 * Math.cos(phase);
    const tl = NT.fly[1];
    let p: [number, number];
    let rot: number;
    let size: number;
    let flapX: number;
    if (t < tl) {
      const { p: pp, d } = pathAt(NP.pathA, qf);
      p = [pp[0], pp[1]];
      const settle = clamp((qf - 0.8) / 0.2);
      const dpx = [d[0] * imgW, d[1] * imgH];
      const ang = Math.atan2(dpx[1], dpx[0]) + Math.PI / 2;
      rot = t < NT.fly[0] ? 0 : lerp(ang, NP.landRot, settle);
      // 飞行中不比画中指尖那只大多少（≤1.1 倍：0.5→0.56），最后四分之一路程才展到休止的大小（落枝前翅一展、近镜头一步）
      size = lerp(0.5 + 0.06 * sstep(qf / 0.75), 1, sstep((qf - 0.75) / 0.25));
      if (t < NT.fly[0]) size = lerp(0.42, 0.5, unfurl);
      if (t >= NT.fly[0]) {
        const nx = -dpx[1];
        const ny = dpx[0];
        const nl = Math.hypot(nx, ny) || 1;
        const f = 14 * (imgH / 1080) * Math.sin(Math.PI * qf) * Math.sin((TAU * (t - NT.fly[0])) / 0.9);
        p[0] += (nx / nl * f) / imgW;
        p[1] += (ny / nl * f) / imgH;
      }
      const settleF = E.settle(win(t, tl - 0.3, tl));
      flapX = lerp(flapFl, 1, settleF) * lerp(1, 0.85, settle) * (t < NT.fly[0] ? unfurl : 1);
    } else {
      p = [NP.land[0], NP.land[1]];
      rot = NP.landRot;
      size = 1.0;
      const tr = t - tl;
      let f: number;
      if (tr < 2.1) { const s = Math.sin(Math.PI * (tr / 0.7)); f = 1 - 0.45 * s * s; } else f = 0.9 + 0.1 * Math.cos((TAU * (tr - 2.1)) / 3.2);
      flapX = 0.85 * f;     // 侧身半合翅（scaleX .85）
    }
    return { u: p[0], v: p[1], rot, size, flapX, alpha: t < NT.fly[0] ? unfurl : 1, flying: t >= NT.fly[0] && t < tl, qf };
  }

  function drawBf(f: CanvasRenderingContext2D, x: number, y: number, unit: number, rot: number, flapX: number, alpha: number) {
    if (!IMG.bf) return;
    const w = unit * 100;
    const h = unit * 80;
    f.save();
    f.translate(x, y);
    f.rotate(rot);
    f.scale(Math.max(0.02, flapX), 1);
    f.globalAlpha = alpha;
    f.drawImage(IMG.bf, -w / 2, -h / 2, w, h);
    f.restore();
  }

  /** 蝶的同形柔光（lighter）：画布比蝶大 160 px 的边，按同一比例画 */
  function drawBfGlow(f: CanvasRenderingContext2D, x: number, y: number, unit: number, rot: number, flapX: number, alpha: number) {
    if (!IMG.bfGlow || alpha <= 0.002) return;
    const w = unit * 100 * (640 / 480);
    const h = unit * 80 * (544 / 384);
    f.save();
    f.translate(x, y);
    f.rotate(rot);
    f.scale(Math.max(0.02, flapX), 1);
    f.globalAlpha = alpha;
    f.drawImage(IMG.bfGlow, -w / 2, -h / 2, w, h);
    f.restore();
  }

  function drawSnow(f: CanvasRenderingContext2D, t: number, box: { x0: number; x1: number; y0: number; y1: number }) {
    const s = H / 1080;
    const ramp = clamp(t / 1.2);
    f.globalCompositeOperation = 'source-over';
    for (const p of SNOW) {
      const vis = clamp((ramp * 1.15 - (p.i / p.n) * 0.9) / 0.15);
      if (vis <= 0) continue;
      const mw = W + 60;
      const mh = H + 60;
      const x = ((((p.x0 * W + p.vx * s * t + p.amp * s * Math.sin((TAU * t) / p.per + p.ph)) % mw) + mw) % mw) - 30;
      const y = ((((p.y0 * H + p.vy * s * t) % mh) + mh) % mh) - 30;
      let a = p.a * vis;
      const bx = clamp(Math.min((x / W - box.x0) / 0.04, (box.x1 - x / W) / 0.04) + 0.5);
      const by = clamp(Math.min((y / H - box.y0) / 0.04, (box.y1 - y / H) / 0.04) + 0.5);
      a *= 1 - 0.65 * bx * by;
      const r = p.rad * s * 2.4;
      f.globalAlpha = a;
      f.drawImage(SPR.snow, x - r, y - r, 2 * r, 2 * r);
    }
    f.globalAlpha = 1;
  }

  /* ───────── 渲染 ───────── */
  function renderBg(t: number) {
    if (!IMG.base || !IMG.island || !IMG.water) return;
    const c = nightCam(t);
    const sx = c.sx;
    const sy = c.sy;
    const X = (u: number) => (u - c.u0) * sx;
    const Y = (v: number) => (v - c.v0) * sy;
    const u1 = sx / 1778;
    const s1 = H / 1080;
    const g = bctx;
    g.setTransform(R, 0, 0, R, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = '#0a0913';
    g.fillRect(0, 0, W, H);
    g.drawImage(IMG.base, X(0), Y(0), sx, sy);
    const dpx = 0.0035 * sx * (1 - c.e);
    g.drawImage(IMG.island, X(ISL.x / IMG_W) + dpx, Y(ISL.y / IMG_H), (ISL.w / IMG_W) * sx, (ISL.h / IMG_H) * sy);

    // ── 光场：L ∈ [0,1]，显示亮度 = tint·(1−L) + L ──
    const B = lerp(0.3, 0.36, E.ease(win(t, 0, 1.2)));
    const tint = [Math.min(1, B * 0.85), Math.min(1, B * 0.82), Math.min(1, B * 1.15)];
    const Gl = sstep(win(t, NT.ground[0], NT.ground[1]));
    const lightDone = t > 6.25;
    if (!lightDone) {
      lLg.setTransform(0.5, 0, 0, 0.5, 0, 0);
      lLg.globalCompositeOperation = 'source-over';
      lLg.clearRect(0, 0, W, H);
      for (const b of BLOBS) {
        const a = sstep((t - b.t + 0.3) / 0.9) * b.a;
        if (a <= 0.003) continue;
        const r = b.rad * sx;
        lLg.globalAlpha = a;
        lLg.drawImage(SPR.blob, X(b.u) - r, Y(b.v) - r, 2 * r, 2 * r);
      }
      if (Gl > 0) { lLg.globalAlpha = Gl; lLg.fillStyle = '#fff'; lLg.fillRect(0, 0, W, H); }
      // 封顶：龙所在的天空（上 30%、u∈[0.18,0.70]）L 上限从 0.35 线性升到终值，不整图交叉淡入；近处最后亮
      lLg.globalCompositeOperation = 'destination-out';
      const cd = lerp(0.35, 1, win(t, 4.4, 6.2));
      if (cd < 0.999) { lLg.globalAlpha = 1 - cd; const rx = 0.36 * sx; const ry = 0.3 * sy; lLg.drawImage(SPR.plateau, X(0.44) - rx, Y(0.1) - ry, 2 * rx, 2 * ry); }
      const cf = sstep(win(t, 3.6, 5.4));
      if (cf < 0.999) { lLg.globalAlpha = 1 - cf; const rx = 0.34 * sx; const ry = 0.46 * sy; lLg.drawImage(SPR.plateau, X(0.16) - rx, Y(0.92) - ry, 2 * rx, 2 * ry); }
      lLg.globalCompositeOperation = 'source-over';
      // 提灯：蝶身一团光，照亮其下
      const bf = bfNight(t);
      if (bf && t < 6.1) {
        const lf = (t < NT.fly[1] ? 1 : 1 - win(t, NT.fly[1], 6.1)) * E.ease(win(t, NT.unfurl[0] + 0.2, NT.unfurl[1] + 0.4));
        const r = 0.12 * sx;
        lLg.globalAlpha = 0.95 * lf;
        lLg.drawImage(SPR.blob, X(bf.u) - r, Y(bf.v) - r, 2 * r, 2 * r);
      }
      lmg.setTransform(1, 0, 0, 1, 0, 0);
      lmg.globalCompositeOperation = 'source-over';
      lmg.globalAlpha = 1;
      lmg.fillStyle = `rgb(${tint.map((x) => Math.round(x * 255)).join(',')})`;
      lmg.fillRect(0, 0, lm.width, lm.height);
      lmg.drawImage(lL, 0, 0);
      g.globalCompositeOperation = 'multiply';
      g.globalAlpha = 1;
      g.drawImage(lm, 0, 0, W, H);
      g.globalCompositeOperation = 'source-over';
    }

    // ── 水面碎光：先画到独立层，用真实水面蒙版裁剪，再 lighter 叠上去 ──
    const gl = 1 - sstep(win(t, 5.6, 6.8));
    if (gl > 0.001) {
      glg.setTransform(R, 0, 0, R, 0, 0);
      glg.globalCompositeOperation = 'source-over';
      glg.globalAlpha = 1;
      glg.clearRect(0, 0, W, H);
      const bfp = bfNight(t);
      let any = false;
      for (const s of GLINTS) {
        const k = Math.floor((t - s.ph) / s.T);
        if (k < 0) continue;
        const age = t - s.ph - k * s.T;
        if (age > s.L) continue;
        const [u, v, tf] = glintPos(s, k);
        const gate = sstep((t - tf) / 0.6);
        if (gate <= 0) continue;
        let boost = 1;
        if (bfp && bfp.flying) { const dd = Math.hypot(u - bfp.u, (v - bfp.v) * 0.5625); if (dd < 0.12) boost = 1 + 0.8 * (1 - dd / 0.12); }
        const a = Math.sin((Math.PI * age) / s.L) * s.a * gate * gl * (1 + (v - 0.5) * 0.6) * boost;
        const len = s.len * sx * (0.7 + 0.5 * v) * 1.5;
        glg.globalAlpha = Math.min(1, a * 1.5);
        glg.drawImage(SPR.glint, X(u) - len / 2, Y(v) - 2, len, 4 * s1 * s.th * 0.6);
        any = true;
      }
      if (any) {
        glg.globalCompositeOperation = 'destination-in';
        glg.globalAlpha = 1;
        glg.drawImage(IMG.water, X(0), Y(0), sx, sy);
        glg.globalCompositeOperation = 'source-over';
        g.globalCompositeOperation = 'lighter';
        g.globalAlpha = 1;
        g.drawImage(glc, 0, 0, W, H);
      }
    }
    // ── 点灯：辉光、涟漪、光尘（lighter） ──
    g.globalCompositeOperation = 'lighter';
    for (const w of NP.wreaths) {
      const age = t - w.t;
      if (age < 0 || age > 2.4) continue;
      const cx = X(w.u);
      const cy = Y(w.v);
      const hw = w.hw * sx;
      const ga = 0.22 * sstep(age / 0.15) * (1 - sstep((age - 0.15) / 0.6));
      if (ga > 0) { const r = 1.3 * hw; g.globalAlpha = ga; g.drawImage(SPR.glowBlue, cx - r, cy - r * 0.62, 2 * r, 2 * r * 0.62); }
      g.globalAlpha = 1;
      for (let k = 0; k < 2; k++) {
        const a2 = age - k * 0.14;
        if (a2 < 0 || a2 > 0.9) continue;
        const p = E.out(a2 / 0.9);
        const rx = hw * lerp(0.9, 1.7, p);
        const ry = rx * 0.3;
        const ra = sstep(p / 0.14) * (1 - p) * (1 - p);
        g.beginPath();
        g.ellipse(cx, cy + hw * 0.15, rx, ry, 0, 0, TAU);
        g.strokeStyle = `rgba(143,196,255,${(0.16 * ra).toFixed(3)})`;
        g.lineWidth = Math.max(4, 5 * u1);
        g.stroke();
        g.strokeStyle = `rgba(191,230,255,${(0.34 * ra).toFixed(3)})`;
        g.lineWidth = Math.max(1.2, 1.3 * u1);
        g.stroke();
      }
      for (let i = 0; i < 5; i++) {
        const rr = mulberry32(900 + i * 31 + Math.round(w.t * 100));
        const ox = (rr() - 0.5) * 1.1 * hw;
        const rise = (30 + 40 * rr()) * s1;
        const life = 1.4;
        const a3 = age - i * 0.07;
        if (a3 < 0 || a3 > life) continue;
        const q = a3 / life;
        g.fillStyle = `rgba(207,230,255,${(0.6 * Math.sin(Math.PI * q)).toFixed(3)})`;
        const rad = (1 + rr()) * s1 * 1.2;
        g.beginPath();
        g.arc(cx + ox, cy - rise * q, rad, 0, TAU);
        g.fill();
      }
    }
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    // 图左缘 150px 羽化进底色（缓出色标，没有一条看得见的边）
    const x1 = tx + 150;
    if (x1 > 0) {
      const gr = g.createLinearGradient(tx, 0, x1, 0);
      for (let i = 0; i <= 8; i++) { const p = i / 8; gr.addColorStop(p, `rgba(10,9,19,${(1 - sstep(p)).toFixed(4)})`); }
      g.fillStyle = gr;
      g.fillRect(0, 0, x1, H);
    }
  }

  function renderFx(t: number) {
    if (!IMG.base) return;
    const c = nightCam(t);
    const sx = c.sx;
    const sy = c.sy;
    const X = (u: number) => (u - c.u0) * sx;
    const Y = (v: number) => (v - c.v0) * sy;
    const u1 = sx / 1778;
    const s1 = H / 1080;
    const f = fctx;
    f.setTransform(R, 0, 0, R, 0, 0);
    f.clearRect(0, 0, W, H);
    f.globalAlpha = 1;
    f.globalCompositeOperation = 'source-over';
    drawSnow(f, t, { x0: 0.05, x1: 0.3, y0: 0.3, y1: 0.62 });
    const tl = NT.fly[1];
    // 远去的灯：G2–G4 在暗纱之上留一点 α≈.25 的灯点，位于标题包围盒之外（盒内的灯 α→0），读成「灯顺流远去」
    {
      const la = 0.25 * sstep(win(t, NT.shade[0] + 0.3, NT.shade[0] + 1.3));
      if (la > 0.002 && tbox) {
        f.globalCompositeOperation = 'lighter';
        for (const w of NP.wreaths.slice(1)) {
          const cx = X(w.u);
          const cy = Y(w.v);
          const dx = Math.max(tbox.l - 10 - cx, 0, cx - (tbox.r + 10));
          const dy = Math.max(tbox.t - 10 - cy, 0, cy - (tbox.b + 10));
          const out = sstep(Math.hypot(dx, dy) / 36);
          if (out <= 0.01) continue;
          const r = Math.max(10, 0.6 * w.hw * sx) * (0.85 + 0.15 * Math.sin((TAU * t) / 6 + w.u * 20));
          f.globalAlpha = la * out;
          f.drawImage(SPR.glowBlue, cx - r, cy - r * 0.7, 2 * r, 2 * r * 0.7);
        }
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
    }
    // 蝶出生：画中指尖蝶柔光一次（α≤.3）→ 光点自翅缘脱出（≈43 px 小弧）
    {
      const pa = win(t, NT.dot[0] - 0.05, NT.dot[0] + 0.55);
      if (pa > 0 && pa < 1) {
        f.globalCompositeOperation = 'lighter';
        const r = 0.032 * sx;
        f.globalAlpha = 0.3 * Math.sin(Math.PI * pa);
        f.drawImage(SPR.glowBlue, X(NP.finger[0]) - r, Y(NP.finger[1]) - r, 2 * r, 2 * r);
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
      const dp = win(t, NT.dot[0], NT.dot[1]);
      if (dp > 0 && dp < 1) {
        const q = E.inout(dp);
        const a = NP.dotFrom;
        const b = NP.birth;
        const cu = a[0] + (b[0] - a[0]) * 0.15 + 0.004;
        const cv = Math.min(a[1], b[1]) - 0.012;
        const at = (qq: number): [number, number] => {
          const w0 = (1 - qq) * (1 - qq);
          const w1 = 2 * (1 - qq) * qq;
          const w2 = qq * qq;
          return [X(w0 * a[0] + w1 * cu + w2 * b[0]), Y(w0 * a[1] + w1 * cv + w2 * b[1])];
        };
        f.globalCompositeOperation = 'lighter';
        for (let k = 3; k >= 0; k--) {
          const qq = Math.max(0, q - k * 0.07);
          const [px, py] = at(qq);
          const al = (k === 0 ? 0.8 : 0.22 / k) * Math.sin(Math.PI * Math.min(1, dp * 1.05));
          f.globalAlpha = al * 0.7;
          f.drawImage(SPR.glowBlue, px - 14 * s1, py - 14 * s1, 28 * s1, 28 * s1);
          f.globalAlpha = Math.min(1, al * 1.15);
          f.fillStyle = '#e4f4ff';
          f.beginPath();
          f.arc(px, py, (k === 0 ? 3.6 : 2.4) * s1, 0, TAU);
          f.fill();
        }
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
    }
    // 光尘（随蝶）
    f.globalCompositeOperation = 'lighter';
    for (let k = 0; ; k++) {
      const te = NT.unfurl[0] + 0.5 + 0.08 * k;
      if (te > tl + 0.1) break;
      const age = t - te;
      if (age < 0 || age > 1.2) continue;
      const bf = bfNight(te);
      if (!bf) continue;
      const rr = mulberry32(5000 + k);
      const dx = (rr() - 0.5) * 24;
      const dy = -6 - 14 * rr();
      const q = age / 1.2;
      f.globalAlpha = 0.5 * (1 - q);
      const rad = (1 + rr()) * s1 * 1.4;
      f.fillStyle = '#cfe6ff';
      f.beginPath();
      f.arc(X(bf.u) + dx * q * s1, Y(bf.v) + dy * q * s1, rad, 0, TAU);
      f.fill();
    }
    f.globalAlpha = 1;
    f.globalCompositeOperation = 'source-over';
    // 落点：阴影、光、涟漪
    const lw = E.out(win(t, tl, tl + 1.5));
    if (lw > 0.001) {
      const lx = X(NP.land[0]);
      const ly = Y(NP.land[1]);
      f.globalAlpha = lw;
      f.drawImage(SPR.shadow, lx - 64 * u1, ly + 2 * u1 - 62 * u1, 128 * u1, 124 * u1);
      f.globalCompositeOperation = 'lighter';
      // 落点的光压低（α≤.35、半径收小）：枝梢的轮廓要露出来，蝶是停在枝上，不是浮在一团光里
      f.globalAlpha = 0.74 * lw;
      f.drawImage(SPR.land, lx - 100 * u1, ly - 78 * u1, 200 * u1, 156 * u1);
      f.globalAlpha = 0.3 * lw;
      { const r = 92 * u1; f.drawImage(SPR.glowBlue, lx - r, ly - r, 2 * r, 2 * r); }
      f.globalAlpha = lw;
      f.globalCompositeOperation = 'source-over';
      // 接触阴影：蝶足与枝梢相触处 1–2 px 的深色细影（让「停落」有重量）
      f.globalAlpha = 0.6 * lw;
      f.drawImage(SPR.shadow, lx - 22 * u1, ly + 15 * u1, 44 * u1, 7 * u1);
      f.globalAlpha = lw;
      for (let k = 0; k < 2; k++) {
        const t0 = tl + k * 0.65;
        const age = t - t0;
        if (age < 0) continue;
        const p = (age % 4.2) / 4.2;
        const scl = lerp(0.7, 1.18, E.out(p));
        const op = 0.6 + 0.4 * (p < 0.25 ? E.out(p / 0.25) : 1 - E.out((p - 0.25) / 0.75));
        const rx = RIPPLE.rings[k][0] * u1 * scl;
        const ry = RIPPLE.rings[k][1] * u1 * scl;
        f.strokeStyle = `rgba(191,230,255,${(RIPPLE.alpha[k] * op).toFixed(3)})`;
        f.lineWidth = Math.max(1, u1);
        f.beginPath();
        f.ellipse(lx + 2 * u1, ly + RIPPLE.cy * u1, rx, ry, 0, 0, TAU);   // 涟漪落在枝下的水面上（上缘低于蝶的方框下缘），不套在蝶身上
        f.stroke();
      }
      f.globalAlpha = 1;
      // 落地的一次柔光脉冲（α≤.35，500 ms，只一次）
      const pp = win(t, tl, tl + 0.5);
      if (pp > 0 && pp < 1) {
        f.globalCompositeOperation = 'lighter';
        const r = 0.05 * sx;
        f.globalAlpha = 0.35 * Math.sin(Math.PI * pp);
        f.drawImage(SPR.glowBlue, lx - r, ly - r * 0.8, 2 * r, 2 * r * 0.8);
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
    }
    // 轨迹：每粒 700 ms 淡入并保留；终帧亮度严格随离落点的远近增（最亮的几粒挨着落点）。
    // 为 t≈4.2 s 的截图帧加密的 14 粒（dense）落地后 0.8 s 内收回：每 3 粒留 1 个小光晕（半径减半、α≤.18），隔一粒淡出，亮度回到按 q 单调的基础值，
    // 不然它们的光晕连成一根发糊的光管。
    {
      const rest = sstep(win(t, tl + 0.6, tl + 1.4));
      for (const d of TRAIL) {
        const td = NT.fly[0] + (NT.fly[1] - NT.fly[0]) * invFlight(d.q) + 0.05;
        const fa = E.out(win(t, td, td + 0.7));
        if (fa <= 0.002) continue;
        const x = X(d.uv[0]) + d.du * u1;
        const y = Y(d.uv[1]) + d.dv * u1;
        let op = lerp(d.op, d.opRest, rest);
        let dot = d.rad;
        if (!d.keep) { op *= 1 - rest; dot *= lerp(1, 0.85, rest); }
        if (d.hz) {
          let ha = (0.18 + 0.32 * d.q) * fa * 1.6;
          let hr = d.rad * 3.6 * u1 * 2.6;
          if (d.dense) {
            ha *= 0.7;
            hr *= 0.85;
          }
          if (d.keep) { ha = lerp(ha, Math.min(0.2, 0.07 + 0.13 * d.q) * fa, rest); hr *= lerp(1, 0.6, rest); }
          else ha *= 1 - rest;
          if (ha > 0.002) { f.globalAlpha = ha; f.drawImage(SPR.hz, x - hr, y - hr, 2 * hr, 2 * hr); }
        }
        if (op <= 0.002) continue;
        f.globalAlpha = op * fa;
        f.fillStyle = '#d4ecff';
        f.beginPath();
        f.arc(x, y, Math.max(0.8, dot * u1), 0, TAU);
        f.fill();
      }
    }
    f.globalAlpha = 1;
    // 触枝抖雪：自枝梢扬起 9 片雪，1.4 s 内落下并淡出
    {
      const tt = t - tl;
      if (tt > 0 && tt < 1.5) {
        const lx = X(NP.land[0]);
        const ly = Y(NP.land[1]) + 14 * s1;
        for (let i = 0; i < 9; i++) {
          const rr = mulberry32(300 + i);
          const ox = (rr() - 0.5) * 80 * u1;
          const oy = -6 * u1 - rr() * 16 * u1;
          const vx = (rr() - 0.5) * 50 * s1;
          const vy = -(55 + 55 * rr()) * s1;
          const gv = 90 * s1;
          const rad = (2 + 1.0 * rr()) * s1 * 1.5;
          f.globalAlpha = 0.85 * (1 - tt / 1.5) * sstep(tt / 0.08);
          f.drawImage(SPR.snow, lx + ox + vx * tt - rad * 2, ly + oy + vy * tt + 0.5 * gv * tt * tt - rad * 2, rad * 4, rad * 4);
        }
        f.globalAlpha = 1;
      }
    }
    // 光点接力：蝶翼抖落一粒光，沿短弧飘向左下火种底座，抵达时开始点亮
    {
      const t0 = tl + 0.12;
      const t1 = NT.seed;
      const p = win(t, t0, t1);
      if (p > 0 && p < 1) {
        const lx = X(NP.land[0]);
        const ly = Y(NP.land[1]);
        const sx_ = 0.0775 * W + 22;
        const sy_ = H - 0.07 * H - 22;
        const q = E.inout(p);
        const cx_ = (lx + sx_) / 2 - 0.02 * W;
        const cy_ = Math.min(ly, sy_) - 0.1 * H;
        const x = (1 - q) * (1 - q) * lx + 2 * (1 - q) * q * cx_ + q * q * sx_;
        const y = (1 - q) * (1 - q) * ly + 2 * (1 - q) * q * cy_ + q * q * sy_;
        f.globalCompositeOperation = 'lighter';
        const a = Math.min(1, p * 6) * (1 - 0.3 * p);
        f.globalAlpha = 0.7 * a;
        f.drawImage(SPR.glowBlue, x - 14 * s1, y - 14 * s1, 28 * s1, 28 * s1);
        f.globalAlpha = a;
        f.fillStyle = '#d4ecff';
        f.beginPath();
        f.arc(x, y, 3 * s1, 0, TAU);
        f.fill();
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
    }
    // 火种第五笔点亮时的十字微光（6–8 px，α≤.4，300 ms）
    {
      const t5 = NT.seed + 4 * 0.13 + 0.2;
      const p = win(t, t5, t5 + 0.3);
      if (p > 0 && p < 1 && seedPt) {
        const r = 7 * s1 * (0.7 + 0.5 * Math.sin(Math.PI * p));
        f.globalCompositeOperation = 'lighter';
        f.globalAlpha = 0.4 * Math.sin(Math.PI * p);
        f.drawImage(SPR.cross, seedPt[0] - r * 2, seedPt[1] - r * 2, r * 4, r * 4);
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
    }
    // 蝶（残影 → 同形辉光 → 本体）
    const bf = noBf ? null : bfNight(t);
    if (bf) {
      const bx = X(bf.u);
      const by = Y(bf.v);
      const un = u1 * bf.size;
      if (bf.flying) {   // 2–3 帧残影：只改形不改亮度（α .16/.12/.08，普通混合，画在本体之下）
        for (let k = 3; k >= 1; k--) {
          const b2 = bfNight(t - 0.045 * k);
          if (!b2 || !b2.flying) continue;
          if (Math.hypot(X(b2.u) - bx, Y(b2.v) - by) < 3 * s1) continue;
          drawBf(f, X(b2.u), Y(b2.v), u1 * b2.size, b2.rot, b2.flapX, [0, 0.16, 0.12, 0.08][k] * bf.alpha);
        }
      }
      if (t < 5.6) {
        f.globalCompositeOperation = 'lighter';
        const gr = 0.07 * sx * (0.6 + 0.4 * bf.size);
        const ga = 0.28 * (t < tl + 0.1 ? 1 : 1 - win(t, tl + 0.1, 5.6)) * bf.alpha;
        f.globalAlpha = ga;
        f.drawImage(SPR.glowBlue, bx - gr, by - gr, 2 * gr, 2 * gr);
        f.globalCompositeOperation = 'source-over';
        f.globalAlpha = 1;
      }
      // 外发光：同形、预先模糊的柔光垫在翅下（参照画中指尖那只发光的蝶），轮廓不再是一道硬边
      f.globalCompositeOperation = 'lighter';
      drawBfGlow(f, bx, by, un, bf.rot, bf.flapX, (t < tl ? 0.5 : lerp(0.5, 0.26, win(t, tl, tl + 1))) * bf.alpha);
      f.globalCompositeOperation = 'source-over';
      drawBf(f, bx, by, un, bf.rot, bf.flapX, bf.alpha);
      // 翅面再叠一层 lighter 的同形柔光（α .34 → 飞行 .26 → 落地 .14）：翅面发亮、半透明，不是平涂
      const ga = (t < NT.fly[0] ? 0.34 : t < tl ? lerp(0.34, 0.26, win(t, NT.fly[0], tl)) : lerp(0.26, 0.14, win(t, tl, tl + 1))) * bf.alpha;
      f.globalCompositeOperation = 'lighter';
      drawBf(f, bx, by, un * 1.04, bf.rot, bf.flapX, ga);
      f.globalCompositeOperation = 'source-over';
    }
  }

  function renderDom(t: number) {
    const S = NT.seed;
    fadeTo(el.credit, t, 0.5, 0.6, 1);
    el.skip.style.opacity = (0.6 * E.ease(win(t, 0.9, 1.3)) * (1 - E.ease(win(t, S - 0.15, S + 0.25)))).toFixed(3);
    seedStrokes(el.enterStrokes, el.enterBase, t, S, 0.13, 0.26, el.enterSeed, 0.55);
    el.enterSeed.style.opacity = E.ease(win(t, S - 0.2, S)).toFixed(3);
    {
      const a = E.ease(win(t, 6.8, 7.6));
      const breath = 0.9 + 0.1 * Math.cos((TAU * Math.max(0, t - T_END)) / 4.8);
      el.enterTxt.style.opacity = (a * breath).toFixed(3);
    }
    const T0 = S + 0.2;      // 栖 5.60
    // 「栖枝」浮现之前两个字都是全透明的，可 h1 上的三层 drop-shadow（24 / 34 px 的大模糊）是个 filter：合成器每一帧都要为这块空白开一个渲染通道、跑三遍大模糊
    // （离屏测量台冻结帧里这一项单独占约 2–4 ms）。comp 里在浮现之前把它关掉，字一出现（reveal 的第一拍）就还给样式表里的那一条——画面逐像素不变（全透明的内容投不出影子）.
    if (comp) el.h1.style.filter = t < T0 ? 'none' : '';
    reveal(el.ch[0], t, T0, 0.9);
    reveal(el.ch[1], t, T0 + 0.18, 0.9);
    {
      const p = E.ease(win(t, T0 + 0.25, T0 + 1.25));
      el.en.style.opacity = p.toFixed(3);
      el.en.style.transform = p >= 1 ? 'none' : `translateY(${((1 - p) * 8).toFixed(2)}px)`;
      el.en.style.filter = p < 1 ? `blur(${((1 - p) * 6).toFixed(2)}px)` : 'none';
      el.en.style.letterSpacing = `${lerp(0.6, 0.42, p).toFixed(3)}em`;
    }
    {
      const p = E.ease(win(t, T0 + 0.4, T0 + 1.1));
      el.rule.forEach((i) => { i.style.transform = `scaleX(${p.toFixed(3)})`; });
      el.ruleSeed.forEach((s, i) => { s.style.opacity = E.ease(win(t, T0 + 0.4 + i * 0.08, T0 + 0.4 + i * 0.08 + 0.3)).toFixed(3); });
    }
    reveal(el.sub, t, T0 + 0.65, 0.9, { blur: 0, y: 8 });
    fadeTo(el.ver, t, T0 + 0.4, 0.6, 0.78);
    // 栖枝一次性高光：一条窄光带自左向右掠过字面，只一次（α≤.35）
    {
      const p = win(t, T0 + 0.95, T0 + 1.95);
      el.sweep.style.opacity = p > 0 && p < 1 ? (0.33 * Math.sin(Math.PI * p)).toFixed(3) : '0';
      el.sweep.style.backgroundPosition = `${(75 - 50 * E.inout(p)).toFixed(2)}% 0`;
    }
  }

  /* ───────── 转场（transition.ts）：蝶飞向左栏的品牌标「枝上蝶」收翅停入、标题与署名缩进左栏、同一张壁纸平移到首页的取景再溶掉 ───────── */
  /** 只画底图（原图＋人物岛＋左缘羽化）：定格后的底图就是这三样；转场里它按 xoff 平移 */
  function drawPlate(xoff: number) {
    if (!IMG.base || !IMG.island) return;
    const g = bctx;
    g.setTransform(R, 0, 0, R, 0, 0);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.fillStyle = '#0a0913';
    g.fillRect(0, 0, W, H);
    g.drawImage(IMG.base, xoff, 0, imgW, imgH);
    g.drawImage(IMG.island, xoff + (ISL.x / IMG_W) * imgW, (ISL.y / IMG_H) * imgH, (ISL.w / IMG_W) * imgW, (ISL.h / IMG_H) * imgH);
    const x1 = xoff + 150;
    if (x1 > 0) {
      const gr = g.createLinearGradient(xoff, 0, x1, 0);
      for (let i = 0; i <= 8; i++) { const p = i / 8; gr.addColorStop(p, `rgba(10,9,19,${(1 - sstep(p)).toFixed(4)})`); }
      g.fillStyle = gr;
      g.fillRect(0, 0, x1, H);
    }
  }

  function prepareTransition(o: TrOptions): SceneTransition {
    const { kind, from, anchors } = o;
    const settled = from >= T_END - 0.05;                 // 定格了：底图是重画的（与定格帧逐像素相同）；被打断：定格那一帧的位图整个仿射到首页的取景
    const tl = NT.fly[1];
    const plate = q1(host, '.boot__plate');
    const h1 = q1(host, '.boot__title h1:not(.sweep)');
    const dur = trDuration(kind);

    tp('night:prepare');
    // ── 蝶：自 fx 画布撤下，换到转场自己的层上飞向品牌标 ──
    const bf0 = IMG.bf && anchors.mark ? bfNight(from) : null;
    const hasBf = !!bf0 && bf0.alpha > 0.2;
    noBf = true;
    renderFx(from);
    noBf = false;
    tp('night:renderFx');
    // legacy：一张整屏的画布每个节拍清空重画；comp：蝶是三张位图层（合成器按位姿变换）＋ 一张只盖光尘路径的小画布
    let bfc: HTMLCanvasElement | undefined;
    let bx: CanvasRenderingContext2D | undefined;
    if (!comp) {
      bfc = document.createElement('canvas');
      bfc.className = 'boot__bfc';
      bfc.setAttribute('aria-hidden', 'true');
      bfc.width = fx.width;
      bfc.height = fx.height;
      host.appendChild(bfc);
      bx = bfc.getContext('2d')!;
    }
    let start: BfPose | undefined;
    let goal: ReturnType<typeof brandGoal> | undefined;
    let path: ReturnType<typeof flightPath> | undefined;
    if (hasBf && bf0 && anchors.mark) {
      const c = nightCam(from);
      start = { x: (bf0.u - c.u0) * c.sx, y: (bf0.v - c.v0) * c.sy, w: (c.sx / 1778) * bf0.size * 100, rot: bf0.rot, flap: bf0.flapX, alpha: bf0.alpha };
      goal = brandGoal(anchors.mark);
      path = flightPath([start.x, start.y], [goal.x, goal.y], 1);
    }
    const glow0 = from < tl ? 0.5 : lerp(0.5, 0.26, win(from, tl, tl + 1));
    const over0 = from < NT.fly[0] ? 0.34 : from < tl ? lerp(0.34, 0.26, win(from, NT.fly[0], tl)) : lerp(0.26, 0.14, win(from, tl, tl + 1));

    // ── 枝：品牌标里那根细枝的分身，从蝶的落脚点往两头长（transition.ts 的 createTwigFx）；真标在它下面淡入后分身撤下 ──
    let twigFx: TwigFx | undefined;
    if (hasBf && anchors.mark && start && goal && path) twigFx = createTwigFx(host, anchors.mark, { stroke: '#d6d0ee', wMain: 1.6, wSide: 1.15, open: twigOpen(start, goal, path, twigFootScreen(anchors.mark)) });

    // ── 标题与署名：FLIP 到左栏字标 / 壁纸署名的位置（还没浮现出来的就不带） ──
    // 被打断时标题常常只浮现了一部分（或一点都没有）：不带的从它此刻的状态淡出、带着走的把 reveal 收完——绝不从 0 / 1 起跳
    const shown = (n: HTMLElement) => parseFloat(n.style.opacity || '0') > 0.5;
    const chBase = el.ch.map(revealBase);
    const enBase = revealBase(el.en);
    const crBase = parseFloat(el.credit.style.opacity || '0') || 0;
    let fh1: Flip | undefined;
    let fen: Flip | undefined;
    let fcr: Flip | undefined;
    const lsH1 = lsEm(h1);
    const lsEn = lsEm(el.en);
    const h1Box = boxRect(h1);
    const h1Src = unionRect(el.ch.map(rangeRect));
    const enBox = boxRect(el.en);
    const enSrc = rangeRect(el.en);
    if (anchors.name && shown(el.ch[0])) fh1 = flipTo(h1Box, h1Src, anchors.name);
    if (anchors.sub && shown(el.en)) fen = flipTo(enBox, enSrc, anchors.sub);
    if (anchors.credit && shown(el.credit)) fcr = flipRight(boxRect(el.credit), anchors.credit);
    const grpSrc: TitleGroup | undefined = fh1 && fen && anchors.name && anchors.sub ? { h1Box, h1Src, h1Dst: anchors.name, enSrc, enDst: anchors.sub } : undefined;
    const nameRgb = parseRgb(anchors.nameColor, [244, 240, 250]);
    const subRgb = parseRgb(anchors.subColor, [190, 180, 210]);
    const S = nightSegs(kind);
    h1.style.transformOrigin = '0 0';
    el.en.style.transformOrigin = '0 0';
    el.credit.style.transformOrigin = '0 0';

    // ── 底图：同一张画平移到首页壁纸的取景（图左缘 x），再整张溶掉露出壁纸层 ──
    // 平移要有左栏来「推」：它从屏外推入，底图左缘露出的那条暗带永远藏在它下面（左栏不是竖栏——窄窗口里它是顶部横条——就不平移）。
    // 定格后：底图是 drawPlate 重画的（与定格帧逐像素相同）。被打断：定格的那一帧位图（连光场、碎光一起）整个仿射到首页的取景——
    // 镜头还在推近（z0 > 1）时尺寸也要对上，以她的脸为不动点对齐；这样两幅画溶解时没有「脸的双影」（评审 R2）。
    const nav = anchors.nav;
    const push = anchors.wallpaper && navPushable(nav, anchors.vw, anchors.vh);
    const txFrom = tx;
    const txTo = push ? wallpaperTx(W, H, anchors.wpFx, anchors.wpFace) : txFrom;
    const cam0 = nightCam(from);
    const aff = push && !settled ? plateFit({ W, H, imgW, imgH, z: cam0.z, u0: cam0.u0, v0: cam0.v0, txTo, face: anchors.wpFace }) : null;
    if (aff) bg.style.transformOrigin = '0 0';
    const shades = [shadeTop, shade, shadeBot];
    const sh0 = shades.map((n) => (n.style.opacity === '' ? 1 : parseFloat(n.style.opacity) || 0));
    const fades: Array<[HTMLElement, number, number]> = [   // [元素, 起始不透明度, 上浮像素]
      [el.sub, parseFloat(el.sub.style.opacity || '1'), -6],
      [q1(host, '.boot__rule'), 1, -6],
      [q1(host, '.boot__enter'), 1, 0],
      [el.skip, parseFloat(el.skip.style.opacity || '0'), 0],
      [el.ver, parseFloat(el.ver.style.opacity || '0'), 0],
      [el.sweep, parseFloat(el.sweep.style.opacity || '0'), 0],
    ];
    let lastPan = -1;

    /** 蝶在飞行画布上的一帧（legacy）. */
    function drawFlight(st: ReturnType<typeof trState>, tr: number) {
      const f = bx!;
      f.setTransform(R, 0, 0, R, 0, 0);
      f.clearRect(0, 0, W, H);
      if (!start || !goal || !path || st.swapOut >= 1) return;
      const pose = bfFlight(start, goal, path, st.fly, st.flap, tr);
      pose.alpha *= 1 - st.swapOut;
      const unit = pose.w / 100;
      const s1 = H / 1080;
      const sinq = Math.sin(Math.PI * clamp(st.fly));
      // 光尘：寿命 ≤ 100 ms 的几粒（dustDots：点距随速度拉开、尺寸 / 亮度各随机 ±30%），标题周围不画
      f.globalCompositeOperation = 'lighter';
      for (const d of dustDots(path, S.fly, tr, 7100, titleRects(tr))) {
        f.globalAlpha = Math.min(1, d.a * 0.55);
        f.fillStyle = '#cfe6ff';
        f.beginPath();
        f.arc(d.x, d.y, 1.5 * s1 * 1.3 * d.r, 0, TAU);
        f.fill();
      }
      f.globalAlpha = 1;
      drawBfGlow(f, pose.x, pose.y, unit, pose.rot, pose.flap, (glow0 + (0.5 - glow0) * sinq) * pose.alpha);
      f.globalCompositeOperation = 'source-over';
      drawBf(f, pose.x, pose.y, unit, pose.rot, pose.flap, pose.alpha);
      f.globalCompositeOperation = 'lighter';
      drawBf(f, pose.x, pose.y, unit * 1.04, pose.rot, pose.flap, (over0 + (0.3 - over0) * sinq) * pose.alpha);
      f.globalCompositeOperation = 'source-over';
    }

    /** 标题（栖枝 / ALIGHT）：栖枝 / ALIGHT 缩进左栏字标；到位后真字标在下面淡入，随后这一份撤下
        （真字标在它下面先淡入到不透明，这一份再淡出——先后错开，交叉淡化的中途才不会变淡一下）。
        「栖枝」与 ALIGHT 是一个整体（titleGroupAt）：以「栖」的左上角为组锚缩放，ALIGHT 前 35% 的行程里从左缘缩进收成左对齐；
        渐变色标 / 外发光一路收敛到字标的纯色无发光（tint），0.70 s 交叉淡化时分身与真身像素一致。
        还没浮现出来（或只出了一半）的从它此刻的状态起：不带的从 base 淡出，带着走的把 reveal 收完——不会在打断的那一帧冒出来. */
    function renderTitle(st: ReturnType<typeof trState>) {
      const gone = st.titleOut >= 1 ? 'hidden' : '';
      const grp = grpSrc ? titleGroupAt(grpSrc, st.title) : undefined;
      if (fh1) {
        h1.style.transform = flipCss(grp ? grp.h1Flip : flipAt(fh1, st.title)); h1.style.letterSpacing = `${lerp(lsH1, anchors.nameLS, st.title).toFixed(4)}em`; h1.style.opacity = (1 - st.titleOut).toFixed(3); h1.style.visibility = gone;
        h1.style.filter = tintGlow(st.tint);
        const grad = tintGradient(nameRgb, st.tint);
        el.ch.forEach((c) => { c.style.backgroundImage = grad; });
        el.ch.forEach((c, i) => settleReveal(c, chBase[i], st.title));
      } else {
        el.ch.forEach((c, i) => { c.style.opacity = (chBase[i].op * (1 - st.ambient)).toFixed(3); });
        // 不带着走的标题（被打断时还没浮现 / 只出了一点）：字全透明的这段时间里 h1 的 drop-shadow 是对一块空白开的渲染通道（见 renderDom），关掉；
        // 还看得见的（字此刻的不透明度 > 1/255）保持样式表里的那一条，淡到不可见才关——投影随字一起淡，画面不变.
        if (comp) h1.style.filter = chBase.some((b) => b.op * (1 - st.ambient) > 0.004) ? '' : 'none';
      }
      if (fen) {
        el.en.style.transform = flipCss(grp ? flipTo(enBox, enSrc, grp.enRect) : flipAt(fen, st.title)); el.en.style.letterSpacing = `${lerp(lsEn, anchors.subLS, st.title).toFixed(4)}em`; el.en.style.visibility = gone;
        el.en.style.color = tintColor(NIGHT_EN_COLOR, subRgb, st.tint);
        el.en.style.textShadow = st.tint >= 0.999 ? 'none' : `0 0 12px rgb(8 6 22 / ${(0.7 * (1 - st.tint)).toFixed(3)})`;
        el.en.style.opacity = ((enBase.op + (1 - enBase.op) * st.title) * (1 - st.titleOut)).toFixed(3);
        el.en.style.filter = enBase.blur * (1 - st.title) > 0.05 ? `blur(${(enBase.blur * (1 - st.title)).toFixed(2)}px)` : 'none';
      } else el.en.style.opacity = (enBase.op * (1 - st.ambient)).toFixed(3);
    }

    /** legacy：每个节拍把底板 / 暗纱 / 小件 / 署名全写一遍（JS 驱动）. */
    function renderLegacyPlate(st: ReturnType<typeof trState>) {
      // 底图：取景平移（定格后只在动的时候重画；被打断时位图整个仿射——不重画，光场、碎光原样跟着走）、暗纱淡出、整张溶掉
      let leftEdge = (txTo - txFrom) * st.pan;
      if (push && settled && txTo !== txFrom && st.pan !== lastPan && (lastPan !== -1 || st.pan > 0)) { lastPan = st.pan; drawPlate(lerp(txFrom, txTo, st.pan)); }
      if (aff) {
        const sc = lerp(1, aff.s, st.pan);
        leftEdge = lerp(0, aff.x, st.pan);
        bg.style.transform = st.pan > 0 ? `translate(${leftEdge.toFixed(2)}px, ${lerp(0, aff.y, st.pan).toFixed(2)}px) scale(${sc.toFixed(5)})` : '';
      }
      // 左栏面板（应用里的真左栏，在开屏底板下面）推进来的地方，底板让出一个洞：画面像是被它「推开」的
      if (push && nav) plate.style.clipPath = holeClip(holeEdge(nav.w, leftEdge, st.pan));
      shades.forEach((n, i) => { n.style.opacity = (sh0[i] * (1 - st.shade)).toFixed(3); });
      plate.style.opacity = (1 - dissolveAlpha(kind, st, from)).toFixed(3);
      fx.style.opacity = (1 - sstep(st.ambient)).toFixed(3);
      const a = sstep(st.ambient);
      for (const [n, base, dy] of fades) { n.style.opacity = (base * (1 - a)).toFixed(3); if (dy) n.style.transform = `translateY(${(dy * a).toFixed(2)}px)`; }
    }
    function renderLegacyCredit(st: ReturnType<typeof trState>) {
      // 署名：滑到壁纸里它该在的地方
      if (fcr) { el.credit.style.transform = flipCss(flipAt(fcr, st.credit)); el.credit.style.opacity = ((crBase + (1 - crBase) * st.credit) * (1 - st.creditOut)).toFixed(3); el.credit.style.visibility = st.creditOut >= 1 ? 'hidden' : ''; }
      else el.credit.style.opacity = (crBase * (1 - st.ambient)).toFixed(3);
    }
    function renderTwig(st: ReturnType<typeof trState>, tr: number) {
      // 枝
      if (twigFx) twigFx.update(st.flyRaw, st.swapOut, start && goal && path && st.swapOut < 1 ? bfBox(bfFlight(start, goal, path, st.fly, st.flap, tr)) : null);
    }

    function renderTr(tr: number) {
      const st = trState('night', kind, tr);
      renderLegacyPlate(st);
      renderTitle(st);
      renderLegacyCredit(st);
      renderTwig(st, tr);
      drawFlight(st, tr);
    }

    /** 此刻标题（栖枝、ALIGHT）占的矩形（尾流的障碍物，也是光尘不画的地方）. */
    function titleRects(tr: number): Rect[] {
      const st = trState('night', kind, tr);
      const out: Rect[] = [];
      if (st.titleOut >= 1) return out;
      const g = grpSrc ? titleGroupAt(grpSrc, st.title) : undefined;
      if (fh1) out.push(g ? g.h1Rect : flipRectAt(h1Box, h1Src, flipAt(fh1, st.title)));
      if (fen) out.push(g ? g.enRect : flipRectAt(enBox, enSrc, flipAt(fen, st.title)));
      return out;
    }

    /** 此刻在界面上方飞的东西：标题、副标题、蝶（应用侧的元素等它们飞过再浮现） */
    function obstacles(tr: number): Rect[] {
      const st = trState('night', kind, tr);
      const out = titleRects(tr);
      if (start && goal && path && st.swapOut < 1) { const pose = bfFlight(start, goal, path, st.fly, st.flap, tr); if (pose.alpha > 0.1) out.push(bfBox(pose)); }
      return out;
    }

    let bfRoot: HTMLElement | undefined;
    let dustCv: HTMLCanvasElement | undefined;
    const ttRoots: HTMLElement[] = [];
    tp('night:measured');
    const shared = { mark: hasBf, title: !!fh1, credit: !!fcr, creditFade: false, push, fig: false, figFade: false };
    const common = {
      shared,
      obstacles,
      dispose() {
        bfc?.remove();
        bfRoot?.remove();
        dustCv?.remove();
        ttRoots.forEach((n) => n.remove());
        twigFx?.el.remove();
        plate.style.clipPath = '';
        bg.style.transform = '';
        bg.style.transformOrigin = '';
        const back = (n: HTMLElement) => { n.style.transform = ''; n.style.transformOrigin = ''; n.style.visibility = ''; n.style.letterSpacing = ''; };
        back(h1); back(el.en); back(el.credit);
        h1.style.opacity = '';
        h1.style.filter = '';
        el.en.style.color = ''; el.en.style.textShadow = '';
        el.ch.forEach((c) => { c.style.backgroundImage = ''; });
        plate.style.opacity = '';
        fx.style.opacity = '';
        shadeTop.style.opacity = '';
        for (const [n] of fades) { n.style.opacity = ''; n.style.transform = ''; }
        el.ch.forEach((c) => { c.style.opacity = ''; });
        // 场景回到离开时的那一帧（定格的要把底图按原取景重画）
        bgFinal = false;
        render(from, !settled);
      },
    };

    /* ───────── legacy：JS 逐拍写样式（旧路径，留着对拍与回退）───────── */
    if (!comp) {
      return {
        ...common,
        render: renderTr,
        backdrop(tr: number): BackdropXf | null {
          // 位图相对它的终态（= 首页壁纸的取景）还剩的变换：被打断时 T_plate(pan)·T_aff⁻¹（位图是仿射到首页取景的），定格后只有水平平移（位图是重画的）
          if (!push) return null;
          const st = trState('night', kind, tr);
          if (aff) return plateResidual(aff, st.pan);
          if (settled && txTo !== txFrom) return { k: 1, x: lerp(txFrom, txTo, st.pan) - txTo, y: 0 };
          return null;
        },
      };
    }

    /* ───────── comp：合成器优先 ─────────
       能交给合成器的（洞 / 底图平移 / 暗纱 / 溶解 / 前景淡出 / 署名 / 首页壁纸 / 蝶的位姿与不透明度）都变成 WAAPI 通道（nightComp.ts），
       实时播放时第一个 rAF 把 startTime 对齐到同一个 t0 后放手，导出时同一批动画逐帧设 currentTime。
       残余 JS 只剩真正需要逐帧重画的小块：标题组（transform / 字距 / 色标 / 外发光）、枝的描画、光尘小画布——它们每个 rAF（按调速器档位）写。 */
    host.classList.add('is-tr');
    const holeEl = q1(host, '.boot__hole');
    const bodyEl = q1(host, '.boot__plate-body');
    let baked = false;
    const wp = push && document.documentElement.dataset.wallpaper === 'on' ? document.querySelector<HTMLElement>('.wallpaper__layer--night .wallpaper__frame') : null;
    const ch = nightChannels({
      kind, from, settled, push: !!push, navW: push && nav ? nav.w : 0, txFrom, txTo, aff,
      shadeBase: [sh0[0], sh0[1], sh0[2]], fades: fades.map(([, base, dy]) => ({ base, dy })), fcr, crBase,
      bf: start && goal && path ? { start, goal, path, glow0, over0 } : undefined,
    });
    tp('night:channels');
    const group = new ClockGroup(dur, o.stager);
    const divisor = bootGovernor.floorDivisor;       // 独显才一开始就是阶梯；其它机器开跑后画不动，再由调速器切（retier）
    const opt = { divisor, refreshMs: learnedRefresh() };
    group.animate(holeEl, ch.hole as Channel, opt);
    group.animate(bodyEl, ch.holeInv as Channel, opt);
    group.animate(bg, ch.bg as Channel, opt);
    tp('night:a-hole-bg');
    group.animate(plate, ch.plate, { ...opt, late: true });          // 溶解的 opacity 动画到点才建：有 opacity 动画的底板是一个离屏渲染面（整屏多一遍读写），而且不再「不透明」，Viz 没法剔掉下面的应用——前 0.4 s 不该有
    shades.forEach((n, i) => group.animate(n, ch.shades[i] as Channel, opt));
    group.animate(fx, ch.fx, opt);
    fades.forEach(([n], i) => group.animate(n, ch.fades[i], opt));
    tp('night:a-fades');
    group.animate(el.credit, ch.credit, opt);
    // 首页壁纸层（被打断：与位图一起套同一个剩余变换；individual translate / scale 属性，不碰它自己的 transform 与 700 ms 过渡）
    if (wp && ch.backdrop) { if (aff) wp.style.transformOrigin = '0 0'; group.animate(wp, ch.backdrop, { ...opt, app: true }); }       // app：应用元素上的动画，转场结束时只撤它（覆盖层里的留到卸载，见 ClockGroup.release）
    // 蝶：三张位图层（柔光、本体、翅面高光；后两者与前者 plus-lighter 叠加，放进 isolation:isolate 的小组里，与原画布的 lighter 一致）
    tp('night:a-wp');
    if (ch.bf && IMG.bf && IMG.bfGlow && start && goal && path) {
      bfRoot = document.createElement('div');
      bfRoot.className = 'boot__bf';
      bfRoot.setAttribute('aria-hidden', 'true');
      const layer = (cls: string, src: HTMLCanvasElement) => { const c = document.createElement('canvas'); c.className = cls; c.width = src.width; c.height = src.height; c.getContext('2d')!.drawImage(src, 0, 0); return c; };
      const lg = layer('boot__bf-glow', IMG.bfGlow);
      const lb = layer('boot__bf-body', IMG.bf);
      const lo = layer('boot__bf-over', IMG.bf);
      bfRoot.append(lg, lb, lo);
      // 动画排队创建（起步的同步段不建）：先把内联样式设成 tr = 0 的状态，动画随后从同一个 t0 起接手
      bfRoot.style.transform = ch.bf.pose.css(ch.bf.pose.truth(0)).transform;
      lg.style.opacity = ch.bf.glowA.css(ch.bf.glowA.truth(0)).opacity;
      lb.style.opacity = ch.bf.bodyA.css(ch.bf.bodyA.truth(0)).opacity;
      lo.style.opacity = ch.bf.overA.css(ch.bf.overA.truth(0)).opacity;
      tp('night:bf-layers');
      host.appendChild(bfRoot);
      tp('night:bf-append');
      group.animate(bfRoot, ch.bf.pose, opt);
      tp('night:bf-pose');
      group.animate(lg, ch.bf.glowA, opt);
      group.animate(lb, ch.bf.bodyA, opt);
      group.animate(lo, ch.bf.overA, opt);
      tp('night:bf-anims');
      // 光尘：只盖光尘路径外接框的小画布（≤ 8 个点，每个节拍清空重画）
      const xs = path.map((p) => p[0]);
      const ys = path.map((p) => p[1]);
      const pad = 24;
      const dx0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
      const dy0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
      const dx1 = Math.min(W, Math.ceil(Math.max(...xs) + pad));
      const dy1 = Math.min(H, Math.ceil(Math.max(...ys) + pad));
      dustCv = document.createElement('canvas');
      dustCv.className = 'boot__dust';
      dustCv.setAttribute('aria-hidden', 'true');
      dustCv.width = Math.max(2, Math.round((dx1 - dx0) * R));
      dustCv.height = Math.max(2, Math.round((dy1 - dy0) * R));
      dustCv.style.cssText = `left:${dx0}px;top:${dy0}px;width:${dx1 - dx0}px;height:${dy1 - dy0}px`;
      host.insertBefore(dustCv, bfRoot);
    }
    // ── 标题组：已完全浮现时换成预烘焙的叠层（见 nightComp.ts 的 nightTitleChannels），主线程不再碰它；还在浮现中（被打断得早）退回 JS 逐拍写 ──
    const bakedTitle = !!(fh1 && fen && grpSrc) && chBase.every((b) => b.op >= 0.999 && b.blur < 0.01 && b.y < 0.01) && enBase.op >= 0.999 && enBase.blur < 0.01 && enBase.y < 0.01 && !!el.en.firstChild;
    if (bakedTitle && grpSrc) {
      const ttBox = boxRect(el.title);
      const fsH1 = parseFloat(getComputedStyle(h1).fontSize) || 1;
      const fsEn = parseFloat(getComputedStyle(el.en).fontSize) || 1;
      const word = el.en.textContent ?? '';
      const xs = Array.from(word, (_, i) => { const r0 = document.createRange(); r0.setStart(el.en.firstChild as Node, i); r0.setEnd(el.en.firstChild as Node, i + 1); return r0.getBoundingClientRect().left - enBox.x; });
      const tch = nightTitleChannels({ kind, grp: grpSrc, h1Box, enBox, enSrc, lsH1, lsEn, nameLS: anchors.nameLS, subLS: anchors.subLS, fsH1, fsEn, letters: word.length });
      const wrap = (box: Rect) => { const w = document.createElement('div'); w.className = 'boot__tt'; w.setAttribute('aria-hidden', 'true'); w.style.cssText = `left:${box.x - ttBox.x}px;top:${box.y - ttBox.y}px;width:${box.w}px;height:${box.h}px`; return w; };
      const rgbCss = (c: readonly number[]) => `rgb(${c.map((x) => Math.round(x)).join(' ')})`;
      // 「栖枝」：光晕层（透明字 + text-shadow）/ 渐变字层 / 纯字标色字层（叠放，上层 opacity = tint）
      const w1 = wrap(h1Box);
      const l1 = (['halo', 'grad', 'flat'] as const).map((kind) => {
        const c = h1.cloneNode(true) as HTMLElement;
        c.removeAttribute('style');
        c.className = `boot__tt-l boot__tt-${kind}`;
        c.querySelectorAll<HTMLElement>('.c').forEach((n) => n.removeAttribute('style'));
        if (kind === 'flat') c.style.setProperty('--tt-c', rgbCss(nameRgb));
        return c;
      });
      w1.append(...l1);
      // ALIGHT：逐字母绝对定位（位置取自原整串排版的 Range 量值，字距微调一致），每层同样三份
      const w2 = wrap(enBox);
      const l2 = (['halo', 'a', 'flat'] as const).map((kind) => {
        const p = document.createElement('p');
        p.className = `boot__en boot__tt-e boot__tt-e--${kind}`;
        if (kind === 'flat') p.style.setProperty('--tt-c', rgbCss(subRgb));
        Array.from(word).forEach((ch0, i) => { const sp = document.createElement('span'); sp.className = 'l'; sp.textContent = ch0; sp.style.left = `${xs[i].toFixed(3)}px`; p.appendChild(sp); });
        return p;
      });
      w2.append(...l2);
      el.sweep.before(w1, w2);      // 放在一次性高光（h1.sweep，plus-lighter 叠层）的前面：叠放顺序与原来一样（高光在字的上面）——append 到末尾的话预烘焙的字层会盖住高光，被打断时「栖」的白色高光第一帧就没了（旧版会保持约 70 ms 再缓降）
      ttRoots.push(w1, w2);
      h1.style.visibility = 'hidden';
      el.en.style.visibility = 'hidden';
      group.animate(w1, tch.h1Tf, opt);
      group.animate(w1, tch.out, opt);
      group.animate(w2, tch.enTf, opt);
      group.animate(w2, tch.out, opt);
      group.animate(l1[0], tch.halo, opt);
      group.animate(l1[2], tch.flat, opt);
      group.animate(l2[0], tch.halo, opt);
      group.animate(l2[2], tch.flat, opt);
      for (const l of l1) group.animate(l.querySelectorAll('.c')[1], tch.h1Char, opt);
      for (const l of l2) l.querySelectorAll('.l').forEach((sp, i) => group.animate(sp, tch.enLetter[i], opt));
      baked = true;
    }
    tp('night:animated');
    const dg = dustCv?.getContext('2d') ?? null;
    let dustBusy = true;
    function drawDust(st: ReturnType<typeof trState>, tr: number) {
      if (!dg || !dustCv || !path) return;
      const dx0 = parseFloat(dustCv.style.left);
      const dy0 = parseFloat(dustCv.style.top);
      const dots = st.swapOut >= 1 ? [] : dustDots(path, S.fly, tr, 7100, titleRects(tr));
      if (!dots.length && !dustBusy) return;
      dustBusy = dots.length > 0;
      dg.setTransform(R, 0, 0, R, -dx0 * R, -dy0 * R);
      dg.clearRect(dx0, dy0, dustCv.width / R + 1, dustCv.height / R + 1);
      dg.globalCompositeOperation = 'lighter';
      const s1 = H / 1080;
      for (const d of dots) {
        dg.globalAlpha = Math.min(1, d.a * 0.55);
        dg.fillStyle = '#cfe6ff';
        dg.beginPath();
        dg.arc(d.x, d.y, 1.5 * s1 * 1.3 * d.r, 0, TAU);
        dg.fill();
      }
      dg.globalAlpha = 1;
      dg.globalCompositeOperation = 'source-over';
    }

    /** 残余 JS：标题组、枝、光尘. */
    function drive(tr: number) {
      const st = trState('night', kind, tr);
      if (!baked) renderTitle(st);
      renderTwig(st, tr);
      drawDust(st, tr);
    }

    return {
      ...common,
      render(tr: number) { group.seek(tr); drive(tr); },
      play(t0: number) { group.play(t0); },
      retier(divisor: number, refreshMs: number) { group.retier(divisor, refreshMs); },
      step(tr: number) { if (!group.running) group.seek(tr); drive(tr); },
      end() {
        group.release();      // 只撤首页壁纸层上的动画；覆盖层里的 fill:both 动画留着，把覆盖层停在终态（透明）直到 React 卸载它——整个撤掉会让覆盖层回到开屏定格画面，被画出一帧
        if (wp) { wp.style.removeProperty('transform-origin'); }
      },
      dispose() {
        group.end();
        if (wp) { wp.style.removeProperty('transform-origin'); }
        host.classList.remove('is-tr');
        common.dispose();
      },
    };
  }

  /** 6.8 s 之后背景画布不再变（镜头 5.6 s 到位、光场 6.25 s、碎光 6.8 s 收完）：画过一次就不必每个节拍再整屏重画（comp；legacy 保持每拍重画）. */
  const BG_STATIC_T = 6.85;

  function render(t: number, skipBg = false) {
    // 光场与碎光只在 6.9 s 前用；之后释放它们的画布内存（再要用时 setAux 会重新分配）
    if (t > 6.9) setAux(false); else setAux(true);
    if (!skipBg && !(comp && bgFinal && t >= BG_STATIC_T)) {
      renderBg(t);
      bgFinal = t >= BG_STATIC_T && !!IMG.base;
    }
    // DOM 暗纱：落地的柔光脉冲走完（5.0 s）才起，1.8 s 慢升
    const sh = sstep(win(t, NT.shade[0], NT.shade[1]));       // smoothstep：比 inout 缓，整屏亮度逐帧变化更小
    shade.style.opacity = String(sh);
    shadeBot.style.opacity = String(sh);
    renderFx(t);
    renderDom(t);
  }

  return {
    theme: 'night',
    duration: T_END,
    ready: ready.then(() => { /* layout() 在首次 resize 里做 */ }),
    render,
    resize,
    prepareTransition,
    dispose() { host.classList.remove('is-comp', 'is-tr', 'is-warm'); host.innerHTML = ''; lm.width = lL.width = glc.width = 0; lm.height = lL.height = glc.height = 0; bg.width = fx.width = 0; },
  };
}
