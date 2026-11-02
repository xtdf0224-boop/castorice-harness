// API 密钥，用系统钥匙串加密（Electron safeStorage → Windows DPAPI）后存在应用的用户数据目录里。
// 密钥不会回到页面：页面只知道“存了一个”和它的末四位。
//
// V0α（X05）：
//   · 改用 safeStorage 的异步 API（encryptStringAsync / decryptStringAsync / isAsyncEncryptionAvailable）；
//     Electron 45 起同步版已弃用。因此 save / get / available 现在都返回 Promise——调用方必须 await。
//   · 兼容读取萤火 v2.0.0 的旧文件：格式不变（{ provider: { hint, value: base64, savedAt } }），
//     同步版 encryptString 写出的密文可以直接用 decryptStringAsync 读。
//   · 保存失败不丢旧值：先加密并解回来核对，再整份原子写入（tmp → rename；rename 失败时先留 .bak 再原地写，原地写失败则还原）。
//   · 文件损坏时先改名备份再重新开始，不静默覆盖。
//   · 密钥只在启动子进程（或发出请求）的那一刻取出：调用方 `await get(provider)` 后立刻放进子进程的 env，
//     不缓存、不放进任务状态、不写任何临时文件（见 scrub：输出里出现密钥原文会被抹成 ••••）。
//
// 模型接入（MODELS-SPEC §11）：
//   · 槽位 = `<服务 id>` 或（端点各有各的密钥时）`<服务 id>:<端点 id>`。哪些槽合法由注册表（services.cjs）在启动时用 configure() 注入，
//     本文件不依赖它；没有注入时（单独加载、旧测试）只认萤火时代的 8 个服务 id。
//   · 页面只传 (服务, 端点)，槽名由主进程算；这里再校验一次格式与是否认识。
//   · 允许不保存密钥的服务（本机服务，keyOptional）把最短长度放宽到 1。
//   · Electron 对象在第一次用到时才取（plain Node 下的检查可以用 __setDeps 注入假的 safeStorage 与目录）。
const fs = require('node:fs');
const path = require('node:path');

/** 萤火 v2.0.0 时代的 8 个服务：注册表没注入时的默认名单（也是 check-security 直接加载本文件时用的）. */
const LEGACY_IDS = new Set(['claude', 'gpt', 'deepseek', 'kimi', 'qwen', 'glm', 'minimax', 'doubao']);
const SLOT_RE = /^[a-z][a-z0-9_-]{0,31}(:[a-z][a-z0-9-]{0,15})?$/;
const SERVICE_RE = /^[a-z][a-z0-9_-]{0,31}$/;

let deps = null;
function electron() {
  if (!deps) { const e = require('electron'); deps = { dir: () => e.app.getPath('userData'), safeStorage: e.safeStorage, platform: process.platform }; }
  return deps;
}
/** 仅供无 Electron 的检查：注入存放目录与 safeStorage 的替身. */
function __setDeps(d) { deps = d ? { dir: () => d.dir, safeStorage: d.safeStorage, platform: d.platform || process.platform } : null; }

let validator = null;
let minLenOf = null;
/**
 * 注入注册表：isKnown(slot) 说这个槽是不是合法的（服务存在；带端点时该端点存在且各有各的密钥）；keyMin(slot) 给最短长度.
 * @param {{ isKnown?: (slot: string) => boolean, keyMin?: (slot: string) => number } | null} cfg  null = 回到默认名单
 */
function configure(cfg) {
  validator = cfg && typeof cfg.isKnown === 'function' ? cfg.isKnown : null;
  minLenOf = cfg && typeof cfg.keyMin === 'function' ? cfg.keyMin : null;
}
/** 槽名格式对、并且是认识的服务（/端点）. */
function isValidSlot(slot) {
  if (typeof slot !== 'string' || !SLOT_RE.test(slot)) return false;
  return validator ? !!validator(slot) : LEGACY_IDS.has(slot);
}
const minLen = (slot) => { const n = minLenOf ? minLenOf(slot) : 8; return Number.isInteger(n) && n >= 1 && n <= 64 ? n : 8; };

function file() { return path.join(electron().dir(), 'model-keys.json'); }

/** 读取整个文件. @returns {{ data: object, corrupt: boolean }} */
function readFile() {
  let text;
  try { text = fs.readFileSync(file(), 'utf8'); } catch (e) {
    if (e && e.code === 'ENOENT') return { data: {}, corrupt: false };
    return { data: {}, corrupt: false, unreadable: true };
  }
  try {
    const data = JSON.parse(text);
    return data && typeof data === 'object' && !Array.isArray(data) ? { data, corrupt: false } : { data: {}, corrupt: true };
  } catch { return { data: {}, corrupt: true }; }
}

function readAll() { return readFile().data; }

