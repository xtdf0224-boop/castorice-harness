/* One service on 模型接入: choose 「命令行登录」 or 「API 密钥」, set it up, pick its model and 推理强度, test it.
   The key field is write-only — after saving, only its last four characters are ever shown.

   The first release's eight cards look and work as before; what the rework adds (MODELS-SPEC §14.4): badges for a plan channel / experimental /
   unchecked facts and the date the entry was last checked, a way tab that disables 「API 密钥」 on a plan channel (a plan key is only for the vendor's own
   command-line tools), the region and {placeholder} fields, the model picker, the test result step by step, and — for a custom service — 编辑 / 删除. */
import { CheckCircle2, ChevronUp, CircleHelp, KeyRound, Pencil, Plug, Star, Terminal, Trash2, XCircle } from 'lucide-react';
import { useState, useSyncExternalStore } from 'react';
import { regionOf, type ProviderInfo } from '../../../lib/providers';
import { gradeOf, type TestStep } from '../../../lib/services';
import type { AuthMode } from '../../../lib/types';
import { choiceEfforts, claudeAuthSnapshot, defaultChoice, modelActions, subscribeClaudeAuth } from '../../../state/models';
import { removeCustomService, tasksUsing } from '../../../state/services';
import { useApp } from '../../../state/store';
import { Badge, Button, Dialog, IconButton, cx } from '../../ui';
import { ApiPane, CliPane } from './CardPanes';
import { cardStatus } from './cardState';
import { ChoiceTabs } from './ChoiceTabs';
import { EndpointField } from './EndpointField';
import { ServiceEditor } from './ServiceEditor';
import { GradeBadges } from './ServiceTile';

function ago(at: number) {
  const s = Math.round((Date.now() - at) / 1000);
  return s < 60 ? '刚刚' : s < 3600 ? `${Math.round(s / 60)} 分钟前` : `${Math.round(s / 3600)} 小时前`;
}

const STEP_LABEL: Record<TestStep['name'], string> = { models: '拉列表', chat: '对话', cli: '命令行' };
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;

/** 「核实于 10-24」, in the warning tone once it is more than 14 days old (the catalog may be behind). */
function verifiedBadge(verified: string, now = Date.now()) {
  const t = Date.parse(verified);
  if (!Number.isFinite(t) || verified === '1970-01-01') return null;
  const old = now - t > 14 * 86_400_000;
  return { text: `核实于 ${verified.slice(5)}`, old };
}

