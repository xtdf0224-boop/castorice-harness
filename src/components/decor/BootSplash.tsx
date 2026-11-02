/* 开屏：夜「蝶落枝头」/ 昼「花海」（8 s 的手作动画，分镜见 design/boot/STORYBOARD.md；场景在 ./boot/）＋ 进入主界面的转场。
   · 它是**覆盖层，不是闸门**：下面的应用一直可以输入（没有 inert、没有焦点陷阱）；任意键 / 点击 / Esc 立刻开始转场，
     转场开始的同一刻焦点就交给首页输入框，按下的那个键照常进输入框。点击只用来关掉它（不会误触下面的按钮）。
     素材还没解码好时：启动那一次（窗口还没显示出来）遮罩从第一次挂载起就是不透明的底色（.boot__veil，与第 0 帧衔接），第 0 帧画好之后画面才在它上面出现，
     所以窗口一露出来看到的就是开屏，不会先看到主界面（electron/main.cjs 也不再在 ready-to-show 就显示窗口，而是等这里说「第 0 帧好了」：lib/firstFrame.ts）；
     窗口已经在屏幕上（外观设置里的「预览」重播）则沿用老办法——整层透明、不挡指针，就绪后整层淡入。
     开屏的时钟等窗口真的露出来才起跳（lib/windowVisibility.ts 的 whenWindowShown），用户看到的是第 0 秒；素材在 main.tsx 一开始就预加载（boot/preload.ts）。
   · 夜是默认，跟随外观设置里的主题；只在首次与升级后播放（bootPolicy.ts，设置里可改为每次启动或关闭），外观设置的「预览」能重播。
   · 动画结束后停在定格画面（「按任意键进入」）：背景不再重画，雪与涟漪以约 10 fps 轻轻动，累计 45 s 后彻底静止（player.ts）。
     默认（bootEnter = 'auto'）定格 3 s 后自己进入；设成 'click' 就一直停着等输入。
   · 离开 = 转场（boot/transition.ts，夜「栖于此」/ 昼「花海收进窗」）：蝶飞向左栏品牌标收翅停入，标题与署名缩进左栏，
     夜的壁纸平移到首页的取景（由左栏面板从屏外推入「推开」）再溶掉、昼的官方立绘收进右侧拱窗（原画背景在运动里淡成窗里的薰衣草底）；
     左栏条目在标题与蝶的「尾流」里浮现（等它们飞过再出现，不叠字），主栏玻璃 / 纸面、内容块、输入框依次浮现。
     开屏已定格 → 完整版 1.2 s；还没播完就被打断 → 快速版 0.7 s（还没浮现的标题不带；夜先对齐取景再溶解，昼也做压缩的收窗）。全程覆盖层 pointer-events:none，不挡输入。
   · 减少动态（系统偏好或设置）、窗口宽高比超出 1.15–2.10、机器画不动：直接显示定格画面，3 s 后（或按键）只做 ≤200 ms 的交叉淡化。
   · 昼可以用「预渲染视频」播背景层（设置里「昼开屏：实时 / 视频（试验）」，默认实时——2026-10-29 改回，beta.4 / beta.5 曾默认视频；boot/bootVideo.ts、videoRun.ts，施工图 docs/BOOT-VIDEO.md）：判决点在 scene.ready 之后（最多再等 VIDEO_WAIT_MS），
     能力 / 比例 / 减少动态 / 隐藏 / 加载任何一环不过，整次走实时（不做半视频）；播放中出问题（error、卡死、丢帧、比例越界）转实时接着跑，被打断（任意键 / 点击）用最近一次已呈现帧的媒体时间做 settle.
   · 页面隐藏（含缩到托盘，lib/windowVisibility.ts 会把它并进 visibilitychange）时暂停，恢复后接着播；转场时窗口隐藏 → 直接跳到终态。
   · 素材 4 s 内没就绪（或加载失败）就放弃：直接交还应用，不留一个空白遮罩。 */
