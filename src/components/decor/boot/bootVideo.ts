/* 昼开屏 · 预渲染视频版（样片）：契约常量、判决（纯函数）、媒体时钟、退路判据，以及 <video> 的预加载。施工图：docs/BOOT-VIDEO.md。
   视频 = 昼开屏里「文字以外、与窗口比例无关」的所有重层，按 t = i / 120（i = 0 … 888，T_END = 7.4 s）逐帧预渲染成一段不透明视频；开屏时硬件解码播放，
   标题文字、署名、跳过提示、版本号、光尘仍实时画（dayScene.ts 的 renderDom / 光尘），播完在 T_END 交回实时 DOM，转场代码一行不改。
   这个文件**不碰场景**：earlyBoot.ts（最先执行的模块）要在页面最早处 import 它来预加载，所以只依赖 bootMath / prof 两个很小的模块（不拉 dayScene）；
   与 dayScene 的常量（T_END、落地时刻 L）一致由 scripts/check-boot.ts 核对，与 public/boot/day-boot.json 一致也由它核对。
   · 本文件里所有「判决」都是纯函数（node 里跑得动）：bootVideoEligible、videoRect、pickVideoFile（注入 mediaCapabilities）、MediaClock、VideoJudge；
   · 只有末尾的预加载（preloadBootVideo / acquireBootVideo / releaseBootVideo）碰 document。 */
import { aspectOk } from './bootMath';
import type { BootImpl } from './bootImpl';
import { tp } from './prof';

/** 契约（docs/BOOT-VIDEO.md §5.2；R 交付的 public/boot/day-boot.json 里同名字段，check-boot 核对）. */
export const BV = {
  /** 按显示分辨率渲染（0.2.0-beta.5）：用户窗口 2560×1600 物理像素、150 % 缩放，最大化约 1710×1020 CSS = 2565×1530 设备像素；舞台高 1000 单位 = 1530 设备像素。
      帧 = DPR 1.5 下 CSS 2140×1020 的整页 = 3210×1530 设备像素：窗口高 1020 CSS 时 1 个视频像素恰好对 1 个设备像素（不再放大 1.8 倍）；别的窗口高度按比例缩放. */
  width: 3210,
  height: 1530,
  /** 60 fps（0.2.0-beta.4 起；原 120）：240 / 120 / 60 Hz 的屏上每帧恰占 4 / 2 / 1 个刷新，节拍是整数；120 fps 在这台机器的屏外真窗口里只呈现了约 84 帧/秒、丢帧 27 %（视频合成成本，见 docs/BOOT-VIDEO.md §10）.
      视频只承载环境层，里面没有快速运动的东西（蝶 / 花瓣 / 光尘 / 文字都是实时的 120 fps），60 够了. */
  fps: 60,
  frames: 445,
  /** 设备像素 / 舞台单位（帧高 1530 对应 1000 个舞台单位）. 立绘与花海条在帧里的显示尺寸与实时版在同一窗口里一致（硬规则 4 的口径：不超过实时版）. */
  scale: 1.53,
  /** 视频覆盖的舞台宽度（单位）与能用视频的最大窗口宽高比. */
  extUnits: 2098.0,
  ratioMax: 2.0981,
  /** 视频内容的最后一刻 = 落地时刻 5.0 s + 2.4 s = dayScene 的 T_END；第 888 帧. */
  tEnd: 7.4,
  landing: 5.0,
  /** 交接：媒体时间 ≥ handoffPre 时预光栅 DOM 背景层；抵达最后一帧时交接，三层 DOM 背景 opacity 从 .001 升到 1 用 handoffFadeMs. */
  handoffPre: 7.15,
  handoffFadeMs: 120,
} as const;

