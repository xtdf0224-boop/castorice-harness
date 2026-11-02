/* Domain model of the harness. Everything the UI shows comes from these shapes: tasks, the runs real
   models carry out (live.ts drives them through the desktop bridge), and the settings around them. */

/** 'new' = 首页「归来」（含新开输入框）；'queue' = 「待你」全部. */
export type ViewId = 'new' | 'queue' | 'tasks' | 'task' | 'agents' | 'tools' | 'models' | 'history' | 'settings';
export type WorkspaceTab = 'conversation' | 'steps' | 'artifacts';
export type ConsoleTab = 'tools' | 'terminal' | 'errors' | 'timeline';

/** 夜（冥河，默认）/ 昼（花海）. */
export type ThemeId = 'night' | 'day';
/** @deprecated 旧名，等同 ThemeId。新代码用 ThemeId。 */
export type VisualMode = ThemeId;
export type MotionPref = 'system' | 'reduced' | 'full';
export type ParticleDensity = 'off' | 'low' | 'normal';

export type RunStatus = 'queued' | 'running' | 'paused' | 'awaiting' | 'completed' | 'failed' | 'cancelled';
export type StepStatus = 'pending' | 'running' | 'awaiting' | 'done' | 'failed' | 'skipped' | 'cancelled';
export type ToolCallStatus = 'running' | 'awaiting' | 'ok' | 'error' | 'denied' | 'cancelled';
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type AgentActivity = 'idle' | 'thinking' | 'tool' | 'waiting' | 'paused';
export type ToolPermission = 'auto' | 'confirm' | 'off';
export type Risk = 'low' | 'medium' | 'high';
export type Tone = 'neutral' | 'info' | 'running' | 'success' | 'warning' | 'danger' | 'paused';

export type AgentId = 'orchestrator' | 'researcher' | 'coder' | 'reviewer';
export type ToolId = 'read_file' | 'write_file' | 'shell' | 'code_search' | 'web_search' | 'web_fetch' | 'git' | 'browser_read' | 'browser_act' | 'other';

/* ───────────── 模型接入 ───────────── */

/** A model service: one of the catalog's presets (claude, gpt, deepseek, kimi, qwen, glm, minimax, doubao, gemini, …) or a custom one (`x_…`).
 *  The services themselves are described in lib/services.ts (types) and electron/ai/catalog/*.json (presets). */
export type ProviderId = string;
/** CLI programs the desktop app can drive. `claude-compat` = Claude Code pointed at another vendor's
 *  Anthropic-compatible endpoint with that vendor's key. `acp:<id>` = a command-line agent that speaks ACP
 *  (`kimi` / `qwen` / `mcode` stay as aliases of `acp:kimi` etc.: tasks saved earlier keep them). */
export type DriverId = import('./services').DriverId;
export type AuthMode = 'cli' | 'api';
/** What a work task's CLI agent may do: follow 工具与技能's policies, or only read. */
export type WorkAccess = 'policy' | 'read';

export interface CliStatus {
  found: boolean;
  path?: string;
  version?: string;
  login: 'yes' | 'no' | 'unknown' | 'n/a';
  account?: string;
  detail?: string;
  at: number;
}

export interface ConnectionTest {
  ok: boolean;
  at: number;
  ms: number;
  message: string;
  auth: AuthMode;
  driver?: DriverId;
  /** The API way tests in steps (model list, then one chat): what each did. */
  steps?: import('./services').TestStep[];
}

