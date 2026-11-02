// Claude 的认证路径、API 计费预算与会话费用账本（K02 / K14）。只存数字和开关，不存任何令牌或密钥。
//
// 认证三条路（栖枝只提供入口，不替用户登录，永不读 ~/.claude/.credentials.json）：
//   ① login  本机已登录的 claude（默认）。状态来自 `claude auth status --json`。子进程环境里会去掉 ANTHROPIC_API_KEY /
//            ANTHROPIC_AUTH_TOKEN，免得用户环境变量里残留的密钥悄悄把订阅换成 API 计费。
//   ② apikey API 密钥（明示选项）：必须设日、月硬预算并确认「这是 API 计费」；密钥由 secrets.cjs 保管，只在启动子进程时注入；
//            超预算不再启动（错误码 BUDGET → 页面进「待你·失败」），运行中用 SDK 的 maxBudgetUsd 兜底。
//   ③ 打开你自己的登录流程：index.cjs 的 openLogin（PowerShell 窗口里运行 `claude auth login`）。
//
// createAuthStore(dir) 不依赖 Electron，check-engine 用临时目录测它；index.cjs 用 app.getPath('userData')。
const fs = require('node:fs');
const path = require('node:path');

const DEFAULTS = { mode: 'login', dailyUsd: null, monthlyUsd: null, useSdk: true, apiAck: false };
const MAX_USD = 100000;

function readJson(file, fallback) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? data : fallback;
  } catch { return fallback; }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(data, null, 2);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch {
    // AppData 被过滤驱动重定向时 rename 会 EXDEV：原地写。
    fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
    try { fs.unlinkSync(tmp); } catch { /* 留着也行 */ }
  }
}

const money = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= MAX_USD ? Math.round(v * 10000) / 10000 : null);
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const round6 = (v) => Math.round(v * 1e6) / 1e6;

