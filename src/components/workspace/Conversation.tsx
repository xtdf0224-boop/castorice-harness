/* 对话, laid out the way chat harnesses do it (Claude / ChatGPT / DeepSeek / Cyrene):
   - 闲聊: one centered column; your messages are bubbles on the right, hers are plain text with her
     name on top, a folded 思考过程 when the model shares one, and 复制 / 重新生成 under the reply.
   - 工作: messages grouped by run with the agents' tool calls threaded in between, in time order.
   The message box is docked at the bottom; while she is writing, its button stops the reply.

   长会话保护（V0α · K08）：
   - AppState 里只有每个任务的尾部消息（启动时 12–80 条，见 persist.ts）；更早的消息向上滚动时分页从存储取（每页 60 条，
     连同夹在其间的工具调用），只放在这个组件自己的状态里——不进 AppState、也不会被当成新消息写回库。
   - 分段渲染：整段对话是一个变高度的行列表，只挂载可见窗口附近的行（上下各留一屏），窗口外用估算/量过的高度占位；
     挂载的行数与会话长度无关。向上翻页后按行高模型修正滚动位置，视线不跳。
   - 工具输出折叠：>5 KB 的输出只显示摘要，点开再向存储取全文；输出只在展开后才画。
   - 超过 2 万字的单条消息先画前 2 万字，点「展开剩余」再画全部。
   预算（10,000 条消息、30% 的调用带 >5 KB 输出）：首屏数据 = 80 条消息 + 当前运行的调用摘要；渲染进程只持有
   尾部 + 滚动过的页，不随历史长度增长。

   她的话层（AGENT-VOICE-PLAN §3.1、§4.4、§4.7；样稿 C 为底，借 B 的剧情框与胶囊、借 A 的连续消息合并头像与换说法）：
   - 她（编排 Agent，说话时角色口吻是开的）的话 = 头像（闲聊 56、工作旁白 40，带 136² 表情角标）+ 名牌 + 神色词 + 气泡，容器带 data-her；
     子 Agent 的话是内容层语气：命途图标 + 名字，无头像无表情（D5）；报错卡 / 卡外那一句 / 系统行各自成型.
   - 旧消息没有 expr：固定 gentle、不画角标；带贴纸的消息不画角标、头像保持 gentle（D19）；危机回合（crisis）没有贴纸、角标、胶囊、换说法.
   - 「她退半步」只在根节点打 data-retreat，头像 / 角标 / 贴纸由 CSS 只做 opacity 过渡并保留占位（不改行高，也不让 memo 的整列表重渲）.
   - MessageRow 是 memo：只有「最后一条她的话」收到神色词 / 外环 / 胶囊这几个会变的 props，其余行的 props 恒定. */
import { ArrowDown, Brain, ChevronDown, CircleCheck, ListChecks, Loader, OctagonX, Reply, StickyNote, type LucideIcon } from 'lucide-react';
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react';
import { desktop } from '../../lib/desktop';
import { duration, timeOfDay } from '../../lib/format';
import { useSay2 } from '../../lib/voice';
import { useNow, useReducedMotion } from '../../lib/hooks';
import { mood, PERSONA } from '../../lib/persona';
import { moodWord } from '../../lib/mood';
import { pillsFor, type Pill } from '../../lib/pills';
import { isOpenRun, TOOL_STATUS } from '../../lib/status';
import { callsInRange, pageMessages, pagingOf, storeAvailable } from '../../lib/storeBridge';
import type { Agent, AppState, ExprId, Message, ToolCall } from '../../lib/types';
import { actions } from '../../state/actions';
import { reply, stopReply } from '../../state/live';
import { engineFromChoice } from '../../state/models';
import { useHerCrisis, useRetreat, useVoice } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { ToolOutputPre } from '../console/ToolOutput';
import { Button, EngineTag, cx } from '../ui';
import { AgentMark } from '../her/AgentMark';
import { ButterflyMark } from '../her/ButterflyMark';
import { HerAvatar } from '../her/HerAvatar';
import { HerLead } from '../her/HerLead';
import {
  APPROVE_SCENES, foldLine, fullTime, hhmm, isErrorCard, isHerMessage, isLeadNote, leadMsgOf, leadWordOf, NOTE_SLACK, pillAfterOf, QUESTION_SCENES, sceneOf,
  shouldMerge, splitBubbles, stickerOf, sysKindOf,
} from '../her/logic';
import { NamePlate } from '../her/NamePlate';
import { Pills } from '../her/Pills';
import { StickerImg } from '../her/StickerImg';
import { guardTail } from '../her/Tail';
import { StoryBox } from '../her/StoryBox';
import { SysLine } from '../her/SysLine';
import '../../styles/her.css';
import '../../styles/store-long.css';
import { Markdown } from './Markdown';
import { HerActions, UserActions, type RewriteMode } from './MessageActions';
import { ModelChips, type ModelPick } from './ModelChips';
import { ModelNotice } from './ModelNotice';
import { TaskPermissionChip } from '../views/tasks/PermissionChip';
import { PromptBox } from './PromptBox';
import { useFocusRequest, useTaskEngine } from './shared';

const NO_MESSAGES: Message[] = [];
const NO_RUNS: string[] = [];
const NO_CALLS: ToolCall[] = [];
const NO_PILLS: readonly Pill[] = [];

const KIND: Record<NonNullable<Message['kind']>, { label: string; icon: LucideIcon; tone: 'neutral' | 'info' | 'success' | 'danger' }> = {
  plan: { label: '计划', icon: ListChecks, tone: 'info' },
  note: { label: '备注', icon: StickyNote, tone: 'neutral' },
  summary: { label: '总结', icon: CircleCheck, tone: 'success' },
  error: { label: '错误', icon: OctagonX, tone: 'danger' },
  reply: { label: '回复', icon: Reply, tone: 'neutral' },
};

/** 向上翻页每页多少条消息. */
const PAGE = 60;
/** 单条消息先画多少字. */
const LONG_MSG = 20_000;
/** 吸顶名牌条的高度（对话区上沿往下；头像 40 + 内边距 4 + 下沿 4）：不透明实底，内容从它下面自然滑过去，被它的下沿干净地切开. */
const HEAD_H = 48;
/** 本组最后一个元素的下沿高过名牌下沿多少 px 以内就退场（让下一组自己的名牌自然出现）. */
const HEAD_LEAVE = 24;

type Item = { t: 'msg'; id: string; at: number; m: Message } | { t: 'call'; id: string; at: number; c: ToolCall };
type Row =
  | { key: string; est: number; kind: 'divider'; runId: string; attempt: number; startedAt: number }
  | { key: string; est: number; kind: 'msg'; m: Message; cont: boolean; /** 下一条合并进了它（同一说话人连发）：行间距收到 6px，操作行不再占一行高. */ joined?: boolean;
      /** 这一行是一组连发的组头，且后面还合并了别的：组内最新的那一条（组头的状态点 / 类型签 / 外环取自它，而不是组头自己那条）. */ last?: Message }
  | { key: string; est: number; kind: 'call'; c: ToolCall };

export interface ConversationProps {
  taskId: string;
  /** The run being viewed (highlighted divider). */
  runId?: string;
  /** The latest run (the typing row follows it while it is running). */
  latestId?: string;
  /** The tab is showing. The panel stays mounted when hidden so the draft and scroll position survive. */
  active: boolean;
  /** 闲聊 layout. */
  chat?: boolean;
}

