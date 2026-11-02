/* 调速器：替代 pacer.ts 的「60 fps 封顶」。
   · 默认每次刷新都推进一步（divisor = 1）；独显（desktop.app.gpu().kind === 'discrete'，本机规则：独显持续 3D 负载会触发 ACPI 中断风暴）才把下限设成 refresh/60 取整（setDiscrete）——
     那是对独显的保护，不是通用上限。
   · 在线测量：每个「残余 JS 帧」记它在主线程上花的 CPU 时间，每个 rAF 记间隔（滚动窗口约 16 帧，p90）。
     p90 帧内 CPU > 0.5 × 刷新间隔，或 rAF 间隔 p90 > 1.5 × 刷新间隔 → 升一档（1 → 2 → 4）。
     rAF 间隔拉长而帧内 CPU 很小 = GPU 背压（集显画不过来，BeginMainFrame 被节流）：这时升档是对的——所有动画一起走阶梯，没有变化的刷新不产生合成帧，GPU 的活直接减半
     （实测夜 / 昼快速版：不升档时转场头 300 ms GPU 线程 100% 忙、出帧 60–100 fps；升到 2 档后 45% 忙、240 fps）。所以判据不看帧内 CPU；
     只是转场刚开始的头 QUIET_MS（起步那几帧的卡顿）不评估。窗口互不重叠、连续两次评估都超线才升（起步时一两帧的卡顿不算）；
     升档后至少保持 600 ms，之后也只升不降（本次开屏 / 转场内；reset() 才回到 1：开屏与转场的负载不同，转场开始时重新量）——档位来回跳比一直低一点更糟，节奏必须均匀。
   · 档位只管残余 JS 小层的写入节拍与阶梯通道的台阶长度；合成器上的 WAAPI 动画不受影响（它们按显示器刷新出画面）。
   · 锁定节拍（setLock，开屏用）：把「约 N 次/秒」当成目标——档位下限 lockFloor = floor(刷新率 / (0.95 × N))（240 Hz 锁 120 = 2；144 / 165 / 120 / 60 Hz = 1，每个刷新都画）。
     锁定下 rAF 间隔天然是 divisor × 刷新间隔（GPU 背压时 rAF 自己就按 8.3 ms 走），原来的升档判据（p90 rAF 间隔 > 1.5 × 刷新间隔）会把「正常的 120」当成「慢」，实测 5 轮里 4 轮升到 4 档（回到 60 次/秒）：
     所以 lockFloor > 1 时升档判据改看「相邻两次实际出图的间隔」（tick 间隔）p90 > 1.5 × divisor × 刷新间隔，CPU 判据的线也按 divisor 放宽（帧内 CPU 的预算是一个节拍，不是一个刷新）。
     relaxOnce：绽开段（GPU 吃紧）里被升档的，交班（绽开画布撤掉、重光栅的东西没了）时放回锁定档一次. */

export const MAX_DIVISOR = 4;
/** 仅测试 / 测量台：globalThis.__alightGovForce 把档位下限强行抬到这个值（消融实验用）. */
const forced = (): number => { const v = (globalThis as unknown as { __alightGovForce?: number }).__alightGovForce; return typeof v === 'number' && v >= 1 ? Math.min(MAX_DIVISOR, Math.round(v)) : 1; };
const WINDOW = 16;
export const HOLD_MS = 600;
export const CPU_FRAC = 0.5;
export const RAF_FRAC = 1.5;
/** 转场刚开始的头这么多毫秒不评估（样本丢掉）：起步的头几帧（创建动画、首次光栅）卡一下是起步本身的事，不是「这台机器画不动」——
    以前它会让头两个窗口都超线、转场一开始就被升到 2 档（整段转场的合成器动画都成了阶梯）. 真的 GPU 吃紧（持续的 rAF 间隔拉长）过了这段照样升档. */
export const QUIET_MS = 150;
/** 单个 rAF 间隔有效的范围：短于它是同一帧里的重复回调，长于它是主线程卡住 / 页面被藏起来. */
const MIN_IV = 1.2;
const MAX_IV = 100;

/** 滚动窗口里第 p 分位的值（最近邻）. */
export function quantile(xs: readonly number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
}

export interface GovernorState {
  divisor: number; floor: number; raised: number; log: Array<{ t: number; cpu: number; iv: number; to: number }>;
  /** 锁定的目标次数/秒（没有锁 = undefined）、锁定档位下限、relaxOnce 放回过没有、画过的残余 JS 帧个数与帧内 CPU 的 p50 / p95（ms）. */
  lock?: number; lockFloor: number; hold: boolean; relaxed: boolean; frames: number; costP50: number; costP95: number;
}

