# 昼开屏 · 预渲染视频版样片（施工图）

状态：设计稿，尚未实施。基线 HEAD a369da8（0.2.0-beta.3）。本文只定契约与做法，不含代码。
读者：R（渲染编码）、I（播放接入）两位实施者，以及最后做 A/B 验收的人。
前置阅读：`docs/BOOT-COMPOSITOR.md`（第六至八轮：昼开屏锁 120、剩余卡顿主要是集显被吃满时随机的约 100 ms Present 停顿）。

目标一句话：把昼开屏里「文字以外、与窗口比例无关」的所有重层，提前逐帧渲染成一段不透明视频，开屏时硬件解码播放；标题文字、署名、版本号、跳过提示与光尘仍实时画；播完后交回实时 DOM，转场代码一行不改。要能与现在的实时版在同一个构建里交错 A/B。

---

## 0. 先定的几件事（含与硬规则的对账）

| 项 | 决定 | 理由 / 备注 |
| --- | --- | --- |
| 渲染边长上限（硬规则 4） | **严格执行**：视频渲染尺度 s = 0.944 像素/舞台单位（视频高 944 px） | 官方立绘 splash-official.webp 为 1600²，舞台里占 1280 单位，开头镜头 z = 1.12，渲染边长 = 0.944 × 1280 × 1.12 = 1353 px ≤ 1600。花海条 day-strip.webp 为 1700×216，铺在 1600×210 单位里，原图密度约 1.0625 px/单位，z = 1.12 时要求 s ≤ 0.9487；0.944 满足。散花、花瓣等矢量小件无原图，不受此限。 |
| 代价 | 视频比实时版糊：开屏全程由 GPU 把 944 高的视频拉到窗高（2560×1600 屏上约 1.69 倍；实时版立绘是 1.28 倍） | 这是硬规则 4 的直接后果，样片说明里必须写明；光尘、蝶、枝、花瓣这类小件在视频里更软。 |
| 想要更清的版本 | R 的脚本留 `--scale` 参数，可另出一档「清晰档」（例如 1.104，高 1104）仅供 A/B 的人看，**默认不生成、不入库、不进安装包** | 只有用户明确放宽硬规则 4 才采用。样片阶段不做。 |
| 帧率 | 120 fps，恒定 | 用户要 120，与昼开屏锁 120 一致，240 Hz 屏上每帧占两个刷新。 |
| 默认值 | ~~设置项默认「视频」~~ → **2026-10-29 起默认「实时」**，视频留作设置里的选项（第 13 节）；任何一环失败整次走今天的实时路径（零回退） | 样片阶段用户要求默认视频；beta.5 之后用户说「改回实时」。 |
| BootImpl 类型 | **不加第三个取值**；做成与 `lockHzFor` 同写法的正交开关，底下仍是 `'comp'` | `dayScene.ts` 的多处、`transition.ts` 的多处、`BootSplash.tsx`、`governedFor` / `governedForTransition` 都是 `bootImpl() === 'comp'` 判断，加第三个值会让它们静默变成 legacy。`?bootimpl=video` 作为别名保留，见第 4 节。 |
| 夜开屏 | 一行不动 | 视频只对昼。 |
| 不做的事 | 带 alpha 的视频；把文字烘进视频；服务端 / 流媒体 | alpha 视频在 Chromium 里不确定能硬解（未验证）；文字要被转场 FLIP。 |

---

## 1. 视频覆盖哪些层、哪个时间段；文字与转场怎么叠；在哪一帧交接

### 1.1 时间轴

- 昼开屏 T_END = L + 2.4 = 7.4 s（L = 落地时刻 5.0 s，来自 `DT.fly[1]`）。
- 视频内容 = 时刻 t ∈ [0, 7.4] 的纯函数，逐帧 t = i / 120，i = 0 … 888，共 **889 帧**（最后一帧恰是 t = 7.4）。时长 889/120 = 7.4083 s。
- 视频播完停在最后一帧（不触发清屏），由交接逻辑撤掉。
- 7.4 s 之后的 3 s 定格（`bootEnter='auto'`）与 10 fps 的 ambient 全部是实时 DOM，与今天一样。

### 1.2 谁进视频，谁留实时

| 层 | 进视频 | 实时 | 说明 |
| --- | --- | --- | --- |
| 底板 `.boot__plate`、`.bd-bg`（光晕、三角纹、顶沿、白渐变）、`.s0-glow` | 是 | | 光晕 0.3–2.7 s 渐升。 |
| 三道光束 `.beam` | 是 | | 0.1–6.6 s。 |
| `.bd-world`（镜头缩放 1.12→1.0）及其内 `.bd-pre` / `.bd-bloom`（花海条、官方立绘、散花、径向蒙版圆形）/ 枝 / 枝上白花 / 雪点 | 是 | | 雪点烘进视频，7.4 s 之后由 DOM 的 ambient 接着落（T_END 的位置是纯函数，接得上）。 |
| `canvas.boot__fx` 里除光尘外的全部：雾、荆棘脉冲、圆边雾圈、点花、花瓣、蝶轨迹、各种光晕 | 是 | | |
| 光尘 40 粒 | | 是 | 位置按窗口分数 `x0*W, y0*H` 定位，烘死会在非视频比例的窗口里交接处错位。视频期间 `boot__fx` 只画光尘，7.4 s 起恢复完整 fx（此时 fx 里除光尘外已无活跃项，见 1.4 的前提检查）。 |
| 蝶 `.bd-bfwrap`（展翅、飞行、落枝、呼吸） | 是 | | 7.4 s 由 DOM 的 svg 接着呼吸。 |
| `.bd-text`：署名、跳过提示、标题「栖」「枝」、ALIGHT、标签条、题词、版本号、进入提示、呼吸线 | | 是 | 转场要对它们做 FLIP / 淡出；署名 1.2 s 才淡完。节拍仍由 `BootPlayer`（调速器锁 120）逐拍写样式。 |
| `.boot__veil`（冷启动垫的 #efeaf6） | | 是 | 与今天相同：首帧上屏后淡出。 |

### 1.3 叠层顺序（自下而上）

1. `video.boot__vid`：新增，放在 `.boot__stage` 内、`.boot__ph` 之前，`z-index` 最低。尺寸见 2.3。`muted`、`playsInline`、`disablePictureInPicture`、`preload="auto"`，`pointer-events:none`。
2. 实时 DOM 背景层（`.boot__ph` 底板、`.bd-stage`）：视频期间 `visibility:hidden`，不参与栅格，也不再每拍写样式。
3. `canvas.boot__fx`（z2）：视频期间只画光尘，叠在视频之上。因为蝶在视频里，光尘画在蝶的上面（实时版光尘在蝶下面）；40 粒小光点，可接受，验收时看一眼。
4. `.bd-bfwrap`（z3）：视频期间 `visibility:hidden`。
5. `.bd-text`（z4）：实时。

### 1.4 交接点：T_END 的最后一帧（媒体时间 7.4 s，第 888 帧）

选 T_END 的理由：此时光束早已收了（约 6.6 s）、枝描完了（4.4 s）、白花弹完了（约 6.4 s）、花瓣与蝶轨迹结束（约 7.2 s）、光晕与光环结束，背景只剩雪、光尘、蝶翅的微动，两边最容易对上。

**前提检查（I 写进 check-boot）**：在 t ≥ 7.3 时，`renderFx` 里除光尘以外没有任何活跃项（花瓣 `life` 到期、轨迹点过期、各光晕 / 光环到期）。这一条不成立就不能在 T_END 交接，要后移交接时刻并重新渲染更长的视频。

**时序**（媒体时间 t_m 取 `requestVideoFrameCallback` 的 `mediaTime`）：

1. t_m ≥ T_END − 0.25 = 7.15 s：预光栅。在一个任务里 `render(T_END)` 把 DOM 背景层写成最终态，把底板、`.bd-stage`、`.bd-bfwrap` 设为可见且 `opacity:.001`（沿用现有 `PRE_RASTER` / `bcvPre` 的做法），让它们提前栅格好。
   - 它们必须叠在视频**之上**（opacity .001 的层不会被当作遮挡）。若放在视频之下，被不透明视频遮挡的层 Chromium 可能不栅格，淡出那一刻会露出未栅格的块。因此 DOM 背景层的叠序实际在视频上方，视频期间用 `visibility:hidden`，预光栅期改为 `opacity:.001` 的可见态。
2. t_m 抵达最后一帧（t_m ≥ 7.4 − 0.5/120）：交接任务。
   - 在同一个任务里再 `render(T_END)` 一次（补 7.15 之后的微动），随后对底板、`.bd-stage`、`.bd-bfwrap` 三层用 WAAPI 同一时间线把 `opacity` 从 .001 升到 1，时长 `HANDOFF_FADE_MS = 120`（只在合成器上跑）。
   - `finished` 之后：`video.pause()`、`removeAttribute('src')` + `load()` 释放解码器、移除 `<video>`、`BootPlayer` 转入 ambient（今天的 10 fps 重画）。
   - `HANDOFF_FADE_MS` 是常量。若验收证明交接帧差足够小，可置 0 改成硬切；默认 120。
3. 此后 3 s 的转场与今天完全一样（`getBake()` 要求烘焙时的光晕不透明度等于此刻的 `el.bk` 不透明度，DOM 层在转场第一帧必须是活的且已栅格，这一点由第 1 步的预光栅保证）。

### 1.5 被打断（点击 / 跳过 / 退出，或 7.4 s 之前的任何退路）

- `leave()` 里先 `video.pause()`，`from` 取**最近一次已呈现帧的 `mediaTime`**（rVFC 最后一次回调），不取墙钟，也不取 `video.currentTime`（它可能已超前于已呈现帧）。
- `scene.settle(from)`：`render(from)` 写完整 DOM 帧（含 fx 画布、蝶、雪、枝），把 DOM 背景层设为可见并 `opacity:.001`，返回 Promise，等 2 个 rAF 让它们栅格，之后 **opacity 直接设 1**（打断场景不做淡入，转场的运动会遮住差异），撤视频，起转场。`BootSplash.tsx` 已有 `scene.settle?.(out.from)` 并 await，不改转场。
- 打断发生在 < 2.7 s（绽开段）时，DOM 走蒙版字符串的慢路径（已有 `hold` 逻辑）。视频模式的 `prepare()` 不烘绽开画布，所以这时的 settle 比实时版慢一些，验收要单独量（见 6.7），并把数字写进报告。