/** Non-secret settings for one vendor. The key itself lives encrypted in the desktop process. */
export interface ProviderConfig {
  id: ProviderId;
  /** Which way new tasks use this vendor. */
  auth: AuthMode;
  driver: DriverId;
  /** The endpoint id (国内 / 国际 / 套餐…). Old saves have cn / global / coding, which the catalog keeps. */
  region: string;
  /** Overrides the region's base URL when not empty. Moved to the main process (svc:override) at the first start of the new version; '' afterwards. */
  baseUrl: string;
  /** Values of the {placeholders} in the region's address (Azure resource name, Bedrock region…); the main process checks them again. */
  params?: Record<string, string>;
  model: string;
  /** Model passed to the CLI; '' = the CLI's own default. */
  cliModel: string;
  /** Custom path to the CLI; '' = find it on PATH. */
  cliPath: string;
  /** Codex only: its Windows sandbox fails on some machines; 'danger-full-access' runs without it. */
  codexSandbox?: 'workspace-write' | 'danger-full-access';
  /** Default 推理强度 for new tasks using the API way / the CLI way; undefined = the model's own default. */
  effort?: import('./effort').Effort;
  cliEffort?: import('./effort').Effort;
  /** '••••abcd' when a key is saved. */
  keyHint?: string;
  cli?: CliStatus;
  test?: ConnectionTest;
}

export interface ModelState {
  /** 2 = the model-access rework (service registry). Absent / 1 = saved by the first release. */
  v?: 2;
  providers: Record<ProviderId, ProviderConfig>;
  /** Name, glyph and group of the custom services as of last time, so a task that names one can still show it before the desktop side answers. */
  customMirror?: import('./services').CustomMirror[];
  /** Saved key hints per SLOT (`<service>` or `<service>:<endpoint>`), from the desktop side. Not saved. */
  keyHints?: Record<string, string>;
  /** Which region the old single key of a service belongs to (see lib/services.ts keyHintFor). Not saved. */
  keyBindings?: Record<string, string>;
  /** Pinned models per service (★ in the model picker). Not saved here (the desktop side keeps them). */
  pinned?: Record<string, string[]>;
  /** Preset addresses the user changed, per service. Not saved here. */
  overrides?: Record<string, { endpoint: string; baseUrl: string; confirmedHost: string }>;
  /** Models of each service: the presets merged with what the service's own list said (svc:models). Not saved. */
  liveApi?: Record<string, import('./services').ModelDef[]>;
  /** Where each `liveApi` list came from and how old it is (for 「缓存 · 6 分钟前」 and the failure line). Not saved. */
  listMeta?: Record<string, { at: number; source: 'live' | 'cache' | 'static'; stale?: boolean; error?: string; code?: string }>;
  /** Models a CLI reports live (Codex: the account's models and their effort levels). Not saved. */
  live?: Partial<Record<DriverId, import('./effort').LiveModel[]>>;
  /** Running inside the desktop app (model access needs it). */
  desktop: boolean;
  encryption: boolean;
  workspaceRoot?: string;
  /** Vendor preselected for new tasks ('' = the first one that is ready). */
  defaultEngine: ProviderId | '';
}

/** How a task (or one agent's steps) runs: which vendor, which way, which model. */
export interface TaskEngine {
  kind: 'live';
  provider: ProviderId;
  auth: AuthMode;
  driver?: DriverId;
  model: string;
  /** e.g. 「Claude · Claude Code」 — shown in headers and messages. */
  label: string;
  /** Working folder for CLI agents. */
  cwd?: string;
  access?: WorkAccess;
  /** 推理强度; undefined = the model's / tool's own default. */
  effort?: import('./effort').Effort;
  /** 浏览器控制: the CLI agent may drive the 栖枝浏览器 window. */
  browser?: boolean;
  /** 输入框里的权限模式（工作任务）；undefined = 'ask'. */
  permissionMode?: PermissionMode;
}

export type TaskKind = 'chat' | 'work';

/** A skill folder in <userData>/skills (SKILL.md frontmatter + body). */
export interface SkillInfo {
  folder: string;
  name: string;
  description: string;
  modes: TaskKind[];
  dir: string;
  skillFile: string;
  enabled: boolean;
  body: string;
  version?: string;
  author?: string;
  /** Why it cannot be used yet (no SKILL.md, no description…). */
  error?: string;
}

