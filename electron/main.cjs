// 栖枝 · Alight — desktop shell (forked from 萤火 · Agent 工作台).
// Loads the built web app (dist/index.html) in a locked-down window: no Node in the page, context
// isolation and sandbox on, external links open in the system browser, in-app navigation stays put.
// A tray icon keeps it reachable: closing the window can tuck it into the tray while runs go on.
const { app, BrowserWindow, shell, Menu, Tray, Notification, ipcMain, nativeImage, nativeTheme, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const ai = require('./ai/index.cjs');
const browser = require('./ai/browser.cjs');
const store = require('./store/index.cjs');
const pet = require('./pet/index.cjs');
const { pageUrls, appSenderCheck } = require('./pet/sender.cjs');

/** Headless probes (scripts/probe): ALIGHT_PROBE=1 keeps every window hidden and skips the tray. */
const PROBE = process.env.ALIGHT_PROBE === '1';
/** 探针的计时用例（S3 长会话、输入延迟）要真实的帧：从不显示的窗口里合成器只有约 1 Hz 的节拍，主线程的 Commit 会被卡 1 秒，
 *  量出来的是窗口隐藏的假象。ALIGHT_PROBE_OSR=1 改用离屏渲染 + 60 fps + 软件渲染（不碰独显）。S2/S5 内存与 CPU 不用它：软件渲染没有 GPU 进程，数字不可比. */
const PROBE_OSR = PROBE && process.env.ALIGHT_PROBE_OSR === '1';
if (PROBE_OSR) app.disableHardwareAcceleration();

/** 设置 › 外观 › 图形处理器：auto 交给系统（双显卡笔记本上通常是集显）、low 固定集显、high 用独显。
 *  Chromium 只在启动时挑显卡，所以偏好存在 userData/gpu.json、改了要重启才生效；探针一律 auto（数字要和基线可比）. */
const GPU_PREFS = new Set(['auto', 'low', 'high']);
const GPU_FILE = () => path.join(app.getPath('userData'), 'gpu.json');
function readGpuPref() {
  try { const p = JSON.parse(fs.readFileSync(GPU_FILE(), 'utf8')).pref; return GPU_PREFS.has(p) ? p : 'auto'; } catch { return 'auto'; }
}
const gpuAtLaunch = PROBE ? 'auto' : readGpuPref();
if (gpuAtLaunch === 'high') app.commandLine.appendSwitch('force_high_performance_gpu');
else if (gpuAtLaunch === 'low') app.commandLine.appendSwitch('force_low_power_gpu');

// One window per user: a second launch focuses the existing one.
if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}
// 桌宠的采集页要几个必须在 app ready 之前设的开关（探针模式下它什么都不动）。
pet.beforeReady();

/** @type {BrowserWindow | null} */
let win = null;
/** @type {Tray | null} */
let tray = null;
/** Set once the app is really quitting, so closing the window no longer hides it. */
let quitting = false;
/** Mirrors 设置 › 关闭窗口时缩小到托盘 (the page tells us on load and on change). */
let closeToTray = true;

const APP_PAGE = path.join(__dirname, '..', 'dist', 'index.html');
const ICON = path.join(__dirname, '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const STATE_FILE = () => path.join(app.getPath('userData'), 'window-state.json');

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  try { fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...readState(), ...patch })); } catch { /* not important */ }
}

function showWindow() {
  if (!win) { createWindow(); return; }
  if (PROBE) return;
  revealed = true;        // 用户自己把它叫出来了（托盘 / 第二次启动）：不用再等页面的「第一帧好了」
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
}

/** 窗口什么时候第一次露出来：不再一到 ready-to-show 就显示——那时页面只画了主界面，开屏还没画好，用户会先看到主界面再看到开机动画。
 *  改为等页面发来 app:frame-ready（开屏第 0 帧已画好；不播开屏则是主界面第一次提交），或者超时兜底（页面卡住 / 出错时也要让用户看到窗口）。 */
