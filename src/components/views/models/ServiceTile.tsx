/* 紧凑行（MODELS-SPEC §14.4）：还没接入的服务，一行一家——徽记 · 名称 · 厂商 · 一句模型摘要 · 兼容小标 · 标签 · 「接入 ▸」。
   整行是一个 button（aria-expanded），点它在原地展开成完整的 ProviderCard；同一时间只展开一个（ModelsView 管）。
   兼容小标「聊天 / 强度 / 干活」由数据推出（gradeOf），不能用的灰显，悬停说明为什么；标签只说事实，不靠颜色单独表达。 */
import { ChevronRight, CircleHelp, Minus } from 'lucide-react';
import { effortLevels } from '../../../lib/effort';
import { gradeOf, type Grade } from '../../../lib/services';
import type { ProviderInfo } from '../../../lib/providers';
import { Badge, cx } from '../../ui';
import { highlightParts, modelSummary, type Row } from './browse';

/** 「聊天 / 强度 / 干活」: three small marks. A mark that does not apply is dashed and says why on hover (never colour alone: a dash icon and the words).
    On a row only the EXCEPTIONS are shown (what is missing, and 「干活（实验）」): a row of three marks on every service says nothing and drowns the one that matters.
    The open card (`showAll`) lists all three. 「强度」 = can the reasoning level be tuned (it used to say 「调参」, which reads as hyper-parameters). */
export function GradeBadges({ grade, size = 'sm', showAll = false }: { grade: Grade; size?: 'sm' | 'md'; showAll?: boolean }) {
  const items: Array<{ key: 'chat' | 'tune' | 'work'; label: string; on: boolean; text?: string; why?: string }> = [
    { key: 'chat', label: '聊天', on: grade.chat, why: grade.why.chat },
    { key: 'tune', label: '强度', on: grade.tune, why: grade.why.tune },
    { key: 'work', label: grade.work === 'experimental' ? '干活（实验）' : '干活', on: grade.work !== 'no', why: grade.why.work },
  ];
  const shown = showAll ? items : items.filter((g) => !g.on || (g.key === 'work' && grade.work === 'experimental'));
  if (!shown.length) return null;
  return (
    <span className={cx('grades', `grades--${size}`)} role="group" aria-label="兼容程度">
      {shown.map((g) => (
        <span key={g.key} className={cx('grade', g.on ? 'is-on' : 'is-off', g.key === 'work' && grade.work === 'experimental' && 'is-experimental')}
          title={g.why ?? (g.key === 'chat' ? '能当闲聊和文本任务的模型用' : g.key === 'tune' ? '能调节推理强度（低 / 中 / 高…）' : '能读写文件、执行命令（经命令行工具）')}
          aria-label={`${g.label}：${g.on ? '可以' : '不可以'}${g.why ? `，${g.why}` : ''}`}>
          {!g.on && <Minus size={10} aria-hidden />}
          {g.label}
        </span>
      ))}
    </span>
  );
}

/** What the service is, in a few facts: 套餐 通道 / 本机 / 预览 / 将下线 / 未核实. */
export function ServiceTags({ p }: { p: ProviderInfo }) {
  const hasPlan = p.regions.some((r) => r.kind === 'plan');
  const isLocal = p.group === 'local' || p.regions.every((r) => r.kind === 'local');
  const first = p.models.slice(0, 3);
  const preview = first.some((m) => m.status === 'preview');
  const retiring = first.find((m) => m.status === 'retiring' || m.status === 'deprecated');
  return (
    <span className="svc-tags">
      {hasPlan && <Badge tone="neutral" className="svc-tag" title="这家有套餐通道：套餐 Key 只能给命令行编码工具用，不能直接调用 API。">套餐</Badge>}
      {isLocal && <Badge tone="neutral" className="svc-tag" title="跑在这台电脑上，只允许 127.0.0.1 / localhost 的地址。">本机</Badge>}
      {preview && <Badge tone="info" className="svc-tag" title="有模型还在预览阶段，能力和价格可能变。">预览</Badge>}
      {retiring && <Badge tone="warning" className="svc-tag" title={retiring.retiresAt ? `${retiring.label ?? retiring.id} 预计 ${retiring.retiresAt} 下线` : `${retiring.label ?? retiring.id} 已宣布弃用`}>将下线</Badge>}
      {p.unverified.length > 0 && (
        <span className="svc-unverified" role="img" aria-label="有几项还没有逐项核实" title={`还没有逐项核实：\n${p.unverified.map((u) => `· ${u}`).join('\n')}`}><CircleHelp size={14} aria-hidden /></span>
      )}
    </span>
  );
}

/** The capability marks of a service as a tile shows them: what it CAN do (a key is not needed yet, and a model can always be typed). */
export function tileGrade(p: ProviderInfo): Grade {
  const model = p.def.defaultModel ?? p.models[0]?.id;
  const levels = model ? effortLevels(p.id, 'api', undefined, model) : [];
  return gradeOf(p.def, { keySaved: true, model: model ?? '(输入)', levels });
}

/** Wrap the matched pieces of a text in <mark> (plain text only: the pieces are React text nodes). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query);
  return <>{parts.map((x, i) => (x.hit ? <mark key={i} className="svc-mark">{x.text}</mark> : <span key={i}>{x.text}</span>))}</>;
}

export function ServiceTile({ row, query, onOpen }: { row: Row; query: string; onOpen: () => void }) {
  const { p } = row;
  const grade = tileGrade(p);
  return (
    <button type="button" className="svc-tile" aria-expanded={false} data-service={p.id} onClick={onOpen}>
      <span className="svc-tile__glyph" aria-hidden>{p.glyph}</span>
      <span className="svc-tile__name">
        <b><Highlight text={p.name} query={query} /></b>
        <small><Highlight text={p.vendor} query={query} /></small>
      </span>
      <span className="svc-tile__summary">
        <span className="truncate"><Highlight text={modelSummary(p)} query={query} /></span>
        {row.hit?.via && <small className="svc-tile__via">{row.hit.via}</small>}
      </span>
      <span className="svc-tile__marks">
        <GradeBadges grade={grade} />
        <ServiceTags p={p} />
      </span>
      <span className="svc-tile__go">接入<ChevronRight size={14} aria-hidden /></span>
    </button>
  );
}
