/* 声线台词库加载器（V1，施工图 §3.3）。真源是 voice-lines.json（每行一条台词）与 voice-facts.json（角色口吻关掉时的纯事实模板）；
   这里只做三件事：按 ID 文法把 JSON 解析成带字段的行、给 when 谓词一个纯函数求值器、给 voice.ts 的 say2() 提供场景别名与槽位小工具。
   纯数据、无副作用、不读 store；加载出错的行不会进池，原因收在 LOAD_ERRORS 里，由 check-voice 断言为空。

   ID 文法（从右往左解析）：
       <场景>.<模式 c|w|a>.<档 s|m|l>[.v<N>][.<cond>][.n|.d]
   · 最右的 .n / .d 是夜 / 昼；其左若不是 s|m|l，先认 COND_VOCAB 里的 cond（min｜fast｜enf｜soft｜none｜planned），再认变体号 v2…v9（缺省 = 第 1 条）；
   · 再剥档、模式，其余全部是场景名（场景名自身可含 c / w 字母，如 done.w、phase.plan）；
   · 词表之外的后缀 → 加载失败。变体号是对施工图 §3.3 的补充：高频格要 ≥4 条，同一格里的行 ID 必须唯一，所以给第 2、3… 条编号。
   · 例外：comfort.crisis.a 无档位，是给提示词用的条款，单列在 CLAUSES，不进台词池。 */
import factsJson from './voice-facts.json';
import linesJson from './voice-lines.json';
import { isExprId, isStickerId } from './expr';
import type { ExprId, Level, StickerId, ThemeId } from './types';

export type Slots = Record<string, string | number | undefined>;

/** 调用点填的事实上下文（§3.3）. 缺事实 = 带 when 的行永不被选中. */
export interface VoiceFacts {
  pending?: number; failed?: number; retries?: number; steps?: number; activeMs?: number;
  saved?: boolean; hasList?: boolean; honor?: 'enf' | 'soft' | 'none'; hours?: number; awayMs?: number;
  /** 这一次运行已经有批准过的计划（计划卡自己写着「批准之后才执行」）：task.start 改用 .planned 变体，不再把计划与承诺重说一遍. */
  planned?: boolean;
}

/** 求助热线的说法. 按用户所在地区（中国大陆，用户 2026-10-27 确认）：心理援助热线 12356，紧急情况 110 / 120（圣经 §6.3、§8.5-7）.
    这是一个能直接嵌进「拨打{hotline}」的短语，不带「请查询」之类要对方自己去找的话. */
export const HOTLINE = '心理援助热线 12356，情况紧急请打 110 或 120';

/** 「做得明显快」的阈值：每步平均不超过这么久（毫秒）. */
export const FAST_MS_PER_STEP = 20_000;
/** 「小任务」的阈值：不到 2 步，或活动时间不到这么久（毫秒）. */
export const SMALL_MS = 60_000;
/** 「该歇一歇」：连续使用满这么多小时. */
export const REST_DUE_HOURS = 2;

export const COND_VOCAB = ['min', 'fast', 'enf', 'soft', 'none', 'planned'] as const;
export type Cond = (typeof COND_VOCAB)[number];

/** 谓词：纯函数，缺事实 = 假. */
export const WHEN_PREDICATES: Record<string, (f: VoiceFacts) => boolean> = {
  noPending: (f) => f.pending === 0 && f.failed === 0,
  hasList: (f) => f.hasList === true,
  retried: (f) => (f.retries ?? 0) > 0,
  /** 确实一次重试都没有（缺事实 = 假）：「顺顺当当」之类的话只在这时说. */
  smooth: (f) => f.retries === 0,
  small: (f) => (f.steps !== undefined && f.steps < 2) || (f.activeMs !== undefined && f.activeMs < SMALL_MS),
  notSmall: (f) => f.steps !== undefined && f.activeMs !== undefined && f.steps >= 2 && f.activeMs >= SMALL_MS,
  fast: (f) => f.retries === 0 && f.steps !== undefined && f.steps >= 3 && f.activeMs !== undefined && f.activeMs <= f.steps * FAST_MS_PER_STEP,
  saved: (f) => f.saved === true,
  restDue: (f) => f.hours !== undefined && f.hours >= REST_DUE_HOURS,
  enf: (f) => f.honor === 'enf',
  soft: (f) => f.honor === 'soft',
  none: (f) => f.honor === 'none',
  planned: (f) => f.planned === true,
};
export const WHEN_VOCAB = Object.keys(WHEN_PREDICATES);

