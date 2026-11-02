# 栖枝 V0α 施工图（给并行实现代理）

> 产品：栖枝 · Alight —— 遐蝶的 Agent 工作台（从萤火 v2.0.0 `8c4000c` 受控 fork）。
> 设计规格：`G:/Claude Code Workplace/castorice-harness/design/DESIGN.md`（§2 体验、§3 界面、§4.2 功能表、§5 文案、§6 视觉、§7 技术、§8 路线）。
> **视觉定稿（用户 10-24 拍板）**：夜（默认）= `design/mockups/night/index.html?screen=s0|s1|s2|s3`，昼 = `design/mockups/day/…`；截图在各自 `shots/`。
> 用户原话「遐蝶主题的」：每一屏都要一眼是遐蝶（她的形象、母题、配色），但仍是每天用 8 小时的专业工作台。DESIGN.md §6.1「辨识度靠结构不靠皮肤」已作废。

## 0. V0α 要交付什么

在**可丢弃的练习目录**里完成「提问 → 工具 → 审批 → 用量」；首页已是「归来」构图；真实的「待你」队列与简版归来简；
深/浅两套主题；输入法正确；Claude 走 Agent SDK（默认用用户自己登录的 `claude`）。**不做**：隔离与 diff、遗物卡、黑色卡（手套只做钩子探针）、灯与让路、档案。

出口（门 1）：钩子探针结论（X17）；S1/S3 对萤火 v2.0.0 基线 ×1.1；IME 用例；队列测试；归来简数字＝日志；开屏期间可输入；用户目视首页。

## 1. 分工（每个文件只有一个主人）

| 模块 | 负责 | 独占文件（只有你能改） |
|---|---|---|
| **B1 外观** | S01 S02 S03 S05(视觉) S08 X10 X12；开屏 s0；把样稿的夜/昼做成真界面 | `src/styles/**`（其他模块新建的 css 除外）、`src/components/decor/**`、`src/components/ui/**`、`src/components/shell/{SideNav,StatusPanel,hosts}.tsx`、`src/App.tsx`、`src/components/views/settings/AppearanceSection.tsx`、`src/components/views/config/ModePicker.tsx`、`index.html`、`public/**`、`build/icon*`、`electron/ai/browser-ui/**`、`scripts/gen-cursors.mjs`、`scripts/cursors-from-sheet.py` |
| **B2 存储** | K07 K08 X11 K14(存储)；SQLite＋事件日志＋FTS＋备份；长会话保护；数据目录 | `electron/store/**`、`src/state/persist.ts`、`src/lib/storeBridge.ts`（新）、`src/state/usage.ts`（新）、`src/lib/presence.ts`、`src/components/workspace/Conversation.tsx`、`src/components/console/**`、`src/components/views/settings/DataSection.tsx`、`scripts/check-store.ts` |
| **B3 引擎** | K01 K02 K11 K12 K14(采集) K32(管道) X17 X05(引擎侧)；Claude Agent SDK 驱动、认证三条路、计划审批、提问卡、用量上报 | `electron/ai/**`（除 `browser-ui/`、`secrets.cjs`；`index.cjs` 里 `register()` 开头两行 require 由底座固定）、`src/state/{live,backend,engine,models,runActions}.ts`（`runActions.ts` 新）、`src/lib/{providers,effort}.ts`、`src/components/shell/ApprovalCard.tsx`、`src/components/workspace/**`（除 `Conversation.tsx`、`PromptBox.tsx`）、`src/components/views/{ModelsView,AgentsView,ToolsView}.tsx`、`src/components/views/models/**`、`src/components/views/config/**`（除 `ModePicker.tsx`）、`scripts/probe/hook-probe/**`、`scripts/check-engine.ts` |
| **B4 交互** | Q01 Q03(界面) Q07 N03 N04 S05(文案) K21 X03 X02(修复) K31 K32(界面)；声线模板、待你、归来、命令注册表、输入法守卫、输入框 | `src/lib/{voice,voice-lines,persona,commands,ime}.ts`、`src/state/{queue,brief,actions,seed,selectors,shell,skills}.ts`、`src/components/shell/{QueueNav,QuotaBar}.tsx`、`src/components/views/{ReturnView,QueueView,NewTaskView,SettingsView,TaskListView,HistoryView}.tsx`、`src/components/views/tasks/**`、`src/components/workspace/PromptBox.tsx`、`scripts/check-interaction.ts`、`scripts/unit-check.ts` |
| **B5 安全** | G01(最小) G02 G19 X04 X05(密钥)；信任阶梯、spawnGit、数据块、safeStorage 异步、CSP 回归 | `electron/trust.cjs`、`electron/git.cjs`、`electron/ai/secrets.cjs`、`src/lib/{datablock,trustBridge}.ts`、`src/state/trustGate.ts`、`src/components/shell/TrustDialogHost.tsx`、`src/components/views/settings/TrustSection.tsx`、`scripts/check-build.mjs`、`vite.config.ts`、`scripts/check-security.ts` |
| **B6 质量** | X01 X02(自动化) X06；无头 E2E 探针、基线采样、输入法用例、假 Anthropic 服务 | `scripts/probe/**`（除 `hook-probe/`）、`docs/BASELINE.md`（新） |

