/* 草稿登记（施工图 §3.6b，V2）：草稿是 PromptBox 的组件本地状态，proactive.ts 读不到，所以由 PromptBox 在 onChange 时 setDraft、
   发送 / 清空时 clearDraft，canNudge 读 hasDraft. 不读 DOM. 空白文本等同清除. 内存 Map，不落盘（重启后没有草稿）. */
const drafts = new Map<string, string>();
const subs = new Set<() => void>();
const emit = () => subs.forEach((fn) => fn());

export function setDraft(taskId: string, text: string): void {
  const had = drafts.has(taskId);
  if (text.trim()) { drafts.set(taskId, text); if (!had) emit(); }
  else if (had) { drafts.delete(taskId); emit(); }
}
export function hasDraft(taskId: string): boolean {
  return drafts.has(taskId);
}
export function clearDraft(taskId: string): void {
  if (drafts.delete(taskId)) emit();
}
/** 「有 / 没有草稿」翻转时回调（每次按键不通知；proactive 据此重排定时器）. 返回取消订阅. */
export function subscribeDraft(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}
