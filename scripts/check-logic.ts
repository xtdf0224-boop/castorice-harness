/* 模块检查（logic）：npm run check:logic。无 GUI、无网络、不启动 Electron.
   覆盖（施工图 §7.1 的 check:logic 行）：exprTag 全部解析用例；settleExpr / moodWord；decideSticker 表驱动；pillsFor；isClosure 正反例；
   voiceGate G1–G11 表驱动（假时钟、内存存储）；canNudge 全部闸门与 nextNudgeAt；openingFor 四种分支；selectRetreat / selectTrail / makeGateSnap；
   设置动作（setLevel / setPersona / setProactive / quietFor / layDown / 记得小事 / dismissHer）；命令注册表的新命令；presence / ime / draft；
   proactive 的写入点（fireNudge / maybeGreet / fireRest 只断言接线：写进对话的消息形状、记账、降级路径）.
   依赖别人真实行为的地方（V1 的 say2 台词、E 的 live.reply）只断言接线，不断言桩的返回值. */
import { isDeepStrictEqual } from 'node:util';

import { hasInvite, isClosure, normalizeClosure } from '../src/lib/closure';
import { commandById, commands, findConflicts } from '../src/lib/commands';
import { clearDraft, hasDraft, setDraft, subscribeDraft } from '../src/lib/draft';
import { EXPR_IDS, STICKER_IDS } from '../src/lib/expr';
import { parseExprTags, stripExprTags } from '../src/lib/exprTag';
import { isComposingNow, setComposingForTest, subscribeComposing } from '../src/lib/ime';
import { CRISIS_WORD, EXPR_RESET, GRUMPY_ENABLED, RUN_CAP, exprWithSticker, moodWord, orchestratorWord, restingExpr, sceneMoodWord, settleExpr, type SettleCtx } from '../src/lib/mood';
import { PILL_SCENES, pillAfterOf, pillsFor, type PillCtx } from '../src/lib/pills';
import { CONTINUOUS_GAP_MS, continuousMinutes, continuousSince, lastInputAt, recordInput, resetPresenceForTest } from '../src/lib/presence';
import { STICKER_CAP, STICKER_GAP, decideSticker, isJoyScene, type StickerCtx } from '../src/lib/stickers';
import type { AppState, ExprId, Level, Message, Run, StickerId, Task } from '../src/lib/types';
import { actions } from '../src/state/actions';
import { AWAY_GREETING_MS, awayMinutes, greetSceneAt, openingFor, type OpeningFacts } from '../src/state/brief';
import {
  NUDGE_GRACE_MS, NUDGE_QUIET_MS, buildNudgeSnap, canNudge, fireNudge, fireRest, foregroundChat, maybeGreet, nextNudgeAt, reconcileResponses, reschedule, resetProactiveSchedForTest, setProactiveEnvForTest, settleRestIgnored, startProactive, type NudgeSnap,
} from '../src/state/proactive';
import { deriveQueue } from '../src/state/queue';
import { distanceOf, effectiveDistance, herOpened, makeGateSnap, selectHerCrisis, selectOrchestratorPresence, selectRetreat, selectTrail } from '../src/state/selectors';
import { DEFAULT_SETTINGS, emptyState } from '../src/state/seed';
import { store } from '../src/state/store';
import {
  DISMISS_PAIR_MS, HOURLY_BUDGET, NUDGE_DAY_CAP, NUDGE_SESSION_CAP, REST_AFTER_MIN, REST_IGNORE_MS, SESSION_CAP_TTL_MS, dayKey, gateLoadFailed, gateStats, greetedToday, isCrisisDay, nightKey,
  noteAccepted, noteAnswered, noteCrisis, noteDismiss, noteSpoken, resetGateForTest, restChip, sceneCountToday, settleIgnored, unansweredHer, voiceGate,
  type GateKind, type GateSnap, type GateStorage,
} from '../src/state/voiceGate';

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

/* ═════════════ exprTag ═════════════ */
section('exprTag：开头 / 结尾 / 容错 / 非法值');
{
  const p = parseExprTags;
  const T = (raw: string, o?: { final?: boolean }) => { const r = p(raw, o); return [r.text, r.expr, r.react, r.hold]; };
  eq('规范开头标签', T('⟦face:relaxed｜react:butterfly⟧你好'), ['你好', 'relaxed', 'butterfly', false]);
  eq('react 可省', T('⟦face:shy⟧嗯'), ['嗯', 'shy', undefined, false]);
  eq('键顺序无所谓', T('⟦react:like｜face:gentle⟧x'), ['x', 'gentle', 'like', false]);
  eq('〚〛 与混用的开闭括号', [T('〚face:confused〛x'), T('⟦face:gentle〛x')], [['x', 'confused', undefined, false], ['x', 'gentle', undefined, false]]);
  eq('分隔符 | 和 ,', [T('⟦face:gentle|react:create⟧x'), T('⟦face:gentle,react:create⟧x')], [['x', 'gentle', 'create', false], ['x', 'gentle', 'create', false]]);
  eq('容错括号 [[ ]] << >> [ ]（只在开头）', [T('[[face:shy]]x'), T('<<face:shy>>x'), T('[face:shy]x')], [['x', 'shy', undefined, false], ['x', 'shy', undefined, false], ['x', 'shy', undefined, false]]);
  eq('单括号不以 face:/react: 起头就不是标签', [T('[hello]x'), T('[1] 项目')], [['[hello]x', undefined, undefined, false], ['[1] 项目', undefined, undefined, false]]);
  eq('前导空白 / BOM', T('\uFEFF\n  ⟦face:relaxed⟧hi'), ['hi', 'relaxed', undefined, false]);
  eq('连续多个开头标签：每个键取第一个出现的值', T('⟦face:shy⟧⟦face:relaxed｜react:like⟧x'), ['x', 'shy', 'like', false]);
  eq('结尾标签', T('hello⟦face:relaxed⟧'), ['hello', 'relaxed', undefined, false]);
  eq('结尾标签前有空白 / 换行也认', T('hello\n  ⟦face:relaxed｜react:like⟧\n'), ['hello', 'relaxed', 'like', false]);
  eq('开头优先；结尾只补开头没给的键', T('⟦face:shy⟧hello⟦face:relaxed｜react:like⟧'), ['hello', 'shy', 'like', false]);
  eq('结尾也认容错括号（残片只认规范括号）', [T('hello [[face:shy]]'), T('hello <<face:shy>>'), T('hello [face:shy]'), T('hello [[face:sh', { final: false })], [['hello', 'shy', undefined, false], ['hello', 'shy', undefined, false], ['hello', 'shy', undefined, false], ['hello [[face:sh', undefined, undefined, false]]);
  eq('非法 face 值：标签剥掉、值忽略', T('⟦face:angry｜react:butterfly⟧x'), ['x', undefined, 'butterfly', false]);
  eq('非法 react 值（withering / takeoff 不在白名单）', [T('⟦face:shy｜react:withering⟧x'), T('⟦react:takeoff⟧x')], [['x', 'shy', undefined, false], ['x', undefined, undefined, false]]);
  eq('face:none 剥掉、无表情', T('⟦face:none⟧x'), ['x', undefined, undefined, false]);
  eq('大小写与空格宽容', T('⟦ FACE : Shy ⟧x'), ['x', 'shy', undefined, false]);
  eq('键不合法：不是标签，原样保留', [T('⟦mood:happy⟧x'), T('⟦face:shy｜mood:x⟧x')], [['⟦mood:happy⟧x', undefined, undefined, false], ['⟦face:shy｜mood:x⟧x', undefined, undefined, false]]);
  eq('体含中文 / 超长：不是标签', [T('⟦face:gentle 你好⟧x'), T(`⟦face:${'a'.repeat(50)}⟧x`)], [['⟦face:gentle 你好⟧x', undefined, undefined, false], [`⟦face:${'a'.repeat(50)}⟧x`, undefined, undefined, false]]);
  eq('only-tag 的空回复', T('⟦face:relaxed⟧'), ['', 'relaxed', undefined, false]);
  eq('空串', T(''), ['', undefined, undefined, false]);
  for (const id of EXPR_IDS) eq(`六个表情 ID 都认：${id}`, p(`⟦face:${id}⟧a`).expr, id);
  for (const id of STICKER_IDS) eq(`六个贴纸 ID 都认：${id}`, p(`⟦react:${id}⟧a`).react, id);
}

section('exprTag：围栏内不解析 / 中段剥离 / 工具前后各一个标签');
{
  const p = parseExprTags;
  const fenced = '```\n⟦face:shy⟧\n```';
  eq('围栏内的标签保留且不取', [p(fenced).text, p(fenced).expr], [fenced, undefined]);
  const mixed = '⟦face:shy⟧ok\n```js\n⟦face:relaxed⟧\n```';
  eq('开头标签生效，围栏内原样', [p(mixed).text, p(mixed).expr], ['ok\n```js\n⟦face:relaxed⟧\n```', 'shy']);
  eq('中段独占一行的标签连行去掉', p('你好\n⟦face:relaxed⟧\n再见').text, '你好\n再见');
  eq('中段行内标签去掉', p('a⟦face:shy⟧b').text, 'ab');
  eq('中段：规范括号 + 以 face:/react: 起头的 [[ ]] / << >> 才剥；单括号与不像标签的双括号不动', [p('a [[face:shy]] b').text, p('a <<react:like>> b').text, p('a [[hello]] b').text, p('a [face:shy] b').text], ['a  b', 'a  b', 'a [[hello]] b', 'a [face:shy] b']);
  const tool = '⟦face:gentle⟧先看一下\n\n⟦face:relaxed｜react:butterfly⟧好了';
  eq('工具前后各一个标签：第一个定表情，第二个（拼接中段）被剥', [p(tool).text, p(tool).expr, p(tool).react], ['先看一下\n\n好了', 'gentle', undefined]);
  const joined = '⟦face:gentle⟧一\n\n⟦face:shy⟧二\n\n⟦face:relaxed⟧三';
  eq('k.all 拼接多个气泡：中段标签全剥', stripExprTags(joined), '一\n\n二\n\n三');
  eq('stripExprTags 保留围栏内', stripExprTags('x⟦face:shy⟧y\n```\n⟦face:shy⟧\n```'), 'xy\n```\n⟦face:shy⟧\n```');
  eq('没有任何括号：原样返回', stripExprTags('普通文本 [1] <b>'), '普通文本 [1] <b>');
  const samples = [tool, joined, fenced, mixed, 'a⟦face:shy⟧b', '⟦face:shy⟧', '⟦face:shy⟧x⟦face:relaxed⟧', '⟦⟦face:shy⟧⟧x', '普通', ''];
  for (const x of samples) { const once = stripExprTags(x); eq(`stripExprTags 幂等：${JSON.stringify(x).slice(0, 24)}`, stripExprTags(once), once); }
  eq('嵌套括号不残留标签', /face:/.test(stripExprTags('⟦⟦face:shy⟧⟧x')), false);
  // 性能：长文本、成千上万个标签都是线性的
  const t0 = Date.now();
  const big = `${'普通文本。'.repeat(40_000)}`;
  parseExprTags(big); stripExprTags(big);
  const many = `${'段落⟦face:shy⟧\n'.repeat(5000)}`;
  const cleaned = stripExprTags(many);
  ok('长文本与 5000 个中段标签：都剥干净且 < 1 秒', !/⟦|face:/.test(cleaned) && Date.now() - t0 < 1000, `${Date.now() - t0}ms`);
}

