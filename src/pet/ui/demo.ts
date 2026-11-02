/* window.alightPet 的替身：在普通浏览器里打开 pet.html（npm run dev 的 /pet.html）时用，
   不接桌面也能看她、聊天框、气泡、小游戏的样子：说一句话、对提问给一句固定的流式回答、接龙和童话各演一小段。
   在应用里永远不会用到它（有 window.alightPet）。
   地址参数：?theme=day  ?scale=1.4  ?watch  ?mood=sleep|think|happy|shy|surprised|watch  ?long  ?chat  ?game=tarot|butterfly|chain|tale */
import type { PetChatEntry, PetChatMsg, PetGameKind, PetGameState, PetLine, PetMood, PetTale, PetUiCommand, PetUiState, PetWindowBridge } from '../contracts';
import { CHAT_MAX } from './chatLog';

/** 契约之外、桌宠窗口可选用的几个方法（主会话 / 主进程补上之前，页面按有没有来决定出不出对应的按钮）。 */
export interface PetExtras {
  saveTale?(t: { words: string[]; title: string; text: string }): Promise<{ ok: boolean; tale?: PetTale }>;
  realtime?(on: boolean): void;
  pause?(paused: boolean): void;
}
export type Bridge = PetWindowBridge & PetExtras;

export function demoBridge(): Bridge {
  const params = new URLSearchParams(location.search);
  const theme = params.get('theme') === 'day' ? 'day' : 'night';
  const subs = {
    cmd: new Set<(c: PetUiCommand) => void>(), state: new Set<(s: PetUiState) => void>(), line: new Set<(l: PetLine) => void>(),
    mood: new Set<(m: { mood: PetMood }) => void>(), chat: new Set<(m: PetChatMsg) => void>(), game: new Set<(s: PetGameState) => void>(),
  };
  const sub = <T,>(set: Set<(v: T) => void>) => (fn: (v: T) => void) => { set.add(fn); return () => { set.delete(fn); }; };
  // 记录，主进程那边（electron/pet/index.cjs）也这样记。
  const log: PetChatEntry[] = [];
  const tales: PetTale[] = [];
  let n = 0;
  const put = (entry: PetChatEntry) => {
    const i = log.findIndex((e) => e.id === entry.id);
    if (i >= 0) log[i] = entry; else log.push(entry);
    if (log.length > CHAT_MAX) log.splice(0, log.length - CHAT_MAX);
    subs.chat.forEach((fn) => fn({ op: 'put', entry }));
  };
  const say = (text: string, mood: PetMood = 'talk', more?: string, id = `demo-${++n}`, streaming = false, extra: Partial<PetChatEntry> = {}) => {
    subs.line.forEach((fn) => fn({ id, text, mood, more, streaming }));
    const at = log.find((e) => e.id === id)?.at ?? Date.now();
    put({ id, who: 'her', text, more, mood, streaming: streaming || undefined, at, ...extra });
  };
  const mine = (text: string) => put({ id: `me-${++n}`, who: 'me', text, at: Date.now() });
  const cmd = (c: PetUiCommand) => subs.cmd.forEach((fn) => fn(c));
  const gameState = (s: PetGameState) => subs.game.forEach((fn) => fn(s));
  const state: PetUiState = {
    theme, scale: Number(params.get('scale')) || 1, watching: params.has('watch'), paused: false, realtime: false, voice: false,
    follow: true, fpsCap: 60,
  };
  const LONG = ['第一步先把护盾打掉，然后集中输出弱点属性。', '第二步等他读条的时候走位，躲开地面的红圈。', '第三步趁硬直时开大招，注意留一点能量给下一个阶段。', '第四步把剩下的血量打完，掉落会在中间的箱子里。'];

  // 接龙演示：她接的都是现成的几个词，只为看状态条的样子。
  const CHAIN = ['海棠', '棠梨', '梨花', '花海'];
  let chain = 0;
  let playing: PetGameKind | null = null;

  setTimeout(() => {
    subs.state.forEach((fn) => fn(state));
    const mood = params.get('mood') as PetMood | null;
    if (params.has('chat')) {
      say('嗯，我在这里。', 'happy');
      mine('这个 Boss 怎么打？');
      say(LONG.slice(0, 2).join(''), 'talk', LONG.join('\n'));
      mine('好，我试试');
    }
    if (params.has('long')) say(LONG.slice(0, 2).join(''), 'talk', LONG.join('\n'));
    else say('嗯，我在这里。现在是浏览器里的预览，还没有接上桌面。', mood ?? 'talk');
    if (mood) subs.mood.forEach((fn) => fn({ mood }));
    if (params.has('chat')) cmd({ type: 'chat' });
    const g = params.get('game') as PetGameKind | null;
    if (g) cmd({ type: 'game', kind: g });
  }, 400);

  return {
    onCommand: sub(subs.cmd),
    onState: sub(subs.state),
    onLine: sub(subs.line),
    onLineDelta: () => () => {},
    onAudio: () => () => {},
    onMood: sub(subs.mood),
    onChat: sub(subs.chat),
    onGame: sub(subs.game),
    ask: (raw) => {
      const text = raw.trim();
      if (!text) return;
      mine(text);
      if (playing === 'chain') {
        const word = CHAIN[chain++ % CHAIN.length];
        setTimeout(() => { say(word, 'talk'); gameState({ kind: 'chain', active: true, nextChar: word.slice(-1), turns: chain * 2, hint: `轮到你，接「${word.slice(-1)}」` }); }, 500);
        return;
      }
      if (playing === 'tale') {
        const words = text.split(/[\s,，、]+/).filter(Boolean).slice(0, 3);
        const tale: PetTale = { id: '', words, title: '雪地里的灯', text: '从前，有一盏只在下雪时才亮的灯。它照过很多人回家的路，却从没见过春天。直到有一年，一只蝴蝶落在了灯罩上。', at: Date.now() };
        setTimeout(() => { say('', 'talk', undefined, `tale-${++n}`, false, { kind: 'tale', tale, text: `《${tale.title}》\n${tale.text}` }); gameState({ kind: 'tale', active: false }); playing = null; }, 800);
        return;
      }
      const id = `ask-${++n}`;
      say('嗯……让我想想。', 'think', undefined, id, true);
      const reply = `你说的是「${text.slice(0, 20)}」。这是预览里的固定回答，真正的回答由大脑通过模型生成，会像这样一点点写出来。`;
      let k = 0;
      const grow = () => {
        k = Math.min(reply.length, k + 6);
        if (k < reply.length) { say(reply.slice(0, k), 'talk', undefined, id, true); setTimeout(grow, 90); } else say(reply, 'talk', undefined, id);
      };
      setTimeout(grow, 700);
    },
    chatSync: () => subs.chat.forEach((fn) => fn({ op: 'reset', entries: log.slice() })),
    chatOpen: () => cmd({ type: 'chat' }),
    chatClose: () => cmd({ type: 'close-chat' }),
    chatFocus: () => {},
    hit: () => {},
    drag: () => {},
    menu: () => say('右键菜单只在桌面版里有。', 'idle'),
    spoken: () => {},
    mic: () => {},
    micFailed: () => {},
    click: () => say('嗯？我在呢。', 'shy'),
    game: (op, kind) => {
      playing = op === 'start' ? kind : null;
      if (op === 'start' && kind === 'chain') { chain = 0; gameState({ kind, active: true, turns: 0, hint: '你先说一个词' }); }
      else if (op === 'start' && kind === 'tale') gameState({ kind, active: true, hint: '给我三个词' });
      else if (op === 'stop') gameState({ kind, active: false });
    },
    gameSay: (l) => {
      say(l.text, l.mood ?? 'talk', undefined, undefined, false, l.card ? { kind: 'card', card: l.card } : {});
    },
    tales: async () => tales.slice().reverse(),
    saveTale: async (t) => {
      const tale: PetTale = { ...t, id: `tale-${tales.length + 1}`, at: Date.now() };
      tales.push(tale);
      return { ok: true, tale };
    },
    realtime: (on) => { state.realtime = on; subs.state.forEach((fn) => fn({ ...state })); },
    pause: (p) => { state.paused = p; subs.state.forEach((fn) => fn({ ...state })); },
  };
}