export function ProviderCard({ info, disabled, onCollapse }: { info: ProviderInfo; disabled: boolean; onCollapse?: () => void }) {
  const cfg = useApp((s) => s.models.providers[info.id]);
  const models = useApp((s) => s.models);
  // The service new tasks start with, as 「新建时默认使用」 shows it (the first ready one when none is set).
  const isDefault = useApp((s) => defaultChoice(s.models)?.provider === info.id);
  const [busy, setBusy] = useState<'' | 'test' | 'detect'>('');
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  // Claude 走了 API 密钥路径：卡片上明示「API 计费」
  const apiBilling = useSyncExternalStore(subscribeClaudeAuth, () => claudeAuthSnapshot()?.config.mode === 'apikey', () => false) && info.id === 'claude';

  const region = regionOf(info, cfg);
  const planRegion = region.kind === 'plan';
  const apiBlocked = planRegion ? '套餐 Key 只能给命令行编码工具用，不能直接调用 API' : !region.baseUrl ? '这个地区没有 API 地址，只能用命令行方式' : undefined;
  const { auth, ready, tested, testing, state, stateText, stateTone } = cardStatus(info, cfg);
  const steps = tested?.steps;
  const grade = gradeOf(info.def, {
    endpoint: cfg.region, keySaved: !!cfg.keyHint, model: auth === 'api' ? cfg.model : cfg.cliModel || cfg.model,
    levels: choiceEfforts(models, { provider: info.id, auth, driver: auth === 'cli' ? cfg.driver : undefined }, auth === 'api' ? cfg.model : cfg.cliModel),
  });
  const ver = verifiedBadge(info.verified);
  const custom = info.kind === 'custom';

  const run = async (kind: 'test' | 'detect') => {
    setBusy(kind);
    try { await (kind === 'test' ? modelActions.test(info.id, auth) : modelActions.detect(info.id)); } finally { setBusy(''); }
  };

  const authOptions = [
    ...(info.drivers.length ? [{ value: 'cli' as AuthMode, label: '命令行登录', icon: Terminal, hint: '用官方命令行工具（Claude Code、Codex…）登录账号后驱动它' }] : []),
    { value: 'api' as AuthMode, label: 'API 密钥', icon: KeyRound, hint: apiBlocked ?? '用这家的 API Key 直接调用接口', disabled: !!apiBlocked },
  ];

  return (
    <article className={cx('panel model-card', `model-card--${state}`)} aria-labelledby={`model-${info.id}`} data-provider={info.id}>
      <header className="model-card__head">
        <span className="model-card__glyph" aria-hidden>{info.glyph}</span>
        <div className="model-card__title">
          <h2 id={`model-${info.id}`} tabIndex={-1}>{info.name}</h2>
          <p>{info.vendor}{ver && <span className={cx('model-card__ver', ver.old && 'is-old')} title={ver.old ? '超过 14 天没有对照官方文档核对，目录可能过时' : '最后一次对照官方文档核对的日期'}> · {ver.text}</span>}</p>
        </div>
        <span className="model-card__badges">
          {isDefault && <Badge tone="running" title="新建闲聊和工作时默认选它"><Star size={11} aria-hidden />默认</Badge>}
          {apiBilling && <Badge tone="warning" title="Claude 现在走 API 密钥路径，按用量计费">API 计费</Badge>}
          {planRegion && <Badge tone="neutral" title="套餐 Key 只能给命令行编码工具用，不能直接调用 API。">套餐</Badge>}
          {auth === 'cli' && region.experimental && cfg.driver === 'claude-compat' && <Badge tone="info" title="厂商没有官方支持把 Claude Code 接到这里，标为实验。">实验</Badge>}
          {info.unverified.length > 0 && (
            <span className="svc-unverified" role="img" aria-label="有几项还没有逐项核实" title={`还没有逐项核实：\n${info.unverified.map((u) => `· ${u}`).join('\n')}`}><CircleHelp size={14} aria-hidden /></span>
          )}
          <Badge tone={stateTone}>{stateText}</Badge>
          {onCollapse && <IconButton icon={ChevronUp} label={`收起 ${info.name}`} size="sm" onClick={onCollapse} />}
        </span>
      </header>
      <GradeBadges grade={grade} showAll />

      <ChoiceTabs<AuthMode> size="sm" className="model-card__auth" label={`${info.name} 的接入方式`} options={authOptions} value={auth}
        onChange={(v) => modelActions.set(info.id, { auth: v })} />

      <div className="model-card__body">
        {auth === 'cli'
          ? <CliPane info={info} cfg={cfg} models={models} disabled={disabled} busy={busy === 'detect'} onDetect={() => run('detect')} />
          : apiBlocked
            ? (
              <div className="model-pane">
                <EndpointField info={info} cfg={cfg} disabled={disabled} />
                <div className="callout callout--warning" role="note">
                  <KeyRound size={18} aria-hidden className="callout__icon" />
                  <div className="callout__body">
                    <p className="callout__text">{apiBlocked}。{planRegion && info.regions.some((r) => r.kind !== 'plan' && r.baseUrl) ? '要用 API，请先把服务地区换成按量计费的那一项。' : ''}</p>
                  </div>
                  {info.drivers.length > 0 && <div className="callout__actions"><Button size="sm" variant="secondary" icon={Terminal} onClick={() => modelActions.set(info.id, { auth: 'cli' })}>改用命令行方式</Button></div>}
                </div>
              </div>
            )
            : <ApiPane info={info} cfg={cfg} models={models} disabled={disabled} />}
      </div>

      {custom && (
        <p className="model-card__custom">
          <span>这是你添加的服务。</span>
          <Button size="sm" variant="ghost" icon={Pencil} disabled={disabled} onClick={() => setEditing(true)}>编辑</Button>
          <Button size="sm" variant="ghost" icon={Trash2} disabled={disabled} onClick={() => setDeleting(true)}>删除</Button>
        </p>
      )}

      <footer className="model-card__foot">
        <div className="model-card__result" role="status">
          {!ready.ready && <span className="model-card__muted">{ready.reason}</span>}
          {ready.ready && !tested && <span className="model-card__muted">已配置，建议测试一次连接。</span>}
          {tested && testing && <span className="model-card__muted">测试中…</span>}
          {tested && !testing && (
            <span className={cx('model-card__test', tested.ok ? 'is-ok' : 'is-bad')} title={tested.message}>
              {tested.ok ? <CheckCircle2 size={14} aria-hidden /> : <XCircle size={14} aria-hidden />}
              <span className="truncate">{tested.ok ? `连接正常 · ${seconds(tested.ms)} · ${tested.message}` : tested.message}</span>
              <span className="model-card__when">{ago(tested.at)}</span>
            </span>
          )}
          {tested && !testing && steps && steps.length > 0 && (
            <span className="model-card__steps">
              {steps.map((s) => (
                <span key={s.name} className={cx('model-card__step', s.ok ? 'is-ok' : 'is-bad')} title={s.detail}>
                  {STEP_LABEL[s.name]} {s.ok ? '✓' : '✗'} {seconds(s.ms)}
                </span>
              ))}
            </span>
          )}
        </div>
        <div className="model-card__actions">
          {!isDefault && ready.ready && <Button size="sm" variant="ghost" icon={Star} onClick={() => modelActions.setDefault(info.id)}>设为默认</Button>}
          <Button size="sm" variant="secondary" icon={Plug} busy={busy === 'test'} disabled={disabled || !ready.ready || !!busy} onClick={() => run('test')}>测试连接</Button>
        </div>
      </footer>

      {editing && <ServiceEditor def={info.def} onClose={() => setEditing(false)} />}
      {deleting && <DeleteService info={info} onClose={() => setDeleting(false)} />}
    </article>
  );
}

/** 删除自定义服务：同时清除它保存的密钥、置顶的模型和缓存的列表；有任务在用它时先说条数——任务留着、可读，不能再发. */
function DeleteService({ info, onClose }: { info: ProviderInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const n = tasksUsing(info.id);
  const go = async () => {
    setBusy(true);
    const r = await removeCustomService(info.id);
    if (r.ok) onClose(); else { setError(r.error); setBusy(false); }
  };
  return (
    <Dialog title={`删除「${info.name}」？`} tone="warning" icon={Trash2} onClose={onClose}
      footer={<><Button variant="ghost" onClick={onClose} data-autofocus>取消</Button><Button variant="danger" icon={Trash2} busy={busy} onClick={() => void go()}>删除</Button></>}>
      <p>会一起清掉它保存的密钥、置顶的模型和缓存的模型列表，这些不能恢复。</p>
      {n > 0
        ? <p>有 {n} 个任务用着它：任务会留下，仍然可以读，但不能再往下发消息，它们的头部会写「（已删除）」。</p>
        : <p>现在没有任务在用它。</p>}
      {error && <p className="model-field__hint model-field__hint--bad" role="alert">{error}</p>}
    </Dialog>
  );
}
