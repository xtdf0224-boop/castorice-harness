/* 确认 public/boot/day-boot.json 描述的视频没过期：重新算源哈希，与 manifest 比对。
   node scripts/boot-video/check-fresh.mjs            退出码 0 = 新鲜（src 哈希不同只告警），1 = 过期（需要重新渲染），2 = 桩 / manifest 缺失
   过期的判据：tEnd / landing 与 dayScene 当前常量不同；splash / strip / timeline 哈希不同；视频文件的字节数 / sha256 与 manifest 不一致。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sourceHashes } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, '..', '..', 'public', 'boot');
let m;
try { m = JSON.parse(fs.readFileSync(path.join(OUT, 'day-boot.json'), 'utf8')); } catch { console.error('no manifest'); process.exit(2); }
if (m.stub) { console.error('STUB manifest: not a real render'); process.exit(2); }
const cur = sourceHashes();
const tl = JSON.parse(cur.timelineJson);
const bad = [];
if (m.tEnd !== tl.T_END) bad.push(`tEnd ${m.tEnd} != ${tl.T_END}`);
if (m.landing !== tl.DT.fly[1]) bad.push(`landing ${m.landing} != ${tl.DT.fly[1]}`);
for (const k of ['splash', 'strip', 'timeline']) if (m.sources[k] !== cur[k]) bad.push(`sources.${k} differs`);
for (const f of m.files) {
  const p = path.join(OUT, f.path);
  const b = fs.readFileSync(p);
  if (b.length !== f.bytes) bad.push(`${f.path}: bytes ${b.length} != ${f.bytes}`);
  if (crypto.createHash('sha256').update(b).digest('hex') !== f.sha256) bad.push(`${f.path}: sha256 differs`);
}
if (bad.length) { console.error('视频过期，需要重新渲染：\n  ' + bad.join('\n  ')); process.exit(1); }
if (m.sources.src !== cur.src) console.warn('warn: boot/day*.ts 源码哈希变了（仅提示：若改动影响画面请重新渲染）');
console.log('fresh');
