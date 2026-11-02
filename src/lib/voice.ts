/* 声线模板库（V1，施工图 §3.3）。
   say2(scene, slots, opts)：纯函数；按 场景 × 模式(闲聊 / 工作 / 页面) × 话量(少 / 中 / 多) 选池，池里按种子轮换；
   带 when 的行只在调用点给了对应事实时才进池（缺事实 = 永不被选中）；persona=false 走 voice-facts.json 的纯事实模板。
   放行、排序、证据永远由确定性代码决定，这里只管措辞。台词在 voice-lines.json，加载与谓词在 voice-lines.ts，黄金输出与 lint 在 scripts/check-voice.ts。

   种子（seed）的约定：`日期|项目|序号`，用 voiceSeed(时间, 项目, 序号) 生成。
   选哪一条 = 日期的天数 + hash(场景|模式|档, 项目) + 序号（对池的大小取模），所以：
   · 同一场景、同一项目，连续的每一天一定换一条（池 ≥2），连续 N 天不重复（N = 池的大小）；
   · 同一天里同一场景要出现多次时，调用方递增「序号」，也不会连着重复；
   · 种子不是这个格式时，退化为对整个种子取 hash，仍是确定的；不给种子就固定取池里第一条.
   旧签名 say(scene, slots, { distance, seed, callName }) 保留：distance 0 = persona:false，1 = 中，2 = 多. */
import { useMemo } from 'react';
import {
  BY_SCENE, CLAUSES, FACTS, LINES, SCENE_ALIASES, canonicalScene, cnCount, cnNum, evalWhen, parseLineId, renderLine, slotsSatisfied, spanCn, spanNum,
  type Slots, type VoiceFacts, type VoiceLine,
} from './voice-lines';
import { useNow } from './hooks';
import { store, useApp } from '../state/store';
import type { Distance, ExprId, Level, Message, StickerId, ThemeId } from './types';

export type Scene = string;
export type { Slots, VoiceFacts };
export { cnCount, cnNum, parseLineId, spanCn, spanNum };

export const DEFAULT_CALL = '阁下';

