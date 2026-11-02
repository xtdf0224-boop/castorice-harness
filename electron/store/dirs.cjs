// 数据目录：在哪里、够不够空间、怎么搬。纯 node（不依赖 electron），所以能在 scripts/check-store.ts 里测。
//
// 优先级：环境变量 ALIGHT_DATA_DIR > <userData>/store-config.json 里的 dataDir > userData 本身。
// 配置文件必须放在 userData（数据库在哪儿本身不能存在数据库里）。
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DB_FILE = 'alight.db';
const CONFIG_FILE = 'store-config.json';
/** 所在盘剩余空间低于这个值，就建议把数据放到别的盘（C 盘已用 93% 的这台机器）。 */
const LOW_SPACE_BYTES = 15 * 1024 ** 3;

function readConfig(userData) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(userData, CONFIG_FILE), 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}

function writeConfig(userData, cfg) {
  fs.mkdirSync(userData, { recursive: true });
  const file = path.join(userData, CONFIG_FILE);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, file);
}

/** 目录存在（或能建出来）并且写得进去。 */
function usable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.alight-write-test-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return true;
  } catch { return false; }
}

/**
 * 决定这次启动用哪个目录。配置的目录用不了（外接盘没插、被删）时退回 userData，并带上 warning，
 * 让界面明说「数据没丢，在原来的位置」——不会悄悄在别处建一个空库。
 * @returns {{ dir: string, source: 'env' | 'config' | 'default', warning?: string, configured?: string }}
 */
function resolveDataDir({ userData, env = process.env }) {
  const fromEnv = typeof env.ALIGHT_DATA_DIR === 'string' ? env.ALIGHT_DATA_DIR.trim() : '';
  if (fromEnv && path.isAbsolute(fromEnv)) {
    if (usable(fromEnv)) return { dir: path.resolve(fromEnv), source: 'env' };
    return { dir: userData, source: 'default', configured: fromEnv, warning: `环境变量 ALIGHT_DATA_DIR 指向的 ${fromEnv} 现在用不了，暂时使用默认位置。数据没有丢，在那个文件夹里。` };
  }
  const cfg = readConfig(userData);
  const wanted = typeof cfg.dataDir === 'string' ? cfg.dataDir : '';
  if (wanted && path.isAbsolute(wanted) && path.resolve(wanted) !== path.resolve(userData)) {
    if (usable(wanted)) return { dir: path.resolve(wanted), source: 'config' };
    return { dir: userData, source: 'default', configured: wanted, warning: `设置的数据目录 ${wanted} 现在用不了（盘没插好或文件夹没了）。暂时使用默认位置，数据没有丢，在原来的文件夹里。` };
  }
  return { dir: userData, source: 'default' };
}

/** 某个路径所在卷的容量。取不到返回 undefined。 */
function disk(p) {
  try {
    const st = fs.statfsSync(p);
    const root = path.parse(path.resolve(p)).root;
    return { root, freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
  } catch { return undefined; }
}

/** 其他盘（D–Z）里空间足够的，给「改到哪里」当建议。只读容量，不碰盘上的任何东西。 */
function suggestions(currentRoot, min = LOW_SPACE_BYTES, limit = 3) {
  const out = [];
  if (process.platform !== 'win32') return out;
  for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (currentRoot && root.toLowerCase() === currentRoot.toLowerCase()) continue;
    const d = disk(root);
    if (!d || d.totalBytes <= 0 || d.freeBytes < min) continue;
    out.push({ dir: path.join(root, 'AlightData'), root, freeBytes: d.freeBytes, totalBytes: d.totalBytes });
  }
  return out.sort((a, b) => b.freeBytes - a.freeBytes).slice(0, limit);
}

/** 当前数据目录的空间报告。low = 所在卷剩余空间低于阈值。 */
function report(dir) {
  const d = disk(dir);
  if (!d) return { root: path.parse(path.resolve(dir)).root, low: false, thresholdBytes: LOW_SPACE_BYTES, suggestions: [] };
  const low = d.freeBytes < LOW_SPACE_BYTES;
  return { ...d, low, thresholdBytes: LOW_SPACE_BYTES, suggestions: low ? suggestions(d.root) : [] };
}

