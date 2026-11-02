/* 昼 · 开屏「绽开」的纯函数（不碰 DOM）：径向蒙版并集的层列表、撤蒙版时刻、三道光束的位置 / 不透明度。
   从 dayScene.ts 机械搬出（dayScene.ts 把这些常量原样 re-export，check-boot 的 `DAY.xxx` 照旧），好让两条出口共用同一份公式：
   · DOM 路径（旧路径；导出 / 减少动态 / 位图没备好 / 被打断时）：bloomMaskCss(t) 写进 `.bd-bloom` 的 mask-image，与 0.1.3（db7176c）逐字相同；
   · 画布路径（0.1.4 起，实时播放）：bloomLayers(t) 的每一层在 1/4 分辨率的蒙版画布上 source-over 画一个径向渐变（并集 = 1 − Π(1 − αi)，与 CSS mask-composite: add 同式），
     再 destination-in 到绽开画布上（dayScene.ts 的 drawBloomCanvas）——不再每拍给整屏三层重新光栅。 */
import { E, clamp, lerp, sstep, win } from './bootMath';
import { DC } from './dayConst';

/** 绽开的时间窗（秒）：dayScene.ts 的 DT.bloom 就是它. */
export const BLOOM_T = [0, 2.7] as const;
/** 绽开边缘的羽化宽度（舞台单位）：很宽，圆边没有一圈看得见的边，不像 PPT 的「圆形」转场 */
export const BLOOM_FEATHER = [90, 170] as const;
/** 绽开不再是「一个小窥孔慢慢长成一个正圆」（评审 R4：0.2–0.8 s 一个 200×110 px 的椭圆几乎不长、边缘偏硬，像雾里捅了个洞；1.0–1.5 s 又是一个明显的正圆向外扩，读成「圆形展开」，不是花海）：
    ① 半径前快后慢——0.25 s 内到约 300 px，之后渐渐收慢到 2.7 s 铺满（BLOOM_P = 1.7 的幂函数）；
    ② 不是一个圆：主圆之外绕着长出 6 片大小、角度、迟早各不同的「花瓣」（BLOOM_PETALS），另有花束、脚边白花、左下远处的花海（横着铺开）三个中心错开 0.07–0.22 s 点开——
       蒙版是它们的并集，轮廓是不规则的瓣形，不是一个几何圆；
    ③ 起点的羽化很宽（320 → 170），没有硬边。 */
export const BLOOM_P = 1.7;
export const bloomE = (x: number) => 1 - Math.pow(1 - clamp(x), BLOOM_P);
/** 主圆的半径（舞台单位）：自脚下 DC.R0 的小圈起，前快后慢（0.25 s 内到约 300 px），2.7 s 铺满（1500）. */
export const bloomRadius = (t: number) => DC.R0 + (1500 - DC.R0) * bloomE(win(t, BLOOM_T[0], BLOOM_T[1]));
/** 绽开的中心（舞台单位）：[x, y, 迟于主圆的秒数, 半径系数, 竖 / 横比 的下限]. */
export const BLOOM_CENTERS: ReadonlyArray<readonly [number, number, number, number, number]> = [
  [1010, 600, 0, 0.62, 0.8],        // 花束（浅色：最先露出来）
  [1150, 870, 0.2, 0.42, 0.7],      // 脚边的白花（那里有暗紫碎晶：晚于主圆，不再作为一块孤立的紫斑最先冒出来）
  [230, 890, 0.22, 0.7, 0.38],      // 左下远处的花海（横着铺开）
];
/** R5（起手）：前两三帧最先露出来的是一团深青色草地、只有她的小腿，旁边还有一块孤立的紫色荆棘光，像一滴墨渍。
    现在浅色的花束、脚边白花在前，深色草地的主圆晚 BLOOM_MAIN_DELAY 才淡入（半径照旧：它只是晚一点看得见）；前 0.3 s 已露区上再压一层 α ≥ 0.4 的雾（BLOOM_FOG）降低反差；
    点花（弹出的白花精灵）只在「当前主圆半径 − BLOOM_FLOWER_MARGIN」以内才弹——不再在空雾里没有地面托着像贴纸. */
export const BLOOM_MAIN_DELAY = 0.12;
export const BLOOM_FLOWER_MARGIN = 40;
export const BLOOM_FOG = { a: 0.5, hold: 0.3, end: 0.9 } as const;
export const bloomFogAlpha = (t: number) => BLOOM_FOG.a * (1 - sstep(win(t, BLOOM_FOG.hold, BLOOM_FOG.end)));
/** 主圆边缘的花瓣：[角度°（屏幕坐标，0 = 向右、90 = 向下）, 中心距（占半径）, 瓣半径（占半径）, 迟于主圆的秒数]. */
export const BLOOM_PETALS: ReadonlyArray<readonly [number, number, number, number]> = [
  [-70, 0.7, 0.44, 0.05], [-10, 0.72, 0.4, 0.12], [48, 0.68, 0.46, 0.02], [118, 0.7, 0.38, 0.1], [196, 0.74, 0.42, 0.07], [252, 0.66, 0.45, 0.14],
];
/** 绽开的形状（审美评审：开场的正圆窥孔形状感太强，像聚光灯 / 幻灯片的「形状展开」）：开头是一个更扁的横向椭圆（竖 / 横 = 0.55）、羽化加倍，
    随绽开渐渐长成圆，2.7 s 绽满时与原来逐像素相同（蒙版撤掉时不会跳）。 */
