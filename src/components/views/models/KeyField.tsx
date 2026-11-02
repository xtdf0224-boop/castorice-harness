/* API Key 输入：只写不读。保存之后只显示末四位（密钥由系统加密保存在桌面端，从不回到页面）。
   一把密钥属于一个槽（服务，或服务 + 地区）：国内站、国际站、套餐的 Key 互不通用，标题里写明是哪个地区的。
   可空密钥的服务（本机）会说明「通常不需要」；没有取密钥的页面时，链接写「官方文档」。 */
import { ExternalLink, KeyRound, Pencil, Trash2 } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import type { ProviderInfo } from '../../../lib/providers';
import type { ProviderConfig } from '../../../lib/types';
import { modelActions } from '../../../state/models';
import { Button } from '../../ui';

export function KeyField({ info, cfg, disabled, label, regionLabel }: { info: ProviderInfo; cfg: ProviderConfig; disabled: boolean; label?: string; regionLabel?: string }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const show = !cfg.keyHint || editing;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!value.trim()) return;
    setSaving(true);
    const done = await modelActions.saveKey(info.id, value.trim());
    setSaving(false);
    if (done) { setValue(''); setEditing(false); }
  };
  const title = label ?? `${info.keyOptional ? '密钥（可不填）' : '密钥'}${regionLabel ? `（${regionLabel}）` : ''}`;
  const link = info.def.keyUrl ? { href: info.def.keyUrl, text: '去获取密钥' } : info.docsUrl ? { href: info.docsUrl, text: '官方文档' } : undefined;
  return (
    <div className="model-field">
      <span className="model-field__label" id={`${id}-l`}>{title}</span>
      {show ? (
        <form className="model-key" onSubmit={save}>
          <input className="input mono" type="password" aria-labelledby={`${id}-l`} value={value} disabled={disabled} autoComplete="off" spellCheck={false}
            placeholder={info.keyOptional ? '粘贴密钥（没开认证可留空）' : '粘贴密钥'} onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" busy={saving} disabled={disabled || !value.trim()}>保存</Button>
          {cfg.keyHint && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(''); }}>取消</Button>}
        </form>
      ) : (
        <div className="model-key model-key--saved">
          <KeyRound size={14} aria-hidden />
          <span className="mono">已保存 {cfg.keyHint}</span>
          <Button size="sm" variant="ghost" icon={Pencil} disabled={disabled} onClick={() => setEditing(true)}>更换</Button>
          <Button size="sm" variant="ghost" icon={Trash2} disabled={disabled} onClick={() => void modelActions.clearKey(info.id)}>删除</Button>
        </div>
      )}
      <p className="model-field__hint">
        {info.keyHelp}{link && ' '}
        {link && <a href={link.href} target="_blank" rel="noreferrer">{link.text}<ExternalLink size={11} aria-hidden /></a>}
      </p>
    </div>
  );
}
