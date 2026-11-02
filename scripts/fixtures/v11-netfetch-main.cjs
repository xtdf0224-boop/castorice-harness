'use strict';
// V11 (MODELS-SPEC §18, decision D5): may the main process use Electron's net.fetch instead of Node's global fetch?
// Runs in a windowless Electron main process (no BrowserWindow is ever created), against the local fake service only:
//   electron scripts/fixtures/v11-netfetch-main.cjs --user-data-dir=<temp dir>      (ALIGHT_V11_OUT=<file> to keep the JSON)
// Four things must hold: the system / Chromium proxy settings apply, redirect:'error' really refuses a redirect,
// the body can be read as a stream (SSE arrives as it is written), and an AbortSignal ends a stream that is in flight.
const { app, net, session } = require('electron');
const fs = require('node:fs');
const http = require('node:http');
const { startFake } = require('./fake-llm.cjs');

app.disableHardwareAcceleration();
const results = [];
const rec = (name, ok, detail) => { results.push({ name, ok: !!ok, detail: detail === undefined ? '' : String(detail) }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = (url, init = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ stream: true }), credentials: 'omit', ...init });

async function main() {
  const fake = await startFake({ script: 'openai-slow-stream' });

  // 1. streaming read
  {
    const t0 = Date.now();
    const res = await net.fetch(`${fake.baseUrl}/chat/completions`, post(''));
    const reader = res.body.getReader();
    const stamps = [];
    for (;;) { const { value, done } = await reader.read(); if (done) break; stamps.push({ at: Date.now() - t0, n: value.length }); }
    const first = stamps[0] ? stamps[0].at : -1;
    const total = Date.now() - t0;
    rec('net.fetch: 响应体按流读取（第一块早于整个流结束）', res.ok && stamps.length >= 3 && first >= 0 && first < total - 500, `first=${first}ms total=${total}ms chunks=${stamps.length}`);
  }

  // 2. redirect:'error'
  {
    fake.script = 'redirect-302';
    fake.reset();
    let threw = false;
    try { await net.fetch(`${fake.baseUrl}/chat/completions`, post('', { redirect: 'error' })); } catch { threw = true; }
    await sleep(100);
    rec("net.fetch: redirect:'error' 拒绝跟随 302", threw, `threw=${threw}`);
    rec('net.fetch: 没有向重定向目标发请求（密钥不会被带过去）', !fake.requests.some((r) => r.path.startsWith('/elsewhere')), fake.requests.map((r) => r.path).join(','));
  }

  // 3. AbortSignal in flight
  {
    fake.script = 'openai-slow-stream';
    fake.reset();
    const ac = new AbortController();
    const t0 = Date.now();
    const res = await net.fetch(`${fake.baseUrl}/chat/completions`, post('', { signal: ac.signal }));
    const reader = res.body.getReader();
    await reader.read();
    ac.abort();
    let ended = '';
    try { const r = await Promise.race([reader.read().then((x) => (x.done ? 'done' : 'chunk')), sleep(1500).then(() => 'hung')]); ended = r; } catch (e) { ended = `rejected:${e && e.name}`; }
    const took = Date.now() - t0;
    rec('net.fetch: AbortSignal 能在流进行中结束读取', ended !== 'hung' && ended !== 'chunk', `${ended} after ${took}ms`);
    // abort before the response starts
    fake.script = 'slow-first-byte';
    const ac2 = new AbortController();
    const p = net.fetch(`${fake.baseUrl}/chat/completions`, post('', { signal: ac2.signal })).then(() => 'resolved', (e) => `rejected:${e && e.name}`);
    setTimeout(() => ac2.abort(), 100);
    const early = await Promise.race([p, sleep(1500).then(() => 'hung')]);
    rec('net.fetch: AbortSignal 能在首字节之前取消', early !== 'hung' && early !== 'resolved', early);
  }

  // 4. proxy settings apply to net.fetch (Chromium network stack) and not to Node's fetch
  {
    const seen = [];
    const proxy = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.writeHead(200, { 'content-type': 'text/plain' }); res.end('via-proxy'); });
    await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
    const pport = proxy.address().port;
    await session.defaultSession.setProxy({ mode: 'fixed_servers', proxyRules: `http=127.0.0.1:${pport}`});
    let viaNet = '';
    try { const r = await net.fetch('http://proxied.alight-v11.invalid/x', { credentials: 'omit' }); viaNet = await r.text(); } catch (e) { viaNet = `error:${e && e.message}`; }
    rec('net.fetch: 浏览器代理设置对它生效（走了代理）', viaNet === 'via-proxy' && seen.some((l) => /proxied\.alight-v11\.invalid/.test(l)), `${viaNet} seen=${seen.join('|')}`);
    let viaNode = '';
    try { const r = await fetch('http://proxied.alight-v11.invalid/x'); viaNode = await r.text(); } catch (e) { viaNode = `error:${(e.cause && e.cause.code) || e.message}`; }
    rec('对照：Node 的全局 fetch 不走这个代理', viaNode !== 'via-proxy', viaNode);
    // loopback stays direct even with a proxy configured (local services keep working)
    fake.script = 'openai-ok';
    fake.reset();
    const before = seen.length;
    const lr = await net.fetch(`${fake.baseUrl}/chat/completions`, post(''));
    await lr.text();
    rec('net.fetch: 回环地址不经代理（本机服务照常）', lr.ok && fake.requests.length === 1 && seen.length === before, `fake=${fake.requests.length} proxyDelta=${seen.length - before}`);
    await session.defaultSession.setProxy({ mode: 'system' });
    proxy.close();
  }

  // 5. information only: what the system setting says about a typical API host on this machine
  let resolved = '';
  try { resolved = await session.defaultSession.resolveProxy('https://api.openai.com/v1/chat/completions'); } catch (e) { resolved = `error:${e && e.message}`; }
  rec('信息：本机系统代理对 api.openai.com 的解析结果', true, resolved);

  await fake.close();
}

app.whenReady().then(async () => {
  try { await main(); } catch (e) { rec('脚本跑到了最后', false, (e && e.stack) || e); }
  const out = process.env.ALIGHT_V11_OUT;
  const text = JSON.stringify(results);
  if (out) fs.writeFileSync(out, text);
  for (const r of results) console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
  app.exit(results.every((r) => r.ok) ? 0 : 1);
});
