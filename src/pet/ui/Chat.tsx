/* 她头顶的聊天框：她是谁、在做什么、最近说过的一切（记录在主进程，聊天框或窗口关了再开都还在）、输入框。
   栖枝新加的：标题下的接龙 / 童话状态条（「接龙中 · 轮到你，接「棠」」+「不玩了」）、童话画成信笺（可存下）、
   占卜翻出的牌、菜单里「我们写过的童话」。开关、键盘归主进程（electron/pet/window.cjs），这里只显示收到的东西。
   「不闪」的做法照萤火 §10：窗口一直是聊天框打开时的大小，聊天框开关只是这一块里画不画。 */
import { memo, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent, type PointerEvent } from 'react';
import type { PetChatEntry, PetGameState, PetTale } from '../contracts';
import { CHAT_INPUT_MAX, atEnd, cardIcon, chatActivity, composerKey, fullText, gameBar, startsRun, taleSaved, taleView } from './chatLog';
import { TAROT_CARDS } from './games';

const WORDS = { name: '遐蝶', idle: '在这里', think: '在想…', typing: '正在写…', empty: '还没有聊过。想说什么都可以。', placeholder: '和她说点什么…' };

const clock = (at: number) => new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
const day = (at: number) => new Date(at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

interface Props {
  log: PetChatEntry[];
  draft: string;
  setDraft(v: string): void;
  /** 窗口此刻拿着键盘。 */
  keys: boolean;
  /** 主进程每打开一次（再次）聊天框加一：光标回到输入框。 */
  opened: number;
  /** 大脑发来的小游戏状态（接龙 / 童话进行中）。 */
  game: PetGameState | null;
  /** 头像（裁好的 data: 地址）；还没好时用底色圆。 */
  avatar: string | null;
  onSend(text: string): void;
  onClose(): void;
  /** 别的窗口拿着键盘时点进了聊天框。 */
  onTakeKeys(): void;
  /** 状态条上的「不玩了」。 */
  onStopGame(kind: 'chain' | 'tale'): void;
  /** 「存下」一篇童话。成功返回 true。 */
  onSaveTale(e: PetChatEntry): Promise<boolean>;
  /** 读存下的童话（新的在前）。 */
  loadTales(): Promise<PetTale[]>;
}

export function ChatPanel({ log, draft, setDraft, keys, opened, game, avatar, onSend, onClose, onTakeKeys, onStopGame, onSaveTale, loadTales }: Props) {
  const w = WORDS;
  const box = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  /** 跟着最新一条走，除非用户往上翻了。 */
  const stick = useRef(true);
  const [behind, setBehind] = useState(false);
  const [menu, setMenu] = useState(false);
  const [view, setView] = useState<'log' | 'tales'>('log');
  /** 存下的童话（名单页用；信笺的「已存下」也看它的 id）。null = 还没读。 */
  const [tales, setTales] = useState<PetTale[] | null>(null);
  /** 这次打开期间刚存下的信笺（消息 id）。 */
  const [savedNow, setSavedNow] = useState<ReadonlySet<string>>(new Set());
  const doing = chatActivity(log);
  const bar = gameBar(game);
  const hasTale = log.some((e) => e.kind === 'tale');
  const ids = new Set((tales ?? []).map((t) => t.id));

  // 每次主进程打开聊天框（它刚让窗口拿了键盘），光标进输入框。
  useEffect(() => { box.current?.focus(); }, [opened]);
  // 点回聊天框时窗口重新拿键盘：光标回输入框，除非点的是自己要用键盘的（输入框、按钮）或消息文字（要选字）。
  const caretBack = useRef(false);
  useEffect(() => {
    if (!keys || !caretBack.current) return;
    caretBack.current = false;
    if (!window.getSelection()?.isCollapsed) return;
    box.current?.focus();
  }, [keys]);
  const pressed = (e: PointerEvent<HTMLElement>) => {
    if (document.hasFocus()) return;
    caretBack.current = !(e.target as Element).closest?.('textarea, input, button, .pet-msg__text, .pet-letter');
    onTakeKeys();
  };

  // 记录里有信笺时读一次存下的名单，好显示「已存下」。
  useEffect(() => {
    if (!hasTale || tales) return;
    let live = true;
    loadTales().then((t) => { if (live) setTales(t); }, () => { if (live) setTales([]); });
    return () => { live = false; };
  }, [hasTale, tales, loadTales]);

  // Esc：先收菜单、再退出童话名单、最后关聊天框（输入法选字时 Esc 归输入法）。
  useEffect(() => {
    const down = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || composerKey(e) !== 'close') return;
      e.preventDefault();
      if (menu) setMenu(false);
      else if (view === 'tales') setView('log');
      else onClose();
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [onClose, menu, view]);

  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setBehind(true);
  }, [log, view]);

  const scrolled = () => {
    const el = list.current;
    if (!el) return;
    stick.current = atEnd(el.scrollTop, el.scrollHeight, el.clientHeight);
    if (stick.current) setBehind(false);
  };
  const toEnd = () => {
    const el = list.current;
    stick.current = true;
    setBehind(false);
    if (el) el.scrollTop = el.scrollHeight;
  };

  const send = (e?: FormEvent) => {
    e?.preventDefault();
    const v = draft.trim();
    if (!v) return;
    setView('log');
    toEnd();
    onSend(v);
    setDraft('');
    box.current?.focus();
  };
  const boxKeys = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composerKey({ key: e.key, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing, keyCode: e.keyCode }) !== 'send') return;
    e.preventDefault();
    send();
  };

  const openTales = () => {
    setMenu(false);
    setView('tales');
    loadTales().then(setTales, () => setTales([]));
  };
  const save = async (e: PetChatEntry) => {
    if (await onSaveTale(e)) {
      setSavedNow((s) => new Set(s).add(e.id));
      loadTales().then(setTales, () => {});
    }
  };

  return (
    <section className="pet-chat" data-hit data-keys={keys ? '' : undefined} aria-label={`和${w.name}聊天`} onPointerDown={pressed}>
      <header className="pet-chat__head">
        <Avatar src={avatar} />
        <div className="pet-chat__who">
          <strong className="pet-chat__name">{w.name}</strong>
          <span className="pet-chat__state" data-doing={doing ?? undefined}>
            {doing === 'think' ? w.think : doing === 'typing' ? w.typing : w.idle}
          </span>
        </div>
        <button type="button" className="pet-chat__icon" aria-label="更多" aria-expanded={menu} title="更多" onClick={() => setMenu((m) => !m)}><MoreIcon /></button>
        <button type="button" className="pet-chat__icon pet-chat__close" aria-label="关闭聊天框" title="关闭（Esc）" onClick={onClose}>×</button>
        {menu && (
          <div className="pet-chat__menu" role="menu">
            <button type="button" role="menuitem" onClick={openTales}>我们写过的童话</button>
          </div>
        )}
      </header>
      {bar && (
        <div className="pet-chat__game" data-kind={bar.kind} role="status" aria-live="polite">
          <span className="pet-chat__gametext">{bar.text}</span>
          <button type="button" className="pet-chat__stop" onClick={() => onStopGame(bar.kind)}>不玩了</button>
        </div>
      )}
      <div className="pet-chat__body">
        {view === 'tales' ? (
          <div className="pet-chat__log pet-tales" role="region" aria-label="我们写过的童话">
            <button type="button" className="pet-tales__back" onClick={() => setView('log')}>← 回到聊天</button>
            {tales === null && <p className="pet-chat__empty">在翻…</p>}
            {tales?.length === 0 && <p className="pet-chat__empty">还没有存下的童话。写好之后点信笺下面的「存下」。</p>}
            {tales?.map((t) => <TaleCard key={t.id} tale={t} />)}
          </div>
        ) : (
          <div ref={list} className="pet-chat__log" role="log" aria-live="polite" aria-label="聊天记录" aria-busy={doing ? true : undefined}
            tabIndex={0} onScroll={scrolled}>
            {log.length === 0 && <p className="pet-chat__empty">{w.empty}</p>}
            {log.map((e, i) => (
              <Message key={e.id} entry={e} avatar={avatar} first={startsRun(log, i)} saved={e.kind === 'tale' && taleSaved(e, savedNow, ids)} onSave={save} />
            ))}
          </div>
        )}
        {/* 放在记录上而不是面板上：草稿写了好几行时输入框会变高。 */}
        {behind && view === 'log' && <button type="button" className="pet-chat__new" onClick={toEnd}>新消息 ↓</button>}
      </div>
      <form className="pet-chat__composer" onSubmit={send}>
        <textarea ref={box} className="pet-chat__input" rows={1} value={draft} maxLength={CHAT_INPUT_MAX} spellCheck={false}
          aria-label={`对${w.name}说的话`} placeholder={w.placeholder} onChange={(e) => setDraft(e.target.value)} onKeyDown={boxKeys} />
        {draft.length > CHAT_INPUT_MAX - 100 && <span className="pet-chat__count" aria-live="polite">{draft.length}/{CHAT_INPUT_MAX}</span>}
        <button type="submit" className="pet-chat__send" aria-label="发送" title="发送（Enter）" disabled={!draft.trim()}><SendIcon /></button>
      </form>
    </section>
  );
}

