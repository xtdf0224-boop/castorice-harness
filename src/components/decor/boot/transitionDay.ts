/* 转场 · 昼「花海收进窗」专属的纯函数与应用侧入场：昼的时间表（窗的左缘 / 立绘 / 临时底 / 纸面）、窗的裁切框、立绘落位、人物分身、光环随动、纸面的羽化展开。
   从 transition.ts 机械拆出（行为不变）。 */
import { lerp, sstep, win } from './bootMath';
import type { Rect, TransitionKind } from './bootTypes';
import type { EntranceCtx, ThemeEntrance } from './transition';
import { COMMON, PAPER_CSS, PAPER_E, TR_FULL, scaled, trDuration, type CommonSegs, type Pt, type Span } from './trCore';

export interface DaySegs extends CommonSegs {
  /** 官方立绘：放大落到窗里的位置（缩放 / 平移走满整段，0.10–0.84 s；R5 起尾巴更短，与临时底的淡出 0.74–0.88 s 同时落定）. */
  art: Span;
  /** 开屏里的题辞、横幅、「按任意键进入」、提示：在纸面前缘到达 x = 200 之前淡完（它们若被奶油纸压着淡出，纸上的那半边会泛粉）. */
  textOut: Span;
  /** 窗里临时薰衣草底在右上 1/3 提前一步淡起：立绘放大时深色的巨瓣先挤进右上角，不能先暗后亮. */
  washTop: Span;
  /** 窗的裁切框：左缘（与拱顶圆角）有自己的进度，比立绘的缩放走得急——主栏在 ~0.45 s 前就已让开，内容块、输入框不必等到 0.9 s 才浮现；
      纸面（昼的主栏）的前缘与底板的撤离都跟着这条边走（全屏只有一条移动的竖边）. */
  win: Span;
  /** 立绘（人物）的分身：在原画上淡入——此后人物本体不再参与任何淡化，只随立绘一起走到窗里. */
  figOn: Span;
  /** 原画里的背景（瀑布、草地、巨瓣）淡成窗里的薰衣草底（窗里的底色 + 光环 + 花海条）——放在收窗运动最快的一段（0.35–0.72 s，实测峰速在 0.58–0.70 s），
      窗的轮廓（描边、白框、阴影、窗台）从收窗一开始就在，换景发生时窗已经读得出来；光环跟着立绘走、花海条跟着窗的底边走，都不钉在终点位置. */
  wash: Span;
  /** 落定之后：窗里临时的薰衣草底与花海条淡出，露出拱窗自己的底（两边几乎一样）. */
  wOut: Span;
  /** 枝条、白花、雪、光尘、提示等随场景一起淡出. */
  scene: Span;
  /** 薰衣草底板溶掉（窗在场时：它在窗左缘让开的地方已经被遮罩撤掉，这里只是剩下的部分——窗后面的、左栏那一条——整体淡出，放在纸面铺满之后）. */
  bg: Span;
  /** 没有窗（窗口窄、拱窗不在场）时的底板溶解与纸面展开：不跟窗走，按时间展开. */
  bgF: Span;
  paper: Span;
  /** 拱窗里的真立绘先淡入（在分身下面），分身随后淡出——两边像素一致，先后错开避免中途变淡. */
  figIn: Span;
  figOut: Span;
  /** 快速版（没有收窗）：开屏里的人物淡完（bg 段）之后，拱窗里的真立绘才淡入. */
  figFade: Span;
  /** 拱窗里的署名原地淡入（昼的署名不飞）. */
  creditIn: Span;
}

const DAY: DaySegs = {
  ...COMMON,
  title: [0.2, 0.8],        // 昼：标题晚 0.06 s 起爬——蝶（自枝梢横着飞向左缘通道）要先抢在标题爬到同一高度之前过去，两者才不会在 (80, 100) 附近相交
  art: [0.1, 0.84], win: [0.1, 0.58], figOn: [0.04, 0.3], wash: [0.34, 0.66], wOut: [0.74, 0.88], scene: [0.05, 0.45], bg: [0.36, 0.76], bgF: [0.15, 0.6], paper: [0.25, 0.82],
  textOut: [0.03, 0.2], washTop: [0.1, 0.42],
  figIn: [0.84, 0.9], figOut: [0.9, 1.0], figFade: [0.6, 0.86], creditIn: [0.62, 0.84],
};

