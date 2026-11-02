/* 消息下面的操作（施工图 §3.7、§3.9、§4.4 MessageActions）.
   她的话：复制 / 重新生成（闲聊最后一条，沿用）/ 让她换个说法 / 撤销换说法 / 记住这个（memoryOn）/ 今天别再说 · 不必回（主动话）/ 这句不用说（模板话）.
   用户的话：记住这个（memoryOn；预填她自己说的字，由用户确认）.
   这里不写 store：换说法走 live.rewriteHer（E），撤销走 actions.undoRewrite，记得小事走 actions.addMemory，
   「今天别再说 / 不必回 / 这句不用说」只经 noteDismiss 记进话语总闸（G8）. 记住这个只收用户自己的消息或用户在输入框里手打的字（§3.9-③）. */
import { BookmarkPlus, Check, Copy, RefreshCw, Shuffle, Undo2 } from 'lucide-react';
import { useRef, useState, type RefObject } from 'react';
import { guardEnter } from '../../lib/ime';
import type { Message } from '../../lib/types';
import { actions } from '../../state/actions';
import { regenerate, rewriteHer } from '../../state/live';
import { useApp } from '../../state/store';
import { noteDismiss } from '../../state/voiceGate';
import { canRewriteHer, sceneOf, sysKindOf } from '../her/logic';

/** 换说法的入口：ok = 直接给；slow = 命令行方式，旁边提示较慢；off = ACP 引擎不提供（§3.7）. */
export type RewriteMode = 'ok' | 'slow' | 'off';

const MEMORY_MAX = 80;

/** 表单（autoFocus 的输入框）收起时它连同焦点一起卸载，焦点会掉到 body；把焦点还给打开它的那颗「记住这个」，键盘用户不用从头 Tab，读屏也停在「记下了」状态字旁边. */
function giveBackFocus(trigger: RefObject<HTMLButtonElement | null>) {
  window.setTimeout(() => trigger.current?.focus(), 0);
}

function MemoryForm({ taskId, initial, onDone }: { taskId: string; initial: string; onDone: (msg?: string) => void }) {
  const [text, setText] = useState(initial);
  const [all, setAll] = useState(false);
  const [err, setErr] = useState('');
  const save = () => {
    const r = actions.addMemory(text, all ? undefined : taskId);
    if (r.ok) onDone('记下了');
    else setErr(r.error);
  };
  const len = Array.from(text).length;
  return (
    <div className="her-mem" role="group" aria-label="记住这个">
      <input
        className="input her-mem__input" value={text} aria-label="想让她记住的小事（最多 80 字）" placeholder="写下想让她记住的小事" autoComplete="off" spellCheck={false}
        maxLength={MEMORY_MAX * 2} autoFocus
        onChange={(e) => { setText(e.target.value); setErr(''); }}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && !e.nativeEvent.isComposing) { e.preventDefault(); e.stopPropagation(); onDone(); return; }
          guardEnter(e, save);
        }}
      />
      <label className="her-mem__scope"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} />所有对话都记得</label>
      <span className={`her-mem__count${len > MEMORY_MAX ? ' is-over' : ''}`}>{len}/{MEMORY_MAX}</span>
      <button type="button" className="her-act her-act--fill" disabled={!text.trim() || len > MEMORY_MAX} onClick={save}>记下</button>
      <button type="button" className="her-act" onClick={() => onDone()}>算了</button>
      {err && <span className="her-mem__err" role="alert">{err}</span>}
    </div>
  );
}

