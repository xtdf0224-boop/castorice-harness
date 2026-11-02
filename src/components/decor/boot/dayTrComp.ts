/* 昼 · 转场的合成器路径（comp）：dayScene.prepareTransition 的新做法。
   legacy 每个节拍把窗的裁切（inset round）、软边遮罩、立绘变换、窗的轮廓（改 left/top/width/height/border-radius）、落影（两张画布）、底板的补集遮罩（三个整屏元素）、
   蝶（整张 SVG 的属性）、光尘（整屏画布）全写一遍——每个节拍整层重新光栅，240 Hz 下 GPU 画不过来。
   这里把它们都变成 dayComp.ts 里的通道（WAAPI，合成器按显示器刷新出画面），残余 JS 只剩：标题组（栖枝 / ALIGHT 的 FLIP、字距、字色）、品牌标的枝（SVG 描画）、光尘小画布。
   所有视觉状态仍是 tr 的纯函数（trState + 通道的 truth），__boot.seek 导出与实时播放共用同一批动画。 */
import { TAU, lerp } from './bootMath';
import { boxRect, lsEm, q1, rangeRect, revealBase, settleReveal, unionRect } from './bootDom';
import type { Rect, SceneTransition, TrOptions } from './bootTypes';
import { bootGovernor } from './governor';
import { learnedRefresh } from './pacer';
import { ClockGroup } from './sampler';
import type { Channel } from './channels';
import { tp } from './prof';
import { CORNER_BOX, BAR_LEN, DAY_BF_SPAN, HEM_H, OUTLINE_PURPLE, OUTLINE_RING, VEIL_W, cornerArcs, dayBfChannels, dayChannels, dayCommonChannels, dayTitleChannels, type DayChannels, type OutlinePieces } from './dayComp';
import { DC, PLATE_FILL_RGB, WALL_RGB, WIN_EDGE_SOFT } from './dayConst';
import { ARCH_BOTTOM_RADIUS, DAY_EN_COLOR, DAY_TITLE_COLOR, FIG_STAGE, archClip, archClipRect, artFit, bfBox, bfFlight, brandGoal, createTwigFx, daySegs, dustDots, flightPath, flipAt, flipCss, flipRectAt, flipTo, parseRgb, stageToScreen, tintColor, titleGroupAt, trState, twigFootScreen, twigOpen, type BfPose, type Flip, type TitleGroup, type TwigFx } from './transition';
import { trDuration } from './trCore';

export interface DayTrEls {
  ch: HTMLElement[];
  enSpan: HTMLElement;
  enLines: HTMLElement[];
  banner: HTMLElement;
  enter: HTMLElement;
  skip: HTMLElement;
  ver: HTMLElement;
  credit: HTMLElement;
  world: HTMLElement;
  bloom: HTMLElement;
  near1: HTMLElement;
  near2: HTMLElement;
  snow: HTMLElement;
  art: HTMLImageElement;
  bgd: HTMLElement;
  bf: SVGElement;
  bfwrap: HTMLElement;
  bfzoom: HTMLElement;
}

export interface DayBfState { x: number; y: number; rot: number; sc: number; flap: number; pose: number; alpha: number }

export interface DayTrCtx {
  host: HTMLElement;
  fx: HTMLCanvasElement;
  el: DayTrEls;
  /** 光尘的光晕精灵. */
  dayGlow: HTMLCanvasElement;
  k: number;
  W: number;
  H: number;
  R: number;
  /** 开屏绽开结束的时刻（之后才有窗）. */
  bloomEnd: number;
  /** 离开时镜头（世界层）的缩放. */
  z0: (from: number) => number;
  bfDay: (t: number) => DayBfState | null;
  figUrl: string;
  flowersUrl: string;
  /** 烘焙好的底板位图（没有就现烘一张）. */
  getBake: () => HTMLCanvasElement;
  /** 开屏第 t 秒的完整一帧（dispose 里把场景复原到离开时的样子）. */
  renderScene: (t: number) => void;
}

const div = (cls: string, css = '', parent?: Element | null): HTMLDivElement => { const d = document.createElement('div'); d.className = cls; if (css) d.style.cssText = css; if (parent) parent.appendChild(d); return d; };

