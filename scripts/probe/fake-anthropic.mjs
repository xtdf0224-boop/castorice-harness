#!/usr/bin/env node
// 本机假 Anthropic Messages 服务：只监听 127.0.0.1，SSE 流式，可脚本化返回文本、思考、tool_use、AskUserQuestion、ExitPlanMode、usage，
// 也能模拟 HTTP 错误、限流头、卡住不回、半路断流。供无头 E2E 与钩子探针用——测试不花用户的额度，也不碰真实账号。
//
// 用法（代码里）：
//   import { startFakeAnthropic, reply, toolUse, askUserQuestion, exitPlanMode } from './fake-anthropic.mjs';
//   const fake = await startFakeAnthropic({ script: [toolUse('Bash', { command: 'echo hi' }), reply('已完成')] });
//   // 让应用把 ANTHROPIC_BASE_URL / 设置里的服务地址指向 fake.baseUrl；密钥随便填
//   await fake.waitForRequests(2); console.log(fake.requests.map((r) => r.lastUserText));
//   await fake.close();
// 用法（命令行）：node scripts/probe/fake-anthropic.mjs [--port 8787] [--selftest]
//
// 脚本 script：数组，第 n 个 POST /v1/messages 吃掉第 n 项；用完后重复最后一项的「默认回复」。每一项是：
//   - 一个 turn 对象（见 reply/toolUse/...），或
//   - 函数 (req, n) => turn（可按请求内容决定回什么；req.lastUserText / req.toolResults 方便判断）。
// turn 字段：blocks[]（text/thinking/tool_use）、stopReason、usage、delayMs（首字节前等待）、tokenDelayMs（块间等待）、
//   chunkChars（每块字数）、status（返回 HTTP 错误）、error（错误体）、headers（额外响应头，如限流头）、hang（接上就不回）、dropAfterBlocks（发 N 块后掐断连接）。
import http from 'node:http';
import { randomBytes } from 'node:crypto';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const id = (prefix) => `${prefix}_${randomBytes(12).toString('hex')}`;

/* ───────────── 脚本积木 ───────────── */

/** 一段文字回复（end_turn）。 */
export function reply(text, extra = {}) {
  return { blocks: [{ type: 'text', text }], stopReason: 'end_turn', ...extra };
}
/** 按系统提示里的话量块（「【话量：少|中|多】」）返回不同长度的回复（T 加；验收探针用：话量三档的回复不能是同一句，不然「少档短而仍是她」没有证据）.
 *  用法：fake.reset([], byLevel({ s: '嗯。', m: '嗯……我看过了。', l: '嗯……我从头看了一遍，……' })) —— 作为默认回复或脚本项（函数项会收到请求摘要）.
 *  system 里没有话量块（口吻关 / 非她的回合）时取 m. */
export function byLevel(map, extra = {}) {
  const key = { 少: 's', 中: 'm', 多: 'l' };
  return (req) => reply(map[key[/【话量：(少|中|多)】/.exec(req.system ?? '')?.[1]] ?? 'm'] ?? map.m, extra);
}
/** 先思考再回复。 */
export function thinkThenReply(thinking, text, extra = {}) {
  return { blocks: [{ type: 'thinking', thinking }, { type: 'text', text }], stopReason: 'end_turn', ...extra };
}
/** 请求调用一个工具（stop_reason=tool_use）。客户端执行后会带着 tool_result 再来一次。 */
export function toolUse(name, input, { text, toolId, ...extra } = {}) {
  const blocks = [];
  if (text) blocks.push({ type: 'text', text });
  blocks.push({ type: 'tool_use', id: toolId ?? id('toolu'), name, input });
  return { blocks, stopReason: 'tool_use', ...extra };
}
/** Claude Code 的 AskUserQuestion：questions = [{ question, header, options:[{label,description}], multiSelect }] */
export function askUserQuestion(questions, extra = {}) {
  return toolUse('AskUserQuestion', { questions }, extra);
}
/** 计划模式收尾：ExitPlanMode（plan 是 Markdown 文本）。 */
export function exitPlanMode(plan, extra = {}) {
  return toolUse('ExitPlanMode', { plan }, extra);
}
/** 返回 HTTP 错误（429 限流、529 过载、401 密钥无效……）。 */
export function httpError(status, message = '模拟错误', type = 'api_error', extra = {}) {
  return { status, error: { type: 'error', error: { type, message } }, ...extra };
}
/** 限流头（Claude Code / Agent SDK 会据此产生 rate_limit 事件）。 */
export function rateLimitHeaders({ status = 'allowed_warning', utilization = 0.85, resetsInSec = 3600, claim = 'five_hour' } = {}) {
  const reset = Math.floor(Date.now() / 1000) + resetsInSec;
  return {
    'anthropic-ratelimit-unified-status': status,
    'anthropic-ratelimit-unified-reset': String(reset),
    'anthropic-ratelimit-unified-representative-claim': claim,
    [`anthropic-ratelimit-unified-${claim.replace(/_/g, '-')}-utilization`]: String(utilization),
    [`anthropic-ratelimit-unified-${claim.replace(/_/g, '-')}-reset`]: String(reset),
    [`anthropic-ratelimit-unified-${claim.replace(/_/g, '-')}-status`]: status,
  };
}

