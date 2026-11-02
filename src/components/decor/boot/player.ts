/* 开屏的时钟：按墙钟时间推进（不是按帧——掉帧不会拖长整幕），页面隐藏就停，定格后降到很低的帧率、不久就彻底停下。
   · 动画段的节拍由调速器管（governor.ts / pacer.ts）：默认每次刷新都推进一步，这台机器画不动就升到 1/2、1/4 档——节拍恒是刷新间隔的整数倍、间隔均匀（不再有 60 fps 封顶；
     独显才把下限设成 refresh/60，那是对「独显持续 3D 负载会触发 ACPI 中断风暴」的保护）。?bootimpl=legacy 时仍是旧的 60 fps 匀速封顶；
   · 动画结束后只剩 ambient（落雪、涟漪、蝶呼吸），≈10 fps 重绘，背景画布不再重画；
   · ambient 累计 AMBIENT_MAX_S 秒（只算页面可见的时间）后画最后一帧并停下，不再留任何 rAF / 定时器。 */
import type { BootScene } from './bootTypes';
import { governedFor, lockHzFor } from './bootImpl';
import { bootGovernor } from './governor';
import { Pacer } from './pacer';

/** 视频版（bootVideo.ts / videoRun.ts）：时钟换成媒体时钟——场景时间由视频已呈现的帧给出，视频卡住文字也停，不会跑到视频前面. */
export interface PlayerMedia {
  /** 这一拍预计上屏的时刻（performance.now() 的 ms）→ 场景时间（秒）. 抵达最后一帧之前恒小于 duration. */
  at(displayMs: number): number;
  /** 每个 rAF 回调里（出不出图都先调）：媒体时间到点了就预光栅. */
  tick?(t: number): void;
  /** 时间到头的这一拍（在 render(duration) 之前）：交接. 之后播放器改用墙钟接着走 ambient. */
  end?(): void;
}

const AMBIENT_MS = 100;           // 定格后 10 fps
const AMBIENT_MAX_S = 45;
/** 前 40 帧里 render() 的平均耗时超过它（≈ 低于 30 fps），说明这台机器画不动：直接跳到定格画面。 */
const SLOW_MEAN_MS = 30;

export class BootPlayer {
  private raf = 0;
  private timer = 0;
  private t0 = 0;
  private pausedAt = 0;
  private readonly pacer: Pacer;
  private lastRenderedT = 0;
  private ended = false;
  private frozen = false;
  private disposed = false;
  private paused = false;
  private costSum = 0;
  private costN = 0;
  private slowHit = false;
  private suspended = false;

  constructor(private readonly scene: BootScene, private readonly cb: { onEnd?: () => void; onError?: (e: unknown) => void } = {}, private media?: PlayerMedia) {
    this.pacer = governedFor(scene.theme) ? new Pacer({ governor: bootGovernor }) : new Pacer();
    // 锁定节拍只属于开屏（BootSplash 在建场景前 reset() 过调速器）；转场的 carryOver() 会清掉它
    if (this.pacer.governed) bootGovernor.setLock(lockHzFor(scene.theme));
  }

  /** 从 fromT 秒开始播（时钟立即起跳）. */
  start(fromT = 0) {
    this.t0 = performance.now() - fromT * 1000;
    this.paused = typeof document !== 'undefined' && document.hidden;
    if (this.paused) this.pausedAt = performance.now();
    else this.schedule();
  }

  /** 退路（视频转实时）期间先停住节拍（场景在换手）：不改变播放状态，lastRenderedT 记成已呈现的那一刻. */
  suspend(fromT: number) {
    if (this.disposed || this.frozen) return;
    this.suspended = true;
    this.cancel();
    this.lastRenderedT = fromT;
  }

  /** 退路完成：改回墙钟，从 fromT 接着走（场景已经换回完整的实时 DOM）. */
  resumeLive(fromT: number) {
    if (this.disposed || this.frozen) return;
    this.media = undefined;
    this.suspended = false;
    this.t0 = performance.now() - fromT * 1000;
    if (!this.paused) this.schedule();
  }