### 1.6 交接帧一致性：怎样才算「逐像素一致或肉眼不可见」

有损编码加 4:2:0 无法保证逐像素相同。因此验收分两层定义，**两层都要过**：

- **A 层（保真度，同分辨率对比）**：把 DOM 在 944 高、DPR 1 的视口里渲染 T_END 的一帧（导出 DOM 蒙版路径，与 HEAD 逐像素相同），和**视频解码出的第 888 帧**逐像素比。阈值：亮度平均绝对差 ≤ 0.6 / 255，99.9 分位 ≤ 6，任意 8×8 块均值差 ≤ 2，且差值图没有可辨认的结构（边缘 / 条带）。这一层衡量编码损失与色彩管线。
- **B 层（真实环境）**：真窗口（realwin 屏外窗口，2560×1600），交接前一帧（视频已拉伸）与交接后第一帧（DOM）的截图相比。只报告平均差与锐度差，由肉眼 + 淡入 120 ms 把关。已知：DOM 的立绘更锐（1.28 倍 vs 1.69 倍放大），这是硬规则 4 的代价，淡入负责把它抹成一次柔和的「变清」，不是跳变。

另有两项要实测并写进报告：

- 宽窗口下 `.bd-bg::after` 的 118° 白渐变（α .04→.34）和 `.tri` 的 100° 遮罩随盒宽变，视频按 ext ≈ 2097 烘，窄一点的窗口（例如宽高比 1.6）的 DOM 盒宽更小，估算右侧有 1–3 个色阶的低频差。验收时在宽高比 1.6、1.7、1.78 三个窗口各量一次 B 层。若 > 2 色阶：见 2.4 的「多出一档」。
- 色彩标定（见 2.5）。

---

## 2. 分辨率、比例、帧率、编码

### 2.1 分辨率与尺度

- 视频帧 **1980 × 944**，DPR 1，尺度 s = 0.944 px / 舞台单位（视口高 944 对应 1000 单位，即 k = 0.944）。
- 对应舞台宽度 ext_v = 1980 / 0.944 = 2097.5 单位，宽高比 2.0975，略小于 `aspectOk` 上限 2.10。
- 理由：比例上限覆盖整个 `aspectOk` 范围 [1.15, 2.10] 的所有窗口（窄窗口靠裁切），一个文件够用。1980×944×120 = 224 M 亮度样本/秒，在 HEVC level 5.1 内（上限 534 M）；H.264 宏块 124×59×120 = 878 k/秒，在 level 5.2 内。（这些是按 level 表推的，摸底只在 2560×1600 上验证过硬解，1980×944 是更小的帧，R 需在真窗口上再确认一次，见 6.2。）

### 2.2 窗口比例与取景

窗口宽高比 r = W / H：

| r | 做法 |
| --- | --- |
| r ≤ 2.0975 且在 `aspectOk` 内（1.15 – 2.10） | 视频：`<video>` 高 = 窗高 H，宽 = H × 1980 / 944，左上对齐于舞台原点，外层 `overflow:hidden` 裁切。窄窗口右侧被裁，与实时版「舞台右边被裁，不重新取景」一致。 |
| r > 2.0975，或 `aspectOk` 为否 | 整次走实时（或沿用今天的定格 + 交叉淡化）。 |
| 开屏播放中 resize 到 r > 2.0975 | 走 1.5 的打断路径，转实时接着跑。 |
| 开屏播放中 resize 但仍在范围内 | 只改 `<video>` 的 CSS 尺寸，不重画。 |

真实窗口比例未知（估算：默认窗口 1.6–1.7，2560×1600@150% 最大化约 1.7–1.75），所以一个覆盖到 2.0975 的文件是安全的。

### 2.3 `<video>` 的几何

`width = H * 1980 / 944`，`height = H`，`left = 0`，`top = 0`，`object-fit: fill`（尺寸已是精确比例）。位置与 `.bd-stage` 的 `scale(k)` 原点一致，因此视频里的 1 个舞台单位恰好落在 DOM 同一位置。

### 2.4 要不要多出一档

默认**不多出**，样片只出一个文件（加一个 H.264 兜底，见 2.6）。若 6.5 的 B 层在宽高比 1.6 / 1.7 / 1.78 上任一处测得右侧低频色差 > 2 色阶，则追加一档「标准档」：宽 1680、高 944（ext = 1779.7，r ≤ 1.78），仅用于 r ≤ 1.78 的窗口，更宽的窗口用宽档。总文件大小上限见 2.7。

### 2.5 色彩

- RGB → YUV 用 BT.709 矩阵、有限范围（tv）。
- 容器里写 `colorspace=bt709`、`color_primaries=bt709`、`color_range=tv`，传递函数标记待标定：候选 `bt709` 与 `iec61966-2-1`（sRGB）。Chromium 对两者的显示结果在暗部不同。
- **标定步骤（R 先做，几分钟）**：做一个包含 0–255 灰阶阶梯、底板色 #d4c8e4 和光晕色块的短测试片，在真窗口里用 `<video>` 播放并截屏，与同色 DOM 色块对比；选误差更小的标记，把选择写进 `day-boot.json` 的 `trc`。
- 抗条带：源图是 8 位，渐变（光晕、白渐变、三角纹遮罩）有 8 位台阶。因此编码前在 10 位 YUV 域加确定性的 TPDF 抖动（种子 = 帧号，可复现），再进 x265。幅度默认 2.0（10 位最低位单位，约 0.5 个 8 位台阶），由「条带指数」调：在两三块平滑渐变区域，比较解码后与母版的亮度台阶游程长度分布，目标不比母版差。抖动会抬码率，受码率上限约束。

### 2.6 编码器与参数

选摸底里在这台机器上硬件解码且 smooth 的，实测最干净的一路：

- **主文件**：HEVC Main10，`hvc1`，mp4 faststart。摸底在 2560×1600@120 下 3 次 0 丢帧、1 次 1 丢帧，冷启动也干净。
- **兜底文件**：H.264 High level 5.2，mp4 faststart。摸底有首个视频冷启动的丢帧（4–13/360），所以仅在 HEVC 不被支持时用。
- 不用 AV1 / VP9（有 2–3 帧丢和 30–54 ms 的停顿）；不用 NVENC / QSV / AMF / CUDA 解码（硬规则 3）。

`ffmpeg` 在 `G:\Claude Code Workplace\tools\ffmpeg\ffmpeg-9.0.1-full_build\bin\ffmpeg.exe`（也在 bash PATH 上），一律 `-threads 4`、低优先级，不下载。

HEVC 起手参数（R 按条带指数与大小调，但容器与 GOP 项不改）：

```
-c:v libx265 -pix_fmt yuv420p10le -preset slow -crf 17 -tag:v hvc1
-r 120 -fps_mode cfr -g 120 -keyint_min 120 -threads 4
-x265-params pools=4:level-idc=5.1:profile=main10:scenecut=0:aq-mode=3:psy-rd=1.0:no-sao=0:vbv-maxrate=18000:vbv-bufsize=36000:frame-threads=2
-colorspace bt709 -color_primaries bt709 -color_trc <标定结果> -color_range tv
-movflags +faststart
```

H.264 起手参数：

```
-c:v libx264 -pix_fmt yuv420p -profile:v high -level 5.2 -preset slow -crf 18
-r 120 -fps_mode cfr -g 120 -keyint_min 120 -sc_threshold 0 -threads 4
-maxrate 24M -bufsize 48M
-colorspace bt709 -color_primaries bt709 -color_trc <标定结果> -color_range tv
-movflags +faststart
```

（X264 用 8 位，抖动幅度改为 0.75 个 8 位台阶，且在 YUV 域加；记忆里这一步能压住 x264 的条带。）

### 2.7 大小

- HEVC 主文件 ≤ 17 MB（vbv 18 Mbps × 7.41 s ≈ 16.7 MB 是上限）。
- H.264 兜底 ≤ 22 MB（24 Mbps 上限）。
- 两个文件合计 ≤ 40 MB。超了先降抖动幅度、再降 crf 目标，不减帧率、不减分辨率。
- 这些文件随安装包进 asar（asar 不压缩，首次播放时整文件读取），安装包增加等于文件大小，要在报告里写出来。

---

## 3. 加载与时序、退路

### 3.1 何时开始加载

- `earlyBoot.ts`（与 React 挂载并行）里，若 `bootVideoFor('day', setting)` 为真，立即建一个 `<video preload="auto" muted playsInline>` 并设置 `src`（路径 `./boot/day-boot.hevc.mp4`；兜底文件在 HEVC 判不支持时才建）。同时调 `navigator.mediaCapabilities.decodingInfo`，要求 `supported && smooth && powerEfficient`，参数：HEVC `video/mp4; codecs="hvc1.2.4.L153.B0"`，宽 1980、高 944、帧率 120、码率取实际文件码率。
- 该 `<video>` 存在模块级变量里，`BootSplash` 复用同一个元素（和 `preloadBoot` 复用同一批 Image 一样），不重建。
- 摸底的经验：`src` 设置后 25–90 ms `loadeddata`，此时 `readyState` 已是 4，整段已缓冲；`play()` 后 2–36 ms 出首帧。解码器能力要在窗口加载**之后**读（`video_decode` 在 app-ready 时读可能是 `disabled_software`，加载后才是 `enabled`），所以以 MediaCapabilities 与实际 `loadeddata` 为准，不用 `app.getGPUFeatureStatus` 作判决。

### 3.2 判决点

位置：`scene.ready.then(...)` 内、`reportFirstFrame()` 之前。条件全满足才用视频：

1. `bootVideoRequested()` 为真，主题为昼，`bootImpl()` 为 `'comp'`。
2. 窗口宽高比在 `aspectOk` 内且 ≤ 2.0975；未开「减少动态」；页面未隐藏。
3. 能力判定通过（HEVC 优先，不通过且 H.264 通过则用兜底文件；都不通过则放弃）。
4. `<video>` 已 `loadeddata`、`readyState ≥ 2`、无 `error`，且首帧已上屏（暂停在 `currentTime = 0`，等一次 `requestVideoFrameCallback` 回调）。

