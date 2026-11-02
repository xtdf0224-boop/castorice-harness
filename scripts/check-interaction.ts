/* 模块检查（interaction）：npm run check:interaction。无 GUI、无网络。
   覆盖：输入法守卫（IME-1…5 的纯逻辑部分）、say() 黄金输出与文案 lint、种子轮换、deriveQueue 性质测试（1,000 个随机状态）、
   deriveBrief 用例、命令注册表（无冲突、无保留键、批准无全局键）、动作与默认值. */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import linesJson from '../src/lib/voice-lines.json';

import { commands, bindingLabel, findConflicts, isCharBinding, isReservedBinding, matchesBinding, parseBinding, registerCommand, resolveCommand } from '../src/lib/commands';
import { guardEnter, guardEscape, isComposingEvent, isEditableTarget, lineInputKeys, type KeyLike } from '../src/lib/ime';
import { ARM_GUARD_MS, ARM_TIMEOUT_MS, createTwoStep } from '../src/lib/twoStep';
import { PERSONA, eventLine, systemPrompt, type PromptPurpose } from '../src/lib/persona';
import { HIGH_FREQUENCY_3, HIGH_FREQUENCY_4, HIGH_FREQUENCY_SCENES, SCENE_NAMES, hasScene, cnCount, cnNum, pickIndex, say, say2, spanCn, spanNum, voiceSeed, voiceVariants, waitText, type VoiceFacts } from '../src/lib/voice';
import type { AppState, Approval, Distance, Level, Message, Question, QueueItem, Run, RunStatus, Task } from '../src/lib/types';
import { modeInfo, modeNote, modeSupport, PERMISSION_MODES } from '../src/components/views/tasks/permission';
import { actions } from '../src/state/actions';
import { awayWindow, deriveBrief, detectAway } from '../src/state/brief';
import { QUEUE_RANK, badgeSpec, deriveQueue, queueNavModel, queueReady, queueSummary, sameQueue } from '../src/state/queue';
import { quotaCell, thisRunUsage } from '../src/state/selectors';
import { DEFAULT_SETTINGS, emptyState, syncPersonaAgent } from '../src/state/seed';
import { store } from '../src/state/store';

const RAW_LINES = linesJson as unknown as Array<{ id: string; text: string }>;

