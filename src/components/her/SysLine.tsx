/* 系统行（样稿 C 的 .sysl，两侧渐隐线）：系统行在前，她的话在后（I-27）.
   「静默 8 分钟　她主动开口　今天 1/3　·　今天别再说」「已连续使用 2 小时　休息关照　·　今天别再提醒」.
   它不是第二种消息：由那条话自带的 Message.src 派生——src.slots 里有就写数字，没有就只写事实标签，从不编数字：
     minutes（或 silent）= 静默了几分钟；count（或 today）/ cap = 今天第几次 / 上限；hours = 连续使用的时长（带单位的字符串，如「两个小时」）.
   「今天别再说 / 今天别再提醒」经 noteDismiss('enough') 记进话语总闸（G8 / G9）. */
import { useState } from 'react';
import { noteDismiss } from '../../state/voiceGate';
import '../../styles/her.css';
import type { SysKind } from './logic';

export interface SysLineProps {
  kind: SysKind;
  scene: string;
  slots?: Record<string, string | number>;
}

const LABEL: Record<SysKind, string> = { rest: '休息关照', late: '夜深提醒', nudge: '她主动开口' };
const DISMISS: Record<SysKind, string> = { rest: '今天别再提醒', late: '今天别再提醒', nudge: '今天别再说' };

export function SysLine({ kind, scene, slots }: SysLineProps) {
  const [done, setDone] = useState(false);
  // 槽位名两边约定过两套：proactive.ts 写 silent（静默几分钟）/ today（今天第几次），文档与旧稿写 minutes / count；都认，免得系统行丢数字（T 对齐）.
  const minutes = slots?.minutes ?? slots?.silent;
  const count = slots?.count ?? slots?.today;
  const cap = slots?.cap;
  const hours = slots?.hours;
  return (
    <p className="sysl" data-sysl={kind}>
      {kind === 'nudge' && minutes !== undefined && <span className="sysl__fact">静默 {minutes} 分钟</span>}
      {kind === 'rest' && hours !== undefined && <span className="sysl__fact">已连续使用 {hours}</span>}
      <b>{LABEL[kind]}</b>
      {kind === 'nudge' && count !== undefined && cap !== undefined && <span className="sysl__fact">今天 {count}/{cap}</span>}
      <span aria-hidden="true">·</span>
      <button
        type="button" className="sysl__act" disabled={done}
        onClick={() => { noteDismiss(scene, 'enough', Date.now()); setDone(true); }}
      >
        {done ? '已记下' : DISMISS[kind]}
      </button>
    </p>
  );
}
