/* 开屏与转场共用的「匀速节拍」。
   两种模式：
   · 调速器模式（默认的 comp 实现，new Pacer({ governor })）：每次刷新都推进一步（档位 divisor = 1），慢机器 / 独显由调速器（governor.ts）升到 2、4 档——节拍恒是刷新间隔的整数倍、间隔均匀；
     不再有「60 fps 封顶」。合成器上的 WAAPI 动画不走这里，永远按显示器刷新出画面。
   · 旧模式（legacy，new Pacer() 或 new Pacer(targetMs)）：渲染间隔取**刷新间隔的整数倍**中最接近 16.7 ms 的那个——
     240 Hz → 每 4 帧画一次（60 fps），144 Hz → 每 2 帧（72 fps），120 Hz → 每 2 帧（60 fps），60 Hz → 每帧。留在 ?bootimpl=legacy 后面做对拍。
   刷新间隔从 rAF 时间戳量出来（estimateRefresh / snapRefresh）。 */
import type { Governor } from './governor';

/** 旧模式的目标渲染间隔：60 fps（旧规则：独显持续 3D 负载会触发 ACPI 中断风暴，开屏的画布动画帧率封顶 60；现在只用于独显的保护档与 legacy）. */
export const TARGET_MS = 1000 / 60;
/** 还没测出刷新间隔时的最小间隔（原来的 14 ms 封顶；在 240 / 144 / 120 / 60 Hz 下恰好落在与正式节拍相同的那一帧上）. */
export const WARMUP_GAP_MS = 14;
/** 常见的刷新率；测得的间隔离其中一个在 6% 以内就吸附上去. */
const RATES = [360, 300, 240, 200, 180, 165, 155, 144, 120, 100, 90, 75, 72, 60, 50, 48, 30];
const SNAP = 0.06;
/** 单个 rAF 间隔有效的范围：短于它是同一帧里的重复回调，长于它是主线程卡住 / 页面被藏起来. */
const MIN_DELTA = 2.4;
const MAX_DELTA = 100;
/** 估计刷新间隔至少要这么多个有效间隔（节拍器自己边走边估时，三个就先用起来——热身那几帧越短越好）；滚动窗口保留多少. */
const MIN_SAMPLES = 6;
const WARMUP_SAMPLES = 3;
const WINDOW = 30;

/** 把测得的间隔吸附到最近的常见刷新率（6% 以内）；离得远的原样返回. */
export function snapRefresh(ms: number): number {
  let best = ms;
  let bd = SNAP;
  for (const hz of RATES) {
    const m = 1000 / hz;
    const d = Math.abs(ms - m) / m;
    if (d <= bd) { bd = d; best = m; }
  }
  return best;
}

/** 从一串 rAF 时间戳间隔估刷新间隔：丢掉不是单帧的（过短 / 过长），取较小的 60% 的中位数——
    慢帧只会让间隔变成刷新间隔的整数倍（变大），所以较小的那部分才是真的单帧. 样本不足返回 undefined. */
export function estimateRefresh(deltas: readonly number[], minSamples = MIN_SAMPLES): number | undefined {
  const d = deltas.filter((x) => x >= MIN_DELTA && x <= MAX_DELTA).sort((a, b) => a - b);
  if (d.length < minSamples) return undefined;
  const low = d.slice(0, Math.max(3, Math.ceil(d.length * 0.6)));
  const mid = low.length >> 1;
  const med = low.length % 2 ? low[mid] : (low[mid - 1] + low[mid]) / 2;
  return snapRefresh(med);
}

/** 渲染间隔是刷新间隔的几倍：n·refresh 最接近 target 的那个 n（并列取较小的，帧率高一点）. */
export function beatEvery(refreshMs: number, targetMs = TARGET_MS): number {
  if (!(refreshMs > 0)) return 1;
  let best = 1;
  let bd = Infinity;
  const max = Math.max(1, Math.ceil(targetMs / refreshMs) + 1);
  for (let n = 1; n <= max; n++) {
    const d = Math.abs(n * refreshMs - targetMs);
    if (d < bd - 0.05) { bd = d; best = n; }
  }
  return best;
}

/** 节拍的毫秒间隔 = 倍数 × 刷新间隔. */
export const beatMs = (refreshMs: number, targetMs = TARGET_MS) => beatEvery(refreshMs, targetMs) * refreshMs;

/** 开屏挂载时（遮罩下）先量一次刷新间隔：连看 frames 个 rAF，用 estimateRefresh / snapRefresh 估计，填 learned 并告诉调速器——这样开屏第一拍起 lockFloor 就是对的。
    窗口还藏着时 rAF 可能一帧都不来（合成器不出帧）：那就一直不 resolve（没人等它），开屏的第一批 rAF 自己会量到，锁定档在量到之前走时间门限（见 due）. */
