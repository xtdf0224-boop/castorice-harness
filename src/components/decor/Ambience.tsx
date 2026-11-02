/* Ambience —— 取代萤火的星空与萤火虫：极淡的落雪 + 偶尔一只蝶 + 完成时一只蝶停落。

   落雪（canvas，夹在壁纸与玻璃之间）
     · 种子固定的静态雪点永远在（一帧，不动，几乎零成本）；
     · 只有「等待态」才真的落：有须你亲批的审批、待回答的问题、待批准的计划时，雪点以 12–30 px/s 缓缓下落；
       一旦没有要等你的事，立即静止。
     · 有时限，也看有没有人在：等待满 2 分钟后落雪逐渐慢下来、20 秒内停住（之后只剩静态雪点，不再有 rAF）；
       窗口失焦（或不可见）超过 15 秒就停；阁下回来（重新聚焦 / 重新可见）再落一阵，时限从头计。
       （代码审查：原先等待态的落雪既没有时限，也不管有没有人在看。）
   蝶（同一块 canvas）
     · 偶尔飞过一只蓝闪蝶，20–40 px/s，沿缓慢游走的路径；同屏 ≤ 5 只（实际最多 2 只），生命 ≤ 28 s，淡入淡出。
   预算
     · 三档：A 省电（集显 / 电池）= 只有静态雪点，不飞蝶、不落雪；B 标准 = 以上全部；
       「背景粒子」设置 off = 什么都不画；减少动态 = 只有静态雪点。
     · 帧率封顶 30、DPR ≤ 1.5、页面隐藏即停（visibilitychange）、被全屏程序盖住也停（useWindowCovered）、没有要动的东西时不跑 rAF。
   完成时（ButterflyLanding，DOM + WAAPI）
     · 一只蝶沿曲线飞到完成的那个状态标签上，停落约 1.2 s 后淡去，只一次；
       减少动态时是一只已经停落的蝶。 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { usePageVisible, useReducedMotion, useWindowCovered } from '../../lib/hooks';
import type { Celebration } from '../../lib/types';
import { actions } from '../../state/actions';
import { currentRun } from '../../state/selectors';
import { shallow, store, useApp } from '../../state/store';
import { BLUR_GRACE_MS, fallIntensity } from './fallLimits';
import { FRAME_P95_LIMIT_MS, FRAME_SAMPLE, motionHealth, percentile } from './motionHealth';

/* ───────────── deterministic data ───────────── */

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Flake { u: number; v: number; r: number; a: number; vy: number; sway: number; phase: number }
interface Soft { u: number; v: number; r: number; a: number }
const MAX_FLAKES = 140;
const MAX_SOFT = 10;
let flakePool: Flake[] | undefined;
let softPool: Soft[] | undefined;

function getFlakes(): Flake[] {
  if (flakePool) return flakePool;
  const rnd = mulberry32(0x5e11a9);
  flakePool = Array.from({ length: MAX_FLAKES }, () => {
    const q = rnd();
    return {
      u: rnd(), v: rnd(),
      r: 0.7 + q * q * q * 2.3,            // 大多数是很小的点
      a: 0.18 + rnd() * 0.32,              // 0.18–0.5（装饰层整体不透明度 ≤ 0.5）
      vy: 12 + rnd() * 18,                 // 12–30 px/s
      sway: 2 + rnd() * 6,
      phase: rnd() * Math.PI * 2,
    };
  });
  return flakePool;
}
function getSoft(): Soft[] {
  if (softPool) return softPool;
  const rnd = mulberry32(0x71e5);
  softPool = Array.from({ length: MAX_SOFT }, () => ({ u: rnd(), v: rnd(), r: 3.4 + rnd() * 3, a: 0.1 + rnd() * 0.12 }));
  return softPool;
}

/* ───────────── sprites ───────────── */

const WING_PATHS = [
  'M20 15.2C17.2 7.2 9.6 2 4.6 4.2 2 5.5 2.6 10.8 7.2 15.4c3.5 3 8 2.4 12.8-.2z',
  'M20 16.6C14.9 16.8 9 19.2 8.8 24c-.1 4.4 4.2 5.8 7.2 3.2 2.6-2.3 3.5-6.6 4-10.6z',
  'M20 15.2c2.8-8 10.4-13.2 15.4-11 2.6 1.3 2 6.6-2.6 11.2-3.5 3-8 2.4-12.8-.2z',
  'M20 16.6c5.1.2 11 2.6 11.2 7.4.1 4.4-4.2 5.8-7.2 3.2-2.6-2.3-3.5-6.6-4-10.6z',
];