import { version as APP_VERSION } from '../../../package.json';
import { useCallback, useEffect, useRef, useState } from 'react';
import { reportFirstFrame } from '../../lib/firstFrame';
import { useReducedMotion } from '../../lib/hooks';
import { isComposingEvent } from '../../lib/ime';
import { whenWindowShown, windowShown } from '../../lib/windowVisibility';
import { useApp } from '../../state/store';
import '../../styles/boot.css';
import { cx } from '../ui';
import { BootPlayer, SOFT_MS, TR_FAST, TR_FULL, aspectOk, beginTransition, createBootScene, trDuration, type BootScene, type BootTheme, type TransitionKind, type TransitionRun } from './boot';
import { bootGovernor } from './boot/governor';
import { measureRefresh } from './boot/pacer';
import { applyGpuKind } from './boot/gpuKind';
import { releaseBootPreload } from './boot/preload';
import { peekNow, warmBoot } from './boot/warm';
import { bootImpl, bootVideoRequested, governedFor } from './boot/bootImpl';
import { END_MEDIA, VIDEO_WAIT_MS, acquireBootVideo, bootVideoEligible, discardPreloadedBootVideo, releaseBootVideo, videoAspectOk, vidInfo, waitBootVideo, type BootVideo } from './boot/bootVideo';
import { VideoRun } from './boot/videoRun';
import { tp } from './boot/prof';
import { runClock } from './boot/transition';
import { markBootSeen } from './bootPolicy';
import { wallpaperFor } from './wallpapers';

const AUTO_AFTER_MS = 3000;      // 定格后自己进入（bootEnter='auto'，或减少动态 / 越界的定格）
const READY_TIMEOUT_MS = 4000;
/** 视频版的预热 / 预烘排期（r4：视频在播时做任何一件带 GPU 栅格的事都可能让视频停 33–60 ms，所以按下面的顺序排，数字是屏外真窗口里量出来的）：
    · prepare（解码 + 烘焙：立绘解码、光晕位图、底板预烘）：判决通过后**立刻**做（0 ms）：判决点 → 窗口真正露出来之间有约 0.5 s 的空档（窗口还藏着，合成器不出帧，主线程闲着）；
      原来延到 1.5 s（媒体时间约 0.9–1.0 s）做，撞在视频播放中，rVFC 出现 35–60 ms 的卡顿（关掉 prepare 卡顿消失、提前到 0 ms 也消失）；
    · 升层 / 探针（warmBoot：html.boot-warm 让整个文档重算样式 ≈ 11 ms 主线程，外加几块应用侧大层的 GPU 栅格）：窗口一露出来、**起播前**做（VIDEO_WARM_MS = 0）；试过以起播为起点延 0.9 / 2.0 s 做，视频就在那一刻停 33–46 ms；
    · 偷看应用（peekNow，转场着色器预编译，舞台临时变成渲染通道）：起播后 VIDEO_PEEK_MS（1 s）做——此时应用已画完（转场预热才全），而且视频全程最长间隔反而最短（见 warm.ts 的 peekNow）. */
const VIDEO_WARM_MS = 0;
const VIDEO_PEEK_MS = 1000;
const VIDEO_PREPARE_MS = 0;

/** 仅开发：?bootcap=night|day 让开屏进入「逐帧导出」模式（design/boot/tools/capture.mjs）：固定主题、不计时、不收输入，
    并暴露 window.__boot.seek(t)：t 在 0…duration 是开屏，其后是转场（再其后是转场结束后的首页）。生产构建里这个函数恒返回 null，整段被摘掉。 */
function captureTheme(): BootTheme | null {
  if (!import.meta.env.DEV) return null;
  try {
    const v = new URLSearchParams(window.location.search).get('bootcap');
    return v === 'night' || v === 'day' ? v : null;
  } catch { return null; }
}

interface SeekOpts {
  /** 离开开屏的时刻（默认 = duration，即定格后离开）；小于 duration = 被打断，走快速版. */
  leaveAt?: number;
  kind?: TransitionKind;
  /** 'bg' = .bd-text 隐藏 + 光尘不画 + 其余 fx 照画（视频母版：docs/BOOT-VIDEO.md §5.3）. 默认 'all'. */
  layers?: 'all' | 'bg' | 'vid';
}

