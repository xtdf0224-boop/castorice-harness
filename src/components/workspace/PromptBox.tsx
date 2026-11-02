/* 输入框：一个圆角框，上面是文字，下面一行小芯片（类型、模型、目录、权限）和一个圆形发送键，回复中变成停止键。
   首页是「信封」样式——地址行「寄往 目录 · 引擎 · 手套」在文字上方，航空信边在顶；任务页里是贴底的细长条。
   Enter 发送，Shift+Enter 换行；输入法组合期间（拼音候选未上屏）Enter 是选字，不发送（lib/ime.ts）. */
import { ArrowRight, ArrowUp, Square } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, type ChangeEvent, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { clearDraft, setDraft } from '../../lib/draft';
import { guardEnter } from '../../lib/ime';
import { cx } from '../ui';
import '../../styles/interaction-composer.css';

export interface PromptBoxProps {
  variant: 'home' | 'docked';
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  label: string;
  /** Chips on the left of the bottom row. */
  chips?: ReactNode;
  /** 信封样式的地址行（「寄往 目录 · 引擎 · 手套」）：有它就是信封，航空信边与地址行在文字上方. */
  addr?: ReactNode;
  /** Small line under the box. */
  hint?: ReactNode;
  /** A reply is being written: the send button becomes 停止. */
  busy?: boolean;
  onStop?: () => void;
  /** Send is allowed with an empty box (e.g. a chat may start empty). */
  allowEmpty?: boolean;
  sending?: boolean;
  /** Why nothing can be sent right now (e.g. no model is set up). Typing still works; the reason is the send button's tooltip. */
  blocked?: string;
  invalid?: boolean;
  describedBy?: string;
  inputRef?: Ref<HTMLTextAreaElement>;
  minRows?: number;
  maxRows?: number;
  id?: string;
  /** 草稿登记的键（任务 id）：有它，输入变化时 setDraft、发送 / 清空 / 卸载时 clearDraft，主动搭话（canNudge）据此不打断正在写的人. */
  draftKey?: string;
}

export function PromptBox({
  variant, value, onChange, onSubmit, placeholder, label, chips, addr, hint, busy, onStop, allowEmpty, sending, blocked, invalid, describedBy, inputRef,
  minRows = variant === 'home' ? (addr ? 2 : 3) : 1, maxRows = 8, id, draftKey,
}: PromptBoxProps) {
  const own = useRef<HTMLTextAreaElement | null>(null);
  const setRef = useCallback((el: HTMLTextAreaElement | null) => {
    own.current = el;
    if (typeof inputRef === 'function') inputRef(el);
    else if (inputRef && typeof inputRef === 'object') (inputRef as { current: HTMLTextAreaElement | null }).current = el;
  }, [inputRef]);

  // Grow with the text between minRows and maxRows.
  useLayoutEffect(() => {
    const el = own.current;
    if (!el) return;
    el.style.height = 'auto';
    const cs = getComputedStyle(el);
    const line = Number.parseFloat(cs.lineHeight) || 22;
    const pad = Number.parseFloat(cs.paddingTop) + Number.parseFloat(cs.paddingBottom);
    const min = line * minRows + pad;
    const max = line * maxRows + pad;
    el.style.height = `${Math.min(Math.max(el.scrollHeight, min), max)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
  }, [value, minRows, maxRows]);

  // 草稿登记：组件本地状态别人读不到，所以在这里告诉 draft.ts（空白等同清除）.
  useEffect(() => {
    if (draftKey) setDraft(draftKey, value);
  }, [draftKey, value]);
  useEffect(() => () => { if (draftKey) clearDraft(draftKey); }, [draftKey]);

  const empty = !value.trim();
  const canSend = !sending && !blocked && (allowEmpty || !empty);
  const send = () => {
    if (!canSend) return;
    if (draftKey) clearDraft(draftKey);
    onSubmit();
  };
  // 组合态的回车是选字（isComposing 或 keyCode 229），交给输入法；Shift+Enter 换行.
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter') return;
    if (e.shiftKey && !e.ctrlKey && !e.metaKey) return;
    guardEnter(e, send, { allowModified: true });
  };

  return (
    <div className={cx('pbox', `pbox--${variant}`, !!addr && 'pbox--envelope', invalid && 'is-invalid', busy && 'is-busy')}>
      <div className="pbox__box" onClick={(e) => { if (e.target === e.currentTarget) own.current?.focus(); }}>
        {addr && <div className="pbox__stripe" aria-hidden />}
        {addr && <div className="pbox__addr">{addr}</div>}
        <label className="sr-only" htmlFor={id}>{label}</label>
        <textarea
          id={id}
          ref={setRef}
          className="pbox__input"
          rows={minRows}
          value={value}
          placeholder={placeholder}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(e: ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="pbox__bar">
          <div className="pbox__chips">{chips}</div>
          {busy && onStop ? (
            <button type="button" className="pbox__send is-stop" aria-label="停止回复" title="停止回复" onClick={onStop}>
              <Square size={13} aria-hidden fill="currentColor" />
            </button>
          ) : (
            <button type="button" className="pbox__send" aria-label={`${label}：发送`} title={blocked ?? '发送（Enter）'} disabled={!canSend} onClick={send}>
              {addr ? <><ArrowRight size={15} aria-hidden /><span>发送</span></> : <ArrowUp size={18} aria-hidden />}
            </button>
          )}
        </div>
      </div>
      {hint && <p className="pbox__hint">{hint}</p>}
    </div>
  );
}
