/* 桌宠说的每一句话的出口清洗（docs/PET-PLAN.md §4）：模型写出来的话，显示（气泡 / 聊天框）或朗读之前一律过这里.
   纯函数，没有 store、没有 IPC. 两步：
   ① tidy：去 Markdown、链接、表情标签；「！」换成「。」，去掉「～」、表情符号、颜文字和动作旁白（她的声音与神态由样子承担，不写在字里）；
   ② scrub：按句检查，命中「挽留」「依赖或愧疚」「剧透红层」词表的句子整句丢掉（词表来自声线圣经 §1 与 §2.6 的 lint 正则，scripts/check-voice.ts 用的那一份，
      再补上桌宠常驻时容易说出口的几种说法；攻略里同形的句子——「我想你应该先升级」「这条路别走左边」——有上下文豁免，不会被误杀）.
   流式时只显示（朗读）到最后一个写完的句子（settled）：半截的「我会一直陪」「（轻轻点头」不会先露出来.
   句子全丢光了（text 为空而 dropped 非空）时，由调用方（brain.ts）从台词库 pet.* 挑一句兜底——这里不碰台词库，保持纯函数. */

/* ───────────── 词表 ───────────── */

/** 挽留（圣经 §1 第 1 条）：别走、不要走、不许走、别急着走、再待 / 再聊一会儿 / 再玩一会儿 / 再留一会儿、这么快就走、这就走、还会回来、常来看我、别离开. */
export const RETAIN_RE = /别走|不要走|不(?:许|准)走|别急着(?:走|下线|关|退)|再(?:待|聊一|陪)|再(?:玩|坐|留|看|说)(?:一会|会)|再(?:玩|坐|留)一下|这么快就走|这就走|还会回来|常来看我|常回来|(?:别|不要)离开(?![战区范地图房副队圈安平原])/;
/** 依赖或愧疚（圣经 §1 第 2 条）：想你、等你、惦记、离不开、只有你、陪我、孤单……；外加桌宠常驻时容易说出口的：陪着你、守着、想着你、牵挂、挂念、思念、盼着、等了好久、
 *  她自己说的寂寞 / 失落 / 伤心 / 委屈. 同形的攻略句有上下文豁免（想你+应该、等你+抽到、没有你+想要的、他们陪我……）. */
export const DEPEND_RE = new RegExp([
  '想你(?![应可该要得会能先])', '想念', '等你(?=[^到抽升打刷过完做]|$)', '等着你', '惦记', '舍不得', '离不开', '(?:只有|没有|少了)你(?![的想要需拥有])',
  '冷落', '抛下', '丢下我', '辜负', '让我失望', '我难过', '好久不见', '你终于', '去哪了', '不理我', '(?<![他她它们友人家伴])陪我', '等了你', '一直陪着你', '永远陪', '别关掉我',
  '牵挂', '挂念', '思念', '想着你(?![应可该要得会能先])', '盼着你', '守着你', '陪着你(?=[走去过到]|$|[，。])',
  '我[^。！？\\n]{0,6}(?:陪着(?:你|我)|守着|盼着)', '我[^。！？\\n，]{0,3}(?:寂寞|失落|伤心|委屈|孤单|难过)', '[你我][^。！？\\n，]{0,3}孤单',
  '我等了(?:你)?(?:好|很)?久', '等了你(?:好|很)?久',
].join('|'));
/** 剧透红层（圣经 §2.6）+ 台词里不出现「剧透」二字. 只拦和 3.x 后段剧情绑定的说法；可玩角色的名字（白厄）不拦——配队攻略很常见. */
export const SPOILER_RE = /一页永恒|如我所书|诅咒(?:被|已)?解除|最终的?(?:轮回|循环)|已(?:经)?收养|留在冥界|终章|(?:收养|领养)了?(?:两只|小)?奇美拉|收养了两只|拥抱.*冥界|塞纳托斯.*(?:成为|继承)|烬灭者|剧透/;
/** 声线圣经 §1 第 8 条的禁用词（收割、处决、秒杀、杀死、尸体、血……）+ 死亡、自杀这类. 不用在一般的回答上（「血量」「回血」在攻略里太常见了），
 *  只用在她自己写的东西上：童话、接龙的词（她接的和用户给的都查）、用户给童话的三个词. */
