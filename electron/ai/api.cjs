// Direct API calls: OpenAI-compatible Chat Completions (GPT, DeepSeek, Kimi, Qwen, GLM, MiniMax, 豆包, Gemini, Grok, Mistral, OpenRouter,
// local servers… anything on the openai-chat protocol) and the Anthropic Messages API (Claude and Anthropic-compatible services).
// Both stream; text arrives as `text` events, reasoning as `thinking`, token counts as `usage`.
//
// Since the model-access rework (MODELS-SPEC §6) the two adapters are PARAMETERIZED: they take a `ResolvedApi` that
// services.cjs built from the registry — the URL, the auth scheme, the output-limit field, where thinking text shows up, the
// fields to drop, the reasoning fields — and never read an address or a body field from the page. The key is read by the caller and
// only used here, in the request headers; it never goes into an event, a notice or an error (the caller also wraps `emit` in the scrubber).

const net = require('./net.cjs');
const effortWire = require('./effort-wire.cjs');
const { scrubValue } = require('./scrub.cjs');

const IDLE_MS = 180_000;
/** Test seam: shrink the first-byte / idle limits so a check does not wait minutes. */
const limits = { firstByteMs: net.FIRST_BYTE_MS, idleMs: IDLE_MS };
function __setLimits(o) { Object.assign(limits, { firstByteMs: net.FIRST_BYTE_MS, idleMs: IDLE_MS }, o || {}); }

/** The 桌宠's quick lane (StartSpec.pet, `r.pet`): she answers in a sentence or two while someone plays, so waiting is short —
 *  12 s for the first byte, 20 s of silence — and nothing is retried with adjusted fields. */
const PET_FIRST_BYTE_MS = 12_000;
const PET_IDLE_MS = 20_000;
const limitsFor = (r) => (r && r.pet
  ? { firstByteMs: Math.min(limits.firstByteMs, PET_FIRST_BYTE_MS), idleMs: Math.min(limits.idleMs, PET_IDLE_MS) }
  : limits);

/* ───────────── message content (text, or text and pictures) ───────────── */

/** Content for the OpenAI-compatible API: a string stays one; parts become text / image_url blocks in order. */
function openAiContent(content) {
  if (!Array.isArray(content)) return String(content);
  const out = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'text' && p.text) out.push({ type: 'text', text: String(p.text) });
    else if (p.type === 'image' && p.data) out.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } });
  }
  return out;
}

/** The same for the Messages API. Images go first: Claude answers a question about a picture better when it has seen the picture. */
function anthropicContent(content) {
  if (!Array.isArray(content)) return String(content);
  const images = [];
  const texts = [];
  for (const p of content) {
    if (!p) continue;
    if (p.type === 'image' && p.data) images.push({ type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } });
    else if (p.type === 'text' && p.text) texts.push({ type: 'text', text: String(p.text) });
  }
  return [...images, ...texts];
}

/* ───────────── errors ───────────── */