export function evalWhen(pred: string, facts: VoiceFacts | undefined): boolean {
  const fn = WHEN_PREDICATES[pred];
  return !!fn && !!facts && fn(facts);
}

/* ───────────── ID 文法 ───────────── */

export interface ParsedId {
  scene: string; mode: 'c' | 'w' | 'a'; level: Level; theme?: ThemeId; cond?: string;
  /** 变体号，从 1 起；ID 里没有 .v<N> 就是 1. */
  variant: number;
}

const LEVELS: readonly string[] = ['s', 'm', 'l'];

export function parseLineId(id: string): ParsedId | undefined {
  const p = id.split('.');
  let theme: ThemeId | undefined;
  const last = p[p.length - 1];
  if (last === 'n' || last === 'd') { theme = last === 'n' ? 'night' : 'day'; p.pop(); }
  let cond: string | undefined;
  if (p.length && (COND_VOCAB as readonly string[]).includes(p[p.length - 1])) cond = p.pop();
  let variant = 1;
  const v = /^v([2-9])$/.exec(p[p.length - 1] ?? '');
  if (v) { variant = Number(v[1]); p.pop(); }
  const lv = p.pop();
  const mode = p.pop();
  if (!lv || !LEVELS.includes(lv) || !mode || !['c', 'w', 'a'].includes(mode) || !p.length) return undefined;
  return { scene: p.join('.'), mode: mode as 'c' | 'w' | 'a', level: lv as Level, theme, cond, variant };
}

/* ───────────── 行与加载 ───────────── */

export interface RawLine {
  id: string; mode: string; lv: string; text: string; exp: string;
  react?: string; when?: string[]; commits?: string; note?: string;
}

export interface VoiceLine extends ParsedId {
  id: string;
  text: string;
  exp: ExprId | null;
  react?: StickerId;
  when: string[];
  commits?: string;
  note?: string;
  /** 没有默认值、必须由调用点给的槽位名（缺了就不能选这一行）. */
  needs: string[];
}

const LEVEL_OF_ZH: Record<string, Level> = { 少: 's', 中: 'm', 多: 'l' };
/** 有默认值的槽位：缺了也能渲染（{t}→「这一件」等），不算「必需」. */
const DEFAULTED = new Set(['n', 't', 'what', 'dir', 'label', 'hotline', 'clauses', 'short', 'away', 'hours']);

export function slotsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\{([\w.]+)\}/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export const LOAD_ERRORS: string[] = [];
export const CLAUSES: Record<string, string> = {};
export const LINES: VoiceLine[] = [];
{
  const seen = new Set<string>();
  for (const raw of linesJson as unknown as RawLine[]) {
    const bad = (why: string) => { LOAD_ERRORS.push(`${raw.id}：${why}`); };
    if (seen.has(raw.id)) { bad('ID 重复'); continue; }
    seen.add(raw.id);
    const q = parseLineId(raw.id);
    if (!q) {
      if (raw.id.startsWith('comfort.crisis')) CLAUSES[raw.id] = raw.text; else bad('ID 不合文法');
      continue;
    }
    if (LEVEL_OF_ZH[raw.lv] !== q.level) { bad(`档位 ${raw.lv} 与 ID 不一致`); continue; }
    if (raw.mode !== q.mode) { bad(`模式 ${raw.mode} 与 ID 不一致`); continue; }
    const exp = raw.exp === '—' ? null : raw.exp;
    if (exp !== null && !isExprId(exp)) { bad(`表情非法 ${raw.exp}`); continue; }
    if (raw.react !== undefined && !isStickerId(raw.react)) { bad(`贴纸非法 ${raw.react}`); continue; }
    const unknown = (raw.when ?? []).filter((w) => !WHEN_VOCAB.includes(w));
    if (unknown.length) { bad(`未知谓词 ${unknown.join('、')}`); continue; }
    LINES.push({
      ...q, id: raw.id, text: raw.text, exp: exp as ExprId | null, react: raw.react as StickerId | undefined,
      when: raw.when ?? [], commits: raw.commits, note: raw.note,
      needs: slotsIn(raw.text).filter((k) => !k.startsWith('img.') && !DEFAULTED.has(k)),
    });
  }
}