function createAuthStore(dir, { now = () => new Date() } = {}) {
  const cfgFile = path.join(dir, 'claude-auth.json');
  const spendFile = path.join(dir, 'api-spend.json');
  const costFile = path.join(dir, 'session-cost.json');

  /* ───── 配置 ───── */

  function getConfig() {
    const raw = readJson(cfgFile, {});
    return {
      mode: raw.mode === 'apikey' ? 'apikey' : 'login',
      dailyUsd: money(raw.dailyUsd),
      monthlyUsd: money(raw.monthlyUsd),
      useSdk: raw.useSdk !== false,
      apiAck: raw.apiAck === true,
    };
  }

  /** @returns {{ ok: true, config: object } | { ok: false, error: string }} */
  function setConfig(patch) {
    const cur = { ...DEFAULTS, ...getConfig() };
    const next = { ...cur };
    if (patch && typeof patch === 'object') {
      if (patch.mode === 'login' || patch.mode === 'apikey') next.mode = patch.mode;
      if ('dailyUsd' in patch) next.dailyUsd = patch.dailyUsd === null ? null : money(Number(patch.dailyUsd));
      if ('monthlyUsd' in patch) next.monthlyUsd = patch.monthlyUsd === null ? null : money(Number(patch.monthlyUsd));
      if (typeof patch.useSdk === 'boolean') next.useSdk = patch.useSdk;
      if (typeof patch.apiAck === 'boolean') next.apiAck = patch.apiAck;
    }
    if (next.mode === 'apikey') {
      if (!next.dailyUsd || !next.monthlyUsd) return { ok: false, error: '用 API 密钥必须先设好日预算和月预算（美元，大于 0）。' };
      if (next.dailyUsd > next.monthlyUsd) return { ok: false, error: '日预算不能高于月预算。' };
      if (!next.apiAck) return { ok: false, error: '请先确认：这是 API 计费，按用量扣费，与订阅额度无关。' };
    }
    writeJson(cfgFile, next);
    return { ok: true, config: next };
  }

  /* ───── API 计费账本 ───── */

  function readSpend() {
    const raw = readJson(spendFile, {});
    const days = raw.days && typeof raw.days === 'object' ? raw.days : {};
    return days;
  }

  /** 今日 / 本月已花（美元，只统计 API 密钥路径）. */
  function spend() {
    const days = readSpend();
    const d = now();
    const today = dayKey(d);
    const month = today.slice(0, 7);
    let m = 0;
    for (const [k, v] of Object.entries(days)) if (k.startsWith(month) && typeof v === 'number') m += v;
    return { day: today, month, today: round6(Number(days[today]) || 0), monthTotal: round6(m) };
  }

  function addSpend(usd) {
    if (typeof usd !== 'number' || !Number.isFinite(usd) || usd <= 0) return spend();
    const days = readSpend();
    const today = dayKey(now());
    days[today] = round6((Number(days[today]) || 0) + usd);
    // 只留最近 62 天
    const keep = Object.keys(days).sort().slice(-62);
    const trimmed = Object.fromEntries(keep.map((k) => [k, days[k]]));
    writeJson(spendFile, { v: 1, days: trimmed });
    return spend();
  }

  /**
   * 开跑前的预算检查（只对 API 密钥路径有意义）。
   * level: 'ok' | 'warn'（≥80%）| 'stop'（≥100%，不再启动）. remainingUsd 给 SDK 的 maxBudgetUsd.
   */
  function budgetCheck() {
    const cfg = getConfig();
    const s = spend();
    if (cfg.mode !== 'apikey') return { level: 'ok', applies: false, ...s, dailyUsd: cfg.dailyUsd, monthlyUsd: cfg.monthlyUsd };
    if (!cfg.dailyUsd || !cfg.monthlyUsd) return { level: 'stop', applies: true, message: '用 API 密钥必须先设好日预算和月预算。', ...s, dailyUsd: cfg.dailyUsd, monthlyUsd: cfg.monthlyUsd };
    const dayLeft = cfg.dailyUsd - s.today;
    const monthLeft = cfg.monthlyUsd - s.monthTotal;
    const remainingUsd = Math.max(0, Math.min(dayLeft, monthLeft));
    const out = { applies: true, remainingUsd: round6(remainingUsd), ...s, dailyUsd: cfg.dailyUsd, monthlyUsd: cfg.monthlyUsd };
    if (remainingUsd <= 0.0001) {
      const which = dayLeft <= monthLeft ? `日预算 $${cfg.dailyUsd}（今天已花 $${s.today.toFixed(2)}）` : `月预算 $${cfg.monthlyUsd}（本月已花 $${s.monthTotal.toFixed(2)}）`;
      return { ...out, level: 'stop', message: `已达到${which}，API 密钥路径已停用。可以在「模型接入」里调高预算，或改用已登录的 claude。` };
    }
    if (s.today >= cfg.dailyUsd * 0.8 || s.monthTotal >= cfg.monthlyUsd * 0.8) {
      return { ...out, level: 'warn', message: `API 计费已用到预算的 80% 以上（今日 $${s.today.toFixed(2)} / $${cfg.dailyUsd}，本月 $${s.monthTotal.toFixed(2)} / $${cfg.monthlyUsd}）。` };
    }
    return { ...out, level: 'ok' };
  }

  /* ───── 会话费用账本：把 SDK 的"累计 total_cost_usd"换成这一次的增量 ───── */

  /**
   * totals: { cost, input, output, cacheRead } —— SDK result 里的累计值（含恢复前的历史）。
   * resumed: 这次是不是 resume 一个已有会话。
   * @returns {{ cost: number, input: number, output: number, cacheRead: number } | null} 增量；基线未知时 null.
   */
  function sessionDelta(sessionId, totals, resumed) {
    if (!sessionId) return resumed ? null : { ...totals };
    const all = readJson(costFile, {});
    const prev = all[sessionId];
    let delta = null;
    if (prev) {
      delta = {
        cost: totals.cost - (prev.cost || 0),
        input: totals.input - (prev.input || 0),
        output: totals.output - (prev.output || 0),
        cacheRead: totals.cacheRead - (prev.cacheRead || 0),
      };
      // 会话被 /clear 重置过：累计变小了，这一段就是新的总数
      if (delta.cost < 0 || delta.input < 0 || delta.output < 0) delta = { ...totals };
    } else if (!resumed) {
      delta = { ...totals };
    }
    all[sessionId] = { ...totals, at: Date.now() };
    const ids = Object.keys(all);
    if (ids.length > 400) {
      ids.sort((a, b) => (all[a].at || 0) - (all[b].at || 0));
      for (const id of ids.slice(0, ids.length - 400)) delete all[id];
    }
    try { writeJson(costFile, all); } catch { /* 记不下来只影响下一次的增量 */ }
    if (delta) delta.cost = round6(Math.max(0, delta.cost));
    return delta;
  }

  /**
   * 旧 stream-json 驱动只有累计的 total_cost_usd（含 --resume 之前的全部历史）：换成这一回合的花费.
   * 和 sessionDelta 共用同一个账本文件，但只维护 cost 字段，不碰 input / output / cacheRead（SDK 路径靠它们算增量）.
   * @returns {number|undefined} 增量；基线未知（resume 了账本里没有的会话）时 undefined——宁可不报，也不把累计值当成这一回合.
   */
  function costDelta(sessionId, totalCost, resumed) {
    if (typeof totalCost !== 'number' || !Number.isFinite(totalCost) || totalCost < 0) return undefined;
    if (!sessionId) return resumed ? undefined : round6(totalCost);
    const all = readJson(costFile, {});
    const prev = all[sessionId];
    let delta;
    if (prev && typeof prev.cost === 'number') {
      delta = totalCost - prev.cost;
      if (delta < 0) delta = totalCost;   // 会话被 /clear 重置过：累计变小了，这一段就是新的总数
    } else if (!resumed) delta = totalCost;
    all[sessionId] = { ...(prev || {}), cost: totalCost, at: Date.now() };
    const ids = Object.keys(all);
    if (ids.length > 400) {
      ids.sort((x, y) => (all[x].at || 0) - (all[y].at || 0));
      for (const id of ids.slice(0, ids.length - 400)) delete all[id];
    }
    try { writeJson(costFile, all); } catch { /* 记不下来只影响下一次的增量 */ }
    return delta === undefined ? undefined : round6(Math.max(0, delta));
  }

  return { getConfig, setConfig, spend, addSpend, budgetCheck, sessionDelta, costDelta, files: { cfgFile, spendFile, costFile } };
}

/** `claude auth status --json` 的输出 → 页面要显示的几项（不含令牌；邮箱是 claude 自己报告的）. */
function parseAuthStatus(text) {
  let j;
  try { j = JSON.parse(text); } catch { return null; }
  if (!j || typeof j !== 'object') return null;
  const method = j.authMethod && j.authMethod !== 'none' ? String(j.authMethod) : '';
  const out = {
    loggedIn: !!j.loggedIn,
    method,
    email: typeof j.email === 'string' ? j.email : '',
    subscription: typeof j.subscriptionType === 'string' ? j.subscriptionType : '',
    apiProvider: typeof j.apiProvider === 'string' ? j.apiProvider : '',
  };
  out.text = [out.method, out.subscription, out.email || (typeof j.account === 'string' ? j.account : '')].filter(Boolean).join(' · ');
  return out;
}

module.exports = { createAuthStore, parseAuthStatus, DEFAULTS, dayKey };
