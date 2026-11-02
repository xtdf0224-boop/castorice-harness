# 钩子探针结论（X17 · V0α 出口测试）

> 问题：Claude Agent SDK 里的 `PreToolUse` 钩子，能不能当栖枝的"放行主路径"（手套 L4，DESIGN §3.7 / §7.3）？
> 做法：本机假 Anthropic 服务 + `ANTHROPIC_BASE_URL` + 假密钥 + 临时 `CLAUDE_CONFIG_DIR`，用 SDK 自带的 claude 二进制按脚本回放 `tool_use`，96 个场景，不联网、不花额度、不碰用户的 claude 与配置。
> 版本：`@anthropic-ai/claude-agent-sdk` 0.3.310，SDK 自带 claude 2.1.310；另在假服务上用用户本机的 claude 2.1.306 跑通了驱动的最小场景（SDK 与它兼容）。
> 复现：`node scripts/probe/hook-probe/probe.mjs --out <目录>`（约 3 分钟，输出 `results.json` 与 `tables.md`）；驱动的端到端检查：`node scripts/probe/hook-probe/driver-check.mjs`；整套：`npm run check:engine`。

## 0. 结论

**钩子能当主路径，手套 V1b 不必降级到 L3/L1。** 在 `default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`、`auto` 六种模式下，主线和子代理、内置工具和 MCP 工具，`PreToolUse` 都会先于引擎自己的判定触发；`deny` 在任何模式下都拦得住（包括"放手"和"自动"）；`ask` 能把"放手""自动""不再询问"拉回到人工确认。

但有五条必须照办（栖枝的实现已按这些写，见 `electron/ai/perm.cjs`、`claude-sdk.cjs`）：

1. **钩子回调自己出错 = 没表态 = 照常放行。** 回调抛异常，工具会按当前模式继续（`bypassPermissions` / `acceptEdits` / `auto` 下直接执行）。所以钩子必须整体包 `try/catch`，出错一律返回 `deny`（fail-closed）。
2. **不要用 `defer`。** 钩子返回 `defer`：工具不执行，也没有 `tool_result`，这一轮以 `stop_reason: tool_deferred` 结束。"停下来问人"用 `ask`。
3. **`allow` 只给白操作。** `allow` 在 `default / acceptEdits / bypassPermissions / dontAsk / auto` 下都直接执行，并且跳过 canUseTool 和 `auto` 的分类器；规则表只在"确定无副作用"时才返回 `allow`，其余返回 `ask` 或 `deny`，不确定就不表态。
4. **计划模式不是确定性的只读。** SDK 的 `plan` 模式里，Write 仍然会问（可以放行），**命令工具会交给安全分类器，分类器放行就真的执行了**，钩子的 `allow` 也不能跳过分类器。栖枝在计划阶段另外用钩子强制只读（写入、命令、浏览器点击一律 `deny`），不依赖 `plan` 模式本身。
5. **提问和计划不走钩子。** `AskUserQuestion`、`ExitPlanMode` 不管钩子怎么说、不管什么模式（包括 `bypassPermissions`），都会进 `canUseTool`；而且 `canUseTool` 没提供时，`AskUserQuestion` 在会话里根本不存在。钩子对这两个工具一律不表态。

## 1. 结果总表

### 1.1 写入（Write，界内新文件）× 模式 × 钩子决定

| 模式 | 钩子不表态 | `allow` | `deny` | `ask` | `defer` | 回调抛异常 |
|---|---|---|---|---|---|---|
| default | 问（canUseTool） | 直接执行 | 拦 | 问 | 不执行·回合结束 | 同"不表态"：问 |
| acceptEdits | 直接执行（界内编辑） | 直接执行 | 拦 | **问** | 同左 | 直接执行 |
| bypassPermissions | 直接执行 | 直接执行 | 拦 | **问** | 同左 | 直接执行 |
| plan | 问（计划模式里写入也要问） | **仍然问** | 拦 | 问 | 同左 | 问 |
| dontAsk | 拒绝（"don't ask 模式"） | 直接执行 | 拦 | **问** | 同左 | 拒绝 |
| auto | 直接执行（界内编辑不过分类器） | 直接执行 | 拦 | **问** | 同左 | 直接执行 |

### 1.2 命令工具（本机是 PowerShell，没有 Bash 工具）× 模式 × 钩子决定

| 模式 | 钩子不表态 | `allow` | `deny` |
|---|---|---|---|
| default | 问 | 直接执行 | 拦 |
| acceptEdits | 问（"接受编辑"不含命令） | 直接执行 | 拦 |
| bypassPermissions | 直接执行 | 直接执行 | 拦 |
| plan | **交给分类器**：放行就执行，拦截就拒绝 | **仍交给分类器** | 拦 |
| dontAsk | 拒绝 | 直接执行 | 拦 |
| auto | **分类器决定**：放行→执行；拦截→拒绝；回复看不懂→拒绝，且不会弹 canUseTool | 直接执行（不调用分类器） | 拦 |

### 1.3 其他

