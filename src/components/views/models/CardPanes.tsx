/* ProviderCard 的两个窗格和几个字段：命令行方式（CliPane）、API 方式（ApiPane）、模型（ModelField）、推理强度（EffortField）。
   旧的八家卡片里有的都还在，体验不变；新增的是：服务地区 / 占位符、模型选择器（置顶、搜索、实时列表）、
   上下文提示（含本机服务的「至少 32K」警告）、「默认（最高）」文案、代理的安装提示与「探测能力」。 */
import { CheckCircle2, ExternalLink, Gauge, Layers, LogIn, RefreshCw, Terminal, TriangleAlert, XCircle } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { desktop } from '../../../lib/desktop';
import type { Effort } from '../../../lib/effort';
import { EFFORT_HINT, EFFORT_LABEL } from '../../../lib/effort';
import { DRIVERS, contextOf, ctxLabel, driverOf, regionOf, type ProviderInfo } from '../../../lib/providers';
import { AGENT_DEFS, DRIVER_DEFS, isPresetId, type AcpAgentDef, type AcpProbeResult } from '../../../lib/services';
import type { AuthMode, DriverId, ModelState, ProviderConfig } from '../../../lib/types';
import { apiDefaultEffortLabel, choiceEfforts, modelActions, modelOptions } from '../../../state/models';
import { probeOf, runProbe as runAgentProbe, useAgentsVersion } from '../../../state/agents';
import { pinModel, refreshModelList } from '../../../state/services';
import { Badge, Button, CopyButton, cx } from '../../ui';
import { MenuSelect } from '../../ui/MenuSelect';
import { ClaudeAuthPane } from './ClaudeAuthPane';
import { EndpointField } from './EndpointField';
import { KeyField } from './KeyField';
import { ModelPicker, type PickerModel } from './ModelPicker';

/* ───────────── 命令行 ───────────── */

/** The agent definition behind a driver id (`acp:<id>`, or the first release's kimi / qwen / mcode). */
export const agentOf = (driver: string): AcpAgentDef | undefined => AGENT_DEFS.find((a) => `acp:${a.id}` === driver || a.legacyDriver === driver);

const PROBE_FEATURES: Array<[keyof AcpProbeResult['caps'], string]> = [['loadSession', '读取旧会话'], ['resume', '恢复会话'], ['configOptions', '会话配置选项'], ['image', '图片'], ['mcpHttp', 'HTTP MCP']];

