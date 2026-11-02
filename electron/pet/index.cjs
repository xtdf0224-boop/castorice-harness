// 桌宠（她）in the main process: owns the pet window, the hotkeys, the sense helper, the capture page, the
// voice and 实时陪玩, and is the only door between them and the app page (docs/PET-PLAN.md §2, §6). The page
// (src/pet/brain.ts) decides what she says; this decides what she may see, and passes things along.
//
//   app page ──pet:config / pet:say / pet:frame / pet:ocr / pet:tts:* / pet:rt / pet:game-state / pet:tale:save──▶ here ──▶ pet window, capture page
//   app page ◀──pet:event──────────────────────────────────────────────────────────────────────────────────────── here ◀── sense, capture, pet window
//
// Ported from the sister project's electron/pet (read-only reference); what differs is written down in docs/PET-PLAN.md.
const { app, ipcMain, Menu, Notification, screen, systemPreferences } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const petWindow = require('./window.cjs');
const hotkeys = require('./hotkeys.cjs');
const sense = require('./sense.cjs');
const policy = require('./policy.cjs');
const capture = require('./capture.cjs');
const tts = require('./tts.cjs');
const realtime = require('./realtime.cjs');

/** The foreground program must hold still this long before it counts as a change. */
const FOCUS_DEBOUNCE_MS = 1500;
/** Switched on, she waits for the sense helper to say what is in front (an anti-cheat game?) before showing; this long at most. */
const FIRST_REPORT_MS = 6000;
/** Reading the screen's text costs a little CPU: not more often than this, and only when the picture is calm. */
const OCR_GAP_MS = 30_000;
/** 实时陪玩: what she said in the last this-many ms is what her own voice coming back through the speakers would say. */
const ECHO_MS = 20_000;
/** …but only while she is speaking and this long after (the room's echo and the recogniser's lag). */
const ECHO_TAIL_MS = 3000;
/** After her voice stops, the turn detection stays strict this long (the last words still ring in the room). */
const BUSY_TAIL_MS = 800;
/** A live reply whose sentences are all handed out but whose sound never started is let go after this long. */
const LIVE_IDLE_MS = 6000;
/** One block of microphone samples is a few KiB; anything past this is not one. */
const MAX_MIC_BYTES = 64 * 1024;
/** The chat panel's log keeps this many messages (both ways). */
const CHAT_MAX = 60;
/** A reply still being written that has not grown for this long never will (every reply ends well before: the slowest,
 *  a web search, gives up after 100 s); it stops looking like she is typing. */
const CHAT_STALE_MS = 120_000;
/** Where sense.cjs puts the pictures it hands to OCR. */
const TEMP_DIR = path.join(os.tmpdir(), 'alight-pet');
const MOODS = new Set(['idle', 'talk', 'think', 'watch', 'happy', 'shy', 'surprised', 'sleep']);
const PROVIDERS = new Set(['elevenlabs', 'minimax', 'edge']);
const THEMES = new Set(['night', 'day']);
/** 小游戏：命途占卜、引蝶、词语接龙、一起写童话（contracts.ts 的 PetGameKind）。 */
const GAME_KINDS = new Set(['tarot', 'butterfly', 'chain', 'tale']);
/** 占卜翻出的命途 = 官方命途图标的文件名后缀（remembrance、erudition…）。 */
const CARD_RE = /^[a-z][a-z-]{0,23}$/;
/** 窗口里自己玩完的小游戏，她说的一句：清洗后最长这么多字。 */
const GAME_SAY_MAX = 140;
/** …而且 10 秒内最多这么多句（页面一直往主进程灌也不理）。 */
const GAME_SAY_BURST = 8;
/** 存下的童话：最多这么多篇，旧的先删；各字段的上限。 */
const TALES_MAX = 100;
const TALE_TITLE_MAX = 60;
const TALE_TEXT_MAX = 2000;
const TALE_WORD_MAX = 20;
/** 光标跟随：看得见时每 50 毫秒读一次光标（≤20 Hz，变了才发）；用不上（游戏 / 全屏程序在前台、她藏着、桌宠关着）就完全不读，
 *  等 sendState / 窗口显示 / 隐藏再启动. */
const LOOK_MS = 50;
/** What the brain is told when the sense helper is gone: no program known, nothing to look at (policy 'never'). */
const UNKNOWN_APP = Object.freeze({ exe: '', title: '', pid: 0, hwnd: '0', fullscreen: 'no', isGame: false, policy: 'never' });

/** 默认全关：桌宠、看屏、朗读、微软朗读备用都要用户自己打开。 */
const DEFAULT_CFG = {
  enabled: false, theme: 'night', scale: 1, watch: false, neverWatch: [], gameAllow: [], gameDeny: [],
  hotkeyAsk: 'Ctrl+Alt+B', hotkeyPause: 'Ctrl+Alt+H', follow: true, fpsCap: 60, realtimeReady: false,
  voice: { enabled: false, provider: 'elevenlabs', voiceId: '', volume: 80, fallback: false, models: { elevenlabs: '', minimax: '' } },
};

/** 探针（scripts/probe）：不建桌宠窗口，也不动 Chromium 的开关，免得改变探针的基线。 */
const probing = () => process.env.ALIGHT_PROBE === '1';

let host = null;
let cfg = DEFAULT_CFG;
let registered = false;
/** The last thing sense reported (to classify again when the lists change). */
let lastRaw = null;
/** The program in front, as the brain knows it. */
let focus = null;
let pendingRaw = null;
let focusTimer = null;
let paused = false;
let speakAbort = null;
let speakingId = '';
let ocrAt = 0;
let ocrBusy = false;
let seenText = [];
/** Bumped whenever looking stops, so a read that began before the stop is known to be out of date. */
let lookEpoch = 0;
/** Lines the pet window began reading aloud and has not finished: the brain waits for each one's end. */
const reading = new Set();
/** An anti-cheat game is in front: her window is hidden (never merely lowered) until it is not. */
let overlayHidden = false;
/** The brain has been told that no program is known (so it is told once, not at every missed heartbeat). */
let lostSent = false;
/** The sense helper has reported the program in front since she was switched on (or was waited for long enough). */
let senseHeard = false;
let firstReportTimer = null;
let watchSeq = 0;
let rtOn = false;
/** 实时陪玩's options (the brain sends them with op 'start'). */
let rtOpts = { listen: 'auto', sensitivity: 50, fastVoice: true, autoOffMin: 20 };
/** She is hearing the user (speech detected, or the hotkey asked her to listen). */
let listening = false;
/** Her spoken reply being read aloud: { id, queue, busy, ac, said, seq, part }. */
let liveUtt = null;
/** The user started talking while she was: cut her off once their words are clear. */
let barge = false;
/** What she said recently ({ text, at }), to tell her own voice coming back through the speakers from the user's. */
let recentSpeech = [];
/** When her voice last stopped (for the echo window and the busy tail). */
let lastVoiceEnd = 0;
let busyTimer = null;
let wasBusy = false;
/** Live replies cut off by the user: late sentences for them are not read. */
const cutIds = new Set();
let hotkeyNote = '';
let unsubs = [];
/** The app page is gone (crashed, reloading, navigated away): nothing is sent to it, and nothing runs for its brain, until its
 *  first pet:config arrives (pageLost / resyncPage). */
let pageGone = false;
/** ...and the new page has not finished loading yet: a pet:config now is a late message of the page that is leaving, not the new one's. */
let pageLoading = false;
/** 实时陪玩 was running when the page went: the new page is told it ended, and why. */
let rtLostNote = '';
/** The user was told once that the sense helper does not work; forgotten when it reports (the next time it fails, say it again). */
let senseNoted = false;
/** 光标跟随的定时器，和上一次发出去的 { dx, dy }（没变就不再发）。 */
let lookTimer = null;
let lastLook = null;
/** 窗口里的小游戏近 10 秒说话的时刻（gameSay 的限流），和给她的话编号用的序号。 */
let gameSays = [];
let gameSeq = 0;
/** The chat panel's messages (PetChatEntry), oldest first; see "the chat log" below. */
let chatLog = [];
let chatSeq = 0;
let chatStaleTimer = null;

/* ───────────── small helpers ───────────── */