/** An agent's own model, set on the Agent page: an engine choice (`claude:cli`…), model and effort. */
export interface AgentEngine {
  /** EngineChoice key: `${provider}:${auth}`. */
  key: string;
  /** '' = that way's default model. */
  model: string;
  effort?: import('./effort').Effort;
}

/** 'other' 不开放覆盖：执行链无法按名字封它，现状也是豁免. */
export type TierableToolId = Exclude<ToolId, 'other'>;
/** 只存「比全局更严」的覆盖；缺省 = 沿用全局. 档序 auto < confirm < off. */
export type AgentTiers = Partial<Record<TierableToolId, 'confirm' | 'off'>>;

export interface Agent {
  id: AgentId;
  name: string;          // functional name, e.g. 编排 Agent
  role: string;          // one line: what it is for
  description: string;
  /** Its own model for the steps it is given; undefined = the task's model. The 编排 Agent always uses the task's. */
  engine?: AgentEngine;
  /** 比全局更严的工具档覆盖（§2.1.1）；缺省 = 全部沿用全局。编排 Agent 恒无覆盖. */
  tiers?: AgentTiers;
  /** Tools it may use when its steps run on a command-line agent.
   *  @deprecated 兼容垫片（D17）：本版继续双写（legacyToolsOf），下一版删. 新代码读 tiers. */
  tools: ToolId[];
  enabled: boolean;
  /** Short glyph text for the avatar (1–2 chars). */
  glyph: string;
  /** Hue token name used for the avatar ring: one of mint | firefly | silver | gold. */
  hue: 'mint' | 'firefly' | 'silver' | 'gold';
}

export interface ToolDef {
  id: ToolId;
  name: string;
  description: string;
  category: '文件' | '执行' | '检索' | '网络' | '版本控制';
  permission: ToolPermission;
  risk: Risk;
}

export interface Task {
  id: string;
  title: string;
  goal: string;
  createdAt: number;
  updatedAt: number;
  agentIds: AgentId[];
  /** Oldest first. The last entry is the current run. */
  runIds: string[];
  messages: Message[];
  /** 闲聊 or 工作. Older saves have no kind: they are work tasks. */
  kind?: TaskKind;
  /** The model the task runs on (undefined only if it was never set up; the UI asks to pick one). */
  engine?: TaskEngine;
  /** CLI session id, so later runs and chat turns continue the same conversation. */
  session?: string;
  /** CLI sessions of agents that run on their own command-line model. */
  agentSessions?: Partial<Record<AgentId, string>>;
  /** Skill folders picked for this task; undefined = every enabled skill for its kind. */
  skills?: string[];
  /** Last time the user looked at this task (its page was open). A finished turn after this is「回合结束待查看」. */
  lastSeenAt?: number;
  /** Trust level of engine.cwd when the latest run started (主进程判定，这里只是快照). */
  trust?: TrustLevel;
  /** 「折叠她的话」：该任务里她的话折成一行（仍可展开）；存任务 meta. */
  foldHer?: boolean;
  /** 系统提示版本 hash(level|mode|persona|callName|memoryRev|taskKind)（§3.2）；存任务 meta. */
  promptRev?: string;
}

export interface PlanStep {
  id: string;
  index: number;            // 0-based position in the plan
  title: string;
  detail: string;
  agentId: AgentId;
  status: StepStatus;
  startedAt?: number;
  endedAt?: number;
  /** Active running time in ms: excludes time spent paused or waiting for an approval, like Run.activeMs.
   *  Older saved runs lack it; fall back to endedAt − startedAt. */
  activeMs?: number;
  toolCallIds: string[];
  /** Short explanation shown under the step (why skipped / failed / carried over). */
  note?: string;
  /** True when a retry reused this step's result from the previous attempt. */
  carried?: boolean;
  /** What the agent reported for this step. */
  result?: string;
  /** The model that ran this step, when it was not the task's own (an agent with its own model). */
  engineLabel?: string;
  /** 停用接手：这一步原本指给已停用的 Agent，实际由 ranAs（遐蝶）执行；取档仍按 agentId（§2.1.4）. */
  ranAs?: AgentId;
}

