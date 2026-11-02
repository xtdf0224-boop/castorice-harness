/* "当前目标": the task's goal, plus when it was created, who works on it and which model runs it.
   收起时是一行（高 ≤ 48px：标签 + 一行目标 + 元信息 + 展开键），展开才看全文——工作页上半屏要让给计划卡和她的话（第 1 轮评审）.
   Agent 的命途图标每个 18px、间距 2px、不重叠，悬停写着名字与命途. */
import { ChevronDown } from 'lucide-react';
import { useId, useLayoutEffect, useRef, useState } from 'react';
import { relative } from '../../lib/format';
import { useNow } from '../../lib/hooks';
import type { Agent } from '../../lib/types';
import { shallow, useApp } from '../../state/store';
import { PATH_NAME, PATH_OF } from '../../lib/expr';
import { AgentMark } from '../her/AgentMark';
import { cx } from '../ui';

export function GoalCard({ taskId }: { taskId: string }) {
  const task = useApp((s) => {
    const t = s.tasks[taskId];
    return t ? { goal: t.goal, createdAt: t.createdAt, agentIds: t.agentIds, engine: t.engine?.label, cwd: t.engine?.cwd, access: t.engine?.access } : undefined;
  }, shallow);
  const agents = useApp((s) => s.agents);
  const now = useNow(30_000);
  const textId = useId();
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const goal = task?.goal ?? '';

  // Detect whether the clamped text is cut off; re-measure when the width changes.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    // 收起时是一行加省略号：横向被截断（scrollWidth）或换行被截断（scrollHeight）都算「还有更多」.
    const measure = () => { if (!expanded) setOverflowing(el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [goal, expanded]);

  if (!task) return null;
  const members = task.agentIds.map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a);
  const names = members.map((a) => a.name).join('、');

  return (
    <section className={cx('panel ws-goal', !expanded && 'is-collapsed')} aria-label="当前目标">
      <div className="ws-goal__row">
        <span className="label ws-goal__label">当前目标</span>
        <p id={textId} ref={textRef} className={cx('ws-goal__text', !expanded && 'is-clamped')} title={expanded ? undefined : goal}>{goal}</p>
        {(overflowing || expanded) && (
          <button type="button" className="ws-goal__toggle" aria-expanded={expanded} aria-controls={textId} onClick={() => setExpanded((v) => !v)}>
            <ChevronDown size={14} aria-hidden />
            {expanded ? '收起' : '展开'}
          </button>
        )}
        <ul className="ws-goal__meta" role="list">
          <li>{relative(task.createdAt, now)}创建</li>
          <li className="ws-goal__agents" title={names}>
            <span className="ws-goal__stack" aria-hidden>
              {members.map((a) => (
                <span key={a.id} className="ws-goal__mark" title={`${a.name} · ${PATH_NAME[PATH_OF[a.id]]}命途`}>
                  <AgentMark agent={a.id} size={18} />
                </span>
              ))}
            </span>
            <span>{members.length} 个 Agent<span className="sr-only">：{names}</span></span>
          </li>
          {task.engine && <li className="ws-goal__engine" title={task.cwd ? `工作文件夹：${task.cwd}` : undefined}>{task.engine}{task.access === 'read' ? ' · 只读' : ''}</li>}
        </ul>
      </div>
    </section>
  );
}
