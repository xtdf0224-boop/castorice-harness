/* 桌宠窗口：她（分层木偶，src/pet/ui/rig/）、气泡、聊天框、悬停按钮和四个小游戏的界面。
   只显示主进程发来的东西（window.alightPet，electron/pet/preload 里的桥），点击、拖动、你打的字再报回去。
   窗口一直是 340×590 页面像素（乘 scale）：下面 340×360 是她，上面 230 留给聊天框 / 气泡 / 小游戏面板，
   开关聊天框时窗口不变大小也不挪（照萤火 §10 的不闪做法）。页面不画背景，别处的点击穿透到后面的游戏。 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PetChatEntry, PetGameKind, PetGameState, PetLine, PetMood, PetTale, PetUiState } from '../contracts';
import { PetAudio } from './audio';
import { Butterflies } from './Butterflies';
import { ChatPanel } from './Chat';
import { applyChat, taleView } from './chatLog';
import { demoBridge, type Bridge } from './demo';
import { ARENA_H } from './gameLogic';
import { butterflyEndLine } from './games';
import { loadAvatar } from './avatar';
import { startMic, type Mic } from './mic';
import { PET_H, PET_W, RIG_H, TOP_H, dragSpeed, insideFigure, lookVector, mouthLevel, rigMood } from './petLogic';
import { FALLBACK_SRC, mountRig, type RigHandle } from './rig';
import { Tarot } from './Tarot';

/** 契约里的 PetUiState 之外，主进程可以多发的一个字段：实时陪玩现在能不能开（决定「实时」按钮出不出）。 */
type Ui = PetUiState & { realtimeReady?: boolean };
const bridge: Bridge = (window as unknown as { alightPet?: Bridge }).alightPet ?? demoBridge();

const START: Ui = { theme: 'night', scale: 1, watching: false, paused: false, realtime: false, voice: true, follow: true, fpsCap: 60 };
/** 按下后移动不到这么远（屏幕像素）算点击，不算拖动。 */
const DRAG_PX = 4;
/** 这么快的第二下点击算双击（打开聊天框）；单击要等这么久才确定。 */
const DOUBLE_MS = 320;
/** 一句话在屏幕上够读完再淡出。 */
const showFor = (text: string) => Math.min(20_000, Math.max(5000, 3200 + text.length * 140));
/** 还在写的一句，这么久（比联网的 100 秒和主进程的 2 分钟都长）没长新字就放弃：收尾句不会来了，气泡不能一直挂着。 */
const STREAM_CAP_MS = 130_000;
/** 主进程的第一份状态这么久还没来，就按默认的把她画出来。 */
const STATE_WAIT_MS = 4000;
/** 光标离她这么远（物理像素，缩放 1、屏幕缩放 1 时）眼睛就看到头。 */
const LOOK_RANGE = 560;
/** 木偶还没给出矩形（或量出 0）时，她大约站在窗口里的位置，点击穿透先按它判断。 */
const FALLBACK_BOX = { x: 50, y: 56, w: 240, h: 300 };
/** 引蝶结果面板留多久（毫秒）。 */
const RESULT_MS = 9000;
/** 悬停按钮在指针离开她之后多久消失（免得从她身上移到按钮上时闪一下）。 */
const TOOLS_HIDE_MS = 220;

type Panel = { kind: 'tarot' } | { kind: 'butterfly' } | { kind: 'butterfly-result'; caught: number; total: number; line: string } | null;
const panelGame = (p: NonNullable<Panel>): PetGameKind => (p.kind === 'tarot' ? 'tarot' : 'butterfly');

const GAMES: Array<{ kind: PetGameKind; label: string }> = [
  { kind: 'tarot', label: '命途占卜' }, { kind: 'butterfly', label: '引蝶' }, { kind: 'chain', label: '词语接龙' }, { kind: 'tale', label: '一起写童话' },
];