let failed = 0;
let passed = 0;
export function eq(name: string, got: unknown, want: unknown) {
  if (!isDeepStrictEqual(got, want)) {
    failed += 1;
    console.error(`  FAIL ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
  } else { passed += 1; if (!process.env.QUIET) console.log(`  ok  ${name}`); }
}
const ok = (name: string, cond: boolean, extra = '') => eq(name + (cond || !extra ? '' : ` (${extra})`), cond, true);
const section = (t: string) => console.log(`\n${t}`);

/* ═════════════ 输入法守卫 ═════════════ */
section('IME 守卫');
{
  const press = (o: Partial<KeyLike>): KeyLike & { calls: string[] } => {
    const calls: string[] = [];
    return { ...o, calls, preventDefault: () => calls.push('prevent'), stopPropagation: () => calls.push('stop') };
  };
  ok('isComposing 为真 = 组合态', isComposingEvent({ key: 'Enter', isComposing: true }));
  ok('keyCode 229 = 组合态（compositionend 先于 keydown 时 isComposing 已是 false）', isComposingEvent({ key: 'Enter', isComposing: false, keyCode: 229 }));
  ok('React 的 nativeEvent.isComposing = 组合态', isComposingEvent({ key: 'Enter', nativeEvent: { isComposing: true } }));
  ok('key === Process = 组合态', isComposingEvent({ key: 'Process' }));
  ok('普通回车不是组合态', !isComposingEvent({ key: 'Enter', keyCode: 13, isComposing: false }));

  let n = 0;
  const submit = () => { n += 1; };
  const composing = press({ key: 'Enter', isComposing: true });
  eq('IME-3 组合态回车不提交（称呼、模型 ID、搜索框）', [guardEnter(composing, submit), n], [false, 0]);
  eq('组合态回车也不 preventDefault（让输入法选字）', composing.calls, []);
  const k229 = press({ key: 'Enter', keyCode: 229 });
  eq('keyCode 229 的回车不提交', [guardEnter(k229, submit), n], [false, 0]);
  const plain = press({ key: 'Enter', keyCode: 13 });
  eq('IME-2 选字后再按回车：恰好提交一次', [guardEnter(plain, submit), n, plain.calls], [true, 1, ['prevent']]);
  eq('Shift+Enter 不提交（换行）', [guardEnter(press({ key: 'Enter', shiftKey: true }), submit), n], [false, 1]);
  eq('Ctrl+Enter 默认不提交，allowModified 时提交', [guardEnter(press({ key: 'Enter', ctrlKey: true }), submit), guardEnter(press({ key: 'Enter', ctrlKey: true }), submit, { allowModified: true }), n], [false, true, 2]);
  eq('不是 Enter 就什么也不做', guardEnter(press({ key: 'a' }), submit), false);

  let cancelled = 0;
  const cancel = () => { cancelled += 1; };
  const escComposing = press({ key: 'Escape', isComposing: true });
  eq('IME-4 组合态 Esc 只取消组合：不执行取消、不 preventDefault，但拦住外层', [guardEscape(escComposing, cancel), cancelled, escComposing.calls], [false, 0, ['stop']]);
  const escPlain = press({ key: 'Escape' });
  eq('非组合态 Esc 执行取消并拦住外层', [guardEscape(escPlain, cancel), cancelled, escPlain.calls], [true, 1, ['prevent', 'stop']]);

  let enters = 0, escs = 0;
  const handler = lineInputKeys<KeyLike>({ onEnter: () => { enters += 1; }, onEscape: () => { escs += 1; } });
  handler({ key: 'Enter', isComposing: true }); handler({ key: 'Escape', isComposing: true });
  eq('lineInputKeys：组合态两者都不触发', [enters, escs], [0, 0]);
  handler({ key: 'Enter' }); handler({ key: 'Escape' });
  eq('lineInputKeys：非组合态各触发一次', [enters, escs], [1, 1]);

  ok('textarea 是可编辑目标', isEditableTarget({ tagName: 'TEXTAREA' }));
  ok('文本 input 是可编辑目标', isEditableTarget({ tagName: 'INPUT', type: 'text' }));
  ok('checkbox 不是可编辑目标', !isEditableTarget({ tagName: 'INPUT', type: 'checkbox' }));
  ok('contenteditable 是可编辑目标', isEditableTarget({ tagName: 'DIV', isContentEditable: true }));
  ok('按钮不是可编辑目标', !isEditableTarget({ tagName: 'BUTTON' }));
  ok('combobox 里的搜索框是可编辑目标', isEditableTarget({ tagName: 'DIV', closest: (sel: string) => (sel.includes('combobox') ? {} : null) }));
}

/* ═════════════ 声线 ═════════════ */
/* 声线的全部规则在 scripts/check-voice.ts（npm run check:voice）：ID 文法、条件台词、话量配额、提示词全组合、危机词表…
   这里留的是「交互」层面的回归：say() 旧签名与旧 27 个场景的黄金输出、别的模块在用的场景名、高频格与轮换、渲染后文案的底线 lint、
   persona 提示词的几条关键断言，以及界面源码里不再出现的词. */
section('say()：基本行为');
const SEED = voiceSeed(new Date(2026, 9, 24), 'zzz-edit', 0);
eq('种子格式', SEED, '2026-10-24|zzz-edit|0');
eq('未知场景返回空串', say('no.such.scene'), '');
eq('同一输入同一输出', say('run.done', { title: 'A' }, { seed: SEED }), say('run.done', { title: 'A' }, { seed: SEED }));
ok('距离 0 不称呼、不用省略号', !/阁下|……/.test(say('return.brief', { away: 41, done: 1, waiting: 2 }, { distance: 0 })));
ok('默认称呼是阁下', voiceVariants('queue.empty', {}, { level: 'm' }).some((t) => t.includes('阁下')));
ok('称呼可改', voiceVariants('return.quiet', {}, { level: 'm', callName: '小夏' }).every((t) => !t.includes('阁下')) && voiceVariants('return.quiet', {}, { level: 'm', callName: '小夏' }).some((t) => t.includes('小夏')));
ok('称呼为空沿用阁下', voiceVariants('return.quiet', {}, { level: 'm', callName: '  ' }).some((t) => t.includes('阁下')));
ok('say2 返回 {text, expr, src}：src 记出处', (() => { const r = say2('run.done', { title: 'A' }, { level: 'm', seed: SEED }); return !!r.text && r.src?.scene === 'done.w' && typeof r.src.idx === 'number'; })());
ok('旧签名 distance 1 / 2 = 中 / 多，0 = persona 关', say('run.done', { title: 'A' }, { distance: 1, seed: SEED }) === say2('done.w', { title: 'A' }, { level: 'm', seed: SEED }).text
  && say('run.done', { title: 'A' }, { distance: 2, seed: SEED }) === say2('done.w', { title: 'A' }, { level: 'l', seed: SEED }).text
  && say('run.done', { title: 'A' }, { distance: 0 }) === '已完成：A。');

section('中文数字与时长');
eq('cnNum', [0, 1, 10, 11, 20, 41, 99, 100].map(cnNum), ['零', '一', '十', '十一', '二十', '四十一', '九十九', '100']);
eq('cnCount 2 读两', [1, 2, 12, 22].map(cnCount), ['一', '两', '十二', '二十二']);
eq('spanCn', [0, 1, 2, 41, 60, 75, 125, 130, 1440, 1620, 3000].map(spanCn), ['不到一分钟', '一分钟', '两分钟', '四十一分钟', '一小时', '一小时十五分钟', '两小时零五分钟', '两小时十分钟', '一天', '一天三小时', '两天两小时']);
eq('spanNum', [0, 41, 60, 75, 1440, 3000].map(spanNum), ['不到 1 分钟', '41 分钟', '1 时', '1 时 15 分', '1 天', '2 天 2 时']);
eq('waitText', [0, 59_000, 60_000, 69 * 60_000, 75 * 60_000, 2 * 86_400_000].map(waitText), ['不到 1 分', '不到 1 分', '1 分', '1 时 9 分', '1 时 15 分', '2 天']);

section('say()：黄金输出（种子 2026-10-24|zzz-edit|0）');
{
  const g = (scene: string, slots: Record<string, string | number>, distance: Distance) => say(scene, slots, { distance, seed: SEED });
  const brief = { away: 41, done: 1, replies: 1, failed: 0, waiting: 2 };
  const GOLDEN: Array<[string, string, Record<string, string | number>, Distance, string]> = [
    ['return.brief d0', 'return.brief', brief, 0, '离开 41 分钟：完成 1，回复 1，待你 2。'],
    ['return.brief d1', 'return.brief', brief, 1, '这四十一分钟里，做完了一项，收到了一条回复，还有两件事在等阁下定夺……细节都在下面，慢慢看就好。'],
    ['return.brief d2', 'return.brief', brief, 2, '回来了，阁下。这四十一分钟里，做完了一项，收到了一条回复，还有两件事在等阁下定夺……细节都在下面，哪件先看，自己定，我不催。'],
    ['return.quiet d0', 'return.quiet', {}, 0, '待你：0。'],
    ['return.quiet d1', 'return.quiet', {}, 1, '都安顿好了，暂时没有要阁下定夺的事。想聊聊，或者开始新的，都可以。'],
    ['queue.empty d1', 'queue.empty', {}, 1, '这一栏是空的……暂时没有要阁下定夺的事。'],
    ['greet.first d1', 'greet.first', {}, 1, '初次见面，我是遐蝶。说话可能慢一点，但会认真听……想被怎么称呼，说一声就好。'],
    ['plan.ready d0', 'plan.ready', { steps: 3 }, 0, '计划已生成：3 步，待批准。'],
    ['plan.ready d1', 'plan.ready', { steps: 3 }, 1, '计划列好了……有想改的地方，直接告诉我。'],
    ['plan.approved d1', 'plan.approved', {}, 1, '明白了……这一件开始做了。'],
    ['run.done d0', 'run.done', { title: 'GODS v3' }, 0, '已完成：GODS v3。'],
    ['run.done d1', 'run.done', { title: 'GODS v3' }, 1, '「GODS v3」做好了。哪里想改，直接告诉我。'],
    ['run.failed d0', 'run.failed', { title: '调研' }, 0, '未完成：调研。原因见下，已完成部分已保留。'],
    ['run.failed d1', 'run.failed', { title: '调研', step: 3 }, 1, '啊，「调研」停下了。原因在下面，想再试，可以从这里接着来。'],
    ['run.cancelled d1', 'run.cancelled', { title: '调研' }, 1, '好的，已经停下了。做到的部分都留着，想接着做，从这里开始就行。'],
    ['question.ask d1', 'question.ask', {}, 1, '我拿不准该往哪边走……选项在下面，阁下挑一个，我再接着做。'],
    ['approval.wait d0', 'approval.wait', { title: '删除 4 个旧版成片母带' }, 0, '待批准：删除 4 个旧版成片母带。'],
    ['approval.wait d1', 'approval.wait', { title: '删除 4 个旧版成片母带' }, 1, '停一下，先请阁下过目：删除 4 个旧版成片母带。放行或拒绝，都可以。'],
    ['chat.error d1', 'chat.error', {}, 1, '抱歉，这次没能回上话……阁下的话还在，原因写在下面，再发一次就好。'],
    ['composer.placeholder d0', 'composer.placeholder', {}, 0, '输入任务，Enter 发送，Shift+Enter 换行。'],
    ['composer.placeholder d1', 'composer.placeholder', {}, 1, '今天先做哪一件？写在这里就好……'],
    ['composer.placeholder.chat d1', 'composer.placeholder.chat', {}, 1, '想说什么，慢慢写……'],
    ['trust.ask d1', 'trust.ask', {}, 1, '这是阁下自己的目录吗……不确定的话，我先只读，不写。'],
    ['notify.approval d1', 'notify.approval', { title: '删除 4 个旧版成片母带' }, 1, '打扰一下……删除 4 个旧版成片母带需要阁下过目，我停着没动。'],
    ['distance.set d2', 'distance.set', {}, 2, '好呀，那我多说一点……吵了就告诉我，随时收一收。'],
  ];
  const GOLD: Record<string, string> = JSON.parse(process.env.GOLDEN_JSON ?? '{}');
  if (process.env.PRINT_GOLDEN) {
    for (const [name, scene, slots, d] of GOLDEN) console.log(JSON.stringify([name, g(scene, slots, d)]));
  }
  for (const [name, scene, slots, d, want] of GOLDEN) eq(`黄金：${name}`, g(scene, slots, d), GOLD[name] ?? want);
}

section('say()：别的模块在用的场景名');
{
  const seed = voiceSeed(new Date(2026, 9, 24), 'p', 0);
  eq('B5 用连字符写法的信任场景指向同一份台词', ['trust-ask', 'trust-suspect', 'trust-broad'].map((a) => say(a, { dir: 'x' }, { seed })), ['trust.ask', 'trust.suspect', 'trust.broad'].map((a) => say(a, { dir: 'x' }, { seed })));
  ok('B3 用的 question.await 与 quota.warn 有台词', hasScene('question.await') && hasScene('quota.warn') && say('question.await', { count: 2 }, { seed }).includes('2'));
  eq('quota.warn 缺槽位时不留空洞', say('quota.warn', { label: '5 小时额度', percent: '', reset: '' }, { level: 'm', seed }).includes('undefined'), false);
  eq('quota.warn 距离 0', say('quota.warn', { label: '5 小时额度', percent: 83, reset: '10月24日 03:00' }, { distance: 0 }), '5 小时额度 约 83%，10月24日 03:00 重置。');
  eq('trust.broad 没有目录名时写「这个目录」（纯事实版）', say('trust.broad', {}, { distance: 0 }).includes('这个目录'), true);
  ok('interrupt 别名指向 stop.w', say('interrupt', { step: 2 }, { level: 'm', seed }) === say2('stop.w', { step: 2 }, { level: 'm', seed }).text);
}

section('say()：高频格、变体数与轮换');
{
  const FULL: VoiceFacts = { pending: 0, failed: 0, hasList: true, saved: true, retries: 1, steps: 4, activeMs: 200_000, hours: 3, honor: 'enf' };
  const slots = { title: '整理目录', steps: 3, away: 41, done: 1, waiting: 1, step: 2, reason: '网络超时', who: '检索', doing: '搜集资料', model: 'sonnet', what: '写入 README.md' };
  // 条件行在不同事实下进池，取几种常见事实里最大的那个池（精确的「每池条数」在 check-voice 里按行数）
  const FACTS_SET: VoiceFacts[] = [FULL, { ...FULL, retries: 0, activeMs: 60_000 }, { pending: 0, failed: 0, steps: 1, activeMs: 20_000 }];
  const pool = (scene: string, level: Level) => Math.max(...(['chat', 'work'] as const).flatMap((mode) => FACTS_SET.map((facts) => voiceVariants(scene, slots, { level, mode, facts }).length)));
  for (const scene of HIGH_FREQUENCY_4) for (const level of ['s', 'm', 'l'] as Level[]) ok(`高频场景 ${scene} ${level} 档池 ≥4 条`, pool(scene, level) >= 4, String(pool(scene, level)));
  for (const scene of HIGH_FREQUENCY_3) for (const level of ['s', 'm', 'l'] as Level[]) ok(`第二批高频场景 ${scene} ${level} 档池 ≥3 条`, pool(scene, level) >= 3, String(pool(scene, level)));
  for (const scene of SCENE_NAMES) ok(`场景 ${scene} 至少有一档能说话`, (['s', 'm', 'l'] as Level[]).some((lv) => pool(scene, lv) >= 1));
  ok('要求的场景全部存在', ['return.brief', 'return.quiet', 'greet.first', 'plan.ready', 'plan.approved', 'run.done', 'run.failed', 'run.cancelled', 'question.ask', 'approval.wait', 'chat.error', 'queue.empty', 'composer.placeholder', 'trust.ask'].every((s) => hasScene(s)));
  for (const scene of HIGH_FREQUENCY_SCENES) {
    for (const level of ['m', 'l'] as Level[]) {
      for (const mode of ['chat', 'work'] as const) {
        const n = voiceVariants(scene, slots, { level, mode }).length;
        if (n < 2) continue;
        const base = Date.UTC(2026, 9, 1);
        const lines: string[] = [];
        for (let day = 0; day < n; day++) lines.push(say2(scene, slots, { level, mode, seed: voiceSeed(base + day * 86_400_000 + 12 * 3_600_000, 'proj', 0) }).text);
        ok(`${scene} ${level}/${mode}：连续 ${n} 天不重复`, new Set(lines).size === n, `${new Set(lines).size}/${n}`);
        const same: string[] = [];
        for (let i = 0; i < n; i++) same.push(say2(scene, slots, { level, mode, seed: voiceSeed(base, 'proj', i) }).text);
        ok(`${scene} ${level}/${mode}：同一天连续 ${n} 次不重复`, new Set(same).size === n);
      }
    }
  }
  eq('pickIndex 在 0..n-1 之内且确定', [pickIndex('a', 9, '2026-10-24|p|0') === pickIndex('a', 9, '2026-10-24|p|0'), pickIndex('a', 9, '2026-10-24|p|0') < 9], [true, true]);
  eq('不是日期格式的种子也确定', pickIndex('a', 9, 'abc'), pickIndex('a', 9, 'abc'));
  eq('没有种子取第一个', pickIndex('a', 9, ''), 0);
  const days = [0, 1, 2, 3, 4, 5].map((d) => pickIndex('return.brief', 9, voiceSeed(Date.UTC(2026, 9, 10 + d, 12), 'p', 0)));
  ok('相邻两天的下标一定不同', days.every((v, i) => i === 0 || v !== days[i - 1]));
}

section('文案 lint（N05 → §3.10 的渲染后版本）');
{
  const FORBIDDEN = ['收割', '处决', '秒杀', 'kill', '暴毙', '杀死', '凉了', '尸体', '血', '自杀', '安乐死'];
  const NICK = ['阿蝶', '蝶宝', '小蝶'];
  const CLINGY = /别走|不要走|再(待|聊一|陪)|这么快就走|这就走|还会回来|想你|想念|等你|等着你|惦记|舍不得|离不开|只有你|没有你|少了你|冷落|抛下|丢下我|辜负|让我失望|我难过|好久不见|你终于|去哪了|不理我|孤单|陪我|等了你/;
  const BUTTON_METAPHOR = ['献上', '安息', '送它安息'];
  const MISNAMED = ['安提拉', '永恒一页', '蝶影翩跹', '缇宁老师', '玻吕刻斯是妹妹'];
  const ONLY_INTERNAL = ['衣冠冢', '讣告', '冰雕'];
  const WISH_OK = ['done.', 'greet.', 'leave.', 'late.', 'boot.', 'return.', 'queue.empty', 'level.set', 'nudge.', 'chat.', 'world.', 'composer.'];
  const slots = { title: '整理目录', steps: 3, away: 41, done: 1, replies: 1, failed: 1, waiting: 2, step: 2, count: 3, dir: 'G:\\x', what: '写入 README.md', reason: '网络超时', minutes: 7, clock: '00:40', hours: 2, who: '检索', doing: '搜集资料', model: 'sonnet', label: '5 小时额度', percent: 83, reset: '03:00', total: 9, max: 3 };
  const FULL: VoiceFacts = { pending: 0, failed: 0, hasList: true, saved: true, retries: 1, steps: 4, activeMs: 200_000, hours: 3, honor: 'enf' };
  let total = 0, wish = 0;
  const problems: string[] = [];
  for (const scene of SCENE_NAMES) {
    for (const persona of [true, false]) {
      for (const level of ['s', 'm', 'l'] as Level[]) {
        for (const callName of ['阁下', '小夏']) {
          for (const mode of ['chat', 'work'] as const) {
            for (const [i, text] of voiceVariants(scene, slots, { level, mode, persona, callName, facts: FULL }).entries()) {
              const at = `${scene} ${persona ? level : '纯事实'}/${mode}#${i}「${text}」`;
              const bad = (why: string) => problems.push(`${at} ${why}`);
              if (!text) bad('空');
              if (/[!！]/.test(text)) bad('感叹号');
              if (/[{}]|undefined|NaN|null/.test(text)) bad('槽位没填');
              for (const w of FORBIDDEN) if (text.includes(w)) bad(`禁用词 ${w}`);
              for (const w of NICK) if (text.includes(w)) bad(`昵称 ${w}`);
              for (const w of BUTTON_METAPHOR) if (text.includes(w)) bad(`隐喻 ${w}`);
              for (const w of MISNAMED) if (text.includes(w)) bad(`名称错误 ${w}`);
              for (const w of ONLY_INTERNAL) if (text.includes(w)) bad(`只能出现在内部名 ${w}`);
              if (text.includes('保护')) bad('「保护」措辞');
              if (CLINGY.test(text)) bad(`挽留 / 愧疚 ${text.match(CLINGY)?.[0]}`);
              if (!persona && /阁下|小夏|……|愿(?!意)|遐蝶/.test(text)) bad('persona 关必须是纯事实');
              if ((text.match(/……/g) ?? []).length > 3) bad('省略号超过三处');
              if (/……\s*\d/.test(text)) bad('省略号后面直接是数字');
              if ((text.match(/愿(?!意)/g) ?? []).length > 1) bad('一条里不止一个「愿」');
              if (/愿(?!意)/.test(text) && !WISH_OK.some((p) => scene.startsWith(p))) bad('「愿」只在许可场景用');
              if (persona && callName === '阁下' && level === 'm' && mode === 'work') { total += 1; if (/愿(?!意)/.test(text)) wish += 1; }
              if (persona && /^approve\.(ask|high)$/.test(scene) && !/请|打扰|停一[下停]|点头|亲手|亲自|定夺|过目|看一眼|拿不准|先停/.test(text)) bad('审批类要带请求语气（请 / 打扰一下 / 停一下 …）');
              if (persona && /^fail\.(w|c)$/.test(scene) && !/抱歉|请|没走|没能|停在|停下|没做成|被卡住|不是/.test(text)) bad('失败类要有致歉或平实的「没走通 / 停在」');
            }
          }
        }
      }
    }
  }
  eq('台词表通过 lint（无任何违规）', [...new Set(problems)].slice(0, 12), []);
  ok(`「愿……」占全部台词的比例 ≤10%（${wish}/${total}）`, wish / total <= 0.1);
  ok('功能名里没有把她的称呼写进去', SCENE_NAMES.every((k) => !/阁下/.test(k)));
}

