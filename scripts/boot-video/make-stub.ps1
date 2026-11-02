param([switch]$Force)
# 桩视频：符合契约（见 geometry.json（现为 1774x846）、120 fps 恒定、889 帧、HEVC Main10 hvc1 / H.264 High L5.2、faststart、命名）的占位片：缓动渐变 + 大号帧号。
# day-boot.json 标 "stub": true —— check-build 对 stub:true 报错（防止桩被打进发布包）。真视频渲染好后由 finalize.mjs 覆盖。
# 用法：powershell -File scripts/boot-video/make-stub.ps1 [-Force]        （仓库根或任何目录都行）
$ErrorActionPreference = 'Stop'
(Get-Process -Id $PID).PriorityClass = 'BelowNormal'      # 子进程继承：低优先级
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
# 安全：public/boot/day-boot.json 已经是真视频（stub:false）时拒绝覆盖，除非加 -Force
$mf = Join-Path (Join-Path (Join-Path $here '..\..') 'public\boot') 'day-boot.json'
if ((Test-Path $mf) -and -not $Force) { $cur = Get-Content $mf -Raw -Encoding UTF8 | ConvertFrom-Json; if (-not $cur.stub) { throw 'day-boot.json 是真视频，拒绝用桩覆盖（要覆盖请加 -Force）' } }
$app  = (Resolve-Path (Join-Path $here '..\..')).Path
$ff   = 'G:/Claude Code Workplace/tools/ffmpeg/ffmpeg-9.0.1-full_build/bin/ffmpeg.exe'
$out  = Join-Path $app 'public\boot'
$lock = 'G:/Claude Code Workplace/castorice-harness/perf-work/av/.heavy-lock'
$geo = Get-Content (Join-Path $here 'geometry.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$sz = "$($geo.width)x$($geo.height)"
$vf = "gradients=s=${sz}:r=120:c0=0xd4c8e4:c1=0xf3eefa:c2=0xb7a6d6:c3=0xfff6ff:nb_colors=4:speed=0.01:seed=7,drawtext=fontfile='C\:/Windows/Fonts/arialbd.ttf':text='STUB %{eif\:n\:d\:4}':fontsize=220:fontcolor=0x3a2a5a@0.85:x=(w-text_w)/2:y=(h-text_h)/2,drawtext=fontfile='C\:/Windows/Fonts/arial.ttf':text='boot video placeholder - not the real render':fontsize=36:fontcolor=0x3a2a5a@0.8:x=(w-text_w)/2:y=h/2+160"
while (-not (New-Item -ItemType Directory $lock -EA SilentlyContinue)) { Start-Sleep 15 }
try {
  New-Item -ItemType Directory -Force $out | Out-Null
  $hevc = Join-Path $out 'day-boot.hevc.mp4'
  $avc  = Join-Path $out 'day-boot.avc.mp4'
  $p = Start-Process -FilePath $ff -PassThru -Wait -NoNewWindow -ArgumentList @('-y','-hide_banner','-loglevel','error','-threads','4','-f','lavfi','-i',"`"$vf`"",'-frames:v','889',
    '-c:v','libx265','-pix_fmt','yuv420p10le','-preset','veryfast','-crf','20','-tag:v','hvc1','-r','120','-fps_mode','cfr','-g','120','-keyint_min','120',
    '-x265-params','pools=4:frame-threads=2:level-idc=5.1:profile=main10:scenecut=0:vbv-maxrate=18000:vbv-bufsize=36000','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv','-movflags','+faststart',"`"$hevc`"")
  if ($p.ExitCode -ne 0) { throw "hevc stub failed" }
  $p = Start-Process -FilePath $ff -PassThru -Wait -NoNewWindow -ArgumentList @('-y','-hide_banner','-loglevel','error','-threads','4','-f','lavfi','-i',"`"$vf`"",'-frames:v','889',
    '-c:v','libx264','-pix_fmt','yuv420p','-profile:v','high','-level','5.2','-preset','veryfast','-crf','22','-r','120','-fps_mode','cfr','-g','120','-keyint_min','120','-sc_threshold','0',
    '-maxrate','24M','-bufsize','48M','-colorspace','bt709','-color_primaries','bt709','-color_trc','bt709','-color_range','tv','-movflags','+faststart',"`"$avc`"")
  if ($p.ExitCode -ne 0) { throw "avc stub failed" }
} finally { Remove-Item $lock -Recurse -Force -EA SilentlyContinue }
node (Join-Path $here 'manifest.mjs') --stub