const Message = memo(function Message({ entry: e, avatar, first, saved, onSave }: {
  entry: PetChatEntry; avatar: string | null; first: boolean; saved: boolean; onSave(e: PetChatEntry): Promise<unknown>;
}) {
  const thinking = e.who === 'her' && e.streaming && e.mood === 'think';
  const lead = e.who === 'her' && (first ? <Avatar src={avatar} /> : <span className="pet-msg__gap" />);
  if (e.kind === 'tale' && e.who === 'her') {
    return (
      <div className="pet-msg" data-who="her" data-first={first ? '' : undefined} data-kind="tale">
        {lead}
        <Letter entry={e} saved={saved} onSave={onSave} />
      </div>
    );
  }
  const card = e.kind === 'card' && e.card ? TAROT_CARDS.find((c) => c.id === e.card) : undefined;
  return (
    <div className="pet-msg" data-who={e.who} data-first={first ? '' : undefined} data-streaming={e.streaming && !thinking ? '' : undefined}
      data-think={thinking ? '' : undefined} data-kind={e.kind === 'card' ? 'card' : undefined}>
      {lead}
      <p className="pet-msg__text" title={clock(e.at)}>
        {e.kind === 'card' && e.card && (
          <span className="pet-msg__card">
            <img src={cardIcon(e.card)} alt="" width={26} height={26} />
            <b>{card?.name ?? e.card}</b>
          </span>
        )}
        {e.voice && <span className="pet-msg__voice" title="语音"><MicIcon /></span>}
        {fullText(e)}
        {thinking && <span className="pet-dots" aria-hidden><i /><i /><i /></span>}
      </p>
    </div>
  );
});

