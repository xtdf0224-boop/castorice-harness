/* 对话里「她的话层」的纯判断（不碰 DOM、不读 store；check:ui-chat 与 Conversation 共用）.
   · 谁算「她」：编排 Agent 的消息，且说话时角色口吻是开的（Message.persona 有值）. 口吻关着时说的话、子 Agent 的话都是内容层语气（D5）.
   · 卡外那一句（HerLead）：note 且出处场景是 approve / question / fail / done / stop / interrupt 之一.
   · 系统行 / 胶囊 / 贴纸的出现条件都写在这里，只读 Message 自带的字段（旧消息没有这些字段，所以旧消息一律不出）. */
import type { Approval, Message, StickerId } from '../../lib/types';
import { isStickerId } from '../../lib/expr';
import { relative } from '../../lib/format';
import { sceneMoodWord } from '../../lib/mood';
import type { PillCtx } from '../../lib/pills';

/** 她一句话的出处场景名：优先 src.scene；没有就从 src.id（`场景.模式.档[.条件][.n|.d]`）里剥. */
export function sceneOf(m: Pick<Message, 'src'>): string {
  const s = m.src;
  if (!s) return '';
  if (s.scene) return s.scene;
  const hit = /^(.*?)\.(c|w|a)\.(s|m|l)(\.|$)/.exec(s.id);
  return hit ? hit[1] : s.id;
}

export const isHerMessage = (m: Message): boolean => m.role === 'agent' && (!m.agentId || m.agentId === 'orchestrator') && !!m.persona;

const LEAD_SCENE = /^(approve|question|fail|done|stop|interrupt)(\.|$)/;
/** 卡外那一句：她的一句 note，渲染为 HerLead（40 px 头像 + 名牌 + 气泡）. */
export const isLeadNote = (m: Message): boolean => isHerMessage(m) && m.kind === 'note' && LEAD_SCENE.test(sceneOf(m));

/** 报错卡本体：只放失败事实，无头像无贴纸（D-01）. */
export const isErrorCard = (m: Message): boolean => m.role === 'agent' && m.kind === 'error';

export type SysKind = 'rest' | 'late' | 'nudge';
/** 这条话前面要不要出系统行（I-27：系统行在前，她的话在后），以及是哪一种.
 *  · sys.rest / sys.late 是休息关照降级成的系统行（role:'system'，她没有开口）：先匹配，不能落到 proactive 兜底里被当成「她主动开口」.
 *  · greet.* 是每日问候（proactive:true），不是搭话：没有系统行（greet.late 例外，仍按「夜深」写）.
 *  · m.proactive 的兜底只给没有出处场景的话（模型自己想的话题，live 不写 src）. */
export function sysKindOf(m: Message): SysKind | undefined {
  const sc = sceneOf(m);
  if (sc === 'sys.rest' || sc === 'nudge.rest' || sc.startsWith('rest.')) return 'rest';
  if (sc === 'sys.late' || sc === 'greet.late' || sc.startsWith('late.')) return 'late';
  if (sc.startsWith('greet.')) return undefined;
  if (sc.startsWith('nudge.')) return 'nudge';
  return !m.src && m.proactive ? 'nudge' : undefined;
}

/** 胶囊出现在哪一类话之后（pills.ts 的 PillCtx.after）. */
export function pillAfterOf(m: Message): PillCtx['after'] {
  // 每日问候（greet.am / noon / eve / away / first）之后不出胶囊；sys.rest 这类系统行不是她的话，也不走这里.
  const sc = sceneOf(m);
  if (sc.startsWith('greet.') && sc !== 'greet.late') return 'other';
  const k = sysKindOf(m);
  if (k) return k;
  return sc.startsWith('world.') ? 'small' : 'other';
}

