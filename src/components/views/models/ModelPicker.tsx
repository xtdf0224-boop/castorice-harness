/* 模型选择（MODELS-SPEC §14.6）：可搜索的下拉，分区显示——置顶 ★ → 当前值 → 预设 → 实时 → 用输入的作为模型 ID。
   一行：显示名（id 为副行）· 上下文 · 小标 · ★。最多画 100 行（OpenRouter 的 469 项不会拖慢页面），其余靠搜索；
   头部是列表的状态（实时 · 6 分钟前 / 缓存 / 拉取失败的原因）和「刷新」；没有预设模型的服务，空态直接说「先拉取模型列表，或输入模型 ID」。
   键盘：↑↓ 选择，Enter 确认，Esc 关闭，Ctrl+Enter 置顶；输入法组合期间不过滤、不抢键（MenuSelect）。
   取回来的名字、备注都当纯文本渲染（I10）：这里没有任何 HTML 注入。 */
import { Cpu, RefreshCw } from 'lucide-react';
import { useMemo } from 'react';
import { isModelId } from '../../../lib/services';
import { MenuSelect, type MenuGroup, type MenuOption, type MenuTag } from '../../ui/MenuSelect';

export interface PickerModel {
  id: string;
  label?: string;
  note?: string;
  ctx?: number;
  status?: 'active' | 'preview' | 'retiring' | 'deprecated' | 'retired';
  retiresAt?: string;
  caps?: { tools?: boolean; vision?: boolean; reasoning?: boolean };
  source?: 'preset' | 'live' | 'user';
  /** A preset the account's own list does not have (lists are per account: not the same as retired). */
  unlisted?: boolean;
}

export interface ListMeta { at: number; source: 'live' | 'cache' | 'static'; stale?: boolean; error?: string; code?: string }

const MAX_ROWS = 100;
const ctxShort = (n: number) => (n >= 1_000_000 ? `${Math.floor(n / 100_000) / 10}M`.replace('.0M', 'M') : `${Math.round(n / 1000)}K`);

