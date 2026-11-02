// baseline：O9 采样（S1 冷启动到可输入、S2 空闲内存、S3 长会话、S5 后台 CPU）。
// 同一套脚本测萤火 v2.0.0（--app-dir 指向 worktree）与当前栖枝；--compare 把结果对照基线 JSON，按「绝对线与基线×1.1 取较严」判定。
// 方法与局限见 docs/BASELINE.md。
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, removeDir, tmpRoot } from '../lib/launch.mjs';
import { LOGICAL_CPUS, cpuBetween, cpuTimes, summarizeMemory, sysBusyPct, treeSnapshot, waitQuiet } from '../lib/proc.mjs';
import { PERF_PROBE_SOURCE, clickText, evaluate, focusSelector, pressKey, readPerf, readProbe, readyProbeSource, sleep, waitUntil } from '../lib/page.mjs';
import { assertSeeded, prepareProfile } from '../lib/profile.mjs';
import { buildPrefs, buildStateBlob } from '../lib/seed.mjs';
import { INPUT_SELECTOR } from '../lib/targets.mjs';
import { gate, percentile, summarize } from '../lib/stats.mjs';
import { describeEnvironment, writeJson } from '../lib/ctx.mjs';
import { CdpConnection } from '../lib/cdp.mjs';
import { detectTarget } from '../lib/targets.mjs';

/** 绝对线（research/08-补充-3 §5.1）。 */
export const LIMITS = {
  s1: { p75Ms: 2500, p95Ms: 5000 },
  s2: { totalMB: 300, rendererMB: 150 },
  s3: { firstScreenMs: 2000, rendererMB: 500, inputP95Ms: 200 },
  s5: { cpuPct: 1 },
};

const SMALL = { id: 'T-small', title: '合成会话 200 条', messages: 200, seed: 7 };
const LONG = { id: 'T-long', title: '合成会话 10000 条', messages: 10000, seed: 9 };

async function waitReady(s, timeoutMs) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const p = await readProbe(s).catch(() => null);
    if (p?.marks?.inputReady !== undefined) return p;
    await sleep(15);
  }
  return null;
}

/** 一次「进程创建 → 可输入」。 */
async function startupRun(ctx, userDataDir, { snapshot = false, timeoutMs = 60000, exePath } = {}) {
  const quiet = await waitQuiet();
  const app = await launchApp({ appDir: ctx.appDir, exePath, userDataDir, keepData: !!userDataDir, init: [readyProbeSource(INPUT_SELECTOR)] });
  try {
    const s = app.page;
    const probe = await waitReady(s, timeoutMs);
    const out = { ok: !!probe, cdpUpMs: Math.round(app.cdpUpMs), sysBusyBeforePct: quiet.pct, noisy: quiet.noisy };
    if (probe) {
      const rel = (n) => (probe.marks[n] === undefined ? null : Math.round(probe.origin + probe.marks[n] - app.t0Wall));
      Object.assign(out, { navStartMs: Math.round(probe.origin - app.t0Wall), dclMs: rel('domContentLoaded'), presentMs: rel('inputPresent'), readyMs: rel('inputReady'), loadMs: rel('load') });
      // 真的能打字：聚焦、插入一个字、读回、清掉
      await focusSelector(s, INPUT_SELECTOR);
      await s.send('Input.insertText', { text: '探' });
      out.typed = (await evaluate(s, `document.querySelector(${JSON.stringify(INPUT_SELECTOR)}).value`)) === '探';
      await pressKey(s, 'a', { mods: ['ctrl'] });
      await pressKey(s, 'Backspace');
      const seeded = await assertSeeded(s, ctx.target, false).catch(() => null);
      out.seededPrefs = seeded?.prefs ?? 0;
    }
    if (snapshot) { await sleep(2500); out.memory = summarizeMemory(treeSnapshot(app.pid)); }
    out.errors = app.errors().map((e) => e.text.slice(0, 200));
    return out;
  } finally {
    const t = performance.now();
    const closed = await app.close({ graceMs: 8000 });
    if (closed.forced) ctx.log('    （应用没有在宽限期内自行退出，已强制结束）');
    ctx.lastCloseMs = Math.round(performance.now() - t);
  }
}

