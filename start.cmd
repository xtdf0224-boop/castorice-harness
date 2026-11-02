@echo off
rem 栖枝 V0α：用开发目录直接启动（没有 dist 就先构建一次）。
cd /d "%~dp0"
if not exist "dist\index.html" call npm run build
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
