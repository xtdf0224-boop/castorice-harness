/* 设置 › 桌宠（docs/PET-PLAN.md §3，从萤火的 PetSettings.tsx + petInput.ts 移植）：一个分区，插在「信任」前面.
   除了语音服务的密钥（直接交给桌面端的主进程，保存后不再回来），其余都是 store 里普通的 settings.pet.
   她是谁、说什么都不在这里定；这里只管：开不开、看不看画面、用哪个模型、读不读出来、热键、名单、实时陪玩. 默认全关. */
import {
  Cpu, ExternalLink, Eye, Info, Keyboard, KeyRound, ListFilter, MessageCircle, PawPrint, Pencil, Play, Plus, Radio, RefreshCw, RotateCcw, ShieldCheck, Trash2, TriangleAlert, Volume2, X,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useId, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import { desktop } from '../../../lib/desktop';
import { PROVIDER_BY_ID, engineLabel } from '../../../lib/providers';
import type { AgentEngine, ModelState, PetProactivity, PetVoiceProvider, ProviderId } from '../../../lib/types';
import { TTS_KEYS_EVENT, hotkeyStore } from '../../../pet/brain';
import type { TtsModel } from '../../../pet/contracts';
import { petLiveEngine, petVisionEngine, petVisionOptions, petWebOptions } from '../../../pet/engines';
import { actions } from '../../../state/actions';
import { menuValue, parseMenuValue } from '../../../state/models';
import { DEFAULT_PET } from '../../../state/seed';
import { useApp } from '../../../state/store';
import { Button, IconButton, Panel, Segmented, Slider, Switch, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { MAX_NAMES, parseAccelerator, parseExe, parseIntIn, type Checked } from '../../../pet/input';
import '../../../styles/pet-settings.css';

/** 桌面端的桌宠. 浏览器开发版里没有. */
const bridge = desktop?.pet;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, '');

/* ───────────── 积木 ───────────── */

/** 分区里的一个带标题的块. */
function Group({ icon: Icon, title, actions: right, children }: { icon: LucideIcon; title: string; actions?: ReactNode; children: ReactNode }) {
  const id = useId();
  return (
    <section className="settings-item pet-set" aria-labelledby={id}>
      <div className="pet-set__head">
        <h3 id={id} className="pet-set__title"><Icon size={15} aria-hidden />{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

/** 左边标题和说明，右边控件；`wide` 让控件独占一行. */
function Row({ title, desc, wide, children }: { title: string; desc?: ReactNode; wide?: boolean; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <p className="settings-row__title">{title}</p>
        {desc && <p className="settings-row__desc">{desc}</p>}
      </div>
      <div className={cx('settings-row__control', wide && 'pet-set__wide')}>{children}</div>
    </div>
  );
}

/** 离开输入框时检查并保存的文本框（回车保存，Esc 放回旧值）. 不合规的内容留在屏幕上并写明原因，改好之前什么都不保存. */
function CommitInput({ label, value, parse, onCommit, placeholder, mono, maxLength, disabled, unit, className, inputMode }: {
  label: string; value: string; parse: (draft: string) => Checked; onCommit: (value: string) => void;
  placeholder?: string; mono?: boolean; maxLength?: number; disabled?: boolean; unit?: string; className?: string; inputMode?: 'numeric' | 'text';
}) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  const [error, setError] = useState<string>();
  // 设置从别处变了（恢复默认、别的窗口）：显示新的.
  useEffect(() => { setDraft(value); setError(undefined); }, [value]);
  const commit = () => {
    const r = parse(draft);
    if (!r.ok) { setError(r.error); return; }
    setError(undefined);
    setDraft(r.value);
    if (r.value !== value) onCommit(r.value);
  };
  return (
    <div className="pet-set__commit">
      <span className="pet-set__with-unit">
        <input
          className={cx('input', mono && 'mono', className)} aria-label={label} value={draft} placeholder={placeholder} maxLength={maxLength} disabled={disabled}
          inputMode={inputMode} autoComplete="off" spellCheck={false}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => { setDraft(e.target.value); setError(undefined); }}
          onBlur={commit}
          onKeyDown={(e) => {
            // 输入法正在选字时，回车和 Esc 归输入法.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { setDraft(value); setError(undefined); }
          }}
        />
        {unit && <span className="pet-set__unit">{unit}</span>}
      </span>
      {error && <p id={`${id}-e`} className="pet-set__err" role="alert">{error}{value ? `（没有保存，仍是 ${value}）` : '（没有保存）'}</p>}
    </div>
  );
}

const asInt = (n: number, lo: number, hi: number) => ({ parse: parseIntIn(lo, hi), value: String(n) });

/** 可编辑的程序名单（小写 exe 名）. `onAdd` 一次拿到新增的名字，可以拒绝并给原因；`onRemove` 去掉一个. */
function NameList({ title, desc, names, onAdd, onRemove }: {
  title: string; desc: string; names: string[]; onAdd: (added: string[]) => string | undefined; onRemove: (name: string) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const submit = () => {
    if (!draft.trim()) return;
    const added: string[] = [];
    for (const part of draft.split(/[,，;；\n]+/)) {
      if (!part.trim()) continue;
      const r = parseExe(part);
      if (!r.ok) { setError(r.error); return; }
      if (!names.includes(r.value) && !added.includes(r.value)) added.push(r.value);
    }
    if (!added.length) { setError('已经在名单里了'); return; }
    if (names.length + added.length > MAX_NAMES) { setError(`名单最多 ${MAX_NAMES} 个`); return; }
    const refused = onAdd(added);
    if (refused) { setError(refused); return; }
    setDraft('');
    setError(undefined);
  };
  return (
    <div className="pet-set__listbox">
      <div>
        <p className="pet-set__listname" id={`${id}-t`}>{title}</p>
        <p className="pet-set__hint">{desc}</p>
      </div>
      {names.length > 0 ? (
        <ul className="pet-tags" aria-labelledby={`${id}-t`}>
          {names.map((n) => (
            <li key={n} className="pet-tag">
              <span>{n}</span>
              <button type="button" aria-label={`从「${title}」移除 ${n}`} title="移除" onClick={() => onRemove(n)}><X size={12} aria-hidden /></button>
            </li>
          ))}
        </ul>
      ) : <p className="pet-set__empty">还没有</p>}
      <div className="pet-set__add">
        <input
          className="input mono" aria-label={`添加到「${title}」`} placeholder="starrail.exe" value={draft} autoComplete="off" spellCheck={false}
          aria-invalid={error ? true : undefined} aria-describedby={error ? `${id}-e` : undefined}
          onChange={(e) => { setDraft(e.target.value); setError(undefined); }}
          onKeyDown={(e) => { if (e.nativeEvent.isComposing || e.keyCode === 229) return; if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <Button size="sm" icon={Plus} disabled={!draft.trim()} onClick={submit}>添加</Button>
      </div>
      {error && <p id={`${id}-e`} className="pet-set__err" role="alert">{error}</p>}
    </div>
  );
}

/* ───────────── 模型 ───────────── */

/** 「Claude Sonnet 5.5 · API」：存下来的选择，不管它现在还连不连得上. */
function engineText(models: ModelState, e: AgentEngine) {
  const [provider, auth] = e.key.split(':');
  const p = PROVIDER_BY_ID[provider as ProviderId];
  if (!p) return e.key;
  return engineLabel(p, auth === 'api' ? 'api' : 'cli', auth === 'api' ? undefined : models.providers[p.id].driver, e.model);
}

/** 自动，或者此刻连着的某个模型. */
function EnginePick({ label, models, options, value, autoSub, emptyHint, onChange }: {
  label: string; models: ModelState; options: Array<{ key: string; model: string; label: string }>;
  value: AgentEngine | undefined; autoSub: string; emptyHint: string; onChange: (e: AgentEngine | undefined) => void;
}) {
  const current = value ? menuValue(value.key, value.model) : '';
  const gone = !!value && !options.some((o) => menuValue(o.key, o.model) === current);
  const list = [
    { value: '', label: '自动', sub: autoSub },
    ...options.map((o) => ({ value: menuValue(o.key, o.model), label: o.label, sub: o.model && o.model !== o.label ? o.model : undefined })),
  ];
  return (
    <div className="pet-set__pick">
      <MenuSelect
        variant="field" label={label} icon={Cpu} value={current} options={list} minWidth={300}
        display={gone && value ? `${engineText(models, value)}（现在不可用）` : undefined}
        onChange={(v) => { if (!v) { onChange(undefined); return; } const { key, model } = parseMenuValue(v); onChange({ key, model }); }}
        footer={<Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>}
      />
      {gone && <p className="pet-set__warn"><TriangleAlert size={13} aria-hidden />这个模型现在连不上，她会先按「自动」选。</p>}
      {!gone && options.length === 0 && <p className="pet-set__hint">{emptyHint}</p>}
    </div>
  );
}

/* ───────────── 语音 ───────────── */

type KeyedProvider = 'elevenlabs' | 'minimax';
const KEYED: Array<{ id: KeyedProvider; name: string; url: string }> = [
  { id: 'elevenlabs', name: 'ElevenLabs', url: 'https://elevenlabs.io/app/settings/api-keys' },
  { id: 'minimax', name: 'MiniMax', url: PROVIDER_BY_ID.minimax?.keyUrl ?? 'https://platform.minimaxi.com/' },
];
const PROVIDER_OPTIONS: Array<{ value: PetVoiceProvider; label: string; hint: string }> = [
  { value: 'elevenlabs', label: 'ElevenLabs', hint: '音质最好；填你自己在那里设计的音色，需要 API Key' },
  { value: 'minimax', label: 'MiniMax', hint: '可以用「音色设计」做出自己的音色，需要 API Key' },
  { value: 'edge', label: '微软在线朗读', hint: '不是她的声音，只作备用；不需要密钥，用的是非官方的免费接口' },
];
const SERVICE_NAME: Record<PetVoiceProvider, string> = { elevenlabs: 'ElevenLabs', minimax: 'MiniMax', edge: '微软在线朗读' };

/** 她的话发给谁：选定的那家；开着备用时，它出错或没配好才改发给微软在线朗读（晓晓，不是她的声音）——备用只有这一家，没有 MiniMax 链. 没有密钥的服务在发出任何东西之前就跳过（electron/pet/tts.cjs 同样）. */
function voiceRoute(provider: PetVoiceProvider, fallback: boolean, hints: Partial<Record<PetVoiceProvider, string>>): PetVoiceProvider[] {
  const chain: PetVoiceProvider[] = fallback && provider !== 'edge' ? [provider, 'edge'] : [provider];
  return chain.filter((p) => p === 'edge' || !!hints[p]);
}

/** 老老实实写明她说的话会发给谁，以及微软在线朗读是什么. */
function VoiceRoute({ provider, fallback, enabled, voiceId, hints }: {
  provider: PetVoiceProvider; fallback: boolean; enabled: boolean; voiceId: string; hints?: Partial<Record<PetVoiceProvider, string>>;
}) {
  const route = hints ? voiceRoute(provider, fallback, hints) : [];
  const unkeyed = !!hints && provider !== 'edge' && !hints[provider];
  // 要音色 ID 的服务（ElevenLabs / MiniMax）没填音色 ID 就不出声（备用开着时才由微软晓晓读）.
  const noId = provider !== 'edge' && !voiceId.trim();
  return (
    <div className="pet-set__route" role="note">
      <p className="pet-set__route-title"><Info size={14} aria-hidden />她说的话会发给谁</p>
      <p className="pet-set__route-text">读出来的是气泡里显示的那部分回复（可能复述了你屏幕上的内容），它会发给语音服务合成声音：</p>
      <ul>
        <li><strong>ElevenLabs</strong>、<strong>MiniMax</strong>：官方接口，用你自己的 API Key 和你设计的音色 ID。没保存密钥、或没填音色 ID，就不会被用到，也就收不到文字。</li>
        <li><strong>微软在线朗读</strong>：Edge 浏览器朗读功能背后的<strong>非官方免费接口</strong>，不需要密钥，没有任何服务保证，随时可能失效；<strong>它不是她的声音</strong>。</li>
      </ul>
      {enabled ? (
        <>
          {route.length > 0 && (
            <p className="pet-set__route-text">
              按现在的设置，文字发给：<strong>{route.map((p) => SERVICE_NAME[p]).join(' → ')}</strong>{route.length > 1 ? '（前一个出错了才发给后一个）' : ''}。
            </p>
          )}
          {noId && !unkeyed && (
            <p className="pet-set__warn">
              <TriangleAlert size={13} aria-hidden />
              {fallback ? `还没有填音色 ID，所以现在由备用声音读出：微软在线朗读（不是她的声音）。` : `还没有填音色 ID，她现在不会出声：到上面的「音色」里填上。`}
            </p>
          )}
          {unkeyed && (
            <p className="pet-set__warn">
              <TriangleAlert size={13} aria-hidden />
              {fallback
                ? `还没有保存 ${SERVICE_NAME[provider]} 的密钥，所以现在由备用声音读出：${SERVICE_NAME[route[0] ?? 'edge']}（不是她的声音）。`
                : `还没有保存 ${SERVICE_NAME[provider]} 的密钥，又没开备用声音，她现在不会出声。`}
            </p>
          )}
          {route.includes('edge') && provider !== 'edge' && <p className="pet-set__route-text">不想让文字发给微软在线朗读：关掉上面的「失败时改用备用声音」。</p>}
        </>
      ) : <p className="pet-set__route-text">语音现在是关的，不会把文字发给任何服务。</p>}
    </div>
  );
}

/** 一个语音服务的密钥：密码框 + 保存；存下后只显示尾号（更换 / 删除）. */
function TtsKey({ provider, name, url, hint, onHint }: { provider: KeyedProvider; name: string; url: string; hint?: string; onHint: (hint: string | undefined) => void }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const show = !hint || editing;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    const key = value.trim();
    if (!key || !bridge) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await bridge.saveTtsKey(provider, key);
      if (r.ok) {
        setValue('');
        setEditing(false);
        onHint(r.hint);
        actions.toast({ tone: 'success', title: '密钥已加密保存', body: `${name} · ${r.hint}` });
      } else setError(r.error);
    } catch (err) { setError(errText(err)); }
    setBusy(false);
  };
  const clear = async () => {
    if (!bridge) return;
    setError(undefined);
    try {
      const r = await bridge.clearTtsKey(provider);
      // 文件没写成：密钥其实还在，尾号照旧显示.
      if (!r.ok) { setError(r.error); return; }
      onHint(undefined);
      setEditing(false);
      setValue('');
      actions.toast({ tone: 'info', title: '密钥已删除', body: name });
    } catch (err) { setError(errText(err)); }
  };
  return (
    <div className="model-field">
      <span className="model-field__label" id={`${id}-l`}>{name} API Key</span>
      {show ? (
        <form className="model-key" onSubmit={save}>
          <input className="input mono" type="password" aria-labelledby={`${id}-l`} value={value} autoComplete="off" spellCheck={false}
            placeholder="粘贴密钥" onChange={(e) => setValue(e.target.value)} />
          <Button type="submit" size="sm" variant="primary" busy={busy} disabled={!value.trim()}>保存</Button>
          {hint && <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setValue(''); setError(undefined); }}>取消</Button>}
        </form>
      ) : (
        <div className="model-key model-key--saved">
          <KeyRound size={14} aria-hidden />
          <span className="mono">已保存 {hint}</span>
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => setEditing(true)}>更换</Button>
          <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void clear()}>删除</Button>
        </div>
      )}
      {error && <p className="pet-set__err" role="alert">{error}</p>}
      <p className="model-field__hint"><a href={url} target="_blank" rel="noreferrer">去获取密钥<ExternalLink size={11} aria-hidden /></a></p>
    </div>
  );
}

