/* 末行保护（第 7 轮）：她的短句气泡 / 卡外那一句，末行不该只剩「决定。」这样两三个字.
   text-wrap: pretty 在 Chromium 里按「词」避孤行，中文每个字都是断点，管不到这一层；
   这里把一段话最后 TAIL 个字包进不换行的 span——要换行也是连这几个字一起换，末行至少 TAIL 个字. 不改文字内容（textContent 不变）、不改布局以外的任何东西. */
import type { ReactNode } from 'react';

const TAIL = 5;
/** 太短的话本来就是一行，不用保护. */
const MIN = 9;

/** 把文字切成 [前面, 末尾几个字]；不够长返回 null. 按码点切，不劈开代理对. */
export function splitTail(text: string): [string, string] | null {
  const cs = Array.from(text);
  if (cs.length < MIN) return null;
  return [cs.slice(0, cs.length - TAIL).join(''), cs.slice(cs.length - TAIL).join('')];
}

/** 一段纯文字加末行保护. */
export function guardTail(text: string): ReactNode {
  const sp = splitTail(text);
  if (!sp) return text;
  return <>{sp[0]}<span className="her-tail">{sp[1]}</span></>;
}
