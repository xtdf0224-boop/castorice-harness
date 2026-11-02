/* 「待你」的口径（施工图 §4.5）：待你 = 须用户亲批 / 回答的（待批、待回复、计划待批）；失败与回合结束待查看归到「可看」.
   左栏的「待你 N」、归来笺正文的「待你」、纸面里「待你」区块的标题、「待你」页的页眉说的是同一个数（= must.length）；
   「可看」是另一个名目，从不并进「待你」。deriveQueue 的全部条目（含可看）仍是「待你」页列表、任务栏角标的口径，那里写明「共 N 件」. */
import type { QueueItem } from '../../../lib/types';
import { waitText } from '../../../lib/voice';

export const MUST = new Set<QueueItem['kind']>(['approval', 'question', 'plan']);

export interface QueueSplit {
  /** 须亲批 / 回答的（待你）. */
  must: QueueItem[];
  /** 失败、回合结束待查看（可看）. */
  look: QueueItem[];
  /** 待你里等得最久的一项的时长文案（「28 分」）；没有待你时是空串. */
  oldest: string;
}

export function splitQueue(items: QueueItem[], now: number): QueueSplit {
  const must = items.filter((i) => MUST.has(i.kind));
  const look = items.filter((i) => !MUST.has(i.kind));
  const oldest = must.length ? waitText(Math.max(0, now - Math.min(...must.map((i) => i.since)))) : '';
  return { must, look, oldest };
}
