# 栖枝桌宠 · 施工图（0.3.0-beta.1）

本文是实现约定：分工、接口、行为、检查。

**底子**：萤火桌宠（[xtdf0224-boop/firefly-harness](https://github.com/xtdf0224-boop/firefly-harness)，只读参考）。它的设计文档 `docs/PET.md` 写得很细，下面凡写「照萤火 §x」的，就是照那一节做，只改这里列出的差异。萤火的代码可以整文件复制过来再改。

## 0. 硬约束（任何一条都不能破）

1. **她的台词**：不挽留，不制造依赖或愧疚（桌宠常驻、陪玩时尤其注意，用户要走就让走）；不剧透 3.x 后段（红层词表见 `../design/chat/R-voice-bible.md` §2.6）；不用「！」「～」，不写动作旁白「（……）」。模型写出来的话一律过 `src/pet/tidy.ts` 的清洗再显示或朗读。台词规则全文：`docs/AGENT-VOICE-PLAN.md` §3.10 与声线圣经 §1。
2. **她的声音**：不克隆声优。只用 ElevenLabs 里用户自己设计的音色（宣传片那个，填 voice ID）、MiniMax 音色设计，或者微软在线朗读（**不是她的声音**，只作可选的备用，默认关）。
3. **她的形象**：桌宠用我做的 Q 版分层木偶（用户 10-31 同意桌宠这一处不限官方图）；头冠不能被裁；显示尺寸（设备像素）不超过源图像素。
4. **看屏隐私**：默认关，用户打开才看；只抓前台、在游戏名单里（或用户标过「当作游戏」）的窗口；一键暂停；不注入、不读内存、不模拟键鼠。反作弊游戏她自己藏起来（照萤火 §4）。
5. **默认全关**：桌宠、看屏、朗读、实时陪玩，新装都是关的。
6. **对游戏的影响**：桌宠画在应用当前的显卡上（默认集显）；待机 ≤30 帧，被完全挡住或藏起来时不画；看屏 1–2 帧/秒、只在本机分析。
7. **用户数据**：不动 `%APPDATA%/alight-desk`（用户正在用的栖枝数据）；任何要跑 Electron 的检查都用临时的 `--user-data-dir`。

## 1. 分工（文件归属）

三个子代理并行，**只改自己名下的文件**；要动别人的文件，在交付说明里写清楚要改什么，由主会话合并。`src/pet/contracts.ts`（接口）和 `package.json` 归主会话。

| 归属 | 文件 |
|---|---|
| **M 主进程** | `electron/pet/**`（新建，整套从萤火移植）、`electron/main.cjs`（接线）、`electron/preload.cjs`（`alightDesktop.pet`）、`electron/ai/{index,services,api}.cjs`（图片消息、桌宠用的短超时）、`scripts/pet-check.ts` |
| **B 大脑与设置** | `src/pet/{brain,prompts,route,triggers,tidy,engines}.ts`、`src/pet/games/*.ts`（小游戏的纯逻辑和台词）、`src/lib/types.ts`（只加桌宠的类型）、`src/lib/desktop.ts`（StartSpec 的图片消息、`pet` 桥的类型）、`src/lib/persona.ts`（只加桌宠的提示词块）、`src/lib/terms.ts`、`src/lib/voice-lines.json`（新场景 `pet.*`）、`src/state/{persist,seed,actions,models,live}.ts`（只加桌宠的部分）、`src/components/views/settings/PetSection.tsx`（新建）与 `SettingsView.tsx` 的一行插入、`src/main.tsx`（启动大脑的一行）、`scripts/pet-brain-check.ts`、`scripts/check-voice.ts`（如要认新场景）、`scripts/gen-legal.ts` |
| **U 桌宠窗口** | `pet.html`、`capture.html`（新建）、`src/pet/ui/**`（除 `rig/`）、`src/pet/capture/**`、`src/styles/pet.css`、`vite.config.ts`、`scripts/check-build.mjs`、`scripts/security-csp.ts`（如 CSP 要加东西） |
| **主会话** | `src/pet/contracts.ts`、`src/pet/ui/rig/**`（分层木偶运行时，见 §7）、`public/pet/**`（她的图层）、`package.json`、版本号、集成和实测 |

## 2. 接口

以 `src/pet/contracts.ts` 为准。和萤火的差别：

- 全局名：页面 `window.alightDesktop.pet`、桌宠窗口 `window.alightPet`、采集页 `window.alightCapture`；采集会话分区 `alight-capture`；临时目录 `%TEMP%\alight-pet`。
- `PetRuntimeConfig.mode` 换成 `theme`（夜 / 昼，只影响聊天框和气泡），新增 `follow`（眼睛跟鼠标）、`fpsCap`。
- `PetMood` 多了 `shy`、`surprised`（对应她的官方表情 害羞、惊讶）。
- 小游戏：`PetEvent { type:'game' }`、`PetWindowBridge.game / gameSay / tales / onGame`、`PetBridge.gameState / saveTale`、`PetUiCommand { type:'game' }`。
- 光标：`PetUiCommand { type:'look', dx, dy }`，主进程在 `follow` 开着、她可见时以 ≤20 Hz 发（光标不动就不发）。

### 2.1 通道

照萤火 §3、§9 的通道表，前缀不变（`pet:*` 主页面 ⇄ 主进程，`pet-ui:*` 桌宠窗口 ⇄ 主进程，`pet-capture:*` 采集页 ⇄ 主进程）。新增：

| 通道 | 方向 | 载荷 |
|---|---|---|
| `pet:game-state` | 主页面 → 主进程（send） | `PetGameState`，原样转给桌宠窗口 `pet-ui:game` |
| `pet:tale:save` | 主页面 → 主进程（invoke） | `{ words, title, text }` → `{ ok, tale }`；存 `userData/pet-tales.json`（最多 100 篇） |
| `pet-ui:game` | 桌宠窗口 → 主进程 | `{ op, kind }` → 转给大脑 `PetEvent { type:'game' }` |
| `pet-ui:game-say` | 桌宠窗口 → 主进程 | `{ text, mood?, card? }`：清洗后当普通台词处理（进聊天记录，`kind: 'card'` 时带 `card`；气泡；`voice.enabled` 时朗读） |
| `pet-ui:tales` | 桌宠窗口 → 主进程（invoke） | → `PetTale[]`，新的在前 |
| `pet-ui:game` | 主进程 → 桌宠窗口 | `PetGameState` |

发送方检查：主进程用**窗口身份**认人（萤火 `appSenderCheck`：`e.sender === win.webContents`、`e.senderFrame === wc.mainFrame`，再核对页面地址）。栖枝现在的 `fromApp` 只比 URL，M 把它换成身份检查，`ai/index.cjs` 也用同一个。

## 3. 设置（`Settings.pet: PetSettings`，B）

```ts
interface PetSettings {
  enabled: boolean;                 // 显示桌宠（默认 false）
  scale: number;                    // 0.6–1.6，默认 1
  watch: boolean;                   // 看游戏画面（默认 false）
  proactivity: 'off' | 'low' | 'normal' | 'high';   // 默认 normal（偶尔）
  cooldownSec: number;              // 默认 120，下限 60（照萤火 §2）
  imagesPerHour: number;            // 默认 20
  vision?: AgentEngine;             // 看图 / 实时用的 API 模型；空 = 自动挑已接入、能看图的
  web?: AgentEngine;                // 联网答疑的命令行模型；空 = 已登录的 Claude Code
  voice: { enabled: boolean; provider: TtsProvider; voiceId: string; volume: number; fallback: boolean; models: { elevenlabs: string; minimax: string } };
                                    // 默认 enabled false、elevenlabs、voiceId ''、80、fallback false
  realtime: { listen: 'auto' | 'key'; sensitivity: number; fastVoice: boolean; autoOffMin: number };   // key、50、true、10
  hotkeyAsk: string;                // 默认 'Ctrl+Alt+B'（不和萤火的 Ctrl+Alt+F 撞）
  hotkeyPause: string;              // 默认 'Ctrl+Alt+H'
  neverWatch: string[]; gameAllow: string[]; gameDeny: string[];
  follow: boolean;                  // 默认 true
  fpsCap: 30 | 60;                  // 默认 60
}
```

- `SETTINGS_REV` 5 → 6。旧存档没有 `pet` 块，补默认值即可（没有要改的旧值）。`pickSettings` 里新写 `pickPet` 逐字段校验，萤火导入的旧存档（`LEGACY_PREFS_KEY`）里如果带着萤火的 `pet` 块，**丢掉不要**（键位、名单、声音都是萤火的）。
- 设置页：在「信任」前加一个 `<Panel label="桌宠">`（照萤火 `PetSettings.tsx` 的项，去掉萨姆 / 流萤相关，文案写她）。「看图 / 实时用的模型」下拉只列已接入、API 方式、`caps.vision` 为真的模型；一个都没有时写明「还没有能看图的 API 模型，实时陪玩会不看画面；可以去『模型接入』接一个」。声音一栏写清「填你在 ElevenLabs 设计的她的音色 ID；不要用克隆声优的音色」，备用的微软朗读要写明「不是她的声音」。

## 4. 大脑（B，跑在主页面）

照萤火 §5、§7「想」、§9「大脑」，差异：

- **人设**：系统提示用她的（`persona.ts` 加一个 `PET_SYSTEM` 块：桌宠场景、陪玩、简短；沿用声线圣经 §6.3 CHAT_SYSTEM 的规则与 `THEME_BLOCK` / `LEVEL_BLOCK`，话量跟设置里的 `level`）。称呼用设置里的 `callName`。
- **清洗**（`src/pet/tidy.ts`，所有模型输出的出口）：把「！」换成「。」、去掉「～」和动作旁白、去链接（照萤火 tidy）；命中挽留词表、依赖词表（声线圣经 §1 的 lint 正则）或剧透红层词表的句子整句丢掉，丢光了就换成台词库里的兜底句。`scripts/pet-brain-check.ts` 要测这些。
- **台词库**：新场景 `pet.*` 进 `voice-lines.json`（每条带表情，符合 §1 底线和话量配额），至少：`pet.hello`（打开桌宠）、`pet.game.start`（进游戏）、`pet.game.end`（离开游戏，不挽留）、`pet.cut`（过场后）、`pet.stuck`、`pet.text`（大段剧情文字）、`pet.win`、`pet.late`（很晚，只说一次）、`pet.click`、`pet.dodge`（剧透绕开）、`pet.err.*`（没模型、模型出错、联网失败、语音失败）、小游戏的台词（见 §5）。设计稿里的示例句可以直接用。模型出错或没接模型时从这里挑。
- **模型调用**：
  - 看图问答 / 主动搭话：`openStream` 的 API 方式，`messages[].content` 里放图片（见 §6）；引擎 = 设置的 `vision`，空则自动挑（已接入、API、`caps.vision`、按便宜和快排序）。没有能看图的 API 模型时：问答退到用户的默认对话引擎（Claude 订阅等命令行方式）且不带图，告诉模型这次没有画面。
  - 联网答疑：Claude Code，`access: 'work'` + `readOnly` + `allow: ['WebSearch','WebFetch']`，权限请求一律拒绝（照萤火 §5、§9）；工作目录用 `workspaceFolder('pet')`，并处理信任账本（见 M 的 §6）。
  - 实时陪玩：只用 API 方式（命令行启动太慢）；没有 API 模型时实时陪玩照样能开，回答走不看图的最快的 API 模型，一个 API 模型都没有就说明原因、不开。
- **小游戏**（`src/pet/games/*.ts` 纯逻辑，B 写；界面 U 写）：
  - `tarot.ts`：可抽的命途（用 `public/art/her/path-*.webp` 已有的四个官方图标：remembrance、erudition、hunt、preservation，再按需加）、每个命途 4–6 句「今天的小提示」（她的口吻，不算命、不说坏话、不涉剧情），`drawTarot(rng)` 返回 `{ card, line }`。
  - `butterfly.ts`：引蝶的计分与结束台词（按停下的只数分档）。
  - `chain.ts`：词语接龙规则：两个以上汉字、首字接上一个词的末字（同音不算）、不能重复；`checkWord`、`lastChar`；大脑在接龙模式下让模型「只回一个以某字开头的词」并用同一规则校验，接不上（或模型两次给错）就认输，台词「唔……接不上了。这一局是{n}的。」。
  - `tale.ts`：三个词 → 提示词（她的口吻、150 字以内、标题、不涉剧情、不写死亡和伤痛的细节）→ 结果进聊天记录（`kind: 'tale'`），用户点「存下」调 `saveTale`。
  - 小游戏进行中不主动搭话。
- **事件 → 心情**：她的样子由大脑发 `PetMood`（`think` 想、`watch` 看屏、`talk` 说、`happy` 赢了 / 被夸、`shy` 被点 / 被夸、`surprised` 过场突然切、`sleep` 很久没动静）。木偶自己按心情摆参数。

## 5. 桌宠窗口（U）

照萤火 §8–§10 的窗口、聊天框、气泡、拖动、右键菜单、悬停按钮，差异：

- **她**：用主会话的 `src/pet/ui/rig/` 画（接口见 §7），不再有 `Sprite` / `Puppet`。没有 WebGL2 或木偶出错时，退到一张静态母版图（`public/pet/rig/fallback.png`），照样能聊天。
- **尺寸**：她（连树枝）在 `scale` 1 时约 300 页面像素高、240 宽；窗口为她留出 340×360（两边给发尾、蝴蝶留空），头顶再留 230 给聊天框，即 340×590，乘 `scale`。聊天框打开时窗口不变大小（照萤火 §10「窗口」的不闪做法）。
- **主题**：`<html data-theme="night|day">`，颜色取主应用的令牌（夜：`--her-bg rgba(32,25,56,.86)`、`--me-bg #7c4ca3→#5a2f84`；昼：`--her-bg #fffefb`、`--her-line #ddd3ee`、`--me-bg #6f4a93→#58377d`），名字「遐蝶」用衬线体。看设计稿 `设计稿.html` 的聊天框。
- **悬停按钮**：鼠标移到她身上，旁边出现「聊天」「小游戏」「实时」「暂停看屏」（实时只在能用时出现）。
- **小游戏界面**：
  - 命途占卜：聊天框位置弹出三张背面朝上的牌（深紫底、细金线的荆棘与蝶纹，代码画），点一张翻开（翻牌 300 ms），正面是官方命途图标；同时调 `gameSay({ text, mood, card })`。
  - 引蝶：她身边一块 420×300 的区域里飞出 5–9 只光蝶（代码画：两片翅膀按正弦扇动、发光），鼠标停住 0.6 秒不动，附近的蝴蝶会落到光标上；30 秒倒计时，结束时 `gameSay` 结束台词。只在这块区域里，不盖全屏。
  - 接龙：聊天框标题下显示「接龙中 · 轮到你，接『棠』」（来自 `onGame`），右上角「不玩了」。
  - 童话：`kind: 'tale'` 的消息画成信笺（米白纸、衬线体），下面「存下」按钮；聊天框菜单里「我们写过的童话」列出 `tales()`。
- **减少动态效果**：系统开了就只留眨眼、嘴型、很轻的呼吸，小游戏照样能玩。

## 6. 主进程（M）

照萤火 `electron/pet/*.cjs` 整套移植，差异：

- 名字：见 §2；`window-state.json` 由主进程和 `pet/window.cjs` 共用会互相覆盖——桌宠的位置改存 `userData/pet-state.json`。
- `main.cjs`：`pet.beforeReady()`（萤火关掉 `CalculateNativeWinOcclusion`；探针模式 `ALIGHT_PROBE=1` 时不关，也不建桌宠窗口，免得改变探针基线）；托盘加「显示 / 隐藏桌宠」「桌宠设置…」（`DesktopCommand` 加 `pet-toggle`、`pet-settings`，页面那边由 B 在 `state/shell.ts` 处理——这一处 B 来改）；主页面崩溃时一分钟内最多重载 3 次（大脑在里面）；`before-quit` 调 `pet.stopAll()`；窗口关闭时如果不缩到托盘就退出应用（桌宠窗口会让 `window-all-closed` 不再触发）。
- 发送方检查改成窗口身份（§2.1）。
- **图片消息**（`ai/services.cjs` 的 `cleanMessages`、`ai/api.cjs` 的两种请求体）：`content` 可以是字符串，也可以是 `ContentPart[]`：`{ type:'text', text }` / `{ type:'image', mime:'image/jpeg'|'image/png', data }`（base64，单张 ≤ 4 MB，一条消息最多 2 张）。OpenAI 兼容转 `image_url` 的 data URL，Anthropic 转 base64 图片块（图在前）。不认识的形状拒绝。
- **桌宠的快速通道**：`StartSpec` 加 `pet?: true`：首字节超时 12 s、空闲 20 s、不重试、`maxTokens` 由页面给（≤600）。
- **联网答疑的工作目录**：`workspaceFolder('pet')` 在信任账本里按 T1 处理（它是应用自己建的空目录），或者给 `pet` 规格单开一条：只读、不弹「目录未信任」。挑一种，写进交付说明。
- 托盘、通知文案写栖枝 / 她。语音合成、实时听写、断句照萤火 §6、§7；密钥存 `userData/tts-keys.json`（系统加密）。
- `pet-tales.json` 的读写（§2.1）。
- **光标**：`follow` 开、她可见、不在游戏前台时，`screen.getCursorScreenPoint()` 每 50 ms 读一次，变了才发 `look`（相对她头部中心，物理像素）。

## 7. 分层木偶（主会话）

`src/pet/ui/rig/`：`rig.ts`（加载与绘制，WebGL2）、`motion.ts`（待机、眨眼、视线、心情 → 参数，纯函数可测）、`index.ts` 导出：

```ts
export interface RigHandle {
  setMood(m: PetMood): void;
  /** 0..1：她声音此刻的响度（PetAudio.level()），驱动嘴。 */
  setTalk(level: number): void;
  /** 视线目标，-1..1（以她的脸为中心）；null = 自己游移。 */
  lookAt(p: { x: number; y: number } | null): void;
  /** 窗口被拖动的速度（像素 / 秒），头发和披摆反向甩。 */
  setDrag(vx: number, vy: number): void;
  /** 一下子的反应：点她、赢了、被吓到…… */
  react(kind: 'poke' | 'cheer' | 'startle' | 'nod'): void;
  setFps(cap: 30 | 60): void;
  setReducedMotion(on: boolean): void;
  /** 她此刻在窗口里占的矩形（页面像素），用来判断点击穿透。 */
  bounds(): { x: number; y: number; w: number; h: number };
  destroy(): void;
}
export function mountRig(canvas: HTMLCanvasElement, opts: { scale: number }): Promise<RigHandle>;
```

U 在 `PetApp` 里接它：心情、音量、光标、拖动都从现有的事件里来。素材在 `public/pet/rig/`（图层 PNG + `rig.json`；`rig.json` 由页面打包引入，不用 `fetch`）。

## 8. 检查

- `npm run check:pet`（主会话加进 `package.json` 和 `check:modules`）：`scripts/pet-check.ts`（M：策略、采集接线、窗口、热键、语音、断句、实时、通道和发送方检查、图片消息校验、`pet-tales.json`）+ `scripts/pet-brain-check.ts`（B：路由、触发、提示词、清洗、台词规则、小游戏逻辑、设置迁移）+ 木偶的纯函数（主会话）。
- `scripts/check-build.mjs`（U）：`dist/pet.html`、`dist/capture.html` 存在、带样式、`__petCapture` 在，CSP 严格。
- 台词：`npm run check:voice` 要认得 `pet.*` 场景并全过。

## 9. 子代理守则

- 只改自己名下的文件（§1）。别人的文件要改，写在交付说明里。
- **不要跑 `vite build`、`npm run build`、`npm run verify`、`npm run app`**：会覆盖 `dist/`，用户可能正开着栖枝。类型检查用 `npx tsc --noEmit -p .`（别人的文件有错就只看自己的），模块检查用对应的 `rolldown … --file node_modules/.cache/xxx.mjs && node …`。
- **不要启动任何可见窗口**，也不要跑真的 Electron 应用；萤火的检查是把 Electron 换成假的来测，照那样做。
- **不要装任何依赖**（不 `npm install`），不要联网下载东西。
- **不碰 `%APPDATA%/alight-desk`**，也不碰 `firefly-harness` 仓库（只读）。不要在项目里跑解包、格式化、代码生成这类会就地写文件的命令。
- 写中文注释，风格照周围的代码。交付时写清：改了哪些文件、跑了哪些检查（贴结果）、没做完或拿不准的地方。

## 10. 落地记录（2026-10-31，0.3.0-beta.1）

- 三个子代理按 §1 分工移植完，主会话做了木偶（`src/pet/ui/rig/`，19 层，素材 `public/pet/rig/`）、接口与集成。`npm run verify` 全过（check:pet = 主进程 449 + 大脑 441 + 桌宠窗口 111 + 木偶 185 项）。
- 两位只读审查员（主进程 17 条、大脑 25 条，无高危）的问题都已修：主页面崩溃时清掉实时陪玩与麦克风；联网答疑在主进程里只给 WebSearch / WebFetch；音色只列音色设计做的、克隆音色一律拒绝；台词清洗补齐挽留 / 依赖 / 旁白 / 剧透词表并去掉对攻略句的误杀；童话和接龙加禁词；桌宠设置有独立备份键 `alight/pet`，音色 ID 按服务分存。
- 集成时补的：`PetLine.kind/tale`、`PetWindowBridge.saveTale/realtime/pause`、`PetRuntimeConfig.realtimeReady`、`voices(provider, {all})`；看鼠标的头部基准改成 0.32（`window.cjs HEAD_Y`）；页面用 CSS zoom 缩放，木偶按 `getBoundingClientRect` 定画布分辨率；朗读失败时桌宠窗口显示一句原因；catalog 给 Claude / GPT / Gemini 全系与 glm-5.3-flash 标了 `caps.vision`。
- 实测（`../design/pet/bench/实测结果.md`）：桌宠不占独显；看屏约多 0.5 GB 内存（GPU 进程里的截屏缓冲，截屏已降到 1080p / 4 fps，关掉 90 秒后释放）。游戏帧率按交替、预热、独显留余量的测法重测（`../design/pet/bench/jitter/`）：桌宠开着、页面空闲时全屏游戏 240.1 帧、1% 低帧 230，和只开游戏一样；早先记的「栖枝本身让全屏游戏 1% 低帧从 232 掉到约 120」是独显越跑越热造成的错觉，作废。真正拖累游戏的是被盖住时还在跑的动效（真全屏 1% 低帧 227 → 66）：0.3.0-beta.2 起，被全屏程序 / 认得的游戏盖住（桌宠没开时：切走满 5 秒）就停（main.cjs 的 announceCovered），修后 223。
- 还缺：LGPL / GPL 全文（下载要用户同意）；实时陪玩没用真密钥测过；真机验收（点击穿透、热键、输入法、真游戏）。
