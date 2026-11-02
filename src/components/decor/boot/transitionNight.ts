/* 转场 · 夜「栖于此」专属的纯函数与应用侧入场：夜的时间表（取景平移 / 暗纱 / 底板溶解）、快速版溶解的亮度整形、标题的色标与外发光、
   被打断时位图仿射到首页取景（plateFit）、左栏推入与底板的洞、左栏推入中的空面板。从 transition.ts 机械拆出（行为不变）。 */
import { clamp, lerp } from './bootMath';
import type { BackdropXf, Rect, TransitionKind } from './bootTypes';
import { COMMON, PAN_E, ROW_CLIP_PX, TR_FULL, hex, mixRgb, scaled, trDuration, type CommonSegs, type RGB, type Span } from './trCore';
import type { EntranceCtx, ThemeEntrance, TrState } from './transition';
import { CSS_EASE, PAN_CSS } from './trCore';

export interface NightSegs extends CommonSegs {
  /** 同一张壁纸：取景从开屏的构图平移到首页的构图；左栏面板同步推入、把这个画面「推开」. */
  pan: Span;
  /** 开屏的暗纱（顶 / 左 / 下）淡出：与主栏玻璃同段（暗纱撤得慢、玻璃进得慢，主栏区的亮度才不会「亮—暗—亮」地泵一下）. */
  shade: Span;
  /** 开屏的整张底图溶掉，露出首页壁纸层. */
  dissolve: Span;
}

const NIGHT: NightSegs = { ...COMMON, pan: [0.1, 0.54], shade: [0.16, 0.8], dissolve: [0.4, 0.9] };

/** 夜的快速版不是简单按比例缩：定格那一帧的位图要仿射到首页取景（平移约 100 px 加上从推近状态缩回），按比例缩会把它挤进 0.18 s，读成镜头甩了一下。
    所以取景 / 左栏推入铺满 0.05–0.42 s（与左栏推入同一条曲线），溶解挪到 0.25–0.55 s（平移已过八成才开始溶）；左栏的字标在面板到位后（0.42 s）才原地淡入（≤ 0.1 s）。 */
const NIGHT_FAST: Partial<NightSegs> = { pan: [0.05, 0.42], nav: [0.05, 0.42], dissolve: [0.1, 0.62], titleSwap: [0.42, 0.5], titleOut: [0.5, 0.57] };
/* R5：快速版的溶解不再等平移铺开——首页壁纸层（夜）在溶解期间被套上与位图相同的剩余变换（见 SceneTransition.backdrop），两层作为一个整体一起收到位，
   所以溶解可以从 0.10 s 起、铺满 0.52 s：被打断时开屏画面比首页暗不少（3 s 时 1.3 倍、1 s 时 1.7 倍），这个亮度差要摊在 ≥ 30 帧里、且按「等比」推进
   （每帧相对变化相同；线性溶解在起点相对变化最大），逐帧全屏平均亮度变化才不超过 3%（STORYBOARD §1.5）。 */
/** 夜 · 被打断的那一刻：首页终态的平均亮度 ÷ 开屏第 from 秒的平均亮度（1920×1080、示例数据，逐 0.5 s 实测；之后靠线性插值）. */
export const LIGHT_RATIO: ReadonlyArray<readonly [number, number]> = [[0, 3.3], [0.5, 2.24], [1, 1.71], [1.5, 1.51], [2, 1.41], [2.5, 1.34], [3, 1.3], [3.5, 1.25], [4, 1.17], [4.5, 1.08], [5, 1.02], [5.5, 1.02], [6, 1.1], [7.4, 1.24]];
export function lightRatio(from: number): number {
  const T = LIGHT_RATIO;
  if (from <= T[0][0]) return T[0][1];
  for (let i = 1; i < T.length; i++) if (from <= T[i][0]) return lerp(T[i - 1][1], T[i][1], (from - T[i - 1][0]) / (T[i][0] - T[i - 1][0]));
  return T[T.length - 1][1];
}
/** 快速版溶解的不透明度：平均亮度按等比推进（亮度 = 起点 × R^p，对应的混合比 α = (R^p − 1) / (R − 1)）；R ≈ 1 时就是线性. */
export function dissolveFast(p: number, ratio: number): number {
  const R = Math.max(1.03, ratio);
  return (Math.pow(R, clamp(p)) - 1) / (R - 1);
}
/** 夜 · 开屏底板的不透明度 = 1 − 它：完整版 E.ease（定格后亮度差小），快速版按亮度差整形. */
export const dissolveAlpha = (kind: TransitionKind, st: Pick<TrState, 'dissolve' | 'dissolveP'>, from: number) => (kind === 'full' ? st.dissolve : dissolveFast(st.dissolveP, lightRatio(from)));

export const nightSegs = (kind: TransitionKind): NightSegs => (kind === 'full' ? NIGHT : { ...scaled(NIGHT, trDuration(kind) / TR_FULL), ...NIGHT_FAST });

