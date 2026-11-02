/* 信任通道的类型化封装（V0α · 模块 B5「安全」）。页面只通过 desktop.call('trust:…') 和主进程说话：
   级别、仓库范围、“第三方克隆”嫌疑全由主进程（electron/trust.cjs）判断，这里只负责搬运与容错。
   没有桌面桥（浏览器里的开发预览）时 getTrustBridge() 返回 null——页面不能核实信任，就一律当 T0，且没有真实运行可言. */
import { desktop } from './desktop';
import type { TrustLevel } from './types';

/** 为什么怀疑它是别处克隆来的（代码由主进程给，措辞由界面决定）. */
export interface TrustReason {
  code: 'vendor-path' | 'foreign-remote' | 'exec-config';
  detail: string;
  items?: string[];
}

export interface TrustInfo {
  /** 解析后的真实路径（目录不存在时是原样输入）. */
  dir: string;
  /** 信任键：realpath(git 顶层)，无仓库时是目录本身（Windows 下小写）. */
  key: string;
  level: TrustLevel;
  exists: boolean;
  isRepo: boolean;
  /** 'repo'：信任的是整个仓库；'dir'：只信任这个目录本身. */
  scope: 'repo' | 'dir';
  /** 仓库顶层（isRepo 时有）. */
  top?: string;
  kind?: 'repo' | 'worktree' | 'gitfile';
  suspect: boolean;
  reasons: TrustReason[];
  /** 磁盘根、用户主目录等，不允许整体信任. */
  rootLike: boolean;
  error?: string;
  storeError?: string;
}

export interface TrustEntry {
  key: string;
  dir: string;
  level: 'T1' | 'T2';
  grantedAt: number;
  isRepo: boolean;
  exists: boolean;
  remote?: string;
}

export type GrantResult = { ok: true; key: string; level: TrustLevel; dir: string } | { ok: false; error: string; code?: string };

export interface TrustBridge {
  inspect(dir: string): Promise<TrustInfo>;
  /** V0α 只授予 T1。疑似第三方克隆时必须 acknowledged:true. */
  grant(dir: string, opts?: { acknowledged?: boolean }): Promise<GrantResult>;
  list(): Promise<{ ok: true; entries: TrustEntry[] } | { ok: false; error: string }>;
  revoke(keyOrDir: string): Promise<{ ok: boolean; removed?: boolean; error?: string }>;
}

function desktopBridge(): TrustBridge | null {
  const call = desktop?.call;
  if (!call) return null;
  const invoke = <T,>(channel: string, ...args: unknown[]) => call.call(desktop, channel, ...args) as Promise<T>;
  return {
    inspect: (dir) => invoke<TrustInfo>('trust:level', dir),
    grant: (dir, opts) => invoke<GrantResult>('trust:grant', dir, 'T1', { acknowledged: opts?.acknowledged === true }),
    list: () => invoke('trust:list'),
    revoke: (keyOrDir) => invoke('trust:revoke', keyOrDir),
  };
}

/** 测试可以换成假桥（传 undefined 恢复真桥）. */
let override: TrustBridge | null | undefined;
export function setTrustBridgeForTest(bridge: TrustBridge | null | undefined): void { override = bridge; }

export function getTrustBridge(): TrustBridge | null {
  return override !== undefined ? override : desktopBridge();
}
