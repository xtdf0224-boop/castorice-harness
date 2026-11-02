// Claude Agent SDK 的消息流 → 栖枝的 StreamEvent（src/lib/desktop.ts）。纯函数式的状态机，不碰 I/O，check-engine 直接喂样本测。
//
// handle(msg) 会通过 emit 发出 session / model / text / thinking / text-break / tool / tool-end / plan / usage /
// notice / rate-limit 事件；遇到 result 时返回一个归一化的结果对象，由驱动决定怎么收尾（done / error / 继续等排队的回合）。
const { summarizeInput, flattenOutput } = require('./proc.cjs');

/** 不显示成"工具行"的内部工具：提问和计划走 question / plan-ready，ToolSearch 是 claude 自己加载延迟工具. */
const QUIET_TOOLS = new Set(['askuserquestion', 'exitplanmode', 'enterplanmode', 'toolsearch']);

const API_ERROR_TEXT = {
  authentication_failed: '认证失败：claude 没有登录，或 API 密钥不对。',
  oauth_org_not_allowed: '这个账号所在的组织不允许使用 Claude Code。',
  account_on_hold: '账号被暂停了。',
  verification_required: '账号需要先完成验证。',
  billing_error: '账单有问题（额度或付款方式）。',
  rate_limit: '触到了限流。',
  overloaded: 'Claude 服务现在很忙。',
  invalid_request: '请求被拒绝（参数不合法）。',
  model_not_found: '找不到这个模型。',
  server_error: 'Claude 服务出了点问题。',
  max_output_tokens: '回复超过了输出长度上限。',
  cloud_credential_error: '云服务凭据有问题。',
  unknown: '未知的接口错误。',
};
const API_ERROR_CODE = {
  authentication_failed: 'AUTH', oauth_org_not_allowed: 'AUTH', account_on_hold: 'AUTH', verification_required: 'AUTH',
  billing_error: 'BILLING', rate_limit: 'RATE_LIMIT', overloaded: 'OVERLOADED', server_error: 'API_ERROR', invalid_request: 'API_ERROR',
  model_not_found: 'API_ERROR', max_output_tokens: 'MAX_OUTPUT', cloud_credential_error: 'AUTH', unknown: 'API_ERROR',
};

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** result.modelUsage（含子代理，累计）→ 总量；没有就退回主循环的 usage. */
function totalsOf(result) {
  let input = 0; let output = 0; let cacheRead = 0;
  const mu = result.modelUsage && typeof result.modelUsage === 'object' ? Object.values(result.modelUsage) : [];
  for (const u of mu) {
    input += num(u.inputTokens) + num(u.cacheReadInputTokens) + num(u.cacheCreationInputTokens);
    output += num(u.outputTokens);
    cacheRead += num(u.cacheReadInputTokens);
  }
  if (!mu.length && result.usage) {
    const u = result.usage;
    input = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    output = num(u.output_tokens);
    cacheRead = num(u.cache_read_input_tokens);
  }
  return { cost: num(result.total_cost_usd), input, output, cacheRead };
}

/** 主循环这一回合自己的用量（不含子代理）。 */
function turnUsageOf(result) {
  const u = result.usage || {};
  return {
    input: num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
  };
}