const REVEAL_FALLBACK_MS = 2500;
let revealed = false;
let revealTimer = null;
function reveal() {
  if (revealed) return;
  revealed = true;
  if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
  if (PROBE || !win || win.isDestroyed()) return;
  if (!win.isVisible()) win.show();
}

/** 把窗口此刻是否可见告诉页面（页面的开屏时钟、动效据此起停）。探针模式窗口从不显示，但页面要的是「可以开始了」，所以报 true. */
function announceVisibility() {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return;
  win.webContents.send('app:visibility', PROBE ? true : win.isVisible() && !win.isMinimized());
}

/** 被盖住：窗口还显示着，可是没人在看她——她这块屏的前台是全屏程序（游戏、视频），或桌宠认得的游戏（窗口模式也算）。
 *  这时页面停下动效（<html data-window-covered>：CSS 动画暂停，落雪和蝶不画），计时器、轮询、数据照常走；副屏上照动。
 *  前台是什么由桌宠读前台程序的小程序报（pet.frontApp）；桌宠关着、小程序没在报时，退一步按「切走满 AWAY_MS」算。
 *  为什么要主进程来说：backgroundThrottling 关着，Chromium 的遮挡检测又被桌宠的截屏页关了（pet.beforeReady），被盖住的窗口照样按
 *  屏幕刷新率出帧，一块在呼吸的面板就会在核显上和全屏游戏抢合成（design/pet/bench/jitter：游戏 1% 低帧约 220 → 80–140）。 */
const AWAY_MS = 5000;
let covered = false;
let blurredAt = 0;
let awayTimer = null;

/** 前台那个程序和主窗口在不在同一块屏上（rect 是物理像素）. 算不出来就当在：宁可停下动效. */
function onMyScreen(rect) {
  try {
    const dip = screen.screenToDipRect(null, { x: rect.x, y: rect.y, width: rect.w, height: rect.h });
    return screen.getDisplayMatching(dip).id === screen.getDisplayMatching(win.getBounds()).id;
  } catch { return true; }
}

function coveredNow() {
  if (PROBE || !win || win.isDestroyed() || !win.isVisible() || win.isMinimized() || win.isFocused()) return false;
  let front = null;
  try { front = pet.frontApp(); } catch { /* the pet is not essential */ }
  if (front) return (front.fullscreen !== 'no' || front.isGame) && onMyScreen(front.rect);
  return blurredAt > 0 && Date.now() - blurredAt >= AWAY_MS;
}

/** 重新判断一次，变了才告诉页面；force：页面刚加载完，照实再说一遍. */
function announceCovered(force = false) {
  const now = coveredNow();
  if (now === covered && !force) return;
  covered = now;
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('app:covered', covered);
}

/** Ask the page to do something (from the tray menu or a notification). */
function command(cmd, show = true) {
  if (show) showWindow();
  if (win) win.webContents.send('app:command', cmd);
}

function trayMenu() {
  return Menu.buildFromTemplate([
    { label: '打开栖枝', click: showWindow },
    { label: '新建任务', click: () => command({ type: 'new' }) },
    { label: '打开栖枝浏览器', click: () => browser.open() },
    { type: 'separator' },
    // 桌宠：显示 / 隐藏不用把主窗口叫出来；设置在主窗口里，所以要显示它。
    { label: '显示 / 隐藏桌宠', click: () => command({ type: 'pet-toggle' }, false) },
    { label: '桌宠设置…', click: () => command({ type: 'pet-settings' }) },
    { type: 'separator' },
    { label: '关闭窗口时缩小到托盘', type: 'checkbox', checked: closeToTray, click: (item) => command({ type: 'close-to-tray', value: item.checked }, false) },
    { type: 'separator' },
    { label: '退出栖枝', click: () => { quitting = true; app.quit(); } },
  ]);
}

