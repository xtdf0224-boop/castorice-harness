// 把官方素材（design/chat/assets/official/）原样转成 public/art/her/*.webp，并写 scripts/art-manifest.json。
//   node scripts/pack-art.mjs [--src <official 目录>] [--out <输出目录>] [--manifest <manifest 路径>]
//
// 规则（施工图 §4.2）：
//   · 不改色、不缩放、不裁切：Pillow 无损 webp（lossless + exact，保留 alpha 与透明处的 RGB）。裁切在 CSS 里做。
//   · 不入包 withering、takeoff、Fatigue、Pets Please、联动款、ref-ui/**（带 UID）。映射表里没有它们，check-art 另行把关。
//   · art-manifest.json 记每个文件的来源相对路径、来源 sha256 与像素、来源解码后 RGBA 的 sha256、输出文件 sha256 与像素。
//     design/ 不在应用仓库里，所以 check-art 只靠 manifest 校验；有 Python + Pillow 时还会解码输出文件逐像素比对。
// 依赖：Python 3 + Pillow（只在打包时用；check-art 不强制）。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : fallback;
}
const srcDir = arg('src', path.resolve(root, '..', 'design', 'chat', 'assets', 'official'));
const outDir = arg('out', path.join(root, 'public', 'art', 'her'));
const manifestPath = arg('manifest', path.join(here, 'art-manifest.json'));

const EXPRS = ['gentle', 'relaxed', 'shy', 'surprised', 'confused', 'grumpy'];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const STICKERS = {
  butterfly: 'Sticker_PPG_22_Castorice_01',
  blushing: 'Sticker_PPG_22_Castorice_03',
  create: 'Sticker_PPG_22_Castorice_04',
  dontthink: 'Sticker_PPG_21_Castorice_01',
  like: 'Sticker_PPG_21_Chimera_01',
  bewildered: 'Sticker_PPG_21_Chimera_02',
};
const PATHS = { remembrance: 'Remembrance', erudition: 'Erudition', hunt: 'The_Hunt', preservation: 'Preservation' };

/** 输出文件名 → 来源（相对 official/）。文件名是契约（src/lib/expr.ts）. */
const MAP = [];
for (const e of EXPRS) MAP.push([`face-${e}.webp`, `expressions/Castorice_Expressions_${cap(e)}.png`, 'face']);
for (const e of EXPRS) MAP.push([`icon-${e}.webp`, `expressions/Icon_Expression_${cap(e)}.png`, 'icon']);
for (const [id, f] of Object.entries(STICKERS)) MAP.push([`sticker-${id}.webp`, `stickers/${f}.png`, 'sticker']);
for (const [id, f] of Object.entries(PATHS)) MAP.push([`path-${id}.webp`, `emblems/Icon_Path_${f}_Medium.png`, 'path']);
for (const [id, f] of Object.entries(PATHS)) MAP.push([`path-${id}-s.webp`, `emblems/Icon_${f}.png`, 'path-s']);
MAP.push(['type-quantum.webp', 'emblems/Type_Quantum.png', 'type']);

const FORBIDDEN = /withering|take-?off|fatigue|pets|butterfly_cake|ref-ui|PPG_20_|PPG_25_|PPG_22_Castorice_02/i;

const PY = `
import sys, json, hashlib
from PIL import Image
job = json.load(sys.stdin)
res = []
for it in job['items']:
    im = Image.open(it['src']); im.load()
    rgba = im.convert('RGBA')
    src_px = hashlib.sha256(rgba.tobytes()).hexdigest()
    im.save(it['out'], 'WEBP', lossless=True, quality=100, method=6, exact=True)
    back = Image.open(it['out']); back.load()
    back_rgba = back.convert('RGBA')
    out_px = hashlib.sha256(back_rgba.tobytes()).hexdigest()
    res.append({'name': it['name'], 'srcSize': list(im.size), 'srcMode': im.mode, 'outSize': list(back.size), 'srcPixels': src_px, 'outPixels': out_px})
json.dump(res, sys.stdout)
`;

const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

if (!fs.existsSync(srcDir)) { console.error(`找不到素材目录：${srcDir}`); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const items = [];
for (const [name, rel] of MAP) {
  if (FORBIDDEN.test(rel)) { console.error(`禁入包的素材：${rel}`); process.exit(2); }
  const src = path.join(srcDir, rel);
  if (!fs.existsSync(src)) { console.error(`缺来源：${rel}`); process.exit(2); }
  items.push({ name, src, out: path.join(outDir, name) });
}

const run = spawnSync('python', ['-I', '-c', PY], { input: JSON.stringify({ items }), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) { console.error(run.stderr || run.error); process.exit(2); }
const res = JSON.parse(run.stdout);

const files = {};
let bad = 0;
for (const [name, rel, kind] of MAP) {
  const r = res.find((x) => x.name === name);
  const srcPath = path.join(srcDir, rel);
  const same = r.srcPixels === r.outPixels && r.srcSize[0] === r.outSize[0] && r.srcSize[1] === r.outSize[1];
  if (!same) { bad += 1; console.error(`像素不一致：${name}`); }
  files[name] = {
    kind,
    source: rel,
    sourceSha256: sha(srcPath),
    sourceWidth: r.srcSize[0],
    sourceHeight: r.srcSize[1],
    sourceMode: r.srcMode,
    pixelsSha256: r.srcPixels,
    sha256: sha(path.join(outDir, name)),
    width: r.outSize[0],
    height: r.outSize[1],
  };
}
if (bad) process.exit(1);

const manifest = {
  note: '由 scripts/pack-art.mjs 生成。来源是 design/chat/assets/official/（见其中 SOURCES.md）；无损 webp，未改色、未缩放、未裁切。',
  credit: '官方表情 / 贴纸 / 命途徽记 © HoYoverse / 米哈游，官方素材，原样使用。',
  files,
};
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${MAP.length} files to ${path.relative(root, outDir)} and ${path.relative(root, manifestPath)}`);
