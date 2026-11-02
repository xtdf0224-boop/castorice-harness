// smoke：启动 → 首页渲染 → 无控制台错误 → 开屏期间可输入（V0α 要求）→ 退出（没有残留进程）。
// 用应用自己的默认设置（开屏默认值也不改），只预置「一个可用的模型」让输入框解锁。
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, removeDir } from '../lib/launch.mjs';
import { findByUserDataDir } from '../lib/proc.mjs';
import { evaluate, readProbe, readyProbeSource, screenshot, sleep, waitUntil } from '../lib/page.mjs';
import { prepareProfile } from '../lib/profile.mjs';
import { buildPrefs } from '../lib/seed.mjs';
import { INPUT_SELECTOR } from '../lib/targets.mjs';
import { writeJson } from '../lib/ctx.mjs';

export async function runSmoke(ctx) {
  const checks = [];
  const add = (name, pass, detail = '', severity = 'must') => { checks.push({ name, pass: !!pass, detail, severity }); ctx.log(`${pass ? '✓' : severity === 'must' ? '✗' : '△'} ${name}${!pass && detail ? `\n     ${detail}` : ''}`); };

  const dist = path.join(ctx.appDir, 'dist', 'index.html');
  add('dist/index.html 存在（集成者已构建）', fs.existsSync(dist), dist);
  if (!fs.existsSync(dist)) return finish(ctx, checks);
  const mainJs = (ctx.pkg.main && path.join(ctx.appDir, ctx.pkg.main)) || '';
  add('package.json 的 main 指向的文件存在', mainJs && fs.existsSync(mainJs), mainJs);

  // 预置一个可用的模型（让首页输入框解锁），其余设置保持应用默认（含开屏）
  const prefs = buildPrefs({ settings: { bootAnimation: 'default' } });
  const prof = await prepareProfile(ctx, { prefs, label: 'smoke', log: ctx.log });
  let app;
  let closed;
  try {
    app = await launchApp({ appDir: ctx.appDir, userDataDir: prof.userDataDir, keepData: true, network: true, viewport: { width: 1440, height: 900 }, init: [readyProbeSource(INPUT_SELECTOR)] });
    const s = app.page;
    add('调试端口与页面目标就绪', true, `CDP ${Math.round(app.cdpUpMs)} ms，${app.version}`);
    const rendered = await waitUntil(s, `document.readyState !== 'loading' && !!document.getElementById('root') && document.getElementById('root').childElementCount > 0`, { timeoutMs: 20000 }).catch(() => false);
    add('首页渲染（#root 有内容）', rendered, '20 秒内 #root 仍然是空的');
    const title = await evaluate(s, 'document.title').catch(() => '');
    add(`标题带应用名「${ctx.target.titleSuffix}」`, title.includes(ctx.target.titleSuffix), `document.title=${JSON.stringify(title)}`);
    const bridge = await evaluate(s, `typeof window.${ctx.target.bridge} === 'object' && typeof window.${ctx.target.bridge}.info === 'function'`).catch(() => false);
    add(`桌面桥 window.${ctx.target.bridge} 在页面里`, bridge);
    if (bridge) {
      const info = await evaluate(s, `window.${ctx.target.bridge}.info().then((i) => JSON.stringify({ enc: i.encryption, root: i.workspaceRoot, platform: i.platform }))`).catch((e) => `错误：${e.message}`);
      add('桥的 info() 能应答', info.startsWith('{'), info);
    }
    // 开屏期间可输入：用应用默认设置启动，输入框多久能收到按键（V0α：开屏不再 inert，应在 3 秒内）
    let probe = null;
    for (let i = 0; i < 400 && !probe?.marks?.inputReady; i++) { probe = await readProbe(s).catch(() => null); if (probe?.marks?.inputReady !== undefined) break; await sleep(25); }
    const readyMs = probe?.marks?.inputReady !== undefined ? Math.round(probe.origin + probe.marks.inputReady - app.t0Wall) : null;
    const boot = await evaluate(s, 'document.documentElement.dataset.boot').catch(() => undefined);
    add(`应用默认设置下主输入框 10 秒内可输入${readyMs !== null ? `（${readyMs} ms）` : ''}`, readyMs !== null && readyMs < 10000,
      `开屏状态 data-boot=${boot}；输入框一直不可用（inert / disabled）——萤火的开屏会让整个应用 inert，V0α 要求去掉`, ctx.target.id === 'alight' ? 'must' : 'advisory');
    await sleep(2500);
    const errs = app.errors();
    add('控制台没有错误（console.error、未捕获异常、CSP 拦截）', errs.length === 0, errs.slice(0, 5).map((e) => `[${e.kind}] ${e.text.slice(0, 200)}`).join('\n     '));
    add('没有失败的网络请求', app.requestsFailed.filter((r) => !r.canceled).length === 0, JSON.stringify(app.requestsFailed.slice(0, 3)));
    if (ctx.outDir) { const f = await screenshot(s, path.join(ctx.outDir, `smoke-${ctx.target.id}.png`)); ctx.log(`   截图 ${f}`); }
  } catch (e) {
    add('冒烟流程没有抛错', false, e.stack ?? e.message);
  } finally {
    if (app) closed = await app.close({ graceMs: 8000 });
    if (app) {
      add('应用自行退出（Browser.close 后没有被强杀）', closed && !closed.forced, 'Browser.close 之后进程应当自己退出（exit code 0）；被强杀说明主进程卡住了', 'advisory');
      const left = findByUserDataDir(prof.userDataDir);
      add('收尾后没有残留进程', left.length === 0, `残留 PID：${left.join(',')}`);
    }
    removeDir(prof.userDataDir);
  }
  return finish(ctx, checks);
}

function finish(ctx, checks) {
  const bad = checks.filter((c) => !c.pass && c.severity === 'must');
  const warn = checks.filter((c) => !c.pass && c.severity !== 'must');
  ctx.log(`\n冒烟：${bad.length ? '失败' : '通过'}（${checks.length - bad.length - warn.length}/${checks.length} 项通过，${warn.length} 项提醒，${bad.length} 项失败）`);
  const out = { target: ctx.target.id, appDir: ctx.appDir, at: new Date().toISOString(), pass: bad.length === 0, checks };
  if (ctx.values.json) writeJson(ctx.values.json, out);
  return bad.length ? 1 : 0;
}
