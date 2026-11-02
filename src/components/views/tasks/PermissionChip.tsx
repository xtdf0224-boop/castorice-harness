/* 权限模式芯片（K32）：逐项确认 / 接受编辑 / 先出计划 / 自动 / 放手。
   首页的信封里叫「手套」，任务页的输入框里常显（TaskPermissionChip，自己读写任务的 engine.permissionMode）。
   引擎做不到的档如实写在提示里，不假装生效（permission.ts 的 modeNote）. */
import { Hand, TriangleAlert } from 'lucide-react';
import type { DriverId, PermissionMode } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { useApp } from '../../../state/store';
import { MenuSelect } from '../../ui/MenuSelect';
import { DEFAULT_MODE, PERMISSION_MODES, modeInfo, modeNote } from './permission';

export function PermissionChip({ value, onChange, driver, disabled, prefix = '手套' }: {
  value?: PermissionMode;
  onChange: (m: PermissionMode) => void;
  driver?: DriverId;
  disabled?: boolean;
  /** 芯片上的前缀；首页信封里是「手套」，任务页里写「权限」. */
  prefix?: string;
}) {
  const info = modeInfo(value);
  const note = modeNote(info.value, driver);
  return (
    <MenuSelect<PermissionMode>
      variant="chip"
      icon={info.value === 'bypass' ? TriangleAlert : Hand}
      label="权限模式"
      value={value ?? DEFAULT_MODE}
      onChange={onChange}
      disabled={disabled}
      display={`${prefix} · ${info.label}`}
      title={`权限模式：${info.label}。${info.sub}${note ? `\n${note}` : ''}`}
      options={PERMISSION_MODES.map((m) => ({ value: m.value, label: m.label, sub: m.sub, icon: m.value === 'bypass' ? TriangleAlert : Hand }))}
      search={false}
      minWidth={300}
    />
  );
}

/** 任务页输入框里的权限模式芯片：读写这个任务的 engine.permissionMode（下一次运行起生效）. */
export function TaskPermissionChip({ taskId }: { taskId: string }) {
  const engine = useApp((s) => s.tasks[taskId]?.engine);
  if (!engine || engine.auth !== 'cli') return null;
  return <PermissionChip prefix="权限" value={engine.permissionMode} driver={engine.driver} onChange={(m) => actions.setTaskPermissionMode(taskId, m)} />;
}