const STICKER_KINDS: ReadonlySet<string | undefined> = new Set([undefined, 'reply', 'note', 'summary']);
/** 这条话画不画贴纸：消息自带的建议（Message.react，已由 decideSticker 采纳）+ 渲染时的硬禁区兜底（§3.5 永不出现）. */
export function stickerOf(m: Message, on: boolean): StickerId | undefined {
  if (!on || !isStickerId(m.react) || !isHerMessage(m)) return undefined;
  if (m.crisis || m.proactive || m.streaming || !m.text) return undefined;
  if (!STICKER_KINDS.has(m.kind) || isLeadNote(m)) return undefined;
  const sc = sceneOf(m);
  if (/^(approve|question|fail|plan|stop|interrupt)(\.|$)/.test(sc)) return undefined;
  return m.react;
}

const BLOCK_START = /^\s*(?:[-*+>#|]|\d+[.)])\s?/m;
/** 闲聊里她一条话里的空行分段 → 多个气泡（间距 6）. 只在纯文字时拆：有围栏代码 / 列表 / 标题 / 引用 / 表格就整条一个气泡；最多 3 个. */
export function splitBubbles(text: string, max = 3): string[] {
  const t = text.trim();
  if (!t || t.includes('```') || BLOCK_START.test(t)) return [text];
  const parts = t.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) return [text];
  if (parts.length <= max) return parts;
  return [...parts.slice(0, max - 1), parts.slice(max - 1).join('\n\n')];
}

/** 连续消息合并头像（§4.4）：同一说话人、同一 runId、间隔 <3 分钟、中间无 call / divider / system、前一条不是 error. */
export function shouldMerge(prev: Message | undefined, cur: Message): boolean {
  if (!prev || prev.role !== 'agent' || cur.role !== 'agent') return false;
  if (prev.kind === 'error' || cur.kind === 'error') return false;
  if (prev.agentId !== cur.agentId || prev.runId !== cur.runId) return false;
  if (!!prev.persona !== !!cur.persona) return false;
  if (cur.at - prev.at >= 180_000 || cur.at < prev.at) return false;
  if (isLeadNote(prev) || isLeadNote(cur)) return false;
  // 带系统行（主动话 / 休息关照）的话要自己露头像，免得系统行下面是空的.
  return !sysKindOf(cur);
}

/** 让她换个说法的入口只给：reply / plan 引言 / note（编排的旁白）/ summary，且不含围栏代码块；流式中、危机回合没有（§3.7）. */
export function canRewriteHer(m: Message): boolean {
  if (!isHerMessage(m) || m.streaming || m.crisis || !m.text.trim()) return false;
  if (m.kind && !['reply', 'plan', 'note', 'summary'].includes(m.kind)) return false;
  return !m.text.includes('```');
}

/** 折叠态那一行：取第一句的前 40 字. */
export function foldLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > 40 ? `${chars.slice(0, 40).join('')}……` : flat;
}

/* ───── 审批的标签：说的是「这一次要做的事」，不是工具类别 ─────
   施工图 D1：待批的标签统一为「待批 · 须亲批」，只有能判定取不回来的才写「须亲批 · 不可逆」. 工具定义的 risk 是类别（shell 一律 high），
   `ls`、`git status` 也是 shell，不能因此就断言「不可逆」；反过来 git（medium）的 `push --force` 才是真取不回来. */
