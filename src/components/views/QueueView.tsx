/* 「待你」全部（V0α · 模块 B4「交互」，Q01）。
   和左栏「待你 · N」、任务栏角标是同一份 deriveQueue：数字相等；排序是类别、再按等得最久，没有随机，也不经过模型。
   每一行在行内就能处理（批准、回答、批计划）；批准没有单键、没有全局键. */
import { Lamp } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNow } from '../../lib/hooks';
import type { QueueKind } from '../../lib/types';
import { useSay2 } from '../../lib/voice';
import { QUEUE_LABEL } from '../../state/queue';
import { personaOn, useQueue, useQueueReady } from '../../state/selectors';
import { useApp } from '../../state/store';
import { Badge, cx } from '../ui';
import { HerAvatar } from '../her/HerAvatar';
import { QueueRow } from './tasks/QueueRow';
import { splitQueue } from './tasks/queueSplit';
import '../../styles/interaction-return.css';

type Filter = 'all' | QueueKind;
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'approval', label: QUEUE_LABEL.approval },
  { id: 'question', label: QUEUE_LABEL.question },
  { id: 'plan', label: QUEUE_LABEL.plan },
  { id: 'failed', label: QUEUE_LABEL.failed },
  { id: 'turn-done', label: QUEUE_LABEL['turn-done'] },
];

export function QueueView() {
  const items = useQueue();
  const ready = useQueueReady();
  const persona = useApp((s) => personaOn(s));
  const say2 = useSay2();
  const now = useNow(30_000);
  const [filter, setFilter] = useState<Filter>('all');
  // 页眉的「待你 N」与左栏、归来笺同一个数（须亲批 / 回答的）；失败与待查看是「可看」，列表里照样都有.
  const { must, look, oldest } = splitQueue(items, now);
  const mustText = ready ? String(must.length) : '—';
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: items.length, approval: 0, question: 0, plan: 0, failed: 0, 'turn-done': 0 };
    for (const i of items) c[i.kind] += 1;
    return c;
  }, [items]);
  const shown = filter === 'all' ? items : items.filter((i) => i.kind === filter);

  return (
    <div className="view queue-view">
      <header className="view__header">
        <div className="view__heading">
          <h1 className="view__title">
            <Lamp size={22} aria-hidden className="queue-view__lamp" />
            待你
            <Badge tone={must.length ? 'warning' : 'neutral'} title={ready ? `待你 ${must.length} 件，另有 ${look.length} 件可看` : '待你：数据还没有读到'}>{mustText}<span className="sr-only"> 件</span></Badge>
          </h1>
          <p className="view__desc">待你是须亲自批、亲自答的事{ready && look.length > 0 && `，另有 ${look.length} 件可看（失败、待查看）`}。列表先按类别、再按等得最久的排。{oldest && `待你里最久 ${oldest}。`}没有随机，也不经过模型。</p>
        </div>
      </header>

      <div className="queue-view__filters" role="group" aria-label="按类别筛选">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" className={cx('queue-filter', filter === f.id && 'is-active')} aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>
            {f.label}<span className="queue-filter__n">{ready ? counts[f.id] : '—'}</span>
          </button>
        ))}
      </div>

      {!ready ? (
        <p className="queue-view__empty" role="status">—</p>
      ) : shown.length === 0 ? (
        <div className="queue-view__empty" role="status" data-her={persona && filter === 'all' ? '' : undefined}>
          {persona && filter === 'all' && <HerAvatar size={40} expr="relaxed" ring="none" />}
          <p>{filter === 'all' ? say2('queue.empty', {}, { mode: 'work' }).text : `没有「${QUEUE_LABEL[filter]}」的事。`}</p>
        </div>
      ) : (
        <ul className="queue-list" aria-label="待你">
          {shown.map((it) => <QueueRow key={it.key} item={it} now={now} />)}
        </ul>
      )}
    </div>
  );
}