export interface ToolCallError {
  code: string;            // e.g. EXIT_1, HTTP_429, ETIMEDOUT
  message: string;         // one line, human readable
  detail?: string;         // stack / stderr excerpt (monospace)
  recoverable: boolean;    // the agent carried on after it (the call failed, not the step)
}

export interface ToolCall {
  id: string;
  runId: string;
  stepId: string;
  agentId: AgentId;
  tool: ToolId;
  title: string;           // human summary: 读取 src/auth/login.ts
  input: Record<string, unknown>;
  output?: string;
  error?: ToolCallError;
  status: ToolCallStatus;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;     // active (unpaused) duration
  approvalId?: string;
  /** The CLI's own tool name (PowerShell, Edit, apply_patch…) when `tool` is a mapped category. */
  toolName?: string;
}

export interface Approval {
  id: string;
  runId: string;
  taskId: string;
  stepId: string;
  toolCallId: string;
  agentId: AgentId;
  tool: ToolId;
  title: string;            // 写入 3 个文件
  reason: string;           // why the agent wants to do it
  preview: string;          // command or diff text (monospace)
  previewKind: 'command' | 'diff' | 'request';
  risk: Risk;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
}

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  agentId?: AgentId;
  runId?: string;
  text: string;
  at: number;
  kind?: 'plan' | 'note' | 'summary' | 'error' | 'reply';
  /** Still being written (the model is streaming its reply). */
  streaming?: boolean;
  /** Which voice spoke (流萤 or 萨姆), so switching modes later does not rename old messages. */
  persona?: VisualMode;
  /** The model's visible reasoning for this reply (shown folded, like DeepSeek's 思考过程). */
  thinking?: string;
  /** A supplement sent during a live run that has already been handed to the agent. */
  delivered?: boolean;
  /** While a chat reply is being written: what she is doing right now (a tool she is using). */
  activity?: string;
  /** 遐蝶（编排）这条话的神色；只在消息产生那一刻由 settleExpr 定下，旧消息没有（渲染时固定 gentle、不画角标）. */
  expr?: ExprId;
  /** 这条话带的贴纸建议 / 采纳结果. */
  react?: StickerId;
  /** 主动搭话（不是回应用户的）. */
  proactive?: boolean;
  /** 轻反应：用户这句命中「落蝶」，没有调模型. */
  reaction?: 'landing';
  /** 模板话的出处，供「换个说法」. */
  src?: { id: string; slots?: Record<string, string | number>; mode: 'chat' | 'work' | 'any'; idx?: number; scene?: string };
  /** 换说法前的原文，供撤销. */
  prevText?: string;
  /** 这一回合是危机路径（D18）：渲染时关掉贴纸 / 角标 / 胶囊. */
  crisis?: boolean;
}

export interface Artifact {
  id: string;
  runId: string;
  stepId: string;
  name: string;               // file name or title
  kind: 'file' | 'diff' | 'report';
  language?: string;          // ts, md, json, diff…
  content: string;
  createdAt: number;
}

export type EventKind = 'run' | 'step' | 'tool' | 'approval' | 'agent' | 'user' | 'error';
export interface RunEvent {
  id: string;
  at: number;
  runId?: string;
  kind: EventKind;
  level: 'info' | 'success' | 'warn' | 'error';
  text: string;
  refId?: string;
}

export interface TerminalLine {
  id: string;
  at: number;
  runId: string;
  stream: 'cmd' | 'stdout' | 'stderr' | 'sys';
  text: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  contextUsed: number;
  contextLimit: number;
  /** Total tokens sampled after each usage report, for the sparkline. */
  series: number[];
}

export interface RunCursor {
  phase: 'planning' | 'executing' | 'done';
  /** Plan index being worked on. */
  step: number;
}

/** What the run's active agent is doing right now — drives the status panel and step glow. */
export interface LiveActivity {
  agentId: AgentId;
  activity: AgentActivity;
  text: string;
}

