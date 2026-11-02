# 昼开屏背景视频：生成、校验、防过期

把昼开屏里「文字与光尘以外」的所有重层（底板 / 光晕 / 光束 / 镜头 / 花海条 / 官方立绘 / 枝 / 蝶 / 荆棘脉冲 / 花瓣…）逐帧渲染成一段不透明视频，开屏时硬件解码播放。
施工图：`docs/BOOT-VIDEO.md`。本目录只放生成与校验脚本；成品在 `public/boot/day-boot.{hevc,avc}.mp4` 与 `day-boot.json`。

> **0.2.0-beta.5 修订（2026-10-29，覆盖下文与 beta.4 修订里的几何 / 大小 / 色彩）**：视频按**显示分辨率**渲染——用户窗口 2560×1600 物理像素、150 % 缩放，最大化（避开任务栏）约 1710×1020 CSS = 2565×1530 设备像素，所以 `geometry.json` 是
> **DPR 1.5、CSS 视口 2140×1020 = 帧 3210×1530**（scale 1.53 设备像素 / 舞台单位，60 fps、445 帧、H.264 High L5.2，约 33 MB）。播放时 1 个视频像素 = 1 个设备像素（窗口高 1020 CSS 时），不再放大 1.81 倍。
> 立绘 / 花海条在帧里的显示尺寸与实时版在同一窗口里一致（同一舞台缩放 × 同一镜头），规则按「不超过实时版」口径，不再为守「不放大超过原图」压低分辨率（`native-check.mjs --s 1.53` 照实报告实时版本身的放大倍数）。
> `render.mjs` 用 `--dpr` / 几何里的 `cssWidth` `cssHeight`（`Emulation.setDeviceMetricsOverride` 的 DPR 1.5，屏幕截图 3210×1530）；`encode.py` 新增 `--corr`（颜色校准图）、`--offset` / `--gain`（RGB 偏置 / 增益）、`--crop-w`。
> **颜色校准**：母版是无头 Chrome 软件光栅，比真窗口里 GPU 光栅的实时版系统性偏暗（左 -0.9/-1.3/-0.3，右侧白渐变 -0.8/-2.1/-1.6 级，随时间与区域变）。做法：`perf-work/bootvideo/r4/run-cap.sh` 在屏外真窗口里把「视频版」与「实时版」冻结在同一 t 抓图 → `r4/calmap.py` 按 64 px 方块取中位数（文字矩形屏蔽、限幅 ±4）→ 16 个时刻的校准图 .npz → `encode.py --corr` 逐帧插值后加到母版 RGB 上再编码；再抓一轮核对，目标带符号均差 ±0.3 级内。
> 编码：`python -I encode.py --codec avc --crf 12 --master <母版目录绝对路径> --corr <校准图.npz> --out day-boot.avc.mp4`（`--master` 必须是绝对路径，concat 清单里存的是它）。

> **0.2.0-beta.4 修订（2026-10-29，覆盖下文的部分内容）**：视频只承载环境层 + 绽开期（< 3.0 s）的立绘，2.7 s 起的清晰立绘 / 近景散花 / 蝶 / 雪点 / B 类 fx 是实时 DOM；**60 fps、只有 H.264**（`day-boot.avc.mp4`，445 帧，不再有 HEVC）。
> 母版用 `render.mjs`（默认 `--mode hook`：工作区源码 + `seek(t, { layers: 'vid' })`，帧率取 geometry.json 的 60），编码 `encode.py --codec avc --crf 12 --master <母版目录绝对路径>`，
> `verify.py --codec avc --master <母版目录>`（最后一帧序号 = frames − 1，键名 `frameLast`），`hashes.mjs` / `manifest.mjs --real` 只认 avc。详见 `docs/BOOT-VIDEO.md` §10。下文提到 HEVC / 120 fps / 889 帧 / 两个文件的地方以 §10 为准。