/* ───────────── 请求解析 ───────────── */

const textOf = (content) => (typeof content === 'string' ? content
  : Array.isArray(content) ? content.map((b) => (b.type === 'text' ? b.text : b.type === 'tool_result' ? textOf(b.content) : '')).join('') : '');

function summarizeRequest(n, method, url, headers, body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
  const toolResults = [];
  for (const m of msgs) {
    if (m.role === 'user' && Array.isArray(m.content)) {
      for (const b of m.content) if (b.type === 'tool_result') toolResults.push({ toolUseId: b.tool_use_id, isError: !!b.is_error, text: textOf(b.content).slice(0, 2000) });
    }
  }
  const key = String(headers['x-api-key'] ?? '').length ? 'x-api-key' : headers.authorization ? 'authorization' : '';
  return {
    n, at: Date.now(), method, path: url, stream: !!body?.stream, model: body?.model,
    system: typeof body?.system === 'string' ? body.system : Array.isArray(body?.system) ? body.system.map((b) => b.text ?? '').join('\n') : '',
    messageCount: msgs.length,
    lastUserText: lastUser ? textOf(lastUser.content) : '',
    toolResults,
    tools: Array.isArray(body?.tools) ? body.tools.map((t) => t.name) : [],
    maxTokens: body?.max_tokens, thinking: body?.thinking, hasKey: !!key, keyHeader: key,
    userAgent: headers['user-agent'], aborted: false, body,
  };
}

const estimateTokens = (s) => Math.max(1, Math.ceil(String(s).length / 3));

/* ───────────── 服务 ───────────── */

/**
 * @param {{ port?: number, host?: string, script?: Array<object|Function>, model?: string, tokenDelayMs?: number, chunkChars?: number, strictKey?: boolean, log?: (s:string)=>void }} [opts]
 */