等待策略：在 `scene.ready` 之后最多**再多等 300 ms**（`VIDEO_WAIT_MS = 300`）。超时直接按实时路径走，并在 `prof` 里记 `{used:false, reason:'timeout', waitMs}`。窗口显示本来有 2.5 s 兜底，所以不会因此露出空窗口。这个 300 ms 是需要用户拍板的数（越大越能用上视频，越小冷启动越不拖）；样片取 300，并在 S1 里测实际会不会触发（预期不会，见 6.6）。

任何一步失败 = 整次走今天的实时路径，**不做半视频**。

### 3.3 起播与时钟

- 窗口真正露出来（`whenWindowShown()`）的同一时刻 `video.play()`，不是之前。第 0 秒是用户看到的第 0 秒。
- 开屏时钟改成**媒体时钟**：`BootPlayer` 新增 `timeSource`。每次 rVFC 回调记 `(mediaTime, expectedDisplayTime)`，每拍的场景时间 t = mediaTime + (本拍预计呈现时刻 − expectedDisplayTime) / 1000，外推量夹在 [0, 50 ms] 内。视频卡住（媒体时间不前进）时文字也跟着停，不会跑到视频前面。首个 rVFC 到来前 t = 0。
- 视频模式下 `BootScene.render(t)` 只调 `renderDom(t)`（文字 + 光尘）；`settle(t)` 与交接才调完整 `render(t)`。

### 3.4 `prepare()` 在视频模式下

- 做：官方立绘 / 花海条的解码（转场的 `getBake` 和交接时的 `render(T_END)` 需要）、底板预烘、`bkb`（1/8 分辨率光晕位图）、枝的烘焙。
- 不做：绽开画布、花海条画布、光束提升（这些是给 DOM 路径在 < 2.7 s 出现的情形用的）。
- 时机：避开最开头的主线程忙时（0.6–1.4 s 有署名与跳过提示出现），放到首帧后；`warm.ts` 的着色器预热放在 2.7–5.0 s 之间，那里除了光尘与文字什么都不动，最安静。7.15 s 预光栅之前必须全部做完，I 在 check-boot 里不测它，在验收里记录完成时刻。

### 3.5 播放中的退路

监听项：`error`、`stalled`、`waiting`，以及每 500 ms 采样 `getVideoPlaybackQuality()`。

| 情况 | 处理 |
| --- | --- |
| `error`，或首帧前就报错 | 立刻整次走实时，从 t = 0 起（首帧未出时无缝）；首帧已出则走 1.5 的打断路径，接着实时跑。 |
| 媒体时间在 `playing` 状态下 > 150 ms 不前进（卡死） | 走打断路径，转实时。 |
| 近 1 s 内丢帧 ≥ 14（> 12%） | 走打断路径，转实时。**仅在 2.8 s – 6.0 s 之间生效**。理由：2.8 s 前转实时要走绽开段慢路径，比继续播视频更糟；6.0 s 之后离交接太近，不如播完。 |
| 摸底的首帧补丁（首个视频进程冷启动时 4–13 帧的启动丢帧） | 不算：丢帧统计从 t_m ≥ 0.5 s 才开始。 |
| 页面隐藏 | `video.pause()`，与 `setHidden` 同步；可见后 `play()`，时钟随媒体走。 |
| 减少动态 / 宽高比越界 | 不放视频，沿用今天的定格。 |

退路只触发一次，触发后不再回到视频。转实时的做法：`video.pause()`，`from` 取已呈现帧的 `mediaTime`，`scene.settle(from)`，2 个 rAF，撤视频，`BootPlayer.start(from)` 继续（`start(fromT)` 已支持从中途起跳）。每一次退路都要在 `prof` 里记原因与时刻，供 A/B 统计。

---

## 4. 实现切换与设置

### 4.1 `bootImpl.ts`

保持 `BootImpl = 'legacy' | 'comp'` 不变。新增：

- `type BootImplRequest = 'legacy' | 'comp' | 'video'`，仅用于解析 `?bootimpl=`。
- `bootImpl()`：`?bootimpl=video` 解析为 `'comp'`，其余照旧。**不让 `'video'` 流进任何 `=== 'comp'` 的判断**。
- `bootVideoRequested(theme, setting)`：仅 `theme === 'day'` 才可能为真。优先级自上而下：
  1. `setBootVideo()`（测试固定值）
  2. `?bootimpl=legacy` → 假（legacy 没有调速器，视频无意义）；`?bootimpl=comp` → 假（即「实时版」，便于 A/B）；`?bootimpl=video` → 真
  3. `?bootvideo=1|0`
  4. `globalThis.__alightBootVideo`（init 脚本注入，打包后的 app 用 `loadFile` 没有查询串，测量台靠它；`rt.mjs` 的 `init` 数组就是现成注入点）
  5. 设置 `settings.bootVideo`
  6. 默认假（2026-10-29 改回；beta.4 / beta.5 是真，第 13 节）
- 另有 `bootVideoEligible(...)` 纯函数承载 3.2 的条件，便于 check-boot 测。

### 4.2 设置项

- `src/lib/types.ts`：`Settings.bootVideo: boolean`。
- `src/state/seed.ts`：`DEFAULT_SETTINGS.bootVideo = true`（2026-10-29 起为 `false`）。`persist.pickSettings` 以 `DEFAULT_SETTINGS` 为白名单，新增布尔键自动持久化，不需要 `migrateSettings` 或 `SETTINGS_REV`；默认改回实时时加了 `SETTINGS_REV` 5 的迁移，见第 13 节。
- `src/components/views/settings/AppearanceSection.tsx`：在「开屏「蝶落枝头」」行下新增 `SettingRow`：标题「昼开屏」，`Segmented<'live'|'video'>`，选项 `实时` / `视频（试验）`，描述写「只影响昼主题的开屏；视频版预渲染背景层、硬件解码播放，不支持时自动回到实时」。「预览」按钮走同一条判决。
- `src/lib/prefsKeys.ts` 的 `readEarlyPrefs` 读 `bootVideo`，让 `earlyBoot.ts` 能早起预加载。
- 夜主题下该行置灰或隐藏（视频只对昼）。

---

## 5. 文件分工与契约

### 5.1 分工

**R（渲染编码）**——只写：

- `scripts/boot-video/**`：渲染、编码、标定、校验脚本与 `README.md`（生成说明：怎么从零生成、耗时、参数、怎样验证、怎样确认视频没过期）。
- `public/boot/day-boot.hevc.mp4`、`public/boot/day-boot.avc.mp4`、`public/boot/day-boot.json`。
- `perf-work/bootvideo/**`（母版、帧哈希、标定片、日志，不入库）。
- 可导出一个小模块 `scripts/boot-video/mp4info.mjs`（解析 mp4 盒：`ftyp`、`stsd` 的编码四字符、宽高、`mvhd` 时长、`stts` 帧数），供 I 的 check-build 引用。

R 不碰 `src/**`。

**I（播放接入）**——只写：

- `src/**` 下与开屏有关的文件：`bootImpl.ts`、`dayScene.ts`（`render` 拆成 `renderBg` / `renderDom`，导出 `renderDom`、视频接管开关、`settle`）、`player.ts`（`timeSource`）、`BootSplash.tsx`（`<video>` 与判决）、`earlyBoot.ts`、`prefsKeys.ts`、`types.ts`、`seed.ts`、`AppearanceSection.tsx`、`boot.css`。
- `scripts/check-boot.ts`、`scripts/check-build.mjs` 的用例。
- DEV 导出钩子（见 5.3）。

I 不碰 `scripts/boot-video/**` 与 `public/boot/day-boot.*`。

**共用**：`perf-work/` 的测量台由 I 主持，R 配合提供产物；重任务一律拿锁（第 7 节）。

### 5.2 契约（R 交付、I 依赖；任一项变更须双方同意并同步改 manifest）

| 项 | 值 |
| --- | --- |
| 主文件 | `public/boot/day-boot.hevc.mp4`：HEVC Main10，hvc1，1980×944，120 fps 恒定，889 帧，时长 7.4083 s，faststart |
| 兜底文件 | `public/boot/day-boot.avc.mp4`：H.264 High L5.2，其余同上 |
| 帧 ↔ 时刻 | 第 i 帧对应场景时刻 t = i / 120，i = 0 … 888；T_END = 7.4 对应 i = 888 |
| 尺度 | 0.944 px / 舞台单位；视口 1980×944，DPR 1；舞台宽 2097.5 单位 |
| 交接时刻 | 预光栅 7.15 s，交接 7.4 s（最后一帧），淡入 120 ms |
| 不含 | 文字段全部、光尘、`boot__veil` |
| 含 | 其余全部（1.2 表） |
| 大小 | 两文件合计 ≤ 40 MB，HEVC ≤ 17 MB，H.264 ≤ 22 MB |
| 色彩 | BT.709 有限范围，传递函数按标定结果 |

`public/boot/day-boot.json`（R 生成，I 与 check 读取）字段：

```
{
  "schema": 1,
  "stub": false,
  "theme": "day",
  "width": 1980, "height": 944, "fps": 120, "frames": 889,
  "scale": 0.944, "extUnits": 2097.5, "ratioMax": 2.0975,
  "tEnd": 7.4, "landing": 5.0, "handoffPre": 7.15, "handoffFadeMs": 120,
  "trc": "<标定结果>", "matrix": "bt709", "range": "tv",
  "files": [
    { "role": "primary",  "path": "day-boot.hevc.mp4", "codec": "hvc1.2.4.L153.B0", "bytes": 0, "sha256": "..." },
    { "role": "fallback", "path": "day-boot.avc.mp4",  "codec": "avc1.640034",      "bytes": 0, "sha256": "..." }
  ],
  "hash": {
    "frame0_source_rgb": "sha256 of 无损母版第 0 帧 RGB",
    "frame888_source_rgb": "sha256 of 无损母版第 888 帧 RGB",
    "frame0_decoded": { "hevc": "...", "avc": "..." },
    "frame888_decoded": { "hevc": "...", "avc": "..." }
  },
  "sources": {
    "splash": "sha256 of art/splash-official.webp",
    "strip": "sha256 of boot/day-strip.webp",
    "timeline": "sha256 of 时间表常量（T_END、L、各层起止）",
    "src": "sha256 of boot/day*.ts（仅提示）"
  },
  "nativeCheck": { "splashMaxEdgePx": 1353, "splashNative": 1600, "stripMaxPxPerUnit": 0.0, "stripNativePxPerUnit": 1.0625 },
  "made": { "date": "...", "ffmpeg": "9.0.1", "headCommit": "a369da8" }
}
```

