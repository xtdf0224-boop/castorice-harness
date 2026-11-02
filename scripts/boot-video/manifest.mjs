/* 生成 public/boot/day-boot.json。
     node manifest.mjs --stub      桩：只填尺寸 / 文件 / 哈希，"stub": true
     node manifest.mjs --real      真片：另读 perf-work/bootvideo/hashes.json（finalize 之前由 verify.py / render 写入的源帧哈希与解码哈希），"stub": false
   文件字节数、sha256、编码字符串、宽高、帧数都由 mp4info.mjs 从磁盘上的 mp4 里读，不信任别处的数。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mp4info } from './mp4info.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const OUT = path.join(APP, 'public', 'boot');
const WORK = 'G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo';
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const stub = process.argv.includes('--stub');
const GEO = JSON.parse(fs.readFileSync(path.join(HERE, 'geometry.json'), 'utf8'));

const files = [['primary', 'day-boot.avc.mp4']].map(([role, name]) => {
  const f = path.join(OUT, name);
  const info = mp4info(fs.readFileSync(f));
  return { role, path: name, codec: info.codecs, bytes: fs.statSync(f).size, sha256: sha(f), info };
});
const p0 = files[0].info;
const tl = (() => { try { return JSON.parse(fs.readFileSync(path.join(WORK, 'meta.json'), 'utf8')); } catch { return {}; } })();
const hashes = stub ? {} : JSON.parse(fs.readFileSync(path.join(WORK, 'hashes.json'), 'utf8'));
const head = execFileSync('git', ['-C', APP, 'rev-parse', '--short', 'HEAD']).toString().trim();

const m = {
  schema: 1,
  stub,
  theme: 'day',
  width: p0.width, height: p0.height, fps: Math.round(p0.fps), frames: p0.frames,
  scale: GEO.scale, extUnits: Math.round((p0.width / GEO.scale) * 10) / 10, ratioMax: Math.ceil((p0.width / p0.height) * 10000) / 10000,
  dpr: GEO.dpr, cssWidth: GEO.cssWidth, cssHeight: GEO.cssHeight,
  duration: Math.round((p0.frames / Math.round(p0.fps)) * 1e4) / 1e4,
  tEnd: 7.4, landing: 5.0, handoffPre: 7.15, handoffFadeMs: 120, ovPre: 1.4, ovFrom: 2.7, ovTo: 3.0,
  layers: 'env+bloom-art',      // 视频 = 环境层 + 绽开期（< 3.0 s）的立绘；2.7 s 起清晰立绘 / 近景散花 / 蝶 / 雪点 / B 类 fx 是实时 DOM（见 docs/BOOT-VIDEO.md §10）
  trc: tl.trc ?? 'bt709', matrix: tl.matrix ?? 'bt709', matrixTag: tl.matrixTag ?? 'bt709', range: 'tv',
  files: files.map(({ role, path: p, codec, bytes, sha256 }) => ({ role, path: p, codec, bytes, sha256 })),
  ...(stub ? {} : { calibration: { note: tl.note, measured: tl.measured, mediaCapabilities: tl.mediaCapabilities_avc_3210x1530_60 ?? tl.mediaCapabilities_avc_1774x846_60 }, hash: hashes.hash, sources: hashes.sources, nativeCheck: hashes.nativeCheck, encode: hashes.encode }),
  made: { date: new Date().toISOString(), ffmpeg: '9.0.1', headCommit: head },
};
fs.writeFileSync(path.join(OUT, 'day-boot.json'), JSON.stringify(m, null, 2) + '\n');
console.log(JSON.stringify({ stub, files: m.files.map((f) => [f.path, f.bytes, f.codec]), frames: m.frames, size: `${m.width}x${m.height}@${m.fps}` }));
