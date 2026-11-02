/* 事实校验（施工图 §3.7）：把一段话里的数字、路径、反引号片段、文件名取成多重集合；「让她换个说法」走模型重写时，
   原文与新文的 factsOf 必须一致，否则拒绝并保留原文（E 的 rewriteHer 调用）. 纯函数、无副作用.

   取法（按顺序，取走的片段不再参与后面的步骤，所以「路径里的数字」不会被当成数字再算一次）：
   1. 反引号片段 `…`（含围栏代码块里的整段）：整段当一个事实，键为带反引号的原文；
   2. URL；
   3. 路径：Windows 盘符（C:\\a\\b、C:/a/b）、UNC、相对 / 绝对的 Unix 式路径（./a、../a、/a/b、a/b/c.ts）；
   4. 文件名：带 1–6 位字母数字扩展名的词（README.md、package.json、v1.2.3 不算：纯数字扩展名交给数字）；
   5. 数字：阿拉伯数字（含小数、千分位、百分号、正负号不算）；紧跟量词的中文数字（「三步」「两处」）折成阿拉伯数字，所以「第 3 步」和「第三步」算同一个事实.
   键统一做 NFKC 归一与小写（盘符、扩展名大小写不敏感）；路径里的反斜杠与斜杠视为同一个. */

/** 多重集合：事实片段 → 出现次数. */
export type FactBag = Map<string, number>;

const CN_DIGIT: Record<string, number> = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
const MEASURE = '个步项处条份页行次天分钟小时秒件张篇段句遍轮组层位名只台套块';

/** 0–99 的中文数字 → 数；不认识返回 undefined. */
export function cnToNumber(s: string): number | undefined {
  if (!s) return undefined;
  if (s === '十') return 10;
  const m = /^([一二两三四五六七八九])?十([一二三四五六七八九])?$/.exec(s);
  if (m) return (m[1] ? CN_DIGIT[m[1]] : 1) * 10 + (m[2] ? CN_DIGIT[m[2]] : 0);
  if (s.length === 1 && s in CN_DIGIT) return CN_DIGIT[s];
  return undefined;
}

const add = (bag: FactBag, key: string) => { bag.set(key, (bag.get(key) ?? 0) + 1); };
const norm = (s: string) => s.normalize('NFKC').toLowerCase();
const normPath = (s: string) => norm(s).replace(/\\/g, '/').replace(/[.,;:，。；：、)）\]】」』"'”’]+$/, '');

export function factsOf(text: string): FactBag {
  const bag: FactBag = new Map();
  if (typeof text !== 'string' || !text) return bag;
  let rest = text;
  const take = (re: RegExp, key: (m: RegExpMatchArray) => string | undefined) => {
    rest = rest.replace(re, (...args) => {
      const m = args.slice(0, -2) as unknown as RegExpMatchArray;
      const k = key(m);
      if (k) add(bag, k);
      return ' ';
    });
  };
  // 1. 围栏代码块与行内反引号
  take(/```[\s\S]*?```/g, (m) => `\`\`\`${norm(m[0].slice(3, -3)).replace(/\s+/g, ' ').trim()}\`\`\``);
  take(/`([^`\n]+)`/g, (m) => `\`${norm(m[1]).trim()}\``);
  // 2. URL
  take(/https?:\/\/[^\s)）」』"'<>，。；]+/gi, (m) => normPath(m[0]));
  // 3. 路径
  take(/\b[a-z]:[\\/][^\s"'`<>|，。；：、)）」』]*/gi, (m) => normPath(m[0]));
  take(/\\\\[^\s"'`<>|，。；]+/g, (m) => normPath(m[0]));
  take(/(?:^|[\s(（「『"'])((?:\.{1,2}\/|\/)[\w.\-@]+(?:\/[\w.\-@]+)*\/?)/g, (m) => normPath(m[1]));
  take(/(?:^|[\s(（「『"'])([\w.\-@]+(?:\/[\w.\-@]+)+\/?)/g, (m) => normPath(m[1]));
  // 4. 文件名
  take(/(?:^|[^\w.])([\w\-@]+(?:\.[\w\-@]+)*\.[a-z][a-z0-9]{0,5})(?![\w])/gi, (m) => (/^\d+(\.\d+)*$/.test(m[1]) ? undefined : norm(m[1])));
  // 5. 数字
  take(/\d{1,3}(?:,\d{3})+(?:\.\d+)?%?|\d+(?:\.\d+)?%?/g, (m) => norm(m[0]).replace(/,/g, ''));
  take(new RegExp(`([零一二两三四五六七八九十]{1,3})(?=[${MEASURE}])`, 'g'), (m) => { const n = cnToNumber(m[1]); return n === undefined ? undefined : String(n); });
  void rest;
  return bag;
}

/** 两段文本的事实是否一致. */
export function sameFacts(a: string, b: string): boolean {
  const x = factsOf(a), y = factsOf(b);
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
}

/** 两段文本的事实差异（调试 / toast 用）：丢了什么、多了什么. */
export function diffFacts(before: string, after: string): { lost: string[]; added: string[] } {
  const x = factsOf(before), y = factsOf(after);
  const lost: string[] = [], added: string[] = [];
  for (const [k, v] of x) for (let i = (y.get(k) ?? 0); i < v; i++) lost.push(k);
  for (const [k, v] of y) for (let i = (x.get(k) ?? 0); i < v; i++) added.push(k);
  return { lost, added };
}
