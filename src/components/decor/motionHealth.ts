/* 动效的「帧耗时 p95 降级」（X12）：Ambience 在落雪 / 飞蝶期间采样相邻两帧的间隔，每 90 帧算一次 p95；
   p95 超过 50 ms（慢于约 20 fps）就把本次运行降为静态（只留静态雪点），并告诉外观设置显示一句话。
   这是个很小的外部 store；切换动效档或粒子设置会清掉降级，让它再试一次。 */

let degraded = false;
const subs = new Set<() => void>();

export const motionHealth = {
  get: () => degraded,
  set(v: boolean) {
    if (degraded === v) return;
    degraded = v;
    subs.forEach((f) => f());
  },
  subscribe(fn: () => void) {
    subs.add(fn);
    return () => { subs.delete(fn); };
  },
};

/** 第 q 分位数（0–1），不改动入参. */
export function percentile(values: readonly number[], q: number): number {
  if (values.length === 0) return 0;
  const a = [...values].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.max(0, Math.ceil(q * a.length) - 1));
  return a[i];
}

export const FRAME_P95_LIMIT_MS = 50;
export const FRAME_SAMPLE = 90;