section('persona：只有遐蝶');
{
  const D = new Date(2026, 9, 24, 21, 44);
  const night = (purpose: PromptPurpose, extra: Record<string, unknown> = {}) => systemPrompt(purpose, { mode: 'night', persona: true, callName: '阁下', level: 'm', ...extra }, D);
  ok('夜与昼都是遐蝶', PERSONA.night.name === '遐蝶' && PERSONA.day.name === '遐蝶' && PERSONA.night.glyph === '遐');
  const all = JSON.stringify(PERSONA) + night('chat') + systemPrompt('step', { mode: 'day', persona: true, callName: '阁下', distance: 2, cwd: 'G:/x', cli: true }, D) + eventLine('night', 'plan') + eventLine('day', 'failed');
  ok('萤火时代的流萤、萨姆台词全部删除', !/流萤|萨姆|萤火/.test(all));
  ok('旧写法「措辞正式」「不主动闲聊」「不说自己是 AI」已删', !/措辞正式|不主动闲聊|不说自己是\s?AI/.test(all));
  ok('中档的系统提示是她', night('chat').includes('遐蝶'));
  ok('距离 0 的系统提示没有角色口吻', !systemPrompt('chat', { mode: 'night', persona: true, callName: '阁下', distance: 0 }, D).includes('遐蝶'));
  ok('关掉人设等同距离 0', !systemPrompt('chat', { mode: 'night', persona: false, callName: '阁下', distance: 1 }, D).includes('遐蝶'));
  ok('她的提示里写明「情绪向事不向人」的边界与诚实', night('chat').includes('不可以：因为') && night('chat').includes('【诚实与边界】'));
  ok('eventLine 只说人话（非空、无感叹号）', ['plan', 'done', 'failed', 'rejected', 'cancelled'].every((e) => { const t = eventLine('night', e as 'plan'); return !!t && !/[!！]/.test(t); }));
}

