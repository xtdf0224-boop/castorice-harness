/* 表情标签解析器（施工图 §3.4、D3）：纯函数，无状态.
   模型在回复的第一行写 ⟦face:ID｜react:ID⟧（react 可省）；解析器两端都认，容错模型放错位置.
   · parseExprTags：只取「开头」（允许前导空白 / BOM）和「结尾」各一个标签当这条消息的表情（开头优先），并把可见文本里的合规标签全部剥掉.
   · stripExprTags：剥掉围栏代码块（```）之外任何位置的合规标签（结果汇总、step.result、后续上下文用）.
   「合规标签」：规范括号 ⟦…⟧ / 〚…〛（中段只认这两种）；首尾另认容错括号 [[ ]] / << >> / [ ]（单括号要求体内以 face: / react: 起头）；
   分隔 ｜ | ,；体长 ≤ 40；体内字符 [A-Za-z:｜|,\s]；键只能是 face / react；值必须在封闭集里（face 还可为 none）.
   非法值：标签剥掉、值忽略（走兜底）. 流式：开头 / 结尾处出现未收尾的 ⟦…（总长 < 48）→ hold 且该片段不显示；final 时残片一律剥掉.
   体内全角冒号 / 逗号（：，）先归一成半角再比对；中段在规范括号之外还认 [[face:…]] / <<face:…>>（单括号不认，免得误吞正文里的 x[face:y]）.
   包裹符：首 / 尾的标签两侧若有成对的 ` ** __ * _ 或行首的引用符 >，包裹符与标签一起剥掉并照常取表情；
   但单反引号（行内代码）包住、且同一行还有别的字时，视作在讲标签语法，原样保留（只有独占一行的才剥）. 围栏除 ``` 外也认行首的 ~~~. */
import { isExprId, isStickerId } from './expr';
import type { ExprId, StickerId } from './types';

export interface ExprParse { text: string; expr?: ExprId; react?: StickerId; hold: boolean }

const BODY_MAX = 40;
const PARTIAL_MAX = 48;
const HEAD_SCAN = 60;
const BODY_RE = /^[A-Za-z:：｜|,，\s]+$/;
const BODY_CHARS = /^[A-Za-z:：｜|,，\s]*$/;
const PART_RE = /^(face|react)\s*:\s*([A-Za-z]+)$/i;

interface Body { ok: boolean; face?: ExprId; react?: StickerId }

/** 体是否合规；ok 时顺带取出（合法的）face / react，非法值忽略. */
function parseBody(body: string): Body {
  if (body.length === 0 || body.length > BODY_MAX || !BODY_RE.test(body)) return { ok: false };
  body = body.replace(/：/g, ':').replace(/，/g, ',');                    // 中文输入法常把冒号 / 逗号写成全角
  const out: Body = { ok: true };
  let any = false;
  for (const raw of body.split(/[｜|,]/)) {
    const part = raw.trim();
    if (!part) continue;
    const m = PART_RE.exec(part);
    if (!m) return { ok: false };
    any = true;
    const key = m[1].toLowerCase();
    const val = m[2].toLowerCase();
    if (key === 'face') { if (out.face === undefined && isExprId(val)) out.face = val; }
    else if (out.react === undefined && isStickerId(val)) out.react = val;
  }
  return any ? out : { ok: false };
}

const startsKey = (body: string) => /^\s*(face|react)\s*[:：]/i.test(body);
/** 流式时体的前缀是否还可能长成 face: / react:. */
const keyPrefix = (body: string) => {
  const r = body.trim().toLowerCase().replace(/：/g, ':');
  return r.length > 0 && ('face:'.startsWith(r) || 'react:'.startsWith(r) || startsKey(r));
};

/* 开括号 → 可接受的闭括号 */
const CANON_OPEN = ['⟦', '〚'];
const CANON_CLOSE = ['⟧', '〛'];
interface Bracket { open: string; close: string[]; canonical: boolean; needKey: boolean }
const HEAD_BRACKETS: Bracket[] = [
  { open: '⟦', close: CANON_CLOSE, canonical: true, needKey: false },
  { open: '〚', close: CANON_CLOSE, canonical: true, needKey: false },
  { open: '[[', close: [']]'], canonical: false, needKey: false },
  { open: '<<', close: ['>>'], canonical: false, needKey: false },
  { open: '[', close: [']'], canonical: false, needKey: true },
];