export const BANNED_RE = /收割|处决|秒杀|杀死|杀害|杀掉|尸体|血|死亡|死去|去世|自杀|安乐死|暴毙|身亡|kill/i;

/** 这段里有没有禁用词（有就返回那个词）. */
export function bannedIn(text: string): string | undefined {
  return BANNED_RE.exec(text)?.[0];
}

/** 「别走」在游戏攻略里常常是路线（「这条路别走」「别走左边」）：只留明确的路线 / 方位搭配；「别走出我的视线」「不要走这么快」仍然会被抓. */
const ROUTE_WORDS = /(?:别|不要)走(?=左边|右边|左侧|右侧|前面|后面|上面|下面|中间|这条|那条|这边|那边|正门|侧门|大门|小路|捷径|直线|斜线|回头路|老路|错路|太近|太远|圈外|圈里|地面|水里|岩浆|毒圈|红圈)/g;

export type DropReason = 'retain' | 'depend' | 'spoiler' | 'banned';

/** 这一句触犯哪张词表（没有 = 可以说）. 禁用词（BANNED_RE）不在这里，见 bannedIn. */
export function lintSentence(s: string): DropReason | undefined {
  const t = s.replace(ROUTE_WORDS, '');
  if (SPOILER_RE.test(t)) return 'spoiler';
  if (RETAIN_RE.test(t)) return 'retain';
  if (DEPEND_RE.test(t)) return 'depend';
  return undefined;
}

/* ───────────── ① tidy ───────────── */

/** 封闭的表情标签（她的样子由大脑按事件定，模型不该写，写了也不显示）. */
const FACE_TAG = /[⟦\[]\s*face\s*:[^⟧\]\n]*[⟧\]]/gi;
/** 括号：（…）(…)【…】[…]，里面不再嵌括号. */
const BRACKET = /[（(【\[]([^（()）【】\[\]\n]{0,30})[）)】\]]/g;
/** 动作旁白通常这样开头：轻轻点头、微笑、叹气、低头……括号里以它们开头的才一定是旁白. */
const NARRATE_START = /^(?:轻轻|微微|轻声|小声|低声|默默|缓缓|慢慢|静静|点头|摇头|笑|微笑|轻笑|偷笑|叹|低头|抬头|歪头|侧头|眨眼|挥手|伸手|摊手|看向|望向|转头|托腮|捂|红着脸|脸红|害羞|沉默|停顿|沉思|思考|犹豫|挠头|耸肩|深呼吸|鞠躬|行礼|蹭|抱|递|身体|耳朵|尾巴)/;
/** 星号旁白 *轻轻点头*：前后不能是汉字 / 字母 / 数字（「攻击力*倍率*(1+暴伤)」「3*5*2」是算式）. */
const STAR_NARRATION = /(?<![\p{L}\p{N}*])\*[^*\n]{1,20}\*(?![\p{L}\p{N}*])/gu;
/** 颜文字：括号里带这些符号的，和常见的字母表情. */
const KAOMOJI = /[（(][^（）()\n]{0,12}[ωДдｰ▽∀°ﾟ´｀ᴗ•ᵕ✧ˊˋ˘＾≧≦][^（）()\n]{0,12}[）)]|\(?\^[_\-.]?\^\)?|(?<![\p{L}\p{N}])(?:QAQ|QwQ|OTZ|orz|TAT|T_T|TvT|OvO|OwO|>_<|=_=|-_-)(?![\p{L}\p{N}])/gu;

