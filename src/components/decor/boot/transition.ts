/* 开屏 → 主界面的转场：夜「栖于此」/ 昼「花海收进窗」。
   · 它是开屏的最后一幕，不是另一个页面：开屏停在定格画面（或被打断的那一帧）时，同一批元素带着去处离开——
     蝶飞向左栏的品牌标「枝上蝶」收翅停入（标亮一次）、「栖枝 ALIGHT」缩小滑进左栏字标的位置、署名滑到壁纸里它该在的地方；
     夜：同一张壁纸做一次取景平移，接上首页壁纸层再溶掉；昼：官方立绘从全屏矩形收成右侧拱窗的形状（窗的左缘比立绘的缩放走得急，奶油纸面的前缘 = 窗的左缘：窗让开、纸露出来，全屏只有一条移动的竖边）。
     昼的窗落影不是 CSS box-shadow（几何每个节拍都在变，整片模糊每个节拍重画是这一幕最贵的一步），而是低分辨率画布上的模糊 + 沿窗的轮廓裁掉里面（dayScene.drawShadow）。
   · 所有视觉状态是转场时刻 tr 的纯函数（本文件的 trState 与几何函数；场景与应用侧的写样式只读它们），所以导出模式能用
     window.__boot.seek(t) 逐帧驱动，实时播放与导出逐像素一致。应用界面里的元素用 WAAPI，结束时 cancel() 掉——不留 fill、不留内联样式
     （有 backdrop-filter 的面板祖先上留了 opacity / filter / transform 的动画，玻璃会整片失效）。
     实时播放时 WAAPI 动画**自己跑**（Entrance.play：同一个起点一次性对齐 startTime，opacity / transform 交给合成器，240 Hz 屏上仍是满帧率），
     只有合成器画不了的那几个（昼的纸面遮罩、夜的左栏底色）和场景的画布 / 样式写入按匀速节拍（pacer.ts，240 Hz 每 4 帧一次 = 60 fps）一步步推进；
     导出模式（__boot.seek）才逐帧把所有动画的 currentTime 都设一遍. 玻璃只做自身的 opacity / transform 淡入，**不再动画 backdrop-filter 的模糊半径**
     （逐帧改模糊半径、背景又在动，每帧全屏重新模糊，是转场掉帧的主因）。
   · 总长：完整版 1.2 s（开屏已定格）、快速版 0.7 s（开屏还没播完就被打断）；减少动态 / 被迫定格只做 ≤200 ms 的交叉淡化（BootSplash）。
     快速版与完整版走同一套（只是整体缩放）：被打断那一刻还没浮现的标题不带（从它此刻的状态淡出，不在第一帧冒出来）；夜把定格那一帧的位图仿射到首页取景（plateFit）再溶解，
     昼用人物分身做压缩的收窗——都不再是「两幅不同取景的画直接交叉溶解 / 人物先淡出再淡入」。
   · 不阻塞输入：覆盖层 pointer-events:none；焦点在转场开始时就交给首页输入框（BootSplash）。
   · 尾流：标题与蝶是在界面「上方」飞过的东西，应用侧的元素（左栏条目、内容块）等它们飞过自己的位置再浮现，不会叠成「AL新开HT」。
     应用侧元素的浮现时刻由 scene.obstacles(tr)（标题 / 蝶此刻占的矩形）与量好的目标矩形算出，仍是 tr 的确定函数。
     昼里收窗中的「窗」（scene.cover(tr)）也是障碍物：文字等窗的竖直边缘越过自己再浮现，不被它切掉一半。
   · 内容块分档浮现：输入框第一档（与日期行、归来简同档），其余每档晚 40 ms；夜里左栏面板推入期间面板里没有内容，到位后条目才自下而上浮现。
   · 标题组（栖枝 + ALIGHT）整体缩进并把色标 / 外发光（夜）、字色 / 阴影（昼）收敛到字标的样子；蝶身后的光尘拖尾寿命 ≤ 100 ms；枝的分身随蝶落定一笔画完（0.58–0.80 s）。
   R5（审美评审第五轮）：夜的首页壁纸层在转场期间与开屏位图一起套同一个剩余变换（SceneTransition.backdrop / plateResidual：两层作为一个整体收到位，溶解可以与平移重叠而没有重影），
     被打断时亮度差按「等比」摊开（dissolveFast）；昼的窗左缘高速时让位给 140 px 的纸面软边（winEdgeAlpha / winSoft，dayScene.ts）；枝的分身从蝶的落脚点往两头长（createTwigFx）；
     光尘拖尾 60% 放出 + 法向抖动；左栏条目从面板离到位只差 9 px 起（rowBaseTime）、快速版每行 0.24 s；昼第一档内容 0.28 s。
   本文件的纯函数部分（时间表、缓动、FLIP、飞行路径、拱窗裁切、取景）不碰 DOM，scripts/check-boot.ts 逐项检查。 */
import { E, TAU, clamp, lerp, mulberry32, sstep, win, bez, bezD } from './bootMath';
import { BRAND_TWIG_MAIN, BRAND_TWIG_SIDE } from '../marks';
import type { Seg as Bezier } from './bootMath';
import type { BootScene, BootTheme, Rect, TrAnchors, TrShared, TransitionKind } from './bootTypes';
import { bootImpl, governedForTransition } from './bootImpl';
import { tp } from './prof';
import { bootGovernor } from './governor';
import { Pacer } from './pacer';
import { Stager, TR_ANIM_ID } from './sampler';
import { ART_E, CSS_EASE, FLIP_E, FLY_E, PAN_E, PAPER_E, WIN_E, prog, TR_FULL, trDuration, type Pt, type Span } from './trCore';
import { dayEntrance, daySegs, type DaySegs } from './transitionDay';
import { navPushX, nightEntrance, nightSegs, type NightSegs } from './transitionNight';

/* 拆分（行为不变）：共享底座 trCore.ts、夜专属 transitionNight.ts、昼专属 transitionDay.ts；这里把它们 re-export 出去，
   check-boot 与场景里的 `import … from './transition'` 照旧。本文件保留：tr 的状态函数、枝 / FLIP / 光尘 / 飞行、尾流与分档、量目标位置、应用侧入场（夜昼的专属部分在各自文件里）、转场时钟、beginTransition。 */
export * from './trCore';
export * from './transitionNight';
export * from './transitionDay';


/** 主栏里的内容块（日期行、归来简、待你、离开期间、最近会话、输入框…）分档浮现：**输入框第一档**，日期行与归来简同档（用户一落座就要能打字，打的字不能等 1 s 才看得见），
    其余按 DOM 顺序每档晚 40 ms，最多错开 4 档（再多的并在最后一档）。夜从 0.46 s（主栏玻璃 0.40 s 起）、昼从 0.40 s（窗的左缘越过它们、纸面前缘落过它们的那一刻）起. */
export const BLOCK_START = 0.46;
export const BLOCK_START_DAY = 0.4;
export const BLOCK_STEP = 0.04;
export const BLOCK_DUR = 0.42;
/** 昼 · 第一档（输入框、日期行、归来简）浮现得更利落（R5）：宽 780 px 的奶油纸前缘越过主栏右缘（≈ 0.35 s）之后，第一块内容不能再让纸空 80 ms——
    时长 0.28 s、起段更陡的 ease-out（wake 之后 70 ms 内有效不透明度就过 0.5）；后几档仍是 0.42 s. */
export const BLOCK_DUR_FIRST_DAY = 0.28;
export const BLOCK_EASE_FIRST = 'cubic-bezier(0.12, 0.85, 0.2, 1)';
export const BLOCK_CAP = 4;
export function blockSpan(kind: TransitionKind, tier: number, start = BLOCK_START, firstDur = BLOCK_DUR): Span {
  const k = trDuration(kind) / TR_FULL;
  const s = (start + BLOCK_STEP * Math.min(Math.max(0, tier), BLOCK_CAP)) * k;
  return [s, s + (tier <= 0 ? firstDur : BLOCK_DUR) * k];
}
/** 每个块的档（0 = 第一档）：输入框 0；日期行与归来简（DOM 的头两块）同在最前一档；之后每块一档. */
export function blockTiers(count: number, inputIdx: number): number[] {
  const out: number[] = [];
  let j = 0;
  for (let i = 0; i < count; i++) {
    if (i === inputIdx) { out.push(0); continue; }
    out.push(Math.max(0, j - 1));
    j++;
  }
  return out;
}

/* ───────────── 状态：tr 的纯函数 ───────────── */

