/* 昼开屏 · 视频版的播放控制（docs/BOOT-VIDEO.md §1.4、§1.5、§3.3、§3.5）。
   一次开屏对应一个 VideoRun：BootSplash 在判决通过后建它，把预加载好的 <video> 叠进舞台（最底层）、起播、跟着视频走时钟、预光栅、交接，出问题时退回实时。
   · 时钟：每次 requestVideoFrameCallback 回调把 (mediaTime, expectedDisplayTime) 记进 MediaClock，BootPlayer 每拍用它算场景时间（player.ts 的 PlayerMedia）；
   · 预光栅 / 交接：媒体时间 ≥ 7.15 s 让场景把 DOM 背景层写成最终态并可见（opacity .001，叠在视频上）；抵达最后一帧（≥ 7.4 − 半帧）时交接——三层 opacity .001 → 1 用 120 ms，
     淡完撤掉 <video>（pause + 清 src + load() 放掉解码器）；
   · 退路（只触发一次，之后不再回视频）：error、卡死（> 150 ms 媒体时间不前进）、丢帧达到 DROP_LIMIT（见 bootVideo.ts 的 VideoJudge）、play() 被拒、窗口比例越界。
     触发后 <video> 立刻暂停，把「最近一次已呈现帧的 mediaTime」交给调用方（onFallback）：它做 scene.settle(from)、撤视频、BootPlayer.resumeLive(from)；
     例外：丢帧退路（视频只是慢、没坏）不暂停——视频接着播，调用方拿 from = 已呈现帧 + FALLBACK_LEAD 去 settle，DOM 栅格的那 2 个 rAF（实测可达 70–108 ms）里画面不停，
     栅格完等媒体时间追上 from（holdAt）再同一个任务里换手，用户看到的是继续在动、没有那一顿；
   · 页面隐藏：video.pause()，可见后 play()，时钟随媒体走；
   · 被用户打断（任意键 / 点击）：interrupt() 暂停并返回最近一次已呈现帧的 mediaTime（不取墙钟、不取 video.currentTime——它可能已超前于已呈现帧）. */
import type { BootScene } from './bootTypes';
import type { PlayerMedia } from './player';
import { learnedRefresh } from './pacer';
import { tp } from './prof';
import { BV, END_MEDIA, FALLBACK_LEAD, MediaClock, SAMPLE_MS, VideoJudge, releaseBootVideo, videoRect, vidInfo, type BootVideo, type FallbackReason } from './bootVideo';

export type RunPhase = 'staged' | 'playing' | 'handoff' | 'done' | 'interrupted' | 'fallback' | 'disposed';

export interface VideoRunOpts {
  scene: BootScene;
  video: BootVideo;
  /** .boot__stage（场景的宿主）. */
  host: HTMLElement;
  /** 退路：<video> 已暂停，from = 最近一次已呈现帧的媒体时间（秒）. 调用方做 settle / 换墙钟 / dispose(). */
  onFallback(reason: FallbackReason, from: number): void;
}

export class VideoRun {
  readonly clock = new MediaClock();
  readonly judge = new VideoJudge();
  phase: RunPhase = 'staged';
  private box: HTMLDivElement | null = null;
  private rv = 0;
  private timer = 0;
  private lastAdvance = 0;
  private lastSample = 0;
  private gotFrame = false;
  private fellBack = false;
  /** 丢帧退路：视频不暂停、rVFC 继续记媒体时钟，直到调用方换手（dispose）. */
  private keepAlive = false;
  private readonly listeners: Array<[string, () => void]> = [];

  constructor(private readonly o: VideoRunOpts) {}

  /** 场景要用的媒体时钟（交给 BootPlayer）. */
  get media(): PlayerMedia {
    return {
      at: (displayMs) => this.clock.at(displayMs),
      tick: () => {
        if (this.phase === 'playing' && this.clock.media >= BV.handoffPre) {
          const info = vidInfo();
          if (info.preAt === undefined) { info.preAt = +performance.now().toFixed(1); tp('video:pre'); }
          this.o.scene.video?.preraster();
        }
      },
      end: () => this.handoff(),
    };
  }

  /** 视频还在顶着背景（没交接、没退路、没被打断）？ */
  get active(): boolean { return this.phase === 'staged' || this.phase === 'playing'; }