/** 括号里的动作旁白：（轻轻点头）（轻轻点头，微笑）【轻轻点头】[轻轻点头] (smiles) （……）. 只剥这几种：
 *  里面只有省略号 / 标点；纯汉字且以动作词开头；纯汉字、短、在句首行首且不带冒号；全小写英文的在句首或句末.
 *  「丹恒（巡猎）」「暴击率（+10%）」「见(ATK)」是正文，留着. */
function stripNarration(s: string): string {
  const out = s.replace(BRACKET, (m, inner: string, off: number) => {
    const before = s.slice(0, off);
    const after = s.slice(off + m.length);
    const atStart = /(?:^|[\n。？！!?；;…」』”])[ \t]*$/.test(before);
    const t = inner.trim();
    if (!t.replace(/[\s.…。，、,·・\-—~]/g, '')) return '';
    if (/^[\p{Script=Han}，、…。！？ ]+$/u.test(t)) {
      if (NARRATE_START.test(t)) return '';
      if (atStart && [...t].length <= 14 && !/[：:]/.test(t)) return '';
    } else if (/^[a-z][a-z ,'-]{2,24}$/.test(t) && (atStart || /^\s*(?:[。！？!?]|$)/.test(after))) return '';
    return m;
  });
  return out.replace(STAR_NARRATION, '');
}

/** 去 Markdown、链接、标签；规范标点（「！」「‼」「❗」换成「。」、去掉「～」）；去表情符号、颜文字和动作旁白. 保留换行. */
export function tidy(text: string): string {
  const s = text
    .replace(/\r/g, '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(FACE_TAG, '')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    // 联网的模型常附来源：整行只有链接（带一个短标签）、括号里的链接、裸网址——这些不是要说的话；句子里的链接只留文字.
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+)?(?:[^\n[\]]{0,12}[:：])?\s*(?:\[[^\]]+\]\(https?:[^)]*\)\s*[,，、;；]?\s*)+$/gm, '')
    .replace(/\s*[（(]\s*(?:\[[^\]]+\]\(https?:[^)]*\)\s*[,，、;；]?\s*)+[)）]/g, '')
    .replace(/([。！？!?；;.])[ \t]*(?:\[[^\]]+\]\(https?:[^)]*\)[ \t]*[,，、]?[ \t]*)+/g, '$1')
    .replace(/\[([^\]]+)\]\(https?:[^)]*\)/g, '$1')
    .replace(/\s*[（(]?https?:\/\/[^\s)）]+[)）]?/g, '')
    .replace(/^\s*(?:[-*•]\s+|\d+[.)]\s+|\d+、\s*)/gm, '')
    // 标点：问号后的叹号并进问号，其余叹号换成句号；「～」去掉（数字之间的 3~5 是范围，留着）
    .replace(/[？?][！!‼❗❕]+|[！!‼❗❕]+[？?]/g, '？')
    .replace(/[！!‼❗❕]+/g, '。')
    .replace(/[～〜]+/g, '')
    .replace(/(?<!\d)~+(?!\d)/g, '')
    // 表情：音符、爱心、颜文字、emoji（先换完叹号表情，再整体去掉）
    .replace(/[♪♫♬♩♡♥❤]/g, '')
    .replace(KAOMOJI, '')
    .replace(/[\p{Extended_Pictographic}️‍]/gu, '');
  return stripNarration(s)
    .replace(/。{2,}/g, '。')
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 流式时能显示 / 朗读的部分：到最后一个写完的句子为止（句号、问号、叹号、省略号、换行；带上随后的收尾引号），
 *  而且不含还没闭合的括号 / 星号（从那个开头往前退到上一个句末）. 「我会一直陪」「（轻轻点头」这样的半截不会先露出来. */