/** All tool calls of the task's runs that are in memory, oldest first (work tasks only). */
function selectCalls(taskId: string, chat?: boolean) {
  return (s: AppState) => {
    if (chat) return NO_CALLS;
    const t = s.tasks[taskId];
    if (!t) return NO_CALLS;
    const out: ToolCall[] = [];
    for (const id of t.runIds) for (const c of s.runs[id]?.toolCalls ?? NO_CALLS) out.push(c);
    return out.length ? out : NO_CALLS;
  };
}

/* ───────────── 行：排序、合并、估高 ───────────── */

const byTime = (a: Item, b: Item) => a.at - b.at || (a.t === b.t ? 0 : a.t === 'msg' ? -1 : 1);
/** 两个各自有序的列表合并（线性）. */
function mergeSorted(a: Item[], b: Item[]): Item[] {
  if (!a.length) return b;
  if (!b.length) return a;
  const out: Item[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) out.push(byTime(a[i], b[j]) <= 0 ? a[i++] : b[j++]);
  while (i < a.length) out.push(a[i++]);
  while (j < b.length) out.push(b[j++]);
  return out;
}

/** 没量过的行先用估算高度（含行间距）：按文字长度粗估. */
function estimate(it: Item, cont = false): number {
  if (it.t === 'call') return 44;
  const m = it.m;
  if (m.role === 'system') return 40;
  const len = m.text.length + (m.thinking ? 40 : 0);
  if (m.role === 'user') return Math.min(900, 64 + 22 * Math.ceil(len / 48) + (m.reaction === 'landing' ? 30 : 0));
  if (isLeadNote(m)) return 96;
  // 她的话：合并头像的后续行没有名行（−30），带贴纸 +110，带系统行 +34.
  return Math.min(1400, 84 - (cont ? 30 : 0) + 24 * Math.ceil(len / 70) + (m.react ? 110 : 0) + (sysKindOf(m) ? 34 : 0));
}

/* ───────────── 行高测量 ───────────── */

interface SlotApi {
  observe(el: HTMLElement): void;
  unobserve(el: HTMLElement): void;
}
const SlotCtx = createContext<SlotApi | null>(null);

/** 一行的外壳：量自己的高度（含下面的行间距）并报告. */
function Slot({ k, children }: { k: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const api = useContext(SlotCtx);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !api) return;
    api.observe(el);
    return () => api.unobserve(el);
  }, [api]);
  return <div ref={ref} className="cv-row" data-k={k}>{children}</div>;
}

