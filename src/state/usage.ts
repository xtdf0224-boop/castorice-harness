/* 用量 L0 → AppState.usage（V0α · K14）。
   存储层（electron/store）按回合累计 task_usage（只有数字）；这里定时、并且在每次 recordUsage 之后，
   把 usageSummary() 写进 AppState.usage，额度条（QuotaBar）与归来简直接读它。
   live.ts 的接口：import { recordUsage } from '../lib/storeBridge'（回合结束时调用一次）。 */
import { onUsageChange, usageSummary } from '../lib/storeBridge';
import type { UsageSummary } from '../lib/types';
import { store } from './store';

const REFRESH_MS = 60_000;

let started = false;
let inflight: Promise<void> | undefined;

const same = (a?: UsageSummary, b?: UsageSummary) => JSON.stringify(a) === JSON.stringify(b);

/** 立刻刷新一次（合并同时发起的多次）。取不到汇总时保持原值。 */
export function refreshUsage(): Promise<void> {
  inflight ??= (async () => {
    try {
      const next = await usageSummary();
      if (next && !same(store.get().usage, next)) store.update((d) => { d.usage = next; });
    } catch { /* 存储不可用：额度条保持旧值 */ } finally {
      inflight = undefined;
    }
  })();
  return inflight;
}

/** 开始同步：先刷一次，之后每分钟一次（跨过零点「今日」会自己归零），页面重新可见时再刷一次，记了新用量马上刷。 */
export function startUsageSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void refreshUsage();
  window.setInterval(() => { if (document.visibilityState === 'visible') void refreshUsage(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refreshUsage(); });
  onUsageChange(() => { void refreshUsage(); });
}