export function prepareDayTransitionComp(c: DayTrCtx, o: TrOptions): SceneTransition {
  tp('day:prepare');
  const { kind, from, anchors } = o;
  const { host, el, k, W, H, R, fx } = c;
  const S = daySegs(kind);
  const dur = trDuration(kind);
  const u = 1 / k;
  const body = q1(host, '.boot__ph');
  const plate = q1(host, '.boot__plate');
  const glowEl = q1(host, '.s0-glow');
  const h1 = q1(host, '.s0-left h1');
  host.classList.add('is-trc');

  // ── 立绘收进拱窗：花海绽满之后、拱窗在场时；否则整个 bloom 随底板一起溶掉 ──
  const fit = from >= c.bloomEnd && anchors.arch && anchors.fig ? artFit(k, anchors.fig) : undefined;
  const arch = anchors.arch;
  const boxW = Math.max(1600, W / k);
  const stageArch: Rect | undefined = arch ? { x: arch.x / k, y: arch.y / k, w: arch.w / k, h: arch.h / k } : undefined;
  const z0 = c.z0(from);
  el.art.style.transformOrigin = '0 0';
  const withWin = !!(fit && stageArch);

  // ── 蝶 ──
  const b0 = c.bfDay(from);
  const hasBf = !!b0 && b0.alpha > 0.2 && !!anchors.mark;
  let start: BfPose | undefined;
  let goal: ReturnType<typeof brandGoal> | undefined;
  let path: ReturnType<typeof flightPath> | undefined;
  if (hasBf && b0 && anchors.mark) {
    const [ax, ay] = DC.A;
    start = { x: k * (ax + z0 * (b0.x - ax)), y: k * (ay + z0 * (b0.y - ay)), w: DAY_BF_SPAN * b0.sc * k * z0, rot: b0.rot, flap: b0.flap, alpha: b0.alpha };
    goal = brandGoal(anchors.mark);
    path = flightPath([start.x, start.y], [goal.x, goal.y], 1);
    el.bfzoom.style.transform = 'none';
  }
  const fold0 = b0 ? b0.pose : 0;
  // 原来的 SVG 蝶退场：转场里的蝶是下面那个合成器上的小组
  el.bf.setAttribute('opacity', '0');
  el.bfwrap.style.display = 'none';

  // ── 枝（品牌标那根细枝的分身；从蝶的落脚点往两头长）──
  let twigFx: TwigFx | undefined;
  if (hasBf && anchors.mark && start && goal && path) twigFx = createTwigFx(host, anchors.mark, { stroke: '#4a2d68', wMain: 1.7, wSide: 1.2, open: twigOpen(start, goal, path, twigFootScreen(anchors.mark)) });

  // ── 标题与署名（FLIP；舞台缩放 k 要从平移里除掉）──
  const shown = (n: HTMLElement) => parseFloat(n.style.opacity || '0') > 0.5;
  const chBase = el.ch.map(revealBase);
  const enBase = revealBase(el.enSpan);
  const crBase = parseFloat(el.credit.style.opacity || '0') || 0;
  let fh1: Flip | undefined;
  let fen: Flip | undefined;
  const lsH1 = lsEm(h1);
  const lsEn = lsEm(el.enSpan);
  const h1Box = boxRect(h1);
  const h1Src = unionRect(el.ch.map(rangeRect));
  const enBox = boxRect(el.enSpan);
  const enSrc = rangeRect(el.enSpan);
  if (anchors.name && shown(el.ch[0])) fh1 = flipTo(h1Box, h1Src, anchors.name);
  if (anchors.sub && shown(el.enSpan)) fen = flipTo(enBox, enSrc, anchors.sub);
  const grpSrc: TitleGroup | undefined = fh1 && fen && anchors.name && anchors.sub ? { h1Box, h1Src, h1Dst: anchors.name, enSrc, enDst: anchors.sub } : undefined;
  const nameRgb = parseRgb(anchors.nameColor, [42, 27, 64]);
  const subRgb = parseRgb(anchors.subColor, [61, 39, 96]);
  h1.style.transformOrigin = '0 0';
  el.enSpan.style.transformOrigin = '0 0';
  tp('day:measured');

  const fades: Array<[HTMLElement | SVGElement, number]> = [   // [元素, 起始不透明度]：随场景淡出
    [q1(host, '.s0-twig'), 1],
    [q1(host, '.s0-twc'), 1],
    [el.near1, parseFloat(el.near1.style.opacity || '1')],
    [el.near2, 1],
    [el.ver, parseFloat(el.ver.style.opacity || '0')],
    ...el.enLines.map((n): [HTMLElement, number] => [n, 1]),
  ];
  const textFades: Array<[HTMLElement, number]> = [
    [el.banner, 1],
    [q1(host, '.s0-epi'), 1],
    [el.enter, parseFloat(el.enter.style.opacity || '1')],
    [el.skip, parseFloat(el.skip.style.opacity || '0')],
  ];

  const common = dayCommonChannels(kind);
  const group = new ClockGroup(dur, o.stager);
  const opt = { divisor: bootGovernor.floorDivisor, refreshMs: learnedRefresh() };
  /** 折线通道整条是常数（比如蝶还在飞、足的不透明度恒为 0）：不建动画（「没有可见变化」的动画合成器画不了），把常数直接写成内联样式. */
  const constant = (ch: Channel): boolean => {
    if (ch.kind === 'native') return false;
    const v0 = ch.truth(0);
    for (let i = 1; i <= 48; i++) { const v = ch.truth((ch.dur * i) / 48); for (let j = 0; j < v.length; j++) if (Math.abs(v[j] - v0[j]) > ch.tol[j] * 0.25) return false; }
    return true;
  };
  const anim = (target: Element | null | undefined, ch: Channel | null | undefined, extra: { late?: boolean; at?: number; sync?: boolean } = {}) => {
    if (target && ch && constant(ch)) { const st = (target as HTMLElement).style; for (const [kk, vv] of Object.entries(ch.css(ch.truth(0)))) st.setProperty(kk.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), vv); return null; }
    return group.animate(target, ch, { ...opt, ...extra });
  };
  // 场景淡出：枝 / 雪 / 近景 / 版本号 / 横线 / 前景画布（E.ease）
  anim(fx, common.scene);
  for (const [n, base] of fades) anim(n, common.fade('scene', base));
  // 落雪：30 个小点各自淡出（整个 .bd-snow 容器是满屏大的层，给它做不透明度动画要一块满屏的渲染面——实测这一项让出帧率掉 29%）
  for (const d of Array.from(el.snow.children) as HTMLElement[]) anim(d, common.fade('scene', parseFloat(d.style.opacity || '0')));
  for (const [n, base] of textFades) anim(n, common.fade('textOut', base));
  anim(el.credit, common.fade('ambient', crBase));
  if (!fh1) el.ch.forEach((n, i) => anim(n, common.fade('scene', chBase[i].op)));
  if (!fen) anim(el.enSpan, common.fade('scene', enBase.op));
  tp('day:a-fades');

  /** 以下三个只在「窗」流程里有. */
  const created: Array<Element> = [];
  let figEl: HTMLImageElement | undefined;
  let ch: DayChannels | undefined;
  const mainLeft = anchors.main ? anchors.main.x : undefined;
  let stripEl: HTMLElement | undefined;
  let rampEl: HTMLElement | undefined;
  let veilEl: HTMLElement | undefined;
  let corners: { tl: HTMLCanvasElement; tr: HTMLCanvasElement; bl: HTMLCanvasElement; br: HTMLCanvasElement; rtAt: (tr: number) => number; rbAt: (tr: number) => number; aLAt: (tr: number) => number; u: number; Rb: number; last: number; lastA: number; lastB: number } | undefined;
  const hidden: HTMLElement[] = [];

  if (withWin && fit && stageArch) {
    /** 晚建：起步的头几帧只建窗 / 立绘 / 主体底板；斜坡、薄纱、窗里的临时件、轮廓、落影的 DOM 与动画按它们第一次看得见的时刻（at，转场第几秒）由 Stager 在节拍帧里建
        （导出模式没有 Stager：立刻建）。晚建的动画一律 sync（已经在 Stager 的任务里了，不要再排队：实测把它们改成排队、与 DOM 错开几帧，昼快速版转场头 300 ms 里画布件（JS 每个节拍往里画）的 GPU 画布命令从 37 ms 涨到 260 ms）。
        大任务（轮廓）拆成几个任务，每个任务里 DOM 与它自己的动画一起建. */
    const late = (at: number, fn: () => void, label = '') => { if (o.stager) o.stager.add(at, fn, -Infinity, label); else fn(); };
    const animL = (target: Element | null | undefined, chn: Channel | null | undefined, extra: { late?: boolean; at?: number } = {}) => anim(target, chn, { ...extra, sync: true });
    // 人物分身：figure-official 的抠图，叠在原画里同一个人的位置，随原画同一个变换一起走
    figEl = document.createElement('img');
    figEl.className = 'boot__fig';
    figEl.alt = '';
    figEl.draggable = false;
    figEl.src = c.figUrl;
    figEl.style.cssText = `left:${FIG_STAGE.x.toFixed(2)}px;top:${FIG_STAGE.y.toFixed(2)}px;width:${FIG_STAGE.w.toFixed(2)}px;transform-origin:${(470 - FIG_STAGE.x).toFixed(2)}px ${(-62 - FIG_STAGE.y).toFixed(2)}px;opacity:0`;
    el.art.after(figEl);
    created.push(figEl);

    const flwH = 0.17 * stageArch.h;
    const flwX = stageArch.x + (stageArch.w - flwH * (1280 / 155)) / 2;
    const chw = dayChannels({ kind, k, W, boxW, stageArch, fit, z0, mainLeft, flwH });
    ch = chw;
    tp('day:channels');
    const hh = stageArch.h;
    const y0 = stageArch.y;
    const Rb = Math.min(window.devicePixelRatio || 1, 2);

    // ── 底板：legacy 是「底色层（.boot__plate）+ 渐变底图层（bd-bg）+ 柔光层」，三层各按 1 − bg 淡出、各带同一条补集遮罩；叠起来对下面的覆盖是 1 − bg²，颜色是
    //    (1 − bg) · 底图 + bg · (1 − bg) · 底色 + bg² · 下面的东西。comp：底图（+ 柔光）烘成一张不带底色的位图（plateBake.ts），底色是它下面一块纯色层，两层各按 1 − bg 淡出（同一个式子）；
    //    再拆成三份（左边一条 / 斜坡窄条 / 实心主体）+ 窗左缘的薄纱各自平移。主栏纸面（.app__main）一直在、不再被前缘遮罩：前缘右边与羽化带里用一层「壁纸色」把它擦掉（见 boot__wall）——
    //    legacy 里那里是「纸面被遮罩掉、露出壁纸」，底板在 bg 淡出时才会透出壁纸而不是纸面（快速版里 bg 在窗左缘到位之前就开始淡了，不擦的话纸面的右缘（带圆角）会从底板里透出来）──
    const bake = c.getBake();
    const bakeCv = (stage = false, cropW?: number): HTMLCanvasElement => {
      const cv = document.createElement('canvas');
      cv.className = 'boot__bake';
      const sw = cropW !== undefined ? Math.max(2, Math.min(bake.width, Math.round((cropW / W) * bake.width))) : bake.width;     // 左边一条只要最左边那一段
      cv.width = sw;
      cv.height = bake.height;
      (cv.getContext('2d', { alpha: false }) as CanvasRenderingContext2D).drawImage(bake, 0, 0, sw, bake.height, 0, 0, sw, bake.height);   // alpha:false：底图的盒子铺满整屏，位图本来就不透明——合成器可以把它下面被盖住的应用剔掉、也不必混合
      if (stage) cv.style.cssText = `left:0;top:0;width:${(W / k).toFixed(2)}px;height:1000px`;
      else if (cropW !== undefined) cv.style.cssText = `left:0;top:0;width:${((sw / bake.width) * W).toFixed(2)}px;height:100%`;
      return cv;
    };
    const bodyPs = body.firstElementChild as HTMLElement;
    if (chw.plate && mainLeft !== undefined) {
      // 主体：藏起 DOM 版的底图 + 柔光（bd-stack），留着底色层（.boot__plate），换上位图盖在它上面
      for (const n of Array.from(bodyPs.children) as HTMLElement[]) { if (n === plate) continue; n.style.display = 'none'; hidden.push(n); }
      const bodyCv = bakeCv();
      bodyPs.appendChild(bodyCv);
      created.push(bodyCv);
      bodyPs.style.transform = 'translateX(0px)';
      anim(body, chw.plate.body); anim(bodyPs, chw.plate.bodyInv);
      anim(plate, chw.bgFade); anim(bodyCv, chw.bgFade);
      // 左边一条、斜坡与壁纸色擦除层：窗的左缘开始动（S.win[0]）之后才用得上
      late(Math.max(0, S.win[0] - 0.04), () => {
        const F = 140;
        const mainRight = anchors.main ? anchors.main.x + anchors.main.w : (mainLeft as number);
        const wall = `rgb(${WALL_RGB.join(' ')})`;
        // 壁纸色擦除层：纸面 [mainLeft, mainRight + 64]（右边多留纸面阴影的宽度）里，前缘 xe 右边全是壁纸色、羽化带（xe − F → xe）里不透明度 0 → 1（= 纸面遮罩 1 − t 的补集），在底板下面、应用上面
        const wH = div('boot__wallh', `left:${(mainLeft as number).toFixed(2)}px;width:${Math.max(0, mainRight + 64 - (mainLeft as number)).toFixed(2)}px`);
        const wE = div('boot__wall', `left:${(-(mainLeft as number)).toFixed(2)}px;width:${(F + 1600).toFixed(0)}px;transform:translateX(${(-F - 6).toFixed(2)}px);background:linear-gradient(90deg, rgb(${WALL_RGB.join(' ')} / 0) 0, ${wall} ${F}px, ${wall} 100%)`);
        wH.appendChild(wE);
        host.insertBefore(wH, body);
        // 斜坡：持有者 F 宽（静态渐变遮罩 0 → 1），内层位图反向平移钉在屏幕上；底色层是它下面同样 0 → 1 渐变的纯色（legacy 里底色层与底图层各被同一条补集遮罩羽化一次、各按 1 − bg 淡出）
        const rF = div('boot__rfill', `width:${F}px;transform:translateX(${(-F - 6).toFixed(2)}px);background:linear-gradient(90deg, rgb(${PLATE_FILL_RGB.join(' ')} / 0) 0, rgb(${PLATE_FILL_RGB.join(' ')}) 100%)`);
        const rE = div('boot__ph boot__ph--ramp', `right:auto;width:${F}px;transform:translateX(${(-F - 6).toFixed(2)}px)`);
        const rIn = div('boot__ps', `inset:auto;left:0;top:0;width:${W}px;height:${H}px;transform:translateX(${(F + 6).toFixed(2)}px)`);
        const rCv = bakeCv();
        rIn.appendChild(rCv);
        rE.appendChild(rIn);
        // 左边一条（左栏所在的那一段，不在纸面里，底板一直在）：底色层 + 位图
        const sE = div('boot__ph boot__ph--strip', `right:auto;width:${(mainLeft as number).toFixed(2)}px`);
        const sFill = div('boot__fill', '');
        const sIn = div('boot__ps', `inset:auto;left:0;top:0;width:${(mainLeft as number).toFixed(2)}px;height:${H}px`);
        const sCv = bakeCv(false, mainLeft as number);
        sIn.appendChild(sCv);
        sE.append(sFill, sIn);
        body.after(rF);
        rF.after(rE);
        rE.after(sE);
        created.push(wH, rF, rE, sE);
        rampEl = rE; stripEl = sE;
        animL(wE, chw.plate?.ramp);
        animL(rF, chw.plate?.ramp); animL(rE, chw.plate?.ramp); animL(rIn, chw.plate?.rampInv);
        for (const n of [rF, rCv, sFill, sCv]) animL(n, chw.bgFade);
      }, 'late:ramp-strip');
    }
    // 窗左缘的薄纱：bloom 之外（世界层里、bloom 之后）的一条窄带 = 窗左缘下面那些东西的拷贝（壁纸色 + 底色层 + 底图位图，后两层各按 1 − bg 淡出，钉在屏幕上），静态渐变遮罩让它的右边渐隐；
    // 整条随软边宽度 scaleX（遮罩跟着缩放）、内层反向缩放（见 dayComp.ts 的 veilTf / veilInv）
    late(Math.max(0, S.win[0] - 0.04), () => {
      const vE = div('boot__sveil', `left:0;top:0;width:${VEIL_W}px;height:1000px;opacity:0`);
      const vW = div('boot__vw', `background:rgb(${WALL_RGB.join(' ')})`);
      const vF = div('boot__fill', '');
      const vIn = div('boot__sveil-in', 'left:0;top:0;width:100%;height:100%');
      const vCv = bakeCv(true);
      vIn.appendChild(vCv);
      vE.append(vW, vF, vIn);
      el.bloom.after(vE);
      created.push(vE);
      veilEl = vE;
      animL(vE, chw.veilTf); animL(vE, chw.veilOn); animL(vIn, chw.veilInv); animL(vF, chw.bgFade); animL(vCv, chw.bgFade);
    }, 'late:sveil');
    // 窗里临时的底 / 雾 / 光环 / 花海条：雾在 0.1 s 起淡入，其余在换景（wash）起才看得见
    late(Math.max(0, S.washTop[0] - 0.05), () => {
      // 窗里临时的薰衣草底：与拱窗自己的底同一条竖向渐变（框 = bloom 盒子，渐变按窗的位置摆）
      const archBg = div('boot__archbg', `left:0;top:0;width:${boxW}px;height:1000px;opacity:0;background:linear-gradient(180deg,#e4dcf4 ${y0.toFixed(1)}px,#efe9f8 ${(y0 + 0.4 * hh).toFixed(1)}px,#f8f4f8 ${(y0 + 0.72 * hh).toFixed(1)}px,#e9e1f3 ${(y0 + hh).toFixed(1)}px)`);
      const archFog = div('boot__archbg', `left:0;top:0;width:${boxW}px;height:1000px;opacity:0;background:linear-gradient(180deg,#e4dcf4 ${y0.toFixed(1)}px,#e8e1f5 ${(y0 + 0.22 * hh).toFixed(1)}px,rgb(239 233 248 / 0) ${(y0 + 0.62 * hh).toFixed(1)}px)`);
      el.art.after(archFog);
      const hs = 0.3503 * hh;
      const archDeco = div('boot__archdeco', `left:0;top:0;width:0;height:0;opacity:0;transform-origin:0 0;--ku:${u.toFixed(5)}`);
      archDeco.innerHTML = `<i style="left:${(stageArch.x + 0.1964 * hh).toFixed(1)}px;top:${(stageArch.y + 0.2442 * hh).toFixed(1)}px;width:${hs.toFixed(1)}px;height:${hs.toFixed(1)}px"></i>`;
      const archFlw = div('boot__archflw is-comp', `left:0;top:0;width:${boxW}px;height:${flwH.toFixed(2)}px;opacity:0;background-image:url('${c.flowersUrl}');background-size:auto ${flwH.toFixed(2)}px;background-position:${flwX.toFixed(2)}px 100%;transform:translateY(${(1000 - flwH).toFixed(2)}px)`);
      el.bloom.insertBefore(archFlw, el.bloom.firstChild);
      el.bloom.insertBefore(archDeco, el.bloom.firstChild);
      el.bloom.insertBefore(archBg, el.bloom.firstChild);
      created.push(archBg, archFog, archDeco, archFlw);
      animL(archBg, chw.under);
      animL(archFog, chw.fog);
      animL(archDeco, chw.under); animL(archDeco, chw.deco);
      animL(archFlw, chw.underFlw); animL(archFlw, chw.flwTy, { at: S.wash[0] });
    }, 'late:archbg');
    // 窗的轮廓（分件）、窗台、落影：窗宽小于屏宽 85% 之后才看得见
    const foAt0 = chw.fo.start ?? S.win[0];
    /** 在 late 的任务里再排一个同一时刻的任务（没有 Stager：立刻做）. */
    const later = (fn: () => void, label: string) => { if (o.stager) o.stager.add(Math.max(0, foAt0 - 0.05), fn, -Infinity, label); else fn(); };
    late(Math.max(0, foAt0 - 0.05), () => {
      const frame = div('boot__dfr', '');
      (veilEl ?? el.bloom).after(frame);
      created.push(frame);
      const pieces = buildOutline(frame, u, k, Rb);
      // 画布件：DOM 与它们的动画在同一个任务里（JS 马上就要每个节拍往里画）
      animL(pieces.cvBL, (chw.stroke as OutlinePieces).botPos.BL); animL(pieces.cvBL, chw.foAl);
      animL(pieces.cvBR, (chw.stroke as OutlinePieces).botPos.BR); animL(pieces.cvBR, chw.fo);
      animL(pieces.cvTL, (chw.ring as OutlinePieces).cornersPos.TL); animL(pieces.cvTL, chw.fo);       // 左上圆角的左侧衰减 aL 画在画布里（渐变，见 drawCornerCanvas）
      animL(pieces.cvTR, (chw.ring as OutlinePieces).cornersPos.TR); animL(pieces.cvTR, chw.fo);
      corners = { tl: pieces.cvTL, tr: pieces.cvTR, bl: pieces.cvBL, br: pieces.cvBR, rtAt: chw.rtAt, rbAt: chw.rbAt, aLAt: chw.aLAt, u, Rb, last: -1, lastA: -1, lastB: -1 };
      // 其余件（直边条 / 窗台 / 落影）：各自一个任务，每个任务里 DOM 与动画一起建，不挤在一个 10 ms 的大任务里
      later(() => { animateOutline(animL, pieces.ring, chw.ring as OutlinePieces, chw, true); }, 'late:outline-ring');
      later(() => { animateOutline(animL, pieces.stroke, chw.stroke as OutlinePieces, chw, false); }, 'late:outline-stroke');
      later(() => {
        animL(pieces.hem[0], chw.hemHolder);
        animL(pieces.hem[1], chw.hemInner); animL(pieces.hem[1], chw.foAl);        // 下层条：整条，fo·aL
        animL(pieces.hem[2], chw.hemInner); animL(pieces.hem[2], chw.hemTop);      // 上层条：左端 190 个舞台单位的渐变遮罩 + 补足 legacy 的 fo·(aL + (1 − aL)·r)
      }, 'late:outline-hem');
      later(() => {
        // 落影：静态的「终态拱窗」的落影（窗收到位时自然露出来）+ 左缘的竖向软阴影条（随窗左缘平移）
        const archShadow = div('boot__dshadow', `left:${stageArch.x.toFixed(2)}px;top:${stageArch.y.toFixed(2)}px;width:${stageArch.w.toFixed(2)}px;height:${stageArch.h.toFixed(2)}px;border-radius:${(stageArch.w / 2).toFixed(2)}px ${(stageArch.w / 2).toFixed(2)}px ${(ARCH_BOTTOM_RADIUS * u).toFixed(2)}px ${(ARCH_BOTTOM_RADIUS * u).toFixed(2)}px;box-shadow:0 ${(14 * u).toFixed(2)}px ${(34 * u).toFixed(2)}px rgb(70 45 110 / 0.2);opacity:0`);
        el.bloom.before(archShadow);
        const shL = div('boot__dshadow-l', `left:${(-60 * u).toFixed(2)}px;width:${(60 * u).toFixed(2)}px;height:1000px;opacity:0`);
        frame.before(shL);
        created.push(archShadow, shL);
        animL(archShadow, chw.fo);
        animL(shL, chw.shL); animL(shL, chw.shLop);
      }, 'late:outline-shadow');
    }, 'late:outline');

    // ── 动画：窗（起步就要）──
    anim(el.bloom, chw.clip);
    if (chw.zoom) anim(el.world, chw.zoom);
    anim(el.art, chw.artTr); anim(el.art, chw.artSc); anim(el.art, chw.artOp);
    anim(figEl, chw.artTr); anim(figEl, chw.artSc); anim(figEl, chw.figOp);
    tp('day:a-win');
  } else {
    // 没有窗：bloom 与底板一起溶掉（E.ease）
    anim(el.bloom, common.bgFlow);
    for (const n of [plate, el.bgd, glowEl]) anim(n, common.bgFlow);
  }

  // ── 蝶（合成器上的小组）与光尘（只盖路径外接框的小画布）──
  let bfRoot: HTMLElement | undefined;
  let dustCv: HTMLCanvasElement | undefined;
  if (hasBf && start && goal && path) {
    const bch = dayBfChannels({ kind, start, goal, path, fold0 });
    bfRoot = div('boot__dbf', '');
    bfRoot.setAttribute('aria-hidden', 'true');
    // SVG 根元素上的 transform / opacity 动画合成器画不了（compositeFailed）：每个 svg 外包一个 div，动画挂在 div 上
    const mkSvg = (cls: string, vb: string, w: number, h: number, left: number, top: number, inner: string) => {
      const wrap = div(cls, `left:${left}px;top:${top}px;width:${w}px;height:${h}px;transform-origin:${-left}px ${-top}px`);
      const sv = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      sv.setAttribute('viewBox', vb);
      sv.setAttribute('width', String(w));
      sv.setAttribute('height', String(h));
      sv.innerHTML = inner;
      wrap.appendChild(sv);
      return wrap;
    };
    const wl = mkSvg('dbf-w dbf-wl', '-2 -34 38 60', 38, 60, -2, -34, '<use href="#bt-wingB"/>');
    const wr = mkSvg('dbf-w dbf-wr', '-2 -34 38 60', 38, 60, -2, -34, '<use href="#bt-wingB"/>');
    const bd = mkSvg('dbf-b', '-10 -22 20 36', 20, 36, -10, -22, '<use href="#bt-bBody"/>');
    const lg = mkSvg('dbf-l', '-5 -5 13 18', 13, 18, -5, -5, '<path d="M0 -4L-3.4 11.4M0 -2L2.8 11.6M.4 0L6.2 11.2" fill="none" stroke="#0e1230" stroke-width=".8" stroke-linecap="round"/>');
    bfRoot.append(wl, wr, bd, lg);
    // 先把内联样式设成 tr = 0 的状态，动画随后从同一个 t0 起接手
    bfRoot.style.transform = bch.pose.css(bch.pose.truth(0)).transform as string;
    bfRoot.style.opacity = bch.alpha.css(bch.alpha.truth(0)).opacity as string;
    wl.style.transform = bch.wingL.css(bch.wingL.truth(0)).transform as string;
    wr.style.transform = bch.wingR.css(bch.wingR.truth(0)).transform as string;
    lg.style.opacity = bch.legs.css(bch.legs.truth(0)).opacity as string;
    host.appendChild(bfRoot);
    anim(bfRoot, bch.pose);
    // 容器的不透明度（带四个子层的组）只在要淡出品牌标前才需要（起点本来就不透明时）：晚建，之前它不是一个渲染面
    if (start.alpha < 0.999 || !o.stager) anim(bfRoot, bch.alpha); else o.stager.add(Math.max(0, S.swapOut[0] - 0.06), () => { anim(bfRoot, bch.alpha, { sync: true }); });
    anim(wl, bch.wingL); anim(wr, bch.wingR); anim(lg, bch.legs);
    tp('day:a-bf');
    // 光尘：只盖光尘路径外接框的小画布（≤ 8 个点，每个节拍清空重画）
    const xs = path.map((p) => p[0]);
    const ys = path.map((p) => p[1]);
    const pad = 24;
    const dx0 = Math.max(0, Math.floor(Math.min(...xs) - pad));
    const dy0 = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const dx1 = Math.min(W, Math.ceil(Math.max(...xs) + pad));
    const dy1 = Math.min(H, Math.ceil(Math.max(...ys) + pad));
    dustCv = document.createElement('canvas');
    dustCv.className = 'boot__dust';
    dustCv.setAttribute('aria-hidden', 'true');
    dustCv.width = Math.max(2, Math.round((dx1 - dx0) * R));
    dustCv.height = Math.max(2, Math.round((dy1 - dy0) * R));
    dustCv.style.cssText = `left:${dx0}px;top:${dy0}px;width:${dx1 - dx0}px;height:${dy1 - dy0}px`;
    host.insertBefore(dustCv, bfRoot);
  }
  // ── 标题组：已完全浮现时换成预烘焙的叠层（dayComp.ts 的 dayTitleChannels），主线程不再碰它；还在浮现中（被打断得早）退回 JS 逐拍写 ──
  let bakedTitle = false;
  const ttRoots: HTMLElement[] = [];
  if (fh1 && fen && grpSrc && chBase.every((b) => b.op >= 0.999 && b.blur < 0.01 && b.y < 0.01) && enBase.op >= 0.999 && enBase.blur < 0.01 && enBase.y < 0.01 && el.enSpan.firstChild) {
    const left = h1.parentElement as HTMLElement;                      // .s0-left（绝对定位，在 .bd-text 里）
    const lb = boxRect(left);
    const fsH1 = parseFloat(getComputedStyle(h1).fontSize) || 1;
    const fsEn = parseFloat(getComputedStyle(el.enSpan).fontSize) || 1;
    const word = el.enSpan.textContent ?? '';
    const xs = Array.from(word, (_, i) => { const r0 = document.createRange(); r0.setStart(el.enSpan.firstChild as Node, i); r0.setEnd(el.enSpan.firstChild as Node, i + 1); return r0.getBoundingClientRect().left - enBox.x; });
    const tch = dayTitleChannels({ kind, k, grp: grpSrc, h1Box, enBox, enSrc, lsH1, lsEn, nameLS: anchors.nameLS, subLS: anchors.subLS, fsH1, fsEn, letters: word.length });
    const wrap = (box: Rect) => div('boot__dtt', `left:${((box.x - lb.x) / k).toFixed(3)}px;top:${((box.y - lb.y) / k).toFixed(3)}px;width:${(box.w / k).toFixed(3)}px;height:${(box.h / k).toFixed(3)}px`, left);
    const rgbCss = (cc: readonly number[]) => `rgb(${cc.map((x) => Math.round(x)).join(' ')})`;
    // 「栖枝」：光晕层（透明字 + text-shadow）/ 起始字色层 / 字标色层（叠放，上层 opacity = tint）
    const w1 = wrap(h1Box);
    const l1 = (['halo', 'a', 'flat'] as const).map((kind2) => {
      const n = h1.cloneNode(true) as HTMLElement;
      n.removeAttribute('style');
      n.className = `boot__dtt-l boot__dtt-${kind2}`;
      n.querySelectorAll<HTMLElement>('.c').forEach((cc) => { cc.removeAttribute('style'); cc.style.opacity = '1'; });
      if (kind2 === 'flat') n.style.setProperty('--tt-c', rgbCss(nameRgb));
      return n;
    });
    w1.append(...l1);
    // ALIGHT：逐字母绝对定位（位置取自原整串排版的量值，字距微调一致），每层同样三份（光晕层只有 ALIGHT 没有阴影，所以两层）
    const w2 = wrap(enBox);
    const l2 = (['a', 'flat'] as const).map((kind2) => {
      const n = document.createElement('div');
      n.className = `boot__dtt-e boot__dtt-e--${kind2}`;
      if (kind2 === 'flat') n.style.setProperty('--tt-c', rgbCss(subRgb));
      Array.from(word).forEach((ch0, i) => { const sp = document.createElement('span'); sp.className = 'l'; sp.textContent = ch0; sp.style.left = `${(xs[i] / k).toFixed(3)}px`; n.appendChild(sp); });
      return n;
    });
    w2.append(...l2);
    ttRoots.push(w1, w2);
    h1.style.visibility = 'hidden';
    el.enSpan.style.visibility = 'hidden';
    anim(w1, tch.h1Tf);
    anim(w2, tch.enTf);
    anim(l1[0], tch.halo); anim(l1[1], tch.aOut); anim(l1[2], tch.flat);
    anim(l2[0], tch.aOut); anim(l2[1], tch.flat);
    for (const l of l1) anim(l.querySelectorAll('.c')[1], tch.h1Char);
    for (const l of l2) l.querySelectorAll('.l').forEach((sp, i) => anim(sp, tch.enLetter[i]));
    bakedTitle = true;
  }
  tp('day:animated');

  /* ───────── 残余 JS：标题组、枝、光尘 ───────── */
  const titleRects = (tr: number): Rect[] => {
    const st = trState('day', kind, tr);
    const out: Rect[] = [];
    if (st.titleOut >= 1) return out;
    const g = grpSrc ? titleGroupAt(grpSrc, st.title) : undefined;
    if (fh1) out.push(g ? g.h1Rect : flipRectAt(h1Box, h1Src, flipAt(fh1, st.title)));
    if (fen) out.push(g ? g.enRect : flipRectAt(enBox, enSrc, flipAt(fen, st.title)));
    return out;
  };
  const obstacles = (tr: number): Rect[] => {
    const st = trState('day', kind, tr);
    const out = titleRects(tr);
    if (start && goal && path && st.swapOut < 1) { const pose = bfFlight(start, goal, path, st.fly, st.flap, tr); if (pose.alpha > 0.1) out.push(bfBox(pose)); }
    return out;
  };
  const cover = (tr: number): Rect[] => {
    if (!withWin || !ch) return [];
    const st = trState('day', kind, tr);
    const cc = archClip(st.art, boxW, 1000, stageArch as Rect, ARCH_BOTTOM_RADIUS / k, st.winL);
    return [stageToScreen(archClipRect(cc, boxW, 1000), lerp(z0, 1, st.art), DC.A, k)];
  };

  const dg = dustCv?.getContext('2d') ?? null;
  let dustBusy = true;
  let dustBox: [number, number, number, number] | null = null;
  const drawDust = (st: ReturnType<typeof trState>, tr: number) => {
    if (!dg || !dustCv || !path) return;
    const dx0 = parseFloat(dustCv.style.left);
    const dy0 = parseFloat(dustCv.style.top);
    const dots = st.swapOut >= 1 || st.fly <= 0.01 ? [] : dustDots(path, S.fly, tr, 7300, titleRects(tr));
    if (!dots.length && !dustBusy) return;
    dustBusy = dots.length > 0;
    dg.setTransform(R, 0, 0, R, -dx0 * R, -dy0 * R);
    if (dustBox) dg.clearRect(dustBox[0], dustBox[1], dustBox[2], dustBox[3]); else dg.clearRect(dx0, dy0, dustCv.width / R + 1, dustCv.height / R + 1);
    let bx0 = Infinity; let by0 = Infinity; let bx1 = -Infinity; let by1 = -Infinity;
    const s1 = H / 1080;
    for (const d of dots) {
      const r = 1.6 * s1 * 1.4 * d.r;
      dg.globalAlpha = Math.min(1, d.a * 0.4);
      dg.drawImage(c.dayGlow, d.x - r * 4, d.y - r * 4, r * 8, r * 8);
      dg.globalAlpha = Math.min(1, d.a * 0.75);
      dg.fillStyle = '#6fb2ea';
      dg.beginPath();
      dg.arc(d.x, d.y, r, 0, TAU);
      dg.fill();
      bx0 = Math.min(bx0, d.x - r * 4 - 1); by0 = Math.min(by0, d.y - r * 4 - 1); bx1 = Math.max(bx1, d.x + r * 4 + 1); by1 = Math.max(by1, d.y + r * 4 + 1);
    }
    dustBox = dots.length ? [bx0, by0, bx1 - bx0, by1 - by0] : null;
    dg.globalAlpha = 1;
  };

  /** 标题：还没浮现（或只出了一半）的从它此刻的状态起——不带的由上面的 WAAPI 淡出，带着走的把 reveal 收完；「栖枝」与 ALIGHT 是一个整体（titleGroupAt）. */
  const lastTitle = { h1: '', en: '' };
  const drive = (tr: number) => {
    const st = trState('day', kind, tr);
    if ((fh1 || fen) && !bakedTitle) {
      const gone = st.titleOut >= 1 ? 'hidden' : '';
      const grp = grpSrc ? titleGroupAt(grpSrc, st.title) : undefined;
      if (fh1) {
        h1.style.transform = flipCss(grp ? grp.h1Flip : flipAt(fh1, st.title), k);
        h1.style.letterSpacing = `${lerp(lsH1, anchors.nameLS, st.title).toFixed(4)}em`;
        h1.style.opacity = (1 - st.titleOut).toFixed(3);
        h1.style.visibility = gone;
        h1.style.color = tintColor(DAY_TITLE_COLOR, nameRgb, st.tint);
        h1.style.textShadow = st.tint >= 0.999 ? 'none' : `0 2px 0 rgb(255 255 255 / ${(0.9 * (1 - st.tint)).toFixed(3)}), 0 10px 30px rgb(120 86 168 / ${(0.28 * (1 - st.tint)).toFixed(3)})`;
        el.ch.forEach((n, i) => settleReveal(n, chBase[i], st.title));
      }
      if (fen) {
        el.enSpan.style.transform = flipCss(grp ? flipTo(enBox, enSrc, grp.enRect) : flipAt(fen, st.title), k);
        el.enSpan.style.letterSpacing = `${lerp(lsEn, anchors.subLS, st.title).toFixed(4)}em`;
        el.enSpan.style.visibility = gone;
        el.enSpan.style.color = tintColor(DAY_EN_COLOR, subRgb, st.tint);
        el.enSpan.style.opacity = ((enBase.op + (1 - enBase.op) * st.title) * (1 - st.titleOut)).toFixed(3);
        el.enSpan.style.filter = enBase.blur * (1 - st.title) > 0.05 ? `blur(${(enBase.blur * (1 - st.title)).toFixed(2)}px)` : 'none';
      }
    }
    void lastTitle;
    if (twigFx) twigFx.update(st.flyRaw, st.swapOut, start && goal && path && st.swapOut < 1 ? bfBox(bfFlight(start, goal, path, st.fly, st.flap, tr)) : null);
    drawDust(st, tr);
    if (corners) {
      const rt = corners.rtAt(tr);
      const aL = corners.aLAt(tr);
      const rtChanged = Math.abs(rt - corners.last) > 0.02;
      if (rtChanged || Math.abs(aL - corners.lastA) > 0.01) { corners.lastA = aL; drawCornerCanvas(corners.tl, 'L', rt, corners.u, k, corners.Rb, aL); }
      if (rtChanged) { corners.last = rt; drawCornerCanvas(corners.tr, 'R', rt, corners.u, k, corners.Rb, 1); }
      const rb = corners.rbAt(tr);
      if (Math.abs(rb - corners.lastB) > 0.02) { corners.lastB = rb; drawBottomCanvas(corners.bl, 'L', rb, corners.u, k, corners.Rb); drawBottomCanvas(corners.br, 'R', rb, corners.u, k, corners.Rb); }
    }
  };

  const dispose = () => {
    group.end();
    for (const n of created) n.remove();
    bfRoot?.remove();
    dustCv?.remove();
    twigFx?.el.remove();
    ttRoots.forEach((n) => n.remove());
    for (const n of [rampEl, stripEl]) n?.remove();
    el.bfwrap.style.display = '';
    host.classList.remove('is-trc');
    const back = (n: HTMLElement | SVGElement) => { n.style.transform = ''; n.style.transformOrigin = ''; n.style.visibility = ''; n.style.letterSpacing = ''; };
    back(h1); back(el.enSpan); back(el.credit); back(el.art);
    h1.style.opacity = '';
    h1.style.color = ''; h1.style.textShadow = ''; el.enSpan.style.color = '';
    el.art.style.opacity = '';
    el.bloom.style.clipPath = '';
    el.bloom.style.opacity = '';
    plate.style.opacity = ''; el.bgd.style.opacity = ''; glowEl.style.opacity = '';
    fx.style.opacity = '';
    for (const [n] of fades) n.style.opacity = '';
    for (const [n] of textFades) n.style.opacity = '';
    el.ch.forEach((n) => { n.style.opacity = ''; });
    (body.firstElementChild as HTMLElement).style.transform = '';
    for (const n of hidden) n.style.display = '';
    hidden.length = 0;
    c.renderScene(from);
  };

  return {
    shared: { mark: hasBf, title: !!fh1, credit: false, creditFade: !!anchors.credit, push: false, fig: !!figEl, figFade: !figEl && !!anchors.fig && !!anchors.arch },
    obstacles,
    cover,
    render(tr: number) { group.seek(tr); drive(tr); },
    play(t0: number) { group.play(t0); },
    retier(divisor: number, refreshMs: number) { group.retier(divisor, refreshMs); },
    step(tr: number) { if (!group.running) group.seek(tr); drive(tr); },
    end() { group.release(); },      // 昼的转场没有挂在应用元素上的动画：覆盖层里的 fill:both 动画留着，把覆盖层停在终态直到卸载（见 ClockGroup.release）
    dispose,
  };
}

