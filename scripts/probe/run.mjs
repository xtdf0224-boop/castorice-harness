#!/usr/bin/env node
// 栖枝 · 无头 E2E 探针入口。用法见 `node scripts/probe/run.mjs help`。
// 约束：不弹可见窗口（ALIGHT_PROBE=1 + 临时 user-data-dir）；不改应用代码；不花真实额度（模型走本机假服务）。
import { parseArgs } from 'node:util';
import { makeContext } from './lib/ctx.mjs';

const HELP = `栖枝 · 无头探针
用法：node scripts/probe/run.mjs <子命令> [选项]

子命令
  smoke      启动 → 首页渲染 → 无控制台错误 → 退出（并确认没有残留进程）
  baseline   O9 采样：S1 冷启动到可输入 / S2 空闲内存 / S3 长会话 / S5 后台 CPU
  ime        输入法用例 IME-1…10（能自动化的跑，其余列人工清单）
  shot       截图：指定视图 / 主题 / 尺寸；加 --fixture 注入验收状态（Agent 页 / 对话 / 工作 / 归来…）再截
  shots      清单驱动的批量验收截图（按「主题 × 话量」一次启动，页面里循环切状态；-nowall 另按主题一轮）
  flows      验收流程 ①–⑪ 的断言版（闲聊标签、失败卡外一句、工作流、命令行路线、话量与口吻、提示词、D-01…D-10 DOM、Agent 页、闸门、危机、落蝶）
  shell      壳：窗口藏进托盘/最小化时页面知道（app:visibility）、被全屏程序盖住时动效停下（app:covered）、夜昼切换同步原生标题栏与窗口底色（app:theme）；经主进程调试端口驱动
  views      夜、昼 × 全部视图的巡检：能切主题、控制台无新错误（含资源 404）、署名（[data-credit]）可见且没被盖住；--out 同时存截图
  ffbase     建（或 --remove 拆）萤火 v2.0.0 基线应用（git worktree 8c4000c，复用本仓库 node_modules），打印目录
  fake       只启动本机假 Anthropic 服务并打印地址（调试用，Ctrl+C 退出）
  selftest   探针自身的离线自检（不启动 Electron，几秒钟；集成者可挂成 check:probe）
  clicheck   用真实的 claude.exe（--cli 指定，默认从 PATH 解析）对着假服务跑一轮工具往返，确认假服务协议够用（假密钥、临时配置目录，不花额度）
  report     把 baseline 结果 JSON 渲染成 Markdown 表格：report --json <结果.json> [--md <输出.md>]
  help       本说明

通用选项
  --app-dir <目录>     被测应用目录（含 package.json、node_modules、dist/）；默认本仓库。基线用 git worktree 的目录
  --target ff|alight   应用类型（默认按 package.json 的 name 判断）
  --tmp <目录>         临时文件根目录（默认 %TEMP%/alight-probe，或环境变量 ALIGHT_PROBE_TMP）
  --json <文件>        把结果写成 JSON
  --out <目录>         截图等产物目录

baseline 选项
  --only s1,idle,s3    只跑其中一部分（s2/s5 即 idle）
  --runs 7             S1 次数（第 1 次单列，其余算 P75/P95）
  --idle 300           S2/S5 静置秒数；--sample 30 采样间隔秒
  --s3-runs 3          S3 次数
  --s1-boot            另测「开屏开着」时的可输入时间
  --osr                S3 用离屏渲染 + 60 fps + 软件渲染（隐藏窗口里合成器只有约 1 Hz，主线程 Commit 会被卡 1 秒，量出的是假象）；S2/S5 不用
  --wakeups            S2/S5 静置时同时开主进程调试端口，读 app.getAppMetrics() 的 percentCPUUsage 与 idleWakeupsPerSecond
  --quick              冒烟档：3 次 / 40 秒 / 1 次，只验证流程
  --vs <基线应用目录>    S1 与基线应用「同场交错」测（ABAB…，环境噪声一致，另带空 Electron 作底噪）；判定用同场数字
  --compare <基线.json>  对照基线 JSON（S2/S3/S5 用），按「绝对线与基线×1.1 取较严」判定

shot 选项
  --view new|queue|tasks|agents|tools|models|history|settings   要截的页面（Alt+1…7；queue 无快捷键则点左栏）
  --theme night|day    主题（默认 night）     --width 1440 --height 900 --scale 1
  --seed tasks         先写入若干合成任务（让列表页不空）
  --file <名字>        输出文件名（默认 <view>-<theme>.png）     --wait 1200 截图前等待毫秒

shot 的验收选项（被测副本要用 --mode development 构建，否则没有 window.__alight.applyFixture）
  --fixture <名>       devFixture 里的状态（agents-idle / chat-reply / work-approval-high / return-brief / avatar-crop …，全清单见 src/components/decor/devFixture.ts 的 FIXTURE_NAMES）
  --level s|m|l        话量（默认 m）          --persona on|off   角色口吻（默认 on）
  --theme night|day    主题                    --wallpaper on|off 壁纸（默认 on）
  --click <步骤>       可多次：click:<css> / clicktext:<文字>[@<容器css>] / scroll:<css> / wait:<毫秒> / key:<键> / hover:<css> / eval:<js>
  --wait <毫秒>        截图前等待（默认 900）   --date <本地时间>  把页面时钟拨到这个时刻（如 2026-10-27T23:42:00）
  --width / --height   窗口尺寸

shots 选项
  --manifest <清单>    默认 design/chat/accept/manifest.json（scripts/probe/manifest-gen.mjs 生成）
  --out <目录>         默认清单所在目录          --only <正则>  只拍文件名匹配的   --theme / --level  过滤
  --limit N            只拍前 N 张              --resume       已有（>2 KB）的跳过   --list  只列分组与条目，不启动
  --no-preflight       不查本机是否有别的重活（调试用；正式拍摄别用）

flows 选项
  --only 1,2,8         只跑其中几个流程（编号 1–11）      --json <文件>  结果写成 JSON

ffbase 选项
  --remove             拆除基线 worktree（先拆 node_modules 目录联接，再 git worktree remove）
  --rebuild            强制重新 vite build

退出码：0 全部通过；1 有失败项；2 用法或环境错误。`;