/** 蓝闪蝶精灵：40×32 的图 ×2，加一圈柔光。 */
function makeButterflySprite(): HTMLCanvasElement {
  const S = 2;
  const pad = 14;
  const c = document.createElement('canvas');
  c.width = (40 + pad * 2) * S;
  c.height = (32 + pad * 2) * S;
  const g = c.getContext('2d')!;
  g.scale(S, S);
  g.translate(pad, pad);
  const halo = g.createRadialGradient(20, 16, 2, 20, 16, 30);
  halo.addColorStop(0, 'rgba(124,200,247,0.34)');
  halo.addColorStop(1, 'rgba(124,200,247,0)');
  g.fillStyle = halo;
  g.fillRect(-pad, -pad, 40 + pad * 2, 32 + pad * 2);
  const grad = g.createLinearGradient(0, 4, 0, 28);
  grad.addColorStop(0, '#62cdf0');
  grad.addColorStop(0.55, '#6f9aee');
  grad.addColorStop(1, '#7a63e0');
  g.lineJoin = 'round';
  g.fillStyle = grad;
  g.strokeStyle = '#1b1e52';
  g.lineWidth = 2;
  for (const d of WING_PATHS) {
    const p = new Path2D(d);
    g.fill(p);
    g.stroke(p);
  }
  g.lineCap = 'round';
  g.lineWidth = 2.2;
  g.beginPath();
  g.moveTo(20, 9.6);
  g.lineTo(20, 27);
  g.stroke();
  return c;
}

/* ───────────── state → config ───────────── */

/** 等待态：有要等你的事（审批、问题、计划批准）。不分配、不排序：每次 store 更新都会跑它。 */
export function isWaiting(s: ReturnType<typeof store.get>): boolean {
  for (const id in s.runs) {
    const r = s.runs[id];
    if (r.planApproval?.status === 'pending') return true;
    for (const a of r.approvals) if (a.status === 'pending') return true;
    if (r.questions) for (const q of r.questions) if (q.status === 'pending') return true;
  }
  return false;
}

interface Fly { x: number; y: number; heading: number; speed: number; wander: number; wphase: number; flap: number; born: number; ttl: number }

const FRAME_MS = 1000 / 30 - 3;
const DPR_CAP = 1.5;
const MAX_BUTTERFLIES = 5;      // 硬上限（规格：同屏 ≤ 5 只）；实际调度最多 2 只
const MAX_CONCURRENT = 2;