/** 判决点最多再等视频多久（scene.ready 之后）；超时整次走实时. 待用户拍板的数（施工图 §9）. */
export const VIDEO_WAIT_MS = 300;
/** 媒体时钟的外推上限（ms）：视频卡住时文字最多比最后一个已呈现的帧多走这么多. */
export const EXTRAP_MAX_MS = 50;
/** 退路判据（§3.5）. */
export const STALL_MS = 150;              // 播放中媒体时间这么久不前进 = 卡死
export const START_STALL_MS = 1000;       // play() 之后这么久还没有第一个已呈现的帧
export const DROP_WINDOW_MS = 1000;       // 丢帧统计窗口
/* 窗口内丢帧 ≥ 30（= 50 % 的 60 fps：真正的「幻灯片」才退）。校准（2026-10-29，屏外真窗口、Intel 集显硬解、旁边无负载）：60 fps 的 H.264 丢 3–4 %（每秒 2–3 帧）、
   HEVC 6–7 %；同一环境下 120 fps 丢 27 %（视频合成成本把合成器压到约 167 帧/秒、视频每两个合成帧才换一帧，≈ 84 帧/秒）。
   原来的 12 %（120 fps 下 14 帧）会在这个环境里每次都触发，退路切换还要停 70–108 ms——比继续播（只是帧率低一点）更糟，所以只在真的画不动时才退. */
export const DROP_LIMIT = 30;
export const DROP_FROM = 2.8;             // 丢帧判据只在媒体时间 2.8 s – 6.0 s 之间生效（2.8 s 前转实时要走绽开段慢路径，6.0 s 后离交接太近）
export const DROP_TO = 6.0;
export const DROP_COUNT_FROM = 0.5;       // 冷启动的启动丢帧不算：统计从媒体时间 0.5 s 才开始
export const FALLBACK_LEAD = 0.12;        // 丢帧退路：视频不暂停，场景按「已呈现帧 + 这么多秒」去 settle，栅格那几个 rAF 里画面不停
export const SAMPLE_MS = 500;             // getVideoPlaybackQuality() 采样间隔
/** 抵达最后一帧的判据：媒体时间 ≥ tEnd − 半帧. */
export const END_MEDIA = BV.tEnd - 0.5 / BV.fps;
/** 文件完整性（截断 / 过短的视频）：manifest 与 BV 约定帧数 = frames、时长 = frames / fps（445 / 60 = 7.4167 s）.
    · 加载时：<video>.duration 与它相差超过 DURATION_TOL 秒 = 文件不对（截断的 mp4 的 moov 若是完整的，duration 对得上，由下面的「播完」检查管），整次走实时；
    · 播放中：视频报 ended 时，最后一个已呈现帧的媒体时间必须 ≥ tEnd − ENDED_SLACK（rVFC 最多少报最后一两帧）；不够 = 文件被截断，走退路（不提前交接）. */
export const DURATION_TOL = 0.04;
export const FILE_DURATION = BV.frames / BV.fps;
export const ENDED_SLACK = 2.5 / BV.fps;
export const durationOk = (d: number): boolean => Number.isFinite(d) && Math.abs(d - FILE_DURATION) <= DURATION_TOL;
/** 视频报 ended 时，已呈现的最后一帧够不够到 T_END（够 = 完整播完；不够 = 被截断）. */
export const endedComplete = (lastPresentedMedia: number): boolean => lastPresentedMedia >= BV.tEnd - ENDED_SLACK;

/** 一个文件：H.264 High L5.2（8 位，avc1.640034）。码率是 vbv 上限，给 mediaCapabilities 用.
    不再带 HEVC Main10：它在真窗口里比 H.264 暗约 2.4 个色阶（P010 非叠加路径）、60 fps 下开头还有一次 170–190 ms 的解码器冷启动停顿（H.264 没有），而 HEVC 的体积优势在 7 s 的环境层视频上不值得多带 14 MB. */
export interface VideoFile { role: 'primary'; name: string; codec: string; bitrate: number }
export const VIDEO_FILES: Record<'primary', VideoFile> = {
  primary: { role: 'primary', name: 'day-boot.avc.mp4', codec: 'avc1.640034', bitrate: 40_000_000 },
};
export const videoUrl = (base: string, f: VideoFile): string => `${base}boot/${f.name}`;

/* ───────── 判决 ───────── */

