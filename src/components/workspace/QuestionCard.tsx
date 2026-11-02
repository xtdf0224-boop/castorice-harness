/* 提问卡（K12）：模型用 AskUserQuestion 问使用者。同一次提问的几个问题合并成一次打断，全部答完才交还模型。
   单选、只有一个问题时，点选项就直接回答；其余情况选好再点「回答」。也可以不选，自己写。
   输入框里回车经过输入法守卫（拼音选字时的回车不会提交）。批准没有单键，回答也没有全局快捷键。
   卡本体是内容层（施工图 §3.1）：只放问题与选项，没有她的话；她的一句（question.w）由 RunCallout 用 HerLead 放在卡的上方。 */
import { CircleHelp } from 'lucide-react';
import { useId, useState } from 'react';
import { guardEnter } from '../../lib/ime';
import { useNow } from '../../lib/hooks';
import type { Question } from '../../lib/types';
import { answerQuestion } from '../../state/runActions';
import '../../styles/engine-cards.css';
import { Button, cx } from '../ui';
import { agoOf } from '../her/logic';

export interface QuestionCardProps {
  /** 同一个运行里待回答的问题（一次提问的几个问题放在一起）. */
  questions: Question[];
  compact?: boolean;
}

export function QuestionCard({ questions, compact = false }: QuestionCardProps) {
  const [picked, setPicked] = useState<Record<string, string[]>>({});
  const [other, setOther] = useState<Record<string, string>>({});
  const now = useNow(15_000);
  const baseId = useId();
  if (!questions.length) return null;

  const answerOf = (q: Question) => [...(picked[q.id] ?? []), ...(other[q.id]?.trim() ? [other[q.id].trim()] : [])];
  const ready = questions.every((q) => answerOf(q).length > 0);
  const single = questions.length === 1 && !questions[0].multiSelect;

  const submit = (override?: Record<string, string[]>) => {
    const answers = questions.map((q) => override?.[q.id] ?? answerOf(q));
    if (answers.some((a) => !a.length)) return;
    questions.forEach((q, i) => { answerQuestion(q.id, answers[i]); });
  };

  const toggle = (q: Question, label: string) => {
    if (single) { submit({ [q.id]: [label] }); return; }
    setPicked((p) => {
      const cur = p[q.id] ?? [];
      if (q.multiSelect) return { ...p, [q.id]: cur.includes(label) ? cur.filter((x) => x !== label) : [...cur, label] };
      return { ...p, [q.id]: cur[0] === label ? [] : [label] };
    });
  };

  const since = Math.min(...questions.map((q) => q.createdAt));
  const titleId = `${baseId}-title`;
  return (
    <article className={cx('eng-card', 'eng-ask', compact && 'eng-card--compact')} aria-labelledby={titleId} data-kind="question" tabIndex={-1}>
      <header className="eng-card__head">
        <span className="eng-tag"><CircleHelp size={14} aria-hidden />待回复</span>
        <h3 className="eng-card__title" id={titleId}>{questions.length > 1 ? `有 ${questions.length} 个问题等你回答` : '有一个问题等你回答'}</h3>
        <time className="eng-card__time" dateTime={new Date(since).toISOString()}>{agoOf(since, now)}</time>
      </header>

      {questions.map((q, qi) => {
        const qid = `${baseId}-q${qi}`;
        const chosen = picked[q.id] ?? [];
        return (
          <section key={q.id} className="eng-q" aria-labelledby={`${qid}-t`}>
            <div className="eng-q__head">
              {q.header && <span className="eng-q__chip">{q.header}</span>}
              <p className="eng-q__text" id={`${qid}-t`}>{q.question}</p>
            </div>
            {q.options.length > 0 && (
              <ul className="eng-opts" aria-label={q.multiSelect ? '选项（可多选）' : '选项'}>
                {q.options.map((o) => (
                  <li key={o.label}>
                    <button type="button" className="eng-opt" aria-pressed={chosen.includes(o.label)} onClick={() => toggle(q, o.label)}>
                      <strong>{o.label}</strong>
                      {o.description && <small>{o.description}</small>}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="eng-other">
              <input
                className="input" value={other[q.id] ?? ''} aria-label={q.options.length ? '或者自己写' : '你的回答'}
                placeholder={q.options.length ? '或者自己写……' : '写下你的回答……'} autoComplete="off" spellCheck={false}
                onChange={(e) => setOther((o) => ({ ...o, [q.id]: e.target.value }))}
                onKeyDown={(e) => { guardEnter(e, () => { if (ready) submit(); }); }}
              />
            </div>
          </section>
        );
      })}

      <div className="eng-actions">
        <Button variant="primary" size={compact ? 'sm' : 'md'} disabled={!ready} onClick={() => submit()}>回答</Button>
        {!ready && <p className="eng-note">每个问题都选一项或写几个字，才能一起交给它。</p>}
      </div>
    </article>
  );
}

/** 已回答的问题的一行摘要（对话里留痕用）. */
export function AnsweredLine({ q }: { q: Question }) {
  return <p className="eng-answered"><b>{q.question}</b>　{(q.answer ?? []).join('、') || '（已跳过）'}</p>;
}