/** 二分：第一个满足 pred 的下标（pred 单调）。 */
function firstWhere(n: number, pred: (i: number) => boolean) {
  let lo = 0, hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (pred(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

interface Older { messages: Message[]; calls: ToolCall[]; more?: boolean; cursor?: number; loading: boolean; failed?: boolean }
const OLDER0: Older = { messages: NO_MESSAGES, calls: NO_CALLS, loading: false };

/** 每个任务一份独立状态（换任务整个重来）. */
export function Conversation(props: ConversationProps) {
  return <ConversationBody key={props.taskId} {...props} />;
}

function ConversationBody({ taskId, runId, latestId, active, chat }: ConversationProps) {
  const messages = useApp((s) => s.tasks[taskId]?.messages ?? NO_MESSAGES);
  const callsSel = useMemo(() => selectCalls(taskId, chat), [taskId, chat]);
  const calls = useApp(callsSel, shallow);
  const agents = useApp((s) => s.agents);
  // "runId|attempt|startedAt" per run, so dividers can say "运行 #n · 14:02:11" without a render per tick.
  const runInfo = useApp((s) => s.tasks[taskId]?.runIds.map((id) => {
    const r = s.runs[id];
    return `${id}|${r?.attempt ?? 0}|${r?.startedAt ?? r?.createdAt ?? 0}`;
  }) ?? NO_RUNS, shallow);
  const live = useApp((s) => {
    const r = latestId ? s.runs[latestId] : undefined;
    return r && r.status === 'running' && r.live ? { agentId: r.live.agentId, text: r.live.text } : undefined;
  }, shallow);
  const reduced = useReducedMotion();
  // 工作页：RunCallout 已经在卡上方说出的那一句（失败 / 完成 / 待批 / 待答），对话流里不再说第二遍（按消息 id 让出）.
  const ownedKey = useApp((s) => {
    if (chat || !runId) return '';
    const r = s.runs[runId];
    const msgs = s.tasks[taskId]?.messages;
    if (!r || !msgs) return '';
    const ids: string[] = [];
    if (r.status === 'failed' && !r.laidDownAt) ids.push(leadMsgOf(msgs, runId, 'fail')?.id ?? '');
    else if (r.status === 'completed') ids.push(leadMsgOf(msgs, runId, 'done')?.id ?? '');
    else if (r.status === 'awaiting' || r.status === 'paused') {
      const pend = r.approvals.filter((a) => a.status === 'pending');
      if (pend.length) ids.push(leadMsgOf(msgs, runId, APPROVE_SCENES, pend[0].createdAt - NOTE_SLACK)?.id ?? '');
      const ask = r.status === 'awaiting' ? r.questions?.filter((q) => q.status === 'pending') : undefined;
      if (ask?.length) ids.push(leadMsgOf(msgs, runId, QUESTION_SCENES, ask[0].createdAt - NOTE_SLACK)?.id ?? '');
    }
    return ids.filter(Boolean).join('|');
  });
  const owned = useMemo(() => new Set(ownedKey ? ownedKey.split('|') : []), [ownedKey]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [away, setAway] = useState(false);

  const agentById = useMemo(() => new Map(agents.map((a) => [a.id, a])), [agents]);
  const runById = useMemo(() => new Map(runInfo.map((item) => {
    const [id, attempt, startedAt] = item.split('|');
    return [id, { attempt: Number(attempt), startedAt: Number(startedAt) }] as const;
  })), [runInfo]);

  const lastAgentId = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return undefined;
      if (messages[i].role === 'agent') return messages[i].id;
    }
    return undefined;
  }, [messages]);

  /* ── 更早的消息与调用（向上翻页），以及尾部时间段里属于「只读了摘要的运行」的调用 ── */
  const [older, setOlder] = useState<Older>(OLDER0);
  const olderRef = useRef(older);
  olderRef.current = older;
  const [range, setRange] = useState<ToolCall[]>(NO_CALLS);
  const firstAt = messages.length ? messages[0].at : undefined;

  useEffect(() => {
    if (chat || firstAt === undefined || !storeAvailable() || !pagingOf(taskId)) return;
    let alive = true;
    void callsInRange({ taskId, fromAt: firstAt }).then((r) => { if (alive && r.ok && r.calls.length) setRange(r.calls); });
    return () => { alive = false; };
  }, [taskId, chat, firstAt]);

  // 还有更早的消息没取回时，列表从已取回的最早一条消息开始：早于它的工具调用（比如读进来的整个运行）先不显示，
  // 等向上翻页翻到那个时间段再一起出现——这样「载入更早的消息」总是接在列表最上面，而不是插在中间.
  const hasMore = older.more ?? (() => { const p = pagingOf(taskId); return !!p && p.oldestSeq > 0 && p.loaded < p.total; })();
  const lowerAt = hasMore ? Math.min(older.messages.length ? older.messages[0].at : Infinity, messages.length ? messages[0].at : Infinity) : -Infinity;

  const items = useMemo(() => {
    const seen = new Set<string>();
    const base: Item[] = [];
    for (const m of messages) { seen.add(m.id); if (!owned.has(m.id)) base.push({ t: 'msg', id: m.id, at: m.at, m }); }
    const extra: Item[] = [];
    for (const m of older.messages) if (!seen.has(m.id)) { seen.add(m.id); extra.push({ t: 'msg', id: m.id, at: m.at, m }); }
    // 同一个调用可能同时在状态里和翻页/区间结果里：以状态里的为准（更新）.
    for (const c of calls) if (c.startedAt >= lowerAt && !seen.has(c.id)) { seen.add(c.id); base.push({ t: 'call', id: c.id, at: c.startedAt, c }); }
    for (const c of older.calls) if (c.startedAt >= lowerAt && !seen.has(c.id)) { seen.add(c.id); extra.push({ t: 'call', id: c.id, at: c.startedAt, c }); }
    for (const c of range) if (c.startedAt >= lowerAt && !seen.has(c.id)) { seen.add(c.id); extra.push({ t: 'call', id: c.id, at: c.startedAt, c }); }
    base.sort(byTime);
    return extra.length ? mergeSorted(extra.sort(byTime), base) : base;
  }, [messages, calls, older.messages, older.calls, range, lowerAt, owned]);

  // 剧情框（storyBox）：开着时，最后一条她的话在输入框上方以框呈现，不再占对话流里的一行；下一条用户消息发出后它回到流里成气泡.
  const voice = useVoice();
  const cfg = useApp((s) => ({
    stickers: s.settings.stickers !== false, stepBack: s.settings.stepBack !== false, storyBox: s.settings.storyBox ?? 'chat',
    memoryOn: !!s.settings.memoryOn, lifeMood: s.settings.lifeMood, mode: s.settings.mode, fold: !!s.tasks[taskId]?.foldHer,
  }), shallow);
  const [storyHidden, setStoryHidden] = useState<string | null>(null);
  // 她退半步：useRetreat 订阅输入法组合态（含窗口失焦清零）、并在 quietUntil 到点时自己翻回，不靠别的重渲带出来.
  const retreat = useRetreat(taskId);
  const retreated = cfg.stepBack && retreat.retreated;
  const storyMsg = useMemo(() => {
    const last = items[items.length - 1];
    if (!last || last.t !== 'msg' || last.id === storyHidden) return undefined;
    const on = cfg.storyBox === 'all' || (cfg.storyBox === 'chat' && !!chat);
    if (!on || retreated || !voice.persona) return undefined;
    const m = last.m;
    if (!isHerMessage(m) || m.crisis || isLeadNote(m) || isErrorCard(m) || m.proactive) return undefined;
    return chat || ['reply', 'plan', 'summary', 'note'].includes(m.kind ?? 'reply') ? m : undefined;
  }, [items, storyHidden, cfg.storyBox, chat, retreated, voice.persona]);
  const storyId = storyMsg?.id;
  // 「收起」按下去，整个剧情框（连同有焦点的那颗按钮）随即卸载，焦点会掉到 body；先把焦点交给输入框（composer 的现成通道）.
  const collapseStory = useCallback(() => {
    if (storyId) setStoryHidden(storyId);
    actions.requestFocus('composer');
  }, [storyId]);
  const storySticker = storyMsg ? stickerOf(storyMsg, cfg.stickers) : undefined;
  // 剧情框降级成气泡的那一刻：那条话以 200 ms 过渡回到对话流（只在降级后的这一次渲染里为真；减少动态时 CSS 直接换）.
  const lastStory = useRef<string | undefined>(undefined);
  const settling = lastStory.current && lastStory.current !== storyId ? lastStory.current : undefined;
  useEffect(() => { lastStory.current = storyId; });

  const rows = useMemo(() => {
    const out: Row[] = [];
    let prev: string | undefined | null = null;
    let prevMsg: Message | undefined;
    let head: Extract<Row, { kind: 'msg' }> | undefined;
    for (const it of items) {
      const rid = it.t === 'msg' ? it.m.runId : it.c.runId;
      if (prev === null || rid !== prev) {
        prev = rid;
        prevMsg = undefined;
        head = undefined;
        const info = rid ? runById.get(rid) : undefined;
        if (info && !chat) out.push({ key: `d:${rid}:${it.id}`, est: 48, kind: 'divider', runId: rid!, attempt: info.attempt, startedAt: info.startedAt });
      }
      if (it.t === 'msg') {
        if (it.id === storyId) continue;
        const cont = shouldMerge(prevMsg, it.m);
        if (cont) { const before = out[out.length - 1]; if (before?.kind === 'msg') before.joined = true; }
        prevMsg = it.m.role === 'agent' ? it.m : undefined;
        const row: Extract<Row, { kind: 'msg' }> = { key: it.id, est: estimate(it, cont), kind: 'msg', m: it.m, cont };
        if (cont && head) head.last = it.m; else head = row;
        out.push(row);
      } else {
        prevMsg = undefined;
        head = undefined;
        out.push({ key: it.id, est: estimate(it), kind: 'call', c: it.c });
      }
    }
    return out;
  }, [items, runById, chat, storyId]);
  /* ── 她此刻的状态：外环（D2，编码运行状态不编码表情）、神色词（每个词对应真实事件）、胶囊、换说法的入口 ── */
  const lastMsg = messages.length ? messages[messages.length - 1] : undefined;
  const lastHer = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (isHerMessage(messages[i]) && !isLeadNote(messages[i]) && !isErrorCard(messages[i])) return messages[i];
    return undefined;
  }, [messages]);
  const herCrisis = useHerCrisis(taskId) || !!lastHer?.crisis;
  const phase = useApp((s): 'planning' | 'running' | 'awaiting' | 'failed' | 'done' | 'idle' => {
    const r = latestId ? s.runs[latestId] : undefined;
    if (!r) return 'idle';
    if (r.status === 'failed') return 'failed';
    if (r.status === 'completed') return 'done';
    if (r.status === 'awaiting') return 'awaiting';
    if (r.status === 'running') return r.planReady ? 'running' : 'planning';
    return 'idle';
  });
  const writing = !!lastHer?.streaming;
  const ring: 'idle' | 'work' | 'wait' = phase === 'awaiting' ? 'wait' : writing || phase === 'running' || phase === 'planning' ? 'work' : 'idle';
  const dot = ring === 'idle' ? undefined : ring;
  const now = useNow(60_000);
  const word = voice.persona && lastHer
    ? moodWord(chat
      ? { surface: 'chat', streaming: writing && !!lastHer.text, thinking: writing && !lastHer.text, crisis: herCrisis, idleMood: cfg.lifeMood ? mood(cfg.mode, 'idle', new Date(now)) : undefined }
      : { surface: 'work', phase, crisis: herCrisis, idleMood: cfg.lifeMood ? mood(cfg.mode, 'idle', new Date(now)) : undefined })
    : undefined;
  const lastHerId = lastHer?.id;
  const lastId = lastMsg?.id;

  // 胶囊：只在闲聊、她的话是最后一条且已写完；退后、危机回合、口吻关着都不出.
  const pillOwner = chat && lastMsg && isHerMessage(lastMsg) && !lastMsg.streaming && !lastMsg.crisis && !isLeadNote(lastMsg) && !isErrorCard(lastMsg) && !retreated && voice.persona ? lastMsg : undefined;
  const pillsRaw = useMemo(
    () => (pillOwner ? pillsFor({ after: pillAfterOf(pillOwner), level: voice.level, persona: voice.persona, crisis: pillOwner.crisis, taskKind: 'chat' }) : NO_PILLS),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只随「哪一条」与话量变
    [pillOwner?.id, voice.level, voice.persona],
  );
  const pills = pillsRaw.length ? pillsRaw : NO_PILLS;
  const pillScene = useRef('');
  pillScene.current = pillOwner ? sceneOf(pillOwner) : '';
  const onPill = useCallback((p: Pill) => {
    if (p.exit) actions.exitPill(taskId, pillScene.current || undefined);
    else actions.sendMessage(taskId, p.text);
    stick.current = true;
    setAway(false);
  }, [taskId]);

  // 换说法：ACP 引擎不提供（最重，npx 冷启动）；命令行方式较慢（§3.7）.
  const { engine } = useTaskEngine(taskId);
  const rewrite: RewriteMode = engine?.driver?.startsWith('acp') ? 'off' : engine?.auth === 'cli' ? 'slow' : 'ok';

  const rowsRef = useRef(rows);
  const estRef = useRef(new Map<string, number>());
  const rowIdxRef = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    rowsRef.current = rows;
    estRef.current = new Map(rows.map((r) => [r.key, r.est]));
    rowIdxRef.current = new Map(rows.map((r, i) => [r.key, i]));
  }, [rows]);

  /* ── 分段渲染：量过的行高 + 估算 → 每行的位置 → 只挂载窗口里的行 ── */
  const heights = useRef(new Map<string, number>()).current;
  const [ver, bump] = useReducer((n: number) => (n + 1) & 0x3fffffff, 0);
  const [view, setView] = useState({ top: 0, h: 0 });

  const prefix = useMemo(() => {
    const p = new Float64Array(rows.length + 1);
    for (let i = 0; i < rows.length; i++) p[i + 1] = p[i] + (heights.get(rows[i].key) ?? rows[i].est);
    return p;
    // ver：量到新高度后重算
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, ver, heights]);

  const prefixRef = useRef(prefix);
  useLayoutEffect(() => { prefixRef.current = prefix; }, [prefix]);

  // 向上翻页后：新行在最上面，把滚动位置往下推相同的高度，视线不动。
  // 锚点 = 翻页前第一条消息/调用（分隔行会随分组变化，不能当锚点）；off = 它翻页前的位置.
  const pendingFirst = useRef<{ key: string; off: number } | undefined>(undefined);
  let shift = 0;
  if (pendingFirst.current) {
    const idx = rows.findIndex((r) => r.key === pendingFirst.current!.key);
    if (idx >= 0) shift = Math.max(0, prefix[idx] - pendingFirst.current.off);
  }
  const shiftRef = useRef(0);
  shiftRef.current = shift;

  const stuck = !away;
  const n = rows.length;
  const total = prefix[n];
  const vh = view.h || 800;
  const over = Math.max(600, vh);
  let start: number, end: number;
  if (stuck) {
    start = firstWhere(n, (i) => prefix[i + 1] > total - vh - over * 2);
    end = n;
  } else {
    const top = view.top + shift;
    start = firstWhere(n, (i) => prefix[i + 1] > top - over);
    end = Math.min(n, firstWhere(n + 1, (i) => prefix[i] >= top + vh + over));
  }
  if (end < start) end = start;

  // 量行高：行的高度变了（挂载、折叠展开、流式变长、窗口变宽）就更新；在视线上方的行变了，补偿滚动位置。
  const slot = useMemo<SlotApi>(() => {
    let ro: ResizeObserver | undefined;
    const onResize = (entries: ResizeObserverEntry[]) => {
      const sc = scrollRef.current;
      if (!sc || sc.clientHeight === 0) return; // 标签页被藏起来时量到的都是 0
      const scTop = sc.getBoundingClientRect().top;
      let changed = false;
      let comp = 0;
      for (const e of entries) {
        const el = e.target as HTMLElement;
        const k = el.dataset.k;
        if (!k) continue;
        const h = Math.round(e.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height);
        if (h <= 0) continue;
        const known = heights.get(k);
        const old = known ?? estRef.current.get(k) ?? h;
        if (known === h) continue;
        heights.set(k, h);
        if (old === h) continue;
        changed = true;
        if (!stick.current && el.getBoundingClientRect().bottom - (h - old) <= scTop + 1) comp += h - old;
      }
      if (comp) sc.scrollTop += comp;
      if (changed) bump();
      if (stick.current) sc.scrollTop = sc.scrollHeight;
      syncHeadRef.current();
    };
    return {
      observe(el) { ro ??= new ResizeObserver(onResize); ro.observe(el); },
      unobserve(el) { ro?.unobserve(el); },
    };
  }, [heights]);

  const toBottom = useCallback((smooth = false) => {
    const el = scrollRef.current;
    if (!el) return;
    // 隔得远（超过两屏）就直接跳：平滑滚动经过的都是没挂载的占位，只会是一片空白。
    const far = el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight * 2;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced && !far ? 'smooth' : 'auto' });
    // 程序化滚动：这一帧里行高可能还在量，下一帧再补算一次组头
    requestAnimationFrame(() => syncHeadRef.current());
  }, [reduced]);

  /* ── 向上翻页 ── */
  const loadingRef = useRef(false);
  const loadOlder = useCallback(async () => {
    if (loadingRef.current) return;
    const o = olderRef.current;
    const p = pagingOf(taskId);
    if (!p) return;
    const more = o.more ?? (p.oldestSeq > 0 && p.loaded < p.total);
    const cursor = Math.min(o.cursor ?? Infinity, p.oldestSeq);
    if (!more || !Number.isFinite(cursor) || cursor <= 0) return;
    loadingRef.current = true;
    setOlder((x) => ({ ...x, loading: true, failed: false }));
    const r = await pageMessages({ taskId, beforeSeq: cursor, limit: PAGE, withCalls: !chat });
    loadingRef.current = false;
    if (!r.ok) { setOlder((x) => ({ ...x, loading: false, failed: true })); return; }
    const old = rowsRef.current;
    const at = old.findIndex((r) => r.kind !== 'divider');
    pendingFirst.current = at >= 0 ? { key: old[at].key, off: prefixRef.current[at] } : undefined;
    setOlder((x) => ({
      messages: [...r.messages, ...x.messages],
      calls: r.calls.length ? [...r.calls, ...x.calls] : x.calls,
      more: r.more,
      cursor: r.oldestSeq || cursor,
      loading: false,
    }));
  }, [taskId, chat]);

  useLayoutEffect(() => {
    if (!pendingFirst.current) return;
    pendingFirst.current = undefined;
    const el = scrollRef.current;
    if (!el) return;
    if (shiftRef.current) el.scrollTop += shiftRef.current;
    lastTop.current = el.scrollTop;
    setView({ top: el.scrollTop, h: el.clientHeight });
  }, [rows]);

  // 内容还没铺满一屏半就接着往上取，直到铺满或没有更早的了。
  useEffect(() => {
    if (active && hasMore && !older.loading && !older.failed && view.h > 0 && total < view.h * 1.5) void loadOlder();
  }, [active, hasMore, older.loading, older.failed, view.h, total, loadOlder]);

  /* ── 吸顶名牌（第 8 轮重做；工作页与闲聊页共用）：对话区上沿的一条不透明实底条（HEAD_H 高，40 头像 + 名牌 + 表情胶囊），
     内容就是从它底下自然滑过去、被它的下沿干净地切开——气泡不淡、不藏、不留空洞，下沿以下没有渐隐带.
     出现条件：①压在名牌条下沿的那一行属于她的一组连发，且这一组的头像已经滚到上沿或以上；
     ②这一组最后一个元素的下沿还在名牌条下沿 + HEAD_LEAVE 以下——否则退场，让下一组自己的名牌自然出现（不会「名牌挂着、下面是别人的话」）.
     不改滚动锚点：名牌条是 .ws-conv__stage 里的叠层（aria-hidden），不占文档流；滚轮转给滚动区.
     按真实 DOM 位置量（getBoundingClientRect），不靠 prefix 估算；挂载 / 改尺寸 / 程序化滚到底 / 新消息 / 行高量到后每次提交都补算（不只在 onScroll）. ── */
  const [headKey, setHeadKey] = useState<string | null>(null);
  const headAt = useCallback((): string | null | undefined => {
    const el = scrollRef.current;
    if (!el) return null;
    if (el.clientHeight <= 0) return undefined; // 标签页藏起来时量不出来：保持原状
    const rs = rowsRef.current;
    if (!rs.length) return null;
    const host = el.getBoundingClientRect().top;
    const edge = host + HEAD_H; // 名牌条的下沿
    // 压在下沿上的行 = 最后一个上沿不低于下沿的行（行间的空隙也算前一行，由「退场」条件收尾）
    let hit: HTMLElement | undefined;
    for (const e of el.querySelectorAll<HTMLElement>('.cv-row')) {
      if (e.getBoundingClientRect().top > edge) break;
      hit = e;
    }
    const hk = hit?.dataset.k;
    let j = hk !== undefined ? rowIdxRef.current.get(hk) : undefined;
    if (j === undefined) return null;
    while (j > 0) { const r = rs[j]; if (r.kind === 'msg' && r.cont) j--; else break; }
    const g = rs[j];
    if (g.kind !== 'msg' || !isHerMessage(g.m) || isLeadNote(g.m) || isErrorCard(g.m)) return null;
    // 这一组的最后一行：没挂载 = 在窗口之下，一定还有内容露在名牌条下面；挂载了就看它最后一个元素的下沿
    let last = j;
    while (last + 1 < rs.length) { const r = rs[last + 1]; if (r.kind === 'msg' && r.cont) last++; else break; }
    const lastEl = el.querySelector<HTMLElement>(`.cv-row[data-k="${CSS.escape(rs[last].key)}"]`);
    if (lastEl) {
      const arts = lastEl.querySelectorAll<HTMLElement>('article');
      const bottom = (arts.length ? arts[arts.length - 1] : lastEl).getBoundingClientRect().bottom;
      if (bottom < edge + HEAD_LEAVE) return null;
    }
    // 组头所在行没挂载 = 它在窗口之上，一定滚出去了；挂载了就看头像（没有头像的折叠行看行首）的上沿是不是已经到了对话区上沿
    const rowEl = el.querySelector<HTMLElement>(`.cv-row[data-k="${CSS.escape(g.key)}"]`);
    if (!rowEl) return g.key;
    const av = rowEl.querySelector<HTMLElement>('.her-msg__av') ?? rowEl;
    return av.getBoundingClientRect().top - host <= 4 ? g.key : null;
  }, []);
  const syncHead = useCallback(() => {
    const k = headAt();
    if (k === undefined) return;
    // 名牌条不盖住滚动条：量出滚动条宽度给 CSS（--her-sb）
    const sc = scrollRef.current;
    if (sc?.parentElement) {
      const sb = `${Math.max(0, sc.offsetWidth - sc.clientWidth)}px`;
      if (sc.parentElement.style.getPropertyValue('--her-sb') !== sb) sc.parentElement.style.setProperty('--her-sb', sb);
    }
    setHeadKey((prev) => (prev === k ? prev : k));
    // 吸顶时把这一组流里的真头像藏起来（data-stuck）：它比名牌条高，组头刚滚进条下的那十几像素会从下沿漏出下巴，和条里的头像摞成两个.
    // 直接改 DOM 属性，不让整列 MessageRow 重渲；虚拟列表重新挂载的行在下一次同步时补上.
    if (sc) {
      for (const e of sc.querySelectorAll<HTMLElement>('.cv-row[data-stuck]')) if (e.dataset.k !== k) delete e.dataset.stuck;
      if (k) { const row = sc.querySelector<HTMLElement>(`.cv-row[data-k="${CSS.escape(k)}"]`); if (row && row.dataset.stuck === undefined) row.dataset.stuck = ''; }
    }
  }, [headAt]);
  const syncHeadRef = useRef(syncHead);
  syncHeadRef.current = syncHead;

  /* ── 滚动 ── */
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    lastTop.current = el.scrollTop;
    syncHead();
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    stick.current = near;
    setAway(!near);
    if (el.clientHeight > 0) {
      setView((v) => (Math.abs(v.top - el.scrollTop) < 100 && v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
    }
    if (el.scrollTop < 600) void loadOlder();
  };

  // Follow new messages, tool calls, a growing reply and the typing row unless the user has scrolled up.
  const liveKey = live ? `${live.agentId}:${live.text}` : '';
  const tail = messages.length ? messages[messages.length - 1].text.length + (messages[messages.length - 1].thinking?.length ?? 0) : 0;
  useLayoutEffect(() => { if (stick.current) toBottom(); }, [messages.length, calls.length, liveKey, tail, rows.length, toBottom]);

  useLayoutEffect(() => {
    if (!active) return;
    const el = scrollRef.current;
    if (!el) return;
    if (stick.current) toBottom();
    else el.scrollTop = lastTop.current;
    if (el.clientHeight > 0) setView({ top: el.scrollTop, h: el.clientHeight });
  }, [active, toBottom]);

  // 每次提交之后（挂载、新消息、行高量到、折叠展开……）按真实 DOM 补算一次组头；放在滚到底的几个 effect 之后，量到的是滚完的位置.
  useLayoutEffect(() => { syncHead(); });

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (el.clientHeight > 0) setView((v) => (v.h === el.clientHeight ? v : { top: el.scrollTop, h: el.clientHeight }));
      if (stick.current && el.clientHeight > 0) toBottom();
      syncHeadRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [toBottom]);

  const follow = () => { stick.current = true; setAway(false); };
  const jump = () => { follow(); toBottom(true); };
  const liveAgent = live ? agentById.get(live.agentId) : undefined;

  const headRow = (() => {
    if (!headKey || cfg.fold) return undefined;
    const r = rows.find((x) => x.key === headKey);
    return r && r.kind === 'msg' ? r : undefined;
  })();
  // 组头的状态（神色词 / 状态点 / 外环）取自这一组里最新的那一条
  const headLast = headRow ? (headRow.last ?? headRow.m) : undefined;
  const headMine = !!headLast && headLast.id === lastHerId;
  const mounted = rows.slice(start, end);
  const topPad = prefix[start];
  const bottomPad = total - prefix[end];

  return (
    <div className={cx('ws-conv', chat && 'ws-conv--chat')} data-retreat={cfg.stepBack && retreated ? 'true' : undefined}>
      <div className="ws-conv__stage">
        <div ref={scrollRef} className="ws-conv__scroll" style={{ overflowAnchor: 'none' }} data-stick={headRow ? '' : undefined} onScroll={onScroll} role="region" aria-label="对话记录" tabIndex={0}>
          <SlotCtx.Provider value={slot}>
            <div className="ws-conv__log cv-log" role="log" aria-label="对话消息">
              {rows.length === 0 && !storyMsg && (chat && voice.persona ? <HerOpening /> : <p className="ws-conv__empty">{chat ? '还没有消息，打个招呼吧。' : '还没有消息。'}</p>)}
              {older.loading && <span className="cv-older" role="status"><Loader size={12} aria-hidden className="so-spin" />正在载入更早的消息…</span>}
              {!older.loading && hasMore && (
                <button type="button" className="cv-older" onClick={() => void loadOlder()}>
                  {older.failed ? '没取到更早的消息，再试一次' : '载入更早的消息'}
                </button>
              )}
              {topPad > 0 && <div className="cv-pad" style={{ height: topPad }} aria-hidden />}
              {mounted.map((row) => {
                if (row.kind === 'divider') {
                  return <DividerRow key={row.key} k={row.key} attempt={row.attempt} startedAt={row.startedAt} viewing={row.runId === runId && runById.size > 1} />;
                }
                if (row.kind === 'msg') {
                  const m = row.m;
                  // 组头的神色词 / 状态点 / 外环 / 类型签取自这一组里最新的一条（组头自己那条可能只是开头一句）；合并进组的后续行不画头，不收这几个 props
                  const gl = row.cont ? m : (row.last ?? m);
                  const mine = !row.cont && gl.id === lastHerId;
                  return (
                    <MessageRow
                      key={row.key} message={m} agent={m.agentId ? agentById.get(m.agentId) : undefined} flat={!!chat} last={m.id === lastAgentId} taskId={taskId}
                      cont={row.cont} joined={row.joined} ring={mine || (!row.cont && gl.id === lastId) ? ring : 'idle'} word={mine ? word : undefined} dot={mine ? dot : undefined} headKind={gl.kind}
                      stickers={cfg.stickers} fold={cfg.fold} memoryOn={cfg.memoryOn} rewrite={rewrite}
                      pills={m.id === lastId ? pills : NO_PILLS} canAsk={m.id === lastId && m.reaction === 'landing'} onPill={onPill} settle={m.id === settling} tail={m.id === lastId}
                    />
                  );
                }
                return <CallRow key={row.key} call={row.c} />;
              })}
              {bottomPad > 0 && <div className="cv-pad" style={{ height: bottomPad }} aria-hidden />}
            </div>
          </SlotCtx.Provider>
          {live && (
            <div className="ws-typing" data-her={liveAgent?.id === 'orchestrator' && voice.persona ? '' : undefined}>
              {liveAgent && (liveAgent.id === 'orchestrator' && voice.persona
                ? <HerAvatar size={28} expr="gentle" ring="work" />
                : <AgentMark agent={liveAgent.id} size={22} state="busy" />)}
              <span className="ws-typing__text">{liveAgent ? `${liveAgent.name}：` : ''}{live.text}</span>
              <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>
            </div>
          )}
        </div>
        {headRow && (
          <div className="her-stickhead" aria-hidden="true" onWheel={(e) => scrollRef.current?.scrollBy({ top: e.deltaY })}><div className="her-stickhead__col">
            <StickyHead m={headRow.m} stickers={cfg.stickers} word={headMine ? word : undefined} dot={headMine ? dot : undefined} ring={headMine ? ring : 'idle'} />
          </div></div>
        )}
        {away && <Button className="ws-conv__jump" size="sm" icon={ArrowDown} onClick={jump}>跳到最新</Button>}
      </div>
      {storyMsg && (
        <div className="story-dock">
          <StoryBox
            word={word} dot={dot} sticker={storySticker} streaming={storyMsg.streaming} onCollapse={collapseStory}
            expr={storyMsg.expr}
          >
            {storyMsg.streaming && !storyMsg.text
              ? <span className="ws-typing__dots" role="status" aria-label="她正在写"><i /><i /><i /></span>
              : <Markdown source={storyMsg.text} headingLevel={4} className="ws-msg__md" />}
          </StoryBox>
        </div>
      )}
      <Composer taskId={taskId} onSent={follow} chat={!!chat} />
    </div>
  );
}