export async function startFakeAnthropic(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const state = {
    script: [...(opts.script ?? [])],
    defaultTurn: opts.defaultTurn ?? reply('好的，已收到。'),
    model: opts.model ?? 'claude-probe-1',
    tokenDelayMs: opts.tokenDelayMs ?? 0,
    chunkChars: opts.chunkChars ?? 6,
    strictKey: !!opts.strictKey,
    messageCalls: 0,
  };
  /** @type {ReturnType<typeof summarizeRequest>[]} */
  const requests = [];
  const waiters = [];
  const sockets = new Set();
  const log = opts.log ?? (() => {});

  const notify = () => { for (const w of [...waiters]) if (w.test()) { waiters.splice(waiters.indexOf(w), 1); w.resolve(); } };

  const send = (res, status, obj, headers = {}) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'request-id': id('req'), ...headers });
    res.end(body);
  };

  function pickTurn(summary) {
    const idx = state.messageCalls++;
    const item = idx < state.script.length ? state.script[idx] : state.defaultTurn;
    return typeof item === 'function' ? item(summary, idx + 1) : item;
  }

  async function streamTurn(req, res, summary, turn, body) {
    const blocks = turn.blocks ?? [];
    const tokenDelay = turn.tokenDelayMs ?? state.tokenDelayMs;
    const chunk = Math.max(1, turn.chunkChars ?? state.chunkChars);
    const inputTokens = turn.usage?.input_tokens ?? estimateTokens(JSON.stringify(body?.messages ?? ''));
    const outText = blocks.map((b) => b.text ?? b.thinking ?? JSON.stringify(b.input ?? '')).join('');
    const outputTokens = turn.usage?.output_tokens ?? estimateTokens(outText);
    const usage0 = { input_tokens: inputTokens, cache_creation_input_tokens: turn.usage?.cache_creation_input_tokens ?? 0, cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0, output_tokens: 1 };
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', 'request-id': id('req'), ...(turn.headers ?? {}) });
    let closed = false;
    res.on('close', () => { closed = true; summary.aborted = !res.writableEnded; });
    const ev = (name, data) => { if (!closed) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };
    const pause = async () => { if (tokenDelay) await sleep(tokenDelay); };

    ev('message_start', { type: 'message_start', message: { id: id('msg'), type: 'message', role: 'assistant', model: body?.model ?? state.model, content: [], stop_reason: null, stop_sequence: null, usage: usage0 } });
    ev('ping', { type: 'ping' });
    let emitted = 0;
    for (let i = 0; i < blocks.length && !closed; i++) {
      const b = blocks[i];
      if (b.type === 'text') {
        ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'text', text: '' } });
        for (let p = 0; p < b.text.length && !closed; p += chunk) { ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: b.text.slice(p, p + chunk) } }); await pause(); }
      } else if (b.type === 'thinking') {
        ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'thinking', thinking: '', signature: '' } });
        for (let p = 0; p < b.thinking.length && !closed; p += chunk) { ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'thinking_delta', thinking: b.thinking.slice(p, p + chunk) } }); await pause(); }
        ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'signature_delta', signature: 'probe-signature' } });
      } else if (b.type === 'tool_use') {
        ev('content_block_start', { type: 'content_block_start', index: i, content_block: { type: 'tool_use', id: b.id ?? id('toolu'), name: b.name, input: {} } });
        const json = JSON.stringify(b.input ?? {});
        for (let p = 0; p < json.length && !closed; p += Math.max(chunk, 12)) { ev('content_block_delta', { type: 'content_block_delta', index: i, delta: { type: 'input_json_delta', partial_json: json.slice(p, p + Math.max(chunk, 12)) } }); await pause(); }
      }
      ev('content_block_stop', { type: 'content_block_stop', index: i });
      emitted++;
      if (turn.dropAfterBlocks !== undefined && emitted >= turn.dropAfterBlocks) { res.socket?.destroy(); return; }
    }
    const stop = turn.stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
    ev('message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: outputTokens, input_tokens: inputTokens, cache_creation_input_tokens: usage0.cache_creation_input_tokens, cache_read_input_tokens: usage0.cache_read_input_tokens } });
    ev('message_stop', { type: 'message_stop' });
    if (!closed) res.end();
  }

  function jsonTurn(res, turn, body) {
    const blocks = (turn.blocks ?? []).map((b) => (b.type === 'tool_use' ? { type: 'tool_use', id: b.id ?? id('toolu'), name: b.name, input: b.input ?? {} } : b.type === 'thinking' ? { type: 'thinking', thinking: b.thinking, signature: 'probe-signature' } : { type: 'text', text: b.text }));
    const inputTokens = turn.usage?.input_tokens ?? estimateTokens(JSON.stringify(body?.messages ?? ''));
    const outputTokens = turn.usage?.output_tokens ?? estimateTokens((turn.blocks ?? []).map((b) => b.text ?? b.thinking ?? JSON.stringify(b.input ?? '')).join(''));
    send(res, 200, {
      id: id('msg'), type: 'message', role: 'assistant', model: body?.model ?? state.model, content: blocks,
      stop_reason: turn.stopReason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'), stop_sequence: null,
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_creation_input_tokens: turn.usage?.cache_creation_input_tokens ?? 0, cache_read_input_tokens: turn.usage?.cache_read_input_tokens ?? 0 },
    }, turn.headers ?? {});
  }

  const server = http.createServer(async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    const raw = Buffer.concat(chunks).toString('utf8');
    if (raw) { try { body = JSON.parse(raw); } catch { body = undefined; } }
    try {
      if (req.method === 'GET' && (url === '/' || url === '/health')) return send(res, 200, { ok: true, fake: 'anthropic', model: state.model });
      if (req.method === 'GET' && url === '/v1/models') {
        return send(res, 200, { data: [{ type: 'model', id: state.model, display_name: '探针模型', created_at: '2026-01-01T00:00:00Z' }], has_more: false, first_id: state.model, last_id: state.model });
      }
      if (req.method === 'POST' && url === '/v1/messages/count_tokens') return send(res, 200, { input_tokens: estimateTokens(JSON.stringify(body?.messages ?? '')) });
      if (req.method === 'POST' && url === '/v1/messages') {
        const summary = summarizeRequest(requests.length + 1, req.method, url, req.headers, body);
        requests.push(summary);
        log(`#${summary.n} POST ${url} stream=${summary.stream} 用户：${summary.lastUserText.slice(0, 60)} 工具结果 ${summary.toolResults.length}`);
        notify();
        if (state.strictKey && !summary.hasKey) return send(res, 401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
        const turn = pickTurn(summary) ?? state.defaultTurn;
        summary.turn = { stopReason: turn.stopReason, blocks: (turn.blocks ?? []).map((b) => b.type + (b.name ? `:${b.name}` : '')), status: turn.status };
        if (turn.delayMs) await sleep(turn.delayMs);
        if (turn.hang) { req.on('close', () => { summary.aborted = true; }); return; }
        if (turn.status) return send(res, turn.status, turn.error ?? { type: 'error', error: { type: 'api_error', message: '模拟错误' } }, turn.headers ?? {});
        return body?.stream === false ? jsonTurn(res, turn, body) : streamTurn(req, res, summary, turn, body);
      }
      return send(res, 404, { type: 'error', error: { type: 'not_found_error', message: `${req.method} ${url}` } });
    } catch (e) {
      try { send(res, 500, { type: 'error', error: { type: 'api_error', message: String(e?.message ?? e) } }); } catch { /* 已经在流里了 */ }
    }
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(opts.port ?? 0, host, resolve); });
  const port = server.address().port;

  return {
    port, host, baseUrl: `http://${host}:${port}`, requests, state,
    /** 消息请求（POST /v1/messages）的次数。 */
    get messageCount() { return requests.length; },
    /** 重设脚本（并清空计数与记录）。 */
    reset(script = [], defaultTurn) { state.script = [...script]; state.messageCalls = 0; requests.length = 0; if (defaultTurn) state.defaultTurn = defaultTurn; },
    /** 追加后续回合。 */
    push(...turns) { state.script.push(...turns); },
    waitForRequests(count, timeoutMs = 15000) {
      if (requests.length >= count) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const w = { test: () => requests.length >= count, resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => { waiters.splice(waiters.indexOf(w), 1); reject(new Error(`等 ${count} 个请求超时（收到 ${requests.length}）`)); }, timeoutMs);
        waiters.push(w);
      });
    },
    /** 等一小会儿，确认「没有」更多请求进来（用来证明没有重复发送）。 */
    async expectNoMoreRequests(afterCount, quietMs = 800) { await sleep(quietMs); return requests.length === afterCount; },
    async close() {
      for (const s of sockets) s.destroy();
      await new Promise((r) => server.close(() => r()));
    },
  };
}

