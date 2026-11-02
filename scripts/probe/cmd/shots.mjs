// shots：清单驱动的批量验收截图（施工图 §7.3「一次启动、循环切状态」）。
//   node scripts/probe/run.mjs shots --app-dir <--mode development 构建的副本> [--manifest <清单.json>] [--out <目录>] [--only <正则>] [--theme night|day] [--level s|m|l] [--limit N] [--resume] [--list]
// 清单（默认 design/chat/accept/manifest.json，由 scripts/probe/manifest-gen.mjs 生成）：
//   { version, defaults:{width,height,wait,date}, shots:[{ file, fixture, theme, level, persona, wallpaper, width, height, wait, date, steps:[…] }] }
//   file 是输出文件名（命名 <区>-<状态>-<night|day>-<s|m|l>[-plain|-nowall].png）；fixture 是 devFixture 里的状态名；
//   steps 见 lib/fx.mjs 的步骤串（click: / clicktext: / scroll: / wait: / key: / hover: / eval:）；date 是本地时间（无时区后缀）.
// 启动次数：带壁纸的按「主题 × 话量」分组（2×3=6 次），壁纸关的（-nowall）按主题分组（2 次）；组内用页面里的 applyFixture 切状态、调窗口尺寸、拨钟，逐张截。
// 一次只开一个 Electron；开跑前先查有没有别的渲染 / 游戏在跑（lib/fx.mjs waitForQuiet）. 窗口始终隐藏（ALIGHT_PROBE=1 + 临时 user-data-dir），用完关掉.
// 产物：<out>/<file>.png 与 <out>/shots-report.json（每张图的体检：标题、文字量、是否有 toast 没关、控制台新增错误）；
// 报告里的 flags 会点出空白图（文字量太少）、toast 挡着、控制台报错、状态名不认识.
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, newUserDataDir, removeDir } from '../lib/launch.mjs';
import { writeJson } from '../lib/ctx.mjs';
import {
  DEFAULT_CLOCK, applyFixture, clockSource, ensureDir, fxPrefs, runSteps, setClock, setViewport, settleAndShoot, sleep, waitDevApi, waitForQuiet,
} from '../lib/fx.mjs';

/** 把清单展开成带默认值的条目. */
export function expandManifest(m) {
  const d = { width: 1440, height: 900, wait: 900, date: DEFAULT_CLOCK, ...(m.defaults ?? {}) };
  return (m.shots ?? []).map((e) => ({
    width: d.width, height: d.height, wait: d.wait, date: d.date, level: 'm', theme: 'night', persona: true, wallpaper: true, steps: [], ...e,
  }));
}

/** 启动分组键：带壁纸 = 主题×话量；壁纸关 = 主题. */
export const groupKeyOf = (e) => (e.wallpaper === false ? `${e.theme}|nowall` : `${e.theme}|${e.level}`);