/** 夜 · 开屏「栖枝」的渐变色标（自上而下）与外发光（drop-shadow 三层：偏移 / 模糊 / 色 / α）. */
export const NIGHT_TITLE_STOPS: ReadonlyArray<readonly [string, number]> = [['#faf8fc', 0], ['#e4dfe6', 28], ['#b99ec3', 66], ['#9a74ad', 100]];
export const NIGHT_TITLE_GLOW: ReadonlyArray<readonly [number, number, number, string, number]> = [[0, 2, 2, '8 6 22', 0.85], [0, 0, 24, '8 6 22', 0.8], [0, 0, 34, '134 92 152', 0.4]];
export const NIGHT_EN_COLOR = '#e8e3f8';
export function tintGradient(target: RGB, k: number): string {
  return `linear-gradient(180deg, ${NIGHT_TITLE_STOPS.map(([c, at]) => `${mixRgb(hex(c), target, k)} ${at}%`).join(', ')})`;
}
/** 外发光随 k 淡掉（k ≥ 1 时是 'none'，与字标一样没有发光）. */
export function tintGlow(k: number): string {
  if (k >= 0.999) return 'none';
  return NIGHT_TITLE_GLOW.map(([x, y, b, c, a]) => `drop-shadow(${x}px ${y}px ${b}px rgb(${c} / ${(a * (1 - k)).toFixed(3)}))`).join(' ');
}

/** 首页壁纸（decor.css 的 .wallpaper__frame）把图左缘放在哪：clamp(窗宽 − 图宽, fx·窗宽 − face·图宽, 160)；图宽 = max(窗宽, 窗高·16/9). */
export function wallpaperTx(W: number, H: number, fx: number, face: number): number {
  const imgW = Math.max(W, 1.7778 * H);
  return clamp(fx * W - face * imgW, W - imgW, 160);
}

/** 夜 · 被打断时的取景对齐。开屏的镜头在 5.6 s 前还在推近：定格的那一帧位图里，图左上角在 (−u0·z·imgW, −v0·z·imgH)、放大 z 倍（只是图的一部分）；
    首页壁纸的取景是图左缘 txTo、放大 1、顶边 0。返回把位图仿射过去的 (s, x, y)：屏幕点 P → (x, y) + s·P。
    以她的脸（u = face、v = FACE_V）为不动点，尺寸与首页壁纸一致（s = 1/z）；位图的右 / 下缘若因此露出（位图只是图的一部分）就多放大一点点盖住（≤ 8%）——
    不然两幅画溶解时她的脸会有双影. */
export const FACE_V = 0.35;
export interface PlateFit { s: number; x: number; y: number }
export function plateFit(o: { W: number; H: number; imgW: number; imgH: number; z: number; u0: number; v0: number; txTo: number; face: number }): PlateFit {
  const sx = o.z * o.imgW;
  const sy = o.z * o.imgH;
  const px = -o.u0 * sx + o.face * sx;               // 她的脸在位图里的屏幕位置
  const py = -o.v0 * sy + FACE_V * sy;
  const wx = o.txTo + o.face * o.imgW;               // 她的脸在首页壁纸里的屏幕位置
  const wy = FACE_V * o.imgH;
  const s0 = 1 / o.z;
  const need = Math.max((o.W - wx) / (s0 * (o.W - px)), (o.H - wy) / (s0 * (o.H - py)));
  const s = s0 * (need > 1 + 1e-9 ? Math.min(need * 1.002, 1.08) : 1);
  return { s, x: wx - s * px, y: wy - s * py };
}

/** 夜 · 被打断时位图（仿射到首页取景）在平移进度 pan 时相对它的终态还剩的变换：位图的 CSS 变换是 T(pan) = translate(lerp(0, aff.x), lerp(0, aff.y)) scale(lerp(1, aff.s))（原点在屏幕左上角），
    终态是 T(1) = aff（也就是首页壁纸的取景）。首页壁纸层上的一点（终态屏幕位置 P）对应位图上的 aff⁻¹(P)，此刻位图把它画在 T(pan)(aff⁻¹(P))——
    所以壁纸层只要套 T(pan)·aff⁻¹ 就与位图逐点重合（屏幕点 P → (x, y) + k·P）：k = lerp(1, aff.s, pan) / aff.s，(x, y) = lerp(0, aff, pan) − k·aff. */
export function plateResidual(aff: PlateFit, pan: number): BackdropXf {
  const k = lerp(1, aff.s, pan) / aff.s;
  return { k, x: lerp(0, aff.x, pan) - k * aff.x, y: lerp(0, aff.y, pan) - k * aff.y };
}

