/* 模型接入页的工具条（MODELS-SPEC §14.1–§14.3）：搜索框、「＋ 添加服务」、「探测本机」、分组页签（带计数）、「显示未核实的预设」。
   搜索框对输入法是安全的：拼音还没上屏时不过滤（composedText：compositionend 或普通输入才更新），组合期间 Enter / Esc 归输入法；
   Esc 清空，Ctrl+F 聚焦（页面里的快捷键，由 ModelsView 接）；结果数用 aria-live="polite" 报出来。 */
import { Plus, Radar, Search, X } from 'lucide-react';
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react';
import { guardEscape } from '../../../lib/ime';
import { Button } from '../../ui';
import { MenuSelect, useComposedText } from '../../ui/MenuSelect';
import { ChoiceTabs, type Choice } from './ChoiceTabs';
import { TAB_LABEL, TAB_ORDER, type TabId } from './browse';

export type AddKind = 'preset' | 'openai' | 'anthropic' | 'agent-registry' | 'agent-custom';

export interface SearchHandle { focus(): void; clear(): void }

export function ModelsToolbar({
  searchRef, onQuery, query, tab, onTab, counts, showUnverified, onShowUnverified, hiddenPresets, onAdd, onProbe, probing, desktop, resultText,
}: {
  searchRef?: Ref<SearchHandle>;
  /** The committed query (what filters). */
  query: string;
  onQuery: (q: string) => void;
  tab: TabId;
  onTab: (t: TabId) => void;
  counts: Record<TabId, number>;
  showUnverified: boolean;
  onShowUnverified: (v: boolean) => void;
  /** How many unchecked presets exist (the switch's label shows it). */
  hiddenPresets: number;
  onAdd: (kind: AddKind) => void;
  onProbe: () => void;
  probing: boolean;
  /** Without the desktop app nothing can be added or probed. */
  desktop: boolean;
  /** 「12 个结果」 (live region). */
  resultText: string;
}) {
  const text = useComposedText();
  const input = useRef<HTMLInputElement>(null);
  useImperativeHandle(searchRef, () => ({ focus: () => input.current?.focus(), clear: () => text.clear() }), [text.clear]); // eslint-disable-line react-hooks/exhaustive-deps
  // the committed text (not a half-typed pinyin) is what the page filters by
  useEffect(() => { onQuery(text.query); }, [text.query]); // eslint-disable-line react-hooks/exhaustive-deps
  // the page cleared the query from outside (「清除搜索」): empty the box too
  useEffect(() => { if (!query && text.query) text.clear(); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const options: Array<Choice<TabId>> = TAB_ORDER.map((t) => ({ value: t, label: TAB_LABEL[t], count: counts[t] }));
  const addOptions: Array<{ value: AddKind; label: string; sub?: string; disabled?: boolean }> = [
    { value: 'preset', label: '从预设选', sub: '在下面的列表里找一家' },
    { value: 'openai', label: '自定义 OpenAI 兼容', sub: '中转站、公司网关、本机的服务', disabled: !desktop },
    { value: 'anthropic', label: '自定义 Anthropic 兼容', sub: '提供 /v1/messages 的服务', disabled: !desktop },
    { value: 'agent-registry', label: '命令行代理 · 官方注册表', sub: '浏览并添加说 ACP 的命令行工具', disabled: !desktop },
    { value: 'agent-custom', label: '命令行代理 · 自定义命令', sub: '这等于让栖枝代你运行一个程序', disabled: !desktop },
  ];

  return (
    <div className="models-toolbar">
      <div className="models-toolbar__row">
        <div className="models-search">
          <label className="sr-only" htmlFor="models-search">搜索服务、模型、别名</label>
          <Search size={15} aria-hidden className="models-search__icon" />
          <input id="models-search" ref={input} type="search" className="input models-search__input" {...text.bind} placeholder="搜服务、模型、别名，拼音也行…" spellCheck={false} autoComplete="off"
            onKeyDown={(e) => { guardEscape(e, () => { if (text.draft) text.clear(); else input.current?.blur(); }); }} />
          {text.draft && <button type="button" className="models-search__clear" aria-label="清空搜索" onClick={() => { text.clear(); input.current?.focus(); }}><X size={14} aria-hidden /></button>}
        </div>
        <MenuSelect<AddKind> variant="chip" className="models-toolbar__add" icon={Plus} label="添加服务" value={'' as AddKind} display="添加服务" search={false} minWidth={300}
          options={addOptions} onChange={(v) => { if (v) onAdd(v); }} />
        <Button size="sm" variant="secondary" icon={Radar} busy={probing} disabled={!desktop} onClick={onProbe} title="看看这台电脑上有没有在运行的模型服务（Ollama、LM Studio…）。只访问 127.0.0.1，不带任何凭据。">探测本机</Button>
      </div>
      <div className="models-toolbar__row models-toolbar__row--tabs">
        <ChoiceTabs<TabId> size="sm" label="服务分组" value={tab} onChange={onTab} options={options} className={query ? 'is-searching' : undefined} />
        {hiddenPresets > 0 && (
          <label className="models-toolbar__switch" title="整条都还没有核实过的预设默认不显示，打开后带「未核实」标出来。">
            <input type="checkbox" checked={showUnverified} onChange={(e) => onShowUnverified(e.target.checked)} />
            显示未核实的预设（{hiddenPresets}）
          </label>
        )}
      </div>
      <p className="models-toolbar__count" aria-live="polite" role="status">{resultText}</p>
    </div>
  );
}
