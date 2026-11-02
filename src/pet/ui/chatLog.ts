/* 聊天框的纯逻辑（不依赖 React，scripts/pet-ui-check.ts 直接测）：记录的合并（真正的记录在主进程 electron/pet/index.cjs，
   以 PetChatMsg 发来）、输入框里按键的意思、标题下她在做什么、童话信笺和接龙状态条要显示的字。
   从萤火桌宠移植，后半部分（信笺、状态条）是栖枝新加的。 */
import type { PetChatEntry, PetChatMsg, PetGameState } from '../contracts';

/** The log keeps this many messages (the desktop keeps the same number). */
export const CHAT_MAX = 60;
/** What the user may type in one message. */
export const CHAT_INPUT_MAX = 500;

/** The log after one message from the desktop: the whole log, a message added (or grown under its id), or one taken back. */
export function applyChat(log: PetChatEntry[], m: PetChatMsg): PetChatEntry[] {
  if (m.op === 'reset') return m.entries.slice(-CHAT_MAX);
  if (m.op === 'drop') return log.some((e) => e.id === m.id) ? log.filter((e) => e.id !== m.id) : log;
  const i = log.findIndex((e) => e.id === m.entry.id);
  if (i >= 0) {
    const next = log.slice();
    next[i] = m.entry;
    return next;
  }
  const next = [...log, m.entry];
  return next.length > CHAT_MAX ? next.slice(-CHAT_MAX) : next;
}

/** What a key press in the composer means. While an IME is composing, Enter picks a candidate and Esc cancels it: neither is ours. */
export function composerKey(e: { key: string; shiftKey?: boolean; isComposing?: boolean; keyCode?: number }): 'send' | 'close' | null {
  if (e.isComposing || e.keyCode === 229) return null;
  if (e.key === 'Escape') return 'close';
  if (e.key === 'Enter' && !e.shiftKey) return 'send';
  return null;
}

/** What the header says: she is still thinking (the "let me think" line), writing her reply, or neither. */
export function chatActivity(log: PetChatEntry[]): 'think' | 'typing' | null {
  for (let i = log.length - 1; i >= 0; i--) {
    const e = log[i];
    if (e.who === 'her' && e.streaming) return e.mood === 'think' ? 'think' : 'typing';
  }
  return null;
}

/** A message in full: her long answers carry the whole text (with its line breaks) in `more`. */
export const fullText = (e: PetChatEntry) => e.more || e.text;

/** Her avatar only on the first of several messages of hers in a row. */
export const startsRun = (log: PetChatEntry[], i: number) => i === 0 || log[i - 1].who !== log[i].who;

/** The log is scrolled (close enough) to its end: new messages keep it there. */
export const atEnd = (scrollTop: number, scrollHeight: number, clientHeight: number) => scrollHeight - scrollTop - clientHeight < 24;

/** 一篇童话在信笺上的样子：标题和正文。消息带着 `tale` 就用它；没有时从文字里认 `《标题》` 开头。 */
export function taleView(e: PetChatEntry): { title: string; body: string } {
  if (e.tale) return { title: e.tale.title, body: e.tale.text };
  const text = fullText(e);
  const m = /^\s*《([^》\n]{1,30})》\s*/.exec(text);
  return m ? { title: m[1], body: text.slice(m[0].length) } : { title: '', body: text };
}

/** 聊天框标题下的状态条：接龙 / 童话进行中显示一句，别的小游戏（占卜、引蝶）在自己的面板里，这里没有。 */
export function gameBar(g: PetGameState | null): { kind: 'chain' | 'tale'; text: string } | null {
  if (!g || !g.active) return null;
  if (g.kind === 'chain') return { kind: 'chain', text: `接龙中 · ${g.hint || (g.nextChar ? `轮到你，接「${g.nextChar}」` : '开始了')}` };
  if (g.kind === 'tale') return { kind: 'tale', text: `写童话 · ${g.hint || '给我三个词'}` };
  return null;
}

/** 占卜翻出的命途图标（官方图标，public/art/her/path-<id>-s.webp）。 */
export const cardIcon = (id: string): string => `./art/her/path-${id.replace(/[^a-z]/g, '')}-s.webp`;

/** 一篇童话存下了吗：本页刚存过（entry id），或它带的 id 已在存下的名单里。 */
export function taleSaved(e: PetChatEntry, savedNow: ReadonlySet<string>, ids: ReadonlySet<string>): boolean {
  return savedNow.has(e.id) || (!!e.tale?.id && ids.has(e.tale.id));
}
