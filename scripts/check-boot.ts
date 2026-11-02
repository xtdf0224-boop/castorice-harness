/* 开屏与落雪时限的纯函数检查（不碰 DOM，不开窗口）。
   用法（在 app/ 下）：
     npx rolldown scripts/check-boot.ts --platform node --format esm --file node_modules/.cache/check-boot.mjs && node node_modules/.cache/check-boot.mjs
   覆盖：缓动曲线端点与单调、smoothstep 色标、确定性随机数、贝塞尔路径、宽高比范围、落雪时限与失焦宽限，
   以及开屏 → 主界面的转场（时间表与错开、tr 的状态函数与终态、FLIP、飞行路径、拱窗裁切、立绘落位、壁纸取景、
   尾流（应用侧元素等标题 / 蝶飞过再浮现）、左栏推入与底板的洞、纸面的羽化展开、枝的生长）。 */
import { BLUR_GRACE_MS, FALL_FADE_MS, FALL_FULL_MS, fallIntensity } from '../src/components/decor/fallLimits';
import * as NIGHT from '../src/components/decor/boot/nightScene';
import * as DAY from '../src/components/decor/boot/dayScene';
import * as TR from '../src/components/decor/boot/transition';
import { revealBase, settleReveal } from '../src/components/decor/boot/bootDom';
import { E, TAU, aspectOk, bez, bezD, cubic, easedStops, invFlight, mulberry32, pathAt, popCurve, sstep, win } from '../src/components/decor/boot/bootMath';
import { BOOT_MAX_DPR } from '../src/components/decor/boot/bootDom';
import * as PC from '../src/components/decor/boot/pacer';
import { governedFor, setBootImpl } from '../src/components/decor/boot/bootImpl';
import * as BM from '../src/components/decor/boot/bootMath';
import * as CH from '../src/components/decor/boot/channels';
import * as GOV from '../src/components/decor/boot/governor';
import * as BL from '../src/components/decor/boot/dayBloom';
import * as BT from '../src/components/decor/boot/bloomTiles';
import * as IMPL from '../src/components/decor/boot/bootImpl';
/** 0.1.3（db7176c）昼开屏 mask-image 字符串（t = i × 0.045 s，i = 0…60，逐串连接）的 FNV-1a 哈希：对拍用的快照自己不能漂. */
const HEAD_MASK_HASH = 0x62583406;
import * as GK from '../src/components/decor/boot/gpuKind';
import * as NC from '../src/components/decor/boot/nightComp';
import * as DC_ from '../src/components/decor/boot/dayComp';
import * as SM from '../src/components/decor/boot/sampler';
import * as PRE from '../src/components/decor/boot/preload';
import { readEarlyPrefs } from '../src/state/prefsKeys';
import * as BV from '../src/components/decor/boot/bootVideo';
// @ts-expect-error mp4info.mjs 是没有类型声明的 .mjs（scripts/boot-video 里的小工具，不依赖 ffprobe）
import { mp4info as mp4infoRaw } from './boot-video/mp4info.mjs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let failed = 0;
let total = 0;
const ok = (name: string, pass: boolean, detail = '') => { total++; if (!pass) failed++; console.log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `  — ${detail}` : ''}`); };
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) <= e;

// ── 缓动曲线：端点 0/1、单调不减 ──
for (const [name, f] of Object.entries(E)) {
  let mono = true;
  let prev = -1;
  for (let i = 0; i <= 200; i++) { const v = f(i / 200); if (v < prev - 1e-9) mono = false; prev = v; }
  ok(`E.${name}：f(0)=0、f(1)=1、单调不减`, f(0) === 0 && f(1) === 1 && mono);
}
ok('cubic(.25,.1,.25,1)（CSS ease）f(.5) ≈ 0.802', near(cubic(0.25, 0.1, 0.25, 1)(0.5), 0.8024, 2e-3), String(cubic(0.25, 0.1, 0.25, 1)(0.5)));
ok('win / sstep 夹在 0–1', win(-1, 0, 2) === 0 && win(3, 0, 2) === 1 && near(win(1, 0, 2), 0.5) && sstep(-5) === 0 && sstep(9) === 1 && near(sstep(0.5), 0.5));
ok('popCurve：先放大到 1.25 再回落到 1（过冲只给小元素）', popCurve(0) === 0 && near(popCurve(0.45), 1.25, 1e-6) && near(popCurve(1), 1, 1e-6));
ok('invFlight 是 flight 曲线的反函数', [0.1, 0.3, 0.5, 0.8].every((q) => near(E.flight(invFlight(q)), q, 1e-4)));

// ── smoothstep 色标：两端斜率为 0（没有马赫带）、单调 ──
{
  const stops = easedStops('11 9 24', 0.86, 0, 14);
  const alphas = [...stops.matchAll(/\/ ([0-9.]+)\)/g)].map((m) => Number(m[1]));
  const first = alphas[0];
  const last = alphas[alphas.length - 1];
  const dropFirst = alphas[0] - alphas[1];
  const dropMid = alphas[6] - alphas[7];
  ok('easedStops：起点 α=0.86、终点 α=0，共 15 个色标', alphas.length === 15 && near(first, 0.86, 1e-3) && near(last, 0, 1e-3));
  ok('easedStops：单调下降，两端比中段平缓（缓出，无折线）', alphas.every((a, i) => i === 0 || a <= alphas[i - 1] + 1e-9) && dropFirst < dropMid * 0.4, `${dropFirst.toFixed(4)} vs ${dropMid.toFixed(4)}`);
  const pos = [...stops.matchAll(/\) ([0-9.]+)%/g)].map((m) => Number(m[1]));
  ok('easedStops：位置从 0% 到 100%', pos[0] === 0 && pos[pos.length - 1] === 100);
  const ranged = easedStops('0 0 0', 1, 0, 10, 52, 84);
  const rp = [...ranged.matchAll(/\) ([0-9.]+)%/g)].map((m) => Number(m[1]));
  ok('easedStops：from/to 限定色标位置（暗纱的横向遮罩 52%–84%）', rp[0] === 52 && rp[rp.length - 1] === 84);
}

// ── 确定性随机数：同一种子同一序列（逐帧导出与实时一致的前提）──
{
  const a = mulberry32(20241024);
  const b = mulberry32(20241024);
  const sa = Array.from({ length: 8 }, () => a());
  const sb = Array.from({ length: 8 }, () => b());
  ok('mulberry32：同种子同序列，值在 [0,1)', sa.every((v, i) => v === sb[i] && v >= 0 && v < 1));
  ok('mulberry32：不同种子不同序列', mulberry32(1)() !== mulberry32(2)());
  ok('TAU = 2π', near(TAU, Math.PI * 2));
}

// ── 贝塞尔路径 ──
{
  const g = [[0, 0], [1, 2], [3, 2], [4, 0]] as const;
  ok('bez：t=0 / t=1 落在端点', near(bez(g, 0)[0], 0) && near(bez(g, 1)[0], 4) && near(bez(g, 1)[1], 0));
  const d0 = bezD(g, 0);
  ok('bezD：起点切线 = 3·(P1−P0)', near(d0[0], 3) && near(d0[1], 6));
  const segs = [[[0, 0], [1, 0], [2, 0], [3, 0]], [[3, 0], [4, 0], [5, 0], [6, 0]]] as const;
  ok('pathAt：多段路径按进度分段、q=1 不越界', near(pathAt(segs, 0.5).p[0], 3, 1e-6) && pathAt(segs, 1).p[0] <= 6 && pathAt(segs, 1).p[0] > 5.9);
}

// ── 宽高比：[1.15, 2.10] 之内播完整动画 ──
ok('aspectOk：16:9、16:10、4:3 播；超宽屏（21:9、32:9）与竖屏定格',
  aspectOk(1920, 1080) && aspectOk(1440, 900) && aspectOk(1280, 960) && !aspectOk(2560, 1080) && !aspectOk(3840, 1080) && !aspectOk(900, 1200) && aspectOk(2000, 1000));

// ── 审查修复：夜 / 昼开屏的时间表与路径（场景数据的纯函数检查）──
{
  const px = (u: number, v: number): [number, number] => [u * 1920, v * 1080];
  const samples = Array.from({ length: 241 }, (_, i) => pathAt(NIGHT.NP.pathA, i / 240).p);
  ok('夜·路径 A：最高处 v ≥ 0.585（不再爬到标题块旁边，这是 1440×900 里离分隔线只有 35 px 的原因）', Math.min(...samples.map((p) => p[1])) >= 0.585, String(Math.min(...samples.map((p) => p[1]))));
  const box = { l: 137, t: 345, r: 600, b: 612 };   // 终帧标题块（含细线与火种分隔线）@1920×1080
  const dist = (p: [number, number]) => { const [x, y] = px(p[0], p[1]); const dx = Math.max(box.l - x, 0, x - box.r); const dy = Math.max(box.t - y, 0, y - box.b); return Math.hypot(dx, dy); };
  ok('夜·路径 A 离标题块（含分隔线）≥ 6% 画宽（115 px）', Math.min(...samples.map(dist)) >= 0.06 * 1920, String(Math.min(...samples.map(dist))));
  const last = pathAt(NIGHT.NP.pathA, 0.9999).p;
  ok('夜·路径 A：起点是出生点，终点是落点', near(pathAt(NIGHT.NP.pathA, 0).p[0], NIGHT.NP.birth[0], 1e-9) && Math.hypot(last[0] - NIGHT.NP.land[0], last[1] - NIGHT.NP.land[1]) < 0.002);
  ok('夜·路径 A：段与段的切线连续（没有尖折线）', [0, 1].every((i) => { const a = bezD(NIGHT.NP.pathA[i], 1); const b = bezD(NIGHT.NP.pathA[i + 1], 0); const cos = (a[0] * b[0] + a[1] * b[1]) / (Math.hypot(a[0], a[1]) * Math.hypot(b[0], b[1])); return cos > 0.99; }));
  ok('夜·落点：休止姿态 rotate(−14°)（分镜 §1.1）', near(NIGHT.NP.landRot, (-14 * Math.PI) / 180, 1e-9));
  const rest = Array.from({ length: 101 }, (_, i) => NIGHT.trailRestOpacity(i / 100));
  ok('夜·定格时光点亮度随 q 严格单调增，最亮的挨着落点（q=1 为 1）', rest.every((v, i) => i === 0 || v > rest[i - 1]) && near(rest[100], 1, 1e-9) && rest[0] > 0.25);
  ok('夜·暗纱在落地那一拍的柔光脉冲之后才收（shade 起点 ≥ 落地时刻）', NIGHT.NT.shade[0] >= NIGHT.NT.fly[1] && NIGHT.NT.shade[1] <= 7.0);
  ok('昼·时间表：出生 < 展翅 < 落地，落地到定格 2.4 s，总时长 ≤ 7.5 s（提前了 0.6 s）', DAY.DT.dot[0] < DAY.DT.unfurl[0] && DAY.DT.unfurl[0] < DAY.DT.fly[0] && near(DAY.T_END, DAY.DT.fly[1] + 2.4, 1e-9) && DAY.T_END <= 7.5 && DAY.DT.fly[0] <= 2.8 + 1e-9);
  ok('昼·绽开中心在花束 / 白花处（舞台约 (1000,760)），不在她脚下的暗紫碎晶（y>860）', DAY.DC.C0[0] === 1000 && DAY.DC.C0[1] === 760 && DAY.DC.C0[1] < 860);
  ok('昼·绽开边缘羽化 ≥ 140（没有一圈看得见的边）', DAY.BLOOM_FEATHER[0] >= 80 && DAY.BLOOM_FEATHER[1] >= 140);
  // 绽开的圆在 2.7 s 前要把整个舞台（含超宽窗口的右缘）盖住：中心到最远角的距离 < 终值半径 1500
  const far = Math.max(...[[0, 0], [2100, 0], [0, 1000], [2100, 1000]].map(([x, y]) => Math.hypot(x - DAY.DC.C0[0], y - DAY.DC.C0[1])));
  ok('昼·绽开的终值半径 1500 盖得住最远的角（含 2.1:1 的窗口）', far < 1500, String(far));
}

// ── 开屏 → 主界面的转场（transition.ts）：时间表、状态、FLIP、飞行、拱窗、取景的纯函数 ──
{
  const THEMES = ['night', 'day'] as const;
  const KINDS = ['full', 'fast'] as const;
  const spansOf = (theme: 'night' | 'day', kind: 'full' | 'fast') => Object.entries((theme === 'night' ? TR.nightSegs(kind) : TR.daySegs(kind)) as unknown as Record<string, TR.Span>);

  ok('转场总长：完整版 ≤ 1.2 s、快速版 ≤ 0.7 s、减少动态的交叉淡化 ≤ 200 ms', TR.trDuration('full') <= 1.2 && TR.trDuration('fast') <= 0.7 && TR.trDuration('fast') < TR.trDuration('full') && TR.SOFT_MS <= 200);
  for (const theme of THEMES) for (const kind of KINDS) {
    const dur = TR.trDuration(kind);
    const bad = spansOf(theme, kind).filter(([, [a, b]]) => !(a >= 0 && b <= dur + 1e-9 && a < b)).map(([n]) => n);
    ok(`时间表（${theme} · ${kind}）：每一段都在 [0, ${dur}] 内且起 < 止`, bad.length === 0, bad.join(','));
    const S = (theme === 'night' ? TR.nightSegs(kind) : TR.daySegs(kind));
    ok(`时间表（${theme} · ${kind}）：蝶飞到之后真标才淡入，真标不透明之后蝶身才淡出（交叉淡化不在中途变淡）；标题 / 署名同理`,
      S.swap[0] >= S.fly[1] - 1e-9 && S.swapOut[0] >= S.swap[1] - 1e-9 && S.titleOut[0] >= S.titleSwap[1] - 1e-9 && S.creditOut[0] >= S.creditSwap[1] - 1e-9
      && S.titleSwap[0] <= S.title[1] + 1e-9 && S.titleOut[1] >= S.title[1] && S.creditOut[1] >= S.credit[1] && S.glow[0] >= S.swap[1] - 1e-9 && S.glow[1] <= dur + 1e-9);
    const blocks = Array.from({ length: 12 }, (_, i) => TR.blockSpan(kind, i));
    ok(`内容块（${kind}）：按档依次浮现、全部在总长之内，第 5 档起并入最后一档`, blocks.every((s, i) => s[1] <= dur + 1e-9 && (i === 0 || s[0] >= blocks[i - 1][0])) && blocks[TR.BLOCK_CAP][0] === blocks[11][0]);
  }
  for (const theme of THEMES) {
    // 主栏玻璃 → 第一档内容（输入框、日期行、归来简同档）→ ……：每档错开 40 ms（完整版）；夜的第一档 0.46 s 起（玻璃 0.40 s 起），昼的第一档 0.40 s 起（窗的左缘越过它们的时刻）
    const S = theme === 'night' ? TR.nightSegs('full') : TR.daySegs('full');
    const start0 = theme === 'night' ? TR.BLOCK_START : TR.BLOCK_START_DAY;
    const starts = [0, 1, 2, 3, 4, 5].map((i) => TR.blockSpan('full', i, start0)[0]);
    const gaps = starts.slice(1).map((s0, i) => s0 - starts[i]);
    ok(`依次浮现（${theme}）：各档内容块每档错开 40 ms，最多 ${TR.BLOCK_CAP + 1} 档（再多的并入最后一档）；第一档不早于主栏玻璃的起点`, gaps.slice(0, TR.BLOCK_CAP).every((g) => near(g, 0.04, 1e-9)) && near(gaps[TR.BLOCK_CAP], 0, 1e-9) && starts[0] >= S.glass[0] - 1e-9, gaps.map((g) => g.toFixed(3)).join(' '));
    ok(`依次浮现（${theme}）：输入框（第一档）在 0.60 s 时有效不透明度 ≥ 0.5（起点 + 60 ms ≤ 0.60 s；快速版按比例 ≤ 0.45 s）`, start0 + 0.06 <= 0.6 && (start0 + 0.06) * (7 / 12) <= 0.45);
    ok(`依次浮现（${theme}）：左栏面板先于主栏玻璃（夜：随取景推入；昼：没有面板，条目各自尾流浮现）`, S.nav[0] < S.glass[0]);
  }
  {
    // 领拍：蝶先抬起（0 s 起飞），镜头 / 立绘 / 左栏面板从 0.10 s 起，标题从 0.14 s 起
    const N = TR.nightSegs('full');
    const D = TR.daySegs('full');
    ok('领拍：蝶 0 s 起飞；取景平移 / 立绘 / 左栏面板 ≥ 0.10 s、标题 ≥ 0.14 s 才动（整屏不再一齐起跳）',
      N.fly[0] === 0 && D.fly[0] === 0 && N.pan[0] >= 0.1 - 1e-9 && D.art[0] >= 0.1 - 1e-9 && N.nav[0] >= 0.1 - 1e-9 && N.title[0] >= 0.14 - 1e-9 && D.title[0] >= 0.14 - 1e-9 && N.credit[0] > N.title[0]);
    ok('取景平移与左栏面板推入是同一段时间、同一条曲线（两边咬得住）', N.pan[0] === N.nav[0] && N.pan[1] === N.nav[1] && TR.PAN_CSS === 'cubic-bezier(0.33, 0.1, 0.2, 1)');
    ok('夜：暗纱与主栏玻璃同段收放（暗纱 16%–80%、玻璃 40%–82%），主栏区亮度不再「亮—暗—亮」泵一下', N.shade[1] === 0.8 && N.shade[1] <= N.glass[1] && N.shade[0] < N.glass[0]);
    ok('昼：场景淡出与纸面展开交叠 ≥ 150 ms（左侧任何一帧都不是全空的）', D.scene[1] - D.paper[0] >= 0.15 - 1e-9);
    ok('昼：原画的背景在收窗运动最快的一段（0.34–0.66 s）淡成窗里的薰衣草底：起点在收窗开始 ≥ 0.24 s 之后（窗的形状已经读得出来，不是在近乎全屏时就变成了薰衣草）、终点早于收窗结束 ≥ 0.18 s、中点落在峰速段（0.44–0.62 s）；临时底在收窗将尽时才淡出',
      D.wash[0] >= D.art[0] + 0.24 - 1e-9 && D.wash[1] <= D.art[1] - 0.18 + 1e-9 && (D.wash[0] + D.wash[1]) / 2 >= 0.44 && (D.wash[0] + D.wash[1]) / 2 <= 0.62 && D.wOut[0] >= D.wash[1] && D.wOut[1] <= D.figOut[1]);
    {
      // 立绘收窗的速度峰值落在 wash 段里：换景由运动遮住
      let pk = 0; let pkAt = 0;
      for (let i = 0; i < 1000; i++) { const t = (i / 1000) * 1.2; const v = TR.trState('day', 'full', t + 0.001).art - TR.trState('day', 'full', t).art; if (v > pk) { pk = v; pkAt = t; } }
      ok('昼：立绘收窗速度最快的时刻（实测 0.58–0.70 s）落在原画换景（wash）的段里——运动遮住换景', pkAt >= D.wash[0] && pkAt <= D.wash[1], pkAt.toFixed(3));
    }
    ok('昼：标题比蝶晚起爬 0.06 s（蝶先抢进左缘的通道，两者不在 (80, 100) 附近相交）', D.title[0] >= 0.2 - 1e-9 && D.title[0] < D.credit[0] + 0.1 && D.title[1] === 0.8);
    ok('昼：真立绘先在分身下面淡入（figIn）、分身再淡出（figOut）——先后错开；分身在原画上淡入发生在收窗刚开始时', D.figIn[1] <= D.figOut[0] + 1e-9 && D.figOn[1] <= D.wash[0] + 0.15 && D.figOn[0] < D.art[0]);
    ok('昼：署名不飞——拱窗里的署名原地淡入，并且在立绘落定之前就到位', D.creditIn[0] > D.ambient[1] && D.creditIn[1] <= D.art[1]);
    // 立绘收窗的缓动：峰值速度比第一版（(0.35,0.1,0.15,1) 走 0.8 s）小
    const peak = (f: (t: number) => number, d: number) => { let m = 0; for (let i = 0; i < 1000; i++) m = Math.max(m, (f((i + 1) / 1000) - f(i / 1000)) * 1000 / d); return m; };
    const old = peak(cubic(0.35, 0.1, 0.15, 1), 0.8);
    const now = peak(TR.ART_E, D.art[1] - D.art[0]);
    ok('昼：立绘收窗的峰值速度 ≤ 第一版的 0.9 倍（R4 是 0.77 倍，R5 把终点提前到 0.84 s、尾巴收短，峰值升到约 0.86 倍，仍低于第一版）；起点有 0.10 s 的领拍', now <= old * 0.9 && now >= old * 0.7, `${(now / old).toFixed(2)}×`);
  }

  // 状态：tr=0 处处是「原样」，tr=总长处处是终态；随 tr 单调不减
  for (const theme of THEMES) for (const kind of KINDS) {
    const dur = TR.trDuration(kind);
    const s0 = TR.trState(theme, kind, 0) as unknown as Record<string, number>;
    const s1 = TR.trState(theme, kind, dur) as unknown as Record<string, number>;
    const mid = Array.from({ length: 121 }, (_, i) => TR.trState(theme, kind, (dur * i) / 120) as unknown as Record<string, number>);
    const keys = Object.keys(s0);
    const DAY_ONLY = ['art', 'winL', 'figOn', 'figIn', 'figOut', 'wash', 'wOut', 'scene', 'textOut', 'washTop', 'bg', 'bgF', 'paper', 'creditIn'];
    const used = (theme === 'night' ? keys.filter((k) => !DAY_ONLY.includes(k)) : keys.filter((k) => !['pan', 'shade', 'dissolve', 'dissolveP'].includes(k))).filter((k) => k !== 'flap');
    ok(`转场状态（${theme} · ${kind}）：tr=0 全部是 0（与定格那一帧逐像素相同）`, used.every((k) => s0[k] === 0), used.filter((k) => s0[k] !== 0).join(','));
    ok(`转场状态（${theme} · ${kind}）：tr=总长 全部到终态 1（蝶、标题、署名、底图、拱窗、玻璃都落定）`, used.every((k) => s1[k] === 1), used.filter((k) => s1[k] !== 1).join(','));
    ok(`转场状态（${theme} · ${kind}）：每一项随 tr 单调不减（拍翅幅度除外：它起落）`, used.every((k) => mid.every((m, i) => i === 0 || m[k] >= mid[i - 1][k] - 1e-9)));
    ok(`转场状态（${theme} · ${kind}）：拍翅幅度起落于 0，不超过 1`, s0.flap === 0 && s1.flap === 0 && mid.every((m) => m.flap >= 0 && m.flap <= 1 + 1e-9));
  }
  ok('状态是 tr 的纯函数：同一个 tr 同一个结果（导出与实时一致）', JSON.stringify(TR.trState('night', 'full', 0.437)) === JSON.stringify(TR.trState('night', 'full', 0.437)) && JSON.stringify(TR.trState('day', 'fast', 0.21)) === JSON.stringify(TR.trState('day', 'fast', 0.21)));

  // FLIP：把文字矩形 src 放到 dst（transform-origin 在元素左上角）
  {
    const el = { x: 137, y: 335, w: 500, h: 137 };
    const src = { x: 140, y: 350, w: 280, h: 190 };
    const dst = { x: 62, y: 18.5, w: 43, h: 27 };
    const f = TR.flipTo(el, src, dst);
    const px = (u: number, v: number) => [el.x + f.x + (u - el.x) * f.s, el.y + f.y + (v - el.y) * f.s];
    const tl = px(src.x, src.y);
    const br = px(src.x + src.w, src.y + src.h);
    ok('flipTo：变换后 src 的左上角落在 dst 的左上角、高度等于 dst 的高度', near(tl[0], dst.x, 1e-9) && near(tl[1], dst.y, 1e-9) && near(br[1] - tl[1], dst.h, 1e-9) && near(f.s, dst.h / src.h, 1e-12));
    const f0 = TR.flipAt(f, 0);
    const f1 = TR.flipAt(f, 1);
    ok('flipAt：p=0 是原位原大小、p=1 到位；缩放按几何插值（缩小时匀速）', f0.x === 0 && f0.y === 0 && f0.s === 1 && near(f1.x, f.x) && near(f1.y, f.y) && near(f1.s, f.s) && near(TR.flipAt(f, 0.5).s, Math.sqrt(f.s), 1e-9));
    ok('flipCss：parentScale 把平移换算成容器的局部单位', TR.flipCss({ x: 100, y: -50, s: 0.5 }, 2) === 'translate(50.00px, -25.00px) scale(0.50000)');
    const cr = { x: 1508, y: 1000, w: 480, h: 18 };
    const fr = TR.flipRight(cr, { x: 1508.9, y: 1014, w: 391, h: 16 });
    ok('flipRight：署名右对齐——缩放后右缘与目标右缘对齐（文字长短不同也不伸出窗口）', near(cr.x + fr.x + cr.w * fr.s, 1508.9 + 391, 1e-9) && near(cr.y + fr.y, 1014, 1e-9));
  }

  // 飞行：起点、终点、尺寸、朝向、不出屏
  {
    const mark = { x: 16, y: 18, w: 38, h: 38 };
    const goal = TR.brandGoal(mark);
    ok('品牌标里那只蝶：中心在方框 (0.654, 0.488)、翼展 0.62 个方框、转 −14°（与开屏停枝的休止姿态同角）', near(goal.x, 16 + 38 * 0.654, 1e-9) && near(goal.y, 18 + 38 * 0.488, 1e-9) && near(goal.w, 38 * 0.62, 1e-9) && near(goal.rot, (-14 * Math.PI) / 180, 1e-12));
    for (const [name, a, W, H] of [['夜 1920×1080', [450, 880], 1920, 1080], ['夜 1440×900', [330, 740], 1440, 900], ['昼 1920×1080（枝梢）', [393, 214], 1920, 1080]] as const) {
      const g = TR.flightPath(a, [goal.x, goal.y]);
      const start = { x: a[0], y: a[1], w: 108, rot: (-14 * Math.PI) / 180, flap: 0.85, alpha: 1 };
      const poses = Array.from({ length: 101 }, (_, i) => TR.bfFlight(start, goal, g, i / 100, TR.flapAmp(i / 100), i / 100));
      const p0 = poses[0];
      const p1 = poses[100];
      ok(`飞行（${name}）：起点就是停枝的位置、终点正好落在品牌标的蝶上（位置、翼展、朝向、翅平展）`, near(p0.x, a[0]) && near(p0.y, a[1]) && near(p0.w, 108) && near(p0.rot, start.rot) && near(p1.x, goal.x, 1e-6) && near(p1.y, goal.y, 1e-6) && near(p1.w, goal.w, 1e-6) && near(Math.cos(p1.rot - goal.rot), 1, 1e-9) && p1.flap === 1);
      ok(`飞行（${name}）：全程在窗口之内（不飞出屏）、翼展单调收小（越飞越远）`, poses.every((p) => p.x > -40 && p.x < W + 40 && p.y > -40 && p.y < H + 40) && poses.every((p, i) => i === 0 || p.w <= poses[i - 1].w + 1e-9));
      const d = bezD(g, 1);
      ok(`飞行（${name}）：自 a 所在的那一侧斜着飘入（收尾时向左、向上走，不是竖直落下）`, d[0] < 0 && d[1] < 0);
    }
  }

  // 昼：立绘收进拱窗
  {
    const arch = { x: 1208.5, y: 12, w: 699.5, h: 1056 };
    const c0 = TR.archClip(0, 1920, 1080, arch);
    const c1 = TR.archClip(1, 1920, 1080, arch);
    ok('archClip：p=0 是整个窗口（四边 0、没有圆角）；p=1 恰好是拱窗（顶圆角 = 半宽、底圆角 16）', c0.t === 0 && c0.l === 0 && c0.r === 0 && c0.b === 0 && c0.rTop === 0 && c0.rBot === 0 && near(c1.l, arch.x) && near(c1.t, arch.y) && near(c1.r, 1920 - 1908) && near(c1.b, 1080 - 1068) && near(c1.rTop, arch.w / 2) && near(c1.rBot, 16));
    const cs = Array.from({ length: 51 }, (_, i) => TR.archClip(i / 50, 1920, 1080, arch));
    ok('archClip：裁切框只缩不胀（四边内缩与圆角随 p 单调增）', cs.every((c, i) => i === 0 || (c.t >= cs[i - 1].t && c.l >= cs[i - 1].l && c.r >= cs[i - 1].r && c.b >= cs[i - 1].b && c.rTop >= cs[i - 1].rTop)));
    ok('archClipCss：inset(… round 顶左 顶右 底右 底左)', /^inset\([\d.]+px [\d.]+px [\d.]+px [\d.]+px round [\d.]+px [\d.]+px [\d.]+px [\d.]+px\)$/.test(TR.archClipCss(c1)));
    // 拱窗里立绘的方框（decor.css .daystage：--ah = 窗高 − 24；宽 = 0.6624·ah；图 left −0.4268·ah、top −0.0849·ah、宽 1.0531·ah）
    const H = 1080;
    const ah = H - 24;
    const fig = { x: 1920 - 12 - 0.6624 * ah - 0.4268 * ah, y: 12 - 0.0849 * ah, w: 1.0531 * ah, h: (1.0531 * ah * 1600) / 1181 };
    const k = H / 1000;
    const fit = TR.artFit(k, fig);
    const sb = (1280 / 1600) * k;
    const screenX = (u: number) => TR.ART_STAGE.x * k + fit.dx + fit.r * u * sb;
    const screenY = (v: number) => TR.ART_STAGE.y * k + fit.dy + fit.r * v * sb;
    ok('artFit：开屏里的立绘落到拱窗里立绘的位置——素材像素 (193.9, 227.7) 恰在窗里立绘的左上角，右缘恰在它的右缘', near(screenX(TR.FIG_REG.x), fig.x, 1e-6) && near(screenY(TR.FIG_REG.y), fig.y, 1e-6) && near(screenX(TR.FIG_REG.x + TR.FIG_REG.s * TR.FIG_REG.w), fig.x + fig.w, 1e-6), `${screenX(TR.FIG_REG.x).toFixed(2)} vs ${fig.x.toFixed(2)}`);
    ok('artFit：1080p 上立绘放大约 1.72 倍（从全身收成窗里的近景）', near(fit.r, 1.719, 0.01), String(fit.r));
  }

  // 夜：同一张壁纸的取景
  ok('wallpaperTx：1920×1080 首页（她在窗宽 65%）图左缘在 153.6 px；开屏定格的取景（57%）是 0，所以只是向右轻移 0.08 窗宽', near(TR.wallpaperTx(1920, 1080, 0.65, 0.57), 153.6, 0.05) && near(TR.wallpaperTx(1920, 1080, 0.57, 0.57), 0, 0.05));
  ok('wallpaperTx：窄一点的窗口（1440×900，图宽 1600）：首页取景 24、开屏定格取景 −91.2（夹在 [窗宽−图宽, 160] 内）', near(TR.wallpaperTx(1440, 900, 0.65, 0.57), 24, 0.05) && near(TR.wallpaperTx(1440, 900, 0.57, 0.57), -91.2, 0.05) && TR.wallpaperTx(1000, 900, 0.9, 0.57) <= 160);
}

// ── 转场（二）：尾流、左栏推入与底板的洞、纸面的羽化展开、枝的生长、人物分身的落位 ──
{
  // flipRectAt 是 flipTo 的正向：把 src 放到 dst 之后，矩形恰是 dst；p=0 恰是 src
  const el = { x: 137, y: 335, w: 500, h: 137 };
  const src = { x: 140, y: 350, w: 280, h: 190 };
  const dst = { x: 62, y: 18.5, w: 43, h: 27 };
  const f = TR.flipTo(el, src, dst);
  const r1 = TR.flipRectAt(el, src, TR.flipAt(f, 1));
  const r0 = TR.flipRectAt(el, src, TR.flipAt(f, 0));
  ok('flipRectAt：p=1 时文字矩形恰是 dst 的左上角与高度、p=0 时恰是 src（尾流的障碍物与屏幕上的标题同一个矩形）', near(r1.x, dst.x, 1e-9) && near(r1.y, dst.y, 1e-9) && near(r1.h, dst.h, 1e-9) && near(r0.x, src.x, 1e-9) && near(r0.w, src.w, 1e-9));

  // 尾流：障碍物（标题）自下而上飞过：下面的行不必等、被飞过的行等它飞过再 + delay、从不相交的不等
  {
    const dur = 1.2;
    const title = (tr: number) => [{ x: 100, y: 500 - 480 * Math.min(1, tr / 0.8), w: 80, h: 40 }];        // 自 y=500 匀速飞到 y=20
    const samples = TR.sampleObstacles(title, dur);
    const row = (y: number) => ({ x: 20, y, w: 160, h: 30 });
    const wBelow = TR.wakeTime(() => row(900), samples, dur);
    const wFar = TR.wakeTime(() => ({ x: 600, y: 300, w: 100, h: 30 }), samples, dur);
    const wMid = TR.wakeTime(() => row(300), samples, dur);
    const wTop = TR.wakeTime(() => row(100), samples, dur);
    const hitEnd = (y: number) => { let last = 0; for (let i = 0; i < samples.length; i++) if (samples[i].some((b) => TR.rectHit(row(y), b, TR.WAKE_PAD))) last = i * TR.WAKE_STEP; return last; };
    ok('尾流：不在标题路径上的行 / 在它下面很远的行不必等（wake = 0）', wBelow === 0 && wFar === 0);
    ok('尾流：被飞过的行等标题飞过再 40 ms（wake = 最后一次相交 + delay）；越靠上的行越晚（自下而上）', near(wMid, hitEnd(300) + TR.WAKE_DELAY, 1e-9) && near(wTop, hitEnd(100) + TR.WAKE_DELAY, 1e-9) && wMid < wTop, `${wMid} ${hitEnd(300)} ${wTop} ${hitEnd(100)}`);
    ok('尾流：目标自己在平移（左栏推入）时按它当时的位置判断——还在屏外的行不会被标题挡住', TR.wakeTime((tr) => ({ x: 20 - 400 * (1 - Math.min(1, tr / 0.6)), y: 300, w: 160, h: 30 }), samples, dur) < wMid);
    const rs = (y: number, wake: number) => TR.rowSpan('full', y, 1080, wake);
    ok('左栏条目的浮现区间：下面的行更早（自下而上轻扫）、wake 之后才开始、全部在总长之内；快速版按比例缩', rs(1000, 0)[0] < rs(100, 0)[0] && rs(100, 0.7)[0] === 0.7 && [0, 0.5, 0.9, 1.19].every((w) => rs(500, w)[1] <= 1.2 + 1e-9 && rs(500, w)[0] < rs(500, w)[1]) && TR.rowSpan('fast', 500, 1080, 0)[0] < rs(500, 0)[0]);
    ok('左栏条目：面板空着的头 0.30 s 里没有任何一行开始浮现（ROW_BASE）', rs(1080, 0)[0] >= TR.ROW_BASE - 1e-9);
    {
      // 夜里面板是从屏外推进来的：条目的底线取「面板到位」的时刻（推入结束 − 0.04 s），推入期间面板里一行都不开始浮现（评审 R4：底部的花行 / 额度 / 话量骑着面板、被屏幕左缘切着进来）
      const N = TR.nightSegs('full');
      const NF = TR.nightSegs('fast');
      const base = N.nav[1] - 0.04;
      const rb = (y: number) => TR.rowSpan('full', y, 1080, 0, 0, base);
      ok('左栏条目（夜 · 完整版）：base = 面板到位（0.50 s），最靠下的一行也不早于它、仍自下而上轻扫、全部在总长内', rb(1080)[0] >= base - 1e-9 && rb(1000)[0] < rb(100)[0] && rb(100)[1] <= 1.2 + 1e-9);
      const baseF = NF.nav[1] - 0.04 * (7 / 12);
      ok('左栏条目（夜 · 快速版）：base = 面板到位（推入 0.05–0.42 s 结束之前 23 ms），全部在 0.7 s 内', TR.rowSpan('fast', 1080, 1080, 0, 0, baseF)[0] >= baseF - 1e-9 && TR.rowSpan('fast', 100, 1080, 0, 0, baseF)[1] <= 0.7 + 1e-9);
      ok('夜 · 推入期间面板里的内容不透明度为 0 的前提：底线晚于推入已走过 99% 的时刻（PAN_E 在 base 时 ≥ 0.99）', TR.PAN_E((base - N.nav[0]) / (N.nav[1] - N.nav[0])) >= 0.99 && TR.PAN_E((baseF - NF.nav[0]) / (NF.nav[1] - NF.nav[0])) >= 0.98);
    }
  }

  // 左栏推入与底板的洞
  {
    const nav = { x: 0, y: 0, w: 216, h: 1080 };
    ok('navPushable：贴左缘的竖栏可以推入；顶部横条（窄窗口）、右侧栏、太宽的不行', TR.navPushable(nav, 1920, 1080) && !TR.navPushable({ x: 0, y: 0, w: 1000, h: 60 }, 1000, 800) && !TR.navPushable({ x: 1500, y: 0, w: 216, h: 1080 }, 1920, 1080) && !TR.navPushable(undefined, 1920, 1080));
    ok('navPushX：pan=0 在屏外（−宽度）、pan=1 到位（0），单调', near(TR.navPushX(216, 0), -216) && near(TR.navPushX(216, 1), 0) && TR.navPushX(216, 0.4) < TR.navPushX(216, 0.6));
    // 取景平移露出的暗带宽 = 平移量；洞的右缘永远 ≥ 暗带的右缘（暗带藏在左栏下面，不会作为一条黑边滑进屏幕）
    const shiftMax = TR.wallpaperTx(1920, 1080, 0.65, 0.57) - TR.wallpaperTx(1920, 1080, 0.57, 0.57);
    let hidden = true;
    for (let i = 0; i <= 100; i++) { const p = i / 100; if (TR.holeEdge(nav.w, shiftMax * p, p) < shiftMax * p - 1e-9) hidden = false; }
    ok('holeEdge：1080p 上洞的右缘（左栏的右缘）始终 ≥ 取景平移露出的暗带（154 px × 进度），黑带永远藏在面板下面', hidden && near(shiftMax, 153.6, 0.1) && nav.w >= shiftMax);
    ok('holeEdge：左栏比平移量窄（紧凑栏）时洞取暗带宽——暗带同样不会露在开屏底板里', near(TR.holeEdge(56, 153.6, 1), 153.6) && near(TR.holeEdge(56, 153.6 * 0.5, 0.5), 76.8));
    ok('holeMask：x=0 不要遮罩；x>0 是「x 之前透明、之后不透明」的横向渐变', TR.holeMask(0) === '' && /^linear-gradient\(90deg, transparent 154\.00px, #000 154\.00px\)$/.test(TR.holeMask(154)));
    ok('holeClip：x=0 不要裁切；x>0 是只裁掉左边 x 像素的矩形（硬边，与 holeMask 同一个洞；底板仍是不透明的矩形，合成器能剔掉它下面的整个界面）', TR.holeClip(0) === '' && TR.holeClip(154) === 'inset(0 0 0 154.00px)');
  }

  // 昼：纸面的羽化展开
  {
    const pm = TR.paperMask(972);
    ok('paperMask：没有窗时（退路）p=0 前缘在元素左缘之外（什么都没露）、p=1 纸面（含左右各 40 px 的阴影）整个露出；前缘随进度单调右移', pm.midAt(pm.xeAt(0)) < 0 && pm.x0At(pm.xeAt(0)) + pm.A + TR.PAPER_FEATHER <= -TR.PAPER_EXT + 1e-9 && pm.midAt(pm.xeAt(1)) > 972 + TR.PAPER_EXT && pm.x0At(pm.xeAt(1)) === -TR.PAPER_EXT && pm.midAt(pm.xeAt(0.3)) < pm.midAt(pm.xeAt(0.6)));
    ok('paperMask：前缘羽化 140 px（R5：高速时由这条软边领跑，不是一根硬竖条；原来 56 px）、渐变在 A 处才开始变透明', TR.PAPER_FEATHER >= 120 && TR.PAPER_FEATHER <= 160 && pm.image.includes(`${pm.A}px, transparent ${pm.A + TR.PAPER_FEATHER}px`));
    // 有窗时：纸面的前缘就是窗的左缘（全屏只有一条移动的竖边；纸始终在窗下面）
    ok('paperEdge：前缘 = 窗的左缘 − 6 px（相对纸面左缘）；窗走完之后再向窗里推 PAPER_TAIL（藏在窗下面，羽化带也整个藏进去，结束时撤掉遮罩不会有一跳）；窗还没动时在纸面之外',
      near(TR.paperEdge(500, 220, 0.5), 500 - 220 - TR.PAPER_GAP) && near(TR.paperEdge(1208.5, 220, 1), 1208.5 - 220 - TR.PAPER_GAP + TR.PAPER_TAIL) && TR.paperEdge(0, 220, 0) < 0 && near(TR.paperEdge(1208.5, 220, 0.9), 1208.5 - 220 - TR.PAPER_GAP));
    {
      const k = 1.08;
      const sa = { x: 1208.5 / k, y: 12 / k, w: 699.5 / k, h: 1056 / k };
      const edge = (tr: number, kind: 'full' | 'fast') => { const st = TR.trState('day', kind, tr); const wl = TR.archClip(st.art, 1920 / k, 1000, sa, 16 / k, st.winL).l * k; return TR.paperEdge(wl, 220, st.winL); };
      const run = (kind: 'full' | 'fast') => Array.from({ length: 141 }, (_, i) => edge((TR.trDuration(kind) * i) / 140, kind));
      ok('纸面前缘随 tr 单调右移（完整版 / 快速版；窗的左缘走 WIN_E、尾巴走 smoothstep）；终点铺满纸面（含阴影）：前缘 − 羽化 ≥ 纸宽 + 40', (['full', 'fast'] as const).every((kd) => run(kd).every((v, i, a) => i === 0 || v >= a[i - 1] - 1e-9)) && run('full')[140] - TR.PAPER_FEATHER >= 972 + TR.PAPER_EXT && run('fast')[140] - TR.PAPER_FEATHER >= 972 + TR.PAPER_EXT && run('full')[0] < -TR.PAPER_EXT);
      // 窗的左缘比立绘的缩放走得急：0.35 s 已过 77%（主栏的块所在的位置），输入框 / 归来简不必等窗收到 0.9 s
      const D = TR.daySegs('full');
      const DF = TR.daySegs('fast');
      ok('窗的左缘（winL）比立绘的缩放（art）走得急：完整版 0.35 s 已过 77%（立绘还没到 70%）、0.58 s 走完（立绘 0.92 s）；快速版 0.30 s 已过 77%、0.48 s 走完',
        TR.trState('day', 'full', 0.35).winL >= 0.77 && TR.trState('day', 'full', 0.35).art < 0.7 && TR.trState('day', 'full', D.win[1]).winL === 1 && TR.trState('day', 'full', D.win[1]).art < 1 && TR.trState('day', 'fast', 0.3).winL >= 0.77 && TR.trState('day', 'fast', DF.win[1]).winL === 1,
        `${TR.trState('day', 'full', 0.35).winL.toFixed(3)} / ${TR.trState('day', 'full', 0.35).art.toFixed(3)}`);
      const pk = (kind: 'full' | 'fast') => { let m = 0; const d = TR.trDuration(kind); for (let i = 0; i < 2000; i++) { const t = (i / 2000) * d; m = Math.max(m, ((TR.trState('day', kind, t + 0.0005).winL - TR.trState('day', kind, t).winL) / 0.0005) * 1208.5); } return m; };
      ok('窗的左缘的峰值速度（1920 宽、0 → 1208.5 px）：完整版 ≤ 6000 px/s、快速版 ≤ 7000 px/s（不甩；快速版不再按 7/12 压缩——压缩了要 9000 px/s 以上）', pk('full') <= 6000 && pk('fast') <= 7000, `${pk('full').toFixed(0)} / ${pk('fast').toFixed(0)}`);
      ok('窗在 win 段之外不动：tr < win 起点时 winL = 0、立绘（art）与窗的左缘各走各的进度（archClip 的 pl）', TR.trState('day', 'full', D.win[0] - 0.01).winL === 0 && near(TR.archClip(0.4, 1920, 1080, { x: 1208.5, y: 12, w: 699.5, h: 1056 }, 16, 0.9).l, 0.9 * 1208.5) && near(TR.archClip(0.4, 1920, 1080, { x: 1208.5, y: 12, w: 699.5, h: 1056 }, 16, 0.9).t, 0.4 * 12) && near(TR.archClip(0.4, 1920, 1080, { x: 1208.5, y: 12, w: 699.5, h: 1056 }, 16, 0.9).rTop, 0.9 * 699.5 / 2));
      ok('昼 · 底板的撤离（bg）在纸面前缘走完之后（0.36 s 起、smoothstep）整体淡出；没有窗时按时间（bgF 0.15–0.60 s）', D.bg[0] >= 0.35 && D.bg[1] > D.win[1] && D.bgF[0] === 0.15 && D.bgF[1] === 0.6);
    }
  }

  // 枝的生长绑在蝶的路程上
  {
    const g = (u: number) => TR.twigGrow(u);
    ok('twigGrow：蝶飞过 72.5% 之前一笔都没有（品牌标的位置上没有一根枝在等蝶）、落定（100%）时恰好长满、单调', g(0) === 0 && g(0.55) === 0 && g(TR.TWIG_FROM) === 0 && g(1) === 1 && Array.from({ length: 101 }, (_, i) => g(i / 100)).every((v, i, a) => i === 0 || v >= a[i - 1]));
    ok('枝的生长：转场开始后 0.5 s 内（蝶还在半路）枝是空的；0.58 s 起长、0.80 s（蝶落定那一帧）长满', [0.1, 0.2, 0.3, 0.4, 0.5, 0.57].every((tr) => TR.twigGrow(TR.trState('night', 'full', tr).flyRaw) === 0 && TR.twigGrow(TR.trState('day', 'full', tr).flyRaw) === 0) && TR.twigGrow(TR.trState('night', 'full', 0.6).flyRaw) > 0 && TR.twigGrow(TR.trState('night', 'full', 0.8).flyRaw) === 1 && TR.twigGrow(TR.trState('night', 'fast', 0.8 * 7 / 12).flyRaw) === 1);
    {
      // 枝根那一小段近乎水平的起笔不会作为「一」读出来：生长的前 30% 整体的不透明度从 0 升到 1（第一帧不可读）
      const a = TR.twigAlpha;
      ok('twigAlpha：生长刚起笔时不透明度几乎为 0（grow = 0.05 时 < 0.1）、前 30% 升到 1、单调', a(0) === 0 && a(0.05) < 0.1 && a(0.3) === 1 && a(1) === 1 && Array.from({ length: 101 }, (_, i) => a(i / 100)).every((v, i, arr) => i === 0 || v >= arr[i - 1]));
      // 起笔的头 3 帧（60 fps）：枝的可读程度（长度 × 不透明度）不超过全长的 5%——不会有一段孤立的平笔悬着
      const readable = [0, 1, 2, 3].map((f) => { const tr = 0.58 + f / 60; const gr = TR.twigGrow(TR.trState('night', 'full', tr).flyRaw); return gr * a(gr); });
      ok('枝的起笔：头 3 帧里（长度 × 不透明度）的可读程度逐帧递增、第 2 帧 < 1%、第 3 帧 < 8%（读成枝随蝶临近一笔画出来，不是先悬一道短横；旧的 E.ease 起笔第 3 帧已是 40% 以上）', readable[2] < 0.01 && readable[3] < 0.08 && readable.every((v, i) => i === 0 || v >= readable[i - 1]), readable.map((v) => v.toFixed(3)).join(' '));
    }
  }

  // 昼：人物分身（figure-official 抠图）叠在原画里同一个人的位置，并随原画的同一个变换落到窗里的立绘位置
  {
    const k = 1080 / 1000;
    const H = 1080;
    const ah = H - 24;
    const fig = { x: 1920 - 12 - 0.6624 * ah - 0.4268 * ah, y: 12 - 0.0849 * ah, w: 1.0531 * ah, h: (1.0531 * ah * 1600) / 1181 };
    const fit = TR.artFit(k, fig);
    ok('FIG_STAGE：宽高比与 figure-official（1181:1600）一致；左上角在原画（舞台 (470,−62)、每素材像素 0.8）里配准点 (193.9, 227.7) 处', near(TR.FIG_STAGE.w / TR.FIG_STAGE.h, 1181 / 1600, 1e-9) && near(TR.FIG_STAGE.x, 470 + 0.8 * 193.9, 1e-9) && near(TR.FIG_STAGE.y, -62 + 0.8 * 227.7, 1e-9) && near(TR.FIG_STAGE.w, 0.8 * 0.634 * 1181, 1e-9));
    // 分身的 transform-origin 取原画的左上角：落定后分身的屏幕位置 = 原画变换后的位置 = 窗里的立绘
    const sx = TR.ART_STAGE.x * k + fit.dx + fit.r * k * (TR.FIG_STAGE.x - TR.ART_STAGE.x);
    const sy = TR.ART_STAGE.y * k + fit.dy + fit.r * k * (TR.FIG_STAGE.y - TR.ART_STAGE.y);
    const sw = fit.r * k * TR.FIG_STAGE.w;
    ok('分身落定（p=1）：恰好叠在拱窗里立绘（figure-official）的方框上——位置与宽度逐像素对上，所以换手看不出来', near(sx, fig.x, 1e-6) && near(sy, fig.y, 1e-6) && near(sw, fig.w, 1e-6), `${sx.toFixed(3)} vs ${fig.x.toFixed(3)}；${sw.toFixed(3)} vs ${fig.w.toFixed(3)}`);
  }
  // ── 评审 R2 修订：收尾路径、被打断的标题、窗的遮挡、光环、取景对齐 ──
  {
    // 蝶的收尾：落点右边紧挨着飞来的字标，蝶自品牌标的正下方升入——身体全程不穿过落座后的字标（评审：0.47–0.60 s 蝶贴在「枝」「栖」上爬过，重叠约 80%）
    const mark = { x: 16, y: 18, w: 38, h: 38 };
    const goal = TR.brandGoal(mark);
    const titleRects = [{ x: 62, y: 15.5, w: 43.3, h: 27 }, { x: 62, y: 41.5, w: 62, h: 14 }];       // 1080p 左栏里「栖枝」「ALIGHT」的文字矩形（终态）
    for (const [name, a, w0] of [['夜 1920×1080', [450, 880], 108], ['夜 1440×900', [330, 740], 90], ['昼 1920×1080（枝梢）', [393, 214], 108], ['夜 被打断在半路', [300, 500], 70]] as const) {
      const g = TR.flightPath(a, [goal.x, goal.y]);
      const start = { x: a[0], y: a[1], w: w0, rot: (-14 * Math.PI) / 180, flap: 0.85, alpha: 1 };
      let hits = 0;
      for (let i = 0; i <= 400; i++) {
        const p = TR.bfFlight(start, goal, g, i / 400, 0, 0);
        const core = { x: p.x - p.w * 0.35, y: p.y - p.w * 0.3, w: p.w * 0.7, h: p.w * 0.6 };
        if (titleRects.some((t) => TR.rectHit(core, t, 2))) hits++;
      }
      ok(`飞行（${name}）：蝶的身体全程不穿过落座后的字标（收尾自品牌标的正下方升入）`, hits === 0, `${hits} 个采样点相交`);
      const rise = bez(g, 0.9);
      ok(`飞行（${name}）：路径走到 90% 时仍在品牌标的下方（升入的那一段在字标左下，不是横穿）`, rise[1] > goal.y + 20 && rise[0] < titleRects[0].x + 10, `(${rise[0].toFixed(0)}, ${rise[1].toFixed(0)})`);
    }
  }
  {
    // 内容块的浮现：输入框第一档（与日期行、归来简同档）；被 wake（标题 / 蝶飞过、纸面前缘、窗让开）推迟的块不早于 wake、档与档仍错开、结尾收在总长之内
    const tiers6 = [0, 0, 1, 2, 3, 0];                       // DOM 顺序：日期行、归来简、待你、离开期间、最近会话、输入框
    ok('blockTiers：输入框 0 档；日期行与归来简（DOM 的头两块）同在第一档；其余每块一档', JSON.stringify(TR.blockTiers(6, 5)) === JSON.stringify(tiers6) && JSON.stringify(TR.blockTiers(4, -1)) === '[0,0,1,2]' && JSON.stringify(TR.blockTiers(3, 0)) === '[0,0,0]');
    const plain = TR.blockSpans('full', [0, 0, 0, 0, 0, 0], tiers6);
    ok('blockSpans：没有任何 wake 时与计划的 blockSpan（按档）完全一致；输入框与日期行 / 归来简同时浮现（第一档）', plain.every((sp, i) => near(sp[0], TR.blockSpan('full', tiers6[i])[0]) && near(sp[1], TR.blockSpan('full', tiers6[i])[1])) && plain[5][0] === plain[0][0] && plain[1][0] === plain[0][0]);
    const w66 = TR.blockSpans('full', [0.66, 0.66, 0.66, 0.66, 0.66, 0.66], tiers6);
    ok('blockSpans：被窗推迟到 0.66 s 的块绝不早于 0.66 s、档与档错开 ≥ 40 ms（不挤成同一刻）、同档同时、结尾都在 1.2 s 内、输入框仍是第一档', w66.every((sp) => sp[0] >= 0.66 - 1e-9 && sp[1] <= 1.2 + 1e-9 && sp[0] < sp[1]) && w66[5][0] === w66[0][0] && w66[2][0] - w66[0][0] >= 0.04 - 1e-9 && w66[3][0] - w66[2][0] >= 0.04 - 1e-9 && w66[4][0] - w66[3][0] >= 0.04 - 1e-9, w66.map((sp) => sp[0].toFixed(2)).join(' '));
    const w90 = TR.blockSpans('full', [0.9, 0.9, 0.9, 0.9, 0.9, 0.9], tiers6);
    ok('blockSpans：wake 很晚（0.9 s）时 wake 优先于错开（先满足 wake、结尾仍在总长内、按档单调不减）', w90.every((sp) => sp[0] >= 0.9 - 1e-9 && sp[1] <= 1.2 + 1e-9) && w90[2][0] >= w90[0][0] && w90[3][0] >= w90[2][0] && w90[4][0] >= w90[3][0]);
    const fast = TR.blockSpans('fast', [0.4, 0.4, 0.4, 0.4, 0.4, 0.4], tiers6);
    ok('blockSpans：快速版按同样规则（不早于 wake、结尾在 0.7 s 内）', fast.every((sp) => sp[0] >= 0.4 - 1e-9 && sp[1] <= 0.7 + 1e-9));
    const mixed = TR.blockSpans('full', [0, 0, 0.8, 0, 0, 0], tiers6);
    ok('blockSpans：只有个别块被推迟时，同档以前的块照计划（输入框、日期行、归来简仍在第一档），被推迟的块之后的档依次顺延 ≥ 40 ms', near(mixed[0][0], TR.blockSpan('full', 0)[0]) && near(mixed[5][0], TR.blockSpan('full', 0)[0]) && mixed[2][0] >= 0.8 - 1e-9 && mixed[3][0] - mixed[2][0] >= 0.04 - 1e-9 && mixed[4][0] - mixed[3][0] >= 0.04 - 1e-9);
    const day = TR.blockSpans('full', [0.39, 0.39, 0.39, 0.39, 0.39, 0.39], tiers6, TR.BLOCK_START_DAY);
    ok('blockSpans（昼）：窗让开（wake ≈ 0.39 s）之后第一档就在 0.40 s——纸面铺满与内容落上纸面之间的空纸时间 ≤ 80 ms', near(day[0][0], 0.4, 1e-9) && near(day[5][0], 0.4, 1e-9) && day[0][0] - 0.39 <= 0.08);
    // 左栏条目：窗（昼）让开之后才浮现，仍自下而上轻扫
    const rsc = (y: number, c: number) => TR.rowSpan('full', y, 1080, 0, c);
    ok('rowSpan：窗让开（coverWake = 0.42 s）之后才开始浮现、仍是下面的行更早；没有窗（coverWake = 0）与原来一样', rsc(1000, 0.42)[0] >= 0.42 - 1e-9 && rsc(1000, 0.42)[0] < rsc(100, 0.42)[0] && rsc(500, 0)[0] === TR.rowSpan('full', 500, 1080, 0)[0] && rsc(100, 0.42)[1] <= 1.2 + 1e-9);
  }
  {
    // 窗：裁切框露出的矩形与屏幕换算
    const arch = { x: 1208.5, y: 12, w: 699.5, h: 1056 };
    const k = 1.08;
    const boxW = 1920 / k;
    const sa = { x: arch.x / k, y: arch.y / k, w: arch.w / k, h: arch.h / k };
    const c0 = TR.archClip(0, boxW, 1000, sa);
    const c1 = TR.archClip(1, boxW, 1000, sa, 16 / k);
    const r0 = TR.archClipRect(c0, boxW, 1000);
    const r1 = TR.archClipRect(c1, boxW, 1000);
    ok('archClipRect：p=0 是整个 box，p=1 恰是拱窗（舞台单位）', near(r0.x, 0) && near(r0.w, boxW) && near(r0.h, 1000) && near(r1.x, sa.x, 1e-9) && near(r1.y, sa.y, 1e-9) && near(r1.w, sa.w, 1e-9) && near(r1.h, sa.h, 1e-9));
    const sc = TR.stageToScreen(r1, 1, [1060, 640], k);
    ok('stageToScreen：镜头没推近（z = 1）时就是乘 k，p=1 的窗恰是屏幕上的拱窗', near(sc.x, arch.x, 1e-6) && near(sc.y, arch.y, 1e-6) && near(sc.w, arch.w, 1e-6) && near(sc.h, arch.h, 1e-6));
    const sz = TR.stageToScreen({ x: 1060, y: 640, w: 100, h: 100 }, 1.1, [1060, 640], k);
    ok('stageToScreen：镜头推近（z > 1）以 A 为不动点放大', near(sz.x, 1060 * k, 1e-9) && near(sz.y, 640 * k, 1e-9) && near(sz.w, 110 * k, 1e-9));
    // 光环 / 贴着立绘的东西：按终态位置摆好再套 decoXf，p=1 恒等、p<1 与立绘同步
    const H = 1080;
    const ah = H - 24;
    const fig = { x: 1920 - 12 - 0.6624 * ah - 0.4268 * ah, y: 12 - 0.0849 * ah, w: 1.0531 * ah, h: (1.0531 * ah * 1600) / 1181 };
    const fit = TR.artFit(k, fig);
    const O = [TR.ART_STAGE.x, TR.ART_STAGE.y];
    const T = (p: number, X: number[]) => { const s = Math.pow(fit.r, p); return [O[0] + (fit.dx / k) * p + s * (X[0] - O[0]), O[1] + (fit.dy / k) * p + s * (X[1] - O[1])]; };
    const m1 = TR.decoXf(1, fit, k);
    ok('decoXf：p=1 恒等（光环落定时恰在拱窗里它该在的位置，换手看不出来）', near(m1.a, 1, 1e-12) && near(m1.x, 0, 1e-9) && near(m1.y, 0, 1e-9));
    const X = [1000, 330];                                  // 原画里贴着人物头部的一点
    const Y = T(1, X);                                      // 它在窗里（终态）的位置
    const same = [0, 0.2, 0.5, 0.8, 1].every((p) => { const m = TR.decoXf(p, fit, k); const got = [m.a * Y[0] + m.x, m.a * Y[1] + m.y]; const want = T(p, X); return near(got[0], want[0], 1e-6) && near(got[1], want[1], 1e-6); });
    ok('decoXf：贴着人物的东西在 p<1 时与立绘同步（光环始终在她的头后面，不钉在终点位置先亮在右边）', same);
    ok('decoXf：p<1 时光环比终态小（随立绘从全身收成近景一起放大）', TR.decoXf(0.3, fit, k).a < 1 && TR.decoXf(0, fit, k).a < TR.decoXf(0.5, fit, k).a);
  }
  {
    // 夜 · 被打断时的取景对齐：以她的脸为不动点、尺寸与首页壁纸一致，右 / 下缘盖住屏幕
    const W = 1920; const H = 1080; const imgW = 1920; const imgH = 1080; const face = 0.57; const txTo = TR.wallpaperTx(W, H, 0.65, face);
    const f0 = TR.plateFit({ W, H, imgW, imgH, z: 1, u0: 0, v0: 0, txTo, face });
    ok('plateFit：镜头已到位（z = 1）时只是向右平移（首页取景，153.6 px），尺寸不变', near(f0.s, 1, 1e-9) && near(f0.x, txTo, 1e-6) && near(f0.y, 0, 1e-6));
    // 用夜景相机的真实公式（nightScene.nightCam）取 z / u0 / v0：t = 0…5.6 s、几种窗口比例
    const cam = (Wc: number, Hc: number, t: number) => {
      const imgWc = Math.max(Wc, 1.7778 * Hc); const imgHc = imgWc / 1.7778;
      const txc = Math.min(160, Math.max(Wc - imgWc, 0.57 * (Wc - imgWc)));
      const e = E.camera(win(t, 0, 5.6)); const z = 1 + 0.12 * (1 - e);
      const wu1 = Wc / imgWc; const wv1 = Hc / imgHc; const u0f = -txc / imgWc;
      const cu = u0f + wu1 / 2 - 0.04 * (1 - e); const cv = wv1 / 2 + 0.02 * (1 - e);
      const wu = wu1 / z; const wv = wv1 / z;
      return { z, imgW: imgWc, imgH: imgHc, u0: Math.min(Math.max(0, 1 - wu), Math.max(0, cu - wu / 2)), v0: Math.min(Math.max(0, 1 - wv), Math.max(0, cv - wv / 2)) };
    };
    let allOk = true; let detail = ''; let worstS = 1;
    for (const [Wc, Hc] of [[1920, 1080], [1728, 1080], [1440, 900], [1280, 720], [2268, 1080]] as const) for (const t of [0, 0.5, 1, 2, 3, 4, 5, 5.6]) {
      const c = cam(Wc, Hc, t);
      const txc = TR.wallpaperTx(Wc, Hc, 0.65, face);
      const f = TR.plateFit({ W: Wc, H: Hc, imgW: c.imgW, imgH: c.imgH, z: c.z, u0: c.u0, v0: c.v0, txTo: txc, face });
      const px = (-c.u0 + face) * c.z * c.imgW;
      const py = (-c.v0 + TR.FACE_V) * c.z * c.imgH;
      const wx = txc + face * c.imgW;
      const wy = TR.FACE_V * c.imgH;
      const faceOk = near(f.x + f.s * px, wx, 1e-6) && near(f.y + f.s * py, wy, 1e-6);
      const cover = f.x + f.s * Wc >= Wc - 1e-6 && f.y + f.s * Hc >= Hc - 1e-6;
      const scaleOk = f.s >= 1 / c.z - 1e-9 && f.s <= (1.08 / c.z) + 1e-9;
      worstS = Math.max(worstS, f.s * c.z);
      if (!(faceOk && cover && scaleOk)) { allOk = false; detail += ` ${Wc}×${Hc} t=${t}: face ${faceOk} cover ${cover} scale ${scaleOk};`; }
    }
    ok('plateFit：镜头还在推近（t = 0–5.6 s，5 种窗口比例）时她的脸恰落在首页壁纸里脸的位置、位图的右 / 下缘盖住屏幕、尺寸与首页壁纸的差不超过 8%（溶解时没有脸的双影）', allOk, detail + ` 最大放大偏差 ${((worstS - 1) * 100).toFixed(1)}%`);
  }
  {
    // 被打断时标题只浮现了一部分：reveal 的状态可读出来，带着走的收完、不带的从它淡出（不从 0 / 1 起跳）
    const node = (op: string, tf: string, fl: string) => ({ style: { opacity: op, transform: tf, filter: fl } }) as unknown as HTMLElement;
    const b = revealBase(node('0.300', 'translateY(5.60px)', 'blur(4.20px)'));
    ok('revealBase：读出 reveal 播到一半的不透明度 / 上浮 / 模糊', near(b.op, 0.3) && near(b.y, 5.6) && near(b.blur, 4.2));
    const e = revealBase(node('', '', ''));
    ok('revealBase：没写过样式（还没浮现）是 0，不是 1', e.op === 0 && e.y === 0 && e.blur === 0);
    const done = revealBase(node('1.000', 'none', 'none'));
    ok('revealBase：播完的是 1 / 0 / 0', done.op === 1 && done.y === 0 && done.blur === 0);
    const n1 = node('0.600', 'translateY(3.20px)', 'blur(2.40px)');
    const b1 = revealBase(n1);
    settleReveal(n1, b1, 0, true);
    ok('settleReveal：k=0 保持原样（转场起点不跳）', near(parseFloat(n1.style.opacity), 0.6) && n1.style.transform === 'translateY(3.20px)' && n1.style.filter === 'blur(2.40px)');
    settleReveal(n1, b1, 1, true);
    ok('settleReveal：k=1 收完（不透明、不上浮、不模糊）', n1.style.opacity === '1.000' && n1.style.transform === 'none' && n1.style.filter === 'none');
    const n2 = node('1.000', 'none', 'none');
    settleReveal(n2, revealBase(n2), 0.5, true);
    ok('settleReveal：已经播完的不写样式（定格后离开的完整版逐像素不变）', n2.style.opacity === '1.000' && n2.style.transform === 'none' && n2.style.filter === 'none');
  }
  ok('bfBox：蝶的方框以翼展 × 1.15 为边、中心在蝶身上', (() => { const b = TR.bfBox({ x: 100, y: 200, w: 60, rot: 0, flap: 1, alpha: 1 }); return near(b.w, 69) && near(b.x + b.w / 2, 100) && near(b.y + b.h / 2, 200); })());
}

// ── 评审 R4 修订：标题组、色彩收敛、光尘拖尾、夜的快速版取景、开屏的轨迹 / 涟漪 / 绽开 ──
{
  // 标题组：「栖枝」+「ALIGHT」作为一个整体缩进字标
  const g = { h1Box: { x: 137, y: 335, w: 500, h: 137 }, h1Src: { x: 140, y: 350, w: 280, h: 190 }, h1Dst: { x: 62, y: 18.5, w: 43, h: 27 }, enSrc: { x: 215, y: 545, w: 260, h: 36 }, enDst: { x: 62, y: 41.5, w: 62, h: 14 } };
  const a0 = TR.titleGroupAt(g, 0);
  const a1 = TR.titleGroupAt(g, 1);
  ok('titleGroupAt：p=0 时两行恰在开屏的位置，p=1 时恰是字标的位置与高度', near(a0.h1Rect.x, g.h1Src.x) && near(a0.enRect.x, g.enSrc.x) && near(a0.enRect.y, g.enSrc.y) && near(a0.enRect.h, g.enSrc.h) && near(a0.enRect.w, g.enSrc.w) && near(a1.h1Rect.x, 62, 1e-9) && near(a1.enRect.x, 62, 1e-9) && near(a1.enRect.y, 41.5, 1e-9) && near(a1.enRect.h, 14, 1e-9));
  let worst = 0;
  let worstH = 0;
  for (let i = Math.ceil(TR.SUB_ALIGN * 100); i <= 100; i++) {
    const a = TR.titleGroupAt(g, i / 100);
    const sc = a.h1Rect.h / g.h1Dst.h;                                            // 组此刻相对终态的倍数
    worst = Math.max(worst, Math.hypot((a.enRect.x - a.h1Rect.x) / sc - (g.enDst.x - g.h1Dst.x), (a.enRect.y - a.h1Rect.y) / sc - (g.enDst.y - g.h1Dst.y)));
    worstH = Math.max(worstH, Math.abs(a.enRect.h - g.enSrc.h * Math.pow(g.enDst.h / g.enSrc.h, i / 100)));
  }
  ok('titleGroupAt：进度过 35% 之后「ALIGHT」相对「栖枝」左上角的偏移 / 行距随组整体缩放（刚体：换算回终态后与终态的差 < 0.01 px）——不再各滑各的；字高按整段行程几何插值', worst < 0.01 && worstH < 1e-9, `${worst} / ${worstH}`);
  {
    // 前 35% 里 ALIGHT 左缘的缩进（开屏里它居中、带线）单调收成零（组的缩放换算回终态像素）
    const offs = Array.from({ length: 36 }, (_, i) => { const a = TR.titleGroupAt(g, i / 100); return ((a.enRect.x - a.h1Rect.x) / (a.h1Rect.h / g.h1Dst.h)) - (g.enDst.x - g.h1Dst.x); });
    ok('titleGroupAt：前 35% 的行程里 ALIGHT 相对「栖枝」的左缘缩进单调收成零（居中 → 左对齐）', offs.every((v, i) => i === 0 || Math.abs(v) <= Math.abs(offs[i - 1]) + 1e-9) && Math.abs(offs[0]) > 5 && Math.abs(offs[35]) < 1e-6, `${offs[0].toFixed(1)} → ${offs[35].toFixed(3)}`);
  }
  {
    // 对照：各自 FLIP（旧做法）中途两行的相对位置与刚体的差 ≥ 3 px——证明这个测试分辨得出「各滑各的」
    const fh = TR.flipTo(g.h1Box, g.h1Src, g.h1Dst);
    const enBox = { x: 200, y: 540, w: 300, h: 40 };
    const fe = TR.flipTo(enBox, g.enSrc, g.enDst);
    const p = 0.5;
    const h1 = TR.flipRectAt(g.h1Box, g.h1Src, TR.flipAt(fh, p));
    const en = TR.flipRectAt(enBox, g.enSrc, TR.flipAt(fe, p));
    const grp = TR.titleGroupAt(g, p);
    const off = Math.hypot((en.x - h1.x) / (h1.h / g.h1Dst.h) - (grp.enRect.x - grp.h1Rect.x) / (grp.h1Rect.h / g.h1Dst.h), (en.y - h1.y) / (h1.h / g.h1Dst.h) - (grp.enRect.y - grp.h1Rect.y) / (grp.h1Rect.h / g.h1Dst.h));
    ok('titleGroupAt：对照——各自 FLIP 时中途 ALIGHT 相对「栖枝」的偏移（换算回终态像素）与刚体差 ≥ 3 px', off >= 3, off.toFixed(2));
  }
  // 色彩收敛
  {
    const g0 = TR.tintGradient([10, 20, 30], 0);
    const g1 = TR.tintGradient([10, 20, 30], 1);
    ok('tintGradient：k=0 是开屏「栖枝」的四个色标（#faf8fc → #9a74ad）、k=1 四个色标都是字标的颜色（纯色）', g0.includes('rgb(250 248 252) 0%') && g0.includes('rgb(154 116 173) 100%') && (g1.match(/rgb\(10 20 30\)/g) ?? []).length === 4);
    const w0 = TR.tintGlow(0);
    const w5 = TR.tintGlow(0.5);
    ok('tintGlow：k=0 是开屏的三层 drop-shadow（α .85 / .80 / .40）、k=0.5 α 减半、k=1 没有发光（none）', (w0.match(/drop-shadow/g) ?? []).length === 3 && w0.includes('0.850') && w0.includes('0.800') && w0.includes('0.400') && w5.includes('0.425') && TR.tintGlow(1) === 'none');
    ok('parseRgb / mixRgb：rgb() / rgba() 取三个通道、混色取整', JSON.stringify(TR.parseRgb('rgb(42, 27, 64)')) === '[42,27,64]' && JSON.stringify(TR.parseRgb('rgba(1, 2, 3, 0.5)')) === '[1,2,3]' && TR.mixRgb([0, 0, 0], [100, 200, 50], 0.5) === 'rgb(50 100 25)');
    const S = TR.nightSegs('full');
    ok('tint 段：0.30–0.70 s 走完，在字标（真身）开始淡入的 0.70 s 时 = 1（分身与真身像素一致，交叉淡化只是走个形式）', S.tint[0] === 0.3 && S.tint[1] === 0.7 && S.tint[1] <= S.titleSwap[0] + 1e-9 && TR.trState('night', 'full', 0.7).tint === 1 && TR.trState('night', 'full', 0.3).tint === 0 && TR.trState('day', 'full', 0.7).tint === 1);
  }
  // 光尘拖尾
  {
    const path = TR.flightPath([450, 880], [35, 37]);
    const fly = [0, 0.8] as const;
    const pos = (te: number) => bez(path, Math.min(1, TR.FLY_E(win(te, fly[0], fly[1]))));
    let maxN = 0; let farthest = 0; let rMin = 9; let rMax = 0; let aMax = 0;
    const gaps: Array<[number, number]> = [];
    for (let tr = 0.05; tr <= 0.8; tr += 0.01) {
      const ds = TR.dustDots(path, fly, tr, 7100);
      maxN = Math.max(maxN, ds.length);
      for (const d of ds) {
        let best = 1e9;
        for (let te = Math.max(0, tr - TR.DUST_LIFE - 0.003); te <= tr + 0.003; te += 0.0005) { const q = pos(te); best = Math.min(best, Math.hypot(q[0] - d.x, q[1] - d.y)); }
        farthest = Math.max(farthest, best);
        rMin = Math.min(rMin, d.r); rMax = Math.max(rMax, d.r); aMax = Math.max(aMax, d.a);
      }
      if (ds.length >= 2) { let sum = 0; for (let i = 1; i < ds.length; i++) sum += Math.hypot(ds[i].x - ds[i - 1].x, ds[i].y - ds[i - 1].y); gaps.push([tr, sum / (ds.length - 1)]); }
    }
    ok('dustDots：同时最多 8 粒（只有 60% 放出）、每一粒都落在蝶「此刻之前 100 ms 内」走过的路径上（寿命 ≤ 100 ms；沿路径法向抖 ≤ 6 px、切向另有 ≤ 3 px 的细抖）', maxN <= 8 && farthest <= TR.DUST_NORMAL + 4.3 + 1e-6, `${maxN} 粒、最远 ${farthest.toFixed(2)} px`);
    ok('dustDots：尺寸 / 亮度各随机在 ±30% 之内（0.7–1.3，且确有起伏）', rMin >= 0.7 - 1e-9 && rMax <= 1.3 + 1e-9 && rMax - rMin >= 0.3 && aMax > 0.5, `${rMin.toFixed(2)}–${rMax.toFixed(2)}`);
    const fast = gaps.reduce((m, [, g]) => Math.max(m, g), 0);
    const tail = gaps.filter(([t]) => t > 0.7).map(([, g]) => g);
    ok('dustDots：点距随速度拉开——飞得最快时的平均点距 ≥ 收尾减速时的 3 倍（不是一串等距的圆点）', tail.length > 0 && fast >= 3 * Math.max(...tail), `最快 ${fast.toFixed(1)} px / 收尾 ${Math.max(...tail).toFixed(1)} px`);
    // 标题周围不画
    const mid = pos(0.4);
    const box = { x: mid[0] - 40, y: mid[1] - 40, w: 80, h: 80 };
    const ds2 = TR.dustDots(path, fly, 0.4, 7100, [box]);
    const ds0 = TR.dustDots(path, fly, 0.4, 7100);
    ok('dustDots：标题的矩形周围 16 px 内的点不画（淡到 0）；没有障碍物时同一时刻确有点', ds0.length > 2 && ds2.every((d) => d.a < 0.004 || Math.hypot(Math.max(box.x - d.x, 0, d.x - box.x - box.w), Math.max(box.y - d.y, 0, d.y - box.y - box.h)) >= 1) && ds2.length < ds0.length);
    ok('dustDots：纯函数（同一个 tr 同一批点）', JSON.stringify(TR.dustDots(path, fly, 0.37, 7100)) === JSON.stringify(TR.dustDots(path, fly, 0.37, 7100)));
    {
      // R5：每次放出机会只有 60% 真放出（不再排成一条竖直虚线）、位置沿路径法向左右抖（±6 px）：统计放出率与法向偏移的分布
      let on = 0; let all = 0; let nMax = 0; let nMin = 0;
      for (let j = 0; j < 4000; j++) {
        const rr = mulberry32(7100 + j * 131);
        rr(); rr(); rr(); rr(); rr();
        const keep = rr() < TR.DUST_P;
        all++; if (keep) on++;
        const jn = (rr() * 2 - 1) * TR.DUST_NORMAL;
        nMax = Math.max(nMax, jn); nMin = Math.min(nMin, jn);
      }
      ok('dustDots：放出率 60%（± 3%），法向抖动两侧都有、幅度 ≤ 6 px', Math.abs(on / all - TR.DUST_P) < 0.03 && nMax > 5 && nMin < -5 && nMax <= TR.DUST_NORMAL + 1e-9 && TR.DUST_P === 0.6 && TR.DUST_NORMAL === 6, `${(on / all).toFixed(3)} ${nMin.toFixed(2)}…${nMax.toFixed(2)}`);
      // 竖直上升的路径：点的横向偏移（= 法向）两侧都有，不在一条竖线上
      const vpath = [[100, 600], [100, 450], [100, 300], [100, 100]] as const;
      const xs: number[] = [];
      for (let tr = 0.1; tr <= 0.7; tr += 0.005) for (const d of TR.dustDots(vpath, fly, tr, 7100)) xs.push(d.x - 100);
      ok('dustDots：竖直上升时点的横向偏移两侧都有（不再是一条竖直虚线）：最小 < −3 px、最大 > 3 px，且不超出 ±9.5 px', Math.min(...xs) < -3 && Math.max(...xs) > 3 && Math.min(...xs) >= -9.5 && Math.max(...xs) <= 9.5, `${Math.min(...xs).toFixed(1)}…${Math.max(...xs).toFixed(1)}`);
    }
  }
  // 夜的快速版：取景平移铺满 0.05–0.42 s，溶解 0.25–0.55 s
  {
    const N = TR.nightSegs('full');
    const NF = TR.nightSegs('fast');
    const peak = (f: (t: number) => number, d: number) => { let m = 0; for (let i = 0; i < 1000; i++) m = Math.max(m, (f((i + 1) / 1000) - f(i / 1000)) * 1000 / d); return m; };
    ok('夜 · 快速版：取景平移与左栏推入是同一段（0.05–0.42 s）、同一条曲线；溶解 0.10–0.62 s（R5：首页壁纸层与位图一起收到位，不必等平移铺开；≥ 30 帧里摊开亮度差）；整体仍在 0.7 s 内', NF.pan[0] === 0.05 && NF.pan[1] === 0.42 && NF.nav[0] === NF.pan[0] && NF.nav[1] === NF.pan[1] && NF.dissolve[0] === 0.1 && NF.dissolve[1] === 0.62 && (NF.dissolve[1] - NF.dissolve[0]) * 60 >= 30 && NF.dissolve[1] <= 0.7);
    // 旧：0.1–0.54 按 7/12 缩成 0.058–0.315（0.257 s）；新 0.37 s——取景位图的仿射峰值速度降到旧的 0.75 以下
    ok('夜 · 快速版：定格位图仿射到首页取景的峰值速度 ≤ 旧（0.257 s）的 0.75 倍（评审 R4：旧的 0.18 s 内走完约 100 px，像镜头甩了一下）', peak(TR.PAN_E, NF.pan[1] - NF.pan[0]) <= peak(TR.PAN_E, (N.pan[1] - N.pan[0]) * (7 / 12)) * 0.75, `${(peak(TR.PAN_E, NF.pan[1] - NF.pan[0]) / peak(TR.PAN_E, (N.pan[1] - N.pan[0]) * (7 / 12))).toFixed(2)}×`);
    ok('夜 · 快速版：左栏字标在面板到位后（0.42 s）原地淡入 ≤ 0.1 s（没被场景接管的字标 / 品牌标不骑着面板进来）；标题淡出仍在字标不透明之后', NF.titleSwap[0] >= NF.nav[1] - 1e-9 && NF.titleSwap[1] - NF.titleSwap[0] <= 0.1 + 1e-9 && NF.titleOut[0] >= NF.titleSwap[1] - 1e-9 && NF.titleOut[1] <= 0.7);
  }
  // 夜开屏：定格时轨迹只留 7 粒、几何级数；涟漪不套在蝶身上
  {
    const dists = Array.from({ length: NIGHT.REST_TAIL.n }, (_, k) => NIGHT.restTailDist(k));
    ok('夜 · 定格的轨迹只留 7 粒：离落点的路程按 1.34 的几何级数拉开（72 → 417 px），最近一粒离蝶中心 ≥ 70 px、与第二粒隔 ≥ 24 px（不再「••」并排贴在翅尖）；法向抖动 6–10 px', NIGHT.REST_TAIL.n === 7 && dists.every((d, i) => i === 0 || near(d / dists[i - 1], 1.34, 1e-9)) && dists[0] >= 70 && dists[1] - dists[0] >= 24 && dists[6] < 420 && NIGHT.REST_TAIL.jitter[0] >= 6 && NIGHT.REST_TAIL.jitter[1] <= 10, dists.map((d) => d.toFixed(0)).join(' '));
    const qs = dists.map(NIGHT.pathQAtDistFromEnd);
    ok('夜 · 7 粒对应的路径进度严格递减、都在 (0, 1) 内（离落点越远进度越小），且离落点的弧长与目标一致', qs.every((q, i) => q > 0 && q < 1 && (i === 0 || q < qs[i - 1])) && qs.every((q, i) => { const a = pathAt(NIGHT.NP.pathA, q).p; const b = pathAt(NIGHT.NP.pathA, 0.9999).p; return Math.abs(Math.hypot((a[0] - b[0]) * 1920, (a[1] - b[1]) * 1080) - dists[i]) < dists[i] * 0.12; }), qs.map((q) => q.toFixed(3)).join(' '));
    const R = NIGHT.RIPPLE;
    ok('夜 · 涟漪落在枝下的水面上：中心比蝶低 82 px，两圈的上缘（放大到 1.18 倍）都在蝶的方框下缘（43 px）之下；α ≤ 0.12（极淡）', R.rings.every(([, ry]) => R.cy - ry * R.sclMax > NIGHT.REST_BF_HALF_H) && R.alpha.every((a) => a <= 0.12 + 1e-9), `外圈上缘 ${(R.cy - R.rings[1][1] * R.sclMax).toFixed(1)} px`);
  }
  // 昼开屏：绽开前快后慢、不是一个圆
  {
    const r = DAY.bloomRadius;
    const v = (t: number) => (r(t + 0.005) - r(t - 0.005)) / 0.01;
    ok('昼 · 绽开半径前快后慢：0.25 s 内到 280–340 px、2.7 s 铺满（1500）、全程单调、速度单调递减', r(0.25) >= 280 && r(0.25) <= 340 && near(r(2.7), 1500, 1e-6) && Array.from({ length: 271 }, (_, i) => r(i / 100)).every((x, i, a) => i === 0 || x >= a[i - 1]) && v(0.25) > v(1) && v(1) > v(2), `${r(0.25).toFixed(0)} px，速度 ${v(0.25).toFixed(0)} / ${v(1).toFixed(0)} / ${v(2).toFixed(0)} px/s`);
    ok('昼 · 绽开从 0 s 就开始（第一帧雾里已经有点）；半径函数到 2.7 s 恰是 1500（撤掉蒙版时不跳）', DAY.DT.bloom[0] === 0 && DAY.DT.bloom[1] === 2.7 && r(0) === DAY.DC.R0 && r(0) < 100);
    const ang = DAY.BLOOM_PETALS.map((p) => ((p[0] % 360) + 360) % 360).sort((a, b) => a - b);
    const gap = ang.map((a, i) => (i === 0 ? ang[0] + 360 - ang[ang.length - 1] : a - ang[i - 1]));
    ok('昼 · 主圆边缘 6 片花瓣：角度间隔不均（最大间隔比最小间隔大 ≥ 20°）、大小（0.38–0.46）与迟早（0.02–0.14 s）各不同——并集的轮廓是不规则的瓣形，不是一个正圆', DAY.BLOOM_PETALS.length === 6 && Math.max(...gap) - Math.min(...gap) >= 20 && new Set(DAY.BLOOM_PETALS.map((p) => p[2])).size >= 5 && new Set(DAY.BLOOM_PETALS.map((p) => p[3])).size >= 5 && DAY.BLOOM_PETALS.every((p) => p[2] >= 0.38 && p[2] <= 0.46 && p[3] >= 0.02 && p[3] <= 0.14), gap.map((x) => x.toFixed(0)).join(' '));
    const dl = DAY.BLOOM_CENTERS.map((c) => c[2]);
    ok('昼 · 三个中心（花束、脚边白花、左下远处的花海）各自错开点开（花束 0 s 最先、脚边白花 0.2 s、花海 0.22 s，互不相同），左下的花海横着铺开（竖 / 横比下限 ≤ 0.4）；花束（浅色）最先、深色草地的主圆晚 BLOOM_MAIN_DELAY 才淡入、脚边白花（暗紫碎晶那里）晚于主圆', DAY.BLOOM_CENTERS.length === 3 && new Set(dl).size === 3 && dl[0] === 0 && Math.min(...dl) >= 0 && Math.max(...dl) <= 0.22 && dl[1] >= DAY.BLOOM_MAIN_DELAY + 0.05 && DAY.BLOOM_MAIN_DELAY >= 0.1 && DAY.BLOOM_CENTERS[2][4] <= 0.4 && DAY.BLOOM_CENTERS[2][0] < 400 && DAY.BLOOM_CENTERS[2][1] > 800);
  }
}

// ── 评审 R5 修订：夜的溶解重影与亮度台阶、昼的窗左缘、枝从落脚点生长、昼开屏的节奏与起手、左栏条目 / 内容块的浮现 ──
{
  // 枝：从蝶的落脚点往两头长（不再是从枝根起笔的一道悬着的短横）
  const F = TR.TWIG_FOOT;
  ok('枝的落脚点：主枝上离蝶身下端（27.8, 26.1）最近的一点，在主枝的中后段（弧长进度 0.5–0.9），离蝶身下端 ≤ 4 个单位', F.s > 0.5 && F.s < 0.9 && Math.hypot(F.pt[0] - TR.BRAND_BODY_FOOT[0], F.pt[1] - TR.BRAND_BODY_FOOT[1]) <= 4, `${F.s.toFixed(3)} (${F.pt[0].toFixed(1)}, ${F.pt[1].toFixed(1)})`);
  const spans = Array.from({ length: 101 }, (_, i) => TR.twigSpan(i / 100));
  ok('twigSpan：grow = 0 是落脚点上的一个点、grow = 1 是整根枝 [0, 1]；区间随 grow 单调向两头延伸、始终含落脚点（每一笔都连着蝶）', near(spans[0][0], F.s) && near(spans[0][1], F.s) && near(spans[100][0], 0) && near(spans[100][1], 1) && spans.every((sp, i) => sp[0] <= F.s + 1e-9 && sp[1] >= F.s - 1e-9 && (i === 0 || (sp[0] <= spans[i - 1][0] + 1e-12 && sp[1] >= spans[i - 1][1] - 1e-12))));
  ok('TWIG_SUBS：三根小杈，主枝要长到 need（0–0.8）才盖住它们的附着点；twigSubAlpha 在 need 之前为 0、单调、grow = 1 时为 1（从不悬在一边）',
    TR.TWIG_SUBS.length === 3 && TR.TWIG_SUBS.every((t) => t.need > 0 && t.need <= 0.8 && TR.twigSubAlpha(Math.max(0, t.need - 0.01), t.need) === 0 && TR.twigSubAlpha(1, t.need) === 1 && Array.from({ length: 101 }, (_, i) => TR.twigSubAlpha(i / 100, t.need)).every((v, i, a) => i === 0 || v >= a[i - 1])), TR.TWIG_SUBS.map((t) => t.need.toFixed(2)).join(' '));
  ok('twigGrow(flyRaw, open)：不早于 open 与 72.5%（取晚者）、落定（100%）时恰好长满、单调', TR.twigGrow(0.9, 0.95) === 0 && TR.twigGrow(0.9, 0) > 0 && TR.twigGrow(1, 0.95) === 1 && Array.from({ length: 101 }, (_, i) => TR.twigGrow(i / 100, 0.8)).every((v, i, a) => i === 0 || v >= a[i - 1]));
  ok('twigFootDepth / twigGate：落脚点在蝶的方框外 = 0（枝不可见）、进入框内 4 px 才完全可见；框内每一点深度 > 0', TR.twigGate(-3) === 0 && TR.twigGate(0) === 0 && TR.twigGate(4) === 1 && near(TR.twigFootDepth([50, 50], { x: 40, y: 40, w: 20, h: 20 }), 10) && TR.twigFootDepth([70, 50], { x: 40, y: 40, w: 20, h: 20 }) < 0);
  {
    // 在真实的飞行上核对「每一帧的枝都接触蝶」：枝的不透明度（alpha × gate）> 0.02 的每一帧，落脚点都在蝶的方框里；落定后枝是满的
    const mark = { x: 16, y: 18, w: 38, h: 38 };
    const goal = TR.brandGoal(mark);
    for (const [name, a, kind] of [['夜 · 完整版', [450, 880], 'full'], ['夜 · 快速版', [450, 880], 'fast'], ['昼 · 完整版（枝梢）', [393, 214], 'full']] as const) {
      const path = TR.flightPath(a, [goal.x, goal.y]);
      const start = { x: a[0], y: a[1], w: 108, rot: (-14 * Math.PI) / 180, flap: 0.85, alpha: 1 };
      const foot = TR.twigFootScreen(mark);
      const open = TR.twigOpen(start, goal, path, foot);
      const dur = TR.trDuration(kind);
      let visible = 0; let detached = 0; let firstVisible = -1; let lastGrow = 0; let maxA = 0;
      for (let i = 0; i <= Math.round(dur * 120); i++) {
        const tr = i / 120;
        const st = TR.trState('night', kind, tr);
        const pose = TR.bfFlight(start, goal, path, st.fly, st.flap, tr);
        const box = TR.bfBox(pose);
        const grow = TR.twigGrow(st.flyRaw, open);
        const alpha = TR.twigAlpha(grow) * TR.twigGate(TR.twigFootDepth(foot, box));
        lastGrow = grow; maxA = Math.max(maxA, alpha);
        if (alpha > 0.02) { visible++; if (firstVisible < 0) firstVisible = tr; if (TR.twigFootDepth(foot, box) <= 0) detached++; }
      }
      ok(`枝（${name}）：枝可见的每一帧落脚点都在蝶的方框里（没有一帧悬着）；起长不早于蝶飞过 72.5%、落定时长满且完全不透明`, open >= TR.TWIG_FROM - 1e-9 && open < 1 && visible > 5 && detached === 0 && lastGrow === 1 && maxA > 0.9 && firstVisible >= TR.nightSegs(kind).fly[1] * 0.725 - 1e-9, `open ${open.toFixed(3)} 首次可见 ${firstVisible.toFixed(3)} s、可见 ${visible} 帧 / 悬着 ${detached}`);
    }
  }

  // 夜：溶解的亮度差摊开 + 首页壁纸与位图一起收到位
  {
    ok('lightRatio：开屏越早被打断越暗（从 3.3× 降到 5 s 时的 1.0×）、之后随暗纱回升；表里的数在端点处取值、中间线性插值', TR.lightRatio(0) === 3.3 && TR.lightRatio(1) === 1.71 && TR.lightRatio(5) === 1.02 && TR.lightRatio(99) === 1.24 && near(TR.lightRatio(0.25), (3.3 + 2.24) / 2, 1e-9) && [0, 0.5, 1, 1.5, 2, 3, 4, 5].every((t, i, a) => i === 0 || TR.lightRatio(t) <= TR.lightRatio(a[i - 1]) + 1e-9));
    ok('dissolveFast：端点 0 / 1、单调；亮度（1 + α·(R − 1)）按等比推进——逐帧（1/60 s）相对变化的最大值 / 最小值 ≤ 1.02（线性溶解在起点相对变化最大）',
      [1.3, 1.7, 3.3].every((R) => { const a = Array.from({ length: 32 }, (_, i) => TR.dissolveFast(i / 31, R)); const M = a.map((x) => 1 + x * (R - 1)); const rate = M.slice(1).map((m, i) => m / M[i]); return a[0] === 0 && near(a[31], 1, 1e-12) && a.every((x, i) => i === 0 || x >= a[i - 1]) && Math.max(...rate) / Math.min(...rate) <= 1.02; }));
    ok('夜 · 打断时的亮度台阶：从 1 / 2 / 3 / 4 s 被打断，溶解段（0.10–0.62 s，31 帧）里平均亮度逐帧的相对变化 ≤ 3%（模型值；实测 ≤ 2.6%）；完整版沿用 E.ease',
      [1, 2, 3, 4].every((from) => { const R = TR.lightRatio(from); const M = Array.from({ length: 32 }, (_, i) => 1 + TR.dissolveFast(i / 31, R) * (R - 1)); return Math.max(...M.slice(1).map((m, i) => m / M[i] - 1)) <= 0.03; })
      && TR.dissolveAlpha('full', TR.trState('night', 'full', 0.6), 7.5) === TR.trState('night', 'full', 0.6).dissolve && near(TR.dissolveAlpha('fast', { dissolve: 0, dissolveP: 1 }, 3), 1) && TR.dissolveAlpha('fast', { dissolve: 0, dissolveP: 0 }, 3) === 0);
    // 首页壁纸层的剩余变换：与位图逐点重合
    const aff = { s: 0.92, x: -37, y: 24 };
    let congruent = true; let identity = true;
    for (const pan of [0, 0.2, 0.5, 0.8, 1]) {
      const sc = 1 + (aff.s - 1) * pan; const lx = aff.x * pan; const ly = aff.y * pan;       // 位图此刻的 CSS 变换 translate(lx, ly) scale(sc)
      const r = TR.plateResidual(aff, pan);
      for (const Ps of [[100, 200], [1500, 400], [0, 1080]]) {
        const Pb = [(Ps[0] - aff.x) / aff.s, (Ps[1] - aff.y) / aff.s];                       // 终态屏幕位置 Ps 对应的位图点 = aff⁻¹(Ps)
        const plate = [lx + sc * Pb[0], ly + sc * Pb[1]];                                       // 位图此刻把它画在哪
        const wall = [r.x + r.k * Ps[0], r.y + r.k * Ps[1]];                                    // 壁纸层套剩余变换后把它画在哪
        if (Math.hypot(plate[0] - wall[0], plate[1] - wall[1]) > 1e-9) congruent = false;
      }
      if (pan === 1 && !(near(r.k, 1, 1e-12) && near(r.x, 0, 1e-9) && near(r.y, 0, 1e-9))) identity = false;
    }
    ok('plateResidual：首页壁纸层套 T(pan)·aff⁻¹ 之后与位图上的每一点逐点重合（任意 pan、任意点；溶解与平移怎么重叠都不会有脸的双影）；pan = 1 时是恒等（结束时撤掉样式没有一跳）', congruent && identity);
  }

  // 昼：窗的左缘、收尾、临时底、文字淡出
  {
    const D = TR.daySegs('full');
    ok('winEdgeAlpha：左缘速度 > 1500 px/s 时窗的左侧轮廓 α ≤ 0.2、< 400 px/s 时 1、之间单调平滑', DAY.winEdgeAlpha(2000) <= 0.2 + 1e-9 && DAY.winEdgeAlpha(1500) <= 0.2 + 1e-9 && DAY.winEdgeAlpha(300) === 1 && Array.from({ length: 41 }, (_, i) => DAY.winEdgeAlpha(1700 - i * 40)).every((v, i, a) => i === 0 || v >= a[i - 1] - 1e-12));
    {
      // 真实的窗：完整版窗的左缘速度高于 1500 px/s 的时刻（0.36 s 以前）轮廓 α = 0.2，0.5 s 之后补足
      const k = 1.08; const sa = { x: 1208.5 / k, y: 12 / k, w: 699.5 / k, h: 1056 / k };
      const left = (tr: number) => { const st = TR.trState('day', 'full', tr); return TR.archClip(st.art, 1920 / k, 1000, sa, 16 / k, st.winL).l * k; };
      const sp = (tr: number) => Math.abs(left(tr + 0.008) - left(tr - 0.008)) / 0.016;
      const slow = Array.from({ length: 121 }, (_, i) => i / 100).find((t) => t > D.win[0] + 0.05 && sp(t) < 1500);
      ok('昼 · 窗的左缘（完整版）：0.15–0.30 s 速度远高于 1500 px/s（轮廓只剩 α 0.2，由 140 px 的纸面软边领跑），降到 1500 px/s 以下的时刻在 0.33–0.45 s，0.56 s 以后轮廓补足（速度 < 400 px/s）',
        [0.15, 0.2, 0.25, 0.3].every((t) => sp(t) > 1500 && DAY.winEdgeAlpha(sp(t)) <= 0.2 + 1e-9) && slow !== undefined && slow >= 0.33 && slow <= 0.45 && DAY.winEdgeAlpha(sp(0.56)) === 1, `速度降到 1500 的时刻 ${slow?.toFixed(3)}、0.56 s 时 ${sp(0.56).toFixed(0)} px/s`);
    }
    ok('winSoft：窗的左缘高速时窗里内容的左缘羽化（速度 > 2500 px/s 时 90 个舞台单位、< 600 px/s 时 0——停稳后是干净的拱窗边）、之间单调平滑', DAY.winSoft(300) === 0 && DAY.winSoft(2600) === DAY.WIN_SOFT.max && DAY.winSoft(5400) === DAY.WIN_SOFT.max && Array.from({ length: 41 }, (_, i) => DAY.winSoft(500 + i * 60)).every((v, i, a) => i === 0 || v >= a[i - 1] - 1e-12));
    ok('昼 · 收尾（R5）：立绘 0.84 s 落定（不再比窗、纸、内容块晚 0.3 s 单独滑），与临时底的淡出（0.74–0.88 s）同时落定；分身交接 0.84–1.0 s 仍是「真身先到、分身后撤」', D.art[1] === 0.84 && D.art[1] <= D.wOut[1] && D.figIn[0] >= D.art[1] - 1e-9 && D.figIn[1] <= D.figOut[0] + 1e-9 && D.figOut[1] <= 1.0 + 1e-9 && D.creditIn[1] <= D.art[1] + 1e-9);
    {
      // 立绘的残余位移：0.70 s 时剩余 ≤ 4%（原来 0.12 的位移还差 51 px）、0.80 s 时 ≤ 1%
      const left = (t: number) => 1 - TR.trState('day', 'full', t).art;
      ok('昼 · 立绘的收尾尾巴：0.70 s 剩余 ≤ 4%、0.80 s 剩余 ≤ 1%、0.84 s 剩余 0', left(0.7) <= 0.04 && left(0.8) <= 0.01 && left(0.84) === 0, `${left(0.7).toFixed(3)} ${left(0.8).toFixed(3)}`);
    }
    ok('昼 · 题辞 / 横幅 / 提示（textOut）在 0.20 s 前淡完（纸面前缘到达 x = 200 之前）；快速版按比例', D.textOut[1] <= 0.2 + 1e-9 && TR.trState('day', 'full', 0.2).textOut === 1 && TR.daySegs('fast').textOut[1] <= 0.2 * (7 / 12) + 1e-9);
    ok('昼 · 窗里临时底在右上 1/3 提前淡起（washTop 比 wash 早 ≥ 0.1 s 起、早于 wash 结束），立绘放大时深色的巨瓣先挤进右上角的那一下被薰衣草雾盖住', D.washTop[0] <= D.wash[0] - 0.1 + 1e-9 && D.washTop[1] <= D.wash[1] && TR.trState('day', 'full', 0.3).washTop > TR.trState('day', 'full', 0.3).wash);
    ok('昼 · 第一档内容（输入框、日期行、归来简）：时长 0.28 s（后几档 0.42 s）、起段 ease-out 比标准的更陡；wake 之后 70 ms 内有效不透明度 ≥ 0.5',
      TR.BLOCK_DUR_FIRST_DAY === 0.28 && near(TR.blockSpan('full', 0, TR.BLOCK_START_DAY, TR.BLOCK_DUR_FIRST_DAY)[1] - TR.blockSpan('full', 0, TR.BLOCK_START_DAY, TR.BLOCK_DUR_FIRST_DAY)[0], 0.28, 1e-9) && near(TR.blockSpan('full', 1, TR.BLOCK_START_DAY, TR.BLOCK_DUR_FIRST_DAY)[1] - TR.blockSpan('full', 1, TR.BLOCK_START_DAY, TR.BLOCK_DUR_FIRST_DAY)[0], 0.42, 1e-9)
      && cubic(0.12, 0.85, 0.2, 1)(0.07 / 0.28) >= 0.5 && TR.BLOCK_EASE_FIRST === 'cubic-bezier(0.12, 0.85, 0.2, 1)');
    {
      const sp = TR.blockSpans('full', [0.4, 0.4, 0.4, 0.4, 0.4], [0, 1, 2, 0, 3], TR.BLOCK_START_DAY, TR.BLOCK_DUR_FIRST_DAY);
      ok('blockSpans（昼）：第一档的块 0.28 s、其余档 0.42 s，结尾都在 1.2 s 内；同档同时浮现', near(sp[0][1] - sp[0][0], 0.28, 1e-9) && near(sp[1][1] - sp[1][0], 0.42, 1e-9) && near(sp[3][1] - sp[3][0], 0.28, 1e-9) && sp[0][0] === sp[3][0] && sp.every((x) => x[1] <= 1.2 + 1e-9));
    }
  }

  // 昼开屏：节奏（1.0 s 以后任意连续 1 s 里至少有一个叙事事件）与起手
  {
    const ev = DAY.DAY_EVENTS;
    let worstGap = 0;
    for (let t = 1.0; t <= DAY.DT.fly[1] - 0.001; t += 0.01) { const alive = ev.some(([, a, b]) => a <= t && t < b); if (!alive) worstGap += 0.01; }
    let everyWindow = true;
    for (let t0 = 1.0; t0 + 1 <= DAY.DT.fly[1]; t0 += 0.05) { if (!ev.some(([, a, b]) => b > t0 && a < t0 + 1)) everyWindow = false; }
    ok('昼 · 开屏节奏（R5）：1.0 s 起到蝶落地之间每一刻都有叙事事件在进行（绽开、荆棘光脉冲、枯枝描画、蝶的出生、飞行首尾相接，没有空档），任意连续 1 s 至少有一个', everyWindow && worstGap < 0.011, `空档共 ${worstGap.toFixed(2)} s`);
    ok('昼 · 枯枝 1.3 s 起从左上角在空雾里描出来（一直描到 4.4 s，蝶落地前 0.6 s 描完）；荆棘光脉冲放在 1.1–2.0 s（绽开的圆已铺开之后）；蝶的出生光晕 2.0 s 起', DAY.DT.twig[0] === 1.3 && DAY.DT.twig[1] === 4.4 && DAY.DT.twig[1] <= DAY.DT.fly[1] - 0.5 && DAY.DT.thorn[0] === 1.1 && DAY.DT.thorn[1] === 2.0 && DAY.DT.glow === 2.0);
    const tp = Array.from({ length: 421 }, (_, i) => DAY.twigProgress(i / 60));
    ok('昼 · 枯枝描画进度：1.2 s 前为 0、单调不减、逐帧（1/60 s）跳变 ≤ 2%（没有一笔突然冒出来）、4.4 s 画满；1.4 s 时枝尖已探进画面（≥ 10%）', DAY.twigProgress(1.2) === 0 && tp.every((v, i) => i === 0 || (v >= tp[i - 1] - 1e-12 && v - tp[i - 1] <= 0.02)) && near(DAY.twigProgress(4.4), 1, 1e-9) && DAY.twigProgress(1.4) >= 0.1, `1.4 s: ${DAY.twigProgress(1.4).toFixed(3)}，最大逐帧 ${Math.max(...tp.map((v, i) => (i ? v - tp[i - 1] : 0))).toFixed(4)}`);
    {
      // 枝杈不得比主干前沿早出现：遮罩进度是主干的弧长比例（pathLength = 1），线宽 30 的圆头描边会让「附着点周围的圆盘」在进度越过 attach 的那一刻整块出现——
      // attach 比附着点的真实弧长比例小，就是一座凭空冒出的孤岛（旧版 [.15 .27 .5 .63 .78]，比真值 [.196 .354 .664 .747 .845] 早 .05–.16，一帧里墨面积涨 18–40 倍）。
      // 用 20000 点折线独立量一遍弧长（和 buildTwig 里的 1200 点不是同一份采样）.
      const tw = DAY.buildTwig();
      const N = 20000;
      const poly: Array<[number, number, number]> = [];
      let acc = 0;
      let prevP: [number, number] | null = null;
      for (const seg of [tw.main1, tw.main2]) {
        for (let i = 0; i <= N; i++) {
          const q = bez(seg, i / N);
          if (prevP) acc += Math.hypot(q[0] - prevP[0], q[1] - prevP[1]);
          prevP = q;
          poly.push([q[0], q[1], acc]);
        }
      }
      const frac = (pt: readonly [number, number]) => { let best = 1e9; let a = 0; for (const [x, y, c] of poly) { const d = Math.hypot(x - pt[0], y - pt[1]); if (d < best) { best = d; a = c; } } return a / acc; };
      const worst = tw.subs.slice(0, 5).map((s, i) => frac(s.p[0]) - tw.attach[i]);
      ok('昼 · 枝杈的出现时刻不早于主干前沿：attach[i] ≥ 附着点的弧长比例 − 1e-3（5 根）；sf 在 sa 画满之后才起笔', worst.every((d) => d <= 1e-3) && tw.attach[5] >= tw.attach[0] + tw.win[0] - 1e-9, `最大提前量 ${Math.max(...worst).toFixed(5)}；attach ${tw.attach.map((v) => v.toFixed(3)).join(' ')}`);
      ok('昼 · 枝杈的显现窗口：attach + win ≤ 1（主干画满、遮罩撤掉那一刻每根枝都已画满，不再有最后一下补满）、窗口 > 0、不超过 .28（sf .16）', tw.attach.every((a, i) => a + tw.win[i] <= 1 + 1e-9 && tw.win[i] > 0.1 && tw.win[i] <= (i === 5 ? 0.16 : 0.28) + 1e-9));
    }
    ok('昼 · 起手的雾：前 0.3 s 已露区上压 α ≥ 0.4 的雾（之后 0.6 s 里淡去）；花束先于主圆、主圆晚 0.12 s 淡入；点花只在「主圆半径 − 40 px」以内弹出', DAY.bloomFogAlpha(0) >= 0.4 && DAY.bloomFogAlpha(0.3) >= 0.4 && DAY.bloomFogAlpha(0.9) === 0 && Array.from({ length: 91 }, (_, i) => DAY.bloomFogAlpha(i / 100)).every((v, i, a) => i === 0 || v <= a[i - 1] + 1e-12) && DAY.BLOOM_MAIN_DELAY === 0.12 && DAY.BLOOM_FLOWER_MARGIN === 40);
  }

  // 夜：左栏条目——面板几乎到位就开始（不骑着面板被屏幕左缘切）、快速版每行不再「啪」地出现、空面板不再黑
  {
    const N = TR.nightSegs('full');
    const NF = TR.nightSegs('fast');
    for (const [name, segs, navW] of [['完整版', N, 260], ['完整版（紧凑栏）', N, 56], ['快速版', NF, 260]] as const) {
      const base = TR.rowBaseTime(segs.nav, navW);
      const pan = TR.PAN_E((base - segs.nav[0]) / (segs.nav[1] - segs.nav[0]));
      ok(`夜 · 左栏条目的底线（${name}，navW ${navW}）：面板离到位只差 ≤ ${TR.ROW_CLIP_PX} px 时开始（字与图标不被屏幕左缘切到），且早于「推入结束前 40 ms」`, TR.navPushX(navW, pan) >= -TR.ROW_CLIP_PX - 0.5 && base < segs.nav[1] - 0.04 * (segs === N ? 1 : 7 / 12) + 1e-9 && base > segs.nav[0], `base ${base.toFixed(3)} s、离到位 ${(-TR.navPushX(navW, pan)).toFixed(1)} px`);
    }
    {
      const base = TR.rowBaseTime(NF.nav, 260);
      const rows = [1080, 800, 500, 200, 60].map((y) => TR.rowSpan('fast', y, 1080, 0, 0, base));
      ok('夜 · 快速版左栏条目：每行淡入 ≥ 0.2 s（原来 0.15 s、steep 的 ease-out 下有效淡入只剩约 80 ms）、整列在 0.7 s 内完成、自下而上依旧错开（轻扫 0.05 s）、用较缓的 ROW_EASE',
        rows.every((r) => r[1] - r[0] >= 0.2 - 1e-9) && rows.every((r) => r[1] <= 0.7 + 1e-9) && rows[0][0] < rows[4][0] && TR.ROW_DUR_FAST >= 0.2 && TR.ROW_EASE === 'cubic-bezier(0.3, 0.1, 0.3, 1)', rows.map((r) => `${r[0].toFixed(3)}–${r[1].toFixed(3)}`).join(' '));
      const f = cubic(0.3, 0.1, 0.3, 1);
      let lo = 0; let hi = 1;
      for (let i = 0; i < 30; i++) { const m = (lo + hi) / 2; if (f(m) < 0.96) lo = m; else hi = m; }
      ok('夜 · 快速版左栏条目：有效淡入时长（不透明度 0 → 0.96）≥ 150 ms（ROW_DUR_FAST × ROW_EASE 到 0.96 的进度）', TR.ROW_DUR_FAST * lo >= 0.15, `${(TR.ROW_DUR_FAST * lo * 1000).toFixed(0)} ms`);
    }
    ok('夜 · 推入中的空面板（R5）：玻璃底色向薰衣草混 ≤ 12%（不改变它的性格，只是别成一条近乎纯黑的竖条），条目开始浮现后 0.32 s 内回到自己的颜色', TR.NAV_GLOW_K > 0 && TR.NAV_GLOW_K <= 0.12 && TR.NAV_GLOW_OUT >= 0.2 && TR.rowBaseTime(N.nav, 260) + TR.NAV_GLOW_OUT <= 0.8);
  }
}

// ── 匀速节拍（pacer.ts）：渲染间隔取刷新间隔的整数倍里最接近 16.7 ms 的那个（legacy 实现；comp 的调速器见后面「调速器」一节）──
setBootImpl('legacy');
{
  const ms = (hz: number) => 1000 / hz;
  ok('beatEvery：240 Hz → 4（60 fps）、144 Hz → 2（72 fps）、120 Hz → 2（60 fps）、60 Hz → 1', PC.beatEvery(ms(240)) === 4 && PC.beatEvery(ms(144)) === 2 && PC.beatEvery(ms(120)) === 2 && PC.beatEvery(ms(60)) === 1,
    [240, 144, 120, 60].map((h) => PC.beatEvery(ms(h))).join(','));
  ok('beatEvery：165 Hz → 3、360 Hz → 6、90 Hz → 1（并列取小倍数）、75 Hz → 1、30 Hz → 1', PC.beatEvery(ms(165)) === 3 && PC.beatEvery(ms(360)) === 6 && PC.beatEvery(ms(90)) === 1 && PC.beatEvery(ms(75)) === 1 && PC.beatEvery(ms(30)) === 1,
    [165, 360, 90, 75, 30].map((h) => PC.beatEvery(ms(h))).join(','));
  ok('beatEvery：无效输入退回 1；渲染间隔恒在目标的 ±5.6 ms 内（60–360 Hz 逐 1 Hz 扫）', PC.beatEvery(0) === 1 && PC.beatEvery(NaN) === 1 && Array.from({ length: 301 }, (_, i) => 60 + i).every((h) => Math.abs(PC.beatMs(ms(h)) - PC.TARGET_MS) <= 5.6), '');
  ok('snapRefresh：4.0 / 4.3 ms 吸附到 240 Hz，6.9 / 7.1 ms → 144 Hz，16.4 ms → 60 Hz；离得远的原样（9.0 ms）', near(PC.snapRefresh(4.0), ms(240), 1e-9) && near(PC.snapRefresh(4.3), ms(240), 1e-9) && near(PC.snapRefresh(6.9), ms(144), 1e-9) && near(PC.snapRefresh(7.1), ms(144), 1e-9) && near(PC.snapRefresh(16.4), ms(60), 1e-9) && PC.snapRefresh(9.0) === 9.0);
  {
    const jit = mulberry32(5);
    const at = (hz: number, n: number, bad: number[] = []) => Array.from({ length: n }, (_, i) => ms(hz) * (bad.includes(i) ? 3 : 1) + (jit() - 0.5) * 0.3);
    ok('estimateRefresh：240 / 144 / 120 / 60 Hz 的 rAF 间隔（带 ±0.15 ms 抖动）估出对应的刷新间隔', [240, 144, 120, 60].every((h) => near(PC.estimateRefresh(at(h, 20)) ?? 0, ms(h), 1e-9)));
    ok('estimateRefresh：混进慢帧（间隔 ×3）和一次 1 s 的卡顿，仍是单帧间隔（慢帧只会变大，取较小的 60%）', near(PC.estimateRefresh([...at(240, 20, [2, 5, 9, 14]), 1002]) ?? 0, ms(240), 1e-9));
    ok('estimateRefresh：样本不足（< 6 个有效间隔）或全是无效间隔 → undefined', PC.estimateRefresh([4.2, 4.1, 4.2]) === undefined && PC.estimateRefresh([1002, 1004, 1003, 1001, 1002, 1003, 1002]) === undefined && PC.estimateRefresh([]) === undefined);
  }
  // 模拟 rAF：每个垂直同步推进一个刷新间隔（带抖动），可在指定的垂直同步上整体卡住一次（主线程忙）
  interface SimOpts { hz: number; dur?: number; jitter?: number; stallAt?: number; stallMs?: number }
  const sim = (o: SimOpts) => {
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, doc: g.document };
    let now = 5000;
    const q = new Map<number, (t: number) => void>();
    let id = 0;
    g.requestAnimationFrame = (cb: (t: number) => void) => { q.set(++id, cb); return id; };
    g.cancelAnimationFrame = (i: number) => { q.delete(i); };
    g.document = { timeline: { get currentTime() { return now; } } };
    PC.resetLearnedRefresh();
    const frames: number[] = [];
    let t0: number | undefined;
    let starts = 0;
    let finished = 0;
    const dur = o.dur ?? 1.2;
    const cancel = TR.runClock(dur, (tr) => frames.push(tr), () => { finished++; }, { onStart: (t) => { t0 = t; starts++; } });
    const rr = mulberry32(11);
    let vsync = 0;
    while (!finished && vsync < 5000) {
      vsync++;
      now += ms(o.hz) + ((rr() - 0.5) * (o.jitter ?? 0.2)) + (vsync === o.stallAt ? (o.stallMs ?? 0) : 0);
      const cbs = [...q.values()];
      q.clear();
      for (const cb of cbs) cb(now);
    }
    cancel();
    g.requestAnimationFrame = saved.raf; g.cancelAnimationFrame = saved.caf; g.document = saved.doc;
    return { frames, t0, starts, finished, vsync };
  };
  for (const hz of [240, 144, 120, 60]) {
    const r = sim({ hz });
    const mid = r.frames.slice(1, -1);
    const iv = mid.slice(2).map((t, i) => (t - mid[i + 1]) * 1000);       // 头一个间隔是节拍器热身（还没量出刷新间隔），之后的才要匀速；真实里下一个节拍器继承上一个量到的值，没有热身
    const want = PC.beatMs(ms(hz));
    ok(`runClock @ ${hz} Hz：同步先画第 0 帧、onStart 一次、到点画终帧（= 总长）再 done 一次`, r.frames[0] === 0 && r.starts === 1 && r.finished === 1 && r.frames[r.frames.length - 1] === 1.2, `frames[0]=${r.frames[0]} last=${r.frames[r.frames.length - 1]} starts=${r.starts} done=${r.finished}`);
    ok(`runClock @ ${hz} Hz：节拍帧匀速——间隔都在 ${want.toFixed(1)} ± 1.5 ms 内（不是每个 rAF 都画），共 ${Math.round(1.2 * 1000 / want)} 帧上下`,
      iv.length > 10 && iv.every((d) => Math.abs(d - want) <= 1.5) && Math.abs(mid.length - 1.2 * 1000 / want) <= 3, `间隔 ${Math.min(...iv).toFixed(2)}–${Math.max(...iv).toFixed(2)} ms，${mid.length} 帧（${r.vsync} 个垂直同步）`);
  }
  {
    const r = sim({ hz: 240, stallAt: 100, stallMs: 60 });
    const mid = r.frames.slice(1, -1);
    const iv = mid.slice(1).map((t, i) => (t - mid[i]) * 1000);
    ok('runClock @ 240 Hz，中途卡住 60 ms：卡住之后不连发补帧（最短间隔 ≥ 14 ms），时间照墙钟走、仍按时画终帧', Math.min(...iv) >= 14 && r.finished === 1 && r.frames[r.frames.length - 1] === 1.2, `最短 ${Math.min(...iv).toFixed(2)} ms，最长 ${Math.max(...iv).toFixed(2)} ms`);
    ok('runClock：起点 t0 取第一个 rAF 回调时的时间轴时刻（WAAPI 的 startTime 与场景同一个口径）；tr 从 0 起', r.t0 !== undefined && r.t0 > 5000 && mid[0] >= 0 && mid[0] < 0.03, `t0=${r.t0} 首个节拍帧 ${mid[0]}`);
  }
  {
    // 新一个节拍器一出生就用上一个量到的刷新间隔：不必再热身
    PC.resetLearnedRefresh();
    const p = new PC.Pacer();
    let t = 100;
    for (let i = 0; i < 12; i++) { t += ms(240); p.due(t); }
    const learnedOk = near(PC.learnedRefresh() ?? 0, ms(240), 1e-9) && new PC.Pacer().every === 4;
    PC.resetLearnedRefresh();
    ok('Pacer：量了十来帧就知道是 240 Hz（every = 4），记下来给下一个节拍器；resetLearnedRefresh 清掉', near(p.refreshMs ?? 0, ms(240), 1e-9) && p.every === 4 && learnedOk && new PC.Pacer().every === 0);
  }
}

setBootImpl(undefined);

// ── 调速器（governor.ts）与调速器模式的节拍器：默认每次刷新都推进，慢机器按 1 → 2 → 4 档升，独显才保留约 60 次/秒的保护档 ──
{
  const ms = (hz: number) => 1000 / hz;
  /** 模拟 n 个 rAF 回调：每个间隔 iv(i)（ms），每个画了的帧花 cost(i) ms；返回每一档变化的时刻与最终档位. */
  const run = (g: GOV.Governor, n: number, iv: (i: number) => number, cost: (i: number) => number = () => 0.3, start = 1000) => {
    const p = new PC.Pacer({ governor: g });
    let now = start;
    const draws: number[] = [];
    for (let i = 0; i < n; i++) {
      now += iv(i);
      if (p.due(now)) { draws.push(now); p.cost(cost(i)); }
    }
    return { draws, now, p };
  };
  PC.resetLearnedRefresh();
  {
    const g = new GOV.Governor();
    const r = run(g, 600, () => ms(240));
    ok('调速器：240 Hz、每帧 0.3 ms：600 个 rAF 之后仍是 1 档，每个 rAF 都画（不再有 60 fps 封顶）', g.divisor === 1 && r.draws.length >= 598, `档位 ${g.divisor}，画了 ${r.draws.length} 帧`);
    const iv = r.draws.slice(1).map((t, i) => t - r.draws[i]);
    ok('调速器：1 档下的节拍间隔就是刷新间隔（4.17 ms），没有 16.7 ms', iv.every((d) => Math.abs(d - ms(240)) < 0.01), `${Math.min(...iv).toFixed(2)}–${Math.max(...iv).toFixed(2)}`);
  }
  PC.resetLearnedRefresh();
  {
    const g = new GOV.Governor();
    const r = run(g, 400, (i) => (i === 100 || i === 101 ? 25 : ms(240)));
    ok('调速器：起步时一两帧的卡顿（两个 25 ms 的 rAF 间隔）不升档', g.divisor === 1, `档位 ${g.divisor}，${JSON.stringify(g.state().log)}`);
    void r;
  }
  PC.resetLearnedRefresh();
  {
    const g = new GOV.Governor();
    run(g, 160, (i) => (i < 40 ? ms(240) : ms(240) * 2));              // 先 240 Hz（量出刷新间隔），之后 rAF 间隔恒为 2 倍（8.3 ms）：p90 > 1.5 × 刷新间隔（帧内 CPU 只有 0.3 ms：GPU 背压照样升档）
    ok('调速器：rAF 间隔 p90 > 1.5 × 刷新间隔（持续 ≥ 2 个窗口；GPU 背压也算）→ 升到 2 档', g.divisor >= 2, `档位 ${g.divisor}`);
  }
  PC.resetLearnedRefresh();
  {
    // 转场刚开始（carryOver）的头 QUIET_MS 不评估：起步那几帧的卡顿不会让转场一开始就升档；持续偏慢过了这段照样升
    const g = new GOV.Governor();
    run(g, 60, () => ms(240));                                           // 先量出刷新间隔
    g.carryOver();
    const p = new PC.Pacer({ governor: g });
    let now = 5000;
    for (let i = 0; i < 10; i++) { now += ms(240); p.due(now); p.cost(0.3); }                       // 先 240 Hz 几帧（节拍器测出刷新间隔）
    for (let i = 0; i < 20; i++) { now += ms(240) * 3; p.due(now); p.cost(0.3); }                 // 头 ~100 ms：慢（3 倍间隔）——在安静期里
    ok('调速器：carryOver 之后头 150 ms 的慢帧不计（起步卡顿不升档）', g.divisor === 1 && g.state().raised === 0, `档位 ${g.divisor}`);
    for (let i = 0; i < 120; i++) { now += ms(240) * 3; p.due(now); p.cost(0.3); }                // 之后持续慢
    ok('调速器：过了安静期持续偏慢照样升档', g.divisor >= 2, `档位 ${g.divisor}`);
    void p;
  }
  PC.resetLearnedRefresh();
  {
    // quietFor(ms)：开屏里已知会卡一下的时刻（预热探针放上去 / 撤下来）不评估；时间用 performance.now() 的口径（与 rAF 时间戳同一个）
    const g = new GOV.Governor();
    const p = new PC.Pacer({ governor: g });
    let now = performance.now();
    for (let i = 0; i < 10; i++) { now += ms(240); p.due(now); p.cost(0.3); }
    g.quietFor(300);
    for (let i = 0; i < 20; i++) { now += ms(240) * 3; p.due(now); p.cost(0.3); }                 // ~250 ms 的慢帧，都在安静期里
    ok('调速器：quietFor(300) 之内的慢帧不计（预热探针的卡顿不升档）', g.divisor === 1 && g.state().raised === 0, `档位 ${g.divisor}`);
    for (let i = 0; i < 120; i++) { now += ms(240) * 3; p.due(now); p.cost(0.3); }                // 安静期过了仍持续慢
    ok('调速器：quietFor 过期之后持续偏慢照样升档', g.divisor >= 2, `档位 ${g.divisor}`);
    const g2 = new GOV.Governor();
    g2.quietFor(1000); g2.quietFor(10);
    ok('调速器：quietFor 取更晚的结束时刻（后一次较短的不会缩短安静期）', (() => { const p2 = new PC.Pacer({ governor: g2 }); let n2 = performance.now(); for (let i = 0; i < 8; i++) { n2 += ms(240); p2.due(n2); p2.cost(0.3); } for (let i = 0; i < 100; i++) { n2 += ms(240) * 3; p2.due(n2); p2.cost(0.3); } return g2.divisor === 1; })(), `档位 ${g2.divisor}`);
  }
  PC.resetLearnedRefresh();
  {
    const g = new GOV.Governor();
    const t = run(g, 200, () => ms(240), () => 3);   // 每帧在主线程上花 3 ms > 0.5 × 4.17 ms
    ok('调速器：p90 帧内 CPU > 0.5 × 刷新间隔（持续）→ 升档', g.divisor >= 2, `档位 ${g.divisor}`);
    void t;
  }
  PC.resetLearnedRefresh();
  {
    // 升档之后：节拍是刷新间隔的整数倍、间隔均匀（2 档 = 每隔一个 rAF 画一次）
    const g = new GOV.Governor();
    const p = new PC.Pacer({ governor: g });
    let now = 1000;
    for (let i = 0; i < 40; i++) { now += ms(240); p.due(now); p.cost(0.2); }
    (g as unknown as { div: number }).div = 2;
    const draws: number[] = [];
    for (let i = 0; i < 80; i++) { now += ms(240); if (p.due(now)) draws.push(now); }
    const iv = draws.slice(1).map((t, i) => t - draws[i]);
    ok('调速器：2 档 → 节拍间隔恒为 2 个刷新间隔（8.33 ms，均匀），4 档同理 16.7 ms', iv.length >= 30 && iv.every((d) => Math.abs(d - 2 * ms(240)) < 0.05), `${Math.min(...iv).toFixed(2)}–${Math.max(...iv).toFixed(2)}`);
    (g as unknown as { div: number }).div = 4;
    const d4: number[] = [];
    for (let i = 0; i < 160; i++) { now += ms(240); if (p.due(now)) d4.push(now); }
    const iv4 = d4.slice(2).map((t, i) => t - d4[i + 1]);
    ok('调速器：4 档 → 16.7 ms 均匀', iv4.length >= 25 && iv4.every((d) => Math.abs(d - 4 * ms(240)) < 0.05), `${Math.min(...iv4).toFixed(2)}–${Math.max(...iv4).toFixed(2)}`);
  }
  PC.resetLearnedRefresh();
  {
    // 升档后至少保持 600 ms，且最多 4 档；只升不降
    const g = new GOV.Governor();
    const p = new PC.Pacer({ governor: g });
    let now = 1000;
    const stamps: Array<[number, number]> = [];
    for (let i = 0; i < 40; i++) { now += ms(240); p.due(now); p.cost(0.2); }          // 先量出刷新间隔（240 Hz）
    for (let i = 0; i < 4000; i++) { now += ms(240) * 3; p.due(now); p.cost(4); stamps.push([now, g.divisor]); }
    const log = g.state().log;
    ok('调速器：持续很慢 → 1 → 2 → 4 档，最多 4 档，两次升档至少相隔 600 ms', g.divisor === 4 && log.length === 2 && log[1].t - log[0].t >= GOV.HOLD_MS, JSON.stringify(log));
    ok('调速器：只升不降（档位序列单调不减）', stamps.every((s, i) => i === 0 || s[1] >= stamps[i - 1][1]));
    g.reset();
    ok('调速器：reset() 回到 1 档', g.divisor === 1 && g.state().raised === 0);
    (g as unknown as { div: number }).div = 4;
    g.carryOver();
    const c2 = g.divisor;
    g.carryOver();
    const c3 = g.divisor;
    g.carryOver();
    ok('调速器：carryOver()（转场开始）开屏里升到 4 档 → 转场从 2 档起、再 → 1 档、1 档仍是 1；样本与 raised 清空', c2 === 2 && c3 === 1 && g.divisor === 1 && g.state().raised === 0, `${c2},${c3},${g.divisor}`);
  }
  PC.resetLearnedRefresh();
  {
    const floorAt = (hz: number, discrete = true) => { const g = new GOV.Governor(); g.setDiscrete(discrete); g.setRefresh(ms(hz)); return g.divisor; };
    const a = floorAt(240); const b = floorAt(144); const c = floorAt(120); const d = floorAt(60);
    const gg = new GOV.Governor(); gg.setRefresh(ms(240));
    ok('独显的保护档：240 Hz → 4（60 次/秒）、144 Hz → 2、120 Hz → 2、60 Hz → 1；集显（不 setDiscrete）恒从 1 起；调速器只往小了记刷新间隔（画不动时 rAF 间隔被拉长也不会改）', a === 4 && b === 2 && c === 2 && d === 1 && floorAt(240, false) === 1 && (gg.setRefresh(ms(60)), gg.refreshMs === ms(240)), `${a},${b},${c},${d}`);
    ok('discreteFloor：无效刷新间隔 → 1；上限 4', GOV.discreteFloor(0) === 1 && GOV.discreteFloor(ms(360)) === 4 && GOV.discreteFloor(ms(30)) === 1);
  }
  {
    // 显卡种类的记录要和这次启动的偏好对得上：在集显上记下 'integrated' 后改「高性能」重启，独显保护档不能因旧记录失效；反过来也不能把集显无谓地压到 60
    const d = GK.discreteFor;
    const same = d('auto:integrated', 'auto') === false && d('high:discrete', 'high') === true && d('auto:discrete', 'auto') === true;
    const switched = d('auto:integrated', 'high') === true && d('high:discrete', 'auto') === false && d('high:discrete', 'low') === false;
    const legacy = d('integrated', 'high') === true && d('discrete', 'auto') === false && d(null, 'high') === true && d(null, 'auto') === false && d('junk', 'low') === false;
    ok('显卡种类记录：偏好没变信记录；换了偏好（或旧格式 / 没有记录）按这次启动的偏好，high = 独显', same && switched && legacy, `${same},${switched},${legacy}`);
  }
  {
    // 转场开始（carryOver）不能丢刷新间隔：nightScene / dayTrComp 的 prepareTransition 在 carryOver 之后才读 floorDivisor——丢掉的话独显（240 Hz）读到的恒是 1，
    // 转场里的场景通道不会一开始就是 60 次/秒的阶梯，之后刷新间隔重新量到时也没有 retier 触发。但升档的判据（refreshMs）要在转场里重新量（不带进来）：
    // 带进来的话集显被 GPU 背压拖到每两个刷新一帧时阈值按 240 Hz 算，转场里一路升到 4 档（实测昼完整版 3 轮里 3 轮；原来 1 轮）
    const g = new GOV.Governor();
    g.setDiscrete(true);
    g.setRefresh(ms(240));
    g.carryOver();
    const kept = g.floorDivisor === 4 && g.divisor === 4 && g.refreshMs === undefined;
    g.setRefresh(ms(120));          // 转场里被背压拖慢、重新量成 120 Hz：保护档取见过的最小刷新间隔，仍是 4
    const keeps = g.floorDivisor === 4 && g.refreshMs === ms(120);
    g.carryOver();                  // 再来一次转场：仍记着
    const again = g.floorDivisor === 4;
    g.reset();
    const cleared = g.refreshMs === undefined && g.floorDivisor === 1;
    const gi = new GOV.Governor();
    gi.setRefresh(ms(240));
    gi.carryOver();
    ok('调速器：carryOver() 把刷新间隔带给独显的保护档（240 Hz → 4 在转场里的场景通道一开始就读得到；之后量到更大的间隔也不降）；升档判据的 refreshMs 不带进来（转场里重新量）；reset() 才清掉', kept && keeps && again && cleared && gi.floorDivisor === 1 && gi.divisor === 1 && gi.refreshMs === undefined, `${kept},${keeps},${again},${cleared},${gi.floorDivisor}`);
    const tsrc0 = readFileSync(join(process.cwd(), 'src/components/decor/boot/transition.ts'), 'utf8');
    ok('beginTransition：carryOver() 先于 scene.prepareTransition（场景此刻读 floorDivisor）', tsrc0.indexOf('bootGovernor.carryOver()') > 0 && tsrc0.indexOf('bootGovernor.carryOver()') < tsrc0.indexOf('scene.prepareTransition('));
  }
  PC.resetLearnedRefresh();
  {
    // 调速器模式的 runClock：每个 rAF 都画（240 Hz 下约 290 帧 / 1.2 s），旧模式 72 帧
    setBootImpl('comp');
    GOV.bootGovernor.reset();
    const g = globalThis as unknown as Record<string, unknown>;
    const saved = { raf: g.requestAnimationFrame, caf: g.cancelAnimationFrame, doc: g.document };
    let now = 5000;
    const q = new Map<number, (t: number) => void>();
    let id = 0;
    g.requestAnimationFrame = (cb: (t: number) => void) => { q.set(++id, cb); return id; };
    g.cancelAnimationFrame = (i: number) => { q.delete(i); };
    g.document = { timeline: { get currentTime() { return now; } } };
    const frames: number[] = [];
    let finished = 0;
    TR.runClock(1.2, (tr) => frames.push(tr), () => { finished++; }, {});
    let v = 0;
    while (!finished && v < 5000) { v++; now += ms(240); const cbs = [...q.values()]; q.clear(); for (const cb of cbs) cb(now); }
    g.requestAnimationFrame = saved.raf; g.cancelAnimationFrame = saved.caf; g.document = saved.doc;
    setBootImpl(undefined);
    ok('runClock（comp，调速器模式）@ 240 Hz：每个 rAF 都出一个节拍帧（≈ 288 帧 / 1.2 s），首帧 0、末帧 = 总长', frames.length >= 280 && frames[0] === 0 && frames[frames.length - 1] === 1.2, `${frames.length} 帧`);
  }
  PC.resetLearnedRefresh();
}

{
  setBootImpl('comp');
  const a = governedFor('night'); const b = governedFor('day');
  setBootImpl('legacy');
  const c = governedFor('night');
  setBootImpl(undefined);
  ok('调速器给接入了合成器路径的主题（夜；0.1.4 起昼的开屏也是：绽开段每拍重光栅的东西拆成了画布 / 位图 / 合成器层）用；legacy 实现一律旧节拍', a === true && b === true && c === false, `${a},${b},${c}`);
}

// ── 采样器（sampler.ts）与通道（channels.ts）：原生缓动零误差、折线在容限内、阶梯整数倍均匀、smoothstep ≡ cubic-bezier(1/3, 0, 2/3, 1) ──
{
  let sm = 0;
  const sb = BM.cubic(...BM.SSTEP_BEZIER);
  for (let i = 0; i <= 1000; i++) sm = Math.max(sm, Math.abs(sb(i / 1000) - BM.sstep(i / 1000)));
  ok('smoothstep（sstep）恰好是 cubic-bezier(1/3, 0, 2/3, 1)：逐点差 < 1e-5（合成器可以原生表达它）', sm < 1e-5, sm.toExponential(2));
  ok('每条 E / 转场缓动都附了 cubic-bezier 四元组（可以原生表达）', Object.values(E).every((f) => (f as BM.Ease).bezier?.length === 4) && [TR.FLY_E, TR.FLIP_E, TR.PAN_E, TR.ART_E, TR.PAPER_E, TR.WIN_E].every((f) => f.bezier?.length === 4));
  ok('PAN_CSS / PAPER_CSS / CSS_EASE 字符串与对应曲线的四元组一致', TR.PAN_CSS === `cubic-bezier(${TR.PAN_E.bezier!.join(', ')})` && TR.PAPER_CSS === `cubic-bezier(${TR.PAPER_E.bezier!.join(', ')})` && TR.CSS_EASE === `cubic-bezier(${E.ease.bezier!.join(', ')})`);

  const dur = 1.2;
  const nat = CH.nativeChannel({ name: 't-native', dur, span: [0.1, 0.54], bezier: TR.PAN_E.bezier!, ease: TR.PAN_E, from: [0, -3], to: [260, 7], css: (v) => ({ transform: `translate(${v[0]}px, ${v[1]}px)` }) });
  const nt = SM.nativeTrack(nat);
  const ne = SM.maxTrackError(nat, nt);
  ok('原生缓动通道：关键帧求值与纯函数逐点一致（误差 < 1e-3 px），只有 4 个关键帧 + 同一条 cubic-bezier', Math.max(...ne) < 1e-3 && nt.length === 4 && nt[1].easing === TR.PAN_CSS, `${ne.map((x) => x.toExponential(1)).join(',')} ${nt.length}`);
  const nat0 = CH.nativeChannel({ name: 't-native0', dur, span: [0, 0.6], bezier: [0, 0, 1, 1], ease: (x) => x, from: [1], to: [0], css: CH.cssOpacity });
  ok('原生缓动通道：从 0 起、到总长前结束 → 3 个关键帧（没有多余的起点帧）', SM.nativeTrack(nat0).length === 3);

  // 折线：旋转的蝶（x、y 沿曲线、转角、拍翅）——容限 0.25 px / 0.5 ÷ 255
  const poly = CH.polyChannel({
    name: 't-poly', dur, knots: CH.knotsOf(dur, [0, 0.8], [0.88, 0.96]), tol: [CH.TOL_PX, CH.TOL_PX, 0.0035, 0.005, 0.005, CH.TOL_ALPHA], css: (v) => CH.cssPose(v.slice(0, 5)),
    truth: (tr) => { const u = Math.min(1, tr / 0.8); return [300 * u * u, 700 * Math.sin(u * 2.2), -0.5 + 0.9 * u, (0.71 + 0.29 * Math.cos(2 * Math.PI * 2.5 * tr)) * (1.7 - 1.4 * u), 1.7 - 1.4 * u, Math.min(1, tr / 0.1) * (tr > 0.88 ? 1 - Math.min(1, (tr - 0.88) / 0.08) : 1)]; },
  });
  const pt = SM.polyTrack(poly);
  const pe = SM.maxTrackError(poly, pt);
  ok('折线通道：采样后逐点对拍，各分量误差都在容限内（位置 < 0.25 px、不透明度 < 0.5 / 255）', pe.every((e, i) => e <= poly.tol[i]), pe.map((e, i) => `${e.toFixed(4)}/${poly.tol[i]}`).join(' '));
  ok('折线通道：关键帧数合理（< 300），时间表的拐点（0.8、0.88、0.96）必取', pt.length < 300 && [0.8, 0.88, 0.96].every((k) => pt.some((p) => Math.abs(p.offset * dur - k) < 1e-9)), `${pt.length} 个`);
  ok('折线通道：偏移单调、首 0 末 1、没有重复偏移', pt[0].offset === 0 && pt[pt.length - 1].offset === 1 && pt.every((p, i) => i === 0 || p.offset > pt[i - 1].offset));
  // 阶梯：divisor × 刷新间隔，每个台阶取起点的真值
  const refresh = 1000 / 240;
  for (const div of [2, 4]) {
    const st = SM.steppedTrack(poly, (div * refresh) / 1000);
    const stepSec = (div * refresh) / 1000;
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      const tr = (dur * i) / 600;
      const k = Math.min(Math.floor(tr / stepSec + 1e-9), st.length - 2);
      const want = poly.truth(Math.min(dur, k * stepSec));
      const got = SM.evalTrack(st, tr / dur);
      for (let c = 0; c < want.length; c++) worst = Math.max(worst, Math.abs(got[c] - want[c]));
    }
    ok(`阶梯通道（${div} 档，台阶 ${(div * refresh).toFixed(2)} ms）：每个台阶恒定取起点的真值，台阶长度是刷新间隔的整数倍`, worst < 1e-9 && st.slice(0, -1).every((k) => k.easing === SM.STEP_EASING) && Math.abs((st[1].offset - st[0].offset) * dur - stepSec) < 1e-9, `${worst}`);
  }
  ok('trackFor：divisor 1 → 原生 / 折线；divisor > 1 → 阶梯（原生通道也一样）', SM.trackFor(nat, 1).length === 4 && SM.trackFor(nat, 2, refresh).length > 50 && SM.trackFor(nat, 2, refresh)[0].easing === SM.STEP_EASING);
  ok('evalTrack：相同偏移取后一个关键帧（与 CSS 一致）；超出 [0, 1] 夹住', (() => { const t: SM.TrackKey[] = [{ offset: 0, v: [0], easing: 'linear' }, { offset: 0.5, v: [1], easing: 'linear' }, { offset: 0.5, v: [5], easing: 'linear' }, { offset: 1, v: [9], easing: 'linear' }]; return SM.evalTrack(t, 0.5)[0] === 5 && SM.evalTrack(t, 0.25)[0] === 0.5 && SM.evalTrack(t, 2)[0] === 9 && SM.evalTrack(t, -1)[0] === 0; })());
  ok('isStatic：from = to 的原生通道不建动画', CH.isStatic(CH.nativeChannel({ name: 's', dur, span: [0, 1], bezier: [0, 0, 1, 1], ease: (x) => x, from: [1], to: [1], css: CH.cssOpacity })) && !CH.isStatic(nat));

  // Stager：按 deadline 排队、到点的必建、预算内多建
  {
    const order: number[] = [];
    const sg = new SM.Stager();
    [0.5, 0.1, 0.9, 0.3].forEach((at) => sg.add(at, () => order.push(at)));
    sg.pump(0, 100);
    ok('Stager：按 deadline 从近到远建；预算（100 ms）内全建完', order.join() === '0.1,0.3,0.5,0.9' && sg.pending === 0, order.join());
    const sg2 = new SM.Stager();
    const o2: number[] = [];
    [0.01, 0.2, 0.9].forEach((at) => sg2.add(at, () => o2.push(at)));
    sg2.pump(0, -1);                              // 预算 0：只建已经到点的（deadline ≤ tr + LEAD）
    ok('Stager：预算用完也一定建到点的（deadline ≤ tr + LEAD），其余留着', o2.join() === '0.01' && sg2.pending === 2, `${o2.join()} 余 ${sg2.pending}`);
    sg2.flush();
    ok('Stager：flush 全建；clear 清空', sg2.pending === 0 && o2.length === 3 && (() => { const s3 = new SM.Stager(); s3.add(1, () => undefined); s3.clear(); return s3.pending === 0; })());
  }

  // Stager 的预算语义：过期（deadline + GRACE ≤ tr）的才不看预算；刚到点（还在 GRACE 之内）的与其余一样按预算，每次至少建一个——起步就要在的那一批不会挤成一个大任务
  {
    const o4: string[] = [];
    const sg4 = new SM.Stager();
    ['a', 'b', 'c'].forEach((n) => sg4.add(-0.03, () => o4.push(n)));      // deadline −30 ms：tr = 0 时已经过期 30 ms > GRACE
    sg4.pump(0, -1);
    ok('Stager：过期（deadline + GRACE ≤ tr）的不看预算，全建', o4.join() === 'a,b,c' && sg4.pending === 0, o4.join());
    const o5: string[] = [];
    const sg5 = new SM.Stager();
    ['a', 'b', 'c'].forEach((n) => sg5.add(-0.01, () => o5.push(n)));      // deadline −10 ms：只过期 10 ms < GRACE（20 ms）：按预算
    sg5.pump(0, -1);
    ok('Stager：刚到点（过期 < GRACE）的按预算——预算用完只建一个（每次至少一个）', o5.join() === 'a' && sg5.pending === 2, `${o5.join()} 余 ${sg5.pending}`);
    sg5.pump(0.02, -1);
    ok('Stager：再过 GRACE 就都过期了，不看预算', o5.join() === 'a,b,c' && sg5.pending === 0, o5.join());
    // 分段任务：返回 false = 没做完，原位排回去；flush 一直做到做完
    let n = 0;
    const sg6 = new SM.Stager();
    sg6.add(0.5, () => (++n < 3 ? false : undefined));
    sg6.pump(0, 100);
    ok('Stager：任务返回 false → 排回去（预算内同一次 pump 里继续做到做完）', n === 3 && sg6.pending === 0, `n=${n} 余 ${sg6.pending}`);
    let m = 0;
    const sg7 = new SM.Stager();
    sg7.add(0.5, () => (++m < 5 ? false : undefined));
    sg7.pump(0, -1);
    ok('Stager：预算用完时分段任务停下、留一个续作（下一个节拍帧接着做）', m === 1 && sg7.pending === 1, `m=${m} 余 ${sg7.pending}`);
    sg7.flush();
    ok('Stager：flush 把分段任务做到做完', m === 5 && sg7.pending === 0, `m=${m}`);
    // samplePolyGen 与 samplePoly 逐点相同，且每段让出一次（可以分几次采完）
    const gen = SM.samplePolyGen(poly);
    let yields = 0;
    let r = gen.next();
    while (!r.done) { yields++; r = gen.next(); }
    const one = SM.samplePoly(poly);
    ok('samplePolyGen：分段采样的结果与一口气采完逐点相同；每个时间表段至少让出一次', r.done === true && r.value.length === one.length && r.value.every((p, i) => p.tr === one[i].tr && p.v.every((x, j) => x === one[i].v[j])) && yields >= 25, `${one.length} 点、让出 ${yields} 次`);
  }
}

// ── 转场结束（ClockGroup.release）：只撤应用元素上的动画，覆盖层里的 fill:both 动画留到卸载 ──
{
  // 取消覆盖层里的动画 = 覆盖层瞬间回到完整不透明的开屏定格画面；React 要到下一个宏任务才卸载它，中间被画出一帧（整屏闪一下）。HEAD 的 legacy 路径靠内联样式停在终态，没有这个问题
  const made: Array<{ cancelled: boolean; id: string; currentTime: number | null; startTime: number | null; pause(): void; cancel(): void }> = [];
  const mkEl = (): Element => ({
    animate: () => {
      const a = { cancelled: false, id: '', currentTime: 0 as number | null, startTime: 0 as number | null, pause() { /* 假动画 */ }, cancel() { this.cancelled = true; } };
      made.push(a);
      return a;
    },
  }) as unknown as Element;
  const ch1 = CH.nativeChannel({ name: 'rel-t', dur: 1.2, span: [0.1, 0.9], bezier: [0, 0, 1, 1], ease: (x) => x, from: [1], to: [0], css: CH.cssOpacity });
  const grp = new SM.ClockGroup(1.2);
  grp.animate(mkEl(), ch1);                     // 覆盖层里的
  grp.animate(mkEl(), ch1, { app: true });      // 应用元素上的（夜的首页壁纸层）
  grp.animate(mkEl(), ch1);
  grp.release();
  ok('ClockGroup.release：只撤 app 元素上的动画；覆盖层里的动画没被 cancel（覆盖层停在终态直到卸载）', made.length === 3 && made[0].cancelled === false && made[1].cancelled === true && made[2].cancelled === false && grp.size === 2, made.map((m) => m.cancelled).join(','));
  grp.release();
  ok('ClockGroup.release：重复调用无害（不再撤已撤的、不动覆盖层的）', made[0].cancelled === false && made[2].cancelled === false && grp.size === 2);
  grp.end();
  ok('ClockGroup.end（导出模式回退 / dispose）：撤掉剩下的全部', made.every((m) => m.cancelled) && grp.size === 0);
  const noC0 = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const rd = (f: string) => noC0(readFileSync(join(process.cwd(), 'src/components/decor/boot', f), 'utf8'));
  const nsrc = rd('nightScene.ts');
  ok('夜的 comp 路径：首页壁纸层上的动画标 app，转场的 end() 只 release（不 group.end()）；dispose 才全撤', /group\.animate\(wp, ch\.backdrop, \{ \.\.\.opt, app: true \}\)/.test(nsrc) && /end\(\) \{\s*group\.release\(\);/.test(nsrc) && /dispose\(\) \{\s*group\.end\(\);/.test(nsrc));
  ok('昼的 comp 路径：转场的 end() 只 release（覆盖层内的动画留到卸载）', /end\(\) \{ group\.release\(\); \}/.test(rd('dayTrComp.ts')));
}

// ── 夜的合成器通道（nightComp.ts）：每条通道逐点对拍，并与 legacy 路径那一行样式写入的公式一致 ──
{
  const W = 1920;
  const H = 1080;
  const navW = 260;
  const rr = { x: 40, y: 60, w: 28, h: 28 };
  const brand = TR.brandGoal(rr);
  const start: TR.BfPose = { x: 640, y: 760, w: 126, rot: -0.24, flap: 0.85, alpha: 1 };
  const path = TR.flightPath([start.x, start.y], [brand.x, brand.y], 1);
  const fl: TR.Flip = { x: -820, y: -300, s: 0.2 };
  const mk = (kind: 'full' | 'fast', settled: boolean, push = true): NC.NightCompInput => {
    const txFrom = -108;
    const txTo = push ? 28 : txFrom;
    const aff = push && !settled ? TR.plateFit({ W, H, imgW: 1920, imgH: 1080, z: 1.05, u0: 0.04, v0: 0.02, txTo, face: 0.57 }) : null;
    return {
      kind, from: settled ? 7.6 : 3.2, settled, push, navW: push ? navW : 0, txFrom, txTo, aff, shadeBase: [1, settled ? 1 : 0.4, settled ? 1 : 0],
      fades: [{ base: 1, dy: -6 }, { base: 1, dy: -6 }, { base: 1, dy: 0 }, { base: 0.6, dy: 0 }, { base: 0.78, dy: 0 }, { base: 0, dy: 0 }], fcr: fl, crBase: 1,
      bf: { start, goal: brand, path, glow0: 0.26, over0: 0.14 },
    };
  };
  for (const kind of ['full', 'fast'] as const) for (const settled of [true, false]) {
    if (kind === 'full' && !settled) continue;          // 完整版只在定格后
    const inp = mk(kind, settled);
    const ch = NC.nightChannels(inp);
    const dur = TR.trDuration(kind);
    const all: CH.Channel[] = [ch.hole, ch.holeInv, ch.bg, ch.plate, ...ch.shades, ch.fx, ...ch.fades, ch.credit, ch.backdrop, ...(ch.bf ? [ch.bf.pose, ch.bf.glowA, ch.bf.bodyA, ch.bf.overA] : [])].filter((c): c is CH.Channel => !!c);
    const bad: string[] = [];
    let worstFrames = 0;
    for (const c of all) {
      const tk = SM.trackFor(c, 1);
      worstFrames = Math.max(worstFrames, tk.length);
      const err = SM.maxTrackError(c, tk);
      err.forEach((e, i) => { if (e > c.tol[i] + 1e-9) bad.push(`${c.name}[${i}] ${e.toFixed(4)}>${c.tol[i]}`); });
    }
    ok(`夜通道（${kind} · ${settled ? '定格' : '被打断'}）：${all.length} 条通道逐点对拍都在容限内`, bad.length === 0, bad.join('; '));
    ok(`夜通道（${kind} · ${settled ? '定格' : '被打断'}）：单条通道的关键帧数 < 400`, worstFrames < 400, String(worstFrames));
    // 与 legacy 的公式一致：洞 = holeEdge；溶解 = 1 − dissolveAlpha；暗纱 / 前景 / 小件的淡出
    let worst = 0;
    for (let i = 0; i <= 240; i++) {
      const tr = (dur * i) / 240;
      const st = TR.trState('night', kind, tr);
      const leftEdge = inp.aff ? inp.aff.x * st.pan : (inp.txTo - inp.txFrom) * st.pan;
      const hole = ch.hole ? ch.hole.truth(tr)[0] : 0;
      worst = Math.max(worst, Math.abs(hole - TR.holeEdge(navW, leftEdge, st.pan)));
      worst = Math.max(worst, Math.abs((ch.plate as CH.Channel).truth(tr)[0] - (1 - TR.dissolveAlpha(kind, st, inp.from))) * 1000);
      ch.shades.forEach((c, k) => { if (c) worst = Math.max(worst, Math.abs(c.truth(tr)[0] - inp.shadeBase[k] * (1 - st.shade)) * 1000); });
      worst = Math.max(worst, Math.abs(ch.fx.truth(tr)[0] - (1 - BM.sstep(st.ambient))) * 1000);
      ch.fades.forEach((c, k) => { const a = BM.sstep(st.ambient); worst = Math.max(worst, Math.abs(c.truth(tr)[0] - inp.fades[k].base * (1 - a)) * 1000); if (inp.fades[k].dy) worst = Math.max(worst, Math.abs(c.truth(tr)[1] - inp.fades[k].dy * a)); });
      if (ch.holeInv) worst = Math.max(worst, Math.abs(ch.holeInv.truth(tr)[0] + hole));
      if (ch.bg && inp.aff) { const sc = BM.lerp(1, inp.aff.s, st.pan); const t = ch.bg.truth(tr); worst = Math.max(worst, Math.abs(t[2] - sc) * 1000, Math.abs(t[0] - inp.aff.x * st.pan)); }
      if (ch.bg && !inp.aff) worst = Math.max(worst, Math.abs(ch.bg.truth(tr)[0] - (inp.txTo - inp.txFrom) * st.pan));
    }
    ok(`夜通道（${kind} · ${settled ? '定格' : '被打断'}）：洞 / 溶解 / 暗纱 / 前景与小件 / 底图的真值与 legacy 的公式一致（holeEdge、dissolveAlpha、sstep…）`, worst < 1e-6, worst.toExponential(2));
  }
  {
    const full = NC.nightChannels(mk('full', true));
    const fast = NC.nightChannels(mk('fast', true));
    ok('夜通道：完整版的溶解与取景是原生缓动（2–4 个关键帧），快速版的溶解是折线（dissolveFast 不是 cubic-bezier）', full.plate?.kind === 'native' && fast.plate?.kind === 'poly' && full.hole?.kind === 'native' && fast.hole?.kind === 'native' && SM.trackFor(full.plate!, 1).length <= 4);
    ok('夜通道：洞与内层反向平移同一条曲线同一段时间（PAN_E，与左栏面板推入一致）；终点 = max(左栏宽, 取景平移露出的暗带)', full.hole!.kind === 'native' && full.hole!.bezier.join() === TR.PAN_E.bezier!.join() && full.hole!.span.join() === TR.nightSegs('full').nav.join() && full.hole!.to[0] === Math.max(260, 28 + 108) && full.holeInv!.to[0] === -full.hole!.to[0]);
    const nopush = NC.nightChannels(mk('full', true, false));
    ok('夜通道：左栏不是竖栏（不推入）→ 没有洞、没有底图平移、没有壁纸变换', !nopush.hole && !nopush.holeInv && !nopush.bg && !nopush.backdrop);
    ok('夜通道：被打断时底图是 translate · scale 的仿射（原生缓动 PAN_E，到 plateFit 的终态）；壁纸层的剩余变换是折线', (() => { const c = NC.nightChannels(mk('fast', false)); return c.bg?.kind === 'native' && c.bg.to.length === 3 && c.backdrop?.kind === 'poly'; })());
    const bfp = full.bf!.pose;
    const pose0 = bfp.truth(0);
    ok('夜通道：蝶的位姿在 tr = 0 就是起点的位姿（位置 / 转角 / 翼展 × 拍翅）', Math.abs(pose0[0] - start.x) < 1e-6 && Math.abs(pose0[1] - start.y) < 1e-6 && Math.abs(pose0[4] - start.w / 100) < 1e-6);
    const poseEnd = bfp.truth(TR.TR_FULL);
    ok('夜通道：蝶落到品牌标上（tr = 飞行段末）位置 = brandGoal', (() => { const t = bfp.truth(TR.nightSegs('full').fly[1]); return Math.abs(t[0] - brand.x) < 0.01 && Math.abs(t[1] - brand.y) < 0.01; })() && poseEnd.length === 5);
    ok('夜通道：蝶三层的不透明度在真标淡入后（swapOut 末）为 0', full.bf!.bodyA.truth(TR.nightSegs('full').swapOut[1])[0] === 0 && full.bf!.glowA.truth(TR.nightSegs('full').swapOut[1])[0] === 0);
  }
  const src = (f: string) => readFileSync(join(process.cwd(), 'src/components/decor/boot', f), 'utf8');
  const noC = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const ns = noC(src('nightScene.ts'));
  ok('夜的 comp 路径：蝶是位图层（canvas 元素 + 合成器位姿），不再每个节拍清空重画整屏画布；光尘是只盖路径外接框的小画布', /boot__bf-glow/.test(ns) && /boot__dust/.test(ns) && /drawDust/.test(ns));
  ok('夜的 comp 路径：洞不再写 clip-path（legacy 才写），改成 overflow 持有者 + 反向平移', /\.boot__hole/.test(ns) && /plate\.style\.clipPath = holeClip/.test(ns.slice(ns.indexOf('function renderLegacyPlate'), ns.indexOf('function renderLegacyCredit'))));
  const tsrc = noC(src('transition.ts'));
  ok('应用侧入场：comp 下品牌标的光晕不再动画 filter: drop-shadow（改成克隆 + opacity）、左栏光晕不再动画 background-color（改成 nav::after 的 opacity）、visibility 改成按 tr 翻转', /boot__halo/.test(tsrc) && /flips\.push/.test(tsrc) && /'::after'/.test(noC(src('transitionNight.ts'))));
}

// ── 夜 · 标题组的预烘焙叠层（nightTitleChannels）：位姿 = titleGroupAt 的 FLIP，逐字平移 = letter-spacing 的收拢，两层 opacity = tint ──
{
  const h1Box = { x: 140, y: 335, w: 845, h: 137 };
  const h1Src = { x: 148, y: 350, w: 320, h: 118 };
  const enBox = { x: 147, y: 481, w: 840, h: 38 };
  const enSrc = { x: 148, y: 484, w: 195, h: 32 };
  const grp = { h1Box, h1Src, h1Dst: { x: 80, y: 20, w: 56, h: 22 }, enSrc, enDst: { x: 80, y: 44, w: 52, h: 12 } };
  for (const kind of ['full', 'fast'] as const) {
    const dur = TR.trDuration(kind);
    const S = TR.nightSegs(kind);
    const t = NC.nightTitleChannels({ kind, grp, h1Box, enBox, enSrc, lsH1: 0.24, lsEn: 0.42, nameLS: 0.04, subLS: 0.3, fsH1: 132, fsEn: 31, letters: 6 });
    const all: CH.Channel[] = [t.h1Tf, t.enTf, t.out, t.halo, t.flat, t.h1Char, ...t.enLetter];
    const bad: string[] = [];
    for (const c of all) SM.maxTrackError(c, SM.trackFor(c, 1)).forEach((e, i) => { if (e > c.tol[i] + 1e-9) bad.push(`${c.name}[${i}] ${e.toFixed(4)}>${c.tol[i]}`); });
    ok(`标题组通道（${kind}）：位姿 / 淡出 / 光晕与纯色层 / 逐字平移逐点对拍都在容限内`, bad.length === 0, bad.join('; '));
    let worst = 0;
    for (let i = 0; i <= 200; i++) {
      const tr = (dur * i) / 200;
      const st = TR.trState('night', kind, tr);
      const g = TR.titleGroupAt(grp, st.title);
      const p1 = t.h1Tf.truth(tr);
      worst = Math.max(worst, Math.abs(p1[0] - g.h1Flip.x), Math.abs(p1[1] - g.h1Flip.y), Math.abs(p1[2] - g.h1Flip.s) * 100);
      const f2 = TR.flipTo(enBox, enSrc, g.enRect);
      const p2 = t.enTf.truth(tr);
      worst = Math.max(worst, Math.abs(p2[0] - f2.x), Math.abs(p2[1] - f2.y), Math.abs(p2[2] - f2.s) * 100);
      // letter-spacing 的收拢：第 i 个字母相对原位移 i · (ls(p) − ls0) · 字号 —— 与 legacy 写 letterSpacing 之后的排版一致（字距只在字与字之间累加）
      const ls = BM.lerp(0.42, 0.3, st.title);
      t.enLetter.forEach((c, k) => { worst = Math.max(worst, Math.abs(c.truth(tr)[0] - k * (ls - 0.42) * 31)); });
      worst = Math.max(worst, Math.abs(t.h1Char.truth(tr)[0] - (BM.lerp(0.24, 0.04, st.title) - 0.24) * 132));
      worst = Math.max(worst, Math.abs(t.halo.truth(tr)[0] - (1 - st.tint)) * 1000, Math.abs(t.flat.truth(tr)[0] - st.tint) * 1000, Math.abs(t.out.truth(tr)[0] - (1 - st.titleOut)) * 1000);
    }
    ok(`标题组通道（${kind}）：真值与 legacy 的公式一致（titleGroupAt、letterSpacing 的 lerp、tint、titleOut）`, worst < 1e-6, worst.toExponential(2));
    ok(`标题组通道（${kind}）：光晕与纯色层同一条曲线（E.inout，原生）；第一个字母 / 第一个字不动（static，不建动画）`, t.halo.kind === 'native' && t.flat.kind === 'native' && t.halo.bezier.join() === E.inout.bezier!.join() && CH.isStatic(t.enLetter[0]) && !CH.isStatic(t.enLetter[1]) && S.tint[1] <= S.titleSwap[1]);
  }
}

// ── 昼的合成器通道（dayComp.ts）：每条通道逐点对拍，并与 legacy 路径那一行样式写入的公式一致 ──
{
  const k = 1.08;                                  // 舞台缩放（H / 1000）
  const Wv = 1728;
  const boxW = Math.max(1600, Wv / k);
  const arch = { x: 1205, y: 13, w: 700, h: 1054 };
  const stageArch = { x: arch.x / k, y: arch.y / k, w: arch.w / k, h: arch.h / k };
  const fig = { x: 1205 - 463, y: -90, w: 1105, h: 1497 };
  const fit = TR.artFit(k, fig);
  const flwH = 0.17 * stageArch.h;
  const base = (kind: 'full' | 'fast', z0 = 1, mainLeft: number | undefined = 236): DC_.DayCompInput => ({ kind, k, W: Wv, boxW, stageArch, fit, z0, mainLeft, flwH });
  for (const [kind, z0] of [['full', 1], ['fast', 1], ['fast', 1.09]] as const) {
    const inp = base(kind, z0);
    const ch = DC_.dayChannels(inp);
    const dur = TR.trDuration(kind);
    const S = TR.daySegs(kind);
    const geom = DC_.dayGeom(inp);
    const polys: CH.Channel[] = [ch.clip, ch.artSc, ch.figOp, ch.under, ch.underFlw, ch.fog, ch.deco, ch.veilTf, ch.veilInv, ch.veilOn, ch.fo, ch.foAl, ch.shL, ch.shLop, ch.hemHolder, ch.hemInner, ...(ch.zoom ? [ch.zoom] : []),
      ...Object.values(ch.plate ?? {}), ...Object.values(ch.ring!.bars), ...Object.values(ch.ring!.cornersPos), ...Object.values(ch.ring!.cornersShape), ...Object.values(ch.ring!.botPos),
      ...Object.values(ch.stroke!.bars), ...Object.values(ch.stroke!.cornersPos), ...Object.values(ch.stroke!.cornersShape), ...Object.values(ch.stroke!.botPos), ...Object.values(ch.stroke!.botShape!)];
    const nats: CH.Channel[] = [ch.artTr, ch.artOp, ch.flwTy, ch.bgFade, ch.scene, ch.textOut, ch.ambient, ch.bgFlow];
    const all = [...polys, ...nats];
    const bad: string[] = [];
    let worstFrames = 0;
    let worstName = '';
    for (const c of all) {
      const tk = SM.trackFor(c, 1);
      if (tk.length > worstFrames) { worstFrames = tk.length; worstName = c.name; }
      SM.maxTrackError(c, tk, 1200).forEach((e, i) => { if (e > c.tol[i] + 1e-9) bad.push(`${c.name}[${i}] ${e.toFixed(4)}>${c.tol[i]}`); });
    }
    const tag = `${kind}${z0 !== 1 ? ' · 镜头 ' + z0 : ''}`;
    ok(`昼通道（${tag}）：${all.length} 条通道逐点对拍都在容限内`, bad.length === 0, bad.slice(0, 4).join('; '));
    ok(`昼通道（${tag}）：单条通道的关键帧数 < 400（最多的 ${worstName} ${worstFrames}）`, worstFrames < 400, `${worstName} ${worstFrames}`);
    // 窗 polygon：64 个顶点；与 legacy 的 inset(round) 同一个形状（弧上的点离圆心恰好是半径，外接框 = 裁切矩形）
    let polyWorst = 0;
    let vertOk = true;
    for (let i = 0; i <= 120; i++) {
      const tr = (dur * i) / 120;
      const a = geom.at(tr);
      const v = ch.clip.truth(tr);
      if (v.length !== DC_.POLY_LEN) vertOk = false;
      const rt = a.c.rTop;
      const mid = [a.c.l + rt + rt * Math.cos(1.25 * Math.PI), a.c.t + rt + rt * Math.sin(1.25 * Math.PI)];
      polyWorst = Math.max(polyWorst, Math.abs(v[24] - mid[0]), Math.abs(v[25] - mid[1]));
      const xs = v.filter((_, j) => j % 2 === 0);
      const ys = v.filter((_, j) => j % 2 === 1);
      polyWorst = Math.max(polyWorst, Math.abs(Math.min(...xs) - a.c.l), Math.abs(Math.max(...xs) - (boxW - a.c.r)), Math.abs(Math.min(...ys) - a.c.t), Math.abs(Math.max(...ys) - (1000 - a.c.b)));
    }
    ok(`昼通道（${tag}）：窗的 polygon 有 64 个顶点、外接框 = archClip 的裁切矩形、弧上的点在半径上`, vertOk && DC_.POLY_LEN === 128 && polyWorst < 1e-6, polyWorst.toExponential(2));
    // 与 legacy 公式一致
    let worst = 0;
    let hemWorst = 0;
    let shWorst = 0;
    for (let i = 0; i <= 240; i++) {
      const tr = (dur * i) / 240;
      const st = TR.trState('day', kind, tr);
      const a = geom.at(tr);
      const tt = ch.artTr.truth(tr);
      worst = Math.max(worst, Math.abs(tt[0] - (fit.dx / k) * st.art), Math.abs(tt[1] - (fit.dy / k) * st.art));
      worst = Math.max(worst, Math.abs(ch.artSc.truth(tr)[0] - Math.pow(fit.r, st.art)) * 1000);
      worst = Math.max(worst, Math.abs(ch.artOp.truth(tr)[0] - (1 - st.wash)) * 1000);
      worst = Math.max(worst, Math.abs(ch.figOp.truth(tr)[0] - st.figOn * (1 - st.figOut)) * 1000);
      worst = Math.max(worst, Math.abs(ch.under.truth(tr)[0] - st.wash * (1 - st.wOut)) * 1000);
      worst = Math.max(worst, Math.abs(ch.fog.truth(tr)[0] - 0.95 * st.washTop * (1 - st.wOut)) * 1000);
      const m = TR.decoXf(st.art, fit, k);
      const dv = ch.deco.truth(tr);
      worst = Math.max(worst, Math.abs(dv[0] - m.x), Math.abs(dv[1] - m.y), Math.abs(dv[2] - m.a) * 1000);
      worst = Math.max(worst, Math.abs(ch.bgFade.truth(tr)[0] - (1 - st.bg)) * 1000);
      worst = Math.max(worst, Math.abs(ch.scene.truth(tr)[0] - (1 - st.scene)) * 1000, Math.abs(ch.textOut.truth(tr)[0] - (1 - st.textOut)) * 1000, Math.abs(ch.ambient.truth(tr)[0] - (1 - st.ambient)) * 1000, Math.abs(ch.bgFlow.truth(tr)[0] - (1 - st.bgF)) * 1000);
      // 窗左缘的薄纱：translateX = 裁切框的左缘、scaleX = 软边宽度 / VEIL_W（至少 VEIL_FW_MIN）；内层 scaleX(1 / s) translateX(−l)（向量 [1 / s, l]）与外层相乘 = 恒等（钉在屏幕上）
      const vt = ch.veilTf.truth(tr);
      const vi = ch.veilInv.truth(tr);
      worst = Math.max(worst, Math.abs(vt[0] - a.c.l), Math.abs(vi[1] - a.c.l), Math.abs(vt[1] * vi[0] - 1));
      // 底板：纸面前缘 = paperEdge(窗左缘, 0, winL)
      const xe = TR.paperEdge(geom.scrLeft(tr), 0, st.winL);
      const pl = ch.plate!;
      worst = Math.max(worst, Math.abs(pl.body.truth(tr)[0] - xe));
      // 窗台：持有者右缘 = 窗右缘、内层条左缘 = 窗左缘（纹理原点）
      const r = a.r;
      worst = Math.max(worst, Math.abs(ch.hemHolder.truth(tr)[0] + DC_.BAR_LEN - (r.x + r.w)), Math.abs(ch.hemHolder.truth(tr)[0] + ch.hemInner.truth(tr)[0] - r.x));
      // 轮廓的不透明度：frame.opacity = sstep(winL) · (1 − wOut) · gate
      const wr = TR.stageToScreen(r, a.zw, [1060, 640], k);
      // 窗左缘的轻量算法（只算 winL / art 两条缓动，折线采样时要调几千次）与完整的 trState + archClip + stageToScreen 逐点一致
      worst = Math.max(worst, Math.abs(geom.scrLeft(tr) - wr.x), Math.abs(geom.leftStage(tr) - a.c.l), Math.abs(geom.artAt(tr) - st.art));
      const fo = BM.sstep(BM.win(st.winL, 0, 0.12)) * (1 - st.wOut) * BM.sstep(BM.win(1 - wr.w / Wv, 0.15, 0.3));
      worst = Math.max(worst, Math.abs(ch.fo.truth(tr)[0] - fo) * 1000, Math.abs(ch.foAl.truth(tr)[0] - fo * DAY.winEdgeAlpha(geom.speed(tr))) * 1000);
      // 窗台（点状，纹理不透明）：legacy 的轮廓遮罩（窗左缘起 aL、往窗里 WIN_EDGE_SOFT 升到 1）再乘 fo = fo·(aL + (1 − aL)·r)；comp = 下层整条（foAl）+ 上层带 0 → 1 渐变遮罩 r（hemTop）叠放 = 1 − (1 − b)(1 − u·r)
      {
        const aL = DAY.winEdgeAlpha(geom.speed(tr));
        const b0 = ch.foAl.truth(tr)[0];
        const u0 = ch.hemTop.truth(tr)[0];
        for (const rr of [0, 0.1, 0.3, 0.5, 0.8, 1]) hemWorst = Math.max(hemWorst, Math.abs(1 - (1 - b0) * (1 - u0 * rr) - fo * (aL + (1 - aL) * rr)));
        // 左缘落影条：foAl × 让位系数（窗左缘离终态拱窗左缘的距离 d → shadowHandover）
        shWorst = Math.max(shWorst, Math.abs(ch.shLop.truth(tr)[0] - fo * aL * DC_.shadowHandover(stageArch.x - r.x, 1 / k)));
      }
      // 薄纱：软边宽度 fw = winSoft(速度)；scaleX = √(fw² + VEIL_FW_SOFT²) / VEIL_W（遮罩的渐变宽度 ≈ fw → 窗里的内容从左缘起 fw 宽渐显，与 legacy 的 mask-image 同一个渐变，fw ≫ VEIL_FW_MIN 时一致）；不透明度 = sstep(fw / VEIL_FW_MIN)
      const fw = st.art === 0 ? 0 : DAY.winSoft(geom.speed(tr));
      worst = Math.max(worst, Math.abs(vt[1] - Math.hypot(fw, DC_.VEIL_FW_SOFT) / DC_.VEIL_W) * 1000, Math.abs(ch.veilOn.truth(tr)[0] - BM.sstep(Math.min(1, fw / DC_.VEIL_FW_MIN))) * 1000);
    }
    ok(`昼通道（${tag}）：立绘 / 窗里临时件 / 底板 / 薄纱 / 轮廓不透明度 / 淡出的真值与 legacy 的公式一致（archClip、decoXf、paperEdge、winSoft、winEdgeAlpha…）`, worst < 1e-6, worst.toExponential(2));
    ok(`昼通道（${tag}）：窗台左缘渐隐——真值上，下层（foAl）+ 上层（hemTop × 静态 0 → 1 渐变）叠起来 = legacy 的 fo·(aL + (1 − aL)·r)，各 r 处误差 < 0.5 / 255（分母的平滑量 HEM_EPS = ${DC_.HEM_EPS}）；落影条 = foAl × 让位系数`, hemWorst < 0.5 / 255 && shWorst < 1e-6, `${hemWorst.toExponential(2)} ${shWorst.toExponential(2)}`);
    {
      // 采样之后的关键帧：u 本身（hemTop）在窗减速到 aL = 1 的那几毫秒里掉得很陡（折线守不住 u 自己的 0.5 / 255 容限，所以它不在上面逐点对拍的清单里），但那里 1 − b 几乎是 0，对叠放结果几乎没有影响——
      // 要看的是叠放结果（下层 + 上层的采样轨道）对 legacy 的误差：1 / 255 以内（下层与上层各自的采样误差之和）
      const tkB = SM.trackFor(ch.foAl, 1);
      const tkU = SM.trackFor(ch.hemTop, 1);
      let aw = 0;
      for (let i = 0; i <= 4800; i++) {
        const tr = (dur * i) / 4800;
        const b = SM.evalTrack(tkB, tr / dur)[0];
        const u = SM.evalTrack(tkU, tr / dur)[0];
        const fo = ch.fo.truth(tr)[0];
        const aL = DAY.winEdgeAlpha(geom.speed(tr));
        for (const rr of [0.1, 0.3, 0.5, 0.8, 1]) aw = Math.max(aw, Math.abs(1 - (1 - b) * (1 - u * rr) - fo * (aL + (1 - aL) * rr)));
      }
      ok(`昼通道（${tag}）：窗台采样后的关键帧（下层 ${tkB.length} + 上层 ${tkU.length}）叠起来对 legacy 的误差 < 1 / 255，关键帧数 < 400`, aw < 1 / 255 && tkU.length < 400, `${(aw * 255).toFixed(3)} 级`);
    }
    ok(`昼通道（${tag}）：立绘的平移 / 窗左缘的薄纱 / 各淡出是原生缓动（零采样误差）；窗 / 缩放是折线`, [ch.artTr, ch.artOp, ch.bgFade, ch.flwTy, ch.scene].every((c) => c.kind === 'native') && ch.clip.kind === 'poly' && ch.artSc.kind === 'poly' && SM.trackFor(ch.artTr, 1).length <= 4);
    ok(`昼通道（${tag}）：tr = 0 时窗是整个窗口、立绘 / 光环不动、轮廓与落影不可见（与开屏定格帧一致）`, (() => {
      const v = ch.clip.truth(0);
      const xs = v.filter((_, j) => j % 2 === 0);
      const ys = v.filter((_, j) => j % 2 === 1);
      return Math.min(...xs) === 0 && Math.max(...xs) === boxW && Math.min(...ys) === 0 && Math.max(...ys) === 1000 && ch.artTr.truth(0)[0] === 0 && ch.artSc.truth(0)[0] === 1 && ch.fo.truth(0)[0] === 0 && ch.veilOn.truth(0)[0] === 0 && ch.under.truth(0)[0] === 0;
    })());
    ok(`昼通道（${tag}）：窗落定（tr = 总长）时 = 拱窗（裁切矩形 = stageArch、立绘落位 = fit、花海条贴窗底边）`, (() => {
      const a = geom.at(dur);
      return Math.abs(a.c.l - stageArch.x) < 1e-6 && Math.abs(a.c.t - stageArch.y) < 1e-6 && Math.abs(boxW - a.c.r - (stageArch.x + stageArch.w)) < 1e-6 && Math.abs(1000 - a.c.b - (stageArch.y + stageArch.h)) < 1e-6
        && Math.abs(ch.artSc.truth(dur)[0] - fit.r) < 1e-9 && Math.abs(ch.flwTy.truth(dur)[0] - (stageArch.y + stageArch.h - flwH)) < 1e-6 && Math.abs(a.c.rTop - stageArch.w / 2) < 1e-6;
    })());
    ok(`昼通道（${tag}）：窗的时间表拐点（win ${S.win.join('–')}、art ${S.art.join('–')}）必取`, [S.win[0], S.win[1], S.art[0], S.art[1]].every((kk) => SM.trackFor(ch.clip, 1).some((p) => Math.abs(p.offset * dur - kk) < 1e-9)));
  }
  // 轮廓分件：几何与 legacy 的 .ring（窗外 4.5–6 px、下角 22 px）/ 1 px 内描边一致
  {
    const inp = base('full');
    const ch = DC_.dayChannels(inp);
    const g = DC_.dayGeom(inp);
    const u = 1 / k;
    let worst = 0;
    for (let i = 0; i <= 120; i++) {
      const tr = (1.2 * i) / 120;
      const a = g.at(tr);
      const bl = ch.ring!.bars.L.truth(tr);
      worst = Math.max(worst, Math.abs(bl[0] - (a.r.x - 6 * u)), Math.abs(bl[1] - (a.r.y + a.c.rTop)));
      const yEnd = bl[1] + bl[3] * DC_.BAR_LEN;
      worst = Math.max(worst, Math.abs(yEnd - (a.r.y + a.r.h + 6 * u - 22 * u)));
      const tl = ch.ring!.cornersPos.TL.truth(tr);
      worst = Math.max(worst, Math.abs(tl[0] + DC_.CORNER_BOX - (a.r.x + a.c.rTop)), Math.abs(tl[1] + DC_.CORNER_BOX - (a.r.y + a.c.rTop)));
      const sh = ch.ring!.cornersShape.TL.truth(tr);
      worst = Math.max(worst, Math.abs(Math.hypot(sh[0] - DC_.CORNER_BOX, sh[1] - DC_.CORNER_BOX) - (a.c.rTop + 6 * u)));
      const sr = ch.stroke!.bars.R.truth(tr);
      worst = Math.max(worst, Math.abs(sr[0] - (a.r.x + a.r.w - u)));
    }
    ok('昼通道：窗的轮廓分件（白框 / 描边的直边、上圆角）的几何与 legacy 的 .ring / 内描边一致', worst < 1e-6, worst.toExponential(2));
  }
  // 蝶（昼）：容器位姿 / 翅 / 足逐点对拍，与 legacy 的 placeBf 公式一致
  {
    const rr = { x: 40, y: 60, w: 28, h: 28 };
    const brand = TR.brandGoal(rr);
    const start: TR.BfPose = { x: 420, y: 230, w: 66 * 1.5 * k, rot: -0.1, flap: 0.95, alpha: 1 };
    const path = TR.flightPath([start.x, start.y], [brand.x, brand.y], 1);
    for (const kind of ['full', 'fast'] as const) {
      const bc = DC_.dayBfChannels({ kind, start, goal: brand, path, fold0: 1 });
      const dur = TR.trDuration(kind);
      const bad: string[] = [];
      for (const c of [bc.pose, bc.alpha, bc.wingL, bc.wingR, bc.legs]) SM.maxTrackError(c, SM.trackFor(c, 1), 1200).forEach((e, i) => { if (e > c.tol[i] + 1e-9) bad.push(`${c.name}[${i}] ${e.toFixed(4)}>${c.tol[i]}`); });
      ok(`昼蝶通道（${kind}）：位姿 / 不透明度 / 左右翅 / 足逐点对拍都在容限内`, bad.length === 0, bad.join('; '));
      let worst = 0;
      for (let i = 0; i <= 200; i++) {
        const tr = (dur * i) / 200;
        const st = TR.trState('day', kind, tr);
        const p = TR.bfFlight(start, brand, path, st.fly, st.flap, tr);
        const q = 1 - BM.sstep(BM.win(st.fly, 0, 0.35));
        const fl = Math.max(0.04, p.flap);
        const wl = bc.wingL.truth(tr);
        const wr2 = bc.wingR.truth(tr);
        worst = Math.max(worst, Math.abs(bc.pose.truth(tr)[3] - p.w / 66) * 100, Math.abs(wl[0] + 12 * q), Math.abs(wl[1] - BM.lerp(1, 0.92, q) * fl) * 100, Math.abs(wr2[0] + 52 * q), Math.abs(wr2[1] - fl) * 100, Math.abs(bc.legs.truth(tr)[0] - q * q) * 1000, Math.abs(bc.alpha.truth(tr)[0] - p.alpha * (1 - st.swapOut)) * 1000);
      }
      ok(`昼蝶通道（${kind}）：翅的 rotate / scaleX、足的不透明度与 legacy 的 placeBf 公式一致；落到品牌标上时位置 = brandGoal`, worst < 1e-6 && (() => { const t = bc.pose.truth(TR.daySegs(kind).fly[1]); return Math.abs(t[0] - brand.x) < 0.01 && Math.abs(t[1] - brand.y) < 0.01; })(), worst.toExponential(2));
    }
  }
  ok('昼通道：没有主栏左缘 → 不拆底板（没有 plate 通道）；镜头在 1 → 没有世界层缩放通道；被打断时镜头 > 1 → 有', !DC_.dayChannels({ ...base('full', 1), mainLeft: undefined }).plate && !DC_.dayChannels(base('full', 1)).zoom && !!DC_.dayChannels(base('fast', 1.08)).zoom);
  {
    const cm = DC_.dayCommonChannels('full');
    ok('昼淡出工厂：起点不透明度 ≤ 0 不建通道；scene / textOut 是 E.ease 的原生缓动，ambient 是线性', cm.fade('scene', 0) === undefined && cm.fade('scene', 0.5)?.kind === 'native' && (cm.fade('scene', 0.5) as CH.NativeChannel).bezier.join() === E.ease.bezier!.join() && (cm.fade('ambient', 1) as CH.NativeChannel).bezier.join() === '0,0,1,1');
  }
  // ── 昼 · 底板位图的淡出 / 上下圆角的弧（画布里画）/ 标题组通道（折叠了整体淡出）──
  for (const kind of ['full', 'fast'] as const) {
    const inp = base(kind, 1);
    const ch = DC_.dayChannels(inp);
    const geom = DC_.dayGeom(inp);
    const dur = TR.trDuration(kind);
    const u = 1 / k;
    let wArc = 0;
    let wBot = 0;
    const SB = 40 * u;
    for (let i = 0; i <= 240; i++) {
      const tr = (dur * i) / 240;
      const a = geom.at(tr);
      wArc = Math.max(wArc, Math.abs(ch.rtAt(tr) - a.c.rTop), Math.abs(ch.rbAt(tr) - a.c.rBot));
      // 描边下角：画布里的弧（圆心 (SB, 0) / (0, 0)、中线半径 rb − 0.5u、线宽 u）与 polygon 版的带（外 rb、内 rb − u）同一个形状
      const rb = ch.rbAt(tr);
      const bl = ch.stroke!.botShape!.BL.truth(tr);
      const br = ch.stroke!.botShape!.BR.truth(tr);
      wBot = Math.max(wBot, Math.abs(Math.hypot(bl[0] - SB, bl[1]) - rb), Math.abs(Math.hypot(br[0], br[1]) - rb));
    }
    ok(`昼（${kind}）：rtAt / rbAt = 窗的上 / 下圆角半径`, wArc < 1e-9, wArc.toExponential(2));
    ok(`昼（${kind}）：描边下角的画布弧与 polygon 版的带同半径`, wBot < 1e-6, wBot.toExponential(2));
  }
  {
    const u = 1 / 1.08;
    const arcs = DC_.cornerArcs(100, u);
    ok('昼：上圆角的弧 = 白框（外 6 / 内 4.5）+ 描边（外 0 / 内 −1）两条带的中线与线宽', arcs.length === 2 && Math.abs(arcs[0].r - (100 + 5.25 * u)) < 1e-9 && Math.abs(arcs[0].w - 1.5 * u) < 1e-9 && Math.abs(arcs[1].r - (100 - 0.5 * u)) < 1e-9 && Math.abs(arcs[1].w - u) < 1e-9);
  }
  for (const kind of ['full', 'fast'] as const) {
    const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });
    const grp = { h1Box: rect(100, 300, 400, 120), h1Src: rect(100, 310, 380, 100), h1Dst: rect(40, 20, 120, 40), enSrc: rect(100, 420, 300, 40), enDst: rect(40, 64, 90, 14) };
    const t = DC_.dayTitleChannels({ kind, k: 1.08, grp, h1Box: grp.h1Box, enBox: rect(100, 420, 300, 40), enSrc: grp.enSrc, lsH1: 0, lsEn: 0, nameLS: 2, subLS: 4, fsH1: 100, fsEn: 40, letters: 6 });
    const all: CH.Channel[] = [t.h1Tf, t.enTf, t.aOut, t.halo, t.flat, t.h1Char, ...t.enLetter];
    const bad: string[] = [];
    for (const c of all) SM.maxTrackError(c, SM.trackFor(c, 1), 1200).forEach((e, i) => { if (e > c.tol[i] + 1e-9) bad.push(`${c.name}[${i}] ${e.toFixed(4)}>${c.tol[i]}`); });
    ok(`昼标题组通道（${kind}）：${all.length} 条通道逐点对拍都在容限内`, bad.length === 0, bad.slice(0, 3).join('; '));
    const dur = TR.trDuration(kind);
    let worst = 0;
    for (let i = 0; i <= 240; i++) {
      const tr = (dur * i) / 240;
      const st = TR.trState('day', kind, tr);
      worst = Math.max(worst, Math.abs(t.aOut.truth(tr)[0] - (1 - st.titleOut)), Math.abs(t.halo.truth(tr)[0] - (1 - st.tint) * (1 - st.titleOut)), Math.abs(t.flat.truth(tr)[0] - st.tint * (1 - st.titleOut)));
    }
    ok(`昼标题组通道（${kind}）：整体淡出折进光晕 / 纯色层——a 层 = 1 − titleOut、光晕 = (1 − tint)(1 − titleOut)、纯色 = tint(1 − titleOut)`, worst < 1e-9, worst.toExponential(2));
  }
  const noC = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const dsrc = (f: string) => noC(readFileSync(join(process.cwd(), 'src/components/decor/boot', f), 'utf8'));
  const dtr = dsrc('dayTrComp.ts');
  ok('昼的 comp 路径：窗是 clip-path:polygon 的 WAAPI（不再写 inset(round)）、软边不再写 mask-image、底板遮罩不再逐拍写（三份拷贝平移）、落影不再有画布、蝶是 HTML 小层', !/archClipCss|setProperty\('mask-image'|shadowCv/.test(dtr) && /boot__sveil/.test(dtr) && /boot__ph--ramp/.test(dtr) && /boot__dbf/.test(dtr) && /chw\.clip/.test(dtr));
  {
    // ── 开屏段（P4）：枝的烘焙 / 开屏层的合成层提升 / 应用「偷看」预热 ──
    const ds = dsrc('dayScene.ts');
    ok('昼 · 枝的烘焙：主体（.bd-twbody）烘成位图、逐拍在小画布里画 7 条带虚线的描边当遮罩（destination-in）；只在 comp + 实时（或 ?twigbake）里做，失败 / 未就绪走 SVG 老路径',
      /destination-in/.test(ds) && /setLineDash\(\[p \* b\.lens\[i\], 4 \* b\.lens\[i\]\]\)/.test(ds) && /mg\.lineWidth = 30/.test(ds) && /bootImpl\(\) === 'comp' && \(!o\.capture \|\| twForce\)/.test(ds) && /if \(!tw\) \{/.test(ds) && /\.s0-twc/.test(ds) && /\.s0-twc/.test(dtr));
    // 分支的显现进度与 SVG 路径同一个公式（主干 gp；枝 i 的 attach[i] 起、0.28 的长度，最后一根 0.16）
    ok('昼 · 枝的烘焙：遮罩路径 i 的进度 = SVG 路径的公式（mask 下标 i ↔ 枝 i − 1，起点 TWIG.attach、窗口 TWIG.win 两处共用）', /clamp\(\(gp - TWIG\.attach\[i - 1\]\) \/ TWIG\.win\[i - 1\]\)/.test(ds) && /clamp\(\(gp - TWIG\.attach\[i\]\) \/ TWIG\.win\[i\]\)/.test(ds));
    const css = readFileSync(join(process.cwd(), 'src/styles/boot.css'), 'utf8');
    ok('昼 · 开屏里 JS 每拍写 transform / opacity 的层有 will-change（近景 / 蝶缩放 / 雪点），转场里的叠层不再整层重栅格', /\.boot--day \.bd-near1, \.boot--day \.bd-near2, \.boot--day \.bd-bfzoom \{ will-change: transform; \}/.test(css) && /\.boot--day \.bd-snow > i \{ will-change: transform, opacity; \}/.test(css));
    const sm = dsrc('sampler.ts');
    ok('升档（retier）重建动画分块做：每块 ≤ 4 ms、其余留给下一个 rAF，新一次升档 / 结束时作废旧的链（不再有一个 40–60 ms 的主线程任务砸在转场中间）', /RETIER_SLICE_MS = 4/.test(sm) && /requestAnimationFrame\(step\)/.test(sm) && /tok !== this\.retierTok/.test(sm) && /end\(\): void \{[^}]*?this\.retierTok\+\+/.test(sm));
    const wm = dsrc('warm.ts');
    ok('昼 · 应用「偷看」预热：开屏舞台（.boot__stage）暂时变成 99.8% 不透明度的渲染通道（Viz 不再把下面的应用剔掉），5 个 rAF 后还原；只在昼', /function peekApp/.test(wm) && /boot--day'\)\) \{ dayProbe = warmDayProbes\(root\); if \(host && !appShown && !noPeek\) peekApp\(host\)/.test(wm) && /\+\+n < frames/.test(wm) && /: 5; \};/.test(wm) && /\.boot__stage\.is-peek \{ opacity: 0\.998;/.test(css));
  }
  ok('昼的 comp 路径：纸面不再逐拍 seek mask-position（dayEntrance.main 在 comp 下直接返回）', /if \(c\.comp && hasWin\) return;/.test(dsrc('transitionDay.ts')));
  {
    // 窗台左缘渐隐：两条叠放的内层条，上层带静态渐变遮罩
    ok('昼 · 窗台：持有者里两条内层条（下层 foAl、上层带 0 → 1 的静态渐变遮罩 + hemTop），渐变宽度 = 轮廓遮罩的软边宽度 WIN_EDGE_SOFT', /dfp dfp-hemi dfp-hemi--hi/.test(dtr) && /mask-image:linear-gradient\(90deg, transparent 0, #000 \$\{WIN_EDGE_SOFT\}px\)/.test(dtr) && /hem\[1\], chw\.foAl/.test(dtr) && /hem\[2\], chw\.hemTop/.test(dtr));
    // 窗的左缘落影条让位：窗边（e = 0）处与静态的终态落影合起来恰是 legacy 的 0.1（0.2 × 一半）；d = 0 全交给静态的，d ≥ 3σ 全开；单调
    const sg = 17;
    const G = (d: number) => 0.5 * DC_.erfc(d / (sg * Math.SQRT2));
    let edgeErr = 0;
    let mono = true;
    let prev = -1;
    for (let d = 0; d <= 160; d += 0.5) {
      const w = DC_.shadowHandover(d, 1);
      edgeErr = Math.max(edgeErr, Math.abs(1 - (1 - 0.2 * G(d)) * (1 - 0.1 * w) - 0.1));
      if (w < prev - 1e-12) mono = false;
      prev = w;
    }
    ok('昼 · 左缘落影条让位 w(d)：窗边处与静态的终态落影合起来恰是 legacy 的深度（误差 < 1e-6）；d = 0 → 0、d ≥ 3σ → 1、单调不减', edgeErr < 1e-6 && DC_.shadowHandover(0, 1) === 0 && DC_.shadowHandover(3 * sg, 1) > 0.985 && mono && DC_.shadowHandover(-5, 1) === 0, `${edgeErr.toExponential(2)} ${DC_.shadowHandover(3 * sg, 1).toFixed(4)}`);
    ok('erfc（Abramowitz–Stegun）：erfc(0) = 1、erfc(1) ≈ 0.157299、erfc(−1) = 2 − erfc(1)', Math.abs(DC_.erfc(0) - 1) < 2e-7 && Math.abs(DC_.erfc(1) - 0.15729921) < 2e-7 && Math.abs(DC_.erfc(-1) - (2 - DC_.erfc(1))) < 1e-12);
    // 品牌标「亮一次」的光晕克隆：峰值压到 0.55（满不透明时亮度约为 legacy 的 2 倍）
    ok('品牌标「亮一次」（comp）：光晕克隆的峰值不透明度 HALO_PEAK ∈ [0.5, 0.6]，关键帧用它', TR.HALO_PEAK >= 0.5 && TR.HALO_PEAK <= 0.6 && /opacity: String\(HALO_PEAK\)/.test(dsrc('transition.ts')));
  }
}

// ── 预加载：缓存按 URL 字符串认，所以列表要与场景里的写法一致 ──
{
  const src = (f: string) => readFileSync(join(process.cwd(), 'src/components/decor/boot', f), 'utf8');
  const night = src('nightScene.ts');
  const day = src('dayScene.ts');
  const nightLoads = [...night.matchAll(/loadImg\(P\('([^']+)'\)\)/g)].map((m) => `boot/${m[1]}`);
  const dayStrip = [...day.matchAll(/loadImg\(P\('([^']+)'\)\)/g)].map((m) => `boot/${m[1]}`);
  ok('预加载 · 夜：场景里 loadImg(P(…)) 的每一张都在 NIGHT_IMAGES 里，且一张不多', nightLoads.length === 3 && nightLoads.every((u) => (PRE.NIGHT_IMAGES as readonly string[]).includes(u)) && PRE.NIGHT_IMAGES.length === nightLoads.length, nightLoads.join(','));
  ok('预加载 · 昼：花海条（P(…)）与 splash / figure / flowers 的写法和 DAY_IMAGES 一致', dayStrip.length === 1 && (PRE.DAY_IMAGES as readonly string[]).includes(dayStrip[0])
    && ['splash-official.webp', 'figure-official.webp', 'day-flowers.webp'].every((n) => day.includes('${o.base}art/' + n) && (PRE.DAY_IMAGES as readonly string[]).includes('art/' + n)), dayStrip.join(','));
  ok('预加载：URL = 资源前缀 + 相对路径（与场景里 `${o.base}boot/…` 同一个字符串）；字体清单夜 2 条、昼 3 条', PRE.bootImageUrls('night', './')[0] === './boot/night-base.jpg' && PRE.bootImageUrls('day', './')[0] === './art/splash-official.webp' && PRE.bootFonts('night').length === 2 && PRE.bootFonts('day').length === 3);
  ok('预加载：没有提前加载过的 URL → preloadedImg 为 undefined（loadImg 走老路径）', PRE.preloadedImg('./boot/never.png') === undefined);
  const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('转场不再动画 backdrop-filter 的模糊半径（玻璃保持终态，只淡入自身的 opacity / transform）', !/backdropFilter|blur0/.test(noComments(src('transition.ts'))));
  ok('开屏时钟（player.ts）用节拍器（comp = 调速器模式；legacy 才是 60 fps 封顶），不再有 14 ms 的硬封顶', /new Pacer\(/.test(src('player.ts')) && /bootGovernor/.test(src('player.ts')) && !/FRAME_MIN_MS/.test(src('player.ts')));
  // 昼 · 窗的落影：转场里画在画布上（dayScene.drawShadow），数值要与真拱窗（decor.css 的 .daystage__arch，静态 box-shadow）是同一个——转场末尾两边交叉淡化，落影才对得上；
  // 同时 .boot__archframe 自己不能再带 box-shadow（否则整片模糊每个节拍在整屏大的层上重画一遍——这正是改画布的原因）
  {
    const css = (f: string) => readFileSync(join(process.cwd(), 'src/styles', f), 'utf8');
    const m = /\.daystage__arch\s*\{[^}]*box-shadow:\s*0\s+(\d+)px\s+(\d+)px\s+rgb\((\d+)\s+(\d+)\s+(\d+)\s*\/\s*([\d.]+)\)/.exec(css('decor.css'));
    const rgba = m ? `rgba(${m[3]}, ${m[4]}, ${m[5]}, ${Number(m[6])})` : '';
    ok('昼 · 窗的落影（画布）与真拱窗的 box-shadow 是同一个：偏移 / 模糊 / 颜色', !!m && Number(m[1]) === DAY.SHADOW_DY && Number(m[2]) === DAY.SHADOW_BLUR && rgba === DAY.SHADOW_RGBA, `decor.css: ${m ? m[0].slice(-60) : '没找到'}；场景: 0 ${DAY.SHADOW_DY}px ${DAY.SHADOW_BLUR}px ${DAY.SHADOW_RGBA}`);
    const bootCss = css('boot.css');
    const frameRule = /\.boot--day \.boot__archframe\s*\{[^}]*\}/.exec(bootCss);
    ok('昼 · .boot__archframe 自己没有 box-shadow（落影在画布里）；落影画布有版式规则', !!frameRule && !/box-shadow/.test(frameRule[0].replace(/\/\*[\s\S]*?\*\//g, '')) && /\.boot__archshadow\s*\{/.test(bootCss));
    ok('昼 · 落影画布的余量 ≥ 3σ + 偏移（σ = 模糊半径 / 2），低分辨率倍数 ≥ 1', DAY.SHADOW_PAD >= (3 * DAY.SHADOW_BLUR) / 2 + DAY.SHADOW_DY && DAY.SHADOW_LOWRES >= 1);
  }
  // 夜 · 「栖枝」的 h1 带三层 drop-shadow（filter，24 / 34 px 的大模糊）：字全透明的时候它也是一个渲染通道，合成器每帧对一块空白跑三遍模糊（离屏冻结帧里单独占 2–4 ms，
  // 夜 fast 出帧 193 → 232 fps、夜开屏 147 → 217 fps 的差别就是它）。comp 里：开屏 5.6 s（字开始浮现）之前关掉；转场里不带着走的标题（被打断时还没浮现）字淡到不可见就关掉。
  ok('夜 · comp：字浮现之前（t < T0）h1 的 filter 关掉，浮现的第一拍还给样式表', /if \(comp\) el\.h1\.style\.filter = t < T0 \? 'none' : ''/.test(night));
  ok('夜 · comp：转场里不带着走的标题，字不可见时 h1 的 filter 关掉（可见时还给样式表）', /if \(comp\) h1\.style\.filter = chBase\.some\(\(b\) => b\.op \* \(1 - st\.ambient\) > 0\.004\) \? '' : 'none'/.test(night));
  // 夜 · 标题的光晕层（预烘焙叠层）：原 h1 是三层 drop-shadow 的串联，第三层的紫光是对「字 + 前两层暗影」整块的影子，并列的 text-shadow 照搬参数会偏暗（标题框 −1.3 级）；第三层 50 px / α .62 逼近
  {
    const bootCss = readFileSync(join(process.cwd(), 'src/styles/boot.css'), 'utf8');
    const m = /\.boot__title \.boot__tt-halo \.c \{[^}]*text-shadow:([^;]*);/.exec(bootCss);
    ok('夜 · 标题光晕层：前两层暗影与 h1 的 drop-shadow 同参数（2px 2px α.85、24px α.8），第三层紫光 50 px / α .62（逐帧对拍标定）', !!m && /0 2px 2px rgb\(8 6 22 \/ 0\.85\)/.test(m[1]) && /0 0 24px rgb\(8 6 22 \/ 0\.8\)/.test(m[1]) && /0 0 50px rgb\(134 92 152 \/ 0\.62\)/.test(m[1]), m ? m[1] : '没找到');
  }
  ok('开屏 / 转场画布的渲染像素比上限 ≤ 1.25（底图只有 2560 宽，1.5 倍不会更清楚）', BOOT_MAX_DPR <= 1.25 && /BOOT_MAX_DPR/.test(night) && /BOOT_MAX_DPR/.test(day) && !/Math\.min\(dpr \|\| 1, 1\.5/.test(night + day));
}

// ── 启动时同步读偏好（lib/earlyBoot.ts）：主题在页面最早的地方就对，不先闪夜色 ──
{
  const store = (m: Record<string, string>) => ({ getItem: (k: string) => (k in m ? m[k] : null) });
  ok('readEarlyPrefs：自己的偏好里 mode=day / bootAnimation=false', JSON.stringify(readEarlyPrefs(store({ 'alight/prefs': JSON.stringify({ settings: { mode: 'day', bootAnimation: false } }) }))) === JSON.stringify({ mode: 'day', bootAnimation: false }));
  ok('readEarlyPrefs：没有自己的偏好时看萤火的（sam → day、firefly → night）', readEarlyPrefs(store({ 'firefly-harness/prefs': JSON.stringify({ settings: { mode: 'sam' } }) })).mode === 'day' && readEarlyPrefs(store({ 'firefly-harness/prefs': JSON.stringify({ settings: { mode: 'firefly' } }) })).mode === 'night');
  ok('readEarlyPrefs：自己的偏好存在时不看萤火的；自己的偏好里写 sam 不认（只有萤火的才映射）', readEarlyPrefs(store({ 'alight/prefs': JSON.stringify({ settings: {} }), 'firefly-harness/prefs': JSON.stringify({ settings: { mode: 'sam' } }) })).mode === undefined && readEarlyPrefs(store({ 'alight/prefs': JSON.stringify({ settings: { mode: 'sam' } }) })).mode === undefined);
  ok('readEarlyPrefs：没有 / JSON 坏了 / 存储会抛 → 全是 undefined，不抛错', (() => {
    const bad = { getItem: () => { throw new Error('denied'); } };
    const a = readEarlyPrefs(store({}));
    const b = readEarlyPrefs(store({ 'alight/prefs': '{oops' }));
    const c = readEarlyPrefs(bad);
    return [a, b, c].every((x) => x.mode === undefined && x.bootAnimation === undefined);
  })());
}

// ── 落雪时限 ──
ok('fallIntensity：2 分钟内满强度', fallIntensity(0) === 1 && fallIntensity(FALL_FULL_MS) === 1 && fallIntensity(60_000) === 1);
ok('fallIntensity：2 分钟之后 20 秒内线性降到 0', near(fallIntensity(FALL_FULL_MS + FALL_FADE_MS / 2), 0.5) && fallIntensity(FALL_FULL_MS + FALL_FADE_MS) === 0 && fallIntensity(10 * 60_000) === 0);
ok('fallIntensity：下降单调', Array.from({ length: 41 }, (_, i) => fallIntensity(FALL_FULL_MS + i * 500)).every((v, i, a) => i === 0 || v <= a[i - 1]));
ok('时限常量：2 分钟 / 20 秒 / 失焦 15 秒', FALL_FULL_MS === 120_000 && FALL_FADE_MS === 20_000 && BLUR_GRACE_MS === 15_000);

// ── 0.1.4 · 昼开屏锁 120：调速器的锁定档 / tick 判据 / relaxOnce、绽开蒙版的层列表（对 0.1.3 快照）、光束的 transform 写法、渲染路径 ──
{
  const ms = (hz: number) => 1000 / hz;
  const src = (f: string) => readFileSync(join(process.cwd(), 'src/components/decor/boot', f), 'utf8');
  const noComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  PC.resetLearnedRefresh();

  // ① 锁定档位下限：刷新率 → divisor
  {
    const at = (hz: number, discrete = false) => { const g = new GOV.Governor(); g.setDiscrete(discrete); g.setLock(120); g.setRefresh(ms(hz)); return g.divisor; };
    const got = [60, 120, 144, 165, 180, 240, 360, 480].map((h) => at(h));
    ok('锁 120：刷新率 60 / 120 / 144 / 165 / 180 → 1（每个刷新都画）、240 → 2、360 → 3、480 → 4', got.join() === '1,1,1,1,1,2,3,4', got.join());
    ok('锁 120：独显 240 Hz 仍是 4（约 60 次/秒的保护档不被 lockFloor 降级）；独显 144 / 120 → 2；独显 60 → 1', at(240, true) === 4 && at(144, true) === 2 && at(120, true) === 2 && at(60, true) === 1, `${at(240, true)},${at(144, true)},${at(120, true)},${at(60, true)}`);
    const g0 = new GOV.Governor(); g0.setRefresh(ms(240));
    ok('没锁（lock 未设）时 lockFloor 恒为 1：集显 240 Hz 的 divisor 与 0.1.3 一样从 1 起；刷新间隔未知时 lockFloor 也是 1（先走 Pacer 的时间门限）', g0.divisor === 1 && g0.lockFloor === 1 && (() => { const g = new GOV.Governor(); g.setLock(120); return g.lockFloor === 1; })());
    const gl = new GOV.Governor(); gl.setLock(120); gl.setRefresh(ms(240)); gl.carryOver();
    ok('carryOver() 清掉 lock（转场的行为与 0.1.3 逐字一致）：lockHz = undefined、lockFloor = 1、divisor 回到 1；reset() 同样', gl.lockHz === undefined && gl.lockFloor === 1 && gl.divisor === 1 && (() => { const g = new GOV.Governor(); g.setLock(120); g.setRefresh(ms(240)); g.reset(); return g.lockHz === undefined && g.divisor === 1; })());
  }

  // ② 节拍器 + 锁定：各刷新率下每秒出图次数与均匀度
  {
    const sim = (hz: number, discrete: boolean, seconds = 3, lock = 120) => {
      PC.resetLearnedRefresh();
      const g = new GOV.Governor();
      g.setDiscrete(discrete);
      if (lock) g.setLock(lock);
      const p = new PC.Pacer({ governor: g });
      let now = performance.now() + 5000;
      const draws: number[] = [];
      const n = Math.round(seconds * hz);
      for (let i = 0; i < n; i++) { now += ms(hz); if (p.due(now)) { draws.push(now); p.cost(0.4); } }
      const t0 = draws[0] + 500;                                   // 头 0.5 s 是热身（量刷新间隔前的几拍走时间门限）
      const ds = draws.filter((d) => d >= t0);
      const iv = ds.slice(1).map((d, i) => d - ds[i]);
      return { rate: (ds.length - 1) / ((ds[ds.length - 1] - ds[0]) / 1000), iv, g, draws };
    };
    const r = (hz: number, d = false) => sim(hz, d);
    const row = [60, 120, 144, 165, 240].map((h) => Math.round(r(h).rate));
    ok('锁 120 的节拍：60 Hz → 60 次/秒、120 → 120、144 → 144、165 → 165、240 → 120（集显，每个刷新画 / 每两个刷新画）', row.join() === '60,120,144,165,120', row.join());
    const dd = r(240, true);
    ok('独显 240 Hz 仍约 60 次/秒（divisor 4），不唤醒更高的节拍', Math.abs(dd.rate - 60) < 1.5, dd.rate.toFixed(1));
    const a = r(240);
    ok('240 Hz 锁 120：节拍间隔恒为 8.33 ms（不混 4.17 / 12.5 / 16.7），全程没有升档（raised = 0）', a.iv.length > 200 && a.iv.every((d) => Math.abs(d - 2 * ms(240)) < 0.05) && a.g.raised === 0 && a.g.divisor === 2, `${Math.min(...a.iv).toFixed(2)}–${Math.max(...a.iv).toFixed(2)}，raised ${a.g.raised}，档位 ${a.g.divisor}`);
    // 刷新间隔还没量到的头几拍：时间门限 = 目标节拍间隔的 90%（7.5 ms）——240 Hz 不会前几拍每个刷新都画
    const w = a.draws.slice(0, 6).map((d, i, xs) => (i ? d - xs[i - 1] : 0)).slice(1);
    ok('240 Hz 锁 120：热身那几拍（刷新间隔未知）也走 ≥ 7.5 ms 的时间门限，没有 4.17 ms 的间隔', w.every((d) => d >= 7.4), w.map((d) => d.toFixed(2)).join());
    const n0 = sim(240, false, 3, 0);
    ok('不锁（夜 / 转场）的节拍器行为不变：240 Hz 每个 rAF 都画', Math.abs(n0.rate - 240) < 2, n0.rate.toFixed(1));
  }

  // ③ 升档判据：lockFloor > 1 时看 tick 间隔（p90 > 1.5 × divisor × 刷新间隔，连续两个窗口），不看 rAF 间隔
  {
    PC.resetLearnedRefresh();
    const mk = () => { const g = new GOV.Governor(); g.setLock(120); g.setRefresh(ms(240)); return g; };
    const feed = (g: GOV.Governor, ivs: number[], cost = 0.5, start = 5000) => {
      let now = start;
      for (const d of ivs) { now += d; g.observeRaf(now); g.observeTick(now); g.observeCost(cost); g.update(now); }
      return now;
    };
    const g1 = mk();
    feed(g1, Array.from({ length: 400 }, () => 2 * ms(240)));
    ok('tick 判据：tick 间隔恒为 8.33 ms（= 2 × 刷新间隔）不升档（原 rAF 判据会把它当「慢」：p90 rAF 间隔 8.33 > 1.5 × 4.17）', g1.divisor === 2 && g1.state().raised === 0, `档位 ${g1.divisor}`);
    const g2 = mk();
    feed(g2, Array.from({ length: 400 }, (_, i) => (i % 16 === 0 ? 3 * ms(240) : 2 * ms(240))));
    ok('tick 判据：偶发一个 12.5 ms 的 tick（每窗口 1 个，p90 = 8.33）不升档', g2.divisor === 2 && g2.state().raised === 0);
    const g3 = mk();
    const t3 = feed(g3, Array.from({ length: 16 }, (_, i) => (i % 2 ? 4 * ms(240) : 2 * ms(240))), 0.5, 5000);          // 一个窗口超线（p90 = 16.7 > 12.5）
    const one = g3.divisor;
    feed(g3, Array.from({ length: 64 }, () => 2 * ms(240)), 0.5, t3);                                                     // 之后恢复正常：不累计
    ok('tick 判据：只有一个窗口超线（随后恢复）不升档；要连续两个窗口', one === 2 && g3.divisor === 2 && g3.state().raised === 0, `${one},${g3.divisor}`);
    const g4 = mk();
    feed(g4, Array.from({ length: 120 }, (_, i) => (i % 2 ? 4 * ms(240) : 2 * ms(240))), 0.5, 5000);
    ok('tick 判据：连续两个窗口 p90 tick 间隔 16.7 ms > 12.5 → 升到 4 档（GPU 背压照样升）', g4.divisor === 4 && g4.state().raised === 1, `档位 ${g4.divisor}`);
    // CPU 判据按 divisor 放宽：每帧 3 ms 在 120 档（预算 4.17 ms）下不升，在 60 档下限（预算 2.08 ms × 1）会升
    const g5 = mk();
    feed(g5, Array.from({ length: 200 }, () => 2 * ms(240)), 3);
    const g6 = new GOV.Governor(); g6.setRefresh(ms(240));
    feed(g6, Array.from({ length: 200 }, () => ms(240)), 3);
    ok('CPU 判据在锁定档下按 divisor 放宽（帧内 3 ms < 0.5 × 2 × 4.17 不升档）；不锁时仍是 0.5 × 刷新间隔（2.08 ms，3 ms 会升）', g5.divisor === 2 && g6.divisor >= 2, `${g5.divisor},${g6.divisor}`);
  }

  // ④ relaxOnce：开屏里被升档的，交班时放回锁定档，且只能一次
  {
    const g = new GOV.Governor(); g.setLock(120); g.setRefresh(ms(240));
    const noop = g.relaxOnce(1000);
    let now = 5000;
    for (let i = 0; i < 120; i++) { now += i % 2 ? 4 * ms(240) : 2 * ms(240); g.observeRaf(now); g.observeTick(now); g.observeCost(0.5); g.update(now); }
    const raised = g.divisor;
    const first = g.relaxOnce(now);
    const back = g.divisor;
    for (let i = 0; i < 200 && g.divisor < 4; i++) { now += i % 2 ? 4 * ms(240) : 2 * ms(240); g.observeRaf(now); g.observeTick(now); g.observeCost(0.5); g.update(now + 700 + i * 20); }
    const second = g.relaxOnce(now + 5000);
    ok('relaxOnce：没被升过档 → false 且不用掉这一次；升到 4 档后 → true 并回到锁定档（2）；之后再升也不再放（每次开屏一次）；reset() 之后又可以', !noop && raised === 4 && first && back === 2 && !second && g.state().relaxed === true && (g.reset(), g.state().relaxed === false), `${noop},${raised},${first},${back},${second}`);
    const gn = new GOV.Governor(); gn.setRefresh(ms(240));
    ok('relaxOnce：没锁（夜 / 转场）时恒为 false，行为不变', gn.relaxOnce(1) === false);
  }

  // ⑤ measureRefresh：8 个 rAF 估出刷新间隔，填 learned 并告诉调速器
  {
    PC.resetLearnedRefresh();
    const gg = globalThis as unknown as Record<string, unknown>;
    const saved = gg.requestAnimationFrame;
    let now = 100;
    gg.requestAnimationFrame = (cb: (t: number) => void) => { now += ms(240); cb(now); return 1; };          // 同步桩：测试脚本一结束就 exit，不能等微任务
    const g = new GOV.Governor();
    void PC.measureRefresh(8, g);
    gg.requestAnimationFrame = saved;
    ok('measureRefresh：8 个 rAF（240 Hz）→ learned = 4.17 ms、调速器的 refreshMs 也是；锁 120 时 lockFloor 一开始就是 2', near(PC.learnedRefresh() ?? 0, ms(240), 1e-9) && near(g.refreshMs ?? 0, ms(240), 1e-9) && (g.setLock(120), g.lockFloor === 2));
    PC.resetLearnedRefresh();
  }

  // ⑥ 绽开蒙版：层列表 → CSS 字符串对 0.1.3 快照逐字相同；撤蒙版时刻；画布路径（径向渐变 source-over 并集）与 CSS 蒙版的 α 等价
  {
    /** 0.1.3（db7176c）dayScene.renderStage 里拼 mask-image 的原代码（逐字快照；只把 RB / FLAT 换成导出的函数）. */
    const headMask = (t: number): string => {
      const RB = DAY.bloomRadius;
      const FLAT = (tt: number) => BM.lerp(DAY.BLOOM_FLAT, 1, DAY.bloomE(win(tt, DAY.DT.bloom[0], DAY.DT.bloom[1])));
      const Rr = RB(t);
      if (Rr >= 1560 || t >= DAY.DT.bloom[1]) return 'none';
      const fea = BM.lerp(DAY.BLOOM_FEATHER_SOFT, DAY.BLOOM_FEATHER[1], E.ease(win(t, DAY.DT.bloom[0], DAY.DT.bloom[1])));
      const layer = (cx: number, cy: number, rx: number, ry: number, a: number, f: number) => {
        const r1 = Math.max(1, rx);
        const r0 = Math.max(0, rx - f);
        return `radial-gradient(${r1.toFixed(1)}px ${Math.max(1, ry).toFixed(1)}px at ${cx.toFixed(1)}px ${cy.toFixed(1)}px, rgba(0,0,0,${a.toFixed(3)}) 0, rgba(0,0,0,${a.toFixed(3)}) ${((r0 / r1) * 100).toFixed(2)}%, rgba(0,0,0,0) 100%)`;
      };
      const alpha = (td: number) => E.ease(win(t - td, 0, 0.15));
      const flat = FLAT(t);
      const out: string[] = [];
      const [cx0, cy0] = DAY.DC.C0;
      out.push(layer(cx0, cy0, Rr, Rr * flat, alpha(DAY.BLOOM_MAIN_DELAY), fea));
      for (const [deg, dist, rad, td0] of DAY.BLOOM_PETALS) {
        const td = td0 + DAY.BLOOM_MAIN_DELAY;
        const R1 = RB(t - td);
        if (t - td <= 0 || R1 < 30) continue;
        const th = (deg * Math.PI) / 180;
        out.push(layer(cx0 + Math.cos(th) * dist * R1, cy0 + Math.sin(th) * dist * R1 * flat, rad * R1, rad * R1 * flat, alpha(td), fea * 0.7));
      }
      for (const [cx, cy, td, kk, fl] of DAY.BLOOM_CENTERS) {
        const R1 = RB(t - td) * kk;
        if (t - td <= 0 || R1 < 30) continue;
        out.push(layer(cx, cy, R1, R1 * BM.lerp(fl, 1, DAY.bloomE(win(t - td, DAY.DT.bloom[0], DAY.DT.bloom[1]))), alpha(td), fea * 0.7));
      }
      return out.join(', ');
    };
    const ts = Array.from({ length: 61 }, (_, i) => i * 0.045).concat([2.6999, 2.7, 2.7001, 3, 5]);
    const same = ts.every((t) => BL.bloomMaskCss(t) === headMask(t));
    ok('bloomMaskCss(t) 对 0.1.3 的 mask-image 字符串逐字相同（t = 0…2.7 s 的 61 个时刻 + 2.7 附近 + 定格后）', same, ts.filter((t) => BL.bloomMaskCss(t) !== headMask(t)).join());
    let h = 0x811c9dc5;
    for (const t of ts.slice(0, 61)) for (const c of headMask(t)) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
    ok('0.1.3 快照的 FNV-1a 哈希（防止对拍用的快照自己漂移）', h === HEAD_MASK_HASH, `0x${h.toString(16)}`);
    ok('bloomLayers 层数 ≤ 10（主圆 1 + 花瓣 6 + 中心 3）；已撤蒙版返回空；第一帧只有一层（α = 0 的主圆）', ts.slice(0, 61).every((t) => BL.bloomLayers(t).length <= 10) && BL.bloomLayers(2.7).length === 0 && BL.bloomLayers(0).length === 1 && BL.bloomLayers(0)[0].a === 0 && BL.bloomLayers(1.2).length === 10);
    let early = false;
    for (let i = 0; i < 2700; i++) if (BL.bloomOpen(i / 1000)) early = true;
    ok('bloomOpen：2.7 s 之前恒为 false（Rr 到 2.7 s 才到 1500，≥ 1560 的条件从不先成立）、2.7 s 起为 true；T_FREE = DT.bloom[1]', !early && !BL.bloomOpen(2.6999) && BL.bloomOpen(2.7) && BL.bloomOpen(5) && BL.T_FREE === DAY.DT.bloom[1] && BL.T_FREE === 2.7);
    // 解析 CSS 字符串里的每个径向渐变，独立求并集 α，对拍 bloomAlphaAt
    const parseCss = (css: string) => [...css.matchAll(/radial-gradient\(([\d.]+)px ([\d.]+)px at ([\d.-]+)px ([\d.-]+)px, rgba\(0,0,0,([\d.]+)\) 0, rgba\(0,0,0,[\d.]+\) ([\d.]+)%/g)].map((m) => ({ r1: +m[1], r2: +m[2], cx: +m[3], cy: +m[4], a: +m[5], p0: +m[6] / 100 }));
    const cssAlpha = (css: string, x: number, y: number) => {
      let keep = 1;
      for (const l of parseCss(css)) { const d = Math.hypot((x - l.cx) / l.r1, (y - l.cy) / l.r2); if (d >= 1) continue; keep *= 1 - l.a * (d <= l.p0 ? 1 : 1 - (d - l.p0) / (1 - l.p0)); }
      return 1 - keep;
    };
    const rnd = mulberry32(5150);
    let worst = 0;
    for (const t of [0.05, 0.15, 0.3, 0.6, 1.0, 1.5, 2.0, 2.5, 2.69]) {
      const layers = BL.bloomLayers(t);
      const css = BL.bloomMaskCss(t);
      for (let i = 0; i < 300; i++) { const x = rnd() * 1700; const y = rnd() * 1000; worst = Math.max(worst, Math.abs(BL.bloomAlphaAt(layers, x, y) - cssAlpha(css, x, y))); }
    }
    ok('画布路径的并集（径向渐变 source-over，1 − Π(1 − αi)）与 CSS 蒙版（mask-composite: add）逐点等价：9 个时刻 × 300 点最大 α 差 < 0.002（只差 CSS 字符串里坐标 / 半径取一位小数）', worst < 0.002, worst.toFixed(5));
    // 1/4 分辨率蒙版的误差：在 1/4 格点上取样、双线性放大，对精确值
    let worstQ = 0;
    const S = 1.6;
    for (const t of [0.1, 0.25, 0.5, 1.0, 1.6, 2.2, 2.6]) {
      const layers = BL.bloomLayers(t);
      const q = 4 / S;                                             // 1/4 分辨率一格 = q 个舞台单位
      const exact = (x: number, y: number) => BL.bloomAlphaAt(layers, x, y);
      const grid = (gx: number, gy: number) => exact((gx + 0.5) * q, (gy + 0.5) * q);       // 蒙版画布像素中心
      for (let i = 0; i < 400; i++) {
        const x = rnd() * 1600; const y = rnd() * 1000;
        const fx = x / q - 0.5; const fy = y / q - 0.5;
        const x0 = Math.floor(fx); const y0 = Math.floor(fy); const ax = fx - x0; const ay = fy - y0;
        const v = grid(x0, y0) * (1 - ax) * (1 - ay) + grid(x0 + 1, y0) * ax * (1 - ay) + grid(x0, y0 + 1) * (1 - ax) * ay + grid(x0 + 1, y0 + 1) * ax * ay;
        worstQ = Math.max(worstQ, Math.abs(v - exact(x, y)));
      }
    }
    ok('1/4 分辨率蒙版画布 + 双线性放大（密度 1.6 px/单位）对精确并集的最大 α 误差 ≤ 0.006（渐变折点处；羽化 ≥ 119 个舞台单位 = 47 个蒙版像素）', worstQ <= 0.006, worstQ.toFixed(5));
    const bb = BL.bloomBox(BL.bloomLayers(0.3));
    ok('bloomBox：包围盒覆盖每个 α > 0 的层（脏矩形不会漏画），第一帧（α = 0）为 null', !!bb && bb.x0 < DAY.DC.C0[0] && bb.x1 > DAY.DC.C0[0] && BL.bloomBox(BL.bloomLayers(0)) === null);
  }

  // ⑦ 光束：transform 写法与 0.1.3 的 left / 渐变 α 等价
  {
    const head = (i: number, t: number) => {
      const fa = E.ease(win(t, 0.1, 1.2)) * (1 - sstep(win(t, DAY.DT.fly[1] - 1.1, DAY.DT.fly[1] + 1.6)));
      const ph = [0.3, 2.1, 4.0][i];
      const w = [150, 210, 120][i];
      const a = [0.16, 0.12, 0.1][i] * fa * (1 + 0.3 * Math.sin((TAU * t) / 14 + ph));
      const cx = 1600 * [0.78, 0.92, 0.64][i] + (12 * t + 30 * Math.sin((TAU * t) / 14 + ph)) * [1, -1, 1][i] * 0.8;
      return { left: cx - w / 2, w, a, on: a > 0.001 };
    };
    let dl = 0; let da = 0; let onOk = true;
    for (let i = 0; i < 3; i++) {
      const b = BL.beamBase(i);
      for (let t = 0; t <= 8; t += 0.05) {
        const h = head(i, t); const f = BL.beamFrame(i, t);
        dl = Math.max(dl, Math.abs(b.left + f.dx - h.left)); da = Math.max(da, Math.abs(f.opacity - h.a)); onOk = onOk && f.on === h.on && b.w === h.w;
      }
    }
    ok('光束：left₀ + dx 与 0.1.3 的 left 差 < 0.25 px、opacity 与原中心 α 差 < 0.5/255、显示 / 隐藏判断与宽度一致（3 道 × t = 0…8 s）', dl < 0.25 && da < 0.5 / 255 && onOk, `${dl.toExponential(2)},${da.toExponential(2)},${onOk}`);
    const d = src('dayScene.ts');
    const code = noComments(d);
    ok('光束的 transform 写成 translate3d(dx,0,0) rotate(31.5deg)（先转后平移：平移在父层坐标系里，与改 left 等价；rotate() translateX() 会差 R·dx）；.beam 自身带 31.5° 的旋转', /translate3d\(\$\{f\.dx\.toFixed\(2\)\}px, 0, 0\) rotate\(\$\{BEAM_ROT\}deg\)/.test(code) && BL.BEAM_ROT === 31.5 && /\.boot--day \.beam \{[^}]*transform: rotate\(31\.5deg\)/.test(readFileSync(join(process.cwd(), 'src/styles/boot.css'), 'utf8')));
    ok('光束的渐变固定成 α = 1 的一条（行内样式只在 setupFast 写一次），每拍只写 transform / opacity / display', /rgba\(255,248,255,1\) 50%/.test(code) && /willChange = 'transform, opacity'/.test(code));
  }

  // ⑧ 渲染路径与结构
  {
    const d = src('dayScene.ts');
    const body = (fn: string) => { const i = d.indexOf(`  function ${fn}(`); const j = d.indexOf('\n  }\n', i); return d.slice(i, j); };
    ok('render() 路径里不再调用 bakeNow（底板在 prepare 里用预解码的位图烘好；失败才由 renderBloom 的 lateBake 退回现烘）；没有 BAKE_AT / bakeTimer', !/bakeNow/.test(body('render')) && !/bakeNow/.test(body('renderStage')) && !/BAKE_AT|bakeTimer/.test(noComments(d)));
    ok('getBake：预烘的底板只在 bk 此刻的不透明度与烘焙时一致才用（被打断得早 → 现烘，与 0.1.3 一致）', /Math\.abs\(bakedOp - bkOpNow\(\)\) < 0\.0015 \? baked : bakeNow\(\)/.test(d));
    const toDom = body('toDom');
    ok('toDom：同一个任务里先把子层还成可见 / 不透明（restoreSubs），再隐藏画布——绝不先隐藏画布（会闪一帧空白）', toDom.indexOf('restoreSubs()') > 0 && toDom.indexOf('restoreSubs()') < toDom.indexOf("visibility = 'hidden'"));
    const st = body('settle');
    ok('settle：先写 t 时刻的 DOM 蒙版字符串（bloomMaskCss），再 toDom，最后才等 2 个 rAF；打断后本次开屏不再回画布（domSettled）', st.indexOf('bloomMaskCss(t)') > 0 && st.indexOf('bloomMaskCss(t)') < st.indexOf('toDom()') && /requestAnimationFrame\(\(\) => requestAnimationFrame/.test(st) && /domSettled = true/.test(st));
    const pt = d.slice(d.indexOf('  function prepareTransition('), d.indexOf('  function prepareTransition(') + 600);
    ok('prepareTransition 一进来先 settle(o.from)（幂等）；转场代码（dayTrComp / prepareTransition 的 DOM）看到的永远是 0.1.3 的 DOM 态', /settle\(o\.from\)/.test(pt));
    const bs = readFileSync(join(process.cwd(), 'src/components/decor/BootSplash.tsx'), 'utf8');
    ok('BootSplash：转场起步前先 scene.settle(out.from)，有 Promise 就等它再 beginTransition；fit() 之后调 scene.prepare()（不 await，不延迟起跳）；挂载时 measureRefresh', /const start = \(\) => \{[\s\S]*beginTransition\(scene, kind[\s\S]*\};[\s\S]*let wait[\s\S]*scene\.settle\?\.\(out\.from\)[\s\S]*wait\.then\(startNow\)/.test(bs) && /void scene\.prepare\?\.\(\)/.test(bs) && /measureRefresh\(8, bootGovernor\)/.test(bs));
    const hd = body('handoff');
    ok('handoff：交班时 relaxOnce 一次；画布与预烘位图 0.5 s 后释放（导出模式不释放：可能往回 seek）', /relaxOnce/.test(hd) && /500\)/.test(hd) && /!o\.capture/.test(hd));
    const pl = src('player.ts');
    ok('player：构造里对调速器模式设锁（lockHzFor），jumpToEnd / 慢机退路 / SLOW_MEAN_MS 不变', /setLock\(lockHzFor\(scene\.theme\)\)/.test(pl) && /SLOW_MEAN_MS = 30/.test(pl) && /jumpToEnd\(\)/.test(pl));
    setBootImpl('comp');
    ok('LOCK_HZ：昼 120、夜默认不锁（真窗口数据说话后再开）；lockHzFor 认 globalThis.__alightLockHz 覆盖', IMPL.lockHzFor('day') === 120 && IMPL.lockHzFor('night') === undefined && (() => { (globalThis as unknown as { __alightLockHz?: unknown }).__alightLockHz = { night: 120 }; const v = IMPL.lockHzFor('night') === 120 && IMPL.lockHzFor('day') === 120; delete (globalThis as unknown as { __alightLockHz?: unknown }).__alightLockHz; return v; })());
    setBootImpl(undefined);
    const gv = src('governor.ts');
    ok('governor：divisor = max(div, floorDivisor, lockFloor, holdFloor, forced())——独显保护档永远优先，lockFloor / holdFloor 只会抬不会降', /Math\.max\(this\.div, this\.floorDivisor, this\.lockFloor, this\.holdFloor, forced\(\)\)/.test(gv));
    {
      // hold：位图没备好、绽开仍走 DOM 蒙版路径时，锁定的 120 不提前生效，节拍按旧的 60 次/秒（discreteFloor）走；撤掉后回到锁定档；reset() / carryOver() 清掉
      const g = new GOV.Governor(); g.setLock(120); g.setRefresh(1000 / 240);
      const d0 = g.divisor; g.setHold(true); const d1 = g.divisor; g.setHold(false); const d2 = g.divisor;
      const g60 = new GOV.Governor(); g60.setLock(120); g60.setHold(true); g60.setRefresh(1000 / 60);
      const gr = new GOV.Governor(); gr.setLock(120); gr.setRefresh(1000 / 240); gr.setHold(true); gr.carryOver();
      const gq = new GOV.Governor(); gq.setHold(true); gq.reset();
      ok('hold：240 Hz 锁 120 → 2；hold 时 → 4（≈ 60 次/秒）；撤掉 → 2；60 Hz hold → 1；carryOver() / reset() 清掉 hold', d0 === 2 && d1 === 4 && d2 === 2 && g60.divisor === 1 && gr.holding === false && gq.holding === false, `${d0},${d1},${d2},${g60.divisor},${gr.holding},${gq.holding}`);
      PC.resetLearnedRefresh();
      const gp = new GOV.Governor(); gp.setLock(120); gp.setHold(true);
      const pp = new PC.Pacer({ governor: gp });
      let tn = performance.now() + 9000; const dr: number[] = [];
      for (let i = 0; i < 3; i++) { tn += ms(240); if (pp.due(tn)) dr.push(tn); }
      ok('hold 且刷新间隔未知：头几拍走 14 ms 的旧时间门限（不是锁定的 7.5 ms）', dr.length === 1, `${dr.length}`);
      PC.resetLearnedRefresh();
    }
    const css = readFileSync(join(process.cwd(), 'src/styles/boot.css'), 'utf8');
    {
      // 实测踩过的坑（离屏测量台 + 无头 Chrome 对拍）：全是源码层面能守住的
      const code = noComments(d);
      const bake = noComments(src('dayBake.ts'));
      const plate = noComments(src('plateBake.ts'));
      ok('.boot canvas { inset: 0; 100% × 100% } 会盖住后挂的画布的 top / bottom：.bd-stripcv 明写 top 与 bottom（内容顶对齐 790 个舞台单位），否则花海条跑到屏幕顶上', /\.bd-stripcv \{[^}]*top: auto[^}]*bottom: 0/.test(css) && /c\.style\.top = '790px'/.test(code));
      ok('画布 / 位图的 CSS 尺寸 = 缓冲 / 密度（向上取整多出的不到 1 px 不会把内容整体拉偏）；画位图只取内容那一块（源矩形 = 单位 × 密度）', /width:\$\{cvW \/ S\}px;height:\$\{cvH \/ S\}px/.test(code) && /g\.drawImage\(bm\.cv, 0, 0, w \* bm\.s, h \* bm\.s, x, y, w, h\)/.test(code) && /g\.drawImage\(b\.art\.cv, 0, 0, 1280 \* b\.art\.s, 1280 \* b\.art\.s, 470, -62, 1280, 1280\)/.test(code));
      ok('光晕（img.bk 的 blur(60px)）：低分辨率上糊再放大（bakeHalo；全分辨率的大半径 canvas blur 在集显上是几百毫秒的 GPU 活）；plateBake 里不再有 blur(60 · S px)', /bakeHalo\(/.test(plate) && !/blur\(\$\{\(60 \* S\)/.test(plate) && /bakeHalo\(bmp\.src, bmp\.w, bmp\.h, S \/ 8, true\)/.test(bake));
      ok('光晕位图用 <img>（PNG blob）挂载，不用 <canvas>（实测挂这张 canvas 进 .bd-bg，离屏 1.8 s 处必有 ≈ 500 ms 的 Present 停顿）；烘它用软件画布（GPU 画布 toBlob 在主线程上 ReadbackImagePixels 等 GPU，一次 69 ms）', /toBlob\(res, 'image\/png'\)/.test(code) && /new Image\(\)/.test(code.slice(code.indexOf('async function mountBk'))) && /willReadFrequently: true/.test(plate));
    }
    ok('boot.css：绽开画布 / 花海条画布 / 散花画布 / 光晕画布 / .is-baked / 文字段 will-change（.is-wc）',/\.bd-bloomcv/.test(css) && /\.bd-stripcv/.test(css) && /\.bd-flcv/.test(css) && /\.bkb/.test(css) && /\.pstrip\.is-baked/.test(css) && /\.ban\.is-wc/.test(css));
    {
      const code = noComments(d);
      ok('文字段 will-change 逐个元素撤（自己的动画收完就撤，不是整组挂到 7.4 s：静止的小字挂着层会发虚、一起撤时「对焦」）；标签条 6.7 s 撤；署名不提层',
        !/\.bd-text\.is-wc/.test(css) && !/s0-credit\.is-wc/.test(css) && /\[el\.banner, L \+ 1\.7\]/.test(code) && /\[el\.ch\[0\], L \+ 1\.4\]/.test(code) && /\[el\.enter, L \+ 2\.2\]/.test(code) && !/el\.credit, L/.test(code) && !/dtext\.classList\.toggle\('is-wc'/.test(code));
    }
  }
}


/* ───────── 第七轮：绽开画布的脏块重绘（bloomTiles.ts）、光晕不透明度的量化、重播不偷看 ───────── */
{
  const S = 1.6, cw = 2561, ch = 1601;
  const grid = BT.makeGrid(cw, ch);
  const [, ay] = DAY.DC.A;
  const zn = 1.03;
  const nearRow = BT.nearRowOf(S, ay, zn);
  const readSrc = (f: string) => readFileSync(join(process.cwd(), 'src/components/decor/boot', f), 'utf8');
  const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('脏块：块边长是 4 的倍数（蒙版画布 1/4 分辨率的源矩形落在整格上）；nearRow 在画布内且不在最上面', BT.TILE % 4 === 0 && nearRow > 0 && nearRow < grid.rows, `${nearRow}/${grid.rows}`);
  let unsafe = 0, badRect = 0, overlap = 0, steps = 0, dirtySum = 0, tilesN = 0, solidSeen = 0, emptySeen = 0;
  let prevLayers: BL.BloomLayer[] = [];
  const dbg = { near: 0, diff: 0, solid: 0, empty: 0, first: [] as string[] };
  grid.prev.fill(0);
  for (let t = 0.02; t < BL.BLOOM_T[1]; t += 1 / 120) {
    const ls = BL.bloomLayers(t).filter((l) => l.a > 0.0004);
    BT.classifyTiles(grid, ls, S);
    const cur = Uint8Array.from(grid.cur);
    const prv = Uint8Array.from(grid.prev);
    const rects = BT.dirtyRects(grid, nearRow, cw, ch);
    steps++;
    // 矩形：对齐 4 px、互不重叠
    for (const r of rects) { if (r.x % 4 || r.y % 4 || r.w % 4 || r.h % 4 || r.w <= 0 || r.h <= 0) badRect++; }
    for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i], b = rects[j];
      if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) overlap++;
    }
    const cx4 = Math.ceil(cw / 4) * 4, cy4 = Math.ceil(ch / 4) * 4;
    const covered = (tx: number, ty: number) => rects.some((r) => tx * BT.TILE >= r.x && Math.min((tx + 1) * BT.TILE, cx4) <= r.x + r.w && ty * BT.TILE >= r.y && Math.min((ty + 1) * BT.TILE, cy4) <= r.y + r.h);
    for (let ty = 0; ty < grid.rows; ty++) for (let tx = 0; tx < grid.cols; tx++) {
      tilesN++;
      const k = ty * grid.cols + tx;
      const inRect = covered(tx, ty);
      if (inRect) dirtySum++;
      if (cur[k] === BT.T_SOLID) solidSeen++;
      if (cur[k] === BT.T_EMPTY) emptySeen++;
      if (inRect) continue;
      // 不重画的块：近景区的非空块不许漏；其余的块这一拍与上一拍的蒙版 α 在块内（含外扩）的取样点上必须一样，且（实心 → 1，空 → 0）
      if (ty >= nearRow && (cur[k] !== BT.T_EMPTY || prv[k] !== BT.T_EMPTY)) { unsafe++; dbg.near++; continue; }
      const x0 = (tx * BT.TILE - BT.MARGIN) / S, x1 = ((tx + 1) * BT.TILE + BT.MARGIN) / S, y0 = (ty * BT.TILE - BT.MARGIN) / S, y1 = ((ty + 1) * BT.TILE + BT.MARGIN) / S;
      for (let iy = 0; iy <= 4; iy++) for (let ix = 0; ix <= 4; ix++) {
        const x = x0 + ((x1 - x0) * ix) / 4, y = y0 + ((y1 - y0) * iy) / 4;
        const a1 = BL.bloomAlphaAt(ls, x, y), a0 = BL.bloomAlphaAt(prevLayers, x, y);
        if (Math.abs(a1 - a0) > 1e-9) { unsafe++; dbg.diff++; if (dbg.first.length < 3) dbg.first.push(`t=${t.toFixed(3)} tile=${tx},${ty} cur=${cur[k]} prv=${prv[k]} a1=${a1.toFixed(4)} a0=${a0.toFixed(4)}`); }
        if (cur[k] === BT.T_SOLID && a1 < 0.9995) { unsafe++; dbg.solid++; }
        if (cur[k] === BT.T_EMPTY && a1 > 0) { unsafe++; dbg.empty++; }
      }
    }
    prevLayers = ls;
  }
  ok(`脏块重绘的安全性：${steps} 拍 × ${grid.cols}×${grid.rows} 块里，凡是不重画的块，蒙版 α 与上一拍逐点相同（实心 = 1、空 = 0），近景区的非空块一律重画`, unsafe === 0, `${unsafe} ${JSON.stringify(dbg)}`);
  ok('脏块矩形对齐 4 px、互不重叠', badRect === 0 && overlap === 0, `${badRect},${overlap}`);
  ok(`脏块确实省了活：整段绽开平均只重画 ${((100 * dirtySum) / tilesN).toFixed(0)}% 的块（实心核与空白占 ${((100 * (solidSeen + emptySeen)) / tilesN).toFixed(0)}%）`, dirtySum / tilesN < 0.6 && solidSeen > 0 && emptySeen > 0);
  ok('TILE_FROM 在绽开窗口里（< 2.7 s）、晚于蒙版软边铺满包围盒的头一段（≥ 1 s）', BT.TILE_FROM >= 1 && BT.TILE_FROM < BL.BLOOM_T[1]);
  const ds = stripComments(readSrc('dayScene.ts'));
  ok('dayScene：1.5 s 起分块重绘（导出模式 / ?fastoff=tiles 关）；每拍都分类以维护 prev', /const tiled = !o\.capture && !fastOff\.has\('tiles'\) && t >= TILE_FROM/.test(ds) && /classifyTiles\(b\.grid/.test(ds) && /dirtyRects\(b\.grid, nearRowOf\(S, ay, zn\), cw, ch\)/.test(ds));
  ok('光晕不透明度量化：实时播放时 α 取 0.3 / 76 的整数倍（终值恰为 0.3，底板烘焙的 |bakedOp − 此刻| < 0.0015 判据不受影响）、值没变不写；导出模式不量化', /const BK_STEPS = 76/.test(ds) && /Math\.round\(\(bkRaw \/ 0\.3\) \* BK_STEPS\) \/ BK_STEPS\) \* 0\.3/.test(ds) && /if \(bko !== bkLast\)/.test(ds) && (Math.round((0.3 / 0.3) * 76) / 76) * 0.3 === 0.3);
  const wm = stripComments(readSrc('warm.ts'));
  ok('重播（主界面已经给用户看过）不偷看应用（peekApp）：它让 Viz 把开屏下面的设置页画几帧，测量台重播 0.87 s 处 90–115 ms 的 LoAF', /let appShown = false/.test(wm) && /if \(host && !appShown && !noPeek\) peekApp\(host\)/.test(wm) && /export function peekNow[^{]*\{\s*if \(appShown\) return Promise\.resolve\(\)/.test(wm));
  ok('App.tsx：booting 变成 false 时 noteAppShown()', /if \(!booting\) noteAppShown\(\)/.test(stripComments(readFileSync(join(process.cwd(), 'src/App.tsx'), 'utf8'))));
}

// ── 昼开屏 · 预渲染视频版（boot/bootVideo.ts、videoRun.ts；docs/BOOT-VIDEO.md）：实现切换、判决、视频矩形、媒体时钟、退路判据、交接常量与 manifest ──
{
  const root = process.cwd();
  const rd = (p: string) => readFileSync(join(root, p), 'utf8');
  const noC = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const withWindow = <T,>(search: string | undefined, fn: () => T): T => {
    const g = globalThis as unknown as { window?: unknown };
    const had = 'window' in g;
    const prev = g.window;
    if (search !== undefined) g.window = { location: { search } };
    try { return fn(); } finally { if (had) g.window = prev; else delete g.window; }
  };
  const setG = (v: unknown) => { (globalThis as unknown as { __alightBootVideo?: unknown }).__alightBootVideo = v; };

  // ① 实现切换：bootVideoRequested 的真值表
  {
    const R = IMPL.bootVideoRequested;
    IMPL.setBootVideo(undefined);
    setG(undefined);
    ok('bootVideoRequested：夜恒为假（无论地址 / 注入 / 设置 / 固定值）', (() => {
      const qs = ['', '?bootimpl=video', '?bootvideo=1', '?bootimpl=comp'];
      let bad = 0;
      for (const q of qs) for (const g of [undefined, true, false]) for (const st of [undefined, true, false]) for (const fx of [undefined, true, false]) {
        setG(g); IMPL.setBootVideo(fx);
        if (withWindow(q, () => R('night', st))) bad++;
      }
      setG(undefined); IMPL.setBootVideo(undefined);
      return bad === 0;
    })());
    ok('bootVideoRequested：昼默认假（2026-10-29 改回实时）；设置 true / false 照办', withWindow('', () => R('day') === false && R('day', true) === true && R('day', false) === false));
    ok('bootVideoRequested：注入 globalThis.__alightBootVideo 压过设置（true / false）；非布尔的注入不算', (() => {
      setG(false); const a = withWindow('', () => R('day', true));
      setG(true); const b = withWindow('', () => R('day', false));
      setG('x'); const c = withWindow('', () => R('day', false));
      setG(undefined);
      return a === false && b === true && c === false;
    })());
    ok('bootVideoRequested：?bootvideo=1|0 压过注入与设置', (() => {
      setG(false); const a = withWindow('?bootvideo=1', () => R('day', false));
      setG(true); const b = withWindow('?bootvideo=0', () => R('day', true));
      setG(undefined);
      return a === true && b === false;
    })());
    ok('bootVideoRequested：?bootimpl=legacy → 假（旧路径没有调速器）、comp → 假（实时版，A/B 的对照）、video → 真；都压过 ?bootvideo= / 注入 / 设置', (() => {
      setG(true);
      const a = withWindow('?bootimpl=legacy&bootvideo=1', () => R('day', true));
      const b = withWindow('?bootimpl=comp&bootvideo=1', () => R('day', true));
      setG(false);
      const c = withWindow('?bootimpl=video&bootvideo=0', () => R('day', false));
      setG(undefined);
      return a === false && b === false && c === true;
    })());
    ok('bootVideoRequested：setBootVideo() 的固定值优先级最高（压过 ?bootimpl=）', (() => {
      IMPL.setBootVideo(false); const a = withWindow('?bootimpl=video', () => R('day', true));
      IMPL.setBootVideo(true); const b = withWindow('?bootimpl=comp', () => R('day', false));
      IMPL.setBootVideo(undefined);
      return a === false && b === true;
    })());
    ok('?bootimpl=video 只是别名：bootImpl() 解析成 \'comp\'，不让 \'video\' 流进任何 === \'comp\' 的判断；governedFor(\'day\') 仍为真、昼锁 120 不变；legacy 仍是 legacy', (() => {
      const a = withWindow('?bootimpl=video', () => [IMPL.bootImpl(), IMPL.governedFor('day'), IMPL.governedForTransition('day'), IMPL.lockHzFor('day')] as const);
      const l = withWindow('?bootimpl=legacy', () => [IMPL.bootImpl(), IMPL.governedFor('day')] as const);
      return a[0] === 'comp' && a[1] === true && a[2] === true && a[3] === 120 && l[0] === 'legacy' && l[1] === false;
    })());
    const bi = rd('src/components/decor/boot/bootImpl.ts');
    ok('BootImpl 类型不加第三个取值（仍是 \'legacy\' | \'comp\'）；\'video\' 只在 BootImplRequest 里', /export type BootImpl = 'legacy' \| 'comp';/.test(bi) && /export type BootImplRequest = BootImpl \| 'video';/.test(bi));
  }

  // ② 判决 bootVideoEligible：比例边界、减少动态、隐藏、能力、加载、主题、实现
  {
    const base = { theme: 'day', impl: 'comp' as 'comp' | 'legacy', requested: true, w: 1600, h: 1000, reduced: false, hidden: false, capability: true, loaded: true };
    const el = (o: Partial<typeof base>) => BV.bootVideoEligible({ ...base, ...o });
    ok('bootVideoEligible：全满足 → ok', el({}).ok === true);
    ok('bootVideoEligible：比例边界 1.15 ok / 1.1499 不 / 2.098 ok / 2.0982 不 / 2.10 不（aspectOk 放行但视频盖不到）/ 2.2 不', el({ w: 1150, h: 1000 }).ok && !el({ w: 1149.9, h: 1000 }).ok && el({ w: 2098, h: 1000 }).ok && !el({ w: 2098.2, h: 1000 }).ok && !el({ w: 2100, h: 1000 }).ok && aspectOk(2100, 1000) && !el({ w: 2200, h: 1000 }).ok);
    ok('bootVideoEligible：1.6 / 1.7 / 1.78 / 2.0 都 ok；失败的原因是 aspect', [1.6, 1.7, 1.78, 2.0].every((r) => el({ w: r * 1000, h: 1000 }).ok) && (() => { const r = el({ w: 2200, h: 1000 }); return !r.ok && r.reason === 'aspect'; })());
    const why = (o: Partial<typeof base>) => { const r = el(o); return r.ok ? 'ok' : r.reason; };
    ok('bootVideoEligible：夜 / legacy / 没要 / 减少动态 / 页面隐藏 / 能力不过 / 没加载好 各自给出对应的原因', why({ theme: 'night' }) === 'night' && why({ impl: 'legacy' }) === 'impl' && why({ requested: false }) === 'not-requested' && why({ reduced: true }) === 'reduced' && why({ hidden: true }) === 'hidden' && why({ capability: false }) === 'capability' && why({ loaded: false }) === 'not-loaded');
    ok('bootVideoEligible：任一项不过就整个不过（2^k 组合里只有全满足为真）', (() => {
      const flags: Array<Partial<typeof base>> = [{ theme: 'night' }, { impl: 'legacy' }, { requested: false }, { w: 2200 }, { reduced: true }, { hidden: true }, { capability: false }, { loaded: false }];
      let okCount = 0;
      for (let m = 0; m < 1 << flags.length; m++) {
        const o = Object.assign({}, ...flags.filter((_, i) => m & (1 << i)));
        if (el(o).ok) okCount++;
      }
      return okCount === 1;
    })());
  }

  // ③ 视频矩形：窗口 (W, H) → 宽高与裁切
  {
    const near2 = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    const full = (BV.BV.width / BV.BV.height);
    const rs = [1.15, 1.6, 1.78, BV.BV.ratioMax].map((r) => ({ r, v: BV.videoRect(1000 * r, 1000) }));
    ok('videoRect：高 = 窗高、宽 = 窗高 × 宽 / 高（3210 / 1530）、左上对齐', rs.every(({ v }) => near2(v.height, 1000) && near2(v.width, 1000 * full) && v.left === 0 && v.top === 0));
    ok('videoRect：窄窗口右侧被裁（r = 1.15 裁 ≈ 947、1.6 裁 ≈ 497、1.78 裁 ≈ 317）；r = ratioMax 不裁（盖得住）', Math.abs(rs[0].v.crop - (1000 * full - 1150)) < 1e-6 && Math.abs(rs[1].v.crop - (1000 * full - 1600)) < 1e-6 && Math.abs(rs[2].v.crop - (1000 * full - 1780)) < 1e-6 && rs[3].v.crop >= 0 && rs[3].v.crop < 0.1);
    ok('videoRect：窗高 1530（视频原尺寸，DPR 1.5 下 CSS 1020）时恰好 3210 × 1530——1 个视频像素对 1 个设备像素；1 个舞台单位 = 1.53 个视频像素 = H / 1000', near2(BV.videoRect(3210, 1530).width, 3210) && near2(BV.videoRect(2140, 1020).width, 2140) && near2(BV.BV.scale, 1530 / 1000));
    ok('videoRect：视频宽度够盖住 aspectOk 内 ratioMax 以内的所有窗口（crop ≥ 0 且窗口宽 ≤ 视频宽 + 0.1）', [1.15, 1.3, 1.6, 1.7, 1.78, 2, 2.098].every((r) => { const v = BV.videoRect(900 * r, 900); return 900 * r <= v.width + 0.1; }));
  }

  // ④ 能力判定（注入 mediaCapabilities）：H.264 通过（supported && powerEfficient；smooth 不参与）= 用视频，不通过 = 整次走实时；不通过时重试
  {
    const mk = (avc: boolean, powerEff = true, smooth = true): BV.McLike => ({
      decodingInfo: async (c: unknown) => {
        const ct = (c as { video: { contentType: string } }).video.contentType;
        const yes = ct.includes('avc1') ? avc : false;
        return { supported: yes, smooth: yes && smooth, powerEfficient: yes && powerEff };
      },
    });
    const a = await BV.pickVideoFile(mk(true));
    const c = await BV.pickVideoFile(mk(false));
    const d = await BV.pickVideoFile(mk(true, false));                // 软解（powerEfficient=false）不算
    const e = await BV.pickVideoFile(undefined);                      // 没有 mediaCapabilities
    const f = await BV.pickVideoFile({ decodingInfo: async () => { throw new Error('x'); } });
    const g = await BV.pickVideoFile(mk(true, true, false));          // smooth=false（Chromium 按历史丢帧率记的，自锁）不挡
    ok('pickVideoFile：H.264 通过 → 主文件；不通过 / 软解 / 没有 mediaCapabilities / 抛错 → null（整次走实时）；smooth=false 不挡（历史丢帧自锁，真画不动由退路判据管）', a === 'primary' && c === null && d === null && e === null && f === null && g === 'primary', [a, c, d, e, f, g].join());
    const cfg = BV.decodingConfig(BV.VIDEO_FILES.primary) as { video: { contentType: string; width: number; height: number; framerate: number } };
    ok('decodingInfo 的参数：avc1.640034、3210 × 1530、60 fps', /avc1\.640034/.test(cfg.video.contentType) && cfg.video.width === 3210 && cfg.video.height === 1530 && cfg.video.framerate === 60);
    // 重试：前几次 powerEfficient=false（GPU 进程刚起来），之后 true → 通过；一直 false → 重试 CAP_TRIES 次后失败；没有 mediaCapabilities 不重试
    let n = 0;
    const flaky: BV.McLike = { decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: ++n >= 3 }) };
    const r1 = await BV.capabilityRetry(flaky, BV.VIDEO_FILES.primary, async () => undefined);
    let m = 0;
    const never: BV.McLike = { decodingInfo: async () => { m++; return { supported: true, smooth: true, powerEfficient: false }; } };
    const r2 = await BV.capabilityRetry(never, BV.VIDEO_FILES.primary, async () => undefined);
    const r3 = await BV.capabilityRetry(undefined, BV.VIDEO_FILES.primary, async () => undefined);
    ok('capabilityRetry：第 3 次才通过 → ok、tries 3；一直不通过 → 恰好 CAP_TRIES 次后 false；没有 mediaCapabilities → 1 次就放弃', r1.ok && r1.tries === 3 && !r2.ok && m === BV.CAP_TRIES && r2.tries === BV.CAP_TRIES && !r3.ok && r3.tries === 1);
  }

  // ⑤ 媒体时钟：外推夹在 [0, 50 ms]，视频卡住时不前进，最后一帧之前不提前走完
  {
    const c = new BV.MediaClock();
    ok('MediaClock：首个 rVFC 回调到来前 t = 0', c.at(1234) === 0 && !c.started);
    c.note(1.0, 1000);
    ok('MediaClock：t = mediaTime + (呈现时刻 − expectedDisplayTime)/1000', near(c.at(1000), 1.0) && near(c.at(1020), 1.02) && near(c.at(1049), 1.049));
    ok('MediaClock：外推夹在 [0, 50 ms]——视频卡住（不再有新帧）时文字最多多走 50 ms；呈现时刻早于记录的（负）按 0', near(c.at(1500), 1.05) && near(c.at(99999), 1.05) && near(c.at(900), 1.0));
    c.note(0.9, 1100);
    ok('MediaClock：媒体时间不倒退（迟到的旧帧忽略）', near(c.media, 1.0));
    c.note(1.0083333, 1008);
    ok('MediaClock：新帧到来后外推量重新起算', near(c.at(1008), 1.0083333) && near(c.at(1058), 1.0583333) && near(c.at(5000), 1.0583333));
    const e = new BV.MediaClock();
    e.note(7.38, 5000);
    ok('MediaClock：抵达最后一帧之前 t 恒 < T_END（外推不会让文字提前走完、提前触发交接）；抵达（媒体时间 ≥ T_END − 半帧）后 t = T_END', e.at(5100) < BV.BV.tEnd && !e.atEnd && (() => { e.note(7.4, 5008); return e.atEnd && e.at(5008) === BV.BV.tEnd && e.at(9999) === BV.BV.tEnd; })());
    const f = new BV.MediaClock();
    f.note(7.3667, 100);
    const fEnded = f.noteEnded(200);
    ok('MediaClock：视频报 ended（rVFC 少报了最后一两帧，已呈现 ≥ T_END − 2.5 帧）也算抵达最后一帧', fEnded === true && f.atEnd && f.at(300) === BV.BV.tEnd);
    const g = new BV.MediaClock();
    g.note(2.28, 100);
    const gEnded = g.noteEnded(200);
    ok('MediaClock：半路就 ended（文件被截断 / 过短）不替它「补」到 T_END：noteEnded 返回 false、时钟不动、不触发交接', gEnded === false && !g.atEnd && near(g.media, 2.28) && g.at(100) < 2.4);
    const h2 = new BV.MediaClock();
    ok('MediaClock：一帧都没呈现就 ended 也是不完整（false）', h2.noteEnded(10) === false && !h2.atEnd);
    ok('END_MEDIA = T_END − 半帧（0.5 / fps）', near(BV.END_MEDIA, 7.4 - 0.5 / BV.BV.fps));
  }

  // ⑥ 退路判据：丢帧窗口、卡死、2.8–6.0 s 的有效区间、只触发一次
  {
    const feed = (j: BV.VideoJudge, from: number, to: number, perSec: number, media0: number, refreshHz?: number, extra = 0) => {
      // 每 500 ms 采样一次；媒体时间与墙钟同速；累计丢帧按 perSec 增长，extra = 在 from 之后一次性多丢的帧
      let r: BV.FallbackReason | null = null;
      let dropped = 0;
      for (let ms = from; ms <= to; ms += 500) {
        dropped = Math.round(perSec * ((ms - from) / 1000)) + (ms > from ? extra : 0);
        r = j.sample(ms, media0 + (ms - from) / 1000, dropped, refreshHz) ?? r;
      }
      return r;
    };
    ok('VideoJudge 丢帧：2.8–6.0 s 之间近 1 s 丢 ≥ 30 帧（= 50 % 的 60 fps）触发（30/s 触发，29/s 不触发）；屏外真窗口里实测的 3–4 % 丢帧（每秒 2–3 帧）与 120 fps 时的 27 % 都不触发', feed(new BV.VideoJudge(), 0, 3000, 30, 2.9) === 'dropped' && feed(new BV.VideoJudge(), 0, 3000, 29, 2.9) === null && feed(new BV.VideoJudge(), 0, 3000, 3, 2.9) === null);
    ok('VideoJudge 丢帧：2.8 s 之前不生效（那里转实时要走绽开段慢路径，比继续播视频更糟）', feed(new BV.VideoJudge(), 0, 2000, 60, 0.6) === null);
    ok('VideoJudge 丢帧：6.0 s 之后不生效（离交接太近，不如播完）', feed(new BV.VideoJudge(), 0, 3000, 60, 6.2) === null);
    ok('VideoJudge 丢帧：冷启动的启动丢帧（媒体时间 < 0.5 s 的那些）不计', (() => {
      const j = new BV.VideoJudge();
      let r = j.sample(100, 0.1, 31, 240) ?? null;      // 启动补丁：31 帧
      for (let i = 1; i <= 12; i++) r = j.sample(100 + i * 500, 0.1 + i * 0.5, 31, 240) ?? r;       // 之后不再丢
      return r === null;
    })());
    ok('VideoJudge 丢帧：生效区间（2.8 s）之前攒下的丢帧一个都不算（warm 探针 / 绽开段的丢帧不会让 2.8 s 一到就误触发；最早在 2.8 s + 1 s 才可能触发）', (() => {
      const j = new BV.VideoJudge();
      let r: BV.FallbackReason | null = null;
      let d = 0;
      for (let ms = 0; ms <= 2200; ms += 500) { d += 80; r = j.sample(ms, 0.6 + ms / 1000, d, 240) ?? r; }       // 媒体时间 0.6–2.8：每个样本多丢 80 帧
      for (let ms = 2500; ms <= 6000; ms += 500) r = j.sample(ms, 0.6 + ms / 1000, d, 240) ?? r;               // 之后不再丢
      return r === null;
    })());
    ok('VideoJudge 丢帧：触发一次后恒返回 null（退路只触发一次）', (() => { const j = new BV.VideoJudge(); feed(j, 0, 3000, 40, 2.9); const again = j.sample(9000, 4, 999, 240); return j.fired === 'dropped' && again === null && j.trip('error') === null && j.stall(9999, 0, true, true, 4) === null; })());
    ok('VideoJudge 丢帧：显示器刷新率低于视频帧率时阈值加上 (60 − 刷新率) × 窗口秒数（30 Hz 的屏上每秒本来就会「丢」约 30 帧，不能误触发）；但真的丢得更多仍触发', feed(new BV.VideoJudge(), 0, 3000, 30, 2.9, 30) === null && feed(new BV.VideoJudge(), 0, 3000, 100, 2.9, 30) === 'dropped');
    const st = (nowMs: number, last: number, playing = true, got = true, media = 3) => new BV.VideoJudge().stall(nowMs, last, playing, got, media);
    ok('VideoJudge 卡死：播放中媒体时间 > 150 ms 不前进触发（149 不、151 触发）', st(1149, 1000) === null && st(1151, 1000) === 'stall');
    ok('VideoJudge 卡死：没在播放（暂停 / 隐藏 / 结束）不算；已抵达最后一帧不算', st(5000, 1000, false) === null && st(5000, 1000, true, true, 7.4) === null);
    ok('VideoJudge 卡死：开播后 1 s 内还没有第一个已呈现的帧 → start-stall（999 ms 不、1001 触发）', st(1999, 1000, true, false, 0) === null && st(2001, 1000, true, false, 0) === 'start-stall');
    ok('退路原因都在类型里：error / stall / start-stall / dropped / play-rejected / resize', (() => { const j = new BV.VideoJudge(); return j.trip('error') === 'error' && j.fired === 'error'; })());
    ok('常量：150 ms / 1 s 窗口 / 30 帧 / 2.8–6.0 s / 0.5 s / 采样 500 ms / 外推 50 ms / 等待 300 ms / 丢帧退路的领先量 0.12 s', BV.STALL_MS === 150 && BV.DROP_WINDOW_MS === 1000 && BV.DROP_LIMIT === 30 && BV.DROP_FROM === 2.8 && BV.DROP_TO === 6.0 && BV.DROP_COUNT_FROM === 0.5 && BV.SAMPLE_MS === 500 && BV.EXTRAP_MAX_MS === 50 && BV.VIDEO_WAIT_MS === 300 && BV.FALLBACK_LEAD === 0.12);
  }

  // ⑦ 前提检查（修订）：视频里只有 A 类 fx（起手的雾 / 荆棘脉冲 / 圆边雾圈 / 点花），它们必须全部在清晰立绘层接手（ovTo = 3.0 s）之前收完——之后立绘层（不透明）会盖住视频里它们压在立绘上的那部分；
  //    B 类（花瓣 / 轨迹 / 蝶的光晕 / 落蝶光环 / 蝶 / 雪点）全程实时画在立绘上方，7.4 s 交接时不需要渐入（旧版的 fxRamp 已删）.
  {
    const ds = rd('src/components/decor/boot/dayScene.ts');
    const OV = DAY.DAY_VID;
    // 点花（DAY_BLOOM）：t0 = 圆边扫过 + 0.05，停留 1.2 s；与 dayScene.initDay 同一个随机序列（mulberry32(4242)）
    const r0 = mulberry32(4242);
    let guard = 0; let n = 0; let bloomEnd = 0;
    while (n < 64 && guard++ < 4000) {
      const x = 60 + r0() * 1500; const y = 540 + r0() * 450;
      if (x < 480 && y > 270 && y < 740) continue;
      r0(); r0(); r0();                                  // s、rot（两次 r()），其余字段不耗随机数
      let lo: number = BL.BLOOM_T[0]; let hi: number = BL.BLOOM_T[1];
      const dx = x - DAY.DC.C0[0]; const dy = y - DAY.DC.C0[1];
      for (let i = 0; i < 22; i++) { const m = (lo + hi) / 2; if (BL.bloomRadius(m) < Math.hypot(dx, dy / BL.bloomFlat(m)) + BL.BLOOM_FLOWER_MARGIN) lo = m; else hi = m; }
      bloomEnd = Math.max(bloomEnd, (lo + hi) / 2 + 0.05 + 1.2);
      n++;
    }
    ok(`A 类 fx 在 ovTo（${OV.ovTo} s）之前全部收完：点花最晚 ${bloomEnd.toFixed(2)} s、荆棘脉冲 ${DAY.DT.thorn[1]} s、圆边雾圈（半径 ≥ 1500 即不画，BLOOM_T[1] = ${BL.BLOOM_T[1]} s）、起手的雾`, bloomEnd <= OV.ovTo + 1e-6 && DAY.DT.thorn[1] <= OV.ovTo && BL.BLOOM_T[1] <= OV.ovTo && BL.bloomRadius(BL.BLOOM_T[1]) >= 1500 && BL.bloomFogAlpha(OV.ovTo) < 0.002);
    ok('清晰立绘层的时刻：ovPre < ovFrom = T_FREE（绽开收完、蒙版撤掉）< ovTo；淡入 300 ms；蝶 2.2 s 才第一次出现，预热 1.6 s 起', OV.ovPre < OV.ovFrom && OV.ovFrom === BL.T_FREE && OV.ovTo > OV.ovFrom && near(OV.ovTo - OV.ovFrom, 0.3) && DAY.DT.dot[0] === 2.2);
    const sc = noC(ds);
    ok('B 类 fx 全程实时：renderFx 有 mode（full / dust / live / base），petals / trail / 蝶光晕 / 落蝶光环只在 partB 里画，雾 / 荆棘 / 雾圈 / 点花只在 partA；光尘不在 base', /type FxMode = 'full' \| 'dust' \| 'live' \| 'base'/.test(sc) && /const partA = mode === 'full' \|\| mode === 'base'/.test(sc) && /const partB = mode === 'full' \|\| mode === 'live'/.test(sc) && /!layersBg && mode !== 'base'/.test(sc) && /if \(partB\) \{\s*for \(const p of DAY_PETALS\)/.test(sc));
    ok('交接不再有 fx 渐入（B 类本来就是实时的）：vidHandoff 里没有 fxRamp / 离屏画布', !/fxRamp = \{ t0/.test(sc) && !/const mul = fxRamp/.test(sc));
  }


  // ⑧ 交接时刻常量与 dayScene / manifest 对齐；防过期
  {
    const B = BV.BV;
    ok('交接常量与 dayScene 对齐：tEnd = T_END = L + 2.4、landing = DT.fly[1]、帧数 = round(tEnd × fps) + 1 = 445（最后一帧恰是 T_END）、时长 445 / 60；60 fps 的每一帧都是 120 fps 网格上的偶数帧（t = i / 60）', B.tEnd === DAY.T_END && B.landing === DAY.DT.fly[1] && B.frames === Math.round(B.tEnd * B.fps) + 1 && B.frames === 445 && near(B.frames / B.fps, 7.4166667, 1e-6));
    ok('交接常量：预光栅 7.15 s（= T_END − 0.25）、淡入 120 ms、最后一帧判据 = T_END − 半帧；尺度 0.846（视口高 846 对应 1000 单位）、舞台宽 1774 / 0.846 = 2096.9（四舍五入到 0.1）、ratioMax 不小于 1774 / 846', near(B.handoffPre, B.tEnd - 0.25) && B.handoffFadeMs === 120 && near(B.scale, B.height / 1000) && Math.abs(B.width / B.scale - B.extUnits) < 0.1 && B.ratioMax >= B.width / B.height - 1e-9 && B.ratioMax - B.width / B.height < 1e-3);
    ok('视频硬件解码的帧率 / 尺寸合同：60 fps、3210 × 1530（按显示分辨率渲染：DPR 1.5 下 CSS 2140 × 1020 的整页；窗口高 1020 CSS 时 1 个视频像素 = 1 个设备像素，播放时不放大）；scale = 1.53 设备像素 / 舞台单位', B.fps === 60 && B.width === 3210 && B.height === 1530 && near(B.scale, 1.53) && near(B.extUnits, 3210 / 1.53, 0.1));
    ok('一个文件：day-boot.avc.mp4（H.264 High，avc1.640034）；路径 ./boot/ 下（media-src \'self\' 覆盖）；不带 HEVC（P010 路径偏暗约 2.4 级、60 fps 下有解码器冷启动停顿）', BV.VIDEO_FILES.primary.name === 'day-boot.avc.mp4' && /^avc1\./.test(BV.VIDEO_FILES.primary.codec) && Object.keys(BV.VIDEO_FILES).length === 1);

    // manifest（R 交付；没有就跳过这一块——check-build 发包前会要求它存在）
    let man: Record<string, unknown> | undefined;
    try { man = JSON.parse(rd('public/boot/day-boot.json')); } catch { man = undefined; }
    if (!man) {
      ok('manifest（public/boot/day-boot.json）还不存在：跳过与 manifest 的核对（check-build 要求发包时存在）', true);
    } else {
      const m = man as { schema: number; stub: boolean; width: number; height: number; fps: number; frames: number; scale: number; extUnits: number; ratioMax: number; tEnd: number; landing: number; handoffPre: number; handoffFadeMs: number; files: Array<{ role: string; path: string; codec: string }>; sources?: { splash?: string; strip?: string; timeline?: string; src?: string } };
      const stale = (what: string) => `视频过期，需要重新渲染：${what}`;
      // 版面逻辑只依赖宽高**比例**（videoRect / ratioMax）；像素尺寸与 scale 只进 mediaCapabilities 的询问与 manifest（R 为守「不超原图」把尺度从 0.944 降到 0.846 时帧是 1774 × 846，比例不变）
      ok(`manifest：schema 1；帧率 / 帧数 / 交接时刻 / 淡入时长与 BV 一致；宽高比 ${(m.width / m.height).toFixed(4)} 与 BV（${(B.width / B.height).toFixed(4)}）差 < 0.001；scale = 高 / 1000；ratioMax 不超过片子的比例 + 0.001`,
        m.schema === 1 && m.fps === B.fps && m.frames === B.frames && m.handoffPre === B.handoffPre && m.handoffFadeMs === B.handoffFadeMs
        && Math.abs(m.width / m.height - B.width / B.height) < 1e-3 && Math.abs(m.scale - m.height / 1000) < 1e-9 && m.ratioMax <= m.width / m.height + 1e-3 && Math.abs(m.extUnits - m.width / m.scale) < 0.1);
      if (m.width !== B.width || m.height !== B.height) ok(`注意：manifest 的帧尺寸 ${m.width}×${m.height} 与 bootVideo.ts 的 BV（${B.width}×${B.height}）不同——只影响 mediaCapabilities 询问用的尺寸，真视频定稿后把 BV 对齐`, true);
      ok('manifest 防过期：tEnd / landing 与 dayScene 当前常量一致（T_END、DT.fly[1]）', m.tEnd === DAY.T_END && m.landing === DAY.DT.fly[1], stale(`manifest tEnd ${m.tEnd} / landing ${m.landing}，dayScene ${DAY.T_END} / ${DAY.DT.fly[1]}`));
      ok('manifest：文件名 / 编码前缀与 bootVideo.ts 一致（只有主文件 avc1.640034）', m.files.length === 1 && m.files.some((f) => f.role === 'primary' && f.path === BV.VIDEO_FILES.primary.name && f.codec === 'avc1.640034'));
      if (m.sources) {
        const sha = (p: string) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex');
        if (m.sources.splash) ok('manifest 防过期：sources.splash = art/splash-official.webp 的 sha256', m.sources.splash === sha('public/art/splash-official.webp'), stale('官方立绘变了'));
        if (m.sources.strip) ok('manifest 防过期：sources.strip = boot/day-strip.webp 的 sha256', m.sources.strip === sha('public/boot/day-strip.webp'), stale('花海条变了'));
        ok('manifest：sources.timeline / sources.src（若有）是 64 位十六进制（timeline 的算法由 scripts/boot-video 定义，src 不一致只告警）', [m.sources.timeline, m.sources.src].every((h) => h === undefined || /^[0-9a-f]{64}$/.test(h)));
      } else {
        ok(`manifest 没有 sources（${m.stub ? '桩视频' : '真视频应当有'}）：素材 / 时间表防过期无法核对${m.stub ? '，stub:true 由 check-build 拦在发包之外' : ''}`, m.stub === true);
      }
    }
  }

  // ⑧b 文件完整性：截断 / 过短的视频不能提前交接（时长与帧数对 manifest；播完时已呈现的最后一帧要够到 T_END）
  {
    const B = BV.BV;
    ok('文件时长合同：FILE_DURATION = 帧数 / 帧率 = 445 / 60；durationOk 容差 ±0.04 s（±2.4 帧）：7.4167 ok / 7.40 ok / 7.37 不 / 7.46 不 / NaN、Infinity、0 不', near(BV.FILE_DURATION, 445 / 60, 1e-9) && BV.durationOk(7.4167) && BV.durationOk(7.40) && BV.durationOk(7.4167 - 0.039) && !BV.durationOk(7.37) && !BV.durationOk(7.46) && !BV.durationOk(NaN) && !BV.durationOk(Infinity) && !BV.durationOk(0) && !BV.durationOk(2.28));
    ok('endedComplete：ended 时已呈现 ≥ T_END − 2.5 帧才算播完（7.4 / 7.3833 / 7.3583 ok；7.35 / 2.28 / 0 不）', BV.endedComplete(7.4) && BV.endedComplete(7.4 - 1 / 60) && BV.endedComplete(7.4 - 2.4 / 60) && !BV.endedComplete(7.4 - 2.6 / 60) && !BV.endedComplete(2.28) && !BV.endedComplete(0));
    const vrs = noC(rd('src/components/decor/boot/videoRun.ts'));
    const bvs = noC(rd('src/components/decor/boot/bootVideo.ts'));
    ok('接线：ended 时 noteEnded 返回 false → 退路 truncated（不提前交接）；加载时 duration 对不上 → 不用视频（reason duration:…）；退路原因含 truncated', /if \(!this\.clock\.noteEnded\(performance\.now\(\)\)\) this\.fallback\('truncated'\)/.test(vrs) && /durationOk\(el\.duration\)/.test(bvs) && /'truncated'/.test(bvs.slice(bvs.indexOf('export type FallbackReason'), bvs.indexOf('export type FallbackReason') + 200)));
    type Mp4Info = { complete: boolean; frames: number; width: number; height: number; trackDuration: number; fps: number | null };
    let info: Mp4Info | undefined;
    let mp4buf: Buffer | undefined;
    try { mp4buf = readFileSync(join(root, 'public/boot', BV.VIDEO_FILES.primary.name)); } catch { mp4buf = undefined; }
    if (mp4buf) {
      const mp4info = mp4infoRaw as (b: Buffer) => Mp4Info;
      info = mp4info(mp4buf);
      ok(`视频文件对 BV：${info!.width}×${info!.height}、${info!.frames} 帧、轨时长 ${info!.trackDuration.toFixed(4)} s、${info!.fps} fps = BV（${B.width}×${B.height}、${B.frames} 帧、${(B.frames / B.fps).toFixed(4)} s、${B.fps} fps）；顶层盒排满整个文件（没被截断）`,
        info!.width === B.width && info!.height === B.height && info!.frames === B.frames && Math.abs(info!.trackDuration - BV.FILE_DURATION) < 0.02 && info!.fps === B.fps && info!.complete === true);
      const half = mp4info(mp4buf.subarray(0, Math.floor(mp4buf.length / 2)));
      const tail = mp4info(mp4buf.subarray(0, mp4buf.length - 1));
      ok('mp4info.complete：把真文件砍一半 / 少最后 1 字节都判成不完整（moov 还在前面，时长与帧数照旧——只有这一项能看出截断）', half.complete === false && tail.complete === false && half.frames === info!.frames);
    } else {
      ok('视频文件不存在：跳过与文件的核对（check-build 发包前要求存在）', true);
    }
  }

  // ⑨ 接线（源码层面）：判决点、起播、打断、设置、预加载、夜不动
  {
    const bs = noC(rd('src/components/decor/BootSplash.tsx'));
    const scene = bs.slice(bs.indexOf('scene.ready.then(async'));
    ok('BootSplash：判决点在 reportFirstFrame() 之前（scene.ready 之后最多再等 VIDEO_WAIT_MS）；不过则 releaseBootVideo（整次实时，没有视频元素残留）', scene.indexOf('waitBootVideo(vsrc, VIDEO_WAIT_MS)') > 0 && scene.indexOf('waitBootVideo(vsrc, VIDEO_WAIT_MS)') < scene.indexOf('reportFirstFrame()') && /releaseBootVideo\(vsrc\);\s*vsrc = null;/.test(scene));
    ok('BootSplash：begin() 在第一次 render(0) 与 prepare 之前；视频与文字时钟在 whenWindowShown 的同一刻起（p.start(0) + vrun.play()）', scene.indexOf('scene.video!.begin()') > 0 && scene.indexOf('scene.video!.begin()') < scene.lastIndexOf('scene.render(0, false)') && /whenWindowShown\(\)\.then\(\(\) => \{[^]*?p\.start\(0\);\s*vrun\?\.play\(\)/.test(scene));
    ok('BootSplash：判决用 bootVideoEligible（比例 / 减少动态 / 隐藏 / 能力 / 加载）；预加载取 acquireBootVideo，不想用就 discardPreloadedBootVideo', /bootVideoEligible\(\{/.test(bs) && /acquireBootVideo\(/.test(bs) && /discardPreloadedBootVideo\(\)/.test(bs));
    ok('BootSplash（视频版排期）：prepare 判决后立刻做（VIDEO_PREPARE_MS = 0，在窗口还藏着的空档里）；升层 / 探针（warmBoot(el, VIDEO_WARM_MS = 0, true)，不偷看）在起播前做；应用偷看（peekNow）起播后 VIDEO_PEEK_MS（1 s）再做；没用上视频则判决后照旧预热', /const VIDEO_PREPARE_MS = 0;/.test(bs) && /VIDEO_PREPARE_MS\)/.test(bs) && /const VIDEO_WARM_MS = 0;/.test(bs) && /const VIDEO_PEEK_MS = 1000;/.test(bs) && /warmBoot\(el, [^;]*VIDEO_WARM_MS, true\)/.test(bs) && /peekNow\(el\)/.test(bs) && bs.indexOf('warmBoot(el, (globalThis') < bs.indexOf('p.start(0)') && bs.indexOf('p.start(0)') < bs.indexOf('peekNow(el)') && /if \(warmWanted && videoWanted && !vrun\) unwarm = warmBoot\(el, 400\)/.test(bs));
    ok('BootSplash：打断时 from 取 vrun.interrupt()（最近一次已呈现帧的媒体时间），不取墙钟 / video.currentTime；转场前 settle 完同一个任务里 dispose 视频', /vrunRef\.current\?\.interrupt\(\) \?\? \(p \? p\.time : 0\)/.test(bs) && /const startNow = \(\) => \{ vrunRef\.current\?\.dispose\(\); start\(\); \}/.test(bs) && !/currentTime/.test(bs));
    ok('BootSplash：退路 onFallback = suspend → settle(from) → （丢帧退路：等媒体时间追上 from）→ dispose 视频 → resumeLive（比例越界则 jumpToEnd）；转场等 fbPending', /p\.suspend\(from\)/.test(bs) && /p\.resumeLive\(t\)/.test(bs) && /vr\.holdAt\(from\)/.test(bs) && /fbPending\.current\.then\(go\)/.test(bs));
    ok('BootSplash：页面隐藏同步暂停 / 恢复视频；resize 视频期间只改 <video> 的 CSS 尺寸，越界走 fallback(\'resize\')', /vrunRef\.current\?\.setHidden\(document\.hidden\)/.test(bs) && /vr\.layout\(/.test(bs) && /vr\.fallback\('resize'\)/.test(bs));
    const vr = noC(rd('src/components/decor/boot/videoRun.ts'));
    ok('videoRun：rVFC 记 (mediaTime, expectedDisplayTime)；error / ended / stalled / waiting 监听；50 ms 一次卡死判据、500 ms 一次 getVideoPlaybackQuality；退路只触发一次', /requestVideoFrameCallback/.test(vr) && /this\.on\('error'/.test(vr) && /this\.on\('ended'/.test(vr) && /getVideoPlaybackQuality/.test(vr) && /setInterval\(\(\) => this\.check\(\), 50\)/.test(vr) && /if \(this\.fellBack \|\| !this\.active\) return/.test(vr));
    ok('videoRun：交接 = scene.video.handoff(120)，淡完 dispose（pause + 清 src + load()）；媒体时间 ≥ 7.15 s 才预光栅', /scene\.video\.handoff\(BV\.handoffFadeMs\)/.test(vr) && /this\.clock\.media >= BV\.handoffPre/.test(vr) && /removeAttribute\('src'\)/.test(noC(rd('src/components/decor/boot/bootVideo.ts'))));
    const ds = noC(rd('src/components/decor/boot/dayScene.ts'));
    ok('dayScene：视频期间 render(t) = renderLive：文字 + 光尘 + 蝶 / 雪点 / B 类 fx + 清晰立绘层的镜头与淡入（renderFx(t, z, \'live\')）；begin() 给舞台加 is-vid、2.3 s 起加 is-ov；settle 的第一步在视频模式下走 vidSettle', /function renderLive\(t: number\) \{\s*renderDom\(t\);/.test(ds) && /renderFx\(t, z, 'live'\)/.test(ds) && /host\.classList\.add\('is-vid'\)/.test(ds) && /host\.classList\.add\('is-ov'\)/.test(ds) && /if \(vidOn\) return vidSettle\(t\)/.test(ds));
    ok('dayScene：预光栅 = 摘 is-vid + 环境层（vidLayers：底板 / 光束 / 花海条；枝不在其中，它全程实时）opacity .001 + renderStage(T_END)；交接 = 同一任务补 render(T_END) + WAAPI opacity .001 → 1；打断 settle 先画 live 档 fx、等 2 个 rAF 再等合成器缓过来（SETTLE_QUIET_DT）才放行，之后 opacity 设 1 且 fx 画满', /host\.classList\.remove\('is-vid'\);\s*for \(const n of vidLayers\(\)\) n\.style\.opacity = '0\.001';\s*renderStage\(T_END\)/.test(ds) && /n\.animate\(\[\{ opacity: 0\.001 \}, \{ opacity: 1 \}\]/.test(ds) && /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{\s*if \(gone\)/.test(ds) && /SETTLE_QUIET_DT/.test(ds) && /renderFx\(t, z, 'live'\);\s*renderDom\(t\);/.test(ds));
    ok('dayScene：视频期间枝全程实时：renderLive 第一拍写枝的初始态、t ≥ TWIG_LIVE_FROM（= DT.twig[0] − 0.1 = 1.2 s）起写镜头 + renderTwig(t)（与 renderStage 共用的枝 / 白花 / 落蝶光晕）；vidLayers 里没有枝；视频母版（setLayers vid）把 .s0-twig 整层 display:none',
      /const TWIG_LIVE_FROM = DT\.twig\[0\] - 0\.1/.test(ds) && /if \(!twLiveInit\) \{ twLiveInit = true; renderTwig\(0\); \}/.test(ds) && /if \(t >= TWIG_LIVE_FROM \|\| t >= ovPreAt\(\)\) setZ\(el\.world, z\);\s*if \(t >= TWIG_LIVE_FROM\) renderTwig\(t\);/.test(ds) && /function renderTwig\(t: number\)/.test(ds) && /\n\s*renderTwig\(t\);\s*\n\s*/.test(ds)
      && /const vidLayers = \(\): HTMLElement\[\] => \[el\.ph, beamsWrap, el\.near1\];/.test(ds) && /twigSvg\.style\.display = vidMaster \? 'none' : ''/.test(ds) && !/is-vid \.s0-tw/.test(rd('src/styles/boot.css')));
    ok('清晰立绘层提前栅格（ovPre）落在枝的第一滴墨（≈ 1.85 s）之前：约 30 ms 的一次性栅格代价不能撞在枝尖最快的 1.9–2.5 s 上；且不早于枝开始描画前 0.1 s 的镜头起点以外的任何东西', DAY.DAY_VID.ovPre <= 1.6 && DAY.DAY_VID.ovPre >= DAY.DT.twig[0] - 0.1);
    ok('dayScene：视频模式的 prepare 不烘绽开画布 / 花海条画布 / 散花画布（const vid = vidOn），也不锁 hold、不提升光束（setupFast 里 if (vidOn) return）', /const vid = vidOn;/.test(ds) && /if \(!vid && st\) \{/.test(ds) && /fastOn = true;\s*if \(vidOn\) return;/.test(ds));
    ok('dayScene：DEV 导出钩子 layers:\'bg\' | \'vid\'（setLayers：光尘不画、.bd-text 隐藏；vid = 视频母版：蝶 / 雪点隐藏、fx 只画 A 类、ovTo 起立绘 / 近景散花不画、ovFrom–ovTo 里立绘组按 α 重映射）；BootSplash 的 seek 接 layers 选项', /layersBg = mode !== 'all'/.test(ds) && /vidMaster = mode === 'vid'/.test(ds) && /function masterOvRemap/.test(ds) && /a \* \(1 - q\) \/ \(1 - q \* a\)/.test(ds) && /scene\.setLayers\?\.\(opts\.layers \?\? 'all'\)/.test(bs));
    const pl = noC(rd('src/components/decor/boot/player.ts'));
    ok('player：timeSource = PlayerMedia（at / tick / end）；时间到头先 end()（交接）再画最后一帧并改回墙钟（t0 = now − D）；suspend / resumeLive 给退路用', /interface PlayerMedia/.test(pl) && /m \? m\.at\(now/.test(pl) && /if \(m\) \{ this\.media = undefined; this\.t0 = now - D \* 1000; m\.end\?\.\(\); \}/.test(pl) && /suspend\(fromT: number\)/.test(pl) && /resumeLive\(fromT: number\)/.test(pl));
    ok('earlyBoot：昼想用视频时同样提前 preloadBootVideo（与图片预加载并行）；prefsKeys 读 bootVideo；seed 默认 false（实时，2026-10-29 改回）；设置里有「昼开屏」行与「视频（试验）」', /preloadBootVideo\(/.test(rd('src/lib/earlyBoot.ts')) && /bootVideo: typeof settings\?\.bootVideo === 'boolean'/.test(rd('src/state/prefsKeys.ts')) && /bootVideo: false,/.test(rd('src/state/seed.ts')) && /bootVideo: boolean/.test(rd('src/lib/types.ts')) && /视频（试验）/.test(rd('src/components/views/settings/AppearanceSection.tsx')) && /title="昼开屏"/.test(rd('src/components/views/settings/AppearanceSection.tsx')));
    const css = rd('src/styles/boot.css');
    ok('boot.css：.boot__vbox 裁切 + .boot__vid 最底层；.is-vid 时底板 / 光束 / 花海条 / 枝 visibility:hidden，立绘层（.bd-bloom）等 .is-ov', /\.boot__vbox \{[^}]*overflow: hidden/.test(css) && /\.boot__vid \{/.test(css) && /\.boot__stage\.is-vid \.boot__ph, \.boot__stage\.is-vid \.bd-beams/.test(css) && /\.boot__stage\.is-vid:not\(\.is-ov\) \.bd-bloom \{ visibility: hidden; \}/.test(css) && !/\.is-vid \.bd-bfwrap/.test(css));
    ok('夜的开屏一行不动：nightScene.ts / nightComp.ts / transitionNight.ts 里没有视频版的任何东西', ['nightScene.ts', 'nightComp.ts', 'transitionNight.ts'].every((f) => !/bootVideo|SceneVideo|\.video\b|vidOn|is-vid/.test(rd(`src/components/decor/boot/${f}`))));
    ok('readEarlyPrefs 读 bootVideo（布尔才认）；其余字段的老断言不变', (() => {
      const st = (m: Record<string, string>) => ({ getItem: (k: string) => (k in m ? m[k] : null) });
      const a = readEarlyPrefs(st({ 'alight/prefs': JSON.stringify({ settings: { bootVideo: false } }) }));
      const b = readEarlyPrefs(st({ 'alight/prefs': JSON.stringify({ settings: { bootVideo: 'yes' } }) }));
      return a.bootVideo === false && b.bootVideo === undefined;
    })());
    ok('readEarlyPrefs：settingsRev < 5（或没存修订号）的 bootVideo true 是 beta.4 / beta.5 的旧默认，按假读（与 migrateSettings 同口径，升级后第一次启动不白读视频）；5 起照办；false 一律是假', (() => {
      const at = (settingsRev: number | undefined, bootVideo: boolean) => readEarlyPrefs({ getItem: (k: string) => (k === 'alight/prefs' ? JSON.stringify({ settingsRev, settings: { bootVideo } }) : null) }).bootVideo;
      return at(4, true) === false && at(undefined, true) === false && at(5, true) === true && at(6, true) === true && at(4, false) === false && at(5, false) === false;
    })());
  }
}

console.log(`\n开屏纯函数检查：${total - failed}/${total} 通过${failed ? `，${failed} 项失败` : ''}`);
process.exit(failed ? 1 : 0);
