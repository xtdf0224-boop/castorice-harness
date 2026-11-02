/* 预热：开屏期间（html[data-boot="on"]）把转场里要动的层先升成合成层，第一个转场帧就不必再等一次整屏光栅 / 层提升
   （实测起步 150 ms 内最长的合成器出帧间隔 28–31 ms，大头是新升层的首次光栅）。
   · 场景的暗纱 / 颗粒（整屏的静态渐变层）：.boot__stage.is-warm（boot.css）；
   · 应用侧的入场目标（左栏、主栏玻璃、内容块、控制台条）：html.boot-warm（boot.css，只在 data-boot="on" 内生效，开屏结束随属性撤掉）。
   它们都在开屏底板的下面，看不见；延后一点（开屏起步的头几帧不要抢资源）再升。
   · 玻璃（backdrop-filter）与「带 opacity 的组」的渲染通道：开屏底板不透明时 Viz 把它下面的应用整个剔掉，这两种通道在整个开屏里一次都没跑过——转场里底板一开始溶解（夜完整版约 0.45 s、
     快速版约 0.4 s），它们第一次被画，Viz 要现编着色器 / 分配中间纹理：实测一个 23–31 ms 的渲染通道（快速版转场里出帧间隔 > 16.7 ms 的大头）。
     所以开屏播到一小半时，在底板上面放一小块（4 × 4 px、几乎全透明）带同样 backdrop-filter 与 opacity 组的东西，让着色器与通道先跑一遍，约 0.4 s 后撤掉. */
import { bootGovernor } from './governor';

/** 主界面已经给用户看过了（这次页面生命周期里 booting 变成过 false：App.tsx 调 noteAppShown）。之后再播的开屏是设置里的「预览」重播：应用里的着色器早在正常渲染时编过了，
    偷看（peekApp）只剩代价——它让 Viz 把开屏下面那个（设置页：七八块玻璃）整个画几帧，测量台里重播 0.87 s 处 3 轮 3 轮出现 90–115 ms 的 LoAF（不偷看：0 轮），所以重播不偷看. */
let appShown = false;
export function noteAppShown(): void { appShown = true; }

/** 预热窗口（探针 0.6 s + 偷看 5 帧 + 撤下来之后的余波）里调速器不评估的时长. */
export const WARM_QUIET_MS = 1500;
export function warmBoot(host: HTMLElement | null, delayMs = 900, noPeek = false): () => void {
  let on = false;
  let probe: HTMLElement | null = null;
  let dayProbe: (() => void) | null = null;
  let undoPeek: (() => void) | null = null;
  let t2 = 0;
  const t = window.setTimeout(() => {
    on = true;
    bootGovernor.quietFor(WARM_QUIET_MS);          // 探针放上去 / 撤下来（+ 偷看）时的那一两个卡顿帧不算「这台机器画不动」
    host?.classList.add('is-warm');
    document.documentElement.classList.add('boot-warm');
    const root = host?.closest<HTMLElement>('.boot') ?? null;
    if (root) {
      probe = document.createElement('div');
      probe.className = 'boot__warmglass';
      probe.setAttribute('aria-hidden', 'true');
      probe.innerHTML = '<i></i><i></i>';
      root.appendChild(probe);
      // 昼的转场多出来的几种渲染通道（clip-path:polygon 的合成器动画、带遮罩的持有者 / 图层、不透明度组里的模糊）：同样先用一小块几乎全透明的东西各跑一遍
      if (root.classList.contains('boot--day')) { dayProbe = warmDayProbes(root); if (host && !appShown && !noPeek) peekApp(host).then((undo) => { undoPeek = undo; }); }
      t2 = window.setTimeout(() => { probe?.remove(); probe = null; dayProbe?.(); dayProbe = null; }, 600);
    }
  }, delayMs);
  return () => {
    window.clearTimeout(t);
    window.clearTimeout(t2);
    probe?.remove();
    dayProbe?.();
    undoPeek?.();
    if (on) { host?.classList.remove('is-warm'); document.documentElement.classList.remove('boot-warm'); }
  };
}

/** 昼的转场用到、而开屏里从没出现过的几种合成器通道，各放一小块（48 px、整体 2% 不透明度）先跑一遍——第一次用时 Skia 要现编着色器，实测一次 70–140 ms 的渲染通道（出帧停 4–8 个刷新）：
    ① clip-path:polygon() 的合成器动画（窗的裁切）里带一个有遮罩的子层（立绘）；② overflow:hidden + 渐变遮罩 + 平移 / 不透明度动画的持有者，里面是反向平移的子层（斜坡 / 薄纱）；
    ③ 不透明度动画的组里一个 filter:blur 的元素（底板里的模糊底图）。返回撤掉它们的函数. */