export interface TrState {
  /** 蝶沿路径的进度（已套飞行缓动）：起飞前 0，落到标上 1. */
  fly: number;
  /** 蝶的原始路径进度（未套缓动，0–1）：枝的生长绑在它上面. */
  flyRaw: number;
  /** 翅膀拍动的幅度：起飞渐起、临近落点渐收（0 = 保持原样，1 = 全幅）. */
  flap: number;
  swap: number;
  swapOut: number;
  glow: number;
  title: number;
  /** 标题的色标 / 外发光 / 字色向字标的样子收敛的进度. */
  tint: number;
  titleSwap: number;
  titleOut: number;
  credit: number;
  creditSwap: number;
  creditOut: number;
  creditIn: number;
  ambient: number;
  nav: number;
  glass: number;
  console: number;
  pan: number;
  shade: number;
  /** 夜 · 开屏底板溶解的进度（完整版已套缓动；快速版请用 dissolveAlpha，按亮度差整形）. */
  dissolve: number;
  /** 夜：溶解的线性进度（0–1，未套缓动）. */
  dissolveP: number;
  art: number;
  /** 昼：窗的左缘（与拱顶圆角）的进度（比 art 急）. */
  winL: number;
  figOn: number;
  figIn: number;
  figOut: number;
  wash: number;
  wOut: number;
  scene: number;
  /** 昼：开屏里的题辞 / 横幅 / 提示的淡出（赶在纸面前缘到达之前）. */
  textOut: number;
  /** 昼：窗里临时薰衣草底在右上 1/3 的提前淡入. */
  washTop: number;
  bg: number;
  /** 昼 · 没有窗时的底板溶解（按时间）. */
  bgF: number;
  paper: number;
}

/** 翅膀拍动幅度：飞行段的头 15% 渐起、后 20% 渐收. */
export const flapAmp = (u: number) => sstep(u / 0.15) * (1 - sstep((u - 0.8) / 0.2));

export function trState(theme: BootTheme, kind: TransitionKind, tr: number): TrState {
  const S = theme === 'night' ? nightSegs(kind) : daySegs(kind);
  const u = prog(tr, S.fly);
  const st: TrState = {
    fly: FLY_E(u),
    flyRaw: u,
    flap: flapAmp(u),
    swap: prog(tr, S.swap),
    swapOut: prog(tr, S.swapOut),
    glow: prog(tr, S.glow),
    title: FLIP_E(prog(tr, S.title)),
    tint: E.inout(prog(tr, S.tint)),
    titleSwap: prog(tr, S.titleSwap),
    titleOut: prog(tr, S.titleOut),
    credit: FLIP_E(prog(tr, S.credit)),
    creditSwap: prog(tr, S.creditSwap),
    creditOut: prog(tr, S.creditOut),
    creditIn: 0,
    ambient: prog(tr, S.ambient),
    nav: theme === 'night' ? PAN_E(prog(tr, S.nav)) : E.ease(prog(tr, S.nav)),
    glass: E.ease(prog(tr, S.glass)),
    console: E.ease(prog(tr, S.console)),
    pan: 0, shade: 0, dissolve: 0, dissolveP: 0, art: 0, winL: 0, figOn: 0, figIn: 0, figOut: 0, wash: 0, wOut: 0, scene: 0, textOut: 0, washTop: 0, bg: 0, bgF: 0, paper: 0,
  };
  if (theme === 'night') {
    const N = S as NightSegs;
    st.pan = PAN_E(prog(tr, N.pan));
    st.shade = FLIP_E(prog(tr, N.shade));       // 暗纱一撤整屏变亮：起得慢一点，逐帧亮度变化才不超过 3%（STORYBOARD §1.5）
    st.dissolveP = prog(tr, N.dissolve);
    st.dissolve = E.ease(st.dissolveP);
  } else {
    const D = S as DaySegs;
    st.art = ART_E(prog(tr, D.art));
    st.winL = WIN_E(prog(tr, D.win));
    st.figOn = sstep(prog(tr, D.figOn));
    st.figIn = prog(tr, D.figIn);
    st.figOut = prog(tr, D.figOut);
    st.wash = sstep(prog(tr, D.wash));          // 对称的 smoothstep：中点落在 0.535 s，正是运动最快的时候；ease-out 会把换景挤在 0.35–0.45 s
    st.wOut = prog(tr, D.wOut);
    st.scene = E.ease(prog(tr, D.scene));
    st.textOut = E.ease(prog(tr, D.textOut));
    st.washTop = sstep(prog(tr, D.washTop));
    st.bg = sstep(prog(tr, D.bg));          // smoothstep：左栏那一条从亮雾变成壁纸的颜色（约 -14 级）慢慢走，逐 0.025 s 的变化 ≤ 1.5 级
    st.bgF = E.ease(prog(tr, D.bgF));
    st.paper = PAPER_E(prog(tr, D.paper));
    st.creditIn = prog(tr, D.creditIn);
  }
  return st;
}

/** 枝的分身（品牌标里那根细枝）的生长：绑在蝶的路程上，并且**从蝶的落脚点往两头长**（R5）。
    原来是从枝根往蝶的方向画——第一段看得见的笔画是悬在蝶左边的一个水平短横，像连字符或运动残影；
    现在每一帧的笔画都连着落脚点（蝶身正下方），读成「蝶落处生出枝」：枝在落脚点那里先冒出一小段，再向枝根与枝梢两头延伸。
    起长的时刻 = 蝶的方框第一次盖住落脚点（twigOpen），不早于蝶飞过 72.5%（完整版 0.58 s）；随蝶临近一笔画完，落定那一帧（0.80 s）恰好长满。起步与收笔都是缓的（smoothstep）. */
export const TWIG_FROM = 0.725;
export const twigGrow = (flyRaw: number, open = 0) => sstep(win(flyRaw, Math.max(TWIG_FROM, open), 1));
/** 枝的分身整体的不透明度：生长的前 30% 从 0 升到 1——起笔那一小段不会作为一道孤立的短笔画读出来. */
export const twigAlpha = (grow: number) => sstep(win(grow, 0, 0.3));

/** 品牌标（40×40 的 viewBox）里蝶身下端的位置：Sprite.tsx 的 alt-brand 里翅膀组 translate(15.4 9.4) rotate(−14 12.4 16.7) scale(.62)，身体线 (20, 27) 经变换 ≈ (27.8, 26.1). */
export const BRAND_BODY_FOOT: Pt = [27.8, 26.1];
const NUM_RE = /-?\d*\.?\d+/g;
interface Poly { pts: Pt[]; cum: number[]; total: number }
/** 把 BRAND_TWIG_MAIN（M + 若干段 C）采成折线并累计弧长（与 SVG 的 pathLength = 1 对得上）. */
function twigPoly(d: string): Poly {
  const n = (d.match(NUM_RE) ?? []).map(Number);
  const pts: Pt[] = [[n[0], n[1]]];
  let cur: Pt = [n[0], n[1]];
  for (let i = 2; i + 5 < n.length; i += 6) {
    const seg: Bezier = [cur, [n[i], n[i + 1]], [n[i + 2], n[i + 3]], [n[i + 4], n[i + 5]]];
    for (let k = 1; k <= 200; k++) pts.push(bez(seg, k / 200));
    cur = seg[3];
  }
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  return { pts, cum, total: cum[cum.length - 1] };
}
/** 折线上离 p 最近的点：弧长进度（0–1）与坐标. */
function nearestOn(P: Poly, p: Pt): { s: number; pt: Pt } {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < P.pts.length; i++) { const d = Math.hypot(P.pts[i][0] - p[0], P.pts[i][1] - p[1]); if (d < bd) { bd = d; best = i; } }
  return { s: P.cum[best] / P.total, pt: P.pts[best] };
}
const MAIN_POLY = twigPoly(BRAND_TWIG_MAIN);
/** 落脚点：主枝上离蝶身下端最近的一点（弧长进度 s 与 40×40 里的坐标）. */
export const TWIG_FOOT = nearestOn(MAIN_POLY, BRAND_BODY_FOOT);
/** 三根小杈：d 是各自的路径，need = 主枝要长到多少（grow）才盖住它的附着点——它在主枝覆盖到之后才淡入，从不悬在一边. */
export const TWIG_SUBS: ReadonlyArray<{ d: string; need: number }> = BRAND_TWIG_SIDE.split(/(?=M)/).filter(Boolean).map((d) => {
  const m = d.match(NUM_RE) ?? [];
  const s = nearestOn(MAIN_POLY, [Number(m[0]), Number(m[1])]).s;
  const f = TWIG_FOOT.s;
  return { d, need: s <= f ? (f - s) / Math.max(1e-6, f) : (s - f) / Math.max(1e-6, 1 - f) };
});
/** 主枝已显现的弧长区间（进度 grow）：以落脚点为中心，向枝根与枝梢按比例同时延伸，grow = 1 时是整根枝. */
export const twigSpan = (grow: number): Span => [TWIG_FOOT.s * (1 - grow), TWIG_FOOT.s + (1 - TWIG_FOOT.s) * grow];
export const twigSubAlpha = (grow: number, need: number) => { const a = Math.min(need, 0.8); return sstep(win(grow, a, a + 0.2)); };
/** 落脚点（屏幕像素）在蝶的方框里的深度（负 = 在框外）；枝只在落脚点进了蝶的方框之后才看得见（每一帧的枝都接触蝶）. */
export const twigFootDepth = (foot: Pt, box: Rect) => Math.min(foot[0] - box.x, box.x + box.w - foot[0], foot[1] - box.y, box.y + box.h - foot[1]);
export const twigGate = (depth: number) => sstep(win(depth, 0, 4));
export const twigFootScreen = (mark: Rect): Pt => [mark.x + (TWIG_FOOT.pt[0] / 40) * mark.w, mark.y + (TWIG_FOOT.pt[1] / 40) * mark.h];
/** 蝶的方框第一次盖住落脚点（深度 ≥ 1 px）时的路径原始进度 flyRaw（从 0.5 起扫；蝶始终自下而上近乎竖直地升入，之后不会再出框）. */
export function twigOpen(start: BfPose, goal: BfGoal, path: Bezier, foot: Pt): number {
  for (let i = 0; i <= 500; i++) {
    const u = 0.5 + i / 1000;
    if (twigFootDepth(foot, bfBox(bfFlight(start, goal, path, FLY_E(u), 0, 0))) >= 1) return u;
  }
  return 1;
}