/** 空 Electron 应用（同样的窗口参数、一个空页面）：底噪基线，也是 S1 里「Electron 自己的启动时间」的参照。 */
function makeFloorApp() {
  const dir = path.join(tmpRoot(), `floor-app-${Date.now().toString(36)}`);
  fs.mkdirSync(path.join(dir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'probe-floor', version: '0.0.0', main: 'main.cjs' }));
  fs.writeFileSync(path.join(dir, 'dist', 'index.html'), '<!doctype html><meta charset="utf-8"><title>floor</title><body style="background:#0e0c19;color:#ccc"><textarea class="pbox__input"></textarea><p>空 Electron 底噪</p></body>');
  fs.writeFileSync(path.join(dir, 'main.cjs'), `const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 1440, height: 900, show: false, backgroundColor: '#0e0c19', webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, backgroundThrottling: false } });
  win.loadFile(path.join(__dirname, 'dist', 'index.html'));
});
app.on('window-all-closed', () => app.quit());
`);
  return dir;
}

const electronOf = (appDir) => path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');

/**
 * S1：进程创建 → 主输入框可输入。
 * Electron 本身的启动时间有强烈的双峰（本机实测同一个 electron.exe 有时 ~130 ms 到调试端口、有时 ~870 ms，疑似 Defender 扫描/云查询），
 * 所以单看总时长会被环境噪声淹没：要和基线「同场交错」测（ABAB…），并拆成三段——
 *   Electron 起步（spawn → 导航起点，含主进程 JS 初始化）、页面（导航起点 → 可输入）、总计。
 * 另带空 Electron 应用一起交错，主进程初始化耗时 ≈ 应用的导航起点 − 空应用的导航起点。
 */
