/* 设置页里的一行：左边是标题与说明，右边是控件（窄了会换行）. 说明是纯文字时按词断行（Words）. */
import type { ReactNode } from 'react';
import { Words } from '../../shell/Words';

export function SettingRow({ title, desc, descId, children }: { title: string; desc?: ReactNode; descId?: string; children: ReactNode }) {
  return (
    <div className="settings-item">
      <div className="settings-row">
        <div className="settings-row__text">
          <p className="settings-row__title">{title}</p>
          {desc && <p className="settings-row__desc words-scope" id={descId}>{typeof desc === 'string' ? <Words text={desc} /> : desc}</p>}
        </div>
        <div className="settings-row__control">{children}</div>
      </div>
    </div>
  );
}
