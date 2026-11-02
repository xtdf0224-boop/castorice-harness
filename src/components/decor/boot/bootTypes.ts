/* 开屏场景的公共类型。场景（夜 / 昼）只负责「时刻 t → 一帧画面」，不管时钟、输入与淡出——那些在 player.ts 与 BootSplash.tsx。
   开屏之后的转场（transition.ts）也是场景的一部分：场景实现 prepareTransition，给出「转场时刻 tr → 一帧」的纯函数。 */

export type BootTheme = 'night' | 'day';

export interface SceneOptions {
  /** 场景把自己的 DOM（画布、文字、火种）挂到这里. */
  host: HTMLElement;
  /** 资源前缀（import.meta.env.BASE_URL）. */
  base: string;
  /** 左上角的版本号. */
  version: string;
  /** 画面来源署名（夜：AI 辅助同人图；昼：官方立绘）. */
  credit: string;
  /** 导出模式：画布 1:1（不乘 dpr），不做任何节流. */
  capture: boolean;
}

/** 转场的两个长度：full = 开屏已播完（1.2 s）；fast = 开屏还没播完就被打断（0.7 s）。减少动态 / 被迫定格只做 ≤200 ms 的交叉淡化（BootSplash 里用 CSS，不走场景）。 */
export type TransitionKind = 'full' | 'fast';

export interface Rect { x: number; y: number; w: number; h: number }

/** 从活的应用里量出来的目标位置（屏幕像素；由 transition.ts 的 measureAnchors 填写）。 */
export interface TrAnchors {
  /** 左栏品牌标「枝上蝶」的方框. */
  mark?: Rect;
  /** 左栏字标「栖枝」「ALIGHT」的文字矩形与字号 / 字距（em）. */
  name?: Rect;
  sub?: Rect;
  nameFont: number;
  subFont: number;
  nameLS: number;
  subLS: number;
  /** 字标「栖枝」「ALIGHT」的字色（计算样式，rgb()）：飞行中的标题把渐变 / 字色一路插值到它. */
  nameColor?: string;
  subColor?: string;
  /** 壁纸 / 拱窗里的署名. */
  credit?: Rect;
  /** 昼：右侧拱窗与窗里的立绘（figure-official 的方框）、拱顶半径. */
  arch?: Rect;
  fig?: Rect;
  /** 首页壁纸取景（--wp-fx / --wp-face，夜）. */
  wpFx: number;
  wpFace: number;
  /** 壁纸层是否开着（关了就没有「同一张画」可接）. */
  wallpaper: boolean;
  /** 左栏（整块，含玻璃底）：夜的转场里它随取景平移从屏外推入. */
  nav?: Rect;
  /** 主栏的纸面（昼的 .app__main）：开屏的底板撤离时，纸面左缘以左的那一条（左栏）要留到纸面铺满之后再淡掉，不然左半屏会先灰一下. */
  main?: Rect;
  /** 窗口大小（CSS 像素）. */
  vw: number;
  vh: number;
}

/** 场景接管了哪些「共享元素」：应用侧据此决定左栏里对应的真元素先隐藏、等交接。 */
export interface TrShared {
  mark: boolean;
  title: boolean;
  /** 署名飞到去处（夜）：真署名先隐藏、等分身到位. */
  credit: boolean;
  /** 署名不飞（昼）：开屏里的署名原地淡出，拱窗里的真署名原地淡入. */
  creditFade: boolean;
  /** 夜：同一张壁纸随左栏一起平移——左栏面板从屏外推入，开屏底板在它推过的地方让出一个「洞」. */
  push: boolean;
  /** 昼：立绘（人物）的分身接手收窗，拱窗里的真立绘先隐藏、等落定后交接. */
  fig: boolean;
  /** 昼（快速版，没有收窗）：开屏里的人物先淡出，拱窗里的真立绘随后才淡入——不让两个人物各淡一半叠在一起. */
  figFade: boolean;
}

/** 分档创建动画的队列（sampler.ts 的 Stager；只有实时播放的夜才给，导出 / 昼不给 = 全部立刻建）. */
export type TrStager = import('./sampler').Stager;

export interface TrOptions {
  kind: TransitionKind;
  /** 实时播放：非紧急的动画由它按 deadline 排队创建，起步的同步段只建马上要动的. */
  stager?: TrStager;
  /** 离开时场景的时刻（秒）：≥ duration 表示已经定格；小于它表示被打断. */
  from: number;
  anchors: TrAnchors;
}

/** 首页壁纸层（夜）在转场里要套的「剩余变换」：屏幕点 P → (x, y) + k·P（原点在屏幕左上角）。 */
export interface BackdropXf { x: number; y: number; k: number }