section('界面源码里不再出现「银手套 / 黑档 / 黑色审批卡」（D1）');
{
  const root = resolvePath(process.cwd(), 'src');
  const BAD = /银手套|黑档|黑色审批卡/;
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\"'`])\/\/.*$/gm, '$1');
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = resolvePath(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!/\.(tsx?|json|css)$/.test(e.name)) continue;
      const raw = readFileSync(p, 'utf8');
      const text = /\.(tsx?|css)$/.test(e.name) ? stripComments(raw) : raw;
      if (BAD.test(text)) hits.push(p.slice(root.length + 1));
    }
  };
  walk(root);
  eq('界面源码（去掉注释之后）与台词库里没有这三个词', hits, []);
  ok('台词库与提示词里更没有', !RAW_LINES.some((r) => BAD.test(r.text)) && !BAD.test(systemPrompt('chat', { mode: 'night', persona: true, callName: '阁下', level: 'l' })));
}

/* ═════════════ 待你队列 ═════════════ */
section('deriveQueue：用例');

const NOW = 1_000_000_000;
function mkTask(id: string, patch: Partial<Task> = {}): Task {
  return { id, title: `任务 ${id}`, goal: '', createdAt: 1, updatedAt: 1, agentIds: ['orchestrator'], runIds: [], messages: [], kind: 'work', ...patch };
}
function mkRun(id: string, taskId: string, status: RunStatus, patch: Partial<Run> = {}): Run {
  return {
    id, taskId, attempt: 1, status, createdAt: 10, activeMs: 0, plan: [], planReady: true, toolCalls: [], approvals: [], artifacts: [], errors: [], terminal: [],
    usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, contextUsed: 0, contextLimit: 0, series: [] }, cursor: { phase: 'executing', step: 0 }, ...patch,
  };
}
function mkApproval(id: string, run: Run, status: Approval['status'], createdAt: number): Approval {
  return { id, runId: run.id, taskId: run.taskId, stepId: 's', toolCallId: 'c', agentId: 'coder', tool: 'shell', title: `执行 ${id}`, reason: '', preview: '', previewKind: 'command', risk: 'medium', status, createdAt };
}
function mkQuestion(id: string, run: Run, status: Question['status'], createdAt: number): Question {
  return { id, runId: run.id, taskId: run.taskId, question: `问题 ${id}`, options: [{ label: 'a' }, { label: 'b' }], status, createdAt };
}
function mkState(tasks: Task[], runs: Run[]): AppState {
  const s = emptyState(0);
  for (const t of tasks) { s.tasks[t.id] = t; s.taskOrder.push(t.id); }
  for (const r of runs) { s.runs[r.id] = r; const t = s.tasks[r.taskId]; if (t && !t.runIds.includes(r.id)) t.runIds.push(r.id); }
  return s;
}

{
  const empty = emptyState(0);
  eq('空状态：队列为空', deriveQueue(empty), []);
  ok('空状态：数据就绪（显示 0 而不是「—」）', queueReady(empty));
  ok('没有状态：数据未就绪（显示「—」）', !queueReady(undefined));

  const t1 = mkTask('t1', { lastSeenAt: 100 });
  const r1 = mkRun('r1', 't1', 'awaiting', { endedAt: undefined });
  r1.approvals = [mkApproval('a1', r1, 'pending', 300), mkApproval('a2', r1, 'approved', 100), mkApproval('a3', r1, 'pending', 200)];
  r1.questions = [mkQuestion('q1', r1, 'pending', 250), mkQuestion('q2', r1, 'answered', 50)];
  r1.planApproval = { status: 'pending' };
  const q = deriveQueue(mkState([t1], [r1]));
  eq('待批在前，同类按等待最久排', q.map((i) => i.key), ['approval:a3', 'approval:a1', 'question:q1', 'plan:r1']);
  eq('已批准、已回答的不进队列', q.some((i) => i.refId === 'a2' || i.refId === 'q2'), false);
  eq('计划待批的起点用 run 的开始/创建时间', q.find((i) => i.kind === 'plan')?.since, 10);
  eq('rank 与类别对应', q.map((i) => i.rank), [0, 0, 1, 2]);

  const done = mkRun('r2', 't2', 'completed', { endedAt: 500 });
  const failedRun = mkRun('r3', 't3', 'failed', { endedAt: 400, failure: { stepId: 's', message: '网络中断 ENOTFOUND' } });
  const state2 = mkState([mkTask('t2', { lastSeenAt: 300 }), mkTask('t3', { lastSeenAt: 399 })], [done, failedRun]);
  eq('回合结束与失败进队列，失败在前', deriveQueue(state2).map((i) => i.key), ['failed:r3', 'turn-done:r2']);
  state2.tasks.t2.lastSeenAt = 500; state2.tasks.t3.lastSeenAt = 400;
  eq('打开过任务之后（lastSeenAt 不早于结束时刻）就退场', deriveQueue(state2), []);
  state2.tasks.t2.lastSeenAt = undefined; state2.tasks.t3.lastSeenAt = undefined;
  eq('旧存档没有 lastSeenAt：一律当作已看过，不冒出一长串', deriveQueue(state2), []);

  const reload = mkRun('r4', 't4', 'paused', { pauseReason: 'reload' });
  const s4 = mkState([mkTask('t4', { lastSeenAt: 1, updatedAt: 900 })], [reload]);
  eq('应用重启时在跑的运行：作为「被中断」进失败类', deriveQueue(s4).map((i) => [i.kind, i.title.includes('被中断了')]), [['failed', true]]);
  // 应用被关机 / 更新 / 崩溃杀掉时用户正盯着这个运行：任务页开着，lastSeenAt 一直追着 updatedAt 走。
  // 「被中断」发生在重启读库的那一刻（run.interruptedAt），不是 updatedAt——否则这次中断永远进不了「待你」
  const watched = mkRun('r4b', 't4b', 'paused', { pauseReason: 'reload', interruptedAt: 2000 });
  const s4b = mkState([mkTask('t4b', { lastSeenAt: 1500, updatedAt: 1000 })], [watched]);
  eq('重启中断时用户正盯着它（lastSeenAt 不早于 updatedAt）：仍然进「待你」，起点是重启那一刻', deriveQueue(s4b).map((i) => [i.kind, i.since]), [['failed', 2000]]);
  s4b.tasks.t4b.lastSeenAt = 2500;
  eq('重启之后打开看过了就退场', deriveQueue(s4b), []);
  // 重启时正等着批准计划：只出「计划待批准」一条，不再重复出「被中断了」
  const planPaused = mkRun('r4c', 't4c', 'paused', { pauseReason: 'reload', interruptedAt: 2000, planApproval: { status: 'pending', at: 250 } });
  eq('重启时正等批准的计划：只有「计划待批准」一条', deriveQueue(mkState([mkTask('t4c', { lastSeenAt: 1, updatedAt: 900 })], [planPaused])).map((i) => i.kind), ['plan']);
  eq('计划待批的起点是计划就绪的时刻（pa.at），不是运行开始时间', deriveQueue(mkState([mkTask('t4c', { lastSeenAt: 1 })], [planPaused])).find((i) => i.kind === 'plan')?.since, 250);
  const userPaused = mkRun('r5', 't5', 'paused', { pauseReason: 'user' });
  eq('自己暂停的不进队列', deriveQueue(mkState([mkTask('t5', { lastSeenAt: 1 })], [userPaused])), []);
  eq('自己取消的不进队列', deriveQueue(mkState([mkTask('t6', { lastSeenAt: 1 })], [mkRun('r6', 't6', 'cancelled', { endedAt: 900 })])), []);
  const old = mkRun('r7', 't7', 'failed', { endedAt: 400 });
  const retry = mkRun('r8', 't7', 'running');
  eq('只看每个任务的最新一次运行（重试之后旧的失败退场）', deriveQueue(mkState([mkTask('t7', { lastSeenAt: 1 })], [old, retry])), []);

  const orphan = mkRun('r9', 'ghost', 'awaiting');
  orphan.approvals = [mkApproval('a9', orphan, 'pending', 5)];
  eq('任务已删除，留下的运行记录不算', deriveQueue(mkState([], [orphan])), []);
  const finished = mkRun('r10', 't10', 'failed', { endedAt: 5 });
  finished.approvals = [mkApproval('a10', finished, 'pending', 5)];
  eq('只要还标着 pending 就算（不看运行状态：宁多一条，不能让模型无声地等下去）', deriveQueue(mkState([mkTask('t10', { lastSeenAt: 99 })], [finished])).map((i) => i.key), ['approval:a10']);

  const chat = mkTask('c1', { kind: 'chat', lastSeenAt: 100, messages: [{ id: 'm1', role: 'agent', text: 'hi', at: 200 } as Message] });
  eq('闲聊：新回复算回合结束', deriveQueue(mkState([chat], [])).map((i) => i.key), ['turn-done:c1']);
  chat.messages.push({ id: 'm2', role: 'agent', kind: 'error', text: 'x', at: 300 } as Message);
  eq('闲聊：最后一条是出错的算失败', deriveQueue(mkState([chat], [])).map((i) => i.key), ['failed:c1']);
  chat.messages[1].streaming = true;
  chat.messages[1].kind = 'reply';
  eq('闲聊：还在写的不算', deriveQueue(mkState([chat], [])), []);
}