const MODEL_COMPLAINT = /model[^.\n]{0,40}(not found|does not exist|doesn'?t exist|not exist|invalid|unknown|unsupported|not supported|not available|unavailable)|(invalid|unknown|unsupported|no such|unrecognized|unrecognised)[^.\n]{0,20}model|模型.{0,10}(不存在|无效|不支持|不可用)/i;

/**
 * An HTTP failure → one readable line with a stable `code` (AUTH, AUTH_SCOPE, NOT_FOUND, MODEL, PARAM, QUOTA, SERVER).
 * @param {number} status
 * @param {string} body  the response text
 * @param {object} r     the ResolvedApi (for the hints that depend on the service)
 * @param {string} [key] the key that was sent: some gateways echo it back, so it is scrubbed out of the detail
 */
function httpError(status, body, r, key) {
  let detail = '';
  try {
    const j = JSON.parse(body);
    detail = (j.error && (j.error.message || j.error.msg || (typeof j.error === 'string' ? j.error : '') || j.error.code)) || j.message || j.msg || (j.base_resp && j.base_resp.status_msg) || '';
  } catch { detail = String(body || '').slice(0, 300); }
  detail = String(scrubValue(String(detail), key) ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const sep = !!(r && r.endpoint && r.endpoint.separateKey);
  const custom = !!(r && r.service && r.service.kind === 'custom');
  let code = 'PARAM';
  let why;
  if (status === 401) { code = 'AUTH'; why = `密钥无效或已过期${sep ? '。这家的国内、国际、套餐密钥互不通用，请检查服务地区' : ''}`; }
  else if (status === 403) { code = 'AUTH_SCOPE'; why = '没有权限（账号未开通该模型，或地区不可用）'; }
  else if (status === 404) { code = 'NOT_FOUND'; why = `找不到接口或模型（检查服务地址与模型名${custom && r.baseUrl ? `；当前地址 ${r.baseUrl}` : ''}）`; }
  else if (status === 402) { code = 'QUOTA'; why = '账户余额不足'; }
  else if (status === 429) { code = 'QUOTA'; why = '请求太频繁或额度用完'; }
  else if (status >= 500) { code = 'SERVER'; why = '服务端出错，稍后再试'; }
  else if (status === 400 && MODEL_COMPLAINT.test(`${detail} ${String(body).slice(0, 400)}`)) { code = 'MODEL'; why = '模型名不被接受'; }
  else why = '请求被拒绝';
  const err = new Error(`${why}（HTTP ${status}）${detail ? `：${detail}` : ''}`);
  err.code = code;
  err.status = status;
  err.provider = r && r.provider;
  return err;
}

/* ───────────── SSE ───────────── */

/**
 * Read an SSE body, calling onData(json) for each `data:` payload. Lines that are not `data:` (comments such as `: keepalive`, `event:`) are ignored.
 * @returns {Promise<{ sawDone: boolean }>}
 */
async function readSse(res, signal, onData, idleMs = limits.idleMs) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let idle;
  let idled = false;
  let sawDone = false;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => { idled = true; reader.cancel(new Error('IDLE')).catch(() => {}); }, idleMs); };
  // Stop / pause / cancel must end the read even while the model is silently reasoning.
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', onAbort, { once: true });
  arm();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (signal.aborted) break;
      arm();
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === '[DONE]') { sawDone = true; continue; }
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        onData(json);
      }
    }
  } finally {
    clearTimeout(idle);
    signal.removeEventListener('abort', onAbort);
    reader.cancel().catch(() => {});
  }
  if (idled && !signal.aborted) throw Object.assign(new Error(idleMs < 60_000 ? `超过 ${Math.max(1, Math.round(idleMs / 1000))} 秒没有收到数据，连接已断开` : `超过 ${Math.max(1, Math.round(idleMs / 60000))} 分钟没有收到数据，连接已断开`), { code: 'EIDLE' });
  return { sawDone };
}

/** Routes text inside <think>…</think> (MiniMax and some others put reasoning in the content) to thinking.
    Call `.end()` when the stream is over: a held-back possible tag start (a trailing 「<」) is real text. */
function thinkSplitter(emit) {
  let inThink = false;
  let pending = '';
  const push = (chunk) => {
    pending += chunk;
    for (;;) {
      const tag = inThink ? '</think>' : '<think>';
      const at = pending.indexOf(tag);
      if (at >= 0) {
        if (at > 0) emit(inThink ? 'thinking' : 'text', pending.slice(0, at));
        pending = pending.slice(at + tag.length);
        inThink = !inThink;
        continue;
      }
      // Keep a possible partial tag at the end for the next chunk.
      let keep = 0;
      for (let k = Math.min(tag.length - 1, pending.length); k > 0; k--) {
        if (tag.startsWith(pending.slice(-k))) { keep = k; break; }
      }
      const out = pending.slice(0, pending.length - keep);
      if (out) emit(inThink ? 'thinking' : 'text', out);
      pending = pending.slice(pending.length - keep);
      return;
    }
  };
  push.end = () => {
    if (pending) emit(inThink ? 'thinking' : 'text', pending);
    pending = '';
  };
  return push;
}

