/* 每家预设的「最小请求」烟测（MODELS-SPEC §15.7）。**默认不联网。**
   只有同时满足三个条件才会发出真实请求：命令行带 --live、环境变量 ALIGHT_SMOKE_LIVE=1、该服务有对应密钥环境变量
   ALIGHT_SMOKE_KEY_<服务 id 大写，- 换 _>（可再用 ALIGHT_SMOKE_KEY_<ID>_<端点 ID 大写> 给某个端点单独的密钥）。缺任何一个就只做 dry-run。

     node scripts/smoke/services-smoke.mjs                       # dry-run：每个预设端点打印它「会发」的请求
     node scripts/smoke/services-smoke.mjs --only gemini,grok    # 只看这几个（按 id）
     node scripts/smoke/services-smoke.mjs --cli                 # 只检查命令行代理的 bin 在不在 PATH、版本号（不调模型）
     ALIGHT_SMOKE_LIVE=1 ALIGHT_SMOKE_KEY_GEMINI=… node scripts/smoke/services-smoke.mjs --live --only gemini
     --custom my-relay.json                       # 把你自己的自定义服务（一个或一组定义，格式同 services.json 的 services[]）一起测；也能拿本机假服务试脚本自己

   它复用 electron/ai/services.cjs 的 resolveApi 与 electron/ai/api.cjs 的真实适配器（不另写一套请求构造），所以测到的就是产品代码。
   规矩：绝不对 plan（套餐）端点做 API 请求（只在 --cli 里看对应命令行）；绝不打印或落盘密钥（密钥只在内存里交给适配器，输出过一遍打码）；
   每个请求间隔 ≥ 1 秒；失败不重试超过适配器自己的上限；单次运行最多 5 个服务（--live），要更多请分批；
   输出 scripts/smoke/out/<日期>.json 与一张人读表；**不会自动改 verified / unverified**，只在末尾列出「建议更新」，由人改预设（§5.9）。
   退出码：dry-run 恒 0（除非 URL 断言失败）；live 任一步失败为 1。 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const req = createRequire(path.join(root, 'package.json'));

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const ONLY = (opt('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const CUSTOM_FILES = argv.flatMap((a, i) => (a === '--custom' && argv[i + 1] ? [argv[i + 1]] : []));
const LIVE = flag('live');
const CLI = flag('cli');
const VERBOSE = flag('verbose');
const MAX_LIVE_SERVICES = 5;
const GAP_MS = 1100;

const net = req('./electron/ai/net.cjs');
const services = req('./electron/ai/services.cjs');
const api = req('./electron/ai/api.cjs');
const secrets = req('./electron/ai/secrets.cjs');
const modelsApi = req('./electron/ai/models-api.cjs');
const { scrubValue } = req('./electron/ai/scrub.cjs');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alight-smoke-'));
// no key is ever stored: secrets.cjs only needs a folder to look in (it stays empty) and a stand-in for the system encryption
secrets.__setDeps({
  dir: tmp,
  safeStorage: { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (s) => Buffer.from(s), decryptStringAsync: async (b) => ({ result: b.toString(), shouldReEncrypt: false }) },
});
const reg = services.createRegistry({ userDir: tmp, secrets });
secrets.configure(reg.secretsConfig());
const cat = services.catalog();
// --custom <file.json>: custom service definitions (an array, or one object) to smoke as well — your own relay, or a fake on 127.0.0.1 to try this script itself.
// They are saved into the run's temp registry like the 「添加服务」 dialog would (the same validation); nothing is written to your real settings.
const customServices = [];
for (const f of CUSTOM_FILES) {
  let defs;
  try { defs = JSON.parse(fs.readFileSync(path.resolve(f), 'utf8')); } catch (e) { console.error(`--custom ${f}：读不了（${e.message}）`); process.exit(2); }
  for (const d of Array.isArray(defs) ? defs : [defs]) {
    const r = await reg.saveService(d, { confirm: async () => true });
    if (!r.ok) { console.error(`--custom ${f}：${r.error}`); process.exit(2); }
    customServices.push(r.value);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envName = (id, ep) => `ALIGHT_SMOKE_KEY_${id.toUpperCase().replace(/-/g, '_')}${ep ? `_${ep.toUpperCase().replace(/-/g, '_')}` : ''}`;
const keyFor = (id, ep) => process.env[envName(id, ep)] || process.env[envName(id)] || '';
const liveAllowed = LIVE && process.env.ALIGHT_SMOKE_LIVE === '1';
/** Every printed string passes this: a key (if any slipped in) is replaced. */
const secretValues = () => [...new Set(Object.keys(process.env).filter((k) => k.startsWith('ALIGHT_SMOKE_KEY_')).map((k) => process.env[k]).filter((v) => v && v.length >= 6))];
const clean = (s) => { let t = String(s ?? ''); for (const k of secretValues()) t = t.split(k).join('***'); return t; };

