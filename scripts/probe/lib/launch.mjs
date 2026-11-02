// 无头启动 Electron 应用并接上 CDP。
// 约束（施工图 §3.3）：不弹可见窗口。主进程在 ALIGHT_PROBE=1 时不显示窗口、不建托盘；用户数据目录必须是临时目录。
// 早期附着：连上浏览器级调试端点后用 Target.setAutoAttach(waitForDebuggerOnStart)，新页面在执行任何脚本之前被暂停，
// 我们先装好 init 脚本、控制台采集，再放行——这样既能测「进程创建到可输入」，也能在页面脚本运行前预置 localStorage。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { CdpConnection, waitForDebugger } from './cdp.mjs';
import { killTree, pidAlive } from './proc.mjs';

/** 临时文件根目录：环境变量 ALIGHT_PROBE_TMP 优先，默认系统临时目录下的 alight-probe。 */
export function tmpRoot() {
  const dir = process.env.ALIGHT_PROBE_TMP || path.join(os.tmpdir(), 'alight-probe');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

export function electronExe(appDir, explicit) {
  if (explicit) { if (!fs.existsSync(explicit)) throw new Error(`找不到 Electron：${explicit}`); return explicit; }
  const exe = path.join(appDir, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (!fs.existsSync(exe)) throw new Error(`找不到 Electron：${exe}`);
  return exe;
}

export function newUserDataDir(label = 'ud') {
  const dir = path.join(tmpRoot(), `${label}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* 被占用就留着，下次清 */ }
}

/** 干净的环境：去掉会让 Electron 当 Node 跑、或让应用读到真实账号凭据的变量。 */
function cleanEnv(extra, claudeConfigDir) {
  const env = { ...process.env, ...extra };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ELECTRON_ENABLE_LOGGING']) {
    if (!(k in extra)) delete env[k];
  }
  env.ALIGHT_PROBE = '1';
  if (!('CLAUDE_CONFIG_DIR' in extra)) env.CLAUDE_CONFIG_DIR = claudeConfigDir;
  return env;
}

/**
 * @typedef {object} LaunchOptions
 * @property {string} appDir            含 package.json 与 dist/ 的应用目录
 * @property {string} [userDataDir]     复用已有配置目录（默认新建临时目录）
 * @property {string[]} [init]          每个新文档开始前执行的脚本源码
 * @property {{width:number,height:number,deviceScaleFactor?:number}} [viewport]
 * @property {Record<string,string>} [env]
 * @property {string[]} [args]          额外的命令行参数
 * @property {boolean} [keepData]       结束后保留用户数据目录
 * @property {boolean} [network]        是否采集网络事件（失败请求）
 * @property {boolean} [inspectMain]    同时开主进程 Node 调试端口（取 app.getAppMetrics()）
 * @property {string} [label]
 * @property {string} [exePath]         指定 electron.exe（默认用 appDir/node_modules 里的）
 */

/** @param {LaunchOptions} opts */
export async function launchApp(opts) {
  const appDir = path.resolve(opts.appDir);
  const exe = electronExe(appDir, opts.exePath);
  const distIndex = path.join(appDir, 'dist', 'index.html');
  if (!fs.existsSync(distIndex)) throw new Error(`${distIndex} 不存在：先构建（集成者跑 vite build），或用 --app-dir 指向已构建的目录`);

  const ownsData = !opts.userDataDir;
  const userDataDir = opts.userDataDir ?? newUserDataDir(opts.label ?? 'ud');
  const claudeConfigDir = path.join(userDataDir, '..', `${path.basename(userDataDir)}-claude-config`);
  fs.mkdirSync(claudeConfigDir, { recursive: true });
  const port = await freePort();
  const inspectPort = opts.inspectMain ? await freePort() : 0;
  const args = [appDir, `--user-data-dir=${userDataDir}`, `--remote-debugging-port=${port}`, ...(inspectPort ? [`--inspect=${inspectPort}`] : []), ...(opts.args ?? [])];

  const t0Wall = Date.now();
  const t0Mono = performance.now();
  const child = spawn(exe, args, { cwd: appDir, env: cleanEnv(opts.env ?? {}, claudeConfigDir), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let exited = false;
  let exitInfo = null;
  const exitWaiters = [];
  child.on('exit', (code, signal) => { exited = true; exitInfo = { code, signal, atMs: performance.now() - t0Mono }; for (const w of exitWaiters.splice(0)) w(); });
  const stdout = [];
  const stderr = [];
  const keepTail = (arr, chunk) => { arr.push(chunk.toString('utf8')); if (arr.length > 400) arr.splice(0, arr.length - 400); };
  child.stdout.on('data', (c) => keepTail(stdout, c));
  child.stderr.on('data', (c) => keepTail(stderr, c));

  /** @type {{t:number, kind:string, level:string, text:string, url?:string}[]} */
  const consoleLog = [];
  const requestsFailed = [];

  const app = {
    pid: child.pid, port, inspectPort, userDataDir, appDir, t0Wall, t0Mono, child,
    consoleLog, requestsFailed, stdout, stderr,
    get exited() { return exited; },
    get exitInfo() { return exitInfo; },
    browser: /** @type {CdpConnection|null} */ (null),
    page: /** @type {import('./cdp.mjs').CdpSession|null} */ (null),
    pageTargetId: '',
    nowMs: () => performance.now() - t0Mono,
    /** 控制台里的错误（console.error、未捕获异常、Log 域 error 级、崩溃）。 */
    errors() { return consoleLog.filter((e) => e.level === 'error'); },
    async close(o) { return closeApp(app, { keepData: opts.keepData, ownsData, ...o }, exitWaiters); },
  };

  try {
    const ver = await waitForDebugger(port, { timeoutMs: 30000, shouldAbort: () => exited });
    app.cdpUpMs = app.nowMs();
    app.version = ver.Browser;
    const browser = await CdpConnection.connect(ver.webSocketDebuggerUrl);
    app.browser = browser;

    let resolvePage;
    const pageReady = new Promise((r) => { resolvePage = r; });
    const wired = new Set();

    const wirePage = async (sessionId, targetInfo, waiting) => {
      if (wired.has(sessionId)) return;
      wired.add(sessionId);
      const s = browser.session(sessionId);
      s.on('Runtime.consoleAPICalled', (p) => {
        const text = (p.args ?? []).map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type)).join(' ');
        consoleLog.push({ t: app.nowMs(), kind: 'console', level: p.type === 'error' ? 'error' : p.type === 'warning' ? 'warn' : 'info', text: text.slice(0, 1200) });
      });
      s.on('Runtime.exceptionThrown', (p) => {
        const d = p.exceptionDetails ?? {};
        consoleLog.push({ t: app.nowMs(), kind: 'exception', level: 'error', text: `${d.exception?.description ?? d.text ?? '未捕获异常'}`.slice(0, 1200), url: d.url });
      });
      s.on('Log.entryAdded', (p) => {
        const e = p.entry ?? {};
        consoleLog.push({ t: app.nowMs(), kind: `log:${e.source}`, level: e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : 'info', text: String(e.text ?? '').slice(0, 1200), url: e.url });
      });
      s.on('Inspector.targetCrashed', () => consoleLog.push({ t: app.nowMs(), kind: 'crash', level: 'error', text: '渲染进程崩溃（Inspector.targetCrashed）' }));
      if (opts.network) {
        s.on('Network.loadingFailed', (p) => requestsFailed.push({ t: app.nowMs(), id: p.requestId, error: p.errorText, canceled: !!p.canceled, blocked: p.blockedReason }));
      }
      const inits = (opts.init ?? []).map((src, i) => `(() => { const k = '__probeInit${i}'; if (globalThis[k]) return; globalThis[k] = 1; ${src}
})();`);
      // 当前正在加载的第一个文档（窗口早在调试端口就绪前后就开始加载了）在它的执行上下文一创建就立刻补跑 init 脚本；
      // 监听必须先于 Runtime.enable（enable 会把已存在的上下文重放一遍）。脚本自带幂等保护，两条路径撞上也只跑一次。
      if (inits.length) {
        s.on('Runtime.executionContextCreated', (p) => {
          const ctx = p.context;
          if (!app.firstContextMs) app.firstContextMs = app.nowMs();
          if (!ctx.auxData?.isDefault || !String(ctx.origin).startsWith('file:')) return;
          for (const expression of inits) s.send('Runtime.evaluate', { expression, contextId: ctx.id, silent: true }).catch(() => {});
        });
      }
      const steps = [
        s.send('Runtime.enable'), s.send('Log.enable'), s.send('Page.enable'), s.send('Inspector.enable').catch(() => {}),
        // 隐藏窗口里页面没有系统焦点：模拟「已获焦点」，否则 focus() 与 :focus 样式不生效
        s.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      ];
      if (opts.network) steps.push(s.send('Network.enable'));
      if (opts.viewport) {
        steps.push(s.send('Emulation.setDeviceMetricsOverride', { width: opts.viewport.width, height: opts.viewport.height, deviceScaleFactor: opts.viewport.deviceScaleFactor ?? 1, mobile: false }));
      }
      await Promise.all(steps);
      for (const source of inits) await s.send('Page.addScriptToEvaluateOnNewDocument', { source });
      app.page = s;
      app.pageTargetId = targetInfo.targetId;
      app.pageAttachedMs = app.nowMs();
      if (waiting) await s.send('Runtime.runIfWaitingForDebugger');
      resolvePage(s);
    };

    browser.on('Target.attachedToTarget', (p) => {
      const info = p.targetInfo ?? {};
      const isMainPage = info.type === 'page' && !String(info.url).startsWith('devtools://') && !app.page;
      if (isMainPage) wirePage(p.sessionId, info, p.waitingForDebugger).catch((e) => consoleLog.push({ t: app.nowMs(), kind: 'probe', level: 'error', text: `接管页面失败：${e.message}` }));
      else if (p.waitingForDebugger) browser.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId).catch(() => {});
    });
    await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    // 页面可能已经存在（连得比窗口创建晚）：补接
    const { targetInfos } = await browser.send('Target.getTargets');
    for (const t of targetInfos) {
      if (t.type === 'page' && !t.attached && !app.page) {
        const { sessionId } = await browser.send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
        await wirePage(sessionId, t, false);
      }
    }
    await Promise.race([
      pageReady,
      new Promise((_, rej) => setTimeout(() => rej(new Error('30 秒内没有出现页面目标')), 30000)),
      new Promise((_, rej) => { exitWaiters.push(() => rej(new Error(`应用在页面出现前退出（code=${exitInfo?.code}）\n${stderr.join('').slice(-800)}`))); }),
    ]);
    return app;
  } catch (e) {
    const tail = stderr.join('').trim().slice(-600);
    await app.close({ quick: true }).catch(() => {});
    throw new Error(`${e.message}${tail ? `\n[stderr] ${tail}` : ''}`);
  }
}

async function closeApp(app, { keepData, ownsData, quick, graceMs = 2500 }, exitWaiters) {
  if (app._closing) return app._closing;
  app._closing = (async () => {
    const waitExit = (ms) => (app.exited ? Promise.resolve(true) : new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), ms);
      exitWaiters.push(() => { clearTimeout(timer); resolve(true); });
    }));
    if (!app.exited && !quick && app.browser && !app.browser.closed) {
      // 先礼：Browser.close 关掉窗口；主进程在探针模式下会随之退出，没退出就结束进程树
      try { await Promise.race([app.browser.send('Browser.close'), new Promise((r) => setTimeout(r, 800))]); } catch { /* 连接已断 */ }
      await waitExit(graceMs);
    }
    try { app.browser?.close(); } catch { /* */ }
    let forced = false;
    if (!app.exited || pidAlive(app.pid)) { forced = true; killTree(app.pid); await waitExit(4000); }
    // 孩子进程残留检查：根进程已死，但树里的其他进程可能还在，再杀一次树（根 pid 不在了 taskkill 会失败，无害）
    const residual = pidAlive(app.pid);
    if (ownsData && !keepData) {
      await new Promise((r) => setTimeout(r, 300));
      removeDir(app.userDataDir);
      removeDir(path.join(app.userDataDir, '..', `${path.basename(app.userDataDir)}-claude-config`));
    }
    return { forced, residual, exitInfo: app.exitInfo };
  })();
  return app._closing;
}

/** 让页面里的脚本在第一个文档开始前写入 localStorage（只在缺省时写，避免覆盖应用自己保存的值）。 */
export function seedLocalStorageScript(entries) {
  const json = JSON.stringify(entries);
  return `(() => { try { const e = ${json}; for (const k of Object.keys(e)) { if (localStorage.getItem(k) === null) localStorage.setItem(k, e[k]); } } catch (err) { console.error('probe seed failed', err); } })();`;
}
