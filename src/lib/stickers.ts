/* 贴纸决策（施工图 §3.5，V2）：确定性、不掷骰.
   · 白名单 D10：butterfly / blushing / create / dontthink / like / bewildered；模型建议的 react 不在白名单里就丢.
   · 每会话（每个任务一次应用生命周期）上限：少 ≤1 且仅完成 / 道谢类；中 ≤2；多 ≤4 且每 10 条她的消息 ≤1. 工作模式只有完成、道谢类可有.
   · 永不出现：审批、提问、计划、步骤、报错、失败、kind==='error'、退后状态、危机、persona=false、settings.stickers=false、Agent 页、
     主动话（proactive）、审批卡 / 报错卡等内容卡里.
   · 返回约定：返回了贴纸，调用方就把这条消息的 expr 写成 gentle（exprWithSticker），且不画 136² 角标（D19）；
     不返回就按 expr 正常画角标.
   · 完成类（scene 为 done.* / chat.thanks）没有模型建议时，done.* 默认 butterfly（「完成（最万能）」，圣经 §4.2）；其余没有建议就不出. */
import { isStickerId } from './expr';
import type { ExprId, Level, StickerId } from './types';

export interface StickerCtx {
  level: Level;
  mode: 'chat' | 'work';
  /** 消息种类：reply / plan / summary / note / error / approval / question / crisis… */
  kind: string;
  expr: ExprId;
  /** 模型标签（或模板）建议的 react（必须在白名单里才采纳）. */
  requested?: StickerId;
  /** 本会话已出过几张. */
  sessionCount: number;
  /** 距上一张贴纸已过几条她的消息. */
  sinceLast: number;
  /** 「她退半步」状态. */
  retreat: boolean;
  /** 场景名（done.w / chat.thanks…）. */
  scene?: string;
  /* 以下为 V2 追加的可选闸（不传 = 不拦），调用点把已知的事实带上就行： */
  /** 角色口吻；false → 不出. */
  persona?: boolean;
  /** settings.stickers；false → 不出. */
  enabled?: boolean;
  /** 危机回合（D18）. */
  crisis?: boolean;
  /** 主动话. */
  proactive?: boolean;
  /** 渲染面：Agent 页永不出（D19）. */
  surface?: 'conversation' | 'agents';
  /** 在内容卡（审批卡、报错卡…）里. */
  inCard?: boolean;
}

/** 每会话上限. */
export const STICKER_CAP: Record<Level, number> = { s: 1, m: 2, l: 4 };
/** 多档：两张贴纸之间至少隔几条她的消息（每 10 条 ≤1）. */
export const STICKER_GAP = 10;

const NEVER_KINDS = new Set(['approval', 'question', 'plan', 'step', 'tool', 'error', 'crisis', 'system']);
/** 完成 / 道谢类场景. */
export const isJoyScene = (scene?: string): boolean => !!scene && /^(done(\.|$)|chat\.thanks(\.|$))/.test(scene);

export function decideSticker(ctx: StickerCtx): StickerId | undefined {
  if (ctx.persona === false || ctx.enabled === false || ctx.crisis || ctx.proactive || ctx.inCard) return undefined;
  if (ctx.surface === 'agents' || ctx.retreat || NEVER_KINDS.has(ctx.kind)) return undefined;
  const joy = isJoyScene(ctx.scene);
  if ((ctx.level === 's' || ctx.mode === 'work') && !joy) return undefined;
  const want: StickerId | undefined = isStickerId(ctx.requested) ? ctx.requested : /^done(\.|$)/.test(ctx.scene ?? '') ? 'butterfly' : undefined;
  if (!want) return undefined;
  if (ctx.sessionCount >= STICKER_CAP[ctx.level]) return undefined;
  if (ctx.level === 'l' && ctx.sessionCount > 0 && ctx.sinceLast < STICKER_GAP) return undefined;
  return want;
}