export interface TwigFx {
  readonly el: SVGSVGElement;
  /** flyRaw = 蝶的路径原始进度；swapOut = 真标淡入之后分身淡出的进度；box = 蝶此刻的方框（没有蝶 = null → 不画）. */
  update(flyRaw: number, swapOut: number, box: Rect | null): void;
}
/** 品牌标那根细枝的分身（SVG，叠在左栏的品牌标位置上）：主枝用 stroke-dasharray / dashoffset 以落脚点为中心向两头长；小杈随主枝覆盖到再淡入. */
export function createTwigFx(host: HTMLElement, mark: Rect, o: { stroke: string; wMain: number; wSide: number; open: number }): TwigFx {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'boot__twig');
  svg.setAttribute('viewBox', '0 0 40 40');
  svg.setAttribute('aria-hidden', 'true');
  svg.style.cssText = `left:${mark.x}px;top:${mark.y}px;width:${mark.w}px;height:${mark.h}px;opacity:0`;
  svg.innerHTML = `<path class="m" d="${BRAND_TWIG_MAIN}" pathLength="1" fill="none" stroke="${o.stroke}" stroke-width="${o.wMain}" stroke-linecap="round" stroke-dasharray="0 3" stroke-dashoffset="0"/>`
    + TWIG_SUBS.map((t) => `<path class="s" d="${t.d}" fill="none" stroke="${o.stroke}" stroke-width="${o.wSide}" stroke-linecap="round" opacity="0"/>`).join('');
  host.appendChild(svg);
  const main = svg.querySelector<SVGPathElement>('.m') as SVGPathElement;
  const subs = Array.from(svg.querySelectorAll<SVGPathElement>('.s'));
  const foot = twigFootScreen(mark);
  // 写入前对同值去重：每个 rAF 都会调 update，枝没长的那些帧（起步前 / 落定后）什么都不该写（原来子杈的 opacity 同值重写 207 次）
  const last = { dash: '', off: '', op: '', disp: '#', subs: subs.map(() => '') };
  return {
    el: svg,
    update(flyRaw, swapOut, box) {
      const grow = twigGrow(flyRaw, o.open);
      const [a] = twigSpan(grow);
      const dash = `${grow.toFixed(4)} 3`;
      const off = (-a).toFixed(4);
      if (dash !== last.dash) { last.dash = dash; main.setAttribute('stroke-dasharray', dash); }
      if (off !== last.off) { last.off = off; main.setAttribute('stroke-dashoffset', off); }
      subs.forEach((p, i) => { const v = twigSubAlpha(grow, TWIG_SUBS[i].need).toFixed(3); if (v !== last.subs[i]) { last.subs[i] = v; p.setAttribute('opacity', v); } });
      const gate = box ? twigGate(twigFootDepth(foot, box)) : 0;
      const op = (twigAlpha(grow) * gate * (1 - swapOut)).toFixed(3);
      if (op !== last.op) { last.op = op; svg.style.opacity = op; }
      const disp = swapOut >= 1 ? 'none' : '';
      if (disp !== last.disp) { last.disp = disp; svg.style.display = disp; }
    },
  };
}


/** FLIP：元素 el（transform-origin 取它的左上角）里的一段文字占着 src 矩形；返回把它放到 dst 矩形所需的平移与均匀缩放（屏幕像素）. */
export interface Flip { x: number; y: number; s: number }
export function flipTo(el: Rect, src: Rect, dst: Rect): Flip {
  const s = dst.h / src.h;
  return { s, x: dst.x - el.x - (src.x - el.x) * s, y: dst.y - el.y - (src.y - el.y) * s };
}
/** 署名是右对齐的文字：缩放后让右缘与目标的右缘对齐（两处的文字长短可以不同，长的不会伸出窗口）. */
export function flipRight(el: Rect, dst: Rect): Flip {
  const s = dst.h / el.h;
  return flipTo(el, el, { x: dst.x + dst.w - el.w * s, y: dst.y, w: el.w * s, h: dst.h });
}
/** 进度 p（0 = 原位原大小，1 = 到位）：平移线性、缩放取几何插值（缩小时看起来匀速）. */
export function flipAt(f: Flip, p: number): Flip {
  return { x: f.x * p, y: f.y * p, s: Math.pow(f.s, p) };
}
/** 元素 el 里的文字矩形 src 经 FLIP 变换 f 之后此刻占的矩形（flipTo 的正向）. */
export function flipRectAt(el: Rect, src: Rect, f: Flip): Rect {
  return { x: el.x + f.x + (src.x - el.x) * f.s, y: el.y + f.y + (src.y - el.y) * f.s, w: src.w * f.s, h: src.h * f.s };
}
/** 写成 CSS transform；parentScale = 元素所在容器已有的缩放（昼的舞台 scale(k)）：平移要换算成容器的局部单位. */
export const flipCss = (f: Flip, parentScale = 1) => `translate(${(f.x / parentScale).toFixed(2)}px, ${(f.y / parentScale).toFixed(2)}px) scale(${f.s.toFixed(5)})`;

/** 标题组（「栖枝」+「ALIGHT」）作为一个整体缩进左栏字标：以「栖枝」的左上角为组锚，ALIGHT 的左上角跟着整体缩放；开屏里的 ALIGHT 是居中、两侧带线的（左缘缩进约 76 px），
    字标里它是左对齐的——这点差别在前 35% 的行程里（两侧的线此时正好淡掉）收完，之后 ALIGHT 相对「栖枝」的位置 / 行距就是刚体（字高自己按整段行程几何插值）。
    不这样做的话，两个元素各自 FLIP（平移线性、缩放按几何插值）在中途会各滑各的：ALIGHT 相对「栖枝」偏右约 40 px、行距偏大，0.6 s 才并拢（评审 R4）. */
export const SUB_ALIGN = 0.35;
export interface TitleGroup { h1Box: Rect; h1Src: Rect; h1Dst: Rect; enSrc: Rect; enDst: Rect }
export function titleGroupAt(g: TitleGroup, p: number): { h1Flip: Flip; h1Rect: Rect; enRect: Rect } {
  const f = flipTo(g.h1Box, g.h1Src, g.h1Dst);
  const fp = flipAt(f, p);
  const h1Rect = flipRectAt(g.h1Box, g.h1Src, fp);
  const S1 = f.s;
  // 「ALIGHT」相对「栖枝」左上角的位置，用源（开屏）的像素单位：起点是开屏里的偏移，终点是字标里的偏移换算回来
  const loSrc: Pt = [g.enSrc.x - g.h1Src.x, g.enSrc.y - g.h1Src.y];
  const loDst: Pt = [(g.enDst.x - g.h1Dst.x) / S1, (g.enDst.y - g.h1Dst.y) / S1];
  const ratio = g.enDst.h / (g.enSrc.h * S1);
  const w = sstep(p / SUB_ALIGN);
  const lo: Pt = [lerp(loSrc[0], loDst[0], w), lerp(loSrc[1], loDst[1], w)];
  const sc = fp.s * Math.pow(ratio, p);                 // 字高：ALIGHT 自己比「栖枝」收得慢一些（字标里它相对更大），按整段行程几何插值——只有左上角的位置是刚体
  return { h1Flip: fp, h1Rect, enRect: { x: h1Rect.x + fp.s * lo[0], y: h1Rect.y + fp.s * lo[1], w: g.enSrc.w * sc, h: g.enSrc.h * sc } };
}

/** 转场里蝶身后的光尘拖尾：每隔约 12 ms（±30%）有一次放出机会，**只有 60% 放出**（R5：蝶竖直上升时原来 4–6 粒间距相近的点排成一条竖直虚线），寿命 ≤ 100 ms（每粒 60–100 ms 各不相同），
    位置取它放出那一刻蝶所在的地方——点距随速度拉开（飞得快时疏、收尾减速时密）——再沿路径的法向抖 ±6 px（切向另有 ±3 px 的细抖），
    尺寸与亮度各随机 ±30%，读成一缕光尘，不是一串等距的圆点。avoid 里的矩形（此刻的标题）周围 16 px 内的点不画（淡到 0）. */
