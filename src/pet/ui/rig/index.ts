/* 分层木偶（她在桌宠窗口里的样子）。接口见 docs/PET-PLAN.md §7。
   画法在 rig.ts，怎么动在 motion.ts，数据（rig.json + public/pet/rig/*.webp）由 design/pet/rig-sample/cut.py 生成。
   没有 WebGL2、图层读不出来、或者 GPU 上下文丢了，就退回一张静态母版图，照样能聊天。 */
import type { PetMood } from '../../contracts';
import RIG from './rig.json';
import { Motion, type ReactKind } from './motion';
import { Puppet, type RigData } from './rig';

export interface RigHandle {
  setMood(m: PetMood): void;
  /** 0..1：她声音此刻的响度（PetAudio.level()），驱动嘴。 */
  setTalk(level: number): void;
  /** 视线目标，-1..1（以她的脸为中心）；null = 自己游移。 */
  lookAt(p: { x: number; y: number } | null): void;
  /** 窗口被拖动的速度（像素 / 秒），头发和发尾反向甩。 */
  setDrag(vx: number, vy: number): void;
  /** 一下子的反应：点她、赢了、被吓到、点头。 */
  react(kind: ReactKind): void;
  setFps(cap: 30 | 60): void;
  setReducedMotion(on: boolean): void;
  /** 她此刻在画布里占的矩形（页面像素），用来判断点击穿透。 */
  bounds(): { x: number; y: number; w: number; h: number };
  /** 画布里这一点（页面像素）是不是落在她身上（按她的轮廓，不是矩形；用来决定挡不挡点击）。 */
  hitTest(x: number, y: number): boolean;
  destroy(): void;
  /** 只在 manual 模式下有：按给定的秒数推进一帧并画出来（录样片、逐帧检查用）。 */
  tick?(dt: number): void;
}

/** 静态图的地址（相对 pet.html）。没有 WebGL2 或木偶出错时用它。 */
export const FALLBACK_SRC = './pet/rig/fallback.png';
const LAYER_DIR = './pet/rig/';
const rig = RIG as unknown as RigData;

/** 她（连树枝、发尾）在母版里的范围：脚贴画布底，左右居中。 */
const FIGURE = (() => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of rig.parts) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.w); y1 = Math.max(y1, p.y + p.h); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
})();

/** 母版在静态图里的偏移：静态图是母版按不透明范围紧裁的（design/pet/形象稿/母版C_紧裁.png）。 */
const FALLBACK_AT = { x: 23, y: 38 };
const MASK_STEP = 8;

/** 她的轮廓（1/8 分辨率的布尔网格），点击判定用。读不出来就退回矩形。 */
async function outlineMask(): Promise<{ w: number; h: number; bits: Uint8Array } | null> {
  try {
    const img = await loadImage(FALLBACK_SRC);
    const w = Math.ceil(img.naturalWidth / MASK_STEP), h = Math.ceil(img.naturalHeight / MASK_STEP);
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    const bits = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) bits[i] = d[i * 4 + 3] > 40 ? 1 : 0;
    return { w, h, bits };
  } catch { return null; }
}

/** 母版坐标的一点在不在她的轮廓里（放宽两格，动起来的头发和发尾也算）。 */
function inOutline(mask: { w: number; h: number; bits: Uint8Array } | null, mx: number, my: number): boolean {
  if (!mask) return mx >= FIGURE.x && mx <= FIGURE.x + FIGURE.w && my >= FIGURE.y && my <= FIGURE.y + FIGURE.h;
  const cx = Math.floor((mx - FALLBACK_AT.x) / MASK_STEP), cy = Math.floor((my - FALLBACK_AT.y) / MASK_STEP);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = cx + dx, y = cy + dy;
    if (x >= 0 && y >= 0 && x < mask.w && y < mask.h && mask.bits[y * mask.w + x]) return true;
  }
  return false;
}

function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = src;
  return img.decode().then(() => img);
}

/** 画布在屏幕上实际占多少设备像素，以及「画布自己的页面像素」→ 设备像素的倍数。
 *  桌宠页面用 CSS zoom 缩放：clientWidth 是不含 zoom 的页面像素，getBoundingClientRect 含 zoom，所以两个都要。 */
function deviceSize(canvas: HTMLCanvasElement) {
  const dpr = window.devicePixelRatio || 1;
  const r = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
  return { w, h, k: canvas.clientWidth > 0 ? w / canvas.clientWidth : dpr };
}

/** 画布要显示的母版区域：整个人等比放进画布、脚贴底，设备像素不超过源图像素（不放大她）。顺手把画布的
 *  像素尺寸设成实际显示尺寸。s：母版像素 → 设备像素；k：画布页面像素 → 设备像素。 */
function fit(canvas: HTMLCanvasElement) {
  const { w, h, k } = deviceSize(canvas);
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const s = Math.min(w / FIGURE.w, h / FIGURE.h, 1);
  const vw = w / s, vh = h / s;
  return { s, k, view: { x: FIGURE.x + FIGURE.w / 2 - vw / 2, y: FIGURE.y + FIGURE.h - vh, w: vw, h: vh } };
}

