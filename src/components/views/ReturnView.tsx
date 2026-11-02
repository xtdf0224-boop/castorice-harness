/* 首页「归来」（V0α · 模块 B4「交互」，Q07 + K31）。
   样稿：castorice-harness/design/mockups/night/index.html?screen=s1（夜）与 day/…?screen=s1（昼）。
   构图：内容列压在左半，右半留给壁纸里的她（不遮、不叠面板）；无大字标题、无右栏；输入框在内容列下三分之一。
   从上到下：时间 → 归来简（纸面）→ 待你（最多 2 行）→ 离开期间（最多 5 行）→ 最近会话（V0α 用它代替「最近成品」）→ 输入框信封。
   归来简来自事件日志与运行记录，不调用模型（brief.ts）；离开不够久或没有事时，整张纸换成一句话. */
import { ArrowRight, CircleAlert, CircleCheck, Info, Lamp, MessageCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Fragment, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useNow } from '../../lib/hooks';
import { relative } from '../../lib/format';
import { weekdayClock } from '../../lib/persona';
import type { AppState, QueueItem } from '../../lib/types';
import { spanCn, useSay, useSay2, voiceSeed, waitText } from '../../lib/voice';
import { actions } from '../../state/actions';
import { BRIEF_FRESH_MS, awayWindow, deriveBrief, type BriefLine, type ReturnBrief } from '../../state/brief';
import { QUEUE_LABEL, waitingText } from '../../state/queue';
import { personaOn, useQueue, useQueueReady } from '../../state/selectors';
import { useApp } from '../../state/store';
import { StatusChip, cx } from '../ui';
import { Butterfly } from '../decor/marks';
import { HerAvatar } from '../her/HerAvatar';
import { NamePlate } from '../her/NamePlate';
import { Words } from '../shell/Words';
import { Composer } from './tasks/Composer';
import { FirstRun } from './tasks/FirstRun';
import { Postmark } from './tasks/Her';
import { OPEN_LABEL, QUEUE_ICON, QueueDetail, QueueRow } from './tasks/QueueRow';
import { MUST, splitQueue } from './tasks/queueSplit';
import { useChoices, useModelsKnown } from './tasks/choices';
import { metaOf, selectSummaries, summariesEqual } from './tasks/taskInfo';
import '../../styles/interaction-return.css';

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (at: number) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const mmdd = (at: number) => { const d = new Date(at); return `${pad(d.getMonth() + 1)} · ${pad(d.getDate())}`; };

/** 离开多久：「40 分钟」「1 时 9 分」「2 天」（waitText 的分钟档补上「钟」）. */
const awayText = (ms: number) => { const t = waitText(ms); return /^\d+ 分$/.test(t) ? `${t}钟` : t; };

const LINE_RANK: Record<BriefLine['kind'], number> = { failed: 0, done: 1, reply: 2, notice: 3 };
const LINE_ICON: Record<BriefLine['kind'], LucideIcon> = { done: CircleCheck, failed: TriangleAlert, reply: MessageCircle, notice: CircleAlert };

const sameBrief = (a: ReturnBrief, b: ReturnBrief) => a === b || JSON.stringify(a) === JSON.stringify(b);
const WELCOMED = 'alight/welcomed';
const wasWelcomed = () => { try { return localStorage.getItem(WELCOMED) === '1'; } catch { return true; } };

/** 「最近会话」不许只露出标题：贴底的输入框（.return-bottom，sticky）会盖住滚动区底部。首屏（滚动位置 0）上，
    若这一节的第一张卡片没有完整落在输入框上沿之上，就把整节往下推到输入框之下——由用户滚到它；
    推多少只看这一刻的实测（不写死像素），内容长高、窗口缩放、输入框折叠都重新量。
    量的时候先清掉上次的推移，所以结果与滚动位置、上一次的值无关；直接写 style，不进 React 状态，免得重渲染回路. */