export type VideoReject = 'night' | 'impl' | 'not-requested' | 'aspect' | 'reduced' | 'hidden' | 'capability' | 'not-loaded';
export interface EligibleIn {
  theme: string;
  /** bootImpl() 的值（视频只在 'comp' 之上）. */
  impl: BootImpl;
  /** bootVideoRequested(...)：用户/地址/测量台是否想要视频. */
  requested: boolean;
  w: number;
  h: number;
  reduced: boolean;
  hidden: boolean;
  /** mediaCapabilities 判定通过（supported && powerEfficient；smooth 不参与，见 capabilityProbe）. */
  capability: boolean;
  /** <video> 已 loadeddata、readyState ≥ 2、没有 error. */
  loaded: boolean;
}
/** 窗口宽高比能用视频：在开屏的 [1.15, 2.10] 之内，并且不超过视频覆盖的宽度（2.0975）. */
export const videoAspectOk = (w: number, h: number): boolean => aspectOk(w, h) && w / Math.max(1, h) <= BV.ratioMax;
/** 判决（§3.2）：全部满足才用视频，缺一项整次走今天的实时路径，不做半视频. 返回第一个不满足的项. */
export function bootVideoEligible(i: EligibleIn): { ok: true } | { ok: false; reason: VideoReject } {
  if (i.theme !== 'day') return { ok: false, reason: 'night' };
  if (i.impl !== 'comp') return { ok: false, reason: 'impl' };
  if (!i.requested) return { ok: false, reason: 'not-requested' };
  if (!videoAspectOk(i.w, i.h)) return { ok: false, reason: 'aspect' };
  if (i.reduced) return { ok: false, reason: 'reduced' };
  if (i.hidden) return { ok: false, reason: 'hidden' };
  if (!i.capability) return { ok: false, reason: 'capability' };
  if (!i.loaded) return { ok: false, reason: 'not-loaded' };
  return { ok: true };
}

/** 视频的矩形（CSS 像素）：高 = 窗高，宽 = 窗高 × 1980 / 944，左上对齐于舞台原点（与 .bd-stage 的 scale(k) 原点一致，视频里的 1 个舞台单位恰好落在 DOM 同一位置）；
    窄窗口右侧被外层 overflow:hidden 裁掉，crop = 被裁掉的宽度. */
export function videoRect(W: number, H: number): { left: number; top: number; width: number; height: number; crop: number } {
  const width = (H * BV.width) / BV.height;
  return { left: 0, top: 0, width, height: H, crop: Math.max(0, width - W) };
}

/* ───────── mediaCapabilities ───────── */

export interface McInfo { supported: boolean; smooth: boolean; powerEfficient: boolean }
export interface McLike { decodingInfo(c: unknown): Promise<McInfo> }
export const decodingConfig = (f: VideoFile) => ({
  type: 'file',
  video: { contentType: `video/mp4; codecs="${f.codec}"`, width: BV.width, height: BV.height, framerate: BV.fps, bitrate: f.bitrate },
});
/** 这个文件能用：supported && powerEfficient（硬件解码）。没有 mediaCapabilities / 抛错 = 不能用. */
export async function capabilityOk(mc: McLike | undefined, f: VideoFile): Promise<boolean> {
  return (await capabilityProbe(mc, f)).ok;
}
export async function capabilityProbe(mc: McLike | undefined, f: VideoFile): Promise<{ ok: boolean; info?: McInfo }> {
  if (!mc || typeof mc.decodingInfo !== 'function') return { ok: false };
  try {
    const r = await mc.decodingInfo(decodingConfig(f));
    // smooth 不参与判决：它是 Chromium 按「这台机器以前放这个规格丢了多少帧」的历史记的——历史里有一次丢帧偏多（比如在屏外 / 被遮挡的窗口里放过）它就恒为 false，
    // 而我们一旦不放它就再也没有新的历史把它洗回 true（自锁，实测 2026-10-29：supported / powerEfficient 为 true、smooth 为 false，整次走实时）。真的画不动由播放中的退路判据管.
    return { ok: !!(r && r.supported && r.powerEfficient), info: r };
  } catch { return { ok: false }; }
}
/** 能力判定会「抖」：窗口 / GPU 进程刚起来时 decodingInfo 可能先答 powerEfficient = false（读 GPU 能力要等窗口加载之后）。
    所以不通过时隔一小会儿再问，最多 CAP_TRIES 次（预加载在 earlyBoot 里很早就开始，有足够的余量；判决点最多再等 VIDEO_WAIT_MS）. */
