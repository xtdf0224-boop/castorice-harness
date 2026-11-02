/* 壁纸：夜（冥河，用户选定的终版）与昼（花海）。
   每张壁纸是一层：模糊小图 → 全图（AVIF/WebP，宽度由浏览器选）→ 骨龙遮纱（仅夜）→ 可见度罩。
   夜景图里她在右半（脸约 57% / 22%）：每个页面按 faceX 把图推到合适的位置（首页没有右栏，她更靠中；
   有右栏的页面她落在主栏与右栏之间），见 decor.css 的 .wallpaper__frame。
   本组件同时发布玻璃面板读的变量：
     --wp-dim      可见度罩的不透明度（壁纸被压暗/洗淡多少）
     --glass-a     面板表面 alpha         --glass-blur  面板模糊
     --halo-k      字形光晕强度 0…1       --wp-fx       她的脸在窗宽的比例
   夜/昼切换时整层交叉淡入；另一主题的图在浏览器空闲时先挂上（隐藏），切换时已经加载好。 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ThemeId, ViewId } from '../../lib/types';
import { useApp } from '../../state/store';
import { cx } from '../ui';
import { DayStage } from './DayStage';
import { NightStage } from './NightStage';
import { bakeDragVeil } from './dragVeilBake';
import { NIGHT_BF_PATCH, NIGHT_FACE_IN_IMAGE, WALLPAPERS, faceXFor, wallpaperFor, type WallpaperDef } from './wallpapers';

/** 自动调节: 首页让壁纸更清楚；信息密集的页面略压暗。 */
const VIEW_SHIFT: Record<ViewId, number> = {
  new: -0.08, queue: 0.03, tasks: 0, task: 0.05, agents: 0.03, tools: 0.04, models: 0.04, history: 0.05, settings: 0,
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 可见度罩的不透明度，由 壁纸可见度 (0–100) 与当前页面决定. */
export function wallpaperDim(visibility: number, view: ViewId, adaptive: boolean, mode: ThemeId = 'night') {
  const k = mode === 'day' ? 0.5 : 0.6;
  const base = 0.62 - k * (visibility / 100);          // 夜：0 → .62，80 → .14，100 → .02
  return clamp(base + (adaptive ? VIEW_SHIFT[view] : 0), 0, 0.9);
}

/** 薄烟玻璃。面板只留很薄的一层底；可读性靠每个字形周围的光晕（app.css 的 --text-halo）。
 *  面板通透度 (0–100)：稳重（0）时 alpha .66 / 模糊 18，通透（100）时 .32 / 9；昼更实一些。 */
export function glassFor(glass: number, mode: ThemeId = 'night') {
  const p = glass / 100;
  if (mode === 'day') return { alpha: 0.92 - 0.3 * p, blur: 16 - 7 * p, halo: p };
  return { alpha: 0.66 - 0.34 * p, blur: 18 - 9 * p, halo: p };
}

export function Wallpaper() {
  const on = useApp((s) => s.settings.wallpaper);
  const mode = useApp((s) => s.settings.mode);
  const visibility = useApp((s) => s.settings.wallpaperVisibility);
  const glass = useApp((s) => s.settings.panelGlass);
  const adaptive = useApp((s) => s.settings.wallpaperAdaptive);
  const tier = useApp((s) => s.settings.motionTier);
  const view = useApp((s) => s.view);
  const current = wallpaperFor(mode).id;

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.wallpaper = on ? 'on' : 'off';
    const dim = wallpaperDim(visibility, view, adaptive, mode);
    const g = glassFor(glass, mode);
    // 省电档（A）：模糊减半——集显与电池下，大面积 backdrop-filter 是最贵的一项。
    const blur = tier === 'A' ? g.blur * 0.5 : g.blur;
    root.style.setProperty('--wp-dim', dim.toFixed(3));
    root.style.setProperty('--glass-a', g.alpha.toFixed(3));
    root.style.setProperty('--glass-dim', '1');
    root.style.setProperty('--glass-blur', `${blur.toFixed(1)}px`);
    root.style.setProperty('--halo-k', g.halo.toFixed(2));
    root.style.setProperty('--wp-fx', String(faceXFor(view, false)));
    root.style.setProperty('--wp-face', String(NIGHT_FACE_IN_IMAGE));
  }, [on, visibility, glass, adaptive, view, mode, tier]);

  // The other theme's layer joins (hidden) when the browser is idle; once mounted, a layer stays.
  const [warm, setWarm] = useState(false);
  useEffect(() => {
    if (!on || warm) return;
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) {
      const h = idle(() => setWarm(true), { timeout: 5000 });
      return () => (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback?.(h);
    }
    const t = window.setTimeout(() => setWarm(true), 2500);
    return () => window.clearTimeout(t);
  }, [on, warm]);

  if (!on) {
    // 关壁纸只去掉 AI 辅助的画面和取自日景同人图的花海条；首页 / 待你的官方立绘拱窗（署名「立绘：官方 © miHoYo」）留着：
    // 昼是原来的拱窗，夜是同一张立绘、同一个版式、夜的配色（不再留一大片星点空白）.
    if (view !== 'new' && view !== 'queue') return null;
    return (
      <div className="wallpaper wallpaper--stage-only" data-view={view} aria-hidden="true">
        {mode === 'day' ? <DayStage flowers={false} /> : <NightStage />}
      </div>
    );
  }
  const credit = wallpaperFor(mode).credit;
  return (
    <div className="wallpaper" data-view={view} aria-hidden="true">
      {WALLPAPERS.filter((w) => warm || w.id === current).map((w) => <Layer key={w.id} def={w} active={w.id === current} />)}
      {mode === 'day' && (view === 'new' || view === 'queue') && <DayStage />}
      <div className="wallpaper__edges" />
      <p className="wallpaper__credit" data-credit="wallpaper" data-boot-target="credit" title={credit.label}>{view === 'new' || view === 'queue' ? credit.label : credit.short}</p>
    </div>
  );
}

