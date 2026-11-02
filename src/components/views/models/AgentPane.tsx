/* 命令行代理（模型接入页的「命令行」分组，MODELS-SPEC §10、§14）。
   ModelsView 在「命令行」分组里渲染 <AgentPane />（不传属性也行；传 query 时按它过滤）。这里有：
     · 没有绑定到服务的代理（11 个预设 + 你自己添加的）各一行，点开是详情：检测、登录、探测能力、读取模型与模式、安装方式、权限模式有没有验证过、
       命令路径、移除（只有自己添加的）；
     · 「官方注册表」「自定义命令」两个对话框（「添加服务」菜单里的两项经 window 事件 alight:models-agent-add 打开它们）；
     · 「能力一览」（引擎诚实表）：每个代理在逐项 / 计划 / 自动 / 放手下做得到什么，降级的意思写在表下。
   页面从不碰可执行文件的路径：自定义命令走「选择文件 → 一次性令牌 → 登记」；注册表的添加每次都会在原生弹窗里再确认一次。 */
import {
  CheckCircle2, ChevronDown, Download, ExternalLink, FolderOpen, Gauge, ListTree, LogIn, PackagePlus, RefreshCw, Search, ShieldAlert, ShieldCheck, Terminal, Trash2, TriangleAlert, XCircle,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { isComposingEvent, lineInputKeys } from '../../../lib/ime';
import { PROVIDER_BY_ID, permissionSupport } from '../../../lib/providers';
import type { PermissionMode } from '../../../lib/types';
import { modelActions } from '../../../state/models';
import { useApp } from '../../../state/store';
import '../../../styles/models-agents-acp.css';
import { Badge, Button, CopyButton, Dialog, EmptyState, cx } from '../../ui';
import { KeyField } from './KeyField';
import {
  addCustom, addFromRegistry, agentDriverId, allAgentRecs, detectLocal, glyphOf, loadCachedProbe, loadRegistry, localCliOf, loginLocal, pickExe, probeOf, pseudoId, refreshUserAgents, removeAgent,
  runProbe, setLocalPath, standaloneRecs, useAgentsVersion, type AcpProbe, type AgentRec, type RegistryListing, type RegistryRow,
} from '../../../state/agents';

/** Same string as AGENT_ADD_EVENT in ModelsView.tsx (imported there; not imported here because that file imports this one). */
const ADD_EVENT = 'alight:models-agent-add';
const ARG_RE = /^[\w.=:@/-]{1,60}$/;
const ENV_RE = /^[A-Z][A-Z0-9_]{2,40}$/;

const norm = (s: string) => s.toLowerCase().normalize('NFKC');
const matches = (hay: string, query: string) => {
  const words = norm(query).split(/\s+/).filter(Boolean);
  const h = norm(hay);
  return words.every((w) => h.includes(w));
};
const clock = (at?: number) => (at ? new Date(at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '');

export function AgentPane({ query = '', disabled, initialOpen = null, initialDialog = null }: { query?: string; disabled?: boolean; /** 一进来就展开的代理 id / 打开的对话框（给检查脚本渲染用，页面里不传） */ initialOpen?: string | null; initialDialog?: 'registry' | 'custom' | null } = {}) {
  useAgentsVersion();
  const desktopOn = useApp((s) => s.models.desktop);
  const off = disabled ?? !desktopOn;
  const [openId, setOpenId] = useState<string | null>(initialOpen);
  const [dialog, setDialog] = useState<'registry' | 'custom' | null>(initialDialog);

  useEffect(() => { void refreshUserAgents(); }, []);
  // 「添加服务」菜单的两项（命令行代理 · 官方注册表 / 自定义命令）
  useEffect(() => {
    const on = (e: Event) => {
      const mode = (e as CustomEvent<{ mode?: string }>).detail?.mode;
      if (mode === 'registry' || mode === 'custom') setDialog(mode);
    };
    window.addEventListener(ADD_EVENT, on);
    return () => window.removeEventListener(ADD_EVENT, on);
  }, []);

  const rows = standaloneRecs().filter((a) => !query.trim() || matches(`${a.label} ${a.id} ${a.bin.join(' ')} ${a.registryId ?? ''}`, query));
  const total = standaloneRecs().length;

  return (
    <div className="acp-pane">
      <div className="acp-bar">
        <p className="acp-bar__text">
          说 ACP 的命令行工具，登录用它们自己的账号，也可以把你自己的程序登记进来。装好之后在这里检测，栖枝才会把它们当作可选的引擎。
        </p>
        <div className="acp-bar__actions">
          <Button size="sm" variant="secondary" icon={PackagePlus} disabled={off} onClick={() => setDialog('registry')}>官方注册表…</Button>
          <Button size="sm" variant="secondary" icon={FolderOpen} disabled={off} onClick={() => setDialog('custom')}>自定义命令…</Button>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState compact icon={Terminal} title={total ? `没有匹配“${query.trim()}”的命令行代理` : '还没有命令行代理'} body="可以从官方注册表里挑一个，或者把你自己的程序登记进来。" />
      ) : (
        <ul className="acp-list" role="list" aria-label="命令行代理">
          {rows.map((rec) => (
            <AgentRow key={rec.id} rec={rec} open={openId === rec.id} disabled={off} onToggle={() => setOpenId(openId === rec.id ? null : rec.id)} />
          ))}
        </ul>
      )}

      <details className="acp-table-wrap">
        <summary>能力一览</summary>
        <AgentCapabilityTable />
      </details>

      {dialog === 'registry' && <RegistryDialog onClose={() => setDialog(null)} />}
      {dialog === 'custom' && <CustomDialog onClose={() => setDialog(null)} onAdded={(id) => { setDialog(null); setOpenId(id); }} />}
    </div>
  );
}