export const DUST_LIFE = 0.1;
export const DUST_EMIT = 0.012;
export const DUST_P = 0.6;
export const DUST_NORMAL = 6;
export interface DustDot { x: number; y: number; a: number; r: number }
export function dustDots(path: Bezier, fly: Span, tr: number, seed: number, avoid: Rect[] = []): DustDot[] {
  const out: DustDot[] = [];
  const j0 = Math.max(0, Math.floor((tr - DUST_LIFE - fly[0]) / DUST_EMIT) - 1);
  const j1 = Math.floor((tr - fly[0]) / DUST_EMIT) + 1;
  for (let j = j0; j <= j1; j++) {
    const rr = mulberry32(seed + j * 131);
    const te = fly[0] + (j + 0.5 + (rr() - 0.5) * 0.6) * DUST_EMIT;
    const sz = 0.7 + 0.6 * rr();
    const br = 0.7 + 0.6 * rr();
    const jx = (rr() - 0.5) * 6;
    const jy = (rr() - 0.5) * 6;
    const keep = rr() < DUST_P;
    const jn = (rr() * 2 - 1) * DUST_NORMAL;
    const life = DUST_LIFE * (0.6 + 0.4 * rr());
    const age = tr - te;
    if (!keep || age < 0 || age > life || te > fly[1]) continue;
    const u = FLY_E(win(te, fly[0], fly[1]));
    const p = bez(path, clamp(u));
    const d = bezD(path, clamp(u, 0.001, 0.999));
    const dl = Math.hypot(d[0], d[1]) || 1;
    let a = Math.pow(1 - age / life, 1.4) * br * sstep(win(u, 0, 0.12)) * (1 - sstep(win(u, 0.9, 1)));
    const x = p[0] + jx + (-d[1] / dl) * jn;
    const y = p[1] + jy + (d[0] / dl) * jn;
    for (const b of avoid) {
      const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
      const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
      a *= sstep(Math.hypot(dx, dy) / 16);
    }
    if (a > 0.004) out.push({ x, y, a, r: sz });
  }
  return out;
}

/** 蝶的飞行路径（屏幕像素的三次贝塞尔）：先抬头升起（略向后、远离目的地一点点）、再弧向目的地，最后**从品牌标的正下方、略偏 a 的一侧升入**。
    落点右边紧挨着就是飞来的标题（字标占着 62–128 px 的横条），蝶若从右边横着飘入，会贴在「栖枝」两个字上爬过（评审 R2：0.47–0.60 s 重叠约 80%）；
    所以收尾的那一段走在标题的左下方（rise ≥ 130 px 的近乎竖直升入，x 始终在标题左缘之左）——标题是从右下方滑进来的，两者各走各的，互不穿过。
    bend 放大 / 缩小这些侧向的摆幅. */
export const FLIGHT_RISE = [130, 340] as const;
export function flightPath(a: Pt, b: Pt, bend = 1): Bezier {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const sx = Math.sign(dx) || -1;
  const sy = Math.sign(dy) || -1;
  const rise = clamp(Math.abs(dy) * 0.45, FLIGHT_RISE[0], FLIGHT_RISE[1]);
  // 起点在目的地的左上方不远处（昼：自枝梢出发，横向远大于纵向）时，标题是从下方斜着往同一个角落爬的：蝶要在标题爬到它所在的高度之前先横着抢进左缘的竖直通道，
  // 所以横向占优时 c1 更靠近目的地、更少上抬（h = 0 → 夜：蝶在标题的正下方很远，原来的弧线就不会相撞）
  const h = clamp((Math.abs(dx) - Math.abs(dy)) / Math.max(1, Math.abs(dx)), 0, 1);
  const c1: Pt = [a[0] + dx * (0.15 + 0.4 * h) - sx * Math.abs(dy) * 0.12 * bend, a[1] + dy * (0.35 - 0.2 * h)];
  const c2: Pt = [b[0] - sx * (Math.abs(dx) * 0.03 + 14) * bend, b[1] - sy * rise * bend];
  return [a, c1, c2, b];
}

/** 蝶的一帧（x, y 是翅膀方框的中心；w 是翼展像素；rot 弧度；flap 是翅膀的横向开合 0.04–1；alpha 不透明度）. */
export interface BfPose { x: number; y: number; w: number; rot: number; flap: number; alpha: number }
export interface BfGoal { x: number; y: number; w: number; rot: number }

const wrapNear = (ang: number, ref: number) => { let a = ang; while (a - ref > Math.PI) a -= TAU; while (a - ref < -Math.PI) a += TAU; return a; };

/** 沿路径 g 飞行：fly = 已套缓动的路径进度，amp = 拍翅幅度，tr = 转场时刻（拍翅的相位）. */
export function bfFlight(a: BfPose, b: BfGoal, g: Bezier, fly: number, amp: number, tr: number): BfPose {
  const t = clamp(fly);
  const p = bez(g, t);
  const d = bezD(g, clamp(t, 0.001, 0.999));
  const head = wrapNear(Math.atan2(d[1], d[0]) + Math.PI / 2, a.rot);      // 蝶头朝着前进的方向
  const up = sstep(win(t, 0, 0.25));
  const down = sstep(win(t, 0.6, 1));
  const rot = lerp(lerp(a.rot, head, up), wrapNear(b.rot, head), down);
  const beat = 0.71 + 0.29 * Math.cos(TAU * 2.5 * tr);                     // 与开屏里飞行时的拍翅同一个频率（2.5 Hz）
  const flap = lerp(lerp(a.flap, beat, amp), 1, sstep(win(t, 0.88, 1)));   // 落到标上时翅膀平展
  return {
    x: p[0], y: p[1],
    w: a.w * Math.pow(b.w / a.w, t),
    rot, flap: Math.max(0.04, flap),
    alpha: lerp(a.alpha, 1, sstep(win(t, 0, 0.1))),
  };
}

/** 品牌标「枝上蝶」里那只蝶（Sprite.tsx 的 symbol alt-brand，40×40）：方框中心在 (0.654, 0.488)、翼展 0.62 个方框、转 −14°（与开屏里停枝的休止姿态同角度）. */
export const BRAND_BF = { cx: 0.654, cy: 0.488, w: 0.62, rot: (-14 * Math.PI) / 180 } as const;
export const brandGoal = (mark: Rect): BfGoal => ({ x: mark.x + mark.w * BRAND_BF.cx, y: mark.y + mark.h * BRAND_BF.cy, w: mark.w * BRAND_BF.w, rot: BRAND_BF.rot });

/** 蝶此刻占的矩形（含一圈柔光）：用作「尾流」的障碍物. */
export const bfBox = (p: BfPose, k = 1.15): Rect => { const s = p.w * k; return { x: p.x - s / 2, y: p.y - s / 2, w: s, h: s }; };

/* ───────────── 尾流：应用侧元素等标题 / 蝶飞过再浮现 ───────────── */

/** 一个矩形是否与障碍物相交（障碍物外扩 pad）. */
export const rectHit = (a: Rect, b: Rect, pad = 0) => a.x < b.x + b.w + pad && a.x + a.w > b.x - pad && a.y < b.y + b.h + pad && a.y + a.h > b.y - pad;

export const WAKE_STEP = 0.005;
export const WAKE_DELAY = 0.04;       // 标题 / 蝶飞过之后再等这么久才开始浮现
export const WAKE_PAD = 6;
/** 逐 WAKE_STEP 采样障碍物（一次算好，所有目标共用）. */
export function sampleObstacles(fn: (tr: number) => Rect[], dur: number, step = WAKE_STEP): Rect[][] {
  const n = Math.ceil(dur / step - 1e-9) + 1;
  return Array.from({ length: n }, (_, i) => fn(Math.min(dur, i * step)));
}
/** 目标 rectAt(tr)（可随时间平移）与障碍物相交的**最后**一个时刻 + delay；从不相交 → 0（不必等）. */
export function wakeTime(rectAt: (tr: number) => Rect, samples: Rect[][], dur: number, o: { step?: number; pad?: number; delay?: number } = {}): number {
  const step = o.step ?? WAKE_STEP;
  const pad = o.pad ?? WAKE_PAD;
  const delay = o.delay ?? WAKE_DELAY;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].length) continue;
    const r = rectAt(Math.min(dur, i * step));
    if (samples[i].some((b) => rectHit(r, b, pad))) last = i;
  }
  return last < 0 ? 0 : Math.min(dur, last * step + delay);
}

/** 左栏条目（行）：最早浮现的时刻 ROW_BASE（此前面板是空的），自下而上轻扫 ROW_SWEEP，每行浮现 ROW_DUR.
    夜里面板是从屏外推进来的：推入期间面板里的内容一律不透明度为 0（不然底部的几行会骑着面板、被屏幕左缘切着进来），推到位之后才自下而上浮现——
    那时 base 取面板几乎到位（离到位只差 ROW_CLIP_PX 像素）的时刻（rowBaseTime）。
    快速版（R5）：每行不再按 7/12 缩到 150 ms（steep 的 ease-out 之下有效淡入只剩约 80 ms，整列约 130 ms 全部「啪」地出现），而是 ROW_DUR_FAST = 0.24 s、较缓的 ROW_EASE，
    轻扫 0.05 s；整列在 0.7 s 内完成. */
export const ROW_BASE = 0.3;
export const ROW_SWEEP = 0.1;
export const ROW_DUR = 0.26;
export const ROW_DUR_FAST = 0.24;
export const ROW_SWEEP_FAST = 0.05;
export const ROW_EASE = 'cubic-bezier(0.3, 0.1, 0.3, 1)';

