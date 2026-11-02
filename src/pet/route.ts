/* 哪个模型回答对桌宠的提问（docs/PET-PLAN.md §4，从萤火的 route.ts 原样移植）. 纯函数：中文关键词和几条简单的判断，不调模型.
   'web' = 要最新的游戏知识（攻略、配队、版本……），'vision' = 问的是屏幕上的东西，'chat' = 其余. */

export type RouteKind = 'web' | 'vision' | 'chat';

export interface Route {
  kind: RouteKind;
  /** A picture of the screen goes along (vision always; web when the question points at the screen). */
  sight: boolean;
  /** The question points at the screen but she cannot look right now. */
  wantsSight: boolean;
}

export interface RouteCtx {
  /** A game is the program in front. */
  game: boolean;
  /** She may look at it right now (watching on, not paused, policy 'watch', picture available). */
  watchable: boolean;
}

/** Needs current knowledge from the web: guides, builds, drops, versions, banners. */
const WEB = new RegExp([
  '攻略', '配队', '配装', '阵容', '搭配', '怎么打', '怎么过', '怎么玩', '怎么获得', '怎么得到', '怎么拿', '怎么解锁', '怎么刷', '怎么养',
  '怎么培养', '怎么凹', '怎么抽', '哪里刷', '哪里找', '哪里有', '哪里买', '在哪(?:里|儿)?(?:刷|找|买|拿|打|获得|得到|抽|领|解锁|看|搜)', '掉落', '刷什么', '刷哪', '突破材料', '升级材料',
  '版本', '更新', '维护', '活动', '复刻', '卡池', '抽卡', '池子', '保底', '强度', '排行', '梯度', '节奏榜', '遗器', '圣遗物', '光锥', '武器',
  '天赋', '加点', '培养', '养成', '兑换码', '机制', '打法', '弱点', '隐藏', '成就', '彩蛋', '收集', '宝箱', '联动', '前瞻', '预告',
  '新角色', '最新', '联网(?:查|搜)', '搜一下', '搜搜', '查一下', '查查', '帮我查', '帮我搜', 'wiki', '百科', '声优', '剧情解析', '背景故事',
  // A time word needs a real noun after it: a bare 新 / 开 / 池 would make "现在开始吧" a web search.
  '(?:今天|本周|这周|本期|最近|现在).{0,6}(?:活动|更新|卡池|维护|版本|上线)',
].join('|'), 'i');

/** Points at what is on the screen. */
const DEIXIS = /这个|这里|这儿|这边|这只|这关|这是|这些|这张|这位|这种|这波|这段|这块|这一|画面|屏幕|看看|看下|看一下|看一眼|瞅|你看|帮我看|能看到|看得到|看到了|眼前|面前|当前|现在(?:的|这)|这.{0,2}(?:怪|boss|敌人|角色|地图|任务|关卡|谜题|机关|门|房间)/i;

/** 游戏里的东西：只有问到这些（或带了指示词）的提问才值得带一张截图；单纯带问号的闲话（「今天吃什么？」「明天天气怎么样」）不带. */
const GAMEWORD = /怪|boss|敌人|关卡|任务|地图|角色|技能|副本|谜题|机关|战斗|剧情|对话|宝箱|血量|血条|装备|遗器|光锥|队伍|队友|配队|伤害|攻击|防御|闪避|大招|卡关|通关|打不过|怎么打|怎么过|往哪|去哪|走哪|怎么走|路线|入口|出口|传送|按钮|界面|菜单|设置|背包|商店|奖励|体力|开拓力|频道|怎么开|怎么关|怎么用|怎么进|怎么选|怎么切|怎么调|怎么退|怎么解锁|怎么触发|怎么领/i;

/** Sounds like a question or a request. */
const QUESTION = /[?？]|吗|怎么|怎样|如何|什么|为什么|为啥|咋|哪|谁|几|多少|能不能|可不可以|是不是|会不会|要不要|该不该|行不行|有没有|对不对|难道/;
const ASK_VERB = /告诉我|帮我|给我|推荐|说说|讲讲|介绍|想知道|求|查|搜/;

/** A greeting or a thanks at the start (with what follows it): "好的，下个版本的卡池是什么时候？" is a question that
 *  only starts politely, so it is cut off before the question is judged. "hi" / "hello" need a non-letter after them. */
const GREETING = /^(?:(?:你好|您好|嗨|哈喽|hello|hi|在吗|早安|早上好|晚安|谢谢|多谢|辛苦|哈哈|嗯+|好的|好吧|拜拜|再见)(?![a-z])[\s,，。.!！~～、…:：]*)+/i;

/** Chatting with her, not asking the game: no picture, no web. */
const SMALLTALK = new RegExp([
  '你(?:是谁|叫什么|喜欢|爱|会不会|几岁|多大|吃了|睡了|困不困|累不累|在干嘛|在做什么|怎么样|还好吗|开心吗|无聊吗|饿不饿|冷不冷)',
  '讲个|说个|唱(?:首|个|支|歌|一)|聊聊|(?:想|来|找你|跟你|和你)聊天|聊天吧|陪我',
].join('|'), 'i');

/** A short remark rather than a short question: "我抽卡又歪了", "活动好累". */
const REMARK = /^[我咱俺]|[了啊呀吧哦嘛哈啦噢喔。.!！~～…]$/;

/** "X 是谁 / 是什么 / 什么意思": a lookup about the game's world, not about the screen. */
const KNOWLEDGE = /.{1,12}(?:是谁|是什么|什么意思|啥意思|有什么用|有啥用)/;

export function routeQuestion(raw: string, ctx: RouteCtx): Route {
  const t = raw.trim();
  const none: Route = { kind: 'chat', sight: false, wantsSight: false };
  if (!t) return none;
  const deixis = DEIXIS.test(t);
  // What is asked, without the greeting in front of it.
  const body = t.replace(GREETING, '').trim();
  const asking = QUESTION.test(body) || ASK_VERB.test(body) || (body.length <= 8 && !REMARK.test(body));

  if (SMALLTALK.test(t) && !deixis) return none;
  // Only a greeting, or a greeting and a remark: small talk. A real question after it is judged on its own.
  if (body.length < t.length && !deixis && !(WEB.test(body) && asking)) {
    const bare = body.replace(/[\s\p{P}]/gu, '');
    if (bare.length < 4 || !(QUESTION.test(body) || ASK_VERB.test(body))) return none;
  }
  if (WEB.test(body) && asking) return { kind: 'web', sight: deixis && ctx.watchable, wantsSight: deixis };
  if (deixis) return ctx.watchable ? { kind: 'vision', sight: true, wantsSight: true } : { kind: 'chat', sight: false, wantsSight: true };
  if (ctx.game && KNOWLEDGE.test(t)) return { kind: 'web', sight: false, wantsSight: false };
  if (ctx.game && ctx.watchable && QUESTION.test(t) && GAMEWORD.test(t)) return { kind: 'vision', sight: true, wantsSight: true };
  return none;
}