/* ───────────── 自检与命令行 ───────────── */

async function readSse(res) {
  const events = [];
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i); buf = buf.slice(i + 2);
      const name = /^event: (.+)$/m.exec(block)?.[1];
      const data = /^data: (.+)$/m.exec(block)?.[1];
      if (name && data) events.push({ name, data: JSON.parse(data) });
    }
  }
  return events;
}

export async function selfTest(log = console.log) {
  const fake = await startFakeAnthropic({ script: [reply('你好，我是假的 Claude。'), toolUse('Bash', { command: 'echo hi' }, { text: '先看一下。' }), askUserQuestion([{ question: '选哪个？', header: '方案', options: [{ label: 'A', description: '快' }, { label: 'B', description: '稳' }], multiSelect: false }]), exitPlanMode('1. 读文件\n2. 改文件'), httpError(429, '太快了', 'rate_limit_error')] });
  const post = (body) => fetch(`${fake.baseUrl}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
  const checks = [];
  const ok = (name, cond) => { checks.push({ name, ok: !!cond }); log(`${cond ? '通过' : '失败'}：${name}`); };

  let res = await post({ model: 'm', stream: true, max_tokens: 100, messages: [{ role: 'user', content: '你好' }] });
  let ev = await readSse(res);
  const text = ev.filter((e) => e.name === 'content_block_delta').map((e) => e.data.delta.text).join('');
  ok('文本流：message_start … message_stop 齐全', ev[0].name === 'message_start' && ev.at(-1).name === 'message_stop');
  ok('文本流：拼起来是脚本里的话', text === '你好，我是假的 Claude。');
  ok('文本流：message_delta 带 end_turn 与 output_tokens', ev.find((e) => e.name === 'message_delta').data.delta.stop_reason === 'end_turn' && ev.find((e) => e.name === 'message_delta').data.usage.output_tokens > 0);

  res = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: '跑个命令' }] });
  ev = await readSse(res);
  const tool = ev.find((e) => e.name === 'content_block_start' && e.data.content_block.type === 'tool_use');
  const json = ev.filter((e) => e.name === 'content_block_delta' && e.data.delta.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('');
  ok('tool_use：块与 input_json_delta', tool?.data.content_block.name === 'Bash' && JSON.parse(json).command === 'echo hi');
  ok('tool_use：stop_reason=tool_use', ev.find((e) => e.name === 'message_delta').data.delta.stop_reason === 'tool_use');

  res = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '输出' }] }] });
  ev = await readSse(res);
  ok('AskUserQuestion：questions 完整', JSON.parse(ev.filter((e) => e.data.delta?.type === 'input_json_delta').map((e) => e.data.delta.partial_json).join('')).questions[0].options.length === 2);
  ok('请求记录：带回了 tool_result', fake.requests[2].toolResults.length === 1 && fake.requests[2].toolResults[0].text === '输出');

  res = await post({ model: 'm', stream: false, messages: [{ role: 'user', content: '计划' }] });
  const j = await res.json();
  ok('非流式 JSON：ExitPlanMode', j.content[0].name === 'ExitPlanMode' && j.content[0].input.plan.includes('读文件'));

  res = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: '限流' }] });
  ok('HTTP 错误：429 + Anthropic 错误体', res.status === 429 && (await res.json()).error.type === 'rate_limit_error');

  res = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: '默认' }] });
  ev = await readSse(res);
  ok('脚本用完后：回默认回复', ev.filter((e) => e.name === 'content_block_delta').map((e) => e.data.delta.text).join('') === '好的，已收到。');
  ok('请求计数', fake.messageCount === 6);
  await fake.close();
  return checks.every((c) => c.ok);
}

if (import.meta.url === `file:///${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('fake-anthropic.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    selfTest().then((okAll) => process.exit(okAll ? 0 : 1), (e) => { console.error(e); process.exit(2); });
  } else {
    const portArg = args.indexOf('--port');
    startFakeAnthropic({ port: portArg >= 0 ? Number(args[portArg + 1]) : 0, log: (s) => console.error(s) }).then((f) => {
      console.error(`假 Anthropic 服务：${f.baseUrl}（POST /v1/messages；密钥任意）\nCtrl+C 退出`);
    });
  }
}
