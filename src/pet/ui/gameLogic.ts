/* 引蝶的纯逻辑：光蝶怎么飞、鼠标停住多久算「停住」、什么时候落到光标上、怎么数只数、倒计时。
   和 React / canvas 分开，scripts/pet-ui-check.ts 直接测它。画面在 Butterflies.tsx。
   玩法见 docs/PET-PLAN.md §5：5–9 只光蝶在她身边飞，鼠标停住 0.6 秒，附近的会落到光标上；30 秒；只数落稳了的。 */

/** 游戏区域（页面像素）：她身边的一块，在桌宠窗口里（340 宽），不盖到屏幕上别处。 */
export const ARENA_W = 340;
export const ARENA_H = 420;
/** 鼠标停住多久（毫秒）算「停住了」。 */
export const STILL_MS = 600;
/** 光标停住时，这个距离内的光蝶会被引过来。 */
export const NEAR_PX = 62;
/** 离光标这么近就落下。 */
export const LAND_PX = 9;
/** 落在光标上停满这么久才算一只。 */
export const COUNT_MS = 450;
/** 鼠标抖动不到这么远不算动（手放在鼠标上总有微小抖动）。 */
export const JITTER_PX = 6;

export type Rng = () => number;

/* ───────────── 鼠标有没有停住 ───────────── */

export interface StillState { has: boolean; x: number; y: number; at: number }
export const noStill = (): StillState => ({ has: false, x: 0, y: 0, at: 0 });

/** 收到一次鼠标位置：离锚点超过 JITTER_PX 才算动了，锚点换到这里、计时重来。 */
export function trackStill(s: StillState, x: number, y: number, now: number): StillState {
  if (!s.has || Math.hypot(x - s.x, y - s.y) > JITTER_PX) return { has: true, x, y, at: now };
  return s;
}
export const isStill = (s: StillState, now: number, ms = STILL_MS): boolean => s.has && now - s.at >= ms;

/* ───────────── 倒计时 ───────────── */

/** 还剩几秒（向上取整，给人看）。 */
export const secondsLeft = (startAt: number, now: number, seconds: number): number => Math.max(0, Math.ceil((seconds * 1000 - (now - startAt)) / 1000));
export const timeUp = (startAt: number, now: number, seconds: number): boolean => now - startAt >= seconds * 1000;

/* ───────────── 光蝶 ───────────── */

export type BfMode = 'wait' | 'fly' | 'land' | 'perch';
export interface Bf {
  id: number;
  x: number; y: number;
  /** 飞行方向（弧度）和速度（像素 / 秒）。 */
  a: number; speed: number;
  /** 翅膀相位和扇动频率（弧度 / 秒）。 */
  phase: number; flap: number;
  size: number;
  /** 0..2：三种紫（画的时候选色）。 */
  tint: number;
  mode: BfMode;
  /** wait：还要等多久（毫秒）才从枝头飞出来。 */
  delay: number;
  /** perch：已经落了多久（毫秒）；落在光标上的偏移。 */
  perchMs: number;
  ox: number; oy: number;
  /** 受惊起飞之后多久（毫秒）内不再落下。 */
  cool: number;
  /** 已经数过了（一只只数一次）。 */
  counted: boolean;
  /** 飞行时的漂移：每只自己的节奏。 */
  wob: number;
}
export interface Sim { bfs: Bf[]; total: number; caught: number; t: number }
export interface Cursor { x: number; y: number; still: boolean }

/** 这一局飞几只：5–9。 */
export const pickCount = (rng: Rng): number => 5 + Math.min(4, Math.floor(rng() * 5));