function createMapper(emit, opts = {}) {
  let sessionId = opts.sessionId || null;
  /** tool_use_id → { name, sub } */
  const tools = new Map();
  /** message.id → 最近一次 usage（一条消息会分成好几条 assistant 带同一个 id） */
  const usageByMessage = new Map();
  /** 收到过文本增量的 message.id；没流式的端点靠 assistant 消息补文本 */
  const streamed = new Set();
  let currentStreamMsg = '';
  let turnText = '';
  let lastTurnText = '';
  let finalText = '';
  let lastError = '';
  let init = null;

  const emitUsage = () => {
    let input = 0; let output = 0; let cached = 0;
    for (const u of usageByMessage.values()) {
      input += num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
      output += num(u.output_tokens);
      cached += num(u.cache_read_input_tokens);
    }
    const last = [...usageByMessage.values()].pop();
    const context = last ? num(last.input_tokens) + num(last.cache_read_input_tokens) + num(last.cache_creation_input_tokens) + num(last.output_tokens) : undefined;
    emit({ type: 'usage', total: true, input, output, cached, context });
  };

  function onAssistant(m) {
    const msg = m.message || {};
    const sub = !!m.parent_tool_use_id;
    if (m.error) lastError = String(m.error);
    if (!sub && msg.id && msg.usage) { usageByMessage.set(msg.id, msg.usage); emitUsage(); }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type === 'text' && b.text && !sub && msg.id && !streamed.has(msg.id)) {
        // 端点没有流式增量：整段文本到这里才有
        turnText += b.text;
        emit({ type: 'text', text: b.text });
        continue;
      }
      if (b.type !== 'tool_use' || tools.has(b.id)) continue;
      const lower = String(b.name || '').toLowerCase();
      tools.set(b.id, { name: b.name, sub, quiet: QUIET_TOOLS.has(lower) });
      if (QUIET_TOOLS.has(lower)) continue;
      if (b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
        emit({ type: 'plan', entries: b.input.todos.map((t) => ({ text: String(t.content || t.activeForm || ''), status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending' })) });
        tools.get(b.id).quiet = true;
        continue;
      }
      if (!sub) emit({ type: 'text-break' });
      const title = summarizeInput(b.input) || String(b.name);
      emit({ type: 'tool', callId: b.id, name: b.name, input: b.input || {}, title: sub ? `↳ ${title}` : title });
    }
  }

  function onUser(m) {
    const content = m.message && Array.isArray(m.message.content) ? m.message.content : [];
    for (const b of content) {
      if (b.type !== 'tool_result') continue;
      const t = tools.get(b.tool_use_id);
      if (!t || t.quiet) continue;
      emit({ type: 'tool-end', callId: b.tool_use_id, ok: !b.is_error, output: flattenOutput(b.content) });
    }
  }

  function onStream(m) {
    if (m.parent_tool_use_id) return;
    const e = m.event || {};
    if (e.type === 'message_start' && e.message && e.message.id) { currentStreamMsg = e.message.id; return; }
    if (e.type === 'content_block_delta' && e.delta) {
      if (e.delta.type === 'text_delta' && e.delta.text) {
        if (currentStreamMsg) streamed.add(currentStreamMsg);
        turnText += e.delta.text;
        emit({ type: 'text', text: e.delta.text });
      } else if (e.delta.type === 'thinking_delta' && e.delta.thinking) {
        emit({ type: 'thinking', text: e.delta.thinking });
      }
    }
  }

  function onResult(m) {
    if (m.session_id && m.session_id !== sessionId) { sessionId = m.session_id; emit({ type: 'session', sessionId }); }
    const text = typeof m.result === 'string' ? m.result : '';
    lastTurnText = turnText || text;
    finalText = finalText ? `${finalText}\n\n${lastTurnText}` : lastTurnText;
    if (!turnText && text && !m.is_error) emit({ type: 'text', text });
    turnText = '';
    const isError = !!m.is_error || (typeof m.subtype === 'string' && m.subtype !== 'success');
    let code = '';
    let message = '';
    if (isError) {
      if (m.subtype === 'error_max_budget_usd') { code = 'BUDGET'; message = '这次运行用到了预算上限，已经停下。'; }
      else if (m.subtype === 'error_max_turns') { code = 'MAX_TURNS'; message = '达到了最大回合数，已经停下。'; }
      else {
        code = API_ERROR_CODE[lastError] || m.subtype || 'CLI_ERROR';
        message = text || API_ERROR_TEXT[lastError] || m.subtype || 'Claude Code 出错';
        if (lastError && API_ERROR_TEXT[lastError] && !text.includes(API_ERROR_TEXT[lastError])) message = `${API_ERROR_TEXT[lastError]}${text ? `\n${text}` : ''}`;
      }
    }
    return {
      kind: 'result', subtype: m.subtype, isError, code, message, text, turnText: lastTurnText, finalText,
      queued: typeof m.queued_turn_count === 'number' ? m.queued_turn_count : undefined,
      stopReason: m.stop_reason || m.subtype, terminal: m.terminal_reason,
      totals: totalsOf(m), turnUsage: turnUsageOf(m), sessionId, deferred: m.stop_reason === 'tool_deferred' || m.terminal_reason === 'tool_deferred',
    };
  }

  return {
    get sessionId() { return sessionId; },
    get init() { return init; },
    get lastTurnText() { return lastTurnText; },
    get turnText() { return turnText; },
    get finalText() { return finalText; },
    /** 一条 SDK 消息 → 事件；result 时返回归一化结果，其余返回 undefined. */
    handle(m) {
      if (!m || typeof m !== 'object') return undefined;
      switch (m.type) {
        case 'system':
          if (m.subtype === 'init') {
            if (m.session_id && m.session_id !== sessionId) { sessionId = m.session_id; emit({ type: 'session', sessionId }); }
            if (m.model) emit({ type: 'model', model: m.model });
            init = { permissionMode: m.permissionMode, model: m.model, tools: m.tools, apiKeySource: m.apiKeySource, version: m.claude_code_version };
          } else if (m.subtype === 'api_retry') {
            const why = API_ERROR_TEXT[m.error] || (m.error_status ? `HTTP ${m.error_status}` : '连接问题');
            emit({ type: 'notice', level: 'warn', text: `连接 Claude 没成功（${why.replace(/。$/, '')}），${Math.max(1, Math.round(num(m.retry_delay_ms) / 1000))} 秒后重试（第 ${m.attempt}/${m.max_retries} 次）。` });
          } else if (m.subtype === 'compact_boundary') {
            emit({ type: 'notice', level: 'info', text: '对话较长，claude 已自动压缩了上下文。' });
          } else if (m.subtype === 'permission_denied' && m.decision_reason_type === 'classifier') {
            emit({ type: 'notice', level: 'warn', text: `自动模式的分类器没有放行「${m.tool_name || '这次调用'}」：${String(m.decision_reason || '').slice(0, 160)}` });
          }
          return undefined;
        case 'stream_event': onStream(m); return undefined;
        case 'assistant': onAssistant(m); return undefined;
        case 'user': onUser(m); return undefined;
        case 'rate_limit_event':
          if (m.rate_limit_info && typeof m.rate_limit_info === 'object') emit({ type: 'rate-limit', info: m.rate_limit_info });
          return undefined;
        case 'result': return onResult(m);
        default: return undefined;
      }
    },
    /** 下一个回合开始前清掉回合内的累计文本. */
    nextTurn() { turnText = ''; },
  };
}

module.exports = { createMapper, totalsOf, turnUsageOf, QUIET_TOOLS, API_ERROR_TEXT, API_ERROR_CODE };