export async function measureS1(ctx, { runs, label = 'S1', prefsExtra = {}, vs, floor = true }) {
  const variants = [];
  const profiles = [];
  const floorDir = floor ? makeFloorApp() : null;
  try {
    if (floorDir) variants.push({ key: 'floor', name: '空 Electron', appDir: floorDir, exePath: electronOf(ctx.appDir) });
    if (vs) variants.push({ key: 'ref', name: vs.target.name, ctx: vs });
    variants.push({ key: 'self', name: ctx.target.name, ctx });
    for (const v of variants) {
      if (!v.ctx) continue;
      ctx.step(`${label}：准备配置目录（${v.name}：无任务，关开屏）`);
      const prof = await prepareProfile(v.ctx, { prefs: buildPrefs({ settings: prefsExtra }), label: `s1-${v.key}`, log: ctx.log });
      profiles.push(prof);
      v.userDataDir = prof.userDataDir;
    }
    const by = Object.fromEntries(variants.map((v) => [v.key, []]));
    for (let i = 0; i < runs; i++) {
      for (const v of variants) {
        const r = v.key === 'floor'
          ? await startupRun({ ...ctx, appDir: v.appDir, target: ctx.target }, undefined, { exePath: v.exePath })
          : await startupRun(v.ctx, v.userDataDir, { snapshot: i === 0 && v.key === 'self' });
        by[v.key].push(r);
        ctx.step(`${label} 第 ${i + 1}/${runs} 轮 ${v.name}：${r.ok ? `可输入 ${r.readyMs} ms（Electron 起步 ${r.navStartMs}，页面 ${r.readyMs - r.navStartMs}，DCL ${r.dclMs}）${r.typed || v.key === 'floor' ? '' : ' 但按键没有进入输入框'}` : '超时没有可输入'}${r.errors.length ? ` 控制台错误 ${r.errors.length} 条` : ''}${r.noisy ? `（整机 CPU 忙碌 ${r.sysBusyBeforePct}%）` : ''}`);
        await sleep(500);
      }
    }
    const summarizeVariant = (list, isFloor) => {
      const ok = list.filter((r) => r.ok && (r.typed || isFloor));
      return {
        runs: list, failed: list.length - ok.length,
        first: ok[0]?.readyMs ?? null,
        all: summarize(ok.map((r) => r.readyMs)),
        afterFirst: summarize(ok.slice(1).map((r) => r.readyMs)),
        electronStartMs: summarize(ok.map((r) => r.navStartMs)),
        pageMs: summarize(ok.map((r) => r.readyMs - r.navStartMs)),
        memoryAtReadyPlus2_5s: list[0]?.memory ?? null,
      };
    };
    const out = { ...summarizeVariant(by.self, false) };
    if (by.ref) out.ref = summarizeVariant(by.ref, false);
    if (by.floor) out.floor = summarizeVariant(by.floor, true);
    if (by.ref) {
      const pairs = by.self.map((r, i) => (r.ok && by.ref[i]?.ok ? r.readyMs - by.ref[i].readyMs : NaN)).filter(Number.isFinite);
      const pairedPage = by.self.map((r, i) => (r.ok && by.ref[i]?.ok ? (r.readyMs - r.navStartMs) - (by.ref[i].readyMs - by.ref[i].navStartMs) : NaN)).filter(Number.isFinite);
      out.paired = { deltaTotalMs: summarize(pairs), deltaPageMs: summarize(pairedPage), ratioOfMedians: out.all.median / out.ref.all.median };
    }
    if (by.floor) {
      out.mainProcessInitMs = Math.round(out.electronStartMs.median - out.floor.electronStartMs.median);
      if (out.ref) out.ref.mainProcessInitMs = Math.round(out.ref.electronStartMs.median - out.floor.electronStartMs.median);
    }
    return out;
  } finally {
    for (const p of profiles) removeDir(p.userDataDir);
    if (floorDir) removeDir(floorDir);
  }
}

async function openTask(s, title) {
  await pressKey(s, '2', { mods: ['alt'] });
  await waitUntil(s, `document.title.startsWith('任务列表')`, { timeoutMs: 15000, label: '进入任务列表' });
  const clickAt = await evaluate(s, 'performance.now()');
  const t = performance.now();
  await clickText(s, title, { within: 'main' });
  await waitUntil(s, `document.title.startsWith(${JSON.stringify(title)})`, { timeoutMs: 180000, intervalMs: 100, label: `打开「${title}」` });
  return { clickAt, titleMs: performance.now() - t };
}

/** 通过主进程的 Node 调试端口读 app.getAppMetrics()：percentCPUUsage 与 idleWakeupsPerSecond（O9 S5 的原定义）。只在 --wakeups 时用。 */
async function mainMetricsSampler(app) {
  const list = await (await fetch(`http://127.0.0.1:${app.inspectPort}/json/list`)).json();
  const conn = await CdpConnection.connect(list[0].webSocketDebuggerUrl);
  const read = async () => {
    const r = await conn.send('Runtime.evaluate', { expression: `JSON.stringify(process.mainModule.require('electron').app.getAppMetrics())`, returnByValue: true });
    if (r.exceptionDetails) throw new Error('读取 app.getAppMetrics() 失败');
    const ms = JSON.parse(r.result.value);
    return {
      cpuPct: Math.round(ms.reduce((a, m) => a + (m.cpu?.percentCPUUsage ?? 0), 0) * 100) / 100,
      wakeups: Math.round(ms.reduce((a, m) => a + (m.cpu?.idleWakeupsPerSecond ?? 0), 0) * 10) / 10,
      privateKB: ms.reduce((a, m) => a + (m.memory?.privateBytes ?? 0), 0),
    };
  };
  await read(); // 「自上次调用以来」：先调一次建立起点
  return { read, close: () => conn.close() };
}

