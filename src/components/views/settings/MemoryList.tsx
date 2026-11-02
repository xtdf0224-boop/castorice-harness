/* 「记得小事」的清单：看 / 改 / 删 / 清空，也可以手打一条（施工图 §3.9）.
   · 邀请制：记忆只来自用户自己的话或在这里手打的字，没有自动抽取；开关关着时不存不读不注入，数据保留，可在这里清空.
   · 上限 ≤ 20 条 × ≤ 80 字（actions.addMemory 另有校验，这里先挡一道并说明）.
   · 分三组：所有对话 / 某个现有对话 / 已无对应对话（任务被清掉后留下的孤儿，单列一组，可见可删）.
   · 单行输入框回车即提交，一律过输入法守卫（lib/ime.ts）：拼音候选未上屏时回车是选字. */
import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { lineInputKeys } from '../../../lib/ime';
import type { MemoryItem } from '../../../lib/types';
import { actions } from '../../../state/actions';
import { shallow, useApp } from '../../../state/store';
import { Button, cx } from '../../ui';

export const MEMORY_MAX = 20;
export const MEMORY_LEN = 80;
const len = (t: string) => Array.from(t.trim()).length;

function MemoryRow({ item, editable }: { item: MemoryItem; editable: boolean }) {
  const [text, setText] = useState(item.text);
  useEffect(() => { setText(item.text); }, [item.text]);
  const commit = () => {
    const next = text.trim();
    if (!next || next === item.text) { setText(item.text); return; }
    if (len(next) > MEMORY_LEN) {
      actions.toast({ tone: 'warning', title: '这条太长了', body: `每条最多 ${MEMORY_LEN} 个字，已保留原来的。` });
      setText(item.text);
      return;
    }
    // 原地改（actions.editMemory）：保留 id 与位置，行不卸载、焦点不丢；超长 / 重复 / 已不在由它回报，失败就把输入还原.
    const r = actions.editMemory(item.id, next);
    if (!r.ok) {
      actions.toast({ tone: 'warning', title: '没能改成', body: r.error });
      setText(item.text);
    }
  };
  const onKeyDown = lineInputKeys<KeyboardEvent<HTMLInputElement>>({ onEnter: commit, onEscape: () => setText(item.text) });
  return (
    <li className="memory-row">
      {editable
        ? <input className="input memory-row__input" value={text} maxLength={MEMORY_LEN} aria-label="记住的这件小事（可修改）" onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={onKeyDown} />
        : <span className="memory-row__text">{item.text}</span>}
      <button type="button" className="memory-row__del" aria-label={`删除：${item.text}`} title="删除这一条" onClick={() => actions.removeMemory(item.id)}><Trash2 size={14} aria-hidden /></button>
    </li>
  );
}

export function MemoryList({ on }: { on: boolean }) {
  const items = useApp((s) => s.memory ?? [], shallow);
  // 与 items 对齐：undefined = 所有对话；null = 任务已不存在（孤儿）；string = 现有任务的标题.
  const where = useApp((s) => (s.memory ?? []).map((m) => (m.taskId ? s.tasks[m.taskId]?.title ?? null : undefined)), shallow);
  const [draft, setDraft] = useState('');
  const [armed, setArmed] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const groups: Array<{ key: string; title: string; rows: MemoryItem[] }> = [];
  items.forEach((m, i) => {
    const w = where[i];
    const key = w === undefined ? 'all' : w === null ? 'orphan' : `task:${m.taskId}`;
    const title = w === undefined ? '所有对话' : w === null ? '已无对应对话' : w;
    const g = groups.find((x) => x.key === key);
    if (g) g.rows.push(m); else groups.push({ key, title, rows: [m] });
  });
  // 「所有对话」在前，孤儿放最后.
  groups.sort((a, b) => (a.key === 'all' ? -1 : b.key === 'all' ? 1 : a.key === 'orphan' ? 1 : b.key === 'orphan' ? -1 : 0));

  const add = () => {
    const t = draft.trim();
    if (!t) return;
    if (len(t) > MEMORY_LEN) { actions.toast({ tone: 'warning', title: '这条太长了', body: `每条最多 ${MEMORY_LEN} 个字。` }); return; }
    const r = actions.addMemory(t);
    if (r.ok) setDraft(''); else actions.toast({ tone: 'warning', title: '没能记下', body: r.error });
  };
  const onKeyDown = lineInputKeys<KeyboardEvent<HTMLInputElement>>({ onEnter: add });
  const clear = () => {
    if (!armed) {
      setArmed(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setArmed(false), 4000);
      return;
    }
    window.clearTimeout(timer.current);
    setArmed(false);
    for (const m of items) actions.removeMemory(m.id);
  };

  return (
    <div className="memory-list">
      {!on && items.length > 0 && <p className="memory-list__note">开关关着：这些不会被读，也不会交给模型；数据还留着，可以在这里清掉。</p>}
      {items.length === 0 ? (
        <p className="memory-list__empty">还没有记下什么。{on ? '在对话里点她的话旁的「记住」，或在下面自己写一条。' : '打开开关后，才能记。'}</p>
      ) : (
        groups.map((g) => (
          <section key={g.key} className={cx('memory-group', g.key === 'orphan' && 'is-orphan')} aria-label={g.title}>
            <h4 className="memory-group__title">{g.title}<span>{g.rows.length}</span></h4>
            <ul className="memory-group__rows">
              {g.rows.map((m) => <MemoryRow key={m.id} item={m} editable={on} />)}
            </ul>
          </section>
        ))
      )}
      <div className="memory-add">
        <input className="input memory-add__input" value={draft} maxLength={MEMORY_LEN} disabled={!on || items.length >= MEMORY_MAX} aria-label="手写一条要记住的小事"
          placeholder={items.length >= MEMORY_MAX ? `已有 ${MEMORY_MAX} 条，先删掉一些` : '自己写一条，例如：叫我小夏'}
          onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} />
        <Button size="sm" variant="secondary" icon={Plus} disabled={!on || !draft.trim() || items.length >= MEMORY_MAX} onClick={add}>记下</Button>
        {items.length > 0 && <Button size="sm" variant={armed ? 'danger' : 'ghost'} icon={Trash2} onClick={clear}>{armed ? `再点一次，清空 ${items.length} 条` : '清空'}</Button>}
      </div>
      <p className="memory-list__limit">最多 {MEMORY_MAX} 条，每条不超过 {MEMORY_LEN} 个字。只记你自己写下的话，不自动记。</p>
    </div>
  );
}
