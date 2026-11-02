/* 信任确认框的内容（V0α · 模块 B5「安全」）。纯展示：状态和选择都从 props 进出，所以能在没有 DOM 的环境里渲染做测试；
   样式表和订阅在 TrustDialogHost.tsx 里。弹层本身用 ui 的 Dialog：焦点进入、Tab 圈在框内、Esc 关闭（＝取消）、关闭后焦点还给原处.

   信息永远写全（路径、信任范围、两种选择各自会怎样、疑似原因）；她的口吻只在最上面那一句 lead，来自 say2('trust.ask' | 'trust.suspect' | 'trust.broad')
   （按话量取档、persona 关时取纯事实），台词库里没有这个场景时用下面的内置句。默认焦点落在「只读继续」（不会因为一次长按回车就升级权限）. */
import { ShieldCheck, TriangleAlert } from 'lucide-react';
import { useCallback, useId, useState } from 'react';
import { say2, voiceSeed } from '../../lib/voice';
import type { TrustInfo, TrustReason } from '../../lib/trustBridge';
import type { Level } from '../../lib/types';
import type { TrustChoice, TrustPromptState } from '../../state/trustGate';
import { Button, Dialog } from '../ui';

/** 路径的最后一段，用在台词里. */
export function baseName(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** 内置句里的称呼用 {n} 占位（默认「阁下」，设置里可改）。 */
const FALLBACK_LEAD = {
  plain: '信任此目录？信任后可以写入并运行命令；不信任则只读。',
  plainBroad: '目录范围太大（磁盘根或用户主目录），只能只读。',
  ask: '这是{n}自己的目录吗……若是，说一声「这是我的」，我便靠近些。',
  suspect: '这里……看起来是别处来的东西。若{n}确认它可靠，再让我靠近也不迟。',
  broad: '这里……范围太大了。{n}若想让我写入，请选一个具体的项目目录。',
};

/** 台词：优先 say2()（场景 trust.ask / trust.suspect / trust.broad，槽位 dir），没有就用内置句. persona=false 为纯事实.
    话量 level 缺省中档；同一目录、同一天抽到同一句（种子用目录名），不会每次打开都换. */
export function trustLead(info: Pick<TrustInfo, 'suspect' | 'rootLike' | 'top' | 'dir'>, level: Level = 'm', callName = '阁下', persona = true): string {
  const scene = info.rootLike ? 'trust.broad' : info.suspect ? 'trust.suspect' : 'trust.ask';
  const name = callName.trim() || '阁下';
  const dir = baseName(info.top ?? info.dir);
  try {
    const line = say2(scene, { dir }, { level, persona, callName: name, mode: 'work', seed: voiceSeed(Date.now(), dir, 0) }).text;
    if (typeof line === 'string' && line.trim()) return line;
  } catch { /* 场景还没登记：用内置句 */ }
  const pick = info.rootLike ? (!persona ? FALLBACK_LEAD.plainBroad : FALLBACK_LEAD.broad)
    : !persona ? FALLBACK_LEAD.plain : info.suspect ? FALLBACK_LEAD.suspect : FALLBACK_LEAD.ask;
  return pick.replaceAll('{n}', name);
}

/** 疑似原因的中文说明（代码由主进程给，措辞在这里定）. */
export function reasonLine(r: TrustReason): string {
  switch (r.code) {
    case 'vendor-path': return `路径里有「${r.detail}」目录，通常放的是别人的代码。`;
    case 'foreign-remote': return `它的远端 ${r.items && r.items.length > 1 ? r.items.join('、') : r.detail} 不在你信任过的仓库所属的账号里。`;
    case 'exec-config': return `带有会执行命令的配置：${(r.items && r.items.length ? r.items : [r.detail]).join('；')}。栖枝不会读取或运行它们。`;
  }
}

export interface TrustDialogViewProps {
  state: TrustPromptState;
  lead: string;
  onChoose: (choice: TrustChoice, opts?: { acknowledged?: boolean }) => void;
}

export function TrustDialogView({ state, lead, onChoose }: TrustDialogViewProps) {
  const { info, busy, error, waiting } = state;
  const [acknowledged, setAcknowledged] = useState(false);
  const ackId = useId();
  const close = useCallback(() => onChoose('cancel'), [onChoose]);
  const suspect = info.suspect;
  const blocked = info.rootLike || (suspect && !acknowledged);
  const trustLabel = '这是我自己的目录，信任并继续';

  const scope = info.rootLike
    ? '这个目录范围太大（磁盘根或用户主目录）。我只能以只读方式看它；要写入，请选具体的项目目录。'
    : info.scope === 'repo'
      ? (info.top && info.top !== info.dir
        ? `它在 git 仓库「${info.top}」里。信任会覆盖整个仓库，而不只是这个子目录。`
        : '这是一个 git 仓库。信任会覆盖整个仓库。')
      : '只对这个目录本身生效；它的上层、同级和子目录各自另问。';

  return (
    <Dialog
      title="信任这个目录？"
      icon={suspect ? TriangleAlert : ShieldCheck}
      tone={suspect ? 'warning' : undefined}
      onClose={close}
      footer={(
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>取消</Button>
          <Button variant="secondary" data-autofocus onClick={() => onChoose('readonly')} disabled={busy}>只读继续</Button>
          <Button
            variant="primary"
            icon={ShieldCheck}
            busy={busy}
            disabled={blocked}
            title={blocked ? (info.rootLike ? '范围太大，不能整体信任' : '请先勾选下面的确认') : undefined}
            onClick={() => onChoose('trust', { acknowledged: suspect ? acknowledged : false })}
          >
            {trustLabel}
          </Button>
        </>
      )}
    >
      <div className="trust-dialog">
        {lead && <p className="trust-dialog__lead">{lead}</p>}

        <div className="trust-dialog__subject">
          <p className="trust-dialog__path" title={info.dir}>{info.dir}</p>
          <p className="trust-dialog__scope">{scope}</p>
        </div>

        <dl className="trust-dialog__options">
          <div>
            <dt>只读继续</dt>
            <dd>我可以读这里的文件并回答问题；不会写入，也不会运行命令。这次打开期间不会再追问。</dd>
          </div>
          {!info.rootLike && (
            <div>
              <dt>信任并继续</dt>
              <dd>
                之后这里的任务可以写文件、运行命令，仍按输入框里选的权限模式征求同意。
                仓库自带的钩子、MCP 与技能配置不会被加载。随时可以在「设置 › 信任的目录」里撤销。
              </dd>
            </div>
          )}
        </dl>

        {suspect && (
          <div className="trust-dialog__warn" role="group" aria-label="需要确认">
            <p className="trust-dialog__warn-title">它看起来像是别处克隆来的</p>
            <ul>
              {info.reasons.map((r) => <li key={r.code}>{reasonLine(r)}</li>)}
            </ul>
            <label className="trust-dialog__ack" htmlFor={ackId}>
              <input id={ackId} type="checkbox" checked={acknowledged} disabled={busy} onChange={(e) => setAcknowledged(e.target.checked)} />
              <span>我确认这是我自己的目录，或者我已经看过它里面的内容。</span>
            </label>
          </div>
        )}

        {error && <p className="trust-dialog__error" role="alert">{error}</p>}
        {waiting > 0 && <p className="trust-dialog__wait">还有 {waiting} 个目录等着确认。</p>}
      </div>
    </Dialog>
  );
}