export const CAP_TRIES = 4;
export const CAP_RETRY_MS = 90;
export async function capabilityRetry(mc: McLike | undefined, f: VideoFile, sleep: (ms: number) => Promise<void>): Promise<{ ok: boolean; tries: number; last?: McInfo }> {
  let last: McInfo | undefined;
  for (let i = 1; i <= CAP_TRIES; i++) {
    const r = await capabilityProbe(mc, f);
    last = r.info;
    if (r.ok) return { ok: true, tries: i, last };
    if (!r.info) return { ok: false, tries: i, last };              // 没有 mediaCapabilities / 抛错：问再多次也一样
    if (i < CAP_TRIES) await sleep(CAP_RETRY_MS);
  }
  return { ok: false, tries: CAP_TRIES, last };
}
/** H.264 通过 = 'primary'，不通过 = null（整次走实时）. */
export async function pickVideoFile(mc: McLike | undefined): Promise<'primary' | null> {
  if (await capabilityOk(mc, VIDEO_FILES.primary)) return 'primary';
  return null;
}

/* ───────── 媒体时钟 ───────── */

/** 开屏的时钟改成媒体时钟（§3.3）：每次 rVFC 回调记 (mediaTime, expectedDisplayTime)，每拍场景时间 t = mediaTime + (本拍预计呈现时刻 − expectedDisplayTime) / 1000，
    外推量夹在 [0, EXTRAP_MAX_MS]——视频卡住（媒体时间不前进）时文字也跟着停，不会跑到视频前面。首个 rVFC 到来前 t = 0。
    抵达最后一帧之前 t 恒小于 tEnd（外推不会让文字提前走完、提前触发交接）；抵达最后一帧（媒体时间 ≥ END_MEDIA）后 t = tEnd. */
export class MediaClock {
  private m = 0;
  private disp = 0;
  private has = false;
  /** 一个新呈现的视频帧：mediaTime（秒）与它预计上屏的时刻（performance.now() 的 ms）. 媒体时间不倒退（seek 回去不在这里发生）. */
  note(mediaTime: number, expectedDisplayMs: number): void {
    if (this.has && mediaTime < this.m) return;
    this.m = mediaTime;
    this.disp = expectedDisplayMs;
    this.has = true;
  }
  /** 视频自己报「播完了」（ended）：最后一帧肯定已经呈现，哪怕 rVFC 少报了一两次——但只在已呈现的媒体时间离 T_END 不超过 ENDED_SLACK 时才这么认；
      更早就 ended = 文件被截断 / 过短，不能替它「补」到 T_END（那会在半路提前交接）：返回 false，调用方走退路. */
  noteEnded(nowMs: number): boolean {
    if (!endedComplete(this.has ? this.m : 0)) return false;
    this.note(Math.max(this.m, BV.tEnd), nowMs);
    return true;
  }
  get started(): boolean { return this.has; }
  /** 最近一个已呈现的帧的媒体时间（秒）；还没有 = 0. */
  get media(): number { return this.has ? this.m : 0; }
  /** 本拍的场景时间（秒）. displayMs = 这一拍预计上屏的时刻. */
  at(displayMs: number): number {
    if (!this.has) return 0;
    if (this.m >= END_MEDIA) return BV.tEnd;
    const ext = Math.min(EXTRAP_MAX_MS, Math.max(0, displayMs - this.disp));
    return Math.min(this.m + ext / 1000, BV.tEnd - 1e-4);
  }
  /** 抵达最后一帧？ */
  get atEnd(): boolean { return this.has && this.m >= END_MEDIA; }
  reset(): void { this.m = 0; this.disp = 0; this.has = false; }
}

/* ───────── 退路判据 ───────── */

export type FallbackReason = 'error' | 'stall' | 'start-stall' | 'dropped' | 'play-rejected' | 'resize' | 'hidden-fail' | 'no-rvfc' | 'truncated';
/** 播放中的退路判据（§3.5）。纯逻辑：调用方每隔一小段时间喂样本，返回非 null = 该转实时了；触发一次后恒返回 null（退路只触发一次，不回到视频）.
    · 卡死：播放状态下媒体时间 > STALL_MS 不前进；开播后 START_STALL_MS 内还没有第一个已呈现的帧也算；
    · 丢帧：近 DROP_WINDOW_MS 内丢帧 ≥ DROP_LIMIT，仅在媒体时间 DROP_FROM – DROP_TO 之间生效；窗口只取生效区间内的样本（区间前的丢帧——冷启动补丁等——不算，见 sample）。
      显示器刷新率低于视频帧率时，Chromium 会把「这一拍没机会呈现」的帧也算进 dropped：阈值再加上 (fps − 刷新率) × 窗口秒数（否则 60 Hz 的屏上 2.8 s 一定误触发）. */
