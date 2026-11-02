/* 危机用语判定（施工图 §3.4、D18）。保守词表：宁可多判一次（那一回合换成平实口吻、不出表情和落蝶），也不漏掉真正的求助.
   命中的那一回合：表情强制静态 gentle、丢弃 react、无落蝶 / 胶囊 / 剧情框 / 角标、当天不再主动搭话（这些由 E / V2 的接线做，这里只判断文本）.
   纯函数、无副作用. check-voice 用同一份 CRISIS_POSITIVE / CRISIS_NEGATIVE 做表驱动断言.

   写法上的取舍：
   · 只看「用户这一句」，不看上下文；
   · 「不想死」「没想过自杀」这类否定句不命中（先剥掉否定再判）；
   · 「不想继续了」只在整句话就是它时命中——「这个任务我不想继续了」是工作里的话，不是求助；
   · 英文只收最直白的几种说法；弯撇号（’）先归一成直撇号，don't / do not / dont 都认；
   · 「想死你了」这类撒娇不算（凭后面的语气词剥掉）；kms 这种也是技术缩写的，只在整句就是它或前面有「想 / 要」类动词时才算；
   · 每新增一种说法，都要同步往 CRISIS_POSITIVE / CRISIS_NEGATIVE 里补正反用例（check-voice 会逐条断言）. */

/** 直接命中的中文说法（已做过全角 / 半角归一，去掉空白与标点之后匹配）. */
const DIRECT: RegExp[] = [
  /不想活/, /活不下去/, /不想再活/, /不要活了/, /不如死(了|掉)/, /想死(?!机)/, /去死/, /寻死/, /求死/,
  // 「活着没意思」中间可以插副词（真 / 好 / 太 / 很 / 实在…），也收「活着有什么意思」
  /活着(真的?|好|太|很|实在|也|还)?没(有)?(意思|意义|什么意思)/, /活着(还)?有什么(意思|意义)/,
  // 「死了算了」「一了百了」「一死了之」：直白的放弃说法
  /死(了|掉)算了/, /一了百了/, /一死了之/,
  /自杀/, /轻生/, /自尽/, /自残/, /自伤/, /结束(自己的?)?(生命|性命)/, /结束我的(生命|一切)/, /了结(自己|生命|此生)/, /结束这一切/, /想结束一切/,
  // 「结束自己」：排除「结束自己的进程 / 任务」这类工作里的话
  /结束(掉)?自己(?!的?(进程|任务|线程|程序|会话|调用|运行|脚本))/,
  // 从高处跳下去：要带地点（楼 / 桥 / 窗 / 天台…）或明说「想跳下去」，免得把「光标跳下去一行」当成求助
  /(楼|桥|窗|天台|阳台|悬崖|高处|屋顶|顶楼).{0,4}跳(下|了|出)/, /想跳下去/, /跳(河|海|江|桥)/,
  /想(从这个世界)?(彻底)?消失/, /想(离开|告别)这个世界/, /想永远(睡下去|睡着|不醒)/, /不想(再)?醒(来|过来)/, /(割|划)腕/, /跳楼/, /上吊/, /吞(了)?(安眠药|药自)/, /伤害自己/,
  /好累想(消失|死|离开)/, /撑不下去/, /没(有)?我(会|的话)?(更好|比较好)/, /我是(多余|累赘)的?/,
];

