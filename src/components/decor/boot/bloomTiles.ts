/* 昼 · 绽开画布的「脏块」重绘（纯函数，不碰 DOM）。
   绽开画布每拍要把三张位图画上去再 destination-in 一张蒙版——整个包围盒（最大 2561 × 1601，约 4 MP）每拍填 3–4 遍。可是蒙版并集里
   · 「实心核」（某一层 α = 1，且整块落在它的内椭圆 r0 里）上一拍和这一拍都是 1，位图是静止的（立绘不动；两件近景只在画面下部）→ 画出来的像素与上一拍逐位相同；
   · 「空」（所有层都够不着）上一拍和这一拍都是 0 → 本来就是空的；
   只有蒙版的软边带（羽化 170–320 个舞台单位）、状态变了的块、近景所在的下部是真的在变。所以把画布切成 TILE × TILE 的块，只重画「脏」块（合并成矩形）：
   像素与整包围盒重绘逐位相同（块边界对齐 4 px 格，蒙版画布的取样位置不变），只是少填了实心核与空白。
   判据保守：块外扩 MARGIN 个画布像素（蒙版画布是 1/4 分辨率、放大时双线性，边缘 1–2 个蒙版像素会互相渗）再分类. */
import type { BloomLayer } from './dayBloom';

/** 块边长（画布像素；4 的倍数，好让蒙版画布的源矩形落在整格上）. */
export const TILE = 64;
/** 分类时块向外扩的画布像素（≥ 2 个蒙版像素 = 8）. */
export const MARGIN = 8;
/** 从舞台时刻 TILE_FROM（秒）起改用脏块重绘：之前蒙版的软边带覆盖大半个包围盒，分块的矩形开销（save / clip / 多次 drawImage）比省下的填充还贵（微基准：0.8 s 处分块 2.67 对整盒 2.05 ms，1.6 s 起反过来 1.95 对 2.24、2.5 s 处 1.60 对 2.25；含约 1.1 ms 的回读同步）. */
export const TILE_FROM = 1.5;
export const T_EMPTY = 0;
export const T_PART = 1;
export const T_SOLID = 2;

export interface TileGrid { cols: number; rows: number; cur: Uint8Array; prev: Uint8Array }
export interface TileRect { x: number; y: number; w: number; h: number }

export function makeGrid(cw: number, ch: number): TileGrid {
  const cols = Math.max(1, Math.ceil(cw / TILE));
  const rows = Math.max(1, Math.ceil(ch / TILE));
  return { cols, rows, cur: new Uint8Array(cols * rows), prev: new Uint8Array(cols * rows) };
}

/** 把 g.cur 填成「这一拍每个块的蒙版状态」（layers 要已经滤掉 α ≈ 0 的层；S = 画布像素 / 舞台单位）. */
export function classifyTiles(g: TileGrid, layers: readonly BloomLayer[], S: number): void {
  const n = layers.length;
  const cx = new Float64Array(n), cy = new Float64Array(n), ix = new Float64Array(n), iy = new Float64Array(n), r0 = new Float64Array(n);
  const one = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const l = layers[i];
    const r1 = Math.max(1, l.rx), r2 = Math.max(1, l.ry);
    cx[i] = l.cx; cy[i] = l.cy; ix[i] = 1 / r1; iy[i] = 1 / r2;
    r0[i] = Math.max(0, l.rx - l.f) / r1;
    one[i] = Number(l.a.toFixed(3)) >= 0.9995 ? 1 : 0;
  }
  const u = TILE / S;
  const m = MARGIN / S;
  const cur = g.cur;
  for (let ty = 0; ty < g.rows; ty++) {
    const y0 = ty * u - m, y1 = (ty + 1) * u + m;
    for (let tx = 0; tx < g.cols; tx++) {
      const x0 = tx * u - m, x1 = (tx + 1) * u + m;
      let st = T_EMPTY;
      for (let i = 0; i < n; i++) {
        const nx = cx[i] < x0 ? x0 : cx[i] > x1 ? x1 : cx[i];
        const ny = cy[i] < y0 ? y0 : cy[i] > y1 ? y1 : cy[i];
        const dx = (nx - cx[i]) * ix[i], dy = (ny - cy[i]) * iy[i];
        if (dx * dx + dy * dy >= 1) continue;                     // 够不着这一块
        if (one[i]) {
          const fx = Math.max(Math.abs(x0 - cx[i]), Math.abs(x1 - cx[i])) * ix[i];
          const fy = Math.max(Math.abs(y0 - cy[i]), Math.abs(y1 - cy[i])) * iy[i];
          if (fx * fx + fy * fy <= r0[i] * r0[i]) { st = T_SOLID; break; }
        }
        st = T_PART;
      }
      cur[ty * g.cols + tx] = st;
    }
  }
}

/** 这一拍要重画的矩形（画布像素，宽 / 高对齐到 4 的倍数、可超出画布边；合并相邻的块），并把 cur 记成下一拍的 prev。
    脏 = (这拍或上拍不空) 且 (软边 / 状态变了 / 在近景区)；nearRow = 近景区的第一行块（≥ 它的行里只要不空就一律重画：近景条与散花每拍随镜头缩放）. */
export function dirtyRects(g: TileGrid, nearRow: number, cw: number, ch: number): TileRect[] {
  const { cols, rows, cur, prev } = g;
  const out: TileRect[] = [];
  const x4 = Math.ceil(cw / 4) * 4;
  const y4 = Math.ceil(ch / 4) * 4;
  let open: TileRect[] = [];
  for (let ty = 0; ty < rows; ty++) {
    const next: TileRect[] = [];
    const yy = ty * TILE;
    let tx = 0;
    while (tx < cols) {
      const k = ty * cols + tx;
      const dirty = (cur[k] !== T_EMPTY || prev[k] !== T_EMPTY) && (cur[k] === T_PART || prev[k] === T_PART || cur[k] !== prev[k] || ty >= nearRow);
      if (!dirty) { tx++; continue; }
      let e = tx + 1;
      while (e < cols) {
        const k2 = ty * cols + e;
        const d2 = (cur[k2] !== T_EMPTY || prev[k2] !== T_EMPTY) && (cur[k2] === T_PART || prev[k2] === T_PART || cur[k2] !== prev[k2] || ty >= nearRow);
        if (!d2) break;
        e++;
      }
      const x = tx * TILE;
      const w = Math.min(e * TILE, x4) - x;
      const h = Math.min(TILE, y4 - yy);
      // 与上一行同 x、同宽的矩形合并成一个更高的
      let merged: TileRect | undefined;
      for (const r of open) if (r.x === x && r.w === w) { merged = r; break; }
      if (merged) { merged.h += h; open.splice(open.indexOf(merged), 1); next.push(merged); } else { const r = { x, y: yy, w, h }; out.push(r); next.push(r); }
      tx = e;
    }
    open = next;
  }
  g.prev.set(g.cur);
  return out;
}

/** 近景区的第一行块：近景条 / 散花（以 A 为原点放大 zn 倍，zn ≥ 1）的上沿不会高于 ay + 130·min(1, zn)（散花位图的上沿是舞台 y = 770，条是 790）. */
export function nearRowOf(S: number, ay: number, zn: number): number {
  const yTop = ay + (770 - ay) * Math.min(1, zn) - 6;
  return Math.max(0, Math.floor((yTop * S) / TILE));
}
