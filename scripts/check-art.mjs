// npm run check:art — 官方素材的入包检查（施工图 §4.2、§7.1）。
//   node scripts/check-art.mjs [--no-pixels]
//
// 1. public/art/her/** 的每个文件都在 scripts/art-manifest.json 里，反之亦然；文件 sha256 与 manifest 一致；
//    webp 头里的像素尺寸 = manifest = 来源尺寸（没缩放、没裁切）。
// 2. 有 Python + Pillow 时，解码每个 webp 的 RGBA，与来源解码后的 RGBA sha256 逐像素比对（无损、没改色）。没有就跳过并说明。
// 3. 不含 ref-ui、withering、takeoff、Fatigue、Pets Please、蝶糕糕：public/** 的文件名、manifest 的来源、src/** 里的素材路径都不出现。
// 4. src/** 与 index.html 里写死的每个 art/… 路径都能在 public/ 里找到；expr.ts 里的 ID 表推出的每个文件名都在包里（面/图标/贴纸/命途/-s/属性）。
// 5. 尺寸规则的静态上限（D4、D-04）：ART_MAX 不超过自然边长（face ≤349 < 527，icon ≤136，sticker ≤120）；
//    源码里写死的 <HerAvatar size>、<ExprBadge size>、<StickerImg size>、<AgentMark size> 数字不超过各自上限。
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const herDir = path.join(root, 'public', 'art', 'her');
const manifestPath = path.join(here, 'art-manifest.json');
const skipPixels = process.argv.includes('--no-pixels');

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failed += 1; console.log(`  FAIL ${msg}${detail ? `\n         ${detail}` : ''}`); }
  return cond;
};
const note = (msg) => console.log(`  skip ${msg}`);
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const rel = (p) => path.relative(root, p).replace(/\\/g, '/');

function walk(dir, pred, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && e.name !== '.cache') walk(p, pred, out); } else if (pred(p)) out.push(p);
  }
  return out;
}