**底座固定、谁都别改**（要改写进你的报告，由集成者改）：`src/lib/types.ts`、`src/lib/desktop.ts`、`electron/preload.cjs`、`electron/main.cjs`、`package.json`、`src/state/store.ts`。

**新文件**：只能建在你的目录范围里；样式新建 `src/styles/<模块>-*.css` 并在你自己的组件里 import，B1 不给别人的类名写样式。

## 2. 契约（已在底座里）

- **类型**（`src/lib/types.ts` 末尾「栖枝 V0α 新增」）：`ThemeId`（`'night'|'day'`，`Settings.mode` 用它）、`PermissionMode`、`TrustLevel`、`Distance`、`Question`、`QueueItem`/`QueueKind`、`UsageRecord`、`UsageSummary`；`Run.questions`、`Run.planApproval`、`Run.costUsd`；`Task.lastSeenAt`、`Task.trust`；`TaskEngine.permissionMode`；`Settings.distance/motionTier/returnAfterMin`；`AppState.usage/lastSeen`；`ViewId` 加 `'queue'`（`'new'` 现在是首页「归来」）。
- **桥**（`src/lib/desktop.ts`）：`desktop.call(channel, …args)`，通道前缀限 `store: trust: usage: git: probe:`；主进程用 `require('./ai/index.cjs').handle` 同款的来源检查登记（`electron/store/index.cjs`、`electron/trust.cjs` 的 `register(handle)` 已被调用）。`desktop.app.setBadge({count, png, label})` 贴任务栏角标。
- **流事件**新增：`question`（AskUserQuestion，回答＝`desktop.answer(id, requestId, 'allow', { answers })`）、`plan-ready`（ExitPlanMode，allow＝批准执行）、`rate-limit`、`context`。`StartSpec` 新增 `permissionMode`、`trust`。
- **占位模块**（有签名、空实现，主人去填）：`src/state/queue.ts` `deriveQueue`/`queueSummary`；`src/lib/voice.ts` `say`；`src/state/brief.ts` `deriveBrief`；`src/lib/commands.ts` `registerCommand`/`useCommandKeys`；`src/lib/datablock.ts` `dataBlock`/`DATA_BLOCK_RULE`；`src/state/trustGate.ts` `requestTrust`/`trustLevel`；组件 `QueueNav`、`QuotaBar`、`ReturnView`、`QueueView`、`TrustDialogHost`、`AppearanceSection`、`DataSection`、`TrustSection`。App.tsx 与 SideNav 已经渲染它们。
- **调用关系**：
  - Composer（B4）开始工作任务前 `await requestTrust(cwd)`（B5）→ 结果写进 `task.trust`；`live.ts`（B3）把 T0 当只读（`access 'read'`）并填 `spec.trust`。
  - `live.ts`（B3）拼提示词时，网页/命令输出/MCP 结果/旧会话/指令文件用 `dataBlock()`（B5）包起来，系统提示加 `DATA_BLOCK_RULE`。
  - `live.ts`（B3）每个回合结束调用 `recordUsage(rec: UsageRecord)`（B2 在 `src/lib/storeBridge.ts` 导出），并把 `costUsd` 累加到 `run.costUsd`。
  - `deriveQueue`（B4）读 `run.approvals`（pending）、`run.questions`（pending）、`run.planApproval`（pending）、失败/中断的 run、`task.lastSeenAt` 之后结束的回合。B3 负责把这些字段写对。
  - 用户在「待你」里回答问题/批准计划：B3 在 `src/state/runActions.ts` 导出 `answerQuestion(questionId, answer)`、`decidePlan(runId, 'approve'|'revise', note?)`；B4 的界面调用它们。批准工具仍是 `backend.decideApproval`。
  - SettingsView（B4）渲染 `AppearanceSection`（B1）、`DataSection`（B2）、`TrustSection`（B5），外加 B4 自己的「称呼与距离」。
  - 归来简与所有「她说的话」走 `say()`（B4）；B1/B3 需要台词时调用 `say(scene, slots)`，场景名写进报告，B4 补变体。