/** S2（空闲内存）与 S5（后台 CPU）：同一次静置里同时采。 */
export async function measureIdle(ctx, { durationSec, sampleSec, wakeups = false }) {
  ctx.step(`S2/S5：准备配置目录（1 个 ${SMALL.messages} 条消息的会话）`);
  const prof = await prepareProfile(ctx, { prefs: buildPrefs(), state: buildStateBlob({ tasks: [SMALL] }), label: 'idle', log: ctx.log });
  const app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, inspectMain: wakeups, init: [readyProbeSource(INPUT_SELECTOR)] });
  const out = { durationSec, sampleSec };
  let main = null;
  try {
    const s = app.page;
    const probe = await waitReady(s, 60000);
    if (!probe) throw new Error('应用没有进入可输入状态');
    await assertSeeded(s, ctx.target, false);
    await sleep(8000);
    // A. 首页静置
    const a0 = treeSnapshot(app.pid);
    await sleep(Math.min(20000, sampleSec * 1000));
    const a1 = treeSnapshot(app.pid);
    out.home = { memory: summarizeMemory(a1), cpu: cpuBetween(a0, a1) };
    ctx.step(`S2/S5 首页静置：privateBytes ${out.home.memory.totalMB} MB（渲染 ${out.home.memory.rendererMB}，不含 GPU ${out.home.memory.totalExGpuMB}），私有工作集 ${out.home.memory.privateWorkingSetMB} MB，CPU ${out.home.cpu.totalPct}%`);
    // B. 打开 200 条会话后静置
    const opened = await openTask(s, SMALL.title);
    out.openMs = Math.round(opened.titleMs);
    await sleep(5000);
    if (wakeups) main = await mainMetricsSampler(app).catch((e) => { ctx.log(`  （读不到 getAppMetrics：${e.message}）`); return null; });
    let prev = treeSnapshot(app.pid);
    let prevSys = cpuTimes();
    out.samples = [];
    const t0 = performance.now();
    while ((performance.now() - t0) / 1000 < durationSec) {
      await sleep(sampleSec * 1000);
      const cur = treeSnapshot(app.pid);
      const mem = summarizeMemory(cur);
      const cpu = cpuBetween(prev, cur);
      const nowSys = cpuTimes();
      const am = main ? await main.read().catch(() => null) : null;
      out.samples.push({ tSec: Math.round((performance.now() - t0) / 1000), ...mem, cpuPct: cpu.totalPct, cpuByKind: cpu.byKindPct, sysBusyPct: sysBusyPct(prevSys, nowSys), ...(am ? { appMetrics: am } : {}) });
      prevSys = nowSys;
      ctx.step(`S2/S5 静置 ${out.samples.at(-1).tSec}s：${mem.totalMB} MB（渲染 ${mem.rendererMB}，不含 GPU ${mem.totalExGpuMB}；私有工作集 ${mem.privateWorkingSetMB}），CPU ${cpu.totalPct}%（${Object.entries(cpu.byKindPct).map(([k, v]) => `${k} ${v}`).join('，')}）`);
      prev = cur;
    }
    const last = out.samples.at(-1);
    const tail = out.samples.slice(-Math.max(1, Math.min(3, out.samples.length)));
    const avg = (key) => Math.round((tail.reduce((a, x) => a + x[key], 0) / tail.length) * 10) / 10;
    // 内存取最后 3 个样本的均值（单个样本里 GPU 进程会有 ±30 MB 的抖动）
    out.final = { totalMB: avg('totalMB'), totalExGpuMB: avg('totalExGpuMB'), privateWorkingSetMB: avg('privateWorkingSetMB'), rendererMB: avg('rendererMB'), rendererPrivateWSMB: avg('rendererPrivateWSMB'), workingSetMB: avg('workingSetMB'), byKindMB: last.byKindMB, byKindPrivateWSMB: last.byKindPrivateWSMB, processCount: last.processCount, lastSampleTotalMB: last.totalMB };
    const warm = out.samples.filter((x) => x.tSec >= 60);
    const cpus = (warm.length ? warm : out.samples).map((x) => x.cpuPct);
    const meanCpu = cpus.reduce((a, b) => a + b, 0) / cpus.length;
    out.cpu = { meanPct: Math.round(meanCpu * 100) / 100, maxPct: Math.max(...cpus), samples: cpus.length, pctOfAllCores: Math.round((meanCpu / LOGICAL_CPUS) * 1000) / 1000 };
    if (main) {
      const am = out.samples.filter((x) => x.appMetrics && x.tSec >= 60).map((x) => x.appMetrics);
      if (am.length) out.appMetrics = { samples: am.length, cpuMeanPct: Math.round((am.reduce((a, x) => a + x.cpuPct, 0) / am.length) * 100) / 100, wakeupsMean: Math.round((am.reduce((a, x) => a + x.wakeups, 0) / am.length) * 10) / 10 };
    }
    out.sysBusyMeanPct = Math.round((out.samples.reduce((a, x) => a + x.sysBusyPct, 0) / out.samples.length) * 10) / 10;
    out.visibility = await evaluate(s, 'document.visibilityState');
    out.errors = app.errors().map((e) => e.text.slice(0, 200));
  } finally {
    main?.close();
    await app.close({ graceMs: 8000 });
    removeDir(prof.userDataDir);
  }
  return out;
}

