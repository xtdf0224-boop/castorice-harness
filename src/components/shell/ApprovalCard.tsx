/* 待批卡（沿用萤火审批卡的逻辑，换成栖枝的样式与文案）。
   规矩：①没有头像、没有装饰、没有动效；②默认焦点落在「先看清单」或「拒绝」，不落在批准上；③批准没有单键（不绑任何快捷键），
   高风险的批准要点两次（「批准……」→「确认批准」）；④不写「保护」「安全」，只写事实（谁在请求、做什么、风险几级）。
   状态面板里用紧凑版（预览折叠），工作区里用完整版。
   内容层（AGENT-VOICE-PLAN §3.1、§4.7）：data-card="approval"，卡内没有头像、贴纸、表情；她的一句由卡外的 HerLead 说，卡本体不随话量变。
   结构不动：check-interaction 的源码守卫依赖 useTwoStep、step.press(…) !== 'confirm'、<article … tabIndex={-1}。 */
import { Check, ChevronDown, FileSearch, Hand, X } from 'lucide-react';
import { useId, useState, type MouseEvent } from 'react';
import { relative } from '../../lib/format';
import { agoOf, approvalTagText, isIrreversible } from '../her/logic';
import { useNow } from '../../lib/hooks';
import { APPROVAL_STATUS, RISK } from '../../lib/status';
import { useTwoStep } from '../../lib/twoStep';
import type { Approval } from '../../lib/types';
import { actions } from '../../state/actions';
import { useApp } from '../../state/store';
import '../../styles/engine-cards.css';
import { Button, CodeBlock, CopyButton, StatusChip, cx } from '../ui';

export interface ApprovalCardProps {
  approval: Approval;
  /** Compact: preview collapsed behind a toggle (status panel). Full: preview shown (workspace). */
  compact?: boolean;
  /** Show which task it belongs to (status panel lists approvals across tasks). */
  showTask?: boolean;
}

const PREVIEW_CAPTION: Record<Approval['previewKind'], string> = {
  command: '命令',
  diff: '差异预览',
  request: '请求内容',
};

/** 差异预览的行数统计（只数 + / - 行，不数 +++ / --- 文件头）：框头写「+13 −5 行」，批准前不用在小框里来回滚才知道改了多少. */
export function diffStat(preview: string): { add: number; del: number; lines: number } {
  let add = 0;
  let del = 0;
  const rows = preview.split('\n');
  for (const l of rows) {
    if (l.startsWith('+') && !l.startsWith('+++')) add += 1;
    else if (l.startsWith('-') && !l.startsWith('---')) del += 1;
  }
  return { add, del, lines: rows.length };
}

/** 命令预览的展示拆分（只改显示，复制的仍是原文）：把命令按空白切开（引号里的不切），开头的命令名与选项留在第一行，
 *  后面是两个及以上的文件 / 路径参数时，每个参数单独一行，缩进两格；其余原样. */
export function splitCommandForDisplay(cmd: string): string[] | undefined {
  if (cmd.includes('\n')) return undefined;
  const tokens = cmd.match(/"[^"]*"|'[^']*'|\S+/g);
  if (!tokens || tokens.length < 3) return undefined;
  let head = 1;
  while (head < tokens.length && /^(-{1,2}[A-Za-z][\w-]*|\/[A-Za-z?]{1,2})$/.test(tokens[head])) head += 1;
  const args = tokens.slice(head);
  const pathLike = (t: string) => /[\\/.*]/.test(t);
  if (args.length < 2 || !args.every(pathLike)) return undefined;
  return [tokens.slice(0, head).join(' '), ...args.map((a) => `  ${a}`)];
}

/** 命令预览：同 CodeBlock 的外观，文件名不在中间折行（每个参数一个不可拆的 span；真放不下才滚动）. */
function CommandBlock({ code, caption, maxHeight }: { code: string; caption: string; maxHeight: number }) {
  const lines = splitCommandForDisplay(code);
  return (
    <figure className="code code--wrap eng-cmd">
      <figcaption className="code__bar">
        <span className="code__lang">{caption}</span>
        <span className="code__tools"><CopyButton text={code} /></span>
      </figcaption>
      <pre className="code__pre" style={{ maxHeight }} tabIndex={0}>
        <code>
          {lines
            ? lines.map((l, i) => <span key={i} className="eng-cmd__line">{l.startsWith('  ') ? <>{'  '}<span className="eng-arg">{l.trim()}</span></> : l}{'\n'}</span>)
            : code.split(/(\s+)/).map((t, i) => (/^\s+$/.test(t) || !t ? t : <span key={i} className="eng-arg">{t}</span>))}
        </code>
      </pre>
    </figure>
  );
}

