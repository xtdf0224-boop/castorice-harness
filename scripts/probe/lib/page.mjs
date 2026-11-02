// 页面侧的小工具：求值、等待、键盘、输入法、截图、「可输入」探测脚本。全部基于一个 CdpSession（页面目标）。
import fs from 'node:fs';
import path from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

/** Runtime.evaluate，返回值按 JSON 取回；脚本抛错时抛出带描述的异常。 */
export async function evaluate(s, expression, { awaitPromise = true, userGesture = true } = {}) {
  const r = await s.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true, userGesture });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error(`页面脚本出错：${d.exception?.description ?? d.exception?.value ?? d.text}`);
  }
  return r.result.value;
}

/** 轮询直到表达式为真值；返回最后一次的值。 */
export async function waitUntil(s, expression, { timeoutMs = 15000, intervalMs = 40, label = expression.slice(0, 60) } = {}) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    try { last = await evaluate(s, expression); } catch { last = undefined; }
    if (last) return last;
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutMs} ms）：${label}`);
}

export async function screenshot(s, file, { clip, format = 'png' } = {}) {
  // 隐藏窗口的合成器偶尔会停帧，captureScreenshot 一等就是 10 分钟：每次最多等 25 秒，超时就戳一下页面再要一次（最多 8 次）。
  let r;
  for (let attempt = 0; ; attempt++) {
    const req = s.send('Page.captureScreenshot', { format, fromSurface: true, captureBeyondViewport: false, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
    req.catch(() => {});
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 25000); });
    r = await Promise.race([req, timeout]);
    clearTimeout(timer);
    if (r) break;
    if (attempt >= 7) throw new Error('Page.captureScreenshot 连续 8 次超时（隐藏窗口停帧）');
    try { await s.send('Runtime.evaluate', { expression: "document.documentElement.style.setProperty('--probe-kick', String(Math.random())); void document.body.offsetHeight; new Promise((res) => requestAnimationFrame(() => res(1)))", awaitPromise: false }); } catch { /* */ }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
}

/* ───────────── 键盘 ───────────── */

const MOD = { alt: 1, ctrl: 2, meta: 4, shift: 8 };
export const modBits = (mods = []) => mods.reduce((a, m) => a | MOD[m], 0);

/** 常用按键 → CDP 参数。 */
const KEYS = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  ' ': { key: ' ', code: 'Space', vk: 32, text: ' ' },
};

function keyInfo(name) {
  if (KEYS[name]) return KEYS[name];
  if (/^[0-9]$/.test(name)) return { key: name, code: `Digit${name}`, vk: name.charCodeAt(0), text: name };
  if (/^[a-z]$/i.test(name)) return { key: name, code: `Key${name.toUpperCase()}`, vk: name.toUpperCase().charCodeAt(0), text: name };
  if (name === '`') return { key: '`', code: 'Backquote', vk: 192, text: '`' };
  if (/^F([1-9]|1[0-2])$/.test(name)) return { key: name, code: name, vk: 111 + Number(name.slice(1)) };
  throw new Error(`未登记的按键：${name}`);
}

/** 一次完整按键（keyDown → keyUp）。带 text 的键会产生 keypress 与默认行为（Enter 在 textarea 里换行、字符被输入）。
 *  返回 keyDown 的 CDP 往返毫秒数：渲染进程处理完输入事件才会应答，所以它＝输入排队延迟＋事件处理耗时（不含出帧；隐藏窗口不出帧）。 */
export async function pressKey(s, name, { mods = [], holdMs = 0 } = {}) {
  const k = keyInfo(name);
  const modifiers = modBits(mods);
  // 带 Ctrl/Alt/Meta 的组合键不产生字符
  const printable = k.text && !(modifiers & (MOD.ctrl | MOD.alt | MOD.meta));
  const t0 = performance.now();
  await s.send('Input.dispatchKeyEvent', {
    type: printable ? 'keyDown' : 'rawKeyDown', modifiers, key: k.key, code: k.code,
    windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, ...(printable ? { text: k.text, unmodifiedText: k.text } : {}),
  });
  const roundtripMs = performance.now() - t0;
  if (holdMs) await sleep(holdMs);
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk });
  return roundtripMs;
}

/** 逐字按键输入 ASCII（走真正的 keydown/keypress/input 链）；非 ASCII 用 insertText。 */
export async function typeText(s, text, { delayMs = 0 } = {}) {
  for (const ch of text) {
    if (/^[\x20-\x7e]$/.test(ch)) await pressKey(s, ch === ' ' ? ' ' : ch);
    else await s.send('Input.insertText', { text: ch });
    if (delayMs) await sleep(delayMs);
  }
}

/* ───────────── 输入法（CDP 的 Input.imeSetComposition / Input.insertText）─────────────
   Chromium 的 imeSetComposition 走和真实输入法同一条 WebInputMethodController 路径：会发 compositionstart/update、
   beforeinput/input(inputType=insertCompositionText)，并让 InputMethodController 处于「组合中」，之后 keydown 的 isComposing 为 true。
   Input.insertText 在组合中等于「提交」（ImeCommitText），触发 compositionend。没有单独的 imeCommitComposition。 */

