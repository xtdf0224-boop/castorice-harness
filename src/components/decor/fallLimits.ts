/* 落雪的时限（Ambience.tsx 用；单独成文件，纯函数，check-boot 直接测它）：
   等待满 FALL_FULL_MS 后在 FALL_FADE_MS 内逐渐停下；窗口失焦超过 BLUR_GRACE_MS 就停，回来再落一阵。 */
export const FALL_FULL_MS = 120_000;
export const FALL_FADE_MS = 20_000;
export const BLUR_GRACE_MS = 15_000;

/** 落雪强度 0–1：时限内为 1，之后线性降到 0. */
export function fallIntensity(waitedMs: number): number {
  return waitedMs <= FALL_FULL_MS ? 1 : Math.max(0, 1 - (waitedMs - FALL_FULL_MS) / FALL_FADE_MS);
}
