/* 落蝶判据（施工图 §4.4，V2）：用户这句是不是「收尾的一句」（谢谢 / 收到 / 好的……），是就不调模型，只给这条用户消息一只落蝶.
   纯函数；调用点在 E 的 backend.sendMessage 与 reply() 末尾「回复期间到达的用户消息再回复」的检查.

   判据（全部满足才命中）：
     1. 去标点后 ≤6 字，且是闭合语. 强闭合语（谢谢 / 辛苦了 / 收到 / 知道了 / 明白了 / 晚安）——她上一条是陈述句即可；
        弱闭合语（好 / 嗯 / 行 / 好的 / 可以 / ok）常常是在同意一个提议，只在她上一条是事件类末句时才算（src.scene ∈ done.* / return.* / leave.* / nudge.rest / notify.* / chat.thanks）.
     2. 她的上一条不含问句词与邀请词（中文请求常无问号，所以不能只看问号）.
        「告诉我」前面有条件（有想改的地方，直接告诉我 / 若…告诉我）是完成类话尾常见的软邀请，不当作邀请词——
        否则「完成之后答谢谢」这条核心用法一个都命中不了.
     3. 她的上一条不带胶囊，且不是 plan / approval / question 相关，当前无待答问题 / 待批审批 / 待批计划，不是工作进行中的追加，上一回合不是 crisis.
   没有她的上一条 → 不命中（没有可收尾的话）. 用户这句带问号 → 不命中. */
import type { Message } from './types';

export interface ClosureCtx {
  /** 她的上一条消息. */
  prev?: Pick<Message, 'text' | 'kind' | 'src' | 'crisis'>;
  /** 她的上一条是否带胶囊. */
  hadPills?: boolean;
  /** 当前是否有待答问题 / 待批审批 / 待批计划. */
  pending?: boolean;
  /** 是否是工作进行中的追加. */
  runningAppend?: boolean;
}

/** 强闭合语的核心词（用户整句 = 若干核心词 + 语气 / 应答填充字）.
 *  「辛苦」「了解」不能裸着当核心词：「好辛苦」「真辛苦」是在说自己的状态，「你了解」是在问她，都该得到回应；只认「辛苦了」「了解了」这类已经收尾的说法. */
const STRONG_CORES = ['谢谢', '多谢', '感谢', '谢了', '辛苦了', '辛苦啦', '辛苦你了', '辛苦您了', '收到', '知道了', '明白了', '了解了', '了解啦', '晚安'];
/** 可以出现在核心词前后的填充字（嗯 / 你 / 啦 / 呀…）. 程度副词（太 / 真 / 多 / 好）不在其内：「太辛苦了」是在说自己；句首的「好 / 好的」单独处理. */
const FILLER = new Set(Array.from('的嗯哦噢啊呀啦哈哒嘞你您了'));
/** 弱闭合语（整句，已去掉句尾语气字）. */
const WEAK = new Set(['好', '好的', '嗯', '嗯嗯', '行', '可以', 'ok', 'okay', 'k']);
/** 句尾语气字（弱闭合语判断前去掉：好哒 / 好呀 / 行啦）. */
const TAIL_PARTICLES = /[啦呀哦噢啊哈哒嘞]+$/;

/** 她的上一条是事件类末句的场景（弱闭合语只在这些之后才算）. */
const EVENT_SCENE = /^(done|return|leave|notify|chat\.thanks|nudge\.rest)(\.|$)/;
/** 她的上一条是 plan / approval / question 相关的场景. */
const BLOCK_SCENE = /^(plan|approve|question|task\.start|phase)(\.|$)/;

const PUNCT = /[\s\p{P}\p{S}　]|\p{Extended_Pictographic}/gu;

/** 去标点与空白、转小写. */
export const normalizeClosure = (text: string): string => text.replace(PUNCT, '').toLowerCase();

/** 她的上一条里的问句词 / 邀请词. 导出给测试与调用方对表. */
export function hasInvite(text: string): boolean {
  if (/[？?]/.test(text)) return true;
  if (/吗|呢|可以吗|要不要|需要我|请告诉|请选|回我一声/.test(text)) return true;
  if (/吧[。.!！]?\s*$/.test(text.trim())) return true;                       // 「…吧。」收尾 = 提议
  if (/想[^。！？\n]{0,12}就/.test(text)) return true;                          // 想…就…
  if (/若[^。！？\n]{0,16}愿意|愿意/.test(text)) return true;                  // 若…愿意
  if (/哪(一)?(件|个|边|种)|还是/.test(text)) return true;                     // 二选一 / 选哪个
  // 「告诉我」：前面有条件从句（有…的话 / 若 / 如果 / 直接 / 哪里不对…）是软邀请，不算
  for (const m of text.matchAll(/告诉我/g)) {
    const before = text.slice(Math.max(0, text.lastIndexOf('。', m.index) + 1), m.index);
    if (!/(有|若|如果|倘若|哪里|直接|随时|别客气|不对)/.test(before)) return true;
  }
  return false;
}

function strongClosure(n: string): boolean {
  if (!STRONG_CORES.some((c) => n.includes(c))) return false;
  let rest = n.replace(/^好的?/, '');                                         // 句首的「好 / 好的」是应答（好的，谢谢）；别处的「好」是程度副词
  for (const c of [...STRONG_CORES].sort((a, b) => b.length - a.length)) rest = rest.split(c).join('');
  return Array.from(rest).every((ch) => FILLER.has(ch));
}

export function isClosure(text: string, ctx: ClosureCtx): boolean {
  const prev = ctx.prev;
  if (!prev || !prev.text) return false;
  if (ctx.pending || ctx.runningAppend || ctx.hadPills || prev.crisis) return false;
  if (prev.kind === 'plan' || prev.kind === 'error') return false;
  const scene = prev.src?.scene;
  if (scene && BLOCK_SCENE.test(scene)) return false;
  if (text.length > 24 || /[？?]/.test(text)) return false;
  const n = normalizeClosure(text);
  if (!n || Array.from(n).length > 6) return false;
  if (hasInvite(prev.text)) return false;
  if (strongClosure(n)) return true;
  const weak = n.replace(TAIL_PARTICLES, '');
  return WEAK.has(weak) && !!scene && EVENT_SCENE.test(scene);
}