export function Ambience() {
  const ref = useRef<HTMLCanvasElement>(null);
  const mode = useApp((s) => s.settings.mode);
  const density = useApp((s) => s.settings.particles);
  const tier = useApp((s) => s.settings.motionTier);
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  // 被全屏程序盖住（lib/windowVisibility.ts）：和隐藏一样不动，只留静态雪点
  const covered = useWindowCovered();
  const waiting = useApp(isWaiting);
  const peek = useApp((s) => !!s.peek);
  const degraded = useSyncExternalStore(motionHealth.subscribe, motionHealth.get, motionHealth.get);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const night = mode !== 'day';
    const flakes = getFlakes();
    const softs = getSoft();
    let W = 0;
    let H = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let timeNow = 0;
    const rnd = mulberry32((Date.now() >>> 0) ^ 0x9e3779b1);
    const flies: Fly[] = [];
    let navRight = 0;                         // 左栏右缘（px）；量不到就是 0，蝶不避让
    const measureNav = () => {
      const r = document.querySelector('.side-nav')?.getBoundingClientRect();
      navRight = r && r.width > 0 && r.left < 8 ? r.right : 0;
    };
    let sprite: HTMLCanvasElement | undefined;
    const ys = new Float32Array(MAX_FLAKES);  // 下落时的 y（px）

    const countFor = () => {
      if (density === 'off') return 0;
      const area = (W * H) / 25000;           // 1600×1000 → 64
      return Math.min(MAX_FLAKES, Math.round(area * (density === 'low' ? 0.5 : 1)));
    };
    const resetYs = () => { for (let i = 0; i < MAX_FLAKES; i++) ys[i] = flakes[i].v * H; };

    const resize = () => {
      dpr = Math.min(DPR_CAP, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      measureNav();
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      resetYs();
      draw(0);
    };

    const flake = night ? '238,240,255' : '150,128,196';
    const softc = night ? '238,240,255' : '170,150,214';

    function draw(dt: number, fall = 1) {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, W, H);
      const n = countFor();
      const falling = dt > 0 && motion.fall;
      for (let i = 0; i < n; i++) {
        const f = flakes[i];
        let y = ys[i];
        if (falling) { y += f.vy * dt * fall; if (y > H + 6) y -= H + 12; ys[i] = y; }
        // 横摆也乘强度：停下的那一刻摆幅正好是 0，不会「跳」一下
        const x = f.u * W + (falling ? Math.sin(timeNow * 0.0003 + f.phase) * f.sway * fall : 0);
        ctx!.fillStyle = `rgba(${flake},${(night ? f.a : f.a * 0.9).toFixed(2)})`;
        ctx!.beginPath();
        ctx!.arc(x, y, f.r, 0, Math.PI * 2);
        ctx!.fill();
      }
      if (n > 0) {
        for (let i = 0; i < Math.min(MAX_SOFT, Math.round(n / 8)); i++) {
          const s = softs[i];
          const g = ctx!.createRadialGradient(s.u * W, s.v * H, 0, s.u * W, s.v * H, s.r * 2.2);
          g.addColorStop(0, `rgba(${softc},${s.a.toFixed(2)})`);
          g.addColorStop(1, `rgba(${softc},0)`);
          ctx!.fillStyle = g;
          ctx!.fillRect(s.u * W - s.r * 2.2, s.v * H - s.r * 2.2, s.r * 4.4, s.r * 4.4);
        }
      }
      // 蝶
      if (flies.length && sprite) {
        for (const b of flies) {
          const age = timeNow - b.born;
          // 左栏是交互区：蝶飞到它上面就渐隐（左栏是半透明玻璃，下面的蝶会盖在图标上，看起来像停在图标上）。
          const clear = navRight > 0 ? Math.min(1, Math.max(0, (b.x - navRight - 8) / 56)) : 1;
          const fade = Math.min(1, age / 2200, (b.ttl - age) / 2600, clear);
          if (fade <= 0) continue;
          const flapX = 0.38 + 0.62 * Math.abs(Math.cos(b.flap));
          ctx!.save();
          ctx!.globalAlpha = Math.max(0, Math.min(1, fade)) * (night ? 0.9 : 0.8);
          ctx!.translate(b.x, b.y);
          ctx!.rotate(b.heading + Math.PI / 2);
          const w = sprite.width / 2 * 0.62;
          const h = sprite.height / 2 * 0.62;
          ctx!.drawImage(sprite, (-w / 2) * flapX, -h / 2, w * flapX, h);
          ctx!.restore();
        }
      }
    }

    const motion = {
      fall: !reduced && !degraded && tier === 'B' && density !== 'off' && waiting && visible && !covered && !peek,
      fly: !reduced && !degraded && tier === 'B' && density !== 'off' && visible && !covered && !peek,
    };

    const spawn = () => {
      if (flies.length >= Math.min(MAX_BUTTERFLIES, MAX_CONCURRENT)) return;
      // 从屏幕左右缘外侧进来，往对侧缓缓游走
      measureNav();
      const fromLeft = rnd() < 0.5;
      const y = H * (0.25 + rnd() * 0.5);
      flies.push({
        x: fromLeft ? (navRight > 0 ? navRight + 20 : -20) : W + 20,
        y,
        heading: fromLeft ? (rnd() - 0.5) * 0.6 : Math.PI + (rnd() - 0.5) * 0.6,
        speed: 20 + rnd() * 20,                      // 20–40 px/s
        wander: 0.5 + rnd() * 0.5,
        wphase: rnd() * 6.28,
        flap: rnd() * 6.28,
        born: timeNow,
        ttl: Math.min(28000, (W / 30) * 1000),
      });
    };

    let startedAt = 0;
    const start = () => {
      if (raf) return;
      last = performance.now();
      startedAt = last;
      raf = requestAnimationFrame(tick);
    };

    // 谁在看：等待计时从这次等待（或这次回来）算起，只在窗口聚焦时往下数；失焦太久就停
    let waitStart = performance.now();
    let blurredAt = document.hasFocus() ? 0 : performance.now();
    const away = (t: number) => blurredAt > 0 && t - blurredAt > BLUR_GRACE_MS;
    const onBlur = () => { blurredAt = performance.now(); };
    const onFocus = () => {
      const was = blurredAt > 0 ? performance.now() - blurredAt : 0;
      blurredAt = 0;
      if (was > BLUR_GRACE_MS) waitStart = performance.now();      // 阁下回来了：再落一阵，时限从头计
      if (motion.fall || flies.length) start();
    };

    const gaps: number[] = [];
    function tick(t: number) {
      if (t - last < FRAME_MS) { raf = requestAnimationFrame(tick); return; }
      const gap = t - last;
      const dt = Math.min(0.1, gap / 1000);
      last = t;
      // 帧耗时 p95 降级：相邻两次绘制的间隔，跳过刚起步的 12 帧；p95 > 50 ms 就降为静态（X12）
      if (gaps.length > 0 || t - startedAt > 400) {
        gaps.push(gap);
        if (gaps.length >= FRAME_SAMPLE) {
          if (percentile(gaps, 0.95) > FRAME_P95_LIMIT_MS) { motionHealth.set(true); return; }
          gaps.length = 0;
        }
      }
      timeNow = t;
      for (const b of flies) {
        const age = t - b.born;
        b.wphase += dt * (0.7 + b.wander * 0.5);
        b.heading += Math.sin(b.wphase) * 0.55 * dt;      // 缓慢游走
        // 靠近左栏就掉头往主区飞，不再穿过去
        if (navRight > 0 && b.x < navRight + 40 && Math.cos(b.heading) < 0) b.heading = Math.PI - b.heading;
        b.x += Math.cos(b.heading) * b.speed * dt;
        b.y += Math.sin(b.heading) * b.speed * dt;
        b.flap += dt * 9;                                  // 约 1.4 Hz 拍翅
        if (b.y < 40) b.heading += 0.9 * dt; else if (b.y > H - 40) b.heading -= 0.9 * dt;
        if (age > b.ttl) b.ttl = -1;
      }
      for (let i = flies.length - 1; i >= 0; i--) if (flies[i].ttl < 0) flies.splice(i, 1);
      const k = motion.fall ? fallIntensity(t - waitStart) : 0;
      draw(dt, k);
      // 没有要动的东西就停 rAF：静态雪点那一帧已经画在 canvas 上了。
      // 落雪等够了（k = 0）、或窗口失焦太久，也停；回来时 onFocus 再起。
      const moving = (motion.fall && k > 0) || flies.length > 0;
      raf = moving && !away(t) ? requestAnimationFrame(tick) : 0;
    }

    // 蝶不靠 rAF 空转等：用定时器排下一次出现，出现时才起 rAF
    let spawnTimer = 0;
    const scheduleSpawn = (ms: number) => {
      spawnTimer = window.setTimeout(() => { timeNow = performance.now(); spawn(); start(); scheduleSpawn(45000 + rnd() * 65000); }, ms);
    };

    resize();
    const onResize = () => resize();
    window.addEventListener('resize', onResize);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    if (motion.fly) { sprite = makeButterflySprite(); scheduleSpawn(12000 + rnd() * 14000); }
    if (motion.fall) start();
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
      window.clearTimeout(spawnTimer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [mode, density, tier, reduced, visible, covered, waiting, peek, degraded]);

  return <canvas ref={ref} className="ambience" aria-hidden="true" />;
}

