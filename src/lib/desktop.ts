/* The desktop bridge (electron/preload.cjs). In the browser dev build it is absent and every model
   feature says so instead of pretending. Keys go in through saveKey and never come back. */
import type { CliStatus, DriverId, ProviderId } from './types';
import type { PetBridge } from '../pet/contracts';
import type { AcpBridge, ServicesBridge } from './services';

export type StreamEvent =
  | { id: string; type: 'session'; sessionId: string }
  | { id: string; type: 'model'; model: string }
  | { id: string; type: 'text'; text: string }
  | { id: string; type: 'thinking'; text: string }
  | { id: string; type: 'text-break' }
  | { id: string; type: 'tool'; callId: string; name: string; input: Record<string, unknown>; title: string }
  | { id: string; type: 'tool-end'; callId: string; ok: boolean; output: string; exitCode?: number }
  | { id: string; type: 'plan'; entries: Array<{ text: string; status: 'pending' | 'in_progress' | 'completed' }> }
  | { id: string; type: 'permission'; requestId: string; callId?: string; name: string; input: Record<string, unknown>; title: string; reason?: string; blockedPath?: string; paths?: string[] }
  | { id: string; type: 'usage'; input: number; output: number; cached: number; total?: boolean; context?: number }
  | { id: string; type: 'notice'; text: string; level?: 'info' | 'warn' | 'error' }
  | { id: string; type: 'stdout'; text: string }
  | { id: string; type: 'done'; text: string; stopReason?: string; sessionId?: string; costUsd?: number }
  | { id: string; type: 'error'; message: string; code?: string; sessionId?: string; costUsd?: number }
  /* 栖枝 V0α（Claude Agent SDK 驱动） */
  /** AskUserQuestion: answer with desktop.answer(id, requestId, 'allow', { answers: { [question]: label } }). */
  | { id: string; type: 'question'; requestId: string; callId?: string; questions: Array<{ question: string; header?: string; options: Array<{ label: string; description?: string }>; multiSelect?: boolean }> }
  /** Plan mode finished planning (ExitPlanMode): 'allow' = 批准执行, 'deny' = 继续改计划. */
  | { id: string; type: 'plan-ready'; requestId: string; callId?: string; plan: string }
  /** SDK rate_limit_event, passed through as-is (only sent when a limit is near/hit). */
  | { id: string; type: 'rate-limit'; info: Record<string, unknown> }
  /** Context window use from getContextUsage(). */
  | { id: string; type: 'context'; used: number; limit: number };

/** 一条消息的一块内容：文字，或一张图（base64；桌宠看屏用，只有 API 方式带；主进程校验 mime 白名单与大小：单张 ≤ 4 MB，一条消息最多 2 张）. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; mime: 'image/jpeg' | 'image/png'; data: string };

export interface StartSpec {
  /** 'api' = the API way (the service's protocol decides the adapter); 'api-openai' / 'api-anthropic' are the old spellings, still accepted. */
  driver: 'api' | 'api-openai' | 'api-anthropic' | DriverId;
  /** The service id (preset or custom). The desktop side looks it up: where the request goes is decided there, never here. */
  provider: ProviderId;
  /** Which endpoint of the service (国内 / 国际 / 套餐…); absent = the service's first usable one. */
  endpoint?: string;
  /** Values of the {placeholders} in the endpoint's address (Azure resource name…); the desktop side checks them. */
  params?: Record<string, string>;
  /* API */
  model?: string;
  system?: string;
  /** content 是字符串，或（桌宠看屏）一串文字 / 图片块. */
  messages?: Array<{ role: 'user' | 'assistant'; content: string | ContentPart[] }>;
  /** The desktop side clamps this to the model's / service's output limit. */
  maxTokens?: number;
  temperature?: number;
  /** API way: the 推理强度 LEVEL (the desktop side turns it into the request fields). CLI way: the effort flag value (Claude Code --effort, Codex model_reasoning_effort). */
  effort?: string;
  /** @deprecated Ignored by the desktop side (the address comes from the service registry). Old page builds sent it to say which region. */
  baseUrl?: string;
  /** @deprecated Ignored by the desktop side (reasoning fields are built from `effort`). */
  extraBody?: Record<string, unknown>;
  /* CLI */
  /** @deprecated Name the command-line agent in `driver` ('kimi' | 'qwen' | 'mcode' | 'acp:<id>'). The desktop side still reads this (and the old `driver: 'acp'` + `acp: 'kimi'`) from old page builds only. */
  agent?: string;
  path?: string;
  cwd?: string;
  prompt?: string;
  sessionId?: string;
  access?: 'chat' | 'work';
  /** A 只读 work task: no browser actions, DeepSeek Harness in its read-only mode. */
  readOnly?: boolean;
  allow?: string[];
  deny?: string[];
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  webSearch?: boolean;
  /** @deprecated Ignored by the desktop side: environments are built there (compat-env.cjs / the agent's definition). */
  env?: Record<string, string>;
  /** @deprecated Ignored by the desktop side. */
  keyEnv?: string;
  /** The run uses skills: Claude Code is allowed to read the skills folder. */
  skills?: boolean;
  /** Attach the alight-browser MCP server (浏览器控制). */
  browser?: boolean;
  /** 输入框里的权限模式（Claude SDK: default / acceptEdits / plan / …；其他引擎尽量映射，做不到的如实降级）. */
  permissionMode?: import('./types').PermissionMode;
  /** Trust level of cwd decided by the desktop side (the main process re-checks it); T0 forces read-only. */
  trust?: import('./types').TrustLevel;
  /** 这一轮是只出计划（只读调研）、执行一步，还是闲聊. */
  phase?: 'plan' | 'step' | 'chat';
  /** 桌宠的轮次（只有大脑 src/pet/brain.ts，经 live.petApiSpec / petCliSpec 会带）. API 方式走快速通道：首字节 12 s、空闲 20 s 超时，不重试，maxTokens 由页面给（≤ 600）；
   *  命令行方式（联网答疑、没有 API 模型时的闲聊）：cwd 必须正好是 workspaceFolder('pet') 的返回值，权限请求由页面一律拒绝. */
  pet?: true;
}

