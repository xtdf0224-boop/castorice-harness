/* 桌宠窗口的小算术（不依赖 React / DOM，scripts/pet-ui-check.ts 直接测）：窗口各块的尺寸、光标命令换成视线、
   拖动速度、她的心情怎么由当前情形定、悬停按钮要不要出现。 */
import type { PetMood } from '../contracts';

/** 窗口（页面像素，乘 scale 就是真窗口）：她 340×360，头顶 230 留给聊天框 / 气泡 / 小游戏面板。 */
export const PET_W = 340;
export const RIG_H = 360;
export const TOP_H = 230;
export const PET_H = TOP_H + RIG_H;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 主进程发来的光标位置（相对她头部中心，物理像素）→ 视线目标 -1..1（y 向下为正）。
 *  `range`：光标离她这么远（物理像素）就看到头了；随显示缩放和屏幕缩放走，所以由调用方按 scale × devicePixelRatio 给。 */
export function lookVector(dx: number, dy: number, range: number): { x: number; y: number } {
  const r = range > 0 ? range : 1;
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { x: 0, y: 0 };
  return { x: clamp(dx / r, -1, 1), y: clamp(dy / r, -1, 1) };
}

/** 拖动速度（屏幕像素 / 秒）：窗口跟着光标走，所以就是光标的速度。时间间隔太短（<4 ms）不算，免得抖。 */
export function dragSpeed(prev: { x: number; y: number; t: number }, now: { x: number; y: number; t: number }, cap = 4000): { vx: number; vy: number } | null {
  const dt = (now.t - prev.t) / 1000;
  if (dt < 0.004) return null;
  return { vx: clamp((now.x - prev.x) / dt, -cap, cap), vy: clamp((now.y - prev.y) / dt, -cap, cap) };
}

/** 声音响度（PetAudio.level()，RMS 约 0…0.35）→ 嘴 0..1。 */
export const mouthLevel = (rms: number): number => clamp(rms * 3.2, 0, 1);

export interface MoodInput {
  /** 大脑给的心情（或当前台词带的）。 */
  feel: PetMood;
  /** 她的声音正在播。 */
  speaking: boolean;
  /** 台词没有声音，但她还在「说」（嘴动一会儿）。 */
  babbling: boolean;
  /** 聊天框开着。 */
  chat: boolean;
  /** 正在看游戏画面。 */
  watching: boolean;
}

/** 木偶要摆的心情：睡着、想、高兴、害羞、惊讶保持原样；说话时是 talk；聊天框开着或在看屏时是 watch。 */
export function rigMood(i: MoodInput): PetMood {
  if (i.feel === 'sleep' || i.feel === 'think' || i.feel === 'happy' || i.feel === 'shy' || i.feel === 'surprised') return i.feel;
  if (i.speaking || i.babbling) return 'talk';
  if (i.chat || i.watching || i.feel === 'watch') return 'watch';
  return 'idle';
}

/** 点击穿透用：点 (x, y) 在她的矩形里吗。四角削掉一点（她是坐姿，矩形的角上大多是空的）。 */
export function insideFigure(box: { x: number; y: number; w: number; h: number }, x: number, y: number): boolean {
  if (box.w <= 0 || box.h <= 0) return false;
  const nx = (x - (box.x + box.w / 2)) / (box.w / 2);
  const ny = (y - (box.y + box.h / 2)) / (box.h / 2);
  return nx ** 4 + ny ** 4 <= 1;
}

/** 牌面图标的地址（相对 pet.html）。`icon` 可以是命途名（`remembrance`）、文件名（`path-remembrance.webp`）或 `art/her/…` 路径。 */
export function tarotIconSrc(icon: string): string {
  const s = icon.trim().replace(/^\.?\//, '');
  if (/\.(webp|png|svg)$/i.test(s)) return `./${s.includes('/') ? s : `art/her/${s}`}`;
  return `./art/her/path-${s.replace(/^path-/, '').replace(/[^a-z]/gi, '').toLowerCase()}.webp`;
}
