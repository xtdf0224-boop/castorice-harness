'use strict';
// A fake model service on 127.0.0.1 (random port) for the model-access checks (npm run check:services).
// Nothing here talks to the internet and nothing needs a real key. Every request is recorded so a test can
// assert exactly what the app sent: method, path, headers, body.
//
//   const fake = await startFake({ script: 'openai-ok' });
//   fake.baseUrl            http://127.0.0.1:PORT/v1
//   fake.origin             http://127.0.0.1:PORT
//   fake.requests           [{ method, path, query, headers, body, raw }]
//   fake.script = 'reject-stream-options'   // switch behaviour between requests (name, function, or array: one entry per request)
//   await fake.close()
//
// Scripts (see MODELS-SPEC §15.2) are plain functions (req, res, ctx) so a test can also pass its own.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const MODELS_DIR = path.join(__dirname, 'models');

/* ───────────── SSE helpers ───────────── */

function sseHead(res, extra = {}) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive', ...extra });
}
const data = (res, obj) => res.write(`data: ${typeof obj === 'string' ? obj : JSON.stringify(obj)}\n\n`);
const chunk = (delta, extra = {}) => ({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: null }], ...extra });
const finish = (reason = 'stop') => ({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: reason }] });
const usageChunk = (input = 7, output = 3, cached = 0) => ({ id: 'chatcmpl-fake', object: 'chat.completion.chunk', model: 'fake', choices: [], usage: { prompt_tokens: input, completion_tokens: output, prompt_tokens_details: { cached_tokens: cached } } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = (res, status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(obj)); };

/** The auth value the request carried, whichever header it used (for the echo-key script and the auth-required wrapper). */
const keyOf = (req) => {
  const h = req.headers;
  if (h.authorization) return String(h.authorization).replace(/^Bearer\s+/i, '');
  return h['x-api-key'] || h['api-key'] || h['x-goog-api-key'] || '';
};

/* ───────────── OpenAI Chat Completions scripts ───────────── */

function openaiOk(req, res) {
  sseHead(res);
  data(res, chunk({ role: 'assistant', content: '' }));
  data(res, chunk({ content: '你好' }));
  data(res, chunk({ content: '，阁下。' }));
  data(res, finish('stop'));
  if (req.body && req.body.stream_options) data(res, usageChunk(11, 5, 2));
  res.write('data: [DONE]\n\n');
  res.end();
}

const reasoningScript = (field) => (req, res) => {
  sseHead(res);
  data(res, chunk({ [field]: '先想一想。' }));
  data(res, chunk({ [field]: '再想一想。' }));
  data(res, chunk({ content: '答案' }));
  data(res, chunk({ content: '是 42。' }));
  data(res, finish('stop'));
  data(res, usageChunk());
  res.write('data: [DONE]\n\n');
  res.end();
};

function openaiThinkTag(req, res) {
  sseHead(res);
  // the tag itself is split across deltas on purpose
  data(res, chunk({ content: '<thi' }));
  data(res, chunk({ content: 'nk>内心' }));
  data(res, chunk({ content: '独白</th' }));
  data(res, chunk({ content: 'ink>正文在这里。' }));
  data(res, finish('stop'));
  data(res, usageChunk());
  res.write('data: [DONE]\n\n');
  res.end();
}

function openaiReasoningDetails(req, res) {
  sseHead(res);
  data(res, chunk({ reasoning_details: [{ type: 'reasoning.text', text: '细节一。' }] }));
  data(res, chunk({ reasoning_details: [{ type: 'reasoning.summary', summary: '摘要二。' }] }));
  data(res, chunk({ content: '结论。' }));
  data(res, finish('stop'));
  data(res, usageChunk());
  res.write('data: [DONE]\n\n');
  res.end();
}

/** Mistral with reasoning on: content is an ARRAY of parts, thinking first, text after, finally plain strings. */
function openaiMistralParts(req, res) {
  sseHead(res);
  data(res, chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: '思考甲。' }] }] }));
  data(res, chunk({ content: [{ type: 'thinking', thinking: [{ type: 'text', text: '思考乙。' }] }] }));
  data(res, chunk({ content: [{ type: 'text', text: '正文甲。' }] }));
  data(res, chunk({ content: [{ type: 'text', text: '正文乙。' }, { type: 'reference', reference_ids: [1] }] }));
  data(res, chunk({ content: '正文丙。' }));
  data(res, finish('stop'));
  data(res, usageChunk());
  res.write('data: [DONE]\n\n');
  res.end();
}

