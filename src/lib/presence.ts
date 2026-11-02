/* 人在不在：上一次看到你是什么时候？（V0α · 「归来」的依据）
   - previousSeen / awayMs：上一次会话最后一次有人操作的时间（启动时固定）。
   - startPresence()：会话中你离开超过 returnAfterMin 分钟再回来，通知 persist.ts 把 AppState.lastSeen 设成你离开的那一刻。
   只记一个时间戳（localStorage，尽力而为），不记内容。被禁用存储时只是没有「归来」。
   V2 追加（施工图 §3.6b）：lastInputAt() / continuousMinutes(now) / continuousSince(now)——沿用同一组输入监听，不新挂；
   「连续使用」＝任意两次输入的间隔都 <20 分钟（R-CI I-16 口径）。原有 API 与 onReturn 行为不变。 */
const KEY = 'alight/last-seen';
/** 萤火的键：从萤火分出来的第一次启动沿用它的「最后看到」。 */
const LEGACY_KEY = 'firefly-harness/last-seen';

function read(): number {
  try { return Number(localStorage.getItem(KEY)) || Number(localStorage.getItem(LEGACY_KEY)) || 0; } catch { return 0; }
}
function write(at: number) {
  try { localStorage.setItem(KEY, String(at)); } catch { /* 忽略 */ }
}

const last = read();
/** 上一次会话最后一次有人操作的时间（0 = 第一次启动）。本次会话里固定不变。 */
export const previousSeen = last;
/** 距离上一次会话结束过了多久（毫秒；第一次启动为 0）。本次会话里固定不变。 */
export const awayMs = last ? Math.max(0, Date.now() - last) : 0;

/** 最近一次有人操作（鼠标、键盘、滚轮、触摸）的时间。 */
let activeAt = Date.now();
let dirty = true;
/** 活动事件可能一秒几十次，只在超过这个间隔时才更新时间戳。 */
const ACTIVE_STEP_MS = 2000;

function flush() {
  if (!dirty) return;
  dirty = false;
  write(activeAt);
}

write(activeAt);

/* ───────────── 连续使用（休息关照用） ───────────── */
/** 间隔小于它的输入算「连续使用」（R-CI I-16：空档 <20 分钟）。 */
export const CONTINUOUS_GAP_MS = 20 * 60_000;
let lastInput = activeAt;
let contStart = activeAt;

/** 记一次输入。间隔 ≥ CONTINUOUS_GAP_MS 就从这一刻起重新算「连续使用」。 */
export function recordInput(now: number = Date.now()): void {
  if (now - lastInput >= CONTINUOUS_GAP_MS) contStart = now;
  if (now > lastInput) lastInput = now;
}
/** 最近一次输入的时间（ms）。 */
export const lastInputAt = (): number => lastInput;
/** 此刻起往回算，已连续使用多少分钟（向下取整）；最近 20 分钟没有输入 = 没在用 = 0。 */
export function continuousMinutes(now: number = Date.now()): number {
  return now - lastInput >= CONTINUOUS_GAP_MS ? 0 : Math.max(0, Math.floor((now - contStart) / 60_000));
}
/** 这一段连续使用的起点；没在连续使用就是 now。 */
export const continuousSince = (now: number = Date.now()): number => (now - lastInput >= CONTINUOUS_GAP_MS ? now : contStart);
/** 测试用：把输入状态重置到某一刻（该刻算第一次输入）。 */
export function resetPresenceForTest(now: number): void { lastInput = now; contStart = now; }

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // 只在这一分钟里有过操作才写；窗口挂着没人动，不算「在」。（没有真正的 window 的测试环境里跳过.）
  window.setInterval(flush, 60_000);
  window.addEventListener('pagehide', flush);
}

let started = false;

/**
 * 开始盯着「离开又回来」：隔了至少 idleMin() 分钟没有操作、再有操作（或窗口重新可见）时，
 * 调用 onReturn(离开的那一刻)。idleMin 每次现取，这样设置里改了马上生效。
 */
export function startPresence(idleMin: () => number, onReturn: (leftAt: number) => void): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const touch = (now: number) => {
    recordInput(now);
    const gap = now - activeAt;
    if (gap >= Math.max(1, idleMin()) * 60_000) onReturn(activeAt);
    if (gap >= ACTIVE_STEP_MS) { activeAt = now; dirty = true; }
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove'] as const) {
    window.addEventListener(type, () => touch(Date.now()), { passive: true, capture: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') touch(Date.now());
    else flush();
  });
}