export const BY_SCENE = new Map<string, VoiceLine[]>();
for (const l of LINES) { const a = BY_SCENE.get(l.scene); if (a) a.push(l); else BY_SCENE.set(l.scene, [l]); }

/** 角色口吻关掉时的纯事实模板：场景 → 模板；false = 该场景在 persona=false 下整行不渲染. */
export const FACTS: Record<string, string | false> = factsJson as unknown as Record<string, string | false>;

/* ───────────── 场景别名（旧 27 个场景 → 新场景名，圣经 §7.3）───────────── */

/** 老调用点不改名：这里查别名到新场景. 无模式上下文的 toast / 通知默认 mode:'work'. */
export const SCENE_ALIASES: Record<string, string> = {
  'return.brief': 'return.brief', 'return.quiet': 'return.quiet', 'queue.empty': 'queue.empty',
  'plan.ready': 'phase.plan', 'plan.approved': 'task.start',
  'run.done': 'done.w', 'run.failed': 'fail.w', 'run.cancelled': 'stop.w', interrupt: 'stop.w',
  'question.ask': 'question.w', 'approval.wait': 'approve.ask', 'approval.rejected': 'approve.no',
  'chat.error': 'fail.c',
  'composer.placeholder': 'composer.w', 'composer.placeholder.chat': 'composer.c',
  'trust.ask': 'trust.ask', 'trust.suspect': 'trust.suspect', 'trust.broad': 'trust.broad',
  'trust-ask': 'trust.ask', 'trust-suspect': 'trust.suspect', 'trust-broad': 'trust.broad',
  'question.await': 'question.await', 'quota.warn': 'quota.warn',
  'notify.approval': 'notify.approval', 'notify.question': 'notify.question', 'notify.plan': 'notify.plan',
  'notify.failed': 'notify.failed', 'notify.many': 'notify.many', 'notify.done': 'notify.done',
  'distance.set': 'level.set', 'empty.recent': 'empty.recent',
  // none 是 cond 后缀词，场景名不能以它结尾：Agent 页页眉的「命令行工具不听档位」场景实名 agents.comp.cli.
  'agents.comp.none': 'agents.comp.cli',
};

/** 别名换成正式场景名. 正式场景名原样返回. */
export function canonicalScene(scene: string): string {
  if (BY_SCENE.has(scene) || Object.hasOwn(FACTS, scene)) return scene;
  return SCENE_ALIASES[scene] ?? scene;
}

/* ───────────── 中文数字与时长（别的模块在用，原样保留）───────────── */

export const num = (s: Slots, k: string): number => { const v = Number(s[k]); return Number.isFinite(v) ? v : 0; };
export const str = (s: Slots, k: string): string => (s[k] === undefined || s[k] === null ? '' : String(s[k]).trim());
export const clip = (t: string, n: number): string => { const a = Array.from(t); return a.length > n ? `${a.slice(0, n).join('')}…` : t; };

const DIGIT = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
/** 0–99 的中文数字；更大的用阿拉伯数字. */
export function cnNum(n: number): string {
  n = Math.floor(n);
  if (!Number.isFinite(n) || n < 0 || n >= 100) return String(n);
  if (n < 10) return DIGIT[n];
  if (n === 10) return '十';
  if (n < 20) return `十${DIGIT[n - 10]}`;
  const t = Math.floor(n / 10), o = n % 10;
  return `${DIGIT[t]}十${o ? DIGIT[o] : ''}`;
}
/** 量词前的数：2 读「两」，其余同 cnNum. */
export const cnCount = (n: number): string => (Math.floor(n) === 2 ? '两' : cnNum(n));