export function planGroups(entries) {
  const groups = new Map();
  for (const e of entries) {
    const k = groupKeyOf(e);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  return groups;
}

export async function runShots(ctx) {
  const v = ctx.values;
  const manifestPath = path.resolve(v.manifest ?? path.join(ctx.repoAppDir, '..', 'design', 'chat', 'accept', 'manifest.json'));
  if (!fs.existsSync(manifestPath)) throw new Error(`找不到清单：${manifestPath}（用 node scripts/probe/manifest-gen.mjs 生成）`);
  const outDir = path.resolve(v.out ?? path.dirname(manifestPath));
  let entries = expandManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
  if (v.only) { const re = new RegExp(String(v.only)); entries = entries.filter((e) => re.test(e.file)); }
  if (v.theme) entries = entries.filter((e) => e.theme === v.theme);
  if (v.level) entries = entries.filter((e) => e.level === v.level);
  if (v.resume) entries = entries.filter((e) => { try { return fs.statSync(path.join(outDir, e.file)).size < 2000; } catch { return true; } });
  if (v.limit) entries = entries.slice(0, Number(v.limit));
  const groups = planGroups(entries);
  ctx.log(`清单 ${manifestPath}\n  ${entries.length} 张，分 ${groups.size} 次启动：${[...groups].map(([k, l]) => `${k}=${l.length}`).join('，')}\n  输出到 ${outDir}`);
  if (v.list) { for (const e of entries) ctx.log(`  ${e.file}  ←  ${e.fixture} ${e.theme}/${e.level}${e.persona ? '' : '/plain'}${e.wallpaper ? '' : '/nowall'} ${e.width}×${e.height}${e.steps.length ? `  steps=${e.steps.length}` : ''}${e.date !== DEFAULT_CLOCK ? `  date=${e.date}` : ''}`); return 0; }
  if (!entries.length) { ctx.log('没有要拍的图。'); return 0; }

  await waitForQuiet(ctx);
  const report = [];
  let flagged = 0;
  for (const [key, list] of groups) {
    ctx.step(`启动：${key}（${list.length} 张）`);
    const [theme] = key.split('|');
    const userDataDir = newUserDataDir('shots');
    const prefs = fxPrefs({ theme });
    const seed = JSON.stringify({ [ctx.target.keys.prefs]: JSON.stringify(prefs) });
    const app = await launchApp({
      appDir: ctx.appDir, userDataDir, keepData: true, viewport: { width: list[0].width, height: list[0].height },
      init: [`try { const e = ${seed}; for (const k of Object.keys(e)) localStorage.setItem(k, e[k]); } catch (err) { console.error('probe seed failed ' + err); }`, clockSource(DEFAULT_CLOCK)],
    });
    try {
      const s = app.page;
      await waitDevApi(s);
      await sleep(1500);   // 启动后的模型检测 / 服务刷新先走完，别在注入之后才来改 models
      let size = `${list[0].width}x${list[0].height}`;
      for (const e of list) {
        const seen = app.consoleLog.length;
        const rec = { file: e.file, fixture: e.fixture, group: key };
        const tEntry = performance.now();
        try {
          await setClock(s, e.date);
          const want = `${e.width}x${e.height}`;
          if (want !== size) { await setViewport(s, e.width, e.height); size = want; await sleep(350); }
          const ok = await applyFixture(s, e.fixture, { level: e.level, persona: e.persona !== false, theme: e.theme, wallpaper: e.wallpaper !== false });
          if (!ok) throw new Error(`不认识的状态：${e.fixture}`);
          await sleep(450);
          await runSteps(s, e.steps);
          const facts = await settleAndShoot(s, path.join(outDir, e.file), { wait: e.wait });
          const errs = app.consoleLog.slice(seen).filter((x) => x.level === 'error').map((x) => x.text.slice(0, 200));
          const flags = [];
          if (facts.textLen < 40 && !facts.overlay) flags.push('文字量过少（可能是空白页）');
          if (facts.toasts) flags.push(`还有 ${facts.toasts} 个 toast 没关`);
          if (errs.length) flags.push(`控制台新增 ${errs.length} 条错误`);
          if (facts.mode !== e.theme) flags.push(`主题不对（${facts.mode}）`);
          Object.assign(rec, { ok: true, facts, errors: errs, flags, ms: Math.round(performance.now() - tEntry) });
          if (flags.length) { flagged += 1; ctx.log(`  ⚠ ${e.file}：${flags.join('；')}${errs[0] ? `\n      ${errs[0]}` : ''}`); }
          else ctx.log(`  ✓ ${e.file}  (${rec.ms} ms，截图 ${facts.shootMs} ms)`);
        } catch (err) {
          flagged += 1;
          Object.assign(rec, { ok: false, error: err.message, flags: ['失败'] });
          ctx.log(`  ✗ ${e.file}：${err.message}`);
        }
        report.push(rec);
      }
    } finally {
      await app.close({ graceMs: 6000 });
      removeDir(userDataDir);
    }
  }
  ensureDir(path.join(outDir, 'x'));
  writeJson(path.join(outDir, 'shots-report.json'), { at: new Date().toISOString(), appDir: ctx.appDir, manifest: manifestPath, total: report.length, flagged, shots: report });
  ctx.log(`\n截图：${report.length - flagged}/${report.length} 张干净，${flagged} 张有提示（见 ${path.join(outDir, 'shots-report.json')}）`);
  return report.some((r) => r.ok === false) ? 1 : 0;
}