export function warmDayProbes(root: HTMLElement): () => void {
  const box = document.createElement('div');
  box.className = 'boot__warmday';
  box.setAttribute('aria-hidden', 'true');
  box.innerHTML = `
    <div class="wd-clip"><i class="wd-mask"></i></div>
    <div class="wd-hold"><i class="wd-in"></i></div>
    <div class="wd-grp"><i class="wd-blur"></i></div>`;
  root.appendChild(box);
  const anims: Animation[] = [];
  try {
    const a = (sel: string, kf: Keyframe[]) => { const n = box.querySelector(sel); if (n) anims.push(n.animate(kf, { duration: 1200, iterations: Infinity, easing: 'linear' })); };
    a('.wd-clip', [{ clipPath: 'polygon(0px 0px, 48px 0px, 48px 48px, 0px 48px)' }, { clipPath: 'polygon(6px 0px, 40px 4px, 44px 40px, 0px 44px)' }, { clipPath: 'polygon(0px 0px, 48px 0px, 48px 48px, 0px 48px)' }]);
    a('.wd-mask', [{ transform: 'translate(0px, 0px) scale(1)' }, { transform: 'translate(6px, 2px) scale(0.9)' }, { transform: 'translate(0px, 0px) scale(1)' }]);
    a('.wd-hold', [{ transform: 'translateX(0px)', opacity: 1 }, { transform: 'translateX(8px)', opacity: 0.6 }, { transform: 'translateX(0px)', opacity: 1 }]);
    a('.wd-in', [{ transform: 'translateX(0px)' }, { transform: 'translateX(-8px)' }, { transform: 'translateX(0px)' }]);
    a('.wd-grp', [{ opacity: 1 }, { opacity: 0.5 }, { opacity: 1 }]);
  } catch { /* 这个环境不行：探针只是预热，没有也无妨 */ }
  return () => { for (const x of anims) { try { x.cancel(); } catch { /* 已经没了 */ } } box.remove(); };
}

/** 视频版：偷看（转场用的着色器预编译）单独排期，放在起播后约 1 s（BootSplash 的 VIDEO_PEEK_MS）。
    r4 实测（屏外真窗口、集显硬解、WGC 抓屏）：偷看期间开屏舞台是 99.8 % 不透明度的渲染通道，视频（3210 × 1530）要被画进中间纹理；
    · 跟 warmBoot 的定时器一起（挂载后 2.9 s ≈ 媒体时间 0.9–2.2 s，随测量台里挂载到起播的间隔漂移）：视频停 33–58 ms；
    · 起播前做（视频停在第 0 帧）：视频不卡，但这时应用还没画完，转场的着色器预热不全（day-fast 转场 p99 反而差一点），而且 2.2 s 处（蝶第一次出现 / 清晰立绘层栅格）仍有 29–37 ms 的停顿；
    · 起播后 1.0 s 做：视频全程最长间隔 20.8 ms（实时版 25–29），2.2 s 的停顿也一并消失（蝶 / 立绘层要用的渲染通道此刻已被舞台渲染通道编过）。所以选它.
    已经给用户看过主界面（设置里的「预览」重播）= 不偷看（见 noteAppShown）. maxMs 兜底（窗口没出帧、rAF 不来也不会一直挂着 is-peek）. */
export function peekNow(stage: HTMLElement, maxMs = 250): Promise<void> {
  if (appShown) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let undo: (() => void) | null = null;
    let finished = false;
    const fin = () => { if (finished) return; finished = true; window.clearTimeout(timer); undo?.(); resolve(); };
    const timer = window.setTimeout(fin, maxMs);
    const frames = peekFrames();
    void peekApp(stage).then((u) => { undo = u; if (finished) u(); });
    let n = 0;
    const step = () => { if (finished) return; if (++n >= frames + 1) fin(); else requestAnimationFrame(step); };
    requestAnimationFrame(step);
  });
}
const peekFrames = (): number => { const v = (globalThis as unknown as { __alightPeekFrames?: number }).__alightPeekFrames; return typeof v === 'number' && v >= 1 ? Math.min(12, Math.round(v)) : 5; };

/** 让 Viz 把开屏下面的应用画几帧——昼的转场起步时底板一让开，应用里的一大把渲染通道（玻璃的模糊、圆角 / 阴影 / 渐变的各种着色器组合）才第一次被画，
    GPU 线程现编约 20 个着色器、停 60–100 ms（实测转场起步 150 ms 内 GrShaderCache::store 约 20 次，FinishPaintRenderPass 97 ms）。
    开屏底板不透明，Viz 的遮挡剔除把下面的应用整个剔掉，小探针（见 warmDayProbes）覆盖不了应用里那么多种组合——所以让开屏的舞台（.boot__stage：底板 / 场景都在里面）暂时变成一个 99.8% 不透明度的渲染通道
    （不能再当遮挡物），应用被画 5 个合成帧（256 个色阶里最多差 0.5 级，看不出来），之后立刻还原. 开屏刚起步不久做（此时场景还没铺开），之后的转场起步就不必再现编了。
    返回撤销函数（开屏提前结束时用）. */
function peekApp(stage: HTMLElement): Promise<() => void> {
  return new Promise((resolve) => {
    let n = 0;
    let done = false;
    const frames = peekFrames();      // 测量台可改（消融）
    const off = () => { if (!done) { done = true; stage.classList.remove('is-peek'); } };
    try {
      stage.classList.add('is-peek');
      const step = () => { if (done) return; if (++n < frames) requestAnimationFrame(step); else off(); };
      requestAnimationFrame(step);
    } catch { off(); }
    resolve(off);
  });
}
