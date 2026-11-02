// After `vite build`: guards on what actually ships in dist/.
//   node scripts/check-build.mjs [distDir]      (distDir defaults to ../dist)
//
// 1. CSP (X04): EVERY html page under dist/ carries exactly one Content-Security-Policy meta, placed before the first script/link,
//    with the policy locked: img-src 'self' data: blob:, connect-src 'self', default/script-src 'self', object-src/base-uri/form-action 'none',
//    nothing but those tokens (no '*', no http(s)/ws hosts, no 'unsafe-eval'; 'unsafe-inline' only for style-src).
//    No html page loads a script/stylesheet/image from the network, and no inline <script> (the CSP would block it).
//    Built CSS must not pull external resources either (url(http…), @import http…).
// 2. backdrop-filter: the glass needs an UNPREFIXED backdrop-filter. (A hand-written -webkit- line next to it once made the minifier
//    drop the standard property.) Every rule that has -webkit-backdrop-filter must also have backdrop-filter, and a built .panel rule,
//    if there is one, must keep it.
// 3. Both wallpapers (night-* and day-*, see src/components/decor/wallpapers.ts) were copied into dist/wallpapers/.
// 4. 她的官方素材：manifest 里的每个文件都在 dist/art/her/ 里，没有被禁的素材；构建产物里引用的每个 art/… 都存在.
// Also a lighter pass over the html pages the desktop shell loads from electron/ (the browser window's own pages): they must carry a CSP too.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(here, '..', 'dist');
const electronDir = process.argv[2] ? null : path.resolve(here, '..', 'electron');

let failed = 0;
const ok = (cond, msg, detail) => {
  if (cond) console.log(`  ok   ${msg}`);
  else { failed += 1; console.log(`  FAIL ${msg}${detail ? `\n         ${detail}` : ''}`); }
  return cond;
};

function walk(dir, pred, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p, pred, out); } else if (pred(p)) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(path.dirname(dist), p).replace(/\\/g, '/');

/* ───────────── CSP ───────────── */

const CSP_META_RE = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi;
const KNOWN_DIRECTIVES = new Set([
  'default-src', 'script-src', 'style-src', 'img-src', 'media-src', 'font-src', 'connect-src', 'object-src', 'base-uri', 'form-action',
  'frame-src', 'child-src', 'worker-src', 'manifest-src', 'script-src-elem', 'style-src-elem', 'script-src-attr', 'style-src-attr',
  'frame-ancestors', 'sandbox', 'upgrade-insecure-requests',
]);
const SAFE_TOKENS = new Set(["'self'", "'none'", 'data:', 'blob:']);

function parseCsp(content) {
  const map = new Map();
  const dup = [];
  for (const part of content.split(';')) {
    const toks = part.trim().split(/\s+/).filter(Boolean);
    if (!toks.length) continue;
    const name = toks[0].toLowerCase();
    if (map.has(name)) dup.push(name);
    map.set(name, toks.slice(1));
  }
  return { map, dup };
}

const sameSet = (a, b) => a.length === b.length && b.every((t) => a.includes(t));