const IRREVERSIBLE_CMD: readonly RegExp[] = [
  /(?:^|[\s;&|(`])(?<!\b(?:git|npm|pnpm|yarn)\s)(?:rm|rmdir|rd|del|erase|shred|unlink)(?=\s)/i,   // 删除（含 cmd 的 del / rd；git rm / npm rm 能找回，不算）
  /\bremove-item\b/i,
  /\bgit\s+(?:-\S+\s+)*push\b[^;&|\n]*?(?:\s--force(?:-with-lease)?\b|\s-[a-z]*f[a-z]*\b|\s\+\S)/i, // push --force / -f / +ref
  /\bgit\s+(?:-\S+\s+)*reset\b[^;&|\n]*\s--hard\b/i,
  /\bgit\s+(?:-\S+\s+)*clean\b[^;&|\n]*\s-[a-z]*f/i,
  /\bgit\s+(?:-\S+\s+)*branch\b[^;&|\n]*\s-D\b/,
  /\bgit\s+(?:-\S+\s+)*stash\s+(?:drop|clear)\b/i,
  /\bdrop\s+(?:table|database|schema)\b/i,
  /\btruncate\s+(?:-s\s*\S+\s+|table\b)/i,
  /\b(?:mkfs(?:\.\w+)?|format-volume|diskpart)\b/i,
  /\bdd\s+[^;&|\n]*\bof=/i,
];
/** 这一次审批要做的事能不能判定为「做了就取不回来」. 只看命令类预览（diff 是改文件，请求是外部调用，都不下这个断言）. */
export function isIrreversible(a: Pick<Approval, 'previewKind' | 'preview'>): boolean {
  return a.previewKind === 'command' && IRREVERSIBLE_CMD.some((re) => re.test(a.preview));
}
/** 审批卡 / 归来笺上待批的标签：不可逆（能判定的）→「须亲批 · 不可逆」；其余高风险 →「待批 · 须亲批」；其余 →「待批」. */
export function approvalTagText(a: Pick<Approval, 'risk' | 'previewKind' | 'preview'>): string {
  if (isIrreversible(a)) return '须亲批 · 不可逆';
  return a.risk === 'high' ? '待批 · 须亲批' : '待批';
}

/** 某次运行里 E 已经写进对话流的「卡外那一句」（场景以 prefix 开头，如 'done' / 'fail'；或精确匹配 exact 里的某个场景名）；最近的一条.
 *  minAt：只认不早于它的（审批 / 提问的话要对应此刻待批的那一项，不是上一次的）. */
export function leadMsgOf(
  messages: readonly Message[] | undefined, runId: string | undefined, prefix: string | readonly string[], minAt = -Infinity,
): Message | undefined {
  if (!messages || !runId) return undefined;
  const exact = typeof prefix === 'string' ? undefined : prefix;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.runId !== runId || !isLeadNote(m) || !m.text.trim() || m.at < minAt) continue;
    const sc = sceneOf(m);
    if (exact ? exact.includes(sc) : sc.startsWith(`${prefix as string}.`)) return m;
  }
  return undefined;
}

/** 某次运行里 E 已经写进对话流的「卡外那一句」的正文. 没有就返回 undefined（调用方再自己查台词库）. */
export function leadTextOf(messages: readonly Message[] | undefined, runId: string | undefined, prefix: string): string | undefined {
  return leadMsgOf(messages, runId, prefix)?.text.trim();
}

/** E 写那句话与建审批 / 提问卡的先后差几秒都算同一次（毫秒）. */
export const NOTE_SLACK = 30_000;

/** 待批的那句话（approve.ask / approve.high）与待答的那句话（question.w）所属的场景名. */
export const APPROVE_SCENES = ['approve.ask', 'approve.high'] as const;
export const QUESTION_SCENES = ['question.w'] as const;

/** 卡外那一句旁边的神色词：词表在 lib/mood.ts 的 sceneMoodWord（待批 / 待答 = 停在这一步，done = 在收尾，失败 = 在收拾，放下 = 停在这里）. */
export const leadWordOf = sceneMoodWord;

/** 卡片右上的相对时间（审批卡、提问卡）：一小时内向下取整到分钟，和左栏「最久 N 分」（queueSplit 的 waitText，floor）同一个取整，
 *  不再出现左栏 2 分、卡上 1 分钟前 / 3 分钟前这种对不上（第 4 轮）；不到 1 分钟写「刚刚」，超过一小时照旧交给 relative. */
export function agoOf(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  return relative(at, now);
}

/** 消息时间：HH:mm（完整时间放进 title 悬停）. */
export function hhmm(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
}
export function fullTime(at: number): string {
  return new Date(at).toLocaleString('zh-CN', { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}