export function HerActions({ m, taskId, canRetry, copy, rewrite, memoryOn, resident = false, hasPills = false }: {
  m: Message; taskId: string; canRetry: boolean; copy: boolean; rewrite: RewriteMode; memoryOn: boolean;
  /** 对话里最后一条：操作行常驻，但只留「换个说法」，其余悬停 / 键盘聚焦才现（样稿 C 没有常驻的一排工具）. */
  resident?: boolean;
  /** 这条话下面有选项胶囊：退出只留在胶囊最后一个，操作行里不再重复「今天别再说 / 不必回」. */
  hasPills?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [memOpen, setMemOpen] = useState(false);
  const memBtn = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState('');
  const busy = useApp((s) => s.tasks[taskId]?.messages.some((x) => x.streaming) ?? false);
  const scene = sceneOf(m);

  const doCopy = async () => {
    try { await navigator.clipboard.writeText(m.text); setCopied(true); window.setTimeout(() => setCopied(false), 1500); } catch { /* clipboard blocked */ }
  };
  const doRewrite = async () => {
    setRewriting(true);
    setStatus('');
    try {
      const r = await rewriteHer(taskId, m.id);
      if (!r.ok) setStatus(r.error);
    } finally {
      setRewriting(false);
    }
  };
  const dismiss = (how: 'enough' | 'skip', said: string) => { noteDismiss(scene, how, Date.now()); setStatus(said); };

  const canRw = rewrite !== 'off' && canRewriteHer(m) && !busy;
  return (
    <div className={`ws-msg__actions her-actions${resident ? ' is-resident' : ''}`}>
      {copy && (
        <button type="button" className="ws-act" onClick={() => void doCopy()} aria-label={copied ? '已复制' : '复制这条回复'} title="复制">
          {copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
        </button>
      )}
      {copy && canRetry && (
        <button type="button" className="ws-act" disabled={busy} onClick={() => regenerate(taskId)} aria-label="重新生成这条回复" title="重新生成">
          <RefreshCw size={14} aria-hidden />
        </button>
      )}
      {canRw && (
        <button
          type="button" className="her-act her-act--rw" disabled={rewriting} onClick={() => void doRewrite()}
          title={rewrite === 'slow' ? '命令行方式较慢，要等一会儿' : '只重写她这一句，不会重新做事'}
          aria-label={rewrite === 'slow' ? '让她换个说法（命令行方式较慢）' : '让她换个说法'}
        >
          <Shuffle size={13} aria-hidden />{rewriting ? '换说法中…' : '换个说法'}
        </button>
      )}
      {m.prevText !== undefined && !m.streaming && (
        <button type="button" className="her-act" onClick={() => actions.undoRewrite(taskId, m.id)} title="换回原来的那一句">
          <Undo2 size={13} aria-hidden />撤销
        </button>
      )}
      {memoryOn && !m.streaming && !m.crisis && (
        <button ref={memBtn} type="button" className="her-act" aria-expanded={memOpen} onClick={() => setMemOpen((v) => !v)}>
          <BookmarkPlus size={13} aria-hidden />记住这个
        </button>
      )}
      {m.proactive && !m.streaming && !hasPills && (
        <>
          {/* 有系统行的话，系统行上已经有「今天别再说 / 今天别再提醒」，这里不再摆第二个（第 1 轮评审：三处几乎一样的退出控件）. */}
          {!sysKindOf(m) && <button type="button" className="her-act" onClick={() => dismiss('enough', '今天不再主动说话了')}>今天别再说</button>}
          <button type="button" className="her-act" onClick={() => dismiss('skip', '这类话今天不再出现')}>不必回</button>
        </>
      )}
      {!m.proactive && m.src && !m.streaming && !m.crisis && (
        <button type="button" className="her-act" onClick={() => dismiss('skip', '这句话今天不再出现')} title="这一类话今天不再说">这句不用说</button>
      )}
      {status && <span className="her-act__status" role="status" aria-live="polite">{status}</span>}
      {memOpen && <MemoryForm taskId={taskId} initial="" onDone={(msg) => { setMemOpen(false); if (msg) setStatus(msg); giveBackFocus(memBtn); }} />}
    </div>
  );
}

export function UserActions({ m, taskId }: { m: Message; taskId: string }) {
  const [open, setOpen] = useState(false);
  const openBtn = useRef<HTMLButtonElement>(null);
  const [status, setStatus] = useState('');
  return (
    <div className="ws-msg__actions her-actions her-actions--me">
      <button ref={openBtn} type="button" className="her-act" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <BookmarkPlus size={13} aria-hidden />记住这个
      </button>
      {status && <span className="her-act__status" role="status" aria-live="polite">{status}</span>}
      {open && <MemoryForm taskId={taskId} initial={Array.from(m.text.trim()).slice(0, MEMORY_MAX).join('')} onDone={(msg) => { setOpen(false); if (msg) setStatus(msg); giveBackFocus(openBtn); }} />}
    </div>
  );
}