/* ───────────── rows ───────────── */

/** 新闲聊的空态：她先开口——开场一句（boot.c，随话量、夜昼），56 头像 + 角标 + 名牌 + 气泡.
 *  不进对话流、不计话量、不带贴纸；口吻关着时调用方退回朴素灰字. */
function HerOpening() {
  const say = useSay2();
  const mode = useApp((s) => s.settings.mode);
  const said = useMemo(() => say('boot', {}, { mode: 'chat' }), [say]);
  const text = said.text.trim();
  if (!text) return <p className="ws-conv__empty">还没有消息，打个招呼吧。</p>;
  return (
    <article className="ws-msg her-msg is-flat her-opening" data-her data-opening aria-label="遐蝶的开场">
      <div className="her-msg__av"><HerAvatar size={56} expr={said.expr ?? 'gentle'} ring="idle" /></div>
      <div className="ws-msg__col">
        <header className="ws-msg__head her-msg__head"><NamePlate size="md" sub={mode === 'day' ? SUB_DAY : SUB_NIGHT} expr={said.expr ?? 'gentle'} /></header>
        <div className="her-bubs"><div className="ws-msg__bubble ws-msg__bubble--md her-bub is-first">{guardTail(text)}</div></div>
      </div>
    </article>
  );
}

/** 吸顶组头：和她那一组第一条消息的头像 + 名行同一套规则（贴纸 / 危机 / 旧消息不画角标与胶囊）. 只在工作页浮出，aria-hidden（真正的组头在流里）. */
function StickyHead({ m, stickers, word, dot, ring }: { m: Message; stickers: boolean; word?: string; dot?: 'work' | 'wait'; ring: 'idle' | 'work' | 'wait' }) {
  const sticker = stickerOf(m, stickers);
  const expr: ExprId = m.crisis || sticker ? 'gentle' : (m.expr ?? 'gentle');
  const badge = !!m.expr && !m.crisis && !sticker;
  const sub = m.crisis ? undefined : m.persona === 'day' ? SUB_DAY : SUB_NIGHT;
  return (
    <div className="her-stickhead__in" data-her>
      <HerAvatar size={40} expr={expr} ring={ring} badge={badge} />
      <NamePlate size="md" sub={sub} word={word} dot={dot} expr={badge ? expr : undefined} />
    </div>
  );
}

