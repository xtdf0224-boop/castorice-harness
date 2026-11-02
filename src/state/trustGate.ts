/* 信任闸门（V0α · 模块 B5「安全」，G01 最小集）。
   Composer（B4）在开始一个工作任务前调用 requestTrust(cwd)：
   - 已是 T1/T2 → 直接返回，不打扰；
   - T0（新目录默认）→ 弹出 TrustDialogHost 里的确认框：「这是我自己的目录，信任并继续」（→T1）/「只读继续」（→T0）/ 取消（→null）；
   - 没有桌面桥、桥出错、目录不存在 → T0（宁可只读，不放行）。
   live.ts（B3）把 task.trust === 'T0' 当作只读运行（access 'read'），并把 trust 填进 StartSpec；主进程另会用 trust.levelOf(cwd) 复核。

   本会话里选过「只读继续」的目录不再重复追问（否则每发一条消息弹一次）；想升级信任走 requestTrust(dir, { force: true })
   （设置 › 信任的目录 › 添加，或工作区里的「信任此目录」）。取消不记忆。同一目录的并发请求共用一个框. */
import { getTrustBridge, type TrustInfo } from '../lib/trustBridge';
import type { TrustLevel } from '../lib/types';

export type TrustChoice = 'trust' | 'readonly' | 'cancel';

/** 对话框要显示的状态（不可变快照）. */
export interface TrustPromptState {
  id: number;
  dir: string;
  info: TrustInfo;
  /** 正在向主进程提交授予. */
  busy: boolean;
  /** 上一次提交失败的原因（框保持打开）. */
  error?: string;
  /** 后面还排着几个目录. */
  waiting: number;
}

interface Pending {
  id: number;
  dir: string;
  info: TrustInfo;
  busy: boolean;
  error?: string;
  settle: (level: TrustLevel | null) => void;
}

let seq = 0;
const queue: Pending[] = [];
const byKey = new Map<string, Promise<TrustLevel | null>>();
/** 本会话里选了「只读继续」的信任键 */
const sessionReadOnly = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: TrustPromptState | null = null;

function rebuild() {
  const head = queue[0];
  snapshot = head ? { id: head.id, dir: head.dir, info: head.info, busy: head.busy, error: head.error, waiting: queue.length - 1 } : null;
  for (const l of listeners) l();
}

export function subscribeTrustPrompt(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
export function getTrustPromptSnapshot(): TrustPromptState | null { return snapshot; }

function finish(p: Pending, level: TrustLevel | null) {
  const i = queue.indexOf(p);
  if (i >= 0) queue.splice(i, 1);
  byKey.delete(p.info.key);
  p.settle(level);
  rebuild();
}

/** 查级别，不弹框。出任何问题都按 T0. */
export async function trustLevel(dir: string): Promise<TrustLevel> {
  const bridge = getTrustBridge();
  if (!bridge) return 'T0';
  try { return (await bridge.inspect(dir)).level; } catch { return 'T0'; }
}

/**
 * 开始工作前确认目录的信任。
 * @returns 'T1'/'T2'（可以写）、'T0'（只读继续）、null（用户取消，不要开始）
 */
export async function requestTrust(dir: string, opts: { force?: boolean } = {}): Promise<TrustLevel | null> {
  const bridge = getTrustBridge();
  if (!bridge) return 'T0';
  let info: TrustInfo;
  try { info = await bridge.inspect(dir); } catch { return 'T0'; }
  if (!info.exists) return 'T0';
  if (info.level === 'T1' || info.level === 'T2') return info.level;
  if (!opts.force && sessionReadOnly.has(info.key)) return 'T0';
  const shared = byKey.get(info.key);
  if (shared) return shared;
  const promise = new Promise<TrustLevel | null>((resolve) => {
    queue.push({ id: ++seq, dir, info, busy: false, settle: resolve });
    rebuild();
  });
  byKey.set(info.key, promise);
  return promise;
}

/**
 * 用户在框里做了选择。trust 可能失败（主进程拒绝、写盘失败）：这时框保持打开并带上原因.
 * @param acknowledged 疑似第三方克隆时，用户额外勾选的确认
 */
export async function decideTrust(id: number, choice: TrustChoice, opts: { acknowledged?: boolean } = {}): Promise<{ ok: boolean; error?: string }> {
  const p = queue.find((q) => q.id === id);
  if (!p) return { ok: false, error: '这个确认已经结束了。' };
  if (p.busy) return { ok: false, error: '正在处理上一个操作。' };
  if (choice === 'cancel') { finish(p, null); return { ok: true }; }
  if (choice === 'readonly') { sessionReadOnly.add(p.info.key); finish(p, 'T0'); return { ok: true }; }
  // choice === 'trust'
  if (p.info.rootLike) { p.error = '这个目录范围太大（磁盘根或用户主目录），只能只读。请选具体的项目目录。'; rebuild(); return { ok: false, error: p.error }; }
  if (p.info.suspect && !opts.acknowledged) { p.error = '这个目录看起来是别处克隆来的，请先勾选确认。'; rebuild(); return { ok: false, error: p.error }; }
  const bridge = getTrustBridge();
  if (!bridge) { p.error = '没有连到桌面端，无法保存信任。'; rebuild(); return { ok: false, error: p.error }; }
  p.busy = true; p.error = undefined; rebuild();
  try {
    const r = await bridge.grant(p.info.dir, { acknowledged: opts.acknowledged === true });
    if (!r.ok) { p.busy = false; p.error = r.error; rebuild(); return { ok: false, error: r.error }; }
    sessionReadOnly.delete(p.info.key);
    finish(p, r.level);
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    p.busy = false; p.error = `保存信任失败：${msg}`; rebuild();
    return { ok: false, error: p.error };
  }
}

/** 放弃所有排队中的确认（按取消处理）。测试用，也可在窗口卸载时调用. */
export function cancelAllTrustPrompts(): void {
  for (const p of [...queue]) finish(p, null);
}

/** 清掉“本会话只读继续”的记忆（授予/撤销之后调用）. */
export function forgetSessionReadOnly(key?: string): void {
  if (key) sessionReadOnly.delete(key); else sessionReadOnly.clear();
}