function useRecentBelowFold(
  rootRef: { current: HTMLDivElement | null },
  colRef: { current: HTMLDivElement | null },
  secRef: { current: HTMLElement | null },
  bottomRef: { current: HTMLDivElement | null },
  on: boolean,
) {
  useLayoutEffect(() => {
    const root = rootRef.current, col = colRef.current, sec = secRef.current, bottom = bottomRef.current;
    if (!on || !root || !col || !sec || !bottom) return;
    const measure = () => {
      sec.style.marginTop = '';
      const card = sec.querySelector<HTMLElement>('.return-recent__card');
      if (!card) return;
      // 输入框贴底时的上沿（滚动位置 0）= 视口高 − 它自己的高；上沿的羽化带（顶部 24px 渐变 + 磨砂）算在它里面，所以卡片要整个落在它上面.
      const limit = root.clientHeight - bottom.offsetHeight;
      // 用 offsetTop 链量（不受开屏转场里 transform 缩放的影响）.
      const topIn = (el: HTMLElement) => { let y = 0; for (let n: HTMLElement | null = el; n && n !== col; n = n.offsetParent as HTMLElement | null) y += n.offsetTop; return y; };
      const secTop = topIn(sec);
      const cardBottom = topIn(card) + card.offsetHeight;
      if (cardBottom <= limit - 4) return;      // 第一张卡完整露出：不动
      // 输入框上沿 24px 是渐隐 + 磨砂的羽化带，标题落在里面会成一行糊字；要推到羽化带之下（它自己的实色部分下面）才算「看不见」.
      const hide = limit + 28;
      if (secTop >= hide) return;               // 整节本来就在输入框之下：不动
      sec.style.marginTop = `${Math.ceil(hide - secTop)}px`;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root); ro.observe(col); ro.observe(bottom);
    return () => { ro.disconnect(); sec.style.marginTop = ''; };
  }, [rootRef, colRef, secRef, bottomRef, on]);
}