  /** 叠进舞台最底层（在场景的 DOM 之前）. 此时视频暂停在第 0 帧. */
  mount(W: number, H: number): void {
    const box = document.createElement('div');
    box.className = 'boot__vbox';
    box.setAttribute('aria-hidden', 'true');
    box.appendChild(this.o.video.el);
    this.o.host.insertBefore(box, this.o.host.firstChild);
    this.box = box;
    this.layout(W, H);
  }

  /** 窗口尺寸变了：只改 <video> 的 CSS 尺寸，不重画. */
  layout(W: number, H: number): void {
    const el = this.o.video.el;
    const r = videoRect(W, H);
    el.style.width = `${r.width.toFixed(2)}px`;
    el.style.height = `${r.height}px`;
    el.style.left = `${r.left}px`;
    el.style.top = `${r.top}px`;
  }

  /** 窗口真正露出来的同一刻起播（第 0 秒是用户看到的第 0 秒）. */
  play(): void {
    if (this.phase !== 'staged') return;
    const el = this.o.video.el;
    this.phase = 'playing';
    const now = performance.now();
    this.lastAdvance = now;
    this.lastSample = now;
    const info = vidInfo();
    info.file = this.o.video.file;
    info.loadMs = this.o.video.readyAt !== undefined ? +(this.o.video.readyAt - this.o.video.startedAt).toFixed(1) : undefined;
    tp('video:play');
    const rvfc = (el as unknown as { requestVideoFrameCallback?: (cb: (now: number, m: { mediaTime: number; expectedDisplayTime: number }) => void) => number }).requestVideoFrameCallback;
    if (typeof rvfc !== 'function') { this.fallback('no-rvfc'); return; }
    const loop = (t: number, m: { mediaTime: number; expectedDisplayTime: number }) => {
      if (this.phase !== 'playing' && this.phase !== 'handoff' && !(this.phase === 'fallback' && this.keepAlive)) return;
      this.gotFrame = true;
      if (!this.clock.started || m.mediaTime > this.clock.media + 1e-6) this.lastAdvance = t;
      this.clock.note(m.mediaTime, m.expectedDisplayTime);
      this.o.scene.video?.note(m.mediaTime);
      this.rv = rvfc.call(el, loop);
    };
    this.rv = rvfc.call(el, loop);
    this.on('error', () => this.fallback('error'));
    // 播完了：最后一个已呈现的帧够到 T_END 才算（rVFC 少报一两帧不要紧）；半路就 ended = 文件被截断 / 过短，不提前交接，走退路回实时（从已呈现的那一帧接着跑）
    this.on('ended', () => { if (!this.clock.noteEnded(performance.now())) this.fallback('truncated'); });
    this.on('stalled', () => { vidInfo().stalls = (vidInfo().stalls ?? 0) + 1; });
    this.on('waiting', () => { vidInfo().waits = (vidInfo().waits ?? 0) + 1; });
    this.timer = window.setInterval(() => this.check(), 50);
    if (!document.hidden) {
      const p = el.play();
      if (p && typeof p.catch === 'function') p.catch(() => this.fallback('play-rejected'));
    }
  }

  /** 页面隐藏 / 可见（含缩到托盘）：与 BootPlayer.setHidden 同步. */
  setHidden(hidden: boolean): void {
    if (this.phase !== 'playing' && this.phase !== 'handoff') return;
    const el = this.o.video.el;
    if (hidden) { try { el.pause(); } catch { /* 无所谓 */ } return; }
    if (this.phase === 'handoff' || el.ended) return;
    this.lastAdvance = performance.now();
    const p = el.play();
    if (p && typeof p.catch === 'function') p.catch(() => this.fallback('play-rejected'));
  }

  /** 最近一次已呈现帧的媒体时间（还没有 = 0）. */
  presented(): number { return this.clock.started ? this.clock.media : 0; }

  /** 用户打断（任意键 / 点击 / 跳过）：暂停并返回最近一次已呈现帧的媒体时间；已经交接 / 退路 / 打断过 = undefined（调用方用播放器自己的时刻）. */
  interrupt(): number | undefined {
    if (!this.active) return undefined;
    const from = this.presented();
    this.phase = 'interrupted';
    this.halt();
    return from;
  }

