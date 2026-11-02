// 假的 dsh（check-engine 用）：把 --patch 指向的 yml 在运行当时是否存在、内容是什么，记到 FAKE_DSH_SEEN，然后按 --json 协议回几行。
const fs = require('node:fs');

const args = process.argv.slice(2);
const i = args.indexOf('--patch');
const patch = i >= 0 ? args[i + 1] : '';
let content = '';
let existed = false;
try { content = fs.readFileSync(patch, 'utf8'); existed = true; } catch { /* 没有 */ }
if (process.env.FAKE_DSH_SEEN) fs.writeFileSync(process.env.FAKE_DSH_SEEN, JSON.stringify({ patch, existed, content, mode: process.env.DSH_PERMISSION_MODE || '' }));
process.stdin.resume();
process.stdin.on('data', () => {});
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'session', sessionId: 'dsh-1' }));
  console.log(JSON.stringify({ type: 'text', text: 'hi' }));
  console.log(JSON.stringify({ type: 'final', text: 'hi' }));
});
