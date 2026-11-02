/* 额度条 L0（V0α · 模块 B4「交互」，Q03）：本次 / 今日 / 本周的花费，一律标「估算」；数据源缺失显示「—」。
   花费是引擎自己报告的 API 等价费用（Claude 的 total_cost_usd），订阅用户不会按它扣费；没有费用时退成 token 数。
   永远不把它换算成百分比——订阅窗口的百分比（L1）要等原样渲染服务端给的行，V0β 再做。SideNav（B1）在左栏底部渲染它. */
import { Coins } from 'lucide-react';
import { quotaCell, thisRunUsage } from '../../state/selectors';
import { shallow, useApp } from '../../state/store';
import { cx } from '../ui';
import '../../styles/interaction-return.css';

const NOTE = '估算：引擎报告的 API 等价费用，不是账单。订阅登录的账号不会按这个数字扣费。「—」表示还没有数据。';

export function QuotaBar({ collapsed }: { collapsed?: boolean }) {
  const cells = useApp((s) => {
    const mine = thisRunUsage(s);
    return {
      run: quotaCell(mine?.costUsd, mine?.tokens),
      today: quotaCell(s.usage?.today.costUsd, s.usage?.today.tokens),
      week: quotaCell(s.usage?.week.costUsd, s.usage?.week.tokens),
    };
  }, shallow);
  const text = `额度（估算）：本次 ${cells.run}，今日 ${cells.today}，本周 ${cells.week}`;

  if (collapsed) {
    return (
      <div className="quota-bar is-compact" role="img" aria-label={text} title={`${text}\n${NOTE}`}>
        <Coins size={18} aria-hidden />
      </div>
    );
  }
  return (
    <section className={cx('quota-bar')} aria-label="额度（估算）" title={NOTE}>
      <h2 className="quota-bar__title">额度<span>估算</span></h2>
      <dl className="quota-bar__cells">
        <div><dt>本次</dt><dd>{cells.run}</dd></div>
        <div><dt>今日</dt><dd>{cells.today}</dd></div>
        <div><dt>本周</dt><dd>{cells.week}</dd></div>
      </dl>
    </section>
  );
}