section('exprTag：流式（hold / 残片 / 无泄漏）');
{
  const p = parseExprTags;
  eq('开头未收尾：hold 且不显示', [p('⟦face:rel').hold, p('⟦face:rel').text], [true, '']);
  eq('只有 ⟦：hold', [p('⟦').hold, p('⟦').text], [true, '']);
  eq('final:true 残片剥掉且不 hold', [p('⟦face:rel', { final: true }).hold, p('⟦face:rel', { final: true }).text], [false, '']);
  eq('结尾未收尾：正文保留、残片 hold', [p('你好⟦face:re').text, p('你好⟦face:re').hold], ['你好', true]);
  eq('结尾未收尾 final：剥掉残片', [p('你好⟦face:re', { final: true }).text, p('你好⟦face:re', { final: true }).hold], ['你好', false]);
  eq('⟦ 后面不像标签（中文）：当正文', [p('⟦你好').text, p('⟦你好').hold], ['⟦你好', false]);
  eq('⟦ 后面超过 48 字符还没收尾：当正文', [p(`⟦face:${'a'.repeat(60)}`).hold], [false]);
  eq('容错括号开头残片也 hold', [p('[[face:sh').hold, p('[face:sh').hold, p('<<face:sh').hold], [true, true, true]);
  eq('[ 开头的普通文字不 hold', [p('[fix] 修一下').hold, p('[1]').hold, p('[').hold], [false, false, false]);
  // 把整条回复一个字一个字喂进去：任何一刻可见文本都不含括号与标签残片
  for (const full of ['⟦face:relaxed｜react:butterfly⟧你好呀，今天过得怎么样', '你好呀，今天过得怎么样⟦face:relaxed｜react:butterfly⟧', '⟦face:shy⟧先看一下\n\n⟦face:gentle⟧好了', '[[face:shy]]好的']) {
    let leak = '';
    for (let i = 0; i <= full.length; i++) {
      const r = p(full.slice(0, i));
      if (/[⟦⟧〚〛]|face:|react:|\[\[|<</.test(r.text)) { leak = `${i}:${JSON.stringify(r.text)}`; break; }
    }
    eq(`逐字流式无泄漏：${full.slice(0, 14)}…`, leak, '');
    const fin = p(full, { final: true });
    ok(`流式结束：hold=false 且无括号：${full.slice(0, 10)}…`, !fin.hold && !/[⟦⟧]/.test(fin.text));
  }
  const growing = (s: string) => p(s).text.length;
  ok('可见文本只增不缩（逐字）', (() => { const full = '⟦face:shy⟧慢慢说，慢慢听。'; let last = 0; for (let i = 0; i <= full.length; i++) { const n = growing(full.slice(0, i)); if (n < last) return false; last = n; } return true; })());
}

/* ═════════════ settleExpr / moodWord ═════════════ */
section('settleExpr：危机 / 硬 gentle / 事件 / 候选 / 关键词 / 连续上限');
{
  const base = (o: Partial<SettleCtx> = {}): SettleCtx => ({ text: '好的', recent: [], lastAt: 0, now: 1000, level: 'm', kind: 'reply', ...o });
  for (const cand of EXPR_IDS) eq(`crisis 恒 gentle（候选 ${cand}）`, settleExpr(base({ kind: 'crisis', candidate: cand, event: 'done' })), 'gentle');
  for (const ev of ['approval', 'irreversible', 'apology', 'fail']) eq(`硬 gentle：事件 ${ev}（模型给 relaxed 也不听）`, settleExpr(base({ event: ev, candidate: 'relaxed' })), 'gentle');
  for (const kind of ['error', 'approval']) eq(`硬 gentle：kind ${kind}`, settleExpr(base({ kind, candidate: 'surprised', text: '诶' })), 'gentle');
  eq('硬 gentle 不受连续上限影响', settleExpr(base({ kind: 'error', recent: Array(9).fill('gentle') })), 'gentle');
  const EV: Array<[string, ExprId]> = [
    ['question', 'confused'], ['retry', 'confused'], ['fail-ext', 'confused'], ['done', 'relaxed'], ['joy', 'relaxed'], ['praised', 'shy'], ['nickname', 'shy'],
    ['late', 'surprised'], ['fast', 'surprised'], ['interrupted', 'surprised'], ['plan-ready', 'gentle'], ['plan-approved', 'gentle'], ['cancelled', 'gentle'],
  ];
  for (const [ev, want] of EV) eq(`事件 ${ev} → ${want}（压过模型候选）`, settleExpr(base({ event: ev, candidate: want === 'shy' ? 'relaxed' : 'shy' })), want);
  eq('未知事件名被忽略', settleExpr(base({ event: 'whatever', candidate: 'shy' })), 'shy');
  eq('kind question → confused；plan → gentle（压过候选）', [settleExpr(base({ kind: 'question', candidate: 'relaxed' })), settleExpr(base({ kind: 'plan', candidate: 'relaxed' }))], ['confused', 'gentle']);
  for (const id of EXPR_IDS) if (id !== 'grumpy') eq(`模型候选 ${id} 照用`, settleExpr(base({ candidate: id })), id);
  eq('grumpy 默认不启用：退 confused', [GRUMPY_ENABLED, settleExpr(base({ candidate: 'grumpy' })), settleExpr(base({ candidate: 'grumpy', level: 'l', kind: 'note' }))], [false, 'confused', 'confused']);
  eq('无标签无关键词 → gentle', settleExpr(base({ text: '收到。' })), 'gentle');
  eq('关键词：她正文头 12 字', [
    settleExpr(base({ text: '呼，做完了。' })), settleExpr(base({ text: '太好了，成了。' })), settleExpr(base({ text: '诶，是这样吗' })), settleExpr(base({ text: '真的吗……' })),
    settleExpr(base({ text: '唔……我想想' })), settleExpr(base({ text: '不好意思，说多了' })), settleExpr(base({ text: '我要想一想' })), settleExpr(base({ text: '这个我不太明白' })),
  ], ['relaxed', 'relaxed', 'surprised', 'surprised', 'shy', 'shy', 'confused', 'confused']);
  eq('关键词只看头 12 字', settleExpr(base({ text: `${'这是一段很长很长很长的话，'}呼，到这儿才有` })), 'gentle');
  eq('「称呼」「招呼」里的呼不算松口气', [settleExpr(base({ text: '请问怎么称呼你' })), settleExpr(base({ text: '打个招呼' }))], ['gentle', 'gentle']);
  eq('道歉里的「不好意思」不读成害羞', settleExpr(base({ text: '抱歉，不好意思，刚才弄错了' })), 'gentle');
  eq('用户夸她 / 叫昵称 → shy', [settleExpr(base({ userText: '你好厉害' })), settleExpr(base({ userText: '蝶宝在吗' }))], ['shy', 'shy']);
  eq('候选优先于关键词', settleExpr(base({ candidate: 'relaxed', text: '诶？' })), 'relaxed');
  // 连续上限：gentle ≤5，其余 ≤3
  eq('gentle 连续 5 条后换 relaxed', [settleExpr(base({ candidate: 'gentle', recent: Array(4).fill('gentle') })), settleExpr(base({ candidate: 'gentle', recent: Array(5).fill('gentle') }))], ['gentle', 'relaxed']);
  eq('其余连续 3 条后换相邻语义', [
    settleExpr(base({ candidate: 'shy', recent: ['shy', 'shy'] })), settleExpr(base({ candidate: 'shy', recent: ['shy', 'shy', 'shy'] })),
    settleExpr(base({ candidate: 'relaxed', recent: Array(3).fill('relaxed') })), settleExpr(base({ candidate: 'confused', recent: Array(3).fill('confused') })),
    settleExpr(base({ candidate: 'surprised', recent: Array(3).fill('surprised') })),
  ], ['shy', 'relaxed', 'gentle', 'gentle', 'gentle']);
  eq('连续被打断就从头数', settleExpr(base({ candidate: 'shy', recent: ['shy', 'shy', 'shy', 'gentle'] })), 'shy');
  eq('距上一次变化 ≥3 分钟当作新的开始', settleExpr(base({ candidate: 'shy', recent: Array(3).fill('shy'), lastAt: 1000, now: 1000 + EXPR_RESET.ms })), 'shy');
  eq('上限常量', [RUN_CAP.gentle, RUN_CAP.relaxed, RUN_CAP.shy, RUN_CAP.surprised, RUN_CAP.confused], [5, 3, 3, 3, 3]);
  // 长序列：不论候选怎么给，输出里没有超过上限的连续段
  let seq: ExprId[] = [];
  const pool: ExprId[] = ['gentle', 'gentle', 'gentle', 'relaxed', 'shy', 'confused', 'surprised'];
  let seed = 7;
  for (let i = 0; i < 400; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const cand = pool[seed % pool.length];
    seq = [...seq, settleExpr(base({ candidate: cand, recent: seq.slice(-8), lastAt: 1000, now: 1000 + i }))];
  }
  let worst = 0; let run = 0;
  for (let i = 0; i < seq.length; i++) { run = i && seq[i] === seq[i - 1] ? run + 1 : 1; worst = Math.max(worst, seq[i] === 'gentle' ? run - 5 : run - 3); }
  ok('400 条随机候选：没有超过上限的连续段', worst <= 0, `worst +${worst}`);
}

section('restingExpr / exprWithSticker / moodWord');
{
  eq('非 gentle 停留 <4 秒不复位', restingExpr('shy', { ageMs: 3000, later: 9 }), 'shy');
  eq('过了 4 秒但还没过 2 条消息也没到 3 分钟：保持', restingExpr('shy', { ageMs: 5000, later: 1 }), 'shy');
  eq('2 条消息后复位', restingExpr('shy', { ageMs: 5000, later: EXPR_RESET.messages }), 'gentle');
  eq('3 分钟后复位', restingExpr('shy', { ageMs: EXPR_RESET.ms, later: 0 }), 'gentle');
  eq('gentle 不变', restingExpr('gentle', { ageMs: 1e9, later: 9 }), 'gentle');
  eq('带贴纸的消息头像保持 gentle', [exprWithSticker('shy', true), exprWithSticker('shy', false)], ['gentle', 'shy']);
  eq('闲聊神色词', [
    moodWord({ surface: 'chat', streaming: true }), moodWord({ surface: 'chat', thinking: true }), moodWord({ surface: 'chat', idleMood: '在翻书' }), moodWord({ surface: 'chat' }),
  ], ['在写', '在想', '在翻书', '在线']);
  eq('工作神色词（每个词对应一个真实阶段）', (['planning', 'running', 'retry', 'awaiting', 'summary', 'failed', 'idle'] as const).map((phase) => moodWord({ surface: 'work', phase })),
    ['在写计划', '在做', '在重试', '停在这一步', '在收尾', '在收拾', '在线']);
  // 第 2 轮评审：胶囊写神色 / 状态，不写情绪——「抱歉」是情绪词，改「在收拾」；放下 = 停在这里；卡外那一句按场景取词（done.* 在收尾）.
  eq('编排者的状态词：在旁看着 / 在做 · 第 N 步 / 在做', [orchestratorWord({ watching: true }), orchestratorWord({ stepIndex: 2 }), orchestratorWord({})], ['在旁看着', '在做 · 第 3 步', '在做']);
  eq('放下：停在这里', moodWord({ surface: 'work', phase: 'laiddown' }), '停在这里');
  eq('卡外那一句的神色词（按场景）', ['approve.ask', 'approve.high', 'question.w', 'done.w', 'done.c', 'fail.w', 'fail.ext.w', 'laid.down', 'stop.w', 'task.start', undefined].map((sc) => sceneMoodWord(sc)?.word),
    ['停在这一步', '停在这一步', '停在这一步', '在收尾', '在收尾', '在收拾', '在收拾', '停在这里', '停在这里', undefined, undefined]);
  ok('神色词表里没有情绪词「抱歉」', !['approve.ask', 'done.w', 'fail.w', 'laid.down'].some((sc) => sceneMoodWord(sc)?.word === '抱歉') && moodWord({ surface: 'work', phase: 'failed' }) !== '抱歉');
  eq('工作已完成：不叠神色词（状态字已写「已完成」），idleMood 不顶上', [moodWord({ surface: 'work', phase: 'done' }), moodWord({ surface: 'work', phase: 'done', idleMood: '在读书' })], [undefined, undefined]);
  // 第 1 轮评审：危机回合 / 危机当天，名牌旁不能写「在读书」之类的活动词.
  const ACTIVITY = ['在读书', '在缝玩偶', '在看花', '在翻书', '在写信', '在整理照片'];
  const crisisWords = [
    moodWord({ surface: 'chat', crisis: true, idleMood: '在读书' }), moodWord({ surface: 'chat', crisis: true }),
    moodWord({ surface: 'work', crisis: true, phase: 'idle', idleMood: '在缝玩偶' }), moodWord({ surface: 'work', crisis: true, idleMood: '在看花' }),
  ];
  eq('危机：闲聊恒「在听」，工作空闲也是「在听」，不回退 idleMood', crisisWords, [CRISIS_WORD, CRISIS_WORD, CRISIS_WORD, CRISIS_WORD]);
  ok('危机下的神色词不在活动词表里', crisisWords.every((w) => !!w && !ACTIVITY.includes(w)));
  eq('危机当天仍在做事：阶段词是事实，照写', (['planning', 'running', 'awaiting', 'failed'] as const).map((phase) => moodWord({ surface: 'work', crisis: true, phase })), ['在写计划', '在做', '停在这一步', '在收拾']);
  eq('非危机不受影响；Agent 页不受危机影响', [moodWord({ surface: 'chat', crisis: false, idleMood: '在读书' }), moodWord({ surface: 'agents', crisis: true, agents: 'idle' })], ['在读书', '空闲']);
  eq('Agent 页神色词（编排者在做 / 在旁看着 与右栏同一个说法）', (['leading', 'present', 'idle', 'running', 'off'] as const).map((agents) => moodWord({ surface: 'agents', agents })), ['在做', '在旁看着', '空闲', '运行中', '歇着']);
}

/* ═════════════ decideSticker ═════════════ */
section('decideSticker：白名单 / 上限 / 禁区 / 返回约定');
{
  const base = (o: Partial<StickerCtx> = {}): StickerCtx => ({ level: 'l', mode: 'chat', kind: 'reply', expr: 'relaxed', requested: 'butterfly', sessionCount: 0, sinceLast: 99, retreat: false, ...o });
  eq('基本放行', decideSticker(base()), 'butterfly');
  for (const id of STICKER_IDS) eq(`白名单内都放行：${id}`, decideSticker(base({ requested: id })), id);
  eq('不在白名单的建议丢掉（withering / takeoff / 乱写）', [decideSticker(base({ requested: 'withering' as StickerId })), decideSticker(base({ requested: 'takeoff' as StickerId })), decideSticker(base({ requested: 'x' as StickerId }))], [undefined, undefined, undefined]);
  eq('没有建议也不是完成类：不出', decideSticker(base({ requested: undefined })), undefined);
  eq('完成类没有建议：done.* 默认 butterfly；道谢类不默认', [decideSticker(base({ requested: undefined, scene: 'done.w' })), decideSticker(base({ requested: undefined, scene: 'chat.thanks' }))], ['butterfly', undefined]);
  const never: Array<[string, Partial<StickerCtx>]> = [
    ['persona=false', { persona: false }], ['stickers=false', { enabled: false }], ['危机回合', { crisis: true }], ['主动话', { proactive: true }], ['内容卡里', { inCard: true }],
    ['Agent 页', { surface: 'agents' }], ['她退半步', { retreat: true }],
    ...(['approval', 'question', 'plan', 'step', 'tool', 'error', 'crisis', 'system'] as const).map((k): [string, Partial<StickerCtx>] => [`kind ${k}`, { kind: k }]),
  ];
  for (const [name, o] of never) eq(`永不出现：${name}`, decideSticker(base(o)), undefined);
  eq('危机 kind 即使 scene 是完成类也不出', decideSticker(base({ kind: 'crisis', scene: 'done.w' })), undefined);
  // 上限
  eq('少档：只有完成 / 道谢类，且 ≤1', [
    decideSticker(base({ level: 's' })), decideSticker(base({ level: 's', scene: 'chat.thanks' })), decideSticker(base({ level: 's', scene: 'done.w', sessionCount: 1 })),
  ], [undefined, 'butterfly', undefined]);
  eq(`中档：≤${STICKER_CAP.m}`, [decideSticker(base({ level: 'm', sessionCount: 0 })), decideSticker(base({ level: 'm', sessionCount: 1 })), decideSticker(base({ level: 'm', sessionCount: 2 }))], ['butterfly', 'butterfly', undefined]);
  eq(`多档：≤${STICKER_CAP.l}，且两张之间隔 ≥${STICKER_GAP} 条`, [
    decideSticker(base({ sessionCount: 0, sinceLast: 0 })), decideSticker(base({ sessionCount: 1, sinceLast: STICKER_GAP - 1 })), decideSticker(base({ sessionCount: 1, sinceLast: STICKER_GAP })),
    decideSticker(base({ sessionCount: 3, sinceLast: 50 })), decideSticker(base({ sessionCount: 4, sinceLast: 50 })),
  ], ['butterfly', undefined, 'butterfly', 'butterfly', undefined]);
  eq('工作模式只有完成 / 道谢类', [decideSticker(base({ mode: 'work' })), decideSticker(base({ mode: 'work', scene: 'phase.edit' })), decideSticker(base({ mode: 'work', scene: 'done.w' })), decideSticker(base({ mode: 'work', scene: 'done.w', kind: 'plan' }))], [undefined, undefined, 'butterfly', undefined]);
  // 第 2 轮评审：「完成」最适合发贴纸——中档、多档的 done.* 各给一次（没有模型建议也给 butterfly），退半步时不给；仍受每会话配额.
  eq('完成类 done.*：中 / 多档各一次，退半步不出', [
    decideSticker(base({ level: 'm', mode: 'work', scene: 'done.w', requested: undefined, expr: 'relaxed' })), decideSticker(base({ level: 'l', mode: 'work', scene: 'done.w', requested: undefined, expr: 'relaxed' })),
    decideSticker(base({ level: 'm', mode: 'work', scene: 'done.w', requested: undefined, retreat: true })), decideSticker(base({ level: 'l', mode: 'work', scene: 'done.w', requested: undefined, retreat: true })),
  ], ['butterfly', 'butterfly', undefined, undefined]);
  eq('完成贴纸仍受配额：中档第 3 张、多档第 5 张不出', [
    decideSticker(base({ level: 'm', mode: 'work', scene: 'done.w', requested: undefined, sessionCount: STICKER_CAP.m })), decideSticker(base({ level: 'l', mode: 'work', scene: 'done.w', requested: undefined, sessionCount: STICKER_CAP.l, sinceLast: 99 })),
  ], [undefined, undefined]);
  eq('dontthink 不会出现在审批里', decideSticker(base({ kind: 'approval', requested: 'dontthink' })), undefined);
  eq('isJoyScene', ['done.w', 'done', 'chat.thanks', 'chat.thanks.c', 'notify.done', 'doneish', 'chat.joy', undefined].map((x) => isJoyScene(x)), [true, true, true, true, false, false, false, false]);
  // 会话序列：按调用方的记账模拟 40 条她的消息，多档总量 ≤4、任意连续 10 条里 ≤1
  let count = 0; let since = 99; const hits: number[] = [];
  for (let i = 0; i < 40; i++) {
    const r = decideSticker(base({ sessionCount: count, sinceLast: since }));
    if (r) { count += 1; since = 0; hits.push(i); } else since += 1;
  }
  ok('多档 40 条消息：总量 ≤4，相邻两张至少隔 10 条', hits.length <= 4 && hits.every((h, i) => i === 0 || h - hits[i - 1] >= STICKER_GAP), JSON.stringify(hits));
}

/* ═════════════ pillsFor ═════════════ */
section('pillsFor：≤3、退出项在最后、不留客');
{
  const base = (o: Partial<PillCtx> = {}): PillCtx => ({ after: 'rest', level: 'm', persona: true, taskKind: 'chat', ...o });
  eq('工作任务 / persona=false / 危机：不出', [pillsFor(base({ taskKind: 'work' })), pillsFor(base({ persona: false })), pillsFor(base({ crisis: true }))], [[], [], []]);
  eq('other：不出', pillsFor(base({ after: 'other' })), []);
  const rest = pillsFor(base());
  eq('休息关照后：3 个，最后是「好，知道了」退出项（leave）', [rest.length, rest[rest.length - 1].exit, rest[rest.length - 1].exitAction, rest[0].accepts], [3, true, 'leave', true]);
  eq('少档休息关照：主选项 + 退出项', pillsFor(base({ level: 's' })).map((p) => [!!p.exit, p.exitAction ?? null]), [[false, null], [true, 'leave']]);
  const late = pillsFor(base({ after: 'late' }));
  eq('很晚之后：2 个，退出项是 leave', [late.length, late[late.length - 1].exitAction], [2, 'leave']);
  eq('休息 / 很晚的退出项叫「好，知道了」，不再摆第二个「今天别再提醒」', [rest[rest.length - 1].text, late[late.length - 1].text, [...rest, ...late].some((p) => /今天别再/.test(p.text))], ['好，知道了', '好，知道了', false]);
  const nudge = pillsFor(base({ after: 'nudge', level: 'l' }));
  eq('主动搭话之后：3 个，退出项是 leave（走 leave.c 短回，不调模型）', [nudge.length, nudge[2].exit, nudge[2].exitAction], [3, true, 'leave']);
  eq('少档主动搭话之后：2 个', pillsFor(base({ after: 'nudge', level: 's' })).length, 2);
  eq('小事类之后：只有多档出', [pillsFor(base({ after: 'small', level: 'l' })).length, pillsFor(base({ after: 'small', level: 'm' })).length, pillsFor(base({ after: 'small', level: 's' })).length], [3, 0, 0]);
  const CLINGY = /再聊|再陪|陪我|别走|不要走|再待|等一下|留下|舍不得|继续聊/;
  for (const after of ['rest', 'late', 'nudge', 'small'] as const) for (const level of ['s', 'm', 'l'] as Level[]) {
    const list = pillsFor(base({ after, level }));
    ok(`${after}×${level}：≤3、非空文案、只有最后一个是退出项、无留客词、id 在清单里`,
      list.length <= 3 && list.every((p, i) => p.text.trim().length > 0 && p.text.length <= 16 && !!p.exit === (i === list.length - 1) && !CLINGY.test(p.text) && p.id in PILL_SCENES),
      JSON.stringify(list));
  }
  ok('默认文案本身都不留客', Object.values(PILL_SCENES).every((t) => !CLINGY.test(t)));
  eq('pillAfterOf：按 src.scene 翻成胶囊类别', ['nudge.rest', 'late.c', 'sys.rest', 'nudge.photo', 'nudge.flower', 'world.x', 'done.w', undefined].map((x) => pillAfterOf(x)), ['rest', 'late', 'rest', 'nudge', 'nudge', 'small', 'other', 'other']);
}

/* ═════════════ isClosure ═════════════ */
section('isClosure：强 / 弱闭合语、问句词与邀请词、胶囊、待办');
{
  const done = { text: '做完了……太好了。结果和过程都在下面，有想改的地方，直接告诉我。', kind: 'note' as const, src: { id: 'done.w.w.m', mode: 'work' as const, scene: 'done.w' } };
  const chat = { text: '这个问题可以这样看，先从数据说起。', kind: 'reply' as const, src: undefined };
  const modelEvent = { text: '设置已经存好了。', kind: 'reply' as const, src: { id: 'x', mode: 'chat' as const, scene: 'chat.thanks' } };
  for (const t of ['谢谢', '谢谢你', '谢谢！', '辛苦了', '收到', '知道了', '明白了', '晚安', '好的，谢谢', '嗯嗯收到', '多谢啦']) ok(`强闭合语（任何陈述句之后）：${t}`, isClosure(t, { prev: chat }));
  for (const t of ['好', '嗯', '好的', '行', '可以', 'ok', 'OK.', '好哒', '嗯嗯', '好！']) {
    ok(`弱闭合语在事件类末句之后命中：${t}`, isClosure(t, { prev: done }));
    ok(`弱闭合语在普通陈述句之后不命中（常常是在同意提议）：${t}`, !isClosure(t, { prev: chat }));
  }
  ok('弱闭合语在 chat.thanks 之后命中', isClosure('好的', { prev: modelEvent }));
  ok('没有 src 的模型回复之后，弱闭合语不命中', !isClosure('好', { prev: { text: '好了。', kind: 'reply' } }));
  for (const t of ['好吧', '不谢', '谢谢，不过还有个问题', '谢谢你帮我解决了这个问题', '谢谢？', '', '   ', '好吗', '可以吗']) ok(`不是闭合语：${JSON.stringify(t)}`, !isClosure(t, { prev: done }));
  for (const [name, text] of [
    ['问号', '要不要我再改一下？'], ['吗', '需要我帮你看看吗'], ['要不要', '要不要先看第二步'], ['需要我', '需要我把测试也跑一遍'], ['请告诉', '请告诉我你的选择'], ['请选', '请选一个方案'],
    ['回我一声', '看完回我一声'], ['吧。收尾', '站起来走一走吧。'], ['想…就', '想聊就聊，想安静待着也好'], ['若…愿意', '若阁下愿意，我可以站近一些。'], ['哪件', '先做哪件，都可以'], ['还是', '是先收尾，还是接着往下做'], ['呢', '今天过得怎么样呢'],
  ] as const) {
    ok(`她上一条含邀请词，强闭合语也不命中：${name}`, !isClosure('谢谢', { prev: { text, kind: 'reply', src: { id: 'x', mode: 'chat', scene: 'done.w' } } }));
    ok(`她上一条含邀请词，弱闭合语也不命中：${name}`, !isClosure('好', { prev: { text, kind: 'reply', src: { id: 'x', mode: 'chat', scene: 'done.w' } } }));
  }
  ok('「有想改的地方，直接告诉我」是完成类话尾的软邀请，不挡', !hasInvite('结果在下面，有想改的地方，直接告诉我。') && !hasInvite('若觉得还差一点，我再改。'));
  ok('「请告诉我…」「回我一声」是邀请词', hasInvite('请告诉我下一步') && hasInvite('方便时回我一声'));
  ok('前一句有「告诉我」条件、后一句才是真邀请：按每个「告诉我」各自的前文判断', hasInvite('有问题直接告诉我。你想先做哪个，告诉我'));
  ok('她上一条带胶囊：不命中', !isClosure('谢谢', { prev: chat, hadPills: true }));
  ok('有待答问题 / 待批审批 / 待批计划：不命中', !isClosure('谢谢', { prev: chat, pending: true }));
  ok('工作进行中的追加：不命中', !isClosure('谢谢', { prev: chat, runningAppend: true }));
  ok('上一回合是危机：不命中', !isClosure('谢谢', { prev: { ...chat, crisis: true } }));
  ok('plan / error 之后：不命中', !isClosure('谢谢', { prev: { ...chat, kind: 'plan' } }) && !isClosure('谢谢', { prev: { ...chat, kind: 'error' } }));
  ok('审批 / 提问 / 计划 / 开工 / 阶段类场景之后：不命中', ['approve.ask', 'question.w', 'plan.intro', 'task.start', 'phase.read'].every((scene) => !isClosure('好', { prev: { text: '我先看一眼。', kind: 'note', src: { id: scene, mode: 'work', scene } } }) && !isClosure('谢谢', { prev: { text: '我先看一眼。', kind: 'note', src: { id: scene, mode: 'work', scene } } })));
  ok('没有她的上一条：不命中', !isClosure('谢谢', {}));
  ok('休息关照（nudge.rest）末句无邀请词：弱闭合语命中；以「吧。」收尾则不', isClosure('好', { prev: { text: '肩膀是不是有点僵？伸个懒腰，看看远处，喝口水。我这边稳稳守着。', kind: 'note', src: { id: 'x', mode: 'chat', scene: 'nudge.rest' } } }) === false
    && isClosure('好', { prev: { text: '伸个懒腰，看看远处，喝口水。我这边稳稳守着。', kind: 'note', src: { id: 'x', mode: 'chat', scene: 'nudge.rest' } } })
    && !isClosure('好', { prev: { text: '已经两小时了……站起来走一走吧。', kind: 'note', src: { id: 'x', mode: 'chat', scene: 'nudge.rest' } } }));
  eq('normalizeClosure：去标点空白、转小写', [normalizeClosure('  好的！'), normalizeClosure('OK.'), normalizeClosure('谢谢～ 😀')], ['好的', 'ok', '谢谢']);
}

/* ═════════════ voiceGate ═════════════ */
const MIN = 60_000;
const HOUR = 60 * MIN;
const at = (h: number, m = 0, dayOffset = 0) => new Date(2026, 9, 27 + dayOffset, h, m, 0, 0).getTime();
const T0 = at(14, 0);
const memStore = (): GateStorage & { data: Record<string, string> } => {
  const data: Record<string, string> = {};
  return { data, getItem: (k) => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
};
function freshGate(): ReturnType<typeof memStore>;
function freshGate<T extends GateStorage | null>(st: T): T;
function freshGate(st: GateStorage | null = memStore()) { resetGateForTest(st); return st; }
const gsnap = (o: Partial<GateSnap> = {}): GateSnap => ({
  level: 'l', persona: true, proactive: 'auto', lifeGreeting: true, quietUntil: 0, retreated: false, composing: false, taskId: 't1', hasDraft: false, continuousMinutes: 0, ...o,
});
const gate = (kind: GateKind, o: Partial<GateSnap> = {}, now = T0, scene = 'x.scene') => voiceGate(kind, scene, gsnap(o), now);
const brief = (r: { ok: boolean; mode: string; level: string; why?: string }) => [r.ok, r.mode, r.level];
const REST_SNAP = { continuousMinutes: REST_AFTER_MIN + 10 };

section('voiceGate G1：退后 / 安静');
{
  freshGate();
  for (const kind of ['reply', 'event', 'lead'] as GateKind[]) {
    eq(`G1 功能话 ${kind}：安静中 → 最短中性句（s 档）`, brief(gate(kind, { quietUntil: T0 + MIN })), [true, 'min', 's']);
    if (kind !== 'lead') eq(`G1 功能话 ${kind}：退后 → min`, brief(gate(kind, { retreated: true, retreatWhy: 'approval' })), [true, 'min', 's']);
  }
  eq('G1 功能话：输入法组合中 → min', brief(gate('reply', { composing: true })), [true, 'min', 's']);
  eq('G1 lead：退后的原因正是它自己要说的事（审批 / 提问 / 计划 / 失败）→ 照常说', (['approval', 'question', 'plan', 'failed'] as const).map((w) => gate('lead', { retreated: true, retreatWhy: w }).mode), ['her', 'her', 'her', 'her']);
  eq('G1 lead：ime / quiet 照常压；不知道原因也压', [gate('lead', { composing: true }).mode, gate('lead', { quietUntil: T0 + MIN, retreated: true, retreatWhy: 'quiet' }).mode, gate('lead', { retreated: true }).mode], ['min', 'min', 'min']);
  eq('G1 lead：审批退后 + 同时在安静一小时里 → 仍然压', gate('lead', { retreated: true, retreatWhy: 'approval', quietUntil: T0 + MIN }).mode, 'min');
  for (const kind of ['proactive', 'greet', 'aside'] as GateKind[]) {
    eq(`G1 非功能话 ${kind}：安静中 → silent`, brief(gate(kind, { quietUntil: T0 + MIN })), [false, 'silent', 'l']);
    eq(`G1 非功能话 ${kind}：退后 → silent`, gate(kind, { retreated: true }).mode, 'silent');
    eq(`G1 非功能话 ${kind}：输入法 → silent`, gate(kind, { composing: true }).mode, 'silent');
  }
  for (const kind of ['rest', 'late'] as GateKind[]) {
    eq(`G1 ${kind}：安静中 → line`, gate(kind, { ...REST_SNAP, quietUntil: T0 + MIN }).mode, 'line');
    eq(`G1 ${kind}：退后 → line`, gate(kind, { ...REST_SNAP, retreated: true }).mode, 'line');
  }
  eq('quietUntil 到点即过：不再算安静', gate('proactive', { quietUntil: T0 }).mode, 'her');
}

section('voiceGate G2 / G3 / G4：角色口吻、话量匹配、主动说话开关');
{
  freshGate();
  for (const kind of ['reply', 'event', 'lead'] as GateKind[]) eq(`G2 persona=false：功能话 ${kind} 照出（走 voice-facts）`, [gate(kind, { persona: false }).ok, gate(kind, { persona: false }).why], [true, 'persona-off']);
  for (const kind of ['proactive', 'greet', 'aside'] as GateKind[]) eq(`G2 persona=false：非功能话 ${kind} → silent`, gate(kind, { persona: false }).mode, 'silent');
  for (const kind of ['rest', 'late'] as GateKind[]) eq(`G2 persona=false：${kind} → line`, gate(kind, { ...REST_SNAP, persona: false }).mode, 'line');
  const m = (proactive: GateSnap['proactive'], level: Level) => gate('proactive', { proactive, level });
  eq('G3 auto 只在多档生效', [m('auto', 'l').mode, m('auto', 'm').mode, m('auto', 's').mode, m('auto', 'm').why], ['her', 'silent', 'silent', 'level-mismatch']);
  eq('G3 on：中、多档生效，少档恒不说', [m('on', 'l').mode, m('on', 'm').mode, m('on', 's').mode], ['her', 'her', 'silent']);
  eq('G4 off：proactive → silent', [m('off', 'l').mode, m('off', 'l').why], ['silent', 'proactive-off']);
  eq('G4 off：rest / late → line（只出系统行，不开口）', [gate('rest', { ...REST_SNAP, proactive: 'off' }).mode, gate('late', { ...REST_SNAP, proactive: 'off' }).mode], ['line', 'line']);
  eq('G4 off：greet 不受影响（由 lifeGreeting 管），aside / 功能话也不受影响', [gate('greet', { proactive: 'off' }).mode, gate('aside', { proactive: 'off' }).mode, gate('reply', { proactive: 'off' }).mode], ['her', 'her', 'her']);
  eq('greet 受 lifeGreeting 管；greet.first 一次性不受它管', [gate('greet', { lifeGreeting: false }).mode, voiceGate('greet', 'greet.first', gsnap({ lifeGreeting: false }), T0).mode], ['silent', 'her']);
  eq('greet.am 每天一次：说过之后同日 silent，次日又可以', (() => {
    freshGate();
    const a = voiceGate('greet', 'greet.am', gsnap(), T0).mode;
    noteSpoken('greet', 'greet.am', T0);
    return [a, voiceGate('greet', 'greet.noon', gsnap(), T0 + HOUR).mode, greetedToday(T0 + HOUR), voiceGate('greet', 'greet.am', gsnap(), T0 + 24 * HOUR).mode, greetedToday(T0 + 24 * HOUR)];
  })(), ['her', 'silent', true, 'her', false]);
}

section('voiceGate G5：每小时预算（滚动 60 分钟，非功能话；功能话与 rest/late 不计）');
{
  eq('常量：少 4 / 中 10 / 多 20；今天 3 次、每任务本会话 2 次；120 分钟；3 秒连关两次；会话降档 8 小时', [HOURLY_BUDGET, NUDGE_DAY_CAP, NUDGE_SESSION_CAP, REST_AFTER_MIN, DISMISS_PAIR_MS, SESSION_CAP_TTL_MS], [{ s: 4, m: 10, l: 20 }, 3, 2, 120, 3000, 8 * HOUR]);
  for (const level of ['s', 'm', 'l'] as Level[]) {
    freshGate();
    const cap = HOURLY_BUDGET[level];
    let last = '';
    for (let i = 0; i < cap; i++) {
      last = gate('aside', { level }, T0 + i * 1000, `aside.${i}`).mode;
      if (last !== 'her') break;
      noteSpoken('aside', `aside.${i}`, T0 + i * 1000);
    }
    eq(`G5 ${level} 档：前 ${cap} 句都放行`, [last, gateStats(T0 + cap * 1000).hourly], ['her', cap]);
    eq(`G5 ${level} 档：第 ${cap + 1} 句 silent（hourly-budget）`, [gate('aside', { level }, T0 + cap * 1000, 'aside.new').mode, gate('aside', { level }, T0 + cap * 1000, 'aside.new').why], ['silent', 'hourly-budget']);
    eq(`G5 ${level} 档：功能话与安全类不受拦`, [gate('reply', { level }, T0 + cap * 1000).mode, gate('event', { level }, T0 + cap * 1000).mode, gate('rest', { level, ...REST_SNAP }, T0 + cap * 1000).mode], ['her', 'her', 'her']);
    eq(`G5 ${level} 档：滚过 60 分钟就放回来`, gate('aside', { level }, T0 + HOUR + cap * 1000 + 1, 'aside.new').mode, 'her');
  }
  freshGate();
  for (let i = 0; i < 50; i++) noteSpoken('reply', `r.${i}`, T0 + i);
  noteSpoken('rest', 'nudge.rest', T0);
  eq('功能话与 rest 的记账不进每小时预算', gateStats(T0 + 100).hourly, 0);
}

section('voiceGate G6 / G8：同日同场景缩档、随手降档（假时钟）');
{
  freshGate();
  const lv = (level: Level, scene = 'phase.edit', kind: GateKind = 'aside', now = T0) => voiceGate(kind, scene, gsnap({ level }), now).level;
  eq('G6 第 1、2 次原档', [lv('l'), (noteSpoken('aside', 'phase.edit', T0), lv('l')), (noteSpoken('aside', 'phase.edit', T0), lv('l'))], ['l', 'l', 'm']);
  eq('G6 第 3 次起缩短一档：l→m、m→s、s 不再降', [lv('l'), lv('m'), lv('s')], ['m', 's', 's']);
  eq('G6 别的场景不受影响', lv('l', 'phase.read'), 'l');
  eq('G6 功能话也缩（approve.ask 连着出）', (() => { noteSpoken('lead', 'approve.ask', T0); noteSpoken('lead', 'approve.ask', T0); return lv('l', 'approve.ask', 'lead'); })(), 'm');
  eq('G6 次日重新数', lv('l', 'phase.edit', 'aside', T0 + 24 * HOUR), 'l');

  // G8 I-22：3 秒内连关两次 → 本会话降一档（只在内存）
  freshGate();
  const L = () => voiceGate('reply', 'any.scene', gsnap({ level: 'l' }), T0 + 100_000).level;
  noteDismiss('nudge.photo', 'x', T0);
  eq('G8 单次 x 不降', L(), 'l');
  noteDismiss('nudge.photo', 'x', T0 + DISMISS_PAIR_MS + 1);
  eq('G8 两次 x 隔了 >3 秒：不算连续，不降', L(), 'l');
  noteDismiss('nudge.photo', 'x', T0 + DISMISS_PAIR_MS + 1 + 2000);
  eq('G8 3 秒内第二次 x：本会话降一档（l→m），功能话也受影响', L(), 'm');
  eq('G8 降档同样作用于预算 / 匹配（auto 只在多档：降到 m 后主动话 silent）', voiceGate('proactive', 'nudge.x', gsnap({ level: 'l', proactive: 'auto' }), T0 + 100_000).why, 'level-mismatch');
  noteDismiss('nudge.photo', 'x', T0 + 10_000); noteDismiss('nudge.photo', 'x', T0 + 11_000);
  eq('G8 再来一对：再降一档（m→s），最多降两档', L(), 's');
  noteDismiss('nudge.photo', 'x', T0 + 20_000); noteDismiss('nudge.photo', 'x', T0 + 21_000);
  eq('G8 降档封顶两档（l 最低到 s）', L(), 's');
  eq('G8 8 小时后回落', voiceGate('reply', 'any.scene', gsnap({ level: 'l' }), T0 + 21_000 + SESSION_CAP_TTL_MS).level, 'l');
  eq('G8 不落盘：降档不写进存储', (() => { const st = memStore(); freshGate(st); noteDismiss('a', 'x', T0); noteDismiss('a', 'x', T0 + 1000); return JSON.stringify(st.data).includes('sessionDrop'); })(), false);
  // I-22 优先于 G6
  freshGate();
  noteSpoken('aside', 'phase.test', T0); noteSpoken('aside', 'phase.test', T0);
  noteDismiss('a', 'x', T0); noteDismiss('a', 'x', T0 + 500);
  eq('G8 优先于 G6：先扣会话降档（l→m），再按同日同场景缩一档（→s）', voiceGate('aside', 'phase.test', gsnap({ level: 'l' }), T0 + 1000).level, 's');
  // later 不记；skip / enough
  freshGate();
  noteDismiss('nudge.photo', 'later', T0); noteDismiss('nudge.photo', 'later', T0 + 100);
  eq('G8 later 不记', gate('proactive', {}, T0 + 200, 'nudge.photo').mode, 'her');
  noteDismiss('nudge.photo', 'skip', T0 + 300);
  eq('G8 skip：该场景当日不再（非功能话 silent；功能话退成 min，不能整句消失）', [gate('proactive', {}, T0 + 400, 'nudge.photo').why, gate('aside', {}, T0 + 400, 'nudge.photo').mode, gate('reply', {}, T0 + 400, 'nudge.photo').mode, gate('proactive', {}, T0 + 400, 'nudge.book').mode], ['skipped', 'silent', 'min', 'her']);
  eq('G8 skip 次日恢复', gate('proactive', {}, T0 + 24 * HOUR, 'nudge.photo').mode, 'her');
  noteDismiss('nudge.photo', 'enough', T0 + 500);
  eq('G8 enough：当日 proactive 全部 silent，且今天的次数置满；其他话不受影响', [gate('proactive', {}, T0 + 600, 'nudge.book').why, gateStats(T0 + 600).today, gate('aside', {}, T0 + 600, 'phase.x').mode], ['enough', NUDGE_DAY_CAP, 'her']);
  eq('G8 enough 次日恢复', [gate('proactive', {}, T0 + 24 * HOUR).mode, gateStats(T0 + 24 * HOUR).today], ['her', 0]);
}

section('voiceGate G7：每屏同时 ≤1 句非功能话');
{
  freshGate();
  eq('G7 前台已有一条未被回应的非功能话 → 新的非功能话 silent', [gate('proactive', { unanswered: true }).why, gate('greet', { unanswered: true }).mode, gate('aside', { unanswered: true }).mode], ['one-at-a-time', 'silent', 'silent']);
  eq('G7 功能话不受限', [gate('reply', { unanswered: true }).mode, gate('event', { unanswered: true }).mode, gate('lead', { unanswered: true }).mode], ['her', 'her', 'her']);
  const msgs = (m: Partial<Message>[]): Message[] => m.map((x, i) => ({ id: `m${i}`, role: 'agent', text: 'x', at: i, ...x }) as Message);
  eq('unansweredHer：最后一条是主动话且之后用户没说话', unansweredHer(msgs([{ role: 'user' }, { proactive: true }])), true);
  eq('unansweredHer：用户回了就不算', unansweredHer(msgs([{ proactive: true }, { role: 'user' }])), false);
  eq('unansweredHer：普通回复不算', unansweredHer(msgs([{ role: 'user' }, {}])), false);
  eq('unansweredHer：按 src.scene 认问候 / 小话题 / 休息', [unansweredHer(msgs([{ src: { id: 'a', mode: 'chat', scene: 'greet.am' } }])), unansweredHer(msgs([{ src: { id: 'a', mode: 'chat', scene: 'nudge.rest' } }])), unansweredHer(msgs([{ src: { id: 'a', mode: 'chat', scene: 'done.w' } }]))], [true, true, false]);
  eq('unansweredHer：系统行（role=system 且带 src）也算；不带 src 的系统消息跳过', [unansweredHer(msgs([{ role: 'system', src: { id: 'sys.rest', mode: 'chat', scene: 'sys.rest' } }])), unansweredHer(msgs([{ proactive: true }, { role: 'system' }]))], [true, true]);
  eq('unansweredHer：空对话', unansweredHer([]), false);
}

section('voiceGate G9：休息关照 / 很晚的护栏');
{
  // 触发条件
  freshGate();
  resetPresenceForTest(0);
  eq('G9-① 连续使用 <120 分钟 → silent；≥120 → her', [gate('rest', { continuousMinutes: 119 }).mode, gate('rest', { continuousMinutes: 120 }).mode, gate('late', { continuousMinutes: 119 }).why, gate('late', { continuousMinutes: 120 }).mode], ['silent', 'her', 'not-due', 'her']);
  eq('rest/late 没有「话量」限制：少档也说（短而仍是她）', brief(gate('rest', { ...REST_SNAP, level: 's' })), [true, 'her', 's']);
  // ② 白天每满 2 小时 ≤1；③ 本连续使用期不再提
  noteSpoken('rest', 'nudge.rest', T0);
  eq('G9-② 白天开过口：2 小时内 → too-soon', gate('rest', { ...REST_SNAP, continuousSince: T0 - 2 * HOUR }, T0 + 90 * MIN).why, 'too-soon');
  const since0 = T0 - 130 * MIN;
  freshGate(); resetPresenceForTest(since0); for (let t = since0; t <= T0; t += 10 * MIN) recordInput(t);
  noteSpoken('rest', 'nudge.rest', T0);
  eq('G9-③ 同一段连续使用里，满 2 小时之后也不再提', gate('rest', { continuousMinutes: 300, continuousSince: since0 }, T0 + 3 * HOUR).why, 'continued');
  eq('G9-③ 换了一段连续使用（起点差 >5 分钟）+ 满 2 小时：可以再提', gate('rest', { continuousMinutes: 125, continuousSince: T0 + 3 * HOUR - 125 * MIN }, T0 + 3 * HOUR).mode, 'her');
  // 夜里每晚 ≤1
  freshGate();
  noteSpoken('rest', 'nudge.rest', at(23, 0));
  eq('G9-② 夜里每晚 ≤1（23:00 说过，次日 01:30 同一个夜晚）', gate('late', { continuousMinutes: 130, continuousSince: at(23, 30) }, at(1, 30, 1)).why, 'once-per-night');
  eq('G9-② 隔了一个夜晚（次日 19:00）又可以', gate('rest', { continuousMinutes: 130, continuousSince: at(17, 0, 1) }, at(19, 0, 1)).mode, 'her');
  eq('nightKey：18:00–次日 06:00 为一个夜晚；白天没有键', [nightKey(at(18, 0)) === dayKey(at(18, 0)), nightKey(at(5, 59)) === dayKey(at(5, 59, -1)), nightKey(at(6, 0)), nightKey(at(12, 0))], [true, true, undefined, undefined]);
  // ④ 今天别再提醒
  freshGate();
  noteDismiss('nudge.rest', 'enough', at(23, 5));
  eq('G9-④ 点了「今天别再提醒」：当晚不再提（含午夜之后），次日傍晚恢复', [gate('rest', REST_SNAP, at(23, 30)).why, gate('late', REST_SNAP, at(2, 0, 1)).why, gate('rest', REST_SNAP, at(19, 0, 1)).mode], ['dismissed', 'dismissed', 'her']);
  freshGate();
  noteDismiss('nudge.rest', 'enough', T0);
  eq('G9-④ 白天点了：当天不再提，次日恢复；它不影响 proactive 的今日次数', [gate('rest', REST_SNAP, T0 + 4 * HOUR).why, gate('rest', REST_SNAP, T0 + 24 * HOUR).mode, gateStats(T0).today], ['dismissed', 'her', 0]);
  // ⑤ 连续 3 次被忽略 → chip
  freshGate();
  const day = (n: number) => at(14, 0, n);
  for (let n = 0; n < 3; n++) {
    eq(`G9-⑤ 第 ${n + 1} 次：开口前还是 her`, gate('rest', REST_SNAP, day(n)).mode, 'her');
    noteSpoken('rest', 'nudge.rest', day(n));
    settleIgnored(day(n) + 6 * MIN, day(n) + 5 * MIN);                         // 5 分钟后既没点按钮、还在操作
  }
  eq('G9-⑤ 连续 3 次被忽略 → chip（只在右栏状态牌亮标记，不再进对话流）', [gate('rest', REST_SNAP, day(3)).mode, gate('rest', REST_SNAP, day(3)).why, gateStats(day(3)).ignoredStreak], ['chip', 'ignored', 3]);
  eq('G9-⑤ chip 压过 line（安静 / 退后 / persona=false 时也是 chip）', [gate('rest', { ...REST_SNAP, quietUntil: day(3) + HOUR }, day(3)).mode, gate('rest', { ...REST_SNAP, persona: false }, day(3)).mode], ['chip', 'chip']);
  noteAccepted(day(3));
  eq('点了「歇一会儿」类按钮：清零', [gate('rest', REST_SNAP, day(3)).mode, gateStats(day(3)).ignoredStreak], ['her', 0]);
  // 忽略的判定
  freshGate();
  noteSpoken('rest', 'nudge.rest', T0);
  settleIgnored(T0 + 4 * MIN, T0 + 3 * MIN);
  eq('忽略：不满 5 分钟不判', gateStats(T0 + 4 * MIN).ignoredStreak, 0);
  settleIgnored(T0 + 6 * MIN, T0 + 1 * MIN);
  eq('忽略：5 分钟后用户早已没有输入（停下了）不算', gateStats(T0 + 6 * MIN).ignoredStreak, 0);
  noteSpoken('rest', 'nudge.rest', T0 + 3 * HOUR);
  noteDismiss('nudge.rest', 'x', T0 + 3 * HOUR + MIN);
  settleIgnored(T0 + 3 * HOUR + 6 * MIN, T0 + 3 * HOUR + 5 * MIN);
  eq('忽略：点了关闭（有反应）不算', gateStats(T0 + 4 * HOUR).ignoredStreak, 0);
  noteSpoken('rest', 'nudge.rest', T0 + 6 * HOUR);
  settleIgnored(T0 + 6 * HOUR + 2 * HOUR, T0 + 6 * HOUR + 2 * HOUR - 1000);
  eq('忽略：隔了很久才来评估的不记（不知道当时的情况）', gateStats(T0 + 9 * HOUR).ignoredStreak, 0);
  // G1 / G2 / G4 / G10 对 rest 的降级与 G11
  freshGate();
  eq('G11 rest 正常 → her', brief(gate('rest', REST_SNAP)), [true, 'her', 'l']);
  noteCrisis(T0);
  eq('G10 危机当天：rest / late → line', [gate('rest', REST_SNAP).mode, gate('late', REST_SNAP).mode], ['line', 'line']);
}

section('voiceGate G10 / G11：危机当天、其余');
{
  freshGate();
  eq('危机前', [isCrisisDay(T0), gate('proactive').mode], [false, 'her']);
  noteCrisis(T0);
  eq('G10 危机当天：非功能话一律 silent，rest/late → line，功能话照出', [isCrisisDay(T0 + HOUR), gate('proactive', {}, T0 + HOUR).why, gate('greet', {}, T0 + HOUR).mode, gate('aside', {}, T0 + HOUR).mode, gate('reply', {}, T0 + HOUR).mode, gate('event', {}, T0 + HOUR).mode], [true, 'crisis-day', 'silent', 'silent', 'her', 'her']);
  eq('G10 次日恢复', [isCrisisDay(T0 + 24 * HOUR), gate('proactive', {}, T0 + 24 * HOUR).mode], [false, 'her']);
  freshGate();
  eq('G11 其余：her，档位原样', [brief(gate('proactive')), brief(gate('reply', { level: 'm' })), brief(gate('lead', { level: 's' }))], [[true, 'her', 'l'], [true, 'her', 'm'], [true, 'her', 's']]);
}

section('voiceGate：记账 / 持久化 / 读不到时的保守');
{
  const st = freshGate();
  noteSpoken('proactive', 'nudge.photo', T0, 't1');
  noteSpoken('proactive', 'nudge.book', T0 + MIN, 't1');
  noteSpoken('proactive', 'nudge.flower', T0 + 2 * MIN, 't2');
  eq('proactive 记账：今天次数、每任务本会话次数、未回应、每小时', [gateStats(T0 + 3 * MIN, 't1').today, gateStats(T0 + 3 * MIN, 't1').session, gateStats(T0 + 3 * MIN, 't1').unanswered, gateStats(T0 + 3 * MIN, 't2').session, gateStats(T0 + 3 * MIN).hourly], [3, 2, true, 1, 3]);
  noteAnswered('t1', T0 + 3 * MIN);
  eq('noteAnswered 清掉该任务的「未回应」，别的任务不动', [gateStats(T0 + 3 * MIN, 't1').unanswered, gateStats(T0 + 3 * MIN, 't2').unanswered], [false, true]);
  eq('sceneCountToday', [sceneCountToday('nudge.photo', T0), sceneCountToday('nudge.nothing', T0)], [1, 0]);
  eq('存到 localStorage 的键', Object.keys(st.data), ['alight/voicegate']);
  resetGateForTest(st);                                                      // 模拟重启：从存储里读回来
  eq('重启后读回：次数 / 会话 / 未回应', [gateStats(T0 + 3 * MIN, 't1').today, gateStats(T0 + 3 * MIN, 't1').session, gateStats(T0 + 3 * MIN, 't2').unanswered, gateLoadFailed()], [3, 2, true, false]);
  eq('次日翻转：今天次数 / 未回应 / 同场景清零', [gateStats(T0 + 24 * HOUR, 't2').today, gateStats(T0 + 24 * HOUR, 't2').unanswered, sceneCountToday('nudge.photo', T0 + 24 * HOUR)], [0, false, 0]);

  const nothing: GateStorage = { getItem: () => null, setItem: () => {} };
  resetGateForTest(nothing);
  eq('存储里没有记录（第一次）：一切从零开始，不算读失败', [gate('proactive').mode, gateLoadFailed()], ['her', false]);
  const bad: Array<[string, GateStorage | null]> = [
    ['存储不可用', null], ['getItem 抛错', { getItem: () => { throw new Error('denied'); }, setItem: () => {} }], ['内容损坏', { getItem: () => '{not json', setItem: () => {} }], ['内容不是对象', { getItem: () => '42', setItem: () => {} }],
  ];
  for (const [name, s] of bad) {
    resetGateForTest(s);
    eq(`读不到（${name}）：按「已说满」——主动话 / 预算 silent，今天次数满`, [gate('proactive').mode, gateLoadFailed(), gateStats(T0).today], ['silent', true, NUDGE_DAY_CAP]);
    eq(`读不到（${name}）：功能话与休息关照照常`, [gate('reply').mode, gate('rest', REST_SNAP).mode], ['her', 'her']);
  }
  resetGateForTest({ getItem: () => '{"day":"x","proactive":{"count":"many","unanswered":{"a":0}},"hourly":[1,"2",null],"sameScene":{"s":"x"},"rest":null}', setItem: () => {} });
  eq('字段类型乱了：宽容地当作零值，不抛错', [gateStats(T0, 'a').today, gateStats(T0, 'a').unanswered, gateStats(T0).hourly], [0, false, 0]);
  const full = freshGate({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  void full;
  eq('写不进存储不抛错（只在内存里）', (() => { noteSpoken('proactive', 'nudge.photo', T0, 't1'); return gateStats(T0, 't1').today; })(), 1);
}

/* ═════════════ canNudge / nextNudgeAt ═════════════ */
section('canNudge：全部闸门');
{
  const ns = (o: Partial<NudgeSnap> = {}, g: Partial<GateSnap> = {}): NudgeSnap => ({
    gate: gsnap(g), visible: true, focused: true, task: { id: 't1', chat: true, lastAt: T0 - 9 * MIN, userSpoke: true, replying: false },
    pendingAny: false, today: 0, session: 0, unansweredPrev: false, ...o,
  });
  const why = (snap: NudgeSnap, now = T0) => { const v = canNudge(snap, now); return v.ok ? 'ok' : v.why; };
  freshGate();
  eq('全部满足 → 说', why(ns()), 'ok');
  const table: Array<[string, NudgeSnap, string]> = [
    ['persona 关', ns({}, { persona: false }), 'persona-off'],
    ['主动说话 off', ns({}, { proactive: 'off' }), 'proactive-off'],
    ['安静一小时中', ns({}, { quietUntil: T0 + MIN }), 'quiet'],
    ['窗口不可见', ns({ visible: false }), 'hidden'],
    ['窗口没焦点', ns({ focused: false }), 'no-focus'],
    ['没有前台任务', ns({ task: undefined }), 'no-chat-task'],
    ['前台不是闲聊', ns({ task: { id: 't1', chat: false, lastAt: T0 - 9 * MIN, userSpoke: true, replying: false } }), 'no-chat-task'],
    ['她正在回复', ns({ task: { id: 't1', chat: true, lastAt: T0 - 9 * MIN, userSpoke: true, replying: true } }), 'replying'],
    ['输入框里有草稿', ns({}, { hasDraft: true }), 'draft'],
    ['输入法在组合', ns({}, { composing: true }), 'ime'],
    ['有待批审批 / 待答 / 待批计划', ns({ pendingAny: true }), 'pending'],
    ['用户在该任务里没说过话', ns({ task: { id: 't1', chat: true, lastAt: T0 - 9 * MIN, userSpoke: false, replying: false } }), 'user-never-spoke'],
    ['静默不满 8 分钟', ns({ task: { id: 't1', chat: true, lastAt: T0 - 7 * MIN, userSpoke: true, replying: false } }), 'too-soon'],
    ['该任务本会话已 2 次', ns({ session: 2 }), 'session-cap'],
    ['今天已 3 次', ns({ today: 3 }), 'day-cap'],
    ['上一次主动没得到回应', ns({ unansweredPrev: true }), 'unanswered'],
    ['话量 中 + auto（D7：auto 只在多档）', ns({}, { level: 'm' }), 'gate:level-mismatch'],
    ['话量 少 + on（少档恒不说）', ns({}, { level: 's', proactive: 'on' }), 'gate:level-mismatch'],
  ];
  for (const [name, snap, want] of table) eq(`canNudge ✗ ${name}`, why(snap), want);
  eq('话量 中 + on → 说', why(ns({}, { level: 'm', proactive: 'on' })), 'ok');
  eq('静默恰好 8 分钟 → 说', why(ns({ task: { id: 't1', chat: true, lastAt: T0 - NUDGE_QUIET_MS, userSpoke: true, replying: false } })), 'ok');
  eq('本会话 1 次、今天 2 次 → 还能说', why(ns({ session: 1, today: 2 })), 'ok');
  // 钟点：08:00 ≤ 钟点 < 22:00
  const old = (now: number) => ns({ task: { id: 't1', chat: true, lastAt: now - 20 * MIN, userSpoke: true, replying: false } });
  eq('钟点：07:59 ✗、08:00 ✓、21:59 ✓、22:00 ✗、03:00 ✗', [at(7, 59), at(8, 0), at(21, 59), at(22, 0), at(3, 0)].map((t) => why(old(t), t)), ['night', 'ok', 'ok', 'night', 'night']);
  // 危机当天恒假
  freshGate(); noteCrisis(T0);
  eq('危机当天 canNudge 恒假（含次日恢复）', [why(ns()), why(ns(), T0 + 24 * HOUR + 1)], ['crisis-day', 'ok']);
  // 总闸的拦：预算、随手降档、今天别再说
  freshGate();
  for (let i = 0; i < HOURLY_BUDGET.l; i++) noteSpoken('aside', `a.${i}`, T0 - i * 1000);
  eq('canNudge 要先过 voiceGate：每小时预算满 → gate:hourly-budget', why(ns()), 'gate:hourly-budget');
  freshGate(); noteDismiss('nudge.photo', 'x', T0 - 5000); noteDismiss('nudge.photo', 'x', T0 - 4000);
  eq('随手降档后（多→中）auto 不再主动开口', why(ns()), 'gate:level-mismatch');
  freshGate(); noteDismiss('nudge.photo', 'enough', T0 - 1000);
  eq('「今天别再说」→ gate:enough', why(ns()), 'gate:enough');
  eq('一个快照的 level 与 gate 的 level 同源：snap 里 level=l 且无降档 → 通过', (freshGate(), why(ns())), 'ok');
}

section('nextNudgeAt：一次性定时器的到期点');
{
  eq('最后一条消息 + 8 分钟', nextNudgeAt(T0, T0 + MIN), T0 + NUDGE_QUIET_MS);
  eq('已经过了到期点 → 现在', nextNudgeAt(T0 - 30 * MIN, T0), T0);
  eq('落在 22:00 之后 → 今晚不排', nextNudgeAt(at(21, 55), at(21, 56)), undefined);
  eq('刚好 21:59 到期 → 排', nextNudgeAt(at(21, 51), at(21, 52)), at(21, 59));
  eq('08:00 之前 → 推到 08:00', nextNudgeAt(at(7, 40), at(7, 41)), at(8, 0));
  eq('凌晨 → 推到 08:00', nextNudgeAt(at(3, 0), at(3, 1)), at(8, 0));
  eq('常量', [NUDGE_QUIET_MS], [8 * MIN]);
}

/* ═════════════ openingFor ═════════════ */
section('openingFor：问候 / 归来分工的四种分支');
{
  const f = (o: Partial<OpeningFacts> = {}): OpeningFacts => ({ hasLastSeen: true, taskCount: 3, awayMs: 0, pending: 0, failed: 0, done: 0, lifeGreeting: true, greetedToday: false, now: at(9, 0), ...o });
  eq('① 从未打开过（无 lastSeen 且无任务）→ FirstRun 的 greet.first', [openingFor(f({ hasLastSeen: false, taskCount: 0 })).kind, openingFor(f({ hasLastSeen: false, taskCount: 0, pending: 3, awayMs: 1e12 })).kind], ['first', 'first']);
  eq('① 没有 lastSeen 但已有任务 → 不是第一次', openingFor(f({ hasLastSeen: false, taskCount: 1 })).kind, 'greet');
  eq('② 离开期间有待你 → 归来笺，不加 greet.away', openingFor(f({ pending: 2, awayMs: 2 * HOUR })), { kind: 'brief', awayGreeting: false });
  eq('② 有失败 / 离开期间已完成 → 归来笺', [openingFor(f({ failed: 1 })), openingFor(f({ done: 2 }))], [{ kind: 'brief', awayGreeting: false }, { kind: 'brief', awayGreeting: false }]);
  eq('③ 离开 ≥3 天且无待你无失败 → 归来笺头部加 greet.away（已完成也算）', [openingFor(f({ awayMs: AWAY_GREETING_MS })), openingFor(f({ awayMs: AWAY_GREETING_MS, done: 4 }))], [{ kind: 'brief', awayGreeting: true }, { kind: 'brief', awayGreeting: true }]);
  eq('③ 差一毫秒不到 3 天 → 按时辰问候', openingFor(f({ awayMs: AWAY_GREETING_MS - 1 })).kind, 'greet');
  eq('③ 离开 ≥3 天但有待你 → 不加 greet.away', openingFor(f({ awayMs: AWAY_GREETING_MS * 2, pending: 1 })), { kind: 'brief', awayGreeting: false });
  eq('④ 其余：每天第一次按时辰问候', openingFor(f()), { kind: 'greet', scene: 'greet.am' });
  eq('④ 同日再开 / lifeGreeting 关 → 无', [openingFor(f({ greetedToday: true })).kind, openingFor(f({ lifeGreeting: false })).kind], ['none', 'none']);
  eq('greetSceneAt：05–11 早、11–17 午、17–22 晚、其余深夜', [4, 5, 10, 11, 16, 17, 21, 22, 0].map((h) => greetSceneAt(at(h, 30))), ['greet.late', 'greet.am', 'greet.am', 'greet.noon', 'greet.noon', 'greet.eve', 'greet.eve', 'greet.late', 'greet.late']);
}

/* ═════════════ selectors：退后 / 神色一路 / 总闸快照 / 旧 distance 垫片 ═════════════ */
const mkRun = (id: string, taskId: string, o: Partial<Run> = {}): Run => ({
  id, taskId, attempt: 1, status: 'running', createdAt: T0 - 60 * MIN, activeMs: 0, plan: [], planReady: false, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [],
  usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: 0, series: [] }, cursor: { phase: 'planning', step: 0 }, ...o,
});
const mkTask = (id: string, o: Partial<Task> = {}): Task => ({ id, title: id, goal: '', createdAt: T0 - HOUR, updatedAt: T0 - HOUR, agentIds: ['orchestrator'], runIds: [], messages: [], ...o });
const mkMsg = (id: string, role: Message['role'], atMs: number, o: Partial<Message> = {}): Message => ({ id, role, text: id, at: atMs, ...o });
function mkState(tasks: Task[], runs: Run[] = [], patch: (s: AppState) => void = () => {}): AppState {
  const s = emptyState(0, { ...DEFAULT_SETTINGS });     // 复制一份设置：emptyState 默认直接用 DEFAULT_SETTINGS，被 immer 冻结后不能再改
  for (const t of tasks) { s.tasks[t.id] = t; s.taskOrder.push(t.id); }
  for (const r of runs) s.runs[r.id] = r;
  patch(s);
  return s;
}

section('selectRetreat：审批 / 提问 / 计划 / 失败 / 输入法 / 安静');
{
  const pending = (status: string) => [{ id: 'x', status, createdAt: T0 - MIN } as never];
  const stateWith = (runOver: Partial<Run>, patch: (s: AppState) => void = () => {}) => mkState([mkTask('w', { runIds: ['r1'] })], [mkRun('r1', 'w', runOver)], (s) => { s.selectedTaskId = 'w'; patch(s); });
  const R = (s: AppState, id: string | undefined = 'w', now = T0, composing = false) => selectRetreat(s, id, now, composing);
  eq('什么都没有：不退', R(stateWith({})), { retreated: false });
  eq('待批审批 → approval', R(stateWith({ approvals: pending('pending') })), { retreated: true, why: 'approval' });
  eq('已处理的审批不算', R(stateWith({ approvals: pending('approved') })), { retreated: false });
  eq('待答问题 → question', R(stateWith({ questions: pending('pending') })), { retreated: true, why: 'question' });
  eq('待批计划 → plan', R(stateWith({ planApproval: { status: 'pending', at: T0 } })), { retreated: true, why: 'plan' });
  eq('计划已批准不算', R(stateWith({ planApproval: { status: 'approved', at: T0 } })), { retreated: false });
  eq('运行失败 → failed', R(stateWith({ status: 'failed' })), { retreated: true, why: 'failed' });
  eq('运行 awaiting 但查不到具体项 → approval', R(stateWith({ status: 'awaiting' })), { retreated: true, why: 'approval' });
  eq('输入法组合 → ime', R(stateWith({}), 'w', T0, true), { retreated: true, why: 'ime' });
  eq('quietUntil > now → quiet；到点即解除', [R(stateWith({}, (s) => { s.quietUntil = T0 + MIN; })), R(stateWith({}, (s) => { s.quietUntil = T0; }))], [{ retreated: true, why: 'quiet' }, { retreated: false }]);
  eq('优先级：审批 > 输入法 > 安静', [R(stateWith({ approvals: pending('pending') }), 'w', T0, true).why, R(stateWith({}, (s) => { s.quietUntil = T0 + MIN; }), 'w', T0, true).why], ['approval', 'ime']);
  eq('没有任务 id：只看 ime / quiet', [selectRetreat(stateWith({}), undefined, T0, true).why, selectRetreat(stateWith({ status: 'failed' }), undefined, T0, false).retreated], ['ime', false]);
  eq('不是选中任务：取它最新的一次运行', R(mkState([mkTask('o', { runIds: ['r9'] })], [mkRun('r9', 'o', { approvals: pending('pending') })]), 'o').why, 'approval');
  eq('任务不存在：不退', R(stateWith({}), 'nope'), { retreated: false });
}

section('selectTrail：闲聊 = 最近 5 句她的话；工作 = 五个节点');
{
  const hers = Array.from({ length: 7 }, (_, i) => mkMsg(`h${i}`, 'agent', T0 + i * 1000, { agentId: 'orchestrator', ...(i % 2 ? { expr: 'shy' as ExprId } : {}) }));
  const chat = mkTask('c', { kind: 'chat', messages: [mkMsg('u0', 'user', T0 - 1000), ...hers, mkMsg('sub', 'agent', T0 + 9000, { agentId: 'researcher', expr: 'relaxed' }), mkMsg('err', 'agent', T0 + 9500, { kind: 'error', expr: 'confused' }), mkMsg('u1', 'user', T0 + 10_000)] });
  const trail = selectTrail(mkState([chat]), 'c');
  eq('闲聊：最近 5 条她的话（旧→新），子 Agent / 报错 / 用户的话不计', trail.map((n) => n.at), [2, 3, 4, 5, 6].map((i) => T0 + i * 1000));
  eq('闲聊：缺 expr 固定 gentle（不兜底），有就照用', trail.map((n) => n.expr), ['gentle', 'shy', 'gentle', 'shy', 'gentle']);
  // 第 1 轮评审：带贴纸 / 危机回合的消息头像固定 gentle，右栏神色一路同口径.
  const stk = mkTask('k', { kind: 'chat', messages: [
    mkMsg('k0', 'agent', T0, { agentId: 'orchestrator', persona: 'night', kind: 'reply', expr: 'shy', react: 'blushing' }),
    mkMsg('k1', 'agent', T0 + 1000, { agentId: 'orchestrator', persona: 'night', kind: 'reply', expr: 'shy' }),
    mkMsg('k2', 'agent', T0 + 2000, { agentId: 'orchestrator', persona: 'night', kind: 'reply', expr: 'relaxed', crisis: true }),
  ] });
  eq('闲聊：带贴纸的那条记 gentle，不带的照用，危机回合 gentle', selectTrail(mkState([stk]), 'k').map((n) => n.expr), ['gentle', 'shy', 'gentle']);
  eq('闲聊：关掉贴纸后，原 expr 照用', selectTrail(mkState([stk], [], (s) => { s.settings.stickers = false; }), 'k').map((n) => n.expr), ['shy', 'shy', 'gentle']);
  eq('selectHerCrisis：今天任务里有危机回合 = 在听；没有 = 否；昨天的不算', [
    selectHerCrisis(mkState([stk]), 'k', T0 + 5000), selectHerCrisis(mkState([chat]), 'c', T0 + 5000), selectHerCrisis(mkState([stk]), 'k', T0 + 3 * 24 * 60 * MIN), selectHerCrisis(mkState([stk]), undefined, T0 + 5000),
  ], [true, false, false, false]);
  eq('闲聊节点形状', trail[0], { kind: 'expr', at: T0 + 2000, expr: 'gentle' });
  eq('没有任务 / 没有她的话 → 空', [selectTrail(mkState([chat]), 'nope'), selectTrail(mkState([chat]), undefined), selectTrail(mkState([mkTask('e', { kind: 'chat' })]), 'e')], [[], [], []]);
  // 第 2 轮评审：新闲聊里她已经开口（HerOpening），右栏空态不能写「她还没有开口」.
  eq('新闲聊（口吻开）= 她已开场；有消息 / 没有这个任务 / 工作任务 = 否', [herOpened(mkState([mkTask('e', { kind: 'chat' })]), 'e'), herOpened(mkState([chat]), 'c'), herOpened(mkState([chat]), 'nope'), herOpened(mkState([mkTask('w0', { kind: 'work' })]), 'w0')], [true, false, false, false]);
  eq('口吻关着（距离 0）：没有开场', herOpened(mkState([mkTask('e', { kind: 'chat' })], [], (s) => { s.settings.distance = 0; }), 'e'), false);
  // 第 2 轮评审：归来笺「这四十一分钟」对不上「15:39 到 16:19」——分钟数按分钟边界相减，与 HH:mm 同口径.
  {
    const at = (h: number, m: number, sec: number) => new Date(2026, 9, 28, h, m, sec).getTime();
    eq('离开分钟数 = 分钟边界相减（同一个 HH:mm 取整）', [awayMinutes(at(15, 39, 50), at(16, 19, 20)), awayMinutes(at(15, 39, 5), at(16, 19, 59)), awayMinutes(at(15, 39, 59), at(16, 19, 0))], [40, 40, 40]);
    eq('至少 1 分钟', awayMinutes(at(10, 0, 0), at(10, 0, 30)), 1);
  }

  const t1 = T0 - 50 * MIN; const t2 = T0 - 40 * MIN; const t3 = T0 - 39 * MIN; const t4 = T0 - 30 * MIN; const t5 = T0 - 10 * MIN;
  const doneMsg = mkMsg('d', 'agent', T0 - 21 * MIN, { agentId: 'orchestrator', kind: 'note', text: '做完了，结果在下面。', src: { id: 'done.w.w.m', mode: 'work', scene: 'done.w' } });
  const work = mkTask('w', { runIds: ['r1'], messages: [doneMsg, mkMsg('thx', 'user', T0 - 20 * MIN, { text: '谢谢' })] });
  const run = mkRun('r1', 'w', {
    startedAt: t1, endedAt: T0 - 22 * MIN, status: 'completed', planReady: true, planApproval: { status: 'approved', at: t2 },
    plan: [{ id: 's1', index: 0, title: 'x', detail: '', agentId: 'coder', status: 'done', toolCallIds: [], startedAt: t3 } as never],
    errors: [{ id: 'e1', at: t4, runId: 'r1', title: 't', code: 'X', message: 'm', fatal: false }, { id: 'e2', at: t4 + 1, runId: 'r1', title: 't', code: 'X', message: 'm', fatal: true }],
    approvals: [{ id: 'a1', status: 'pending', createdAt: t5 } as never],
  });
  const wt = selectTrail(mkState([work], [run], (s) => { s.selectedTaskId = 'w'; }), 'w');
  eq('工作：计划就绪 / 开工 / 重试 / 道谢 / 待批 五类节点加完成后的收尾节点，按时间排', wt.map((n) => [n.kind, n.at]), [['plan', t1], ['start', t2], ['retry', t4], ['pending', t5], ['thanks', T0 - 20 * MIN], ['end', T0 - 22 * MIN]].sort((a, b) => (a[1] as number) - (b[1] as number)));
  eq('工作：节点的神色与标签', wt.map((n) => [n.kind, n.expr, n.label]).sort(), [['end', 'relaxed', '做完'], ['pending', 'gentle', '待批'], ['plan', 'gentle', '计划就绪'], ['retry', 'confused', '重试'], ['start', 'gentle', '开工'], ['thanks', 'relaxed', '道谢']]);
  // 第 4 轮评审：右栏失败节点写场景名「没走通」，不叫「抱歉」；放下时失败与放下合成一个「放下」节点（不并排两个同时刻的节点）.
  eq('工作：失败收尾 = gentle「没走通」；放下（含失败后放下）只列一个「放下」；进行中没有收尾节点', (() => {
    const mk = (o: object) => selectTrail(mkState([mkTask('w', { runIds: ['rx'] })], [mkRun('rx', 'w', { startedAt: t1, planReady: true, ...o })]), 'w').filter((n) => n.kind === 'end').map((n) => [n.expr, n.label, n.at]);
    return [mk({ status: 'failed', endedAt: t4 }), mk({ status: 'failed', endedAt: t4, laidDownAt: t5 }), mk({ laidDownAt: t5 }), mk({ status: 'running' })];
  })(), [[['gentle', '没走通', t4]], [['gentle', '放下', t5]], [['gentle', '放下', t5]], []]);
  ok('右栏神色一路里没有叫「抱歉」的节点', (() => {
    const labels = ([{ status: 'failed', endedAt: t4 }, { status: 'failed', endedAt: t4, laidDownAt: t5 }, { status: 'completed', endedAt: t4 }] as Partial<Run>[])
      .flatMap((o) => selectTrail(mkState([mkTask('w', { runIds: ['rx'] })], [mkRun('rx', 'w', { startedAt: t1, planReady: true, ...o })]), 'w').map((n) => n.label));
    return labels.length > 0 && !labels.includes('抱歉');
  })());
  eq('工作：没有道谢的话就没有道谢节点；落蝶标记也算', [
    selectTrail(mkState([{ ...work, messages: [doneMsg, mkMsg('q', 'user', T0 - 20 * MIN, { text: '再改改' })] }], [run]), 'w').some((n) => n.kind === 'thanks'),
    selectTrail(mkState([{ ...work, messages: [doneMsg, mkMsg('q', 'user', T0 - 20 * MIN, { text: '随便', reaction: 'landing' })] }], [run]), 'w').some((n) => n.kind === 'thanks'),
  ], [false, true]);
  eq('工作：重试判据也认 retryOf；计划待批的节点用 planApproval.at', (() => {
    const r = mkRun('r2', 'w', { retryOf: 'r1', startedAt: t1, planReady: true, planApproval: { status: 'pending', at: t2 } });
    return selectTrail(mkState([mkTask('w', { runIds: ['r2'] })], [r]), 'w').map((n) => [n.kind, n.at]);
  })(), [['plan', t2], ['retry', t1]].sort((a, b) => (a[1] as number) - (b[1] as number)));
  eq('工作：没有运行 → 空', selectTrail(mkState([mkTask('w')]), 'w'), []);
  // 第 3 轮评审：提问卡等回答时，神色一路最后的节点写「待答」，审批写「待批」；两者同时在等取最早的那一项.
  eq('工作：待答 = 提问，待批 = 审批；同时等取最早的', (() => {
    const pend = (o: object) => selectTrail(mkState([mkTask('w', { runIds: ['rq'] })], [mkRun('rq', 'w', { startedAt: t1, planReady: true, ...o })]), 'w').filter((n) => n.kind === 'pending').map((n) => [n.label, n.at]);
    const q = (at: number) => ({ id: 'q1', status: 'pending', createdAt: at } as never);
    const a = (at: number) => ({ id: 'a1', status: 'pending', createdAt: at } as never);
    return [pend({ questions: [q(t4)] }), pend({ approvals: [a(t4)] }), pend({ questions: [q(t4)], approvals: [a(t5)] }), pend({ questions: [q(t5)], approvals: [a(t4)] })];
  })(), [[['待答', t4]], [['待批', t4]], [['待答', t4]], [['待批', t4]]]);
}

/* ═════════════ 第 4 轮：编排者唯一状态词 / 危机当天三处「在听」 ═════════════ */
section('selectOrchestratorPresence：同一状态下页头 / 右栏名牌 / 右栏 Agent 行是同一个词');
{
  const live = (agentId: 'orchestrator' | 'researcher' | 'coder' | 'reviewer') => ({ agentId, activity: 'tool', text: '读文件' } as never);
  const step = (index: number, agentId: string, status: string, ranAs?: string) => ({ id: `s${index}`, index, title: 'x', detail: '', agentId, ranAs, status, toolCallIds: [] } as never);
  const pres = (o: Partial<Run>) => selectOrchestratorPresence(mkState([mkTask('w', { runIds: ['rp'] })], [mkRun('rp', 'w', { startedAt: T0 - 5 * MIN, planReady: true, ...o })]), 'rp');
  // 三处各自的取词方式：页头胶囊 = AgentHead 的 agents 神色词；右栏名牌 = HerHeader 的 work.running；右栏 Agent 行 = presence.word.
  const three = (p: ReturnType<typeof pres>) => [
    moodWord({ surface: 'agents', agents: p.kind === 'doing' ? 'leading' : p.kind === 'watching' ? 'present' : 'idle', stepIndex: p.stepIndex }),
    moodWord({ surface: 'work', phase: 'running', watching: p.kind === 'watching', stepIndex: p.stepIndex }),
    p.word,
  ];
  const watching = pres({ live: live('researcher'), plan: [step(0, 'researcher', 'running')] });
  eq('别的 Agent 在做、她没在执行 → watching「在旁看着」', [watching.kind, ...three(watching)], ['watching', '在旁看着', '在旁看着', '在旁看着']);
  const takeover = pres({ live: live('orchestrator'), plan: [step(0, 'researcher', 'done'), step(1, 'coder', 'running', 'orchestrator')] });
  eq('她接手执行（停用接手）→ doing「在做 · 第 N 步」', [takeover.kind, takeover.stepIndex, ...three(takeover)], ['doing', 1, '在做 · 第 2 步', '在做 · 第 2 步', '在做 · 第 2 步']);
  const ownNoStep = pres({ live: live('orchestrator') });
  eq('她在执行但没有对应步骤（汇总）→「在做」', [ownNoStep.kind, ...three(ownNoStep)], ['doing', '在做', '在做', '在做']);
  eq('没有运行 / 运行已结束 / 运行里没人在做 → idle，不出词（各处照旧用阶段词与闲时词）', [
    selectOrchestratorPresence(mkState([mkTask('w')]), undefined).kind, selectOrchestratorPresence(mkState([mkTask('w')]), 'nope').kind,
    pres({ status: 'completed', endedAt: T0 - MIN, live: live('researcher') }).kind, pres({}).kind, pres({}).word,
  ], ['idle', 'idle', 'idle', 'idle', undefined]);
  eq('页头 idle 写「空闲」；这三处里没有「统筹中」「在场」「空闲 · 待命」', (() => {
    const all = [watching, takeover, ownNoStep, pres({})].flatMap(three).filter((w): w is string => !!w);
    return [moodWord({ surface: 'agents', agents: 'idle' }), all.some((w) => ['统筹中', '在场', '空闲 · 待命'].includes(w))];
  })(), ['空闲', false]);
}

section('危机当天：名牌 / 右栏 / 页头的神色词都是「在听」，不是活动词');
{
  freshGate();
  noteCrisis(T0);
  const chatT = mkTask('c', { kind: 'chat' }); const workT = mkTask('wk', { kind: 'work' });
  const day = (id: string, tasks: Task[]) => selectHerCrisis(mkState(tasks), id, T0 + HOUR);
  const idle = '在读书';
  eq('危机当天总闸 → selectHerCrisis 对闲聊 / 工作任务都为真', [day('c', [chatT]), day('wk', [workT]), day(undefined as never, [chatT])], [true, true, true]);
  eq('名牌（闲聊）/ 右栏（闲聊、工作空闲）/ 页头（工作空闲）都是「在听」', [
    moodWord({ surface: 'chat', crisis: day('c', [chatT]), idleMood: idle }),
    moodWord({ surface: 'chat', crisis: day('c', [chatT]), streaming: false, thinking: false, idleMood: idle }),
    moodWord({ surface: 'work', crisis: day('wk', [workT]), phase: 'idle', idleMood: idle }),
    moodWord({ surface: 'work', crisis: day('wk', [workT]), idleMood: idle }),
  ], [CRISIS_WORD, CRISIS_WORD, CRISIS_WORD, CRISIS_WORD]);
  eq('次日恢复闲时词', selectHerCrisis(mkState([chatT]), 'c', T0 + 24 * HOUR), false);
  freshGate();
}

section('makeGateSnap / 旧 distance 垫片');
{
  const base = (patch: (s: AppState) => void = () => {}, tasks: Task[] = [mkTask('c', { kind: 'chat' })]) => mkState(tasks, [], (s) => { s.selectedTaskId = 'c'; patch(s); });
  clearDraft('c'); setComposingForTest(false);
  const g0 = makeGateSnap(base(), T0);
  eq('默认快照', [g0.level, g0.persona, g0.proactive, g0.lifeGreeting, g0.quietUntil, g0.retreated, g0.composing, g0.taskId, g0.hasDraft, g0.unanswered], ['m', true, 'auto', true, 0, false, false, 'c', false, false]);
  eq('话量 / persona / 主动说话跟着设置走', (() => { const g = makeGateSnap(base((s) => { s.settings.level = 'l'; s.settings.persona = false; s.settings.proactive = 'on'; s.settings.lifeGreeting = false; }), T0); return [g.level, g.persona, g.proactive, g.lifeGreeting]; })(), ['l', false, 'on', false]);
  eq('旧存档：distance 0 + persona true 也算 persona 关', makeGateSnap(base((s) => { s.settings.distance = 0; }), T0).persona, false);
  eq('旧存档没有 proactive：lifeNudge 决定 auto / off', [makeGateSnap(base((s) => { (s.settings as { proactive?: unknown }).proactive = undefined; s.settings.lifeNudge = true; }), T0).proactive, makeGateSnap(base((s) => { (s.settings as { proactive?: unknown }).proactive = undefined; s.settings.lifeNudge = false; }), T0).proactive], ['auto', 'off']);
  eq('安静中：retreated + quietUntil + 原因 quiet', (() => { const g = makeGateSnap(base((s) => { s.quietUntil = T0 + MIN; }), T0); return [g.retreated, g.quietUntil, g.retreatWhy]; })(), [true, T0 + MIN, 'quiet']);
  setComposingForTest(true);
  eq('输入法组合：composing 为真，retreated 不含 ime', (() => { const g = makeGateSnap(base(), T0); return [g.composing, g.retreated, g.retreatWhy]; })(), [true, false, 'ime']);
  setComposingForTest(false);
  setDraft('c', '写了一半'); eq('草稿', makeGateSnap(base(), T0).hasDraft, true); clearDraft('c');
  const withMsgs = mkTask('c', { kind: 'chat', messages: [mkMsg('u', 'user', T0 - 20 * MIN), mkMsg('n', 'agent', T0 - 10 * MIN, { proactive: true })] });
  eq('未被回应的主动话 → unanswered', makeGateSnap(base(undefined, [withMsgs]), T0).unanswered, true);
  eq('taskId 缺省取选中任务；可显式指定', [makeGateSnap(base(), T0).taskId, makeGateSnap(base(), T0, 'zzz').taskId], ['c', 'zzz']);
  eq('连续使用分钟数来自 presence', (() => { resetPresenceForTest(T0 - 50 * MIN); for (let t = T0 - 50 * MIN; t <= T0; t += 10 * MIN) recordInput(t); const g = makeGateSnap(base(), T0); return [g.continuousMinutes, g.continuousSince]; })(), [50, T0 - 50 * MIN]);

  const S = (persona: boolean, distance: 0 | 1 | 2, level: Level) => distanceOf({ persona, distance, level });
  eq('distanceOf：新旧字段两边都认', [S(true, 1, 'm'), S(true, 2, 'l'), S(true, 2, 'm'), S(true, 1, 'l'), S(false, 2, 'l'), S(true, 0, 'm'), S(true, 1, 's'), S(false, 1, 'm')], [1, 2, 2, 2, 0, 0, 1, 0]);
  eq('effectiveDistance = distanceOf(settings)', effectiveDistance(base((s) => { s.settings.persona = false; })), 0);
}

/* ═════════════ 动作 ═════════════ */
section('动作：setLevel / setPersona / setProactive / setDistance 的派生垫片');
{
  store.init(emptyState(0));
  const st = () => store.get().settings;
  eq('默认', [st().level, st().persona, st().distance, st().proactive, st().lifeGreeting, st().lifeNudge], ['m', true, 1, 'auto', true, false]);
  actions.setLevel('l');
  eq('setLevel(l)：level / distance 派生 / 一条反馈', [st().level, st().distance, store.get().toasts.length], ['l', 2, 1]);
  actions.setLevel('l');
  eq('同值不再反馈', store.get().toasts.length, 1);
  actions.setLevel('s');
  eq('setLevel(s)：旧 distance 并入 1（回滚到 0.1.4 后「少」并入「中」）', [st().level, st().distance], ['s', 1]);
  actions.setPersona(false);
  eq('setPersona(false)：distance 0；话量不变；编排 Agent 改名 / 字块', [st().persona, st().distance, st().level, store.get().agents[0].name], [false, 0, 's', '编排 Agent']);
  actions.setLevel('l');
  eq('persona 关时改话量：distance 仍是 0', [st().level, st().distance], ['l', 0]);
  actions.setPersona(true);
  eq('setPersona(true)：distance 按话量派生；名字回来', [st().distance, store.get().agents[0].name], [2, '遐蝶']);
  actions.setProactive('off');
  eq('setProactive(off)：lifeNudge 派生为 false', [st().proactive, st().lifeNudge], ['off', false]);
  actions.setProactive('on');
  eq('setProactive(on)：lifeNudge 派生为 true', [st().proactive, st().lifeNudge], ['on', true]);
  actions.setProactive('auto');
  eq('setProactive(auto)：lifeNudge 派生为 false（0.1.4 的 lifeNudge 不看话量、界面里没有开关，写 true 会让回滚后凭空调模型搭话）', [st().proactive, st().lifeNudge], ['auto', false]);
  actions.setDistance(0);
  eq('旧 setDistance(0)：persona 关、level 同步为 m', [st().distance, st().persona, st().level], [0, false, 'm']);
  actions.setDistance(2);
  eq('旧 setDistance(2)：level=l', [st().distance, st().persona, st().level], [2, true, 'l']);
  actions.setStoryBox('all'); actions.setStickers(false); actions.setStepBack(false); actions.setProactiveTopics(true); actions.setLifeGreeting(false);
  eq('其余设置动作', [st().storyBox, st().stickers, st().stepBack, st().proactiveTopics, st().lifeGreeting], ['all', false, false, true, false]);
  actions.setToolPermission('shell', 'off');
  const tp = store.get().toasts[store.get().toasts.length - 1];
  eq('工具策略反馈改成「从下一步开始」', [tp.body?.includes('从下一步开始'), tp.body?.includes('下一次调用')], [true, false]);
}

section('动作：安静一小时 / 折叠 / 放下 / 她的话旁的按钮');
{
  store.init(emptyState(0));
  const before = Date.now();
  actions.quietFor(60);
  const q = store.get().quietUntil;
  eq('quietFor(60)：写 quietUntil ≈ 一小时后，并有反馈', [q >= before + 60 * MIN && q <= Date.now() + 60 * MIN, store.get().toasts.length], [true, 1]);
  actions.quietFor(0);
  eq('quietFor(0) 解除', store.get().quietUntil, 0);
  store.update((d) => { d.tasks.a = mkTask('a') as never; });
  actions.toggleFold('a'); const f1 = store.get().tasks.a.foldHer;
  actions.toggleFold('a'); const f2 = store.get().tasks.a.foldHer;
  actions.toggleFold('nope');
  eq('toggleFold 翻转 foldHer；不存在的任务不抛', [f1, f2], [true, false]);

  // 放下：待你里不再有它
  const failedRun = mkRun('rf', 'f', { status: 'failed', startedAt: T0 - 30 * MIN, endedAt: T0 - 20 * MIN, failure: { stepId: 's', message: '没过' } });
  store.init(mkState([mkTask('f', { runIds: ['rf'], lastSeenAt: T0 - HOUR })], [failedRun]));
  store.update((d) => { d.toasts.push({ id: 'tt', tone: 'danger', title: '失败', createdAt: 0, ttl: 0, key: 'run:rf' }); });
  eq('放下之前：失败的运行在待你里', deriveQueue(store.get()).map((i) => i.kind), ['failed']);
  actions.layDown('rf');
  const laid = store.get().runs.rf.laidDownAt;
  eq('layDown：写 laidDownAt，待你里不再出现，相关 toast 一并收掉', [typeof laid, deriveQueue(store.get()).length, store.get().toasts.some((t) => t.key === 'run:rf')], ['number', 0, false]);
  actions.layDown('rf');
  eq('layDown 只写一次；不存在的运行不抛', [store.get().runs.rf.laidDownAt === laid, (actions.layDown('nope'), true)], [true, true]);
  eq('放下的只是失败条目：同任务其它待你项不受影响', (() => {
    const r = mkRun('rf', 'f', { status: 'failed', startedAt: T0 - 30 * MIN, endedAt: T0 - 20 * MIN, laidDownAt: T0, approvals: [{ id: 'ap', status: 'pending', createdAt: T0 - 5 * MIN, title: '写入', runId: 'rf', taskId: 'f' } as never] });
    return deriveQueue(mkState([mkTask('f', { runIds: ['rf'], lastSeenAt: T0 - HOUR })], [r])).map((i) => i.kind);
  })(), ['approval']);

  // 她的话旁的按钮 → voiceGate
  freshGate();
  store.init(mkState([mkTask('c', { kind: 'chat', messages: [mkMsg('n1', 'agent', T0, { proactive: true, src: { id: 'nudge.photo.c.l', mode: 'chat', scene: 'nudge.photo' } })] })]));
  actions.dismissHer('c', 'n1', 'skip');
  eq('dismissHer(skip)：该场景当日不再', voiceGate('aside', 'nudge.photo', gsnap(), Date.now()).why, 'skipped');
  noteSpoken('proactive', 'nudge.book', Date.now(), 'c');
  actions.dismissHer('c', 'n1', 'noreply');
  eq('dismissHer(noreply)：只清「未回应」，不降档不置满', [gateStats(Date.now(), 'c').unanswered, gateStats(Date.now()).today], [false, 1]);
  actions.dismissHer('c', 'n1', 'enough');
  eq('dismissHer(enough)：今天别再说（置满、proactive silent）', [gateStats(Date.now()).enough, gateStats(Date.now()).today, voiceGate('proactive', 'nudge.x', gsnap(), Date.now()).why], [true, NUDGE_DAY_CAP, 'enough']);
  freshGate();
  actions.dismissHer('c', 'n1', 'x'); actions.dismissHer('c', 'n1', 'x');
  eq('dismissHer(x) 连点两次：本会话降一档', voiceGate('reply', 'q', gsnap({ level: 'l' }), Date.now()).level, 'm');
  freshGate();
  actions.dismissHer('c', 'nope', 'skip');
  eq('找不到那条消息也不抛', true, true);

  // 休息关照的两个按钮
  freshGate();
  actions.muteRest();
  eq('muteRest：今天不再提醒（休息关照 / 很晚），并有一条反馈', [voiceGate('rest', 'nudge.rest', gsnap(REST_SNAP), Date.now()).why, voiceGate('late', 'late.c', gsnap(REST_SNAP), Date.now()).why, store.get().toasts.length > 0], ['dismissed', 'dismissed', true]);
  freshGate();
  for (let n = 0; n < 3; n++) { const d = at(14, 0, n); noteSpoken('rest', 'nudge.rest', d); settleIgnored(d + 6 * MIN, d + 5 * MIN); }
  actions.acceptRest();
  eq('acceptRest：被忽略计数清零', gateStats(at(14, 0, 3)).ignoredStreak, 0);
  freshGate();
  actions.run({ type: 'mute-rest' });
  eq('UiCommand mute-rest 走 muteRest', voiceGate('rest', 'nudge.rest', gsnap(REST_SNAP), Date.now()).why, 'dismissed');
}

section('动作：记得小事');
{
  store.init(emptyState(0));
  const mem = () => store.get().memory;
  eq('memoryOn 关：不存', [actions.addMemory('喜欢喝热茶').ok, mem().length], [false, 0]);
  actions.setMemoryOn(true);
  const a = actions.addMemory('  喜欢喝\n 热茶  ');
  eq('空白折成一个空格再存', [a.ok, mem()[0].text, mem()[0].taskId], [true, '喜欢喝 热茶', undefined]);
  const dup = actions.addMemory('喜欢喝 热茶');
  eq('同范围同样的话不重复存（返回原 id）', [dup.ok, dup.ok && a.ok && dup.id === a.id, mem().length], [true, true, 1]);
  const scoped = actions.addMemory('喜欢喝 热茶', 't1');
  eq('范围不同（仅某场对话）可以再存', [scoped.ok, mem().length, mem()[1].taskId], [true, 2, 't1']);
  eq('空文本 / 超过 80 字 → 失败；恰好 80 字 → 通过', [actions.addMemory('   ').ok, actions.addMemory('一'.repeat(81)).ok, actions.addMemory('二'.repeat(80)).ok], [false, false, true]);
  eq('错误提示是中文', (() => { const r = actions.addMemory('三'.repeat(81)); return !r.ok && /80/.test(r.error); })(), true);
  eq('按字符数算（emoji 不是两个字）', actions.addMemory('🙂'.repeat(80)).ok, true);
  for (let i = mem().length; i < 20; i++) actions.addMemory(`第 ${i} 条`);
  const over = actions.addMemory('第 21 条');
  eq('最多 20 条', [mem().length, over.ok, !over.ok && over.error.includes('20')], [20, false, true]);
  const first = mem()[0];
  eq('editMemory：改文字', [actions.editMemory(first.id, '喜欢喝冷茶').ok, mem()[0].text], [true, '喜欢喝冷茶']);
  eq('editMemory：空 / 超长 / 撞上同范围同样的话 / 不存在 → 失败', [
    actions.editMemory(first.id, ' ').ok, actions.editMemory(first.id, '四'.repeat(81)).ok, actions.editMemory(first.id, mem()[2].text).ok, actions.editMemory('nope', 'x').ok,
  ], [false, false, false, false]);
  actions.removeMemory(first.id);
  eq('removeMemory', [mem().length, mem().some((m) => m.id === first.id)], [19, false]);
  actions.setMemoryOn(false);
  eq('关掉 memoryOn 不清数据（可一键清空）', mem().length, 19);
  eq('关掉后不能新增', actions.addMemory('新的一条').ok, false);
  store.update((d) => { d.memory.push({ id: 'orph', text: '孤儿', at: 1, taskId: 'gone-task' }); });
  eq('带 taskId 而任务已不存在的条目（孤儿）保留，可见可删', mem().some((m) => m.id === 'orph'), true);
  actions.clearMemory();
  eq('clearMemory 一键清空', mem().length, 0);
}

/* ═════════════ 命令 ═════════════ */
section('命令：靠近 / 远一点 / 请她安静 / 正常说 / 安静一小时 / 别主动说话 / 折叠');
{
  store.init(emptyState(0));
  const cmd = (id: string) => { const c = commandById(id); if (!c) throw new Error(`没有命令 ${id}`); return c; };
  const en = (id: string) => cmd(id).enabled?.() ?? true;
  for (const id of ['voice.closer', 'voice.farther', 'voice.plain', 'voice.normal', 'voice.quiet', 'voice.noProactive', 'voice.proactive', 'voice.fold']) ok(`命令 ${id} 已注册，分类「她」，有标题和拼音别名`, !!commandById(id) && commandById(id)!.category === '她' && !!commandById(id)!.title && (commandById(id)!.aliases?.length ?? 0) > 0);
  eq('命令没有键位冲突、没有保留键、没有批准类绑定', [findConflicts(commands()), commands().flatMap((c) => c.keys ?? []).some((k) => /approve|批准/i.test(k)), commands().filter((c) => c.id.startsWith('voice.')).every((c) => !c.keys?.length)], [[], false, true]);
  eq('话量 m：靠近可用、远一点可用', [en('voice.closer'), en('voice.farther')], [true, true]);
  cmd('voice.closer').run(); eq('靠近 → l', store.get().settings.level, 'l');
  eq('l 档：靠近不可用并说原因', en('voice.closer'), '已经是最近的一档');
  cmd('voice.farther').run(); cmd('voice.farther').run(); eq('远一点 ×2 → s', store.get().settings.level, 's');
  eq('s 档：远一点不可用并说原因', en('voice.farther'), '已经是最远的一档');
  eq('请她安静 = 角色口吻关；正常说 = 开', (() => {
    const a = en('voice.plain'); cmd('voice.plain').run(); const p1 = store.get().settings.persona; const b = en('voice.plain'); const c = en('voice.normal');
    cmd('voice.normal').run(); return [a, p1, b, c, store.get().settings.persona, en('voice.normal')];
  })(), [true, false, '已经只说事实了', true, true, '已经是正常说话了']);
  cmd('voice.quiet').run(); const quiet1 = store.get().quietUntil > Date.now();
  cmd('voice.quiet').run();
  eq('安静一小时：再用一次解除', [quiet1, store.get().quietUntil], [true, 0]);
  cmd('voice.noProactive').run();
  eq('别主动说话 → proactive=off（rest / late 从此只出系统行）；此后该命令不可用，「允许她主动说话」可用', [store.get().settings.proactive, en('voice.noProactive'), en('voice.proactive')], ['off', '她已经不会主动说话了', true]);
  cmd('voice.proactive').run();
  eq('允许她主动说话 → auto', store.get().settings.proactive, 'auto');
  eq('折叠她的话：没有打开任务时不可用', en('voice.fold'), '先打开一个任务');
  store.update((d) => { d.tasks.a = mkTask('a') as never; d.selectedTaskId = 'a'; d.view = 'task'; });
  cmd('voice.fold').run();
  eq('折叠她的话：打开任务后翻转 foldHer', [en('voice.fold'), store.get().tasks.a.foldHer], [true, true]);
}

/* ═════════════ presence / ime / draft ═════════════ */
section('presence：连续使用 / ime：组合态 / draft：草稿');
{
  resetPresenceForTest(T0);
  eq('刚开始：0 分钟', continuousMinutes(T0), 0);
  for (let t = T0; t <= T0 + 120 * MIN; t += 10 * MIN) recordInput(t);
  eq('每 10 分钟一次输入，连续两小时 = 120 分钟，起点是第一次输入', [continuousMinutes(T0 + 120 * MIN), continuousSince(T0 + 120 * MIN), lastInputAt()], [120, T0, T0 + 120 * MIN]);
  eq('向下取整', continuousMinutes(T0 + 120 * MIN + 59_000), 120);
  eq('最近输入过去 <20 分钟：仍在连续', continuousMinutes(T0 + 120 * MIN + CONTINUOUS_GAP_MS - 1) >= 139, true);
  eq('最近 20 分钟没输入：不算在用（0），起点是现在', [continuousMinutes(T0 + 120 * MIN + CONTINUOUS_GAP_MS), continuousSince(T0 + 120 * MIN + CONTINUOUS_GAP_MS)], [0, T0 + 120 * MIN + CONTINUOUS_GAP_MS]);
  recordInput(T0 + 120 * MIN + 40 * MIN);
  eq('歇了 ≥20 分钟再输入：新的一段，从这一刻起算', [continuousMinutes(T0 + 170 * MIN), continuousSince(T0 + 170 * MIN)], [10, T0 + 160 * MIN]);
  recordInput(T0);
  eq('乱序的旧时间戳不会倒退 lastInput', lastInputAt(), T0 + 160 * MIN);

  setComposingForTest(false);
  const seen: boolean[] = [];
  const off = subscribeComposing(() => seen.push(isComposingNow()));
  setComposingForTest(true); setComposingForTest(true); setComposingForTest(false);
  off(); setComposingForTest(true);
  eq('ime：组合态变化才通知、可退订', [seen, isComposingNow()], [[true, false], true]);
  setComposingForTest(false);

  clearDraft('d1'); clearDraft('d2');
  const flips: string[] = [];
  const unsub = subscribeDraft(() => flips.push(`${hasDraft('d1')}`));
  setDraft('d1', '写了'); setDraft('d1', '写了一半'); setDraft('d1', '   '); setDraft('d1', '再写'); clearDraft('d1'); clearDraft('d1');
  unsub(); setDraft('d2', 'x');
  eq('draft：空白等同清除；只有「有 / 无」翻转才通知；可退订', [flips, hasDraft('d1'), hasDraft('d2')], [['true', 'false', 'true', 'false'], false, true]);
  clearDraft('d2');
}

/* ═════════════ proactive：写入点（只断言接线） ═════════════ */
const chatWith = (msgs: Message[], patch: (s: AppState) => void = () => {}): AppState =>
  mkState([mkTask('c', { kind: 'chat', messages: msgs })], [], (s) => { s.view = 'task'; s.selectedTaskId = 'c'; s.settings.level = 'l'; s.settings.proactive = 'auto'; patch(s); });
const tail = (): Message => { const m = store.get().tasks.c.messages; return m[m.length - 1]; };
const countMsgs = () => store.get().tasks.c.messages.length;
const feedInputs = (now: number, minutes: number) => { resetPresenceForTest(now - minutes * MIN); for (let t = now - minutes * MIN; t <= now; t += 10 * MIN) recordInput(t); recordInput(now); };
const quietMsgs = (): Message[] => [mkMsg('u1', 'user', T0 - 30 * MIN), mkMsg('a1', 'agent', T0 - 20 * MIN, { agentId: 'orchestrator' })];

section('proactive：foregroundChat / buildNudgeSnap');
{
  setProactiveEnvForTest({ visible: () => true, focused: () => true });
  setComposingForTest(false); clearDraft('c'); freshGate();
  const s = chatWith(quietMsgs());
  eq('foregroundChat：任务页 + 选中闲聊 才算', [foregroundChat(s)?.id, foregroundChat({ ...s, view: 'tasks' }), foregroundChat({ ...s, tasks: { c: { ...s.tasks.c, kind: 'work' } } }), foregroundChat({ ...s, selectedTaskId: undefined })], ['c', undefined, undefined, undefined]);
  const snap = buildNudgeSnap(s, T0);
  eq('buildNudgeSnap：窗口 / 任务 / 计数', [snap.visible, snap.focused, snap.task?.id, snap.task?.userSpoke, snap.task?.lastAt, snap.task?.replying, snap.pendingAny, snap.today, snap.session, snap.unansweredPrev], [true, true, 'c', true, T0 - 20 * MIN, false, false, 0, 0, false]);
  eq('buildNudgeSnap：gate 快照取的是前台闲聊任务', [snap.gate.taskId, snap.gate.level, snap.gate.proactive], ['c', 'l', 'auto']);
  eq('buildNudgeSnap：流式中的最后一条算她正在回复', buildNudgeSnap(chatWith([...quietMsgs().slice(0, 1), mkMsg('s', 'agent', T0 - MIN, { streaming: true })]), T0).task?.replying, true);
  const waiting = mkState([mkTask('c', { kind: 'chat', messages: quietMsgs() }), mkTask('w', { runIds: ['r'] })], [mkRun('r', 'w', { approvals: [{ id: 'ap', status: 'pending', createdAt: T0, title: 't', runId: 'r', taskId: 'w' } as never] })], (x) => { x.view = 'task'; x.selectedTaskId = 'c'; });
  eq('buildNudgeSnap：别的任务里有待批审批也算 pendingAny', buildNudgeSnap(waiting, T0).pendingAny, true);
  eq('buildNudgeSnap：不是闲聊页 → 没有 task', buildNudgeSnap({ ...s, view: 'queue' }, T0).task, undefined);
  setDraft('c', 'x'); eq('buildNudgeSnap：草稿', buildNudgeSnap(s, T0).gate.hasDraft, true); clearDraft('c');
}

section('proactive：fireNudge（主动搭话，默认 nudge.* 模板）');
{
  const hold = (s: AppState, now = T0, env?: { visible?: boolean; focused?: boolean }) => {
    setProactiveEnvForTest({ visible: () => env?.visible ?? true, focused: () => env?.focused ?? true });
    freshGate(); setComposingForTest(false); clearDraft('c'); store.init(s);
    return fireNudge(now);
  };
  const id = hold(chatWith(quietMsgs()));
  const m = tail();
  eq('说了：写进前台闲聊任务，返回消息 id', [typeof id, m.id === id, countMsgs()], ['string', true, 3]);
  eq('消息形状：编排署名 / note / 主动话 / 夜昼 / 时间', [m.role, m.agentId, m.kind, m.proactive, m.persona, m.at, m.text.trim().length > 0], ['agent', 'orchestrator', 'note', true, 'night', T0, true]);
  ok('expr 由 settleExpr 在此刻定下（合法的六个之一）', !!m.expr && (EXPR_IDS as readonly string[]).includes(m.expr));
  eq('src 记出处：nudge.* 场景；系统行所需的 slots（静默 20 分钟——真实的静默时长，不是常量 8 · 今天 1/3）', [m.src?.scene?.startsWith('nudge.'), m.src?.slots?.sys, m.src?.slots?.silent, m.src?.slots?.today, m.src?.slots?.cap, m.src?.mode], [true, 'nudge', 20, 1, NUDGE_DAY_CAP, 'chat']);
  eq('记账：今天 1、本会话 1、未回应、场景计数', [gateStats(T0, 'c').today, gateStats(T0, 'c').session, gateStats(T0, 'c').unanswered, sceneCountToday(m.src!.scene!, T0)], [1, 1, true, 1]);
  eq('任务的更新时间被推到现在', store.get().tasks.c.updatedAt, T0);
  eq('这是一条「未被回应的非功能话」；胶囊类别 = 小话题；神色一路里能看到它', [unansweredHer(store.get().tasks.c.messages), pillAfterOf(m.src?.scene), selectTrail(store.get(), 'c').slice(-1)[0].expr === m.expr], [true, 'nudge', true]);
  eq('不带贴纸（主动话永不带贴纸）', decideSticker({ level: 'l', mode: 'chat', kind: 'note', expr: m.expr ?? 'gentle', requested: 'butterfly', sessionCount: 0, sinceLast: 99, retreat: false, proactive: true }), undefined);
  eq('上一次没得到回应 → 不再说', [fireNudge(T0 + 9 * MIN), countMsgs()], [undefined, 3]);
  const firstScene = m.src!.scene!;
  // 用户回应后再说：换一个话题；本会话第 3 次不说
  store.update((d) => { d.tasks.c.messages.push(mkMsg('u2', 'user', T0 + 10 * MIN, { text: '嗯，听着呢' })); });
  noteAnswered('c', T0 + 10 * MIN);
  const id2 = fireNudge(T0 + 30 * MIN);
  eq('用户回应后（静默 ≥8 分钟）可以再说，且换了话题', [typeof id2, tail().src?.scene !== firstScene, gateStats(T0 + 30 * MIN, 'c').today], ['string', true, 2]);
  store.update((d) => { d.tasks.c.messages.push(mkMsg('u3', 'user', T0 + 40 * MIN, { text: '嗯' })); });
  noteAnswered('c', T0 + 40 * MIN);
  eq('该任务本会话已 2 次 → 不再说', [fireNudge(T0 + 60 * MIN), gateStats(T0 + 60 * MIN, 'c').session], [undefined, 2]);

  // 不说的情形：消息条数不变
  const none = (name: string, s: AppState, env?: { visible?: boolean; focused?: boolean }, now = T0) => { const n0 = s.tasks.c?.messages.length ?? 0; const r = hold(s, now, env); eq(`不说：${name}`, [r, store.get().tasks.c?.messages.length ?? 0], [undefined, n0]); };
  none('不在任务页', chatWith(quietMsgs(), (s) => { s.view = 'queue'; }));
  none('前台是工作任务', mkState([mkTask('c', { kind: 'work', messages: quietMsgs() })], [], (s) => { s.view = 'task'; s.selectedTaskId = 'c'; s.settings.level = 'l'; }));
  none('角色口吻关', chatWith(quietMsgs(), (s) => { s.settings.persona = false; }));
  none('主动说话 off', chatWith(quietMsgs(), (s) => { s.settings.proactive = 'off'; }));
  none('话量 中 + auto', chatWith(quietMsgs(), (s) => { s.settings.level = 'm'; }));
  none('窗口隐藏', chatWith(quietMsgs()), { visible: false });
  none('窗口没焦点', chatWith(quietMsgs()), { focused: false });
  none('静默不满 8 分钟', chatWith([mkMsg('u1', 'user', T0 - 30 * MIN), mkMsg('a1', 'agent', T0 - 5 * MIN)]));
  none('用户在该任务里没说过话', chatWith([mkMsg('a1', 'agent', T0 - 20 * MIN)]));
  none('钟点 22:00 以后', chatWith([mkMsg('u1', 'user', at(22, 0) - 30 * MIN), mkMsg('a1', 'agent', at(22, 0) - 20 * MIN)]), undefined, at(22, 10));
  none('安静一小时中', chatWith(quietMsgs(), (s) => { s.quietUntil = T0 + MIN; }));
  { freshGate(); store.init(chatWith(quietMsgs())); setDraft('c', '写了一半'); const n = countMsgs(); eq('不说：输入框里有草稿', [fireNudge(T0), countMsgs()], [undefined, n]); clearDraft('c'); }
  { freshGate(); store.init(chatWith(quietMsgs())); setComposingForTest(true); const n = countMsgs(); eq('不说：输入法在组合', [fireNudge(T0), countMsgs()], [undefined, n]); setComposingForTest(false); }
  { freshGate(); store.init(chatWith(quietMsgs())); noteCrisis(T0); const n = countMsgs(); eq('不说：危机当天', [fireNudge(T0), countMsgs()], [undefined, n]); }
  { freshGate(); store.init(chatWith(quietMsgs())); for (let i = 0; i < HOURLY_BUDGET.l; i++) noteSpoken('aside', `a.${i}`, T0 - i * 1000); const n = countMsgs(); eq('不说：每小时预算满', [fireNudge(T0), countMsgs()], [undefined, n]); }

  // 让她自己想话题：走 live.reply({nudge:true})，这里没有模型（task.engine 为空），只断言接线：不写模板消息、照常记账
  const model = hold(chatWith(quietMsgs(), (s) => { s.settings.proactiveTopics = true; }));
  eq('proactiveTopics 开：不写模板话（交给 live.reply，模型可回 silent 由 E 删消息），但今天次数照记', [model, countMsgs(), gateStats(T0, 'c').today, gateStats(T0, 'c').unanswered], ['model', 2, 1, true]);
}

section('proactive：maybeGreet（每日按时辰问候，greet.* 模板）');
{
  const run = (s: AppState, now = T0, env?: { visible?: boolean; focused?: boolean }) => {
    setProactiveEnvForTest({ visible: () => env?.visible ?? true, focused: () => env?.focused ?? true });
    freshGate(); clearDraft('c'); store.init(s);
    return maybeGreet(now);
  };
  const id = run(chatWith([]));
  const m = tail();
  eq('空的闲聊页：问候一句，按钟点选 greet.noon（14:00）', [typeof id, m.id === id, m.src?.scene?.startsWith('greet.noon'), m.src?.slots?.sys, m.proactive, m.role, m.agentId, m.kind], ['string', true, true, 'greet', true, 'agent', 'orchestrator', 'note']);
  eq('问候记账：今天已问候；再来一次不说', [greetedToday(T0), maybeGreet(T0 + MIN), countMsgs()], [true, undefined, 1]);
  eq('问候是一条未被回应的非功能话（G7）', unansweredHer(store.get().tasks.c.messages), true);
  eq('次日再开：又问候一次（换成对应钟点的场景）', (() => { store.update((d) => { d.tasks.c.messages.push(mkMsg('u', 'user', T0 + MIN)); }); return typeof maybeGreet(at(9, 0, 1)); })(), 'string');
  run(chatWith([]), at(9, 0)); eq('早上 9 点 → greet.am；深夜 23 点 → greet.late', [tail().src?.scene?.startsWith('greet.am'), (run(chatWith([]), at(23, 0)), tail().src?.scene?.startsWith('greet.late'))], [true, true]);
  eq('隔了 ≥30 分钟没动静的闲聊页也问候', typeof run(chatWith([mkMsg('u', 'user', T0 - 40 * MIN), mkMsg('a', 'agent', T0 - 39 * MIN)])), 'string');
  const none = (name: string, s: AppState, env?: { visible?: boolean; focused?: boolean }) => { const n0 = s.tasks.c?.messages.length ?? 0; eq(`不问候：${name}`, [run(s, T0, env), store.get().tasks.c?.messages.length ?? 0], [undefined, n0]); };
  none('刚聊过（<30 分钟）', chatWith([mkMsg('u', 'user', T0 - 10 * MIN), mkMsg('a', 'agent', T0 - 9 * MIN)]));
  none('lifeGreeting 关', chatWith([], (s) => { s.settings.lifeGreeting = false; }));
  none('角色口吻关（非功能话 silent）', chatWith([], (s) => { s.settings.persona = false; }));
  none('窗口隐藏', chatWith([]), { visible: false });
  none('不在任务页', chatWith([], (s) => { s.view = 'queue'; }));
  none('安静一小时中', chatWith([], (s) => { s.quietUntil = T0 + MIN; }));
  none('她在流式回复', chatWith([mkMsg('u', 'user', T0 - 90 * MIN), mkMsg('a', 'agent', T0 - 80 * MIN, { streaming: true })]));
  eq('不问候：有待你的事 → 该出归来笺（openingFor = brief），不在闲聊页里抢话', (() => {
    const s = mkState([mkTask('c', { kind: 'chat', messages: [] }), mkTask('w', { runIds: ['r'] })], [mkRun('r', 'w', { approvals: [{ id: 'ap', status: 'pending', createdAt: T0, title: 't', runId: 'r', taskId: 'w' } as never] })], (x) => { x.view = 'task'; x.selectedTaskId = 'c'; });
    setProactiveEnvForTest(); setProactiveEnvForTest({ visible: () => true, focused: () => true }); freshGate(); store.init(s);
    return [maybeGreet(T0), store.get().tasks.c.messages.length];
  })(), [undefined, 0]);
}

section('proactive：fireRest（休息关照 / 很晚）');
{
  setProactiveEnvForTest({ visible: () => true, focused: () => true });
  const go = (s: AppState, now = T0, minutes = 130) => { freshGate(); setComposingForTest(false); store.init(s); feedInputs(now, minutes); return fireRest(now); };
  const r1 = go(chatWith(quietMsgs()));
  const m = tail();
  eq('连续 130 分钟：她开口，写进前台闲聊任务', [r1, m.role, m.agentId, m.kind, m.proactive, m.src?.scene?.startsWith('nudge.rest'), m.src?.slots?.sys, m.src?.slots?.hours, countMsgs()], ['her', 'agent', 'orchestrator', 'note', true, true, 'rest', '两小时', 3]);
  eq('系统行要的数字单独放：hrs=2（hours 是模板槽位，不被盖掉）', m.src?.slots?.hrs, 2);
  eq('休息关照之后胶囊类别 = rest', pillAfterOf(m.src?.scene), 'rest');
  eq('记账：同一段连续使用里不再提', [fireRest(T0 + MIN), countMsgs()], [undefined, 3]);
  eq('不满 120 分钟：不说', [go(chatWith(quietMsgs()), T0, 100), countMsgs()], [undefined, 2]);
  eq('窗口隐藏：不说', (() => { setProactiveEnvForTest({ visible: () => false }); const r = go(chatWith(quietMsgs())); setProactiveEnvForTest({ visible: () => true, focused: () => true }); return [r, countMsgs()]; })(), [undefined, 2]);

  const line = go(chatWith(quietMsgs(), (s) => { s.settings.proactive = 'off'; }));
  const lm = tail();
  eq('主动说话 off：rest 只出一行系统行（role=system，不是她的话）', [line, lm.role, lm.src?.scene, lm.proactive, lm.text.trim().length > 0, /[！～]/.test(lm.text), lm.agentId, lm.expr], ['line', 'system', 'sys.rest', true, true, false, undefined, undefined]);
  eq('系统行也记进 G9（同段不再提）', fireRest(T0 + MIN), undefined);
  eq('安静一小时 / 角色口吻关 → 同样只出系统行', [go(chatWith(quietMsgs(), (s) => { s.quietUntil = T0 + HOUR; })), tail().role, go(chatWith(quietMsgs(), (s) => { s.settings.persona = false; })), tail().role], ['line', 'system', 'line', 'system']);
  eq('危机当天 → 系统行', (() => { freshGate(); store.init(chatWith(quietMsgs())); feedInputs(T0, 130); noteCrisis(T0); return [fireRest(T0), tail().role]; })(), ['line', 'system']);

  const toasted = go(chatWith(quietMsgs(), (s) => { s.view = 'queue'; }));
  const tt = store.get().toasts.find((x) => x.key === 'rest');
  eq('没有前台闲聊任务：降级为一次性 toast，带「今天别再提醒」，对话流不动', [toasted, !!tt, tt?.action?.label, tt?.action?.command, (tt?.ttl ?? 0) > 0, countMsgs()], ['toast', true, '今天别再提醒', { type: 'mute-rest' }, true, 2]);
  eq('toast 也计入 G9（同段不再提）', [fireRest(T0 + MIN)], [undefined]);

  // 很晚（01:00–06:00）走 late.*，槽位是钟点
  const lateAt = at(3, 0, 1);
  const lateR = go(chatWith([mkMsg('u1', 'user', lateAt - 30 * MIN), mkMsg('a1', 'agent', lateAt - 20 * MIN)]), lateAt);
  const lmsg = tail();
  eq('凌晨 3 点：late.c，槽位 clock=03:00', [lateR, lmsg.src?.scene?.startsWith('late.c'), lmsg.src?.slots?.sys, lmsg.src?.slots?.clock, pillAfterOf(lmsg.src?.scene)], ['her', true, 'late', '03:00', 'late']);

  // 连续 3 次被忽略 → chip：右栏状态牌上亮一枚标记，不进对话流
  freshGate(); resetPresenceForTest(0);
  for (let n = 0; n < 3; n++) { const d = at(14, 0, n); noteSpoken('rest', 'nudge.rest', d); settleIgnored(d + 6 * MIN, d + 5 * MIN); }
  store.init(chatWith(quietMsgs()));
  const day3 = at(14, 0, 3);
  feedInputs(day3, 130);
  const chipR = fireRest(day3);
  eq('连续 3 次被忽略：chip（restChip 亮起），不写消息', [chipR, restChip.get()?.kind, countMsgs()], ['chip', 'rest', 2]);
  eq('chip 也记下开口时刻：2 小时内不再亮', fireRest(day3 + MIN), undefined);
  restChip.set(undefined);
}

section('proactive：reschedule（一次性 setTimeout，不轮询，窗口隐藏不排）');
{
  type Timer = { id: number; ms: number; live: boolean };
  const timers: Timer[] = [];
  const g = globalThis as unknown as { window?: unknown };
  const had = 'window' in g; const prev = g.window;
  g.window = {
    setTimeout: (_fn: () => void, ms: number) => { const t = { id: timers.length + 1, ms, live: true }; timers.push(t); return t.id; },
    clearTimeout: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
  };
  const live = () => timers.filter((t) => t.live).map((t) => t.ms).sort((a, b) => a - b);
  try {
    resetProactiveSchedForTest();
    setProactiveEnvForTest({ visible: () => true, focused: () => true });
    freshGate(); setComposingForTest(false); clearDraft('c'); resetPresenceForTest(T0);
    store.init(chatWith([mkMsg('u1', 'user', T0 - 30 * MIN), mkMsg('a1', 'agent', T0 - 2 * MIN)]));
    reschedule(T0);
    eq('主动搭话：最后一条消息 + 8 分钟；休息关照：这一段连续使用的起点 + 120 分钟', live(), [6 * MIN, 120 * MIN]);
    const n = timers.length;
    reschedule(T0);
    eq('同样的状态再算一遍：不重复排', timers.length, n);
    store.update((d) => { d.tasks.c.messages.push(mkMsg('a2', 'agent', T0 - MIN)); });
    reschedule(T0);
    eq('来了新消息：旧的收掉，按新的最后一条重排', live(), [7 * MIN, 120 * MIN]);
    setProactiveEnvForTest({ visible: () => false, focused: () => true });
    reschedule(T0);
    eq('窗口隐藏：两个都不排（也不留旧的）', live(), []);
    setProactiveEnvForTest({ visible: () => true, focused: () => true });
    reschedule(T0);
    eq('回到窗口：重新排', live(), [7 * MIN, 120 * MIN]);
    store.update((d) => { d.settings.proactive = 'off'; });
    reschedule(T0);
    eq('主动说话 off：不排搭话（休息关照仍排，它到点只出系统行）', live(), [120 * MIN]);
    store.update((d) => { d.settings.proactive = 'auto'; d.quietUntil = T0 + 30 * MIN; });
    reschedule(T0);
    eq('安静一小时中：搭话推迟到安静结束之后', live(), [30 * MIN + 1000, 120 * MIN]);
    store.update((d) => { d.quietUntil = 0; d.settings.persona = false; });
    reschedule(T0);
    eq('角色口吻关：不排搭话；休息关照照排（到点只出系统行，安全类提醒不能消失）', live(), [120 * MIN]);
    store.update((d) => { d.settings.persona = true; });
    store.init(chatWith([mkMsg('u1', 'user', at(22, 0) - 30 * MIN), mkMsg('a1', 'agent', at(22, 0) - 5 * MIN)]));
    reschedule(at(22, 0));
    eq('今晚过了 22:00：不排搭话', live().filter((x) => x < 100 * MIN), []);
    store.init(chatWith([mkMsg('a1', 'agent', T0 - 2 * MIN)]));
    reschedule(T0);
    eq('用户从没说过话：不排搭话', live().filter((x) => x < 100 * MIN), []);
    store.init(chatWith([mkMsg('u1', 'user', T0 - 30 * MIN), mkMsg('a1', 'agent', T0 - 2 * MIN)]));
    freshGate(); noteCrisis(T0);
    reschedule(T0);
    eq('危机当天：不排搭话', live().filter((x) => x < 100 * MIN), []);
    freshGate();
    feedInputs(T0, 100);
    reschedule(T0);
    eq('已经连续 100 分钟：休息关照排在 20 分钟后', live().includes(20 * MIN), true);
    feedInputs(T0, 130);
    reschedule(T0);
    eq('已经连续 130 分钟：马上排（0）', live().includes(0), true);
    resetPresenceForTest(T0 - 3 * HOUR);
    reschedule(T0);
    eq('最近 20 分钟没有输入（不在用）：不排休息关照', live().filter((x) => x >= 100 * MIN), []);
  } finally {
    resetProactiveSchedForTest();
    if (had) g.window = prev; else delete g.window;
    setProactiveEnvForTest();
  }
}

section('proactive：startProactive（接线：订阅 / 退订 / 幂等）');
{
  const g = globalThis as unknown as { window?: unknown; document?: unknown };
  const hadW = 'window' in g; const hadD = 'document' in g; const pw = g.window; const pd = g.document;
  const added: string[] = []; const removed: string[] = [];
  const target = { addEventListener: (t: string) => { added.push(t); }, removeEventListener: (t: string) => { removed.push(t); }, setTimeout: () => 1, clearTimeout: () => {} };
  g.window = target; g.document = { addEventListener: (t: string) => { added.push(`doc:${t}`); }, removeEventListener: (t: string) => { removed.push(`doc:${t}`); } };
  try {
    setProactiveEnvForTest({ visible: () => false, focused: () => false });
    store.init(mkState([mkTask('c', { kind: 'chat' })], [], (s) => { s.view = 'queue'; }));
    const stop = startProactive();
    const stop2 = startProactive();
    eq('startProactive：监听窗口焦点 / 失焦 / 可见性 / 输入；重复调用不重复挂', [added.sort(), stop === stop2], [['doc:visibilitychange', 'blur', 'focus', 'keydown', 'pointerdown'].sort(), true]);
    stop();
    eq('stop：全部摘掉', removed.sort(), added.slice().sort());
    stop();
    eq('stop 可重复调用', removed.length, added.length);
    const again = startProactive(); again();
    eq('停了之后可以再启动', added.length, 10);
  } finally {
    if (hadW) g.window = pw; else delete g.window;
    if (hadD) g.document = pd; else delete g.document;
    setProactiveEnvForTest();
  }
}

/* ═════════════ 评审回归（第四轮审查确认的问题） ═════════════ */

section('回归 exprTag：包裹符 / 行内代码 / 全角冒号 / 中段双括号 / ~~~ 围栏');
{
  const p = parseExprTags;
  const T = (raw: string, o?: { final?: boolean }) => { const r = p(raw, o); return [r.text, r.expr, r.react, r.hold]; };
  eq('行内代码包着、独占一行的标签：连包裹符剥掉并取表情', T('`⟦face:gentle⟧`\n好的'), ['好的', 'gentle', undefined, false]);
  eq('粗体包着的标签', T('**⟦face:gentle⟧**\n好的'), ['好的', 'gentle', undefined, false]);
  eq('下划线 / 双反引号包着', [T('__⟦face:shy⟧__\n好的'), T('``⟦face:shy⟧``\n好的')], [['好的', 'shy', undefined, false], ['好的', 'shy', undefined, false]]);
  eq('引用符开头：标签与引用符一起剥，正文的引用保留', T('> ⟦face:gentle⟧\n> 好的'), ['> 好的', 'gentle', undefined, false]);
  eq('结尾：行内代码 / 引用符里的标签', [T('好的\n`⟦face:gentle⟧`'), T('好的\n> ⟦face:gentle⟧')], [['好的', 'gentle', undefined, false], ['好的', 'gentle', undefined, false]]);
  eq('粗体包着的标签后面紧跟正文', T('**⟦face:gentle⟧** 好的'), ['好的', 'gentle', undefined, false]);
  eq('不成对的包裹符不算：标签剥掉，包裹符留着（不吞正文）', T('**⟦face:gentle⟧ 好的**'), ['** 好的**', undefined, undefined, false]);
  const lit = '我把标签写成了 `⟦face:gentle⟧`，解析器会认。';
  eq('正文里行内代码讲标签语法：原样保留（不留空的 ``）', [stripExprTags(lit), T(lit)], [lit, [lit, undefined, undefined, false]]);
  const lit2 = '`⟦face:gentle⟧` 是标签的写法。';
  eq('开头的行内代码后面还有字：是在讲语法，保留，不取表情', T(lit2), [lit2, undefined, undefined, false]);
  eq('独占一行的行内代码（中段）：整行去掉', stripExprTags('前\n`⟦face:gentle⟧`\n后'), '前\n后');
  eq('独占一行的引用（中段）：整行去掉', stripExprTags('前\n> ⟦face:gentle⟧\n后'), '前\n后');
  eq('句中的粗体包着：包裹符与标签一起去掉（不留 ****）', stripExprTags('前 **⟦face:gentle⟧** 后'), '前  后');
  eq('围栏内的行内代码标签不动', stripExprTags('```\n`⟦face:gentle⟧`\n```'), '```\n`⟦face:gentle⟧`\n```');
  eq('~~~ 围栏同样保护；围栏外照剥', stripExprTags('前\n~~~\n⟦face:shy⟧\n~~~\n⟦face:relaxed⟧后'), '前\n~~~\n⟦face:shy⟧\n~~~\n后');
  eq('流式：包裹符 + 未收尾的标签也 hold，不闪出半截', [T('`⟦face:ge'), T('**⟦fac'), T('> ⟦face')], [['', undefined, undefined, true], ['', undefined, undefined, true], ['', undefined, undefined, true]]);
  eq('final 时残片剥掉不 hold', T('`⟦face:ge', { final: true }), ['', undefined, undefined, false]);
  for (const x of ['`⟦face:gentle⟧`\n好的', '> ⟦face:gentle⟧\n> 好的', lit, '前\n`⟦face:gentle⟧`\n后']) { const once = stripExprTags(x); eq(`包裹符用例 stripExprTags 幂等：${JSON.stringify(x).slice(0, 20)}`, stripExprTags(once), once); }

  eq('全角冒号 / 逗号：开头取表情', T('⟦face：gentle｜react：like⟧好的。'), ['好的。', 'gentle', 'like', false]);
  eq('全角冒号：结尾与中段都剥', [T('好的。⟦face：shy⟧'), stripExprTags('你好。\n\n⟦face：relaxed⟧ 完成。')], [['好的。', 'shy', undefined, false], '你好。\n\n 完成。']);
  eq('全角冒号：done 出口的 stripExprTags 不再把标签带进 st.result', /face/.test(stripExprTags('⟦face：gentle⟧\n结果在这里。')), false);
  eq('流式：全角冒号的残片也 hold', T('⟦face：gen'), ['', undefined, undefined, true]);
  eq('中段容错双括号 [[face:…]] / <<react:…>> 也剥（续写的第二个气泡开头写成这样）', [stripExprTags('第一段。\n\n[[face:relaxed]] 第二段。'), stripExprTags('一\n\n<<react:like>> 二')], ['第一段。\n\n 第二段。', '一\n\n 二']);
  const prose = 'a[face:y]z 中间 [face:x] 还有 [[笔记]] 和 <<说明>> 收尾';
  eq('中段的单括号 / 不像标签的双括号不动（不误吞正文）', stripExprTags(prose), prose);
}

section('回归 isClosure：用户说自己的状态不当收尾');
{
  const prevStmt = { text: '这一步改完了，文件在左边。', kind: 'reply' as const, src: { id: 'x', mode: 'chat' as const, scene: 'chat.reply' } };
  for (const t of ['好辛苦', '太辛苦了', '真辛苦', '你了解', '多了解', '辛苦', '了解']) ok(`不是收尾（要回应）：${t}`, !isClosure(t, { prev: prevStmt }));
  for (const t of ['辛苦了', '你辛苦了', '辛苦啦', '辛苦你了', '了解了', '好的，谢谢', '好的收到', '嗯嗯谢谢', '多谢啦', '谢谢你']) ok(`仍是收尾：${t}`, isClosure(t, { prev: prevStmt }));
}

section('回归 actions：setAgentTier 的「从下一步开始」/ lifeNudge 垫片 / 折叠记 I-22');
{
  store.init(emptyState(0));
  const last = () => store.get().toasts[store.get().toasts.length - 1];
  actions.setAgentTier('researcher', 'web_search', 'off');
  const t1 = last();
  eq('改档有反馈：说清「从下一步开始」，没有在跑的步骤时不加那句', [store.get().toasts.length, t1.body?.includes('从下一步开始'), t1.body?.includes('已对它关上'), t1.body?.includes('照旧'), /[！～]/.test(`${t1.title}${t1.body}`)], [1, true, true, false, false]);
  actions.setAgentTier('researcher', 'web_search', 'off');
  eq('同档再点：不重复反馈', store.get().toasts.length, 1);
  actions.setAgentTier('researcher', 'web_search', undefined);
  actions.setAgentTier('orchestrator', 'web_search', 'off');
  eq('被拒绝（编排 Agent）走原来的提示，不说「从下一步开始」', last().body?.includes('从下一步开始'), false);
  // 这个 Agent 正有一步在跑、且这个工具原本是白档：另说一句「这一步里仍会用」
  store.update((d) => {
    d.runs.rr = mkRun('rr', 'tt', { status: 'running', plan: [{ id: 's1', index: 0, title: '查', detail: '', agentId: 'researcher', status: 'running', toolCallIds: [] }] });
  });
  actions.setAgentTier('researcher', 'web_search', 'off');
  const t2 = last();
  eq('该 Agent 正在跑一步、工具原本是白档：说明这一步里照旧，不用「立刻」一类绝对说法', [t2.body?.includes('从下一步开始'), t2.body?.includes('照旧'), /立刻|马上/.test(t2.body ?? '')], [true, true, false]);
  actions.setAgentTier('researcher', 'web_search', undefined);
  actions.setAgentTier('researcher', 'shell', 'off');
  eq('原本就要确认的工具（银档）改黑：这一步里本来就会问，不加那句', last().body?.includes('照旧'), false);

  // lifeNudge 垫片：只有 on 才写 true
  store.init(emptyState(0));
  for (const [v, want] of [['on', true], ['auto', false], ['off', false]] as const) { actions.setProactive(v); eq(`setProactive(${v}) → lifeNudge=${want}`, store.get().settings.lifeNudge, want); }
  actions.setProactive('on'); actions.setProactive('auto');
  eq('选回默认「自动」不会留下 lifeNudge=true', store.get().settings.lifeNudge, false);

  // 折叠她的主动话 = 一次「关闭」
  freshGate();
  store.init(mkState([mkTask('c', { kind: 'chat', messages: [mkMsg('n1', 'agent', T0, { proactive: true })] }), mkTask('plain', { kind: 'chat', messages: [mkMsg('a', 'agent', T0)] })]));
  actions.toggleFold('plain'); actions.toggleFold('plain'); actions.toggleFold('plain');
  eq('折叠没有主动话的任务：不记关闭', voiceGate('reply', 'q', gsnap({ level: 'l' }), Date.now()).level, 'l');
  actions.toggleFold('c'); actions.toggleFold('c');
  eq('展开不记：折一次又展开，不降档', voiceGate('reply', 'q', gsnap({ level: 'l' }), Date.now()).level, 'l');
  actions.toggleFold('c');
  eq('3 秒内第二次折叠 = 连关两次：本会话降一档', voiceGate('reply', 'q', gsnap({ level: 'l' }), Date.now()).level, 'm');
}

section('回归 G9-⑤：被忽略的整条链（定时器 → 累加 → 反应清零 → chip）');
{
  setProactiveEnvForTest({ visible: () => true, focused: () => true });
  setComposingForTest(false);
  const speak = (d: number, patch: (s: AppState) => void = () => {}) => { store.init(chatWith(quietMsgs(), patch)); feedInputs(d, 130); return fireRest(d); };
  // 1. 连续三天她开口、用户一直在用、从不点按钮：每次 5 分钟后的定时器都累加，第 4 次降成 chip
  freshGate();
  for (let n = 0; n < 3; n++) {
    const d = at(14, 0, n);
    eq(`第 ${n + 1} 次：她照常开口`, speak(d), 'her');
    recordInput(d + 5 * MIN);                                                   // 5 分钟后用户还在操作
    settleRestIgnored(d + 5 * MIN + 1000);
    eq(`第 ${n + 1} 次 5 分钟后定时器到点：被忽略计数 +1`, gateStats(d + 6 * MIN).ignoredStreak, n + 1);
  }
  eq('连续 3 次被忽略后：不再进对话流，降成 chip', [speak(at(14, 0, 3)), restChip.get()?.kind, countMsgs()], ['chip', 'rest', 2]);
  restChip.set(undefined);
  // 2. 点退出项（好，知道了 = noteDismiss later）：有反应，不算被忽略
  freshGate(); speak(T0);
  noteDismiss('nudge.rest', 'later', T0 + MIN); recordInput(T0 + 5 * MIN); settleRestIgnored(T0 + 5 * MIN + 1000);
  eq('点了退出项：不算被忽略', gateStats(T0 + 6 * MIN).ignoredStreak, 0);
  // 3. 用户在对话里发了话：有反应
  freshGate(); speak(T0);
  store.update((d) => { d.tasks.c.messages.push(mkMsg('u9', 'user', T0 + 2 * MIN, { text: '在忙。' })); });
  recordInput(T0 + 5 * MIN); settleRestIgnored(T0 + 5 * MIN + 1000);
  eq('在对话里回了话：不算被忽略', gateStats(T0 + 6 * MIN).ignoredStreak, 0);
  // 3b. 同上，但是 onChange 里的 reconcileResponses 当场就清
  freshGate(); speak(T0);
  store.update((d) => { d.tasks.c.messages.push(mkMsg('u9', 'user', T0 + 2 * MIN, { text: '在忙。' })); });
  reconcileResponses(T0 + 3 * MIN); recordInput(T0 + 5 * MIN); settleRestIgnored(T0 + 5 * MIN + 1000);
  eq('reconcileResponses 一并清掉等待反应', gateStats(T0 + 6 * MIN).ignoredStreak, 0);
  // 4. 5 分钟后用户已经停下：不算
  freshGate(); speak(T0);
  settleRestIgnored(T0 + 5 * MIN + 1000);
  eq('5 分钟后用户早已没有输入：不算', gateStats(T0 + 6 * MIN).ignoredStreak, 0);
  // 5. 点「去歇一会儿」：清零（acceptRest 是 Conversation.onPill 对 accepts 胶囊要调的）
  freshGate(); speak(T0); recordInput(T0 + 5 * MIN); settleRestIgnored(T0 + 5 * MIN + 1000);
  actions.acceptRest();
  eq('acceptRest：被忽略计数清零', gateStats(T0 + 6 * MIN).ignoredStreak, 0);

  // 6. 她一开口就排好 5 分钟的定时器；停掉时一并清掉
  type Timer = { id: number; ms: number; live: boolean };
  const timers: Timer[] = [];
  const g = globalThis as unknown as { window?: unknown };
  const had = 'window' in g; const prev = g.window;
  g.window = {
    setTimeout: (_fn: () => void, ms: number) => { const t = { id: timers.length + 1, ms, live: true }; timers.push(t); return t.id; },
    clearTimeout: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
  };
  try {
    freshGate(); resetProactiveSchedForTest();
    eq('休息关照开口 → 排一个 REST_IGNORE_MS 之后的一次性定时器', [speak(T0), timers.filter((t) => t.live).map((t) => t.ms)], ['her', [REST_IGNORE_MS + 1000]]);
    resetProactiveSchedForTest();
    eq('停掉调度时定时器一并清掉', timers.some((t) => t.live), false);
    freshGate(); timers.length = 0;
    eq('降成系统行 / toast 也排', [speak(T0, (s) => { s.settings.proactive = 'off'; }), speak(T0 + 3 * HOUR, (s) => { s.view = 'queue'; }), timers.filter((t) => t.live).length], ['line', 'toast', 1]);
  } finally {
    resetProactiveSchedForTest();
    if (had) g.window = prev; else delete g.window;
    setProactiveEnvForTest();
  }
}

section('回归 proactive：回应清「未回应」/ 真实静默时长 / 条件解除后的缓冲 / persona 关与安静时的休息关照');
{
  setProactiveEnvForTest({ visible: () => true, focused: () => true });
  setComposingForTest(false); clearDraft('c');
  // 回应 → 清掉「上一次主动没得到回应」，会话上限才可能到
  freshGate(); store.init(chatWith(quietMsgs()));
  const id1 = fireNudge(T0);
  reconcileResponses(T0 + MIN);
  eq('她开口后用户还没说话：仍是未回应', [typeof id1, gateStats(T0 + MIN, 'c').unanswered], ['string', true]);
  store.update((d) => { d.tasks.c.messages.push(mkMsg('u2', 'user', T0 + 2 * MIN, { text: '嗯' })); });
  reconcileResponses(T0 + 3 * MIN);
  eq('用户在对话里说了话（输入框 / 胶囊都一样）：清掉未回应', gateStats(T0 + 3 * MIN, 'c').unanswered, false);
  eq('于是下一次可以开口，本会话计数 2', [typeof fireNudge(T0 + 30 * MIN), gateStats(T0 + 30 * MIN, 'c').session], ['string', 2]);
  store.update((d) => { d.tasks.c.messages.push(mkMsg('u3', 'user', T0 + 40 * MIN, { text: '嗯嗯' })); });
  reconcileResponses(T0 + 41 * MIN);
  eq('NUDGE_SESSION_CAP 在产品里可达：第 3 次被 session-cap 拦住', [fireNudge(T0 + 60 * MIN), gateStats(T0 + 60 * MIN, 'c').session, canNudge(buildNudgeSnap(store.get(), T0 + 60 * MIN), T0 + 60 * MIN).why], [undefined, NUDGE_SESSION_CAP, 'session-cap']);
  // 模型想话题：先记账再异步回话——此时用户的旧消息不能把「未回应」清掉
  freshGate(); store.init(chatWith(quietMsgs(), (s) => { s.settings.proactiveTopics = true; }));
  fireNudge(T0); reconcileResponses(T0 + 1000);
  eq('proactiveTopics：她还没回话时，用户更早的消息不清「未回应」', gateStats(T0 + 1000, 'c').unanswered, true);

  // 系统行的静默分钟数是真的
  freshGate(); store.init(chatWith([mkMsg('u1', 'user', T0 - 200 * MIN), mkMsg('a1', 'agent', T0 - 180 * MIN)]));
  fireNudge(T0);
  eq('静默 3 小时之后开口：系统行写 180，不是常量 8', tail().src?.slots?.silent, 180);

  // 条件由否变是：到期点已过也给缓冲，不当场开口
  eq('nextNudgeAt：到期点已过 → 现在（纯计算，默认不加缓冲）', nextNudgeAt(T0 - 20 * MIN, T0), T0);
  eq('nextNudgeAt：带缓冲 → 现在 + 缓冲；到期点还没到则不动', [nextNudgeAt(T0 - 20 * MIN, T0, NUDGE_GRACE_MS), nextNudgeAt(T0 - 2 * MIN, T0, NUDGE_GRACE_MS)], [T0 + NUDGE_GRACE_MS, T0 + 6 * MIN]);
  eq('缓冲不会把时刻推过 22:00：22:00 前 10 秒到期 + 缓冲 → 今晚不排', nextNudgeAt(at(21, 59) + 50_000 - NUDGE_QUIET_MS - 5000, at(21, 59) + 50_000, NUDGE_GRACE_MS), undefined);

  type Timer = { id: number; ms: number; live: boolean };
  const timers: Timer[] = [];
  const g = globalThis as unknown as { window?: unknown };
  const had = 'window' in g; const prev = g.window;
  g.window = {
    setTimeout: (_fn: () => void, ms: number) => { const t = { id: timers.length + 1, ms, live: true }; timers.push(t); return t.id; },
    clearTimeout: (id: number) => { const t = timers.find((x) => x.id === id); if (t) t.live = false; },
  };
  const live = () => timers.filter((t) => t.live).map((t) => t.ms).sort((a, b) => a - b);
  try {
    resetProactiveSchedForTest(); freshGate(); clearDraft('c'); resetPresenceForTest(T0);
    store.init(chatWith(quietMsgs()));                                                       // 最后一条是 20 分钟前，到期点早过了
    reschedule(T0);
    eq('到期点已过：排 NUDGE_GRACE_MS 之后，不是 0（回到窗口 / 清草稿那一刻不当场开口）', live().filter((x) => x < 100 * MIN), [NUDGE_GRACE_MS]);
    setDraft('c', '写了半截');
    reschedule(T0);
    clearDraft('c');
    reschedule(T0);
    eq('清掉半截草稿：条件由否变是，同样给缓冲', live().filter((x) => x < 100 * MIN), [NUDGE_GRACE_MS]);

    // persona 关：休息关照照排；到点出系统行
    resetProactiveSchedForTest();
    store.init(chatWith(quietMsgs(), (s) => { s.settings.persona = false; }));
    reschedule(T0);
    eq('角色口吻关：休息关照仍排（搭话不排）', live(), [120 * MIN]);
    freshGate(); store.init(chatWith(quietMsgs(), (s) => { s.settings.persona = false; })); feedInputs(T0, 130);
    eq('角色口吻关：到点只出系统行（G2）', [fireRest(T0), tail().role], ['line', 'system']);

    // 安静一小时 + 没有闲聊页：不弹 toast，推迟到安静结束之后
    resetProactiveSchedForTest(); freshGate(); resetPresenceForTest(T0);
    store.init(chatWith(quietMsgs(), (s) => { s.view = 'queue'; s.quietUntil = T0 + 3 * HOUR; }));
    reschedule(T0);
    eq('安静中且没有闲聊页：休息关照推迟到安静结束之后（比原定的 120 分钟还晚时）', live(), [3 * HOUR + 1000]);
  } finally {
    resetProactiveSchedForTest();
    if (had) g.window = prev; else delete g.window;
    setProactiveEnvForTest();
  }
  setProactiveEnvForTest({ visible: () => true, focused: () => true });
  freshGate(); store.init(chatWith(quietMsgs(), (s) => { s.view = 'queue'; s.quietUntil = T0 + HOUR; })); feedInputs(T0, 130);
  eq('安静中、没有闲聊页、却到点了：不弹 toast、不记账', [fireRest(T0), store.get().toasts.some((x) => x.key === 'rest')], [undefined, false]);
  store.update((d) => { d.quietUntil = 0; });
  eq('安静解除后还能说（没有被白白消耗当晚额度）', fireRest(T0 + MIN), 'toast');
  setProactiveEnvForTest();
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(`${failed} failed`); process.exit(1); }