function exposeCapture(scene: BootScene, root: () => HTMLElement | null) {
  const twoRAF = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  let run: { kind: TransitionKind; from: number; ctl: TransitionRun; ended: boolean } | null = null;
  const endRun = () => { if (!run) return; run.ctl.restore(); run = null; root()?.classList.remove('is-cap-gone'); };
  (window as unknown as { __boot?: unknown }).__boot = {
    duration: scene.duration,
    theme: scene.theme,
    ready: scene.ready,
    trFull: TR_FULL,
    trFast: TR_FAST,
    /** 昼：解码 + 烘焙（绽开画布、花海条、光晕、底板）；地址里带 ?bloomcv=1 才烘，对拍要先 await 它，否则测到的是 DOM 旧路径. */
    prepare: async () => { await scene.prepare?.(); },
    /** 转场进行中：开屏里在界面上方飞的东西（标题、蝶）此刻占的矩形（测试用）. */
    obstacles: (tr: number) => run?.ctl.obstacles(tr) ?? [],
    /** 昼：转场进行中盖在界面上方的窗（收窗中的立绘）此刻占的矩形（测试用）. */
    cover: (tr: number) => run?.ctl.cover(tr) ?? [],
    seek: async (t: number, opts: SeekOpts = {}) => {
      scene.setLayers?.(opts.layers ?? 'all');
      const from = opts.leaveAt ?? scene.duration;
      const kind: TransitionKind = opts.kind ?? (from >= scene.duration - 0.05 ? 'full' : 'fast');
      const dur = trDuration(kind);
      if (t <= from) {
        endRun();
        scene.render(t, false);
      } else {
        const tr = t - from;
        if (run && (run.kind !== kind || run.from !== from || (run.ended && tr < dur))) endRun();
        if (!run) { scene.render(from, false); run = { kind, from, ctl: beginTransition(scene, kind, from), ended: false }; }
        run.ctl.seek(Math.min(tr, dur));
        if (tr >= dur) {
          if (!run.ended) { run.ctl.end(); run.ended = true; }
          root()?.classList.add('is-cap-gone');
        }
      }
      await twoRAF();
    },
  };
}

/** 转场开始的这一刻把焦点交给首页的输入框（按下的那个键随后进它）；别处已经有焦点（用户点进了别的输入框）就不抢。 */
function focusHome() {
  const a = document.activeElement;
  if (a && a !== document.body && !a.closest('.boot')) return;
  document.querySelector<HTMLElement>('.return-view .pbox__input')?.focus({ preventScroll: true });
}

interface Leaving { kind: TransitionKind | 'soft'; from: number }