/** 空 Electron 的内存底噪：同样的窗口参数、一个空页面，静置后采 privateBytes——用来判断 S2 的绝对线是否可达。 */
export async function measureFloor(ctx, { settleSec = 25 } = {}) {
  const dir = makeFloorApp();
  const app = await launchApp({ appDir: dir, exePath: electronOf(ctx.appDir), label: 'floor' });
  try {
    await sleep(settleSec * 1000);
    const a = treeSnapshot(app.pid);
    await sleep(8000);
    const b = treeSnapshot(app.pid);
    return { memory: summarizeMemory(b), cpu: cpuBetween(a, b) };
  } finally {
    await app.close({ graceMs: 5000 });
    removeDir(dir);
  }
}

/** S3：10,000 条消息的长会话。 */
export async function measureS3(ctx, { runs }) {
  ctx.step(`S3：准备配置目录（${LONG.messages} 条消息 + ${SMALL.messages} 条消息各一个会话）`);
  const state = buildStateBlob({ tasks: [SMALL, LONG] });
  const prof = await prepareProfile(ctx, { prefs: buildPrefs(), state, label: 's3', log: ctx.log });
  const list = [];
  try {
    for (let i = 0; i < runs; i++) {
      const quiet = await waitQuiet();
      // --osr：离屏 + 60 fps + 软件渲染（见 electron/main.cjs 的 ALIGHT_PROBE_OSR）；默认的隐藏窗口里合成器只有约 1 Hz，Commit 会卡 1 秒
      const app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, env: ctx.values.osr ? { ALIGHT_PROBE_OSR: '1' } : {}, init: [readyProbeSource(INPUT_SELECTOR), PERF_PROBE_SOURCE] });
      const r = { sysBusyBeforePct: quiet.pct, noisy: quiet.noisy, osr: !!ctx.values.osr };
      try {
        const s = app.page;
        const probe = await waitReady(s, 120000);
        if (!probe) throw new Error('应用没有进入可输入状态');
        r.startupMs = Math.round(probe.origin + probe.marks.inputReady - app.t0Wall);
        await sleep(4000);
        r.homeMemory = summarizeMemory(treeSnapshot(app.pid));
        // 打开长会话，直到主线程安静（1.2 s 内没有再出现卡顿）
        const opened = await openTask(s, LONG.title);
        r.titleMs = Math.round(opened.titleMs);
        await waitUntil(s, `(performance.now() - (globalThis.__perf.lastBusyEnd || 0)) > 1200`, { timeoutMs: 180000, intervalMs: 250, label: '主线程安静' });
        const busyEnd = await evaluate(s, 'globalThis.__perf.lastBusyEnd');
        r.openToSettledMs = Math.max(r.titleMs, Math.round(busyEnd - opened.clickAt));
        // 打开阶段的卡顿（只看点击之后）：合并的连续忙碌段 ＝ 用户看到的「卡死」时长
        const perfOpen = await readPerf(s);
        r.openBlockedMs = Math.max(0, ...perfOpen.gaps.filter((g) => g.at >= opened.clickAt).map((g) => g.gap));
        r.openLongTask = { count: perfOpen.long.filter((x) => x.at >= opened.clickAt).length, maxMs: Math.max(0, ...perfOpen.long.filter((x) => x.at >= opened.clickAt).map((x) => x.d)) };
        r.dom = JSON.parse(await evaluate(s, `JSON.stringify({ nodes: document.querySelectorAll('*').length, textareas: document.querySelectorAll('textarea').length })`));
        await sleep(2500);
        r.openMemory = summarizeMemory(treeSnapshot(app.pid));
        // 在长会话底部输入框打字：30 个键，间隔 40 ms，量每个 keyDown 的 CDP 往返（输入排队＋事件处理）
        await focusSelector(s, INPUT_SELECTOR);
        const rt = [];
        for (const ch of 'abcdefghijklmnopqrstuvwxyz0123') { rt.push(await pressKey(s, ch)); await sleep(40); }
        r.typing = { n: rt.length, medianMs: Math.round(percentile(rt, 50)), p95Ms: Math.round(percentile(rt, 95)), maxMs: Math.round(Math.max(...rt)) };
        await sleep(300);
        // 「无响应」：Chromium 在输入事件 15 s 得不到应答时才判定卡死；这里把「打开时连续忙碌 ≥5 s」或「单键往返 ≥5 s」记为风险
        r.maxBlockedMs = Math.round(Math.max(r.openBlockedMs, r.typing.maxMs));
        r.unresponsiveRisk = r.maxBlockedMs >= 5000;
        await pressKey(s, 'a', { mods: ['ctrl'] });
        await pressKey(s, 'Backspace');
        r.errors = app.errors().map((e) => e.text.slice(0, 200));
      } catch (e) { r.error = e.message; } finally { await app.close({ graceMs: 10000 }); }
      list.push(r);
      ctx.step(`S3 第 ${i + 1}/${runs} 次：${r.error ? `失败 ${r.error}` : `启动可输入 ${r.startupMs} ms；打开长会话到安静 ${r.openToSettledMs} ms（打开时连续忙碌 ${r.openBlockedMs} ms）；渲染进程 ${r.openMemory.rendererMB} MB（私有工作集 ${r.openMemory.rendererPrivateWSMB}；进程树 ${r.openMemory.totalMB}）；DOM ${r.dom.nodes} 节点；打字往返 P95 ${r.typing.p95Ms} ms（最大 ${r.typing.maxMs}）`}`);
      await sleep(800);
    }
  } finally { removeDir(prof.userDataDir); }
  const good = list.filter((r) => !r.error);
  return {
    messages: LONG.messages, stateChars: prof.bytes.state, runs: list, failed: list.length - good.length,
    startupMs: summarize(good.map((r) => r.startupMs)),
    openToSettledMs: summarize(good.map((r) => r.openToSettledMs)),
    rendererMB_afterOpen: summarize(good.map((r) => r.openMemory.rendererMB), 1),
    rendererPrivateWSMB_afterOpen: summarize(good.map((r) => r.openMemory.rendererPrivateWSMB), 1),
    totalMB_afterOpen: summarize(good.map((r) => r.openMemory.totalMB), 1),
    typingP95Ms: summarize(good.map((r) => r.typing.p95Ms)),
    domNodes: good[0]?.dom.nodes ?? null,
    maxBlockedMs: Math.max(0, ...good.map((r) => r.maxBlockedMs)),
    unresponsiveRisk: good.some((r) => r.unresponsiveRisk),
  };
}