/** The stream closed before the model said it was done: what arrived is only part of the reply. */
const incomplete = () => Object.assign(new Error('连接提前结束，没有收到模型的结束信号，回复不完整。可以重新生成或重试这一步。'), { code: 'EINCOMPLETE' });

/* ───────────── requests ───────────── */

/** The key goes into exactly one place, chosen by the service's scheme. Nothing a static header says can override it. */
function authHeaders(auth, key) {
  if (!key || !auth || auth.scheme === 'none') return {};
  switch (auth.scheme) {
    case 'x-api-key': return { 'x-api-key': key };
    case 'api-key': return { 'api-key': key };
    case 'header': return auth.header ? { [auth.header]: key } : {};
    case 'both': return { 'x-api-key': key, authorization: `Bearer ${key}` };
    default: return { authorization: `Bearer ${key}` };
  }
}

function buildHeaders(r, key, extra = {}) {
  return { ...r.headers, ...extra, ...authHeaders(r.auth, key), 'content-type': 'application/json', accept: 'text/event-stream' };
}

async function post(r, key, body, signal, extraHeaders) {
  return net.fetchStream(r.url, { method: 'POST', headers: buildHeaders(r, key, extraHeaders), body: JSON.stringify(body) }, { signal, firstByteMs: limitsFor(r).firstByteMs });
}

/**
 * Send the request; a 400 that points at something we can fix gets ONE adjusted retry per kind, at most two in all (MODELS-SPEC §6.1):
 *   stream_options refused → drop it · output-limit field refused (auto) → the other field · limit too large → 8192 ·
 *   reasoning field refused → one level lower, else without the reasoning fields. Every retry says so in a notice.
 * @param {object} r     ResolvedApi
 * @param {string} key
 * @param {(s: object) => object} build  body from the mutable state `s`
 * @param {object} s     { streamUsage, field, n, effortFields, level }
 */
async function sendWithRetries(r, key, build, s, emit, signal, extraHeaders) {
  const done = new Set();
  for (;;) {
    const body = build(s);
    const res = await post(r, key, body, signal, extraHeaders);
    // The 桌宠's quick lane is not retried with adjusted fields: a refusal is reported at once (the caller turns it into the error).
    if (res.status !== 400 || done.size >= 2 || r.pet) return res;
    const text = await res.text();
    let fix = null;
    if (s.streamUsage && !done.has('stream') && /stream_options/i.test(text)) {
      fix = { kind: 'stream', note: '这家服务不接受 stream_options，已去掉后重试（用量统计可能缺失）。', apply: () => { s.streamUsage = false; } };
    } else if (s.canSwapField && !done.has('field') && new RegExp(s.field === 'max_tokens' ? 'max_completion_tokens' : '(?<![a-z_])max_tokens').test(text)) {
      const to = s.field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens';
      fix = { kind: 'field', note: `这家服务要求用 ${to} 设置输出上限，已换字段重试。`, apply: () => { s.field = to; } };
    } else if (!done.has('big') && s.n > 8192 && /too large|exceed|maximum|context length/i.test(text)) {
      fix = { kind: 'big', note: `输出上限 ${s.n} 超过这个模型的限制，已改为 8192 重试。`, apply: () => { s.n = 8192; } };
    } else if (!done.has('effort') && s.level && s.level !== 'off' && Object.keys(s.effortFields).length && effortWire.REASONING_COMPLAINT.test(text) && !/adaptive/i.test(text)) {
      const d = effortWire.degradeOnce(r.effort.spec, s.level);
      if (d) fix = { kind: 'effort', note: `这个模型不接受「${effortWire.LABEL[s.level]}」强度，已降为「${effortWire.LABEL[d.level]}」重试。`, apply: () => { s.level = d.level; s.effortFields = d.fields; } };
    }
    // The model refuses the thinking fields themselves (an older Claude model and "adaptive", a service that has no such switch): send the
    // request without any, whatever the level was — including the default level, which carries the first-party summary request. 'off' keeps
    // its rule: the opposite intent is never retried.
    if (!fix && !done.has('think') && s.level !== 'off' && Object.keys(s.effortFields).length && /thinking|adaptive/i.test(text)) {
      fix = { kind: 'think', note: '这个模型不接受思考参数，已去掉后重试（看不到思考摘要，推理强度也不再生效）。', apply: () => { s.effortFields = {}; s.level = undefined; } };
    }
    if (!fix) throw httpError(400, text, r, key);
    done.add(fix.kind);
    fix.apply();
    emit({ type: 'notice', level: 'info', text: fix.note });
  }
}