export function BootSplash({ onDone }: { onDone: () => void }) {
  const mode = useApp((s) => s.settings.mode);
  const bootEnter = useApp((s) => s.settings.bootEnter);
  const bootVideoSetting = useApp((s) => s.settings.bootVideo);
  const bootVideoRef = useRef(bootVideoSetting);
  bootVideoRef.current = bootVideoSetting;
  const reduced = useReducedMotion();
  const [cap] = useState(captureTheme);
  const theme: BootTheme = cap ?? (mode === 'day' ? 'day' : 'night');
  const credit = wallpaperFor(theme).credit.label;

  const [out, setOut] = useState<Leaving | null>(null);
  const [loaded, setLoaded] = useState(false);                       // 第一帧画好了：画面出现
  // 启动那一次（窗口还没显示出来）：遮罩从第一次挂载起就不透明；窗口已在屏幕上（预览重播）则整层透明再淡入
  const [fresh] = useState(() => !cap && !windowShown());
  const [veil, setVeil] = useState(fresh);                           // 底色垫层（画面淡入完就撤）
  const [instant, setInstant] = useState(false);                     // 第 0 帧画好时窗口还没露出来：没人看得见，画面不淡入、直接不透明
  const [settled, setSettled] = useState<'' | 'played' | 'still'>('');   // 已经停在定格画面
  const done = useRef(onDone);
  done.current = onDone;
  const host = useRef<HTMLDivElement>(null);
  const rootEl = useRef<HTMLDivElement>(null);
  const player = useRef<BootPlayer | null>(null);
  const sceneRef = useRef<BootScene | null>(null);
  const leaving = useRef<Leaving | null>(null);
  const stillRef = useRef(false);
  const vrunRef = useRef<VideoRun | null>(null);                  // 视频版的播放控制（没用视频 = null）
  const fbPending = useRef<Promise<void> | null>(null);           // 视频退路里 settle 还没完成：转场要等它
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;

  // 测量台读：调速器此刻的档位（perf-work/harness 的 recorder 在 dump 里带上它）
  useEffect(() => { (window as unknown as { __alightBootGov?: () => unknown }).__alightBootGov = () => ({ ...bootGovernor.state(), fast: (window as unknown as { __alightDayFast?: unknown }).__alightDayFast, video: (globalThis as unknown as { __alightBootVid?: unknown }).__alightBootVid }); }, []);
  // 调速器（boot/governor.ts）：每次开屏从头量；显卡种类用记下来的 / 问主进程「这次启动用的偏好」（独显才保留约 60 次/秒的保护档）
  useEffect(() => {
    if (cap) return;
    bootGovernor.reset();
    void measureRefresh(8, bootGovernor);        // 遮罩下先量刷新间隔：开屏第一拍起锁定档（240 Hz 锁 120 = 每两个刷新）就是对的；窗口还藏着、rAF 不来时不 resolve，由开屏自己的 rAF 量
    return applyGpuKind();
  }, [cap]);
  // 记下「这个版本播过了」：开屏中途崩了也不会下次又播。导出模式不记。
  useEffect(() => { if (!cap) markBootSeen(APP_VERSION); }, [cap]);
  // 开屏结束（或放弃）后放掉预加载的底图（解码后几十 MB）；预览重播时会重新加载
  useEffect(() => releaseBootPreload, []);
  // 画面淡入完（或直接不透明了）就撤掉底色垫层
  useEffect(() => {
    if (!loaded || !veil) return;
    const t = window.setTimeout(() => setVeil(false), instant ? 0 : 240);
    return () => window.clearTimeout(t);
  }, [loaded, veil, instant]);

  // 离开：时钟立刻停下（场景留在这一帧）→ 选转场的种类 → 同一刻把焦点交给首页输入框。
  const leave = useCallback(() => {
    if (leaving.current || cap) return;
    const p = player.current;
    p?.stop();
    const soft = !p || reducedRef.current || stillRef.current || p.slow;
    // 视频期间：from 取最近一次已呈现帧的媒体时间（不取墙钟，也不取 video.currentTime——它可能已超前于已呈现帧）；已经抵达最后一帧就当定格后离开
    let from = vrunRef.current?.interrupt() ?? (p ? p.time : 0);
    const atEnd = from >= END_MEDIA && !!vrunRef.current && !p?.finished;
    if (atEnd) from = sceneRef.current?.duration ?? from;
    const next: Leaving = { kind: soft ? 'soft' : p.finished || atEnd ? 'full' : 'fast', from };
    leaving.current = next;
    focusHome();
    setOut(next);
  }, [cap]);

  // 转场：量目标位置 → 场景与应用侧同一个时钟一帧帧推进 → 到点把应用交还。
  // 减少动态 / 被迫定格：CSS 交叉淡化（≤200 ms）。窗口隐藏着：直接到终态。
  useEffect(() => {
    if (!out) return;
    const scene = sceneRef.current;
    if (out.kind === 'soft' || !scene || document.hidden) {
      vrunRef.current?.dispose();
      const t = window.setTimeout(() => done.current(), out.kind === 'soft' && !document.hidden ? SOFT_MS + 20 : 0);
      return () => window.clearTimeout(t);
    }
    // 昼的开屏在绽开段是画布（scene.settle）：同一个任务里先换回 DOM 的状态，再等最多 2 个 rAF 让刚变可见的层栅格好，然后起转场（没有画布 / 已交班 = 不用等，同步起）
    let cleanup: (() => void) | undefined;
    let cancelled = false;
    const kind = out.kind;
    const start = () => {
      if (cancelled) return;
      let run: TransitionRun | undefined;
      try { run = beginTransition(scene, kind, out.from, { live: true }); } catch (e) { console.error('boot transition', e); done.current(); return; }
      const r = run;
      let over = false;
      const finish = () => { if (over) return; over = true; stop(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', finish); r.end(); done.current(); };
      const onVis = () => { if (document.hidden) finish(); };
      document.addEventListener('visibilitychange', onVis);
      window.addEventListener('resize', finish);
      // 节拍帧（场景的画布 / 样式、合成器画不了的几个动画）按匀速节拍推进；应用侧其余的 WAAPI 动画在第一个 rAF 对齐起点后自己跑
      const stop = runClock(r.dur, (tr) => r.step(tr), finish, { onStart: (t0) => r.play(t0), onTier: (d, ms) => r.retier(d, ms), theme: scene.theme });
      cleanup = () => { if (!over) { over = true; stop(); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('resize', finish); r.end(); } };
    };
    // 视频期间被打断：settle 把 DOM 背景层写成 from 时刻的样子并等栅格好，之后**同一个任务里**撤掉 <video> 再起转场（视频在 DOM 层下面，撤早了会露出底）
    const startNow = () => { vrunRef.current?.dispose(); start(); };
    const go = () => {
      if (cancelled) return;
      let wait: Promise<void> | undefined;
      try { wait = scene.settle?.(out.from); } catch (e) { console.error('boot settle', e); }
      if (wait) void wait.then(startNow); else startNow();
    };
    if (fbPending.current) void fbPending.current.then(go); else go();      // 视频退路的 settle 还没完成：等它（别在它的 2 个 rAF 里起转场）
    return () => { cancelled = true; cleanup?.(); };
  }, [out]);

  // 定格后自己进入：bootEnter = 'auto'，或这次是被迫定格（减少动态、窗口比例越界）
  useEffect(() => {
    if (!settled || cap || out) return;
    if (settled === 'played' && bootEnter !== 'auto') return;
    const t = window.setTimeout(leave, AUTO_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [settled, bootEnter, leave, cap, out]);

  // 任意键：只触发转场，不拦截——按下的键照常送到首页输入框。纯修饰键不算。
  useEffect(() => {
    if (cap) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta' || e.key === 'CapsLock') return;
      if (isComposingEvent(e)) return;     // 输入法在组合：回车/Esc 是它的，不算「任意键」
      leave();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [leave, cap]);

  // 场景：建好 → 素材就绪后排版、画第 0 帧、起时钟（或直接定格）
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    let resizeRaf = 0;
    let onVis: (() => void) | undefined;
    let onResize: (() => void) | undefined;
    let prepTimer = 0;
    let peekTimer = 0;
    const scene = createBootScene(theme, { host: el, base: import.meta.env.BASE_URL, version: APP_VERSION, credit, capture: !!cap });
    sceneRef.current = scene;
    const giveUp = () => { if (!dead) done.current(); };    // 素材没读出来：不挡应用
    const timeout = window.setTimeout(giveUp, READY_TIMEOUT_MS);
    // 昼开屏想用视频（设置 / 地址 / 测量台）而且此刻的窗口允许：现在就取（earlyBoot 预加载的那个，没有就现建）；判决点在 scene.ready 之后. 不想用就放掉 earlyBoot 预加载但没人要的
    const info = vidInfo(true);
    const vwant = !cap && !!scene.video && bootImpl() === 'comp' && bootVideoRequested(theme, bootVideoRef.current) && !reduced && !document.hidden && videoAspectOk(window.innerWidth, window.innerHeight);
    info.requested = vwant;
    let vsrc: BootVideo | null = vwant ? acquireBootVideo(import.meta.env.BASE_URL) : null;
    if (!vsrc) discardPreloadedBootVideo();
    const warmWanted = !cap && (governedFor(theme) || (theme === 'day' && bootImpl() === 'comp'));          // 夜与昼的合成器路径都要预热（昼只放几块几乎全透明的探针与应用侧入场目标的升层，开屏本身不多一层）
    const videoWanted = !!vsrc;
    let unwarm: (() => void) | undefined = warmWanted && !videoWanted ? warmBoot(el) : undefined;               // 视频版的预热等判决之后再排：用视频 = 起播时（见下），没用上 = 判决后马上排

    scene.ready.then(async () => {
      if (dead) return;
      window.clearTimeout(timeout);
      const fit = () => scene.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio);
      fit();
      if (cap) { exposeCapture(scene, () => rootEl.current); scene.render(0, false); setLoaded(true); return; }

      // 视频版的判决点（docs/BOOT-VIDEO.md §3.2）：scene.ready 之后最多再等 VIDEO_WAIT_MS；任何一环不过 = 整次走实时（不做半视频）
      let wait: { ok: boolean; reason?: string; waitMs: number } | undefined;
      if (vsrc && !reduced && !document.hidden && videoAspectOk(window.innerWidth, window.innerHeight)) {
        const w0 = window.innerWidth;
        const h0 = window.innerHeight;
        wait = await waitBootVideo(vsrc, VIDEO_WAIT_MS);
        if (dead) return;
        if (window.innerWidth !== w0 || window.innerHeight !== h0) fit();           // 等的时候窗口变了
      }
      let still = reduced || !aspectOk(window.innerWidth, window.innerHeight);
      stillRef.current = still;
      let vrun: VideoRun | undefined;
      if (vsrc) {
        const elig = bootVideoEligible({ theme, impl: bootImpl(), requested: true, w: window.innerWidth, h: window.innerHeight, reduced, hidden: document.hidden, capability: !!wait?.ok, loaded: !!wait?.ok });
        info.waitMs = wait?.waitMs;
        info.capTries = vsrc.capTries; info.cap = vsrc.capInfo;
        if (elig.ok && !still && scene.video) {
          vrun = new VideoRun({ scene, video: vsrc, host: el, onFallback });
          vrunRef.current = vrun;
          info.used = true;
          tp('video:decide');
        } else {
          info.used = false;
          info.reason = !elig.ok ? (wait && !wait.ok && wait.reason ? wait.reason : elig.reason) : 'still';
          releaseBootVideo(vsrc);            // 整次走实时：没有任何视频元素残留
          vsrc = null;
        }
        tp(info.used ? 'video:used' : `video:not-used:${info.reason}`);
      }
      if (warmWanted && videoWanted && !vrun) unwarm = warmBoot(el, 400);          // 想用视频却没用上：整次走实时，预热照旧（只是从判决点起算）
      if (vrun) {
        scene.video!.begin();                // 背景层由视频顶着：render(t) 只画文字 + 光尘（必须在第一次 render 与 prepare 之前）
        vrun.mount(window.innerWidth, window.innerHeight);
        prepTimer = window.setTimeout(() => { void scene.prepare?.().catch(() => undefined); }, (globalThis as unknown as { __alightVidPrepareMs?: number }).__alightVidPrepareMs ?? VIDEO_PREPARE_MS);     // 解码 + 烘焙（视频模式：立绘解码、光晕位图、底板），避开最开头的主线程忙时
      } else if (!still) void scene.prepare?.().catch(() => undefined);       // 解码 + 烘焙（昼：绽开画布、花海条、光晕、底板），任务切成小片，与起跳并行、不延迟起跳
      const p = new BootPlayer(scene, { onEnd: () => { if (!dead) setSettled(still ? 'still' : 'played'); }, onError: giveUp }, vrun?.media);
      player.current = p;
      if (still) p.jumpToEnd();
      else scene.render(0, false);
      setInstant(!windowShown());
      setLoaded(true);
      // 第 0 帧画好了：告诉主进程可以显示窗口；时钟等窗口真的露出来（用户看到的是第 0 秒）再起跳——窗口还藏着的时候合成器不出帧，起跳了也白白丢掉开头
      reportFirstFrame();
      // 视频与文字时钟同一刻起。视频版：升层 / 探针趁视频停在第 0 帧先做，起播后 VIDEO_PEEK_MS 再偷看应用
      if (!still) void whenWindowShown().then(() => {
        if (dead || player.current !== p || leaving.current) return;
        if (vrun && warmWanted) unwarm = warmBoot(el, (globalThis as unknown as { __alightVidWarmMs?: number }).__alightVidWarmMs ?? VIDEO_WARM_MS, true);      // 升层 / 探针趁视频还停在第 0 帧做
        p.start(0);
        vrun?.play();
        if (vrun && warmWanted) peekTimer = window.setTimeout(() => { if (!dead && !leaving.current) void peekNow(el); }, (globalThis as unknown as { __alightVidPeekMs?: number }).__alightVidPeekMs ?? VIDEO_PEEK_MS);
      });

      onVis = () => { p.setHidden(document.hidden); vrunRef.current?.setHidden(document.hidden); };
      document.addEventListener('visibilitychange', onVis);
      onResize = () => {
        if (resizeRaf) return;
        resizeRaf = requestAnimationFrame(() => {
          resizeRaf = 0;
          if (dead) return;
          fit();
          const vr = vrunRef.current;
          if (vr?.active) {
            // 视频期间：比例仍在视频覆盖范围内只改 <video> 的 CSS 尺寸；越界走退路（onFallback 里再按 aspectOk 决定定格还是接着实时）
            if (!videoAspectOk(window.innerWidth, window.innerHeight)) vr.fallback('resize');
            else { vr.layout(window.innerWidth, window.innerHeight); p.redraw(); }
            return;
          }
          if (!still && !p.finished && !aspectOk(window.innerWidth, window.innerHeight)) { still = true; stillRef.current = true; p.jumpToEnd(); }   // 还在播：比例越界就直接定格
          else p.redraw();                                                                                   // 已经定格：只按新尺寸重画
        });
      };
      window.addEventListener('resize', onResize);
    }).catch(giveUp);

    /** 视频退路（error、卡死、丢帧、比例越界、play 被拒）：<video> 已暂停，from = 最近一次已呈现帧的媒体时间。节拍先停住，scene.settle(from) 把 DOM 背景层写成 from 时刻的样子并等栅格好，
        同一个任务里撤视频，BootPlayer 改回墙钟从 from 接着播（或比例越界：直接定格）。首帧未出（from = 0）时无缝. */
    function onFallback(reason: string, from: number) {
      const p = player.current;
      const sc = sceneRef.current;
      if (dead || !p || !sc) return;
      p.suspend(from);
      let wait: Promise<void> | undefined;
      try { wait = sc.settle?.(from); } catch (e) { console.error('boot video fallback settle', reason, e); }
      const go = async () => {
        // 丢帧退路（视频没停）：DOM 层栅格好了再等媒体时间追上 from，同一个任务里撤视频、换手；其它退路视频早已暂停，presented() 就是 from
        const vr = vrunRef.current;
        let t = from;
        if (vr && !dead) { try { t = Math.max(from, await vr.holdAt(from)); } catch { /* 用 from */ } }
        if (fbPending.current === pend) fbPending.current = null;
        if (dead) return;
        vrunRef.current?.dispose();
        if (leaving.current) return;                          // 用户在这期间离开了：转场的 effect 已在等 fbPending，它自己起转场
        if (!aspectOk(window.innerWidth, window.innerHeight)) { stillRef.current = true; p.jumpToEnd(); }
        else p.resumeLive(t);
      };
      const pend: Promise<void> = (wait ?? Promise.resolve()).then(go);
      fbPending.current = pend;
    }

    return () => {
      dead = true;
      unwarm?.();
      window.clearTimeout(prepTimer);
      window.clearTimeout(peekTimer);
      vrunRef.current?.dispose();
      vrunRef.current = null;
      fbPending.current = null;
      releaseBootVideo(vsrc);
      window.clearTimeout(timeout);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      if (onVis) document.removeEventListener('visibilitychange', onVis);
      if (onResize) window.removeEventListener('resize', onResize);
      player.current?.dispose();
      player.current = null;
      sceneRef.current = null;
      scene.dispose();
    };
  }, [theme, reduced, cap, credit]);

  return (
    <div
      ref={rootEl}
      className={cx('boot', `boot--${theme}`, cap ? 'is-cap' : !loaded && 'is-loading', fresh && 'is-fresh', instant && 'is-instant', out && 'is-out', out && `is-out--${out.kind}`, settled && 'is-settled')}
      role="presentation"
      data-boot-theme={theme}
      // 点击只用来关掉它；素材还没就绪、开屏还没起来（不透明的底色挡着下面）时点击不算数，也不漏给下面的按钮
      onPointerDown={(e) => { if (cap) return; e.preventDefault(); e.stopPropagation(); if (player.current) leave(); }}
    >
      {veil && <div className="boot__veil" aria-hidden="true" />}
      <p className="sr-only" role="status">栖枝已就绪，按任意键进入。</p>
      <div className="boot__stage" ref={host} />
    </div>
  );
}
