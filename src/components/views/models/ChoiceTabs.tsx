/* 一排互斥的小按钮（单选组）：和 Segmented 同一套外观，但每项可以带计数、可以单独禁用并写明原因。
   模型接入页用它做分组页签（国际 7 · 国内 11 …）和卡片里的「命令行登录 / API 密钥」。 */
import type { LucideIcon } from 'lucide-react';
import { useId } from 'react';
import { cx } from '../../ui';

export interface Choice<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
  /** A count after the label (0 is shown too when `showZero`). */
  count?: number;
  /** Greyed out and not selectable; `hint` says why. */
  disabled?: boolean;
  hint?: string;
}

export function ChoiceTabs<T extends string>({ options, value, onChange, label, size = 'md', className, showZero }: {
  options: Array<Choice<T>>; value: T; onChange: (v: T) => void; label: string; size?: 'sm' | 'md'; className?: string; showZero?: boolean;
}) {
  const name = useId();
  return (
    <div role="radiogroup" aria-label={label} className={cx('segmented', `segmented--${size}`, 'choice-tabs', className)}>
      {options.map((o) => {
        const Icon = o.icon;
        const selected = o.value === value;
        return (
          <label key={o.value} className={cx('segmented__opt', selected && 'is-selected', o.disabled && 'is-disabled')} title={o.hint}>
            <input type="radio" name={name} value={o.value} checked={selected} disabled={o.disabled} onChange={() => onChange(o.value)} className="sr-only" aria-describedby={o.disabled && o.hint ? `${name}-${o.value}-why` : undefined} />
            {Icon && <Icon size={14} aria-hidden />}
            <span>{o.label}</span>
            {o.count != null && (o.count > 0 || showZero) && <small className="segmented__count">{o.count}</small>}
            {o.disabled && o.hint && <span id={`${name}-${o.value}-why`} className="sr-only">：{o.hint}</span>}
          </label>
        );
      })}
    </div>
  );
}
