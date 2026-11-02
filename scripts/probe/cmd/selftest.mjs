// selftest：探针自身的离线自检（不启动 Electron、不联网、几秒钟）。集成者可以把它挂成 npm run check:probe。
import { selfTest as fakeSelfTest } from '../fake-anthropic.mjs';
import { CdpConnection } from '../lib/cdp.mjs';
import { cpuBetween, summarizeMemory } from '../lib/proc.mjs';
import { EVENT_LOGGER_SOURCE, PERF_PROBE_SOURCE, ime, pressKey, readyProbeSource } from '../lib/page.mjs';
import { buildPrefs, buildStateBlob, storageScript } from '../lib/seed.mjs';
import { TARGETS, detectTarget } from '../lib/targets.mjs';
import { gate, percentile, summarize } from '../lib/stats.mjs';
import vm from 'node:vm';
import { clockSource, fxPrefs, parseStep } from '../lib/fx.mjs';
import { byLevel } from '../fake-anthropic.mjs';
import { build as buildManifest } from '../manifest-gen.mjs';
import { expandManifest, groupKeyOf, planGroups } from './shots.mjs';

export async function runSelftest(ctx) {
  const results = [];
  const t = (name, fn) => {
    return Promise.resolve().then(fn).then((r) => { results.push({ name, ok: r !== false }); ctx.log(`${r !== false ? '通过' : '失败'}：${name}`); }, (e) => { results.push({ name, ok: false }); ctx.log(`失败：${name} —— ${e.message}`); });
  };
  const compiles = (src) => { new Function(src); return true; };

  await t('stats：分位数与摘要', () => {
    const p = percentile([1, 2, 3, 4, 100], 50) === 3 && percentile([10], 95) === 10 && Number.isNaN(percentile([], 50)) && percentile([0, 100], 75) === 75;
    const s = summarize([100, 200, 300, 400]);
    return p && s.n === 4 && s.median === 250 && s.max === 400;
  });
  await t('stats：门槛取绝对线与基线×1.1 的较严者', () => {
    const a = gate(2500, 1000); const b = gate(300, 470); const c = gate(1, undefined);
    return Math.abs(a.value - 1100) < 1e-9 && a.rule === '基线×1.1' && b.value === 300 && b.rule === '绝对线' && c.value === 1;
  });
  await t('proc：内存汇总与 CPU 差分', () => {
    const mk = (at, cpu) => ({ at, procs: [
      { pid: 1, kind: 'browser', privateBytes: 40 * 1048576, workingSet: 100 * 1048576, privateWS: 30 * 1048576, cpuSec: cpu },
      { pid: 2, kind: 'gpu', privateBytes: 300 * 1048576, workingSet: 200 * 1048576, privateWS: 90 * 1048576, cpuSec: cpu },
      { pid: 3, kind: 'renderer', privateBytes: 60 * 1048576, workingSet: 90 * 1048576, privateWS: 50 * 1048576, cpuSec: cpu }] });
    const m = summarizeMemory(mk(0, 0));
    const c = cpuBetween(mk(0, 0), mk(10_000, 0.1)); // 每个进程 10 s 里用了 0.1 s ＝ 1%，三个进程合计 3%
    return m.totalMB === 400 && m.totalExGpuMB === 100 && m.rendererMB === 60 && m.privateWorkingSetMB === 170 && Math.abs(c.totalPct - 3) < 0.01;
  });
  await t('seed：合成数据逐字节可复现，10,000 条消息的体量符合预期', () => {
    const a = JSON.stringify(buildStateBlob({ tasks: [{ id: 'x', title: 't', messages: 10000, seed: 9 }] }));
    const b = JSON.stringify(buildStateBlob({ tasks: [{ id: 'x', title: 't', messages: 10000, seed: 9 }] }));
    const c = JSON.stringify(buildStateBlob({ tasks: [{ id: 'x', title: 't', messages: 10000, seed: 10 }] }));
    const blob = JSON.parse(a);
    return a === b && a !== c && blob.tasks.x.messages.length === 10000 && a.length > 1_500_000 && a.length < 4_000_000 && new Set(blob.tasks.x.messages.map((m) => m.id)).size === 10000;
  });
  await t('seed：偏好里 default 标记不写入；fakeApi:null 表示没配模型', () => {
    const p = buildPrefs({ settings: { bootAnimation: 'default', mode: 'night' } });
    const q = buildPrefs({ fakeApi: null });
    return !('bootAnimation' in p.settings) && p.settings.mode === 'night' && p.models.defaultEngine === 'claude' && !q.models;
  });
  await t('页面脚本都是合法 JS', () => compiles(storageScript({ a: '1' }, { force: true })) && compiles(readyProbeSource('textarea')) && compiles(PERF_PROBE_SOURCE) && compiles(EVENT_LOGGER_SOURCE));
  await t('目标识别：萤火 / 栖枝', () => TARGETS.ff.bridge === 'fireflyDesktop' && TARGETS.alight.bridge === 'alightDesktop' && detectTarget(ctx.appDir).id === 'alight');
  await t('键盘：Enter 带 text、Escape 不带；输入法三种变体的参数', async () => {
    const sent = [];
    const s = { send: async (m, p) => { sent.push([m, p]); return {}; } };
    await pressKey(s, 'Enter');
    await pressKey(s, 'Escape');
    await pressKey(s, 'a', { mods: ['ctrl'] });
    await ime.key(s, 'Enter', 'A'); await ime.key(s, 'Enter', 'B'); await ime.key(s, 'Escape', 'C');
    const down = sent.filter(([, p]) => p.type === 'keyDown' || p.type === 'rawKeyDown').map(([, p]) => p);
    return down[0].type === 'keyDown' && down[0].text === '\r' && down[1].type === 'rawKeyDown' && down[1].text === undefined && down[2].type === 'rawKeyDown' && down[2].modifiers === 2
      && down[3].key === 'Process' && down[3].windowsVirtualKeyCode === 229
      && down[4].key === 'Enter' && down[4].windowsVirtualKeyCode === 13
      && down[5].key === 'Escape' && down[5].windowsVirtualKeyCode === 229;
  });
  await t('CDP 客户端：连不上时报错而不是挂住', async () => {
    try { await CdpConnection.connect('ws://127.0.0.1:1/devtools/browser/x', 1500); return false; } catch { return true; }
  });
  await t('假 Anthropic 服务：流式 / tool_use / AskUserQuestion / ExitPlanMode / 错误', async () => fakeSelfTest(() => {}));

  // ── T：验收探针（shots / flows / shot --fixture）的离线自检 ──
  await t('fx：拨钟脚本——new Date() 与 Date.now() 跟着拨，带参数的 new Date(y,m,d) 不受影响，可复位', () => {
    const sandbox = { globalThis: undefined };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(clockSource('2026-10-27T23:42:00'), sandbox);
    const d = vm.runInContext('new Date()', sandbox);
    const near = Math.abs(d.getTime() - new Date('2026-10-27T23:42:00').getTime()) < 5000;
    const fixed = vm.runInContext('new Date(2020, 0, 2, 3).getFullYear()', sandbox) === 2020;
    const now = Math.abs(vm.runInContext('Date.now()', sandbox) - new Date('2026-10-27T23:42:00').getTime()) < 5000;
    vm.runInContext('__probeClock.set(null)', sandbox);
    const back = Math.abs(vm.runInContext('Date.now()', sandbox) - Date.now()) < 5000;
    const inst = vm.runInContext('new Date() instanceof Date && typeof Date() === "string"', sandbox);
    return near && fixed && now && back && inst;
  });
  await t('fx：步骤串解析（click / clicktext / scroll / wait / key / eval，对象写法，非法抛错）', () => {
    const a = parseStep('click:.tarot-pick'); const b = parseStep('eval:window.x = 1; 2'); const c = parseStep({ wait: 300 });
    let threw = false; try { parseStep('bogus:1'); } catch { threw = true; }
    return a.op === 'click' && a.arg === '.tarot-pick' && b.arg === 'window.x = 1; 2' && c.op === 'wait' && c.arg === 300 && threw;
  });
  await t('fx：验收偏好对齐当前版本（settingsRev 5 / agentsRev 2），关开屏、出错不开控制台', () => {
    const p = fxPrefs({ theme: 'day' });
    return p.settingsRev === 5 && p.agentsRev === 2 && p.settings.mode === 'day' && p.settings.bootAnimation === false && p.settings.openConsoleOnError === false;
  });
  await t('fx：验收偏好的模型名像真的（不是占位名 claude-probe-1）', () => {
    const m = fxPrefs({ theme: 'night' }).models?.providers?.claude?.model;
    return typeof m === 'string' && m.length > 0 && !/probe/i.test(m);
  });
  await t('fake：byLevel 按系统提示里的话量块回不同长度，缺省取中', () => {
    const f = byLevel({ s: '短', m: '中等长度', l: '很长很长的一句' });
    const text = (sys) => f({ system: sys }).blocks[0].text;
    return text('…【话量：少】…') === '短' && text('【话量：多】') === '很长很长的一句' && text('没有话量块') === '中等长度' && text('【话量：中】') === '中等长度';
  });
  await t('manifest：核心矩阵 42 张齐全、文件名唯一且合规、-nowall 夜昼各一张、分 8 次启动', () => {
    const shots = buildManifest();
    const names = shots.map((s) => s.file);
    const CORE = ['agent-default', 'chat-reply', 'work-plan-pending', 'work-approval-high', 'work-done', 'work-failed', 'return-brief'];
    const core = CORE.flatMap((c) => ['night', 'day'].flatMap((th) => ['s', 'm', 'l'].map((l) => `${c}-${th}-${l}.png`)));
    const groups = planGroups(expandManifest({ shots }));
    return new Set(names).size === names.length && core.length === 42 && core.every((n) => names.includes(n))
      && names.every((n) => /^[a-z0-9]+(-[a-z0-9]+)*-(night|day)-(s|m|l)(-nowall)?\.png$/.test(n))
      && names.includes('agent-default-night-m-nowall.png') && names.includes('chat-reply-day-m-nowall.png')
      && groups.size === 8 && [...groups.keys()].every((k) => /^(night|day)\|(s|m|l|nowall)$/.test(k))
      && shots.every((e) => groupKeyOf({ wallpaper: e.wallpaper, theme: e.theme, level: e.level }) === (e.wallpaper === false ? `${e.theme}|nowall` : `${e.theme}|${e.level}`));
  });

  const bad = results.filter((r) => !r.ok);
  ctx.log(`\n自检：${results.length - bad.length}/${results.length} 通过`);
  return bad.length ? 1 : 0;
}
