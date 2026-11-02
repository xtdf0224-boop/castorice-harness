/* 她自己怎么动：呼吸、眨眼、视线、头的轻晃、小腿摆、枝头蝴蝶，以及心情和一下子的反应。
   只算参数（RigParams），不碰 WebGL，所以能在 node 里测（scripts/pet-rig-check.ts）。 */
import type { PetMood } from '../../contracts';
import type { RigParams } from './rig';

export type ReactKind = 'poke' | 'cheer' | 'startle' | 'nod';

interface MoodPose {
  /** 头的偏置（叠在视线带动的转头上）。 */
  head: [number, number, number];
  /** 有固定看向时的视线（null = 自己游移或看鼠标）。 */
  gaze: [number, number] | null;
  /** 小腿摆的幅度（-1..1 的比例）和快慢（弧度 / 秒）。 */
  leg: [number, number];
  /** 眨眼间隔的倍数（想事情时眨得少）。 */
  blinkEvery: number;
  smile: number;
}

const POSES: Record<PetMood, MoodPose> = {
  idle: { head: [0, 0, 0], gaze: null, leg: [0.28, 1.3], blinkEvery: 1, smile: 0 },
  talk: { head: [0, 0.05, 0], gaze: [0, 0.05], leg: [0.15, 1.1], blinkEvery: 1.2, smile: 0 },
  watch: { head: [-0.3, 0.15, -0.1], gaze: [-0.55, 0.3], leg: [0.08, 0.9], blinkEvery: 1.3, smile: 0 },
  think: { head: [0.15, 0.25, 0.45], gaze: [0.35, 0.7], leg: [0.1, 0.8], blinkEvery: 1.6, smile: 0 },
  happy: { head: [0, 0.12, 0.15], gaze: [0, 0.1], leg: [0.7, 2.4], blinkEvery: 1, smile: 1 },
  shy: { head: [0.2, -0.35, -0.35], gaze: [0.6, -0.45], leg: [0.05, 0.8], blinkEvery: 0.8, smile: 0.55 },
  surprised: { head: [0, 0.4, 0], gaze: [0, 0.1], leg: [0.2, 3], blinkEvery: 2, smile: 0 },
  sleep: { head: [0.05, -0.55, 0.5], gaze: [0, -0.5], leg: [0, 0.5], blinkEvery: 1, smile: 0 },
};

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const ease = (k: number, dt: number) => 1 - Math.exp(-dt * k);

export class Motion {
  t = 0;
  mood: PetMood = 'idle';
  private moodT = 99;
  /** 外部给的视线目标（-1..1，以她的脸为中心）；null = 自己游移。 */
  look: { x: number; y: number } | null = null;
  /** 0..1：她声音此刻的响度。 */
  talk = 0;
  reduced = false;
  private blinkT = -1;
  private nextBlink = 1.5;
  private doubleBlink = false;
  private gaze = { x: 0, y: 0, tx: 0, ty: 0, next: 1 };
  private reacts: Array<{ kind: ReactKind; t: number }> = [];
  private smileHold = 0;
  private legPhase = 0;
  private bf = { out: false, t: 0, next: 50, flapT: -1, nextFlap: 4 };

  constructor(private rng: () => number = Math.random) {}

  setMood(m: PetMood) {
    if (m === this.mood) return;
    const was = this.mood;
    this.mood = m;
    this.moodT = 0;
    if (m === 'happy') { this.smileHold = 1.6; this.launch(); }
    if (m === 'surprised') { this.react('startle'); }
    if (m === 'shy') this.smileHold = 1.2;
    if (was === 'sleep') this.blinkT = 0;   // 醒来先眨一下
  }

  react(kind: ReactKind) {
    if (this.mood === 'sleep' && kind !== 'poke') return;
    this.reacts.push({ kind, t: 0 });
    if (kind === 'cheer') { this.smileHold = 1.2; this.launch(); }
    if (kind === 'startle') this.launch();
    if (kind === 'poke' || kind === 'startle') { this.blinkT = 0; this.doubleBlink = false; }
  }