export function CliPane({ info, cfg, models, disabled, busy, onDetect }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; disabled: boolean; busy: boolean; onDetect: () => void }) {
  const ids = useId();
  const d = driverOf(cfg.driver);
  const cli = cfg.cli;
  const agent = agentOf(cfg.driver);
  const drv = DRIVER_DEFS.find((x) => x.id === cfg.driver);
  const canLogin = d.auth === 'account' && (!!drv?.loginArgs?.length || !!agent?.auth.loginArgs?.length);
  const usesVendorKey = d.auth === 'key';
  // The probe's result is shared with the 命令行 group (state/agents.ts): one answer in one place; 「读取模型与模式」 also fills the model menus.
  useAgentsVersion();
  const probe = agent ? probeOf(agent.id) : undefined;

  // Changing the tool resets the model to that tool's first suggestion (see modelActions.set), so the saved 强度 may no longer fit.
  const onDriver = (driver: DriverId) => {
    const model = info.cliModels[driver]?.[0]?.id ?? '';
    modelActions.set(info.id, { driver, ...effortReset(models, cfg, 'cli', driver, model) });
  };

  return (
    <div className="model-pane">
      {info.drivers.length > 1 ? (
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-drv`}>命令行工具</label>
          <MenuSelect<DriverId> variant="field" id={`${ids}-drv`} label="命令行工具" icon={Terminal} value={cfg.driver} disabled={disabled}
            options={info.drivers.map((id) => ({ value: id, label: DRIVERS[id]?.label ?? id, sub: DRIVERS[id]?.auth === 'account' ? '用账号登录' : '用这家的 API Key' }))}
            onChange={onDriver} />
        </div>
      ) : (
        <p className="model-pane__driver"><Terminal size={14} aria-hidden /><strong>{d.label}</strong><span>{d.auth === 'account' ? '账号登录' : '用 API Key'}</span></p>
      )}
      <p className="model-pane__note">{d.note}</p>

      <div className={cx('model-cli', cli && (cli.found ? 'is-found' : 'is-missing'))}>
        <div className="model-cli__state">
          {!cli && <span className="model-card__muted">还没有检测</span>}
          {cli && !cli.found && <span><XCircle size={14} aria-hidden /> 没有找到 {d.bin}{cli.detail ? `：${cli.detail}` : ''}</span>}
          {cli?.found && cli.detail && <span className="model-card__muted" role="note">{cli.detail}</span>}
          {cli?.found && (
            <span className="model-cli__found">
              <CheckCircle2 size={14} aria-hidden />
              <span className="mono truncate" title={cli.path}>{cli.version || d.bin}</span>
              {cli.login === 'yes' && <Badge tone="success">已登录{cli.account ? ` · ${cli.account}` : ''}</Badge>}
              {cli.login === 'no' && <Badge tone="warning">未登录</Badge>}
              {cli.login === 'unknown' && d.auth === 'account' && <Badge tone="neutral" title="这个工具不报告登录状态，测试一次连接即可确认">登录状态未知</Badge>}
            </span>
          )}
        </div>
        <div className="model-cli__actions">
          <Button size="sm" variant="ghost" icon={RefreshCw} busy={busy} disabled={disabled} onClick={onDetect}>检测</Button>
          {agent && desktop?.acp && cli?.found && <Button size="sm" variant="ghost" icon={Gauge} busy={probe?.state === 'busy' && !probe.deep} disabled={disabled || probe?.state === 'busy'} onClick={() => void runAgentProbe(agent.id, false)} title="只发一次 initialize，不开会话，不花额度">探测能力</Button>}
          {agent && desktop?.acp && cli?.found && <Button size="sm" variant="ghost" icon={Layers} busy={probe?.state === 'busy' && probe.deep} disabled={disabled || probe?.state === 'busy'} onClick={() => void runAgentProbe(agent.id, true)} title="开一次会话，读出它自己的模型、推理强度和模式；不发提问，不花额度">读取模型与模式</Button>}
          {canLogin && cfg.driver !== 'claude-code' && cli?.found && <Button size="sm" variant={cli.login === 'no' ? 'primary' : 'ghost'} icon={LogIn} disabled={disabled} onClick={() => void modelActions.login(info.id)}>登录</Button>}
        </div>
      </div>
      {probe?.state === 'done' && (
        <p className="model-pane__probe" role="status">
          {probe.result.ok
            ? <>它会：{PROBE_FEATURES.filter(([k]) => probe.result.caps[k]).map(([, t]) => t).join('、') || '只有最基本的对话'}{probe.result.authMethods.length ? ` · 登录方式 ${probe.result.authMethods.map((a) => a.id).join('、')}` : ''}</>
            : <>探测没有成功：{probe.result.error ?? '没有回应'}</>}
        </p>
      )}
      {probe?.state === 'error' && <p className="model-pane__probe model-pane__probe--bad" role="status">没能探测：{probe.error}</p>}
      {cli && !cli.found && <InstallHint driver={d.install} agent={agent} />}

      {cfg.driver === 'claude-code' && <ClaudeAuthPane info={info} cfg={cfg} disabled={disabled} />}
      {(usesVendorKey || cfg.driver === 'claude-compat') && info.regions.length > 1 && <EndpointField info={info} cfg={cfg} disabled={disabled} />}
      {usesVendorKey && <KeyField info={info} cfg={cfg} disabled={disabled} regionLabel={info.regions.some((r) => r.separateKey) ? regionOf(info, cfg).label : undefined} />}

      <ModelField info={info} cfg={cfg} models={models} auth="cli" disabled={disabled} />
      <EffortField info={info} cfg={cfg} models={models} auth="cli" disabled={disabled} />

      <details className="model-adv">
        <summary>高级</summary>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-p`}>命令路径<span className="model-field__opt">（不在 PATH 里时填写）</span></label>
          <input id={`${ids}-p`} className="input mono" value={cfg.cliPath} disabled={disabled} spellCheck={false} autoComplete="off"
            placeholder={`例如 C:\\…\\${d.bin}.cmd`} onChange={(e) => modelActions.set(info.id, { cliPath: e.target.value.trim() })} />
        </div>
        {cfg.driver === 'codex' && (
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-sb`}>Codex 沙箱</label>
            <MenuSelect<NonNullable<ProviderConfig['codexSandbox']>> variant="field" id={`${ids}-sb`} label="Codex 沙箱" value={cfg.codexSandbox ?? 'workspace-write'} disabled={disabled}
              options={[
                { value: 'workspace-write', label: '工作文件夹内可写', sub: '推荐' },
                { value: 'danger-full-access', label: '不使用沙箱', sub: 'Windows 沙箱起不来时才用' },
              ]}
              onChange={(v) => modelActions.set(info.id, { codexSandbox: v })} />
            {cfg.codexSandbox === 'danger-full-access' && <p className="model-field__hint model-field__hint--warn">不使用沙箱时，Codex 可以在整台电脑上执行命令。</p>}
          </div>
        )}
      </details>
    </div>
  );
}

/** Where to get the tool: an npm command (with a copy button), a script line, and the vendor's own remark. */
function InstallHint({ driver, agent }: { driver: string; agent?: AcpAgentDef }) {
  const npm = agent?.install.npm ? `npm install -g ${agent.install.npm}` : driver.startsWith('npm') ? driver : '';
  const script = agent?.install.script ?? (npm ? '' : driver);
  return (
    <div className="model-pane__install">
      {npm && <p><span>安装：</span><code className="mono">{npm}</code><CopyButton text={npm} label="复制安装命令" /></p>}
      {script && <p><span>{npm ? '或：' : '安装：'}</span><code className="mono">{script}</code></p>}
      {agent?.install.note && <p className="model-pane__install-note">{agent.install.note}</p>}
      {agent?.docsUrl && <p><a href={agent.docsUrl} target="_blank" rel="noreferrer">官方文档<ExternalLink size={11} aria-hidden /></a></p>}
    </div>
  );
}

/* ───────────── API ───────────── */

export function ApiPane({ info, cfg, models, disabled }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; disabled: boolean }) {
  const ids = useId();
  const region = regionOf(info, cfg);
  const preset = isPresetId(info.id);
  const override = models.overrides?.[info.id];
  const overridden = !!override && override.endpoint === cfg.region;
  return (
    <div className="model-pane">
      <EndpointField info={info} cfg={cfg} disabled={disabled} />
      <KeyField info={info} cfg={cfg} disabled={disabled} regionLabel={info.regions.length > 1 && info.regions.some((r) => r.separateKey) ? region.label : undefined} />
      <ModelField info={info} cfg={cfg} models={models} auth="api" disabled={disabled} />
      <EffortField info={info} cfg={cfg} models={models} auth="api" disabled={disabled} />
      {preset && (
        <details className="model-adv">
          <summary>高级</summary>
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-u`}>服务地址<span className="model-field__opt">（留空用官方地址）</span></label>
            <div className="model-key">
              <input id={`${ids}-u`} className="input mono" value={cfg.baseUrl} disabled={disabled} spellCheck={false} autoComplete="off"
                placeholder={region.baseUrl} onChange={(e) => modelActions.set(info.id, { baseUrl: e.target.value.trim() })} />
              {(cfg.baseUrl || overridden) && <Button size="sm" variant="ghost" disabled={disabled} onClick={() => modelActions.set(info.id, { baseUrl: '' })}>恢复默认地址</Button>}
            </div>
            <p className="model-field__hint">改了地址，已保存的密钥就会发往新地址：换主机时栖枝会先问你。</p>
          </div>
        </details>
      )}
    </div>
  );
}