/** A value for each {placeholder} that fits its pattern (the preset's own example when it does). */
function paramsFor(ep) {
  const out = {};
  for (const p of ep.params || []) {
    const re = new RegExp(p.pattern);
    const candidates = [p.example, 'my-resource', 'us-east-1', '0'.repeat(32), 'example'].filter(Boolean);
    out[p.name] = candidates.find((c) => re.test(c)) || candidates[0];
  }
  return out;
}

const mask = (headers) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, /^(authorization|x-api-key|api-key|x-goog-api-key)$/i.test(k) || /key|token|auth/i.test(k) ? String(v).replace(/(Bearer\s+)?.+/, (m, b) => `${b || ''}***`) : v]));

/* ═══════════════════════════ --cli ═══════════════════════════ */

function cliChecks() {
  const rows = [];
  const bins = new Map();
  for (const d of cat.drivers) if (d.bin) bins.set(d.bin, `驱动 ${d.id}`);
  for (const a of cat.agents) for (const b of a.bin) if (!bins.has(b)) bins.set(b, `代理 ${a.id}`);
  for (const [bin, who] of bins) {
    const where = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
    const lines = where.status === 0 ? where.stdout.split(/\r?\n/).filter(Boolean) : [];
    // on Windows `where` also lists extension-less shims first: run the one Windows can run
    const found = (process.platform === 'win32' ? lines.find((l) => /\.(exe|cmd|bat|com)$/i.test(l)) : undefined) || lines[0] || '';
    let version = '';
    if (found) {
      const v = spawnSync(found, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 4000, shell: /\.(cmd|bat)$/i.test(found) });
      version = String(v.stdout || v.stderr || '').split(/\r?\n/).find(Boolean) || '';
    }
    rows.push({ bin, who, found: !!found, path: found, version: clean(version).slice(0, 80) });
  }
  return rows;
}

/* ═══════════════════════════ dry-run ═══════════════════════════ */

function chosenModel(service, ep) {
  const list = ep.models || service.models;
  return service.defaultModel || (list[0] && list[0].id) || 'MODEL-ID';
}

function dryRun(service, ep) {
  const params = paramsFor(ep);
  const model = chosenModel(service, ep);
  const rr = reg.resolveApi({ driver: 'api', provider: service.id, endpoint: ep.id, params, model, messages: [{ role: 'user', content: '只回复 OK' }] }, { test: true });
  if (!rr.ok) return { service: service.id, endpoint: ep.id, model, ok: false, error: rr.error, code: rr.code };
  const r = rr.r;
  const build = r.protocol === 'anthropic' ? api.buildAnthropicBody : api.buildOpenAIBody;
  const body = build(r);
  const headers = mask(api.buildHeaders(r, 'KEY'));
  const urlOk = !!net.checkBaseUrl(r.baseUrl).url;
  const retries = [];
  if (r.protocol !== 'anthropic') {
    if (r.wire.streamUsage === 'include_usage') retries.push('stream_options 被拒 → 去掉重试一次');
    if (r.wire.maxTokensField === 'auto') retries.push('输出上限字段被拒 → 换另一个字段重试一次');
  }
  if (r.effort.level) retries.push('推理档位被拒 → 降一档重试一次');
  return {
    service: service.id, endpoint: ep.id, model, ok: urlOk, protocol: r.protocol, method: 'POST', url: r.url, headers, body, maxTokens: r.maxTokens, retries, notices: r.notices.map((n) => n.text),
    error: urlOk ? undefined : '地址没有通过 checkBaseUrl',
  };
}

/* ═══════════════════════════ live ═══════════════════════════ */

const classify = (e) => {
  const c = e && e.code;
  if (!c) return 'NETWORK';
  if (['AUTH', 'AUTH_SCOPE', 'MODEL', 'PARAM', 'QUOTA', 'NOT_FOUND', 'SERVER'].includes(c)) return c === 'AUTH_SCOPE' ? 'AUTH' : c === 'NOT_FOUND' ? 'MODEL' : c;
  return /^E[A-Z]+$/.test(c) || c === 'ABORT' || c === 'TIMEOUT' ? 'NETWORK' : c;
};

