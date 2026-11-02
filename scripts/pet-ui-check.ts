/* 桌宠窗口页面侧的纯逻辑检查：
     npx rolldown scripts/pet-ui-check.ts --platform node --format esm --file node_modules/.cache/pet-ui-check.mjs && node node_modules/.cache/pet-ui-check.mjs
   覆盖：聊天记录的合并和 60 条上限、输入框按键的意思、标题下的状态、童话信笺 / 接龙状态条 / 占卜牌的显示字、
   窗口尺寸、光标换视线、拖动速度、心情的决定、点击穿透的形状、引蝶（鼠标停住的判定、落点、只数、倒计时、起飞、边界）。
   无 GUI、无网络、不启动 Electron、不依赖 React / DOM；小游戏的牌和台词（src/pet/games/*，代理 B）不在这里测。 */
import { isDeepStrictEqual } from 'node:util';

import type { PetChatEntry, PetChatMsg, PetGameState } from '../src/pet/contracts';
import { CHAT_MAX, applyChat, atEnd, cardIcon, chatActivity, composerKey, fullText, gameBar, startsRun, taleSaved, taleView } from '../src/pet/ui/chatLog';
import {
  ARENA_H, ARENA_W, COUNT_MS, JITTER_PX, LAND_PX, NEAR_PX, STILL_MS, createSim, isStill, noStill, pickCount, secondsLeft, simDone, stepSim, timeUp, trackStill,
  type Cursor, type Sim,
} from '../src/pet/ui/gameLogic';
import { PET_H, PET_W, RIG_H, TOP_H, dragSpeed, insideFigure, lookVector, mouthLevel, rigMood, tarotIconSrc } from '../src/pet/ui/petLogic';

