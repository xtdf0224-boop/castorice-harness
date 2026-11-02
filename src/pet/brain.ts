/* 桌宠的大脑（docs/PET-PLAN.md §4，从萤火的 src/pet/brain.ts 移植）. 跑在主页面里：模型接入、人设、设置都在这儿的 store 里.
   它听桌面感知到的一切（前台的程序、画面、用户的话、桌宠窗口里的小游戏），决定什么时候说话、说什么，调模型，再把台词发回桌宠窗口.
   触发规则在 triggers.ts，提示词在 prompts.ts（人设基底 persona.PET_SYSTEM），提问路由在 route.ts，选模型在 engines.ts，
   模型写出来的话一律过 tidy.ts 再显示 / 朗读（去「！」「～」、丢掉挽留 / 依赖 / 剧透的句子，丢光了就换台词库 pet.* 的兜底句），小游戏的规则在 games/*.ts.
   createBrain 把依赖当参数收进来，scripts/pet-brain-check.ts 才能拿假桌面、假模型流来驱动它. */
import { isCrisisText } from '../lib/crisis';
import { desktop, openStream, type ContentPart, type StartSpec, type StreamEvent } from '../lib/desktop';
import type { Level, ModelState, PetSettings, TaskEngine, ThemeId } from '../lib/types';
import { voiceNow } from '../lib/voice';
import { actions } from '../state/actions';
import { petApiSpec, petCliSpec } from '../state/live';
import { store } from '../state/store';
import type { FocusApp, PetBridge, PetEvent, PetFrame, PetGameKind, PetGameState, PetLine, PetMood, PetRuntimeConfig } from './contracts';
import { petChatEngine, petLiveEngine, petVisionEngine, petWebEngine } from './engines';
import { STOP_WORDS, chainPrompt, checkWord, lastChar, normalizeWord, parseWordReply } from './games/chain';
import { parseTale, parseTaleWords, talePrompt } from './games/tale';
import {
  DESCRIBE_SYSTEM, askText, cliPrompt, describeText, errorLine, noModelLine, petLine, petSystem, proactiveText, remember, thinkLine, toMessages,
  type AskCtx, type NoImage, type PetWho, type Turn,
} from './prompts';
import { routeQuestion, type Route } from './route';
import {
  LIMITS, imagesLeft, newMemory, nextTrigger, noteLine, noteUser, tickIgnored, trackScene, type SceneTrack, type Trigger, type TriggerCtx,
} from './triggers';
import { fallbackScene, flatten, isSkip, lintSentence, polish, settled, shapeAnswer, speechChunks, tidy, trimLine, written } from './tidy';

/** 看有没有话要自己说的间隔. */
const TICK_MS = 5000;
/** 一次回答超过这么久没写完就放弃. */
const ASK_TIMEOUT_MS = 45_000;
const WEB_TIMEOUT_MS = 100_000;
const PROACTIVE_TIMEOUT_MS = 30_000;
const OCR_WAIT_MS = 4000;
/** 实时陪玩：一句话的回答超过这么久没写完就放弃；等画面也不超过这个. */
const LIVE_TIMEOUT_MS = 20_000;
const LIVE_FRAME_WAIT_MS = 700;
/** 实时陪玩：这么短的间隔里听到的下一句，而前一句的回答还没开口，两句并成一个问题. */
const LIVE_JOIN_MS = 6000;
/** 实时陪玩：一轮说出口的问答之后，这么久里她不自己再起一句. */
const LIVE_QUIET_MS = 20_000;
/** 气泡里的字边写边显示. */
const STREAM_PUSH_MS = 150;
/** 一句话「正在读」超过这么久没收到结束消息，就当它丢了（桌宠页崩溃、隐藏、重载）. */
const SPEAKING_WATCHDOG_MS = 60_000;
/** 小游戏：这么久没有任何动静，就当它已经结束（窗口丢了停止消息时，不让她永远不插嘴）. */
const GAME_IDLE_MS = 30 * 60_000;
/** 接龙里她想一个词最多等多久；写一篇童话最多等多久. */
const CHAIN_TIMEOUT_MS = 25_000;
/** 接龙里她回一个词，输出上限（仍远低于 600；模型有一点思考的余地）. */
const CHAIN_MAX_TOKENS = 200;
const TALE_TIMEOUT_MS = 60_000;

/** 桌宠设置页监听的事件：语音密钥存了或删了（设置页派发，大脑重新读一遍密钥，重算「实时陪玩开得起来吗」）. */
export const TTS_KEYS_EVENT = 'pet-tts-keys';

export interface BrainDeps {
  bridge: PetBridge;
  read(): { pet: PetSettings; theme: ThemeId; callName: string; level: Level; persona: boolean; models: ModelState };
  stream(spec: StartSpec, on: (ev: StreamEvent) => void, onId?: (id: string) => void): Promise<string>;
  stop(id: string): void;
  /** 回答桌宠的命令行模型时没有人在提示框前：它请求的一切（权限、提问、计划）一律拒绝. */
  deny(id: string, requestId: string): void;
  /** 命令行模型用的空文件夹. */
  workspace(): Promise<string>;
  toast(t: { tone: 'info' | 'warning' | 'danger' | 'success'; title: string; body?: string }): void;
  now(): number;
  rand(): number;
}

export interface Brain {
  start(): () => void;
  /** 看一眼有没有话要自己说（计时器调它）. */
  tick(): Promise<void>;
  handle(ev: PetEvent): void;
  ask(text: string): Promise<void>;
  realtime(on: boolean): Promise<void>;
  /** 语音密钥变了：重新读，重算 realtimeReady 并把配置发给桌面. */
  refreshKeys(): Promise<void>;
  /** 测试用：她记得的对话. */
  history: Turn[];
}

const image = (f: PetFrame): ContentPart => ({ type: 'image', mime: 'image/jpeg', data: f.data });
const withTimeout = <T>(p: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);

/** 一次进行中的模型调用. `abort` 让正在等它的那次调用立刻结束（run 设的）. */
interface Active { cancelled: boolean; id?: string; abort?: () => void; timedOut?: boolean; stopped?: boolean }

/* ───────────── 热键注册的结果 ───────────── */

/** 桌面最后一次注册两个全局热键后说的（`hotkeys` 事件）. */
export interface HotkeyStatus { ask: boolean; pause: boolean; errors: string[] }

let hotkeyStatus: HotkeyStatus | undefined;
const hotkeyListeners = new Set<() => void>();

/** 给设置页（React 的 useSyncExternalStore）用：桌面还没说话之前 `get` 是 undefined，那时不当作有哪个失败了；没事件时返回同一个对象. */
export const hotkeyStore = {
  get: (): HotkeyStatus | undefined => hotkeyStatus,
  subscribe(fn: () => void) {
    hotkeyListeners.add(fn);
    return () => { hotkeyListeners.delete(fn); };
  },
};
function publishHotkeys(s: HotkeyStatus | undefined) {
  hotkeyStatus = s;
  hotkeyListeners.forEach((fn) => fn());
}