export class Governor {
  private cpu: number[] = [];
  private iv: number[] = [];
  private lastRaf = -1;
  private fresh = 0;               // 自上次评估以来的新样本数
  private strikes = 0;             // 连续超线的评估次数
  private div = 1;
  private discrete = false;
  private heldUntil = -Infinity;
  /** carryOver 之后的第一个 rAF 起 QUIET_MS 内不评估. */
  private quietPending = false;
  private quietUntil = -Infinity;
  private refresh: number | undefined;
  /** carryOver 带进来的刷新间隔（只给独显的保护档用，见 carryOver）；reset() 清掉. */
  private carried: number | undefined;
  /** 锁定的目标节拍（次/秒）；undefined = 不锁. */
  private lock: number | undefined;
  /** 场景临时要求的「旧节拍」（约 60 次/秒，discreteFloor）：昼的绽开段位图还没备好、仍走 DOM 蒙版路径时（每拍整屏三层重光栅，GPU 只撑得住 60 fps），锁定的 120 不能提前生效——
      否则 GPU 被重光栅压满、BeginMainFrame 被节流，tick 窗口（16 个 tick）要攒好几秒才升得了档. 画布备好 / 绽开结束时场景撤掉它. */
  private hold = false;
  /** 相邻两次实际出图的间隔（lockFloor > 1 时升档判据用）与上一次出图的时刻、自上次评估以来的新 tick 数. */
  private tickIv: number[] = [];
  private lastTick = -1;
  private freshTick = 0;
  private relaxed = false;
  /** 所有画过的残余 JS 帧的帧内 CPU（最近 600 个，state() 报 p50 / p95）. */
  private allCost: number[] = [];
  private nCost = 0;
  /** 升过几次档（报告用）. */
  raised = 0;
  /** 每次升档的依据（调试 / 测量台读）：时刻、p90 帧内 CPU、p90 rAF 间隔、升到几档. */
  private log: GovernorState['log'] = [];

  /** 当前档位：测出来的档位与独显保护档（refresh/60 取整）取大者. */
  get divisor(): number { return Math.max(this.div, this.floorDivisor, this.lockFloor, this.holdFloor, forced()); }
  get refreshMs(): number | undefined { return this.refresh; }

  /** 接下来 ms 毫秒不评估（样本丢掉；已有的安静期取更晚的那个）：开屏里已知会卡一下的时刻——预热（warm.ts）把探针放上去 / 撤下来时 Viz 要现编着色器、
      rAF 间隔拉长，但那时 GPU 只有 30–45% 忙（不是画不动），不该因此把整段开屏降到 2 档（实测夜开屏 5 轮里 5 轮在约 1.0–1.6 s 处被这样升档，之后一直 120 Hz）. */
  quietFor(ms: number): void {
    const until = (typeof performance !== 'undefined' ? performance.now() : 0) + ms;
    if (until > this.quietUntil) this.quietUntil = until;
  }

  /** 回到初始状态（新的一次开屏 / 转场）；显卡种类保留（不会变）. */
  reset(): void {
    this.cpu = []; this.iv = []; this.lastRaf = -1; this.fresh = 0; this.strikes = 0;
    this.div = 1; this.heldUntil = -Infinity; this.raised = 0; this.log = []; this.quietPending = false; this.quietUntil = -Infinity;
    this.refresh = undefined;       // 重新量（预览重播时显示器可能换了）
    this.carried = undefined;
    this.lock = undefined; this.hold = false; this.tickIv = []; this.lastTick = -1; this.freshTick = 0; this.relaxed = false;
    this.allCost = []; this.nCost = 0;
  }

  /** 见过的最小刷新间隔：此刻量到的与 carryOver 带来的取小者. */
  private knownRefresh(): number | undefined {
    if (this.refresh === undefined) return this.carried;
    return this.carried === undefined ? this.refresh : Math.min(this.refresh, this.carried);
  }