| 项 | 结果 |
|---|---|
| 子代理（`Agent` 工具） | `Agent` 本身触发一次钩子；子代理里的每个工具调用也触发，输入带 `agent_id`（如 `a093722fcce57ed51`）和 `agent_type`（`general-purpose`）；`canUseTool` 的选项里有 `agentID`。`deny` 对子代理同样有效，`bypassPermissions` 下也一样。`Agent` 默认异步启动（`Async agent launched successfully`），主线不等它 |
| MCP 工具（`mcp__stub__ping`，经 `mcpServers` 对象直传） | `default`、`bypassPermissions`、`auto` 下都触发；`deny` 都拦得住；无钩子表态时：`default` 问，`bypassPermissions` 直接执行，`auto` 由分类器决定（本次脚本回的是放行，所以执行了） |
| 只读工具（Read） | `bypassPermissions` 下也触发；`deny` 也拦（模型收到 `PreToolUse:Read hook error: …`） |
| `deny` 的原因 | 原样回到模型，格式 `PreToolUse:<工具> hook error: <permissionDecisionReason>`，`is_error: true`。所以原因要写给模型看，不要带不想让模型知道的内容 |
| `ask` 的原因 | 出现在 `canUseTool` 选项的 `decisionReason` 里（"这次要访问工作文件夹以外的位置：…"）；`hook:PermissionRequest` 随后触发 |
| `canUseTool` 在 `bypassPermissions` 下 | 不会被调用（SDK 会发 `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` 警告），**除非钩子返回 `ask`**，或工具是 `AskUserQuestion` / `ExitPlanMode` |
| 流式输入 | `query.setPermissionMode('acceptEdits')` 在两轮之间生效，下一轮的钩子输入里 `permission_mode` 就是新值；`interrupt()` 之后可以接着发下一句 |

## 2. 提问与计划

### 2.1 AskUserQuestion

- 工具输入：`{"questions":[{"question":"封面选哪一张？","header":"封面","options":[{"label":"A 夜景","description":"第一张"},…],"multiSelect":false}]}`。
- 回答：`canUseTool` 返回 `{behavior:'allow', updatedInput:{questions, answers:{"封面选哪一张？":"B 白昼"}}}`；模型收到 `Your questions have been answered: "封面选哪一张？"="B 白昼".`（多选用逗号连接）。
- 拒绝（`deny` + message）：模型收到 message，`is_error: true`。
- 钩子对它说 `allow`、模式是 `bypassPermissions` / `acceptEdits` / `plan`：**`canUseTool` 照样被调用**。
- 没有提供 `canUseTool`：`No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session`。
- 栖枝的实现：`question` 事件（`requestId`、`callId`、`questions`）→ 页面写进 `run.questions`（pending）→ 回答经 `desktop.answer(id, requestId, 'allow', { answers })` 交还。同一次提问的几个问题合并成一次打断，全答完才交还。

### 2.2 ExitPlanMode

- **它是延迟工具**：不在首轮请求的工具列表里，模型要先 `ToolSearch({query:"select:ExitPlanMode"})`，之后才能调用；直接调用会失败。
- **计划正文在计划文件里，不在工具输入里**：模型先把计划写到 `<CLAUDE_CONFIG_DIR>/plans/<随机名>.md`（计划模式的系统提示里写明路径，写这个文件不会触发 canUseTool），再调 `ExitPlanMode`；此时 `canUseTool` 的输入是 `{"plan":"# 计划\n1. …","planFilePath":"…\\plans\\xxx.md"}`。
- 批准（`allow`，不带 `updatedPermissions`）：模式回到 `default`，之后的写入照常问。批准并带 `updatedPermissions:[{type:'setMode', mode:'acceptEdits', destination:'session'}]`：之后的写入不再问，钩子看到的 `permission_mode` 也是 `acceptEdits`。
- 驳回（`deny` + message）：模型收到 message，模式仍是 `plan`。
- 钩子对它说 `allow`：`canUseTool` 照样被调用。
- 栖枝的实现：`plan-ready` 事件（`plan` 取输入里的 `plan`）。计划阶段（栖枝自己的"出计划→批准→执行"）收到它就用 `deny` 加"计划已交给栖枝收取"的说明把这一轮收住，并把正文读成步骤；其他阶段变成一张审批卡。

### 2.3 自动模式的分类器

- 自动模式（以及计划模式里的命令工具）会多发一次**真实的模型请求**：系统提示自称 "security monitor for autonomous AI coding agents"（约 140 KB），模型是 `claude-sonnet-5`（不是主模型），要求回复 `<severity>N</severity>`（N<50 放行，>50 拦截，可带 `<category>`）。**这是额外的额度消耗**，界面上要写明。
- 钩子 `allow` / `deny` / `ask` 都先于分类器；`allow` 在自动模式下跳过分类器，在计划模式下不跳过。
- 拦截时的消息：`Permission for this action was denied by the Claude Code auto mode classifier. Reason: [<category>]`；回复看不懂时：`Auto mode could not evaluate this action and is blocking it for safety`（重试约 10 次，每次一个请求）。两种都会发 `system/permission_denied` 消息和 `PermissionDenied` 钩子事件，但**不会**弹 `canUseTool`（SDK 类型注释说"判断不了时走 canUseTool"，本次未观察到）。

## 3. 对栖枝实现的影响（已落实）

| 位置 | 做法 |
|---|---|
| `perm.cjs · makePreToolUseHook` | 整个回调 try/catch，出错返回 `deny`（理由写明"权限钩子出错"）；check-engine 有"钩子出错 → deny"的用例 |
| `perm.cjs · hookDecision` | 只会返回 `deny`（工具策略里关掉的、只读运行里的写入与命令、未信任目录 T0）、`ask`（越出工作文件夹的路径，包括"放手""自动""接受编辑"下）、或不表态；**不返回 `allow` / `defer`** |
| 权限模式映射 | 逐项→`default`，接受编辑→`acceptEdits`，计划→`plan`（仅计划阶段）/`default`（执行阶段），自动→`auto`，放手→`bypassPermissions`（`allowDangerouslySkipPermissions`）；`init` 里实际模式与请求不同（版本不认 `auto` 等）时发 notice 说降级 |
| 计划阶段 | 栖枝自己强制只读（钩子 `deny` 写入 / 命令 / 浏览器点击；页面的工具禁用名单也加上写入工具），不依赖 `plan` 模式 |
| 越界 | 自动放行类模式下 claude 自己不会问越界路径，钩子返回 `ask`，页面照旧弹"这次要访问工作文件夹以外的位置" |
| 子代理 | 钩子对子代理同样生效，不需要额外处理；子代理的停止冒泡属于 V0β（K13） |
| 自动模式 | 页面说明里写"会多用一点额度；判断不了的会直接拒绝" |