/* ───────────── 模型 / 推理强度 ───────────── */

/** The change that drops the saved 推理强度 when the new model (or tool) does not offer it. */
export function effortReset(models: ModelState, cfg: ProviderConfig, auth: AuthMode, driver: DriverId | undefined, model: string): Partial<Pick<ProviderConfig, 'effort' | 'cliEffort'>> {
  const saved = auth === 'api' ? cfg.effort : cfg.cliEffort;
  if (!saved || choiceEfforts(models, { provider: cfg.id, auth, driver }, model).includes(saved)) return {};
  return auth === 'api' ? { effort: undefined } : { cliEffort: undefined };
}

const short = (n: number) => (n >= 1_000_000 ? `${Math.floor(n / 100_000) / 10}M`.replace('.0M', 'M') : `${Math.round(n / 1000)}K`);

/** The line under the model menu: its context window; a warning when a local server's window is too small for an agent (§14.4). */
export function contextNote(info: ProviderInfo, model: string, tool?: string): { text: string; known?: boolean; warn?: boolean } | undefined {
  if (!model) return tool ? { text: `${tool} 自己选模型，上下文窗口随模型而定` } : undefined;
  const ctx = contextOf(info, model);
  const below = info.def.flags?.ctxWarnBelow;
  if (below && ctx.tokens < below) {
    return { text: `${ctx.known ? '上下文' : '估算的上下文'}只有 ${short(ctx.tokens)}，做 Agent 至少要 32K${info.id === 'ollama' ? '：用环境变量 OLLAMA_CONTEXT_LENGTH 调大' : '：在这个服务里把上下文长度调大'}`, warn: true };
  }
  return ctx.known ? { text: ctxLabel(ctx.tokens), known: true } : { text: `没有收录这个模型的上下文窗口，按 ${short(info.defaultCtx)} 估算` };
}