const DividerRow = memo(function DividerRow({ k, attempt, startedAt, viewing }: { k: string; attempt: number; startedAt: number; viewing: boolean }) {
  return (
    <Slot k={k}>
      <div className="ws-conv__divider" data-viewing={viewing ? 'true' : undefined}>
        <span>运行 #{attempt}</span>
        {startedAt > 0 && <time dateTime={new Date(startedAt).toISOString()}>{timeOfDay(startedAt)}</time>}
        {viewing && <span className="ws-conv__viewing">当前查看</span>}
      </div>
    </Slot>
  );
});

interface ItemProps {
  message: Message;
  agent?: Agent;
  /** 闲聊的单列布局. */
  flat: boolean;
  /** 她这条是不是可以「重新生成」的最后一条. */
  last: boolean;
  taskId: string;
  /** 连续消息合并头像：不画头像与名行（占位等宽）. */
  cont: boolean;
  /** 下一条合并进了这一条：行间距 6px，操作行悬停才浮在气泡右下角（不占行高）. */
  joined?: boolean;
  /** 组头的类型签（计划 / 总结）取自这一组里最新的一条；合并进组的后续行不画头，不用. */
  headKind?: Message['kind'];
  /** 以下三个只会给「最后一条她的话」，其余行恒为默认值，memo 才不会整列重渲. */
  ring: 'idle' | 'work' | 'wait';
  word?: string;
  dot?: 'work' | 'wait';
  stickers: boolean;
  fold: boolean;
  memoryOn: boolean;
  rewrite: RewriteMode;
  pills: readonly Pill[];
  canAsk: boolean;
  onPill: (p: Pill) => void;
  /** 刚从剧情框降级回对话流：200 ms 过渡. */
  settle?: boolean;
  /** 这是整个对话的最后一条：它的操作行常驻（只留「换个说法」），卡外那一句才带神色词 / 外环. 其余行恒为 false. */
  tail: boolean;
}

