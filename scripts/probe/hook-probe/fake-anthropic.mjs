// 本机假 Anthropic Messages 服务（X17 钩子探针用，也可给别的无头测试复用）。
// 只监听 127.0.0.1 的随机端口；流式 SSE；按"脚本"依次回放 tool_use / 文本。不联网、不花额度。
//
// 用法：
//   const fake = await startFakeAnthropic();
//   fake.queue([ turn, turn, … ]);          // 主模型的回合脚本，先进先出
//   // 跑 SDK：env 里放 ANTHROPIC_BASE_URL=fake.url、ANTHROPIC_API_KEY=任意假值、CLAUDE_CONFIG_DIR=临时目录
//   fake.requests                           // 每个请求的摘要（模型、工具名、最后一条 tool_result…）
//   await fake.close();
//
// 一个 turn：{ blocks: Block[] | ((req) => Block[]), stop?: 'tool_use'|'end_turn', delayMs?: number }
//   Block：{ type: 'text', text } | { type: 'tool_use', name, input }   （id 自动生成）
// 小模型（model 以 FAST_MODEL 开头）的请求不消耗脚本，永远回一句短文本。
// fake.sideByNoTools = true 时，没有带工具列表的请求也按小模型处理（claude-compat 把所有模型槽钉成同一个模型，后台小请求与主请求同名，只能这样认）。
import http from 'node:http';

export const FAST_MODEL = 'fake-haiku';

let idSeq = 0;
const nextId = (p) => `${p}_probe${(++idSeq).toString(36).padStart(4, '0')}`;

function summarizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);
  return content.map((c) => (c && typeof c.text === 'string' ? c.text : c && c.type === 'image' ? '[image]' : JSON.stringify(c))).join('\n');
}

/** 请求摘要：不留整份 body（里面有一大段系统提示），只留判断用的字段。 */
function summarizeRequest(body, url) {
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const results = [];
  let lastUserText = '';
  // 最后一条 user 消息里的 tool_result / text（assistant 消息跳过）
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    if (Array.isArray(m.content)) {
      for (const b of m.content) {
        if (b.type === 'tool_result') results.push({ tool_use_id: b.tool_use_id, is_error: !!b.is_error, content: summarizeContent(b.content).slice(0, 600) });
        else if (b.type === 'text') lastUserText += `${b.text}\n`;
      }
    } else if (typeof m.content === 'string') lastUserText = m.content;
    break;
  }
  const system = Array.isArray(body.system) ? body.system.map((s) => s.text || '').join('\n') : String(body.system || '');
  // 计划模式的提示里写着计划文件放在哪（CLAUDE_CONFIG_DIR/plans/xxx.md）；脚本要照这个路径写计划。
  const allText = msgs.map((m) => (typeof m.content === 'string' ? m.content : (m.content || []).map((b) => b.text || '').join('\n'))).join('\n');
  const planFile = (allText.match(/create your plan at (\S+?\.md) using the Write tool/) || [])[1];
  return {
    n: 0,
    url,
    model: body.model,
    stream: !!body.stream,
    tools: Array.isArray(body.tools) ? body.tools.map((t) => t.name) : [],
    messageCount: msgs.length,
    system: system.slice(0, 160).replace(/\s+/g, ' '),
    lastUserText: lastUserText.trim().slice(0, 400),
    toolResults: results,
    planFile,
    /** 自动模式的安全分类器请求（系统提示里自称 security monitor）：不消耗脚本，按 setClassifier 回复。 */
    classifier: /security monitor for autonomous AI coding agents/.test(system),
    _systemFull: system,
    _lastUserTextFull: lastUserText,
  };
}

function sse(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function streamMessage(res, model, blocks, stop) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
  const msgId = nextId('msg');
  sse(res, 'message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  blocks.forEach((b, index) => {
    if (b.type === 'text') {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
    } else {
      sse(res, 'content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
      sse(res, 'content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
    }
    sse(res, 'content_block_stop', { type: 'content_block_stop', index });
  });
  sse(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 24 } });
  sse(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

function jsonMessage(res, model, blocks, stop) {
  const content = blocks.map((b) => (b.type === 'text' ? { type: 'text', text: b.text } : { type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} }));
  const body = JSON.stringify({ id: nextId('msg'), type: 'message', role: 'assistant', model, content, stop_reason: stop, stop_sequence: null, usage: { input_tokens: 120, output_tokens: 24, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}

export async function startFakeAnthropic({ keepBodies = false } = {}) {
  const script = [];
  const requests = [];
  const sockets = new Set();
  let counter = 0;
  let classifierMode = 'garbage';

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = req.url || '';
      let body = {};
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { body = {}; }
      if (req.method === 'POST' && /\/v1\/messages\/count_tokens/.test(url)) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      if (req.method !== 'POST' || !/\/v1\/messages(\?|$)/.test(url)) {
        requests.push({ n: ++counter, url, method: req.method, other: true });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'fake server: not found' } }));
        return;
      }
      const sum = summarizeRequest(body, url);
      sum.n = ++counter;
      if (keepBodies) sum.body = body;
      // 测试里要核对：到底是哪把密钥（假的）发到了这里
      sum.apiKey = String(req.headers['x-api-key'] || '');
      sum.hasAuthorization = !!req.headers.authorization;
      const model = String(body.model || 'claude-sonnet-5-5');
      const side = model.startsWith(FAST_MODEL) || (api.sideByNoTools === true && sum.tools.length === 0 && !sum.classifier);
      sum.side = side;
      requests.push(sum);
      let blocks;
      let stop = 'end_turn';
      let delayMs = 0;
      if (side) {
        blocks = [{ type: 'text', text: 'ok' }];
      } else if (sum.classifier) {
        // 分类器约定：<severity>N</severity>，N<50 放行，>50 拦截（可带 <category>）；'garbage' = 看不懂的回复
        const verdict = classifierMode === 'allow' ? '<severity>8</severity>'
          : classifierMode === 'block' ? '<severity>90</severity><category>Data Exfiltration</category>'
            : '我无法判断。';
        blocks = [{ type: 'text', text: verdict }];
        sum.replied = [`classifier:${classifierMode}`];
      } else {
        const turn = script.shift();
        if (turn) {
          const raw = typeof turn.blocks === 'function' ? turn.blocks(sum) : turn.blocks;
          blocks = raw.map((b) => (b.type === 'tool_use' ? { ...b, id: b.id || nextId('toolu') } : b));
          stop = turn.stop || (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
          delayMs = turn.delayMs || 0;
          sum.replied = blocks.map((b) => (b.type === 'tool_use' ? `tool_use:${b.name}` : 'text'));
        } else {
          blocks = [{ type: 'text', text: '（探针脚本已用完）' }];
          sum.replied = ['text(script-empty)'];
        }
      }
      const send = () => { if (body.stream) streamMessage(res, model, blocks, stop); else jsonMessage(res, model, blocks, stop); };
      if (delayMs) setTimeout(send, delayMs); else send();
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const api = {
    url: `http://127.0.0.1:${port}`,
    port,
    sideByNoTools: false,
    requests,
    queue(turns) { script.push(...turns); },
    pending: () => script.length,
    /** 'allow' | 'block' | 'garbage'：自动模式的安全分类器怎么答。 */
    setClassifier(mode) { classifierMode = mode; },
    reset() { script.length = 0; requests.length = 0; counter = 0; classifierMode = 'garbage'; },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  return api;
}
