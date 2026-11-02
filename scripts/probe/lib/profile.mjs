// 准备带种子的用户数据目录：启动一次（localStorage 种子在第一份文档的应用代码之前写好）→ 存可选的假密钥 → 正常退出让数据落盘。
// 之后的测量启动都复用这个目录，等于「老用户重启应用」。
// 种子必须在应用第一次读库之前就位：栖枝第一次启动时才会把 localStorage 里的旧任务迁进 SQLite 库，
// 如果先空启动一次（库里记下「没有旧数据」）再写种子，旧任务就永远不会被迁进去（探针看到的是空列表）。
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, newUserDataDir } from './launch.mjs';
import { evaluate, sleep, waitUntil } from './page.mjs';
import { INPUT_SELECTOR } from './targets.mjs';
import { storageScript } from './seed.mjs';

export const FAKE_KEY = 'sk-ant-probe-0000000000000000';

/**
 * @param {{appDir:string, target:any}} ctx
 * @param {{prefs?:object, state?:object, saveKey?:boolean, userFiles?:Record<string,string>, label?:string, log?:(s:string)=>void}} spec
 *   userFiles：第一次启动之前写进用户数据目录的文件（文件名 → 内容），栖枝用它放 services.json（自定义服务）
 * @returns {Promise<{userDataDir:string, bytes:{prefs:number,state:number}}>}
 */
export async function prepareProfile(ctx, spec) {
  const { appDir, target } = ctx;
  const log = spec.log ?? (() => {});
  const userDataDir = newUserDataDir(spec.label ?? 'profile');
  for (const [name, content] of Object.entries(spec.userFiles ?? {})) fs.writeFileSync(path.join(userDataDir, name), content);
  const entries = {};
  if (spec.prefs) entries[target.keys.prefs] = JSON.stringify(spec.prefs);
  if (spec.state) entries[target.keys.state] = JSON.stringify(spec.state);
  const lens = Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.length]));
  // 应用在 pagehide 时会把内存里的旧状态冲刷回 localStorage，所以种子不能「先 setItem 再 reload」：
  // 用「新文档开始前执行」的脚本写入（在应用代码之前），应用第一份文档读到的就是种子。
  const app = await launchApp({ appDir, userDataDir, keepData: true, label: spec.label, init: Object.keys(entries).length ? [storageScript(entries, { force: true })] : [] });
  try {
    const s = app.page;
    await waitUntil(s, `document.readyState !== 'loading' && !!document.getElementById('root') && document.getElementById('root').childElementCount > 0`, { timeoutMs: 30000, label: '应用首次渲染' });
    await waitUntil(s, `!!document.querySelector(${JSON.stringify(INPUT_SELECTOR)})`, { timeoutMs: 30000, label: '出现输入框' });
    const stored = JSON.parse(await evaluate(s, `JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(entries))}.map(k => [k, (localStorage.getItem(k) || '').length])))`));
    for (const [k, n] of Object.entries(lens)) {
      if (!stored[k]) throw new Error(`localStorage 没存进去：${k} 期望约 ${n} 字符，实际 ${stored[k]}（可能超出配额）`);
    }
    if (spec.saveKey !== false) {
      const r = await evaluate(s, `window.${target.bridge}.saveKey('claude', ${JSON.stringify(FAKE_KEY)}).then((r) => JSON.stringify(r))`);
      if (!JSON.parse(r).ok) throw new Error(`保存假密钥失败：${r}`);
    }
    await sleep(1500);
    // 重载后应用读到的是我们的种子：设置里 bootAnimation 与预期一致
    log(`  种子已写入（prefs ${lens[target.keys.prefs] ?? 0} 字符，state ${lens[target.keys.state] ?? 0} 字符；应用读入后 prefs ${stored[target.keys.prefs] ?? 0}、state ${stored[target.keys.state] ?? 0} 字符）`);
    const closed = await app.close({ graceMs: 6000 });
    if (closed.forced) log('  注意：准备种子时应用没有自行退出，已强制结束（localStorage 可能没落盘）');
    return { userDataDir, bytes: { prefs: lens[target.keys.prefs] ?? 0, state: lens[target.keys.state] ?? 0 }, forced: closed.forced };
  } catch (e) {
    await app.close({ quick: true }).catch(() => {});
    throw e;
  }
}

/** 启动后确认种子还在（防止「准备时强杀导致没落盘」被当成测量数据）。 */
export async function assertSeeded(s, target, expectState) {
  const r = JSON.parse(await evaluate(s, `JSON.stringify({ prefs: (localStorage.getItem(${JSON.stringify(target.keys.prefs)}) || '').length, state: (localStorage.getItem(${JSON.stringify(target.keys.state)}) || '').length })`));
  if (!r.prefs) throw new Error('用户数据目录里没有偏好种子：准备阶段没有落盘');
  if (expectState && !r.state) throw new Error('用户数据目录里没有任务历史种子：准备阶段没有落盘');
  return r;
}