const MessageRow = memo(function MessageRow(props: ItemProps) {
  return <Slot k={props.message.id}><MessageItem {...props} /></Slot>;
});

const CallRow = memo(function CallRow({ call }: { call: ToolCall }) {
  return <Slot k={call.id}><InlineTool call={call} /></Slot>;
});

/* ───────────── one message ───────────── */

const SUB_NIGHT = '冥河的女儿';
const SUB_DAY = '拥抱新生的祈望';

function MessageItem(p: ItemProps) {
  const { message: m, agent, flat, last, taskId, cont } = p;
  const time = <time className="ws-msg__time" dateTime={new Date(m.at).toISOString()} title={fullTime(m.at)}>{hhmm(m.at)}</time>;
  const [whole, setWhole] = useState(false);
  const [open, setOpen] = useState(false);
  const cut = !whole && m.text.length > LONG_MSG;
  const shown = cut ? m.text.slice(0, LONG_MSG) : m.text;
  const rest = cut ? (
    <button type="button" className="cv-longmore" onClick={() => setWhole(true)}>展开剩余 {(m.text.length - LONG_MSG).toLocaleString('zh-CN')} 字</button>
  ) : null;

  /* ── 系统行（休息关照 / 她主动开口的 role=system 版本）与旧的朴素系统消息 ── */
  if (m.role === 'system') {
    const k = sysKindOf(m);
    if (k) return <SysLine kind={k} scene={sceneOf(m)} slots={m.src?.slots} />;
    return <p className="ws-msg ws-msg--system">{m.text}{time}</p>;
  }

  /* ── 用户：--me-bg 气泡；命中「落蝶」的在下面挂一个小标 ── */
  if (m.role === 'user') {
    return (
      <article className="ws-msg ws-msg--user her-me" aria-label="你的消息">
        {!flat && <header className="ws-msg__head"><span className="ws-msg__name">你</span>{time}</header>}
        <div className="her-me__row">
          {flat && time}
          <div className="ws-msg__bubble her-me__bub">{shown}{rest}</div>
        </div>
        {m.reaction === 'landing' && (
          <span className="her-landing" aria-live="polite">
            <span className="her-landing__mark"><ButterflyMark size={18} wire /></span>落蝶
            {p.canAsk && (
              <button type="button" className="her-act" onClick={() => void reply(taskId, flat ? {} : { followUp: true })}>让她回一句</button>
            )}
          </span>
        )}
        {p.memoryOn && flat && <UserActions m={m} taskId={taskId} />}
      </article>
    );
  }

  /* ── 报错卡本体：只放失败事实，无头像、无贴纸、无名牌（内容层，D-01） ── */
  if (isErrorCard(m)) {
    return (
      <article className="ws-msg her-errcard" data-card="error" data-kind="error" aria-label="错误">
        <header className="ws-msg__head">
          <span className="ws-kind ws-kind--danger"><OctagonX size={11} aria-hidden />错误</span>
          {time}
        </header>
        <div className="her-errcard__body"><Markdown source={shown} headingLevel={4} className="ws-msg__md" />{rest}</div>
      </article>
    );
  }

  const herSays = isHerMessage(m);

  /* ── 卡外她那一句（approve / question / fail / done…）：40 px 头像 + 名牌 + 神色词 + 气泡，和 RunCallout 里的同一个 HerLead ──
     神色词只给对话流里最后一条（旧的待批 / 失败不该永远写着「停在这一步」）. */
  if (isLeadNote(m)) {
    const scene = sceneOf(m);
    const w = p.tail ? leadWordOf(scene) : undefined;
    return (
      <article className="ws-msg her-leadrow" data-her data-kind="note" aria-label="遐蝶的消息">
        <HerLead text={shown} scene={scene} ring={p.tail ? p.ring : 'idle'} word={w?.word ?? null} dot={w?.dot} expr={m.expr ?? 'gentle'} crisis={!!m.crisis} />
      </article>
    );
  }

  const kind = m.kind ? KIND[m.kind] : undefined;
  const KindIcon = kind?.icon;
  const waiting = m.streaming && !m.text;

  /* ── 她：头像 + 名牌 + 神色词 + 气泡 ── */
  if (herSays) {
    const sticker = stickerOf(m, p.stickers);
    // 一条消息只有一种表情信号（D19）：带贴纸 → 头像 gentle、无角标；旧消息没有 expr → gentle、无角标；危机回合同理.
    const expr: ExprId = m.crisis || sticker ? 'gentle' : (m.expr ?? 'gentle');
    const badge = !!m.expr && !m.crisis && !sticker;
    const sys = sysKindOf(m);
    // 危机回合：名牌只写「遐蝶」，不带称号（冥河 / 死荫是死亡意象，不该紧挨着自伤的话；第 2 轮评审）.
    const sub = m.crisis ? undefined : m.persona === 'day' ? SUB_DAY : SUB_NIGHT;
    const ck = p.headKind ?? m.kind;
    const chipKind = ck ? KIND[ck] : undefined;
    const ChipIcon = chipKind?.icon;
    const chips = chipKind && (ck === 'plan' || ck === 'summary') && ChipIcon
      ? <span className={`ws-kind ws-kind--${chipKind.tone}`}><ChipIcon size={11} aria-hidden />{chipKind.label}</span> : null;

    if (p.fold && !m.streaming && m.text && !open) {
      return (
        <article className="ws-msg her-msg her-msg--fold" data-her data-kind={m.kind} aria-label="遐蝶的消息（已折叠）">
          <button type="button" className="her-fold" aria-expanded={false} onClick={() => setOpen(true)}>
            <HerAvatar size={24} expr={expr} ring="none" badge={false} />
            <span className="her-fold__line">{foldLine(m.text)}</span>
            <span className="her-fold__more">展开<ChevronDown size={13} aria-hidden /></span>
          </button>
        </article>
      );
    }

    const split = flat ? splitBubbles(shown) : [shown];
    // 危机回复里的热线号码加粗，一眼找得到（只认写在 HOTLINE 里的三个号码）.
    const bubbles = m.crisis ? split.map((b) => b.replace(/(?<![\d*])(12356|110|120)(?![\d*])/g, '**$1**')) : split;
    return (
      <>
        {sys && <SysLine kind={sys} scene={sceneOf(m)} slots={m.src?.slots} />}
        <article className={cx('ws-msg', 'her-msg', flat && 'is-flat', cont && 'is-cont', p.joined && 'is-joined', p.settle && 'is-settle')} data-her data-kind={m.kind} data-latest={p.tail || p.last ? 'true' : undefined} aria-label="遐蝶的消息">
          <div className="her-msg__av">
            {!cont && <HerAvatar size={flat ? 56 : 40} expr={expr} ring={p.ring} badge={badge} />}
          </div>
          <div className="ws-msg__col">
            {!cont ? (
              <header className="ws-msg__head her-msg__head">
                <NamePlate size="md" sub={sub} word={p.word} dot={p.dot} expr={badge ? expr : undefined} />
                {chips}
                {time}
              </header>
            ) : <span className="her-msg__hover">{time}</span>}
            {m.thinking && <Thinking text={m.thinking} live={!!m.streaming && !m.text} />}
            {waiting && !m.thinking ? (
              <div className="ws-msg__bubble ws-msg__bubble--typing her-bub is-first" aria-label="遐蝶正在输入">
                <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>
              </div>
            ) : waiting ? null : (
              <div className="her-bubs">
                {bubbles.map((b, i) => (
                  <div
                    key={i}
                   
                    className={cx('ws-msg__bubble ws-msg__bubble--md her-bub', i === 0 && !cont && 'is-first', m.streaming && i === bubbles.length - 1 && 'is-streaming')}
                    aria-busy={(m.streaming && i === bubbles.length - 1) || undefined}
                  >
                    <Markdown source={b} headingLevel={4} className="ws-msg__md" tail />
                    {i === bubbles.length - 1 && rest}
                  </div>
                ))}
              </div>
            )}
            {m.streaming && m.activity && (
              <p className="ws-msg__activity" role="status">
                <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>{m.activity}
              </p>
            )}
            {sticker && <div className="her-sticker"><StickerImg id={sticker} size={104} /></div>}
            {!m.streaming && m.text && (
              <HerActions m={m} taskId={taskId} canRetry={last} copy={flat} rewrite={p.rewrite} memoryOn={p.memoryOn} resident={p.tail} hasPills={p.pills.length > 0} />
            )}
            {p.pills.length > 0 && <Pills pills={p.pills} onPick={p.onPill} />}
          </div>
        </article>
      </>
    );
  }

  /* ── 子 Agent（以及口吻关着时的编排 Agent）：官方命途图标 + 名字，朴素，无头像无表情（D5） ── */
  const name = agent?.name ?? 'Agent';
  return (
    <article className={cx('ws-msg ws-msg--agent', flat && 'ws-msg--flat', cont && 'is-cont')} data-kind={m.kind} aria-label={`${name}的消息`}>
      {agent && !cont ? <span className="her-msg__mark"><AgentMark agent={agent.id} size={28} /></span> : <span className="her-msg__mark" aria-hidden />}
      <div className="ws-msg__col">
        {!cont ? (
          <header className="ws-msg__head">
            <span className="ws-msg__name">{name}</span>
            {kind && KindIcon && <span className={`ws-kind ws-kind--${kind.tone}`}><KindIcon size={11} aria-hidden />{kind.label}</span>}
            {time}
          </header>
        ) : <span className="her-msg__hover">{time}</span>}
        {m.thinking && <Thinking text={m.thinking} live={!!m.streaming && !m.text} />}
        {waiting && !m.thinking ? (
          <div className="ws-msg__bubble ws-msg__bubble--typing" aria-label={`${name}正在输入`}>
            <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>
          </div>
        ) : waiting ? null : (
          <div className={cx('ws-msg__bubble ws-msg__bubble--md', m.streaming && 'is-streaming')} aria-busy={m.streaming || undefined}>
            <Markdown source={shown} headingLevel={4} className="ws-msg__md" />
            {rest}
          </div>
        )}
        {m.streaming && m.activity && (
          <p className="ws-msg__activity" role="status">
            <span className="ws-typing__dots" aria-hidden><i /><i /><i /></span>{m.activity}
          </p>
        )}
      </div>
    </article>
  );
}