/** 对照基线 JSON，返回判定表。门槛 ＝ 绝对线与基线×1.1 取较严。 */
export function compareToBaseline(cur, base) {
  const rows = [];
  const add = (id, name, value, abs, baseVal, unit, informational = false) => {
    const g = gate(abs, baseVal);
    rows.push({ id, name, value: Number.isFinite(value) ? value : null, unit, abs, baseline: Number.isFinite(baseVal) ? baseVal : null, gate: Number(g.value.toPrecision(4)), rule: g.rule, pass: Number.isFinite(value) ? value <= g.value : null, informational });
  };
  if (cur.s1) {
    // 同场交错测过基线就用同场的（环境噪声一致）；否则退回 --compare 的历史基线
    const inSession = !!cur.s1.ref;
    const src = inSession ? cur.s1.all : cur.s1.afterFirst;
    const srcRef = inSession ? cur.s1.ref.all : base?.s1?.afterFirst;
    add('S1', inSession ? '冷启动到可输入 P75（同场交错）' : '冷启动到可输入 P75', src.p75, LIMITS.s1.p75Ms, srcRef?.p75, 'ms');
    add('S1', inSession ? '冷启动到可输入 P95（同场交错）' : '冷启动到可输入 P95', src.p95, LIMITS.s1.p95Ms, srcRef?.p95, 'ms');
    // 环境噪声（Electron 自己有时 130 ms、有时 870 ms 才起来）对总值是加性的：补一行「应用自身增量 ＝ 同场总值 − 同场空 Electron」，只供参考
    if (inSession && cur.s1.floor) {
      const inc = cur.s1.all.median - cur.s1.floor.all.median;
      const incRef = cur.s1.ref.all.median - cur.s1.floor.all.median;
      add('S1', '应用自身增量 中位（参考）', Math.round(inc), Infinity, Math.round(incRef), 'ms', true);
    }
  }
  if (cur.idle) {
    add('S2', '空闲内存 进程树 privateBytes', cur.idle.final.totalMB, LIMITS.s2.totalMB, base?.idle?.final?.totalMB, 'MB');
    add('S2', '空闲内存 渲染进程 privateBytes', cur.idle.final.rendererMB, LIMITS.s2.rendererMB, base?.idle?.final?.rendererMB, 'MB');
    // 判定用 O9 原定义的口径：Electron percentCPUUsage（Windows 上按逻辑核数归一，＝占整机的百分比；已用 getAppMetrics 核对：单核 1.72% ↔ 0.07%）
    const allCores = (r) => (r?.idle?.cpu && r.env?.logicalCpus ? Math.round((r.idle.cpu.meanPct / r.env.logicalCpus) * 10000) / 10000 : undefined);
    add('S5', '后台 CPU 合计（占整机%）', allCores(cur), LIMITS.s5.cpuPct, allCores(base), '%');
    add('S5', '后台 CPU 合计（单核%，参考）', cur.idle.cpu.meanPct, Infinity, base?.idle?.cpu?.meanPct, '%', true);
  }
  if (cur.s3) {
    add('S3', '长会话 打开到安静', cur.s3.openToSettledMs.median, LIMITS.s3.firstScreenMs, base?.s3?.openToSettledMs?.median, 'ms');
    add('S3', '长会话 渲染进程 privateBytes', cur.s3.rendererMB_afterOpen.max, LIMITS.s3.rendererMB, base?.s3?.rendererMB_afterOpen?.max, 'MB');
    add('S3', '长会话 打字往返 P95', cur.s3.typingP95Ms.max, LIMITS.s3.inputP95Ms, base?.s3?.typingP95Ms?.max, 'ms');
    rows.push({ id: 'S3', name: '长会话 无「无响应」（最长阻塞 ≤5 s）', value: cur.s3.maxBlockedMs, unit: 'ms', abs: 5000, baseline: base?.s3?.maxBlockedMs ?? null, gate: 5000, rule: '绝对线', pass: cur.s3.maxBlockedMs <= 5000 });
  }
  return rows;
}