/** 模型: the service's models (presets merged with its own list) in the picker; a command-line tool's own list without refresh or pins. */
export function ModelField({ info, cfg, models, auth, disabled }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; auth: AuthMode; disabled: boolean }) {
  const ids = useId();
  const api = auth === 'api';
  const current = api ? cfg.model : cfg.cliModel;
  const driver = api ? undefined : cfg.driver;
  const [refreshing, setRefreshing] = useState(false);

  const commit = (next: string) => {
    if (next === current) return;
    modelActions.set(info.id, { ...(api ? { model: next } : { cliModel: next }), ...effortReset(models, cfg, auth, driver, next) });
  };

  const rows: PickerModel[] = api
    ? (models.liveApi?.[info.id] ?? (regionOf(info, cfg).models ?? info.models).map((m) => ({ ...m, source: 'preset' as const })))
    : modelOptions(models, { provider: info.id, auth, driver }).filter((o) => o.id).map((o) => ({ id: o.id, label: o.label, note: o.note, source: 'preset' as const }));

  // Bring the cache up to date when the list opens — only for a service that is set up (nothing is contacted for the others, MODELS-SPEC I9)
  const configured = !!cfg.keyHint || info.keyOptional;
  const refresh = async (fresh: boolean) => {
    if (!api || !info.def.modelsApi) return;
    setRefreshing(true);
    try { await refreshModelList(info.id, { fresh }); } finally { setRefreshing(false); }
  };

  const note = contextNote(info, current, api ? undefined : DRIVERS[cfg.driver]?.label);
  const hasList = api && !!info.def.modelsApi;
  // the list belongs to a region (and its placeholder values): when those change, show what the cache has for the new one (no request is made)
  const paramsKey = JSON.stringify(cfg.params ?? {});
  useEffect(() => { if (hasList && configured) void refreshModelList(info.id, { cacheOnly: true }); }, [info.id, hasList, configured, cfg.region, paramsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="model-field">
      <label className="model-field__label" htmlFor={`${ids}-m`}>模型{!api && <span className="model-field__opt">（不选就用工具默认）</span>}</label>
      <ModelPicker
        id={`${ids}-m`} label="模型" value={current} onChange={commit} models={rows} disabled={disabled}
        pinned={api ? models.pinned?.[info.id] : undefined} onPin={api ? (m, on) => void pinModel(info.id, m, on) : undefined}
        meta={api ? models.listMeta?.[info.id] : undefined} refreshing={refreshing}
        onRefresh={hasList ? () => void refresh(true) : undefined} onOpen={hasList && configured ? () => void refresh(false) : undefined}
        allowEmpty={!api} emptyOption={!api ? { label: `默认（${DRIVERS[cfg.driver]?.label ?? '工具'} 自己选）`, sub: '不指定模型' } : undefined}
      />
      {api && info.modelHint && <p className="model-field__hint">{info.modelHint}</p>}
      {note && (
        <p className={cx('model-field__meta', note.known && 'is-known', note.warn && 'is-warn')} role={note.warn ? 'note' : undefined}>
          {note.warn ? <TriangleAlert size={13} aria-hidden /> : <Layers size={13} aria-hidden />}{note.text}
        </p>
      )}
    </div>
  );
}

/** 推理强度: the levels this model (or tool) offers, saved as the default for new tasks on this way. The first entry says what the model's own default really is. */
export function EffortField({ info, cfg, models, auth, disabled }: { info: ProviderInfo; cfg: ProviderConfig; models: ModelState; auth: AuthMode; disabled: boolean }) {
  const ids = useId();
  const api = auth === 'api';
  const model = api ? cfg.model : cfg.cliModel;
  const levels = choiceEfforts(models, { provider: info.id, auth, driver: api ? undefined : cfg.driver }, model);
  const saved = api ? cfg.effort : cfg.cliEffort;
  const value = saved && levels.includes(saved) ? saved : '';
  const set = (v: string) => {
    const effort = (v || undefined) as Effort | undefined;
    modelActions.set(info.id, api ? { effort } : { cliEffort: effort });
  };
  const first = api ? apiDefaultEffortLabel(models, info.id, model) : { label: '默认', sub: '用模型自己的默认强度' };
  const options = [{ value: '', label: first.label, sub: first.sub }, ...levels.map((l) => ({ value: l as string, label: EFFORT_LABEL[l], sub: EFFORT_HINT[l] }))];
  const caption = <>推理强度<span className="model-field__opt">（新建任务时的默认值）</span></>;
  return levels.length > 0 ? (
    <div className="model-field">
      <label className="model-field__label" htmlFor={`${ids}-e`}>{caption}</label>
      <MenuSelect variant="field" id={`${ids}-e`} label="推理强度" icon={Gauge} value={value} options={options} onChange={set} disabled={disabled} minWidth={260} />
    </div>
  ) : (
    <div className="model-field">
      <span className="model-field__label">{caption}</span>
      <p className="model-field__static"><Gauge size={14} aria-hidden />这个模型不能调节推理强度</p>
    </div>
  );
}