## 3. 规则

1. 正文、界面文案一律中文；她称用户「阁下」（可在设置里改称呼）；省略号呼吸、「愿……」收尾；不用感叹号、不说「想你/欢迎回来！」、不挽留、不声称有感受；不用「收割/处决/kill/凋零特效」。放行、排序、证据只由确定性代码决定。
2. 形象只用官方图或用户选定的壁纸（`design/mockups/assets/`：wallpaper-night.jpg＝终版夜景〔AI 辅助同人图，须署名〕、wallpaper-day.jpg、splash-official.png、figure-official.png、face-gentle.png、chibi-official.png）；不变形、不拉伸、不改色、不水平翻转；不用 `ref/实机截图*`（带 UID）。
3. **不要启动任何可见窗口**（Electron、浏览器、安装包）。要跑 Electron 只用无头探针：`ALIGHT_PROBE=1` 且 `--user-data-dir=<scratchpad 下的临时目录>`（主进程已支持：不显示窗口、不建托盘）。用完关掉进程。
4. 不要并发 `npm run verify` / `vite build` / `npm install`（会抢 `dist/` 与 `node_modules`）。工作中只跑 `npx tsc --noEmit` 和你自己的 `npm run check:<模块>`（rolldown 输出到各自的 `node_modules/.cache/check-<模块>.mjs`）。tsc 报别人文件的错：不要去改，写进报告。
5. 不改别人的独占文件；需要别人改的，写进报告的 `requests`。不 `git commit`（集成者统一提交）。
6. 不读 `~/.claude/.credentials.json`；不把任何密钥写进 `os.tmpdir()` 明文文件；测试用假服务器与临时 `CLAUDE_CONFIG_DIR`，不花用户的额度。
7. 临时文件放 `C:/Users/27842/AppData/Local/Temp/claude/G--Claude-Code-Workplace/9bd55743-d7e5-4a08-a41a-f20269557ef9/scratchpad/v0a/<模块>/`。Git Bash 里含中文的 heredoc 易坏，先用 Write 写文件再运行。
8. 本机特例：笔记本独显持续 3D 负载会触发 ACPI 中断风暴——常驻动效默认集显、30 fps 封顶、页面隐藏即暂停、可关；不要跑长时间 GPU 压测。

## 4. 各模块验收要点