/** 离开多久，中文口语：四十一分钟 / 一小时十五分钟 / 两天三小时. */
export function spanCn(min: number): string {
  min = Math.max(0, Math.floor(min));
  if (min < 1) return '不到一分钟';
  if (min < 60) return `${cnCount(min)}分钟`;
  if (min < 1440) {
    const h = Math.floor(min / 60), m = min % 60;
    if (m === 0) return `${cnCount(h)}小时`;
    return m < 10 ? `${cnCount(h)}小时零${cnNum(m)}分钟` : `${cnCount(h)}小时${cnNum(m)}分钟`;
  }
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
  return h === 0 ? `${cnCount(d)}天` : `${cnCount(d)}天${cnCount(h)}小时`;
}

/** 离开多久，数字写法：41 分钟 / 1 时 15 分 / 2 天 3 时（纯事实、队列等待用）. */
export function spanNum(min: number): string {
  min = Math.max(0, Math.floor(min));
  if (min < 1) return '不到 1 分钟';
  if (min < 60) return `${min} 分钟`;
  if (min < 1440) { const h = Math.floor(min / 60), m = min % 60; return m ? `${h} 时 ${m} 分` : `${h} 时`; }
  const d = Math.floor(min / 1440), h = Math.floor((min % 1440) / 60);
  return h ? `${d} 天 ${h} 时` : `${d} 天`;
}

/* ───────────── 槽位渲染 ───────────── */

/** 夜昼景物槽（§2.8）. */
const IMG: Record<string, [string, string]> = {
  light: ['灯光', '日光'], water: ['冥河静静的水面', '花海起伏的浪'], weather: ['雪', '微风'],
  flower: ['幽蓝的安提灵', '开满的花'], sky: ['月色', '天光'], rest: ['灯下', '日光下'],
};

/** 「待你」的数：调用点给了 queue（左栏 / 区块标题同口径，含待批、提问、失败、待查看）就用它，否则退回 waiting（只算在等定夺的）.
    归来笺正文与区块标题必须是同一个数（评审 return-brief）. */
export const waitingOf = (s: Slots): number => (s.queue !== undefined && String(s.queue).trim() !== '' ? num(s, 'queue') : num(s, 'waiting'));

/** 「做完了一项，收到了一条回复，有一项没能走到最后，等阁下的有三件」. */
export function briefClauses(s: Slots, n: string): string {
  const done = num(s, 'done'), replies = num(s, 'replies'), failed = num(s, 'failed'), waiting = waitingOf(s);
  const out: string[] = [];
  if (done > 0) out.push(`做完了${cnCount(done)}项`);
  if (replies > 0) out.push(`收到了${cnCount(replies)}条回复`);
  if (failed > 0) out.push(`有${cnCount(failed)}项没能走到最后`);
  if (waiting > 0) out.push(s.queue !== undefined ? `等${n}的共有${cnCount(waiting)}件` : `还有${cnCount(waiting)}件事在等${n}定夺`);
  return out.length ? out.join('，') : '没有新的变动';
}

/** 少档的短版：「做完一项，回复一条，一项没走完，三件等阁下」. */
export function briefShort(s: Slots, n: string): string {
  const done = num(s, 'done'), replies = num(s, 'replies'), failed = num(s, 'failed'), waiting = waitingOf(s);
  const out: string[] = [];
  if (done > 0) out.push(`做完${cnCount(done)}项`);
  if (replies > 0) out.push(`回复${cnCount(replies)}条`);
  if (failed > 0) out.push(`${cnCount(failed)}项没走完`);
  if (waiting > 0) out.push(`${cnCount(waiting)}件等${n}`);
  return out.length ? out.join('，') : '没有新的变动';
}