  /** 转场开始：开屏与转场的负载不同，档位重新量——但这台机器在开屏里已经慢到要升档的话，转场也不会快多少：从开屏最终档位的一半起步（至少 1 档），样本全部清掉. */
  carryOver(): void {
    const next = Math.max(1, this.div >> 1);
    const known = this.knownRefresh();
    this.reset();
    this.div = next;
    // 刷新间隔是显示器的事，开屏里量到的要带进转场——但只给独显的保护档用（floorDivisor），升档的判据（refresh）仍在转场里重新量：
    // 场景（nightScene / dayTrComp）的 prepareTransition 在 carryOver 之后、转场的第一个 rAF 之前就要读 floorDivisor，refresh 此刻是 undefined 的话它恒为 1，
    // 独显上转场里的合成器通道不会一开始就是 60 次/秒的阶梯（保护对转场从不生效），之后刷新间隔重新量到时也没有 retier 触发。
    // 不把 refresh 本身带进转场：升档的阈值（p90 rAF 间隔 > 1.5 × 刷新间隔）依赖它——集显在转场里被 GPU 背压拖到每两个刷新一帧时，重新量的刷新间隔会读成 120 Hz，
    // 阈值随之放宽、停在 2 档；带着开屏里的 240 Hz 进来，同样的背压会一路升到 4 档（60 次/秒的台阶），实测昼完整版 3 轮里 3 轮升到 4 档（原来 1 轮）。
    this.carried = known;
    this.quietPending = true;
    this.lock = undefined; this.hold = false;          // 锁定节拍只属于开屏；转场的行为与以前逐字一致（reset() 已清，这里再写一遍是为了读代码的人）
  }

  /** 锁定目标节拍（次/秒；开屏的昼用 120）。undefined = 不锁。刷新间隔已知时 lockFloor = floor(刷新率 / (0.95 × hz))：
      240 Hz 锁 120 → 2、360 → 3、480 → 4；180 及以下（含 144 / 165 / 120 / 60）→ 1，每个刷新都画（不低于约 120 的整数分频）. */
  setLock(hz?: number): void { this.lock = hz && hz > 0 ? hz : undefined; }
  get lockHz(): number | undefined { return this.lock; }
  /** 锁定带来的档位下限（没锁 / 刷新间隔未知 = 1）. */
  get lockFloor(): number {
    const r = this.refresh;
    if (!this.lock || !r) return 1;
    return Math.min(MAX_DIVISOR, Math.max(1, Math.floor(1000 / r / (this.lock * 0.95))));
  }

  /** 场景要求临时按旧节拍（约 60 次/秒）走 / 撤掉（见 hold）；reset() 清掉. */
  setHold(on: boolean): void {
    if (on === this.hold) return;
    this.hold = on;
    // 档位下限变了：之前攒的样本是另一个节拍下的，作废
    this.cpu = []; this.iv = []; this.tickIv = []; this.fresh = 0; this.freshTick = 0; this.strikes = 0;
  }
  get holding(): boolean { return this.hold; }
  /** hold 带来的档位下限（没 hold / 刷新间隔未知 = 1）. */
  get holdFloor(): number { const r = this.refresh; return this.hold && r ? discreteFloor(r) : 1; }

  /** 每次 Pacer.due() 返回 true（实际出一张图）时调：记相邻两次出图的间隔（lockFloor > 1 时升档判据用）. */
  observeTick(now: number): void {
    if (this.lastTick >= 0) {
      const d = now - this.lastTick;
      if (d >= MIN_IV && d <= MAX_IV) {
        this.tickIv.push(d);
        if (this.tickIv.length > WINDOW) this.tickIv.shift();
        this.freshTick++;
      } else if (d > MAX_IV) { this.tickIv = []; this.freshTick = 0; }
    }
    this.lastTick = now;
  }

  /** 仅开屏用，每次开屏只能一次：绽开段里被升了档（div > lockFloor），交班时放回锁定档（实际 divisor 回到 lockFloor），重新保持 HOLD_MS，样本清空. 返回有没有放. */
  relaxOnce(now: number): boolean {
    if (this.lock === undefined || this.relaxed) return false;
    if (this.div <= this.lockFloor) return false;       // 没被升过档（或升到的不比锁定档高）：不放，也不用掉这一次
    this.relaxed = true;
    this.div = 1;
    this.heldUntil = now + HOLD_MS;
    this.cpu = []; this.iv = []; this.fresh = 0; this.strikes = 0; this.tickIv = []; this.freshTick = 0;
    return true;
  }

  /** 正在用独显：档位下限抬到 refresh/60 取整（对「独显持续 3D 负载触发 ACPI 中断风暴」的保护）. */
  setDiscrete(on: boolean): void { this.discrete = on; }
  /** 档位的下限（独显：refresh/60 取整；其它 1）. */
  get floorDivisor(): number { const r = this.knownRefresh(); return this.discrete && r ? discreteFloor(r) : 1; }