  /** 退路（只触发一次）：暂停视频，把最近一次已呈现帧的媒体时间交给 onFallback. */
  fallback(reason: FallbackReason): void {
    if (this.fellBack || !this.active) return;
    this.fellBack = true;
    this.judge.trip(reason);
    let from = this.presented();
    this.phase = 'fallback';
    const keep = reason === 'dropped' && !this.o.video.el.paused && !this.o.video.el.ended && from > 0 && from < END_MEDIA - FALLBACK_LEAD;
    if (keep) {
      this.keepAlive = true;
      window.clearInterval(this.timer);       // 判据停了；rVFC 与 <video> 继续跑
      this.timer = 0;
      from += FALLBACK_LEAD;
    } else this.halt();
    const info = vidInfo();
    (info.fallbacks ??= []).push({ reason, at: +performance.now().toFixed(1), media: +from.toFixed(4) });
    this.quality();
    tp(`video:fallback:${reason}`);
    this.o.onFallback(reason, from);
  }

  /** 丢帧退路里等媒体时间追上 t（最多 maxMs；视频没在播 / 已结束 / 没开 keepAlive 立刻返回）. 返回此刻最近一次已呈现帧的媒体时间. */
  holdAt(t: number, maxMs = 160): Promise<number> {
    return new Promise((res) => {
      if (!this.keepAlive || this.presented() >= t) { res(this.presented()); return; }
      const t0 = performance.now();
      const poll = () => {
        if (this.presented() >= t || performance.now() - t0 >= maxMs || this.phase === 'disposed') { res(this.presented()); return; }
        requestAnimationFrame(poll);
      };
      requestAnimationFrame(poll);
    });
  }

  /** 交接：场景把 DOM 背景层淡入到不透明（120 ms），淡完撤视频. */
  private handoff(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'handoff';
    const info = vidInfo();
    info.handoffAt = +performance.now().toFixed(1);
    tp('video:handoff');
    this.quality();
    const scene = this.o.scene;
    const done = () => { if (this.phase === 'handoff') { this.phase = 'done'; this.dispose(); tp('video:handoff-done'); } };
    if (!scene.video) { done(); return; }
    void scene.video.handoff(BV.handoffFadeMs).then(done, done);
  }

  /** 每 50 ms：卡死判据；每 SAMPLE_MS：丢帧采样. */
  private check(): void {
    if (this.phase !== 'playing') return;
    const el = this.o.video.el;
    const now = performance.now();
    const playing = !el.paused && !el.ended && !document.hidden;
    let r = this.judge.stall(now, this.lastAdvance, playing, this.gotFrame, this.clock.media);
    if (!r && playing && now - this.lastSample >= SAMPLE_MS) {
      this.lastSample = now;
      const q = this.quality();
      const rf = learnedRefresh();
      if (q) r = this.judge.sample(now, this.clock.media, q.dropped, rf ? 1000 / rf : undefined);
    }
    if (r) this.fallback(r);
  }

  private quality(): { dropped: number; total: number } | undefined {
    try {
      const q = this.o.video.el.getVideoPlaybackQuality();
      const info = vidInfo();
      info.dropped = q.droppedVideoFrames;
      info.total = q.totalVideoFrames;
      return { dropped: q.droppedVideoFrames, total: q.totalVideoFrames };
    } catch { return undefined; }
  }

  private on(type: string, fn: () => void): void {
    this.o.video.el.addEventListener(type, fn);
    this.listeners.push([type, fn]);
  }

  /** 停播与监听（不摘元素）. */
  private halt(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
    const el = this.o.video.el;
    try { (el as unknown as { cancelVideoFrameCallback?: (h: number) => void }).cancelVideoFrameCallback?.(this.rv); } catch { /* 无所谓 */ }
    this.rv = 0;
    for (const [t, f] of this.listeners) el.removeEventListener(t, f);
    this.listeners.length = 0;
    try { el.pause(); } catch { /* 无所谓 */ }
  }

  /** 撤视频：释放解码器、摘元素. 幂等. */
  dispose(): void {
    if (this.phase === 'disposed') return;
    this.halt();
    releaseBootVideo(this.o.video);
    this.box?.remove();
    this.box = null;
    this.phase = 'disposed';
  }
}

