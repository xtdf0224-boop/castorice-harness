#!/usr/bin/env node
/* 台词库导出工具（V1）。读 src/lib/voice-lines.json（唯一真源），不改它；只往外写文件。
   用法（cwd = app/ 或它的副本）：
     node scripts/gen-voice-lines.mjs --md out.md                    渲染成 voice_lint.py 吃的表格：python -I design/chat/tools/voice_lint.py out.md
     node scripts/gen-voice-lines.mjs --review out.md [--changes c.json] [--base old.json]   审稿用：按场景分组，每行标 ID / 模式 / 话量 / 夜昼 / 表情 / 全文，另列「本轮新写 / 改写」清单
     node scripts/gen-voice-lines.mjs --check                        只检查 JSON 本身（可解析、ID 唯一、字段齐全），不写文件
   --base 给的是改动前的 voice-lines.json：有的话，审稿清单里再列「改写前后」对照.
   changes.json 形如 { "new": [id…], "rewritten": [id…], "extra_only": [id…], "deleted": [id…] }（构建台词库时顺手记下的）. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] ?? ''; };
const SRC = resolve(process.cwd(), flag('--src') || 'src/lib/voice-lines.json');
const rows = JSON.parse(readFileSync(SRC, 'utf8'));

const COND = ['min', 'fast', 'enf', 'soft', 'none', 'planned'];
function parse(id) {
  const p = id.split('.');
  let theme = '';
  if (p[p.length - 1] === 'n' || p[p.length - 1] === 'd') theme = p.pop();
  let cond = '';
  if (COND.includes(p[p.length - 1])) cond = p.pop();
  let variant = 1;
  const v = /^v([2-9])$/.exec(p[p.length - 1] ?? '');
  if (v) { variant = Number(v[1]); p.pop(); }
  const lv = p.pop(), mode = p.pop();
  if (!['s', 'm', 'l'].includes(lv) || !['c', 'w', 'a'].includes(mode) || !p.length) return null;
  return { scene: p.join('.'), mode, lv, theme, cond, variant };
}

/* ── --check ── */
{
  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    for (const k of ['id', 'mode', 'lv', 'text', 'exp']) if (typeof r[k] !== 'string' || !r[k]) problems.push(`${r.id ?? '?'}：缺字段 ${k}`);
    if (seen.has(r.id)) problems.push(`${r.id}：ID 重复`);
    seen.add(r.id);
    if (!parse(r.id) && r.id !== 'comfort.crisis.a') problems.push(`${r.id}：ID 不合文法`);
  }
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`${rows.length} 行，${new Set(rows.map((r) => parse(r.id)?.scene ?? r.id)).size} 个场景，ID 唯一、字段齐全`);
}

const MODE = { c: '闲聊', w: '工作', a: '页面' };
const LV = { s: '少', m: '中', l: '多' };

/* ── --md：voice_lint.py 的输入 ── */
const mdOut = flag('--md');
if (mdOut) {
  const lines = ['# 台词库渲染（由 gen-voice-lines.mjs 生成，勿手改）', '', '| ID | 档 | 台词 | 表情 | 备注 |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.id} | ${r.lv} | 「${r.text}」 | ${r.exp} | ${(r.note ?? '').replace(/\|/g, '/')} |`);
  writeFileSync(resolve(process.cwd(), mdOut), lines.join('\n') + '\n', 'utf8');
  console.log(`已写 ${mdOut}`);
}

/* ── --review：审稿清单 ── */
const reviewOut = flag('--review');
if (reviewOut) {
  const changesPath = flag('--changes');
  const ch = changesPath ? JSON.parse(readFileSync(resolve(process.cwd(), changesPath), 'utf8')) : { new: [], rewritten: [], extra_only: [], deleted: [] };
  const isNew = new Set(ch.new), isRw = new Set(ch.rewritten);
  const byScene = new Map();
  for (const r of rows) {
    const q = parse(r.id);
    const scene = q ? q.scene : 'comfort.crisis';
    (byScene.get(scene) ?? byScene.set(scene, []).get(scene)).push({ r, q });
  }
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const out = [];
  out.push('# 遐蝶台词库 · 审稿清单（V1）', '');
  out.push(`共 ${rows.length} 行，${byScene.size} 个场景。本轮新写 ${ch.new.length} 条，改写 ${ch.rewritten.length} 条，仅补字段（when / commits）${ch.extra_only.length} 条，删除 ${ch.deleted.length} 条。`);
  out.push('', '读法：「标记」列 新 = 本轮新写，改 = 本轮改写；when = 条件谓词（缺事实永不被选中）；honor 池 = enf / soft / none（按引擎会不会遵守分池）；承 = 带 commits（承诺类台词的实现点）。槽位 `{n}` 称呼，`{img.*}` 夜昼景物。', '');
  out.push('审的时候请回答圣经 §8.3 的十问；尤其：①少档是「短而仍是她」还是退回通知腔；②情绪系在事上还是系在你的去留上；③失败 / 批准里有没有意象；④夜昼只换景物不换人；⑤有没有碰红层。', '');
  const list = (title, ids) => {
    out.push(`## ${title}（${ids.length}）`, '');
    out.push(ids.length ? ids.map((i) => `\`${i}\``).join('、') : '（无）', '');
  };
  list('本轮新写的 ID', ch.new);
  list('本轮改写的 ID', ch.rewritten);
  list('仅补字段（when / commits）的 ID', ch.extra_only);
  list('本轮删除的 ID（已由 .enf 等新 ID 取代）', ch.deleted);
  const basePath = flag('--base');
  if (basePath) {
    const old = new Map(JSON.parse(readFileSync(resolve(process.cwd(), basePath), 'utf8')).map((r) => [r.id, r]));
    const now = new Map(rows.map((r) => [r.id, r]));
    out.push('## 改写前后', '', '| ID | 旧 | 新 |', '|---|---|---|');
    for (const id of ch.rewritten) if (old.has(id) && now.has(id)) out.push(`| ${id} | ${cell(old.get(id).text)} | ${cell(now.get(id).text)} |`);
    for (const id of ch.deleted) if (old.has(id)) out.push(`| ${id}（已删） | ${cell(old.get(id).text)} | 由 .enf / .soft / .none 与 .v2… 取代 |`);
    out.push('');
  }
  out.push('## 按场景分组', '');
  for (const [scene, list2] of byScene) {
    out.push(`### ${scene}`, '');
    out.push('| ID | 模式 | 话量 | 夜昼 | 表情 | 标记 | 全文 |', '|---|---|---|---|---|---|---|');
    for (const { r, q } of list2) {
      const flags = [isNew.has(r.id) ? '新' : isRw.has(r.id) ? '改' : '', (r.when ?? []).length ? `when:${r.when.join('+')}` : '', ['enf', 'soft', 'none'].includes(q?.cond) ? `honor:${q.cond}` : '', r.commits ? `承:${r.commits}` : ''].filter(Boolean).join(' ');
      const theme = q?.theme === 'n' ? '夜' : q?.theme === 'd' ? '昼' : '通用';
      out.push(`| ${r.id} | ${q ? MODE[q.mode] : '条款'} | ${q ? LV[q.lv] : '—'} | ${theme} | ${r.exp} | ${cell(flags)} | ${cell(r.text)} |`);
    }
    out.push('');
  }
  writeFileSync(resolve(process.cwd(), reviewOut), out.join('\n'), 'utf8');
  console.log(`已写 ${reviewOut}`);
}