哈希的定义：「源哈希」= 无损母版里该帧的 RGB 像素字节的 SHA-256；「解码哈希」= 用 `ffmpeg -i <mp4> -vf select=eq(n\,K) -f rawvideo -pix_fmt yuv420p10le`（H.264 用 yuv420p）取出的原始平面的 SHA-256（`-threads 4`）。I 用第 888 帧的无损母版帧做 1.6 的 A 层对拍基准，需要 R 把 `perf-work/bootvideo/master/frame0.png`、`frame888.png` 一并提供（不入库）。

**防过期**：`check-boot` 读取 manifest，发现以下任一项不符就失败，并提示「视频过期，需要重新渲染」：`tEnd` 或 `landing` 与 `dayScene` 当前常量不同；`sources.splash` / `sources.strip` 与当前素材不同；`timeline` 哈希与当前时间表不同。`sources.src` 不一致只告警。`check-build` 在 manifest 的 `stub:true` 时报错（见 5.4）。

### 5.3 DEV 导出钩子（I 提供，R 依赖）

渲染必须走确定性导出路径（与 0.1.3 逐像素相同，`design/boot/out/boot-day.mp4` 就是它的产物）：先起无 HMR 的 dev server（`cd app && npx vite --config ../design/boot/tools/vite.e2e.config.mjs`，端口 5332），打开 `?bootcap=day`，调用 `window.__boot.seek(t, { leaveAt: 1e9 })`，再 `Page.captureScreenshot`。

I 要加的东西：`window.__boot.seek(t, { leaveAt: 1e9, layers: 'bg' })`，等价于「`.bd-text` 隐藏 + 光尘不画 + 其余 fx 照画」。入口仍只在 DEV（生产构建里整段被摘掉，`captureTheme()` 判 `import.meta.env.DEV`）。这与视频模式里的 `renderBg` / `renderDom` 拆分是同一件事，所以由 I 做。

R 的第一阶段不等它：在测量用副本里用 `patch-*.sh` 打补丁（只进 `perf-work`，不进仓库）关闭光尘并 CSS 注入 `.bd-text{visibility:hidden}`，先把管线与耗时跑通；**最终母版必须用 I 的钩子重渲染**，以保证可复现。

### 5.4 桩文件（解耦用）

R 在第一个小时内交一个**桩**：`scripts/boot-video/make-stub.ps1` 用 lavfi 生成符合契约（尺寸、帧率、帧数、编码、命名）的占位视频（渐变加帧号），`day-boot.json` 标 `"stub": true`。I 靠它先把播放、交接、退路、设置全部接通。`check-build.mjs` 对 `stub:true` 报错（防止桩被打进发布包）。真视频到位后覆盖桩，I 只需要重跑测试。

### 5.5 I 的 check 用例

`check-boot.ts` 新增（纯函数，node 里跑）：

- `bootVideoRequested` 的真值表：主题 × 设置 × `?bootimpl=` × `?bootvideo=` × `globalThis` × 固定值，夜恒为假；`?bootimpl=video` 解析为 `'comp'` 并且 `governedFor('day')` 仍为真。
- `bootVideoEligible`：比例边界（1.15、2.0975、2.10）、减少动态、隐藏、能力判定的各个组合。
- 视频矩形：窗口 (W, H) → (width, height, 裁切)，含 r = 1.15、1.6、1.78、2.0975。
- 时钟外推：夹在 [0, 50 ms]；媒体时间停滞时不前进。
- 退路判据：丢帧窗口、卡死、2.8–6.0 s 的有效区间、只触发一次。
- 前提检查：t ≥ 7.3 时 fx 里除光尘外无活跃项。
- 交接时刻常量与 manifest 对齐；防过期规则。
- 夜的现有断言不变（`selftest.mjs` 里的夜相关项不动）。

`check-build.mjs` 新增：

- manifest 存在则校验：两个文件在 `dist/boot/`、字节数与 sha256 与 manifest 一致、合计 ≤ 40 MB、`stub !== true`、`mp4info` 解析出的编码四字符 / 宽高 / 帧数与 manifest 一致。
- 不放宽 `media-src`：现有检查已要求恰好是 `'self' blob:`，保持不变；`<video src="./boot/...">` 已被 `media-src 'self'` 覆盖。
- `check-art.mjs` 只扫 `public/art/her` 和文件名禁用词，视频放 `public/boot/` 不受影响。

---

## 6. 验收

总原则：只用屏外 / 无头窗口，用完关掉自己起的进程；用户若开着栖枝（`node_modules/electron/dist/electron.exe` 不带临时 user-data-dir）绝不动；每次测量前确认插电（`Win32_Battery.BatteryStatus = 2`，电池下数字作废）并跑 `perf-work/dayhz/guard.ps1`（退出码 0 / 3 / 4）；不写 `APP/dist`、`APP/release`，不跑 `npm run verify / build / dist:win`，构建只在副本（`sync-build.ps1` 或 `mk-app.sh`，`FROM_WORKTREE=1`，输出到 `perf-work`）；不碰 `%APPDATA%/alight-desk`。

### 6.1 功能与交接帧

1. 交接帧对拍：1.6 的 A 层与 B 层。A 层用 944 高 DPR 1 的视口，DOM 的 T_END 帧与解码出的第 888 帧比；B 层用 realwin 真窗口，在宽高比 1.6、1.7、1.78 各一次。输出差值图、直方图和三个数字（平均差、99.9 分位、8×8 块最大均值差）。
2. 首帧对拍：视频第 0 帧与 DOM 的 t = 0 帧（A 层同法），阈值同上。
3. 色标：标定片在真窗口里的灰阶与色块误差，结论写进 manifest 的 `trc`。
4. 打断帧：在 t = 1.0、2.5、3.5、5.5、7.0 s 各打断一次，`settle(from)` 后的 DOM 帧与被打断时的视频帧比（差值，肉眼比对）。重点看 < 2.7 s 的慢路径转场起步延迟。
5. 文字与视频同步：标题「栖」出现时刻（5.5 s）与视频里蝶落点（约 5.0 s）的相对关系，在 WGC 捕获序列里测，偏差应 ≤ 1 帧（8.3 ms）。

### 6.2 硬解与能力

- 在真窗口 + Intel 核显（默认 GPU 偏好）上读 `MediaCapabilities`（HEVC 1980×944@120 `supported && smooth && powerEfficient`），同时用 `GPU Engine(*engtype_VideoDecode)` 计数器确认确实在硬解。摸底只测过 2560×1600，这里用实际帧大小再确认。
- 「高性能」(NVIDIA) 偏好未测，样片阶段不测，写进已知限制。
- 能力判定为假的机器（模拟：把 `decodingInfo` 的结果在测试里强制为假）必须走实时路径，且无任何视频元素残留。

### 6.3 A/B 测量

用 `perf-work/harness` 的 `ab.mjs` 交错 A/B（5 轮以上取中位数，沿用 `agg.mjs`），变体：

- A：实时（`?bootimpl=comp`）。
- B：视频（`?bootimpl=video`）。
- 如有需要，C：视频但强制走兜底 H.264。

场景：昼开屏全程（冷启动必播，用 `s1-boot-always.mjs`）。指标：

| 指标 | 说明 |
| --- | --- |
| Viz 出帧 fps | 与 BOOT-COMPOSITOR 的口径一致 |
| > 8.3 ms 帧占比，> 16.7 ms 占比，p95 出帧间隔 | 视频是 120 fps 内容，8.3 ms 为预期间隔 |
| LoAF（Long Animation Frames） | 数量与最长一个 |
| 视频 `droppedVideoFrames / totalVideoFrames` | 用 `getVideoPlaybackQuality()`；目标 0–1 / 889 |
| rVFC 呈现间隔 | 用 `expectedDisplayTime` 之差，不用 `now`（它是主线程回调时刻，不是呈现时刻） |
| 主运动节奏 | 在 realwin 的 WGC 捕获序列里测光束 / 镜头推移 / 蝶的位移：相邻捕获帧的内容更新间隔的分布，> 2 个刷新间隔（16.7 ms）的占比，最长停顿；同法比较 A 与 B |
| 退路触发次数 | 来自 `prof`，期望 0 |

要在两种条件下各测：quiet（无干扰）和「旁边开着重负载」。后者尽量复现用户机的 Claude 桌面端占 10–14% 3D 引擎的情形（用一个合成的 3D 负载页或空转的 GPU 工作，**不要**拉满，遵守硬规则 3），因为用户的卡顿恰恰出在这一条件下，摸底在安静机器上没复现。

### 6.4 打包后（asar）

用 `mk-app.sh` 在副本里构建，再用 `node_modules/.bin/asar pack` 把副本的 `dist` 打成 `app.asar`，让 Electron 从 asar 加载（`loadFile`，页面是 `file://` 指向 asar 内）。确认：`<video>` 能播、`seek` 正常、Chromium 发出 `Range: bytes=0-`、CSP 无违规、冷启动时 `loadeddata` 时间、`decodingInfo` 与实际播放一致。摸底已验证过 asar 里的探针视频可播，这里要验证真实包。

### 6.5 比例与取景

窗口宽高比 1.15、1.6、1.7、1.78、2.0、2.10、2.2 各开一次：视频 / 实时的取舍符合 2.2 的表；视频版右侧裁切正确；低频色差按 1.6 记录。结果决定要不要 2.4 的「标准档」。

### 6.6 冷启动 S1 不变慢

`s1-boot-always.mjs` 交错 A/B 至少 15 轮：`reportFirstFrame` 时刻、窗口显示时刻、`BootSplash` 挂载到首帧的耗时。门槛：中位数增加 ≤ 25 ms，p95 增加 ≤ 60 ms；`VIDEO_WAIT_MS` 的超时在 15 轮里 0 次触发。超标则调 3.2 的等待值或把 `<video>` 的创建再提前。

### 6.7 打断与退路

