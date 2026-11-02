/* 中文按词断行（第 4 轮评审：归来笺、设置页、右栏里「定夺」「生效」被拆成两行、行首行尾挂单字）.
   做法：Intl.Segmenter('zh') 切词 -> 标点粘在相邻的词上 -> 单字词并进相邻的词（任何一块至少两个字，不会有单字行）
   -> 块与块之间放 <wbr>，段落上配 word-break: keep-all（见 interaction-return.css 的 .words）：只有 <wbr> 处才许断行.
   纯函数，无 DOM；Segmenter 不可用时整段原样返回（交给浏览器自己断）. */

const OPEN = /^[「『（《〈【〔［｛“‘(\[{]+$/;
const CLOSE = /^[」』）》〉】〕］｝”’)\]}，。、；：！？…—,.;:!?·]+$/;
const SPACE = /^\s+$/;

/** 空白块的标记：渲染时原样输出，不再加 <wbr>. */
export const isSpaceChunk = (c: string) => SPACE.test(c);

type Seg = { segment: string; isWordLike?: boolean };
type SegmenterLike = { segment(text: string): Iterable<Seg> };
let seg: SegmenterLike | null | undefined;
const segmenter = (): SegmenterLike | null => {
  if (seg !== undefined) return seg;
  try {
    const Ctor = (Intl as unknown as { Segmenter?: new (l: string, o: { granularity: 'word' }) => SegmenterLike }).Segmenter;
    seg = Ctor ? new Ctor('zh', { granularity: 'word' }) : null;
  } catch { seg = null; }
  return seg;
};

/** 词典切不对的词（专名与界面里常用的双字词）：整个作为一块. */
const PROTECT = ['栖枝', '遐蝶', '阁下', '重启', '生效', '定夺', '归来简', '话量', '试听', '壁纸', '立绘', '口吻', '命途', '行迹', '待你', '可看', '放下', '接手', '审批', '计划', '工具', '代码'];
const PROTECT_RE = new RegExp(`(${PROTECT.join('|')})`);

const cache = new Map<string, string[]>();

/** 先按 PROTECT 切开，其余交给 Segmenter. */
function* tokens(sg: SegmenterLike, text: string): Generator<Seg> {
  for (const piece of text.split(PROTECT_RE)) {
    if (!piece) continue;
    if (PROTECT.includes(piece)) yield { segment: piece, isWordLike: true };
    else yield* sg.segment(piece);
  }
}

/** 切成断行块：块内不断，块间可断. 空白自成一块（isSpaceChunk）. */
export function wordChunks(text: string): string[] {
  const hit = cache.get(text);
  if (hit) return hit;
  const sg = segmenter();
  let out: string[];
  if (!sg || !text) {
    out = text ? [text] : [];
  } else {
    // 1) 词 + 标点：开括号并给后一个词，闭标点并给前一个词.
    const parts: string[] = [];
    let open = '';
    for (const s of tokens(sg, text)) {
      const t = s.segment;
      if (SPACE.test(t)) { if (open) { parts.push(open); open = ''; } parts.push(t); continue; }
      if (!s.isWordLike && OPEN.test(t)) { open += t; continue; }
      if (!s.isWordLike && CLOSE.test(t)) {
        const last = parts.length - 1;
        if (last >= 0 && !SPACE.test(parts[last])) parts[last] += open + t; else parts.push(open + t);
        open = '';
        continue;
      }
      parts.push(open + t);
      open = '';
    }
    if (open) parts.push(open);
    // 2) 单字块并进后一块（后一块不存在或隔着空白就并进前一块）：事在 / 等阁下，免得单字独占一行.
    const len = (c: string) => Array.from(c.replace(/[「『（《〈【〔［｛“‘(\[{」』）》〉】〕］｝”’)\]}，。、；：！？…—,.;:!?·]/g, '')).length;
    out = [];
    for (let i = 0; i < parts.length; i++) {
      let cur = parts[i];
      if (SPACE.test(cur)) { out.push(cur); continue; }
      while (len(cur) < 2 && i + 1 < parts.length && !SPACE.test(parts[i + 1])) { cur += parts[i + 1]; i += 1; }
      if (len(cur) < 2) {
        const prev = out.length - 1;
        if (prev >= 0 && !SPACE.test(out[prev])) { out[prev] += cur; continue; }
      }
      out.push(cur);
    }
  }
  if (cache.size > 400) cache.clear();
  cache.set(text, out);
  return out;
}