/* ───────── 窗的轮廓 / 窗台的 DOM（分件）───────── */

interface OutlineEls {
  bars: { L: HTMLElement; R: HTMLElement; T: HTMLElement; B: HTMLElement };
  cBL: HTMLElement;
  cBR: HTMLElement;
}
interface BuiltOutline { ring: OutlineEls; stroke: OutlineEls; hem: HTMLElement[]; cvTL: HTMLCanvasElement; cvTR: HTMLCanvasElement; cvBL: HTMLCanvasElement; cvBR: HTMLCanvasElement }

function buildOutline(frame: HTMLElement, u: number, k: number, Rb: number): BuiltOutline {
  const S = CORNER_BOX;
  const mk = (band: typeof OUTLINE_RING | typeof OUTLINE_PURPLE, color: string, ringBottom: boolean): OutlineEls => {
    const th = (band.out - band.in) * u;
    const bar = (cls: string, w: number, h: number) => div(`dfp ${cls}`, `width:${w.toFixed(3)}px;height:${h.toFixed(3)}px;background:${color}`, frame);
    const bars = { L: bar('dfp-bar', th, BAR_LEN), R: bar('dfp-bar', th, BAR_LEN), T: bar('dfp-bar', BAR_LEN, th), B: bar('dfp-bar', BAR_LEN, th) };
    let cBL: HTMLElement;
    let cBR: HTMLElement;
    if (ringBottom) {
      // 白框的下角半径固定（22 个屏幕 px）：带边框的小件，只平移
      const R = OUTLINE_RING.rBot * u;
      const bw = th;
      cBL = div('dfp dfp-cb', `width:${R.toFixed(3)}px;height:${R.toFixed(3)}px;border-left:${bw.toFixed(3)}px solid ${color};border-bottom:${bw.toFixed(3)}px solid ${color};border-bottom-left-radius:${R.toFixed(3)}px;box-sizing:border-box`, frame);
      cBR = div('dfp dfp-cb', `width:${R.toFixed(3)}px;height:${R.toFixed(3)}px;border-right:${bw.toFixed(3)}px solid ${color};border-bottom:${bw.toFixed(3)}px solid ${color};border-bottom-right-radius:${R.toFixed(3)}px;box-sizing:border-box`, frame);
    } else {
      // 描边的下角：画布里每个节拍重画（见 drawBottomCanvas），这里只占位
      cBL = div('dfp dfp-cb', 'display:none', frame);
      cBR = div('dfp dfp-cb', 'display:none', frame);
    }
    return { bars, cBL, cBR };
  };
  const ring = mk(OUTLINE_RING, 'rgb(255 255 255 / 0.7)', true);
  const stroke = mk(OUTLINE_PURPLE, 'rgb(120 100 170 / 0.42)', false);
  // 上两个圆角：白框与描边的弧画在同一张小画布里（每个节拍按半径重画；位置 / 不透明度走合成器）
  const cv = (): HTMLCanvasElement => {
    const c2 = document.createElement('canvas');
    c2.className = 'dfp dfp-cv';
    c2.width = Math.max(2, Math.round(S * k * Rb));
    c2.height = c2.width;
    c2.style.cssText = `width:${S}px;height:${S}px`;
    frame.appendChild(c2);
    return c2;
  };
  const cvTL = cv();
  const cvTR = cv();
  const bcv = (): HTMLCanvasElement => {
    const c3 = document.createElement('canvas');
    c3.className = 'dfp dfp-cv';
    c3.width = Math.max(2, Math.round(40 * u * k * Rb));
    c3.height = c3.width;
    c3.style.cssText = `width:${(40 * u).toFixed(3)}px;height:${(40 * u).toFixed(3)}px`;
    frame.appendChild(c3);
    return c3;
  };
  const cvBL = bcv();
  const cvBR = bcv();
  // 窗台：持有者（右缘跟窗的右缘，overflow:hidden）+ 两条叠放的内层条（纹理原点 = 窗左缘）；贴窗的底边内侧。
  // 窗台也在 legacy 的轮廓遮罩里（窗左缘起 aL、往窗里 190 个舞台单位升到 1）：下层条整条（不透明度 fo·aL）+ 上层条带静态的 0 → 1 渐变遮罩（.dfp-hemi--hi，不透明度 hemTop），
  // 两条的纹理是不透明的，叠起来恰好是 fo·(aL + (1 − aL)·r)——见 dayComp.ts 的 hemTopAlpha
  const holder = div('dfp dfp-hemh', `width:${BAR_LEN}px;height:${(HEM_H * u).toFixed(3)}px;top:0`, frame);       // 持有者本身不透明（淡入淡出在内层条上）：旧版这里写了 opacity:0 又没动画它，窗台整条看不见
  const hemStyle = `width:${BAR_LEN}px;height:${(HEM_H * u).toFixed(3)}px;--ku:${u.toFixed(5)}`;
  const low = div('dfp dfp-hemi', hemStyle, holder);
  const top = div('dfp dfp-hemi dfp-hemi--hi', `${hemStyle};mask-image:linear-gradient(90deg, transparent 0, #000 ${WIN_EDGE_SOFT}px)`, holder);
  return { ring, stroke, hem: [holder, low, top], cvTL, cvTR, cvBL, cvBR };
}