export interface Run {
  id: string;
  taskId: string;
  attempt: number;          // 1-based, increments on retry
  status: RunStatus;
  /** Why the run is paused, when it is. */
  pauseReason?: 'user' | 'reload';
  /** 应用重启时它还在运行 / 等待、被置为暂停的时刻（pauseReason 'reload'）。「被中断了」进「待你」的起点用它——任务的 updatedAt 在这时不会动. */
  interruptedAt?: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** Active running time in ms (excludes paused / awaiting time). Wall time = (endedAt ?? now) − startedAt. */
  activeMs: number;
  /** Status to return to on resume ('running' or 'awaiting'). */
  pausedFrom?: 'running' | 'awaiting';
  live?: LiveActivity;
  plan: PlanStep[];
  planReady: boolean;
  toolCalls: ToolCall[];
  approvals: Approval[];
  artifacts: Artifact[];
  errors: RunErrorRecord[];
  terminal: TerminalLine[];
  usage: Usage;
  cursor: RunCursor;
  /** Which run this one retried, if any. */
  retryOf?: string;
  retryMode?: 'resume' | 'restart';
  failure?: { stepId: string; message: string };
  /** Which model ran it, e.g. 「Claude · Claude Code · Claude Sonnet 5.5」. */
  engineLabel?: string;
  /** Agents that ran on their own model in this run (snapshot taken when the run started). */
  agentEngines?: Partial<Record<AgentId, TaskEngine>>;
  /** 模型问你的问题（AskUserQuestion）. */
  questions?: Question[];
  /** 计划审批（K11）：计划出来后先等你批准再执行；'approved' 之后才进入执行。at：pending 时是计划就绪的时刻，approved 时是批准的时刻. */
  planApproval?: { status: 'pending' | 'approved'; at?: number; edited?: boolean };
  /** 本次运行的花费（引擎报告的 total_cost_usd 累加；没有就是 undefined）. */
  costUsd?: number;
  /** Which done steps each CLI session has been told about ('task' = the task's own session, or an
   *  agent id): results produced elsewhere are handed to a session once, before its next turn. */
  shown?: Record<string, string[]>;
  /** 未竟之信「放下」的时刻. */
  laidDownAt?: number;
}

export interface RunErrorRecord {
  id: string;
  at: number;
  runId: string;
  stepId?: string;
  toolCallId?: string;
  title: string;
  code: string;
  message: string;
  detail?: string;
  fatal: boolean;
}

