#!/usr/bin/env bash
# 渲染用的源码镜像：把仓库源码复制到 perf-work/bootvideo/src-render（不碰仓库，不跑 npm install，node_modules 用目录联接指回仓库）。
#   bash make-render-src.sh patch   默认。git archive HEAD（不受工作区里别人改动影响）+ 一个小补丁：关掉光尘、藏起 .bd-text。
#                                   —— 与 I 的 DEV 钩子 __boot.seek(t, { layers: 'bg' }) 等价，只是不依赖它。
#   bash make-render-src.sh hook    工作区当前源码（含 I 的改动），不打补丁；render.mjs --mode hook 会用 layers:'bg' 调 seek。
# 渲染（render.mjs）读这个镜像，用无 HMR 的 vite dev（端口 5332）+ 无头 Chrome。
set -e
MODE="${1:-patch}"
W="G:/Claude Code Workplace/castorice-harness/perf-work/bootvideo"
REPO="G:/Claude Code Workplace/castorice-harness/app"
SRC="$W/src-render-$MODE"
winpath() { cygpath -w "$1"; }
unlink() { [ -e "$1" ] && powershell.exe -NoProfile -Command "if ((Get-Item -LiteralPath '$(winpath "$1")' -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { cmd /c rmdir '$(winpath "$1")' }" >/dev/null 2>&1 || true; }
unlink "$SRC/node_modules"
rm -rf "$SRC"; mkdir -p "$SRC"
if [ "$MODE" = hook ]; then
  (cd "$REPO" && tar --exclude=./node_modules --exclude=./dist --exclude=./release --exclude=./assets-src -cf - .) | tar -x -C "$SRC"
  REV="worktree (HEAD $(git -C "$REPO" rev-parse --short HEAD) + 未提交改动)"
else
  git -C "$REPO" archive HEAD | tar -x -C "$SRC"
  REV="HEAD $(git -C "$REPO" rev-parse HEAD)"
  # 补丁：①光尘（renderFx 里的 40 粒窗口像素光点）不画 ②.bd-text 整段隐藏（署名 / 跳过 / 标题 / 版本号…）。其余像素与 HEAD 逐位相同。
  D="$SRC/src/components/decor/boot/dayScene.ts"
  grep -c 'for (const m of DAY_MOTES) {' "$D" | grep -qx 1 || { echo "补丁失败：dayScene.ts 里找不到唯一的光尘循环"; exit 1; }
  sed -i 's/for (const m of DAY_MOTES) {/for (const m of DAY_MOTES.slice(0, 0)) {/' "$D"
  printf '\n.boot--day .bd-text { visibility: hidden !important; }\n' >> "$SRC/src/styles/boot.css"
fi
powershell.exe -NoProfile -Command "New-Item -ItemType Junction -Path '$(winpath "$SRC/node_modules")' -Target '$(winpath "$REPO/node_modules")' | Out-Null"
printf '%s\n模式 %s\n时间 %s\n' "$REV" "$MODE" "$(date '+%F %T')" > "$SRC/BUILD-INFO.txt"
cat "$SRC/BUILD-INFO.txt"
