/* 无头 Chrome 的一个小型 CDP 客户端（模型接入页的界面检查与截图用）。
   不装 puppeteer：Chrome 以 --headless=new 启动（不会有任何可见窗口），Node 自带的全局 WebSocket 说 CDP。
   用法见 scripts/smoke/ui/models-ui.mjs. 临时用户目录由调用者给（放临时文件夹，用完删）。 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

export const CHROME_CANDIDATES = [
  process.env.ALIGHT_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('找不到 Chrome 或 Edge（可用环境变量 ALIGHT_CHROME 指定）');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{ userDataDir: string, port?: number, width?: number, height?: number, scale?: number, colorScheme?: 'dark'|'light' }} o
 */
export async function launchChrome(o) {
  const port = o.port ?? 9347;
  const args = [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${o.userDataDir}`,
    `--window-size=${o.width ?? 1440},${o.height ?? 960}`, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check',
    '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--mute-audio',
    `--force-device-scale-factor=${o.scale ?? 1}`, 'about:blank',
  ];
  const child = spawn(findChrome(), args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  child.on('exit', () => { exited = true; });
  let version;
  for (let i = 0; i < 80; i++) {
    try { version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await sleep(150); }
    if (exited) throw new Error('Chrome 启动后立刻退出了');
  }
  if (!version) { child.kill(); throw new Error('连不上 Chrome 的调试端口'); }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page') ?? targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP 连接失败')); });
  let id = 0;
  const waiting = new Map();
  const listeners = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && waiting.has(msg.id)) {
      const w = waiting.get(msg.id);
      waiting.delete(msg.id);
      if (msg.error) w.rej(new Error(`${w.method}: ${msg.error.message}`)); else w.res(msg.result);
    } else if (msg.method) for (const l of listeners) l(msg);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; waiting.set(i, { res, rej, method }); ws.send(JSON.stringify({ id: i, method, params })); });

  const consoleLog = [];
  listeners.push((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') consoleLog.push({ type: msg.params.type, text: msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ') });
    if (msg.method === 'Runtime.exceptionThrown') consoleLog.push({ type: 'exception', text: msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text });
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('DOM.enable');
  if (o.colorScheme) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.colorScheme }] });

  const api = {
    send, consoleLog, child,
    async init(script) { await send('Page.addScriptToEvaluateOnNewDocument', { source: script }); },
    async goto(url, waitFor) {
      await send('Page.navigate', { url });
      if (waitFor) await api.waitFor(waitFor, 20000);
      else await sleep(500);
    },
    /** Evaluate in the page; returns the (JSON) value. Throws on exceptions. */
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async waitFor(expr, timeout = 8000) {
      const t0 = Date.now();
      for (;;) {
        let v = false;
        try { v = await api.eval(expr); } catch { v = false; }
        if (v) return v;
        if (Date.now() - t0 > timeout) throw new Error(`等待超时：${expr}`);
        await sleep(100);
      }
    },
    sleep,
    async screenshot(file, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    },
    /** A full-width capture of the whole scrollable page (the app scrolls inside .view, so we resize the viewport instead). */
    async setViewport(width, height, scale = 1) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    },
    async rect(selector) {
      return api.eval(`(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    },
    async click(selector) {
      const r = await api.rect(selector);
      if (!r) throw new Error(`找不到 ${selector}`);
      await api.clickAt(r.x + r.w / 2, r.y + r.h / 2);
    },
    async clickAt(x, y) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    },
    /** Real click on the element an expression evaluates to (scrolled into view first), e.g. clickEl(`document.querySelector('.x')`). */
    async clickEl(expr) {
      const r = await api.eval(`(() => { const e = (${expr}); if (!e) return null; e.scrollIntoView({ block: 'center', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      if (!r) throw new Error(`找不到可点的元素：${expr}`);
      await api.sleep(60);
      const r2 = await api.eval(`(() => { const e = (${expr}); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await api.clickAt(r2.x, r2.y);
    },
    async count(selector) { return api.eval(`document.querySelectorAll(${JSON.stringify(selector)}).length`); },
    async text(selector) { return api.eval(`(document.querySelector(${JSON.stringify(selector)}) || {}).textContent || ''`); },
    async focus(selector) { await api.eval(`document.querySelector(${JSON.stringify(selector)})?.focus()`); },
    async type(text) { await send('Input.insertText', { text }); },
    /** Real key presses (keydown/keyup), e.g. key('Enter'), key('ArrowDown'). */
    async key(key, opts = {}) {
      const map = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, Tab: 9, Backspace: 8 };
      const code = map[key] ?? 0;
      const base = { key, code: key, windowsVirtualKeyCode: opts.keyCode ?? code, nativeVirtualKeyCode: opts.keyCode ?? code };
      await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base, ...(key === 'Enter' ? { text: '\r' } : {}) });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    },
    /** The text the IME is composing (underlined candidates); commit with imeCommit. */
    async imeSetComposition(text) { await send('Input.imeSetComposition', { text, selectionStart: text.length, selectionEnd: text.length }); },
    async imeCommit(text) { await send('Input.insertText', { text }); },
    async close() { try { ws.close(); } catch { /* gone */ } child.kill(); await sleep(200); },
  };
  return api;
}
