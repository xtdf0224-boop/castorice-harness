/* 分层木偶的检查：rig.json 和图层文件对得上、参数怎么折腾都不出界、眨眼会睁回来、睡着会闭眼、
   蝴蝶飞一圈会回到枝头、「减少动态效果」时不晃。只测纯逻辑（motion.ts）和数据，不开 WebGL。 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import RIG from '../src/pet/ui/rig/rig.json';
import { Motion } from '../src/pet/ui/rig/motion';
import { DEFAULT_PARAMS, type RigData, type RigParams } from '../src/pet/ui/rig/rig';
import type { PetMood } from '../src/pet/contracts';

let pass = 0, fail = 0;
const ok = (cond: unknown, name: string) => { if (cond) pass++; else { fail++; console.error('  ✗', name); } };
const section = (s: string) => console.log('·', s);
const rig = RIG as unknown as RigData;
const ROOT = process.cwd();   // 检查都从 app 目录跑（npm run …）

section('rig.json 与图层');
{
  const ids = new Set<string>();
  for (const p of rig.parts) {
    ok(!ids.has(p.id), `图层 id 不重复：${p.id}`); ids.add(p.id);
    ok(/^[a-zA-Z0-9]+\.webp$/.test(p.file), `文件名规整：${p.file}`);
    const f = join(ROOT, 'public', 'pet', 'rig', p.file);
    ok(existsSync(f), `图层文件在：${p.file}`);
    if (existsSync(f)) {
      const b = readFileSync(f);
      ok(b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP', `是 WebP：${p.file}`);
      // 无损 WebP（VP8L）头里写着宽高：和 rig.json 对得上
      if (b.toString('ascii', 12, 16) === 'VP8L') {
        const bits = b.readUInt32LE(21);
        ok((bits & 0x3fff) + 1 === p.w && ((bits >> 14) & 0x3fff) + 1 === p.h, `尺寸一致：${p.file}`);
      }
    }
    ok(p.x >= 0 && p.y >= 0 && p.x + p.w <= rig.canvas.w && p.y + p.h <= rig.canvas.h, `在母版画布里：${p.id}`);
    ok(Array.isArray(p.grid) && p.grid[0] >= 1 && p.grid[1] >= 1 && (p.grid[0] + 1) * (p.grid[1] + 1) < 65536, `网格合理：${p.id}`);
    if (p.phys) ok(!!rig.physics[p.phys.group] && p.phys.len > 0, `物理组存在：${p.id}`);
    if (p.kind === 'iris') ok(!!p.eye && !!p.stencilTest && rig.parts.some((q) => q.stencilWrite === p.stencilTest), `瞳孔有对应的眼白：${p.id}`);
    if (p.kind === 'eyesClosed') ok(!!p.lid && p.lid.top >= 0 && p.lid.line > p.lid.top && p.lid.line <= 1, '眼皮参数在范围内');
    if (p.kind === 'leg') ok(!!p.knee, `小腿有膝盖：${p.id}`);
    if (p.kind === 'butterfly') ok(!!p.center, '蝴蝶有中心');
  }
  for (const need of ['body', 'head', 'bangs', 'sideL', 'sideR', 'irisL', 'irisR', 'eyeWhiteL', 'eyeWhiteR', 'eyesClosed', 'mouthOpen', 'smile', 'tailL', 'tailR', 'legL', 'legR', 'butterfly']) ok(ids.has(need), `有图层 ${need}`);
  ok(existsSync(join(ROOT, 'public', 'pet', 'rig', 'fallback.png')), '静态备用图在');
  const z = rig.parts.map((p) => p.z);
  ok(rig.parts.find((p) => p.id === 'body')!.z === Math.min(...z), '身体在最底层');
  ok(rig.parts.find((p) => p.id === 'butterfly')!.z === Math.max(...z), '蝴蝶在最上层（飞过她头前时不能被挡住）');
  ok(rig.parts.filter((p) => p.head).every((p) => p.z <= rig.parts.find((q) => q.id === 'bangs')!.z), '刘海在头部最上层');
}

const run = (m: Motion, p: RigParams, secs: number, dt = 1 / 60, each?: (t: number) => void) => {
  for (let t = 0; t < secs; t += dt) { m.step(dt, p); each?.(t); }
};
const inRange = (p: RigParams) =>
  [p.angleX, p.angleY, p.angleZ, p.bodyX, p.bodyZ, p.eyeX, p.eyeY, p.legL, p.legR].every((v) => v >= -1.0001 && v <= 1.0001)
  && [p.breath, p.eyeOpen, p.mouth, p.smile, p.flap].every((v) => v >= -0.0001 && v <= 1.3);

section('参数不出界');
{
  let seed = 3;
  const rng = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  const m = new Motion(rng), p = { ...DEFAULT_PARAMS };
  const moods: PetMood[] = ['idle', 'talk', 'watch', 'think', 'happy', 'shy', 'surprised', 'sleep'];
  let bad = 0;
  for (let i = 0; i < 400; i++) {
    if (i % 7 === 0) m.setMood(moods[Math.floor(rng() * moods.length)]);
    if (i % 5 === 0) m.react((['poke', 'cheer', 'startle', 'nod'] as const)[Math.floor(rng() * 4)]);
    m.talk = rng() < 0.3 ? rng() : 0;
    m.look = rng() < 0.3 ? { x: rng() * 4 - 2, y: rng() * 4 - 2 } : null;
    run(m, p, 0.5, rng() < 0.5 ? 1 / 60 : 1 / 7, () => { if (!inRange(p)) bad++; });
  }
  ok(bad === 0, `随机折腾 200 秒，参数一直在范围里（出界 ${bad} 帧）`);
  ok(Object.values(p).every((v) => Number.isFinite(v)), '没有 NaN');
}

section('眨眼');
{
  const m = new Motion(() => 0.5), p = { ...DEFAULT_PARAMS };
  let minOpen = 1;
  run(m, p, 8, 1 / 60, () => { minOpen = Math.min(minOpen, p.eyeOpen); });
  ok(minOpen < 0.1, '8 秒里至少眨了一次眼（眼睛合到底）');
  run(m, p, 0.3);
  m.step(1 / 60, p);
  // 眨完一定睁回来：找一段不眨的时候
  let opened = false;
  run(m, p, 6, 1 / 60, () => { if (p.eyeOpen > 0.999) opened = true; });
  ok(opened, '眨完会完全睁开');
}

section('睡着与醒来');
{
  const m = new Motion(() => 0.5), p = { ...DEFAULT_PARAMS };
  m.setMood('sleep');
  run(m, p, 4);
  ok(p.eyeOpen < 0.05, '睡着时眼睛闭上');
  ok(p.angleY < -0.2, '睡着时低头');
  ok(Math.abs(p.legL) < 0.05 && Math.abs(p.legR) < 0.05, '睡着时腿不晃');
  m.setMood('idle');
  run(m, p, 2);
  ok(p.eyeOpen > 0.9, '醒来后睁开眼');
}

section('说话与笑');
{
  const m = new Motion(() => 0.5), p = { ...DEFAULT_PARAMS };
  m.talk = 1; run(m, p, 0.3);
  ok(p.mouth > 0.8, '有声音时嘴张开');
  m.talk = 0; run(m, p, 1);
  ok(p.mouth < 0.05, '没声音时嘴合上');
  m.setMood('happy'); run(m, p, 0.6);
  ok(p.smile > 0.8, '开心时笑眼');
  run(m, p, 3);
  ok(p.smile < 0.2, '笑一会儿就收回来（不是一直闭着眼）');
}

section('枝头的蝴蝶');
{
  const m = new Motion(() => 0.5), p = { ...DEFAULT_PARAMS };
  m.react('cheer');
  let far = 0;
  run(m, p, 2.3, 1 / 60, () => { far = Math.max(far, Math.hypot(p.flyX, p.flyY)); });
  ok(far > 200, '欢呼时蝴蝶飞起来');
  ok(m.busy(), '蝴蝶在飞时要满帧率');
  run(m, p, 3);
  ok(p.flyX === 0 && p.flyY === 0, '飞一圈回到枝头');
  m.setMood('sleep'); m.launch();
  run(m, p, 0.5);
  ok(p.flyX === 0 && p.flyY === 0, '她睡着时蝴蝶不飞');
}

section('减少动态效果');
{
  const m = new Motion(() => 0.5), p = { ...DEFAULT_PARAMS };
  m.reduced = true;
  let maxLeg = 0, maxBody = 0, minOpen = 1;
  run(m, p, 10, 1 / 60, () => { maxLeg = Math.max(maxLeg, Math.abs(p.legL), Math.abs(p.legR)); maxBody = Math.max(maxBody, Math.abs(p.bodyZ)); minOpen = Math.min(minOpen, p.eyeOpen); });
  ok(maxLeg < 0.01 && maxBody < 0.01, '不晃腿、不摆身体');
  ok(minOpen < 0.1, '照样眨眼');
  m.react('cheer'); run(m, p, 1);
  ok(p.flyX === 0 && p.flyY === 0, '蝴蝶不飞');
}

section('空闲时降帧');
{
  const m = new Motion(() => 0.99), p = { ...DEFAULT_PARAMS };
  let idleFrames = 0, frames = 0;
  run(m, p, 20, 1 / 60, () => { frames++; if (!m.busy()) idleFrames++; });
  ok(idleFrames / frames > 0.6, `待机时大部分帧不需要满帧率（${Math.round((idleFrames / frames) * 100)}%）`);
}

console.log(`\n木偶检查：${pass} 项通过，${fail} 项失败`);
if (fail) process.exit(1);