/** 开一局：蝴蝶从 `origin`（她的枝头）陆续飞出来。 */
export function createSim(total: number, origin: { x: number; y: number }, rng: Rng): Sim {
  const bfs: Bf[] = [];
  for (let i = 0; i < total; i++) {
    bfs.push({
      id: i, x: origin.x, y: origin.y,
      a: -Math.PI / 2 + (rng() - 0.5) * 2.2, speed: 38 + rng() * 34,
      phase: rng() * Math.PI * 2, flap: 11 + rng() * 5,
      size: 0.85 + rng() * 0.4, tint: Math.floor(rng() * 3),
      mode: 'wait', delay: i * 260 + rng() * 300, perchMs: 0,
      ox: (rng() - 0.5) * 22, oy: (rng() - 0.5) * 14, cool: 0, counted: false, wob: 0.6 + rng() * 1.2,
    });
  }
  return { bfs, total, caught: 0, t: 0 };
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 向 `to` 转一点（弧度，走最短的方向）。 */
function turnToward(a: number, to: number, maxStep: number): number {
  let d = (to - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + clamp(d, -maxStep, maxStep);
}

/** 往前走 `dt` 秒（秒）。`cursor`：鼠标在游戏区里的位置和有没有停住；null = 鼠标不在区里。返回现在的总数。 */
export function stepSim(sim: Sim, dt: number, cursor: Cursor | null, arena = { w: ARENA_W, h: ARENA_H }): number {
  sim.t += dt;
  const ms = dt * 1000;
  for (const b of sim.bfs) {
    b.phase += b.flap * dt * (b.mode === 'perch' ? 0.22 : 1);
    if (b.cool > 0) b.cool = Math.max(0, b.cool - ms);
    if (b.mode === 'wait') {
      b.delay -= ms;
      if (b.delay <= 0) b.mode = 'fly';
      continue;
    }
    const near = !!cursor && cursor.still && !b.counted && b.cool <= 0 && Math.hypot(cursor.x - b.x, cursor.y - b.y) <= NEAR_PX;
    if (b.mode === 'perch') {
      const stay = !!cursor && Math.hypot(cursor.x + b.ox - b.x, cursor.y + b.oy - b.y) < 16 + (cursor.still ? 40 : 0);
      if (!cursor || !stay) {
        // 光标动了（或没了）：受惊起飞
        b.mode = 'fly'; b.cool = 1600; b.perchMs = 0;
        b.a = -Math.PI / 2 + Math.sin(sim.t * 13 + b.id * 2.3) * 1.1; b.speed = 70;
      } else {
        b.x += (cursor.x + b.ox - b.x) * Math.min(1, dt * 14);
        b.y += (cursor.y + b.oy - b.y) * Math.min(1, dt * 14);
        b.perchMs += ms;
        if (!b.counted && b.perchMs >= COUNT_MS) { b.counted = true; sim.caught += 1; }
        continue;
      }
    }
    if (b.mode === 'land') {
      if (!near || !cursor) b.mode = 'fly';
      else {
        const dx = cursor.x + b.ox - b.x, dy = cursor.y + b.oy - b.y, d = Math.hypot(dx, dy);
        if (d <= LAND_PX) { b.mode = 'perch'; b.perchMs = 0; continue; }
        // 越近越慢，轻飘飘地靠过去
        const sp = clamp(d * 2.6, 26, 120);
        b.x += (dx / d) * sp * dt;
        b.y += (dy / d) * sp * dt;
        b.a = Math.atan2(dy, dx);
        continue;
      }
    }
    if (near && b.mode === 'fly') { b.mode = 'land'; continue; }
    // fly：漂着飞，碰到边缘就往回拐一点
    b.a += Math.sin(sim.t * b.wob * 2.1 + b.id * 1.7) * 1.6 * dt;
    const margin = 26;
    if (b.x < margin || b.x > arena.w - margin || b.y < margin || b.y > arena.h - margin) {
      b.a = turnToward(b.a, Math.atan2(arena.h * 0.5 - b.y, arena.w * 0.5 - b.x), 3.2 * dt);
    }
    // 起飞的冲劲慢慢退回平时的速度
    const base = 34 + (b.id % 3) * 9;
    b.speed += (base - b.speed) * Math.min(1, dt * 1.6);
    b.x = clamp(b.x + Math.cos(b.a) * b.speed * dt, 4, arena.w - 4);
    b.y = clamp(b.y + Math.sin(b.a) * b.speed * dt, 4, arena.h - 4);
  }
  return sim.caught;
}

/** 这一局结束了吗：时间到，或者全落稳了。 */
export const simDone = (sim: Sim, startAt: number, now: number, seconds: number): boolean => sim.caught >= sim.total || timeUp(startAt, now, seconds);