async function liveOne(service, ep) {
  const key = keyFor(service.id, ep.id);
  const params = paramsFor(ep);
  const model = chosenModel(service, ep);
  const steps = [];
  const mapi = modelsApi.createModelsApi({ registry: Object.assign(Object.create(reg), { readKey: async () => key }), cacheFile: path.join(tmp, `cache-${service.id}-${ep.id}.json`), tooSoon: () => false });
  // 1 · the list (only when there is one and the key may be used)
  if (service.modelsApi && !(service.modelsApi.auth === 'required' && !key) && !(service.modelsApi.onlyEndpoints && !service.modelsApi.onlyEndpoints.includes(ep.id))) {
    const t0 = Date.now();
    const r = await mapi.listModels({ service: service.id, endpoint: ep.id, params, fresh: true });
    steps.push({ name: 'models', ms: Date.now() - t0, result: r.source === 'live' ? 'ok' : (r.code === 'NO_LIST' ? 'NO_LIST' : classify({ code: r.code })), detail: r.source === 'live' ? `${r.models.length} 个模型` : clean(r.error || ''), count: r.models.length });
    await sleep(GAP_MS);
  }
  // 2 · one minimal chat turn
  const rr = reg.resolveApi({ driver: 'api', provider: service.id, endpoint: ep.id, params, model, messages: [{ role: 'user', content: '只回复 OK' }] }, { test: true });
  if (!rr.ok) { steps.push({ name: 'chat', ms: 0, result: rr.code === 'PLAN_KEY' ? 'PLAN_KEY' : 'PARAM', detail: clean(rr.error) }); return { service: service.id, endpoint: ep.id, model, steps }; }
  const events = [];
  const t0 = Date.now();
  let result;
  let error;
  try {
    const run = rr.r.protocol === 'anthropic' ? api.streamAnthropic : api.streamOpenAI;
    result = await run(rr.r, key, (e) => events.push(e), AbortSignal.timeout(60_000));
  } catch (e) { error = e; }
  const usage = events.filter((e) => e.type === 'usage').pop();
  steps.push({
    name: 'chat', ms: Date.now() - t0, result: error ? classify(error) : 'ok', detail: error ? clean(error.message).slice(0, 200) : `回复「${clean(result.text).slice(0, 30)}」`,
    thinking: events.some((e) => e.type === 'thinking' && e.text), finishReason: result && result.stopReason, usage: usage ? { input: usage.input, output: usage.output } : undefined,
    notices: events.filter((e) => e.type === 'notice').map((e) => clean(e.text)),
  });
  return { service: service.id, endpoint: ep.id, model, steps };
}

/* ═══════════════════════════ main ═══════════════════════════ */

const pick = () => {
  let list = [...cat.presets, ...customServices];
  if (ONLY.length) list = list.filter((s) => ONLY.includes(s.id));
  else list = list.filter((s) => !s.hidden);
  return list;
};

const report = { at: new Date().toISOString(), mode: CLI ? 'cli' : liveAllowed ? 'live' : 'dry-run', results: [], cli: [], suggestions: [] };
let failedUrl = 0;
let failedLive = 0;