export class VideoJudge {
  fired: FallbackReason | null = null;
  private samples: Array<[number, number]> = [];
  /** 一次 getVideoPlaybackQuality() 采样. refreshHz 未知传 undefined（按够快处理）.
      统计窗口只取**落在生效区间 [DROP_FROM, DROP_TO] 之内**的样本：区间之前的丢帧（冷启动补丁、warm 探针 / 偷看应用那几帧、绽开段的主线程忙）一个都不算——
      否则区间前的 0.5 s 里攒下的丢帧会让 2.8 s 一到就误触发（自测里实测过：warm 的 GPU 峰值把 2.4–3.1 s 的丢帧推到 ≥ 14）. 所以最早在媒体时间 DROP_FROM + 1 s 才可能触发. */
  sample(nowMs: number, mediaTime: number, dropped: number, refreshHz?: number): FallbackReason | null {
    if (this.fired) return null;
    if (mediaTime < DROP_COUNT_FROM || mediaTime < DROP_FROM || mediaTime > DROP_TO) { this.samples.length = 0; return null; }
    this.samples.push([nowMs, dropped]);
    while (this.samples.length > 1 && nowMs - this.samples[1][0] >= DROP_WINDOW_MS) this.samples.shift();
    const first = this.samples[0];
    const span = nowMs - first[0];
    if (span < DROP_WINDOW_MS * 0.9) return null;
    const slack = refreshHz && refreshHz < BV.fps ? (BV.fps - refreshHz) * (span / 1000) : 0;
    if (dropped - first[1] >= DROP_LIMIT + slack) { this.fired = 'dropped'; return 'dropped'; }
    return null;
  }
  /** 卡死判据. playing = 视频应当正在播（未暂停、未隐藏、未结束）；lastAdvanceMs = 媒体时间上一次前进（或开播）的时刻；gotFrame = 开播后已经有过已呈现的帧. */
  stall(nowMs: number, lastAdvanceMs: number, playing: boolean, gotFrame: boolean, mediaTime: number): FallbackReason | null {
    if (this.fired || !playing || mediaTime >= END_MEDIA) return null;
    if (!gotFrame) { if (nowMs - lastAdvanceMs > START_STALL_MS) { this.fired = 'start-stall'; return 'start-stall'; } return null; }
    if (nowMs - lastAdvanceMs > STALL_MS) { this.fired = 'stall'; return 'stall'; }
    return null;
  }
  /** 外部原因（error、play() 被拒、resize 越界……）直接触发. */
  trip(reason: FallbackReason): FallbackReason | null {
    if (this.fired) return null;
    this.fired = reason;
    return reason;
  }
}

/* ───────── 测量台读的状态 ───────── */

export interface VidInfo {
  requested?: boolean;
  used?: boolean;
  reason?: string;
  waitMs?: number;
  capTries?: number;
  cap?: McInfo;
  file?: string;
  loadMs?: number;
  fallbacks?: Array<{ reason: string; at: number; media: number }>;
  handoffAt?: number;
  preAt?: number;
  prepareDoneAt?: number;
  dropped?: number;
  total?: number;
  stalls?: number;
  waits?: number;
}
/** globalThis.__alightBootVid：每次开屏重置；BootSplash / videoRun 往里记，测量台（perf-work/harness）读. */
export function vidInfo(reset = false): VidInfo {
  const g = globalThis as unknown as { __alightBootVid?: VidInfo };
  if (reset || !g.__alightBootVid) g.__alightBootVid = {};
  return g.__alightBootVid;
}

/* ───────── <video> 的预加载（碰 document）───────── */

export interface BootVideo {
  el: HTMLVideoElement;
  /** 当前（最后一次尝试）的文件. */
  file: 'primary';
  state: 'loading' | 'ready' | 'failed';
  reason?: string;
  capTries?: number;
  capInfo?: McInfo;
  startedAt: number;
  readyAt?: number;
  /** 主文件读到 loadeddata 且能力判定通过（必要时换兜底再来一遍）= true；都不行 = false. */
  ready: Promise<boolean>;
  released: boolean;
}

let held: BootVideo | null = null;

function loadedOrError(el: HTMLVideoElement): Promise<boolean> {
  return new Promise<boolean>((res) => {
    if (el.error) { res(false); return; }
    if (el.readyState >= 2) { res(true); return; }
    const done = (v: boolean) => { el.removeEventListener('loadeddata', ok); el.removeEventListener('error', bad); res(v); };
    const ok = () => done(true);
    const bad = () => done(false);
    el.addEventListener('loadeddata', ok);
    el.addEventListener('error', bad);
  });
}

