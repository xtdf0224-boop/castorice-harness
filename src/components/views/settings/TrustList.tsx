/* 「信任的目录」列表（V0α · 模块 B5「安全」）。纯展示，状态与动作由 TrustSection 传入，方便无 DOM 渲染测试. */
import { Folder, FolderGit2 } from 'lucide-react';
import type { TrustEntry } from '../../../lib/trustBridge';
import { Button } from '../../ui';

export function entryName(e: Pick<TrustEntry, 'dir'>): string {
  const parts = e.dir.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? e.dir;
}

export function levelLabel(level: TrustEntry['level']): string {
  return level === 'T2' ? '完全信任 · T2' : '我的目录 · T1';
}

function dateText(ms: number): string {
  if (!ms) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function TrustList({ entries, busyKey, onRevoke }: { entries: TrustEntry[]; busyKey?: string | null; onRevoke: (entry: TrustEntry) => void }) {
  if (entries.length === 0) {
    return <p className="trust-list__empty">还没有信任过任何目录。新目录默认只读，要写入的时候，我会先问一声。</p>;
  }
  return (
    <ul className="trust-list" aria-label="信任的目录">
      {entries.map((e) => {
        const Icon = e.isRepo ? FolderGit2 : Folder;
        const name = entryName(e);
        return (
          <li key={e.key} className="trust-list__row">
            <Icon className="trust-list__icon" size={18} aria-hidden />
            <div className="trust-list__text">
              <p className="trust-list__name">{name}</p>
              <p className="trust-list__path" title={e.dir}>{e.dir}</p>
              <p className="trust-list__meta">
                <span className="trust-list__level">{levelLabel(e.level)}</span>
                {e.isRepo && <span>整个仓库</span>}
                {e.remote && <span>{e.remote}</span>}
                {e.grantedAt > 0 && <span>{dateText(e.grantedAt)} 授予</span>}
                {!e.exists && <span className="trust-list__missing">目录已不存在</span>}
              </p>
            </div>
            <Button size="sm" variant="secondary" busy={busyKey === e.key} aria-label={`撤销对「${name}」的信任`} onClick={() => onRevoke(e)}>撤销</Button>
          </li>
        );
      })}
    </ul>
  );
}
