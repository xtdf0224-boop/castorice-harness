/* 输入法守卫（V0α · X02 / N03 / K3）。
   中文输入法在拼音候选未上屏时，Enter 是「选字」、Esc 是「取消组合」，都不属于页面。
   判断组合态不能只看 isComposing：MDN 写明 compositionend 可能先于 keydown，那时 isComposing 为 false，
   但 keyCode 仍是 229；个别输入法还会报 key === 'Process'。三者任一成立都当作组合态。

   所有「回车即提交」的单行输入框（称呼、模型 ID、搜索、行内改名……）都用 guardEnter / guardEscape，
   不要再自己写 `e.key === 'Enter'`。全局快捷键（commands.ts）也经过 isComposingEvent。
   纯函数、不依赖 DOM，check-interaction 直接测它。 */

/** React 的 KeyboardEvent 与原生 KeyboardEvent 共有的最小形状（nativeEvent 只有 React 的有）. */
export interface KeyLike {
  key?: string;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean; keyCode?: number };
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  preventDefault?: () => void;
  stopPropagation?: () => void;
}

/** 这个按键事件是不是输入法在用（拼音候选未上屏、选字、取消组合）. */
export function isComposingEvent(e: KeyLike): boolean {
  if (e.isComposing || e.nativeEvent?.isComposing) return true;
  if (e.keyCode === 229 || e.nativeEvent?.keyCode === 229) return true;
  return e.key === 'Process';
}

/**
 * 回车提交：组合态把 Enter 留给输入法（返回 false，什么都不做）；否则 preventDefault 并调用 submit。
 * `allowModified` 默认 false：带 Shift / Ctrl / Alt / Meta 的 Enter 不算提交（Shift+Enter 是换行）。
 * 返回 true 表示提交已执行.
 */
export function guardEnter(e: KeyLike, submit: () => void, opts: { allowModified?: boolean } = {}): boolean {
  if (e.key !== 'Enter') return false;
  if (isComposingEvent(e)) return false;
  if (!opts.allowModified && (e.shiftKey || e.ctrlKey || e.altKey || e.metaKey)) return false;
  e.preventDefault?.();
  submit();
  return true;
}

/**
 * Esc：组合态只取消组合——不执行 cancel、不 preventDefault（让输入法自己收掉候选），
 * 并 stopPropagation，免得外层的「Esc 关弹窗 / 关抽屉 / 放弃行内编辑」把它当成自己的.
 * 非组合态：preventDefault + stopPropagation 后调用 cancel，返回 true.
 */
export function guardEscape(e: KeyLike, cancel: () => void): boolean {
  if (e.key !== 'Escape') return false;
  if (isComposingEvent(e)) { e.stopPropagation?.(); return false; }
  e.preventDefault?.();
  e.stopPropagation?.();
  cancel();
  return true;
}

/**
 * 给单行输入框一次接好 Enter / Esc：`<input onKeyDown={lineInputKeys({ onEnter: commit, onEscape: revert })} />`.
 * 输入法组合期间两者都不触发.
 */
export function lineInputKeys<E extends KeyLike>(h: { onEnter?: () => void; onEscape?: () => void }): (e: E) => void {
  return (e) => {
    if (h.onEnter && guardEnter(e, h.onEnter)) return;
    if (h.onEscape) guardEscape(e, h.onEscape);
  };
}

/** 事件目标是不是可编辑元素（输入框、文本域、contenteditable、下拉里的搜索框）. */
export function isEditableTarget(t: unknown): boolean {
  const el = t as { tagName?: string; isContentEditable?: boolean; closest?: (s: string) => unknown } | null;
  if (!el || typeof el !== 'object') return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = String((el as { type?: string }).type ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'file', 'color'].includes(type);
  }
  if (el.isContentEditable) return true;
  return !!el.closest?.('[contenteditable="true"],[role="textbox"],[role="combobox"],[role="searchbox"]');
}

/* ───────────── 全局「输入法正在组合」（施工图 §3.8，V2） ─────────────
   「她退半步」与话语总闸要知道此刻有没有拼音候选没上屏：window 上挂 compositionstart / compositionend（捕获阶段，不挡别人）.
   窗口失焦时清零（组合被输入法吞掉、compositionend 没来时不会一直卡在「组合中」）. 没有 window 的环境（测试）里只靠 setComposingForTest. */
let composingNow = false;
const composingSubs = new Set<() => void>();

function setComposing(v: boolean) {
  if (composingNow === v) return;
  composingNow = v;
  composingSubs.forEach((fn) => fn());
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('compositionstart', () => setComposing(true), true);
  window.addEventListener('compositionend', () => setComposing(false), true);
  window.addEventListener('blur', () => setComposing(false));
}

/** 此刻有没有输入法组合在进行. */
export function isComposingNow(): boolean { return composingNow; }
/** 组合态变化时回调（useSyncExternalStore 用）. 返回取消订阅. */
export function subscribeComposing(fn: () => void): () => void {
  composingSubs.add(fn);
  return () => { composingSubs.delete(fn); };
}
/** 测试用：直接设组合态. */
export function setComposingForTest(v: boolean): void { setComposing(v); }
