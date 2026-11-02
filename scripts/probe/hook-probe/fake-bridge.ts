/* 假的桌面桥（check-engine 用）：在页面代码（desktop.ts 在模块加载时读 window.alightDesktop）被加载之前，
   先把 window 与 alightDesktop 放好。使用方必须把它放在所有 import 的最前面。
   它不连任何东西：start 记下 spec，按测试给的 handler 回放 StreamEvent；answer / stop / call 只记录。 */
export type Ev = Record<string, unknown>;

type Listener = (ev: Ev & { id: string }) => void;
const listeners = new Set<Listener>();

export interface FakeBridge {
  version: number;
  specs: any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  answers: Array<{ id: string; requestId: string; decision: string; input: unknown }>;
  stops: Array<{ id: string; how: string }>;
  calls: Array<{ channel: string; args: any[] }>; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** store:user-messages 的回复：按任务 id 给「库里」的用户消息（页面窗口之外更早的补充说明）. */
  userMessages: Record<string, Array<{ id: string; at: number; text: string }>>;
  handler: null | ((id: string, spec: any, emit: (e: Ev) => void) => void); // eslint-disable-line @typescript-eslint/no-explicit-any
  onAnswer: null | ((a: { id: string; requestId: string; decision: string; input: unknown }) => void);
  emit(id: string, ev: Ev): void;
  onEvent(fn: Listener): () => void;
  start(spec: unknown): Promise<string>;
  answer(id: string, requestId: string, decision: string, input: unknown): Promise<boolean>;
  stop(id: string, how: string): Promise<boolean>;
  input(): Promise<boolean>;
  info(): Promise<unknown>;
  call(channel: string, ...args: unknown[]): Promise<unknown>;
}

export const bridge: FakeBridge = {
  version: 1,
  specs: [],
  answers: [],
  stops: [],
  calls: [],
  userMessages: {},
  handler: null,
  onAnswer: null,
  emit(id, ev) { for (const l of listeners) l({ id, ...ev }); },
  onEvent(fn) { listeners.add(fn); return () => { listeners.delete(fn); }; },
  async start(spec) {
    const id = `f${bridge.specs.length + 1}`;
    bridge.specs.push(spec);
    setTimeout(() => bridge.handler?.(id, spec, (e) => bridge.emit(id, e)), 5);
    return id;
  },
  async answer(id, requestId, decision, input) { const a = { id, requestId, decision, input }; bridge.answers.push(a); bridge.onAnswer?.(a); return true; },
  async stop(id, how) { bridge.stops.push({ id, how }); return true; },
  async input() { return true; },
  async info() { return { encryption: true, keys: {}, workspaceRoot: '', platform: 'win32' }; },
  async call(channel, ...args) {
    bridge.calls.push({ channel, args });
    if (channel === 'store:user-messages') {
      const req = (args[0] ?? {}) as { taskId?: string };
      return { ok: true, messages: bridge.userMessages[req.taskId ?? ''] ?? [] };
    }
    return channel === 'usage:add' ? { ok: true, recorded: true } : { ok: false, error: 'n/a' };
  },
};

const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.alightDesktop = bridge;
