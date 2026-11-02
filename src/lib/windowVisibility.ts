/* 窗口被藏进托盘 / 最小化时，让页面知道自己「不可见」。

   主窗口为了让开屏视频、计时器在被遮住时不卡，把 backgroundThrottling 关了——副作用是 Chromium 也不再报告
   页面隐藏：document.visibilityState 恒为 'visible'，visibilitychange 不会触发，于是 Ambience 的 rAF、
   轮询、用量刷新在托盘里照跑（B6 的探针实测过）。

   主进程在 show / hide / minimize / restore 时发 app:visibility，这里把它并进 document.visibilityState 与
   document.hidden，并派发 visibilitychange——页面里原有的所有「页面隐藏即暂停」逻辑（hooks.usePageVisible、
   Ambience、presence、persist、usage、shell）不用改就生效。再给 <html> 打 data-window-hidden，CSS 动画也一并暂停。
   没有桌面桥（浏览器开发版）或没有 onVisibility（旧壳）时什么都不做。 */
import { desktop } from './desktop';

let started = false;
let shellHidden = false;
/** 窗口至少露出来过一次（主进程发过 visible = true）。主窗口现在要等页面说「第一帧好了」才显示（lib/firstFrame.ts），
 *  开屏的时钟要等窗口真的露出来再起跳，不然用户看到的已经是第 0.3 s 了. */
let shownOnce = false;
const shownWaiters = new Set<() => void>();

/** 窗口已经（至少一次）显示出来了？没有桌面桥（浏览器开发版）或旧壳没有 onVisibility：一直是 true. */
export function windowShown(): boolean {
  return !desktop?.app?.onVisibility || shownOnce;
}

/** 等窗口显示出来；最多等 timeoutMs（主进程自己 2.5 s 超时兜底显示，这里留够余量），到点也放行. */
export function whenWindowShown(timeoutMs = 3200): Promise<void> {
  if (windowShown()) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { window.clearTimeout(t); shownWaiters.delete(done); resolve(); };
    const t = window.setTimeout(done, timeoutMs);
    shownWaiters.add(done);
  });
}

/* 被盖住：窗口还显示着，可是她这块屏的前台是全屏程序（游戏、视频）或桌宠认得的游戏（桌宠没开时：切走满 5 秒），主进程发 app:covered
   （electron/main.cjs 的 announceCovered）。这里给 <html> 打 data-window-covered（base.css：CSS 动画暂停），再告诉订阅者
   （Ambience 停下落雪和蝶）。不碰 document.hidden：页面并没有被藏起来，轮询、计时、桌宠的大脑都照常走。
   为什么要停：被盖住的窗口照样按屏幕刷新率出帧，一块在呼吸的面板就会在核显上和全屏游戏抢合成，游戏多卡帧（design/pet/bench/jitter）. */
let covered = false;
const coveredSubs = new Set<() => void>();

export function windowCovered(): boolean {
  return covered;
}

export function subscribeWindowCovered(fn: () => void): () => void {
  coveredSubs.add(fn);
  return () => { coveredSubs.delete(fn); };
}

export function startWindowVisibility(): void {
  if (started || typeof document === 'undefined') return;
  const subscribe = desktop?.app?.onVisibility;
  if (!subscribe) return;
  started = true;

  desktop!.app!.onCovered?.((on: boolean) => {
    if (on === covered) return;
    covered = on;
    if (on) document.documentElement.dataset.windowCovered = '1'; else delete document.documentElement.dataset.windowCovered;
    for (const fn of [...coveredSubs]) fn();
  });

  const proto = Document.prototype;
  const nativeState = Object.getOwnPropertyDescriptor(proto, 'visibilityState')?.get;
  const nativeHidden = Object.getOwnPropertyDescriptor(proto, 'hidden')?.get;
  if (!nativeState || !nativeHidden) return;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (shellHidden ? 'hidden' : nativeState.call(document)) });
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => shellHidden || nativeHidden.call(document) });

  subscribe.call(desktop!.app, (visible: boolean) => {
    if (visible) { shownOnce = true; for (const w of [...shownWaiters]) w(); }
    const hidden = !visible;
    if (hidden === shellHidden) return;
    shellHidden = hidden;
    if (hidden) document.documentElement.dataset.windowHidden = '1'; else delete document.documentElement.dataset.windowHidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
}