/** Strict policy for the app's own pages. @returns {string[]} problems */
function appCspProblems(html) {
  const problems = [];
  const metas = html.match(CSP_META_RE) ?? [];
  if (metas.length !== 1) return [`needs exactly one CSP meta, found ${metas.length}`];
  const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(metas[0]);
  if (!content) return ['CSP meta has no content'];
  const { map, dup } = parseCsp(content[1] ?? content[2]);
  if (dup.length) problems.push(`duplicate directives: ${dup.join(', ')}`);
  for (const [name, toks] of map) {
    if (!KNOWN_DIRECTIVES.has(name)) problems.push(`unknown directive ${name}`);
    for (const t of toks) {
      const low = t.toLowerCase();
      if (SAFE_TOKENS.has(low)) continue;
      if (low === "'unsafe-inline'" && name === 'style-src') continue;
      problems.push(`${name}: token ${t} is not allowed`);
    }
  }
  const want = {
    'default-src': ["'self'"], 'script-src': ["'self'"], 'img-src': ["'self'", 'data:', 'blob:'], 'connect-src': ["'self'"],
    'object-src': ["'none'"], 'base-uri': ["'none'"], 'form-action': ["'none'"],
  };
  for (const [name, toks] of Object.entries(want)) {
    const got = map.get(name);
    if (!got) problems.push(`${name} is missing`);
    else if (!sameSet(got.map((t) => t.toLowerCase()), toks)) problems.push(`${name} is "${got.join(' ')}", must be "${toks.join(' ')}"`);
  }
  for (const [name, allowed] of [['style-src', ["'self'", "'unsafe-inline'"]], ['media-src', ["'self'", 'blob:']], ['font-src', ["'self'", 'data:']]]) {
    const got = map.get(name);
    if (got && !got.every((t) => allowed.includes(t.toLowerCase()))) problems.push(`${name} "${got.join(' ')}" is wider than "${allowed.join(' ')}"`);
  }
  // The policy only covers what is parsed after it.
  const at = html.search(CSP_META_RE);
  const firstLoader = html.search(/<(script|link|img|iframe|object|embed|video|audio|source)\b/i);
  if (firstLoader >= 0 && at > firstLoader) problems.push('CSP meta comes after the first script/link/media element');
  // Things that would be blocked or that reach the network.
  for (const m of html.matchAll(/<(script|link|img|iframe|source|video|audio|embed|object)\b[^>]*>/gi)) {
    const tag = m[0];
    const url = /\b(?:src|href|data)\s*=\s*["']?([^"'\s>]+)/i.exec(tag);
    if (url && /^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(url[1]) && !/^data:|^blob:/i.test(url[1])) problems.push(`loads from the network: ${url[1].slice(0, 80)}`);
    if (/^<script\b/i.test(tag) && !/\bsrc\s*=/i.test(tag)) problems.push('inline <script> (blocked by script-src \'self\')');
  }
  if (/\son[a-z]+\s*=\s*["']/i.test(html)) problems.push('inline event-handler attribute (blocked by script-src \'self\')');
  return problems;
}

/** Looser rule for pages under electron/ that have their own, stricter-than-app policy. */
function shellPageProblems(html) {
  const metas = html.match(CSP_META_RE) ?? [];
  if (metas.length !== 1) return [`needs exactly one CSP meta, found ${metas.length}`];
  const content = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(metas[0]);
  const { map } = parseCsp(content ? (content[1] ?? content[2]) : '');
  const problems = [];
  for (const name of ['default-src', 'script-src', 'img-src', 'connect-src']) {
    for (const t of map.get(name) ?? []) {
      const low = t.toLowerCase();
      if (t === '*' || low === "'unsafe-eval'" || /^(https?|wss?):/i.test(t)) problems.push(`${name}: token ${t} is not allowed`);
    }
  }
  if (!map.has('default-src')) problems.push('default-src is missing');
  return problems;
}

const pages = walk(dist, (p) => /\.html?$/i.test(p));
ok(pages.length > 0, `dist has html pages (${pages.length})`, `looked in ${dist}`);
ok(pages.some((p) => path.basename(p).toLowerCase() === 'index.html'), 'dist/index.html exists');
for (const p of pages) {
  const problems = appCspProblems(fs.readFileSync(p, 'utf8'));
  ok(problems.length === 0, `CSP locked in ${rel(p)}`, problems.join('; '));
}
if (electronDir) {
  for (const p of walk(electronDir, (f) => /\.html?$/i.test(f))) {
    const problems = shellPageProblems(fs.readFileSync(p, 'utf8'));
    ok(problems.length === 0, `CSP present in ${path.relative(path.resolve(here, '..'), p).replace(/\\/g, '/')}`, problems.join('; '));
  }
}

/* ───────────── CSS ───────────── */

const cssFiles = walk(dist, (p) => p.endsWith('.css'));
const css = cssFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');
ok(cssFiles.length > 0, `dist has css (${cssFiles.length} files)`);

const external = css.match(/url\(\s*["']?(?:https?:)?\/\/[^)]*\)|@import\s+(?:url\(\s*)?["']?(?:https?:)?\/\//gi) ?? [];
ok(external.length === 0, 'built CSS pulls nothing from the network', external.slice(0, 3).join(' | '));

const rules = css.match(/\{[^{}]*\}/g) ?? [];
const prefixedOnly = rules.filter((r) => /-webkit-backdrop-filter\s*:/.test(r) && !/(^|[;{\s])backdrop-filter\s*:/.test(r));
ok(prefixedOnly.length === 0, 'every rule with -webkit-backdrop-filter also keeps the unprefixed backdrop-filter', prefixedOnly[0]?.slice(0, 120));
const glass = rules.filter((r) => /(^|[;{\s])backdrop-filter\s*:/.test(r));
ok(glass.length > 0, `built CSS has glass (${glass.length} rules with backdrop-filter)`);
const panelRules = css.match(/\.panel\{[^}]*\}/g) ?? [];
if (panelRules.length) ok(panelRules.some((r) => /(^|[;{])backdrop-filter:/.test(r)), 'built .panel keeps unprefixed backdrop-filter');

/* ───────────── assets ───────────── */

const wallDir = path.join(dist, 'wallpapers');
const wallImages = walk(wallDir, (p) => /\.(avif|webp|jpe?g|png)$/i.test(p) && fs.statSync(p).size > 1024);
ok(wallImages.length > 0, `wallpapers copied to dist/ (${wallImages.length} images)`);
for (const id of ['night', 'day']) {
  ok(wallImages.some((p) => path.basename(p).toLowerCase().startsWith(`${id}-`)), `the ${id} wallpaper is in dist/wallpapers/`);
}

/* ───────────── opening animation and display font ───────────── */

// The opening animation gives up (silently) when one of its images is missing, and the OFL needs its text next to the font.
for (const f of ['boot/night-base.jpg', 'boot/night-island.webp', 'boot/night-water.png', 'boot/day-strip.webp', 'art/splash-official.webp', 'fonts/cinzel-latin.woff', 'fonts/OFL-Cinzel.txt']) {
  const p = path.join(dist, f);
  ok(fs.existsSync(p) && fs.statSync(p).size > 1024 - (f.endsWith('.txt') ? 1024 : 0), `dist/${f} is there`);
}
// Every Cinzel @font-face in the built CSS points at a file that exists (Vite rewrites the url relative to the css file).
{
  let faces = 0;
  const broken = [];
  for (const file of cssFiles) {
    for (const face of fs.readFileSync(file, 'utf8').match(/@font-face\s*\{[^}]*\}/g) ?? []) {
      if (!/Cinzel/i.test(face)) continue;
      faces += 1;
      for (const m of face.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/g)) {
        if (/^data:/i.test(m[1])) continue;
        const target = m[1].startsWith('/') ? path.join(dist, m[1]) : path.resolve(path.dirname(file), m[1].split(/[?#]/)[0]);
        if (!fs.existsSync(target)) broken.push(m[1]);
      }
    }
  }
  ok(faces > 0, `built CSS declares the Cinzel @font-face (${faces})`);
  ok(broken.length === 0, 'the Cinzel @font-face points at files that exist in dist/', broken.join(', '));
}

/* ───────────── 官方素材（她的头像 / 表情 / 贴纸 / 命途图标） ───────────── */

// public/art/her/** 是 scripts/pack-art.mjs 从官方素材转出来的，文件清单在 scripts/art-manifest.json（check-art 管内容，这里管有没有进包）.
{
  let names = [];
  try { names = Object.keys(JSON.parse(fs.readFileSync(path.join(here, 'art-manifest.json'), 'utf8')).files ?? {}); } catch { /* 下面会报 */ }
  ok(names.length > 0, `scripts/art-manifest.json 列出了她的素材（${names.length} 个）`);
  const missing = names.filter((n) => { const p = path.join(dist, 'art', 'her', n); return !fs.existsSync(p) || fs.statSync(p).size < 200; });
  ok(missing.length === 0, `manifest 里的每个文件都在 dist/art/her/ 里（${names.length} 个）`, missing.slice(0, 6).join(', '));
  // 不该入包的：带 UID 的界面截图、withering / takeoff 贴纸、Fatigue、Pets Please.
  const banned = walk(path.join(dist, 'art'), (p) => /withering|take-?off|fatigue|pets[-_ ]?please|butterfly[-_]?cake|ref-ui/i.test(p));
  ok(banned.length === 0, 'dist/art 里没有 withering / takeoff / Fatigue / Pets Please / ref-ui', banned.slice(0, 3).map(rel).join(', '));
  ok(!fs.existsSync(path.join(dist, 'ref-ui')), 'dist 里没有 ref-ui/（带 UID 的游戏截图）');
}

// 构建后的 CSS / JS / HTML 里写死的每个 art/… 路径都能在 dist 里找到（Vite 不会替我们发现漏拷的 public 文件）.
// 动态拼出来的名字（face-${id}）在上面按 manifest 查；这里查的是字面量.
{
  const code = walk(dist, (p) => /\.(?:css|m?js|html?)$/i.test(p));
  const missing = new Set();
  let refs = 0;
  for (const f of code) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_-])art\/([A-Za-z0-9_./-]+\.(?:webp|png|jpe?g|svg|avif|gif))/g)) {
      refs += 1;
      if (!fs.existsSync(path.join(dist, 'art', m[1]))) missing.add(`art/${m[1]}`);
    }
  }
  ok(refs > 0, `构建产物里引用了 art/… 下的图片（${refs} 处）`);
  ok(missing.size === 0, '构建产物里引用的每个 art/… 都能在 dist 里找到', [...missing].slice(0, 6).join(', '));
}

/* ───────────── 5. 昼开屏视频（docs/BOOT-VIDEO.md §5.4）─────────────
   public/boot/day-boot.json 存在（有视频版）就校验：不是桩（stub !== true，防止桩被打进发布包）、视频文件在 dist/boot/、字节数与 sha256 与 manifest 一致、
   合计 ≤ 40 MB（H.264 单文件；不再带 HEVC）、mp4 盒里的编码四字符 / 宽高 / 帧数与 manifest 一致（scripts/boot-video/mp4info.mjs 解析，不依赖 ffprobe）。
   不放宽 media-src：上面的 CSP 检查已要求恰好是 'self' blob:，<video src="./boot/…"> 被 'self' 覆盖. */
{
  const manPath = path.join(dist, 'boot', 'day-boot.json');
  if (!fs.existsSync(manPath)) {
    ok(true, '昼开屏视频：dist/boot/day-boot.json 不存在（没有视频版，开屏走实时）——跳过');
  } else {
    const { mp4info } = await import(pathToFileURL(path.join(here, 'boot-video', 'mp4info.mjs')).href);
    const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    let man = {};
    try { man = JSON.parse(fs.readFileSync(manPath, 'utf8')); } catch (e) { ok(false, '昼开屏视频：day-boot.json 能解析', String(e)); }
    ok(man.stub !== true, '昼开屏视频：manifest 不是桩（stub !== true）——桩视频不能进发布包', 'scripts/boot-video 重新渲染并 finalize');
    ok(man.schema === 1 && man.theme === 'day', '昼开屏视频：manifest schema 1、theme day');
    let total = 0;
    for (const f of man.files ?? []) {
      const fp = path.join(dist, 'boot', f.path);
      if (!ok(fs.existsSync(fp), `昼开屏视频：dist/boot/${f.path} 存在`)) continue;
      const st = fs.statSync(fp);
      total += st.size;
      ok(st.size === f.bytes, `昼开屏视频：${f.path} 字节数与 manifest 一致（${st.size}）`, `manifest ${f.bytes}`);
      ok(sha(fp) === f.sha256, `昼开屏视频：${f.path} 的 sha256 与 manifest 一致`);
      const limit = 40 * 1024 * 1024;
      ok(st.size <= limit, `昼开屏视频：${f.path} ≤ 40 MB（${(st.size / 1048576).toFixed(1)} MB）`);
      let info;
      try { info = mp4info(fs.readFileSync(fp)); } catch (e) { ok(false, `昼开屏视频：${f.path} 能解析 mp4 盒`, String(e)); continue; }
      const entry = 'avc1';
      ok(info.sampleEntry === entry, `昼开屏视频：${f.path} 的编码四字符是 ${entry}`, String(info.sampleEntry));
      ok(info.codecs === f.codec, `昼开屏视频：${f.path} 的 codecs 字符串与 manifest 一致`, `${info.codecs} vs ${f.codec}`);
      ok(info.width === man.width && info.height === man.height, `昼开屏视频：${f.path} 宽高 ${man.width}×${man.height}`, `${info.width}×${info.height}`);
      ok(info.frames === man.frames, `昼开屏视频：${f.path} 帧数 ${man.frames}`, String(info.frames));
      ok(info.faststart === true, `昼开屏视频：${f.path} 是 faststart（moov 在 mdat 之前）`);
      ok(info.complete === true, `昼开屏视频：${f.path} 没被截断（顶层盒排满整个文件、有 mdat）`);
      ok(Math.abs((info.trackDuration ?? 0) - man.frames / man.fps) < 0.02, `昼开屏视频：${f.path} 轨时长 = 帧数 / 帧率（${(man.frames / man.fps).toFixed(4)} s）`, String(info.trackDuration));
    }
    ok(total <= 40 * 1024 * 1024, `昼开屏视频：视频文件合计 ≤ 40 MB（${(total / 1048576).toFixed(1)} MB）`);
    ok((man.files ?? []).length === 1 && man.files[0].role === 'primary' && man.fps === 60 && man.frames === 445, '昼开屏视频：只有一个主文件（H.264，60 fps、445 帧）');
  }
}

/* ───────────── 6. 桌宠的两个页面（docs/PET-PLAN.md §8）─────────────
   dist/pet.html（桌宠窗口）和 dist/capture.html（隐藏的画面采集页）都要建出来：各带一个存在的脚本，桌宠页带样式，
   采集页小（它只判断画面，不能把应用的 React 包拖进来）且暴露 __petCapture，桌宠的静态母版图（没有 WebGL2 时用）在 dist/pet/rig/ 里。
   CSP 在上面「每个 html 页面」的循环里已经逐页查过（同一条严格策略）；这里再确认这两页在名单里。
   指定了 dist 目录（check-security 的夹具）时，没有这两页就跳过，别的构建产物检查照常。 */
{
  const petPages = ['pet.html', 'capture.html'];
  const present = petPages.filter((f) => fs.existsSync(path.join(dist, f)));
  if (!process.argv[2] || present.length) {
    const read = (f) => (fs.existsSync(path.join(dist, f)) ? fs.readFileSync(path.join(dist, f), 'utf8') : '');
    const scriptsOf = (html) => [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    const exists = (src) => fs.existsSync(path.resolve(dist, src.split(/[?#]/)[0]));
    for (const [f, what] of [['pet.html', '桌宠窗口'], ['capture.html', '画面采集页']]) {
      const html = read(f);
      ok(!!html, `dist/${f} 建出来了（${what}）`);
      if (!html) continue;
      const scripts = scriptsOf(html);
      ok(scripts.length > 0 && scripts.every(exists), `dist/${f} 带的脚本都在`, scripts.join(', '));
      ok(pages.some((p) => path.basename(p) === f), `dist/${f} 在上面逐页查 CSP 的名单里`);
    }
    const pet = read('pet.html');
    const sheets = [...pet.matchAll(/<link[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]);
    ok(sheets.length > 0 && sheets.every(exists), 'dist/pet.html 带样式表，且样式表都在', sheets.join(', '));
    const petCss = sheets.map((h) => (exists(h) ? fs.readFileSync(path.resolve(dist, h.split(/[?#]/)[0]), 'utf8') : '')).join('\n');
    ok(/\.pet-chat\b/.test(petCss) && /\.pet-card\b/.test(petCss) && /\.pet-arena\b/.test(petCss), '桌宠样式表里有聊天框、牌、引蝶区的样式');
    ok(/data-theme=["']?day/.test(petCss) && /prefers-reduced-motion/.test(petCss), '桌宠样式表有昼主题和「减少动态效果」的规则');
    // 采集页：小、暴露开始钩子
    const capJs = scriptsOf(read('capture.html')).map((s) => (exists(s) ? fs.readFileSync(path.resolve(dist, s.split(/[?#]/)[0]), 'utf8') : '')).join('');
    ok(capJs.length > 0 && capJs.length < 60_000 && /__petCapture/.test(capJs), '画面采集页很小，并暴露 __petCapture（主进程用它开始采集）', `${capJs.length} 字节`);
    ok(!/react-dom/.test(capJs) && !/createRoot/.test(capJs), '画面采集页没有把 React 包拖进来');
    // 桌宠窗口：静态母版图在包里（木偶出错或没有 WebGL2 时退到它，聊天照样能用）
    const fb = path.join(dist, 'pet', 'rig', 'fallback.png');
    ok(fs.existsSync(fb) && fs.statSync(fb).size > 1024, 'dist/pet/rig/fallback.png 在（没有 WebGL2 时的静态母版图，也是聊天头像的来源）');
    // 小游戏的命途图标（官方图标）都在包里：牌面从 art/her/path-<id>.webp 取
    const icons = ['remembrance', 'erudition', 'hunt', 'preservation'].flatMap((id) => [`path-${id}.webp`, `path-${id}-s.webp`]);
    const lost = icons.filter((n) => !fs.existsSync(path.join(dist, 'art', 'her', n)));
    ok(lost.length === 0, '占卜牌面用的命途图标都在 dist/art/her/ 里', lost.join(', '));
  } else {
    console.log('  skip 桌宠页面检查（指定的 dist 里没有 pet.html / capture.html）');
  }
}

process.exit(failed ? 1 : 0);
