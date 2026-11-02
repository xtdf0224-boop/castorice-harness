/* 桌宠的消息形状：大脑（主页面）、桌宠窗口、采集页三方共用。
   主进程（electron/pet/*.cjs）用同名通道和同样的字段，没有 TS 类型；见 docs/PET-PLAN.md。
   从萤火桌宠移植（firefly-harness 的 src/pet/contracts.ts），改动：形象模式换成夜 / 昼主题、心情多了 shy / surprised、
   加了小游戏和童话的消息。 */
import type { AgentEngine, ThemeId } from '../lib/types';

/** 她此刻的样子。分层木偶按它摆参数（src/pet/ui/rig/moods.ts），不是换图。 */
export type PetMood = 'idle' | 'talk' | 'think' | 'watch' | 'happy' | 'shy' | 'surprised' | 'sleep';
export type SceneState = 'static' | 'motion' | 'cut' | 'settled' | 'black';
export type FullscreenKind = 'no' | 'borderless' | 'exclusive';
export type WatchPolicy = 'watch' | 'chat-only' | 'never';
export type TtsProvider = 'elevenlabs' | 'minimax' | 'edge';
/** 小游戏：命途占卜、引蝶（都在桌宠窗口里玩完）、词语接龙、一起写童话（大脑出词 / 写字）。 */
export type PetGameKind = 'tarot' | 'butterfly' | 'chain' | 'tale';

export interface FocusApp {
  exe: string;          // 小写文件名，如 'starrail.exe'
  title: string;
  pid: number;
  hwnd: string;         // 十进制窗口句柄，desktopCapturer 的 'window:<hwnd>:0' 里就是它
  fullscreen: FullscreenKind;
  isGame: boolean;
  game?: string;        // 认得出时的显示名（崩坏：星穹铁道）
  policy: WatchPolicy;
  /** 带反作弊的游戏（policy.cjs）：它在前台时她的窗口藏起来，也不说话。 */
  antiCheat?: boolean;
}

/** 她说的一句话。`speak`：也读出来。 */
export interface PetLine {
  id: string;
  text: string;
  mood?: PetMood;
  speak?: boolean;
  /** 气泡里截掉的部分（完整回答）。 */
  more?: string;
  streaming?: boolean;
  /** 特殊的一句：tale = 一起写的童话（聊天记录里画成信笺，带「存下」）。'card' 只能由桌宠窗口的 gameSay 产生，页面发的会被主进程丢掉。 */
  kind?: 'text' | 'tale';
  /** kind = 'tale' 时这篇童话的内容（还没存，没有 id）。 */
  tale?: { words: string[]; title: string; text: string };
}

export interface PetFrame {
  mime: 'image/jpeg';
  data: string;         // base64
  width: number;
  height: number;
  at: number;
}

/** 主页面在桌宠设置或主题变化时整份发给主进程。 */
export interface PetRuntimeConfig {
  enabled: boolean;
  /** 聊天框和气泡跟着应用的夜 / 昼走；她本人不变。 */
  theme: ThemeId;
  scale: number;
  watch: boolean;
  neverWatch: string[];
  gameAllow: string[];
  gameDeny: string[];
  hotkeyAsk: string;
  hotkeyPause: string;
  /** 眼睛和头跟着鼠标看（主进程按需读光标位置，她被藏起来时不读）。 */
  follow: boolean;
  /** 动画帧率上限：30 或 60（说话、拖动、眨眼时才用到上限，平时更低）。 */
  fpsCap: 30 | 60;
  /** 实时陪玩此刻开得起来（存了 ElevenLabs 密钥，并且接了至少一个 API 方式的模型）。大脑算，桌宠窗口据此出「实时」按钮。 */
  realtimeReady: boolean;
  voice: { enabled: boolean; provider: TtsProvider; voiceId: string; volume: number; fallback: boolean; models: { elevenlabs: string; minimax: string } };
}

export interface PetUiState {
  theme: ThemeId;
  scale: number;
  watching: boolean;
  paused: boolean;
  realtime: boolean;
  /** 实时陪玩此刻正在听（听到有人说话，或按了「听我说一句」）。 */
  listening?: boolean;
  voice: boolean;
  follow: boolean;
  fpsCap: 30 | 60;
  /** 系统开了「减少动态效果」：只留眨眼、嘴型和很轻的呼吸。 */
  reducedMotion?: boolean;
  /** 同 PetRuntimeConfig.realtimeReady。 */
  realtimeReady?: boolean;
}