function createTray() {
  if (tray || PROBE) return;
  let image = nativeImage.createFromPath(ICON);
  if (image.isEmpty()) image = nativeImage.createFromPath(path.join(__dirname, '..', 'build', 'icon.png'));
  tray = new Tray(process.platform === 'win32' ? image : image.resize({ width: 16, height: 16 }));
  tray.setToolTip('栖枝 · 遐蝶的 Agent 工作台');
  tray.setContextMenu(trayMenu());
  tray.on('click', () => (win && win.isVisible() && win.isFocused() ? win.hide() : showWindow()));
}

/** 页面地址的两种写法（路径里有 ~ [ ] % 时 loadFile 和 pathToFileURL 写得不一样）：见 pet/sender.cjs. */
const APP_URLS = pageUrls(APP_PAGE);
const isAppFile = (u) => typeof u === 'string' && APP_URLS.has(u.split('#')[0]);

/** Only the app's own page may talk to the shell: the sender is the main window's web contents, in its top frame (nothing it
 *  embeds), and that frame is still on the bundled page. Who it is is decided by identity, not by comparing the frame's URL
 *  as text; the address check only says it was not navigated elsewhere. ai/index.cjs and the 桌宠 use the same check. */
const isAppSender = appSenderCheck(() => win, APP_URLS);
const fromApp = isAppSender;

// 页面的第一帧准备好了 → 显示窗口（只接受本应用页面的消息；只发不收，没有参数）。显示后立刻回报可见状态：开屏的时钟等的就是这一条.
ipcMain.on('app:frame-ready', (e) => {
  if (!fromApp(e)) return;
  reveal();
  announceVisibility();
  announceCovered(true);
});

ipcMain.on('app:prefs', (e, prefs) => {
  if (!fromApp(e) || !prefs || typeof prefs !== 'object') return;
  if (typeof prefs.closeToTray === 'boolean') closeToTray = prefs.closeToTray;
  if (tray) tray.setContextMenu(trayMenu());
});

// A system notification while the window is hidden or minimized (an approval waiting, a run finished).
ipcMain.on('app:notify', (e, n) => {
  if (!fromApp(e) || !n || typeof n.title !== 'string' || !Notification.isSupported()) return;
  if (win && win.isVisible() && !win.isMinimized() && win.isFocused()) return;
  const note = new Notification({ title: n.title.slice(0, 80), body: typeof n.body === 'string' ? n.body.slice(0, 240) : '', icon: ICON, silent: false });
  note.on('click', () => (n.command && typeof n.command === 'object' ? command(n.command) : showWindow()));
  note.show();
});

// 「待你」角标（Q01）：页面画好一个小图（PNG data URL）与描述，这里贴到任务栏图标右下角；count 0 清除。
ipcMain.on('app:badge', (e, b) => {
  if (!fromApp(e) || !win || !b || typeof b !== 'object') return;
  const count = Number(b.count) || 0;
  if (count <= 0 || typeof b.png !== 'string' || !b.png.startsWith('data:image/png;base64,')) { win.setOverlayIcon(null, ''); return; }
  const img = nativeImage.createFromDataURL(b.png);
  if (!img.isEmpty()) win.setOverlayIcon(img, String(b.label || `待你 ${count}`).slice(0, 60));
});

// 夜/昼：原生标题栏与窗口底色跟着页面主题走（深色标题栏配昼、浅色配夜会和界面打架）。
const THEME_BG = { night: '#0e0c19', day: '#dcd5ee' };
ipcMain.on('app:theme', (e, mode) => {
  if (!fromApp(e) || !win || !Object.prototype.hasOwnProperty.call(THEME_BG, mode)) return;
  nativeTheme.themeSource = mode === 'day' ? 'light' : 'dark';
  win.setBackgroundColor(THEME_BG[mode]);
  // 下次启动窗口一创建就用这个底色（页面要 0.2 s 后才说得上话；昼主题不该先闪一下夜色）
  if (readState().theme !== mode) writeState({ theme: mode });
});

