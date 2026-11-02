/* 词语接龙（docs/PET-PLAN.md §4）的规则. 纯函数，可测. 状态在大脑里（brain.ts），界面在桌宠窗口（只显示大脑发来的 PetGameState）.
   规则：一个词两到六个汉字；首字要接上一个词的末字（同音不算，必须是同一个字）；不能重复；不含禁用词（收割、尸体、血、死亡……，用户和她接的词都查）.
   轮到她时，大脑让模型「只回一个以某字开头的词」，回来的词用同一套规则检查；接不上（或模型两次给错）她就认输. */

import { bannedIn } from '../tidy';

/** 一个词最多几个汉字（用户和模型都一样）. */
export const CHAIN_MAX_CHARS = 6;

/** 汉字（含扩展区）. */
const HAN = /\p{Script=Han}/u;

/** 去掉两头的空白、引号、标点（用户和模型都爱给词加引号、句号）. */
export function normalizeWord(raw: string): string {
  return raw.trim().replace(/^[\s"'“”‘’「」『』《》（）()【】\[\]。，、！？!?,.;；:：…~～-]+|[\s"'“”‘’「」『』《》（）()【】\[\]。，、！？!?,.;；:：…~～-]+$/gu, '');
}

/** 这个词的末字（最后一个汉字）；没有汉字就是空串. */
export function lastChar(word: string): string {
  const chars = [...normalizeWord(word)];
  for (let i = chars.length - 1; i >= 0; i--) if (HAN.test(chars[i])) return chars[i];
  return '';
}

/** 这个词的首字. */
export function firstChar(word: string): string {
  const chars = [...normalizeWord(word)];
  return chars.find((c) => HAN.test(c)) ?? '';
}

/** 能不能接：`prev` 是上一个词（第一个词为 null），`used` 是已经用过的词. 不合规时 reason 是一句平实的话（会放进她的台词里）. */
export function checkWord(word: string, prev: string | null, used: Set<string>): { ok: true } | { ok: false; reason: string } {
  const w = normalizeWord(word);
  const chars = [...w];
  if (!w || !chars.every((c) => HAN.test(c))) return { ok: false, reason: '只收汉字组成的词' };
  if (chars.length < 2) return { ok: false, reason: '词至少要两个字' };
  if (chars.length > CHAIN_MAX_CHARS) return { ok: false, reason: '词最多六个字' };
  if (bannedIn(w)) return { ok: false, reason: '这个词不适合接龙' };
  if (prev !== null) {
    const need = lastChar(prev);
    if (need && chars[0] !== need) return { ok: false, reason: `要用「${need}」开头` };
  }
  if (used.has(w)) return { ok: false, reason: '这个词已经用过了' };
  return { ok: true };
}

/** 让模型接一个词的用户消息（系统提示在 prompts.ts 的 chain 一节）. `used` 是已用过的词，告诉它别重复. */
export function chainPrompt(char: string, used: Iterable<string> = []): string {
  const list = [...used].slice(-30);
  return [
    `接龙：请回一个以「${char}」开头的词，两到六个汉字，只回这个词，不加标点、解释和别的话。`,
    list.length ? `已经用过的词（不要重复）：${list.join('、')}` : '',
  ].filter(Boolean).join('\n');
}

/** 从模型的回话里取出它接的词：去掉标点和客套，取第一段汉字（至少一个字；够不够两个字由 checkWord 判）. */
export function parseWordReply(raw: string): string {
  const line = raw.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  const run = /\p{Script=Han}+/u.exec(normalizeWord(line));
  return run ? run[0] : '';
}

/** 用户中途想停：「不玩了」「结束」之类. */
export const STOP_WORDS = /^(?:不玩了|不接了|不写了|结束|结束吧|停|停下|算了|退出|不要了)[。.!！\s]*$/;
