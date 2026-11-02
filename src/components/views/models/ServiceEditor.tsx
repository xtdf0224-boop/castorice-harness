/* 添加 / 编辑自定义服务的对话框（MODELS-SPEC §9、§14.5）。
   任何有 OpenAI Chat 或 Anthropic Messages 兼容端点的服务——中转站、公司网关、没做预设的小厂、本机另一个端口的 Ollama——都能接：
   名称、服务地址、鉴权、密钥、模型即可。表单里的校验只是体验：保存时主进程把整份定义重新校验，换主机 / 内网地址 / 首次存密钥
   会弹原生确认（页面按不到）。地址是某家的套餐地址时红字说明并拒绝（套餐 Key 只能给命令行工具用）。 */
import { Check, CircleAlert, Plus, RefreshCw, Save, ShieldCheck, Trash2, X } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import type { Effort } from '../../../lib/effort';
import { EFFORT_LABEL } from '../../../lib/effort';
import type { ServiceDef } from '../../../lib/services';
import { modelActions } from '../../../state/models';
import { refreshModelList, saveCustomService } from '../../../state/services';
import { useApp } from '../../../state/store';
import { Button, Dialog, IconButton, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { ChoiceTabs } from './ChoiceTabs';
import { EFFORT_KINDS, LEVELS, SCHEMES, defToForm, emptyForm, emptyModelRow, formFieldOf, formToDef, previewGrade, validateForm, type EditorForm, type EffortKind, type ModelRow, type Scheme } from './editor';
import { GradeBadges } from './ServiceTile';

const MAX_ROWS = 50;

function FieldError({ id, text }: { id: string; text?: string }) {
  return text ? <p className="model-field__hint model-field__hint--bad" id={id} role="alert"><CircleAlert size={12} aria-hidden />{text}</p> : null;
}

export function ServiceEditor({ def, protocol, onClose, onSaved }: {
  /** Editing an existing custom service. */
  def?: ServiceDef;
  /** A new service: which protocol the 「添加服务」 menu chose. */
  protocol?: 'openai-chat' | 'anthropic';
  onClose: () => void;
  /** After the service (and its key) are saved. `test`: the 「保存并测试」 button. */
  onSaved?: (id: string, test: boolean) => void;
}) {
  const ids = useId();
  const [form, setForm] = useState<EditorForm>(() => (def ? defToForm(def) : emptyForm(protocol)));
  const [saved, setSaved] = useState<ServiceDef | undefined>();
  const editing = def ?? saved;
  const [server, setServer] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'' | 'save' | 'test'>('');
  const [listing, setListing] = useState(false);
  const keyHint = useApp((s) => (editing ? s.models.providers[editing.id]?.keyHint : undefined));
  const live = useApp((s) => (editing ? s.models.liveApi?.[editing.id] : undefined));
  const check = useMemo(() => validateForm(form), [form]);
  const grade = useMemo(() => previewGrade(form), [form]);
  const set = <K extends keyof EditorForm>(k: K, v: EditorForm[K]) => { setForm((f) => ({ ...f, [k]: v })); setServer({}); };
  const setRow = (i: number, patch: Partial<ModelRow>) => { setForm((f) => ({ ...f, models: f.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) })); setServer({}); };
  const err = (field: string, show = true) => (show ? (server[field] ?? check.errors[field]) : server[field]);

  const onProtocol = (p: EditorForm['protocol']) => {
    if (p === form.protocol) return;
    setForm((f) => ({
      ...f, protocol: p,
      // the usual header of the new protocol, unless the person chose another one
      scheme: f.scheme === 'bearer' && p === 'anthropic' ? 'x-api-key' : f.scheme === 'x-api-key' && p === 'openai-chat' ? 'bearer' : f.scheme,
      compatUrl: p === 'anthropic' ? '' : f.compatUrl,
      // changing the protocol clears the models' reasoning settings (their spelling belongs to the protocol)
      models: f.models.map((m) => ({ ...m, effort: 'none' as EffortKind, levels: [], canOff: false, effortField: false })),
    }));
    setServer({});
  };

  const blocker = Object.values(check.errors)[0];
  const submit = async (andTest: boolean) => {
    if (!check.ok) return;
    setBusy(andTest ? 'test' : 'save');
    setServer({});
    const r = await saveCustomService(formToDef(form, editing));
    if (!r.ok) { setServer({ [formFieldOf(r.field)]: r.error }); setBusy(''); return; }
    setSaved(r.value);
    if (form.key.trim()) {
      const ok = await modelActions.saveKey(r.value.id, form.key.trim());
      if (!ok) { setServer({ key: '服务已保存，但密钥没能保存（见提示）。可以再试一次，或稍后在卡片里保存密钥。' }); setBusy(''); return; }
    }
    setBusy('');
    onSaved?.(r.value.id, andTest);
    onClose();
  };

  const addable = (live ?? []).filter((m) => !form.models.some((r) => r.id === m.id)).slice(0, 400);
  const fetchList = async () => {
    if (!editing) return;
    setListing(true);
    try { await refreshModelList(editing.id, { fresh: true }); } finally { setListing(false); }
  };

  const urlLine = check.url.ok && form.baseUrl.trim();
  const effortOptions = EFFORT_KINDS.filter((k) => k.value !== 'anthropic' || form.protocol === 'anthropic');

  return (
    <Dialog title={def ? `编辑 · ${def.name}` : `添加服务 · 自定义 ${form.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI'} 兼容`} icon={Plus} onClose={onClose}
      footer={(
        <>
          {!check.ok && blocker && <span className="svc-editor__blocker" role="status">还不能保存：{blocker}</span>}
          <Button variant="ghost" onClick={onClose}>取消</Button>
          {!def && <Button variant="secondary" disabled={!check.ok || !!busy} busy={busy === 'test'} onClick={() => void submit(true)}>保存并测试</Button>}
          <Button variant="primary" icon={Save} disabled={!check.ok || !!busy} busy={busy === 'save'} onClick={() => void submit(false)}>保存</Button>
        </>
      )}>
      <form className="svc-editor" onSubmit={(e) => { e.preventDefault(); void submit(false); }} noValidate>
        {err('_form') && <p className="model-field__hint model-field__hint--bad" role="alert">{err('_form')}</p>}

        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-name`}>名称</label>
          <input id={`${ids}-name`} className={cx('input', err('name', !!form.name.trim()) && 'is-invalid')} value={form.name} maxLength={60} autoComplete="off" data-autofocus
            placeholder="例如 我的中转站" aria-invalid={!!err('name', !!form.name.trim()) || undefined} onChange={(e) => set('name', e.target.value)} />
          <FieldError id={`${ids}-name-e`} text={err('name', !!form.name.trim())} />
        </div>

        <div className="model-field">
          <span className="model-field__label">协议</span>
          <ChoiceTabs<EditorForm['protocol']> size="sm" label="协议" value={form.protocol} onChange={onProtocol}
            options={[{ value: 'openai-chat', label: 'OpenAI 兼容', hint: '/chat/completions' }, { value: 'anthropic', label: 'Anthropic 兼容', hint: '/v1/messages' }]} />
        </div>

        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-url`}>服务地址</label>
          <input id={`${ids}-url`} className={cx('input mono', err('baseUrl', !!form.baseUrl.trim()) && 'is-invalid')} value={form.baseUrl} spellCheck={false} autoComplete="off"
            placeholder={form.protocol === 'anthropic' ? 'https://api.example.com' : 'https://api.example.com/v1'} aria-invalid={!!err('baseUrl', !!form.baseUrl.trim()) || undefined}
            aria-describedby={`${ids}-url-note`} onChange={(e) => set('baseUrl', e.target.value)} />
          <div id={`${ids}-url-note`}>
            <FieldError id={`${ids}-url-e`} text={err('baseUrl', !!form.baseUrl.trim())} />
            {urlLine && !err('baseUrl') && (
              <p className="model-field__hint svc-editor__ok"><ShieldCheck size={12} aria-hidden />
                {check.url.local ? `本机 http · ${check.url.host}` : `https · 主机 ${check.url.host}`}。密钥只会发往 {check.url.host}；以后换地址会再问你。
              </p>
            )}
            {check.warnings.map((w) => <p key={w} className="model-field__hint model-field__hint--warn">{w}</p>)}
          </div>
        </div>

        {form.protocol === 'openai-chat' && (
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-compat`}>Anthropic 兼容地址<span className="model-field__opt">（可选，填了才能「干活」，标「实验」）</span></label>
            <input id={`${ids}-compat`} className={cx('input mono', err('compatUrl', !!form.compatUrl.trim()) && 'is-invalid')} value={form.compatUrl} spellCheck={false} autoComplete="off"
              placeholder="https://api.example.com/anthropic" aria-invalid={!!err('compatUrl', !!form.compatUrl.trim()) || undefined} onChange={(e) => set('compatUrl', e.target.value)} />
            <FieldError id={`${ids}-compat-e`} text={err('compatUrl', !!form.compatUrl.trim())} />
          </div>
        )}

        <div className="svc-editor__auth">
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-scheme`}>鉴权</label>
            <MenuSelect<Scheme> variant="field" id={`${ids}-scheme`} label="鉴权" value={form.scheme} search={false} minWidth={320}
              options={SCHEMES.filter((s) => s.value !== 'both' || form.protocol === 'anthropic').map((s) => ({ value: s.value, label: s.label, sub: s.sub }))} onChange={(v) => set('scheme', v)} />
            {form.scheme === 'header' && (
              <input className={cx('input mono', err('header') && 'is-invalid')} aria-label="鉴权头的名字" value={form.header} spellCheck={false} autoComplete="off" placeholder="头的名字，例如 X-Api-Token"
                aria-invalid={!!err('header') || undefined} onChange={(e) => set('header', e.target.value)} />
            )}
            <FieldError id={`${ids}-hdr-e`} text={err('header', !!form.header.trim())} />
          </div>
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-key`}>密钥</label>
            {editing && keyHint && !form.key ? (
              <p className="model-key model-key--saved"><Check size={14} aria-hidden /><span className="mono">已保存 {keyHint}</span><span className="model-field__opt">要换的话在下面粘贴新的</span></p>
            ) : null}
            <input id={`${ids}-key`} className="input mono" type="password" value={form.key} autoComplete="off" spellCheck={false} disabled={form.scheme === 'none'}
              placeholder={form.scheme === 'none' ? '这个服务不需要密钥' : editing && keyHint ? '粘贴新的密钥（不填就不改）' : form.keyOptional ? '粘贴密钥（没开认证可留空）' : '粘贴密钥'} onChange={(e) => set('key', e.target.value)} />
            <label className="svc-editor__check">
              <input type="checkbox" checked={form.keyOptional || form.scheme === 'none'} disabled={form.scheme === 'none'} onChange={(e) => set('keyOptional', e.target.checked)} />
              不需要密钥（仅本机地址）
            </label>
            <FieldError id={`${ids}-auth-e`} text={err('auth') ?? err('key')} />
          </div>
        </div>

        <div className="model-field">
          <span className="model-field__label" id={`${ids}-models`}>模型</span>
          <div className="svc-models" role="group" aria-labelledby={`${ids}-models`}>
            <div className="svc-models__head" aria-hidden><span>ID</span><span>上下文</span><span>推理强度写法</span><span /></div>
            {form.models.slice(0, MAX_ROWS).map((m, i) => (
              <div key={i} className="svc-models__row">
                <div className="svc-models__cell">
                  <input className={cx('input mono', err(`model-${i}`, !!m.id.trim()) && 'is-invalid')} aria-label={`第 ${i + 1} 个模型的 ID`} value={m.id} spellCheck={false} autoComplete="off"
                    placeholder={i === 0 ? '例如 gpt-6.1-sol' : '模型 ID'} aria-invalid={!!err(`model-${i}`, !!m.id.trim()) || undefined} onChange={(e) => setRow(i, { id: e.target.value.trim() })} />
                </div>
                <div className="svc-models__cell">
                  <input className={cx('input mono', err(`ctx-${i}`) && 'is-invalid')} aria-label={`第 ${i + 1} 个模型的上下文窗口`} value={m.ctx} inputMode="numeric" autoComplete="off"
                    placeholder={check.local ? '8192' : '128000'} onChange={(e) => setRow(i, { ctx: e.target.value.trim() })} />
                </div>
                <div className="svc-models__cell">
                  <MenuSelect<EffortKind> variant="field" label={`第 ${i + 1} 个模型的推理强度写法`} value={m.effort} search={false} minWidth={320}
                    options={effortOptions.map((k) => ({ value: k.value, label: k.label, sub: k.sub }))} onChange={(v) => setRow(i, { effort: v, levels: v === 're' || v === 're-think' || v === 'anthropic' || v === 'enable-thinking' ? (m.levels.length ? m.levels : ['low', 'medium', 'high']) : [] })} />
                </div>
                <IconButton icon={Trash2} label={`删除第 ${i + 1} 行`} size="sm" disabled={form.models.length === 1} onClick={() => set('models', form.models.filter((_, j) => j !== i))} />
                {(err(`model-${i}`, !!m.id.trim()) || err(`ctx-${i}`) || err(`maxOut-${i}`)) && (
                  <div className="svc-models__err"><FieldError id={`${ids}-m${i}-e`} text={err(`model-${i}`, !!m.id.trim()) ?? err(`ctx-${i}`) ?? err(`maxOut-${i}`)} /></div>
                )}
                {(m.effort === 're' || m.effort === 're-think' || m.effort === 'anthropic' || m.effort === 'enable-thinking') && (
                  <div className="svc-models__effort" role="group" aria-label={`第 ${i + 1} 个模型支持的档位`}>
                    {LEVELS.map((l: Exclude<Effort, 'off' | 'ultra'>) => (
                      <button key={l} type="button" className={cx('svc-level', m.levels.includes(l) && 'is-on')} aria-pressed={m.levels.includes(l)}
                        onClick={() => setRow(i, { levels: m.levels.includes(l) ? m.levels.filter((x) => x !== l) : [...m.levels, l] })}>
                        {m.levels.includes(l) && <Check size={11} aria-hidden />}{EFFORT_LABEL[l]}
                      </button>
                    ))}
                    <label className="svc-editor__check"><input type="checkbox" checked={m.canOff} onChange={(e) => setRow(i, { canOff: e.target.checked })} />支持关闭思考</label>
                    {m.effort === 'enable-thinking' && <label className="svc-editor__check"><input type="checkbox" checked={m.effortField} onChange={(e) => setRow(i, { effortField: e.target.checked })} />开启时同时带 reasoning_effort</label>}
                  </div>
                )}
              </div>
            ))}
            {form.models.length > MAX_ROWS && <p className="model-field__hint">还有 {form.models.length - MAX_ROWS} 个模型没有在这里列出，它们会原样保留。</p>}
          </div>
          <FieldError id={`${ids}-models-e`} text={err('models', false)} />
          <div className="svc-models__actions">
            <Button size="sm" variant="ghost" icon={Plus} disabled={form.models.length >= MAX_ROWS} onClick={() => set('models', [...form.models, emptyModelRow()])}>一行</Button>
            {editing && editing.modelsApi && (
              <>
                <Button size="sm" variant="ghost" icon={RefreshCw} busy={listing} onClick={() => void fetchList()}>拉取模型列表</Button>
                {addable.length > 0 && (
                  <MenuSelect<string> variant="chip" label="从列表添加模型" value="" display="从列表添加…" maxRows={100} searchable minWidth={320}
                    options={addable.map((m) => ({ value: m.id, label: m.label ?? m.id, sub: m.label ? m.id : undefined }))}
                    onChange={(id) => { if (id) setForm((f) => ({ ...f, models: [...f.models.filter((r) => r.id.trim() || r.ctx.trim()), emptyModelRow(id)] })); }} />
                )}
              </>
            )}
            {!editing && <span className="model-field__opt">保存后，在服务卡片里点模型选择的「刷新」可以拉取列表。</span>}
          </div>
        </div>

        <details className="model-adv svc-editor__adv">
          <summary>高级：输出上限字段 · 额外请求头 · 额外请求体 · 思考文字位置</summary>
          <div className="model-field">
            <span className="model-field__label">输出上限字段</span>
            <MenuSelect<EditorForm['maxTokensField']> variant="field" label="输出上限字段" value={form.maxTokensField} search={false}
              options={[{ value: 'auto', label: 'auto', sub: '先发 max_tokens；服务说要换就换一次（默认，不知道选哪个就选它）' }, { value: 'max_tokens', label: 'max_tokens' }, { value: 'max_completion_tokens', label: 'max_completion_tokens' }]} onChange={(v) => set('maxTokensField', v)} />
          </div>
          <div className="model-field">
            <span className="model-field__label">额外请求头<span className="model-field__opt">（最多 8 项）</span></span>
            {form.headers.map((h, i) => (
              <div key={i} className="svc-hdr">
                <input className={cx('input mono', err(`header-${i}`) && 'is-invalid')} aria-label={`第 ${i + 1} 个请求头的名字`} value={h.name} placeholder="名字" spellCheck={false} autoComplete="off"
                  onChange={(e) => set('headers', form.headers.map((x, j) => (j === i ? { ...x, name: e.target.value.trim() } : x)))} />
                <input className="input mono" aria-label={`第 ${i + 1} 个请求头的值`} value={h.value} placeholder="值" spellCheck={false} autoComplete="off"
                  onChange={(e) => set('headers', form.headers.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <IconButton icon={X} label={`删除第 ${i + 1} 个请求头`} size="sm" onClick={() => set('headers', form.headers.filter((_, j) => j !== i))} />
                <FieldError id={`${ids}-h${i}-e`} text={err(`header-${i}`)} />
              </div>
            ))}
            <FieldError id={`${ids}-hs-e`} text={err('headers')} />
            <div><Button size="sm" variant="ghost" icon={Plus} disabled={form.headers.length >= 8} onClick={() => set('headers', [...form.headers, { name: '', value: '' }])}>请求头</Button></div>
          </div>
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-xb`}>额外请求体（JSON）</label>
            <textarea id={`${ids}-xb`} className={cx('textarea mono', err('extraBody') && 'is-invalid')} rows={3} value={form.extraBody} spellCheck={false} placeholder={'{"reasoning_format": "parsed"}'}
              aria-invalid={!!err('extraBody') || undefined} onChange={(e) => set('extraBody', e.target.value)} />
            <FieldError id={`${ids}-xb-e`} text={err('extraBody')} />
            <p className="model-field__hint model-field__hint--warn">这些字段会原样发往你填写的地址。model、messages、stream、tools、max_tokens 这类由栖枝决定的字段不能写。</p>
          </div>
          <div className="model-field">
            <span className="model-field__label">思考文字出现的位置<span className="model-field__opt">（默认自动：reasoning_content / reasoning / &lt;think&gt;）</span></span>
            <label className="svc-editor__check"><input type="checkbox" checked={form.thinkReasoningDetails} onChange={(e) => set('thinkReasoningDetails', e.target.checked)} />也看 reasoning_details</label>
            <label className="svc-editor__check"><input type="checkbox" checked={form.thinkContentParts} onChange={(e) => set('thinkContentParts', e.target.checked)} />content 可能是数组（Mistral 式，数组里的正文不会丢）</label>
          </div>
        </details>

        <div className="svc-editor__preview" role="group" aria-label="能力预览">
          <span className="model-field__label">能力预览</span>
          <GradeBadges grade={grade} size="md" showAll />
          <ul className="svc-editor__why">
            {grade.work === 'no' && grade.why.work && <li>干活：{grade.why.work}。要干活，请再填 Anthropic 兼容地址，或选一个命令行代理。</li>}
            {grade.work === 'experimental' && <li>干活：填了 Anthropic 兼容地址，可以经 Claude Code 干活，但厂商没有官方支持，标为实验。</li>}
            {!grade.tune && <li>强度：没有给模型指定推理强度写法，所以不调节（宁可不调，也不乱发）。</li>}
            {!grade.chat && grade.why.chat && <li>聊天：{grade.why.chat}。</li>}
          </ul>
        </div>
      </form>
    </Dialog>
  );
}