function staticRig(canvas: HTMLCanvasElement): Promise<RigHandle> {
  const img = new Image();
  img.src = FALLBACK_SRC;
  const ctx = canvas.getContext('2d');
  let box = { x: 0, y: 0, w: canvas.clientWidth, h: canvas.clientHeight };
  const draw = () => {
    if (!ctx || !img.naturalWidth) return;
    const { w, h, k } = deviceSize(canvas);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.clearRect(0, 0, w, h);
    const s = Math.min(w / img.naturalWidth, h / img.naturalHeight, 1);
    const dw = img.naturalWidth * s, dh = img.naturalHeight * s, dx = (w - dw) / 2, dy = h - dh;
    ctx.drawImage(img, dx, dy, dw, dh);
    box = { x: dx / k, y: dy / k, w: dw / k, h: dh / k };
  };
  img.decode().then(draw, () => { /* 图也读不出来：画空，聊天照常 */ });
  const ro = new ResizeObserver(draw);
  ro.observe(canvas);
  let mask: Awaited<ReturnType<typeof outlineMask>> = null;
  void outlineMask().then((m) => { mask = m; });
  return Promise.resolve({
    setMood() {}, setTalk() {}, lookAt() {}, setDrag() {}, react() {}, setFps() {}, setReducedMotion() {},
    bounds: () => box,
    hitTest: (x: number, y: number) => {
      if (!img.naturalWidth || box.w <= 0) return false;
      // 静态图坐标 → 母版坐标
      const mx = FALLBACK_AT.x + ((x - box.x) / box.w) * img.naturalWidth, my = FALLBACK_AT.y + ((y - box.y) / box.h) * img.naturalHeight;
      return inOutline(mask, mx, my);
    },
    destroy: () => ro.disconnect(),
  });
}

/** manual：不自己跑动画循环，由调用方用 tick(dt) 一帧一帧推进（录样片、逐帧检查）。 */
export async function mountRig(canvas: HTMLCanvasElement, opts: { scale: number; manual?: boolean }): Promise<RigHandle> {
  let puppet: Puppet;
  try {
    const imgs = await Promise.all(rig.parts.map((p) => loadImage(LAYER_DIR + p.file)));
    const byId: Record<string, HTMLImageElement> = {};
    rig.parts.forEach((p, i) => { byId[p.id] = imgs[i]; });
    puppet = new Puppet(canvas, rig, byId);
  } catch (err) {
    console.warn('[pet] 木偶不可用，改用静态图：', err);
    return staticRig(canvas);
  }

  const motion = new Motion();
  const mask = await outlineMask();
  let fpsCap: 30 | 60 = 60;
  let raf = 0, last = 0, lastDrawn = 0, dead = false;
  let fallback: RigHandle | null = null;
  const frame = (dt: number, draw: boolean) => {
    motion.step(dt, puppet.p);
    puppet.update(dt);
    if (draw) { puppet.view = fit(canvas).view; puppet.render(); }
    // 拖动速度慢慢回零（窗口停下后头发回摆）
    puppet.drag.vx *= Math.exp(-dt * 6); puppet.drag.vy *= Math.exp(-dt * 6);
  };
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = last ? (now - last) / 1000 : 1 / 60;
    last = now;
    // 平时 30 帧（还不到就只推进、不画）；说话、眨眼、反应、蝴蝶在飞、被拖动时跟到上限
    const busy = motion.busy() || Math.abs(puppet.drag.vx) > 5;
    const cap = busy ? fpsCap : Math.min(30, fpsCap);
    const draw = now - lastDrawn >= 1000 / cap - 2;
    if (draw) lastDrawn = now;
    frame(dt, draw);
  };
  if (!opts.manual) raf = requestAnimationFrame(tick);

  // GPU 上下文丢了（显卡驱动重置、GPU 进程崩了）：停掉，换静态图
  const onLost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(raf);
    if (dead) return;
    dead = true;
    void staticRig(canvas).then((h) => { fallback = h; });
  };
  canvas.addEventListener('webglcontextlost', onLost);

  return {
    setMood: (m) => motion.setMood(m),
    setTalk: (v) => { motion.talk = Math.max(0, Math.min(1, v)); },
    lookAt: (p) => { motion.look = p; },
    setDrag: (vx, vy) => { puppet.drag.vx = vx; puppet.drag.vy = vy; },
    react: (k) => motion.react(k),
    setFps: (cap) => { fpsCap = cap === 30 ? 30 : 60; },
    setReducedMotion: (on) => { motion.reduced = on; },
    bounds: () => {
      if (fallback) return fallback.bounds();
      const f = fit(canvas);
      const m = f.s / f.k;   // 母版像素 → 画布页面像素
      return { x: (FIGURE.x - f.view.x) * m, y: (FIGURE.y - f.view.y) * m, w: FIGURE.w * m, h: FIGURE.h * m };
    },
    hitTest: (x, y) => {
      if (fallback) return fallback.hitTest(x, y);
      const f = fit(canvas);
      return inOutline(mask, f.view.x + (x * f.k) / f.s, f.view.y + (y * f.k) / f.s);
    },
    tick: opts.manual ? (dt: number) => { if (!dead) frame(dt, true); } : undefined,
    destroy: () => {
      cancelAnimationFrame(raf);
      canvas.removeEventListener('webglcontextlost', onLost);
      if (fallback) fallback.destroy();
      else if (!dead) puppet.destroy();
    },
  };
}
