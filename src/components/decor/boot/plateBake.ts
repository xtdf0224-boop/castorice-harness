/* 昼 · 底板的烘焙：开屏的底板（薰衣草底 + 渐变底图 + 模糊的立绘光晕 + 三角纹 + 顶沿菱形 + 柔光）在绽开结束（2.7 s）之后是静止的——
   转场里它要被拆成好几份（主体 / 斜坡 / 左边一条 / 窗左缘的薄纱）各自平移，每一份原来都是一整棵带 filter:blur、遮罩、渐变的 DOM 子树（每份好几个渲染面，实测每多一份拷贝出帧率掉 10–15%）。
   这里把它一次画进一张画布（与 DOM 版同一套数值：CSS 的渐变角度、径向椭圆、模糊半径、三角纹 / 菱形平铺、遮罩渐变），转场里每份拷贝都只是一张位图（一个图层、一个绘制）。
   画布按「舞台单位」作图（k = 舞台缩放 H / 1000），再乘 R（渲染像素比）。 */

/** CSS linear-gradient(角度, 色标…) 在 w × h 的盒子里的画布渐变：渐变线过盒子中心、长度 |w·sinθ| + |h·cosθ|（θ 从「朝上」顺时针量）. */
export function cssLinear(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, deg: number, stops: ReadonlyArray<readonly [number, string]>): CanvasGradient {
  const a = (deg * Math.PI) / 180;
  const dx = Math.sin(a);
  const dy = -Math.cos(a);
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = x + w / 2;
  const cy = y + h / 2;
  const gr = g.createLinearGradient(cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  return gr;
}

/** CSS radial-gradient(rx ry at (cx, cy), 色标…)（椭圆；色标位置是沿 rx 方向的比例）：在画布上先按 ry / rx 压扁坐标系再画圆形渐变. */
export function fillCssRadial(g: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, stops: ReadonlyArray<readonly [number, string]>, x: number, y: number, w: number, h: number): void {
  g.save();
  g.translate(cx, cy);
  g.scale(1, ry / rx);
  const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  for (const [o, c] of stops) gr.addColorStop(o, c);
  g.fillStyle = gr;
  g.fillRect(x - cx, (y - cy) * (rx / ry), w, h * (rx / ry));
  g.restore();
}

/** 立绘模糊光晕（.bk：left 640 / top 140 / width 1100，blur(60px) saturate(1.1)）的低分辨率位图：四周多留 3σ = HALO_PAD 个舞台单位。
    σ = 60 个舞台单位的高斯是极低频的，没必要在全分辨率上糊——先缩到 ls（像素 / 舞台单位，通常 S/4 或 S/8）再糊（σ' = 60·ls 像素），之后合成时双线性放大，肉眼与全分辨率的糊一样；
    全分辨率上的大半径 canvas filter blur 在集显上是个几百毫秒的 GPU 活（实测排在 Present 前面，整体停顿 ≈ 500 ms）。 */
export const HALO_PAD = 180;
/** cpu = true：软件画布（willReadFrequently）——要把结果 toBlob 编成 PNG 时用：GPU 画布的 toBlob 会在主线程上 ReadbackImagePixels 等 GPU（实测一次 69 ms）；这张图只有 300 × 300 左右，CPU 上糊几毫秒. */
export function bakeHalo(bk: CanvasImageSource, bkW: number, bkH: number, ls: number, cpu = false): { cv: HTMLCanvasElement; w: number; h: number; s: number } {
  const bh = (1100 * bkH) / bkW;
  const w = 1100 + 2 * HALO_PAD;
  const h = bh + 2 * HALO_PAD;
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, Math.ceil(w * ls));
  cv.height = Math.max(2, Math.ceil(h * ls));
  const g = cv.getContext('2d', cpu ? { willReadFrequently: true } : undefined) as CanvasRenderingContext2D;
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';           // 缩小到 1/5–1/10：先低通再采样，别混叠
  g.filter = `blur(${(60 * ls).toFixed(2)}px) saturate(1.1)`;
  g.drawImage(bk, HALO_PAD * ls, HALO_PAD * ls, 1100 * ls, bh * ls);
  g.filter = 'none';
  return { cv, w, h, s: ls };
}