function useReducedMotion(): boolean {
  const [on, setOn] = useState(() => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!m) return;
    const f = () => setOn(m.matches);
    m.addEventListener('change', f);
    return () => m.removeEventListener('change', f);
  }, []);
  return on;
}

export function PetApp() {
  const [ui, setUi] = useState<Ui>(START);
  /** 主进程的第一份状态到了：之前什么都不画，免得她先以错的主题或大小闪一下。 */
  const [got, setGot] = useState(false);
  const [line, setLine] = useState<PetLine | null>(null);
  const [shown, setShown] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [mood, setMood] = useState<PetMood>('idle');
  const [playing, setPlaying] = useState(false);
  const [babbling, setBabbling] = useState(false);
  /** 声音合成失败的那句：她仍照着动嘴。 */
  const [voiceless, setVoiceless] = useState('');
  /** 读不出声时的一句说明（密钥无效、音色被拒……）：同一个原因 5 分钟内只提示一次，8 秒后收起。 */
  const [voiceNote, setVoiceNote] = useState('');
  const noted = useRef(new Map<string, number>());
  const [hover, setHover] = useState(false);
  /** 聊天框：开着没有、主进程打开过几次（每次光标回输入框）、记录、没发出去的草稿。 */
  const [chat, setChat] = useState(false);
  const [opened, setOpened] = useState(0);
  const [log, setLog] = useState<PetChatEntry[]>([]);
  const [draft, setDraft] = useState('');
  /** 窗口拿着键盘。 */
  const [keys, setKeys] = useState(() => document.hasFocus());
  /** 指针在她身上（或悬停按钮上）：按钮出现。 */
  const [near, setNear] = useState(false);
  const [gamesOpen, setGamesOpen] = useState(false);
  /** 占卜 / 引蝶在窗口里自己玩完：当前的面板。 */
  const [panel, setPanel] = useState<Panel>(null);
  /** 大脑接手的接龙 / 童话的状态。 */
  const [game, setGame] = useState<PetGameState | null>(null);
  const [avatar, setAvatar] = useState<string | null>(null);
  const [rigGen, setRigGen] = useState(0);
  const [rigOk, setRigOk] = useState(true);
  const [box, setBox] = useState(FALLBACK_BOX);
  const reducedMq = useReducedMotion();
  const reduced = reducedMq || !!ui.reducedMotion;

  const audio = useRef<PetAudio | null>(null);
  const rig = useRef<RigHandle | null>(null);
  /** 用户用 × 关掉的那句的 id：它接着长的后续不会把气泡再弹出来。 */
  const dismissed = useRef('');
  /** 下面指针那个 effect 留给页面其余部分的：重新看一下指针在什么上面，或者忘掉它。 */
  const pointer = useRef({ look() {}, forget() {} });
  /** 窗口里这一点（clientX / clientY）在她身上吗：按木偶报的轮廓（rig.hitTest）；木偶还没好或退到静态图时按矩形的超椭圆粗判。 */
  const onFigure = useRef<(x: number, y: number) => boolean>(() => false);
  /** 最新的状态给只挂一次的监听用。 */
  const live = useRef({ ui, panel, game, chat, box });
  live.current = { ui, panel, game, chat, box };
  onFigure.current = (x, y) => {
    const cv = document.getElementById('pet-rig') ?? document.querySelector('.pet-stage');
    if (!cv) return false;
    const r = cv.getBoundingClientRect();
    const k = r.width > 0 ? PET_W / r.width : 1;
    const px = (x - r.left) * k, py = (y - r.top) * k;
    return rig.current ? rig.current.hitTest(px, py) : insideFigure(live.current.box, px, py);
  };
  /** 没有声音的台词动嘴时的开合（只读，不触发重画）。 */
  const flapRef = useRef(false);

  /* ───────────── 收主进程的消息 ───────────── */

  const closePanel = useCallback(() => {
    const p = live.current.panel;
    if (!p) return;
    bridge.game('stop', panelGame(p));
    setPanel(null);
    setShown(false);
  }, []);

  /** 结束正在玩的（面板里的，或大脑接手的）：通知主进程，大脑好重新开口。 */
  const endGames = useCallback(() => {
    const { panel: p, game: g } = live.current;
    if (p) { bridge.game('stop', panelGame(p)); setPanel(null); }
    if (g?.active) { bridge.game('stop', g.kind); setGame(null); }
  }, []);

  const closeChat = useCallback(() => { setChat(false); bridge.chatClose(); }, []);

  const startGame = useCallback((kind: PetGameKind) => {
    endGames();
    setGamesOpen(false);
    setExpanded(false);
    if (kind === 'tarot' || kind === 'butterfly') {
      // 面板要用聊天框那块地方：聊天框先收起
      if (live.current.chat) closeChat();
      setPanel({ kind });
      setShown(false);
      bridge.game('start', kind);
    } else {
      // 接龙、童话在聊天框里玩：大脑接手，状态条先写个开场的提示，大脑的第一份状态一到就换掉
      setGame({ kind, active: true, hint: kind === 'tale' ? '给我三个词' : '你先说一个词' });
      bridge.game('start', kind);
      bridge.chatOpen();
    }
  }, [endGames, closeChat]);
  const start = useRef(startGame);
  start.current = startGame;
  useEffect(() => {
    if (!voiceNote) return;
    const t = setTimeout(() => setVoiceNote(''), 8000);
    return () => clearTimeout(t);
  }, [voiceNote]);

  useEffect(() => {
    const a = new PetAudio({
      spoken: (id, state) => { bridge.spoken(id, state); setPlaying(state === 'start'); },
      mouth: () => {},
      failed: (id, reason) => {
        setVoiceless(id);
        const why = (reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (!why) return;
        const now = Date.now();
        if (now - (noted.current.get(why) ?? 0) < 5 * 60_000) return;
        noted.current.set(why, now);
        setVoiceNote(`这句没能读出来：${why}`);
      },
    });
    audio.current = a;
    const wait = setTimeout(() => setGot(true), STATE_WAIT_MS);
    const off = [
      bridge.onState((s) => { setUi(s); setGot(true); }),
      bridge.onLine((l) => {
        setLine((prev) => { if (prev?.id !== l.id) setExpanded(false); return l; });
        // 用户用 × 关掉了这句：写的过程中它保持关着（写完的最终版会再显示）。
        const closed = !!dismissed.current && l.id === dismissed.current;
        if (!closed) dismissed.current = '';
        setShown(!!l.text && !(closed && l.streaming));
        // 新的一句顶替正在读的那句；她放弃的那句还在路上的声音现在就丢掉。
        a.stop(l.id, true);
        if (l.mood) setMood(l.mood);
      }),
      bridge.onLineDelta((d) => setLine((prev) => (prev && prev.id === d.id ? { ...prev, text: prev.text + d.text } : prev))),
      bridge.onAudio((m) => a.push(m)),
      bridge.onMood((m) => setMood(m.mood)),
      bridge.onCommand((c) => {
        // 实时陪玩：你插话了，或更新的回答顶替了：她的声音马上停。
        if (c.type === 'hush') { a.stop(); return; }
        // 窗口又点击穿透了：指针原来在什么上面已经不算数。
        if (c.type === 'pointer') { pointer.current.forget(); return; }
        if (c.type === 'look') {
          const { ui: u } = live.current;
          if (!u.follow) return;
          const range = LOOK_RANGE * (window.devicePixelRatio || 1) * u.scale;
          rig.current?.lookAt(lookVector(c.dx, c.dy, range));
          return;
        }
        if (c.type === 'game') { start.current(c.kind); return; }
        if (c.type === 'chat') {
          // 聊天框要用占卜 / 引蝶的地方：那局不玩了（没有结束台词，不是玩完）
          if (live.current.panel) { bridge.game('stop', panelGame(live.current.panel)); setPanel(null); }
          setChat(true); setOpened((n) => n + 1); setHover(false); setGamesOpen(false);
        } else if (c.type === 'close-chat') setChat(false);
      }),
      bridge.onChat((m) => setLog((prev) => applyChat(prev, m))),
      bridge.onGame((s) => {
        if (s.kind === 'chain' || s.kind === 'tale') setGame(s.active ? s : null);
      }),
    ];
    // 开始听：主进程把记录原样发来（它比这个页面活得久）。
    bridge.chatSync();
    void loadAvatar().then(setAvatar);
    return () => { clearTimeout(wait); off.forEach((fn) => fn()); a.dispose(); audio.current = null; };
  }, []);

  // 窗口拿着键盘没有（点别处会拿走；聊天框照样开着）。
  useEffect(() => {
    const on = () => setKeys(true);
    const off = () => setKeys(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', off);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', off); };
  }, []);

  // 窗口大小由主进程管，页面跟着缩放；主题、减少动态效果也写在根上给 CSS 用。
  useLayoutEffect(() => {
    if (!got) return;
    const root = document.documentElement;
    root.style.zoom = String(ui.scale);
    root.dataset.theme = ui.theme;
  }, [got, ui.scale, ui.theme]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    if (reduced) root.dataset.reduced = ''; else delete root.dataset.reduced;
  }, [reduced]);

  // 麦克风：只在实时陪玩开着时开。打不开、或用到一半没了，就告诉主进程，她不会一直挂着 LIVE 却是聋的。
  useEffect(() => {
    if (!ui.realtime) return;
    let mic: Mic | null = null;
    let stopped = false;
    void startMic((pcm) => bridge.mic(pcm), () => { if (!stopped) bridge.micFailed(); }).then((m) => {
      if (stopped) m?.stop();
      else if (m) mic = m;
      else bridge.micFailed();
    });
    return () => { stopped = true; mic?.stop(); };
  }, [ui.realtime]);

  /* ───────────── 她（分层木偶） ───────────── */

  // 木偶随缩放重建一次（它按缩放决定画布分辨率）；画布换新元素（key），免得同一块画布换上下文类型。
  useEffect(() => {
    if (!got || !rigOk) return;
    const cv = document.getElementById('pet-rig') as HTMLCanvasElement | null;
    if (!cv) return;
    let dead = false;
    let handle: RigHandle | null = null;
    mountRig(cv, { scale: ui.scale }).then((r) => {
      if (dead) { r.destroy(); return; }
      handle = r;
      rig.current = r;
      setRigGen((n) => n + 1);
    }, () => { if (!dead) setRigOk(false); });
    return () => { dead = true; handle?.destroy(); if (rig.current === handle) rig.current = null; };
  }, [got, ui.scale, rigOk]);

  // 她此刻在窗口里站的矩形：点击穿透和悬停都按它。木偶摆动时这个矩形会略变，隔一会儿读一次。
  useEffect(() => {
    if (!got) return;
    const read = () => {
      const b = rig.current?.bounds() ?? FALLBACK_BOX;
      const n = b.w > 8 && b.h > 8 ? { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.w), h: Math.round(b.h) } : FALLBACK_BOX;
      setBox((p) => (p.x === n.x && p.y === n.y && p.w === n.w && p.h === n.h ? p : n));
    };
    read();
    const id = setInterval(read, 400);
    return () => clearInterval(id);
  }, [got, rigGen, rigOk]);

  /* ───────────── 气泡、嘴、心情 ───────────── */

  // 聊天框开着时不画气泡（她的话进记录），但一句话照样有它的时间，所以脸和嘴照常、关掉聊天框时也不冒出早就说完的旧气泡。
  // 还在写的一句等下一段（每一段重新计时），最多 STREAM_CAP_MS。
  useEffect(() => {
    if (!shown || !line || (hover && !chat) || expanded || playing) return;
    const t = setTimeout(() => setShown(false), line.streaming ? STREAM_CAP_MS : showFor(line.text));
    return () => clearTimeout(t);
  }, [shown, line, chat, hover, expanded, playing]);

  const text = line?.text ?? '';
  // 小游戏的面板开着时她的话在面板里，不再画气泡。
  const bubble = shown && !!text && !chat && !panel;
  // 气泡没了（×、没有文字、聊天框打开），指针就不在它上面了，也不会再来 mouseleave：hover 不能一直挂着，否则以后的气泡永远不会淡出。
  useEffect(() => { if (!bubble) setHover(false); }, [bubble]);
  // 这句没有声音：本来就不读、朗读关了、或合成失败。
  const silent = !!line && !playing && (!line.speak || !ui.voice || voiceless === line.id);
  const lineId = line?.id;
  useEffect(() => {
    if (!shown || !silent) return;
    const until = Date.now() + Math.min(3000, 600 + text.length * 70);
    setBabbling(true);
    const t = setInterval(() => { if (Date.now() > until) { clearInterval(t); flapRef.current = false; setBabbling(false); } else flapRef.current = !flapRef.current; }, 170);
    return () => { clearInterval(t); flapRef.current = false; setBabbling(false); };
  }, [shown, silent, lineId]);

  const feel: PetMood = shown && line?.mood ? line.mood : mood;
  const babble = feel === 'talk' && shown && silent && babbling;
  const rigState = rigMood({ feel, speaking: playing, babbling: babble, chat, watching: ui.watching });

  useEffect(() => { rig.current?.setMood(rigState); }, [rigState, rigGen]);
  useEffect(() => { rig.current?.setFps(ui.fpsCap); }, [ui.fpsCap, rigGen]);
  useEffect(() => { rig.current?.setReducedMotion(reduced); }, [reduced, rigGen]);
  useEffect(() => { if (!ui.follow) rig.current?.lookAt(null); }, [ui.follow, rigGen]);
  // 嘴：说话时读正在播的声音的响度；没有声音的台词按 170 ms 的节拍随机似的开合。
  useEffect(() => {
    const r = rig.current;
    if (!r || (!playing && !babble)) { rig.current?.setTalk(0); return; }
    const id = setInterval(() => r.setTalk(playing ? mouthLevel(audio.current?.level() ?? 0) : flapRef.current ? 0.55 : 0.06), 33);
    return () => { clearInterval(id); r.setTalk(0); };
  }, [playing, babble, rigGen]);

  /* ───────────── 指针 ───────────── */

  // 点击穿透：只有她、气泡、聊天框、面板、按钮（带 data-hit 的）接住点击，别处穿到后面的游戏。
  useEffect(() => {
    let over = false;
    let by = false;
    let hideTimer: ReturnType<typeof setTimeout> | null = null;
    /** 指针最后在窗口里的位置（null：在窗口外，或不知道了）。 */
    let at: { x: number; y: number } | null = null;
    const look = () => {
      if (!at) return;
      const el = document.elementFromPoint(at.x, at.y);
      // 她身上要看轮廓（hitTest），不是矩形：腿间、发尾外的透明处点击穿透
      const onHer = !!el?.closest('.pet-hitbox') && onFigure.current(at.x, at.y);
      const now = onHer || !!el?.closest('[data-hit]:not(.pet-hitbox)');
      if (now !== over) { over = now; bridge.hit(now); }
      const close = onHer || !!el?.closest('.pet-tools');
      if (close) {
        if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
        if (!by) { by = true; setNear(true); }
      } else if (by && !hideTimer) {
        hideTimer = setTimeout(() => { hideTimer = null; by = false; setNear(false); }, TOOLS_HIDE_MS);
      }
    };
    const move = (e: MouseEvent) => { at = { x: e.clientX, y: e.clientY }; look(); };
    const leave = () => {
      at = null;
      if (over) { over = false; bridge.hit(false); }
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (by) { by = false; setNear(false); }
    };
    // 主进程让窗口点击穿透了，页面不知道（藏起来、重载、丢了键盘）：位置也过期了，下次移动重新报。
    const forget = () => { at = null; over = false; leave(); bridge.hit(false); };
    pointer.current = { look, forget };
    window.addEventListener('mousemove', move);
    document.addEventListener('mouseleave', leave);
    window.addEventListener('blur', leave);
    return () => {
      if (hideTimer) clearTimeout(hideTimer);
      window.removeEventListener('mousemove', move);
      document.removeEventListener('mouseleave', leave);
      window.removeEventListener('blur', leave);
    };
  }, []);

  // 指针不动、版面在它下面变了（气泡来了 / 走了、聊天框开关、面板、缩放、她的矩形变了），它已经在别的东西上了；
  // 光靠 mousemove 发现不了，窗口会吞掉本该给游戏的点击（或放过本该给她的），直到下一次移动。
  useEffect(() => {
    const id = requestAnimationFrame(() => pointer.current.look());
    return () => cancelAnimationFrame(id);
  }, [got, shown, text, chat, near, expanded, ui.scale, panel, gamesOpen, box]);
  // 按钮收起后子菜单跟着收
  useEffect(() => { if (!near || chat || panel) setGamesOpen(false); }, [near, chat, panel]);

  const press = useRef<{ x: number; y: number; moved: boolean; last: { x: number; y: number; t: number } } | null>(null);
  /** 等着看有没有第二下的单击。 */
  const clickWait = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (clickWait.current) clearTimeout(clickWait.current); }, []);
  const down = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    press.current = { x: e.screenX, y: e.screenY, moved: false, last: { x: e.screenX, y: e.screenY, t: performance.now() } };
    // 主进程自己跟着真实光标走；这里的数字只用来判断「动没动」。
    bridge.drag('start', NaN, NaN);
  }, []);
  const move = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p) return;
    if (!p.moved && Math.hypot(e.screenX - p.x, e.screenY - p.y) >= DRAG_PX) p.moved = true;
    if (!p.moved) return;
    bridge.drag('move', NaN, NaN);
    // 窗口跟着光标，所以窗口的速度就是光标的速度：木偶的头发和披摆往反方向甩。
    const now = { x: e.screenX, y: e.screenY, t: performance.now() };
    const v = dragSpeed(p.last, now);
    if (v) { rig.current?.setDrag(v.vx, v.vy); p.last = now; }
  }, []);
  const up = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!p) return;
    bridge.drag('end', NaN, NaN);
    rig.current?.setDrag(0, 0);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    if (p.moved) return;
    // 按下没拖动就是点她；快速两下改成打开聊天框。
    rig.current?.react('poke');
    if (clickWait.current) {
      clearTimeout(clickWait.current);
      clickWait.current = null;
      bridge.chatOpen();
      return;
    }
    clickWait.current = setTimeout(() => { clickWait.current = null; bridge.click(); }, DOUBLE_MS);
  }, []);

  /* ───────────── 聊天框、小游戏 ───────────── */

  const saveTale = useCallback(async (e: PetChatEntry): Promise<boolean> => {
    if (!bridge.saveTale) return false;
    const v = taleView(e);
    try { return !!(await bridge.saveTale({ words: e.tale?.words ?? [], title: v.title, text: v.body })).ok; } catch { return false; }
  }, []);
  const loadTales = useCallback((): Promise<PetTale[]> => bridge.tales(), []);
  const stopGame = useCallback((kind: 'chain' | 'tale') => { bridge.game('stop', kind); setGame(null); }, []);

  /** 引蝶玩完（时间到或全落稳）：结束台词交给主进程，面板里也显示。 */
  const butterflyEnd = useCallback((r: { caught: number; total: number }) => {
    if (!r.total) { closePanel(); return; }
    const end = butterflyEndLine(r.caught, r.total);
    bridge.gameSay({ text: end.text, mood: end.mood });
    if (end.mood === 'happy') rig.current?.react('cheer');
    setPanel({ kind: 'butterfly-result', caught: r.caught, total: r.total, line: end.text });
  }, [closePanel]);
  useEffect(() => {
    if (panel?.kind !== 'butterfly-result') return;
    const t = setTimeout(closePanel, RESULT_MS);
    return () => clearTimeout(t);
  }, [panel, closePanel]);

  const tarotSay = useCallback((l: { text: string; mood: PetMood; card: string }) => {
    bridge.gameSay(l);
    if (l.mood === 'happy') rig.current?.react('cheer');
  }, []);

  /** 引蝶的蝴蝶从她的枝头飞出来（游戏区里的坐标：区域在窗口最下面 ARENA_H 高）。 */
  const origin = {
    x: Math.min(PET_W - 20, Math.max(20, box.x + box.w * 0.86)),
    y: Math.min(ARENA_H - 20, Math.max(20, TOP_H + box.y + box.h * 0.55 - (PET_H - ARENA_H))),
  };

  const more = line?.more;
  const playingPanel = panel?.kind === 'tarot' || panel?.kind === 'butterfly';
  const showTools = near && !chat && !playingPanel;
  if (!got) return null;
  return (
    <div className="pet" data-theme={ui.theme}>
      <div className="pet-top">
        {chat && (
          <ChatPanel log={log} draft={draft} setDraft={setDraft} keys={keys} opened={opened} game={game} avatar={avatar}
            onSend={(v) => bridge.ask(v)} onClose={closeChat} onTakeKeys={() => bridge.chatFocus()} onStopGame={stopGame}
            onSaveTale={saveTale} loadTales={loadTales} />
        )}
        {!chat && panel?.kind === 'tarot' && <Tarot onSay={tarotSay} onClose={closePanel} reduced={reduced} />}
        {!chat && panel?.kind === 'butterfly-result' && (
          <section className="pet-game pet-result" data-hit aria-label="引蝶结果">
            <header className="pet-game__head">
              <strong className="pet-game__title">引蝶</strong>
              <span className="pet-game__score">{panel.caught} / {panel.total} 只</span>
              <button type="button" className="pet-game__x" aria-label="收起" title="收起" onClick={closePanel}>×</button>
            </header>
            <p className="pet-game__quote" role="status" aria-live="polite">{panel.line}</p>
          </section>
        )}
      </div>
      {voiceNote && <p className="pet-voice-note" role="status">{voiceNote}</p>}
      {bubble && (
        <div className="pet-bubble-wrap">
          <div className="pet-bubble" data-hit data-streaming={line?.streaming ? '' : undefined} data-open={expanded ? '' : undefined}
            onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
            <p className="pet-bubble__text" role="status" aria-live="polite">{expanded && more ? more : text}</p>
            {more && (
              <button type="button" className="pet-bubble__more" onClick={() => setExpanded((x) => !x)}>{expanded ? '收起' : '展开'}</button>
            )}
            <button type="button" className="pet-bubble__close" aria-label="关闭气泡" onClick={() => { dismissed.current = line?.id ?? ''; setShown(false); setExpanded(false); setHover(false); }}>×</button>
          </div>
        </div>
      )}
      {panel?.kind === 'butterfly' && <Butterflies origin={origin} fpsCap={ui.fpsCap} reduced={reduced} onEnd={butterflyEnd} onStop={closePanel} />}
      <div className="pet-stage" style={{ width: PET_W, height: RIG_H }}>
        {rigOk
          ? <canvas key={ui.scale} id="pet-rig" className="pet-rig" aria-hidden />
          : <img className="pet-fallback" src={FALLBACK_SRC} alt="" draggable={false} width={210} height={300} />}
        {/* 她身上能点、能拖的那块：按木偶报的矩形摆；真正挡不挡点击看 rig.hitTest 的轮廓（见上面的指针 effect）。 */}
        <div className="pet-hitbox" role="button" tabIndex={-1} aria-label="遐蝶：点一下，双击聊天，拖动换位置，右键有菜单"
          style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
          onPointerDown={(e) => { if (onFigure.current(e.clientX, e.clientY)) down(e); }} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
          onMouseDown={(e) => { if (chat) e.preventDefault(); }}
          onContextMenu={(e) => { e.preventDefault(); bridge.menu(); }} />
        {showTools && (
          <Tools ui={ui} open={gamesOpen} setOpen={setGamesOpen} onChat={() => bridge.chatOpen()} onGame={startGame} />
        )}
        <div className="pet-badges">
          {ui.realtime && <span className="pet-badge pet-badge--live" title="实时陪玩中">LIVE</span>}
          {ui.realtime && ui.listening && <span className="pet-badge pet-badge--ear" title="在听你说话"><MicIcon /></span>}
          {ui.watching && <span className="pet-badge" title="正在看游戏画面"><EyeIcon /></span>}
          {ui.paused && !ui.watching && <span className="pet-badge pet-badge--off" title="看屏已暂停"><PauseIcon /></span>}
        </div>
      </div>
    </div>
  );
}