type VoiceItem = { id: string; name: string; preview?: string; kind?: 'designed' | 'stock' };
/** 列表项的标记：设计 / 现成（主进程若已经把标记写进名字里就不再重复）. */
function voiceTag(v: VoiceItem): string {
  const tag = v.kind === 'designed' ? '设计' : v.kind === 'stock' ? '现成' : '';
  return tag && !v.name.includes(tag) ? tag : '';
}
type VoiceList = { provider: PetVoiceProvider; status: 'loading' | 'ready' | 'error' | 'need-key'; list: VoiceItem[]; message?: string };
type ModelList = { provider: KeyedProvider; status: 'loading' | 'ready' | 'error'; list: TtsModel[]; live: boolean; message?: string };

/** ElevenLabs / MiniMax 的语音模型. '' = 推荐的那个（它会随服务变）. */
function ModelPicker({ provider, keyed, tick }: { provider: KeyedProvider; keyed: boolean; tick: number }) {
  const models = useApp((s) => s.settings.pet.voice.models);
  const value = models[provider];
  const [state, setState] = useState<ModelList>({ provider, status: 'loading', list: [], live: false });
  useEffect(() => {
    if (!bridge) return;
    let stale = false;
    setState({ provider, status: 'loading', list: [], live: false });
    bridge.ttsModels(provider).then(
      (r) => {
        if (stale) return;
        if ('models' in r) setState({ provider, status: 'ready', list: r.models, live: r.live });
        else setState({ provider, status: 'error', list: [], live: false, message: r.error || '读取模型列表失败' });
      },
      (e) => { if (!stale) setState({ provider, status: 'error', list: [], live: false, message: errText(e) }); },
    );
    return () => { stale = true; };
    // 存了密钥，ElevenLabs 的内置清单就换成账号里的实时列表.
  }, [provider, keyed, tick]);
  const shown = state.provider === provider ? state : { provider, status: 'loading' as const, list: [], live: false };
  const rec = shown.list.find((m) => m.recommended);
  const opt = (m: TtsModel) => ({ value: m.id, label: m.name || m.id, sub: m.note ? `${m.id} · ${m.note}` : m.id });
  const current = shown.list.filter((m) => !m.legacy);
  const legacy = shown.list.filter((m) => m.legacy);
  const groups = [
    { options: [{ value: '', label: rec ? `推荐：${rec.name || rec.id}` : '推荐', sub: rec?.note ?? '用这家服务推荐的模型' }] },
    ...(current.length ? [{ label: '可选模型', hint: shown.live ? '来自你的账号' : undefined, options: current.map(opt) }] : []),
    ...(legacy.length ? [{ label: '旧模型', hint: '还能用，效果一般不如新的', options: legacy.map(opt) }] : []),
    // 存下的选择，列表里已经没有了（服务改了名或下线了）：仍然显示着.
    ...(value && !shown.list.some((m) => m.id === value) ? [{ options: [{ value, label: value, sub: '当前选择（列表里没有）' }] }] : []),
  ];
  const chosen = shown.list.find((m) => m.id === (value || rec?.id));
  const name = provider === 'minimax' ? 'MiniMax' : 'ElevenLabs';
  return (
    <Row title="模型" desc={`同一个声音换模型，音质、语气和速度都会不一样。${name} 的声音编号在它的各个模型之间通用。`} wide>
      <MenuSelect variant="field" label="模型" icon={Cpu} value={value} groups={groups} placeholder={shown.status === 'loading' ? '读取中…' : '推荐'} minWidth={320}
        disabled={!bridge || shown.status === 'loading'}
        onChange={(v) => actions.setPet({ voice: { models: { [provider]: v } } })} />
      {chosen?.note && <p className="pet-set__hint">{chosen.name || chosen.id}：{chosen.note}</p>}
      {shown.status === 'error' && <p className="pet-set__err" role="alert">{shown.message}</p>}
    </Row>
  );
}