/** 从 `from`（体起点）起，BODY_MAX 内最早的闭括号. */
function findClose(text: string, from: number, closers: string[]): { idx: number; len: number } | undefined {
  let best: { idx: number; len: number } | undefined;
  for (const c of closers) {
    const k = text.indexOf(c, from);
    if (k >= 0 && k - from <= BODY_MAX && (!best || k < best.idx)) best = { idx: k, len: c.length };
  }
  return best;
}

interface Hit { end: number; body: Body }

type TagMode = 'head' | 'middle';
/** 在 text[i] 处读一个完整标签. head（首尾）还认全部容错括号；middle 只认规范括号加 [[face:…]] / <<face:…>>（后两种要求体内以 face: / react: 起头）. */
function tagAt(text: string, i: number, mode: TagMode): Hit | undefined {
  for (const b of HEAD_BRACKETS) {
    if (!b.canonical && !(mode === 'head' || b.open === '[[' || b.open === '<<')) continue;
    if (!text.startsWith(b.open, i)) continue;
    const from = i + b.open.length;
    const c = findClose(text, from, b.close);
    if (!c) continue;
    const bodyText = text.slice(from, c.idx);
    if ((b.needKey || (mode === 'middle' && !b.canonical)) && !startsKey(bodyText)) continue;
    const body = parseBody(bodyText);
    if (body.ok) return { end: c.idx + c.len, body };
  }
  return undefined;
}

/* ── 包裹符：模型有时把标签写进行内代码 / 粗体 / 引用里 ── */
const QUOTE_PRE = /^(?:>[ \t]*)+/;
const WRAP_RUN = /^[`*_]{1,4}/;
const mirror = (w: string) => Array.from(w).reverse().join('');
const lineStartOk = (s: string, pos: number) => { const ls = s.lastIndexOf('\n', pos - 1) + 1; return /^[ \t]*(?:>[ \t]*)*$/.test(s.slice(ls, pos)); };
const lineEndOk = (s: string, pos: number) => { let e = pos; while (s[e] === ' ' || s[e] === '\t') e++; return e >= s.length || s[e] === '\n'; };

/** 首部：[引用符][包裹符]标签[对称的包裹符]；含反引号的包裹要求这个标签独占一行（否则是在讲标签语法）. */
function wrappedTagAt(text: string, i: number): Hit | undefined {
  const q = QUOTE_PRE.exec(text.slice(i, i + 16));
  const j = i + (q ? q[0].length : 0);
  const w = WRAP_RUN.exec(text.slice(j, j + 4));
  const wrap = w && !w[0].includes('```') ? w[0] : '';
  const hit = tagAt(text, j + wrap.length, 'head');
  if (!hit) return undefined;
  let end = hit.end;
  if (wrap) {
    const m = mirror(wrap);
    if (!text.startsWith(m, end)) return undefined;
    end += m.length;
    if (wrap.includes('`') && !lineEndOk(text, end)) return undefined;
  }
  return { end, body: hit.body };
}
/** 首部残片判断时先跳过引用符与包裹符. */
function skipWrap(text: string, i: number): number {
  const q = QUOTE_PRE.exec(text.slice(i, i + 16));
  const j = i + (q ? q[0].length : 0);
  const w = WRAP_RUN.exec(text.slice(j, j + 4));
  return w && !w[0].includes('```') ? j + w[0].length : j;
}

/** 开头未收尾的残片（流式）：从 i 起到文末，没有闭括号、总长 < PARTIAL_MAX、体仍像标签. */
function headPartial(text: string, i: number): boolean {
  for (const b of HEAD_BRACKETS) {
    if (!text.startsWith(b.open, i)) continue;
    const rest = text.slice(i + b.open.length);
    if (rest.length + b.open.length >= PARTIAL_MAX) continue;
    if (b.close.some((c) => rest.includes(c))) continue;
    if (!BODY_CHARS.test(rest)) continue;
    if (b.canonical) return true;
    if (b.needKey ? keyPrefix(rest) : rest.trim() === '' || keyPrefix(rest)) return true;
  }
  return false;
}

