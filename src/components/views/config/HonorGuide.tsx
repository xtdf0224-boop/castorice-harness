/* 工具页顶部「引擎遵守情况」（施工图 §2.1.4 / §4.3）：不再手写，一律由 honorSummary(driver, mode) 逐引擎、逐权限模式生成.
   Claude Code 一行带权限模式选择（逐项 / 计划 / 接受编辑 / 自动 / 放手），因为银档在不同模式下会不会问并不一样；其余引擎与模式无关.
   文案不用「银手套 / 黑档 / 黑色审批卡」（D1）；「手套」只留给输入框里的权限模式. */
import { useId } from 'react';
import { Info } from 'lucide-react';
import { PERMISSION_MODE_LABEL, honorSummary, type HonorDriver } from '../../../lib/providers';
import type { PermissionMode } from '../../../lib/types';
import { cx } from '../../ui';

export const GUIDE_MODES: readonly PermissionMode[] = ['ask', 'plan', 'acceptEdits', 'auto', 'bypass'];

const OTHER_ENGINES: ReadonlyArray<{ id: string; name: string; driver: HonorDriver }> = [
  { id: 'codex', name: 'Codex', driver: 'codex' },
  { id: 'dsh', name: 'DeepSeek Harness', driver: 'dsh' },
  { id: 'acp', name: 'Kimi / Qwen / MiniMax 等命令行代理', driver: 'acp:kimi' },
  { id: 'api', name: 'API 方式（任何服务）', driver: 'api' },
];

export function HonorGuide({ mode, onMode }: { mode: PermissionMode; onMode?: (m: PermissionMode) => void }) {
  const group = useId();
  return (
    <div className="callout callout--neutral tools-honor" role="note">
      <Info size={18} aria-hidden className="callout__icon" />
      <div className="callout__body">
        <p className="callout__text">
          工具策略是全局的，作用于所有任务里的命令行 Agent：它要用某个工具时，按这里的设置自动执行、先问你，或直接拒绝；每个 Agent 还可以在 Agent 页把某个工具再收紧一档（只能收紧，不能放宽）。但各引擎遵守的程度不同，如实写在下面：
        </p>
        <dl className="tools-honor__list">
          <div className="tools-honor__row" data-engine="claude-code">
            <dt>Claude Code</dt>
            <dd>
              {onMode ? (
                /* 原生 radio（同 CardBack 的 TierSwitch）：方向键切换、组内只占一个 Tab 位由浏览器负责 */
                <span role="radiogroup" aria-label="权限模式" className="tools-honor__modes">
                  {GUIDE_MODES.map((m) => (
                    <label key={m} className={cx('tools-honor__mode', m === mode && 'is-on')}>
                      <input type="radio" className="sr-only" name={group} value={m} checked={m === mode} onChange={() => onMode(m)} />
                      <span>{PERMISSION_MODE_LABEL[m]}</span>
                    </label>
                  ))}
                </span>
              ) : null}
              <span className="tools-honor__text" data-mode={mode}>{honorSummary('claude-code', mode)}</span>
            </dd>
          </div>
          {OTHER_ENGINES.map((e) => (
            <div className="tools-honor__row" key={e.id} data-engine={e.id}>
              <dt>{e.name}</dt>
              <dd><span className="tools-honor__text">{honorSummary(e.driver, mode)}</span></dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