/** 画一张上圆角的画布：两条弧（白框 + 描边），半径 rt（舞台单位）。左上的那张再乘 legacy 的轮廓遮罩（aL）：窗框左边起 aL、往窗里 WIN_EDGE_SOFT 个舞台单位升到 1
    （弧延伸到窗里几百个单位，只有紧贴左缘的那一小段是被压暗的；整件乘 aL 的话高速段整条上弧都消失了）. */
function drawCornerCanvas(cv: HTMLCanvasElement, side: 'L' | 'R', rt: number, u: number, k: number, Rb: number, aL: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const S = CORNER_BOX;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  g.setTransform(k * Rb, 0, 0, k * Rb, 0, 0);
  g.lineCap = 'butt';
  const cx = side === 'L' ? S : 0;
  const a0 = side === 'L' ? Math.PI : 1.5 * Math.PI;
  for (const a of cornerArcs(rt, u)) {
    if (a.r <= 0.01) continue;
    g.strokeStyle = a.color;
    g.lineWidth = a.w;
    g.beginPath();
    g.arc(cx, S, a.r, a0, a0 + 0.5 * Math.PI);
    g.stroke();
  }
  if (side === 'L' && aL < 0.999) {
    // 窗框的左缘在画布里的 x = S − rt（弧的圆心在 (S, S)，窗的左缘比圆心靠左 rt）
    const x0 = S - rt;
    const gr = g.createLinearGradient(x0, 0, x0 + WIN_EDGE_SOFT, 0);
    gr.addColorStop(0, `rgba(0,0,0,${aL.toFixed(4)})`);
    gr.addColorStop(1, 'rgba(0,0,0,1)');
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    g.globalCompositeOperation = 'source-over';
  }
}

