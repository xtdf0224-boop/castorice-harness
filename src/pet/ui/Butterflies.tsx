/* 引蝶的界面：她身边一块 340×420 的区域（桌宠窗口里，不盖屏幕别处）里飞出 5–9 只光蝶（代码画：两片翅膀按正弦扇动、带光晕），
   鼠标停住 0.6 秒，附近的会落到光标上；30 秒倒计时。怎么飞、怎么数在 gameLogic.ts（纯逻辑，有检查）。
   区域不挡点击：光标位置从页面的 mousemove 来（窗口点击穿透时 Electron 也会转发移动事件）。 */
import { useEffect, useRef, useState } from 'react';
import { ARENA_H, ARENA_W, createSim, isStill, noStill, pickCount, secondsLeft, simDone, stepSim, trackStill, type Bf, type Cursor, type Sim } from './gameLogic';
import { BUTTERFLY_SECONDS } from './games';

const TINTS = [
  { wing: '#b48ae0', edge: '#e9d8ff', glow: '180,138,224' },
  { wing: '#d7a6ff', edge: '#fff0ff', glow: '215,166,255' },
  { wing: '#9b7bd8', edge: '#d9ccff', glow: '155,123,216' },
] as const;

interface Props {
  /** 蝴蝶飞出来的地方（游戏区里的坐标，她的枝头）。 */
  origin: { x: number; y: number };
  /** 帧率上限（设置里的 30 / 60）。 */
  fpsCap: 30 | 60;
  /** 系统开了「减少动态效果」：翅膀只轻轻颤，飞行照常（游戏要玩）。 */
  reduced: boolean;
  /** 时间到，或者全落稳了。 */
  onEnd(r: { caught: number; total: number }): void;
  /** 「不玩了」。 */
  onStop(): void;
}

export function Butterflies({ origin, fpsCap, reduced, onEnd, onStop }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [hud, setHud] = useState({ left: BUTTERFLY_SECONDS, caught: 0, total: 0 });
  // 回调放进 ref：游戏循环只在挂载时起一次，结束时调最新的那个。
  const end = useRef(onEnd);
  end.current = onEnd;

  useEffect(() => {
    const el = wrap.current;
    const cv = canvas.current;
    const g = cv?.getContext('2d');
    if (!el || !cv || !g) { end.current({ caught: 0, total: 0 }); return; }
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = Math.round(ARENA_W * dpr);
    cv.height = Math.round(ARENA_H * dpr);
    const halos = TINTS.map((t) => halo(t.glow));
    const total = pickCount(Math.random);
    const sim: Sim = createSim(total, origin, Math.random);
    const startAt = performance.now();
    let still = noStill();
    let pos: { x: number; y: number } | null = null;
    let last = startAt;
    let hudKey = '';
    let raf = 0;
    let done = false;
    setHud({ left: BUTTERFLY_SECONDS, caught: 0, total });

    const move = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0) return;
      const k = ARENA_W / r.width;
      const x = (e.clientX - r.left) * k, y = (e.clientY - r.top) * k;
      if (x < 0 || y < 0 || x > ARENA_W || y > ARENA_H) { pos = null; still = noStill(); return; }
      pos = { x, y };
      still = trackStill(still, x, y, performance.now());
    };
    const leave = () => { pos = null; still = noStill(); };
    window.addEventListener('mousemove', move);
    document.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);

    const frameMs = 1000 / fpsCap - 2;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < frameMs) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const cursor: Cursor | null = pos ? { x: pos.x, y: pos.y, still: isStill(still, now) } : null;
      stepSim(sim, dt, cursor);
      draw(g, sim, halos, dpr, now / 1000, reduced);
      const key = `${secondsLeft(startAt, now, BUTTERFLY_SECONDS)}/${sim.caught}`;
      if (key !== hudKey) { hudKey = key; setHud({ left: secondsLeft(startAt, now, BUTTERFLY_SECONDS), caught: sim.caught, total }); }
      if (!done && simDone(sim, startAt, now, BUTTERFLY_SECONDS)) {
        done = true;
        cancelAnimationFrame(raf);
        end.current({ caught: sim.caught, total });
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      done = true;
      cancelAnimationFrame(raf);
      window.removeEventListener('mousemove', move);
      document.removeEventListener('mouseleave', leave);
      window.removeEventListener('blur', leave);
    };
    // 一局只起一次；起点、帧率上限、是否减少动态都取挂载时的值。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrap} className="pet-arena" aria-label="引蝶">
      <canvas ref={canvas} className="pet-arena__cv" aria-hidden />
      <div className="pet-arena__hud" role="status" aria-live="off">
        <span>{hud.total} 只 · 剩 {hud.left} 秒 · 落稳 {hud.caught}</span>
      </div>
      <button type="button" className="pet-arena__stop" data-hit onClick={onStop}>不玩了</button>
      <p className="pet-arena__tip" aria-hidden>鼠标停住不动，蝴蝶会落下来</p>
    </div>
  );
}

