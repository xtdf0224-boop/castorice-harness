# 输入法用例（X02）

> 范围：键盘输入的所有可编辑控件。本机启用了简体中文输入法（`0804`），进程名判断是微软拼音。
> 用例来源：`research/08-补充-3-roadmap-vs-daily-pain.md` §5.2（IME-1…10）。IME-11…13 属于 V1a 功能（空回车＝收下、对照台、河道改名），V0α 不实现，到时按同样办法补。
> 自动化脚本：`node scripts/probe/run.mjs ime [--app-dir <目录>] [--only IME-1,IME-3] --json <文件>`（无头，不弹窗，不花额度；模型走本机假服务）。

## 1. 结论

- **通路可用**：Chrome DevTools Protocol 的 `Input.imeSetComposition` 与 `Input.insertText` 在 Electron 45（Chromium 156）的隐藏窗口里能驱动 Chromium 自己的输入法控制器，页面收到的事件次序、`isComposing`、`keyCode` 与真输入法的实测形态一致（见 §2）。所以 IME-1…7、9、10 的主体可以自动跑，每次提交前一条命令就能回归。
- **做不到自动化的**：候选窗位置（IME-8）、真实输入法的词库/云候选/中英切换等怪癖、以及需要一张真实「待批准卡」的 IME-5 正向用例。这些列在 §5 的人工清单里，发版前人工过一遍（约 10 分钟）。
- **萤火 v2.0.0 基线实测（2026-10-24，全套约 95 秒）**：IME-2、5、6、7、9、10 **通过**；IME-1 的 A、B 通过，防御性变体 C 提醒；IME-8 纯人工（只做了前置检查）；**IME-3、IME-4 失败**——设置页「称呼」框与模型 ID 框对「输入法放行了回车/Esc 本身」的情形（形态 B）没有守卫：拼音字母被当成最终值存下（`callName` 由「开拓者」变成 `nib`），模型 ID 的行内编辑被关掉。这正是 B4 要修的缺口（施工图 B4：IME 守卫）。
- **栖枝 V0α 集成实测（2026-10-24，集成者，`dist/` 最终构建）**：IME-1、2、3、4、5、6、7、9、10 **全部通过**（IME-3、IME-4 的修复生效：称呼框与模型 ID 框对形态 A/B/C 都不提交、Esc 只取消组合，没有组合时 Esc 仍能放弃行内编辑）；IME-8 纯人工。IME-10 在「闲聊」模式下 5 路并发流式：84 个样本 P50 1.5 ms、P95 1.9 ms、P99 2.3 ms。两处探针的调整：①栖枝首页输入框默认「工作」（发出去的是制定计划的提示词），`ime` 发送前先切到「闲聊」，否则 IME-2 的「发出去的文字」是整段计划提示词、IME-10 在隐藏窗口里会偶发约 1 s 的合成器 `Commit` 尖峰（窗口隐藏的假象，见 `docs/BASELINE.md` §8.2）；②IME-2 的「任务历史」检查读 localStorage，栖枝的任务在 SQLite 里，这一项退化为人工（信息级）。

## 2. 通路验证：`imeSetComposition` 等价于真输入法吗

在萤火基线的主输入框里，页面事件记录器（捕获阶段挂在 `window` 上）实测到：

| 步骤 | CDP 调用 | 页面收到的事件 |
|---|---|---|
| ① 开始组合 | `Input.imeSetComposition {text:'ni'}` | `compositionstart` → `compositionupdate('ni')` → `beforeinput(insertCompositionText, isComposing)` → `input(value='ni', isComposing=true)` |
| ② 组合中按回车 | `Input.dispatchKeyEvent {type:'rawKeyDown', key:'Process', code:'Enter', windowsVirtualKeyCode:229}` | `keydown {key:'Process', code:'Enter', keyCode:229, isComposing:true}` |
| ③ 选字提交 | `Input.insertText {text:'你'}` | `compositionupdate('你')` → `beforeinput` → `input(value='你')` → `compositionend('你')` |
| ④ 回车抬起 | `Input.dispatchKeyEvent {type:'keyUp', key:'Enter'}` | `keyup {key:'Enter', keyCode:13, isComposing:false}` |
| ⑤ 再按回车 | `pressKey('Enter')`（`keyDown` 带 `text:'\r'`） | `keydown {Enter, 13, isComposing:false}` → 应用发送，恰好一次 |

这与 MDN 对 `keydown` 的描述一致：Chromium 的次序是「keydown（`isComposing=true`、`keyCode=229`）→ `compositionend` → keyup」。没有单独的 `imeCommitComposition`，**提交就是 `Input.insertText`**。

**限制**：这是 Blink 一侧的行为。没有真实的 TSF（Windows 文本服务框架）参与，所以看不到候选窗、词库、Shift 切换中英文、云候选这些系统层行为。

## 3. 三种「按键形态」（A/B/C）

「组合态下的 Enter / Esc」在线上可能以三种形态到达页面；守卫要同时挡住它们。脚本用 `ime.key(s, 'Enter'|'Escape', 'A'|'B'|'C')` 逐一模拟：