section('deriveQueue：1,000 个随机状态');
{
  const rng = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const STATUS: RunStatus[] = ['queued', 'running', 'paused', 'awaiting', 'completed', 'failed', 'cancelled'];
  const OPEN = new Set<RunStatus>(['queued', 'running', 'paused', 'awaiting']);
  let sortedBad = 0, dupBad = 0, countBad = 0, orderBad = 0, expectBad = 0, badgeBad = 0, sumBad = 0, nonEmpty = 0, kinds = new Set<string>();
  for (let n = 0; n < 1000; n++) {
    const r = rng(n + 1);
    const int = (m: number) => Math.floor(r() * m);
    const pick = <T,>(xs: T[]) => xs[int(xs.length)];
    const tasks: Task[] = [];
    const runs: Run[] = [];
    const expected = new Set<string>();
    const nTasks = int(7);
    for (let i = 0; i < nTasks; i++) {
      const id = `t${i}`;
      const chat = r() < 0.3;
      const seen = r() < 0.15 ? undefined : int(2000);
      const task = mkTask(id, { kind: chat ? 'chat' : 'work', lastSeenAt: seen, updatedAt: int(2000) });
      tasks.push(task);
      if (chat) {
        const nm = int(4);
        for (let m = 0; m < nm; m++) task.messages.push({ id: `${id}m${m}`, role: pick(['user', 'agent', 'agent']), kind: r() < 0.3 ? 'error' : undefined, streaming: r() < 0.15, text: 'x', at: int(2500) } as Message);
        const last = task.messages[task.messages.length - 1];
        if (seen !== undefined && last && last.role === 'agent' && !last.streaming && seen < last.at) expected.add(`${last.kind === 'error' ? 'failed' : 'turn-done'}:${id}`);
        continue;
      }
      const nRuns = int(4);
      for (let j = 0; j < nRuns; j++) {
        const status = pick(STATUS);
        const run = mkRun(`${id}r${j}`, id, status, { endedAt: OPEN.has(status) ? undefined : int(2500), pauseReason: status === 'paused' ? pick(['user', 'reload'] as const) : undefined, interruptedAt: status === 'paused' && r() < 0.6 ? int(3000) : undefined, createdAt: int(100) });
        for (let a = 0; a < int(3); a++) {
          const ap = mkApproval(`${run.id}a${a}`, run, pick(['pending', 'pending', 'approved', 'rejected', 'expired'] as const), int(3000));
          run.approvals.push(ap);
          if (ap.status === 'pending') expected.add(`approval:${ap.id}`);
        }
        if (r() < 0.5) for (let k = 0; k < int(3); k++) {
          const qu = mkQuestion(`${run.id}q${k}`, run, pick(['pending', 'answered', 'cancelled'] as const), int(3000));
          (run.questions ??= []).push(qu);
          if (qu.status === 'pending') expected.add(`question:${qu.id}`);
        }
        if (r() < 0.3) { run.planApproval = { status: pick(['pending', 'approved'] as const) }; if (run.planApproval.status === 'pending') expected.add(`plan:${run.id}`); }
        runs.push(run); task.runIds.push(run.id);
      }
      const latest = task.runIds.length ? runs.find((x) => x.id === task.runIds[task.runIds.length - 1]) : undefined;
      if (latest && seen !== undefined) {
        const interrupted = latest.status === 'paused' && latest.pauseReason === 'reload';
        // 重启时正等批准计划的运行，「计划待批准」那一条就是该做的事，不再重复出「被中断了」
        const planWaiting = latest.planApproval?.status === 'pending';
        if (latest.status === 'failed' || (interrupted && !planWaiting)) {
          const at = latest.endedAt ?? (interrupted ? latest.interruptedAt ?? task.updatedAt : undefined) ?? latest.startedAt ?? latest.createdAt;
          if (seen < at) expected.add(`failed:${latest.id}`);
        } else if (latest.status === 'completed' && seen < (latest.endedAt ?? latest.createdAt)) expected.add(`turn-done:${latest.id}`);
      }
    }
    // 孤儿运行：任务不存在.
    for (let g = 0; g < int(3); g++) {
      const run = mkRun(`ghost${g}`, 'ghost', pick(STATUS));
      run.approvals = [mkApproval(`ghost${g}a`, run, 'pending', int(100))];
      runs.push(run);
    }
    // 对象里的插入顺序也随机.
    const shuffle = <T,>(xs: T[]) => xs.map((x) => [r(), x] as const).sort((a, b) => a[0] - b[0]).map((p) => p[1]);
    const build = (ts: Task[], rs: Run[]) => { const s = emptyState(0); for (const t of ts) s.tasks[t.id] = t; for (const x of rs) s.runs[x.id] = x; return s; };
    const state = build(shuffle(tasks), shuffle(runs));
    const items = deriveQueue(state);
    const keys = items.map((i) => i.key);
    if (new Set(keys).size !== keys.length) dupBad += 1;
    for (let i = 1; i < items.length; i++) {
      const a = items[i - 1], b = items[i];
      if (!(a.rank < b.rank || (a.rank === b.rank && (a.since < b.since || (a.since === b.since && a.key < b.key))))) { sortedBad += 1; break; }
    }
    for (const it of items) if (it.rank !== QUEUE_RANK[it.kind]) { sortedBad += 1; break; }
    if (!isDeepStrictEqual([...keys].sort(), [...expected].sort())) expectBad += 1;
    const again = deriveQueue(build(shuffle(tasks), shuffle(runs)));
    if (!isDeepStrictEqual(again, items) || !sameQueue(again, items)) orderBad += 1;
    // 三个出口数字相等：左栏、角标、汇总.
    const sum = queueSummary(items, NOW + 5_000_000);
    const badge = badgeSpec(items);
    if (sum.count !== items.length || badge.count !== items.length) countBad += 1;
    if (items.length > 0 && !badge.label.startsWith(`待你 ${items.length} 件`)) badgeBad += 1;
    if (items.length > 0 && badge.text !== (items.length > 9 ? '9+' : String(items.length))) badgeBad += 1;
    if (items.length === 0 && (badge.count !== 0 || badge.text !== '' || badge.label !== '')) badgeBad += 1;
    if (Object.values(sum.byKind).reduce((x, y) => x + y, 0) !== items.length) sumBad += 1;
    const model = queueNavModel(true, items, NOW + 5_000_000);
    if (model.countText !== String(items.length) || model.count !== items.length || (items.length > 0 && !model.label.startsWith(`待你 ${items.length} 件`))) countBad += 1;
    if (items.length) { nonEmpty += 1; for (const it of items) kinds.add(it.kind); }
  }
  eq('1,000 个随机状态：排序稳定（rank → since → key）', sortedBad, 0);
  eq('1,000 个随机状态：无重复条目', dupBad, 0);
  eq('1,000 个随机状态：条目恰好等于按规则独立算出的集合', expectBad, 0);
  eq('1,000 个随机状态：与对象遍历顺序无关（确定性）', orderBad, 0);
  eq('1,000 个随机状态：左栏数 = 角标数 = 队列长度', countBad, 0);
  eq('1,000 个随机状态：角标文字与读屏文案', badgeBad, 0);
  eq('1,000 个随机状态：各类计数之和等于队列长度', sumBad, 0);
  ok(`随机状态确实覆盖了各类条目（${nonEmpty} 个非空，${[...kinds].sort().join('、')}）`, nonEmpty > 300 && kinds.size === 5);
  eq('数据未就绪：左栏写「—」而不是 0', [queueNavModel(false, [], NOW).countText, queueNavModel(false, [], NOW).count], ['—', undefined]);
  eq('队列为空：左栏写 0 与一句话', [queueNavModel(true, [], NOW).countText, queueNavModel(true, [], NOW).label], ['0', '待你：现在没有等着的事']);
  eq('角标：>9 写 9+', badgeSpec(Array.from({ length: 12 }, (_, i) => ({ key: `approval:${i}`, kind: 'approval', taskId: 't', refId: `${i}`, title: '', sub: '', since: i, rank: 0 }) as QueueItem)).text, '9+');
  eq('角标：只有回合结束时不是金色', badgeSpec([{ key: 'turn-done:x', kind: 'turn-done', taskId: 't', refId: 'x', title: '', sub: '', since: 1, rank: 4 }]).tone, 'plain');
  eq('角标：有待批时是金色，读屏文案写全', (() => { const b = badgeSpec([{ key: 'approval:x', kind: 'approval', taskId: 't', refId: 'x', title: '', sub: '', since: 1, rank: 0 }, { key: 'turn-done:y', kind: 'turn-done', taskId: 't', refId: 'y', title: '', sub: '', since: 2, rank: 4 }]); return [b.tone, b.label]; })(), ['gold', '待你 2 件：待批 1、待查看 1']);
  eq('最久：以最早的 since 算', queueSummary([{ key: 'a', kind: 'approval', taskId: 't', refId: 'a', title: '', sub: '', since: 100, rank: 0 }, { key: 'b', kind: 'question', taskId: 't', refId: 'b', title: '', sub: '', since: 400, rank: 1 }], 1000).oldestMs, 900);
}