> **与施工图的一处偏离（硬规则 4 实测的结果）**
> 施工图按 s = 0.944（帧 1980×944）设计，并假设花海条原图密度 1.0625 px/单位。实测不成立：`day-strip.webp`（1700×216）在 CSS 里是 `background-size: 1700px`，即 1 px / 单位；
> 且花海条挂在 `.bd-near1` / `.bd-pre` 上，有效镜头缩放是 `zf = 1 + 1.5 × (z − 1)`，开头 1.18（不是 1.12）。于是 s = 0.944 时花海条在 **t < 2.75 s** 被放大到原图的 **1.114 倍**，超过原图。
> 为守「不放大超过原图」，几何改为 **s = 0.846、帧 1774×846**（`geometry.json`；花海条最大 0.9983，官方立绘最大边长 1212.8 px ≤ 1600）。
> 画面比例 1774/846 = 2.0969，与 1980/944 = 2.0975 相差 0.03%：播放端只按比例排版（视频高 = 窗高、宽 = 高 × 比例、`object-fit: fill`），不受影响；`day-boot.json` 的 `width / height / scale / extUnits / ratioMax` 已按新几何写。
> `native-check.mjs` 可随时重测；要出 944 档只能在用户明确放宽硬规则 4 后（`render.mjs --scale 0.944 --out …`）。

## 文件

| 文件 | 作用 |
| --- | --- |
| `geometry.json` | 视频几何（scale / 宽 / 高 / 帧率 / 帧数），所有脚本共用 |
| `make-render-src.sh` | 渲染用源码镜像（`git archive HEAD` + 小补丁：关光尘、藏 `.bd-text`；`hook` 模式用工作区源码 + I 的 `layers:'bg'` 钩子） |
| `lib.mjs`、`vite.render.config.mjs` | 共用：等机器空闲、持 `.heavy-lock`、低优先级、vite dev、无头 Chrome |
| `render.mjs` | **阶段一**：逐帧渲染 → 无损母版（FFV1 mkv，每 120 帧一段，可断点续渲） |
| `native-check.mjs` | 硬规则 4：每张官方素材的渲染尺寸 / 原图尺寸（t 每 0.05 s） |
| `calibrate.py`、`calib-entry.cjs` | 色彩标定：在屏外真窗口里播标定片，选 `trc` |
| `encode.py` | **阶段二**：母版 → BT.709 YUV + 抖动 → x265 / x264 |
| `verify.py` | 解码回来与母版比（A 层数字、条带指数、解码哈希、母版第 0 / 888 帧 PNG） |
| `sources.mjs`、`hashes.mjs`、`manifest.mjs` | 源哈希 / 汇总哈希 / 写 `day-boot.json` |
| `check-fresh.mjs` | 防过期：重算源哈希与 manifest 比对（退出码 0 新鲜 / 1 过期 / 2 桩） |
| `mp4info.mjs` | 极小的 mp4 盒解析（编码四字符、宽高、帧数、`colr`、faststart），给 check-build 用 |
| `make-stub.ps1` | 桩视频（占位，`stub:true`；check-build 必须对它报错） |

工作目录（不入库）：`G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo/`（母版、哈希、标定片、日志、`frames/` 里的帧 PNG）。

## 从零生成（全程约 40–60 分钟，重任务一次一个）

前置：插着电（`Win32_Battery.BatteryStatus = 2`）；没有别的渲染 / 编码 / 游戏在跑（脚本会等，最多 60 分钟）；不用 GPU（Chrome `--disable-gpu`，ffmpeg 不用 CUDA / NVENC / QSV）；ffmpeg 一律 `-threads 4`，进程低优先级。全部在 `app/` 下执行。