/* ═══════════════════════════ one agent ═══════════════════════════ */

/** Detection of an agent: through its service card's settings when there is one (so the engine list can use it), else on its own. */
function useAgentRuntime(rec: AgentRec) {
  const pid = pseudoId(rec.id);
  const cfg = useApp((s) => s.models.providers[pid]);
  useAgentsVersion();
  const local = localCliOf(rec.id);
  if (cfg) {
    return {
      wired: true as const, cfg, info: PROVIDER_BY_ID[pid], cli: cfg.cli, path: cfg.cliPath, localBusy: false,
      detect: () => modelActions.detect(pid), login: () => modelActions.login(pid),
      setPath: (v: string) => modelActions.set(pid, { cliPath: v }),
      first: () => { if (!cfg.cli) modelActions.set(pid, { auth: 'cli' }); },
    };
  }
  return {
    wired: false as const, cfg: undefined, info: undefined, cli: local.cli, path: local.path, localBusy: local.busy,
    detect: () => detectLocal(rec.id), login: () => loginLocal(rec.id), setPath: (v: string) => setLocalPath(rec.id, v),
    first: () => { if (!local.cli && !local.busy) void detectLocal(rec.id); },
  };
}

const SOURCE_WORD = { preset: '预设', registry: '官方注册表', custom: '自定义命令' } as const;

function AgentRow({ rec, open, disabled, onToggle }: { rec: AgentRec; open: boolean; disabled: boolean; onToggle: () => void }) {
  const rt = useAgentRuntime(rec);
  const body = useId();
  const verified = rec.perm.level === 'verified';
  const cli = rt.cli;
  const found = cli?.found;
  return (
    <li className={cx('acp-row', open && 'is-open', found && 'is-found')} data-agent={rec.id}>
      <button type="button" className="acp-row__head" aria-expanded={open} aria-controls={open ? body : undefined} onClick={() => { if (!open) rt.first(); onToggle(); }}>
        <span className="acp-row__glyph" aria-hidden>{glyphOf(rec.label)}</span>
        <span className="acp-row__name">
          <b>{rec.label}</b>
          <small>{SOURCE_WORD[rec.source]} · <span className="mono">{rec.registry?.command ?? [rec.bin[0], ...rec.args].join(' ')}</span></small>
        </span>
        <span className="acp-row__marks">
          {cli === undefined && <Badge tone="neutral">未检测</Badge>}
          {cli && !cli.found && <Badge tone="neutral" title={cli.detail || `PATH 里没有找到 ${rec.bin.join(' 或 ')}`}>未安装</Badge>}
          {cli?.found && cli.login === 'no' && <Badge tone="warning">未登录</Badge>}
          {cli?.found && cli.login !== 'no' && <Badge tone="success">已找到</Badge>}
          <Badge tone={verified ? 'success' : 'neutral'} title={verified ? '这个代理的权限模式实测过' : '它的权限模式没有验证过：栖枝不替它切模式'}>
            {verified ? <ShieldCheck size={11} aria-hidden /> : <ShieldAlert size={11} aria-hidden />}权限{verified ? '已验证' : '未验证'}
          </Badge>
        </span>
        <ChevronDown size={16} className="acp-row__chev" aria-hidden />
      </button>
      {open && <AgentDetails id={body} rec={rec} rt={rt} disabled={disabled} />}
    </li>
  );
}