/* ───────────── OpenAI-compatible ───────────── */

const OPENAI_RESERVED_SOURCES = ['reasoning_details', 'reasoning', 'reasoning_content'];

/** Text of a thinking part: `thinking` is a string, or an array of {type:'text', text}. */
function partThinking(p) {
  if (typeof p.thinking === 'string') return p.thinking;
  if (Array.isArray(p.thinking)) return p.thinking.map((x) => (x && typeof x.text === 'string' ? x.text : typeof x === 'string' ? x : '')).join('');
  return typeof p.text === 'string' ? p.text : '';
}

/**
 * OpenAI-compatible streaming chat.
 * @param {object} r    ResolvedApi from services.cjs
 * @param {string} key  may be empty for a keyless local service
 */
/** The mutable part of a request that the retries adjust. */
const openaiState = (r) => ({
  streamUsage: r.wire.streamUsage !== 'none',
  field: r.wire.maxTokensField === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
  canSwapField: r.wire.maxTokensField === 'auto',
  n: r.maxTokens,
  effortFields: r.effort.fields,
  level: r.effort.level,
});
/** The Chat Completions body for a ResolvedApi and its current state (exported so the checks can compare it with what the first release sent). */
function buildOpenAIBody(r, st = openaiState(r)) {
  const messages = [];
  if (r.system) messages.push({ role: 'system', content: r.system });
  for (const m of r.messages) messages.push({ role: m.role, content: openAiContent(m.content) });
  const body = { model: r.model, messages, stream: true };
  if (st.streamUsage) body.stream_options = { include_usage: true };
  body[st.field] = st.n;
  // custom services' extra fields first, then the reasoning fields (they win); no temperature: GPT-6, Kimi and the reasoning modes reject or ignore it
  Object.assign(body, r.extraBody, st.effortFields);
  for (const f of r.wire.dropFields) delete body[f];
  return body;
}

async function streamOpenAI(r, key, emit, signal) {
  const s = openaiState(r);
  const build = (st) => buildOpenAIBody(r, st);
  const res = await sendWithRetries(r, key, build, s, emit, signal);
  if (!res.ok) throw httpError(res.status, await res.text(), r, key);

  const think = new Set(r.wire.thinkIn);
  const thinkOrder = r.wire.thinkIn.filter((x) => OPENAI_RESERVED_SOURCES.includes(x));
  let full = '';
  let finish = '';
  const split = thinkSplitter((type, text) => {
    // without think-tag in the list a literal <think> is ordinary text; the splitter is only used when it is listed
    if (type === 'text') full += text;
    emit({ type, text });
  });
  const putText = (t) => { if (!t) return; if (think.has('think-tag')) split(t); else { full += t; emit({ type: 'text', text: t }); } };
  const { sawDone } = await readSse(res, signal, (j) => {
    if (j.error) throw Object.assign(new Error((j.error && (j.error.message || j.error)) || '服务返回错误'), { code: 'API_ERROR' });
    const choice = Array.isArray(j.choices) ? j.choices[0] : undefined;
    const delta = choice && choice.delta;
    if (delta) {
      // thinking text: the first listed source that has text in this delta wins (OpenRouter sends the same text twice)
      for (const src of thinkOrder) {
        let t = '';
        if (src === 'reasoning_details') {
          if (Array.isArray(delta.reasoning_details)) t = delta.reasoning_details.map((d) => (d && typeof d.text === 'string' ? d.text : d && typeof d.summary === 'string' ? d.summary : '')).join('');
        } else if (typeof delta[src] === 'string') t = delta[src];
        if (t) { emit({ type: 'thinking', text: t }); break; }
      }
      const c = delta.content;
      if (typeof c === 'string') putText(c);
      else if (Array.isArray(c)) {
        // Mistral with reasoning on: content is a list of parts. Never drop the reply because it is not a string.
        for (const p of c) {
          if (typeof p === 'string') putText(p);
          else if (p && p.type === 'thinking') { const t = partThinking(p); if (t) emit({ type: 'thinking', text: t }); }
          else if (p && p.type === 'text' && typeof p.text === 'string') putText(p.text);
        }
      }
    }
    if (choice && choice.finish_reason) finish = choice.finish_reason;
    if (j.usage) {
      const u = j.usage;
      emit({
        type: 'usage',
        input: u.prompt_tokens ?? u.input_tokens ?? 0,
        output: u.completion_tokens ?? u.output_tokens ?? 0,
        cached: u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? 0,
      });
    }
  }, limitsFor(r).idleMs);
  split.end();
  if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  if (!finish && !(sawDone && full)) throw incomplete();
  return { text: full, stopReason: finish || 'stop' };
}