/** 昼的快速版：窗的左缘不按 7/12 压缩（压缩了它一秒钟要扫过 9000 px 以上，比完整版快 1.7 倍）；走 0.06–0.48 s（峰值约 6300 px/s，是完整版的 1.15 倍），0.27 s 左右就让开主栏、输入框 0.33 s 前可见. */
const DAY_FAST: Partial<DaySegs> = { win: [0.06, 0.48] };
export const daySegs = (kind: TransitionKind): DaySegs => (kind === 'full' ? DAY : { ...scaled(DAY, trDuration(kind) / TR_FULL), ...DAY_FAST });

export const DAY_TITLE_COLOR = '#3a2357';
export const DAY_EN_COLOR = '#5a3a7e';

/** 昼：立绘收进拱窗。裁切框（相对一个 box 的四边内缩与上 / 下圆角，单位与入参一致）从整个窗口（p=0）收成拱窗（p=1）。
    左缘与拱顶圆角走自己的进度 pl（缺省 = p）：它们是窗「让开主栏」的那一边，比立绘的缩放走得急（WIN_E）；上 / 右 / 下三边只缩 12 px，随 p. */
export interface ArchClip { t: number; r: number; b: number; l: number; rTop: number; rBot: number }
export const ARCH_BOTTOM_RADIUS = 16;
export function archClip(p: number, boxW: number, boxH: number, arch: Rect, botR = ARCH_BOTTOM_RADIUS, pl = p): ArchClip {
  return {
    t: lerp(0, arch.y, p), l: lerp(0, arch.x, pl),
    r: lerp(0, boxW - (arch.x + arch.w), p), b: lerp(0, boxH - (arch.y + arch.h), p),
    rTop: lerp(0, arch.w / 2, pl), rBot: lerp(0, botR, p),
  };
}
export const archClipCss = (c: ArchClip) => `inset(${c.t.toFixed(2)}px ${c.r.toFixed(2)}px ${c.b.toFixed(2)}px ${c.l.toFixed(2)}px round ${c.rTop.toFixed(2)}px ${c.rTop.toFixed(2)}px ${c.rBot.toFixed(2)}px ${c.rBot.toFixed(2)}px)`;

/** 裁切框（archClip 的结果）在 box 里露出的矩形（box 单位）. */
export const archClipRect = (c: ArchClip, boxW: number, boxH: number): Rect => ({ x: c.l, y: c.t, w: boxW - c.r - c.l, h: boxH - c.b - c.t });
/** 舞台单位的矩形 → 屏幕像素：舞台先按 z 绕 A 放大（开屏的镜头推近），再整体乘 k. */
export const stageToScreen = (r: Rect, z: number, A: Pt, k: number): Rect => ({ x: k * (A[0] + z * (r.x - A[0])), y: k * (A[1] + z * (r.y - A[1])), w: k * z * r.w, h: k * z * r.h });

/** figure-official（1181×1600）与 splash-official（1600²）是同一幅稿：x_sp = 0.634·x + 193.9，y_sp = 0.634·y + 227.7（STORYBOARD §3.4，SIFT + RANSAC）. */
export const FIG_REG = { s: 0.634, x: 193.9, y: 227.7, w: 1181, h: 1600 } as const;
/** 开屏里立绘（.s0-art）：舞台坐标 (470, −62)、1280 见方，素材 1600 px，所以每个素材像素 0.8 个舞台单位. */
export const ART_STAGE = { x: 470, y: -62, size: 1280, px: 1600 } as const;
/** 人物分身（figure-official 的抠图）在开屏舞台里的方框：恰好叠在原画（splash）里同一个人的位置（舞台单位）. */
export const FIG_STAGE = (() => {
  const u = ART_STAGE.size / ART_STAGE.px;
  const w = u * FIG_REG.s * FIG_REG.w;
  return { x: ART_STAGE.x + u * FIG_REG.x, y: ART_STAGE.y + u * FIG_REG.y, w, h: (w * FIG_REG.h) / FIG_REG.w };
})();
/** 把开屏里的立绘落到拱窗里立绘的位置：fig = 拱窗里 figure-official 的方框（屏幕像素），k = 舞台缩放。返回平移（屏幕像素）与缩放倍数. */
export interface ArtFit { dx: number; dy: number; r: number }
export function artFit(k: number, fig: Rect): ArtFit {
  const sb = (ART_STAGE.size / ART_STAGE.px) * k;                     // 开屏：每个素材像素多少屏幕像素
  const st = fig.w / FIG_REG.w / FIG_REG.s;                           // 拱窗：同上
  const ox = fig.x - FIG_REG.x * st;
  const oy = fig.y - FIG_REG.y * st;
  return { dx: ox - ART_STAGE.x * k, dy: oy - ART_STAGE.y * k, r: st / sb };
}