/** The app page: main.cjs says which window and frame that is (identity, not a URL compared as text). */
function fromApp(e) {
  return !!host && typeof host.isAppSender === 'function' && host.isAppSender(e) === true;
}
function fromPet(e) {
  const w = petWindow.get();
  if (!w || !e || e.sender !== w.webContents) return false;
  // Not just her window: her page, in its top frame (nothing it might embed gets to speak for her).
  // She only ever loads her own page: window.cjs blocks every navigation away from it.
  const f = e.senderFrame;
  return !!f && f === e.sender.mainFrame;
}
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromApp(e)) throw new Error('拒绝：调用不是来自栖枝页面');
    return fn(e, ...args);
  });
}
/** 桌宠窗口自己的 invoke（童话列表）：只认她的页面。 */
function handlePet(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!fromPet(e)) throw new Error('拒绝：调用不是来自桌宠窗口');
    return fn(e, ...args);
  });
}
function listen(channel, check, fn) {
  ipcMain.on(channel, (e, ...args) => {
    if (!check(e)) return;
    // A malformed message from a page must not become an uncaught exception in the main process.
    try { fn(e, ...args); } catch { /* dropped */ }
  });
}

/** An event for the app page. */
function emit(ev) {
  if (pageGone) return;
  const w = host && host.getMainWindow();
  if (w && !w.isDestroyed() && !w.webContents.isDestroyed()) w.webContents.send('pet:event', ev);
}
/** A command for the app page (the pet menu and the hotkeys can ask for page-level things). */
function toPage(cmd, show = false) {
  if (host) host.sendCommandToPage(cmd, show);
}

const isOwn = (f) => !!f && f.pid === process.pid;
const strings = (v) => (Array.isArray(v) ? [...new Set(v.filter((x) => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 200) : []);
const clamp = (v, lo, hi, def) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : def);

/** A speech model id as the services write them (eleven_v3, speech-2.8-hd); anything else = the recommended one. */
const modelId = (v) => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(v.trim()) ? v.trim() : '');

/** Whatever the page sends is checked field by field: the desktop side never trusts its shape. */
function sanitizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const v = r.voice && typeof r.voice === 'object' ? r.voice : {};
  const vm = v.models && typeof v.models === 'object' ? v.models : {};
  return {
    enabled: r.enabled === true,
    theme: THEMES.has(r.theme) ? r.theme : DEFAULT_CFG.theme,
    scale: clamp(r.scale, 0.6, 1.6, 1),
    watch: r.watch === true,
    neverWatch: strings(r.neverWatch),
    gameAllow: strings(r.gameAllow),
    gameDeny: strings(r.gameDeny),
    hotkeyAsk: typeof r.hotkeyAsk === 'string' ? r.hotkeyAsk.trim().slice(0, 40) : DEFAULT_CFG.hotkeyAsk,
    hotkeyPause: typeof r.hotkeyPause === 'string' ? r.hotkeyPause.trim().slice(0, 40) : DEFAULT_CFG.hotkeyPause,
    follow: r.follow !== false,
    fpsCap: r.fpsCap === 30 ? 30 : 60,
    // 实时陪玩此刻开得起来：大脑算好发来，桌宠窗口据此出「实时」按钮（主进程不自己判断）。
    realtimeReady: r.realtimeReady === true,
    voice: {
      enabled: v.enabled === true,
      // 不认识的服务 = ElevenLabs（她自己的音色在那里）；微软朗读不是她的声音，只有用户明说才用。
      provider: PROVIDERS.has(v.provider) ? v.provider : 'elevenlabs',
      voiceId: typeof v.voiceId === 'string' ? v.voiceId.trim().slice(0, 200) : '',
      volume: clamp(v.volume, 0, 100, 80),
      fallback: v.fallback === true,
      models: { elevenlabs: modelId(vm.elevenlabs), minimax: modelId(vm.minimax) },
    },
  };
}

function sanitizeLine(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null;
  // Whatever the brain sends goes through the small cleaning once more (it is what is shown, entered in the log and read aloud).
  const line = { id: raw.id.slice(0, 80), text: plain(raw.text.slice(0, 2000)) };
  if (MOODS.has(raw.mood)) line.mood = raw.mood;
  if (raw.speak === true) line.speak = true;
  if (raw.streaming === true) line.streaming = true;
  if (typeof raw.more === 'string' && raw.more) line.more = plain(raw.more.slice(0, 6000));
  // 一起写的童话：聊天框把 kind 为 tale 的消息画成信笺（标题和正文从 tale 里取，没有 tale 就从文字里认《标题》）；
  // 「存下」是窗口自己带着正文来存（pet-ui:tale-save），这里只记下它是一篇童话. 别的 kind 丢掉。
  if (raw.kind === 'tale') {
    line.kind = 'tale';
    const body = taleBody(raw.tale);
    if (body) line.tale = body;
  }
  return line;
}

/* ───────────── small texts (game lines, tales) ───────────── */

/** 括号里的动作旁白：（轻轻点头）(笑)——只收短的、纯汉字的；带数字、字母或标点的括号是正文，留着（同 src/pet/tidy.ts）。 */
const NARRATION = /[（(][\u4e00-\u9fff]{1,14}[）)]/g;
/**
 * 主进程的小清洗，规则和 src/pet/tidy.ts 的标点部分一致（模型的话在页面里已经过 tidy，这是第二道防线；小游戏的台词、童话也走这里）：
 * 去控制字符；问号后的叹号并进问号，其余全角半角的「！!」换成「。」；去「～〜」和不在两个数字之间的「~」；去括号里的短纯汉字旁白；连着的句号并成一个。
 */
function plain(text) {
  return String(text == null ? '' : text)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[？?][！!]+|[！!]+[？?]/g, '？')
    .replace(/[！!]+/g, '。')
    .replace(/[～〜]+/g, '')
    .replace(/(?<!\d)~+(?!\d)/g, '')
    .replace(NARRATION, '')
    .replace(/。{2,}/g, '。');
}
const cut = (text, n) => Array.from(String(text)).slice(0, n).join('');
/** 窗口里的小游戏她说的一句：清洗、一行、最多 GAME_SAY_MAX 个字。 */
const gameText = (text) => {
  const t = cut(plain(text).replace(/\s+/g, ' ').trim(), GAME_SAY_MAX).trim();
  return /[\p{L}\p{N}]/u.test(t) ? t : ''; // nothing but punctuation is not a line
};

/** { words, title, text } from the page → the cleaned one, or null. 词语（最多 6 个）、标题、成稿都要有。 */
function taleBody(t) {
  if (!t || typeof t !== 'object') return null;
  const words = (Array.isArray(t.words) ? t.words : []).filter((w) => typeof w === 'string').map((w) => cut(plain(w).trim(), TALE_WORD_MAX)).filter(Boolean).slice(0, 6);
  const title = typeof t.title === 'string' ? cut(plain(t.title).replace(/\s+/g, ' ').trim(), TALE_TITLE_MAX) : '';
  const text = typeof t.text === 'string' ? cut(plain(t.text).trim(), TALE_TEXT_MAX) : '';
  return words.length && title && text ? { words, title, text } : null;
}

/* ───────────── pet-tales.json ───────────── */

const talesFile = () => path.join(app.getPath('userData'), 'pet-tales.json');

/** One saved tale as read from disk, or null: a damaged entry is dropped, never thrown. */
function savedTale(t) {
  if (!t || typeof t !== 'object' || typeof t.id !== 'string' || !t.id || t.id.length > 80) return null;
  const body = taleBody(t);
  const at = Number(t.at);
  return body && Number.isFinite(at) ? { id: t.id, ...body, at } : null;
}

/**
 * Newest first, at most TALES_MAX. No file is an empty list. A file whose text is not JSON, or not the right shape, is `damaged`
 * (saving sets it aside). A file that could not be READ (EBUSY, EPERM, a virus scan holding it…) is `unreadable`: nothing is wrong
 * with it, so it is left alone and the caller says "try again".
 */
