// 合成数据：预置 localStorage 里的偏好与任务历史（旧存储格式，version 1 / rev 2）。
// 栖枝的 B2 存储层会把这份旧数据一次性迁移进 SQLite，所以同一份种子对萤火基线与栖枝都有效。
// 全部确定性（带种子的伪随机数），同一参数两次生成逐字节相同，基线对比才有意义。

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const USER_LINES = [
  '帮我看一下这个目录里有哪些脚本', '把上一步的结果再整理成表格', '这里的报错是什么意思', '继续', '先别改，只告诉我原因',
  '能不能把函数拆小一点', '测试怎么跑', '把这段话润色一下，语气柔和一点', '为什么构建变慢了', '把 README 里的安装步骤补全',
  'ok，就按这个方案来', '再检查一遍有没有漏掉的边界情况', '把日志里的时间换成本地时间', '这个配置项是做什么的',
];
const AGENT_SENTENCES = [
  '我先读了相关文件，结构大致是这样的：入口在 main 里，渲染进程只负责展示，所有写入都经过桥接层。',
  '这个报错来自依赖的版本不一致，锁文件里记录的是旧版本，本地安装的是新版本。',
  '建议把长函数按职责拆成三段：解析、校验、落盘；这样每一段都可以单独写测试。',
  '已经按你的要求改好，下面是改动的要点，改动之外的文件都没有碰。',
  'Next, I will run the unit tests and compare the output with the previous run to make sure nothing regressed.',
  '构建变慢的主要原因是图片资源没有走缓存，每次都重新压缩；把缓存目录加进配置后恢复了正常。',
  '这里有两种做法：一是在加载时做迁移，二是在首次写入时做迁移。前者简单，后者对启动时间更友好。',
  '需要注意的边界情况有三个：空输入、超长输入，以及输入里带有控制字符。',
];
const CODE = [
  '```ts\nexport function tail<T>(items: T[], n: number): T[] {\n  return items.length <= n ? items : items.slice(items.length - n);\n}\n```',
  '```bash\nnpm run check:unit && npm run check:modules\n```',
  '```json\n{ "retry": 3, "timeoutMs": 12000, "backoff": "exponential" }\n```',
];

function pick(rand, arr) { return arr[Math.floor(rand() * arr.length)]; }

function agentText(rand) {
  const roll = rand();
  if (roll < 0.25) return pick(rand, AGENT_SENTENCES);
  if (roll < 0.7) return `${pick(rand, AGENT_SENTENCES)}${pick(rand, AGENT_SENTENCES)}\n\n- ${pick(rand, AGENT_SENTENCES)}\n- ${pick(rand, AGENT_SENTENCES)}`;
  return `${pick(rand, AGENT_SENTENCES)}\n\n${pick(rand, CODE)}\n\n${pick(rand, AGENT_SENTENCES)}${pick(rand, AGENT_SENTENCES)}`;
}

const ENGINE = { kind: 'live', provider: 'claude', auth: 'api', model: 'claude-probe-1', label: 'Claude · API · claude-probe-1' };

/** 一个合成的聊天任务。 */
export function buildChatTask({ id, title, messages, seed = 1, endAt = 1_760_000_000_000 }) {
  const rand = mulberry32(seed);
  const list = [];
  const step = 45_000;
  const start = endAt - messages * step;
  for (let i = 0; i < messages; i++) {
    const user = i % 2 === 0;
    list.push(user
      ? { id: `${id}-m${i}`, role: 'user', text: pick(rand, USER_LINES), at: start + i * step }
      : { id: `${id}-m${i}`, role: 'agent', agentId: 'orchestrator', text: agentText(rand), at: start + i * step, kind: 'reply', persona: 'firefly' });
  }
  return {
    id, title, goal: title, createdAt: start, updatedAt: endAt, agentIds: ['orchestrator'], runIds: [], messages: list,
    kind: 'chat', engine: ENGINE,
  };
}

/**
 * 旧格式的完整任务历史。
 * @param {{ tasks: Array<{id:string,title:string,messages:number,seed?:number}> }} spec
 */
export function buildStateBlob(spec) {
  const tasks = {};
  const taskOrder = [];
  for (const t of spec.tasks) {
    tasks[t.id] = buildChatTask(t);
    taskOrder.push(t.id);
  }
  return { version: 1, rev: 2, tasks, taskOrder, runs: {}, events: [] };
}