export const BLOOM_FLAT = 0.55;
export const BLOOM_FEATHER_SOFT = 320;

/** 椭圆的竖 / 横比：开头扁、随绽开长成圆（绽满时 = 1）. */
export const bloomFlat = (t: number) => lerp(BLOOM_FLAT, 1, bloomE(win(t, BLOOM_T[0], BLOOM_T[1])));

/** 蒙版并集里的一层：中心 (cx, cy)、横 / 竖半径 (rx, ry)（舞台单位）、峰值 α、羽化宽 f（r0 = rx − f 以内是 α，往外线性到 0）. */
export interface BloomLayer { cx: number; cy: number; rx: number; ry: number; a: number; f: number }

/** 撤蒙版的条件（HEAD：`Rr >= 1560 || t >= DT.bloom[1]`）：之后 `.bd-bloom` 不带蒙版. Rr 到 2.7 s 才到 1500，所以实际就是 t ≥ BLOOM_T[1]；
    这个时刻（T_free）也是画布路径交班给 DOM 的时刻. */
export const bloomOpen = (t: number) => bloomRadius(t) >= 1560 || t >= BLOOM_T[1];
/** 绽开画布的交班时刻. */
export const T_FREE = BLOOM_T[1];

/** t 时刻蒙版并集的各层（主圆 1 + 花瓣 ≤ 6 + 中心 ≤ 3，共 ≤ 10 层；已撤蒙版的 t 返回空数组）. 顺序与 CSS 的 mask-image 层序一致（先列的在上；source-over 并集与顺序无关）. */
export function bloomLayers(t: number): BloomLayer[] {
  if (bloomOpen(t)) return [];
  const Rr = bloomRadius(t);
  const fea = lerp(BLOOM_FEATHER_SOFT, BLOOM_FEATHER[1], E.ease(win(t, BLOOM_T[0], BLOOM_T[1])));
  const alpha = (td: number) => E.ease(win(t - td, 0, 0.15));        // 每个中心 / 花瓣 0.15 s 淡入，第一帧还是一整屏雾
  const flat = bloomFlat(t);
  const out: BloomLayer[] = [];
  const [cx0, cy0] = DC.C0;
  out.push({ cx: cx0, cy: cy0, rx: Rr, ry: Rr * flat, a: alpha(BLOOM_MAIN_DELAY), f: fea });
  for (const [deg, dist, rad, td0] of BLOOM_PETALS) {
    const td = td0 + BLOOM_MAIN_DELAY;                                  // 瓣在主圆之后（主圆里是深色草地）
    const R1 = bloomRadius(t - td);
    if (t - td <= 0 || R1 < 30) continue;
    const th = (deg * Math.PI) / 180;
    out.push({ cx: cx0 + Math.cos(th) * dist * R1, cy: cy0 + Math.sin(th) * dist * R1 * flat, rx: rad * R1, ry: rad * R1 * flat, a: alpha(td), f: fea * 0.7 });
  }
  for (const [cx, cy, td, kk, fl] of BLOOM_CENTERS) {
    const R1 = bloomRadius(t - td) * kk;
    if (t - td <= 0 || R1 < 30) continue;
    out.push({ cx, cy, rx: R1, ry: R1 * lerp(fl, 1, bloomE(win(t - td, BLOOM_T[0], BLOOM_T[1]))), a: alpha(td), f: fea * 0.7 });
  }
  return out;
}

/** 一层的 CSS（与 0.1.3 的 `layer()` 逐字相同）. */
export function bloomLayerCss(l: BloomLayer): string {
  const r1 = Math.max(1, l.rx);
  const r0 = Math.max(0, l.rx - l.f);
  return `radial-gradient(${r1.toFixed(1)}px ${Math.max(1, l.ry).toFixed(1)}px at ${l.cx.toFixed(1)}px ${l.cy.toFixed(1)}px, rgba(0,0,0,${l.a.toFixed(3)}) 0, rgba(0,0,0,${l.a.toFixed(3)}) ${((r0 / r1) * 100).toFixed(2)}%, rgba(0,0,0,0) 100%)`;
}

/** `.bd-bloom` 的 mask-image 值：已撤蒙版 = 'none'，否则各层的 CSS 用逗号连起来（与 0.1.3 逐字相同）. */
export function bloomMaskCss(t: number): string {
  if (bloomOpen(t)) return 'none';
  return bloomLayers(t).map(bloomLayerCss).join(', ');
}