/** 纯事实的归来简：离开 41 分钟：完成 1，回复 1，待你 1。 */
export function briefFacts(s: Slots): string {
  const parts: string[] = [];
  const add = (label: string, v: number) => { if (v > 0) parts.push(`${label} ${v}`); };
  add('完成', num(s, 'done')); add('回复', num(s, 'replies')); add('失败', num(s, 'failed')); add('待你', waitingOf(s));
  const head = `离开 ${spanNum(num(s, 'away'))}`;
  return parts.length ? `${head}：${parts.join('，')}。` : `${head}。`;
}

/** 把调用点给的原始槽位补成模板用的槽位：默认值、口语化、旧槽位别名（title → t / what）. */
export function deriveSlots(slots: Slots, callName: string, plainFacts = false): Record<string, string> {
  const o: Record<string, string> = {};
  for (const [k, v] of Object.entries(slots)) if (v !== undefined && v !== null && String(v).trim() !== '') o[k] = String(v).trim();
  const title = clip(o.title ?? '', 20);
  if (o.t === undefined) o.t = title ? `「${title}」` : '这一件';
  if (o.what === undefined) o.what = clip(o.title ?? '', 26) || '这一步';
  if (o.first !== undefined) o.first = clip(o.first, 20);
  if (o.dir === undefined) o.dir = '这个目录'; else o.dir = clip(o.dir, 24);
  if (o.label !== undefined) o.label = clip(o.label, 16);
  if (o.away !== undefined && /^\d+(\.\d+)?$/.test(o.away)) o.away = plainFacts ? spanNum(Number(o.away)) : spanCn(Number(o.away));
  if (o.hours !== undefined && /^\d+(\.\d+)?$/.test(o.hours)) o.hours = `${cnCount(Math.max(1, Math.round(Number(o.hours))))}个钟头`;
  if (o.hotline === undefined) o.hotline = HOTLINE;
  if (o.clauses === undefined && ['done', 'replies', 'failed', 'waiting'].some((k) => slots[k] !== undefined)) {
    o.clauses = plainFacts ? '' : briefClauses(slots, callName);
  }
  if (o.short === undefined && ['done', 'replies', 'failed', 'waiting'].some((k) => slots[k] !== undefined)) {
    o.short = plainFacts ? '' : briefShort(slots, callName);
  }
  // 纯事实模板用的两个派生槽位（旧 d0 的归来简与额度句）
  if (['done', 'replies', 'failed', 'waiting', 'queue', 'away'].some((k) => slots[k] !== undefined)) o.brief = briefFacts(slots);
  o.qcount = o.count ?? '1';
  if (o.label !== undefined) o.quotaNote = o.percent ? ` 约 ${o.percent}%` : '需要留意';
  return o;
}

/** 渲染一行：{n}、{img.xxx}、{slot}；没有的槽位留空（同旧行为）。
    可选段 [[…{slot}…]]：里面的槽位有一个缺就整段不出（纯事实模板用：「计划已生成[[：{steps} 步]]」）. */
export function renderLine(text: string, slots: Slots, callName: string, theme: ThemeId, plainFacts = false): string {
  const d = deriveSlots(slots, callName, plainFacts);
  return text
    .replace(/\[\[(.*?)\]\]/gs, (_m, seg: string) => (slotsIn(seg).every((k) => k === 'n' || k.startsWith('img.') || d[k] !== undefined && d[k] !== '') ? seg : ''))
    .replace(/\{img\.(\w+)\}/g, (_m, k: string) => IMG[k]?.[theme === 'day' ? 1 : 0] ?? '')
    .replace(/\{(\w+)\}/g, (_m, k: string) => (k === 'n' ? callName : d[k] ?? ''))
    .trim();
}

/** 这一行需要的槽位，调用点是否都给了. */
export function slotsSatisfied(needs: readonly string[], slots: Slots): boolean {
  return needs.every((k) => {
    if (k === 'count' && slots.count === 0) return true;
    const v = slots[k];
    return v !== undefined && v !== null && String(v).trim() !== '';
  });
}