export interface PlateBakeInput {
  /** 舞台缩放（H / 1000）. */
  k: number;
  /** 屏幕大小（CSS px）与渲染像素比. */
  W: number;
  H: number;
  R: number;
  /** .bd-bg 的宽（舞台单位，≥ W / k）. */
  wExt: number;
  /** 模糊的立绘光晕（.bk 的 <img>，或预解码好的 ImageBitmap）、它的像素尺寸与此刻的不透明度. */
  bk: CanvasImageSource;
  bkW: number;
  bkH: number;
  bkOpacity: number;
  /** 画不画最底下那层 #d4c8e4 的薰衣草底（缺省画）。转场里它是单独的一层（`.boot__plate` / 一块纯色 div）：legacy 的底板是「底色层 + 渐变底图层」两层各按 1 − bg 的不透明度淡出，
      合在一起对下面的覆盖是 1 − bg²、颜色是 (1 − bg) · 底图 + bg · (1 − bg) · 底色 + bg² · 下面的东西——与「一张画好底色的位图按 1 − bg² 淡出」差 bg · (1 − bg) · (底图 − 底色)（最大约 7 级、偏亮偏灰），
      所以转场里底色与底图必须是两层、各自按 1 − bg 淡出。底图的盒子（wExt × 1000）铺满整屏，不画底色时位图仍是不透明的. */
  fill?: boolean;
}

const TRI = (g: CanvasRenderingContext2D) => { g.fillStyle = 'rgba(255,255,255,0.42)'; g.beginPath(); g.moveTo(5.2, 5.4); g.lineTo(10.8, 5.4); g.lineTo(8, 10.2); g.closePath(); g.fill(); };
const DIAMOND = (g: CanvasRenderingContext2D) => { g.fillStyle = 'rgba(255,255,255,0.75)'; g.beginPath(); g.moveTo(12, 1.6); g.lineTo(14.2, 4.5); g.lineTo(12, 7.4); g.lineTo(9.8, 4.5); g.closePath(); g.fill(); };

/** 平铺用的小画布：size × size 个舞台单位的一块、按 ss 倍超采样（再用 pattern.setTransform 缩回去，避免非整数像素的平铺接缝）. */
function tile(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, ss = 4): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w * ss);
  c.height = Math.round(h * ss);
  const g = c.getContext('2d') as CanvasRenderingContext2D;
  g.scale(ss, ss);
  draw(g);
  return c;
}

