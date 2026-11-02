/* 一个假的 window.alightDesktop，给无头 Chrome 里的「模型接入」页用（scripts/smoke/ui/models-ui.mjs 在页面脚本之前注入）。
   它不联网、不读任何密钥：服务注册表、密钥、模型列表都是内存里的假数据，由 window.__FAKE_CFG 配置。
   没有 `call`，所以 persist 走浏览器开发版的 localStorage 路径。 */
(() => {
  const cfg = window.__FAKE_CFG || {};
  const hints = { ...(cfg.keys || {}) };                       // slot -> '••••abcd'
  const user = { custom: [...(cfg.custom || [])], agents: [], overrides: { ...(cfg.overrides || {}) }, pinned: { ...(cfg.pinned || {}) }, keyBindings: { ...(cfg.keyBindings || {}) } };
  const log = (window.__FAKE_LOG = []);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const SEPARATE = new Set(cfg.separateSlots || ['kimi:cn', 'kimi:global', 'qwen:cn', 'qwen:global', 'glm:cn', 'glm:global', 'minimax:cn', 'minimax:global']);
  const slotOf = (provider, endpoint) => (endpoint && SEPARATE.has(`${provider}:${endpoint}`) ? `${provider}:${endpoint}` : provider);

  /** 469 models for the OpenRouter-sized list, a few with reasoning levels. */
  function bigList() {
    const vendors = ['anthropic', 'openai', 'google', 'meta-llama', 'mistralai', 'deepseek', 'qwen', 'x-ai', 'cohere', 'nvidia', 'microsoft', 'amazon', 'moonshotai', 'z-ai', 'minimax', 'baidu'];
    const out = [];
    for (let i = 0; i < 469; i++) {
      const v = vendors[i % vendors.length];
      const m = { id: `${v}/model-${String(i).padStart(3, '0')}${i % 7 === 0 ? ':free' : ''}`, label: `${v} Model ${i}`, ctx: [32768, 131072, 200000, 1000000][i % 4], source: 'live' };
      if (i % 5 === 0) m.effort = { style: 'openrouter', levels: ['low', 'medium', 'high'] };
      if (i % 9 === 0) m.caps = { vision: true, tools: true };
      out.push(m);
    }
    return out;
  }
  const LISTS = {
    openrouter: bigList,
    ollama: () => [{ id: 'qwen3:32b', note: '32.8B Q4_K_M', ctx: 32768, source: 'live' }, { id: 'llama4:scout', note: '109B Q4_K_M', source: 'live' }, { id: 'gpt-oss:20b', note: '20.9B MXFP4', ctx: 131072, source: 'live' }],
    siliconflow: () => ['Qwen/Qwen3-235B-A22B', 'deepseek-ai/DeepSeek-V4-Pro', 'moonshotai/Kimi-K3', 'THUDM/GLM-5', 'MiniMaxAI/MiniMax-M3'].map((id) => ({ id, source: 'live' })),
  };
  if (cfg.lists) for (const k of Object.keys(cfg.lists)) LISTS[k] = () => cfg.lists[k];

  const tests = cfg.tests || {};
  const cli = cfg.cli || {};                                    // driver -> { found, login, version }

  window.alightDesktop = {
    version: 1,
    async info() { return { encryption: cfg.encryption !== false, keys: { ...hints }, workspaceRoot: 'C:/w', platform: 'win32' }; },
    async saveKey(provider, key, endpoint) {
      log.push(['saveKey', provider, endpoint]);
      const hint = `••••${String(key).slice(-4)}`;
      hints[slotOf(provider, endpoint)] = hint;
      return { ok: true, hint };
    },
    async clearKey(provider, endpoint) { log.push(['clearKey', provider, endpoint]); delete hints[slotOf(provider, endpoint)]; return { ok: true }; },
    async detect(req) {
      await wait(120);
      const c = cli[req.driver];
      return c ? { found: true, path: `C:/tools/${req.driver}.cmd`, version: c.version || '1.0.0', login: c.login || 'unknown', account: c.account } : { found: false, login: 'unknown', detail: '' };
    },
    async models() { return null; },
    async openLogin() { return { ok: true, command: 'tool login' }; },
    async test(spec) {
      log.push(['test', spec.provider, spec.endpoint, spec.model]);
      await wait(700);
      const t = tests[spec.provider];
      if (t && t.ok === false) return { ok: false, error: t.error || '密钥无效或已过期', code: 'AUTH', ms: 420, steps: [{ name: 'models', ok: false, ms: 420, detail: t.error || '密钥无效或已过期' }] };
      return { ok: true, text: 'OK', ms: 1180, model: spec.model, steps: [{ name: 'models', ok: true, ms: 380, detail: '469 个模型' }, { name: 'chat', ok: true, ms: 1180, detail: '回复「OK」' }] };
    },
    async pickFolder() { return null; },
    async workspaceFolder(name) { return `C:/w/${name}`; },
    async openFolder() { return ''; },
    async start() { return 'fake'; },
    async input() { return true; },
    async answer() { return true; },
    async stop() { return true; },
    onEvent() { return () => {}; },
    services: {
      async list() { return JSON.parse(JSON.stringify(user)); },
      async save(def) {
        log.push(['save', def.name]);
        if (!def || typeof def.name !== 'string' || !def.name.trim()) return { ok: false, error: '名称不能为空', field: 'name' };
        const id = def.id || `x_${def.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'svc'}${user.custom.length + 1}`;
        const full = { glyph: def.name.slice(0, 1), group: 'hub', vendor: '自定义', keyHelp: '自定义服务', drivers: [], verified: '2026-10-24', ...def, id, kind: 'custom' };
        const i = user.custom.findIndex((s) => s.id === id);
        if (i >= 0) user.custom[i] = full; else user.custom.push(full);
        return { ok: true, value: full };
      },
      async remove(id) { log.push(['remove', id]); user.custom = user.custom.filter((s) => s.id !== id); for (const k of Object.keys(hints)) if (k === id || k.startsWith(`${id}:`)) delete hints[k]; return { ok: true, value: { clearedSlots: 1 } }; },
      async setOverride(id, endpoint, baseUrl) { log.push(['override', id, endpoint, baseUrl]); if (baseUrl) user.overrides[id] = { endpoint, baseUrl, confirmedHost: '' }; else delete user.overrides[id]; return { ok: true, value: null }; },
      async pin(id, model, on) {
        log.push(['pin', id, model, on]);
        const set = new Set(user.pinned[id] || []);
        if (on) set.add(model); else set.delete(model);
        user.pinned[id] = [...set];
        return { ok: true, value: user.pinned[id] };
      },
      async migrate() { return { ok: true, value: { bound: [], applied: [], rejected: [] } }; },
      async models(req) {
        log.push(['models', req.service, req.endpoint, !!req.fresh, !!req.cacheOnly]);
        await wait(cfg.listDelay ?? 250);
        const fail = (cfg.listFail || {})[req.service];
        const mk = LISTS[req.service];
        if (fail) return { ok: false, source: 'static', at: Date.now(), models: [], error: fail, code: 'AUTH' };
        if (!mk) return { ok: true, source: 'static', at: Date.now(), models: [] };
        return { ok: true, source: req.cacheOnly ? 'cache' : 'live', at: Date.now() - (cfg.listAge || 0), models: mk(), stale: !!cfg.listStale };
      },
      async modelDetail() { return { ok: false, error: '没有详情' }; },
      async probeLocal() { await wait(400); return cfg.probe || []; },
    },
    acp: {
      async probe() { return { ok: true, authMethods: [], caps: { loadSession: true, resume: false, list: false, close: false, configOptions: true, mcpHttp: false, image: true } }; },
      async registry() { return { ok: true, value: [] }; },
      async addFromRegistry() { return { ok: false, error: '假桥不支持' }; },
      async pickExe() { return { ok: false, error: '假桥不支持' }; },
      async addCustom() { return { ok: false, error: '假桥不支持' }; },
      async remove() { return { ok: true, value: null }; },
    },
  };
})();