function VoiceSettings() {
  const voice = useApp((s) => s.settings.pet.voice);
  const [hints, setHints] = useState<Partial<Record<PetVoiceProvider, string>>>();
  const [voices, setVoices] = useState<VoiceList>({ provider: voice.provider, status: 'loading', list: [] });
  const [tick, setTick] = useState(0);
  // 默认只列音色设计做的音色；勾上才把账号里现成的也列出来（克隆的音色任何时候都不列）.
  const [showAll, setShowAll] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ sig: string; ok: boolean; text: string }>();
  const provider = voice.provider;
  const model = provider === 'edge' ? '' : voice.models[provider];
  // 音色 ID 每个服务各存一个（换服务再换回来不丢）；这里的 voiceId 是当前服务的那一个.
  const voiceId = voice.voiceIds[provider];
  const sig = `${provider}|${voiceId}|${model}`;

  // 哪些服务已经有密钥.
  useEffect(() => {
    let stale = false;
    (bridge ? bridge.ttsKeys() : Promise.resolve({})).then((h) => { if (!stale) setHints(h); }, () => { if (!stale) setHints({}); });
    return () => { stale = true; };
  }, []);

  // 选定服务的声音列表. 要密钥的服务没有密钥时不去问.
  const keyed = provider === 'edge' || !!hints?.[provider];
  const known = hints !== undefined;
  useEffect(() => {
    if (!bridge || !known) return;
    if (!keyed) { setVoices({ provider, status: 'need-key', list: [] }); return; }
    let stale = false;
    setVoices({ provider, status: 'loading', list: [] });
    bridge.voices(provider, showAll ? { all: true } : undefined).then(
      (r) => {
        if (stale) return;
        if (Array.isArray(r)) setVoices({ provider, status: 'ready', list: r });
        else setVoices({ provider, status: 'error', list: [], message: r?.error || '读取声音列表失败' });
      },
      (e) => { if (!stale) setVoices({ provider, status: 'error', list: [], message: errText(e) }); },
    );
    return () => { stale = true; };
  }, [provider, keyed, known, tick, showAll]);

  // 刚换走的那个服务的列表，在新服务加载时不显示.
  const shown: VoiceList = voices.provider === provider ? voices : { provider, status: 'loading', list: [] };
  const options = [
    ...(provider === 'edge' ? [{ value: '', label: '默认', sub: '微软在线朗读的默认声音' }] : []),
    // 存下的声音，哪怕列表读不出来也仍然显示.
    ...(voiceId && !shown.list.some((v) => v.id === voiceId) ? [{ value: voiceId, label: voiceId, sub: '当前选择' }] : []),
    ...shown.list.map((v) => ({ value: v.id, label: v.name || v.id, sub: [voiceTag(v), v.name && v.name !== v.id ? v.id : ''].filter(Boolean).join(' · ') || undefined })),
  ];
  const placeholder = !bridge ? '需要桌面版' : shown.status === 'loading' ? '读取中…' : shown.status === 'need-key' ? '先保存密钥' : '还没选声音';
  const canTest = !!bridge && (provider === 'edge' || !!voiceId) && keyed;

  const runTest = async () => {
    if (!bridge) return;
    setTesting(true);
    setTest(undefined);
    try {
      const r = await bridge.testVoice({ provider, voiceId: voiceId, model, text: '试一试这个声音，听起来怎么样？' });
      setTest({ sig, ok: r.ok, text: r.ok ? '已发出试听' : r.error });
    } catch (e) { setTest({ sig, ok: false, text: errText(e) }); }
    setTesting(false);
  };

  return (
    <Group icon={Volume2} title="语音">
      <Switch label="让她开口说话" description="气泡里的话同时读出来，长回答只读前两句。默认关。" checked={voice.enabled} onChange={(v) => actions.setPet({ voice: { enabled: v } })} />
      <div className="callout callout--info pet-set__note" role="note">
        <Info size={16} aria-hidden className="callout__icon" />
        <div className="callout__body">
          <p className="callout__title">她的声音</p>
          <p className="callout__text">只能用音色设计做出来的音色（ElevenLabs 的 Voice Design、MiniMax 的音色设计），或你自己生成的配音；克隆出来的音色会被拒绝，列表里也不会出现。不要用克隆声优的音色。微软在线朗读不是她的声音，只能作可选的备用，默认关。</p>
        </div>
      </div>
      <Row title="语音服务" desc="每个服务各记各的音色 ID（编号不通用），换过去再换回来不会丢。">
        <Segmented<PetVoiceProvider> label="语音服务" options={PROVIDER_OPTIONS} value={provider}
          onChange={(v) => actions.setPet({ voice: { provider: v } })} />
      </Row>

      <div className="pet-set__box">
        <p className="pet-set__boxtitle">语音服务密钥</p>
        <p className="pet-set__hint">密钥由系统加密，只保存在桌面版的主进程里，这里保存后不再显示。微软在线朗读不需要密钥。</p>
        {hints ? (
          <div className="pet-set__keys">
            {KEYED.map((k) => (
              <TtsKey key={k.id} provider={k.id} name={k.name} url={k.url} hint={hints[k.id]}
                onHint={(h) => { setHints((cur) => ({ ...cur, [k.id]: h })); window.dispatchEvent(new Event(TTS_KEYS_EVENT)); }} />
            ))}
          </div>
        ) : <p className="pet-set__hint">读取中…</p>}
      </div>

      <Row title="音色" desc={provider === 'minimax' ? '填你用音色设计做好的音色 ID，或从账号里选一个（只列音色设计做的，克隆的会被拒绝）。' : provider === 'elevenlabs' ? '填你用 Voice Design 设计的她的音色 ID，或从账号里选一个（只列设计的，克隆的会被拒绝）。' : '微软在线朗读自带的声音（不是她的声音）。'} wide>
        {provider !== 'edge' && (
          <CommitInput label="音色 ID" mono className="pet-set__voiceid" value={voiceId} maxLength={200} placeholder="粘贴音色 ID"
            parse={(d) => ({ ok: true, value: d.trim() })} onCommit={(v) => actions.setPet({ voice: { voiceIds: { [provider]: v } } })} />
        )}
        {provider !== 'edge' && <p className="pet-set__hint">克隆的音色会被拒绝：试听和朗读都不会出声，请用音色设计里为她做的音色。</p>}
        <div className="pet-set__voicebar">
          <div className="pet-set__grow">
            <MenuSelect variant="field" label="从账号里选音色" icon={Volume2} value={voiceId} options={options} placeholder={placeholder} minWidth={280}
              disabled={shown.status === 'loading' || shown.status === 'need-key'}
              onChange={(v) => actions.setPet({ voice: { voiceIds: { [provider]: v } } })} />
          </div>
          <IconButton icon={RefreshCw} label="刷新声音列表" variant="secondary" disabled={!bridge || !keyed || shown.status === 'loading'} onClick={() => setTick((t) => t + 1)} />
          <Button icon={Play} busy={testing} disabled={!canTest} onClick={() => void runTest()}>试听</Button>
        </div>
        {provider !== 'edge' && (
          <label className="pet-set__check">
            <input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />
            显示全部（也列出账号里现成的音色，分别标「设计」「现成」；克隆的不会列出）
          </label>
        )}
        {shown.status === 'error' && <p className="pet-set__err" role="alert">{shown.message}</p>}
        {shown.status === 'need-key' && <p className="pet-set__hint">先在上面保存 {provider === 'minimax' ? 'MiniMax' : 'ElevenLabs'} 的 API Key，才能列出账号里的声音；音色 ID 可以直接填。</p>}
        {test?.sig === sig && <p className={test.ok ? 'pet-set__ok' : 'pet-set__err'} role={test.ok ? 'status' : 'alert'}>{test.text}</p>}
      </Row>
      {provider !== 'edge' && <ModelPicker provider={provider} keyed={keyed} tick={tick} />}

      <Slider label="音量" value={voice.volume} min={0} max={100} step={5} onChange={(v) => actions.setPet({ voice: { volume: v } })}
        description="只影响桌宠说话的音量，不是系统音量。" />
      <Switch label="失败时改用备用声音（微软晓晓）" description="当前服务出错或没配好时，改用微软在线朗读的晓晓读出来，让她总能出声。这不是她的声音，只作备用；没有 MiniMax 这一档。默认关。" checked={voice.fallback}
        onChange={(v) => actions.setPet({ voice: { fallback: v } })} />
      <VoiceRoute provider={provider} fallback={voice.fallback} enabled={voice.enabled} voiceId={voiceId} hints={hints} />
    </Group>
  );
}