/** 悬停按钮：聊天、小游戏（点开展开四项）、实时（能用时）、暂停看屏（在看屏时）。 */
function Tools({ ui, open, setOpen, onChat, onGame }: { ui: Ui; open: boolean; setOpen(v: boolean): void; onChat(): void; onGame(k: PetGameKind): void }) {
  const live = !!bridge.realtime && !!(ui.realtimeReady || ui.realtime);
  const pause = !!bridge.pause && (ui.watching || ui.paused);
  return (
    <div className="pet-tools" role="toolbar" aria-label="她身边的按钮">
      {open && (
        <div className="pet-games" role="menu" aria-label="小游戏">
          {GAMES.map((g) => <button key={g.kind} type="button" role="menuitem" className="pet-tool" data-hit onClick={() => onGame(g.kind)}>{g.label}</button>)}
        </div>
      )}
      <div className="pet-tools__col">
        <button type="button" className="pet-tool" data-hit onClick={onChat} title="和她聊天（双击她也可以）"><ChatIcon />聊天</button>
        <button type="button" className="pet-tool" data-hit aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)} title="小游戏"><SparkIcon />小游戏</button>
        {live && (
          <button type="button" className="pet-tool" data-hit data-on={ui.realtime ? '' : undefined} aria-pressed={ui.realtime} onClick={() => bridge.realtime?.(!ui.realtime)}
            title={ui.realtime ? '关掉实时陪玩' : '打开实时陪玩'}><MicIcon />实时</button>
        )}
        {pause && (
          <button type="button" className="pet-tool" data-hit data-on={ui.paused ? '' : undefined} aria-pressed={ui.paused} onClick={() => bridge.pause?.(!ui.paused)}
            title="暂停 / 继续看游戏画面">{ui.paused ? <PlayIcon /> : <PauseIcon />}{ui.paused ? '继续看屏' : '暂停看屏'}</button>
        )}
      </div>
    </div>
  );
}

function ChatIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M20 12a7.5 7 0 0 1-10.6 6.4L4.5 20l1.4-4A7 7 0 0 1 4.5 12 7.5 7 0 0 1 20 12z" /><path d="M9 12h.01M12.5 12h.01M16 12h.01" />
    </svg>
  );
}
function SparkIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 16v4M17 18h4" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />
    </svg>
  );
}
function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
      <rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" />
    </svg>
  );
}
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
      <path d="M7 4.5v15l12-7.5z" />
    </svg>
  );
}
