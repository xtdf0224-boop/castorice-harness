/* 模型接入: every model service the app knows (a few dozen presets, the custom ones you add, the command-line agents), each usable through its
   CLI (account login) or an API key, with the model and 推理强度 each one starts with, plus the service new 闲聊 / 工作 start on.
   Model calls only work in the desktop app.

   How it stays calm with dozens of services (MODELS-SPEC §14): the ones you have set up are on top as full cards; every other service is one compact
   row, grouped (国际 / 国内 / 聚合与云 / 本地 / 命令行) and foldable; a search finds them by name, vendor, alias, model or pinyin; a row opens in place into
   the full card (one at a time). Nothing is contacted by opening this page except — for services that are already set up — a refresh of their model
   lists (switchable off here). */
import { ChevronDown, Cpu, Plus, Radar, ShieldCheck, Sparkles, Star, Terminal, TriangleAlert, KeyRound, SearchX } from 'lucide-react';
import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { DRIVERS, PROVIDERS, PROVIDER_BY_ID, allProviders, modelName } from '../../lib/providers';
import { servicesVersion, subscribeServices, type ProbeFound } from '../../lib/services';
import { isComposingEvent } from '../../lib/ime';
import type { ProviderId } from '../../lib/types';
import { defaultChoice, engineChoices, modelActions, refreshModels } from '../../state/models';
import { adoptProbe, probeLocalServers, refreshConfiguredLists } from '../../state/services';
import { useApp } from '../../state/store';
import '../../styles/models-agents.css';
import '../../styles/models-services.css';
import { Badge, Button, EmptyState, Panel, Switch, cx } from '../ui';
import { MenuSelect } from '../ui/MenuSelect';
import { ViewHeader } from './config/ViewHeader';
import { AgentPane } from './models/AgentPane';
import { useAgentsVersion } from '../../state/agents';
import { GROUP_LABEL, buildBrowse, defaultTab, type GroupSection, type Row, type TabId } from './models/browse';
import { ModelsToolbar, type AddKind, type SearchHandle } from './models/ModelsToolbar';
import { ConnectedTile } from './models/ConnectedTile';
import { ProviderCard } from './models/ProviderCard';
import { getPrefs, setPrefs, usePrefs } from './models/prefs';
import { ServiceEditor } from './models/ServiceEditor';
import { ServiceTile } from './models/ServiceTile';

/** MB3's AgentPane may listen for this to open its 「注册表」 / 「自定义命令」 dialogs (the 「添加服务」 menu has those two entries). */
export const AGENT_ADD_EVENT = 'alight:models-agent-add';