/* 围栏：``` 在任何位置，~~~ 在行首；奇数个围栏标记之后就在围栏里 */
const FENCE_SPLIT = /(```|^[ \t]*~~~)/m;
const FENCE_ALL = /```|^[ \t]*~~~/gm;
const inFence = (text: string, pos: number): boolean => ((text.slice(0, pos).match(FENCE_ALL) ?? []).length % 2) === 1;

/** 结尾标签：text（已去尾部空白）以闭括号结尾，向前找对应开括号. */
function tailTag(text: string): { start: number; body: Body } | undefined {
  const lo = Math.max(0, text.length - PARTIAL_MAX - 2);
  const tryPair = (closer: string, openers: string[], needKey: boolean) => {
    if (!text.endsWith(closer)) return undefined;
    const bodyEnd = text.length - closer.length;
    let start = -1;
    let open = '';
    for (const o of openers) {
      const k = text.lastIndexOf(o, bodyEnd - 1);
      if (k >= lo && k > start) { start = k; open = o; }
    }
    if (start < 0) return undefined;
    const bodyText = text.slice(start + open.length, bodyEnd);
    if (needKey && !startsKey(bodyText)) return undefined;
    const body = parseBody(bodyText);
    return body.ok && !inFence(text, start) ? { start, body } : undefined;
  };
  for (const c of CANON_CLOSE) { const h = tryPair(c, CANON_OPEN, false); if (h) return h; }
  return tryPair(']]', ['[['], false) ?? tryPair('>>', ['<<'], false) ?? tryPair(']', ['['], true);
}

/** 结尾标签，两侧允许有成对的包裹符（反引号包裹要求独占一行）. */
function tailTagWrapped(text: string): { start: number; body: Body } | undefined {
  const plain = tailTag(text);
  if (plain) return plain;
  const m = /[`*_]{1,4}$/.exec(text);
  if (!m || m[0].includes('```')) return undefined;
  const inner = text.slice(0, text.length - m[0].length);
  const h = tailTag(inner);
  const mir = mirror(m[0]);
  if (!h || !inner.slice(0, h.start).endsWith(mir)) return undefined;
  const start = h.start - mir.length;
  if (mir.includes('`') && !lineStartOk(inner, start)) return undefined;
  return { start, body: h.body };
}

/** 结尾未收尾的规范括号残片（流式）. */
function tailPartial(text: string): number {
  const lo = Math.max(0, text.length - PARTIAL_MAX + 1);
  let start = -1;
  for (const o of CANON_OPEN) { const k = text.lastIndexOf(o); if (k >= lo && k > start) start = k; }
  if (start < 0) return -1;
  const rest = text.slice(start + 1);
  if (CANON_CLOSE.some((c) => rest.includes(c)) || !BODY_CHARS.test(rest) || inFence(text, start)) return -1;
  return start;
}

/** 围栏外的所有合规标签（单趟扫描，片段拼接，标签再多也是 O(n)）. 包裹符：独占一行的整行去掉；行内代码（单反引号）里的当字面量保留；粗体 / 斜体连包裹符一起去掉. */
const MIDDLE_OPENS = ['⟦', '〚', '[[', '<<'];
function stripMiddleOnce(text: string): string {
  if (!MIDDLE_OPENS.some((o) => text.includes(o))) return text;
  const parts = text.split(FENCE_SPLIT);                 // [正文, 围栏标记, 围栏内, 围栏标记, 正文 …]
  for (let p = 0; p < parts.length; p += 4) {            // 只处理围栏外的段；围栏内与围栏标记原样保留
    const s = parts[p];
    const out: string[] = [];
    let at = 0;       // 下一次找开括号的位置
    let keep = 0;     // 还没写进 out 的起点
    for (;;) {
      let k = -1;
      for (const o of MIDDLE_OPENS) { const j = s.indexOf(o, at); if (j >= 0 && (k < 0 || j < k)) k = j; }
      if (k < 0) break;
      const hit = tagAt(s, k, 'middle');
      if (!hit) { at = k + 1; continue; }
      let from = k;
      let end = hit.end;
      const pre = /[`*_]{1,3}$/.exec(s.slice(Math.max(0, k - 3), k));
      const mir = pre ? mirror(pre[0]) : '';
      if (pre && s.startsWith(mir, end)) {
        const alone = lineStartOk(s, k - pre[0].length) && lineEndOk(s, end + mir.length);
        if (!alone && pre[0] === '`') { at = end; continue; }          // 行内代码里讲标签语法：保留字面量
        from = k - pre[0].length;
        end += mir.length;
      }
      if (lineStartOk(s, from) && lineEndOk(s, end)) {                  // 独占一行（含引用符）：连行一起去掉
        let e = end;
        while (s[e] === ' ' || s[e] === '\t') e++;
        if (s[e] === '\n') {
          const ls = s.lastIndexOf('\n', from - 1) + 1;
          if (s.slice(ls, from).includes('>')) from = ls;
          end = e + 1;
        }
      }
      out.push(s.slice(keep, from));
      keep = end;
      at = end;
    }
    if (keep > 0) { out.push(s.slice(keep)); parts[p] = out.join(''); }
  }
  return parts.join('');
}

function stripMiddle(text: string): string {
  let cur = text;
  for (let n = 0; n < 5; n++) { const next = stripMiddleOnce(cur); if (next === cur) break; cur = next; }
  return cur;
}

/** 快速路径：全文没有任何开 / 闭括号候选，就不用进慢路径（绝大多数回复）. */
function mayHaveTag(text: string): boolean {
  if (CANON_OPEN.some((o) => text.includes(o)) || CANON_CLOSE.some((c) => text.includes(c))) return true;
  if (/\[\[\s*(?:face|react)|<<\s*(?:face|react)/i.test(text)) return true;      // 中段的容错双括号
  const head = text.slice(0, HEAD_SCAN);
  const tail = text.slice(-HEAD_SCAN);
  return /[[<]/.test(head) || /[\]>]/.test(tail);
}

export function parseExprTags(raw: string, o: { final?: boolean } = {}): ExprParse {
  if (!raw || !mayHaveTag(raw)) return { text: raw, hold: false };
  let text = raw;
  let expr: ExprId | undefined;
  let react: StickerId | undefined;
  let hold = false;
  const take = (b: Body) => {
    if (expr === undefined && b.face) expr = b.face;
    if (react === undefined && b.react) react = b.react;
  };

  /* 开头：允许前导空白 / BOM，可连续多个标签 */
  let i = 0;
  const skipWs = () => { while (i < text.length && (text[i] === '﻿' || /\s/.test(text[i]))) i++; };
  skipWs();
  const headStart = i;
  for (;;) {
    const hit = wrappedTagAt(text, i);
    if (!hit) break;
    take(hit.body);
    i = hit.end;
    skipWs();
  }
  if (i > headStart) text = text.slice(i);                               // 吃掉标签后，正文从第一个非空白字符开始
  else if (headPartial(text, skipWrap(text, headStart)) || headPartial(text, headStart)) {
    hold = !o.final;
    text = '';
    return { text, expr, react, hold };
  }

  /* 结尾：可连续多个标签；开头优先，所以只补开头没给的键 */
  for (;;) {
    const trimmed = text.replace(/\s+$/, '');
    const hit = tailTagWrapped(trimmed);
    if (!hit) {
      const p = tailPartial(trimmed);
      if (p >= 0) { text = trimmed.slice(0, p).replace(/\s+$/, ''); hold = !o.final; }
      break;
    }
    take(hit.body);
    text = trimmed.slice(0, hit.start).replace(/[ \t]+$/, '').replace(/(^|\n)[ \t]*(?:>[ \t]*)+$/, '$1').replace(/\s+$/, '');   // 标签那一行只剩引用符的也一并去掉
  }

  return { text: stripMiddle(text), expr, react, hold };
}

/** 剥掉围栏外任何位置的合规标签（幂等）. 没有标签时原样返回. */
export function stripExprTags(text: string): string {
  if (!text || !mayHaveTag(text)) return text;
  return parseExprTags(text, { final: true }).text;
}