export interface Settings {
  mode: VisualMode;
  motion: MotionPref;
  particles: ParticleDensity;
  /** 主题光标: the 流萤 / 萨姆 cursor set instead of the system's. */
  themeCursor: boolean;
  confirmBeforeCancel: boolean;
  openConsoleOnError: boolean;
  /** Desktop: the close button tucks the window into the system tray instead of quitting. */
  closeToTray: boolean;
  /** Show the character wallpaper under the starfield (流萤 and 萨姆 each have their own). */
  wallpaper: boolean;
  /** 0–100: how clearly the wallpaper shows through the night grade. */
  wallpaperVisibility: number;
  /** 0–100: how see-through the glass panels are (code and logs always stay opaque). */
  panelGlass: number;
  /** Let the welcome page show more of the wallpaper and dim it on dense pages. */
  wallpaperAdaptive: boolean;
  /** Play the 开机动画 when the workbench opens. */
  bootAnimation: boolean;
  /** Title screen of the 开机动画: wait for a click (like the game) or enter by itself. */
  bootEnter: 'click' | 'auto';
  /** 昼开屏用预渲染视频（试验）：背景层提前逐帧渲染成视频、硬件解码播放，文字与光尘仍实时画；不支持 / 出问题自动回到实时. 只影响昼主题. */
  bootVideo: boolean;
  /** 角色口吻（D6）：关 = 纯事实（facts 池），遐蝶牌改名「编排 Agent」、头像回字块、不出表情 / 贴纸. 与话量（level）是两个开关. */
  persona: boolean;
  /** How she addresses you. */
  callName: string;
  /** 'natural' shows a reply as it is written; 'instant' waits and shows each finished reply at once. */
  typing: 'natural' | 'instant';
  /** 每日一次按时辰问候（greet.*，模板、零 token）；新装 true，旧存档保持原值. */
  lifeGreeting: boolean;
  /** Little idle status next to her name (在看星星、待命中…). */
  lifeMood: boolean;
  /** @deprecated 兼容垫片（D17）：由 setLevel/setPersona/setProactive 派生（lifeNudge = proactive !== 'off'），下一版删. 新代码读 proactive. */
  lifeNudge: boolean;
  /** @deprecated 兼容垫片（D17）：distance = persona===false ? 0 : level==='l' ? 2 : 1，下一版删. 新代码读 level / persona. */
  distance: Distance;
  /** 话量：少 / 中 / 多（取代 distance）. */
  level: Level;
  /** 她主动说话：auto = 仅话量「多」；on = 中、多；off = 不说（D7）. */
  proactive: 'auto' | 'on' | 'off';
  /** 「让她自己想话题」：true 才用 NUDGE_PROMPT 调模型. */
  proactiveTopics: boolean;
  /** 记得小事（邀请制）：关时不存不读不注入. */
  memoryOn: boolean;
  /** 「她退半步」：审批 / 报错 / 输入法组合时头像与角标收起. */
  stepBack: boolean;
  /** 剧情框：闲聊里最新一句（chat），或还包含计划引言与总结（all）. 默认关. */
  storyBox: 'off' | 'chat' | 'all';
  /** 官方贴纸总开关. */
  stickers: boolean;
  /** 动效档：A 省电（集显、电池）/ B 标准. */
  motionTier: 'A' | 'B';
  /** 离开多少分钟后回来算「归来」（5–120）. */
  returnAfterMin: number;
  /** 桌宠（docs/PET-PLAN.md §3）：默认全关. 存档里的这一块逐字段校验（persist.pickPet），萤火的旧桌宠设置不沿用. */
  pet: PetSettings;
}

/* ───────────── 桌宠（docs/PET-PLAN.md §3）───────────── */

export type PetProactivity = 'off' | 'low' | 'normal' | 'high';
export type PetVoiceProvider = 'elevenlabs' | 'minimax' | 'edge';
/** 每个有密钥的语音服务各选一个语音模型（API 里的模型 id）；'' = 推荐的那个. 分开存，切回来时不丢. */
export type PetVoiceModels = { elevenlabs: string; minimax: string };
/** 每个语音服务各存一个音色 ID（ElevenLabs / MiniMax 的音色 ID；edge = 微软朗读的声音名，空 = 默认的晓晓）. 分开存，换服务再换回来不丢. */
export type PetVoiceIds = { elevenlabs: string; minimax: string; edge: string };