  /** 蝴蝶从枝头飞一圈再回来。 */
  launch() {
    if (this.reduced || this.mood === 'sleep' || this.bf.out) return;
    this.bf.out = true; this.bf.t = 0;
  }

  /** 这一帧要不要满帧率：说话、眨眼、反应、蝴蝶在飞或在扇、刚换心情。 */
  busy(): boolean {
    return this.talk > 0.02 || this.blinkT >= 0 || this.reacts.length > 0 || this.bf.out || this.bf.flapT >= 0 || this.moodT < 0.8;
  }

  step(dt: number, p: RigParams) {
    dt = clamp(dt, 0, 0.1);
    this.t += dt; this.moodT += dt;
    const t = this.t, pose = POSES[this.mood], reduced = this.reduced;
    const sleeping = this.mood === 'sleep';

    // 呼吸：3.8 秒一次，睡着时慢而深
    const period = sleeping ? 5.2 : 3.8;
    p.breath = (0.5 - 0.5 * Math.cos((t / period) * Math.PI * 2)) * (reduced ? 0.5 : sleeping ? 1.25 : 1);

    // 眨眼：2.2–6 秒一次，约六分之一连眨两下；睡着时闭着
    if (sleeping) {
      p.eyeOpen += (0 - p.eyeOpen) * ease(2.2, dt);
      this.blinkT = -1;
    } else {
      this.nextBlink -= dt;
      if (this.blinkT < 0 && this.nextBlink <= 0) { this.blinkT = 0; this.doubleBlink = this.rng() < 1 / 6; }
      let open = 1;
      if (this.blinkT >= 0) {
        this.blinkT += dt;
        const ph = this.blinkT / 0.16;
        open = ph < 0.45 ? 1 - ph / 0.45 : ph < 1 ? (ph - 0.45) / 0.55 : 1;
        if (ph >= 1) {
          if (this.doubleBlink) { this.doubleBlink = false; this.blinkT = 0; }
          else { this.blinkT = -1; this.nextBlink = (2.2 + this.rng() * 3.8) * pose.blinkEvery; }
        }
      }
      // 刚从闭着醒来：慢慢睁
      p.eyeOpen = p.eyeOpen < 0.95 && this.blinkT < 0 ? p.eyeOpen + (1 - p.eyeOpen) * ease(6, dt) : open;
    }

    // 视线：外部目标 > 心情的固定看向 > 自己游移
    const g = this.gaze;
    if (this.look && !sleeping) { g.tx = clamp(this.look.x, -1, 1); g.ty = clamp(this.look.y, -1, 1); }
    else if (pose.gaze) { g.tx = pose.gaze[0]; g.ty = pose.gaze[1]; }
    else if ((g.next -= dt) <= 0) {
      g.tx = (this.rng() * 2 - 1) * 0.6; g.ty = (this.rng() * 2 - 1) * 0.35; g.next = 1.2 + this.rng() * 2.5;
    }
    const kEye = ease(14, dt), kHead = ease(reduced ? 2 : 3.2, dt);
    g.x += (g.tx - g.x) * kEye; g.y += (g.ty - g.y) * kEye;
    p.eyeX = g.x; p.eyeY = g.y;

    // 头：跟着视线转一点，叠心情的偏置和两个正弦的轻晃
    const sway = reduced ? 0 : Math.sin(t * 0.7) * 0.12 + Math.sin(t * 1.9 + 0.8) * 0.05;
    let hx = g.x * 0.55 + sway + pose.head[0];
    let hy = g.y * 0.5 + (reduced ? 0 : Math.sin(t * 0.9) * 0.06) + pose.head[1];
    let hz = (reduced ? 0 : Math.sin(t * 0.55 + 1) * 0.18) - g.x * 0.15 + pose.head[2];
    if (sleeping) hz += Math.sin(t * 0.4) * 0.08;   // 打盹时头一点一点
    // 说话时随声音轻点头
    hy += this.talk * 0.1 * Math.sin(t * 7);
    // 一下子的反应
    for (const r of this.reacts) r.t += dt;
    this.reacts = this.reacts.filter((r) => r.t < 0.9);
    for (const r of this.reacts) {
      const k = Math.exp(-r.t * 5);
      if (r.kind === 'poke') { hz += 0.55 * k * Math.cos(r.t * 14); hy -= 0.15 * k; }
      if (r.kind === 'startle') { hy += 0.5 * k; hx += 0.15 * k * Math.sin(r.t * 20); }
      if (r.kind === 'nod') hy -= 0.4 * Math.sin(Math.min(1, r.t / 0.6) * Math.PI);
      if (r.kind === 'cheer') hz += 0.25 * k * Math.sin(r.t * 12);
    }
    p.angleX += (clamp(hx, -1, 1) - p.angleX) * kHead;
    p.angleY += (clamp(hy, -1, 1) - p.angleY) * kHead;
    p.angleZ += (clamp(hz, -1, 1) - p.angleZ) * kHead;
    p.bodyZ = reduced ? 0 : Math.sin(t * 0.5) * 0.25;
    p.bodyX = reduced ? 0 : Math.sin(t * 0.4 + 2) * 0.2;

    // 嘴：张开快、合上慢
    const target = clamp(this.talk, 0, 1);
    p.mouth += (target - p.mouth) * ease(target > p.mouth ? 30 : 12, dt);

    // 笑眼：开心 / 害羞 / 欢呼时停一会儿再收
    this.smileHold = Math.max(0, this.smileHold - dt);
    const smileTo = this.smileHold > 0 ? Math.max(pose.smile, 0.95) : 0;
    p.smile += (smileTo - p.smile) * ease(this.smileHold > 0 ? 9 : 5, dt);

    // 小腿：左右交替轻晃，开心时晃得多，困了就停
    const [amp, speed] = reduced ? [0, 1] : pose.leg;
    this.legPhase += dt * speed;
    const cheer = this.reacts.some((r) => r.kind === 'cheer') ? 0.4 : 0;
    const a = Math.min(1, amp + cheer);
    p.legL += (a * Math.sin(this.legPhase) - p.legL) * ease(6, dt);
    p.legR += (a * Math.sin(this.legPhase + 2.6) - p.legR) * ease(6, dt);

    // 枝头的蝴蝶：停着时隔一会儿扇两三下；偶尔飞一圈再回来
    const bf = this.bf;
    if (bf.out) {
      bf.t += dt;
      const s = clamp(bf.t / 4.6, 0, 1);
      // 从枝头起飞，往左上绕到她脸旁，兜一个小弯再落回枝头（一直在她身边，不飞出画布）
      const a1 = Math.sin(Math.PI * s), a2 = Math.sin(Math.PI * 2 * s);
      p.flyX = -340 * a1 - 50 * a2;
      p.flyY = -440 * a1 + 60 * a2;
      const vx = -340 * Math.PI * Math.cos(Math.PI * s) - 100 * Math.PI * Math.cos(Math.PI * 2 * s);
      p.flyTilt = clamp(vx / 4000, -0.35, 0.35);
      p.flap = 0.5 + 0.5 * Math.cos(bf.t * Math.PI * 2 * 9);
      if (s >= 1) { bf.out = false; bf.next = 70 + this.rng() * 90; p.flyX = 0; p.flyY = 0; p.flyTilt = 0; }
    } else {
      bf.next -= dt;
      if (bf.next <= 0 && this.mood === 'idle' && !reduced) this.launch();
      bf.nextFlap -= dt;
      if (bf.flapT < 0 && bf.nextFlap <= 0 && !reduced) bf.flapT = 0;
      if (bf.flapT >= 0) {
        bf.flapT += dt;
        p.flap = 0.55 + 0.45 * Math.cos(bf.flapT * Math.PI * 2 * 5);
        if (bf.flapT > 0.6) { bf.flapT = -1; bf.nextFlap = 3 + this.rng() * 6; p.flap = 1; }
      } else p.flap = 1;
      p.flyX = 0; p.flyY = 0; p.flyTilt = 0;
    }
  }
}