type AnimFn = (target: Element | null | undefined, ch: Channel | null | undefined, extra?: { late?: boolean; at?: number; sync?: boolean }) => unknown;

function animateOutline(anim: AnimFn, els: OutlineEls, pc: OutlinePieces, ch: DayChannels, ring: boolean) {
  // 白框的下角是固定半径的带边框小件（只平移）；描边的下角在画布里画（pieces.cvBL / cvBR），这里不建
  if (ring) { anim(els.cBL, pc.botPos.BL); anim(els.cBR, pc.botPos.BR); }
  anim(els.bars.L, pc.bars.L); anim(els.bars.R, pc.bars.R); anim(els.bars.T, pc.bars.T); anim(els.bars.B, pc.bars.B);
  // 左侧件（左直边、下左圆角）再乘左缘速度衰减；其余件只随 fo
  anim(els.bars.L, ch.foAl);
  if (ring) anim(els.cBL, ch.foAl);
  for (const n of [els.bars.R, els.bars.T, els.bars.B]) anim(n, ch.fo);
  if (ring) anim(els.cBR, ch.fo);
}

/** 描边的下圆角（半径 rb，舞台单位）：左下 = 圆心 (SB, 0)、角度 π/2 → π；右下 = 圆心 (0, 0)、角度 0 → π/2（盒子边长 SB = 40 个屏幕 px）. 线宽 1 px、带的中线 = rb − 0.5 px. */
function drawBottomCanvas(cv: HTMLCanvasElement, side: 'L' | 'R', rb: number, u: number, k: number, Rb: number): void {
  const g = cv.getContext('2d');
  if (!g) return;
  const SB = 40 * u;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, cv.width, cv.height);
  const r = rb - 0.5 * u;
  if (r <= 0.01) return;
  g.setTransform(k * Rb, 0, 0, k * Rb, 0, 0);
  g.strokeStyle = 'rgb(120 100 170 / 0.42)';
  g.lineWidth = u;
  g.beginPath();
  if (side === 'L') g.arc(SB, 0, r, 0.5 * Math.PI, Math.PI); else g.arc(0, 0, r, 0, 0.5 * Math.PI);
  g.stroke();
}