function Layer({ def, active }: { def: WallpaperDef; active: boolean }) {
  const [loaded, setLoaded] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // A cached image can finish before React attaches onLoad.
  useEffect(() => { if (img.current?.complete && img.current.naturalWidth > 0) setLoaded(true); }, []);

  // 夜：骨龙遮纱（backdrop-filter + 遮罩，转场里每帧都要重做）在图加载之后、空闲时烘成一张小画布当普通叠层盖上去（见 dragVeilBake.ts）；烘不出来就保持 CSS 版本.
  const frame = useRef<HTMLDivElement>(null);
  const veil = useRef<HTMLDivElement>(null);
  const veilCv = useRef<HTMLCanvasElement>(null);
  const [baked, setBaked] = useState(false);
  useEffect(() => {
    if (def.id !== 'night' || !loaded) return;
    const f = frame.current;
    const v = veil.current;
    const cv = veilCv.current;
    const im = img.current;
    if (!f || !v || !cv || !im) return;
    let idle = 0;
    let timer = 0;
    let dead = false;
    const bake = () => {
      if (dead || !im.complete || im.naturalWidth <= 0) return;
      const fs = getComputedStyle(f);
      const vs = getComputedStyle(v);
      const frameW = parseFloat(fs.width);
      const frameH = parseFloat(fs.height);
      const dv = parseFloat(vs.getPropertyValue('--dv'));
      const dvb = parseFloat(vs.getPropertyValue('--dvb'));
      if (!(frameW > 0) || !(frameH > 0) || !(dv >= 0) || !(dvb >= 0)) return;
      const out = bakeDragVeil({ img: im, frameW, frameH, dpr: window.devicePixelRatio || 1, veilRgb: [14, 10, 34], veilAlpha: dv, blurPx: dvb });
      const ctx = out && cv.getContext('2d');
      if (!out || !ctx) return;
      cv.width = out.width;
      cv.height = out.height;
      ctx.drawImage(out, 0, 0);
      setBaked(true);
    };
    const later = () => {
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(bake, { timeout: 2500 });
      else timer = window.setTimeout(bake, 600);
    };
    later();
    // 窗口大小 / 缩放变了：布局尺寸与设备像素比跟着变，重烘（去抖）
    let last = `${f.offsetWidth}x${window.devicePixelRatio}`;
    let deb = 0;
    const onSize = () => {
      const key = `${f.offsetWidth}x${window.devicePixelRatio}`;
      if (key === last) return;
      last = key;
      window.clearTimeout(deb);
      deb = window.setTimeout(later, 350);
    };
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(onSize) : null;
    ro?.observe(f);
    window.addEventListener('resize', onSize);
    return () => {
      dead = true;
      if (idle) window.cancelIdleCallback?.(idle);
      window.clearTimeout(timer);
      window.clearTimeout(deb);
      ro?.disconnect();
      window.removeEventListener('resize', onSize);
    };
  }, [def.id, loaded]);

  const base = import.meta.env.BASE_URL;
  const srcSet = (ext: string) => def.widths.map((w) => `${base}wallpapers/${def.id}-${w}.${ext} ${w}w`).join(', ');
  return (
    <div className={cx('wallpaper__layer', `wallpaper__layer--${def.id}`, active && 'is-active', loaded && 'is-loaded')}>
      <div className="wallpaper__frame" ref={frame}>
        {/* 没有低清占位：图在本地磁盘上，几十毫秒就读完；一整幅 blur(26px) 的占位层会在 GPU 进程里撑起一整幅滤镜表面（实测多占约 100 MB 提交量），而且占位用完之后也不会还回去。 */}
        <picture>
          <source type="image/avif" srcSet={srcSet('avif')} sizes="max(100vw, 177.78vh)" />
          <source type="image/webp" srcSet={srcSet('webp')} sizes="max(100vw, 177.78vh)" />
          <img
            ref={img}
            className="wallpaper__img"
            src={`${base}wallpapers/${def.id}-2560.webp`}
            alt=""
            decoding="async"
            draggable={false}
            style={{ objectPosition: def.focus }}
            onLoad={() => setLoaded(true)}
          />
        </picture>
        {/* 夜：图向右推时左缘露出的那段羽化进底色。原来是 .wallpaper__img 上的 mask-image（整幅图成一个遮罩渲染通道，转场里每帧重做），现在是左缘 150 px 宽的一条渐变叠层. */}
        {def.id === 'night' && <div className="wallpaper__lfade" />}
        {def.id === 'night' && (
          <img
            className="wallpaper__bfpatch"
            src={`${base}boot/night-bfpatch.webp`}
            alt=""
            draggable={false}
            style={{ left: `${(NIGHT_BF_PATCH.x / NIGHT_BF_PATCH.imgW) * 100}%`, top: `${(NIGHT_BF_PATCH.y / NIGHT_BF_PATCH.imgH) * 100}%`, width: `${(NIGHT_BF_PATCH.w / NIGHT_BF_PATCH.imgW) * 100}%`, height: `${(NIGHT_BF_PATCH.h / NIGHT_BF_PATCH.imgH) * 100}%` }}
          />
        )}
        {def.id === 'night' && (
          <div className={cx('wallpaper__dragveil', baked && 'is-baked')} ref={veil}>
            <canvas ref={veilCv} />
          </div>
        )}
      </div>
      <div className="wallpaper__vig" />
      <div className="wallpaper__grade" />
    </div>
  );
}