/** Folded reasoning (as DeepSeek / Kimi show it). 栖枝的标签只写事实，不拟人. */
function Thinking({ text, live }: { text: string; live: boolean }) {
  const n = Array.from(text).length;
  const label = live ? '正在思考…' : `思考过程 · ${n} 字`;
  return (
    <details className="ws-think" open={live || undefined}>
      <summary><Brain size={13} aria-hidden />{label}</summary>
      <div className="ws-think__body">{text}</div>
    </details>
  );
}

/* ───────────── a tool call in the transcript ───────────── */

/** 输出只在展开后才画；>5 KB 的先画前 5 KB（或存储里的摘要），点「展开全文」再取全部. */
const InlineTool = memo(function InlineTool({ call }: { call: ToolCall }) {
  const def = useApp((s) => s.tools.find((t) => t.id === call.tool));
  const [open, setOpen] = useState(false);
  const meta = TOOL_STATUS[call.status];
  const Icon = meta.icon;
  const out = call.error?.message && !call.output ? call.error.message : call.output;
  return (
    <details className={cx('ws-tool', `ws-tool--${meta.tone}`)} data-card="tool" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <span className={cx('ws-tool__icon', meta.spin && 'is-spin')} data-tone={meta.tone} title={meta.label}><Icon size={13} aria-hidden /></span>
        <span className="ws-tool__name">{call.toolName ?? def?.name ?? call.tool}</span>
        <span className="ws-tool__title">{call.title}</span>
        <span className="ws-tool__meta">{meta.label}{call.durationMs != null ? ` · ${duration(call.durationMs)}` : ''}</span>
      </summary>
      {open && <ToolOutputPre call={{ id: call.id, output: out }} empty={call.status === 'running' ? '执行中…' : '（没有输出）'} />}
    </details>
  );
});