/* ═════════════════ 完成时一只蝶停落 ═════════════════ */

const FRESH_MS = 6000;           // 太旧的庆祝（比如恢复的状态）直接忽略
const FLIGHT_MS = 1500;
const REST_MS = 1200;
const FADE_MS = 400;
const STATIC_MS = 1400;

interface Anchor { x: number; y: number; found: boolean }

/** 用户正在看刚完成的那个运行吗？只有那时页面上的状态标签才是「它的」标签。 */
function isWatching(runId: string): boolean {
  const s = store.get();
  return s.view === 'task' && currentRun(s)?.id === runId;
}

/** 目标：第一个可见的 [data-celebrate-target] 的右上角；找不到就落在主区上沿偏右处。 */
function findAnchor(useTarget: boolean): Anchor {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
  let fallback: DOMRect | undefined;
  const targets = useTarget ? Array.from(document.querySelectorAll<HTMLElement>('[data-celebrate-target]')) : [];
  for (const el of targets) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || el.getClientRects().length === 0) continue;
    const inView = r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    if (inView) return { x: clamp(r.right - 6, 24, vw - 24), y: clamp(r.top + 2, 24, vh - 24), found: true };
    fallback ??= r;
  }
  if (fallback) return { x: clamp(fallback.right - 6, 24, vw - 24), y: clamp(fallback.top + 2, 24, vh - 24), found: true };
  const main = document.getElementById('main')?.getBoundingClientRect();
  if (main && main.width > 0) return { x: clamp(main.right - 90, 24, vw - 24), y: clamp(main.top + 60, 24, vh - 24), found: false };
  return { x: vw / 2, y: vh / 2, found: false };
}