/** webp 头里的像素尺寸（VP8L / VP8X / VP8）. */
function webpSize(buf) {
  if (buf.length < 30 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return undefined;
  const kind = buf.toString('latin1', 12, 16);
  if (kind === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
  if (kind === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return [(b & 0x3fff) + 1, ((b >> 14) & 0x3fff) + 1];
  }
  if (kind === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
  return undefined;
}

/* ───────────── 1. manifest ↔ 文件 ───────────── */

console.log('manifest 与文件');
let manifest;
try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) { manifest = undefined; ok(false, 'scripts/art-manifest.json 可读', String(e)); }
const entries = manifest ? Object.entries(manifest.files ?? {}) : [];
const onDisk = fs.existsSync(herDir) ? fs.readdirSync(herDir).filter((f) => !f.startsWith('.')) : [];
ok(onDisk.length > 0, `public/art/her 有素材（${onDisk.length} 个）`);
ok(entries.length > 0, `manifest 有记录（${entries.length} 条）`);
const names = new Set(entries.map(([n]) => n));
const extra = onDisk.filter((f) => !names.has(f));
const missing = [...names].filter((n) => !onDisk.includes(n));
ok(extra.length === 0, '包里没有 manifest 之外的文件', extra.join(', '));
ok(missing.length === 0, 'manifest 里的每个文件都在包里', missing.join(', '));
for (const [name, m] of entries) {
  const p = path.join(herDir, name);
  if (!fs.existsSync(p)) continue;
  const buf = fs.readFileSync(p);
  const size = webpSize(buf);
  ok(crypto.createHash('sha256').update(buf).digest('hex') === m.sha256, `${name} 与 manifest 的 sha256 一致`);
  ok(!!size && size[0] === m.width && size[1] === m.height, `${name} 像素 ${size ? size.join('×') : '?'} = manifest ${m.width}×${m.height}`);
  ok(m.width === m.sourceWidth && m.height === m.sourceHeight, `${name} 与来源同尺寸（没缩放、没裁切）`, `${m.sourceWidth}×${m.sourceHeight} → ${m.width}×${m.height}`);
}

/* ───────────── 2. 像素 ───────────── */

console.log('像素（无损、没改色）');
if (skipPixels) note('带了 --no-pixels');
else if (entries.length) {
  const PY = `
import sys, json, hashlib
from PIL import Image
out = {}
for p in json.load(sys.stdin):
    im = Image.open(p); im.load()
    out[p] = hashlib.sha256(im.convert('RGBA').tobytes()).hexdigest()
json.dump(out, sys.stdout)
`;
  const files = entries.map(([n]) => path.join(herDir, n)).filter((p) => fs.existsSync(p));
  const r = spawnSync('python', ['-I', '-c', PY], { input: JSON.stringify(files), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) note(`没有 Python + Pillow，只校验了 sha256 与尺寸（${(r.stderr || String(r.error || '')).split('\n').filter(Boolean).pop() ?? ''}）`);
  else {
    const got = JSON.parse(r.stdout);
    const wrong = entries.filter(([n, m]) => fs.existsSync(path.join(herDir, n)) && got[path.join(herDir, n)] !== m.pixelsSha256).map(([n]) => n);
    ok(wrong.length === 0, `解码后的 RGBA 与来源逐像素一致（${files.length} 个）`, wrong.join(', '));
  }
}

/* ───────────── 3. 不该入包的 ───────────── */

console.log('不该入包的');
const BANNED_NAME = /withering|take-?off|fatigue|pets[-_ ]?please|butterfly[-_]?cake|ref-ui|PPG_20_|PPG_25_|Message_Castorice/i;
const publicFiles = walk(path.join(root, 'public'), () => true);
const bannedFiles = publicFiles.filter((p) => BANNED_NAME.test(rel(p)));
ok(bannedFiles.length === 0, 'public/** 的文件名里没有 withering / takeoff / Fatigue / Pets Please / ref-ui', bannedFiles.map(rel).join(', '));
const bannedSources = entries.filter(([, m]) => BANNED_NAME.test(m.source));
ok(bannedSources.length === 0, 'manifest 的来源里没有被禁的素材', bannedSources.map(([n]) => n).join(', '));
const srcFiles = walk(path.join(root, 'src'), (p) => /\.(tsx?|css)$/.test(p));
const pageFiles = [...srcFiles, path.join(root, 'index.html')].filter((p) => fs.existsSync(p));
const bannedRefs = [];
for (const f of pageFiles) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/(?:art\/[\w./-]*|ref-ui\/[\w./-]*)(?:withering|takeoff|fatigue)[\w.-]*|ref-ui\/[\w./-]+/gi)) bannedRefs.push(`${rel(f)}: ${m[0]}`);
}
ok(bannedRefs.length === 0, '源码里没有引用被禁的素材路径', bannedRefs.slice(0, 5).join(' | '));

/* ───────────── 4. 引用都存在 ───────────── */

console.log('引用');
const dangling = [];
let refCount = 0;
for (const f of pageFiles) {
  const t = fs.readFileSync(f, 'utf8');
  for (const m of t.matchAll(/\bart\/([A-Za-z0-9_./-]+\.(?:webp|png|jpe?g|svg|avif|gif))/g)) {
    refCount += 1;
    if (!fs.existsSync(path.join(root, 'public', 'art', m[1]))) dangling.push(`${rel(f)}: art/${m[1]}`);
  }
}
ok(dangling.length === 0, `源码里写死的 art/… 路径都存在（${refCount} 处）`, dangling.slice(0, 8).join(' | '));

