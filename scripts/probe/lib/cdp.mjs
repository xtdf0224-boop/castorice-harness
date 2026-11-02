// 极简 Chrome DevTools Protocol 客户端：只用 Node 自带的 fetch / WebSocket，不装依赖。
// 一个 CdpConnection 对应一条 WebSocket（浏览器级或页面级）；用 flatten 模式时，一条连接上可以挂多个 sessionId。

export class CdpError extends Error {
  constructor(method, error) {
    super(`CDP ${method} 失败：${error.message ?? JSON.stringify(error)}${error.data ? `（${error.data}）` : ''}`);
    this.code = error.code;
    this.method = method;
  }
}

export class CdpConnection {
  /** @param {WebSocket} ws */
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    /** @type {Map<number, {resolve:Function, reject:Function, method:string}>} */
    this.pending = new Map();
    /** @type {Map<string, Set<Function>>} key = `${sessionId||''}|${method}` */
    this.handlers = new Map();
    this.closed = false;
    this.closeWaiters = [];
    ws.addEventListener('message', (ev) => this.#onMessage(ev));
    ws.addEventListener('close', () => this.#onClose());
    ws.addEventListener('error', () => { /* close 事件会跟着来 */ });
  }

  static connect(url, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { try { ws.close(); } catch { /* */ } reject(new Error(`连接 ${url} 超时`)); }, timeoutMs);
      ws.addEventListener('open', () => { clearTimeout(timer); resolve(new CdpConnection(ws)); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`连接 ${url} 失败`)); }, { once: true });
    });
  }

  #onMessage(ev) {
    let msg;
    try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); } catch { return; }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(p.method, msg.error));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    const set = this.handlers.get(`${msg.sessionId ?? ''}|${msg.method}`);
    if (set) for (const h of [...set]) { try { h(msg.params ?? {}, msg.sessionId); } catch (e) { console.error('[cdp handler]', e); } }
    const any = this.handlers.get(`${msg.sessionId ?? ''}|*`);
    if (any) for (const h of [...any]) { try { h(msg.method, msg.params ?? {}); } catch (e) { console.error('[cdp handler]', e); } }
  }

  #onClose() {
    this.closed = true;
    for (const [, p] of this.pending) p.reject(new Error(`CDP 连接已关闭（等待 ${p.method} 时）`));
    this.pending.clear();
    for (const w of this.closeWaiters) w();
    this.closeWaiters = [];
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error(`CDP 连接已关闭（${method}）`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      try { this.ws.send(JSON.stringify(payload)); } catch (e) { this.pending.delete(id); reject(e); }
    });
  }

  /** 订阅事件；返回取消订阅函数。method 为 '*' 时收到 (method, params)。 */
  on(method, handler, sessionId) {
    const key = `${sessionId ?? ''}|${method}`;
    let set = this.handlers.get(key);
    if (!set) this.handlers.set(key, (set = new Set()));
    set.add(handler);
    return () => set.delete(handler);
  }

  /** 等一个事件（可带过滤）；超时抛错。 */
  waitFor(method, { sessionId, filter, timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params) => {
        if (filter && !filter(params)) return;
        clearTimeout(timer);
        off();
        resolve(params);
      }, sessionId);
      const timer = setTimeout(() => { off(); reject(new Error(`等待 CDP 事件 ${method} 超时（${timeoutMs} ms）`)); }, timeoutMs);
    });
  }

  waitClosed(timeoutMs) {
    if (this.closed) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      this.closeWaiters.push(() => { clearTimeout(timer); resolve(true); });
    });
  }

  close() {
    try { this.ws.close(); } catch { /* */ }
  }

  /** 绑定一个 sessionId，得到只管这个目标的小接口。 */
  session(sessionId) {
    return new CdpSession(this, sessionId);
  }
}

export class CdpSession {
  constructor(conn, sessionId) {
    this.conn = conn;
    this.sessionId = sessionId;
  }
  send(method, params = {}) { return this.conn.send(method, params, this.sessionId); }
  on(method, handler) { return this.conn.on(method, handler, this.sessionId); }
  waitFor(method, opts = {}) { return this.conn.waitFor(method, { ...opts, sessionId: this.sessionId }); }
}

/** 轮询 http://127.0.0.1:port/json/version，直到调试端口起来。 */
export async function waitForDebugger(port, { timeoutMs = 30000, intervalMs = 15, shouldAbort } = {}) {
  const deadline = performance.now() + timeoutMs;
  let lastErr;
  while (performance.now() < deadline) {
    if (shouldAbort && shouldAbort()) throw new Error('应用在调试端口就绪前退出了');
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
      if (res.ok) return await res.json();
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`调试端口 ${port} 在 ${timeoutMs} ms 内没有就绪：${lastErr?.message ?? ''}`);
}