/** 假服务在服务注册表里的 id（栖枝：模型服务的地址由桌面端的服务表决定，页面传来的地址不再被读，所以 E2E 要把假服务登记成自定义服务）。 */
export const FAKE_SERVICE_ID = 'x_probe';

/**
 * 假 Anthropic 服务的自定义服务文件（userData/services.json）：无密钥的本机地址（http://127.0.0.1 是允许的），Anthropic 协议。
 * prepareProfile 的 userFiles 在第一次启动之前把它写进用户数据目录；配套的偏好由 buildPrefs({ fakeApi: { baseUrl, custom: true } }) 给出。
 */
export function fakeServiceFiles(baseUrl, model = 'claude-probe-1') {
  const def = {
    id: FAKE_SERVICE_ID, kind: 'custom', name: '探针假服务', vendor: '本机', glyph: '探', group: 'local', protocol: 'anthropic',
    auth: { scheme: 'none' }, wire: { maxTokensField: 'auto', defaultMaxOut: 16000, testMaxTokens: 512 },
    endpoints: [{ id: 'main', label: '本机', kind: 'local', baseUrl }],
    models: [{ id: model, label: model, ctx: 200000 }], defaultModel: model, drivers: [], defaultCtx: 200000, keyHelp: '自定义服务', verified: '2026-10-24',
  };
  return { 'services.json': JSON.stringify({ v: 1, services: [def], agents: [], overrides: {}, keyBindings: {}, pinned: {}, confirmed: {}, retired: [] }) };
}

/** 偏好（settings、模型接入）。默认把 Claude 配成 API 方式（密钥由 prepareProfile 存一把假的），这样首页输入框才解锁——
 *  萤火在没有任何可用模型时把整块输入框 disabled（fieldset.is-locked）。传 fakeApi: null 可得到「没配模型」的状态。
 *  栖枝的服务地址在桌面端：要把请求导到本机假服务，用 fakeApi: { baseUrl, custom: true } 并给 prepareProfile 传 userFiles: fakeServiceFiles(baseUrl)。 */
export function buildPrefs({ settings = {}, fakeApi = { baseUrl: '' }, sidebarCollapsed = false } = {}) {
  const prefs = {
    settingsRev: 2, policyRev: 2,
    settings: { bootAnimation: false, ...settings },
    navCollapsed: sidebarCollapsed,
    console: { open: false, height: 280, tab: 'tools' },
    tools: [], agents: [],
  };
  // 值为 'default' 的设置项不写入，让应用用自己的默认值（比如开屏）
  for (const k of Object.keys(prefs.settings)) if (prefs.settings[k] === 'default') delete prefs.settings[k];
  if (fakeApi && fakeApi.custom) {
    prefs.models = {
      v: 2,
      customMirror: [{ id: FAKE_SERVICE_ID, name: '探针假服务', glyph: '探', group: 'local' }],
      providers: { [FAKE_SERVICE_ID]: { id: FAKE_SERVICE_ID, auth: 'api', driver: 'claude-compat', region: 'main', baseUrl: '', model: fakeApi.model ?? 'claude-probe-1', cliModel: '', cliPath: '' } },
      defaultEngine: FAKE_SERVICE_ID,
    };
  } else if (fakeApi) {
    // 栖枝：保持空地址（桌面端会拒绝把一个 http 地址当作厂商的服务地址迁过去，并在界面上提示）；萤火：地址写在这里，E2E 把它指向假服务
    prefs.models = {
      providers: { claude: { id: 'claude', auth: 'api', driver: 'claude-code', region: 'global', baseUrl: fakeApi.baseUrl ?? '', model: fakeApi.model ?? 'claude-probe-1', cliModel: '', cliPath: '' } },
      defaultEngine: 'claude',
    };
  }
  return prefs;
}

/** 写 localStorage 的页面脚本；force 时覆盖已有值（reload 前后用）。 */
export function storageScript(entries, { force = false } = {}) {
  const json = JSON.stringify(entries);
  return `(() => { try { const e = ${json}; for (const k of Object.keys(e)) { ${force ? '' : "if (localStorage.getItem(k) !== null) continue; "}localStorage.setItem(k, e[k]); } } catch (err) { console.error('probe seed failed: ' + err); } })();`;
}
