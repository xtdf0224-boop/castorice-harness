/* 夜景壁纸的「骨龙遮纱」烘焙。

   decor.css 的 .wallpaper__dragveil 是一块 backdrop-filter: blur(5px) + 暗纱底色 + 四个径向渐变遮罩的元素，盖在龙头与肋骨上。它糊的东西永远是同一张静态壁纸，
   可 backdrop-filter 加遮罩在合成器里是「每一帧都要重做」的渲染通道（读一次背板、模糊、再套一次遮罩）：夜的转场里壁纸层在平移 / 缩放，
   这一块在冻结帧基准里占单帧代价的 1.3–2.9 ms（离屏测量台的转场里，它是夜快速版出帧掉到 120–180 fps 的一大块）。
   所以：壁纸图加载之后，在空闲时把它的结果画进一张小画布里——颜色 = 暗纱盖在模糊图上，alpha = 遮罩——当成普通的叠层盖在壁纸上：
       叠层 over 壁纸 = m · (暗纱 over 模糊(壁纸)) + (1 − m) · 壁纸
   与元素原来的合成结果是同一个式子（BF 的结果被元素自己的遮罩裁一次，再与背板按遮罩混合），只是模糊在画布里算一次，不再每帧算。
   烘不出来（画布不可用 / 图没好）时 CSS 里的 backdrop-filter 版本照旧工作，什么也不变。

   下面的几何、色标与 decor.css 里的 .wallpaper__dragveil 一一对应（单位 u = 图宽 / 1778；遮罩椭圆的圆心已减去元素的左缘 359）. */

/** 元素外接框（图坐标，单位 u）：左缘、宽、高；上缘就是图的上缘. */
export const VEIL_BOX = { x: 359, w: 1086, h: 356, units: 1778 } as const;

export interface VeilEllipse { cx: number; cy: number; rx: number; ry: number; stop: number }
/** 四个径向渐变遮罩（`#000 stop, transparent 100%`），并集（mask-composite 默认 add = source-over）. */
export const VEIL_ELLIPSES: readonly VeilEllipse[] = [
  { cx: 484 - 359, cy: 216, rx: 125, ry: 132, stop: 0.56 },
  { cx: 765 - 359, cy: 178, rx: 232, ry: 178, stop: 0.5 },
  { cx: 830 - 359, cy: 54, rx: 310, ry: 88, stop: 0.48 },
  { cx: 1175 - 359, cy: 42, rx: 270, ry: 78, stop: 0.42 },
];

/** 单个椭圆渐变在 (x, y)（单位 u，相对元素左上角）处的 alpha：到 stop 之前不透明，之后线性掉到 0（r = 1）. */
export function ellipseAlpha(e: VeilEllipse, x: number, y: number): number {
  const r = Math.hypot((x - e.cx) / e.rx, (y - e.cy) / e.ry);
  if (r <= e.stop) return 1;
  if (r >= 1) return 0;
  return (1 - r) / (1 - e.stop);
}
/** 四个遮罩的并集 alpha（source-over：1 − Π(1 − aᵢ)）. */
export function veilMaskAlpha(x: number, y: number): number {
  let keep = 1;
  for (const e of VEIL_ELLIPSES) keep *= 1 - ellipseAlpha(e, x, y);
  return 1 - keep;
}

export interface VeilBakeInput {
  /** 已加载的壁纸 <img>（用它当前选中的那个候选图的像素）. */
  img: CanvasImageSource & { naturalWidth: number; naturalHeight: number };
  /** 壁纸框（.wallpaper__frame）的布局尺寸，CSS px，不受 transform 影响. */
  frameW: number;
  frameH: number;
  dpr: number;
  /** 暗纱底色的 rgb 与不透明度（decor.css 的 --dv 与 background）. */
  veilRgb: readonly [number, number, number];
  veilAlpha: number;
  /** 模糊半径（--dvb，CSS px）. */
  blurPx: number;
}

/** 烘焙画布的像素尺寸（= 元素的外接框 × dpr，四舍五入）. */
export function veilPixelSize(frameW: number, dpr: number): { w: number; h: number; u: number } {
  const u = frameW / VEIL_BOX.units;
  return { w: Math.max(1, Math.round(VEIL_BOX.w * u * dpr)), h: Math.max(1, Math.round(VEIL_BOX.h * u * dpr)), u };
}

