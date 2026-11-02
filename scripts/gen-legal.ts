/* npm run legal — writes DISCLAIMER.md and build/license.txt (the installer's licence page) from the
   same source as Settings › 免责声明与使用条款 (src/lib/terms.ts), plus the MIT licence for the code and the edge-tts notice. */
import fs from 'node:fs';
import path from 'node:path';
import { AUTHOR_URL, TERMS, termsAsText } from '../src/lib/terms';

// npm scripts run from the package root (the bundled script lives in node_modules/.cache).
const at = (f: string) => path.join(process.cwd(), f);
const mit = fs.readFileSync(at('LICENSE'), 'utf8');
// 桌宠的微软在线朗读用到一个移植的文件（electron/pet/tts-edge-gec.cjs），按 LGPL-3.0：声明也放进许可页.
const edgeNotice = fs.readFileSync(at('licenses/edge-tts-NOTICE.txt'), 'utf8');

const md = [
  '# 免责声明与使用条款',
  '',
  '> 与安装程序的许可页同源；应用内「设置 › 关于与免责声明」是它的简版。安装或使用本软件即视为同意以下全部条款。',
  '',
  ...TERMS.flatMap((s) => [
    `## ${s.title}`,
    '',
    ...s.paragraphs.flatMap((p) => [p, '']),
    ...(s.items ?? []).map((i) => (i.href ? `- [${i.text}](${i.href})` : `- ${i.text}`)),
    ...(s.items ? [''] : []),
  ]),
].join('\n');
fs.writeFileSync(at('DISCLAIMER.md'), md);

const txt = [
  '栖枝 · Alight — 免责声明与使用条款',
  `作者：${AUTHOR_URL}`,
  '',
  '安装前请阅读以下条款。点击「我同意」即表示您已阅读、理解并同意全部内容。',
  '',
  termsAsText(),
  '',
  '────────────────────────────────────────',
  '源代码许可证（仅适用于本项目的源代码，不适用于第 2 条所列图像）',
  '',
  mit.trim(),
  '',
  '────────────────────────────────────────',
  '第三方源代码声明（仅 electron/pet/tts-edge-gec.cjs 一个文件，按 LGPL-3.0）',
  '',
  edgeNotice.trim(),
  '',
].join('\r\n').replace(/\r?\n/g, '\r\n');
fs.mkdirSync(at('build'), { recursive: true });
// UTF-8 with BOM so the NSIS licence page shows Chinese correctly.
fs.writeFileSync(at('build/license.txt'), '\uFEFF' + txt);
console.log('wrote DISCLAIMER.md and build/license.txt');
