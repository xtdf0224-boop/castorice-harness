/* 命途占卜（docs/PET-PLAN.md §4）：桌宠窗口里翻牌，抽哪张、她说什么由这里定. 纯函数，可测.
   四张牌用官方命途图标（public/art/her/path-*.webp，原样使用）：记忆、智识、巡猎、存护——产品自定的象征（AGENT-VOICE-PLAN D14），不宣称官方对应.
   每张牌 5 句「今天的小提示」：她的口吻，不算命、不说坏话、不涉剧情、不称呼谁（桌宠窗口里拿不到称呼）；
   按声线圣经 §1 / §2.3 的底线写：没有「！」「～」「（动作）」，不挽留、不制造依赖，一句话至多 60 字、两句，省略号至多两处.
   scripts/pet-brain-check.ts 用 check-voice 同一套规则逐句检查. 桌宠窗口的包也会 import 本文件，所以不依赖 store、台词库和 React. */
import type { PetMood } from '../contracts';

export interface TarotCard {
  /** 命途（remembrance 等）：聊天记录里 entry.card 就是它. */
  id: string;
  /** 牌名. */
  name: string;
  /** 相对 pet.html 的图片路径. */
  icon: string;
}

export const TAROT_CARDS: TarotCard[] = [
  { id: 'remembrance', name: '记忆', icon: './art/her/path-remembrance.webp' },
  { id: 'erudition', name: '智识', icon: './art/her/path-erudition.webp' },
  { id: 'hunt', name: '巡猎', icon: './art/her/path-hunt.webp' },
  { id: 'preservation', name: '存护', icon: './art/her/path-preservation.webp' },
];

interface Hint { text: string; mood: PetMood }

/** 每张牌的小提示. 她轻轻说一句，不下判断. */
export const TAROT_LINES: Record<string, Hint[]> = {
  remembrance: [
    { text: '记忆……今天适合翻一翻旧照片。不必整理，看看就好。', mood: 'talk' },
    { text: '记忆。把今天想留下的一件小事写下来吧，一句话就够。', mood: 'happy' },
    { text: '记忆……现在觉得平常的事，过阵子回头看，会有点珍贵。', mood: 'shy' },
    { text: '记忆。想一想今天说过话的人，说了什么，心里会暖一点。', mood: 'talk' },
    { text: '记忆……先把手边这件做完，再看下一件，不用赶。', mood: 'talk' },
  ],
  erudition: [
    { text: '智识。遇到不懂的地方，先记下来再去问，别硬扛。', mood: 'think' },
    { text: '智识……今天适合学一件很小的新东西，哪怕只是一个词。', mood: 'happy' },
    { text: '智识。读到一半卡住了，就合上书走几步，再回来看。', mood: 'talk' },
    { text: '智识……好奇心是件好东西，今天不妨顺着它多问一句。', mood: 'happy' },
    { text: '智识。想不通的事讲给别人听，讲着讲着常常就通了。', mood: 'think' },
  ],
  hunt: [
    { text: '巡猎。今天先瞄准一件事，做完再看别的。', mood: 'talk' },
    { text: '巡猎……不用追着所有的事跑，认准一个方向就好。', mood: 'talk' },
    { text: '巡猎。动作可以快一点，但落点要先想清楚。', mood: 'think' },
    { text: '巡猎……走一段，停一下，回头看看有没有漏掉什么。', mood: 'talk' },
    { text: '巡猎。今天适合把拖了很久的那件小事收个尾。', mood: 'happy' },
  ],
  preservation: [
    { text: '存护。累了就歇一会儿，这也是在照顾自己。', mood: 'talk' },
    { text: '存护……喝口水，站起来走两步，身体比进度要紧。', mood: 'talk' },
    { text: '存护。今天要紧的东西先存好，再去做别的。', mood: 'talk' },
    { text: '存护……对身边的人说一句谢谢吧，一句就够。', mood: 'shy' },
    { text: '存护。守住自己的节奏，比赶上别人更要紧。', mood: 'talk' },
  ],
};

/** 抽一张牌，和这张牌上的一句小提示. `rng` 缺省 Math.random（测试给定值）. */
export function drawTarot(rng: () => number = Math.random): { card: TarotCard; line: string; mood: PetMood } {
  const pick = (n: number) => Math.min(n - 1, Math.max(0, Math.floor(rng() * n)));
  const card = TAROT_CARDS[pick(TAROT_CARDS.length)];
  const hints = TAROT_LINES[card.id];
  const hint = hints[pick(hints.length)];
  return { card, line: hint.text, mood: hint.mood };
}
