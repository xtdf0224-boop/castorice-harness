/* 按词断行的一段中文：块与块之间放 <wbr>，父级配 .words（word-break: keep-all），只有词边界能换行.
   归来笺、设置页、右栏的说明文字共用（lib/words.ts 负责切词）. */
import { Fragment } from 'react';
import { isSpaceChunk, wordChunks } from '../../lib/words';
import '../../styles/interaction-return.css';

export function Words({ text }: { text: string }) {
  const chunks = wordChunks(text);
  return (
    <>
      {chunks.map((c, i) => (
        <Fragment key={i}>
          {i > 0 && !isSpaceChunk(c) && !isSpaceChunk(chunks[i - 1]) ? <wbr /> : null}
          {c}
        </Fragment>
      ))}
    </>
  );
}
