/* 神色兜底与神色词（施工图 §3.4，V2）。不多一次模型调用：模型标签给了合法候选就用，没给就看事件 / 关键词 / 连续上限.
   只在消息产生那一刻调用并把结果写进 Message.expr；渲染时不调（旧消息固定 gentle、不画角标）.

   优先级（从高到低）：
     1. kind==='crisis' → 恒 gentle（D18）.
     2. 硬 gentle：kind 为 error / approval，或事件为 approval / irreversible / apology / fail（失败≠难过：失败时她是 gentle 的抱歉）。
        这一档不受模型候选、关键词、连续上限影响.
     3. 事件映射（以事件为主、模型标签为辅，§4.5）：提问 / 重试 / 外部原因失败 → confused；完成 / 替你高兴 → relaxed；
        被夸 / 被叫昵称 → shy；很晚 / 做得意外地快 / 被打断 → surprised；计划就绪 / 批准 / 取消 → gentle.
     4. 模型候选（合法的六个 ID 之一）.
     5. 闲聊无标签：正文头 12 字与用户上一句的关键词.
     6. 缺省 gentle.
   grumpy 默认不启用（D9）→ 退 confused；开启后也只在多档、工作里对事较劲时可用.
   连续相同表情上限：gentle ≤5，其余 ≤3，超出换相邻语义；距上一次变化 ≥3 分钟当作新的开始. */
import { isExprId } from './expr';
import type { ExprId, Level } from './types';

export interface SettleCtx {
  /** 模型标签给的候选. */
  candidate?: ExprId;
  /** 事件名（approval / irreversible / apology / fail / fail-ext / question / retry / done / joy / praised / nickname / late / fast / interrupted / plan-ready / plan-approved / cancelled…）. */
  event?: string;
  /** 她这条话的正文（已剥标签）. */
  text: string;
  /** 用户上一句. */
  userText?: string;
  /** 最近几条她的表情，新的在后. */
  recent: ExprId[];
  /** 上一次表情变化的时刻（ms）. */
  lastAt: number;
  now: number;
  level: Level;
  /** 'crisis' → 恒 gentle（D18）；其余是消息种类（reply / plan / summary / note / error / approval / question…）. */
  kind: string;
}

/** grumpy 官方图标是明确的怒眉（比「别扭」重），默认不启用，缺省退 confused（D9）. 要启用只改这里. */
export const GRUMPY_ENABLED = false;
/** 连续相同表情的上限. */
export const RUN_CAP: Record<ExprId, number> = { gentle: 5, relaxed: 3, shy: 3, surprised: 3, confused: 3, grumpy: 3 };
/** 表情复位（显示层用）：停留至少 4 秒不换；之后过 2 条消息或 3 分钟回到 gentle. */
export const EXPR_RESET = { holdMs: 4000, messages: 2, ms: 3 * 60_000 } as const;

const HARD_GENTLE_KINDS = new Set(['error', 'approval']);
const HARD_GENTLE_EVENTS = new Set(['approval', 'irreversible', 'apology', 'fail']);
const EVENT_EXPR: Record<string, ExprId> = {
  question: 'confused', retry: 'confused', 'fail-ext': 'confused',
  done: 'relaxed', joy: 'relaxed',
  praised: 'shy', nickname: 'shy',
  late: 'surprised', fast: 'surprised', interrupted: 'surprised',
  'plan-ready': 'gentle', 'plan-approved': 'gentle', cancelled: 'gentle', 'plan-cancelled': 'gentle',
};
const KIND_EXPR: Record<string, ExprId> = { question: 'confused', plan: 'gentle' };
/** 连续超限时换哪个：相邻语义. */
const ADJACENT: Record<ExprId, ExprId> = { gentle: 'relaxed', relaxed: 'gentle', shy: 'relaxed', surprised: 'gentle', confused: 'gentle', grumpy: 'confused' };

/** 她正文头 12 字里的关键词（§3.4-2）. 先看「道歉」类，免得「不好意思」把抱歉读成害羞. */
function headExpr(head: string): ExprId | undefined {
  if (/抱歉|对不起/.test(head)) return undefined;
  if (/(^|[，。…、\s])呼($|[，。…、\s])|太好了/.test(head)) return 'relaxed';   // 「呼」要单独成词，不然「称呼」「招呼」也算
  if (/诶|咦|真的吗/.test(head)) return 'surprised';
  if (/唔|不好意思/.test(head)) return 'shy';
  if (/我要想一想|不太明白/.test(head)) return 'confused';
  return undefined;
}
/** 用户上一句：夸她、叫昵称 → 害羞. */
const PRAISE = /厉害|真棒|好棒|聪明|可爱|温柔|漂亮|阿蝶|蝶宝|小蝶/;

function keywordExpr(c: SettleCtx): ExprId | undefined {
  const head = Array.from((c.text ?? '').trim()).slice(0, 12).join('');
  return headExpr(head) ?? (c.userText && PRAISE.test(c.userText) ? 'shy' : undefined);
}

function limitRun(pick: ExprId, c: SettleCtx): ExprId {
  const recent = c.now - c.lastAt >= EXPR_RESET.ms ? [] : c.recent;
  let run = 0;
  for (let i = recent.length - 1; i >= 0 && recent[i] === pick; i--) run += 1;
  return run >= RUN_CAP[pick] ? ADJACENT[pick] : pick;
}