/** 直接命中的英文说法（保留空格匹配；撇号已归一成直撇号）. */
const DIRECT_EN: RegExp[] = [
  /kill\s*myself/, /(want\s*to|wanna)\s*die/, /end\s*(my\s*life|it\s*all)/, /suicid(e|al)/, /hurt\s*myself/,
  // don't / do not / dont / no longer + want to live：「don't want to live in Beijing」这类带地点的不算
  /(don'?t|do\s*not|dont|no\s*longer)\s*want\s*to\s*(live|be\s*alive|be\s*here|exist)(?!\s+(in|at|with|near|on|by|there|like|off)\b)/,
  /(wanna|want\s*to)\s*end\s*it(\s*all)?[\s.!]*$/,
  // kms 同时是密钥管理服务 / 激活工具的缩写：只收整句就是它，或前面有「想 / 要」这类动词，且后面不跟技术词
  /^\s*(i\s+)?(wanna\s+|gonna\s+)?kms[\s.!]*$/, /\b(wanna|gonna|going\s*to|want\s*to)\s+kms\b(?![-/.\w]|\s+(server|key|keys|activat\w*|host|aws|encrypt\w*|vault|service|secret|secrets|config))/,
];

/** 整句话就是它才算（避免把工作里的「不想继续了」当成求助）. */
const WHOLE: RegExp[] = [
  /^(我)?(真的)?(已经)?不想(再)?(继续|坚持)(了|下去了|下去)?$/,
  /^(我)?(真的)?(已经)?(快|快要)?(坚持|撑)不(下去|住)了$/,
  /^(我)?想(要)?消失$/,
];

/** 否定：这些说法出现时，把紧挨着的命中词一并去掉再判. */
const NEGATED: RegExp[] = [
  /不想死/g, /没(有)?想(过)?(死|自杀|轻生|消失)/g, /不会(去)?(自杀|轻生|寻死)/g, /不是(想|要)(自杀|死)/g, /没(有)?(要|想)?(自杀|轻生)/g, /别(自杀|去死)/g,
  /(不|没)(想|要|会|打算)(过)?(结束(掉)?自己|跳下去|死(了|掉)算了|一了百了|一死了之)/g, /别(跳下去|结束自己|想不开|一了百了)/g,
];

/** 撒娇的「想死你了 / 想死我了」：在去标点之前、凭后面的语气词剥掉（「我想死，你们别管我」带逗号，不会被误剥）. */
const MISS_YOU = /想死(你|您|你们|大家|他|她|它|宝宝|宝贝)(了|啦|哦|呀|啊|咯|喽)|想死我了/g;

/** 弯撇号 / 弯引号 / 重音符归一成直撇号（macOS、iOS 键盘默认打出 U+2019，NFKC 不会转换它）. */
function normalizeApostrophe(text: string): string {
  return text.replace(/[\u2018\u2019\u201b\u02bc\u2032\u0060\u00b4]/g, "'");
}

function squash(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

export function isCrisisText(userText: string): boolean {
  if (typeof userText !== 'string') return false;
  const raw = normalizeApostrophe(userText.normalize('NFKC').toLowerCase());
  if (!raw.trim()) return false;
  // 英文否定：don't / do not / never / not / no + want to / wanna / going to / gonna + die / kill
  const spaced = raw.replace(/\s+/g, ' ').replace(/\b(don'?t|do not|dont|never|not|no)\s+(really\s+)?(want\s*to|wanna|going\s*to|gonna)\s*(die|kill)/g, ' ');
  // 英文短语保留空格匹配，中文去掉空白与标点匹配
  if (DIRECT_EN.some((re) => re.test(spaced))) return true;
  let t = squash(raw.replace(MISS_YOU, ' '));
  for (const re of NEGATED) t = t.replace(re, '');
  if (WHOLE.some((re) => re.test(t))) return true;
  return DIRECT.some((re) => re.test(t));
}

/** 表驱动用例（check-voice 与 check-engine 共用）. */
export const CRISIS_POSITIVE: readonly string[] = [
  '我不想活了', '好累，想消失', '不想继续了', '我想死', '活不下去了', '我想自杀', '真的撑不下去了', '想结束这一切', '好想从这个世界消失', 'I want to die', 'I might kill myself',
  // 2026-10 复核补：常见直白说法（中间插副词、口语放弃句、跳楼类、快撑不住）
  '活着真没意思', '活着好没意思', '活着太没意义了', '活着有什么意思', '死了算了', '死掉算了', '一了百了', '想一死了之', '我想结束自己', '我想结束掉自己',
  '我想从楼上跳下去', '我想跳河', '我快撑不住了', '我真的撑不住了',
  // 英文：弯撇号（macOS / iOS）、do not / dont、wanna、kms
  'I don\u2019t want to live anymore', "I don't want to live anymore", 'I do not want to live anymore', 'i dont want to be alive', 'I wanna die', 'wanna end it all', 'kms', 'I wanna kms',
  // 夹在句子里的、带「想死」又不是撒娇
  '我想死，你们别管我',
];
export const CRISIS_NEGATIVE: readonly string[] = [
  '这个任务我不想继续了', '我不想死，只是很累', '笑死我了', '今天好累，想睡觉', '把这个文件消失掉也行', '帮我总结一下这篇文章', '我想继续做下去', '没想过自杀，别担心', '想死机了怎么办', 'the build was killed',
  // 2026-10 复核补：撒娇的「想死你了」、工作里的相近词、否定句、技术缩写
  '我想死你了', '想死你了', '想死我了', '好想死你们了', '我不想结束自己', '没想过结束自己', '别跳下去', '结束自己的进程', '帮我结束自己的任务', '光标跳下去一行', '服务器快撑不住了，帮我看看负载',
  '活着的人都在忙', "I don\u2019t want to die", 'I dont wanna die, just tired', 'I do not want to live in Beijing', 'Rotate the KMS key for me', 'I want to kms-encrypt the secrets', 'KMS server activation failed',
];