/** What the tray menu or a notification asks the page to do. */
export type DesktopCommand =
  | { type: 'new' } | { type: 'close-to-tray'; value: boolean } | { type: 'approvals' } | { type: 'open-task'; taskId: string }
  /** 托盘 / 桌宠右键菜单：显示或隐藏桌宠、打开桌宠设置、开始或结束实时陪玩、把前台程序当作游戏（allow）或只聊天（!allow）. */
  | { type: 'pet-toggle' } | { type: 'pet-settings' } | { type: 'pet-realtime'; on: boolean } | { type: 'pet-watch'; exe: string; allow: boolean };

/** 图形处理器：auto 交给系统、low 固定集显、high 用独显（electron/main.cjs 在启动时按它挑显卡）. */
export type GpuPref = 'auto' | 'low' | 'high';
export interface GpuStatus {
  /** 存下来的偏好（下次启动用） */
  pref: GpuPref;
  /** 这次启动实际用的偏好 */
  atLaunch: GpuPref;
  /** 正在用的显卡名（取不到时为空） */
  active: string;
  kind: 'integrated' | 'discrete' | 'unknown';
  /** 有没有两块可选的显卡（只有一块时这一行只作说明） */
  choice: boolean;
}

export interface DesktopBridge {
  version: number;
  /** `keys`: '••••abcd' hints per key SLOT (`<service>` or `<service>:<endpoint>`). */
  info(): Promise<{ encryption: boolean; keys: Record<string, string>; workspaceRoot: string; platform: string }>;
  /** `endpoint`: which region the key is for (the desktop side computes the slot: regions that need their own key get their own). */
  saveKey(provider: ProviderId, key: string, endpoint?: string): Promise<{ ok: true; hint: string } | { ok: false; error: string }>;
  clearKey(provider: ProviderId, endpoint?: string): Promise<{ ok: true } | { ok: false; error: string }>;
  detect(req: { driver: DriverId; path?: string }): Promise<Omit<CliStatus, 'at'>>;
  models(req: { driver: DriverId; path?: string; fresh?: boolean }): Promise<import('./effort').LiveModel[] | null>;
  openLogin(req: { driver: DriverId; path?: string }): Promise<{ ok: true; command: string } | { ok: false; error: string }>;
  /** `steps`: the API way tries the model list first (no tokens) and then one chat turn; the card can show both. */
  test(spec: StartSpec): Promise<{ ok: true; text: string; ms: number; model?: string; steps?: import('./services').TestStep[] } | { ok: false; error: string; code?: string; ms: number; steps?: import('./services').TestStep[] }>;
  pickFolder(start?: string): Promise<string | null>;
  workspaceFolder(name: string): Promise<string>;
  openFolder(dir: string): Promise<string>;
  start(spec: StartSpec): Promise<string>;
  input(id: string, text: string): Promise<boolean>;
  answer(id: string, requestId: string, decision: 'allow' | 'deny', input?: Record<string, unknown>): Promise<boolean>;
  stop(id: string, how: 'interrupt' | 'kill'): Promise<boolean>;
  onEvent(fn: (ev: StreamEvent) => void): () => void;
  /** Generic invoke for the V0α modules (channels must start with store: / trust: / usage: / git: / probe:).
   *  Each module wraps it with typed helpers in its own file (src/lib/storeBridge.ts, src/lib/trustBridge.ts…). */
  call?<T = unknown>(channel: string, ...args: unknown[]): Promise<T>;
  /** The window shell: tray preference, system notifications, commands from the tray menu. */
  app?: {
    setPrefs(prefs: { closeToTray: boolean }): void;
    notify(n: { title: string; body?: string; command?: DesktopCommand }): void;
    /** 任务栏角标（「待你」数量）：png 是页面画的小图 data URL；count 0 清除. */
    setBadge?(b: { count: number; png?: string; label?: string }): void;
    /** 原生标题栏与窗口底色跟着夜/昼走. */
    setTheme?(mode: import('./types').ThemeId): void;
    /** 主窗口被藏进托盘/最小化（false）或重新显示（true）；窗口关着 backgroundThrottling，页面自己看不出来. */
    onVisibility?(fn: (visible: boolean) => void): () => void;
    /** 主窗口还显示着，可是她这块屏的前台是全屏程序或游戏（桌宠没开时：切走满 5 秒）：true 时页面停下动效，计时器与数据照常. */
    onCovered?(fn: (covered: boolean) => void): () => void;
    /** 页面的第一帧准备好了（开屏第 0 帧已画好 / 主界面第一次提交）：主进程此时才把窗口显示出来（只发不收；见 lib/firstFrame.ts）. */
    frameReady?(): void;
    /** 图形处理器偏好（重启后生效）与此刻正在用的显卡. */
    /** light = true：只要偏好与这次启动用的偏好（kind 为 'unknown'），不收集 GPU 信息（开屏里用）. */
    gpu?(light?: boolean): Promise<GpuStatus | null>;
    setGpu?(pref: GpuPref): Promise<{ ok: boolean; error?: string }>;
    relaunch?(): Promise<boolean>;
    onCommand(fn: (cmd: DesktopCommand) => void): () => void;
  };
  /** The service registry: custom services, address overrides, pinned models, live model lists, local-server probe (the svc:* channels). */
  services?: ServicesBridge;
  /** Command-line agents (the acp:* channels; handlers land with the ACP part). */
  acp?: AcpBridge;
  browser?: { open(): Promise<boolean>; clear(): Promise<boolean> };
  /** 桌宠（electron/pet/*.cjs 经 preload 暴露；浏览器开发版没有）. */
  pet?: PetBridge;
  skills?: {
    list(): Promise<{ root: string; skills: import('./types').SkillInfo[]; error?: string }>;
    import(): Promise<{ ok: true; name: string } | { ok: false; error?: string; canceled?: boolean; conflict?: string; token?: string; name?: undefined }>;
    confirmImport(token: string): Promise<{ ok: true; name: string } | { ok: false; error?: string; canceled?: boolean; conflict?: string; token?: string }>;
    create(name: string): Promise<{ ok: true; name: string; dir: string } | { ok: false; error: string }>;
    installExamples(): Promise<{ ok: true; added: string[] } | { ok: false; error: string }>;
    setEnabled(folder: string, enabled: boolean): Promise<boolean>;
    remove(folder: string): Promise<{ ok: true } | { ok: false; error: string }>;
    open(folder?: string): Promise<string>;
  };
}