/* ───────────── composer ───────────── */

function Composer({ taskId, onSent, chat }: { taskId: string; onSent: () => void; chat: boolean }) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { engine, choices, state } = useTaskEngine(taskId);
  const runOpen = useApp((s) => {
    const t = s.tasks[taskId];
    const r = t?.runIds.length ? s.runs[t.runIds[t.runIds.length - 1]] : undefined;
    return !!r && isOpenRun(r.status);
  });
  const hasRun = useApp((s) => (s.tasks[taskId]?.runIds.length ?? 0) > 0);
  const replying = useApp((s) => s.tasks[taskId]?.messages.some((m) => m.streaming) ?? false);
  const persona = useApp((s) => (s.settings.persona ? PERSONA[s.settings.mode].name : '编排 Agent'));

  useFocusRequest('composer', () => requestAnimationFrame(() => inputRef.current?.focus()));

  const submit = () => {
    if (!text.trim()) return;
    actions.sendMessage(taskId, text);
    setText('');
    onSent();
    inputRef.current?.focus();
  };

  // 闲聊 can switch model and effort mid-conversation; the next reply uses them.
  const currentKey = engine ? `${engine.provider}:${engine.auth}` : '';
  const switchTo = async (p: ModelPick) => {
    const c = choices.find((x) => x.key === p.key);
    if (!c) return;
    if (engine && p.key === currentKey && c.driver === engine.driver && p.model === engine.model && p.effort === engine.effort) return;
    const cwd = c.auth === 'cli' ? (engine?.cwd ?? await desktop?.workspaceFolder(`chat-${Date.now().toString(36)}`)) : undefined;
    actions.setTaskEngine(taskId, engineFromChoice(c, { cwd, model: p.model, effort: p.effort }));
  };

  const chips = chat
    ? <ModelChips pick={{ key: currentKey, model: engine?.model ?? '', effort: engine?.effort, driver: engine?.driver }} onPick={(p) => void switchTo(p)} />
    : engine && <><EngineTag label={engine.label} /><TaskPermissionChip taskId={taskId} /></>;

  // A reply needs a model; supplements to a work task are only stored until it runs, so they never wait for one.
  const blocked = chat && state !== 'ready' ? (choices.length ? '先选一个能用的模型' : '先到「模型接入」接入一个模型') : undefined;
  const hint = chat
    ? 'Enter 发送，Shift + Enter 换行'
    : runOpen ? '补充说明会交给正在执行的 Agent' : hasRun ? `可以追问结果（${persona}会回答，但不会再动文件）` : '开始运行时，这些补充会一起交给 Agent';

  return (
    <div className={cx('ws-composer-wrap', chat && 'ws-composer-wrap--chat')}>
      {chat && <ModelNotice taskId={taskId} chat />}
      <PromptBox
        variant="docked"
        id={`ws-composer-${taskId}`}
        value={text}
        onChange={setText}
        onSubmit={submit}
        inputRef={inputRef}
        label={chat ? `发给${persona}的消息` : '补充说明或调整要求'}
        placeholder={chat ? `和${persona}说点什么…` : '补充说明或调整要求…'}
        chips={chips}
        hint={hint}
        blocked={blocked}
        busy={chat && replying}
        onStop={() => stopReply(taskId)}
        draftKey={taskId}
      />
    </div>
  );
}
