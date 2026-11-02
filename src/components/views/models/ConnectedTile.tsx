/* 「已接入」的一行摘要：徽记 · 名称 · 当前模型与强度 · 状态 · 测试 · 展开。
   已经接好的服务不再一律摊成完整配置卡（每张约 480 px，首屏只看得到一张，几十家服务一家也找不到）：默认是这一行，≥ 860 px 时排成两列；
   点它（或右边的箭头）在原地展开成完整的 ProviderCard，同一时间只展开一个（ModelsView 管）。
   不用 svc-tile 这个类：那是「还没接入」的行（计数、点选、展开的检查都按它数）。 */
import { ChevronRight, Plug, Star } from 'lucide-react';
import { useState } from 'react';
import { EFFORT_LABEL } from '../../../lib/effort';
import { DRIVERS, modelName, type ProviderInfo } from '../../../lib/providers';
import { choiceEfforts, defaultChoice, modelActions } from '../../../state/models';
import { useApp } from '../../../state/store';
import { Badge, Button, cx } from '../../ui';
import { cardStatus } from './cardState';

export function ConnectedTile({ info, disabled, onOpen }: { info: ProviderInfo; disabled: boolean; onOpen: () => void }) {
  const cfg = useApp((s) => s.models.providers[info.id]);
  const models = useApp((s) => s.models);
  const isDefault = useApp((s) => defaultChoice(s.models)?.provider === info.id);
  const [busy, setBusy] = useState(false);
  const st = cardStatus(info, cfg);
  const api = st.auth === 'api';
  const model = api ? cfg.model : cfg.cliModel;
  const levels = choiceEfforts(models, { provider: info.id, auth: st.auth, driver: api ? undefined : cfg.driver }, model);
  const level = api ? cfg.effort : cfg.cliEffort;
  const modelText = api
    ? (cfg.model ? modelName(info, cfg.model) : '还没有选模型')
    : `${DRIVERS[cfg.driver]?.label ?? '命令行'} · ${cfg.cliModel ? modelName(info, cfg.cliModel) : '工具默认模型'}`;
  const effortText = levels.length ? `强度 ${level ? EFFORT_LABEL[level] : '默认'}` : '';
  // amber only for something the person has to do: a failed test, a service that has a key but cannot be used yet
  const needs = st.state === 'off' || st.state === 'error';
  const tone = st.state === 'off' ? 'warning' : st.stateTone;
  const text = st.state === 'off' ? '待处理' : st.stateText;
  const title = st.state === 'off' ? st.ready.reason : st.tested && !st.testing ? st.tested.message : undefined;

  const test = async () => {
    setBusy(true);
    try { await modelActions.test(info.id, st.auth); } finally { setBusy(false); }
  };

  return (
    <div className={cx('conn-tile', `conn-tile--${st.state}`)} data-service={info.id} data-provider-row={info.id}>
      <button type="button" className="conn-tile__main" aria-expanded={false} aria-label={`${info.name}：${modelText}${effortText ? `，${effortText}` : ''}，${text}。展开设置`} onClick={onOpen}>
        <span className="conn-tile__glyph" aria-hidden>{info.glyph}</span>
        <span className="conn-tile__text">
          <b>{info.name}</b>
          <small title={`${modelText}${effortText ? ` · ${effortText}` : ''}`}>
            <span className="truncate">{modelText}</span>
            {effortText && <span className="conn-tile__effort">{effortText}</span>}
          </small>
        </span>
      </button>
      <span className="conn-tile__marks">
        {isDefault && <Badge tone="running" title="新建闲聊和工作时默认选它"><Star size={11} aria-hidden />默认</Badge>}
        <Badge tone={tone} title={title}>{text}</Badge>
      </span>
      <Button size="sm" variant="ghost" icon={Plug} busy={busy} disabled={disabled || !st.ready.ready || busy} onClick={() => void test()}
        title={needs && st.ready.reason ? st.ready.reason : '测试一次连接'}>测试</Button>
      <button type="button" className="conn-tile__open" aria-hidden tabIndex={-1} onClick={onOpen}><ChevronRight size={16} aria-hidden /></button>
    </div>
  );
}