```bash
cd "G:/Claude Code Workplace/castorice-harness/app"
S=scripts/boot-video; W=../perf-work/bootvideo
bash $S/make-render-src.sh patch                       # 1. 源码镜像（HEAD + 补丁）
node $S/native-check.mjs --s 0.846 --json $W/native-check.json   # 2. 原图检查（必须无「超 1.0 的时段」）
node $S/render.mjs                                     # 3. 母版：889 帧 ≈ 6 分钟（0.4 s/帧）→ $W/master/seg_*.mkv（约 0.86 GB）
python -I $S/calibrate.py --variants "hevc:none709:srgb:0:0 hevc:709:bt709:0:0 avc:none709:srgb:0:0 avc:709:bt709:0:0"   # 4. 色彩标定（约 3 分钟），见下「色彩」
python -I $S/encode.py --codec hevc --crf 9  --tag hevc --out $W/final/day-boot.hevc.mp4     # 5. 编码（各约 2.5 分钟）
python -I $S/encode.py --codec avc  --crf 10 --tag avc  --out $W/final/day-boot.avc.mp4
python -I $S/verify.py --codec hevc --mp4 $W/final/day-boot.hevc.mp4 --json $W/verify-hevc.json --dump $W/frames   # 6. 全帧校验（各约 6 分钟）
python -I $S/verify.py --codec avc  --mp4 $W/final/day-boot.avc.mp4  --json $W/verify-avc.json  --dump $W/frames
cp $W/final/day-boot.*.mp4 public/boot/                # 7. 入库位置
node $S/hashes.mjs && node $S/manifest.mjs --real      # 8. 写 public/boot/day-boot.json
node $S/check-fresh.mjs                                # 9. 防过期自检
```

真窗口取景核对（可选）：`python -I $S/calibrate.py --framecheck public/boot/day-boot.hevc.mp4 --ref $W/master/frame888.png --seek 7.4 --name fc-hevc-888`
（`--seek end` = 从头播到结束再抓，`--seek endclean` = 同上但页面没有别的动画，只读丢帧数；输出 `$W/calib/<name>.json`）。


重编码（调参）只重做 `encode.py` 之后的步骤，母版不动。母版的第 0 / 888 帧 PNG 在 `perf-work/bootvideo/master/frame0.png`、`frame888.png`（`verify.py` 导出，给 A 层对拍用）。

### 可复现性
- **HEVC 的 mp4 不是逐字节可复现的**（x265 多线程：同一母版、同参数两次编码字节数差约 1 KB）；AVC 逐字节可复现。保真度数字都是对入库的那个文件量的。
- 渲染是确定性的：同一镜像、同一参数下同一帧的 PNG 字节相同（`master/seg_*.mkv.png-sha256.txt` 存了每帧 PNG 的 sha256；`render.mjs --frames 300-300 --out X` 重渲单帧可比对）。
- 抖动是确定性的（种子 = 帧号），同一母版 + 同一参数 + 同一 x265 版本 → 同一 mp4。

## 渲染与「实时版」的关系

母版用施工图 5.3 的「确定性导出路径」：`?bootcap=day`（不带 `?bloomcv=1`，走 DOM 蒙版路径，与 0.1.3 逐像素相同），`window.__boot.seek(t, { leaveAt: 1e9 })`，`Page.captureScreenshot`。
区别只有两处补丁（`make-render-src.sh patch`）：`renderFx` 里的 40 粒光尘不画、`.bd-text { visibility: hidden }`——等价于 I 的 `seek(t, { layers: 'bg' })`。I 的钩子进库后可用 `make-render-src.sh hook` + `render.mjs --mode hook` 重渲，并与现有母版逐帧比对 PNG 哈希。

## 帧 ↔ 时刻 ↔ 交接

第 i 帧 = 场景时刻 t = i / 120 s，i = 0 … 888（T_END = 7.4 s 是第 888 帧），共 889 帧、7.4083 s、恒定 120 fps、GOP 120（关键帧每秒一个，`-g 120 -keyint_min 120`，scenecut 关）。
`sources.timeline` = `sha256(JSON.stringify({ T_END, DT, DAY_EVENTS }))`（`timeline-entry.mjs` 从 `dayScene.ts` 的导出里取；原文也存在 manifest 的 `sources.timelineJson`，I 的 check-boot 可直接对）。

