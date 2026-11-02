/* 汇总 manifest 需要的哈希 / 源哈希 / 原图检查 / 编码参数 → perf-work/bootvideo/hashes.json（manifest.mjs --real 读它）。
   前置：verify-avc.json（verify.py）、encode-avc.json（encode.py --tag avc）、native-check.json（native-check.mjs，含当前 scale）。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sourceHashes } from './sources.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORK = 'G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo';
const GEO = JSON.parse(fs.readFileSync(path.join(HERE, 'geometry.json'), 'utf8'));
const rd = (f) => JSON.parse(fs.readFileSync(path.join(WORK, f), 'utf8'));
const va = rd('verify-avc.json');
const LAST = String(GEO.frames - 1);
const nc = rd('native-check.json')[String(GEO.scale)];
if (!nc) throw new Error(`native-check.json 里没有 scale=${GEO.scale} 的结果`);
// 2026-10-29 第三轮起：规则的口径是「她在屏幕上的显示尺寸不超过原图 / 不超过实时版」——视频按显示分辨率渲染，帧里的显示尺寸与实时版在同一窗口里一致（同一舞台缩放 × 同一镜头），
// 所以这里不再因为「比原图大」而拒绝：照实记录（实时版本身在用户窗口里就大于原图，见 docs/BOOT-VIDEO.md §11），不擅自改实时版。
const out = {
  hash: {
    frame0_source_rgb: va.sourceRgbSha256['0'],
    frameLast_index: Number(LAST),
    frameLast_source_rgb: va.sourceRgbSha256[LAST],
    frame0_decoded: { avc: va.decodedSha256['0'] },
    frameLast_decoded: { avc: va.decodedSha256[LAST] },
  },
  sources: (({ splash, strip, timeline, src, timelineJson }) => ({ splash, strip, timeline, src, timelineJson }))(sourceHashes()),
  nativeCheck: {
    splashMaxEdgePx: Math.round(nc.splashMaxEdgePx * 100) / 100, splashNative: 1600,
    stripMaxPxPerUnit: Math.round(nc.strip.v * 1e4) / 1e4, stripNativePxPerUnit: 1.0,
    artOverNative: nc.art.over, stripOverNative: nc.strip.over,
    note: '实测（native-check.mjs，t 每 0.05 s，scale = 设备像素 / 舞台单位）：立绘 = img.s0-art 的渲染边长；花海条 = day-strip.webp 的最大累计缩放（原图 1700 px 宽、舞台里画 1700 单位宽，即 1 px / 单位）。视频按显示分辨率渲染（scale 1.53 = 用户最大化窗口 1020 CSS 高 x DPR 1.5），帧里的显示尺寸与实时版在同一窗口里一致（同一舞台缩放 x 同一镜头），所以与实时版同样合规；实时版本身在这个窗口里就让立绘 / 花海条大于原图（见 artOverNative / stripOverNative），未改实时版。立绘在视频里只有 t < 3.0 s（绽开期）；2.7 s 起的清晰立绘是实时 DOM 层（不是视频）。',
    scaleTried: [0.944, 0.846, GEO.scale],
  },
  encode: { avc: rd('encode-avc.json') },
  verify: { avc: { agg: va.agg, frame0: va.frame0, frameLast: va.frameLast, bands: va.bands } },
};
fs.writeFileSync(path.join(WORK, 'hashes.json'), JSON.stringify(out, null, 2));
console.log('hashes.json written');
