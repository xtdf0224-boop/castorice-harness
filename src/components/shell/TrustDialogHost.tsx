/* 信任确认框的挂载点（V0α · 模块 B5「安全」）。App.tsx 已挂载；requestTrust() 通过 trustGate 的队列在这里弹框.
   内容在 TrustDialogView.tsx（纯展示，可测试）；这里只管订阅队列、读话量与口吻设置（useVoice）、把选择交回 trustGate. */
import { useCallback, useSyncExternalStore } from 'react';
import '../../styles/security-trust.css';
import { decideTrust, getTrustPromptSnapshot, subscribeTrustPrompt, type TrustChoice } from '../../state/trustGate';
import { useVoice } from '../../state/selectors';
import { useApp } from '../../state/store';
import { TrustDialogView, trustLead } from './TrustDialogView';

export function TrustDialogHost() {
  const state = useSyncExternalStore(subscribeTrustPrompt, getTrustPromptSnapshot, getTrustPromptSnapshot);
  const voice = useVoice();
  const callName = useApp((s) => s.settings.callName);
  const id = state?.id;
  // 稳定的回调：Dialog 的焦点管理依赖 onClose 的身份，勾选框改变状态时不能让它重新抢焦点.
  const onChoose = useCallback((choice: TrustChoice, opts?: { acknowledged?: boolean }) => {
    if (id !== undefined) void decideTrust(id, choice, opts);
  }, [id]);
  if (!state) return null;
  return <TrustDialogView key={state.id} state={state} lead={trustLead(state.info, voice.level, callName, voice.persona)} onChoose={onChoose} />;
}