- 在 t < 2.7 s 打断，转场起步延迟与实时版的差；在 2.7–7.4 s 打断。
- 注入故障：`error`（把 src 指向不存在的文件）、卡死（暂停解码器）、丢帧（在 3–5 s 之间制造主线程 / GPU 负载），确认各自走对的退路，退路后画面与文字连续、转场正常、`prof` 有记录。
- 页面隐藏 / 显示、resize 越界、减少动态。

### 6.8 开屏全程 CPU / GPU 占用对比

在 A / B 各 5 轮里，开屏 0–7.4 s（含到转场结束）按进程（browser / renderer / GPU）采样 CPU，以及 GPU 引擎 3D、`VideoDecode`、`Copy` 的利用率（Windows 性能计数器 `GPU Engine(*)`）。目标：B 的 3D 引擎和渲染进程 CPU 明显低于 A，`VideoDecode` 有占用；要写出实际数字，不预设结论。若 B 的 GPU 总占用不降甚至上升（视频解码 + 拉伸加上 DOM 预光栅），也要如实写，那样「卡顿」未必改善。

### 6.9 通过 / 不通过

通过：6.1 的 A 层达标、B 层肉眼无跳变；6.3 在「旁边有负载」条件下视频版的 > 8.3 ms 占比与最长停顿不差于实时版（中位数），在安静条件下不更差；视频丢帧 ≤ 1/889（中位数）；6.4 asar 可播；6.6 达标；6.7 全部正确；视频总大小 ≤ 40 MB。
不通过的任何一项都写进报告，样片仍可交给用户看，但要标明「未达标项」。

---

## 7. 重任务与资源纪律（R 与 I 共同遵守）

- 这台笔记本满载会断电重启（Kernel-Power 41，10-26、10-28 各一次）。一次只开一个重任务，逐帧渲染、编码、测量、构建都算。
- 重任务前拿锁：

```
PowerShell: $l='G:/Claude Code Workplace/castorice-harness/perf-work/av/.heavy-lock'; while(-not (New-Item -ItemType Directory $l -EA SilentlyContinue)){Start-Sleep 15}; try{ ... } finally{Remove-Item $l -Recurse -Force}
```

- 开跑前查有没有别的渲染 / ffmpeg / 大 python / 游戏在跑，有就等，最多 60 分钟。
- ffmpeg 一律 `-threads 4`；不用 CUDA 解码、不用 NVENC / QSV / AMF；低优先级运行（`start /belownormal`）。
- 渲染帧不落 C 盘（C 盘只剩约 1.5 GB）：Chrome 配置与临时文件放 `perf-work`（G 盘）。`design/boot/tools/capture.mjs` 里的 `SCRATCH` 写死在 C 盘旧会话目录，R 不直接用，改用自己的脚本（可借 `perf-work/parity/day120/` 的 `lib.mjs` / `cap.mjs` 的写法）。
- R 的渲染分两段，便于重编码而不重渲染：
  1. 渲染：dev server + 软件渲染（`--disable-gpu`），视口 1980×944，DPR 1，`seek` 逐帧取 PNG，直接管到无损母版（FFV1 mkv 或同类，放 `perf-work/bootvideo/master/`），不留散落 PNG。889 帧，按旧日志估算（2560×1600 约 1.2–2.1 s/帧，像素约一半）约 15–30 分钟，**是估算，需先量 20 帧再定**。
  2. 编码：从母版读帧，numpy 做 RGB → BT.709 YUV 10 位 + 抖动，管给 ffmpeg 的 x265（再出 H.264）。每次调参只重做这一段。
- Python 打印中文设 `PYTHONIOENCODING=utf-8`；长命令后台写日志。
- 不 `git commit / push`，不 `npm install`，不下载。缺工具写进报告。
- 她的形象只用官方素材：不裁荆棘冠、不改色、不放大超过原图（第 0 节已对账）。R 的 `nativeCheck` 要对 `splash-official.webp` 与 `day-strip.webp` 实际算一遍写进 manifest，不对就把 `scale` 降下来重渲染。

---

## 8. 里程碑与顺序

| 阶段 | R | I | 门槛 |
| --- | --- | --- | --- |
| M0 | 读本文，确认契约 | 读本文，确认契约 | 契约冻结 |
| M1（并行） | 桩视频与 manifest；渲染管线用副本补丁跑通；量 20 帧耗时；色彩标定 | `bootImpl` 的正交开关、设置项、`earlyBoot` 预加载、`renderBg` / `renderDom` 拆分与 DEV `layers:'bg'` 钩子 | R 的桩可被 I 播起来 |
| M2 | 母版全量渲染（用 I 的钩子）；HEVC / H.264 编码与调参；校验脚本 | 判决点、播放、交接、退路、`settle(from)`；check-boot / check-build 用例 | 用桩跑通全部路径 |
| M3 | 交付真视频与 manifest（含哈希、母版两帧） | 换上真视频，跑 6.1 对拍 | A 层达标 |
| M4 | 配合重渲染（若 B 层或色标不过） | 6.2–6.8 的 A/B 与报告 | 6.9 |

重任务的执行互斥：R 在渲染 / 编码时，I 不做测量；I 在测量时，R 不渲染。双方约定一个简单的交替表放在 `perf-work/bootvideo/SCHEDULE.txt`。

---

## 9. 已知风险与待用户确认

待用户确认的数：

1. 硬规则 4 的解读：本文按「严格」（视频高 944，立绘与花海条都不超过原图）。若想要更清晰的视频，须由用户明确放宽，再出「清晰档」对比。
2. `VIDEO_WAIT_MS = 300`：多等多久还没准备好就退回实时。
3. 默认值设为「视频」，样片期间是否同时保留「实时」作为默认回退入口（设置里已有）。（已定：beta.4 / beta.5 默认视频；2026-10-29 改回默认实时，见第 13 节。）

风险与未验证项：

- 视频比实时版糊（硬规则 4 的代价）；小件（光尘、蝶、枝、花瓣）更软。这可能被用户一眼看出，要在样片说明里提前讲清。
- 摸底在安静机器上做的，**用户的真实卡顿条件（旁边 Claude 桌面端占 3D 引擎、集显被吃满的随机约 100 ms Present 停顿）没有复现**。视频的 Present 同样受这个停顿影响，只是主线程与光栅负载大幅下降；是否真的更顺要以 6.3 的「旁边有负载」条件为准，不预设结论。
- 首个视频冷启动有解码器预热的丢帧（H.264 4–13/360，AV1 约 11/360，HEVC 0–1/360）；开屏视频永远是进程里第一个视频，所以主选 HEVC Main10。
- HEVC 在老核显 / 缺编解码器的 Windows 上可能 `supported=false`，所以有 H.264 兜底与整次回实时。
- 摸底没测：高性能 GPU（NVIDIA）偏好下的表现；1980×944@120 的具体硬解（只测过 2560×1600）；WGC 呈现节奏（只用了 rVFC 近似）；带 alpha 的视频。
- 交接处的色阶 / 锐度差（硬规则 4 + 有损编码）：靠 120 ms 淡入与 A / B 两层验收把关；宽窗口的两条随盒宽变的渐变估算最多差 1–3 色阶，只在右侧，未实测。
- 光尘叠在视频里的蝶上方，与实时版层序不同（实时版光尘在蝶下），40 粒小光点，预期不明显。
- 预光栅一次性栅格全部 DOM 层（含 1600² 立绘），7.15 s 附近可能产生一次 GPU 峰值；这时视频在播，文字几乎不动，预期可承受，6.3 要看这一段的出帧间隔。
- 打包体积增加约 25–40 MB（视频不被 asar 压缩）。
- 渲染耗时、解码能力与窗口比例的数字有一部分是旧日志推算或估算，已在文中标明；以 M1 实测为准更新本文。
- 本文未改任何代码，也未跑渲染或测量。对 `dayTrComp.ts` 后半段与 `dayComp.ts` 没有细读，转场依赖清单来自前 200 行与 BOOT-COMPOSITOR；I 在 M2 开工前应通读一遍，确认交接时 DOM 层的状态与 `getBake()` 的前提。

---

## 10. 修订（0.2.0-beta.4 样片，2026-10-29）：评审 1–6 项的处理

本节**覆盖**前文里与之冲突的内容（前文是施工图原稿，保留作历史）。**几何（1774×846）、大小（11.2 MB）、预热 / prepare 的排期、颜色的数字以 §11 为准。**

### 10.1 现在的结构：视频 = 环境层，清晰立绘是实时 DOM

| 项 | 旧（施工图） | 现在 |
| --- | --- | --- |
| 视频内容 | 除文字 / 光尘外的一切 | 底板 / 光晕 / 光束 / 花海条 / 枝，以及 **< 3.0 s（绽开期）的立绘与近景散花**；A 类 fx（起手的雾、荆棘脉冲、圆边雾圈、点花，全在 < 3.0 s） |
| 实时 | 文字、光尘 | 文字、光尘、**2.7 s 起的清晰立绘 + 近景散花（DOM，叠在视频之上）**、蝶、雪点、B 类 fx（花瓣 / 轨迹 / 蝶的光晕 / 落蝶光环） |
| 编码 | HEVC Main10 120 fps 主文件 + H.264 兜底，1774×846，合计 36 MB | **只有 H.264 High L5.2、60 fps、445 帧**（`day-boot.avc.mp4`，11.2 MB），1774×846 |
| 立绘清晰度 | 视频里 1213 px 边长再被 GPU 拉 1.8 倍：清晰度 0.25–0.38（相对实时） | 2.7 s 起是 DOM 原图（与实时版同一个元素）：清晰度 0.96–1.01；< 2.7 s 的绽开期仍是视频里的软立绘（硬规则 4：视频渲染边长 ≤ 原图，花海条限制了尺度） |