function makeVideo(base: string): BootVideo {
  const el = document.createElement('video');
  el.className = 'boot__vid';
  el.muted = true;
  el.defaultMuted = true;
  el.playsInline = true;
  el.preload = 'auto';
  el.controls = false;
  el.loop = false;
  el.disablePictureInPicture = true;
  (el as unknown as { disableRemotePlayback?: boolean }).disableRemotePlayback = true;
  el.tabIndex = -1;
  el.setAttribute('aria-hidden', 'true');
  el.setAttribute('muted', '');
  el.setAttribute('playsinline', '');
  const h: BootVideo = { el, file: 'primary', state: 'loading', startedAt: performance.now(), ready: Promise.resolve(false), released: false };
  h.ready = (async () => {
    const mc = (navigator as unknown as { mediaCapabilities?: McLike }).mediaCapabilities;
    for (const role of ['primary'] as const) {
      const f = VIDEO_FILES[role];
      h.file = role;
      const cap = capabilityRetry(mc, f, (ms) => new Promise<void>((res) => setTimeout(res, ms))).then((r) => { h.capTries = r.tries; h.capInfo = r.last; return r.ok; });
      el.src = videoUrl(base, f);              // 立刻开始读：与能力判定并行（摸底：src 设置后 25–90 ms loadeddata）
      if (!(await cap)) { h.reason = `capability:${role}`; continue; }
      const loaded = await loadedOrError(el);
      if (h.released) return false;
      if (loaded && !durationOk(el.duration)) { h.reason = `duration:${role}:${Number.isFinite(el.duration) ? el.duration.toFixed(3) : el.duration}`; continue; }      // 文件不完整 / 不对：时长对不上 manifest（frames / fps）
      if (loaded) { h.state = 'ready'; h.readyAt = performance.now(); return true; }
      h.reason = `load:${role}`;
    }
    h.state = 'failed';
    return false;
  })().catch(() => { h.state = 'failed'; h.reason ??= 'exception'; return false; });
  tp('video:preload');
  return h;
}

/** 页面最早处（lib/earlyBoot.ts）开始预加载：<video> 在这里建好并读文件，BootSplash 随后 acquire 同一个元素. 重复调用无害. */
export function preloadBootVideo(base: string): void {
  if (held || typeof document === 'undefined') return;
  try { held = makeVideo(base); } catch { held = null; }
}

/** 取走预加载的 <video>（所有权交给调用方，由它 releaseBootVideo）；没有（预览重播、预加载没做）就现建一个. */
export function acquireBootVideo(base: string): BootVideo | null {
  if (typeof document === 'undefined') return null;
  const h = held;
  held = null;
  if (h && !h.released) return h;
  try { return makeVideo(base); } catch { return null; }
}

/** 放掉预加载但没人要的 <video>（开屏没播、主题对不上……）. */
export function discardPreloadedBootVideo(): void {
  if (held) { releaseBootVideo(held); held = null; }
}

/** 释放：停播、清 src、load() 让解码器放手、摘下元素. */
export function releaseBootVideo(h: BootVideo | null | undefined): void {
  if (!h || h.released) return;
  h.released = true;
  const el = h.el;
  try { el.pause(); } catch { /* 无所谓 */ }
  try { el.removeAttribute('src'); el.load(); } catch { /* 无所谓 */ }
  el.remove();
}

/** 等视频就绪，最多 maxMs；已经就绪立即返回（不多一个 tick）. */
export function waitBootVideo(h: BootVideo, maxMs: number): Promise<{ ok: boolean; reason?: string; waitMs: number }> {
  if (h.state === 'ready') return Promise.resolve({ ok: true, waitMs: 0 });
  if (h.state === 'failed') return Promise.resolve({ ok: false, reason: h.reason ?? 'failed', waitMs: 0 });
  const t0 = performance.now();
  return new Promise((res) => {
    const timer = window.setTimeout(() => res({ ok: false, reason: 'timeout', waitMs: Math.round(performance.now() - t0) }), maxMs);
    void h.ready.then((ok) => { window.clearTimeout(timer); res({ ok, reason: ok ? undefined : (h.reason ?? 'failed'), waitMs: Math.round(performance.now() - t0) }); });
  });
}
