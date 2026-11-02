import { Wrench } from 'lucide-react';
import { useState } from 'react';
import { PERMISSION } from '../../lib/status';
import type { PermissionMode } from '../../lib/types';
import { useApp } from '../../state/store';
import { Panel, cx } from '../ui';
import { ToolRow } from './config/ToolRow';
import { PERM_ICON, sameRecord, selectToolStats } from './config/util';
import { BrowserPanel } from './config/BrowserPanel';
import { SkillsPanel } from './config/SkillsPanel';
import { HonorGuide } from './config/HonorGuide';
import { useHonorEnv } from './config/honorUi';
import { ViewHeader } from './config/ViewHeader';

const POLICY_HELP = [
  { id: 'auto', text: '直接调用' },
  { id: 'confirm', text: '调用前先问你，出现在「待确认操作」；是否一定会问，随引擎与权限模式，见上方说明' },
  { id: 'off', text: 'Agent 不能调用，它会换一种做法或说明做不到' },
] as const;

/** Skills, the 栖枝浏览器 window agents can drive, and the tool policies (auto / confirm / off). */
export function ToolsView() {
  const tools = useApp((s) => s.tools);
  const stats = useApp(selectToolStats, sameRecord);
  // 权限模式：默认取此刻选中任务的（Claude Code 在不同模式下，需确认的工具会不会问并不一样）；这里可以改着看.
  const env = useHonorEnv();
  const [picked, setMode] = useState<PermissionMode | undefined>();
  const mode = picked ?? env.mode;

  return (
    <div className="view tools-view">
      <ViewHeader icon={Wrench} title="工具与技能" desc="管理 Agent 能用的技能，准备好栖枝浏览器，并设置它调用工具的方式。" />

      <HonorGuide mode={mode} onMode={setMode} />

      <SkillsPanel />
      <BrowserPanel />

      <Panel label="工具策略" title="工具" icon={Wrench} energy flush>
        <ul className="tools-policy" aria-label="调用策略说明">
          {POLICY_HELP.map(({ id, text }) => {
            const Icon = PERM_ICON[id];
            return (
              <li key={id} className={cx('tools-policy__item', `is-${id}`)}>
                <Icon size={16} aria-hidden />
                <p><strong>{PERMISSION[id].label}</strong><span aria-hidden> = </span><span className="sr-only">：</span>{text}</p>
              </li>
            );
          })}
        </ul>

        <div className="tools-listwrap">
          <div className="tools-list">
            <div className="tools-cols" aria-hidden>
              <span>工具</span><span>风险</span><span>调用策略</span><span>使用情况</span>
            </div>
            <ul className="tools-rows">
              {tools.map((tool) => <ToolRow key={tool.id} tool={tool} stat={stats[tool.id]} />)}
            </ul>
          </div>
        </div>
      </Panel>
    </div>
  );
}