## 色彩

BT.709 矩阵、有限范围；传递函数标记由 `calibrate.py` 决定，写进容器与 VUI（`day-boot.json` 的 `trc`）。
抗条带：抖动加在 YUV 域、量化之前（TPDF，种子 = 帧号）。HEVC 为 10 位，幅度以 10 位最低位为单位；H.264 为 8 位，幅度以 8 位台阶为单位。色度下采样取「左对齐」（H.273 type 0，Chromium 与硬解的假设）。

## 怎样确认视频没过期

`node scripts/boot-video/check-fresh.mjs`。`tEnd` / `landing` / 时间表 / `splash` / `strip` 任一变了 = 过期（需要重渲染）；`day*.ts` 源码哈希变了只告警。

## 本次产物（HEAD a369da8，母版 2026-10-29）

| | HEVC（主） | H.264（兜底） |
| --- | --- | --- |
| 文件 | `day-boot.hevc.mp4`，Main10，`hvc1.2.4.L153.90` | `day-boot.avc.mp4`，High L5.2，`avc1.640034` |
| 尺寸 / 帧率 / 帧数 / 时长 | 1774×846、120 fps 恒定、889 帧、7.4083 s | 同 |
| 大小 | 14 704 357 字节（14.0 MiB，15.9 Mbps） | 21 422 018 字节（20.4 MiB，23.1 Mbps） |
| 参数 | x265 slow、crf 9、vbv 18000/36000、GOP 120、抖动 TPDF 2.0（10 位最低位） | x264 slow、crf 10、maxrate 24M/48M、GOP 120、抖动 0.75（8 位台阶） |
| 合计 | 36.1 MB（上限 40 MB；HEVC <= 17、H.264 <= 22 均满足），安装包增加同等大小 | |

保真度（解码回来对母版，`verify.py`，889 帧全量，亮度 / 8 位 RGB 域）：

| | 第 0 帧 mad / p99.9 / 8x8 块 | 第 888 帧（交接帧）mad / p99.9 / 8x8 块 | 全片最差帧 mad / p99.9 / 块 |
| --- | --- | --- | --- |
| HEVC | 0.14 / 1.21 / 0.39 | 0.39 / 3.01 / 1.48（PSNR 44.7 dB） | 0.61 / 9.43 / 3.0 |
| H.264 | 0.45 / 2.07 / 0.84 | 0.55 / 3.07 / 1.74（PSNR 44.4 dB） | 0.87 / 10.3 / 3.7 |

A 层阈值（mad <= 0.6、p99.9 <= 6、块 <= 2）在第 0 帧与第 888 帧两个交接 / 起始帧上全部满足；全片个别帧（HEVC 第 227、443 帧附近，运动 / 花瓣密集处）略超。
条带：在右侧白渐变与左侧雾的平滑区，解码后 8 位台阶的平均游程与母版之比为 1.05–1.5（母版自己的 Chrome 渐变带 TPDF 抖动，游程 1.5–2.9 像素），无母版里没有的新色带；见 `frames/*-band8x-*.png`（对比度放大 8 倍，左 = 母版、右 = 解码）。
差值图（`frames/*-diff16x-*.png`，16 倍放大）：差集中在线条边缘（色度 4:2:0），平滑区只有噪声级差异。