export const NAV_ROWS = [
  '.side-nav__cta', '.queue-nav-wrap', '.side-nav__scroll .side-nav__list > li', '.side-nav__desk .side-nav__grp', '.side-nav__proj-list > li', '.side-nav__empty',
  '.side-nav__hr', '.side-nav__pinned .side-nav__list > li', '.side-nav__sea', '.quota-bar', '.side-nav__voice-row', '.side-nav__gear-wrap', '.side-nav__tools',
] as const;
/** 一行的浮现区间：自下而上的底线（base，绝对秒；缺省 ROW_BASE 按比例缩）与「标题 / 蝶飞过」的 wake 取晚者；盖在上面的「窗」（昼，收窗中的立绘）让开之后（coverWake）再依自下而上的次序错开——窗的竖直边缘不会切着一行字. */
export function rowSpan(kind: TransitionKind, yc: number, H: number, wake: number, coverWake = 0, base?: number): Span {
  const k = trDuration(kind) / TR_FULL;
  const fast = kind === 'fast';
  const sweep = fast ? ROW_SWEEP_FAST : ROW_SWEEP * k;
  const up = 1 - clamp(yc / Math.max(1, H));
  const b = (base ?? ROW_BASE * k) + sweep * up;
  const dur = trDuration(kind);
  const a = Math.min(Math.max(b, wake, coverWake > 0 ? coverWake + sweep * up : 0), dur - 0.05 * k);
  return [a, Math.min(dur, a + (fast ? ROW_DUR_FAST : ROW_DUR * k))];
}

/** 主栏内容块的浮现区间：计划的 blockSpan（按档，每档错开 40 ms）与各自的 wake（标题 / 蝶飞过、纸面前缘越过、盖在上面的窗让开）取晚者。
    被 wake 推迟的块仍按档错开（档与档之间 ≥ 一档的间隔，同一档的块同时浮现）、并把结尾收在总长之内（最后一块至少留 BLOCK_MIN_DUR）。 */
export const BLOCK_MIN_DUR = 0.22;
export function blockSpans(kind: TransitionKind, wakes: number[], tiers: number[] = wakes.map((_, i) => Math.max(0, i - 1)), start = BLOCK_START, firstDur = BLOCK_DUR): Span[] {
  const k = trDuration(kind) / TR_FULL;
  const dur = trDuration(kind);
  const step = BLOCK_STEP * k;
  const latest = dur - BLOCK_MIN_DUR * k;
  const order = wakes.map((_, i) => i).sort((a, b) => (tiers[a] - tiers[b]) || (a - b));
  const out: Span[] = new Array(wakes.length);
  let prev = -1;
  let prevTier = -1;
  let pushed = false;                                                   // 前面已有块被推迟：后面的块也依次错开（不然它们会挤在同一刻）
  for (const i of order) {
    const plan = blockSpan(kind, tiers[i], start, firstDur);
    const lb = Math.min(Math.max(plan[0], wakes[i]), dur - 0.05 * k);   // 绝不早于 wake（标题 / 蝶 / 窗没让开之前一个像素都不浮现）
    let a = lb;
    if (pushed && prev >= 0) a = Math.max(a, prev + (Math.min(tiers[i], BLOCK_CAP) > Math.min(prevTier, BLOCK_CAP) ? step : 0));
    a = Math.min(a, Math.max(latest, lb));                              // 能收进总长就收进去（最后一块至少留 BLOCK_MIN_DUR）
    if (a < prev) a = prev;
    if (a > plan[0] + 1e-9) pushed = true;
    prev = a;
    prevTier = tiers[i];
    out[i] = [a, Math.min(dur, a + (tiers[i] <= 0 ? firstDur : BLOCK_DUR) * k)];
  }
  return out;
}

/* ───────────── 量应用里的目标位置（DOM） ───────────── */

const rectOf = (e: Element | null | undefined): Rect | undefined => {
  if (!e) return undefined;
  const b = e.getBoundingClientRect();
  return b.width >= 1 && b.height >= 1 ? { x: b.left, y: b.top, w: b.width, h: b.height } : undefined;
};
/** 一个元素里文字的紧矩形（行内盒，不含行距）；没有文字时退回元素方框. */
export function textRect(e: Element | null | undefined): Rect | undefined {
  if (!e) return undefined;
  const r = document.createRange();
  r.selectNodeContents(e);
  const b = r.getBoundingClientRect();
  return b.width >= 1 && b.height >= 1 ? { x: b.left, y: b.top, w: b.width, h: b.height } : rectOf(e);
}
const byTarget = (name: string) => document.querySelector<HTMLElement>(`[data-boot-target="${name}"]`);
const px = (v: string) => parseFloat(v) || 0;

export function measureAnchors(): TrAnchors {
  const cs = getComputedStyle(document.documentElement);
  const nameEl = byTarget('brand-name');
  const subEl = byTarget('brand-sub');
  const font = (e: HTMLElement | null) => (e ? px(getComputedStyle(e).fontSize) : 0);
  const ls = (e: HTMLElement | null) => { if (!e) return 0; const c = getComputedStyle(e); const f = px(c.fontSize) || 1; return c.letterSpacing === 'normal' ? 0 : px(c.letterSpacing) / f; };
  return {
    mark: rectOf(byTarget('brand-mark')),
    name: textRect(nameEl),
    sub: textRect(subEl),
    nameFont: font(nameEl),
    subFont: font(subEl),
    nameLS: ls(nameEl),
    subLS: ls(subEl),
    nameColor: nameEl ? getComputedStyle(nameEl).color : undefined,
    subColor: subEl ? getComputedStyle(subEl).color : undefined,
    credit: rectOf(byTarget('credit')),
    arch: rectOf(byTarget('arch')),
    fig: rectOf(byTarget('fig')),
    wpFx: parseFloat(cs.getPropertyValue('--wp-fx')) || 0.65,
    wpFace: parseFloat(cs.getPropertyValue('--wp-face')) || 0.57,
    wallpaper: document.documentElement.dataset.wallpaper === 'on',
    nav: rectOf(document.querySelector('[data-boot-in="nav"]')),
    main: rectOf(document.querySelector('.app__main')),
    vw: window.innerWidth,
    vh: window.innerHeight,
  };
}

/* ───────────── 应用侧入场（WAAPI） ─────────────
   左栏面板、主栏的玻璃 / 纸面、内容块、左栏条目、底部控制台条浮现（位移 ≤ 12 px；玻璃只做自身的 opacity / transform 淡入，模糊半径保持终态）。
   每个动画都在元素自己身上，创建时暂停在 0；结束 cancel()：不留 fill、不留内联样式。
   · 导出模式（__boot.seek）：seek(tr) 把所有动画的 currentTime 逐帧设一遍——结果是 tr 的纯函数.
   · 实时播放：play(t0) 把「合成器能画」的动画（opacity / transform / filter）一次性对齐到同一个起点（startTime = t0）然后放手，它们自己跑，
     不再每个 rAF 由 JS 去 seek（暂停的动画被 JS 每帧 seek，合成器帮不上忙）；合成器画不了的（mask-position、background-color，标为 stepped）
     仍由 step(tr) 按节拍推进——它们要和场景的底板遮罩（同样按节拍写）同步，否则「底板撤掉多少、纸面露出多少」会差一步. */

export interface Entrance {
  /** 设到转场第 tr 秒（导出模式：所有动画）. */
  seek(tr: number): void;
  /** 实时：让能自己跑的动画从时间轴时刻 t0（毫秒，document.timeline.currentTime 的口径）起开跑. 返回 false = 这个环境不行，step 会照旧设全部. */
  play(t0: number): boolean;
  /** 实时：节拍帧——只设 stepped 的那几个（play 失败时设全部）. */
  step(tr: number): void;
  /** 撤掉所有动画（元素回到它自己的样式）. */
  end(): void;
}

export type Props = Record<string, string>;

/** comp：品牌标「亮一次」的光晕克隆的峰值不透明度（见 createAppEntrance 里的说明）. */
export const HALO_PEAK = 0.55;

function track(from: Props, to: Props, span: Span, dur: number, easing = CSS_EASE): Keyframe[] {
  const a = clamp(span[0] / dur);
  const b = clamp(span[1] / dur);
  const f: Keyframe[] = [];
  if (a > 0) f.push({ offset: 0, ...from, easing: 'linear' });
  f.push({ offset: a, ...from, easing });
  f.push({ offset: Math.max(a, b), ...to, easing: 'linear' });
  if (b < 1) f.push({ offset: 1, ...to });
  return f;
}

export interface EntranceOptions {
  theme: BootTheme;
  kind: TransitionKind;
  shared: TrShared;
  /** 开屏里「在界面上方飞」的东西此刻占的矩形（SceneTransition.obstacles）. */
  obstacles: (tr: number) => Rect[];
  /** 昼：此刻盖在界面上方的「窗」（收窗中的立绘）占的矩形（SceneTransition.cover）：文字等窗的边缘越过它再浮现，不被一条竖直的边切掉一半. */
  cover?: (tr: number) => Rect[];
  /** 实时播放（夜）：动画按 deadline 排队创建（见 sampler.ts 的 Stager）；缺省 = 立刻全建. */
  stager?: Stager;
}

/** 夜 / 昼各自的专属部分（transitionNight.ts 的 nightEntrance、transitionDay.ts 的 dayEntrance）拿到的上下文——
    它们只靠这里给的东西干活，不 import 本文件的值（避免成环）. */
