/* 引蝶（docs/PET-PLAN.md §4）：桌宠窗口里 30 秒，光标停住不动，附近的蝴蝶会落下来. 画面和计时在窗口里，计分与结束台词在这里. 纯函数，可测.
   结束台词按停下的比例分五档：一只没有、不到四成、四成到八成、只差一点、全部；每档几句，她轻轻说，不评分、不催、不说「下次再来」之类留人的话.
   同样按声线圣经 §1 / §2.3 写：没有「！」「～」「（动作）」，一句话至多 60 字、两句，省略号至多两处. 桌宠窗口的包也 import 本文件，所以不依赖 store、台词库和 React. */
import type { PetMood } from '../contracts';

/** 一局的长度（秒）. */
export const BUTTERFLY_SECONDS = 30;

export type ButterflyTier = 'none' | 'few' | 'some' | 'half' | 'most' | 'all';

/** 停下的比例 → 哪一档. */
export function butterflyTier(caught: number, total: number): ButterflyTier {
  const t = Math.max(0, Math.floor(total));
  const c = Math.max(0, Math.min(t, Math.floor(caught) || 0));
  if (c <= 0) return 'none';
  if (t > 0 && c >= t) return 'all';
  const r = t > 0 ? c / t : 0;
  if (r < 0.4) return 'few';
  if (r < 0.5) return 'some';
  if (r < 0.8) return 'half';
  return 'most';
}

/** 每档的句子：{c} 是停下的只数，{t} 是一共飞出来几只. */
const LINES: Record<ButterflyTier, Array<{ text: string; mood: PetMood }>> = {
  none: [
    { text: '一只也没有停下……没关系，它们本来就怕生。', mood: 'talk' },
    { text: '这一轮它们都躲开了。蝴蝶就是这样，安静一点再试试。', mood: 'think' },
    { text: '唔……没能留住。别在意，蝴蝶比人更挑时候。', mood: 'shy' },
  ],
  few: [
    { text: '停下了 {c} 只。它们慢慢才肯靠近，这样已经不错。', mood: 'talk' },
    { text: '{c} 只落下来了，一共 {t} 只。慢一点，它们会靠近的。', mood: 'talk' },
    { text: '有 {c} 只愿意停下来呢，光是这样就很好看。', mood: 'happy' },
  ],
  // 四成到五成：已经不少了，但还没过半
  some: [
    { text: '停下了 {c} 只，一共 {t} 只。手很稳呢。', mood: 'happy' },
    { text: '{c} 只……已经不少了。它们好像不那么怕了。', mood: 'happy' },
    { text: '落下了 {c} 只。再安静一点，剩下的也会来。', mood: 'talk' },
  ],
  // 过半（>= 0.5）才说「过半」
  half: [
    { text: '停下了 {c} 只，一共 {t} 只。手很稳呢。', mood: 'happy' },
    { text: '{c} 只……已经过半了。它们好像不怕了。', mood: 'happy' },
    { text: '落下了 {c} 只，过半了呢。再安静一点，剩下的也会来。', mood: 'talk' },
  ],
  most: [
    { text: '停下了 {c} 只，一共 {t} 只，只差一点了。', mood: 'surprised' },
    { text: '{c} 只都落下来了，几乎全部。真漂亮。', mood: 'happy' },
    { text: '差一点就全部了。这样已经很难得。', mood: 'shy' },
  ],
  all: [
    { text: '全部停下来了，{t} 只都在。真漂亮。', mood: 'happy' },
    { text: '{t} 只都落下来了……一只也没有少。', mood: 'surprised' },
    { text: '诶，全部都留住了。蝴蝶今天特别信任这里。', mood: 'shy' },
  ],
};

/** 这一局的结束台词（停下 caught 只，一共 total 只）. `rng` 缺省 Math.random. */
export function butterflyEndLine(caught: number, total: number, rng: () => number = Math.random): { text: string; mood: PetMood } {
  const t = Math.max(0, Math.floor(total) || 0);
  const c = Math.max(0, Math.min(t, Math.floor(caught) || 0));
  const list = LINES[butterflyTier(c, t)];
  const hit = list[Math.min(list.length - 1, Math.max(0, Math.floor(rng() * list.length)))];
  return { text: hit.text.replace(/\{c\}/g, String(c)).replace(/\{t\}/g, String(t)), mood: hit.mood };
}

/** 供检查用：所有结束台词的模板. */
export const BUTTERFLY_TEMPLATES: ReadonlyArray<{ tier: ButterflyTier; text: string; mood: PetMood }> =
  (Object.entries(LINES) as Array<[ButterflyTier, Array<{ text: string; mood: PetMood }>]>).flatMap(([tier, list]) => list.map((l) => ({ tier, ...l })));