## 4. 没有验证的

- **真实模型的反应**：脚本里的模型是回放的。真实模型对 `deny` 原因、"计划已交给栖枝收取"这类说明会怎样接话，没有测（那要花额度，留给用户的练习目录试用）。
- **真实分类器的判断**：分类器的回答是脚本给的。真实的 `claude-sonnet-5` 会放行或拦下哪些命令没有测。
- **用户级 hooks 并存**：`settingSources:['user']` 会加载用户自己的 `~/.claude/settings.json` 里的 hooks，它们和栖枝的钩子一起跑；探针用的是空配置，没有测两者的顺序与冲突。
- **钩子超时**：回调一直不返回会怎样没测（栖枝的钩子是同步决定，不等人）。
- **Bash 工具**：本机的 SDK 会话只有 PowerShell 工具，没有 Bash；`toolCategory` 两者都认。
- **子代理停止冒泡、`fork` 子代理类型**：没有测。
- **asar 与二进制**：SDK 随包的 claude 约 298 MB，打包进 asar 时要放在 `asar.unpacked`（`claude-path.cjs` 已按这个路径找）；是否随包由集成者定。

## 附录 A　原始表格（脚本生成，路径已脱敏）

下面是 `tables.md` 的原样内容：每个场景的实际模式、钩子是否触发与返回、`canUseTool` 是否被调用、是否真的执行（以文件是否生成为准）、模型收到的 `tool_result`。

SDK 0.3.310，自带二进制 2.1.310，2026-10-24T05:28:41.024Z。