  /** 刷新间隔（ms）——来自 pacer 对 rAF 时间戳的估计。只往小了更新（本次会话见过的最高刷新率）：机器画不动时 rAF 间隔会被拉长到 2 倍、4 倍，
      若把这个当成「刷新间隔」，慢就永远不算慢了；显示器的刷新率在一次开屏里是不会变的. */
  setRefresh(ms: number | undefined): void {
    if (ms === undefined) { this.refresh = undefined; return; }
    if (this.refresh === undefined || ms < this.refresh * 0.94) this.refresh = ms;
  }

  /** 每个 rAF 回调调一次（无论画不画）. */
  observeRaf(now: number): void {
    if (this.quietPending) { this.quietUntil = now + QUIET_MS; this.quietPending = false; }
    if (this.lastRaf >= 0) {
      const d = now - this.lastRaf;
      if (d >= MIN_IV && d <= MAX_IV) {
        this.iv.push(d);
        if (this.iv.length > WINDOW) this.iv.shift();
        this.fresh++;
      } else if (d > MAX_IV) { this.iv = []; this.cpu = []; this.fresh = 0; this.strikes = 0; }      // 页面被藏起来 / 主线程卡死过：旧样本作废
    }
    this.lastRaf = now;
  }

  /** 每个画了的残余 JS 帧：它在主线程上花的毫秒数. */
  observeCost(ms: number): void {
    this.cpu.push(ms);
    if (this.cpu.length > WINDOW) this.cpu.shift();
    this.nCost++;
    this.allCost.push(ms);
    if (this.allCost.length > 600) this.allCost.shift();
  }

  /** 评估一次（每个 rAF 回调里 observe 之后调）. 返回档位有没有变.
      窗口互不重叠：每攒满 WINDOW 个新的 rAF 间隔才评估一次，连续两次都超线才升档——也就是至少 2 × WINDOW 帧（240 Hz 下约 130 ms）持续偏慢；
      起步时一两帧的卡顿（创建动画、首次光栅）只会落进一个窗口里，不会升档. */
  update(now: number): boolean {
    const r = this.refresh;
    const tick = this.lockFloor > 1;                 // 锁定档下限 > 1：升档判据看 tick 间隔，窗口按 tick 数计
    if (now < this.quietUntil) { this.iv = []; this.cpu = []; this.fresh = 0; this.strikes = 0; this.tickIv = []; this.freshTick = 0; return false; }
    if (!r || this.divisor >= MAX_DIVISOR || (tick ? this.freshTick : this.fresh) < WINDOW) return false;
    this.fresh = 0;
    this.freshTick = 0;
    const cpuP = this.cpu.length >= 8 ? quantile(this.cpu, 0.9) : 0;
    const d = this.divisor;
    const ivP = tick ? quantile(this.tickIv, 0.9) : quantile(this.iv, 0.9);
    // 锁定档下一个节拍就是 d 个刷新，帧内 CPU 的预算是一个节拍的一半（不是一个刷新的一半）；rAF 间隔判据换成 tick 间隔：> 1.5 × d × 刷新间隔
    const over = tick ? (cpuP > CPU_FRAC * r * d || ivP > RAF_FRAC * r * d) : (cpuP > CPU_FRAC * r || ivP > RAF_FRAC * r);
    this.cpu = [];
    this.iv = [];
    this.tickIv = [];
    this.strikes = over ? this.strikes + 1 : 0;
    if (this.strikes < 2 || now < this.heldUntil) return false;
    this.div = Math.min(MAX_DIVISOR, d * 2);
    this.raised++;
    this.heldUntil = now + HOLD_MS;
    this.strikes = 0;
    this.log.push({ t: Math.round(now), cpu: +cpuP.toFixed(2), iv: +ivP.toFixed(2), to: this.div });
    return true;
  }

  state(): GovernorState {
    return { divisor: this.divisor, floor: this.floorDivisor, raised: this.raised, log: this.log.slice(), lock: this.lock, lockFloor: this.lockFloor, hold: this.hold, relaxed: this.relaxed,
      frames: this.nCost, costP50: +quantile(this.allCost, 0.5).toFixed(2), costP95: +quantile(this.allCost, 0.95).toFixed(2) };
  }
}

/** 独显的默认档：把 refreshMs 的节拍拉到不高于 60 fps 的整数倍. */
export const discreteFloor = (refreshMs: number): number => (refreshMs > 0 ? Math.max(1, Math.min(MAX_DIVISOR, Math.round(1000 / 60 / refreshMs))) : 1);

/** 全局共用一个：开屏时钟与转场时钟看到的是同一个机器（BootSplash 在每次挂载时 reset）. */
export const bootGovernor = new Governor();
