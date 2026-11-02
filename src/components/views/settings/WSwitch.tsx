/* 设置页与右栏里带说明的开关：说明按词断行（Words），不在「定夺」「生效」中间换行、不留单字行.
   包一层 .words-scope，样式见 interaction-settings.css；其余与 ui 的 Switch 完全一样. */
import type { ComponentProps } from 'react';
import { Switch } from '../../ui';
import { Words } from '../../shell/Words';

type Props = Omit<ComponentProps<typeof Switch>, 'description'> & { description?: string };

export function WSwitch({ description, ...rest }: Props) {
  return (
    <div className="words-scope">
      <Switch {...rest} description={description ? <Words text={description} /> : undefined} />
    </div>
  );
}