/** 整份写入。失败就抛出，旧文件保持原样（或被还原）. */
function writeAll(data) {
  const f = file();
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, f);
    return;
  } catch {
    // 个别机器上 AppData 被过滤驱动重定向，rename 会 EXDEV：原地写。先把旧内容留一份，写坏了能还原。
  }
  let old = null;
  try { old = fs.readFileSync(f, 'utf8'); } catch { /* no old file */ }
  try {
    fs.writeFileSync(f, body, { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    if (old !== null) { try { fs.writeFileSync(f, old, { encoding: 'utf8', mode: 0o600 }); } catch { /* best effort */ } }
    throw e;
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* leave it */ }
  }
}

/** 文件坏了：改名留底，再从空白开始。失败就抛出，不覆盖. */
function setAsideCorrupt() {
  const dest = `${file()}.corrupt-${Date.now()}`;
  fs.renameSync(file(), dest);
  return dest;
}

const hintOf = (key) => `••••${key.slice(-4)}`;
const has = (data, slot) => Object.prototype.hasOwnProperty.call(data, slot);

/** 系统加密是否可用（异步）。Linux 上若退回 basic_text（硬编码口令），按不可用处理. */
async function available() {
  try {
    const { safeStorage, platform } = electron();
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return false;
    if (platform === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' && safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch { return false; }
}

/** { slot: '••••abcd' } for every saved key（不解密）. 认不出的槽不返回. */
function hints() {
  const out = {};
  for (const [id, entry] of Object.entries(readAll())) if (isValidSlot(id) && entry && typeof entry === 'object' && typeof entry.hint === 'string' && entry.hint) out[id] = entry.hint;
  return out;
}

async function encrypt(text) {
  const { safeStorage } = electron();
  const buf = await safeStorage.encryptStringAsync(text);
  // 解回来核对一次：加密“成功”但读不出来的话，宁可保存失败也不要覆盖掉旧值。
  const back = await safeStorage.decryptStringAsync(buf);
  if (!back || back.result !== text) throw new Error('系统加密自检未通过，未保存');
  return buf.toString('base64');
}

/** @returns {Promise<string>} 末四位提示 */
async function save(provider, key) {
  if (!isValidSlot(provider)) throw new Error('未知的模型服务');
  const clean = String(key || '').trim();
  if (clean.length < minLen(provider) || clean.length > 4096 || /\s/.test(clean)) throw new Error('密钥格式不对：应为一串不含空格的字符');
  if (!(await available())) throw new Error('系统加密不可用，无法安全保存密钥');
  const value = await encrypt(clean); // 先加密，旧值此刻原封不动
  // 加密是异步的；从这里到写盘是同步的，所以并发保存不会互相覆盖.
  const cur = readFile();
  if (cur.unreadable) throw new Error('读不了密钥文件，未保存');
  if (cur.corrupt) setAsideCorrupt();
  const data = cur.data;
  data[provider] = { hint: hintOf(clean), value, savedAt: Date.now() };
  writeAll(data);
  return data[provider].hint;
}

function clear(provider) {
  if (!isValidSlot(provider)) return;
  const cur = readFile();
  if (cur.corrupt || cur.unreadable) return;
  if (has(cur.data, provider)) { delete cur.data[provider]; writeAll(cur.data); }
}

/**
 * 删掉一个服务的所有槽（`<id>` 与 `<id>:…`）。服务被删时调用，所以不要求它还“认识”这个服务，只要求 id 的格式对.
 * @returns {number} 删掉了几个槽
 */
function clearService(serviceId) {
  if (typeof serviceId !== 'string' || !SERVICE_RE.test(serviceId)) return 0;
  const cur = readFile();
  if (cur.corrupt || cur.unreadable) return 0;
  let n = 0;
  for (const k of Object.keys(cur.data)) if (k === serviceId || k.startsWith(`${serviceId}:`)) { delete cur.data[k]; n += 1; }
  if (n) writeAll(cur.data);
  return n;
}

/**
 * 取出明文密钥（仅主进程，仅在要用的那一刻）。读不出来返回 null.
 * 系统提示密钥已更换（shouldReEncrypt）时，用新密钥重新加密写回，旧值在写成功之前不动.
 * @returns {Promise<string|null>}
 */
async function get(provider) {
  if (!isValidSlot(provider)) return null;
  const all = readAll();
  const entry = has(all, provider) ? all[provider] : undefined;
  if (!entry || typeof entry !== 'object' || typeof entry.value !== 'string' || !entry.value) return null;
  const { safeStorage } = electron();
  let r;
  try { r = await safeStorage.decryptStringAsync(Buffer.from(entry.value, 'base64')); } catch { return null; }
  if (!r || typeof r.result !== 'string') return null;
  if (r.shouldReEncrypt) {
    try {
      const value = await encrypt(r.result);
      const cur = readFile();
      if (!cur.corrupt && !cur.unreadable && has(cur.data, provider) && cur.data[provider] && cur.data[provider].value === entry.value) {
        cur.data[provider] = { ...cur.data[provider], value };
        writeAll(cur.data);
      }
    } catch { /* 保留旧密文，下次再试 */ }
  }
  return r.result;
}

module.exports = { hints, save, clear, clearService, get, available, configure, isValidSlot, minLen, LEGACY_IDS, SLOT_RE, __setDeps, PROVIDERS: LEGACY_IDS };
