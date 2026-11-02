/* 下拉菜单: the app's own select. A chip (or a form field) that opens a floating list drawn in the
   Firefly / SAM style — grouped options with a title, a second line and a right-hand note, a check on
   the current one, a filter box when the list is long. It replaces native <select> menus, which
   Windows draws as white boxes with unreadable group headers.

   For long lists (模型接入's model picker, the task menu's 「更多…」) it also offers: small tags after the label, a ★ toggle per row,
   a cap on the rows drawn (`maxRows`, the rest is reached by typing), a last row 「用输入的作为…」 (`typed`), a slot above the list (`top`:
   refresh, failure notice) and rows that swap the list in place (`keepOpen`). The filter box is input-method safe: while a pinyin
   composition is open nothing is filtered and Enter / Esc / arrows belong to the input method (MODELS-SPEC §14.3, §14.6).

   Accessibility: the trigger is a button with aria-haspopup="listbox"; the open list is a listbox
   driven by aria-activedescendant (focus stays in the filter box or on the list). Arrow keys, Home /
   End, PageUp / PageDown, Enter / Space, Escape and Tab work as in a native select, and typing jumps
   to the first match when there is no filter box. */
import { Check, ChevronDown, Search, Star, type LucideIcon } from 'lucide-react';
import { useCallback, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type CompositionEvent, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { isComposingEvent } from '../../lib/ime';
import { cx } from './index';

export interface MenuTag { text: string; tone?: 'neutral' | 'info' | 'warning' | 'success'; title?: string }

export interface MenuOption<T extends string = string> {
  value: T;
  /** Main line, e.g. 「Claude Sonnet 5.5」. */
  label: string;
  /** Second line, e.g. the model id or a short description. */
  sub?: string;
  /** Small text on the right, e.g. 「1M 上下文」. */
  meta?: string;
  disabled?: boolean;
  icon?: LucideIcon;
  /** Text the filter also matches (aliases, ids…) but nobody sees. */
  keywords?: string;
  /** Small tags after the label (预览、将下线、实时…). Plain text. */
  tags?: MenuTag[];
  /** A ★ toggle at the end of the row. Clicking it never picks the row; Ctrl+Enter toggles it for the highlighted row. */
  star?: { on: boolean; label: string; onToggle: () => void };
  /** Picking this row calls onChange and leaves the list open (a 「更多…」 row swaps the list in place). */
  keepOpen?: boolean;
}
export interface MenuGroup<T extends string = string> {
  /** Group title; omit for an untitled group. */
  label?: string;
  /** Small text next to the title. */
  hint?: string;
  options: Array<MenuOption<T>>;
}

export interface MenuSelectProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the control (also the filter box's label). */
  label: string;
  options?: Array<MenuOption<T>>;
  groups?: Array<MenuGroup<T>>;
  /** 'chip': a small pill for the message box; 'field': a full-width form control. */
  variant?: 'chip' | 'field';
  icon?: LucideIcon;
  /** Text on the closed control; defaults to the selected option's label. */
  display?: ReactNode;
  /** Shown on the closed control when nothing matches `value`. */
  placeholder?: string;
  title?: string;
  disabled?: boolean;
  /** Filter box: 'auto' shows it from 10 options up; `searchable` (or true) always shows it. */
  search?: boolean | 'auto';
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Extra content under the list (e.g. a link to settings). */
  footer?: ReactNode;
  /** Content between the filter box and the list (a refresh button, a failure notice). */
  top?: ReactNode;
  /** At most this many rows are drawn; the rest is reached by typing (a line says how many are left). */
  maxRows?: number;
  /** A last row for whatever was typed: shown when `accept(query)` and the query is not one of the options' values. */
  typed?: { accept: (query: string) => boolean; label: (query: string) => string; sub?: string };
  /** Shown instead of 「没有匹配的选项」 when the list is empty (no query). */
  empty?: ReactNode;
  /** Told when the list opens or closes. */
  onOpenChange?: (open: boolean) => void;
  className?: string;
  /** Extra class on the floating list (e.g. a wider one). */
  popClassName?: string;
  id?: string;
  /** Minimum width of the open list in px. */
  minWidth?: number;
}

/* ───────────── pure helpers (also used by the checks) ───────────── */

const haystack = (o: MenuOption, g: MenuGroup) => `${o.label} ${o.sub ?? ''} ${o.meta ?? ''} ${o.keywords ?? ''} ${(o.tags ?? []).map((t) => t.text).join(' ')} ${g.label ?? ''}`.toLowerCase();

/** The groups with only the options that contain every word of the query (case-insensitive); empty groups drop out. */
export function filterGroups<T extends string>(groups: Array<MenuGroup<T>>, query: string): Array<MenuGroup<T>> {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  return groups.map((g) => ({ ...g, options: g.options.filter((o) => { const h = haystack(o, g); return words.every((w) => h.includes(w)); }) })).filter((g) => g.options.length);
}

/** At most `max` options in total (groups keep their order; a group with nothing left drops out). `hidden` = how many were cut. */
export function windowGroups<T extends string>(groups: Array<MenuGroup<T>>, max: number | undefined): { groups: Array<MenuGroup<T>>; shown: number; hidden: number } {
  const total = groups.reduce((n, g) => n + g.options.length, 0);
  if (!max || total <= max) return { groups, shown: total, hidden: 0 };
  let left = max;
  const out: Array<MenuGroup<T>> = [];
  for (const g of groups) {
    if (left <= 0) break;
    const options = g.options.slice(0, left);
    left -= options.length;
    out.push({ ...g, options });
  }
  return { groups: out, shown: max, hidden: total - max };
}

/**
 * The text of a filter box that does not react to a half-typed pinyin: `change` while an input method is composing only updates the draft;
 * the filter (`commit`) follows when the composition ends, or on any ordinary edit. Pure state machine, no DOM.
 */
export function composedText(commit: (value: string) => void, onDraft?: (value: string) => void) {
  let composing = false;
  return {
    get composing() { return composing; },
    start() { composing = true; },
    change(value: string, isComposing = false) { onDraft?.(value); if (!composing && !isComposing) commit(value); },
    end(value: string) { composing = false; onDraft?.(value); commit(value); },
    reset() { composing = false; },
  };
}

/** React side of composedText: `draft` is what the box shows, `query` what filters. */
export function useComposedText() {
  const [draft, setDraft] = useState('');
  const [query, setQuery] = useState('');
  const machine = useRef<ReturnType<typeof composedText> | null>(null);
  if (!machine.current) machine.current = composedText(setQuery, setDraft);
  const m = machine.current;
  const bind = {
    value: draft,
    onChange: (e: ChangeEvent<HTMLInputElement>) => m.change(e.target.value, (e.nativeEvent as InputEvent).isComposing === true),
    onCompositionStart: () => m.start(),
    onCompositionEnd: (e: CompositionEvent<HTMLInputElement>) => m.end(e.currentTarget.value),
  };
  const clear = useCallback(() => { m.reset(); setDraft(''); setQuery(''); }, [m]);
  return { draft, query, bind, clear, setBoth: (v: string) => { setDraft(v); setQuery(v); } };
}

const MARGIN = 8;
const GAP = 6;
const TYPED_KEY = '\u0000typed';

export function MenuSelect<T extends string>({
  value, onChange, label, options, groups, variant = 'chip', icon: Icon, display, placeholder, title, disabled, search = 'auto', searchable, searchPlaceholder, footer, top, maxRows, typed, empty,
  onOpenChange, className, popClassName, id, minWidth = 240,
}: MenuSelectProps<T>) {
  const all = useMemo<Array<MenuGroup<T>>>(() => groups ?? [{ options: options ?? [] }], [groups, options]);
  const flat = useMemo(() => all.flatMap((g) => g.options), [all]);
  const current = flat.find((o) => o.value === value);
  const showSearch = searchable === true || search === true || (search === 'auto' && (flat.length >= 10 || !!typed));

  const [open, setOpen] = useState(false);
  const text = useComposedText();
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const typedKeys = useRef({ text: '', at: 0 });
  /** The highlight follows the keyboard into view; a hovering pointer must not scroll the list, or the
      list would slide under a resting cursor and keep changing what is under it. */
  const follow = useRef(false);
  const base = useId();
  const listId = `${base}-list`;
  const optId = (i: number) => `${base}-o${i}`;

  // What the open list shows: filtered by the committed query (not a half-typed pinyin), cut to `maxRows`, plus the 「用输入的…」 row.
  const q = useDeferredValue(text.query.trim());
  const filtered = useMemo(() => filterGroups(all, q), [all, q]);
  const windowed = useMemo(() => windowGroups(filtered, maxRows), [filtered, maxRows]);
  const typedOption = useMemo<MenuOption<T> | null>(() => {
    if (!typed || !q || !typed.accept(q) || flat.some((o) => o.value === q)) return null;
    return { value: q as T, label: typed.label(q), sub: typed.sub, icon: undefined };
  }, [typed, q, flat]);
  const shown = windowed.groups;
  const shownFlat = useMemo(() => [...shown.flatMap((g) => g.options), ...(typedOption ? [typedOption] : [])], [shown, typedOption]);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    text.clear();
    if (refocus) trigger.current?.focus();
  }, [text.clear]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the owner when the list opens or closes (not on the first render).
  const told = useRef(onOpenChange);
  told.current = onOpenChange;
  const first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } told.current?.(open); }, [open]);

  const openMenu = () => {
    if (disabled) return;
    const i = flat.findIndex((o) => o.value === value);
    follow.current = true;
    setActive(i >= 0 ? i : flat.findIndex((o) => !o.disabled));
    setOpen(true);
  };

  // Place the list under the control, or above it when there is more room there; keep it on screen.
  const place = useCallback(() => {
    const t = trigger.current;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const below = window.innerHeight - r.bottom - GAP - MARGIN;
    const above = r.top - GAP - MARGIN;
    const down = below >= 320 || below >= above;
    const width = Math.max(r.width, minWidth);
    const popW = pop.current?.offsetWidth ?? width;
    const left = Math.max(MARGIN, Math.min(r.left, window.innerWidth - popW - MARGIN));
    setPos({
      left,
      minWidth: width,
      maxHeight: Math.max(160, down ? below : above),
      ...(down ? { top: r.bottom + GAP } : { bottom: window.innerHeight - r.top + GAP }),
    });
  }, [minWidth]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // Second pass once the list has its real width.
    const raf = requestAnimationFrame(place);
    return () => cancelAnimationFrame(raf);
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    (showSearch ? input.current : list.current)?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (pop.current?.contains(t) || trigger.current?.contains(t)) return;
      close(false);
    };
    const onMove = (e: Event) => { if (!pop.current?.contains(e.target as Node)) place(); };
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', onMove, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [open, showSearch, close, place]);

  // Filtering resets the highlight to the first match.
  useEffect(() => { if (open && q) { follow.current = true; setActive(shownFlat.findIndex((o) => !o.disabled)); } }, [q, open, shownFlat]);

  // Keep a keyboard-moved highlight in view, scrolling only the list itself.
  useEffect(() => {
    if (!open || active < 0 || !follow.current) return;
    const el = document.getElementById(optId(active));
    const box = list.current;
    if (!el || !box) return;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    if (r.top < b.top + 4) box.scrollTop -= b.top + 4 - r.top;
    else if (r.bottom > b.bottom - 4) box.scrollTop += r.bottom - (b.bottom - 4);
  }, [active, open, shownFlat]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Tab out of the open list: hand focus back to the control first, so the browser moves on from there. */
  const leave = () => {
    trigger.current?.focus({ preventScroll: true });
    close(false);
  };

  const pick = (o: MenuOption<T> | undefined) => {
    if (!o || o.disabled) return;
    if (o.keepOpen) { text.clear(); follow.current = true; setActive(0); onChange(o.value); return; }
    close();
    if (o.value !== value || o === typedOption) onChange(o.value);
  };

  const move = (from: number, step: number) => {
    const n = shownFlat.length;
    if (!n) return -1;
    let i = from;
    for (let k = 0; k < n; k++) {
      i = Math.max(0, Math.min(n - 1, i + step));
      if (!shownFlat[i].disabled) return i;
      if ((step > 0 && i === n - 1) || (step < 0 && i === 0)) break;
    }
    return from;
  };

  const onListKey = (e: KeyboardEvent) => {
    // 搜索框里输入法正在组合：回车是选字、Esc 是取消组合、方向键翻候选，都先交给输入法.
    if (isComposingEvent(e)) return;
    follow.current = true;
    // The footer (e.g. 「管理模型接入」) and the top slot (e.g. 「刷新」) are reached with Tab and work like any button.
    const target = e.target as HTMLElement;
    const inFoot = !!target.closest?.('.mselect-pop__foot');
    const inTop = !!target.closest?.('.mselect-pop__top');
    if (inFoot || inTop) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      else if (inFoot && e.key === 'Tab' && e.shiftKey) { e.preventDefault(); (showSearch ? input.current : list.current)?.focus(); }
      else if (e.key === 'Tab' && !e.shiftKey && inFoot) leave();
      return;
    }
    if (e.key === 'Tab' && !e.shiftKey) {
      const first = pop.current?.querySelector<HTMLElement>('.mselect-pop__top button, .mselect-pop__foot button, .mselect-pop__foot a[href]');
      if (first) { e.preventDefault(); first.focus(); return; }
    }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); setActive((a) => move(a, 1)); return;
      case 'ArrowUp': e.preventDefault(); setActive((a) => move(a < 0 ? shownFlat.length : a, -1)); return;
      case 'PageDown': e.preventDefault(); setActive((a) => move(a, 6)); return;
      case 'PageUp': e.preventDefault(); setActive((a) => move(a, -6)); return;
      case 'Home': if (showSearch) return; e.preventDefault(); setActive(move(-1, 1)); return;
      case 'End': if (showSearch) return; e.preventDefault(); setActive(move(shownFlat.length, -1)); return;
      case 'Enter': {
        e.preventDefault();
        const o = shownFlat[active];
        if (e.ctrlKey && o?.star) { o.star.onToggle(); return; }
        pick(o);
        return;
      }
      case ' ': if (showSearch) return; e.preventDefault(); pick(shownFlat[active]); return;
      case 'Escape':
        // Esc clears a typed query first, closes second.
        e.preventDefault(); e.stopPropagation();
        if (text.draft) { text.clear(); return; }
        close();
        return;
      case 'Tab': leave(); return;
      default:
        // Type to jump (no filter box).
        if (!showSearch && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          const now = Date.now();
          typedKeys.current = { text: (now - typedKeys.current.at < 700 ? typedKeys.current.text : '') + e.key.toLowerCase(), at: now };
          const hit = shownFlat.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typedKeys.current.text));
          if (hit >= 0) setActive(hit);
        }
    }
  };

  const onTriggerKey = (e: KeyboardEvent) => {
    if (open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openMenu(); }
  };

  const shownText = display ?? current?.label ?? placeholder ?? '';
  let index = -1;
  const renderOption = (o: MenuOption<T>, isTyped = false) => {
    index += 1;
    const i = index;
    const selected = !isTyped && o.value === value;
    const OIcon = o.icon;
    return (
      <div
        key={isTyped ? TYPED_KEY : o.value}
        id={optId(i)}
        role="option"
        aria-selected={selected}
        aria-disabled={o.disabled || undefined}
        className={cx('mselect-opt', selected && 'is-selected', i === active && 'is-active', o.disabled && 'is-disabled', isTyped && 'is-typed', o.star && 'has-star')}
        onPointerMove={() => { follow.current = false; if (!o.disabled && active !== i) setActive(i); }}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => pick(o)}
      >
        <span className="mselect-opt__check" aria-hidden>{selected ? <Check size={14} /> : OIcon ? <OIcon size={14} /> : null}</span>
        <span className="mselect-opt__text">
          <span className="mselect-opt__label">
            <span className="mselect-opt__name">{o.label}</span>
            {o.tags?.map((t) => <span key={t.text} className={cx('mselect-tag', t.tone && `mselect-tag--${t.tone}`)} title={t.title}>{t.text}</span>)}
          </span>
          {o.sub && <span className="mselect-opt__sub">{o.sub}</span>}
        </span>
        {o.meta && <span className="mselect-opt__meta">{o.meta}</span>}
        {o.star && (
          <button type="button" tabIndex={-1} className={cx('mselect-opt__star', o.star.on && 'is-on')} aria-pressed={o.star.on} aria-label={o.star.label} title={`${o.star.label}（Ctrl+Enter）`}
            onMouseDown={(e) => e.preventDefault()} onClick={(e) => { e.stopPropagation(); o.star?.onToggle(); }}>
            <Star size={14} aria-hidden fill={o.star.on ? 'currentColor' : 'none'} />
          </button>
        )}
      </div>
    );
  };

  return (
    <>
      <button
        ref={trigger}
        id={id}
        type="button"
        className={cx(variant === 'chip' ? 'pchip mselect-chip' : 'mselect-field', open && 'is-open', disabled && 'is-disabled', className)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-label={`${label}：${typeof shownText === 'string' ? shownText : current?.label ?? ''}`}
        title={title}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onTriggerKey}
      >
        {Icon && <Icon size={variant === 'chip' ? 13 : 15} aria-hidden className="mselect__icon" />}
        <span className="mselect__text">{shownText}</span>
        <ChevronDown size={variant === 'chip' ? 12 : 14} aria-hidden className="mselect__chev" />
      </button>
      {open && createPortal(
        <div ref={pop} className={cx('mselect-pop', popClassName)} style={pos} onKeyDown={onListKey}>
          {showSearch && (
            <div className="mselect-pop__search">
              <Search size={13} aria-hidden />
              <input
                ref={input}
                type="text"
                {...text.bind}
                placeholder={searchPlaceholder ?? '搜索…'}
                aria-label={`在「${label}」中搜索`}
                role="combobox"
                aria-expanded
                aria-controls={listId}
                aria-activedescendant={active >= 0 ? optId(active) : undefined}
                aria-autocomplete="list"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          )}
          {top && <div className="mselect-pop__top">{top}</div>}
          <div
            ref={list}
            id={listId}
            className="mselect-pop__list"
            role="listbox"
            aria-label={label}
            tabIndex={-1}
            aria-activedescendant={!showSearch && active >= 0 ? optId(active) : undefined}
          >
            {shownFlat.length === 0 && (q || !empty ? <p className="mselect-pop__empty">没有匹配的选项</p> : <div className="mselect-pop__empty">{empty}</div>)}
            {shown.map((g, gi) => (
              <div key={`${g.label ?? ''}-${gi}`} role="group" aria-label={g.label} className="mselect-group">
                {g.label && (
                  <p className="mselect-group__label" aria-hidden>
                    <span>{g.label}</span>
                    {g.hint && <small>{g.hint}</small>}
                  </p>
                )}
                {g.options.map((o) => renderOption(o))}
              </div>
            ))}
            {windowed.hidden > 0 && <p className="mselect-pop__more" role="note">还有 {windowed.hidden} 项，输入关键词缩小范围</p>}
            {typedOption && <div role="group" className="mselect-group mselect-group--typed">{renderOption(typedOption, true)}</div>}
          </div>
          {footer && <div className="mselect-pop__foot">{footer}</div>}
        </div>,
        document.body,
      )}
    </>
  );
}