/* ───────────── 分区 ───────────── */

const PROACTIVITY: Array<{ value: PetProactivity; label: string; hint: string }> = [
  { value: 'off', label: '不主动', hint: '只在你问她的时候说话' },
  { value: 'low', label: '很少', hint: '很少打扰你' },
  { value: 'normal', label: '偶尔', hint: '偶尔搭一句' },
  { value: 'high', label: '常常', hint: '话比较多' },
];

const LISTEN: Array<{ value: 'auto' | 'key'; label: string }> = [
  { value: 'auto', label: '自动听' },
  { value: 'key', label: '按键说一句' },
];

/** 实时陪玩还缺什么：一个 ElevenLabs 密钥（听和说都靠它）和一个 API 方式的模型. */
function LiveNeeds() {
  const models = useApp((s) => s.models);
  const pet = useApp((s) => s.settings.pet);
  const [keys, setKeys] = useState<Partial<Record<PetVoiceProvider, string>>>();
  useEffect(() => {
    let stale = false;
    const read = () => { (bridge ? bridge.ttsKeys() : Promise.resolve({})).then((k) => { if (!stale) setKeys(k); }, () => { if (!stale) setKeys({}); }); };
    read();
    // 上面「语音」里存了或删了密钥.
    window.addEventListener(TTS_KEYS_EVENT, read);
    return () => { stale = true; window.removeEventListener(TTS_KEYS_EVENT, read); };
  }, []);
  const vision = petVisionEngine(models, pet.vision);
  const engine = petLiveEngine(models, pet.vision);
  const items: ReactNode[] = [];
  if (keys && !keys.elevenlabs) items.push(<span key="el">还没有保存 ElevenLabs 的密钥：实时陪玩用它听你说话。在上面的「语音」里保存。</span>);
  if (!engine) items.push(<span key="m">还没有用 API 接入的模型：实时陪玩要它来马上回答（命令行方式启动太慢）。</span>);
  else if (!vision) items.push(<span key="v">还没有能看图的 API 模型，实时陪玩会不看画面；可以去「模型接入」接一个。</span>);
  if (!items.length) return null;
  return (
    <div className="pet-set__qwen is-missing">
      <TriangleAlert size={14} aria-hidden />
      <span className="pet-set__needs">{items}</span>
      {!engine && <Button size="sm" variant="ghost" onClick={() => actions.navigate('models')}>去模型接入</Button>}
    </div>
  );
}