// expr.ts 的 ID 表推出的文件名.
const exprText = fs.readFileSync(path.join(root, 'src', 'lib', 'expr.ts'), 'utf8');
const list = (name) => {
  const m = new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`).exec(exprText);
  return m ? [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]) : [];
};
const exprIds = list('EXPR_IDS');
const stickerIds = list('STICKER_IDS');
const pathIds = list('PATH_IDS');
ok(exprIds.length === 6 && stickerIds.length === 6 && pathIds.length === 4, `expr.ts 的 ID 表：表情 ${exprIds.length}、贴纸 ${stickerIds.length}、命途 ${pathIds.length}`);
const expected = [
  ...exprIds.flatMap((e) => [`face-${e}.webp`, `icon-${e}.webp`]),
  ...stickerIds.map((s) => `sticker-${s}.webp`),
  ...pathIds.flatMap((p) => [`path-${p}.webp`, `path-${p}-s.webp`]),
  'type-quantum.webp',
];
const lacking = expected.filter((f) => !onDisk.includes(f));
ok(lacking.length === 0, `expr.ts 推出的 ${expected.length} 个文件名都在包里`, lacking.join(', '));
const unused = onDisk.filter((f) => !expected.includes(f));
ok(unused.length === 0, '包里没有 expr.ts 用不到的文件', unused.join(', '));
// 贴纸白名单（D10）与旧文件不被动.
ok(!stickerIds.some((s) => /withering|takeoff/.test(s)), '贴纸白名单里没有 withering / takeoff');
for (const f of ['face-gentle.webp', 'figure-official.webp', 'splash-official.webp', 'day-flowers.webp']) {
  ok(fs.existsSync(path.join(root, 'public', 'art', f)), `既有的 art/${f} 还在`);
}

/* ───────────── 5. 尺寸规则（静态） ───────────── */

console.log('尺寸规则');
const num = (name) => { const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(exprText); return m ? Number(m[1]) : NaN; };
const naturalFace = num('FACE_NATURAL');
const naturalIcon = num('ICON_NATURAL');
const naturalSticker = num('STICKER_NATURAL');
const artMax = /ART_MAX\s*=\s*\{\s*face:\s*(\d+)\s*,\s*icon:\s*(\d+)\s*,\s*sticker:\s*(\d+)/.exec(exprText);
ok(!!artMax, 'expr.ts 有 ART_MAX');
if (artMax) {
  const [face, icon, sticker] = artMax.slice(1).map(Number);
  ok(face <= 349 && face <= naturalFace, `ART_MAX.face ${face} ≤ 349 且 ≤ 自然边长 ${naturalFace}`);
  ok(icon <= naturalIcon, `ART_MAX.icon ${icon} ≤ 自然边长 ${naturalIcon}`);
  ok(sticker <= 120 && sticker <= naturalSticker, `ART_MAX.sticker ${sticker} ≤ 120 且 ≤ 自然边长 ${naturalSticker}`);
  const sq = Math.floor((face / 135.1) * 100);
  const over = [];
  for (const f of srcFiles.filter((p) => p.endsWith('.tsx'))) {
    const t = fs.readFileSync(f, 'utf8');
    for (const m of t.matchAll(/<(HerAvatar|ExprBadge|StickerImg)\b([^>]*?)(?:\/>|>)/gs)) {
      const attrs = m[2];
      const s = /\bsize=\{(\d+(?:\.\d+)?)\}/.exec(attrs);
      if (!s) continue;
      const n = Number(s[1]);
      const full = /shape=["']full["']/.test(attrs);
      const cap = m[1] === 'ExprBadge' ? icon : m[1] === 'StickerImg' ? sticker : full ? face : sq;
      if (n > cap) over.push(`${rel(f)}: <${m[1]} size={${n}}> > ${cap}`);
    }
    for (const m of t.matchAll(/<AgentMark\b([^>]*?)\/>/gs)) {
      const s = /\bsize=\{(\d+)\}/.exec(m[1]);
      if (s && Number(s[1]) > 128) over.push(`${rel(f)}: <AgentMark size={${s[1]}}> > 128`);
    }
  }
  ok(over.length === 0, '源码里写死的头像 / 角标 / 贴纸 / 命途图标尺寸不超过上限', over.join(' | '));
}

/* ───────────── 6. 回归：审查确认的四处（右栏焦点、折叠按钮语义、记忆行内编辑、素材声明） ───────────── */

console.log('回归：右栏立绘收起 / 展开保住焦点');
{
  const t = fs.readFileSync(path.join(root, 'src/components/shell/StatusPanel.tsx'), 'utf8');
  const toggle = /const toggle = \(\) => \{[^\n]*\};/.exec(t)?.[0] ?? '';
  ok(/refocusToggle\.current = true/.test(toggle), 'toggle() 先登记「要把焦点交给另一颗按钮」');
  ok(/useEffect\(\(\) => \{[^]*?refocusToggle\.current[^]*?\.herpanel-toggle[^]*?\.herpanel-niche__fold[^]*?\.focus\([^]*?\}, \[folded\]\)/.test(t), 'folded 变化后 effect 聚焦对应分支的按钮（展开 / 收起）');
  ok(/<header ref=\{herRef\}/.test(t), '页头挂了 herRef，查询限定在右栏页头内');
}

console.log('回归：「折叠她的话」名字固定，状态只交给 aria-pressed');
{
  const t = fs.readFileSync(path.join(root, 'src/components/shell/StatusPanel.tsx'), 'utf8');
  const line = t.split('\n').find((l) => l.includes('aria-pressed={st.fold}')) ?? '';
  ok(!!line, '按钮仍带 aria-pressed={st.fold}');
  ok(/>折叠她的话<\/Button>/.test(line) && !/展开她的话/.test(line), '名字固定为「折叠她的话」，不随状态翻转');
}

console.log('回归：记得小事的行内编辑原地改');
{
  const t = fs.readFileSync(path.join(root, 'src/components/views/settings/MemoryList.tsx'), 'utf8');
  const row = t.slice(t.indexOf('function MemoryRow'), t.indexOf('export function MemoryList'));
  const commit = row.slice(row.indexOf('const commit'), row.indexOf('const onKeyDown'));
  ok(/actions\.editMemory\(item\.id, next\)/.test(commit), 'MemoryRow.commit 调 actions.editMemory(item.id, next)');
  ok(!/actions\.addMemory/.test(commit), 'MemoryRow.commit 不再「加新」（不换 id、不跳到组尾）');
  ok(!/actions\.removeMemory/.test(commit), 'MemoryRow.commit 不再「删旧」');
  ok(/!r\.ok[^]*?r\.error[^]*?setText\(item\.text\)/.test(commit), '失败时 toast r.error 并还原输入');
}

console.log('回归：素材声明与界面行为一致');
{
  const old = '没有改色、变形或裁切';
  for (const f of ['src/lib/terms.ts', 'src/components/views/SettingsView.tsx', 'DISCLAIMER.md', 'build/license.txt']) {
    let t = '';
    try { t = fs.readFileSync(path.join(root, f), 'utf8'); } catch { /* 缺文件由下面的断言报 */ }
    ok(t !== '' && !t.includes(old), `${f} 不再写「${old}」`);
    ok(t.includes('只在显示时取景') && t.includes('按主题着色'), `${f} 写明头像只在显示时取景、命途图标按主题着色`);
  }
  const terms = fs.readFileSync(path.join(root, 'src/lib/terms.ts'), 'utf8');
  const sentence = /官方素材，素材文件原样使用[^；]*/.exec(terms)?.[0] ?? '';
  const dis = fs.readFileSync(path.join(root, 'DISCLAIMER.md'), 'utf8');
  ok(!!sentence && dis.includes(sentence), 'DISCLAIMER.md 与 terms.ts 同源（已重跑 npm run legal）');
}

if (failed) { console.log(`\ncheck-art: ${failed} 项失败`); process.exit(1); }
console.log('\ncheck-art: 全部通过');
