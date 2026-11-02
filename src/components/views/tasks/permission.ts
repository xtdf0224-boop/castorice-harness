/* 输入框里的权限模式（K32）：逐项 / 接受编辑 / 计划 / 自动 / 放手。
   写进 TaskEngine.permissionMode，由引擎（B3）映射到 SDK 的 permissionMode。纯数据，界面与测试共用。 */
import { DRIVERS, permissionSupport } from '../../../lib/providers';
import type { DriverId, PermissionMode } from '../../../lib/types';

export interface ModeInfo { value: PermissionMode; label: string; sub: string; /** 值得多提醒一句的档. */ warn?: string }

export const PERMISSION_MODES: ModeInfo[] = [
  { value: 'ask', label: '逐项确认', sub: '写文件、执行命令之前，每一步都先问你' },
  { value: 'acceptEdits', label: '接受编辑', sub: '文件改动直接放行，执行命令等仍然逐项问' },
  { value: 'plan', label: '先出计划', sub: '先给计划，你批准之后才动手' },
  { value: 'auto', label: '自动', sub: '常规操作按规则放行，越界的才问你' },
  { value: 'bypass', label: '放手', sub: '不再询问，直接做', warn: '放手：不再逐项询问。只建议在可丢弃的练习目录里用。' },
];

export const DEFAULT_MODE: PermissionMode = 'ask';
export const modeInfo = (m: PermissionMode | undefined): ModeInfo => PERMISSION_MODES.find((x) => x.value === (m ?? DEFAULT_MODE)) ?? PERMISSION_MODES[0];

/** 这个引擎能不能按所选模式工作：full = 五档都如实对应；partial = 只有部分档如实对应（别的档照实降级）；none = 不能逐项问，按沙箱策略执行. */
export function modeSupport(driver: DriverId | undefined): 'full' | 'partial' | 'none' {
  if (!driver) return 'none';
  if (driver === 'claude-code') return 'full';
  if (driver === 'claude-compat') return 'partial';   // 兼容端点走旧驱动：只有逐项和接受编辑
  return DRIVERS[driver]?.approvals === 'per-call' ? 'partial' : 'none';
}

/** 模式芯片下的一句说明。映射以 lib/providers.ts 的 permissionSupport 为准（与 electron/ai/perm.cjs 里真正生效的一致），
 *  做不到的档如实写，不假装生效. claudeLegacy：Claude 走旧的 stream-json 驱动（SDK 开关关着）. */
export function modeNote(mode: PermissionMode | undefined, driver: DriverId | undefined, opts: { claudeLegacy?: boolean } = {}): string | undefined {
  const info = modeInfo(mode);
  if (!driver) return '没有选引擎，权限模式不适用。';
  const s = permissionSupport(driver, info.value, opts);
  return s.level === 'full' ? s.note ?? info.warn : s.note;
}