const mk = (w: number, h: number): HTMLCanvasElement => {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
};

/** 烘出遮纱叠层（不透明度已含在像素的 alpha 里；以 1:1 铺在元素外接框上）. 失败返回 null. */
export function bakeDragVeil(o: VeilBakeInput): HTMLCanvasElement | null {
  try {
    const { w, h, u } = veilPixelSize(o.frameW, o.dpr);
    if (!(o.img.naturalWidth > 0) || !(o.img.naturalHeight > 0)) return null;
    const sigma = o.blurPx * o.dpr;                          // backdrop-filter 的 blur(r) 是设备像素里的标准差 r × 缩放
    const md = Math.ceil(sigma * 3.2);                       // 模糊的边界余量
    const ww = w + 2 * md;
    const wh = h + 2 * md;
    // 1) 工作画布：外接框 + 余量范围内的壁纸（设备像素）。只用「目标矩形」形式的 drawImage（不给源矩形：带 srcset 的 <img>，
    //    源矩形的坐标系是密度校正后的 naturalWidth 还是解码位图的像素，实现之间不一致），把整幅图按设备像素平铺到工作画布上、被画布裁掉多余部分。
    //    上缘外面没有图——backdrop-filter 的边缘模式是镜像，这里也镜像（上缘处遮罩不为 0，其余三边遮罩≈0）
    const work = mk(ww, wh);
    const wc = work.getContext('2d');
    if (!wc) return null;
    wc.imageSmoothingEnabled = true;
    wc.imageSmoothingQuality = 'high';
    const Wd = o.frameW * o.dpr;                              // 整幅图在设备像素里的尺寸
    const Hd = o.frameH * o.dpr;
    const ox = md - VEIL_BOX.x * u * o.dpr;                   // 图的左缘在工作画布里的 x
    wc.drawImage(o.img, ox, md, Wd, Hd);
    wc.save();                                                // 上余量 = 图上缘往下 md 行的镜像
    wc.setTransform(1, 0, 0, -1, 0, md);
    wc.drawImage(o.img, ox, 0, Wd, Hd);
    wc.restore();
    // 2) 模糊
    const blurred = mk(ww, wh);
    const bc = blurred.getContext('2d');
    if (!bc) return null;
    bc.filter = `blur(${sigma}px)`;
    bc.drawImage(work, 0, 0);
    bc.filter = 'none';
    // 3) 结果画布：裁回外接框 → 盖暗纱底色 → 用遮罩并集裁 alpha
    const out = mk(w, h);
    const oc = out.getContext('2d');
    if (!oc) return null;
    oc.drawImage(blurred, md, md, w, h, 0, 0, w, h);
    oc.fillStyle = `rgb(${o.veilRgb[0]} ${o.veilRgb[1]} ${o.veilRgb[2]} / ${o.veilAlpha})`;
    oc.fillRect(0, 0, w, h);
    const mask = mk(w, h);
    const mc = mask.getContext('2d');
    if (!mc) return null;
    const dpx = w / (VEIL_BOX.w * u);                         // 每 CSS px 的画布像素（≈ dpr）
    const dpy = h / (VEIL_BOX.h * u);
    for (const e of VEIL_ELLIPSES) {
      mc.save();
      mc.setTransform(e.rx * u * dpx, 0, 0, e.ry * u * dpy, e.cx * u * dpx, e.cy * u * dpy);
      const g = mc.createRadialGradient(0, 0, 0, 0, 0, 1);
      g.addColorStop(0, 'rgb(0 0 0 / 1)');
      g.addColorStop(e.stop, 'rgb(0 0 0 / 1)');
      g.addColorStop(1, 'rgb(0 0 0 / 0)');
      mc.fillStyle = g;
      mc.fillRect(-2, -2, 4, 4);                              // 变换后覆盖整个椭圆（渐变在 r > 1 处是透明的）
      mc.restore();
    }
    oc.globalCompositeOperation = 'destination-in';
    oc.drawImage(mask, 0, 0);
    oc.globalCompositeOperation = 'source-over';
    return out;
  } catch {
    return null;
  }
}