/** 一个进行中的小游戏（只有接龙和童话由大脑接手；占卜和引蝶只是让她别在这时插嘴）. */
interface Play {
  kind: PetGameKind;
  /** 最近一次动静（开始、结束、用户在游戏里说话），用来判断窗口是不是把停止消息弄丢了. */
  last: number;
  chain?: { prev: string | null; used: Set<string>; turns: number; busy: boolean };
  tale?: { busy: boolean };
}

export function createBrain(deps: BrainDeps): Brain {
  const { bridge } = deps;
  const mem = newMemory();
  const history: Turn[] = [];
  const imagesSent: number[] = [];
  let focus: FocusApp | undefined;
  let focusSince = 0;
  let scene: SceneTrack | undefined;
  let idle: { seconds: number; at: number } | undefined;
  let text: { lines: string[]; at: number } | undefined;
  let ocrLines: string[] = [];
  let paused = false;
  let speaking = false;
  let speakingSince = 0;
  let busy = 0;
  let active: Active | undefined;
  /** 她自己的一句话正在写（一个提问会取消它）. */
  let proactiveRun: Active | undefined;
  let ticking = false;
  let seq = 0;
  let rtLive = false;
  /** 实时陪玩已经真的开起来了（收到过 live，还没结束）. */
  let rtHeard = false;
  /** 实时陪玩：说出口的回答、它回答的问题、有没有已经开口. */
  let live: Active | undefined;
  let liveQ: { text: string; at: number; spoke: boolean; id: string; spoken: string[]; held: string[]; dropped: boolean } | undefined;
  /** 实时陪玩：用户正说到一半（听到 start，还没有 final）：她的回答先等着. */
  let userTalking = false;
  let lastLiveAt = 0;
  let lastRt = '';
  let cwd: string | undefined;
  let lastCfg = '';
  let lastPet: PetSettings | undefined;
  let lastTheme: ThemeId | undefined;
  let lastModels: ModelState | undefined;
  let wasOn: boolean | undefined;
  /** 提示过「音色 ID 还没填」（状态消失之前不再说）；上一次同步时桌宠是不是开着. */
  let voiceHinted = false;
  let lastPetOn = false;
  let lastClickAt = 0;
  /** 最近发给桌宠窗口的一句话的 id. */
  let lastSentId = '';
  /** 桌面最后说的热键注册结果（undefined：还没说，不当作失败）. */
  let hotkeys: HotkeyStatus | undefined;
  /** 存了 ElevenLabs 的密钥吗（实时陪玩的听和说都用它）. 读不到就当没有. */
  let haveElevenKey = false;
  /** 进行中的小游戏，和接龙 / 童话里她正在想的那一次模型调用. */
  let play: Play | undefined;
  let playRun: Active | undefined;

  const lineId = (p: string) => `${p}_${deps.now().toString(36)}_${++seq}`;
  const whoOf = (r: ReturnType<BrainDeps['read']>): PetWho => ({ callName: r.callName, level: r.level, theme: r.theme, persona: r.persona });
  const who = (): PetWho => whoOf(deps.read());

  /** 把一句话发给桌宠窗口；resolve 的是有没有真的显示出来（她的窗口藏起来时桌面会丢掉）. */
  async function sayShown(line: PetLine): Promise<boolean> {
    lastSentId = line.id;
    // 主进程不再清洗：每一句话（包括台词库的句子、带着模型报错原文的出错句）发出去之前，都再过一遍出口清洗.
    const out = exit(line);
    if (!out) return false;
    try { return (await bridge.say(out)).ok; } catch { return false; }
  }
  /** 出口清洗：去「！」「～」和动作旁白，丢掉挽留 / 依赖 / 剧透的句子. 整句都被丢光 = 不发（要兜底的，在这之前已经换成台词库的句子了）. */
  function exit(line: PetLine): PetLine | undefined {
    const final = !line.streaming;
    const text = polish(line.text, final).text;
    if (!text) return undefined;
    const out: PetLine = { ...line, text };
    if (line.more) {
      const more = polish(line.more, final).text;
      if (more) out.more = more; else delete out.more;
    }
    return out;
  }
  /** 发给桌宠窗口. 还在写的话带 `streaming`. */
  function say(line: PetLine) {
    void sayShown(line);
  }
  /** 台词库 pet.* 里的一句（口吻关着走纯事实；没有事实可说的场景此时不出声）. */
  function sayScene(scene: string, slots: Record<string, string | number> = {}, o: { speak?: boolean; id?: string } = {}) {
    const l = petLine(scene, who(), { slots, now: deps.now() });
    if (!l.text) return;
    say({ id: o.id ?? lineId('l'), text: l.text, mood: l.mood, speak: !!o.speak });
  }

  /* ───────────── 设置 → 桌面 ───────────── */

  /** 实时陪玩此刻开得起来吗：存了 ElevenLabs 的密钥，并且接了至少一个 API 方式的模型. */
  function realtimeReady(r: ReturnType<BrainDeps['read']>) {
    return haveElevenKey && !!petLiveEngine(r.models, r.pet.vision);
  }

  /** 当前选的语音服务的音色 ID. */
  const voiceIdOf = (pet: PetSettings) => pet.voice.voiceIds[pet.voice.provider].trim();

  function config(): PetRuntimeConfig {
    const r = deps.read();
    const { pet } = r;
    return {
      enabled: pet.enabled, theme: r.theme, scale: pet.scale, watch: pet.watch,
      neverWatch: pet.neverWatch, gameAllow: pet.gameAllow, gameDeny: pet.gameDeny,
      hotkeyAsk: pet.hotkeyAsk, hotkeyPause: pet.hotkeyPause, follow: pet.follow, fpsCap: pet.fpsCap,
      realtimeReady: realtimeReady(r),
      // 音色 ID 分服务存（settings.pet.voice.voiceIds）；给主进程的是当前服务的那一个.
      voice: { enabled: pet.voice.enabled, provider: pet.voice.provider, voiceId: voiceIdOf(pet), volume: pet.voice.volume, fallback: pet.voice.fallback, models: pet.voice.models },
    };
  }
  function sync(force = false) {
    // 任务在跑的时候 store 一秒变好多次；这里只关心桌宠自己的设置、夜昼和模型接入.
    const r = deps.read();
    if (!force && r.pet === lastPet && r.theme === lastTheme && r.models === lastModels) return;
    lastPet = r.pet;
    lastTheme = r.theme;
    lastModels = r.models;
    // 关了「看游戏画面」（或桌宠本身）：从屏幕上读到的东西一并丢掉.
    if (!r.pet.watch || !r.pet.enabled) forgetScreen();
    // 刚刚关掉：她手上在做的（一个回答、一次搜索、她自己的一句话、一段小游戏）不再做完给没人看.
    if (wasOn && !r.pet.enabled) {
      stopWork();
      endPlay(false);
      hotkeys = undefined;
      publishHotkeys(undefined);
    }
    // 刚刚打开（不是应用启动时就开着）：说一句短的招呼，告诉怎么叫她.
    if (wasOn === false && r.pet.enabled) {
      const key = r.pet.hotkeyAsk;
      // 桌宠窗口要一小会儿才加载好；那时桌面已经说过热键有没有注册上（没说过就不当作失败）.
      setTimeout(() => {
        const keyed = hotkeys?.ask !== false;
        const l = petLine(keyed ? 'pet.hello.hotkey' : 'pet.hello.dblclick', who(), { slots: { key }, now: deps.now() });
        if (l.text) say({ id: lineId('l'), text: l.text, mood: l.mood, speak: false });
      }, 1600);
      void refreshKeys();
    }
    wasOn = r.pet.enabled;
    // 朗读开着，选的却是要音色 ID 的服务（ElevenLabs / MiniMax）而没填：只有填了音色 ID 才出声（「备用」也只落到微软晓晓，不是她的声音）.
    // 说一句让去设置里填，每次这个状态出现只说一次（刚开桌宠时排在招呼后面）.
    const needsVoiceId = r.pet.enabled && r.pet.voice.enabled && r.pet.voice.provider !== 'edge' && !voiceIdOf(r.pet);
    if (!needsVoiceId) voiceHinted = false;
    else if (!voiceHinted) {
      voiceHinted = true;
      const justOn = !lastPetOn;
      setTimeout(() => {
        const now = deps.read().pet;
        if (now.enabled && now.voice.enabled && now.voice.provider !== 'edge' && !voiceIdOf(now)) sayScene('pet.err.voiceid');
      }, justOn ? 3600 : 300);
    }
    lastPetOn = r.pet.enabled;
    // 实时陪玩开着时设置变了：桌面不用重启就能收到新的.
    if (rtLive) {
      const opts = liveOptions(r.pet);
      const o = JSON.stringify(opts);
      if (o !== lastRt) { lastRt = o; void bridge.realtime(opts).catch(() => {}); }
    }
    const cfg = config();
    const sig = JSON.stringify(cfg);
    if (sig === lastCfg) return;
    lastCfg = sig;
    bridge.configure(cfg);
  }

  async function refreshKeys() {
    try { haveElevenKey = !!(await bridge.ttsKeys()).elevenlabs; } catch { haveElevenKey = false; }
    sync(true);
  }

  /* ───────────── 桌面告诉我们的 ───────────── */

  /** 停掉她手上所有的回答（提问、搜索、她自己的一句、说出口的回答、接龙 / 童话里想的那一次）：都不要了. */
  function stopWork() {
    cancel(active);
    cancel(proactiveRun);
    cancel(playRun);
    if (liveQ) liveQ.dropped = true;
    cancel(live);
    liveQ = undefined;
    userTalking = false;
  }

  /** 屏幕上读来的文字只在她可以看的时候留着：暂停、关了「看游戏画面」、前台变成不能看的程序，都清掉. */
  function forgetScreen() {
    text = undefined;
    ocrLines = [];
  }

  /** 前台是她此刻可以看的游戏（设置、暂停、策略都放行）. */
  function mayWatch(pet: PetSettings) {
    return pet.enabled && pet.watch && !paused && !!focus?.isGame && focus.policy === 'watch';
  }

  /** 小游戏正在玩（窗口把停止消息弄丢了的话，半小时后当作结束）. */
  function playing() {
    return !!play && deps.now() - play.last < GAME_IDLE_MS;
  }

  function handle(ev: PetEvent) {
    const t = deps.now();
    switch (ev.type) {
      case 'focus': {
        const prev = focus;
        focus = ev.app;
        if (!prev || prev.exe !== ev.app.exe || prev.hwnd !== ev.app.hwnd) {
          focusSince = t;
          scene = undefined;
          forgetScreen();
        }
        // 同一个程序的策略变了（用户标了「不要看」）也一样.
        if (ev.app.policy !== 'watch' || !ev.app.isGame) forgetScreen();
        break;
      }
      case 'idle': idle = { seconds: ev.seconds, at: t }; break;
      case 'scene': scene = trackScene(scene, { state: ev.state, since: ev.since }, t); break;
      case 'text':
        // 对一个她已经不该再看的程序，识别结果迟到了：丢掉.
        if (!mayWatch(deps.read().pet)) break;
        text = { lines: ev.lines, at: ev.at };
        ocrLines = [...ocrLines, ...ev.lines].slice(-30);
        break;
      case 'ask': void ask(ev.text); break;
      case 'click': {
        noteUser(mem, t);
        // 点一下会打断正在想、正在写或正在读的回答：这时点击只算「用户在」.
        if (busy > 0 || speaking) break;
        if (t - lastClickAt < 2500) break;
        lastClickAt = t;
        sayScene('pet.click');
        break;
      }
      case 'pause': {
        paused = ev.paused;
        if (ev.paused) {
          forgetScreen();
          // 暂停了看屏：在路上的主动搭话（可能已经取了画面、正在等模型）作废.
          cancel(proactiveRun);
        }
        sayScene(ev.paused ? 'pet.pause.on' : 'pet.pause.off');
        break;
      }
      case 'hotkeys':
        hotkeys = { ask: ev.ask, pause: ev.pause, errors: [...ev.errors] };
        publishHotkeys(hotkeys);
        break;
      case 'spoken':
        speaking = ev.state === 'start';
        if (speaking) speakingSince = t;
        break;
      case 'rt': {
        const wasLive = rtHeard;
        // 只有真正 live 才算开着：connecting 时、以及我们自己发了 stop 之后，设置变了都不会重发 start（重开麦克风）.
        rtLive = ev.state === 'live';
        rtHeard = ev.state === 'live';
        // connecting → live 才算开了；出错或带原因地结束，说明原因；平平地结束，只说一句收尾（没开成就结束的不说）.
        if (ev.state === 'live' && !wasLive) sayScene('pet.rt.on');
        else if (ev.state === 'error' || (ev.state === 'closed' && ev.message)) sayScene('pet.err.voice', { reason: (ev.message ?? '实时陪玩出错了').replace(/\s+/g, ' ').slice(0, 70) });
        else if (ev.state === 'closed' && wasLive) sayScene('pet.rt.off');
        break;
      }
      case 'rt-request': void realtime(ev.on); break;
      case 'hear':
        if (ev.state === 'start') {
          userTalking = true;
          noteUser(mem, t);
          // 她自己正在写的一句让路；已经开口的回答也让路（桌面已经把她的声音截断了）；还没开口的回答等用户说完.
          cancel(proactiveRun);
          if (live && liveQ?.spoke) { liveQ.dropped = true; cancel(live); }
        } else if (ev.state === 'final') {
          userTalking = false;
          if (ev.text) void liveAsk(ev.text);
          else releaseHeld();
        } else if (ev.state === 'none') {
          // 其实不是说话（咳嗽、游戏声）：憋着的话现在说.
          userTalking = false;
          releaseHeld();
        }
        break;
      case 'game': gameEvent(ev.op, ev.kind); break;
    }
  }

  /* ───────────── 跑一次模型 ───────────── */

  /** 开一条流，resolve 它的最后一条消息：命令行模型可能先说「我去查一下」，搜完再答，只有答案是她要说的. `onText` 看到的是当前这条消息写到哪了. */
  function run(spec: StartSpec, a: Active, ms: number, onText?: (soFar: string) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      let acc = '';
      let fresh = false;
      let over = false;
      const finish = (fn: () => void) => { if (over) return; over = true; clearTimeout(timer); fn(); };
      const timer = setTimeout(() => {
        // 超时时流的 id 可能还没到（start 还没返回）：记下来，id 一到就停流.
        finish(() => { a.timedOut = true; halt(a); reject(new Error('等了太久，没有收到回复。')); });
      }, ms);
      // 取消的调用立刻不再等（cancel() 会自己停流）.
      a.abort = () => finish(() => reject(new Error('已取消。')));
      a.stopped = false;
      deps.stream(spec, (ev) => {
        if (a.cancelled || over) return;
        if (ev.type === 'text') {
          if (fresh && ev.text.trim()) { acc = ''; fresh = false; }
          acc += ev.text;
          onText?.(acc);
        } else if (ev.type === 'text-break') fresh = true;
        // 没有人在提示框前：权限、提问、计划一律拒绝.
        else if (ev.type === 'permission' || ev.type === 'question' || ev.type === 'plan-ready') deps.deny(ev.id, ev.requestId);
        // `done` 带的是所有消息拼起来的全文；最后一条才是答案.
        else if (ev.type === 'done') finish(() => resolve(acc.trim() ? acc : ev.text));
        else if (ev.type === 'error') finish(() => reject(new Error(ev.message)));
      }, (id) => { a.id = id; if (a.cancelled || a.timedOut) halt(a); }).then((id) => { a.id = id; if (a.cancelled || a.timedOut) halt(a); }, (e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });
  }

  function cancel(a: Active | undefined) {
    if (!a) return;
    a.cancelled = true;
    halt(a);
    a.abort?.();
  }

  /** 停掉这次调用的流（只停一次：id 一到和超时/取消可能都来叫）. */
  function halt(a: Active) {
    if (!a.id || a.stopped) return;
    a.stopped = true;
    deps.stop(a.id);
  }

  async function scratch() {
    if (!cwd) cwd = await deps.workspace().catch(() => undefined);
    return cwd;
  }

  /** 这会儿为什么拿不到画面（undefined = 可以看）. */
  function noSight(pet: PetSettings): NoImage | undefined {
    if (!pet.watch) return 'off';
    if (paused) return 'paused';
    if (!focus || !focus.isGame || focus.policy === 'never') return 'none';
    if (focus.policy !== 'watch') return 'chat-only';
    // 全黑只有在独占全屏时才确定是「没有画面」；加载界面、暗场景看起来一样，别的时候她仍试着抓一帧（抓不到再说是黑的）.
    if (scene?.state === 'black' && focus.fullscreen === 'exclusive') return 'black';
    return undefined;
  }

  /* ───────────── 一个提问 ───────────── */

  async function ask(raw: string) {
    const question = raw.trim();
    if (!question) return;
    const t = deps.now();
    noteUser(mem, t);
    // 小游戏里也要先查危机文字：命中就结束游戏（不说收尾的话），走下面正常的危机分支——小游戏的规则不拦住关心.
    if (play && isCrisisText(question)) endPlay(false);
    if (play && playing() && (play.kind === 'chain' || play.kind === 'tale')) { void playAsk(question); return; }
    cancel(active);
    // 她自己还在写的一句：丢掉，连它的流一起停掉——先答提问.
    cancel(proactiveRun);
    // 说出口的回答（实时陪玩）也一样，不然两个回答会互相截断声音.
    if (liveQ) liveQ.dropped = true;
    cancel(live);
    const a: Active = { cancelled: false };
    active = a;
    busy++;
    const id = lineId('ask');
    const r = deps.read();
    const w = whoOf(r);
    try {
      // 对方流露自伤的念头：这一回合换成平实口吻，不看画面、不联网，只关心.
      const crisis = isCrisisText(question);
      const why = noSight(r.pet);
      const route: Route = crisis ? { kind: 'chat', sight: false, wantsSight: false } : routeQuestion(question, { game: !!focus?.isGame && focus.policy !== 'never', watchable: !why });
      const workdir = await scratch();
      const vision = petVisionEngine(r.models, r.pet.vision);
      const web = route.kind === 'web' ? petWebEngine(r.models, r.pet.web, workdir) : undefined;
      const chat = petChatEngine(r.models, { vision: r.pet.vision, cwd: workdir });
      if (!web && !chat) { say({ id, text: noModelLine(w) || errorLine(w, '没有可用的模型'), mood: 'think', speak: false }); return; }

      const thinking = thinkLine(w, !!web, deps.now());
      if (thinking && !crisis) say({ id, text: thinking, mood: 'think', streaming: true });

      // 画面：只在问题指着屏幕、她可以看、又有一个能看图的模型时才有. 屏幕上的文字只跟游戏相关的提问一起走，闲聊不带.
      const aboutGame = route.kind !== 'chat' || route.wantsSight;
      const ctx: AskCtx = { question, app: crisis ? undefined : focus, ocr: aboutGame && !why ? ocrLines.slice(-12) : [], image: false };
      let frame: PetFrame | null = null;
      if (route.wantsSight && !why) {
        if (!vision) ctx.noImage = 'no-model';
        else if (imagesLeft(imagesSent, r.pet.imagesPerHour, t, false) <= 0) ctx.noImage = 'budget';
        else {
          frame = await bridge.frame({ maxSide: 1280 }).catch(() => null);
          if (!frame) ctx.noImage = scene?.state === 'black' ? 'black' : 'none';
        }
        if (frame) {
          const o = await withTimeout(bridge.ocr().catch(() => null), OCR_WAIT_MS, null);
          if (o?.lines.length) ctx.ocr = o.lines.slice(-12);
        }
      } else if (route.wantsSight) ctx.noImage = why;
      if (a.cancelled) return;

      let answer: string;
      const push = streamer(id, a);
      if (web) {
        // 命令行模型收不到图：画面先由看图模型压成一句话，作为文字带过去.
        if (frame && vision) {
          imagesSent.push(deps.now());
          const spec = petApiSpec(vision, { system: DESCRIBE_SYSTEM, messages: [{ role: 'user', content: [image(frame), { type: 'text', text: describeText(question, focus) }] }], maxTokens: 160 });
          if (spec.ok) ctx.seen = polish(await run(spec.value, a, ASK_TIMEOUT_MS).catch(() => '')).text.slice(0, 200) || undefined;
        }
        if (a.cancelled) return;
        const spec = petCliSpec(web, { system: petSystem(w, 'web'), prompt: cliPrompt(ctx, history, w), webSearch: true });
        if (!spec.ok) throw new Error(spec.error);
        answer = await run(spec.value, a, WEB_TIMEOUT_MS, push);
      } else {
        const engine = chat!;
        ctx.image = !!frame;
        if (route.kind === 'web') ctx.noWeb = true;
        if (frame) imagesSent.push(deps.now());
        answer = await run(replySpec(engine, w, ctx, frame, crisis), a, ASK_TIMEOUT_MS, push);
      }
      if (a.cancelled) return;

      const shaped = shapeAnswer(answer);
      let reply = shaped.text;
      let mood: PetMood = 'talk';
      if (!reply) {
        // 整段话都被出口清洗丢掉了（挽留 / 依赖 / 剧透）：换成台词库里的兜底句.
        if (!shaped.dropped.length) throw new Error('模型没有回复。');
        const f = petLine(fallbackScene(shaped.dropped), w, { now: deps.now() });
        reply = f.text;
        mood = f.mood;
      }
      if (!reply) throw new Error('模型没有回复。');
      say({ id, text: reply, more: shaped.text ? shaped.more : undefined, mood, speak: true });
      const at = deps.now();
      remember(history, [{ role: 'user', text: question, at }, { role: 'assistant', text: reply, at }], at);
      noteLine(mem, at, false);
    } catch (e) {
      if (!a.cancelled) {
        const msg = e instanceof Error ? e.message : String(e);
        const l = petLine('pet.err.model', w, { slots: { reason: msg.replace(/\s+/g, ' ').trim().slice(0, 70) }, now: deps.now() });
        say({ id, text: l.text || msg, mood: 'think', speak: false });
      }
    } finally {
      busy--;
      if (active === a) active = undefined;
    }
  }

  /** API 模型（没有任何 API 模型时，是一个没有工具的命令行模型）这一轮的 spec. */
  function replySpec(engine: TaskEngine, w: PetWho, ctx: AskCtx, frame: PetFrame | null, crisis = false): StartSpec {
    const body = askText(ctx);
    const system = petSystem(w, 'ask', { crisis });
    if (engine.auth === 'cli') {
      const s = petCliSpec(engine, { system, prompt: cliPrompt(ctx, history, w), webSearch: false });
      if (!s.ok) throw new Error(s.error);
      return s.value;
    }
    const messages = toMessages(history, frame ? [image(frame), { type: 'text', text: body }] : body);
    const s = petApiSpec(engine, { system, messages, maxTokens: 500 });
    if (!s.ok) throw new Error(s.error);
    return s.value;
  }

  /** 回答写到哪，就在气泡里显示到哪（写完才读出来）. 每次都过出口清洗：还没写完的残句里已经含了词表里的词就先不显示. */
  function streamer(id: string, a: Active) {
    let last = 0;
    return (soFar: string) => {
      const t = deps.now();
      if (a.cancelled || t - last < STREAM_PUSH_MS) return;
      const shown = written(soFar);
      if (!shown.text) return;
      last = t;
      say({ id, text: shown.text, more: shown.more, mood: 'talk', streaming: true });
    };
  }

  /* ───────────── 她自己开口 ───────────── */

  /** 没有模型（或模型没接）时，各种触发用台词库里现成的一句：不花钱，也说得过去. 卡住了要看了画面才知道，所以没有现成的. */
  const CANNED: Partial<Record<Trigger['kind'], string>> = { greet: 'pet.game.start', cut: 'pet.cut', text: 'pet.text', win: 'pet.win', late: 'pet.late' };

  async function proactive(trigger: Trigger) {
    const r = deps.read();
    // 招呼和夜里的提醒不靠屏幕；其余的要她此刻可以看（触发之后设置可能变了）.
    const sees = mayWatch(r.pet);
    if (trigger.kind !== 'greet' && trigger.kind !== 'late' && !sees) return;
    const w = whoOf(r);
    const t = deps.now();
    // 先登记，提问才能在任何一步取消它，哪怕还在取画面.
    const a: Active = { cancelled: false };
    proactiveRun = a;
    busy++;
    try {
      const canned = async () => {
        const scene = CANNED[trigger.kind];
        if (!scene || a.cancelled) return;
        const l = petLine(scene, w, { now: t });
        if (!l.text) return;
        if (!await sayShown({ id: lineId('p'), text: l.text, mood: l.mood, speak: true })) return;
        const at = deps.now();
        noteLine(mem, at, true);
        remember(history, [{ role: 'assistant', text: l.text, at }], at);
      };
      // 夜里提一次休息：现成的一句就够，不调模型.
      if (trigger.kind === 'late') { await canned(); return; }
      // 她自己想说的一句话只走 API 方式：命令行方式启动要好几秒、还占订阅额度，不值得（没有 API 模型就用台词库里现成的一句）.
      const engine = trigger.image ? petVisionEngine(r.models, r.pet.vision) : petChatEngine(r.models, { vision: r.pet.vision });
      if (!engine || engine.auth !== 'api') { await canned(); return; }
      let frame: PetFrame | null = null;
      if (trigger.image) {
        frame = await bridge.frame({ maxSide: 1024 }).catch(() => null);
        if (!frame || a.cancelled) return;
        imagesSent.push(deps.now());
      }
      const body = proactiveText({ kind: trigger.kind, app: focus, ocr: sees ? ocrLines.slice(-10) : [], lines: sees ? trigger.lines : undefined, staticMs: trigger.staticMs, image: !!frame });
      const system = petSystem(w, 'proactive');
      const s = petApiSpec(engine, { system, messages: [{ role: 'user', content: frame ? [image(frame), { type: 'text', text: body }] : body }], maxTokens: 160 });
      if (!s.ok) return;
      if (a.cancelled) return;
      const raw = await run(s.value, a, PROACTIVE_TIMEOUT_MS);
      // 她想的时候用户问了话：她自己的这句只会碍事.
      if (a.cancelled || mem.lastUserAt > t || busy > 1 || isSkip(raw)) return;
      const line = trimLine(raw, LIMITS.lineMax).text;
      if (!line) return;
      // 桌面没显示出来的话（她的窗口藏起来了）等于没说：不计数，也不记进对话.
      if (!await sayShown({ id: lineId('p'), text: line, mood: 'talk', speak: true })) return;
      const at = deps.now();
      noteLine(mem, at, true);
      remember(history, [{ role: 'assistant', text: line, at }], at);
    } catch { /* 她自己想说的话从来不值得弹一条错误 */ } finally {
      busy--;
      if (proactiveRun === a) proactiveRun = undefined;
    }
  }

  async function tick() {
    if (ticking) return;
    // 「读完了」的消息可能丢了（桌宠页崩溃、隐藏、重载）：她不能从此哑掉.
    if (speaking && deps.now() - speakingSince > SPEAKING_WATCHDOG_MS) speaking = false;
    const { pet } = deps.read();
    if (!pet.enabled || pet.proactivity === 'off') return;
    ticking = true;
    try {
      const t = deps.now();
      tickIgnored(mem, t);
      const ctx: TriggerCtx = {
        now: t, proactivity: pet.proactivity, cooldownSec: pet.cooldownSec, focus, focusSince, scene, idle, text,
        paused, watching: pet.watch, busy: busy > 0 || speaking, realtime: rtLive && t - lastLiveAt < LIVE_QUIET_MS, minigame: playing(),
        images: imagesLeft(imagesSent, pet.imagesPerHour, t, true),
      };
      const trigger = nextTrigger(mem, ctx, deps.rand);
      if (trigger) await proactive(trigger);
    } finally {
      ticking = false;
    }
  }

  /* ───────────── 小游戏（接龙、童话由大脑接手；占卜、引蝶只让她别插嘴）───────────── */

  function publishGame(s: PetGameState) {
    try { bridge.gameState(s); } catch { /* 桌面没接上：窗口自己的界面不受影响 */ }
  }

  /** 结束当前的小游戏. `byUser`：用户中途叫停（接龙 / 童话时她说一句收尾的话）. */
  function endPlay(byUser: boolean) {
    const g = play;
    if (!g) return;
    play = undefined;
    cancel(playRun);
    playRun = undefined;
    if (g.kind === 'chain' || g.kind === 'tale') {
      publishGame({ kind: g.kind, active: false });
      if (byUser) sayScene(g.kind === 'chain' ? 'pet.play.chain.stop' : 'pet.play.stop');
    }
  }

  function gameEvent(op: 'start' | 'stop', kind: PetGameKind) {
    const t = deps.now();
    if (op === 'stop') {
      if (play?.kind === kind) endPlay(true);
      return;
    }
    if (play) endPlay(false);
    play = { kind, last: t };
    noteUser(mem, t);
    // 她自己正在写的一句让路（小游戏进行中她不主动搭话）.
    cancel(proactiveRun);
    if (kind === 'chain') {
      play.chain = { prev: null, used: new Set(), turns: 0, busy: false };
      publishGame({ kind, active: true, turns: 0, hint: '轮到你，先说一个词' });
      sayScene('pet.play.chain.start');
    } else if (kind === 'tale') {
      play.tale = { busy: false };
      publishGame({ kind, active: true, hint: '给她三个词，用空格隔开' });
      sayScene('pet.play.tale.start');
    }
  }

  /** 接龙 / 童话进行中，用户在聊天框里说的话. */
  async function playAsk(raw: string) {
    const g = play;
    if (!g) return;
    g.last = deps.now();
    if (STOP_WORDS.test(raw.trim())) { endPlay(true); return; }
    if (g.kind === 'chain') await chainTurn(g, raw);
    else if (g.kind === 'tale') await taleTurn(g, raw);
  }

  /** 她这一轮想事情用的模型（接龙和童话都不带图、不联网）；没有就说明，游戏结束. */
  async function playEngine(g: Play): Promise<{ engine: TaskEngine; w: PetWho } | undefined> {
    const r = deps.read();
    const engine = petChatEngine(r.models, { vision: r.pet.vision, cwd: await scratch() });
    if (!engine) {
      sayScene('pet.err.nomodel');
      if (play === g) endPlay(false);
      return undefined;
    }
    return { engine, w: whoOf(r) };
  }

  /** 单条用户消息 → 一次模型调用 → 原文（接龙 / 童话共用）. */
  function oneShot(engine: TaskEngine, w: PetWho, kind: 'chain' | 'tale', prompt: string, maxTokens: number): StartSpec {
    const system = petSystem(w, kind);
    if (engine.auth === 'cli') {
      const s = petCliSpec(engine, { system, prompt, webSearch: false });
      if (!s.ok) throw new Error(s.error);
      return s.value;
    }
    const s = petApiSpec(engine, { system, messages: [{ role: 'user', content: prompt }], maxTokens });
    if (!s.ok) throw new Error(s.error);
    return s.value;
  }

  async function chainTurn(g: Play, raw: string) {
    const c = g.chain;
    if (!c || c.busy) return;
    const word = normalizeWord(raw);
    const chk = checkWord(word, c.prev, c.used);
    if (!chk.ok) { sayScene('pet.play.chain.bad', { reason: chk.reason }); return; }
    // 模型出错（或空回复）不算她输：用户这一步退回去，游戏还在，可以再说一次.
    const before = { prev: c.prev, turns: c.turns };
    c.used.add(word);
    c.prev = word;
    c.turns++;
    c.busy = true;
    publishGame({ kind: 'chain', active: true, turns: c.turns, hint: '她在想……' });
    const a: Active = { cancelled: false };
    playRun = a;
    busy++;
    try {
      const picked = await playEngine(g);
      if (!picked || a.cancelled) return;
      let reply: string | undefined;
      let note = '';
      // 模型两次给不出合规的词（不是词、不接、重复、太长、含禁用词……），她就认输.
      for (let attempt = 0; attempt < 2 && !reply; attempt++) {
        const spec = oneShot(picked.engine, picked.w, 'chain', chainPrompt(lastChar(c.prev ?? word), c.used) + note, CHAIN_MAX_TOKENS);
        const answer = await run(spec, a, CHAIN_TIMEOUT_MS);
        if (a.cancelled) return;
        // 空回复是模型那边的问题，不是它「接不上」：走出错的分支.
        if (!answer.trim()) throw new Error('模型没有回复。');
        const got = parseWordReply(answer);
        const bad = checkWord(got, c.prev, c.used);
        if (bad.ok && !lintSentence(got)) reply = got;
        else note = `\n（上一次的「${got.slice(0, 12)}」不能用：${bad.ok ? '换一个词' : bad.reason}。请换一个。）`;
      }
      if (!reply) {
        play = undefined;
        publishGame({ kind: 'chain', active: false, turns: c.turns });
        sayScene('pet.play.chain.lose', { count: c.turns });
        return;
      }
      c.used.add(reply);
      c.prev = reply;
      c.turns++;
      g.last = deps.now();
      const next = lastChar(reply);
      publishGame({ kind: 'chain', active: true, nextChar: next, turns: c.turns, hint: `轮到你，接「${next}」` });
      sayScene('pet.play.chain.next', { word: reply });
    } catch (e) {
      if (!a.cancelled) {
        c.used.delete(word);
        c.prev = before.prev;
        c.turns = before.turns;
        const need = before.prev ? lastChar(before.prev) : '';
        publishGame({ kind: 'chain', active: true, turns: c.turns, ...(need ? { nextChar: need, hint: `轮到你，接「${need}」` } : { hint: '轮到你，先说一个词' }) });
        sayScene('pet.err.model', { reason: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 70) });
      }
    } finally {
      c.busy = false;
      busy--;
      if (playRun === a) playRun = undefined;
    }
  }

  async function taleTurn(g: Play, raw: string) {
    const tl = g.tale;
    if (!tl || tl.busy) return;
    const pw = parseTaleWords(raw);
    if (!pw.ok) { sayScene(pw.why === 'word' ? 'pet.play.tale.word' : 'pet.play.tale.bad'); return; }
    const words = pw.words;
    tl.busy = true;
    publishGame({ kind: 'tale', active: true, hint: '她在写……' });
    sayScene('pet.play.tale.wait');
    const a: Active = { cancelled: false };
    playRun = a;
    busy++;
    try {
      const picked = await playEngine(g);
      if (!picked || a.cancelled) return;
      const spec = oneShot(picked.engine, picked.w, 'tale', talePrompt(words), 600);
      const answer = await run(spec, a, TALE_TIMEOUT_MS);
      if (a.cancelled) return;
      const tale = parseTale(answer, words);
      // 空的、被丢光的、含禁用词的：不发，请对方换三个词再试一次（游戏还在）.
      if (!tale.text) throw new Error(tale.dropped.length ? '这次没写成，换三个词再试一次。' : '模型没有回复。');
      const id = lineId('tale');
      const at = deps.now();
      // 主进程把它记成 kind:'tale' 的聊天消息（信笺样式）；text 也以《标题》开头，窗口认不出 tale 字段时可以兜底.
      say({ id, text: `《${tale.title}》\n${tale.text}`, mood: 'talk', speak: false, kind: 'tale', tale: { words, title: tale.title, text: tale.text } });
      remember(history, [{ role: 'user', text: `一起写童话：${words.join('、')}`, at }, { role: 'assistant', text: `《${tale.title}》${tale.text}`, at }], at);
      sayScene('pet.play.tale.done');
      if (play === g) { play = undefined; publishGame({ kind: 'tale', active: false }); }
    } catch (e) {
      if (!a.cancelled) {
        publishGame({ kind: 'tale', active: true, hint: '给她三个词，用空格隔开' });
        sayScene('pet.err.model', { reason: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 70) });
      }
    } finally {
      tl.busy = false;
      busy--;
      if (playRun === a) playRun = undefined;
    }
  }

  /* ───────────── 实时陪玩 ───────────── */

  /** 实时陪玩用什么开始（设置变了时也这样重发）. */
  function liveOptions(pet: PetSettings) {
    return { op: 'start' as const, listen: pet.realtime.listen, sensitivity: pet.realtime.sensitivity, fastVoice: pet.realtime.fastVoice, autoOffMin: pet.realtime.autoOffMin };
  }

  async function realtime(on: boolean) {
    if (!on) { rtLive = false; await bridge.realtime({ op: 'stop' }).catch(() => {}); return; }
    const r = deps.read();
    if (!r.pet.enabled) { deps.toast({ tone: 'info', title: '先打开桌宠', body: '实时陪玩是桌宠的一项功能。' }); return; }
    // 开不起来就说明原因：没有 ElevenLabs 密钥（听和说都靠它），或者没有 API 方式的模型（命令行方式启动太慢）.
    if (!haveElevenKey) await refreshKeys();
    if (!haveElevenKey) { sayScene('pet.err.rtkey'); return; }
    if (!petLiveEngine(r.models, r.pet.vision)) { sayScene('pet.err.rtmodel'); return; }
    const opts = liveOptions(r.pet);
    lastRt = JSON.stringify(opts);
    const res = await bridge.realtime(opts).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
    if (!res.ok) sayScene('pet.err.voice', { reason: res.error.replace(/\s+/g, ' ').slice(0, 70) });
  }

  /** 用户说话时憋住的、她回答里的句子. */
  function releaseHeld() {
    const q = liveQ;
    // 用户说话时憋住的：现在说，哪怕回答已经写完（除非有更新的回答顶替了它）.
    if (!q || q.dropped || !q.held.length) return;
    for (const piece of q.held.splice(0)) {
      q.spoke = true;
      q.spoken.push(piece);
      void bridge.realtime({ op: 'say', id: q.id, text: piece }).catch(() => {});
    }
  }

  /** 语气词、咳嗽不是问题. */
  const meaningful = (s: string) => /[\p{L}\p{N}]/u.test(s) && !/^[嗯啊哦呃额哈唉诶欸呀嘛哎噢喔\s，。！？,.!?…~]+$/u.test(s);

  /** 实时陪玩里听到的一句话：马上回答，出声，一句一句读，带最新一帧画面. */
  async function liveAsk(raw: string) {
    let question = raw.replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!meaningful(question)) return;
    const t = deps.now();
    // 分两口气说的：前一句的回答还没开口，后一句就并进去.
    if (live && liveQ && !liveQ.spoke && t - liveQ.at < LIVE_JOIN_MS) question = `${liveQ.text}，${question}`.slice(0, 500);
    noteUser(mem, t);
    lastLiveAt = t;
    if (liveQ) liveQ.dropped = true;
    cancel(live);
    cancel(proactiveRun);
    // 打字问的回答还在路上：以刚说的这句为准，两路回答不能同时出声（和 ask() 对称）.
    cancel(active);
    const r = deps.read();
    const w = whoOf(r);
    const crisis = isCrisisText(question);
    const why = noSight(r.pet);
    const route: Route = crisis ? { kind: 'chat', sight: false, wantsSight: false } : routeQuestion(question, { game: !!focus?.isGame && focus.policy !== 'never', watchable: !why });
    // 要联网的问题走慢一点的路（命令行的 Claude Code 去搜）；没有它，她就在这里凭记忆答，并说明可能不是最新的.
    const canSearch = route.kind === 'web' && !!petWebEngine(r.models, r.pet.web, undefined);
    if (canSearch) { void ask(question); return; }
    const engine = petLiveEngine(r.models, r.pet.vision);
    if (!engine) { sayScene('pet.err.rtmodel'); return; }
    const a: Active = { cancelled: false };
    live = a;
    const id = lineId('live');
    const q = { text: question, at: t, spoke: false, id, spoken: [] as string[], held: [] as string[], dropped: false };
    liveQ = q;
    busy++;
    let failed = false;
    /** 气泡里最后显示的，她被打断时用来收尾. */
    const bubble: { tail?: { text: string; more?: string } } = {};
    try {
      const vision = petVisionEngine(r.models, r.pet.vision);
      // 只有指着屏幕的话才带画面，且在每小时额度之内（闲聊不带）.
      const wants = !crisis && (route.kind !== 'chat' || route.wantsSight);
      const ctx: AskCtx = { question, app: crisis ? undefined : focus, ocr: !why && wants ? ocrLines.slice(-8) : [], image: false };
      if (route.kind === 'web') ctx.noWeb = true;
      let frame: PetFrame | null = null;
      if (wants) {
        if (why) ctx.noImage = why;
        else if (!vision) ctx.noImage = 'no-model';
        else if (imagesLeft(imagesSent, r.pet.imagesPerHour, t, false) <= 0) ctx.noImage = 'budget';
        else {
          frame = await withTimeout(bridge.frame({ maxSide: 960 }).catch(() => null), LIVE_FRAME_WAIT_MS, null);
          if (frame) imagesSent.push(deps.now());
          else if (route.wantsSight) ctx.noImage = scene?.state === 'black' ? 'black' : 'none';
        }
      }
      if (a.cancelled) return;
      ctx.image = !!frame;
      const body = askText(ctx);
      const spec = petApiSpec(engine, { system: petSystem(w, 'live', { crisis }), messages: toMessages(history, frame ? [image(frame), { type: 'text', text: body }] : body), maxTokens: 260 });
      if (!spec.ok) throw new Error(spec.error);
      let done = 0;
      let last = 0;
      const speakNew = (soFar: string, final: boolean) => {
        // 先对累计的全文清洗，再按句切块：（轻轻点头。）这样的旁白在清洗时就没了，不会被切成独立的一块读出来；
        // 还没写完的尾巴（半句、没闭合的括号）先不读.
        const c = speechChunks(tidy(final ? soFar : settled(soFar)), done, final);
        done = c.done;
        for (const piece of c.pieces) {
          // 每一块读出来之前也过出口清洗.
          const spoken = flatten(polish(piece).text);
          if (!spoken) continue;
          // 用户正在说话：先憋着，等他说完.
          if (userTalking) { q.held.push(spoken); continue; }
          q.spoke = true;
          q.spoken.push(spoken);
          void bridge.realtime({ op: 'say', id, text: spoken }).catch(() => {});
        }
      };
      const answer = await run(spec.value, a, LIVE_TIMEOUT_MS, (soFar) => {
        if (a.cancelled) return;
        speakNew(soFar, false);
        const now = deps.now();
        if (now - last >= STREAM_PUSH_MS) {
          const shown = written(soFar);
          if (shown.text) { last = now; bubble.tail = { text: shown.text, more: shown.more }; say({ id, ...bubble.tail, mood: 'talk', streaming: true }); }
        }
      });
      if (a.cancelled) return;
      speakNew(answer, true);
      const shaped = shapeAnswer(answer);
      let reply = shaped.text;
      let fellBack = false;
      if (!reply) {
        if (!shaped.dropped.length) throw new Error('模型没有回复。');
        reply = petLine(fallbackScene(shaped.dropped), w, { now: deps.now() }).text;
        fellBack = true;
      }
      if (!reply) throw new Error('模型没有回复。');
      // 整段回答都被清洗丢光、什么也没读出来：兜底句要读出来（实时陪玩里气泡不会再读一遍）.
      if (fellBack && !q.spoke && !q.held.length) {
        if (userTalking) q.held.push(reply);
        else { q.spoke = true; q.spoken.push(reply); void bridge.realtime({ op: 'say', id, text: reply }).catch(() => {}); }
      }
      // 气泡留着整个回答，不再读一遍（上面已经一句一句读过了）.
      say({ id, text: reply, more: shaped.text ? shaped.more : undefined, mood: 'talk', speak: false });
      const at = deps.now();
      remember(history, [{ role: 'user', text: question, at }, { role: 'assistant', text: reply, at }], at);
      lastLiveAt = at;
      noteLine(mem, at, false);
    } catch (e) {
      failed = true;
      if (!a.cancelled) {
        const l = petLine('pet.err.model', w, { slots: { reason: (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').trim().slice(0, 70) }, now: deps.now() });
        say({ id, text: l.text, mood: 'think', speak: false });
      }
    } finally {
      busy--;
      if (live === a) live = undefined;
      // 被打断了，而气泡里还显示着写了一半的回答、也没有更新的话顶替它：收个尾，不然它一直是「正在写」.
      if (a.cancelled && bubble.tail && lastSentId === id) say({ id, ...bubble.tail, mood: 'idle' });
      // 打断或出错时她已经开了口：说出口的那些留在对话里.
      if ((a.cancelled || failed) && q.spoken.length) {
        const at = deps.now();
        remember(history, [{ role: 'user', text: question, at }, { role: 'assistant', text: `${q.spoken.join('')}……`, at }], at);
      }
    }
  }

  /* ───────────── 运行 ───────────── */

  function start() {
    sync();
    void refreshKeys();
    const off = bridge.onEvent(handle);
    const timer = setInterval(() => { void tick(); }, TICK_MS);
    const unsub = store.subscribe(() => sync());
    return () => { off(); unsub(); clearInterval(timer); cancel(active); cancel(proactiveRun); cancel(playRun); };
  }

  return { start, tick, handle, ask, realtime, refreshKeys, history };
}

/* ───────────── 真正的那只 ───────────── */

let current: Brain | undefined;

/** 在主页面启动一次；浏览器开发版（没有桌面桥）什么都不做. */
export function startPet(): void {
  const bridge = desktop?.pet;
  if (!bridge || current) return;
  current = createBrain({
    bridge,
    read: () => {
      const s = store.get();
      const v = voiceNow();
      return { pet: s.settings.pet, theme: s.settings.mode, callName: v.callName, level: v.level, persona: v.persona, models: s.models };
    },
    stream: openStream,
    stop: (id) => { void desktop?.stop(id, 'kill'); },
    deny: (id, requestId) => { void desktop?.answer(id, requestId, 'deny'); },
    workspace: () => desktop!.workspaceFolder('pet'),
    toast: (t) => actions.toast(t),
    now: Date.now,
    rand: Math.random,
  });
  current.start();
  // 设置页存了 / 删了语音密钥：重新读，重算「实时陪玩开得起来吗」.
  if (typeof window !== 'undefined') window.addEventListener(TTS_KEYS_EVENT, () => { void current?.refreshKeys(); });
}

/** 托盘 / 桌宠菜单的开始 / 结束实时陪玩. */
export function petRealtime(on: boolean): void {
  void current?.realtime(on);
}