export function settleExpr(c: SettleCtx): ExprId {
  if (c.kind === 'crisis') return 'gentle';
  if (HARD_GENTLE_KINDS.has(c.kind) || (c.event !== undefined && HARD_GENTLE_EVENTS.has(c.event))) return 'gentle';
  let pick: ExprId | undefined = (c.event !== undefined ? EVENT_EXPR[c.event] : undefined) ?? KIND_EXPR[c.kind];
  if (!pick && c.candidate && isExprId(c.candidate)) pick = c.candidate;
  if (!pick) pick = keywordExpr(c);
  if (!pick) pick = 'gentle';
  if (pick === 'grumpy' && !(GRUMPY_ENABLED && c.level === 'l' && c.kind !== 'reply')) pick = 'confused';
  return limitRun(pick, c);
}

/** 显示层的复位：一个非 gentle 的表情停留够久（≥4 秒）后，再过 2 条消息或 3 分钟回到 gentle. 纯函数，给右栏 / 头部徽章用；
 *  消息自己的 expr 不改（旧消息渲染固定读 Message.expr）. */
export function restingExpr(expr: ExprId, o: { ageMs: number; later: number }): ExprId {
  if (expr === 'gentle' || o.ageMs < EXPR_RESET.holdMs) return expr;
  return o.later >= EXPR_RESET.messages || o.ageMs >= EXPR_RESET.ms ? 'gentle' : expr;
}

/** 带贴纸的那条消息头像保持 gentle、不画角标（D19）. */
export const exprWithSticker = (expr: ExprId, hasSticker: boolean): ExprId => (hasSticker ? 'gentle' : expr);

/** 名牌旁的神色词所需的上下文；每个词必须对应真实事件（I-10）. */
export interface MoodWordCtx {
  surface: 'chat' | 'work' | 'agents';
  /** chat */
  streaming?: boolean;
  thinking?: boolean;
  /** 空闲时的小状态（persona.mood 的结果），没有则「在线」. */
  idleMood?: string;
  /** work */
  phase?: 'planning' | 'running' | 'retry' | 'awaiting' | 'summary' | 'failed' | 'laiddown' | 'done' | 'idle';
  /** 危机回合（Message.crisis）或危机当天：名牌旁恒为「在听」，不回退到 idleMood 的活动词（在读书……）. 调用方一律用 selectors 的 useHerCrisis 取（D18）. */
  crisis?: boolean;
  /** agents */
  agents?: 'leading' | 'present' | 'idle' | 'running' | 'off';
  /** 编排者此刻的出场方式（selectors 的 selectOrchestratorPresence 给）：同一运行里页头胶囊（agents）、右栏名牌（work.running）、右栏 Agent 行读同一个词.
   *  watching = 运行中、别的 Agent 在做、她自己没在执行步骤 →「在旁看着」；stepIndex = 她接手执行的那一步（0 起）→「在做 · 第 N 步」. */
  watching?: boolean;
  stepIndex?: number;
}

/** 编排者（遐蝶）在一次运行里的唯一状态词. 页头神色词、右栏名牌下的状态词、右栏「活跃 Agent」里她那一行、Agent 页缎带都以它为准，
 *  同一状态下不会出现「在场 / 在做 / 空闲 · 待命」几种说法. 没有运行时不走这里（用闲时词）. */
export const WATCHING_WORD = '在旁看着';
export function orchestratorWord(o: { watching?: boolean; stepIndex?: number }): string {
  if (o.watching) return WATCHING_WORD;
  return o.stepIndex !== undefined ? `在做 · 第 ${o.stepIndex + 1} 步` : '在做';
}

/** 危机回合 / 危机当天她的神色词（第 1 轮评审：用户说不想活了，她旁边不能写「在读书」）. */
export const CRISIS_WORD = '在听';

/** 卡外她那一句所属场景 → 神色词（第 2 轮评审：胶囊写神色 / 状态，不写情绪；「抱歉」是情绪词，改「在收拾」）.
 *  待批 / 待答 = 停在这一步；done.* = 在收尾；fail.* = 在收拾；放下（laid.down / stop.w）= 停在这里；其余场景不写词.
 *  HerLead 的胶囊与右栏「此刻」共用这一张表，不各写各的. */
export function sceneMoodWord(scene: string | undefined): { word: string; dot?: 'work' | 'wait' } | undefined {
  if (!scene) return undefined;
  if (/^(approve\.(ask|high)|question)(\.|$)/.test(scene)) return { word: '停在这一步', dot: 'wait' };
  if (/^done(\.|$)/.test(scene)) return { word: '在收尾' };
  if (/^fail(\.|$)/.test(scene)) return { word: '在收拾' };
  if (/^(laid\.down|stop\.w)(\.|$)/.test(scene)) return { word: '停在这里' };
  return undefined;
}

/** 返回 undefined = 名牌旁不画神色词：工作已完成（done）时状态字已经写了「已完成」，不再叠一个词. */
export function moodWord(c: MoodWordCtx): string | undefined {
  // 闲聊：危机时恒「在听」；工作：只在没有真实阶段可写时（空闲）换成「在听」，在做 / 待批 / 抱歉这些阶段词是事实，照写.
  if (c.crisis && (c.surface === 'chat' || (c.surface === 'work' && (c.phase === undefined || c.phase === 'idle')))) return CRISIS_WORD;
  if (c.surface === 'chat') return c.streaming ? '在写' : c.thinking ? '在想' : c.idleMood || '在线';
  if (c.surface === 'work') {
    switch (c.phase) {
      case 'planning': return '在写计划';
      case 'running': return orchestratorWord(c);
      case 'retry': return '在重试';
      case 'awaiting': return '停在这一步';
      case 'summary': return '在收尾';
      case 'failed': return '在收拾';
      case 'laiddown': return '停在这里';
      case 'done': return undefined;
      default: return c.idleMood || '在线';
    }
  }
  switch (c.agents) {
    case 'leading': return orchestratorWord({ stepIndex: c.stepIndex });
    case 'present': return WATCHING_WORD;
    case 'running': return '运行中';
    case 'off': return '歇着';
    default: return '空闲';
  }
}