export interface EntranceCtx {
  o: EntranceOptions;
  /** comp（合成器优先）实现：true 时走新做法（nav::after 的光晕、visibility 改翻转……）；false = legacy 原样. */
  comp: boolean;
  dur: number;
  kk: number;
  S: NightSegs | DaySegs;
  nav: HTMLElement | null;
  col: HTMLElement | null;
  main: HTMLElement | null;
  navRect: Rect | undefined;
  mainRect: Rect | undefined;
  /** 夜：左栏是竖栏、壁纸开着，面板随取景平移从屏外推入. */
  pushed: boolean;
  /** 逐 wakeStep 秒采样的障碍物（标题 / 蝶）. */
  samples: Rect[][];
  wakeStep: number;
  /** tr 的纯状态函数. */
  state: (tr: number) => TrState;
  /** 建一个应用侧动画（创建时暂停在 0）；stepped = 合成器画不了、实时由节拍推进. */
  add: (el: Element | null | undefined, frames: Keyframe[], pseudo?: string, stepped?: boolean, notBefore?: number) => void;
  /** 先隐藏、span 里线性淡入的「真身」. */
  /** late：在 span 起点之后一小会儿才建（目标此刻还在被藏起来的祖先里时，Chromium 会把创建时「看不见」的动画判成合成器画不了——署名在藏起来的真拱窗里）. */
  hold: (el: HTMLElement | null, span: Span, late?: boolean) => void;
  /** 在 at 秒之前不可见（visibility:hidden）：legacy 是 visibility 的 WAAPI（合成器画不了），comp 是按 tr 翻转内联 visibility. */
  flip: (el: Element | null, at: number) => void;
  track: (from: Props, to: Props, span: Span, dur: number, easing?: string) => Keyframe[];
  q1: (sel: string) => HTMLElement | null;
}

/** 主题专属部分返回的钩子. */
export interface ThemeEntrance {
  /** 夜：左栏推入到「条目几乎到位」的时刻（条目等它再浮现）. */
  rowBase?: number;
  /** 内容块的额外 wake（昼：纸面前缘越过它的右缘才浮现）. */
  extraWake?: (r: Rect | undefined) => number;
  /** 面板（夜：左栏推入与空面板的光）——在条目之前建. */
  panel?: () => void;
  /** 主栏（昼：纸面展卷）——在内容块之后建. */
  main?: () => void;
  /** 共享元素真身的交接（昼：署名淡入、立绘 / 光环的先隐藏后现身）——在公共的 hold 之后建. */
  holds?: () => void;
}

