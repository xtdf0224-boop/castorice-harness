// The page's only door to the desktop: model access calls, all handled in electron/ai/index.cjs.
// API keys go in through saveKey and never come back out.
const { contextBridge, ipcRenderer } = require('electron');

const listeners = new Set();
ipcRenderer.on('ai:event', (_e, ev) => { for (const l of listeners) l(ev); });
const commands = new Set();
ipcRenderer.on('app:command', (_e, cmd) => { for (const l of commands) l(cmd); });
// The main window is hidden / minimized / shown again (backgroundThrottling is off, so the page cannot tell by itself).
const visibility = new Set();
ipcRenderer.on('app:visibility', (_e, visible) => { for (const l of visibility) l(!!visible); });
// The main window is still shown, but a fullscreen program covers it (or it was left a while ago): the page stops its motion.
const covered = new Set();
ipcRenderer.on('app:covered', (_e, on) => { for (const l of covered) l(!!on); });
// 桌宠 → 主页面的事件（焦点程序、画面状态、你在聊天框里说的话、小游戏…）：见 electron/pet/index.cjs.
const petListeners = new Set();
ipcRenderer.on('pet:event', (_e, ev) => { for (const l of petListeners) l(ev); });

contextBridge.exposeInMainWorld('alightDesktop', {
  version: 1,
  info: () => ipcRenderer.invoke('ai:info'),
  // endpoint is optional: regions that need their own key get their own slot, computed by the main process
  saveKey: (provider, key, endpoint) => ipcRenderer.invoke('ai:key:save', provider, key, endpoint),
  clearKey: (provider, endpoint) => ipcRenderer.invoke('ai:key:clear', provider, endpoint),
  detect: (req) => ipcRenderer.invoke('ai:detect', req),
  models: (req) => ipcRenderer.invoke('ai:models', req),
  openLogin: (req) => ipcRenderer.invoke('ai:login', req),
  test: (spec) => ipcRenderer.invoke('ai:test', spec),
  pickFolder: (start) => ipcRenderer.invoke('ai:folder:pick', start),
  workspaceFolder: (name) => ipcRenderer.invoke('ai:folder:workspace', name),
  openFolder: (dir) => ipcRenderer.invoke('ai:folder:open', dir),
  start: (spec) => ipcRenderer.invoke('ai:start', spec),
  input: (id, text) => ipcRenderer.invoke('ai:input', id, text),
  answer: (id, requestId, decision, input) => ipcRenderer.invoke('ai:answer', id, requestId, decision, input),
  stop: (id, how) => ipcRenderer.invoke('ai:stop', id, how),
  onEvent: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
  /** V0α modules (store / trust / usage / git / probe) share one allow-listed invoke; main checks the sender. */
  call: (channel, ...args) => (/^(store|trust|usage|git|probe):[\w:.-]{1,60}$/.test(String(channel))
    ? ipcRenderer.invoke(String(channel), ...args)
    : Promise.reject(new Error('不允许的通道'))),
  /** The shell around the page: tray preferences, system notifications, commands from the tray menu. */
  app: {
    setPrefs: (prefs) => ipcRenderer.send('app:prefs', prefs),
    notify: (n) => ipcRenderer.send('app:notify', n),
    setBadge: (b) => ipcRenderer.send('app:badge', b),
    setTheme: (mode) => ipcRenderer.send('app:theme', mode),
    onVisibility: (fn) => { visibility.add(fn); return () => visibility.delete(fn); },
    onCovered: (fn) => { covered.add(fn); return () => covered.delete(fn); },
    /** 页面的第一帧准备好了：主进程此时才把窗口显示出来（只发不收；见 electron/main.cjs 的 app:frame-ready）. */
    frameReady: () => ipcRenderer.send('app:frame-ready'),
    /** 设置 › 外观 › 图形处理器：读偏好与正在用的显卡、改偏好（重启后生效）、立即重启. */
    gpu: (light) => ipcRenderer.invoke('app:gpu:get', light === true),
    setGpu: (pref) => ipcRenderer.invoke('app:gpu:set', pref),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    onCommand: (fn) => { commands.add(fn); return () => commands.delete(fn); },
  },
  /** The service registry (custom services, address overrides, pinned models, live model lists, local probe). The call() allow-list is NOT widened for it. */
  services: {
    list: () => ipcRenderer.invoke('svc:list'),
    save: (def) => ipcRenderer.invoke('svc:save', def),
    remove: (id) => ipcRenderer.invoke('svc:remove', id),
    setOverride: (id, endpoint, baseUrl) => ipcRenderer.invoke('svc:override', id, endpoint, baseUrl),
    pin: (id, model, on) => ipcRenderer.invoke('svc:pin', id, model, on),
    migrate: (req) => ipcRenderer.invoke('svc:migrate', req),
    models: (req) => ipcRenderer.invoke('svc:models', req),
    modelDetail: (req) => ipcRenderer.invoke('svc:model-detail', req),
    probeLocal: () => ipcRenderer.invoke('svc:probe-local'),
  },
  /** Command-line agents (ACP): probe, the official registry, user-added agents. The channels are registered by electron/ai/acp-agents.cjs. */
  acp: {
    probe: (req) => ipcRenderer.invoke('acp:probe', req),
    registry: (req) => ipcRenderer.invoke('acp:registry', req),
    addFromRegistry: (req) => ipcRenderer.invoke('acp:add-registry', req),
    pickExe: () => ipcRenderer.invoke('acp:pick-exe'),
    addCustom: (req) => ipcRenderer.invoke('acp:add-custom', req),
    remove: (id) => ipcRenderer.invoke('acp:remove', id),
  },
  browser: {
    open: () => ipcRenderer.invoke('browser:open'),
    clear: () => ipcRenderer.invoke('browser:clear'),
  },
  /** 桌宠（docs/PET-PLAN.md §2）：PetBridge in src/pet/contracts.ts, handled in electron/pet/index.cjs. The call() allow-list is NOT widened for it. */
  pet: {
    configure: (cfg) => ipcRenderer.send('pet:config', cfg),
    say: (line) => ipcRenderer.invoke('pet:say', line),
    frame: (opts) => ipcRenderer.invoke('pet:frame', opts),
    ocr: () => ipcRenderer.invoke('pet:ocr'),
    // opts.all: also the ready-made voices (by default only the ones the user designed; clones are never listed)
    voices: (provider, opts) => ipcRenderer.invoke('pet:tts:voices', provider, opts && typeof opts === 'object' ? { all: opts.all === true } : undefined),
    testVoice: (v) => ipcRenderer.invoke('pet:tts:test', v),
    ttsModels: (provider) => ipcRenderer.invoke('pet:tts:models', provider),
    saveTtsKey: (provider, key) => ipcRenderer.invoke('pet:tts:key', provider, key),
    clearTtsKey: (provider) => ipcRenderer.invoke('pet:tts:clear', provider),
    ttsKeys: () => ipcRenderer.invoke('pet:tts:keys'),
    realtime: (cmd) => ipcRenderer.invoke('pet:rt', cmd),
    gameState: (s) => ipcRenderer.send('pet:game-state', s),
    saveTale: (t) => ipcRenderer.invoke('pet:tale:save', t),
    onEvent: (fn) => { petListeners.add(fn); return () => petListeners.delete(fn); },
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    import: () => ipcRenderer.invoke('skills:import'),
    confirmImport: (token) => ipcRenderer.invoke('skills:import:confirm', token),
    create: (name) => ipcRenderer.invoke('skills:create', name),
    installExamples: () => ipcRenderer.invoke('skills:examples'),
    setEnabled: (folder, enabled) => ipcRenderer.invoke('skills:enable', folder, enabled),
    remove: (folder) => ipcRenderer.invoke('skills:remove', folder),
    open: (folder) => ipcRenderer.invoke('skills:open', folder),
  },
});
