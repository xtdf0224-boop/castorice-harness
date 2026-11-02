/* 设置 › 数据（V0α · 模块 B2「存储」）：数据目录（可改到别的盘；C 盘剩余 <15 GB 时提示）、数据库与备份（VACUUM INTO）、
   用量记录开关（默认开，只存数字）。SettingsView（B4）渲染它；children 放在最后（例如「清除所有任务记录」那一行）. */
import { Archive, Database, FolderOpen, HardDrive, RefreshCw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import {
  backupNow, clearUsage, compactDb, getStatus, listBackups, openDataDir, pickDataDir, setDataDir, setUsageEnabled, storeAvailable,
  usageEnabled, type BackupItem, type StoreStatus,
} from '../../../lib/storeBridge';
import type { UsageSummary } from '../../../lib/types';
import { flushSaveAsync, freezeWrites } from '../../../state/persist';
import { useApp } from '../../../state/store';
import { Button, Panel } from '../../ui';
import { WSwitch } from './WSwitch';
import '../../../styles/store-data.css';

const GB = 1024 ** 3;
const MB = 1024 ** 2;

function bytes(n: number | undefined): string {
  if (n === undefined) return '未知';
  if (n >= GB) return `${(n / GB).toFixed(n >= 100 * GB ? 0 : 1)} GB`;
  if (n >= MB) return `${(n / MB).toFixed(n >= 100 * MB ? 0 : 1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}
const when = (t: number) => new Date(t).toLocaleString('zh-CN', { hour12: false });
const money = (v: number | undefined) => (v === undefined ? '—' : `$${v < 1 ? v.toFixed(3) : v.toFixed(2)}`);

type Note = { tone: 'ok' | 'warn' | 'bad'; text: string };
type Pending = { dir: string; exists: boolean };

export function DataSection({ children }: { children?: ReactNode }) {
  const desktopStore = storeAvailable();
  const usage = useApp((s) => s.usage);
  const [status, setStatus] = useState<StoreStatus>();
  const [backups, setBackups] = useState<BackupItem[]>([]);
  const [busy, setBusy] = useState<'backup' | 'move' | 'compact' | undefined>();
  const [note, setNote] = useState<Note>();
  const [pending, setPending] = useState<Pending>();
  const [usageOn, setUsageOn] = useState(true);
  const [confirmClear, setConfirmClear] = useState(false);

  const refresh = useCallback(async () => {
    if (!desktopStore) return;
    const [st, bk] = await Promise.all([getStatus(), listBackups()]);
    if (st.ok) { setStatus(st.status); setUsageOn(st.status.usageEnabled); }
    if (bk.ok) setBackups(bk.items.slice(0, 5));
  }, [desktopStore]);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (!desktopStore) void usageEnabled().then(setUsageOn); }, [desktopStore]);

  const runBackup = async (dir?: string) => {
    setBusy('backup');
    setNote(undefined);
    await flushSaveAsync();
    const r = await backupNow(dir);
    setBusy(undefined);
    if (r.ok) {
      setNote({ tone: 'ok', text: `已备份到 ${r.path}（${bytes(r.bytes)}，${r.tasks} 个任务，用时 ${r.ms} ms，自检通过）。` });
      void refresh();
    } else setNote({ tone: 'bad', text: `没能备份：${r.error}` });
  };

  const chooseOther = async () => {
    const dir = await pickDataDir(status?.dataDir);
    if (dir) await runBackup(dir);
  };

  const askMove = async (dir: string | null) => {
    if (!dir) return;
    setNote(undefined);
    setPending({ dir, exists: false });
  };
  const pickAndAsk = async () => { await askMove(await pickDataDir(status?.dataDir)); };

  const doMove = async (p: Pending) => {
    setBusy('move');
    setNote(undefined);
    await flushSaveAsync();
    const r = await setDataDir(p.dir, p.exists);
    setBusy(undefined);
    if (r.ok) {
      // 页面还要活 1.6 秒才重新载入：这段时间里的保存会写进新位置的库（只带着增量，建出残缺的任务行），先冻结
      freezeWrites();
      setPending(undefined);
      setNote({ tone: 'ok', text: `已切换到 ${r.dataDir}。${r.copied ? `数据已复制（${bytes(r.copied.bytes)}）并通过自检。` : ''}旧位置 ${r.previous} 的文件原样保留，确认没问题后可以自己删除。正在重新载入……` });
      window.setTimeout(() => window.location.reload(), 1600);
    } else if (r.code === 'exists') {
      setPending({ dir: p.dir, exists: true });
    } else {
      setPending(undefined);
      setNote({ tone: 'bad', text: `没能切换：${r.error}` });
    }
  };

  const doCompact = async () => {
    setBusy('compact');
    setNote(undefined);
    await flushSaveAsync();
    const r = await compactDb();
    setBusy(undefined);
    if (r.ok) { setNote({ tone: 'ok', text: `已整理：${bytes(r.before)} → ${bytes(r.after)}。` }); void refresh(); } else setNote({ tone: 'bad', text: `没能整理：${r.error}` });
  };

  const toggleUsage = async (on: boolean) => { setUsageOn(on); setUsageOn(await setUsageEnabled(on)); };
  const doClear = async () => {
    setConfirmClear(false);
    const n = await clearUsage();
    setNote({ tone: 'ok', text: n ? `已清除 ${n} 条用量记录。` : '没有用量记录可清除。' });
  };

  const disk = status?.disk;
  const used = disk?.totalBytes && disk.freeBytes !== undefined ? Math.round((1 - disk.freeBytes / disk.totalBytes) * 100) : undefined;
  const source = status?.source === 'env' ? '由环境变量 ALIGHT_DATA_DIR 指定' : status?.source === 'config' ? '你在这里设置的位置' : '默认位置（应用的用户数据目录）';

  return (
    <Panel label="存储" title="数据与备份" icon={Database} energy>
      <div className="settings-list">
        {desktopStore ? (
          <>
            <div className="settings-item">
              <div className="settings-row">
                <div className="settings-row__text">
                  <p className="settings-row__title">数据目录</p>
                  <p className="settings-row__desc">任务、消息、事件和用量都存在这个文件夹里的 alight.db（SQLite），只在这台电脑上。{source}。</p>
                  <p className="sd-path">{status?.dataDir ?? '读取中……'}</p>
                  {status?.warning && <p className="sd-callout sd-callout--warn" role="status">{status.warning}</p>}
                  {disk && (
                    <div className="sd-disk">
                      <div className="sd-disk__bar" role="img" aria-label={used === undefined ? '磁盘容量未知' : `${disk.root} 已用 ${used}%`}>
                        <span style={{ width: `${used ?? 0}%` }} data-low={disk.low || undefined} />
                      </div>
                      <p className="sd-meta">
                        {disk.root} 剩余 {bytes(disk.freeBytes)} / 共 {bytes(disk.totalBytes)}
                        {disk.low && <strong>低于 {bytes(disk.thresholdBytes)}</strong>}
                      </p>
                    </div>
                  )}
                  {disk?.low && (
                    <div className="sd-callout sd-callout--warn" role="status">
                      <p>{disk.root} 的剩余空间不多了。聊天记录和工具输出会越积越多，建议把数据放到空间更大的盘。</p>
                      {disk.suggestions.length > 0 && (
                        <div className="sd-actions">
                          {disk.suggestions.map((s) => (
                            <Button key={s.dir} size="sm" variant="secondary" icon={HardDrive} disabled={!!busy || status?.envLocked} onClick={() => void askMove(s.dir)}>
                              改到 {s.dir}（剩 {bytes(s.freeBytes)}）
                            </Button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="settings-row__control sd-actions">
                  <Button size="sm" variant="secondary" icon={FolderOpen} disabled={!!busy || status?.envLocked} onClick={() => void pickAndAsk()}>更改位置…</Button>
                  <Button size="sm" variant="ghost" onClick={() => void openDataDir('data')}>打开文件夹</Button>
                </div>
              </div>

              {pending && (
                <div className="sd-callout" role="alertdialog" aria-label="确认更改数据目录">
                  {pending.exists ? (
                    <p>{pending.dir} 里已经有一份栖枝数据库。要改用它吗？当前这份不会被删除，也不会和它合并。</p>
                  ) : (
                    <p>把数据放到 <span className="sd-path">{pending.dir}</span>？栖枝会先把现有数据复制过去并自检，旧位置的文件原样保留。完成后页面会重新载入。</p>
                  )}
                  <div className="sd-actions">
                    <Button size="sm" variant="primary" busy={busy === 'move'} onClick={() => void doMove(pending)}>{pending.exists ? '改用它' : '确认更改'}</Button>
                    <Button size="sm" variant="ghost" disabled={busy === 'move'} onClick={() => setPending(undefined)}>取消</Button>
                  </div>
                </div>
              )}
            </div>

            <div className="settings-item">
              <div className="settings-row">
                <div className="settings-row__text">
                  <p className="settings-row__title">数据库与备份</p>
                  <p className="settings-row__desc">备份是一份可以单独打开的完整副本（VACUUM INTO），不会覆盖已有的备份。</p>
                  <p className="sd-meta">
                    {status ? `${bytes(status.bytes)} · ${status.counts.tasks} 个任务 · ${status.counts.messages.toLocaleString('zh-CN')} 条消息 · SQLite ${status.sqlite}` : '读取中……'}
                  </p>
                </div>
                <div className="settings-row__control sd-actions">
                  <Button size="sm" variant="secondary" icon={Archive} busy={busy === 'backup'} disabled={!!busy} onClick={() => void runBackup()}>立即备份</Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void chooseOther()}>备份到其他位置…</Button>
                  <Button size="sm" variant="ghost" disabled={!!busy} onClick={() => void openDataDir('backups')}>打开备份文件夹</Button>
                  <Button size="sm" variant="ghost" icon={RefreshCw} busy={busy === 'compact'} disabled={!!busy} onClick={() => void doCompact()} title="删掉任务后回收库文件里的空闲空间">整理数据库</Button>
                </div>
              </div>
              {backups.length > 0 && (
                <ul className="sd-list" aria-label="最近的备份">
                  {backups.map((b) => <li key={b.path}><span className="sd-path">{b.name}</span><span>{bytes(b.bytes)}</span><span>{when(b.at)}</span></li>)}
                </ul>
              )}
              {note && <p className={`sd-note sd-note--${note.tone}`} role="status">{note.text}</p>}
            </div>
          </>
        ) : (
          <div className="settings-item">
            <p className="settings-row__title">保存位置</p>
            <p className="settings-row__desc">现在是浏览器开发版：任务和设置存在浏览器自己的存储里，没有数据库、备份和数据目录设置。桌面版会把它们放进本机的数据库。</p>
            {note && <p className={`sd-note sd-note--${note.tone}`} role="status">{note.text}</p>}
          </div>
        )}

        <div className="settings-item">
          <WSwitch
            label="记录用量"
            description="记下每个回合的 token 数、花费和用的模型，用来在额度条上显示今日与本周的用量。只存数字，不存任何对话内容；数据只在这台电脑上，随时可以关掉或清除。"
            checked={usageOn}
            onChange={(v) => void toggleUsage(v)}
          />
          <UsageLine usage={usage} on={usageOn} />
          <div className="sd-actions sd-actions--row">
            {confirmClear ? (
              <>
                <span className="sd-meta">清除后今日 / 本周的用量会归零，要清除吗？</span>
                <Button size="sm" variant="danger" icon={Trash2} onClick={() => void doClear()}>清除用量记录</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>取消</Button>
              </>
            ) : (
              <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setConfirmClear(true)}>清除用量记录</Button>
            )}
          </div>
        </div>

        {children}
      </div>
    </Panel>
  );
}

function UsageLine({ usage, on }: { usage: UsageSummary | undefined; on: boolean }) {
  if (!usage) return null;
  const part = (label: string, w: UsageSummary['today']) => `${label} ${w.turns} 个回合 · ${w.tokens.toLocaleString('zh-CN')} tokens · ${money(w.costUsd)}`;
  return (
    <p className="sd-meta" role="status">
      <span>{part('今日', usage.today)}</span>
      <span>{part('本周', usage.week)}</span>
      {usage.estimated && <span>含估算或未知的花费</span>}
      {!on && <span>记录已关闭，不再增加</span>}
    </p>
  );
}