  /** 页面隐藏（含缩到托盘）时暂停：时钟停表，恢复后接着走. */
  setHidden(hidden: boolean) {
    if (this.disposed || this.frozen || hidden === this.paused) return;
    this.paused = hidden;
    if (hidden) {
      this.pausedAt = performance.now();
      this.cancel();
    } else {
      this.t0 += performance.now() - this.pausedAt;
      this.schedule();
    }
  }

  /** 当前时刻（秒）. */
  get time() { return this.lastRenderedT; }

  /** 动画已经结束（停在定格画面，可能还在 ambient）. */
  get finished() { return this.ended; }

  /** 机器画不动、被迫跳到了定格画面（离场时只做交叉淡化，不做转场）. */
  get slow() { return this.slowHit; }

  /** 尺寸变了：按当前时刻重画一帧（定格后背景也要重画）. */
  redraw() {
    if (this.disposed) return;
    try { this.scene.render(this.ended || this.frozen ? Math.max(this.scene.duration, this.lastRenderedT) : this.lastRenderedT, false); } catch (e) { this.cb.onError?.(e); }
  }

  /** 直接跳到定格画面并停下（减少动态 / 宽高比越界 / 机器画不动）. */
  jumpToEnd() {
    if (this.disposed) return;
    this.cancel();
    this.media = undefined;
    this.ended = true;
    this.frozen = true;
    this.lastRenderedT = this.scene.duration;
    try { this.scene.render(this.scene.duration, false); } catch (e) { this.cb.onError?.(e); }
    this.cb.onEnd?.();
  }

  /** 停下（淡出开始时）：画面留在最后一帧，不再调度任何东西. */
  stop() { this.frozen = true; this.cancel(); }

  dispose() { this.disposed = true; this.cancel(); }

  private cancel() {
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.timer) window.clearTimeout(this.timer);
    this.raf = 0;
    this.timer = 0;
  }

  private schedule() {
    if (this.disposed || this.frozen || this.paused || this.suspended || this.raf || this.timer) return;
    if (this.ended) this.timer = window.setTimeout(() => { this.timer = 0; this.raf = requestAnimationFrame(this.tick); }, AMBIENT_MS);
    else this.raf = requestAnimationFrame(this.tick);
  }

  private tick = (now: number) => {
    this.raf = 0;
    if (this.disposed || this.frozen || this.paused || this.suspended) return;
    const D = this.scene.duration;
    const m = this.media;
    const t = m ? m.at(now + (this.pacer.refreshMs ?? 0)) : (now - this.t0) / 1000;
    try {
      m?.tick?.(t);
      if (t < D) {
        if (this.pacer.due(now)) {
          const c0 = performance.now();
          this.lastRenderedT = t;
          this.scene.render(t, false);
          const cost = performance.now() - c0;
          this.pacer.cost(cost);
          this.costSum += cost;
          if (++this.costN === 40 && this.costSum / 40 > SLOW_MEAN_MS) { this.slowHit = true; this.jumpToEnd(); return; }
        }
      } else if (!this.ended) {
        this.ended = true;
        this.lastRenderedT = D;
        if (m) { this.media = undefined; this.t0 = now - D * 1000; m.end?.(); }      // 视频版：先交接（场景回到完整实时模式），再画最后一帧；ambient 从 D 起接着走墙钟
        this.scene.render(D, false);
        this.cb.onEnd?.();
      } else if (t - D > AMBIENT_MAX_S) {
        // 够久了：画最后一帧、停下。之后页面上没有任何动的东西，也没有任何定时器。
        this.frozen = true;
        this.lastRenderedT = t;
        this.scene.render(t, true);
        return;
      } else {
        this.lastRenderedT = t;
        this.scene.render(t, true);      // 背景画布不再重画；只动 fx（雪、涟漪、蝶呼吸）
      }
    } catch (e) {
      this.frozen = true;
      this.cb.onError?.(e);
      return;
    }
    this.schedule();
  };
}
