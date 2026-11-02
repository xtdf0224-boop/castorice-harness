/* 设置 › 信任的目录（V0α · 模块 B5「安全」）：列出 T1/T2 目录，可撤销，可添加。SettingsView（B4）渲染它.
   本组件自带 Panel（跨整行），SettingsView 里不需要再包一层. */
import { FolderPlus, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import '../../../styles/security-trust.css';
import { desktop } from '../../../lib/desktop';
import { getTrustBridge, type TrustEntry } from '../../../lib/trustBridge';
import { forgetSessionReadOnly, requestTrust } from '../../../state/trustGate';
import { Button, Panel } from '../../ui';
import { TrustList, entryName } from './TrustList';

export function TrustSection() {
  const bridge = getTrustBridge();
  const [entries, setEntries] = useState<TrustEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const refresh = useCallback(async () => {
    const b = getTrustBridge();
    if (!b) return;
    try {
      const r = await b.list();
      if (!alive.current) return;
      if (r.ok) { setEntries(r.entries); setError(null); } else { setEntries([]); setError(r.error); }
    } catch (e) {
      if (alive.current) { setEntries([]); setError(e instanceof Error ? e.message : String(e)); }
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const revoke = async (entry: TrustEntry) => {
    const b = getTrustBridge();
    if (!b) return;
    setBusyKey(entry.key); setNote('');
    try {
      const r = await b.revoke(entry.key);
      if (!alive.current) return;
      if (r.ok) {
        forgetSessionReadOnly(entry.key);
        setNote(`已撤销「${entryName(entry)}」。正在运行的任务不受影响；下次在那里开始工作，我会重新问一声。`);
      } else setNote(`撤销没有成功：${r.error ?? '未知原因'}`);
    } catch (e) {
      if (alive.current) setNote(`撤销没有成功：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (alive.current) setBusyKey(null);
      void refresh();
    }
  };

  const add = async () => {
    if (!desktop) return;
    setNote('');
    const dir = await desktop.pickFolder();
    if (!dir) return;
    const level = await requestTrust(dir, { force: true });
    if (!alive.current) return;
    setNote(level === 'T1' || level === 'T2' ? '已信任。' : level === 'T0' ? '保持只读。' : '');
    void refresh();
  };

  return (
    <Panel className="settings-span trust-section" label="安全" title="信任的目录" icon={ShieldCheck} energy
      actions={desktop ? <Button size="sm" variant="secondary" icon={FolderPlus} onClick={() => void add()}>添加目录…</Button> : undefined}>
      <p className="trust-section__intro">
        新目录默认只读：我可以读文件、回答问题，但不会写入，也不会运行命令。信任过的目录在这里；撤销之后回到只读。
        仓库自带的钩子、MCP 与技能配置，在任何一档都不会被加载。
      </p>
      {!bridge && <p className="trust-list__empty">需要桌面版才能管理信任的目录。</p>}
      {bridge && entries === null && <p className="trust-list__empty">正在读取……</p>}
      {bridge && entries !== null && <TrustList entries={entries} busyKey={busyKey} onRevoke={(e) => void revoke(e)} />}
      {error && <p className="trust-dialog__error" role="alert">读取信任记录时出了问题：{error}</p>}
      <p className="trust-section__note" role="status" aria-live="polite">{note}</p>
    </Panel>
  );
}