export type PetEvent =
  | { type: 'focus'; app: FocusApp }
  | { type: 'idle'; seconds: number }
  /** `since`：该状态开始的墙钟毫秒（Date.now() 刻度）；采集页只报持续了多久，capture.cjs 换算。 */
  | { type: 'scene'; state: SceneState; since: number; change: number }
  | { type: 'text'; lines: string[]; at: number }
  | { type: 'ask'; text: string }
  | { type: 'click' }
  | { type: 'pause'; paused: boolean }
  | { type: 'spoken'; lineId: string; state: 'start' | 'end' }
  | { type: 'rt'; state: 'connecting' | 'live' | 'closed' | 'error'; message?: string }
  /** 两个全局热键注册之后：哪个能用、不能用的原因（各一句中文）。 */
  | { type: 'hotkeys'; ask: boolean; pause: boolean; errors: string[] }
  /** 实时陪玩听到的：start 你开口了（她在说话就打断她）；partial / final 目前 / 整句的转写；none 这一轮没听到字。 */
  | { type: 'hear'; state: 'start' | 'partial' | 'final' | 'none'; text?: string }
  /** 桌宠窗口里开始 / 结束了一个小游戏。接龙和童话由大脑接手；占卜和引蝶只是告诉大脑别在这时插嘴。 */
  | { type: 'game'; op: 'start' | 'stop'; kind: PetGameKind }
  /** 桌宠窗口的「实时」按钮（或菜单）要开 / 关实时陪玩：大脑按设置调 realtime({op:'start',…}) / {op:'stop'}。 */
  | { type: 'rt-request'; on: boolean };

export type RealtimeCmd =
  | { op: 'start'; listen: 'auto' | 'key'; sensitivity: number; fastVoice: boolean; autoOffMin: number }
  | { op: 'stop' }
  /** 实时回答里写完的一句，写完就读。同一个 `id` 的句子接着播。 */
  | { op: 'say'; id: string; text: string }
  /** 马上停下她的实时语音（你插话了，或者有更新的回答顶替）。 */
  | { op: 'hush' };

/** 语音服务的一个模型，设置页这样列。 */
export interface TtsModel {
  id: string;
  name: string;
  /** 一句中文说明：音质 / 速度 / 注意事项。 */
  note?: string;
  /** 没选时用的那个。 */
  recommended?: boolean;
  /** 旧的或快下线的：还能用，排在最后。 */
  legacy?: boolean;
}

/** 一起写的童话。存在主进程的 userData/pet-tales.json（最多 100 篇，旧的先删）。 */
export interface PetTale {
  id: string;
  /** 你给的三个词。 */
  words: string[];
  title: string;
  text: string;
  at: number;
}

/** 大脑告诉桌宠窗口小游戏现在的样子（接龙轮到谁、上一个字；童话在写）。 */
export interface PetGameState {
  kind: PetGameKind;
  active: boolean;
  /** 接龙：下一个词要以这个字开头。 */
  nextChar?: string;
  /** 接龙：已经接了几个。 */
  turns?: number;
  /** 一句给人看的状态（「轮到你，接『棠』」）。 */
  hint?: string;
}

