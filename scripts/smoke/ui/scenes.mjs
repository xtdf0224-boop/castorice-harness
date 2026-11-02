/* 界面检查用的场景：给假桥（fake-bridge.js）的配置。每个场景描述「这台电脑上接了什么」. */

const customRelay = {
  id: 'x_my-relay', kind: 'custom', name: '我的中转站', vendor: '自定义', glyph: '我', group: 'hub', protocol: 'openai-chat',
  endpoints: [{ id: 'main', label: '中转站', kind: 'payg', baseUrl: 'https://api.example.com/v1' }],
  auth: { scheme: 'bearer' }, wire: { maxTokensField: 'auto', defaultMaxOut: 16000, testMaxTokens: 512 }, defaultCtx: 128000,
  models: [{ id: 'gpt-6.1-sol', ctx: 1050000, effort: { style: 're', levels: ['low', 'medium', 'high'] } }, { id: 'deepseek-v4-pro', ctx: 1000000 }],
  drivers: [], keyHelp: '自定义服务', verified: '2026-10-24',
};

export const SCENES = {
  /** 什么都没接：首次进入 */
  empty: { keys: {}, cli: {}, custom: [] },
  /** 常见的一天：Claude(命令行已登录)、DeepSeek(密钥)、Kimi(国内站密钥)、Ollama(本机)、自定义中转站 */
  mixed: {
    keys: { deepseek: '••••a3f9', 'kimi:cn': '••••9c21', openrouter: '••••77de', 'x_my-relay': '••••beef' },
    cli: { 'claude-code': { found: true, login: 'yes', version: '3.2.1', account: 'you@example.com' }, codex: { found: true, login: 'no', version: '0.9.4' } },
    custom: [customRelay],
    pinned: { openrouter: ['anthropic/model-000:free'] },
    tests: {},
    probe: [{ service: 'ollama', endpoint: 'local', port: 11434, models: ['qwen3:32b', 'llama4:scout', 'gpt-oss:20b'] }],
  },
  /** 列表拉取失败 */
  failing: { keys: { openrouter: '••••77de' }, cli: {}, custom: [], listFail: { openrouter: '密钥无效或已过期，没能拉取模型列表' } },
};
