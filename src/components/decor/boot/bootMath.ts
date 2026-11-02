/* 开屏的小数学：缓动、三次贝塞尔路径、确定性随机数、渐变生成。
   所有视觉状态都是时间 t 的纯函数——这里没有任何 Math.random / Date.now，逐帧导出与实时播放逐像素一致。 */

export const TAU = Math.PI * 2;

export const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const sstep = (x: number) => { const t = clamp(x); return t * t * (3 - 2 * t); };
/** 把 t 落在 [a, b] 里的进度夹到 0–1. */
export const win = (t: number, a: number, b: number) => clamp((t - a) / (b - a));

/** 缓动曲线：函数本身，加上它「可以原生表达」的 cubic-bezier 四元组（合成器路径里 WAAPI 关键帧直接用这条曲线，不必采样）. */
export type Ease = ((t: number) => number) & { readonly bezier?: readonly [number, number, number, number] };
/** smoothstep（sstep）恰好是 cubic-bezier(1/3, 0, 2/3, 1)：x(s) = s，y(s) = 3s² − 2s³. */
export const SSTEP_BEZIER = [1 / 3, 0, 2 / 3, 1] as const;

/** CSS cubic-bezier(x1, y1, x2, y2) 的求值（二分法，22 次迭代足够）. */
export function cubic(x1: number, y1: number, x2: number, y2: number): Ease {
  const f = (t: number): number => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0;
    let hi = 1;
    let m = 0.5;
    for (let i = 0; i < 22; i++) {
      m = (lo + hi) / 2;
      const x = 3 * (1 - m) * (1 - m) * m * x1 + 3 * (1 - m) * m * m * x2 + m * m * m;
      if (x < t) lo = m; else hi = m;
    }
    return 3 * (1 - m) * (1 - m) * m * y1 + 3 * (1 - m) * m * m * y2 + m * m * m;
  };
  return Object.assign(f, { bezier: [x1, y1, x2, y2] as const });
}

/** 分镜 §1.4 的缓动曲线表. */
export const E = {
  ease: cubic(0.22, 0.8, 0.24, 1),
  inout: cubic(0.65, 0, 0.35, 1),
  camera: cubic(0.4, 0.3, 0.4, 1),
  flight: cubic(0.45, 0.05, 0.3, 1),
  settle: cubic(0.2, 0.7, 0.2, 1),
  out: cubic(0, 0, 0.58, 1),
};

/** 枝上白花：先放大到 1.25 倍再回落到 1（开花要有「落下来」的一拍）. */
export const popCurve = (p: number) => (p <= 0 ? 0 : p < 0.45 ? 1.25 * E.ease(p / 0.45) : 1.25 - 0.25 * sstep((p - 0.45) / 0.55));

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Pt = readonly [number, number];
export type Seg = readonly [Pt, Pt, Pt, Pt];

export function bez(g: Seg, t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * u * g[0][0] + 3 * u * u * t * g[1][0] + 3 * u * t * t * g[2][0] + t * t * t * g[3][0],
    u * u * u * g[0][1] + 3 * u * u * t * g[1][1] + 3 * u * t * t * g[2][1] + t * t * t * g[3][1],
  ];
}
export function bezD(g: Seg, t: number): [number, number] {
  const u = 1 - t;
  return [
    3 * u * u * (g[1][0] - g[0][0]) + 6 * u * t * (g[2][0] - g[1][0]) + 3 * t * t * (g[3][0] - g[2][0]),
    3 * u * u * (g[1][1] - g[0][1]) + 6 * u * t * (g[2][1] - g[1][1]) + 3 * t * t * (g[3][1] - g[2][1]),
  ];
}
export function pathAt(segs: readonly Seg[], q: number): { p: [number, number]; d: [number, number] } {
  const tt = clamp(q, 0, 0.9999) * segs.length;
  const si = Math.floor(tt);
  return { p: bez(segs[si], tt - si), d: bezD(segs[si], tt - si) };
}
/** 飞行曲线的反函数：路径进度 q → 归一化时间. */
export function invFlight(q: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (E.flight(m) < q) lo = m; else hi = m;
  }
  return (lo + hi) / 2;
}

/** 缓出渐变的 CSS 色标：在 a0 → a1 之间按 smoothstep 取 n 个点，两端斜率为 0。
    线性渐变在两端有「马赫带」（一条看得见的折线），暗纱与暗角用它代替线性色标，边缘才会羽化得干净。 */
export function easedStops(rgb: string, a0: number, a1: number, n = 12, from = 0, to = 100): string {
  const out: string[] = [];
  for (let i = 0; i <= n; i++) {
    const p = i / n;
    const a = a0 + (a1 - a0) * sstep(p);
    out.push(`rgb(${rgb} / ${a.toFixed(4)}) ${(from + (to - from) * p).toFixed(2)}%`);
  }
  return out.join(', ');
}

/** 一块可平铺的细噪点（白点、α 0–3/255），盖在暗纱之上，把 8 位里的等高线打散成颗粒；返回 PNG 的 data: URL. */
export function grainTile(size = 192, seed = 1357): string {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const g = c.getContext('2d');
  if (!g) return '';
  const img = g.createImageData(size, size);
  const r = mulberry32(seed);
  for (let i = 0; i < size * size; i++) {
    const a = r() + r();                       // 三角分布 0–2
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.floor(a * 1.6);  // 0–3
  }
  g.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

/** 窗口宽高比在 [1.15, 2.10] 之内才播完整动画：太宽（> 2.10）夜景落点会被裁掉，太窄（< 1.15）她与落点放不进同一画面。 */
export const aspectOk = (w: number, h: number) => { const a = w / Math.max(1, h); return a >= 1.15 && a <= 2.1; };