/** window.alightDesktop.pet（主页面）。 */
export interface PetBridge {
  configure(cfg: PetRuntimeConfig): void;
  say(line: PetLine): Promise<{ ok: boolean }>;
  frame(opts?: { maxSide?: number }): Promise<PetFrame | null>;
  ocr(): Promise<{ lines: string[] } | null>;
  /** 语音服务里能用作她的声音的音色。默认只列音色设计做的（designed）；all 为真时再加上现成音色（stock）。
   *  克隆出来的音色任何时候都不列，试听和使用前主进程还会再核对一次（用户硬约束：她的声音不能克隆声优）。 */
  voices(provider: TtsProvider, opts?: { all?: boolean }): Promise<Array<{ id: string; name: string; preview?: string; kind?: 'designed' | 'stock' }> | { error: string }>;
  testVoice(v: { provider: TtsProvider; voiceId: string; model?: string; text: string }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 有密钥的服务的语音模型：ElevenLabs 存了密钥时读账号里的实时列表，否则用内置清单。 */
  ttsModels(provider: Exclude<TtsProvider, 'edge'>): Promise<{ models: TtsModel[]; live: boolean } | { error: string }>;
  saveTtsKey(provider: Exclude<TtsProvider, 'edge'>, key: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }>;
  clearTtsKey(provider: Exclude<TtsProvider, 'edge'>): Promise<{ ok: true } | { ok: false; error: string }>;
  ttsKeys(): Promise<Partial<Record<TtsProvider, string>>>;
  realtime(cmd: RealtimeCmd): Promise<{ ok: true } | { ok: false; error: string }>;
  /** 小游戏的状态，转给桌宠窗口。 */
  gameState(s: PetGameState): void;
  /** 存一篇写好的童话；返回存下的那篇（带 id）。 */
  saveTale(t: Omit<PetTale, 'id' | 'at'>): Promise<{ ok: true; tale: PetTale } | { ok: false; error: string }>;
  onEvent(fn: (ev: PetEvent) => void): () => void;
}

/** 主进程让桌宠窗口做的事（呼出热键、菜单、双击会打开聊天框）。 */
export type PetUiCommand =
  | { type: 'chat' } | { type: 'close-chat' } | { type: 'hush' }
  /** 主进程又让窗口点击穿透了（藏起来、重载、丢了键盘）：忘掉指针在哪，下次移动重新报。 */
  | { type: 'pointer' }
  /** 右键菜单里选了小游戏。 */
  | { type: 'game'; kind: PetGameKind }
  /** 主进程按需发来的光标位置（屏幕坐标，相对她头部的中心，物理像素）。follow 关着或她藏起来时不发。 */
  | { type: 'look'; dx: number; dy: number };

/** 聊天框里的一条。记录在主进程（electron/pet/index.cjs），所以聊天框关了、窗口重建了都还在。 */
export interface PetChatEntry {
  id: string;
  who: 'me' | 'her';
  text: string;
  /** `text` 是气泡里截短的版本时，她的完整回答。 */
  more?: string;
  /** 她还在写：同一个 id 继续长。 */
  streaming?: boolean;
  mood?: PetMood;
  /** 你通过麦克风说的（实时陪玩），不是打的字。 */
  voice?: boolean;
  /** 特殊的一条：tale 童话（信笺样式，可存下），card 占卜翻出的牌。 */
  kind?: 'text' | 'tale' | 'card';
  /** kind = 'card'：翻出的命途（官方命途图标的文件名后缀，如 remembrance）。 */
  card?: string;
  /** kind = 'tale'：这篇童话（存下之后带 id）。 */
  tale?: PetTale;
  /** Date.now()：这一条开始的时间。 */
  at: number;
}

/** `pet-ui:chat`：整份记录（页面要时）、加一条或长了一条、撤回一条。 */
export type PetChatMsg =
  | { op: 'reset'; entries: PetChatEntry[] }
  | { op: 'put'; entry: PetChatEntry }
  | { op: 'drop'; id: string };

/** `pet-ui:audio` 的一条：一句话语音的一块，或者结束。 */
export type PetAudioMsg =
  | {
    lineId: string;
    seq: number;
    chunk: Uint8Array;
    mime: string;
    /** 0–100：页面按它调增益（语音服务不管音量）。 */
    volume?: number;
    /** 实时陪玩：裸 16 位 PCM，不是 mp3，边到边播。 */
    live?: boolean;
  }
  | {
    lineId: string;
    end: true;
    /** 合成失败的原因；这句不播。 */
    failed?: string;
  };

/** window.alightPet（桌宠窗口）。 */
export interface PetWindowBridge {
  onCommand(fn: (c: PetUiCommand) => void): () => void;
  onState(fn: (s: PetUiState) => void): () => void;
  onLine(fn: (l: PetLine) => void): () => void;
  onLineDelta(fn: (d: { id: string; text: string }) => void): () => void;
  onAudio(fn: (a: PetAudioMsg) => void): () => void;
  onMood(fn: (m: { mood: PetMood }) => void): () => void;
  onChat(fn: (m: PetChatMsg) => void): () => void;
  onGame(fn: (s: PetGameState) => void): () => void;
  /** 聊天框里你发的话（聊天框不关）。 */
  ask(text: string): void;
  /** 要整份记录（回 `{ op: 'reset' }`）：页面挂好监听后发一次。 */
  chatSync(): void;
  /** 打开聊天框（双击、聊天按钮）；主进程回 `chat` 命令。 */
  chatOpen(): void;
  /** 你关了聊天框（Esc、×）：交还键盘。 */
  chatClose(): void;
  /** 聊天框开着、别的窗口拿着键盘时你点回来了：重新拿键盘。 */
  chatFocus(): void;
  /** 点了她（按下后没变成拖动）。 */
  click(): void;
  hit(over: boolean): void;
  drag(phase: 'start' | 'move' | 'end', x: number, y: number): void;
  menu(): void;
  spoken(lineId: string, state: 'start' | 'end'): void;
  mic(pcm: Int16Array): void;
  /** 实时陪玩：麦克风打不开，或用到一半没了。主进程结束这次实时陪玩并说明原因。 */
  micFailed(): void;
  /** 开始 / 结束一个小游戏（主进程转给大脑）。 */
  game(op: 'start' | 'stop', kind: PetGameKind): void;
  /** 桌宠窗口自己玩完的小游戏（占卜、引蝶）里她说的一句：主进程按普通台词处理（记进聊天记录、气泡、朗读），
   *  文字先过台词清洗（去「！」「～」、截长）。card：占卜翻出的命途。 */
  gameSay(line: { text: string; mood?: PetMood; card?: string }): void;
  /** 存下的童话，新的在前。 */
  tales(): Promise<PetTale[]>;
  /** 信笺上的「存下」（通道 pet-ui:tale-save，主进程写 pet-tales.json）。 */
  saveTale(t: Omit<PetTale, 'id' | 'at'>): Promise<{ ok: true; tale: PetTale } | { ok: false; error: string }>;
  /** 「实时」按钮：开 / 关实时陪玩（通道 pet-ui:realtime，主进程转给大脑 PetEvent { type:'rt-request' }）。 */
  realtime(on: boolean): void;
  /** 「暂停看屏」按钮：和暂停热键一样（通道 pet-ui:pause）。 */
  pause(paused: boolean): void;
}

export type { AgentEngine };
