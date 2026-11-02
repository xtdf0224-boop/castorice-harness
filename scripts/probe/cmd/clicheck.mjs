// clicheck：拿真实的 claude.exe（用户自己的那份）对着假 Anthropic 服务跑一遍，确认假服务讲的协议它认——
// 文字回复、tool_use → tool_result → 最终回复、usage。全程假密钥、临时 CLAUDE_CONFIG_DIR、ANTHROPIC_BASE_URL 指向本机：不读真实凭据、不花额度。
//   node scripts/probe/run.mjs clicheck [--cli <claude.exe 路径>]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { reply, startFakeAnthropic, toolUse } from '../fake-anthropic.mjs';
import { tmpRoot } from '../lib/launch.mjs';

function findClaude(explicit) {
  if (explicit) return explicit;
  const w = spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true });
  for (const line of (w.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
    if (/claude\.cmd$/i.test(line)) {
      const exe = path.join(path.dirname(line), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (fs.existsSync(exe)) return exe;
    }
    if (/claude\.exe$/i.test(line)) return line;
  }
  return null;
}

function runClaude(exe, args, env, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const timer = setTimeout(() => { try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }); } catch { /* */ } }, timeoutMs);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
  });
}

export async function runClicheck(ctx) {
  const exe = findClaude(ctx.values.cli);
  if (!exe || !fs.existsSync(exe)) { ctx.log('找不到 claude.exe（用 --cli 指定）'); return 2; }
  const dir = fs.mkdtempSync(path.join(tmpRoot(), 'clicheck-'));
  const cfg = path.join(dir, 'config');
  const work = path.join(dir, 'work');
  fs.mkdirSync(cfg); fs.mkdirSync(work);
  fs.writeFileSync(path.join(work, 'hello.txt'), '探针文件内容\n');
  // 按「请求里有没有 tool_result」应答：没有就要求读文件，有了就给最终回复（对 Claude Code 可能夹带的预检小请求也稳）
  const turnFor = (req) => (req.toolResults.length ? reply('文件里写的是：探针文件内容。', { usage: { input_tokens: 120, output_tokens: 22 } }) : toolUse('Read', { file_path: path.join(work, 'hello.txt') }, { text: '我先读一下文件。' }));
  const fake = await startFakeAnthropic({ defaultTurn: turnFor });
  const env = { ...process.env, ANTHROPIC_BASE_URL: fake.baseUrl, ANTHROPIC_API_KEY: 'sk-ant-probe-fake-0000000000', CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1' };
  for (const k of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) delete env[k];
  const checks = [];
  const add = (name, pass, detail = '') => { checks.push({ name, pass: !!pass, detail }); ctx.log(`${pass ? '✓' : '✗'} ${name}${!pass && detail ? `\n     ${detail}` : ''}`); };
  try {
    ctx.step(`claude ${exe}`);
    const v = await runClaude(exe, ['--version'], env, work, 20000);
    add('claude --version 能跑', v.code === 0, v.out.trim().slice(0, 80) || v.err.slice(0, 200));
    const r = await runClaude(exe, ['-p', '读一下 hello.txt 然后告诉我内容', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--allowedTools', 'Read', '--max-turns', '4'], env, work, 90000);
    const lines = r.out.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const result = lines.find((l) => l.type === 'result');
    add('claude -p 跑完并给出 result 事件', !!result && !result.is_error, `exit=${r.code} ${result ? JSON.stringify(result).slice(0, 300) : r.err.slice(0, 300) || r.out.slice(0, 300)}`);
    add('假服务收到了 ≥2 个 /v1/messages 请求（工具往返）', fake.messageCount >= 2, `请求数 ${fake.messageCount}`);
    add('第二个请求带着 tool_result', fake.requests.some((q) => q.toolResults.length > 0), JSON.stringify(fake.requests.map((q) => [q.n, q.stream, q.toolResults.length])));
    add('最终文字来自假服务', !!result && String(result.result).includes('探针文件内容'), String(result?.result).slice(0, 120));
    add('请求带了假密钥而不是别的凭据', fake.requests.every((q) => !q.hasKey || q.keyHeader), `keyHeader=${fake.requests[0]?.keyHeader}`);
    const usage = result?.usage;
    add('result 带 usage（供 K14 用量采集）', !!usage && usage.output_tokens > 0, JSON.stringify(usage));
    ctx.log(`   请求：${fake.requests.map((q) => `#${q.n} stream=${q.stream} tools=${q.tools.length} toolResults=${q.toolResults.length} → ${q.turn?.blocks?.join('+')}`).join(' | ')}`);
  } finally {
    await fake.close();
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
  }
  const bad = checks.filter((c) => !c.pass);
  ctx.log(`\nclaude CLI 对假服务：${bad.length ? `${bad.length} 项失败` : '通过'}`);
  return bad.length ? 1 : 0;
}