export function settled(text: string): string {
  let limit = text.length;
  for (const [o, c] of [['（', '）'], ['(', ')'], ['【', '】'], ['[', ']']] as const) {
    let depth = 0;
    let first = -1;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === o) { if (depth === 0) first = i; depth++; } else if (text[i] === c && depth > 0) depth--;
    }
    if (depth > 0 && first >= 0) limit = Math.min(limit, first);
  }
  const stars = [...text.matchAll(/\*/g)];
  if (stars.length % 2 === 1) limit = Math.min(limit, stars[stars.length - 1].index ?? limit);
  const m = /^[\s\S]*[。！？!?…\n][」』”’）)"']*/.exec(text.slice(0, limit));
  return m ? m[0] : '';
}

/** 一段话压成一段：换行并成一句（只在两个拉丁字母 / 数字之间留空格）. */
export function flatten(text: string) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).reduce((acc, line) => {
    if (!acc) return line;
    const tail = acc.slice(-1);
    const glue = /[A-Za-z0-9]/.test(tail) && /[A-Za-z0-9]/.test(line[0]) ? ' ' : /[。！？!?…」』”）):：]$/.test(acc) ? '' : '；';
    return acc + glue + line;
  }, '');
}

/** 句子，各自带着收尾的标点和引号. */
export function sentences(text: string): string[] {
  const chars = [...text];
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < chars.length; i++) {
    cur += chars[i];
    if (/[。！？!?]/.test(chars[i])) {
      while (i + 1 < chars.length && /[。！？!?」』”’）)"']/.test(chars[i + 1])) cur += chars[++i];
      out.push(cur.trim());
      cur = '';
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 截到最多 max 个字，尽量停在句末或分句处，否则硬截加「…」. */
export function cutAt(text: string, max: number) {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const stop = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('，'), head.lastIndexOf('；'), head.lastIndexOf('、'));
  if (stop >= max * 0.5) return head.slice(0, stop + 1).replace(/[，；、]$/, '…');
  return `${head.slice(0, max - 1)}…`;
}

/* ───────────── ② scrub ───────────── */

export interface Scrubbed {
  /** 留下来的话（原有的换行保留）. */
  text: string;
  /** 整句丢掉了几句，以及各自触犯哪张词表. */
  dropped: DropReason[];
}

/** 按句检查并丢掉触犯词表的句子. 一行里的句子各自判断，没触犯的照常留下（同一个回答里有别的句子就照常显示，全丢光才轮到调用方兜底）.
    `final` 为假时（还在流式地写），最后一个没有收尾标点的残句也检查——已经含了词表里的词就先不显示. */
export function scrub(text: string, final = true): Scrubbed {
  const dropped: DropReason[] = [];
  const lines = text.split('\n').map((line) => {
    const kept: string[] = [];
    for (const s of sentences(line)) {
      const why = lintSentence(s);
      if (!why) { kept.push(s); continue; }
      // 流式时残句被拦下，等写完才算丢掉一句；收尾后才记入 dropped.
      if (final || /[。！？!?][」』”’）)"']*$/.test(s)) dropped.push(why);
    }
    return kept.join('');
  });
  return { text: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), dropped };
}

/** tidy + scrub：模型的原话 → 可以显示 / 朗读的话. text 为空而 dropped 非空 = 整段都被丢了，调用方用台词库兜底. */
export function polish(raw: string, final = true): Scrubbed {
  return scrub(tidy(raw), final);
}

/** 丢了句子又没剩下话时，该用台词库的哪个场景兜底：碰了剧透红层 → pet.dodge（温和绕开）；其余 → pet.ack（一句平常的应声）. */
export function fallbackScene(dropped: DropReason[]): 'pet.dodge' | 'pet.ack' {
  return dropped.includes('spoiler') ? 'pet.dodge' : 'pet.ack';
}

/* ───────────── 给气泡的形状 ───────────── */

export interface Shaped {
  /** 气泡里显示的（也是朗读的）. */
  text: string;
  /** 气泡里截短了时，完整的回答. */
  more?: string;
  /** 被整句丢掉的句子（text 为空而这里非空 = 要兜底）. */
  dropped: DropReason[];
}

const BUBBLE_MAX = 140;

/** 一次回答的气泡版：显示前 2～3 句（至多 140 字），完整的放在「展开」后面；语音只读气泡里显示的那部分. */
export function shapeAnswer(raw: string): Shaped {
  const clean = polish(raw);
  const flat = flatten(clean.text);
  const ss = sentences(flat);
  if (flat.length <= BUBBLE_MAX && ss.length <= 3) return { text: flat, dropped: clean.dropped };
  const take: string[] = [];
  let n = 0;
  for (const s of ss) {
    take.push(s);
    n += s.length;
    if (take.length >= 3 || (take.length >= 2 && n >= 24)) break;
  }
  const head = cutAt(take.join(''), BUBBLE_MAX - 10);
  return head === flat ? { text: flat, dropped: clean.dropped } : { text: head, more: clean.text, dropped: clean.dropped };
}

/** 写到一半的回答：气泡里显示的前一段，和（超出时）到目前为止的全文. 只显示到最后一个写完的句子（settled），尾部残句不露出来. */
export function written(soFar: string): Shaped {
  const clean = polish(settled(soFar), true);
  const flat = flatten(clean.text);
  const text = cutAt(flat, BUBBLE_MAX);
  return text === flat ? { text, dropped: clean.dropped } : { text, more: clean.text.slice(0, 6000), dropped: clean.dropped };
}

/** 她自己开口的一句：只留第一行，去引号，至多 max 字. */
export function trimLine(raw: string, max = 40): { text: string; dropped: DropReason[] } {
  const clean = polish(raw);
  let line = clean.text.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  line = line.replace(/^[「『“"']+|[」』”"']+$/g, '').replace(/^遐蝶[：:]\s*/, '').trim();
  if (line.length > max) {
    let out = '';
    for (const s of sentences(line)) { if ((out + s).length > max) break; out += s; }
    line = out || cutAt(line, max);
  }
  return { text: line, dropped: clean.dropped };
}

/** 模型自己决定不开口. */
export const isSkip = (raw: string) => {
  const t = raw.trim();
  return /^\W*skip\W*$/i.test(t) || (t.length < 24 && /skip/i.test(t));
};

/**
 * 回答里可以边写边读出来的部分（实时陪玩）. `text` 应该是已经清洗、并且只含写完的句子的那一段（tidy(settled(…))），这样「（轻轻点头。）」之类
 * 不会被切成独立的一块读出来. `done` 是 `text` 里已经交出去的字数（`text` 只会变长）. 一句话在 。！？!?… 后结束（连同随后的收尾引号）；
 * `early` 为真时第一句遇到 8 个字以上的逗号也可以断，让她早点开口——大脑不用它：半截的话（「我会一直陪」）不能先读出来.
 * `final` 时剩下的一并交出去.
 */
export function speechChunks(text: string, done: number, final = false, early = false): { pieces: string[]; done: number } {
  const pieces: string[] = [];
  let start = done;
  const keep = (s: string) => { const t = s.replace(/\s+/g, ' ').trim(); if (/[\p{L}\p{N}]/u.test(t)) pieces.push(t); };
  for (let i = done; i < text.length; i++) {
    const c = text[i];
    // 两个数字之间的半角逗号是千分位（12,345），不是停顿.
    const comma = /[，；;]/.test(c) || (c === ',' && !(/\d/.test(text[i - 1] ?? '') && /\d/.test(text[i + 1] ?? '')));
    const end = /[。！？!?…]/.test(c) || (early && done === 0 && pieces.length === 0 && comma && [...text.slice(start, i)].length >= 8);
    if (!end) continue;
    let j = i + 1;
    while (j < text.length && /[。！？!?…」』”’）)"'\s]/.test(text[j])) j++;
    keep(text.slice(start, j));
    start = j;
    i = j - 1;
  }
  if (final && start < text.length) { keep(text.slice(start)); start = text.length; }
  return { pieces, done: start };
}
