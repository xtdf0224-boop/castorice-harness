/* The starting point of a fresh install: default settings, the agent roster, tool policies and an
   empty task list. Nothing is made up — tasks, runs and models all come from what the user does. */
import type { Agent, AppState, PetSettings, Settings, ToolDef } from '../lib/types';
import { PERSONA } from '../lib/persona';
import { initialModels } from './models';

/** 桌宠的默认设置（docs/PET-PLAN.md §3）：桌宠、看屏、朗读、实时陪玩新装都是关的. */
export const DEFAULT_PET: PetSettings = {
  enabled: false,
  scale: 1,
  watch: false,
  proactivity: 'normal',
  cooldownSec: 120,
  imagesPerHour: 20,
  voice: { enabled: false, provider: 'elevenlabs', voiceIds: { elevenlabs: '', minimax: '', edge: '' }, volume: 80, fallback: false, models: { elevenlabs: '', minimax: '' } },
  realtime: { listen: 'key', sensitivity: 50, fastVoice: true, autoOffMin: 10 },
  // 全局热键：只有 Alt+字母会让开着桌宠时所有程序的菜单快捷键失灵，所以带 Ctrl；不和萤火的 Ctrl+Alt+F / P 撞.
  hotkeyAsk: 'Ctrl+Alt+B',
  hotkeyPause: 'Ctrl+Alt+H',
  neverWatch: [],
  gameAllow: [],
  gameDeny: [],
  follow: true,
  fpsCap: 60,
};

export const DEFAULT_SETTINGS: Settings = {
  mode: 'night',
  motion: 'system',
  particles: 'normal',
  themeCursor: false,
  confirmBeforeCancel: true,
  openConsoleOnError: true,
  closeToTray: true,
  wallpaper: true,
  wallpaperVisibility: 80,
  panelGlass: 65,
  wallpaperAdaptive: true,
  bootAnimation: true,
  bootEnter: 'auto',
  bootVideo: false,   // 昼开屏默认实时（2026-10-29 改回；beta.4 / beta.5 默认视频，旧存档由 persist.migrateSettings rev 5 换回）
  persona: true,
  callName: '阁下',
  typing: 'natural',
  /* 每日问候（greet.* 模板，零 token，只在用户自己打开应用 / 闲聊页时一次，§2.2）：新装默认开；旧存档的值由 persist.migrateSettings 原样保留.
     主动搭话由 proactive 管（默认 auto = 仅话量「多」才开口，D7）；小状态只是名字旁的一个词. */
  lifeGreeting: true,
  lifeMood: true,
  lifeNudge: false,   // @deprecated 垫片（D17）：setProactive 只在 proactive === 'on' 时写 true（auto / off 都是 false）；默认保持 0.1.4 的 false，回滚后不会凭空多出模型搭话
  distance: 1,        // @deprecated 垫片：由 level / persona 派生（D17）
  /* 施工图 §2.2 的新键. */
  level: 'm',
  proactive: 'auto',
  proactiveTopics: false,
  memoryOn: false,
  stepBack: true,
  storyBox: 'chat',
  stickers: true,
  motionTier: 'B',
  returnAfterMin: 30,
  pet: DEFAULT_PET,
};