export interface SceneTransition {
  readonly shared: TrShared;
  /** 画转场第 tr 秒（0 … 转场总长）。时间 tr 的纯函数：同一个 tr 永远是同一帧. */
  render(tr: number): void;
  /** 此刻开屏里「在界面上方飞」的东西占着的矩形（标题、副标题、蝶；屏幕像素）。应用侧的元素等它们飞过才浮现（尾流），别叠在字上. */
  obstacles(tr: number): Rect[];
  /** 昼：此刻盖在界面上方的「窗」（收窗中的立绘，裁切框露出的矩形；屏幕像素）。应用侧的文字等窗的边缘越过它再浮现，不被窗的竖直边缘切掉一半. */
  cover?(tr: number): Rect[];
  /** 夜：开屏底板（位图）在 tr 时相对「它的终态（= 首页壁纸的取景）」还剩的变换。转场把同一个变换套在首页壁纸层上，
   *  于是两层作为一个整体一起收到位——无论溶解与平移怎么重叠都不会出现脸的双影（R5；之前是「先对齐再溶解」，对齐的 ease-out 长尾巴与溶解重叠了）. 不需要（没有平移）返回 null. */
  backdrop?(tr: number): BackdropXf | null;
  /** 撤掉转场加的所有东西（画布、内联样式），场景回到离开时的样子. */
  dispose(): void;
  /* ── 合成器路径（comp）才有的三个可选成员；没有（legacy / 昼）就一律走 render ── */
  /** 实时：让场景自己的合成器动画从时间轴时刻 t0（毫秒）起开跑（与应用侧入场的 play 同一个 t0）. */
  play?(t0: number): void;
  /** 实时：节拍帧——只做残余 JS（需要逐帧重画的小块：标题组、枝、光尘）；合成器上的动画不碰. 没有就用 render. */
  step?(tr: number): void;
  /** 慢机器的退路：调速器升档，把场景自己的合成器动画重建成阶梯. */
  retier?(divisor: number, refreshMs: number): void;
  /** 转场结束、覆盖层即将卸载：撤掉场景挂在「应用元素」（首页壁纸层……）上的动画与内联样式；覆盖层内部的东西随整个覆盖层卸载. */
  end?(): void;
}

/** 昼开屏的「视频版」接管开关（bootVideo.ts / videoRun.ts；docs/BOOT-VIDEO.md）。视频期间 render(t) 只画文字 + 光尘（背景层由视频顶着）。 */
export interface SceneVideo {
  /** 视频每呈现一帧（rVFC）告诉场景它的媒体时间：清晰立绘层的淡入进度按它算（与视频母版里立绘组的 α 重映射同一个 q）. */
  note(mediaTime: number): void;
  /** 进入视频模式：实时背景层（底板 / 舞台 / 蝶）visibility:hidden，不参与栅格、不再每拍写样式. 必须在第一次 render 之前、prepare() 之前调. */
  begin(): void;
  /** 此刻是视频模式？（交接 / 打断 / 退路之后为假） */
  readonly active: boolean;
  /** 媒体时间 ≥ 7.15 s：在一个任务里 render(T_END) 把 DOM 背景层写成最终态，三层设为可见、opacity .001（叠在视频之上），提前栅格好. 幂等. */
  preraster(): void;
  /** 抵达最后一帧：同一个任务里再 render(T_END)，三层的 opacity 用 WAAPI 从 .001 升到 1（fadeMs；0 = 硬切），finished 之后 resolve. 之后场景回到普通模式. */
  handoff(fadeMs: number): Promise<void>;
}

export interface BootScene {
  readonly theme: BootTheme;
  /** 昼：视频版的接管开关；夜没有. */
  readonly video?: SceneVideo;
  /** 仅导出（DEV 的 window.__boot.seek 的 layers 选项）：'bg' = .bd-text 隐藏 + 光尘不画 + 其余 fx 照画（视频母版用）；'all' = 完整. */
  setLayers?(mode: 'all' | 'bg' | 'vid'): void;
  /** 动画时长（秒）；之后是定格画面（ambient）. */
  readonly duration: number;
  /** 素材解码完毕、字体就绪、第一次布局完成. */
  readonly ready: Promise<void>;
  /** 绘制时刻 t 的完整一帧（画布＋DOM）。skipBg 仅夜用：背景画布不动时跳过它（定格后的 ambient）. */
  render(t: number, skipBg?: boolean): void;
  /** 窗口尺寸变了（CSS 像素）。会清空画布，调用方随后要再 render 一次. */
  resize(w: number, h: number, dpr: number): void;
  /** 开屏 → 主界面的转场：量好场景这边的起点、把需要的层准备好。场景停在 o.from 那一帧不再自己动. */
  prepareTransition(o: TrOptions): SceneTransition;
  /** 可选：在 resize 之后（遮罩下 / 起跳的同时）把开屏里每拍要重光栅的东西预先烘成位图 / 画布（昼：绽开画布、花海条、光晕、底板），任务切成 < 10 ms 的小片，不挡起跳；
      resolve = 烘完（或放弃：位图没备好的那一项一直走旧的 DOM 路径，画面一致）. 导出模式默认不烘（逐帧确定），地址里带 ?bloomcv=1 才烘（对拍用）. */
  prepare?(): Promise<void>;
  /** 可选：离开开屏（被打断 / 定格后进入）的这一刻，把画布模式的东西在同一个任务里换回 DOM 的状态（画面与 t 时刻的旧路径逐像素相同）。
      返回 Promise = 刚换回的 DOM 层还要等几个 rAF 才栅格好，调用方等它 resolve 再起转场（最多 2 个 rAF）；返回 undefined = 不用等. */
  settle?(t: number): Promise<void> | undefined;
  dispose(): void;
}