export function printTable(ctx, rows) {
  ctx.log('');
  ctx.log('编号  指标                                实测          绝对线      基线        门槛(规则)        判定');
  for (const r of rows) {
    ctx.log(`${r.id}    ${r.name.padEnd(34, '　').slice(0, 34)} ${String(r.value ?? 'n/a').padStart(8)} ${r.unit.padEnd(3)} ${String(Number.isFinite(r.abs) ? r.abs : '—').padStart(8)}  ${String(r.baseline ?? '—').padStart(8)}  ${String(Number.isFinite(r.gate) ? r.gate : '—').padStart(8)} (${r.rule})  ${r.pass === null ? '—' : r.pass ? '通过' : r.informational ? '偏高(参考)' : '未过'}`);
  }
}

export async function runBaseline(ctx) {
  const v = ctx.values;
  const quick = !!v.quick;
  const only = new Set(String(v.only ?? 's1,idle,s3,floor').toLowerCase().split(',').map((x) => x.trim()).map((x) => (x === 's2' || x === 's5' ? 'idle' : x)));
  const runs = Number(v.runs ?? (quick ? 3 : 7));
  const idleSec = Number(v.idle ?? (quick ? 40 : 300));
  const sampleSec = Number(v.sample ?? (quick ? 10 : 30));
  const s3runs = Number(v['s3-runs'] ?? (quick ? 1 : 3));
  const result = { target: ctx.target.id, targetName: ctx.target.name, appDir: ctx.appDir, version: ctx.pkg.version, env: describeEnvironment(ctx.appDir), params: { runs, idleSec, sampleSec, s3runs, quick } };
  let vs;
  if (v.vs) {
    const vsDir = path.resolve(v.vs);
    vs = { appDir: vsDir, target: detectTarget(vsDir), log: ctx.log, step: ctx.step, values: v };
    result.vs = { appDir: vsDir, target: vs.target.id };
  }
  if (only.has('s1')) {
    result.s1 = await measureS1(ctx, { runs, vs });
    if (v['s1-boot']) result.s1BootOn = await measureS1(ctx, { runs: Math.min(3, runs), label: 'S1(开屏开)', prefsExtra: { bootAnimation: true, bootEnter: 'auto' }, floor: false });
  }
  if (only.has('idle')) result.idle = await measureIdle(ctx, { durationSec: idleSec, sampleSec, wakeups: !!v.wakeups });
  if (only.has('s3')) result.s3 = await measureS3(ctx, { runs: s3runs });
  if (only.has('floor')) {
    result.floor = await measureFloor(ctx, { settleSec: quick ? 10 : 25 });
    ctx.step(`空 Electron 底噪：privateBytes ${result.floor.memory.totalMB} MB（GPU ${result.floor.memory.byKindMB.gpu ?? 0}、渲染 ${result.floor.memory.rendererMB}、主进程 ${result.floor.memory.byKindMB.browser ?? 0}），私有工作集 ${result.floor.memory.privateWorkingSetMB} MB`);
  }
  let base;
  if (v.compare) base = JSON.parse(fs.readFileSync(v.compare, 'utf8'));
  result.verdict = compareToBaseline(result, base);
  printTable(ctx, result.verdict);
  if (v.json) { writeJson(v.json, result); ctx.log(`\n结果已写入 ${v.json}`); }
  else process.stdout.write(`${JSON.stringify(result)}\n`);
  return result.verdict.some((r) => r.pass === false && !r.informational) ? 1 : 0;
}