/** 童话信笺：米白纸、衬线体、标题；下面「存下」。 */
function Letter({ entry: e, saved, onSave }: { entry: PetChatEntry; saved: boolean; onSave(e: PetChatEntry): Promise<unknown> }) {
  const { title, body } = taleView(e);
  const [busy, setBusy] = useState(false);
  return (
    <article className="pet-letter" data-streaming={e.streaming ? '' : undefined} aria-label={title ? `童话《${title}》` : '童话'}>
      {title && <h4 className="pet-letter__title">{title}</h4>}
      <p className="pet-letter__body">{body}</p>
      {!e.streaming && (
        <footer className="pet-letter__foot">
          <button type="button" className="pet-letter__save" disabled={saved || busy} data-saved={saved ? '' : undefined}
            onClick={async () => { setBusy(true); try { await onSave(e); } finally { setBusy(false); } }}>
            {saved ? '已存下' : busy ? '存着…' : '存下'}
          </button>
        </footer>
      )}
    </article>
  );
}

/** 「我们写过的童话」名单里的一篇：点标题展开 / 收起。 */
function TaleCard({ tale }: { tale: PetTale }) {
  const [open, setOpen] = useState(false);
  return (
    <article className="pet-letter pet-letter--list" data-open={open ? '' : undefined}>
      <button type="button" className="pet-letter__head" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <h4 className="pet-letter__title">{tale.title || '无题'}</h4>
        <span className="pet-letter__meta">{day(tale.at)}{tale.words.length ? ` · ${tale.words.join('、')}` : ''}</span>
      </button>
      {open && <p className="pet-letter__body">{tale.text}</p>}
    </article>
  );
}

/** 她的脸，从母版图里裁的（avatar.ts）；还没好时只有底色圆。 */
function Avatar({ src }: { src: string | null }) {
  return <span className="pet-avatar" aria-hidden style={src ? { backgroundImage: `url(${src})` } : undefined} />;
}

function SendIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />
    </svg>
  );
}
function MoreIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden>
      <circle cx="5" cy="12" r="1.8" /><circle cx="12" cy="12" r="1.8" /><circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