export function createAppEntrance(o: EntranceOptions): Entrance {
  const comp = bootImpl() === 'comp';
  const dur = trDuration(o.kind);
  const kk = dur / TR_FULL;
  const ms = dur * 1000;
  const night = o.theme === 'night';
  const S = night ? nightSegs(o.kind) : daySegs(o.kind);
  const anims: Array<{ a: Animation; stepped: boolean }> = [];
  const flips: Array<{ el: HTMLElement; at: number; hidden: boolean }> = [];
  const extras: HTMLElement[] = [];                 // 挂在覆盖层里的临时元素（品牌标的光晕）
  const q1 = (s: string) => document.querySelector<HTMLElement>(s);
  const visible = (e: HTMLElement | null) => !!e && getComputedStyle(e).visibility !== 'hidden' && e.getBoundingClientRect().width > 0;

  /* 入场分三段做（实时播放时由 Stager 在起步后的节拍帧里一段一段跑，起步的同步段一点都不占；导出 / 昼就地连着做）：
     ① 障碍物采样（标题 / 蝶 / 窗的纯函数，约 240 个时刻）；② 量应用里的目标位置、算每个条目 / 内容块浮现的时刻（此时所有元素都还在它们的终态位置）；③ 建动画. */
  let nav: HTMLElement | null = null;
  let col: HTMLElement | null = null;
  let main: HTMLElement | null = null;
  let navRect: Rect | undefined;
  let mainRect: Rect | undefined;
  let markRect: Rect | undefined;
  let pushed = false;
  let samples: Rect[][] = [];
  let coverSamples: Rect[][] | null = null;
  let themed: ThemeEntrance = {};
  let ctx!: EntranceCtx;
  const VH = window.innerHeight;
  const navDx = (tr: number) => (pushed && navRect ? navPushX(navRect.w, PAN_E(win(tr, S.nav[0], S.nav[1]))) : 0);
  const wakeOf = (r: Rect | undefined, dx?: (tr: number) => number) => (r ? wakeTime((tr) => (dx ? { ...r, x: r.x + dx(tr) } : r), samples, dur, { delay: WAKE_DELAY * kk }) : 0);
  // 窗（昼）：目标与窗相交的最后一个时刻 + 40 ms；终态里仍压在窗下面的（拱窗自己的内容、贴底的条）不等它——窗的终态就是拱窗本身
  const coverWake = (r: Rect | undefined) => {
    if (!r || !coverSamples) return 0;
    const end = coverSamples[coverSamples.length - 1];
    return !end.some((b) => rectHit(r, b, WAKE_PAD)) ? wakeTime(() => r, coverSamples, dur, { delay: WAKE_DELAY * kk }) : 0;
  };

  let live = false;       // play() 成功：非 stepped 的动画已经自己在跑
  let playT0 = 0;
  let ended = false;
  /** 这批动画要在转场第几秒之前存在：左栏（夜：随取景平移推入；昼：窗收过来）露出来之前，里面的条目 / 真身必须已经是隐藏的初始状态. */
  const by = Math.max(0, (S.nav[0] as number));
  /** 动画的第一次变化发生在第几秒（关键帧里第一对不同的相邻帧）. */
  const startOf = (frames: Keyframe[]): number => {
    const sig = (f: Keyframe) => JSON.stringify(Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'offset' && k !== 'easing')));
    for (let i = 0; i + 1 < frames.length; i++) if (sig(frames[i]) !== sig(frames[i + 1])) return Number(frames[i].offset ?? 0) * dur;
    return 0;
  };
  /** stepped = 合成器画不了的属性（mask-position、background-color）：实时播放时由节拍推进，不放手让它自己跑. */
  const add: EntranceCtx['add'] = (el, frames, pseudo, stepped = false, notBefore) => {
    if (!el) return;
    const make = () => {
      if (ended) return;
      try {
        const a = el.animate(frames, { duration: ms, fill: 'both', easing: 'linear', ...(pseudo ? { pseudoElement: pseudo } : {}) });
        a.id = TR_ANIM_ID;        // 测试与调试用：document.getAnimations().filter((a) => a.id === 'boot-tr') 就是转场里的全部动画
        a.pause();
        a.currentTime = 0;
        anims.push({ a, stepped });
        if (live && !stepped) a.startTime = playT0;       // 起步之后才建的：对齐到同一个起点，从「此刻应有的进度」跑
      } catch { /* 这个元素 / 这个浏览器不支持：它就直接是终态，不影响其余 */ }
    };
    if (o.stager) o.stager.add(Math.min(startOf(frames), by) - Stager.LEAD, make, notBefore ?? -Infinity, `app:${pseudo ?? ''}`); else make();
  };
  // 共享元素的真身：先隐藏，等场景那边的「分身」到位再淡入（蝶身 / 标题 / 署名 / 立绘撤下之前它必须已经是不透明的，否则交叉淡化会在中途变淡一下）
  const hold: EntranceCtx['hold'] = (el, span, late = false) => add(el, track({ opacity: '0' }, { opacity: '1' }, span, dur, 'linear'), undefined, false, late ? span[0] + 0.02 : undefined);
  const flip: EntranceCtx['flip'] = (el, at) => {
    if (!el) return;
    if (comp) { flips.push({ el: el as HTMLElement, at, hidden: false }); return; }
    add(el, [{ offset: 0, visibility: 'hidden' }, { offset: clamp(at / dur), visibility: 'hidden' }, { offset: clamp(at / dur), visibility: 'visible' }, { offset: 1, visibility: 'visible' }]);
  };
  const applyFlips = (tr: number) => {
    for (const f of flips) {
      const hide = tr < f.at;
      if (hide !== f.hidden) { f.hidden = hide; f.el.style.visibility = hide ? 'hidden' : ''; }
    }
  };

  // ── ① 障碍物采样 ──
  const stage1 = () => {
    if (ended) return;
    samples = sampleObstacles(o.obstacles, dur);
    coverSamples = o.cover ? sampleObstacles(o.cover, dur) : null;
    tp('ent:sampled');
  };

  // ── ② 量 ──
  let rows: Array<{ el: HTMLElement; rect: Rect }> = [];
  let rowSpans: Span[] = [];
  let blocks: Array<{ el: HTMLElement; span: Span; first: boolean }> = [];
  let view: HTMLElement | null = null;
  let consoleBar: HTMLElement | null = null;
  let status: HTMLElement | null = null;
  const stage2 = () => {
    if (ended) return;
    nav = q1('[data-boot-in="nav"]');
    col = q1('[data-boot-in="col"]');
    main = q1('.app__main');
    view = q1('.app__view');
    consoleBar = q1('.app > .console');
    status = q1('.app > .status-panel');
    navRect = rectOf(nav);
    mainRect = rectOf(main);
    markRect = rectOf(byTarget('brand-mark'));       // 品牌标的位置要在这里量（元素还在终态位置）：stage3 里左栏的推入动画已经建好（夜：translateX(−面板宽)），那时量到的是推出屏外的位置（光晕克隆会落在 x = −200 处，亮一次整个看不见）
    pushed = o.shared.push && !!navRect;
    ctx = { o, comp, dur, kk, S, nav, col, main, navRect, mainRect, pushed, samples, wakeStep: WAKE_STEP, state: (tr) => trState(o.theme, o.kind, tr), add, hold, flip, track, q1 };
    themed = night ? nightEntrance(ctx) : dayEntrance(ctx);
    tp('ent:measured');
    // 左栏条目：最外层的行（嵌套的只取外层）。夜里面板是从屏外推进来的：条目要等面板到位（推入的最后 0.04 s 之前）才开始自下而上浮现——
    // 推入期间面板里什么内容都没有，底部的几行不会骑着面板、被屏幕左缘切着进来
    const rowEls = new Set<HTMLElement>();
    if (nav) for (const sel of NAV_ROWS) nav.querySelectorAll<HTMLElement>(sel).forEach((e) => rowEls.add(e));
    rows = [...rowEls].filter((e) => ![...rowEls].some((p) => p !== e && p.contains(e))).map((el) => ({ el, rect: rectOf(el) })).filter((r): r is { el: HTMLElement; rect: Rect } => !!r.rect);
    rowSpans = rows.map((r) => rowSpan(o.kind, r.rect.y + r.rect.h / 2, VH, wakeOf(r.rect, navDx), coverWake(r.rect), themed.rowBase));
    // 主栏的内容块：计划的时刻（blockSpan，输入框第一档）与「标题 / 蝶飞过」「纸面前缘越过」「窗让开」取晚者
    const blockEls = col ? Array.from(col.children) as HTMLElement[] : [];
    const inputIdx = blockEls.findIndex((e) => e.matches('.return-bottom') || !!e.querySelector('.pbox__input'));
    const tiers = blockTiers(blockEls.length, inputIdx);
    const blockSp = blockSpans(o.kind, blockEls.map((c) => { const r = rectOf(c); return Math.max(wakeOf(r), themed.extraWake?.(r) ?? 0, coverWake(r)); }), tiers, night ? BLOCK_START : BLOCK_START_DAY, night ? BLOCK_DUR : BLOCK_DUR_FIRST_DAY);
    blocks = blockEls.map((el, i) => ({ el, span: blockSp[i], first: !night && tiers[i] <= 0 }));
    tp('ent:blocks');
  };

  // ── ③ 建动画 ──
  const stage3 = () => {
    if (ended) return;
    // ── 左栏面板（只是玻璃底，不含条目）──
    themed.panel?.();
    // 左栏条目：在标题 / 蝶的尾流里浮现
    rows.forEach((r, i) => add(r.el, track({ opacity: '0', transform: 'translateY(6px)' }, { opacity: '1', transform: 'none' }, rowSpans[i], dur, o.kind === 'fast' ? ROW_EASE : CSS_EASE)));

    if (col) {
      // 首页：主栏的玻璃是 .return-col::before（夜与昼都是）——动画放在伪元素自己身上，不动它的祖先；backdrop-filter 保持终态（只淡入 opacity / transform）
      add(col, track({ opacity: '0', transform: 'translateY(12px)' }, { opacity: '1', transform: 'none' }, S.glass, dur), '::before');
      // 内容块依次浮现（输入框在最后）
      blocks.forEach((b) => add(b.el, track({ opacity: '0', transform: 'translateY(10px)' }, { opacity: '1', transform: 'none' }, b.span, dur, b.first ? BLOCK_EASE_FIRST : CSS_EASE)));
      themed.main?.();
    } else if (view) {
      // 其它页面（预览重播时在设置页等）：整页浮起；面板自带的玻璃在这 0.4 s 里不模糊，结束后恢复
      add(view, track({ opacity: '0', transform: 'translateY(10px)' }, { opacity: '1', transform: 'none' }, S.glass, dur));
      if (visible(status)) add(status, track({ opacity: '0', transform: 'translateX(12px)' }, { opacity: '1', transform: 'none' }, S.glass, dur));
    }

    if (consoleBar) add(consoleBar, track({ opacity: '0', transform: 'translateY(8px)' }, { opacity: '1', transform: 'none' }, S.console, dur));

    // 共享元素的真身：先隐藏，等场景那边的「分身」到位再淡入。
    // 没被场景接管的（被打断时蝶还没出生、标题还没浮现）也不能让它骑着左栏面板进来：在面板到位后（titleSwap，≤ 0.1 s）原地淡入
    const mark = byTarget('brand-mark');
    hold(mark, o.shared.mark ? S.swap : S.titleSwap);
    hold(byTarget('brand-name'), S.titleSwap);
    hold(byTarget('brand-sub'), S.titleSwap);
    if (o.shared.credit) hold(byTarget('credit'), S.creditSwap);
    themed.holds?.();
    // 标亮一次：品牌标自己的光晕（.brand-mark--glow 的 drop-shadow）鼓一下再回落
    if (mark) {
      const base = getComputedStyle(mark).filter;
      if (base && base !== 'none') {
        const g0 = S.glow[0] / dur;
        const g1 = S.glow[1] / dur;
        const gm = lerp(g0, g1, 0.35);
        const boot = comp ? document.querySelector<HTMLElement>('.boot') : null;
        const mr = markRect;
        if (boot && mr) {
          // comp：filter 的 drop-shadow 动画合成器画不了（compositeFailed）。改成：品牌标的一份克隆叠在原处，带一个静态的、更大的光晕（8 px / 18 px 两层、α .95 / .7），只动它的 opacity（0 → 峰值 → 0，同一条时间表与缓动）。
          // 峰值 HALO_PEAK：克隆的光晕盘比 legacy（6 px 的基础光晕 + 偏右 12 px 的一层）大，满不透明时品牌标框内的亮度约为 legacy 的 2 倍（评审实测 tr 0.92–1.00 相对终态的平均偏差 4.9–5.4 对 2.6–2.8；夜快速版 0.537–0.583 为 6.0–6.4 级），按 0.55 压回去
          const halo = mark.cloneNode(true) as SVGElement;
          halo.removeAttribute('data-boot-target');
          halo.setAttribute('class', 'brand-mark boot__halo');
          halo.style.cssText = `left:${mr.x}px;top:${mr.y}px;width:${mr.w}px;height:${mr.h}px;opacity:0;filter:drop-shadow(0 0 8px rgb(124 200 247 / 0.95)) drop-shadow(0 0 18px rgb(124 200 247 / 0.7))`;
          boot.appendChild(halo);
          extras.push(halo as unknown as HTMLElement);
          add(halo, [
            { offset: 0, opacity: '0', easing: 'linear' }, { offset: g0, opacity: '0', easing: CSS_EASE },
            { offset: gm, opacity: String(HALO_PEAK), easing: 'cubic-bezier(0.4, 0, 0.6, 1)' }, { offset: g1, opacity: '0' }, { offset: 1, opacity: '0' },
          ]);
        } else {
          const peak = base.replace(/rgba?\([^)]*\)/, 'rgb(124 200 247 / 0.95)').replace(/(\d+(\.\d+)?)px/, '12px');
          add(mark, [
            { offset: 0, filter: base }, { offset: g0, filter: base, easing: CSS_EASE },
            { offset: gm, filter: peak, easing: 'cubic-bezier(0.4, 0, 0.6, 1)' }, { offset: g1, filter: base }, { offset: 1, filter: base },
          ]);
        }
      }
    }
    tp('ent:built');
    applyFlips(0);
  };

  if (o.stager) {
    // 连着三段在同一个 deadline 上入队（先进先出）：每段单独占一个节拍帧的预算，不会挤在一起
    o.stager.add(0.05, stage1, -Infinity, 'ent1-sample');
    o.stager.add(0.05, stage2, -Infinity, 'ent2-measure');
    o.stager.add(0.05, stage3, -Infinity, 'ent3-build');
  } else { stage1(); stage2(); stage3(); }

  return {
    seek(tr: number) {
      const t = clamp(tr, 0, dur) * 1000;
      for (const { a } of anims) a.currentTime = t;
      applyFlips(tr);
    },
    play(t0: number) {
      try {
        playT0 = t0;
        for (const x of anims) if (!x.stepped) x.a.startTime = t0;      // 对齐起点：此刻 currentTime = 时间轴时刻 − t0 ≈ 0，之后合成器自己推进
        live = true;
      } catch {
        live = false;                                                   // 极少见：回到逐帧 seek（慢一点，但结果一样）
        for (const x of anims) { try { x.a.pause(); } catch { /* 已经没了 */ } }
      }
      return live;
    },
    step(tr: number) {
      const t = clamp(tr, 0, dur) * 1000;
      for (const x of anims) if (x.stepped || !live) x.a.currentTime = t;
      applyFlips(tr);
    },
    end() {
      ended = true;
      for (const { a } of anims) { try { a.cancel(); } catch { /* 已经没了 */ } }
      anims.length = 0;
      for (const f of flips) f.el.style.removeProperty('visibility');
      flips.length = 0;
      for (const x of extras) x.remove();
      extras.length = 0;
    },
  };
}