export const AGENTS: Agent[] = [
  { id: 'orchestrator', name: '编排 Agent', role: '拆解目标、分派步骤、汇总结果', glyph: '编', hue: 'mint',
    description: '负责理解目标、制定计划并把步骤分派给其他 Agent，最后汇总产出。遇到需要确认的操作时会暂停并征求你的意见。',
    tools: ['read_file', 'code_search', 'web_search'], enabled: true },   // 编排 Agent 恒无 tiers：沿用全局档
  { id: 'researcher', name: '检索 Agent', role: '检索资料、抓取文档、整理对比', glyph: '检', hue: 'silver',
    description: '擅长检索网页与项目内容，整理资料并给出有依据的对比。',
    tiers: { write_file: 'off', shell: 'off', git: 'off' },
    tools: ['web_search', 'web_fetch', 'read_file', 'code_search', 'browser_read', 'browser_act'], enabled: true },
  { id: 'coder', name: '编码 Agent', role: '阅读与修改代码、执行命令', glyph: '码', hue: 'firefly',
    description: '负责阅读代码、生成改动并在确认后写入文件或执行命令。',
    tiers: { web_search: 'off', web_fetch: 'off', browser_read: 'off', browser_act: 'off' },
    tools: ['read_file', 'write_file', 'code_search', 'shell', 'git'], enabled: true },
  { id: 'reviewer', name: '审查 Agent', role: '运行测试、复核结论', glyph: '审', hue: 'gold',
    description: '负责运行测试、检查产出质量，并指出缺少依据的结论。',
    tiers: { write_file: 'off', web_search: 'off', web_fetch: 'off', git: 'off', browser_read: 'off', browser_act: 'off' },
    tools: ['read_file', 'shell', 'code_search'], enabled: true },
];

export const TOOLS: ToolDef[] = [
  { id: 'read_file',   name: '读取文件', category: '文件',     risk: 'low',    permission: 'auto',    description: '读取工作区内的文件内容。' },
  { id: 'write_file',  name: '写入文件', category: '文件',     risk: 'medium', permission: 'confirm', description: '创建或修改工作区内的文件。' },
  { id: 'code_search', name: '代码搜索', category: '检索',     risk: 'low',    permission: 'auto',    description: '在项目中按关键字或正则搜索。' },
  { id: 'shell',       name: '执行命令', category: '执行',     risk: 'high',   permission: 'confirm', description: '在任务的工作文件夹里执行命令。' },
  { id: 'web_search',  name: '网页搜索', category: '网络',     risk: 'low',    permission: 'auto',    description: '通过搜索服务检索网页。' },
  { id: 'web_fetch',   name: '抓取网页', category: '网络',     risk: 'medium', permission: 'confirm', description: '下载网页并提取正文。' },
  { id: 'git',         name: 'Git 操作', category: '版本控制', risk: 'medium', permission: 'confirm', description: '查看状态、提交与切换分支。' },
  { id: 'browser_read', name: '浏览网页', category: '网络',     risk: 'low',    permission: 'auto',    description: '读取栖枝浏览器当前页面、截图、滚动（只在开启「浏览器」的命令行任务里出现）。' },
  { id: 'browser_act',  name: '操作网页', category: '网络',     risk: 'medium', permission: 'confirm', description: '在栖枝浏览器里打开网址、后退、点击、输入、按键——打开的可能是你已登录的网站，点击和输入可能提交表单或改动网站上的数据。' },
  { id: 'other',       name: '其他工具', category: '执行',     risk: 'medium', permission: 'confirm', description: '命令行 Agent 自带的其他工具（子任务、MCP 工具等）。' },
];

/** 编排 Agent takes 遐蝶's name when she is speaking (distance ≥ 1). */
export function syncPersonaAgent(d: { agents: Agent[]; settings: Settings }) {
  const o = d.agents.find((a) => a.id === 'orchestrator');
  if (!o) return;
  const p = d.settings.persona ? PERSONA[d.settings.mode] : undefined;
  o.name = p ? p.name : AGENTS[0].name;
  o.glyph = p ? p.glyph : AGENTS[0].glyph;
}

export function emptyState(_now: number, settings: Settings = DEFAULT_SETTINGS): AppState {
  const agents = AGENTS.map((a) => ({ ...a }));
  syncPersonaAgent({ agents, settings });
  return {
    view: 'new',
    workspaceTab: 'conversation',
    console: { open: false, tab: 'tools', height: 280 },
    statusDrawerOpen: false,
    navCollapsed: false,
    settings,
    tasks: {},
    taskOrder: [],
    runs: {},
    agents,
    tools: TOOLS,
    models: initialModels(),
    events: [],
    toasts: [],
    announcement: { text: '', at: 0 },
    memory: [],
    quietUntil: 0,
  };
}