| 形态 | 页面看到的 keydown | 出现的场合 | 失败后果 | 判定档 |
|---|---|---|---|---|
| **A** | `key="Process"`、`keyCode=229`、`isComposing=true` | Chromium＋Windows TSF 的实测形态（微软拼音） | 应用若按 `e.key==='Enter'` 判断，天然不触发；但守卫仍不应依赖这点 | 必须通过 |
| **B** | `key="Enter"/"Escape"`、`keyCode=13/27`、`isComposing=true` | 输入法把键本身放行（部分第三方输入法、特定组合） | 只查 `key` 的处理器会把组合态回车当成提交 | **必须通过** |
| **C** | `key="Enter"/"Escape"`、`keyCode=229`、`isComposing=false` | `compositionend` 先于 `keydown`（MDN 说明会发生；Safari/Firefox 常见） | 只查 `isComposing` 的守卫会漏掉 | 防御性（提醒，不算失败） |

判定三档：**失败**＝必须修；**提醒**＝防御性用例；**通过**。退出码只在有「失败」或「出错」时非零。

## 4. 用例清单

「自动化」列＝脚本覆盖的部分。「萤火基线」＝2026-10-24 在萤火 v2.0.0（`8c4000c`，worktree）上的实测。「V0α 期望」＝栖枝集成后应有的结果。

| ID | 用例 | 预期 | 自动化 | 萤火基线（实测） | V0α 期望 |
|---|---|---|---|---|---|
| IME-1 | 主输入框：组合态按回车选字 | 选字，**不发送**；组合文字留在框里；回车没被应用当成自己的 Enter（`defaultPrevented` 为假） | A、B 自动；C 防御性 | A、B **通过**；C **提醒**（`keyCode=229` 的回车触发了发送，只查了 `isComposing`） | 全部通过（B4 的 `lib/ime.ts` 同时查 `isComposing` 与 `keyCode===229`） |
| IME-2 | 主输入框：选字后再按回车 | 恰好发送一次，不重复；发出去的是选好的字不是拼音；任务历史里只有一条用户消息 | 自动（假服务数请求、读落盘的任务历史） | **通过** | 通过 |
| IME-3 | 单行输入框回车即提交：设置页「称呼」、模型 ID 框 | 组合态回车**不提交** | A/B/C 自动（称呼：看落盘的 `callName`；模型 ID：看输入框是否被关掉） | A **通过**；**B 失败**（称呼框把 `nib` 存成了最终值；模型 ID 框被 `finish(true)` 关掉）；C **提醒** | 全部通过 |
| IME-4 | Esc 在组合态 | 只取消组合，**不关闭**行内编辑；没有组合时 Esc 仍能放弃（对照） | A、B 自动＋无组合对照 | A、对照**通过**；**B 失败**（Esc 直接放弃了行内编辑） | 全部通过，且对照仍通过（守卫别写成永远吞 Esc） |
| IME-5 | 单键快捷操作（Enter＝一键收束、Y/N、数字、空格） | 焦点在可编辑控件时一律禁用；组合态不触发 | 负向自动（输入框里敲 `y n a x 1 2 3 空格`、组合态敲 `y n 1 2`，看有没有被拦截）；正向（焦点在批准卡上才触发）**人工**，待 V0α 集成后用假服务 `tool_use` 补一条自动用例 | 负向**通过** | 通过 |
| IME-6 | 流式输出重渲染中打拼音 | 预编辑文字不丢、不重复、组合不被打断（无多余 `compositionend`），提交后恰好是选好的字 | 自动（假服务 50 事件/秒的长回复，边流边组合 5 步） | **通过** | 通过（Conversation 改成虚拟化后复测） |
| IME-7 | 草稿自动保存与外部写入 | 组合期间不把拼音写进草稿；重启后文本正确 | 自动：拦截 `localStorage.setItem`，组合 2.3 秒内无草稿写入；重启后读输入框（有草稿功能时应恢复）。外部写入（点技能标签插入文字、粘贴）**人工** | **通过**（该版本没有草稿持久化，重启后为空） | 通过；若 B2/B4 加了草稿，重启后应恢复 |
| IME-8 | 候选窗位置 | 候选窗贴着光标；多行自动增高、125%/150% 缩放、玻璃与粒子层开着时都对 | **人工**（需要真输入法）。自动只做前置检查：输入框在视口内、祖先没有 CSS `zoom`/缩放变换 | 前置检查通过 | 人工清单（§5） |
| IME-9 | `maxLength` 与组合态 | 上限附近组合，不丢字、不错位截断 | 自动：称呼框（`maxLength=20`）18 字 + 组合 `nihao` → 提交「你好吗」，应正好截成 20 字（前 18 字 + 「你好」）；真实输入法的候选行为人工确认 | **通过** | 通过 |
| IME-10 | 重负载下组合态延迟（S4） | 5 个会话同时流式输出（每路约 50 事件/秒）时，组合 / 按键 / 提交的 CDP 往返 P95 ≤100 ms、P99 ≤200 ms | 自动（84 个样本）；真输入法的主观手感人工。注意这是「主线程忙不忙」的度量，萤火流式渲染走 70/120 ms 的节流定时器，负载本来就轻 | **通过**：84 个样本，P50 1.6 ms、P95 2.5 ms、P99 3.3 ms | 通过 |

