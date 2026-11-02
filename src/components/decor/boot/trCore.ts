/* 转场的共享底座（纯函数、不碰 DOM）：时间表的公共部分、缓动曲线、颜色小工具。
   从 transition.ts 机械拆出（行为不变），好让夜（transitionNight.ts）与昼（transitionDay.ts）互不依赖地各自演进；
   transition.ts 把这三个文件都 re-export 出去，所以 check-boot 与场景里的 `import … from './transition'` 照旧。 */
import { cubic, lerp, win } from './bootMath';
import type { TransitionKind } from './bootTypes';

/* ───────────── 时间表（秒；完整版 1.2 s，快速版整体按比例缩） ───────────── */

export const TR_FULL = 1.2;
export const TR_FAST = 0.7;
/** 减少动态 / 被迫定格（超宽窗口、机器画不动）：只交叉淡化，≤ 200 ms. */
export const SOFT_MS = 180;
export const trDuration = (kind: TransitionKind) => (kind === 'full' ? TR_FULL : TR_FAST);

/** 一段时间 [起, 止]（秒）. */
export type Span = readonly [number, number];

export interface CommonSegs {
  /** 雪、轨迹光、「按任意键进入」、副标题、版本号：淡出. */
  ambient: Span;
  /** 蝶起飞 → 飞到品牌标（前 0.12 s 是「领拍」：只有蝶先抬起，镜头与立绘随后才动）. */
  fly: Span;
  /** 品牌标（真的）在蝶身下淡入；它不透明之后蝶身与枝的分身（画布 / SVG）才淡出——先后错开，交叉淡化的中途才不会变淡一下. */
  swap: Span;
  swapOut: Span;
  /** 品牌标「亮一次」. */
  glow: Span;
  /** 标题 FLIP 缩进左栏字标；字标（真的）淡入；开屏里的标题随后淡出. */
  title: Span;
  /** 飞行中的标题把渐变色标 / 外发光（昼：字色 / 阴影）一路插值到字标的样子：交叉淡化时分身与真身像素一致，不是「到位了才换一个」. */
  tint: Span;
  titleSwap: Span;
  titleOut: Span;
  /** 署名滑到去处（夜）；真署名淡入；开屏里的署名随后淡出. */
  credit: Span;
  creditSwap: Span;
  creditOut: Span;
  /** 左栏面板：夜 = 随取景平移从屏外推入；昼 = 没有面板（条目各自尾流浮现）. */
  nav: Span;
  /** 主栏玻璃（.return-col::before）与底部控制台条. */
  glass: Span;
  console: Span;
}

export const COMMON: CommonSegs = {
  ambient: [0.02, 0.32],
  fly: [0.0, 0.8],
  swap: [0.8, 0.88],
  swapOut: [0.88, 0.96],
  glow: [0.88, 1.2],
  title: [0.14, 0.8],
  tint: [0.3, 0.7],
  titleSwap: [0.7, 0.82],
  titleOut: [0.82, 0.92],
  credit: [0.24, 0.8],
  creditSwap: [0.72, 0.84],
  creditOut: [0.84, 0.94],
  nav: [0.1, 0.54],
  glass: [0.4, 0.82],
  console: [0.64, 1.0],
};

export function scaled<T extends object>(segs: T, k: number): T {
  const out: Record<string, Span> = {};
  const r = (x: number) => Math.round(x * 1e9) / 1e9;      // 0.7000000000000001 之类的浮点尾巴会让「总长处的进度」差一点点到不了 1
  for (const [name, s] of Object.entries(segs as Record<string, Span>)) out[name] = [r(s[0] * k), r(s[1] * k)];
  return out as unknown as T;
}

/* ───────────── 缓动 ───────────── */

/** 蝶的飞行：起得不急、匀匀地飞、收得很长（落到标上是减速入港）. */
export const FLY_E = cubic(0.45, 0, 0.25, 1);
/** 标题 / 署名缩进左栏（FLIP）：温柔的标准缓动，别一上来就冲到位. */
export const FLIP_E = cubic(0.4, 0, 0.2, 1);
/** 取景平移与左栏面板推入（同一条曲线、同一段时间，两边才咬得住）. */
export const PAN_E = cubic(0.33, 0.1, 0.2, 1);
export const PAN_CSS = 'cubic-bezier(0.33, 0.1, 0.2, 1)';
/** 立绘收窗：比第一版平——先静一拍、再滑进去、落得很轻；R5 把终点提前到 0.84 s、尾巴收短（(.5,0,.4,1) 的长尾巴让人物在窗、纸、内容块都停稳之后还单独滑了 0.3 s），
    峰值速度约是第一版的 0.86 倍（R4 的 (.5,0,.4,1) 是 0.77 倍；第一版 (0.35,0.1,0.15,1) 在 0.8 s 里走完，前 0.3 s 就冲完了 70%）. */
export const ART_E = cubic(0.45, 0, 0.35, 1);
/** 奶油纸面展开（前缘羽化，左→右；仅用于没有窗的退路——有窗时纸面的前缘就是窗的左缘）. */
export const PAPER_E = cubic(0.3, 0.1, 0.2, 1);
export const PAPER_CSS = 'cubic-bezier(0.3, 0.1, 0.2, 1)';
/** 昼 · 窗的左缘（与拱顶圆角）：比立绘的缩放 (ART_E) 急一些的 ease-out——0.10–0.58 s 走完，0.35 s 时已过 77%（主栏的块所在的位置），
    所以输入框、归来简在 0.40 s 就能落上纸面，不必等窗收到 0.9 s. */
export const WIN_E = cubic(0.3, 0, 0.3, 1);
export const CSS_EASE = 'cubic-bezier(0.22, 0.8, 0.24, 1)';

export const prog = (tr: number, s: Span) => win(tr, s[0], s[1]);

export type Pt = readonly [number, number];

/** 左栏推入到离到位还差这么多像素时，条目就可以开始浮现（左栏内边距 12 px，字与图标不会被屏幕左缘切到）. */
export const ROW_CLIP_PX = 9;

/** 飞行中的标题向字标的样子收敛：渐变色标 / 外发光（夜）、字色 / 阴影（昼）按 k（0 = 开屏的样子，1 = 字标）插值——
    到 0.70 s 交叉淡化时分身与真身像素一致，不是「到位了才换成另一个」. */
export type RGB = readonly [number, number, number];
export function parseRgb(css: string | undefined, fallback: RGB = [255, 255, 255]): RGB {
  const m = css ? /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(css) : null;
  return m ? [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3])] : fallback;
}
export const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
export const mixRgb = (a: RGB, b: RGB, k: number): string => `rgb(${[0, 1, 2].map((i) => Math.round(lerp(a[i], b[i], k))).join(' ')})`;
export const tintColor = (from: string, target: RGB, k: number) => mixRgb(hex(from), target, k);