清晰立绘层（`DAY_VID`：`ovPre` 2.3 s 起栅格、`ovFrom` 2.7 s = T_FREE 到 `ovTo` 3.0 s 淡入）：
- 淡入不是普通的 opacity：立绘有一条很宽的 CSS 蒙版羽化（左 / 右两侧大半幅 α 在 0–1 之间），「视频里有立绘 + DOM 层按 q 淡入」是两次 over，羽化带会暗到 10 个色阶、3.0 s 视频撤掉立绘时还会跳一下。
  母版里立绘组（立绘 + 近景散花）按 `f(a, q) = a(1 − q)/(1 − q·a)` 重映射 α（`masterOvRemap`：wrapper + SVG `feComponentTransfer`），DOM 层按 `q·a` 叠上去，B 的系数恰好是 `1 − a`；q = 0 与之前逐位相同，q = 1 时视频里没有立绘。
  实测 2.75 / 2.85 / 2.95 s 的整帧低频差恒为 0.8–0.9（与 3.5 s 以后一样，是 H.264 的整体 −0.5…−1 级偏差），没有色阶跳变。DOM 层的 q 取视频已呈现帧的媒体时间（`scene.video.note`），与母版里的 q 同一个值。
- 视频母版：`window.__boot.seek(t, { leaveAt: 1e9, layers: 'vid' })`（`scripts/boot-video/render.mjs` 默认 `--mode hook`，用工作区源码）。

### 10.2 评审各项

1. **丢帧 / 120 fps（high）**：本机 240 Hz 屏，屏外真窗口里 120 fps 视频只呈现约 84 帧/秒（合成器被视频合成成本压到约 167 帧/秒，每两个合成帧才换一帧），丢帧 27 %——一个只有 `<video>` 的测试页同样如此（HEVC / H.264 一样）。改 60 fps 后：呈现间隔 17.5 ms（= 3 个合成帧，整数节拍），丢帧 3–5 %（H.264），HEVC 6–7 % 且开头有 170–190 ms 的解码器冷启动停顿（H.264 没有）。→ **60 fps + H.264**。
   退路判据重标定：窗口内丢帧 ≥ 30（= 50 % 的 60 fps）才退（原 12 %，在这个环境里每次都会触发）。丢帧退路不再暂停视频：视频接着播，场景按「已呈现帧 + 0.12 s」去 settle，栅格完等媒体时间追上再同一个任务里换手（原来那 70–108 ms 的冻结没有了；`drop:3.5` 注入故障 → 退路 `dropped`，无控制台错误）。
   另：MediaCapabilities 的 `smooth` 不再参与判决（它是 Chromium 按「以前放这个规格丢了多少帧」的历史记的：屏外窗口里放过几次丢帧偏多的就恒为 false，我们一旦不放就洗不回来；实测过一次整次走了实时）；`powerEfficient` 不通过时隔 90 ms 再问，最多 4 次。
   **未验证**：用户的**可见**窗口。本次所有真窗口测量都是屏外窗口（硬规则 1）；屏外窗口没有硬件叠加层（MPO），可见窗口里视频合成成本应更低，但没有数据。需要用户本人在可见窗口里看（`globalThis.__alightBootVid` 里有 `dropped` / `total` / `fallbacks`）。
2. **转场更差（medium）**：安静时 day-fast（3 s 打断）转场 fps 92 → 106（实时 110）、p99 27 → 16.7（实时 16.7）；旁边有 3D 负载时 87.7 / p99 27 / 最长 77–125 ms → 96 / p99 25 / 最长 29（实时 103 / 16.7 / 25）。做法：立绘 / 近景散花 / 蝶 / 雪点本来就是实时的，settle 只需露出底板 / 光晕 / 花海条 / 光束 / 枝；settle 里在 2 个 rAF 之后再等「连续两个 rAF 间隔 ≤ 20 ms」（最多 260 ms），把集显被占着时栅格那一顿挪到转场开始之前。
3. **0.9 s 的停顿（medium）**：未完全消除。查明：不是 prepare（`__alightVidPrepareMs` 延到永不也在）、不是跳过提示（CSS 藏掉也在）、不是文字 / fx 画布（全藏也在）、不是关键帧（GOP 60 vs 445 一样）、不是测量注入（只留一行也在）；位置是媒体时间 ≈ 1.05–1.12 s，视频连续两三帧不换（rVFC 间隔 33–47 ms），无抓屏的 3 轮里只有 1 轮出现、有抓屏的 8 轮全有——与屏外窗口的 WGC 抓屏相关，且只出现在视频版。真实用户机上（无抓屏、可见窗口）预期更轻，但**没有证据**。另一个停顿（≈ 2.4 s，35–55 ms）查明是蝶第一次出现时整个 SVG 首次栅格，已把它摊到 1.6–2.2 s（以 α .004 预画一遍），现在 ≤ 25–33 ms。
4. **亮度台阶（medium）**：HEVC 主文件撤掉，改 H.264 8 位。真窗口里视频 vs 实时的带符号均差为 (−0.5, −1.1, −0.3) 级（HEVC 是 −2.4…−2.7）；交接帧对（最后一帧视频 vs 交接后 DOM）低频差 0.84（原 2.43）。
5. **立绘发糊（high）**：见 10.1。2.7 s 以后的清晰度比（视频版 / 实时）0.96–1.01（原 0.25–0.38）；2.7 s 前（视频里的软立绘）0.34–0.6，2.7–3.0 s 的 300 ms 是一次对焦。
6. **交接时「对焦」+ 变亮（medium）**：立绘本来就是 DOM，交接时没有清晰度跳变；亮度见 4；交接的 120 ms 淡入保留。

### 10.3 测量（realwin 屏外真窗口，Intel 集显硬解，插电，同一构建 `perf-work/vid-app`）

| 场景 | 指标 | 实时 | 视频 |
| --- | --- | --- | --- |
| 安静 day-auto 开屏 | 呈现内容更新率 fps / p99 间隔 / 最长间隔 | 135 / 16.7 / 29.2 ms | 160.7 / 8.3 / 50 ms（0.9 s 处） |
| 安静 day-auto 转场 | fps / p99 / 最长 | 124.8 / 14.6 / 25.0 | 121.2 / 16.7 / 20.8 |
| 安静 day-fast 转场 | fps / p99 / 最长 | 110.4 / 16.7 / 22.9 | 106.0 / 16.7 / 31.2 |
| 3D 负载 day-auto 开屏 | fps / p99 | 92.7 / 16.7 | 155.3 / 12.5（最长 45.8 vs 29.2） |
| 3D 负载 day-fast 转场（修 settle 后，5 轮） | fps / p99 / 最长 | 103 / 16.7 / 25 | 96 / 25 / 29.2 |
| 视频本身 | rVFC 帧数 / dropped / 退路 | — | 420 / 24（5 %）/ 0 |

注入故障（`perf-work/bootvideo/r1fault.mjs`）：normal、interrupt 1.0 / 2.5 / 3.5 / 5.5、error 3.0、stall 3.0、drop 3.5、off：全部转场正常结束、`<video>` 无残留、无控制台错误，退路原因与时刻记在 `__alightBootVid.fallbacks`。

### 10.4 已知限制

- 没有在用户的**可见**窗口里验证（见 10.2 第 1 项）；0.9 s 的停顿在屏外窗口 + 抓屏下仍有（41–58 ms 一次）。
- < 2.7 s（绽开期）立绘是视频里的软版本（0.846 像素 / 舞台单位）；2.7–3.0 s 对焦。
- 打包（asar）本轮没有重测（文件名 / 大小变了：只有 `day-boot.avc.mp4` 11.2 MB，安装包比旧样片少约 25 MB）；窗口宽高比 1.6 / 1.78 只做了视频模式的目视检查（harness 的 resize 模拟让实时对照的时间对不上，量不了数）。
- 高性能（NVIDIA）偏好未测。

---

## 11. 修订（0.2.0-beta.5 样片，2026-10-29）：按显示分辨率重渲 + 停顿 / 截断 / 颜色

测量条件同 §10.3：屏外真窗口（realwin，Intel 集显硬解，插电，WGC 抓屏）、同一构建 `perf-work/hd-app`、live / video 交错 4 轮。过程数据在 `perf-work/bootvideo/r4/`。

### 11.1 按显示分辨率渲染（评审 high）

- 用户窗口 2560×1600 物理像素、150 % 缩放；开屏舞台 = 最大化（避开任务栏）约 1710×1020 CSS = **2565×1530 设备像素**，舞台高 1000 单位 = 1530 设备像素。
  视频改成 **DPR 1.5、CSS 视口 2140×1020 = 帧 3210×1530**（`geometry.json`：scale 1.53 设备像素 / 单位）。窗口高 1020 CSS 时 1 个视频像素 = 1 个设备像素，播放不再放大（上一轮是 1.81 倍）。按 DPR 1.5 渲，所有按 CSS px 写的模糊 / 描边与实时版同尺度。
- H.264 High L5.2（`avc1.640034`）、60 fps、445 帧、crf 12、**33 181 076 字节（31.6 MiB，35.8 Mbps）**（≤ 40 MB）；比 beta.4 的 11.2 MB 多约 22 MB 安装包。
  **不用退档**：`MediaCapabilities`（3210×1530@60，40 Mbps）supported + powerEfficient；真窗口里 445 帧丢 24（5.4 %，与 1774×846 时的 24 完全相同），退路次数 0。
- 清晰度比（Laplacian 方差，视频 / 实时，同一 t 冻结，文字矩形屏蔽）：t = 0.25 / 0.75 / 1.0 / 2.5 / 4.5 / 6.0 s 分别 1.09 / 1.04 / 1.18 / 1.14 / 0.99 / 0.98（目标 ≥ 0.85；上一轮 0.34–0.6）。
- 交接「对焦」：最后一个视频帧（7.35 s）对交接后的 DOM 帧：亮度平均绝对差 0.77、低频差 0.26（beta.4 是 0.84 / 2.43）、清晰度比 0.985，没有可见的对焦台阶。
- 编码损失（`verify.py`，对校准后的母版，每 5 帧）：mad 均值 0.60（第 0 帧 0.47、最后一帧 0.52）、PSNR 均值 46.9 dB、最差 44.2 dB。
- **硬规则 4 的口径**：规则管的是她的显示尺寸不超过实时版 / 原图的显示。视频帧里她的尺寸与实时版在同一窗口里一致（同一舞台缩放 × 同一镜头）。`native-check.mjs --s 1.53`（t 每 0.1 s）实测，**实时版本身**在这个窗口里：立绘最大边 2193 px（t = 0，原图 1600，1.371 倍），落地后 1958 px（1.224 倍）；花海条全程 1.805 倍（原图 1 px / 单位）。这是实时版的现状，未改。

### 11.2 0.9 s 停顿（评审 medium）：原因与处理