export function ModelsView() {
  const models = useApp((s) => s.models);
  const prefs = usePrefs();
  useSyncExternalStore(subscribeServices, servicesVersion, servicesVersion);
  useAgentsVersion();
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [expanded, setExpanded] = useState<{ id: string; wasConnected: boolean } | null>(null);
  const [editor, setEditor] = useState<{ protocol: 'openai-chat' | 'anthropic' } | null>(null);
  const [probe, setProbe] = useState<{ busy: boolean; found?: ProbeFound[] }>({ busy: false });
  const search = useRef<SearchHandle>(null);
  // the tab nobody chose yet (「已接入」 when something is connected, else 「全部」) is decided once the desktop side has answered and then stays — the page
  // must not jump to another tab because the person has just saved their first key
  const [settled, setSettled] = useState(false);
  const firstTab = useRef<TabId | null>(null);

  // opening the page: read the desktop side, then (for services that are already set up) bring their model lists up to date — two at a time, quietly
  useEffect(() => {
    let alive = true;
    void (async () => {
      await refreshModels();
      if (alive) setSettled(true);
      if (alive && getPrefs().autoRefresh) await refreshConfiguredLists({ concurrency: 2 });
    })();
    return () => { alive = false; };
  }, []);

  // Ctrl+F finds a service (not the browser's: there is none in the app)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f' && !isComposingEvent(e)) { e.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const choices = engineChoices(models);
  const providers = useMemo(() => allProviders(), [models.customMirror, servicesVersion()]); // eslint-disable-line react-hooks/exhaustive-deps
  const defaultProvider = defaultChoice(models, choices)?.provider;
  const hiddenPresets = providers.filter((p) => p.hidden).length;
  const base = { providers, models, defaultProvider, showUnverified: prefs.showUnverified, keepInPlace: expanded ?? undefined };
  const overview = useMemo(() => buildBrowse({ ...base, tab: 'all', query: '' }), [providers, models, defaultProvider, prefs.showUnverified, expanded]); // eslint-disable-line react-hooks/exhaustive-deps
  if (settled && !prefs.tab && firstTab.current === null) firstTab.current = defaultTab(overview);
  const tab: TabId = prefs.tab ?? (settled ? firstTab.current ?? 'all' : defaultTab(overview));
  const browse = useMemo(() => buildBrowse({ ...base, tab, query: deferredQuery }), [providers, models, defaultProvider, prefs.showUnverified, expanded, tab, deferredQuery]); // eslint-disable-line react-hooks/exhaustive-deps
  const searching = deferredQuery.trim().length > 0;

  const options = PROVIDERS.flatMap((p) => {
    const mine = choices.filter((c) => c.provider === p.id);
    if (!mine.length) return [];
    return [{
      value: p.id as string,
      label: p.name,
      sub: mine.map((c) => (c.auth === 'api' ? 'API 密钥' : DRIVERS[c.driver ?? p.drivers[0]]?.label ?? '命令行')).join(' · '),
      meta: mine[0].model ? modelName(p, mine[0].model) : '工具默认模型',
    }];
  });
  const current = defaultChoice(models, choices)?.provider ?? '';

  /* ───────────── actions ───────────── */

  const openRow = (r: Row) => setExpanded({ id: r.p.id, wasConnected: false });
  const collapse = (id: string) => {
    setExpanded(null);
    // focus goes back to the row that opened it (it is a row again once the card folds)
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`.svc-tile[data-service="${id}"], .conn-tile[data-service="${id}"] .conn-tile__main`)?.focus());
  };
  const setTab = (t: TabId) => { setPrefs({ tab: t }); setExpanded(null); };
  const toggleGroup = (key: string) => { const c = { ...getPrefs().collapsed }; if (c[key]) delete c[key]; else c[key] = true; setPrefs({ collapsed: c }); };

  const onAdd = (kind: AddKind) => {
    if (kind === 'preset') { setTab('all'); search.current?.focus(); return; }
    if (kind === 'openai' || kind === 'anthropic') { setEditor({ protocol: kind === 'openai' ? 'openai-chat' : 'anthropic' }); return; }
    setTab('cli');
    // MB3's AgentPane may open its registry / custom-command dialog
    requestAnimationFrame(() => window.dispatchEvent(new CustomEvent(AGENT_ADD_EVENT, { detail: { mode: kind === 'agent-registry' ? 'registry' : 'custom' } })));
  };

  const runProbe = async () => {
    setProbe({ busy: true });
    const found = await probeLocalServers();
    setProbe({ busy: false, found });
  };
  const adopt = (f: ProbeFound) => {
    const id = adoptProbe(f);
    if (!id) return;
    setPrefs({ tab: 'local' });
    setQuery('');
    setExpanded({ id, wasConnected: false });
  };

  const startClaudeCli = () => {
    modelActions.set('claude', { auth: 'cli' });
    setPrefs({ tab: 'intl' });
    setExpanded({ id: 'claude', wasConnected: false });
  };

  // an opened service scrolls into view and takes focus (the page may have been long)
  useEffect(() => {
    if (!expanded) return;
    const raf = requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`[data-provider="${expanded.id}"]`);
      card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      card?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [expanded?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ───────────── pieces ───────────── */

  // 已接入的服务：默认是一行摘要（≥ 860 px 排两列），点开的那一家才是完整配置卡（占满一整行）
  const cards = (rows: Row[]) => (
    <div className="models-grid">
      {rows.map((r) => (expanded?.id === r.p.id
        ? <div key={r.p.id} className="models-grid__open"><ProviderCard info={r.p} disabled={!models.desktop} onCollapse={() => collapse(r.p.id)} /></div>
        : <ConnectedTile key={r.p.id} info={r.p} disabled={!models.desktop} onOpen={() => setExpanded({ id: r.p.id, wasConnected: true })} />))}
    </div>
  );

  const groupBody = (g: GroupSection) => (
    <>
      {g.connectedHere.length > 0 && tab !== 'all' && !searching && (
        <div className="svc-group__connected">
          <p className="svc-group__sub">已接入 · {g.connectedHere.length}</p>
          {cards(g.connectedHere)}
        </div>
      )}
      {g.group === 'cli' ? <AgentPane query={searching ? deferredQuery : ''} disabled={!models.desktop} /> : (
        <div className="svc-rows" role="list">
          {g.rows.map((r) => (
            <div key={r.p.id} role="listitem" className={cx('svc-row', expanded?.id === r.p.id && 'is-open')}>
              {expanded?.id === r.p.id && !expanded.wasConnected
                ? <ProviderCard info={r.p} disabled={!models.desktop} onCollapse={() => collapse(r.p.id)} />
                : <ServiceTile row={r} query={deferredQuery} onOpen={() => openRow(r)} />}
            </div>
          ))}
        </div>
      )}
    </>
  );

  const showConnected = tab === 'connected' || tab === 'all';
  const visibleGroups = browse.groups.filter((g) => {
    if (searching) return g.rows.length > 0 || (g.group === 'cli' && (g.agents ?? 0) > 0);
    if (tab === 'all') return true;
    return g.group === tab;
  });
  const noMatches = searching && browse.matches === 0;
  const resultText = searching ? (browse.matches ? `${browse.matches} 个结果` : '没有结果') : '';

  const start = choices.length === 0 && models.desktop;

  return (
    <div className="view models-view">
      <ViewHeader icon={Cpu} title="模型接入" desc="官方命令行登录账号，或保存 API 密钥；接好的排在最上面，其余按分组收着，搜名字、模型或别名都行。" />

      {!models.desktop && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body">
            <p className="callout__text">浏览器开发版不能调用模型，也不能保存密钥。请使用桌面版（安装包，或在源码目录运行 <code>npm run app</code>）。</p>
          </div>
        </div>
      )}
      {models.desktop && !models.encryption && (
        <div className="callout callout--warning" role="note">
          <TriangleAlert size={18} aria-hidden className="callout__icon" />
          <div className="callout__body"><p className="callout__text">系统加密不可用，暂时无法保存 API 密钥；命令行登录不受影响。</p></div>
        </div>
      )}

      {start ? (
        <Panel label="开始" title="先接入第一个模型" icon={Sparkles} energy className="models-start">
          <p className="models-start__lead">还没有接入任何模型……阁下想先从哪一条路开始？</p>
          <div className="models-start__ways">
            <button type="button" className="models-start__way" onClick={startClaudeCli}>
              <Terminal size={18} aria-hidden /><b>我有 Claude / ChatGPT 订阅</b><small>用官方命令行工具登录账号，不需要密钥</small>
            </button>
            <button type="button" className="models-start__way" onClick={() => { setTab('all'); search.current?.focus(); }}>
              <KeyRound size={18} aria-hidden /><b>我有 API 密钥</b><small>在下面搜一家，粘贴密钥即可</small>
            </button>
            <button type="button" className="models-start__way" onClick={() => void runProbe()}>
              <Radar size={18} aria-hidden /><b>我想用本机模型</b><small>探测这台电脑上的 Ollama、LM Studio…</small>
            </button>
          </div>
        </Panel>
      ) : (
        <div className="models-default panel" title="新建闲聊和工作时先选这一家，也可以临时换成别的。只有已经接好的服务会出现在这里。">
          <span className="models-default__label"><Star size={14} aria-hidden />新建时默认使用</span>
          {options.length > 0 ? (
            <>
              <label className="sr-only" htmlFor="models-default">新建闲聊和工作时默认使用的模型</label>
              <div className="models-default__select">
                <MenuSelect variant="field" id="models-default" label="新建时默认使用" icon={Cpu} value={current} options={options}
                  onChange={(v) => modelActions.setDefault(v as ProviderId)} minWidth={300} />
              </div>
              <Badge tone="success">{options.length} 家可用</Badge>
            </>
          ) : (
            <>
              <p className="models-default__empty">还没有可用的模型，先在下面接入一个</p>
              <Badge tone="neutral">还没有接入</Badge>
            </>
          )}
        </div>
      )}

      <ModelsToolbar
        searchRef={search} query={query} onQuery={setQuery} tab={tab} onTab={setTab} counts={overview.counts}
        showUnverified={prefs.showUnverified} onShowUnverified={(v) => setPrefs({ showUnverified: v })} hiddenPresets={hiddenPresets}
        onAdd={onAdd} onProbe={() => void runProbe()} probing={probe.busy} desktop={models.desktop} resultText={resultText}
      />

      {probe.found && (
        <div className={cx('callout', probe.found.length ? 'callout--success' : 'callout--neutral')} role="status">
          <Radar size={18} aria-hidden className="callout__icon" />
          <div className="callout__body">
            {probe.found.length === 0
              ? <p className="callout__text">这台电脑上没有发现在运行的模型服务（看了 Ollama、LM Studio、llama.cpp 等常用端口，只访问 127.0.0.1）。先把服务启动起来再试一次。</p>
              : probe.found.map((f) => (
                <p key={`${f.service}-${f.port}`} className="callout__text models-probe__row">
                  <span>在 {f.port} 发现 <b>{PROVIDER_BY_ID[f.service].name}</b>，{f.models.length} 个模型</span>
                  <Button size="sm" variant="secondary" onClick={() => adopt(f)}>接入</Button>
                </p>
              ))}
          </div>
          <div className="callout__actions"><Button size="sm" variant="ghost" onClick={() => setProbe({ busy: false })}>知道了</Button></div>
        </div>
      )}

      {noMatches && (
        <EmptyState icon={SearchX} title={`没有找到「${deferredQuery.trim()}」`}
          body={<>可以用「添加服务」接入任何 OpenAI / Anthropic 兼容的服务。{browse.hiddenMatches > 0 && <> 另有 {browse.hiddenMatches} 个未核实的预设匹配。</>}</>}
          actions={(
            <>
              <Button size="sm" variant="secondary" icon={Plus} disabled={!models.desktop} onClick={() => setEditor({ protocol: 'openai-chat' })}>添加 OpenAI 兼容服务</Button>
              {browse.hiddenMatches > 0 && <Button size="sm" variant="ghost" onClick={() => setPrefs({ showUnverified: true })}>显示未核实的预设</Button>}
              <Button size="sm" variant="ghost" onClick={() => { search.current?.clear(); setQuery(''); }}>清除搜索</Button>
            </>
          )} />
      )}
      {searching && browse.matches > 0 && browse.hiddenMatches > 0 && (
        <p className="models-hidden-hint">另有 {browse.hiddenMatches} 个未核实的预设匹配，<button type="button" className="link-button" onClick={() => setPrefs({ showUnverified: true })}>显示它们</button>。</p>
      )}

      {showConnected && !noMatches && (browse.connected.length > 0 || (tab === 'connected' && !searching)) && (
        <section className="svc-group svc-group--connected" aria-labelledby="svc-connected">
          <h2 id="svc-connected" className="svc-group__title svc-group__title--static">已接入<small>{browse.connected.length}</small></h2>
          {browse.connected.length > 0 ? cards(browse.connected) : (
            <EmptyState compact icon={Cpu} title="还没有接入任何服务" body="在「全部」里挑一家，或者用上面的「添加服务」。" actions={<Button size="sm" variant="secondary" onClick={() => setTab('all')}>去看全部服务</Button>} />
          )}
        </section>
      )}

      {!noMatches && visibleGroups.map((g) => {
        const key = g.group;
        const folded = !searching && !!prefs.collapsed[key];
        const bodyId = `svc-body-${key}`;
        const count = g.group === 'cli' ? (g.agents ?? 0) : g.rows.length;
        const label = g.group === 'cli' ? `${count} 个` : count === g.total ? `${count} 家` : `还可接入 ${count}`;
        // a group tab with nothing left to add
        if (!searching && tab !== 'all' && g.group !== 'cli' && g.rows.length === 0 && g.connectedHere.length === 0) return null;
        return (
          <section key={key} className="svc-group" aria-labelledby={`svc-h-${key}`} data-group={key}>
            <h2 id={`svc-h-${key}`} className="svc-group__title">
              <button type="button" className="svc-group__toggle" aria-expanded={!folded} aria-controls={bodyId} onClick={() => toggleGroup(key)}>
                <ChevronDown size={14} aria-hidden className="svc-group__chev" />{GROUP_LABEL[g.group]}<small>{label}</small>
              </button>
            </h2>
            {!folded && <div id={bodyId} className="svc-group__body">{groupBody(g)}</div>}
          </section>
        );
      })}

      <section className="models-opts" aria-label="页面选项">
        <Switch checked={prefs.autoRefresh} onChange={(v) => setPrefs({ autoRefresh: v })} label="打开本页时刷新已接入服务的模型列表"
          description="只会联系已经接好（保存了密钥或不需要密钥）的服务，而且只在缓存过期时请求；没接入的服务一概不碰。" />
      </section>

      <p className="models-foot">
        <ShieldCheck size={14} aria-hidden />
        <span>
          API 密钥由系统加密（Windows DPAPI）保存在本机的应用数据目录，不写入浏览器存储，界面上只显示末四位。命令行登录由各工具自己保存，栖枝不会读取你的账号密码或登录令牌。
          使用真实模型会按各服务商的价格计费，或消耗你的订阅额度。取回来的模型列表只当文字显示，不当指令。
        </span>
      </p>

      {editor && (
        <ServiceEditor protocol={editor.protocol} onClose={() => setEditor(null)}
          onSaved={(id, test) => {
            setPrefs({ tab: 'connected' });
            setQuery('');
            setExpanded({ id, wasConnected: true });
            if (test) void modelActions.test(id, 'api');
          }} />
      )}
    </div>
  );
}