/* ═════════════ 高风险批准的两步确认 ═════════════ */
section('两步确认（待批卡 / 「待你」里的放行）');
{
  let t = 1000;
  const m = createTwoStep({ now: () => t });
  eq('第一次按：进入第二步', m.press(), 'arm');
  t += 40;
  eq('双击的第二下（40ms 后）不算确认', m.press(), 'ignore');
  t += 100;
  eq('长按 Enter / 触屏连点（仍在 ' + ARM_GUARD_MS + 'ms 之内）不算确认', m.press(), 'ignore');
  t += ARM_GUARD_MS;
  eq('隔了够久的第二次：确认', m.press(), 'confirm');
  eq('确认之后回到第一步', m.press(), 'arm');
  t += ARM_TIMEOUT_MS + 1;
  eq('超时没有第二次点击 → 退回第一步（再按又是第一步，不是确认）', m.press(), 'arm');
  m.reset();
  eq('reset 之后重新开始', m.press(), 'arm');
  const quick = createTwoStep({ now: () => t, guardMs: 0 });
  eq('guardMs 为 0 时第二次立刻确认（只用来证明守卫就是这个数）', [quick.press(), quick.press()], ['arm', 'confirm']);
}

/* ═════════════ 额度条与权限模式 ═════════════ */
section('额度条 L0 与权限模式');
{
  eq('额度：金额两位小数', [quotaCell(0.42, 5), quotaCell(1.9, undefined), quotaCell(0, 9)], ['$0.42', '$1.90', '$0.00']);
  eq('额度：不到一分钱写 <$0.01', quotaCell(0.004, 10), '<$0.01');
  eq('额度：没有费用就写 token 数', [quotaCell(undefined, 950), quotaCell(undefined, 12_300), quotaCell(undefined, 2_400_000)], ['950 tok', '12.3k tok', '2.4M tok']);
  eq('额度：缺数据写「—」，不是 0', [quotaCell(undefined, undefined), quotaCell(undefined, 0), quotaCell(Number.NaN, undefined)], ['—', '—', '—']);
  const st = emptyState(0);
  eq('没有任何运行：本次没有数据', thisRunUsage(st), undefined);
  st.runs.a = mkRun('a', 't', 'completed', { costUsd: 0.5, createdAt: 5 });
  st.runs.b = mkRun('b', 't', 'completed', { createdAt: 9 });
  eq('本次 = 最近创建的运行（没有选中任务时）', thisRunUsage(st), { costUsd: undefined, tokens: 0 });

  eq('权限模式五档，顺序固定', PERMISSION_MODES.map((m) => m.value), ['ask', 'acceptEdits', 'plan', 'auto', 'bypass']);
  eq('默认逐项确认', modeInfo(undefined).value, 'ask');
  eq('引擎支持度：Claude 全档、兼容端点与 ACP 只有部分档、沙箱类不能逐项', [modeSupport('claude-code'), modeSupport('claude-compat'), modeSupport('kimi'), modeSupport('codex'), modeSupport('dsh'), modeSupport(undefined)], ['full', 'partial', 'partial', 'none', 'none', 'none']);
  // 说明以 permissionSupport 为准（与 electron/ai/perm.cjs 一致）：Kimi 的「放手」是 yolo（手套只记账），不是「降级为逐项确认」
  eq('如实写：ACP 引擎选了「放手」是 yolo、只记账', modeNote('bypass', 'kimi')?.includes('只记账'), true);
  eq('如实写：Kimi 的「接受编辑」是近似（按逐项）', modeNote('acceptEdits', 'kimi')?.includes('按逐项确认处理'), true);
  eq('如实写：沙箱类引擎', modeNote('ask', 'codex')?.includes('沙箱策略'), true);
  eq('Codex 的「先出计划」如实对应（只读沙箱）', modeNote('plan', 'codex')?.includes('只读'), true);
  eq('Codex / DSH 的「先出计划」如实说：只有计划阶段只读，批准之后按沙箱 / 它自己的权限执行（不能逐项确认）', [modeNote('plan', 'codex'), modeNote('plan', 'dsh')].map((n) => /批准计划之后/.test(n ?? '') && /不能逐项确认/.test(n ?? '')), [true, true]);
  eq('兼容端点选了「放手」：旧驱动只有逐项和接受编辑', modeNote('bypass', 'claude-compat')?.includes('只有逐项和接受编辑'), true);
  eq('Claude 走旧驱动时「自动」降级为逐项', modeNote('auto', 'claude-code', { claudeLegacy: true })?.includes('按逐项处理'), true);
  eq('Claude 逐项确认没有多余提示', modeNote('ask', 'claude-code'), undefined);
  ok('放手要多提醒一句', !!modeNote('bypass', 'claude-code'));
}