查明是**两件**事，都是「视频在播时做了一件带 GPU 栅格的事」，视频与它争集显：

1. **prepare**（立绘解码 + 光晕位图 + 底板预烘）：`VIDEO_PREPARE_MS = 1500` 从判决点算，落在媒体时间约 0.9–1.0 s。无抓屏的 rVFC 间隔（每条 2.6 s、各 3 轮）：默认 2 / 3 轮在 1.04–1.08 s 有 35 ms 的间隔；关掉 prepare 0 / 3；prepare 提前到 0 ms 0 / 3（起播时刻不变：1090 vs 1100 ms）。
   → **prepare 判决后立刻做**（窗口还藏着的约 0.5 s 空档里）。
2. **warmBoot**：定时器从挂载算（2.9 s），测量台里挂载到起播之间会被「等抓屏就绪」卡住 1–2 s，所以它落在媒体时间 0.9–2.2 s 的任意位置（trace：`TimerFire` → 一次 `UpdateLayoutTree` 10.6 ms、1439 个元素（`html.boot-warm`）→ 3 次 GPU 栅格 flush → `DrawAndSwap` 间隔 38–42 ms）。偷看（`peekApp`）期间舞台是 99.8 % 不透明度的渲染通道，3210×1530 的视频要被画进中间纹理，是大头。
   试过：预热延到起播后 0.9 / 2.0 / 3.2 / 4.2 s（停顿跟着走，33–58 ms）；偷看帧数 5 → 2 / 1（略好，不够）；偷看放起播前（视频不卡，但应用还没画完、转场预热不全，day-fast 转场 p99 反而差；2.2 s 处仍有 29–37 ms）。
   → 最终排期：升层 / 探针（`warmBoot(el, 0, true)`，不偷看）在窗口露出来、**起播前**做；**偷看起播后 1.0 s**（`VIDEO_PEEK_MS`，`peekNow`）做——此时应用已画完，而且 2.2 s 处（蝶第一次出现 / 清晰立绘层栅格）的停顿也消失（这两样要的渲染通道被舞台渲染通道先编过）。
3. 清晰立绘层提前栅格（`ovPre` 2.3 s）本身有 ≈ 30 ms 的一次性代价：挪早到 1.4 / 0.5 s，停顿跟着挪（不是它引起的停顿，是它自己的），保持 2.3 s；加了测量钩子 `__alightOvPre`。

结果（真窗口 + WGC，4 轮中位数，开屏段呈现间隔最大值）：**day-auto video 25.0 / live 25.0 ms，day-fast video 20.8 / live 29.2 ms**（beta.4：video 50–58 / live 25–29）；每轮 video [25, 25, 25, 20.8]、[20.8, 20.8, 29.2, 20.8]，live [25, 25, 25, 29.2]、[29.2, 29.2, 25, 29.2]。呈现内容更新率 video 162.8 / 151.4 fps，live 128.7 / 99.4 fps。
新增测量钩子（只给测量台，默认不设）：`__alightVidPrepareMs`、`__alightVidWarmMs`、`__alightVidPeekMs`、`__alightOvPre`。

### 11.3 截断 / 过短的视频文件（评审 medium）

- 以前：`ended` 一律「补」成已到 T_END，截断文件在半路 `ended` 就提前交接（r3 的 f-trunc 在 2.28 s 交接）。
- 现在（`bootVideo.ts` / `videoRun.ts`）：① 加载时 `<video>.duration` 必须 = 帧数 / 帧率（445 / 60 = 7.4167 s，容差 ±0.04 s），否则整次走实时（reason `duration:…`）；② 播放中 `ended` 时最后一个已呈现帧的媒体时间必须 ≥ T_END − 2.5 帧，否则 `MediaClock.noteEnded` 返回 false，走退路 `truncated`（从已呈现帧接着实时跑，不提前交接）。
- `mp4info.mjs` 新增 `complete`（顶层盒排满整个文件且有 mdat）；`check-build.mjs` 校验 complete、轨时长 = 帧数 / 帧率、单文件 ≤ 40 MB。
- 真窗口故障注入（`r4/f-*`）：截到 13 MB → 退路 `truncated` 在媒体 2.0 s，无提前交接；截到 14 MB → `truncated` @ 2.27 s；`ffmpeg -t 3 -c copy` 的 3 s 短片（moov 完整）→ 不用视频（`duration:primary:3.033`），整次实时；其余场景（normal、interrupt 1.0 / 2.5 / 3.5 / 5.5 / 7.1、error 3.0、stall 3.0、off）全部正常结束、`<video>` 无残留。
- `check:boot` 新增：`durationOk` / `endedComplete` 边界、`noteEnded` 半路 ended 不补、接线、真文件与 BV 的宽高 / 帧数 / 时长 / 完整性、砍一半 / 少 1 字节判不完整。

### 11.4 颜色（评审 low）

- 量法：同一 t 冻结的视频版 / 实时版整窗抓图（`r4/run-cap.sh`，文字矩形屏蔽），低通后带符号均差。beta.4 的编码对实时版：(−0.6…−2.0，−1.1…−2.6，−0.5…−1.7) 级，随时间和区域变（右侧白渐变的蓝 / 绿最多 −2.1 / −1.8，早期更大）。
- 原因：**母版（无头 Chrome 软件光栅）本身就比 GPU 光栅的实时版暗**：master − live 与 video − live 一致到 0.1，video − master ≤ 0.2。不是编码、不是 trc / 矩阵标记。
- 做法：`r4/calmap.py` 把「实时 − 视频」按 64 px 方块取中位数（文字屏蔽、限幅 ±4、平滑），在 t = 0.25 … 7.35 s 的 17 个关键时刻存成校准图；`encode.py --corr` 逐帧按时刻线性插值、放大后加到母版 RGB 上再编码（抖动照旧）。校准过一轮后再抓，残差合进图（`r4/calmerge.py`）再编一次。
- 结果（真窗口，校准后，带符号均差 R / G / B 级）：t = 0.25 → +0.02 / 0.00 / +0.06；0.75 → 0.00 / +0.02 / −0.03；1.0 → −0.05 / −0.06 / −0.04；2.5 → −0.02 / −0.01 / 0.00；4.5 → −0.16 / −0.19 / −0.07；6.0 → −0.07 / −0.12 / −0.06；7.35 → −0.06 / −0.12 / −0.03；平均 −0.05 / −0.07 / −0.02（目标 ±0.3）。
  交接处的低频台阶：最后一个视频帧对交接后的 DOM 低频均差 0.26（signed −0.12 / −0.17 / −0.07），对实时版 0.21；交接后 DOM 对实时版 0.04。
- 局限：0.5 s 附近那个关键时刻没能用「同一帧」核对（暂停落在第 31 / 32 帧，实时版冻不到同一刻）；校准图是这台机器 / 这块屏的管线下测的，别的 GPU 可能有 ±1 级的另一种偏差；校准只针对 3210×1530 在 1020 CSS 高窗口里 1:1 的情形。

### 11.5 转场段 p99（评审 low）

真窗口 4 轮：day-auto 转场 p99 video 16.7 / live 16.7 ms（最大 25.0 / 20.8）；day-fast 转场 p99 video 25.0 / live 16.7 ms（最大 35.4 / 43.7，live 的最长间隔更大）。day-auto 持平；**day-fast 的 p99 仍差约 5–8 ms**，没有消除。
已做的：prepare 提前到判决点（转场要的 `bkb` 光晕位图、底板预烘、立绘解码在起播前就备好）；偷看放到应用已画完之后。没做的：视频模式的 prepare 不烘花海条 / 近景散花画布（实时版在 2.75 s 起有它们，转场里 DOM 的 `.pstrip` / 散花 svg 要现栅格）——这是剩下那几毫秒的最可能来源（推测，没有隔离实验），要烘就会改变清晰立绘层里近景散花从矢量变位图的外观，且母版里的重映射（`masterOvRemap`）是按矢量对的，所以这轮没动。

### 11.6 未验证 / 已知限制

- 用户的**可见**窗口（硬规则 1：所有真窗口测量都是屏外窗口）；asar 打包后的体积 / 读取没重测；冷启动 S1（prepare 提前、预热挪到起播前）没重测；NVIDIA 偏好未测。
- 窗口高度不是 1020 CSS 时视频按比例缩放（宽度 3210 像素按高度比例），与实时版的像素对应关系变成缩放；高 DPI 更高的屏（> 1530 设备像素高）会放大视频，清晰度比会低于 1。
- 机器不支持 3210×1530 的 H.264 硬解（`supported && powerEfficient` 不过）整次走实时，没有退档文件。

## 12. 修订（0.2.0-beta.5 样片，2026-10-29）：左上角树枝「出来卡卡的」——枝杈起笔时刻 + 枝改由实时层画

用户反馈：树枝出来卡卡的；切到实时版也一样。所以主因在动画内容，不在视频、也不在帧率。

### 12.1 根因：枝杈的出现时刻（实时版、视频母版都有）

- 枝的遮罩进度是**主干的弧长比例**（`pathLength = 1`），而 `TWIG.attach`（各枝杈起笔时的主干进度）是按「0.5 × 贝塞尔参数」手写的 `[.15 .27 .5 .63 .78 .37]`。5 根枝杈附着点的真实弧长比例是 `.196 / .354 / .664 / .747 / .845`，枝杈比主干生长前沿早出现 `.046 / .084 / .164 / .117 / .065`（23–83 舞台单位，约 38–135 设备像素）。
- 枝杈遮罩是线宽 30 的圆头描边：进度一越过 attach，附着点周围直径 30 单位的圆盘就整块出现（一座孤岛），主干前沿稍后才追上去接上。实测每次开屏 4 次（另 1 次在屏外）：墨面积一帧涨 18–40 倍（正常约 22 px，孤岛 344–807 px），前沿追上时再跳 52–67 px（正常步长约 3.5 px）。实时版 / 视频版同一份（`gp` = 0.1525 / 0.2725 / 0.5025 / 0.6325 / 0.7825）。
- 没覆盖的原因：`check-boot` 的「一笔不突然冒出来」只查主干 `twigProgress`，没查枝杈遮罩的起笔。
- 排除项（诊断阶段逐项查过）：TWIG_P0 的 0.2 s「一跳」（镜头把起段推在屏外，第一滴墨 1.85 s 才进画面，已是正常速度）、实时版呈现节奏（120 次/秒）、镜头漂移（平滑单调，占生长速度 12–32%）。

