/* 模型接入 › Claude 的认证三条路（K02）。栖枝只提供入口，不替你登录，永不读取或保存登录令牌。
   ① 用我已登录的 claude（默认）：显示 `claude auth status` 的结果；
   ② 用 API 密钥（明示选项）：必须设日 / 月硬预算、确认「这是 API 计费」；超预算不再启动，进「待你」；
   ③ 打开你自己的登录流程：在新窗口里由 claude 自己登录。 */
import { Coins, LogIn, ShieldQuestion } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import type { ProviderInfo } from '../../../lib/providers';
import type { ProviderConfig } from '../../../lib/types';
import { claudeAuthSnapshot, modelActions, refreshClaudeAuth, subscribeClaudeAuth, updateClaudeAuth } from '../../../state/models';
import '../../../styles/engine-cards.css';
import { Button, cx } from '../../ui';
import { KeyField } from './KeyField';

const usd = (v: number | null | undefined) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');

export function ClaudeAuthPane({ info, cfg, disabled }: { info: ProviderInfo; cfg: ProviderConfig; disabled: boolean }) {
  const view = useSyncExternalStore(subscribeClaudeAuth, claudeAuthSnapshot, claudeAuthSnapshot);
  const mode = view?.config.mode ?? 'login';
  const [openApi, setOpenApi] = useState(false);
  const [daily, setDaily] = useState('');
  const [monthly, setMonthly] = useState('');
  const [ack, setAck] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void refreshClaudeAuth(); }, []);
  // 桌面端的设置读回来之后，表单跟着它走
  useEffect(() => {
    if (!view) return;
    setDaily(view.config.dailyUsd != null ? String(view.config.dailyUsd) : '');
    setMonthly(view.config.monthlyUsd != null ? String(view.config.monthlyUsd) : '');
    setAck(view.config.apiAck);
  }, [view?.config.dailyUsd, view?.config.monthlyUsd, view?.config.apiAck]); // eslint-disable-line react-hooks/exhaustive-deps

  const apiShown = openApi || mode === 'apikey';
  const login = cfg.cli?.login;
  const loginText = !cfg.cli?.found ? '还没有检测到 claude，先点「检测」。'
    : login === 'yes' ? `已登录${cfg.cli.account ? ` · ${cfg.cli.account}` : ''}`
      : login === 'no' ? '还没有登录：用下面第 3 条打开登录流程。'
        : '登录状态未知，点「检测」或测试一次连接。';

  const chooseLogin = async () => {
    setError('');
    setOpenApi(false);
    if (mode === 'login') return;
    setBusy(true);
    const r = await updateClaudeAuth({ mode: 'login' });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const enableApi = async () => {
    setError('');
    const d = Number(daily);
    const m = Number(monthly);
    if (!(d > 0) || !(m > 0)) { setError('请填好日预算和月预算（美元，大于 0）。'); return; }
    setBusy(true);
    const r = await updateClaudeAuth({ mode: 'apikey', dailyUsd: d, monthlyUsd: m, apiAck: ack });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const saveBudget = async () => {
    setError('');
    setBusy(true);
    const r = await updateClaudeAuth({ dailyUsd: Number(daily) || null, monthlyUsd: Number(monthly) || null });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };

  const sp = view?.spend;
  const dailyLimit = view?.config.dailyUsd ?? null;
  const monthlyLimit = view?.config.monthlyUsd ?? null;
  const spendTone = view?.budget.level === 'stop' ? 'is-stop' : view?.budget.level === 'warn' ? 'is-warn' : undefined;

  return (
    <div className="eng-auth" role="group" aria-label="Claude 的认证方式">
      <h3 className="eng-auth__title"><ShieldQuestion size={15} aria-hidden />认证方式　<small className="eng-note">栖枝只拉起你自己的 claude，不替你登录，也不读取或保存令牌。</small></h3>
      <ul className="eng-auth__paths">
        <li>
          <button type="button" className="eng-path" aria-pressed={mode === 'login' && !openApi} disabled={disabled || busy} onClick={() => void chooseLogin()}>
            <span className="eng-path__mark" aria-hidden />
            <span className="eng-path__text">
              <strong>1　用我已登录的 claude　<span className="eng-note">默认</span></strong>
              <small>{loginText}　走订阅额度，不单独计费。</small>
            </span>
          </button>
        </li>
        <li>
          <button type="button" className="eng-path" aria-pressed={apiShown} disabled={disabled || busy} onClick={() => setOpenApi((v) => !v)}>
            <span className="eng-path__mark" aria-hidden />
            <span className="eng-path__text">
              <strong>2　用 API 密钥　<span className="eng-note">明示选项 · 按量计费</span></strong>
              <small>{mode === 'apikey' ? '正在使用。每次启动前先核对日 / 月预算。' : '要先设好日预算和月预算，并确认这是 API 计费。'}</small>
            </span>
          </button>
        </li>
        <li>
          <button type="button" className="eng-path" disabled={disabled || busy} onClick={() => void modelActions.login('claude')}>
            <LogIn size={16} aria-hidden style={{ flex: 'none', marginTop: 2 }} />
            <span className="eng-path__text">
              <strong>3　打开我自己的登录流程</strong>
              <small>在新窗口里运行 claude auth login，由 claude 自己登录；完成后回来点「检测」。</small>
            </span>
          </button>
        </li>
      </ul>

      {apiShown && (
        <div className="eng-bill">
          <span className="eng-bill__label"><Coins size={15} aria-hidden />这是 API 计费</span>
          <p>用 API 密钥时，每次调用都按用量向你的 Anthropic API 账户扣费，与订阅额度无关。栖枝在每次启动前核对预算，超出就不再启动（进「待你·失败」），运行中也用 SDK 的预算上限兜底。</p>
          <p>为了不让 agent 运行的命令读到这把密钥（提示注入可能把它外传），这条路径下 claude 会把密钥从命令的环境里剥掉，因此只能「逐项确认」和「先出计划」；「接受编辑 / 自动 / 放手」在这里会降为逐项确认。</p>
          <p>为了让你心里有数：按这台电脑过去 33 天的日志、用官方价格折算，同样的工作量走 API 计费，每 30 天大约 $900（轻度阶段）到 $7,200（多代理阶段）。这是等价额，不是你现在实际付的钱。</p>
          <KeyField info={info} cfg={cfg} disabled={disabled} label="Claude API Key（只用于这条路径）" />
          <div className="eng-budget">
            <label>日预算（美元）
              <input className="input mono" inputMode="decimal" value={daily} disabled={disabled || busy} placeholder="例如 5" autoComplete="off" onChange={(e) => setDaily(e.target.value)} />
            </label>
            <label>月预算（美元）
              <input className="input mono" inputMode="decimal" value={monthly} disabled={disabled || busy} placeholder="例如 50" autoComplete="off" onChange={(e) => setMonthly(e.target.value)} />
            </label>
          </div>
          <label className="eng-check">
            <input type="checkbox" checked={ack} disabled={disabled || busy || mode === 'apikey'} onChange={(e) => setAck(e.target.checked)} />
            <span>我知道这是 API 计费：按用量扣费，预算是栖枝这边的硬上限（80% 时提示，100% 时停用这条路径）。</span>
          </label>
          {sp && (
            <p className="eng-spend" role="status">
              <span>今日 <b className={cx(spendTone)}>{usd(sp.today)}</b>{dailyLimit != null && ` / ${usd(dailyLimit)}`}</span>
              <span>本月 <b className={cx(spendTone)}>{usd(sp.monthTotal)}</b>{monthlyLimit != null && ` / ${usd(monthlyLimit)}`}</span>
              {view?.budget.message && <span className={spendTone}>{view.budget.message}</span>}
            </p>
          )}
          <div className="eng-actions">
            {mode === 'apikey'
              ? <Button size="sm" variant="secondary" busy={busy} disabled={disabled} onClick={() => void saveBudget()}>更新预算</Button>
              : <Button size="sm" variant="primary" busy={busy} disabled={disabled || !view?.keySaved || !ack} onClick={() => void enableApi()}>启用 API 密钥路径</Button>}
            {mode !== 'apikey' && !view?.keySaved && <span className="eng-note">先保存上面的 API Key。</span>}
            {mode === 'apikey' && <Button size="sm" variant="ghost" disabled={disabled || busy} onClick={() => void chooseLogin()}>改回已登录的 claude</Button>}
          </div>
        </div>
      )}
      {error && <p className="model-field__hint model-field__hint--warn" role="alert">{error}</p>}

      <p className="eng-exe">
        {view?.exe.own ? `用的是你自己的 claude：${view.exe.own}`
          : view?.exe.bundled ? '没有找到你自己装的 claude，用的是栖枝随包的版本（登录状态仍然是你电脑上 claude 的登录）。'
            : '还没找到 claude：请先安装 Claude Code，或在「高级」里填写路径。'}
      </p>
      <label className="eng-check">
        <input type="checkbox" checked={view?.config.useSdk === false} disabled={disabled || busy}
          onChange={(e) => { void updateClaudeAuth({ useSdk: !e.target.checked }).then((r) => { if (!r.ok) setError(r.error); }); }} />
        <span>改用旧的 stream-json 驱动（Agent SDK 出问题时的退路：没有提问卡、计划审批和权限钩子）。</span>
      </label>
    </div>
  );
}