if (CLI) {
  report.cli = cliChecks();
  console.log('命令行：bin 在不在 PATH、--version（不调模型）\n');
  for (const r of report.cli) console.log(`  ${r.found ? 'ok  ' : '缺  '} ${r.bin.padEnd(14)} ${r.who.padEnd(26)} ${r.found ? `${r.version || '（没有版本输出）'}` : '不在 PATH 上'}`);
} else {
  if (LIVE && !liveAllowed) console.log('提示：--live 还需要环境变量 ALIGHT_SMOKE_LIVE=1，所以这次只做 dry-run。\n');
  const list = pick();
  let liveCount = 0;
  for (const service of list) {
    const eps = service.endpoints.filter((e) => e.baseUrl);
    for (const ep of service.endpoints) {
      if (ep.kind === 'plan') { report.results.push({ service: service.id, endpoint: ep.id, skipped: 'plan', note: '套餐端点：套餐 Key 只能给命令行工具用，不做 API 请求（只在 --cli 里看对应命令行）' }); continue; }
      if (!ep.baseUrl) continue;
      const d = dryRun(service, ep);
      const wantLive = liveAllowed && !!keyFor(service.id, ep.id);
      if (!wantLive || liveCount >= MAX_LIVE_SERVICES) {
        report.results.push({ ...d, mode: 'dry-run', ...(wantLive ? { note: `单次运行最多 ${MAX_LIVE_SERVICES} 个服务：这个留给下一批` } : liveAllowed ? { note: `没有 ${envName(service.id, ep.id)} / ${envName(service.id)}，只做 dry-run` } : {}) });
        if (!d.ok) failedUrl += 1;
        continue;
      }
      if (!d.ok) { failedUrl += 1; report.results.push({ ...d, mode: 'dry-run' }); continue; }
      if (!report.results.some((x) => x.mode === 'live' && x.service === service.id)) liveCount += 1;
      const l = await liveOne(service, ep);
      report.results.push({ ...d, mode: 'live', steps: l.steps });
      if (l.steps.some((s) => s.result !== 'ok' && s.result !== 'NO_LIST')) failedLive += 1;
      await sleep(GAP_MS);
    }
    void eps;
  }

  // 人读的表
  for (const r of report.results) {
    if (r.skipped) { console.log(`· ${r.service} · ${r.endpoint}  ${r.note}`); continue; }
    console.log(`\n${r.ok ? '·' : '✗'} ${r.service} · ${r.endpoint} · ${r.model}${r.mode === 'live' ? '  [live]' : ''}`);
    if (r.error) console.log(`    ${r.error}`);
    if (r.url) {
      console.log(`    ${r.method} ${r.url}`);
      if (VERBOSE || r.mode === 'dry-run') console.log(`    headers ${JSON.stringify(r.headers)}`);
      console.log(`    body    ${VERBOSE ? JSON.stringify(r.body, null, 2).replace(/\n/g, '\n            ') : JSON.stringify(r.body)}`);
      if (r.retries.length) console.log(`    重试    ${r.retries.join('；')}（总共最多两次）`);
      for (const n of r.notices) console.log(`    提示    ${n}`);
    }
    if (r.note) console.log(`    ${r.note}`);
    for (const s of r.steps || []) console.log(`    ${s.name.padEnd(6)} ${s.result.padEnd(9)} ${String(s.ms).padStart(5)} ms  ${s.detail}${s.thinking ? '  [有思考文字]' : ''}${s.finishReason ? `  finish=${s.finishReason}` : ''}${s.usage ? `  usage=${s.usage.input}/${s.usage.output}` : ''}`);
  }

  // 建议更新（不自动改预设）
  for (const r of report.results.filter((x) => x.mode === 'live')) {
    const svc = cat.byId.get(r.service) || customServices.find((x) => x.id === r.service);
    const good = r.steps.every((s) => s.result === 'ok' || s.result === 'NO_LIST');
    if (good && svc && svc.unverified && svc.unverified.length) report.suggestions.push(`${r.service}：这一轮最小请求通过。对照 unverified 逐条看：${svc.unverified.map((u) => `「${u}」`).join('、')}，确认的删掉并把 verified 改成今天（${new Date().toISOString().slice(0, 10)}）。`);
    if (!good) report.suggestions.push(`${r.service} · ${r.endpoint}：${r.steps.filter((s) => s.result !== 'ok' && s.result !== 'NO_LIST').map((s) => `${s.name} ${s.result}（${s.detail}）`).join('；')}。先查是密钥、地址还是预设里的写法（maxTokensField / 档位 / 方言）。`);
  }
  if (report.suggestions.length) console.log(`\n建议更新（不会自动改）：\n${report.suggestions.map((s) => `  - ${s}`).join('\n')}`);
  const n = report.results.filter((r) => !r.skipped).length;
  console.log(`\n${n} 个（服务，端点）${liveAllowed ? '，live ' + report.results.filter((r) => r.mode === 'live').length + ' 个' : '，全部 dry-run'}${failedUrl ? `；${failedUrl} 个地址断言失败` : ''}${failedLive ? `；${failedLive} 个 live 失败` : ''}`);
}

// 结果文件（已 gitignore），里面没有密钥：headers 打码，错误信息过 clean
const outDir = process.env.ALIGHT_SMOKE_OUT || path.join(here, 'out');
try {
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, `${report.at.slice(0, 10)}.json`), clean(JSON.stringify(report, null, 2)));
} catch { /* the table above is the result */ }
void scrubValue;
secrets.__setDeps(null);
secrets.configure(null);
try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* next time */ }
process.exit(failedUrl || (LIVE && failedLive) ? 1 : 0);
