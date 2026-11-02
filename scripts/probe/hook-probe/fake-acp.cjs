// 假的 ACP 代理（check-engine / electron-check / services-electron-main 用）。
// 实现搬到了 scripts/fixtures/fake-acp.cjs（模型接入 T-ACP 的完整版）；这里只是转过去，旧的环境变量（FAKE_ACP_MODES / CURRENT / LOG / FAIL_MODES /
// PROMPT_LOG / PERM_KIND / PERM_LOG / ENV_DUMP / ENV_KEYS）原样有效，默认行为不变：initialize / session/new（旧的 modes）/ session/set_mode / session/prompt。
require('../../fixtures/fake-acp.cjs');