declare global {
  interface Window { alightDesktop?: DesktopBridge }
}

export const desktop: DesktopBridge | undefined = typeof window !== 'undefined' ? window.alightDesktop : undefined;

/* One listener for all streams; each stream registers its own handler by id. Events that arrive
   before the handler is registered (start() resolves after the first events) are buffered. */
const handlers = new Map<string, (ev: StreamEvent) => void>();
const early = new Map<string, StreamEvent[]>();
desktop?.onEvent((ev) => {
  const h = handlers.get(ev.id);
  if (h) { h(ev); return; }
  const list = early.get(ev.id) ?? [];
  list.push(ev);
  early.set(ev.id, list);
  if (early.size > 50) early.delete(early.keys().next().value as string);
});

/** Start a stream and route its events to `on`. Resolves with the stream id. */
export async function openStream(spec: StartSpec, on: (ev: StreamEvent) => void, onId?: (id: string) => void): Promise<string> {
  if (!desktop) throw new Error('需要桌面版才能调用真实模型。');
  const id = await desktop.start(spec);
  onId?.(id);
  const finalOn = (ev: StreamEvent) => {
    if (ev.type === 'done' || ev.type === 'error') handlers.delete(id);
    on(ev);
  };
  handlers.set(id, finalOn);
  const buffered = early.get(id);
  if (buffered) { early.delete(id); buffered.forEach(finalOn); }
  return id;
}
