// report：把 baseline 的结果 JSON 渲染成 Markdown（--json 是输入；--md 给了就写文件，否则打印）。
// 判定表按当前规则重新计算；给 --compare <基线.json> 时对照该基线。
import fs from 'node:fs';
import { compareToBaseline } from './baseline.mjs';
import { renderMarkdown } from '../lib/report.mjs';

export async function runReport(ctx) {
  const input = ctx.values.json;
  if (!input) throw new Error('report 需要 --json <baseline 结果文件>');
  const result = JSON.parse(fs.readFileSync(input, 'utf8'));
  const base = ctx.values.compare ? JSON.parse(fs.readFileSync(ctx.values.compare, 'utf8')) : undefined;
  result.verdict = compareToBaseline(result, base);
  const md = renderMarkdown(result);
  if (ctx.values.md) { fs.writeFileSync(ctx.values.md, md, 'utf8'); ctx.log(`已写入 ${ctx.values.md}`); } else process.stdout.write(`${md}\n`);
  return 0;
}