/* ───────────── Anthropic Messages ───────────── */

/**
 * Anthropic Messages API streaming (Claude, and services that speak the same protocol).
 * @param {object} r    ResolvedApi from services.cjs
 */
const anthropicState = (r) => ({ streamUsage: false, field: 'max_tokens', canSwapField: false, n: r.maxTokens, effortFields: r.effort.fields, level: r.effort.level });
/** The Messages API body for a ResolvedApi and its current state. */
function buildAnthropicBody(r, st = anthropicState(r)) {
  const body = { model: r.model, max_tokens: st.n, stream: true, messages: r.messages.map((m) => ({ role: m.role, content: anthropicContent(m.content) })) };
  if (r.system) body.system = r.system;
  // No temperature / top_p: Claude 5.x returns 400 for any non-default sampling value.
  Object.assign(body, r.extraBody, st.effortFields);
  for (const f of r.wire.dropFields) delete body[f];
  return body;
}

async function streamAnthropic(r, key, emit, signal) {
  const s = anthropicState(r);
  const build = (st) => buildAnthropicBody(r, st);
  const res = await sendWithRetries(r, key, build, s, emit, signal, { 'anthropic-version': r.wire.anthropicVersion });
  if (!res.ok) throw httpError(res.status, await res.text(), r, key);

  let full = '';
  let stop = '';
  let ended = false;
  let input = 0;
  let cached = 0;
  await readSse(res, signal, (j) => {
    if (j.type === 'error') throw Object.assign(new Error((j.error && j.error.message) || '服务返回错误'), { code: (j.error && j.error.type) || 'API_ERROR' });
    if (j.type === 'message_start' && j.message?.usage) {
      input = (j.message.usage.input_tokens || 0) + (j.message.usage.cache_creation_input_tokens || 0) + (j.message.usage.cache_read_input_tokens || 0);
      cached = j.message.usage.cache_read_input_tokens || 0;
    } else if (j.type === 'content_block_delta' && j.delta) {
      if (j.delta.type === 'text_delta' && j.delta.text) { full += j.delta.text; emit({ type: 'text', text: j.delta.text }); }
      else if (j.delta.type === 'thinking_delta' && j.delta.thinking) emit({ type: 'thinking', text: j.delta.thinking });
    } else if (j.type === 'message_delta') {
      if (j.delta?.stop_reason) stop = j.delta.stop_reason;
      if (j.usage) emit({ type: 'usage', input, output: j.usage.output_tokens || 0, cached });
    } else if (j.type === 'message_stop') ended = true;
  }, limitsFor(r).idleMs);
  if (signal.aborted) throw Object.assign(new Error('已停止'), { code: 'ABORTED' });
  if (!ended && !stop) throw incomplete();
  return { text: full, stopReason: stop };
}

module.exports = { streamOpenAI, streamAnthropic, buildOpenAIBody, buildAnthropicBody, buildHeaders, thinkSplitter, httpError, authHeaders, readSse, openAiContent, anthropicContent, limitsFor, __setLimits };