真窗口里的颜色（`calibrate.py --framecheck`，屏外真窗口、Intel 集显硬解、WGC / capturePage，停在第 0 / 888 帧与母版比）：
- H.264：平均有符号差 (−0.07, −0.03, 0.02)、(0.09, 0.02, 0.14)，mad 0.45 / 0.55，与 numpy 解码一致 -> 颜色管线无偏。
- **HEVC（10 位）：整体偏暗 (−1.9, −0.7, −2.0) 级**（mad 1.08 / 0.98），与区域、亮度无关；暂停 / 停在末帧的状态下复现，同一标定片上也复现（−1.2, −0.1, −1.7）；H.264 无此现象。
  边播边抓的标定（flat 色块，`calib/result.json`）里 HEVC 在 ±2 级内。结论：Chromium 对 P010（10 位）非叠加路径的转换比 8 位多约 1.5–2 级的负偏，**末帧交接（视频停在最后一帧再与 DOM 交叉淡入）会看到约 0.8% 的亮度台阶**——淡入 120 ms 与「变清」同时发生，预计看不出，但 I 的 B 层要看一眼；若介意可改用 H.264 做主文件（体积更大、首个视频冷启动丢帧多）或给 HEVC 加 +2 级偏置（未做，会让别的 GPU 偏亮）。

## 色彩标定（BOOT-VIDEO 2.5）：与施工图预期不同

`calibrate.py` 在屏外真窗口里播同一帧标定图（灰阶块 / 底板 #d4c8e4 / 光晕 / 饱和色块），逐块与目标 sRGB 比，抓屏用 WGC（DWM 合成后）与 capturePage 两条路径。结果（`day-boot.json` 的 `calibration` 有完整数字）：
- **矩阵标记**：显式标 `bt709`（或 BT.601 + 601 系数）时红 −22、绿 +20、品红 −28 级（HEVC / H.264 都是，H.264 另有灰阶整体 −3）；**矩阵标记留空 + 709 系数**，两条路径都在 2 级以内（H.264 在 1 级以内）。所以成品编码是 BT.709 系数 + `colour_description` 里矩阵 = unspecified（`matrixTag: "unspecified"`），Chromium 对 HD 默认按 709 解；其它播放器（mpv / VLC / 系统播放器）对 HD 的 unspecified 同样按 709。
- **传递函数标记**：`bt709` 与 `iec61966-2-1` 输出逐位相同（硬解路径不看这个标记），取语义正确的 **`iec61966-2-1`**（源像素是 sRGB）；写进 `trc`。软解路径（`--disable-accelerated-video-decode`）在屏外窗口里抓不到视频，未标定。
- `MediaCapabilities`（`video/mp4; codecs="hvc1.2.4.L153.90"`，1774×846@120）：`supported` / `smooth` / `powerEfficient` 均为 true。

## 已知问题 / 给 I 的提示

- **几何与施工图不同**（见开头）：`width/height/scale/extUnits/ratioMax` 以 manifest 为准（1774 / 846 / 0.846 / 2096.9 / 2.0969）；版面只依赖比例（视频高 = 窗高、宽 = 高 × width/height）。若 check-boot 里写死了 1980 / 944 / 2.0975，要改成读 manifest。
- `matrix` 字段写的是**系数**（bt709），`matrixTag` 是**容器 / VUI 里的标记**（unspecified）；`codec` 字符串是 `hvc1.2.4.L153.90`（x265 写的约束字节是 0x90，施工图写的 `.B0` 对不上，`MediaCapabilities` 用哪个都行）。
- 离屏测量窗口里用一页只有 `<video>` 的页面播（`--seek endclean`），丢帧约 27%（239–246 / 889），HEVC、H.264 与一段 `testsrc2` 对照片完全一样 -> 这是屏外窗口 / 测量页的环境值，不是文件的问题；真正的呈现帧率请用 realwin 的 WGC 节拍测量。
- `sources.src` 是 manifest 生成时 `boot/day*.ts` 的哈希（当时工作区已含 I 的改动；渲染本身来自 HEAD + 补丁，与 I 的 `layers:'bg'` 钩子逐像素等价，见下），仅作提示。
- 渲染复现性：同一镜像、同参数，单帧独立渲染与连续渲染相比，第 0、300 帧逐字节相同；第 600、888 帧有 42 / 241 个像素差 <= 4 级（枝画布烘焙状态的差异）。I 的钩子（`make-render-src.sh hook` + `render.mjs --mode hook`）与母版对拍同样如此。