export function agoText(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return '刚刚';
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} 分钟前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小时前`;
  return `${Math.round(s / 86400)} 天前`;
}

/** The line at the top of the open list: where the list came from, or why it could not be fetched. */
export function listStateText(meta: ListMeta | undefined, refreshing: boolean, now = Date.now()): { text: string; tone: 'ok' | 'muted' | 'warn' } {
  if (refreshing) return { text: '正在拉取模型列表…', tone: 'muted' };
  if (!meta) return { text: '还没有拉取过实时列表', tone: 'muted' };
  if (meta.code === 'NO_KEY') return { text: '保存密钥后可以拉取模型列表', tone: 'muted' };
  if (meta.code === 'PLAN_KEY') return { text: '套餐通道不能拉取列表，请手动填写模型 ID', tone: 'muted' };
  if (meta.code === 'NO_LIST') return { text: '这个服务没有模型列表接口，请手动填写模型 ID', tone: 'muted' };
  if (meta.error) return { text: `实时列表拉取失败：${meta.error}${meta.source === 'cache' ? ' · 先用缓存' : ''}`, tone: 'warn' };
  if (meta.source === 'live') return { text: `实时 · ${agoText(meta.at, now)}`, tone: 'ok' };
  if (meta.source === 'cache') return { text: meta.stale ? `缓存 · ${agoText(meta.at, now)}，已过期` : `缓存 · ${agoText(meta.at, now)}`, tone: 'muted' };
  return { text: '只有内置的模型，没有实时列表', tone: 'muted' };
}

const tagsOf = (m: PickerModel, inLiveSection: boolean): MenuTag[] => {
  const t: MenuTag[] = [];
  if (m.status === 'preview') t.push({ text: '预览', tone: 'info' });
  if (m.status === 'retiring' || m.status === 'deprecated') t.push({ text: '将下线', tone: 'warning', title: m.retiresAt ? `预计 ${m.retiresAt} 下线` : '厂商已宣布弃用' });
  if (m.caps?.vision) t.push({ text: '支持图片' });
  if (m.caps?.tools) t.push({ text: '工具' });
  // the 实时 section already says it; a live model that sits in 置顶 / 当前 carries the tag
  if (m.source === 'live' && !inLiveSection) t.push({ text: '实时', tone: 'success' });
  if (m.unlisted) t.push({ text: '此账号列表里没有', tone: 'warning', title: '列表按账号过滤：不在列表里不代表已下线，仍可以选' });
  return t;
};

/** One model → one menu row (value = the model id). */
export function pickerOption(m: PickerModel, pin?: { on: boolean; toggle: (id: string, on: boolean) => void }, inLiveSection = false): MenuOption {
  const label = m.label ?? m.id;
  return {
    value: m.id,
    label,
    sub: label !== m.id ? m.id : (m.note || undefined),
    meta: [m.label && m.note ? m.note : '', m.ctx ? ctxShort(m.ctx) : ''].filter(Boolean).join(' · ') || undefined,
    keywords: `${m.id} ${m.note ?? ''}`,
    tags: tagsOf(m, inLiveSection),
    star: pin ? { on: pin.on, label: pin.on ? `取消置顶 ${label}` : `置顶 ${label}`, onToggle: () => pin.toggle(m.id, !pin.on) } : undefined,
  };
}

/** The sections of the open list: 置顶 → 当前 → 预设 → 实时. A model appears once (pinned beats current beats the rest). */
export function buildPickerGroups(models: PickerModel[], opts: { value: string; pinned?: string[]; onPin?: (id: string, on: boolean) => void }): Array<MenuGroup> {
  const pins = opts.pinned ?? [];
  const byId = new Map(models.map((m) => [m.id, m]));
  const used = new Set<string>();
  const row = (m: PickerModel, inLive = false) => pickerOption(m, opts.onPin ? { on: pins.includes(m.id), toggle: opts.onPin } : undefined, inLive);
  const groups: MenuGroup[] = [];
  const pinnedRows = pins.map((id) => byId.get(id)).filter((m): m is PickerModel => !!m);
  if (pinnedRows.length) { groups.push({ label: '置顶', options: pinnedRows.map((m) => row(m)) }); pinnedRows.forEach((m) => used.add(m.id)); }
  if (opts.value && !used.has(opts.value)) {
    const cur = byId.get(opts.value) ?? { id: opts.value, source: 'user' as const };
    groups.push({ label: '当前', options: [row(cur)] });
    used.add(opts.value);
  }
  const preset = models.filter((m) => !used.has(m.id) && m.source !== 'live');
  const live = models.filter((m) => !used.has(m.id) && m.source === 'live');
  if (preset.length) groups.push({ label: '预设', options: preset.map((m) => row(m)) });
  if (live.length) groups.push({ label: `实时 · ${live.length}`, options: live.map((m) => row(m, true)) });
  return groups;
}

export function ModelPicker({
  id, label, value, onChange, models, pinned, onPin, meta, refreshing, onRefresh, onOpen, disabled, allowEmpty, emptyOption, minWidth = 340, contextHint,
}: {
  id?: string;
  label: string;
  /** The model id in use ('' = the tool's own default, with `emptyOption`). */
  value: string;
  onChange: (model: string) => void;
  models: PickerModel[];
  pinned?: string[];
  onPin?: (model: string, on: boolean) => void;
  meta?: ListMeta;
  refreshing?: boolean;
  /** Fetch the live list again (the 刷新 button). Absent = this list has no live source (a command-line tool's own list). */
  onRefresh?: () => void;
  /** The list was opened (the owner can bring the cache up to date). */
  onOpen?: () => void;
  disabled?: boolean;
  /** An empty model id is allowed (command-line tools: 「默认」). */
  allowEmpty?: boolean;
  emptyOption?: { label: string; sub?: string };
  minWidth?: number;
  contextHint?: string;
}) {
  const groups = useMemo<MenuGroup[]>(() => {
    const g = buildPickerGroups(models, { value, pinned, onPin });
    if (allowEmpty && emptyOption) g.unshift({ options: [{ value: '', label: emptyOption.label, sub: emptyOption.sub, icon: Cpu }] });
    return g;
  }, [models, value, pinned, onPin, allowEmpty, emptyOption]);
  const current = models.find((m) => m.id === value);
  const shown = value ? (current?.label ?? value) : (emptyOption?.label ?? '');
  const state = onRefresh ? listStateText(meta, !!refreshing) : undefined;
  const noModels = models.length === 0;

  const top = onRefresh && state ? (
    <div className="picker-top">
      <span className={`picker-top__state picker-top__state--${state.tone}`} role="status">{state.text}</span>
      <button type="button" className="picker-top__btn" onClick={onRefresh} disabled={refreshing}>
        <RefreshCw size={12} aria-hidden className={refreshing ? 'spin' : undefined} />刷新
      </button>
    </div>
  ) : undefined;

  return (
    <MenuSelect
      variant="field" id={id} label={label} icon={Cpu} value={value} groups={groups} display={shown || undefined} placeholder="选择模型，或输入模型 ID" title={contextHint}
      onChange={onChange} disabled={disabled} searchable searchPlaceholder="搜索模型，或输入模型 ID…" maxRows={MAX_ROWS} minWidth={minWidth} popClassName="mselect-pop--wide"
      top={top} onOpenChange={(o) => { if (o) onOpen?.(); }}
      typed={{ accept: (q) => isModelId(q), label: (q) => `用「${q}」作为模型 ID`, sub: '这个服务不一定认识它，测试连接可以确认' }}
      empty={noModels ? <span className="picker-empty">{onRefresh ? '先拉取模型列表，或输入模型 ID' : '没有预设的模型，输入模型 ID 即可'}</span> : undefined}
      footer={<span className="picker-foot">↑↓ 选择 · Enter 确认{onPin ? ' · Ctrl+Enter 置顶' : ''} · Esc 关闭</span>}
    />
  );
}