- **B1**：夜/昼两套令牌与样稿一致（色值见样稿 index.html 与 DESIGN §6.2，强调色取她的发色藕紫）；壁纸玻璃＋字形光晕（萤火的做法，正文对比度 ≥4.5:1）；开屏「蝶落枝头」可跳过且**开屏期间应用可输入**（不再 `inert`）；品牌标「枝上蝶」与火种五笔加载自绘；冥河细线；落雪/蝴蝶克制且三档预算（A 省电/B 标准）＋页面隐藏暂停＋减少动态；去掉萤火的星空、萤火虫、萨姆装甲、主题光标、ConvergenceBurst；托盘/窗口图标换成栖枝；左栏结构按样稿（「待你」在顶部，额度条在底部）。
- **B2**：`node:sqlite` 库（放 `<dataDir>/alight.db`，WAL）；任务/运行/事件持久化，启动只加载每个会话尾部（K08：绝不整份读进渲染进程，长会话分页、列表虚拟化，单条工具输出 >5 KB 只存摘要＋按需取全文）；`VACUUM INTO` 备份；从旧 localStorage 一次性迁移；`usage:add`/`usage:summary`（今日/本周，标估算）；数据目录可选、C 盘余量 <15 GB 时提示；`check-store` 覆盖迁移、分页、备份、用量汇总。
- **B3**：`electron/ai/claude-sdk.cjs` 用 `@anthropic-ai/claude-agent-sdk`（ESM，主进程 `await import()`）；默认 `pathToClaudeCodeExecutable` 指向用户自己的 `claude.exe`（从 PATH 的 `claude.cmd` 解析，例如 `G:/ClaudeCode/node_modules/@anthropic-ai/claude-code/bin/claude.exe`），不碰令牌；`settingSources: ['user']`、`strictMcpConfig: true`；`PreToolUse` 钩子为主路径（allow/deny/ask），`canUseTool` 处理问答与计划；`AskUserQuestion`→`question` 事件；计划模式＋`ExitPlanMode`→`plan-ready`；`usage`/`context`/`rate-limit`/`done.costUsd`；浏览器 MCP 用 `mcpServers` 对象直传（不写临时文件）；SDK 加载失败时退回旧的 stream-json 驱动并提示。认证三条路（自己的 claude / API 密钥＋日月硬预算＋「这是 API 计费」提示 / 打开自己的登录流程），**不替用户登录**。K11：计划出来先进 `run.planApproval = pending`，批准后才执行（萤火是直接执行）；K12：问题进 `run.questions`；K32：输入框权限模式映射到 SDK `permissionMode`。**X17 钩子探针**：用假 Anthropic 服务（本机 127.0.0.1，`ANTHROPIC_BASE_URL`＋假 key＋临时 `CLAUDE_CONFIG_DIR`）验证 `PreToolUse` 在 default/acceptEdits/auto(若有)/bypass 下是否仍触发、deny/ask 语义、子 agent 是否触发，结论写 `docs/HOOK-PROBE.md`。
- **B4**：`say()` 纯函数＋高频场景 ≥8 变体＋种子轮换＋黄金输出测试＋文案 lint；`deriveQueue` 确定性（1,000 个随机状态的性质测试：排序稳定、无重复、计数＝界面）；「待你」页与左栏入口（最久等待时间）；任务栏角标（画小图调 `desktop.app.setBadge`）；归来页按样稿 s1（夜/昼）；归来简数字全部可追到运行记录；命令注册表（萤火原有全局键迁进来）；IME 守卫（`isComposing` 时回车不发送、Esc 只取消组合；修复设置页「称呼」框与模型 ID 框回车即提交）；输入框：闲聊/工作（不靠模型自动分类）、权限模式芯片、「寄往 目录·引擎·手套」信封样式（样稿 s1/s2）；设置：称呼、距离 0–2。
- **B5**：信任存储（userData/trust.json，键＝realpath(git 顶层)）；`requestTrust` 弹框（一键「这是我自己的目录」）；T0 只读；`spawnGit()` 加固并有测试（夹带 `core.fsmonitor`/`post-checkout` 的仓库不得执行它们）；`dataBlock()` 带 nonce 边界、限长、来源；`secrets.cjs` 改 `safeStorage` 异步 API（Electron 45 同步版已弃用），兼容读取旧文件；CSP 回归（`img-src 'self' data: blob:`、`connect-src 'self'` 不得放宽，`check-build.mjs` 覆盖所有页面）。
- **B6**：`scripts/probe/run.mjs` 无头启动（`ALIGHT_PROBE=1`＋临时 user-data-dir＋`--remote-debugging-port`），能驱动页面、截图、读控制台；假 Anthropic 服务（流式 SSE，能回放 tool_use / AskUserQuestion / ExitPlanMode）；基线采样 S1（冷启动到可输入）/S2（空闲内存）/S3（长会话首屏与内存）/S5（后台 CPU），先测萤火 `8c4000c`（用 `git worktree add <scratchpad>/ff 8c4000c`，复用本仓库 node_modules 的 Electron 45，只加隐藏窗口补丁）再测当前栖枝，写 `docs/BASELINE.md`；IME 用例 IME-1…10 用 CDP `Input.imeSetComposition` 自动化，做不到的列人工清单。