export const ime = {
  async compose(s, text, { start = text.length, end = text.length } = {}) {
    await s.send('Input.imeSetComposition', { text, selectionStart: start, selectionEnd: end });
  },
  /** 提交：把组合文本替换成最终文字（可以和组合文本不同，比如拼音 ni → 你）。 */
  async commit(s, text) { await s.send('Input.insertText', { text }); },
  /** 取消组合（空串）。 */
  async cancel(s) { await s.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); },
  /**
   * 输入法接管的按键：Windows 上 TSF 输入法吞掉的键，浏览器收到 keyCode 229（VK_PROCESSKEY）、key="Process"；
   * code 保留物理键（Enter、Escape…）。composing 由 Blink 按当前是否在组合中自己填。
   */
  async processKey(s, code = 'Enter') {
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Process', code, windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  },
  async processKeyUp(s, code = 'Enter') {
    const vk = { Enter: 13, Escape: 27, Space: 32 }[code] ?? 0;
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: code === 'Space' ? ' ' : code, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
  },
  /**
   * 在输入法场景下按 Enter / Escape，三种「线上可能出现的形态」（见 research/08-补充-3 §5.2 与 MDN keydown 说明）：
   *   A  Chromium＋Windows TSF 的实测形态：key="Process"、keyCode=229、isComposing=true（组合中）
   *   B  输入法把 Enter/Esc 本身放行：key="Enter"/"Escape"、keyCode=13/27，组合中 Blink 填 isComposing=true
   *   C  compositionend 先于 keydown（先 commit 再调用）：key="Enter"/"Escape"、keyCode=229、isComposing=false
   * 返回这次 keydown 的 CDP 往返毫秒数。
   */
  async key(s, name, variant = 'A') {
    const vk = { Enter: 13, Escape: 27 }[name];
    const spec = {
      A: { key: 'Process', windowsVirtualKeyCode: 229 },
      B: { key: name, windowsVirtualKeyCode: vk },
      C: { key: name, windowsVirtualKeyCode: 229 },
    }[variant];
    if (!spec || !vk) throw new Error(`ime.key：不认识的参数 ${name}/${variant}`);
    const t0 = performance.now();
    await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: name, nativeVirtualKeyCode: spec.windowsVirtualKeyCode, ...spec });
    const ms = performance.now() - t0;
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk });
    return ms;
  },
};

/** 在页面里装一个事件记录器（捕获阶段，window 上），测完用 readLog 取回。 */
export const EVENT_LOGGER_SOURCE = `
(() => {
  if (window.__evlog) { window.__evlog.length = 0; return; }
  const log = (window.__evlog = []);
  const t0 = performance.now();
  const pick = (e) => {
    const t = e.target;
    const o = { t: Math.round((performance.now() - t0) * 10) / 10, type: e.type };
    if (e.type.startsWith('key')) Object.assign(o, { key: e.key, code: e.code, keyCode: e.keyCode, isComposing: e.isComposing, defaultPrevented: undefined });
    if (e.type.startsWith('composition')) o.data = e.data;
    if (e.type === 'beforeinput' || e.type === 'input') Object.assign(o, { inputType: e.inputType, data: e.data, isComposing: e.isComposing });
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT')) { o.value = t.value; o.tag = t.tagName; }
    return o;
  };
  const types = ['keydown', 'keyup', 'keypress', 'compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input'];
  for (const type of types) {
    window.addEventListener(type, (e) => {
      const o = pick(e);
      log.push(o);
      // 记下 keydown 之后是否被应用 preventDefault（冒泡阶段末尾再看）
      if (type === 'keydown') setTimeout(() => { o.defaultPrevented = e.defaultPrevented; }, 0);
    }, true);
  }
})();
`;

export async function installEventLogger(s) { await evaluate(s, EVENT_LOGGER_SOURCE); }
export async function readEventLog(s) { return JSON.parse(await evaluate(s, 'JSON.stringify(window.__evlog || [])')); }
export async function clearEventLog(s) { await evaluate(s, 'window.__evlog && (window.__evlog.length = 0), true'); }

/* ───────────── 「可输入」探测 ───────────── */

/**
 * 页面里的就绪探测器：输入框出现、可见、不在 inert 子树里、没被禁用，就记一个 inputReady 时间戳。
 * 所有时间戳是 performance.now()（相对页面导航起点），配合 performance.timeOrigin 换算成 epoch 毫秒。
 */