/** 一层覆盖的包围盒（舞台单位；渐变到 r1 处归零）. */
export function bloomLayerBox(l: BloomLayer): { x0: number; y0: number; x1: number; y1: number } {
  const r1 = Math.max(1, l.rx);
  const r2 = Math.max(1, l.ry);
  return { x0: l.cx - r1, y0: l.cy - r2, x1: l.cx + r1, y1: l.cy + r2 };
}

/** 各层包围盒的并集（空 = null）. */
export function bloomBox(ls: readonly BloomLayer[]): { x0: number; y0: number; x1: number; y1: number } | null {
  let b: { x0: number; y0: number; x1: number; y1: number } | null = null;
  for (const l of ls) {
    if (l.a <= 0.0004) continue;                           // α 取三位小数 = 0.000 的层什么都不画
    const c = bloomLayerBox(l);
    b = b ? { x0: Math.min(b.x0, c.x0), y0: Math.min(b.y0, c.y0), x1: Math.max(b.x1, c.x1), y1: Math.max(b.y1, c.y1) } : c;
  }
  return b;
}

/** 蒙版并集在 (x, y) 处的 α（舞台单位；CSS 的 mask-composite: add = source-over 并集 1 − Π(1 − αi)）——check-boot 对拍画布路径用. */
export function bloomAlphaAt(ls: readonly BloomLayer[], x: number, y: number): number {
  let keep = 1;
  for (const l of ls) {
    const r1 = Math.max(1, l.rx);
    const r2 = Math.max(1, l.ry);
    const d = Math.hypot((x - l.cx) / r1, (y - l.cy) / r2);          // 椭圆归一化距离：渐变的 0…100%
    if (d >= 1) continue;
    const r0 = Math.max(0, l.rx - l.f) / r1;
    const a = Number(l.a.toFixed(3)) * (d <= r0 ? 1 : 1 - (d - r0) / (1 - r0));
    keep *= 1 - a;
  }
  return 1 - keep;
}

/* ───────── 三道斜光束 ─────────
   早期氛围（7 s 前渐隐，终帧与样稿一致）。0.1.3 每拍写 left / width / background（带 α 的渐变）——整条 1900 px 高的旋转层每拍重新光栅（div.bd-stage 的 1506 个瓦片）。
   0.1.4：渐变固定成 α = 1 的一条，宽度 / 起点位置固定，每拍只写 transform（屏幕系平移 dx，与改 left 等价）与 opacity（= 原来的中心 α）；.beam 自身带 rotate(31.5deg)，
   所以 transform 写成 `translate3d(dx, 0, 0) rotate(31.5deg)`（先转后平移，平移在父层坐标系里；写成 rotate() translateX() 会差 R·dx）. */
export const BEAM_ROT = 31.5;
const BEAM_PH = [0.3, 2.1, 4.0] as const;
const BEAM_W = [150, 210, 120] as const;
const BEAM_A = [0.16, 0.12, 0.1] as const;
const BEAM_X = [0.78, 0.92, 0.64] as const;
const BEAM_DIR = [1, -1, 1] as const;
export const BEAM_TOP = 280 - 950;
/** 光束的淡入淡出系数的终点：L − 1.1 … L + 1.6（L = 落地时刻 5.0 s）. */
export const BEAM_FADE = { in: [0.1, 1.2], out0: 5.0 - 1.1, out1: 5.0 + 1.6 } as const;

/** 第 i 道光束在 t 时刻的 {中心 x、宽、中心 α}（0.1.3 的式子，逐字）. */
export function beamAt(i: number, t: number): { cx: number; w: number; a: number } {
  const fa = E.ease(win(t, BEAM_FADE.in[0], BEAM_FADE.in[1])) * (1 - sstep(win(t, BEAM_FADE.out0, BEAM_FADE.out1)));
  const TAU = Math.PI * 2;
  const ph = BEAM_PH[i];
  const a = BEAM_A[i] * fa * (1 + 0.3 * Math.sin((TAU * t) / 14 + ph));
  const cx = 1600 * BEAM_X[i] + (12 * t + 30 * Math.sin((TAU * t) / 14 + ph)) * BEAM_DIR[i] * 0.8;
  return { cx, w: BEAM_W[i], a };
}
/** 固定部分：left（= t = 0 时的中心 − 宽 / 2）、宽. */
export function beamBase(i: number): { left: number; w: number } {
  const b = beamAt(i, 0);
  return { left: b.cx - b.w / 2, w: b.w };
}
/** 每拍写的部分：屏幕系平移 dx（= cx(t) − cx(0)）、不透明度（= 中心 α）、要不要显示. */
export function beamFrame(i: number, t: number): { dx: number; opacity: number; on: boolean } {
  const b = beamAt(i, t);
  const b0 = beamAt(i, 0);
  return { dx: b.cx - b0.cx, opacity: b.a, on: b.a > 0.001 };
}
