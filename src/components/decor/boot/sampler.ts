/* 采样器：把通道（channels.ts）变成 WAAPI 关键帧，并管一组动画的时钟。
   · nativeTrack：2–4 个关键帧 + 同一条 cubic-bezier——合成器自己算缓动，零采样误差；
   · polyTrack：自适应二分的折线（线性关键帧）：区间中点（及 1/4、3/4）偏离弦超过容限就对半分，时间表的拐点（knots）必取；
   · steppedTrack：慢机器的退路——每 divisor × 刷新间隔一个台阶（steps(1, jump-end)），起点对齐 t0，节拍是刷新间隔的整数倍、间隔均匀；
   · evalTrack：在 node 里求值一条轨道（check-boot 用它逐点对拍「关键帧 vs 纯函数」，不需要浏览器）；
   · ClockGroup：一批动画共用一个时钟——创建时暂停在 0，实时播放时第一个 rAF 把所有 startTime 对齐到同一个 t0 后放手（与应用侧入场的 Entrance.play 同口径），
     导出模式（__boot.seek）把同一批动画的 currentTime 逐帧设一遍。实时与导出共用这同一份采样. */
import { clamp, cubic } from './bootMath';
import type { Bezier4, Channel, CssProps, NativeChannel, PolyChannel } from './channels';
import { isStatic } from './channels';
import { tp } from './prof';

export interface TrackKey { offset: number; v: number[]; easing: string }
export interface Sample { tr: number; v: number[] }

export const bezierCss = (b: Bezier4): string => `cubic-bezier(${b[0]}, ${b[1]}, ${b[2]}, ${b[3]})`;
export const STEP_EASING = 'steps(1, jump-end)';
/** 重建动画（retier）每块最多占主线程的毫秒数. */
export const RETIER_SLICE_MS = 4;
/** 折线通道分段采样：每块最多占主线程的毫秒数（实时播放、有 Stager 时）. */
export const SAMPLE_SLICE_MS = 1.5;

/* ───────── 轨道 ───────── */

export function nativeTrack(ch: NativeChannel): TrackKey[] {
  const a = clamp(ch.span[0] / ch.dur);
  const b = clamp(ch.span[1] / ch.dur);
  const f: TrackKey[] = [];
  if (a > 0) f.push({ offset: 0, v: ch.from, easing: 'linear' });
  f.push({ offset: a, v: ch.from, easing: bezierCss(ch.bezier) });
  f.push({ offset: Math.max(a, b), v: ch.to, easing: 'linear' });
  if (b < 1) f.push({ offset: 1, v: ch.to, easing: 'linear' });
  return f;
}

/** 自适应折线采样（可分段）：每采完时间表里的一小段（maxSeg）让出一次——调用者（Stager 的任务）可以按预算分几次、在几个节拍帧里采完，不必一口气占主线程 8 ms.
    返回 [{tr, v}]（含两端与所有 knots）. safety：容限的安全系数（CSS 数值取整、浏览器端的插值误差留出余量）. */
export function* samplePolyGen(ch: PolyChannel, o: { safety?: number; maxSeg?: number; minSeg?: number } = {}): Generator<void, Sample[], void> {
  const safety = o.safety ?? 0.6;
  const maxSeg = o.maxSeg ?? 0.04;
  const minSeg = o.minSeg ?? ch.minSeg ?? 0.0012;
  const tol = ch.tol.map((t) => t * safety);
  const cache = new Map<number, number[]>();
  const f = (tr: number): number[] => { let v = cache.get(tr); if (!v) { v = ch.truth(tr); cache.set(tr, v); } return v; };
  const out: Sample[] = [];
  const bad = (a: number, b: number): boolean => {
    const fa = f(a);
    const fb = f(b);
    for (const q of [0.5, 0.25, 0.75]) {
      const t = a + (b - a) * q;
      const m = f(t);
      for (let i = 0; i < m.length; i++) if (Math.abs(m[i] - (fa[i] + (fb[i] - fa[i]) * q)) > tol[i]) return true;
    }
    return false;
  };
  const refine = (a: number, b: number, depth: number) => {
    if (b - a > minSeg * 2 && depth < 14 && bad(a, b)) { const m = (a + b) / 2; refine(a, m, depth + 1); out.push({ tr: m, v: f(m) }); refine(m, b, depth + 1); }
  };
  const knots = [...new Set(ch.knots.map((k) => clamp(k, 0, ch.dur)).concat([0, ch.dur]))].sort((a, b) => a - b);
  out.push({ tr: knots[0], v: f(knots[0]) });
  for (let i = 1; i < knots.length; i++) {
    const a0 = knots[i - 1];
    const b0 = knots[i];
    const n = Math.max(1, Math.ceil((b0 - a0) / maxSeg));
    for (let k = 0; k < n; k++) {
      const a = a0 + ((b0 - a0) * k) / n;
      const b = a0 + ((b0 - a0) * (k + 1)) / n;
      refine(a, b, 0);
      out.push({ tr: b, v: f(b) });
      yield;
    }
  }
  return out;
}