export function ReturnView() {
  const win = useSyncExternalStore(awayWindow.subscribe, awayWindow.get, awayWindow.get);
  const fresh = !!win && Date.now() - win.to < BRIEF_FRESH_MS;
  const select = useCallback(
    (s: AppState): ReturnBrief => (fresh && win ? deriveBrief(s, win.from, win.to) : deriveBrief(s, undefined, Date.now())),
    [fresh, win],
  );
  const brief = useApp(select, sameBrief);
  const items = useQueue();
  const ready = useQueueReady();
  const persona = useApp((s) => personaOn(s));
  const taskCount = useApp((s) => s.taskOrder.length);
  const summaries = useApp(selectSummaries, summariesEqual);
  const { choices } = useChoices();
  const known = useModelsKnown();
  const desktopOk = useApp((s) => s.models.desktop);
  const now = useNow(30_000);
  const say = useSay();
  const { weekday, clock } = weekdayClock(new Date(now));
  const recent = useMemo(() => [...summaries].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 3), [summaries]);

  // 第一次打开（没有任务、没来过）：欢迎词 greet.first 只在先接入模型的那张卡（FirstRun）里出一次.
  // 看到过就锁住，直到离开这个页面，免得写进 localStorage 之后同一次停留里欢迎词又消失.
  const firstSeen = useRef(false);
  if (taskCount === 0 && !wasWelcomed()) firstSeen.current = true;
  const firstEver = firstSeen.current && taskCount === 0;
  useEffect(() => {
    if (firstSeen.current && known) { try { localStorage.setItem(WELCOMED, '1'); } catch { /* 记不住就算了 */ } }
  }, [known]);

  const rootRef = useRef<HTMLDivElement>(null);
  const colRef = useRef<HTMLDivElement>(null);
  const recentRef = useRef<HTMLElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  useRecentBelowFold(rootRef, colRef, recentRef, bottomRef, recent.length > 0);

  const showPaper = !brief.quiet && persona;
  const welcomeCard = known && choices.length === 0;
  // 安静归来：她只说一句，在输入框上方（Composer 的开屏句）；页面顶部那一句换成系统小字，不再重复一遍问候.
  const quietText = items.length === 0 && ready
    ? (persona
      ? (taskCount === 0 && firstEver && (!known || welcomeCard) ? '' : taskCount === 0 ? '还没有任务' : '没有在等你的事')
      : (taskCount === 0 ? (firstEver && (!known || welcomeCard) ? '' : say('empty.recent')) : brief.text))
    : '';
  // 待你 = 须亲批 / 回答的；失败与待查看是「可看」，另起名目（r3：左栏、纸面、标题、「全部 N」必须是同一个数）.
  const split = splitQueue(items, now);
  const headSource = split.must.length > 0 ? split.must : split.look;
  const head = headSource.slice(0, 2);

  return (
    <div className="view return-view" ref={rootRef}>
      <div className="return-col" data-boot-in="col" ref={colRef}>
        <div className="return-when"><span>{weekday}</span><b>{clock}</b></div>

        {!brief.quiet && !persona && <p className="return-plain" role="status">{brief.text}</p>}
        {showPaper && <BriefPaper brief={brief} items={items} now={now} />}
        {brief.quiet && quietText && persona && <QuietPaper empty={taskCount === 0} at={now} awayMs={fresh && win ? win.to - win.from : 0} />}
        {brief.quiet && quietText && !persona && (
          <div className="return-quiet is-plain" role="status">
            <p>{quietText}</p>
          </div>
        )}

        {!showPaper && head.length > 0 && (
          <section className="return-blk" aria-labelledby="return-queue-h">
            <div className="return-hd">
              <Lamp size={16} aria-hidden className="return-hd__lamp" />
              {/* 同一口径：标题的数 = 须亲批 / 回答的件数（与左栏「待你」一致）；没有这类事时标题改叫「可看」，不拿可看的数充待你 */}
              <h2 id="return-queue-h">{split.must.length > 0 ? '待你' : '可看'} <span className="return-hd__cnt">{split.must.length > 0 ? split.must.length : split.look.length}</span></h2>
              <button type="button" className="return-hd__more" onClick={() => actions.navigate('queue')}>{head.length < headSource.length ? `全部 ${headSource.length}` : '待你页'}<ArrowRight size={12} aria-hidden /></button>
            </div>
            <ul className="queue-list is-compact" aria-label={split.must.length > 0 ? '待你' : '可看'}>
              {head.map((it) => <QueueRow key={it.key} item={it} now={now} compact />)}
            </ul>
            {split.must.length > 0 && split.look.length > 0 && (
              <button type="button" className="return-blk__look" onClick={() => actions.navigate('queue')}>另有 {split.look.length} 件可看<ArrowRight size={12} aria-hidden /></button>
            )}
          </section>
        )}

        {!showPaper && !brief.quiet && brief.lines.length > 0 && brief.from !== undefined && brief.to !== undefined && (
          <section className="return-away" aria-labelledby="return-away-h">
            <AwayList brief={brief} headingId="return-away-h" />
          </section>
        )}

        {recent.length > 0 && (
          <section className="return-blk" aria-labelledby="return-recent-h" ref={recentRef}>
            <div className="return-hd">
              <h2 id="return-recent-h">最近会话</h2>
              <span className="return-hd__note">成品架随 V1 到来，先放最近的会话</span>
              <button type="button" className="return-hd__more" onClick={() => actions.navigate('tasks')}>全部任务<ArrowRight size={12} aria-hidden /></button>
            </div>
            <ul className="return-recent">
              {recent.map((t) => (
                <li key={t.id}>
                  <button type="button" className="return-recent__card" onClick={() => actions.openTask(t.id)}>
                    <span className="return-recent__name">{t.title}</span>
                    <span className="return-recent__row"><StatusChip meta={metaOf(t.status, t.kind)} size="sm" /><span className="return-recent__time">{relative(t.updatedAt, now)}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="return-bottom" ref={bottomRef}>
          {welcomeCard && <FirstRun desktopOk={desktopOk} greet={firstEver} />}
          <Composer boot={!showPaper} collapsible />
        </div>
      </div>
    </div>
  );
}

/** 离开期间：标题 + 时间范围 + 每行一件事（点开对应的任务）. 纸面里与纸面外共用. */
function AwayList({ brief, headingId, limit }: { brief: ReturnBrief; headingId: string; limit?: number }) {
  const [all, setAll] = useState(false);
  // 默认最多 limit 行：失败 > 完成 > 回复 > 提示，同类取最近的，摆回时间顺序；多出的收成「全部 N 条」.
  const shown = useMemo(() => {
    if (!limit || all || brief.lines.length <= limit) return brief.lines;
    const keep = new Set([...brief.lines].sort((a, b) => LINE_RANK[a.kind] - LINE_RANK[b.kind] || b.at - a.at).slice(0, limit));
    return brief.lines.filter((l) => keep.has(l));
  }, [brief.lines, limit, all]);
  const total = brief.lines.length + brief.more;
  const folded = shown.length < brief.lines.length;
  return (
    <>
      <div className="return-hd">
        <h2 id={headingId}>离开期间</h2>
        {brief.from !== undefined && brief.to !== undefined && <span className="return-hd__range">{hhmm(brief.from)} 到 {hhmm(brief.to)}</span>}
        {folded && <button type="button" className="return-hd__more" onClick={() => setAll(true)}>全部 {total} 条<ArrowRight size={12} aria-hidden /></button>}
      </div>
      <ul className="return-away__rows">
        {shown.map((l) => <AwayRow key={`${l.kind}:${l.runId ?? l.taskId}:${l.at}`} line={l} />)}
      </ul>
      {!folded && brief.more > 0 && <p className="return-away__more">另 {brief.more} 条</p>}
    </>
  );
}

/** 离开期间的一行：点开对应的任务（任务删了，行留着但不能点）. */
function AwayRow({ line }: { line: BriefLine }) {
  const alive = useApp((st) => !!line.taskId && !!st.tasks[line.taskId]);
  const Icon = LINE_ICON[line.kind];
  return (
    <li>
      <button type="button" className={cx('return-away__row', `is-${line.kind}`)} disabled={!alive} onClick={() => line.taskId && actions.openTask(line.taskId, line.runId)}>
        <span className="return-away__node" aria-hidden><Icon size={13} /></span>
        <span className="return-away__text">{line.text}{line.kind === 'failed' && <em>已留行迹</em>}</span>
        <span className="return-away__time">{hhmm(line.at)}</span>
      </button>
    </li>
  );
}

/** 称呼不拆行（「阁下」不拆开），其余按词断行（Words：词边界才许换行，没有单字行）. */
function keepName(text: string, name: string): ReactNode {
  const n = name.trim();
  if (!n || !text.includes(n)) return <Words text={text} />;
  const parts = text.split(n);
  // 称呼两侧是词边界（放 <wbr>），但标点要贴在前一个词后面，不在它们之间放断点.
  const closeAt = /^[」』）》〉】〕］｝”’)\]}，。、；：！？…—,.;:!?·]/;
  const openAt = /[「『（《〈【〔［｛“‘(\[{]$/;
  return parts.flatMap((part, i) => {
    const out: ReactNode[] = [<Words key={`w${i}`} text={part} />];
    if (i < parts.length - 1) {
      const next = parts[i + 1];
      out.push(<Fragment key={`n${i}`}>{part && !openAt.test(part) && !/\s$/.test(part) ? <wbr /> : null}<span className="nowrap">{n}</span>{next && !closeAt.test(next) && !/^\s/.test(next) ? <wbr /> : null}</Fragment>);
    }
    return out;
  });
}

/** 按句号分段：第一句是事，后面的（愿……）另起一行. */
const sentences = (text: string): string[] => text.match(/[^。]+。?/g)?.map((x) => x.trim()).filter(Boolean) ?? [text];

const LONG_AWAY_MS = 3 * 24 * 60 * 60_000;
const MAX_WANT = 3;

/** 待你的一行（纸面里）：图标盘 + 标题 + 已等时长 +「查看 / 回答」；不可逆项左边 3 px 金线 +「须亲批 · 不可逆」.
   点开后就在行内处理（与「待你」页同一份 QueueDetail）：批准没有单键、没有全局键. */
function WantRow({ item, now }: { item: QueueItem; now: number }) {
  const [open, setOpen] = useState(false);
  const uid = useId();
  const Icon = QUEUE_ICON[item.kind];
  const irreversible = useApp((s) => item.kind === 'approval' && s.runs[item.runId ?? '']?.approvals.find((a) => a.id === item.refId)?.risk === 'high');
  // 失败 / 待查看的行写「停在第 N 步 · 时刻」，不写「已等」：失败的事谈不上在等.
  const stopped = useApp((s) => {
    if (item.kind !== 'failed') return '';
    const r = item.runId ? s.runs[item.runId] : undefined;
    if (!r) return '';
    if (r.status === 'paused') return '被中断';
    const step = r.failure ? r.plan.find((p) => p.id === r.failure!.stepId) : undefined;
    return step ? `停在第 ${step.index + 1} 步` : '';
  });
  const waiting = MUST.has(item.kind);
  return (
    <li className={cx('bwant', irreversible && 'is-irreversible', open && 'is-open')}>
      <div className="bwant__head">
        <span className="bwant__disc" aria-hidden><Icon size={18} /></span>
        <div className="bwant__text">
          <span className="bwant__title" id={`${uid}-t`}>{item.title}</span>
          <span className="bwant__meta">
            <span>{QUEUE_LABEL[item.kind]}</span>
            <span className="return-sep" aria-hidden />
            {waiting
              ? <span className="bwant__wait">已等 {waitingText(item.since, now)}</span>
              : <>{stopped && <><span>{stopped}</span><span className="return-sep" aria-hidden /></>}<span className="bwant__wait">{hhmm(item.since)}</span></>}
            {irreversible && <b className="bwant__tag">须亲批 · 不可逆</b>}
          </span>
        </div>
        <button type="button" className="bwant__open" aria-expanded={open} aria-controls={`${uid}-d`} aria-describedby={`${uid}-t`} onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : OPEN_LABEL[item.kind]}
        </button>
      </div>
      {open && (
        <div className="bwant__detail" id={`${uid}-d`} tabIndex={-1}>
          <QueueDetail item={item} />
        </div>
      )}
    </li>
  );
}

/** 归来简：一张奶白纸面（夜昼同色）。头是她的头像（带表情角标）与名牌，右上是邮戳；
   正文先写事实，再把「待你」「离开期间」两个区块收进纸里；脚注说明来源。头在她的话层（data-her），
   事实与区块是内容层（data-card="brief"），里面没有头像与贴纸. */
function BriefPaper({ brief, items, now }: { brief: ReturnBrief; items: QueueItem[]; now: number }) {
  const to = brief.to ?? Date.now();
  const callName = useApp((s) => s.settings.callName);
  const say2 = useSay2();
  // 归来笺的开头按「话量」取句：brief.text 由 state/brief.ts 按旧的 distance 取（只分中 / 多），少档会落到中档的原句；
  // 这里把当前话量传给 say2，少档只取 return.brief.w.s*. 取不到就退回 brief.text.
  const lead = say2('return.brief', { away: brief.counts.away, done: brief.counts.done, failed: brief.counts.failed, replies: brief.counts.replies, waiting: brief.counts.waiting },
    { mode: 'work', seed: voiceSeed(to, '归来', 0) }).text || brief.text;
  const awayMs = brief.from !== undefined && brief.to !== undefined ? brief.to - brief.from : 0;
  // 离开 ≥3 天且没有待你、没有失败：归来简头部加一句 greet.away（不说「好久不见」）.
  const longAway = awayMs >= LONG_AWAY_MS && items.length === 0 && brief.counts.failed === 0
    ? say2('greet.away', { away: spanCn(brief.counts.away) }, { mode: 'work', facts: { pending: 0, failed: 0, awayMs, hasList: brief.lines.length > 0 } }).text
    : '';
  // 待你 = 须亲批 / 回答（与正文同一个数）；可看 = 失败、回合结束待查看. 纸面里一共最多 MAX_WANT 行，待你先占.
  const { must, look } = splitQueue(items, now);
  const wants = must.slice(0, MAX_WANT);
  const looks = look.slice(0, Math.max(0, MAX_WANT - wants.length));
  // 「全部 N」说的就是它所在区块的那个数；区块里的行没被折叠时写「待你页」，不拿另一个口径的数字来充.
  const mustMore = wants.length < must.length;
  const lookMore = looks.length < look.length;
  const jump = (id: string) => () => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'center', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    else actions.navigate('queue');
  };
  return (
    <article className="brief-paper" aria-label="归来简">
      <span className="brief-paper__rest" aria-hidden><Butterfly size={46} rotate={11} /></span>
      <span className="brief-paper__pm"><Postmark time={hhmm(to)} date={mmdd(to)} /></span>
      <header className="brief-paper__head" data-her>
        <HerAvatar size={52} expr="gentle" ring="none" />
        <div className="brief-paper__who">
          <NamePlate size="sm" />
          <span className="brief-paper__tag">归来简</span>
        </div>
      </header>
      <div className="brief-paper__thorn" aria-hidden />
      <div data-card="brief">
        {/* 事实胶囊：脚注说「数字都能点开追到日志」，数字就在这里——每个是按钮，跳到对应的行；待你 = 须亲批 / 回答的，与左栏同一个数 */}
        <ul className="brief-facts" aria-label="事实">
          {awayMs > 0 && <li><span className="brief-facts__away">离开 {awayText(awayMs)}</span></li>}
          {brief.counts.done > 0 && <li><button type="button" className="brief-facts__chip" onClick={jump('brief-away-h')}>完成 <b>{brief.counts.done}</b></button></li>}
          {brief.counts.failed > 0 && <li><button type="button" className="brief-facts__chip is-failed" onClick={jump(look.some((i) => i.kind === 'failed') ? 'brief-look-h' : 'brief-away-h')}>没走完 <b>{brief.counts.failed}</b></button></li>}
          {brief.counts.replies > 0 && <li><button type="button" className="brief-facts__chip" onClick={jump('brief-away-h')}>回复 <b>{brief.counts.replies}</b></button></li>}
          {must.length > 0 && <li><button type="button" className="brief-facts__chip is-want" onClick={jump('brief-want-h')}>待你 <b>{must.length}</b></button></li>}
        </ul>
        {longAway && <p className="brief-paper__text brief-paper__greet words">{keepName(longAway, callName)}</p>}
        {sentences(lead).map((t, i) => <p key={i} className="brief-paper__text words">{keepName(t, callName)}</p>)}
        <p className="brief-paper__src"><Info size={12} aria-hidden />据事件日志生成，数字都能点开追到日志<span className="return-sep" aria-hidden />未调用模型</p>

        {must.length > 0 && (
          <section className="brief-block" aria-labelledby="brief-want-h">
            <div className="return-hd">
              <Lamp size={16} aria-hidden className="return-hd__lamp" />
              <h2 id="brief-want-h">待你 <span className="return-hd__cnt">{must.length}</span></h2>
              <button type="button" className="return-hd__more" onClick={() => actions.navigate('queue')}>{mustMore ? `全部 ${must.length}` : '待你页'}<ArrowRight size={12} aria-hidden /></button>
            </div>
            <ul className="bwant-list" aria-label="待你">
              {wants.map((it) => <WantRow key={it.key} item={it} now={now} />)}
            </ul>
          </section>
        )}

        {look.length > 0 && (
          <section className={cx('brief-block', must.length > 0 && 'is-sub')} aria-labelledby="brief-look-h">
            <div className="return-hd">
              <h3 id="brief-look-h">可看 <span className="return-hd__cnt is-soft">{look.length}</span></h3>
              {(must.length === 0 || lookMore) && <button type="button" className="return-hd__more" onClick={() => actions.navigate('queue')}>{lookMore ? `全部 ${look.length}` : '待你页'}<ArrowRight size={12} aria-hidden /></button>}
            </div>
            {looks.length > 0 && (
              <ul className="bwant-list" aria-label="可看">
                {looks.map((it) => <WantRow key={it.key} item={it} now={now} />)}
              </ul>
            )}
          </section>
        )}

        {brief.lines.length > 0 && brief.from !== undefined && brief.to !== undefined && (
          <section className="brief-block return-away" aria-labelledby="brief-away-h">
            <AwayList brief={brief} headingId="brief-away-h" limit={3} />
          </section>
        )}
      </div>
    </article>
  );
}

/** 安静归来：同样的纸面和 52 px 头像（带角标）、同样的「归来简」小标，只写一句事实；脚注照旧说明来源.
   事实句：知道离开多久就写「离开 N 分钟，没有新事，也没有在等你的。」（无意象）. 不是有内容的归来简，所以不用 .brief-paper. */
function QuietPaper({ empty, at, awayMs }: { empty: boolean; at: number; awayMs: number }) {
  const text = empty ? '还没有任务。' : awayMs >= 60_000 ? `离开 ${awayText(awayMs)}，没有新事，也没有在等你的。` : '没有新事，也没有在等你的。';
  return (
    <article className="quiet-paper" aria-label="归来简">
      <span className="quiet-paper__pm"><Postmark time={hhmm(at)} date={mmdd(at)} /></span>
      <header className="quiet-paper__head" data-her>
        <HerAvatar size={52} expr="gentle" ring="none" />
        <div className="quiet-paper__who">
          <NamePlate size="sm" />
          <span className="brief-paper__tag">归来简</span>
        </div>
      </header>
      <div data-card="quiet">
        <p className="quiet-paper__text words" role="status"><Words text={text} /></p>
        <p className="quiet-paper__src"><Info size={12} aria-hidden />据事件日志生成<span className="return-sep" aria-hidden />未调用模型</p>
      </div>
    </article>
  );
}
