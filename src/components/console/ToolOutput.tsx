/* 工具输出的「按需取全文」（K08）。
   超过 5 KB 的输出在存储里只放摘要（读进页面的也只是摘要），全文另存；这里在需要时才取：
   - 读自存储的摘要：显示摘要 + 「展开全文」，点了才向存储要；
   - 本次运行里刚产生的长输出（页面里有全文）：先只画前 5 KB，点「展开全文」再画全部；
   - 任何情况下最多画 20 万字符（再长的可以复制全文）。 */
import { ChevronsDown, Loader } from 'lucide-react';
import { useEffect, useState } from 'react';
import { fullOutput, outputSize } from '../../lib/storeBridge';
import type { ToolCall } from '../../lib/types';
import '../../styles/store-long.css';
import { CodeBlock, CopyButton } from '../ui';

/** 先画多少字符（也是存储里「折叠」的门槛）. */
export const VIEW_MAX = 5 * 1024;
/** 展开后最多画多少字符. */
export const SHOW_MAX = 200_000;

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.ceil(n / 1024)} KB` : `${n} 字符`);

export interface ToolOutputView {
  /** 现在要画的文字. */
  text: string;
  /** 输出的完整长度（字符）. */
  total: number;
  /** 现在画的只是开头一段. */
  clipped: boolean;
  /** 手里有完整输出时就是它（显示被截短时可以「复制全文」）. */
  fullText?: string;
  loading: boolean;
  /** 存储里没有这条的全文（只剩摘要）. */
  missing: boolean;
  expand: () => void;
}

export function useToolOutput(call: Pick<ToolCall, 'id' | 'output'>): ToolOutputView {
  const [full, setFull] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => { setFull(undefined); setLoading(false); setMissing(false); setOpen(false); }, [call.id]);

  const local = call.output ?? '';
  const folded = outputSize(call); // 页面里只是摘要时，这是完整长度
  const total = folded ?? local.length;

  let text: string;
  let clipped = false;
  if (folded !== undefined) {
    text = full ?? local;
    clipped = full === undefined;
  } else if (local.length > VIEW_MAX && !open) {
    text = local.slice(0, VIEW_MAX);
    clipped = true;
  } else text = local;
  if (text.length > SHOW_MAX) { text = text.slice(0, SHOW_MAX); clipped = true; }

  const expand = () => {
    if (folded === undefined) { setOpen(true); return; }
    if (loading) return;
    setLoading(true);
    void fullOutput(call.id).then((f) => {
      if (f === undefined) setMissing(true); else setFull(f);
      setLoading(false);
    });
  };
  return { text, total, clipped, fullText: folded === undefined ? local : full, loading, missing, expand };
}

/** 「已折叠 · 展开全文」那一行. 没有被折叠时什么都不画. */
export function OutputMore({ view }: { view: ToolOutputView }) {
  if (!view.clipped && !view.missing) return null;
  return (
    <p className="so-note" role="status">
      {view.missing ? (
        <span>全文已经取不回来了（存储里只留下摘要）</span>
      ) : (
        <>
          <span>{view.text.length >= SHOW_MAX ? `只显示前 ${size(SHOW_MAX)}，共 ${size(view.total)}` : `已折叠 · 显示前 ${size(view.text.length)}，共 ${size(view.total)}`}</span>
          {view.text.length < SHOW_MAX && (
            <button type="button" className="so-more" onClick={view.expand} disabled={view.loading}>
              {view.loading ? <Loader size={12} aria-hidden className="so-spin" /> : <ChevronsDown size={12} aria-hidden />}
              {view.loading ? '正在取回…' : '展开全文'}
            </button>
          )}
          {view.fullText !== undefined && view.text.length < view.fullText.length && <CopyButton text={view.fullText} label="复制全文" />}
        </>
      )}
    </p>
  );
}

/** 控制台里的输出：代码块 + 折叠说明. */
export function ToolOutputCode({ call, caption = '输出', maxHeight = 220 }: { call: Pick<ToolCall, 'id' | 'output'>; caption?: string; maxHeight?: number }) {
  const view = useToolOutput(call);
  return (
    <div className="so-block">
      <CodeBlock code={view.text} caption={caption} maxHeight={maxHeight} wrap />
      <OutputMore view={view} />
    </div>
  );
}

/** 对话里内联的输出：一块 <pre>. */
export function ToolOutputPre({ call, empty }: { call: Pick<ToolCall, 'id' | 'output'>; empty: string }) {
  const view = useToolOutput(call);
  return (
    <>
      <pre className="ws-tool__out">{view.text || empty}</pre>
      <OutputMore view={view} />
    </>
  );
}
