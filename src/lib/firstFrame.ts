/* 「页面的第一帧准备好了」——告诉主进程可以把窗口显示出来（electron/main.cjs 的 app:frame-ready）。
   窗口不再一到 ready-to-show 就露出来（那时开屏还没画好，用户会先看到主界面再看到开机动画）：
     · 要播开屏：开屏第 0 帧画好（BootSplash）；不播：主界面第一次提交（App）。
   只发一次；没有桌面桥（浏览器开发版）或旧壳没有这个方法时什么都不做（旧壳自己一到 ready-to-show 就显示了）. */
import { desktop } from './desktop';

let sent = false;

export function reportFirstFrame(): void {
  if (sent) return;
  sent = true;
  try { desktop?.app?.frameReady?.(); } catch { /* 主进程那边没有这个通道：窗口由它自己的超时显示 */ }
}

/** 仅测试：让 reportFirstFrame 可以再发一次. */
export function resetFirstFrame(): void { sent = false; }

/** 下一次 rAF 之后调 cb；但最多等 maxMs——窗口还没显示的时候合成器不出帧（隐藏窗口里一有画面变化 rAF 就掉到约 1 Hz），不能干等. */
export function afterFrame(cb: () => void, maxMs = 50): void {
  let done = false;
  const fire = () => { if (done) return; done = true; cb(); };
  try { requestAnimationFrame(fire); } catch { /* 没有 rAF：靠下面的计时 */ }
  window.setTimeout(fire, maxMs);
}