### 12.2 修法（`dayScene.ts`）

- `buildTwig` 里 attach 改成**附着点在主干折线上的弧长比例**（1200 点折线累计，`.196 .354 .664 .747 .845`），sf（接在 sa 枝梢）= sa 的 attach + 窗口 = `.476`；窗口 `TWIG.win[] = min(.28, 1 − attach)`（`.28 .28 .28 .253 .155`，sf `.16`）。旧版 se 在主干画满（gp = 1，整枝撤遮罩）时只画到 79 %，剩下 21 % 会一下补满，现在 `attach + win ≤ 1`。
- 画布版 `drawTwig` 与 SVG 版（`renderTwig`）共用 `TWIG.attach` / `TWIG.win`；导出（确定性、对拍）走 SVG 路径，同一份数。枝杈起笔时刻后移（sb 1.95→2.11 s，sc 2.36→2.67 s，sd 2.60→2.86 s，se 2.95→3.15 s），都在 4.4 s 前画满；白花 / 落蝶光晕（5.05 s 起）不变。
- `check:boot` 新增：用 20000 点折线**独立**重量附着点弧长，断言 `attach[i] ≥ 弧长比例 − 1e-3`（5 根）、sf 在 sa 画满后起笔、`attach + win ≤ 1`。旧值在这条检查下一定失败。

### 12.3 2.4 s 前后的呈现停顿（实时、视频都有）

- 每次开屏在 boot 时刻 ≈ 2.42 s 有一次 29–37 ms 的呈现间隔（rAF 同时晚 13–16 ms，无 LoAF）；此刻枝尖约 450 px/s，一次停顿 = 一步跳约 13 px。旧 / 新 attach 都有（A/B 交错）。
- 消融（真窗口、WGC，各 3–4 轮）：只关雪点 / 只关蝶 / 只关 fx / 预栅格提前到 1.7 s，停顿都还在；**雪点 + 蝶 + fx 一起关**才没有。解释：雪点（30 个 will-change 层，opacity 从 0 起的那一拍才第一次栅格）与蝶第一次出现的栅格叠在一起，关掉一个另一个顶上。
- 修法：`BF_WARM_FROM`（1.6 s，枝还没进画面）起，蝶以 α .004 先画一遍（视频版原本就有，现在实时版也有：`bfWarm`），雪点以 opacity .004 先「亮」一遍（`renderSnow` 的 `warm`）；导出（`o.capture`）不预热，逐帧确定。
- 结果：实时版 4 轮，≥ 25 ms 的间隔 4 轮里只剩 1 次（r4，2.21 s，29.2 ms，蝶 2.2 s 第一次出现处）；之前每轮必有一次 29–37 ms（2.41–2.43 s）。

### 12.4 视频版：枝移出视频，全程实时

- **母版不含枝**：`setLayers('vid')` 把 `.s0-twig` 整层 `display:none`（枝身 + 白花 + 落蝶光晕一起搬；不能只藏枝身，白花 / 光晕画在枝身上面，留在视频里叠层顺序会反）。视频只剩底板 / 光晕 / 光束 / 花海条 / 绽开期立绘。全部 445 帧重渲（枝在 1.2–7.4 s 每一帧里都有，不止前几段），母版 `perf-work/bootvideo/master-nt`（1.53 s/帧，11 分钟）。
- **实时侧接管**（`renderLive`）：第一拍写枝的初始态（白花缩到 0 等）；`t ≥ TWIG_LIVE_FROM`（= `DT.twig[0] − 0.1` = 1.2 s）起每拍写 `world` 的镜头缩放 + `renderTwig(t)`（与实时版同一套：画布位图 + 遮罩）；`vidLayers`（交接 / 打断时淡入的环境层）里去掉枝；`boot.css` 的 `.is-vid` 不再隐藏 `.s0-twc` / `.s0-twig`。枝烘焙本来就在 resize 后 200 ms 做（视频模式也做），1.85 s 的第一滴墨前就绪。
- **镜头同步**：`t` 就是 `MediaClock.at`（视频已呈现帧的媒体时间 + 到上屏时刻的外推，不是 60 fps 的离散帧），与母版里烘进去的镜头同一个时间；`z' ≤ 0.037/s`，附着点处约 45 px/s，一帧（≤ 17 ms）的偏差 ≤ 0.75 px。
- **`DAY_VID.ovPre` 2.3 → 1.4 s**：清晰立绘层提前栅格有约 30 ms 的一次性代价，原来落在 2.3 s（枝尖最快处，rVFC 记到 2–3 帧的媒体时间跳变），挪到枝第一滴墨（1.85 s）之前。`day-boot.json` 的 `ovPre` 同步；`check:boot` 新增 `ovPre ≤ 1.6 且 ≥ 枝镜头起点`。
- **交接前后一致**：枝全程是实时 DOM，7.15 s 预光栅 / 7.4 s 交接时不再有枝的淡入，只淡入底板 / 光束 / 花海条（它们在 DOM 里本来就在枝下面，叠层顺序 `ph < beams < world(bloom < twc < twig)` 与视频前相同）；最后一帧的源帧哈希变了（`frameLast_source_rgb` 变，第 0 帧哈希不变）。
- 重编码：`encode.py --codec avc --crf 12 --dither 0.75 --trc srgb --maxrate 48000 --bufsize 96000 --corr r4/corr2.npz`（颜色校准图沿用，枝很小，64 px 方块中位数基本不受影响，没有重新校准），33 165 162 字节（31.6 MiB，35.8 Mbps，比旧片少 16 KB）。`verify.py --every 5`：mad 均值 0.60、PSNR 均值 46.96 dB / 最差 44.24 dB、最后一帧 mad 0.52 / PSNR 48.06（旧片：0.60 / 46.9 / 44.2 / 0.52）。`hashes.mjs` → `manifest.mjs --real` → `check-fresh.mjs`：fresh。
- 视频版实测（`twig/run-twig.mjs`，屏外真窗口 + WGC）：**孤岛 0**（≥ 60 px 的只剩 4.0–4.2 s 蝶从右缘进入裁剪区、4.5 s 蝶落到枝梢，都不是枝）；视频被使用、无退路；与实时版同一 t 的抓屏逐帧比对，枝的位置 / 形状 / 枝杈起笔一致，枝与底板没有错位；枝区域更新间隔在 1.9–4.4 s 内没有 ≥ 25 ms 的间隔（2 轮）。

### 12.5 数字（实时版，4 轮，boot 时刻 1.9–4.4 s，屏外真窗口 + WGC + 插电）

| | 旧 attach（A/B 同轮交错） | 新 attach | 新 attach + 预热 |
| --- | --- | --- | --- |
| ≥ 60 px 孤岛（1.9–3.0 s） | 每轮 4 次（773–807 / 660–710 / 459–469 / 341–346 墨像素） | 0 | 0 |
| 主干前沿逐帧最大步长（1.9–4.2 s） | 65–67 px（4 次 > 50 px） | 8–11 px | — |
| ≥ 25 ms 呈现间隔 | 多数轮有 1 次（2.42 s，29–37 ms） | 多数轮有 1 次（同处，29–37 ms） | 4 轮共 1 次（2.21 s，29 ms） |

### 12.6 未验证 / 已知限制

- **视频版的节奏数字不全**：做视频版测量时机器已拔电（`BatteryStatus = 1`，等了约 10 分钟没插回），按硬规则只做了功能核对（孤岛 0、无退路、与实时版逐帧同形、无 ≥ 25 ms 间隔，2 轮），**没有做 ≥ 4 轮的节奏统计，也没重测 rVFC 在 1.85–4.4 s 的媒体时间跳变（ovPre 提前的效果）**；插电后补测：`bash ../with-lock.sh bash run-one.sh <前缀> video 4`（`perf-work/bootvideo/twig`），再 `extract.py` / `cad.py` / `pops.py`。
- 今天的实时版呈现是约 100 次/秒（间隔里每 6 个有一个 20.8 ms），不是诊断时的 120；旧 / 新 attach 同轮交错的 A/B 里一样，所以是机器当时的状态，不是这次改动；没找到原因。
- 2.2 s 蝶第一次出现处仍可能有一次 29 ms 的间隔（预热只摊了栅格，没有消掉第一次绘制）。
- 没有在用户的可见窗口里验证；「卡卡的」是否完全来自孤岛没法替用户确认，请用户肉眼验收。
- 画布 `twc` 随镜头缩放时的位图重采样有无微抖没有专门测。
- 建议后续：把 `twig/pops.py` 的孤岛判据接进 `perf-work/harness/ab.mjs`，作为开屏固定回归项。

## 13. 默认改回「实时」（0.2.0-beta.6，2026-10-29）

用户在 beta.5 之后先说「视频版要不先不修」，再说「改回实时」。第 11.6 / 12.6 节列的视频版已知问题暂不跟进；视频版留作设置 › 外观「昼开屏」里的可选项，视频文件照旧随包。

- `seed.ts`：`DEFAULT_SETTINGS.bootVideo = false`；`bootImpl.bootVideoRequested` 的兜底（第 ⑥ 级）改为假。
- 存档迁移 `SETTINGS_REV` 5（`persist.migrateSettings`）：存档整份写 settings，beta.4 / beta.5 存下的 `bootVideo: true` 分不出是默认还是自己选的，按旧默认换成 false；rev ≥ 5 存下的 true（默认改回之后自己选的）照办。顺带把剧情框的迁移限定在 `rev < 4`：rev 4 存的 `'off'` 是默认改成「闲聊」之后自己选的，不能被这次升级再改一遍。
- 早预加载（`earlyBoot.ts` → `readEarlyPrefs`）在 React 与迁移之前同步读 localStorage，同一条规则放在 `prefsKeys.BOOT_LIVE_REV`，两边共用：升级后第一次启动、新存档还没写回时，也不会白读 33 MB 的视频。
- 测试：check-boot（默认假；早读按修订号）、unit-check（4 → 5、rev 5 不动、写回后早读一致、之后选视频能存住）、check-store（库镜像路径）、probe 的 fx / selftest 对齐 settingsRev 5。
