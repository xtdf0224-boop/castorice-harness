/* 左栏「待你 · N · 最久 X」入口（V0α · 模块 B4「交互」，Q01）。SideNav（B1）在左栏顶部渲染它。
   「待你」只数须亲自处理的（待批、待回复、计划待批）；失败与待查看写成另一个名目「可看 N」，不并进「待你」——
   与归来笺里「待你」区块的标题同一个数（r3：左栏 3、纸面 1 对不上）。最久也只算待你里的。
   数据未就绪时写「—」而不是 0。有须亲批的事时灯是金色. */
import { Lamp } from 'lucide-react';
import { useNow } from '../../lib/hooks';
import { actions } from '../../state/actions';
import { useQueue, useQueueReady } from '../../state/selectors';
import { useApp } from '../../state/store';
import { cx } from '../ui';
import { splitQueue } from '../views/tasks/queueSplit';
import '../../styles/interaction-return.css';

export function QueueNav({ collapsed }: { collapsed?: boolean }) {
  const items = useQueue();
  const ready = useQueueReady();
  const current = useApp((s) => s.view === 'queue');
  const now = useNow(30_000);
  const { must, look, oldest } = splitQueue(items, now);
  const urgent = ready && must.length > 0;
  // 灯与数字只跟「待你」走：没有须亲批的事就是空态（可看写成旁边的小字，紧凑态里写在读屏文案与悬停里）.
  const state = urgent ? 'is-urgent' : 'is-empty';
  const lookText = look.length ? `可看 ${look.length}` : '';
  const label = !ready
    ? '待你：数据还没有读到'
    : must.length
      ? `待你 ${must.length} 件，最久 ${oldest}${lookText ? `；另有 ${look.length} 件可看` : ''}`
      : `待你：现在没有等着的事${lookText ? `；另有 ${look.length} 件可看` : ''}`;

  return (
    <div className={cx('queue-nav-wrap', collapsed && 'is-compact')}>
      <button
        type="button"
        className={cx('queue-nav', state)}
        aria-current={current ? 'page' : undefined}
        aria-label={label}
        title={`${label}（Alt+8）`}
        onClick={() => actions.navigate('queue')}
      >
        <span className="queue-nav__lamp" aria-hidden><Lamp size={18} /></span>
        {!collapsed && <span className="queue-nav__label">待你</span>}
        <span className="queue-nav__count" aria-hidden>{ready ? must.length : '—'}</span>
        {!collapsed && (lookText || oldest) && (
          // 「可看 N」与「最久 X」收成一组：左栏窄（≈190 px）、昼里计数还带金色圆底时一行放不下，
          // 两样都有就整组换到第二行（样式里按容器宽判断），不裁字、不让某一个字孤在行尾.
          <span className={cx('queue-nav__meta', lookText && oldest && 'is-pair')} aria-hidden>
            {lookText && <span className="queue-nav__look">{lookText}</span>}
            {oldest && <span className="queue-nav__oldest">最久 {oldest}</span>}
          </span>
        )}
      </button>
    </div>
  );
}
