/* 选项胶囊（施工图 §4.4，V2）：只在闲聊；出现在 ①休息关照 / 很晚 / 主动搭话之后（所有话量）；②多档的「小事」类话之后.
   ≤3 个，最后一个恒为退出项（透明底、虚线描边）；退出项只触发 leave.c 模板短回（exitAction:'leave'），不调模型、不追问；
   休息 / 很晚之后的退出项是「好，知道了」——「今天别再提醒」只留系统行上那一处（第 1 轮评审：三处几乎一样的退出控件太啰嗦）；
   exitAction:'mute' 仍留在类型里备用，但现在没有胶囊用它；文案里永不出现「再聊一会儿」「陪我」一类的留客词（CLINGY）. 点击普通项 = 把该文字当用户消息发出.
   crisis 回合与危机当天不出；persona=false 不出；工作任务不出. 少档只留「主选项 + 退出项」（短而仍是她）.

   文案来自 pill.* 场景（V1 的台词库；场景名见下面 PILL_SCENES），库里没有时用这里的朴素默认句，两条路都过 CLINGY 过滤. */
import { say2 } from './voice';
import type { Level } from './types';

export interface Pill {
  id: string;
  text: string;
  /** 退出项：最后一个，虚线描边. */
  exit?: boolean;
  /** 仅退出项：触发什么（leave = leave.c 模板短回；mute = 今天别再提醒，现不使用）. */
  exitAction?: 'leave' | 'mute';
  /** 仅 rest/late 的「去歇一会儿」类：点了清零「被忽略」计数（voiceGate.noteAccepted）. */
  accepts?: boolean;
}

export interface PillCtx {
  /** 刚出现的是哪一类话. */
  after: 'rest' | 'late' | 'nudge' | 'small' | 'other';
  level: Level;
  persona: boolean;
  crisis?: boolean;
  /** 任务种类；只有 chat 出. */
  taskKind: 'chat' | 'work';
  /** 称呼与夜昼（给 pill.* 台词用，可省）. */
  callName?: string;
  theme?: 'night' | 'day';
}

/** 默认文案（也是 V1 写 pill.* 台词时的场景名清单）. */
export const PILL_SCENES: Record<string, string> = {
  'pill.rest.go': '好，我去歇一会儿',
  'pill.rest.keep': '我再做一会儿',
  'pill.rest.ack': '好，知道了',
  'pill.late.go': '做完这件就歇',
  'pill.late.ack': '好，知道了',
  'pill.nudge.more': '说说看',
  'pill.nudge.other': '换个话题',
  'pill.nudge.leave': '先不聊了',
  'pill.small.more': '说说看',
  'pill.small.other': '换个话题',
  'pill.small.leave': '先不聊了',
};

/** 留客词：命中就丢掉模板句，改用默认句（lint 在 check-voice，这里是第二道）. */
const CLINGY = /再聊|再陪|陪我|别走|不要走|再待|等一下|留下|舍不得/;

function textOf(id: string, ctx: PillCtx): string {
  const fallback = PILL_SCENES[id];
  try {
    const r = say2(id, {}, { level: ctx.level, mode: 'chat', persona: true, callName: ctx.callName, theme: ctx.theme });
    const t = r.text.trim();
    if (t && !CLINGY.test(t) && Array.from(t).length <= 16) return t;
  } catch { /* 台词库里没有就用默认句 */ }
  return fallback;
}

/** 一条她的话（按 src.scene）之后该出哪一类胶囊；不是这几类就是 'other'（不出）. 给渲染层把 Message.src 翻成 PillCtx.after 用. */
export function pillAfterOf(scene: string | undefined): PillCtx['after'] {
  if (!scene) return 'other';
  if (/^nudge\.rest(\.|$)/.test(scene) || /^sys\.rest/.test(scene)) return 'rest';
  if (/^late(\.|$)/.test(scene) || /^sys\.late/.test(scene)) return 'late';
  if (/^nudge\.(doll|photo|flower|book|letter|myth)(\.|$)/.test(scene)) return 'nudge';
  if (/^world\./.test(scene)) return 'small';
  return 'other';
}

export function pillsFor(ctx: PillCtx): Pill[] {
  if (ctx.taskKind !== 'chat' || !ctx.persona || ctx.crisis) return [];
  const mk = (id: string, extra: Partial<Pill> = {}): Pill => ({ id, text: textOf(id, ctx), ...extra });
  const short = ctx.level === 's';
  switch (ctx.after) {
    case 'rest':
      return short
        ? [mk('pill.rest.go', { accepts: true }), mk('pill.rest.ack', { exit: true, exitAction: 'leave' })]
        : [mk('pill.rest.go', { accepts: true }), mk('pill.rest.keep'), mk('pill.rest.ack', { exit: true, exitAction: 'leave' })];
    case 'late':
      return [mk('pill.late.go', { accepts: true }), mk('pill.late.ack', { exit: true, exitAction: 'leave' })];
    case 'nudge':
      return short
        ? [mk('pill.nudge.more'), mk('pill.nudge.leave', { exit: true, exitAction: 'leave' })]
        : [mk('pill.nudge.more'), mk('pill.nudge.other'), mk('pill.nudge.leave', { exit: true, exitAction: 'leave' })];
    case 'small':
      // 「小事」类话之后的胶囊只给多档
      return ctx.level === 'l'
        ? [mk('pill.small.more'), mk('pill.small.other'), mk('pill.small.leave', { exit: true, exitAction: 'leave' })]
        : [];
    default:
      return [];
  }
}
