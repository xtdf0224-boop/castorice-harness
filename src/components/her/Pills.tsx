/* 选项胶囊（施工图 §4.4、I-26，借样稿 B）：只在闲聊，出现在休息关照 / 很晚 / 主动搭话之后与多档的小事之后.
   ≤3 个，最后一个恒为退出项（透明底、虚线描边）；点普通项 = 把那句字当用户消息发出；退出项只走模板短回 / 「今天别再提醒」，不调模型、不追问.
   文案来自 pills.ts（pill.* 台词），这里一个字都不加；不挡输入；aria-label 清楚.
   第 3 轮评审（借样稿 B 的剧情选项）：37 px 高，左边 22 px 圆形图标位——普通项对话气泡，退出项门（图标纯装饰，aria-hidden）. */
import { DoorOpen, MessageCircle } from 'lucide-react';
import type { Pill } from '../../lib/pills';
import '../../styles/her.css';

export function Pills({ pills, onPick }: { pills: readonly Pill[]; onPick: (p: Pill) => void }) {
  if (!pills.length) return null;
  const shown = pills.slice(0, 3);
  // 退出项恒在最后：就算调用方顺序不对也在这里扶正.
  const ordered = [...shown.filter((p) => !p.exit), ...shown.filter((p) => p.exit)].slice(0, 3);
  return (
    <div className="her-pills" role="group" aria-label="可以这样回她">
      {ordered.map((p) => (
        <button key={p.id} type="button" className={`pill${p.exit ? ' pill--exit' : ''}`} data-pill={p.id} aria-label={p.exit ? `${p.text}（结束这个话题）` : p.text} onClick={() => onPick(p)}>
          <span className="pill__icon" aria-hidden="true">{p.exit ? <DoorOpen size={13} /> : <MessageCircle size={13} />}</span>
          {p.text}
        </button>
      ))}
    </div>
  );
}