function readTales() {
  let text;
  try { text = fs.readFileSync(talesFile(), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { tales: [], damaged: false };
    return { tales: [], damaged: false, unreadable: String((e && e.code) || 'EIO') };
  }
  let raw;
  try { raw = JSON.parse(text); } catch { return { tales: [], damaged: true }; }
  const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.tales) ? raw.tales : null;
  if (!list) return { tales: [], damaged: true };
  const tales = list.map(savedTale).filter(Boolean).sort((a, b) => b.at - a.at).slice(0, TALES_MAX);
  return { tales, damaged: false };
}

function writeTales(tales) {
  const file = talesFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ version: 1, tales }, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, 'utf8');
  try { fs.renameSync(tmp, file); } catch {
    // AppData behind a filter driver can refuse the rename (EXDEV): write in place.
    try { fs.writeFileSync(file, body, 'utf8'); } finally { try { fs.unlinkSync(tmp); } catch { /* leave it */ } }
  }
}

/** `pet:tale:save`: the page saves a finished tale → { ok, tale }. A damaged file is set aside, never written over. */
function saveTale(raw) {
  const body = taleBody(raw);
  if (!body) return { ok: false, error: '童话不完整：要有词语、标题和正文' };
  try {
    const cur = readTales();
    if (cur.unreadable) return { ok: false, error: `现在读不了存童话的文件（${cur.unreadable}，可能被别的程序占着），它没有被动过。过一会儿再存一次。` };
    if (cur.damaged) { try { fs.renameSync(talesFile(), `${talesFile()}.corrupt-${Date.now()}`); } catch { /* best effort */ } }
    const tale = { id: `tale_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`, ...body, at: Date.now() };
    writeTales([tale, ...cur.tales].slice(0, TALES_MAX));
    return { ok: true, tale };
  } catch (e) {
    return { ok: false, error: `没能存下这篇童话：${String((e && e.message) || e).slice(0, 120)}` };
  }
}

/** PetGameState from the page, checked field by field (or null). */
function sanitizeGame(raw) {
  if (!raw || typeof raw !== 'object' || !GAME_KINDS.has(raw.kind)) return null;
  const g = { kind: raw.kind, active: raw.active === true };
  if (typeof raw.nextChar === 'string' && raw.nextChar) g.nextChar = Array.from(raw.nextChar)[0];
  if (Number.isFinite(raw.turns)) g.turns = Math.max(0, Math.min(9999, Math.floor(raw.turns)));
  if (typeof raw.hint === 'string' && raw.hint) g.hint = cut(raw.hint.replace(/\s+/g, ' ').trim(), 80);
  return g;
}

/* ───────────── what the pet window shows ───────────── */

/** Is she looking at the game right now? Pixels only flow while all of this holds. */
function canSee() {
  const st = capture.status();
  return cfg.enabled && cfg.watch && !paused && !!focus && focus.policy === 'watch' && focus.isGame && st.live && st.hwnd === focus.hwnd;
}

/** 系统开了「减少动态效果」（Windows 设置 › 辅助功能 › 视觉效果 › 动画效果 关着）。读不到就当没开。 */
function reducedMotion() {
  try { return systemPreferences.getAnimationSettings().prefersReducedMotion === true; } catch { return false; }
}

/** 游戏或全屏的程序（视频、演示）在前台：不读光标，也不让她追着光标看（鼠标在别处干活，和她无关）。 */
const gameInFront = () => !!focus && (focus.isGame === true || (!!focus.fullscreen && focus.fullscreen !== 'no'));

function uiState() {
  return {
    theme: cfg.theme, scale: cfg.scale, watching: canSee(), paused: paused && cfg.watch, realtime: rtOn, listening: rtOn && listening,
    voice: cfg.voice.enabled,
    // 眼睛跟鼠标：设置开着、而且此刻在发 look（游戏在前台时不发，她自己游移）。
    follow: cfg.follow && !gameInFront(),
    fpsCap: cfg.fpsCap,
    reducedMotion: reducedMotion(),
    realtimeReady: cfg.realtimeReady,
  };
}
function sendState() {
  petWindow.sendState(uiState());
  syncLook();
}

/* ───────────── her eyes follow the cursor ───────────── */
// follow on, she on screen, no game in front: the cursor is read every 50 ms (screen.getCursorScreenPoint), and a `look`
// goes to her window only when it moved. dx / dy are from the middle of her head, in physical pixels (DIP × the scale of
// the display the cursor is on). With follow off, or nothing to do (a game in front, she is hidden), nothing is read often.

function followNow() {
  return cfg.enabled && cfg.follow && !pageGone && !overlayHidden && !gameInFront() && petWindow.isVisible();
}

function scaleAt(p) {
  try { const f = screen.getDisplayNearestPoint(p).scaleFactor; return Number.isFinite(f) && f > 0 ? f : 1; } catch { return 1; }
}

function lookTick() {
  lookTimer = null;
  // Nothing to do now (a game in front, she is hidden…): the timer stops; sendState / the window showing or hiding start it again.
  if (!followNow()) { lastLook = null; return; }
  const head = petWindow.headPoint();
  if (head) {
    const p = screen.getCursorScreenPoint();
    const k = scaleAt(p);
    const dx = Math.round((p.x - head.x) * k);
    const dy = Math.round((p.y - head.y) * k);
    if (!lastLook || lastLook.dx !== dx || lastLook.dy !== dy) {
      lastLook = { dx, dy };
      petWindow.sendCommand({ type: 'look', dx, dy });
    }
  }
  lookTimer = setTimeout(lookTick, LOOK_MS);
  if (lookTimer.unref) lookTimer.unref();
}

/** Start or stop the cursor reading to match what is true now (called whenever the state changes, and when the window is shown or hidden). */
function syncLook() {
  if (probing()) return;
  if (followNow()) {
    if (!lookTimer) { lookTimer = setTimeout(lookTick, 0); if (lookTimer.unref) lookTimer.unref(); }
  } else {
    clearTimeout(lookTimer);
    lookTimer = null;
    lastLook = null; // when she is seen again, say where the cursor is again
  }
}

/* ───────────── the program in front, and whether to look ───────────── */

/** Is this a game with an anti-cheat? policy.cjs decides (its list, and what it finds next to the game). */
function isAntiCheat(raw) {
  try { return !!policy.isAntiCheat(raw); } catch { return false; }
}

/**
 * Her window is a transparent always-on-top overlay, which an anti-cheat may take for a cheat's: while such a
 * game is in front she is hidden altogether (not just lowered) and says nothing; she comes back when it is not.
 */
function syncOverlay(hide) {
  if (overlayHidden === hide) return;
  overlayHidden = hide;
  // Over an anti-cheat game she says nothing: a live reply stops before her window goes, and so does 实时陪玩 (her
  // microphone and the recogniser would go on unseen).
  if (hide && liveUtt) { cutIds.add(liveUtt.id); stopLive(true); }
  if (hide && realtime.active()) { realtime.stop('反作弊游戏在前台，实时陪玩先结束了；换到别的程序后可以再开始。'); setRt(false); }
  if (hide) { petWindow.hide(); chatSettle(); }
  else if (cfg.enabled) petWindow.show();
  syncLook();
}

/** Show her, once it is known what is in front (it might be an anti-cheat game); if the sense helper says nothing for a
 *  while she comes anyway, and the user is told why she cannot keep out of the way of such games. */
function showSoon() {
  if (overlayHidden) return;
  if (senseHeard) { petWindow.show(); return; }
  if (firstReportTimer) return;
  firstReportTimer = setTimeout(() => {
    firstReportTimer = null;
    if (!cfg.enabled || senseHeard) return;
    senseHeard = true;
    if (!overlayHidden) petWindow.show();
    senseTrouble();
  }, FIRST_REPORT_MS);
}

/** The sense helper did not report in time. Only slow (still starting, a virus scan)? Then she hides as soon as it says
 *  an anti-cheat game is in front. Not running at all: say so once. */