/* ═════════════ 归来简 ═════════════ */
section('deriveBrief：用例');
{
  const MIN = 60_000;
  const t0 = 10_000_000;
  const away = (m: number) => t0 + m * MIN;
  const withSettings = (s: AppState, patch: Partial<AppState['settings']> = {}) => { s.settings = { ...s.settings, ...patch }; return s; };
  const doneRun = mkRun('r1', 't1', 'completed', { endedAt: away(16) });
  const failRun = mkRun('r2', 't2', 'failed', { endedAt: away(30) });
  const waitRun = mkRun('r3', 't3', 'awaiting');
  waitRun.approvals = [mkApproval('a1', waitRun, 'pending', away(5))];
  waitRun.questions = [mkQuestion('q1', waitRun, 'pending', away(6))];
  const chat = mkTask('c1', { kind: 'chat', lastSeenAt: t0, messages: [{ id: 'm', role: 'agent', text: 'x', at: away(20) } as Message] });
  const state = withSettings(mkState([mkTask('t1', { lastSeenAt: t0 }), mkTask('t2', { lastSeenAt: t0 }), mkTask('t3', { lastSeenAt: t0 }), chat], [doneRun, failRun, waitRun]), { distance: 0 });
  const b = deriveBrief(state, t0, away(41));
  ok('离开 41 分钟且有事：出信', !b.quiet);
  eq('计数：完成 1、失败 1、回复 1、待你（待批+待回复）2', [b.counts.done, b.counts.failed, b.counts.replies, b.counts.waiting], [1, 1, 1, 2]);
  const qn = deriveQueue(state).length;
  eq('距离 0：一行数字，与计数一致；「待你」与区块标题 / 左栏同一个数（deriveQueue 全部条目）', b.text, `离开 41 分钟：完成 1，回复 1，失败 1，待你 ${qn}。`);
  ok('这个状态里待你比「待批 + 待回复」多（有失败、待查看），所以两个口径确实会差', qn > b.counts.waiting);
  eq('每一行都能追到记录', b.lines.map((l) => [l.kind, !!(l.runId ? state.runs[l.runId] : state.tasks[l.taskId ?? ''])]), [['done', true], ['reply', true], ['failed', true]]);
  eq('行按时间顺序', b.lines.map((l) => l.at), [away(16), away(20), away(30)]);
  eq('时间窗口', [b.from, b.to], [t0, away(41)]);
  eq('没有超出 5 行就不折叠', b.more, 0);
  const d1 = deriveBrief(withSettings(state, { distance: 1, callName: '阁下' }), t0, away(41));
  ok('距离 1：句子里每个数字都在', d1.text.includes('四十一分钟') && d1.text.includes('做完了一项') && d1.text.includes('收到了一条回复') && d1.text.includes('有一项没能走到最后') && d1.text.includes(`等阁下的共有${cnCount(qn)}件`) && !d1.text.includes('还有两件事'), d1.text);
  eq('同一天同一状态：文字稳定', deriveBrief(state, t0, away(41)).text, d1.text);
  ok('离开不够久：只有一句安静的话', deriveBrief(state, t0, away(10)).quiet && deriveBrief(state, t0, away(10)).lines.length === 0);
  ok('阈值可调：设成 5 分钟就出信', !deriveBrief(withSettings(state, { returnAfterMin: 5 }), t0, away(10)).quiet);
  ok('没有离开时刻：安静', deriveBrief(state, undefined, away(41)).quiet);
  const calm = mkState([mkTask('t1', { lastSeenAt: t0 })], [mkRun('r1', 't1', 'completed', { endedAt: t0 - 5 })]);
  const quiet = deriveBrief(withSettings(calm, { distance: 1 }), t0, away(90));
  ok('离开期间没有事件：安静，且是 return.quiet 的话', quiet.quiet && quiet.text === say('return.quiet', {}, { distance: 1, callName: calm.settings.callName, seed: voiceSeed(away(90), '归来', 0) }));
  // 超过 5 行：失败优先，其余取最近的；more = 总数 - 5.
  const many: Run[] = [];
  const tasks: Task[] = [];
  for (let i = 0; i < 9; i++) { tasks.push(mkTask(`m${i}`, { lastSeenAt: t0 })); many.push(mkRun(`mr${i}`, `m${i}`, i === 2 ? 'failed' : 'completed', { endedAt: away(1 + i) })); }
  const big = deriveBrief(withSettings(mkState(tasks, many), { distance: 0 }), t0, away(60));
  eq('超过 5 行：只显示 5 行，其余折叠', [big.lines.length, big.more, big.counts.done + big.counts.failed], [5, 4, 9]);
  ok('超过 5 行：失败那条一定保留', big.lines.some((l) => l.kind === 'failed'));
  eq('超过 5 行：仍按时间顺序', big.lines.map((l) => l.at), [...big.lines.map((l) => l.at)].sort((x, y) => x - y));
  const soft = mkRun('r5', 't5', 'running');
  soft.errors = [{ id: 'e1', at: away(3), runId: 'r5', title: '网络', code: 'ENOTFOUND', message: 'x', fatal: false }, { id: 'e2', at: away(4), runId: 'r5', title: '网络', code: 'ENOTFOUND', message: 'x', fatal: false }];
  const noticeState = withSettings(mkState([mkTask('t5', { lastSeenAt: t0 })], [soft]), { distance: 0 });
  const nb = deriveBrief(noticeState, t0, away(40));
  eq('已继续的出错只列行、不计入句子', [nb.quiet, nb.lines.map((l) => l.kind), nb.counts.notices, nb.text], [false, ['notice'], 1, '离开 40 分钟。']);

  // 离开窗口
  eq('detectAway：离开的那一刻到回来够久才算', [detectAway(0, 29 * MIN, 30), detectAway(0, 30 * MIN, 30)], [undefined, { from: 0, to: 30 * MIN }]);
  eq('detectAway：lastSeen 不是数就不算', detectAway(NaN, 99 * MIN, 30), undefined);
  eq('detectAway：阈值夹在 5–120', [detectAway(0, 4 * MIN, 1), detectAway(0, 5 * MIN, 1)], [undefined, { from: 0, to: 5 * MIN }]);
  awayWindow.set({ from: 1, to: 2 });
  eq('awayWindow：设置与清除', [awayWindow.get(), (awayWindow.clear(), awayWindow.get())], [{ from: 1, to: 2 }, undefined]);
}

/* ═════════════ 命令注册表 ═════════════ */
section('命令注册表');
{
  store.init(emptyState(0));
  const list = commands();
  eq('默认键位没有冲突', findConflicts(list), []);
  eq('默认键位不占系统与输入法的键', list.flatMap((c) => c.keys ?? []).filter(isReservedBinding), []);
  ok('每个命令有标题', list.every((c) => c.id && c.title));
  ok('命令 id 唯一', new Set(list.map((c) => c.id)).size === list.length);
  ok('批准没有全局键（没有批准类命令绑定键位）', list.filter((c) => /approv|allow|permit|decide|批准|放行/i.test(`${c.id}${c.title}`)).every((c) => !(c.keys ?? []).length));
  ok('没有单个字符的全局键（K2）', list.flatMap((c) => c.keys ?? []).every((k) => !isCharBinding(parseBinding(k))));
  ok('没有裸 Enter / Space 绑定', list.flatMap((c) => c.keys ?? []).every((k) => !['enter', ' '].includes(parseBinding(k).key) || parseBinding(k).ctrl || parseBinding(k).alt));
  const keys = Object.fromEntries(list.flatMap((c) => (c.keys ?? []).map((k) => [k, c.id])));
  eq('萤火原有键位保留', [keys['Alt+1'], keys['Alt+2'], keys['Alt+3'], keys['Alt+4'], keys['Alt+5'], keys['Alt+6'], keys['Alt+7'], keys['Ctrl+`'], keys['Alt+W'], keys['Escape']], ['nav.new', 'nav.tasks', 'nav.agents', 'nav.tools', 'nav.models', 'nav.history', 'nav.settings', 'console.toggle', 'peek.toggle', 'layer.close']);
  eq('新增键位', [keys['Ctrl+N'], keys['Ctrl+,'], keys['Ctrl+B'], keys['Alt+8']], ['session.new', 'settings.open', 'nav.toggle', 'nav.queue']);
  eq('键位显示', ['Alt+1', 'Ctrl+`', 'Escape', 'Ctrl+,'].map(bindingLabel), ['Alt+1', 'Ctrl+`', 'Esc', 'Ctrl+,']);

  const ev = (o: Record<string, unknown>) => ({ key: '', code: '', ...o }) as Parameters<typeof resolveCommand>[0];
  const alt1 = ev({ key: '1', code: 'Digit1', altKey: true });
  eq('Alt+1 → 回到归来', resolveCommand(alt1)?.id, 'nav.new');
  eq('输入法组合期间一律不触发', resolveCommand({ ...alt1, isComposing: true }), undefined);
  eq('keyCode 229 也不触发', resolveCommand({ ...alt1, keyCode: 229 }), undefined);
  eq('文本框里 Alt+1 照常触发（不产生字符的组合）', resolveCommand({ ...alt1, target: { tagName: 'TEXTAREA' } })?.id, 'nav.new');
  eq('文本框里 Ctrl+N 照常触发', resolveCommand(ev({ key: 'n', code: 'KeyN', ctrlKey: true, target: { tagName: 'TEXTAREA' } }))?.id, 'session.new');
  eq('没有绑定的键不触发', resolveCommand(ev({ key: 'k', code: 'KeyK', ctrlKey: true })), undefined);
  eq('Ctrl+Shift+1 不是 Alt+1', resolveCommand(ev({ key: '1', code: 'Digit1', ctrlKey: true, shiftKey: true })), undefined);
  registerCommand({ id: 'test.char', title: '测试字符键', keys: ['b'], run: () => {} });
  eq('字符键在文本框里不触发', resolveCommand(ev({ key: 'b', code: 'KeyB', target: { tagName: 'INPUT', type: 'text' } })), undefined);
  eq('字符键在非可编辑处触发', resolveCommand(ev({ key: 'b', code: 'KeyB', target: { tagName: 'BUTTON' } }))?.id, 'test.char');
  ok('isCharBinding / matchesBinding', isCharBinding(parseBinding('b')) && !isCharBinding(parseBinding('Alt+b')) && matchesBinding(parseBinding('Ctrl+,'), ev({ key: ',', code: 'Comma', ctrlKey: true })));
  eq('冲突检测能抓到同键', (() => { registerCommand({ id: 'test.dup', title: '重复', keys: ['Alt+1'], run: () => {} }); return findConflicts().map((c) => c.ids); })(), [['nav.new', 'test.dup']]);

  // Esc 分层：没有可关的东西时不吞 Esc；赏图中、状态抽屉开着时才关.
  const esc = ev({ key: 'Escape', code: 'Escape' });
  eq('没有赏图与抽屉时 Esc 不被注册表吞掉', resolveCommand(esc, list.filter((c) => c.id === 'layer.close')), undefined);
  store.update((d) => { d.statusDrawerOpen = true; });
  eq('状态抽屉开着：Esc 关抽屉', resolveCommand(esc, list)?.id, 'layer.close');
  store.update((d) => { d.dialog = { kind: 'clear-history' }; });
  eq('有对话框时 Esc 留给对话框', resolveCommand(esc, list.filter((c) => c.id === 'layer.close')), undefined);
  store.update((d) => { d.dialog = undefined; d.statusDrawerOpen = false; d.peek = true; });
  eq('赏图中：只有标了 peek 的命令可用', [resolveCommand(alt1, list, { peek: true })?.id, resolveCommand(esc, list, { peek: true })?.id, resolveCommand(ev({ key: 'w', code: 'KeyW', altKey: true }), list, { peek: true })?.id], [undefined, 'layer.close', 'peek.toggle']);
  store.update((d) => { d.peek = false; });
}

