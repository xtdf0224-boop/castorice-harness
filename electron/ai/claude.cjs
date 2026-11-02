// Claude Code driver: `claude -p` with stream-json in and out. Permission prompts come back to us
// as control requests (the same channel the Agent SDK uses), so the workbench can show its own
// 待确认操作 card and answer allow / deny. Also drives Claude Code against another vendor's
// Anthropic-compatible endpoint (DeepSeek, Kimi, GLM, MiniMax, 豆包, Qwen) when `env` points it there.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnCli, killTree, parseJson, summarizeInput, flattenOutput } = require('./proc.cjs');

function tmpFile(prefix, content) {
  const f = path.join(os.tmpdir(), `alight-${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(f, content, 'utf8');
  return f;
}

/**
 * spec: { exe, cwd, prompt, system, sessionId?, model?, access: 'chat'|'work', allow: string[], deny: string[], env,
 *         costDelta?: (sessionId, 累计 total_cost_usd, 是否 resume) => 这一回合的花费 | undefined（result 里的 total_cost_usd 是会话累计值，
 *         不换成增量，页面逐回合累加会把前面的回合重复计入；没给就只在新会话的第一回合报）,
 *         mcpJson?: 浏览器 MCP 的 JSON 字符串（只在 exe 是真正的 .exe 时用，不写临时文件）, permissionMode?: 'default'|'acceptEdits' }
 * spec.onlyTools?: string[]：只有这些工具存在（--tools），它请求别的权限就地拒绝，不问页面（桌宠的联网答疑）。
 * 这是旧的 stream-json 驱动：Agent SDK 驱动（claude-sdk.cjs）不可用或被用户关掉时的退路，没有钩子、没有提问卡、没有计划审批。
 * Returns a controller: { send(text), answer(requestId, decision), interrupt(), stop(), done: Promise }
 */
function buildArgs(spec, sysFile) {
  // -p skips the workspace-trust dialog: never load a project's own .claude settings (hooks!) or
  // .mcp.json from a folder that may be untrusted. Only the user's settings and our MCP server apply.
  const args = ['-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--setting-sources', 'user', '--strict-mcp-config'];
  if (sysFile) args.push('--append-system-prompt-file', sysFile);
  if (spec.sessionId) args.push('--resume', spec.sessionId);
  if (spec.model) args.push('--model', spec.model);
  if (spec.effort) args.push('--effort', spec.effort);
  for (const dir of spec.addDirs || []) args.push('--add-dir', dir);
  if (spec.mcpJson) args.push('--mcp-config', spec.mcpJson);
  if (spec.permissionMode && spec.permissionMode !== 'default') args.push('--permission-mode', spec.permissionMode);
  if (spec.access === 'chat') {
    args.push('--tools', '');
  } else if (Array.isArray(spec.onlyTools) && spec.onlyTools.length) {
    args.push('--permission-prompt-tool', 'stdio', '--tools', spec.onlyTools.join(','), '--allowedTools', spec.onlyTools.join(','));
  } else {
    args.push('--permission-prompt-tool', 'stdio');
    if (spec.allow && spec.allow.length) args.push('--allowedTools', spec.allow.join(','));
    if (spec.deny && spec.deny.length) args.push('--disallowedTools', spec.deny.join(','));
  }
  return args;
}

function runClaude(spec, emit) {
  const sysFile = spec.system ? tmpFile('sys', spec.system) : null;
  const args = buildArgs(spec, sysFile);

  let sessionId = spec.sessionId || null;
  let stderr = '';
  let finalText = '';
  let lastTurnText = '';
  let turnText = '';
  let sentTurns = 0;
  let results = 0;
  let finished = false;
  let interrupted = false;
  const usageByMessage = new Map();
  const tools = new Map(); // tool_use_id → { name, input }
  let reqSeq = 0;
  let costAcc;   // 这个进程里各回合花费的增量之和（队列里并进来的回合也算）
  let settle;
  let resolveDone;
  const done = new Promise((r) => { resolveDone = r; });

  const only = Array.isArray(spec.onlyTools) && spec.onlyTools.length ? new Set(spec.onlyTools.map((t) => String(t).toLowerCase())) : null;
  const write = (obj) => { try { child.stdin.write(`${JSON.stringify(obj)}\n`); } catch { /* closed */ } };
  const finish = (ev) => {
    if (finished) return;
    finished = true;
    try { child.stdin.end(); } catch { /* closed */ }
    if (sysFile) fs.unlink(sysFile, () => {});
    emit(ev);
    resolveDone();
  };
  const emitUsage = () => {
    let input = 0; let output = 0; let cached = 0;
    for (const u of usageByMessage.values()) {
      input += (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      output += u.output_tokens || 0;
      cached += u.cache_read_input_tokens || 0;
    }
    const last = [...usageByMessage.values()].pop();
    const context = last ? (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0) + (last.output_tokens || 0) : undefined;
    emit({ type: 'usage', total: true, input, output, cached, context });
  };

  const child = spawnCli(spec.exe, args, {
    cwd: spec.cwd,
    env: spec.env,
    onErr: (d) => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); },
    onLine: (line) => {
      const ev = parseJson(line);
      if (!ev) { emit({ type: 'stdout', text: line.slice(0, 2000) }); return; }
      switch (ev.type) {
        case 'system':
          if (ev.session_id && ev.session_id !== sessionId) { sessionId = ev.session_id; emit({ type: 'session', sessionId }); }
          if (ev.subtype === 'init' && ev.model) emit({ type: 'model', model: ev.model });
          break;
        case 'stream_event': {
          clearTimeout(settle);
          const e = ev.event || {};
          if (e.type === 'content_block_delta' && e.delta) {
            if (e.delta.type === 'text_delta' && e.delta.text) { turnText += e.delta.text; emit({ type: 'text', text: e.delta.text }); }
            else if (e.delta.type === 'thinking_delta' && e.delta.thinking) emit({ type: 'thinking', text: e.delta.thinking });
          }
          break;
        }
        case 'assistant': {
          const msg = ev.message || {};
          if (msg.id && msg.usage) { usageByMessage.set(msg.id, msg.usage); emitUsage(); }
          for (const b of Array.isArray(msg.content) ? msg.content : []) {
            if (b.type !== 'tool_use' || tools.has(b.id)) continue;
            tools.set(b.id, { name: b.name, input: b.input });
            if (b.name === 'TodoWrite' && b.input && Array.isArray(b.input.todos)) {
              emit({ type: 'plan', entries: b.input.todos.map((t) => ({ text: String(t.content || t.activeForm || ''), status: t.status === 'completed' ? 'completed' : t.status === 'in_progress' ? 'in_progress' : 'pending' })) });
              continue;
            }
            emit({ type: 'text-break' });
            emit({ type: 'tool', callId: b.id, name: b.name, input: b.input || {}, title: summarizeInput(b.input) });
          }
          break;
        }
        case 'user': {
          const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
          for (const b of content) {
            if (b.type !== 'tool_result') continue;
            const t = tools.get(b.tool_use_id);
            if (!t || t.name === 'TodoWrite') continue;
            emit({ type: 'tool-end', callId: b.tool_use_id, ok: !b.is_error, output: flattenOutput(b.content) });
          }
          break;
        }
        case 'control_request': {
          const r = ev.request || {};
          if (r.subtype === 'can_use_tool' && only && !only.has(String(r.tool_name).toLowerCase())) {
            write({ type: 'control_response', response: { subtype: 'success', request_id: ev.request_id, response: { behavior: 'deny', message: `这次运行只能用 ${spec.onlyTools.join(' / ')}，不能用「${r.tool_name}」。` } } });
          } else if (r.subtype === 'can_use_tool') {
            const id = r.tool_use_id || [...tools.entries()].reverse().find(([, t]) => t.name === r.tool_name)?.[0];
            emit({ type: 'permission', requestId: ev.request_id, callId: id, name: r.tool_name, input: r.input || {}, title: summarizeInput(r.input), reason: r.decision_reason || '', blockedPath: r.blocked_path || '' });
          } else {
            // Hooks / MCP messages we did not register: answer so Claude Code does not wait.
            write({ type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: '不支持的请求' } });
          }
          break;
        }
        case 'result': {
          results += 1;
          if (ev.session_id && ev.session_id !== sessionId) { sessionId = ev.session_id; emit({ type: 'session', sessionId }); }
          {
            const d = spec.costDelta ? spec.costDelta(sessionId, ev.total_cost_usd, !!spec.sessionId) : (spec.sessionId || typeof ev.total_cost_usd !== 'number' ? undefined : ev.total_cost_usd);
            if (typeof d === 'number') costAcc = (costAcc || 0) + d;
          }
          const text = typeof ev.result === 'string' ? ev.result : '';
          lastTurnText = turnText || text;
          finalText = finalText ? `${finalText}\n\n${lastTurnText}` : lastTurnText;
          if (!turnText && text) emit({ type: 'text', text });
          turnText = '';
          if (ev.usage) {
            const u = ev.usage;
            emit({ type: 'usage', total: true, input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), output: u.output_tokens || 0, cached: u.cache_read_input_tokens || 0 });
          }
          // Queued sends can be absorbed into the running turn, so count what Claude says is still
          // queued (queued_turn_count) rather than how many messages we sent.
          const queued = typeof ev.queued_turn_count === 'number' ? ev.queued_turn_count : Math.max(0, sentTurns - results);
          clearTimeout(settle);
          if (ev.is_error && !interrupted) {
            finish({ type: 'error', message: text || ev.subtype || 'Claude Code 出错', code: ev.subtype || 'CLI_ERROR', sessionId, costUsd: costAcc });
          } else if (queued === 0 || interrupted) {
            finish({ type: 'done', text: lastTurnText, stopReason: interrupted ? 'interrupted' : ev.subtype, sessionId, costUsd: costAcc });
          } else {
            emit({ type: 'text-break' });
            // Older builds without queued_turn_count: if nothing more arrives, the queue was merged.
            if (typeof ev.queued_turn_count !== 'number') settle = setTimeout(() => finish({ type: 'done', text: lastTurnText, stopReason: ev.subtype, sessionId, costUsd: costAcc }), 3000);
          }
          break;
        }
        default: break;
      }
    },
  });

  child.on('error', (e) => finish({ type: 'error', message: `无法启动 Claude Code：${e.message}`, code: 'SPAWN' }));
  child.on('close', (code) => {
    if (finished) return;
    if (interrupted) { finish({ type: 'done', text: lastTurnText || turnText, stopReason: 'interrupted', sessionId }); return; }
    const tail = stderr.trim().split(/\r?\n/).slice(-6).join('\n');
    finish({ type: 'error', message: tail ? `Claude Code 退出（${code}）：${tail}` : `Claude Code 意外退出（${code}）`, code: `EXIT_${code}`, sessionId });
  });

  const send = (text) => {
    sentTurns += 1;
    write({ type: 'user', session_id: sessionId || '', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null });
  };
  send(spec.prompt);

  return {
    done,
    send,
    answer(requestId, decision, input) {
      const response = decision === 'allow'
        ? { behavior: 'allow', updatedInput: input || {} }
        : { behavior: 'deny', message: '使用者在栖枝里拒绝了这次操作。请换一种不需要它的做法，或说明为什么需要。' };
      write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });
    },
    interrupt() {
      if (finished) return;
      interrupted = true;
      write({ type: 'control_request', request_id: `ff_int_${++reqSeq}`, request: { subtype: 'interrupt' } });
      setTimeout(() => { if (!finished) { try { child.stdin.end(); } catch { /* closed */ } } }, 1500);
      setTimeout(() => { if (!finished) killTree(child); }, 5000);
    },
    stop() {
      if (finished) return;
      interrupted = true;
      killTree(child);
    },
  };
}

module.exports = { runClaude, buildArgs };