function senseTrouble() {
  const why = String(sense.lastError() || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (sense.running() && !why) return;
  noteSense(`所以她分不出前台是不是带反作弊的游戏，也看不了游戏画面。${why ? `原因：${why}` : ''}`);
}

/** The helper that reads the program in front kept dying right after it started: it is not tried again (until the settings are
 *  changed or she is switched on again), and this is said once. */
function senseGaveUp(why) {
  const reason = String(why || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  noteSense(`读前台程序的小程序一启动就退出，连着失败好几次，已经不再重试，所以她分不出前台是不是带反作弊的游戏，也看不了游戏画面。${reason ? `原因：${reason}` : ''}`);
}

/** One system notification about the sense helper, until it has worked once. */
function noteSense(body) {
  if (senseNoted || !Notification.isSupported()) return;
  senseNoted = true;
  new Notification({ title: '桌宠读不到前台程序', body: body.slice(0, 240) }).show();
}

function applyFocus(raw) {
  lastRaw = raw;
  lostSent = false;
  syncOverlay(isAntiCheat(raw));
  const next = policy.classify(raw, { neverWatch: cfg.neverWatch, gameAllow: cfg.gameAllow, gameDeny: cfg.gameDeny });
  const same = focus && focus.exe === next.exe && focus.hwnd === next.hwnd && focus.title === next.title
    && focus.fullscreen === next.fullscreen && focus.policy === next.policy && focus.isGame === next.isGame && focus.game === next.game
    && focus.antiCheat === next.antiCheat;
  focus = next;
  if (!same) emit({ type: 'focus', app: next });
  void updateWatch();
  frontChanged();
}

/** Is the program in front fullscreen or a game she knows (the built-in list, the user's lists, an anti-cheat), and where
 *  (physical pixels, as the sense helper reports it)? The main window asks to know whether a game or a fullscreen video is
 *  in front on its screen (electron/main.cjs, coveredNow). null while nothing reads the program in front (the pet is off,
 *  or the helper is gone): the main window then goes by how long it has been left. */
function frontApp() {
  if (!lastRaw || !sense.running()) return null;
  return {
    fullscreen: lastRaw.fullscreen === 'borderless' || lastRaw.fullscreen === 'exclusive' ? lastRaw.fullscreen : 'no',
    isGame: !!(focus && focus.isGame),
    rect: lastRaw.rect,
  };
}

/** What frontApp() says has changed: let the main window decide again. */
function frontChanged() {
  if (!host || typeof host.onFrontApp !== 'function') return;
  try { host.onFrontApp(); } catch { /* the main window is not essential to the pet */ }
}

function onFocus(raw) {
  // The pet's own window (the chat panel) holds the keyboard for a while: the game stays "the program in front".
  if (raw.hwnd === petWindow.hwnd()) return;
  senseNoted = false; // it works
  // The first report since she was switched on: she may appear now, unless it is an anti-cheat game.
  const first = !senseHeard;
  if (first) { senseHeard = true; clearTimeout(firstReportTimer); firstReportTimer = null; }
  // At once: her window goes when an anti-cheat game takes the front, and looking stops when the game is no longer in front.
  // Coming back and looking again wait for the focus to settle.
  if (isAntiCheat(raw)) syncOverlay(true);
  else if (first && cfg.enabled && !overlayHidden) petWindow.show();
  const st = capture.status();
  if (st.active && st.hwnd !== raw.hwnd) { stopLooking(); sendState(); }
  // Settling is about the window, not its title: a title that keeps changing (a clock, a song's name) must not put the
  // change off for ever, so only another window starts the wait again (the newest report is the one applied).
  const settling = !!focusTimer && !!pendingRaw && pendingRaw.hwnd === raw.hwnd && pendingRaw.exe === raw.exe && pendingRaw.fullscreen === raw.fullscreen;
  pendingRaw = raw;
  if (settling) return;
  clearTimeout(focusTimer);
  focusTimer = setTimeout(() => { focusTimer = null; if (pendingRaw) applyFocus(pendingRaw); }, FOCUS_DEBOUNCE_MS);
}

/**
 * The sense helper is gone or has gone quiet, so what was last known about the program in front is stale: forget it,
 * stop looking, and tell the brain that no program is known. (A hidden overlay stays hidden: it may still be a game.)
 */
function onLost() {
  clearTimeout(focusTimer);
  focusTimer = null;
  pendingRaw = null;
  lastRaw = null;
  focus = null;
  if (!lostSent) { lostSent = true; emit({ type: 'focus', app: { ...UNKNOWN_APP } }); }
  void updateWatch();
  frontChanged();
}

function wantWatch() {
  // Another window is settling in front: the program last applied is not the one to look at any more.
  if (pendingRaw && focus && pendingRaw.hwnd !== focus.hwnd) return false;
  // Nobody to ask her about the picture while the page is gone (crashed, reloading).
  return !pageGone && cfg.enabled && cfg.watch && !paused && !!focus && focus.policy === 'watch' && focus.isGame && /^\d+$/.test(focus.hwnd) && focus.hwnd !== '0';
}

/** The text read so far belongs to a screen she is no longer allowed to see. */
function forgetText() {
  seenText = [];
  lookEpoch++;
}

function stopLooking() {
  forgetText();
  capture.stop();
}

async function updateWatch() {
  const seq = ++watchSeq;
  if (!wantWatch()) {
    forgetText();
    if (capture.status().active) capture.stop();
    sendState();
    return;
  }
  const hwnd = focus.hwnd;
  const st = capture.status();
  if (st.active && st.hwnd === hwnd) { sendState(); return; }
  await capture.start(hwnd);
  // The foreground may have changed while the page was starting; the newest call decides.
  if (seq !== watchSeq) return;
  if (!(wantWatch() && focus.hwnd === hwnd)) stopLooking();
  sendState();
}

function setPaused(v) {
  if (paused === v) return;
  paused = v;
  emit({ type: 'pause', paused });
  void updateWatch();
  sendState();
}

/* ───────────── reading the screen's text ───────────── */

async function readText() {
  if (!canSee()) return [];
  const hwnd = focus.hwnd;
  const epoch = lookEpoch;
  // Still the same game, and looking has not stopped in between?
  const same = () => canSee() && focus.hwnd === hwnd && epoch === lookEpoch;
  const png = await capture.png({ maxSide: 1600 });
  if (!png || !same()) return [];
  const lines = await sense.ocrPng(png);
  // Paused, switched off or in another program by now: nothing that was read is passed on.
  return same() ? lines : [];
}

/** After a calm moment: read the text and tell the brain about lines it has not seen. */
function scheduleOcr() {
  const now = Date.now();
  if (ocrBusy || now - ocrAt < OCR_GAP_MS || !canSee()) return;
  ocrAt = now;
  ocrBusy = true;
  readText().then((lines) => {
    const fresh = lines.filter((l) => !seenText.includes(l));
    seenText = [...seenText, ...fresh].slice(-300);
    if (fresh.length) emit({ type: 'text', lines: fresh.slice(0, 20), at: Date.now() });
  }).catch(() => {}).finally(() => { ocrBusy = false; });
}

/* ───────────── what she says ───────────── */

async function speak(line) {
  if (speakAbort) speakAbort.abort();
  const ac = new AbortController();
  speakAbort = ac;
  speakingId = line.id;
  let seq = 0;
  const volume = cfg.voice.volume;
  try {
    await tts.synth(line.text, cfg.voice, {
      signal: ac.signal,
      onChunk: (buf, mime) => petWindow.sendAudio({ lineId: line.id, seq: seq++, chunk: new Uint8Array(buf), mime, volume }),
    });
    petWindow.sendAudio({ lineId: line.id, end: true });
  } catch (e) {
    if (!ac.signal.aborted) petWindow.sendAudio({ lineId: line.id, end: true, failed: String((e && e.message) || e).slice(0, 120) });
  } finally {
    if (speakAbort === ac) { speakAbort = null; speakingId = ''; }
  }
}

/**
 * Whatever was being read cannot finish: the pet page reloaded or crashed, her window was hidden, or she is shutting
 * down. The brain holds back proactive talk until a line it heard start has ended, so tell it each one has.
 */
function endSpoken() {
  if (speakAbort) { speakAbort.abort(); speakAbort = null; }
  // A live reply being read stops with it (and is not picked up again by its late sentences).
  if (liveUtt) { cutIds.add(liveUtt.id); stopLive(petWindow.isVisible()); }
  const ids = new Set(reading);
  if (speakingId) ids.add(speakingId);
  speakingId = '';
  reading.clear();
  updateBusy();
  for (const lineId of ids) emit({ type: 'spoken', lineId, state: 'end' });
}

/** `extra`: what only this process may add to the chat entry (a card flipped in 命途占卜) — never taken from a page's line. */
function say(raw, extra) {
  const line = sanitizeLine(raw);
  // Nothing is shown or read while she is hidden for an anti-cheat game.
  if (!line || !cfg.enabled || overlayHidden) return { ok: false };
  // A different line replaces whatever is being read.
  if (speakAbort && speakingId !== line.id) { speakAbort.abort(); speakAbort = null; speakingId = ''; }
  petWindow.sendLine(line);
  chatHers(line, extra);
  if (line.speak && !line.streaming && cfg.voice.enabled) {
    // Read the ordinary way: a live reply still playing gives way.
    if (liveUtt) stopLive(true);
    noteSpeech(line.text);
    void speak(line);
  }
  return { ok: true };
}

async function testVoice(v) {
  const x = v && typeof v === 'object' ? v : {};
  if (!PROVIDERS.has(x.provider)) return { ok: false, error: '未知的语音服务' };
  if (probing()) return { ok: false, error: '探针模式下不建桌宠窗口' };
  petWindow.create();
  let waited;
  await Promise.race([petWindow.whenReady(), new Promise((r) => { waited = setTimeout(r, 6000); })]);
  clearTimeout(waited);
  const id = `test-${Date.now()}`;
  let seq = 0;
  const volume = cfg.voice.volume;
  try {
    const r = await tts.test(
      { provider: x.provider, voiceId: String(x.voiceId || '').slice(0, 200), model: modelId(x.model), text: String(x.text || '').slice(0, 200) },
      { onChunk: (buf, mime) => petWindow.sendAudio({ lineId: id, seq: seq++, chunk: new Uint8Array(buf), mime, volume }) },
    );
    petWindow.sendAudio({ lineId: id, end: true });
    return r;
  } finally {
    // With the pet switched off, her window was built just for this: it goes back to sleep.
    petWindow.park();
  }
}

/* ───────────── the chat log ───────────── */
// Everything said both ways lately, for the chat panel. It lives here rather than in her page, so it outlives the panel,
// a reloaded page and a recreated window, for as long as the app runs (it is never written to disk).

function chatPut(entry) {
  const i = chatLog.findIndex((e) => e.id === entry.id);
  if (i >= 0) chatLog[i] = entry;
  else {
    chatLog.push(entry);
    if (chatLog.length > CHAT_MAX) chatLog = chatLog.slice(-CHAT_MAX);
  }
  petWindow.sendChat({ op: 'put', entry });
  if (entry.streaming) {
    clearTimeout(chatStaleTimer);
    chatStaleTimer = setTimeout(() => chatSettle(), CHAT_STALE_MS);
  }
}

/**
 * Her replies still being written (all, or only `onlyId`), except `keepId`, will not grow any more: a newer line took
 * over, the brain dropped the reply (the user cut in), or she was hidden or switched off before it ended. One that never
 * got past "let me think" goes; one with words in it stays as far as it got. A reply that does go on after all simply
 * comes back under its id.
 */
function chatSettle(keepId, onlyId) {
  for (const e of chatLog.slice()) {
    if (e.who !== 'her' || !e.streaming || e.id === keepId || (onlyId && e.id !== onlyId)) continue;
    if (e.mood === 'think') {
      chatLog = chatLog.filter((x) => x !== e);
      petWindow.sendChat({ op: 'drop', id: e.id });
    } else chatPut({ ...e, streaming: false });
  }
  if (!chatLog.some((e) => e.streaming)) clearTimeout(chatStaleTimer);
}

/** The user's words: typed in the panel, or heard (实时陪玩). */
function chatMine(text, voice) {
  const entry = { id: `me_${Date.now().toString(36)}_${++chatSeq}`, who: 'me', text, at: Date.now() };
  if (voice) entry.voice = true;
  chatPut(entry);
}

/** One of her lines as it reaches the window: a new message, or the one with the same id growing. */
function chatHers(line, extra) {
  if (!line.text) return;
  // Any other line while an older reply is still being written (a newer question, her own line, a reaction): that one
  // is not being written any more.
  chatSettle(line.id);
  const prev = chatLog.find((e) => e.id === line.id);
  const entry = { id: line.id, who: 'her', text: line.text, at: prev ? prev.at : Date.now() };
  if (line.more) entry.more = line.more;
  if (line.streaming) entry.streaming = true;
  if (line.mood) entry.mood = line.mood;
  if (line.kind === 'tale') { entry.kind = 'tale'; if (line.tale) entry.tale = line.tale; }
  if (extra && extra.kind === 'card' && extra.card) { entry.kind = 'card'; entry.card = extra.card; }
  chatPut(entry);
}

/* ───────────── hotkeys, menu ───────────── */

/** The program in front as sense last reported it (not her own window): it gets the keyboard back when the panel closes. */
function frontHwnd() {
  const f = pendingRaw || focus;
  return f && !isOwn(f) ? String(f.hwnd || '') : '';
}

/** Open the chat panel: the hotkey, the menu, a double-click on her, the chat button beside her. */
function openChat() {
  // Not over an anti-cheat game: the panel would bring her window back (nor before it is known what is in front).
  if (!cfg.enabled || overlayHidden || !senseHeard) return;
  petWindow.show();
  if (!petWindow.chatState().focused) petWindow.setRestoreTarget(frontHwnd());
  petWindow.sendCommand({ type: 'chat' });
}

function onAskKey() {
  if (!cfg.enabled || overlayHidden) return;
  // 实时陪玩 by hotkey: the 呼出 key means "listen to me now" (and she stops talking).
  if (rtOn && rtOpts.listen === 'key') {
    if (realtime.listenOnce()) {
      quiet();
      setListening(true);
      // The brain stops the reply it is still writing.
      emit({ type: 'hear', state: 'start' });
    }
    return;
  }
  // Pressed again while typing in the panel: it closes, and the keyboard goes back to the game.
  const st = petWindow.chatState();
  if (st.open && st.focused) { petWindow.sendCommand({ type: 'close-chat' }); return; }
  openChat();
}

function applyHotkeys() {
  const r = hotkeys.apply({ ask: cfg.hotkeyAsk, pause: cfg.hotkeyPause }, { onAsk: onAskKey, onPause: () => setPaused(!paused) });
  // The settings page shows which one did not take, and the brain only names a key that works.
  emit({ type: 'hotkeys', ask: r.ask === true, pause: r.pause === true, errors: r.errors.slice(0, 2) });
  const note = r.errors.join('\n');
  // Say so once (a system notification: the page may be hidden), not at every settings change.
  if (note && note !== hotkeyNote && Notification.isSupported()) {
    new Notification({ title: '桌宠快捷键没有生效', body: note.slice(0, 240) }).show();
  }
  hotkeyNote = note;
}

function showMenu() {
  const w = petWindow.get();
  if (!w) return;
  const f = focus;
  const items = [];
  const chat = petWindow.chatState();
  items.push(chat.open
    ? { label: '收起聊天框', click: () => petWindow.sendCommand({ type: 'close-chat' }) }
    : { label: '和她聊天', click: () => openChat() });
  items.push({ type: 'separator' });
  if (f && f.exe && f.policy !== 'never' && !isOwn(f)) {
    if (f.isGame && f.policy === 'watch') items.push({ label: `不看「${f.game || f.exe}」，只聊天`, click: () => toPage({ type: 'pet-watch', exe: f.exe, allow: false }) });
    else if (!f.isGame) items.push({ label: `把「${f.exe}」当作游戏，让她看`, click: () => toPage({ type: 'pet-watch', exe: f.exe, allow: true }) });
  }
  if (cfg.watch) items.push({ label: paused ? '继续观看' : '暂停观看', click: () => setPaused(!paused) });
  items.push({ label: rtOn ? '结束实时陪玩' : '开始实时陪玩', click: () => toPage({ type: 'pet-realtime', on: !rtOn }) });
  // 小游戏：窗口自己玩（占卜、引蝶）或经大脑玩（接龙、童话），选了就告诉她的窗口开始。
  const play = (kind) => () => petWindow.sendCommand({ type: 'game', kind });
  items.push({
    label: '小游戏',
    submenu: [
      { label: '命途占卜', click: play('tarot') },
      { label: '引蝶', click: play('butterfly') },
      { label: '词语接龙', click: play('chain') },
      { label: '一起写童话', click: play('tale') },
    ],
  });
  items.push({ type: 'separator' });
  items.push({ label: '桌宠设置…', click: () => toPage({ type: 'pet-settings' }, true) });
  items.push({ label: '打开栖枝', click: () => host && host.showMainWindow() });
  items.push({ label: '隐藏桌宠', click: () => toPage({ type: 'pet-toggle' }) });
  Menu.buildFromTemplate(items).popup({ window: w });
}

/* ───────────── 实时陪玩 ───────────── */
// realtime.cjs hears; the brain answers; here her answer is read aloud sentence by sentence (tts.live, raw PCM played as
// it arrives), and the user talking over her cuts her off once their words are clear (not her own voice coming back).

const herSpeaking = () => !!liveUtt || reading.size > 0;
function updateBusy() {
  const now = herSpeaking();
  clearTimeout(busyTimer);
  if (now) { wasBusy = true; realtime.setBusy(true); return; }
  if (wasBusy) { wasBusy = false; lastVoiceEnd = Date.now(); }
  // Her last words still ring in the room for a moment: stay strict a little longer.
  busyTimer = setTimeout(() => { if (!herSpeaking()) realtime.setBusy(false); }, BUSY_TAIL_MS);
  if (busyTimer.unref) busyTimer.unref();
}
function setListening(v) { if (listening === v) return; listening = v; sendState(); }

function setRt(on) {
  if (rtOn === on) return;
  rtOn = on;
  // Her window may have the microphone only while 实时陪玩 is on.
  petWindow.allowMic(on);
  if (!on) { stopLive(true); barge = false; listening = false; }
  sendState();
}

/** Stop her live reply; `hushWindow` also drops what the window is playing. */
function stopLive(hushWindow) {
  // Cut off: its words in the log stop where they got to.
  if (liveUtt) { clearTimeout(liveUtt.idle); liveUtt.ac.abort(); chatSettle(undefined, liveUtt.id); liveUtt = null; }
  if (hushWindow) petWindow.sendCommand({ type: 'hush' });
  updateBusy();
}

/** She stops talking at once: the live reply (its late sentences are refused) and a line read the ordinary way. */
function quiet() {
  if (liveUtt) { cutIds.add(liveUtt.id); if (cutIds.size > 16) cutIds.delete(cutIds.values().next().value); }
  stopLive(true);
  if (speakAbort) { speakAbort.abort(); speakAbort = null; speakingId = ''; }
}

function noteSpeech(text) {
  const t = Date.now();
  recentSpeech = recentSpeech.filter((x) => t - x.at < ECHO_MS).concat({ text: String(text || ''), at: t }).slice(-12);
}

const norm = (t) => String(t || '').replace(/[\s\p{P}\p{S}]/gu, '');

/** Words from the microphone that are her own recent words coming back through the speakers. Only while she speaks
 *  and shortly after: later, the user repeating her words is the user. */
function isEcho(text) {
  const heard = norm(text);
  if (heard.length < 2) return false;
  const t = Date.now();
  if (!herSpeaking() && t - lastVoiceEnd > ECHO_TAIL_MS) return false;
  const said = norm(recentSpeech.filter((x) => t - x.at < ECHO_MS).map((x) => x.text).join(''));
  if (!said) return false;
  if (said.includes(heard)) return true;
  // Mostly the same pairs of characters as something she just said (the recogniser rarely hears her exactly).
  const pairs = (x) => { const out = new Set(); for (let k = 0; k + 1 < x.length; k++) out.add(x.slice(k, k + 2)); return out; };
  const a = pairs(heard);
  const b = pairs(said);
  let hit = 0;
  for (const p of a) if (b.has(p)) hit++;
  return a.size >= 3 && hit / a.size >= 0.75;
}

function liveSay(id, text) {
  if (!rtOn || !cfg.enabled || overlayHidden || cutIds.has(id)) return { ok: false };
  if (!cfg.voice.enabled) return { ok: true }; // the bubble shows it; nothing is read
  if (!liveUtt || liveUtt.id !== id) {
    stopLive(false);
    // A line being read the ordinary way stops: the live reply takes over. (The window drops the older live
    // reply's sound itself when the first sound of this one arrives.)
    if (speakAbort) { speakAbort.abort(); speakAbort = null; speakingId = ''; }
    liveUtt = { id, queue: [], busy: false, ac: new AbortController(), said: '', seq: 0, part: 0, idle: null };
  }
  // The user is in the middle of a sentence: once their words are clear, they may cut her off.
  if (listening) barge = true;
  noteSpeech(text);
  clearTimeout(liveUtt.idle);
  liveUtt.queue.push(text);
  updateBusy();
  void pump(liveUtt);
  return { ok: true };
}

async function pump(u) {
  if (u.busy) return;
  u.busy = true;
  try {
    while (liveUtt === u && u.queue.length) {
      // Her voice was switched off meanwhile: what is still queued is not read.
      if (!cfg.voice.enabled) { u.queue.length = 0; break; }
      const text = u.queue.shift();
      const volume = cfg.voice.volume;
      try {
        await tts.live(text, cfg.voice, {
          signal: u.ac.signal,
          fast: rtOpts.fastVoice,
          previous: u.said,
          onPcm: (buf) => { if (liveUtt === u) petWindow.sendAudio({ lineId: u.id, seq: u.seq++, chunk: new Uint8Array(buf), mime: tts._internals.PCM_MIME, volume, live: true }); },
          // Microsoft read-aloud gives MP3: the window decodes each sentence and plays it after the one before.
          onMp3: (buf) => {
            if (liveUtt !== u) return;
            const part = `${u.id}~${u.part++}`;
            petWindow.sendAudio({ lineId: part, group: u.id, seq: 0, chunk: new Uint8Array(buf), mime: 'audio/mpeg', volume });
            petWindow.sendAudio({ lineId: part, end: true });
          },
        });
        u.said = `${u.said}${text}`.slice(-400);
      } catch {
        if (u.ac.signal.aborted) return;
        // This sentence stays silent (the bubble still shows it); the next one tries again.
      }
    }
  } finally {
    u.busy = false;
    // Everything is handed to the window; its 'spoken end' says when she has finished (the reply keeps its state for
    // sentences still to come until then). If no sound ever started, it is let go after a while.
    if (liveUtt === u && !u.queue.length) {
      clearTimeout(u.idle);
      u.idle = setTimeout(() => { if (liveUtt === u && !u.busy && !u.queue.length && !reading.has(u.id)) { liveUtt = null; updateBusy(); } }, LIVE_IDLE_MS);
      if (u.idle.unref) u.idle.unref();
    }
  }
}

const hearHooks = {
  // The key is read (decrypted) at the moment the session connects, and again on every reconnect; it is not kept.
  key: () => tts.getKey('elevenlabs'),
  state: (st, message) => {
    if (st === 'live') setRt(true);
    else if (st === 'closed' || st === 'error') setRt(false);
    emit(message ? { type: 'rt', state: st, message } : { type: 'rt', state: st });
  },
  speechStart: () => {
    // While she talks it may be her own voice or the game: wait for words before cutting her off.
    if (herSpeaking()) { barge = true; return; }
    setListening(true);
    emit({ type: 'hear', state: 'start' });
  },
  partial: (text) => {
    // A word or two is not enough to tell the user from her own echo: wait for a little more.
    if (!barge || norm(text).length < 3 || isEcho(text)) return;
    barge = false;
    quiet();
    setListening(true);
    emit({ type: 'hear', state: 'start' });
  },
  final: (text) => {
    const cutIn = barge;
    barge = false;
    setListening(false);
    // Her own words coming back are not a question.
    if (isEcho(text)) { emit({ type: 'hear', state: 'none' }); return; }
    if (cutIn || herSpeaking()) { quiet(); if (cutIn) emit({ type: 'hear', state: 'start' }); }
    const said = String(text).slice(0, 500);
    if (said.trim()) chatMine(said.trim(), true);
    emit({ type: 'hear', state: 'final', text: said });
  },
  none: () => {
    barge = false;
    setListening(false);
    emit({ type: 'hear', state: 'none' });
  },
};

async function realtimeCmd(cmd) {
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: '命令无效' };
  if (cmd.op === 'stop') { realtime.stop(); setRt(false); return { ok: true }; }
  if (cmd.op === 'hush') { stopLive(true); return { ok: true }; }
  if (cmd.op === 'say') {
    const id = typeof cmd.id === 'string' ? cmd.id.slice(0, 80) : '';
    const text = typeof cmd.text === 'string' ? cmd.text.slice(0, 400) : '';
    if (!id || !text.trim()) return { ok: false, error: '命令无效' };
    return liveSay(id, text);
  }
  if (cmd.op !== 'start') return { ok: false, error: '命令无效' };
  if (!cfg.enabled) return { ok: false, error: '先打开桌宠' };
  // An anti-cheat game is in front: her window is hidden and she does not listen unseen (this also ended a running session).
  if (overlayHidden) return { ok: false, error: '反作弊游戏在前台，她的窗口先藏起来了，这时不能开实时陪玩；换到别的程序后再开始。' };
  rtOpts = {
    listen: cmd.listen === 'key' ? 'key' : 'auto',
    sensitivity: clamp(cmd.sensitivity, 0, 100, 50),
    fastVoice: cmd.fastVoice !== false,
    autoOffMin: clamp(cmd.autoOffMin, 5, 120, 20),
  };
  // Already on: the new options apply without reconnecting.
  if (realtime.active()) { realtime.update(rtOpts); if (rtOpts.listen === 'auto') setListening(false); return { ok: true }; }
  const r = await realtime.start(rtOpts, hearHooks);
  if (!r || !r.ok) {
    setRt(false);
    emit({ type: 'rt', state: 'closed' });
    return { ok: false, error: (r && r.error) || '实时陪玩没能启动' };
  }
  return { ok: true };
}

/* ───────────── the app page goes away and comes back ───────────── */

/**
 * The app page is gone: it crashed, is reloading, navigated somewhere else or was destroyed (main.cjs tells us). Its brain is gone
 * with it, so nothing may go on for it: the microphone and the recogniser stop, what she was saying stops, her eyes (the capture,
 * the cursor reading) close, whatever was on its way is out of date, and nothing is sent at the page until its first pet:config
 * comes (then resyncPage tells the new brain how things stand).
 */
function pageLost() {
  if (!registered) return;
  pageLoading = true; // (a second call — the reload after a crash — is the same page going away: nothing more to stop)
  if (pageGone) return;
  pageGone = true;
  lookEpoch++;
  watchSeq++;
  if (realtime.active()) {
    realtime.stop();
    rtLostNote = '页面重新加载了，实时陪玩先结束了；需要的话可以再开始。';
  }
  setRt(false);
  endSpoken();
  stopLooking();
  chatSettle();
  clearTimeout(lookTimer);
  lookTimer = null;
  lastLook = null;
}

/** The new page has finished loading (main.cjs: did-finish-load): from now on its pet:config is believed. */
function pageLoaded() {
  pageLoading = false;
}

/** The first pet:config of a new page: its brain starts knowing nothing, so say what it would have heard. */
function resyncPage() {
  const rtNote = rtLostNote;
  rtLostNote = '';
  if (!cfg.enabled) return;
  // (configure just sent the hotkeys.) The program in front, whether she is paused, and 实时陪玩 if it was cut off.
  if (lostSent) emit({ type: 'focus', app: { ...UNKNOWN_APP } });
  else if (focus) emit({ type: 'focus', app: focus });
  if (paused) emit({ type: 'pause', paused: true });
  if (rtNote) emit({ type: 'rt', state: 'closed', message: rtNote });
}

/* ───────────── settings ───────────── */

function shutdownPet() {
  clearTimeout(focusTimer);
  focusTimer = null;
  clearTimeout(firstReportTimer);
  firstReportTimer = null;
  senseHeard = false;
  pendingRaw = null;
  watchSeq++;
  stopLooking();
  sense.stop();
  hotkeys.clear();
  hotkeyNote = '';
  emit({ type: 'hotkeys', ask: false, pause: false, errors: [] });
  endSpoken();
  if (realtime.active()) realtime.stop();
  setRt(false);
  petWindow.hide();
  chatSettle();
  petWindow.sendGame(null);
  syncLook();
  focus = null;
  lastRaw = null;
  overlayHidden = false;
  lostSent = false;
  frontChanged();
}

function configure(next) {
  const prev = cfg;
  cfg = next;
  // A probe run (ALIGHT_PROBE=1) never gets a pet window, sensing, hotkeys or capture: its baseline must stay as it is.
  if (probing()) return;
  // Reading aloud was just switched off: what she is saying (and what is queued) stops now, not at the end of the sentence.
  if (prev.voice.enabled && !cfg.voice.enabled) quiet();
  if (!cfg.enabled) { if (prev.enabled) shutdownPet(); return; }
  petWindow.applyScale(cfg.scale);
  // Over an anti-cheat game she stays hidden (syncOverlay brings her back when it is no longer in front), and just
  // switched on she waits to hear what is in front.
  showSoon();
  // A page that has just loaded may not have its listeners up yet when the first state goes out: send it again once it has.
  void petWindow.whenReady().then(sendState);
  applyHotkeys();
  if (!sense.running()) {
    sense.start({
      onFocus,
      onIdle: (seconds) => emit({ type: 'idle', seconds }),
      onLost,
      onGiveUp: senseGaveUp,
    });
  }
  sendState();
  // A change of the lists or of the watch switch changes what the program in front is allowed.
  const listsChanged = ['neverWatch', 'gameAllow', 'gameDeny'].some((k) => prev[k].join('\n') !== cfg[k].join('\n'));
  if (listsChanged && lastRaw) applyFocus(lastRaw);
  else void updateWatch();
}

/* ───────────── wiring ───────────── */

/** Before app.whenReady(): switches that must be set early. */
function beforeReady() {
  // Not in a probe run: it would change what the probes measure (docs/BASELINE.md).
  if (probing()) return;
  // 测量用：ALIGHT_PET_KEEP_OCCLUSION=1 时不关遮挡检测，用来量这个开关对全屏游戏帧率的影响（design/pet/bench）。
  if (process.env.ALIGHT_PET_KEEP_OCCLUSION === '1') return;
  // Kept on purpose, and it is for the capture page: that page is a hidden window nobody can see, and Chromium treats a window
  // it thinks is covered as occluded and stops its frames and timers, so getDisplayMedia would get no frames. The switch is
  // process-wide (it also keeps the main window and her window from being paused as "covered"), which is why a probe run, whose
  // baseline is measured with the occlusion detection on, never sets it (above).
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
}

/** host = { getMainWindow(), showMainWindow(), sendCommandToPage(cmd, show?), isAppSender(event), onFrontApp?() } */
function register(hostApi) {
  if (registered) return;
  registered = true;
  host = hostApi;
  if (!probing()) capture.init();
  unsubs.push(capture.onScene((ev) => {
    emit({ type: 'scene', state: ev.state, since: ev.since, change: ev.change });
    if (ev.state === 'settled' || ev.state === 'static') scheduleOcr();
  }));
  unsubs.push(capture.onLive(() => sendState()));
  // The pet page reloaded or crashed, or her window was hidden: what it was playing is gone.
  unsubs.push(petWindow.onReset(() => endSpoken()));
  // Her window shown or hidden (also by itself: a crash that is given up, the user closing it): the cursor reading starts or stops.
  unsubs.push(petWindow.onVisibility(() => syncLook()));

  // From the app page.
  ipcMain.on('pet:config', (e, raw) => {
    if (!fromApp(e)) return;
    if (pageGone && pageLoading) return; // a late message of the page that is leaving
    // A page that was gone is back: it hears the settings are applied first, then how things stand.
    const back = pageGone;
    pageGone = false;
    configure(sanitizeConfig(raw));
    if (back) resyncPage();
  });
  handle('pet:say', (_e, line) => say(line));
  handle('pet:frame', async (_e, opts) => (canSee() ? capture.frame({ maxSide: opts && opts.maxSide }) : null));
  handle('pet:ocr', async () => (canSee() ? { lines: (await readText()).slice(0, 40) } : null));
  // opts.all: the ready-made voices too (the picker shows only the ones the user designed by default); clones are never listed.
  handle('pet:tts:voices', async (_e, provider, opts) => {
    try { return await tts.voices(String(provider), { all: !!opts && typeof opts === 'object' && opts.all === true }); } catch (err) { return { error: String((err && err.message) || err).slice(0, 200) }; }
  });
  handle('pet:tts:test', (_e, v) => testVoice(v));
  handle('pet:tts:models', async (_e, provider) => {
    try { return await tts.models(String(provider)); } catch (err) { return { error: String((err && err.message) || err).slice(0, 200) }; }
  });
  handle('pet:tts:key', (_e, provider, key) => tts.saveKey(String(provider), key));
  handle('pet:tts:clear', (_e, provider) => tts.clearKey(String(provider)));
  handle('pet:tts:keys', () => tts.hints());
  handle('pet:rt', (_e, cmd) => realtimeCmd(cmd));
  // 小游戏：大脑说接龙轮到谁 / 童话在写，原样（逐字段检查过）转给她的窗口；写好的童话存下。
  ipcMain.on('pet:game-state', (e, raw) => {
    if (!fromApp(e)) return;
    const g = sanitizeGame(raw);
    if (g) petWindow.sendGame(g);
  });
  handle('pet:tale:save', (_e, t) => saveTale(t));

  // From the pet window.
  // 小游戏：开始 / 结束，转给大脑（接龙和童话由它接手，占卜和引蝶只是告诉它别在这时插嘴）。
  listen('pet-ui:game', fromPet, (_e, m) => {
    if (!m || (m.op !== 'start' && m.op !== 'stop') || !GAME_KINDS.has(m.kind)) return;
    emit({ type: 'game', op: m.op, kind: m.kind });
  });
  // 窗口里自己玩完的小游戏她说的一句：清洗（去「！」「～」、截长）后当普通台词处理——进聊天记录、气泡、开着朗读就读。
  listen('pet-ui:game-say', fromPet, (_e, m) => {
    if (!m || typeof m !== 'object' || !cfg.enabled || overlayHidden) return;
    const text = gameText(m.text);
    if (!text) return;
    const now = Date.now();
    gameSays = gameSays.filter((t) => now - t < 10_000);
    if (gameSays.length >= GAME_SAY_BURST) return;
    gameSays.push(now);
    const line = { id: `game_${now.toString(36)}_${++gameSeq}`, text, speak: true };
    if (MOODS.has(m.mood)) line.mood = m.mood;
    say(line, typeof m.card === 'string' && CARD_RE.test(m.card) ? { kind: 'card', card: m.card } : undefined);
  });
  handlePet('pet-ui:tales', () => readTales().tales);
  // 信笺上的「存下」：窗口带着词语、标题、正文来，和主页面的 pet:tale:save 写同一个 pet-tales.json（同样的清洗、上限）。
  handlePet('pet-ui:tale-save', (_e, t) => saveTale(t));
  // 「实时」按钮：只转给大脑（它按设置去调 realtime start / stop），主进程不自己开.
  listen('pet-ui:realtime', fromPet, (_e, on) => {
    if (typeof on !== 'boolean' || !cfg.enabled || overlayHidden) return;
    emit({ type: 'rt-request', on });
  });
  // 「暂停看屏」按钮：和暂停热键一样（停采集、告诉大脑、更新状态）；热键是翻转，按钮说明白要哪一边.
  listen('pet-ui:pause', fromPet, (_e, p) => {
    if (typeof p !== 'boolean' || !cfg.enabled || overlayHidden) return;
    setPaused(p);
  });
  // The chat panel. Sending does not close it; the message goes into the log, then to the brain.
  listen('pet-ui:ask', fromPet, (_e, m) => {
    const text = m && typeof m.text === 'string' ? m.text.trim().slice(0, 2000) : '';
    if (!text) return;
    chatMine(text, false);
    emit({ type: 'ask', text });
  });
  listen('pet-ui:chat-sync', fromPet, () => petWindow.sendChat({ op: 'reset', entries: chatLog.slice() }));
  listen('pet-ui:chat-open', fromPet, () => openChat());
  listen('pet-ui:chat-close', fromPet, () => petWindow.sendCommand({ type: 'close-chat' }));
  listen('pet-ui:chat-focus', fromPet, () => {
    const st = petWindow.chatState();
    if (!st.open || st.focused) return;
    petWindow.setRestoreTarget(frontHwnd());
    petWindow.focusChat();
  });
  listen('pet-ui:hit', fromPet, (_e, over) => petWindow.setInteractive(over === true));
  listen('pet-ui:drag', fromPet, (_e, m) => {
    if (m && ['start', 'move', 'end'].includes(m.phase)) petWindow.drag(m.phase, m.x, m.y);
  });
  listen('pet-ui:menu', fromPet, () => showMenu());
  listen('pet-ui:click', fromPet, () => emit({ type: 'click' }));
  listen('pet-ui:mic', fromPet, (_e, m) => {
    const pcm = m && m.pcm;
    // Only a block of samples (a typed array, small) goes on to the session.
    if (!rtOn || !ArrayBuffer.isView(pcm) || !pcm.byteLength || pcm.byteLength > MAX_MIC_BYTES) return;
    realtime.pushMic(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  });
  // 实时陪玩 cannot hear: the page could not open the microphone, or lost it. The session ends and says why (the text is
  // the desktop's own, never the page's).
  listen('pet-ui:mic-failed', fromPet, () => {
    if (!rtOn) return;
    realtime.stop('打不开麦克风：请在 Windows 设置的「隐私和安全性 › 麦克风」里允许桌面应用使用麦克风，或接上麦克风后再开始实时陪玩。', true);
    setRt(false);
  });
  listen('pet-ui:spoken', fromPet, (_e, m) => {
    if (!m || typeof m.lineId !== 'string' || (m.state !== 'start' && m.state !== 'end')) return;
    // Remember what is playing, so its end can be reported if the page cannot (endSpoken). A page could send any number of ids.
    const lineId = m.lineId.slice(0, 80);
    if (m.state === 'start') {
      if (reading.size >= 8) reading.delete(reading.values().next().value);
      reading.add(lineId);
    } else {
      reading.delete(lineId);
      if (liveUtt && liveUtt.id === lineId && !liveUtt.busy && !liveUtt.queue.length) { clearTimeout(liveUtt.idle); liveUtt = null; }
    }
    updateBusy();
    emit({ type: 'spoken', lineId, state: m.state });
  });
}

/** Pictures handed to OCR that the helper had not finished with when the app quit (sense.cjs names them ocr-<pid>-<id>.png). */
function removeTempFrames() {
  let names;
  try { names = fs.readdirSync(TEMP_DIR); } catch { return; }
  const mine = `ocr-${process.pid}-`;
  for (const name of names) {
    if (!name.startsWith(mine) || !name.endsWith('.png')) continue;
    try { fs.unlinkSync(path.join(TEMP_DIR, name)); } catch { /* still open: the next start sweeps it */ }
  }
}

/** App is quitting. */
function stopAll() {
  // Her window closing from here on is the app going away, not one to build again.
  petWindow.shutdown();
  clearTimeout(focusTimer);
  clearTimeout(firstReportTimer);
  clearTimeout(lookTimer);
  lookTimer = null;
  try { stopLive(false); } catch { /* the page is going away too */ }
  try { endSpoken(); } catch { /* the page is going away too */ }
  try { realtime.stop(); } catch { /* not running */ }
  try { sense.stop(); } catch { /* not running */ }
  try { hotkeys.clear(); } catch { /* none */ }
  capture.dispose();
  forgetText();
  removeTempFrames();
  unsubs.forEach((fn) => { try { if (typeof fn === 'function') fn(); } catch { /* going away anyway */ } });
  unsubs = [];
  const w = petWindow.get();
  if (w) w.destroy();
}

module.exports = { beforeReady, register, stopAll, pageLost, pageLoaded, frontApp, _internals: { sanitizeConfig, sanitizeLine, sanitizeGame, gameText, taleBody, plain } };