/** 画一张底板（屏幕大小 W × H CSS px，乘 R 个渲染像素）. */
export function bakePlate(i: PlateBakeInput): HTMLCanvasElement {
  const { k, W, H, R, wExt } = i;
  const cv = document.createElement('canvas');
  cv.width = Math.max(2, Math.round(W * R));
  cv.height = Math.max(2, Math.round(H * R));
  const g = cv.getContext('2d') as CanvasRenderingContext2D;
  const S = k * R;
  g.setTransform(S, 0, 0, S, 0, 0);
  // 薰衣草底（屏幕大小）
  if (i.fill !== false) {
    g.fillStyle = '#d4c8e4';
    g.fillRect(0, 0, W / k + 1, H / k + 1);
  }
  // ── .bd-bg（盒子 wExt × 1000，overflow:hidden）──
  g.save();
  g.beginPath();
  g.rect(0, 0, wExt, 1000);
  g.clip();
  // 背景：先 118deg 的四色线性渐变，其上一团椭圆形的暖白柔光（CSS 里先列的在上）
  g.fillStyle = cssLinear(g, 0, 0, wExt, 1000, 118, [[0, '#ddd3ee'], [0.34, '#ece6f6'], [0.58, '#f6f2fa'], [1, '#eef2fb']]);
  g.fillRect(0, 0, wExt, 1000);
  fillCssRadial(g, 992, 540, 760, 640, [[0, '#fffdf9'], [0.34, 'rgba(255,253,249,0.88)'], [0.74, 'rgba(255,253,249,0)'], [1, 'rgba(255,253,249,0)']], 0, 0, wExt, 1000);
  // .bk：立绘的模糊光晕（left 640 / top 140 / width 1100，blur(60px) saturate(1.1)，不透明度 = 绽开进度）——canvas 的 filter 半径是画布像素，不随变换缩放
  if (i.bkOpacity > 0.001 && i.bkW > 0) {
    // 光晕：低分辨率位图（S/4）放大合成（0.1.3 是在全分辨率上 blur(60 · S px)，集显上要几百毫秒 GPU）；σ = 60 个舞台单位的低频，差别在 1/255 内
    const hl = bakeHalo(i.bk, i.bkW, i.bkH, S / 4);
    g.save();
    g.globalAlpha = i.bkOpacity;
    g.imageSmoothingEnabled = true;
    g.drawImage(hl.cv, 0, 0, hl.w * hl.s, hl.h * hl.s, 640 - HALO_PAD, 140 - HALO_PAD, hl.w, hl.h);
    g.restore();
  }
  // .tri：16 px 的三角纹，不透明度 .5，遮罩 = 100deg 的 #000 → .2（55%）→ 透明
  {
    const lay = document.createElement('canvas');
    lay.width = cv.width;
    lay.height = cv.height;
    const lg = lay.getContext('2d') as CanvasRenderingContext2D;
    lg.setTransform(S, 0, 0, S, 0, 0);
    const pat = lg.createPattern(tile(16, 16, TRI), 'repeat');
    if (pat) {
      pat.setTransform(new DOMMatrix().scale(1 / 4));
      lg.fillStyle = pat;
      lg.fillRect(0, 0, wExt, 1000);
      lg.globalCompositeOperation = 'destination-in';
      lg.fillStyle = cssLinear(lg, 0, 0, wExt, 1000, 100, [[0, '#000'], [0.55, 'rgba(0,0,0,0.2)'], [1, 'rgba(0,0,0,0)']]);
      lg.fillRect(0, 0, wExt, 1000);
      g.save();
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.globalAlpha = 0.5;
      g.drawImage(lay, 0, 0);
      g.restore();
    }
  }
  // .edge：顶沿 9 px 的菱形平铺（24 × 9，水平居中）与其下 1 px 的亮线
  {
    const pat = g.createPattern(tile(24, 9, DIAMOND), 'repeat');
    if (pat) {
      const off = (((wExt - 24) / 2) % 24 + 24) % 24;
      pat.setTransform(new DOMMatrix().translate(off, 0).scale(1 / 4));
      g.fillStyle = pat;
      g.fillRect(0, 0, wExt, 9);
    }
    g.fillStyle = 'rgba(255,255,255,0.45)';
    g.fillRect(0, 9, wExt, 1);
  }
  // .bd-bg::after：118deg 的白色罩（.04 → .22（55%）→ .34）
  g.fillStyle = cssLinear(g, 0, 0, wExt, 1000, 118, [[0, 'rgba(255,255,255,0.04)'], [0.55, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0.34)']]);
  g.fillRect(0, 0, wExt, 1000);
  g.restore();
  // .s0-glow：盒子 1600 × 1000，椭圆 520 × 420，中心 (22%, 54%)，白 .7 → 72% 处透明
  fillCssRadial(g, 352, 540, 520, 420, [[0, 'rgba(255,255,255,0.7)'], [0.72, 'rgba(255,255,255,0)'], [1, 'rgba(255,255,255,0)']], 0, 0, 1600, 1000);
  return cv;
}