/* ═════════════ 默认值与动作 ═════════════ */
section('默认值与动作');
{
  eq('默认称呼、话量与夜昼', [DEFAULT_SETTINGS.callName, DEFAULT_SETTINGS.level, DEFAULT_SETTINGS.mode, DEFAULT_SETTINGS.returnAfterMin], ['阁下', 'm', 'night', 30]);
  eq('旧垫片：distance 仍是 1（由 level / persona 派生，下一版再删）', DEFAULT_SETTINGS.distance, 1);
  eq('她的新设置默认值：主动说话 auto、小话题关、记得小事关、退半步开、剧情框闲聊开（用户 10-28 定）、贴纸开', [DEFAULT_SETTINGS.proactive, DEFAULT_SETTINGS.proactiveTopics, DEFAULT_SETTINGS.memoryOn, DEFAULT_SETTINGS.stepBack, DEFAULT_SETTINGS.storyBox, DEFAULT_SETTINGS.stickers], ['auto', false, false, true, 'chat', true]);
  eq('新装开场问候默认开（走 greet.* 模板，零 token；旧存档里的 false 由 migrateSettings 保持）', DEFAULT_SETTINGS.lifeGreeting, true);
  const seed = emptyState(0);
  eq('编排 Agent 叫遐蝶', [seed.agents[0].name, seed.agents[0].glyph], ['遐蝶', '遐']);
  const off = emptyState(0, { ...DEFAULT_SETTINGS, persona: false });
  eq('距离 0（人设关）时叫编排 Agent', off.agents[0].name, '编排 Agent');
  syncPersonaAgent({ agents: off.agents, settings: { ...off.settings, persona: true } });
  eq('syncPersonaAgent 能切回来', off.agents[0].name, '遐蝶');

  store.init(emptyState(0));
  const id = actions.createTask({ title: '练习', goal: '', kind: 'chat', agentIds: ['orchestrator'], start: false, trust: 'T1' });
  const created = store.get().tasks[id];
  eq('新建任务：trust 与 lastSeenAt 写进任务', [created.trust, typeof created.lastSeenAt], ['T1', 'number']);
  store.update((d) => { d.tasks[id].lastSeenAt = 5; d.view = 'new'; });
  actions.openTask(id);
  ok('打开任务页更新 lastSeenAt', (store.get().tasks[id].lastSeenAt ?? 0) > 5);
  const seen = store.get().tasks[id].lastSeenAt!;
  actions.markSeen(id, seen - 1000);
  eq('markSeen 只往前走', store.get().tasks[id].lastSeenAt, seen);
  actions.markSeen(id, seen + 1000);
  eq('markSeen 往前推', store.get().tasks[id].lastSeenAt, seen + 1000);
  store.update((d) => { d.tasks[id].engine = { kind: 'live', provider: 'claude', auth: 'cli', model: 'sonnet', label: 'Claude' }; });
  actions.setTaskPermissionMode(id, 'plan');
  eq('权限模式写进 TaskEngine', store.get().tasks[id].engine?.permissionMode, 'plan');
  actions.setDistance(2);
  eq('距离 2：persona 开', [store.get().settings.distance, store.get().settings.persona, store.get().agents[0].name], [2, true, '遐蝶']);
  actions.setDistance(0);
  eq('距离 0：persona 同步关掉', [store.get().settings.distance, store.get().settings.persona, store.get().agents[0].name], [0, false, '编排 Agent']);
  actions.setDistance(1);
  eq('回到距离 1', [store.get().settings.distance, store.get().settings.persona], [1, true]);
  actions.setLevel('l');
  eq('setLevel(多)：level 与 distance 垫片一起变', [store.get().settings.level, store.get().settings.distance, store.get().settings.persona], ['l', 2, true]);
  actions.setLevel('s');
  eq('setLevel(少)：distance 垫片 = 1（少仍是她，不再等于纯事实）', [store.get().settings.level, store.get().settings.distance, store.get().agents[0].name], ['s', 1, '遐蝶']);
  actions.setPersona(false);
  eq('setPersona(关)：口吻关 = 纯事实，distance 垫片 0，编排 Agent 改名', [store.get().settings.persona, store.get().settings.distance, store.get().settings.level, store.get().agents[0].name], [false, 0, 's', '编排 Agent']);
  actions.setPersona(true);
  eq('setPersona(开)：话量保持，名字回来', [store.get().settings.persona, store.get().settings.distance, store.get().settings.level, store.get().agents[0].name], [true, 1, 's', '遐蝶']);
  actions.setLevel('m');
  actions.setProactive('off');
  eq('setProactive(off)：lifeNudge 垫片随之关', [store.get().settings.proactive, store.get().settings.lifeNudge], ['off', false]);
  actions.setProactive('on');
  eq('setProactive(on)：lifeNudge 垫片随之开', [store.get().settings.proactive, store.get().settings.lifeNudge], ['on', true]);
  actions.setProactive('auto');

  // toast「去确认」：首页 / 待你没有右栏，焦点请求没有人接——要先去那个任务；窄窗口下不能白开一个不存在的抽屉（还会吞掉一次 Esc）
  const g2 = globalThis as unknown as { window?: unknown };
  const hadWindow = 'window' in g2;
  const prevWindow = g2.window;
  g2.window = { matchMedia: () => ({ matches: true }) };
  try {
    store.update((d) => { d.view = 'new'; d.selectedTaskId = undefined; d.statusDrawerOpen = false; d.focusRequest = undefined; });
    actions.run({ type: 'show-approvals', taskId: id, runId: 'r-x' });
    const a = store.get();
    eq('首页点「去确认」：打开那个任务页并请求聚焦待批区', [a.view, a.selectedTaskId, a.focusRequest?.target], ['task', id, 'approvals']);
    store.update((d) => { d.view = 'queue'; d.statusDrawerOpen = false; d.focusRequest = undefined; });
    actions.run({ type: 'show-approvals', taskId: id });
    eq('「待你」页同样先去任务页', [store.get().view, store.get().focusRequest?.target], ['task', 'approvals']);
    store.update((d) => { d.view = 'new'; d.statusDrawerOpen = false; d.focusRequest = undefined; });
    actions.requestFocus('approvals');
    eq('没有右栏的页面：窄窗口下也不会白开一个不存在的抽屉', store.get().statusDrawerOpen, false);
    store.update((d) => { d.view = 'task'; d.selectedTaskId = id; d.statusDrawerOpen = false; });
    actions.run({ type: 'show-approvals', taskId: id });
    eq('已经在有右栏的任务页：窄窗口下照常打开抽屉', store.get().statusDrawerOpen, true);
    store.update((d) => { d.view = 'new'; d.statusDrawerOpen = false; });
    actions.run({ type: 'show-approvals' });
    eq('不知道是哪个任务：从首页去「待你」', store.get().view, 'queue');
  } finally { if (hadWindow) g2.window = prevWindow; else delete g2.window; }

  // 高风险批准的两步确认：焦点要能交回卡片（tabIndex -1）；两处都经 useTwoStep.press 判断，第二步不直接批准
  // （组件带 CSS，bundle 不进 node 测试，没法渲染——这里对源码做守卫；判断本身的逻辑在上面 createTwoStep 的用例里）
  const src = (p: string) => readFileSync(resolvePath(process.cwd(), p), 'utf8');
  const cardSrc = src('src/components/shell/ApprovalCard.tsx');
  const rowSrc = src('src/components/views/tasks/QueueRow.tsx');
  ok('待批卡：高风险的批准要经过 useTwoStep.press 判断，卡片本身能接住焦点（tabIndex -1）', cardSrc.includes('useTwoStep') && /step\.press\([^)]*\)[\s\S]{0,80}!== 'confirm'/.test(cardSrc) && /<article[^>]*tabIndex=\{-1\}/.test(cardSrc.replace(/\s+/g, ' ')));
  ok('「待你」行：放行经过 useTwoStep.press 判断，详情容器能接住焦点', rowSrc.includes('useTwoStep') && /step\.press\(\) !== 'confirm'/.test(rowSrc) && /qrow__detail"[^>]*tabIndex=\{-1\}/.test(rowSrc));
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(`${failed} failed`); process.exit(1); }