/** 昼：跟着立绘一起收窗的东西（立绘身后的光环）。它们按「终态位置」摆好，再套这个变换：p = 1 时是恒等，p < 1 时与立绘同步
    （原画的变换 T(p) 乘 T(1) 的逆），所以光环始终在她的头后面，不会钉在终点位置、在窗还很大的时候先亮在右边。
    返回舞台单位的 translate(x, y) scale(a)，transform-origin 在舞台原点. */
export interface DecoXf { a: number; x: number; y: number }
export function decoXf(p: number, fit: ArtFit, k: number): DecoXf {
  const a = Math.pow(fit.r, p - 1);
  const tx = fit.dx / k;
  const ty = fit.dy / k;
  return { a, x: (1 - a) * ART_STAGE.x + tx * p - a * tx, y: (1 - a) * ART_STAGE.y + ty * p - a * ty };
}

/** 昼的纸面展开：一条 (A + F) 宽的渐变（A 不透明、F 渐出）随前缘从左向右推过去；四周多留 E（别把纸面的阴影一起裁掉）。
    有窗时纸面的前缘就是窗的左缘（见 paperEdge）：纸始终在窗下面、全屏只有一条移动的竖边——窗是「让开」、纸是「露出来」，不是两张半透明板错位叠着；
    前缘的羽化 140 px（R5：原来 56 px 的前缘在窗的左缘以 5000 px/s 扫过时读成一根硬竖条；现在高速时由这条 140 px 的软边领跑，窗自己的描边在高速段淡掉——winEdgeAlpha——减速后再补上）. */
export const PAPER_FEATHER = 140;
export const PAPER_EXT = 40;
/** 前缘（渐变归零处）落在窗左缘之内这么多（窗的 6 px 白框压住它）. */
export const PAPER_GAP = 6;
/** 窗停稳之后，前缘再向窗里走这么远（藏在窗下面）：纸面连同它右缘的阴影一并铺满，结束时撤掉遮罩不会有一跳. */
export const PAPER_TAIL = 194;
export function paperMask(W: number, F = PAPER_FEATHER, E_ = PAPER_EXT) {
  const A = W + 2 * E_;
  const Wi = A + F;
  return {
    A, Wi,
    /** 前缘（渐变归零处）在 xe（相对元素左缘）时，渐变图左缘相对元素左缘的位置. */
    x0At: (xe: number) => xe - Wi,
    /** 前缘羽化带的中点（它越过一个块的右缘，这个块才开始浮现）. */
    midAt: (xe: number) => xe - F / 2,
    /** 没有窗时（退路）按进度 p 的前缘. */
    xeAt: (p: number) => -E_ + Wi * p,
    image: `linear-gradient(90deg, #000 0, #000 ${A}px, transparent ${A + F}px)`,
  };
}
/** 昼 · 有窗时纸面前缘的位置（相对纸面元素的左缘，px）：窗的左缘（winLeft，屏幕 px）减去纸面的左缘（mainLeft）与 PAPER_GAP；
    窗的左缘走完（winL 的最后 10%）之后再向窗里推 PAPER_TAIL. */
export const paperEdge = (winLeft: number, mainLeft: number, winL: number) => winLeft - mainLeft - PAPER_GAP + PAPER_TAIL * sstep(win(winL, 0.9, 1));