/** 一只光蝶的光晕：预先画成一张小图，每帧只 drawImage（比逐帧 shadowBlur 省得多）。 */
function halo(rgb: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb},0.55)`);
  grad.addColorStop(0.45, `rgba(${rgb},0.16)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

function draw(g: CanvasRenderingContext2D, sim: Sim, halos: HTMLCanvasElement[], dpr: number, t: number, reduced: boolean) {
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, ARENA_W, ARENA_H);
  for (const b of sim.bfs) {
    if (b.mode === 'wait') continue;
    wing(g, b, halos[b.tint], t, reduced);
  }
}

function wing(g: CanvasRenderingContext2D, b: Bf, halo: HTMLCanvasElement, t: number, reduced: boolean) {
  const tint = TINTS[b.tint];
  const s = 11 * b.size;
  // 翅膀张开的程度：两片翅膀按 |cos| 横向收放；减少动态时只颤一点
  const open = reduced ? 0.8 + 0.2 * Math.abs(Math.cos(b.phase)) : 0.18 + 0.82 * Math.abs(Math.cos(b.phase));
  // 飞行时头朝前进的方向；落下和落着时放正，带一点各自的小歪
  const rot = b.mode === 'perch' || b.mode === 'land' ? Math.sin(b.id * 2.1 + t * 0.6) * 0.18 : b.a + Math.PI / 2;
  g.save();
  g.translate(b.x, b.y);
  g.rotate(rot);
  g.globalAlpha = b.mode === 'perch' ? 0.95 : 0.8;
  g.drawImage(halo, -s * 2.4, -s * 2.4, s * 4.8, s * 4.8);
  g.globalAlpha = 1;
  const k = s / 12;
  for (const side of [-1, 1]) {
    g.save();
    g.scale(side * open * k, k);
    g.beginPath();
    g.moveTo(0, 0);
    g.bezierCurveTo(4, -14, 16, -17, 17, -8);
    g.bezierCurveTo(18, -1, 9, 3, 0, 1);
    g.moveTo(0, 1);
    g.bezierCurveTo(8, 3, 14, 9, 10, 14);
    g.bezierCurveTo(6, 17, 1, 9, 0, 3);
    g.closePath();
    const fill = g.createLinearGradient(0, -14, 14, 12);
    fill.addColorStop(0, tint.edge);
    fill.addColorStop(0.5, tint.wing);
    fill.addColorStop(1, '#6a4aa8');
    g.fillStyle = fill;
    g.globalAlpha = 0.92;
    g.fill();
    g.globalAlpha = 0.7;
    g.lineWidth = 0.8 / Math.max(0.3, open * k);
    g.strokeStyle = tint.edge;
    g.stroke();
    g.restore();
  }
  g.globalAlpha = 1;
  g.fillStyle = '#2a1646';
  g.beginPath();
  g.ellipse(0, 1, 1.1 * k, 6 * k, 0, 0, Math.PI * 2);
  g.fill();
  g.restore();
}