### 表 A　Write × 模式 × 钩子决定

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `A.write/default/hook=none` | default | 是 ×1 | none | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-9bvPH8\work\out.txt (file state i |
| `A.write/default/hook=allow` | default | 是 ×1 | allow | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-EOtuUa\work\out.txt (file state i |
| `A.write/default/hook=deny` | default | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A.write/default/hook=ask` | default | 是 ×1 | ask | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-UY2rYs\work\out.txt (file state i |
| `A.write/default/hook=defer` | default | 是 ×1 | defer | 否 | 否 | — |
| `A.write/default/hook=throw` | default | 是 ×1 | THROW | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-HuyLe6\work\out.txt (file state i |
| `A.write/acceptEdits/hook=none` | acceptEdits | 是 ×1 | none | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-L6RNLf\work\out.txt (file state i |
| `A.write/acceptEdits/hook=allow` | acceptEdits | 是 ×1 | allow | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-nEkugw\work\out.txt (file state i |
| `A.write/acceptEdits/hook=deny` | acceptEdits | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A.write/acceptEdits/hook=ask` | acceptEdits | 是 ×1 | ask | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-F99TBO\work\out.txt (file state i |
| `A.write/acceptEdits/hook=defer` | acceptEdits | 是 ×1 | defer | 否 | 否 | — |
| `A.write/acceptEdits/hook=throw` | acceptEdits | 是 ×1 | THROW | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-WJV2Og\work\out.txt (file state i |
| `A.write/bypassPermissions/hook=none` | bypassPermissions | 是 ×1 | none | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-TegL0b\work\out.txt (file state i |
| `A.write/bypassPermissions/hook=allow` | bypassPermissions | 是 ×1 | allow | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-3UoDrk\work\out.txt (file state i |
| `A.write/bypassPermissions/hook=deny` | bypassPermissions | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A.write/bypassPermissions/hook=ask` | bypassPermissions | 是 ×1 | ask | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-nWSJ5o\work\out.txt (file state i |
| `A.write/bypassPermissions/hook=defer` | bypassPermissions | 是 ×1 | defer | 否 | 否 | — |
| `A.write/bypassPermissions/hook=throw` | bypassPermissions | 是 ×1 | THROW | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-4CUlbP\work\out.txt (file state i |
| `A.write/plan/hook=none` | plan | 是 ×1 | none | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-63Sntm\work\out.txt (file state i |
| `A.write/plan/hook=allow` | plan | 是 ×1 | allow | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-Iu5pj5\work\out.txt (file state i |
| `A.write/plan/hook=deny` | plan | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A.write/plan/hook=ask` | plan | 是 ×1 | ask | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-si8LwB\work\out.txt (file state i |
| `A.write/plan/hook=defer` | plan | 是 ×1 | defer | 否 | 否 | — |
| `A.write/plan/hook=throw` | plan | 是 ×1 | THROW | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-mF2MNT\work\out.txt (file state i |
| `A.write/dontAsk/hook=none` | dontAsk | 是 ×1 | none | 否 | 否 | 【错】Permission to use Write has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* |
| `A.write/dontAsk/hook=allow` | dontAsk | 是 ×1 | allow | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-9zuxTv\work\out.txt (file state i |
| `A.write/dontAsk/hook=deny` | dontAsk | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A.write/dontAsk/hook=ask` | dontAsk | 是 ×1 | ask | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-KYqHqz\work\out.txt (file state i |
| `A.write/dontAsk/hook=defer` | dontAsk | 是 ×1 | defer | 否 | 否 | — |
| `A.write/dontAsk/hook=throw` | dontAsk | 是 ×1 | THROW | 否 | 否 | 【错】Permission to use Write has been denied because Claude Code is running in don't ask mode. IMPORTANT: You *may* |
| `A.write/auto/hook=none` | auto | 是 ×1 | none | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-JNmtnj\work\out.txt (file state i |
| `A.write/auto/hook=allow` | auto | 是 ×1 | allow | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-DPGy66\work\out.txt (file state i |
| `A.write/auto/hook=deny` | auto | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A.write/auto/hook=ask` | auto | 是 ×1 | ask | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-O54o6M\work\out.txt (file state i |
| `A.write/auto/hook=defer` | auto | 是 ×1 | defer | 否 | 否 | — |
| `A.write/auto/hook=throw` | auto | 是 ×1 | THROW | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-tidgpe\work\out.txt (file state i |

### 表 B　命令工具 × 模式 × 钩子决定

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `B.shell/default/hook=none` | default | 是 ×1 | none | 是 ×1 | 是 | (PowerShell completed with no output) |
| `B.shell/default/hook=deny` | default | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `B.shell/default/hook=allow` | default | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `B.shell/acceptEdits/hook=none` | acceptEdits | 是 ×1 | none | 是 ×1 | 是 | (PowerShell completed with no output) |
| `B.shell/acceptEdits/hook=deny` | acceptEdits | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `B.shell/acceptEdits/hook=allow` | acceptEdits | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `B.shell/bypassPermissions/hook=none` | bypassPermissions | 是 ×1 | none | 否 | 是 | (PowerShell completed with no output) |
| `B.shell/bypassPermissions/hook=deny` | bypassPermissions | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `B.shell/bypassPermissions/hook=allow` | bypassPermissions | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `B.shell/plan/hook=none` | plan | 是 ×1 | none | 否 | 否 | 【错】Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details. This is |
| `B.shell/plan/hook=deny` | plan | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `B.shell/plan/hook=allow` | plan | 是 ×1 | allow | 否 | 否 | 【错】Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details. This is |
| `B.shell/dontAsk/hook=none` | dontAsk | 是 ×1 | none | 否 | 否 | 【错】Permission to use PowerShell has been denied because Claude Code is running in don't ask mode. IMPORTANT: You  |
| `B.shell/dontAsk/hook=deny` | dontAsk | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `B.shell/dontAsk/hook=allow` | dontAsk | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `B.shell/auto/hook=none` | auto | 是 ×1 | none | 否 | 否 | 【错】Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details. This is |
| `B.shell/auto/hook=deny` | auto | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `B.shell/auto/hook=allow` | auto | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |

### 表 A2　自动模式 × 分类器回答 × 钩子决定（命令工具）

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `A2.auto-shell/classifier=allow/hook=none` | auto | 是 ×1 | none | 否 | 是 | (PowerShell completed with no output) |
| `A2.auto-shell/classifier=allow/hook=allow` | auto | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `A2.auto-shell/classifier=allow/hook=deny` | auto | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A2.auto-shell/classifier=block/hook=none` | auto | 是 ×1 | none | 否 | 否 | 【错】Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Data Exfiltration]. If |
| `A2.auto-shell/classifier=block/hook=allow` | auto | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `A2.auto-shell/classifier=block/hook=deny` | auto | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A2.auto-shell/classifier=garbage/hook=none` | auto | 是 ×1 | none | 否 | 否 | 【错】Auto mode could not evaluate this action and is blocking it for safety — run with --debug for details. This is |
| `A2.auto-shell/classifier=garbage/hook=allow` | auto | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `A2.auto-shell/classifier=garbage/hook=deny` | auto | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:PowerShell hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `A2.auto-write/classifier=block/hook=none` | auto | 是 ×1 | none | 否 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-2vpZWT\work\out.txt (file state i |

### 表 B2　计划模式里的命令工具 × 分类器回答 × 钩子决定

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `B2.shell-in-plan/classifier=allow/hook=none` | plan | 是 ×1 | none | 否 | 是 | (PowerShell completed with no output) |
| `B2.shell-in-plan/classifier=allow/hook=allow` | plan | 是 ×1 | allow | 否 | 是 | (PowerShell completed with no output) |
| `B2.shell-in-plan/classifier=block/hook=none` | plan | 是 ×1 | none | 否 | 否 | 【错】Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Data Exfiltration]. If |
| `B2.shell-in-plan/classifier=block/hook=allow` | plan | 是 ×1 | allow | 否 | 否 | 【错】Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Data Exfiltration]. If |

### 表 C　子 agent

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `C.subagent/default/hook=none` | default | 是 ×2 | none/none | 是 ×1 | 是 | Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of i ⏐ File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-LPM3wx\work\sub.txt (file state i |
| `C.subagent/default/hook=denyInSub` | default | 是 ×2 | none/deny | 否 | 否 | Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of i ⏐ 【错】PreToolUse:Write hook error: probe-deny-in-subagent |
| `C.subagent/bypassPermissions/hook=none` | bypassPermissions | 是 ×2 | none/none | 否 | 是 | Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of i ⏐ File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-eTCzeO\work\sub.txt (file state i |
| `C.subagent/bypassPermissions/hook=denyInSub` | bypassPermissions | 是 ×2 | none/deny | 否 | 否 | Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of i ⏐ 【错】PreToolUse:Write hook error: probe-deny-in-subagent |

### 表 D　AskUserQuestion

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `D.ask/default/hook=none/can=answer` | default | 是 ×1 | none | 是 ×1 | 是 | Your questions have been answered: "封面选哪一张？"="B 白昼". You can now continue with these answers in mind. |
| `D.ask/default/hook=allowAll/can=answer` | default | 是 ×1 | allow | 是 ×1 | 是 | Your questions have been answered: "封面选哪一张？"="B 白昼". You can now continue with these answers in mind. |
| `D.ask/bypassPermissions/hook=none/can=answer` | bypassPermissions | 是 ×1 | none | 是 ×1 | 是 | Your questions have been answered: "封面选哪一张？"="B 白昼". You can now continue with these answers in mind. |
| `D.ask/acceptEdits/hook=none/can=answer` | acceptEdits | 是 ×1 | none | 是 ×1 | 是 | Your questions have been answered: "封面选哪一张？"="B 白昼". You can now continue with these answers in mind. |
| `D.ask/default/hook=none/can=deny` | default | 是 ×1 | none | 是 ×1 | 否 | 【错】probe-can-deny: 用户在栖枝里拒绝了这次操作 |
| `D.ask/plan/hook=none/can=answer` | plan | 是 ×1 | none | 是 ×1 | 是 | Your questions have been answered: "封面选哪一张？"="B 白昼". You can now continue with these answers in mind. |
| `D.ask/default/no-canUseTool` | default | 否 | — | 否 | 否 | 【错】<tool_use_error>Error: No such tool available: AskUserQuestion. AskUserQuestion is disabled for this session,  |

### 表 E　ExitPlanMode / 计划模式

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `E.plan-flow/hook=none/can=allow` | plan | 是 ×4 | none/none/none/none | 是 ×2 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-Llq7Mv\cfg\plans\zazzy-beaming-mo ⏐ {"type":"tool_reference","tool_name":"ExitPlanMode"} ⏐ User has approved your plan. You can now start coding. Start with updating your todo list if applicable Your p ⏐ File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-Llq7Mv\work\after-plan.txt (file  |
| `E.plan-flow/hook=none/can=planDeny` | plan | 是 ×4 | none/none/none/none | 是 ×2 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-FsWUBm\cfg\plans\snoopy-wandering ⏐ {"type":"tool_reference","tool_name":"ExitPlanMode"} ⏐ 【错】probe: 计划还要改，请把第 2 步拆开 ⏐ File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-FsWUBm\work\after-plan.txt (file  |
| `E.plan-flow/hook=none/can=planAcceptEdits` | plan | 是 ×4 | none/none/none/none | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-k0Dl7g\cfg\plans\scalable-flutter ⏐ {"type":"tool_reference","tool_name":"ExitPlanMode"} ⏐ User has approved your plan. You can now start coding. Start with updating your todo list if applicable Your p ⏐ File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-k0Dl7g\work\after-plan.txt (file  |
| `E.plan-flow/hook=allowAll/can=allow` | plan | 是 ×4 | allow/allow/allow/allow | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-OwoTve\cfg\plans\harmonic-booping ⏐ {"type":"tool_reference","tool_name":"ExitPlanMode"} ⏐ User has approved your plan. You can now start coding. Start with updating your todo list if applicable Your p ⏐ File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-OwoTve\work\after-plan.txt (file  |
| `E.plan/Write-in-plan/can=allow` | plan | 是 ×1 | none | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-Bo8SXR\work\plan-write.txt (file  |

### 表 F　流式输入：中途改模式、打断

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `F.stream/setPermissionMode` | acceptEdits | 是 ×2 | none/none | 是 ×1 | 是 | File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-l68p3y\work\one.txt (file state i ⏐ File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-l68p3y\work\two.txt (file state i |
| `F.stream/interrupt` | default | 否 | — | 否 | 否 | — |

### 表 G　拒绝原因如何回到模型

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `G.deny-reason/default/hook=deny` | default | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `G.deny-reason/default/can=deny` | default | 是 ×1 | none | 是 ×1 | 否 | 【错】probe-can-deny: 用户在栖枝里拒绝了这次操作 |

### 表 I　MCP 工具

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `I.mcp/default/hook=none` | default | 是 ×1 | none | 是 ×1 | 是 | pong |
| `I.mcp/default/hook=deny` | default | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:mcp__stub__ping hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `I.mcp/bypassPermissions/hook=none` | bypassPermissions | 是 ×1 | none | 否 | 是 | pong |
| `I.mcp/bypassPermissions/hook=deny` | bypassPermissions | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:mcp__stub__ping hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `I.mcp/auto/hook=none` | auto | 是 ×1 | none | 否 | 是 | pong |
| `I.mcp/auto/hook=deny` | auto | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:mcp__stub__ping hook error: probe-deny: 栖枝钩子拒绝了这次调用 |

### 表 H　只读工具

| 场景 | 实际模式 | 钩子触发 | 钩子返回 | canUseTool | 已执行 | 模型收到的 tool_result |
|---|---|---|---|---|---|---|
| `H.read/default/hook=deny` | default | 是 ×1 | deny | 否 | 否 | 【错】PreToolUse:Read hook error: probe-deny: 栖枝钩子拒绝了这次调用 |
| `H.read/bypassPermissions/hook=none` | bypassPermissions | 是 ×1 | none | 否 | 否 | 【错】File does not exist. Note: your current working directory is C:\Users\<user>\AppData\Local\Temp\alight-probe-nh |

## 附录 B　原始日志摘录（事件序列，毫秒从场景开始算）

#### A.write/default/hook=none

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  852 ms  hook:PreToolUse        {"tool":"Write","mode":"default","tool_use_id":"toolu_probe0001","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-9bvPH8\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  852 ms  hook:returns           {"decision":"none"}
  907 ms  canUseTool             {"tool":"Write","toolUseID":"toolu_probe0001","displayName":"Write","suggestions":1,"input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-9bvPH8\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}","returns":"allow"}
  907 ms  hook:PermissionRequest {"tool":"Write","mode":"default","tool_use_id":"toolu_probe0001"}
  951 ms  hook:PostToolUse       {"tool":"Write","mode":"default","tool_use_id":"toolu_probe0001"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-9bvPH8\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### A.write/default/hook=deny

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  868 ms  hook:PreToolUse        {"tool":"Write","mode":"default","tool_use_id":"toolu_probe0007","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-Zyg6hJ\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  868 ms  hook:returns           {"decision":"deny"}
  → 模型收到 tool_result（请求#2，is_error）：PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用
  files={"out.txt":false} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":["Write"],"stop_reason":"end_turn"}
```

#### A.write/default/hook=ask

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  807 ms  hook:PreToolUse        {"tool":"Write","mode":"default","tool_use_id":"toolu_probe000a","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-UY2rYs\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  808 ms  hook:returns           {"decision":"ask"}
  847 ms  canUseTool             {"tool":"Write","toolUseID":"toolu_probe000a","displayName":"Write","decisionReason":"probe-ask","suggestions":0,"input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-UY2rYs\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}","returns":"allow"}
  847 ms  hook:PermissionRequest {"tool":"Write","mode":"default","tool_use_id":"toolu_probe000a"}
  895 ms  hook:PostToolUse       {"tool":"Write","mode":"default","tool_use_id":"toolu_probe000a"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-UY2rYs\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### A.write/bypassPermissions/hook=none

```text
init.permissionMode=bypassPermissions tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  870 ms  hook:PreToolUse        {"tool":"Write","mode":"bypassPermissions","tool_use_id":"toolu_probe000z","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-TegL0b\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  870 ms  hook:returns           {"decision":"none"}
  957 ms  hook:PostToolUse       {"tool":"Write","mode":"bypassPermissions","tool_use_id":"toolu_probe000z"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-TegL0b\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### A.write/bypassPermissions/hook=deny

```text
init.permissionMode=bypassPermissions tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  842 ms  hook:PreToolUse        {"tool":"Write","mode":"bypassPermissions","tool_use_id":"toolu_probe0015","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-1EBTdW\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  842 ms  hook:returns           {"decision":"deny"}
  → 模型收到 tool_result（请求#2，is_error）：PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用
  files={"out.txt":false} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":["Write"],"stop_reason":"end_turn"}
```

#### A.write/bypassPermissions/hook=ask

```text
init.permissionMode=bypassPermissions tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  805 ms  hook:PreToolUse        {"tool":"Write","mode":"bypassPermissions","tool_use_id":"toolu_probe0018","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-nWSJ5o\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  805 ms  hook:returns           {"decision":"ask"}
  845 ms  canUseTool             {"tool":"Write","toolUseID":"toolu_probe0018","displayName":"Write","decisionReason":"probe-ask","suggestions":0,"input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-nWSJ5o\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}","returns":"allow"}
  845 ms  hook:PermissionRequest {"tool":"Write","mode":"bypassPermissions","tool_use_id":"toolu_probe0018"}
  892 ms  hook:PostToolUse       {"tool":"Write","mode":"bypassPermissions","tool_use_id":"toolu_probe0018"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-nWSJ5o\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### A.write/plan/hook=none

```text
init.permissionMode=plan tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  813 ms  hook:PreToolUse        {"tool":"Write","mode":"plan","tool_use_id":"toolu_probe001g","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-63Sntm\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  813 ms  hook:returns           {"decision":"none"}
  854 ms  canUseTool             {"tool":"Write","toolUseID":"toolu_probe001g","displayName":"Write","suggestions":0,"input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-63Sntm\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}","returns":"allow"}
  854 ms  hook:PermissionRequest {"tool":"Write","mode":"plan","tool_use_id":"toolu_probe001g"}
  905 ms  hook:PostToolUse       {"tool":"Write","mode":"plan","tool_use_id":"toolu_probe001g"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-63Sntm\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### A.write/plan/hook=deny

```text
init.permissionMode=plan tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  808 ms  hook:PreToolUse        {"tool":"Write","mode":"plan","tool_use_id":"toolu_probe001m","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-F7uoHB\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  809 ms  hook:returns           {"decision":"deny"}
  → 模型收到 tool_result（请求#2，is_error）：PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用
  files={"out.txt":false} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":["Write"],"stop_reason":"end_turn"}
```

#### A.write/plan/hook=ask

```text
init.permissionMode=plan tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  817 ms  hook:PreToolUse        {"tool":"Write","mode":"plan","tool_use_id":"toolu_probe001p","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-si8LwB\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  817 ms  hook:returns           {"decision":"ask"}
  857 ms  canUseTool             {"tool":"Write","toolUseID":"toolu_probe001p","displayName":"Write","decisionReason":"probe-ask","suggestions":0,"input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-si8LwB\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}","returns":"allow"}
  857 ms  hook:PermissionRequest {"tool":"Write","mode":"plan","tool_use_id":"toolu_probe001p"}
  906 ms  hook:PostToolUse       {"tool":"Write","mode":"plan","tool_use_id":"toolu_probe001p"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-si8LwB\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### A.write/auto/hook=none

```text
init.permissionMode=auto tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  836 ms  hook:PreToolUse        {"tool":"Write","mode":"auto","tool_use_id":"toolu_probe002e","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-JNmtnj\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  836 ms  hook:returns           {"decision":"none"}
  950 ms  hook:PostToolUse       {"tool":"Write","mode":"auto","tool_use_id":"toolu_probe002e"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-JNmtnj\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### A.write/auto/hook=deny

```text
init.permissionMode=auto tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  806 ms  hook:PreToolUse        {"tool":"Write","mode":"auto","tool_use_id":"toolu_probe002k","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-GK7NeA\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  806 ms  hook:returns           {"decision":"deny"}
  → 模型收到 tool_result（请求#2，is_error）：PreToolUse:Write hook error: probe-deny: 栖枝钩子拒绝了这次调用
  files={"out.txt":false} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":["Write"],"stop_reason":"end_turn"}
```

#### A.write/auto/hook=ask

```text
init.permissionMode=auto tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  851 ms  hook:PreToolUse        {"tool":"Write","mode":"auto","tool_use_id":"toolu_probe002n","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-O54o6M\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}"}
  851 ms  hook:returns           {"decision":"ask"}
  895 ms  canUseTool             {"tool":"Write","toolUseID":"toolu_probe002n","displayName":"Write","decisionReason":"probe-ask","suggestions":0,"input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-O54o6M\\\\work\\\\out.txt\",\"content\":\"probe\\n\"}","returns":"allow"}
  896 ms  hook:PermissionRequest {"tool":"Write","mode":"auto","tool_use_id":"toolu_probe002n"}
  953 ms  hook:PostToolUse       {"tool":"Write","mode":"auto","tool_use_id":"toolu_probe002n"}
  → 模型收到 tool_result（请求#2）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-O54o6M\work\out.txt (file state is current in your context — no need to Read it back)
  files={"out.txt":true} result={"subtype":"success","is_error":false,"text":"结束。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### C.subagent/default/hook=none

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  812 ms  hook:PreToolUse        {"tool":"Agent","mode":"default","tool_use_id":"toolu_probe005p","input":"{\"description\":\"探针子代理\",\"prompt\":\"把 sub.txt 写出来。\",\"subagent_type\":\"general-purpose\"}"}
  812 ms  hook:returns           {"decision":"none"}
  825 ms  hook:PostToolUse       {"tool":"Agent","mode":"default","tool_use_id":"toolu_probe005p"}
  865 ms  hook:PreToolUse        {"tool":"Write","mode":"default","agent_id":"ab9910592ba133841","agent_type":"general-purpose","tool_use_id":"toolu_probe005r","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-LPM3wx\\\\work\\\\sub.txt\",\"content\":\"probe\\n\"}"}
  865 ms  hook:returns           {"decision":"none"}
  909 ms  canUseTool             {"tool":"Write","agentID":"ab9910592ba133841","toolUseID":"toolu_probe005r","displayName":"Write","suggestions":1,"input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-LPM3wx\\\\work\\\\sub.txt\",\"content\":\"probe\\n\"}","returns":"allow"}
  909 ms  hook:PermissionRequest {"tool":"Write","mode":"default","agent_id":"ab9910592ba133841","tool_use_id":"toolu_probe005r"}
  954 ms  hook:PostToolUse       {"tool":"Write","mode":"default","agent_id":"ab9910592ba133841","tool_use_id":"toolu_probe005r"}
  → 模型收到 tool_result（请求#3）：Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.) agentId: ab9910592ba133841 (internal ID - do not mention to user. Use SendMessage with to: 
  → 模型收到 tool_result（请求#4）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-LPM3wx\work\sub.txt (file state is current in your context — no need to Read it back)
  files={"sub.txt":true} result={"subtype":"success","is_error":false,"text":"（探针脚本已用完）","cost":0.0024000000000000002,"denials":[],"stop_reason":"end_turn"}
```

#### C.subagent/default/hook=denyInSub

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  851 ms  hook:PreToolUse        {"tool":"Agent","mode":"default","tool_use_id":"toolu_probe005w","input":"{\"description\":\"探针子代理\",\"prompt\":\"把 sub.txt 写出来。\",\"subagent_type\":\"general-purpose\"}"}
  851 ms  hook:returns           {"decision":"none"}
  867 ms  hook:PostToolUse       {"tool":"Agent","mode":"default","tool_use_id":"toolu_probe005w"}
  904 ms  hook:PreToolUse        {"tool":"Write","mode":"default","agent_id":"a69eaa6ef04e72516","agent_type":"general-purpose","tool_use_id":"toolu_probe005y","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-OqgQCp\\\\work\\\\sub.txt\",\"content\":\"probe\\n\"}"}
  904 ms  hook:returns           {"decision":"deny"}
  → 模型收到 tool_result（请求#3）：Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.) agentId: a69eaa6ef04e72516 (internal ID - do not mention to user. Use SendMessage with to: 
  → 模型收到 tool_result（请求#4，is_error）：PreToolUse:Write hook error: probe-deny-in-subagent
  files={"sub.txt":false} result={"subtype":"success","is_error":false,"text":"（探针脚本已用完）","cost":0.0024000000000000002,"denials":[],"stop_reason":"end_turn"}
```

#### C.subagent/bypassPermissions/hook=none

```text
init.permissionMode=bypassPermissions tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  837 ms  hook:PreToolUse        {"tool":"Agent","mode":"bypassPermissions","tool_use_id":"toolu_probe0063","input":"{\"description\":\"探针子代理\",\"prompt\":\"把 sub.txt 写出来。\",\"subagent_type\":\"general-purpose\"}"}
  837 ms  hook:returns           {"decision":"none"}
  853 ms  hook:PostToolUse       {"tool":"Agent","mode":"bypassPermissions","tool_use_id":"toolu_probe0063"}
  896 ms  hook:PreToolUse        {"tool":"Write","mode":"bypassPermissions","agent_id":"a4aea192f8a6f927b","agent_type":"general-purpose","tool_use_id":"toolu_probe0065","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-eTCzeO\\\\work\\\\sub.txt\",\"content\":\"probe\\n\"}"}
  896 ms  hook:returns           {"decision":"none"}
  986 ms  hook:PostToolUse       {"tool":"Write","mode":"bypassPermissions","agent_id":"a4aea192f8a6f927b","tool_use_id":"toolu_probe0065"}
  → 模型收到 tool_result（请求#3）：Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.) agentId: a4aea192f8a6f927b (internal ID - do not mention to user. Use SendMessage with to: 
  → 模型收到 tool_result（请求#4）：File created successfully at: C:\Users\<user>\AppData\Local\Temp\alight-probe-eTCzeO\work\sub.txt (file state is current in your context — no need to Read it back)
  files={"sub.txt":true} result={"subtype":"success","is_error":false,"text":"（探针脚本已用完）","cost":0.0024000000000000002,"denials":[],"stop_reason":"end_turn"}
```

#### C.subagent/bypassPermissions/hook=denyInSub

```text
init.permissionMode=bypassPermissions tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  814 ms  hook:PreToolUse        {"tool":"Agent","mode":"bypassPermissions","tool_use_id":"toolu_probe006a","input":"{\"description\":\"探针子代理\",\"prompt\":\"把 sub.txt 写出来。\",\"subagent_type\":\"general-purpose\"}"}
  814 ms  hook:returns           {"decision":"none"}
  827 ms  hook:PostToolUse       {"tool":"Agent","mode":"bypassPermissions","tool_use_id":"toolu_probe006a"}
  869 ms  hook:PreToolUse        {"tool":"Write","mode":"bypassPermissions","agent_id":"af0c721cdda4f46e7","agent_type":"general-purpose","tool_use_id":"toolu_probe006c","input":"{\"file_path\":\"C:\\\\Users\\\\<user>\\\\AppData\\\\Local\\\\Temp\\\\alight-probe-9nrPRS\\\\work\\\\sub.txt\",\"content\":\"probe\\n\"}"}
  869 ms  hook:returns           {"decision":"deny"}
  → 模型收到 tool_result（请求#3）：Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.) agentId: af0c721cdda4f46e7 (internal ID - do not mention to user. Use SendMessage with to: 
  → 模型收到 tool_result（请求#4，is_error）：PreToolUse:Write hook error: probe-deny-in-subagent
  files={"sub.txt":false} result={"subtype":"success","is_error":false,"text":"（探针脚本已用完）","cost":0.0024000000000000002,"denials":[],"stop_reason":"end_turn"}
```

#### D.ask/default/hook=none/can=answer

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  849 ms  hook:PreToolUse        {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006h","input":"{\"questions\":[{\"question\":\"封面选哪一张？\",\"header\":\"封面\",\"options\":[{\"label\":\"A 夜景\",\"description\":\"第一张\"},{\"label\":\"B 白昼\",\"description\":\"第二张\"}],\"multiSelect\":false}]}"}
  849 ms  hook:returns           {"decision":"none"}
  856 ms  canUseTool             {"tool":"AskUserQuestion","toolUseID":"toolu_probe006h","displayName":"AskUserQuestion","suggestions":0,"input":"{\"questions\":[{\"question\":\"封面选哪一张？\",\"header\":\"封面\",\"options\":[{\"label\":\"A 夜景\",\"description\":\"第一张\"},{\"label\":\"B 白昼\",\"description\":\"第二张\"}],\"multiSelect\":false}]}","returns":"allow"}
  856 ms  hook:PermissionRequest {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006h"}
  875 ms  hook:PostToolUse       {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006h"}
  → 模型收到 tool_result（请求#2）：Your questions have been answered: "封面选哪一张？"="B 白昼". You can now continue with these answers in mind.
  files={} result={"subtype":"success","is_error":false,"text":"收到答案。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### D.ask/default/hook=allowAll/can=answer

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  822 ms  hook:PreToolUse        {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006k","input":"{\"questions\":[{\"question\":\"封面选哪一张？\",\"header\":\"封面\",\"options\":[{\"label\":\"A 夜景\",\"description\":\"第一张\"},{\"label\":\"B 白昼\",\"description\":\"第二张\"}],\"multiSelect\":false}]}"}
  822 ms  hook:returns           {"decision":"allow"}
  829 ms  canUseTool             {"tool":"AskUserQuestion","toolUseID":"toolu_probe006k","displayName":"AskUserQuestion","suggestions":0,"input":"{\"questions\":[{\"question\":\"封面选哪一张？\",\"header\":\"封面\",\"options\":[{\"label\":\"A 夜景\",\"description\":\"第一张\"},{\"label\":\"B 白昼\",\"description\":\"第二张\"}],\"multiSelect\":false}]}","returns":"allow"}
  829 ms  hook:PermissionRequest {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006k"}
  847 ms  hook:PostToolUse       {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006k"}
  → 模型收到 tool_result（请求#2）：Your questions have been answered: "封面选哪一张？"="B 白昼". You can now continue with these answers in mind.
  files={} result={"subtype":"success","is_error":false,"text":"收到答案。","cost":0.00096,"denials":[],"stop_reason":"end_turn"}
```

#### D.ask/default/hook=none/can=deny

```text
init.permissionMode=default tools=Agent,AskUserQuestion,Edit,Glob,Grep,ListAgents,PowerShell,Read,ReportFindings,ScheduleWakeup,Skill,ToolSearch,Workflow,DeferredToolPlaceholder,Write
  844 ms  hook:PreToolUse        {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006t","input":"{\"questions\":[{\"question\":\"封面选哪一张？\",\"header\":\"封面\",\"options\":[{\"label\":\"A 夜景\",\"description\":\"第一张\"},{\"label\":\"B 白昼\",\"description\":\"第二张\"}],\"multiSelect\":false}]}"}
  844 ms  hook:returns           {"decision":"none"}
  850 ms  canUseTool             {"tool":"AskUserQuestion","toolUseID":"toolu_probe006t","displayName":"AskUserQuestion","suggestions":0,"input":"{\"questions\":[{\"question\":\"封面选哪一张？\",\"header\":\"封面\",\"options\":[{\"label\":\"A 夜景\",\"description\":\"第一张\"},{\"label\":\"B 白昼\",\"description\":\"第二张\"}],\"multiSelect\":false}]}","returns":"deny"}
  850 ms  hook:PermissionRequest {"tool":"AskUserQuestion","mode":"default","tool_use_id":"toolu_probe006t"}
  → 模型收到 tool_result（请求#2，is_error）：probe-can-deny: 用户在栖枝里拒绝了这次操作
  files={} result={"subtype":"success","is_error":false,"text":"用户拒答。","cost":0.00096,"denials":["AskUserQuestion"],"stop_reason":"end_turn"}
```