let failed = 0;
let passed = 0;
function eq(name: string, got: unknown, want: unknown) {
  if (!isDeepStrictEqual(got, want)) {
    failed += 1;
    console.error(`  FAIL ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  } else { passed += 1; if (!process.env.QUIET) console.log(`  ok  ${name}`); }
}
const ok = (name: string, cond: boolean, extra = '') => eq(name + (cond || !extra ? '' : ` (${extra})`), cond, true);
const section = (t: string) => console.log(`\n${t}`);

/** 固定种子的随机数：每次跑都一样。 */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const her = (id: string, text: string, extra: Partial<PetChatEntry> = {}): PetChatEntry => ({ id, who: 'her', text, at: 1_700_000_000_000, ...extra });
const me = (id: string, text: string): PetChatEntry => ({ id, who: 'me', text, at: 1_700_000_000_000 });

/* ═════════════ 窗口尺寸（PET-PLAN §5） ═════════════ */
section('窗口尺寸');
eq('她 340×360，头顶 230，合 340×590', [PET_W, RIG_H, TOP_H, PET_H], [340, 360, 230, 590]);
ok('引蝶的游戏区在窗口里（宽不超过窗口、高不超过窗口）', ARENA_W <= PET_W && ARENA_H <= PET_H);

/* ═════════════ 聊天记录 ═════════════ */
section('聊天记录：合并、更新、撤回、60 条上限');
{
  eq('CHAT_MAX 是 60', CHAT_MAX, 60);
  let log: PetChatEntry[] = [];
  log = applyChat(log, { op: 'put', entry: me('1', '你好') });
  log = applyChat(log, { op: 'put', entry: her('2', '嗯', { streaming: true }) });
  eq('加两条', log.map((e) => e.id), ['1', '2']);
  log = applyChat(log, { op: 'put', entry: her('2', '嗯，我在', { streaming: true }) });
  eq('同一个 id 长在原处（不新增）', [log.length, log[1].text], [2, '嗯，我在']);
  log = applyChat(log, { op: 'put', entry: her('2', '嗯，我在。') });
  eq('写完后 streaming 没了', log[1].streaming, undefined);
  const before = log;
  eq('撤回不存在的 id：原样（同一个数组）', applyChat(log, { op: 'drop', id: 'x' }) === before, true);
  log = applyChat(log, { op: 'drop', id: '1' });
  eq('撤回一条', log.map((e) => e.id), ['2']);
  const many: PetChatEntry[] = Array.from({ length: 80 }, (_, i) => me(`m${i}`, `${i}`));
  const reset = applyChat([], { op: 'reset', entries: many });
  eq('reset 只留最后 60 条', [reset.length, reset[0].id, reset[59].id], [60, 'm20', 'm79']);
  let grow: PetChatEntry[] = [];
  for (let i = 0; i < 75; i++) grow = applyChat(grow, { op: 'put', entry: me(`g${i}`, `${i}`) });
  eq('逐条加到 75 条，只留最近 60', [grow.length, grow[0].id, grow[59].id], [60, 'g15', 'g74']);
  const upd = applyChat(grow, { op: 'put', entry: me('g20', '改过') });
  eq('更新已有的一条不挤掉别的', [upd.length, upd.find((e) => e.id === 'g20')?.text], [60, '改过']);
  const msg: PetChatMsg = { op: 'put', entry: her('t1', '', { kind: 'tale', tale: { id: '', words: ['雪', '灯', '蝶'], title: '雪地里的灯', text: '从前……', at: 1 } }) };
  eq('信笺消息原样进记录（带 tale）', applyChat([], msg)[0].tale?.title, '雪地里的灯');
}

section('输入框按键：发送 / 关闭 / 输入法');
{
  eq('Enter 发送', composerKey({ key: 'Enter' }), 'send');
  eq('Shift+Enter 换行', composerKey({ key: 'Enter', shiftKey: true }), null);
  eq('Esc 关闭', composerKey({ key: 'Escape' }), 'close');
  eq('输入法选字时 Enter 归输入法', composerKey({ key: 'Enter', isComposing: true }), null);
  eq('输入法选字时 Esc 归输入法', composerKey({ key: 'Escape', isComposing: true }), null);
  eq('keyCode 229（部分输入法）也不算', composerKey({ key: 'Enter', keyCode: 229 }), null);
  eq('别的键没意思', composerKey({ key: 'a' }), null);
}

section('标题下她在做什么 / 头像 / 滚动');
{
  eq('没有在写的：null', chatActivity([me('1', 'x'), her('2', 'y')]), null);
  eq('「让我想想」那条在写：think', chatActivity([her('2', '嗯……', { streaming: true, mood: 'think' })]), 'think');
  eq('正在写字：typing', chatActivity([her('2', '嗯，我', { streaming: true, mood: 'talk' })]), 'typing');
  eq('别人的话还在长不算她', chatActivity([{ ...me('1', 'x'), streaming: true }]), null);
  eq('完整回答用 more', fullText(her('1', '前面', { more: '前面和后面' })), '前面和后面');
  const log = [me('1', 'a'), her('2', 'b'), her('3', 'c'), me('4', 'd')];
  eq('她连说几条只在第一条带头像', log.map((_, i) => startsRun(log, i)), [true, true, false, true]);
  eq('离底部不到 24 像素算在底部', [atEnd(100, 300, 180), atEnd(80, 300, 180)], [true, false]);
}

section('童话信笺 / 接龙状态条 / 占卜牌');
{
  const tale = { id: 't', words: ['雪', '灯'], title: '雪地里的灯', text: '从前，有一盏灯。', at: 1 };
  eq('带 tale 的消息：标题与正文取自 tale', taleView(her('1', '随便', { kind: 'tale', tale })), { title: '雪地里的灯', body: '从前，有一盏灯。' });
  eq('没有 tale：认《标题》开头', taleView(her('1', '《月下》\n很久以前。', { kind: 'tale' })), { title: '月下', body: '很久以前。' });
  eq('没有标题：整段是正文', taleView(her('1', '很久以前。', { kind: 'tale' })), { title: '', body: '很久以前。' });
  eq('长回答 more 也认标题', taleView(her('1', '《月》', { kind: 'tale', more: '《月》\n正文' })), { title: '月', body: '正文' });
  const g = (s: Partial<PetGameState> & { kind: PetGameState['kind'] }): PetGameState => ({ active: true, ...s });
  eq('接龙：有 hint 用 hint', gameBar(g({ kind: 'chain', hint: '轮到你，接「棠」' })), { kind: 'chain', text: '接龙中 · 轮到你，接「棠」' });
  eq('接龙：没有 hint 用 nextChar', gameBar(g({ kind: 'chain', nextChar: '棠' })), { kind: 'chain', text: '接龙中 · 轮到你，接「棠」' });
  eq('接龙：什么都没有', gameBar(g({ kind: 'chain' })), { kind: 'chain', text: '接龙中 · 开始了' });
  eq('童话：默认提示「给我三个词」', gameBar(g({ kind: 'tale' })), { kind: 'tale', text: '写童话 · 给我三个词' });
  eq('不在进行：没有状态条', gameBar({ kind: 'chain', active: false }), null);
  eq('没有状态：没有状态条', gameBar(null), null);
  eq('占卜 / 引蝶在自己的面板里，聊天框没有状态条', [gameBar(g({ kind: 'tarot' })), gameBar(g({ kind: 'butterfly' }))], [null, null]);
  eq('命途图标路径', cardIcon('remembrance'), './art/her/path-remembrance-s.webp');
  eq('命途图标路径不让 ../ 之类混进来', cardIcon('../x/hunt'), './art/her/path-xhunt-s.webp');
  const e = her('1', '', { kind: 'tale', tale });
  eq('已存下：本页刚存过', taleSaved(e, new Set(['1']), new Set()), true);
  eq('已存下：id 在名单里', taleSaved(e, new Set(), new Set(['t'])), true);
  eq('没存：都不在', taleSaved(e, new Set(), new Set(['z'])), false);
  eq('没存：tale 没有 id', taleSaved(her('2', '', { kind: 'tale', tale: { ...tale, id: '' } }), new Set(), new Set([''])), false);
  eq('牌面图标：命途名', tarotIconSrc('remembrance'), './art/her/path-remembrance.webp');
  eq('牌面图标：path- 前缀', tarotIconSrc('path-hunt'), './art/her/path-hunt.webp');
  eq('牌面图标：文件名', tarotIconSrc('path-erudition.webp'), './art/her/path-erudition.webp');
  eq('牌面图标：art/her/ 路径', tarotIconSrc('art/her/path-preservation.webp'), './art/her/path-preservation.webp');
  eq('牌面图标：带 ./ 和 / 前缀', tarotIconSrc('/art/her/path-hunt.webp'), './art/her/path-hunt.webp');
}

/* ═════════════ 光标、拖动、嘴、心情 ═════════════ */
section('光标 → 视线、拖动速度、嘴、心情');
{
  eq('在头正前方：0,0', lookVector(0, 0, 500), { x: 0, y: 0 });
  eq('右下方一半的距离', lookVector(250, 250, 500), { x: 0.5, y: 0.5 });
  eq('太远了夹在 ±1', lookVector(-9000, 9000, 500), { x: -1, y: 1 });
  eq('NaN 当作没动', lookVector(NaN, 3, 500), { x: 0, y: 0 });
  eq('range 为 0 不除零', lookVector(1, 1, 0), { x: 1, y: 1 });
  eq('时间间隔太短不算', dragSpeed({ x: 0, y: 0, t: 0 }, { x: 5, y: 5, t: 2 }), null);
  eq('速度（像素 / 秒）', dragSpeed({ x: 0, y: 0, t: 0 }, { x: 10, y: -20, t: 100 }), { vx: 100, vy: -200 });
  eq('速度有上限', dragSpeed({ x: 0, y: 0, t: 0 }, { x: 1000, y: 0, t: 10 })?.vx, 4000);
  eq('响度 0 → 嘴 0；0.35 → 约满；超过夹在 1', [mouthLevel(0), mouthLevel(0.35) > 0.99, mouthLevel(5), mouthLevel(-1)], [0, true, 1, 0]);
  const base = { speaking: false, babbling: false, chat: false, watching: false };
  eq('睡 / 想 / 高兴 / 害羞 / 惊讶 保持', (['sleep', 'think', 'happy', 'shy', 'surprised'] as const).map((feel) => rigMood({ ...base, feel })), ['sleep', 'think', 'happy', 'shy', 'surprised']);
  eq('说话（有声音）→ talk', rigMood({ ...base, feel: 'idle', speaking: true }), 'talk');
  eq('没有声音的台词动嘴 → talk', rigMood({ ...base, feel: 'talk', babbling: true }), 'talk');
  eq('聊天框开着 → watch', rigMood({ ...base, feel: 'idle', chat: true }), 'watch');
  eq('在看屏 → watch', rigMood({ ...base, feel: 'idle', watching: true }), 'watch');
  eq('什么都没有 → idle', rigMood({ ...base, feel: 'idle' }), 'idle');
  eq('talk 心情但没在说 → idle', rigMood({ ...base, feel: 'talk' }), 'idle');
  eq('高兴压过说话（笑着说）', rigMood({ ...base, feel: 'happy', speaking: true }), 'happy');
}

section('点击穿透的粗判（木偶没好时的矩形；正常按 rig.hitTest 的轮廓）');
{
  const box = { x: 50, y: 60, w: 240, h: 300 };
  ok('中心点中', insideFigure(box, 170, 210));
  ok('四条边的中点中', insideFigure(box, 50, 210) && insideFigure(box, 290, 210) && insideFigure(box, 170, 60) && insideFigure(box, 170, 360));
  ok('四个角不中（空的）', !insideFigure(box, 51, 61) && !insideFigure(box, 289, 61) && !insideFigure(box, 51, 359) && !insideFigure(box, 289, 359));
  ok('矩形外不中', !insideFigure(box, 10, 210) && !insideFigure(box, 170, 400));
  ok('宽高为 0 的矩形永远不中（木偶还没量出来）', !insideFigure({ x: 0, y: 0, w: 0, h: 0 }, 0, 0));
}

/* ═════════════ 引蝶 ═════════════ */
section('引蝶：鼠标停住的判定');
{
  let s = noStill();
  ok('没有任何位置时不算停住', !isStill(s, 99_999));
  s = trackStill(s, 100, 100, 1000);
  ok('刚收到位置：还没停住', !isStill(s, 1000));
  ok('停住差 1 毫秒：不算', !isStill(s, 1000 + STILL_MS - 1));
  ok('停住满 0.6 秒：算', isStill(s, 1000 + STILL_MS));
  s = trackStill(s, 100 + JITTER_PX, 100, 1300);
  eq('抖动不超过 JITTER_PX：锚点和计时不变', [s.x, s.y, s.at], [100, 100, 1000]);
  s = trackStill(s, 100 + JITTER_PX + 1, 100, 1400);
  eq('超过一点点就算动了：锚点换、计时重来', [s.x, s.at], [100 + JITTER_PX + 1, 1400]);
  ok('动了之后不算停住', !isStill(s, 1400 + STILL_MS - 1));
  eq('STILL_MS 是 600', STILL_MS, 600);
}

section('引蝶：倒计时、只数、结束');
{
  eq('开局 30 秒', secondsLeft(0, 0, 30), 30);
  eq('过了 1 毫秒仍显示 30（向上取整）', secondsLeft(0, 1, 30), 30);
  eq('过了 1 秒显示 29', secondsLeft(0, 1000, 30), 29);
  eq('还剩 0.5 秒显示 1', secondsLeft(0, 29_500, 30), 1);
  eq('到点显示 0', secondsLeft(0, 30_000, 30), 0);
  eq('超时不出负数', secondsLeft(0, 99_000, 30), 0);
  eq('timeUp 边界', [timeUp(0, 29_999, 30), timeUp(0, 30_000, 30)], [false, true]);
  const r = rng(7);
  const counts = new Set(Array.from({ length: 400 }, () => pickCount(r)));
  eq('每局 5–9 只，五种都会出现', [...counts].sort(), [5, 6, 7, 8, 9]);
  eq('随机数 0 与 0.999… 的两端', [pickCount(() => 0), pickCount(() => 0.9999999)], [5, 9]);
  const sim = createSim(7, { x: 290, y: 200 }, rng(1));
  eq('开局 7 只，都还在等着从枝头飞出来', [sim.bfs.length, sim.total, sim.caught, sim.bfs.every((b) => b.mode === 'wait')], [7, 7, 0, true]);
  ok('一只一只错开飞出来（等待时间递增）', sim.bfs.every((b, i, a) => i === 0 || b.delay > a[i - 1].delay - 300));
  ok('全落稳就结束', simDone({ ...sim, caught: 7 }, 0, 100, 30));
  ok('没到点、没落稳不结束', !simDone({ ...sim, caught: 6 }, 0, 29_999, 30));
  ok('到点就结束', simDone({ ...sim, caught: 0 }, 0, 30_000, 30));
}

/** 往前跑 `seconds` 秒（30 帧 / 秒），每帧给 `cursor`。返回每帧之后的 caught，和有没有蝴蝶飞出区域。 */
function run(sim: Sim, seconds: number, cursor: () => Cursor | null) {
  const caught: number[] = [];
  let out = false;
  for (let i = 0; i < seconds * 30; i++) {
    stepSim(sim, 1 / 30, cursor());
    caught.push(sim.caught);
    for (const b of sim.bfs) if (!(b.x >= 0 && b.x <= ARENA_W && b.y >= 0 && b.y <= ARENA_H && Number.isFinite(b.x + b.y))) out = true;
  }
  return { caught, out };
}

section('引蝶：落点判定与只数');
{
  // 光标在区里不动：蝴蝶飞近就被引过来，落稳了才算；只数只增不减，不超过总数
  const still = createSim(7, { x: 290, y: 200 }, rng(3));
  const rs = run(still, 30, () => ({ x: 170, y: 200, still: true }));
  ok('光标停住 30 秒：至少落稳一只', rs.caught.at(-1)! >= 1, String(rs.caught.at(-1)));
  ok('只数只增不减', rs.caught.every((c, i, a) => i === 0 || c >= a[i - 1]));
  ok('只数不超过总数', rs.caught.at(-1)! <= still.total);
  ok('蝴蝶没有飞出游戏区、没有 NaN', !rs.out);
  // 光标一直在动：没有一只落下
  const moving = createSim(7, { x: 290, y: 200 }, rng(3));
  const rm = run(moving, 30, () => ({ x: 170, y: 200, still: false }));
  eq('光标一直在动：一只也没落', rm.caught.at(-1), 0);
  ok('光标在动时也没有蝴蝶落到光标上（没有 perch）', moving.bfs.every((b) => b.mode !== 'perch'));
  // 光标不在区里（null）：同样没有
  const away = createSim(7, { x: 290, y: 200 }, rng(3));
  eq('光标不在游戏区：一只也没落', run(away, 20, () => null).caught.at(-1), 0);
  // 太远的不会被引过来
  const far = createSim(1, { x: 20, y: 20 }, rng(5));
  far.bfs[0].mode = 'fly';
  far.bfs[0].x = 20; far.bfs[0].y = 20;
  stepSim(far, 1 / 30, { x: 20 + NEAR_PX + 30, y: 20, still: true });
  eq('距离超过 NEAR_PX：不被引', far.bfs[0].mode, 'fly');
  // 近的被引、落下、停满 COUNT_MS 才数
  const one = createSim(1, { x: 100, y: 100 }, rng(9));
  const b = one.bfs[0];
  b.mode = 'fly'; b.delay = 0; b.x = 100; b.y = 100;
  const cur: Cursor = { x: 100 + NEAR_PX - 10, y: 100, still: true };
  stepSim(one, 1 / 30, cur);
  eq('距离在 NEAR_PX 内、光标停住：转入降落', b.mode, 'land');
  let perchedAt = -1;
  for (let i = 0; i < 300 && one.caught === 0; i++) {
    stepSim(one, 1 / 30, cur);
    if ((b.mode as string) === 'perch' && perchedAt < 0) perchedAt = i;
  }
  ok('落下了', perchedAt >= 0);
  eq('落稳后算 1 只', one.caught, 1);
  ok('刚落下的那一刻还不算（要停满 COUNT_MS）', (() => {
    const t = createSim(1, { x: 100, y: 100 }, rng(9));
    const q = t.bfs[0];
    q.mode = 'perch'; q.delay = 0; q.x = 100; q.y = 100; q.perchMs = 0; q.ox = 0; q.oy = 0;
    const c: Cursor = { x: 100, y: 100, still: true };
    const frames = Math.floor((COUNT_MS - 40) / (1000 / 30));
    for (let i = 0; i < frames; i++) stepSim(t, 1 / 30, c);
    const early = t.caught;
    for (let i = 0; i < 6; i++) stepSim(t, 1 / 30, c);
    return early === 0 && t.caught === 1;
  })());
  // 光标动了：落着的受惊起飞，已数的仍算数，再停住也不再数第二次、也不再落下
  const cursorMoves: Cursor = { x: 100 + NEAR_PX - 10 + 80, y: 100, still: false };
  stepSim(one, 1 / 30, cursorMoves);
  eq('光标一动，落着的受惊起飞', b.mode as string, 'fly');
  eq('起飞后已数的仍算数', one.caught, 1);
  for (let i = 0; i < 200; i++) stepSim(one, 1 / 30, { x: b.x + 5, y: b.y, still: true });
  eq('数过的蝴蝶不会再落下、不会数第二次', [one.caught, b.mode as string], [1, 'fly']);
  // 全部落稳：simDone
  const all = createSim(5, { x: 170, y: 200 }, rng(11));
  const ra = run(all, 30, () => ({ x: 170, y: 200, still: true }));
  ok('整局里只数不超过总数（5 只）', ra.caught.at(-1)! <= 5);
  ok('LAND_PX 比 NEAR_PX 小得多（落的是光标，不是一大片）', LAND_PX * 5 < NEAR_PX);
  // 等待中的蝴蝶不动
  const wait = createSim(3, { x: 290, y: 200 }, rng(2));
  stepSim(wait, 0.05, null);
  ok('还在等的蝴蝶留在枝头', wait.bfs.filter((x) => x.mode === 'wait').every((x) => x.x === 290 && x.y === 200));
  // 同样的种子、同样的操作，结果一样
  const a1 = run(createSim(7, { x: 290, y: 200 }, rng(3)), 10, () => ({ x: 170, y: 200, still: true })).caught;
  const a2 = run(createSim(7, { x: 290, y: 200 }, rng(3)), 10, () => ({ x: 170, y: 200, still: true })).caught;
  eq('同一个种子、同样的光标：结果一样（可复现）', a1, a2);
}

console.log(`\n${failed ? 'FAILED' : 'ok'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