/** 32 位 FNV-1a. */
function hash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 生成种子：本地日期 + 项目名 + 可选序号（同一天里同一场景第几次）. */
export function voiceSeed(at: number | Date = 0, project = '', index: number | string = ''): string {
  const d = at instanceof Date ? at : new Date(at);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}|${project}|${index}`;
}

/** 在 n 个变体里选第几个. 同一个 (场景, 种子) 永远得到同一个结果. */
export function pickIndex(scene: string, n: number, seed = ''): number {
  if (n <= 1) return 0;
  const parts = seed.split('|');
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(parts[0] ?? '');
  let idx: number;
  if (m) {
    const day = Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86_400_000);
    const extra = parts.slice(2).join('|');
    const bump = /^\d+$/.test(extra) ? Number(extra) : extra ? hash(extra) : 0;
    idx = day + hash(`${scene}|${parts[1] ?? ''}`) + bump;
  } else {
    idx = seed ? hash(`${scene}|${seed}`) : 0;
  }
  return ((idx % n) + n) % n;
}

const nameOf = (callName?: string) => (callName ?? '').trim() || DEFAULT_CALL;

/** 等待时长：「等 1 时 9 分」「最久 2 天」用：不到 1 分钟写「不到 1 分」，其余同 spanNum（分钟取整）. */
export function waitText(ms: number): string {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 1) return '不到 1 分';
  const t = spanNum(min);
  return t.endsWith('分钟') ? t.replace('分钟', '分') : t;
}

/* ═══════════════ 场景清单与高频格（§3.3）═══════════════ */

/** 全部场景名（台词库里出现过的）. */
export const SCENE_NAMES: string[] = [...BY_SCENE.keys()];
export function hasScene(scene: string): boolean { const c = canonicalScene(scene); return BY_SCENE.has(c) || Object.hasOwn(FACTS, c); }

/** 高频格：用户一天里会反复看到的场景. 前一批每个 (场景, 模式, 档) 池 ≥4 条，后一批 ≥3 条（check-voice 数）.
    greet.* 按时辰拆成 greet.am|noon|eve|late|away，各自一个场景. */
export const HIGH_FREQUENCY_4: readonly string[] = [
  'return.brief', 'return.quiet', 'queue.empty', 'phase.plan', 'task.start', 'done.w', 'fail.w', 'approve.ask', 'approve.high',
  'question.w', 'composer.w', 'composer.c', 'greet.am', 'greet.noon', 'greet.eve', 'greet.late', 'greet.away', 'chat.joy', 'chat.thanks', 'run.wait',
];
export const HIGH_FREQUENCY_3: readonly string[] = [
  'greet.first', 'agents.setmodel', 'agents.white', 'agents.silver', 'agents.black', 'agents.on', 'agents.off',
  'phase.read', 'phase.edit', 'phase.test', 'phase.retry', 'approve.yes', 'approve.no', 'level.set',
  'leave.c', 'leave.w', 'leave.run', 'leave.reassure',
];
export const HIGH_FREQUENCY_SCENES: string[] = [...HIGH_FREQUENCY_4, ...HIGH_FREQUENCY_3];

/* ═══════════════ say2 ═══════════════ */

/** 调用点之外，说话上下文：React 里 useVoice()（V2）、非 React 的 voiceNow() 给的就是这个. */
export interface VoiceCtx { level: Level; persona: boolean; theme: ThemeId }

export interface Say2Opts {
  level?: Level;
  mode?: 'chat' | 'work';
  theme?: ThemeId;
  persona?: boolean;
  seed?: string;
  callName?: string;
  facts?: VoiceFacts;
  /** 「让她换个说法」重抽时避开当前这一行（行 ID，即 Message.src.id）；池里只有它一条就仍用它. */
  exceptId?: string;
}

export interface Say2Result {
  text: string;
  expr: ExprId | null;
  react?: StickerId;
  src: Message['src'];
  /** persona=false 且该场景在 voice-facts 里标 false：调用方不出气泡. */
  silent?: boolean;
}

/** cond 后缀里真正按「引擎会不会遵守」分池的三个；min / fast 只是 when 的标记，闸门在 when 里. */
const HONOR_CONDS: readonly string[] = ['enf', 'soft', 'none'];
/** 由 cond 自己当闸门的后缀：honor 三个 + planned（task.start 的「已有批准计划」变体，缺 facts.planned 永不被选中）. */
const GATED_CONDS: readonly string[] = [...HONOR_CONDS, 'planned'];

const FALLBACK_LEVELS: Record<Level, Level[]> = { s: ['s', 'm', 'l'], m: ['m', 's', 'l'], l: ['l', 'm', 's'] };

/** 某场景、某模式、某档、此刻上下文里能抽的行（已过 when / cond / 主题 / 必需槽位）.
    honor 已知、且这一格有对应 honor 后缀的行时，只从这些行里抽：不带后缀的中性行只在 honor 缺失时用，
    免得「这位同伴不理会档位」被三选一的中性行稀释掉（审稿 high-1）. */
function usableRows(rows: readonly VoiceLine[], m: 'c' | 'w' | 'a', level: Level, o: { theme: ThemeId; facts?: VoiceFacts; slots: Slots }): VoiceLine[] {
  const pool = rows.filter((l) =>
    l.mode === m && l.level === level
    && (!l.theme || l.theme === o.theme)
    && (!l.cond || !GATED_CONDS.includes(l.cond) || evalWhen(l.cond, o.facts))
    && l.when.every((w) => evalWhen(w, o.facts))
    && slotsSatisfied(l.needs, o.slots));
  const honor = o.facts?.honor;
  if (honor && pool.some((l) => l.cond === honor)) return pool.filter((l) => l.cond === honor);
  // 已有批准计划且这一格有 .planned 行：只从这些里抽，免得无计划版（「我一步一步来」之类）把计划卡已说过的再说一遍
  if (o.facts?.planned && pool.some((l) => l.cond === 'planned')) return pool.filter((l) => l.cond === 'planned');
  return pool;
}

/** 纯事实模板：honor 已知且有「<场景>.<honor>」的专用模板时用专用的（银 / 黑要如实说引擎会不会遵守），否则用场景本身的. */
function factsText(scene: string, slots: Slots, callName: string, theme: ThemeId, honor?: VoiceFacts['honor']): string | false | undefined {
  const t = (honor && FACTS[`${scene}.${honor}`] !== undefined ? FACTS[`${scene}.${honor}`] : undefined) ?? FACTS[scene];
  if (t === undefined) return undefined;
  if (t === false) return false;
  return renderLine(t, slots, callName, theme, true);
}

export function say2(scene: Scene, slots: Slots = {}, opts: Say2Opts = {}): Say2Result {
  const level: Level = opts.level ?? 'm';
  const theme: ThemeId = opts.theme ?? 'night';
  const callName = nameOf(opts.callName);
  const mode: 'chat' | 'work' = opts.mode ?? 'work';
  const here = mode === 'chat' ? 'c' : 'w';
  const sc = canonicalScene(scene);
  const flat: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(slots)) if (v !== undefined) flat[k] = v;
  const factsResult = (): Say2Result => {
    const t = factsText(sc, slots, callName, theme, opts.facts?.honor);
    return { text: t || '', expr: null, src: { id: sc, slots: flat, mode, idx: 0, scene: sc }, ...(t === false ? { silent: true } : {}) };
  };
  if (opts.persona === false) return factsResult();
  const rows = BY_SCENE.get(sc);
  if (!rows) return factsResult();
  const order: Array<'c' | 'w' | 'a'> = [here, 'a', here === 'c' ? 'w' : 'c'];
  for (const lv of FALLBACK_LEVELS[level]) {
    for (const m of order) {
      const pool = usableRows(rows, m, lv, { theme, facts: opts.facts, slots });
      if (!pool.length) continue;
      let i = pickIndex(`${sc}|${m}|${lv}`, pool.length, opts.seed);
      if (opts.exceptId && pool.length > 1 && pool[i].id === opts.exceptId) i = (i + 1) % pool.length;
      const hit = pool[i];
      return {
        text: renderLine(hit.text, slots, callName, theme),
        expr: hit.exp,
        react: hit.react,
        src: { id: hit.id, slots: flat, mode: hit.mode === 'c' ? 'chat' : hit.mode === 'w' ? 'work' : 'any', idx: i, scene: hit.scene },
      };
    }
  }
  return factsResult();
}

/** 某场景此刻能抽的每一个变体（渲染后的整句）. 测试与 lint 用. */
export function voiceVariants(scene: Scene, slots: Slots = {}, opts: Omit<Say2Opts, 'seed' | 'exceptId'> = {}): string[] {
  const sc = canonicalScene(scene);
  const rows = BY_SCENE.get(sc);
  const level: Level = opts.level ?? 'm';
  const theme: ThemeId = opts.theme ?? 'night';
  const callName = nameOf(opts.callName);
  const here = (opts.mode ?? 'work') === 'chat' ? 'c' : 'w';
  if (opts.persona === false || !rows) {
    const t = factsText(sc, slots, callName, theme, opts.facts?.honor);
    return t ? [t] : [];
  }
  for (const lv of FALLBACK_LEVELS[level]) {
    for (const m of [here, 'a', here === 'c' ? 'w' : 'c'] as Array<'c' | 'w' | 'a'>) {
      const pool = usableRows(rows, m, lv, { theme, facts: opts.facts, slots });
      if (pool.length) return pool.map((l) => renderLine(l.text, slots, callName, theme));
    }
  }
  const t = factsText(sc, slots, callName, theme, opts.facts?.honor);
  return t ? [t] : [];
}

/* ═══════════════ 旧签名 ═══════════════ */

export interface SayOpts extends Say2Opts {
  /** 0 纯事实 / 1 中（默认）/ 2 多. 新代码用 level + persona. */
  distance?: Distance;
}

/** 旧签名：distance 0 → persona:false，1 → 中，2 → 多. 返回纯文本；未知场景返回空串. 无模式上下文的 toast / 通知按 work. */
export function say(scene: Scene, slots: Slots = {}, opts: SayOpts = {}): string {
  const { distance, ...rest } = opts;
  const d: Distance = distance === 0 || distance === 2 ? distance : 1;
  return say2(scene, slots, { ...rest, persona: rest.persona ?? d !== 0, level: rest.level ?? (d === 2 ? 'l' : 'm') }).text;
}

/** 场景别名表（只读）. */
export { SCENE_ALIASES, CLAUSES, LINES };

/* ═══════════════ 说话上下文 ═══════════════ */

/** 非 React 的说话上下文（live.ts、shell.ts 等）. 关掉口吻或旧 distance 为 0 都算 persona=false（与 selectors.effectiveDistance 同口径）. */
export function voiceNow(): VoiceCtx & { callName: string } {
  const s = store.get()?.settings;
  return {
    level: s?.level ?? 'm',
    persona: !!s && s.persona !== false && s.distance !== 0,
    theme: s?.mode ?? 'night',
    callName: nameOf(s?.callName),
  };
}

/** say2 的 React 版：自带话量、口吻、夜昼、称呼与日期种子. 第三个参数可覆盖其中任何一项（mode、facts、seed…）. */
export function useSay2() {
  const level = useApp((s) => s.settings.level ?? 'm');
  const persona = useApp((s) => s.settings.persona !== false && s.settings.distance !== 0);
  const theme = useApp((s) => s.settings.mode);
  const callName = useApp((s) => s.settings.callName);
  const day = new Date(useNow(60_000)).toDateString();
  return useMemo(
    () => (scene: Scene, slots: Slots = {}, o: Say2Opts = {}): Say2Result =>
      say2(scene, slots, { level, persona, theme, callName, seed: voiceSeed(Date.now(), '', 0), ...o }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `day` 只用来在跨过午夜时换一条
    [level, persona, theme, callName, day],
  );
}

/** useSay2 的字符串版：`(scene, slots?, o?) => string`. （selectors.ts 里旧的 useSay 保留到调用方换完） */
export function useSay() {
  const say2h = useSay2();
  return useMemo(() => (scene: Scene, slots: Slots = {}, o: Say2Opts = {}): string => say2h(scene, slots, o).text, [say2h]);
}