export function PetSection() {
  const pet = useApp((s) => s.settings.pet);
  const models = useApp((s) => s.models);
  const set = actions.setPet;
  const hotkeysAreDefault = pet.hotkeyAsk === DEFAULT_PET.hotkeyAsk && pet.hotkeyPause === DEFAULT_PET.hotkeyPause;
  // 桌面能注册哪些热键（electron/pet/hotkeys.cjs 的每条失败说明开头是「呼出…」/「暂停…」）. 桌面还没说话之前不当作有哪个失败了.
  const registered = useSyncExternalStore(hotkeyStore.subscribe, hotkeyStore.get);
  const hotkeyErrors = registered?.errors ?? [];
  const askErrors = hotkeyErrors.filter((e) => e.startsWith('呼出'));
  const pauseErrors = hotkeyErrors.filter((e) => e.startsWith('暂停'));
  const otherErrors = hotkeyErrors.filter((e) => !e.startsWith('呼出') && !e.startsWith('暂停'));
  const failed = (list: string[]) => list.map((e) => <p key={e} className="pet-set__err" role="alert">{e}</p>);

  /** 热键合规 = Electron 读得懂，且和另一个不同. */
  const hotkey = (other: string) => (draft: string): Checked => {
    const r = parseAccelerator(draft);
    if (!r.ok) return r;
    const o = parseAccelerator(other);
    return o.ok && o.value === r.value ? { ok: false, error: '和另一个热键重复了' } : r;
  };

  // 把程序标进「永远不看」/「不要看」会把它从「可以看」里拿掉（更严的名单本来就优先）；反过来是拒绝，名单之间不自相矛盾.
  const addStrict = (key: 'neverWatch' | 'gameDeny') => (added: string[]) => {
    set({ [key]: [...pet[key], ...added], gameAllow: pet.gameAllow.filter((x) => !added.includes(x)) });
    return undefined;
  };
  const addAllow = (added: string[]) => {
    const blocked = added.find((x) => pet.neverWatch.includes(x) || pet.gameDeny.includes(x));
    if (blocked) return `${blocked} 在「永远不看」或「不要看」里，那边优先。先把它从那里移除。`;
    set({ gameAllow: [...pet.gameAllow, ...added] });
    return undefined;
  };
  const remove = (key: 'neverWatch' | 'gameAllow' | 'gameDeny') => (name: string) => set({ [key]: pet[key].filter((x) => x !== name) });

  return (
    <Panel className="settings-span" label="桌面" title="桌宠" icon={PawPrint} energy id="settings-pet">
      {!bridge && (
        <div className="callout callout--warning pet-set__note" role="note">
          <Info size={16} aria-hidden className="callout__icon" />
          <div className="callout__body">
            <p className="callout__title">需要桌面版</p>
            <p className="callout__text">桌宠是一个独立的透明小窗口，只有桌面版才有。在浏览器里预览时，下面的选项只能看，不能改。</p>
          </div>
        </div>
      )}
      <fieldset className="pet-set__fields" disabled={!bridge}>
        <legend className="sr-only">桌宠设置</legend>
        <div className="settings-list">
          <Group icon={PawPrint} title="形象">
            <Switch label="显示桌宠" description="屏幕角落里一个 Q 版的小遐蝶，可以拖动，右键有菜单。她是我们自己画的 Q 版同人图（AI 辅助绘制，按官方外貌），不是官方素材。默认关。" checked={pet.enabled} onChange={(v) => set({ enabled: v })} />
            <Slider label="大小" value={Math.round(pet.scale * 100)} min={60} max={160} step={5} format={(v) => `${v}%`} ends={['小', '大']}
              onChange={(v) => set({ scale: v / 100 })} />
            <Switch label="眼睛跟着鼠标" description="她的视线和头会跟着光标转。她被藏起来或你在游戏里时不读光标位置。" checked={pet.follow} onChange={(v) => set({ follow: v })} />
            <Row title="动画帧率上限" desc="待机时她最多 30 帧；说话、拖动、眨眼时才用到这里的上限。想省一点显卡就选 30。">
              <Segmented<'30' | '60'> label="动画帧率上限" options={[{ value: '30', label: '30 帧' }, { value: '60', label: '60 帧' }]} value={String(pet.fpsCap) as '30' | '60'}
                onChange={(v) => set({ fpsCap: v === '30' ? 30 : 60 })} />
            </Row>
          </Group>

          <Group icon={Eye} title="看画面">
            <Switch label="允许她看游戏画面" description="开着时，她能在本机看一眼你正在玩的游戏，聊剧情、帮你看看卡在哪里。默认关。" checked={pet.watch} onChange={(v) => set({ watch: v })} />
            <div className="pet-set__privacy" role="group" aria-label="隐私说明">
              <p className="pet-set__privacy-title"><ShieldCheck size={15} aria-hidden />她怎么看，看到的去了哪里</p>
              <ul>
                <li>只看当前在前台、又在游戏名单里（或你标过「当作游戏」）的<strong>游戏窗口</strong>，不看整个桌面。聊天、网银、浏览器这类不是游戏的窗口不会被截取。</li>
                <li>画面默认<strong>留在这台电脑上</strong>，只在本机判断「有没有在动、是不是过场」，每秒看一两帧。</li>
                <li>只有你问她，或她主动搭话时，才把<strong>一帧</strong>发给你选的看图模型（要一个支持图片的 API 模型）。</li>
                <li>本机识别出的几行屏幕文字会随与游戏有关的提问、搭话一起发给为她作答的模型，不一定带画面；没有看图模型时，这个模型是你在「模型接入」里选的默认模型（可能是命令行工具）。</li>
                <li>前台是游戏时，游戏名（你标成游戏的程序用它的窗口标题）在你提问和她打招呼时就会发给模型，「允许她看游戏画面」关着也一样。</li>
                <li>攻略、配装这类要联网查的问题，会连同问题、最近几句对话、游戏名和识别出的几行文字（问到画面时，还有看图模型对画面的一句话描述）交给由 Claude Code 驱动的模型，只允许它搜索和打开网页，不带图。</li>
                <li>竞技反作弊游戏<strong>只聊天</strong>，不看画面，她自己会藏起来。不注入游戏、不读内存、不模拟键鼠。</li>
                <li>她会读前台程序的名字和窗口标题，用来认出你在玩什么。看画面时桌宠上有小眼睛标记，按暂停热键立刻停止。</li>
              </ul>
            </div>
          </Group>

          <Group icon={MessageCircle} title="主动搭话">
            <Row title="主动程度" desc="她自己开口的频率。你在打字、或她刚说过话时不会插嘴；连续两次没人理会就安静 10 分钟；玩她的小游戏时也不插嘴。">
              <Segmented<PetProactivity> label="主动程度" options={PROACTIVITY} value={pet.proactivity} onChange={(v) => set({ proactivity: v })} />
            </Row>
            <Row title="冷却" desc="两次主动搭话之间至少隔多久，60 秒到 1 小时。">
              <CommitInput label="冷却（秒）" unit="秒" inputMode="numeric" className="pet-set__num" disabled={pet.proactivity === 'off'}
                {...asInt(pet.cooldownSec, 60, 3600)} onCommit={(v) => set({ cooldownSec: Number(v) })} />
            </Row>
            <Row title="每小时最多发几张截图" desc="她主动搭话时最多带几张截图给看图模型，用来控制花费。0 表示从不主动发截图。">
              <CommitInput label="每小时最多发几张截图" unit="张" inputMode="numeric" className="pet-set__num"
                {...asInt(pet.imagesPerHour, 0, 240)} onCommit={(v) => set({ imagesPerHour: Number(v) })} />
            </Row>
          </Group>

          <Group icon={Cpu} title="模型">
            <Row title="看图 / 实时用的模型" desc="看截图、实时陪玩时回答用的 API 模型，要支持图片。自动：用已接入的、支持图片的、又便宜又快的那个。" wide>
              <EnginePick label="看图 / 实时用的模型" models={models} options={petVisionOptions(models)} value={pet.vision} autoSub="用已接入的、支持图片的便宜模型"
                emptyHint="还没有能看图的 API 模型，实时陪玩会不看画面；可以去「模型接入」接一个。" onChange={(e) => set({ vision: e })} />
            </Row>
            <Row title="联网答疑用的模型" desc="问攻略、配装、版本信息时用的命令行模型，要能联网搜索。目前只用由 Claude Code 驱动的模型（默认是已登录的 Claude Code）：它只被允许搜索和打开网页，别的工具都禁掉了。" wide>
              <EnginePick label="联网答疑用的模型" models={models} options={petWebOptions(models)} value={pet.web} autoSub="用已登录的 Claude Code"
                emptyHint="还没有登录可用的 Claude Code。到「模型接入」里登录之后，她才能联网查资料。" onChange={(e) => set({ web: e })} />
            </Row>
            <p className="pet-set__hint">没有能看图的 API 模型时，她平时说话改用你在「模型接入」里选的默认模型（可以是 Claude 订阅等命令行方式），但没有画面。</p>
          </Group>

          <VoiceSettings />

          <Group
            icon={Keyboard} title="热键"
            actions={!hotkeysAreDefault && <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => set({ hotkeyAsk: DEFAULT_PET.hotkeyAsk, hotkeyPause: DEFAULT_PET.hotkeyPause })}>恢复默认</Button>}
          >
            <Row title="呼出聊天框" desc="在任何程序里按它，桌宠头上弹出聊天框，和她来回聊；再按一次收起。至少带 Ctrl、Alt 或 Win；建议用 Ctrl+Alt 开头，不容易和别的程序的快捷键冲突，例如 Ctrl+Alt+B。">
              <CommitInput label="呼出聊天框的热键" mono className="pet-set__key" value={pet.hotkeyAsk} maxLength={40} parse={hotkey(pet.hotkeyPause)} onCommit={(v) => set({ hotkeyAsk: v })} />
              {failed(askErrors)}
            </Row>
            <Row title="暂停 / 继续看画面" desc="按一下立刻停止看画面，再按一下继续。">
              <CommitInput label="暂停或继续看画面的热键" mono className="pet-set__key" value={pet.hotkeyPause} maxLength={40} parse={hotkey(pet.hotkeyAsk)} onCommit={(v) => set({ hotkeyPause: v })} />
              {failed(pauseErrors)}
            </Row>
            {failed(otherErrors)}
            <p className="pet-set__hint">如果别的程序已经占用了这个组合，热键会注册失败，换一个就好。</p>
          </Group>

          <Group icon={ListFilter} title="名单">
            <p className="pet-set__hint">
              填程序的文件名，比如 starrail.exe；直接粘贴完整路径也行，会自动取文件名。桌宠的右键菜单里也能把前台程序加进来。
              优先级：永远不看 &gt; 不要看（还叠加内置的反作弊游戏名单）&gt; 游戏，可以看。
            </p>
            <div className="pet-set__lists">
              <NameList title="永远不看" desc="这些程序在前台时，她完全不看画面。" names={pet.neverWatch} onAdd={addStrict('neverWatch')} onRemove={remove('neverWatch')} />
              <NameList title="不要看" desc="只聊天、不看画面。叠加在内置的反作弊游戏名单上。" names={pet.gameDeny} onAdd={addStrict('gameDeny')} onRemove={remove('gameDeny')} />
              <NameList title="游戏，可以看" desc="内置名单没认出来的游戏，加在这里她才会看它的画面。" names={pet.gameAllow} onAdd={addAllow} onRemove={remove('gameAllow')} />
            </div>
          </Group>

          <Group icon={Radio} title="实时陪玩">
            <div className="callout callout--info" role="note">
              <Info size={16} aria-hidden className="callout__icon" />
              <div className="callout__body">
                <p className="callout__title">边玩边用语音聊</p>
                <p className="callout__text">
                  开着时她听着你的麦克风：你说完一句，她马上回答，问到画面时会带上此刻的游戏画面。识别你说的话用 ElevenLabs，回答用你在「模型接入」里接的 API 模型；回答读出来用上面「语音」里选的服务（需要打开「让她开口说话」，否则只显示在气泡里）；
                  <strong>大约每小时几元</strong>，取决于聊多少和用的模型。麦克风里听起来像说话的声音（也包括游戏里的人声、旁边的人）会被送去 ElevenLabs 识别，安静时不发麦克风的声音（连接保持期间只发不含声音的保活包）。从桌宠的「实时」按钮或右键菜单开始和结束；默认关。
                </p>
              </div>
            </div>
            <LiveNeeds />
            <Row title="怎么听" desc={pet.realtime.listen === 'key'
              ? `按 ${pet.hotkeyAsk} 后说一句话，说完自动停。外放声音或游戏很吵时用这个，免得把游戏里的人声当成你在说话。`
              : '你一开口她就在听，说完一句就回答；她说话时你开口会打断她。建议戴耳机。'}>
              <Segmented<'auto' | 'key'> label="怎么听" options={LISTEN} value={pet.realtime.listen} onChange={(v) => set({ realtime: { listen: v } })} />
            </Row>
            <Slider label="灵敏度" value={pet.realtime.sensitivity} min={0} max={100} step={5} onChange={(v) => set({ realtime: { sensitivity: v } })}
              description="越高越容易听到小声说话，也越容易把杂音当成说话；游戏声音大时调低一些。" />
            <Switch label="更快开口" description="她的回答用 ElevenLabs Flash v2.5 来读：开口快大约半秒，音质比你选的模型略逊。只对 ElevenLabs 有效。"
              checked={pet.realtime.fastVoice} onChange={(v) => set({ realtime: { fastVoice: v } })} />
            <Row title="自动结束" desc="这么久没听到你说话就自动结束，免得忘了关。5 到 120 分钟。">
              <CommitInput label="自动结束（分钟）" unit="分钟" inputMode="numeric" className="pet-set__num"
                {...asInt(pet.realtime.autoOffMin, 5, 120)} onCommit={(v) => set({ realtime: { autoOffMin: Number(v) } })} />
            </Row>
            <p className="pet-set__hint">
              外放时她自己的声音和游戏声会漏进麦克风，戴耳机最稳；不方便时用「按键说一句」。开始实时陪玩后如果游戏声音突然变小，是 Windows 的通信闪避：
              到 控制面板 › 声音 › 通信，选「不执行任何操作」。语音识别的连接目前不走系统代理，需要代理才能访问 ElevenLabs 的网络会连不上。
            </p>
          </Group>
        </div>
      </fieldset>
    </Panel>
  );
}