/**
 * 目标文件夹里现成的 alight.db 能不能改用：只读打开，user_version 在 1..SCHEMA_VERSION，自检通过，tasks 表在。
 * 空文件 / 不是数据库 / 损坏 / 更新版本写出来的都不行（code invalid-db）——否则先写了配置再发现打不开，
 * 此后每次 open() 都抛错，界面里的「更改位置」自己也进不去，只能手改 store-config.json.
 */
function checkExistingDb(file) {
  const { AlightDb, SCHEMA_VERSION } = require('./db.cjs');
  let check = null;
  try {
    check = new AlightDb(file, { readOnly: true });
    const ver = Number(check.get('PRAGMA user_version').user_version);
    if (ver === 0) throw new Error('它是空的，或者不是栖枝的数据库');
    if (ver > SCHEMA_VERSION) throw new Error(`它是更新版本的栖枝写出来的（数据库版本 ${ver}，这个程序是 ${SCHEMA_VERSION}），请先更新栖枝`);
    const quick = check.get('PRAGMA quick_check').quick_check;
    if (quick !== 'ok') throw new Error(`没通过自检：${quick}`);
    check.get('SELECT COUNT(*) AS n FROM tasks');
  } catch (e) {
    throw Object.assign(new Error(`这个文件夹里的 alight.db 不能用：${String((e && e.message) || e).slice(0, 160)}。请换一个文件夹，或先把它移走。`), { code: 'invalid-db' });
  } finally {
    try { check && check.close(); } catch { /* 已经关了 */ }
  }
}

/**
 * 把库搬到新目录：VACUUM INTO 复制到 <target>/alight.db（做完自检），写配置。旧文件原样留着，绝不删。
 * useExisting：目标里已经有 alight.db 时改用它（不覆盖也不合并；先校验，不能用就拒绝、不写配置）。
 * db / getDb：当前库，或取得当前库的函数——只有需要复制时才用到；当前库打不开时也能改用目标里现成的库、或改回默认位置.
 * @param {{ db?: { backup(dest: string): object }, getDb?: () => { backup(dest: string): object }, userData: string, target: string, useExisting?: boolean }} o
 */
function moveData({ db, getDb, userData, target, useExisting }) {
  if (!target || !path.isAbsolute(target)) throw Object.assign(new Error('请选一个完整的文件夹路径'), { code: 'bad-path' });
  const dir = path.resolve(target);
  if (!usable(dir)) throw Object.assign(new Error('这个文件夹写不进去，换一个'), { code: 'not-writable' });
  const file = path.join(dir, DB_FILE);
  let copied = null;
  if (fs.existsSync(file)) {
    checkExistingDb(file);
    if (!useExisting) throw Object.assign(new Error('这个文件夹里已经有一个 alight.db。要改用它的话请确认；当前数据库不会被删除或合并。'), { code: 'exists' });
  } else {
    const source = db || (getDb && getDb());
    if (!source) throw Object.assign(new Error('当前数据库打不开，没法复制。可以改用另一个文件夹里现成的数据库'), { code: 'no-source' });
    copied = source.backup(file);
  }
  const cfg = readConfig(userData);
  if (path.resolve(dir) === path.resolve(userData)) delete cfg.dataDir; else cfg.dataDir = dir;
  writeConfig(userData, cfg);
  return { dir, copied };
}

/** 备份文件名：alight-20261024-153000.db（本地时间）。 */
function backupName(now = Date.now()) {
  const d = new Date(now);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `alight-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.db`;
}

function listBackups(dir, limit = 50) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => /^alight-.*\.db$/.test(f))
      .map((f) => { const st = fs.statSync(path.join(dir, f)); return { name: f, path: path.join(dir, f), bytes: st.size, at: st.mtimeMs }; })
      .sort((a, b) => b.at - a.at)
      .slice(0, limit);
  } catch { return []; }
}

module.exports = { DB_FILE, LOW_SPACE_BYTES, readConfig, writeConfig, usable, resolveDataDir, disk, suggestions, report, moveData, backupName, listBackups };