export function readyProbeSource(selector) {
  return `
  const P = (globalThis.__probe = globalThis.__probe || { marks: {} });
  P.origin = performance.timeOrigin;
  const mark = (n) => { if (!(n in P.marks)) P.marks[n] = performance.now(); };
  const SEL = ${JSON.stringify(selector)};
  let done = false;
  const check = () => {
    if (done) return;
    const el = document.querySelector(SEL);
    if (!el) return;
    mark('inputPresent');
    if (el.matches(':disabled') || el.readOnly || el.closest('[inert]') || el.getClientRects().length === 0 || getComputedStyle(el).visibility === 'hidden') return;
    mark('inputReady');
    done = true;
    mo.disconnect();
    clearInterval(iv);
  };
  const mo = new MutationObserver(check);
  mo.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['inert', 'disabled', 'hidden', 'style', 'class', 'data-boot'] });
  const iv = setInterval(check, 4);
  document.addEventListener('DOMContentLoaded', () => mark('domContentLoaded'), { once: true });
  addEventListener('load', () => mark('load'), { once: true });
  try {
    new PerformanceObserver((list) => { for (const e of list.getEntries()) mark(e.name === 'first-contentful-paint' ? 'fcp' : e.name === 'first-paint' ? 'fp' : e.entryType); }).observe({ type: 'paint', buffered: true });
  } catch { /* 不支持就算了 */ }
  check();
  `;
}

export async function readProbe(s) {
  return JSON.parse(await evaluate(s, 'JSON.stringify(globalThis.__probe || null)'));
}

/* ───────────── 鼠标与按文字找控件 ───────────── */

export async function mouseClick(s, x, y, { button = 'left', clickCount = 1 } = {}) {
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, buttons: button === 'left' ? 1 : 2 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
}

/** 在页面里找「文字包含 text 的最里层可点击元素」，返回中心点与描述；找不到返回 null。 */
export async function findClickable(s, text, { within = 'body', selector = 'button, a, [role=button], [role=tab], [role=menuitem], summary, label' } = {}) {
  return evaluate(s, `(() => {
    const root = document.querySelector(${JSON.stringify(within)});
    if (!root) return null;
    const want = ${JSON.stringify(text)};
    const all = [...root.querySelectorAll(${JSON.stringify(selector)})];
    // 先按可见文字匹配；没有文字命中才退到 aria-label / title（否则「删除 XXX」的图标按钮会被当成 XXX）
    let cands = all.filter((e) => (e.textContent || '').includes(want));
    if (!cands.length) cands = all.filter((e) => (e.getAttribute('aria-label') || '').includes(want) || (e.title || '').includes(want));
    // 最里层优先（按文字长度最短）
    cands.sort((a, b) => (a.textContent || '').length - (b.textContent || '').length);
    for (const e of cands) {
      e.scrollIntoView({ block: 'center', inline: 'center' });
      const r = e.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), tag: e.tagName, cls: String(e.className).slice(0, 60), text: (e.textContent || '').trim().slice(0, 40) };
    }
    return null;
  })()`);
}

export async function clickText(s, text, opts = {}) {
  const hit = await findClickable(s, text, opts);
  if (!hit) throw new Error(`找不到可点击的「${text}」`);
  await mouseClick(s, hit.x, hit.y);
  return hit;
}

export async function clickSelector(s, selector) {
  const hit = await evaluate(s, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  if (!hit) throw new Error(`找不到元素：${selector}`);
  await mouseClick(s, hit.x, hit.y);
  return hit;
}

/** 让某个元素获得焦点（用 DOM focus，配合 Emulation.setFocusEmulationEnabled，隐藏窗口里也生效）。 */
export async function focusSelector(s, selector) {
  const ok = await evaluate(s, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) return false; e.focus({ preventScroll: true }); return document.activeElement === e; })()`);
  if (!ok) throw new Error(`无法聚焦：${selector}`);
}

/* ───────────── 页面性能探针（S3/S4）───────────── */

/**
 * 心跳 + longtask：看主线程被占住多久（lastBusyEnd ＝ 最近一次卡顿结束的时刻，用来判断「打开后多久才安静」）。
 * 不用 PerformanceEventTiming：窗口不可见时没有出帧，事件计时要等「呈现」，隐藏窗口里拿不到。
 */
export const PERF_PROBE_SOURCE = `
(() => {
  const P = (globalThis.__perf = { gaps: [], long: [], heartbeat: 0, lastBusyEnd: 0 });
  let last = performance.now();
  setInterval(() => { const n = performance.now(); const gap = n - last; last = n; P.heartbeat++; if (gap > 150) { P.gaps.push({ at: Math.round(n), gap: Math.round(gap) }); P.lastBusyEnd = Math.max(P.lastBusyEnd, n); } }, 50);
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { P.long.push({ at: Math.round(e.startTime), d: Math.round(e.duration) }); P.lastBusyEnd = Math.max(P.lastBusyEnd, e.startTime + e.duration); } }).observe({ type: 'longtask', buffered: true }); } catch {}
})();
`;

export async function readPerf(s) {
  return JSON.parse(await evaluate(s, `JSON.stringify(globalThis.__perf || null)`));
}
