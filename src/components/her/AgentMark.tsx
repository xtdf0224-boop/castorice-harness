/* Agent 的官方命途图标（施工图 §4.2、D14、§4.7）。
   <48 px 用 `-s` 64²，≥48 用 128²（由 PATH_SRC 决定）；着色靠 CSS（夜里提亮、昼里压成深紫）；aria-label 带命途名.
   命途分配是产品自定的象征，不宣称官方对应. DOM：data-agent-mark（D-05：src 必须来自 her/path-*）；渲染边长 ≤ 128. */
import { PATH_NAME, PATH_OF, PATH_SRC } from '../../lib/expr';
import type { AgentId } from '../../lib/types';
import '../../styles/her.css';

export function AgentMark({ agent, size, state }: { agent: AgentId; size: number; state?: 'busy' | 'done' | 'idle' | 'off' }) {
  const path = PATH_OF[agent];
  const px = Math.min(Math.max(1, Math.round(size)), 128);
  const name = `${PATH_NAME[path]}命途`;
  return (
    <img
      data-agent-mark={agent}
      data-state={state}
      data-small={px < 48 ? '' : undefined}
      className="hmark"
      src={PATH_SRC(path, px)}
      alt={name}
      aria-label={name}
      width={px}
      height={px}
      draggable={false}
      style={{ width: px, height: px }}
    />
  );
}