/** 一口气采完（node 里对拍、导出模式、没有 Stager 时用）. */
export function samplePoly(ch: PolyChannel, o: Parameters<typeof samplePolyGen>[1] = {}): Sample[] {
  const g = samplePolyGen(ch, o);
  let r = g.next();
  while (!r.done) r = g.next();
  return r.value;
}

export function polyTrack(ch: PolyChannel, o?: Parameters<typeof samplePoly>[1]): TrackKey[] {
  const s = samplePoly(ch, o);
  return s.map((p) => ({ offset: p.tr / ch.dur, v: p.v, easing: 'linear' }));
}

/** 阶梯轨道：每 stepSec 秒一个台阶（steps(1, jump-end)），值取台阶起点的真值；最后一个关键帧落在总长处. */
export function steppedTrack(ch: Channel, stepSec: number): TrackKey[] {
  const n = Math.max(1, Math.ceil(ch.dur / stepSec - 1e-9));
  const out: TrackKey[] = [];
  for (let k = 0; k < n; k++) out.push({ offset: (k * stepSec) / ch.dur, v: ch.truth(k * stepSec), easing: STEP_EASING });
  out.push({ offset: 1, v: ch.truth(ch.dur), easing: 'linear' });
  return out;
}

/** 一条通道此刻该用哪种轨道：divisor = 1（默认）原生 / 折线；> 1 阶梯（台阶 = divisor × 刷新间隔）. */
export function trackFor(ch: Channel, divisor = 1, refreshMs = 1000 / 60): TrackKey[] {
  if (divisor > 1) return steppedTrack(ch, (divisor * refreshMs) / 1000);
  return ch.kind === 'native' ? nativeTrack(ch) : polyTrack(ch);
}

export function toKeyframes(track: readonly TrackKey[], css: (v: number[]) => CssProps): Keyframe[] {
  return track.map((k) => ({ offset: k.offset, easing: k.easing, ...css(k.v) }));
}

/* ───────── 求值（node 里对拍用；语义与 WAAPI 一致）───────── */