/** 左栏是不是一根贴着左缘的竖栏（窄窗口里它会变成顶部横条，那时不推入、不平移）. */
export const navPushable = (nav: Rect | undefined, W: number, H: number): nav is Rect => !!nav && nav.x < 4 && nav.h > 0.8 * H && nav.w >= 40 && nav.w < 0.4 * W;
/** 左栏面板推入时的平移（像素，≤ 0）：pan = 0 在屏外，pan = 1 到位. */
export const navPushX = (navW: number, pan: number) => -navW * (1 - pan);
/** 开屏底板在左边让出的宽度：左栏的右缘，且不小于壁纸平移露出的那条暗带（暗带永远藏在左栏下面，不会作为一条黑边滑进屏幕）. */
export const holeEdge = (navW: number, shift: number, pan: number) => Math.max(navW * pan, Math.max(0, shift));
/** 让出左边 x 像素的遮罩（x ≤ 0 时不要遮罩）. 实时播放不用它（见 holeClip），导出 / 测试沿用. */
export const holeMask = (x: number) => (x > 0.01 ? `linear-gradient(90deg, transparent ${x.toFixed(2)}px, #000 ${x.toFixed(2)}px)` : '');
/** 同一个洞，写成矩形裁切（clip-path: inset）：边是硬的，与 holeMask 的「x 之前透明、之后不透明」逐像素一致；
    但裁切不是遮罩——底板仍是一块不透明的矩形，合成器可以把它下面被盖住的整个界面（壁纸、玻璃、模糊）直接剔掉不画；用遮罩的话整个转场里下面的一切每帧都要画（GPU 是转场掉帧的瓶颈）. */
export const holeClip = (x: number) => (x > 0.01 ? `inset(0 0 0 ${x.toFixed(2)}px)` : '');

/** 夜 · 推入中的空面板：玻璃底色向这个颜色混 NAV_GLOW_K，条目开始浮现后 NAV_GLOW_OUT 秒内回到自己的颜色. */
export const NAV_GLOW: readonly [number, number, number] = [156, 138, 214];
export const NAV_GLOW_K = 0.1;
export const NAV_GLOW_OUT = 0.32;
/** 面板（宽 navW，推入段 navSpan，曲线 PAN_E）离到位只差 ROW_CLIP_PX 像素的时刻. */
export function rowBaseTime(navSpan: Span, navW: number): number {
  const target = 1 - Math.min(0.5, ROW_CLIP_PX / Math.max(1, navW));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (PAN_E(m) < target) lo = m; else hi = m; }
  return lerp(navSpan[0], navSpan[1], (lo + hi) / 2);
}

/** 夜 · 应用侧入场的专属部分：左栏面板随取景平移从屏外推入，推入中的空面板带一点薰衣草的光. */
export function nightEntrance(c: EntranceCtx): ThemeEntrance {
  const { nav, navRect, pushed, dur, kk, add, track, comp } = c;
  const S = c.S as NightSegs;
  const rowBase = pushed && navRect ? rowBaseTime(S.nav, navRect.w) : undefined;
  return {
    rowBase,
    panel() {
      if (!nav) return;
      // 玻璃（backdrop-filter）保持终态，只动它自己的 transform / opacity：逐帧改模糊半径是最贵的一种（背景又在动，每帧全屏重新模糊）
      const from: Record<string, string> = pushed && navRect ? { transform: `translateX(${(-navRect.w).toFixed(1)}px)` } : { opacity: '0', transform: 'translateX(-12px)' };
      const to: Record<string, string> = pushed ? { transform: 'none' } : { opacity: '1', transform: 'none' };
      // 推入与取景平移同一条曲线、同一段时间：它「推开」画面，黑带始终藏在它下面
      add(nav, track(from, to, S.nav, dur, pushed ? PAN_CSS : CSS_EASE));
      // 空面板别是一条近乎纯黑的竖条（R5：推入期间里面没有内容，左 0–215 区平均亮度从 27 掉到 14.5，终态是 22）：玻璃的底色在条目浮现之前带一点薰衣草的光（向 NAV_GLOW 混 10%），
      // 条目开始浮现时（rowBase）起 0.32 s 内回到它自己的颜色——空面板的亮度 ≥ 18，玻璃后面仍看得到壁纸的模糊色
      if (pushed && rowBase !== undefined) {
        const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?/.exec(getComputedStyle(nav).backgroundColor);
        if (m) {
          const out: Span = [rowBase, rowBase + NAV_GLOW_OUT * kk];
          if (comp) {
            // comp：backgroundColor 合成器画不了（逐拍 seek 的台阶）。改成 nav::after（z-index −1 的薰衣草色块，boot.css）的 opacity：K · α 原生缓动淡到 0（α = 玻璃底色的不透明度，叠上去的量与原来改底色等价）
            add(nav, track({ opacity: (NAV_GLOW_K * parseFloat(m[4] ?? '1')).toFixed(4) }, { opacity: '0' }, out, dur, CSS_EASE), '::after');
          } else {
            const cur = `rgb(${m[1]} ${m[2]} ${m[3]} / ${m[4] ?? 1})`;
            const lit = `rgb(${[1, 2, 3].map((i) => Math.round(lerp(parseFloat(m[i]), NAV_GLOW[i - 1], NAV_GLOW_K))).join(' ')} / ${m[4] ?? 1})`;
            const h0 = clamp(rowBase / dur);
            const h1 = clamp((rowBase + NAV_GLOW_OUT * kk) / dur);
            add(nav, [{ offset: 0, backgroundColor: lit }, { offset: h0, backgroundColor: lit, easing: CSS_EASE }, { offset: Math.max(h0, h1), backgroundColor: cur }, { offset: 1, backgroundColor: cur }], undefined, true);
          }
        }
      }
    },
  };
}
