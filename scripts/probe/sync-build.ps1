# 把仓库同步到验收副本并构建（不碰仓库的 dist；用户的栖枝从仓库 dist 加载）。
#   powershell -NoProfile -File scripts/probe/sync-build.ps1            # 同步并构建 app-dev（--mode development，有 window.__alight）与 app-prod（正常模式，给 check-build 用）
#   powershell -NoProfile -File scripts/probe/sync-build.ps1 -Only dev  # 只构建 dev（改了 src 之后截图 / flows 前用这个，几秒钟）
#   powershell -NoProfile -File scripts/probe/sync-build.ps1 -Only prod
# 副本：<AV>/T/app-dev 与 <AV>/T/app-prod。node_modules 是联接（junction）到仓库的 node_modules：
#   · robocopy /MIR 带 /XD node_modules dist release .git .cache，所以重跑同步不会碰联接，也不会删仓库的 node_modules；
#   · 要删副本，只能 cmd /c rmdir <副本>\node_modules 拆联接，再删目录——不要 rm -rf（会顺着联接删真的 node_modules）。
# 构建前拿重任务锁（<AV>/.heavy-lock，目录锁），构建完释放。
param([ValidateSet('both', 'dev', 'prod')][string]$Only = 'both')
$app = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$av = 'G:/Claude Code Workplace/castorice-harness/perf-work/av'
$lock = "$av/.heavy-lock"
while (-not (New-Item -ItemType Directory $lock -ErrorAction SilentlyContinue)) { Start-Sleep 15 }
try {
  foreach ($kind in @('dev', 'prod')) {
    if ($Only -ne 'both' -and $Only -ne $kind) { continue }
    $dst = "$av/T/app-$kind"
    New-Item -ItemType Directory -Force $dst | Out-Null
    robocopy $app $dst /MIR /XD node_modules dist release .git .cache /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）" }
    if (-not (Test-Path "$dst/node_modules")) { cmd /c mklink /J ("$dst/node_modules" -replace '/', '\') ("$app/node_modules" -replace '/', '\') | Out-Null }
    Push-Location $dst
    try {
      if ($kind -eq 'dev') { $env:NODE_ENV = 'development'; $mode = '--mode development' } else { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue; $mode = '' }
      # 构建器把「use client」之类的警告写到 stderr：交给 cmd 合并输出，免得 PowerShell 把它当成错误
      $out = cmd /c "node node_modules/vite/bin/vite.js build --outDir dist --emptyOutDir $mode 2>&1"
      if ($LASTEXITCODE -ne 0) { $out | Select-Object -Last 20; throw "vite build 失败（$kind）" }
      $out | Select-Object -Last 1
    } finally { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue; Pop-Location }
    "[$kind] 构建完成：$dst/dist"
  }
} finally { Remove-Item $lock -Recurse -Force }
