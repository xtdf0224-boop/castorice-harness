/* render.mjs / native-check.mjs 共用：重任务纪律（等机器空闲、持 .heavy-lock、低优先级）、vite dev（源码镜像）、无头 Chrome（CDP）。 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WORK = 'G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo';
export const LOCK = 'G:/Claude Code Workplace/castorice-harness/perf-work/av/.heavy-lock';
export const FFMPEG = 'G:/Claude Code Workplace/tools/ffmpeg/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

export function lowerPriority() { try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* 子进程继承低优先级 */ } }

/* ───── 开跑前：别的重任务在吗？ ───── */
function busyReason() {
  let names = '';
  try { names = execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8' }); } catch { /* ignore */ }
  const hit = names.split('\n').map((l) => l.split('","')[0].replace(/^"/, '').toLowerCase()).filter((n) => /^(ffmpeg|x265|x264|handbrake|handbrakecli|blender|obs64|premiere|davinci|resolve|rendersvc)/.test(n));
  if (hit.length) return 'running: ' + [...new Set(hit)].join(',');
  return null;
}
async function cpuLoad(ms = 3000) {
  const a = os.cpus().map((c) => ({ ...c.times }));
  await sleep(ms);
  const b = os.cpus().map((c) => ({ ...c.times }));
  let idle = 0, tot = 0;
  b.forEach((t, i) => { const d = { idle: t.idle - a[i].idle, all: Object.keys(t).reduce((s, k) => s + t[k] - a[i][k], 0) }; idle += d.idle; tot += d.all; });
  return 1 - idle / tot;
}
export async function waitQuiet(skip = false) {
  if (skip) return;
  const t0 = Date.now();
  for (;;) {
    const why = busyReason();
    const load = why ? 1 : await cpuLoad();
    if (!why && load < 0.5) { log(`machine quiet (cpu ${(load * 100).toFixed(0)}%)`); return; }
    if (Date.now() - t0 > 60 * 60 * 1000) throw new Error('machine busy for 60 min: ' + (why || `cpu ${(load * 100).toFixed(0)}%`));
    log('waiting:', why || `cpu ${(load * 100).toFixed(0)}%`);
    await sleep(30000);
  }
}
export async function takeLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  for (;;) {
    try { fs.mkdirSync(LOCK); held = true; return; } catch (e) { if (e.code !== 'EEXIST') throw e; log('heavy-lock held, waiting'); await sleep(15000); }
  }
}
let held = false;      // 只释放自己拿到的锁
export const release = () => { if (!held) return; held = false; try { fs.rmSync(LOCK, { recursive: true, force: true }); } catch { /* ignore */ } };

/* ───── vite dev + Chrome ───── */
export async function startVite(SRC, PORT) {
  if (!fs.existsSync(path.join(SRC, 'package.json'))) throw new Error(`源码镜像不存在：${SRC}（先 bash make-render-src.sh）`);
  const p = spawn(process.execPath, [path.join(SRC, 'node_modules/vite/bin/vite.js'), '--config', path.join(HERE, 'vite.render.config.mjs')], {
    cwd: SRC, env: { ...process.env, BV_ROOT: SRC, BV_PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write('[vite] ' + d));
  p.stderr.on('data', (d) => process.stderr.write('[vite] ' + d));
  for (let i = 0; i < 150; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) return p; } catch { /* retry */ }
    await sleep(200);
  }
  p.kill();
  throw new Error('vite did not start');
}

export async function launchChrome(VW, VH, DPR = 1) {
  const port = 20000 + Math.floor(Math.random() * 30000);
  const prof = path.join(WORK, 'chrome-profile');
  fs.rmSync(prof, { recursive: true, force: true });
  fs.mkdirSync(prof, { recursive: true });
  const proc = spawn(CHROME, [
    '--headless=new', `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, `--window-size=${VW},${VH}`,
    '--hide-scrollbars', '--mute-audio', `--force-device-scale-factor=${DPR}`, '--force-color-profile=srgb', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    '--font-render-hinting=none', 'about:blank',
  ], { stdio: 'ignore' });
  let list;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/list`); list = await r.json(); if (list.length) break; } catch { /* retry */ }
    await sleep(200);
  }
  if (!list) throw new Error('chrome did not start');
  const page = list.find((x) => x.type === 'page') || list[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.method === 'Runtime.exceptionThrown') console.error('[page exception]', (d.params.exceptionDetails.exception?.description || '').slice(0, 300));
    if (d.method === 'Runtime.consoleAPICalled' && ['error'].includes(d.params.type)) console.error('[console]', d.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 300));
    if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const close = async () => { try { ws.close(); } catch { /* ignore */ } try { proc.kill(); } catch { /* ignore */ } await sleep(300); };
  return { send, close };
}