**S4 的口径**：CDP 的 `Input.*` 调用在渲染进程处理完事件后才应答，所以往返时间＝输入排队延迟＋事件处理耗时，**不含出帧**——隐藏窗口不出帧（见 `docs/BASELINE.md` §3.1），而 `PerformanceEventTiming` 要等呈现，在隐藏窗口里取不到。这是「主线程忙不忙」的度量，不是端到端的「按键到像素」。

## 5. 人工清单（发版前过一遍，约 10 分钟；用真实微软拼音）

每条都用真键盘，窗口真实显示。

1. **IME-8 候选窗位置**：在 100%、125%、150% 缩放下，分别在①首页输入框（单行）②输入框自动增高到 8 行后的末行③任务页底部输入框打字，候选窗应紧贴光标下方；窗口靠近屏幕底边时应翻到光标上方。玻璃（`backdrop-filter`）与粒子/落雪层开着、关着各看一遍。
2. **IME-1/3 真实回车**：输入 `nihao` 不选字，直接按回车（把拼音字母原样上屏）——输入框里应出现 `nihao`，**不发送**、不提交设置。再对设置页「称呼」框、模型 ID 框各做一次。
3. **IME-4 真实 Esc**：在模型 ID 框里输入拼音后按 Esc——只取消拼音；再按一次 Esc 才放弃编辑。
4. **IME-5 正向**：出现批准卡后，焦点在卡片本身时 Enter/Y/N/数字生效；点进输入框打字（含拼音）后这些键都不触发。
5. **IME-7 外部写入**：拼音按住不提交（别选字），点技能标签或粘贴——不丢字、不重复、不出现重复的拼音。
6. **IME-9 上限附近**：称呼框里已有 18 个字，输入 `nihao` 选「你好吗」——结果应是 18 字 + 「你好」，没有错位。
7. **IME-10 手感**：同时开着 5 个会话在流式输出，在其中一个里连续打两三句话，候选窗跟手，没有字母漏进输入框。
8. **多输入法冷启动**：切到微软拼音以外的输入法（如果装了搜狗/微信输入法）重复第 2 条——它们对回车的处理不同（形态 B 就来自这类输入法）。

## 6. 怎么跑、怎么读

```powershell
# 对当前栖枝（先由集成者 vite build 出 dist/）
node scripts/probe/run.mjs ime --json out/ime-alight.json
# 只跑某几条
node scripts/probe/run.mjs ime --only IME-3,IME-4
# 对萤火基线（先 node scripts/probe/run.mjs ffbase 建好基线应用，会打印目录）
node scripts/probe/run.mjs ime --app-dir <ffbase 打印的目录> --json out/ime-ff.json
```

输出每条用例的检查点：`✓` 通过、`✗` 必须修、`△` 提醒（防御性）、`·` 仅信息。失败时附带证据（`defaultPrevented`、落盘前后的值、输入框是否还在）。`--json` 写完整结果。

**新增单行输入框或带回车/Esc 处理的控件时**：在 `scripts/probe/cmd/ime.mjs` 里照 IME-3/IME-4 加一条（`ime.key(s, 'Enter'|'Escape', 'A'|'B'|'C')` 三种形态都要覆盖）。

## 7. 已知局限

- 没有真实 TSF：看不到候选窗、词库行为、Shift 中英切换、云候选；形态 A 是依据 MDN 与 Chromium 行为的模拟，与微软拼音逐键比对仍需人工（§5）。
- IME-3 的「称呼」判定依赖偏好落在 `localStorage`（读 `<key>/prefs` 里的 `settings.callName`）；如果 B2 把偏好迁到别处，该判定会退化为只看 `keydown.defaultPrevented`。
- IME-2 的重复消息检查依赖旧存储格式（`localStorage` 里的任务历史）；迁到 SQLite 后改为只数假服务收到的请求次数。
- 设置页「称呼」与模型 ID 框是靠 `aria-label` 找的（`称呼`、`模型 ID`）；改了界面文案要同步更新脚本顶部的两个选择器。
- **多服务接入之后（2026-10-24）**：①栖枝的模型下拉自带搜索框，输入的文字可以直接当模型 ID 用，它就是「模型 ID 框」（`.mselect-pop__search input`）：IME-3/IME-4 现在测它（组合态回车不选中「用「xxx」作为模型 ID」，组合态 Esc 不关菜单；没有组合时 Esc 先清搜索词、再按一次才关）。②模型服务的地址在桌面端的服务表里，页面写的地址不再被读，所以 `ime` 把本机假服务登记成自定义服务（`lib/seed.mjs` 的 `fakeServiceFiles`，经 `prepareProfile` 的 `userFiles` 在第一次启动前写进 userData/services.json，偏好里默认引擎指向它）。
- 隐藏窗口里页面定时器会被拉长到 40–100 ms，脚本为此轮询等待 `defaultPrevented` 回填。