/** 正在用的显卡（只在设置页问起时取一次：'complete' 要多跑一趟信息收集）。 */
let gpuInfo = null;
function activeGpu() {
  if (!gpuInfo) {
    gpuInfo = app.getGPUInfo('complete').then((info) => {
      // 0x1414 是微软基本显示适配器（软件），不算一块能选的显卡
      const devs = (info.gpuDevice || []).filter((d) => d.vendorId !== 0x1414);
      const discrete = devs.some((d) => d.vendorId === 0x10de || d.vendorId === 0x1002);
      const renderer = String((info.auxAttributes && info.auxAttributes.glRenderer) || '');
      const name = (renderer.match(/^ANGLE \([^,]+, (.+?) \(0x[0-9a-f]+\)/i) || [])[1] || '';
      const act = devs.find((d) => d.active);
      const kind = !act ? 'unknown' : act.vendorId === 0x8086 ? 'integrated' : act.vendorId === 0x10de ? 'discrete' : 'unknown';   // AMD 的集显与独显同一个厂商号，分不出来
      return { active: name.slice(0, 80), kind, choice: discrete && devs.length >= 2 };
    }).catch(() => ({ active: '', kind: 'unknown', choice: false }));
  }
  return gpuInfo;
}

ipcMain.handle('app:gpu:get', async (e, light) => {
  if (!fromApp(e)) return null;
  // light：只要偏好与「这次启动用的偏好」（开屏的调速器据此判断是不是独显），不去收集 GPU 信息（'complete' 要多跑一趟，开屏期间不能干这个）
  if (light === true) return { pref: readGpuPref(), atLaunch: gpuAtLaunch, active: '', kind: 'unknown', choice: false };
  return { pref: readGpuPref(), atLaunch: gpuAtLaunch, ...(await activeGpu()) };
});
ipcMain.handle('app:gpu:set', (e, pref) => {
  if (!fromApp(e) || !GPU_PREFS.has(pref)) return { ok: false };
  try { fs.writeFileSync(GPU_FILE(), JSON.stringify({ pref })); return { ok: true }; } catch (err) { return { ok: false, error: String(err && err.message || err) }; }
});
// 「立即重启」：只在页面上点了才重启，正在跑的命令行代理随退出一起收掉（before-quit 里 ai.stopAll）
ipcMain.handle('app:relaunch', (e) => {
  if (!fromApp(e) || PROBE) return false;
  app.relaunch();
  quitting = true;
  app.quit();
  return true;
});

function createWindow() {
  const theme = readState().theme === 'day' ? 'day' : 'night';
  if (theme === 'day') nativeTheme.themeSource = 'light';
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: THEME_BG[theme],
    title: '栖枝',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      offscreen: PROBE_OSR,
      // The boot clip is muted; this just lets it start without a click.
      autoplayPolicy: 'no-user-gesture-required',
      // Keep timers and media running when the window is covered (the boot clip must not stall).
      backgroundThrottling: false,
      // Model access (keys, CLI runs) — see electron/ai/index.cjs.
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  Menu.setApplicationMenu(null);
  if (PROBE_OSR) win.webContents.setFrameRate(60);

  // backgroundThrottling 关着，页面自己看不出窗口被藏进托盘或最小化了——主进程告诉它，动效和轮询据此暂停。
  // 无头探针里窗口本来就没显示，不发（否则页面会一直当自己被藏起来）。
  if (!PROBE) {
    for (const ev of ['show', 'hide', 'minimize', 'restore']) win.on(ev, announceVisibility);
    // 被盖住的判断跟着焦点与显示状态走；刚显示出来又没拿到焦点，「切走多久」从这一刻算起.
    const away = (since) => {
      blurredAt = since;
      clearTimeout(awayTimer);
      awayTimer = since ? setTimeout(() => announceCovered(), AWAY_MS + 50) : null;
      announceCovered();
    };
    win.on('focus', () => away(0));
    win.on('blur', () => away(Date.now()));
    for (const ev of ['show', 'restore']) win.on(ev, () => away(win.isFocused() ? 0 : Date.now()));
    for (const ev of ['hide', 'minimize']) win.on(ev, () => announceCovered());
  }

  // 窗口先藏着，等页面说「第一帧好了」再显示（见 reveal）；超时兜底。ready-to-show 不再触发显示.
  revealed = false;
  if (revealTimer) clearTimeout(revealTimer);
  revealTimer = PROBE ? null : setTimeout(reveal, REVEAL_FALLBACK_MS);
  win.loadFile(APP_PAGE);

  // Links with target=_blank (credits, GitHub) open in the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never navigate the app window away from the bundled page — not even to another local file
  // (a dropped .html would otherwise run with the desktop bridge).
  const guard = (event, url) => {
    if (isAppFile(url)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  };
  win.webContents.on('will-navigate', guard);
  win.webContents.on('will-frame-navigate', (event) => { if (!event.isMainFrame) return; guard(event, event.url); });
  // A crashed page is a blank window, and the 桌宠's brain lives in it: load it again (the runs go on in this process),
  // but not in a loop: at most 3 times a minute.
  const self = win;
  let crashes = [];
  // The page is what the 桌宠's brain, ears and mouth belong to: when it crashes, reloads, navigates away or is destroyed, the main
  // process stops her session (microphone, speaking, looking) and waits for the new page's first pet:config (electron/pet/index.cjs pageLost).
  const petPageLost = () => { try { pet.pageLost(); } catch { /* the pet is not essential */ } };
  win.webContents.on('did-start-navigation', (...a) => {
    // Electron passes one details object (older builds: event, url, isInPlace, isMainFrame).
    const d = a[0] && typeof a[0] === 'object' && 'isMainFrame' in a[0] ? a[0] : { isSameDocument: a[2], isMainFrame: a[3] };
    if (d.isMainFrame && !d.isSameDocument) petPageLost();
  });
  win.webContents.on('did-finish-load', () => { try { pet.pageLoaded(); } catch { /* the pet is not essential */ } });
  win.webContents.on('destroyed', petPageLost);
  win.webContents.on('render-process-gone', (_e, details) => {
    petPageLost();
    if (quitting || win !== self || (details && details.reason === 'clean-exit')) return;
    const now = Date.now();
    crashes = crashes.filter((t) => now - t < 60_000).concat(now);
    if (crashes.length > 3) return;
    setTimeout(() => { if (win === self && !win.isDestroyed()) win.reload(); }, 1000);
  });
  // The close button tucks the window into the tray (when that setting is on); runs keep going.
  win.on('close', (event) => {
    if (quitting || !closeToTray || !tray) return;
    event.preventDefault();
    win.hide();
    if (!readState().trayHinted) {
      writeState({ trayHinted: true });
      tray.displayBalloon({ title: '栖枝还在托盘里', content: '任务会继续在后台运行。点托盘图标打开；右键可以退出，或在设置里改成关闭即退出。', iconType: 'info' });
    }
  });
  win.on('closed', () => {
    win = null;
    petPageLost();
    if (revealTimer) { clearTimeout(revealTimer); revealTimer = null; }
    // 桌宠的窗口还在时 'window-all-closed' 不会触发：窗口不缩到托盘就关掉了，应用也跟着退出.
    if (quitting || !closeToTray) app.quit();
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(() => {
  // Windows groups notifications by this id (the installer registers the same one).
  if (process.platform === 'win32') app.setAppUserModelId('io.github.xtdf0224-boop.alight');
  ai.register({ isAppSender });
  pet.register({ getMainWindow: () => win, showMainWindow: showWindow, sendCommandToPage: command, isAppSender, onFrontApp: () => announceCovered() });
  createTray();
  createWindow();
});
app.on('window-all-closed', () => { if (quitting || !closeToTray) app.quit(); });
// Never leave a CLI agent running after the app is gone (nor the 桌宠's sense helper, capture page and windows).
// Each step on its own: one that throws must not keep the store from being closed (or the others from running).
app.on('before-quit', () => {
  quitting = true;
  for (const stop of [() => ai.stopAll(), () => pet.stopAll(), () => store.close()]) {
    try { stop(); } catch { /* not running / not open */ }
  }
});