function openaiCommentLines(req, res) {
  sseHead(res);
  res.write(': keepalive\n\n');
  data(res, chunk({ content: '甲' }));
  res.write(': OPENROUTER PROCESSING\n\n');
  data(res, chunk({ content: '乙' }));
  data(res, finish('stop'));
  data(res, usageChunk());
  res.write('data: [DONE]\n\n');
  res.end();
}

/** No finish_reason at all, then the stream just ends: the app must call it incomplete. */
function openaiNoFinish(req, res) {
  sseHead(res);
  data(res, chunk({ content: '说到一半' }));
  res.end();
}

/** [DONE] after real text but never a finish_reason: still a complete reply. */
function openaiDoneOnly(req, res) {
  sseHead(res);
  data(res, chunk({ content: '完整的话。' }));
  res.write('data: [DONE]\n\n');
  res.end();
}

/** A body that names a rejected field → 400 like a strict gateway; otherwise normal. */
const rejectField = (field, hint = field) => (req, res, ctx) => {
  if (req.body && Object.hasOwn(req.body, field)) return json(res, 400, { error: { message: `Unsupported parameter: '${field}'. ${hint}` } });
  return ctx.scripts['openai-ok'](req, res, ctx);
};

const SCRIPTS = {
  'openai-ok': openaiOk,
  'openai-reasoning-content': reasoningScript('reasoning_content'),
  'openai-reasoning': reasoningScript('reasoning'),
  'openai-think-tag': openaiThinkTag,
  'openai-reasoning-details': openaiReasoningDetails,
  'openai-mistral-parts': openaiMistralParts,
  'openai-comment-lines': openaiCommentLines,
  'openai-no-finish': openaiNoFinish,
  'openai-done-only': openaiDoneOnly,
  'reject-stream-options': rejectField('stream_options', 'stream_options is not supported by this gateway.'),
  /** max_tokens is refused and the message points at max_completion_tokens. */
  'reject-max-tokens': (req, res, ctx) => (req.body && Object.hasOwn(req.body, 'max_tokens')
    ? json(res, 400, { error: { message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead." } })
    : ctx.scripts['openai-ok'](req, res, ctx)),
  /** …and the other way round. */
  'reject-max-completion-tokens': (req, res, ctx) => (req.body && Object.hasOwn(req.body, 'max_completion_tokens')
    ? json(res, 400, { error: { message: "Unknown field max_completion_tokens; this endpoint expects max_tokens." } })
    : ctx.scripts['openai-ok'](req, res, ctx)),
  /** The output limit asked for is too large: only ≤ 8192 passes. */
  'reject-big-max': (req, res, ctx) => {
    const n = req.body && (req.body.max_tokens ?? req.body.max_completion_tokens);
    if (n > 8192) return json(res, 400, { error: { message: `max_tokens ${n} exceeds the maximum allowed (8192) for this model` } });
    return ctx.scripts['openai-ok'](req, res, ctx);
  },
  /** reasoning_effort values listed in ctx.rejectEfforts are a 400 that names the field. */
  'reject-effort': (req, res, ctx) => {
    const v = req.body && req.body.reasoning_effort;
    if (v && (ctx.rejectEfforts || ['max', 'xhigh']).includes(v)) return json(res, 400, { error: { message: `Invalid value for reasoning_effort: '${v}'. Supported values are: 'low', 'medium', 'high'.` } });
    return ctx.scripts['openai-ok'](req, res, ctx);
  },
  /** Any thinking / reasoning field is refused (used to prove "off" is not retried). */
  'reject-all-effort': (req, res, ctx) => {
    if (req.body && (req.body.reasoning_effort || req.body.thinking || req.body.enable_thinking !== undefined)) return json(res, 400, { error: { message: 'reasoning_effort / thinking is not supported for this model' } });
    return ctx.scripts['openai-ok'](req, res, ctx);
  },
  /** 401 whose body echoes the key it was sent (some gateways do). */
  'echo-key-error': (req, res) => json(res, 401, { error: { message: `Incorrect API key provided: ${keyOf(req)}. You can find your API key at https://example.test/keys.` } }),
  /** The same, as a streamed text delta that carries the key split in two pieces. */
  'echo-key-stream': (req, res) => {
    const k = keyOf(req);
    const mid = Math.max(1, Math.floor(k.length / 2));
    sseHead(res);
    data(res, chunk({ content: `你的密钥是 ${k.slice(0, mid)}` }));
    data(res, chunk({ content: `${k.slice(mid)} 请保密。` }));
    data(res, finish('stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  },
  'status-403': (req, res) => json(res, 403, { error: { message: 'model not enabled for this account' } }),
  'status-404': (req, res) => json(res, 404, { error: { message: 'not found' } }),
  'status-429': (req, res) => json(res, 429, { error: { message: 'rate limit' } }),
  'status-402': (req, res) => json(res, 402, { error: { message: 'insufficient balance' } }),
  'status-500': (req, res) => json(res, 500, { error: { message: 'internal error' } }),
  'status-400-model': (req, res) => json(res, 400, { error: { message: 'The model `nope` does not exist' } }),
  'status-400-param': (req, res) => json(res, 400, { error: { message: 'messages must not be empty' } }),
  /** Redirects to another host: with redirect:'error' the app must never follow. */
  'redirect-302': (req, res, ctx) => { res.writeHead(302, { location: `${ctx.origin}/elsewhere/v1/chat/completions` }); res.end(); },
  /** The first byte arrives after ctx.delayMs. */
  'slow-first-byte': async (req, res, ctx) => { await sleep(ctx.delayMs || 800); if (!res.destroyed) openaiOk(req, res); },
  /** One chunk, then silence (the connection stays open). */
  idle: (req, res) => { sseHead(res); data(res, chunk({ content: '开头' })); },
  /** Chunks spaced out in time (to prove the reply streams instead of arriving at the end). */
  'openai-slow-stream': async (req, res) => {
    sseHead(res);
    for (const t of ['一', '二', '三', '四']) { if (res.destroyed) return; data(res, chunk({ content: t })); await sleep(250); }
    data(res, finish('stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  },
  /** ~9 MB JSON (more than the 8 MB non-streaming cap). */
  'huge-body': (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"object":"list","data":[');
    const row = `${JSON.stringify({ id: 'x'.repeat(60), pad: 'y'.repeat(900) })},`;
    for (let i = 0; i < 9500; i++) res.write(row);
    res.end('{"id":"last"}]}');
  },

  /* ───────────── Anthropic Messages ───────────── */

  'anthropic-ok': (req, res) => {
    sseHead(res);
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { id: 'msg_fake', type: 'message', role: 'assistant', model: 'fake', content: [], usage: { input_tokens: 9, output_tokens: 1, cache_read_input_tokens: 3 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '你好' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: '，阁下。' } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 6 } });
    ev('message_stop', {});
    res.end();
  },
  'anthropic-thinking': (req, res) => {
    sseHead(res);
    const ev = (type, o) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`);
    ev('message_start', { message: { id: 'msg_fake', role: 'assistant', content: [], usage: { input_tokens: 9, output_tokens: 1 } } });
    ev('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '想一下。' } });
    ev('content_block_stop', { index: 0 });
    ev('content_block_start', { index: 1, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 1, delta: { type: 'text_delta', text: '好的。' } });
    ev('content_block_stop', { index: 1 });
    ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 8 } });
    ev('message_stop', {});
    res.end();
  },
  'anthropic-error': (req, res) => {
    sseHead(res);
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`);
    res.end();
  },
  'anthropic-http-401': (req, res) => json(res, 401, { type: 'error', error: { type: 'authentication_error', message: `invalid x-api-key: ${keyOf(req)}` } }),
};

/* ───────────── model lists ───────────── */

function modelsFixture(name) {
  try { return JSON.parse(fs.readFileSync(path.join(MODELS_DIR, `${name}.json`), 'utf8')); } catch { return null; }
}

const OPENAI_LIST = { object: 'list', data: [{ id: 'fake-chat-1', object: 'model', owned_by: 'fake' }, { id: 'fake-chat-2', object: 'model', owned_by: 'fake' }, { id: 'text-embedding-fake', object: 'model', owned_by: 'fake' }] };
const OLLAMA_TAGS = { models: [{ name: 'qwen3:32b', details: { parameter_size: '32B', quantization_level: 'Q4_K_M' } }, { name: 'llama3.2:3b', details: { parameter_size: '3B' } }] };

/* ───────────── server ───────────── */

/**
 * @param {{ script?: string | Function | Array<string | Function>, rejectEfforts?: string[], delayMs?: number, models?: object, requireAuth?: boolean | string[] }} [opts]
 */
async function startFake(opts = {}) {
  const requests = [];
  const sockets = new Set();
  const state = { script: opts.script || 'openai-ok', seq: 0 };
  let origin = '';

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = null; }
      const url = new URL(req.url, 'http://x');
      const rec = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: { ...req.headers }, body, raw, at: Date.now() };
      req.body = body;
      requests.push(rec);
      const ctx = { origin, scripts: SCRIPTS, rejectEfforts: opts.rejectEfforts, delayMs: opts.delayMs, requests, sleep, json, keyOf };
      try {
        // model lists, probes
        if (req.method === 'GET') {
          if (opts.requireAuth && !keyOf(req)) return json(res, 401, { error: { message: 'missing key' } });
          const custom = typeof opts.models === 'function' ? opts.models(req, rec) : opts.models;
          if (custom && custom[url.pathname] !== undefined) {
            const v = custom[url.pathname];
            if (typeof v === 'number') return json(res, v, { error: { message: `status ${v}` } });
            if (typeof v === 'string') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(v); }
            return json(res, 200, v);
          }
          if (/\/models$/.test(url.pathname) || /\/v1\/models$/.test(url.pathname)) return json(res, 200, OPENAI_LIST);
          if (url.pathname === '/api/tags') return json(res, 200, OLLAMA_TAGS);
          if (url.pathname === '/slow') { await sleep(opts.delayMs || 3000); return json(res, 200, {}); }
          if (url.pathname === '/huge') return SCRIPTS['huge-body'](req, res, ctx);
          if (url.pathname === '/redirect') { res.writeHead(302, { location: `${origin}/models` }); return res.end(); }
          return json(res, 404, { error: { message: 'not found' } });
        }
        // chat endpoints
        let script = state.script;
        if (Array.isArray(script)) script = script[Math.min(state.seq, script.length - 1)];
        state.seq += 1;
        if (typeof script === 'string') {
          const fn = SCRIPTS[script];
          if (!fn) return json(res, 500, { error: { message: `no such fake script ${script}` } });
          if (opts.requireAuth && !keyOf(req)) return json(res, 401, { error: { message: 'missing key' } });
          return await fn(req, res, ctx);
        }
        return await script(req, res, ctx);
      } catch (e) {
        if (!res.headersSent) json(res, 500, { error: { message: String(e && e.message || e) } });
        else res.end();
      }
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  origin = `http://127.0.0.1:${port}`;
  return {
    port,
    origin,
    baseUrl: `${origin}/v1`,
    requests,
    get script() { return state.script; },
    set script(v) { state.script = v; state.seq = 0; },
    reset() { requests.length = 0; state.seq = 0; },
    close() { for (const s of sockets) s.destroy(); return new Promise((r) => server.close(() => r())); },
  };
}

module.exports = { startFake, SCRIPTS, modelsFixture, sleep };
