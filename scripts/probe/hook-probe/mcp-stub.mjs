// 最小的 stdio MCP 服务（探针用）：一个工具 ping，被调用时写标记文件，证明它真的执行了。
// 用法：node mcp-stub.mjs <标记文件路径>
import fs from 'node:fs';
import readline from 'node:readline';

const marker = process.argv[2];
const rl = readline.createInterface({ input: process.stdin });
const send = (obj) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...obj })}\n`);

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    send({ id: msg.id, result: { protocolVersion: msg.params?.protocolVersion || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'stub', version: '0.0.1' } } });
  } else if (msg.method === 'tools/list') {
    send({ id: msg.id, result: { tools: [{ name: 'ping', description: 'Probe tool: writes a marker file and returns pong.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }] } });
  } else if (msg.method === 'tools/call') {
    if (marker) { try { fs.writeFileSync(marker, 'pong\n'); } catch { /* ignore */ } }
    send({ id: msg.id, result: { content: [{ type: 'text', text: 'pong' }] } });
  } else if (msg.id !== undefined && msg.method) {
    send({ id: msg.id, error: { code: -32601, message: 'not supported' } });
  }
});