export function measureRefresh(frames = 8, governor?: Governor): Promise<void> {
  return new Promise((res) => {
    if (typeof requestAnimationFrame !== 'function') { res(); return; }
    const ds: number[] = [];
    let prev = -1;
    const step = (now: number) => {
      if (prev >= 0) ds.push(now - prev);
      prev = now;
      if (ds.length < frames) { requestAnimationFrame(step); return; }
      const e = estimateRefresh(ds, WARMUP_SAMPLES);
      if (e !== undefined) { learned = e; governor?.setRefresh(e); }
      res();
    };
    requestAnimationFrame(step);
  });
}

/** 最近一次量到的刷新间隔：下一个节拍器一出生就有数，不必重新热身. 每个节拍器仍会用自己的滚动窗口更新它. */
let learned: number | undefined;
export const learnedRefresh = () => learned;
/** 仅测试：清掉记忆. */
export function resetLearnedRefresh(): void { learned = undefined; }

export interface PacerOptions {
  /** 调速器：给了就是调速器模式. */
  governor: Governor;
  /** 调速器升档时调（新档位）：转场里用它把合成器上的动画重建成阶梯. */
  onTier?: (divisor: number) => void;
}

/** 节拍器：每个 rAF 回调里问一句 due(now)——要不要在这一帧画。第一次回调（或久未调用后）总是 true. */
export class Pacer {
  private last = -Infinity;
  private prev = -1;
  private deltas: number[] = [];
  private est: number | undefined = learned;
  private readonly target: number;
  private readonly gov: Governor | undefined;
  private readonly onTier: ((divisor: number) => void) | undefined;

  /** new Pacer() / new Pacer(targetMs) = 旧模式；new Pacer({ governor }) = 调速器模式. */
  constructor(opt: number | PacerOptions = TARGET_MS) {
    if (typeof opt === 'number') { this.target = opt; this.gov = undefined; this.onTier = undefined; } else { this.target = TARGET_MS; this.gov = opt.governor; this.onTier = opt.onTier; }
  }

  /** 当前估计的刷新间隔（ms）；还没有数据时 undefined. */
  get refreshMs(): number | undefined { return this.est; }
  /** 渲染间隔是刷新间隔的几倍（还没测出来：0）. 调速器模式 = 当前档位. */
  get every(): number { return this.est ? (this.gov ? this.gov.divisor : beatEvery(this.est, this.target)) : 0; }
  /** 调速器模式下用的刷新间隔（本次见过的最高刷新率；没有调速器 = 当前估计）. */
  /** 调速器模式？ */
  get governed(): boolean { return !!this.gov; }

  /** 看一眼这个回调的时间戳，更新滚动窗口里的刷新间隔估计. */
  observe(now: number): void {
    if (this.prev >= 0) {
      this.deltas.push(now - this.prev);
      if (this.deltas.length > WINDOW) this.deltas.shift();
      const e = estimateRefresh(this.deltas, WARMUP_SAMPLES);
      if (e !== undefined) { this.est = e; learned = e; this.gov?.setRefresh(e); }
    }
    this.gov?.observeRaf(now);
    if (this.gov?.update(now)) this.onTier?.(this.gov.divisor);
    this.prev = now;
  }

  /** 一个画了的帧在主线程上花了多少毫秒（调速器据此判断这台机器画不画得动）. */
  cost(ms: number): void { this.gov?.observeCost(ms); }

  /** 这个 rAF 回调要不要画一帧？now = rAF 的时间戳. 门限取「节拍间隔 − 半个刷新间隔」，让时间戳的抖动不会把一帧挤到下一个节拍上. */
  due(now: number): boolean {
    this.observe(now);
    let gap: number;
    const r = this.gov?.refreshMs ?? this.est;          // 调速器记着本次见过的最高刷新率（画不动时 rAF 间隔被拉长，不能把它当刷新间隔）
    if (!r) gap = this.gov ? 0 : WARMUP_GAP_MS;
    else if (this.gov) gap = this.gov.divisor * r - r * 0.5;
    else gap = beatMs(r, this.target) - r * 0.5;
    // 锁定节拍而刷新间隔本次还没量到（开屏第一拍起 3 个 rAF 间隔之内）：按「目标节拍间隔的 90%」的时间门限出图——240 Hz 每两个刷新、120 / 60 Hz 每个刷新——
    // 不会前几拍每个刷新都画（240 fps）、量到之后又掉到 120.
    if (this.gov && this.gov.refreshMs === undefined) { if (this.gov.holding) gap = WARMUP_GAP_MS; else if (this.gov.lockHz) gap = (1000 / this.gov.lockHz) * 0.9; }
    if (now - this.last >= gap) { this.last = now; this.gov?.observeTick(now); return true; }
    return false;
  }

  /** 把「刚画过一帧」记在 now（同步画了第 0 帧之后，第一个 rAF 回调不必再画一次）. */
  mark(now: number): void { this.last = now; }
}