function AgentDetails({ id, rec, rt, disabled }: { id: string; rec: AgentRec; rt: ReturnType<typeof useAgentRuntime>; disabled: boolean }) {
  const ids = useId();
  const [busy, setBusy] = useState<'' | 'detect' | 'probe' | 'deep'>('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const probe = probeOf(rec.id);
  const user = rec.source !== 'preset';
  const cli = rt.cli;
  const canLogin = rec.auth.mode === 'own-login' && !!rec.auth.loginArgs?.length && !!cli?.found;
  // 目录里的 unverified 一栏兼作探测记录：「V7 实测 / 复测」开头的是已经测过的事实，其余是还没核实的
  const measured = (rec.unverified ?? []).filter((u) => /^V7 (实测|复测)/.test(u));
  const open = (rec.unverified ?? []).filter((u) => !/^V7 (实测|复测)/.test(u));

  useEffect(() => { void loadCachedProbe(rec.id); }, [rec.id]);

  const detect = async () => { setBusy('detect'); try { await rt.detect(); } finally { setBusy(''); } };
  const doProbe = async (deep: boolean) => { setBusy(deep ? 'deep' : 'probe'); try { await runProbe(rec.id, deep); } finally { setBusy(''); } };
  const probeBusy = probe?.state === 'busy';

  return (
    <div className="acp-detail" id={id}>
      {rec.auth.loginHint && <p className="acp-note">{rec.auth.loginHint}</p>}
      {user && (
        <p className="acp-note acp-note--warn">
          <TriangleAlert size={14} aria-hidden />
          <span>
            {rec.source === 'custom' ? '这等于让栖枝代你运行这个程序：权限和你的用户一样，不经 shell。' : '这是从官方注册表添加的第三方程序，版本固定，不会自动升级。'}
            {rec.registry?.command && <> 命令：<code className="mono">{rec.registry.command}</code></>}
          </span>
        </p>
      )}

      <div className="acp-cli">
        <div className="acp-cli__state" role="status">
          {cli === undefined && <span className="acp-muted">{rt.localBusy ? '正在检测…' : '还没有检测'}</span>}
          {cli && !cli.found && <span><XCircle size={14} aria-hidden /> {cli.detail || `PATH 里没有找到 ${rec.bin.join(' 或 ')}`}</span>}
          {cli?.found && (
            <span className="acp-cli__found">
              <CheckCircle2 size={14} aria-hidden />
              <span className="mono truncate" title={cli.path}>{cli.version || rec.bin[0]}</span>
              {cli.login === 'yes' && <Badge tone="success">已登录{cli.account ? ` · ${cli.account}` : ''}</Badge>}
              {cli.login === 'no' && <Badge tone="warning">未登录</Badge>}
              {cli.login === 'unknown' && rec.auth.mode === 'own-login' && <Badge tone="neutral" title="这个工具不报告登录状态，探测或测试一次连接即可确认">登录状态未知</Badge>}
            </span>
          )}
        </div>
        <div className="acp-cli__actions">
          <Button size="sm" variant="ghost" icon={RefreshCw} busy={busy === 'detect' || rt.localBusy} disabled={disabled || !!busy} onClick={() => void detect()}>检测</Button>
          {canLogin && <Button size="sm" variant={cli?.login === 'no' ? 'primary' : 'ghost'} icon={LogIn} disabled={disabled} onClick={() => void rt.login()}>登录</Button>}
          <Button size="sm" variant="ghost" icon={Gauge} busy={busy === 'probe' || (probeBusy && !probe.deep)} disabled={disabled || !!busy || probeBusy}
            title="只发一次 initialize，不开会话，不调模型，不花额度" onClick={() => void doProbe(false)}>探测能力</Button>
          <Button size="sm" variant="ghost" icon={ListTree} busy={busy === 'deep' || (probeBusy && probe.deep)} disabled={disabled || !!busy || probeBusy}
            title="在临时目录里开一个会话（不发消息）来读取它的模型与模式；可能需要先登录" onClick={() => void doProbe(true)}>读取模型与模式</Button>
        </div>
      </div>

      <ProbeView probe={probe} />
      <PermNote rec={rec} probe={probe} />

      {measured.length > 0 && (
        <div className="acp-unv">
          <span className="acp-label">随版本发布的探测记录</span>
          <ul>{measured.map((u) => <li key={u}>{u}</li>)}</ul>
        </div>
      )}
      {open.length > 0 && (
        <div className="acp-unv">
          <span className="acp-label">还没有核实</span>
          <ul>{open.map((u) => <li key={u}>{u}</li>)}</ul>
        </div>
      )}

      <InstallHint rec={rec} show={!cli?.found || rec.source === 'preset'} />

      {rt.wired && rt.info && rec.binding.mode === 'env' && !rec.vendor && (
        <KeyField info={rt.info} cfg={rt.cfg} disabled={disabled} label={`密钥（环境变量 ${rec.binding.keyEnv}，可不填）`} />
      )}

      {rec.source === 'preset' && (
        <details className="model-adv">
          <summary>高级</summary>
          <div className="model-field">
            <label className="model-field__label" htmlFor={`${ids}-p`}>命令路径<span className="model-field__opt">（不在 PATH 里时填写）</span></label>
            <input id={`${ids}-p`} className="input mono" value={rt.path} disabled={disabled} spellCheck={false} autoComplete="off"
              placeholder={`例如 C:\\…\\${rec.bin[0]}.cmd`} onChange={(e) => rt.setPath(e.target.value.trim())} />
          </div>
        </details>
      )}

      {user && (
        <div className="acp-remove">
          {!confirmRemove
            ? <Button size="sm" variant="ghost" icon={Trash2} disabled={disabled} onClick={() => setConfirmRemove(true)}>移除</Button>
            : (
              <>
                <span className="acp-muted">移除后，用过它的任务还能看，但不能再发新消息。</span>
                <Button size="sm" variant="danger" icon={Trash2} disabled={disabled} onClick={() => void removeAgent(rec.id)}>确定移除</Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>取消</Button>
              </>
            )}
        </div>
      )}
    </div>
  );
}

/** Where to get the tool: an npm command (with a copy button), a script line, and the vendor's own remark. */
function InstallHint({ rec, show }: { rec: AgentRec; show: boolean }) {
  if (!show) return null;
  const npm = rec.install.npm ? `npm install -g ${rec.install.npm}` : '';
  if (!npm && !rec.install.script && !rec.install.note && !rec.docsUrl) return null;
  return (
    <div className="acp-install">
      <span className="acp-label">安装</span>
      {npm && <p><code className="mono">{npm}</code><CopyButton text={npm} label="复制安装命令" /></p>}
      {rec.install.script && <p><span className="acp-muted">{npm ? '或：' : ''}</span><code className="mono">{rec.install.script}</code></p>}
      {rec.install.note && <p className="acp-muted">{rec.install.note}</p>}
      {rec.docsUrl && <p><a href={rec.docsUrl} target="_blank" rel="noreferrer noopener">官方文档<ExternalLink size={11} aria-hidden /></a></p>}
    </div>
  );
}

/* ───────────── what the probe found ───────────── */

const CAPS: Array<[keyof AcpProbe['caps'], string]> = [
  ['loadSession', '读取旧会话'], ['resume', '恢复会话'], ['list', '会话列表'], ['close', '关闭会话'], ['mcpHttp', 'HTTP MCP'], ['image', '图片'],
];

function ProbeView({ probe }: { probe: ReturnType<typeof probeOf> }) {
  if (!probe) return null;
  if (probe.state === 'busy') return <p className="acp-probe acp-muted" role="status">{probe.deep ? '正在开一个会话读取模型与模式…' : '正在探测…'}</p>;
  if (probe.state === 'error') return <p className="acp-probe acp-probe--bad" role="status">没能探测：{probe.error}</p>;
  const r = probe.result;
  if (!r.ok) return <p className="acp-probe acp-probe--bad" role="status">探测没有成功：{r.error ?? '没有回应'}</p>;
  const s = r.summary;
  return (
    <div className="acp-probe" role="status">
      <p className="acp-probe__head">
        <span className="acp-label">探测结果</span>
        {r.agentInfo && <span className="mono">{r.agentInfo.name} {r.agentInfo.version}</span>}
        {r.at && <span className="acp-muted">{clock(r.at)}{r.cached ? '（缓存）' : ''}</span>}
      </p>
      <ul className="acp-caps" aria-label="它的能力">
        {CAPS.map(([k, label]) => (
          <li key={k} className={cx('acp-cap', r.caps[k] ? 'is-on' : 'is-off')}>{r.caps[k] ? <CheckCircle2 size={12} aria-hidden /> : <XCircle size={12} aria-hidden />}{label}<span className="sr-only">{r.caps[k] ? '：有' : '：没有'}</span></li>
        ))}
        <li className={cx('acp-cap', s ? (r.caps.configOptions ? 'is-on' : 'is-off') : 'is-unknown')}>
          {s ? (r.caps.configOptions ? <CheckCircle2 size={12} aria-hidden /> : <XCircle size={12} aria-hidden />) : <span aria-hidden>?</span>}
          会话配置选项<span className="acp-muted">{s ? '' : '（要点「读取模型与模式」才知道）'}</span>
        </li>
      </ul>
      {r.authMethods.length > 0 && (
        <p className="acp-muted">登录方式：{r.authMethods.map((m) => `${m.id}（${m.type === 'agent' ? '它自己登录' : m.type === 'terminal' ? '要在终端里登录' : '其他'}）`).join('、')}</p>
      )}
      {r.needsLogin && <p className="acp-probe--bad"><TriangleAlert size={13} aria-hidden /> {r.error}</p>}
      {!r.needsLogin && r.error && probe.deep && <p className="acp-probe--bad"><TriangleAlert size={13} aria-hidden /> {r.error}</p>}
      {s && (
        <div className="acp-sum">
          {s.models.length > 0 && <Chips label="模型" items={s.models.map((m) => ({ id: m.id, text: m.label, on: m.id === s.currentModel }))} />}
          {s.efforts.length > 0 && <Chips label="推理强度" items={s.efforts.map((e) => ({ id: e.id, text: e.label, on: e.id === s.currentEffort, off: !e.level }))} note="虚线的是栖枝量表里没有的名字，不能在这里选。" />}
          {s.modes.length > 0 && <Chips label="它的模式（只读展示）" items={s.modes.map((m) => ({ id: m.id, text: m.label, on: m.id === s.currentMode }))} note="栖枝不替没验证过的代理切模式，这里只是让你知道它有什么。" />}
          {!s.models.length && !s.efforts.length && !s.modes.length && <p className="acp-muted">它没有提供模型、强度或模式选项。</p>}
        </div>
      )}
    </div>
  );
}

function Chips({ label, items, note }: { label: string; items: Array<{ id: string; text: string; on?: boolean; off?: boolean }>; note?: string }) {
  const shown = items.slice(0, 16);
  return (
    <div className="acp-chips">
      <span className="acp-label">{label}</span>
      <ul>
        {shown.map((i) => (
          <li key={i.id} className={cx('acp-chip', i.on && 'is-on', i.off && 'is-off')} title={i.id}>{i.text}{i.on && <span className="sr-only">（当前）</span>}</li>
        ))}
        {items.length > shown.length && <li className="acp-chip acp-chip--more">还有 {items.length - shown.length} 项</li>}
      </ul>
      {note && <small className="acp-muted">{note}</small>}
    </div>
  );
}

/* ───────────── permission modes, said honestly ───────────── */

const MODE_WORD: Record<PermissionMode, string> = { ask: '逐项', acceptEdits: '接受编辑', plan: '计划', auto: '自动', bypass: '放手' };

function PermNote({ rec, probe }: { rec: AgentRec; probe: ReturnType<typeof probeOf> }) {
  void probe;
  const map = rec.perm.modeMap;
  if (rec.perm.level === 'verified' && map) {
    const pairs = (Object.keys(map) as PermissionMode[]).map((m) => `${MODE_WORD[m]} → ${map[m]}`).join('，');
    return (
      <p className="acp-note acp-note--perm">
        <ShieldCheck size={14} aria-hidden />
        <span>权限模式已验证：{pairs}。「自动」「放手」下手套只记账、不拦截。只读运行里，它设不上只读相关的模式时栖枝不会启动它。</span>
      </p>
    );
  }
  return (
    <p className="acp-note acp-note--perm">
      <ShieldAlert size={14} aria-hidden />
      <span>
        权限模式没有验证过：栖枝不会替它切模式，页面里的「计划」「自动」「放手」对它不生效，它按自己的默认逐项确认。
        只读运行（目录没信任、只读任务、计划阶段）时，它发来的写入、删除、命令类请求会被栖枝自动拒绝，但它若自己放行了就拦不住。
      </span>
    </p>
  );
}

/* ═══════════════════════════ 能力一览（引擎诚实表） ═══════════════════════════ */

const LEVEL_WORD = { full: '如实对应', approx: '近似', degraded: '已降级', unverified: '未验证' } as const;
const TABLE_MODES: PermissionMode[] = ['ask', 'plan', 'auto', 'bypass'];

/** 每个命令行代理在各权限模式下做得到什么（来自 permissionSupport），加上探测到的会话能力。降级的意思写在表下，不藏在提示里。 */
export function AgentCapabilityTable() {
  useAgentsVersion();
  const rows = allAgentRecs().filter((a) => !a.hidden);
  return (
    <div className="acp-table-box">
      <div className="acp-table-scroll">
        <table className="acp-table">
          <caption className="sr-only">命令行代理的权限模式与会话能力</caption>
          <thead>
            <tr>
              <th scope="col">代理</th>
              {TABLE_MODES.map((m) => <th key={m} scope="col">{MODE_WORD[m]}</th>)}
              <th scope="col">恢复会话</th>
              <th scope="col">配置选项</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => {
              const p = probeOf(a.id);
              const r = p?.state === 'done' && p.result.ok ? p.result : undefined;
              return (
                <tr key={a.id}>
                  <th scope="row">{a.label}</th>
                  {TABLE_MODES.map((m) => {
                    const s = permissionSupport(agentDriverId(a.id), m);
                    return <td key={m} className={cx('acp-lv', `is-${s.level}`)} title={s.note}>{LEVEL_WORD[s.level]}</td>;
                  })}
                  <td>{r ? (r.caps.resume ? '恢复' : r.caps.loadSession ? '重放' : '没有') : <span className="acp-muted" title="还没探测">—</span>}</td>
                  <td>{r ? (r.summary ? (r.caps.configOptions ? '有' : '没有') : <span className="acp-muted" title="要读取模型与模式才知道">未知</span>) : <span className="acp-muted" title="还没探测">—</span>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="acp-legend">
        <li><b>如实对应</b>：页面里的模式就是它真正的模式。</li>
        <li><b>近似</b>：它没有同名的模式，用最接近的，行为稍有不同。</li>
        <li><b>已降级</b>：它做不到这个模式，这次按更保守的逐项处理，运行流里会写明。</li>
        <li><b>未验证</b>：栖枝没有验证过它的权限模式，不替它切；它按自己的默认逐项确认。</li>
        <li>「恢复会话」：恢复 = 能接着上次的会话；重放 = 要把历史重放一遍（慢一些）。两项都要先在上面点「探测能力」才有。</li>
      </ul>
    </div>
  );
}

/* ═══════════════════════════ 官方注册表 ═══════════════════════════ */

function RegistryDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<{ busy: boolean; listing?: RegistryListing; error?: string }>({ busy: true });
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const composing = useRef(false);
  const [adding, setAdding] = useState('');
  const [message, setMessage] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const load = async (fresh: boolean) => {
    setState((s) => ({ ...s, busy: true, error: undefined }));
    const r = await loadRegistry(fresh);
    setState((s) => (r.ok ? { busy: false, listing: r.listing } : { busy: false, listing: s.listing, error: r.error }));
  };
  useEffect(() => { void load(false); }, []);

  const rows = (state.listing?.rows ?? []).filter((r) => !query.trim() || matches(`${r.name} ${r.id} ${r.description}`, query));
  const add = async (r: RegistryRow) => {
    setAdding(r.id);
    setMessage(null);
    const res = await addFromRegistry(r.id);
    setAdding('');
    if (res.ok) { setMessage({ tone: 'ok', text: `已添加。将要运行的命令：${res.command}` }); void load(false); }
    else if (res.error !== '已取消') setMessage({ tone: 'bad', text: res.error });
  };

  return (
    <Dialog title="命令行代理 · 官方注册表" icon={PackagePlus} onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" icon={RefreshCw} busy={state.busy} onClick={() => void load(true)}>刷新</Button>
          <Button variant="secondary" onClick={onClose}>关闭</Button>
        </>
      )}>
      <div className="acp-reg">
        <p className="acp-note">
          这是 ACP 官方维护的代理清单。<b>添加不会运行任何东西</b>：每次添加都会在系统弹窗里让你确认，写明包名、固定的版本和完整的命令行；
          第一次使用时才会通过 npx 或 uvx 下载并执行第三方程序（包含它的依赖）。清单没有给 npx / uvx 包的校验值，栖枝无法校验它们。
        </p>
        <label className="acp-search">
          <Search size={14} aria-hidden />
          <span className="sr-only">搜索注册表</span>
          <input type="search" className="input" value={text} placeholder="搜名称、说明…" autoComplete="off" spellCheck={false}
            onChange={(e) => { setText(e.target.value); if (!composing.current) setQuery(e.target.value); }}
            onCompositionStart={() => { composing.current = true; }}
            onCompositionEnd={(e) => { composing.current = false; setQuery(e.currentTarget.value); }}
            onKeyDown={(e) => { if (isComposingEvent(e)) return; if (e.key === 'Escape' && text) { e.stopPropagation(); setText(''); setQuery(''); } }} />
        </label>
        {message && <p className={cx('acp-msg', message.tone === 'bad' && 'is-bad')} role="status">{message.text}</p>}
        {state.error && <p className="acp-msg is-bad" role="alert"><TriangleAlert size={13} aria-hidden /> {state.error}</p>}
        {state.listing?.error && <p className="acp-msg" role="status">{state.listing.error}</p>}
        {state.busy && !state.listing && <p className="acp-muted" role="status">正在读取…</p>}
        {state.listing && (
          <>
            <p className="acp-muted" aria-live="polite">{rows.length} 个{state.listing.at ? ` · 更新于 ${clock(state.listing.at)}${state.listing.stale ? '（缓存）' : ''}` : ''}</p>
            <ul className="acp-reg__list" role="list">
              {rows.map((r) => <RegistryItem key={r.id} r={r} busy={adding === r.id} locked={!!adding} onAdd={() => void add(r)} />)}
            </ul>
            {rows.length === 0 && <p className="acp-muted">没有匹配的条目。</p>}
          </>
        )}
      </div>
    </Dialog>
  );
}

function RegistryItem({ r, busy, locked, onAdd }: { r: RegistryRow; busy: boolean; locked: boolean; onAdd: () => void }): ReactNode {
  return (
    <li className="acp-reg__item">
      <div className="acp-reg__main">
        <p className="acp-reg__title">
          <b>{r.name}</b> <span className="mono acp-muted">{r.version}</span>
          <Badge tone="neutral">{r.dist === 'binary' ? '二进制' : r.dist}</Badge>
          {r.license && <Badge tone="neutral">{r.license}</Badge>}
          {r.dist === 'binary'
            ? <Badge tone={r.hasSha256 ? 'success' : 'warning'} title="二进制的下载地址是否附带校验值">{r.hasSha256 ? '有校验值' : '没有校验值'}</Badge>
            : <Badge tone="warning" title="清单没有给 npx / uvx 包的校验值">无法校验</Badge>}
          {r.preset && <Badge tone="info" title="栖枝已经有这个代理的预设">已有预设</Badge>}
          {r.installed && <Badge tone="success">已添加 {r.installedVersion}</Badge>}
        </p>
        {r.description && <p className="acp-reg__desc">{r.description}</p>}
        {r.command && <p className="acp-reg__cmd"><code className="mono">{r.command}</code></p>}
        {!r.addable && r.reason && <p className="acp-muted">{r.reason}</p>}
        {r.dist === 'binary' && r.downloads.length > 0 && (
          <ul className="acp-reg__dl">
            {r.downloads.map((d) => (
              <li key={d.platform}>
                <Download size={11} aria-hidden />
                {d.url ? <a href={d.url} target="_blank" rel="noreferrer noopener">{d.platform}</a> : d.platform}
                {d.sha256 && <span className="mono acp-muted" title="sha256">{d.sha256.slice(0, 16)}…</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="acp-reg__act">
        {r.preset
          ? <span className="acp-muted">用预设（先自行安装它的命令）</span>
          : r.addable
            ? <Button size="sm" variant={r.installed ? 'secondary' : 'primary'} icon={PackagePlus} busy={busy} disabled={locked || (r.installed && !r.updateAvailable)} onClick={onAdd}>
                {r.installed ? (r.updateAvailable ? `更新到 ${r.version}` : '已添加') : '添加…'}
              </Button>
            : null}
      </div>
    </li>
  );
}

/* ═══════════════════════════ 自定义命令 ═══════════════════════════ */

function CustomDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const ids = useId();
  const [picked, setPicked] = useState<{ token: string; name: string } | null>(null);
  const [label, setLabel] = useState('');
  const [args, setArgs] = useState('');
  const [envName, setEnvName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'pick' | 'add'>('');

  const argList = args.trim() ? args.trim().split(/\s+/) : [];
  const problems: string[] = [];
  if (argList.length > 8) problems.push('参数最多 8 个');
  if (argList.some((a) => !ARG_RE.test(a))) problems.push('参数只能是字母、数字和 . = : @ / - _，每个不超过 60 个字符（不能有引号、& | < > ^ % 等）');
  if (envName && !ENV_RE.test(envName)) problems.push('环境变量名要像 MY_AGENT_KEY（大写字母、数字、下划线）');
  if (label.length > 60) problems.push('名称不超过 60 个字符');
  const canAdd = !!picked && !!label.trim() && problems.length === 0;

  const choose = async () => {
    setBusy('pick');
    setError('');
    const r = await pickExe();
    setBusy('');
    if (!r.ok) { if (!r.canceled) setError(r.error); return; }
    setPicked({ token: r.token, name: r.name });
    setLabel((l) => l || r.name.replace(/\.(exe|cmd|bat)$/i, ''));
  };
  const submit = async () => {
    if (!canAdd || busy || !picked) return;
    setBusy('add');
    setError('');
    const r = await addCustom({ token: picked.token, label: label.trim(), args: argList, envNames: envName ? [envName] : [] });
    setBusy('');
    if (r.ok) onAdded(r.id);
    else if (r.error !== '已取消') setError(r.error);
  };
  const enter = lineInputKeys<KeyboardEvent>({ onEnter: () => void submit() });

  return (
    <Dialog title="命令行代理 · 自定义命令" icon={FolderOpen} onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>取消</Button>
          <Button variant="primary" icon={PackagePlus} busy={busy === 'add'} disabled={!canAdd || !!busy} onClick={() => void submit()}>登记…</Button>
        </>
      )}>
      <div className="acp-custom">
        <p className="acp-note acp-note--warn">
          <TriangleAlert size={14} aria-hidden />
          <span>这等于让栖枝代你运行这个程序：权限和你的用户一样。栖枝不经 shell 启动它，参数只能是普通的词。点「登记」时系统还会再问你一次。</span>
        </p>
        <div className="model-field">
          <span className="model-field__label">可执行文件</span>
          <div className="acp-pick">
            <Button variant="secondary" icon={FolderOpen} busy={busy === 'pick'} disabled={!!busy} onClick={() => void choose()}>{picked ? '重新选择…' : '选择可执行文件…'}</Button>
            {picked ? <span className="mono" title="页面只知道文件名，完整路径只在栖枝的主进程里">{picked.name}</span> : <span className="acp-muted">.exe / .cmd / .bat；这个程序要能说 ACP（通常是 xxx acp 或 xxx --acp）</span>}
          </div>
        </div>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-n`}>名称</label>
          <input id={`${ids}-n`} className="input" value={label} maxLength={60} autoComplete="off" onChange={(e) => setLabel(e.target.value)} onKeyDown={enter} placeholder="例如 我的代理" />
        </div>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-a`}>参数<span className="model-field__opt">（空格分隔，让它进入 ACP 模式的那几个）</span></label>
          <input id={`${ids}-a`} className="input mono" value={args} autoComplete="off" spellCheck={false} onChange={(e) => setArgs(e.target.value)} onKeyDown={enter} placeholder="例如 acp 或 --acp" />
        </div>
        <div className="model-field">
          <label className="model-field__label" htmlFor={`${ids}-e`}>密钥变量名<span className="model-field__opt">（可不填，最多一个）</span></label>
          <input id={`${ids}-e`} className="input mono" value={envName} autoComplete="off" spellCheck={false} onChange={(e) => setEnvName(e.target.value.trim())} onKeyDown={enter} placeholder="例如 MY_AGENT_KEY" />
          <p className="model-field__hint">只填变量的名字。值是你之后在这个代理卡片里保存的密钥，栖枝只在运行它的时候放进它的环境，不会写在别处。</p>
        </div>
        {problems.map((p) => <p key={p} className="acp-msg is-bad" role="alert"><TriangleAlert size={13} aria-hidden /> {p}</p>)}
        {error && <p className="acp-msg is-bad" role="alert"><TriangleAlert size={13} aria-hidden /> {error}</p>}
      </div>
    </Dialog>
  );
}
