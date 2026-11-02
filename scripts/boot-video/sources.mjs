/* 视频「防过期」用的源哈希（manifest.sources）。
     splash   = sha256(public/art/splash-official.webp)
     strip    = sha256(public/boot/day-strip.webp)
     timeline = sha256(JSON.stringify({ T_END, DT, DAY_EVENTS, DAY_VID }))，值来自 dayScene.ts 的导出（rolldown 打包后在 node 里取）；timelineJson 里存原文，方便 I 核对
     src      = sha256 over（文件名 + 换行 + 内容），boot/day*.ts 按文件名排序（仅提示：改了渲染相关代码但没改时间表时的告警）
   命令行：node sources.mjs            打印 JSON；  node check-fresh.mjs   与 public/boot/day-boot.json 比对（见该文件）。 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..', '..');
const CACHE = 'G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo/.cache';
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

export function timelineJson() {
  fs.mkdirSync(CACHE, { recursive: true });
  const out = path.join(CACHE, 'timeline-bundle.mjs');
  execFileSync(process.execPath, [path.join(APP, 'node_modules', 'rolldown', 'bin', 'cli.mjs'), path.join(HERE, 'timeline-entry.mjs'), '--platform', 'node', '--format', 'esm', '--file', out], { stdio: 'pipe', cwd: APP });
  return execFileSync(process.execPath, [out], { encoding: 'utf8' });
}

export function sourceHashes() {
  const tl = timelineJson();
  const dir = path.join(APP, 'src', 'components', 'decor', 'boot');
  const days = fs.readdirSync(dir).filter((f) => /^day.*\.ts$/.test(f)).sort();
  const h = crypto.createHash('sha256');
  for (const f of days) { h.update(f + '\n'); h.update(fs.readFileSync(path.join(dir, f))); }
  return {
    splash: sha(fs.readFileSync(path.join(APP, 'public', 'art', 'splash-official.webp'))),
    strip: sha(fs.readFileSync(path.join(APP, 'public', 'boot', 'day-strip.webp'))),
    timeline: sha(tl),
    timelineJson: tl,
    src: h.digest('hex'),
    srcFiles: days,
  };
}

if (process.argv[1] && /sources\.mjs$/.test(process.argv[1])) console.log(JSON.stringify(sourceHashes(), null, 2));