export interface PetSettings {
  /** 显示桌宠窗口（默认关）. */
  enabled: boolean;
  /** 大小 0.6–1.6. */
  scale: number;
  /** 允许她在本机看前台的游戏窗口（默认关；画面只在本机分析，问她或她主动搭话时才发一帧给看图模型）. */
  watch: boolean;
  /** 她自己开口的频率；'normal' = 偶尔. */
  proactivity: PetProactivity;
  /** 两次主动搭话之间至少隔多少秒（下限 60）. */
  cooldownSec: number;
  /** 每小时最多发几帧画面给模型. */
  imagesPerHour: number;
  /** 看图 / 实时用的 API 模型；空 = 自动挑已接入的、能看图的 API 模型. */
  vision?: AgentEngine;
  /** 联网答疑用的命令行模型；空 = 已登录的 Claude Code. */
  web?: AgentEngine;
  /** 朗读（默认关）：ElevenLabs / MiniMax 用你自己设计的音色，微软在线朗读不是她的声音，只作可选的备用. */
  voice: { enabled: boolean; provider: PetVoiceProvider; voiceIds: PetVoiceIds; volume: number; fallback: boolean; models: PetVoiceModels };
  /** 实时陪玩：listen 'auto' 一直听 / 'key' 按呼出键说一句；sensitivity 0–100；fastVoice 用 Flash 模型更快开口；autoOffMin 这么久没人说话就自动结束. */
  realtime: { listen: 'auto' | 'key'; sensitivity: number; fastVoice: boolean; autoOffMin: number };
  /** 呼出聊天框 / 暂停看屏的全局热键（Electron 写法）. */
  hotkeyAsk: string;
  hotkeyPause: string;
  /** 永远不看的程序（小写 exe 名）. */
  neverWatch: string[];
  /** 用户标过「当作游戏、可以看」的程序. */
  gameAllow: string[];
  /** 用户标过「只聊天、不看画面」的程序（叠加在内置反作弊名单上）. */
  gameDeny: string[];
  /** 眼睛和头跟着鼠标看. */
  follow: boolean;
  /** 动画帧率上限. */
  fpsCap: 30 | 60;
}

/* ───────────── 栖枝 V0α 新增 ───────────── */

/** 输入框里常显的权限模式：逐项 / 接受编辑 / 计划 / 自动 / 放手. */
export type PermissionMode = 'ask' | 'acceptEdits' | 'plan' | 'auto' | 'bypass';

/** 工作区信任阶梯（主进程按 realpath 记）：T0 受限（新目录默认，只读）/ T1 我的目录 / T2 完全信任（V0β）. */
export type TrustLevel = 'T0' | 'T1' | 'T2';

/** 她说话离你多远：0 纯事实 / 1 措辞正式（默认）/ 2 称呼名字、记住偏好. */
export type Distance = 0 | 1 | 2;

/** 话量：少 / 中 / 多（§2.2）. */
export type Level = 's' | 'm' | 'l';
/** 官方游戏内表情（D9 的中文名见 expr.ts）. */
export type ExprId = 'gentle' | 'relaxed' | 'shy' | 'surprised' | 'confused' | 'grumpy';
/** 官方贴纸白名单（D10）. */
export type StickerId = 'butterfly' | 'blushing' | 'create' | 'dontthink' | 'like' | 'bewildered';

/** 记得小事（§2.2、§3.9）：≤20 条 × ≤80 字；taskId 缺省 = 所有对话可见. */
export interface MemoryItem { id: string; text: string; at: number; taskId?: string }

/** 模型问你的问题（Claude 的 AskUserQuestion）：进「待你」，回答后交还模型. */
export interface Question {
  id: string;
  runId?: string;
  taskId: string;
  header?: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  status: 'pending' | 'answered' | 'cancelled';
  answer?: string[];
  /** Free text typed instead of picking an option. */
  other?: string;
  createdAt: number;
  answeredAt?: number;
}

/** 「待你」一行。由 src/state/queue.ts 从 AppState 确定性地推导，不存盘. */
export type QueueKind = 'approval' | 'question' | 'plan' | 'failed' | 'turn-done';
export interface QueueItem {
  /** Stable: `${kind}:${refId}`. */
  key: string;
  kind: QueueKind;
  taskId: string;
  runId?: string;
  /** approval id / question id / run id. */
  refId: string;
  title: string;
  /** Context line (task title…). */
  sub: string;
  /** When it started waiting (ms epoch). */
  since: number;
  /** Lower sorts first: approval 0, question 1, plan 2, failed 3, turn-done 4. */
  rank: number;
}

/** 任务级用量（K14 task_usage）：只有数字，没有内容。每个结束的回合一行. */
export interface UsageRecord {
  at: number;
  taskId: string;
  runId?: string;
  provider: ProviderId;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Engine-reported (Claude Code total_cost_usd) unless costEstimated; undefined = unknown. */
  costUsd?: number;
  costEstimated?: boolean;
  durationMs?: number;
}