/** 昼 · 应用侧入场的专属部分：奶油纸面「展卷」（前缘 = 窗的左缘）、署名在拱窗里原地淡入、拱窗里的真立绘 / 光环等先隐藏后现身. */
export function dayEntrance(c: EntranceCtx): ThemeEntrance {
  const { o, dur, main, mainRect, samples, wakeStep, add, hold, flip, track, q1 } = c;
  const S = c.S as DaySegs;
  const hasWin = !!o.cover && o.cover(0).length > 0;                         // 有窗：纸面的前缘就是窗的左缘
  const pm = mainRect ? paperMask(mainRect.w) : null;
  /** 纸面前缘（渐变归零处，相对纸面元素的左缘）在 tr 时的位置. */
  const paperXe = (tr: number): number => {
    if (!pm) return 0;
    if (hasWin && mainRect && o.cover) {
      const w = o.cover(tr)[0];
      return paperEdge(w ? w.x : 0, mainRect.x, c.state(tr).winL);
    }
    return pm.xeAt(PAPER_E(win(tr, S.paper[0], S.paper[1])));
  };
  const paperWake = (r: Rect | undefined) => {
    if (!pm || !r || !mainRect) return 0;
    const right = r.x + r.w - mainRect.x;
    for (let i = 0; i < samples.length; i++) { const tr = Math.min(dur, i * wakeStep); if (pm.midAt(paperXe(tr)) >= right) return tr; }
    return dur;
  };
  const byTarget = (name: string) => document.querySelector<HTMLElement>(`[data-boot-target="${name}"]`);
  return {
    extraWake: (r) => paperWake(r),
    main() {
      if (!pm || !main) return;
      if (c.comp && hasWin) return;          // comp 有窗：纸面始终在，由底板（三份拷贝）的移动露出来，不再逐拍 seek 一条 mask-position（合成器画不了）；没有窗（开屏很早就被打断）时仍是 legacy 的按时间推进的展卷遮罩
      // 昼：奶油纸面「展卷」——有窗时前缘就是窗的左缘（paperEdge：窗让开多少、纸露出多少，全屏只有一条移动的竖边；纸始终在窗下面），按 8 ms 一档采样成关键帧；
      // 没有窗（窗口窄、拱窗不在场）时退回按时间推进的前缘。遮罩四周多留 40 px，别把纸面的阴影一起裁掉；结束时 cancel，不留遮罩
      const sz = `${pm.Wi}px calc(100% + ${2 * PAPER_EXT}px)`;
      // mask-clip: no-clip：默认的 border-box 会把纸面外的阴影也裁掉（遮罩一撤，阴影又冒出来）
      const mk = (xe: number): Record<string, string> => ({ maskImage: pm.image, maskSize: sz, maskRepeat: 'no-repeat', maskClip: 'no-clip', maskOrigin: 'border-box', maskPosition: `${pm.x0At(xe).toFixed(2)}px ${-PAPER_EXT}px` });
      if (hasWin) {
        const n = Math.max(2, Math.ceil(dur / 0.008));
        const frames: Keyframe[] = [];
        for (let i = 0; i <= n; i++) { const tr = (i / n) * dur; frames.push({ offset: i / n, easing: 'linear', ...mk(paperXe(tr)) }); }
        add(main, frames, undefined, true);     // mask-position 合成器画不了；它与场景里底板的补集遮罩同一个节拍推进（见 Entrance 的说明）
      } else add(main, track(mk(pm.xeAt(0)), mk(pm.xeAt(1)), S.paper, dur, PAPER_CSS), undefined, true);
    },
    holds() {
      // 署名不飞（昼）：拱窗里的真署名原地淡入
      if (!o.shared.credit && o.shared.creditFade) hold(byTarget('credit'), S.creditIn, c.comp);       // comp：署名在被藏起来（visibility:hidden）的真拱窗里——等拱窗露出来（creditIn 起）之后再建，否则 Chromium 判成「没有可见变化」、合成器画不了
      // 拱窗里的真立绘：用 visibility 而不是 opacity 来「先隐藏」——给大图加 opacity 动画会让它换一种方式光栅化，动画 cancel 的那一刻边缘会有极轻的一跳；
      // 它在分身（此刻还不透明）的下面变为可见，分身随后淡出（两边像素一致）
      if (o.shared.figFade) hold(byTarget('fig'), S.figFade);
      // comp：真拱窗（圆角裁切 + 渐变底 + 花海 + 立绘…整块是一个渲染面）在窗盖着它的这段时间里（到署名淡入起）藏起来不画——它在窗下面本来就看不见，每帧画它是白花 GPU（实测昼转场 550–1000 ms 的出帧停顿与它有关）
      if (c.comp && o.shared.fig) flip(q1('.daystage__arch'), S.creditIn[0]);
      if (o.shared.fig) {
        flip(byTarget('fig'), S.figIn[0]);
        // 真拱窗里的光环 / 底纹 / 花海条 / 窗台也一并藏起来，等开屏里临时的那一份开始淡出（wOut）时再交接：
        // 光环的 1.5 px 细圈不藏的话，开屏的底板溶解时会从巨瓣上透出来，浮在离她的头 450 px 的地方（评审 R4）
        for (const sel of ['.daystage__halo', '.daystage__pattern', '.daystage__flowers', '.daystage__hem']) flip(q1(sel), S.wOut[0]);
      }
    },
  };
}