/* ───────────── 转场时钟 ───────────── */

export interface ClockOptions {
  /** 第一个 rAF 回调时调用一次，t0 = 转场的起点（document.timeline.currentTime 的口径，毫秒）：让应用侧能自己跑的 WAAPI 动画对齐到同一个起点开跑. */
  onStart?: (t0: number) => void;
  /** 主题：只有接入了合成器路径的主题（夜）才用调速器，其余保持旧的 60 fps 匀速封顶. 不给 = 按 comp 实现. */
  theme?: string;
  /** 调速器升档时调（新档位）：转场把合成器上的动画重建成阶梯（慢机器的退路）. */
  onTier?: (divisor: number, refreshMs: number) => void;
  /** 节拍器（缺省新建一个）：frame 只在到点的 rAF 回调里调。comp = 调速器模式（默认每个 rAF 都调，慢机器升到每 2 / 4 个 rAF）；legacy = 240 Hz 屏上每 4 帧一次（60 fps，间隔恒定）. */
  pacer?: Pacer;
}

/** 按墙钟推进转场：先同步调一次 frame(0)（第一个绘制帧就是起点的样子）；之后每个 rAF 回调里，到节拍才调 frame(tr)，到点再调 frame(dur) 然后 done()。返回取消函数。
    起点 t0 取第一个 rAF 回调时的时间轴时刻（与 WAAPI 的 startTime 同一个口径），tr = (rAF 时间戳 − t0) / 1000. */
export function runClock(dur: number, frame: (tr: number) => void, done: () => void, opts: ClockOptions = {}): () => void {
  const governed = opts.theme ? governedForTransition(opts.theme) : bootImpl() === 'comp';
  const pacer = opts.pacer ?? (governed ? new Pacer({ governor: bootGovernor, onTier: (d) => opts.onTier?.(d, bootGovernor.refreshMs ?? 1000 / 60) }) : new Pacer());
  let raf = 0;
  let dead = false;
  let t0 = -1;
  const tick = (now: number) => {
    raf = 0;
    if (dead) return;
    let draw = false;
    if (t0 < 0) {
      const ct = typeof document !== 'undefined' ? document.timeline.currentTime : null;
      t0 = typeof ct === 'number' ? ct : now;
      pacer.observe(now);
      pacer.mark(now);                      // 第 0 帧已经画过了，这一回调不用再画
      opts.onStart?.(t0);
    } else draw = pacer.due(now);
    const tr = (now - t0) / 1000;
    if (tr >= dur) { dead = true; frame(dur); done(); return; }
    if (draw) { const c0 = performance.now(); frame(Math.max(0, tr)); pacer.cost(performance.now() - c0); }
    raf = requestAnimationFrame(tick);
  };
  frame(0);
  raf = requestAnimationFrame(tick);
  return () => { dead = true; if (raf) cancelAnimationFrame(raf); };
}

/* ───────────── 一次转场的完整运行 ───────────── */

export interface TransitionRun {
  readonly dur: number;
  readonly kind: TransitionKind;
  /** 设到转场第 tr 秒（场景与应用侧入场一起，应用侧的全部动画都设）——导出模式用，结果是 tr 的纯函数. */
  seek(tr: number): void;
  /** 实时：让应用侧能自己跑的 WAAPI 动画从时间轴时刻 t0 起开跑（runClock 的 onStart）. */
  play(t0: number): void;
  /** 实时：节拍帧——场景（画布 / 样式）与应用侧 stepped 的动画设到 tr；能自己跑的 WAAPI 动画不碰. */
  step(tr: number): void;
  /** 此刻开屏里在界面上方飞的东西占的矩形（测试用）. */
  obstacles(tr: number): Rect[];
  /** 昼：此刻盖在界面上方的窗（收窗中的立绘）占的矩形（测试用）. */
  cover(tr: number): Rect[];
  /** 撤掉应用侧的所有动画（不碰场景：覆盖层随后整个卸载）. */
  end(): void;
  /** 连场景一起复原到离开时的那一帧（导出模式往回 seek 时用）. */
  restore(): void;
  /** 慢机器的退路：调速器升到 divisor 档，把合成器上的动画重建成阶梯（台阶 = divisor × 刷新间隔）. */
  retier(divisor: number, refreshMs: number): void;
}

/** 开屏的底图里，枯枝上画中原有的那只紫蝶被抹掉了（落点是新蝶的）；首页壁纸里它还在。
    转场期间壁纸层里盖一小块「抹掉之后」的补丁（Wallpaper.tsx，在玻璃下面：跟着模糊、跟着染色），结束后慢慢淡去——它从来不会在玻璃还没进来的时候冒出来. */
function setBootPatch(on: boolean) {
  const d = document.documentElement.dataset;
  if (on) d.bootPatch = 'on'; else delete d.bootPatch;
}

export interface BeginOptions {
  /** 实时播放（BootSplash）：夜的动画分档创建（起步的同步段只建马上要动的，其余按 deadline 在节拍帧里建）. 导出 / 测试不给 = 全部立刻建. */
  live?: boolean;
}

/** 量目标位置 → 场景准备转场 → 建应用侧入场。场景此后停在 from 那一帧，由 seek(tr) 驱动。 */
export function beginTransition(scene: BootScene, kind: TransitionKind, from: number, opts: BeginOptions = {}): TransitionRun {
  tp('begin:start');
  bootGovernor.carryOver();     // 开屏与转场的负载不同：转场的档位重新量（开屏里已经升到几档的，转场从一半起步；独显的保护档不受影响）
  const stager = opts.live && bootImpl() === 'comp' ? new Stager() : undefined;
  const anchors = measureAnchors();
  tp('begin:measured');
  const sceneTr = scene.prepareTransition({ kind, from, anchors, stager });
  tp('begin:scene');
  setBootPatch(scene.theme === 'night');
  // 应用侧入场：实时播放时它的量取与建立（约 10 ms + 几十个动画）由 Stager 挪到起步之后的节拍帧里（createAppEntrance 自己分三段排队），这里只是建个壳
  const entrance: Entrance = createAppEntrance({ theme: scene.theme, kind, shared: sceneTr.shared, obstacles: sceneTr.obstacles, cover: sceneTr.cover, stager });
  tp('begin:entrance');
  // 分档创建不能只指望 rAF：页面的 rAF 稀（机器卡、窗口刚露出来）时，入场的元素会在底板「洞」打开前还停在终态。起步后再用几个很短的宏任务（每个只占一个节拍帧的预算）先把头几段建了，rAF 的节拍帧接着建
  let kicks = 0;
  let kickTimer = 0;
  let playedAt = -1;
  const curTr = () => (playedAt >= 0 ? Math.max(0, ((document.timeline.currentTime as number | null) ?? playedAt) - playedAt) / 1000 : 0);
  const kick = () => {
    if (!stager || kicks++ >= 6) return;
    kickTimer = window.setTimeout(() => { kickTimer = 0; stager.pump(curTr(), 2.5); if (stager.pending) kick(); }, 2);
  };
  kick();
  // 夜：首页壁纸层（图框）与开屏位图一起收到位——溶解期间两层作为一个整体套同一个剩余变换（individual transform 属性：不碰它自己的 transform / transition）
  const wp = scene.theme === 'night' && sceneTr.backdrop ? document.querySelector<HTMLElement>('.wallpaper__layer--night .wallpaper__frame') : null;
  const backdrop = (tr: number) => {
    if (!wp) return;
    const b = sceneTr.backdrop?.(tr);
    if (!b) { clearBackdrop(); return; }
    wp.style.transformOrigin = '0 0';
    wp.style.translate = `${b.x.toFixed(2)}px ${b.y.toFixed(2)}px`;
    wp.style.scale = Math.abs(b.k - 1) < 1e-5 ? '' : b.k.toFixed(5);
  };
  const clearBackdrop = () => { if (!wp) return; wp.style.removeProperty('translate'); wp.style.removeProperty('scale'); wp.style.removeProperty('transform-origin'); };
  return {
    dur: trDuration(kind),
    kind,
    seek(tr) { stager?.flush(); sceneTr.render(tr); entrance.seek(tr); backdrop(tr); },
    play(t0) { playedAt = t0; sceneTr.play?.(t0); entrance.play(t0); },
    step(tr) {
      if (stager && tr > 0) stager.pump(tr, 2.5);
      if (sceneTr.step) sceneTr.step(tr); else sceneTr.render(tr);
      entrance.step(tr);
      backdrop(tr);
    },
    obstacles: (tr) => sceneTr.obstacles(tr),
    cover: (tr) => sceneTr.cover?.(tr) ?? [],
    end() { window.clearTimeout(kickTimer); stager?.clear(); sceneTr.end?.(); entrance.end(); clearBackdrop(); setBootPatch(false); },
    restore() { window.clearTimeout(kickTimer); stager?.clear(); entrance.end(); clearBackdrop(); setBootPatch(false); sceneTr.dispose(); },
    retier(divisor, refreshMs) { sceneTr.retier?.(divisor, refreshMs); },
  };
}