export function ButterflyLanding() {
  const celebration = useApp((s) => s.celebration, shallow);
  const reduced = useReducedMotion();
  const reducedRef = useRef(reduced);
  reducedRef.current = reduced;
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!celebration || !root) return;
    const c: Celebration = celebration;
    if (Date.now() - c.at > FRESH_MS || document.hidden) { actions.clearCelebration(); return; }

    const anchor = findAnchor(isWatching(c.runId));
    const el = document.createElement('div');
    el.className = 'landing';
    el.innerHTML = '<svg viewBox="0 0 40 32" width="34" height="27" aria-hidden="true" focusable="false"><use href="#alt-bf"/></svg>';
    root.appendChild(el);
    const W = 34;
    const H = 27;
    const rest = `translate(${(anchor.x - W / 2).toFixed(1)}px, ${(anchor.y - H * 0.78).toFixed(1)}px) rotate(-8deg)`;
    let timer = 0;
    let anim: Animation | undefined;
    const finish = () => actions.clearCelebration();

    if (reducedRef.current) {
      el.style.transform = rest;
      timer = window.setTimeout(finish, STATIC_MS);
    } else {
      // 从目标左下方、屏外一点的地方出发，曲线飞来
      const sx = Math.max(-40, anchor.x - 420);
      const sy = Math.min(window.innerHeight + 30, anchor.y + 260);
      const frames: Keyframe[] = [];
      const steps = 12;
      for (let i = 0; i <= steps; i++) {
        const p = i / steps;
        const e = 1 - Math.pow(1 - p, 2.2);                   // 末段减速
        const bend = Math.sin(p * Math.PI) * -70;              // 向上拱起
        const x = sx + (anchor.x - W / 2 - sx) * e;
        const y = sy + (anchor.y - H * 0.78 - sy) * e + bend * (1 - p * 0.3);
        const rot = -26 + 18 * p + Math.sin(p * 11) * 6 * (1 - p);
        const flap = 1 - Math.abs(Math.sin(p * 34)) * 0.55 * (1 - p * 0.9);   // 拍翅：越近越慢
        frames.push({ offset: p, opacity: Math.min(1, p * 5), transform: `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${rot.toFixed(1)}deg) scaleX(${flap.toFixed(2)})` });
      }
      frames.push({ offset: 1, opacity: 1, transform: `${rest} scaleX(0.7)` });
      anim = el.animate(frames, { duration: FLIGHT_MS, easing: 'linear', fill: 'forwards' });
      anim.onfinish = () => {
        // 停落：翅膀缓缓合拢又展开一次，然后淡去
        el.style.transform = `${rest} scaleX(0.7)`;
        const settle = el.animate(
          [{ transform: `${rest} scaleX(0.7)` }, { transform: `${rest} scaleX(0.42)`, offset: 0.45 }, { transform: `${rest} scaleX(0.9)` }],
          { duration: REST_MS, easing: 'ease-in-out', fill: 'forwards' },
        );
        settle.onfinish = () => {
          const out = el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: FADE_MS, fill: 'forwards' });
          out.onfinish = finish;
        };
      };
    }
    return () => {
      window.clearTimeout(timer);
      anim?.cancel();
      el.remove();
    };
  }, [celebration]);

  return <div ref={rootRef} className="landing-host" aria-hidden="true" />;
}