const easingCache = new Map<string, (x: number) => number>();
function easingFn(e: string): (x: number) => number {
  let f = easingCache.get(e);
  if (f) return f;
  if (e === 'linear') f = (x) => x;
  else if (/^steps\(/.test(e)) {
    const n = Number(/steps\(\s*(\d+)/.exec(e)?.[1] ?? 1);
    f = (x) => (x >= 1 ? 1 : Math.floor(x * n) / n);
  } else {
    const m = /cubic-bezier\(([^)]+)\)/.exec(e);
    const q = (m ? m[1] : '0,0,1,1').split(',').map(Number);
    f = cubic(q[0], q[1], q[2], q[3]);
  }
  easingCache.set(e, f);
  return f;
}

/** u = tr / dur ∈ [0, 1]：重叠 / 相等的偏移取后一个（与 CSS 一致：在偏移处，后面的关键帧生效）. */
export function evalTrack(track: readonly TrackKey[], u: number): number[] {
  const x = clamp(u);
  let i = 0;
  while (i + 1 < track.length && track[i + 1].offset <= x) i++;
  const a = track[i];
  const b = track[i + 1];
  if (!b || x >= b.offset) return a.v.slice();
  const span = b.offset - a.offset;
  const p = easingFn(a.easing)(span > 0 ? (x - a.offset) / span : 1);
  return a.v.map((av, k) => av + (b.v[k] - av) * p);
}

/** 轨道相对真值的最大误差（逐分量），在 [0, dur] 上 n 点扫（含两端）. */
export function maxTrackError(ch: Channel, track: readonly TrackKey[], n = 2400): number[] {
  const err = ch.tol.map(() => 0);
  for (let i = 0; i <= n; i++) {
    const tr = (ch.dur * i) / n;
    const want = ch.truth(tr);
    const got = evalTrack(track, tr / ch.dur);
    for (let k = 0; k < want.length; k++) err[k] = Math.max(err[k], Math.abs(want[k] - got[k]));
  }
  return err;
}

/* ───────── 动画与时钟 ───────── */

/** 应用侧入场与场景共用的动画 id：探针与测试靠它数「转场里的动画」. */
export const TR_ANIM_ID = 'boot-tr';

/** 分档创建动画（实时播放才用）：创建一个 WAAPI 动画要几百微秒，七八十个堆在转场起步的同一个任务里会让起步卡十几毫秒。
    这里按「最晚什么时候必须存在」（deadline，转场第几秒）排队：起步只同步创建 deadline 很近的，其余由节拍帧里的 pump 每帧限额创建；
    快到 deadline（LEAD 之内）的无论预算都要建。导出模式（逐帧 seek）不用它：全部立刻建. */
export class Stager {
  private q: Array<{ at: number; run: () => unknown; notBefore: number; label: string }> = [];
  /** 创建要比第一次变化提前这么久（秒）. */
  static readonly LEAD = 0.03;
  /** deadline 过了这么久（秒）还没建的任务才不看预算（deadline = 第一次变化 − LEAD，所以此时离它真的开始变还有 LEAD − GRACE）：
      起点就要在的那一批（蝶的几条通道……）在头 GRACE 秒里按预算一帧几个地建，不是一个 15 ms 的大任务. */
  static readonly GRACE = 0.02;
  get pending(): number { return this.q.length; }
  /** at = 这个动画最晚要存在的时刻（秒）；run 里真正创建（返回 false = 还没做完，下次接着做：分段采样的长任务用）. 排队只是排队，什么时候建由 pump / flush 决定. */
  add(at: number, run: () => unknown, notBefore = -Infinity, label = ''): void {
    let i = this.q.length;
    while (i > 0 && this.q[i - 1].at > at) i--;
    this.q.splice(i, 0, { at, run, notBefore, label });
  }
  /** 节拍帧里调：按 deadline 顺序建；预算（budgetMs）里的随便建（含还没到点的：提前建），超过预算的只建「过期」的（deadline + GRACE ≤ tr）；每次至少建一个. */
  pump(tr: number, budgetMs = 1.2): void {
    const t0 = performance.now();
    let ran = 0;
    for (let i = 0; i < this.q.length;) {
      const j = this.q[i];
      if (j.notBefore > tr) { i++; continue; }                        // 还没到「才允许建」的时刻（建早了反而贵：比如溶解的 opacity 动画会让整块底板提前变成离屏渲染面）
      if (ran > 0 && j.at + Stager.GRACE > tr && performance.now() - t0 >= budgetMs) break;
      this.q.splice(i, 1);
      ran++;
      this.exec(j);
    }
  }
  /** 跑一个任务（测量台里记下它占了多久：tp 标签 job@deadline:毫秒:名字）. run 返回 false = 没做完，原位排回去等下一次. */
  private exec(j: { at: number; run: () => unknown; notBefore: number; label: string }): void {
    const c0 = performance.now();
    let more = false;
    try { more = j.run() === false; } catch { /* 这一个不行就算了 */ }
    tp(`job@${j.at.toFixed(3)}:${(performance.now() - c0).toFixed(2)}:${j.label}`);
    if (more) this.add(j.at, j.run, j.notBefore, j.label);
  }
  /** 立刻全建（导出 / 起步同步段里 deadline 已到的）. at ≤ upTo 的全建；缺省全部. */
  flush(upTo = Infinity): void {
    while (this.q.length && this.q[0].at <= upTo) {
      const j = this.q.shift()!;
      let guard = 0;
      for (;;) {                      // 分段的任务在这里一直做到做完
        const c0 = performance.now();
        let more = false;
        try { more = j.run() === false; } catch { /* 同上 */ }
        tp(`job@${j.at.toFixed(3)}:${(performance.now() - c0).toFixed(2)}:${j.label}`);
        if (!more || ++guard > 10000) break;
      }
    }
  }
  clear(): void { this.q.length = 0; }
}

/** 一批动画共用一个时钟（创建时暂停在 0）. */
export class ClockGroup {
  private items: Animation[] = [];
  /** 每个动画的来源（慢机器退路 retier 时按新档位重建）. */
  private entries: Array<{ el: Element; ch: Channel; pseudo?: string; a: Animation }> = [];
  private live = false;
  private t0 = 0;
  /** 挂在「应用元素」（覆盖层之外的首页元素，animate 的 app 选项）上的动画：转场结束时只撤这些（release），覆盖层里的留到卸载. */
  private apps = new Set<Animation>();
  constructor(readonly dur: number, private readonly stager?: Stager) {}

  get size(): number { return this.items.length; }
  get running(): boolean { return this.live; }
  add(a: Animation): void { this.items.push(a); }

  /** 在 el（或它的伪元素）上建一条通道的动画；静态的通道（from = to）不建. 有 stager 就按 deadline 排队（返回 null），否则立刻建并返回. */
  animate(el: Element | null | undefined, ch: Channel | null | undefined, o: { pseudo?: string; divisor?: number; refreshMs?: number; at?: number; sync?: boolean; late?: boolean; app?: boolean } = {}): Animation | null {
    if (!el || !ch || isStatic(ch)) return null;
    /** 折线通道在有 Stager 的实时播放里分段采样（每段约 SLICE_MS），采完才 animate()；其余一口气做完. */
    let gen: Generator<void, Sample[], void> | null = null;
    let samples: Sample[] | null = null;
    const make = (): Animation | null | false => {
      try {
        let kf: Keyframe[];
        if (ch.kind === 'poly' && this.stager && !o.sync && (o.divisor ?? 1) === 1) {
          if (!samples) {
            gen ??= samplePolyGen(ch);
            const c0 = performance.now();
            for (;;) {
              const r = gen.next();
              if (r.done) { samples = r.value; break; }
              if (performance.now() - c0 >= SAMPLE_SLICE_MS) return false;       // 这一块用完了：下一个节拍帧接着采
            }
          }
          kf = toKeyframes(samples.map((p) => ({ offset: p.tr / ch.dur, v: p.v, easing: 'linear' })), ch.css);
        } else kf = toKeyframes(trackFor(ch, o.divisor ?? 1, o.refreshMs), ch.css);
        const a = el.animate(kf, { duration: ch.dur * 1000, fill: 'both', easing: 'linear', ...(o.pseudo ? { pseudoElement: o.pseudo } : {}) });
        a.id = TR_ANIM_ID;
        a.pause();
        a.currentTime = 0;
        this.items.push(a);
        this.entries.push({ el, ch, pseudo: o.pseudo, a });
        if (o.app) this.apps.add(a);
        if (this.live) a.startTime = this.t0;           // 起步之后才建的：直接对齐到同一个起点，它自己从「此刻应有的进度」跑
        return a;
      } catch { return null; }          // 这个元素 / 这个浏览器不支持：它就直接是终态，不影响其余
    };
    const at = o.at ?? (ch.kind === 'native' ? ch.span[0] : (ch.start ?? 0));
    // 有 stager：一律排队（起步的同步段不建动画——元素此刻的静态样式就是 tr = 0 的状态；不是的，调用者先把内联样式设成 tr = 0 的值）；sync = 必须马上建
    if (this.stager && !o.sync) { this.stager.add(at - Stager.LEAD, make, o.late ? at - Stager.LEAD : undefined, `${ch.name}`); return null; }
    const a = make();
    return a === false ? null : a;
  }

  /** 实时：节拍帧——动画没能自己跑（play 失败）时才逐帧设. */
  step(tr: number): void { if (!this.live) this.seek(tr); }

  /** 导出模式：所有动画设到转场第 tr 秒. */
  seek(tr: number): void {
    const t = clamp(tr, 0, this.dur) * 1000;
    for (const a of this.items) a.currentTime = t;
  }

  /** 实时：把所有动画的起点对齐到时间轴时刻 t0（毫秒）后放手，它们自己跑. 返回 false = 这个环境不行（调用者退回逐帧 seek）. */
  play(t0: number): boolean {
    try {
      this.t0 = t0;
      for (const a of this.items) a.startTime = t0;
      this.live = true;
    } catch {
      this.live = false;
      for (const a of this.items) { try { a.pause(); } catch { /* 已经没了 */ } }
    }
    return this.live;
  }

  /** 慢机器的退路：调速器升档后，把已经建好的动画按新档位重建成阶梯（台阶 = divisor × 刷新间隔，起点对齐 t0），再撤掉旧的.
      只重建这个组自己的动画；还没建的（stager 里排队的）本来就按当时的档位建. 返回重建了几个. */
  private retierTok = 0;
  /** 按新档位重建一个动画（成功返回 true；这一个不行就留着原来的）. */
  private rebuild(e: { el: Element; ch: Channel; pseudo?: string; a: Animation }, divisor: number, refreshMs: number): boolean {
    try {
      const kf = toKeyframes(trackFor(e.ch, divisor, refreshMs), e.ch.css);
      const a = e.el.animate(kf, { duration: e.ch.dur * 1000, fill: 'both', easing: 'linear', ...(e.pseudo ? { pseudoElement: e.pseudo } : {}) });
      a.id = TR_ANIM_ID;
      a.pause();
      a.currentTime = 0;
      if (this.live) a.startTime = this.t0;
      const i = this.items.indexOf(e.a);
      if (i >= 0) this.items[i] = a; else this.items.push(a);
      if (this.apps.delete(e.a)) this.apps.add(a);
      try { e.a.cancel(); } catch { /* 已经没了 */ }
      e.a = a;
      return true;
    } catch { return false; }
  }

  /** 慢机器退路：按新档位重建所有动画。实时播放时分块做（每块约 RETIER_SLICE_MS，其余留给下一个 rAF）——一口气重建一百多条动画（每条要对通道重新采样成台阶）是一个 40–60 ms 的主线程任务，
      正好砸在转场中间；导出（非 live）一次做完. 返回要重建的个数. */
  retier(divisor: number, refreshMs: number): number {
    const tok = ++this.retierTok;
    const todo = this.entries.slice();
    if (!this.live) { let n = 0; for (const e of todo) if (this.rebuild(e, divisor, refreshMs)) n++; return n; }
    let i = 0;
    const step = () => {
      if (tok !== this.retierTok || !this.live) return;
      const t0 = performance.now();
      while (i < todo.length && performance.now() - t0 < RETIER_SLICE_MS) this.rebuild(todo[i++], divisor, refreshMs);
      if (i < todo.length) requestAnimationFrame(step);
    };
    step();
    return todo.length;
  }

  /** 转场自然结束、覆盖层随后（React 的下一个宏任务）才卸载：只撤挂在应用元素上的动画（它们取消后元素回到自己的样式 = 首页的终态）。
      覆盖层里的动画不能在这里撤：它们靠 fill: both 把覆盖层停在终态（透明 / 移出），一撤覆盖层就瞬间回到完整不透明的开屏画面，
      在卸载之前被画出一帧——整屏闪一下；它们随覆盖层卸载（元素被移除，动画随之消失），导出模式回退时由 end() 清掉. */
  release(): void {
    this.retierTok++;
    for (const a of this.apps) { try { a.cancel(); } catch { /* 已经没了 */ } }
    this.items = this.items.filter((a) => !this.apps.has(a));
    this.entries = this.entries.filter((e) => !this.apps.has(e.a));
    this.apps.clear();
  }

  /** 撤掉所有动画（元素回到自己的样式，不留 fill、不留内联样式）. */
  end(): void {
    this.retierTok++;
    for (const a of this.items) { try { a.cancel(); } catch { /* 已经没了 */ } }
    this.items.length = 0;
    this.entries.length = 0;
    this.apps.clear();
    this.live = false;
  }
}