const isShown = (el: HTMLElement) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';

/** Deciding removes the card (and the button that had focus) from the DOM, which would drop focus to <body>.
 *  Move it to somewhere stable in the same region instead: the next pending card (the card itself, not its
 *  buttons, so a stray Enter can never approve a different operation), else the approvals section of the
 *  status panel, else the page heading. `card` is the card that was just decided and `region` the landmark
 *  that held it; both are read before the decision, because afterwards the card is detached. */
function restoreFocusAfterDecision(card: Element | null, region: Element | null, approvalId: string) {
  const attempt = (): boolean => {
    if (card?.isConnected) return false; // React has not removed it yet
    const active = document.activeElement;
    if (active && active !== document.body && document.contains(active)) return true; // something else already took focus
    const pendingCards = Array.from(document.querySelectorAll<HTMLElement>('.eng-ap[data-status="pending"]'))
      .filter((el) => el.dataset.approvalId !== approvalId && region?.contains(el) && isShown(el));
    const target = pendingCards[0]
      ?? (region?.matches('aside') ? region.querySelector<HTMLElement>('.status-panel__section--approvals') : null)
      ?? region?.querySelector<HTMLElement>('h1')
      ?? (region instanceof HTMLElement ? region : null);
    if (!target || !target.isConnected) return true;
    if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
    target.focus();
    return document.activeElement === target;
  };
  // Timers, not rAF: they still fire when the tab is throttled. The first try lands right after React commits.
  let done = false;
  for (const delay of [0, 60, 200]) window.setTimeout(() => { if (!done) done = attempt(); }, delay);
}