/** 额度条 L0 的汇总（本次 / 今日 / 本周），由存储层算好给页面. */
export interface UsageSummary {
  today: { costUsd?: number; tokens: number; turns: number };
  week: { costUsd?: number; tokens: number; turns: number };
  /** Some costs in the window were unknown or estimated → show「估算」. */
  estimated: boolean;
}

/** Serializable UI commands, so engine-made toasts can carry an action without importing the UI. */
export type UiCommand =
  | { type: 'open-task'; taskId: string; runId?: string; tab?: WorkspaceTab }
  /** With taskId / runId the command first opens that run, so the console shows the run the toast is about. */
  | { type: 'open-console'; tab: ConsoleTab; focusId?: string; taskId?: string; runId?: string }
  | { type: 'resume-run'; runId: string }
  | { type: 'retry-run'; runId: string; mode: 'resume' | 'restart' }
  /** 带上 taskId / runId：在没有右栏的页面（首页、待你）里要先打开那个任务，不然「去确认」无处可去. */
  | { type: 'show-approvals'; taskId?: string; runId?: string }
  | { type: 'navigate'; view: ViewId }
  /** 「今天别再提醒」（休息关照 / 很晚的一次性 toast 上的按钮，施工图 §3.6b）. */
  | { type: 'mute-rest' };

export interface Toast {
  id: string;
  tone: Tone;
  title: string;
  body?: string;
  action?: { label: string; command: UiCommand };
  createdAt: number;
  /** ms; 0 = stays until dismissed */
  ttl: number;
  /** Toasts about the same thing share a key: a newer one replaces the older, and resolving the
   *  thing (approval decided, run retried) removes it. */
  key?: string;
}

export interface ConsoleState {
  open: boolean;
  tab: ConsoleTab;
  height: number;
  /** Tool call to scroll to / expand when the console opens. */
  focusId?: string;
}

export type Dialog =
  | { kind: 'cancel-run'; runId: string }
  | { kind: 'clear-history' }
  | { kind: 'delete-task'; taskId: string };

export interface Celebration { runId: string; at: number }

export interface AppState {
  view: ViewId;
  selectedTaskId?: string;
  /** Run shown in the workspace; defaults to the task's latest run. */
  selectedRunId?: string;
  workspaceTab: WorkspaceTab;
  console: ConsoleState;
  statusDrawerOpen: boolean;
  navCollapsed: boolean;
  settings: Settings;
  tasks: Record<string, Task>;
  /** Newest first. */
  taskOrder: string[];
  runs: Record<string, Run>;
  agents: Agent[];
  tools: ToolDef[];
  models: ModelState;
  /** Installed skills (read from the desktop side; not saved in the page). */
  skills?: { root: string; list: SkillInfo[]; loaded: boolean };
  events: RunEvent[];        // global timeline, newest last, capped
  toasts: Toast[];
  dialog?: Dialog;
  celebration?: Celebration;
  /** Live-region text for screen readers; replaced on every announcement. */
  announcement: { text: string; at: number };
  /** Set by 预览 in Settings to replay the 开机动画. Not persisted. */
  bootAt?: number;
  /** 赏图: the interface fades out so the wallpaper shows in full. Not persisted. */
  peek?: boolean;
  /** 额度条 L0（来自存储层，不存进 AppState 的持久化部分）. */
  usage?: UsageSummary;
  /** When the user was last seen (presence), for「归来」. Not persisted here (presence.ts keeps it). */
  lastSeen?: number;
  /** One-shot request for a region to scroll into view and take focus (e.g. pending approvals). */
  focusRequest?: { target: 'approvals' | 'composer' | 'console' | 'plan'; at: number };
  /** 记得小事（memoryOn 才读 / 注入）；持久化 prefs. */
  memory: MemoryItem[];
  /** 「安静一小时」：ms 时间戳，0 = 无；所有说话入口读同一个 voiceGate. 持久化 prefs. */
  quietUntil: number;
}