const OPTIONS = {
  'app-dir': { type: 'string' }, target: { type: 'string' }, tmp: { type: 'string' }, json: { type: 'string' }, out: { type: 'string' },
  only: { type: 'string' }, runs: { type: 'string' }, idle: { type: 'string' }, sample: { type: 'string' }, 's3-runs': { type: 'string' },
  's1-boot': { type: 'boolean' }, osr: { type: 'boolean' }, quick: { type: 'boolean' }, compare: { type: 'string' }, vs: { type: 'string' }, keep: { type: 'boolean' }, remove: { type: 'boolean' }, wakeups: { type: 'boolean' }, rebuild: { type: 'boolean' }, wait: { type: 'string' },
  view: { type: 'string' }, theme: { type: 'string' }, width: { type: 'string' }, height: { type: 'string' }, scale: { type: 'string' },
  seed: { type: 'string' }, cli: { type: 'string' }, file: { type: 'string' }, md: { type: 'string' }, port: { type: 'string' }, verbose: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  fixture: { type: 'string' }, level: { type: 'string' }, persona: { type: 'string' }, wallpaper: { type: 'string' }, click: { type: 'string', multiple: true }, date: { type: 'string' },
  manifest: { type: 'string' }, limit: { type: 'string' }, resume: { type: 'boolean' }, list: { type: 'boolean' }, 'no-preflight': { type: 'boolean' },
};

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { process.stdout.write(`${HELP}\n`); return 0; }
  let values;
  try { ({ values } = parseArgs({ args: rest, options: OPTIONS, allowPositionals: false })); } catch (e) { process.stderr.write(`参数错误：${e.message}\n\n${HELP}\n`); return 2; }
  if (values.help) { process.stdout.write(`${HELP}\n`); return 0; }
  if (process.platform !== 'win32') { process.stderr.write('探针目前只支持 Windows（进程树采样用 PowerShell）。\n'); return 2; }
  if (cmd === 'fake') {
    const { startFakeAnthropic } = await import('./fake-anthropic.mjs');
    const fake = await startFakeAnthropic({ port: values.port ? Number(values.port) : 0 });
    process.stderr.write(`假 Anthropic 服务：${fake.baseUrl}（POST /v1/messages，key 任意）\n按 Ctrl+C 退出\n`);
    await new Promise(() => {});
    return 0;
  }
  const loaders = {
    smoke: () => import('./cmd/smoke.mjs').then((m) => m.runSmoke),
    baseline: () => import('./cmd/baseline.mjs').then((m) => m.runBaseline),
    ime: () => import('./cmd/ime.mjs').then((m) => m.runIme),
    shot: () => import('./cmd/shot.mjs').then((m) => m.runShot),
    shots: () => import('./cmd/shots.mjs').then((m) => m.runShots),
    flows: () => import('./cmd/flows.mjs').then((m) => m.runFlows),
    views: () => import('./cmd/views.mjs').then((m) => m.runViews),
    shell: () => import('./cmd/shell.mjs').then((m) => m.runShell),
    ffbase: () => import('./cmd/ffbase.mjs').then((m) => m.runFfbase),
    selftest: () => import('./cmd/selftest.mjs').then((m) => m.runSelftest),
    report: () => import('./cmd/report.mjs').then((m) => m.runReport),
    clicheck: () => import('./cmd/clicheck.mjs').then((m) => m.runClicheck),
  };
  if (!loaders[cmd]) { process.stderr.write(`未知子命令：${cmd}\n\n${HELP}\n`); return 2; }
  try {
    const ctx = makeContext(values, cmd);
    const fn = await loaders[cmd]();
    return await fn(ctx);
  } catch (e) {
    process.stderr.write(`探针出错：${e.stack ?? e.message}\n`);
    return 2;
  }
}

main().then((code) => process.exit(code), (e) => { process.stderr.write(`${e.stack ?? e}\n`); process.exit(2); });