export function ApprovalCard({ approval, compact = false, showTask = false }: ApprovalCardProps) {
  const agentName = useApp((s) => s.agents.find((a) => a.id === approval.agentId)?.name ?? approval.agentId);
  const toolName = useApp((s) => s.tools.find((t) => t.id === approval.tool)?.name ?? approval.tool);
  const taskTitle = useApp((s) => (showTask ? s.tasks[approval.taskId]?.title : undefined));
  const now = useNow(15_000);
  const [open, setOpen] = useState(!compact);
  // 差异预览默认是个有限高的框；点「展开全部」才放开（只在工作区的完整版里给）.
  const [tall, setTall] = useState(false);
  const diff = approval.previewKind === 'diff' ? diffStat(approval.preview) : undefined;
  // 高风险的批准要点两次；五秒不确认就退回去。第二次要来得不太快、焦点也不在按钮上（双击 / 按住 Enter 不能一步通过），见 lib/twoStep
  const step = useTwoStep(5000);
  const armed = step.armed;
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const previewId = `${baseId}-preview`;

  const pending = approval.status === 'pending';
  // 须亲批 = 工具类别是高风险，或这一次要做的事能判定取不回来（git push --force 走的是 git，类别只是中）；
  // 「不可逆」只在能判定时才说——shell 里的 ls / git status 是高风险类别，但并不是不可逆的.
  const irreversible = isIrreversible(approval);
  const high = approval.risk === 'high' || irreversible;
  const risk = RISK[approval.risk];
  const status = APPROVAL_STATUS[approval.status];

  const decide = (decision: 'approve' | 'reject', e: MouseEvent<HTMLButtonElement>) => {
    const region = e.currentTarget.closest('aside, main');
    actions.decideApproval(approval.id, decision);
    restoreFocusAfterDecision(e.currentTarget.closest('.eng-ap'), region, approval.id);
  };
  const approve = (e: MouseEvent<HTMLButtonElement>) => {
    if (high) {
      const r = step.press(e.currentTarget.closest<HTMLElement>('.eng-ap'));
      if (r !== 'confirm') return;
    }
    decide('approve', e);
  };

  return (
    <article
      className={cx('eng-card', 'eng-ap', compact && 'eng-card--compact', !pending && 'is-decided')}
      data-card="approval"
      data-status={approval.status}
      data-approval-id={approval.id}
      data-risk={approval.risk}
      data-preview-open={tall ? 'true' : undefined}
      aria-labelledby={titleId}
      tabIndex={-1}
    >
      <header className="eng-card__head">
        <span className={cx('eng-tag', !pending && 'eng-tag--calm', pending && high && 'eng-tag--gold')}>
          <Hand size={14} aria-hidden />
          {pending ? approvalTagText(approval) : status.label}
        </span>
        <h3 className="eng-card__title" id={titleId}>{approval.title}</h3>
        <time className="eng-card__time" dateTime={new Date(approval.createdAt).toISOString()}>{agoOf(approval.createdAt, now)}</time>
      </header>

      <p className="eng-card__lead">{approval.reason}</p>

      <dl className="eng-facts">
        <dt>请求者</dt><dd>{agentName} · {toolName}</dd>
        <dt>风险</dt><dd className={approval.risk === 'high' ? 'is-risk-high' : undefined}>{risk.label}</dd>
        {showTask && taskTitle && (
          <>
            <dt>任务</dt>
            <dd><button type="button" className="shell-link" title={taskTitle} onClick={() => actions.openTask(approval.taskId)}>{taskTitle}</button></dd>
          </>
        )}
      </dl>

      {compact && open && (
        <button type="button" className="eng-toggle" aria-expanded={open} aria-controls={previewId} onClick={() => setOpen(false)}>
          <ChevronDown size={14} aria-hidden /><span>收起清单</span>
        </button>
      )}
      <div className="eng-card__preview" id={previewId} hidden={!open}>
        {approval.previewKind === 'command' ? (
          <CommandBlock code={approval.preview} caption={PREVIEW_CAPTION.command} maxHeight={220} />
        ) : (
          <CodeBlock
            code={approval.preview}
            language={approval.previewKind === 'diff' ? 'diff' : 'text'}
            caption={diff ? `${PREVIEW_CAPTION.diff} · +${diff.add} −${diff.del} 行` : PREVIEW_CAPTION[approval.previewKind]}
            maxHeight={220}
            wrap={approval.previewKind !== 'diff'}
          />
        )}
        {diff && !compact && diff.lines > 9 && (
          <button type="button" className="eng-toggle" aria-expanded={tall} onClick={() => setTall((v) => !v)}>
            <ChevronDown size={14} aria-hidden style={tall ? { transform: 'rotate(180deg)' } : undefined} /><span>{tall ? '收起' : `展开全部（${diff.lines} 行）`}</span>
          </button>
        )}
      </div>

      {pending ? (
        <div className="eng-actions">
          {!open && (
            <Button variant={high ? 'primary' : 'secondary'} size={compact ? 'sm' : 'md'} icon={FileSearch} data-first-focus aria-expanded={open} aria-controls={previewId} onClick={() => setOpen(true)}>
              先看清单
            </Button>
          )}
          <Button
            variant="secondary"
            size={compact ? 'sm' : 'md'}
            icon={X}
            data-first-focus={open ? '' : undefined}
            aria-label={`拒绝「${approval.title}」`}
            onClick={(e) => decide('reject', e)}
          >
            拒绝
          </Button>
          <Button
            variant={high ? 'warning' : 'primary'}
            size={compact ? 'sm' : 'md'}
            icon={Check}
            aria-label={armed ? `确认批准「${approval.title}」` : `批准「${approval.title}」`}
            onClick={approve}
          >
            {high ? (armed ? '确认批准' : '批准……') : '批准一次'}
          </Button>
          {high && armed && <p className="eng-note" role="status">再点一次「确认批准」才会执行。{irreversible ? '这类操作之后可能取不回来。' : ''}</p>}
        </div>
      ) : (
        <div className="eng-decided">
          <StatusChip meta={status} size="sm" />
          {approval.decidedAt != null && <span>{relative(approval.decidedAt, now)}</span>}
        </div>
      )}
    </article>
  );
}
